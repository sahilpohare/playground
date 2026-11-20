import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BOT_ROUTE,
  type Launch,
  launchAbove,
  opsLaunch,
  type Project,
  schemaChanges,
  shipYard,
  type YardArgs,
  type YardIo,
} from "../../../../../packages/scripts/src/ship/yard"
import type { Proc } from "../../../../../scripts/hooks/session-state"

const HOSTS = { api: "https://api.yard.example.com", web: "https://yard.example.com" }

type Fake = {
  changed?: string[]
  deploys?: Partial<Record<Project, boolean>>
  launch?: Launch
  record?: string
  statuses?: Record<string, number>
}

// Every vercel call, network read and git read stubbed: the io logs each call in order, and answers as the case sets it.
const fake = (set: Fake = {}) => {
  const calls: string[] = []
  const lines: string[] = []
  let record = set.record
  const io: YardIo = {
    changed: async (from, to) => {
      calls.push(`changed ${from}..${to}`)
      return set.changed ?? ["api/hono/src/index.ts"]
    },
    deploy: async (project, dir) => {
      calls.push(`deploy ${project} ${dir}`)
      return set.deploys?.[project] ?? true
    },
    drop: async (dir) => {
      calls.push(`drop ${dir}`)
    },
    err: (line) => lines.push(line),
    fetch: async (tags) => {
      calls.push(`fetch ${tags.join(" ")}`)
    },
    launch: async () =>
      set.launch ?? { found: "the Ops lead's claude process", kind: "ops", role: "lead" },
    out: (line) => lines.push(line),
    readRecord: async () => record,
    status: async (url) => {
      calls.push(`status ${url}`)
      return (
        set.statuses?.[url] ??
        (url.endsWith("/api/health") ? 200 : url.endsWith(BOT_ROUTE) ? 401 : 0)
      )
    },
    worktree: async (tag) => {
      calls.push(`worktree ${tag}`)
      return `/wt/${tag}`
    },
    writeRecord: async (tag) => {
      calls.push(`record ${tag}`)
      record = tag
    },
  }
  return { calls, io, lines, out: () => lines.join("\n") }
}

const run = (args: Partial<YardArgs>, set: Fake = { record: "v0.0.110" }) => {
  const f = fake(set)
  return shipYard({ tag: "v0.0.111", ...args }, HOSTS, f.io).then((code) => ({ ...f, code }))
}

describe("ship:yard's order", () => {
  test("it fetches both tags, deploys the API, checks it, deploys the web, checks it, records the tag, then removes the worktree", async () => {
    const { calls, code } = await run({})
    expect(code).toBe(0)
    expect(calls).toEqual([
      "fetch v0.0.110 v0.0.111",
      "changed v0.0.110..v0.0.111",
      "worktree v0.0.111",
      "deploy api /wt/v0.0.111",
      `status ${HOSTS.api}/api/health`,
      `status ${HOSTS.api}${BOT_ROUTE}`,
      "deploy web /wt/v0.0.111",
      `status ${HOSTS.web}/api/health`,
      `status ${HOSTS.web}${BOT_ROUTE}`,
      "record v0.0.111",
      "drop /wt/v0.0.111",
    ])
  })

  test("a failed API deploy stops the step before the web deploy, and records nothing", async () => {
    const { calls, code, out } = await run({}, { deploys: { api: false }, record: "v0.0.110" })
    expect(code).not.toBe(0)
    expect(calls.some((c) => c.startsWith("deploy web"))).toBe(false)
    expect(calls.some((c) => c.startsWith("record"))).toBe(false)
    expect(out()).toContain("the api deploy failed")
    expect(calls.at(-1)).toBe("drop /wt/v0.0.111")
  })

  test("a failed web deploy stops the step and records nothing", async () => {
    const { calls, code } = await run({}, { deploys: { web: false }, record: "v0.0.110" })
    expect(code).not.toBe(0)
    expect(calls.some((c) => c.startsWith("record"))).toBe(false)
    expect(calls.at(-1)).toBe("drop /wt/v0.0.111")
  })
})

describe("ship:yard's live-host checks", () => {
  test("the API's health answering other than 200 stops before the web deploy, naming the URL and status", async () => {
    const url = `${HOSTS.api}/api/health`
    const { calls, code, out } = await run({}, { record: "v0.0.110", statuses: { [url]: 503 } })
    expect(code).not.toBe(0)
    expect(out()).toContain(`${url} answered 503, not 200`)
    expect(calls.some((c) => c.startsWith("deploy web"))).toBe(false)
  })

  test("the bot route answering without a token stops the step, naming the URL and status", async () => {
    const url = `${HOSTS.web}${BOT_ROUTE}`
    const { calls, code, out } = await run({}, { record: "v0.0.110", statuses: { [url]: 200 } })
    expect(code).not.toBe(0)
    expect(out()).toContain(`${url} answered 200, not 401`)
    expect(calls.some((c) => c.startsWith("record"))).toBe(false)
  })

  test("the bot route is one Yard's router serves", async () => {
    const router = await Bun.file(
      `${import.meta.dir}/../../../../../api/hono/src/routers/yard.ts`,
    ).text()
    expect(BOT_ROUTE.startsWith("/api/v1/yard/")).toBe(true)
    expect(router).toContain(`"${BOT_ROUTE.slice("/api/v1/yard".length)}"`)
  })
})

describe("ship:yard's schema stop", () => {
  const SCHEMA = ["packages/db/src/schema/yard.ts", "packages/db/drizzle/0017_yard_more.sql"]

  test("a tag that changes the schema or a migration stops before any deploy, naming each file", async () => {
    const { calls, code, out } = await run(
      {},
      { changed: ["api/hono/src/index.ts", ...SCHEMA], record: "v0.0.110" },
    )
    expect(code).not.toBe(0)
    for (const file of SCHEMA) expect(out()).toContain(file)
    expect(out()).toContain("--schema-cleared")
    expect(calls.some((c) => c.startsWith("deploy"))).toBe(false)
  })

  test("--schema-cleared naming the decision lets the step go on", async () => {
    const { calls, code } = await run(
      { schemaCleared: "i123" },
      { changed: SCHEMA, record: "v0.0.110" },
    )
    expect(code).toBe(0)
    expect(calls).toContain("record v0.0.111")
  })

  test("only the schema and the migrations count", () => {
    expect(
      schemaChanges([
        "packages/db/src/index.ts",
        "packages/db/drizzle.config.ts",
        "api/hono/src/index.ts",
        ...SCHEMA,
      ]),
    ).toEqual(SCHEMA)
  })
})

describe("ship:yard's launch", () => {
  test.each([
    ["a worker's", { found: "a worker's claude process", kind: "worker", role: "worker" }],
    ["the Builder's", { found: "the Builder's claude process", kind: "builder", role: "lead" }],
    ["an unset role's", { found: "a claude process with no role", kind: "ops" }],
    [
      "a lead role with no session name",
      { found: "a claude process with no session", role: "lead" },
    ],
  ] as [string, Launch][])(
    "%s launch is refused before any git or vercel call, naming the role",
    async (_, launch) => {
      const { calls, code, out } = await run({}, { launch, record: "v0.0.110" })
      expect(code).not.toBe(0)
      expect(calls).toEqual([])
      expect(out()).toContain(`${launch.found}, whose PLAYGROUND_ROLE is ${launch.role ?? "unset"}`)
    },
  )

  test("the Ops lead's launch goes on", async () => {
    const launch = { found: "the Ops lead's claude process", kind: "ops", role: "lead" }
    const { code } = await run({}, { launch, record: "v0.0.110" })
    expect(code).toBe(0)
  })
})

// Made-up sessions under a scratch folder: the claude process (pid 300) above a shell (200) above the step (100), each read through a stubbed process reader, so no real process, registry or roster is read.
describe("ship:yard's launch, read from the claude process above", () => {
  let scratch = ""
  const ROSTER = [
    { kind: "builder", name: "builder" },
    { kind: "ops", name: "ops" },
    { kind: "worker", name: "abc-worker" },
  ]
  const session = async (folder: string, entry: Record<string, unknown>) =>
    Bun.write(join(scratch, folder, "sessions", "300.json"), JSON.stringify({ pid: 300, ...entry }))

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "ship-yard-launch-"))
    await Bun.write(join(scratch, "data", "roster.json"), JSON.stringify({ agents: ROSTER }))
    await session("ops", { name: "ops", sessionId: "s-ops" })
    await session("builder", { name: "builder", sessionId: "s-builder" })
    await session("worker", { name: "abc-worker", sessionId: "s-worker" })
    await session("nameless", { sessionId: "s-nameless" })
    // a registry and a roster that name the worker's session as the Ops lead's, for the step's own environment to point at
    await Bun.write(
      join(scratch, "fake-config", "sessions", "1.json"),
      JSON.stringify({ name: "ops", sessionId: "s-worker" }),
    )
    await Bun.write(
      join(scratch, "fake-data", "roster.json"),
      JSON.stringify({ agents: [{ kind: "ops", name: "abc-worker" }] }),
    )
  })

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true })
  })

  const procs =
    (claude: Record<string, string> | undefined, data = "data") =>
    (pid: number): Proc | undefined =>
      pid === 100
        ? { comm: "bun", env: {}, ppid: 200 }
        : pid === 200
          ? { comm: "/bin/zsh", env: {}, ppid: claude ? 300 : 1 }
          : pid === 300 && claude
            ? {
                comm: "/opt/claude/bin/claude",
                env: { PLAYGROUND_DATA_DIR: join(scratch, data), ...claude },
                ppid: 1,
              }
            : undefined
  const under = (folder: string, role: string) => ({
    CLAUDE_CONFIG_DIR: join(scratch, folder),
    PLAYGROUND_ROLE: role,
  })

  test("the Ops lead's claude process passes", async () => {
    const launch = await launchAbove(100, procs(under("ops", "lead")))
    expect(launch).toEqual({
      found: "the claude process 300, session ops",
      kind: "ops",
      role: "lead",
    })
    expect(opsLaunch(launch)).toBe(true)
  })

  test("a worker's claude process is refused, whatever the step's own environment names", async () => {
    const forged = {
      CLAUDE_CODE_SESSION_ID: "s-ops",
      CLAUDE_CONFIG_DIR: join(scratch, "fake-config"),
      PLAYGROUND_DATA_DIR: join(scratch, "fake-data"),
      PLAYGROUND_ROLE: "lead",
    }
    const kept = Object.fromEntries(Object.keys(forged).map((key) => [key, process.env[key]]))
    Object.assign(process.env, forged)
    try {
      const launch = await launchAbove(100, procs(under("worker", "worker")))
      expect(launch).toMatchObject({ kind: "worker", role: "worker" })
      const f = fake({ record: "v0.0.110" })
      const code = await shipYard({ tag: "v0.0.111" }, HOSTS, {
        ...f.io,
        launch: async () => launch,
      })
      expect(code).not.toBe(0)
      expect(f.calls).toEqual([])
      expect(f.out()).toContain("whose PLAYGROUND_ROLE is worker")
    } finally {
      for (const [key, value] of Object.entries(kept))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
  })

  test("the Builder's claude process, a lead of another kind, is refused", async () => {
    const launch = await launchAbove(100, procs(under("builder", "lead")))
    expect(launch.kind).toBe("builder")
    expect(opsLaunch(launch)).toBe(false)
  })

  test("a call with no claude process above it (a detached, nohup, launchd or osascript run) is refused, naming that", async () => {
    const launch = await launchAbove(100, procs(undefined))
    expect(launch).toEqual({ found: "no Claude Code process above this call" })
    expect(opsLaunch(launch)).toBe(false)
  })

  test("a claude process whose registry names no session is refused", async () => {
    const launch = await launchAbove(100, procs(under("nowhere", "lead")))
    expect(launch.found).toContain("whose session its registry does not name")
    expect(opsLaunch(launch)).toBe(false)
  })

  test("a claude process whose registry entry holds no name is refused", async () => {
    const launch = await launchAbove(100, procs(under("nameless", "lead")))
    expect(launch.found).toContain("whose registry it cannot read")
    expect(opsLaunch(launch)).toBe(false)
  })

  test("a claude process whose roster cannot be read names no kind and is refused", async () => {
    const launch = await launchAbove(100, procs(under("ops", "lead"), "no-data"))
    expect(launch.kind).toBeUndefined()
    expect(opsLaunch(launch)).toBe(false)
  })
})

describe("ship:yard's record", () => {
  test("with no record and no --since, it stops before any read or deploy, asking for the tag live now", async () => {
    const { calls, code, out } = await run({}, {})
    expect(code).not.toBe(0)
    expect(out()).toContain("--since <the tag live now>")
    expect(calls).toEqual([])
  })

  test("--since stands in for the record on a first run", async () => {
    const { calls, code } = await run({ since: "v0.0.109" }, {})
    expect(code).toBe(0)
    expect(calls.slice(0, 2)).toEqual(["fetch v0.0.109 v0.0.111", "changed v0.0.109..v0.0.111"])
    expect(calls.at(-2)).toBe("record v0.0.111")
  })

  test("the tag already recorded deploys nothing", async () => {
    const { calls, code, out } = await run({}, { record: "v0.0.111" })
    expect(code).toBe(0)
    expect(out()).toContain("already deployed")
    expect(calls).toEqual([])
  })
})
