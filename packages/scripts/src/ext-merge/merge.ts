import { type Check, type Gate } from "../pr-merge/gates"
import { commentsOf, gh, runGh, squashAt, type Run } from "../pr-merge/merge"
import { gatesOf, reviewersOf, type Agent, type ExtFacts } from "./gates"

export type Outcome =
  | { gates: Gate[]; kind: "explained" | "refused" }
  | { gates: Gate[]; kind: "failed"; reason: string }
  | { gates: Gate[]; kind: "merged"; sha: string }

// How many workflow files .github/workflows holds at a ref, 0 when the folder does not exist there.
async function workflowsAt(run: Run, repo: string, ref: string): Promise<number> {
  const result = await run([
    "api",
    `repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
    "--jq",
    '[.[] | select(.type == "file" and (.name | test("\\\\.ya?ml$")))] | length',
  ])
  if (result.code === 0 && /^\d+$/.test(result.stdout.trim())) return Number(result.stdout.trim())
  if (result.code !== 0 && /HTTP 404/.test(result.stderr)) return 0
  throw new Error(
    `could not read the workflow files of ${repo} at ${ref}: gh exited ${result.code}: ${result.stderr.trim()}`,
  )
}

// Everything the gates read about one PR, from gh, the guarded repositories and the roster.
export async function factsOf(
  run: Run,
  repo: string,
  n: number,
  repos: Set<string>,
  agents: Agent[],
): Promise<ExtFacts> {
  const view = JSON.parse(
    await gh(run, [
      "pr",
      "view",
      String(n),
      "-R",
      repo,
      "--json",
      "author,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,state,statusCheckRollup,url",
    ]),
  ) as {
    author: { login: string } | null
    baseRefName: string
    headRefOid: string
    isCrossRepository: boolean
    isDraft: boolean
    mergeable: string
    state: string
    statusCheckRollup: Check[] | null
    url: string
  }
  const [defaultBranch, viewer, comments] = await Promise.all([
    gh(run, ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]),
    gh(run, ["api", "user", "--jq", ".login"]),
    commentsOf(run, repo, n),
  ])
  const [atHead, onDefault] = await Promise.all([
    workflowsAt(run, repo, view.headRefOid),
    workflowsAt(run, repo, defaultBranch),
  ])
  return {
    author: view.author?.login ?? "",
    base: view.baseRefName,
    checks: view.statusCheckRollup ?? [],
    comments,
    crossRepo: view.isCrossRepository,
    defaultBranch,
    draft: view.isDraft,
    guarded: repos.has(repo.toLowerCase()),
    head: view.headRefOid,
    mergeable: view.mergeable,
    repo,
    reviewers: reviewersOf(agents, view.url),
    state: view.state,
    viewer,
    workflows: Math.max(atHead, onDefault),
  }
}

// Reads the gates at the PR's head and, when every one passes, squash-merges it at exactly that head.
export async function extMerge(
  repo: string,
  n: number,
  {
    agents,
    explain = false,
    repos,
    run = runGh,
  }: { agents: Agent[]; explain?: boolean; repos: Set<string>; run?: Run },
): Promise<Outcome> {
  const facts = await factsOf(run, repo, n, repos, agents)
  const gates = gatesOf(facts)
  if (explain) return { gates, kind: "explained" }
  if (gates.some((gate) => !gate.ok)) return { gates, kind: "refused" }
  const squashed = await squashAt(run, repo, n, facts.head)
  return "sha" in squashed
    ? { gates, kind: "merged", sha: squashed.sha }
    : { gates, kind: "failed", reason: squashed.reason }
}
