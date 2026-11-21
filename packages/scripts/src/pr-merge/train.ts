// The merge queue's readers: the order open PRs merge in, which of them pass every pr:merge gate at their head (merge-on-ready, ready.ts, takes the first), and the forecast, which squashes each open PR onto canary and the PRs ahead of it as GitHub's squash merge will, so a conflict with a PR still in review shows before that PR lands.
import { join } from "node:path"

import { BASE, gatesOf, withReadyDraft, type PrFacts } from "./gates"
import { gatesPath, type GateRead } from "./gates-file"
import {
  factsOf,
  fetchHead,
  gateOptions,
  gh,
  lockRootOf,
  MARKED,
  parseMergeTree,
  queuePath,
  readQueue,
  realLockRoot,
  repoOf,
  runGh,
  runGit,
  type Run,
} from "./merge"

export { queuePath, readQueue } from "./merge"

// One PR squashed onto the step before: its head, the commit that squashes it, and that commit's tree.
export type Step = { commit: string; head: string; n: number; tree: string }

// A PR whose squash conflicts: what it conflicted with (canary, or the PR ahead of it), and the files.
export type Drop = { files: string[]; head: string; n: number; why: string; with: string }

export type Candidate = { facts: PrFacts; n: number }

// Pure: a PR's place in the merge queue, any PR it does not list after every one it does, by number.
const placeIn = (queue: number[]) => (n: number) => {
  const i = queue.indexOf(n)
  return i === -1 ? queue.length + n : i
}

const IDENTITY = ["-c", "user.name=pr:train", "-c", "user.email=pr-train@localhost"]

const git1 = async (git: Run, args: string[]): Promise<string> => {
  const result = await git(args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

// git merge-tree --write-tree of two commits: the tree, or the files that conflict.
async function mergeTree(
  git: Run,
  ours: string,
  theirs: string,
): Promise<{ tree: string } | { files: string[] }> {
  const result = await git(["merge-tree", "--write-tree", "--name-only", ours, theirs])
  const merged = parseMergeTree(result)
  if (!merged) {
    throw new Error(
      `git merge-tree ${ours} ${theirs} exited ${result.code}: ${result.stderr.trim()}`,
    )
  }
  return merged.clean ? { tree: merged.tree } : { files: merged.files }
}

// Squashes each PR's head onto canary and the steps before it, in order, as GitHub's squash merge will; a PR whose merge conflicts is dropped, naming what it conflicts with: canary itself, else each PR ahead of it whose head alone conflicts with it.
export async function chainOf(
  git: Run,
  canary: string,
  picks: { head: string; n: number }[],
  id: string,
): Promise<{ dropped: Drop[]; steps: Step[] }> {
  const steps: Step[] = []
  const dropped: Drop[] = []
  let base = canary
  for (const pick of picks) {
    const merged = await mergeTree(git, base, pick.head)
    if ("files" in merged) {
      const alone = await mergeTree(git, canary, pick.head)
      const ahead: string[] = []
      if ("tree" in alone) {
        for (const step of steps) {
          if ("files" in (await mergeTree(git, step.head, pick.head))) ahead.push(`#${step.n}`)
        }
      }
      const against = "files" in alone ? BASE : ahead.join(", ") || "the PRs ahead of it"
      dropped.push({
        files: merged.files,
        head: pick.head,
        n: pick.n,
        why: `conflicts with ${against} in ${merged.files.join(", ")}`,
        with: against,
      })
      continue
    }
    const message = `train ${id}: #${pick.n} at ${pick.head.slice(0, 7)}`
    const commit = await git1(git, [
      ...IDENTITY,
      "commit-tree",
      merged.tree,
      "-p",
      base,
      "-m",
      message,
    ])
    steps.push({ commit, head: pick.head, n: pick.n, tree: merged.tree })
    base = commit
  }
  return { dropped, steps }
}

export type TrainOptions = { repo?: string }

// What runs outside GitHub: git in this checkout, the folder the lock lives in, the merge queue, the gates file merge-on-ready writes, and how a PR's facts are read (factsOf, unless a test hands its own).
export type TrainLocal = {
  facts?: (run: Run, repo: string, n: number) => Promise<PrFacts>
  gates?: string
  git?: Run
  lockRoot?: string
  queue?: string
}

// The script whose runs are real; anywhere else, as under test, a run needs a git stub and a scratch lockRoot.
const REAL_RUNS = ["train-cli.ts"]

export function resolve(local: TrainLocal, main = Bun.main) {
  const git = local.git ?? runGit
  const lockRoot = local.lockRoot ?? lockRootOf()
  const cli = REAL_RUNS.some((file) => main === join(import.meta.dir, file))
  if (!cli && (!local.git || lockRoot === realLockRoot())) {
    throw new Error("pr:train under test needs a git stub and a scratch lockRoot")
  }
  return {
    cli,
    facts: local.facts ?? ((run: Run, repo: string, n: number) => factsOf(run, repo, n, git)),
    // a test writes the gates file only where it names one
    gates: local.gates ?? (cli ? gatesPath() : null),
    git,
    lockRoot,
    queue: local.queue ?? queuePath(),
  }
}

// The repo owner's open PRs into canary, by number, drafts only when asked; a PR by anyone else never merges on ready.
async function openPrs(run: Run, repo: string, drafts = false): Promise<number[]> {
  const owner = repo.split("/")[0]?.toLowerCase() ?? ""
  const listed = await gh(run, [
    "pr",
    "list",
    "-R",
    repo,
    "--base",
    BASE,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,author,isDraft",
    "--jq",
    ".[] | {author: .author.login, draft: .isDraft, n: .number} | tojson",
  ])
  return listed
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { author: string; draft: boolean; n: number })
    .filter((pr) => pr.author.toLowerCase() === owner && (drafts || !pr.draft))
    .map((pr) => pr.n)
}

// canary now, after fetching it and each PR's head (fetchHead: its pull ref, else its branch at that head).
async function fetchHeads(git: Run, heads: Head[]) {
  await git1(git, ["fetch", "--quiet", "origin", BASE])
  for (const { branch, head, n } of heads) await fetchHead(git, n, head, branch)
  return git1(git, ["rev-parse", `origin/${BASE}`])
}

// Pure: PR numbers in the merge queue's order, then any others by number.
export const sortByQueue = (ns: number[], queue: number[]): number[] => {
  const place = placeIn(queue)
  return [...ns].sort((a, b) => place(a) - place(b))
}

type Head = { branch: string; head: string; n: number }

const headOf = async (run: Run, repo: string, n: number): Promise<Head> => {
  const view = JSON.parse(
    await gh(run, ["pr", "view", String(n), "-R", repo, "--json", "headRefName,headRefOid"]),
  ) as { headRefName: string; headRefOid: string }
  return { branch: view.headRefName, head: view.headRefOid, n }
}

export type Forecast = { canary: string; conflicts: Drop[]; order: number[] }

// The early merge test: each open PR, gated or not and drafts included, merged onto canary and every PR ahead of it in the queue, so a conflict with a PR still in review is found and fixed before that PR lands rather than after. Writes nothing on GitHub.
export async function forecast(
  { repo }: TrainOptions,
  run: Run = runGh,
  local: TrainLocal = {},
): Promise<Forecast> {
  const { git, queue } = resolve(local)
  const name = await repoOf(run, repo)
  const order = sortByQueue(await openPrs(run, name, true), await readQueue(queue))
  const picks = await Promise.all(order.map((n) => headOf(run, name, n)))
  const canary = await fetchHeads(git, picks)
  const { dropped } = await chainOf(git, canary, picks, "forecast")
  return { canary, conflicts: dropped, order }
}

// The owner's open PRs whose every pr:merge gate passes at their head, in merge-queue order, a draft that passes but for ready included, why each other one is held, and each read PR's failing gates at its head (reads, which gates.json keeps): a PR whose facts cannot be read (a failed fetch, a pr template the head cannot show) is held with that error and has no read, so one such PR never ends the pass.
export async function gatedOf(
  run: Run,
  name: string,
  facts: (run: Run, repo: string, n: number) => Promise<PrFacts>,
  queue: string,
): Promise<{ held: { n: number; why: string }[]; order: Candidate[]; reads: GateRead[] }> {
  const options = await gateOptions(name)
  const held: { n: number; why: string }[] = []
  const order: Candidate[] = []
  const reads: GateRead[] = []
  for (const n of sortByQueue(await openPrs(run, name, true), await readQueue(queue))) {
    let read: PrFacts
    try {
      read = await facts(run, name, n)
    } catch (error) {
      held.push({
        n,
        why: `not gated: facts unreadable (${(error as Error).message})`,
      })
      continue
    }
    const failed = withReadyDraft(read, gatesOf(read, options), MARKED).filter((gate) => !gate.ok)
    reads.push({ failed: failed.map((gate) => gate.name), head: read.head, n })
    if (failed.length === 0) order.push({ facts: read, n })
    else
      held.push({
        n,
        why: `not gated: ${failed.map((gate) => (gate.name === "held" ? `held (${gate.detail})` : gate.name)).join(", ")}`,
      })
  }
  return { held, order, reads }
}
