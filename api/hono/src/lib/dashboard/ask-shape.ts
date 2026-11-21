import {
  ASK_CODE_COLUMNS,
  PROGRESS_LANGUAGE,
  PROGRESS_STATES,
  progressItems,
} from "@packages/config/inbox"
import { placedKindOf } from "@packages/config/kinds"

// An Inbox ask reads the way chat talks to the owner: a picture of the point first, with a one-sentence note under it (the plain-words skill), then short bullets, then its options, in its `options` and `deny` labels.

// Past this many characters, an ask's text with no picture and no bullets reads as a wall of prose.
export const PROSE_LIMIT = 300

const FENCE = /^\s*```/m
const LIST = /^\s*(?:[-*+]|\d+[.)])\s/m

// What bun run ask says of an ask's shape: the words live in bin/dashboard-ask.ts, outside the app copy tests/web/next/src/ui-copy.test.ts reads.
export type ShapeHint =
  | { kind: "prose" }
  | { kind: "unlabelled" }
  | { kind: "unlinked"; refs: string[] }
  | { kind: "wide"; longest: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Pure: the characters in the longest line inside a text's code blocks, counted by code point, so a box-drawing character counts as one; a diff block is skipped, since the card wraps it, and a progress block, which the card draws at its own width.
const longestCodeLine = (text: string): number => {
  let inside = false
  let skipped = false
  let longest = 0
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*```\s*(\S*)/)
    if (fence) {
      skipped = !inside && (fence[1]!.toLowerCase() === "diff" || fence[1] === PROGRESS_LANGUAGE)
      inside = !inside
    } else if (inside && !skipped) longest = Math.max(longest, [...line].length)
  }
  return longest
}

// What the owner would open from a card: a PR (a number of 2 digits or more after a #, so step #1 is none, or any after PR), a tracker ID (ABC-123, but not a version such as GLM-4.7, whose number runs on past a dot) or a commit sha (7 to 40 hex characters, holding a digit and a letter); an Inbox ref (#iN) is none.
const REF =
  /(?<![\w#/&])#\d{2,}\b|\bPR\s*#?\d+\b|(?<![\w/-])[A-Z]{2,10}-\d+(?![\w-]|\.\d)|(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g
// Encodings and standards that read as a team key and a number.
const NOT_TRACKERS = new Set(["ISO", "SHA", "UTF"])
const LINKED = /\]\([^)]+\)|https?:\/\//

// Pure: the refs a text names on a line outside its code blocks with no link on that line, each once, in order.
const unlinkedRefs = (text: string): string[] => {
  const refs = new Set<string>()
  let inside = false
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inside = !inside
    else if (!inside && !LINKED.test(line))
      for (const [ref] of line.matchAll(REF)) {
        const sha = /^[0-9a-f]+$/.test(ref)
        if (sha && !(/\d/.test(ref) && /[a-f]/.test(ref))) continue
        if (NOT_TRACKERS.has(ref.split("-")[0]!)) continue
        refs.add(ref)
      }
  }
  return [...refs]
}

// Pure: the hints for an `ask` decision: one when its text runs past PROSE_LIMIT with no list, no code block and no attachments, one when it labels no options, one when a code block other than a diff holds a line past ASK_CODE_COLUMNS, one when a line names a PR, a tracker ID or a commit with no link on it; the wide and unlinked ones alone for a read-only update's text, which renders on the same card; none for any other item, which posts either way.
export function shapeHints(input: unknown): ShapeHint[] {
  const preview = isRecord(input) ? input.preview : undefined
  if (!isRecord(preview) || typeof preview.text !== "string") return []
  const ask = preview.type === "ask"
  if (!ask && !(isRecord(input) && input.kind === "update")) return []
  const text = preview.text
  const hints: ShapeHint[] = []
  const attached = Array.isArray(preview.attachments) && preview.attachments.length > 0
  if (ask && !attached && text.length > PROSE_LIMIT && !FENCE.test(text) && !LIST.test(text)) {
    hints.push({ kind: "prose" })
  }
  // an ask with neither options nor an approve label shows the bare Approve and Deny, but a questions ask, which labels each question's own options
  if (
    ask &&
    preview.options === undefined &&
    preview.approve === undefined &&
    preview.questions === undefined
  ) {
    hints.push({ kind: "unlabelled" })
  }
  const refs = unlinkedRefs(text)
  if (refs.length > 0) hints.push({ kind: "unlinked", refs })
  const longest = longestCodeLine(text)
  if (longest > ASK_CODE_COLUMNS) hints.push({ kind: "wide", longest })
  return hints
}

// Pure: the text's progress blocks, each its lines between its fences, in order.
const progressBlocks = (text: string): string[] => {
  const blocks: string[] = []
  let block: string[] | null = null
  let inside = false
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*```\s*(\S*)/)
    if (fence) {
      if (inside && block) blocks.push(block.join("\n"))
      block = !inside && fence[1] === PROGRESS_LANGUAGE ? [] : null
      inside = !inside
    } else if (block) block.push(line)
  }
  return blocks
}

const STATES = `${PROGRESS_STATES.slice(0, -1).join(", ")} or ${PROGRESS_STATES.at(-1)}`

// Pure: why bun run ask refuses an ask's or a read-only update's text, whose card would draw a progress block it cannot read as plain code: the first line with other than 4 or 5 fields, a percent outside 0 to 100 or an unknown state, named by its block and line; null when every block reads.
export function progressRefusal(input: unknown): string | null {
  const preview = isRecord(input) ? input.preview : undefined
  if (!isRecord(preview) || typeof preview.text !== "string") return null
  if (preview.type !== "ask" && !(isRecord(input) && input.kind === "update")) return null
  for (const [index, block] of progressBlocks(preview.text).entries()) {
    const read = progressItems(block)
    if (read.ok) continue
    const { fault } = read
    const where = `progress block ${index + 1}`
    const shape = `write each line as name | percent | what's going on | ETA | state, the percent 0 to 100 and the state optional, one of ${STATES} (to-inbox's PROGRESS.md)`
    if (fault.kind === "empty") return `${where} holds no line; ${shape}`
    const at = `${where}, line ${fault.line},`
    const why =
      fault.kind === "fields"
        ? `holds ${fault.count} fields, not 4 or 5`
        : fault.kind === "percent"
          ? "has a percent outside 0 to 100"
          : `has the state "${fault.state}", not ${STATES}`
    return `${at} ${why}: "${fault.text}"; ${shape}`
  }
  return null
}

// Pure: whether a card's text holds a progress block, the mark of the dispatcher's in-flight card (PG-2720).
export const holdsProgressBlock = (preview: unknown): boolean =>
  isRecord(preview) && typeof preview.text === "string" && progressBlocks(preview.text).length > 0

// Pure: whether the poster's name places as the dispatcher (an `<id>-dispatcher` name, or the dispatcher's name in sessions.names), so no name is hard-coded (PG-2720).
export function isDispatcher(from: string | null | undefined): boolean {
  return typeof from === "string" && placedKindOf(from, undefined) === "dispatcher"
}

// The dispatcher's one open in-flight card, its newest item it may still edit that holds a progress block, so a second card or another poster's names it (PG-2720).
export type InflightCard = { ref: number; title: string } | null

// Pure: whether a title is the daily ledger card's, its prefix (org.ledger.title) alone or followed by ": " and a day, which posts beside the dispatcher's one card.
export const isLedgerTitle = (title: string, ledger: string): boolean =>
  title === ledger || title.startsWith(`${ledger}: `)

// Pure: why bun run ask refuses a progress card: only the dispatcher's first card, its same-title twin or its daily ledger card passes.
export function progressCardRefusal(
  input: unknown,
  inFlight: InflightCard,
  ledger?: string,
): string | null {
  if (!isRecord(input)) return null
  const preview = input.preview
  if (!isRecord(preview) || typeof preview.text !== "string") return null
  // a progress block draws the card, so only an ask or a read-only update may hold one, the same shape progressRefusal reads
  if (preview.type !== "ask" && input.kind !== "update") return null
  // an item with no progress block posts from any poster, so its absence returns null
  if (!holdsProgressBlock(preview)) return null
  const from = typeof input.from === "string" ? input.from : undefined
  const title = typeof input.title === "string" ? input.title : ""
  // the dispatcher posts the card, then edits it in place, so its first card passes and a twin still edits
  if (isDispatcher(from)) {
    if (!inFlight) return null
    if (title === inFlight.title) return null
    if (ledger !== undefined && isLedgerTitle(title, ledger)) return null
    return `a progress block is the dispatcher's one card, not one to start twice: yours is #i${inFlight.ref}, so add this job as a row on it with \`playground ask edit #i${inFlight.ref}\`, or post under its title, "${inFlight.title}"`
  }
  // a progress card is the dispatcher's, not one another poster may start
  return inFlight
    ? `a progress block is the dispatcher's one card, not one a poster may start; send its progress up the chain, for the dispatcher to add as a row on #i${inFlight.ref}`
    : `a progress block is the dispatcher's one card, not one a poster may start; send it up the chain, not as its own card`
}

// A template for each shape the docs work through, each picture with its one-sentence note under it: a code change led by a diff, a plain decision led by an ASCII flow, a UI change, whose before and after pictures join it as attachments once the card takes attachments, and a Slack message led by its thread so far.
export const ASK_EXAMPLES = {
  code: {
    from: "builder",
    preview: {
      deny: "Keep it on dev",
      options: [{ label: "Port the fix to staging, then main" }],
      text: [
        "```diff",
        "- const limit = 100",
        "+ const limit = rows.length",
        "```",
        "",
        "The export fix is ready to port to staging and main.",
        "",
        "- 🐛 The export ends at 100 rows.",
        "- ✅ The fix runs on dev since 24 Oct, with no errors.",
        "- ↩️ One commit reverts it.",
        "- 🎯 It touches the export alone.",
      ].join("\n"),
      type: "ask",
    },
    title: "Port the export fix to staging and main?",
  },
  decision: {
    from: "builder",
    preview: {
      deny: "Turn the request down",
      options: [{ label: "Take the request and run the dry run" }],
      text: [
        "```",
        "web-api",
        "   │ asks for a dry run",
        "   ▼",
        "builder ──runs──▶ export job (dev)",
        "   │",
        "   ▼",
        "report to you",
        "```",
        "",
        "A dry run of the export job waits on your yes.",
        "",
        "- 📨 The web-api session asks for a dry run of the export job.",
        "- 🧪 The run is on dev only and writes no rows.",
        "- ⏱️ It takes about 10 minutes.",
      ].join("\n"),
      type: "ask",
    },
    title: "Take the web-api session's request for an export dry run?",
  },
  delete: {
    from: "builder",
    kind: "decision",
    preview: {
      type: "delete",
      what: "/Users/you/playground/.claude/worktrees/PG-12-old-export",
      why: [
        "Its PR is open, and its branch holds 2 commits no merge landed.",
        "",
        "- 🗑️ Approve moves it to the trash, kept 7 days; playground rm --restore brings it back.",
        "- ✋ Deny leaves it in place.",
      ].join("\n"),
    },
    title: "Delete the old export worktree?",
  },
  questions: {
    from: "builder",
    preview: {
      questions: [
        {
          options: [
            { description: "a day of soak before main", label: "Staging first" },
            { label: "Straight to main" },
          ],
          question: "Where should the export fix land first?",
          recommended: 0,
        },
        {
          options: [{ label: "Now" }, { label: "After the next ship" }],
          question: "When should it go out?",
        },
      ],
      text: "Two calls on the export fix, one for each.",
      type: "ask",
    },
    title: "How should the export fix roll out?",
  },
  slack: {
    from: "builder",
    preview: {
      link: "https://app.slack.com/client/TXXXXXXXXXX/DXXXXXXXXXX",
      text: "hey, the fix is on staging now. can you try the export again?",
      thread: [
        {
          said: "The export ends at 100 rows, and the client needs all of them.",
          who: "Colleague",
        },
        { said: "Ping me when I can test it.", who: "Colleague" },
      ],
      to: "@colleague",
      type: "slack",
    },
    title: "Tell the colleague the export fix is on staging?",
  },
  ui: {
    from: "builder",
    preview: {
      attachments: [
        { group: "Inbox card", label: "before", src: "/Users/you/shots/card-before.png" },
        { group: "Inbox card", label: "after", src: "/Users/you/shots/card-after.png" },
      ],
      deny: "Keep the card as it is",
      options: [{ label: "Build the row as the after picture shows" }],
      text: [
        "The Inbox card can show its pictures as one thumbnail row.",
        "",
        "- 🖼️ The Inbox card shows its pictures as a row of thumbnails.",
        "- 👆 A click opens the picture in the viewer.",
        "- 📱 The row scrolls sideways on a phone.",
        "- ↩️ One revert puts the old card back.",
        "- 🎯 It touches the Inbox card alone.",
      ].join("\n"),
      type: "ask",
    },
    title: "Show an ask's pictures as a thumbnail row?",
  },
} as const

export type AskExampleKind = keyof typeof ASK_EXAMPLES

export const isAskExampleKind = (kind: string): kind is AskExampleKind =>
  Object.hasOwn(ASK_EXAMPLES, kind)
