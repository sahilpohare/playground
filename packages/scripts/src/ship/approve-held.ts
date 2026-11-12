// ship:approve-held <n>: approves the held CI runs of the ship PR alone, the pull_request runs at its head whose conclusion is action_required, which the bot that opened the draft leaves waiting for an approval; prints each run it approved, or none held.

import { gh, repoOf, runGh, type Run } from "../pr-merge/merge"

export type HeldFacts = { base: string; head: string; sha: string; state: string }

export type HeldRun = {
  conclusion: string
  event: string
  headSha: string
  id: number
}

// Pure: the one reason the ship PR's held runs may not be approved, or null when they may.
export function heldRefusals(facts: HeldFacts): string | null {
  if (facts.state !== "open" || facts.head !== "canary" || facts.base !== "main")
    return `pr: it is ${facts.state} with head ${facts.head} into ${facts.base}: ship:approve-held approves an open ship PR, head canary into main`
  return null
}

// Pure: the held runs of a list, a pull_request run at this head waiting for its approval; GitHub reads one status completed with conclusion action_required.
export function heldRuns(runs: HeldRun[], sha: string): HeldRun[] {
  return runs.filter(
    (r) => r.headSha === sha && r.event === "pull_request" && r.conclusion === "action_required",
  )
}

// Approves each held run of ship PR n, one POST per run, and returns the lines the CLI prints.
export async function approveHeld(run: Run, repo: string, n: number): Promise<string[]> {
  const pr = JSON.parse(await gh(run, ["api", `repos/${repo}/pulls/${n}`])) as {
    base: { ref: string }
    head: { ref: string; sha: string }
    state: string
  }
  const facts: HeldFacts = {
    base: pr.base.ref,
    head: pr.head.ref,
    sha: pr.head.sha,
    state: pr.state,
  }
  const refusal = heldRefusals(facts)
  if (refusal) throw new Error(refusal)
  const listed = JSON.parse(
    await gh(run, [
      "api",
      `repos/${repo}/actions/runs?event=pull_request&head_sha=${facts.sha}&per_page=100&status=action_required`,
    ]),
  ) as {
    workflow_runs?: {
      conclusion: string
      event: string
      head_sha: string
      id: number
      status: string
    }[]
  }
  const held = heldRuns(
    (listed.workflow_runs ?? []).map((r) => ({
      conclusion: r.conclusion,
      event: r.event,
      headSha: r.head_sha,
      id: r.id,
    })),
    facts.sha,
  )
  if (held.length === 0) return ["none held"]
  const lines: string[] = []
  for (const heldRun of held) {
    await gh(run, ["api", "-X", "POST", `repos/${repo}/actions/runs/${heldRun.id}/approve`])
    lines.push(`approved run ${heldRun.id}`)
  }
  return lines
}

if (import.meta.main) {
  const [n] = process.argv.slice(2)
  if (!n || !/^\d+$/.test(n)) {
    console.error("usage: bun run ship:approve-held <n>")
    process.exit(1)
  }
  try {
    const repo = await repoOf(runGh)
    for (const line of await approveHeld(runGh, repo, Number(n))) console.log(line)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
