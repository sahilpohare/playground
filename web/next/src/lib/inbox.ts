import type { InboxAction, InboxAnswer, InboxItem } from "@api/hono"
import {
  type ChoiceRow,
  type Choices,
  choicesOf,
  CLOCKS_STOPPED_AT,
  picksOf,
  rowOfAnswer,
} from "@packages/config/inbox"
import { useQuery } from "@tanstack/react-query"

import { agentLabel } from "@/lib/agent-label"
import { apiClient, unwrap } from "@/lib/api/client"
import { isProbe } from "@/lib/dashboard"
import { needsYouAnchor, type TargetSource } from "@/lib/needs-you"
import type { ShownState } from "@/lib/status-icons"
import { fullTime } from "@/lib/time"

export const INBOX_QUERY_KEY = ["inbox"] as const

// A new item shows in the Inbox and its tab's count within this long, without a reload.
export const INBOX_REFRESH_MS = 5_000

export async function fetchInbox() {
  const { data, error } = await unwrap(apiClient.v1.inbox.$get())
  if (error) throw new Error(error.message)
  return data
}

// seen is the updatedAt the card showed, so the API refuses an answer to words edited since.
export async function answerItem(
  { id, updatedAt }: Pick<InboxItem, "id" | "updatedAt">,
  action: InboxAction,
  text?: string,
  note?: string,
  option?: number,
  options?: number[],
) {
  const { data, error } = await unwrap(
    apiClient.v1.inbox[":id"].answer.$post({
      json: { action, note, option, options, seen: updatedAt, text },
      param: { id },
    }),
  )
  if (error) throw new Error(error.message)
  return data
}

// A card's Reply: his comment alone, typed into its poster as re #iN.
export async function replyItem(id: string, text: string) {
  const { data, error } = await unwrap(
    apiClient.v1.inbox[":id"].reply.$post({ json: { text }, param: { id } }),
  )
  if (error) throw new Error(error.message)
  return data
}

// Pure: why Reply holds a comment back: a secret ask's value typed as the comment, which would reach a transcript; null for any other.
export const commentRefused = (comment: string, value: string): string | null =>
  value.trim() !== "" && comment.trim() === value.trim()
    ? "That is the value: it goes in its field and Submit, never in a comment"
    : null

// The Archive shelf's Dismiss all: each card's own Dismiss in turn, so one that still waits is set aside and anything else marked dismissed, each poster told as that card's own click tells it.
export async function dismissEach(items: Pick<InboxItem, "id" | "updatedAt">[]) {
  for (const item of items) await answerItem(item, "dismiss")
}

// A secret ask's value, posted once to its own route and kept nowhere here; seen as an answer's.
export async function provideSecret(
  { id, updatedAt }: Pick<InboxItem, "id" | "updatedAt">,
  value: string,
) {
  const { data, error } = await unwrap(
    apiClient.v1.inbox[":id"].secret.$post({ json: { seen: updatedAt, value }, param: { id } }),
  )
  if (error) throw new Error(error.message)
  return data
}

// A reveal card's Keychain value, fetched on the owner's Show or Copy alone and held by the caller only as long as it shows.
export async function revealSecret(id: string): Promise<string> {
  const { data, error } = await unwrap(apiClient.v1.inbox[":id"].reveal.$post({ param: { id } }))
  if (error) throw new Error(error.message)
  return data.value
}

// The update named: one he clicked.
export async function markRead(ids: string[]) {
  const { data, error } = await unwrap(apiClient.v1.inbox.read.$post({ json: { ids } }))
  if (error) throw new Error(error.message)
  return data
}

export async function retryItem(id: string) {
  const { data, error } = await unwrap(apiClient.v1.inbox[":id"].retry.$post({ param: { id } }))
  if (error) throw new Error(error.message)
  return data
}

export async function dismissItems(ids: string[], tell?: true) {
  const { data, error } = await unwrap(apiClient.v1.inbox.dismiss.$post({ json: { ids, tell } }))
  if (error) throw new Error(error.message)
  return data
}

// Later: puts an open decision or draft, or an update, away until a time, when it asks again; it leaves the list and the count until then, and the Archive shelf when it was there.
export async function scheduleItem(id: string, at: string) {
  const { data, error } = await unwrap(
    apiClient.v1.inbox[":id"].schedule.$post({ json: { at }, param: { id } }),
  )
  if (error) throw new Error(error.message)
  return data
}

// The inbox every dashboard surface reads, one query so the Inbox tab's count and the list never disagree. DashboardProvider's observer polls (every dashboard page mounts it), and the tab's dot's polls in a hidden tab too (TAB_DOT_POLLING); the rest read its cache.
export function useInbox(
  enabled: boolean,
  { background = false, poll = false }: { background?: boolean; poll?: boolean } = {},
) {
  return useQuery({ enabled, ...inboxPolling({ background, poll }) })
}

// The inbox read's polling: every INBOX_REFRESH_MS when poll, and in a hidden tab too when background, which the tab's dot needs and a plain interval skips.
export const inboxPolling = ({ background, poll }: { background: boolean; poll: boolean }) => ({
  queryFn: fetchInbox,
  queryKey: INBOX_QUERY_KEY,
  refetchInterval: poll ? INBOX_REFRESH_MS : (false as const),
  refetchIntervalInBackground: background,
})

export const itemTag = (item: Pick<InboxItem, "ref">): string => `#i${item.ref}`

// Pure: when an item was dismissed or closed by its poster, on any answer that holds one; null on one that does not, a resolution included, which closed without a dismissal.
const answeredDismissedAt = (item: InboxItem): string | null => {
  const answer = item.answer
  return answer && "dismissedAt" in answer && answer.dismissedAt ? answer.dismissedAt : null
}

// Pure: an answer that did not reach its poster and that he has not dismissed, which offers Retry (11 answers failed unseen on 9 Oct).
export const sendFailed = (item: InboxItem): boolean =>
  item.kind !== "update" && item.delivery?.status === "failed" && !answeredDismissedAt(item)

// The failures Retry is offered after, the API's RETRY_CODES restated since the web imports its types alone (a test holds the two equal): nothing was typed, so a retry cannot type the answer twice.
export const RETRY_CODES = [
  "INPUT_NOT_EMPTY",
  "LOST",
  "NOT_FOUND",
  "ON_PICKER",
  "SESSIONS_FAILED",
  "UPLOAD_FAILED",
] as const

// Pure: an answer whose send is unconfirmed (typing began, INTERRUPTED, or the adapter threw, ERROR), which may be in the session already, so its card offers Check it for me rather than Retry.
export const sendUnconfirmed = (item: InboxItem): boolean =>
  sendFailed(item) &&
  item.delivery?.status === "failed" &&
  (item.delivery.code === "INTERRUPTED" || item.delivery.code === "ERROR")

// The note Check it for me sends the dispatcher for an unconfirmed answer: the item and the session it went to, so the dispatcher looks there and reports.
export const checkAnswerNote = (item: InboxItem): string =>
  `Check it for me: did ${agentLabel(item.from)} get my answer to ${itemTag(item)}? Look at its transcript and tell me whether it arrived.`

// The API's STUCK_QUEUED_MS restated (a test holds the two equal): an answer reading queued this long after it was queued lost its follow-up to an API restart.
export const STUCK_QUEUED_MS = 11 * 60_000

// Pure: an answer that failed to send that Retry can safely follow, or one stuck queued, whose Retry reads it again and types nothing while Claude Code still holds it; after any other failure it may be in the session already, so it offers Check it for me or Dismiss.
export const retryable = (item: InboxItem, now = Date.now()): boolean =>
  (sendFailed(item) &&
    item.delivery?.status === "failed" &&
    (RETRY_CODES as readonly string[]).includes(item.delivery.code)) ||
  (item.delivery?.status === "queued" && now - Date.parse(item.delivery.at) >= STUCK_QUEUED_MS)

// The API's ACKS_STAMPED_FROM restated, since the web imports its types alone (a test holds the two equal): an answer delivered before then may have been acked with no stamp, so it reads as closed.
export const ACKS_STAMPED_FROM = "2026-10-12T08:05:50.000Z"

// Pure: a go, an answer to carry out (Approve, Edit, Send, Draft), which closes only with where it landed or why there is no link.
export const isGo = (choice: string): boolean => (GO_CHOICES as readonly string[]).includes(choice)

// The API's GO_CHOICES restated (a test holds the two equal).
export const GO_CHOICES = ["approve", "draft", "edit", "send"] as const

// Pure: a Slack link in its app form naming a conversation, or one parsed thread in it, its query and hash aside: the only place a send shares its files into, the API's slackPlace restated (a test holds the two agreeing).
export const slackPlaced = (link: string): boolean => {
  if (!URL.canParse(link)) return false
  const url = new URL(link)
  if (url.protocol !== "https:" || url.hostname !== "app.slack.com") return false
  const [, client, team, channel, ...rest] = url.pathname.replace(/\/$/, "").split("/")
  if (client !== "client" || !team || !channel || !/^[CDG][A-Z0-9]+$/.test(channel)) return false
  if (rest.length === 0) return true
  const [word, parent, ...more] = rest
  return (
    word === "thread" &&
    more.length === 0 &&
    (parent ?? "").startsWith(`${channel}-`) &&
    /^\d+\.\d+$/.test((parent ?? "").slice(channel.length + 1))
  )
}

// Pure: "1 file" or "N files", as a Slack send's mark and its result line count them.
export const filesCount = (n: number): string => (n === 1 ? "1 file" : `${n} files`)

// Pure: the button whose go shares an open item's files into Slack, a Slack draft's Send or a slack decision's Approve, or null when its files stay on the card (a Linear draft's, an ask's, one with no Slack link); the API's filesToUpload decides the same.
export const uploadsOn = (item: InboxItem): "Approve" | "Send" | null => {
  if (item.status !== "open" || item.kind === "update") return null
  const preview = item.preview
  if (!("attachments" in preview) || !preview.attachments?.length) return null
  if (!("link" in preview) || !preview.link || !slackPlaced(preview.link)) return null
  if (item.kind === "draft") return "Send"
  return item.kind === "decision" && item.preview.type === "slack" ? "Approve" : null
}

// Pure: whether an open draft offers Draft beside Send: a Slack draft, which Slack's MCP server saves as a draft, never a Linear comment, whose API creates none; the API's savesDraft decides the same (a test holds the two equal).
export const canDraft = (item: InboxItem): boolean =>
  item.kind === "draft" && item.status === "open" && kindWord(item) === "Slack draft"

// The item's answer once it holds a choice, his or a settle's; null before that, a Schedule put-away included, which holds only when to ask again. An update's answer, a resolution included, holds none.
const chosen = (item: InboxItem) =>
  item.kind !== "update" && item.answer && "choice" in item.answer ? item.answer : null

// What the dashboard's own run on an accept's, a clone's, an apps change's, a grant's, an own card's, a root step's or a guard setting's Approve gave, read off any answer, none for the rest.
type Steps = Pick<
  InboxAnswer,
  "accepted" | "cloned" | "listed" | "opened" | "owned" | "rooted" | "set"
>
const stepsOf = (answer: object | null): Steps => (answer ?? {}) as Steps

// Pure: whether a card a reply collapsed opens again to its full self, its answers and Schedule back: an open decision or draft whose answer is that reply, its poster not done with it, which an answer or a Schedule from the card replaces.
export const reopenable = (item: InboxItem): boolean => {
  const answer = chosen(item)
  return item.status === "open" && answer?.choice === "replied" && !answer.ackedAt
}

// Pure: whether Schedule is offered, the API's scheduleItem rule restated: an open decision or draft whose answer holds no choice yet, one still sleeping included, which Schedule puts away again, or a reply its poster is not done with.
export const schedulable = (item: InboxItem): boolean =>
  item.kind !== "update" && item.status === "open" && (!chosen(item) || reopenable(item))

// Pure: whether a key opens or folds a card a reply collapsed: E alone, Caps Lock's too, never typed in the card's box, held down or composing text.
export const reopenKey = (key: Omit<CardKey, "keyCode">): boolean =>
  key.key.toLowerCase() === "e" &&
  !(key.altKey || key.ctrlKey || key.metaKey || key.shiftKey || key.repeat || key.isComposing) &&
  key.target !== "box"

// A zone's offset from UTC at a moment, daylight saving included.
const offsetAt = (zone: string, t: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      second: "numeric",
      timeZone: zone,
      year: "numeric",
    })
      .formatToParts(t)
      .map(({ type, value }) => [type, Number(value)]),
  )
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return wall - Math.floor(t / 1000) * 1000
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

// One of Schedule's fixed times: when it asks again, its name, and that moment in the owner's zone with its day.
export type ScheduleChoice = { at: string; label: string; when: string }

// Pure: Schedule's fixed times in the owner's zone (the clock.ownerZone setting), soonest first: in 30 minutes, 1 hour and 3 hours, this evening's 18:00 while it is ahead, the next 09:00 (Today or Tomorrow), the coming Monday's 09:00 and next week's same weekday at 09:00; a moment two of them share is kept once, a named time winning over an "In N" one, and Today, Tomorrow or Next <weekday> over Monday.
export function scheduleChoices(now: Date, zone: string): ScheduleChoice[] {
  const t = now.getTime()
  const local = new Date(t + offsetAt(zone, t))
  const day = local.getUTCDay()
  // a wall-clock hour in the zone, this many days from today, as a UTC time, at the offset that day has
  const zoneAt = (days: number, hour: number) => {
    const wall = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + days,
      hour,
    )
    return wall - offsetAt(zone, wall - offsetAt(zone, wall))
  }
  const nineToday = zoneAt(0, 9) > t
  const named: [number, string][] = [
    [zoneAt(0, 18), "This evening 18:00"],
    [zoneAt(nineToday ? 0 : 1, 9), nineToday ? "Today 09:00" : "Tomorrow 09:00"],
    [zoneAt(7, 9), `Next ${DAYS[day]} 09:00`],
    [zoneAt((8 - day) % 7 || 7, 9), "Monday 09:00"],
  ]
  const ahead: [number, string][] = [
    [t + 30 * 60_000, "In 30 minutes"],
    [t + 3_600_000, "In 1 hour"],
    [t + 3 * 3_600_000, "In 3 hours"],
  ]
  // two times meet when they show the same minute, since an "In N" one keeps now's seconds
  const seen = new Set<number>()
  return [...named, ...ahead]
    .filter(([at]) => {
      const minute = Math.floor(at / 60_000)
      if (at <= t || seen.has(minute)) return false
      seen.add(minute)
      return true
    })
    .sort(([a], [b]) => a - b)
    .map(([at, label]) => {
      const shown = new Date(at + offsetAt(zone, at))
      const hh = String(shown.getUTCHours()).padStart(2, "0")
      const mm = String(shown.getUTCMinutes()).padStart(2, "0")
      const when = `${DAYS[shown.getUTCDay()]} ${shown.getUTCDate()} ${MONTHS[shown.getUTCMonth()]}, ${hh}:${mm}`
      return { at: new Date(at).toISOString(), label, when }
    })
}

// Pure: the moment Pick a time names, a day from the Calendar at a time field's "HH:MM" in this browser's time zone, or null while it names none: no day, a time that does not read, or a moment not after now, which Set refuses.
export function pickedAt(day: Date | undefined, time: string, now: Date): Date | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!day || !match) return null
  const at = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Number(match[1]),
    Number(match[2]),
  )
  return at.getTime() > now.getTime() ? at : null
}

// Pure: whether he archived an item and has not dismissed it since.
export const isArchived = (item: InboxItem): boolean =>
  item.answer !== null && "archivedAt" in item.answer && !("dismissedAt" in item.answer)

// Pure: whether an item asks something of the owner now: an open decision or draft, an answer that failed to send, or an update not read yet. A reply took an item off his hands, so it waits on its poster alone, and one he archived waits on him moving it back.
export const needsYou = (item: InboxItem): boolean =>
  isArchived(item)
    ? false
    : item.kind === "update"
      ? item.readAt === null
      : (item.status === "open" && chosen(item)?.choice !== "replied") || sendFailed(item)

// Pure: whether a card shows folded until he opens it: every card but one that needs an answer now, so an ask put away with Later folds until its time and a card that rises to needing him shows open.
export const foldsByDefault = (item: InboxItem, now: number): boolean =>
  !needsYou(item) ||
  (item.kind !== "update" &&
    item.answer !== null &&
    "snoozedUntil" in item.answer &&
    Date.parse(item.answer.snoozedUntil) > now)

// The shelf a card sits on: the list, or one of the rows under it.
export type Shelf = "archived" | "done" | "inbox" | "progress" | "snoozed"

// The words each shelf's row shows; what a row does reads its place, never these, so they can change.
export const SHELF_LABELS: Record<Exclude<Shelf, "inbox">, string> = {
  archived: "Archive",
  done: "Done",
  progress: "In progress",
  snoozed: "Later",
}

// A card's verbs, beside its own answers and Reply: Seen marks it read, Done sends it to Done, Later puts it off until a time, Archive takes it off his list or Done onto the Archive shelf and Move back returns it, and Dismiss sends it to Done marked dismissed.
export type Verb = "archive" | "dismiss" | "done" | "later" | "moveBack" | "seen"

// Pure: whether an item still waits on his answer: an open decision, draft or secret ask he has not replied to.
export const waiting = (item: InboxItem): boolean =>
  item.kind !== "update" && item.status === "open" && chosen(item)?.choice !== "replied"

// Pure: whether his Dismiss marked an item, rather than his Done or its poster's close.
const dismissedMark = (item: InboxItem): boolean =>
  item.answer !== null && "dismissed" in item.answer && item.answer.dismissed === true

// Pure: the verbs a card offers on its shelf, by its state: Seen while unread; what waits takes Later, Archive and Dismiss; an update in the list takes Done too; an answered, working or failed one takes Done and Dismiss; an archived one Later, Move back and Dismiss, with no Later on one answered; and one on Done its Archive and Dismiss until dismissed, with Move back and no Archive on one set aside while it waited, and no Archive on one whose send failed.
export function verbs(item: InboxItem, shelf: Shelf): Verb[] {
  if (shelf === "done") {
    const archives = item.status !== "cleared" && item.delivery?.status !== "failed"
    return [
      ...(item.status === "cleared" ? (["moveBack"] as const) : []),
      ...(dismissedMark(item)
        ? []
        : ([...(archives ? (["archive"] as const) : []), "dismiss"] as const)),
    ]
  }
  // Later takes what waits or an update alone, so a set-aside one and one archived from Done once answered have none (PG-1909)
  if (shelf === "archived") {
    return waiting(item) || item.kind === "update"
      ? ["later", "moveBack", "dismiss"]
      : ["moveBack", "dismiss"]
  }
  const seen = item.readAt === null ? (["seen"] as const) : []
  if (waiting(item)) return [...seen, "later", "archive", "dismiss"]
  if (item.kind === "update") return [...seen, "done", "later", "archive", "dismiss"]
  return [...seen, "done", "dismiss"]
}

// Pure: the ids of what waits on the owner in the Inbox, in the list's order, so Playground's row's link reaches the first.
export const inboxWaiting = (items: InboxItem[]): string[] =>
  items.filter(needsYou).map((item) => item.id)

// Pure: whether a card is In progress: an answer its poster is carrying out (itemState's sending, the light's working), not dismissed.
const working = (item: InboxItem): boolean =>
  !answeredDismissedAt(item) && itemState(item) === "sending"

// Pure: whether a card stays in the list: it asks something of him; he only commented on it, so he still owes its answer while its poster reads the comment; or it is an update he read and has not sent to Done, dismissed or seen resolved, read since CLOCKS_STOPPED_AT, one woken from Later included.
const listed = (item: InboxItem): boolean =>
  needsYou(item) ||
  (reopenable(item) && !answeredDismissedAt(item)) ||
  (item.kind === "update" &&
    !answeredDismissedAt(item) &&
    !(item.answer && "choice" in item.answer) &&
    Date.parse(item.readAt ?? item.updatedAt) >= Date.parse(CLOCKS_STOPPED_AT))

// Pure: the time Done orders an item by: when he dismissed it or its poster closed it, else when it was answered, resolved or read.
const doneAt = (item: InboxItem): number => {
  const dismissed = answeredDismissedAt(item)
  if (dismissed) return Date.parse(dismissed)
  if (item.kind === "update") {
    const answer = item.answer
    return Date.parse(answer && "at" in answer ? answer.at : (item.readAt ?? item.updatedAt))
  }
  return Date.parse(chosen(item)?.at ?? item.updatedAt)
}

// Pure: the list as shown, moved by a verb alone, never a clock: the items that ask something of him, the cards he only commented on and the updates he has not dismissed, in the API's order; In progress, the answers their posters are carrying out, newest first; Archive, what he set aside to talk about later (Archive's `cleared`) and has not dismissed, newest first; and Done, the rest, the newest first. Nothing is deleted.
export function inboxView(items: InboxItem[]): {
  archived: InboxItem[]
  done: InboxItem[]
  progress: InboxItem[]
  shown: InboxItem[]
} {
  // a set-aside whose send failed stays in the list and its count, offering Retry, until it reaches its poster or he dismisses it
  const shelved = (item: InboxItem) =>
    item.status === "cleared" && !answeredDismissedAt(item) && !sendFailed(item)
  const newest = (a: InboxItem, b: InboxItem) => b.ref - a.ref
  const rest = items.filter((item) => !shelved(item))
  return {
    archived: items.filter(shelved).sort(newest),
    done: rest
      .filter((item) => !listed(item) && !working(item))
      .sort((a, b) => doneAt(b) - doneAt(a) || newest(a, b)),
    progress: rest.filter((item) => !listed(item) && working(item)).sort(newest),
    shown: rest.filter(listed),
  }
}

// Pure: the list as he sees it: the items in his order keep their places and one that left drops out, while one that arrived since waits in held, newest first, until he takes it. With no order yet, every item shows in the API's order, and with nothing left in view what arrived shows at once, since nothing can move under him.
export function pinnedView(
  shown: InboxItem[],
  order: readonly string[] | null,
): { held: InboxItem[]; rows: InboxItem[] } {
  if (order === null) return { held: [], rows: shown }
  const byId = new Map(shown.map((item) => [item.id, item]))
  const rows = order.flatMap((id) => byId.get(id) ?? [])
  const held = shown.filter((item) => !order.includes(item.id)).sort((a, b) => b.ref - a.ref)
  return rows.length === 0 ? { held: [], rows: held } : { held, rows }
}

export const newLabel = (count: number): string => `${count} new update${count === 1 ? "" : "s"}`

// Pure: the card a take hands focus to, the first it put on top, but only while the pill he took holds focus, since the pill leaves and focus would drop to the page; a take by a link, or one whose pill lost focus, moves no focus.
export const focusAfterTake = <T>(
  pill: { contains: (node: never) => boolean } | null,
  active: unknown,
  first: T | null,
): T | null => (pill?.contains(active as never) ? first : null)

// How long a row's buttons stay paused after it moves under him, so a click meant for another item never lands on it.
export const MOVED_PAUSE_MS = 1_000

// Pure: the rows whose place changed since the last render, or that were not there; none on the first read.
export const movedRows = (before: readonly string[] | null, after: readonly string[]): string[] =>
  before === null ? [] : after.filter((id, index) => before.indexOf(id) !== index)

// Pure: one render's step: the rows that moved since the last read rows, and the rows to compare the next read with; while the inbox loads (ids null) nothing is kept, so its first read moves nothing.
export const movedStep = (
  before: string[] | null,
  ids: string[] | null,
): { before: string[] | null; moved: string[] } =>
  ids === null ? { before, moved: [] } : { before: ids, moved: movedRows(before, ids) }

// A key pressed on a card, as cardKey and reopenKey read it: where it was pressed, its box, a decision's choice or elsewhere.
export type CardKey = {
  altKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  key: string
  keyCode: number
  metaKey: boolean
  repeat: boolean
  shiftKey: boolean
  target: "box" | "choice" | "elsewhere"
}

// Pure: what a card does with Cmd/Ctrl+Enter, the Questionnaire's submit key, by where it was pressed: null leaves the key alone (a decision's picked option goes through the Questionnaire's submit, and Shift, Alt or a key that composes text is not the shortcut); "leave" keeps a key pressed on a link or a button from the Questionnaire, so the browser does what it does there (Cmd+Enter on Open thread opens it in a tab); in the card's box, "send" presses the draft's Send, and "hold" takes the key with nothing to send, a repeat or a decision with no option picked included, so the item is never checked and marked invalid.
export function cardKey(
  key: CardKey,
  card: {
    choosing: boolean
    draftReady: boolean
    picked: boolean
  },
): "hold" | "leave" | "send" | null {
  if (key.key !== "Enter" || !(key.metaKey || key.ctrlKey) || key.shiftKey || key.altKey)
    return null
  if (key.isComposing || key.keyCode === 229) return null
  if (key.target === "elsewhere") return "leave"
  if (card.choosing) return card.picked ? null : "hold"
  if (key.repeat) return "hold"
  return card.draftReady ? "send" : "hold"
}

// Pure: why a decision's Send is off, its hover and screen-reader words, until a row is picked.
export const sendWhy = (pick: ChoiceRow | null): string | null =>
  pick === null ? "Pick an option first" : null

// Pure: whether Dismiss is offered: an answered decision or draft, one that failed to send included, one he replied to, which stays open, or any update, read or not, still in the list; dismissing an update marks it read.
export const dismissable = (item: InboxItem): boolean =>
  (item.kind === "update" || item.status !== "open" || chosen(item)?.choice === "replied") &&
  !answeredDismissedAt(item)

// Pure: what a shelf's row does, by its place: Archive's one click dismisses each card in turn, Done's marks what is unread on it as read and the row reads muted once none is, and In progress and Later have no one click.
export function shelfRow(
  place: Exclude<Shelf, "inbox">,
  shelf: InboxItem[],
): { bulk: { each: boolean; ids: string[] } | null; muted: boolean; unread?: number } {
  if (place === "archived")
    return {
      bulk: shelf.length > 0 ? { each: true, ids: shelf.map((item) => item.id) } : null,
      muted: false,
    }
  if (place !== "done") return { bulk: null, muted: false }
  const unread = shelf.filter(dismissable)
  return {
    bulk: shelf.length > 0 ? { each: false, ids: unread.map((item) => item.id) } : null,
    muted: unread.length === 0,
    unread: unread.length,
  }
}

// Pure: the line over the list: what needs him, the drafts, the answers that failed to send and the unread updates, each left out at none. A reply took an item off his hands, so it reads here no more.
export function inboxSummary(items: InboxItem[]): string | null {
  const open = items.filter(
    (item) =>
      item.kind !== "update" && item.status === "open" && chosen(item)?.choice !== "replied",
  )
  const decisions = open.filter((item) => item.kind === "decision").length
  const drafts = open.filter((item) => item.kind === "draft").length
  const failed = items.filter(sendFailed).length
  const unread = items.filter((item) => item.kind === "update" && item.readAt === null).length
  const parts = [
    decisions ? `${decisions} need${decisions === 1 ? "s" : ""} you` : null,
    drafts ? `${drafts} draft${drafts === 1 ? "" : "s"}` : null,
    failed ? `${failed} failed to send` : null,
    unread ? `${unread} unread` : null,
  ].filter((part) => part !== null)
  return parts.length ? parts.join(" · ") : null
}

// The word an item's band gives its kind: a decision by what Approve does, a draft as one, an update by its outcome.
export function kindWord(item: InboxItem): string {
  if (item.kind === "draft") {
    return httpsUrl(item.preview.link)?.hostname === "linear.app" ? "Linear comment" : "Slack draft"
  }
  if (item.kind === "update") {
    const word = item.preview.outcome
    return word.charAt(0).toUpperCase() + word.slice(1)
  }
  const words = {
    accept: "Accept",
    apps: "Your apps",
    ask: "Ask",
    budget: "Budget",
    clone: "Clone",
    delete: "Delete",
    grant: "Permission",
    guard: "Guard setting",
    own: "Own account",
    reveal: "Show a secret",
    root: "Root step",
    schema: "Schema",
    secret: "Secret",
    ship: "Ship",
    slack: "Slack",
    ticket: "New ticket",
  } as const
  return words[item.preview.type]
}

// Pure: whether an answer is carried out: a go is carried out only once its poster closes it with where it landed.
const carriedOut = (item: InboxItem): boolean => {
  const answer = chosen(item)
  // a settle is no go, so it is never carried out
  if (item.kind === "update" || !answer || answer.choice === "settled") return false
  const delivery = item.delivery
  const read = delivery?.status === "delivered" && delivery.via === "cli"
  // delivered before acks were stamped, so it may have been acked with no stamp, as the API's stale read takes it
  const unstamped =
    delivery?.status === "delivered" && Date.parse(answer.at) < Date.parse(ACKS_STAMPED_FROM)
  return (
    Boolean(answer.ackedAt || answer.link || ("noLink" in answer && answer.noLink)) ||
    unstamped ||
    // a cli-read reply waits for its ack like any go, so the card reads as being worked on
    (read && answer.choice !== "replied" && !isGo(answer.choice))
  )
}

// Where an item stands, which its card's colour says: open while it needs him, sending while a go or a reply is being carried out, done once its poster closed it or every environment took a secret, failed when the answer did not reach its poster or a secret's sink refused it, closed once denied, discarded, settled, read, a Draft Slack refused, or a failure he dismissed.
export type ItemState = "closed" | "done" | "failed" | "open" | "sending"

// Pure: a Draft its poster closed with no link, which only Slack refusing it leaves (draft_already_exists), so nothing was saved.
const draftRefused = (item: InboxItem): boolean => {
  const answer = chosen(item)
  return (
    item.kind === "draft" &&
    answer?.choice === "draft" &&
    Boolean("noLink" in answer && answer.noLink)
  )
}

export function itemState(item: InboxItem): ItemState {
  // a secret he provided follows its sink alone: done once every environment took it, failed while any did not, a dismiss included, so the record stays; a poster not yet told of it is deliveryNote's
  const provided = chosen(item)
  if (provided?.choice === "provided") {
    if (!provided.results) return "sending"
    return provided.results.every((result) => result.exitCode === 0) ? "done" : "failed"
  }
  if (sendFailed(item)) return "failed"
  if (needsYou(item)) return "open"
  // an accept, a clone, an apps change, an own flag, a root step or a guard setting the dashboard ran is done or failed by its exit code alone, since nothing is left for its poster to carry out; a grant that opened nothing failed, and one that opened its pane waits on its poster's recheck
  const { accepted, cloned, listed, opened, owned, rooted, set } = stepsOf(provided)
  const ran = accepted ?? cloned ?? listed ?? owned ?? rooted ?? set
  if (ran) return ran.exitCode === 0 ? "done" : "failed"
  if (opened && opened.exitCode !== 0) return "failed"
  // a reply is being carried out by its poster until it is closed, then done
  if (item.kind !== "update" && chosen(item)?.choice === "replied")
    return carriedOut(item) ? "done" : "sending"
  const answer = chosen(item)
  if (item.kind === "update" || !answer || !isGo(answer.choice)) return "closed"
  if (draftRefused(item)) return "closed"
  if (carriedOut(item)) return "done"
  // a failure he dismissed never reached its poster, so no one is carrying it out
  return item.delivery?.status === "failed" ? "closed" : "sending"
}

// Pure: the note a provided secret's card shows under its result when telling its poster failed, so the sink's result keeps the card's colour; null otherwise.
export const deliveryNote = (item: InboxItem): string | null =>
  sendFailed(item) && chosen(item)?.choice === "provided" && item.delivery?.status === "failed"
    ? `Not told to ${agentLabel(takenBy(item))} yet: ${item.delivery.reason}`
    : null

// Each state's light, the sidebar's state that means the same, so its icon and colour come from status-icons.ts's one table: waiting on him, being carried out, carried out, failed to send, closed.
const INBOX_LIGHTS: Record<ItemState, ShownState> = {
  closed: "idle",
  done: "done",
  failed: "failing",
  open: "waiting",
  sending: "working",
}

// Pure: the light a card draws beside its title; null for an unread update, which keeps its dot.
export const inboxLight = (item: InboxItem): ShownState | null =>
  item.kind === "update" && item.readAt === null ? null : INBOX_LIGHTS[itemState(item)]

// Pure: when an item changed after it was posted (an answer, its delivery, its poster's ack, settle or edit), from its updatedAt; null for one unchanged since. An update counts only its poster's edit, since his read stamps readAt with updatedAt and his Dismiss or a resolve gives it an answer.
export const changedAt = (item: InboxItem): string | null =>
  Date.parse(item.updatedAt) - Date.parse(item.createdAt) >= 1000 &&
  (item.kind !== "update" ||
    (item.answer === null &&
      (item.readAt === null || Date.parse(item.updatedAt) > Date.parse(item.readAt))))
    ? item.updatedAt
    : null

// Pure: whether a card reads Updated: it changed after the look before this one (since, null before any) and by the time this look began (upto), so a change made as he looks shows in place and none reads Updated twice.
export const updatedSince = (
  item: InboxItem,
  since: string | null,
  upto: string | null,
): boolean => {
  const at = changedAt(item)
  if (at === null || upto === null) return false
  return (
    (since === null || Date.parse(at) > Date.parse(since)) && Date.parse(at) <= Date.parse(upto)
  )
}

// Pure: the session that took an item's answer, which is not its poster once the poster has ended; a row from before the taker was recorded reads as its poster.
export const takenBy = (item: InboxItem): string =>
  (item.delivery?.status === "delivered" || item.delivery?.status === "queued") && item.delivery.to
    ? item.delivery.to
    : item.from

// Pure: what became of an answer, the card's result line: what was picked, in the card's own words, then a state only where the answer did not simply go through, since the card's light says the rest; his comment shows on the line under it, never in this one, and no word here is one typed for the session that asked.
export function outcomeLine(item: InboxItem): string | null {
  // an item still sleeping holds no choice, and asks him nothing until its time
  if (item.kind === "update" || !item.answer || !("choice" in item.answer)) return null
  if (draftRefused(item) && item.answer.choice === "draft")
    return `Draft not saved: ${item.answer.noLink}`
  // closed by its poster, decided another way: the owner gave no answer, so nothing was delivered
  if (item.answer.choice === "settled") {
    const by = `Decided by ${agentLabel(item.answer.by)}`
    return item.answer.note ? `${by} · ${item.answer.note}` : by
  }
  // each environment's mark, and why one refused it: all a secret's card ever shows of it
  if (item.answer.choice === "provided") {
    const results = (item.answer.results ?? []).map((result) =>
      result.exitCode === 0
        ? `${result.environment} ✓`
        : `${result.environment} ✗ ${result.line ?? (result.exitCode === null ? "stopped by a signal" : `exit ${result.exitCode}`)}`,
    )
    return ["Provided", ...results].join(" · ")
  }
  // his words, being carried out by its poster until it is closed, which the light says
  if (item.answer.choice === "replied")
    return item.answer.said ? `You: "${item.answer.said}"` : "You replied"
  const who = agentLabel(takenBy(item))
  let done = {
    approve: pickedLine(item, item.answer),
    clear: `Archived ${fullTime(item.answer.at)}`,
    deny: pickedLine(item, item.answer),
    discard: "Discarded",
    draft: item.answer.editedText
      ? "Saved as a Slack draft with your changes"
      : "Saved as a Slack draft",
    edit: `${pickedLine(item, item.answer)} · With your changes`,
    send: item.answer.editedText ? "Sent with your changes" : "Sent",
  }[item.answer.choice]
  const uploaded = item.answer.uploaded
  if (uploaded) done += ` · ${filesCount(uploaded)} shared`
  const delivery = item.delivery
  const failed =
    delivery?.status !== "failed"
      ? null
      : delivery.code === "LOST"
        ? `Lost: ${delivery.reason}`
        : sendUnconfirmed(item)
          ? `Send unconfirmed: whether ${who} has it is not known`
          : `Send failed: ${delivery.reason}`
  // a step the dashboard ran says what it gave, the card's whole result, and why its poster was not told when that failed; a grant that opened its pane says so, then waits on its poster's recheck
  const step = stepLine(stepsOf(item.answer))
  if (step) return failed ? `${done} · ${step} · ${failed}` : `${done} · ${step}`
  const { opened } = stepsOf(item.answer)
  if (opened) done += ` · ${opened.line.charAt(0).toUpperCase()}${opened.line.slice(1)}`
  // Claude Code holds it until the session is free, whatever the answer
  if (delivery?.status === "queued") return `${done} · Queued for ${who}`
  if (failed) return `${done} · ${failed}`
  return item.answer.noLink ? `${done} · No link: ${item.answer.noLink}` : done
}

// Pure: the result line of a step the dashboard ran on Approve that leaves its poster nothing to do: an accept's, a clone's, an apps change's, an own flag's, a root step's, a guard setting's, or a grant that opened nothing; null for any other answer.
const stepLine = (answer: Steps): string | null => {
  const { accepted, cloned, listed, opened, owned, rooted, set } = answer
  if (accepted)
    return accepted.exitCode === 0
      ? `Accepted: ${accepted.line}`
      : `Accept failed (exit ${accepted.exitCode}): ${accepted.line}`
  if (cloned)
    return cloned.exitCode === 0
      ? `Cloned: ${cloned.line}`
      : `Clone failed (exit ${cloned.exitCode}): ${cloned.line}`
  if (listed)
    return listed.exitCode === 0
      ? `Your apps: ${listed.line}`
      : `Apps change failed (exit ${listed.exitCode}): ${listed.line}`
  if (owned)
    return owned.exitCode === 0
      ? `Own account: ${owned.line}`
      : `Own account change failed (exit ${owned.exitCode}): ${owned.line}`
  if (rooted)
    return rooted.exitCode === 0
      ? `Ran as root: ${rooted.line}`
      : `Root step failed (exit ${rooted.exitCode}): ${rooted.line}`
  if (set)
    return set.exitCode === 0
      ? `Guard setting: ${set.line}`
      : `Guard setting failed (exit ${set.exitCode}): ${set.line}`
  if (opened && opened.exitCode !== 0)
    return `Opening System Settings failed (exit ${opened.exitCode}): ${opened.line}`
  return null
}

// Pure: what a link points to, named from the link itself when its poster gave no label: a Linear ticket's ID, a pull request or issue as owner/repo#N, Open thread for a Slack link, else the site.
const linkName = (url: URL): string => {
  const host = url.hostname
  if (host === "slack.com" || host.endsWith(".slack.com")) return "Open thread"
  if (host === "linear.app")
    return /\/issue\/([a-z][a-z0-9]*-\d+)/i.exec(url.pathname)?.[1]?.toUpperCase() ?? "Linear"
  const github =
    host === "github.com" && /^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url.pathname)
  if (github) return `${github[1]}/${github[2]}#${github[3]}`
  const compare = host === "github.com" && /^\/([^/]+)\/([^/]+)\/compare\//.exec(url.pathname)
  return compare ? `${compare[1]}/${compare[2]} compare` : host
}

// Pure: a link the dashboard opens, https alone; null for anything else.
const httpsUrl = (link?: string): URL | null => {
  if (!link) return null
  try {
    const url = new URL(link)
    return url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

// Pure: where an item will land, given upfront, for its place line: a draft's thread as Open thread, a slack, ship or ticket decision's place by its link's name, or why there is none yet; null once its poster's ack links where it landed, which the result line shows instead.
export function upfrontLink(
  item: InboxItem,
): { href: string; label: string } | { reason: string } | null {
  if (item.kind === "update" || chosen(item)?.link) return null
  const preview = item.preview
  if (item.kind === "decision" && !(PLACED_TYPES as readonly string[]).includes(item.preview.type))
    return null
  const url = httpsUrl("link" in preview ? preview.link : undefined)
  if (url) return { href: url.href, label: item.kind === "draft" ? "Open thread" : linkName(url) }
  return "noLink" in preview && preview.noLink ? { reason: preview.noLink } : null
}

// The decisions whose preview names where they land, the API's PLACED_TYPES restated (a test holds the two equal).
export const PLACED_TYPES = ["ship", "slack", "ticket"] as const

// Pure: where an answered item was carried out, named for what was done: the poster's https URL and its label, else a name drawn from the link; null without one.
export function resultLink(item: InboxItem): { href: string; label: string } | null {
  if (item.kind === "update") return null
  const answer = chosen(item)
  const url = httpsUrl(answer?.link)
  if (!url) return null
  return { href: url.href, label: answer?.linkLabel ?? linkName(url) }
}

// Pure: the oldest open decision or draft a session posted, which it depends on, so it reads Waiting on your inbox, with the orange eye, linked to that item; null when it posted none still open, or is a probe, which waits on its spawner, never the owner.
export function inboxWaitOf(
  items: readonly InboxItem[],
  name: string,
): { id: string; ref: number } | null {
  if (isProbe(name)) return null
  const open = items
    .filter(
      (item) =>
        item.from === name &&
        item.kind !== "update" &&
        item.status === "open" &&
        chosen(item)?.choice !== "replied",
    )
    .sort((a, b) => a.ref - b.ref)[0]
  return open ? { id: open.id, ref: open.ref } : null
}

// Pure: the sessions waiting on an open decision or draft they posted, probes left out; a reply took the item off the owner's hands, so its poster reads there no more.
export const inboxPosters = (items: readonly InboxItem[]): Set<string> =>
  new Set(
    items
      .filter(
        (item) =>
          item.kind !== "update" &&
          item.status === "open" &&
          chosen(item)?.choice !== "replied" &&
          !isProbe(item.from),
      )
      .map((item) => item.from),
  )

// Pure: whether a link's anchor (needs-you-<id>) names an item the inbox holds, so the view opens its Inbox tab to show it.
export const inboxTarget = (anchor: string, items: readonly InboxItem[]): boolean => {
  const prefix = needsYouAnchor("")
  return anchor.startsWith(prefix) && items.some((item) => item.id === anchor.slice(prefix.length))
}

// Pure: the shut shelf an asked-for card waits on, opened for a click alone; null for none.
export const shelfToOpen = (
  anchor: string,
  source: TargetSource,
  shelves: readonly (readonly [Shelf, unknown, readonly InboxItem[]])[],
  open: readonly string[],
): Shelf | null => {
  const shelf = shelves.find(([, , list]) =>
    list.some((item) => needsYouAnchor(item.id) === anchor),
  )?.[0]
  return source === "click" && shelf && !open.includes(shelf) ? shelf : null
}

// Pure: a decision's rows as its card shows them (choicesOf), or null for a secret and any other item.
export const decisionChoices = (item: InboxItem): Choices | null =>
  item.kind === "decision" ? choicesOf(item.preview) : null

// Pure: the result line's lead for a pick, the option as the card showed it: a multi-question ask by each question's pick, a lettered row by its letter and label, a yes or no by its side and its own label, and a bare Approve or Deny where the row says no more.
function pickedLine(
  item: InboxItem,
  answer: { choice: string; option?: number; options?: number[] },
): string {
  if (answer.options && item.kind === "decision") {
    const picks = picksOf(item.preview, answer.options)
    if (picks) return picks.map((p) => `${p.letter}. ${p.label}`).join(" · ")
  }
  const side = answer.choice === "deny" ? "Deny" : "Approve"
  const row = item.kind === "decision" ? rowOfAnswer(item.preview, answer) : null
  if (!row) return side
  if (decisionChoices(item)?.shape === "letters") return `${row.letter} · ${row.label}`
  return row.label === side ? side : `${side} · ${row.label}`
}
