"use client"

import type { InboxAction, InboxItem, InboxPreview, InboxUpdate } from "@api/hono"
import {
  type AskQuestion,
  type Choices,
  INSTALL_TEXT,
  PEER_INSTALL_TEXT,
  PEER_POLICY,
  PEER_RULE,
  questionsOf,
  ROOT_DIR,
  ROOT_STEPS,
} from "@packages/config/inbox"
import type { DISPATCHER_SLOT_LABELS } from "@packages/config/kinds"
import {
  RiAlarmWarningLine,
  RiAppsLine,
  RiArchive2Line,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiChat3Line,
  RiCheckDoubleLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDraftLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileCopyLine,
  RiGitMergeLine,
  RiGitRepositoryLine,
  RiInboxLine,
  RiInboxUnarchiveLine,
  RiKey2Line,
  RiLockPasswordLine,
  RiMoneyDollarCircleLine,
  RiProgress4Line,
  RiPuzzleLine,
  RiQuestionAnswerLine,
  RiQuestionLine,
  RiRefreshLine,
  RiReplyLine,
  RiSearchEyeLine,
  RiSendPlaneLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
  RiShipLine,
  RiSlackLine,
  RiTableLine,
  RiTicketLine,
  RiUserStarLine,
  RiWindowLine,
  RiZzzLine,
  type RemixiconComponentType,
} from "@remixicon/react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"

import { COMPOSER_ID } from "@/components/dashboard/composer"
import { useDashboard } from "@/components/dashboard/dashboard"
import { PreviewPane } from "@/components/dashboard/preview-pane"
import { ReadOnlyLine } from "@/components/dashboard/read-only-line"
import { Attachments } from "@/components/dashboard/viewer/thumbnails"
import { Hint, OFF_FOCUSABLE } from "@/components/hint"
import { OPEN_HEADER, SHELF_ITEM, SHELF_ROW, STICKY_HEADER } from "@/components/shelf"
import { ShelfMark } from "@/components/shelf-mark"
import { TranscriptMarkdown } from "@/components/transcript-markdown"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useYardWrites } from "@/hooks/use-yard-writes"
import { ACCOUNTS_QUERY_KEY } from "@/lib/accounts"
import { agentLabel, roleLabel } from "@/lib/agent-label"
import { apiClient, unwrap } from "@/lib/api/client"
import { EMPTY_PICKS, readPicks, savePicks } from "@/lib/ask-picks"
import { HOLDS_RELOAD } from "@/lib/build-reload"
import { copyToClipboard } from "@/lib/clipboard"
import { config } from "@/lib/config"
import { dispatcherOf, useNow } from "@/lib/dashboard"
import { cardDraftKey, draftSaver, readDrafts, saveDraft } from "@/lib/drafts"
import {
  answerItem,
  canDraft,
  cardKey,
  type CardKey,
  changedAt,
  checkAnswerNote,
  commentRefused,
  decisionChoices,
  deliveryNote,
  dismissEach,
  dismissItems,
  filesCount,
  focusAfterTake,
  foldsByDefault,
  INBOX_QUERY_KEY,
  isArchived,
  inboxLight,
  inboxSummary,
  inboxView,
  itemTag,
  kindWord,
  markRead,
  MOVED_PAUSE_MS,
  movedStep,
  newLabel,
  outcomeLine,
  pickedAt,
  pinnedView,
  provideSecret,
  reopenable,
  reopenKey,
  replyItem,
  resultLink,
  retryable,
  retryItem,
  revealSecret,
  schedulable,
  scheduleChoices,
  scheduleItem,
  sendFailed,
  sendUnconfirmed,
  sendWhy,
  type Shelf,
  SHELF_LABELS,
  shelfRow,
  shelfToOpen,
  takenBy,
  updatedSince,
  upfrontLink,
  uploadsOn,
  useInbox,
  verbs,
  waiting,
} from "@/lib/inbox"
import { JOBS_QUERY_KEY } from "@/lib/jobs"
import { needsYouAnchor, useNeedsYouTarget } from "@/lib/needs-you"
import { insertPaste } from "@/lib/paste"
import { OPEN_PREVIEW, takePreview } from "@/lib/previews"
import { ON_THE_MAC_LINE } from "@/lib/relay"
import { replyRoute, useTypedReply } from "@/lib/reply"
import { iconTone, type ShownState, statusIcon } from "@/lib/status-icons"
import { inboxMark, readMark } from "@/lib/tab-dot"
import { fullTime, relativeTime } from "@/lib/time"

const DECISION_ICONS: Record<InboxPreview["type"], RemixiconComponentType> = {
  accept: RiPuzzleLine,
  apps: RiAppsLine,
  ask: RiQuestionAnswerLine,
  budget: RiMoneyDollarCircleLine,
  clone: RiGitRepositoryLine,
  delete: RiDeleteBinLine,
  grant: RiShieldKeyholeLine,
  guard: RiShieldCheckLine,
  own: RiUserStarLine,
  reveal: RiKey2Line,
  root: RiLockPasswordLine,
  schema: RiTableLine,
  secret: RiKey2Line,
  ship: RiShipLine,
  slack: RiSlackLine,
  ticket: RiTicketLine,
}

const OUTCOME_ICONS: Record<InboxUpdate["outcome"], RemixiconComponentType> = {
  alert: RiAlarmWarningLine,
  decision: RiCheckDoubleLine,
  finding: RiSearchEyeLine,
  merged: RiGitMergeLine,
  shipped: RiShipLine,
}

const iconOf = (item: InboxItem): RemixiconComponentType =>
  item.kind === "draft"
    ? kindWord(item) === "Linear comment"
      ? RiChat3Line
      : RiSlackLine
    : item.kind === "update"
      ? OUTCOME_ICONS[item.preview.outcome]
      : DECISION_ICONS[item.preview.type]

// Each kind's colour, on its icon; an alert keeps the red its word asks for.
const KIND_TONES: Record<InboxItem["kind"], string> = {
  decision: "text-warning",
  draft: "text-info",
  update: "text-success",
}

// The column a card's state icon sits in, one box wide and one line tall, so the place line's words and the title's start at the same x and the icon is centred on the title's first line.
const LEAD = "flex h-lh w-4 shrink-0 items-center justify-center"

// A card's state as the sidebar draws the same state, beside its title as a row's light sits beside its name; the spinner turns only where motion is allowed.
function Light({ state }: { state: ShownState }) {
  const spec = statusIcon(state)
  return (
    <spec.Icon
      aria-hidden
      className={cn("size-4", iconTone(state), spec.spins && "motion-safe:animate-spin")}
    />
  )
}

const ALERT_TONE = "text-destructive"

const kindTone = (item: InboxItem): string =>
  item.kind === "update" && item.preview.outcome === "alert" ? ALERT_TONE : KIND_TONES[item.kind]

// Each dispatcher's own colour on its name, so the two read apart at a glance.
const POSTER_TONES: Record<(typeof DISPATCHER_SLOT_LABELS)[number], string> = {
  Alpha: "text-info",
  Bravo: "text-bravo",
}

// A dispatcher's tone by its role, never by a name that merely reads Alpha, so a worker named alpha keeps the text's colour.
const posterTone = (from: string): string | undefined => {
  const role = roleLabel(from)
  return role && role in POSTER_TONES ? POSTER_TONES[role as keyof typeof POSTER_TONES] : undefined
}

// The item's kind as an icon and a word, its id, who posted it, and Updated when it changed since his last look, in one muted band across the pane at the card's start, ending in one time and a tick: the only place an item says what it is.
function KindBand({
  busy,
  focusHeld,
  item,
  now,
  onRead,
  replying,
  unread,
  updated,
}: {
  busy: boolean
  focusHeld: boolean
  item: InboxItem
  now: number
  onRead: () => void
  replying: boolean
  unread: boolean
  updated: boolean
}) {
  const Icon = iconOf(item)
  const kind = item.kind === "draft" ? `${kindWord(item)} to ${item.preview.to}` : kindWord(item)
  const changed = changedAt(item)
  return (
    // a muted band the pane's full width, its words where they sat, so its icon stays over the title's
    <div className="-mx-(--pane-x) text-xs">
      <p className="bg-muted text-foreground flex flex-wrap items-center gap-x-1.5 px-(--pane-x) py-1">
        {/* in the title's LEAD box, 2px on, so the band's words start where the title's do */}
        <span className={cn(LEAD, "me-0.5")}>
          <Icon className={cn("size-3.5", kindTone(item))} aria-hidden />
        </span>
        <span>{kind}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{itemTag(item)}</span>
        <span aria-hidden>·</span>
        <Hint content={item.from}>
          <span className={posterTone(item.from)}>{agentLabel(item.from)}</span>
        </Hint>
        {updated && (
          <>
            <span aria-hidden>·</span>
            <span className="text-info">Updated</span>
          </>
        )}
        {focusHeld && (
          <>
            <span aria-hidden>·</span>
            <Hint content="It came in while focus stands, so it counts once focus ends">
              <span className="text-muted-foreground">Quiet</span>
            </Hint>
          </>
        )}
        {/* the item the composer's words name as re #iN, until they are sent */}
        {replying && (
          <>
            <span aria-hidden>·</span>
            <Badge variant="outline" className="text-2xs h-4 px-1.5">
              Replying
            </Badge>
          </>
        )}
        {/* at the right end one time, the last change, then a tick: one to mark it read, two once read, muted */}
        <span className="ml-auto flex items-center gap-1.5">
          {/* plain text on the default cursor, reading when it was read on hover once it is */}
          <time
            dateTime={changed ?? item.createdAt}
            className="group/time cursor-default select-none"
          >
            <span className={cn(item.readAt && "group-hover/time:hidden")}>
              {`${changed ? "updated" : "posted"} ${relativeTime(changed ?? item.createdAt, new Date(now))}`}
            </span>
            {item.readAt && (
              <span className="hidden group-hover/time:inline">
                {`read ${relativeTime(item.readAt, new Date(now))}`}
              </span>
            )}
          </time>
          {unread && !config.hosted ? (
            <Hint content="Mark as read">
              <button
                type="button"
                aria-label="Mark as read"
                className="hover:text-foreground text-muted-foreground -m-1 rounded-sm p-1 outline-none disabled:opacity-50"
                disabled={busy}
                onClick={onRead}
              >
                <RiCheckLine className="size-3.5" aria-hidden />
              </button>
            </Hint>
          ) : (
            <Hint content={item.readAt ? `Read ${fullTime(item.readAt)}` : "Read"}>
              <RiCheckDoubleLine className="text-muted-foreground size-3.5" aria-label="Read" />
            </Hint>
          )}
        </span>
      </p>
    </div>
  )
}

// Where the item points, its PR, ticket or thread, above its title, or why it has no link.
function Place({ item }: { item: InboxItem }) {
  const place = upfrontLink(item)
  if (!place) return null
  return (
    <div className="text-muted-foreground flex gap-2 text-xs">
      <span className={LEAD} />
      {"href" in place ? (
        <a
          href={place.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground inline-flex min-w-0 items-center gap-1 hover:underline"
        >
          {place.label}
          <RiExternalLinkLine className="size-3" aria-hidden />
        </a>
      ) : (
        <span className="min-w-0">No link: {place.reason}</span>
      )}
    </div>
  )
}

// The words a session wrote, as they were written: every line break kept and nothing rendered, so what is approved is what was read, a rule at its left rather than a background marking it as quoted.
const QUOTE = "text-foreground border-l-2 pl-3 break-words whitespace-pre-wrap"

// An ask's words render as a chat message's do, line breaks kept, so a fenced block shows highlighted with its copy button; a Slack message's stay QUOTE, since they are sent exactly as written. Its lines are roomy, on the card's own background.
const ASK_QUOTE =
  "text-foreground min-w-0 break-words leading-relaxed [&_[data-slot=alert-description]]:text-xs [&_[data-slot=alert]]:text-xs [&_[data-streamdown=inline-code]]:text-xs [&_table]:text-xs"

// The card's own boxes (a note, a reply) write small, under the ask they answer; md: beats Textarea's own md:text-sm
const BOX = "text-xs md:text-xs"

// Approve reads green and Deny red, on a muted wash that deepens when picked, the same on a choice and on a footer button, dark theme included, where the outline Button's own border and hover would win.
const SIDE_TONES: Record<"approve" | "deny", string> = {
  approve:
    "border-success/30 bg-success/10 hover:bg-success/15 dark:border-success/30 dark:bg-success/10 dark:hover:bg-success/15 data-checked:border-success data-checked:bg-success/20 dark:data-checked:bg-success/20",
  deny: "border-destructive/30 bg-destructive/10 hover:bg-destructive/15 dark:border-destructive/30 dark:bg-destructive/10 dark:hover:bg-destructive/15 data-checked:border-destructive data-checked:bg-destructive/20 dark:data-checked:bg-destructive/20",
}

// Draft saves without sending, so it takes amber between Send's green and Discard's red.
const DRAFT_TONE =
  "border-warning/30 bg-warning/10 hover:bg-warning/15 dark:border-warning/30 dark:bg-warning/10 dark:hover:bg-warning/15"

// The rows as the card's choices, numbered for the keys 1 on. While the card is busy (its answer on its way, or it has just moved under the owner) they stay enabled, dimmed and busy, and take no click or key: Questionnaire counts a disabled choice as no answer, so disabling them would mark a card Send already checked invalid.
export function AskChoices({
  busy,
  choices,
  paused,
  pick,
  setPick,
}: {
  busy: boolean
  choices: Choices
  paused: boolean
  pick: number | null
  setPick: (pick: number) => void
}) {
  const yesNo = choices.shape === "yes-no"
  return (
    <QuestionnaireChoices
      aria-busy={busy || undefined}
      className={cn(busy && "pointer-events-none opacity-50")}
    >
      {choices.rows.map((row) => {
        // a yes or no reads Approve or Deny over its own label; a lettered row reads its letter and label over its description
        const word = yesNo ? (row.go ? "Approve" : "Deny") : `${row.letter}. ${row.label}`
        const said = yesNo && row.label !== word ? [row.label, row.description] : [row.description]
        return (
          <Hint key={row.index} content={paused ? PAUSED_WHY : undefined}>
            <QuestionnaireChoice
              checked={pick === row.index}
              // a yes or no's keys 1 and 2 still pick a side, with no number badge drawn
              className={cn(
                "text-xs",
                yesNo && "[&_[data-slot=questionnaire-choice-shortcut]]:hidden!",
                SIDE_TONES[row.go ? "approve" : "deny"],
              )}
              value={`${row.letter}: ${row.label}`}
              onChange={() => {
                if (!busy) setPick(row.index)
              }}
            >
              <span className="font-medium">{word}</span>
              {said.map((line, at) =>
                line ? (
                  <QuestionnaireChoiceDescription key={at}>{line}</QuestionnaireChoiceDescription>
                ) : null,
              )}
            </QuestionnaireChoice>
          </Hint>
        )
      })}
    </QuestionnaireChoices>
  )
}

// A signature of an ask's questions, so the card drops its picks and steps back to the first when an in-place edit grows, shrinks, reorders or rewords them, since the picks are held by position and a stale one would land on another question.
export function picksKey(questions: AskQuestion[]): string {
  return JSON.stringify(questions.map((q) => [q.question, q.options.map((o) => o.label)]))
}

// A signature of a single-question ask's choice rows, so the card drops its kept pick when an in-place edit changes, reorders or rewords them, since the pick is held by position; picksKey does the same for a multi-question ask.
export function choicesKey(choices: Choices | null): string {
  if (!choices) return "[]"
  return JSON.stringify([choices.shape, choices.rows.map((r) => [r.label, r.letter, r.go])])
}

// One question of a multi-question ask as the card's choices, numbered for the keys 1 on, with the recommended option badged where it sits; the pick is this question's own, so stepping between questions keeps each. Busy dims them and takes no click, as AskChoices does.
function QuestionChoices({
  busy,
  paused,
  pick,
  question,
  setPick,
}: {
  busy: boolean
  paused: boolean
  pick: number | null
  question: AskQuestion
  setPick: (index: number) => void
}) {
  return (
    <QuestionnaireChoices
      aria-busy={busy || undefined}
      className={cn(busy && "pointer-events-none opacity-50")}
    >
      {question.options.map((row) => (
        <Hint key={row.index} content={paused ? PAUSED_WHY : undefined}>
          <QuestionnaireChoice
            checked={pick === row.index}
            className={cn("text-xs", SIDE_TONES.approve)}
            value={`${row.letter}: ${row.label}`}
            onChange={() => {
              if (!busy) setPick(row.index)
            }}
          >
            <span className="flex items-center gap-2 font-medium">
              <span>
                {row.letter}. {row.label}
              </span>
              {question.recommended === row.index && <Badge variant="secondary">Recommended</Badge>}
            </span>
            {row.description && (
              <QuestionnaireChoiceDescription>{row.description}</QuestionnaireChoiceDescription>
            )}
          </QuestionnaireChoice>
        </Hint>
      ))}
    </QuestionnaireChoices>
  )
}

// What the other side has said so far, one gist line per message with who said it, above the reply it leads to; each gist renders as transcript text until its renderer lands5's renderer lands.
function SoFar({ thread }: { thread?: { said: string; who: string }[] }) {
  if (!thread) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-xs font-medium">So far</p>
      <ul className="text-muted-foreground flex flex-col gap-1">
        {thread.map((line, index) => (
          <li key={index} className="flex min-w-0 gap-1">
            <span className="shrink-0 font-medium">{line.who}:</span>
            <div className="min-w-0 break-words">
              <TranscriptMarkdown card>{line.said}</TranscriptMarkdown>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Under a Slack send's files while it is open: that its go shares them into the same thread (uploadsOn).
function UploadMark({ item }: { item: InboxItem }) {
  const on = uploadsOn(item)
  if (!on || item.kind === "update" || !("attachments" in item.preview)) return null
  const count = item.preview.attachments?.length ?? 0
  return (
    <p className="text-muted-foreground text-xs">
      {filesCount(count)} · uploads on {on}
    </p>
  )
}

// An ask's words and files, and a read-only update's, which shows them with no Approve.
function Shown({ preview }: { preview: Pick<InboxUpdate, "attachments" | "text"> }) {
  return (
    <>
      {preview.text && (
        <div className={ASK_QUOTE}>
          <TranscriptMarkdown card>{preview.text}</TranscriptMarkdown>
        </div>
      )}
      {preview.attachments ? <Attachments items={preview.attachments} /> : null}
    </>
  )
}

// How long a shown value stays on screen before it hides itself.
const REVEAL_SHOWN_MS = 30_000

// A reveal card's value: masked until Show, which fetches it and hides it again after REVEAL_SHOWN_MS, on Hide or when the card folds; Copy fetches it straight to the clipboard and never draws it. It lives in this state alone.
function RevealField({ id }: { id: string }) {
  const [value, setValue] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (value === null) return
    const hide = setTimeout(() => setValue(null), REVEAL_SHOWN_MS)
    return () => clearTimeout(hide)
  }, [value])
  const reveal = async (use: (value: string) => unknown) => {
    setError(null)
    try {
      await use(await revealSecret(id))
    } catch (failure) {
      setError((failure as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <code
          aria-label="Value"
          className="border-input min-w-0 flex-1 truncate rounded-md border px-2.5 py-1.5 font-mono text-xs"
        >
          {value ?? "\u25CF".repeat(12)}
        </code>
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => (value === null ? void reveal(setValue) : setValue(null))}
        >
          {value === null ? (
            <RiEyeLine data-icon="inline-start" />
          ) : (
            <RiEyeOffLine data-icon="inline-start" />
          )}
          {value === null ? "Show" : "Hide"}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void reveal((got) => copyToClipboard(got, "Copied"))}
        >
          <RiFileCopyLine data-icon="inline-start" />
          Copy
        </Button>
      </div>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  )
}

// Exactly what Approve does, the card's description: our own words around the session's, a Slack message's plain text that hides nothing and an ask's rendered as its chat would show them.
function Preview({ item }: { item: Extract<InboxItem, { kind: "decision" }> }) {
  const preview = item.preview
  switch (preview.type) {
    case "ask":
      // an ask with options or questions says what each one does in its choices, so its text stands alone above them
      return (
        <>
          {!preview.options && !preview.approve && !preview.questions && (
            <p>On Approve, {agentLabel(item.from)} does this:</p>
          )}
          <Shown preview={preview} />
        </>
      )
    case "slack":
      return (
        <>
          <SoFar thread={preview.thread} />
          <p>On Approve, {preview.to} gets:</p>
          <p className={QUOTE}>{preview.text}</p>
          {preview.attachments ? <Attachments items={preview.attachments} /> : null}
          <UploadMark item={item} />
        </>
      )
    case "ship":
      return (
        <>
          <p>
            On Approve, main moves to <code className="font-mono">{preview.sha.slice(0, 7)}</code>{" "}
            and the installed skills update. {preview.prs.length} pull request
            {preview.prs.length === 1 ? "" : "s"}:
          </p>
          <ul className="text-foreground list-disc pl-5">
            {preview.prs.map((pr) => (
              <li key={pr.number}>
                {pr.url ? (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary font-medium underline"
                  >
                    #{pr.number}
                  </a>
                ) : (
                  `#${pr.number}`
                )}{" "}
                {pr.title}
              </li>
            ))}
          </ul>
        </>
      )
    case "ticket":
      return (
        <>
          <p>
            On Approve, a new ticket is filed in {preview.team}: {preview.title}
          </p>
          <div className={ASK_QUOTE}>
            <TranscriptMarkdown card on="muted">
              {preview.body}
            </TranscriptMarkdown>
          </div>
        </>
      )
    case "delete":
      return (
        <>
          <p>On Approve, this is deleted:</p>
          <p className={QUOTE}>{preview.what}</p>
          <TranscriptMarkdown card>{`Why: ${preview.why}`}</TranscriptMarkdown>
        </>
      )
    case "schema":
      return (
        <>
          <p>On Approve, this schema is applied:</p>
          <div className={ASK_QUOTE}>
            <TranscriptMarkdown card on="muted">
              {preview.shape}
            </TranscriptMarkdown>
          </div>
        </>
      )
    case "budget":
      return (
        <>
          <p>On Approve, {preview.amount} is spent.</p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "secret":
      if (preview.sink.type === "keychain")
        return (
          <p>
            On Submit, the value is saved in this computer's secret store as its{" "}
            <code className="font-mono">{preview.sink.item}</code> item. It is kept nowhere else.
          </p>
        )
      return (
        <p>
          On Submit, the value goes to <code className="font-mono">{preview.key}</code> in Vercel
          project <code className="font-mono">{preview.sink.project}</code> ({preview.sink.scope})
          for {preview.sink.environments.join(", ")}. It is kept nowhere.
        </p>
      )
    case "accept":
      if (preview.more?.length)
        return (
          <>
            <p>
              On Approve, the dashboard accepts these proposals in order, and stops at the first
              that fails:
            </p>
            <ol className="list-decimal pl-5">
              {[preview, ...preview.more].map((proposal, at) => (
                <li key={at}>
                  the proposed {proposal.kind} <code className="font-mono">{proposal.key}</code> in{" "}
                  {proposal.scope}, as it reads at{" "}
                  <code className="font-mono">{proposal.rev.slice(0, 7)}</code>
                </li>
              ))}
            </ol>
            <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
          </>
        )
      return (
        <>
          <p>
            On Approve, the dashboard accepts the proposed {preview.kind}{" "}
            <code className="font-mono">{preview.key}</code> in {preview.scope}, as it reads at{" "}
            <code className="font-mono">{preview.rev.slice(0, 7)}</code>.
          </p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "apps":
      return (
        <>
          <p>
            On Approve, the dashboard {preview.change === "add" ? "adds" : "removes"}{" "}
            <code className="font-mono">{preview.app}</code>{" "}
            {preview.change === "add" ? "to" : "from"} your apps, which no session may drive.
          </p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "clone":
      // each repo and the very folder Approve fills, in the order it clones them
      return (
        <>
          <p>
            On Approve, the dashboard clones these repos into this machine&apos;s extensions, in
            order, and stops at the first that fails. Then it copies the guards&apos; lists from
            this checkout into your login&apos;s lists, keeping each one already there. It makes no
            repo.
          </p>
          <ol className="list-decimal pl-5">
            {preview.repos.map((repo) => (
              <li key={repo.scope}>
                <code className="font-mono break-all">{repo.repo}</code> into{" "}
                <code className="font-mono break-all">{repo.folder}</code>
              </li>
            ))}
          </ol>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "reveal":
      return (
        <>
          <p>
            Shows the <code className="font-mono break-all">{preview.service}</code> item from this
            computer&apos;s secret store here when you click Show or Copy. It is kept nowhere else.
          </p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
          {item.status === "open" && !isArchived(item) && !config.hosted && (
            <RevealField id={item.id} />
          )}
        </>
      )
    case "grant":
      return (
        <>
          <p>
            On Approve, System Settings opens at Privacy &amp; Security &gt;{" "}
            {preview.permission === "accessibility" ? "Accessibility" : "Screen Recording"}, where
            you turn it on for the app that runs {agentLabel(item.from)}, and{" "}
            {agentLabel(item.from)} checks it again.
          </p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "root":
      // a peer's card names the machine and how its one password is used; an install shows the very program text sudo or pkexec runs and each script's hash it checks, so the owner approves the exact bytes
      if (preview.machine)
        return preview.step === "install" ? (
          <>
            <p>
              On Approve, the Dashboard copies each script below to {preview.machine}, then runs
              this program there as root through sudo, with the admin password from your secret
              card. The password is used once, then deleted from this computer. It copies each
              script into <code className="font-mono">{ROOT_DIR}</code> only if its sha256 matches,
              then lets your user on {preview.machine} run those scripts alone as root with no
              password, through <code className="font-mono">{PEER_RULE}</code>.
            </p>
            <ul className="list-disc pl-5">
              {preview.scripts?.map((script) => (
                <li key={script.name}>
                  <code className="font-mono">{script.name}</code>:{" "}
                  <code className="font-mono break-all">{script.sha256}</code>
                </li>
              ))}
            </ul>
            <pre className={`${QUOTE} font-mono text-xs`}>{PEER_INSTALL_TEXT}</pre>
            <p>
              To undo it: remove <code className="font-mono">{PEER_RULE}</code> and{" "}
              <code className="font-mono">{PEER_POLICY}</code> on {preview.machine}.
            </p>
            <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
          </>
        ) : (
          <>
            <p>
              On Approve, the Dashboard checks{" "}
              <code className="font-mono break-all">
                {ROOT_DIR}/{preview.step}
              </code>{" "}
              on {preview.machine}, then runs it there as root, with no password, through the rule
              its install card set up. {ROOT_STEPS[preview.step].what}.
            </p>
            <p>
              To undo it: {ROOT_STEPS[preview.step].undo}, on {preview.machine}.
            </p>
            <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
          </>
        )
      return preview.step === "install" ? (
        <>
          <p>
            On Approve, your computer asks for your password in its own window, then runs this
            program as root. It copies each script below into{" "}
            <code className="font-mono">{ROOT_DIR}</code> only if its sha256 matches.
          </p>
          <ul className="list-disc pl-5">
            {preview.scripts?.map((script) => (
              <li key={script.name}>
                <code className="font-mono">{script.name}</code>:{" "}
                <code className="font-mono break-all">{script.sha256}</code>
              </li>
            ))}
          </ul>
          {preview.ca ? (
            <p>
              It also keeps the Dashboard&apos;s certificate as root, only if its sha256 is{" "}
              <code className="font-mono break-all">{preview.ca.sha256}</code>. A new certificate
              needs a new install card.
            </p>
          ) : (
            <p>
              The Dashboard has no certificate yet, so chromium-ca refuses until a later install
              card carries one.
            </p>
          )}
          <pre className={`${QUOTE} font-mono text-xs`}>{INSTALL_TEXT}</pre>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      ) : (
        <>
          <p>
            On Approve, your computer asks for your password in its own window, then runs{" "}
            <code className="font-mono break-all">
              {ROOT_DIR}/{preview.step}
            </code>{" "}
            as root. {ROOT_STEPS[preview.step].what}.
          </p>
          <p>To undo it: {ROOT_STEPS[preview.step].undo}.</p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "guard":
      // the key, scope and value exactly as Approve writes them, the value as its JSON
      return (
        <>
          <p>
            On Approve, the dashboard{" "}
            {preview.value === undefined ? "takes the guard setting" : "sets the guard setting"}{" "}
            <code className="font-mono">{preview.key}</code> at{" "}
            <code className="font-mono">{preview.scope}</code>
            {preview.value === undefined ? " back to its default." : " to:"}
          </p>
          {preview.value !== undefined && (
            <pre className={`${QUOTE} font-mono text-xs`}>
              {JSON.stringify(preview.value, null, 2)}
            </pre>
          )}
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
    case "own":
      // the one row and the change Approve asks for; Approve's result line says what it found there
      return (
        <>
          <p>
            On Approve, the dashboard {preview.own ? "marks" : "unmarks"}{" "}
            <code className="font-mono">{preview.key}</code> as your own account in{" "}
            <code className="font-mono">usage.accounts</code> at{" "}
            <code className="font-mono">{preview.scope}</code>: Own{" "}
            {preview.own ? "off → on" : "on → off"}. Every other account stays as it is.
          </p>
          <p className="break-words whitespace-pre-wrap">Why: {preview.why}</p>
        </>
      )
  }
}

const PAUSED_WHY = "This item just moved: its buttons wake in a moment"

// Pick a time's field starts at 09:00, the hour the fixed choices use.
const PICKED_TIME = "09:00"

// The one question each card's Questionnaire holds, shown from the first render.
const QUESTION = "item"

type Answer = (
  action: InboxAction,
  text?: string,
  option?: number,
  options?: number[],
) => Promise<void>

// Opens a folded card to its full self, a reply's its answers and Later back, or folds it again (a dashboard user: "Maybe add a simple shortcut to be able to re-expand it, just like it automatically compacts"); E does the same with focus in the card, as its tooltip says, the scroll bar's Kbd pattern.
function Reopen({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const label = open ? "Collapse" : "Expand"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={label}
            aria-expanded={open}
            aria-keyshortcuts="E"
            onClick={() => setOpen(!open)}
          >
            <RiArrowDownSLine
              className={cn("motion-safe:transition-transform", open && "rotate-180")}
              aria-hidden
            />
          </Button>
        }
      />
      <TooltipContent className="flex items-center gap-2">
        {label}
        <Kbd>E</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

// Later (put an ask away until a time, and it asks again then, which is not a schedule), an icon beside Reply: the fixed times, each with its day and time, or Pick a time, whose row the card draws as its own footer line, since this right group never wraps; the item leaves the list and the count until then.
// The owner's zone, the clock.ownerZone setting, which Schedule's fixed times read in.
const readOwnerZone = async (): Promise<string> => {
  const { data, error } = await unwrap(
    apiClient.v1.settings[":key"].$get({ param: { key: "clock.ownerZone" }, query: {} }),
  )
  if (error) throw new Error(error.message)
  return String(data.value)
}

function Schedule({
  busy,
  held,
  hold,
  onSchedule,
  setPicking,
}: {
  busy: boolean
  held: string | undefined
  hold: { className?: string; focusableWhenDisabled?: boolean }
  onSchedule: (at: string) => void
  setPicking: (picking: boolean) => void
}) {
  const { data, isError } = useQuery({
    queryKey: ["setting", "clock.ownerZone"],
    queryFn: readOwnerZone,
    retry: false,
  })
  // a refused read (no extensions login yet, as on a fixture stack) reads in UTC, the setting's default
  const zone = isError ? "UTC" : data
  return (
    <DropdownMenu>
      <Hint content={held ?? "Later: put it away until a time, then it asks again"}>
        <DropdownMenuTrigger
          render={
            <Button aria-label="Later" size="icon-sm" variant="outline" disabled={busy} {...hold} />
          }
        >
          <RiZzzLine />
        </DropdownMenuTrigger>
      </Hint>
      {/* a key in the menu stays in the menu, since a decision's form would read a digit as its shortcut */}
      <DropdownMenuContent
        align="start"
        className="w-auto"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Ask again{zone ? ` (${zone})` : ""}</DropdownMenuLabel>
          {(zone ? scheduleChoices(new Date(), zone) : []).map((choice) => (
            <DropdownMenuItem key={choice.label} onClick={() => onSchedule(choice.at)}>
              {choice.label}
              <DropdownMenuShortcut>{choice.when}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setPicking(true)}>Pick a time…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// A key on a card as cardKey and reopenKey read it.
const keyOf = (event: KeyboardEvent): CardKey => {
  const target = event.target
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    isComposing: event.nativeEvent.isComposing,
    key: event.key,
    keyCode: event.keyCode,
    metaKey: event.metaKey,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    target:
      target instanceof HTMLTextAreaElement
        ? "box"
        : target instanceof HTMLInputElement && target.type === "radio"
          ? "choice"
          : "elsewhere",
  }
}

// One item as a card: its band, place line and title, then what Approve does or a draft's words, then, once answered or settled, the result on its own line above the footer, wrapping freely, then one footer row with an open card's actions on the left and, on the right, its verbs (verbs()), its chevron, then Reply. The same card sits on every shelf; one that folds by default (foldsByDefault()) shows its band, place line, title, result line and row of choices until opened.
export function InboxCard({
  defaultOpen = false,
  focusHeld = false,
  item,
  marked,
  now,
  onBack,
  paused,
  shelf = "inbox",
  updated,
}: {
  // a card that folds by default starts opened, as a click on it opens it
  defaultOpen?: boolean
  // it came in while focus stands, so it waits uncounted until focus ends
  focusHeld?: boolean
  item: InboxItem
  marked: boolean
  now: number
  // Move back's click, before its answer, so the list shows the card at its top rather than behind the pill
  onBack?: () => void
  paused: boolean
  shelf?: Shelf
  updated: boolean
}) {
  const queryClient = useQueryClient()
  const { allowed, dispatcher, outbox, workers } = useDashboard()
  // what the card answers: everything on a local stack, and on the hosted build its answer, Later and Done where the relay carries them
  const writes = useYardWrites()
  const answers = writes.answers(item)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Check it for me sends its note once
  const [asked, setAsked] = useState(false)
  // a draft's words, editable where they stand, and kept under the card's own key while they can still change (open, or a reply its poster is not done with), so a list refresh or a shelf move that remounts the card gives back what he typed
  const posted = item.kind === "draft" ? item.preview.text : ""
  const keeps = item.kind === "draft" && schedulable(item)
  const keptKey = cardDraftKey(item.id)
  const [kept] = useState(() => (keeps ? readDrafts()[keptKey] : undefined))
  const [draft, setDraft] = useState(kept?.text ?? posted)
  const [saveKept] = useState(() => draftSaver(keptKey, kept))
  const editDraft = (text: string) => {
    setDraft(text)
    saveKept({ attachments: [], text: text === posted ? "" : text })
  }
  // once it is answered, settled or archived, its kept words go
  useEffect(() => {
    if (item.kind === "draft" && !keeps) saveDraft(keptKey, { attachments: [], text: "" })
  }, [item.kind, keeps, keptKey])
  // the poster's bun run ask edit replaces the words in place, unless he has changed them
  const [synced, setSynced] = useState(posted)
  if (posted !== synced) {
    setSynced(posted)
    if (draft === synced) setDraft(posted)
  }
  // a multi-question ask's picks, one option index per question, and the question in sight, held below as the single pick is so the card steps through them before its Submit sends them all at once
  const questions = item.kind === "decision" ? questionsOf(item.preview) : []
  const multi = questions.length > 0
  // a single-question ask's choice rows, used both for the signature below and the pick's row further down
  const choices = multi ? null : decisionChoices(item)
  // the card's answer in progress is kept under its id while it can still take it, and cleared once answered, settled or archived, so it stays in step with a draft card's words
  const keepsAnswer = item.kind === "decision" && schedulable(item)
  // the card's answer in progress comes back after a list refresh or a shelf move remounts it (ask-picks store), as a draft card's words do: its pick(s), the question in sight and the Note, read once under its own id while it still keeps an answer; the pick(s) and step are taken only while the signature still matches, so a stale pick never lands on another option, while the Note stands on its own
  const sig = multi ? picksKey(questions) : choicesKey(choices)
  const [restored] = useState(() => (keepsAnswer ? (readPicks()[item.id] ?? null) : null))
  const sigKept =
    restored !== null &&
    restored.sig === sig &&
    restored.picks.length === questions.length &&
    restored.step < Math.max(questions.length, 1)
  const [pick, setPick] = useState<number | null>(sigKept ? restored.pick : null)
  const [picks, setPicks] = useState<(number | null)[]>(
    sigKept ? restored.picks : questions.map(() => null),
  )
  const [step, setStep] = useState(sigKept ? restored.step : 0)
  // an in-place bun run ask edit can change the questions or a single ask's options under an open card; when the signature moves, drop the pick, picks and step back to the first, as the draft text resyncs above, so a stale pick never lands on another option
  const [syncedPicks, setSyncedPicks] = useState(() => sig)
  if (sig !== syncedPicks) {
    setSyncedPicks(sig)
    setPick(null)
    setPicks(questions.map(() => null))
    setStep(0)
  }
  const [note, setNote] = useState(restored?.note ?? "")
  useEffect(() => {
    savePicks(item.id, keepsAnswer ? { note, pick, picks, sig, step } : EMPTY_PICKS)
  }, [item.id, keepsAnswer, note, pick, picks, sig, step])
  // a secret ask's value, held only until Submit hands it on, then cleared
  const [secret, setSecret] = useState("")
  const secretKey =
    item.kind === "decision" && item.preview.type === "secret" ? item.preview.key : null
  const secretAsk = secretKey !== null
  // a secret ask's or a reveal card's Reply stays in its own box, never the chat's composer, so its value reaches no chat (the API refuses a reveal card's comment that holds its value)
  const keepsReply = secretAsk || (item.kind === "decision" && item.preview.type === "reveal")
  // set by such a card's empty-box Reply, so a muted line under its box says where the note goes, until the box holds text
  const [hinted, setHinted] = useState(false)
  const titleId = useId()
  // every write the card makes goes through here, and a card whose answer the relay does not carry sends nothing; a refusal shows in the Mac's own words
  const settle = async (write: () => Promise<unknown>) => {
    if (!answers) return false
    setPending(true)
    setError(null)
    try {
      await write()
      return true
    } catch (failure) {
      setError((failure as Error).message)
      return false
    } finally {
      await queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      // an own card's Approve writes usage.accounts, so Settings > Accounts reads its switch again
      if (item.kind === "decision" && item.preview.type === "own")
        await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY })
      // a guard card's Approve may turn a job on or off, so Settings > Jobs reads its switches again
      if (item.kind === "decision" && item.preview.type === "guard")
        await queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      setPending(false)
    }
  }
  const onProvide = () => {
    const value = secret
    setSecret("")
    return settle(() => provideSecret(item, value))
  }
  // Schedule's picked time, drawn as its own footer line, since the card's right group never wraps
  const [picking, setPicking] = useState(false)
  const [day, setDay] = useState<Date | undefined>()
  const [time, setTime] = useState(PICKED_TIME)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const when = pickedAt(day, time, new Date())
  const onSchedule = (at: string) => void settle(() => scheduleItem(item.id, at))
  const closePicking = () => {
    setPicking(false)
    setDay(undefined)
    setTime(PICKED_TIME)
  }
  // every card opens and folds by its chevron, a click on a folded one or E; one that folds by default (all but one that needs an answer now) starts folded, and a reply's card opens to its answers and Later
  const [toggled, setToggled] = useState<boolean | null>(defaultOpen ? true : null)
  const folds = foldsByDefault(item, now)
  const open = toggled ?? !folds
  const folded = !open
  const outcome =
    item.kind === "update" || (reopenable(item) && folds && open) ? null : outcomeLine(item)
  // The taker's label in the outcome keeps the raw name on hover, as its band does: its first mention renders under the same Hint.
  const who = agentLabel(takenBy(item))
  const at = outcome === null ? -1 : outcome.indexOf(who)
  const linked = resultLink(item)
  const untold = deliveryNote(item)
  const failed = sendFailed(item) && !untold
  const light = inboxLight(item)
  // a folded row keeps its verbs, and the answers that need nothing its body holds; Seen is the band's tick, on a card in his list he has not marked read, and reading answers nothing
  const buttons = verbs(item, shelf)
  const unread = buttons.includes("seen")
  // the hosted build's relay carries no read mark, so a click there leaves it to this Mac
  const read = () =>
    unread && !paused && !config.hosted ? void settle(() => markRead([item.id])) : undefined
  const busy = pending || paused
  // a row that just moved under him keeps its buttons focusable, dimmed and saying why, so focus stays put and a click meant for another item lands on none
  const hold = paused ? OFF_FOCUSABLE : {}
  const held = paused ? PAUSED_WHY : undefined
  const quiet = (outcome !== null && !failed) || (item.kind === "update" && item.readAt !== null)
  // the comment rides an answer as its note where the card still takes one, a secret's Submit aside, so its value travels alone
  const noted = outcome === null && item.kind !== "update" && !secretAsk
  // an answer takes his comment as its note, so the box empties once it is in; Archive and Move back, and any verb on a card that takes no answer, carry none, so his words stay
  const onAnswer: Answer = async (action, text, option, options) => {
    const sent = await settle(() =>
      answerItem(item, action, text, note.trim() || undefined, option, options),
    )
    if (sent && noted && action !== "archive" && action !== "unarchive") setNote("")
  }
  const commentId = useId()
  // Playground's live session, whose composer, the page's or the aside's, takes a Reply's hand, as the dashboard mounts it
  const chat = allowed ? dispatcherOf(workers, dispatcher) : null
  // Reply with an empty box hands the card's ref to Playground's composer (a secret ask's, or any while that session is down, opens its own box), and with words opens a folded card to them or sends them alone; either box takes focus in the click's own frame, so a paste sent at once lands there
  const onReply = () => {
    const text = note.trim()
    const route = replyRoute({ chat: chat !== null, folded, secret: keepsReply, text })
    if (route === "composer" && chat) {
      flushSync(() => outbox.reply(chat.name, item.ref))
      document.getElementById(COMPOSER_ID)?.focus()
      return
    }
    if (route !== "send") {
      // only a folded card is opened, so one open by default still folds once answered
      if (folded) flushSync(() => setToggled(true))
      if (keepsReply && text === "") setHinted(true)
      document.getElementById(commentId)?.focus()
      return
    }
    const refused = secretAsk ? commentRefused(note, secret) : null
    if (refused) return setError(refused)
    void settle(() => replyItem(item.id, text)).then((sent) => sent && setNote(""))
  }

  const title =
    item.kind === "update" && item.preview.link ? (
      <a
        href={item.preview.link}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline"
        onClick={read}
      >
        {item.title}
      </a>
    ) : unread && !config.hosted ? (
      <button type="button" className="text-left" onClick={read}>
        {item.title}
      </button>
    ) : (
      item.title
    )

  // choices is the single ask's rows computed above, null for a multi-question ask; its footer sits in the form beside its Send while it is open, and every other card's answers from outside it
  const picked = pick === null ? null : (choices?.rows[pick] ?? null)
  // every question of a multi-question ask answered, so its Submit may send them all at once
  const allPicked = multi && picks.every((p) => p !== null)
  const footerInForm = (choices !== null || multi) && outcome === null && !folded
  const draftReady = item.kind === "draft" && outcome === null && !busy && draft.trim() !== ""
  const secretReady = secretAsk && outcome === null && !busy && secret.trim() !== ""
  // what Approve does, the card's description, kept once answered or archived, or what a read-only update shows; a folded card hides it
  const preview = folded ? null : item.kind === "decision" ? (
    <Preview item={item} />
  ) : item.kind === "update" && (item.preview.text || item.preview.attachments) ? (
    <Shown preview={item.preview} />
  ) : null
  // an answered or archived draft's words, read-only, as they went
  const sentWords =
    item.kind === "draft" ? (
      <div className="flex flex-col gap-3 text-sm">
        <SoFar thread={item.preview.thread} />
        <p className={QUOTE}>
          {(item.answer && "editedText" in item.answer && item.answer.editedText) ||
            item.preview.text}
        </p>
        {item.preview.attachments ? <Attachments items={item.preview.attachments} /> : null}
      </div>
    ) : null
  const body = folded ? null : outcome !== null ? (
    sentWords
  ) : choices ? (
    <AskChoices busy={busy} choices={choices} paused={paused} pick={pick} setPick={setPick} />
  ) : secretAsk && !config.hosted ? (
    // masked, never saved by the browser, and a key here stays in the field; Enter submits; enabled while the card is paused, as the comment box is, so a paste in that second lands
    <Input
      aria-label={`Value for ${secretKey}`}
      autoComplete="new-password"
      className={BOX}
      data-1p-ignore
      data-lpignore="true"
      placeholder="Paste the value"
      readOnly={pending}
      spellCheck={false}
      type="password"
      value={secret}
      onChange={(event) => setSecret(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key !== "Enter") return
        event.preventDefault()
        if (secretReady) void onProvide()
      }}
    />
  ) : item.kind === "draft" ? (
    <div className="flex flex-col gap-3 text-sm">
      <SoFar thread={item.preview.thread} />
      <div className="flex flex-col gap-1.5">
        {item.preview.thread && (
          <p className="text-muted-foreground text-xs font-medium">Your message</p>
        )}
        {!answers ? (
          <p className="whitespace-pre-wrap">{draft}</p>
        ) : (
          <Textarea
            aria-label={`Message to ${item.preview.to}`}
            className={BOX}
            value={draft}
            onChange={(event) => editDraft(event.target.value)}
          />
        )}
      </div>
      {item.preview.attachments ? <Attachments items={item.preview.attachments} /> : null}
      <UploadMark item={item} />
    </div>
  ) : null

  // an answered or settled card's result is its description, read above the footer row and wrapping freely, so a long line never comes between its buttons; a multi-question ask shows it as a plain CardDescription, since its header sits outside every QuestionnaireItem and QuestionnaireDescription reads an item's context
  const resultClass = cn("min-w-0 text-xs", light && iconTone(light))
  const resultBody =
    outcome === null ? null : (
      <>
        {at < 0 ? (
          outcome
        ) : (
          <>
            {outcome.slice(0, at)}
            <Hint content={takenBy(item)}>
              <span>{who}</span>
            </Hint>
            {outcome.slice(at + who.length)}
          </>
        )}
        {item.kind !== "update" &&
          item.answer &&
          "note" in item.answer &&
          item.answer.choice !== "settled" &&
          item.answer.note && (
            <span className="text-muted-foreground mt-1 block whitespace-pre-wrap">
              You: {item.answer.note}
            </span>
          )}
        {untold && <span className="text-muted-foreground mt-1 block">{untold}</span>}
        {linked && (
          <>
            {" · "}
            <a
              href={linked.href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "inline-flex items-center gap-1 hover:underline",
                light === "done" && "text-success",
              )}
            >
              {linked.label}
              <RiExternalLinkLine className="size-3" aria-hidden />
            </a>
          </>
        )}
      </>
    )

  // a folded row keeps the answers that need nothing its body holds: an update's Approve link, Retry and Check it for me, but not a decision's pick, a secret's value or a draft's words
  const needsBody = outcome === null && (choices !== null || secretAsk || item.kind === "draft")
  const left =
    folded && needsBody ? null : outcome !== null ? (
      sendUnconfirmed(item) && dispatcher ? (
        <Hint content="Ask the dispatcher to look at the session and tell you whether your answer arrived">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || asked}
            {...hold}
            onClick={() => {
              setAsked(true)
              outbox.send(dispatcher, { attachments: [], text: checkAnswerNote(item) })
            }}
          >
            <RiQuestionLine data-icon="inline-start" />
            Check it for me
          </Button>
        </Hint>
      ) : (
        retryable(item, now) &&
        !config.hosted && (
          <Hint content={held}>
            <Button
              size="sm"
              disabled={busy}
              {...hold}
              onClick={() => void settle(() => retryItem(item.id))}
            >
              <RiRefreshLine data-icon="inline-start" />
              Retry
            </Button>
          </Hint>
        )
      )
    ) : secretAsk ? (
      <Hint content={held}>
        <Button
          size="sm"
          variant="outline"
          className={SIDE_TONES.approve}
          {...hold}
          disabled={!secretReady}
          onClick={() => void onProvide()}
        >
          <RiSendPlaneLine data-icon="inline-start" />
          Submit
        </Button>
      </Hint>
    ) : item.kind === "decision" ? null : item.kind === "draft" ? (
      <>
        <Hint content={held}>
          <Button
            size="sm"
            variant="outline"
            className={SIDE_TONES.approve}
            {...hold}
            disabled={!draftReady}
            onClick={() => void onAnswer("send", draft)}
          >
            <RiSendPlaneLine data-icon="inline-start" />
            Send
          </Button>
        </Hint>
        {canDraft(item) && (
          <Hint
            content={
              paused ? PAUSED_WHY : "Save it as a draft in Slack, for you to finish and send"
            }
          >
            <Button
              size="sm"
              variant="outline"
              className={DRAFT_TONE}
              {...hold}
              disabled={!draftReady}
              onClick={() => void onAnswer("draft", draft)}
            >
              <RiDraftLine data-icon="inline-start" />
              Draft
            </Button>
          </Hint>
        )}
        <Hint content={held}>
          <Button
            size="sm"
            variant="outline"
            className={SIDE_TONES.deny}
            disabled={busy}
            {...hold}
            onClick={() => void onAnswer("discard")}
          >
            <RiCloseLine data-icon="inline-start" />
            Discard
          </Button>
        </Hint>
      </>
    ) : item.kind === "update" && item.preview.approve ? (
      // a pending Yard post's Approve opens Yard's approve page in the browser, where the owner is signed in, since a token never approves (the tier-two rule)
      <Button
        size="sm"
        variant="outline"
        className={SIDE_TONES.approve}
        render={<a href={item.preview.approve} target="_blank" rel="noopener noreferrer" />}
        nativeButton={false}
        onClick={read}
      >
        <RiExternalLinkLine data-icon="inline-start" />
        Approve
      </Button>
    ) : null

  // one icon button per verb, named in its label and saying on hover what it does
  const verb = (name: string, why: string, icon: ReactNode, onClick: () => void) => (
    <Hint key={name} content={held ?? `${name}: ${why}`}>
      <Button
        aria-label={name}
        size="icon-sm"
        variant="outline"
        disabled={busy}
        {...hold}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Hint>
  )
  const right = (
    <div className="ml-auto flex shrink-0 gap-2">
      {buttons.includes("done") &&
        verb(
          "Done",
          "it goes to Done",
          <RiCheckDoubleLine />,
          () => void settle(() => dismissItems([item.id], true)),
        )}
      {buttons.includes("later") && (
        <Schedule
          busy={busy}
          held={held}
          hold={hold}
          onSchedule={onSchedule}
          setPicking={setPicking}
        />
      )}
      {buttons.includes("archive") &&
        verb(
          "Archive",
          "onto the Archive shelf, as it stands; its poster is told nothing, and one that waits keeps waiting",
          <RiArchive2Line />,
          () => void onAnswer("archive"),
        )}
      {buttons.includes("moveBack") &&
        verb("Move back", "back to your list, to answer it again", <RiInboxUnarchiveLine />, () => {
          onBack?.()
          void onAnswer("unarchive")
        })}
      {buttons.includes("dismiss") &&
        verb(
          "Dismiss",
          waiting(item)
            ? "it goes to Done, and its poster is told it is set aside"
            : "it goes to Done, marked dismissed",
          <RiCloseLine />,
          () => void onAnswer("dismiss"),
        )}
      <Reopen open={open} setOpen={setToggled} />
      {/* a Reply is a write the relay does not carry, so the hosted build's comment rides the answer alone */}
      {!config.hosted && (
        <Hint
          content={
            held ??
            (secretAsk || !chat
              ? "Reply: your comment alone, to its poster"
              : "Reply: your comment alone, to its poster, or with the box empty, in your chat")
          }
        >
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Reply to ${itemTag(item)}`}
            className="shrink-0"
            disabled={busy}
            {...hold}
            onClick={onReply}
          >
            <RiReplyLine />
          </Button>
        </Hint>
      )}
    </div>
  )

  // a card whose answer the relay does not carry holds no buttons: a paired hosted page says to answer it on the Mac, and one with no key leaves it to the Inbox's one read-only line
  const footer = !answers ? (
    writes.send ? (
      <CardFooter className="text-muted-foreground text-xs">{ON_THE_MAC_LINE}</CardFooter>
    ) : null
  ) : (
    <CardFooter className="flex-wrap gap-2">
      {footerInForm ? (
        // shadcn's questionnaire actions in a row that wraps on a narrow card: Submit first, off until an option is picked (every question of a multi-question ask) and saying why on hover and focus, then a multi-question ask's Previous and Next between its questions, then the card's own buttons
        <QuestionnaireActions className="flex flex-wrap">
          <Hint
            content={
              held ??
              (multi ? (allPicked ? undefined : "Answer every question first") : sendWhy(picked)) ??
              undefined
            }
          >
            <QuestionnaireSubmit
              // green as a go row, or red once the no-go row is the pick it sends
              className={SIDE_TONES[!multi && picked && !picked.go ? "deny" : "approve"]}
              disabled={busy || (multi ? !allPicked : pick === null)}
              render={<Button size="sm" variant="outline" {...OFF_FOCUSABLE} />}
              size="sm"
              variant="outline"
            >
              <RiSendPlaneLine data-icon="inline-start" />
              Send
            </QuestionnaireSubmit>
          </Hint>
          {multi && (
            <>
              <QuestionnairePrevious disabled={busy || step === 0} size="sm" variant="outline" />
              <QuestionnaireNext
                disabled={busy || step >= questions.length - 1 || picks[step] == null}
                size="sm"
                variant="outline"
                onClick={(event) => {
                  event.preventDefault()
                  setStep((s) => Math.min(s + 1, questions.length - 1))
                }}
              />
            </>
          )}
          {left}
          {right}
        </QuestionnaireActions>
      ) : (
        <>
          {left}
          {right}
        </>
      )}
      {picking && buttons.includes("later") && (
        // shadcn's date and time picker: a day from the Calendar, a time from the field, in this browser's time zone
        <div className="flex basis-full flex-wrap items-center gap-2">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Day to ask again"
                  className="w-32 justify-between font-normal"
                />
              }
            >
              {day
                ? day.toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                    weekday: "short",
                  })
                : "Pick a day"}
              <RiArrowDownSLine data-icon="inline-end" />
            </PopoverTrigger>
            {/* a key in the calendar stays in the calendar, since a decision's form would read a digit as its shortcut */}
            <PopoverContent
              align="start"
              className="w-auto overflow-hidden p-0"
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Calendar
                mode="single"
                selected={day}
                disabled={{ before: new Date() }}
                onSelect={(picked) => {
                  setDay(picked)
                  setCalendarOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
          <Input
            aria-label="Time to ask again"
            className="bg-background w-28 appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            onKeyDown={(event) => {
              // a key here stays in the field, so an E typed into it never folds a reopened card
              event.stopPropagation()
              if (event.key === "Escape") closePicking()
              // Enter here sets nothing and submits no form: Set does that
              if (event.key === "Enter") event.preventDefault()
            }}
          />
          <Button
            size="sm"
            disabled={busy || when === null}
            onClick={() => {
              closePicking()
              if (when) onSchedule(when.toISOString())
            }}
          >
            Set
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={closePicking}>
            Cancel
          </Button>
        </div>
      )}
      {error && <p className="text-destructive basis-full text-xs">{error}</p>}
    </CardFooter>
  )

  // the card's last block before its buttons: his comment, the note with whatever he answers, or alone through Reply, which stays on the Mac, so the hosted build draws it only where it rides an answer; shared by the single-question item and the multi-question steps
  const noteContent =
    !folded && answers && (noted || !config.hosted) ? (
      // the same gap-2 above it as between the choices
      <CardContent className="mt-[calc(--spacing(2)-var(--card-spacing))]">
        {/* a box turned disabled drops focus to the page, so words dictated or typed as a card above leaves land nowhere: it stays enabled while the card is paused and turns read-only while its answer is on its way */}
        <NoteBox
          id={commentId}
          placeholder={
            keepsReply && !config.hosted
              ? "Type a note to Playground, then press Reply"
              : noted
                ? "Add an optional comment"
                : "Add a comment"
          }
          readOnly={pending}
          value={note}
          onChange={(event) => {
            setNote(event.target.value)
            if (event.target.value.trim() !== "") setHinted(false)
          }}
        />
        {hinted && (
          <p className="text-muted-foreground mt-2 text-xs">
            Type your note in the box above, then press Reply. The token goes in its own field
          </p>
        )}
      </CardContent>
    ) : null

  return (
    <Card
      id={needsYouAnchor(item.id)}
      {...{ [HOLDS_RELOAD]: "" }}
      role="listitem"
      // focusable from script alone, so taking the pill can hand focus to the card it put on top
      tabIndex={-1}
      size="sm"
      className={cn(
        // no outer card: the item sits flat on the Inbox, edge to edge, under its KindBand
        "wrap-anywhere overflow-visible rounded-none bg-transparent px-0 pt-0 ring-0 outline-none [&_[data-slot=card-content]]:px-0 [&_[data-slot=card-footer]]:rounded-none [&_[data-slot=card-footer]]:border-t-0 [&_[data-slot=card-footer]]:bg-transparent [&_[data-slot=card-footer]]:px-0 [&_[data-slot=card-header]]:px-0",
        folded && "cursor-pointer",
      )}
      // a click on a folded card opens it, and E opens or folds it, with focus anywhere in the card but its box
      onClick={
        folded
          ? (event) => {
              if (!(event.target as Element).closest("a, button, input, textarea")) setToggled(true)
            }
          : undefined
      }
      onKeyDown={(event) => {
        if (!reopenKey(keyOf(event))) return
        event.preventDefault()
        setToggled(!open)
      }}
    >
      <KindBand
        busy={busy}
        focusHeld={focusHeld}
        item={item}
        now={now}
        onRead={() => read()}
        replying={marked}
        unread={unread}
        updated={updated}
      />
      {/* the card is one question on shadcn's Questionnaire, composed with the Card's slots as shadcn's own card example does: its title and description are the question's; a decision's footer sits in the form beside its Submit, while every other card's footer answers from outside it, so a key pressed on one of its buttons never submits it */}
      <Questionnaire
        // a contents box, so the card's slots lay out as they would with no form between them
        className="contents"
        shortcuts="numbers"
        // an answer unmounts the choices it was checked against, which the Questionnaire then reads as unanswered and marks aria-invalid, so the answered card starts a fresh one
        key={outcome === null ? "open" : "answered"}
        // a multi-question ask shows one question at a time (step), every other card its one question
        {...(multi
          ? { item: `q${step}`, onItemChange: (id: string) => setStep(Number(id.slice(1))) }
          : { defaultItem: QUESTION })}
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          if (multi) {
            if (allPicked) void onAnswer("approve", undefined, undefined, picks as number[])
          } else if (picked)
            void (picked.go ? onAnswer("approve", undefined, picked.index) : onAnswer("deny"))
        }}
        // Cmd or Ctrl+Enter submits the question: a decision's picked row through the Questionnaire's submit, nothing before a pick (a multi-question ask before its last question is answered), and in any other card's box what the box holds, through the button it feeds; read as the key comes down, before the Questionnaire's own handler, so a key on a link or a button reaches the browser alone
        onKeyDownCapture={(event) => {
          const action = cardKey(keyOf(event), {
            choosing: footerInForm,
            draftReady,
            picked: multi ? allPicked : pick !== null,
          })
          if (action === null) return
          if (action === "leave") return event.stopPropagation()
          event.preventDefault()
          if (action === "send") void onAnswer("send", draft)
        }}
      >
        {multi ? (
          <>
            {/* a multi-question ask's title and words stand above its questions, outside any one of them, so they hold while the steps change under them */}
            <CardHeader className="grid-cols-[minmax(0,1fr)]">
              <Place item={item} />
              <CardTitle
                className={cn(
                  "flex items-start gap-2",
                  quiet && "text-muted-foreground font-normal",
                )}
              >
                <span className={LEAD}>
                  {unread && !light && (
                    <span aria-hidden className="bg-primary size-2 rounded-full" />
                  )}
                  {light && <Light state={light} />}
                </span>
                {title}
                {unread && <span className="sr-only"> (unread)</span>}
              </CardTitle>
              {preview && (
                <CardDescription className="flex flex-col gap-1 text-xs [&>[data-slot=attachment-thumbs]]:mt-2">
                  {preview}
                </CardDescription>
              )}
              {resultBody && (
                <CardDescription className={resultClass}>{resultBody}</CardDescription>
              )}
            </CardHeader>
            {outcome === null && !folded && (
              <CardContent className="grid gap-(--card-spacing)">
                <QuestionnaireProgress />
                {questions.map((question, q) => (
                  <QuestionnaireItem key={q} name={`q${q}`} className="gap-2">
                    <QuestionnaireTitle className="text-xs">{question.question}</QuestionnaireTitle>
                    <QuestionChoices
                      busy={busy}
                      paused={paused}
                      pick={picks[q] ?? null}
                      question={question}
                      setPick={(index) =>
                        setPicks((prev) => prev.map((p, i) => (i === q ? index : p)))
                      }
                    />
                  </QuestionnaireItem>
                ))}
              </CardContent>
            )}
            {noteContent}
          </>
        ) : (
          <QuestionnaireItem
            aria-labelledby={titleId}
            name={QUESTION}
            className="gap-(--card-spacing)"
          >
            {/* one column no wider than the card, so a wide table or drawing in the ask scrolls inside it rather than stretching the card */}
            <CardHeader className="grid-cols-[minmax(0,1fr)]">
              <Place item={item} />
              <QuestionnaireTitle
                id={titleId}
                render={<CardTitle />}
                // the card's own gap spaces the title from what follows, so it takes none of the bare Questionnaire's room below a title with no description
                className={cn(
                  "flex items-start gap-2 [&:not(:has(~[data-slot=questionnaire-description]))]:mb-0",
                  quiet && "text-muted-foreground font-normal",
                )}
              >
                <span className={LEAD}>
                  {/* the unread dot stands in for an update's light; an ask keeps its light, and its ✓✓ says unread */}
                  {unread && !light && (
                    <span aria-hidden className="bg-primary size-2 rounded-full" />
                  )}
                  {light && <Light state={light} />}
                </span>
                {title}
                {unread && <span className="sr-only"> (unread)</span>}
              </QuestionnaireTitle>
              {preview && (
                <QuestionnaireDescription
                  render={<CardDescription />}
                  // every ask's words read small, a Slack message's and a ticket's included
                  // its files sit gap-3 below the words, as the choices sit below the files
                  className="flex flex-col gap-1 text-xs [&>[data-slot=attachment-thumbs]]:mt-2"
                >
                  {preview}
                </QuestionnaireDescription>
              )}
              {resultBody && (
                <QuestionnaireDescription className={resultClass}>
                  {resultBody}
                </QuestionnaireDescription>
              )}
            </CardHeader>
            {body && <CardContent>{body}</CardContent>}
            {noteContent}
          </QuestionnaireItem>
        )}
        {footerInForm && footer}
      </Questionnaire>
      {!footerInForm && footer}
    </Card>
  )
}

// The note under an ask, as tall as its first choice whatever that grows to (a Hint's render overwrites the choice's own data-slot, so it is read as the choices' first child), and growing past it as he types; as tall as an Approve choice on a card with no choices.
function NoteBox(
  props: Pick<
    ComponentProps<typeof Textarea>,
    "id" | "onChange" | "placeholder" | "readOnly" | "value"
  >,
) {
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const area = box.current
    const choice = area
      ?.closest("[role=listitem]")
      ?.querySelector<HTMLElement>("[data-slot=questionnaire-choices] > *")
    if (!area || !choice) return
    const observer = new ResizeObserver(() => {
      area.style.minHeight = `${choice.offsetHeight}px`
    })
    observer.observe(choice)
    return () => observer.disconnect()
  }, [])
  return (
    <Textarea
      ref={box}
      aria-label="Comment"
      className={cn("min-h-14 py-2", BOX)}
      // a paste lands as the text its event carried, as the composer's does, since the browser's own insert reads the clipboard again, which a dictation app may have put back by then
      onPaste={(event) => void insertPaste(event)}
      {...props}
    />
  )
}

// Taking what waits behind the pill glides the rows already in view down from the top while the taken ones fade in above them, this long; nothing moves under reduced motion.
const GLIDE_MS = 300

function glide(list: HTMLElement | null, taken: number, below: HTMLElement | null) {
  if (!list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const rows = [...list.children] as HTMLElement[]
  const first = rows[0]
  const kept = rows[taken]
  if (!first || !kept) return
  const by = kept.offsetTop - first.offsetTop
  const timing = { duration: GLIDE_MS, easing: "ease-out" }
  for (const row of [...rows.slice(taken), ...(below ? [below] : [])])
    row.animate([{ transform: `translateY(-${by}px)` }, { transform: "none" }], timing)
  for (const row of rows.slice(0, taken)) row.animate([{ opacity: 0 }, { opacity: 1 }], timing)
}

// The pill comes in sliding down and fading in, and fades out, this long; under reduced motion it just appears and goes.
const PILL_MS = 200

// What waits behind the pill, kept PILL_MS past the last so the pill fades out with the words it had; null once it has gone.
function usePill(count: number): { count: number; leaving: boolean } | null {
  const [last, setLast] = useState(count)
  useEffect(() => {
    if (count > 0) {
      setLast(count)
      return
    }
    const timer = setTimeout(() => setLast(0), PILL_MS)
    return () => clearTimeout(timer)
  }, [count])
  const shown = count || last
  return shown > 0 ? { count: shown, leaving: count === 0 } : null
}

// The rows that just moved under him, by their ids in order joined with spaces (null while the inbox loads), each paused for MOVED_PAUSE_MS from its latest move.
function useMovedPause(key: string | null): ReadonlySet<string> {
  const before = useRef<string[] | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [paused, setPaused] = useState<ReadonlyMap<string, number>>(new Map())
  useLayoutEffect(() => {
    const step = movedStep(before.current, key === null ? null : key ? key.split(" ") : [])
    before.current = step.before
    if (step.moved.length === 0) return
    const until = Date.now() + MOVED_PAUSE_MS
    setPaused((now) => new Map([...now, ...step.moved.map((id) => [id, until] as const)]))
    // each wake ends only its own move's pause, so a later move's stays whatever the clock reads
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setPaused((now) => new Map([...now].filter(([, at]) => at > until)))
    }, MOVED_PAUSE_MS)
    timers.current.add(timer)
  }, [key])
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])
  return new Set(paused.keys())
}

// Whether the open items start open; the shelves under them start shut.
export const FOLDS_OPEN = { open: true } as const

// A panel clips for its fold, so it reaches over the pane's side padding and pads back, and a card's band and round ends show whole; links in a card keep their own look
const SHELVES =
  "[&_[data-slot=accordion-content]]:-mx-(--pane-x) [&_[data-slot=accordion-content]]:px-(--pane-x)"
const SHELF_PANEL = "[&_a]:no-underline [&_p:not(:last-child)]:mb-0"

// A shelf's row: its icon, its name and how many it holds, the count a mono outline label; an empty shelf's row is grayed and shut by its disabled item.
export function ShelfLabel({
  count,
  icon: Icon,
  label,
  unread,
}: {
  count?: number
  icon: RemixiconComponentType
  label: string
  unread?: number
}) {
  return (
    <span className="text-muted-foreground flex items-center gap-2">
      <Icon className="size-3.5" aria-hidden />
      {label}
      {/* small, beside the row's words */}
      {count !== undefined && (
        <Badge variant="outline" className="text-2xs h-4 px-1.5 font-mono tabular-nums">
          {count}
        </Badge>
      )}
      {unread !== undefined && <span className="sr-only">, {unread} unread</span>}
    </span>
  )
}

// A shelf header's ✓, an icon alone as the open row's Mark all as read is, gone once nothing on the shelf is left to dismiss
export function ShelfDismiss({
  disabled,
  ids,
  label,
  onDismiss,
}: {
  disabled: boolean
  ids: string[]
  label: string
  onDismiss: (ids: string[]) => void
}) {
  if (ids.length === 0) return null
  return (
    <div className="absolute top-1.5 right-[calc(var(--pane-x,0px)+1.75rem)]">
      <Hint content={label}>
        <Button
          aria-label={label}
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
          disabled={disabled}
          onClick={() => onDismiss(ids)}
        >
          <RiCheckLine />
        </Button>
      </Hint>
    </div>
  )
}

// The pill that puts what arrived on top, the same xs outline Button as Mark all as read beside it.
export function NewPill({
  count,
  leaving,
  onTake,
  ref,
}: {
  count: number
  leaving: boolean
  onTake: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    // white, the one call to act on the open row
    <Button
      ref={ref}
      size="xs"
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      className={cn(
        "shrink-0 duration-200 ease-out",
        leaving
          ? "fill-mode-forwards pointer-events-none motion-safe:animate-out motion-safe:fade-out-0 motion-reduce:hidden"
          : "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2",
      )}
      onClick={onTake}
    >
      <RiArrowUpLine data-icon="inline-start" />
      {/* in a pane too narrow for the whole line it reads as its count alone, so the line never runs past its pane */}
      <span aria-hidden className="@sm:hidden">
        {count} new
      </span>
      <span className="sr-only @sm:not-sr-only">{newLabel(count)}</span>
    </Button>
  )
}

// The Inbox's first load: its open row where it will sit with no count until there is one to show, the Mark all as read room kept, the Spinner under it, so the data lands below without moving the row
function InboxLoading() {
  return (
    <section aria-busy aria-label="Inbox" className="@container flex flex-col gap-3">
      <Accordion className={SHELVES}>
        <AccordionItem value="open" disabled className={SHELF_ITEM}>
          <AccordionTrigger
            className={SHELF_ROW}
            header={(props) => (
              <h3 {...props} className={cn(props.className, STICKY_HEADER, OPEN_HEADER)} />
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 pr-10">
              <RiInboxLine className="size-3.5 shrink-0" aria-hidden />
              <span className="text-muted-foreground truncate">Inbox</span>
            </span>
            <ShelfMark empty />
          </AccordionTrigger>
        </AccordionItem>
      </Accordion>
      <div className="text-muted-foreground grid place-items-center pt-8">
        <Spinner />
      </div>
    </section>
  )
}

// Playground's Inbox: one list of cards, each keeping its place while he looks, what arrived since waiting behind a pill until he takes it, then In progress, Later, Archive and Done as rows that open and shut.
export function Inbox({ viewing }: { viewing: boolean }) {
  const { allowed } = useDashboard()
  const { data, error, isPending } = useInbox(allowed)
  const queryClient = useQueryClient()
  const now = useNow()
  const writes = useYardWrites()
  const [bulkPending, setBulkPending] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  // the ids in the order he sees them, set on the first read and when he takes what waits behind the pill
  const [order, setOrder] = useState<string[] | null>(null)
  const items = data?.items ?? []
  // a card moves by a verb alone: an answer its poster carries out goes to In progress, and one he dismissed or its poster closed to Done
  const { archived: setAside, done, progress, shown } = inboxView(items)
  // Archive holds what he archived, kept out of items, and what was set aside before Archive kept items open
  const archived = [...(data?.archived ?? []), ...setAside].sort((a, b) => b.ref - a.ref)
  const snoozed = data?.snoozed ?? []
  // the shelves under the open items, each row's place, icon and cards, the place its key in the accordion and for a link to a shelved card
  const shelves = [
    ["progress", RiProgress4Line, progress],
    ["snoozed", RiZzzLine, snoozed],
    ["archived", RiArchive2Line, archived],
    ["done", RiCheckDoubleLine, done],
  ] as const
  const { held, rows } = pinnedView(shown, order)
  const pill = usePill(held.length)
  // the look before this one and the newest change as this one began: a card changed between the two reads Updated until he looks away and back, while one that changes as he looks shows in place
  const [look, setLook] = useState<{
    since: string | null
    upto: string | null
  } | null>(null)
  if (viewing && data && look === null)
    setLook({ since: readMark("inbox"), upto: inboxMark(items) })
  if (!viewing && look !== null) setLook(null)
  const updated = (item: InboxItem) => look !== null && updatedSince(item, look.since, look.upto)
  const quiet = new Set(data?.quiet ?? [])
  const rowIds = rows.map((item) => item.id)
  if (data && order?.join(" ") !== rowIds.join(" ")) setOrder(rowIds)
  // a card he moved back from Archive takes the list's top once it arrives, his own click, never behind the pill
  const [back, setBack] = useState<string | null>(null)
  if (back !== null && held.some((item) => item.id === back)) {
    setBack(null)
    setOrder([back, ...rowIds])
  }
  const paused = useMovedPause(data ? [...rowIds, ...done.map((item) => item.id)].join(" ") : null)
  const list = useRef<HTMLDivElement>(null)
  const below = useRef<HTMLDivElement>(null)
  const [listOpen, setListOpen] = useState<boolean>(FOLDS_OPEN.open)
  const [shelvesOpen, setShelvesOpen] = useState<string[]>([])
  // the brand's click opens the Preview row, whether it came before this mounted or after
  useEffect(() => {
    const open = () => {
      if (takePreview())
        setShelvesOpen((keys) => (keys.includes("Preview") ? keys : [...keys, "Preview"]))
    }
    open()
    window.addEventListener(OPEN_PREVIEW, open)
    return () => window.removeEventListener(OPEN_PREVIEW, open)
  }, [])
  const taken = useRef(0)
  const pillButton = useRef<HTMLButtonElement>(null)
  const take = () => {
    setListOpen(true)
    taken.current = held.length
    setOrder([...held.map((item) => item.id), ...rowIds])
  }
  useLayoutEffect(() => {
    if (taken.current === 0) return
    glide(list.current, taken.current, below.current)
    focusAfterTake(
      pillButton.current,
      document.activeElement,
      list.current?.firstElementChild as HTMLElement | null,
    )?.focus({ preventScroll: true })
    taken.current = 0
  })
  // a link to an item (a Waiting on your inbox badge, Playground's row) scrolls the list to it once it is read
  useNeedsYouTarget(data !== undefined, (anchor, source) => {
    // one still behind the pill takes what waits, so the next try finds its row
    if (held.some((item) => needsYouAnchor(item.id) === anchor)) {
      take()
      return false
    }
    // a folded list opens first, so the next try finds its row
    if (!listOpen && rows.some((item) => needsYouAnchor(item.id) === anchor)) {
      setListOpen(true)
      return false
    }
    // a click on a card on a shut shelf (an answer's chip names one) opens its shelf first, so the next try finds its row
    const shelf = shelfToOpen(anchor, source, shelves, shelvesOpen)
    if (shelf) {
      setShelvesOpen((keys) => [...keys, shelf])
      return false
    }
    const row = document.getElementById(anchor)
    row?.scrollIntoView({ block: "center" })
    // a row in a hidden tab cannot scroll yet, so it is tried again once its tab shows
    return row !== null && row.offsetParent !== null
  })
  const reply = useTypedReply()
  if (isPending) return <InboxLoading />
  if (error) return <p className="text-destructive text-sm">{error.message}</p>
  const summary = inboxSummary(shown)
  // what Mark all as read marks: every unread update, ask and draft on screen, each staying in the list as it is until done
  const unreadIds = rows
    .filter((item) => item.readAt === null && (item.kind === "update" || item.status === "open"))
    .map((item) => item.id)
  const clearing = unreadIds.length
  const shelfSizes: Record<string, number> = Object.fromEntries(
    shelves.map(([place, , shelf]) => [place, shelf.length]),
  )
  const actions = (pill || rows.length > 0) && (
    <div className="absolute top-1.5 right-[calc(var(--pane-x,0px)+1.75rem)] flex items-center gap-2">
      {pill && <NewPill ref={pillButton} count={pill.count} leaving={pill.leaving} onTake={take} />}
      {/* an icon alone, bare like the chevron beside it: the card's ✓ while anything is unread, its muted ✓✓ once all is read */}
      {config.hosted ? null : clearing === 0 ? (
        <span className="text-muted-foreground grid size-6 place-items-center">
          <RiCheckDoubleLine className="size-3" aria-label="All read" />
        </span>
      ) : (
        <Hint content={`Mark all as read: ${clearing} stay in the list until done`}>
          <Button
            aria-label="Mark all as read"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
            disabled={bulkPending}
            onClick={() => void bulk(() => markRead(unreadIds))}
          >
            <RiCheckLine />
          </Button>
        </Hint>
      )}
    </div>
  )
  const bulk = async (write: () => Promise<unknown>) => {
    setBulkPending(true)
    setBulkError(null)
    try {
      await write()
    } catch (failure) {
      setBulkError((failure as Error).message)
    } finally {
      await queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      setBulkPending(false)
    }
  }
  return (
    <section aria-label="Inbox" className="@container flex flex-col gap-3">
      {!writes.send && <ReadOnlyLine />}
      {/* one accordion, each row an icon, its words and a count: the open items first, then the shelves, an empty row grayed and shut */}
      <Accordion
        multiple
        className={SHELVES}
        // an empty row is always shut, so an Inbox with nothing in a row never shows it open on a blank panel; the open list keeps his choice while it is empty, so it shows again when items come
        value={[
          ...(listOpen && rows.length > 0 ? ["open"] : []),
          ...shelvesOpen.filter((key) => key === "Preview" || (shelfSizes[key] ?? 0) > 0),
        ]}
        onValueChange={(value: string[]) => {
          if (rows.length > 0) setListOpen(value.includes("open"))
          setShelvesOpen(value.filter((key) => key !== "open"))
        }}
      >
        {/* the new pill and Mark all as read sit on the open row's right, before its chevron, laid over the row since a button cannot sit inside its trigger */}
        <AccordionItem value="open" disabled={rows.length === 0} className={SHELF_ITEM}>
          <AccordionTrigger
            className={SHELF_ROW}
            header={(props) => (
              <h3 {...props} className={cn(props.className, STICKY_HEADER, OPEN_HEADER)}>
                {props.children}
                {actions}
              </h3>
            )}
          >
            {/* room on the right for the pill and Mark all as read, so the chevron stays rightmost */}
            <span
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2",
                pill ? "pr-40" : rows.length > 0 && "pr-10",
              )}
            >
              <RiInboxLine className="size-3.5 shrink-0" aria-hidden />
              <span
                className={cn(
                  "truncate",
                  summary === null ? "text-muted-foreground" : "text-foreground",
                )}
              >
                Inbox
              </span>
              <span className="sr-only">{summary ?? "All caught up"}</span>
              {/* the row reads Inbox and its count, zero included, as each shelf does, the summary for a screen reader */}
              <Badge variant="outline" className="text-2xs h-4 px-1.5 font-mono tabular-nums">
                {shown.length}
              </Badge>
            </span>
            <ShelfMark empty={shown.length === 0} />
          </AccordionTrigger>
          {/* kept mounted while folded, so a fold keeps what a card holds: a draft typed, a picked option, a half-set Later, a reopened card */}
          <AccordionContent keepMounted className={SHELF_PANEL}>
            {bulkError && <p className="text-destructive pt-4 text-xs">{bulkError}</p>}
            <div ref={list} role="list" className="flex flex-col gap-6 pt-8 pb-3">
              {rows.map((item) => (
                <InboxCard
                  key={item.id}
                  focusHeld={quiet.has(item.id)}
                  item={item}
                  marked={item.ref === reply?.ref}
                  now={now}
                  paused={paused.has(item.id)}
                  updated={updated(item)}
                />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
        <div ref={below}>
          {shelves.map(([place, Icon, shelf]) => {
            const label = SHELF_LABELS[place]
            const { bulk: sweep, muted, unread } = shelfRow(place, shelf)
            return (
              <AccordionItem
                key={place}
                value={place}
                disabled={shelf.length === 0}
                className={SHELF_ITEM}
              >
                <AccordionTrigger
                  // Done at 0 unread reads as muted as an empty shelf, yet still opens to its history
                  className={cn(
                    SHELF_ROW,
                    muted && "opacity-50 hover:opacity-100 aria-expanded:opacity-100",
                  )}
                  header={(props) => (
                    <h3 {...props} className={cn(props.className, STICKY_HEADER)}>
                      {props.children}
                      {/* the Archive shelf empties in one click, each card's own Dismiss in turn; Done marks what settled on its own read, typing nothing into any session, greyed once all are */}
                      {sweep && !config.hosted && (
                        <ShelfDismiss
                          disabled={bulkPending}
                          ids={sweep.ids}
                          label={
                            sweep.each ? `Dismiss all in ${label}` : `Mark all in ${label} as read`
                          }
                          onDismiss={(ids) =>
                            void bulk(() =>
                              sweep.each
                                ? dismissEach(shelf.filter((item) => ids.includes(item.id)))
                                : dismissItems(ids),
                            )
                          }
                        />
                      )}
                    </h3>
                  )}
                >
                  {/* every shelf counts what it holds, Done its history too, its ✓ and its muting saying whether any is unread */}
                  <ShelfLabel count={shelf.length} icon={Icon} label={label} unread={unread} />
                  <ShelfMark empty={shelf.length === 0} />
                </AccordionTrigger>
                {/* kept mounted while shut, as the open row is, so a card opened on its shelf stays opened */}
                <AccordionContent keepMounted className={SHELF_PANEL}>
                  <div role="list" className="flex flex-col gap-3 pt-8 pb-3">
                    {shelf.map((item) => (
                      <InboxCard
                        key={item.id}
                        item={item}
                        marked={item.ref === reply?.ref}
                        now={now}
                        paused={paused.has(item.id)}
                        onBack={() => setBack(item.id)}
                        shelf={place}
                        updated={updated(item)}
                      />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )
          })}
          {/* the Preview row under Done, there whether or not the Inbox holds anything: a live page from a dev stack or Previews, the pane's room below it as a browser */}
          <AccordionItem value="Preview" className={SHELF_ITEM}>
            <AccordionTrigger
              className={SHELF_ROW}
              header={(props) => <h3 {...props} className={cn(props.className, STICKY_HEADER)} />}
            >
              <ShelfLabel icon={RiWindowLine} label="Preview" />
              <ShelfMark />
            </AccordionTrigger>
            <AccordionContent className={SHELF_PANEL}>
              <div className="pt-3">
                <PreviewPane />
              </div>
            </AccordionContent>
          </AccordionItem>
        </div>
      </Accordion>
    </section>
  )
}
