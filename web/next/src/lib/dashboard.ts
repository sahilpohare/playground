"use client"

import type { Agent, DashboardFrame, Entry, Worker } from "@api/hono"
import { isEndedStatus, kindOfName, setSessionNames } from "@packages/config/kinds"
import { replaceEqualDeep } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  agentLabel,
  mention,
  roleLabel,
  setDispatcherOrder,
  withoutIdKind,
} from "@/lib/agent-label"
import { apiClient, unwrap } from "@/lib/api/client"
import { config } from "@/lib/config"
import { createWatch, type ActivityFrame, type SessionActivity } from "@/lib/live-activity"

const RECONNECT_MIN_MS = 2000
const RECONNECT_MAX_MS = 30_000
const ENTRY_LIMIT = 400

export type DashboardProblem = { code: string; message: string }

export type EntriesListener = (sessionId: string, entries: Entry[]) => void

// Entries arrive twice for the same step when a live frame races the initial fetch, so they merge by id and keep transcript order, never time order: a message queued mid-turn is written after the step in hand but stamped when it was queued, earlier. newer is later in the transcript than older, but where the two share a step: a new entry goes just after the shared one it follows in newer, or before the first it precedes, and one that shares none goes after older. So a live frame is merged as newer than the steps shown, and a Load older page and the initial fetch as older, the steps shown going over them. keep is how many of the newest stay: the recent window, plus whatever older steps were asked for.
export const mergeEntries = (older: Entry[], newer: Entry[], keep = ENTRY_LIMIT): Entry[] => {
  const merged = [...older]
  let before: Entry[] = []
  let cursor: number | null = null
  for (const entry of newer) {
    const at = merged.findIndex((shown) => shown.id === entry.id)
    if (at >= 0) {
      merged.splice(at, 1, entry)
      if (cursor === null) merged.splice(at, 0, ...before)
      cursor = (cursor === null ? at + before.length : at) + 1
      before = []
    } else if (cursor === null) before.push(entry)
    else merged.splice(cursor++, 0, entry)
  }
  return [...merged, ...before].slice(-keep)
}

const OLDER_PAGE = 100
const EMPTY_HOPS = 5

// Where paging back through a session's older steps stands: idle (more may be there), loading, done (the start of the session is shown), missing (the database has not read that far, or holds no such session) or error.
export type OlderState = "done" | "error" | "idle" | "loading" | "missing"

export type Older = { load: () => void; state: OlderState }

// One session's steps and where paging back through them stands. cursor is the seq the last older page stopped at (null until one loads, and again after a trim, when paging restarts from the oldest step shown); framed names the steps frames brought since the transcript fetch was asked for, null while none is out; keep is how many steps stay; request names the older page in flight, so a reply for another session or an earlier visit is dropped.
export type History = {
  cursor: number | null
  framed: string[] | null
  keep: number
  list: Entry[]
  older: OlderState
  request: number
  sessionId: string | null
}

export const historyOf = (sessionId: string | null): History => ({
  cursor: null,
  framed: null,
  keep: ENTRY_LIMIT,
  list: [],
  older: "idle",
  request: 0,
  sessionId,
})

// Steps from the file tail or the socket. A frame goes after the steps shown; the transcript fetch goes after what was shown when it was asked for (a reconnect's steps from before a gap) and before the frames that landed since, which are newer (framed). Once older steps were loaded, keep grows with what arrives, so the newest never push the loaded history out; a trim that does drop steps means the oldest shown is no longer where paging stood, so paging starts again from it.
export function withSteps(
  history: History,
  entries: Entry[],
  { fetched = false }: { fetched?: boolean } = {},
): History {
  const loaded = history.keep > ENTRY_LIMIT
  const keep = loaded ? history.keep + entries.length : history.keep
  const ids = new Set([...history.list, ...entries].map((entry) => entry.id))
  const since = new Set(history.framed ?? [])
  const list = fetched
    ? mergeEntries(
        mergeEntries(
          history.list.filter((entry) => !since.has(entry.id)),
          entries,
          Infinity,
        ),
        history.list.filter((entry) => since.has(entry.id)),
        keep,
      )
    : mergeEntries(history.list, entries, keep)
  const framed = fetched
    ? null
    : history.framed && [
        ...history.framed,
        ...entries.flatMap((entry) =>
          history.list.some((e) => e.id === entry.id) ? [] : [entry.id],
        ),
      ]
  const trimmed = list.length < ids.size
  // A page still loading was asked for from where paging stood before the trim, so it is dropped too: withOlder applies a reply only while loading.
  return trimmed
    ? { ...history, cursor: null, framed, keep, list, older: "idle" }
    : { ...history, framed, keep, list }
}

// The transcript fetch is out: frames from now on are newer than it.
export const fetchAsked = (history: History): History => ({ ...history, framed: [] })

export type OlderPage =
  | { kind: "error" }
  | { kind: "missing" }
  | { before: number | null; entries: Entry[]; hasMore: boolean; kind: "page" }

// An older page's reply, applied only to the request that asked for it.
export function withOlder(history: History, request: number, page: OlderPage): History {
  if (history.request !== request || history.older !== "loading") return history
  if (page.kind !== "page") return { ...history, older: page.kind }
  const keep = history.keep + page.entries.length
  return {
    ...history,
    cursor: page.before,
    keep,
    list: mergeEntries(page.entries, history.list, keep),
    older: page.hasMore ? "idle" : "done",
  }
}

// An MCP tool reads as its server and tool (`slack-shared · conversations_history`), not the raw `mcp__server__tool` id.
export const toolLabel = (tool: string | null): string => {
  const [prefix, server, ...rest] = (tool ?? "").split("__")
  return prefix === "mcp" && server && rest.length ? `${server} · ${rest.join("__")}` : (tool ?? "")
}

type MdNode = { children?: MdNode[]; type: string; value?: string }

// A message reads line by line, as the terminal shows it: each newline in its text becomes a line break, where markdown would fold it into its paragraph. Code keeps its own lines and is left alone.
export const remarkLineBreaks = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children) return
    node.children = node.children.flatMap((child): MdNode[] => {
      const value = child.type === "text" ? (child.value ?? "") : ""
      if (!/[\r\n]/.test(value)) {
        walk(child)
        return [child]
      }
      return value
        .split(/\r?\n|\r/)
        .flatMap((part, i) => [
          ...(i > 0 ? [{ type: "break" }] : []),
          ...(part ? [{ type: "text", value: part }] : []),
        ])
    })
  }
  walk(tree)
}

// Each failed reconnect waits twice as long, up to 30s, so a socket refused for good (an expired session) does not spend the rate limit every two seconds.
export const reconnectDelay = (failures: number): number =>
  Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, failures))

const ROLE_PREFIX: Partial<Record<Worker["role"], string>> = {
  runner: "runner-",
  worker: "worker-",
}

// A probe is a throwaway test session (probe-<what>, or <id>-probe, read as the API reads it, kindOfName): what it waits on is its spawner's to answer, so it never counts as waiting on you, and it sits in Other.
export const isProbe = (name: string): boolean => kindOfName(name) === "probe"

// The sessions that check a worker's pull request: a reviewer and a tester, by the roster's kind, else by an old name (reviewer-<sin> and tester-<sin>, a suffix allowed: reviewer-gluttony-97) or an <id>-<kind> name (b7k2mq-reviewer).
export type Checker = "reviewer" | "tester"

const CHECKER_NAME = /^(reviewer|tester)-([a-z]+)(?:-(.+))?$/

// Pure: whether a session is a reviewer or a tester, and which: its kind decides when the board has read one, else its name, read as the API reads it (kindOfName).
export const checkerOf = (name: string, kind?: string | null): Checker | null => {
  const read = kind || kindOfName(name)
  return read === "reviewer" || read === "tester" ? read : null
}

// A row's own name without the role its group already says, as its label: Greed under Subagents, Pride under AI Runners, an `<id>-<kind>` name's id alone (K3m9px), as agentLabel reads it, and a manager's or a dispatcher's role word (Ops, Alpha). A reviewer or tester keeps its role, since it shares its worker's sin (ReviewerEnvy). Classification and the detail header keep the full name.
export const sinName = (worker: Worker): string => {
  const role = roleLabel(worker.name)
  if (role) return role
  if (checkerOf(worker.name)) return agentLabel(worker.name)
  const prefix = ROLE_PREFIX[worker.role]
  const name =
    prefix && worker.name.startsWith(prefix) && worker.name.length > prefix.length
      ? worker.name.slice(prefix.length)
      : worker.name
  return mention(withoutIdKind(name))
}

// A row's one line about the work: the triaged title the dispatcher keeps in its roster, else the session's first ask, else for the dispatcher (which has no task of its own) what it does.
export const rowTitle = (worker: Worker): string =>
  worker.title ??
  worker.task ??
  (worker.role === "dispatcher" ? "Hands each task to a worker" : "No task yet")

// The board's groups in order, and the group every role the API gives belongs to, for the sidebar and the dashboard's table alike. A role missing from GROUP_OF, or a group GROUP_ORDER does not list, is a type error, so a new one cannot quietly drop its sessions from the board. Scripts holds no session: it is the ops jobs, which run with no Claude session behind them.
export const GROUP_ORDER = [
  "Dispatchers",
  "Orchestrators",
  "Subagents",
  "AI Runners",
  "Scripts",
  "Other",
] as const

export type GroupLabel = (typeof GROUP_ORDER)[number]

export const GROUP_OF: Record<Worker["role"], GroupLabel> = {
  dispatcher: "Dispatchers",
  manager: "Orchestrators",
  other: "Other",
  runner: "AI Runners",
  worker: "Subagents",
}

// Pure: an agent's group, as GROUP_OF gives its session's: a dispatcher, which the API gives the roster's manager role, by its kind, live or down; a demoted duplicate reads as other, so Other, as its sidebar row.
export const agentGroup = (agent: Pick<Agent, "kind" | "role">): GroupLabel =>
  agent.kind === "dispatcher" && agent.role === "manager" ? "Dispatchers" : GROUP_OF[agent.role]

export type SessionGroup = { label: GroupLabel; sessions: Worker[] }

// The sidebar's session groups in order (Dispatchers for the dispatchers, whose rows the sidebar draws in its header, then ZeroSDK's: Orchestrators for the managers, Subagents for `worker-<sin>`, `reviewer-<sin>`, `tester-<sin>` and any the roster calls a worker, AI Runners for `runner-<sin>` and any the roster calls a runner, Scripts for the ops jobs, which the sidebar fills itself, Other for `probe-<what>` and any other name), each holding its sessions in the board's order (orderByStatus's, as the dashboard hands it on). Dispatchers, Orchestrators, Subagents, AI Runners and Scripts show even when empty; Other only holds strays, so it shows only when one is live.
export const sessionGroups = (sessions: Worker[]): SessionGroup[] =>
  GROUP_ORDER.map((label) => ({
    label,
    sessions: sessions.filter((w) => GROUP_OF[w.role] === label),
  })).filter(({ label, sessions: held }) => label !== "Other" || held.length > 0)

// One worker's row with the reviewers and testers checking its work nested under it. A reviewer or tester whose worker is not there leads a row of its own.
export type Nested<T> = { lead: T; members: T[] }

// Pure: a group label's count, as ZeroSDK's countCell shows it: every session its rows hold, the reviewers and testers nested under them included, so a checker whose worker is gone counts once, under a roster row that is no session.
export const heldCount = <T>(rows: Nested<T>[], isSession: (item: T) => boolean): number =>
  rows.reduce((total, { lead, members }) => total + [lead, ...members].filter(isSession).length, 0)

// Pure: the board's rows with each reviewer and tester (checkerOf, by its kind when known) under its worker: the one the roster's worker key names (else, while that one is not live, only the one its roster pr names); with no key, the one its roster pr names, else the worker its name names whole after its role (tester-sloth-2 under worker-sloth-2), else the one whose pull request a number after its sin names (reviewer-gluttony-97), else the longest worker name its own holds, whatever follows (reviewer-sloth-2-sendtop under worker-sloth-2). Rows keep the board's order, which orderByStatus set on each session's steady light, so a light blinking between steps moves nothing; the one move is up to the waiting rows for a row whose member waits (state is read for needs-you alone, which counts at once under the hold too). A group ranked 0 keeps the given order, so a lead with an open ask keeps its place (Orchestrators, sidebar.md).
export function nestCheckers<T>(
  items: T[],
  facts: {
    // the row's group's rank: rows sort by it first, and a group ranked 0 keeps the given order (Orchestrators, whose chain order holds), the rest by waits (Subagents)
    group?: (item: T) => number
    // its kind, null until the board has read one
    kind: (item: T) => string | null
    name: (item: T) => string
    pr: (item: T) => number | null
    state: (item: T) => SortState
    worker: (item: T) => string | null
  },
): Nested<T>[] {
  const isChecker = (item: T) => checkerOf(facts.name(item), facts.kind(item)) !== null
  const leads = items.filter((item) => !isChecker(item))
  const groups = new Map(leads.map((item) => [item, [] as T[]]))
  const bare = (lead: T) => facts.name(lead).replace(/^worker-/, "")
  const rows: Nested<T>[] = []
  for (const item of items) {
    if (!isChecker(item)) {
      rows.push({ lead: item, members: groups.get(item) ?? [] })
      continue
    }
    const worker = facts.worker(item)
    const rosterPr = facts.pr(item)
    const byPr = (pr: number | null) =>
      pr !== null ? leads.find((l) => facts.pr(l) === pr) : undefined
    // an old name's sin, which the name fallbacks read; an <id>-<kind> name has none
    const match = CHECKER_NAME.exec(facts.name(item))
    const held = match ? facts.name(item).slice(match[1]!.length + 1) : null
    const suffix = Number(match?.[3])
    const lead =
      worker !== null
        ? (leads.find((l) => facts.name(l) === worker) ?? byPr(rosterPr))
        : (byPr(rosterPr) ??
          (held === null
            ? undefined
            : (leads.find((l) => held === bare(l)) ??
              byPr(Number.isInteger(suffix) && suffix > 0 ? suffix : null) ??
              leads
                .filter((l) => held.startsWith(`${bare(l)}-`))
                .toSorted((a, b) => bare(b).length - bare(a).length)[0])))
    if (lead) groups.get(lead)?.push(item)
    else rows.push({ lead: item, members: [] })
  }
  const waits = ({ lead, members }: Nested<T>) =>
    [lead, ...members].some((item) => facts.state(item) === "needs-you") ? 0 : 1
  const rank = ({ lead }: Nested<T>) => facts.group?.(lead) ?? 1
  return rows.toSorted((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? 0 : waits(a) - waits(b)))
}

// Pure: a session's state as its sidebar row and its System table row nest and rank: waiting on you while something of yours holds it (waits), paused while the usage limit alone holds it, since it waits on the reset and not on you, so it never jumps to the waiting rows, else its own state.
export const nestState = (state: SortState, paused: boolean, waits: boolean): SortState =>
  waits ? "needs-you" : paused ? "paused" : state

// Pure: the most pressing state in a row's group: waiting wins, then working, then idle.
export const groupState = <T>(row: Nested<T>, state: (item: T) => SortState): SortState =>
  [row.lead, ...row.members]
    .map(state)
    .reduce((best, next) => (STATUS_RANK[next] < STATUS_RANK[best] ? next : best))

export type SessionTask = Worker["tasks"][number]

// Each task's state in words: a subagent is Done when it finishes, a background process Exited.
export const TASK_LABELS: Record<SessionTask["kind"], Record<SessionTask["state"], string>> = {
  agent: { done: "Done", failed: "Failed", running: "Running", stopped: "Stopped" },
  process: { done: "Exited", failed: "Failed", running: "Running", stopped: "Stopped" },
}

// A session's state as the board orders it: its light, or down for an agent the roster lists with no live session (the dashboard's table ranks those by status before the socket's first list, and puts them last after it). "paused" is a row the usage limit alone holds: it waits on the reset, not on a person.
export type SortState = Worker["light"] | "down" | "paused"

// A light's rank where the board has no fuller state to go by: the API's states before the socket's first list, and the most pressing light in a worker's nested row. Waiting on you first, then working, then the usage-paused rows with the idle ones, then down.
export const STATUS_RANK: Record<SortState, number> = {
  "needs-you": 0,
  working: 1,
  paused: 2,
  idle: 2,
  unknown: 2,
  down: 3,
}

const timeOf = (iso: string | null): number => (iso ? Date.parse(iso) || 0 : 0)

// An Other session idle this long hides behind Show N idle, so a session idle since yesterday never crowds the list.
export const OTHER_IDLE_MS = 3 * 60 * 60 * 1000

// Pure: whether a session has sat idle for over OTHER_IDLE_MS since it last did anything; one with no time known counts as recent.
export const longIdle = (state: SortState, lastActiveAt: string | null, now: number): boolean =>
  state === "idle" && lastActiveAt !== null && now - timeOf(lastActiveAt) > OTHER_IDLE_MS

// Pure: whether an Other row shows even while its group is collapsed, in the sidebar and the dashboard's table alike: one waiting (at a picker or a prompt, or with an open inbox item it posted) or open in the view.
export const keepsOther = (state: SortState, waiting: boolean, selected: boolean): boolean =>
  state === "needs-you" || waiting || selected

// Whether the Other group is open and shows its long-idle rows, which the dashboard keeps for the sidebar and the dashboard's table.
export type OtherView = {
  open: boolean
  setOpen: (open: boolean) => void
  setShowIdle: (showIdle: boolean) => void
  showIdle: boolean
}

// Pure: the Other group's rows, in their order, for the sidebar and the dashboard's table alike. A row kept (keepsOther) always shows; a collapsed group shows only those, an open one the rest too, but for the long-idle ones until showIdle. idle counts the long-idle rows Show N idle stands for.
export function otherRows<T>(
  items: T[],
  view: {
    idle: (item: T) => boolean
    keep: (item: T) => boolean
    open: boolean
    showIdle: boolean
  },
): { idle: number; rows: T[] } {
  const { idle, keep, open, showIdle } = view
  return {
    idle: items.filter((item) => !keep(item) && idle(item)).length,
    rows: items.filter((item) => keep(item) || (open && (showIdle || !idle(item)))),
  }
}

// How long a new light must hold before its row moves. A session flips idle and back between two steps of one turn within a second or two, and its row stays put meanwhile; a wait moves at once, both into it and out of it, since leaving it means it was answered.
export const LIGHT_HOLD_MS = 5000

// A session's light as the board orders it (light), the one it shows now (seen), and since when it has shown that.
export type Steady = { light: Worker["light"]; seen: Worker["light"]; since: number }

// Pure: each live session's steady light at now. A light a session just took counts once it has held for holdMs, except needs-you and the light that leaves it, which count at once, as does a new session's first light. wakeAt is when the next light still waiting would count, or null when none waits.
export function settleLights(
  prev: ReadonlyMap<string, Steady>,
  workers: Worker[],
  now: number,
  holdMs = LIGHT_HOLD_MS,
): { lights: Map<string, Steady>; wakeAt: number | null } {
  const lights = new Map<string, Steady>()
  let wakeAt: number | null = null
  for (const { light, sessionId } of workers) {
    const was = prev.get(sessionId)
    const since = was?.seen === light ? was.since : now
    const prompt = light === "needs-you" || was?.light === "needs-you"
    const steady = !was || prompt || now - since >= holdMs ? light : was.light
    lights.set(sessionId, { light: steady, seen: light, since })
    if (steady !== light) wakeAt = Math.min(wakeAt ?? Infinity, since + holdMs)
  }
  return { lights, wakeAt }
}

// Pure: the settled lights as they were when nothing in them moved, so a board frame that left every light where it stood hands the same map on and nothing reading it draws again.
export function keepSettled<
  T extends { lights: ReadonlyMap<string, Steady>; wakeAt: number | null },
>(prev: T, next: T): T {
  if (prev.wakeAt !== next.wakeAt || prev.lights.size !== next.lights.size) return next
  for (const [id, steady] of next.lights) {
    const was = prev.lights.get(id)
    if (was?.light !== steady.light || was.seen !== steady.seen || was.since !== steady.since)
      return next
  }
  return prev
}

// Each live session's settled light (held), settling as settleLights says and waking when the next one counts, which its icon shows and the board's order (orderByStatus in lib/agents.ts) ranks it by, so a pause between two steps neither flashes another state nor moves a row.
export function useHeldLights(workers: Worker[] | null): ReadonlyMap<string, Worker["light"]> {
  const [settled, setSettled] = useState(() => settleLights(new Map(), [], 0))
  useEffect(() => {
    setSettled((prev) => keepSettled(prev, settleLights(prev.lights, workers ?? [], Date.now())))
  }, [workers])
  useEffect(() => {
    const { wakeAt } = settled
    if (wakeAt === null) return
    // Settled as of wakeAt at the earliest, so a timer that fires early (the clock stepped back) still settles the light it waited for, and wakeAt moves on.
    const timer = setTimeout(
      () =>
        setSettled((prev) =>
          keepSettled(prev, settleLights(prev.lights, workers ?? [], Math.max(Date.now(), wakeAt))),
        ),
      Math.max(0, wakeAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [settled, workers])
  return useMemo(
    () => new Map([...settled.lights].map(([id, steady]) => [id, steady.light])),
    [settled.lights],
  )
}

export type LiveState = "Connecting" | "Live" | "Lost" | "Reconnecting"

// The live feed's state, which the System item's light shows: lost while the open socket's last frame is a read's error (the API could not read the sessions' terminal), live while it is open otherwise; with it closed, connecting until a workers frame has ever arrived (a socket that drops before its first frame is still connecting), then reconnecting.
export const liveState = (
  connected: boolean,
  workers: Worker[] | null,
  problem: DashboardProblem | null = null,
): LiveState =>
  connected ? (problem ? "Lost" : "Live") : workers === null ? "Connecting" : "Reconnecting"

// A page description is one short line: a worker's first ask is cut at a word near the limit, so it never wraps under the title.
export const oneLine = (text: string, max = 80): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim())
  if (chars.length <= max) return chars.join("")
  // Counted in characters, not UTF-16 units, so a cut never splits an emoji.
  const cut = chars.slice(0, max - 1).join("")
  // The cut already ends on a word when the next character is a space; otherwise back up to the last one, and always to the one before a link (bare, or wrapped in <…|…>, (…) or […](…)), so half a URL never shows.
  const space = chars[max - 1] === " " ? cut.length : cut.lastIndexOf(" ")
  const before = cut.slice(space + 1).includes("://")
  return `${(space > max / 2 || (before && space > 0) ? cut.slice(0, space) : cut).trimEnd()}…`
}

// Each light's state in words, capitalised as a label. The one map the sidebar rows, the page header and the Dashboard's Status column all read, so screen readers and tests see the same words.
export const LIGHT_LABELS: Record<Worker["light"], string> = {
  idle: "Idle",
  "needs-you": "Waiting on you",
  unknown: "State unknown",
  working: "Working",
}

// What any session but Playground's reads while a prompt, a picker, a permission or a blocking screen holds it: it is stuck, and Playground or its lead answers it, never the owner, so only Playground's own reads Waiting on you.
export const STUCK = "Stuck"

// Pure: a blocked session's words: Waiting on you for Playground's own (dispatcher), else Stuck.
export const waitLabel = (dispatcher: boolean): string =>
  dispatcher ? LIGHT_LABELS["needs-you"] : STUCK

const MINUTE_MS = 60_000

// Pure: the time left until eta at now, to the nearest minute under an hour (~20m, and ~1m in its last half minute) and to the nearest hour past it (~1h). No eta, one that does not parse, or one that has passed is null: the time left shows alone, never a guess.
export const etaLabel = (eta: string | null, now: number): string | null => {
  const at = eta ? Date.parse(eta) : Number.NaN
  if (Number.isNaN(at) || at <= now) return null
  const minutes = Math.max(1, Math.round((at - now) / MINUTE_MS))
  return minutes < 60 ? `~${minutes}m` : `~${Math.round(minutes / 60)}h`
}

// Pure: the ETA a worker shows as its time left on its row's tooltip, while it is working or stuck. The sidebar's rows show none, and a runner's job has no end, and an idle or down worker is not on the clock.
export const shownEta = (
  { eta, role, state }: { eta: string | null; role: Worker["role"]; state: SortState },
  now: number,
): string | null =>
  role === "worker" && (state === "working" || state === "needs-you") ? etaLabel(eta, now) : null

// The clock, read again every everyMs, for words that change with time alone.
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

// Pure: whether a session is the primary dispatcher, whose chat is the dashboard's home and holds the Inbox: it holds the dispatcher role under the name the API gives the primary (primary, PLAYGROUND_DISPATCHER on the API), or under any name before the API has given one.
export const isPrimary = (
  worker: Pick<Worker, "name" | "role">,
  primary: string | null = null,
): boolean => worker.role === "dispatcher" && (primary === null || worker.name === primary)

// The primary dispatcher's live session, found by its role and the name the API gives it, never by a name written here.
export const dispatcherOf = (
  workers: Worker[] | null,
  primary: string | null = null,
): Worker | null => workers?.find((w) => isPrimary(w, primary)) ?? null

// Pure: the header's dispatcher slots, a list by role in the order the API names them (PLAYGROUND_DISPATCHER, then PLAYGROUND_DISPATCHER_SECONDARY), each the live session holding the role under that name, or none while it is down. The primary's slot is always kept; the second's only while its session is live or the roster lists it in a status that has not ended (rostered, the board's agents), so a machine that runs no second dispatcher, or ended it, shows no row for it.
export const dispatchersOf = (
  workers: Worker[] | null,
  names: readonly string[],
  rostered: readonly { name: string; status: string | null }[] = [],
): { name: string; worker: Worker | null }[] =>
  names.flatMap((name, i) => {
    const worker = workers?.find((w) => w.role === "dispatcher" && w.name === name) ?? null
    const listed = rostered.some((agent) => agent.name === name && !isEndedStatus(agent.status))
    return worker || i === 0 || listed ? [{ name, worker }] : []
  })

// The worker /dashboard shows: the one the URL asks for while it is live, else the primary dispatcher, whose chat is the dashboard's home, since the owner talks to the dispatcher alone. None while the list has not come or the primary is not live.
export const pickWorker = (
  requested: string | null,
  workers: Worker[] | null,
  primary: string | null = null,
): string | null =>
  requested && workers?.some((w) => w.sessionId === requested)
    ? requested
    : (dispatcherOf(workers, primary)?.sessionId ?? null)

// Pure: the live session a transcript link to a worker's view names, by the ?worker= in it; null for any other link.
export const viewWorker = <T extends Pick<Worker, "sessionId">>(
  href: string,
  workers: T[],
): T | null => {
  let id: string | null
  try {
    id = new URL(href).searchParams.get("worker")
  } catch {
    return null
  }
  return id ? (workers.find((w) => w.sessionId === id) ?? null) : null
}

// Pure: the socket's problem after one more board frame. A single failed read raises nothing, since the next refresh usually reads fine; the second failure in a row raises it, a raised one holds through every failure after it, and only a board that reads clears it.
export const MISSES_TO_ALERT = 2
export type Misses = { misses: number; problem: DashboardProblem | null }
export const afterFrame = (state: Misses, failure: DashboardProblem | null): Misses =>
  failure === null
    ? { misses: 0, problem: null }
    : {
        misses: state.misses + 1,
        problem: state.problem || state.misses + 1 >= MISSES_TO_ALERT ? failure : null,
      }

// How often the hosted build reads the board through the relay.
export const BOARD_POLL_MS = 5000

// The dashboard's one WebSocket: every worker change, every new transcript entry handed to whoever subscribed, and the activity of the one chat it watches (watch names it, null for none).
export function useDashboardSocket(enabled: boolean) {
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [activity, setActivity] = useState<SessionActivity | null>(null)
  const watcher = useRef(createWatch())
  const [approvals, setApprovals] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [dispatcher, setDispatcher] = useState<string | null>(null)
  const [dispatchers, setDispatchers] = useState<readonly string[] | null>(null)
  const [problem, setProblem] = useState<DashboardProblem | null>(null)
  const [connected, setConnected] = useState(false)
  // Bumped by the first workers frame of each connection: entries written while the socket was down, or before the hub began tailing, are fetched again then.
  const [generation, setGeneration] = useState(0)
  const listeners = useRef(new Set<EntriesListener>())

  useEffect(() => {
    if (!enabled) return
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    let failures = 0
    let fresh = false
    let misses: Misses = { misses: 0, problem: null }

    // A board frame, from the socket or, on the hosted build, from a read of the board.
    const onFrame = (frame: DashboardFrame) => {
      if (frame.type === "workers") {
        // each frame is parsed afresh, so a session it left as it was keeps its object and a frame that moved nothing keeps the board, and nothing reading them draws again
        setWorkers((shown) => replaceEqualDeep(shown, frame.workers))
        setApprovals(frame.approvals)
        setRestoring(frame.restoring)
        setDispatcher(frame.dispatcher)
        setSessionNames(frame.names)
        setDispatcherOrder(frame.dispatchers)
        setDispatchers((shown) => replaceEqualDeep(shown, frame.dispatchers))
        misses = afterFrame(misses, null)
        setProblem(null)
        if (fresh) {
          fresh = false
          setGeneration((n) => n + 1)
        }
      } else if (frame.type === "error") {
        setDispatcher(frame.dispatcher)
        setSessionNames(frame.names)
        setDispatcherOrder(frame.dispatchers)
        setDispatchers((shown) => replaceEqualDeep(shown, frame.dispatchers))
        misses = afterFrame(misses, { code: frame.code, message: frame.message })
        setProblem(misses.problem)
      } else {
        for (const listener of listeners.current) listener(frame.sessionId, frame.entries)
      }
    }

    // The hosted build reaches the Mac through the relay, which carries requests and no live frames yet, so it reads the board every BOARD_POLL_MS in place of the socket.
    if (config.hosted) {
      const read = async () => {
        const { data } = await unwrap(apiClient.v1.board.$get())
        if (closed) return
        setConnected(Boolean(data))
        if (data) onFrame(data)
        retry = setTimeout(() => void read(), BOARD_POLL_MS)
      }
      fresh = true
      void read()
      return () => {
        closed = true
        if (retry) clearTimeout(retry)
      }
    }

    const connect = () => {
      const opened = apiClient.v1.ws.$ws()
      socket = opened
      const sendWatch = (data: string) => opened.send(data)
      opened.addEventListener("open", () => {
        failures = 0
        // a reconnect replays the hub's last frame, so the count starts again, while a problem already raised stays until a board reads
        misses = { misses: 0, problem: misses.problem }
        fresh = true
        setConnected(true)
        watcher.current.connected(sendWatch)
      })
      opened.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as DashboardFrame | ActivityFrame
        if (frame.type === "activity") {
          setActivity({ activity: frame.activity, sessionId: frame.sessionId })
        } else onFrame(frame)
      })
      opened.addEventListener("close", () => {
        watcher.current.disconnected(sendWatch)
        setActivity(null)
        setConnected(false)
        if (!closed) retry = setTimeout(connect, reconnectDelay(failures++))
      })
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }, [enabled])

  const subscribe = useCallback((listener: EntriesListener) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  const watch = useCallback((sessionId: string | null) => watcher.current.set(sessionId), [])

  return {
    activity,
    approvals,
    connected,
    dispatcher,
    dispatchers,
    generation,
    problem,
    restoring,
    subscribe,
    watch,
    workers,
  }
}

const NO_ENTRIES: Entry[] = []

// One session's steps: its recent history fetched once from the file, then kept current from the socket; older steps come from the database a page at a time, before the oldest one shown.
export function useEntries(
  sessionId: string | null,
  subscribe: (listener: EntriesListener) => () => void,
  generation: number,
) {
  const [history, setHistory] = useState<History>(() => historyOf(null))
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<DashboardProblem | null>(null)
  const requests = useRef(0)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setHistory((current) =>
      fetchAsked(current.sessionId === sessionId ? current : historyOf(sessionId)),
    )
    setLoading(true)
    setProblem(null)
    const unsubscribe = subscribe((id, entries) => {
      if (id !== sessionId) return
      setHistory((current) =>
        current.sessionId === sessionId ? withSteps(current, entries) : current,
      )
    })
    void unwrap(
      apiClient.v1.workers[":sessionId"].transcript.$get({
        param: { sessionId },
        query: { limit: String(ENTRY_LIMIT) },
      }),
    ).then(({ data, error }) => {
      if (cancelled) return
      setLoading(false)
      if (error) {
        setHistory((current) =>
          current.sessionId === sessionId ? { ...current, framed: null } : current,
        )
        return setProblem({ code: error.code, message: error.message })
      }
      setHistory((current) =>
        current.sessionId === sessionId ? withSteps(current, data, { fetched: true }) : current,
      )
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [generation, sessionId, subscribe])

  const mine = history.sessionId === sessionId
  const oldestId = mine ? (history.list[0]?.id ?? null) : null
  const { cursor, older } = history
  const loadOlder = useCallback(() => {
    if (!sessionId || !oldestId || older === "loading" || older === "done") return
    requests.current += 1
    const request = requests.current
    setHistory((current) =>
      current.sessionId === sessionId ? { ...current, older: "loading", request } : current,
    )
    // A page can hold only lines that make no step; the next ones are fetched straight away, a few at most, so a click shows something whenever there is something to show.
    void (async () => {
      let query: { before: string } | { beforeId: string } =
        cursor === null ? { beforeId: oldestId } : { before: `${cursor}` }
      let page: OlderPage = { kind: "error" }
      for (let hop = 0; hop < EMPTY_HOPS; hop++) {
        const { data, error } = await unwrap(
          apiClient.v1.sessions[":id"].steps.$get({
            param: { id: sessionId },
            query: { ...query, limit: `${OLDER_PAGE}` },
          }),
        )
        page = error
          ? { kind: error.code === "NOT_FOUND" ? "missing" : "error" }
          : !data.anchored
            ? { kind: "missing" }
            : { before: data.before, entries: data.entries, hasMore: data.hasMore, kind: "page" }
        if (
          page.kind !== "page" ||
          page.entries.length > 0 ||
          !page.hasMore ||
          page.before === null
        )
          break
        query = { before: `${page.before}` }
      }
      setHistory((current) =>
        current.sessionId === sessionId ? withOlder(current, request, page) : current,
      )
    })()
  }, [cursor, older, oldestId, sessionId])

  // the same object until its state moves, so the dashboard's context holds across a render that changed nothing here
  const olderOf = useMemo<Older>(
    () => ({ load: loadOlder, state: mine ? older : "idle" }),
    [loadOlder, mine, older],
  )
  return {
    entries: mine ? history.list : NO_ENTRIES,
    loading,
    older: olderOf,
    problem,
  }
}

// The body the answer route takes, as its own schema declares it.
export type FeedAnswerBody = Parameters<
  (typeof apiClient.v1.workers)[":sessionId"]["feed"][":requestId"]["$post"]
>[0]["json"]

// Answers a prompt a live session left waiting through the API, which reads it as waiting before the reply and gone after it.
export async function answerFeedPrompt(sessionId: string, requestId: string, body: FeedAnswerBody) {
  return unwrap(
    apiClient.v1.workers[":sessionId"].feed[":requestId"].$post({
      json: body,
      param: { requestId, sessionId },
    }),
  )
}

// The latest steps of a subagent a live session ran, read from its own transcript.
export async function fetchSubagentSteps(sessionId: string, agentId: string) {
  return unwrap(
    apiClient.v1.workers[":sessionId"].agents[":agentId"].transcript.$get({
      param: { agentId, sessionId },
      query: { limit: "200" },
    }),
  )
}

// Types a message into a live session's terminal through the API, which records it in the console's activity; attachments are the ids of files uploaded for it, whose paths follow the words, and thread the thread it is routed to by the marker the API puts first, or newThread to open one with it; queuedAt is when Claude Code first held it, for an API that restarted since.
export async function sendMessage(
  to: string,
  text: string,
  attachments: string[] = [],
  id?: string,
  {
    newThread,
    queuedAt,
    threadId,
  }: { newThread?: boolean; queuedAt?: string; threadId?: string } = {},
) {
  return unwrap(
    apiClient.v1.messages.$post({
      json: { attachments, id, newThread, queuedAt, text, threadId, to },
    }),
  )
}
