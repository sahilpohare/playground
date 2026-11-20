import type { Agent, CiState, Pull, PullProblem, PullsQueue } from "@api/hono"

export type PullGroup = { pulls: PullRow[]; repo: string }

// A pull's row: the queued ones carry their place in the merge queue (1 is next) and when it is expected to merge; `unpaired` marks a queued pull no agent works on, so the board read nothing of it but its number and the queue's words.
export type PullRow = Pull & { etaMerge?: string | null; place?: number; unpaired?: boolean }

// The tab's sections, in merge order: the queued ones, then the open ones, then the parked ones, then the merged and closed.
export type PullSection = { groups: PullGroup[]; kind: "open" | "parked" | "queued" | "settled" }

const REPO_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//

const CI_WORDS: Record<CiState, string> = {
  failing: "Failing",
  none: "None",
  passing: "Passing",
  pending: "Pending",
}

const STATE_WORDS = { closed: "Closed", merged: "Merged", open: "Open" } as const

// Pure: each column's words for one pull request in the Pull requests tab: its repository, its state (an open draft reads Draft), the ReviewBot score at its head, its CI and the approvals it still needs; an unpaired row's are Unknown.
export function pullFields(pr: PullRow) {
  const repo = REPO_RE.exec(pr.url)?.[1] ?? pr.url
  if (pr.unpaired) {
    const unknown = "Unknown"
    return { approvals: unknown, ci: unknown, repo, score: unknown, state: unknown }
  }
  return {
    approvals: pr.approvals > 0 ? `${pr.approvals} needed` : "None needed",
    ci: CI_WORDS[pr.ci],
    repo,
    score: pr.score ?? "None",
    state: pr.state === "open" && pr.draft ? "Draft" : STATE_WORDS[pr.state],
  }
}

const newestFirst = (a: PullRow, b: PullRow) =>
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || b.number - a.number

const byRepo = (pulls: PullRow[], sort: (a: PullRow, b: PullRow) => number): PullGroup[] => {
  const groups = new Map<string, Map<string, PullRow>>()
  for (const pr of pulls) {
    const repo = pullFields(pr).repo
    const group = groups.get(repo) ?? new Map<string, PullRow>()
    group.set(pr.url, pr)
    groups.set(repo, group)
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, group]) => ({ pulls: [...group.values()].sort(sort), repo }))
}

// Pure: whether a queued row's expected merge time has passed, so the cell says overdue rather than wording a past time as time left.
export function etaOverdue(etaMerge: string | null | undefined, now: number): boolean {
  if (!etaMerge) return false
  const at = Date.parse(etaMerge)
  return !Number.isNaN(at) && at < now
}

// Pure: the pull requests an agent's view lists, in four sections in merge order, each group a repository, A to Z, the newest update first, the queued ones in their queue order. A pull is queued while the merge queue of its own repository names it and it is still open, and parked while that queue parks it; queued rows carry their place (1 is next) and expected merge. The queue names its repository, so a same-numbered pull of another repository matches nothing. The dispatcher's view lists every pull across the board, once each; any other agent's the one the board pairs it with (its branch's when it works on one of its own, else its roster's `pr`), whatever its state. The board reads one pull request an agent, so that is all an agent's view can list; the dispatcher's also lists each queued pull no agent works on, unpaired, titled by its queue item, while the queue names its repository.
export function viewPulls(
  agents: Agent[],
  sessionId: string,
  dispatcher: boolean,
  queue?: PullsQueue,
): PullSection[] {
  const pulls = dispatcher
    ? agents.flatMap((a) => (a.pr ? [a.pr] : []))
    : agents.flatMap((a) => (a.sessionId === sessionId && a.pr ? [a.pr] : []))
  const inQueueRepo = (pr: Pull) => queue !== undefined && pullFields(pr).repo === queue.repo
  const places = new Map<number, { etaMerge: string | null; place: number }>()
  ;(queue?.queue ?? []).forEach((entry, at) =>
    places.set(entry.pr, { etaMerge: entry.etaMerge, place: at + 1 }),
  )
  const parked = new Set((queue?.parked ?? []).map((entry) => entry.pr))
  const queued: PullRow[] = []
  const open: PullRow[] = []
  const held: PullRow[] = []
  const settled: PullRow[] = []
  const seen = new Set<string>()
  for (const pr of pulls) {
    if (seen.has(pr.url)) continue
    seen.add(pr.url)
    const place = inQueueRepo(pr) ? places.get(pr.number) : undefined
    if (pr.state !== "open") settled.push(pr)
    else if (place) queued.push({ ...pr, ...place })
    else if (inQueueRepo(pr) && parked.has(pr.number)) held.push(pr)
    else open.push(pr)
  }
  if (dispatcher && queue?.repo) {
    queue.queue.forEach((entry, at) => {
      const url = `https://github.com/${queue.repo}/pull/${entry.pr}`
      if (seen.has(url)) return
      seen.add(url)
      queued.push({
        approvals: 0,
        ci: "none",
        conflicts: false,
        draft: false,
        etaMerge: entry.etaMerge,
        gates: null,
        head: "",
        number: entry.pr,
        place: at + 1,
        queued: true,
        reviewed: false,
        round: null,
        score: null,
        state: "open",
        tester: null,
        title: entry.item ?? "Queued pull",
        unpaired: true,
        updatedAt: null,
        url,
        verdict: null,
      })
    })
  }
  const sections: PullSection[] = []
  const section = (
    kind: PullSection["kind"],
    list: PullRow[],
    sort: (a: PullRow, b: PullRow) => number = newestFirst,
  ) => {
    const groups = byRepo(list, sort)
    if (groups.length > 0) sections.push({ groups, kind })
  }
  section("queued", queued, (a, b) => (a.place ?? 0) - (b.place ?? 0))
  section("open", open)
  section("parked", held)
  section("settled", settled)
  return sections
}

// Pure: why the pull requests an agent's view lists could not be read: on the dispatcher's view, which lists every agent's, any agent's failure; on any other, its own alone, so another agent's failure never reads as its own.
export function pullProblemOf(
  agents: Agent[],
  sessionId: string,
  dispatcher: boolean,
): PullProblem | null {
  const failed = agents.filter((a) => a.pullProblem && (dispatcher || a.sessionId === sessionId))
  return failed[0]?.pullProblem ?? null
}
