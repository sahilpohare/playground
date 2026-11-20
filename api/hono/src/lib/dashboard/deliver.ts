import { readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { SESSION_MODELS, storedAs } from "@packages/config/console"
import {
  activity,
  db,
  dashboardMessageSummary,
  recordActivity,
  type ActivityActor,
  type ActivityEvent,
} from "@packages/db"
import { and, eq, inArray } from "drizzle-orm"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import {
  ATTACHED_LABEL,
  MAX_ATTACHMENTS,
  withAttachments,
  type Attachment,
} from "@/lib/dashboard/attachments"
import { configDir, readsLive } from "@/lib/dashboard/fixture"
import {
  pressEnter,
  prompt,
  promptOnScreen,
  promptOutcome,
  switchKeys,
  typeKeys,
  type KeyStep,
} from "@/lib/dashboard/herdr"
import { settingCommand, settingSummary, type SessionSetting } from "@/lib/dashboard/setting"
import { readScreen } from "@/lib/dashboard/terminal"
import { readTail, TEXT_LIMIT, type Entry } from "@/lib/dashboard/transcript"
import { listLive, type Live, type Worker } from "@/lib/dashboard/workers"
import type { ErrorCode } from "@/lib/error"

// What to deliver: `to` is the session's name as the dashboard lists it (Worker.name), `text` is what to say, `attachments` the stored files it carries (findAttachment's, so each path is one the dashboard made), and `actor` is who says it, the signed-in person for a route. `id`, the composer's own for the message, becomes its activity row's id, so a retry of a request that went unanswered finds the message delivered rather than typing it again.
export type Delivery = {
  actor: ActivityActor
  attachments?: Attachment[]
  id?: string
  // When an earlier try of this id read QUEUED, as the outbox recorded it, so an API that restarted since, and lost its own record, reads the message again rather than typing it twice.
  queuedAt?: string
  // A model or effort the composer's pickers set for a dispatcher or the assistant: its one slash command is typed in place of `text`, and recorded as a dashboard.setting row.
  setting?: SessionSetting
  text: string
  to: string
}

// Pure: the words a delivery types and the refusal they meet, judged on the normalized text; a setting's command is built from fixed lists, so it alone passes as a command, with no skill check.
export const deliveryWords = (
  delivery: Pick<Delivery, "attachments" | "setting" | "text">,
  skillLater = false,
): { refused: Refusal | null; skill: string | null; words: string } => {
  if (delivery.setting) {
    return { refused: null, skill: null, words: settingCommand(delivery.setting) }
  }
  const words = normalize(delivery.text)
  return {
    refused: refusal(words, delivery.attachments?.length ?? 0, skillLater),
    skill: skillLater ? skillCommand(words) : null,
    words,
  }
}

// The activity row a delivery records: a setting told whole, a message by its size alone.
export const deliveryEvent = (
  delivery: Pick<Delivery, "actor" | "attachments" | "id" | "setting">,
  to: string,
  words: string,
): ActivityEvent =>
  delivery.setting
    ? {
        action: "dashboard.setting",
        actor: delivery.actor,
        id: delivery.id,
        summary: settingSummary(to, delivery.setting),
      }
    : {
        action: "dashboard.message",
        actor: delivery.actor,
        id: delivery.id,
        summary: dashboardMessageSummary(
          to,
          words,
          (delivery.attachments ?? []).map((file) => file.size),
        ),
      }

// Why a delivery did not happen, or has not yet. BUSY, INPUT_NOT_EMPTY, NOT_FOUND, ON_PICKER and SESSIONS_FAILED come before anything is typed (BUSY: a model switch to a session working a turn or compacting, whose confirm would come with no one to answer it, or its own paste such a session held, cleared) (SESSIONS_FAILED includes a send herdr refused before sending anything, tried twice here), so they can succeed on a retry once the session or herdr changes, but for an INPUT_NOT_EMPTY marked `pasted`, whose message sits unsent in the box for its retry to press Enter on; AMBIGUOUS, COMMAND, EMPTY and TOO_LONG cannot until the text or the names change. INTERRUPTED means typing began and did not finish, or a held message left the screen with a transcript that cannot be read back to when it was queued: some or all of the message may be in the session's input or already sent, so it is never retried unseen. QUEUED means Claude Code holds a herdr session's message, in its box while it compacts or in its queue while it works, and takes it on its own: a retry under the same id types nothing and reads it again, and LOST is that retry finding it neither on the screen nor in the transcript QUEUED_MS after it was queued, so Retry sends it again.
export const DELIVERY_FAILURES = [
  "AMBIGUOUS",
  "BUSY",
  "COMMAND",
  "EMPTY",
  "INPUT_NOT_EMPTY",
  "INTERRUPTED",
  "LOST",
  "NOT_FOUND",
  "ON_PICKER",
  "QUEUED",
  "SESSIONS_FAILED",
  "TOO_LONG",
] as const

export type DeliveryFailure = (typeof DELIVERY_FAILURES)[number]

// How a route reports each refusal: its HTTP status and the API's error code, with the reason's own code under `delivery`.
export const FAILURE_STATUS: Record<DeliveryFailure, [ContentfulStatusCode, ErrorCode]> = {
  AMBIGUOUS: [409, "CONFLICT"],
  BUSY: [409, "CONFLICT"],
  COMMAND: [400, "VALIDATION_ERROR"],
  EMPTY: [400, "VALIDATION_ERROR"],
  INPUT_NOT_EMPTY: [409, "CONFLICT"],
  INTERRUPTED: [502, "SESSIONS_FAILED"],
  LOST: [409, "CONFLICT"],
  NOT_FOUND: [404, "NOT_FOUND"],
  ON_PICKER: [409, "CONFLICT"],
  QUEUED: [409, "CONFLICT"],
  SESSIONS_FAILED: [502, "SESSIONS_FAILED"],
  TOO_LONG: [400, "VALIDATION_ERROR"],
}

// How long a queued message may be gone from the screen with no transcript line before it reads lost: the longest compaction measured took 411s (3,224 compactions in this machine's transcripts on 3 Nov, p99 199s), so 10 minutes covers it with room.
export const QUEUED_MS = 10 * 60_000

// `at` is when the delivery finished, its Enter typed and its activity row written (for a retry answered by its row, when that row's transaction began, and `replayed` set); `reason` is a sentence to show as it is. `pasted` marks an INPUT_NOT_EMPTY whose message sits pasted and unsent in the box, which its retry presses Enter on, so a thread it opened is kept for that retry.
export type DeliveryResult =
  | { at: string; ok: true; replayed?: true; sessionId: string }
  | { code: DeliveryFailure; ok: false; pasted?: true; queuedAt?: string; reason: string }

export const MAX_CHARS = 8000
export const MAX_LINES = 100
// A tab would autocomplete and a control character is a keystroke, so the text arrives with tabs as four spaces, line ends as \n and no other control character (C0, DEL or C1), trimmed.
export const normalize = (text: string): string =>
  [...text.replace(/\r\n?/g, "\n").replaceAll("\t", "    ")]
    .filter((ch) => ch === "\n" || !/\p{Cc}/u.test(ch))
    .join("")
    .trim()

type Refusal = Extract<DeliveryResult, { ok: false }>

const refused = (code: DeliveryFailure, reason: string): Refusal => ({
  code,
  ok: false,
  reason,
})

// A leading / runs a slash command and a leading ! a shell command, in a session that bypasses permission prompts; invisible characters before one (a zero-width space, a word joiner) could be dropped on the way, so they are looked past.
export const COMMAND_START = /^[\p{Cf}\p{Z}\s]*[/!]/u

// A skill's command, as Claude Code takes it: a / at the very start, then a skill folder's name, then a space, a new line or the end. Anything else after the / (a capital, a dot, a slash, an invisible character) is no skill's name.
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/
const SKILL_COMMAND = /^\/([a-z0-9][a-z0-9-]*)(?=[ \n]|$)/

// The skill a message would run, or null when it is not one skill's command.
export const skillCommand = (text: string): string | null => SKILL_COMMAND.exec(text)?.[1] ?? null

const BANG_ROUTE = "Type a ! command in the dispatcher's terminal window."

const commandRefusal = (skill?: string): Refusal =>
  refused(
    "COMMAND",
    skill
      ? `/${skill} is not a skill this session can run, and any other / or ! would run as a command in the session, so it is not typed.`
      : `A message starting with / or ! would run as a command in the session, so it is not typed. ${BANG_ROUTE}`,
  )

// What the dashboard will not type, judged on the normalized text; `files` is how many attachments come with it, since files alone are something to send. With `skillLater`, a skill's command passes, for deliver() to check against the session's own skills once it is found; every other command is refused.
export const refusal = (text: string, files = 0, skillLater = false): Refusal | null => {
  if (!text && !files) return refused("EMPTY", "There is nothing to send.")
  if (files > MAX_ATTACHMENTS) {
    return refused("TOO_LONG", `A message carries at most ${MAX_ATTACHMENTS} files.`)
  }
  if (text.length > MAX_CHARS) {
    return refused("TOO_LONG", `A message holds at most ${MAX_CHARS} characters.`)
  }
  if (text.split("\n").length > MAX_LINES) {
    return refused("TOO_LONG", `A message holds at most ${MAX_LINES} lines.`)
  }
  if (COMMAND_START.test(text) && !(skillLater && skillCommand(text))) {
    return commandRefusal()
  }
  return null
}

// The skills a person may run as a command, from each folder given: a folder named as a skill is, holding a SKILL.md that resolves (through a symlink too) to a regular file whose frontmatter reads and does not say `user-invocable: false`. A message's words never become a path here: they are only looked up in what is read.
export async function readSkills(dirs: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [])
    for (const name of names) {
      if (!SKILL_NAME.test(name)) continue
      try {
        const file = await realpath(join(dir, name, "SKILL.md"))
        if (!(await stat(file)).isFile()) continue
        const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(await Bun.file(file).text())
        if (!front) continue
        const meta: unknown = Bun.YAML.parse(front[1] ?? "")
        if (typeof meta !== "object" || meta === null) continue
        if ((meta as Record<string, unknown>)["user-invocable"] === false) continue
        found.add(name)
      } catch {
        continue
      }
    }
  }
  return found
}

// Where a session's skills live: Claude Code's own skills folder, and the session's project's when its cwd is known, since an empty or relative one would name a folder of the API's own. A fixture's cwds are made up, so a stack that does not read this machine reads its config folder alone.
export const skillDirs = (cwd: string, config: string, live: boolean): string[] => [
  join(config, "skills"),
  ...(live && isAbsolute(cwd) ? [join(cwd, ".claude", "skills")] : []),
]

// The skills a session may run as a command: what deliver() checks a / against, and what the composer's / menu offers.
export const sessionSkills = (cwd: string): Promise<Set<string>> =>
  readSkills(skillDirs(cwd, configDir(), readsLive()))

const RULE = /^─+$/
const NAMED_RULE = /^─.*─$/
// While messages wait in its queue, Claude Code fills its empty box with one of these dim hints (its prompt input's placeholder, 2.1.309) and draws the messages themselves above the box; the screen read drops the dimming, so a hint is matched whole.
const QUEUED_HINTS = new Set([
  "Press up to edit queued messages",
  "Press up to edit queued messages, Enter to send them immediately",
  "Press up to select a queued message to edit, or Enter to send them now",
  "Press up to select a queued message, then Enter to edit it",
])

// Text as one line, every run of spaces (a no-break one and a line end too) one space, so a box wrapped in a narrow pane reads as its words.
const flat = (text: string): string => text.replace(/\s+/g, " ").trim()

// The box's words after its ❯ prompt, or null when it does not open on one (shell mode's !).
const boxWords = (box: string[]): string | null =>
  box[0]?.startsWith("❯") ? flat(box.join(" ").slice(1)) : null

// A queue hint as a pane narrower than it draws it, cut off at the edge with an ellipsis (an 18-column pane drew "Press up to edi…" after every send to it while busy).
const cutHint = (box: string[], words: string): boolean =>
  box.length === 1 &&
  words.length > 1 &&
  words.endsWith("…") &&
  [...QUEUED_HINTS].some((hint) => hint.startsWith(words.slice(0, -1).trimEnd()))

// What a session's input box holds, as the screen read shows it between the last two rules on the screen: only its ❯ prompt or a queue hint (empty), anything more (a draft, which would be sent with the message, a ! or an open / menu, which would run it, or a picker framed by rules, which ON_PICKER normally catches first), or no rules to frame a box at all (missing: a Claude Code whose layout has changed).
export const inputState = (screen: string): "empty" | "holds" | "missing" => {
  const box = inputBox(screen)
  if (!box) return "missing"
  const words = boxWords(box)
  if (words === null) return "holds"
  return (box.length === 1 && words === "") || QUEUED_HINTS.has(words) || cutHint(box, words)
    ? "empty"
    : "holds"
}

const IMAGE_MARK = /\[Image #\d+\]/g
// Claude Code 2.1.309 folds a paste of more characters than this, or more than 2 line breaks
const FOLD_CHARS = 800

// Pure: whether the box holds this message whole and unsent, as Claude Code draws a paste of it: each image's path taken in as an [Image #n] mark, one per image, and nothing more or less, or the [Pasted text #n +k lines] a long paste folds into beside those marks, whose k counts the paste's line breaks, for a paste long enough to fold. Anything else in it is someone's draft.
export const holdsUnsent = (screen: string, text: string, images: string[]): boolean => {
  const box = inputBox(screen)
  const words = box ? boxWords(box) : null
  if (!words || (words.match(IMAGE_MARK) ?? []).length !== images.length) return false
  const left = flat(words.replace(IMAGE_MARK, " "))
  const fold = /^\[Pasted text #\d+(?: \+(\d+) lines)?\]$/.exec(left)
  const breaks = (text.match(/\n/g) ?? []).length
  if (fold) return (text.length > FOLD_CHARS || breaks > 2) && Number(fold[1] ?? 0) === breaks
  const pasted = images.reduce((rest, path) => rest.replace(path, ""), text)
  return left === flat(pasted)
}

// How a herdr session's box is read after the send: up to 8 reads 150ms apart, 1.2s in all, the first after one gap, so Claude Code has drawn the paste or taken the Enter.
export const SETTLE_GAP_MS = 150
export const SETTLE_READS = 8
// How long the model menu's switch reads the pane for its end state: up to 40 reads SETTLE_GAP_MS apart, 6s in all, since a confirm drawn over the box comes first and the status line redraws after the switch.
export const SWITCH_READS = 40

// Whether something other than the input box sits where it shows: no box framed by rules, or one that does not open on its ❯ prompt, as a prompt drawn over it reads.
const coveredBox = (screen: string): boolean => {
  const box = inputBox(screen)
  return !box || boxWords(box) === null
}

// The status line: the lines below the input box's bottom rule, as one line.
const statusLine = (screen: string): string => {
  const lines = screen.split("\n").map((line) => line.trimEnd())
  return flat(lines.slice(lines.findLastIndex((line) => RULE.test(line)) + 1).join(" "))
}

// The model the session's status line names, by its alias followed by its version (Opus 5.5 reads opus), so a folder or branch named for a model is not one; null when it names none, or no box shows, since a prompt drawn over the box names models of its own.
const statusModel = (screen: string): string | null => {
  if (!inputBox(screen)) return null
  const status = statusLine(screen)
  return SESSION_MODELS.find((alias) => new RegExp(`\\b${alias} \\d`, "i").test(status)) ?? null
}

const cut = (words: string): string => (words.length > 300 ? `${words.slice(0, 299)}…` : words)

// Pure: what the pane shows, in words for a refusal to name: the status line under an empty box, the words a box holds, or, with no box, the lines below the last rule (a prompt drawn over the box), else the last 3 lines.
const shownOn = (screen: string): string => {
  const lines = screen.split("\n").map((line) => line.trimEnd())
  const box = inputBox(screen)
  if (box && inputState(screen) === "empty")
    return `its status line reads "${cut(statusLine(screen))}"`
  if (box) return `its input holds "${cut(boxWords(box) ?? flat(box.join(" ")))}"`
  const rule = lines.findLastIndex((line) => NAMED_RULE.test(line))
  const below = (rule >= 0 ? lines.slice(rule + 1) : lines).filter((line) => line.trim())
  return `its pane shows "${cut(flat((rule >= 0 ? below : below.slice(-3)).join(" ")))}"`
}

// The lines between the last two rules on the screen, or null when no rules frame a box.
const inputBox = (screen: string): string[] | null => {
  const lines = screen.split("\n").map((line) => line.trimEnd())
  const bottom = lines.findLastIndex((line) => RULE.test(line))
  const top = lines.findLastIndex((line, i) => i < bottom && NAMED_RULE.test(line))
  return bottom < 1 || top < 0 ? null : lines.slice(top + 1, bottom)
}

// Pure: whether the input box starts as this message does, as Claude Code draws a paste: its first line (cut at the screen's edge), or the [Pasted text #n] or [Image #n] it folds a long paste or an image's path into.
export const holdsMessage = (screen: string, text: string): boolean => {
  const box = inputBox(screen)
  const first = (box?.[0] ?? "").replace(/^❯\s*/, "").trim()
  if (!box || !first) return false
  if (/^\[(?:Pasted text|Image) #\d+/.test(boxWords(box) ?? first)) return true
  const start =
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  return start !== "" && (start.startsWith(first) || first.startsWith(start))
}

// The lines above the input box's top rule, or none when no rules frame a box.
const aboveBox = (screen: string): string[] => {
  const lines = screen.split("\n").map((line) => line.trimEnd())
  const bottom = lines.findLastIndex((line) => RULE.test(line))
  const top = lines.findLastIndex((line, i) => i < bottom && NAMED_RULE.test(line))
  return bottom < 1 || top < 0 ? [] : lines.slice(0, top)
}

// The first line of a message's words, as a box or a queue draws it.
const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((line) => line.trim() && !line.startsWith(ATTACHED_LABEL))
    ?.trim() ?? ""

// Whether the spinner above the box says Claude Code compacts.
const compacting = (screen: string): boolean =>
  aboveBox(screen).some((line) => line.includes("Compacting conversation"))

// Pure: whether Claude Code holds the message to take on its own: in its box while its spinner says it compacts (its "Compacting conversation" status), or drawn in its queue above a box showing a queue hint while it works. Either goes once the session is free, so it reads queued rather than failed.
export const holdsQueued = (screen: string, text: string): boolean => {
  const above = aboveBox(screen)
  if (compacting(screen)) {
    return holdsMessage(screen, text)
  }
  const start = firstLine(text)
  const box = inputBox(screen)
  const words = box ? boxWords(box) : null
  const hinted = box !== null && words !== null && (QUEUED_HINTS.has(words) || cutHint(box, words))
  return (
    hinted &&
    start !== "" &&
    above.some((line) => {
      const drawn = line.replace(/^❯\s*/, "").trim()
      return (
        line.startsWith("❯") && drawn !== "" && (start.startsWith(drawn) || drawn.startsWith(start))
      )
    })
  )
}

// `board` finds the session a name names, from the board the dashboard already streams; `readSession` reads the board again before the session is typed into, and before the Enter. `prompt` sends a herdr session its whole message in one call, and `pressEnter` one Enter when that call's own did not land (herdr.ts); `wait` sleeps between the reads of its box after the send, and `said` reads a session's transcript, its tail as readTail bounds it.
export type DeliverDeps = {
  board: () => Promise<Live>
  delivered: (id: string) => Promise<Date | null>
  now: () => Date
  pressEnter: (surface: string) => Promise<void>
  prompt: (surface: string, text: string) => Promise<void>
  readScreen: (surface: string) => Promise<string>
  readSession: (worker: Worker) => Promise<Live>
  record: (event: ActivityEvent, typing: () => Promise<void>) => Promise<void>
  said: (worker: Worker) => Promise<Entry[]>
  skills: (cwd: string) => Promise<ReadonlySet<string>>
  typeKeys: (surface: string, steps: KeyStep[]) => Promise<void>
  wait: (ms: number) => Promise<void>
}

// The record and the send share a transaction: a send herdr refuses rolls the record back, and a record that cannot be inserted means nothing is typed.
const recordWhileTyping: DeliverDeps["record"] = (event, typing) =>
  db.transaction(async (tx) => {
    await recordActivity(tx, event)
    await typing()
  })

// The rows a delivery records under its id: a message's and a setting's.
export const DELIVERED_ACTIONS = [
  ...storedAs("dashboard.message"),
  ...storedAs("dashboard.setting"),
]
// When the message or setting with this id was recorded, if it was: its row commits with its Enter, so a row means it went.
const deliveredAt: DeliverDeps["delivered"] = async (id) => {
  const [row] = await db
    .select({ at: activity.createdAt })
    .from(activity)
    .where(and(eq(activity.id, id), inArray(activity.action, DELIVERED_ACTIONS)))
  return row?.at ?? null
}

export const deliverDeps: DeliverDeps = {
  // The hub's newest board, without waiting on a refresh in flight, or a fresh read when it has none or it was cut short; hub.ts imports this module through sdk.ts, so it is loaded when first needed
  board: async () => {
    const shown = (await import("@/lib/dashboard/hub")).dashboardHub.snapshot
    return shown && !shown.partial ? shown : listLive()
  },
  delivered: deliveredAt,
  now: () => new Date(),
  pressEnter,
  prompt,
  readScreen: (surface) => readScreen(surface, 40),
  readSession: listLive,
  record: recordWhileTyping,
  said: async (worker) => {
    const path = (await listLive()).transcripts.get(worker.sessionId)
    return path ? readTail(path, Number.POSITIVE_INFINITY) : []
  },
  skills: sessionSkills,
  typeKeys,
  wait: (ms) => Bun.sleep(ms),
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// A send that failed: `typed` 0 with no Enter means herdr sent nothing, and `atEnter` that it failed at or after the Enter, so the message may have gone.
class TypingFailed extends Error {
  constructor(
    readonly typed: number,
    readonly atEnter: boolean,
    cause: unknown,
  ) {
    super(messageOf(cause))
  }
}

// Where typing stood when it stopped: `nothing` before the first text, or `held` when the refusal's reason already says where the message stands (both stand as they are), `typed` once all of it was but not the Enter.
class TypingStopped extends Error {
  constructor(
    readonly result: Refusal,
    readonly stood: "held" | "nothing" | "typed" = "typed",
  ) {
    super(result.reason)
  }
}

// herdr refused a first send before sending anything, so nothing was typed, and a later try can pass.
class BeforeTyping {
  constructor(readonly message: string) {}
}

// Two deliveries to one session would each pass the screen check before either sends, so each session's deliveries run one at a time, from reading its screen to its send. The queue is this process's own: a second dashboard stack (a worktree's test stack beside the live dashboard) sends to the same pane independently.
const typingLines = new Map<string, Promise<unknown>>()

// The dashboard's own last pastes into each herdr session, newest last: a later try that finds one unsent in the box (its Enter lost, though its own settle read the box empty before the paste was drawn) presses Enter on it rather than reading it as a draft. `unsent` holds the ids a try left pasted and unsent until one is delivered, so their retry that finds the box empty never pastes them twice. Both are this process's own, as typingLines is, so a restart forgets them.
export type Paste = { at: number; id?: string; images: string[]; text: string }
// A transcript's clock and the API's can differ by a moment.
const SAID_SLACK_MS = 5000

// Pure: whether the session's transcript shows the paste went, a person's message since it opening on its first line of words, or holding that line's start where the transcript clipped it at TEXT_LIMIT (or, for files alone, carrying files): true, and a box holding it again is the owner's recall (Up brings an earlier message back), never the dashboard's unsent paste; false only when the entries read reach back past the paste and none is it; null when they do not reach back that far, so whether it went is not known.
export const wentIn = (entries: Entry[], paste: Paste): boolean | null => {
  const since = paste.at - SAID_SLACK_MS
  const first = flat(
    paste.text.split("\n").find((line) => line.trim() && !line.startsWith(ATTACHED_LABEL)) ?? "",
  )
  const opens = (said: string): boolean =>
    flat(said.replace(IMAGE_MARK, " ")).startsWith(first) ||
    (said.length === TEXT_LIMIT &&
      said.endsWith("…") &&
      first.startsWith(flat(said.slice(0, -1).replace(IMAGE_MARK, " "))))
  const went = entries.some(
    (entry) =>
      entry.kind === "human" &&
      Date.parse(entry.at) >= since &&
      (first ? opens(entry.text) : (entry.attachments?.length ?? 0) > 0),
  )
  if (went) return true
  const oldest = entries[0]
  return oldest && Date.parse(oldest.at) <= since ? false : null
}
const PASTES_KEPT = 5
const pastes = new Map<string, Paste[]>()
const unsent = new Set<string>()
// The messages Claude Code held when their try ended (QUEUED), by id, with when they were pasted, so a retry reads them again rather than pasting them twice; this process's own, as `unsent` is.
const queued = new Map<string, number>()
// Per session, the message with an id whose box read empty after its paste with nothing to show it went, by id and when it was pasted: it may sit undrawn with its Enter lost, so no other message is pasted there until it shows, goes or ages past QUEUED_MS, whichever path sends it (the composer's outbox or an Inbox answer).
const unproven = new Map<string, { at: number; id: string }>()
const proven = (sessionId: string, id: string | undefined): void => {
  if (id && unproven.get(sessionId)?.id === id) unproven.delete(sessionId)
}

const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const next = (typingLines.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => {})
  typingLines.set(key, settled)
  void settled.then(() => {
    if (typingLines.get(key) === settled) typingLines.delete(key)
  })
  return next
}

// The live sessions a name reaches, and the one a message to it goes to. Of two or more named for the dispatcher, the read has already given the role to the oldest alone (workers.ts), so that one; any other name reaches its one session, or none when two share it.
function reached(workers: Worker[], to: string): { count: number; worker: Worker | undefined } {
  const named = workers.filter((w) => w.name === to)
  const worker =
    named.find((w) => w.role === "dispatcher") ?? (named.length === 1 ? named[0] : undefined)
  return { count: named.length, worker }
}

// A retry of a message already recorded under its id, answered from its row: the session is found by name alone, as a send finds it, so one now on a picker still answers it, while an ended or doubled name leaves it to the usual refusals.
async function recorded(delivery: Delivery, deps: DeliverDeps): Promise<DeliveryResult | null> {
  const at = delivery.id ? await deps.delivered(delivery.id) : null
  if (!at) return null
  let live: Live
  try {
    live = await deps.board()
  } catch {
    return null
  }
  const { worker } = reached(live.workers, delivery.to)
  return worker
    ? { at: at.toISOString(), ok: true, replayed: true, sessionId: worker.sessionId }
    : null
}

type Target = { surface: string; worker: Worker }

// The named session as the read shows it, or why it cannot take a message. A read cut short (a herdr server or pane that did not answer whole) that misses the name is read once more, and still missing it is a failed read, never a session gone, so no answer is relayed past a poster that is still live.
async function target(to: string, read: () => Promise<Live>): Promise<Refusal | Target> {
  let live: Live
  let found: ReturnType<typeof reached>
  let tries = 0
  do {
    try {
      live = await read()
    } catch (error) {
      return refused("SESSIONS_FAILED", `Could not read the sessions: ${messageOf(error)}`)
    }
    found = reached(live.workers, to)
  } while (!found.count && live.partial && ++tries < 2)
  if (!found.count && live.partial) {
    return refused(
      "SESSIONS_FAILED",
      `The sessions read was cut short (a herdr server or pane did not answer whole), so ${to} was not found; nothing was typed.`,
    )
  }
  const { count, worker } = found
  if (!count) return refused("NOT_FOUND", `No live session is named ${to}.`)
  if (!worker) return refused("AMBIGUOUS", `${count} live sessions are named ${to}.`)
  if (worker.light === "needs-you") {
    return refused(
      "ON_PICKER",
      `${worker.name} is waiting on a picker or a prompt. Answer that first: typing now would answer it instead.`,
    )
  }
  if (worker.remote) {
    return refused(
      "NOT_FOUND",
      `${worker.name} runs on another machine over ssh, so its transcript is not here to confirm a message; nothing was typed.`,
    )
  }
  const surface = live.surfaces.get(worker.sessionId)
  if (!surface) return refused("NOT_FOUND", `${worker.name} has no terminal to type into.`)
  return { surface, worker }
}

// The one way the dashboard tells a live session something, as if the owner typed it into the session's own terminal: the composer and the inbox's answers call it, and nothing else may, since nothing sends a message on the owner's behalf. It returns a refusal or a failure rather than throwing. It throws only when the activity row cannot be written: almost always on the insert, before anything is typed, but a failure at the commit comes after the Enter, so the message has gone with no row to record it. herdr refuses a send while the session waits on a prompt, but nothing here can see a key the owner presses in that terminal, or another dashboard stack typing.
export async function deliver(
  delivery: Delivery,
  deps: DeliverDeps = deliverDeps,
): Promise<DeliveryResult> {
  const attachments = delivery.attachments ?? []
  // The person's own words are judged, so a leading / or ! is a command whether or not files come with it, and the caps count only what they wrote; the files' Attached lines come on top, at most MAX_ATTACHMENTS of them. A skill's command waits for the session's own skills, read once it is found.
  const { refused: refusedText, skill, words } = deliveryWords(delivery, true)
  if (refusedText) return refusedText
  const text = withAttachments(words, attachments)
  const switching = delivery.setting && "model" in delivery.setting ? delivery.setting.model : null
  const images = attachments.filter((file) => file.kind === "image").map((file) => file.path)
  // A paste is this message's when it carries this id, or, for a message with none, these words.
  const isThis = (paste: Paste): boolean =>
    paste.id === delivery.id && (paste.id !== undefined || paste.text === text)
  const answered = await recorded(delivery, deps)
  if (answered) return answered
  const first = await target(delivery.to, deps.board)
  if (!("worker" in first)) return first
  const { sessionId } = first.worker
  // The board is read again, and only the session found decides, since the board it was found on may be a moment old.
  const own = () => deps.readSession(first.worker)
  return oneAtATime(sessionId, async () => {
    // Behind the session's line, so a retry that arrives while its first try is still typing reads the row that try commits.
    const at = delivery.id ? await deps.delivered(delivery.id) : null
    if (at) {
      proven(sessionId, delivery.id)
      return { at: at.toISOString(), ok: true, replayed: true, sessionId }
    }
    const found = await target(delivery.to, own)
    if (!("worker" in found)) return found
    if (found.worker.sessionId !== sessionId) {
      return refused("NOT_FOUND", `${delivery.to} now names another session. Send it again.`)
    }
    const { surface, worker } = found
    if (skill && !(await deps.skills(worker.cwd)).has(skill)) return commandRefusal(skill)
    const event = deliveryEvent(delivery, worker.name, words)
    const busy = (model: string, cleared = false): Refusal =>
      refused(
        "BUSY",
        `${worker.name} is working a turn or compacting, so the switch to ${model} ${cleared ? "it held was cleared" : "was not typed"}: its confirm would come with no one to answer it. Pick it again once it is idle.`,
      )
    // One try, from reading the screen to the Enter. A first send herdr refused before sending anything typed nothing and comes back as BeforeTyping, which the loop below tries once more at once, since the screen is read again and finds anything that landed after all.
    const attempt = async (): Promise<DeliveryResult | BeforeTyping> => {
      let screen: string
      try {
        screen = await deps.readScreen(surface)
      } catch (error) {
        return refused(
          "SESSIONS_FAILED",
          `Could not read ${worker.name}'s terminal: ${messageOf(error)}`,
        )
      }
      const input = inputState(screen)
      if (switching && (worker.light === "working" || compacting(screen))) return busy(switching)
      // QUEUED carries when the message was pasted, which a queued_command's stamp follows within moments, so the outbox's retry after a restart reads the transcript from there
      const stillQueued = (at: number): Refusal => ({
        ...refused(
          "QUEUED",
          `${worker.name} has the message or takes it once it is free, after a compaction or its turn: it reads Delivered once its transcript shows it.`,
        ),
        pasted: true,
        queuedAt: new Date(at).toISOString(),
      })
      // A message Claude Code held when an earlier try ended, by this process's record or, after a restart, by the outbox's queuedAt, is read again, never pasted twice: still held, it waits; gone from the screen, the transcript says it went, or, QUEUED_MS on, that it was lost when the transcript reaches back with no line, and unconfirmed when it does not. One back in the box with no compaction left goes on below, where it gets its Enter as a paste of ours.
      const told = delivery.queuedAt ? Date.parse(delivery.queuedAt) : Number.NaN
      const queuedAt = delivery.id
        ? (queued.get(delivery.id) ?? (told <= deps.now().getTime() ? told : undefined))
        : undefined
      if (delivery.id && queuedAt !== undefined) {
        if (holdsQueued(screen, text)) {
          proven(sessionId, delivery.id)
          return stillQueued(queuedAt)
        }
        if (!(input === "holds" && holdsMessage(screen, text))) {
          let went: boolean | null = null
          try {
            went = wentIn(await deps.said(worker), { at: queuedAt, images, text })
          } catch {}
          if (went) {
            queued.delete(delivery.id)
            await deps.record(event, async () => {})
            return { at: deps.now().toISOString(), ok: true, sessionId }
          }
          if (deps.now().getTime() - queuedAt < QUEUED_MS) return stillQueued(queuedAt)
          queued.delete(delivery.id)
          // a transcript that does not reach back to when it was queued, or could not be read, cannot say it never went, so it reads unconfirmed rather than lost
          if (went === null) {
            return refused(
              "INTERRUPTED",
              `${worker.name} no longer shows the message, and its transcript cannot be read back to when it was queued, so it may have gone: check it before sending it again.`,
            )
          }
          return refused(
            "LOST",
            `${worker.name} no longer shows the message, and its transcript holds no sign of it ${QUEUED_MS / 60_000} minutes after it was queued. Retry sends it again.`,
          )
        }
        queued.delete(delivery.id)
      }
      // A message an earlier try left unsent that has left the box since went by a late Enter or the owner's own, or was cleared by hand; either way it is never pasted twice.
      if (delivery.id && unsent.has(delivery.id) && input === "empty") {
        await deps.record(event, async () => {})
        return { at: deps.now().toISOString(), ok: true, sessionId }
      }
      // A paste of the dashboard's own that its Enter left in the box, this message's or an earlier one's, gets that Enter rather than reading as a draft, this held message's first, even with no paste remembered after a restart; any other text in the box is someone's. Claude Code folds a long paste into [Pasted text #n +k lines], which is taken as a paste whose line breaks k counts.
      const held =
        input === "holds"
          ? queuedAt !== undefined && holdsMessage(screen, text)
            ? { at: queuedAt, id: delivery.id, images, text }
            : (pastes.get(sessionId) ?? []).findLast((paste) =>
                holdsUnsent(screen, paste.text, paste.images),
              )
          : undefined
      // one the transcript shows went, or cannot show did not, is the owner's recall of it or may be, so it holds as a draft
      let stuck = held
      if (held) {
        try {
          if (wentIn(await deps.said(worker), held) !== false) stuck = undefined
        } catch {
          stuck = undefined
        }
      }
      if (input === "holds" && !stuck) {
        return refused(
          "INPUT_NOT_EMPTY",
          `${worker.name}'s input already holds something, or a picker covers it: a draft, or a ! or / waiting for a command, which anything typed now would join. Nothing was typed, so it can go once the box is clear.`,
        )
      }
      if (input === "missing") {
        return refused(
          "INPUT_NOT_EMPTY",
          `Cannot find ${worker.name}'s input box on its screen: something covers it, or Claude Code's layout has changed. Nothing was typed, so it can go once the box shows.`,
        )
      }
      // herdr pastes the message and then presses Enter, and Claude Code can still be taking a pasted image's path in when the Enter comes, so the Enter is lost and the message sits in the box. So the box is read after the send: empty, it went; holding this message, it gets one more Enter and is read again; holding it still, or holding text that does not start as it does, it is typed but not submitted, and no client retries it unseen, but for a message with an id still holding it, which waits as INPUT_NOT_EMPTY for its retry's Enter. The box read empty just before the send, so what it holds then is this message unless someone typed into it meanwhile. After a prompt that failed as typed (`lost`), an empty box cannot tell a message that went from one never pasted, so it stays interrupted, and the outbox reads it delivered once the transcript holds it.
      // Whether the transcript already holds the paste, read once its box reads empty: a session that took it at once, before any read saw it, writes its line.
      const tookIt = async (sent: string): Promise<boolean> => {
        try {
          return (
            wentIn(await deps.said(worker), {
              at: pastedAt ?? deps.now().getTime(),
              images,
              text: sent,
            }) === true
          )
        } catch {
          return false
        }
      }
      // The box after a send: its first empty read once the message has been seen in the box or the queue, or the transcript holds it, else its last; `seen` says whether it was. An empty read alone proves nothing: Claude Code slow under load had not drawn a paste whose Enter it then lost, so the box read empty, the message read typed, and the next one was pasted after it and went with it as one prompt.
      const settled = async (
        at: string,
        lost: unknown,
        sent: string,
        known: boolean,
      ): Promise<{ after: string; seen: boolean }> => {
        let after = ""
        let seen = known
        let asked = false
        for (let i = 0; i < SETTLE_READS; i++) {
          await deps.wait(SETTLE_GAP_MS)
          try {
            after = await deps.readScreen(at)
          } catch (error) {
            throw new TypingFailed(1, true, lost ?? error)
          }
          if (holdsQueued(after, sent) || holdsMessage(after, sent)) seen = true
          if (inputState(after) !== "empty") continue
          if (lost || seen) break
          // the transcript is read at the first empty read and the last, not at each
          if (!asked || i === SETTLE_READS - 1) {
            asked = true
            if (await tookIt(sent)) {
              seen = true
              break
            }
          }
        }
        return { after, seen }
      }
      // A box with no message of ours in it: no Enter goes into text that is not ours.
      const unseen = (after: string): TypingStopped =>
        new TypingStopped(
          refused(
            "INTERRUPTED",
            inputState(after) === "missing"
              ? `Cannot find ${worker.name}'s input box after the send, so whether the message went is not known: it reads Delivered once its transcript shows it.`
              : `${worker.name}'s input holds text that does not start as the message does, so no Enter was pressed: the message may be typed but not submitted, and it reads Delivered once its transcript shows it.`,
          ),
          "held",
        )
      // A message with an id that Claude Code holds after the send waits as QUEUED, its row left for the retry that sees it arrive; it gets no Enter, since Claude Code takes it on its own.
      // the hold is timed from the paste, not from this read after herdr's answer and the settle, since Claude Code stamps a queued_command at its Enter
      let pastedAt: number | undefined
      const queueIt = (seen: boolean): TypingStopped => {
        const now = deps.now().getTime()
        const held = pastedAt ?? now
        // an entry past the bound has settled, or its message was discarded; a retry still carries its queuedAt
        for (const [id, at] of queued) if (now - at >= QUEUED_MS) queued.delete(id)
        if (delivery.id) queued.set(delivery.id, held)
        if (seen) proven(sessionId, delivery.id)
        else if (delivery.id) unproven.set(sessionId, { at: held, id: delivery.id })
        return new TypingStopped(stillQueued(held), "held")
      }
      // `sent` is the paste the box should hold, `own` whether it is this message's, whose Enter left unsent is this message's to retry, and `known` whether the box was already seen holding it. A message with an id never seen in the box, the queue or the transcript waits as QUEUED, so the next message waits for it, and its next try presses Enter on it once Claude Code draws it.
      const submitted = async (
        at: string,
        lost: unknown,
        sent = text,
        own = true,
        known = false,
      ): Promise<void> => {
        const { after: first, seen } = await settled(at, lost, sent, known)
        if (own && delivery.id && holdsQueued(first, sent)) throw queueIt(true)
        if (inputState(first) === "empty") {
          if (lost) throw new TypingFailed(1, true, lost)
          if (!seen && own && delivery.id) throw queueIt(false)
          return
        }
        if (!holdsMessage(first, sent)) throw unseen(first)
        try {
          await deps.pressEnter(at)
        } catch (error) {
          throw new TypingFailed(1, true, error)
        }
        const { after: second } = await settled(at, lost, sent, true)
        if (own && delivery.id && holdsQueued(second, sent)) throw queueIt(true)
        if (inputState(second) === "empty") return
        if (!holdsMessage(second, sent)) throw unseen(second)
        // With an id the outbox tries it again on its own, and that try presses Enter on it, so it waits queued rather than failing in front of the owner.
        if (own && delivery.id) {
          unsent.add(delivery.id)
          throw new TypingStopped(
            {
              ...refused(
                "INPUT_NOT_EMPTY",
                `The message sits unsent in ${worker.name}'s input after one more Enter, so the next try presses Enter on it again.`,
              ),
              pasted: true,
            },
            "held",
          )
        }
        throw new TypingStopped(
          refused(
            "INTERRUPTED",
            `The message is typed but not submitted: ${worker.name}'s input still holds it after one more Enter, and it reads Delivered once its transcript shows it.`,
          ),
          "held",
        )
      }
      // The model menu's switch after its /model paste, judged by the model the session then runs, as its status line names it, never by a fixed screen text, since Claude Code may draw a confirm over the box, a reworded one or none. It presses a key only on what it has read: the one option of a prompt over the box that reads as the switch (switchKeys()), since the owner's pick is the consent, one more Enter on its own paste still in the box, and once the wait is out, a Backspace for each character of that paste, so the box ends as empty as it was. A refusal names what the pane shows.
      const switchedTo = async (model: string, at: string, lost: unknown): Promise<void> => {
        const press = async (steps: KeyStep[]): Promise<void> => {
          try {
            await deps.typeKeys(at, steps)
          } catch (error) {
            throw new TypingFailed(1, true, error)
          }
        }
        const notSwitched = (why: string): TypingStopped =>
          new TypingStopped(
            refused("INTERRUPTED", `${worker.name} did not switch to ${model}: ${why}`),
            "held",
          )
        let screen = ""
        let answered = false
        let entered = false
        for (let i = 0; i < SWITCH_READS; i++) {
          await deps.wait(SETTLE_GAP_MS)
          try {
            screen = await deps.readScreen(at)
          } catch (error) {
            throw new TypingFailed(1, true, lost ?? error)
          }
          if (holdsQueued(screen, text)) {
            if (!holdsUnsent(screen, text, [])) {
              throw notSwitched(
                "it waits in its queue behind the session's turn, and its confirm will need an answer in the session.",
              )
            }
            await press(Array.from(text, () => ({ key: "backspace" as const })))
            throw new TypingStopped(busy(model, true), "held")
          }
          const input = inputState(screen)
          if (input === "empty") {
            if (statusModel(screen) === model) return
            continue
          }
          if (input === "holds" && holdsMessage(screen, text)) {
            if (entered) continue
            entered = true
            try {
              await deps.pressEnter(at)
            } catch (error) {
              throw new TypingFailed(1, true, error)
            }
            continue
          }
          const shown = promptOnScreen(screen)
          if (answered || !coveredBox(screen) || !shown.options.some((o) => o.on)) continue
          const keys = switchKeys(shown, model)
          if (!keys) {
            throw notSwitched(
              `${shownOn(screen)}, and none of its options reads as the switch, so nothing was pressed. Answer it in the session.`,
            )
          }
          await press(keys)
          answered = true
        }
        if (holdsUnsent(screen, text, [])) {
          await press(Array.from(text, () => ({ key: "backspace" as const })))
          throw notSwitched(
            `the command sat unsent in its input after one more Enter, so it was cleared. Pick it again.`,
          )
        }
        throw notSwitched(
          `${shownOn(screen)} after ${(SWITCH_READS * SETTLE_GAP_MS) / 1000}s. Check the session before you pick again.`,
        )
      }
      try {
        await deps.record(event, async () => {
          // read once more before the send: a herdr pane's id changes when it moves, so this read names where the session is now
          const again = await target(delivery.to, own)
          if (!("worker" in again)) throw new TypingStopped(again, "nothing")
          if (again.worker.sessionId !== sessionId) {
            throw new TypingStopped(
              refused("NOT_FOUND", `${delivery.to} now names another session. Send it again.`),
              "nothing",
            )
          }
          if (stuck && isThis(stuck)) {
            pastedAt = stuck.at
            await submitted(again.surface, null, text, true, true)
            pastes.set(
              sessionId,
              (pastes.get(sessionId) ?? []).filter((paste) => paste !== stuck),
            )
            return
          }
          if (stuck) {
            try {
              await submitted(again.surface, null, stuck.text, false, true)
            } catch (error) {
              if (!(error instanceof TypingStopped || error instanceof TypingFailed)) throw error
              throw new TypingStopped(
                refused(
                  "INPUT_NOT_EMPTY",
                  `${worker.name}'s input still holds an earlier message from here after its Enter, so this one waits.`,
                ),
                "nothing",
              )
            }
            const left = (pastes.get(sessionId) ?? []).filter((paste) => paste !== stuck)
            pastes.set(sessionId, left)
            proven(sessionId, stuck.id)
          }
          const earlier = unproven.get(sessionId)
          if (earlier && earlier.id !== delivery.id) {
            if (deps.now().getTime() - earlier.at < QUEUED_MS) {
              throw new TypingStopped(
                refused(
                  "INPUT_NOT_EMPTY",
                  `${worker.name} may still be taking an earlier message from here that has not shown yet, so this one waits until it does. Nothing was typed.`,
                ),
                "nothing",
              )
            }
            unproven.delete(sessionId)
          }
          const at = deps.now().getTime()
          pastedAt = at
          let lost: unknown = null
          try {
            await deps.prompt(again.surface, text)
          } catch (error) {
            const outcome = promptOutcome(error)
            if (outcome === "picker") {
              throw new TypingStopped(
                refused(
                  "ON_PICKER",
                  `${worker.name} is waiting on a picker or a prompt, and herdr sent nothing. Answer that first.`,
                ),
                "nothing",
              )
            }
            if (outcome === "gone") {
              throw new TypingStopped(
                refused(
                  "NOT_FOUND",
                  `${worker.name}'s Claude is not running in its pane any more.`,
                ),
                "nothing",
              )
            }
            // typed: herdr may have pasted it, or pasted it and pressed Enter, before the answer was lost, so the box decides below; unsent: herdr refused before sending anything
            if (outcome !== "typed") throw new TypingFailed(0, false, error)
            lost = error
          }
          // a switch's paste is never remembered, so no later send presses Enter on a /model it left
          if (switching) return switchedTo(switching, again.surface, lost)
          // herdr took the paste, or may have, so it is remembered for a later try to find
          const kept = (pastes.get(sessionId) ?? []).filter((paste) => !isThis(paste))
          pastes.set(
            sessionId,
            [...kept, { at, id: delivery.id, images, text }].slice(-PASTES_KEPT),
          )
          await submitted(again.surface, lost)
        })
      } catch (error) {
        if (error instanceof TypingStopped) {
          if (error.stood === "nothing" || error.stood === "held") return error.result
          return refused(
            "INTERRUPTED",
            `${error.result.reason} The message is typed but not sent: it sits in ${worker.name}'s input.`,
          )
        }
        if (!(error instanceof TypingFailed)) throw error
        // A first send herdr refused before sending anything typed nothing and is tried again; one that may have sent stays INTERRUPTED, which no client retries unseen.
        if (error.typed === 0 && !error.atEnter) {
          return new BeforeTyping(error.message)
        }
        const left = error.atEnter
          ? ` The Enter may have gone through anyway: it reads Delivered once its transcript shows it.`
          : ""
        return refused("INTERRUPTED", `The message did not go through: ${error.message}${left}`)
      }
      return { at: deps.now().toISOString(), ok: true, sessionId: worker.sessionId }
    }
    // A message can get lost: a first send herdr refused before sending anything typed nothing, so deliver tries it once more at once and then the outbox retries it, on its own schedule for SESSIONS_FAILED, so it reaches the red bubble only after both; each such try is logged with the failure's own words. A send that may have landed is never retried here and is not logged (INTERRUPTED).
    let refusedBeforeTyping = ""
    for (const i of [0, 1]) {
      const result = await attempt()
      if (!(result instanceof BeforeTyping)) {
        if (delivery.id && result.ok) unsent.delete(delivery.id)
        if (result.ok || result.code !== "QUEUED") proven(sessionId, delivery.id)
        return result
      }
      refusedBeforeTyping = result.message
      console.warn(
        `Dashboard message to ${worker.name} not sent (try ${i + 1} of 2): herdr failed before anything was typed: ${result.message}${i === 0 ? "; trying again" : ""}`,
      )
    }
    return refused("SESSIONS_FAILED", `The message did not go through: ${refusedBeforeTyping}`)
  })
}
