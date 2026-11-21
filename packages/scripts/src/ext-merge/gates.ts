// The gates an extension repository's PR passes before ext:merge lands it on the default branch, which the sync renders into every session's store: no-extension-repo-write lets a session push a branch there, and this is the one way that branch reaches the default.

import { ciGate, verdictsAt, type Check, type Comment, type Gate } from "../pr-merge/gates"

export type ExtFacts = {
  author: string
  base: string
  checks: Check[]
  comments: Comment[]
  // The head's branch lives in another repository (a fork).
  crossRepo: boolean
  defaultBranch: string
  draft: boolean
  // The repository is one no-extension-repo-write guards.
  guarded: boolean
  head: string
  // GitHub's word on the merge: MERGEABLE, CONFLICTING or UNKNOWN.
  mergeable: string
  repo: string
  // The roster's reviewer sessions that list the PR, none of them a session that lists it as its own.
  reviewers: string[]
  state: string
  // The GitHub account every session posts as, whose comments alone carry a verdict.
  viewer: string
  // The workflow files at the head or on the default branch, whichever holds more.
  workflows: number
}

export type Agent = { kind?: string; name?: string; pr?: string | null; prs?: string[] }

// Pure: the reviewer sessions whose roster row lists the PR, less any session that lists it as its own work, so an author's own 5/5 never counts.
export function reviewersOf(agents: Agent[], url: string): string[] {
  const lists = (agent: Agent) => agent.pr === url || (agent.prs ?? []).includes(url)
  const checker = (agent: Agent) => agent.kind === "reviewer" || agent.kind === "tester"
  const authors = new Set(agents.filter((a) => lists(a) && !checker(a)).map((a) => a.name))
  return agents
    .filter((a) => a.kind === "reviewer" && lists(a) && a.name && !authors.has(a.name))
    .map((a) => a.name as string)
}

// Pure: the checks gate: every check at the head finished and passed; a head with none passes only when the repository has no workflow file, since one whose workflows have not reported yet is still pending. Once one check has reported, the rest are not matched to the workflow files on purpose, since a workflow that never runs on a pull request would hold the PR for good.
function checksGate(facts: ExtFacts): Gate {
  if (facts.checks.length > 0) return ciGate(facts.checks)
  return facts.workflows === 0
    ? { detail: "no checks, and the repository has no workflow file", name: "ci", ok: true }
    : {
        detail: `no check at the head yet, though the repository has ${facts.workflows} workflow file${facts.workflows === 1 ? "" : "s"}: wait for them to report`,
        name: "ci",
        ok: false,
      }
}

// Pure: every gate, in the order a PR meets them; the PR merges only when every one is ok.
export function gatesOf(facts: ExtFacts): Gate[] {
  const sha7 = facts.head.slice(0, 7)
  const review = verdictsAt({
    comments: facts.comments,
    head: facts.head,
    owner: facts.viewer,
  }).get("review")
  return [
    {
      detail: facts.guarded
        ? `${facts.repo} is an extension repository`
        : `${facts.repo} is not an extension repository no-extension-repo-write guards: merge it the way its own repository does`,
      name: "extension",
      ok: facts.guarded,
    },
    {
      detail: facts.state === "OPEN" ? "open" : `the PR is ${facts.state.toLowerCase()}`,
      name: "open",
      ok: facts.state === "OPEN",
    },
    {
      detail:
        facts.author.toLowerCase() === facts.viewer.toLowerCase()
          ? `by ${facts.author}`
          : `opened by ${facts.author}, not ${facts.viewer}, the account every session pushes as`,
      name: "author",
      ok: facts.author.toLowerCase() === facts.viewer.toLowerCase(),
    },
    {
      detail: facts.draft ? "a draft: mark it ready with gh pr ready" : "ready",
      name: "ready",
      ok: !facts.draft,
    },
    {
      detail:
        facts.base === facts.defaultBranch
          ? `it merges into ${facts.base}`
          : `it merges into ${facts.base}, not the default branch ${facts.defaultBranch}`,
      name: "base",
      ok: facts.base === facts.defaultBranch,
    },
    {
      detail: facts.crossRepo
        ? "its head is a branch of another repository"
        : "its head is a branch of the repository",
      name: "head",
      ok: !facts.crossRepo,
    },
    review
      ? {
          detail: review.pass ? review.text : `newest review is not a pass: ${review.text}`,
          name: "review",
          ok: review.pass,
        }
      : {
          detail: `missing 5/5 review (## ReviewBot · round <n>: 5/5 at <sha7>) at ${sha7} from ${facts.viewer}`,
          name: "review",
          ok: false,
        },
    facts.reviewers.length > 0
      ? { detail: `reviewed by ${facts.reviewers.join(", ")}`, name: "independent", ok: true }
      : {
          detail:
            "no reviewer session other than its author lists the PR in the roster: spawn one for the PR, whose 5/5 is the one that counts",
          name: "independent",
          ok: false,
        },
    checksGate(facts),
    {
      detail:
        facts.mergeable === "MERGEABLE"
          ? "it merges clean"
          : facts.mergeable === "CONFLICTING"
            ? `it conflicts with ${facts.defaultBranch}: merge it in, then the new head needs its checks and a 5/5`
            : "GitHub has not worked out whether it merges clean yet: run it again in a minute",
      name: "mergeable",
      ok: facts.mergeable === "MERGEABLE",
    },
  ]
}
