// The gates a Playground PR passes before it merges. Every verdict comment is posted as the repo's owner (the reviewer posts through gh under the owner's account), so a gate reads only comments posted under that account, and nobody else can post a verdict and merge. CI is GitHub's own check runs on the head, REQUIRED_CHECKS among them.

import { atHead, verdictsOf, type GateName, type Verdict } from "@packages/config/verdicts"

import { bodyRefusal } from "./body"
import type { Lost } from "./lost"

export { atHead, verdictOf, verdictsOf } from "@packages/config/verdicts"
export type { GateName, Verdict } from "@packages/config/verdicts"

// One GitHub check on the head, as `gh pr view --json statusCheckRollup` gives it: a check run (status, conclusion) or a commit status (state).
export type Check = {
  conclusion?: string | null
  context?: string
  detailsUrl?: string
  name?: string
  startedAt?: string
  state?: string
  status?: string
  workflowName?: string
}

export type Comment = { author: string; body: string; createdAt: string; url?: string }

export type Gate = { detail: string; name: string; ok: boolean }

// GitHub's jobs every head runs (.github/workflows), by their check names: pr:merge needs each one's newest run on the head finished and passed.
export const REQUIRED_CHECKS = ["Audit, Lint, and Build", "test"]

// The workflow each required check's job runs in, so a run that finished without that job reads apart from one GitHub has yet to start.
const REQUIRED_WORKFLOWS: Record<string, string> = {
  "Audit, Lint, and Build": "auto-check-build",
  test: "auto-test",
}

export type PrFacts = {
  // How many commits canary has that the head lacks: 0 is up to date, NaN when gh's answer did not read as a count.
  aheadBy: number
  // Who opened the PR (its GitHub login).
  author: string
  base: string
  // The PR's description, held to the PR template the Changelog reads, its Evidence naming each changed doc; absent only in a test, which skips that gate.
  body?: string
  // origin/canary now, and the tree of the head merged with it (git merge-tree --write-tree); mergeTree is null when they conflict or it could not be read.
  canary: string
  mergeTree: string | null
  // The files the head's merge with canary conflicts in, null when it merged clean or could not be read; left out where no merge was read.
  conflicts?: string[] | null
  // The head's GitHub checks; none while GitHub Actions is off.
  checks: Check[]
  comments: Comment[]
  draft: boolean
  files: string[]
  head: string
  // Why held-prs.json holds the PR, or null when it is not held.
  held: string | null
  // The lines canary added that a merge of canary into the PR dropped from git's own merge and the squash still lacks, or why they could not be read (lostLines).
  lost: Lost
  // The PR's number.
  n: number
  owner: string
  // Each PR the body says it is stacked on (parentsOf) with its GitHub state, or why the state did not read; set wherever the body is read, [] for none.
  parents?: { n: number; state: string }[]
  // The pr template's own placeholders, read at the head, which the body gate refuses in the body's prose; left out in a test, which skips that check.
  placeholders?: string[]
  state: string
  // The body's bare all-caps tokens that no file at the head holds outside the gate's own folders (unfoundTokens), which the body gate refuses; left out in a test, which skips that check.
  unfound?: string[]
}

export const BASE = "canary"

// Pure: the newest verdict per gate at the head, from the owner's comments only, oldest comment first so a later one replaces an earlier.
export function verdictsAt(facts: Pick<PrFacts, "comments" | "head" | "owner">) {
  const newest = new Map<GateName, Verdict>()
  const sorted = [...facts.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const comment of sorted) {
    if (comment.author.toLowerCase() !== facts.owner.toLowerCase()) continue
    for (const verdict of verdictsOf(comment.body))
      if (atHead(verdict.at, facts.head))
        newest.set(verdict.gate, { ...verdict, createdAt: comment.createdAt, url: comment.url })
  }
  return newest
}

const PASSED = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"])

// gitGuardian: the head must carry a GitGuardian check (a head it never started on ran no secret scan); outsideAuthor: the one login besides the repo's owner whose PR may merge, named on purpose.
export type GateOptions = { gitGuardian?: boolean; outsideAuthor?: string }

// Pure: the author gate: the repo's owner (every factory session pushes as it), or the login --outside-author names, since an outside PR's code would run here and merges only on a lead's go.
function authorGate(facts: PrFacts, outsideAuthor?: string): Gate {
  const by = facts.author.toLowerCase()
  if (by === facts.owner.toLowerCase())
    return { detail: `by ${facts.author}`, name: "author", ok: true }
  if (outsideAuthor && by === outsideAuthor.toLowerCase()) {
    return { detail: `by ${facts.author}, named by --outside-author`, name: "author", ok: true }
  }
  return {
    detail: `by ${facts.author}, not ${facts.owner}: an outside PR merges only on a lead's go, with --outside-author ${facts.author}`,
    name: "author",
    ok: false,
  }
}

export const isGitGuardian = (check: Check): boolean =>
  /^GitGuardian\b/i.test(check.name ?? check.context ?? "")

// Pure: each check's newest run, keyed by workflow and name (a commit status by context), since a rerun or a close and reopen leaves older runs in the rollup; a run not yet finished counts as newest, since a queued one reads no start time.
export function newestRuns(checks: Check[]): Check[] {
  const rank = (check: Check) =>
    check.state === undefined && check.status?.toUpperCase() !== "COMPLETED"
      ? "~"
      : (check.startedAt ?? "")
  const newest = new Map<string, Check>()
  for (const check of checks) {
    const key =
      check.state === undefined
        ? `run ${check.workflowName ?? ""} ${check.name ?? ""}`
        : `status ${check.context ?? ""}`
    const held = newest.get(key)
    if (!held || rank(check) > rank(held)) newest.set(key, check)
  }
  return [...newest.values()]
}

// Pure: the run id of a required check's workflow once every job it ran passed, its check still missing: GitHub ended the run without creating the job, and a rerun brings it; null while a job is unfinished or red, or none ran. The largest id is the newest run's, since a second run on the head with fewer shards leaves the first run's extra shard listed.
function endedRun(checks: Check[], name: string): string | null {
  const jobs = checks.filter((check) => check.workflowName === REQUIRED_WORKFLOWS[name])
  const done = (check: Check) =>
    check.status?.toUpperCase() === "COMPLETED" && PASSED.has(check.conclusion?.toUpperCase() ?? "")
  if (!jobs.length || !jobs.every(done)) return null
  const run = Math.max(
    ...jobs.map((job) => Number(/\/actions\/runs\/(\d+)\//.exec(job.detailsUrl ?? "")?.[1] ?? 0)),
  )
  return run > 0 ? String(run) : null
}

// Pure: the head's GitHub checks as one gate: every check's newest run finished and passed, each required name among them. gitGuardian refuses a head with no GitGuardian check.
export function ciGate(
  all: Check[],
  { gitGuardian = false, required = [] }: { gitGuardian?: boolean; required?: string[] } = {},
): Gate {
  const checks = newestRuns(all)
  const missing = required.filter((name) => !checks.some((check) => check.name === name))
  for (const name of missing) {
    const run = endedRun(checks, name)
    if (run)
      return {
        detail: `no ${name} check on the head, though every job of its ${REQUIRED_WORKFLOWS[name]} run passed: GitHub ended that run without creating it; rerun it with \`gh run rerun ${run}\``,
        name: "ci",
        ok: false,
      }
  }
  if (missing.length > 0)
    return {
      detail: `no ${missing.join(" or ")} check on the head yet: GitHub runs it on every push`,
      name: "ci",
      ok: false,
    }
  if (gitGuardian && !checks.some(isGitGuardian)) {
    return {
      detail:
        "no GitGuardian check on the head: it never started, so no secret scan ran; close and reopen the PR to start it on this head, which keeps its review and go; push again only if it has not started about 10 minutes after the reopen, which needs a fresh review and go",
      name: "ci",
      ok: false,
    }
  }
  if (checks.length === 0) return { detail: "no checks reported", name: "ci", ok: true }
  const bad = checks.filter((check) =>
    check.state !== undefined
      ? check.state.toUpperCase() !== "SUCCESS"
      : check.status?.toUpperCase() !== "COMPLETED" ||
        !PASSED.has(check.conclusion?.toUpperCase() ?? ""),
  )
  if (bad.length === 0) {
    const count = `${checks.length} check${checks.length === 1 ? "" : "s"}`
    return { detail: `${count} passed`, name: "ci", ok: true }
  }
  const names = bad.map((check) => {
    const name = check.name ?? check.context ?? "a check"
    const how =
      check.state ?? (check.status?.toUpperCase() === "COMPLETED" ? check.conclusion : check.status)
    return `${name} ${String(how ?? "unknown").toLowerCase()}`
  })
  return { detail: `not passed: ${names.join(", ")}`, name: "ci", ok: false }
}

// Pure: the up-to-date gate: a head with everything on canary, or one behind it that merges with canary clean; a conflict needs canary merged in, which takes a fresh run and review at the new head.
function upToDate(facts: PrFacts): Gate {
  const sha7 = facts.head.slice(0, 7)
  const name = "up to date"
  if (!Number.isInteger(facts.aheadBy))
    return { detail: `could not read how far ${BASE} is ahead of ${sha7}`, name, ok: false }
  if (facts.aheadBy === 0) return { detail: `${sha7} has everything on ${BASE}`, name, ok: true }
  const behind = `${BASE} has ${facts.aheadBy} commit${facts.aheadBy === 1 ? "" : "s"} ${sha7} lacks`
  return facts.mergeTree
    ? {
        detail: `${behind}; it merges clean with ${BASE} ${facts.canary.slice(0, 7)}`,
        name,
        ok: true,
      }
    : {
        detail: `${behind} and conflicts with it; merge ${BASE} in, then the new head needs its checks and a 5/5`,
        name,
        ok: false,
      }
}

// Pure: the gate that refuses a squash deleting lines canary added that a merge of canary into the PR dropped from git's own merge, as a merge with -s ours does while canary still reads as merged in.
export function keepsCanary(lost: Lost): Gate {
  const name = "keeps canary"
  if (typeof lost === "string")
    return { detail: `could not read what the squash deletes: ${lost}`, name, ok: false }
  if (lost.length === 0)
    return {
      detail: `no merge of ${BASE} into the PR dropped a line git's own merge keeps`,
      name,
      ok: true,
    }
  const byFile = new Map<string, Set<string>>()
  for (const line of lost)
    byFile.set(line.path, (byFile.get(line.path) ?? new Set()).add(line.commit.slice(0, 7)))
  const where = [...byFile]
    .map(([path, merges]) => `${path} (dropped in ${[...merges].join(", ")})`)
    .join(", ")
  const redo = lost.every((line) => line.path.startsWith("scripts/hooks/bundled/"))
    ? `these are bundles rebuilt inside the merge: redo that merge plainly (reset the branch to the commit before it, then git merge origin/${BASE}), commit the merge with ${BASE}'s bundles as they are, then run \`bun run hooks:bundle\` and commit the rebuild on its own, and re-gate`
    : `redo that merge plainly (reset the branch to the commit before it, then git merge origin/${BASE}, resolving each conflict with both sides' meaning) and re-apply your change in a commit of your own, or keep the lines, and re-gate`
  return {
    detail: `the squash would delete ${lost.length} line${lost.length === 1 ? "" : "s"} ${BASE} added that a merge of ${BASE} dropped, which git's own merge keeps: ${where}. Only a squash that holds them again clears this, so a new merge of ${BASE} leaves them lost: ${redo}`,
    name,
    ok: false,
  }
}

// Pure: whether PR n at its head merges clean with canary now, and as which tree, read from git merge-tree's exit code, never its tree line alone (a merge judged clean by its tree line was a conflict).
export function mergeLine(
  n: number,
  facts: Pick<PrFacts, "canary" | "conflicts" | "head" | "mergeTree">,
): string {
  const at = `#${n} at ${facts.head.slice(0, 7)}`
  const canary = `${BASE} ${facts.canary.slice(0, 7)}`
  if (facts.mergeTree)
    return `${at} merges clean with ${canary} as tree ${facts.mergeTree.slice(0, 7)}`
  if (facts.conflicts?.length)
    return `${at} conflicts with ${canary} in ${facts.conflicts.join(", ")}`
  return `${at}: its merge with ${canary} could not be read`
}

// Pure: whether the merge path marks this draft ready: the owner's own draft whose every other gate in gates passes.
export const marksReady = (facts: PrFacts, gates: Gate[]): boolean =>
  facts.draft &&
  facts.author.toLowerCase() === facts.owner.toLowerCase() &&
  gates.every((gate) => gate.ok || gate.name === "ready")

// Pure: gates with the ready gate passed, saying why, for a draft the merge path marks ready.
export const withReadyDraft = (facts: PrFacts, gates: Gate[], detail: string): Gate[] =>
  marksReady(facts, gates)
    ? gates.map((gate) => (gate.name === "ready" ? { ...gate, detail, ok: true } : gate))
    : gates

// Pure: the PRs a body says it is stacked on, each `Stacked on #N` (playbook DISPATCH.md's stack line) in any case, a list of them on one line (`#N and #M`, `#N, #M`) included, once each, in order.
export const parentsOf = (body: string): number[] => [
  ...new Set(
    [...body.matchAll(/\bstacked on (#\d+(?:(?:\s*(?:,|&|\band\b)\s*|\s+)#\d+)*)/gi)].flatMap(
      (match) => [...(match[1] ?? "").matchAll(/#(\d+)/g)].map((number) => Number(number[1])),
    ),
  ),
]

// Pure: the parent gate, since a review scores a stacked PR's own lines alone and its squash would land an unmerged parent's: every parent the body names must read MERGED in facts.parents; a parent open, closed unmerged or never read refuses, and a body naming none meets no gate.
function parentGate(facts: PrFacts): Gate | undefined {
  const declared = parentsOf(facts.body ?? "")
  if (declared.length === 0) return undefined
  const parents = declared.map((n) => ({
    n,
    state: facts.parents?.find((parent) => parent.n === n)?.state ?? "never read",
  }))
  const why = parents.flatMap(({ n, state }) =>
    state === "MERGED"
      ? []
      : state === "OPEN"
        ? [`stacked on #${n}, still open: merge #${n} first`]
        : state === "CLOSED"
          ? [
              `stacked on #${n}, closed without merging: once its lines land another way, remove the \`Stacked on #${n}\` line from the body (no push)`,
            ]
          : [
              `stacked on #${n}, whose state could not be read (${state}); if #${n} is not a PR, reword the \`Stacked on\` line`,
            ],
  )
  if (why.length > 0) return { detail: why.join("; "), name: "parent", ok: false }
  return {
    detail: `stacked on ${declared.map((n) => `#${n}`).join(", ")}, merged`,
    name: "parent",
    ok: true,
  }
}

// Pure: the newest review on the head.
function reviewGate(facts: PrFacts): Gate {
  const review = verdictsAt(facts).get("review")
  if (review)
    return {
      detail: review.pass ? review.text : `newest review is not a pass: ${review.text}`,
      name: "review",
      ok: review.pass,
    }
  return {
    detail: `missing 5/5 review (## ReviewBot · round <n>: 5/5 at <sha7>) at ${facts.head.slice(0, 7)} from ${facts.owner}`,
    name: "review",
    ok: false,
  }
}

// Pure: every gate, in the order a PR meets them, each saying what it found at the head. The PR merges only when every one is ok.
export function gatesOf(facts: PrFacts, { gitGuardian, outsideAuthor }: GateOptions = {}): Gate[] {
  const gates: Gate[] = [
    {
      detail: facts.state === "OPEN" ? "open" : `the PR is ${facts.state.toLowerCase()}`,
      name: "open",
      ok: facts.state === "OPEN",
    },
    authorGate(facts, outsideAuthor),
    {
      detail: facts.held ?? "not in held-prs.json",
      name: "held",
      ok: facts.held === null,
    },
    {
      detail: facts.draft ? "the PR is a draft; mark it ready first" : "ready for review",
      name: "ready",
      ok: !facts.draft,
    },
    {
      detail:
        facts.base === BASE
          ? `into ${BASE}`
          : `into ${facts.base}, not ${BASE}; pr:merge merges only into ${BASE}`,
      name: "base",
      ok: facts.base === BASE,
    },
  ]
  const parent = parentGate(facts)
  if (parent) gates.push(parent)
  gates.push(upToDate(facts), keepsCanary(facts.lost))
  gates.push(ciGate(facts.checks, { gitGuardian, required: REQUIRED_CHECKS }))
  if (facts.body !== undefined) {
    const why = bodyRefusal(facts.body, facts.files, {
      placeholders: facts.placeholders,
      unfound: facts.unfound,
    })
    gates.push(
      why
        ? { detail: `${why}; fix the body (no push)`, name: "body", ok: false }
        : { detail: "the PR template", name: "body", ok: true },
    )
  }
  gates.push(reviewGate(facts))
  return gates
}
