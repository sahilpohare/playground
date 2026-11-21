import { afterAll, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  agentOf,
  branchTicketOf,
  agentsBoard,
  cachedBy,
  CHUNK_BYTES,
  ciOf,
  foldTranscript,
  ghAnswer,
  ghGraphql,
  matchAgents,
  mergedOnce,
  mergedPullsPath,
  MERGED_PULLS_CAP,
  PR_TTL_MS,
  pullFromAnswer,
  pullOf,
  pullQuery,
  readMergedPulls,
  queued as queuedFor,
  repoOf,
  scanTranscript,
  scoreOf,
  workOf,
  type Pull,
  type TranscriptFacts,
} from "../../../../../../api/hono/src/lib/dashboard/agents"
import type { RosterAgent } from "../../../../../../api/hono/src/lib/dashboard/roster"
import {
  DISPATCHER,
  roleOf,
  type Live,
  type Worker,
} from "../../../../../../api/hono/src/lib/dashboard/workers"
import { org } from "../../../../../../api/hono/src/lib/org"
import { setSessionNames } from "../../../../../../packages/config/src/kinds"
import { orgOf } from "../../../../../../packages/config/src/org"
import { verdictsAt } from "../../../../../../packages/scripts/src/pr-merge/gates"
import { inFixture, onLiveDashboard } from "../../../../../dashboard-fixture"
import { withGhDown } from "../../../../../gh-down"
import { liveReads } from "../../../../../live-reads"
import { OLD, SEEDED_NAMES } from "../../../../../session-names"

// workers.ts sets the names its data folder holds when it loads; the cases name the managers' old names, as a machine past the switch does.
setSessionNames(SEEDED_NAMES)

// A tester's word at a commit.
const drove = (status: "green" | "red", commit: string) =>
  `## TesterBot · ${status === "green" ? "PASS" : "FAIL"} at ${commit.slice(0, 7)} · both shots attached`

// These drive the live paths against the test's own scratch files.
liveReads()

const line = (value: unknown) => JSON.stringify(value)
const DISPATCHER_ADDRESS = "uds:/tmp/cc-socks/23210.sock"

const fromDispatcher = (body: string, at = "2026-10-06T10:00:00.000Z") =>
  line({
    type: "user",
    uuid: `p-${at}`,
    timestamp: at,
    origin: { kind: "peer", name: DISPATCHER, from: DISPATCHER_ADDRESS, body },
    message: { role: "user", content: body },
  })

const assistant = (at: string, ...content: unknown[]) =>
  line({ type: "assistant", uuid: `a-${at}`, timestamp: at, message: { content } })

const send = (to: string, message: string) => ({
  type: "tool_use",
  name: "SendMessage",
  input: { message, summary: "x", to },
})

const bash = (description: string) => ({
  type: "tool_use",
  name: "Bash",
  input: { command: "bun test", description },
})

const toolResult = (at: string) =>
  line({
    type: "user",
    uuid: `r-${at}`,
    timestamp: at,
    message: { content: [{ type: "tool_result", content: "ok" }] },
  })

const NONE: TranscriptFacts = { lastActivityAt: null, report: null }

describe("foldTranscript", () => {
  test(`the last report to ${OLD.dispatcher} and the last line's time`, () => {
    const text = [
      fromDispatcher("Build the Agents app"),
      assistant("2026-10-06T10:01:00.000Z", send(DISPATCHER, "Plan: three parts\nmore detail")),
      assistant("2026-10-06T10:02:00.000Z", { type: "text", text: "Writing the API now." }),
      assistant("2026-10-06T10:03:00.000Z", bash("Run the agents tests")),
      toolResult("2026-10-06T10:03:05.000Z"),
    ].join("\n")
    const facts = foldTranscript(text, [DISPATCHER], new Map(), NONE)
    expect(facts.lastActivityAt).toBe("2026-10-06T10:03:05.000Z")
    expect(facts.report).toEqual({
      at: "2026-10-06T10:01:00.000Z",
      text: "Plan: three parts\nmore detail",
    })
  })

  test(`a reply to the uds address ${OLD.dispatcher} wrote from counts as a report; one to a peer does not`, () => {
    const addresses = new Map<string, Set<string>>()
    const text = [
      fromDispatcher("Go"),
      assistant("2026-10-06T10:01:00.000Z", send(DISPATCHER_ADDRESS, "Done: merged")),
      assistant("2026-10-06T10:02:00.000Z", send("worker-wrath", "Here is the roster module")),
    ].join("\n")
    const facts = foldTranscript(text, [DISPATCHER], addresses, NONE)
    expect(addresses.get(DISPATCHER)?.has(DISPATCHER_ADDRESS)).toBe(true)
    expect(facts.report?.text).toBe("Done: merged")
  })

  test(`a name with its [ref] still names ${OLD.dispatcher}`, () => {
    const text = assistant("2026-10-06T10:01:00.000Z", send(`${DISPATCHER} [3fa9c1]`, "Report"))
    expect(foldTranscript(text, [DISPATCHER], new Map(), NONE).report?.text).toBe("Report")
  })

  test("lines that say nothing new keep what earlier lines said", () => {
    const prior: TranscriptFacts = {
      lastActivityAt: "2026-10-06T09:00:00.000Z",
      report: { at: "2026-10-06T09:00:00.000Z", text: "Old report" },
    }
    const facts = foldTranscript(
      toolResult("2026-10-06T10:00:00.000Z"),
      [DISPATCHER],
      new Map(),
      prior,
    )
    expect(facts.lastActivityAt).toBe("2026-10-06T10:00:00.000Z")
    expect(facts.report?.text).toBe("Old report")
  })

  test("the dispatcher's own transcript reports to no one", () => {
    const text = assistant("2026-10-06T10:01:00.000Z", send(DISPATCHER, "talking to myself"))
    expect(foldTranscript(text, [], new Map(), NONE).report).toBeNull()
  })

  // #2429: a runner reports to Ops, its manager, so a runner's row reads its newest message to either
  test("a message to another recipient given, by its name or the address it wrote from, is a report, and the newest of them wins", () => {
    const OPS = "ops"
    const OPS_ADDRESS = "uds:/tmp/cc-socks/31337.sock"
    const fromOps = line({
      type: "user",
      uuid: "p-ops",
      timestamp: "2026-10-06T10:00:30.000Z",
      origin: { kind: "peer", name: OPS, from: OPS_ADDRESS, body: "Keep the stack up" },
      message: { role: "user", content: "Keep the stack up" },
    })
    const lines = [
      fromDispatcher("Go"),
      fromOps,
      assistant("2026-10-06T10:01:00.000Z", send(DISPATCHER, "To the dispatcher")),
      assistant("2026-10-06T10:02:00.000Z", send(OPS, "Rolled canary 795c4c6")),
    ]
    const addresses = new Map<string, Set<string>>()
    expect(foldTranscript(lines.join("\n"), [DISPATCHER, OPS], addresses, NONE).report).toEqual({
      at: "2026-10-06T10:02:00.000Z",
      text: "Rolled canary 795c4c6",
    })
    expect(addresses.get(OPS)?.has(OPS_ADDRESS)).toBe(true)
    const byAddress = [
      ...lines,
      assistant("2026-10-06T10:03:00.000Z", send(OPS_ADDRESS, "Stack restarted")),
    ]
    expect(
      foldTranscript(byAddress.join("\n"), [DISPATCHER, OPS], new Map(), NONE).report?.text,
    ).toBe("Stack restarted")
    // a session that reports to the dispatcher alone: its message to Ops, or to Ops' address, is no report
    const worker = foldTranscript(byAddress.join("\n"), [DISPATCHER], new Map(), NONE)
    expect(worker.report?.text).toBe("To the dispatcher")
  })

  test("a partial first line and junk are passed over", () => {
    const text = ['":"assistant","SendMessage"}', "not json", toolResult("2026-10-06T10:00:00Z")]
    expect(foldTranscript(text.join("\n"), [DISPATCHER], new Map(), NONE)).toEqual({
      ...NONE,
      lastActivityAt: "2026-10-06T10:00:00Z",
    })
  })
})

describe("scanTranscript", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-scan-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))

  test("reads only what was written since, and waits for a line to end", async () => {
    const path = join(dir, "s.jsonl")
    writeFileSync(
      path,
      `${fromDispatcher("Go")}\n${assistant("2026-10-06T10:01:00Z", bash("one"))}\n`,
    )
    expect((await scanTranscript(path, [DISPATCHER])).lastActivityAt).toBe("2026-10-06T10:01:00Z")
    const next = assistant("2026-10-06T10:02:00Z", send(DISPATCHER_ADDRESS, "Halfway"))
    appendFileSync(path, next.slice(0, 20))
    expect(await scanTranscript(path, [DISPATCHER])).toMatchObject({
      lastActivityAt: "2026-10-06T10:01:00Z",
      report: null,
    })
    appendFileSync(path, `${next.slice(20)}\n`)
    const facts = await scanTranscript(path, [DISPATCHER])
    expect(facts.report?.text).toBe("Halfway")
    expect(facts.lastActivityAt).toBe("2026-10-06T10:02:00Z")
  })

  test("a first read folds chunk by chunk, past a line longer than a chunk", async () => {
    const path = join(dir, "big.jsonl")
    const filler = (at: string, size: number) =>
      line({
        type: "user",
        uuid: `f-${at}`,
        timestamp: at,
        message: { content: [{ type: "tool_result", content: "x".repeat(size) }] },
      })
    writeFileSync(
      path,
      [
        fromDispatcher("Go"),
        assistant("2026-10-06T10:01:00Z", send(DISPATCHER_ADDRESS, "Early report")),
        filler("2026-10-06T10:02:00Z", CHUNK_BYTES + 1024),
        ...Array.from({ length: 40 }, (_, i) =>
          filler(`2026-10-06T10:03:${String(i).padStart(2, "0")}Z`, 64 * 1024),
        ),
        assistant("2026-10-06T10:05:00Z", bash("last step")),
        "",
      ].join("\n"),
    )
    const facts = await scanTranscript(path, [DISPATCHER])
    expect(facts.report?.text).toBe("Early report")
    expect(facts.lastActivityAt).toBe("2026-10-06T10:05:00Z")
  })

  test("a file that shrank is read afresh", async () => {
    const path = join(dir, "t.jsonl")
    writeFileSync(path, `${assistant("2026-10-06T10:01:00Z", bash("a long first description"))}\n`)
    await scanTranscript(path, [DISPATCHER])
    writeFileSync(path, `${assistant("2026-10-06T10:05:00Z", bash("b"))}\n`)
    expect((await scanTranscript(path, [DISPATCHER])).lastActivityAt).toBe("2026-10-06T10:05:00Z")
  })
})

describe("repoOf", () => {
  test("ssh and https remotes name owner/repo; others name nothing", () => {
    expect(repoOf("git@github.com:acme/factory.git")).toBe("acme/factory")
    expect(repoOf("https://github.com/acme-labs/acme-app.git")).toBe("acme-labs/acme-app")
    expect(repoOf("https://github.com/acme/factory")).toBe("acme/factory")
    expect(repoOf("https://gitlab.com/a/b.git")).toBeNull()
  })
})

const rosterAgent = (fields: Partial<RosterAgent> = {}): RosterAgent => ({
  name: "worker-lust",
  role: "worker",
  status: "working",
  task: "Dashboard: Agents app",
  ...fields,
})

describe("workOf", () => {
  const git = { branch: "feat/agents-app", repo: "acme/factory" }

  test("a checkout on its own branch is where the work is, whatever the roster says", () => {
    const roster = rosterAgent({ pr: "https://github.com/acme/factory/pull/32" })
    expect(workOf(roster, git)).toEqual({
      branch: "feat/agents-app",
      lookup: "acme/factory#feat/agents-app",
      repo: "acme/factory",
    })
  })

  test("on a default branch the roster's pr, then its branch, name the pull request", () => {
    const main = { branch: "main", repo: "acme/factory" }
    const pr = "https://github.com/acme/factory/pull/34"
    expect(workOf(rosterAgent({ branch: "feat/x", pr }), main).lookup).toBe(pr)
    expect(workOf(rosterAgent({ branch: "feat/x" }), main)).toEqual({
      branch: "feat/x",
      lookup: "acme/factory#feat/x",
      repo: "acme/factory",
    })
    expect(workOf(rosterAgent(), main)).toEqual({
      branch: "main",
      lookup: null,
      repo: "acme/factory",
    })
  })

  test("a checkout another session shares yields to the roster's pr or branch", () => {
    const pr = "https://github.com/acme/factory/pull/34"
    expect(workOf(rosterAgent({ pr }), git, true).lookup).toBe(pr)
    expect(workOf(rosterAgent({ branch: "fix/z", repo: "o/r" }), git, true)).toEqual({
      branch: "fix/z",
      lookup: "o/r#fix/z",
      repo: "o/r",
    })
    expect(workOf(rosterAgent(), git, true).lookup).toBe("acme/factory#feat/agents-app")
  })

  test("a down agent has only the roster: its repo and branch", () => {
    expect(workOf(rosterAgent({ branch: "fix/y", repo: "o/r" }), null)).toEqual({
      branch: "fix/y",
      lookup: "o/r#fix/y",
      repo: "o/r",
    })
    expect(workOf(rosterAgent({ branch: "fix/y" }), null).lookup).toBeNull()
  })
})

describe("pull requests", () => {
  const head = "0cf0142407f978ecd9716470d7bdc6137fabbe05"
  const node = (fields: Record<string, unknown> = {}) => ({
    comments: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    headRefOid: head,
    isDraft: true,
    number: 33,
    state: "OPEN",
    title: "Dashboard home",
    updatedAt: "2026-10-12T10:00:00Z",
    url: "https://github.com/acme/factory/pull/33",
    ...fields,
  })

  test("a PullRequest node reads as number, title, state, draft, CI, approvals, merge queue, review, tester and last update", () => {
    expect(pullOf(node())).toEqual({
      approvals: 0,
      ci: "passing",
      conflicts: false,
      draft: true,
      gates: null,
      head,
      number: 33,
      queued: false,
      reviewed: false,
      round: null,
      score: null,
      state: "open",
      tester: null,
      title: "Dashboard home",
      updatedAt: "2026-10-12T10:00:00Z",
      url: "https://github.com/acme/factory/pull/33",
      verdict: null,
    })
    expect(pullOf(node({ title: null, updatedAt: "not a time" }))).toMatchObject({
      title: "",
      updatedAt: null,
    })
    expect(
      pullOf(node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }))?.ci,
    ).toBe("none")
    expect(pullOf(node({ state: "MERGED" }))?.state).toBe("merged")
    // #2457: CONFLICTING or DIRTY conflicts with its base; UNKNOWN, GitHub still working it out, does not
    expect(pullOf(node({ mergeable: "CONFLICTING" }))?.conflicts).toBe(true)
    expect(pullOf(node({ mergeStateStatus: "DIRTY" }))?.conflicts).toBe(true)
    expect(pullOf(node({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))?.conflicts).toBe(
      false,
    )
    expect(pullOf(node({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }))?.conflicts).toBe(
      false,
    )
    expect(pullOf(null)).toBeNull()
    expect(pullOf({ number: 1 })).toBeNull()
  })

  test("approvals still needed: the base's rules' count less the reviewers whose latest word approves, at least one, only while a review is required", () => {
    const rules = (n: number) => ({
      rules: { nodes: [{ parameters: { requiredApprovingReviewCount: n } }, { parameters: null }] },
    })
    const approved = (n: number) => ({
      latestOpinionatedReviews: { nodes: Array.from({ length: n }, () => ({ state: "APPROVED" })) },
    })
    const needed = (fields: Record<string, unknown>) => pullOf(node(fields))?.approvals
    expect(needed({ baseRef: rules(3), ...approved(2), reviewDecision: "REVIEW_REQUIRED" })).toBe(1)
    expect(needed({ baseRef: rules(3), ...approved(0), reviewDecision: "REVIEW_REQUIRED" })).toBe(3)
    expect(
      needed({
        baseRef: { branchProtectionRule: { requiredApprovingReviewCount: 2 } },
        reviewDecision: "REVIEW_REQUIRED",
      }),
    ).toBe(2)
    expect(needed({ reviewDecision: "REVIEW_REQUIRED" })).toBe(1)
    expect(needed({ baseRef: rules(2), ...approved(2), reviewDecision: "CHANGES_REQUESTED" })).toBe(
      1,
    )
    expect(needed({ baseRef: rules(3), reviewDecision: "APPROVED" })).toBe(0)
    expect(needed({ baseRef: rules(3) })).toBe(0)
    expect(needed({ baseRef: rules(3), reviewDecision: "REVIEW_REQUIRED", state: "MERGED" })).toBe(
      0,
    )
  })

  test("queued: in a merge queue or set to merge itself", () => {
    expect(pullOf(node({ mergeQueueEntry: { state: "QUEUED" } }))?.queued).toBe(true)
    expect(pullOf(node({ autoMergeRequest: { enabledAt: "2026-10-08T10:00:00Z" } }))?.queued).toBe(
      true,
    )
    expect(pullOf(node({ autoMergeRequest: null, mergeQueueEntry: null }))?.queued).toBe(false)
  })

  test("the newest ReviewBot round at any head, and the newest Tester verdict at the head alone", () => {
    const comments = (...bodies: string[]) => ({
      comments: { nodes: bodies.map((body) => ({ body })) },
    })
    const read = (...bodies: string[]) => pullOf(node(comments(...bodies)))
    expect(
      read("## ReviewBot · round 1: 3/5 at 1111111", "## ReviewBot · round 2: 4/5 at 2222222")
        ?.round,
    ).toBe(2)
    expect(read(drove("green", head))?.tester).toBe("pass")
    expect(read(drove("red", head))?.tester).toBe("fail")
    // a review is no tester's word
    expect(read(`## ReviewBot · round 1: 5/5 at ${head.slice(0, 7)}`)?.tester).toBeNull()
    // a stale verdict at an earlier head does not count, so it cannot hide an at-head PASS (the gate's rule)
    expect(read(drove("green", head), drove("red", "1234567"))?.tester).toBe("pass")
    expect(read("a plain comment that says PASS at abcdef1")?.tester).toBeNull()
    // the newest verdict's score, whatever head it scored
    expect(
      read("## ReviewBot · round 1: 3/5 at 1111111", "## ReviewBot · round 3: 5/5 at 2222222")
        ?.verdict,
    ).toBe("5/5")
    expect(read("a plain comment")?.verdict).toBeNull()
  })

  test("a verdict counts only from the owner's comments, and the newest by time wins", () => {
    const said = (login: string, createdAt: string, body: string) => ({
      author: { login },
      body,
      createdAt,
    })
    const review = (login: string, at: string, body: string) =>
      pullOf(node({ comments: { nodes: [said(login, at, body)] } }), "acme")
    expect(
      review("someone-else", "2026-10-12T09:00:00Z", "## ReviewBot · round 2: 5/5 at 0cf0142")
        ?.score,
    ).toBeNull()
    expect(
      review("someone-else", "2026-10-12T09:00:00Z", "## ReviewBot · round 2: 5/5 at 0cf0142")
        ?.reviewed,
    ).toBe(false)
    expect(
      review("acme", "2026-10-12T09:00:00Z", "## ReviewBot · round 2: 5/5 at 0cf0142")?.score,
    ).toBe("5/5")
    // GitHub lists comments newest first; the newest by time wins, never the last in the list
    const newestFirst = pullOf(
      node({
        comments: {
          nodes: [
            said("acme", "2026-10-12T10:00:00Z", "## ReviewBot · round 3: 3/5 at 2222222"),
            said("acme", "2026-10-12T09:00:00Z", "## ReviewBot · round 2: 5/5 at 0cf0142"),
          ],
        },
      }),
      "acme",
    )
    expect(newestFirst?.verdict).toBe("3/5")
    expect(newestFirst?.round).toBe(3)
    // the score is the newest verdict at the PR's head, and only the 5/5 scored it
    expect(newestFirst?.score).toBe("5/5")
  })

  test("the dashboard and pr:merge read one thread the same way", () => {
    // distinct shas, each a prefix of the head
    const at = (n: number) => head.slice(0, 7 + n)
    const comment = (login: string, minute: number, body: string) => ({
      author: login,
      body,
      createdAt: `2026-10-12T09:${String(minute).padStart(2, "0")}:00Z`,
    })
    const build = (comments: { author: string; body: string; createdAt: string }[]) => ({
      gates: comments,
      // the same thread as the GraphQL query returns it: the author as its { login }
      pull: pullOf(
        node({ comments: { nodes: comments.map((c) => ({ ...c, author: { login: c.author } })) } }),
        "acme",
      ),
    })
    const agree = (comments: ReturnType<typeof comment>[], head: string) => {
      const { pull } = build(comments)
      const board = verdictsAt({ comments, head, owner: "acme" })
      const review = board.get("review")
      const drive = board.get("tester")
      return {
        ready: pull?.score,
        gate: review?.pass ? `${review.score}/5` : null,
        reviewed: pull?.reviewed,
        tested: pull?.tester,
        passed: drive?.pass ? "pass" : drive ? "fail" : null,
      }
    }
    // a 5/5 at the head reads Ready on both sides
    expect(agree([comment("acme", 1, `## ReviewBot · round 2: 5/5 at ${at(1)}`)], head)).toEqual({
      ready: "5/5",
      gate: "5/5",
      reviewed: true,
      tested: null,
      passed: null,
    })
    // a pushed head no review has scored yet keeps the PR reviewed but unscored, on both sides
    expect(
      agree(
        [
          comment("acme", 1, "## ReviewBot · round 2: 5/5 at 1111111"),
          comment("acme", 3, drove("green", "1111111")),
          comment("acme", 5, "## ReviewBot · round 3: 3/5 at 2222222"),
        ],
        head,
      ),
    ).toEqual({ ready: null, gate: null, reviewed: true, tested: null, passed: null })
    // a tester PASS at the head reads the same on both sides
    expect(
      agree(
        [
          comment("acme", 1, `## ReviewBot · round 2: 5/5 at ${at(1)}`),
          comment("acme", 4, drove("green", at(1))),
        ],
        head,
      ),
    ).toEqual({ ready: "5/5", gate: "5/5", reviewed: true, tested: "pass", passed: "pass" })
    // someone else's marker is nobody's verdict, on both sides
    expect(
      agree([comment("someone-else", 1, `## ReviewBot · round 2: 5/5 at ${at(1)}`)], head),
    ).toEqual({ ready: null, gate: null, reviewed: false, tested: null, passed: null })
  })

  test("a GraphQL answer is its PR, null when the repository has none, and throws when it names no repository", () => {
    const answer = (repository: unknown) => JSON.stringify({ data: { repository } })
    expect(pullFromAnswer(answer({ pullRequest: node() }))?.number).toBe(33)
    expect(pullFromAnswer(answer({ pullRequests: { nodes: [node({ number: 7 })] } }))?.number).toBe(
      7,
    )
    expect(pullFromAnswer(answer({ pullRequests: { nodes: [] } }))).toBeNull()
    expect(() =>
      pullFromAnswer(JSON.stringify({ errors: [{ message: "rate limited" }] })),
    ).toThrow()
    expect(() => pullFromAnswer("not json")).toThrow()
  })

  // The gates are posted by the account gh reads as, which on an org-owned repo is not its owner: the answer's viewer decides whose markers count.
  test("on an org-owned repo, the viewer's verdict counts and anyone else's does not", () => {
    const said = (login: string) => ({
      author: { login },
      body: "## ReviewBot · round 2: 5/5 at 0cf0142",
      createdAt: "2026-10-12T09:00:00Z",
    })
    const answer = (login: string) =>
      JSON.stringify({
        data: {
          repository: {
            pullRequest: node({
              comments: { nodes: [said(login)] },
              url: "https://github.com/acme-labs/acme/pull/33",
            }),
          },
          viewer: { login: "acme" },
        },
      })
    expect(pullFromAnswer(answer("acme"))?.score).toBe("5/5")
    expect(pullFromAnswer(answer("someone-else"))?.score).toBeNull()
    expect(pullFromAnswer(answer("acme-labs"))?.score).toBeNull()
  })

  test("a pull request is read again every five minutes", () => {
    expect(PR_TTL_MS).toBe(300_000)
  })

  test("a gh -i answer splits into its body, and names GitHub's reset time once the budget is spent", () => {
    const headers = (remaining: string) =>
      `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: 1791492171\r\n\r\n`
    expect(ghAnswer(`${headers("4863")}{"data":{}}`)).toEqual({
      body: '{"data":{}}',
      retryAt: null,
    })
    expect(ghAnswer(`${headers("0")}{"errors":[]}`)).toEqual({
      body: '{"errors":[]}',
      retryAt: 1791492171000,
    })
    expect(ghAnswer("")).toEqual({ body: "", retryAt: null })
  })

  test("a merged pull request named by its URL is read once; an open or closed one, or one found by branch, every time", async () => {
    const reads: string[] = []
    const pull = (state: Pull["state"]) => ({ ...pullOf(node())!, state })
    const read = mergedOnce(async (lookup) => {
      reads.push(lookup)
      return pull(
        lookup.endsWith("/1")
          ? "open"
          : lookup.endsWith("/2")
            ? "merged"
            : lookup.endsWith("/3")
              ? "closed"
              : "closed",
      )
    })
    const merged = "https://github.com/acme/factory/pull/2"
    const open = "https://github.com/acme/factory/pull/1"
    const closed = "https://github.com/acme/factory/pull/3"
    const branch = "acme/factory#feat/x"
    for (let i = 0; i < 2; i++)
      for (const lookup of [merged, open, closed, branch]) await read(lookup)
    expect(reads).toEqual([merged, open, closed, branch, open, closed, branch])
    expect((await read(merged))?.state).toBe("merged")
  })

  test("merged and closed facts outlive the process in a capped file, and an open one is never kept", async () => {
    const folder = mkdtempSync(join(tmpdir(), "merged-pulls-"))
    const file = join(folder, OLD.dispatcher, "merged-pulls.json")
    const url = (n: number) => `https://github.com/acme/factory/pull/${n}`
    const reads: string[] = []
    let n = 0
    const merged = (number: number) => ({ ...pullOf(node())!, number, state: "merged" }) as Pull
    const read = mergedOnce((lookup) => {
      reads.push(lookup)
      n += 1
      return Promise.resolve(lookup.endsWith("/1") ? { ...merged(n), state: "open" } : merged(n))
    }, file)
    await read(url(1))
    expect(await readMergedPulls(file)).toEqual([])
    const first = await read(url(2))
    expect(reads).toEqual([url(1), url(2)])
    // A fresh cache, as the next process starts: the facts load, and GitHub is asked nothing.
    const second = mergedOnce((lookup) => {
      reads.push(lookup)
      return Promise.resolve(null)
    }, file)
    expect(await second(url(2))).toEqual(first)
    expect(reads).toEqual([url(1), url(2)])
    for (let i = 0; i < MERGED_PULLS_CAP + 5; i++) await read(url(3 + i))
    const kept = await readMergedPulls(file)
    expect(kept).toHaveLength(MERGED_PULLS_CAP)
    // url(2) merged plus the loop's 205: 206 facts, the 6 oldest dropped.
    expect(kept[0]?.[0]).toBe(url(8))
    expect(kept.at(-1)?.[0]).toBe(url(MERGED_PULLS_CAP + 7))
  })

  test("the file keeps a merged pull request alone; a closed one, which can be reopened, is dropped", async () => {
    const folder = mkdtempSync(join(tmpdir(), "merged-pulls-"))
    const file = join(folder, "merged-pulls.json")
    const merged = {
      pull: { ...pullOf(node())!, state: "merged" },
      url: "https://github.com/acme/factory/pull/2",
    }
    const closed = {
      ...merged,
      pull: { ...merged.pull, state: "closed" },
      url: "https://github.com/acme/factory/pull/3",
    }
    writeFileSync(file, JSON.stringify({ pulls: [merged, closed] }))
    expect((await readMergedPulls(file)).map(([url]) => url)).toEqual([
      "https://github.com/acme/factory/pull/2",
    ])
  })

  test("one fault in the file drops that entry and keeps the rest", async () => {
    const folder = mkdtempSync(join(tmpdir(), "merged-pulls-"))
    const file = join(folder, "merged-pulls.json")
    const good = {
      pull: { ...pullOf(node())!, state: "merged" },
      url: "https://github.com/acme/factory/pull/2",
    }
    writeFileSync(
      file,
      JSON.stringify({
        pulls: [
          good,
          {
            pull: { ...good.pull, state: "open" },
            url: "https://github.com/acme/factory/pull/3",
          },
          { pull: good.pull },
        ],
      }),
    )
    const entries = await readMergedPulls(file)
    expect(entries.map(([url]) => url)).toEqual(["https://github.com/acme/factory/pull/2"])
  })

  test("an entry missing a field is dropped, so an older build's shape is read again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "merged-pulls-"))
    const file = join(folder, "merged-pulls.json")
    const whole = { ...pullOf(node())!, state: "merged" } as Record<string, unknown>
    const short = { ...whole }
    delete short.round
    const noVerdict = { ...whole }
    delete noVerdict.verdict
    writeFileSync(
      file,
      JSON.stringify({
        pulls: [
          { pull: short, url: "https://github.com/acme/factory/pull/2" },
          { pull: noVerdict, url: "https://github.com/acme/factory/pull/3" },
          { pull: whole, url: "https://github.com/acme/factory/pull/4" },
        ],
      }),
    )
    expect((await readMergedPulls(file)).map(([url]) => url)).toEqual([
      "https://github.com/acme/factory/pull/4",
    ])
  })

  test("a file that does not read costs the cache nothing", async () => {
    const folder = mkdtempSync(join(tmpdir(), "merged-pulls-"))
    const file = join(folder, "merged-pulls.json")
    writeFileSync(file, "not json")
    const url = "https://github.com/acme/factory/pull/2"
    const read = mergedOnce(
      () => Promise.resolve({ ...pullOf(node())!, state: "merged" } as Pull),
      file,
    )
    expect((await read(url))?.state).toBe("merged")
  })

  test("the file sits beside the roster in the data folder, or where the override names", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-config-"))
    const before = process.env.CLAUDE_CONFIG_DIR
    const beforeOverride = process.env.PLAYGROUND_MERGED_PULLS
    try {
      process.env.CLAUDE_CONFIG_DIR = home
      process.env.PLAYGROUND_DATA_DIR = join(home, "playground")
      delete process.env.PLAYGROUND_MERGED_PULLS
      expect(mergedPullsPath()).toBe(join(home, "playground", "merged-pulls.json"))
      process.env.PLAYGROUND_MERGED_PULLS = join(home, "elsewhere.json")
      expect(mergedPullsPath()).toBe(join(home, "elsewhere.json"))
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
      delete process.env.PLAYGROUND_DATA_DIR
      if (beforeOverride === undefined) delete process.env.PLAYGROUND_MERGED_PULLS
      else process.env.PLAYGROUND_MERGED_PULLS = beforeOverride
    }
  })

  test("CI reads failing, pending, passing or none", () => {
    expect(ciOf("FAILURE")).toBe("failing")
    expect(ciOf("ERROR")).toBe("failing")
    expect(ciOf("PENDING")).toBe("pending")
    expect(ciOf("EXPECTED")).toBe("pending")
    expect(ciOf("SUCCESS")).toBe("passing")
    expect(ciOf("")).toBe("none")
  })

  test("a PR stays reviewed after a push, though its score counts only at the head", () => {
    const verdict = { body: "## ReviewBot · round 1: 3/5 at deadbee · 1 blocking" }
    const pushed = pullOf(node({ comments: { nodes: [verdict] } }))
    expect(pushed?.reviewed).toBe(true)
    expect(pushed?.score).toBeNull()
    const other = { body: "Score 5/5 at 0cf0142, said someone else" }
    expect(pullOf(node({ comments: { nodes: [other] } }))?.reviewed).toBe(false)
    expect(
      pullOf(node({ comments: { nodes: [{ body: "## ReviewBot · notes" }] } }))?.reviewed,
    ).toBe(false)
  })

  test("the newest ReviewBot score counts only at the PR's head", () => {
    const at = (sha: string, score: string, round = 1) =>
      `## ReviewBot · round ${round}: ${score} at ${sha}`
    expect(scoreOf([at("0cf0142", "4/5"), at("0cf0142", "5/5", 2)], head)).toBe("5/5")
    // a verdict at another head never hides the newest one at the PR's head (the gate's rule)
    expect(scoreOf([at("0cf0142", "5/5"), at("deadbee", "3/5")], head)).toBe("5/5")
    expect(scoreOf(["Score 5/5 at 0cf0142, said someone else"], head)).toBeNull()
    // the dashboard reads the gate's marker alone: a score off the first line is nobody's verdict
    expect(scoreOf(["## ReviewBot\n\n4/5 → 0cf0142407"], head)).toBeNull()
    expect(scoreOf([at("0cf0142407", "4/5", 3)], head)).toBe("4/5")
  })

  test("a lookup is a PR URL or owner/name#branch, as gh api graphql arguments", () => {
    const byUrl = pullQuery("https://github.com/acme/2048/pull/33") ?? []
    expect(byUrl[byUrl.indexOf("number=33") - 1]).toBe("-F")
    expect(byUrl[byUrl.indexOf("owner=acme") - 1]).toBe("-f")
    expect(byUrl[byUrl.indexOf("name=2048") - 1]).toBe("-f")
    const byBranch = pullQuery("acme/factory#feat/agents-app")
    expect(byBranch).toContain("branch=feat/agents-app")
    expect(byBranch).toContain("name=factory")
    expect(pullQuery("not a lookup")).toBeNull()
  })
})

const worker = (name: string, fields: Partial<Worker> = {}): Worker => ({
  cwd: "/repo",
  effort: null,
  eta: null,
  failed: false,
  feed: [],
  lastActiveAt: null,
  lifecycle: "running",
  light: "working",
  model: null,
  name,
  questions: [],
  role: name === DISPATCHER ? "dispatcher" : name.startsWith("runner-") ? "runner" : "worker",
  sessionId: `s-${name}`,
  startedAt: null,
  task: `first ask of ${name}`,
  tasks: [],
  title: null,
  updatedAt: "2026-10-06T10:00:00.000Z",
  workspace: null,
  ...fields,
})

describe("matchAgents", () => {
  test("two live sessions sharing the dispatcher's name pair the roster with the first, the one the read leads with", () => {
    const roster = [rosterAgent({ name: DISPATCHER, role: "manager" })]
    const demoted = worker(DISPATCHER, { role: "other", sessionId: "s-demoted" })
    const keeper = worker(DISPATCHER, { sessionId: "s-keeper" })
    // the read's re-sort leads with the keeper (workers.ts), so the first is the one to pair
    const pairs = matchAgents(roster, [keeper, demoted]).map((m) => [
      m.roster?.name,
      m.live?.sessionId,
    ])
    expect(pairs[0]).toEqual([DISPATCHER, "s-keeper"])
  })

  test("by name, by bare sin, by a workspace holding one session, and unlisted sessions too", () => {
    const roster = [
      rosterAgent({ name: DISPATCHER, role: "manager" }),
      rosterAgent({ name: "worker-greed" }),
      rosterAgent({ name: "worker-envy", workspace: "workspace:51" }),
      rosterAgent({ name: "worker-sloth", workspace: "workspace:60" }),
    ]
    const workers = [
      worker(DISPATCHER),
      worker("greed"),
      worker("session 1b9436d3", { workspace: { ref: "workspace:51", title: null } }),
      worker("probe-a", { workspace: { ref: "workspace:60", title: null } }),
      worker("probe-b", { workspace: { ref: "workspace:60", title: null } }),
    ]
    const pairs = matchAgents(roster, workers).map((m) => [m.roster?.name, m.live?.name])
    expect(pairs).toEqual([
      [DISPATCHER, DISPATCHER],
      ["worker-greed", "greed"],
      ["worker-envy", "session 1b9436d3"],
      ["worker-sloth", undefined],
      [undefined, "probe-a"],
      [undefined, "probe-b"],
    ])
  })

  test("one surface ref held by two entries pairs the session once, with the entry its name holds", () => {
    const roster = [
      rosterAgent({ name: "reviewer-composer", surface: "surface:286", worker: "worker-composer" }),
      rosterAgent({ name: "reviewer-522", surface: "surface:286" }),
    ]
    const workers = [worker("reviewer-522", { surface: "surface:286" })]
    const pairs = matchAgents(roster, workers).map((m) => [m.roster?.name, m.live?.name])
    expect(pairs).toEqual([
      ["reviewer-composer", undefined],
      ["reviewer-522", "reviewer-522"],
    ])
  })

  test("an ended entry pairs by name alone, never by surface", () => {
    const roster = [
      rosterAgent({ name: "reviewer-composer", status: "ended", surface: "surface:286" }),
    ]
    const workers = [worker("session 1a2b3c4d", { surface: "surface:286" })]
    expect(matchAgents(roster, workers).map((m) => [m.roster?.name, m.live?.name])).toEqual([
      ["reviewer-composer", undefined],
      [undefined, "session 1a2b3c4d"],
    ])
  })

  test("a roster surface pairs ahead of the name when no other entry holds the session's name; a stale surface pairs by name alone, never the workspace", () => {
    const workers = [
      worker("envy", { surface: "surface:2" }),
      worker("greed", { surface: "surface:1", workspace: { ref: "workspace:51", title: null } }),
    ]
    // worker-envy holds envy's name, so worker-greed's surface on envy's pane loses to that name.
    const both = [
      rosterAgent({ name: "worker-greed", surface: "surface:2" }),
      rosterAgent({ name: "worker-envy", surface: "surface:9", workspace: "workspace:51" }),
    ]
    expect(matchAgents(both, workers).map((m) => [m.roster?.name, m.live?.name])).toEqual([
      ["worker-greed", "greed"],
      ["worker-envy", "envy"],
    ])
    // No other entry holds envy's name, so the surface wins over it.
    expect(matchAgents([both[0]], workers).map((m) => [m.roster?.name, m.live?.name])).toEqual([
      ["worker-greed", "envy"],
    ])
    // A stale surface pairs by name alone, never the workspace's remaining session.
    expect(
      matchAgents(
        [rosterAgent({ name: "worker-sloth", surface: "surface:9", workspace: "workspace:51" })],
        workers,
      ).map((m) => [m.roster?.name, m.live?.name]),
    ).toEqual([
      ["worker-sloth", undefined],
      [undefined, "envy"],
      [undefined, "greed"],
    ])
  })
})

describe("agentOf", () => {
  const work = { branch: null, lookup: null, repo: null }
  const NOW = new Date("2026-10-06T12:00:00.000Z")

  test("the roster's word wins for who and why; the session's for state", () => {
    const agent = agentOf(
      {
        live: worker("worker-lust", { light: "needs-you" }),
        roster: rosterAgent({ title: "Agents app" }),
      },
      null,
      work,
      null,
      NOW,
    )
    expect(agent).toMatchObject({
      name: "worker-lust",
      role: "worker",
      sessionId: "s-worker-lust",
      state: "needs-you",
      status: "working",
      task: "Dashboard: Agents app",
      title: "Agents app",
    })
    expect(agent.lastActivityAt).toBe("2026-10-06T10:00:00.000Z")
  })

  // the sidebar placed a session by roleOf and the System table by the roster's role alone, so one name sat in two groups
  test("the table places an agent with conflicting signals where the sidebar does, by roleOf", () => {
    const cases: [string, RosterAgent["role"]][] = [
      [OLD.builder, "worker"],
      [OLD.builder, "runner"],
      ["runner-pride", "worker"],
      ["worker-envy", "runner"],
      ["probe-path", "manager"],
    ]
    for (const [name, role] of cases) {
      const live = worker(name, { role: roleOf(name, { role }) })
      const agent = agentOf({ live, roster: rosterAgent({ name, role }) }, null, work, null, NOW)
      expect<string>(agent.role, name).toBe(live.role)
      // down, with no session to place it, the table reads the same rule the sidebar would
      const down = agentOf(
        { live: null, roster: rosterAgent({ name, role }) },
        null,
        work,
        null,
        NOW,
      )
      expect<string>(down.role, `${name} down`).toBe(live.role)
    }
    // paired by workspace, the roster's name differs from the session's, and the sidebar placed the session by its own name
    const paired = worker("notes-fix", { role: "other" })
    const agent = agentOf({ live: paired, roster: rosterAgent() }, null, work, null, NOW)
    expect(agent.role).toBe("other")
  })

  test("a session outside the factory's names that the roster lacks is other", () => {
    const stray = worker("session e73f9d9c", { role: "other" })
    expect(agentOf({ live: stray, roster: null }, null, work, null, NOW).role).toBe("other")
  })

  test("the ETA is the roster's, and none when the roster has none", () => {
    const eta = "2026-10-06T12:20:00Z"
    expect(
      agentOf({ live: worker("worker-lust"), roster: rosterAgent({ eta }) }, null, work, null, NOW)
        .eta,
    ).toBe(eta)
    expect(agentOf({ live: null, roster: rosterAgent() }, null, work, null, NOW).eta).toBeNull()
    expect(
      agentOf({ live: worker("worker-lust"), roster: null }, null, work, null, NOW).eta,
    ).toBeNull()
  })

  test("a roster agent with no session is down; a session the roster lacks keeps its first ask", () => {
    expect(agentOf({ live: null, roster: rosterAgent() }, null, work, null, NOW).state).toBe("down")
    const unlisted = agentOf({ live: worker(DISPATCHER), roster: null }, null, work, null, NOW)
    expect(unlisted).toMatchObject({
      role: "manager",
      status: null,
      task: `first ask of ${DISPATCHER}`,
    })
  })

  test("the later of the transcript's report and the roster's stands, by instant not by text", () => {
    const facts = {
      ...NONE,
      report: { at: "2026-10-06T10:00:00.000Z", text: "from the transcript" },
    }
    const earlier = rosterAgent({
      lastReport: `from ${OLD.dispatcher}`,
      lastReportAt: "2026-10-06T15:00:00+05:30",
    })
    const later = rosterAgent({
      lastReport: `from ${OLD.dispatcher}`,
      lastReportAt: "2026-10-06T16:00:00+05:30",
    })
    expect(agentOf({ live: null, roster: earlier }, facts, work, null, NOW).report?.text).toBe(
      "from the transcript",
    )
    expect(agentOf({ live: null, roster: later }, facts, work, null, NOW).report?.text).toBe(
      `from ${OLD.dispatcher}`,
    )
    expect(
      agentOf(
        { live: null, roster: rosterAgent({ lastReport: "undated" }) },
        facts,
        work,
        null,
        NOW,
      ).report?.text,
    ).toBe("from the transcript")
  })

  test("a roster time from a wrong clock, hours ahead, counts as no time", () => {
    const facts = {
      ...NONE,
      report: { at: "2026-10-06T10:00:00.000Z", text: "from the transcript" },
    }
    const ahead = rosterAgent({
      lastReport: `from ${OLD.dispatcher}`,
      lastReportAt: "2026-10-07T03:44:00Z",
    })
    expect(agentOf({ live: null, roster: ahead }, facts, work, null, NOW).report?.text).toBe(
      "from the transcript",
    )
    expect(agentOf({ live: null, roster: ahead }, null, work, null, NOW).report).toEqual({
      at: null,
      text: `from ${OLD.dispatcher}`,
    })
  })
})

describe("cachedBy", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0))

  test("loads once, serves the stale answer past its ttl while a fresh one loads, then the fresh one", async () => {
    let now = 0
    let calls = 0
    const answers = ["first", "second"]
    const get = cachedBy(
      100,
      async () => answers[calls++] ?? "",
      () => now,
    )
    expect(await get("k")).toBe("first")
    now = 50
    expect(await get("k")).toBe("first")
    expect(calls).toBe(1)
    now = 150
    expect(await get("k")).toBe("first")
    await settle()
    expect(calls).toBe(2)
    expect(await get("k")).toBe("second")
  })

  test("a refresh that fails keeps the answer it would have replaced, and is not tried again for one ttl", async () => {
    let now = 0
    let calls = 0
    let fail = false
    const get = cachedBy(
      100,
      async () => {
        calls++
        if (fail) throw new Error("rate limited")
        return "good"
      },
      () => now,
    )
    expect(await get("k")).toBe("good")
    fail = true
    now = 150
    expect(await get("k")).toBe("good")
    await settle()
    expect(calls).toBe(2)
    now = 249
    expect(await get("k")).toBe("good")
    await settle()
    expect(calls).toBe(2)
    fail = false
    now = 250
    expect(await get("k")).toBe("good")
    await settle()
    expect(calls).toBe(3)
  })

  test("a first load that fails is served as that failure for one ttl, then loaded again", async () => {
    let now = 0
    let calls = 0
    const get = cachedBy(
      100,
      async () => {
        calls++
        if (calls === 1) throw new Error("rate limited")
        return "good"
      },
      () => now,
    )
    await expect(get("k")).rejects.toThrow("rate limited")
    await settle()
    now = 99
    await expect(get("k")).rejects.toThrow("rate limited")
    expect(calls).toBe(1)
    now = 100
    expect(await get("k")).toBe("good")
    expect(calls).toBe(2)
  })

  test("a failure that names when to retry holds the next load until then, past the ttl", async () => {
    let now = 0
    let calls = 0
    const get = cachedBy(
      100,
      async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error("rate limited"), { retryAt: 5000 })
        return "good"
      },
      () => now,
    )
    await expect(get("k")).rejects.toThrow("rate limited")
    await settle()
    for (now = 100; now < 5000; now += 100) await expect(get("k")).rejects.toThrow("rate limited")
    expect(calls).toBe(1)
    now = 5000
    expect(await get("k")).toBe("good")
    expect(calls).toBe(2)
  })

  test("a good answer asked for all through a backoff longer than ten ttls is served to its end", async () => {
    let now = 0
    let calls = 0
    const get = cachedBy(
      300,
      async () => {
        calls++
        if (calls === 1) return "good"
        throw Object.assign(new Error("rate limited"), { retryAt: 3600 })
      },
      () => now,
    )
    expect(await get("k")).toBe("good")
    now = 300
    expect(await get("k")).toBe("good")
    await settle()
    for (now = 400; now <= 3600; now += 100) expect(await get("k")).toBe("good")
    expect(calls).toBe(3)
  })

  test("a refresh in flight is not dropped by the ten-ttl rule, so it is not loaded twice", async () => {
    let now = 0
    let calls = 0
    let release: (value: string) => void = () => {}
    const get = cachedBy(
      100,
      (key) => {
        if (key === "other") return Promise.resolve("x")
        calls++
        if (calls === 1) return Promise.resolve("good")
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
      () => now,
    )
    expect(await get("k")).toBe("good")
    now = 995
    expect(await get("k")).toBe("good")
    now = 1001
    await get("other")
    const again = get("k")
    release("fresh")
    await again
    expect(calls).toBe(2)
  })

  test("a refresh that never settles is tried again once ten ttls pass, for a key asked throughout", async () => {
    let now = 0
    let calls = 0
    const get = cachedBy(
      100,
      () => {
        calls++
        if (calls === 1) return Promise.resolve("good")
        return new Promise<string>(() => {})
      },
      () => now,
    )
    expect(await get("k")).toBe("good")
    for (now = 100; now <= 5000; now += 100) expect(await get("k")).toBe("good")
    expect(calls).toBe(6)
  })

  test("callers asking at once share one load", async () => {
    let calls = 0
    let release: (value: string) => void = () => {}
    const get = cachedBy(100, () => {
      calls++
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const asks = [get("k"), get("k"), get("k")]
    release("good")
    expect(await Promise.all(asks)).toEqual(["good", "good", "good"])
    expect(calls).toBe(1)
  })

  test("a key nobody asks for in ten ttls is dropped and loaded afresh", async () => {
    let now = 0
    let calls = 0
    const get = cachedBy(
      100,
      async (key) => `${key}${++calls}`,
      () => now,
    )
    expect(await get("a")).toBe("a1")
    now = 1001
    expect(await get("b")).toBe("b2")
    expect(await get("a")).toBe("a3")
  })
})

describe("agentsBoard", () => {
  const home = mkdtempSync(join(tmpdir(), "agents-board-"))
  const before = process.env.CLAUDE_CONFIG_DIR
  afterAll(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
    delete process.env.PLAYGROUND_DATA_DIR
    rmSync(home, { force: true, recursive: true })
  })

  test("joins the roster in the data folder to the live list it is given", async () => {
    process.env.CLAUDE_CONFIG_DIR = home
    process.env.PLAYGROUND_DATA_DIR = join(home, "playground")
    mkdirSync(join(home, "playground"))
    writeFileSync(
      join(home, "playground", "roster.json"),
      JSON.stringify({
        agents: [
          { name: DISPATCHER, role: "manager", status: "active", task: "Dispatch" },
          { name: "worker-sloth", role: "worker", status: "working", task: "Gone quiet" },
          { name: "worker-lust", role: "worker", status: "working", task: "Agents app" },
          {
            backlogNext: "1",
            backlogTaken: "2",
            name: OLD.builder,
            role: "manager",
            status: "working",
            task: "Lead",
          },
        ],
        backlog: [
          "Settled",
          "Next: a tester runner",
          "Taken out of turn",
          `${org.owner.name}: an ETA`,
        ],
        updatedAt: "2026-10-06T10:00:00Z",
      }),
    )
    mkdirSync(join(home, "sessions"))
    writeFileSync(
      join(home, "sessions", "777.json"),
      JSON.stringify({ messagingSocketPath: "/tmp/cc-socks/777.sock", name: DISPATCHER }),
    )
    // The reply goes to OLD.dispatcher's socket with no earlier message from it in the transcript: only the registry says whose socket it is.
    const transcript = join(home, "lust.jsonl")
    writeFileSync(
      transcript,
      `${assistant("2026-10-06T10:01:00Z", send("uds:/tmp/cc-socks/777.sock", "Plan sent"))}\n`,
    )
    const live: Live = {
      surfaces: new Map(),
      transcripts: new Map([["s-worker-lust", transcript]]),
      workers: [worker(DISPATCHER, { cwd: home }), worker("worker-lust", { cwd: home })],
    }
    const board = await agentsBoard(async () => live)
    expect(board.liveProblem).toBeNull()
    expect(board.sockets).toEqual({ "uds:/tmp/cc-socks/777.sock": DISPATCHER })
    expect(board.roster).toEqual({
      backlog: [`${org.owner.name}: an ETA`, "Next: a tester runner"],
      path: join(home, "playground", "roster.json"),
      problem: null,
      updatedAt: "2026-10-06T10:00:00Z",
    })
    expect(board.agents.map((a) => [a.name, a.state, a.report?.text ?? null])).toEqual([
      [DISPATCHER, "working", null],
      ["worker-sloth", "down", null],
      ["worker-lust", "working", "Plan sent"],
      [OLD.builder, "down", null],
    ])
    expect(board.agents[2]).toMatchObject({ branch: null, pr: null, task: "Agents app" })
  })

  test("a pull request read that fails names why on its own agent, rather than reading as no pull request (#603)", async () => {
    const roster = JSON.stringify({
      agents: [
        {
          name: "worker-envy",
          pr: "https://github.com/o/r/pull/1",
          role: "worker",
          status: "working",
          task: "Boards",
        },
        {
          name: "worker-lust",
          pr: "https://github.com/o/r/pull/2",
          role: "worker",
          status: "working",
          task: "Agents app",
        },
      ],
      updatedAt: "2026-10-06T10:00:00Z",
    })
    const home2 = mkdtempSync(join(tmpdir(), "agents-board-gh-"))
    process.env.CLAUDE_CONFIG_DIR = home2
    process.env.PLAYGROUND_DATA_DIR = join(home2, "playground")
    mkdirSync(join(home2, "playground"))
    writeFileSync(join(home2, "playground", "roster.json"), roster)
    const live: Live = { surfaces: new Map(), transcripts: new Map(), workers: [] }
    const board = await agentsBoard(async () => live, {
      readPull: async (lookup) => {
        if (lookup.endsWith("/2")) throw new Error("gh api graphql exited 4")
        return null
      },
    })
    expect(board.agents.map((a) => [a.name, a.pr, a.pullProblem])).toEqual([
      ["worker-envy", null, null],
      ["worker-lust", null, { reason: "gh api graphql exited 4", setup: false }],
    ])
    const read = await agentsBoard(async () => live, { readPull: async () => null })
    expect(read.agents.map((a) => a.pullProblem)).toEqual([null, null])
    process.env.CLAUDE_CONFIG_DIR = home
    process.env.PLAYGROUND_DATA_DIR = join(home, "playground")
    rmSync(home2, { force: true, recursive: true })
  })

  test("when the sessions cannot be read, the roster still shows, every agent down, with the reason", async () => {
    const board = await agentsBoard(async () => {
      throw new Error("the sessions read did not answer in time")
    })
    expect(board.liveProblem).toBe("the sessions read did not answer in time")
    expect(board.agents.map((a) => [a.name, a.state])).toEqual([
      [DISPATCHER, "down"],
      ["worker-sloth", "down"],
      ["worker-lust", "down"],
      [OLD.builder, "down"],
    ])
  })
})

// A gh on PATH that answers each pull request by its number as GitHub and gh answered the reads measured once: a refused query, a pull request GitHub does not hold, a gateway error on stderr alone, and no login.
const FAKE_GH = `#!/usr/bin/env bun
const number = process.argv.find((arg) => arg.startsWith("number="))?.slice(7)
const head = "HTTP/2.0 200 OK\\nContent-Type: application/json; charset=utf-8\\n\\n"
const errors = (error) => head + JSON.stringify({ data: { repository: null }, errors: [error] })
const answers = {
  1: [1, errors({ message: "Resource not accessible by integration", type: "FORBIDDEN" }), "gh: Resource not accessible by integration\\n"],
  2: [1, errors({ message: "Could not resolve to a PullRequest with the number of 2.", type: "NOT_FOUND" }), "gh: Could not resolve to a PullRequest with the number of 2.\\n"],
  3: [1, "", "HTTP 502: Bad Gateway (https://api.github.com/graphql)\\n"],
  4: [4, "", "To get started with GitHub CLI, please run:  gh auth login\\n"],
}
const [code, out, err] = answers[number]
process.stdout.write(out)
process.stderr.write(err)
process.exit(code)
`

describe.skipIf(onLiveDashboard())("a failed GitHub read (#1672)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-gh-read-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))
  const data = join(dir, "data")
  mkdirSync(data)
  writeFileSync(
    join(data, "roster.json"),
    JSON.stringify({
      agents: [1, 2, 3, 4].map((n) => ({
        name: `worker-${n}`,
        pr: `https://github.com/o/r/pull/${n}`,
        role: "worker",
        status: "working",
        task: "Read",
      })),
      updatedAt: "2026-10-22T10:00:00Z",
    }),
  )
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "gh"), FAKE_GH)
  chmodSync(join(bin, "gh"), 0o755)
  const board = (path: string) =>
    inFixture(
      `const { agentsBoard } = await import(\`\${API}/lib/dashboard/agents\`)
const board = await agentsBoard(async () => ({ surfaces: new Map(), transcripts: new Map(), workers: [] }))
console.log(JSON.stringify(board.agents.map((a) => [a.name, a.pr, a.pullProblem])))
process.exit(0)`,
      dir,
      {
        CLAUDE_CONFIG_DIR: join(dir, "config"),
        PLAYGROUND_DATA_DIR: data,
        PLAYGROUND_LIVE_READS: "1",
        PLAYGROUND_MERGED_PULLS: join(dir, "merged-pulls.json"),
        PATH: path,
      },
    )

  test("names GitHub's own answer or gh's stderr, reads a pull request GitHub does not hold as none, and keeps the gh setup line for no login", async () => {
    const { code, result, stderr } = await board(`${bin}:${process.env.PATH}`)
    expect(stderr).not.toContain("error:")
    expect(code).toBe(0)
    expect(result).toEqual([
      ["worker-1", null, { reason: "Resource not accessible by integration", setup: false }],
      ["worker-2", null, null],
      [
        "worker-3",
        null,
        { reason: "HTTP 502: Bad Gateway (https://api.github.com/graphql)", setup: false },
      ],
      ["worker-4", null, { reason: "gh is not logged in", setup: true }],
    ])
  })

  test("says gh is not installed when it is not on PATH", async () => {
    const tools = join(dir, "tools")
    mkdirSync(tools)
    symlinkSync(Bun.which("git") ?? "git", join(tools, "git"))
    const { code, result } = await board(`${tools}:${dirname(process.execPath)}`)
    expect(code).toBe(0)
    expect(result).toEqual(
      [1, 2, 3, 4].map((n) => [
        `worker-${n}`,
        null,
        { reason: "gh is not installed", setup: true },
      ]),
    )
  })
})

describe("queued", () => {
  const roster = (agents: Partial<RosterAgent>[], backlog: string[]) => ({
    agents: agents.map((fields) => rosterAgent(fields)),
    backlog,
    updatedAt: "2026-10-06T10:00:00Z",
  })
  const queued = (read: Parameters<typeof queuedFor>[0], owner = "Merritt") =>
    queuedFor(read, owner)

  test("the backlog from the lead's cursor on; with no cursor, all of it", () => {
    const backlog = ["first", "second", "third"]
    expect(queued(roster([{ name: OLD.dispatcher }], backlog))).toEqual(backlog)
    expect(
      queued(roster([{ name: OLD.dispatcher }, { backlogNext: 2, name: OLD.builder }], backlog)),
    ).toEqual(["third"])
    expect(queued(roster([{ backlogNext: 5, name: OLD.builder }], backlog))).toEqual([])
    expect(queued(null)).toEqual([])
  })

  test("the marks are the builder's: a builder of a new name holds them while its entry is live, else the builder's sessions.names name", () => {
    const backlog = ["first", "second", "third"]
    const lead = (status: string) =>
      roster(
        [
          { backlogNext: 1, name: "builder", status: "ended" },
          { backlogNext: 2, kind: "builder", name: "x7mh4d-builder", status },
        ],
        backlog,
      )
    expect(queued(lead("working"))).toEqual(["third"])
    expect(queued(lead("ended"))).toEqual(["second", "third"])
  })

  test("fixes first, then the owner's own asks, then the rest, each oldest first", () => {
    const backlog = [
      "review skill",
      "Merritt: ETA per worker",
      "Fix: pglaunch binds 0.0.0.0",
      "findings flow",
      "Owner: system panel",
      "Merritt: system panel",
      "Fix: CI red on canary",
    ]
    expect(queued(roster([{ name: OLD.builder }], backlog), "Merritt")).toEqual([
      "Fix: pglaunch binds 0.0.0.0",
      "Fix: CI red on canary",
      "Merritt: ETA per worker",
      "Merritt: system panel",
      "review skill",
      "findings flow",
      "Owner: system panel",
    ])
  })

  test("with PLAYGROUND_OWNER_NAME unset, the owner's asks are the Owner: entries", () => {
    const backlog = ["review skill", "Merritt: ETA per worker", "Owner: system panel"]
    expect(queued(roster([{ name: OLD.builder }], backlog), orgOf({}).owner.name)).toEqual([
      "Owner: system panel",
      "review skill",
      "Merritt: ETA per worker",
    ])
  })

  test("only the lead's entry holds the marks; a stray mark anywhere else hides nothing", () => {
    const backlog = ["a", "b", "c"]
    const stray = { backlogNext: 2, backlogTaken: [0], name: "worker-pride" }
    expect(queued(roster([stray, { name: OLD.builder }], backlog))).toEqual(["a", "b", "c"])
    expect(queued(roster([stray], backlog))).toEqual(["a", "b", "c"])
    expect(
      queued(
        roster(
          [
            { backlogNext: 1, name: OLD.dispatcher },
            { backlogNext: 2, name: OLD.builder },
          ],
          backlog,
        ),
      ),
    ).toEqual(["c"])
  })

  test("entries at or past the cursor already taken out of turn are hidden too", () => {
    const backlog = ["a", "b", "c", "d", "e"]
    const lead = { backlogNext: 1, backlogTaken: [2, 4], name: OLD.builder }
    expect(queued(roster([lead], backlog))).toEqual(["b", "d"])
    expect(queued(roster([{ backlogTaken: [0], name: OLD.builder }], backlog))).toEqual([
      "b",
      "c",
      "d",
      "e",
    ])
  })
})

// a branch names a ticket by where it sits, so this repository's own branches that are not tickets name none.
describe("branchTicketOf", () => {
  const own = "acme/factory"

  test("PG-<n> in either case on the stack's own repository, or one it cannot name, gives PG-<n>", () => {
    expect(branchTicketOf("PG-966-label", own, own)).toBe("PG-966")
    expect(branchTicketOf("pg-966-label", own, own)).toBe("PG-966")
    expect(branchTicketOf("pg-966", null, own)).toBe("PG-966")
    expect(branchTicketOf("pg-966-label", "acme-labs/example-repo", "")).toBe("PG-966")
  })

  test("another repository's branch that starts with a Linear ID gives that ID", () => {
    expect(branchTicketOf("fix-1234-export", "acme-labs/example-repo", own)).toBe("FIX-1234")
    expect(branchTicketOf("ABC-2582", "acme-labs/gke-deployments", own)).toBe("ABC-2582")
  })

  test("any other branch names none", () => {
    for (const [branch, repo] of [
      ["nd-603-aside-setup-lines", own],
      ["test-855-stack", own],
      ["pr-843", own],
      ["fix-1234-export", null],
      ["vx-step1-soak", own],
      ["feat/board-colours", "acme-labs/example-repo"],
      ["research-939-pg-baseline", "acme-labs/example-repo"],
      [null, own],
    ] as const)
      expect(branchTicketOf(branch, repo, own)).toBeNull()
  })
})

// the board reads each session's PR again on every cache expiry, so it skips gh while ops-tick's gh sign-in probe reads failed, and the row shows why
test("ghGraphql throws gh unreachable while the gh sign-in probe reads failed", async () => {
  await withGhDown(() =>
    expect(ghGraphql(["-f", "query={viewer{login}}"])).rejects.toThrow(
      "gh unreachable: gh token invalid",
    ),
  )
})
