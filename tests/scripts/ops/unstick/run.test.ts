import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HERDR_SESSIONS } from "../../../../packages/scripts/src/ops-herdr/herdr"
import { refusalOf } from "../../../../packages/scripts/src/playground/prompt"
import { callKey, transcriptOf } from "../../../../packages/scripts/src/stuck-alert"
import { OLD_NAMES } from "../../../session-names"
import { storeWith } from "../../hooks/render-set"
import { machine } from "../run-slot-fake"

// ops-unstick is Python waiting for its TypeScript port, so these drive its pure readers through a Python of 3.13 (uv, as test:skills runs), else the runner's python3.
const RUN_PY = join(import.meta.dir, "../../../../scripts/ops/unstick/run.py")
const PYTHON = Bun.which("uv")
  ? ["uv", "run", "--quiet", "--python", "3.13", "python"]
  : ["python3"]
const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("run", sys.argv[1])
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)
call = json.loads(sys.stdin.read())
if "at" in call:
    run.time.time = lambda: call["at"]
notified = []
run.notify = lambda text, to="dispatcher": notified.append([to, text])
paths = [run.CODE, run.LW, run.OPS, run.HERE]
out = paths if call["fn"] == "paths" else getattr(run, call["fn"])(*call["args"])
print(json.dumps({"notified": notified, "result": out} if call.get("notified") else {"result": out, "state": call["args"][0]} if call.get("state") else out))
`

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ops-unstick-"))
  dirs.push(dir)
  // A machine past the switch, so the managers' old names place.
  storeWith(join(dir, "playground"), {}, { "sessions.aliases": OLD_NAMES })
  return dir
}

// Every run swaps notify for a recorder, so no test sends a line; `notified` returns what it would have sent beside the result, and `state` the first argument as the call left it.
const drive = async (
  env: Record<string, string>,
  config: string,
  body: { args: unknown[]; at?: number; fn: string; notified?: true; state?: true },
): Promise<unknown> => {
  const proc = Bun.spawn([...PYTHON, "-I", "-c", DRIVER, RUN_PY], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TZ: "UTC",
      // the sandbox's real-home uv folders, so uv finds its Python 3.13 rather than downloading one into the scratch home
      UV_CACHE_DIR: process.env.UV_CACHE_DIR,
      UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
      ...env,
    },
    stderr: "pipe",
    stdin: new TextEncoder().encode(JSON.stringify(body)),
    stdout: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`run.py ${body.fn} exited ${code}: ${err}`)
  return JSON.parse(out)
}
const callWith = (
  env: Record<string, string>,
  config: string,
  fn: string,
  ...args: unknown[]
): Promise<unknown> => drive(env, config, { args, fn })
const call = (config: string, fn: string, ...args: unknown[]): Promise<unknown> =>
  callWith({}, config, fn, ...args)
const notified = (config: string, fn: string, ...args: unknown[]) =>
  drive({}, config, { args, fn, notified: true }) as Promise<{
    notified: [string, string][]
    result: unknown
  }>

// Claude Code's registry, each name a live session: the test's own pid stands in for its claude.
const liveAs = (config: string, names: string[]) => {
  mkdirSync(join(config, "sessions"), { recursive: true })
  for (const [i, name] of names.entries())
    writeFileSync(
      join(config, "sessions", `${i}.json`),
      JSON.stringify({ name, pid: process.pid, sessionId: `s-${i}` }),
    )
}

const DAY = 86_400
// The reset as Claude Code prints it, "Oct 20 at 9:30pm", days from now in local time.
const printed = (days: number): string => {
  const at = new Date(Date.now() + days * DAY * 1000)
  const month = at.toLocaleString("en-US", { month: "short" })
  return `${month} ${at.getDate()} at 9:30pm`
}
const prompt = ["", "────────────────", "> ", "────────────────", "  ? for shortcuts"]
const weekly = (days: number, credits: "inline" | "below") => [
  "⏺ Working on the fix.",
  ...(credits === "inline"
    ? [
        `  ⎿  You've hit your weekly limit · resets ${printed(days)} · /usage-credits to finish what you're working on`,
      ]
    : [
        `  ⎿  You've hit your weekly limit · resets ${printed(days)}`,
        "     /usage-credits to finish what you're working on",
      ]),
  ...prompt,
]

describe("ops-unstick reads Claude Code's weekly limit line", () => {
  for (const credits of ["below", "inline"] as const)
    test(`as a usage-limit block until its dated reset, the /usage-credits hint ${credits}`, async () => {
      const config = scratch()
      const [kind, line, stuck] = (await call(config, "read_block", weekly(2, credits), {})) as [
        string,
        string,
        [string, number],
      ]
      expect(kind).toBe("usage-limit")
      expect(line).toBe(`hit your weekly limit · resets ${printed(2)}`)
      expect(stuck[1]).toBeLessThan(-DAY)
      expect(stuck[1]).toBeGreaterThan(-3 * DAY)
    })

  test("as stuck, not a block, once its dated reset is past", async () => {
    const [kind, , stuck] = (await call(scratch(), "read_block", weekly(-1, "below"), {})) as [
      string | null,
      string,
      [string, number],
    ]
    expect(kind).toBeNull()
    expect(stuck[1]).toBeGreaterThan(0)
  })

  // at 20:40Z (02:10 local) "resets 7:30pm" read as 400m past, though it was that evening's 7:30pm, and the block flapped on and off the list.
  const clock = (minutesFromNow: number, timeZone = "UTC"): string =>
    new Date(Date.now() + minutesFromNow * 60_000)
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })
      .replace(/\s/g, "")
      .toLowerCase()

  test("as the machine's own clock time, as Claude Code prints it", async () => {
    const screen = [
      `  ⎿  You've hit your weekly limit · resets ${clock(1040, "Asia/Kolkata")}`,
      ...prompt,
    ]
    const [kind, , stuck] = (await callWith(
      { TZ: "Asia/Kolkata" },
      scratch(),
      "read_block",
      screen,
      {},
    )) as [string | null, string, [string, number]]
    expect(kind).toBe("usage-limit")
    expect(stuck[1]).toBeLessThan(-1030 * 60)
    expect(stuck[1]).toBeGreaterThan(-1041 * 60)
  })

  test("as a usage-limit block on every cycle when its reset names no date and is 17 hours ahead", async () => {
    const screen = [`  ⎿  You've hit your weekly limit · resets ${clock(1040)}`, ...prompt]
    for (const cycle of [1, 2]) {
      const [kind, , stuck] = (await call(scratch(), "read_block", screen, {})) as [
        string | null,
        string,
        [string, number],
      ]
      expect(kind, `cycle ${cycle}`).toBe("usage-limit")
      expect(stuck[1]).toBeLessThan(-1030 * 60)
      expect(stuck[1]).toBeGreaterThan(-1041 * 60)
    }
  })

  test("as a usage-limit block when its reset names no date and is 19 hours ahead", async () => {
    const screen = [`  ⎿  You've hit your weekly limit · resets ${clock(1140)}`, ...prompt]
    const [kind, , stuck] = (await call(scratch(), "read_block", screen, {})) as [
      string | null,
      string,
      [string, number],
    ]
    expect(kind).toBe("usage-limit")
    expect(stuck[1]).toBeLessThan(-1130 * 60)
  })

  test("as stuck when a weekly reset with no date passed minutes ago", async () => {
    const screen = [`  ⎿  You've hit your weekly limit · resets ${clock(-5)}`, ...prompt]
    const [kind, , stuck] = (await call(scratch(), "read_block", screen, {})) as [
      string | null,
      string,
      [string, number],
    ]
    expect(kind).toBeNull()
    expect(stuck[1]).toBeGreaterThan(0)
  })

  test("as stuck when a five-hour reset with no date passed minutes ago", async () => {
    const screen = [`  ⎿  Usage limit reached · resets ${clock(-5)}`, ...prompt]
    const [kind, , stuck] = (await call(scratch(), "read_block", screen, {})) as [
      string | null,
      string,
      [string, number],
    ]
    expect(kind).toBeNull()
    expect(stuck[1]).toBeGreaterThan(0)
  })
})

// the capped account line and the dialog's room judge a session by the --account its spawn.sh resume record names, none for a GLM pin, else this machine's own login.
describe("a session's account, for the capped account line and the dialog's room", () => {
  // three days ahead, on the hour as usage.json's resets_at falls, so run.py never skips it as past and the wobble test's round(reset / 3600) holds
  const RESET = Math.ceil(Date.now() / 3_600_000) * 3600 + 3 * DAY
  const write = (path: string, body: string): void => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, body)
  }
  const usage = (
    config: string,
    file: string,
    account: string,
    pct: number,
    reset = RESET,
    at = new Date(),
  ) =>
    write(
      join(config, "playground", file),
      JSON.stringify({
        account,
        rate_limits: { seven_day: { resets_at: reset, used_percentage: pct } },
        writtenAt: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    )
  const record = (config: string, name: string, flags: string) =>
    write(
      join(config, "playground", "resume", `${name}.sh`),
      `#!/bin/bash\n# server: factory\nexec /x/scripts/spawn.sh resume ${name} /x 0b9e8f1a ${flags}\n`,
    )
  const machine = (ownPct: number, twoPct: number) => {
    const config = scratch()
    mkdirSync(join(config, "playground", "ops", "unstick"), { recursive: true })
    usage(config, "usage.json", "own@example.net", ownPct)
    usage(config, "usage-two.json", "two@example.com", twoPct)
    record(config, "worker-on-two", "--account two@example.com --model claude-opus-5-5")
    record(config, "dispatcher-2", "")
    write(join(config, "playground", "backends", "dispatcher-2"), "glm\n")
    return config
  }

  test("posts no line for usage.json's account at 98% when no live session runs on it", async () => {
    const config = machine(98, 22)
    const { notified: sent, result } = await notified(config, "capped_alert", [
      "worker-on-two",
      "dispatcher-2",
    ])
    expect(sent).toEqual([])
    expect(result).toEqual([])
  })

  test("reads a pin that names its harness, claude-code glm, as GLM, off the own login at 100%", async () => {
    const config = machine(100, 22)
    write(join(config, "playground", "backends", "dispatcher-2"), "claude-code glm\n")
    const { notified: sent } = await notified(config, "capped_alert", ["dispatcher-2"])
    expect(sent).toEqual([])
  })

  test("counts a session by its record's account line, a login spawn.sh's usage gate picked (PG-2137)", async () => {
    const config = machine(40, 100)
    write(
      join(config, "playground", "resume", "worker-picked.sh"),
      "#!/bin/bash\n# server: factory\n# account: two@example.com\nexec /x/scripts/spawn.sh resume worker-picked /x 0b9e8f1a\n",
    )
    const { notified: sent } = await notified(config, "capped_alert", ["worker-picked"])
    expect(sent).toHaveLength(2)
    expect(sent[0][1]).toStartWith("CAP 100%: two@example.com's week is at 100%")
  })

  test("counts a session with no --account on this machine's own login", async () => {
    const { notified: sent } = await notified(machine(100, 22), "capped_alert", ["worker-plain"])
    expect(sent).toHaveLength(2)
    expect(sent[0][1]).toStartWith("CAP 100%: own@example.net's week")
  })

  test("counts a session with no --account on usage.json's storedLogin while usage.json reads a factory account", async () => {
    const config = machine(40, 22)
    const own = JSON.parse(readFileSync(join(config, "playground", "usage.json"), "utf8"))
    write(
      join(config, "playground", "usage.json"),
      JSON.stringify({ ...own, storedLogin: { account: "stored@example.org", week: 100 } }),
    )
    const { notified: sent } = await notified(config, "capped_alert", ["worker-plain"])
    expect(sent).toHaveLength(2)
    expect(sent[0][1]).toStartWith("CAP 100%: stored@example.org's week is at 100%")
  })

  const stored = (config: string, week: number) => {
    const own = JSON.parse(readFileSync(join(config, "playground", "usage.json"), "utf8"))
    write(
      join(config, "playground", "usage.json"),
      JSON.stringify({ ...own, storedLogin: { account: "stored@example.org", week } }),
    )
  }

  test("reads a fresh storedLogin over a stale file of the same account, with that file's reset", async () => {
    const config = machine(40, 22)
    stored(config, 100)
    usage(
      config,
      "usage-stored.json",
      "stored@example.org",
      97,
      RESET,
      new Date(Date.now() - 3_600_000),
    )
    expect(await call(config, "room", "worker-plain")).toEqual([
      false,
      "stored@example.org: 7d 100%",
    ])
    const { notified: sent } = await notified(config, "capped_alert", ["worker-plain"])
    expect(sent).toHaveLength(2)
    expect(sent[0][1]).toStartWith(
      `CAP 100%: stored@example.org's week is at 100% (resets ${new Date(RESET * 1000).toUTCString().slice(0, 3)}`,
    )
  })

  test("takes no reset already past from a stale file of the storedLogin's account", async () => {
    const config = machine(40, 22)
    stored(config, 100)
    const past = Math.floor(Date.now() / 1000) - DAY
    usage(
      config,
      "usage-stored.json",
      "stored@example.org",
      97,
      past,
      new Date(Date.now() - 2 * DAY * 1000),
    )
    const { notified: sent } = await notified(config, "capped_alert", ["worker-plain"])
    expect(sent[0][1]).toStartWith(
      "CAP 100%: stored@example.org's week is at 100% (resets unknown)",
    )
    const keys = JSON.parse(
      readFileSync(join(config, "playground", "ops", "unstick", "capped-sent.json"), "utf8"),
    ).keys
    expect(keys["stored@example.org"]).toMatch(/^\d{4}-W\d{2}$/)
  })

  test("sends a storedLogin's line once a week though no file reads its reset", async () => {
    const config = machine(40, 22)
    stored(config, 100)
    const sends = async () =>
      (await notified(config, "capped_alert", ["worker-plain"])).notified.length
    expect(await sends()).toBe(2)
    expect(await sends()).toBe(0)
    const sentPath = join(config, "playground", "ops", "unstick", "capped-sent.json")
    const sentFile = JSON.parse(readFileSync(sentPath, "utf8"))
    expect(sentFile.keys["stored@example.org"]).toMatch(/^\d{4}-W\d{2}$/)
    write(sentPath, JSON.stringify({ ...sentFile, keys: { "stored@example.org": "2020-W01" } }))
    expect(await sends()).toBe(2)
  })

  test("names why a GLM pin has no room", async () => {
    expect(await call(machine(40, 22), "room", "dispatcher-2")).toEqual([
      false,
      "a GLM session, which no usage file reads",
    ])
  })

  test("sends once across a reset that wobbles by a second over the hour, and again the next week", async () => {
    const config = machine(100, 22)
    const sends = async (reset: number) => {
      usage(config, "usage.json", "own@example.net", 100, reset)
      return (await notified(config, "capped_alert", ["worker-plain"])).notified.length
    }
    expect(await sends(RESET)).toBe(2)
    expect(await sends(RESET - 1)).toBe(0)
    expect(await sends(RESET)).toBe(0)
    expect(await sends(RESET + 7 * DAY)).toBe(2)
  })

  test("reads no room for a session whose record names a spare at 100%, though usage.json has room", async () => {
    expect(await call(machine(40, 100), "room", "worker-on-two")).toEqual([
      false,
      "two@example.com: 7d 100%",
    ])
  })

  test("reads room for a session on a factory account under 100%, though usage.json is spent", async () => {
    expect(await call(machine(100, 60), "room", "worker-on-two")).toEqual([
      true,
      "two@example.com: 7d 60%",
    ])
  })
})

describe("the usage-limit dialog's Escape", () => {
  const dialog = (days: number) => [
    `  ⎿  You've hit your weekly limit · resets ${printed(days)}`,
    "",
    "  What do you want to do?",
    "",
    "  ❯ 1. Stop and wait for limit to reset",
    "    2. Switch to extra usage",
    "",
    "  Enter to confirm · Esc to cancel",
  ]
  const spent = (config: string) => {
    mkdirSync(join(config, "playground"), { recursive: true })
    writeFileSync(
      join(config, "playground", "usage.json"),
      JSON.stringify({
        account: "pat@example.com",
        rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 100 } },
        writtenAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    )
    return config
  }

  test("goes once the printed reset has passed, though usage.json still reads the week spent", async () => {
    const [room, why] = (await call(
      spent(scratch()),
      "dialog_room",
      "worker-brave-otter",
      dialog(-1),
    )) as [boolean, string]
    expect(room).toBe(true)
    expect(why).toStartWith("its reset (")
  })

  test("waits while the week is spent and its reset is ahead", async () => {
    const [room, why] = (await call(
      spent(scratch()),
      "dialog_room",
      "worker-brave-otter",
      dialog(2),
    )) as [boolean, string]
    expect(room).toBe(false)
    expect(why).toBe("pat@example.com: 5h 12%, 7d 100%")
  })
})

describe("run from the repo", () => {
  test("keeps its state in $PLAYGROUND_DATA_DIR, never in the checkout", async () => {
    const config = scratch()
    const [code, lw, ops, here] = (await call(config, "paths")) as string[]
    expect(code).toBe(join(import.meta.dir, "../../../../scripts/ops"))
    expect([lw, ops, here]).toEqual([
      join(config, "playground"),
      join(config, "playground", "ops"),
      join(config, "playground", "ops", "unstick"),
    ])
  })
})

describe("an account move", () => {
  const moveFile = (config: string, move: unknown): void => {
    mkdirSync(join(config, "playground", "ops", "unstick"), { recursive: true })
    writeFileSync(join(config, "playground", "ops", "unstick", "move.json"), JSON.stringify(move))
  }
  const iso = (secondsFromNow: number): string =>
    new Date(Date.now() + secondsFromNow * 1000).toISOString().replace(/\.\d+Z$/, "Z")

  test("names its dispatcher while move.json's until is ahead", async () => {
    const config = scratch()
    moveFile(config, { to: "dispatcher-2", until: iso(3600) })
    expect(await call(config, "moving")).toBe("dispatcher-2")
  })

  test("names none once until has passed, with no move.json, or with a name that is not a session's", async () => {
    const past = scratch()
    moveFile(past, { to: "dispatcher-2", until: iso(-60) })
    expect(await call(past, "moving")).toBeNull()
    expect(await call(scratch(), "moving")).toBeNull()
    const odd = scratch()
    moveFile(odd, { to: "dispatcher 2; rm", until: iso(3600) })
    expect(await call(odd, "moving")).toBeNull()
  })

  test("reads an until written with milliseconds or an offset, and no move from one with no zone", async () => {
    const until = new Date(Date.now() + 3600 * 1000)
    const ms = scratch()
    moveFile(ms, { to: "dispatcher-2", until: until.toISOString() })
    expect(await call(ms, "moving")).toBe("dispatcher-2")
    const offset = scratch()
    moveFile(offset, {
      to: "dispatcher-2",
      until: until.toISOString().replace(/\.\d+Z$/, "+00:00"),
    })
    expect(await call(offset, "moving")).toBe("dispatcher-2")
    const bare = scratch()
    moveFile(bare, { to: "dispatcher-2", until: until.toISOString().replace(/\.\d+Z$/, "") })
    expect(await call(bare, "moving")).toBeNull()
  })

  test("holds only a limit block's own alert, and only while a move runs", async () => {
    const config = scratch()
    expect(await call(config, "held_for_move", "usage-limit", "dispatcher-2")).toBe(true)
    expect(await call(config, "held_for_move", "usage-limit-stuck", "dispatcher-2")).toBe(true)
    expect(await call(config, "held_for_move", "permission", "dispatcher-2")).toBe(false)
    expect(await call(config, "held_for_move", "usage-limit", null)).toBe(false)
  })

  test("sums the limit blocks into one line and names every other block", async () => {
    const blocks = {
      a: { kind: "usage-limit", name: "worker-b" },
      b: { kind: "usage-limit-stuck", name: "worker-a" },
      c: { kind: "permission", name: "tester-c" },
    }
    expect(await call(scratch(), "move_summary", blocks)).toBe(
      "2 sessions blocked on the usage limit. Blocked for another reason: tester-c (permission). On the limit: worker-a, worker-b",
    )
    expect(await call(scratch(), "move_summary", { a: blocks.a })).toBe(
      "1 session blocked on the usage limit. Nothing blocked for another reason. On the limit: worker-b",
    )
  })

  test("keeps the count and the other blocks inside notify.sh's 400-character cut with 25 sessions at the limit", async () => {
    const blocks: Record<string, { kind: string; name: string }> = {
      z: { kind: "permission", name: "tester-calm-ridge" },
    }
    for (let i = 0; i < 12; i++)
      blocks[`o${i}`] = { kind: "picker", name: `tester-calm-ridge-${i}` }
    for (let i = 0; i < 25; i++)
      blocks[`s${i}`] = { kind: "usage-limit", name: `worker-steady-lathe-${i}` }
    const line = (await call(scratch(), "move_summary", blocks)) as string
    expect(line.length).toBeGreaterThan(400)
    expect(line.slice(0, 400)).toStartWith("25 sessions blocked on the usage limit.")
    expect(line.slice(0, 400)).toContain("tester-calm-ridge (permission)")
  })
})

// review round 1: under the load units a waiter for units that are not free waits beside a free run-slot by design
describe("the slot-stuck alert", () => {
  // older: a big ticket older than the medium one, which the window has tracked; took: a start of run-slot in the runs log inside the window
  const queue = (held: boolean, { older = false, took = false } = {}) => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    const bin = join(config, "bin")
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    mkdirSync(bin)
    writeFileSync(
      join(bin, "sysctl"),
      `#!/bin/bash\ncase "$2" in vm.loadavg) echo "{ 2.00 2.00 2.00 }" ;; esac\n`,
    )
    chmodSync(join(bin, "sysctl"), 0o755)
    for (const off of ["run-slot.3-off", "run-slot.4-off"]) writeFileSync(join(ops, off), "")
    if (held) {
      mkdirSync(join(ops, "run-slot-2"))
      writeFileSync(
        join(ops, "run-slot-2.holder"),
        `worker-big ${process.pid} 2026-10-18T19:00:00Z 3 big\n`,
      )
    }
    writeFileSync(join(ops, "run-slot.waiters", `2-${process.pid}-worker-m`), "s2 22 2 medium\n")
    if (older)
      writeFileSync(join(ops, "run-slot.waiters", `1-${process.pid}-worker-big`), "s2 23 3 big\n")
    const now = Date.now() / 1000
    if (took)
      writeFileSync(
        join(ops, "run-slot.runs.log"),
        `${new Date((now - 60) * 1000).toISOString().slice(0, 19)}Z start worker-x 4242 run-slot waited=3s\n`,
      )
    const state = { slot_free: { since: now - 200, ticket: `${older ? 1 : 2}${process.pid}` } }
    return callWith(
      { PATH: `${bin}:${process.env.PATH}`, RUN_SLOT_SIZE: "medium" },
      config,
      "slot_stuck",
      state,
      now,
    )
  }

  test("pages when the waiter could take run-slot", async () => {
    const alert = (await queue(false)) as { case: string; kind: string; line: string; name: string }
    expect(alert.kind).toBe("slot-stuck")
    expect(alert.name).toBe("worker-m")
    expect(alert.case).toBe("could-take")
    expect(alert.line).toContain("could take it and takes nothing")
    expect(alert.line).not.toContain("held by")
  })

  // issue 1842: under the battery's or focus's hold can-take reads closed, so the alert names the hold the queue waits on, not a stall, and sends nothing
  const HOLD = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("run", sys.argv[1])
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)
clock = [1_800_000_000.0]
run.time.time = lambda: clock[0]
sent = []
run.notify = lambda text, to="dispatcher": sent.append([to, text])
run.log = lambda line: None
for fn in ("stall", "ending_alert", "api_stop_alerts", "slot_idle_alerts", "docker_check", "memory_files", "heavy_jobs", "slot_alerts", "capped_alert"):
    setattr(run, fn, lambda *a, **k: [])
run.herdr_sessions = lambda: []
run.moving = lambda now_t=None: None
os.makedirs(run.HERE, exist_ok=True)
state = {"blocks": {}}
run.cycle(state)
clock[0] += 200
run.cycle(state)
alerts = json.load(open(os.path.join(run.OPS, "alerts-pending.json")))["alerts"]
print(json.dumps({"alerts": [a for a in alerts if a["kind"] == "slot-stuck"], "sent": sent}))
`
  // two cycles over an ops folder `setup` fills, with `path` ahead of the run's PATH for a fake machine's load
  const cycled = async (setup: (ops: string) => void, path?: string) => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    setup(ops)
    const proc = Bun.spawn([...PYTHON, "-I", "-c", HOLD, RUN_PY], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: process.env.HOME,
        PATH: path ? `${path}:${process.env.PATH}` : process.env.PATH,
        RUN_SLOT_SIZE: "medium",
        TZ: "UTC",
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, err).toBe(0)
    return JSON.parse(out) as {
      alerts: { case: string; line: string; name: string }[]
      sent: [string, string][]
    }
  }
  const held = (file: string, line: string) =>
    cycled((ops) => {
      for (const off of ["run-slot.3-off", "run-slot.4-off"]) writeFileSync(join(ops, off), "")
      writeFileSync(join(ops, file), line)
      writeFileSync(join(ops, "run-slot.waiters", `2-${process.pid}-worker-m`), "s2 22 2 medium\n")
    })
  // issue 1647: a fresh medium head beside run-slot-2's medium run, at the load5 given, fits only while slots 3 and 4 open, which the load brake shuts at the cap; `run-slot.sh head` names no waiter that does not fit, and the brake lapses LOAD_WAIT s after the oldest ask, well before a ticket pins at AGED, so a waiter the brake holds is never the head this check watches
  const braked = (load5: number) =>
    cycled((ops) => {
      mkdirSync(join(ops, "run-slot-2"))
      writeFileSync(
        join(ops, "run-slot-2.holder"),
        `worker-s ${process.pid} 2026-11-11T12:00:00Z 2 medium\n`,
      )
      writeFileSync(
        join(ops, "run-slot.waiters", `${Date.now()}000000-${process.pid}-worker-m`),
        "s2 22 2 medium\n",
      )
    }, machine({ load5 }).bin)

  test("lists and sends nothing for a head the load brake holds", async () => {
    expect(await braked(30)).toEqual({ alerts: [], sent: [] })
  })

  test("still sends the could-take line for the same head with load5 under the cap", async () => {
    const { alerts, sent } = await braked(2)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].case).toBe("could-take")
    expect(alerts[0].name).toBe("worker-m")
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toContain("could take it and takes nothing")
  })

  test("names the battery's hold and sends no stall line", async () => {
    const { alerts, sent } = await held(
      "run-slot.battery",
      "ops 2026-11-11T12:00:00Z 2099-01-01T00:00:00Z held for the row\n",
    )
    expect(sent).toEqual([])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].case).toBe("hold")
    expect(alerts[0].name).toBe("worker-m")
    expect(alerts[0].line).toContain("held by the battery's red mark (run-slot.battery)")
    expect(alerts[0].line).not.toContain("fit no open slot")
    expect(alerts[0].line).not.toContain("could take")
  })

  test("names the focus hold with its holder and sends no stall line", async () => {
    const { alerts, sent } = await held(
      "run-slot.focus",
      "worker-f 2026-11-11T12:00:00Z 2099-01-01T00:00:00Z focus for the row\n",
    )
    expect(sent).toEqual([])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].case).toBe("hold")
    expect(alerts[0].line).toContain("held by worker-f's focus (run-slot.focus)")
    expect(alerts[0].line).not.toContain("fit no open slot")
    expect(alerts[0].line).not.toContain("could take")
  })

  test("stays quiet while the waiter's units are not free", async () => {
    expect(await queue(true)).toBeNull()
  })

  // issue 1216: can-take read the session's size, so a pinned big head read as a medium paged while its own 3 units could not fit;
  // issue 1416: the free slot no waiter fits is named, with the head's own ticket units, and carries no "could take it" line
  test("names the free slot no waiter fits, with the head's own ticket units", async () => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    const bin = join(config, "bin")
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    mkdirSync(bin)
    writeFileSync(
      join(bin, "sysctl"),
      `#!/bin/bash\ncase "$2" in vm.loadavg) echo "{ 2.00 2.00 2.00 }" ;; esac\n`,
    )
    chmodSync(join(bin, "sysctl"), 0o755)
    for (const off of ["run-slot.3-off", "run-slot.4-off"]) writeFileSync(join(ops, off), "")
    mkdirSync(join(ops, "run-slot-2"))
    writeFileSync(
      join(ops, "run-slot-2.holder"),
      `worker-s ${process.pid} 2026-10-18T19:00:00Z 1 small\n`,
    )
    const head = join(ops, "run-slot.waiters", `1-${process.pid}-worker-big`)
    writeFileSync(head, "s2 23 3 big\n")
    const pinned = Date.now() / 1000 - 1300
    utimesSync(head, pinned, pinned)
    const now = Date.now() / 1000
    const state = { slot_free: { since: now - 200, ticket: `1${process.pid}` } }
    const alert = (await callWith(
      { PATH: `${bin}:${process.env.PATH}`, RUN_SLOT_SIZE: "medium" },
      config,
      "slot_stuck",
      state,
      now,
    )) as { kind: string; line: string }
    expect(alert.kind).toBe("slot-stuck")
    expect(alert.line).toContain("its 3 units fit no open slot")
    expect(alert.line).toContain("run-slot-2 holds 1 unit")
    expect(alert.line).not.toContain("could take")
  })

  // issue 1416, the lead's condition: a free slot no waiter fits is the units rule working, and in single mode it can last the whole
  // switch window, so the line sends once per episode, keyed on the head ticket the way the could-take line's send dedupes, and a new
  // head ticket sends again. The episode state lives on state["slot_free"], so the driver calls cycle() on one state, in one process.
  const EPISODE = `
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("run", sys.argv[1])
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)
real_time = time.time
clock = [1_800_000_000.0]
run.time.time = lambda: clock[0]
sent = []
run.notify = lambda text, to="dispatcher": sent.append([to, text])
run.log = lambda line: None
for fn in ("stall", "ending_alert", "api_stop_alerts", "slot_idle_alerts", "docker_check", "memory_files", "heavy_jobs", "slot_alerts", "capped_alert"):
    setattr(run, fn, lambda *a, **k: [])
run.herdr_sessions = lambda: []
run.moving = lambda now_t=None: None
os.makedirs(run.HERE, exist_ok=True)
state = {"blocks": {}}
run.cycle(state)
clock[0] += 200
run.cycle(state)
run.cycle(state)
aged = real_time() - 1300
new = os.path.join(run.OPS, "run-slot.waiters", "2-%d-worker-big2" % os.getpid())
with open(new, "w") as f:
    f.write("s2 23 3 big\\n")
os.utime(new, (aged, aged))
waiters = os.path.join(run.OPS, "run-slot.waiters")
for f in os.listdir(waiters):
    if f.endswith("-worker-big"):
        os.remove(os.path.join(waiters, f))
clock[0] += 200
run.cycle(state)
clock[0] += 200
run.cycle(state)
print(json.dumps(sent))
`
  test("sends once per episode, and again for a new head ticket", async () => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    mkdirSync(join(ops, "run-slot-2"), { recursive: true })
    writeFileSync(join(ops, "run-slot-2.holder"), `worker-big 1 2026-10-18T19:00:00Z 3 big\n`)
    for (const off of ["run-slot.3-off", "run-slot.4-off"]) writeFileSync(join(ops, off), "")
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    const head = join(ops, "run-slot.waiters", `1-${process.pid}-worker-big`)
    writeFileSync(head, "s2 23 3 big\n")
    const pinned = Date.now() / 1000 - 1300
    utimesSync(head, pinned, pinned)
    const proc = Bun.spawn([...PYTHON, "-I", "-c", EPISODE, RUN_PY], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TZ: "UTC",
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, err).toBe(0)
    const sent = JSON.parse(out) as [string, string][]
    expect(sent).toHaveLength(2)
    expect(sent[0][0]).toBe("builder")
    expect(sent[0][1]).toContain("its 3 units fit no open slot")
    expect(sent[0][1]).toContain("run-slot-2 holds 3 units")
    expect(sent[0][1]).not.toContain("could take")
    expect(sent[1][1]).toContain("worker-big2")
  })

  // the same episode's kind change: after the no-fit send the holder in run-slot-2 ends, the same head's can-take passes,
  // and the could-take line sends too, once, the two lines keyed per kind on the episode the head ticket holds
  const EPISODE_KIND = `
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("run", sys.argv[1])
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)
clock = [1_800_000_000.0]
run.time.time = lambda: clock[0]
sent = []
run.notify = lambda text, to="dispatcher": sent.append([to, text])
run.log = lambda line: None
for fn in ("stall", "ending_alert", "api_stop_alerts", "slot_idle_alerts", "docker_check", "memory_files", "heavy_jobs", "slot_alerts", "capped_alert"):
    setattr(run, fn, lambda *a, **k: [])
run.herdr_sessions = lambda: []
run.moving = lambda now_t=None: None
os.makedirs(run.HERE, exist_ok=True)
state = {"blocks": {}}
run.cycle(state)
clock[0] += 200
run.cycle(state)
os.remove(os.path.join(run.OPS, "run-slot-2.holder"))
os.rmdir(os.path.join(run.OPS, "run-slot-2"))
clock[0] += 200
run.cycle(state)
clock[0] += 200
run.cycle(state)
print(json.dumps(sent))
`
  test("sends the could-take line when the holder ends and the same head can take it", async () => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    mkdirSync(join(ops, "run-slot-2"), { recursive: true })
    writeFileSync(join(ops, "run-slot-2.holder"), `worker-big 1 2026-10-18T19:00:00Z 3 big\n`)
    for (const off of ["run-slot.3-off", "run-slot.4-off", "run-slot.single"])
      writeFileSync(join(ops, off), "")
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    const head = join(ops, "run-slot.waiters", `1-${process.pid}-worker-big`)
    writeFileSync(head, "s2 23 3 big\n")
    const pinned = Date.now() / 1000 - 1300
    utimesSync(head, pinned, pinned)
    const proc = Bun.spawn([...PYTHON, "-I", "-c", EPISODE_KIND, RUN_PY], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TZ: "UTC",
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, err).toBe(0)
    const sent = JSON.parse(out) as [string, string][]
    expect(sent).toHaveLength(2)
    expect(sent[0][0]).toBe("builder")
    expect(sent[0][1]).toContain("its 3 units fit no open slot")
    expect(sent[0][1]).toContain("run-slot-2 holds 3 units")
    expect(sent[0][1]).not.toContain("could take")
    expect(sent[1][1]).toContain("worker-big")
    expect(sent[1][1]).toContain("could take it and takes nothing")
  })

  // 31 Oct: both alerts named a big session's ticket, the oldest, which ranks behind a newer medium one by design
  test("watches the queue's head, so an older big ticket behind a newer medium one fires nothing", async () => {
    expect(await queue(false, { older: true })).toBeNull()
  })

  // 31 Oct: two samples 2 minutes apart read free while the runs log shows run-slot taken 5 times between them
  test("stays quiet when the runs log shows run-slot taken inside the window", async () => {
    expect(await queue(false, { took: true })).toBeNull()
  })
})

// a lead is known by its roster kind, so a manager respawned under a new name is still known as one, and every alert names a kind notify.sh resolves.
describe("managers by kind", () => {
  test("a lead by its roster kind, else by its <id>-<kind> name or today's name (PG-1644)", async () => {
    const config = scratch()
    mkdirSync(join(config, "playground"), { recursive: true })
    writeFileSync(
      join(config, "playground", "roster.json"),
      JSON.stringify({
        agents: [
          { kind: "builder", name: "x7mh4d-builder" },
          { kind: "worker", name: "k3v9q2-worker" },
        ],
      }),
    )
    const kinds = await call(config, "roster_kinds")
    expect(kinds).toEqual({ "k3v9q2-worker": "worker", "x7mh4d-builder": "builder" })
    for (const [name, lead] of [
      ["x7mh4d-builder", true],
      ["builder", true],
      ["planner", true],
      ["k3v9q2-worker", false],
      ["dispatcher", false],
      ["m4n7vw-builder", true],
      ["m4n7vw-ops", true],
      ["m4n7vw-planner", true],
      ["m4n7vw-dispatcher", false],
      ["ops-dashboard", false],
    ] as const)
      expect(await call(config, "is_lead", name, kinds), name).toBe(lead)
  })

  test("a session's lead is a kind word", async () => {
    const config = scratch()
    expect(await call(config, "lead_of", "worker-greed")).toBe("builder")
    expect(await call(config, "lead_of", "runner-pride")).toBe("ops")
    expect(await call(config, "lead_of", "ops")).toBe("dispatcher")
    expect(await call(config, "lead_of", "m4n7vw-ops")).toBe("dispatcher")
    expect(await call(config, "lead_of", "m4n7vw-dispatcher")).toBe("builder")
    expect(await call(config, "lead_of", "dispatcher")).toBe("builder")
    expect(await call(config, "lead_of", "dispatcher-2")).toBe("dispatcher")
  })

  test("the second dispatcher's lead is the first dispatcher, never the builder (PG-1644)", async () => {
    const config = scratch()
    mkdirSync(join(config, "playground"), { recursive: true })
    writeFileSync(
      join(config, "playground", "roster.json"),
      JSON.stringify({
        agents: [
          { kind: "dispatcher", name: "m4n7vw-dispatcher", status: "working", task: "t" },
          { kind: "dispatcher", name: "q8r2tx-dispatcher", slot: 2, status: "working", task: "t" },
        ],
      }),
    )
    expect(await call(config, "lead_of", "q8r2tx-dispatcher")).toBe("dispatcher")
    expect(await call(config, "lead_of", "m4n7vw-dispatcher")).toBe("builder")
  })
})

// a probe's prompts are its spawner's to answer, so its block alert goes to the session its spawn brief names, never dispatcher.
describe("block alerts", () => {
  test("a probe's go to its live spawner, else the builder; a worker's to its manager (PG-2184)", async () => {
    const config = scratch()
    liveAs(config, ["worker-mild-lark", "builder"])
    const transcript = join(config, "probe.jsonl")
    const brief =
      "You are probe-herdr-answer, a probe in the Playground factory; you report to worker-mild-lark. Report to worker-mild-lark with SendMessage (to: worker-mild-lark)."
    writeFileSync(
      transcript,
      `${JSON.stringify({ message: { content: brief, role: "user" }, type: "user" })}\n`,
    )
    expect(await call(config, "alert_to", "probe-herdr-answer", transcript)).toBe(
      "worker-mild-lark",
    )
    expect(
      await call(config, "alert_to", "probe-herdr-answer", join(config, "missing.jsonl")),
    ).toBe("builder")
    expect(await call(config, "alert_to", "probe-herdr-answer", null)).toBe("builder")
    expect(await call(config, "alert_to", "worker-mild-lark", null)).toBe("builder")
    expect(await call(config, "limit_targets", "probe-herdr-answer", transcript)).toEqual([
      "worker-mild-lark",
    ])
    expect(await call(config, "limit_targets", "worker-mild-lark", transcript)).toEqual([])
  })
})

// A subagent's prompt whose hook record a later Stop replaced reaches ops-unstick's screen alone, which read no key off it (PG-385).
describe("a permission prompt read off the screen", () => {
  const SESSION = "d9d2ef1a-a7b9-4ecb-a758-087576d79391"
  const COMMAND = "mkdir -p /tmp/spec && cd /tmp/spec"
  const DASHES = "╌".repeat(27)
  const screenOf = (command: string) => [
    `⏺ Bash(${command})`,
    "─".repeat(27),
    " Bash command",
    DASHES,
    ` │ ${command}`,
    DASHES,
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for mkdir commands",
    "   3. No, and tell Claude what to do differently (esc)",
  ]
  const line = (type: string, part: Record<string, unknown>) =>
    JSON.stringify({ message: { content: [part] }, type })
  // The session's own transcript, its turn ended, and a subagent's beside it whose Bash call waits on the prompt.
  const transcripts = (config: string) => {
    const dir = join(config, "projects", "-repo")
    mkdirSync(join(dir, SESSION, "subagents"), { recursive: true })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      `${line("assistant", { id: "t1", input: { prompt: "Spec read" }, name: "Agent", type: "tool_use" })}\n${line("user", { tool_use_id: "t1", type: "tool_result" })}\n`,
    )
    writeFileSync(
      join(dir, SESSION, "subagents", "agent-a7d782.jsonl"),
      `${line("assistant", { id: "t2", input: { command: COMMAND }, name: "Bash", type: "tool_use" })}\n`,
    )
  }

  test("carries the key of the subagent's waiting call, which picker's allow accepts", async () => {
    const config = scratch()
    transcripts(config)
    const screen = screenOf(COMMAND)
    const answer = String(await call(config, "prompt_answer", "k3m9px-worker", SESSION, screen))
    const key = /playground picker k3m9px-worker allow ([0-9a-f]{8})/.exec(answer)?.[1] ?? ""
    expect(key).toBe(callKey({ command: COMMAND }))
    const transcript = await transcriptOf(config, SESSION)
    expect(refusalOf("k3m9px-worker", screen.join("\n"), transcript, key)).toBe("")
  })

  // no-raw-spawn refuses the dispatcher's herdr call too, so the route left is a close and a resume by session id
  test("names the close and resume when no waiting call is surely its own", async () => {
    const config = scratch()
    transcripts(config)
    const answer = String(
      await call(config, "prompt_answer", "k3m9px-worker", SESSION, screenOf("rm -rf /tmp/spec")),
    )
    expect(answer).toContain("spawn.sh close k3m9px-worker")
    expect(answer).toContain("~/.playground/resume/k3m9px-worker.sh")
    expect(answer).not.toContain("dispatcher")
  })
})

// ops-unstick reads herdr alone (#419): the source test below holds run.py to no cmux command, and these read herdr's panes.
describe("the session read", () => {
  const pid = String(process.pid)
  const script = (path: string, body: string): void => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  // A herdr server whose one pane runs claude at `held` (none when null).
  const machine = (held: string | null) => {
    const config = scratch()
    const bin = join(config, "bin")
    const herdrDir = join(config, "herdr")
    mkdirSync(bin)
    mkdirSync(herdrDir)
    mkdirSync(join(config, "sessions"))
    writeFileSync(join(herdrDir, "factory.sock"), "")
    const panes = held ? '[{"pane_id":"p1","workspace_id":"w1"}]' : "[]"
    const info = `{"result":{"process_info":{"foreground_processes":[{"argv":["claude"],"name":"claude","pid":${held}}]}}}`
    script(
      join(bin, "herdr"),
      `case "$1 $2" in\n"pane list") echo '{"result":{"panes":${panes}}}' ;;\n"pane process-info") echo '${info}' ;;\n*) exit 1 ;;\nesac`,
    )
    // Claude's registry entry at the pane's pid, which gives the session's id.
    writeFileSync(
      join(config, "sessions", `${pid}.json`),
      JSON.stringify({
        entrypoint: "cli",
        pid: Number(pid),
        sessionId: "0b9e8f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b",
      }),
    )
    const env = {
      PLAYGROUND_HERDR_DIR: herdrDir,
      PLAYGROUND_HERDR_SESSIONS: "factory",
      HERDR_BIN_PATH: join(bin, "herdr"),
      PATH: `${bin}:${process.env.PATH}`,
    }
    return { config, env }
  }

  test("reads herdr's sessions with the registry's session id", async () => {
    const { config, env } = machine(pid)
    const found = (await callWith(env, config, "herdr_sessions")) as {
      herdr: string
      pid: string
      session_id: string
    }[]
    expect(found.map((s) => [s.herdr, s.pid, s.session_id])).toEqual([
      ["factory", pid, "0b9e8f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b"],
    ])
  })

  test("runs the pinned herdr in HOME's data folder when HERDR_BIN_PATH is unset", async () => {
    const { config, env } = machine(pid)
    const { HERDR_BIN_PATH: bin, ...rest } = env
    const home = scratch()
    mkdirSync(join(home, ".playground", "bin"), { recursive: true })
    script(join(home, ".playground", "bin", "herdr"), readFileSync(bin, "utf8"))
    const found = (await callWith({ ...rest, HOME: home }, config, "herdr_sessions")) as {
      pid: string
    }[]
    expect(found.map((s) => s.pid)).toEqual([pid])
  })

  test("reads no session and fails nothing while the registry's live session runs in no herdr pane", async () => {
    const { config, env } = machine(null)
    expect(await callWith(env, config, "herdr_sessions")).toEqual([])
  })

  test("run.py names no cmux command, so a cycle, its reads and its Escape run on herdr alone", () => {
    expect(readFileSync(RUN_PY, "utf8")).not.toMatch(/["']cmux["']/)
  })
})

describe("the quiet read", () => {
  const line = (type: string, secondsAgo: number) =>
    JSON.stringify({ timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(), type })
  const quiet = async (lines: string[]): Promise<number> => {
    const config = scratch()
    const path = join(config, "t.jsonl")
    writeFileSync(path, `${lines.join("\n")}\n`)
    return (await call(config, "quiet_for", path, Date.now() / 1000)) as number
  }

  test("counts a session whose newest work line is old as quiet, though queued messages wrote since", async () => {
    expect(
      await quiet([
        line("assistant", 300),
        line("queue-operation", 20),
        line("queue-operation", 5),
      ]),
    ).toBeGreaterThan(290)
  })

  test("passes over the lines Claude Code writes with no timestamp", async () => {
    const untimed = [
      "last-prompt",
      "custom-title",
      "agent-name",
      "mode",
      "permission-mode",
      "atis-latch",
    ].map((type) => JSON.stringify({ type }))
    expect(
      await quiet([
        line("assistant", 300),
        ...untimed,
        line("queue-operation", 20),
        line("queue-operation", 5),
      ]),
    ).toBeGreaterThan(290)
  })

  test("counts a session that wrote a work line just now as at work", async () => {
    expect(await quiet([line("queue-operation", 30), line("assistant", 5)])).toBeLessThan(60)
  })

  test("counts a line still being written as at work", async () => {
    expect(await quiet([line("assistant", 300), '{"type":"assis'])).toBeLessThan(60)
  })
})

// Claude Code's autocompact thrashing stop is an API error line; its resume and its lead's line name the small-reads fix, since redoing the step refills the context.
describe("an api-error stop", () => {
  const THRASH =
    "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh."
  const stopped = (config: string, text: string) => {
    const transcript = join(config, "stopped.jsonl")
    const line = {
      apiError: "autocompact_thrashing",
      error: "invalid_request",
      isApiErrorMessage: true,
      message: { content: [{ text, type: "text" }], role: "assistant" },
      timestamp: "2026-10-19T20:43:00.000Z",
      type: "assistant",
      uuid: "e1",
    }
    writeFileSync(transcript, `${JSON.stringify(line)}\n`)
    return transcript
  }

  test("reads a thrash stop from the transcript, and its lines name small reads and a fresh start", async () => {
    const config = scratch()
    const transcript = stopped(config, THRASH)
    const [entry, text] = (await call(
      config,
      "api_error_stop",
      { session_id: "s1", transcript_path: transcript },
      Date.now() / 1000 + 300,
    )) as [string, string, number]
    expect(entry).toBe("e1")
    expect(text.startsWith("Autocompact is thrashing")).toBe(true)
    const [resume, lead] = (await call(config, "api_stop_lines", "worker-x", text, "5m")) as [
      string,
      string,
    ]
    expect(resume).toContain("Carry on with small reads (Read with offset and limit, grep, head")
    expect(resume).not.toContain("redo the step")
    expect(resume.length).toBeLessThanOrEqual(400)
    expect(lead).toBe(
      "worker-x stopped on autocompact thrashing and sat idle 5m; ops-unstick sent it a resume line with small reads. If it thrashes again, start it fresh from its brief (api-error stop).",
    )
  })

  test("a stop its StopFailure hook recorded as failed is ops-session-resume's, and an older failed record leaves it here (#1637)", async () => {
    const config = scratch()
    const transcript = stopped(config, "API Error: Connection lost mid-response")
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    const record = (at: string) =>
      writeFileSync(
        join(states, "s1.json"),
        JSON.stringify({
          at,
          event: "StopFailure",
          reason: "server_error",
          sessionId: "s1",
          state: "failed",
        }),
      )
    const stop = () =>
      call(
        config,
        "api_error_stop",
        { session_id: "s1", transcript_path: transcript },
        Date.now() / 1000 + 300,
      )
    expect(await stop()).not.toBeNull()
    record("2026-10-19T20:43:00.027Z")
    expect(await stop()).toBeNull()
    record("2026-10-19T20:40:00.000Z")
    expect(await stop()).not.toBeNull()
  })

  test("any other API error keeps its redo line", async () => {
    const config = scratch()
    const [resume, lead] = (await call(
      config,
      "api_stop_lines",
      "worker-x",
      "API Error: Server error mid-response",
      "3m",
    )) as [string, string]
    expect(resume).toBe(
      "ops-unstick: your last turn ended on an API error (API Error: Server error mid-response) and you have sat idle 3m since. Carry on from where you stopped: redo the step that failed.",
    )
    expect(lead).toBe(
      "worker-x stopped on an API error (API Error: Server error mid-response) and sat idle 3m; ops-unstick sent it a resume line (api-error stop).",
    )
  })
})

describe("factory names (#966)", () => {
  test("an <id>-<kind> name reads as its kind, as an old prefixed name does, and goes to its lead", async () => {
    const config = scratch()
    const names = [
      "k3m9px-worker",
      "k3m9px-reviewer",
      "k3m9px-runner",
      "k3m9px-probe",
      "worker-greed",
      "runner-calm-heron",
      "probe-x",
      "builder",
      "k3m9px-builder",
      "worker-",
    ]
    expect(await Promise.all(names.map((name) => call(config, "kind_of_name", name)))).toEqual([
      "worker",
      "reviewer",
      "runner",
      "probe",
      "worker",
      "runner",
      "probe",
      null,
      null,
      null,
    ])
    expect(
      await Promise.all(names.slice(0, 3).map((name) => call(config, "lead_of", name))),
    ).toEqual(["builder", "builder", "ops"])
  })

  test("an <id>-probe's alerts go to its spawner, as a probe-<what>'s do", async () => {
    const config = scratch()
    liveAs(config, ["worker-mild-lark"])
    const transcript = join(config, "probe.jsonl")
    const brief =
      "You are k3m9px-probe, a probe in the Playground factory; you report to worker-mild-lark. Report to worker-mild-lark with SendMessage (to: worker-mild-lark)."
    writeFileSync(
      transcript,
      `${JSON.stringify({ message: { content: brief, role: "user" }, type: "user" })}\n`,
    )
    expect(await call(config, "alert_to", "k3m9px-probe", transcript)).toBe("worker-mild-lark")
    expect(await call(config, "limit_targets", "k3m9px-probe", transcript)).toEqual([
      "worker-mild-lark",
    ])
  })

  test("a session started under a plain name reads as its roster kind, which wins over its name's", async () => {
    const config = scratch()
    mkdirSync(join(config, "playground"), { recursive: true })
    writeFileSync(
      join(config, "playground", "roster.json"),
      JSON.stringify({
        agents: [
          { kind: "worker", name: "anne-liaison" },
          { kind: "runner", name: "night-watch" },
          { kind: "probe", name: "herdr-check" },
          { kind: "reviewer", name: "worker-odd-name" },
        ],
      }),
    )
    const names = ["anne-liaison", "night-watch", "herdr-check", "worker-odd-name", "plain"]
    expect(await Promise.all(names.map((name) => call(config, "kind_of", name)))).toEqual([
      "worker",
      "runner",
      "probe",
      "reviewer",
      null,
    ])
    expect(await call(config, "lead_of", "anne-liaison")).toBe("builder")
    expect(await call(config, "lead_of", "night-watch")).toBe("ops")
    liveAs(config, ["worker-mild-lark"])
    const transcript = join(config, "probe.jsonl")
    const brief =
      "You are herdr-check, a probe in the Playground factory; you report to worker-mild-lark. Report to worker-mild-lark with SendMessage (to: worker-mild-lark)."
    writeFileSync(
      transcript,
      `${JSON.stringify({ message: { content: brief, role: "user" }, type: "user" })}\n`,
    )
    expect(await call(config, "alert_to", "herdr-check", transcript)).toBe("worker-mild-lark")
    expect(await call(config, "limit_targets", "herdr-check", transcript)).toEqual([
      "worker-mild-lark",
    ])
  })
})

describe("ops-unstick's slot alerts", () => {
  const at = "2026-10-25T21:00:00Z"
  const devRow = (pid: string, tree: string): string =>
    `  ${pid}      1 bun /repo/.claude/worktrees/${tree}/api/hono/src/bin/dev.ts`

  test("a worker's dev stack outside a slot raises no outside-slot", async () => {
    const jobs = [{ inside: false, kind: "dev stack", pid: "101", where: "pg-2088-usage-bars" }]
    expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toEqual([])
  })

  test("a dev stack still counts toward the heavy-jobs cap", async () => {
    const jobs = [
      { inside: false, kind: "dev stack", pid: "101", where: "pg-2088-usage-bars" },
      { inside: false, kind: "dev stack", pid: "102", where: "pg-2090-question-red-flash" },
      { inside: true, kind: "suite", pid: "103", where: "review-2112" },
    ]
    expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toEqual([
      {
        at,
        kind: "heavy-jobs",
        line: "3 heavy jobs at once (cap 2): pg-2088-usage-bars dev stack, pg-2090-question-red-flash dev stack, review-2112 suite",
        name: "machine",
        since: at,
      },
    ])
  })

  test("a suite outside a slot still raises outside-slot", async () => {
    const jobs = [
      { inside: false, kind: "suite", pid: "104", where: "pg-2121-dev-stack-outside-slot" },
    ]
    expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toEqual([
      {
        at,
        kind: "outside-slot",
        line: "a suite runs outside the run slots (pid 104); use run-slot.sh",
        name: "pg-2121-dev-stack-outside-slot",
        since: at,
      },
    ])
  })

  test("a self-hosted runner's CI job reads as a ci job, raises no outside-slot and counts toward the cap", async () => {
    const rows = [
      "  999431      1 /x/.playground/ops/mac-runners/runner-1/bin/Runner.Worker spawnclient 1 2",
      "  999432 999431 /bin/bash -e /x/.playground/ops/mac-runners/runner-1/_work/_temp/a.sh",
      "  999433 999432 bun run test",
    ]
    const jobs = (await call(scratch(), "heavy_jobs", rows)) as {
      inside: boolean
      kind: string
      pid: string
      where: string
    }[]
    expect(jobs).toEqual([{ inside: false, kind: "ci job", pid: "999433", where: "mac-runner" }])
    expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toEqual([])
    const more = [
      ...jobs,
      { inside: true, kind: "suite", pid: "105", where: "review-2112" },
      { inside: true, kind: "suite", pid: "106", where: "review-2113" },
    ]
    expect(await call(scratch(), "slot_alerts", more, 2, at)).toEqual([
      {
        at,
        kind: "heavy-jobs",
        line: "3 heavy jobs at once (cap 2): mac-runner ci job, review-2112 suite, review-2113 suite",
        name: "machine",
        since: at,
      },
    ])
  })

  test("the live dashboard's own dev stack is skipped, its worktree read canary before desk", async () => {
    expect(
      await call(scratch(), "heavy_jobs", [devRow("999421", "desk"), devRow("999422", "canary")]),
    ).toEqual([])
  })

  // a slotted commit's pre-commit suite: run-slot.sh holds the slot, git commit runs under it, and the suite under that
  const held = (slot: string) => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    mkdirSync(join(ops, slot), { recursive: true })
    writeFileSync(join(ops, `${slot}.holder`), "worker-x 999441 2026-11-01T13:00:00Z 1 small\n")
    return config
  }
  const committing = (holder: string) => [
    `  ${holder}      1 bash /x/.playground/ops/run-slot.sh worker-x -- git commit`,
    `  999442 ${holder} git commit`,
    "  999443 999442 bun run test:file tests/AGENTS.test.ts /x/.claude/worktrees/pg-334-x",
  ]

  for (const slot of ["run-slot-commit", "run-slot-model-2"])
    test(`a suite under ${slot}'s holder reads as inside a slot`, async () => {
      expect(await call(held(slot), "heavy_jobs", committing("999441"))).toEqual([
        { inside: true, kind: "suite", pid: "999443", where: "pg-334-x" },
      ])
    })

  test("a suite with no slot holder in its chain is still outside", async () => {
    const jobs = await call(held("run-slot-commit"), "heavy_jobs", committing("999444"))
    expect(jobs).toEqual([{ inside: false, kind: "suite", pid: "999443", where: "pg-334-x" }])
    expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toHaveLength(1)
  })

  // precommit:light's tree as ps shows it: bun run, the script, then trace-count's test:file, its sandbox and bun test
  const precommitLight = [
    "  999451      1 bun run precommit:light /x/msg.txt",
    "  999452 999451 bun packages/scripts/src/precommit-light.ts /x/msg.txt",
    "  999453 999452 bun run test:file tests/packages/scripts/src/trace-count/count.test.ts",
    "  999454 999453 bun packages/scripts/src/test-sandbox.ts tests/packages/scripts/src/trace-count/count.test.ts",
    "  999455 999454 bun test tests/packages/scripts/src/trace-count/count.test.ts",
  ]
  // the same tree with bun test straight under the script, the form before trace-count ran through test:file
  const precommitLightBare = [
    ...precommitLight.slice(0, 2),
    precommitLight[4]!.replace("999454", "999452"),
  ]

  for (const [form, rows] of [
    ["bun run test:file", precommitLight],
    ["bun test tests", precommitLightBare],
  ] as const)
    test(`precommit:light's ${form}, which runs outside the slots by rule, is no job and raises no outside-slot`, async () => {
      const jobs = await call(scratch(), "heavy_jobs", rows)
      expect(jobs).toEqual([])
      expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toEqual([])
    })

  for (const [form, row, pid] of [
    ["bun run test:file", precommitLight[2]!.replace("999452", "     1"), "999453"],
    ["bun test tests", precommitLight[4]!.replace("999454", "     1"), "999455"],
  ] as const)
    test(`a bare ${form} with no precommit:light above it and no holder still raises outside-slot`, async () => {
      const jobs = await call(scratch(), "heavy_jobs", [row])
      expect(jobs).toEqual([{ inside: false, kind: "suite", pid, where: "?" }])
      expect(await call(scratch(), "slot_alerts", jobs, 2, at)).toEqual([
        {
          at,
          kind: "outside-slot",
          line: `a suite runs outside the run slots (pid ${pid}); use run-slot.sh`,
          name: "?",
          since: at,
        },
      ])
    })

  test("the slots read are run-slot.sh's own, each model slot by its name", async () => {
    const script = readFileSync(
      join(import.meta.dir, "../../../../scripts/ops/run-slot.sh"),
      "utf8",
    )
    const fixed = script
      .match(/^\s*for s in ((?:run-slot\S* )+)\$\(ls "\$OPS"/m)?.[1]
      ?.trim()
      .split(" ")
    expect(fixed?.length).toBeGreaterThan(0)
    const config = held("run-slot-model-2")
    writeFileSync(join(config, "playground", "ops", "run-slot-model-10.holder"), "")
    expect(await call(config, "slot_names")).toEqual([
      ...(fixed ?? []),
      "run-slot-model-10",
      "run-slot-model-2",
    ])
  })

  test("an idle holder raises slot-idle on each of run-slot.sh's CPU slots alone", async () => {
    const script = readFileSync(
      join(import.meta.dir, "../../../../scripts/ops/run-slot.sh"),
      "utf8",
    )
    const cpu = script.match(/^holders\(\) \{\n[^\n]*\n\s*for s in ([^;]+);/m)?.[1]?.split(" ")
    expect(cpu?.length).toBeGreaterThan(0)
    const config = scratch()
    const ops = join(config, "playground", "ops")
    const bin = join(config, "bin")
    mkdirSync(bin)
    // the holder's one child has used no CPU
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/bash\necho "  999461 ${process.pid} 0:00.00 sleep 900"\n`,
    )
    chmodSync(join(bin, "ps"), 0o755)
    const now = Date.now() / 1000
    const slots = ["run-slot-commit", "run-slot-clone", "run-slot-quick", "run-slot-model-1"]
    const state: { slot_idle: Record<string, unknown> } = { slot_idle: {} }
    for (const slot of [...(cpu ?? []), ...slots]) {
      mkdirSync(join(ops, slot), { recursive: true })
      writeFileSync(join(ops, `${slot}.holder`), `worker-x ${process.pid} 2026-11-01T13:00:00Z\n`)
      state.slot_idle[`${slot}:${process.pid}`] = { cpu: 0, since: now - 1000, told: true }
    }
    const alerts = (await callWith(
      { PATH: `${bin}:${process.env.PATH}` },
      config,
      "slot_idle_alerts",
      state,
      now,
    )) as { kind: string; line: string }[]
    expect(alerts.map((a) => a.line.match(/holds (\S+) with/)?.[1])).toEqual(cpu ?? [])
    expect(new Set(alerts.map((a) => a.kind))).toEqual(new Set(["slot-idle"]))
  })

  // run-slot's holder on run-slot-3 with the given ps rows under it, its saved baseline at cpu seconds over the pids it saw, idle since `ago` seconds; the alerts' kinds and the entry the check saved
  const idleRun = async (rows: string[], cpu: number, ago: number, pids?: string[]) => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    const bin = join(config, "bin")
    mkdirSync(join(ops, "run-slot-3"), { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(ops, "run-slot-3.holder"), `worker-x ${process.pid} 2026-11-03T10:17:00Z\n`)
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/bash\n${rows.map((row) => `echo "${row}"`).join("\n")}\n`,
    )
    chmodSync(join(bin, "ps"), 0o755)
    const now = Date.now() / 1000
    const key = `run-slot-3:${process.pid}`
    const state = {
      slot_idle: { [key]: { cpu, since: now - ago, told: true, ...(pids && { pids }) } },
    }
    const after = (await drive({ PATH: `${bin}:${process.env.PATH}` }, config, {
      args: [state, now],
      fn: "slot_idle_alerts",
      state: true,
    })) as { result: { kind: string }[]; state: { slot_idle: Record<string, { pids?: string[] }> } }
    return { kinds: after.result.map((a) => a.kind), saved: after.state.slot_idle[key] }
  }
  const idleCheck = async (rows: string[], cpu: number, ago: number, pids?: string[]) =>
    (await idleRun(rows, cpu, ago, pids)).kinds

  test("a batch whose earlier step exited is measured from its new total, so its busy next step raises no slot-idle", async () => {
    expect(await idleCheck([`  999471 ${process.pid} 5:00.00 bun test`], 600, 1000)).toEqual([])
  })

  test("a busy grandchild under an idle batch script counts, even below an exited step's baseline", async () => {
    const rows = [
      `  999472 ${process.pid} 0:00.04 bash -c batch`,
      "  999473 999472 3:40.00 bun packages/scripts/src/verdicts.ts",
    ]
    expect(await idleCheck(rows, 600, 1000)).toEqual([])
    expect(await idleCheck(rows, 0.04, 1000)).toEqual([])
  })

  test("a tree holding a pid the last check did not see restarts its wait, so a step started since raises no slot-idle (#1043)", async () => {
    const rows = [
      `  999478 ${process.pid} 0:00.00 bash -c batch`,
      "  999479 999478 0:00.50 bun test",
    ]
    expect(await idleCheck(rows, 0, 1000, ["999478"])).toEqual([])
  })

  test("a tree of the pids the last check saw, at flat CPU past SLOT_IDLE, still raises slot-idle, its times summed in hundredths (#1043)", async () => {
    const rows = [
      `  999478 ${process.pid} 0:00.04 bash -c batch`,
      "  999479 999478 0:00.30 bun test",
    ]
    expect(await idleCheck(rows, 0.34, 1000, ["999478", "999479"])).toEqual(["slot-idle"])
  })

  test("a check with no reset saves the tree's pids, so an entry saved with none takes them and an exited pid drops out (#1061's nit)", async () => {
    const rows = [
      `  999480 ${process.pid} 0:00.00 bash -c batch`,
      "  999481 999480 0:00.00 sleep 900",
    ]
    expect((await idleRun(rows, 0, 100)).saved?.pids).toEqual(["999480", "999481"])
    expect((await idleRun(rows, 0, 100, ["999480", "999481", "999482"])).saved?.pids).toEqual([
      "999480",
      "999481",
    ])
  })

  test("a bun install process at near 0% CPU waits SLOT_IDLE_INSTALL, then still raises slot-idle, and a wrapper naming one in its argv waits SLOT_IDLE", async () => {
    const rows = [`  999474 ${process.pid} 0:01.00 bun install --frozen-lockfile`]
    expect(await idleCheck(rows, 1, 1500)).toEqual([])
    expect(await idleCheck(rows, 1, 2800)).toEqual(["slot-idle"])
    const wrapped = [
      `  999476 ${process.pid} 0:00.01 bash -c bun install && sleep 900`,
      "  999477 999476 0:00.00 sleep 900",
    ]
    expect(await idleCheck(wrapped, 0.01, 1000)).toEqual(["slot-idle"])
  })

  // the heavy-job cap reads run-slot.sh's own count of the CPU slots held or open, on a machine at load1 2 with the given off-switches
  const capped = (off: string[] = [], held: string[] = []) => {
    const config = scratch()
    const ops = join(config, "playground", "ops")
    const bin = join(config, "bin")
    mkdirSync(ops, { recursive: true })
    mkdirSync(bin)
    writeFileSync(
      join(bin, "sysctl"),
      `#!/bin/bash\ncase "$2" in vm.loadavg) echo "{ 2.00 2.00 2.00 }" ;; kern.memorystatus_level) echo 80 ;; kern.memorystatus_vm_pressure_level) echo 1 ;; esac\n`,
    )
    chmodSync(join(bin, "sysctl"), 0o755)
    // the CPU 80% idle in top's second sample and no swap-ins in vm_stat's last row, so run-slot's gauges open every lane
    writeFileSync(
      join(bin, "top"),
      `#!/bin/bash\necho "CPU usage: 1.00% user, 1.00% sys, 98.00% idle"\necho "CPU usage: 10.00% user, 10.00% sys, 80.00% idle"\n`,
    )
    writeFileSync(
      join(bin, "vm_stat"),
      `#!/bin/bash\necho "    free  swapins swapouts"\necho "    8023  9966113 12153731"\necho "    7698        0        0"\n`,
    )
    for (const name of ["top", "vm_stat"]) chmodSync(join(bin, name), 0o755)
    for (const name of off) writeFileSync(join(ops, name), "")
    for (const slot of held) {
      mkdirSync(join(ops, slot))
      writeFileSync(
        join(ops, `${slot}.holder`),
        `worker-x ${process.pid} 2026-11-01T14:00:00Z 2 medium\n`,
      )
    }
    return callWith({ PATH: `${bin}:${process.env.PATH}` }, config, "heavy_cap") as Promise<number>
  }

  test("four CPU slots held raise no heavy-jobs alert", async () => {
    const cap = await capped([], ["run-slot", "run-slot-2", "run-slot-3", "run-slot-4"])
    const jobs = ["101", "102", "103", "104"].map((pid) => ({
      inside: true,
      kind: "suite",
      pid,
      where: `pg-340-${pid}`,
    }))
    expect(await call(scratch(), "slot_alerts", jobs, cap, at)).toEqual([])
  })

  test("with run-slot.4-off and no run-slot-4 holder, the cap is at most 3", async () => {
    expect(await capped(["run-slot.4-off"])).toBe(3)
  })

  test("a cap read that fails allows every CPU slot and logs it", async () => {
    const config = scratch()
    const bin = join(config, "bin")
    mkdirSync(join(config, "playground", "ops", "unstick"), { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(bin, "bash"), "#!/bin/sh\nexit 1\n")
    chmodSync(join(bin, "bash"), 0o755)
    expect(await callWith({ PATH: `${bin}:${process.env.PATH}` }, config, "heavy_cap")).toBe(4)
    expect(
      readFileSync(join(config, "playground", "ops", "unstick", "unstick.log"), "utf8"),
    ).toContain("run-slot.sh slots gave no count ('')")
  })
})

// ops-unstick routes a block to the session's manager and presses nothing on a permission prompt; a block the session's own hook recorded is that hook's to route.
describe("pickers go to the manager (PG-2184)", () => {
  test("a block the session's own hook recorded as stuck or failed is the hook's; any other is unstick's", async () => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    const record = (state: string) =>
      JSON.stringify({ at: "2026-10-26T05:00:00.000Z", event: "x", sessionId: "s", state })
    writeFileSync(join(states, "stuck.json"), record("stuck"))
    writeFileSync(join(states, "failed.json"), record("failed"))
    writeFileSync(join(states, "working.json"), record("working"))
    expect(
      await Promise.all(
        ["stuck", "failed", "working", "none"].map((sid) => call(config, "hook_owned", sid)),
      ),
    ).toEqual([true, true, false, false])
  })

  test("run.py presses Escape for the usage-limit dialog alone, never on a permission prompt", () => {
    const source = readFileSync(RUN_PY, "utf8")
    expect([...source.matchAll(/\bescape\(s, name, "([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      "the usage-limit dialog",
    ])
  })
})

// OrbStack hung twice on 27 Oct and the live dashboard lost its database for about 6 minutes each time, until a person restarted it.
describe("a hung Docker with the live dashboard's db unreachable restarts OrbStack (#2437)", () => {
  // A machine whose `docker info` hangs until `answer()`, whose live dashboard's health reads `db`, and whose orbctl records each call; its state folder carries from one cycle to the next.
  // The probe gets 2 s, 5 times the 0.4 s an answering probe took at most beside twice the cores in busy loops, and the hang execs its sleep, so the probe's kill ends it and none outlives its case.
  const machine = (db: string) => {
    const config = scratch()
    const bin = join(config, "bin")
    mkdirSync(bin)
    mkdirSync(join(config, "playground", "ops", "unstick"), { recursive: true })
    const orbctl = join(config, "orbctl-calls")
    const answers = join(config, "docker-answers")
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    script("docker", `if [ -f "${answers}" ]; then echo 28.0.0; else exec sleep 10; fi`)
    script("orbctl", `echo "$1" >> "${orbctl}"`)
    script(
      "git",
      `printf 'worktree /repo\\nbranch refs/heads/main\\n\\nworktree ${config}\\nbranch refs/heads/live/dashboard\\n'`,
    )
    script("bunx", "echo http://127.0.0.1:1")
    script("curl", `echo '{"data":{"db":"${db}","dashboard":"live","message":"degraded"}}'`)
    const env = { PLAYGROUND_REPO: "/repo", PATH: `${bin}:${process.env.PATH}` }
    const check = (state: Record<string, unknown> = {}) =>
      drive(env, config, { args: [state, 2], fn: "docker_check", notified: true }) as Promise<{
        notified: [string, string][]
        result: { kind: string; line: string }[]
      }>
    const calls = () => (existsSync(orbctl) ? readFileSync(orbctl, "utf8").trim().split("\n") : [])
    const answer = (yes: boolean) => (yes ? writeFileSync(answers, "") : rmSync(answers))
    return { answer, calls, check }
  }

  test("restarts OrbStack on the first cycle, logs both exit codes and tells ops", async () => {
    const { calls, check } = machine("unreachable")
    const { notified, result } = await check()
    expect(calls()).toEqual(["stop", "start"])
    expect(result.map((a) => a.kind)).toEqual(["docker-restarted"])
    expect(result[0]?.line).toContain("orbctl stop exited 0, orbctl start exited 0")
    expect(notified.map(([to]) => to)).toEqual(["ops"])
  })

  test("restarts once per outage, a job restart between cycles included, and again in the next outage", async () => {
    const { answer, calls, check } = machine("unreachable")
    await check()
    // each check is a fresh process, as ops-up's restart of this job would be, so only the state folder carries the restart
    expect((await check({ docker_misses: 1 })).result.map((a) => a.kind)).toEqual(["docker-hung"])
    expect(calls()).toEqual(["stop", "start"])
    answer(true)
    expect((await check({ docker_misses: 2 })).result).toEqual([])
    answer(false)
    expect((await check()).result.map((a) => a.kind)).toEqual(["docker-restarted"])
    expect(calls()).toEqual(["stop", "start", "stop", "start"])
  })

  test("a docker timeout with the dashboard's db ok keeps today's count: no restart, an alert from the second miss", async () => {
    const { calls, check } = machine("ok")
    expect((await check()).result).toEqual([])
    expect((await check({ docker_misses: 1 })).result.map((a) => a.kind)).toEqual(["docker-hung"])
    expect(calls()).toEqual([])
  })

  test("a Docker that answers restarts nothing and alerts nothing, even with the dashboard's db unreachable", async () => {
    const { answer, calls, check } = machine("unreachable")
    answer(true)
    expect((await check({ docker_misses: 3 })).result).toEqual([])
    expect(calls()).toEqual([])
  })
})

// unstick read Playground's herdr servers under the names they had before ops-herdr renamed them, so it found none of the sessions on them
describe("the herdr servers", () => {
  test("unstick's default list is ops-herdr's", () => {
    const text = readFileSync(RUN_PY, "utf8")
    expect(/^HERDR_SESSIONS = .* or "([^"]+)"\)\.split/m.exec(text)?.[1]).toBe(
      HERDR_SESSIONS.join(","),
    )
  })
})

// Retro 31: one account's week ran out at night and ops-unstick re-sent each stopped session's limit alert every 10 minutes, 1,664 lines by morning.
describe("a usage-limit block over a night", () => {
  // run.py's cycle every 120 seconds for 8 hours on a made-up clock, its herdr, screens and side checks stubbed, one session at its limit throughout
  const REPLAY = `
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location("run", sys.argv[1])
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)
clock = [1_800_000_000.0]
run.time.time = lambda: clock[0]
run.time.sleep = lambda s: None
sent = []
run.notify = lambda text, to="dispatcher": sent.append([to, text])
run.log = lambda line: None
run.alert_to = lambda name, transcript: "lead"
session = {"session_id": "s-1", "surface_id": "w1:p1", "workspace_id": "w1", "transcript_path": ""}
run.herdr_sessions = lambda: [session]
run.name_of = lambda s: "worker-a"
run.roster_kinds = lambda: {}
run.kind_of = lambda name, kinds=None: "worker"
run.is_lead = lambda name, kinds: False
run.manager_kind_of_name = lambda name: None
run.named_kind = lambda name: None
run.quiet_for = lambda path, now_t: 3600
run.screen = lambda s: ["You've hit your weekly limit"]
stuck = sys.argv[2] == "usage-limit-stuck"
run.read_block = lambda lines, s: (None, None, ("You've hit your weekly limit", 1800)) if stuck else (sys.argv[2], "You've hit your weekly limit", None)
run.session_account = lambda name: "acct-spent"
run.moving = lambda now_t=None: None
for fn in ("stall",):
    setattr(run, fn, lambda *a, **k: None)
run.capped_alert = lambda names, limited=None: sent.append(["limited", ",".join(sorted(limited or []))]) or []
for fn in ("ending_alert", "api_stop_alerts", "slot_idle_alerts", "docker_check", "memory_files", "heavy_jobs", "slot_alerts"):
    setattr(run, fn, lambda *a, **k: [])
run.heavy_cap = lambda: 1
run.slot_stuck = lambda *a, **k: None
import os
os.makedirs(run.HERE, exist_ok=True)
state = {"blocks": {}}
for _ in range(8 * 3600 // 120 + 1):
    run.cycle(state)
    clock[0] += 120
print(json.dumps(sent))
`
  const replay = async (accounts: object, kind = "usage-limit"): Promise<[string, string][]> => {
    const config = scratch()
    writeFileSync(
      join(config, "playground", "usage.json"),
      JSON.stringify({ account: "acct-spent", accounts, writtenAt: "2027-01-15T08:00:00Z" }),
    )
    const proc = Bun.spawn([...PYTHON, "-I", "-c", REPLAY, RUN_PY, kind], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        TZ: "UTC",
        UV_CACHE_DIR: process.env.UV_CACHE_DIR,
        UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`replay exited ${code}: ${err}`)
    return JSON.parse(out)
  }

  test("a worker's limit line goes nowhere; the summary an hour stays", async () => {
    const sent = await replay({
      "acct-half": { week: 60 },
      "acct-roomy": { week: 20 },
      "acct-spent": { week: 100 },
    })
    for (const to of ["builder", "dispatcher"]) {
      const lines = sent.filter(([who]) => who === to).map(([, text]) => text)
      expect(
        lines.filter((text) => text.includes("is at its usage limit")),
        to,
      ).toHaveLength(0)
      const summaries = lines.filter((text) => text.includes("blocked on the usage limit"))
      expect(summaries, to).toHaveLength(8)
      expect(lines, to).toHaveLength(8)
      expect(summaries[0]).toBe(
        "1 session blocked on the usage limit. Nothing blocked for another reason. On the limit: worker-a",
      )
    }
  })

  test("a limit dialog still showing past its reset tells its manager once and never caps its account; a live one caps it (#1457)", async () => {
    const accounts = { "acct-spent": { week: 3 } }
    const limitedBy = (sent: [string, string][]) => [
      ...new Set(sent.filter(([who]) => who === "limited").map(([, accts]) => accts)),
    ]
    const stuck = await replay(accounts, "usage-limit-stuck")
    expect(limitedBy(stuck)).toEqual([""])
    const told = stuck.filter(([who]) => who === "lead").map(([, text]) => text)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("nudge it")
    expect(limitedBy(await replay(accounts))).toEqual(["acct-spent"])
  })

  test("most_room reads usage.json's accounts map: a week past its reset as 0, never the skipped account", async () => {
    const most = async (accounts: object, skip = "acct-spent") => {
      const config = scratch()
      writeFileSync(
        join(config, "playground", "usage.json"),
        JSON.stringify({ account: "acct-spent", accounts, writtenAt: "2027-01-15T08:00:00Z" }),
      )
      return call(config, "most_room", skip)
    }
    expect(await most({ "acct-roomy": { week: 20 }, "acct-spent": { week: 5 } })).toEqual([
      "acct-roomy",
      20,
    ])
    expect(
      await most({
        "acct-reset": { week: 100, weekReset: 1_700_000_000 },
        "acct-roomy": { week: 20 },
        "acct-spent": { week: 100 },
      }),
    ).toEqual(["acct-reset", 0])
    expect(await most({ "acct-spent": { week: 100 } })).toBeNull()
  })

  test("a probe's limit line names the account with the most room, and says so when none has room", async () => {
    const probeLine = async (accounts: object) => {
      const config = scratch()
      writeFileSync(
        join(config, "playground", "usage.json"),
        JSON.stringify({ account: "acct-spent", accounts, writtenAt: "2027-01-15T08:00:00Z" }),
      )
      const transcript = join(config, "probe.jsonl")
      writeFileSync(
        transcript,
        `${JSON.stringify({
          message: {
            content:
              "You are probe-herdr-answer, a probe in the Playground factory; you report to worker-mild-lark. Report to worker-mild-lark with SendMessage (to: worker-mild-lark).",
            role: "user",
          },
          type: "user",
        })}\n`,
      )
      const { notified: sent } = await notified(
        config,
        "limit_alert",
        "probe-herdr-answer",
        "You've hit your weekly limit",
        transcript,
      )
      return sent[0]?.[1]
    }
    expect(await probeLine({ "acct-roomy": { week: 20 }, "acct-spent": { week: 100 } })).toContain(
      "Most room: acct-roomy (week 20%)",
    )
    expect(await probeLine({ "acct-spent": { week: 100 } })).toContain(
      "No account in usage.json's accounts has room",
    )
  })

  test("any other block still alerts every 10 minutes", async () => {
    const sent = await replay({ "acct-roomy": { week: 20 } }, "picker")
    expect(sent.filter(([, text]) => text.includes("is blocked on a picker prompt"))).toHaveLength(
      49,
    )
  })
})
describe("the capped and ending account lines (#1457)", () => {
  const RESET = Math.ceil(Date.now() / 3_600_000) * 3600 + 3 * DAY
  const write = (path: string, body: string): void => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, body)
  }
  const usage = (
    config: string,
    file: string,
    account: string,
    pct: number,
    reset = RESET,
    at = new Date(),
  ) =>
    write(
      join(config, "playground", file),
      JSON.stringify({
        account,
        rate_limits: { seven_day: { resets_at: reset, used_percentage: pct } },
        writtenAt: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    )
  const record = (config: string, name: string, flags: string) =>
    write(
      join(config, "playground", "resume", `${name}.sh`),
      `#!/bin/bash\n# server: factory\nexec /x/scripts/spawn.sh resume ${name} /x 0b9e8f1a ${flags}\n`,
    )
  const machine = (ownPct: number, twoPct: number, twoEnds?: string) => {
    const config = scratch()
    mkdirSync(join(config, "playground", "ops", "unstick"), { recursive: true })
    usage(config, "usage.json", "own@example.net", ownPct)
    usage(config, "usage-two.json", "two@example.com", twoPct)
    write(
      join(config, "playground", "usage.json"),
      JSON.stringify({
        account: "own@example.net",
        accounts: { "own@example.net": { week: ownPct }, "two@example.com": { week: twoPct } },
        rate_limits: { seven_day: { resets_at: RESET, used_percentage: ownPct } },
        writtenAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    )
    record(config, "worker-on-two", "--account two@example.com --model claude-opus-5-5")
    record(config, "worker-plain", "")
    record(config, "worker-two-b", "--account two@example.com")
    record(config, "worker-two-c", "--account two@example.com --model claude-sonnet-5-5")
    if (twoEnds)
      storeWith(join(config, "playground"), {}, {
        "usage.accounts": [{ email: "two@example.com", provider: "claude", ends: twoEnds }],
      } as never)
    return config
  }

  test("a week at 98% with a live session on the account sends nothing (#1457)", async () => {
    const config = machine(98, 22)
    const { notified: sent } = await notified(config, "capped_alert", ["worker-plain"])
    expect(sent).toEqual([])
  })

  test("a capped account names every live session on it and the roomiest target, once per reset (#1457)", async () => {
    const config = machine(40, 100)
    const { notified: sent } = await notified(config, "capped_alert", [
      "worker-on-two",
      "worker-two-b",
      "worker-two-c",
      "worker-plain",
    ])
    expect(sent).toHaveLength(2)
    expect(sent.map(([to]) => to)).toEqual(["builder", "ops"])
    const line = sent[0]![1]
    expect(line).toContain("two@example.com")
    expect(line).toContain("worker-on-two")
    expect(line).toContain("worker-two-b")
    expect(line).toContain("worker-two-c")
    expect(line).not.toContain("worker-plain")
    expect(line).toContain("own@example.net")
    expect(line).toContain("spawn.sh close")
    const again = (
      await notified(config, "capped_alert", [
        "worker-on-two",
        "worker-two-b",
        "worker-two-c",
        "worker-plain",
      ])
    ).notified
    expect(again).toEqual([])
  })

  test("an ending account with room sends ops one line naming the account, its end and the points left (#1457)", async () => {
    const config = machine(40, 55, new Date(Date.now() + 12 * 3_600_000).toISOString())
    const { notified: sent } = await notified(config, "ending_alert")
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe("ops")
    expect(sent[0]![1]).toContain("two@example.com")
    expect(sent[0]![1]).toContain("points left")
  })

  test("an ending account's line goes once per end: the next tick and the next hour send nothing, a new end sends again (#1457)", async () => {
    const config = machine(40, 55, new Date(Date.now() + 12 * 3_600_000).toISOString())
    const sends = async (hours = 0) =>
      (
        (await drive({}, config, {
          args: [],
          at: Date.now() / 1000 + hours * 3600,
          fn: "ending_alert",
          notified: true,
        })) as { notified: unknown[] }
      ).notified.length
    expect(await sends()).toBe(1)
    expect(await sends()).toBe(0)
    expect(await sends(1)).toBe(0)
    storeWith(join(config, "playground"), {}, {
      "usage.accounts": [
        {
          email: "two@example.com",
          provider: "claude",
          ends: new Date(Date.now() + 10 * 3_600_000).toISOString(),
        },
      ],
    } as never)
    expect(await sends()).toBe(1)
  })

  test("an ending account at 100% sends nothing (#1457)", async () => {
    const config = machine(40, 100, new Date(Date.now() + 12 * 3_600_000).toISOString())
    const { notified: sent } = await notified(config, "ending_alert")
    expect(sent).toEqual([])
  })
})

// The auto-memory trial (#1484) turns memory on for the sessions the roster marks memory=on, so a note one of them leaves in a project folder raises nothing, while another session's still does.
describe("the memory files alert and the memory trial (#1484)", () => {
  const ON = "a1b2c3d4-0000-4000-8000-0000000014a1"
  const OFF = "a1b2c3d4-0000-4000-8000-0000000014a2"
  const machineWith = () => {
    const config = scratch()
    mkdirSync(join(config, "sessions"), { recursive: true })
    writeFileSync(
      join(config, "sessions", "1.json"),
      JSON.stringify({ name: "worker-on", sessionId: ON }),
    )
    writeFileSync(
      join(config, "sessions", "2.json"),
      JSON.stringify({ name: "worker-off", sessionId: OFF }),
    )
    writeFileSync(
      join(config, "playground", "roster.json"),
      JSON.stringify({
        agents: [
          { kind: "worker", memory: "on", name: "worker-on", status: "working", task: "t" },
          { kind: "worker", memory: "off", name: "worker-off", status: "working", task: "t" },
        ],
      }),
    )
    const memory = join(config, "projects", "-made-up-checkout", "memory")
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(memory, "on.md"), `---\noriginSessionId: ${ON}\n---\na made-up note\n`)
    writeFileSync(join(memory, "off.md"), `---\noriginSessionId: ${OFF}\n---\na made-up note\n`)
    return config
  }

  test("names the off session's note alone", async () => {
    const found = (await call(machineWith(), "memory_files")) as { line: string; name: string }[]
    expect(found.map((f) => f.name)).toEqual(["worker-off"])
  })
})
