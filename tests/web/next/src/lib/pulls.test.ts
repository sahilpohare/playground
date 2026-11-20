import { describe, expect, test } from "bun:test"

import {
  etaOverdue,
  pullFields,
  pullProblemOf,
  viewPulls,
} from "../../../../../web/next/src/lib/pulls"

// The API's types reach the web through @api/hono, which only the web resolves, so they are read off the functions that take them.
type Agent = Parameters<typeof viewPulls>[0][number]
type Pull = NonNullable<Agent["pr"]>
type PullsQueue = NonNullable<Parameters<typeof viewPulls>[3]>

const pull = (number: number, fields: Partial<Pull> = {}): Pull => ({
  approvals: 0,
  ci: "passing",
  conflicts: false,
  draft: false,
  gates: null,
  head: "",
  number,
  queued: false,
  reviewed: false,
  round: null,
  score: null,
  state: "open",
  tester: null,
  title: `PR ${number}`,
  updatedAt: "2026-10-12T10:00:00Z",
  url: `https://github.com/acme/factory/pull/${number}`,
  verdict: null,
  ...fields,
})

const agent = (name: string, pr: Pull | null, fields: Partial<Agent> = {}): Agent => ({
  branch: null,
  branchTicket: null,
  eta: null,
  kind: null,
  lastActivityAt: null,
  name,
  parked: null,
  pr,
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

const numbers = (sections: ReturnType<typeof viewPulls>) =>
  sections.map(({ groups, kind }) => [
    kind,
    groups.map(({ pulls, repo }) => [repo, pulls.map((p) => p.number)]),
  ])

describe("viewPulls", () => {
  const other = (n: number, fields: Partial<Pull> = {}) =>
    pull(n, { url: `https://github.com/acme-labs/example-repo/pull/${n}`, ...fields })
  const board = [
    agent("dispatcher", null, { role: "manager" }),
    agent("worker-greed", pull(36)),
    agent("reviewer-greed", pull(36)),
    agent("worker-lust", pull(40, { updatedAt: "2026-10-12T11:00:00Z" })),
    agent("worker-avaritia", pull(35)),
    agent("worker-sloth", pull(30, { state: "merged" })),
    agent("worker-wrath", other(1201)),
    agent("worker-pride", null),
    agent("worker-envy", pull(41, { state: "closed" }), { sessionId: null, state: "down" }),
    agent("worker-gula", other(1190, { draft: true, updatedAt: null }), {
      sessionId: null,
      state: "down",
    }),
  ]
  const queue: PullsQueue = {
    parked: [{ pr: 35 }],
    queue: [
      { etaMerge: null, item: null, pr: 36 },
      { etaMerge: "2026-10-12T12:00:00Z", item: null, pr: 40 },
    ],
    repo: "acme/factory",
  }
  const unpaired: PullsQueue = {
    ...queue,
    queue: [...queue.queue, { etaMerge: "2026-10-12T13:00:00Z", item: "Queue tab", pr: 50 }],
  }

  test("an agent's view lists the pull request it works on, merged or closed included, in its section", () => {
    expect(numbers(viewPulls(board, "s-worker-greed", false))).toEqual([
      ["open", [["acme/factory", [36]]]],
    ])
    expect(numbers(viewPulls(board, "s-reviewer-greed", false))).toEqual([
      ["open", [["acme/factory", [36]]]],
    ])
    expect(numbers(viewPulls(board, "s-worker-sloth", false))).toEqual([
      ["settled", [["acme/factory", [30]]]],
    ])
    expect(viewPulls(board, "s-worker-pride", false)).toEqual([])
    expect(viewPulls(board, "s-gone", false)).toEqual([])
  })

  test("Playground's view lists every pull across the board once, open ones first and merged and closed last, each group a repository A to Z, the newest update first", () => {
    expect(numbers(viewPulls(board, "s-dispatcher", true))).toEqual([
      [
        "open",
        [
          ["acme-labs/example-repo", [1201, 1190]],
          ["acme/factory", [40, 36, 35]],
        ],
      ],
      ["settled", [["acme/factory", [41, 30]]]],
    ])
  })

  test("queued pulls lead in queue order, each with its place and time to merge, then the open ones, then the parked, then the merged and closed", () => {
    const sections = viewPulls(board, "s-dispatcher", true, queue)
    expect(numbers(sections)).toEqual([
      ["queued", [["acme/factory", [36, 40]]]],
      ["open", [["acme-labs/example-repo", [1201, 1190]]]],
      ["parked", [["acme/factory", [35]]]],
      ["settled", [["acme/factory", [41, 30]]]],
    ])
    expect(sections[0].groups[0].pulls.map((p) => [p.number, p.place, p.etaMerge])).toEqual([
      [36, 1, null],
      [40, 2, "2026-10-12T12:00:00Z"],
    ])
  })

  test("the queue matches only its own repository's pulls, so a same-numbered pull of another repository matches nothing", () => {
    const twin = [
      agent("worker-greed", pull(36)),
      agent("worker-ira", other(36)),
      // a parked number of another repository parks nothing, and a merged pull the queue names is merged and closed all the same
      agent("worker-acedia", other(35)),
      agent("worker-gula", pull(40, { state: "merged" })),
    ]
    const sections = viewPulls(twin, "s-dispatcher", true, queue)
    expect(numbers(sections)).toEqual([
      ["queued", [["acme/factory", [36]]]],
      ["open", [["acme-labs/example-repo", [36, 35]]]],
      ["settled", [["acme/factory", [40]]]],
    ])
  })

  test("a worker's queued pull carries its global place in the queue", () => {
    const sections = viewPulls(board, "s-worker-greed", false, queue)
    expect(numbers(sections)).toEqual([["queued", [["acme/factory", [36]]]]])
    expect(sections[0].groups[0].pulls[0].place).toBe(1)
  })

  test("Playground's view lists a queued pull no agent works on, at its place with its time to merge, titled by its queue item, its state and CI unknown", () => {
    const sections = viewPulls(board, "s-dispatcher", true, unpaired)
    expect(numbers(sections)[0]).toEqual(["queued", [["acme/factory", [36, 40, 50]]]])
    const row = sections[0].groups[0].pulls[2]
    expect([row.place, row.etaMerge, row.title, row.url]).toEqual([
      3,
      "2026-10-12T13:00:00Z",
      "Queue tab",
      "https://github.com/acme/factory/pull/50",
    ])
    expect(pullFields(row)).toEqual({
      approvals: "Unknown",
      ci: "Unknown",
      repo: "acme/factory",
      score: "Unknown",
      state: "Unknown",
    })
  })

  test("an unpaired queue entry stands for its own repository's pull, so an agent's same-numbered pull of another repository stays as it was", () => {
    const twin = [agent("dispatcher", null, { role: "manager" }), agent("worker-ira", other(50))]
    expect(numbers(viewPulls(twin, "s-dispatcher", true, unpaired))).toEqual([
      ["queued", [["acme/factory", [36, 40, 50]]]],
      ["open", [["acme-labs/example-repo", [50]]]],
    ])
  })

  test("a queue whose repository is unknown (an origin off GitHub) adds no unpaired rows", () => {
    expect(numbers(viewPulls(board, "s-dispatcher", true, { ...unpaired, repo: "" }))).toEqual(
      numbers(viewPulls(board, "s-dispatcher", true, { ...queue, repo: "" })),
    )
  })

  test("an unpaired queue entry with no item reads Queued pull", () => {
    const bare: PullsQueue = { ...queue, queue: [{ etaMerge: null, item: null, pr: 50 }] }
    const row = viewPulls(board, "s-dispatcher", true, bare)[0].groups[0].pulls[0]
    expect([row.number, row.title]).toEqual([50, "Queued pull"])
  })

  test("an agent's view never lists the queue's unpaired pulls", () => {
    expect(numbers(viewPulls(board, "s-worker-greed", false, unpaired))).toEqual([
      ["queued", [["acme/factory", [36]]]],
    ])
    expect(viewPulls(board, "s-worker-pride", false, unpaired)).toEqual([])
  })
})

describe("etaOverdue", () => {
  const now = Date.parse("2026-10-12T12:00:00Z")
  test("a time that has passed is overdue", () => {
    expect(etaOverdue("2026-10-12T11:59:00Z", now)).toBe(true)
    expect(etaOverdue("2026-10-05T12:00:00Z", now)).toBe(true)
  })
  test("a time still ahead is not, and neither is no time or one that cannot be read", () => {
    expect(etaOverdue("2026-10-12T12:00:01Z", now)).toBe(false)
    expect(etaOverdue(null, now)).toBe(false)
    expect(etaOverdue(undefined, now)).toBe(false)
    expect(etaOverdue("tomorrow morning", now)).toBe(false)
  })
})

describe("pullProblemOf", () => {
  const agents = [
    agent("dispatcher", null, { role: "manager" }),
    agent("worker-greed", null),
    agent("worker-lust", pull(40)),
    agent("worker-envy", null, {
      pullProblem: { reason: "GitHub answered without the repository", setup: false },
      sessionId: null,
      state: "down",
    }),
  ]

  test("an agent's view names only its own failed read, so another agent's failure never reads as its own", () => {
    expect(pullProblemOf(agents, "s-worker-greed", false)).toBeNull()
    const problem = { reason: "gh is not logged in", setup: true }
    const own = [agent("worker-greed", null, { pullProblem: problem })]
    expect(pullProblemOf(own, "s-worker-greed", false)).toBe(problem)
  })

  test("Playground's view, which lists every agent's pull requests, names any failed read", () => {
    expect(pullProblemOf(agents, "s-dispatcher", true)?.reason).toBe(
      "GitHub answered without the repository",
    )
    expect(pullProblemOf(agents.slice(0, 3), "s-dispatcher", true)).toBeNull()
  })
})

describe("pullFields", () => {
  test("each column's words: repository, state, score at the head, CI and approvals still needed", () => {
    expect(pullFields(pull(36, { approvals: 2, ci: "failing", score: "4/5" }))).toEqual({
      approvals: "2 needed",
      ci: "Failing",
      repo: "acme/factory",
      score: "4/5",
      state: "Open",
    })
    const fields = (fields: Partial<Pull>) => pullFields(pull(36, fields))
    expect(fields({ draft: true }).state).toBe("Draft")
    expect(fields({ draft: true, state: "merged" }).state).toBe("Merged")
    expect(fields({ state: "closed" }).state).toBe("Closed")
    expect(fields({}).score).toBe("None")
    expect(fields({}).approvals).toBe("None needed")
    expect(fields({ ci: "passing" }).ci).toBe("Passing")
    expect(fields({ ci: "pending" }).ci).toBe("Pending")
    expect(fields({ ci: "none" }).ci).toBe("None")
  })
})
