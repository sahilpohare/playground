import "@packages/env/aliases"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { getSessionNames, managerOf, type RosterKind } from "@packages/config/kinds"
import { atHead, verdictsOf } from "@packages/config/verdicts"
import { ghSkipped } from "@packages/scripts/gh-read"

import { readFixtureMachine, readsLive } from "@/lib/dashboard/fixture"
import { gatesAt, readGates } from "@/lib/dashboard/gates"
import { heldReason, readHeld } from "@/lib/dashboard/held"
import { dashboardHub } from "@/lib/dashboard/hub"
import { readManagersOrder } from "@/lib/dashboard/managers-order"
import { queueRepo, readMergeQueue } from "@/lib/dashboard/merge-queue"
import { socketNames } from "@/lib/dashboard/peers"
import {
  readRoster,
  rosterPath,
  type Roster,
  type RosterAgent,
  type RosterRole,
} from "@/lib/dashboard/roster"
import { clip, completeLines, sentIn } from "@/lib/dashboard/transcript"
import { readWorkQueue, type WorkQueue } from "@/lib/dashboard/work-queue"
import {
  DISPATCHER,
  kindOf,
  listLive,
  roleOf,
  type Light,
  type Live,
  type Worker,
} from "@/lib/dashboard/workers"
import { org } from "@/lib/org"
import { dataDir } from "@/lib/sessions/paths"

// What every agent is doing: the dispatcher's roster (who it dispatched and why) joined to the live sessions the dashboard already streams, with each one's last activity, last report (to the dispatcher, or a runner's to Ops too), branch and pull request. Read-only: it reads the roster, transcripts and git, and asks GitHub only through a cached `gh api graphql` read.
export type AgentState = Light | "down"

export type CiState = "failing" | "none" | "passing" | "pending"

export type Pull = {
  // approvals still needed before it may merge: what its base branch's rules require, less the approvals it holds, while GitHub's review decision says one is required
  approvals: number
  ci: CiState
  // it conflicts with its base (mergeable CONFLICTING or mergeStateStatus DIRTY), so GitHub starts no Actions run on it; UNKNOWN, while GitHub works it out, is no conflict
  conflicts: boolean
  draft: boolean
  // the pr:merge gates it fails at its head, as the merge train last read them (gates.json, `gatesAt`): none when it would merge, null while no read is at this head
  gates: string[] | null
  // its head commit
  head: string
  number: number
  // in a merge queue, or set to merge itself once it may
  queued: boolean
  // any ReviewBot verdict in the comments read, at any head: a push leaves the score behind but not the review
  reviewed: boolean
  // the newest ReviewBot verdict's round, at any head
  round: number | null
  score: string | null
  state: "closed" | "merged" | "open"
  // the newest tester's word (## TesterBot · PASS|FAIL at <sha7>), when it was given at the head
  tester: "fail" | "pass" | null
  title: string
  // when GitHub last saw it change, a push, a comment or a review
  updatedAt: string | null
  url: string
  // the newest ReviewBot verdict's score, at any head: a push or a canary merge leaves the score behind, not what the review said
  verdict: string | null
}

export type PullProblem = { reason: string; setup: boolean }

export type Report = { at: string | null; text: string }

export type Agent = {
  branch: string | null
  // The ticket its branch names (branchTicketOf): PG-<n> from this stack's own PG-<n>-<slug> in either case, a Linear ID from another repository's branch; null otherwise.
  branchTicket: string | null
  eta: string | null
  // What it is: the roster's kind, else what its name gives; null for a session outside the factory.
  kind: RosterKind | null
  lastActivityAt: string | null
  name: string
  // why its pull request is on the held list (ops/report/held-prs.json), while it is
  parked: string | null
  pr: Pull | null
  // why its pull request could not be read from GitHub, in GitHub's or gh's own words, so an empty Pull requests tab can say so; `setup` when gh is missing or has no login, which setting gh up fixes, rather than GitHub refusing the read
  pullProblem: PullProblem | null
  report: Report | null
  // The roster's role, else the live session's; other for one outside the factory's names.
  role: RosterRole | "other"
  // A runner's cadence as the roster gives it: `always`, or a 5-field cron; null when it has none.
  schedule: string | null
  sessionId: string | null
  state: AgentState
  status: string | null
  task: string | null
  // The Linear ticket the roster puts it on (ABC-123), which its sidebar row shows before its title.
  ticket: string | null
  title: string | null
  // For a reviewer or tester, the full name of the worker whose pull request it checks, which its row nests under.
  worker: string | null
  workspace: string | null
}

// The leads' merge queue, read-only: the open pull requests in the order they will merge, each with when it is expected to merge and the leads' words for it (the tab's title for a pull no agent works on), and the parked ones. repo is what the tab matches a queue entry by, this checkout's repository, since a number alone would match any repository's pull.
export type PullsQueue = {
  parked: { pr: number }[]
  queue: { etaMerge: string | null; item: string | null; pr: number }[]
  repo: string
}

// liveProblem says why live sessions could not be read (the sessions read failed or timed out); the roster's agents then all read as down. sockets names each live session's peer socket (`uds:<path>`), so a message sent to an address can be shown by its recipient's name.
export type AgentsBoard = {
  agents: Agent[]
  liveProblem: string | null
  // The manager session names in the order the owner dragged the sidebar's Orchestrators rows into, [] until then.
  managersOrder: string[]
  pullsQueue: PullsQueue
  roster: { backlog: string[]; path: string; problem: string | null; updatedAt: string | null }
  sockets: Record<string, string>
  // The owner's open pulls in the work org, null while none is set (work-queue.ts), and on a board of live sessions' pulls alone.
  workQueue: WorkQueue | null
}

export type TranscriptFacts = { lastActivityAt: string | null; report: Report | null }

type Json = Record<string, unknown>

export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const str = (value: unknown): string => (typeof value === "string" ? value : "")

const parse = (line: string): Json | null => {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

const REPORT_LIMIT = 600

// Each report recipient's uds addresses by its name, as the registry and its own peer messages give them.
export type Addresses = Map<string, Set<string>>

const addressOf = (addresses: Addresses, name: string, address: string) => {
  const held = addresses.get(name) ?? new Set<string>()
  held.add(address)
  addresses.set(name, held)
}

// A peer message from a recipient carries the uds address it sends from; a reply often goes there rather than to its name, so the address counts as that recipient's too.
export const learnAddress = (
  line: string,
  recipients: readonly string[],
  addresses: Addresses,
): void => {
  const d = parse(line)
  if (!d) return
  const attachment = isRecord(d.attachment) ? d.attachment : {}
  const origin = isRecord(d.origin)
    ? d.origin
    : isRecord(attachment.origin)
      ? attachment.origin
      : {}
  if (origin.kind === "peer" && recipients.includes(str(origin.name)) && str(origin.from)) {
    addressOf(addresses, str(origin.name), str(origin.from))
  }
}

// Pure: the last message one line sent to any of recipients, by name or by an address it wrote from.
export const reportOf = (
  line: string,
  recipients: readonly string[],
  addresses: Addresses,
): Report | null => {
  let report: Report | null = null
  for (const { at, text, to } of sentIn(line)) {
    const toRecipient = recipients.some((name) => to === name || addresses.get(name)?.has(to))
    if (text && toRecipient) {
      report = { at, text: clip(text, REPORT_LIMIT) }
    }
  }
  return report
}

const timestampOf = (line: string): string | null => str(parse(line)?.timestamp) || null

// Pure: complete transcript lines, oldest first, folded over what earlier lines said. It walks back from the newest line and parses only the lines that can hold what is still missing, so a long transcript with no report costs a substring test per line, not a JSON parse. recipients are who a session reports to (reportsTo), none for the dispatcher's own transcript.
export function foldTranscript(
  text: string,
  recipients: readonly string[],
  addresses: Addresses,
  prior: TranscriptFacts,
): TranscriptFacts {
  const lines = text.split("\n")
  const reports = recipients.length > 0
  if (reports) {
    for (const line of lines) if (line.includes('"peer"')) learnAddress(line, recipients, addresses)
  }
  let lastActivityAt: string | null = null
  let report: Report | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastActivityAt && (report || !reports)) break
    const line = lines[i] ?? ""
    if (!line.trim()) continue
    if (!lastActivityAt) lastActivityAt = timestampOf(line)
    if (!report && reports && line.includes('"SendMessage"')) {
      report = reportOf(line, recipients, addresses)
    }
  }
  return {
    lastActivityAt: lastActivityAt ?? prior.lastActivityAt,
    report: report ?? prior.report,
  }
}

const NO_FACTS: TranscriptFacts = { lastActivityAt: null, report: null }

// A first read covers this much of a transcript's end: enough for any recent report, without reading a session's whole history. The dispatcher's needs only its last line.
const SCAN_BYTES = 32 * 1024 * 1024
const DISPATCHER_SCAN_BYTES = 512 * 1024
// Bytes are read and folded this many at a time, so a first read of every live session at once holds a few chunks in memory rather than every window whole.
export const CHUNK_BYTES = 2 * 1024 * 1024

type Scan = TranscriptFacts & { offset: number }

const scans = new Map<string, Promise<Scan>>()
const recipientAddresses: Addresses = new Map()

// Pure: who a session's report goes to: a runner reports to Ops, its manager, as well as to the dispatcher; the dispatcher to no one; every other session to the dispatcher.
export const reportsTo = (role: Worker["role"] | undefined): readonly string[] =>
  role === "dispatcher"
    ? []
    : role === "runner"
      ? [DISPATCHER, getSessionNames().names.ops]
      : [DISPATCHER]

// Each transcript is read once from its end, then only from where the last read stopped, so a refresh costs the bytes written since. A file that shrank is read afresh. The bytes are folded a chunk at a time, oldest first; a chunk holding no whole line (one line longer than a chunk) is widened until it holds one.
async function advance(
  path: string,
  prior: Scan | null,
  recipients: readonly string[],
): Promise<Scan> {
  const reports = recipients.length > 0
  const file = Bun.file(path)
  const size = file.size
  let scan: Scan =
    prior && prior.offset <= size
      ? prior
      : { ...NO_FACTS, offset: Math.max(0, size - (reports ? SCAN_BYTES : DISPATCHER_SCAN_BYTES)) }
  let chunk = CHUNK_BYTES
  while (scan.offset < size) {
    const end = Math.min(size, scan.offset + chunk)
    const bytes = new Uint8Array(await file.slice(scan.offset, end).arrayBuffer())
    const { consumed, text } = completeLines(bytes)
    if (consumed === 0) {
      if (end === size) break
      chunk *= 2
      continue
    }
    const facts = foldTranscript(text, recipients, recipientAddresses, scan)
    scan = { ...facts, offset: scan.offset + consumed }
    chunk = CHUNK_BYTES
  }
  return scan
}

export async function scanTranscript(
  path: string,
  recipients: readonly string[],
): Promise<TranscriptFacts> {
  const prior = scans.get(path)
  const next = (prior ?? Promise.resolve(null))
    .catch(() => null)
    .then((scan) => advance(path, scan, recipients))
  scans.set(path, next)
  return next
}

const forgetScans = (live: Set<string>) => {
  for (const path of scans.keys()) if (!live.has(path)) scans.delete(path)
}

// A command's exit code and trimmed output and stderr. One that cannot start or runs past its time throws, since that says nothing about what it would have answered.
export async function run(
  command: string[],
  timeoutMs: number,
  label = command[0],
): Promise<{ code: number; err: string; out: string }> {
  const proc = Bun.spawn(command, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  if (timedOut) throw new Error(`${label} ran past ${timeoutMs}ms`)
  return { code, err: err.trim(), out: out.trim() }
}

// Answers kept per key and shared by every caller, so a page refreshing every few seconds runs each command at most once per ttl, and callers asking at once share one load. Past its ttl an answer is still served while a fresh one loads behind it, so no request waits on git or GitHub once the first has answered. A load that fails (it throws; an answer of "none" resolves) keeps the answer it would have replaced, or the failure when there was none, and is not tried again until the time its error names (`retryAt`, such as GitHub's reset) or one ttl, so a refused read is never fired again by every call. A load still running after ten ttls is taken for hung, and the next call starts another. A key nobody asks for in ten ttls is dropped.
export function cachedBy<T>(
  ttlMs: number,
  load: (key: string) => Promise<T>,
  clock: () => number = Date.now,
) {
  const cache = new Map<
    string,
    {
      askedAt: number
      good: boolean
      pending: Promise<T> | null
      retryAt: number
      startedAt: number
      value: Promise<T>
    }
  >()
  return (key: string): Promise<T> => {
    const now = clock()
    for (const [old, entry] of cache) if (now - entry.askedAt > ttlMs * 10) cache.delete(old)
    const hit = cache.get(key)
    if (hit) hit.askedAt = now
    const running = hit?.pending && now - hit.startedAt <= ttlMs * 10
    if (hit && (running || now < hit.retryAt)) return hit.value
    const loading = load(key)
    const entry = hit ?? {
      askedAt: now,
      good: false,
      pending: loading,
      retryAt: 0,
      startedAt: now,
      value: loading,
    }
    Object.assign(entry, { pending: loading, startedAt: now })
    if (!entry.good) entry.value = loading
    cache.set(key, entry)
    loading.then(
      () => {
        if (entry.pending !== loading) return
        Object.assign(entry, {
          good: true,
          pending: null,
          retryAt: clock() + ttlMs,
          value: loading,
        })
      },
      (err: unknown) => {
        if (entry.pending !== loading) return
        const named = isRecord(err) ? err.retryAt : null
        const retryAt = typeof named === "number" && named > clock() ? named : clock() + ttlMs
        Object.assign(entry, { pending: null, retryAt })
      },
    )
    return entry.value
  }
}

export type GitFacts = { branch: string | null; repo: string | null }

export const repoOf = (remote: string): string | null =>
  /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] ?? null

const GIT_TTL_MS = 30_000

// git refusing (a directory that is no checkout, a checkout with no origin) is an answer: no branch, no repo. A fixture stack runs no git: its fixture says what each checkout is on.
const gitFacts = cachedBy<GitFacts>(GIT_TTL_MS, async (cwd) => {
  if (!readsLive()) return readFixtureMachine().git[cwd] ?? { branch: null, repo: null }
  const [branch, remote] = await Promise.all([
    run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], 3000),
    run(["git", "-C", cwd, "remote", "get-url", "origin"], 3000),
  ])
  return {
    branch: branch.code === 0 && branch.out !== "HEAD" ? branch.out : null,
    repo: remote.code === 0 ? repoOf(remote.out) : null,
  }
})

// A branch every checkout starts on has no pull request of its own.
const DEFAULT_BRANCHES = new Set(["canary", "develop", "main", "master"])

export type Work = { branch: string | null; lookup: string | null; repo: string | null }

// Pure: where an agent's work sits. A session whose checkout is on a branch of its own is working there, so that branch and its pull request are the agent's. On a default branch, or down, the roster's record stands: its pr URL names the pull request outright, else its branch is looked up. A checkout another live session shares is not the agent's own, so there the roster's pr or branch wins when it has one.
export function workOf(roster: RosterAgent | null, git: GitFacts | null, shared = false): Work {
  const branch = git?.branch && !DEFAULT_BRANCHES.has(git.branch) ? git.branch : null
  const own = shared && (roster?.pr || roster?.branch) ? null : branch
  if (own) {
    return { branch: own, lookup: git?.repo ? `${git.repo}#${own}` : null, repo: git?.repo ?? null }
  }
  const repo = roster?.repo ?? git?.repo ?? null
  const byBranch =
    repo && roster?.branch && !DEFAULT_BRANCHES.has(roster.branch)
      ? `${repo}#${roster.branch}`
      : null
  return {
    branch: roster?.branch ?? git?.branch ?? null,
    lookup: roster?.pr ?? byBranch,
    repo,
  }
}

// The rollup GitHub keeps for a PR's head commit, as one word; no rollup means no checks ran.
const CI_STATES: Record<string, CiState> = {
  ERROR: "failing",
  EXPECTED: "pending",
  FAILURE: "failing",
  PENDING: "pending",
  SUCCESS: "passing",
}

export const ciOf = (rollup: string): CiState => CI_STATES[rollup] ?? "none"

// The Dashboard reads the gate's markers (packages/config/src/verdicts.ts) rather than its own regexes, so both readers answer a thread the same way: a marker counts only from the account that posts the gates (the repo's owner, whom pr:merge trusts), and a score off a comment's first line is nobody's verdict.
const verdicts = (bodies: string[]) => bodies.flatMap((b) => verdictsOf(b))
const reviews = (bodies: string[]) => verdicts(bodies).filter((v) => v.gate === "review")

// Pure: the newest ReviewBot comment's score, as /linear reads it, when the commit it scored is the PR's head; an older head's score says nothing about this one.
export function scoreOf(bodies: string[], head: string): string | null {
  const hit = reviews(bodies)
    .filter((v) => atHead(v.at, head))
    .at(-1)
  return hit ? `${hit.score}/5` : null
}

// Pure: whether any ReviewBot verdict with a score sits in these comments, whatever commit it scored.
export const reviewedOf = (bodies: string[]): boolean => reviews(bodies).length > 0

// Pure: the newest ReviewBot verdict's round (`## ReviewBot · round 2: 4/5 at abc1234`), whatever commit it scored.
export function roundOf(bodies: string[]): number | null {
  return reviews(bodies).at(-1)?.round ?? null
}

// Pure: the newest ReviewBot verdict's score (`4/5`), whatever commit it scored.
export function verdictOf(bodies: string[]): string | null {
  const hit = reviews(bodies).at(-1)
  return hit ? `${hit.score}/5` : null
}

// Pure: the newest tester's word, when the commit it tested is the PR's head; an older head's verdict says nothing about this one.
export function testerOf(bodies: string[], head: string): "fail" | "pass" | null {
  const hit = verdicts(bodies)
    .filter((v) => v.gate === "tester" && atHead(v.at, head))
    .at(-1)
  if (!hit) return null
  return hit.pass ? "pass" : "fail"
}

// Pure: the approvals a PR's base branch's rules (a ruleset's, else a branch protection rule's) require, and the reviewers whose latest word approves it.
export function approvalCounts(node: Json): { approved: number; required: number } {
  const base = isRecord(node.baseRef) ? node.baseRef : {}
  const counts = [
    ...nodes(base.rules).map((rule) => rule.parameters),
    base.branchProtectionRule,
  ].map((rule) => (isRecord(rule) ? rule.requiredApprovingReviewCount : null))
  return {
    approved: nodes(node.latestOpinionatedReviews).filter((r) => r.state === "APPROVED").length,
    required: Math.max(0, ...counts.filter((n): n is number => typeof n === "number")),
  }
}

// Pure: the approvals a PR still needs: none unless GitHub's review decision says a review is required (or changes were asked for), then what its rules require less those approving it, at least one.
export function approvalsOf(node: Json): number {
  if (node.reviewDecision !== "REVIEW_REQUIRED" && node.reviewDecision !== "CHANGES_REQUESTED")
    return 0
  const { approved, required } = approvalCounts(node)
  return Math.max(1, required - approved)
}

const PR_STATES = { CLOSED: "closed", MERGED: "merged", OPEN: "open" } as const

export const nodes = (connection: unknown): Json[] =>
  isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : []

// Pure: a PullRequest node's comment bodies as the gate reads them: the poster's comments only when one is given (every gate comment is posted by that one account, so nobody else can post a marker), oldest first so the newest verdict is the last.
const commentBodies = (connection: unknown, poster?: string): string[] =>
  nodes(connection)
    .filter(
      (c) =>
        !poster ||
        str(isRecord(c.author) ? c.author.login : "").toLowerCase() === poster.toLowerCase(),
    )
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)))
    .map((c) => str(c.body))

// Pure: one PullRequest node of the query below as a Pull, or null when it is not one.
export function pullOf(node: unknown, poster?: string): Pull | null {
  if (!isRecord(node) || typeof node.number !== "number" || !str(node.url)) return null
  const state = PR_STATES[str(node.state) as keyof typeof PR_STATES]
  if (!state) return null
  const commit = nodes(node.commits)[0]?.commit
  const rollup =
    isRecord(commit) && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : {}
  const bodies = commentBodies(node.comments, poster)
  return {
    approvals: state === "open" ? approvalsOf(node) : 0,
    ci: ciOf(str(rollup.state)),
    conflicts: node.mergeable === "CONFLICTING" || node.mergeStateStatus === "DIRTY",
    draft: node.isDraft === true,
    gates: null,
    head: str(node.headRefOid),
    number: node.number,
    queued: isRecord(node.mergeQueueEntry) || isRecord(node.autoMergeRequest),
    reviewed: reviewedOf(bodies),
    round: roundOf(bodies),
    score: scoreOf(bodies, str(node.headRefOid)),
    state,
    tester: testerOf(bodies, str(node.headRefOid)),
    title: str(node.title),
    updatedAt: Number.isNaN(Date.parse(str(node.updatedAt))) ? null : str(node.updatedAt),
    url: str(node.url),
    verdict: verdictOf(bodies),
  }
}

// One GraphQL read per PR: its title, state and last update, the head commit's check rollup, what its approvals and merge stand at, and only its last 30 comments, where a current ReviewBot score and TesterBot word sit, so a PR with a long thread costs no more than a short one.
const PULL_FIELDS =
  "fragment P on PullRequest { autoMergeRequest { enabledAt } baseRef { branchProtectionRule { requiredApprovingReviewCount } rules(first: 100) { nodes { parameters { ... on PullRequestParameters { requiredApprovingReviewCount } } } } } comments(last: 30) { nodes { author { login } body createdAt } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } headRefOid isDraft latestOpinionatedReviews(first: 20) { nodes { state } } mergeQueueEntry { state } mergeStateStatus mergeable number reviewDecision state title updatedAt url }"
const BY_BRANCH = `${PULL_FIELDS} query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...P } } } viewer { login } }`
const BY_NUMBER = `${PULL_FIELDS} query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...P } } viewer { login } }`

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/
const BRANCH_LOOKUP_RE = /^([\w.-]+)\/([\w.-]+)#(.+)$/

// Pure: the `gh api graphql` arguments for a lookup, a PR URL or `owner/name#branch`.
export function pullQuery(lookup: string): string[] | null {
  const byUrl = PR_URL_RE.exec(lookup)
  if (byUrl) {
    const [, owner, name, number] = byUrl
    return [
      "-f",
      `query=${BY_NUMBER}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]
  }
  const byBranch = BRANCH_LOOKUP_RE.exec(lookup)
  if (!byBranch) return null
  const [, owner, name, branch] = byBranch
  return [
    "-f",
    `query=${BY_BRANCH}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `branch=${branch}`,
  ]
}

export const PR_TTL_MS = 300_000

// Pure: a `gh api -i` answer as its body, and when GitHub's budget opens again (its reset header, in ms) once the answer says none is left.
export function ghAnswer(out: string): { body: string; retryAt: number | null } {
  const split = /\r?\n\r?\n/.exec(out)
  if (!split) return { body: "", retryAt: null }
  const head = out.slice(0, split.index)
  const header = (name: string) => new RegExp(`^${name}:\\s*(\\d+)\\s*$`, "im").exec(head)?.[1]
  const reset = header("x-ratelimit-reset")
  return {
    body: out.slice(split.index + split[0].length),
    retryAt: header("x-ratelimit-remaining") === "0" && reset ? Number(reset) * 1000 : null,
  }
}

// gh exits 4 when it has no login.
const GH_SIGNED_OUT = 4

// Pure: why a `gh api graphql` read that exited non-zero failed, in one line: GitHub's own GraphQL error messages, else the first line gh wrote to stderr (an HTTP status line), else its exit code. `notFound` when every error is GitHub saying the repository or pull request does not exist, which is an answer rather than a failure; `setup` when gh has no login, which only `gh auth login` fixes.
export function ghFailure(
  code: number,
  body: string,
  err: string,
): { notFound: boolean; reason: string; setup: boolean } {
  const answer = parse(body)
  const errors = answer && Array.isArray(answer.errors) ? answer.errors.filter(isRecord) : []
  const said =
    errors
      .map((error) => str(error.message))
      .filter(Boolean)
      .join("; ") ||
    err
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^gh: /, "")
  return {
    notFound: errors.length > 0 && errors.every((error) => error.type === "NOT_FOUND"),
    reason:
      code === GH_SIGNED_OUT
        ? "gh is not logged in"
        : said
          ? said.replace(/\s+/g, " ")
          : `gh api graphql exited ${code}`,
    setup: code === GH_SIGNED_OUT,
  }
}

// Pure: a `gh api graphql` answer as the PR it names, null when the repository holds none, its verdicts counted from the viewer's comments alone: gh reads as the account that posts every gate comment, which on an org-owned repo is not its owner. An answer without a repository (an error, a rate limit) throws, so the cache keeps what it had.
export function pullFromAnswer(out: string): Pull | null {
  const answer: unknown = JSON.parse(out)
  const data = isRecord(answer) ? answer.data : null
  const repository = isRecord(data) ? data.repository : null
  if (!isRecord(repository)) throw new Error("GitHub answered without the repository")
  const viewer = isRecord(data) && isRecord(data.viewer) ? str(data.viewer.login) : ""
  return pullOf(repository.pullRequest ?? nodes(repository.pullRequests)[0], viewer || undefined)
}

// One `gh api graphql` read, skipped with ghSkipped's line while the gh sign-in probe reads failed: its answer's body, `notFound` when GitHub answered that it holds no such repository or pull request, which reads as none, as an empty branch does. Any other failure throws, naming why, when GitHub's budget opens again and whether only a setup fixes it.
export async function ghGraphql(args: string[]): Promise<{ body: string; notFound: boolean }> {
  const skipped = ghSkipped()
  if (skipped) throw new Error(skipped)
  const { code, err, out } = await run(["gh", "api", "graphql", "-i", ...args], 10_000).catch(
    (error: unknown) => {
      throw isRecord(error) && error.code === "ENOENT"
        ? Object.assign(new Error("gh is not installed"), { setup: true })
        : error
    },
  )
  const { body, retryAt } = ghAnswer(out)
  if (code === 0) return { body, notFound: false }
  const { notFound, reason, setup } = ghFailure(code, body, err)
  if (notFound) return { body, notFound }
  throw Object.assign(new Error(reason), { retryAt, setup })
}

// A merged pull request never changes, so one named by its URL is read once; one found by branch may be followed by a newer one, and a closed one can be reopened, so it keeps the ordinary reads. The facts also outlive the process in a small capped file beside the roster: loaded on the first lookup, written atomically on every addition, and a file that does not read costs the cache nothing.
export const MERGED_PULLS_CAP = 200

// The dashboard's own data folder, beside the roster; a live-reads test stack names a scratch file so its writes stay off the live dashboard's.
export const mergedPullsPath = (): string =>
  process.env.PLAYGROUND_MERGED_PULLS || join(dataDir(), "merged-pulls.json")

const intOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null

const oneOf = <T extends string>(value: unknown, choices: readonly T[]): boolean =>
  (choices as readonly unknown[]).includes(value)

// Each field of a stored entry checked on its own, as the roster's reader does: the checks are keyed by Pull's own fields, so a field the board gains without a check here fails the type check, and an entry an older build wrote, or one hand-mangled, drops whole and is read again.
const storedPull = (value: unknown): Pull | null => {
  if (!isRecord(value) || value.state !== "merged") return null
  const ok: Record<keyof Pull, boolean> = {
    approvals: intOf(value.approvals) !== null,
    ci: oneOf(value.ci, ["failing", "none", "passing", "pending"]),
    // an entry stored before the field came reads as no conflict, since a merged PR has none
    conflicts: value.conflicts === undefined || typeof value.conflicts === "boolean",
    draft: typeof value.draft === "boolean",
    // a merged PR has no gate read, and an entry stored before head came reads as none
    gates: value.gates === undefined || value.gates === null,
    head: value.head === undefined || typeof value.head === "string",
    number: intOf(value.number) !== null,
    queued: typeof value.queued === "boolean",
    reviewed: typeof value.reviewed === "boolean",
    round: value.round === null || intOf(value.round) !== null,
    score: value.score === null || typeof value.score === "string",
    state: value.state === "merged",
    tester: value.tester === null || oneOf(value.tester, ["fail", "pass"]),
    title: typeof value.title === "string",
    updatedAt: value.updatedAt === null || typeof value.updatedAt === "string",
    url: typeof value.url === "string" && PR_URL_RE.test(value.url),
    verdict: value.verdict === null || typeof value.verdict === "string",
  }
  return Object.values(ok).every(Boolean)
    ? ({
        ...value,
        conflicts: value.conflicts === true,
        gates: null,
        head: typeof value.head === "string" ? value.head : "",
      } as unknown as Pull)
    : null
}

export const readMergedPulls = async (file: string): Promise<[string, Pull][]> => {
  const text = await readFile(file, "utf8").catch(() => null)
  if (text === null) return []
  const parsed: unknown = await Promise.resolve()
    .then(() => JSON.parse(text))
    .catch(() => null)
  const pulls = parsed && isRecord(parsed) && Array.isArray(parsed.pulls) ? parsed.pulls : []
  const entries: [string, Pull][] = []
  for (const entry of pulls) {
    if (!isRecord(entry)) continue
    const url = str(entry.url)
    const pull = storedPull(entry.pull)
    if (!pull || !PR_URL_RE.test(url)) continue
    entries.push([url, pull])
  }
  return entries.slice(-MERGED_PULLS_CAP)
}

export const writeMergedPulls = async (file: string, entries: [string, Pull][]): Promise<void> => {
  const tmp = `${file}.${randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, JSON.stringify({ pulls: entries.map(([url, pull]) => ({ pull, url })) }))
  await rename(tmp, file)
}

export function mergedOnce(
  load: (lookup: string) => Promise<Pull | null>,
  file: string | null = null,
) {
  const merged = new Map<string, Pull>()
  let loaded: Promise<void> | null = null
  return async (lookup: string): Promise<Pull | null> => {
    if (file && !loaded)
      loaded = readMergedPulls(file).then((entries) => {
        for (const [url, pull] of entries) if (!merged.has(url)) merged.set(url, pull)
      })
    if (loaded) await loaded
    const kept = merged.get(lookup)
    if (kept) return kept
    const pull = await load(lookup)
    if (pull?.state === "merged" && PR_URL_RE.test(lookup)) {
      merged.set(lookup, pull)
      // Awaited, so a cache that answers from the file is never older than the read that just landed; a failed write still answers.
      if (file) await writeMergedPulls(file, [...merged].slice(-MERGED_PULLS_CAP)).catch(() => {})
    }
    return pull
  }
}

// A fixture stack asks GitHub nothing: its fixture holds each pull request as the query would return it.
const pullFor = mergedOnce(
  cachedBy<Pull | null>(PR_TTL_MS, async (lookup) => {
    if (!readsLive()) return pullOf(readFixtureMachine().pulls[lookup] ?? null)
    const query = pullQuery(lookup)
    if (!query) return null
    const { body, notFound } = await ghGraphql(query)
    return notFound ? null : pullFromAnswer(body)
  }),
  // A fixture stack asks GitHub nothing, so its made-up pulls never reach the live dashboard's file.
  readsLive() ? mergedPullsPath() : null,
)

export type Match<W = Worker> = { live: W | null; roster: RosterAgent | null }

const ROLE_OF: Record<Worker["role"], Agent["role"]> = {
  dispatcher: "manager",
  manager: "manager",
  other: "other",
  runner: "runner",
  worker: "worker",
}

// A session the roster does not list takes the role its name gives it, in the roster's words.
export const agentRoleOf = (name: string): Agent["role"] => ROLE_OF[roleOf(name)]

// A session launched under its bare sin (`greed`) is the roster's `worker-greed`.
const ROLE_PREFIX_RE = /^(?:runner|worker)-/

// Pure: each roster agent paired with its live session, by its surface when the roster sets one (surface:<n>, one pane), else by name (or that name without its role prefix), else by the workspace it was dispatched into when that workspace holds exactly one unclaimed session and the roster sets no surface. An agent whose surface is gone pairs by name alone: a workspace fallback could grab a neighbour's session in a shared workspace. Roster agents keep the roster's order; live sessions the roster does not list follow, since they still count as agents.
export function matchAgents<
  W extends { name: string; surface?: string | null; workspace: { ref: string } | null },
>(roster: RosterAgent[], workers: W[]): Match<W>[] {
  const unclaimed = new Set(workers)
  // A name two live sessions share (the demoted dispatcher) pairs with the first the read leads with, the keeper, never the last.
  const byName = new Map<string, W>()
  for (const w of workers) if (!byName.has(w.name)) byName.set(w.name, w)
  const bySurface = new Map(workers.flatMap((w) => (w.surface ? [[w.surface, w] as const] : [])))
  const claim = (live: W | undefined): W | null => {
    if (!live || !unclaimed.has(live)) return null
    unclaimed.delete(live)
    return live
  }
  // A surface pairs only when no other roster entry holds the session's name: one ref carried by two entries (a stale one, or a respawned pane) would otherwise pair each of them with the same session.
  const bare = (name: string): string => name.replace(ROLE_PREFIX_RE, "")
  const holds = (agent: RosterAgent, live: W): boolean =>
    roster.some((o) => o !== agent && (o.name === live.name || bare(o.name) === live.name))
  const surfaced = roster.map((agent) => {
    // an ended entry's ref belongs to a pane its successor took, so it pairs by name alone
    const live =
      agent.surface && agent.status !== "ended" ? bySurface.get(agent.surface) : undefined
    return claim(live && !holds(agent, live) ? live : undefined)
  })
  const named = roster.map((agent) =>
    claim(
      [agent.name, agent.name.replace(ROLE_PREFIX_RE, "")]
        .map((name) => byName.get(name))
        .find((w) => w && unclaimed.has(w)),
    ),
  )
  const matches: Match<W>[] = roster.map((agent, i) => {
    const inSpace = [...unclaimed].filter(
      (w) => !agent.surface && agent.workspace && w.workspace?.ref === agent.workspace,
    )
    const live = surfaced[i] ?? named[i] ?? (inSpace.length === 1 ? claim(inSpace[0]) : null)
    return { live, roster: agent }
  })
  for (const live of unclaimed) matches.push({ live, roster: null })
  return matches
}

const timeOf = (report: Report): number => (report.at ? Date.parse(report.at) : Number.NaN)

// The later of two reports; one with no time, or a time that does not parse, loses to one with a time.
const newest = (a: Report | null, b: Report | null): Report | null => {
  if (!a || !b) return a ?? b
  const [at, bt] = [timeOf(a), timeOf(b)]
  if (Number.isNaN(bt)) return a
  return Number.isNaN(at) || bt > at ? b : a
}

// A roster time this far ahead of now was stamped from a wrong clock, so it is treated as no time rather than outranking every real one.
const CLOCK_SKEW_MS = 5 * 60 * 1000

const PG_BRANCH = /^pg-(\d+)(?:-|$)/i
const LINEAR_BRANCH = /^([a-z]{2,5})-(\d+)(?:-|$)/i

// Pure: the ticket a branch names, read by where it sits, since this repository's own branches (nd-603-aside, test-855) are not tickets: a PG-<n>-<slug> in either case on the stack's own repository, or one it cannot name, gives PG-<n> (every branch counts as its own while the stack names no repository of its own), and a branch of another repository that starts with a Linear ID gives that ID.
export function branchTicketOf(
  branch: string | null,
  repo: string | null,
  ownRepo: string,
): string | null {
  if (!branch) return null
  const own = !repo || !ownRepo || repo === ownRepo
  const key = PG_BRANCH.exec(branch)?.[1]
  if (own) return key ? `PG-${key}` : null
  const linear = LINEAR_BRANCH.exec(branch)
  return linear ? `${linear[1]!.toUpperCase()}-${linear[2]}` : null
}

// Pure: one agent as the page shows it, at the moment now.
export function agentOf(
  { live, roster }: Match,
  facts: TranscriptFacts | null,
  work: Work,
  pr: Pull | null,
  now: Date,
  parked: string | null = null,
  pullProblem: PullProblem | null = null,
  ownRepo = "",
): Agent {
  const reportedAt = roster?.lastReportAt ?? null
  const rosterReport = roster?.lastReport
    ? {
        at:
          reportedAt && Date.parse(reportedAt) <= now.getTime() + CLOCK_SKEW_MS ? reportedAt : null,
        text: roster.lastReport,
      }
    : null
  return {
    branch: work.branch,
    branchTicket: branchTicketOf(work.branch, work.repo, ownRepo),
    eta: roster?.eta ?? null,
    kind: kindOf(roster?.name ?? live?.name ?? "", roster ?? undefined),
    lastActivityAt: facts?.lastActivityAt ?? live?.updatedAt ?? null,
    name: roster?.name ?? live?.name ?? "",
    parked,
    pr,
    pullProblem,
    report: newest(facts?.report ?? null, rosterReport),
    // the role the sidebar placed the live session under, else the sidebar's own rule for a down agent, so the two never place one agent in different groups
    role: ROLE_OF[live?.role ?? roleOf(roster?.name ?? "", roster ?? undefined)],
    schedule: roster?.schedule ?? null,
    sessionId: live?.sessionId ?? null,
    state: live?.light ?? "down",
    status: roster?.status ?? null,
    task: roster?.task ?? live?.task ?? null,
    ticket: roster?.ticket ?? null,
    title: roster?.title ?? null,
    worker: roster?.worker ?? null,
    workspace: roster?.workspace ?? live?.workspace?.ref ?? null,
  }
}

// The order waiting entries go out in, by prefix: a fix for live breakage or security, then what the owner (PLAYGROUND_OWNER_NAME) asked for themself, then the rest; each oldest first.
const priorityOf = (entry: string, owner: string): number => {
  const prefixes = ["Fix: ", `${owner}: `]
  const rank = prefixes.findIndex((prefix) => entry.startsWith(prefix))
  return rank === -1 ? prefixes.length : rank
}

// Pure: the backlog still waiting, in the order they go out. The roster's backlog only grows; the builder keeps two marks on its own entry: `backlogNext`, below which every entry is settled, and `backlogTaken`, the entries at or past it settled already (dispatched out of turn, or dropped). Only the builder's entry is read, so a stray mark on any other entry hides nothing; with no entry of it, or no marks (or marks that did not read, which the roster's problem names), the cursor is 0 and nothing is taken.
export function queued(roster: Roster | null, owner: string): string[] {
  // playbook's ROSTER.md: the builder dispatches the backlog, keeping its marks on its own entry as their only writer.
  const builder = managerOf(roster?.agents, "builder")
  const lead = roster?.agents.find((agent) => agent.name === builder)
  const cursor = lead?.backlogNext ?? 0
  const taken = new Set(lead?.backlogTaken ?? [])
  return (roster?.backlog ?? [])
    .map((entry, i) => ({ entry, i }))
    .filter(({ i }) => i >= cursor && !taken.has(i))
    .sort((a, b) => priorityOf(a.entry, owner) - priorityOf(b.entry, owner) || a.i - b.i)
    .map(({ entry }) => entry)
}

const NO_SESSIONS: Live = { surfaces: new Map(), transcripts: new Map(), workers: [] }

const FIXTURE_ROSTER = "<fixture>/playground/roster.json"

// One board: the roster and the live sessions, each agent with its transcript's facts, its branch and its pull request. A git or GitHub read that fails leaves that agent without a branch or a pull request rather than failing the board, the GitHub failure named on that agent (`pullProblem`).
export async function agentsBoard(
  live: () => Promise<Live> = async () => dashboardHub.snapshot ?? listLive(),
  { readPull = pullFor }: { readPull?: (lookup: string) => Promise<Pull | null> } = {},
): Promise<AgentsBoard> {
  const path = rosterPath()
  const [{ problem, roster }, sockets, read, held, gates, queueRead, managersOrder, workQueue] =
    await Promise.all([
      readRoster(path),
      socketNames(),
      live().then(
        (sessions) => ({ liveProblem: null, sessions }),
        (err: unknown) => ({
          liveProblem: err instanceof Error ? err.message : "the sessions could not be read",
          sessions: NO_SESSIONS,
        }),
      ),
      readHeld(),
      readGates(),
      readMergeQueue(),
      readManagersOrder(),
      readWorkQueue(),
    ])
  const { liveProblem, sessions } = read
  // The registry names each recipient's current socket even when a transcript's first message from it lies before the window scanned.
  const recipients = reportsTo("runner")
  for (const [address, name] of Object.entries(sockets)) {
    if (recipients.includes(name)) addressOf(recipientAddresses, name, address)
  }
  const perCwd = new Map<string, number>()
  for (const w of sessions.workers) perCwd.set(w.cwd, (perCwd.get(w.cwd) ?? 0) + 1)
  const ownRepo = queueRepo()
  const agents = await Promise.all(
    matchAgents(roster?.agents ?? [], sessions.workers).map(async (match) => {
      const cwd = match.live?.cwd ?? ""
      const transcript = match.live ? sessions.transcripts.get(match.live.sessionId) : undefined
      const [facts, git] = await Promise.all([
        transcript
          ? scanTranscript(transcript, reportsTo(match.live?.role)).catch(() => null)
          : null,
        cwd ? gitFacts(cwd).catch(() => null) : null,
      ])
      const work = workOf(match.roster, git, (perCwd.get(cwd) ?? 0) > 1)
      let pullProblem: PullProblem | null = null
      const pull = work.lookup
        ? await readPull(work.lookup).catch((err: unknown) => {
            pullProblem = {
              reason: err instanceof Error ? err.message : "GitHub could not be read",
              setup: isRecord(err) && err.setup === true,
            }
            return null
          })
        : null
      const pr = pull && { ...pull, gates: gatesAt(gates, pull) }
      return agentOf(
        match,
        facts,
        work,
        pr,
        new Date(),
        heldReason(held, pr?.url ?? null),
        pullProblem,
        ownRepo,
      )
    }),
  )
  forgetScans(new Set(sessions.transcripts.values()))
  return {
    agents,
    liveProblem,
    managersOrder,
    pullsQueue: {
      parked: (queueRead?.parked ?? []).map((entry) => ({ pr: entry.pr })),
      queue: (queueRead?.queue ?? []).map((entry) => ({
        etaMerge: entry.etaMerge ?? null,
        item: entry.item ?? null,
        pr: entry.pr,
      })),
      repo: ownRepo,
    },
    roster: {
      backlog: queued(roster, org.owner.name),
      // a fixture stack's folder sits in this machine's checkout, a real path a screenshot would carry
      path: readsLive() ? path : FIXTURE_ROSTER,
      problem,
      updatedAt: roster?.updatedAt ?? null,
    },
    sockets,
    workQueue,
  }
}
