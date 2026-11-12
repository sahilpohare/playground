import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseLine, type Entry } from "../../../../../api/hono/src/lib/dashboard/transcript"
import {
  LIGHT_HOLD_MS,
  LIGHT_LABELS,
  afterFrame,
  agentGroup,
  checkerOf,
  etaLabel,
  fetchAsked,
  groupState,
  heldCount,
  historyOf,
  isProbe,
  keepSettled,
  keepsOther,
  liveState,
  longIdle,
  mergeEntries,
  dispatcherOf,
  dispatchersOf,
  nestCheckers,
  nestState,
  oneLine,
  OTHER_IDLE_MS,
  otherRows,
  pickWorker,
  reconnectDelay,
  remarkLineBreaks,
  rowTitle,
  sessionGroups,
  settleLights,
  shownEta,
  sinName,
  TASK_LABELS,
  toolLabel,
  withOlder,
  withSteps,
} from "../../../../../web/next/src/lib/dashboard"
import { modelName } from "../../../../../web/next/src/lib/model-label"
import { inFixture, onLiveDashboard } from "../../../../dashboard-fixture"
import { OLD } from "../../../../session-names"

const entry = (id: string, at: string, text = id): Entry => ({
  at,
  from: null,
  id,
  kind: "assistant",
  text,
  tool: null,
})

// The row type, taken from the function itself: the API's source resolves its own @/ paths, which this test's config does not.
type Worker = Parameters<typeof sessionGroups>[0][number]

const session = (name: string, role: Worker["role"]) =>
  ({ name, role, sessionId: `s-${name}` }) as Worker

describe("liveState", () => {
  test("live while the socket is open; closed, connecting until a frame has ever come, then reconnecting", () => {
    expect(liveState(false, null)).toBe("Connecting")
    expect(liveState(true, null)).toBe("Live")
    expect(liveState(true, [])).toBe("Live")
    expect(liveState(false, [])).toBe("Reconnecting")
  })

  test("lost while the open socket's last frame is the sessions read's error; a closed socket is reconnecting whatever it last said", () => {
    const problem = { code: "SESSIONS_FAILED", message: "cmux refused the API's socket" }
    expect(liveState(true, [], problem)).toBe("Lost")
    expect(liveState(true, null, problem)).toBe("Lost")
    expect(liveState(false, [], problem)).toBe("Reconnecting")
  })
})

describe("LIGHT_LABELS", () => {
  test("every state is a capitalised label, waiting on you included", () => {
    expect(LIGHT_LABELS).toEqual({
      idle: "Idle",
      "needs-you": "Waiting on you",
      unknown: "State unknown",
      working: "Working",
    })
    for (const label of Object.values(LIGHT_LABELS)) expect(label).toMatch(/^\p{Lu}/u)
  })
})

describe("etaLabel", () => {
  const NOW = Date.parse("2026-10-06T12:00:00.000Z")
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

  test("the time left, to the nearest minute under an hour and to the nearest hour past it", () => {
    expect(etaLabel(at(20), NOW)).toBe("~20m")
    expect(etaLabel(at(20.2), NOW)).toBe("~20m")
    expect(etaLabel(at(20.6), NOW)).toBe("~21m")
    expect(etaLabel(at(0.25), NOW)).toBe("~1m")
    expect(etaLabel(at(0.01), NOW)).toBe("~1m")
    expect(etaLabel(at(59.5), NOW)).toBe("~1h")
    expect(etaLabel(at(60), NOW)).toBe("~1h")
    expect(etaLabel(at(89), NOW)).toBe("~1h")
    expect(etaLabel(at(90), NOW)).toBe("~2h")
    expect(etaLabel("2026-10-06T17:50:00+05:30", NOW)).toBe("~20m")
  })

  test("nothing once the time has come: the time left shows alone", () => {
    expect(etaLabel(at(0), NOW)).toBeNull()
    expect(etaLabel(at(-1), NOW)).toBeNull()
    expect(etaLabel(at(-600), NOW)).toBeNull()
  })

  test("nothing when there is no ETA or it is not a time, never a guess", () => {
    expect(etaLabel(null, NOW)).toBeNull()
    expect(etaLabel("", NOW)).toBeNull()
    expect(etaLabel("soon", NOW)).toBeNull()
  })
})

describe("shownEta", () => {
  const NOW = Date.parse("2026-10-06T12:00:00.000Z")
  const eta = "2026-10-06T12:20:00.000Z"

  test("a worker's, while it is working or waiting on you", () => {
    expect(shownEta({ eta, role: "worker", state: "working" }, NOW)).toBe("~20m")
    expect(shownEta({ eta, role: "worker", state: "needs-you" }, NOW)).toBe("~20m")
  })

  test("none while idle or down, for a runner, a manager or the dispatcher, or with no ETA", () => {
    expect(shownEta({ eta, role: "worker", state: "idle" }, NOW)).toBeNull()
    expect(shownEta({ eta, role: "worker", state: "down" }, NOW)).toBeNull()
    expect(shownEta({ eta, role: "runner", state: "working" }, NOW)).toBeNull()
    expect(shownEta({ eta, role: "manager", state: "working" }, NOW)).toBeNull()
    expect(shownEta({ eta, role: "dispatcher", state: "working" }, NOW)).toBeNull()
    expect(shownEta({ eta: null, role: "worker", state: "working" }, NOW)).toBeNull()
  })
})

describe("isProbe and checkerOf", () => {
  test("probe-<what> is a probe; a bare prefix is not", () => {
    expect(isProbe("probe-history")).toBe(true)
    expect(isProbe("probe-")).toBe(false)
    expect(isProbe("k3m9px-probe")).toBe(true)
    expect(isProbe("k3m9px-worker")).toBe(false)
    expect(isProbe("worker-greed")).toBe(false)
  })

  test("reviewer-<sin> and tester-<sin>, suffixed or not, are checkers", () => {
    expect(checkerOf("reviewer-envy")).toBe("reviewer")
    expect(checkerOf("tester-gluttony-97")).toBe("tester")
    expect(checkerOf("worker-envy")).toBeNull()
    expect(checkerOf("reviewer-")).toBeNull()
  })

  test("the roster's kind decides before the name, and an <id>-<kind> name is read by its last word", () => {
    expect(checkerOf("b7k2mq-reviewer", "reviewer")).toBe("reviewer")
    expect(checkerOf("anything", "tester")).toBe("tester")
    expect(checkerOf("reviewer-envy", "worker")).toBeNull()
    expect(checkerOf("b7k2mq-tester")).toBe("tester")
    expect(checkerOf("b7k2mq-worker")).toBeNull()
    expect(checkerOf("my-reviewer")).toBeNull()
  })
})

describe("nestCheckers", () => {
  type Row = {
    name: string
    pr: number | null
    kind?: string
    state: "down" | "idle" | "needs-you" | "working"
    worker?: string
  }
  const facts = {
    kind: (r: Row) => r.kind ?? null,
    name: (r: Row) => r.name,
    pr: (r: Row) => r.pr,
    state: (r: Row) => r.state,
    worker: (r: Row) => r.worker ?? null,
  }
  const r = (name: string, state: Row["state"] = "idle", pr: number | null = null): Row => ({
    name,
    pr,
    state,
  })
  const names = (rows: ReturnType<typeof nestCheckers<Row>>) =>
    rows.map(({ lead, members }) => [lead.name, members.map((m) => m.name)])

  test("each reviewer and tester nests under worker-<sin>, keeping the board's order", () => {
    const rows = nestCheckers(
      [r("worker-envy"), r("reviewer-envy"), r("worker-greed"), r("tester-envy")],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-envy", ["reviewer-envy", "tester-envy"]],
      ["worker-greed", []],
    ])
  })

  test("a checker named by its kind nests under the worker its roster names, and a worker's kind keeps an old checker name a lead", () => {
    const rows = nestCheckers(
      [
        r("k3v9q2-worker"),
        { ...r("b7k2mq-reviewer"), kind: "reviewer", worker: "k3v9q2-worker" },
        { ...r("x7mh4d-sentry"), kind: "tester", worker: "k3v9q2-worker" },
        { ...r("reviewer-odd"), kind: "worker" },
      ],
      facts,
    )
    expect(names(rows)).toEqual([
      ["k3v9q2-worker", ["b7k2mq-reviewer", "x7mh4d-sentry"]],
      ["reviewer-odd", []],
    ])
  })

  test("a kindless <id>-<kind> checker nests by its name's last word under the worker its roster names", () => {
    const rows = nestCheckers(
      [r("k3v9q2-worker"), { ...r("b7k2mq-reviewer"), worker: "k3v9q2-worker" }],
      facts,
    )
    expect(names(rows)).toEqual([["k3v9q2-worker", ["b7k2mq-reviewer"]]])
  })

  test("the pull request pairs it where it differs from the name: the roster's pr, else a number after the sin", () => {
    const rows = nestCheckers(
      [
        r("worker-envy", "idle", 97),
        r("worker-gluttony", "idle", 98),
        r("reviewer-gluttony-97"),
        r("tester-wrath", "idle", 98),
      ],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-envy", ["reviewer-gluttony-97"]],
      ["worker-gluttony", ["tester-wrath"]],
    ])
  })

  test("a respawned worker's checkers nest under it by name, whatever follows: the longest worker name wins", () => {
    const rows = nestCheckers(
      [
        r("worker-sloth"),
        r("worker-sloth-2"),
        r("reviewer-sloth-2-sendtop"),
        r("tester-sloth-2"),
        r("reviewer-sloth-fix"),
      ],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-sloth", ["reviewer-sloth-fix"]],
      ["worker-sloth-2", ["reviewer-sloth-2-sendtop", "tester-sloth-2"]],
    ])
  })

  test("a name matches a worker's whole name only, never part of a word", () => {
    expect(names(nestCheckers([r("worker-sloth-2"), r("reviewer-sloth-20")], facts))).toEqual([
      ["worker-sloth-2", []],
      ["reviewer-sloth-20", []],
    ])
  })

  test("the roster's worker key names the worker outright, ahead of the pull request and the name", () => {
    const rows = nestCheckers(
      [
        r("worker-envy", "idle", 97),
        r("worker-greed-2"),
        { ...r("reviewer-wrath-3", "idle", 97), worker: "worker-greed-2" },
      ],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-envy", []],
      ["worker-greed-2", ["reviewer-wrath-3"]],
    ])
  })

  test("a worker key naming a worker that is not live trusts the roster's pr alone, never a name guess", () => {
    const rows = nestCheckers(
      [
        r("worker-sloth"),
        r("worker-envy", "idle", 97),
        { ...r("reviewer-sloth-2-sendtop"), worker: "worker-sloth-2" },
        { ...r("tester-sloth-2", "idle", 97), worker: "worker-sloth-2" },
      ],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-sloth", []],
      ["worker-envy", ["tester-sloth-2"]],
      ["reviewer-sloth-2-sendtop", []],
    ])
  })

  test("a respawned worker's whole name outranks a respawn counter read as a pull request", () => {
    const rows = nestCheckers(
      [r("worker-envy", "idle", 2), r("worker-sloth-2", "idle", 263), r("tester-sloth-2")],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-envy", []],
      ["worker-sloth-2", ["tester-sloth-2"]],
    ])
  })

  test("a reviewer or tester whose worker is gone leads its own row", () => {
    expect(names(nestCheckers([r("reviewer-sloth"), r("worker-greed")], facts))).toEqual([
      ["reviewer-sloth", []],
      ["worker-greed", []],
    ])
  })

  test("a checker nests under a roster worker whose session is gone: by its worker key, else by the pull request", () => {
    expect(
      names(
        nestCheckers(
          [{ ...r("worker-envy", "down", 104) }, { ...r("reviewer-envy"), worker: "worker-envy" }],
          facts,
        ),
      ),
    ).toEqual([["worker-envy", ["reviewer-envy"]]])
    expect(
      names(nestCheckers([r("worker-envy", "down", 104), r("tester-envy", "idle", 104)], facts)),
    ).toEqual([["worker-envy", ["tester-envy"]]])
  })

  test("a checker whose roster worker names its lead nests under the lead, wherever its group sits", () => {
    const rows = nestCheckers(
      [r(OLD.builder), { ...r("tester-train"), worker: OLD.builder }, r("worker-greed")],
      facts,
    )
    expect(names(rows)).toEqual([
      [OLD.builder, ["tester-train"]],
      ["worker-greed", []],
    ])
  })

  test("a light blinking idle between steps moves no row: the board's order (set on steady lights) stands", () => {
    const rows = nestCheckers([r("worker-greed", "idle"), r("worker-lust", "working")], facts)
    expect(names(rows)).toEqual([
      ["worker-greed", []],
      ["worker-lust", []],
    ])
  })

  test("a member waiting on Merritt lifts its worker's row above working and idle ones, and groupState says so", () => {
    const rows = nestCheckers(
      [r("worker-greed", "working"), r("worker-envy"), r("tester-envy", "needs-you")],
      facts,
    )
    expect(names(rows)).toEqual([
      ["worker-envy", ["tester-envy"]],
      ["worker-greed", []],
    ])
    expect(groupState(rows[0]!, facts.state)).toBe("needs-you")
    expect(groupState(rows[1]!, facts.state)).toBe("working")
  })

  test("Orchestrators keep the given order even when one waits on Merritt, while Subagents still wait-sort", () => {
    const ranked = {
      ...facts,
      group: (row: Row) => (new Set<string>(Object.values(OLD)).has(row.name) ? 0 : 1),
    }
    const rows = nestCheckers(
      [
        r(OLD.builder),
        r(OLD.dispatcher, "needs-you"),
        r("worker-greed", "working"),
        r("worker-envy", "needs-you"),
      ],
      ranked,
    )
    expect(names(rows)).toEqual([
      [OLD.builder, []],
      [OLD.dispatcher, []],
      ["worker-envy", []],
      ["worker-greed", []],
    ])
  })
})

describe("nestState", () => {
  const live = (light: "idle" | "needs-you" | "working", paused = false) => ({
    light,
    ...(paused && { usageLimit: { resets: null, resetsAt: null } }),
  })

  test("a row the usage limit alone holds reads paused, and something of yours still reads waiting", () => {
    expect(nestState("needs-you", true, false)).toBe("paused")
    expect(nestState("needs-you", true, true)).toBe("needs-you")
    expect(nestState("working", false, false)).toBe("working")
  })

  test("a usage-paused worker stays below a working one, while a waiting one moves up", () => {
    const rows = [
      { name: "worker-envy", w: live("working") },
      { name: "worker-greed", w: live("needs-you", true) },
      { name: "worker-lust", w: live("needs-you") },
    ]
    const nested = nestCheckers(rows, {
      kind: () => null,
      name: (r) => r.name,
      pr: () => null,
      state: (r) => nestState(r.w.light, Boolean(r.w.usageLimit), false),
      worker: () => null,
    })
    expect(nested.map(({ lead }) => lead.name)).toEqual([
      "worker-lust",
      "worker-envy",
      "worker-greed",
    ])
  })
})

describe("TASK_LABELS", () => {
  test("a subagent is Done when it finishes, a process Exited; every word is capitalised", () => {
    expect(TASK_LABELS.agent.done).toBe("Done")
    expect(TASK_LABELS.process.done).toBe("Exited")
    for (const kind of Object.values(TASK_LABELS))
      for (const word of Object.values(kind)) expect(word).toMatch(/^\p{Lu}/u)
  })
})

describe("sinName", () => {
  test("a reviewer or tester keeps its role, since it shares its worker's sin", () => {
    expect(sinName(session("reviewer-envy", "worker"))).toBe("ReviewerEnvy")
    expect(sinName(session("tester-gluttony-97", "worker"))).toBe("TesterGluttony97")
  })

  test("drops the role prefix its group already says and capitalises the rest", () => {
    expect(sinName(session("worker-greed", "worker"))).toBe("Greed")
    expect(sinName(session("runner-pride", "runner"))).toBe("Pride")
    expect(sinName(session(OLD.dispatcher, "dispatcher"))).toBe("Alpha")
    expect(sinName(session(OLD.builder, "manager"))).toBe("Builder")
    expect(sinName(session("worker-constructor", "worker"))).toBe("Constructor")
  })

  test("keeps a prefix that does not match the session's role, and a bare prefix", () => {
    expect(sinName(session("runner-pride", "worker"))).toBe("RunnerPride")
    expect(sinName(session("worker-", "worker"))).toBe("Worker")
    expect(sinName(session("probe-paste", "worker"))).toBe("ProbePaste")
  })

  test("an <id>-<kind> name reads as agentLabel reads it, a checker keeping its role", () => {
    expect(sinName(session("k3m9px-worker", "worker"))).toBe("K3m9px")
    expect(sinName(session("b7k2mq-runner", "runner"))).toBe("B7k2mq")
    expect(sinName(session("h4t8wz-reviewer", "worker"))).toBe("H4t8wzReviewer")
  })
})

describe("rowTitle", () => {
  test("is the roster's triaged title, else the first ask, else says there is no task yet", () => {
    const greed = {
      ...session("worker-greed", "worker"),
      task: "Build the composer",
      title: `Message ${OLD.dispatcher} from the dashboard`,
    }
    expect(rowTitle(greed)).toBe(`Message ${OLD.dispatcher} from the dashboard`)
    expect(rowTitle({ ...greed, title: null })).toBe("Build the composer")
    expect(rowTitle({ ...greed, task: null, title: null })).toBe("No task yet")
    expect(rowTitle({ ...session(OLD.dispatcher, "dispatcher"), task: null, title: null })).toBe(
      "Hands each task to a worker",
    )
  })
})

const live = (name: string, light: Worker["light"], fields: Partial<Worker> = {}): Worker =>
  ({
    light,
    name,
    role: "worker",
    sessionId: `s-${name}`,
    startedAt: null,
    ...fields,
  }) as Worker

describe("settleLights", () => {
  const at = (light: Worker["light"]) => [live("worker-a", light)]

  test("a new session's light counts at once", () => {
    const { lights, wakeAt } = settleLights(new Map(), at("idle"), 1000)
    expect(lights.get("s-worker-a")?.light).toBe("idle")
    expect(wakeAt).toBeNull()
  })

  test("a new light waits until it has held, so a row stays put through a short pause", () => {
    const start = settleLights(new Map(), at("working"), 0).lights
    const paused = settleLights(start, at("idle"), 1000)
    expect(paused.lights.get("s-worker-a")?.light).toBe("working")
    expect(paused.wakeAt).toBe(1000 + LIGHT_HOLD_MS)
    const resumed = settleLights(paused.lights, at("working"), 2000)
    expect(resumed.lights.get("s-worker-a")?.light).toBe("working")
    expect(resumed.wakeAt).toBeNull()
  })

  test("a light that holds counts once the hold is up", () => {
    const start = settleLights(new Map(), at("working"), 0).lights
    const paused = settleLights(start, at("idle"), 1000).lights
    expect(
      settleLights(paused, at("idle"), 1000 + LIGHT_HOLD_MS - 1).lights.get("s-worker-a")?.light,
    ).toBe("working")
    const settled = settleLights(paused, at("idle"), 1000 + LIGHT_HOLD_MS)
    expect(settled.lights.get("s-worker-a")?.light).toBe("idle")
    expect(settled.wakeAt).toBeNull()
  })

  test("waiting on you counts at once", () => {
    const start = settleLights(new Map(), at("working"), 0).lights
    expect(settleLights(start, at("needs-you"), 1).lights.get("s-worker-a")?.light).toBe(
      "needs-you",
    )
  })

  test("leaving waiting on you counts at once, since it means he answered", () => {
    const start = settleLights(new Map(), at("needs-you"), 0).lights
    const answered = settleLights(start, at("working"), 1)
    expect(answered.lights.get("s-worker-a")?.light).toBe("working")
    expect(answered.wakeAt).toBeNull()
    const quiet = settleLights(start, at("idle"), 1)
    expect(quiet.lights.get("s-worker-a")?.light).toBe("idle")
  })

  test("a session that ended is dropped", () => {
    const start = settleLights(new Map(), at("working"), 0).lights
    expect(settleLights(start, [], 1).lights.size).toBe(0)
  })
})

// a board frame that moves no light hands the same map on, so nothing reading it draws again
describe("keepSettled", () => {
  const at = (light: Worker["light"]) => [live("worker-a", light)]

  test("a frame that moved no light keeps the lights it had", () => {
    const start = settleLights(new Map(), at("working"), 0)
    expect(keepSettled(start, settleLights(start.lights, at("working"), 500))).toBe(start)
  })

  test("a light that moved hands the new lights on", () => {
    const start = settleLights(new Map(), at("working"), 0)
    const next = settleLights(start.lights, at("needs-you"), 500)
    expect(keepSettled(start, next)).toBe(next)
  })

  test("a new hold hands the new wake on", () => {
    const start = settleLights(new Map(), at("working"), 0)
    const next = settleLights(start.lights, at("idle"), 500)
    expect(keepSettled(start, next)).toBe(next)
  })
})

describe("agentGroup", () => {
  test("a dispatcher, which the API gives the roster's manager role, goes under Dispatchers by its kind, live or down", () => {
    expect(agentGroup({ kind: "dispatcher", role: "manager" })).toBe("Dispatchers")
    expect(agentGroup({ kind: "builder", role: "manager" })).toBe("Orchestrators")
    expect(agentGroup({ kind: "worker", role: "worker" })).toBe("Subagents")
    expect(agentGroup({ kind: null, role: "other" })).toBe("Other")
  })

  // a demoted duplicate reads as other, and the sidebar puts it in Other
  test("a demoted duplicate dispatcher, read as other, goes under Other as its sidebar row does", () => {
    expect(agentGroup({ kind: "dispatcher", role: "other" })).toBe("Other")
  })
})

describe("sessionGroups", () => {
  // The sidebar groups as ZeroSDK's does, Orchestrators and Subagents, then the factory's AI Runners, Scripts and Other
  // the dispatchers have a group of their own
  test("the dispatchers under Dispatchers, then the managers under Orchestrators, then Subagents, then AI Runners, then Scripts, which holds no session, each in the board's order", () => {
    const board = [
      session(OLD.dispatcher, "dispatcher"),
      session(OLD.builder, "manager"),
      session(OLD.ops, "manager"),
      session("worker-pride", "worker"),
      session("runner-pride", "runner"),
      session("worker-greed", "worker"),
      session("runner-sloth", "runner"),
    ]
    expect(sessionGroups(board).map((g) => [g.label, g.sessions.map((w) => w.name)])).toEqual([
      ["Dispatchers", [OLD.dispatcher]],
      ["Orchestrators", [OLD.builder, OLD.ops]],
      ["Subagents", ["worker-pride", "worker-greed"]],
      ["AI Runners", ["runner-pride", "runner-sloth"]],
      ["Scripts", []],
    ])
  })

  test("Dispatchers, Orchestrators, Subagents, AI Runners and Scripts are there even when nobody is in them; Other only holds strays", () => {
    expect(sessionGroups([]).map((g) => [g.label, g.sessions.length])).toEqual([
      ["Dispatchers", 0],
      ["Orchestrators", 0],
      ["Subagents", 0],
      ["AI Runners", 0],
      ["Scripts", 0],
    ])
  })

  test("a session outside the factory's names goes to Other, after Scripts, not Subagents", () => {
    const board = [session("worker-greed", "worker"), session("session e73f9d9c", "other")]
    expect(sessionGroups(board).map((g) => [g.label, g.sessions.map((w) => w.name)])).toEqual([
      ["Dispatchers", []],
      ["Orchestrators", []],
      ["Subagents", ["worker-greed"]],
      ["AI Runners", []],
      ["Scripts", []],
      ["Other", ["session e73f9d9c"]],
    ])
  })
})

describe("heldCount", () => {
  type Item = { name: string; session: boolean }
  const live = (name: string): Item => ({ name, session: true })
  const isSession = (item: Item) => item.session

  test("a label counts every session its rows hold, the reviewers and testers nested under them included", () => {
    const rows = [
      { lead: live("worker-pride"), members: [live("reviewer-pride"), live("tester-pride")] },
      { lead: live("worker-greed"), members: [] },
    ]
    expect(heldCount(rows, isSession)).toBe(4)
  })

  test("a checker whose worker is gone counts once, since its muted roster row is no session", () => {
    const rows = [
      { lead: { name: "worker-envy", session: false }, members: [live("reviewer-envy")] },
    ]
    expect(heldCount(rows, isSession)).toBe(1)
    expect(heldCount([], isSession)).toBe(0)
  })
})

describe("longIdle", () => {
  const NOW = Date.parse("2026-10-06T12:00:00.000Z")
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  test("idle for over three hours since it last did anything", () => {
    expect(longIdle("idle", ago(OTHER_IDLE_MS + 60_000), NOW)).toBe(true)
    expect(longIdle("idle", ago(OTHER_IDLE_MS - 60_000), NOW)).toBe(false)
  })

  test("a session at work or waiting on you, or one with no time known, is never long idle", () => {
    expect(longIdle("working", ago(OTHER_IDLE_MS * 8), NOW)).toBe(false)
    expect(longIdle("needs-you", ago(OTHER_IDLE_MS * 8), NOW)).toBe(false)
    expect(longIdle("idle", null, NOW)).toBe(false)
  })
})

describe("otherRows", () => {
  // a: kept (waits on you), b: recent, c and d: long idle
  const items = ["a", "b", "c", "d"]
  const view = (open: boolean, showIdle: boolean) => ({
    idle: (item: string) => item === "c" || item === "d",
    keep: (item: string) => item === "a",
    open,
    showIdle,
  })

  test("collapsed, only the kept rows show, and the long idle ones are counted", () => {
    expect(otherRows(items, view(false, false))).toEqual({ idle: 2, rows: ["a"] })
  })

  test("open, the rest show but for the long idle ones, until Show idle", () => {
    expect(otherRows(items, view(true, false))).toEqual({ idle: 2, rows: ["a", "b"] })
    expect(otherRows(items, view(true, true))).toEqual({ idle: 2, rows: ["a", "b", "c", "d"] })
  })

  test("keepsOther keeps a session waiting on Merritt by its light or an open inbox item, or open in the view", () => {
    expect(keepsOther("needs-you", false, false)).toBe(true)
    expect(keepsOther("idle", true, false)).toBe(true)
    expect(keepsOther("working", false, true)).toBe(true)
    expect(keepsOther("idle", false, false)).toBe(false)
  })

  test("collapsed, a session at a prompt and a long-idle one with an open inbox item both show", () => {
    const NOW = Date.parse("2026-10-06T12:00:00.000Z")
    const old = new Date(NOW - OTHER_IDLE_MS * 2).toISOString()
    const rows = [
      { waits: 0, at: null, id: "prompt", state: "needs-you" as const },
      { waits: 1, at: old, id: "asked", state: "idle" as const },
      { waits: 0, at: old, id: "stale", state: "idle" as const },
    ]
    const shown = otherRows(rows, {
      idle: (row) => longIdle(row.state, row.at, NOW),
      keep: (row) => keepsOther(row.state, row.waits > 0, false),
      open: false,
      showIdle: false,
    })
    expect([shown.idle, shown.rows.map((row) => row.id)]).toEqual([1, ["prompt", "asked"]])
  })

  test("a kept row that is long idle shows and is not counted", () => {
    const kept = { ...view(false, false), keep: (item: string) => item === "c" }
    expect(otherRows(items, kept)).toEqual({ idle: 1, rows: ["c"] })
  })
})

// The shipped fixture, read by the API's own listLive and agentsBoard in a process of its own, as a fixture stack's sidebar and dashboard receive it: a screenshot of one shows every group and every state.
describe.skipIf(onLiveDashboard())("the default fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-fixture-groups-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))
  const read = inFixture(
    `const { listLive } = await import(\`\${API}/lib/dashboard/workers\`)
const { agentsBoard } = await import(\`\${API}/lib/dashboard/agents\`)
const live = await listLive()
const board = await agentsBoard(async () => live)
console.log(JSON.stringify({ agents: board.agents, board: board.agents.map((a) => [a.name, a.state]), workers: live.workers }))
process.exit(0)
`,
    dir,
  )
  const fixture = async () => {
    const { code, result, stderr } = await read
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
    return result as {
      agents: {
        kind: string | null
        name: string
        pr: { number: number } | null
        role: string
        sessionId: string | null
        state: string
        status: string | null
        worker: string | null
      }[]
      board: [string, string][]
      workers: Worker[]
    }
  }

  test("fills every sidebar group that holds sessions", async () => {
    const { workers } = await fixture()
    const groups = sessionGroups(workers)
    expect(groups.length).toBeGreaterThan(0)
    // Scripts holds the ops jobs, never a session
    expect(groups.filter((g) => g.sessions.length === 0).map((g) => g.label)).toEqual(["Scripts"])
  }, 60_000)

  test("shows a session in each light, a reviewer, a tester and a name outside the factory's, and an agent that is down", async () => {
    const { board, workers } = await fixture()
    expect(new Set(workers.map((w) => w.light))).toEqual(
      new Set(["idle", "needs-you", "unknown", "working"]),
    )
    const names = workers.map((w) => w.name)
    for (const name of [
      "h4n8zt-reviewer",
      "p9c3wx-tester",
      "scratch-demo",
      "k3m9px-worker",
      "q7w8f2-reviewer",
    ])
      expect(names).toContain(name)
    expect(board).toContainEqual(["worker-wrath", "down"])
  }, 60_000)

  test("its GLM session is a working worker carrying the model id, which rows name GLM 5.3 Flash", async () => {
    const { workers } = await fixture()
    const glm = workers.find((w) => w.name === "worker-glm-flash")
    expect(glm?.model).toBe("glm-5.3-flash[1m]")
    expect(glm?.light).toBe("working")
    expect(modelName(glm?.model ?? null)).toBe("GLM 5.3 Flash")
  }, 60_000)

  test("nests its checkers under their worker, a gone worker's under its roster row, and a lead's own under the lead, as both views place them", async () => {
    const { agents, workers } = await fixture()
    const agentOf = (name: string) => agents.find((a) => a.name === name)
    // the callers' items: live sessions but the dispatcher's, plus roster workers whose session is gone
    const items = [
      ...workers.filter((w) => w.role === "manager"),
      ...workers.filter((w) => w.role === "worker"),
      ...agents.filter((a) => a.sessionId === null && a.state === "down" && a.role === "worker"),
    ]
    const nested = (rows: { name: string }[]) =>
      nestCheckers(rows, {
        kind: (row) => agentOf(row.name)?.kind ?? null,
        name: (row) => row.name,
        pr: (row) => agentOf(row.name)?.pr?.number ?? null,
        state: () => "idle",
        worker: (row) => agentOf(row.name)?.worker ?? null,
      })
        .filter(({ members }) => members.length > 0)
        .map(({ lead, members }) => [lead.name, members.map((m) => m.name).toSorted()])
    const lust = ["worker-lust-2", ["h4n8zt-reviewer", "p9c3wx-tester"]]
    const envy = ["worker-envy", ["b7k2mq-reviewer"]]
    const train = ["builder", ["r6t2dv-tester"]]
    const titles = ["k3m9px-worker", ["q7w8f2-reviewer"]]
    expect(agentOf("b7k2mq-reviewer")?.worker).toBe("worker-envy")
    expect(agentOf("b7k2mq-reviewer")?.kind).toBe("reviewer")
    expect(agentOf("worker-envy")?.status).toBe("parked")
    expect(agentOf("worker-envy")?.sessionId).toBeNull()
    // this call reads every state as idle, so the rows keep the board's input order, where k3m9px-worker comes ahead of worker-lust-2
    expect(nested(items)).toEqual([train, titles, lust, envy])
    // over live sessions alone, envy's reviewer has no lead: the roster row takes it in for the callers' list, and the sidebar draws no roster-only checker
    expect(nested(workers.filter((w) => w.role === "worker"))).toEqual([titles, lust])
  }, 60_000)

  // One stream carries a Markdown table, so a round that checks Streamdown's tables appends nothing to a fixture session.
  test("its dispatcher's stream holds a Markdown table", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../../../api/hono/src/fixtures/dashboard.json"),
        "utf8",
      ),
    ) as { files: Record<string, unknown[]> }
    const lines =
      fixture.files["projects/-fixture-playground/11111111-1111-4111-8111-000000000001.jsonl"] ?? []
    const entries = lines.flatMap((line) => parseLine(JSON.stringify(line)))
    const table = entries.find((e) => e.kind === "assistant" && e.text.includes("| Lane |"))
    expect(table?.text).toContain("| Lane | Work | State |")
    expect(table?.text).toContain("| --- | --- | --- |")
    expect(table?.text).toContain("| Boards | The Linear app |")
    expect(table?.text).toContain("| Sidebar | The worker lights |")
  })
})

describe("mergeEntries", () => {
  test("a live frame that races the initial fetch is not shown twice, and order follows the transcript", () => {
    const fetched = [entry("a", "2026-10-06T10:00:00Z"), entry("b", "2026-10-06T10:00:01Z")]
    const live = [entry("b", "2026-10-06T10:00:01Z"), entry("c", "2026-10-06T10:00:02Z")]
    expect(mergeEntries(fetched, live).map((e) => e.id)).toEqual(["a", "b", "c"])
    expect(mergeEntries(live, fetched).map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  test("a message queued mid-turn keeps its place in the transcript, though its time is when it was queued", () => {
    const shown = [
      { ...entry("his", "2026-10-13T11:48:10Z"), kind: "human" as const },
      entry("bash1", "2026-10-13T11:48:16Z"),
      entry("result1", "2026-10-13T11:48:24Z"),
    ]
    const live = [
      { ...entry("peer", "2026-10-13T11:48:15Z"), kind: "peer" as const },
      entry("bash2", "2026-10-13T11:48:39Z"),
    ]
    expect(mergeEntries(shown, live).map((e) => e.id)).toEqual([
      "his",
      "bash1",
      "result1",
      "peer",
      "bash2",
    ])
    expect(
      mergeEntries(shown, live.slice(0, 1))
        .map((e) => e.id)
        .at(-1),
    ).toBe("peer")
  })

  test("what shares no step goes after the older list, whatever its times; a shared step places what is new around it", () => {
    const older = [entry("a", "2026-10-06T10:00:03Z"), entry("b", "2026-10-06T10:00:04Z")]
    const newer = [entry("c", "2026-10-06T10:00:00Z"), entry("d", "2026-10-06T10:00:01Z")]
    expect(mergeEntries(older, newer).map((e) => e.id)).toEqual(["a", "b", "c", "d"])
    const fetched = [
      entry("b", "2026-10-06T10:00:01Z"),
      entry("q", "2026-10-06T10:00:00Z"),
      entry("c", "2026-10-06T10:00:02Z"),
    ]
    expect(mergeEntries([fetched[2]!], fetched).map((e) => e.id)).toEqual(["b", "q", "c"])
  })

  test("keeps only the newest 400", () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      entry(`e${i}`, new Date(Date.UTC(2026, 9, 6, 10, 0, i)).toISOString()),
    )
    const merged = mergeEntries([], many)
    expect(merged).toHaveLength(400)
    expect(merged[0]?.id).toBe("e50")
  })

  test("keeps the newest steps whole, so Load older pages on from the oldest one shown", () => {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, i)).toISOString()
    const many = [
      { ...entry("h0", at(0)), kind: "human" as const, text: "go" },
      ...Array.from({ length: 450 }, (_, i) => entry(`e${i}`, at(i + 1))),
    ]
    expect(mergeEntries([], many).map((e) => e.id)).toEqual(many.slice(-400).map((e) => e.id))
  })

  test("keeps older steps that were asked for: keep grows by what was loaded", () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      entry(`e${i}`, new Date(Date.UTC(2026, 9, 6, 10, 0, i)).toISOString()),
    )
    expect(mergeEntries([], many, 450)).toHaveLength(450)
  })
})

describe("toolLabel", () => {
  test("an MCP tool reads as server and tool; any other tool as itself", () => {
    expect(toolLabel("mcp__slack-shared__conversations_history")).toBe(
      "slack-shared · conversations_history",
    )
    expect(toolLabel("Bash")).toBe("Bash")
    expect(toolLabel(null)).toBe("")
  })
})

describe("reconnectDelay", () => {
  test("doubles from 2s with each failure and stops at 30s", () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe("oneLine", () => {
  test("a short line is left as it is, with its whitespace folded", () => {
    expect(oneLine("Fix the  reminder\n twice")).toBe("Fix the reminder twice")
  })

  test("a long line is cut at a word before the limit and ends in an ellipsis", () => {
    const long = `Task from ${OLD.dispatcher}, for Ivo. Thread: https://acme.slack.com/archives/C0EXAMPLE01/p1791225532654419`
    const line = oneLine(long, 40)
    expect(line).toBe(`Task from ${OLD.dispatcher}, for Ivo. Thread:…`)
    expect(line.length).toBeLessThanOrEqual(40)
  })

  test("a cut inside a word backs up to the word before it", () => {
    expect(oneLine("The quick brown fox jumps over the lazy dog again and again", 30)).toBe(
      "The quick brown fox jumps…",
    )
  })

  test("a cut inside a link backs up to before the link", () => {
    const ask = `Task from ${OLD.dispatcher}, for Ivo. Thread: https://acme.slack.com/archives/C0EXAMPLE01/p1791225532654419`
    expect(oneLine(ask)).toBe(`Task from ${OLD.dispatcher}, for Ivo. Thread:…`)
  })

  test("a wrapped link, Slack's <url|label> or in parentheses, is cut before too", () => {
    const slack =
      "See the thread <https://acme.slack.com/archives/C0EXAMPLE01/p1|here> and fix it soon please"
    expect(oneLine(slack, 60)).toBe("See the thread…")
    expect(oneLine("Fix it (https://acme.slack.com/archives/C0EXAMPLE01/p1) today", 40)).toBe(
      "Fix it…",
    )
  })

  test("a hard cut counts characters, so it never splits an emoji", () => {
    expect(oneLine(`${"x".repeat(18)}👍👍👍`, 20)).toBe(`${"x".repeat(18)}👍…`)
  })

  test("a single unbroken word is cut at the limit", () => {
    expect(oneLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`)
  })
})

describe("remarkLineBreaks", () => {
  type Node = { children?: Node[]; type: string; value?: string }
  const run = (tree: Node) => {
    remarkLineBreaks()(tree)
    return tree
  }

  test("each newline in typed text becomes a line break, in nested text too", () => {
    const tree = run({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "line one\nline two\n\nafter a blank" },
            { type: "emphasis", children: [{ type: "text", value: "a\nb" }] },
          ],
        },
      ],
    })
    expect(tree.children?.[0]?.children).toEqual([
      { type: "text", value: "line one" },
      { type: "break" },
      { type: "text", value: "line two" },
      { type: "break" },
      { type: "break" },
      { type: "text", value: "after a blank" },
      {
        type: "emphasis",
        children: [{ type: "text", value: "a" }, { type: "break" }, { type: "text", value: "b" }],
      },
    ])
  })

  test("a lone CR or a CRLF breaks a line as \\n does", () => {
    const tree = run({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "a\rb\r\nc" }] }],
    })
    expect(tree.children?.[0]?.children).toEqual([
      { type: "text", value: "a" },
      { type: "break" },
      { type: "text", value: "b" },
      { type: "break" },
      { type: "text", value: "c" },
    ])
  })

  test("code keeps its own lines, and text with no newline is untouched", () => {
    const code = { type: "code", value: "a\nb" }
    const inline = { type: "inlineCode", value: "x\ny" }
    const plain = { type: "text", value: "one line" }
    const tree = run({
      type: "root",
      children: [code, { type: "paragraph", children: [inline, plain] }],
    })
    expect(tree.children).toEqual([code, { type: "paragraph", children: [inline, plain] }])
  })
})

describe("dispatchersOf", () => {
  const opus = { name: OLD.dispatcher, role: "dispatcher", sessionId: "s-opus" }
  const glm = { name: `${OLD.dispatcher}-2`, role: "dispatcher", sessionId: "s-glm" }
  const kid = { name: OLD.builder, role: "manager", sessionId: "s-kid" }
  type Workers = Parameters<typeof dispatchersOf>[0]

  test("the dispatcher role's sessions as a list, in the order the API names them, whatever the board's order", () => {
    const slots = dispatchersOf([kid, glm, opus] as Workers, [
      OLD.dispatcher,
      `${OLD.dispatcher}-2`,
    ])
    expect(slots.map((slot) => slot.worker?.sessionId ?? null)).toEqual(["s-opus", "s-glm"])
  })

  // #i520: "Each row keeps its slot while its session is down, reading Not running"
  test("the primary keeps its slot while its session is down, with no session in it", () => {
    expect(dispatchersOf([glm] as Workers, [OLD.dispatcher, `${OLD.dispatcher}-2`])).toEqual([
      { name: OLD.dispatcher, worker: null },
      { name: `${OLD.dispatcher}-2`, worker: glm as never },
    ])
    expect(dispatchersOf(null, [OLD.dispatcher])).toEqual([{ name: OLD.dispatcher, worker: null }])
  })

  // Not every machine runs a second dispatcher, so its slot follows what is live.
  test("no second dispatcher live or in the roster: no second slot", () => {
    expect(dispatchersOf([opus, kid] as Workers, [OLD.dispatcher, `${OLD.dispatcher}-2`])).toEqual([
      { name: OLD.dispatcher, worker: opus as never },
    ])
    expect(
      dispatchersOf(
        [opus] as Workers,
        [OLD.dispatcher, `${OLD.dispatcher}-2`],
        [{ name: OLD.builder, status: "working" }],
      ),
    ).toHaveLength(1)
  })

  test.each(["parked", "working", null])(
    "a second dispatcher the roster lists as %p but no live session holds keeps a slot with no session, to read Not running",
    (status) => {
      expect(
        dispatchersOf(
          [opus] as Workers,
          [OLD.dispatcher, `${OLD.dispatcher}-2`],
          [{ name: `${OLD.dispatcher}-2`, status }],
        ),
      ).toEqual([
        { name: OLD.dispatcher, worker: opus as never },
        { name: `${OLD.dispatcher}-2`, worker: null },
      ])
    },
  )

  // An ended second dispatcher with no live session draws no row, so the sidebar shows no Bravo the machine has ended (#850).
  test.each(["done", "ended"])(
    "a second dispatcher the roster marks %s, with no live session, keeps no slot",
    (status) => {
      expect(
        dispatchersOf(
          [opus] as Workers,
          [OLD.dispatcher, `${OLD.dispatcher}-2`],
          [{ name: `${OLD.dispatcher}-2`, status }],
        ),
      ).toEqual([{ name: OLD.dispatcher, worker: opus as never }])
    },
  )

  test("a live second dispatcher keeps its slot while the roster still marks it ended", () => {
    expect(
      dispatchersOf(
        [opus, glm] as Workers,
        [OLD.dispatcher, `${OLD.dispatcher}-2`],
        [{ name: `${OLD.dispatcher}-2`, status: "ended" }],
      ).map((s) => s.worker),
    ).toEqual([opus as never, glm as never])
  })

  test("a live second dispatcher takes its slot with its session, roster or not", () => {
    expect(
      dispatchersOf([glm, opus] as Workers, [OLD.dispatcher, `${OLD.dispatcher}-2`]).map(
        (s) => s.worker,
      ),
    ).toEqual([opus as never, glm as never])
  })

  test("a session of a dispatcher's name that does not hold the role takes no slot", () => {
    const demoted = { ...glm, role: "other", sessionId: "s-glm-2" }
    expect(dispatchersOf([demoted] as Workers, [`${OLD.dispatcher}-2`])[0]?.worker).toBeNull()
  })

  test("the primary is the first name's, also while the second leads the board or is the only one live", () => {
    expect(dispatcherOf([glm, opus] as Workers, OLD.dispatcher)?.sessionId).toBe("s-opus")
    expect(dispatcherOf([glm] as Workers, OLD.dispatcher)).toBeNull()
    expect(pickWorker(null, [glm, opus] as Workers, OLD.dispatcher)).toBe("s-opus")
    expect(pickWorker(null, [glm] as Workers, OLD.dispatcher)).toBeNull()
    expect(pickWorker("s-glm", [glm, opus] as Workers, OLD.dispatcher)).toBe("s-glm")
  })
})

describe("pickWorker", () => {
  const live = [{ sessionId: "s-1" }, { sessionId: "s-2" }] as Parameters<typeof pickWorker>[1]

  test("the session ?worker= names while it is live", () => {
    expect(pickWorker("s-2", live)).toBe("s-2")
  })

  test("the dispatcher, by its role, when nothing is asked for or the session has ended", () => {
    const withDispatcher = [
      { role: "manager", sessionId: "s-1" },
      { role: "dispatcher", sessionId: "s-d" },
    ] as Parameters<typeof pickWorker>[1]
    expect(pickWorker(null, withDispatcher)).toBe("s-d")
    expect(pickWorker("s-9", withDispatcher)).toBe("s-d")
    expect(pickWorker("s-1", withDispatcher)).toBe("s-1")
  })

  test("none when no dispatcher is live, or the list has not come", () => {
    expect(pickWorker(null, live)).toBeNull()
    expect(pickWorker("s-9", live)).toBeNull()
    expect(pickWorker("s-1", null)).toBeNull()
  })
})

const at = (i: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, i)).toISOString()
const steps = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => entry(`e${from + i}`, at(from + i)))

describe("history", () => {
  test("an older page lands only for the request that asked for it", () => {
    const loading = {
      ...withSteps(historyOf("s1"), steps(100, 300)),
      older: "loading" as const,
      request: 2,
    }
    const page = { before: 50, entries: steps(0, 100), hasMore: true, kind: "page" as const }
    expect(withOlder(loading, 1, page)).toBe(loading)
    const landed = withOlder(loading, 2, page)
    expect([landed.list.length, landed.keep, landed.cursor, landed.older]).toEqual([
      300,
      500,
      50,
      "idle",
    ])
    expect(withOlder(loading, 2, { ...page, entries: [], hasMore: false }).older).toBe("done")
    expect(withOlder(loading, 2, { kind: "missing" }).older).toBe("missing")
    expect(withOlder(loading, 2, { kind: "error" }).older).toBe("error")
  })

  test("once older steps are loaded, new steps grow what is kept rather than pushing them out", () => {
    const loaded = withOlder(
      { ...withSteps(historyOf("s1"), steps(100, 300)), older: "loading", request: 1 },
      1,
      { before: 0, entries: steps(0, 100), hasMore: false, kind: "page" },
    )
    const later = withSteps(loaded, steps(300, 700))
    expect([later.list.length, later.list[0]?.id, later.older]).toEqual([700, "e0", "done"])
  })

  test("a trim that drops the oldest steps restarts paging from the oldest one shown", () => {
    const full = withSteps(historyOf("s1"), steps(0, 400))
    const done = { ...full, cursor: 7, older: "done" as const }
    const trimmed = withSteps(done, steps(400, 410))
    expect([trimmed.list[0]?.id, trimmed.cursor, trimmed.older]).toEqual(["e10", null, "idle"])
    expect(withSteps(done, steps(0, 5))).toMatchObject({ cursor: 7, older: "done" })
  })

  test("an older page goes above the steps shown whatever its times: a split line's earlier block, or before a queued message", () => {
    const loading = (list: Entry[]) => ({
      ...withSteps(historyOf("s1"), list),
      older: "loading" as const,
      request: 1,
    })
    const page = (entries: Entry[]) => ({
      before: null,
      entries,
      hasMore: true,
      kind: "page" as const,
    })
    const split = loading([entry("X:1", at(5)), entry("Y", at(6)), entry("W", at(7))])
    expect(withOlder(split, 1, page([entry("X:0", at(5))])).list.map((e) => e.id)).toEqual([
      "X:0",
      "X:1",
      "Y",
      "W",
    ])
    const queued = loading([
      { ...entry("peer", "2026-10-13T11:48:15Z"), kind: "peer" as const },
      entry("bash2", "2026-10-13T11:48:39Z"),
    ])
    const earlier = page([
      { ...entry("his", "2026-10-13T11:48:10Z"), kind: "human" as const },
      entry("bash1", "2026-10-13T11:48:16Z"),
      entry("result1", "2026-10-13T11:48:24Z"),
    ])
    expect(withOlder(queued, 1, earlier).list.map((e) => e.id)).toEqual([
      "his",
      "bash1",
      "result1",
      "peer",
      "bash2",
    ])
  })

  test("frames that beat the initial fetch stay after it, a queued message included", () => {
    const framed = withSteps(
      withSteps(fetchAsked(historyOf("s1")), [entry("x", "2026-10-13T11:48:24Z")]),
      [{ ...entry("peer", "2026-10-13T11:48:15Z"), kind: "peer" as const }],
    )
    expect(framed.list.map((e) => e.id)).toEqual(["x", "peer"])
    const fetched = [
      entry("w", "2026-10-13T11:48:16Z"),
      entry("x", "2026-10-13T11:48:24Z"),
      { ...entry("peer", "2026-10-13T11:48:15Z"), kind: "peer" as const },
    ]
    expect(withSteps(framed, fetched, { fetched: true }).list.map((e) => e.id)).toEqual([
      "w",
      "x",
      "peer",
    ])
    const early = withSteps(fetchAsked(historyOf("s1")), [entry("z", "2026-10-13T11:49:00Z")])
    expect(withSteps(early, fetched, { fetched: true }).list.map((e) => e.id)).toEqual([
      "w",
      "x",
      "peer",
      "z",
    ])
  })

  test("a refetch after a gap keeps the new steps: what was shown when it was asked goes before it, frames since after it", () => {
    const shown = withSteps(historyOf("s1"), steps(0, 400))
    const asked = fetchAsked(shown)
    const framed = withSteps(asked, steps(900, 902))
    const refetched = withSteps(framed, steps(500, 900), { fetched: true })
    expect([refetched.list[0]?.id, refetched.list.at(-1)?.id, refetched.list.length]).toEqual([
      "e502",
      "e901",
      400,
    ])
    expect(refetched.framed).toBeNull()
    const again = withSteps(fetchAsked(shown), steps(399, 400))
    expect(withSteps(again, steps(300, 400), { fetched: true }).list.at(-1)?.id).toBe("e399")
  })

  test("a trim while an older page loads drops that page, so no step between them is skipped", () => {
    const full = withSteps(historyOf("s1"), steps(100, 500))
    const loading = { ...full, older: "loading" as const, request: 1 }
    const trimmed = withSteps(loading, steps(500, 503))
    expect([trimmed.list[0]?.id, trimmed.older, trimmed.cursor]).toEqual(["e103", "idle", null])
    const late = withOlder(trimmed, 1, {
      before: 0,
      entries: steps(0, 100),
      hasMore: false,
      kind: "page",
    })
    expect(late).toBe(trimmed)
  })
})

describe("afterFrame", () => {
  const failure = { code: "SESSIONS_FAILED", message: "cmux sessions failed: no answer from cmux" }
  const clear = { misses: 0, problem: null }

  test("one failed read raises nothing", () => {
    expect(afterFrame(clear, failure)).toEqual({ misses: 1, problem: null })
  })

  test("the second failure in a row raises the problem, with its reason", () => {
    expect(afterFrame(afterFrame(clear, failure), failure)).toEqual({ misses: 2, problem: failure })
  })

  test("a raised problem holds through a reconnect's replayed failure, until a board reads", () => {
    const raised = afterFrame(afterFrame(clear, failure), failure)
    const reconnected = { misses: 0, problem: raised.problem }
    expect(afterFrame(reconnected, failure).problem).toEqual(failure)
    expect(afterFrame(reconnected, null).problem).toBeNull()
  })

  test("a board that reads clears it, and the count starts again", () => {
    const raised = afterFrame(afterFrame(clear, failure), failure)
    const recovered = afterFrame(raised, null)
    expect(recovered).toEqual(clear)
    expect(afterFrame(recovered, failure).problem).toBeNull()
  })
})
