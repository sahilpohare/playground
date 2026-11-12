"use client"

import type { Agent, Entry, Worker } from "@api/hono"
import type { RosterKind } from "@packages/config/kinds"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"

import { labelParts, labelText, setRosterKinds, type LabelFacts } from "@/lib/agent-label"
import { apiClient, unwrap } from "@/lib/api/client"
import {
  agentGroup,
  GROUP_OF,
  GROUP_ORDER,
  nestCheckers,
  rowTitle,
  shownEta,
  sinName,
  STATUS_RANK,
  type EntriesListener,
  type SessionTask,
} from "@/lib/dashboard"
import { modelName } from "@/lib/model-label"
import { whenWords } from "@/lib/ops"
import {
  checkedOf,
  lightOf,
  ownPr,
  PR_TONES,
  prTone,
  stateWords,
  WAIT_WORDS,
  type LightFacts,
  type PrTone,
  type ShownState,
  type Wait,
} from "@/lib/status-icons"
import { fullTime } from "@/lib/time"

export const AGENTS_QUERY_KEY = ["dashboard", "agents"] as const

// Branches and pull requests move slowly, so they are re-read this often; live state arrives over the socket in between.
export const AGENTS_REFRESH_MS = 30_000

// A read this fresh is not repeated when the window regains focus; the socket keeps the rows live meanwhile.
export const AGENTS_STALE_MS = 10_000

// Sessions message each other many times a minute, so the reads a message asks for are folded into at most one per this span.
export const AGENTS_MESSAGE_COALESCE_MS = 5_000

export async function fetchAgents() {
  const { data, error } = await unwrap(apiClient.v1.agents.$get())
  if (error) throw new Error(error.message)
  setRosterKinds(data.agents)
  return data
}

// A message to anyone may be a report to the dispatcher (sent by name or to its uds address), so it is the API, which knows the dispatcher's addresses, that decides.
export const sentMessage = (entries: Entry[]): boolean =>
  entries.some((entry) => entry.kind === "tool" && entry.tool === "SendMessage")

// Runs at once, then at most once per waitMs: calls inside the wait fold into one run when it ends, so the newest call is never lost.
export function coalesce(run: () => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  const open = () => {
    timer = setTimeout(() => {
      timer = null
      if (!pending) return
      pending = false
      run()
      open()
    }, waitMs)
  }
  const call = () => {
    if (timer) {
      pending = true
      return
    }
    run()
    open()
  }
  call.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = false
  }
  return call
}

// The sessions as the board knows them: when one starts, ends, is renamed or changes directory, the roster join and its branch need reading again.
export const sessionsKey = (workers: Worker[] | null): string =>
  (workers ?? [])
    .map((w) => `${w.sessionId}:${w.name}:${w.cwd}`)
    .sort()
    .join("|")

// An agent's group, as the sidebar groups its session.
const groupOf = (agent: Agent): number => GROUP_ORDER.indexOf(agentGroup(agent))

type Placed = { agent: Agent; place: number }

// Pure: the API's agents in the board's order, each with the socket's state for its session: one the socket no longer lists is down. A live agent's place is its session's position in workers, which the dashboard hands on in orderByStatus's order (managers by byManagerOrder; the rest by the state each row's icon draws, then byRowKey, each light settled), so the table moves when the sidebar does; a down one follows them all, in the API's order. workers is null until the socket's first list, when the API's states stand and rank each group, in the API's order within a status.
export function liveAgents(agents: Agent[], workers: Worker[] | null): Agent[] {
  const ranks = new Map((workers ?? []).map((w, i) => [w.sessionId, { i, light: w.light }]))
  // The sidebar's own order: managers, workers, runners, others, and in each, by place. Before the socket's first list there is no board to follow, so the API's states rank each group by status first.
  const compareAgents = (a: Placed, b: Placed): number =>
    groupOf(a.agent) - groupOf(b.agent) ||
    (workers ? 0 : STATUS_RANK[a.agent.state] - STATUS_RANK[b.agent.state]) ||
    a.place - b.place
  return agents
    .map((agent, at): Placed => {
      const live = agent.sessionId ? ranks.get(agent.sessionId) : undefined
      const place = live ? live.i : ranks.size + at
      if (!workers || !agent.sessionId) return { agent, place }
      return { agent: { ...agent, state: live?.light ?? "down" }, place }
    })
    .sort(compareAgents)
    .map(({ agent }) => agent)
}

// Pure: what an agent is doing in a few words, as the sidebar's rowTitle words a session: its roster title, else its first ask, else for the dispatcher (which has no task of its own) what it does.
export const doingOf = (agent: Agent, dispatcher: boolean): string =>
  agent.title ?? agent.task ?? (dispatcher ? "Hands each task to a worker" : "No task yet")

// How a status reads at a glance: quiet for what is stopped, parked or merely idle, else the text's own; the state's colour is its icon's, never the words'.
export type StatusTone = "muted" | "normal"

const QUIET: ReadonlySet<ShownState> = new Set([
  "down",
  "ended",
  "idle",
  "parked",
  "unknown",
  "usage-limit",
])

// An open decision or draft a live session posted to Playground's Inbox and depends on: since no factory session blocks on the owner (playbook's ask rule), this is how one shows it waits, linked to the item.
export type InboxWait = { id: string; ref: number } | null

// What the board knows of an agent beyond the API's read: its live session (its tasks, its newest reply, when its transcript last changed), its light once held, and whether a reviewer or tester of its pull request is at work.
export type LiveFacts = {
  checkers?: boolean
  light?: Agent["state"]
  worker?: Worker | null
}

// Pure: whether a worker's reviewers and testers, by their held lights, are a check it waits on: one at work, or one stuck. The sidebar and the Agents table both ask this.
export const checksOpen = (lights: Agent["state"][]): boolean =>
  lights.some((light) => light === "working" || light === "needs-you")

// Pure: what an idle agent still waits on, the most telling first (Wait): a reviewer or tester at work, its pull request's CI or merge queue, a running subagent or background process, an inbox decision it posted.
export function waitsOf(agent: Agent, live: LiveFacts = {}, waitsOn: InboxWait = null): Wait[] {
  const pr = ownPr(agent)
  const open = pr?.state === "open"
  const running = (kind: SessionTask["kind"]) =>
    (live.worker?.tasks ?? []).some((task) => task.kind === kind && task.state === "running")
  const waits: [Wait, boolean][] = [
    ["checks", Boolean(live.checkers)],
    ["ci", open && pr.ci === "pending"],
    ["queue", open && pr.queued && pr.approvals === 0],
    ["helper", running("agent")],
    ["job", running("process")],
    ["inbox", waitsOn !== null],
  ]
  return waits.filter(([, on]) => on).map(([wait]) => wait)
}

// Pure: an agent's facts for lightOf, its light the held one when the board has it.
export function factsOf(
  agent: Agent,
  now: number,
  live: LiveFacts = {},
  waitsOn: InboxWait = null,
  dispatcher = false,
): LightFacts {
  const held = agent.state === "down" ? "down" : (live.light ?? agent.state)
  // a runner's job runs as a background task while its session idles, so it reads Working (the plan: "Runners use Working while their job runs, Stuck and Down")
  const runs =
    agent.role === "runner" && (live.worker?.tasks ?? []).some((task) => task.state === "running")
  const light = (held === "idle" || held === "unknown") && runs ? "working" : held
  // No progress reads the session's own work alone: a quiet runner whose job runs is not hung
  const active = light === held ? (live.worker?.lastActiveAt ?? null) : null
  return {
    checked: checkedOf(agent),
    dispatcher,
    ended: agent.status === "ended",
    failed: live.worker?.failed ?? false,
    idleFor: active ? now - Date.parse(active) : null,
    light,
    parked: agent.parked,
    pr: ownPr(agent),
    rosterParked: agent.status === "parked",
    usageLimit: live.worker?.usageLimit ?? null,
    waits: waitsOf(agent, live, waitsOn),
  }
}

// Pure: what the hover adds to an agent's state: what else it waits on and its review round, how many approvals it still needs, or why it is parked.
function detailOf(state: ShownState, facts: LightFacts): string | null {
  const { pr, waits = [] } = facts
  if (state === "waiting") {
    const round = waits[0] === "checks" && pr?.round ? `review round ${pr.round}` : null
    const rest = waits.slice(1).map((wait) => WAIT_WORDS[wait])
    return [round, ...rest].filter(Boolean).join(" · ") || null
  }
  if ((state === "approval" || state === "approvals") && pr)
    return `${pr.approvals} approval${pr.approvals === 1 ? "" : "s"} still needed`
  if (state === "parked") return facts.parked ?? null
  if (state === "usage-limit") {
    const limit = facts.usageLimit
    const at = limit?.resets ?? (limit?.resetsAt ? fullTime(limit.resetsAt) : null)
    return at ? `resets ${at}` : null
  }
  if (state === "ready" && pr?.tester === "pass") return "tester PASS"
  return null
}

export type Status = {
  detail: string | null
  state: ShownState
  text: string
  tone: StatusTone
}

// Pure: one agent's state (lightOf), its words and what its hover adds. dispatcher says the agent is Playground, whose Stuck alone reads Waiting on you.
export function statusParts(
  agent: Agent,
  now: number,
  waitsOn: InboxWait = null,
  dispatcher = false,
  live: LiveFacts = {},
): Status {
  const facts = factsOf(agent, now, live, waitsOn, dispatcher)
  const state = lightOf(facts)
  return {
    detail: detailOf(state, facts),
    state,
    text: stateWords(state, facts),
    tone: QUIET.has(state) ? "muted" : "normal",
  }
}

// Pure: the state's words, as the Dashboard's Status column reads (Working).
export function statusOf(
  agent: Agent,
  now: number,
  waitsOn: InboxWait = null,
  dispatcher = false,
  live: LiveFacts = {},
): { text: string; tone: StatusTone } {
  const { text, tone } = statusParts(agent, now, waitsOn, dispatcher, live)
  return { text, tone }
}

export type AgentsBoard = Awaited<ReturnType<typeof fetchAgents>>

// A reader's own slice of the board, which React Query draws again only when that slice changes (its structural sharing keeps an unchanged slice's object across reads): the peer addresses alone, or with them what a label needs of every agent, so a stream's hundreds of names hold still through a read that moved only a session's activity.
export const socketsOf = (board: AgentsBoard) => board.sockets
export const labelBoard = (board: AgentsBoard) => ({
  agents: board.agents.map(
    ({ branchTicket, kind, name, pr, task, ticket, title, worker }): LabelFacts => ({
      branchTicket,
      kind,
      name,
      pr: pr && { number: pr.number },
      task,
      ticket,
      title,
      worker,
    }),
  ),
  sockets: board.sockets,
})

// The board as last read, for a part of the page that only names agents (a stream's recipients): it reads whatever the page holds and fetches only when nothing has been read yet, leaving re-reads to useAgents; select narrows what it reads to the slice it draws.
export const useAgentsBoard = <T = AgentsBoard>(select?: (board: AgentsBoard) => T) =>
  useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: fetchAgents,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    select,
  })

// The Orchestrators rows' dragged order, written whole, or forgotten so A to Z by title returns.
export async function saveManagersOrder(names: string[]) {
  const { error } = await unwrap(apiClient.v1.managers.order.$post({ json: { names } }))
  if (error) throw new Error(error.message)
}

export async function resetManagersOrder() {
  const { error } = await unwrap(apiClient.v1.managers.order.$delete())
  if (error) throw new Error(error.message)
}

// The dashboard's agents, live: the API's read joined to the socket's state. The API is read again when a session starts, ends, is renamed or moves (not on the socket's first list, which the first read already joined), when any session sends a message (it may be a report; at most once per AGENTS_MESSAGE_COALESCE_MS), and every half minute.
export function useAgents(
  subscribe: (listener: EntriesListener) => () => void,
  workers: Worker[] | null,
  enabled = true,
) {
  const queryClient = useQueryClient()
  const query = useQuery({
    enabled,
    queryKey: AGENTS_QUERY_KEY,
    queryFn: fetchAgents,
    refetchInterval: AGENTS_REFRESH_MS,
    staleTime: AGENTS_STALE_MS,
  })
  const sessions = sessionsKey(workers)
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (workers === null) return
    if (seen.current !== null && seen.current !== sessions) {
      void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY })
    }
    seen.current = sessions
  }, [queryClient, sessions, workers])
  useEffect(() => {
    const reread = coalesce(
      () => void queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY }),
      AGENTS_MESSAGE_COALESCE_MS,
    )
    const unsubscribe = subscribe((_sessionId, entries) => {
      if (sentMessage(entries)) reread()
    })
    return () => {
      unsubscribe()
      reread.cancel()
    }
  }, [queryClient, subscribe])
  return { ...query, agents: query.data ? liveAgents(query.data.agents, workers) : null }
}

// A sidebar row's words in parts: the first line is the row's one truncating title, and the second, cut from its end and never the state (#i546), is a line of its tooltip, which holds both whole: the label and the title on the first (`AB-843#8 Reviewer Review it`, a manager's role word alone, `Ops`, and a runner's `Keep the dashboard up · runner` before a ticket or a pull request; a worker, like a session with no kind, keeps its pull request, its ticket and the title, `AB-843#8 Chat scroll fix`); the model, then the effort and the state on the second, every part after a ` · `. The session's name and its time left show in the row's tooltip alone.
export type RowLines = {
  // what the row's tooltip adds to the state (lightOf's detail)
  detail: string | null
  // the effort the newest reply ran with, between the model and the state in the tooltip
  effort: string | null
  // the time left, the tooltip's alone (timeLeft)
  eta: string | null
  // its kind (labelParts), which closes its label: its role word after the ticket and the pull request, else after the title
  kind: RosterKind | null
  // the model's name, without the effort
  model: string | null
  pr: number | null
  // the row's one icon
  shown: ShownState
  state: string
  ticket: string | null
  title: string
  // the pull request's colour, on its number
  tone: PrTone | null
  // when an AI runner runs, a part of its own after the state in the tooltip
  when: string | null
}

// Pure: the time left a worker shows, on its row's tooltip: none once merged (its pull request carried, so it is off the clock) or paused on a usage limit, else shownEta by its held light, a fixing run on its pull request counting as work.
export function timeLeft(agent: Agent, now: number, live: LiveFacts = {}): string | null {
  const state = lightOf(factsOf(agent, now, live))
  if (state !== "working" && state !== "fixing" && state !== "stuck") return null
  return shownEta({ ...agent, state: state === "stuck" ? "needs-you" : "working" }, now)
}

// Pure: a live session's row: its one state (statusParts) once the board has read its agent, else what its own light says. light is its held light; checkers says a reviewer or tester nested under it is at work, and waitsOn an inbox item it posted. label, a dispatcher's Alpha or Bravo (dispatcherRowLabel), names the row in place of its title, over its state alone, with no model after it. lead is the agent a checker's work belongs to, whose ticket and pull request its label takes.
export function rowLines(
  worker: Worker,
  agent: Agent | null,
  now: number,
  checkers = false,
  waitsOn: InboxWait = null,
  light: Worker["light"] = worker.light,
  label?: string,
  lead: Agent | null = null,
): RowLines {
  const dispatcher = worker.role === "dispatcher"
  const agentView = agent ?? agentOfWorker(worker)
  const status = statusParts(agentView, now, waitsOn, dispatcher, {
    checkers,
    light,
    worker,
  })
  const model = label ? null : modelName(worker.model)
  // a dispatcher named by its label keeps no session name (#i520), else its state keeps its name (Inbox #i493: "dispatcher keeps Playground; only managers drop names"), and an AI runner's ends with when it runs
  const name = dispatcher && !label ? sinName(worker) : null
  const when = worker.role === "runner" ? rosterWhen(agent?.schedule ?? null) : null
  return {
    detail: status.detail,
    effort: model ? (worker.effort ?? null) : null,
    eta: timeLeft(agentView, now, { checkers, light, worker }),
    ...(label
      ? {
          kind: null,
          pr: agent?.pr?.number ?? null,
          ticket: agent?.ticket ?? null,
          title: label,
        }
      : firstLineOf(agent, rowTitle(worker), lead)),
    model,
    shown: status.state,
    state: [name, status.text].filter(Boolean).join(" · "),
    tone: agent ? prTone(agent) : null,
    when,
  }
}

// A row's first line in parts: its label's (labelParts), so the pull request's number can take its colour, and the title with any leading copy of the ticket or the pull request dropped.
export type FirstLine = Pick<RowLines, "kind" | "pr" | "ticket" | "title">

// Pure: a row's first line from its agent and its title. lead is the agent a checker's work belongs to; a manager's is its role word alone, with no title; an agent the board has not read, or one with no kind, keeps its own pull request and ticket.
export function firstLineOf(agent: Agent | null, title: string, lead: Agent | null): FirstLine {
  const parts = agent ? labelParts(agent, (name) => (lead?.name === name ? lead : undefined)) : null
  if (parts && "title" in parts) return { kind: null, pr: null, ticket: null, title: parts.title }
  const named = parts && "kind" in parts ? parts : null
  const pr = named ? named.pr : (agent?.pr?.number ?? null)
  const ticket = named ? named.ticket : ticketOf(agent)
  return {
    // a worker's row drops its role word, which every Subagents row would repeat, in its line and its tooltip alike; labelOf keeps it for the System page and AgentLink
    kind: named && named.kind !== "worker" ? named.kind : null,
    pr,
    ticket,
    title: stripTitle(title, [
      pr != null ? `#${pr}` : null,
      ticket,
      ticket && pr != null ? `${ticket}#${pr}` : null,
    ]),
  }
}

// Pure: when an AI runner runs, from the roster's schedule: `always`, else a 5-field cron, in words; null with none.
const rosterWhen = (schedule: string | null): string | null =>
  schedule ? whenWords(schedule === "always" ? { always: true } : { cron: schedule }) : null

// Pure: when an agent runs, for the System table's status, as its sidebar row says it: an AI runner's schedule in words, null for any other role.
export const runnerWhen = (agent: Pick<Agent, "role" | "schedule">): string | null =>
  agent.role === "runner" ? rosterWhen(agent.schedule) : null

// Pure: a live session as an agent before the board has read it: no pull request, roster or report yet.
const agentOfWorker = (worker: Worker): Agent => ({
  branch: null,
  branchTicket: null,
  eta: worker.eta,
  kind: null,
  lastActivityAt: worker.lastActiveAt,
  name: worker.name,
  parked: null,
  pr: null,
  pullProblem: null,
  report: null,
  role: worker.role === "dispatcher" ? "manager" : worker.role,
  schedule: null,
  sessionId: worker.sessionId,
  state: worker.light,
  status: null,
  task: worker.task,
  ticket: null,
  title: worker.title,
  worker: null,
  workspace: worker.workspace?.ref ?? null,
})

const PG_TICKET = /^PG-(\d+)$/i

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Pure: the title with a copy of an id the row already shows gone from its start or its end (a row read `AB-110#7 #<n> touched…`), a PG ticket's number counting as its issue's `#N` and a trailing one in brackets too, so the drawn row and its hover read alike.
export const stripTitle = (title: string, ids: (string | null)[]): string => {
  const shown = ids.flatMap((id) => {
    if (!id) return []
    const issue = PG_TICKET.exec(id)?.[1]
    return issue ? [id, `#${issue}`] : [id]
  })
  let out = title.trim()
  for (let moved = true; moved;) {
    moved = false
    for (const id of shown) {
      const next = out
        .replace(new RegExp(`^${escaped(id)}(?:[\\s:]+|$)`, "i"), "")
        .replace(new RegExp(`(?:^|\\s+)\\(?${escaped(id)}\\)?$`, "i"), "")
        .trim()
      if (next !== out) {
        out = next
        moved = true
      }
    }
  }
  return out
}

// Pure: the label a row's first line leads with (labelText: `AB-843#8 Reviewer`), or null when it has none, where the title leads and the kind follows it.
export const rowLabel = (lines: FirstLine): string | null =>
  lines.kind ? labelText({ kind: lines.kind, pr: lines.pr, ticket: lines.ticket }) : null

// Pure: whether a row's label has a ticket or a pull request to lead with (`AB-843#8 Reviewer`).
export const labelLeads = (lines: FirstLine): boolean => rowLabel(lines) !== null

// Pure: a row's first line as plain text, as the sidebar draws it.
export const firstLine = (lines: FirstLine): string => {
  const label = rowLabel(lines)
  if (label) return `${label} ${lines.title}`
  if (lines.kind) return `${lines.title} · ${lines.kind}`
  return [`${lines.ticket ?? ""}${lines.pr ? `#${lines.pr}` : ""}`, lines.title]
    .filter(Boolean)
    .join(" ")
}

// Pure: a row's lines as plain text, for its tooltip, with its pull request's colour in words and as the class its number takes, and what the state's hover adds. The model and effort read before the status.
export const rowText = (
  lines: RowLines,
): { first: string; prClass: string | null; prWords: string | null; second: string } => {
  const model = lines.model ? (lines.effort ? `${lines.model} ${lines.effort}` : lines.model) : null
  return {
    first: firstLine(lines),
    prClass: lines.tone ? PR_TONES[lines.tone].className : null,
    prWords: lines.tone ? PR_TONES[lines.tone].words : null,
    second: [model, lines.state, lines.when, lines.detail].filter(Boolean).join(" · "),
  }
}

// Pure: the ticket a row with no kind leads with: the roster's (the ticket the agent works on), else the one its branch names (the API's branchTicket: pg-<n>-sort is PG-<n>).
export const ticketOf = (agent: Agent | null): string | null =>
  agent?.ticket ?? agent?.branchTicket ?? null

// Each state's place in Subagents, AI Runners and Other, in lightOf's order of urgency, with two moves: the usage-limit pause ranks with the idle rows, since it waits on the reset, not on a person, and what is over (Done, Merged, Ended) goes last, then Down, which only the Agents table lists.
export const SHOWN_RANK: Record<ShownState, number> = {
  stuck: 0,
  failing: 1,
  "no-progress": 2,
  fixing: 3,
  working: 4,
  waiting: 5,
  approval: 6,
  approvals: 6,
  ready: 7,
  parked: 8,
  "usage-limit": 9,
  unknown: 9,
  idle: 9,
  done: 10,
  merged: 11,
  ended: 12,
  down: 13,
}

type RowKey = { pr: number | null; ticket: string | null; title: string }

const TICKET = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/

// Pure: a ticket as its team key and its number, so AB-9 comes before AB-262.
const ticketParts = (ticket: string): [string, number] => {
  const match = TICKET.exec(ticket)
  return match ? [match[1]!.toUpperCase(), Number(match[2])] : [ticket.toUpperCase(), 0]
}

// Pure: two rows of one state in order: rows with a ticket first, by its team key A to Z then its number, then the PR; then rows with a PR alone, by its number; then rows with neither, A to Z by title.
export function byRowKey(a: RowKey, b: RowKey): number {
  const tier = (key: RowKey) => (key.ticket ? 0 : key.pr !== null ? 1 : 2)
  const pr = (key: RowKey) => key.pr ?? Infinity
  if (tier(a) !== tier(b)) return tier(a) - tier(b)
  if (a.ticket && b.ticket) {
    const [teamA, numberA] = ticketParts(a.ticket)
    const [teamB, numberB] = ticketParts(b.ticket)
    if (teamA !== teamB) return teamA.localeCompare(teamB)
    if (numberA !== numberB) return numberA - numberB
  }
  return pr(a) - pr(b) || a.title.localeCompare(b.title)
}

// Pure: where a manager sits in its group, each by its role word (Builder, Planner): the dispatcher first, then the dragged order the API keeps, then the rest A to Z by roster title, an untitled one after the titled by its name, so a new manager shows with no write.
export function byManagerOrder(
  a: { dispatcher: boolean; name: string; title: string | null },
  b: { dispatcher: boolean; name: string; title: string | null },
  stored: readonly string[],
): number {
  if (a.dispatcher !== b.dispatcher) return a.dispatcher ? -1 : 1
  const at = (name: string) => {
    const i = stored.indexOf(name)
    return i === -1 ? stored.length : i
  }
  if (at(a.name) !== at(b.name)) return at(a.name) - at(b.name)
  if (Boolean(a.title) !== Boolean(b.title)) return a.title ? -1 : 1
  return (a.title ?? a.name).localeCompare(b.title ?? b.name)
}

// Pure: the board in the order every view shows it, so the sidebar and the Agents table move together. The groups go in GROUP_ORDER; Dispatchers in the order the API names them (dispatchers), as the sidebar draws them; Orchestrators by byManagerOrder; Subagents, AI Runners and Other go by the state each row's icon draws (rowLines on its held light, its reviewers and testers counted as a check it waits on), a row waiting on you (at a card, or on an inbox item it posted) ranking with Stuck, then by byRowKey.
export function orderByStatus(
  workers: Worker[],
  agents: Agent[] | null,
  held: ReadonlyMap<string, Worker["light"]>,
  waiting: ReadonlySet<string>,
  now: number,
  managersOrder: readonly string[] = [],
  dispatchers: readonly string[] = [],
): Worker[] {
  const agentOf = (w: Worker) => agents?.find((a) => a.sessionId === w.sessionId) ?? null
  const light = (w: Worker) => held.get(w.sessionId) ?? w.light
  const checking = new Set(
    nestCheckers(
      workers.filter((w) => GROUP_OF[w.role] === "Subagents"),
      {
        kind: (w) => agentOf(w)?.kind ?? null,
        name: (w) => w.name,
        pr: (w) => agentOf(w)?.pr?.number ?? null,
        state: (w) => (waiting.has(w.sessionId) ? "needs-you" : light(w)),
        worker: (w) => agentOf(w)?.worker ?? null,
      },
    )
      .filter(({ members }) => checksOpen(members.map(light)))
      .map(({ lead }) => lead.sessionId),
  )
  const placed = workers.map((w, at) => {
    const lines = rowLines(w, agentOf(w), now, checking.has(w.sessionId), null, light(w))
    return {
      at,
      group: GROUP_ORDER.indexOf(GROUP_OF[w.role]),
      key: { pr: lines.pr, ticket: lines.ticket, title: lines.title },
      manager: {
        dispatcher: w.role === "dispatcher",
        name: w.name,
        title: w.title ?? agentOf(w)?.title ?? null,
      },
      managers: GROUP_OF[w.role] === "Dispatchers" || GROUP_OF[w.role] === "Orchestrators",
      rank: waiting.has(w.sessionId) ? 0 : SHOWN_RANK[lines.shown],
      w,
    }
  })
  return placed
    .toSorted(
      (a, b) =>
        a.group - b.group ||
        (a.managers
          ? byManagerOrder(
              a.manager,
              b.manager,
              a.manager.dispatcher ? dispatchers : managersOrder,
            ) || a.at - b.at
          : a.rank - b.rank || byRowKey(a.key, b.key) || a.at - b.at),
    )
    .map(({ w }) => w)
}
