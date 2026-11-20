import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { AgentStatus } from "../../../../../../web/next/src/components/dashboard/agent-status"

// React resolves from the web app's own packages, which this directory cannot see; the two calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
type CreateElement = (type: unknown, props?: unknown, ...children: Node[]) => Node
const web = join(import.meta.dir, "../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: CreateElement
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}

type Agent = Parameters<typeof AgentStatus>[0]["agent"]

const NOW = Date.parse("2026-10-07T12:00:00Z")

const agent = (fields: Partial<Agent>): Agent => ({
  branch: null,
  branchTicket: null,
  eta: null,
  kind: null,
  lastActivityAt: null,
  name: "worker-greed",
  parked: null,
  pr: null,
  pullProblem: null,
  report: null,
  role: "worker",
  schedule: null,
  sessionId: "s-greed",
  state: "working",
  status: null,
  task: null,
  ticket: null,
  title: null,
  worker: null,
  workspace: null,
  ...fields,
})

const render = (fields: Partial<Agent>, dispatcher = false) =>
  renderToStaticMarkup(createElement(AgentStatus, { agent: agent(fields), dispatcher, now: NOW }))

describe("AgentStatus", () => {
  test("the words take no state colour: the icon beside them carries it", () => {
    const waiting = render({ name: "dispatcher", role: "manager", state: "needs-you" }, true)
    expect(waiting).toContain("Waiting on you")
    expect(waiting).not.toMatch(/text-(destructive|caution|success)/)
    const failing = render({
      pr: {
        approvals: 0,
        ci: "failing",
        conflicts: false,
        draft: false,
        gates: null,
        head: "",
        number: 97,
        queued: false,
        reviewed: true,
        round: 1,
        score: "4/5",
        state: "open",
        tester: null,
        title: "",
        updatedAt: null,
        url: "https://github.com/o/r/pull/97",
        verdict: null,
      },
    })
    expect(failing).toContain("Fixing")
    expect(failing).not.toMatch(/text-(destructive|caution|success)/)
  })

  test("a quiet phrase stays muted; a stuck worker is not quiet, and its words take no colour", () => {
    expect(render({ state: "idle" })).toContain("text-muted-foreground")
    const waiting = render({ state: "needs-you" })
    expect(waiting).toContain("Stuck")
    expect(waiting).not.toMatch(/text-(muted-foreground|destructive|caution|success)/)
  })
})
