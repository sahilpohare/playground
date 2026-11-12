import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RmDeps } from "../../../../packages/scripts/src/playground/rm"
import {
  type CleanupDeps,
  cleanWorktree,
  cleanupHeld,
  containersFor,
  type EndDeps,
  endMerged,
  endOne,
  finishedOf,
  sweep,
  type Target,
  unsavedLive,
} from "../../../../scripts/ops/optimizer/auto_end"
import type {
  CollectInput,
  PrState,
  RegistryEntry,
} from "../../../../scripts/ops/optimizer/idle_sessions"

const NOW = 1_760_700_000
const URL = "https://github.com/o/r/pull/2110"
const NEXT = "https://github.com/o/r/pull/2111"
const MERGED: PrState = {
  head: "abc1234",
  mergeSha: "daaac8e0000",
  ref: "pg-2099-x",
  state: "merged",
  verdicts: [],
}

const live = (name: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name,
  pid: 4242,
  sessionId: `sess-${name}`,
  status: "idle",
  statusUpdatedAt: (NOW - 45 * 60) * 1000,
  ...over,
})

// A faked herdr (close), roster (report) and worktree read (unsaved), each call kept.
const fakes = (over: Partial<EndDeps> = {}) => {
  const closed: string[] = []
  const reported: [string, string][] = []
  const checked: Target[] = []
  const deps: EndDeps = {
    close: async (name) => {
      closed.push(name)
      return { ok: true, out: `closed ${name} (pane w1:p2 on factory)` }
    },
    report: async (name, text) => void reported.push([name, text]),
    unsaved: async (target) => {
      checked.push(target)
      return null
    },
    ...over,
  }
  return { checked, closed, deps, reported }
}

const input = (over: Partial<CollectInput> = {}): CollectInput => ({
  hours: 1,
  now: NOW,
  prState: async (url) => (url === URL ? MERGED : null),
  roster: {},
  sessions: {},
  workerPrs: async () => [],
  ...over,
})

// PG-1419: rm's reader returns a PR (its head beside its number and state) or none, and the cleanup's finished reads rm's freed off it
test("finishedOf reads rm's reader shape, a PR beside its head, number and state or none: merged and closed are done, open and none are not", () => {
  expect(finishedOf({ head: "h", number: 7, state: "MERGED" })).toBe(true)
  expect(finishedOf({ head: "h", number: 7, state: "CLOSED" })).toBe(true)
  expect(finishedOf({ head: "h", number: 7, state: "OPEN" })).toBe(false)
  expect(finishedOf(null)).toBe(false)
})

describe("sweep: ops-tick ends what the detector flags", () => {
  test("names the PR that merged last and its merge sha, not an older linked PR", async () => {
    const { deps, reported } = fakes()
    const older: PrState = { ...MERGED, mergeSha: "0ld0000", mergedAt: "2026-10-31T19:00:00Z" }
    const newer: PrState = { ...MERGED, mergeSha: "2ew1111", mergedAt: "2026-11-01T00:10:00Z" }
    const lines = await sweep(
      input({
        linkedPrs: async (sessionId) => (sessionId === "sess-h2wq8n-worker" ? [URL] : []),
        prState: async (url) => (url === URL ? older : url === NEXT ? newer : null),
        roster: { "h2wq8n-worker": { kind: "worker", name: "h2wq8n-worker", pr: NEXT } },
        sessions: { "h2wq8n-worker": live("h2wq8n-worker") },
        workerPrs: async (name) => (name === "h2wq8n-worker" ? [NEXT] : []),
      }),
      deps,
    )
    expect(reported).toEqual([
      ["h2wq8n-worker", "ended automatically: worker-prs-done (merged), #2111 merged as 2ew1111"],
    ])
    expect(lines).toEqual([
      {
        text: "Ended h2wq8n-worker: worker-prs-done (merged), #2111 merged as 2ew1111",
        to: "builder",
      },
    ])
  })

  test("a checker whose PR is done, one whose worker is gone, and a worker whose PRs are merged", async () => {
    const { closed, deps, reported } = fakes()
    const lines = await sweep(
      input({
        roster: {
          "b7k2mq-tester": { kind: "tester", name: "b7k2mq-tester", worker: "gone-worker" },
          "m4tqzr-reviewer": { kind: "reviewer", name: "m4tqzr-reviewer", pr: URL },
          "q6dmtb-worker": { kind: "worker", name: "q6dmtb-worker", pr: URL },
        },
        sessions: {
          "b7k2mq-tester": live("b7k2mq-tester"),
          "m4tqzr-reviewer": live("m4tqzr-reviewer"),
          "m4tqzr-worker": live("m4tqzr-worker", { status: "busy" }),
          "q6dmtb-worker": live("q6dmtb-worker"),
        },
        workerPrs: async (name) =>
          name === "m4tqzr-reviewer" || name === "q6dmtb-worker" ? [URL] : [],
      }),
      deps,
    )
    expect(closed).toEqual(["b7k2mq-tester", "m4tqzr-reviewer", "q6dmtb-worker"])
    expect(reported).toEqual([
      ["b7k2mq-tester", "ended automatically: checker-worker-gone (gone-worker)"],
      ["m4tqzr-reviewer", "ended automatically: checker-pr-done (merged), #2110 merged as daaac8e"],
      ["q6dmtb-worker", "ended automatically: worker-prs-done (merged), #2110 merged as daaac8e"],
    ])
    expect(lines).toEqual([
      { text: "Ended b7k2mq-tester: checker-worker-gone (gone-worker)", to: "builder" },
      {
        text: "Ended m4tqzr-reviewer: checker-pr-done (merged), #2110 merged as daaac8e",
        to: "builder",
      },
      {
        text: "Ended q6dmtb-worker: worker-prs-done (merged), #2110 merged as daaac8e",
        to: "builder",
      },
    ])
  })

  test("a reviewer idle 30+ minutes on a scored head ends with its resume named and its worktrees left for that resume; a tester does not", async () => {
    const scored: PrState = { head: "abc1234567", state: "open", verdicts: ["abc1234"] }
    const cleaned: string[] = []
    const { closed, deps } = fakes({
      cleanup: async (target) => (cleaned.push(target.name), [`removed /wt/${target.name}`]),
    })
    const lines = await sweep(
      input({
        prState: async () => scored,
        roster: {
          "k8wjf3-reviewer": { kind: "reviewer", name: "k8wjf3-reviewer", worker: "k8wjf3-worker" },
          "k8wjf3-tester": { kind: "tester", name: "k8wjf3-tester", worker: "k8wjf3-worker" },
        },
        sessions: {
          "k8wjf3-reviewer": live("k8wjf3-reviewer"),
          "k8wjf3-tester": live("k8wjf3-tester"),
          "k8wjf3-worker": live("k8wjf3-worker", { status: "busy" }),
        },
        workerPrs: async (name) => (name === "k8wjf3-worker" ? [] : [NEXT]),
      }),
      deps,
    )
    expect(closed).toEqual(["k8wjf3-reviewer"])
    expect(cleaned).toEqual([])
    const text =
      "Ended k8wjf3-reviewer: checker-nothing (head scored); resume it on the next push: scripts/spawn.sh resume k8wjf3-reviewer <dir> --pr <PR url>"
    expect(lines).toEqual([
      { text, to: "builder" },
      { text, to: "k8wjf3-worker" },
    ])
  })

  test("a line goes to the roster lead, its worker's, or ops for a ops checker; a roster-says flag ends nobody", async () => {
    const { closed, deps } = fakes()
    const lines = await sweep(
      input({
        roster: {
          "h3fnrc-tester": { kind: "tester", name: "h3fnrc-tester", pr: URL, worker: "ops" },
          "w33hrq-reviewer": {
            kind: "reviewer",
            name: "w33hrq-reviewer",
            pr: URL,
            worker: "w33hrq-worker",
          },
          "w33hrq-worker": { kind: "worker", lead: "ops", name: "w33hrq-worker", pr: URL },
          "p8nj8s-worker": { kind: "worker", name: "p8nj8s-worker", status: "paused" },
        },
        sessions: {
          "h3fnrc-tester": live("h3fnrc-tester"),
          ops: live("ops", { status: "busy" }),
          "p8nj8s-worker": live("p8nj8s-worker"),
          "w33hrq-reviewer": live("w33hrq-reviewer"),
          "w33hrq-worker": live("w33hrq-worker"),
        },
        workerPrs: async (name) => (name === "p8nj8s-worker" ? [] : [URL]),
      }),
      deps,
    )
    expect(closed).toEqual(["h3fnrc-tester", "w33hrq-reviewer", "w33hrq-worker"])
    expect(lines.map((l) => l.to)).toEqual(["ops", "ops", "ops"])
  })

  test("a checker of an <id>-ops worker with no roster lead tells ops, not the builder", async () => {
    const { closed, deps } = fakes()
    const lines = await sweep(
      input({
        roster: {
          "r2kq9m-reviewer": {
            kind: "reviewer",
            name: "r2kq9m-reviewer",
            pr: URL,
            worker: "x4m2kq-ops",
          },
        },
        sessions: { "r2kq9m-reviewer": live("r2kq9m-reviewer") },
      }),
      deps,
    )
    expect(closed).toEqual(["r2kq9m-reviewer"])
    expect(lines.map((l) => l.to)).toEqual(["ops"])
  })

  // #1762: a lead closed the worker's PR unmerged and had it rebuild from canary; the older merged PR on its row must not end it, and its lead must hear.
  test("a worker whose PR that closed last closed unmerged is kept, and its lead is asked to reassign or end it", async () => {
    const { closed, deps, reported } = fakes()
    const older: PrState = { ...MERGED, mergedAt: "2026-11-01T00:10:00Z" }
    const unmerged: PrState = {
      closedAt: "2026-11-01T03:00:00Z",
      head: "cl0sed11",
      ref: "pg-2111-z",
      state: "closed",
      verdicts: [],
    }
    const lines = await sweep(
      input({
        prState: async (url) => (url === URL ? older : url === NEXT ? unmerged : null),
        roster: { "v4tql8-worker": { kind: "worker", name: "v4tql8-worker", pr: NEXT } },
        sessions: { "v4tql8-worker": live("v4tql8-worker") },
        workerPrs: async (name) => (name === "v4tql8-worker" ? [URL, NEXT] : []),
      }),
      deps,
    )
    expect([closed, reported]).toEqual([[], []])
    expect(lines).toEqual([
      {
        text: "Kept v4tql8-worker: worker-pr-closed (closed #2111); reassign it or end it",
        to: "builder",
      },
    ])
  })

  test("a worker whose PR that closed last merged is ended, and the line names it, reading merged", async () => {
    const { deps, reported } = fakes()
    const older: PrState = {
      closedAt: "2026-11-01T00:10:00Z",
      head: "cl0sed11",
      ref: "pg-2110-z",
      state: "closed",
      verdicts: [],
    }
    const newer: PrState = { ...MERGED, mergedAt: "2026-11-01T03:00:00Z" }
    const lines = await sweep(
      input({
        prState: async (url) => (url === URL ? older : url === NEXT ? newer : null),
        roster: { "s9bkr5-worker": { kind: "worker", name: "s9bkr5-worker", pr: NEXT } },
        sessions: { "s9bkr5-worker": live("s9bkr5-worker") },
        workerPrs: async (name) => (name === "s9bkr5-worker" ? [URL, NEXT] : []),
      }),
      deps,
    )
    expect(reported).toEqual([
      ["s9bkr5-worker", "ended automatically: worker-prs-done (merged), #2111 merged as daaac8e"],
    ])
    expect(lines).toEqual([
      {
        text: "Ended s9bkr5-worker: worker-prs-done (merged), #2111 merged as daaac8e",
        to: "builder",
      },
    ])
  })

  // #1748 runs live after the next ship: the sweep holds the checker too, not only the detector's list
  test("a checker whose own worker is gone stays while an open PR on its list has a live worker", async () => {
    const { closed, deps } = fakes()
    const lines = await sweep(
      input({
        prState: async (url) =>
          url === NEXT ? { head: "0pen0001", state: "open", verdicts: [] } : null,
        roster: {
          "j4wnc7-reviewer": {
            kind: "reviewer",
            name: "j4wnc7-reviewer",
            prs: [NEXT],
            worker: "g0new0rk-worker",
          },
          "c6xhn2-worker": { kind: "worker", name: "c6xhn2-worker" },
        },
        sessions: {
          "c6xhn2-worker": live("c6xhn2-worker"),
          "j4wnc7-reviewer": live("j4wnc7-reviewer"),
        },
        workerPrs: async (name) => (name === "c6xhn2-worker" ? [NEXT] : []),
      }),
      deps,
    )
    expect([closed, lines]).toEqual([[], []])
  })

  // GitHub closes a PR's issue a beat after its merge, so the issue never counts as the last close
  test("a merged PR beside the issue it closes, closed a beat later, still ends the worker as merged", async () => {
    const { closed, deps, reported } = fakes()
    const ISSUE = "https://github.com/o/r/issues/2112"
    const lines = await sweep(
      input({
        prState: async (url) =>
          url === NEXT
            ? { ...MERGED, mergedAt: "2026-11-01T03:00:00Z" }
            : url === ISSUE
              ? { closedAt: "2026-11-01T03:00:01Z", head: "", state: "closed", verdicts: [] }
              : null,
        roster: {
          "n8vtrw-worker": { kind: "worker", name: "n8vtrw-worker", pr: NEXT, prs: [NEXT, ISSUE] },
        },
        sessions: { "n8vtrw-worker": live("n8vtrw-worker") },
        workerPrs: async (name) => (name === "n8vtrw-worker" ? [NEXT] : []),
      }),
      deps,
    )
    expect(closed).toEqual(["n8vtrw-worker"])
    expect(reported).toEqual([
      ["n8vtrw-worker", "ended automatically: worker-prs-done (merged), #2111 merged as daaac8e"],
    ])
    expect(lines).toEqual([
      {
        text: "Ended n8vtrw-worker: worker-prs-done (merged), #2111 merged as daaac8e",
        to: "builder",
      },
    ])
  })
})

describe("guards", () => {
  test("never a manager, the dispatcher, a runner, the optimizer or a probe, whatever its roster pr", async () => {
    const names = ["builder", "dispatcher", "optimizer", "runner-plain-relay", "z9xq7t-probe"]
    const kinds = ["builder", "dispatcher", "optimizer", "runner", "probe"]
    const { closed, deps, reported } = fakes()
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: Object.fromEntries(
          names.map((name, i) => [name, { kind: kinds[i], name, pr: URL }]),
        ),
        sessions: Object.fromEntries(names.map((name) => [name, live(name)])),
      }),
      deps,
    )
    expect([lines, closed, reported]).toEqual([[], [], []])
  })

  test("a busy session, or one quiet under 10 minutes, is left for the sweep", async () => {
    const { closed, deps } = fakes()
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: {
          "2ngpk2-reviewer": { kind: "reviewer", name: "2ngpk2-reviewer", pr: URL },
          "2ngpk2-tester": { kind: "tester", name: "2ngpk2-tester", pr: URL },
        },
        sessions: {
          "2ngpk2-reviewer": live("2ngpk2-reviewer", { status: "busy" }),
          "2ngpk2-tester": live("2ngpk2-tester", { statusUpdatedAt: (NOW - 9 * 60) * 1000 }),
        },
      }),
      deps,
    )
    expect([lines, closed]).toEqual([[], []])
  })

  test("uncommitted or unpushed work keeps a session open and tells its lead", async () => {
    const { checked, closed, deps, reported } = fakes({
      unsaved: async (target) => {
        checked.push(target)
        return "uncommitted work in /wt/pg-2099-x"
      },
    })
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: { "q6dmtb-worker": { kind: "worker", name: "q6dmtb-worker", pr: URL } },
        sessions: { "q6dmtb-worker": live("q6dmtb-worker") },
      }),
      deps,
    )
    expect(checked.map((t) => [t.name, t.refs])).toEqual([["q6dmtb-worker", ["pg-2099-x"]]])
    expect([closed, reported]).toEqual([[], []])
    expect(lines).toEqual([
      {
        text: "Not ended q6dmtb-worker (#2110 merged as daaac8e): uncommitted work in /wt/pg-2099-x; push it, then close it",
        to: "builder",
      },
    ])
  })

  test("a close spawn.sh refuses ends nothing and tells the lead why", async () => {
    const { deps, reported } = fakes({
      close: async () => ({ ok: false, out: "spawn.sh: no resume record for wwzdhx-reviewer" }),
    })
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: { "wwzdhx-reviewer": { kind: "reviewer", name: "wwzdhx-reviewer", pr: URL } },
        sessions: { "wwzdhx-reviewer": live("wwzdhx-reviewer") },
      }),
      deps,
    )
    expect(reported).toEqual([])
    expect(lines.map((l) => l.text)).toEqual([
      "Not ended wwzdhx-reviewer (#2110 merged as daaac8e): spawn.sh close refused: spawn.sh: no resume record for wwzdhx-reviewer",
    ])
  })
})

describe("endMerged: right after a merge", () => {
  test("ends the PR's worker, reviewer and tester, each row with the merged sha", async () => {
    const { closed, deps, reported } = fakes()
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: {
          "yrpygg-reviewer": {
            kind: "reviewer",
            name: "yrpygg-reviewer",
            pr: URL,
            worker: "yrpygg-worker",
          },
          "yrpygg-tester": {
            kind: "tester",
            name: "yrpygg-tester",
            pr: URL,
            worker: "yrpygg-worker",
          },
          "yrpygg-worker": { kind: "worker", name: "yrpygg-worker", pr: URL },
        },
        sessions: {
          "yrpygg-reviewer": live("yrpygg-reviewer"),
          "yrpygg-tester": live("yrpygg-tester", { status: "shell" }),
          "yrpygg-worker": live("yrpygg-worker"),
        },
      }),
      deps,
    )
    expect(closed).toEqual(["yrpygg-reviewer", "yrpygg-tester", "yrpygg-worker"])
    expect(reported.map(([, text]) => text)).toEqual([
      "ended automatically: #2110 merged as daaac8e",
      "ended automatically: #2110 merged as daaac8e",
      "ended automatically: #2110 merged as daaac8e",
    ])
    expect(lines).toHaveLength(3)
  })

  test("a worker with a next task, and the checkers of a worker on its next PR, stay", async () => {
    const { closed, deps } = fakes()
    await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: {
          "fnhq3x-reviewer": {
            kind: "reviewer",
            name: "fnhq3x-reviewer",
            pr: URL,
            worker: "fnhq3x-worker",
          },
          "fnhq3x-worker": { kind: "worker", name: "fnhq3x-worker", pr: NEXT },
          "p2vxnf-worker": { kind: "worker", name: "p2vxnf-worker" },
        },
        sessions: {
          "fnhq3x-reviewer": live("fnhq3x-reviewer"),
          "fnhq3x-worker": live("fnhq3x-worker"),
          "p2vxnf-worker": live("p2vxnf-worker"),
        },
      }),
      deps,
    )
    expect(closed).toEqual([])
  })

  test("a worker and its checker whose other PR is still open stay: the worker's transcript links it", async () => {
    const { closed, deps } = fakes()
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        linkedPrs: async (sessionId) => (sessionId === "sess-fnhq3x-worker" ? [URL, NEXT] : []),
        prState: async (url) =>
          url === URL
            ? MERGED
            : url === NEXT
              ? { ...MERGED, mergeSha: undefined, state: "open" }
              : null,
        roster: {
          "fnhq3x-reviewer": {
            kind: "reviewer",
            name: "fnhq3x-reviewer",
            pr: URL,
            worker: "fnhq3x-worker",
          },
          "fnhq3x-worker": { kind: "worker", name: "fnhq3x-worker", pr: URL },
        },
        sessions: {
          "fnhq3x-reviewer": live("fnhq3x-reviewer"),
          "fnhq3x-worker": live("fnhq3x-worker"),
        },
      }),
      deps,
    )
    expect(closed).toEqual([])
    expect(lines).toEqual([])
  })

  test("a session whose other PR could not be read stays, as on a rate limit", async () => {
    const { closed, deps } = fakes()
    await endMerged(
      URL,
      "daaac8e0000",
      input({
        linkedPrs: async (sessionId) => (sessionId === "sess-k3m9px-worker" ? [URL, NEXT] : []),
        roster: { "k3m9px-worker": { kind: "worker", name: "k3m9px-worker", pr: URL } },
        sessions: { "k3m9px-worker": live("k3m9px-worker") },
      }),
      deps,
    )
    expect(closed).toEqual([])
  })

  test("a row whose session is gone is ended in the roster alone, and an ended row is left", async () => {
    const { closed, deps, reported } = fakes()
    const lines = await endMerged(
      URL,
      "daaac8e0000",
      input({
        roster: {
          "5j9yqr-reviewer": { kind: "reviewer", name: "5j9yqr-reviewer", pr: URL },
          "5j9yqr-tester": { kind: "tester", name: "5j9yqr-tester", pr: URL, status: "ended" },
        },
      }),
      deps,
    )
    expect(closed).toEqual([])
    expect(reported).toEqual([
      ["5j9yqr-reviewer", "ended automatically: #2110 merged as daaac8e, with no live session"],
    ])
    expect(lines.map((l) => l.text)).toEqual([
      "Ended 5j9yqr-reviewer's row: #2110 merged as daaac8e, with no live session",
    ])
  })
})

// 3 Nov, 05:35Z: a reviewer whose row named #689 was ended when #689 merged, while it still held #683, #693 and #106.
describe("a checker's prs list (#706)", () => {
  const A = "https://github.com/o/r/pull/2120"
  const B = "https://github.com/o/r/pull/2121"
  const C = "https://github.com/o/r/pull/2122"
  const OPEN: PrState = { head: "bbb2222", ref: "pg-2100-y", state: "open", verdicts: [] }
  const world = (prs?: string[]) =>
    input({
      prState: async (url) => (url === URL ? MERGED : [A, B, C].includes(url) ? OPEN : null),
      roster: {
        "x7rv2k-reviewer": {
          kind: "reviewer",
          name: "x7rv2k-reviewer",
          pr: URL,
          ...(prs ? { prs } : {}),
          worker: "x7rv2k-worker",
        },
      },
      sessions: {
        "x7rv2k-reviewer": live("x7rv2k-reviewer"),
        "x7rv2k-worker": live("x7rv2k-worker", { status: "busy" }),
      },
      workerPrs: async (name) => (name === "x7rv2k-worker" ? [URL] : []),
    })

  test("a reviewer holding the merged PR and three open ones stays, through endMerged and the sweep", async () => {
    const merged = fakes()
    expect(await endMerged(URL, "daaac8e0000", world([URL, A, B, C]), merged.deps)).toEqual([])
    const swept = fakes()
    expect(await sweep(world([URL, A, B, C]), swept.deps)).toEqual([])
    expect([...merged.closed, ...swept.closed]).toEqual([])
  })

  test("a row whose session is gone keeps its row while its list holds an open PR", async () => {
    const gone = { ...world([URL, A]), sessions: {} }
    const { deps, reported } = fakes()
    expect(await endMerged(URL, "daaac8e0000", gone, deps)).toEqual([])
    expect(reported).toEqual([])
  })

  test("an entry GitHub cannot read keeps a row whose session is gone", async () => {
    const gone = { ...world([URL, "https://github.com/o/r/pull/2199"]), sessions: {} }
    const { deps, reported } = fakes()
    expect(await endMerged(URL, "daaac8e0000", gone, deps)).toEqual([])
    expect(reported).toEqual([])
  })

  test("a row with no prs list, or one whose PRs are all done, ends as today", async () => {
    for (const prs of [undefined, [URL]]) {
      const merged = fakes()
      await endMerged(URL, "daaac8e0000", world(prs), merged.deps)
      expect(merged.closed).toEqual(["x7rv2k-reviewer"])
      const swept = fakes()
      await sweep(world(prs), swept.deps)
      expect(swept.closed).toEqual(["x7rv2k-reviewer"])
    }
  })
})

describe("unsavedLive: the worktrees a session used, read for unsaved work", () => {
  const sh = (cwd: string, ...argv: string[]) => {
    const r = Bun.spawnSync(argv, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
    if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr}`)
  }
  // A clone of a scratch remote, pushed clean, a linked worktree of it on a pushed branch, and a transcript whose cwds are the clone and the worktree.
  const scratch = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "auto-end-")))
    const remote = join(root, "remote.git")
    const main = join(root, "main")
    const dir = join(root, "work")
    sh(root, "git", "init", "-q", "--bare", remote)
    sh(root, "git", "clone", "-q", remote, main)
    writeFileSync(join(main, "a.txt"), "a\n")
    sh(main, "git", "add", "a.txt")
    sh(main, "git", "commit", "-qm", "a")
    sh(main, "git", "push", "-q", "origin", "HEAD")
    sh(main, "git", "worktree", "add", "-q", "-b", "work", dir)
    sh(dir, "git", "push", "-q", "origin", "work")
    const projects = join(root, "projects")
    mkdirSync(join(projects, "-scratch"), { recursive: true })
    writeFileSync(
      join(projects, "-scratch", "sess-1.jsonl"),
      `${JSON.stringify({ cwd: main, type: "user" })}\n${JSON.stringify({ cwd: dir, type: "user" })}\n`,
    )
    const target: Target = {
      kind: "reviewer",
      name: "k3m9px-reviewer",
      refs: [],
      sessionId: "sess-1",
    }
    return { dir, main, projects, target }
  }

  test("a clean, pushed worktree reads null; an uncommitted file and an unpushed commit each name the worktree", async () => {
    const { dir, projects, target } = scratch()
    expect(await unsavedLive(target, projects)).toBeNull()
    writeFileSync(join(dir, "b.txt"), "b\n")
    expect(await unsavedLive(target, projects)).toBe(`uncommitted work in ${dir}`)
    sh(dir, "git", "add", "b.txt")
    sh(dir, "git", "commit", "-qm", "b")
    expect(await unsavedLive(target, projects)).toBe(`unpushed commits in ${dir}`)
  })

  // PG-1165: the post-merge cleanup discards a finished PR's worktree, so its unsaved work holds no end
  test("a Playground worktree whose PR merged or closed holds no end, while an open or unreadable one, or another repo's, still does", async () => {
    const { dir, main, projects, target } = scratch()
    const wt = join(main, ".claude", "worktrees", "pg-1")
    sh(main, "git", "worktree", "add", "-q", "-b", "PG-1-thing", wt)
    writeFileSync(join(wt, "wip.txt"), "x\n")
    writeFileSync(
      join(projects, "-scratch", "sess-1.jsonl"),
      `${JSON.stringify({ cwd: main })}\n${JSON.stringify({ cwd: wt })}\n`,
    )
    const url = "https://github.com/o/r/pull/1"
    const merged = { ...target, pr: url }
    const asked: string[] = []
    const done = (finished: boolean) => ({
      finished: async (path: string, pr?: string) => (asked.push(`${path} ${pr}`), finished),
      main,
    })
    expect(await unsavedLive(merged, projects, done(true))).toBeNull()
    expect(asked).toEqual([`${wt} ${url}`])
    expect(await unsavedLive(merged, projects, done(false))).toBe(`uncommitted work in ${wt}`)
    expect(await unsavedLive(merged, projects)).toBe(`uncommitted work in ${wt}`)
    writeFileSync(join(dir, "b.txt"), "b\n")
    writeFileSync(join(projects, "-scratch", "sess-1.jsonl"), `${JSON.stringify({ cwd: dir })}\n`)
    expect(await unsavedLive(merged, projects, done(true))).toBe(`uncommitted work in ${dir}`)
    const lines = await endOne(merged, "worker-prs-done", {
      cleanup: async () => [`removed ${wt}`],
      close: async () => ({ ok: true, out: "" }),
      report: async () => {},
      unsaved: (t) => unsavedLive(t, projects, done(true)),
    })
    expect(lines[0]!.text).toStartWith("Not ended k3m9px-reviewer")
    writeFileSync(
      join(projects, "-scratch", "sess-1.jsonl"),
      `${JSON.stringify({ cwd: main })}\n${JSON.stringify({ cwd: wt })}\n`,
    )
    const ended = await endOne(merged, "worker-prs-done", {
      cleanup: async () => [`removed ${wt}`],
      close: async () => ({ ok: true, out: "" }),
      report: async () => {},
      unsaved: (t) => unsavedLive(t, projects, done(true)),
    })
    expect(ended).toEqual([
      { text: `Ended k3m9px-reviewer: worker-prs-done; cleanup: removed ${wt}`, to: "builder" },
    ])
  })

  test("the main checkout every session starts in is never read: its untracked files hold no end", async () => {
    const { main, projects, target } = scratch()
    writeFileSync(join(main, "par.out"), "x\n")
    expect(await unsavedLive(target, projects)).toBeNull()
  })

  test("a read that fails holds the end: a worktree with no commit to read, and a transcript folder that cannot be read", async () => {
    const { main, projects, target } = scratch()
    const bare = join(projects, "..", "empty")
    sh(main, "git", "worktree", "add", "-q", "--orphan", "-b", "empty", bare)
    writeFileSync(join(projects, "-scratch", "sess-1.jsonl"), `${JSON.stringify({ cwd: bare })}\n`)
    expect(await unsavedLive(target, projects)).toBe(`could not check ${bare}`)
    const file = join(projects, "..", "not-a-folder")
    writeFileSync(file, "")
    expect(await unsavedLive(target, file)).toBe(`could not check its transcript in ${file}`)
  })
})

// PG-919: a merge cleans what each closed session used
describe("cleanWorktree: each worktree a closed session used, removed with its containers and branch once its work is saved", () => {
  const ENV = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
  }
  const run = (cwd: string, ...argv: string[]) => {
    const r = Bun.spawnSync(argv, { cwd, env: ENV })
    if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr}`)
  }
  const live = (container: string) => container === "playground-dashboard-db"
  // A scratch remote and its clone as the main checkout, with a pushed worktree pg-1 in its .claude/worktrees on branch PG-1-thing.
  const recorded = (wt: string) => {
    mkdirSync(join(wt, ".turbo"), { recursive: true })
    writeFileSync(join(wt, ".turbo", "dev.pgid"), "{}")
  }

  const machine = (name = "pg-1", at?: (main: string) => string) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-")))
    const remote = join(root, "remote.git")
    const main = join(root, "main")
    run(root, "git", "init", "-q", "--bare", remote)
    run(root, "git", "clone", "-q", remote, main)
    writeFileSync(join(main, "a.txt"), "a\n")
    // as the repo's own .gitignore keeps a stack's record out of git status
    writeFileSync(join(main, ".gitignore"), ".turbo/\n")
    run(main, "git", "add", "a.txt", ".gitignore")
    run(main, "git", "commit", "-qm", "a")
    run(main, "git", "push", "-q", "origin", "HEAD")
    const wt = at ? at(main) : join(main, ".claude", "worktrees", name)
    run(main, "git", "worktree", "add", "-q", "-b", "PG-1-thing", wt)
    run(wt, "git", "push", "-q", "origin", "PG-1-thing")
    return { main, root, wt }
  }
  const branches = (repo: string) =>
    Bun.spawnSync(["git", "-C", repo, "branch", "--format=%(refname:short)"]).stdout.toString()
  // Real git on the scratch repos; playground rm stands in as git worktree remove in the scratch main checkout, refusing when told to; docker lists the given names.
  const fakes = (
    main: string,
    listed: string[] | null,
    refuse?: string,
    over: Partial<CleanupDeps> = {},
  ) => {
    const calls: string[] = []
    const deps: CleanupDeps = {
      containers: async () => listed,
      devStop: async (dir) => (calls.push(`dev:stop ${dir}`), { ok: true, out: "" }),
      git: async (dir, args) => {
        const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: ENV })
        return r.exitCode === 0 ? r.stdout.toString().trim() : null
      },
      finished: async () => false,
      held: async () => null,
      live,
      liveBranch: "live/dashboard",
      main,
      removeContainer: async (name) => (calls.push(`docker rm -fv ${name}`), true),
      rm: async (path, reason) => {
        calls.push(`rm ${path} (${reason})`)
        if (refuse) return { ok: false, out: refuse }
        run(main, "git", "worktree", "remove", path)
        return { ok: true, out: "" }
      },
      ...over,
    }
    return { calls, deps }
  }

  test("a clean, pushed worktree goes, with its dev stack stopped, its two containers and its branch", async () => {
    const { main, wt } = machine()
    const listed = ["playground-pg-1-db", "playground-pg-1-redis", "playground-dashboard-db"]
    recorded(wt)
    const { calls, deps } = fakes(main, listed)
    expect(await cleanWorktree(wt, "k3m9px-reviewer ended", deps)).toBe(
      `removed ${wt}, containers playground-pg-1-db, playground-pg-1-redis, branch PG-1-thing`,
    )
    expect(calls).toEqual([
      `dev:stop ${wt}`,
      `rm ${wt} (k3m9px-reviewer ended)`,
      "docker rm -fv playground-pg-1-db",
      "docker rm -fv playground-pg-1-redis",
    ])
    expect(existsSync(wt)).toBe(false)
    expect(branches(main)).not.toContain("PG-1-thing")
  })

  test("a dirty worktree, or one with unpushed commits, is kept with the reason, and nothing of it is touched", async () => {
    const { main, wt } = machine()
    const { calls, deps } = fakes(main, ["playground-pg-1-db"])
    writeFileSync(join(wt, "wip.txt"), "x\n")
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(`kept ${wt}: uncommitted work`)
    run(wt, "git", "add", "wip.txt")
    run(wt, "git", "commit", "-qm", "wip")
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(`kept ${wt}: unpushed commits`)
    expect(calls).toEqual([])
    expect(existsSync(wt)).toBe(true)
    expect(branches(main)).toContain("PG-1-thing")
  })

  test("a commit on no remote ref counts as pushed once named as a PR's head GitHub keeps, as after a merge deletes its branch", async () => {
    const { main, wt } = machine()
    const { deps } = fakes(main, [])
    writeFileSync(join(wt, "wip.txt"), "x\n")
    run(wt, "git", "add", "wip.txt")
    run(wt, "git", "commit", "-qm", "wip")
    const head = Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"]).stdout.toString().trim()
    expect(await cleanWorktree(wt, "r ended", deps, { pushed: head })).toBe(
      `removed ${wt}, branch PG-1-thing`,
    )
  })

  test("a worktree playground rm refuses is kept with its refusal, and its containers and branch stay", async () => {
    const { main, wt } = machine()
    const refusal = `${wt} is held by pid 7 (zsh) working in ${wt}`
    recorded(wt)
    const { calls, deps } = fakes(main, ["playground-pg-1-db"], refusal)
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(`kept ${wt}: ${refusal}`)
    expect(calls).toEqual([`dev:stop ${wt}`, `rm ${wt} (r ended)`])
    expect(branches(main)).toContain("PG-1-thing")
  })

  test("the live dashboard's checkout is kept before anything runs, even clean and pushed", async () => {
    const { main } = machine()
    const desk = join(main, ".claude", "worktrees", "desk")
    run(main, "git", "worktree", "add", "-q", "-b", "live/dashboard", desk)
    run(desk, "git", "push", "-q", "origin", "live/dashboard")
    const { calls, deps } = fakes(main, ["playground-desk-db"])
    expect(await cleanWorktree(desk, "r ended", deps)).toBe(
      `kept ${desk}: the live dashboard's checkout`,
    )
    expect(calls).toEqual([])
    expect(existsSync(desk)).toBe(true)
  })

  test("a worktree a live session holds is kept before its dev stack is stopped", async () => {
    const { main, wt } = machine()
    const holder = `${wt} is held by k3m9px-worker, which the roster lists as working`
    const { calls, deps } = fakes(main, ["playground-pg-1-db"], undefined, {
      held: async () => holder,
    })
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(`kept ${wt}: ${holder}`)
    expect(calls).toEqual([])
  })

  test("the session's PR goes to the holder check and playground rm, so the merging worker's hold by that PR's number alone does not keep a checker's review-<n>", async () => {
    const { main, wt } = machine("review-2110")
    const url = "https://github.com/o/r/pull/2110"
    const asked: (string | undefined)[] = []
    const { deps } = fakes(main, [], undefined, {
      held: async (_path, pr) => (asked.push(pr), null),
      rm: async (path, _reason, pr) => {
        asked.push(pr)
        run(main, "git", "worktree", "remove", path)
        return { ok: true, out: "" }
      },
    })
    expect(await cleanWorktree(wt, "r ended", deps, { pr: url })).toBe(
      `removed ${wt}, branch PG-1-thing`,
    )
    expect(asked).toEqual([url, url])
  })

  // PG-1165
  test("a merged or closed PR's worktree goes through playground rm --discard whatever it holds, while one whose PR is open or unreadable keeps its work", async () => {
    const { main, wt } = machine()
    const url = "https://github.com/o/r/pull/1"
    const asked: (string | undefined)[] = []
    const open = fakes(main, [], undefined, {
      finished: async (path, pr) => (asked.push(`${path} ${pr}`), false),
    })
    writeFileSync(join(wt, "wip.txt"), "x\n")
    expect(await cleanWorktree(wt, "r ended", open.deps, { pr: url })).toBe(
      `kept ${wt}: uncommitted work`,
    )
    expect(open.calls).toEqual([])
    const moved: string[] = []
    const done = fakes(main, [], undefined, {
      finished: async (path, pr) => (asked.push(`${path} ${pr}`), true),
      rm: async (path, reason, pr, discard) => {
        moved.push(`rm ${path} (${reason}) ${pr} discard=${discard}`)
        return { ok: true, out: "" }
      },
    })
    expect(await cleanWorktree(wt, "r ended", done.deps, { pr: url })).toBe(`removed ${wt}`)
    expect(moved).toEqual([`rm ${wt} (r ended) ${url} discard=true`])
    expect(asked).toEqual([`${wt} ${url}`, `${wt} ${url}`])
  })

  test("another repo's worktree keeps its unpushed commits though its PR merged, since git worktree remove and branch -D leave no trash to restore from", async () => {
    const playground = machine()
    const other = machine()
    const asked: string[] = []
    const { calls, deps } = fakes(playground.main, [], undefined, {
      finished: async (path) => (asked.push(path), true),
    })
    writeFileSync(join(other.wt, "wip.txt"), "x\n")
    run(other.wt, "git", "add", "wip.txt")
    run(other.wt, "git", "commit", "-qm", "wip")
    expect(await cleanWorktree(other.wt, "r ended", deps)).toBe(
      `kept ${other.wt}: unpushed commits`,
    )
    expect(asked).toEqual([])
    expect(calls).toEqual([])
    expect(branches(other.main)).toContain("PG-1-thing")
  })

  test("a clean worktree rm refuses for work not on canary goes through --discard once its PR merged or closed, and stays while it is open", async () => {
    const { main, wt } = machine()
    const unlanded = `${wt}'s HEAD holds work not landed on origin/canary (fetch origin canary if it merged since): playground rm --worktree ${wt} --discard removes it anyway`
    for (const finished of [false, true]) {
      const moved: string[] = []
      const { deps } = fakes(main, [], undefined, {
        finished: async () => finished,
        rm: async (path, _reason, _pr, discard) => {
          moved.push(`rm ${path} discard=${discard}`)
          return discard ? { ok: true, out: "" } : { ok: false, out: unlanded }
        },
      })
      expect(await cleanWorktree(wt, "r ended", deps)).toBe(
        finished ? `removed ${wt}` : `kept ${wt}: ${unlanded}`,
      )
      expect(moved).toEqual([
        `rm ${wt} discard=false`,
        ...(finished ? [`rm ${wt} discard=true`] : []),
      ])
    }
  })

  test("a dev:stop refusal keeps the worktree, while no recorded stack lets it go", async () => {
    const { main, wt } = machine()
    recorded(wt)
    const refusal = "dev:stop: the stack's process groups also hold pid 9, so nothing is signalled"
    const refused = fakes(main, ["playground-pg-1-db"], undefined, {
      devStop: async () => ({ ok: false, out: refusal }),
    })
    expect(await cleanWorktree(wt, "r ended", refused.deps)).toBe(`kept ${wt}: ${refusal}`)
    expect(refused.calls).toEqual([])
    const none = fakes(main, ["playground-pg-1-db"], undefined, {
      devStop: async () => ({ ok: false, out: `dev:stop: no stack is recorded in ${wt}` }),
    })
    expect(await cleanWorktree(wt, "r ended", none.deps)).toBe(
      `removed ${wt}, containers playground-pg-1-db, branch PG-1-thing`,
    )
  })

  test("a clone with no recorded stack goes without dev:stop, so one with no node_modules, whose dev:stop cannot load, still goes (PG-1186)", async () => {
    const { main, wt } = machine()
    const stops: string[] = []
    const { deps } = fakes(main, [], undefined, {
      devStop: async (dir) => (
        stops.push(dir),
        { ok: false, out: 'error: script "dev:stop" exited with code 1' }
      ),
    })
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(`removed ${wt}, branch PG-1-thing`)
    expect(stops).toEqual([])
  })

  test("a docker ps that cannot list keeps the containers and says so", async () => {
    const { main, wt } = machine()
    const { calls, deps } = fakes(main, null)
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(
      `removed ${wt}, its containers kept since docker ps could not list them, branch PG-1-thing`,
    )
    expect(calls.filter((c) => c.startsWith("docker"))).toEqual([])
  })

  test("the main checkout and a worktree outside .claude/worktrees are never targets", async () => {
    const { main } = machine()
    const { calls, deps } = fakes(main, [])
    expect(await cleanWorktree(main, "r ended", deps)).toBe(`kept ${main}: not a linked worktree`)
    const outside = machine("pg-1", (m) => join(m, "..", "elsewhere"))
    const other = fakes(outside.main, [])
    expect(await cleanWorktree(outside.wt, "r ended", other.deps)).toBe(
      `kept ${outside.wt}: not a worktree in ${join(outside.main, ".claude", "worktrees")}`,
    )
    expect([...calls, ...other.calls]).toEqual([])
    expect(existsSync(outside.wt)).toBe(true)
  })

  test("another repo's clean worktree goes through git worktree remove with no force flag, then prune and its branch; a dirty one is kept", async () => {
    const ours = machine()
    const theirs = machine("zs-1", (m) => join(m, "..", "zerostarter-wt"))
    const { calls, deps } = fakes(ours.main, ["playground-zs-1-db"])
    writeFileSync(join(theirs.wt, "wip.txt"), "x\n")
    expect(await cleanWorktree(theirs.wt, "r ended", deps)).toBe(
      `kept ${theirs.wt}: uncommitted work`,
    )
    run(theirs.wt, "git", "clean", "-qf")
    expect(await cleanWorktree(theirs.wt, "r ended", deps)).toBe(
      `removed ${theirs.wt}, branch PG-1-thing`,
    )
    expect(calls).toEqual([])
    expect(existsSync(theirs.wt)).toBe(false)
    expect(branches(theirs.main)).not.toContain("PG-1-thing")
  })

  // PG-1419: the cleanup's held check carries the worktree's own PR freed, so a merged PR's worktree goes under a stale working row naming its branch, and one with commits past the merged head stays, its commit named
  test("a stale working row naming the branch no longer keeps a merged PR's worktree, and one with a commit past the merged head stays, its commit named", async () => {
    const url = "https://github.com/o/r/pull/1"
    const rmOf = (data: string, main: string, prHead: string): RmDeps => ({
      caller: async () => undefined,
      clones: () => [],
      data,
      decision: async () => null,
      home: data,
      main,
      merged: () => null,
      notify: () => {},
      places: () => [],
      prState: async () => ({ head: prHead, number: 1, state: "MERGED" }),
      procs: () => [],
      session: async () => "t",
    })
    const { main, root, wt } = machine()
    recorded(wt)
    const full = (rev: string) =>
      Bun.spawnSync(["git", "-C", wt, "rev-parse", rev]).stdout.toString().trim()
    writeFileSync(
      join(root, "roster.json"),
      JSON.stringify({
        agents: [{ branch: "PG-1-thing", name: "abc123-worker", status: "working" }],
      }),
    )
    const route = fakes(main, [], undefined, {
      held: (path, pr) => cleanupHeld(path, pr, rmOf(root, main, full("HEAD"))),
    })
    expect(await cleanWorktree(wt, "r ended", route.deps, { pr: url })).toContain(`removed ${wt}`)

    const over = machine()
    const overShort = (rev: string) =>
      Bun.spawnSync(["git", "-C", over.wt, "rev-parse", "--short", rev]).stdout.toString().trim()
    const overFull = (rev: string) =>
      Bun.spawnSync(["git", "-C", over.wt, "rev-parse", rev]).stdout.toString().trim()
    writeFileSync(join(over.wt, "b.txt"), "b\n")
    run(over.wt, "git", "add", "b.txt")
    run(over.wt, "git", "commit", "-qm", "b")
    writeFileSync(
      join(over.root, "roster.json"),
      JSON.stringify({
        agents: [{ branch: "PG-1-thing", name: "abc123-worker", status: "working" }],
      }),
    )
    const stalled = fakes(over.main, [], undefined, {
      finished: async () => true,
      held: (path, pr) => cleanupHeld(path, pr, rmOf(over.root, over.main, overFull("HEAD~1"))),
    })
    expect(await cleanWorktree(over.wt, "r ended", stalled.deps, { pr: url })).toBe(
      `kept ${over.wt}: ${over.wt} is held by abc123-worker, which the roster lists as working, and its commits past merged PR #1's head stay: ${overShort("HEAD")}`,
    )
    expect(existsSync(over.wt)).toBe(true)
  })

  test("the container names are the worktree's own, whole, and never the live dashboard's or first run's", () => {
    const main = "/h/playground"
    const wt = (name: string) => join(main, ".claude", "worktrees", name)
    expect(containersFor(wt("pg-1"), main, live)).toEqual([
      "playground-pg-1-db",
      "playground-pg-1-redis",
    ])
    expect(containersFor(wt("dashboard"), main, live)).toEqual(["playground-dashboard-redis"])
    expect(containersFor(main, main, live)).toEqual([])
    expect(containersFor(join(wt("pg-1"), "sub"), main, live)).toEqual([])
  })

  test("only a listed name equal to the worktree's own is removed, never one that only starts with it", async () => {
    const { main, wt } = machine()
    const listed = [
      "playground-pg-1-db-ab12",
      "playground-pg-1-dbx",
      "playground-pg-10-db",
      "playground-db",
    ]
    const { calls, deps } = fakes(main, listed)
    expect(await cleanWorktree(wt, "r ended", deps)).toBe(`removed ${wt}, branch PG-1-thing`)
    expect(calls.filter((c) => c.startsWith("docker"))).toEqual([])
  })
})

describe("endMerged: a closed session's worktrees are cleaned after its close, and only then", () => {
  test("the cleanup's lines join the end's line, and a session whose close is refused is not cleaned", async () => {
    const cleaned: string[] = []
    const cleanup = async (target: Target) => (
      cleaned.push(`${target.name} ${target.pr}`),
      [`removed /wt/${target.name}`]
    )
    const roster = { "m4tqzr-reviewer": { kind: "reviewer", name: "m4tqzr-reviewer", pr: URL } }
    const sessions = { "m4tqzr-reviewer": live("m4tqzr-reviewer") }
    const ok = fakes({ cleanup })
    expect(await endMerged(URL, "daaac8e0000", input({ roster, sessions }), ok.deps)).toEqual([
      {
        text: "Ended m4tqzr-reviewer: #2110 merged as daaac8e; cleanup: removed /wt/m4tqzr-reviewer",
        to: "builder",
      },
    ])
    const refused = fakes({ cleanup, close: async () => ({ ok: false, out: "no pane" }) })
    await endMerged(URL, "daaac8e0000", input({ roster, sessions }), refused.deps)
    expect(cleaned).toEqual([`m4tqzr-reviewer ${URL}`])
  })
})
