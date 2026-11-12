import { apiClient, unwrap } from "@/lib/api/client"

// A log of how text reaches the composer, kept in this browser, so the next time dictated words never land it says why: every Cmd+V keydown on the page, heard before any handler can stop it, with where it reached, every paste on the page, a box emptied soon after a paste, every beforeinput and input in the box but plain typing, each focusout from the box, the window's blur and focus, the page's visibility and each composer mount and unmount, with where focus was, how long the page took to handle it, the clipboard's types and lengths, never the words. It leaves the browser only for this machine's own API, when a dictation misses the box (reportPasteMiss) or a page load finds a miss newer than the last one a load sent (reportPasteLoad). Read it at /dashboard?debug=paste (printed to the console) or with window.__dashboardPasteLog().
// TEMPORARY (open until the log is out): remove the log and its miss report once a reported miss is explained, or 7 days after the report reaches the live dashboard with no miss reported.
export const PASTE_LOG_KEY = "dashboard.paste-log"
export const PASTE_LOG_MAX = 200

export type PasteEvent =
  | "beforeinput"
  | "blur"
  | "emptied"
  | "focus"
  | "focusout"
  | "input"
  | "keydown"
  | "mount"
  | "paste"
  | "unmount"
  | "visibilitychange"

// Where a Cmd+V went: box, heard by the box itself; stopped, aimed at the box but stopped by a handler before it; field, another input, textarea or editable element; none, nothing that takes text.
export type Reached = "box" | "field" | "none" | "stopped"

// What emptied the box after a paste: empty-insert, the paste's words never reached the box (no input from it and no look saw them: the composer's insert left the box as it was, as the browser's own did once); remount, the box was taken down and the one that came up was empty; reset, the same box's value was set empty with no key or press of his.
export type EmptiedCause = "empty-insert" | "remount" | "reset"

// active, target and related name an element (#id when it has one of its own, else its tag and data-slot), boxLength is the box's length as the event was handled (for emptied, its length just before), cause what emptied it, delay how long after the event was made it was handled (a busy page shows here; for emptied, how long after the paste), inBox whether focus was in this composer's own box, length the text the event carries (a paste's plain text, a beforeinput's data), mount the id of the composer's mount that logged it, reached where a Cmd+V went, related where focus went on a focusout from the box, types the clipboard's item types, and visible whether the page was shown; an entry an earlier page logged reads cause, inBox, reached and visible as null.
export type PasteLogEntry = {
  active: string
  at: string
  boxLength: number
  cause: EmptiedCause | null
  delay: number
  event: PasteEvent
  inBox: boolean | null
  inputType: string | null
  length: number
  mount: string
  prevented: boolean
  reached: Reached | null
  related: string
  target: string
  types: string[]
  visible: boolean | null
}

type LogStorage = Pick<Storage, "getItem" | "setItem">

const storageOf = (): LogStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export function readPasteLog(storage: LogStorage | null = storageOf()): PasteLogEntry[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PASTE_LOG_KEY) ?? "[]")
    return Array.isArray(value) ? (value as PasteLogEntry[]) : []
  } catch {
    return []
  }
}

const time = (entry: PasteLogEntry) => Date.parse(entry.at)

// Pure: whether each entry is a miss: a Cmd+V that reached nothing taking text, one in the box with no paste within PASTE_WAIT_MS after it (logged before or after it, since a busy page or Ctrl+V's default action can log the paste first), a paste into the box that carried no text and no file, or a box emptied after a paste. An earlier page's entry, which says nothing of the box, counts the same way.
export const missesIn = (entries: PasteLogEntry[]): boolean[] =>
  entries.map((entry) => {
    if (entry.event === "emptied" || entry.reached === "none") return true
    if (entry.reached === "field" || entry.inBox === false) return false
    if (entry.event === "paste") return entry.length === 0 && !entry.types?.includes("Files")
    if (entry.event !== "keydown") return false
    return !entries.some(
      (later) =>
        later.event === "paste" &&
        time(later) >= time(entry) &&
        time(later) - time(entry) <= PASTE_WAIT_MS,
    )
  })

const NEAR_MISS_MS = 10_000

// Pure: the log cut to max entries, a miss and every entry within NEAR_MISS_MS of one kept past any number of hits, so a dictation that never landed outlives the messages sent after it; a Cmd+V the newest entry is still within PASTE_WAIT_MS of may yet get its paste, so it keeps nothing; once every entry is kept that way, the oldest go first.
const keepMisses = (entries: PasteLogEntry[], max: number): PasteLogEntry[] => {
  const excess = entries.length - max
  if (excess <= 0) return entries
  const misses = missesIn(entries)
  const newest = Math.max(...entries.map(time))
  const waits = (entry: PasteLogEntry) =>
    entry.event === "keydown" && entry.reached !== "none" && newest - time(entry) < PASTE_WAIT_MS
  const missAt = entries.filter((entry, i) => misses[i] && !waits(entry)).map(time)
  const kept = entries.map((entry) =>
    missAt.some((at) => Math.abs(time(entry) - at) <= NEAR_MISS_MS),
  )
  const drop = new Set<number>()
  for (let i = 0; i < entries.length && drop.size < excess; i += 1) if (!kept[i]) drop.add(i)
  for (let i = 0; i < entries.length && drop.size < excess; i += 1) drop.add(i)
  return entries.filter((_, i) => !drop.has(i))
}

export function logPaste(entry: PasteLogEntry, storage: LogStorage | null = storageOf()): void {
  if (!storage) return
  try {
    storage.setItem(
      PASTE_LOG_KEY,
      JSON.stringify(keepMisses([...readPasteLog(storage), entry], PASTE_LOG_MAX)),
    )
  } catch {
    // a full or blocked storage keeps no log; the composer works the same
  }
}

type Named = { getAttribute?: (name: string) => string | null; id?: string; tagName?: string }

// An id React or Base UI made up at render, which names no control.
const GENERATED_ID = /_r_/i

type Editable = { isContentEditable?: boolean; tagName?: string; type?: string }

// An input that takes no typed text, so a Cmd+V there lands nowhere.
const NO_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

// Pure: whether an element takes text, so a Cmd+V there lands somewhere.
export const takesText = (element: Editable | null | undefined): boolean =>
  !!element &&
  (element.isContentEditable === true ||
    element.tagName === "TEXTAREA" ||
    (element.tagName === "INPUT" && !NO_TEXT_INPUTS.has(element.type ?? "")))

// Pure: an element as the log names it, by an id of its own, else its tag and slot, never its text or label.
export const nameOf = (element: Named | null | undefined): string => {
  if (!element?.tagName) return "none"
  if (element.id && !GENERATED_ID.test(element.id)) return `#${element.id}`
  const slot = element.getAttribute?.("data-slot")
  return `${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}`
}

type Seen = {
  clipboardData?: { getData: (type: string) => string; types: readonly string[] } | null
  ctrlKey?: boolean
  data?: string | null
  defaultPrevented: boolean
  inputType?: string
  key?: string
  metaKey?: boolean
  relatedTarget?: unknown
  target: unknown
  timeStamp: number
  type: string
}

// The paste events the composer inserted itself (insertPaste), so the log reads their words as let into the box, never as kept from it, each with whether the box then held them, so one it did not reads empty-insert.
const insertedPastes = new WeakMap<object, boolean>()
export const markInserted = (event: object, landed: boolean) =>
  void insertedPastes.set(event, landed)

const EVENTS: PasteEvent[] = [
  "beforeinput",
  "blur",
  "emptied",
  "focus",
  "focusout",
  "input",
  "keydown",
  "mount",
  "paste",
  "unmount",
  "visibilitychange",
]

// A name as one token of at most 100 characters, as the API's report takes it.
const token = (name: string | undefined) => name?.replace(/\s+/g, "_").slice(0, 100) || "none"

// Pure: an entry in the shape the API's report takes (pasteReportSchema), so one odd event never fails a report: names as single tokens, an empty inputType as none, at most 8 clipboard types, each one token of at most 60 characters (Google Docs' own runs to 62), and an earlier page's entry with its missing fields unknown.
const reportable = (entry: PasteLogEntry): PasteLogEntry => ({
  ...entry,
  active: token(entry.active),
  cause: entry.cause ?? null,
  inBox: entry.inBox ?? null,
  inputType: entry.inputType || null,
  mount: token(entry.mount),
  reached: entry.reached ?? null,
  related: token(entry.related),
  target: token(entry.target),
  types: entry.types
    .filter((type) => /^\S+$/.test(type))
    .map((type) => type.slice(0, 60))
    .slice(0, 8),
  visible: entry.visible ?? null,
})

// A key typed or deleted in the box, which would push a miss out of the ring; a dictation arrives as a paste or an insert that is not one character.
const typed = ({ data, inputType }: Seen) =>
  !!inputType &&
  (inputType.startsWith("delete") ||
    inputType === "insertLineBreak" ||
    inputType === "insertParagraph" ||
    (inputType === "insertText" && data?.length === 1))

// A Cmd or Ctrl+V.
const pasteKey = ({ ctrlKey, key, metaKey }: Pick<Seen, "ctrlKey" | "key" | "metaKey">) =>
  key?.toLowerCase() === "v" && !!(metaKey || ctrlKey)

// Pure: the entry for one event, or null for one the log leaves out: a keydown other than Cmd or Ctrl+V, a beforeinput or input outside the box, plain typing, and a focusout from anything but the box. reached is a Cmd+V's alone.
export const pasteEntry = (
  event: Seen,
  {
    active,
    at,
    box,
    mount,
    now,
    reached = null,
    visible,
  }: {
    active: unknown
    at: string
    box: { value: string } | null
    mount: string
    now: number
    reached?: Reached | null
    visible: boolean
  },
): PasteLogEntry | null => {
  if (!EVENTS.includes(event.type as PasteEvent)) return null
  const kind = event.type as PasteEvent
  if (kind === "keydown" && !pasteKey(event)) return null
  if ((kind === "beforeinput" || kind === "input") && (event.target !== box || typed(event)))
    return null
  if (kind === "focusout" && event.target !== box) return null
  return reportable({
    active: nameOf(active as Named),
    at,
    boxLength: box?.value.length ?? 0,
    cause: null,
    delay: Math.max(0, Math.round(now - event.timeStamp)),
    event: kind,
    inBox: box !== null && active === box,
    inputType: event.inputType ?? null,
    length:
      kind === "paste"
        ? (event.clipboardData?.getData("text/plain").length ?? 0)
        : (event.data?.length ?? 0),
    mount,
    prevented: event.defaultPrevented && !insertedPastes.has(event),
    reached: kind === "keydown" ? reached : null,
    related: kind === "focusout" ? nameOf(event.relatedTarget as Named) : "none",
    target: nameOf(event.target as Named),
    types: kind === "paste" ? [...(event.clipboardData?.types ?? [])] : [],
    visible,
  })
}

// Heard on window as they bubble, after the composer's own handlers, so prevented says whether they kept them; window's own blur and focus arrive here too, since an element's never bubble. A keydown is heard on window before anything else (watchPastes).
const WINDOW_EVENTS: PasteEvent[] = ["beforeinput", "blur", "focus", "focusout", "input", "paste"]

// Keys that alone are no keystroke of his, the Cmd of a dictation's Cmd+V among them.
const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"])

let loadSent = false

// Logs one composer mount's events, its mount and its unmount, sends the stored log once a page load (reportPasteLoad), makes the log readable from the console and prints it when the page is opened with ?debug=paste. Returns the cleanup.
export function watchPastes(box: () => HTMLTextAreaElement | null): () => void {
  const target = window as Window & { __dashboardPasteLog?: () => PasteLogEntry[] }
  target.__dashboardPasteLog = () => readPasteLog()
  if (new URLSearchParams(window.location.search).get("debug") === "paste") {
    console.info("Paste log", JSON.stringify(readPasteLog()))
  }
  if (!loadSent) {
    loadSent = true
    void reportPasteLoad().catch(() => {})
  }
  const mount = Math.random().toString(36).slice(2, 8)
  const report = (miss: PasteMiss) => void reportPasteMiss(miss).catch(() => {})
  const misses = missWatch(report)
  const visible = () => document.visibilityState === "visible"
  const empties = emptyWatch(box, ({ after, before, cause }) => {
    const active = document.activeElement
    logPaste(
      reportable({
        active: nameOf(active),
        at: new Date().toISOString(),
        boxLength: before,
        cause,
        delay: after,
        event: "emptied",
        inBox: active !== null && active === box(),
        inputType: null,
        length: 0,
        mount,
        prevented: false,
        reached: null,
        related: "none",
        target: nameOf(box()),
        types: [],
        visible: visible(),
      }),
    )
    report("emptied")
  })
  const log = (
    event: Seen,
    {
      active = document.activeElement,
      at = new Date().toISOString(),
      now = performance.now(),
      reached = null,
    }: { active?: Element | null; at?: string; now?: number; reached?: Reached | null } = {},
  ) => {
    const field = box()
    const entry = pasteEntry(event, {
      active,
      at,
      box: field,
      mount,
      now,
      reached,
      visible: visible(),
    })
    if (!entry) return
    logPaste(entry)
    const inBox =
      entry.event === "keydown"
        ? reached === "box" || reached === "stopped"
        : event.target === field
    misses.seen(entry, inBox)
    if (fillsBox(entry, inBox)) empties.pasted(entry.length, insertedPastes.get(event) === true)
    else if (entry.event === "input" && inBox) empties.landed()
  }
  const listen = (event: Event) => log(event as unknown as Seen)
  // A Cmd+V is heard here before any handler can stop it and logged once it is through, so prevented is final and reached says whether the box itself heard it; any other key of his ends the wait for an emptied box, as a press does, since his Enter or press is how a message is sent.
  let heard: Event | null = null
  const hear = (event: Event) => {
    heard = event
  }
  const mounted = box()
  mounted?.addEventListener("keydown", hear)
  const keydown = (event: Event) => {
    const key = event as KeyboardEvent
    if (!pasteKey(key)) {
      if (!MODIFIERS.has(key.key)) empties.userActed()
      return
    }
    const active = document.activeElement
    const at = new Date().toISOString()
    const now = performance.now()
    setTimeout(() => {
      const reached: Reached =
        heard === event
          ? "box"
          : event.target === mounted
            ? "stopped"
            : takesText(event.target as Editable)
              ? "field"
              : "none"
      log(event as unknown as Seen, { active, at, now, reached })
    }, 0)
  }
  const press = () => empties.userActed()
  const logMount = (type: "mount" | "unmount") =>
    log({ defaultPrevented: false, target: box(), timeStamp: performance.now(), type })
  logMount("mount")
  for (const name of WINDOW_EVENTS) window.addEventListener(name, listen)
  window.addEventListener("keydown", keydown, true)
  window.addEventListener("pointerdown", press, true)
  document.addEventListener("visibilitychange", listen)
  return () => {
    logMount("unmount")
    misses.stop()
    empties.stop()
    for (const name of WINDOW_EVENTS) window.removeEventListener(name, listen)
    window.removeEventListener("keydown", keydown, true)
    window.removeEventListener("pointerdown", press, true)
    mounted?.removeEventListener("keydown", hear)
    document.removeEventListener("visibilitychange", listen)
  }
}

export const PASTE_WAIT_MS = 1000
export const PASTE_MISS_ENTRIES = 50
// The most a report may weigh, as the API's body limit takes it.
export const PASTE_REPORT_BYTES = 128 * 1024
export const LOAD_MARK_KEY = "dashboard.paste-log.loaded"

// emptied: the box went empty within EMPTY_WAIT_MS of a paste into it, with no key or press of his; empty-paste: a paste into the box carried no text and no file; no-paste: a Cmd+V aimed at the box brought no paste within PASTE_WAIT_MS; off-box: a Cmd+V reached nothing that takes text. A Cmd+V the page never heard is not seen here: a dictation app's own history gives its time.
export type PasteMiss = "emptied" | "empty-paste" | "no-paste" | "off-box"

type Timers = { clear: (id: unknown) => void; set: (run: () => void, ms: number) => unknown }

// Reads each logged entry for a miss, inBox saying whether a keydown was aimed at the box or the box took a paste, and reports each miss once, a Cmd+V whose paste was logged first included; stop cancels a wait.
export function missWatch(
  report: (miss: PasteMiss) => void,
  timers: Timers = {
    clear: (id) => clearTimeout(id as number),
    set: (run, ms) => setTimeout(run, ms),
  },
) {
  let waiting: unknown = null
  let pastedAt = Number.NEGATIVE_INFINITY
  const settle = () => {
    if (waiting !== null) timers.clear(waiting)
    waiting = null
  }
  return {
    seen(entry: PasteLogEntry, inBox: boolean) {
      if (entry.event === "keydown") {
        settle()
        if (entry.reached === "none") report("off-box")
        else if (inBox && !(pastedAt >= time(entry) && pastedAt - time(entry) <= PASTE_WAIT_MS))
          waiting = timers.set(() => {
            waiting = null
            report("no-paste")
          }, PASTE_WAIT_MS)
      } else if (entry.event === "paste") {
        settle()
        pastedAt = time(entry)
        if (inBox && entry.length === 0 && !entry.types.includes("Files")) report("empty-paste")
      }
    },
    stop: settle,
  }
}

export const EMPTY_WAIT_MS = 3000
const EMPTY_TICK_MS = 100

type Box = { value: string }
export type Emptied = { after: number; before: number; cause: EmptiedCause }

// Pure: whether a paste is one whose words the box let in: into the box, with text, and not taken by the composer (a screenshot, or text over 2,000 characters, which it makes a file).
export const fillsBox = (entry: PasteLogEntry, inBox: boolean): boolean =>
  entry.event === "paste" && inBox && !entry.prevented && entry.length > 0

// A paste a mount was still watching when it was taken down, which the next mount takes up.
let leftPending: { at: number; before: number; landed: boolean } | null = null

// Watches the box for EMPTY_WAIT_MS after a paste whose words it let in (fillsBox, so a paste the composer made a file never reads as a wipe) and reports, once, a box gone empty, from the first look on, with no key or press of his in between (his: an Enter or a press on Send is how a message is sent); before is the box's length at the last look, else its length before the paste plus the paste's. A paste lands once an input from the box follows it (landed, or pasted's own for one the composer inserted before it was logged) or a look sees words, and one that never landed reads empty-insert, since nothing was there to set empty. A box taken down meanwhile is taken up by the next mount, and an empty one there reads remount. stop hands the paste to the next mount.
export function emptyWatch(
  box: () => Box | null,
  report: (emptied: Emptied) => void,
  {
    now = () => performance.now(),
    timers = {
      clear: (id) => clearTimeout(id as number),
      set: (run, ms) => setTimeout(run, ms),
    },
  }: { now?: () => number; timers?: Timers } = {},
) {
  let pending: { at: number; before: number; el: Box | null; landed: boolean } | null = null
  let tick: unknown = null
  const settle = () => {
    if (tick !== null) timers.clear(tick)
    tick = null
    pending = null
  }
  const check = () => {
    tick = null
    if (!pending) return
    const after = now() - pending.at
    if (after > EMPTY_WAIT_MS) return settle()
    const el = box()
    if (el?.value === "") {
      report({
        after: Math.round(after),
        before: pending.before,
        cause: !pending.landed ? "empty-insert" : el === pending.el ? "reset" : "remount",
      })
      return settle()
    }
    if (el) {
      pending.before = el.value.length
      pending.el ??= el
      pending.landed = true
    }
    tick = timers.set(check, EMPTY_TICK_MS)
  }
  const watch = (next: NonNullable<typeof pending>, ms: number) => {
    settle()
    pending = next
    tick = timers.set(check, ms)
  }
  if (leftPending && now() - leftPending.at <= EMPTY_WAIT_MS)
    watch({ ...leftPending, el: null }, EMPTY_TICK_MS)
  leftPending = null
  return {
    userActed: settle,
    // the first look comes as soon as the paste's own insert is done, so a reset straight after it is still seen
    pasted(length = 0, landed = false) {
      const el = box()
      watch({ at: now(), before: (el?.value.length ?? 0) + (landed ? 0 : length), el, landed }, 0)
    },
    landed() {
      if (pending) pending.landed = true
    },
    stop() {
      if (pending && now() - pending.at <= EMPTY_WAIT_MS)
        leftPending = { at: pending.at, before: pending.before, landed: pending.landed }
      settle()
    },
  }
}

// Pure: the report of a miss, the log's last PASTE_MISS_ENTRIES entries behind it, or null with nothing logged.
export const pasteReport = (
  miss: PasteMiss,
  storage: LogStorage | null = storageOf(),
): { entries: PasteLogEntry[]; miss: PasteMiss } | null => {
  const entries = readPasteLog(storage).slice(-PASTE_MISS_ENTRIES).map(reportable)
  return entries.length === 0 ? null : { entries, miss }
}

// Sends a miss and the entries behind it to this machine's API, which keeps them as a file under the data folder's debug/paste for agents to read, so nobody copies the log by hand. A failed send is let go: the log is still in this browser.
export async function reportPasteMiss(miss: PasteMiss): Promise<void> {
  const report = pasteReport(miss)
  if (report) await unwrap(apiClient.v1.debug.paste.$post({ json: report }))
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

// Pure: the whole stored log as one load report, its newest entries that fit PASTE_REPORT_BYTES, while it holds a miss newer than the last one sent (LOAD_MARK_KEY); else null.
export const loadReport = (
  storage: LogStorage | null = storageOf(),
): { entries: PasteLogEntry[]; miss: "load" } | null => {
  const entries = readPasteLog(storage).map(reportable)
  let mark: string | null = null
  try {
    mark = storage?.getItem(LOAD_MARK_KEY) ?? null
  } catch {
    // a blocked storage sends as though nothing had been sent
  }
  const misses = missesIn(entries)
  if (!entries.some((entry, i) => misses[i] && (mark === null || entry.at > mark))) return null
  let size = bytes({ entries: [], miss: "load" })
  let from = entries.length
  while (from > 0 && size + bytes(entries[from - 1]) + 1 <= PASTE_REPORT_BYTES) {
    from -= 1
    size += bytes(entries[from]) + 1
  }
  return { entries: entries.slice(from), miss: "load" }
}

// Sends the stored log once a page load, so misses an earlier page logged (before this report existed, or while the API was down) still reach this machine's API, then marks it sent. A failed send is let go: the next page load tries again.
export async function reportPasteLoad(storage: LogStorage | null = storageOf()): Promise<void> {
  const report = loadReport(storage)
  const newest = report?.entries.at(-1)?.at
  if (!report || !newest) return
  await unwrap(apiClient.v1.debug.paste.$post({ json: report }))
  try {
    storage?.setItem(LOAD_MARK_KEY, newest)
  } catch {
    // a blocked storage keeps no mark, so a later page load sends again
  }
}
