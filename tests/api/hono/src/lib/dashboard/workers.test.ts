import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registryOf } from "../../../../../../api/hono/src/lib/dashboard/peers"
import { NO_FACTS, type Pickers } from "../../../../../../api/hono/src/lib/dashboard/transcript"
import {
  answeredSince,
  DISPATCHER,
  DISPATCHER_SECONDARY,
  DISPATCHERS,
  composeWorkers,
  dispatcherSlots,
  feedItemOf,
  herdrFeed,
  isLiveRecord,
  isProbe,
  kindOf,
  lightOf,
  liveRecords,
  type LiveProof,
  nameOf,
  readDispatcherSlots,
  roleOf,
  rosterFacts,
  rosterRoleOf,
  secondaryOf,
} from "../../../../../../api/hono/src/lib/dashboard/workers"
import { setSessionNames } from "../../../../../../packages/config/src/kinds"
import { inFixture, onLiveDashboard } from "../../../../../dashboard-fixture"
import { capital, OLD, SEEDED_NAMES } from "../../../../../session-names"
import { slowChild } from "../../../../../slow-child"
import {
  permissionItem,
  planItem,
  questionItem,
  QUESTION_ID,
  TWO_QUESTION_ID,
  twoQuestionItem,
} from "./feed-fixtures"

// workers.ts sets the names its data folder holds when it loads; the cases name the managers' old names, as a machine past the switch does.
setSessionNames(SEEDED_NAMES)

// A raw session list with every record taken at its word, as listLive hands it on when it has no registry to read.
const fromRecords = (
  sessions: unknown,
  ...rest: Parameters<typeof composeWorkers> extends [unknown, ...infer R] ? R : never
) => composeWorkers(liveRecords(sessions, null), ...rest)

const session = (over: Record<string, unknown>) => ({
  agent: "claude",
  agent_lifecycle: "running",
  cwd: "/repo",
  launch_arguments: ["/bin/claude", "-n", "greed"],
  launch_backed: true,
  session_id: "s-greed",
  started_at: "2026-10-06T09:00:00.000Z",
  stored_pid_exists: true,
  surface_id: "MADESURF-1",
  transcript_path: "/t/s-greed.jsonl",
  updated_at: "2026-10-06T10:00:00.000Z",
  workspace_id: "W1",
  ...over,
})

const workspaces = {
  workspaces: [
    { id: "W1", ref: "workspace:40", custom_title: "greed" },
    { id: "W5", ref: "workspace:5", custom_title: DISPATCHER },
  ],
}

describe("nameOf", () => {
  test("reads -n, --name and --name=", () => {
    expect(nameOf(["claude", "-n", "pride"])).toBe("pride")
    expect(nameOf(["claude", "--name", "envy"])).toBe("envy")
    expect(nameOf(["claude", "--name=wrath"])).toBe("wrath")
    expect(nameOf(["claude"])).toBe("")
    expect(nameOf(undefined)).toBe("")
  })
})

// herdr has no Feed, so a blocked herdr session's card is the open call that raised its prompt
describe("herdrFeed", () => {
  const at = "2026-10-18T12:00:00.000Z"
  const call = (id: string, name: string, input: unknown) => ({ at, id, input, name })
  const calls = [
    call("toolu_plan", "ExitPlanMode", { plan: "# Plan\n\nShip it." }),
    call("toolu_write", "Write", { content: "x", file_path: "/tmp/a" }),
    call("toolu_ask", "AskUserQuestion", { questions: [{ question: "Go?", options: [] }] }),
    call("toolu_bash", "Bash", { command: "ls -la" }),
  ]
  const wait = (
    reason: string | null,
    tool: string | null = null,
    agentId: string | null = null,
  ) => ({
    agentId,
    reason,
    tool,
  })

  test("with no stuck record, the newest open call is the prompt", () => {
    expect(herdrFeed(calls, null)).toEqual([
      expect.objectContaining({
        detail: "ls -la",
        kind: "permission",
        requestId: "toolu_bash",
        tool: "Bash",
        whole: true,
      }),
    ])
    expect(herdrFeed(calls.slice(0, 3), wait(null))).toEqual([
      {
        at,
        kind: "question",
        questions: [{ header: null, multiSelect: false, options: [], prompt: "Go?" }],
        requestId: "toolu_ask",
      },
    ])
  })

  test("the stuck record's kind and tool pick the call, past newer ones", () => {
    expect(herdrFeed(calls, wait("plan"))).toEqual([
      {
        at,
        clipped: false,
        kind: "plan",
        plan: "# Plan\n\nShip it.",
        requestId: "toolu_plan",
        whole: true,
      },
    ])
    expect(herdrFeed(calls, wait("question"))[0]?.requestId).toBe("toolu_ask")
    expect(herdrFeed(calls, wait("permission", "Write"))[0]).toMatchObject({
      detail: "/tmp/a",
      tool: "Write",
    })
    // a permission with no tool named is the newest call that is not a picker or a plan
    expect(herdrFeed(calls.slice(0, 3), wait("permission"))[0]?.requestId).toBe("toolu_write")
  })

  test("a subagent's prompt, an elicitation, a login or a call that is not there gets no card", () => {
    expect(herdrFeed(calls, wait("permission", "Bash", "agent-1"))).toEqual([])
    expect(herdrFeed(calls, wait("elicitation"))).toEqual([])
    expect(herdrFeed(calls, wait("login"))).toEqual([])
    expect(herdrFeed(calls, wait("permission", "Edit"))).toEqual([])
    expect(herdrFeed([], null)).toEqual([])
  })
})

describe("lightOf", () => {
  test("a waiting picker or a needsInput session needs you; running works; anything else is idle", () => {
    expect(lightOf("running", [{ multiSelect: false, options: [], prompt: "?" }])).toBe("needs-you")
    expect(lightOf("needsInput", [])).toBe("needs-you")
    expect(lightOf("running", [])).toBe("working")
    expect(lightOf("idle", [])).toBe("idle")
    const permission = feedItemOf(permissionItem())
    expect(lightOf("running", [], permission ? [permission] : [])).toBe("needs-you")
  })
})

describe("a Codex session's light", () => {
  // It writes no state record (its hooks.json leaves session-state out), so a light that would read idle is unknown.
  test("reads unknown where it would read idle, and herdr's working and waiting as they are", () => {
    const light = (agent: string, lifecycle: string) =>
      fromRecords(
        { sessions: [session({ agent, agent_lifecycle: lifecycle })] },
        workspaces,
        new Map(),
        new Map(),
      ).workers[0]?.light
    expect(light("codex", "idle")).toBe("unknown")
    expect(light("codex", "unknown")).toBe("unknown")
    expect(light("codex", "running")).toBe("working")
    expect(light("codex", "needsInput")).toBe("needs-you")
    expect(light("claude", "idle")).toBe("idle")
    expect(light("claude", "unknown")).toBe("idle")
  })
})

describe("DISPATCHER", () => {
  test("is the dispatcher role word unless PLAYGROUND_DISPATCHER names a test stack's throwaway session", () => {
    expect(DISPATCHER).toBe(process.env.PLAYGROUND_DISPATCHER || "dispatcher")
  })
})

describe("DISPATCHERS", () => {
  test("the dispatcher role's names, the primary first: PLAYGROUND_DISPATCHER, then PLAYGROUND_DISPATCHER_SECONDARY (the primary's name plus -2 by default)", () => {
    expect(DISPATCHER_SECONDARY).toBe(
      process.env.PLAYGROUND_DISPATCHER_SECONDARY ||
        `${process.env.PLAYGROUND_DISPATCHER || "dispatcher"}-2`,
    )
    expect(DISPATCHERS).toEqual([DISPATCHER, DISPATCHER_SECONDARY])
  })

  // A live-reads test stack that sets only PLAYGROUND_DISPATCHER=probe-x must never give the real OLD.dispatcher-2 the role, or its composer types into it (reviewer-tidy-relay).
  test(`an unset secondary follows the primary, so a test stack's probe never reaches the real ${OLD.dispatcher}-2`, () => {
    expect(secondaryOf(OLD.dispatcher)).toBe(`${OLD.dispatcher}-2`)
    expect(secondaryOf("probe-x")).toBe("probe-x-2")
    expect(secondaryOf("probe-x", "probe-y")).toBe("probe-y")
  })

  // verify cls: the sidebar dropped 32px when the second dispatcher's row arrived under a one-row placeholder, so /api/health names how many dispatcher rows the header draws
  test("the header's dispatcher slot count: the primary's always, each other one's while a session of its name is registered or the roster lists it", () => {
    expect(dispatcherSlots([OLD.dispatcher, `${OLD.dispatcher}-2`], new Set())).toBe(1)
    expect(
      dispatcherSlots([OLD.dispatcher, `${OLD.dispatcher}-2`], new Set([`${OLD.dispatcher}-2`])),
    ).toBe(2)
    expect(
      dispatcherSlots([OLD.dispatcher, `${OLD.dispatcher}-2`], new Set([OLD.dispatcher])),
    ).toBe(1)
    expect(dispatcherSlots([OLD.dispatcher], new Set([`${OLD.dispatcher}-2`]))).toBe(1)
  })

  // A second dispatcher the roster marks done or ended counts no row, while a parked or working one still does (#850).
  test.each([
    ["ended", 1],
    ["done", 1],
    ["parked", 2],
    ["working", 2],
  ])(
    "a roster whose second dispatcher reads %s counts %i dispatcher rows",
    async (status, rows) => {
      const dir = mkdtempSync(join(tmpdir(), "dispatcher-slots-"))
      // a live-reads process, whose data folder is PLAYGROUND_DATA_DIR, reading the roster alone (no opt-in to Claude's registry)
      const set: Record<string, string> = {
        CLAUDE_CONFIG_DIR: join(dir, "config"),
        PLAYGROUND_ALL_SESSIONS: "",
        PLAYGROUND_DATA_DIR: join(dir, "data"),
        PLAYGROUND_LIVE_READS: "1",
      }
      const saved = Object.keys(set).map((key) => [key, process.env[key]] as const)
      Object.assign(process.env, set)
      mkdirSync(set.PLAYGROUND_DATA_DIR!, { recursive: true })
      const agent = (name: string, status: string) => ({
        name,
        role: "manager",
        status,
        task: "Dispatch",
      })
      writeFileSync(
        join(set.PLAYGROUND_DATA_DIR!, "roster.json"),
        JSON.stringify({
          agents: [agent(DISPATCHER, "working"), agent(DISPATCHER_SECONDARY, status)],
          updatedAt: "2026-11-04T14:00:00Z",
        }),
      )
      try {
        expect(await readDispatcherSlots()).toBe(rows)
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(dir, { force: true, recursive: true })
      }
    },
  )

  test("both names take the dispatcher role, whatever the roster calls them", () => {
    for (const name of DISPATCHERS) {
      expect(roleOf(name)).toBe("dispatcher")
      expect(roleOf(name, { role: "manager" })).toBe("dispatcher")
    }
  })
})

describe("roleOf", () => {
  test(`${OLD.planner}, ${OLD.builder}, ${OLD.ops} and optimizer are managers by name, and so is anyone the roster calls a manager`, () => {
    expect(roleOf(OLD.planner)).toBe("manager")
    expect(roleOf(OLD.builder)).toBe("manager")
    expect(roleOf(OLD.ops)).toBe("manager")
    expect(roleOf("optimizer")).toBe("manager")
    expect(roleOf("worker-sloth", { role: "manager" })).toBe("manager")
    expect(roleOf(OLD.builder, { role: "worker" })).toBe("manager")
    expect(roleOf("worker-sloth", { role: "worker" })).toBe("worker")
    // the roster's manager role outranks the runner- prefix
    expect(roleOf("runner-pride", { role: "manager" })).toBe("manager")
    expect(roleOf("runner-pride", { role: "runner" })).toBe("runner")
    expect(roleOf(capital(OLD.builder))).toBe("other")
  })

  test("an <id>-<kind> manager is a manager by its name alone, and an ops job is not (PG-1644)", () => {
    for (const [name, kind] of [
      ["x7mh4d-builder", "builder"],
      ["k3v9q2-ops", "ops"],
      ["q8r2tx-planner", "planner"],
      ["p2c4fj-optimizer", "optimizer"],
    ] as const)
      expect([roleOf(name), kindOf(name)]).toEqual(["manager", kind])
    expect(roleOf("ops-dashboard")).toBe("other")
    expect(roleOf("ops-localci")).toBe("other")
    expect(kindOf("ops-dashboard")).toBeNull()
  })

  test("the roster's runner role outranks a worker- or other name, but not a manager's or the dispatcher's", () => {
    expect(roleOf("linear-auto", { role: "runner" })).toBe("runner")
    expect(roleOf("worker-envy", { role: "runner" })).toBe("runner")
    expect(roleOf(OLD.builder, { role: "runner" })).toBe("manager")
    expect(roleOf(DISPATCHER, { role: "runner" })).toBe("dispatcher")
  })

  test("a kindless <id>-<kind> name takes its role from its last word, as an old name does from its prefix (#966)", () => {
    expect(roleOf("b7k2mq-reviewer")).toBe("worker")
    expect(roleOf("k3m9px-tester")).toBe("worker")
    expect(roleOf("k3m9px-worker")).toBe("worker")
    expect(roleOf("k3m9px-runner")).toBe("runner")
    expect(roleOf("x7mh4d-builder")).toBe("manager")
    expect(roleOf("k3m9px-probe", { role: "worker" })).toBe("other")
    // the roster's manager or runner role still outranks it
    expect(roleOf("b7k2mq-reviewer", { role: "runner" })).toBe("runner")
    expect(roleOf("k3m9px-wizard")).toBe("other")
    expect(roleOf("k3m9px-wizard", { role: "worker" })).toBe("worker")
  })

  test(`${OLD.dispatcher} stays the dispatcher though the roster calls it a manager`, () => {
    expect(roleOf(DISPATCHER, { role: "manager" })).toBe("dispatcher")
  })

  const SINS = ["envy", "gluttony", "greed", "lust", "pride", "sloth", "wrath"]

  test(`${OLD.dispatcher} is the dispatcher, runner-<sin> is a runner and worker-<sin> is a worker`, () => {
    expect(roleOf(DISPATCHER)).toBe("dispatcher")
    for (const sin of SINS) {
      expect(roleOf(`runner-${sin}`)).toBe("runner")
      expect(roleOf(`worker-${sin}`)).toBe("worker")
    }
  })

  test("a session's kind is the roster's first (#966), else what its name gives, else none", () => {
    expect(kindOf("b7k2mq-reviewer", { kind: "reviewer", role: "worker" })).toBe("reviewer")
    expect(kindOf("worker-greed", { kind: "researcher", role: "worker" })).toBe("researcher")
    expect(kindOf(DISPATCHER)).toBe("dispatcher")
    expect(kindOf(OLD.builder)).toBe("builder")
    expect(kindOf(OLD.ops)).toBe("ops")
    expect(kindOf(OLD.planner)).toBe("planner")
    expect(kindOf("reviewer-envy")).toBe("reviewer")
    expect(kindOf("worker-greed", { role: "worker" })).toBe("worker")
    // an <id>-<kind> name with no roster entry reads its last word, as the web's checkerOf does
    expect(kindOf("b7k2mq-reviewer")).toBe("reviewer")
    expect(kindOf("scratch-demo")).toBeNull()
  })

  test("reviewer-<sin> and tester-<sin> are workers, suffix and all, and the roster's worker role makes one of any name", () => {
    expect(roleOf("reviewer-envy")).toBe("worker")
    expect(roleOf("tester-gluttony-97")).toBe("worker")
    expect(roleOf("linear-check", { role: "worker" })).toBe("worker")
  })

  // a session's kind, written at spawn, places it whatever its name, so a name need not carry its role.
  test("the roster's kind places a session first, a name that carries no role included", () => {
    expect(roleOf("k3v9q2-reviewer", { kind: "reviewer", role: "worker" })).toBe("worker")
    expect(roleOf("k3v9q2-tester", { kind: "tester", role: "worker" })).toBe("worker")
    expect(roleOf("k3v9q2-researcher", { kind: "researcher", role: "worker" })).toBe("worker")
    expect(roleOf("k3v9q2-runner", { kind: "runner", role: "worker" })).toBe("runner")
    expect(roleOf("x7mh4d-builder", { kind: "builder", role: "worker" })).toBe("manager")
    expect(roleOf("x7mh4d-ops", { kind: "ops", role: "manager" })).toBe("manager")
    expect(roleOf("k3v9q2-probe", { kind: "probe", role: "worker" })).toBe("other")
    // the kind outranks the name's prefix, and the dispatchers and probes keep their own rules
    expect(roleOf("worker-envy", { kind: "runner", role: "worker" })).toBe("runner")
    expect(roleOf(DISPATCHER, { kind: "worker", role: "worker" })).toBe("dispatcher")
    expect(roleOf("probe-history", { kind: "worker", role: "worker" })).toBe("other")
    // with no kind, the kind its name gives places it, and a name that gives none reads by its role
    expect(roleOf("k3v9q2-reviewer")).toBe("worker")
    expect(roleOf("k3v9q2-wizard", { role: "worker" })).toBe("worker")
  })

  test("any other name is other, the old -runner suffix and a bare runner-, worker- or probe- included", () => {
    for (const name of [
      "wrath",
      "dashboard-runner",
      "runner",
      "runner-",
      "worker-",
      "probe-",
      "Runner-pride",
      "session 1a2b3c4d",
    ]) {
      expect(roleOf(name)).toBe("other")
    }
  })
})

describe("probes", () => {
  test("a probe is other whatever the roster says, and never waits on Merritt", () => {
    expect(roleOf("probe-history")).toBe("other")
    expect(roleOf("probe-history", { role: "worker" })).toBe("other")
    expect(roleOf("probe-history", { role: "manager" })).toBe("other")
    expect(isProbe("probe-history")).toBe(true)
    expect(isProbe("probe-")).toBe(false)
    expect(isProbe("k3m9px-probe")).toBe(true)
    expect(isProbe("k3m9px-worker")).toBe(false)
  })
})

describe("rosterRoleOf", () => {
  const roles = new Map([
    ["linear-auto", { role: "runner" }],
    ["runner-pride", { role: "runner" }],
    ["worker-greed", { kind: "worker", role: "worker" }],
  ] as const)

  test("the roster's kind and role for a session's name, or for its bare sin by the role-prefixed name", () => {
    expect(rosterRoleOf(roles, "linear-auto")).toEqual({ role: "runner" })
    expect(rosterRoleOf(roles, "greed")).toEqual({ kind: "worker", role: "worker" })
    expect(rosterRoleOf(roles, "pride")).toEqual({ role: "runner" })
    expect(rosterRoleOf(roles, "wrath")).toBeUndefined()
  })
})

describe("composeWorkers", () => {
  test("the two dispatchers both keep the role, the primary first on the board", () => {
    const second = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER_SECONDARY],
      session_id: "s-glm",
      started_at: "2026-10-06T08:00:00.000Z",
      surface_id: "MADESURF-1",
    })
    const first = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-opus",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-2",
    })
    const { workers } = fromRecords({ sessions: [second, first] }, workspaces, new Map(), new Map())
    expect(workers.filter((w) => w.role === "dispatcher").map((w) => w.sessionId)).toEqual([
      "s-opus",
      "s-glm",
    ])
  })

  test("of two live sessions named for the second dispatcher, its oldest keeps the role, and the primary keeps its own", () => {
    const sessions = [
      { id: "s-glm-new", name: DISPATCHER_SECONDARY, at: "2026-10-06T10:00:00.000Z" },
      { id: "s-glm-old", name: DISPATCHER_SECONDARY, at: "2026-10-06T08:00:00.000Z" },
      { id: "s-opus", name: DISPATCHER, at: "2026-10-06T09:00:00.000Z" },
    ].map(({ at, id, name }, i) =>
      session({
        launch_arguments: ["/bin/claude", "-n", name],
        session_id: id,
        started_at: at,
        surface_id: `MADESURF-${i + 1}`,
      }),
    )
    const { workers } = fromRecords({ sessions }, workspaces, new Map(), new Map())
    const roles = Object.fromEntries(workers.map((w) => [w.sessionId, w.role]))
    expect(roles).toEqual({
      "s-glm-new": "other",
      "s-glm-old": "dispatcher",
      "s-opus": "dispatcher",
    })
  })

  test("of two live sessions named for the dispatcher, the oldest by startedAt keeps the role and the later reads as other", () => {
    const older = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-old",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-1",
    })
    const newer = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-new",
      started_at: "2026-10-06T10:00:00.000Z",
      surface_id: "MADESURF-2",
    })
    const { workers } = fromRecords({ sessions: [newer, older] }, workspaces, new Map(), new Map())
    const named = workers.filter((w) => w.name === DISPATCHER)
    expect(named).toHaveLength(2)
    expect(named.find((w) => w.role === "dispatcher")?.sessionId).toBe("s-old")
    expect(named.find((w) => w.role === "other")?.sessionId).toBe("s-new")
  })

  test("a tie on startedAt keeps the session whose id sorts first, whatever the array order", () => {
    const later = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-b",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-1",
    })
    const earlier = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-a",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-2",
    })
    const { workers } = fromRecords(
      { sessions: [later, earlier] },
      workspaces,
      new Map(),
      new Map(),
    )
    const named = workers.filter((w) => w.name === DISPATCHER)
    expect(named.find((w) => w.role === "dispatcher")?.sessionId).toBe("s-a")
    expect(named.find((w) => w.role === "other")?.sessionId).toBe("s-b")
  })

  test("a startedAt that does not parse never keeps the role over one that does", () => {
    const garbage = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-garbage",
      started_at: "not a time",
      surface_id: "MADESURF-1",
    })
    const real = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-real",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-2",
    })
    const { workers } = fromRecords({ sessions: [garbage, real] }, workspaces, new Map(), new Map())
    const named = workers.filter((w) => w.name === DISPATCHER)
    expect(named.find((w) => w.role === "dispatcher")?.sessionId).toBe("s-real")
  })

  test("after the demotion the dispatcher leads the board's order", () => {
    const demoted = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-new",
      started_at: "2026-10-06T10:00:00.000Z",
      surface_id: "MADESURF-1",
    })
    const keeper = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-old",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-2",
    })
    const { workers } = fromRecords(
      { sessions: [demoted, keeper] },
      workspaces,
      new Map(),
      new Map(),
    )
    expect(workers.find((w) => w.name === DISPATCHER)?.role).toBe("dispatcher")
  })

  test("the session demoted to other shows its own first ask, as any other does, while the keeper still shows none", () => {
    const keeper = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-old",
      started_at: "2026-10-06T09:00:00.000Z",
      surface_id: "MADESURF-1",
    })
    const demoted = session({
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-new",
      started_at: "2026-10-06T10:00:00.000Z",
      surface_id: "MADESURF-2",
    })
    const tasks = new Map([
      ["s-old", "Run the dashboard"],
      ["s-new", "Look at the dashboard"],
    ])
    const { workers } = fromRecords({ sessions: [demoted, keeper] }, workspaces, tasks)
    const bySession = new Map(workers.map((w) => [w.sessionId, w]))
    expect(bySession.get("s-new")).toMatchObject({ role: "other", task: "Look at the dashboard" })
    expect(bySession.get("s-old")).toMatchObject({ role: "dispatcher", task: null })
  })

  test("a probe at a picker reads idle; the dispatcher at one still needs you", () => {
    const probe = session({
      agent_lifecycle: "needsInput",
      launch_arguments: ["/bin/claude", "-n", "probe-history"],
      session_id: "s-probe",
      surface_id: "MADESURF-P",
    })
    const dispatcher = session({
      agent_lifecycle: "needsInput",
      launch_arguments: ["/bin/claude", "-n", DISPATCHER],
      session_id: "s-boss",
      surface_id: "MADESURF-D",
      workspace_id: "W5",
    })
    const { workers } = fromRecords({ sessions: [probe, dispatcher] }, workspaces, new Map())
    const by = new Map(workers.map((w) => [w.sessionId, w]))
    expect(by.get("s-probe")).toMatchObject({ light: "idle", role: "other" })
    expect(by.get("s-boss")).toMatchObject({ light: "needs-you", role: "dispatcher" })
  })

  test("one row per live session of a harness; dead sessions and another agent's are left out", () => {
    const sessions = {
      sessions: [
        session({}),
        session({ session_id: "dead", stored_pid_exists: false }),
        session({ session_id: "gemini", agent: "gemini" }),
      ],
    }
    const { workers } = fromRecords(sessions, workspaces, new Map())
    expect(workers.map((w) => w.sessionId)).toEqual(["s-greed"])
  })

  test("a row carries its name, workspace, light and task, and maps its transcript and surface", () => {
    const sessions = { sessions: [session({})] }
    const live = fromRecords(sessions, workspaces, new Map([["s-greed", "Pick lunch"]]))
    expect(live.workers[0]).toMatchObject({
      light: "working",
      name: "greed",
      role: "other",
      task: "Pick lunch",
      title: null,
      workspace: { ref: "workspace:40", title: "greed" },
    })
    expect(live.transcripts.get("s-greed")).toBe("/t/s-greed.jsonl")
    expect(live.surfaces.get("s-greed")).toBe("MADESURF-1")
  })

  // The dispatcher is OLD.dispatcher unless a test stack's PLAYGROUND_DISPATCHER renames it, so the fixture takes whichever name this run has.
  test(`${OLD.dispatcher} is the dispatcher: listed first, with no task, whatever its first ask was`, () => {
    const sessions = {
      sessions: [
        session({}),
        session({
          session_id: `s-${OLD.dispatcher}`,
          launch_arguments: ["/bin/claude"],
          workspace_id: "W5",
          agent_lifecycle: "idle",
        }),
      ],
    }
    const { workers } = fromRecords(
      sessions,
      workspaces,
      new Map([[`s-${OLD.dispatcher}`, "I don't want this 80/20 rule"]]),
    )
    expect(workers.map((w) => [w.name, w.role, w.task])).toEqual([
      [DISPATCHER, "dispatcher", null],
      ["greed", "other", null],
    ])
  })

  test("a session named runner-<sin> is a runner and keeps its task, in the board's usual order", () => {
    const sessions = {
      sessions: [
        session({}),
        session({
          session_id: "s-runner-pride",
          launch_arguments: ["/bin/claude", "-n", "runner-pride"],
          agent_lifecycle: "idle",
        }),
      ],
    }
    const { workers } = fromRecords(
      sessions,
      workspaces,
      new Map([["s-runner-pride", "Keep the dashboard on the newest canary"]]),
    )
    expect(workers.map((w) => [w.name, w.role, w.task])).toEqual([
      ["greed", "other", null],
      ["runner-pride", "runner", "Keep the dashboard on the newest canary"],
    ])
  })

  test("a session's live /rename name leads, whatever it was launched as or its workspace is titled", () => {
    const sessions = {
      sessions: [
        session({}),
        session({
          session_id: "s-dashboard",
          launch_arguments: ["/bin/claude", "-n", "dashboard-runner"],
          workspace_id: "W50",
          surface_id: "MADESURF-50",
        }),
      ],
    }
    const titled = {
      workspaces: [
        ...workspaces.workspaces,
        { id: "W50", ref: "workspace:50", custom_title: "something-else" },
      ],
    }
    const live = new Map([
      ["s-greed", "worker-greed"],
      ["s-dashboard", "runner-pride"],
    ])
    const { workers } = fromRecords(sessions, titled, new Map(), live)
    expect(workers.map((w) => [w.name, w.role])).toEqual([
      ["runner-pride", "runner"],
      ["worker-greed", "worker"],
    ])
  })

  test("without a live name, the launch name beats the workspace title", () => {
    const sessions = {
      sessions: [
        session({
          session_id: "s-dashboard",
          launch_arguments: ["/bin/claude", "-n", "dashboard-runner"],
          workspace_id: "W50",
        }),
      ],
    }
    const titled = {
      workspaces: [{ id: "W50", ref: "workspace:50", custom_title: "runner-pride" }],
    }
    const { workers } = fromRecords(sessions, titled, new Map(), new Map([["s-dashboard", null]]))
    expect(workers.map((w) => w.name)).toEqual(["dashboard-runner"])
  })

  test(`${OLD.dispatcher}, launched with no name, stays the dispatcher by its live name even when its workspace is shared`, () => {
    const sessions = {
      sessions: [
        session({
          session_id: `s-${OLD.dispatcher}`,
          launch_arguments: ["/bin/claude"],
          workspace_id: "W5",
          surface_id: "L1",
        }),
        session({
          session_id: "s-hand0001",
          launch_arguments: ["/bin/claude"],
          workspace_id: "W5",
          surface_id: "L2",
        }),
      ],
    }
    const live = new Map([[`s-${OLD.dispatcher}`, DISPATCHER]])
    const { workers } = fromRecords(sessions, workspaces, new Map(), live)
    expect(workers.map((w) => [w.name, w.role])).toEqual([
      [DISPATCHER, "dispatcher"],
      ["session repo", "other"],
    ])
  })

  test("a workspace's title still names a lone session that has neither a live nor a launch name, a nested headless run not counting as a second", () => {
    const sessions = {
      sessions: [
        session({
          session_id: `s-${OLD.dispatcher}`,
          launch_arguments: ["/bin/claude"],
          workspace_id: "W5",
          surface_id: "L1",
        }),
        // OLD.dispatcher's own `claude -p` trial, run in its terminal
        session({
          session_id: "s-trial",
          launch_arguments: ["/bin/claude", "-p"],
          launch_backed: false,
          workspace_id: "W5",
          surface_id: "L1",
        }),
      ],
    }
    const { workers } = fromRecords(sessions, workspaces, new Map())
    expect(workers.map((w) => [w.name, w.role])).toEqual([[DISPATCHER, "dispatcher"]])
  })

  test("two sessions sharing a renamed workspace keep their own launch names", () => {
    const sessions = {
      sessions: [
        session({
          session_id: "s-a",
          launch_arguments: ["/bin/claude", "-n", "worker-envy"],
          surface_id: "A",
        }),
        session({
          session_id: "s-b",
          launch_arguments: ["/bin/claude", "-n", "worker-lust"],
          surface_id: "B",
        }),
      ],
    }
    const shared = { workspaces: [{ id: "W1", ref: "workspace:40", custom_title: "runner-sloth" }] }
    const { workers } = fromRecords(sessions, shared, new Map())
    expect(workers.map((w) => [w.name, w.role])).toEqual([
      ["worker-envy", "worker"],
      ["worker-lust", "worker"],
    ])
  })

  test("in a shared renamed workspace, a session launched without a name is named for its folder, not the workspace's role", () => {
    const sessions = {
      sessions: [
        session({
          session_id: "s-runner",
          launch_arguments: ["/bin/claude", "-n", "dashboard-runner"],
          surface_id: "A",
        }),
        session({
          cwd: "/Users/me/acme-app/",
          session_id: "s-hand0001",
          launch_arguments: ["/bin/claude"],
          surface_id: "B",
        }),
      ],
    }
    const shared = { workspaces: [{ id: "W1", ref: "workspace:50", custom_title: "runner-pride" }] }
    const { workers } = fromRecords(sessions, shared, new Map())
    expect(workers.map((w) => [w.name, w.role])).toEqual([
      ["dashboard-runner", "other"],
      ["session acme-app", "other"],
    ])
  })

  test("an unnamed session in a folder named for a role takes none, and one with no folder keeps its id", () => {
    const unnamed = (cwd: string, id: string) =>
      session({ cwd, session_id: id, launch_arguments: ["/bin/claude"], surface_id: id })
    const sessions = {
      sessions: [
        unnamed(`/Users/me/${OLD.dispatcher}`, "s-hand0001"),
        unnamed("/w/worker-foo", "s-hand0003"),
        unnamed("/w/runner-foo", "s-hand0004"),
        unnamed("/w/probe-foo", "s-hand0005"),
        session({
          cwd: "",
          session_id: "s-hand0002",
          launch_arguments: ["/bin/claude"],
          surface_id: "C",
        }),
      ],
    }
    const shared = { workspaces: [{ id: "W1", ref: "workspace:50", custom_title: "runner-pride" }] }
    const { workers } = fromRecords(sessions, shared, new Map())
    expect(workers.map((w) => [w.name, w.role, isProbe(w.name)])).toEqual([
      [`session ${OLD.dispatcher}`, "other", false],
      ["session probe-foo", "other", false],
      ["session runner-foo", "other", false],
      ["session s-hand00", "other", false],
      ["session worker-foo", "other", false],
    ])
  })

  test("a row carries the triaged title and the ETA the roster gives its full name", () => {
    const sessions = {
      sessions: [session({ launch_arguments: ["/bin/claude", "-n", "worker-greed"] })],
    }
    const roster = {
      etas: new Map([["worker-greed", "2026-10-06T12:20:00Z"]]),
      roles: new Map(),
      titles: new Map([["worker-greed", `Message ${OLD.dispatcher} from the dashboard`]]),
    }
    const { workers } = fromRecords(sessions, { workspaces: [] }, new Map(), new Map(), roster)
    expect(workers.map((w) => [w.name, w.title, w.eta])).toEqual([
      ["worker-greed", `Message ${OLD.dispatcher} from the dashboard`, "2026-10-06T12:20:00Z"],
    ])
  })

  test("a session launched under its bare sin takes the roster's role for its role-prefixed name", () => {
    const roster = {
      etas: new Map(),
      roles: new Map([["worker-greed", { role: "worker" as const }]]),
      titles: new Map(),
    }
    const { workers } = fromRecords(
      { sessions: [session({})] },
      { workspaces: [] },
      new Map(),
      new Map(),
      roster,
    )
    expect(workers.map((w) => [w.name, w.role])).toEqual([["greed", "worker"]])
  })

  test("a row carries when its transcript last changed, and null when that is unknown", () => {
    const sessions = {
      sessions: [session({}), session({ session_id: "s-envy", surface_id: "MADESURF-2" })],
    }
    const { workers } = fromRecords(
      sessions,
      { workspaces: [] },
      new Map(),
      new Map(),
      undefined,
      new Map(),
      Date.now(),
      new Map([["s-greed", "2026-10-06T08:00:00.000Z"]]),
    )
    expect(workers.map((w) => [w.sessionId, w.lastActiveAt])).toEqual([
      ["s-greed", "2026-10-06T08:00:00.000Z"],
      ["s-envy", null],
    ])
  })

  test("a blank name at one step falls through to the next", () => {
    const sessions = {
      sessions: [session({ launch_arguments: ["/bin/claude", "-n", "worker-sloth"] })],
    }
    const { workers } = fromRecords(
      sessions,
      { workspaces: [] },
      new Map(),
      new Map([["s-greed", "  "]]),
    )
    expect(workers.map((w) => w.name)).toEqual(["worker-sloth"])
  })

  test("a name is trimmed before it is classified", () => {
    const sessions = {
      sessions: [session({ launch_arguments: ["/bin/claude", "-n", " runner-pride "] })],
    }
    const { workers } = fromRecords(sessions, { workspaces: [] }, new Map())
    expect(workers.map((w) => [w.name, w.role])).toEqual([["runner-pride", "runner"]])
  })

  test("the board lists the dispatcher, then the managers, then everyone else; managers keep their tasks", () => {
    const named = (sessionId: string, name: string, lifecycle = "running") =>
      session({
        session_id: sessionId,
        launch_arguments: ["/bin/claude", "-n", name],
        surface_id: sessionId,
        agent_lifecycle: lifecycle,
      })
    const sessions = {
      sessions: [
        named("s-greed", "worker-greed", "needsInput"),
        named("s-boy", OLD.ops),
        named("s-planner", "planner"),
        named("s-kid", OLD.builder, "idle"),
        named("s-plan", OLD.planner),
        session({
          session_id: `s-${OLD.dispatcher}`,
          launch_arguments: ["/bin/claude"],
          workspace_id: "W5",
          surface_id: "L",
        }),
      ],
    }
    const roster = {
      etas: new Map(),
      roles: new Map([["planner", { role: "manager" as const }]]),
      titles: new Map(),
    }
    const tasks = new Map([["s-kid", "Run the review queue"]])
    const { workers } = fromRecords(sessions, workspaces, tasks, new Map(), roster)
    expect(workers.map((w) => w.role)).toEqual([
      "dispatcher",
      "manager",
      "manager",
      "manager",
      "manager",
      "worker",
    ])
    expect(workers[0]?.name).toBe(DISPATCHER)
    expect(
      workers
        .slice(1, 5)
        .map((w) => w.name)
        .toSorted(),
    ).toEqual([OLD.ops, OLD.builder, OLD.planner, "planner"].toSorted())
    expect(workers.find((w) => w.name === OLD.builder)?.task).toBe("Run the review queue")
  })

  test("workers that need you sort before working ones, then idle, then by name", () => {
    const sessions = {
      sessions: [
        session({
          session_id: "a",
          launch_arguments: ["c", "-n", "sloth"],
          agent_lifecycle: "idle",
        }),
        session({ session_id: "b", launch_arguments: ["c", "-n", "envy"] }),
        session({
          session_id: "c",
          launch_arguments: ["c", "-n", "wrath"],
          agent_lifecycle: "needsInput",
        }),
        session({ session_id: "d", launch_arguments: ["c", "-n", "greed"] }),
      ],
    }
    const { workers } = fromRecords(sessions, workspaces, new Map())
    expect(workers.map((w) => w.name)).toEqual(["wrath", "envy", "greed", "sloth"])
  })

  test("a headless run nested in a worker's terminal is not a second worker; a lone unlaunched session still shows", () => {
    const sessions = {
      sessions: [
        session({}),
        session({ session_id: "nested", launch_arguments: [], launch_backed: false }),
        session({
          session_id: "lone",
          launch_arguments: [],
          launch_backed: false,
          surface_id: "MADESURF-9",
          workspace_id: "W5",
        }),
      ],
    }
    const { workers } = fromRecords(sessions, workspaces, new Map())
    expect(workers.map((w) => w.sessionId).sort()).toEqual(["lone", "s-greed"])
  })

  test("garbage in yields no rows rather than a throw", () => {
    expect(fromRecords(null, "x", new Map()).workers).toEqual([])
  })
})

describe("rosterFacts", () => {
  const agent = (name: string, role: "manager" | "runner" | "worker", title?: string) => ({
    name,
    role,
    status: "working",
    task: "t",
    ...(title === undefined ? {} : { title }),
  })

  test("maps each agent's full name to its kind and role, and to its trimmed title when it has one", () => {
    const roster = {
      updatedAt: "2026-10-06T03:39:00.000+05:30",
      agents: [
        agent("worker-greed", "worker", ` Message ${OLD.dispatcher} from the dashboard `),
        agent("worker-envy", "worker", "  "),
        agent(OLD.builder, "manager"),
      ],
    }
    const facts = rosterFacts(roster)
    expect(facts.titles).toEqual(
      new Map([["worker-greed", `Message ${OLD.dispatcher} from the dashboard`]]),
    )
    expect(facts.roles).toEqual(
      new Map([
        ["worker-greed", { role: "worker" }],
        ["worker-envy", { role: "worker" }],
        [OLD.builder, { role: "manager" }],
      ]),
    )
    const kinded = rosterFacts({
      ...roster,
      agents: [{ ...agent("k3v9q2-reviewer", "worker"), kind: "reviewer" }],
    })
    expect(kinded.roles.get("k3v9q2-reviewer")).toEqual({ kind: "reviewer", role: "worker" })
  })

  test("maps each agent's full name to its ETA when it has one", () => {
    const roster = {
      updatedAt: "2026-10-06T03:39:00.000+05:30",
      agents: [
        { ...agent("worker-greed", "worker"), eta: "2026-10-06T12:20:00Z" },
        agent("worker-envy", "worker"),
      ],
    }
    expect(rosterFacts(roster).etas).toEqual(new Map([["worker-greed", "2026-10-06T12:20:00Z"]]))
  })

  test("no roster gives no ETAs, roles or titles", () => {
    const facts = rosterFacts(null)
    expect(facts.etas.size + facts.roles.size + facts.titles.size).toBe(0)
    expect(facts.assistant).toBeUndefined()
  })

  // #780: the Assistant has a chat of its own, found by the roster's assistant kind whatever its name
  test("names the session in the assistant seat, the newest live entry of that kind, and none while every one has ended", () => {
    const assistant = (name: string, status: string) => ({
      ...agent(name, "manager"),
      kind: "assistant" as const,
      status,
    })
    const seat = (agents: ReturnType<typeof agent>[]) =>
      rosterFacts({ updatedAt: "2026-11-03T21:00:00Z", agents }, false).assistant
    expect(seat([assistant("q2w8rt-assistant", "working")])).toBe("q2w8rt-assistant")
    expect(seat([assistant("old-assistant", "ended"), assistant("errands", "working")])).toBe(
      "errands",
    )
    expect(seat([assistant("errands", "ended"), agent("builder", "manager")])).toBeUndefined()
  })

  // A test stack that points PLAYGROUND_DISPATCHER at a throwaway probe keeps the real assistant out of its composer's reach, as it keeps the real second dispatcher
  test("names no assistant on a stack whose dispatcher is redirected to a probe", () => {
    const roster = {
      updatedAt: "2026-11-03T21:00:00Z",
      agents: [{ ...agent("errands", "manager"), kind: "assistant" as const }],
    }
    expect(rosterFacts(roster, true).assistant).toBeUndefined()
  })

  test("marks the live session in the assistant seat, and no other, so the web gives it a chat", () => {
    const sessions = {
      sessions: [
        session({
          session_id: "s-a",
          launch_arguments: ["/bin/claude", "-n", "errands"],
          workspace_id: "W1",
          surface_id: "A",
        }),
        session({
          session_id: "s-b",
          launch_arguments: ["/bin/claude", "-n", "builder"],
          workspace_id: "W2",
          surface_id: "B",
        }),
      ],
    }
    const workspaces = {
      workspaces: [
        { id: "W1", ref: "workspace:1", title: "errands" },
        { id: "W2", ref: "workspace:2", title: "builder" },
      ],
    }
    const roster = {
      assistant: "errands",
      etas: new Map(),
      roles: new Map([["errands", { kind: "assistant" as const, role: "manager" as const }]]),
      titles: new Map(),
    }
    const { workers } = fromRecords(sessions, workspaces, new Map(), new Map(), roster)
    expect(workers.find((w) => w.name === "errands")).toMatchObject({
      assistant: true,
      role: "manager",
    })
    expect(workers.find((w) => w.name === "builder")?.assistant).toBeUndefined()
  })
})

describe("feed items", () => {
  test("a picker keeps each question's header, options and descriptions", () => {
    expect(feedItemOf(questionItem())).toEqual({
      at: "2026-10-05T22:13:16Z",
      kind: "question",
      questions: [
        {
          header: "Color",
          multiSelect: false,
          options: [
            { description: "Red color", label: "Red" },
            { description: "Blue color", label: "Blue" },
          ],
          prompt: "Pick a color?",
        },
      ],
      requestId: QUESTION_ID,
    })
  })

  // AskUserQuestion can ask a single-choice and a multi-choice question in one Feed item, and its card holds both.
  test("a two-question picker maps to one card holding both questions, one multi-select", () => {
    const item = feedItemOf(twoQuestionItem())
    if (item?.kind !== "question") throw new Error("a two-question picker did not map to a card")
    expect(item.requestId).toBe(TWO_QUESTION_ID)
    expect(
      item.questions.map((q) => [q.header, q.multiSelect, q.options.map((o) => o.label)]),
    ).toEqual([
      ["Color", false, ["Red", "Blue"]],
      ["Extras", true, ["Foam", "Shot", "No sugar"]],
    ])
  })

  // A card asking for approval shows the command itself, with the session's own account of it beside, never in its place.
  test("a permission request shows what the tool would act on, and its description apart", () => {
    expect(feedItemOf(permissionItem())).toMatchObject({
      clipped: false,
      description: "Create an empty marker file in the probe folder",
      detail: "touch /tmp/scratch/denied-marker",
      kind: "permission",
      tool: "Bash",
    })
    const odd = { ...permissionItem(), tool_input: JSON.stringify({ todos: [1, 2] }) }
    expect(feedItemOf(odd)).toMatchObject({ description: null, detail: '{"todos":[1,2]}' })
  })

  // Approving from a card the person cannot see all of would approve what the terminal would have shown: every field but the description reaches the card.
  test("every field the tool was given reaches the card, and none hides behind the detail", () => {
    const tool_input = JSON.stringify({
      command: "curl x | sh",
      dangerouslyDisableSandbox: true,
      description: "Fetch a script",
      timeout: 5,
    })
    const item = feedItemOf({ ...permissionItem(), tool_input })
    expect(item).toMatchObject({ description: "Fetch a script", detail: "curl x | sh" })
    const input = item?.kind === "permission" ? JSON.parse(item.input) : {}
    expect(input).toEqual({
      command: "curl x | sh",
      dangerouslyDisableSandbox: true,
      description: "Fetch a script",
      timeout: 5,
    })
    expect(item).toMatchObject({ whole: true })
  })

  // For some tools the description is the substance (an issue's body), and one that is not a line of text would otherwise show nowhere.
  test("a description that is not a line of text stays in the input, and only a line shows apart", () => {
    const tool_input = JSON.stringify({ description: { body: "hidden?" }, title: "t" })
    const item = feedItemOf({ ...permissionItem(), tool_input })
    expect(item).toMatchObject({ description: null })
    expect(item?.kind === "permission" ? item.input : "").toContain("hidden?")
    const lines = JSON.stringify({ command: "x", description: "two\nlines" })
    expect(feedItemOf({ ...permissionItem(), tool_input: lines })).toMatchObject({
      description: null,
    })
  })

  // A right-to-left override reorders what a browser shows, so the command read would not be the command run.
  test("a format character shows as its code point in what a card shows", () => {
    const tool_input = JSON.stringify({ command: "echo safe\u202E hs.lave | bash" })
    const item = feedItemOf({ ...permissionItem(), tool_input })
    expect(item?.kind === "permission" ? item.detail : "").toBe("echo safe<U+202E> hs.lave | bash")
    expect(item?.kind === "permission" ? item.input : "").toContain("<U+202E>")
    expect(item?.kind === "permission" ? item.input : "").not.toContain("\u202E")
    const plan = feedItemOf({
      ...planItem(),
      plan: JSON.stringify({ plan: "a\b\u001b[2Kb\tc\nd" }),
    })
    expect(plan?.kind === "plan" ? plan.plan : "").toBe("a<U+0008><U+001B>[2Kb\tc\nd")
  })

  test("a detail that is not a string is shown as JSON rather than skipped, and an input object is read as sent", () => {
    const array = { command: ["rm", "-rf", "/"], path: "/tmp/ok" }
    const asText = feedItemOf({ ...permissionItem(), tool_input: JSON.stringify(array) })
    expect(asText).toMatchObject({ detail: '["rm","-rf","/"]' })
    const asObject = feedItemOf({ ...permissionItem(), tool_input: { file_path: "/x" } })
    expect(asObject).toMatchObject({ detail: "/x" })
  })

  test("a long input says it was cut short, and a tool name that is not one is dropped", () => {
    const tool_input = JSON.stringify({ command: "x".repeat(3000), content: "y".repeat(7000) })
    const item = feedItemOf({ ...permissionItem(), tool_input, tool_name: "Bash; rm" })
    expect(item).toMatchObject({ clipped: true, tool: "", whole: false })
  })

  test("an option with no label, or a label already offered, is not offered", () => {
    const blank = questionItem()
    const q = {
      ...blank.questions[0]!,
      options: [{ description: "", id: "opt0", label: "" }, blank.questions[0]!.options[1]!],
    }
    const item = feedItemOf({ ...blank, questions: [q] })
    expect(item?.kind === "question" ? item.questions[0]?.options.map((o) => o.label) : []).toEqual(
      ["Blue"],
    )
    const twice = {
      ...blank.questions[0]!,
      options: [...blank.questions[0]!.options, blank.questions[0]!.options[0]!],
    }
    const deduped = feedItemOf({ ...blank, questions: [twice] })
    expect(
      deduped?.kind === "question" ? deduped.questions[0]?.options.map((o) => o.label) : [],
    ).toEqual(["Red", "Blue"])
  })

  test("a plan is its text, unwrapped from the Feed's JSON or an object, and says when it was cut short", () => {
    expect(feedItemOf(planItem())).toMatchObject({
      clipped: false,
      kind: "plan",
      plan: "# Plan: create the plan-marker file\n\n## Step\n1. touch plan-marker\n",
    })
    expect(feedItemOf({ ...planItem(), plan: { plan: "an object" } })).toMatchObject({
      plan: "an object",
    })
    const long = { ...planItem(), plan: JSON.stringify({ plan: "z".repeat(9000) }) }
    expect(feedItemOf(long)).toMatchObject({ clipped: true })
  })

  test("telemetry, answered items and items with no request id are not pending", () => {
    expect(feedItemOf({ kind: "toolUse", request_id: "x" })).toBeNull()
    expect(feedItemOf({ ...questionItem(), status: "resolved" })).toBeNull()
    expect(feedItemOf({ ...questionItem(), request_id: "" })).toBeNull()
  })
})

// A record kept after its session ended: its stored pid now belongs to whatever macOS started next (ManagedSettingsAgent), so the record still says the pid exists and the session waits on input. No registry file names it.
const reused = session({
  agent_lifecycle: "needsInput",
  launch_arguments: ["/bin/claude", "-n", "greed"],
  pid: 67174,
  session_id: "s-ended",
  stored_pid_arguments: [
    "/System/Library/Frameworks/ManagedSettings.framework/Versions/A/ManagedSettingsAgent",
  ],
  surface_id: "MADESURF-GONE",
  transcript_path: "/c/projects/p/s-ended.jsonl",
  workspace_id: "W-GONE",
})
const running = session({ pid: 95475, transcript_path: "/c/projects/p/s-greed.jsonl" })
const STARTED = "Tue Oct 6 09:00:00 2026"
const proof = (over: Partial<LiveProof> = {}): LiveProof => ({
  projects: "/c/projects",
  registry: new Map([[95475, { procStart: STARTED, sessionId: "s-greed" }]]),
  starts: new Map([[95475, STARTED]]),
  ...over,
})

describe("isLiveRecord", () => {
  test("a record is live only when Claude's registry names its session at its pid", () => {
    expect(isLiveRecord(running, proof())).toBe(true)
    expect(isLiveRecord(reused, proof())).toBe(false)
  })

  test("a pid the registry gives to another session is not this one's", () => {
    const registry = new Map([[95475, { procStart: STARTED, sessionId: "s-other" }]])
    expect(isLiveRecord(running, proof({ registry }))).toBe(false)
  })

  test("a file a crash left behind proves nothing once its pid is another process's", () => {
    expect(
      isLiveRecord(running, proof({ starts: new Map([[95475, "Wed Oct 7 08:00:00 2026"]]) })),
    ).toBe(false)
    expect(isLiveRecord(running, proof({ starts: new Map() }))).toBe(false)
  })

  test("with no start time to compare, the registry's name for the pid stands", () => {
    expect(isLiveRecord(running, proof({ starts: null }))).toBe(true)
    const registry = new Map([[95475, { procStart: null, sessionId: "s-greed" }]])
    expect(isLiveRecord(running, proof({ registry, starts: new Map() }))).toBe(true)
  })

  test("a procStart Claude writes in another shape (ISO, epoch) keeps a live record live", () => {
    for (const procStart of ["2026-10-06T09:00:00.000Z", 1791277200000]) {
      const text = JSON.stringify({ pid: 95475, procStart, sessionId: "s-greed" })
      expect(isLiveRecord(running, proof({ registry: registryOf([{ pid: 95475, text }]) }))).toBe(
        true,
      )
    }
  })

  test("a registry file caught mid-rewrite leaves the record's word standing for its pid alone", () => {
    const registry = new Map([[95475, null]])
    expect(isLiveRecord(running, proof({ registry }))).toBe(true)
    expect(isLiveRecord(reused, proof({ registry }))).toBe(false)
  })

  test("a session under another Claude config keeps its registry there, so the record's word stands", () => {
    const elsewhere = { ...reused, transcript_path: "/other/projects/p/s-ended.jsonl" }
    expect(isLiveRecord(elsewhere, proof())).toBe(true)
    expect(isLiveRecord({ ...reused, transcript_path: "" }, proof())).toBe(false)
  })

  test("the record's own word still has to hold: a pid it saw end, or another agent, is never live", () => {
    expect(isLiveRecord({ ...running, stored_pid_exists: false }, proof())).toBe(false)
    expect(isLiveRecord({ ...running, agent: "gemini" }, proof())).toBe(false)
    const registry = new Map([[95475, { procStart: STARTED, sessionId: "" }]])
    expect(isLiveRecord({ ...running, session_id: "" }, proof({ registry }))).toBe(false)
  })

  test("with no registry to read, the record's own pid is trusted as before", () => {
    expect(isLiveRecord(reused, proof({ registry: null }))).toBe(true)
    expect(isLiveRecord(reused, null)).toBe(true)
  })
})

describe("an ended session whose pid was reused", () => {
  test("shows no row, light, picker or needs-you, while the live session beside it stays", () => {
    const live = composeWorkers(
      liveRecords({ sessions: [reused, running] }, proof()),
      {
        workspaces: [
          ...workspaces.workspaces,
          { id: "W-GONE", ref: "workspace:9", custom_title: "greed" },
        ],
      },
      new Map(),
    )
    expect(live.workers.map((w) => w.sessionId)).toEqual(["s-greed"])
    expect(live.workers.some((w) => w.light === "needs-you")).toBe(false)
    expect(live.workers.flatMap((w) => w.questions)).toEqual([])
    expect([...live.surfaces.keys()]).toEqual(["s-greed"])
    expect([...live.transcripts.keys()]).toEqual(["s-greed"])
  })

  test("before the registry check it would have read as a session waiting on you", () => {
    const trusted = fromRecords({ sessions: [reused] }, workspaces, new Map())
    expect(trusted.workers.map((w) => w.light)).toEqual(["needs-you"])
  })
})

describe("a picker he already answered", () => {
  // The session went needsInput as its picker went up, at 22:13:16.4Z.
  const waiting = session({
    agent_lifecycle: "needsInput",
    session_id: "s-greed",
    updated_at: "2026-10-05T22:13:16.400Z",
  })
  const board = (pickers: Pickers, record = waiting) =>
    fromRecords(
      { sessions: [record] },
      workspaces,
      new Map(),
      new Map(),
      undefined,
      new Map([["s-greed", { ...NO_FACTS, pickers }]]),
    ).workers[0]

  test("leaves the red once the transcript holds the answer, while the record still reads needsInput", () => {
    const worker = board({ answeredAt: "2026-10-05T22:13:20.100Z", interrupted: false, open: [] })
    expect(worker).toMatchObject({
      feed: [],
      lifecycle: "running",
      light: "working",
      questions: [],
    })
  })

  test("keeps the red while a picker is still open, a second one raised after the first was answered", () => {
    const worker = board({
      answeredAt: "2026-10-05T22:13:20.100Z",
      interrupted: false,
      open: ["toolu_second"],
    })
    expect(worker?.light).toBe("needs-you")
  })

  test("keeps needsInput the record took after the answer, such as a permission prompt", () => {
    const later = session({
      agent_lifecycle: "needsInput",
      session_id: "s-greed",
      updated_at: "2026-10-05T22:13:21.000Z",
    })
    const worker = board(
      { answeredAt: "2026-10-05T22:13:20.100Z", interrupted: false, open: [] },
      later,
    )
    expect(worker).toMatchObject({ lifecycle: "needsInput", light: "needs-you" })
  })

  test("Esc on the picker and an interrupt leave it idle at its prompt; going on after a rejection is running", () => {
    const pickers = { answeredAt: "2026-10-05T22:13:20.100Z", open: [] }
    expect(board({ ...pickers, interrupted: true })).toMatchObject({
      feed: [],
      lifecycle: "idle",
      light: "idle",
    })
    expect(board({ ...pickers, interrupted: false })?.lifecycle).toBe("running")
  })

  test("a transcript with no answer leaves the record's word", () => {
    expect(board(NO_FACTS.pickers)?.light).toBe("needs-you")
  })
})

describe("answeredSince", () => {
  const answered = (answeredAt: string | null, open: string[] = []) => ({
    answeredAt,
    interrupted: false,
    open,
  })

  test("a whole-second stamp counts only answers from the next second on", () => {
    expect(answeredSince(answered("2026-10-05T22:13:16.999Z"), "2026-10-05T22:13:16Z")).toBe(false)
    expect(answeredSince(answered("2026-10-05T22:13:17.000Z"), "2026-10-05T22:13:16Z")).toBe(true)
  })

  test("a stamp with milliseconds counts any later answer", () => {
    expect(answeredSince(answered("2026-10-05T22:13:16.401Z"), "2026-10-05T22:13:16.400Z")).toBe(
      true,
    )
    expect(answeredSince(answered("2026-10-05T22:13:16.400Z"), "2026-10-05T22:13:16.400Z")).toBe(
      false,
    )
  })

  test("an open picker, no answer or an unreadable time is not answered", () => {
    expect(
      answeredSince(answered("2026-10-05T22:14:00Z", ["toolu_1"]), "2026-10-05T22:13:16Z"),
    ).toBe(false)
    expect(answeredSince(answered(null), "2026-10-05T22:13:16Z")).toBe(false)
    expect(answeredSince(answered("2026-10-05T22:14:00Z"), "")).toBe(false)
  })
})

// A cmux on PATH that logs each call it gets and answers none, so a case shows the board asks cmux nothing.
const FAKE_CMUX = `#!/usr/bin/env bun
const { appendFileSync } = await import("node:fs")
appendFileSync(process.env.FAKE_CMUX_LOG, process.argv.slice(2).join(" ") + "\\n")
process.exit(1)
`

describe.skipIf(onLiveDashboard())("reading herdr's sessions", () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
  })

  // A script on a live-reads process whose cmux is the fake above, started SLOW_CHILD seconds late when that is set, and whose Claude config folder holds what `setup` writes, with the calls that cmux got. It opts in to every session on the machine unless `env` says otherwise.
  async function drive(
    script: string,
    setup?: (dir: string) => void,
    env: Record<string, string> = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "workers-read-"))
    dirs.push(dir)
    const bin = join(dir, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "cmux"), FAKE_CMUX)
    chmodSync(join(bin, "cmux"), 0o755)
    slowChild("bun", bin)
    mkdirSync(join(dir, "config"))
    setup?.(dir)
    const log = join(dir, "cmux.log")
    writeFileSync(log, "")
    const { code, result, stderr } = await inFixture(
      `const { listLive } = await import(\`\${API}/lib/dashboard/workers\`)
const { appendFileSync } = await import("node:fs")
const mark = (what) => appendFileSync(process.env.FAKE_CMUX_LOG, "-- " + what + "\\n")
${script}
process.exit(0)
`,
      dir,
      {
        CLAUDE_CONFIG_DIR: join(dir, "config"),
        PLAYGROUND_ALL_SESSIONS: "true",
        PLAYGROUND_DATA_DIR: join(join(dir, "config"), "playground"),
        PLAYGROUND_LIVE_READS: "1",
        FAKE_CMUX_LOG: log,
        PATH: `${bin}:${process.env.PATH}`,
        ...env,
      },
    )
    expect(stderr).not.toContain("error:")
    expect(code).toBe(0)
    return { calls: readFileSync(log, "utf8").trim().split("\n"), result }
  }
  const after = (calls: string[], mark: string) => calls.slice(calls.indexOf(`-- ${mark}`) + 1)

  test("herdr's sessions make the board, with herdr's state and the C5 file's usage limit, a pane with no registry file is none, and cmux is asked nothing", async () => {
    const { calls, result } =
      await drive(`const { mkdirSync, writeFileSync } = await import("node:fs")
const { join } = await import("node:path")
const config = process.env.CLAUDE_CONFIG_DIR
const answer = (method, params) => {
  const pane = (id, status) => ({ agent_status: status, pane_id: id, terminal_id: "t-" + id, workspace_id: "w1" })
  if (method === "session.snapshot") return { snapshot: { panes: [pane("w1:p1", "blocked"), pane("w1:p2", "working")], workspaces: [{ label: "probes", workspace_id: "w1" }] } }
  if (params.pane_id === "w1:p2") return { process_info: { foreground_processes: [{ argv: ["/bin/zsh"], pid: 4343 }] } }
  return { process_info: { foreground_processes: [{ argv: ["claude", "-n", "worker-herdr-a"], cwd: "/tmp/probe-a", pid: 4242 }] } }
}
process.env.PLAYGROUND_HERDR_DIR = join(config, "playground", "herdr")
process.env.PLAYGROUND_HERDR_SESSIONS = "probes"
mkdirSync(join(config, "playground", "herdr"), { recursive: true })
Bun.listen({ unix: join(config, "playground", "herdr", "probes.sock"), socket: { data(conn, chunk) {
  const req = JSON.parse(new TextDecoder().decode(chunk).split("\\n")[0])
  conn.write(JSON.stringify({ id: req.id, result: answer(req.method, req.params) }) + "\\n")
  conn.end()
} } })
mkdirSync(join(config, "sessions"))
writeFileSync(join(config, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "h-1" }))
mkdirSync(join(config, "playground", "session-state"), { recursive: true })
writeFileSync(join(config, "playground", "session-state", "h-1.json"), JSON.stringify({ at: new Date().toISOString(), event: "StopFailure", resetsAt: "2026-10-18T05:00:00.000Z", sessionId: "h-1", state: "usage-limit" }))
mark("start")
const board = await listLive()
const herdr = board.workers.find((w) => w.name === "worker-herdr-a")
console.log(JSON.stringify({
  board: board.workers.length,
  herdr: [herdr.light, herdr.lifecycle, herdr.surface, herdr.workspace, herdr.usageLimit, board.surfaces.get("h-1")],
}))`)
    expect(result).toEqual({
      board: 1,
      herdr: [
        "needs-you",
        "needsInput",
        "herdr:probes:w1:p1",
        { ref: "herdr:probes:w1", title: "probes" },
        { resets: null, resetsAt: "2026-10-18T05:00:00.000Z" },
        "herdr:probes:w1:p1",
      ],
    })
    expect(after(calls, "start")).toEqual([])
  }, 60_000)

  // A fresh Playground on a Mac whose cmux runs sessions it never started: its board holds its own herdr sessions alone, opted in or not, and the opt-in adds only the registry's second dispatcher to the header's slots
  describe("a stack's own sessions", () => {
    const others = (dir: string) => {
      mkdirSync(join(dir, "config", "sessions"), { recursive: true })
      writeFileSync(
        join(dir, "config", "sessions", `${process.pid}.json`),
        JSON.stringify({ name: "optimizer", pid: process.pid, sessionId: "c-1" }),
      )
    }
    const own = `const { mkdirSync, writeFileSync } = await import("node:fs")
const { join } = await import("node:path")
const { DISPATCHER, DISPATCHER_SECONDARY, readDispatcherSlots } = await import(\`\${API}/lib/dashboard/workers\`)
const config = process.env.CLAUDE_CONFIG_DIR
process.env.PLAYGROUND_HERDR_DIR = join(config, "playground", "herdr")
process.env.PLAYGROUND_HERDR_SESSIONS = "factory"
mkdirSync(process.env.PLAYGROUND_HERDR_DIR, { recursive: true })
Bun.listen({ unix: join(process.env.PLAYGROUND_HERDR_DIR, "factory.sock"), socket: { data(conn, chunk) {
  const req = JSON.parse(new TextDecoder().decode(chunk).split("\\n")[0])
  const result = req.method === "session.snapshot"
    ? { snapshot: { panes: [{ agent_status: "idle", pane_id: "w1:p1", terminal_id: "t-1", workspace_id: "w1" }], workspaces: [{ label: "leads", workspace_id: "w1" }] } }
    : { process_info: { foreground_processes: [{ argv: ["claude", "-n", DISPATCHER], cwd: "/tmp/leads", pid: 4242 }] } }
  conn.write(JSON.stringify({ id: req.id, result }) + "\\n")
  conn.end()
} } })
const sessions = join(config, "sessions")
mkdirSync(sessions, { recursive: true })
writeFileSync(join(sessions, "4242.json"), JSON.stringify({ name: DISPATCHER, pid: 4242, sessionId: "h-1" }))
writeFileSync(join(sessions, "4343.json"), JSON.stringify({ name: DISPATCHER_SECONDARY, pid: 4343, sessionId: "c-2" }))
mark("start")
const board = await listLive()
console.log(JSON.stringify({
  feed: board.workers.flatMap((w) => w.feed).length,
  names: board.workers.map((w) => (w.name === DISPATCHER ? "the dispatcher" : w.name) + ": " + w.role).sort(),
  slots: await readDispatcherSlots(),
}))`

    test.each([
      ["no opt-in", "", 1],
      ["the opt-in", "true", 2],
    ])(
      "with %s, only the dispatcher Playground started in herdr shows, and cmux is asked nothing",
      async (_, optIn, slots) => {
        const { calls, result } = await drive(own, others, { PLAYGROUND_ALL_SESSIONS: optIn })
        expect(result).toEqual({ feed: 0, names: ["the dispatcher: dispatcher"], slots })
        expect(after(calls, "start")).toEqual([])
      },
      60_000,
    )
  })

  // the session's transcript reaches herdrState through the board, so a turn after a stuck record (an Escape fires no hook) ends herdr's blocked
  test("a herdr session blocked on a prompt its transcript has moved past reads idle", async () => {
    const { result } = await drive(`const { mkdirSync, writeFileSync } = await import("node:fs")
const { join } = await import("node:path")
const config = process.env.CLAUDE_CONFIG_DIR
const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
process.env.PLAYGROUND_HERDR_DIR = join(config, "playground", "herdr")
process.env.PLAYGROUND_HERDR_SESSIONS = "probes"
mkdirSync(join(config, "playground", "herdr"), { recursive: true })
Bun.listen({ unix: join(config, "playground", "herdr", "probes.sock"), socket: { data(conn, chunk) {
  const req = JSON.parse(new TextDecoder().decode(chunk).split("\\n")[0])
  const result = req.method === "session.snapshot"
    ? { snapshot: { panes: [{ agent_status: "blocked", pane_id: "w1:p1", terminal_id: "t-1", workspace_id: "w1" }], workspaces: [{ label: "probes", workspace_id: "w1" }] } }
    : { process_info: { foreground_processes: [{ argv: ["claude", "-n", "worker-herdr-a"], cwd: "/tmp/probe-a", pid: 4242 }] } }
  conn.write(JSON.stringify({ id: req.id, result }) + "\\n")
  conn.end()
} } })
mkdirSync(join(config, "sessions"))
writeFileSync(join(config, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "h-1" }))
mkdirSync(join(config, "playground", "session-state"), { recursive: true })
writeFileSync(join(config, "playground", "session-state", "h-1.json"), JSON.stringify({ at: ago(60), event: "PermissionRequest", sessionId: "h-1", state: "stuck" }))
mkdirSync(join(config, "projects", "-tmp-probe-a"), { recursive: true })
writeFileSync(join(config, "projects", "-tmp-probe-a", "h-1.jsonl"), JSON.stringify({ type: "user", timestamp: ago(30), message: { content: "go on" } }) + "\\n")
const herdr = (await listLive()).workers.find((w) => w.name === "worker-herdr-a")
console.log(JSON.stringify([herdr.lifecycle, herdr.light]))`)
    expect(result).toEqual(["idle", "idle"])
  }, 60_000)

  // herdr has no Feed, so a blocked herdr session's card comes from its transcript's open call, named by its hooks' stuck record
  test("a herdr session blocked on a picker gets its card from the transcript, marked herdr", async () => {
    const { result } = await drive(`const { mkdirSync, writeFileSync } = await import("node:fs")
const { join } = await import("node:path")
const config = process.env.CLAUDE_CONFIG_DIR
const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
process.env.PLAYGROUND_HERDR_DIR = join(config, "playground", "herdr")
process.env.PLAYGROUND_HERDR_SESSIONS = "probes"
mkdirSync(join(config, "playground", "herdr"), { recursive: true })
Bun.listen({ unix: join(config, "playground", "herdr", "probes.sock"), socket: { data(conn, chunk) {
  const req = JSON.parse(new TextDecoder().decode(chunk).split("\\n")[0])
  const result = req.method === "session.snapshot"
    ? { snapshot: { panes: [{ agent_status: "blocked", pane_id: "w1:p1", terminal_id: "t-1", workspace_id: "w1" }], workspaces: [{ label: "probes", workspace_id: "w1" }] } }
    : { process_info: { foreground_processes: [{ argv: ["claude", "-n", "worker-herdr-a"], cwd: "/tmp/probe-a", pid: 4242 }] } }
  conn.write(JSON.stringify({ id: req.id, result }) + "\\n")
  conn.end()
} } })
mkdirSync(join(config, "sessions"))
writeFileSync(join(config, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: "h-1" }))
mkdirSync(join(config, "playground", "session-state"), { recursive: true })
writeFileSync(join(config, "playground", "session-state", "h-1.json"), JSON.stringify({ at: ago(5), event: "PermissionRequest", reason: "question", sessionId: "h-1", state: "stuck", tool: "AskUserQuestion" }))
mkdirSync(join(config, "projects", "-tmp-probe-a"), { recursive: true })
const ask = { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions: [{ question: "Which port?", header: "Port", multiSelect: false, options: [{ label: "3000", description: "web" }, { label: "4000", description: null }] }] } }
writeFileSync(join(config, "projects", "-tmp-probe-a", "h-1.jsonl"), JSON.stringify({ type: "assistant", timestamp: ago(10), message: { model: "claude-opus-5-5", content: [ask] } }) + "\\n")
const herdr = (await listLive()).workers.find((w) => w.name === "worker-herdr-a")
console.log(JSON.stringify([herdr.light, herdr.herdr, herdr.feed]))`)
    expect(result).toEqual([
      "needs-you",
      true,
      [
        {
          at: expect.any(String),
          kind: "question",
          questions: [
            {
              header: "Port",
              multiSelect: false,
              options: [
                { description: "web", label: "3000" },
                { description: null, label: "4000" },
              ],
              prompt: "Which port?",
            },
          ],
          requestId: "toolu_ask",
        },
      ],
    ])
  }, 60_000)

  // an ops-unstick entry naming one session on another's surface put a wrong Waiting on you on Playground's row and held his messages
  test("an ops-unstick entry whose surface and name disagree marks neither session, and names itself", async () => {
    const { result } =
      await drive(`const { unstickProblem } = await import(\`\${API}/lib/dashboard/workers\`)
const { mkdirSync, writeFileSync } = await import("node:fs")
const { join } = await import("node:path")
const config = process.env.CLAUDE_CONFIG_DIR
const panes = { "w1:p1": ["worker-a", 4242, "h-a"], "w1:p2": ["worker-b", 4343, "h-b"] }
process.env.PLAYGROUND_HERDR_DIR = join(config, "playground", "herdr")
process.env.PLAYGROUND_HERDR_SESSIONS = "probes"
mkdirSync(process.env.PLAYGROUND_HERDR_DIR, { recursive: true })
Bun.listen({ unix: join(process.env.PLAYGROUND_HERDR_DIR, "probes.sock"), socket: { data(conn, chunk) {
  const req = JSON.parse(new TextDecoder().decode(chunk).split("\\n")[0])
  const result = req.method === "session.snapshot"
    ? { snapshot: { panes: Object.keys(panes).map((id) => ({ agent_status: "idle", pane_id: id, terminal_id: "t-" + id, workspace_id: "w1" })), workspaces: [{ label: "probes", workspace_id: "w1" }] } }
    : { process_info: { foreground_processes: [{ argv: ["claude", "-n", panes[req.params.pane_id][0]], cwd: "/tmp/probe", pid: panes[req.params.pane_id][1] }] } }
  conn.write(JSON.stringify({ id: req.id, result }) + "\\n")
  conn.end()
} } })
mkdirSync(join(config, "sessions"))
for (const [, pid, sessionId] of Object.values(panes)) writeFileSync(join(config, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId }))
const dir = join(process.env.PLAYGROUND_DATA_DIR, "ops", "unstick")
mkdirSync(dir, { recursive: true })
const entry = { kind: "permission", line: "Allow?", name: "worker-a", since: new Date().toISOString(), surface: "herdr:probes:w1:p2", workspace: "herdr:probes:w1" }
writeFileSync(join(dir, "state.json"), JSON.stringify({ blocked: [entry], writtenAt: new Date().toISOString() }))
const board = await listLive()
console.log(JSON.stringify({ board: board.workers.map((w) => [w.name, w.light]).sort(), problem: unstickProblem() }))`)
    expect(result).toEqual({
      board: [
        ["worker-a", "idle"],
        ["worker-b", "idle"],
      ],
      problem:
        "ops-unstick lists worker-a as blocked (permission) on surface herdr:probes:w1:p2, which worker-b holds, so neither is marked",
    })
  }, 60_000)
})
