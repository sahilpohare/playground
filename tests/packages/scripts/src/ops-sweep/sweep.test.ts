import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SDK_PROBE } from "../../../../../packages/config/src/kinds"
import {
  boxRoute,
  chaseStale,
  check,
  CONFLICT_AFTER,
  type Context,
  forecast,
  IDLE_DB_AFTER,
  IDLE_DB_GAP,
  idleDbs,
  lateReviewers,
  leakedTests,
  maybePrune,
  opsDown,
  pass,
  prlessBranches,
  type Run,
  runsForDelete,
  stalledPrs,
} from "../../../../../packages/scripts/src/ops-sweep/sweep"
import { RETIRED } from "../../../../../packages/settings/src/jobs"
import { storeWith } from "../../../../scripts/hooks/render-set"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const DEAD = Bun.spawnSync(["true"]).pid
// A pid that reads gone now, verified before use, so a test holds however the machine reuses pids under load.
const gonePid = (): number => {
  for (;;) {
    const pid = Bun.spawnSync(["true"]).pid
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
  }
}
const NOW = Date.parse("2026-10-20T12:00:00Z")

type Call = { argv: string[]; cwd?: string; env?: Record<string, string | undefined> }

const PS = {
  out: "bash /x/scripts/ops/dashboard/supervisor.sh\n",
}

// A scratch config folder and a fake run: each argv is answered by the first reply whose key it starts with (ps shows the dashboard's supervisor unless told otherwise), else exit 0 and nothing printed.
const setup = (given: Record<string, { code?: number; out?: string }> = {}) => {
  const replies: Record<string, { code?: number; out?: string }> = {
    "gh api graphql": { out: JSON.stringify({ data: { search: { nodes: [] } } }) },
    "ps -ax": PS,
    ...given,
  }
  const cfg = realpathSync(mkdtempSync(join(tmpdir(), "ops-sweep-")))
  dirs.push(cfg)
  const data = join(cfg, "playground")
  const ops = join(data, "ops")
  mkdirSync(join(ops, "sweep"), { recursive: true })
  mkdirSync(join(cfg, "sessions"), { recursive: true })
  const calls: Call[] = []
  const run: Run = async (argv, options = {}) => {
    calls.push({ argv, cwd: options.cwd, env: options.env })
    const line = argv.join(" ")
    const key = Object.keys(replies).find((k) => line.startsWith(k))
    const reply = key === undefined ? {} : replies[key]!
    return { code: reply.code ?? 0, err: "", out: reply.out ?? "" }
  }
  const ctx: Context = {
    cfg,
    data,
    dashboard: "/dashboard",
    factory: async () => "acme/app",
    load: () => 1,
    main: "/main",
    now: () => NOW,
    ops,
    repo: "/repo",
    run,
  }
  return { calls, ctx, ops, sweep: join(ops, "sweep") }
}

const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const session = (ctx: Context, name: string, pid: number, status = "busy") =>
  write(join(ctx.cfg, "sessions", `${name}.json`), { name, pid, status })
const roster = (ctx: Context, agents: Record<string, unknown>[]) =>
  write(join(ctx.data, "roster.json"), { agents })
// A resume record as spawn.sh writes it: the server it ran on, then its exec line, with --ssh for a remote probe.
const sshRecord = (
  ctx: Context,
  name: string,
  server = "playground-probes",
  ssh = " --ssh a@10.0.0.2 --key /k",
) => {
  mkdirSync(join(ctx.data, "resume"), { recursive: true })
  writeFileSync(
    join(ctx.data, "resume", `${name}.sh`),
    `#!/bin/bash\n# server: ${server}\nexec /main/scripts/spawn.sh resume ${name} /main 6aafeb8a-bce0-4ceb-92cf-97f92cece832${ssh}\n`,
  )
}

const DOCKER_PS = "docker ps --filter name=^playground-"
const TEST_PS = "docker ps --filter name=^playground-test-"
const DASHBOARD_DB = "bun /repo/api/hono/src/bin/dashboard-db.ts"
const psql = (name: string) => `docker exec ${name} psql`

// idle-db.json as a pass that saw the containers left it, age seconds before NOW.
const idleState = (sweep: string, value: Record<string, number>, age = 0) => {
  const path = join(sweep, "idle-db.json")
  write(path, value)
  utimesSync(path, NOW / 1000 - age, NOW / 1000 - age)
}

describe("idleDbs", () => {
  test("flags a container with no client for 2 hours, keeping when it was first seen idle", async () => {
    const { ctx, sweep } = setup({
      [DOCKER_PS]: { out: "playground-a-db\nplayground-b-db\n" },
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
      [psql("playground-a-db")]: { out: "0\n" },
      [psql("playground-b-db")]: { out: "0\n" },
    })
    const first = NOW / 1000 - IDLE_DB_AFTER
    idleState(sweep, { "playground-a-db": first, "playground-gone-db": first })
    expect(await idleDbs(ctx)).toEqual(["idle-db:playground-a-db"])
    expect(read(join(sweep, "idle-db.json"))).toEqual({
      "playground-a-db": first,
      "playground-b-db": NOW / 1000,
    })
  })

  test("starts every clock again after a gap with no pass that saw the containers", async () => {
    const { ctx, sweep } = setup({
      [DOCKER_PS]: { out: "playground-a-db\n" },
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
      [psql("playground-a-db")]: { out: "0\n" },
    })
    idleState(sweep, { "playground-a-db": NOW / 1000 - 3 * 3600 }, IDLE_DB_GAP + 1)
    expect(await idleDbs(ctx)).toEqual([])
    expect(read(join(sweep, "idle-db.json"))).toEqual({ "playground-a-db": NOW / 1000 })
  })

  test("drops a container with a client from the state", async () => {
    const { ctx, sweep } = setup({
      [DOCKER_PS]: { out: "playground-a-db\n" },
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
      [psql("playground-a-db")]: { out: "2\n" },
    })
    idleState(sweep, { "playground-a-db": 0 })
    expect(await idleDbs(ctx)).toEqual([])
    expect(read(join(sweep, "idle-db.json"))).toEqual({})
  })

  test("never flags the dashboard database, found by POSTGRES_URL's port under any name", async () => {
    const { calls, ctx, sweep } = setup({
      [DOCKER_PS]: { out: "playground-dispatcher-db\nplayground-desk-db\n" },
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
      [psql("playground-dispatcher-db")]: { out: "0\n" },
      [psql("playground-desk-db")]: { out: "0\n" },
    })
    idleState(sweep, { "playground-desk-db": 0, "playground-dispatcher-db": 0 })
    expect(await idleDbs(ctx)).toEqual(["idle-db:playground-desk-db"])
    expect(calls.some((c) => c.argv.join(" ").startsWith(psql("playground-dispatcher-db")))).toBe(
      false,
    )
    const lookup = calls.find((c) => c.argv.join(" ").startsWith(DASHBOARD_DB))!
    expect(lookup.cwd).toBe("/dashboard")
    expect(lookup.env && "POSTGRES_URL" in lookup.env).toBe(false)
  })

  test("skips the check with dashboard-db-unknown when the dashboard database cannot be found", async () => {
    const { calls, ctx, sweep } = setup({
      [DOCKER_PS]: { out: "playground-dispatcher-db\n" },
      [DASHBOARD_DB]: { code: 1 },
      [psql("playground-dispatcher-db")]: { out: "0\n" },
    })
    idleState(sweep, { "playground-dispatcher-db": 0 })
    expect(await idleDbs(ctx)).toEqual(["dashboard-db-unknown"])
    expect(calls.some((c) => c.argv[0] === "docker" && c.argv[1] === "exec")).toBe(false)
    expect(read(join(sweep, "idle-db.json"))).toEqual({ "playground-dispatcher-db": 0 })
  })
})

describe("leakedTests", () => {
  test("removes a playground-test-<suite>-<pid> container whose pid is gone, with its volumes", async () => {
    const { calls, ctx } = setup({ [TEST_PS]: { out: "playground-test-ask-4242\n" } })
    expect(await leakedTests(ctx, (pid) => pid !== 4242)).toEqual(["playground-test-ask-4242"])
    expect(calls.some((c) => c.argv.join(" ") === "docker rm -fv playground-test-ask-4242")).toBe(
      true,
    )
  })

  test("leaves a playground-test- container whose pid still runs alone", async () => {
    const { calls, ctx } = setup({ [TEST_PS]: { out: "playground-test-inbox-4243\n" } })
    expect(await leakedTests(ctx, (pid) => pid === 4243)).toEqual([])
    expect(calls.some((c) => c.argv[0] === "docker" && c.argv[1] === "rm")).toBe(false)
  })

  test("leaves a name whose last field is not a pid alone: a worktree named test-x reads playground-test-x-db", async () => {
    const { calls, ctx } = setup({
      [TEST_PS]: { out: "playground-test-x-db\nplayground-test-worktree-db\n" },
    })
    expect(await leakedTests(ctx, () => false)).toEqual([])
    expect(calls.some((c) => c.argv[0] === "docker" && c.argv[1] === "rm")).toBe(false)
  })

  test("counts a pid whose signal is refused as running, so pid 1's container stays", async () => {
    expect(runsForDelete(process.pid)).toBe(true)
    expect(runsForDelete(gonePid())).toBe(false)
    const { calls, ctx } = setup({ [TEST_PS]: { out: "playground-test-ask-1\n" } })
    expect(await leakedTests(ctx)).toEqual([])
    expect(calls.some((c) => c.argv[0] === "docker" && c.argv[1] === "rm")).toBe(false)
  })

  test("reads nothing when docker does not answer", async () => {
    const { calls, ctx } = setup({ [TEST_PS]: { code: 1 } })
    expect(await leakedTests(ctx)).toEqual([])
    expect(calls.some((c) => c.argv[0] === "docker" && c.argv[1] === "rm")).toBe(false)
  })

  test("pass removes a dead-pid test container and logs the removal to the ops log", async () => {
    const dead = gonePid()
    const { calls, ctx, ops } = setup({ [TEST_PS]: { out: `playground-test-ask-${dead}\n` } })
    roster(ctx, [])
    const { result } = await pass(ctx, new Set(), new Set())
    expect(result).toBe("ok")
    expect(
      calls.some((c) => c.argv.join(" ") === `docker rm -fv playground-test-ask-${dead}`),
    ).toBe(true)
    expect(readFileSync(join(ops, "ops-log.md"), "utf8")).toContain(
      `leaked test containers removed (ops-sweep): playground-test-ask-${dead}`,
    )
  })
})

describe("check", () => {
  test("a parked runner never reads as down, an ended one neither, a working one does", async () => {
    const { ctx } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [
      { name: "runner-parked", status: "parked" },
      { name: "runner-ended", status: "ended" },
      { name: "runner-gone", status: "working" },
      { name: "runner-waits", status: "working" },
      { name: "runner-busy", status: "working" },
    ])
    session(ctx, "runner-waits", process.pid, "waiting")
    session(ctx, "runner-busy", process.pid)
    session(ctx, "runner-gone", DEAD)
    expect((await check(ctx)).sort()).toEqual(["down:runner-gone", "waiting:runner-waits"])
  })

  test("probes: gone but not ended, over 15 minutes, unrecorded after 10", async () => {
    const { ctx, sweep } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [
      { name: "probe-gone", status: "working" },
      { name: "probe-old", status: "working" },
    ])
    session(ctx, "probe-old", process.pid)
    session(ctx, "probe-stray", process.pid)
    const now = NOW / 1000
    write(join(sweep, "probe-first-seen.json"), {
      "probe-left": now - 3600,
      "probe-old": now - 16 * 60,
      "probe-stray": now - 11 * 60,
    })
    expect((await check(ctx)).sort()).toEqual([
      "probe-gone-unended:probe-gone",
      "probe-over-15m:probe-old",
      "probe-unrecorded:probe-stray",
    ])
    expect(read(join(sweep, "probe-first-seen.json"))).toEqual({
      "probe-old": now - 16 * 60,
      "probe-stray": now - 11 * 60,
    })
  })

  test("an --ssh probe is live while its labelled pane runs ssh, read once a server, and gone when the pane is gone or back at its shell", async () => {
    const { ctx, sweep } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [
      { kind: "probe", name: "ssh-live", status: "working" },
      { kind: "probe", name: "ssh-old", status: "working" },
      { kind: "probe", name: "ssh-shell", status: "working" },
      { kind: "probe", name: "ssh-gone", status: "working" },
      { name: "probe-local", status: "working" },
    ])
    sshRecord(ctx, "ssh-live")
    sshRecord(ctx, "ssh-old")
    sshRecord(ctx, "ssh-shell")
    sshRecord(ctx, "ssh-gone")
    sshRecord(ctx, "probe-local", "playground-probes", "")
    write(join(sweep, "probe-first-seen.json"), { "ssh-old": NOW / 1000 - 16 * 60 })
    const reads: string[] = []
    ctx.herdr = async (server, args) => {
      reads.push(`${server} ${args.join(" ")}`)
      if (args[1] === "list")
        return JSON.stringify({
          result: {
            panes: [
              { label: "ssh-live", pane_id: "w1:p1" },
              { label: "ssh-old", pane_id: "w1:p2" },
              { label: "ssh-shell", pane_id: "w1:p3" },
              { label: "probe-local", pane_id: "w1:p4" },
            ],
          },
        })
      const name = args.at(-1) === "w1:p3" ? "bash" : "ssh"
      return JSON.stringify({
        result: { process_info: { foreground_processes: [{ argv: [name], name, pid: 1 }] } },
      })
    }
    expect((await check(ctx)).sort()).toEqual([
      "probe-gone-unended:probe-local",
      "probe-gone-unended:ssh-gone",
      "probe-gone-unended:ssh-shell",
      "probe-over-15m:ssh-old",
    ])
    expect(reads.filter((r) => r.endsWith("pane list"))).toEqual(["playground-probes pane list"])
    expect(read(join(sweep, "probe-first-seen.json"))).toEqual({
      "ssh-live": NOW / 1000,
      "ssh-old": NOW / 1000 - 16 * 60,
    })
  })

  test("an --ssh probe is live when any pane under its label runs ssh, a stale shell pane listed first", async () => {
    const { ctx } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [{ kind: "probe", name: "ssh-again", status: "working" }])
    sshRecord(ctx, "ssh-again")
    ctx.herdr = async (_server, args) => {
      if (args[1] === "list")
        return JSON.stringify({
          result: {
            panes: [
              { label: "ssh-again", pane_id: "w1:p1" },
              { label: "ssh-again", pane_id: "w1:p2" },
            ],
          },
        })
      const name = args.at(-1) === "w1:p1" ? "bash" : "ssh"
      return JSON.stringify({
        result: { process_info: { foreground_processes: [{ argv: [name], name, pid: 1 }] } },
      })
    }
    expect(await check(ctx)).toEqual([])
  })

  test("an --ssh probe reads gone with no herdr reader, and no pane is read with no --ssh probe unended", async () => {
    const { ctx } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [
      { kind: "probe", name: "ssh-live", status: "working" },
      { kind: "probe", name: "ssh-ended", status: "ended" },
    ])
    sshRecord(ctx, "ssh-live")
    sshRecord(ctx, "ssh-ended")
    expect(await check(ctx)).toEqual(["probe-gone-unended:ssh-live"])
    const reads: string[] = []
    ctx.herdr = async (server, args) => {
      reads.push(`${server} ${args.join(" ")}`)
      return ""
    }
    roster(ctx, [{ name: "ssh-ended", status: "ended" }])
    expect(await check(ctx)).toEqual([])
    expect(reads).toEqual([])
  })

  test("a runner and a probe by their kind: an <id>-<kind> name, or a roster kind over any name", async () => {
    const { ctx, sweep } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [
      { name: "k3m9px-runner", status: "working" },
      { kind: "runner", name: "plain-job", status: "working" },
      { name: "b7k2mq-probe", status: "working" },
      { kind: "probe", name: "plain-test", status: "working" },
    ])
    session(ctx, "x7mh4d-probe", process.pid)
    write(join(sweep, "probe-first-seen.json"), { "x7mh4d-probe": NOW / 1000 - 16 * 60 })
    expect((await check(ctx)).sort()).toEqual([
      "down:k3m9px-runner",
      "down:plain-job",
      "probe-gone-unended:b7k2mq-probe",
      "probe-gone-unended:plain-test",
      "probe-over-15m:x7mh4d-probe",
      "probe-unrecorded:x7mh4d-probe",
    ])
  })

  // #2597: the dashboard's hosted session runs as a probe for the factory's hooks, but no lead spawns or records it, so it raised probe-unrecorded:probe-sdk
  test("the dashboard's hosted session raises no probe alert, while an unrecorded probe past 15 minutes raises both", async () => {
    const { ctx, sweep } = setup({ [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" } })
    roster(ctx, [])
    session(ctx, SDK_PROBE, process.pid)
    session(ctx, "x7mh4d-probe", process.pid)
    const old = NOW / 1000 - 16 * 60
    write(join(sweep, "probe-first-seen.json"), { [SDK_PROBE]: old, "x7mh4d-probe": old })
    expect((await check(ctx)).sort()).toEqual([
      "probe-over-15m:x7mh4d-probe",
      "probe-unrecorded:x7mh4d-probe",
    ])
  })

  test("an answered ask on ops's entry, read through bun run ask", async () => {
    const { calls, ctx } = setup({
      "bun run --silent --cwd /dashboard ask get #i7": { out: 'note\n{"status":"answered"}' },
      "bun run --silent --cwd /dashboard ask get #i8": { out: '{"status":"open"}' },
      "bun run --silent --cwd /dashboard ask get x9": { code: 1 },
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
    })
    roster(ctx, [{ asks: "7 8 x9", name: "ops", status: "working" }])
    expect((await check(ctx)).sort()).toEqual(["ask-answered:7", "ask-unreadable:x9"])
    expect(calls.some((c) => c.argv.at(-1) === "x9")).toBe(true)
  })

  test("an answered ask on an <id>-ops entry, which holds ops' seat by its name (PG-1644)", async () => {
    const { ctx } = setup({
      "bun run --silent --cwd /dashboard ask get #i7": { out: '{"status":"answered"}' },
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
    })
    roster(ctx, [
      { asks: "7", name: "k3v9q2-ops", status: "working" },
      { asks: "7", name: "x7mh4d-worker", status: "working" },
    ])
    expect(await check(ctx)).toEqual(["ask-answered:7"])
  })

  test("an unreadable roster is the one finding", async () => {
    const { ctx } = setup()
    expect(await check(ctx)).toEqual(["roster-unreadable:ENOENT"])
  })
})

describe("chaseStale", () => {
  const STALE = "bun run --silent --cwd /dashboard ask stale --minutes 15"
  const lines = [
    "#i3 abc from builder: go, answered 20m ago",
    "#i4 def from worker-gone: answer, answered 40m ago",
  ].join("\n")

  test("reminds a live poster once every 30 minutes and names a poster that is down", async () => {
    const { calls, ctx, sweep } = setup({ [STALE]: { out: lines } })
    const live = new Map([["builder", "busy"]])
    expect(await chaseStale(ctx, live)).toEqual(["stale-poster-down:#i4:worker-gone"])
    const sent = calls.filter((c) => c.argv[1] === "/repo/scripts/ops/notify.sh")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.argv.slice(2, 3)).toEqual(["sweep"])
    expect(sent[0]!.argv[3]).toStartWith("Inbox #i3 (abc): the owner answered 20m ago")
    expect(sent[0]!.env?.NOTIFY_TO).toBe("builder")
    expect(read(join(sweep, "stale-told.json"))).toEqual({ "#i3": NOW / 1000, "#i4": 0 })
    await chaseStale(ctx, live)
    expect(calls.filter((c) => c.argv[1] === "/repo/scripts/ops/notify.sh")).toHaveLength(1)
  })

  test("reports an unclosed answer once, stays quiet on it for 4 hours, then reports it again (#129)", async () => {
    const { calls, ctx } = setup({ [STALE]: { out: lines } })
    const live = new Map([["builder", "busy"]])
    const told = () => calls.filter((c) => c.argv[1] === "/repo/scripts/ops/notify.sh").length
    const at = (minutes: number) => {
      ctx.now = () => NOW + minutes * 60_000
      return chaseStale(ctx, live)
    }
    await at(0)
    await at(5)
    await at(60)
    await at(239)
    expect(told()).toBe(1)
    await at(240)
    expect(told()).toBe(2)
  })

  test("a failed read is stale-unreadable", async () => {
    const { ctx } = setup({ [STALE]: { code: 1 } })
    expect(await chaseStale(ctx, new Map())).toEqual(["stale-unreadable"])
  })
})

describe("boxRoute", () => {
  const route = async (reply: { code?: number; out?: string }) => {
    const { ctx, ops } = setup()
    const argvs: string[][] = []
    ctx.run = async (argv) => {
      argvs.push(argv)
      return { code: reply.code ?? 0, err: "", out: reply.out ?? "" }
    }
    const found = await boxRoute(ctx)
    expect(argvs).toEqual([[join(ops, "run-slot.sh"), "box-off"]])
    return found
  }

  test("names each failing precondition run-slot.sh box-off prints in one finding, and none when the route can fire (#129)", async () => {
    expect(await route({ out: "no-ci-sh\nno-ssh-key\n" })).toEqual([
      "box-route-off:no-ci-sh,no-ssh-key",
    ])
    expect(await route({ out: "slot-off\n" })).toEqual(["box-route-off:slot-off"])
    expect(await route({ out: "" })).toEqual([])
    expect(await route({ code: 2 })).toEqual(["box-route-unreadable"])
  })
})

describe("lateReviewers", () => {
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
  // one PR as GitHub's GraphQL answers it: open, its head's checks in the rollup state given, the last finishing `ready` minutes ago, and the comments given
  const answer = (ready: number, comments: string[] = [], state = "SUCCESS", isDraft = false) =>
    JSON.stringify({
      data: {
        repository: {
          p145: {
            comments: { nodes: comments.map((body) => ({ body })) },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { completedAt: minutesAgo(ready + 5) },
                          { completedAt: minutesAgo(ready) },
                        ],
                      },
                      state,
                    },
                  },
                },
              ],
            },
            headRefOid: "b9861d6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            isDraft,
            state: "OPEN",
          },
        },
      },
    })
  const late = async (
    reply: string,
    live: [string, string][] = [],
    reviewer = true,
    status = "working",
  ) => {
    const { ctx } = setup()
    const told: Call[] = []
    ctx.factory = async () => "acme/app"
    ctx.run = async (argv, options = {}) => {
      if (argv[1] === "/repo/scripts/ops/notify.sh") told.push({ argv, env: options.env })
      return { code: 0, err: "", out: argv[0] === "gh" ? reply : "" }
    }
    const agents = [
      { kind: "builder", name: "builder" },
      {
        kind: "worker",
        name: "abcdef-worker",
        pr: "https://github.com/acme/app/pull/145",
        status,
      },
      ...(reviewer ? [{ kind: "reviewer", name: "ghjkmn-reviewer", pr: "145", status }] : []),
    ]
    roster(ctx, agents)
    const found = await lateReviewers(ctx, agents, new Map(live))
    const again = told.length
    await lateReviewers(ctx, agents, new Map(live))
    return { again, found, told }
  }

  test("tells the worker's lead once per head when a head ready 20 minutes has no round and no live reviewer (#129)", async () => {
    const { again, found, told } = await late(answer(21))
    expect(found).toEqual([])
    expect(again).toBe(1)
    expect(told).toHaveLength(1)
    expect(told[0]!.env?.NOTIFY_TO).toBe("builder")
    expect(told[0]!.argv[3]).toBe(
      "PR #145 (abcdef-worker): its head b9861d6 has been ready 21m with no review round and no live session for ghjkmn-reviewer. Start its reviewer, or ask abcdef-worker to.",
    )
    const none = await late(answer(21), [], false)
    expect(none.told[0]!.argv[3]).toContain("no reviewer on the roster")
  })

  test("stays quiet before 20 minutes, after a review round, with a live reviewer, or while the checks are not green (#129)", async () => {
    expect((await late(answer(19))).told).toEqual([])
    expect((await late(answer(30, ["## ReviewBot · round 1: 3/5 at 1234567"]))).told).toEqual([])
    expect((await late(answer(30), [["ghjkmn-reviewer", "busy"]])).told).toEqual([])
    expect((await late(answer(30, [], "PENDING"))).told).toEqual([])
  })

  test("a green draft with no reviewer row sends nothing, and a ready non-draft still alerts (#1565)", async () => {
    expect((await late(answer(30, [], "SUCCESS", true), [], false)).told).toEqual([])
    const nonDraft = await late(answer(30, [], "SUCCESS", false), [], false)
    expect(nonDraft.told).toHaveLength(1)
    expect(nonDraft.told[0]!.argv[3]).toContain("no reviewer on the roster")
  })

  test("a parked worker's ready head sends nothing, while a working one's still alerts (#175)", async () => {
    expect((await late(answer(30), [], true, "parked")).told).toEqual([])
    expect((await late(answer(30), [], true, "working")).told).toHaveLength(1)
  })

  test("a GraphQL answer it cannot read is reviewer-check-unreadable", async () => {
    expect((await late("not json")).found).toEqual(["reviewer-check-unreadable"])
  })

  // the two PRs as GitHub's GraphQL answers one query carrying both aliases, each ready the minutes given
  const answerTwo = (ready: number) =>
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          [146, 147].map((n) => [
            `p${n}`,
            {
              comments: { nodes: [] },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            { completedAt: minutesAgo(ready + 5) },
                            { completedAt: minutesAgo(ready) },
                          ],
                        },
                        state: "SUCCESS",
                      },
                    },
                  },
                ],
              },
              headRefOid: `b9860000000000000000000000000000000000${n}`,
              state: "OPEN",
            },
          ]),
        ),
      },
    })

  test("a reviewer row whose prs names the PR covers it, and a PR no row names still alerts (#1533)", async () => {
    const { ctx } = setup()
    const told: Call[] = []
    ctx.factory = async () => "acme/app"
    ctx.run = async (argv, options = {}) => {
      if (argv[1] === "/repo/scripts/ops/notify.sh") told.push({ argv, env: options.env })
      return { code: 0, err: "", out: argv[0] === "gh" ? answerTwo(21) : "" }
    }
    const agents = [
      { kind: "builder", name: "builder" },
      {
        kind: "worker",
        name: "bbbbb-worker",
        pr: "https://github.com/acme/app/pull/146",
        status: "working",
      },
      {
        kind: "worker",
        name: "ccccc-worker",
        pr: "https://github.com/acme/app/pull/147",
        status: "working",
      },
      {
        kind: "reviewer",
        name: "ghjkmn-reviewer",
        pr: "145",
        prs: ["145", "146"],
        status: "working",
      },
    ]
    roster(ctx, agents)
    const found = await lateReviewers(ctx, agents, new Map([["ghjkmn-reviewer", "busy"]]))
    expect(found).toEqual([])
    // PR 146 is covered by the live reviewer's prs, so it stays quiet; PR 147, named by no row, still alerts
    expect(told).toHaveLength(1)
    expect(told[0]!.argv[3]).toContain("PR #147 (ccccc-worker)")
    expect(told[0]!.argv[3]).toContain("no reviewer on the roster")
    // once that reviewer's session is gone, PR 146 alerts by its name; PR 147 was told at this head already
    await lateReviewers(ctx, agents, new Map())
    expect(told).toHaveLength(2)
    expect(told[1]!.argv[3]).toContain("PR #146 (bbbbb-worker)")
    expect(told[1]!.argv[3]).toContain("no live session for ghjkmn-reviewer")
  })
})

describe("conflicting PRs, in lateReviewers' read (#2457)", () => {
  // PR 145 as GitHub's GraphQL answers it (#2443's shape: a rollup green from other apps, no GitHub Actions suite), its checks still pending so no late-reviewer line mixes in
  const answer = (fields: Record<string, unknown> = {}, runs = 0) =>
    JSON.stringify({
      data: {
        repository: {
          p145: {
            comments: { nodes: [] },
            commits: {
              nodes: [
                {
                  commit: {
                    checkSuites: { totalCount: runs },
                    statusCheckRollup: { contexts: { nodes: [] }, state: "PENDING" },
                  },
                },
              ],
            },
            headRefOid: "c0ff1c7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            isDraft: false,
            mergeStateStatus: "DIRTY",
            mergeable: "CONFLICTING",
            state: "OPEN",
            ...fields,
          },
        },
      },
    })
  // one sweep's read at each of the given seconds after NOW, each answered by its own reply, with every queued line it told
  const sweeps = async (replies: string[], step = 300) => {
    const { ctx, sweep } = setup()
    const told: Call[] = []
    let at = 0
    ctx.now = () => NOW + at * 1000
    let reply = ""
    ctx.run = async (argv, options = {}) => {
      if (argv[1] === "/repo/scripts/ops/notify.sh") told.push({ argv, env: options.env })
      return { code: 0, err: "", out: argv[0] === "gh" ? reply : "" }
    }
    const agents = [
      { kind: "builder", name: "builder" },
      {
        kind: "worker",
        name: "abcdef-worker",
        pr: "https://github.com/acme/app/pull/145",
        status: "working",
      },
    ]
    roster(ctx, agents)
    const counts: number[] = []
    for (const [i, out] of replies.entries()) {
      at = i * step
      reply = out
      await lateReviewers(ctx, agents, new Map())
      counts.push(told.length)
    }
    return { counts, state: read(join(sweep, "conflict-told.json")), told }
  }

  test("a conflict with no run at the head tells the worker and its lead one sweep after it is first seen, once per head", async () => {
    const { counts, told } = await sweeps([answer(), answer(), answer()])
    expect(counts).toEqual([0, 2, 2])
    expect(told.map((c) => c.env?.NOTIFY_TO)).toEqual(["abcdef-worker", "builder"])
    expect(told[0]!.argv[2]).toBe("sweep")
    expect(told[0]!.argv[3]).toBe(
      "PR #145 (abcdef-worker): it conflicts with its base at head c0ff1c7, so GitHub runs no CI on it. Merge canary into it and push.",
    )
  })

  test("#2443's shape, a rollup green from other apps with no Actions run, gets the conflict line and no late-reviewer line", async () => {
    const green = answer({
      commits: {
        nodes: [
          {
            commit: {
              checkSuites: { totalCount: 0 },
              statusCheckRollup: {
                contexts: { nodes: [{ completedAt: new Date(NOW - 60 * 60_000).toISOString() }] },
                state: "SUCCESS",
              },
            },
          },
        ],
      },
    })
    const { counts, told } = await sweeps([green, green])
    expect(counts).toEqual([0, 2])
    expect(told.every((c) => c.argv[3]!.includes("it conflicts with its base"))).toBe(true)
  })

  test("a new head that conflicts again starts its own clock and tells again", async () => {
    const moved = answer({ headRefOid: "c0ff2c7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    const { counts, told } = await sweeps([answer(), answer(), moved, moved])
    expect(counts).toEqual([0, 2, 2, 4])
    expect(told[2]!.argv[3]).toContain("at head c0ff2c7")
  })

  test("a draft alerts too, since a draft gets CI; DIRTY alone or CONFLICTING alone is a conflict", async () => {
    expect((await sweeps([answer({ isDraft: true }), answer({ isDraft: true })])).counts).toEqual([
      0, 2,
    ])
    const dirty = answer({ mergeable: "UNKNOWN" })
    expect((await sweeps([dirty, dirty])).counts).toEqual([0, 2])
    const conflicting = answer({ mergeStateStatus: "UNKNOWN" })
    expect((await sweeps([conflicting, conflicting])).counts).toEqual([0, 2])
  })

  test("stays quiet with a GitHub Actions run at the head, while GitHub works it out (UNKNOWN), and before CONFLICT_AFTER", async () => {
    expect((await sweeps([answer({}, 1), answer({}, 1)])).told).toEqual([])
    const unknown = answer({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })
    const quiet = await sweeps([unknown, unknown])
    expect(quiet.told).toEqual([])
    expect(quiet.state).toEqual({})
    expect((await sweeps([answer(), answer()], CONFLICT_AFTER - 1)).told).toEqual([])
  })

  test("an UNKNOWN read at the same head, as GitHub works it out again after the base moves, keeps the told mark and tells nothing", async () => {
    const unknown = answer({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })
    const { counts, state } = await sweeps([answer(), answer(), unknown, answer(), answer()])
    expect(counts).toEqual([0, 2, 2, 2, 2])
    expect(state["145"]).toMatchObject({
      sha: "c0ff1c7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      told: true,
    })
    // an UNKNOWN read before the clock runs out neither tells nor restarts it
    expect((await sweeps([answer(), unknown, answer()])).counts).toEqual([0, 0, 2])
  })

  test("keeps only PRs conflicting now, so a fixed conflict that comes back at the same head tells again", async () => {
    const clean = answer({ mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" })
    const { counts, state } = await sweeps([answer(), answer(), clean, answer(), answer()])
    expect(counts).toEqual([0, 2, 2, 2, 4])
    expect(Object.keys(state)).toEqual(["145"])
    const closed = await sweeps([answer(), answer({ state: "MERGED" })])
    expect(closed.state).toEqual({})
  })
})

describe("stalledPrs", () => {
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
  type Pr = {
    body?: string
    checks?: string
    comments?: { age: number; body: string }[]
    commitAge?: number
    createdAge?: number
    labels?: string[]
    number?: number
    repo?: string
  }
  // open PRs as GitHub's GraphQL search answers them: each opened `createdAge` minutes ago (by default when its head was committed) with its head committed `commitAge` minutes ago, its checks in the rollup state given, and its comments oldest first
  const answer = (prs: Pr[]) =>
    JSON.stringify({
      data: {
        search: {
          nodes: prs.map((p) => ({
            body: p.body ?? "",
            comments: {
              nodes: (p.comments ?? []).map((c) => ({
                body: c.body,
                createdAt: minutesAgo(c.age),
              })),
            },
            commits: {
              nodes: [
                {
                  commit: {
                    committedDate: minutesAgo(p.commitAge ?? 5),
                    statusCheckRollup: { state: p.checks ?? "FAILURE" },
                  },
                },
              ],
            },
            createdAt: minutesAgo(p.createdAge ?? p.commitAge ?? 5),
            labels: { nodes: (p.labels ?? []).map((name) => ({ name })) },
            number: p.number ?? 9,
            repository: { nameWithOwner: p.repo ?? "acme/app" },
            reviews: { nodes: [] },
          })),
        },
      },
    })
  const verdicts = (...scores: number[]) =>
    scores.map((s, i) => ({
      age: 20 * (scores.length - i),
      body: `## ReviewBot · round ${i + 9}: ${s}/5 at 1234567 · 2 blocking`,
    }))
  const stalled = async (reply: string, agents: Record<string, unknown>[] = []) => {
    const { ctx, ops } = setup()
    const queries: string[] = []
    ctx.run = async (argv) => {
      if (argv[0] === "gh") queries.push(argv.join(" "))
      return { code: 0, err: "", out: argv[0] === "gh" ? reply : "" }
    }
    const found = await stalledPrs(ctx, agents)
    let file: { alerts: Record<string, string>[]; writtenAt: string } | null = null
    try {
      file = read(join(ops, "alerts-prs.json"))
    } catch {}
    return { ctx, file, found, queries }
  }
  const lines = async (prs: Pr[]) => (await stalled(answer(prs))).file?.alerts.map((a) => a.line)

  test("writes an entry for a PR whose last 4 verdicts hold one score below 5, naming the score and round (#454)", async () => {
    const { file, found } = await stalled(answer([{ comments: verdicts(5, 3, 3, 3, 3) }]))
    expect(found).toEqual([])
    expect(file).toEqual({
      alerts: [
        {
          at: "2026-10-20T12:00:00Z",
          kind: "pr-stalled",
          lastActivityAt: "2026-10-20T11:55:00Z",
          line: "last 4 verdicts 3/5, round 13",
          name: "acme/app#9",
        },
      ],
      writtenAt: "2026-10-20T12:00:00Z",
    })
  })

  test("writes no entry for 3 same scores, 4 mixed ones, or 4 at 5/5 (#454)", async () => {
    expect(await lines([{ comments: verdicts(3, 3, 3) }])).toEqual([])
    expect(await lines([{ comments: verdicts(3, 4, 3, 3) }])).toEqual([])
    expect(await lines([{ comments: verdicts(5, 5, 5, 5) }])).toEqual([])
  })

  test("reads only ReviewBot verdicts among the comments when it counts 4 (#454)", async () => {
    const comments = [
      ...verdicts(3, 3),
      { age: 15, body: "## TesterBot · PASS at 1234567" },
      { age: 12, body: "pushed a fix" },
      ...verdicts(3, 3).map((c) => ({ ...c, age: c.age / 4 })),
    ]
    expect(await lines([{ comments }])).toEqual(["last 4 verdicts 3/5, round 10"])
  })

  test("writes an entry for a PR with no commit, verdict or comment for 30 minutes, not before (#454)", async () => {
    expect(await lines([{ comments: [{ age: 31, body: "a comment" }], commitAge: 40 }])).toEqual([
      "no new commit, verdict or comment for 31m",
    ])
    expect(await lines([{ comments: [{ age: 29, body: "a comment" }], commitAge: 40 }])).toEqual([])
    expect(await lines([{ commitAge: 29 }])).toEqual([])
  })

  test("counts a PR's opening as activity, so one opened 10 minutes ago from a 2-hour-old head is not idle", async () => {
    expect(await lines([{ commitAge: 120, createdAge: 10 }])).toEqual([])
    expect(await lines([{ commitAge: 120, createdAge: 120 }])).toEqual([
      "no new commit, verdict or comment for 120m",
    ])
  })

  test("joins both reasons in one entry for a PR that is idle and repeats its score (#454)", async () => {
    const comments = verdicts(2, 2, 2, 2).map((c) => ({ ...c, age: c.age + 40 }))
    expect(await lines([{ commitAge: 90, comments }])).toEqual([
      "last 4 verdicts 2/5, round 12; no new commit, verdict or comment for 60m",
    ])
  })

  test("leaves out an idle PR waiting on its checks or on merge-on-ready, but not its repeated score (#454)", async () => {
    expect(await lines([{ checks: "PENDING", commitAge: 40 }])).toEqual([])
    const { ctx } = setup()
    write(join(ctx.data, "merge-queue.json"), { queue: [{ pr: 9, readyAt: minutesAgo(35) }] })
    ctx.run = async (argv) => ({
      code: 0,
      err: "",
      out: argv[0] === "gh" ? answer([{ checks: "SUCCESS", commitAge: 40 }]) : "",
    })
    await stalledPrs(ctx, [])
    expect(read(join(ctx.ops, "alerts-prs.json")).alerts).toEqual([])
    expect(
      await lines([{ checks: "PENDING", comments: verdicts(3, 3, 3, 3), commitAge: 40 }]),
    ).toEqual(["last 4 verdicts 3/5, round 12"])
  })

  test("leaves out a PR held or parked by its body, a label or its newest comment (#454)", async () => {
    const repeat = verdicts(3, 3, 3, 3)
    expect(await lines([{ body: "## TL;DR\n\nParked: waits on #12.", comments: repeat }])).toEqual(
      [],
    )
    expect(await lines([{ comments: repeat, labels: ["on hold"] }])).toEqual([])
    expect(await lines([{ comments: repeat, labels: ["parked"] }])).toEqual([])
    expect(
      await lines([{ comments: [...repeat, { age: 1, body: "**Held:** until the lock lands." }] }]),
    ).toEqual([])
    for (const body of [
      "The lock is held by the train.",
      "- Parked work: none related.",
      "- **Held/parked:** a line opening with the marker.",
    ])
      expect(await lines([{ body, comments: repeat, commitAge: 40 }])).toEqual([
        "last 4 verdicts 3/5, round 12",
      ])
    expect(await lines([{ comments: repeat, labels: ["threshold"] }])).toEqual([
      "last 4 verdicts 3/5, round 12",
    ])
  })

  test("reads the factory repo and each live row's PR repo in one search for our open PRs (#454)", async () => {
    const { queries } = await stalled(answer([]), [
      { name: "abcdef-worker", pr: "https://github.com/Work/Site/pull/3", status: "working" },
      { name: "ghjkmn-worker", pr: "https://github.com/old/gone/pull/1", status: "ended" },
      { name: "pqrstv-worker", pr: "https://github.com/old/done/pull/2", status: "merged" },
    ])
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain("is:pr is:open author:@me repo:acme/app repo:work/site")
    expect(queries[0]).not.toContain("old/")
  })

  // In a repo other than the factory's, the search finds every open PR the shared account ever opened there, most of them no factory work.
  test("outside the factory repo it alerts only on a PR a live row names in pr or prs, and searches each named repo", async () => {
    const idle = 40
    const { file, queries } = await stalled(
      answer([
        { commitAge: idle, number: 3, repo: "work/site" },
        { commitAge: 93 * 24 * 60, number: 700, repo: "work/site" },
        { commitAge: idle, number: 5, repo: "work/other" },
        { commitAge: idle, number: 6, repo: "work/other" },
        { commitAge: idle, number: 9 },
      ]),
      [
        { name: "abcdef-worker", pr: "https://github.com/Work/Site/pull/3", status: "working" },
        {
          name: "abcdef-reviewer",
          prs: ["https://github.com/work/other/pull/5", "https://github.com/work/other/issues/6"],
          status: "working",
        },
        { name: "ghjkmn-worker", pr: "https://github.com/work/site/pull/700", status: "ended" },
      ],
    )
    expect(file?.alerts.map((a) => a.name).sort()).toEqual([
      "acme/app#9",
      "work/other#5",
      "work/site#3",
    ])
    expect(queries[0]).toContain("repo:work/other")
  })

  test("in the factory repo it alerts on every open PR of ours, named by a row or not", async () => {
    const { file } = await stalled(answer([{ commitAge: 600, number: 9 }]), [
      { name: "abcdef-worker", pr: "https://github.com/acme/app/pull/12", status: "working" },
    ])
    expect(file?.alerts.map((a) => a.name)).toEqual(["acme/app#9"])
  })

  test("an answer it cannot read is stalled-check-unreadable, and leaves the file as it was (#454)", async () => {
    const { file, found } = await stalled("not json")
    expect(found).toEqual(["stalled-check-unreadable"])
    expect(file).toBeNull()
  })
})

describe("prlessBranches", () => {
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
  // each branch as GitHub's GraphQL answers it, by its alias: its head committed `age` minutes ago with `prs` PRs in any state, or null when the branch is not on GitHub
  const answer = (branches: (null | { age: number; prs: number })[]) =>
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          branches.map((b, i) => [
            `b${i}`,
            b && {
              associatedPullRequests: { totalCount: b.prs },
              target: {
                committedDate: minutesAgo(b.age),
                oid: `c0ffee${i}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
              },
            },
          ]),
        ),
      },
    })
  const sweep = async (
    reply: string,
    rows: Record<string, unknown>[] = [
      { branch: "PG-234-branch-no-pr", kind: "worker", name: "abcdef-worker", status: "working" },
    ],
  ) => {
    const { ctx } = setup()
    const told: Call[] = []
    const queries: string[] = []
    ctx.factory = async () => "acme/app"
    ctx.run = async (argv, options = {}) => {
      if (argv[1] === "/repo/scripts/ops/notify.sh") told.push({ argv, env: options.env })
      if (argv[0] === "gh") queries.push(argv.join(" "))
      return { code: 0, err: "", out: argv[0] === "gh" ? reply : "" }
    }
    const agents = [{ kind: "builder", name: "builder" }, ...rows]
    roster(ctx, agents)
    const found = await prlessBranches(ctx, agents)
    const again = told.length
    await prlessBranches(ctx, agents)
    return { again, found, queries, told }
  }

  test("tells the worker's lead once per head when its PG branch's head is 15 minutes old with no PR (#234)", async () => {
    const { again, found, told } = await sweep(answer([{ age: 16, prs: 0 }]))
    expect(found).toEqual([])
    expect(again).toBe(1)
    expect(told).toHaveLength(1)
    expect(told[0]!.env?.NOTIFY_TO).toBe("builder")
    expect(told[0]!.argv[3]).toBe(
      "Branch PG-234-branch-no-pr (abcdef-worker): its head c0ffee0 is 16m old and has no PR, so no CI runs on it. Open its draft PR so CI runs.",
    )
  })

  test("tells the lead again when the branch's head moves and still has no PR (#234)", async () => {
    const { ctx } = setup()
    const told: string[] = []
    let reply = answer([{ age: 20, prs: 0 }])
    ctx.factory = async () => "acme/app"
    ctx.run = async (argv) => {
      if (argv[1] === "/repo/scripts/ops/notify.sh") told.push(argv[3]!)
      return { code: 0, err: "", out: argv[0] === "gh" ? reply : "" }
    }
    const agents = [
      { kind: "builder", name: "builder" },
      { branch: "PG-234-branch-no-pr", kind: "worker", name: "abcdef-worker", status: "working" },
    ]
    roster(ctx, agents)
    await prlessBranches(ctx, agents)
    reply = reply.replace("c0ffee0", "beef000")
    await prlessBranches(ctx, agents)
    await prlessBranches(ctx, agents)
    expect(told.map((line) => line.split(" ")[5])).toEqual(["c0ffee0", "beef000"])
  })

  test("stays quiet with a PR in any state, a head under 15 minutes, or a branch not on GitHub (#234)", async () => {
    expect((await sweep(answer([{ age: 30, prs: 1 }]))).told).toEqual([])
    expect((await sweep(answer([{ age: 14, prs: 0 }]))).told).toEqual([])
    expect((await sweep(answer([null]))).told).toEqual([])
  })

  test("reads no row holding a pr, as a merged one does, and none whose status is not live (#234)", async () => {
    const merged = await sweep(answer([{ age: 30, prs: 0 }]), [
      {
        branch: "PG-227-conventions-tighten",
        kind: "worker",
        name: "abcdef-worker",
        pr: "https://github.com/acme/app/pull/230",
        status: "working",
      },
    ])
    expect(merged.queries).toEqual([])
    expect(merged.told).toEqual([])
    expect(
      (
        await sweep(answer([{ age: 30, prs: 0 }]), [
          {
            branch: "PG-234-branch-no-pr",
            kind: "worker",
            name: "abcdef-worker",
            status: "waiting",
          },
        ])
      ).told,
    ).toHaveLength(1)
    for (const status of ["done", "ended", "merged", "parked"]) {
      const { queries, told } = await sweep(answer([{ age: 30, prs: 0 }]), [
        { branch: "PG-234-branch-no-pr", kind: "worker", name: "abcdef-worker", status },
      ])
      expect(told).toEqual([])
      expect(queries).toEqual([])
    }
  })

  test("reads every worker's PG branch in one GraphQL call, and no other branch (#234)", async () => {
    const { queries, told } = await sweep(
      answer([
        { age: 20, prs: 0 },
        { age: 40, prs: 0 },
      ]),
      [
        { branch: "PG-234-branch-no-pr", kind: "worker", name: "abcdef-worker", status: "working" },
        { branch: "pg-235-other", kind: "worker", name: "ghjkmn-worker", status: "working" },
        { branch: "fix-not-tracked", kind: "worker", name: "pqrstv-worker", status: "working" },
      ],
    )
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain('b0: ref(qualifiedName: "refs/heads/PG-234-branch-no-pr")')
    expect(queries[0]).toContain('b1: ref(qualifiedName: "refs/heads/pg-235-other")')
    expect(queries[0]).not.toContain("fix-not-tracked")
    expect(told.map((c) => c.argv[3]!.split(":")[0])).toEqual([
      "Branch PG-234-branch-no-pr (abcdef-worker)",
      "Branch pg-235-other (ghjkmn-worker)",
    ])
  })

  test("a GraphQL answer it cannot read is branch-check-unreadable (#234)", async () => {
    expect((await sweep("not json")).found).toEqual(["branch-check-unreadable"])
  })
})

describe("opsDown", () => {
  test("names a job whose script is not running, a failing beat, a stale one and an unreadable one, never a waiting one", async () => {
    const { ctx, ops } = setup({
      "ps -ax": { out: "" },
    })
    write(join(ops, "jobs.json"), { jobs: [{ disabled: true, name: "ops-off" }] })
    const at = (s: number) => new Date(NOW - s * 1000).toISOString()
    write(join(ops, "ops-fine.json"), {
      cycleSeconds: 60,
      job: "ops-fine",
      lastBeatAt: at(30),
      lastResult: "ok",
    })
    write(join(ops, "ops-bad.json"), {
      cycleSeconds: 60,
      job: "ops-bad",
      lastBeatAt: at(30),
      lastResult: "error",
    })
    write(join(ops, "ops-old.json"), {
      cycleSeconds: 60,
      job: "ops-old",
      lastBeatAt: at(181),
      lastResult: "ok",
    })
    write(join(ops, "ops-off.json"), {
      cycleSeconds: 60,
      job: "ops-off",
      lastBeatAt: at(9999),
      lastResult: "x",
    })
    write(join(ops, "ops-wait.json"), {
      cycleSeconds: 60,
      job: "ops-wait",
      lastBeatAt: at(30),
      lastResult: "waiting: nothing to read yet",
    })
    writeFileSync(join(ops, "ops-torn.json"), "{")
    expect((await opsDown(ctx)).sort()).toEqual([
      "ops-beat-unreadable:ops-torn.json",
      "ops-down:dashboard",
      "ops-failing:ops-bad",
      "ops-stale:ops-old",
    ])
  })

  test("reads the peer relay's all-up ok beat as healthy and its beat naming a down peer as failing, beside another job's ok (PG-2546)", async () => {
    const { ctx, ops } = setup({ "ps -ax": { out: "dashboard/supervisor.sh" } })
    const relay = (lastResult: string) =>
      write(join(ops, "ops-peer-relay.json"), {
        cycleSeconds: 60,
        job: "ops-peer-relay",
        lastBeatAt: new Date(NOW - 30_000).toISOString(),
        lastResult,
      })
    write(join(ops, "ops-fine.json"), {
      cycleSeconds: 60,
      job: "ops-fine",
      lastBeatAt: new Date(NOW - 30_000).toISOString(),
      lastResult: "ok",
    })
    relay("ok")
    expect(await opsDown(ctx)).toEqual([])
    relay(
      "spark-b: up: copying ops-peer.jsonl both ways with me@spark-b; spark-c: down: ssh exited 255; ssh starts again in 2s",
    )
    expect(await opsDown(ctx)).toEqual(["ops-failing:ops-peer-relay"])
  })

  test("treats a steady up:, waiting:, or idle: beat as healthy and a failed beat as failing (PG-2637)", async () => {
    const { ctx, ops } = setup({ "ps -ax": { out: "dashboard/supervisor.sh" } })
    const beat = (file: string, lastResult: string) =>
      write(join(ops, `${file}.json`), {
        cycleSeconds: 60,
        job: file,
        lastBeatAt: new Date(NOW - 30_000).toISOString(),
        lastResult,
      })
    beat("ops-tunnel", "up: 127.0.0.1:18000")
    expect(await opsDown(ctx)).toEqual([])
    beat("ops-tunnel", "waiting: nothing to read yet")
    expect(await opsDown(ctx)).toEqual([])
    beat("ops-peer-relay", "idle: PLAYGROUND_PEERS names no peer")
    expect(await opsDown(ctx)).toEqual([])
    beat("ops-tunnel", "failed: x")
    expect(await opsDown(ctx)).toEqual(["ops-failing:ops-tunnel"])
  })

  test("reads ops-tick's failing up: beat as failing, since up: is steady only for the tunnel (PG-2637)", async () => {
    const { ctx, ops } = setup({ "ps -ax": { out: "dashboard/supervisor.sh" } })
    const beat = (lastResult: string) =>
      write(join(ops, "ops-tick.json"), {
        cycleSeconds: 60,
        job: "ops-tick",
        lastBeatAt: new Date(NOW - 30_000).toISOString(),
        lastResult,
      })
    beat("up: spawn.sh exited 1")
    expect(await opsDown(ctx)).toEqual(["ops-failing:ops-tick"])
  })

  test.each([
    [
      "stale",
      (job: string) =>
        JSON.stringify({
          cycleSeconds: 60,
          job,
          lastBeatAt: new Date(NOW - 9999 * 1000).toISOString(),
          lastResult: "ok",
        }),
    ],
    ["torn", () => "{"],
  ])(
    "reads no %s beat file of a retired job, even with no jobs.json row for it (#2339)",
    async (_, body) => {
      const { ctx, ops } = setup({ "ps -ax": { out: "dashboard/supervisor.sh" } })
      write(join(ops, "jobs.json"), { jobs: [] })
      for (const job of RETIRED) writeFileSync(join(ops, `${job}.json`), body(job))
      expect(await opsDown(ctx)).toEqual([])
    },
  )
})

describe("forecast", () => {
  test("projects each window to its reset from the recent rate", async () => {
    const { ctx, sweep } = setup()
    const t = NOW / 1000
    const r5 = t + 7200
    const r7 = t + 86400
    write(join(ctx.data, "usage.json"), {
      rate_limits: {
        five_hour: { resets_at: r5, used_percentage: 50 },
        seven_day: { resets_at: r7, used_percentage: 40 },
      },
    })
    writeFileSync(
      join(sweep, "usage-samples.jsonl"),
      `${JSON.stringify({ f5: 40, r5, r7, s7: 39, t: t - 3600 })}\n`,
    )
    expect(await forecast(ctx)).toEqual({ "5h": 70, "7d": 64 })
  })

  test("a window with no reset is left out", async () => {
    const { ctx } = setup()
    write(join(ctx.data, "usage.json"), {
      rate_limits: {
        five_hour: { resets_at: null, used_percentage: 0 },
        seven_day: { resets_at: NOW / 1000 + 86400, used_percentage: 40 },
      },
    })
    expect(await forecast(ctx)).toEqual({})
  })

  test("an account with no 5-hour window still has its week projected", async () => {
    const { ctx, sweep } = setup()
    const t = NOW / 1000
    const r7 = t + 86400
    write(join(ctx.data, "usage.json"), {
      rate_limits: { seven_day: { resets_at: r7, used_percentage: 40 } },
    })
    writeFileSync(
      join(sweep, "usage-samples.jsonl"),
      `${JSON.stringify({ r7, s7: 39, t: t - 3600 })}\n`,
    )
    expect(await forecast(ctx)).toEqual({ "7d": 64 })
  })
})

describe("pace off", () => {
  const T = NOW / 1000
  const A = "one@example.com"
  const B = "two@example.com"
  // week-marks.py's samples of one account, `before`% 3 hours back and `now`% now, its week resetting `reset` seconds on; the other accounts' go to account-samples.jsonl.
  const week = (ctx: Context, account: string, before: number, now: number, reset: number) =>
    writeFileSync(
      join(ctx.ops, "usage", account === A ? "week-samples.jsonl" : "account-samples.jsonl"),
      [before, now]
        .map(
          (w, i) =>
            `${JSON.stringify({ account, reset: T + reset, t: T - 10800 + i * 10800, week: w })}\n`,
        )
        .join(""),
    )
  // login-flip.py's split of new sessions, written now.
  const split = (ctx: Context, shares: Record<string, number>) =>
    write(join(ctx.ops, "usage", "login-flip.json"), { split: { at: T, shares } })
  const machine = () => {
    const made = setup()
    roster(made.ctx, [])
    mkdirSync(join(made.ops, "usage"), { recursive: true })
    storeWith(made.ctx.data, {}, { "usage.accounts": [{ email: A, label: "main" }, { email: B }] })
    split(made.ctx, { [A]: 1, [B]: 0 })
    return made
  }
  const paceFile = (ctx: Context) => join(ctx.data, "usage-pace-off-until")
  const text = (path: string) => readFileSync(path, "utf8").trim()

  test("a week forecast under 100% at its reset turns the pace off for an hour and records the forecast by label", async () => {
    const { ctx, sweep } = machine()
    week(ctx, A, 39, 40, 86400)
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-20T13:00:00Z")
    expect(read(join(sweep, "pace-off.json"))).toEqual({
      at: "2026-10-20T12:00:00Z",
      forecast: { main: 48 },
      until: "2026-10-20T13:00:00Z",
    })
  })

  test("the pace-off time is never later than the week's reset", async () => {
    const { ctx } = machine()
    week(ctx, A, 39, 40, 1800)
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-20T12:30:00Z")
  })

  test("a week forecast at 100% or more writes nothing and removes the time the sweep wrote", async () => {
    const { ctx, sweep } = machine()
    week(ctx, A, 80, 90, 86400)
    await check(ctx)
    expect(await Bun.file(paceFile(ctx)).exists()).toBe(false)
    writeFileSync(paceFile(ctx), "2026-10-20T12:55:00Z\n")
    write(join(sweep, "pace-off.json"), { until: "2026-10-20T12:55:00Z" })
    await check(ctx)
    expect(await Bun.file(paceFile(ctx)).exists()).toBe(false)
    expect(read(join(sweep, "pace-off.json"))).toEqual({
      at: "2026-10-20T12:00:00Z",
      forecast: { main: 170 },
      until: null,
    })
  })

  test("headroom on an account the split gives no share to turns nothing off, and on one it picks does", async () => {
    const { ctx, sweep } = machine()
    week(ctx, A, 80, 90, 86400)
    week(ctx, B, 39, 40, 86400)
    await check(ctx)
    expect(await Bun.file(paceFile(ctx)).exists()).toBe(false)
    split(ctx, { [A]: 0.5, [B]: 0.5 })
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-20T13:00:00Z")
    expect(read(join(sweep, "pace-off.json")).forecast).toEqual({ "account 2": 48, main: 170 })
  })

  test("the pace runs from the move onto the account, so idle hours before it never read as room", async () => {
    const { ctx, sweep } = machine()
    const row = (account: string, t: number, week: number) =>
      `${JSON.stringify({ account, reset: T + 14400, t: T - t, week })}\n`
    writeFileSync(join(ctx.ops, "usage", "account-samples.jsonl"), row(A, 10800, 50))
    writeFileSync(
      join(ctx.ops, "usage", "week-samples.jsonl"),
      row(B, 7201, 20) + row(A, 7200, 50) + row(A, 0, 70),
    )
    await check(ctx)
    expect(await Bun.file(paceFile(ctx)).exists()).toBe(false)
    expect(read(join(sweep, "pace-off.json")).forecast).toEqual({})
  })

  test("readings that span under 3 hours forecast nothing, so the pace stays on", async () => {
    const { ctx, sweep } = machine()
    writeFileSync(
      join(ctx.ops, "usage", "week-samples.jsonl"),
      [39, 40]
        .map(
          (w, i) =>
            `${JSON.stringify({ account: A, reset: T + 86400, t: T - 3600 + i * 3600, week: w })}\n`,
        )
        .join(""),
    )
    await check(ctx)
    expect(await Bun.file(paceFile(ctx)).exists()).toBe(false)
    expect(read(join(sweep, "pace-off.json")).forecast).toEqual({})
  })

  test("with no fresh split, usage.json's account is the one forecast", async () => {
    const { ctx } = machine()
    write(join(ctx.ops, "usage", "login-flip.json"), {
      split: { at: T - 3600, shares: { [B]: 1 } },
    })
    write(join(ctx.data, "usage.json"), { account: A })
    week(ctx, A, 39, 40, 86400)
    week(ctx, B, 80, 90, 86400)
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-20T13:00:00Z")
  })

  test("a future time written by hand is left as it is, headroom or none", async () => {
    const { ctx } = machine()
    writeFileSync(paceFile(ctx), "2026-10-22T09:00:00+05:30\n")
    week(ctx, A, 39, 40, 86400)
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-22T09:00:00+05:30")
    week(ctx, A, 80, 90, 86400)
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-22T09:00:00+05:30")
  })

  test("a past time written by hand no longer holds the file", async () => {
    const { ctx } = machine()
    writeFileSync(paceFile(ctx), "2026-10-19T09:00:00Z\n")
    week(ctx, A, 39, 40, 86400)
    await check(ctx)
    expect(text(paceFile(ctx))).toBe("2026-10-20T13:00:00Z")
  })
})

describe("pass", () => {
  test("tells ops only a new finding, again once it clears and comes back, never a known one", async () => {
    const replies: Record<string, { code?: number; out?: string }> = {
      [DASHBOARD_DB]: { out: "playground-dispatcher-db\n" },
    }
    const { calls, ctx, sweep } = setup(replies)
    roster(ctx, [{ name: "runner-gone", status: "working" }])
    const told = () =>
      calls.filter((c) => c.argv[1] === "/repo/scripts/ops/notify.sh").map((c) => c.argv[3])
    const known = new Set(["no-headroom"])
    let { active, result } = await pass(ctx, new Set(known), known)
    expect(result).toBe("ok")
    expect(told()).toEqual(["down:runner-gone"])
    ;({ active } = await pass(ctx, active, known))
    expect(told()).toHaveLength(1)
    roster(ctx, [])
    ;({ active } = await pass(ctx, active, known))
    roster(ctx, [{ name: "runner-gone", status: "working" }])
    await pass(ctx, active, known)
    expect(told()).toEqual(["down:runner-gone", "down:runner-gone"])
    expect(readFileSync(join(sweep, "sweep.log"), "utf8")).toContain("Z down:runner-gone\n")
    const up = calls.find((c) => c.argv[2] === "/main/scripts/ops/up.py")!
    expect(up.env?.OPS_UP_SKIP).toBe("ops-sweep")
  })
})

describe("maybePrune", () => {
  test("prunes once in 6 hours when quiet, and logs what it freed or that it could not run", async () => {
    const { calls, ctx, ops, sweep } = setup({
      "docker builder prune": { code: 127 },
      "docker volume prune": { out: "Total reclaimed space: 1.5GB\n" },
    })
    await maybePrune(ctx)
    expect(calls.map((c) => c.argv.slice(0, 3).join(" "))).toContain("docker volume prune")
    expect(read(join(sweep, "prune-state.json"))).toEqual({ at: NOW / 1000 })
    expect(readFileSync(join(ops, "ops-log.md"), "utf8")).toContain(
      "`volume prune -f` freed 1.5GB; `builder prune -f --filter until=24h` failed (exit 127)",
    )
    calls.length = 0
    await maybePrune(ctx)
    expect(calls).toHaveLength(0)
  })

  test("waits while a container sits in Created, or the dashboard rolled in the last 5 minutes", async () => {
    const busy = setup({ "docker ps -a": { out: "abc\n" } })
    await maybePrune(busy.ctx)
    expect(busy.calls.some((c) => c.argv[1] === "volume")).toBe(false)
    const rolled = setup()
    mkdirSync(join(rolled.ops, "dashboard"))
    writeFileSync(
      join(rolled.ops, "dashboard", "supervisor.log"),
      `${new Date(NOW - 60_000).toISOString().slice(0, 19)}Z canary moved\n`,
    )
    await maybePrune(rolled.ctx)
    expect(rolled.calls).toHaveLength(0)
    const onMain = setup()
    mkdirSync(join(onMain.ops, "dashboard"))
    writeFileSync(
      join(onMain.ops, "dashboard", "supervisor.log"),
      `${new Date(NOW - 60_000).toISOString().slice(0, 19)}Z main moved: abc1234 -> def5678\n`,
    )
    await maybePrune(onMain.ctx)
    expect(onMain.calls).toHaveLength(0)
  })
})
