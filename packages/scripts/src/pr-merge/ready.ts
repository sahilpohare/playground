// Merge-on-ready: a PR ready before another merges straight away, so each gated PR, in queue order, merges at once through pr:merge when every gate passes, GitHub's checks at its head included. One merge a call. Each call first writes every read PR's failing gates to gates.json, which the Dashboard's Ready reads.
import { gatesOf, marksReady } from "./gates"
import { gatesFile, writeGates } from "./gates-file"
import { gateOptions, prMerge, repoOf, runGh, type Outcome, type Run } from "./merge"
import { gatedOf, resolve, type TrainLocal } from "./train"
import { TYPES_BUDGET_MS } from "./types"

export type Readied = {
  merged?: { n: number; sha: string; why: string }
  refused: { n: number; why: string }[]
  unreadable: { n: number; why: string }[]
}

// merge: how one PR merges, given what is left of the call's types budget: pr:merge's own path unless a test hands its own.
export type ReadyLocal = TrainLocal & {
  merge?: (n: number, typesBudgetMs: number) => Promise<Outcome>
}

const refusal = (outcome: Outcome): string =>
  outcome.kind === "locked"
    ? `the merge lock is held by ${outcome.holder}`
    : outcome.kind === "failed"
      ? outcome.reason
      : `has not passed ${outcome.gates
          .filter((gate) => !gate.ok)
          .map((gate) => gate.name)
          .join(", ")}`

export async function mergeReady(
  { repo }: { repo?: string },
  run: Run = runGh,
  local: ReadyLocal = {},
): Promise<Readied> {
  const { facts, gates, queue } = resolve(local)
  const name = await repoOf(run, repo)
  const options = await gateOptions(name)
  // every types gate in one call shares one budget, so a call that refuses several PRs still ends inside the merge train's 900s
  const deadline = Date.now() + TYPES_BUDGET_MS
  const merge =
    local.merge ??
    ((n: number, typesBudgetMs: number) => prMerge(n, { repo: name }, run, { typesBudgetMs }))
  const { held, order, reads } = await gatedOf(run, name, facts, queue)
  // a file it cannot write costs the Dashboard's read, never this cycle's merge
  if (gates)
    await writeGates(gates, gatesFile(name, reads, new Date().toISOString())).catch(
      (err: unknown) =>
        console.error(
          `pr:train ready: gates.json not written: ${err instanceof Error ? err.message : String(err)}`,
        ),
    )
  const unreadable = held.filter(({ why }) => why.startsWith("not gated: facts unreadable"))
  const readied: Readied = { refused: [], unreadable }
  for (const { facts: pr, n } of order) {
    const all = gatesOf(pr, options)
    // a draft is marked ready on every other gate, as gatedOf does
    const marked = marksReady(pr, all)
    const failing = all.filter((gate) => !gate.ok && !(marked && gate.name === "ready"))
    if (failing.length > 0) continue
    const why = all.find((gate) => gate.name === "ci")?.detail ?? ""
    const outcome = await merge(n, deadline - Date.now())
    if (outcome.kind === "merged") {
      readied.merged = { n, sha: outcome.sha, why }
      return readied
    }
    readied.refused.push({ n, why: refusal(outcome) })
  }
  return readied
}

// What pr:train ready prints: its lines, each unreadable PR as an error line, and exit 1 when one was unreadable and nothing merged, so the merge train's log, which keeps a failing run, keeps the error as canary's throw did
export const readyReport = (readied: Readied) => ({
  code: readied.unreadable.length > 0 && !readied.merged ? 1 : 0,
  errors: readied.unreadable.map(({ n, why }) => `✗ #${n} ${why}`),
  lines: [
    readied.merged
      ? `Merged #${readied.merged.n} on ready at ${readied.merged.sha}: ${readied.merged.why}`
      : "Nothing merged on ready.",
    ...readied.refused.map((r) => `- #${r.n} refused: ${r.why}`),
  ],
})
