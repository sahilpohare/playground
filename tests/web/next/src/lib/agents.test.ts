import { describe, expect, test } from "bun:test"

import type { Entry } from "../../../../../api/hono/src/lib/dashboard/transcript"
import {
  AGENTS_MESSAGE_COALESCE_MS,
  coalesce,
  doingOf,
  firstLine,
  firstLineOf,
  liveAgents,
  orderByStatus,
  rowLines,
  rowText,
  runnerWhen,
  sentMessage,
  sessionsKey,
  statusOf,
  statusParts,
  ticketOf,
  timeLeft,
  waitsOf,
} from "../../../../../web/next/src/lib/agents"
import { LIGHT_LABELS, STUCK } from "../../../../../web/next/src/lib/dashboard"

// The API's types reach the web through @api/hono, which only the web resolves; its own source uses an @/ this config cannot follow, so they are read off the function that takes them.
type Agent = Parameters<typeof liveAgents>[0][number]
type Worker = NonNullable<Parameters<typeof liveAgents>[1]>[number]

const NOW = Date.parse("2026-10-06T12:00:00.000Z")

const entry = (at: string, kind: Entry["kind"], fields: Partial<Entry> = {}): Entry => ({
  at,
  from: null,
  id: `${kind}-${at}`,
  kind,
  text: `${kind} at ${at}`,
  tool: kind === "tool" ? "Bash" : null,
  ...fields,
})

const agent = (name: string, fields: Partial<Agent> = {}): Agent => ({
  branch: null,
  branchTicket: null,
  eta: null,
  kind: null,
  lastActivityAt: "2026-10-06T10:00:00.000Z",
  name,
  parked: null,
  pr: null,
  pullProblem: null,
  report: null,
  role: "worker",
  schedule: null,
  sessionId: `s-${name}`,
  state: "working",
  status: null,
  task: null,
  ticket: null,
  title: null,
  worker: null,
  workspace: null,
  ...fields,
})

const worker = (name: string, light: Worker["light"], fields: Partial<Worker> = {}): Worker => ({
  cwd: `/repo/${name}`,
  effort: null,
  eta: null,
  failed: false,
  feed: [],
  lastActiveAt: null,
  lifecycle: "running",
  light,
  model: null,
  name,
  questions: [],
  role: "worker",
  sessionId: `s-${name}`,
  startedAt: null,
  task: null,
  tasks: [],
  title: null,
  updatedAt: null,
  workspace: null,
  ...fields,
})

describe("sentMessage", () => {
  test("a SendMessage call to anyone asks for a fresh read; other steps do not", () => {
    expect(sentMessage([entry("t", "tool", { tool: "SendMessage" })])).toBe(true)
    expect(
      sentMessage([entry("t", "tool"), entry("t", "assistant", { text: "SendMessage" })]),
    ).toBe(false)
  })
})

describe("sessionsKey", () => {
  test("changes when a session starts, ends, is renamed or moves, not when it pauses", () => {
    const base = sessionsKey([worker("worker-a", "working"), worker("worker-b", "idle")])
    expect(sessionsKey([worker("worker-b", "working"), worker("worker-a", "idle")])).toBe(base)
    expect(sessionsKey([worker("worker-a", "working")])).not.toBe(base)
    expect(sessionsKey([{ ...worker("worker-a", "working"), cwd: "/elsewhere" }])).not.toBe(
      sessionsKey([worker("worker-a", "working")]),
    )
    expect(sessionsKey(null)).toBe("")
  })
})

describe("liveAgents", () => {
  test("the socket's light wins; a session it no longer lists is down; a roster-only agent stays down", () => {
    const agents = [
      agent("worker-a"),
      agent("worker-b"),
      agent("worker-c", { sessionId: null, state: "down" }),
    ]
    const live = liveAgents(agents, [worker("worker-a", "needs-you")])
    expect(live.map((a) => [a.name, a.state])).toEqual([
      ["worker-a", "needs-you"],
      ["worker-b", "down"],
      ["worker-c", "down"],
    ])
  })

  test("before the socket's first list, each group ranks by the API's state, in the API's order within one", () => {
    const agents = [
      agent("worker-a", { state: "idle" }),
      agent("worker-b", { sessionId: null, state: "down" }),
      agent("worker-c", { state: "needs-you" }),
      agent("worker-d"),
      agent("worker-e"),
    ]
    expect(liveAgents(agents, null).map((a) => a.name)).toEqual([
      "worker-c",
      "worker-d",
      "worker-e",
      "worker-a",
      "worker-b",
    ])
  })

  test("before the socket's first list, the API's state stands", () => {
    expect(liveAgents([agent("worker-a", { state: "idle" })], null)[0]?.state).toBe("idle")
  })

  test("in the sidebar's order: managers, workers, runners; each group as the dashboard's board holds it, then the down ones", () => {
    const agents = [
      agent("runner-pride", { role: "runner" }),
      agent("worker-d", { sessionId: null, state: "down" }),
      agent("worker-c"),
      agent("worker-b"),
      agent("worker-e"),
      agent("dispatcher", { role: "manager" }),
    ]
    const board = orderByStatus(
      [
        worker("runner-pride", "working", { role: "runner" }),
        worker("worker-c", "idle"),
        worker("worker-b", "working"),
        worker("worker-e", "working"),
        worker("dispatcher", "idle", { role: "dispatcher" }),
      ],
      agents,
      new Map(),
      new Set(),
      NOW,
    )
    // Working before idle whatever the times; a tie keeps the board's order; the session that is down last.
    expect(liveAgents(agents, board).map((a) => a.name)).toEqual([
      "dispatcher",
      "worker-b",
      "worker-e",
      "worker-c",
      "worker-d",
      "runner-pride",
    ])
  })

  test("managers go by the socket's rank, the dispatcher first, whatever the roster's order", () => {
    const agents = [
      agent("ops", { role: "manager" }),
      agent("builder", { role: "manager" }),
      agent("dispatcher", { role: "manager" }),
      agent("lightgone", { role: "manager", sessionId: null, state: "down" }),
    ]
    const workers = ["dispatcher", "builder", "ops"].map((name) => worker(name, "idle"))
    expect(liveAgents(agents, workers).map((a) => a.name)).toEqual([
      "dispatcher",
      "builder",
      "ops",
      "lightgone",
    ])
    expect(liveAgents(agents, null).map((a) => a.name)).toEqual([
      "ops",
      "builder",
      "dispatcher",
      "lightgone",
    ])
  })

  test("groups go as the sidebar's: managers, workers, runners, then a session outside the factory's names", () => {
    const agents = [
      agent("stray", { role: "other" }),
      agent("runner-pride", { role: "runner" }),
      agent("worker-a"),
      agent("builder", { role: "manager" }),
    ]
    expect(liveAgents(agents, null).map((a) => a.name)).toEqual([
      "builder",
      "worker-a",
      "runner-pride",
      "stray",
    ])
  })

  test("a worker that comes to need you moves first", () => {
    const agents = [agent("worker-a"), agent("worker-b")]
    const workers = [worker("worker-a", "working"), worker("worker-b", "needs-you")]
    expect(
      liveAgents(agents, orderByStatus(workers, agents, new Map(), new Set(), NOW)).map(
        (a) => a.name,
      ),
    ).toEqual(["worker-b", "worker-a"])
  })
})

type Pull = NonNullable<Agent["pr"]>
const pull = (fields: Partial<Pull> = {}): Pull => ({
  approvals: 0,
  ci: "passing",
  draft: false,
  number: 36,
  queued: false,
  reviewed: false,
  round: null,
  score: null,
  state: "open",
  tester: null,
  title: "",
  updatedAt: null,
  url: "https://github.com/acme/archive/pull/36",
  verdict: null,
  ...fields,
})

describe("statusOf", () => {
  const phrase = (fields: Partial<Agent>) => statusOf(agent("worker-a", fields), NOW)

  test("a worker whose pull request merged reads Merged, even once its session has closed", () => {
    expect(phrase({ pr: pull({ state: "merged" }), state: "down" }).text).toBe("Merged")
    expect(phrase({ pr: pull({ state: "merged" }), role: "runner", state: "down" }).text).toBe(
      "Down",
    )
  })

  test("a checker's merged pull request is its worker's, so it reads its own state", () => {
    const merged = { pr: pull({ state: "merged" }) }
    expect(statusOf(agent("reviewer-a", { ...merged, state: "down" }), NOW).text).toBe("Down")
    expect(statusOf(agent("reviewer-a", { ...merged, state: "idle" }), NOW).text).toBe("Idle")
  })

  test("an agent the roster closed reads Ended, muted; one that went without being closed, Down", () => {
    expect(phrase({ state: "down", status: "ended" })).toEqual({ text: "Ended", tone: "muted" })
    expect(phrase({ state: "down", status: "working" })).toEqual({ text: "Down", tone: "muted" })
    expect(phrase({ state: "idle", status: "ended" }).text).toBe("Idle")
    expect(phrase({ state: "working", status: "ended" }).text).toBe("Working")
  })

  // A stuck session reads red, since it needs someone at once.
  test("any session but Playground's that a prompt holds is Stuck; only Playground's own is on you", () => {
    for (const role of ["manager", "runner", "worker"] as const)
      expect(statusOf(agent("a", { role, state: "needs-you" }), NOW).text).toBe(STUCK)
    expect(
      statusOf(agent("dispatcher", { role: "manager", state: "needs-you" }), NOW, null, true).text,
    ).toBe("Waiting on you")
  })

  test("the words of each state, the quiet ones muted", () => {
    expect(phrase({ state: "working" })).toEqual({ text: "Working", tone: "normal" })
    expect(phrase({ state: "idle" })).toEqual({ text: "Idle", tone: "muted" })
    expect(phrase({ pr: pull({ ci: "failing" }) }).text).toBe("Fixing")
    expect(phrase({ pr: pull({ score: "5/5" }), state: "idle" }).text).toBe("Ready")
    expect(phrase({ pr: pull({ approvals: 2 }), state: "idle" }).text).toBe("Waiting on approvals")
    expect(phrase({ parked: "held", state: "idle" })).toEqual({ text: "Parked", tone: "muted" })
    expect(phrase({ pr: pull({ state: "closed" }), state: "idle" }).text).toBe("Idle")
    expect(phrase({ pr: pull({ ci: "pending" }), state: "idle" }).text).toBe("Waiting on CI")
  })

  test("the board's facts: its held light, an API error, a hung turn, a checker at work", () => {
    const a = agent("worker-a", { state: "working" })
    expect(statusOf(a, NOW, null, false, { light: "idle" }).text).toBe("Idle")
    const failed = worker("worker-a", "idle", { failed: true })
    expect(statusOf(a, NOW, null, false, { worker: failed }).text).toBe("Failing")
    const hung = worker("worker-a", "working", { lastActiveAt: "2026-10-06T11:00:00.000Z" })
    expect(statusOf(a, NOW, null, false, { worker: hung }).text).toBe("No progress")
    expect(
      statusOf(agent("worker-a", { state: "idle" }), NOW, null, false, { checkers: true }).text,
    ).toBe("Waiting on checks")
  })

  test("no ETA anywhere: working, stuck, merged, idle, down, a runner, a manager, or an unknown one, since estimates read as promises the sidebar cannot keep", () => {
    const eta = "2026-10-06T12:20:00.000Z"
    expect(phrase({ eta, state: "working" })).toEqual({ text: "Working", tone: "normal" })
    expect(phrase({ eta, state: "needs-you" }).text).toBe(STUCK)
    expect(phrase({ eta, pr: pull({ state: "merged" }) }).text).toBe("Merged")
    expect(phrase({ eta, state: "idle" }).text).toBe("Idle")
    expect(phrase({ eta, state: "down" }).text).toBe("Down")
    expect(phrase({ eta, role: "runner" }).text).toBe("Working")
    expect(phrase({ eta, role: "manager" }).text).toBe("Working")
    expect(phrase({ eta: "soon", state: "working" }).text).toBe("Working")
  })
})

describe("waitsOf", () => {
  test("what an agent still waits on, the most telling first", () => {
    const tasks: Worker["tasks"] = [
      {
        endedAt: null,
        id: "t1",
        kind: "agent",
        label: "x",
        startedAt: "",
        state: "running",
        taskId: null,
      },
      {
        endedAt: null,
        id: "t2",
        kind: "process",
        label: "y",
        startedAt: "",
        state: "running",
        taskId: null,
      },
    ]
    const a = agent("worker-a", { pr: pull({ ci: "pending", queued: true }) })
    expect(
      waitsOf(
        a,
        { checkers: true, worker: worker("worker-a", "idle", { tasks }) },
        { id: "i", ref: 1 },
      ),
    ).toEqual(["checks", "ci", "queue", "helper", "job", "inbox"])
    expect(waitsOf(agent("worker-a"))).toEqual([])
  })

  test("a queued pull request still short of approvals waits on them, not the queue; a finished task waits on nothing", () => {
    expect(waitsOf(agent("worker-a", { pr: pull({ approvals: 1, queued: true }) }))).toEqual([])
    const done: Worker["tasks"] = [
      {
        endedAt: "x",
        id: "t1",
        kind: "agent",
        label: "x",
        startedAt: "",
        state: "done",
        taskId: null,
      },
    ]
    expect(
      waitsOf(agent("worker-a"), { worker: worker("worker-a", "idle", { tasks: done }) }),
    ).toEqual([])
  })

  test("a runner whose job runs as a background task reads Working, not Waiting on a job", () => {
    const job: Worker["tasks"] = [
      {
        endedAt: null,
        id: "t1",
        kind: "process",
        label: "bun run dev",
        startedAt: "",
        state: "running",
        taskId: null,
      },
    ]
    const runner = agent("runner-pride", { role: "runner", state: "idle" })
    const live = { worker: worker("runner-pride", "idle", { role: "runner", tasks: job }) }
    expect(statusParts(runner, NOW, null, false, live).state).toBe("working")
    expect(statusParts(runner, NOW).state).toBe("idle")
    // a Codex runner, whose idle reads unknown, still reads Working while its job runs
    const codex = {
      light: "unknown" as const,
      worker: worker("runner-pride", "unknown", { role: "runner", tasks: job }),
    }
    expect(statusParts(runner, NOW, null, false, codex).state).toBe("working")
    // a quiet runner whose job runs is not hung: No progress reads the session's own work alone
    const quiet = {
      worker: worker("runner-pride", "idle", {
        lastActiveAt: "2026-10-06T10:00:00.000Z",
        role: "runner",
        tasks: job,
      }),
    }
    expect(statusParts(runner, NOW, null, false, quiet).state).toBe("working")
    // a worker's own background job still reads Waiting on a job
    expect(
      statusParts(agent("worker-a", { state: "idle" }), NOW, null, false, {
        worker: worker("worker-a", "idle", { tasks: job }),
      }).text,
    ).toBe("Waiting on a job")
  })

  test("a reviewer's or tester's pull request is its worker's, so its CI is not its wait", () => {
    expect(waitsOf(agent("reviewer-a", { pr: pull({ ci: "pending" }) }))).toEqual([])
  })
})

describe("statusParts' hover detail", () => {
  test("the review round while it waits on checks, the approvals still needed, why it is parked", () => {
    const idle = { state: "idle" as const }
    expect(
      statusParts(agent("worker-a", { ...idle, pr: pull({ round: 2 }) }), NOW, null, false, {
        checkers: true,
      }).detail,
    ).toBe("review round 2")
    expect(
      statusParts(agent("worker-a", { ...idle, pr: pull({ approvals: 1 }) }), NOW).detail,
    ).toBe("1 approval still needed")
    expect(
      statusParts(agent("worker-a", { ...idle, parked: "held until reset" }), NOW).detail,
    ).toBe("held until reset")
    expect(statusParts(agent("worker-a"), NOW).detail).toBeNull()
  })

  test("a session the usage limit holds reads Paused · usage limit, with its reset on hover", () => {
    const paused = (usageLimit: Worker["usageLimit"]) =>
      statusParts(agent("worker-a", { state: "needs-you" }), NOW, null, false, {
        worker: worker("worker-a", "needs-you", { usageLimit }),
      })
    const dialog = paused({ resets: "3am (Asia/Calcutta)", resetsAt: null })
    expect(dialog.state).toBe("usage-limit")
    expect(dialog.text).toBe("Paused · usage limit")
    // muted, as Parked's words are, since nothing needs anyone
    expect(dialog.tone).toBe("muted")
    expect(dialog.detail).toBe("resets 3am (Asia/Calcutta)")
    expect(paused({ resets: null, resetsAt: "2026-10-07T23:00:00.000Z" }).detail).toStartWith(
      "resets ",
    )
    expect(paused({ resets: null, resetsAt: null }).detail).toBeNull()
  })
})

describe("timeLeft", () => {
  const at = "2026-10-06T12:20:00.000Z"
  const left = (fields: Partial<Agent> = {}, live: Record<string, unknown> = {}) =>
    timeLeft(agent("worker-a", { eta: at, ...fields }), NOW, live)

  test("a working or stuck worker shows the time its eta holds", () => {
    expect(left({ state: "working" })).toBe("~20m")
    expect(left({ state: "needs-you" })).toBe("~20m")
  })

  test("a merged worker is off the clock even while its roster eta stands, so is one paused on a usage limit", () => {
    expect(left({ pr: pull({ state: "merged" }) })).toBeNull()
    const paused = worker("worker-a", "needs-you", {
      usageLimit: { resets: "3am (Asia/Calcutta)", resetsAt: null },
    })
    expect(left({ state: "needs-you" }, { worker: paused })).toBeNull()
  })

  test("the held light decides, not the raw state; a runner never shows one", () => {
    expect(left({ state: "idle" }, { light: "working" })).toBe("~20m")
    expect(left({ state: "working" }, { light: "idle" })).toBeNull()
    expect(left({ role: "runner", state: "working" })).toBeNull()
  })
})

describe("doingOf", () => {
  test("the roster title, else the first ask, else what the dispatcher does", () => {
    expect(
      doingOf(agent("worker-a", { task: "Long first ask", title: "Short title" }), false),
    ).toBe("Short title")
    expect(doingOf(agent("worker-a", { task: "Long first ask" }), false)).toBe("Long first ask")
    expect(doingOf(agent("dispatcher", { role: "manager" }), true)).toBe(
      "Hands each task to a worker",
    )
    expect(doingOf(agent("builder", { role: "manager" }), false)).toBe("No task yet")
    expect(doingOf(agent("probe-a"), false)).toBe("No task yet")
  })
})

describe("status words", () => {
  test("every phrase starts with a capital", () => {
    const states: Agent["state"][] = ["down", "idle", "needs-you", "working"]
    const roles: Agent["role"][] = ["manager", "runner", "worker"]
    const prs = [
      null,
      ...(["closed", "merged", "open"] as const).map((state) =>
        pull({ reviewed: true, score: "4/5", state }),
      ),
    ]
    for (const state of states)
      for (const role of roles)
        for (const pr of prs)
          for (const status of ["working", "ended"])
            for (const eta of [null, "2026-10-06T11:00:00.000Z", "2026-10-06T13:00:00.000Z"]) {
              const { text } = statusOf(agent("a", { eta, pr, role, state, status }), NOW)
              for (const word of text.split(" · "))
                expect(word.charAt(0)).toBe(word.charAt(0).toUpperCase())
            }
    expect(statusOf(agent("dispatcher", { role: "manager", state: "idle" }), NOW).text).toBe(
      LIGHT_LABELS.idle,
    )
  })
})

describe("rowLines and rowText", () => {
  const pr = pull({
    number: 197,
    reviewed: true,
    score: "5/5",
    url: "https://github.com/o/r/pull/197",
  })
  const greed = worker("worker-greed", "working", {
    effort: "high",
    eta: "2026-10-06T12:20:00.000Z",
    model: "claude-opus-5-5",
    title: "Dashboard home",
  })

  test("a session with a kind leads with its label, its pull request's number in its colour, then the title it does not repeat", () => {
    const lines = rowLines(
      greed,
      agent("worker-greed", { kind: "worker", pr, ticket: "MADENOVA-1234" }),
      NOW,
    )
    expect([lines.ticket, lines.pr, lines.kind, lines.title]).toEqual([
      "MADENOVA-1234",
      197,
      null,
      "Dashboard home",
    ])
    // A worker's title carries no role word.
    expect(rowText(lines).first).toBe("MADENOVA-1234#197 Dashboard home")
    expect(rowText(lines).prClass).toBe("text-success")
  })

  test("a checker's label takes its worker's ticket and pull request, a manager's is its role word alone, and the title leads before there is either, its kind after it", () => {
    const lead = agent("worker-greed", { branchTicket: "PG-12", kind: "worker", pr })
    const reviewer = agent("b7k2mq-reviewer", {
      kind: "reviewer",
      title: "Review it",
      worker: "worker-greed",
    })
    expect(firstLine(firstLineOf(reviewer, "Review it", lead))).toBe("PG-12#197 Reviewer Review it")
    // Its role word alone, with no roster title
    expect(
      firstLine(firstLineOf(agent("ops", { kind: "ops", pr, ticket: "PG-1" }), "Ops lead", null)),
    ).toBe("Ops")
    expect(
      firstLine(firstLineOf(agent("worker-greed", { kind: "worker" }), "Row wrap", null)),
    ).toBe("Row wrap")
    expect(firstLine(firstLineOf(null, "Row wrap", null))).toBe("Row wrap")
  })

  test("the ticket and pull request joined, then the title, over the model, the effort and the state, each after a separator, with the name and the time on the hover alone", () => {
    const lines = rowLines(
      greed,
      agent("worker-greed", { eta: "2026-10-06T12:20:00.000Z", pr, ticket: "MADENOVA-1234" }),
      NOW,
    )
    expect(lines).toEqual({
      detail: null,
      effort: "high",
      eta: "~20m",
      kind: null,
      model: "Opus 5.5",
      pr: 197,
      shown: "working",
      state: "Working",
      ticket: "MADENOVA-1234",
      title: "Dashboard home",
      tone: "ready",
      when: null,
    })
    expect(rowText(lines)).toEqual({
      first: "MADENOVA-1234#197 Dashboard home",
      prClass: "text-success",
      prWords: "PR ready: 5/5 at its head",
      second: "Opus 5.5 high · Working",
    })
  })

  test("the model reads before the status, so a glance down the sidebar lines up the models", () => {
    const lines = rowLines(greed, agent("worker-greed", { pr }), NOW)
    expect(lines.model).toBe("Opus 5.5")
    expect(lines.effort).toBe("high")
    expect(rowText(lines).second).toBe("Opus 5.5 high · Working")
  })

  test("a model without an effort reads before the status alone; no model, no effort", () => {
    expect(
      rowText(rowLines(worker("worker-greed", "working", { model: "claude-opus-5-5" }), null, NOW))
        .second,
    ).toBe("Opus 5.5 · Working")
    expect(rowText(rowLines(worker("worker-greed", "working"), null, NOW)).second).toBe("Working")
  })

  test("the title's own leading copy of an id the row shows goes, so the row never shows it twice", () => {
    const lines = rowLines(
      worker("worker-greed", "working", {
        model: "claude-opus-5-5",
        title: "MADEPLUM-2582 rent figure",
      }),
      agent("worker-greed", {
        pr: { ...pr, number: 151, url: "https://github.com/o/r/pull/151" },
        ticket: "MADEPLUM-2582",
      }),
      NOW,
    )
    expect(lines.title).toBe("rent figure")
    expect(rowText(lines).first).toBe("MADEPLUM-2582#151 rent figure")
  })

  test("a title leading with both, the ask's way, keeps one of each", () => {
    const lines = rowLines(
      worker("worker-greed", "working", { title: "#197 MADENOVA-1234 Dashboard home" }),
      agent("worker-greed", { pr, ticket: "MADENOVA-1234" }),
      NOW,
    )
    expect(lines.title).toBe("Dashboard home")
    expect(rowText(lines).first).toBe("MADENOVA-1234#197 Dashboard home")
  })

  test("a title never repeats a number the line shows: the PG ticket's issue as #N, at its start or its end (the row that read PG-1104#1112 #1104 touched)", () => {
    const lines = (title: string) =>
      rowLines(
        worker("worker-a", "working", { title }),
        agent("worker-a", {
          branch: "pg-1104-touched",
          // the API reads the branch's ticket (branchTicketOf)
          branchTicket: "PG-1104",
          pr: pull({ number: 1112 }),
          title,
        }),
        NOW,
      )
    expect(rowText(lines("#1104 touched files")).first).toBe("PG-1104#1112 touched files")
    expect(lines("PG-1104: touched files").title).toBe("touched files")
    expect(lines("touched files (#1112)").title).toBe("touched files")
    expect(lines("touched files #1104").title).toBe("touched files")
    // a number the line does not show, or one inside a longer number, stays
    expect(lines("#11045 touched files").title).toBe("#11045 touched files")
    expect(lines("touched #1104 files").title).toBe("touched #1104 files")
  })

  test("an id the row does not show stays in the title", () => {
    const lines = rowLines(
      worker("worker-greed", "working", { title: "#151 MADEPLUM-2582 rent figure" }),
      agent("worker-greed", { pr }),
      NOW,
    )
    expect(lines.title).toBe("#151 MADEPLUM-2582 rent figure")
    expect(rowText(lines).first).toBe("#197 #151 MADEPLUM-2582 rent figure")
  })

  test("the time left is a working or stuck worker's alone, and none once it passes", () => {
    expect(
      rowLines(greed, agent("worker-greed", { eta: "2026-10-06T12:20:00.000Z", pr }), NOW).eta,
    ).toBe("~20m")
    const stuck = worker("worker-greed", "needs-you", { eta: "2026-10-06T12:20:00.000Z" })
    expect(rowLines(stuck, null, NOW).eta).toBe("~20m")
    const overdue = worker("worker-greed", "working", { eta: "2026-10-06T11:00:00.000Z" })
    expect(rowLines(overdue, null, NOW).eta).toBeNull()
    const manager = {
      ...worker("builder", "working", { eta: "2026-10-06T12:20:00.000Z" }),
      role: "manager" as const,
    }
    expect(rowLines(manager, null, NOW).eta).toBeNull()
  })

  test("the row's icon follows its held light, not the raw one", () => {
    const idle = rowLines(greed, agent("worker-greed", { pr }), NOW, false, null, "idle")
    expect(idle.shown).toBe("ready")
    expect(idle.state).toBe("Ready")
    expect(idle.eta).toBeNull()
  })

  test("before the board is read, its own light stands", () => {
    const bare = worker("worker-greed", "working", { title: "Dashboard home" })
    expect(rowText(rowLines(bare, null, NOW))).toEqual({
      first: "Dashboard home",
      prClass: null,
      prWords: null,
      second: "Working",
    })
    expect(rowLines(bare, null, NOW).eta).toBeNull()
    expect(rowLines(worker("worker-greed", "needs-you"), null, NOW).shown).toBe("stuck")
  })

  test("a reviewer or tester reads the same set: working, stuck, idle, done", () => {
    const reviewer = worker("reviewer-greed", "working")
    expect(rowLines(reviewer, agent("reviewer-greed", { pr }), NOW).state).toBe("Working")
    const idle = worker("reviewer-greed", "idle")
    expect(rowLines(idle, agent("reviewer-greed", { pr, state: "idle" }), NOW).state).toBe("Done")
  })

  test("its pull request's colour, said in words on hover; a checker's row takes none", () => {
    const tone = (fields: Partial<Pull>) =>
      rowLines(greed, agent("worker-greed", { pr: { ...pr, ...fields } }), NOW).tone
    expect(tone({ ci: "failing" })).toBe("failing")
    expect(tone({ score: "4/5" })).toBe("review")
    expect(tone({ draft: true, reviewed: false, score: null })).toBe("draft")
    expect(tone({})).toBe("ready")
    expect(tone({ state: "merged" })).toBe("merged")
    expect(rowLines(greed, null, NOW).tone).toBeNull()
    expect(
      rowLines(worker("reviewer-greed", "working"), agent("reviewer-greed", { pr }), NOW).tone,
    ).toBeNull()
  })

  test("a reviewer or tester at work makes its worker's idle row wait on checks, with the round on hover", () => {
    const idle = worker("worker-greed", "idle")
    const lines = rowLines(
      idle,
      agent("worker-greed", { pr: { ...pr, round: 3, score: null }, state: "idle" }),
      NOW,
      true,
    )
    expect(lines.shown).toBe("waiting")
    expect(rowText(lines).second).toBe("Waiting on checks · review round 3")
    const dispatcher = { ...worker("dispatcher", "needs-you"), role: "dispatcher" as const }
    // the dispatcher keeps its label in its state (Inbox #i493), Alpha by default
    expect(rowLines(dispatcher, null, NOW).state).toBe(`Alpha · ${LIGHT_LABELS["needs-you"]}`)
    expect(rowLines(dispatcher, null, NOW).eta).toBeNull()
  })
})

describe("coalesce", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test("folds the agents re-reads a burst of messages asks for into one at once and one after", async () => {
    let runs = 0
    const reread = coalesce(() => runs++, 40)
    for (let i = 0; i < 50; i++) reread()
    expect(runs).toBe(1)
    await wait(60)
    expect(runs).toBe(2)
    await wait(60)
    expect(runs).toBe(2)
    reread()
    expect(runs).toBe(3)
    reread.cancel()
  })

  test("drops a pending run once cancelled", async () => {
    let runs = 0
    const reread = coalesce(() => runs++, 20)
    reread()
    reread()
    reread.cancel()
    await wait(40)
    expect(runs).toBe(1)
  })

  test("waits a few seconds between the reads messages ask for", () => {
    expect(AGENTS_MESSAGE_COALESCE_MS).toBe(5_000)
  })
})

// No factory session blocks on the owner (playbook's ask rule): one that posted a decision or draft it depends on reads Waiting on your inbox, orange, and one with nothing pending or running reads Idle.
describe("waiting on an inbox item", () => {
  const item = { id: "i-41", ref: 41 }

  test("an idle session that posted one waits on your inbox; one at work keeps working; a gone one waits on nothing", () => {
    expect(statusOf(agent("worker-a", { state: "idle" }), NOW, item)).toEqual({
      text: "Waiting on your inbox",
      tone: "normal",
    })
    expect(statusOf(agent("worker-a", { state: "working" }), NOW, item).text).toBe("Working")
    expect(statusOf(agent("worker-a", { state: "idle" }), NOW).text).toBe(LIGHT_LABELS.idle)
    expect(statusOf(agent("worker-a", { state: "down" }), NOW, item).text).toBe("Down")
  })

  test("rowLines reads it for the row, before and after the board is read", () => {
    const idle = worker("worker-greed", "idle")
    expect(rowLines(idle, null, NOW, false, item).state).toBe("Waiting on your inbox")
    expect(rowLines(idle, agent("worker-greed", { state: "idle" }), NOW, false, item).shown).toBe(
      "waiting",
    )
  })
})

// Workers sort by pull request number, then ticket number (AB-262#7 shape), then name, which replaced a status-then-recency sort.
describe("orderByStatus", () => {
  const board = (rows: [Worker, Agent][]) => ({
    agents: rows.map(([, a]) => a),
    workers: rows.map(([w]) => w),
  })
  const names = (workers: Worker[]) => workers.map((w) => w.name)
  const order = (
    rows: [Worker, Agent][],
    waiting: ReadonlySet<string> = new Set(),
    held: ReadonlyMap<string, Worker["light"]> = new Map(),
  ) => {
    const { agents, workers } = board(rows)
    return names(orderByStatus(workers, agents, held, waiting, NOW))
  }
  const row = (
    name: string,
    light: Worker["light"],
    fields: Partial<Agent> = {},
    own: Partial<Worker> = {},
  ): [Worker, Agent] => [
    worker(name, light, { lastActiveAt: "2026-10-06T11:59:00.000Z", ...own }),
    agent(name, { state: light, ...fields }),
  ]

  test("a mixed board ranks by the state its icon draws, the most urgent first, and what is over last", () => {
    expect(
      order([
        row("worker-merged", "idle", {
          pr: pull({ number: 1, state: "merged" }),
        }),
        row("worker-idle", "idle"),
        row("worker-parked", "idle", { parked: "held for a ship" }),
        row("worker-ready", "idle", { pr: pull({ number: 2, score: "5/5" }) }),
        row("worker-waiting", "idle", {
          pr: pull({ ci: "pending", number: 3 }),
        }),
        row("worker-working", "working"),
        row("worker-fixing", "working", {
          pr: pull({ ci: "failing", number: 4 }),
        }),
        row("worker-stuck", "needs-you"),
      ]),
    ).toEqual([
      "worker-stuck",
      "worker-fixing",
      "worker-working",
      "worker-waiting",
      "worker-ready",
      "worker-parked",
      "worker-idle",
      "worker-merged",
    ])
  })

  test("within one state: ticket then PR, then a PR alone, then neither, A to Z by title", () => {
    expect(
      order([
        row("worker-none-b", "working", { title: "Beta" }, { title: "Beta" }),
        row("worker-pr-184", "working", { pr: pull({ number: 184 }) }),
        row("worker-nova-12", "working", { ticket: "MADENOVA-12" }),
        row("worker-pg-12", "working", {
          pr: pull({ number: 173 }),
          ticket: "PG-12",
        }),
        row("worker-none-a", "working", { title: "Alpha" }, { title: "Alpha" }),
        row("worker-pr-118", "working", { pr: pull({ number: 118 }) }),
        row("worker-pg-9", "working", {
          pr: pull({ number: 199 }),
          ticket: "PG-9",
        }),
      ]),
    ).toEqual([
      "worker-nova-12",
      "worker-pg-9",
      "worker-pg-12",
      "worker-pr-118",
      "worker-pr-184",
      "worker-none-a",
      "worker-none-b",
    ])
  })

  test("a row waiting on you, at a card or on an inbox item it posted, ranks with Stuck", () => {
    expect(
      order(
        [row("worker-a", "working", { ticket: "PG-1" }), row("worker-b", "idle")],
        new Set(["s-worker-b"]),
      ),
    ).toEqual(["worker-b", "worker-a"])
  })

  test("a row the usage limit alone holds ranks with the idle rows, below Working", () => {
    expect(
      order([
        row("worker-idle", "idle", { ticket: "PG-1" }),
        row(
          "worker-paused",
          "needs-you",
          { ticket: "PG-2" },
          {
            usageLimit: { resets: "9:30am", resetsAt: "2026-10-06T11:00:00Z" },
          },
        ),
        row("worker-working", "working", { ticket: "PG-3" }),
        row("worker-stuck", "needs-you", { ticket: "PG-4" }),
      ]),
    ).toEqual(["worker-stuck", "worker-working", "worker-idle", "worker-paused"])
  })

  // a review: a checker only its roster kind marks counted as a lead here, so its worker ranked as idle while its row read Waiting on checks
  test("a checker its kind alone marks, under a bare name, makes its worker rank as waiting on checks", () => {
    expect(
      order([
        row("worker-b", "idle", { ticket: "PG-1" }),
        row("k3v9q2-worker", "idle", { kind: "worker", ticket: "PG-2" }),
        row("calm-sift", "working", { kind: "reviewer", worker: "k3v9q2-worker" }),
      ]),
    ).toEqual(["calm-sift", "k3v9q2-worker", "worker-b"])
  })

  test("it ranks by the held light, so a pause between two steps moves nothing", () => {
    expect(
      order(
        [
          row("worker-a", "idle", { ticket: "PG-2" }),
          row("worker-b", "working", { ticket: "PG-1" }),
        ],
        new Set(),
        new Map([["s-worker-a", "working"]]),
      ),
    ).toEqual(["worker-b", "worker-a"])
  })

  test("groups go in GROUP_ORDER, Orchestrators first whatever their states", () => {
    expect(
      order([
        row("worker-a", "needs-you"),
        row("runner-a", "working", { role: "runner" }, { role: "runner" }),
        row("builder", "idle", { role: "manager", title: "Builder" }, { role: "manager" }),
        row("ops", "needs-you", { role: "manager", title: "Ops" }, { role: "manager" }),
      ]),
    ).toEqual(["builder", "ops", "worker-a", "runner-a"])
  })

  // Managers read Builder, Ops, Optimizer, Planner, and drag and drop reorders them.
  test("Orchestrators go A to Z by roster title, the dispatcher first, an untitled one after the titled, and a dragged order before both", () => {
    const managers: [Worker, Agent][] = [
      row("planner", "working", { role: "manager", title: "Planner" }, { role: "manager" }),
      row("zeta", "idle", { role: "manager", title: null }, { role: "manager" }),
      row("ops", "needs-you", { role: "manager", title: "Ops" }, { role: "manager" }),
      row("dispatcher", "idle", { role: "manager" }, { role: "dispatcher" }),
      row("optimizer", "idle", { role: "manager", title: "Optimizer" }, { role: "manager" }),
      row("builder", "idle", { role: "manager", title: "Builder" }, { role: "manager" }),
    ]
    const { agents, workers } = board(managers)
    const sorted = (stored: string[]) =>
      names(orderByStatus(workers, agents, new Map(), new Set(), NOW, stored))
    expect(sorted([])).toEqual(["dispatcher", "builder", "ops", "optimizer", "planner", "zeta"])
    // the stored order leads; a manager it does not name follows, A to Z, so a new one shows with no write
    expect(sorted(["planner", "gone", "ops"])).toEqual([
      "dispatcher",
      "planner",
      "ops",
      "builder",
      "optimizer",
      "zeta",
    ])
  })

  // the table keeps the sidebar's dispatcher order, the API's, whatever their titles
  test("the dispatchers go in the order the API names them, ahead of any title or dragged order", () => {
    const { agents, workers } = board([
      row("dispatcher", "idle", { role: "manager", title: "Zulu" }, { role: "dispatcher" }),
      row("dispatcher-2", "working", { role: "manager", title: "Alpha" }, { role: "dispatcher" }),
    ])
    const sorted = (stored: string[]) =>
      names(
        orderByStatus(workers, agents, new Map(), new Set(), NOW, stored, [
          "dispatcher",
          "dispatcher-2",
        ]),
      )
    expect(sorted([])).toEqual(["dispatcher", "dispatcher-2"])
    expect(sorted(["dispatcher-2"])).toEqual(["dispatcher", "dispatcher-2"])
  })

  test("Orchestrators sort by the board's own roster title before the agents read lands, so the first paint does not reorder", () => {
    const { workers } = board([
      row("planner", "idle", { role: "manager" }, { role: "manager" }),
      row("builder", "idle", { role: "manager" }, { role: "manager" }),
    ])
    const titled = workers.map((w) => ({
      ...w,
      title: w.name === "builder" ? "Planner" : "Builder",
    }))
    expect(names(orderByStatus(titled, null, new Map(), new Set(), NOW))).toEqual([
      "planner",
      "builder",
    ])
  })
})

describe("ticketOf", () => {
  test("the roster's ticket, else the one its branch names (the API's branchTicket)", () => {
    expect(ticketOf(agent("worker-a", { branchTicket: "PG-12", ticket: "MADENOVA-5" }))).toBe(
      "MADENOVA-5",
    )
    expect(ticketOf(agent("worker-a", { branchTicket: "PG-12" }))).toBe("PG-12")
    expect(ticketOf(agent("worker-a", { branch: "vx-ui-menu" }))).toBeNull()
    expect(ticketOf(null)).toBeNull()
  })

  test("line 1 leads with the ticket and the PR joined, PG-12#173", () => {
    const lines = rowLines(
      worker("worker-a", "working", { title: "Sort" }),
      agent("worker-a", {
        branchTicket: "PG-12",
        pr: pull({ number: 173 }),
        title: "Sort",
      }),
      NOW,
    )
    expect(rowText(lines).first).toBe("PG-12#173 Sort")
    expect(rowText({ ...lines, ticket: null }).first).toBe("#173 Sort")
    expect(rowText({ ...lines, pr: null }).first).toBe("PG-12 Sort")
  })
})

// Every row's second line reads model and state, managers and dispatchers included; a runner's reads its AI state and script state, each with when.
describe("line 2 for managers and AI runners", () => {
  const opus = { effort: "high", model: "claude-opus-5-5" }

  test("a manager's reads its model, then its state", () => {
    const lines = rowLines(
      worker("builder", "working", { ...opus, role: "manager" }),
      agent("builder", { role: "manager" }),
      NOW,
    )
    expect(rowText(lines).second).toBe("Opus 5.5 high · Working")
  })

  test("an AI runner's reads its model, its state, then when it runs from the roster's schedule, left out when it has none", () => {
    const runner = worker("runner-steady-tick", "working", { ...opus, role: "runner" })
    const at = (schedule: string | null) =>
      rowText(rowLines(runner, agent("runner-steady-tick", { role: "runner", schedule }), NOW))
        .second
    expect(at("*/5 * * * *")).toBe("Opus 5.5 high · Working · every 5 min")
    expect(at("always")).toBe("Opus 5.5 high · Working · always running")
    expect(at(null)).toBe("Opus 5.5 high · Working")
  })

  test("an AI runner's when is a part of its own after its state, so a narrow row cuts it before the model (#i546)", () => {
    const runner = worker("runner-steady-tick", "working", { ...opus, role: "runner" })
    const lines = rowLines(
      runner,
      agent("runner-steady-tick", { role: "runner", schedule: "always" }),
      NOW,
    )
    expect(lines.state).toBe("Working")
    expect(lines.when).toBe("always running")
  })

  test("the System table's status ends with when an AI runner runs, as its row does, and with nothing for any other role", () => {
    expect(
      runnerWhen(agent("runner-steady-tick", { role: "runner", schedule: "*/5 * * * *" })),
    ).toBe("every 5 min")
    expect(runnerWhen(agent("runner-steady-tick", { role: "runner" }))).toBeNull()
    expect(runnerWhen(agent("worker-greed", { role: "worker", schedule: "always" }))).toBeNull()
  })

  test("a worker's reads its model, then its state, with no name of its own", () => {
    const lines = rowLines(worker("worker-greed", "working", opus), agent("worker-greed"), NOW)
    expect(rowText(lines).second).toBe("Opus 5.5 high · Working")
  })
})
