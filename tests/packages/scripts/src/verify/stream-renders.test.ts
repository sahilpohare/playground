import { describe, expect, test } from "bun:test"

import {
  allowance,
  STEPS,
  STREAM_RENDERS_SCRIPT,
  streamRendersResult,
} from "../../../../../packages/scripts/src/verify/stream-renders"

const read = (renders: Record<string, number>, rows = 9, parts = 420) =>
  streamRendersResult("s", { parts, renders, rows }, STEPS)

describe("streamRendersResult", () => {
  test("passes steps that drew their own words and their turn's row alone", () => {
    const result = read({ AgentLink: 10, StepRow: 10, TranscriptMarkdown: 10 })
    expect(result.ok).toBe(true)
    expect(result.detail).toBe(
      "10 steps into a stream of 9 rows and 420 parts: AgentLink 10, StepRow 10, TranscriptMarkdown 10 draws",
    )
  })

  // the stream's clock ticks on every inbox read, every 5s, and draws no row whose shown time it leaves alone, so a run's allowance is the steps' own draws, twice over for a board frame beside each
  test("allows each component twice the steps, and no row more for a clock tick", () => {
    expect(allowance(STEPS)).toBe(20)
    expect(read({ AgentLink: 20, StepRow: 20, TranscriptMarkdown: 20 }).ok).toBe(true)
    expect(read({ AgentLink: 10, StepRow: 29, TranscriptMarkdown: 10 }).ok).toBe(false)
  })

  // before the fix, each step rebuilt every message, so every row drew on every step, and every part's words drew through the dashboard's context
  test("fails a step that drew the whole stream again, naming each component over its allowance", () => {
    const result = read({ AgentLink: 90, StepRow: 90, TranscriptMarkdown: 4200 })
    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      "AgentLink drew 90 times, over 20; StepRow drew 90 times, over 20; TranscriptMarkdown drew 4200 times, over 20, 10 steps into a stream of 9 rows and 420 parts",
    )
  })

  test("fails a run in which no row drew, which measured nothing", () => {
    expect(read({}).detail).toBe("no row drew over 10 steps (9 rows shown)")
    expect(read({ StepRow: 10 }, 0).ok).toBe(false)
  })
})

describe("STREAM_RENDERS_SCRIPT", () => {
  test("installs the DevTools hook React reports commits to, before React loads, and keeps the socket's workers frame", () => {
    expect(STREAM_RENDERS_SCRIPT).toContain("window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {")
    expect(STREAM_RENDERS_SCRIPT).toContain("onCommitFiberRoot")
    expect(STREAM_RENDERS_SCRIPT).toContain("supportsFiber: true")
    expect(STREAM_RENDERS_SCRIPT).toContain('data.type === "workers"')
    expect(STREAM_RENDERS_SCRIPT).toContain("window.__streamRenders = {")
  })

  // a subtree React skipped keeps the fibers it had, PerformedWork flag and all, so only a fiber new since the last commit counts
  test("counts a fiber React rendered this commit, and none in a subtree it skipped, whatever another root commits between", () => {
    const hook = installed()
    const leaf = { child: null, flags: 1, sibling: null, type: StepRow }
    const skipped = { child: leaf, flags: 1, sibling: null, type: Stream }
    const app: { current: object } = {
      current: { child: skipped, flags: 0, sibling: null, type: null },
    }
    hook.onCommitFiberRoot(1, app)
    expect(counts()).toEqual({ StepRow: 1, Stream: 1 })
    // the development build's overlay is a root of its own, committing between the app's
    hook.onCommitFiberRoot(1, { current: { child: null, flags: 0, sibling: null, type: null } })
    const redrawn = { child: null, flags: 1, sibling: null, type: StepRow }
    // the next commit: a bailed-out parent holds the skipped subtree as it was, beside a new row that drew
    const parent = {
      child: skipped,
      flags: 0,
      sibling: { child: redrawn, flags: 1, sibling: null, type: Stream },
      type: null,
    }
    app.current = { child: parent, flags: 0, sibling: null, type: null }
    hook.onCommitFiberRoot(1, app)
    expect(counts()).toEqual({ StepRow: 2, Stream: 2 })
  })
})

function StepRow() {}
function Stream() {}
type Hook = { onCommitFiberRoot: (id: number, root: { current: object }) => void }
const scope: Record<string, unknown> = { WebSocket: class {} }
const installed = () => {
  const run = new Function("window", STREAM_RENDERS_SCRIPT)
  run(scope)
  return scope.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook
}
const counts = () => (scope.__streamRenders as { counts: () => Record<string, number> }).counts()
