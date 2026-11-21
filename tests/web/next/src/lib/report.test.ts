import { describe, expect, test } from "bun:test"

import type { OpsReport } from "../../../../../api/hono/src/lib/apps/ops-report"
import type { Plan, PlanItem, PlanLane } from "../../../../../api/hono/src/lib/apps/plan"
import { attentionCount, healthReadAt, laneNow } from "../../../../../web/next/src/lib/report"

type Agent = NonNullable<Parameters<typeof laneNow>[2]>[number]
type Worker = NonNullable<Parameters<typeof laneNow>[4]>[number]

const NOW = Date.parse("2026-10-06T19:00:00Z")

const agent = (name: string, fields: Partial<Agent> = {}): Agent => ({
  branch: null,
  branchTicket: null,
  eta: null,
  kind: null,
  lastActivityAt: "2026-10-06T18:50:00.000Z",
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

const item = (id: string, fields: Partial<PlanItem> = {}): PlanItem => ({
  estimateRange: "0.9-1.3h",
  outcome: `What ${id} does.`,
  id,
  title: `Item ${id}`,
  ...fields,
})

const lane = (fields: Partial<PlanLane> = {}): PlanLane => ({
  id: "easy",
  items: [item("24"), item("19", { estimateRange: "1.0-1.5h" })],
  title: "Easy",
  worker: "worker-a",
  ...fields,
})

const plan = (fields: Partial<Plan> = {}): Plan => ({
  doneToday: [],
  generatedAt: "2026-10-06T18:34:00Z",
  inFlight: [
    {
      id: "19",
      outcome: "The Plan page, in plain words.",
      pr: "https://github.com/example/app/pull/109",
      worker: "worker-a",
    },
  ],
  landingNext: [],
  lanes: [lane()],
  ...fields,
})

describe("laneNow", () => {
  test("a lane's worker on an item in flight: its line, PR, status in the Dashboard's words and estimate", () => {
    const pr = {
      approvals: 0,
      ci: "passing" as const,
      conflicts: false,
      draft: false,
      gates: null,
      head: "",
      number: 109,
      queued: false,
      reviewed: true,
      round: 1,
      score: "5/5",
      state: "open" as const,
      tester: null,
      title: "",
      updatedAt: null,
      url: "https://github.com/example/app/pull/109",
      verdict: null,
    }
    expect(laneNow(lane(), plan(), [agent("worker-a", { pr })], NOW)).toEqual({
      availability: "busy",
      estimate: "1.0-1.5h",
      inFlight: true,
      item: "19",
      lane: "Easy",
      outcome: "The Plan page, in plain words.",
      pr: "https://github.com/example/app/pull/109",
      status: "Working",
      worker: "worker-a",
    })
  })

  test("a free worker reads its lane's next item, with no pull request of another chore", () => {
    const pr = {
      approvals: 0,
      ci: "passing" as const,
      conflicts: false,
      draft: false,
      gates: null,
      head: "",
      number: 90,
      queued: false,
      reviewed: false,
      round: null,
      score: null,
      state: "merged" as const,
      tester: null,
      title: "",
      updatedAt: null,
      url: "https://github.com/example/app/pull/90",
      verdict: null,
    }
    const idle = agent("worker-a", { pr, state: "idle" })
    const now = laneNow(lane(), plan({ inFlight: [] }), [idle], NOW)
    expect(now).toMatchObject({
      availability: "free",
      inFlight: false,
      item: "24",
      outcome: "What 24 does.",
      pr: null,
      status: "Merged",
    })
  })

  test("a worker the board has at work is busy, never free, while the plan shows nothing in flight", () => {
    for (const state of ["working", "needs-you"] as const) {
      const now = laneNow(lane(), plan({ inFlight: [] }), [agent("worker-a", { state })], NOW)
      expect(now).toMatchObject({ availability: "busy", inFlight: false, item: "24" })
    }
  })

  test("a session the usage limit alone holds reads the sidebar's paused word, not Stuck", () => {
    const paused = worker("worker-a", "needs-you", {
      usageLimit: { resets: "3am (Asia/Calcutta)", resetsAt: null },
    })
    expect(
      laneNow(lane(), plan(), [agent("worker-a", { state: "needs-you" })], NOW, [paused]).status,
    ).toBe("Paused · usage limit")
  })

  test("a session stuck on a prompt, with no usage limit, still reads Stuck", () => {
    expect(
      laneNow(lane(), plan(), [agent("worker-a", { state: "needs-you" })], NOW, [
        worker("worker-a", "needs-you"),
      ]).status,
    ).toBe("Stuck")
    expect(
      laneNow(lane(), plan(), [agent("worker-a", { state: "needs-you" })], NOW, null).status,
    ).toBe("Stuck")
  })

  test("a worker whose session is gone or ended is down, never free", () => {
    for (const status of [null, "ended"]) {
      const down = agent("worker-a", { state: "down", status })
      const now = laneNow(lane(), plan({ inFlight: [] }), [down], NOW)
      expect(now).toMatchObject({ availability: "down", inFlight: false, item: "24" })
    }
  })

  test("a worker the board does not hold, or a board not read yet, claims no availability", () => {
    expect(laneNow(lane(), plan({ inFlight: [] }), [], NOW).availability).toBeNull()
    expect(laneNow(lane(), plan({ inFlight: [] }), undefined, NOW).availability).toBeNull()
  })

  test("a lane with no worker, or one the board does not hold, shows no status", () => {
    expect(laneNow(lane({ worker: null }), plan(), [], NOW)).toMatchObject({
      inFlight: false,
      item: "24",
      status: null,
      worker: null,
    })
    expect(laneNow(lane(), plan(), undefined, NOW).status).toBeNull()
  })

  test("an in-flight item missing from its lane still reads, without an estimate", () => {
    const now = laneNow(lane({ items: [item("24")] }), plan(), [], NOW)
    expect(now).toMatchObject({ estimate: null, item: "19", inFlight: true })
  })

  test("an empty lane with nothing in flight has no item", () => {
    expect(laneNow(lane({ items: [] }), plan({ inFlight: [] }), [], NOW).item).toBeNull()
  })
})

const report = (fields: Partial<OpsReport> = {}): OpsReport => ({
  changes: [],
  findings: [],
  generatedAt: "2026-10-06T19:00:00Z",
  hash: null,
  health: [],
  merges: [],
  ...fields,
})

test("attentionCount says how many things need attention, in words", () => {
  expect(attentionCount(report())).toBe("Nothing")
  const finding = { item: "#5", state: "stuck", why: "No reviewer" }
  expect(attentionCount(report({ findings: [finding] }))).toBe("1 item")
  expect(attentionCount(report({ findings: [finding, finding] }))).toBe("2 items")
})

test("healthReadAt is the newest reading's time, skipping any that is not a time", () => {
  expect(healthReadAt(report())).toBeNull()
  const health = [
    { label: "Memory", now: "2026-10-06T18:59:00Z", reading: "33% used" },
    { label: "Swap", now: "2026-10-06T19:00:30Z", reading: "71% used" },
    { label: "Workers", now: "all busy", reading: "3" },
  ]
  expect(healthReadAt(report({ health }))).toBe("2026-10-06T19:00:30.000Z")
})
