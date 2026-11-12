import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as state from "../../../../../../extensions/core/skills/code-review-loop/scripts/state"
import { REQUIRED_CHECKS } from "../../../../../../packages/scripts/src/pr-merge/gates"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const STATE_TS = join(ROOT, "extensions/core/skills/code-review-loop/scripts/state.ts")

// The scratch folders the suite makes, removed at the end (the process table reads none of them).
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "state-ts-"))
  dirs.push(dir)
  return dir
}

const git = (repo: string, ...args: string[]): string => {
  const out = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

const runCli = (args: string[]): { code: number; stdout: string; stderr: string } => {
  const out = Bun.spawnSync([process.execPath, STATE_TS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() }
}

const withIo = (
  run: (...args: string[]) => string,
  body: () => Promise<void> | void,
): Promise<void> => {
  const real = { ...state.io }
  state.io.run = run
  return Promise.resolve(body()).finally(() => Object.assign(state.io, real))
}

const HEAD = "69a6a4c0123456789abcdef0123456789abcdef0"

const comment = (body: string, login = "acme-owner", at = "2026-10-07T10:00:00Z") => ({
  author: { login },
  body,
  createdAt: at,
  url: `https://x/${at}`,
})

test("01 the verdict line", () => {
  expect(
    state.verdictOf(
      "## ReviewBot · round 2: 5/5 at 69a6a4c · 0 blocking, 0 should-fix, 0 nits\n\nok",
    ),
  ).toEqual([2, 5, "69a6a4c"])
  expect(state.verdictOf("Some text\n## ReviewBot · round 2: 5/5 at 69a6a4c")).toBeNull()
  expect(state.verdictOf("ReviewBot round 2 inline findings at 69a6a4c")).toBeNull()
})

test("01a the shebang keeps bun from loading the working folder's env file", () => {
  expect(readFileSync(STATE_TS, "utf8").split("\n")[0]).toContain("--no-env-file")
})

test("02 COMMENTS.md gives the verdict line, and pr:merge reads the same header", () => {
  const commentsMd = readFileSync(
    join(ROOT, "extensions/core/skills/code-review-loop/references/COMMENTS.md"),
    "utf8",
  )
  const template = /^## ReviewBot · round <r>: <s>\/5 at <sha7>.*$/m.exec(commentsMd)
  expect(template).not.toBeNull()
  const filled = template![0]
    .replaceAll("<r>", "3")
    .replaceAll("<s>", "4")
    .replaceAll("<sha7>", "abc1234")
  expect(state.verdictOf(filled)).toEqual([3, 4, "abc1234"])
  const gates = readFileSync(join(ROOT, "packages/config/src/verdicts.ts"), "utf8")
  expect(gates).toContain("ReviewBot\\s*·\\s*round")
})

test("03 the newest verdict by this account wins; another account's never counts", () => {
  const comments = [
    comment(
      "## ReviewBot · round 1: 3/5 at 1111111 · 1 blocking",
      "acme-owner",
      "2026-10-07T09:00:00Z",
    ),
    comment(
      "## ReviewBot · round 9: 5/5 at 69a6a4c · 0 blocking",
      "someone-else",
      "2026-10-07T09:30:00Z",
    ),
    comment(
      "## ReviewBot · round 2: 4/5 at 2222222 · 0 blocking, 1 should-fix",
      "acme-owner",
      "2026-10-07T10:00:00Z",
    ),
    comment("thanks, fixed", "acme-owner", "2026-10-07T10:05:00Z"),
  ]
  const [verdict, source] = state.latestVerdict(comments, "acme-owner")
  expect(verdict).toEqual([2, 4, "2222222"])
  expect(source!.createdAt).toBe("2026-10-07T10:00:00Z")
})

const prFixture = (n: number, head: string, bodies: string[]) => ({
  number: n,
  title: `pr ${n}`,
  isDraft: n === 3,
  headRefOid: head,
  comments: { nodes: bodies.map((b) => comment(b)) },
})

test("04 the recovery scan's three states", () => {
  const rows = Object.fromEntries(
    [
      prFixture(1, HEAD, []),
      prFixture(2, HEAD, ["## ReviewBot · round 1: 4/5 at 1111111 · 1 should-fix"]),
      prFixture(3, HEAD, ["## ReviewBot · round 2: 5/5 at 69a6a4c · 0 blocking"]),
    ].map((p) => [
      (state.scanRow(p, "acme-owner").number as number).toString(),
      state.scanRow(p, "acme-owner"),
    ]),
  )
  expect(rows["1"]!.status).toBe("UNREVIEWED")
  expect(rows["2"]!.status).toBe("STALE 4/5 at 1111111")
  expect(rows["3"]!.status).toBe("SCORED 5/5")
  expect(rows["3"]!.draft).toBe(true)
})

const roster = {
  agents: [
    { name: "worker-greed", pr: "https://github.com/acme/archive/pull/157", status: "working" },
    {
      name: "reviewer-greed",
      pr: "https://github.com/acme/archive/pull/157#issuecomment-1",
      status: "working",
    },
    { name: "reviewer-old", pr: "https://github.com/acme/archive/pull/157", status: "ended" },
    { name: "worker-other", pr: "https://github.com/acme/archive/pull/1570", status: "working" },
    {
      name: "worker-elsewhere",
      pr: "https://github.com/someone/dispatcher/pull/157",
      status: "working",
    },
    { name: "no-pr", status: "working" },
    "not an agent",
  ],
}
const plans = {
  "pg-82-sidebar.md": "- resume #71 after #120\n",
  "pg-84-tables.md": "#860 and ##86 and PR#86x",
}

test("04d a PR's holders are its agents not ended, never #1570's or another repo's", () => {
  expect(state.holders(roster, "acme/archive", 157)).toEqual(["reviewer-greed", "worker-greed"])
  expect(state.holders(null, "acme/archive", 157)).toEqual([])
})

test("04f a plan naming #71 parks it; #860, ##86 and #86x do not name #86", () => {
  expect(state.plansNaming(plans, 71)).toEqual(["pg-82-sidebar.md"])
  expect(state.plansNaming(plans, 86)).toEqual([])
})

test("04h holder tags: held, parked, many plans, lost, outside author, held wins", () => {
  expect(state.holderTag(roster, plans, "acme/archive", 157)).toEqual([
    "reviewer-greed, worker-greed",
    false,
  ])
  expect(state.holderTag(roster, plans, "acme/archive", 71)).toEqual([
    "no agent; parked in pg-82-sidebar.md",
    false,
  ])
  expect(
    state.holderTag(null, { "a.md": "#71", "b.md": "#71", "c.md": "#71" }, "acme/archive", 71)[0],
  ).toBe("no agent; parked in a.md (+2)")
  expect(state.holderTag(roster, plans, "acme/archive", 99)).toEqual([
    "no agent, in no plan: lost",
    true,
  ])
  expect(state.holderTag(roster, plans, "acme/archive", 99, "visitor", "acme-owner")).toEqual([
    "outside author visitor: the builder triages (a colleague's: the dispatcher decides per the org's channel triage; another's app PR: read-only review then the gate; skills/factory: closed)",
    false,
  ])
  expect(state.holderTag(roster, plans, "acme/archive", 99, "acme-owner", "acme-owner")[1]).toBe(
    true,
  )
  expect(state.holderTag(roster, plans, "acme/archive", 157, "visitor", "acme-owner")).toEqual([
    "reviewer-greed, worker-greed",
    false,
  ])
  expect(
    state.scanRow({ ...prFixture(4, HEAD, []), author: { login: "visitor" } }, "acme-owner").author,
  ).toBe("visitor")
})

test("04k the plans are the folder's .md files, a missing folder is no plans", () => {
  const d = scratch()
  writeFileSync(join(d, "a.md"), "#5")
  writeFileSync(join(d, "b.txt"), "#5")
  const saved = process.env.PLAYGROUND_PLANS_DIR
  try {
    process.env.PLAYGROUND_PLANS_DIR = d
    expect(state.readPlans()).toEqual({ "a.md": "#5" })
    process.env.PLAYGROUND_PLANS_DIR = join(d, "missing")
    expect(state.readPlans()).toEqual({})
  } finally {
    saved === undefined
      ? delete process.env.PLAYGROUND_PLANS_DIR
      : (process.env.PLAYGROUND_PLANS_DIR = saved)
  }
})

const plan = [
  { id: "pr-157", pr: "https://github.com/acme/archive/pull/157", worker: "worker-greed" },
  { id: "pr-158", pr: "https://github.com/acme/archive/pull/158", worker: "worker-greed (D)" },
  { id: "pr-159", pr: "https://github.com/acme/archive/pull/159", worker: "reviewer-old" },
  { id: "pr-160", pr: "https://github.com/acme/archive/pull/160", worker: null },
  { id: "pr-161", pr: "https://github.com/acme/archive/pull/1610", worker: "worker-other" },
  {
    id: "pr-162",
    pr: "https://github.com/acme/archive/pull/162",
    worker: "reviewer-old worker-greed",
  },
  { id: "no-pr", worker: "worker-other" },
  "not an item",
]

test("04m plan.json's items hold or park a PR by their live workers", () => {
  expect(state.holderTag(roster, {}, "acme/archive", 158, undefined, undefined, plan)).toEqual([
    "worker-greed",
    false,
  ])
  expect(state.holderTag(roster, {}, "acme/archive", 157, undefined, undefined, plan)).toEqual([
    "reviewer-greed, worker-greed",
    false,
  ])
  expect(state.holderTag(roster, {}, "acme/archive", 159, undefined, undefined, plan)).toEqual([
    "no agent; parked in plan.json",
    false,
  ])
  expect(state.holderTag(roster, {}, "acme/archive", 160, undefined, undefined, plan)).toEqual([
    "no agent; parked in plan.json",
    false,
  ])
  expect(state.holderTag(roster, {}, "acme/archive", 162, undefined, undefined, plan)).toEqual([
    "no agent; parked in plan.json",
    false,
  ])
  expect(state.holderTag(roster, {}, "acme/archive", 161, undefined, undefined, plan)).toEqual([
    "no agent, in no plan: lost",
    true,
  ])
})

test("04q the plan is plan.json's lane items, a malformed lane skipped; a missing plan.json is no plan", () => {
  const d = scratch()
  const path = join(d, "plan.json")
  writeFileSync(
    path,
    JSON.stringify({ lanes: [{ items: plan.slice(0, 2) }, { items: "none" }, "not a lane"] }),
  )
  const saved = process.env.PLAYGROUND_PLAN_PATH
  try {
    process.env.PLAYGROUND_PLAN_PATH = path
    expect(state.readPlan()).toEqual(plan.slice(0, 2))
    process.env.PLAYGROUND_PLAN_PATH = join(d, "missing.json")
    expect(state.readPlan()).toEqual([])
  } finally {
    saved === undefined
      ? delete process.env.PLAYGROUND_PLAN_PATH
      : (process.env.PLAYGROUND_PLAN_PATH = saved)
  }
})

const threads = [
  {
    id: "T1",
    isResolved: false,
    path: "a.ts",
    line: 3,
    comments: {
      nodes: [
        comment("Off by one.\n\nReviewBot · round 1"),
        comment("fixed in abc", "acme-owner", "2026-10-07T11:00:00Z"),
      ],
    },
  },
  {
    id: "T2",
    isResolved: true,
    path: "b.ts",
    line: 4,
    comments: { nodes: [comment("Old.\n\nReviewBot · round 1")] },
  },
  {
    id: "T3",
    isResolved: false,
    path: "c.ts",
    line: 5,
    comments: { nodes: [comment("a human's thread")] },
  },
  {
    id: "T4",
    isResolved: false,
    path: "d.ts",
    line: 6,
    comments: { nodes: [comment("Name it.\n\nReviewBot · round 2")] },
  },
]

test("05 our open threads", () => {
  const opened = state.openThreads(threads)
  expect(opened.map((t) => t.id)).toEqual(["T1", "T3", "T4"])
  expect(opened.filter((t) => t.ours).map((t) => t.id)).toEqual(["T1", "T4"])
  expect(opened[0]!.replied).toBe(true)
  expect(opened[2]!.replied).toBe(false)
  expect(opened[1]!.replied).toBe(false)
})

test("05d the opener decides ours past 20 replies, and an outdated line falls back to originalLine", () => {
  const longThread = {
    id: "T5",
    isResolved: false,
    path: "e.ts",
    line: null,
    originalLine: 9,
    opener: { nodes: [{ body: "Long one.\n\nReviewBot · round 1" }] },
    comments: { nodes: [comment("a reply 25 comments in")] },
  }
  const t5 = state.openThreads([longThread])[0]!
  expect(t5.ours).toBe(true)
  expect(t5.replied).toBe(true)
  expect(t5.where).toBe("e.ts:9")
})

const response = (body: string, status = "200 OK", headers = ""): string =>
  `HTTP/2.0 ${status}\r\nX-Ratelimit-Resource: core\r\n${headers}\r\n${body}`

test("05e wait rides out a failed read and ends on the push, polling REST every 300s", async () => {
  const calls: string[][] = []
  const sleeps: number[] = []
  const limited = new state.Called(
    ["gh"],
    response(
      '{"message": "API rate limit exceeded"}',
      "403 Forbidden",
      "X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1000600\r\n",
    ),
    "",
  )
  await withIo(
    (...args: string[]) => {
      calls.push(args)
      if (calls.length === 1) throw new state.Called(args, "", "network down")
      if (calls.length === 2) throw limited
      if (calls.length === 3)
        return response(`{"merged": false, "sha": "${HEAD}", "state": "open"}`)
      return response(
        '{"merged": false, "sha": "abcdef0123456789abcdef0123456789abcdef01", "state": "open"}',
      )
    },
    async () => {
      const realSleep = state.io.sleep
      const realTime = state.io.time
      state.io.sleep = (s: number) => {
        sleeps.push(s)
        return Promise.resolve()
      }
      state.io.time = () => 1000000
      const err: string[] = []
      const realWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = (line: string | Uint8Array): boolean => {
        err.push(line.toString())
        return true
      }
      try {
        await state.cmdWait("acme/archive", "160", HEAD.slice(0, 7))
      } finally {
        process.stderr.write = realWrite
        state.io.sleep = realSleep
        state.io.time = realTime
      }
      expect(err.join("")).toContain("trying again")
    },
  )
  expect(calls.length).toBe(4)
  expect(calls.map((c) => c.slice(0, 4))).toEqual([
    ["gh", "api", "-i", "repos/acme/archive/pulls/160"],
    ["gh", "api", "-i", "repos/acme/archive/pulls/160"],
    ["gh", "api", "-i", "repos/acme/archive/pulls/160"],
    ["gh", "api", "-i", "repos/acme/archive/pulls/160"],
  ])
  expect(sleeps).toEqual([300, 605, 300])
})

const waitOnce = async (view: string): Promise<string> => {
  let out = ""
  await withIo(
    () => response(view),
    async () => {
      const realSleep = state.io.sleep
      state.io.sleep = () => Promise.resolve()
      const lines: string[] = []
      const realLog = console.log
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      try {
        await state.cmdWait("acme/archive", "160", HEAD)
      } finally {
        console.log = realLog
        state.io.sleep = realSleep
      }
      out = lines.join("\n").trim()
    },
  )
  return out
}

test("05g a merged PR ends the wait as CLOSED MERGED", async () => {
  expect(await waitOnce(`{"merged": true, "sha": "${HEAD}", "state": "closed"}`)).toBe(
    "CLOSED MERGED",
  )
})

test("05h a PR closed unmerged ends the wait as CLOSED CLOSED", async () => {
  expect(await waitOnce(`{"merged": false, "sha": "${HEAD}", "state": "closed"}`)).toBe(
    "CLOSED CLOSED",
  )
})

const waitThrough = async (views: string[]): Promise<[string, number, number[]]> => {
  const reads: string[][] = []
  const naps: number[] = []
  let out = ""
  await withIo(
    (...a: string[]) => {
      reads.push(a)
      return response(views[Math.min(reads.length, views.length) - 1]!)
    },
    async () => {
      const realSleep = state.io.sleep
      state.io.sleep = (s: number) => {
        naps.push(s)
        return Promise.resolve()
      }
      const lines: string[] = []
      const realLog = console.log
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      try {
        await state.cmdWait("acme/archive", "160", HEAD)
      } finally {
        console.log = realLog
        state.io.sleep = realSleep
      }
      out = lines.join("\n").trim()
    },
  )
  return [out, reads.length, naps]
}

const closed = `{"merged": false, "sha": "${HEAD}", "state": "closed"}`
const still = `{"merged": false, "sha": "${HEAD}", "state": "open"}`
const moved =
  '{"merged": false, "sha": "abcdef0123456789abcdef0123456789abcdef01", "state": "open"}'

test("05m a PR closed unmerged is read once more a poll later before the wait ends as CLOSED CLOSED", async () => {
  expect(await waitThrough([closed, closed])).toEqual(["CLOSED CLOSED", 2, [300]])
})

test("05n a close and reopen (#1701) keeps the wait running to the next push", async () => {
  expect(await waitThrough([closed, still, moved])).toEqual([
    "MOVED abcdef0123456789abcdef0123456789abcdef01",
    3,
    [300, 300],
  ])
})

test("05o a second close after a reopen is read once more too", async () => {
  const [out, reads] = await waitThrough([closed, still, closed, closed])
  expect(out).toBe("CLOSED CLOSED")
  expect(reads).toBe(4)
})

// A concluded run completes at 1000100 s by default, after the waiter's start at 1000000 s.
const at = (s: number): string => new Date(s * 1000).toISOString()
const run = (name: string, conclusion: string | null, id = 1, done = 1000100) => ({
  completed_at: conclusion ? at(done) : null,
  conclusion,
  id,
  name,
})
const runs = (...list: object[]): string => JSON.stringify(list)
const AUDIT = "Audit, Lint, and Build"

// Each poll reads the pull, then the head's check runs while the PR is open at <sha>; a Called in either list is a failed read.
const checksThrough = async (
  pulls: (string | state.Called)[],
  checkRuns: (string | state.Called)[],
  now = 1000000,
): Promise<[string, number[], string[]]> => {
  const naps: number[] = []
  const paths: string[] = []
  let p = 0
  let c = 0
  let out = ""
  const next = (list: (string | state.Called)[], i: number): string => {
    const item = list[Math.min(i, list.length - 1)]!
    if (item instanceof state.Called) throw item
    return response(item)
  }
  await withIo(
    (...a: string[]) => {
      paths.push(a[3]!)
      return a[3]!.includes("/check-runs") ? next(checkRuns, c++) : next(pulls, p++)
    },
    async () => {
      const realSleep = state.io.sleep
      const realTime = state.io.time
      state.io.sleep = (s: number) => {
        naps.push(s)
        if (naps.length > 20) throw new Error("the wait never returned")
        return Promise.resolve()
      }
      state.io.time = () => now
      const lines: string[] = []
      const realLog = console.log
      const realWrite = process.stderr.write.bind(process.stderr)
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      process.stderr.write = () => true
      try {
        await state.cmdChecks("acme/archive", "160", HEAD.slice(0, 7))
      } finally {
        console.log = realLog
        process.stderr.write = realWrite
        state.io.sleep = realSleep
        state.io.time = realTime
      }
      out = lines.join("\n").trim()
    },
  )
  return [out, naps, paths]
}

test("05p checks: a check that fails, then passes on a re-run at the same head, ends with both conclusions (#1410)", async () => {
  const [out, naps, paths] = await checksThrough(
    [still],
    [
      runs(run(AUDIT, null), run("test", "failure")),
      runs(run(AUDIT, "success"), run("test", null, 2)),
      runs(run(AUDIT, "success"), run("test", "success", 2), run("Shards", "success")),
    ],
  )
  expect(out).toBe(`CHECK success ${AUDIT}\nCHECK success test`)
  expect(naps).toEqual([300, 300])
  expect(paths.filter((x) => x.includes("/check-runs"))).toEqual(
    Array(3).fill(`repos/acme/archive/commits/${HEAD}/check-runs?per_page=100`),
  )
})

test("05q checks: both checks concluded, one red, end the wait at once, since red is a conclusion (#1410)", async () => {
  const [out, naps] = await checksThrough(
    [still],
    [runs(run("test", "failure"), run(AUDIT, "success"))],
  )
  expect(out).toBe(`CHECK success ${AUDIT}\nCHECK failure test`)
  expect(naps).toEqual([])
})

test("05w checks: a red that concludes after the other check is reported, and the next waiter sees its re-run clear (#1410)", async () => {
  const red = runs(run("test", "success", 1, 1000100), run(AUDIT, "failure", 1, 1000400))
  const [first, firstNaps] = await checksThrough(
    [still],
    [runs(run("test", "success"), run(AUDIT, null)), red],
  )
  expect(first).toBe(`CHECK failure ${AUDIT}\nCHECK success test`)
  expect(firstNaps).toEqual([300])
  const [next, naps] = await checksThrough(
    [still],
    [
      red,
      runs(run("test", "success"), run(AUDIT, null, 2)),
      runs(run("test", "success"), run(AUDIT, "success", 2, 1002000)),
    ],
    1000500,
  )
  expect(next).toBe(`CHECK success ${AUDIT}\nCHECK success test`)
  expect(naps).toEqual([300, 300])
})

test("05x checks: a cancelled run from before the waiter started is waited past too (#1410)", async () => {
  const [out, naps] = await checksThrough(
    [still],
    [
      runs(run("test", "cancelled", 1, 999000), run(AUDIT, "success")),
      runs(run("test", "success", 2), run(AUDIT, "success")),
    ],
  )
  expect(out).toBe(`CHECK success ${AUDIT}\nCHECK success test`)
  expect(naps).toEqual([300])
})

test("05r checks: a gate check with no run yet, or two runs of one name, waits on the newest (#1410)", async () => {
  const [out] = await checksThrough(
    [still],
    [
      runs(run(AUDIT, "success")),
      runs(run("test", "success", 3), run(AUDIT, "success"), run("test", "failure", 2)),
    ],
  )
  expect(out).toBe(`CHECK success ${AUDIT}\nCHECK success test`)
})

test("05s checks: a head that moves mid-wait ends it as MOVED (#1410)", async () => {
  const [out, naps] = await checksThrough(
    [still, moved],
    [runs(run(AUDIT, null), run("test", null))],
  )
  expect(out).toBe("MOVED abcdef0123456789abcdef0123456789abcdef01")
  expect(naps).toEqual([300])
})

test("05t checks: a closed PR ends it as CLOSED, read once more a poll later, with no check read (#1410)", async () => {
  const [out, naps, paths] = await checksThrough([closed, closed], [runs()])
  expect(out).toBe("CLOSED CLOSED")
  expect(naps).toEqual([300])
  expect(paths.some((x) => x.includes("/check-runs"))).toBe(false)
  const merged = `{"merged": true, "sha": "${HEAD}", "state": "closed"}`
  expect((await checksThrough([merged], [runs()]))[0]).toBe("CLOSED MERGED")
})

test("05u checks: a rate-limited check read waits for its reset, then reads again (#1410)", async () => {
  const limited = new state.Called(
    ["gh"],
    response(
      '{"message": "API rate limit exceeded"}',
      "403 Forbidden",
      "X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1000600\r\n",
    ),
    "",
  )
  const [out, naps] = await checksThrough(
    [still],
    [limited, runs(run(AUDIT, "success"), run("test", "success"))],
  )
  expect(out).toBe(`CHECK success ${AUDIT}\nCHECK success test`)
  expect(naps).toEqual([605])
})

test("05y checks: v0.0.82's ship pin holds while a red shard keeps Audit, Lint, and Build running, and an all-green pin ends green (#1650)", async () => {
  const pin = [
    run("Lint and Build", "success"),
    run("test", "success"),
    run("Suite (9)", "failure"),
  ]
  const [red, redNaps] = await checksThrough(
    [still],
    [runs(...pin, run(AUDIT, null)), runs(...pin, run(AUDIT, "failure"))],
  )
  expect(red).toBe(`CHECK failure ${AUDIT}\nCHECK success test`)
  expect(redNaps).toEqual([300])
  const [green, greenNaps] = await checksThrough(
    [still],
    [runs(run("Suite (9)", "success"), run("test", "success"), run(AUDIT, "success"))],
  )
  expect(green).toBe(`CHECK success ${AUDIT}\nCHECK success test`)
  expect(greenNaps).toEqual([])
})

test("05v the checks it waits on are the gate's own (#1410)", () => {
  expect(state.GATE_CHECKS).toEqual(REQUIRED_CHECKS)
})

test("05z wait and checks run from the system tmp folder whatever folder they start in, so no waiter holds a review worktree", async () => {
  const merged = `{"merged": true, "sha": "${HEAD}", "state": "closed"}`
  const start = process.cwd()
  try {
    for (const cmd of [state.cmdWait, state.cmdChecks]) {
      process.chdir(scratch())
      let cwd = ""
      await withIo(
        () => {
          cwd = process.cwd()
          return response(merged)
        },
        async () => {
          const realLog = console.log
          console.log = () => {}
          try {
            await cmd("acme/archive", "160", HEAD)
          } finally {
            console.log = realLog
          }
        },
      )
      expect(realpathSync(cwd)).toBe(realpathSync(tmpdir()))
    }
  } finally {
    process.chdir(start)
  }
})

test("05i the comment and thread lists past a page are named as cut", () => {
  const page = {
    comments: { pageInfo: { hasPreviousPage: true } },
    reviews: { pageInfo: { hasPreviousPage: false } },
    reviewThreads: { pageInfo: { hasNextPage: true } },
  }
  expect(state.cutLists(page)).toEqual(["comments", "reviewThreads"])
  expect(
    state.cutLists({
      comments: { pageInfo: {} },
      reviews: { pageInfo: {} },
      reviewThreads: { pageInfo: {} },
    }),
  ).toEqual([])
  expect(state.PR_QUERY).toContain("hasNextPage")
  expect(state.PR_QUERY.split("hasPreviousPage").length - 1).toBe(2)
})

test("06 since the verdict: replies and reviews with a body, never a verdict", () => {
  const since = state.saidSince(
    [
      comment(
        "## ReviewBot · round 1: 3/5 at 1111111 · 1 blocking",
        "acme-owner",
        "2026-10-07T09:00:00Z",
      ),
      comment(
        "## ReviewBot · round 2: 4/5 at 2222222 · 0 blocking, 1 should-fix",
        "acme-owner",
        "2026-10-07T10:00:00Z",
      ),
      comment("thanks, fixed", "acme-owner", "2026-10-07T10:05:00Z"),
    ],
    [
      { author: { login: "bot" }, body: "LGTM", submittedAt: "2026-10-07T10:10:00Z" },
      { author: { login: "x" }, body: "", submittedAt: "2026-10-07T10:20:00Z" },
    ],
    "2026-10-07T09:45:00Z",
  )
  expect(since.map(([, who]) => who)).toEqual(["acme-owner", "bot"])
})

const scratchRepo = (repo: string, files: Record<string, string>): void => {
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "canary")
  git(repo, "config", "user.email", "t@t")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "commit.gpgsign", "false")
  writeFiles(repo, files)
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "base")
  git(repo, "checkout", "-qb", "pr")
}

const writeFiles = (repo: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    const full = join(repo, path)
    mkdirSync(dirnameOf(full), { recursive: true })
    writeFileSync(full, text)
  }
}

const dirnameOf = (p: string): string => {
  const parts = p.split("/")
  parts.pop()
  return parts.join("/")
}

const touched = (repo: string): { code: number; listed: string[]; stderr: string } => {
  const out = runCli(["touched-tests", repo, "canary", "HEAD"])
  return { code: out.code, listed: out.stdout.split("\n").filter(Boolean), stderr: out.stderr }
}

test("07 delta: a base merge versus the PR's own push, on a real repository", () => {
  const repo = scratch()
  git(repo, "init", "-q", "-b", "canary")
  git(repo, "config", "user.email", "t@t")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "commit.gpgsign", "false")
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
  writeFileSync(join(repo, "a.txt"), `${lines.join("\n")}\n`)
  writeFileSync(join(repo, "b.txt"), "b\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "base")
  git(repo, "checkout", "-qb", "pr")
  const changed = [...lines]
  changed[14] = "line 15, fixed"
  writeFileSync(join(repo, "a.txt"), `${changed.join("\n")}\n`)
  git(repo, "commit", "-qam", "own change")
  const oldHead = git(repo, "rev-parse", "HEAD")
  git(repo, "checkout", "-q", "canary")
  writeFileSync(join(repo, "a.txt"), `top 1\ntop 2\n${lines.join("\n")}\n`)
  writeFileSync(join(repo, "b.txt"), "b, from canary\n")
  git(repo, "commit", "-qam", "canary moves under the PR's file")
  git(repo, "checkout", "-q", "pr")
  git(repo, "merge", "-q", "--no-edit", "canary")
  const merged = git(repo, "rev-parse", "HEAD")

  const naive = git(repo, "diff", "--name-only", `${oldHead}..${merged}`, "--", "a.txt")
  expect(naive).toBe("a.txt")
  const oldDiff = git(repo, "diff", `canary...${oldHead}`)
  const newDiff = git(repo, "diff", `canary...${merged}`)
  expect(oldDiff).not.toBe(newDiff)
  expect(state.deltaKind(oldDiff, newDiff)).toEqual(["BASE-MERGE", []])

  writeFileSync(join(repo, "c.txt"), "new\n")
  git(repo, "add", "c.txt")
  git(repo, "commit", "-qm", "own push")
  const pushed = git(repo, "rev-parse", "HEAD")
  expect(state.deltaKind(oldDiff, git(repo, "diff", `canary...${pushed}`))).toEqual([
    "OWN",
    ["c.txt"],
  ])

  git(repo, "checkout", "-qb", "hand", oldHead)
  const beside = [...lines]
  beside[13] = "line 14, canary"
  git(repo, "checkout", "-q", "canary")
  writeFileSync(join(repo, "a.txt"), `top 1\ntop 2\n${beside.join("\n")}\n`)
  git(repo, "commit", "-qam", "canary edits the line beside the PR's")
  git(repo, "checkout", "-q", "hand")
  const conflicted = Bun.spawnSync(["git", "-C", repo, "merge", "-q", "--no-edit", "canary"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(conflicted.exitCode).not.toBe(0)
  const both = [...beside]
  both[14] = "line 15, fixed"
  writeFileSync(join(repo, "a.txt"), `top 1\ntop 2\n${both.join("\n")}\n`)
  git(repo, "commit", "-qam", "resolve by hand, keeping both sides")
  expect(
    state.deltaKind(oldDiff, git(repo, "diff", `canary...${git(repo, "rev-parse", "HEAD")}`)),
  ).toEqual(["BASE-MERGE", []])
  const dropped = [...beside]
  writeFileSync(join(repo, "a.txt"), `top 1\ntop 2\n${dropped.join("\n")}\n`)
  git(repo, "commit", "-qam", "a resolution that drops the PR's line")
  expect(
    state.deltaKind(oldDiff, git(repo, "diff", `canary...${git(repo, "rev-parse", "HEAD")}`)),
  ).toEqual(["OWN", ["a.txt"]])

  const out = runCli(["delta", repo, "canary", oldHead, merged])
  expect(out.code).toBe(0)
  expect(out.stdout.trim()).toBe("BASE-MERGE")
})

test("07i a push of the PR's own that only moves its line is OWN, though its changed lines read the same", () => {
  const repo = scratch()
  git(repo, "init", "-q", "-b", "canary")
  git(repo, "config", "user.email", "t@t")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "m.py"), "def f():\n    pass\n\n\ndef g():\n    pass\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "base")
  git(repo, "checkout", "-qb", "pr")
  writeFileSync(join(repo, "m.py"), "def f():\n    check()\n    pass\n\n\ndef g():\n    pass\n")
  git(repo, "commit", "-qam", "guard f")
  const oldHead = git(repo, "rev-parse", "HEAD")
  writeFileSync(join(repo, "m.py"), "def f():\n    pass\n\n\ndef g():\n    check()\n    pass\n")
  git(repo, "commit", "-qam", "move the guard to g")
  const out = runCli(["delta", repo, "canary", oldHead, "HEAD"])
  expect(out.stdout.trim()).toBe("OWN: m.py")
})

test("08 input it does not implement is refused, never ignored", () => {
  for (const [args, name] of [
    [["scan"], "a missing argument"],
    [["scan", "acme/archive", "--table"], "an extra flag"],
    [["pr", "acme/archive", "#12"], "a PR number with a #"],
    [["wait", "x/y", "1", "HEAD"], "a ref that is not a SHA"],
    [["checks", "x/y", "1", "HEAD"], "a checks ref that is not a SHA"],
    [["review"], "an unknown command"],
  ] as [string[], string][]) {
    const out = runCli(args)
    expect(out.code, name).not.toBe(0)
  }
})

const restComment = (body: string, login = "acme-owner", at = "2026-10-07T10:00:00Z") => ({
  body,
  created_at: at,
  html_url: `https://x/${at}`,
  user: { login },
})

const restView = {
  draft: true,
  head: { sha: HEAD },
  merged: false,
  number: 160,
  state: "open",
  title: "t",
  user: { login: "acme-owner" },
}
const restReviewComments = [
  {
    body: "Off by one.\n\nReviewBot · round 1",
    created_at: "2026-10-07T10:00:00Z",
    id: 1,
    in_reply_to_id: null,
    line: 3,
    original_line: 3,
    path: "a.py",
    user: { login: "acme-owner" },
  },
  {
    body: "fixed in abc",
    created_at: "2026-10-07T11:00:00Z",
    id: 2,
    in_reply_to_id: 1,
    line: 3,
    original_line: 3,
    path: "a.py",
    user: { login: "acme-owner" },
  },
  {
    body: "a human's note",
    created_at: "2026-10-07T12:00:00Z",
    id: 3,
    in_reply_to_id: null,
    line: null,
    original_line: 9,
    path: "b.py",
    user: { login: "someone" },
  },
]

test("09 the REST pull reads as the GraphQL one, threads grouped, resolution unknown", () => {
  const pr = state.restPr(
    restView,
    [restComment("## ReviewBot · round 1: 3/5 at 69a6a4c · 1 blocking")],
    [
      {
        body: "",
        state: "COMMENTED",
        submitted_at: "2026-10-07T10:00:00Z",
        user: { login: "acme-owner" },
      },
    ],
    restReviewComments,
  )
  expect(pr.state).toBe("OPEN")
  expect(pr.isDraft).toBe(true)
  expect(pr.headRefOid).toBe(HEAD)
  expect(pr.number).toBe(160)
  expect(state.latestVerdict(pr.comments.nodes, "acme-owner")[0]).toEqual([1, 3, "69a6a4c"])
  const listed = state.openThreads(pr.reviewThreads.nodes)
  expect(listed.map((t) => [t.where, t.ours, t.replied, t.unknown])).toEqual([
    ["a.py:3", true, true, true],
    ["b.py:9", false, false, true],
  ])
  expect(state.restPr({ ...restView, state: "closed", merged: true }, [], [], []).state).toBe(
    "MERGED",
  )
  const row = state.scanRow(
    state.restScanPr(restView, [restComment("## ReviewBot · round 2: 5/5 at 69a6a4c")]),
    "acme-owner",
  )
  expect(row.status).toBe("SCORED 5/5")
  expect(row.draft).toBe(true)
  expect(row.author).toBe("acme-owner")
})

test("09f pr reads over REST when GraphQL is spent, and says so", async () => {
  const calls: string[][] = []
  const lines: string[] = []
  await withIo(
    (...args: string[]) => {
      calls.push(args)
      if (args.includes("graphql"))
        throw new state.Called(args, "", "GraphQL: API rate limit already exceeded for user ID 1.")
      if (args[2] === "user") return "acme-owner\n"
      const path = args.find((a) => a.startsWith("repos/"))!
      if (path.endsWith("/pulls/160")) return JSON.stringify(restView)
      if (path.includes("/issues/160/comments"))
        return JSON.stringify([
          [restComment("## ReviewBot · round 1: 3/5 at 69a6a4c · 1 blocking")],
        ])
      if (path.includes("/pulls/160/reviews")) return JSON.stringify([[]])
      if (path.includes("/pulls/160/comments")) return JSON.stringify([restReviewComments])
      throw new Error(path)
    },
    async () => {
      const realLog = console.log
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      try {
        await state.cmdPr("acme/archive", "160")
      } finally {
        console.log = realLog
      }
    },
  )
  const text = lines.join("\n")
  expect(text).toContain("GraphQL spent")
  expect(text).toContain("threads, resolution unknown: 2, 1 of them ours")
  expect(text).toContain("round 1 3/5")
  expect(text).toContain("comment 1 a.py:3 (ours, author replied, resolution unknown): Off by one.")
  expect(calls.filter((c) => c.includes("graphql")).length).toBe(1)
  expect(calls.length).toBe(6)
})

test("09h any other GraphQL failure still fails, never falls back", async () => {
  const calls: string[][] = []
  let raised = false
  await withIo(
    (...args: string[]) => {
      calls.push(args)
      if (args.includes("graphql")) throw new state.Called(args, "", "HTTP 502: Bad Gateway")
      return args.at(-1)!.endsWith("/pulls/160") ? JSON.stringify(restView) : "[[]]"
    },
    async () => {
      try {
        await state.cmdPr("acme/archive", "160")
      } catch {
        raised = true
      }
    },
  )
  expect(raised).toBe(true)
  expect(calls.length).toBe(1)
})

test("09i scan reads over REST when GraphQL is spent, and any other failure still fails it", async () => {
  const other = {
    ...restView,
    draft: false,
    head: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
    number: 161,
    title: "u",
  }
  const data = scratch()
  const savedData = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  const scanCalls: string[][] = []
  const lines: string[] = []
  let raised = false
  try {
    await withIo(
      (...args: string[]) => {
        scanCalls.push(args)
        if (args.includes("graphql"))
          throw new state.Called(
            args,
            "",
            "GraphQL: API rate limit already exceeded for user ID 1.",
          )
        if (args[2] === "user") return "acme-owner\n"
        const path = args.find((a) => a.startsWith("repos/"))!
        if (path.includes("/pulls?state=open")) return JSON.stringify([[restView, other]])
        if (path.includes("/issues/160/comments"))
          return JSON.stringify([[restComment("## ReviewBot · round 2: 5/5 at 69a6a4c")]])
        if (path.includes("/issues/161/comments")) return JSON.stringify([[]])
        throw new Error(path)
      },
      async () => {
        const realLog = console.log
        console.log = (line?: unknown) => {
          lines.push(String(line))
        }
        try {
          await state.cmdScan("acme/archive")
        } finally {
          console.log = realLog
        }
      },
    )
    await withIo(
      (...args: string[]) => {
        if (args.includes("graphql")) throw new state.Called(args, "", "HTTP 502: Bad Gateway")
        return "[[]]"
      },
      async () => {
        try {
          await state.cmdScan("acme/archive")
        } catch {
          raised = true
        }
      },
    )
  } finally {
    savedData === undefined
      ? delete process.env.PLAYGROUND_DATA_DIR
      : (process.env.PLAYGROUND_DATA_DIR = savedData)
  }
  expect(lines[0]).toBe("GraphQL spent: read over REST")
  expect(lines.some((l) => l.startsWith("#160 69a6a4c SCORED 5/5 draft"))).toBe(true)
  expect(lines.some((l) => l.startsWith("#161 abcdef0 UNREVIEWED"))).toBe(true)
  expect(lines.at(-1)!.startsWith("RESULT: 2 open, 1 with an unscored head")).toBe(true)
  expect(scanCalls.filter((c) => c.includes("graphql")).length).toBe(1)
  expect(scanCalls.length).toBe(5)
  expect(raised).toBe(true)
})

test("10 touched-tests: the four rules on a scratch repository, printed one path per line", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/lib/sql.ts": "x\n",
    "scripts/plain.sh": "x\n",
    "tests/api/hono/src/routers/admin.test.ts":
      'import { q } from "../../../../../api/hono/src/lib/sql"\n',
    "tests/changed.test.ts": "x\n",
    "tests/scan.test.ts": 'readdirSync("skills")\n',
    "tests/scripts/hooks/no-playground-leak.test.ts": "x\n",
    "tests/test_scan.py": 'pathlib.Path("api/hono/src").rglob("*.ts")\n',
    "tests/unrelated.test.ts": "x\n",
    "tests/web/next/src/lib/chat.test.ts": 'import { send } from "@/lib/outbox"\n',
    "tests/web/next/src/lib/outbox.test.ts": "x\n",
    "web/next/src/lib/outbox.ts": "x\n",
  })
  writeFiles(repo, {
    "api/hono/src/lib/sql.ts": "y\n",
    "scripts/plain.sh": "y\n",
    "tests/changed.test.ts": "y\n",
    "web/next/src/lib/outbox.ts": "y\n",
  })
  git(repo, "commit", "-qam", "change")
  const { code, listed, stderr } = touched(repo)
  expect(code, stderr).toBe(0)
  expect(listed).toContain("tests/web/next/src/lib/outbox.test.ts")
  expect(listed).toContain("tests/changed.test.ts")
  expect(
    ["tests/api/hono/src/routers/admin.test.ts", "tests/web/next/src/lib/chat.test.ts"].every((t) =>
      listed.includes(t),
    ),
  ).toBe(true)
  expect(
    ["tests/scan.test.ts", "tests/scripts/hooks/no-playground-leak.test.ts"].every((t) =>
      listed.includes(t),
    ),
  ).toBe(true)
  expect([...new Set(listed)].sort()).toEqual(listed)
  expect(listed.length).toBe(6)
  expect(listed).not.toContain("tests/unrelated.test.ts")
  expect(listed).not.toContain("tests/test_scan.py")
  git(repo, "rm", "-q", "tests/changed.test.ts", "tests/web/next/src/lib/outbox.test.ts")
  git(repo, "commit", "-qm", "drop two tests")
  const after = touched(repo).listed
  expect(after.includes("tests/changed.test.ts")).toBe(false)
  expect(after.includes("tests/web/next/src/lib/outbox.test.ts")).toBe(false)
})

test("10 touched-tests: scan words inside fixture strings read as no scanner", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/lib/sql.ts": "x\n",
    "tests/changed.test.ts": "x\n",
    "tests/fixture.test.ts":
      "// the fixture's own text, not a scan this test runs\n" +
      "const shape = 'readdirSync(\"skills\")'\n" +
      'const tip = "run git grep -n over the repo first"\n' +
      "const tag = `ls-files the whole repo`\n",
  })
  writeFiles(repo, { "api/hono/src/lib/sql.ts": "y\n", "tests/changed.test.ts": "y\n" })
  git(repo, "commit", "-qam", "change")
  const { code, listed, stderr } = touched(repo)
  expect(code, stderr).toBe(0)
  expect(listed).toContain("tests/changed.test.ts")
  expect(listed).not.toContain("tests/fixture.test.ts")
})

test("10 touched-tests: a real scanner reads as one past a stray backtick or a call's argument", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/lib/sql.ts": "x\n",
    "tests/changed.test.ts": "x\n",
    "tests/real.test.ts":
      "// a stray backtick in a comment: `\n" +
      "const re = /`x`/\n" +
      'const found = execSync("git ls-files -z")\n' +
      'const listed = spawnSync("git", ["grep", "-l", "x"])\n',
  })
  writeFiles(repo, { "api/hono/src/lib/sql.ts": "y\n", "tests/changed.test.ts": "y\n" })
  git(repo, "commit", "-qam", "change")
  const { code, listed, stderr } = touched(repo)
  expect(code, stderr).toBe(0)
  expect(listed).toContain("tests/real.test.ts")
  expect(listed).toContain("tests/changed.test.ts")
})

test("10 touched-tests: a real scanner reads as one past a quote in a regex literal", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/lib/sql.ts": "x\n",
    "tests/changed.test.ts": "x\n",
    "tests/caret.test.ts": 'const ok = /^"/.test(s) && readdirSync(dir).map((f) => "x")\n',
    "tests/plain.test.ts": 'const ok = /"/.test(s) && readdirSync(dir).filter((f) => f !== "x")\n',
    "tests/tick.test.ts": "if (/`/.test(s)) for (const f of readdirSync(d)) log(`${f}`)\n",
  })
  writeFiles(repo, { "api/hono/src/lib/sql.ts": "y\n", "tests/changed.test.ts": "y\n" })
  git(repo, "commit", "-qam", "change")
  const { code, listed, stderr } = touched(repo)
  expect(code, stderr).toBe(0)
  expect(listed).toContain("tests/caret.test.ts")
  expect(listed).toContain("tests/plain.test.ts")
  expect(listed).toContain("tests/tick.test.ts")
  expect(listed).toContain("tests/changed.test.ts")
})

test("10 touched-tests: a real scanner reads as one past a value-shaped quote inside a regex", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/lib/sql.ts": "x\n",
    "tests/changed.test.ts": "x\n",
    "tests/eqquote.test.ts": 'const ok = /a="/.test(s) && readdirSync(dir).map((f) => "x")\n',
    "tests/keyquote.test.ts": "const ok = /key:'/.test(s) && readdirSync(dir).map((f) => 'x')\n",
    "tests/gttick.test.ts": "const ok = />`/.test(s) && readdirSync(dir).map((f) => log(`${f}`))\n",
  })
  writeFiles(repo, { "api/hono/src/lib/sql.ts": "y\n", "tests/changed.test.ts": "y\n" })
  git(repo, "commit", "-qam", "change")
  const { code, listed, stderr } = touched(repo)
  expect(code, stderr).toBe(0)
  expect(listed).toContain("tests/eqquote.test.ts")
  expect(listed).toContain("tests/keyquote.test.ts")
  expect(listed).toContain("tests/gttick.test.ts")
  expect(listed).toContain("tests/changed.test.ts")
})

// The empty diff leaves rule 4's whole-tree picks alone, so the row pins the repo's own scanners and the fixture-string rule at every head
test("10 touched-tests: the repo's own scanners read as scanners and its fixture strings read as none", () => {
  const out = runCli(["touched-tests", ROOT, "HEAD", "HEAD"])
  const listed = out.stdout.split("\n").filter(Boolean)
  expect(out.code, out.stderr).toBe(0)
  expect(listed).toContain("tests/web/next/src/app/globals.test.ts")
  expect(listed).toContain("tests/web/next/src/native-title.test.ts")
  expect(listed).not.toContain(
    "tests/extensions/core/skills/code-review-loop/scripts/state.test.ts",
  )
})

test("10k a renamed file's old path still selects the test importing it", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "tests/uses-old.test.ts": 'import { a } from "@/lib/old"\n',
    "web/next/src/lib/old.ts": "x\n",
  })
  git(repo, "mv", "web/next/src/lib/old.ts", "web/next/src/lib/new.ts")
  git(repo, "commit", "-qm", "rename")
  expect(touched(repo).listed).toContain("tests/uses-old.test.ts")
})

const WALKERS = [
  "tests/packages/scripts/src/parity/record.test.ts",
  "tests/packages/scripts/src/trace-count/count.test.ts",
  "tests/packages/scripts/src/verify/prebuild.test.ts",
  "tests/skills/built-in-names.test.ts",
]

test("10p each test whose imported source walks the repo is listed for any change", () => {
  const repo = scratch()
  const files: Record<string, string> = { "docs/page.md": "x\n" }
  for (const path of WALKERS) files[path] = 'import { walk } from "./source"\n'
  scratchRepo(repo, files)
  writeFiles(repo, { "docs/page.md": "y\n" })
  git(repo, "commit", "-qam", "a docs line")
  const listed = touched(repo).listed
  expect(WALKERS.every((w) => listed.includes(w))).toBe(true)
})

test("10i a Python repo lists each tests/test_*.py that scans a folder holding a changed file", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "pyproject.toml": "[project]\n",
    "src/pkg/integrations/street/form.py": "x\n",
    "src/pkg/other.py": "x\n",
    "tests/helper.py": 'pathlib.Path("src/pkg").rglob("*.py")\n',
    "tests/test_chain.py":
      'ROOT = pathlib.Path(__file__).parents[1]\nfor p in (ROOT / "src" / "pkg" / "integrations").glob("**/*.py"):\n    pass\n',
    "tests/test_guard.py":
      'integrations = pathlib.Path("src/pkg/integrations")\nfor path in integrations.rglob("*.py"):\n    path.read_text()\n',
    "tests/test_one_file.py": '(ROOT / "src" / "pkg" / "other.py").read_text(encoding="utf-8")\n',
    "tests/test_plain.py": "from pkg import form\n",
  })
  writeFiles(repo, { "src/pkg/integrations/street/form.py": "y\n" })
  git(repo, "commit", "-qam", "change the form")
  const first = touched(repo)
  expect(first.code, first.stderr).toBe(0)
  expect(first.listed).toEqual(["tests/test_chain.py", "tests/test_guard.py"])
  writeFiles(repo, { "src/pkg/other.py": "y\n" })
  git(repo, "commit", "-qam", "change the other file")
  expect(touched(repo).listed).toContain("tests/test_one_file.py")
})

test("10l a changed prompt template lists each test pinning a prompt's digest", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "pyproject.toml": "[project]\n",
    "src/pkg/templates/maintenance.md": "x\n",
    "tests/test_digests.py": "DEVELOP_DIGESTS = {}\n",
    "tests/test_exit_goodbye.py": "assert hashlib.sha256(prompt.encode()).hexdigest() == want\n",
    "tests/test_plain.py": "from pkg import form\n",
  })
  writeFiles(repo, { "src/pkg/templates/maintenance.md": "y\n" })
  git(repo, "commit", "-qam", "change a template")
  const out = touched(repo)
  expect(out.code, out.stderr).toBe(0)
  expect(out.listed).toEqual(["tests/test_digests.py", "tests/test_exit_goodbye.py"])
})

test("10m a test importing a changed file relatively, and one in its mirrored folder naming it", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "scripts/briefs/new-tester.md": "x\n",
    "tests/elsewhere/names.test.ts":
      'const names = ["new-tester.md"]\nimport { fakeBun } from "./audit-fake"\n',
    "tests/packages/scripts/src/audit-canary.test.ts": 'import { fakeBun } from "./audit-fake"\n',
    "tests/packages/scripts/src/audit-fake.ts": "x\n",
    "tests/packages/scripts/src/lib/deep.test.ts": "import { fakeBun } from '../audit-fake.ts'\n",
    "tests/scripts/briefs/slots.test.ts":
      'for (const name of ["new-reviewer.md", "new-tester.md"]) read(join("scripts/briefs", name))\n',
  })
  writeFiles(repo, {
    "scripts/briefs/new-tester.md": "y\n",
    "tests/packages/scripts/src/audit-fake.ts": "y\n",
  })
  git(repo, "commit", "-qam", "change a helper and a brief")
  const out = touched(repo)
  expect(out.code, out.stderr).toBe(0)
  expect(out.listed).toEqual([
    "tests/packages/scripts/src/audit-canary.test.ts",
    "tests/packages/scripts/src/lib/deep.test.ts",
    "tests/scripts/briefs/slots.test.ts",
  ])
})

test("10n a test reading a changed file by its src-relative path quoted whole, with and without the extension", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/lib/health.ts": "x\n",
    "api/hono/src/main.ts": "x\n",
    "tests/api/hono/src/health-longer.test.ts": 'const deeper = await read("lib/health/x")\n',
    "tests/api/hono/src/lib/health-reader.test.ts":
      'const api = join(import.meta.dir, "../../../../../../api/hono/src")\nconst health = await read("lib/health")\n',
    "tests/api/hono/src/main-prose.test.ts": 'const note = "ship canary to main"\n',
    "tests/api/hono/src/main-reader.test.ts": 'const entry = await read("main.ts")\n',
    "tests/api/hono/src/routers/main-branch.test.ts": 'const want = "main"\n',
    "tests/web/next/src/components/dashboard/sidebar-footer.test.ts":
      'const web = join(import.meta.dir, "../../../../../../web/next/src")\nconst dashboard = await read("components/dashboard/app-sidebar.tsx")\n',
    "web/next/src/components/dashboard/app-sidebar.tsx": "x\n",
  })
  writeFiles(repo, {
    "api/hono/src/lib/health.ts": "y\n",
    "api/hono/src/main.ts": "y\n",
    "web/next/src/components/dashboard/app-sidebar.tsx": "y\n",
  })
  git(repo, "commit", "-qam", "change three sources")
  const out = touched(repo)
  expect(out.code, out.stderr).toBe(0)
  expect(out.listed).toEqual([
    "tests/api/hono/src/lib/health-reader.test.ts",
    "tests/api/hono/src/main-reader.test.ts",
    "tests/web/next/src/components/dashboard/sidebar-footer.test.ts",
  ])
})

test("10o a test that greps the repo is listed, by argv or shell, wrapped or after -C", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "scripts/plain.sh": "x\n",
    "tests/api/hono/src/lib/dev/old-proxy.test.ts":
      'Bun.spawnSync(["git", "grep", "-l", "-E", "old-address"], { cwd: ROOT })\n',
    "tests/dash-c.test.ts":
      'spawnSync(["git", "-C", ROOT, "grep", "-l", "x"])\nconst out = await $`git -C ${ROOT} grep -l y`.text()\n',
    "tests/log-grep.test.ts":
      'spawnSync(["git", "log", "--grep", "x"])\nconst out = await $`git log --oneline | grep x`.text()\n',
    "tests/new-guard.test.ts": "const found = await $`git grep -l TODO`.text()\n",
    "tests/prose.test.ts": 'const word = "grep"\n',
    "tests/wrapped.test.ts":
      'const found = Bun.spawnSync(\n  [\n    "git",\n    "grep",\n    "-l",\n  ],\n  { cwd: ROOT },\n)\n',
  })
  writeFiles(repo, { "scripts/plain.sh": "y\n" })
  git(repo, "commit", "-qam", "change a script no test names")
  const out = touched(repo)
  expect(out.code, out.stderr).toBe(0)
  expect(out.listed).toEqual([
    "tests/api/hono/src/lib/dev/old-proxy.test.ts",
    "tests/dash-c.test.ts",
    "tests/new-guard.test.ts",
    "tests/wrapped.test.ts",
  ])
})

test("10q a test joining a changed file's path from its package root is listed; a longer name and a bare src stay out", () => {
  const repo = scratch()
  scratchRepo(repo, {
    "api/hono/src/hosted.ts": "x\n",
    "tests/api/hono/src/routers/yard.test.ts":
      'const API = join(ROOT, "api/hono")\nconst HOSTED = join(API, "src/hosted.ts")\n',
    "tests/api/hono/src/routers/hosted-longer.test.ts":
      'const other = join(API, "src/hostedx.ts")\n',
    "tests/api/hono/src/routers/src-prose.test.ts": 'const folder = "src"\n',
    "tests/web/next/src/lib/outbox-reader.test.ts":
      'const WEB = join(ROOT, "web/next")\nconst outbox = await read(join(WEB, "src/lib/outbox"))\n',
    "web/next/src/lib/outbox.ts": "x\n",
  })
  writeFiles(repo, { "api/hono/src/hosted.ts": "y\n", "web/next/src/lib/outbox.ts": "y\n" })
  git(repo, "commit", "-qam", "change two sources")
  const out = touched(repo)
  expect(out.code, out.stderr).toBe(0)
  expect(out.listed).toEqual([
    "tests/api/hono/src/routers/yard.test.ts",
    "tests/web/next/src/lib/outbox-reader.test.ts",
  ])
})

test("07z a file that was last in the old diff and is not last in the new one reads unchanged", () => {
  const file = (name: string, line: string) =>
    `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+${line}\n`
  expect(
    state.deltaKind(file("a.ts", "x") + file("b.ts", "y"), file("b.ts", "y") + file("c.ts", "z")),
  ).toEqual(["OWN", ["a.ts", "c.ts"]])
})

test("10r a dotfile or a dotted folder keeps its whole name as its stem, so its spelling is never empty", () => {
  expect(state.stemOf(".gitignore")).toBe(".gitignore")
  expect(state.stemOf(".github/CODEOWNERS")).toBe(".github/CODEOWNERS")
  expect(state.stemOf("packages/x.y/README")).toBe("packages/x.y/README")
  expect(state.stemOf(".env.example")).toBe(".env")
  expect(state.stemOf("scripts/spawn.sh")).toBe("scripts/spawn")
  expect(state.spellings(".gitignore")).toEqual([".gitignore"])
  expect([...state.mirrors(".gitignore")]).toEqual([
    "tests/.gitignore.test.ts",
    "tests/.gitignore.test.tsx",
  ])
})

// #1359: a fake GitHub of one PR whose body and comments the reviewer read at READ_AT.
const READ_AT = "2026-11-08T19:00:00Z"
const BODY = "## TL;DR\n\n- the body as read"
const freshThrough = async (
  body: string,
  comments: object[],
  reviewComments: object[] = [],
  reviews: object[] = [],
): Promise<[string, number, string[]]> => {
  const paths: string[] = []
  const lines: string[] = []
  let code = 0
  await withIo(
    (...args: string[]) => {
      const path = args.find((a) => a.startsWith("repos/"))!
      paths.push(path)
      if (path === "repos/acme/archive/pulls/160")
        return JSON.stringify({ ...restView, body, updated_at: "2026-11-08T19:09:00Z" })
      if (path.startsWith("repos/acme/archive/issues/160/comments"))
        return JSON.stringify([comments])
      if (path.startsWith("repos/acme/archive/pulls/160/comments"))
        return JSON.stringify([reviewComments])
      if (path.startsWith("repos/acme/archive/pulls/160/reviews")) return JSON.stringify([reviews])
      throw new Error(path)
    },
    async () => {
      const realLog = console.log
      const realCode = process.exitCode
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      process.exitCode = 0
      try {
        await state.cmdFresh("acme/archive", "160", READ_AT, state.bodyDigest(BODY))
        code = Number(process.exitCode ?? 0)
      } finally {
        console.log = realLog
        process.exitCode = realCode ?? 0
      }
    },
  )
  return [lines.join("\n"), code, paths]
}

const posted = (body: string, at: string, id = 7) => ({
  body,
  created_at: at,
  html_url: `https://github.com/acme/archive/pull/160#issuecomment-${id}`,
  id,
  updated_at: at,
  user: { login: "acme-owner" },
})

test("10a fresh refuses a body edited after the read, naming the body (#1359)", async () => {
  const [out, code] = await freshThrough(`${BODY}\n- an edit after the read`, [])
  expect(code).toBe(1)
  expect(out).toContain(
    `CHANGED body: ${state.bodyDigest(BODY)} at the read, ${state.bodyDigest(`${BODY}\n- an edit after the read`)} now`,
  )
})

test("10b fresh refuses a comment posted after the read, naming it (#1359)", async () => {
  const [out, code, paths] = await freshThrough(BODY, [
    posted("an old note", "2026-11-08T18:00:00Z", 6),
    posted("Before shot posted\n\nmore", "2026-11-08T19:04:00Z"),
  ])
  expect(code).toBe(1)
  expect(out).toBe(
    "CHANGED comment https://github.com/acme/archive/pull/160#issuecomment-7 by acme-owner at 2026-11-08T19:04:00Z: Before shot posted",
  )
  expect(paths).toContain(`repos/acme/archive/issues/160/comments?since=${READ_AT}&per_page=100`)
})

test("10c fresh refuses a thread reply posted after the read, naming it (#1359)", async () => {
  const [out, code, paths] = await freshThrough(
    BODY,
    [],
    [{ ...posted("fixed in abc", "2026-11-08T19:05:00Z", 9), html_url: "https://x/r9" }],
  )
  expect(code).toBe(1)
  expect(out).toBe(
    "CHANGED review comment https://x/r9 by acme-owner at 2026-11-08T19:05:00Z: fixed in abc",
  )
  expect(paths).toContain(`repos/acme/archive/pulls/160/comments?since=${READ_AT}&per_page=100`)
})

test("10d fresh passes an unchanged body with no comment after the read, one at the read itself included (#1359)", async () => {
  const [out, code] = await freshThrough(BODY, [posted("at the read", READ_AT)])
  expect(code).toBe(0)
  expect(out).toBe(`FRESH since ${READ_AT}`)
})

test("10g fresh refuses a review submitted with a body after the read, naming it (#1359)", async () => {
  const review = (body: string, at: string | null, id: number) => ({
    body,
    html_url: `https://github.com/acme/archive/pull/160#pullrequestreview-${id}`,
    id,
    submitted_at: at,
    user: { login: "acme-owner" },
  })
  const [out, code, paths] = await freshThrough(
    BODY,
    [],
    [],
    [
      review("an old summary", "2026-11-08T18:00:00Z", 1),
      review("", "2026-11-08T19:06:00Z", 2),
      review("a pending draft", null, 3),
      review("Replies to round 1\n\nmore", "2026-11-08T19:07:00Z", 4),
    ],
  )
  expect(code).toBe(1)
  expect(out).toBe(
    "CHANGED review https://github.com/acme/archive/pull/160#pullrequestreview-4 by acme-owner at 2026-11-08T19:07:00Z: Replies to round 1",
  )
  expect(paths).toContain("repos/acme/archive/pulls/160/reviews?per_page=100")
})

test("10e pr prints the read line fresh takes: its start time and the body's digest (#1359)", async () => {
  const lines: string[] = []
  await withIo(
    (...args: string[]) => {
      if (args.includes("graphql"))
        throw new state.Called(args, "", "GraphQL: API rate limit already exceeded for user ID 1.")
      if (args[2] === "user") return "acme-owner\n"
      const path = args.find((a) => a.startsWith("repos/"))!
      if (path.endsWith("/pulls/160")) return JSON.stringify({ ...restView, body: BODY })
      return JSON.stringify([[]])
    },
    async () => {
      const realLog = console.log
      const realTime = state.io.time
      state.io.time = () => Date.parse(READ_AT) / 1000
      console.log = (line?: unknown) => {
        lines.push(String(line))
      }
      try {
        await state.cmdPr("acme/archive", "160")
      } finally {
        console.log = realLog
        state.io.time = realTime
      }
    },
  )
  expect(lines.at(-1)).toBe(`read: ${READ_AT} ${state.bodyDigest(BODY)}`)
  expect(state.PR_QUERY).toContain(" body ")
})

test("10f fresh refuses a read time or a digest it cannot use (#1359)", () => {
  for (const args of [
    ["fresh", "x/y", "1", "yesterday", "0123456789ab"],
    ["fresh", "x/y", "1", READ_AT, "nothex"],
  ]) {
    const out = runCli(args)
    expect(out.code, args.join(" ")).not.toBe(0)
    expect(out.stderr).toMatch(/not a read time|not a body digest/)
  }
})
