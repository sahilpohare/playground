import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const script = join(import.meta.dir, "..", "..", "..", "scripts", "ops", "notify.sh")
const scratch = mkdtempSync(join(tmpdir(), "notify-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

let configs = 0
// Queues one line in a config folder of its own, whose roster holds the agents given, and returns the record the outbox holds.
const queued = async (text: string, agents: object[] | null = null, to?: string, via = script) => {
  const config = join(scratch, `config-${++configs}`)
  mkdirSync(join(config, "playground"), { recursive: true })
  if (agents) writeFileSync(join(config, "playground", "roster.json"), JSON.stringify({ agents }))
  const proc = Bun.spawn(["bash", via, "test", text], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      ...(to && { NOTIFY_TO: to }),
    },
    stderr: "pipe",
  })
  expect(await proc.exited).toBe(0)
  return JSON.parse(
    readFileSync(join(config, "playground", "ops", "outbox", "ops-test.jsonl"), "utf8"),
  ) as {
    to: string
    text: string
  }
}

const manager = (kind: string, name: string) => ({ kind, name, role: "manager", status: "working" })

// an ops job tells whoever holds a manager's seat, so a respawned manager under a new name gets its lines.
test("a line goes to ops by default, and a manager kind to whoever holds its seat", async () => {
  const roster = [manager("ops", "p4nb7c-ops"), manager("builder", "x7mh4d-builder")]
  expect((await queued("hello", roster)).to).toBe("p4nb7c-ops")
  expect((await queued("hello", roster, "builder")).to).toBe("x7mh4d-builder")
  expect((await queued("hello", roster, "dispatcher")).to).toBe("dispatcher")
})

// link-skills.sh links notify.sh into the state folder, where roster.ts is not beside it.
test("a manager kind resolves through a link to notify.sh, as it does from the checkout", async () => {
  const linked = join(scratch, "linked", "ops", "notify.sh")
  mkdirSync(dirname(linked), { recursive: true })
  symlinkSync(script, linked)
  const roster = [manager("builder", "x7mh4d-builder")]
  expect((await queued("hello", roster, "builder", linked)).to).toBe("x7mh4d-builder")
})

test("sessions.names' names stand while the roster holds no entry of the kind", async () => {
  expect((await queued("hello")).to).toBe("ops")
  expect((await queued("hello", [], "builder")).to).toBe("builder")
  expect((await queued("hello", null, "Not A Name")).to).toBe("ops")
})

// a kindless <id>-<kind> entry holds its seat by its name's suffix, and the dispatcher is a kind too.
test("a manager's <id>-<kind> name places with no roster kind, and dispatcher names the primary", async () => {
  const roster = [
    { name: "k3v9q2-ops", role: "manager", status: "working" },
    { name: "m4n7vw-dispatcher", role: "manager", status: "working" },
  ]
  expect((await queued("hello", roster)).to).toBe("k3v9q2-ops")
  expect((await queued("hello", roster, "dispatcher")).to).toBe("m4n7vw-dispatcher")
  expect((await queued("hello", [], "dispatcher")).to).toBe("dispatcher")
})

// a line that must reach the owner away from the Dashboard also shows as a macOS banner; osascript is a stub here, so no banner fires.
test("NOTIFY_MAC shows the line as one macOS banner, and a line without it shows none", async () => {
  const bin = join(scratch, "bin")
  const shown = join(scratch, "osascript.log")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "osascript"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${shown}"\n`, {
    mode: 0o755,
  })
  const notify = (mac: string) =>
    Bun.spawn(["bash", script, "test", "the Dashboard is down"], {
      env: {
        CLAUDE_CONFIG_DIR: join(scratch, "config-mac"),
        PLAYGROUND_DATA_DIR: join(join(scratch, "config-mac"), "playground"),
        HOME: scratch,
        ...(mac && { NOTIFY_MAC: mac }),
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stderr: "pipe",
    }).exited
  expect(await notify("")).toBe(0)
  expect(existsSync(shown)).toBe(false)
  const outbox = join(scratch, "config-mac", "playground", "ops", "outbox", "ops-test.jsonl")
  expect(readFileSync(outbox, "utf8")).toContain('"text": "the Dashboard is down"')
  expect(await notify("1")).toBe(0)
  expect(
    readFileSync(shown, "utf8")
      .split("\n")
      .filter((l) => l === "the Dashboard is down"),
  ).toHaveLength(1)
})

// A multi-line send within 400 characters keeps its length through the flatten, so its cut keeps every name whole.
test("a multi-line line within 400 characters goes whole, each newline one space", async () => {
  const text = Array.from(
    { length: 3 },
    (_, i) =>
      `  stale /Users/owner/acme/archive/.claude/worktrees/vx-${1000 + i}-some-chore vx-${1000 + i}`,
  ).join("\n")
  expect(text.length).toBeLessThanOrEqual(400)
  expect((await queued(text)).text).toBe(text.replace(/\n/g, " "))
})

test("a line past 400 characters stops at 400", async () => {
  const text = "stale /users/x/".repeat(40)
  expect(text.length).toBeGreaterThan(400)
  expect((await queued(text)).text).toBe(text.slice(0, 400))
})

// The relay tags each line with its queue file's job, so a job word that names another queue by a path would queue a line under that job's tag.
test.each(["../wa", "x/../../outbox/ops-wa", "WA", ""])(
  "a job outside lower-case letters, digits and hyphens (%p) is refused, and nothing is queued",
  async (job) => {
    const config = join(scratch, `config-${++configs}`)
    mkdirSync(join(config, "playground", "ops", "outbox", "ops-x"), { recursive: true })
    const proc = Bun.spawn(["bash", script, job, "a line"], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: scratch,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain("notify.sh: the job")
    expect(existsSync(join(config, "playground", "ops", "outbox", "ops-wa.jsonl"))).toBe(false)
    expect(existsSync(join(config, "playground", "ops", "alerts.log"))).toBe(false)
  },
)
