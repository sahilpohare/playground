"use client"

import { useChat } from "@ai-sdk/react"
import type { Worker } from "@api/hono"
import {
  RiArrowGoBackLine,
  RiBrainLine,
  RiChat3Line,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiErrorWarningLine,
  RiGitBranchLine,
  RiHistoryLine,
  RiInboxArchiveLine,
  RiQuestionLine,
  RiRefreshLine,
  RiToolsLine,
} from "@remixicon/react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

import { Checkpoint } from "@/components/checkpoint"
import { ActivityLine } from "@/components/dashboard/activity-line"
import { AgentLink } from "@/components/dashboard/agent-link"
import {
  AttachmentChips,
  chipsFromEntry,
  chipsFromRefs,
  type AttachmentChipItem,
} from "@/components/dashboard/attachments"
import {
  carriesHand,
  chatShown,
  countKeys,
  dropsLead,
  endOf,
  handDown,
  HAND_MS,
  handShift,
  handUp,
  heldRoom,
  jumpEnds,
  jumpKey,
  jumpTarget,
  keyWay,
  modeAfter,
  newCount,
  opensAtEnd,
  ownEnd,
  paceAfterScrollDown,
  paceNow,
  partKey,
  pastSince,
  pulledUp,
  readsView,
  ROW_WORDS,
  rowKey,
  sendAnchor,
  sendLeads,
  showsToLatest,
  startsScrollDown,
  scrollsInside,
  markSteps,
  SEEN_OBSERVER,
  STREAM_ROW,
  STREAM_SCROLL,
  TO_LATEST_HOLD_MS,
  turnRoom,
  viewShift,
  watchKeyScroll,
  wheelsToEnd,
  wheelWay,
  wordsIn,
  type ChatMode,
  type HandWay,
  type ModeAct,
  type SentIn,
  type StepMark,
} from "@/components/dashboard/chat-scroll"
import { composerId } from "@/components/dashboard/composer"
import { useDashboard, type DashboardStream } from "@/components/dashboard/dashboard"
import { LoginExpired } from "@/components/dashboard/login-expired"
import { NeedsYouCard } from "@/components/dashboard/needs-you-card"
import { ScrollBar } from "@/components/dashboard/scroll-bar"
import { CopyMessage, FooterAction, StatusFooter } from "@/components/dashboard/status-mark"
import { useGlide, type RowFacts } from "@/components/dashboard/use-glide"
import { TranscriptMarkdown } from "@/components/transcript-markdown"
import {
  leadsWithImage,
  TranscriptBubble,
  TranscriptMessage,
} from "@/components/transcript-message"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { MessageFooter } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { CenterSpinner, PulseDot, Spinner } from "@/components/ui/spinner"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { useTypedHold } from "@/hooks/use-typed-hold"
import {
  agentLabel,
  chatLabel,
  messageRecipient,
  withoutRef,
  withoutSenderName,
} from "@/lib/agent-label"
import { socketsOf, useAgentsBoard } from "@/lib/agents"
import {
  attachmentsOf,
  firstLineOf,
  outboxOf,
  SUBAGENT_TOOLS,
  subagentRunning,
  textOf,
  toUIMessages,
  type DashboardMessage,
  type DashboardToolOutput,
  type DashboardToolPart,
  type Outbox,
} from "@/lib/chat"
import { readChatPrefs, prefsOf, saveChatPrefs, useChatPrefs } from "@/lib/chat-mode"
import { config } from "@/lib/config"
import { fetchSubagentSteps, oneLine, type Older } from "@/lib/dashboard"
import { stepOf } from "@/lib/live-activity"
import { useMakerIcon } from "@/lib/model-icons"
import { initialsOf, rowModelName, rowProvider } from "@/lib/model-label"
import {
  lostPrompt,
  needsYouAnchor,
  streamItems,
  useNeedsYouTarget,
  type StreamNeed,
} from "@/lib/needs-you"
import {
  canCheck,
  canRetry,
  checkNote,
  deliveredAt,
  isNext,
  isUnsentMarker,
  landed,
  othersWaiting,
  pendingAction,
  retryNote,
  statusLine,
  statusMark,
  undoOf,
  undoState,
  UNSENT_MARKER,
  waiting as queuedFor,
  type OutboxMessage,
} from "@/lib/outbox"
import { fullTime } from "@/lib/time"

// A message's recipient by its label, the board's socket address resolved to its session; plain text, since the row it sits in is one button, and the open row links it.
function Recipient({ to }: { to: string }) {
  const sockets = useAgentsBoard(socketsOf).data
  return agentLabel(sockets?.[to] ?? withoutRef(to))
}

// A message row's tail after its bright verb, in the title's muted tone: to or from, the other session (a session when unknown), then the message's first line, so a sent and a received message read alike.
function Addressed({ by, rest, to }: { by: "from" | "to"; rest: string; to: string | null }) {
  return (
    <>
      {` ${by} `}
      {to ? <Recipient to={to} /> : "a session"}
      {`: ${rest}`}
    </>
  )
}

const recipientOf = (part: DashboardToolPart) =>
  part.toolName === "SendMessage" ? messageRecipient(part.input.summary) : null

const outputOf = (part: DashboardToolPart): DashboardToolOutput | null =>
  part.state === "output-available" ? (part.output as DashboardToolOutput) : null

const RUNNING = new Set<DashboardToolPart["state"]>(["input-available", "input-streaming"])

// A tool row's line, as AI Elements' Tool draws it: its icon, then its name and one-line summary truncating together; a running call shimmers and a failed one is red, each also said in words for a screen reader. Its icon says the state too, so neither rests on motion or colour alone: the pulsing dot while it runs (it stays under reduced motion, where the shimmer stops), a warning when it failed.
function ToolLine({ icon, part }: { icon: ReactNode; part: DashboardToolPart }) {
  const message = recipientOf(part)
  const failed = part.state === "output-error"
  const running = RUNNING.has(part.state)
  return (
    <TraceLine status={running ? "running" : failed ? "error" : undefined} className="text-xs">
      <TraceIcon>{running ? <PulseDot /> : failed ? <RiErrorWarningLine /> : icon}</TraceIcon>
      <TraceTitle>
        {running ? <span className="sr-only">Running: </span> : null}
        {failed ? <span className="sr-only">Failed: </span> : null}
        <span className="text-foreground in-data-[status=error]:text-destructive font-medium">
          {part.title ?? part.toolName}
        </span>
        {message ? (
          <Addressed by="to" rest={message.rest} to={message.to} />
        ) : part.input.summary ? (
          ` ${part.input.summary}`
        ) : null}
      </TraceTitle>
    </TraceLine>
  )
}

// A call's input or what it returned, as plain text in a CodeBlock with no language, so nothing in it is highlighted or rendered.
function ToolText({
  children,
  label,
  variant,
}: {
  children: string
  label: string
  variant?: "destructive"
}) {
  return (
    <CodeBlock size="sm" variant={variant}>
      <CodeBlockHeader>
        <CodeBlockTitle>{label}</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-64">
        {children}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function ToolOutput({ part }: { part: DashboardToolPart }) {
  if (part.errorText)
    return (
      <ToolText label="Error" variant="destructive">
        {part.errorText}
      </ToolText>
    )
  const output = outputOf(part)?.text
  return output ? <ToolText label="Result">{output}</ToolText> : null
}

// a tool row draws again only when what it shows moved, since every new step of a turn hands its older calls in as new objects
export const sameTool = (
  a: { defaultOpen?: boolean; part: DashboardToolPart },
  b: { defaultOpen?: boolean; part: DashboardToolPart },
) =>
  a.defaultOpen === b.defaultOpen &&
  a.part.errorText === b.part.errorText &&
  a.part.input.json === b.part.input.json &&
  a.part.input.summary === b.part.input.summary &&
  outputOf(a.part)?.agentId === outputOf(b.part)?.agentId &&
  outputOf(a.part)?.text === outputOf(b.part)?.text &&
  a.part.state === b.part.state &&
  a.part.title === b.part.title &&
  a.part.toolName === b.part.toolName

export const ToolStep = memo(ToolStepRow, sameTool)

// One tool call, closed to its row: what it was and its one-line summary, opening to its input and what it returned (a message's recipient linked to its view while it is live). Only a test starts it open.
function ToolStepRow({ defaultOpen, part }: { defaultOpen?: boolean; part: DashboardToolPart }) {
  const message = recipientOf(part)
  return (
    <Trace>
      <TraceCollapsible defaultOpen={defaultOpen}>
        <TraceCollapsibleTrigger>
          <ToolLine icon={<RiToolsLine />} part={part} />
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {message ? (
            <p className="text-xs">
              To <AgentLink name={message.to} className="text-foreground" />
            </p>
          ) : null}
          {part.input.json ? <ToolText label="Input">{part.input.json}</ToolText> : null}
          <ToolOutput part={part} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

// A session's thinking as AI Elements' Reasoning: closed, since a transcript's thinking is whole when it is read, and its words through TranscriptMarkdown, so a remote image in them never loads. Only a test starts it open.
export function ReasoningStep({ defaultOpen, text }: { defaultOpen?: boolean; text: string }) {
  return (
    <Trace>
      <TraceCollapsible defaultOpen={defaultOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine className="text-xs">
            <TraceIcon>
              <RiBrainLine />
            </TraceIcon>
            <TraceTitle>Thought</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="text-xs [&_[data-slot=code-block]]:text-xs [&_[data-streamdown=inline-code]]:text-xs">
          <TranscriptMarkdown on="none">{text}</TranscriptMarkdown>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

const SUBAGENT_REFRESH_MS = 5000

// A subagent's mark: its parent session's model logo, by the rows' resolver, since a subagent runs on that model; a branch off the session when its model is unknown, and its place kept empty while the logo is read.
function SubagentIcon({ worker }: { worker: Pick<Worker, "localModel" | "model"> }) {
  const Logo = useMakerIcon(rowProvider(worker), initialsOf(rowModelName(worker)))
  if (!worker.model) return <RiGitBranchLine />
  return Logo ? <Logo aria-hidden /> : null
}

// A subagent's run as AI Elements' Task: the Agent call's row, opening to the subagent's own steps, read from its transcript while it is open (again every few seconds while it runs), then what it reported. Its steps are known once Claude Code names the subagent, which a run in the background does at once and one in the foreground when it reports.
function SubagentRun({ part, worker }: { part: DashboardToolPart; worker: Worker }) {
  const [open, setOpen] = useState(false)
  const agentId = outputOf(part)?.agentId ?? null
  const running = subagentRunning(part, worker.tasks)
  const steps = useQuery({
    enabled: open && agentId !== null,
    queryFn: async () => {
      const { data, error } = await fetchSubagentSteps(worker.sessionId, agentId ?? "")
      if (error) throw new Error(error.message)
      return toUIMessages(data)
    },
    queryKey: ["subagent-steps", worker.sessionId, agentId],
    refetchInterval: running ? SUBAGENT_REFRESH_MS : false,
  })
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <ToolLine icon={<SubagentIcon worker={worker} />} part={part} />
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2 text-xs">
          {agentId === null ? (
            <p>Its steps show here once it reports.</p>
          ) : steps.isPending ? (
            <Spinner />
          ) : steps.isError ? (
            <p>Its steps did not load: {steps.error.message}</p>
          ) : steps.data.length === 0 ? (
            <p>No steps yet.</p>
          ) : (
            steps.data.map((message) => (
              <div key={message.id} className="flex flex-col gap-2">
                <Parts message={message} variant="tinted" worker={worker} />
              </div>
            ))
          )}
          <ToolOutput part={part} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

// words and thinking take only text, so a row whose text stayed is left alone as its turn grows
const TextPart = memo(TranscriptBubble)
const ReasoningPart = memo(ReasoningStep)

// A message's parts in order: its words in bubbles, its thinking closed, each tool call closed to its row, a subagent's run as a Task.
function Parts({
  message,
  variant,
  worker,
}: {
  message: DashboardMessage
  variant: "muted" | "tinted"
  worker: Worker
}) {
  // each part marked with its step, which Reading's count watches (SeenSteps), and its words with where the glide rests (spansOf)
  return message.parts.map((part, i) => {
    const key = partKey(message, i)
    const drawn =
      part.type === "text" ? (
        <TextPart text={part.text} variant={variant} />
      ) : part.type === "reasoning" ? (
        <ReasoningPart text={part.text} />
      ) : part.type !== "dynamic-tool" ? null : SUBAGENT_TOOLS.has(
          (part as DashboardToolPart).toolName,
        ) ? (
        <SubagentRun part={part as DashboardToolPart} worker={worker} />
      ) : (
        <ToolStep part={part as DashboardToolPart} />
      )
    return drawn ? (
      <div key={key} data-rests={part.type === "text" || undefined} data-step={key}>
        {drawn}
      </div>
    ) : null
  })
}

// Another session's message, folded as a tool row read as a sent one is: Received, then from its sender (plain text, since the row is one button) and its first line, opening to its whole text, its files, its sender linked and Copy. Only a test starts it open.
export function PeerStep({
  chips,
  defaultOpen,
  from,
  text,
}: {
  chips: AttachmentChipItem[]
  defaultOpen?: boolean
  from: string | null
  text: string
}) {
  return (
    <Trace>
      <TraceCollapsible defaultOpen={defaultOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine className="text-xs">
            <TraceIcon>
              <RiInboxArchiveLine />
            </TraceIcon>
            <TraceTitle>
              <span className="text-foreground font-medium">Received</span>
              <Addressed by="from" rest={firstLineOf(text)} to={from} />
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {from ? (
            <p className="text-xs">
              From <AgentLink name={from} className="text-foreground" />
            </p>
          ) : null}
          <TranscriptBubble text={text} variant="tinted" />
          {chips.length ? <AttachmentChips className="max-w-full" items={chips} /> : null}
          {text.trim() ? (
            <MessageFooter className="text-2xs min-h-6">
              <CopyMessage text={text} />
            </MessageFooter>
          ) : null}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

const Step = memo(StepRow, sameStep)

// What the clock shows in a row: the day its time is read against (messageTime names the day off it), and whether the owner's newest message still offers Undo.
const clockOf = (props: Parameters<typeof StepRow>[0]): string =>
  `${props.now.toDateString()} ${
    undoState({
      marker: props.marker,
      newest: props.newest,
      now: props.now.getTime(),
      sent: props.sent,
      unsent: Boolean(props.message.metadata?.unsent),
      waiting: props.waiting,
    })?.kind ?? ""
  }`

// a row draws again only when what it reads moved, so a board frame, a keystroke or a clock tick that moves nothing it shows leaves the stream's rows alone
export function sameStep(a: Parameters<typeof StepRow>[0], b: Parameters<typeof StepRow>[0]) {
  return (
    a.composer === b.composer &&
    a.marker === b.marker &&
    a.message === b.message &&
    a.newest === b.newest &&
    clockOf(a) === clockOf(b) &&
    a.outbox === b.outbox &&
    a.sent === b.sent &&
    a.waiting === b.waiting &&
    a.worker.name === b.worker.name &&
    a.worker.sessionId === b.worker.sessionId &&
    a.worker.tasks === b.worker.tasks
  )
}

export function StepRow({
  composer,
  marker,
  message,
  newest,
  now,
  outbox,
  sent,
  waiting,
  worker,
}: {
  // The id of the session's box, which a pending bubble's buttons hand focus back to.
  composer: string
  // The Undo sent for this message, when there is one.
  marker: OutboxMessage | null
  message: DashboardMessage
  // Whether this is his newest message in the stream and this page's last send to the session, the one an Undo marker would take back.
  newest: boolean
  now: Date
  // Passed in rather than read from the dashboard's context, so a provider render that moved only the board leaves the row alone.
  outbox: Outbox
  // The message as this page sent it, when its outbox matched it: its files keep their names and sizes, which a transcript does not hold.
  sent: OutboxMessage | null
  // Whether another message to the session is still on its way, which an Undo marker would land after.
  waiting: boolean
  worker: Worker
}) {
  const at = message.metadata?.at ?? null
  const sockets = useAgentsBoard(socketsOf).data
  // the Undo marker's own typed state holds its Dismiss back the same way
  const markerHeld = useTypedHold(marker?.typedAt ?? null)
  if (message.role === "assistant") {
    // its name leads the turn's first words, or sits on its own line when the turn opens with a tool row, its thinking or an image
    const first = message.parts.find(
      (part) => part.type === "text" || part.type === "reasoning" || part.type === "dynamic-tool",
    )
    const words = textOf(message)
    return (
      <TranscriptMessage
        at={at}
        now={now}
        opensWithText={first?.type === "text" && !leadsWithImage(first.text)}
        text=""
        variant="muted"
        who={<AgentLink name={worker.name} sessionId={worker.sessionId} />}
      >
        <Parts message={message} variant="muted" worker={worker} />
        {words.trim() ? (
          <MessageFooter className="text-2xs min-h-6">
            <CopyMessage text={words} />
          </MessageFooter>
        ) : null}
      </TranscriptMessage>
    )
  }
  const peer = message.metadata?.kind === "peer"
  const from = message.metadata?.from ?? null
  // the page's own record keeps every file it sent, while a transcript read can name an image only once its source line is read too
  const chips = sent?.attachments.length
    ? chipsFromRefs(sent.attachments)
    : chipsFromEntry(attachmentsOf(message))
  const sender = from ? (sockets?.[from] ?? withoutRef(from)) : null
  const text = textOf(message)
  // Copy gives the words the bubble shows, so it never hands back the sender's name line the bubble hides
  const shown = peer && sender ? withoutSenderName(text, sender) : text
  if (peer) return <PeerStep chips={chips} from={from} text={shown} />
  const undo = undoState({
    marker,
    newest,
    now: now.getTime(),
    sent,
    unsent: Boolean(message.metadata?.unsent),
    waiting,
  })
  const delivered = deliveredAt({ at, sent })
  const focusComposer = () => document.getElementById(composer)?.focus()
  return (
    <TranscriptMessage
      at={at}
      bubbleClassName={undo?.kind === "unsent" ? "line-through opacity-70" : undefined}
      now={now}
      text={shown}
      variant="default"
      who="You"
    >
      {chips.length ? <AttachmentChips className="max-w-full" items={chips} /> : null}
      {undo?.kind === "unsent" ? (
        <MessageFooter className="text-2xs min-h-6">
          <CopyMessage text={shown} />
          <span role="status">Unsent</span>
        </MessageFooter>
      ) : delivered ? (
        <StatusFooter
          // a failure's reason stays visible beside Retry and Discard, so it wraps rather than being cut
          className={cn(
            "text-2xs min-h-6 gap-x-2",
            undo?.kind === "failed" && "text-destructive flex-wrap text-right",
          )}
          {...(undo?.kind === "unsending"
            ? { label: "Unsending…", mark: "sending" }
            : undo?.kind === "failed"
              ? { label: `Undo failed: ${undo.marker.reason ?? "not sent"}`, mark: "failed" }
              : { hover: fullTime(delivered), label: "Delivered", mark: "delivered" })}
          action={
            undo?.kind === "undo" ? (
              <FooterAction
                Icon={RiArrowGoBackLine}
                label="Undo your last message"
                onClick={() => outbox.send(worker.name, { attachments: [], text: UNSENT_MARKER })}
              />
            ) : undo?.kind === "unsending" && undo.marker.state === "queued" ? (
              <FooterAction
                Icon={RiCloseLine}
                label="Unsend Undo"
                onClick={() => {
                  if (outbox.cancel(undo.marker.id)) focusComposer()
                }}
              />
            ) : undo?.kind === "unsending" && undo.marker.state === "typed" && markerHeld ? (
              <FooterAction
                Icon={RiCloseLine}
                label="Dismiss Undo"
                onClick={() => {
                  outbox.dismiss(undo.marker.id)
                  focusComposer()
                }}
              />
            ) : null
          }
          copy={shown}
        >
          {undo?.kind === "failed" ? (
            <span aria-hidden="true">Undo failed: {undo.marker.reason ?? "not sent"}</span>
          ) : null}
          {undo?.kind === "failed" && undo.retry ? (
            <FooterAction
              Icon={RiRefreshLine}
              label="Retry Undo"
              onClick={() => {
                outbox.retry(undo.marker.id)
                focusComposer()
              }}
            />
          ) : null}
          {undo?.kind === "failed" ? (
            <FooterAction
              Icon={RiDeleteBinLine}
              label="Discard Undo"
              onClick={() => {
                outbox.discard(undo.marker.id)
                focusComposer()
              }}
            />
          ) : null}
        </StatusFooter>
      ) : text.trim() ? (
        <MessageFooter className="text-2xs min-h-6">
          <CopyMessage text={shown} />
        </MessageFooter>
      ) : null}
    </TranscriptMessage>
  )
}

// The content's own room under its last line, its pb-9 (langsdk's), which the room an anchor needs adds to; keep in step with pb-9 below and verify send-top's ROOM.
const ROOM_UNDER = 36

// Hold the room under the stream's last row (turnRoom while an anchor leads, never ending above the view's bottom edge: heldRoom), measured in the content's own pixels. viewTop is where the view goes back to after the change being held, when the browser has already moved it.
function holdRoom(content: HTMLDivElement, following: boolean, viewTop?: number) {
  const box = content.parentElement
  const rows = [...content.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.hasAttribute("data-message-scroller-spacer"),
  )
  const anchorRow = rows.findLast((row) => row.dataset.scrollAnchor === "true")
  const last = rows.at(-1)
  if (!box || !last) return
  const top = content.getBoundingClientRect().top
  const lastBottom = last.getBoundingClientRect().bottom - top + ROOM_UNDER
  const need =
    anchorRow && !following
      ? turnRoom({
          anchorTop: anchorRow.getBoundingClientRect().top - top,
          height: box.clientHeight,
          lastBottom,
          margin: STREAM_SCROLL.scrollMargin,
        })
      : 0
  const shift = viewTop === undefined ? 0 : viewTop - box.scrollTop
  const viewBottom = box.getBoundingClientRect().bottom - top + shift
  const held = following
    ? Math.max(0, (Number.parseFloat(content.style.paddingBottom) || ROOM_UNDER) - ROOM_UNDER)
    : undefined
  const room = heldRoom({ held, lastBottom, need, viewBottom })
  const padding = room > 0 ? `${ROOM_UNDER + room}px` : ""
  if (content.style.paddingBottom !== padding) content.style.paddingBottom = padding
}

// How far the stream's last row ends below the view's bottom, the room held under it aside.
function rowsPast(content: HTMLDivElement): number {
  const box = content.parentElement
  const last = [...content.children].findLast(
    (child) => child instanceof HTMLElement && !child.hasAttribute("data-message-scroller-spacer"),
  )
  if (!box || !last) return 0
  return Math.max(0, last.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom)
}

// What sits at the middle of the view and the row holding it, each with where it sat on the screen.
type SeenInView = { at: number; element: Element; row: Element; rowAt: number }

// Where an element sits on the screen, in pixels below the stream's top, null once it has left the page.
const screenTop = (box: Element, element: Element): number | null =>
  element.isConnected ? element.getBoundingClientRect().top - box.getBoundingClientRect().top : null

// What sits at the middle of the view, else the last row when the view shows only the room under it, with the row that holds it: the browser's scroll anchoring keeps it in place when entries are dropped above the view, while a cut at the end moves it down.
function seenInView(box: Element, content: Element): SeenInView | null {
  const { height, left, top, width } = box.getBoundingClientRect()
  const rows = [...content.children].filter(
    (child) => !child.hasAttribute("data-message-scroller-spacer"),
  )
  const middle = document.elementFromPoint(left + width / 2, top + height / 2)
  const row = rows.find((child) => middle && child.contains(middle)) ?? rows.at(-1)
  if (!row) return null
  const element = middle && row.contains(middle) ? middle : row
  return {
    at: element.getBoundingClientRect().top - top,
    element,
    row,
    rowAt: row.getBoundingClientRect().top - top,
  }
}

// A message sent from here before its transcript holds it, standing where it will land: it says where it is (sending, queued and why, sent, failed) and offers what can be done (pendingAction's unsend or dismiss, and retry, check it for me or edit once failed). A button that removes itself hands focus back to the composer.
function PendingMessage({
  composer,
  message,
  now,
  worker,
}: {
  // The id of the session's box, which Unsend, Dismiss or Retry hands focus back to once the button is gone.
  composer: string
  message: OutboxMessage
  now: Date
  worker: Worker
}) {
  const { dispatcher, outbox } = useDashboard()
  const label = chatLabel(worker, dispatcher)
  const failed = message.state === "failed"
  const limited = Boolean(worker.usageLimit)
  const busy = worker.light === "working"
  const status = statusLine(message, {
    busy,
    label,
    limited,
    next: isNext(outbox.messages, message),
  })
  const note = retryNote(message, limited)
  const files = message.attachments.length
  // A button's name quotes its message, or counts its files when it has no words.
  const short = oneLine(message.text, 40) || `${files} file${files === 1 ? "" : "s"}`
  const focusComposer = () => document.getElementById(composer)?.focus()
  const dismissHeld = useTypedHold(message.typedAt)
  // Check it for me sends its note once
  const [asked, setAsked] = useState(false)
  const action = pendingAction(message, { busy, held: dismissHeld })
  return (
    <TranscriptMessage
      at={message.at}
      bubbleClassName={failed ? undefined : "opacity-70"}
      now={now}
      text={message.text}
      variant="default"
      who="You"
    >
      {message.attachments.length ? (
        <AttachmentChips
          className={cn("max-w-full", !failed && "opacity-70")}
          items={chipsFromRefs(message.attachments)}
        />
      ) : null}
      <StatusFooter
        // min-h-6: a footer holding a button (Unsend, Dismiss) is as tall as one without, so his row keeps its height from Queued to Delivered and the view never dips at delivery
        // a failure's reason stays visible beside Retry and Edit, so it wraps rather than being cut
        className={cn(
          "text-2xs min-h-6 gap-x-2 text-right",
          failed && "text-destructive flex-wrap",
        )}
        label={status}
        mark={statusMark(message)}
        action={
          action === "unsend" ? (
            <FooterAction
              Icon={RiCloseLine}
              label={`Unsend "${short}"`}
              onClick={() => {
                if (outbox.cancel(message.id)) focusComposer()
              }}
            />
          ) : action === "dismiss" ? (
            <FooterAction
              Icon={RiCloseLine}
              label={`Dismiss "${short}"`}
              onClick={() => {
                outbox.dismiss(message.id)
                focusComposer()
              }}
            />
          ) : null
        }
        copy={message.text}
      >
        {failed ? <span aria-hidden="true">{status}</span> : null}
        {note ? <span aria-hidden="true">{note}</span> : null}
        {failed && canRetry(message.code) ? (
          <FooterAction
            Icon={RiRefreshLine}
            label={`Retry "${short}"`}
            onClick={() => {
              outbox.retry(message.id)
              focusComposer()
            }}
          />
        ) : null}
        {failed && dispatcher && canCheck(message.code) && !asked ? (
          <FooterAction
            Icon={RiQuestionLine}
            label={`Check it for me: ask the dispatcher whether "${short}" arrived`}
            onClick={() => {
              setAsked(true)
              outbox.send(dispatcher, { attachments: [], text: checkNote(label, short) })
              focusComposer()
            }}
          />
        ) : null}
        {failed && !config.hosted ? (
          <FooterAction
            Icon={RiEditLine}
            label={`Edit "${short}"`}
            onClick={() => outbox.edit(message.id)}
          />
        ) : null}
        {failed ? (
          <FooterAction
            Icon={RiDeleteBinLine}
            label={`Discard "${short}"`}
            onClick={() => {
              outbox.discard(message.id)
              focusComposer()
            }}
          />
        ) : null}
      </StatusFooter>
    </TranscriptMessage>
  )
}

// Scrolls the stream to the card a sidebar row asked for, through the scroller's own API, and stops to read there (onHit), so the glide never carries the card away. Waits for the steps, for the same reason.
function TargetNeed({ onHit, ready }: { onHit: () => void; ready: boolean }) {
  const { scrollToMessage } = useMessageScroller()
  useNeedsYouTarget(ready, (anchor) => {
    const hit = scrollToMessage(anchor, { align: "center" })
    // the steps that just landed lay out after this runs; asking again once they have holds it
    if (hit) {
      onHit()
      requestAnimationFrame(() => {
        scrollToMessage(anchor, { align: "center" })
        requestAnimationFrame(() => scrollToMessage(anchor, { align: "center" }))
      })
    }
    return hit
  })
  return null
}

const OLDER_LABELS: Record<Older["state"], string> = {
  done: "The start of the session",
  error: "Older steps did not load: try again",
  idle: "Load older",
  loading: "Load older",
  missing: "Older steps are not in the database yet: try again",
}

// Above the recent steps, outside the scroller's content so the steps it prepends keep the reader's place: a way back through the session's older ones, read from the database a page at a time, on the Checkpoint that marks the edge of what is loaded. It stays one button whatever its state, focusable even while disabled (as a page loads, or once the start is shown), so keyboard focus is never dropped. Its row is there from the first paint, invisible until there are steps, so their arrival pushes nothing down.
export function OlderSteps({ older, shown }: { older: Older; shown: boolean }) {
  const idle = older.state !== "loading" && older.state !== "done"
  return (
    <div className={cn("pt-1 pb-4", !shown && "invisible")}>
      <Checkpoint icon={RiHistoryLine}>
        <Button
          variant="ghost"
          size="xs"
          disabled={!idle}
          focusableWhenDisabled
          className="data-disabled:opacity-50"
          onClick={older.load}
        >
          {older.state === "loading" ? <Spinner /> : null}
          {OLDER_LABELS[older.state]}
        </Button>
      </Checkpoint>
    </div>
  )
}

// Reading's count: the steps that landed since it went to Reading that it has reported below the view and never had any of their height at or above the view's bottom, read from an IntersectionObserver on each marked step ([data-step]), never from a layout read. Mounted only while Reading.
function SeenSteps({
  boxOf,
  onSeen,
  units,
}: {
  boxOf: () => HTMLElement | null
  onSeen: (entries: { height: number; key: string | undefined }[]) => void
  units: string
}) {
  const [observer, setObserver] = useState<IntersectionObserver | null>(null)
  useEffect(() => {
    const box = boxOf()
    if (!box) return
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (!entry.target.isConnected) seen.unobserve(entry.target)
        onSeen(
          entries.map((entry) => ({
            height: entry.intersectionRect.height,
            key: entry.target instanceof HTMLElement ? entry.target.dataset.step : undefined,
          })),
        )
      },
      { ...SEEN_OBSERVER, root: box },
    )
    setObserver(seen)
    return () => seen.disconnect()
  }, [boxOf, onSeen])
  // a step that lands is watched once it is on the page; watching one already watched does nothing
  useEffect(() => {
    if (!observer) return
    for (const step of boxOf()?.querySelectorAll("[data-step]") ?? []) observer.observe(step)
  }, [boxOf, observer, units])
  return null
}

// The chat's Checkpoint bar with what it does: the scroller's own end for Scroll to end and the switch to Watching, so a send's spacer and anchor go with it.
function ChatBar({
  mode,
  onToEnd,
  onWatch,
  ...bar
}: Omit<Parameters<typeof ScrollBar>[0], "onToEnd" | "onToggle"> & {
  onToEnd: (scrollToEnd: (smooth: boolean) => void) => void
  onWatch: (watch: boolean, scrollToEnd: (smooth: boolean) => void) => void
}) {
  const { scrollToEnd } = useMessageScroller()
  const toEnd = useCallback(
    (smooth: boolean) => {
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
      scrollToEnd({ behavior: smooth && !reduced ? "smooth" : "instant" })
    },
    [scrollToEnd],
  )
  return (
    <ScrollBar
      {...bar}
      mode={mode}
      onToEnd={() => onToEnd(toEnd)}
      onToggle={() => onWatch(mode !== "watching", toEnd)}
    />
  )
}

// What the glide reads of a row: its words (a closed tool row, thinking, subagent run or peer's message as ROW_WORDS) and whether it rests at its top, a person's message or a card; a turn rests at each of its words instead ([data-rests]).
const factsOf = (message: DashboardMessage): RowFacts => {
  if (message.metadata?.kind === "peer") return { rests: false, words: ROW_WORDS }
  if (message.role !== "assistant") return { rests: true, words: wordsIn(textOf(message)) }
  let words = 0
  for (const part of message.parts) {
    if (part.type === "text") words += wordsIn(part.text)
    else if (part.type === "reasoning" || part.type === "dynamic-tool") words += ROW_WORDS
  }
  return { rests: false, words }
}

// A session the dashboard reads no stream for yet: nothing loading, nothing older, no problem.
const NO_STREAM: Omit<DashboardStream, "activity"> = {
  loading: false,
  older: { load: () => {}, state: "idle" },
  problem: null,
}

// A worker's steps as they happen, read from its chat (useChat): what a person or a peer asked it, then each turn of its own (its thinking, its words, each tool call and a subagent's run), with what waits on the owner slotted in where it was asked: its asks, and its Feed prompts under the latest step. Messages sent from here follow them as pending bubbles until its transcript holds them, and those it holds say when they arrived. Under it, the chat's Checkpoint bar holds its mode: Watching glides down through new rows at reading speed, Reading moves only by his hand.
export function WorkerStream({
  needs,
  now,
  worker,
}: {
  needs: StreamNeed[]
  now: Date
  worker: Worker
}) {
  const { chats, dispatcher, outbox, streams } = useDashboard()
  const {
    loading,
    older: entriesOlder,
    problem: streamProblem,
  } = streams.get(worker.sessionId) ?? NO_STREAM
  // a dispatcher by its label, as its heading and box name it (chatLabel)
  const label = chatLabel(worker, dispatcher)
  const composer = composerId(worker, dispatcher)
  const { messages } = useChat({ chat: chats.chat(worker.name) })
  // Undo's markers stand as no row of their own: each shows in the footer of the message it takes back
  const all = outboxOf(messages)
  const records = all.filter((m) => !isUnsentMarker(m.text))
  const steps = messages.filter((m) => !m.metadata?.outbox)
  const newestMine = steps.findLast((m) => m.metadata?.kind === "human")?.id ?? null
  const waiting = othersWaiting(records)
  const items = streamItems(
    steps.map((message) => ({ at: message.metadata?.at ?? "", message })),
    needs,
  )
  const pending = records.filter((m) => !landed(m))
  const sent = new Map(records.flatMap((m) => (m.entryId ? [[m.entryId, m] as const] : [])))
  // this view is keyed by its session, so this is when its session opened here
  const [openedAt] = useState(() => new Date().toISOString())
  const keyOf = (message: DashboardMessage) => rowKey(message.id, sent.get(message.id) ?? null)
  const rows = [
    ...items.map((item) =>
      item.kind === "need"
        ? {
            facts: { rests: true, words: ROW_WORDS },
            id: needsYouAnchor(item.need.item.id),
            key: needsYouAnchor(item.need.item.id),
            mine: false,
            units: [needsYouAnchor(item.need.item.id)],
          }
        : {
            facts: factsOf(item.entry.message),
            id: item.entry.message.id,
            key: keyOf(item.entry.message),
            mine: item.entry.message.metadata?.kind === "human",
            units: countKeys(keyOf(item.entry.message), item.entry.message),
          },
    ),
    ...pending.map((message) => ({
      facts: { rests: true, words: wordsIn(message.text) },
      id: message.id,
      key: message.id,
      mine: true,
      units: [message.id],
    })),
  ]
  const facts = useRef<ReadonlyMap<string, RowFacts>>(new Map())
  facts.current = new Map(rows.map((row) => [row.id, row.facts]))

  // the chat's mode and learned pace, kept in this browser per session
  const prefs = useChatPrefs(worker.name)
  const mode = prefs.mode
  // the newest send this view made, and whether it was made while Reading, which takes the top with it
  const sentKey = sendAnchor(records, openedAt)
  const [sentIn, setSentIn] = useState<SentIn | null>(null)
  if (sentKey && sentIn?.id !== sentKey) setSentIn({ id: sentKey, leads: mode === "reading" })
  const anchored = sendLeads(sentKey, sentIn)
  // the steps there when it went to Reading, and where the observer has put each since (below the view, or seen), for the count
  const units = rows.flatMap((row) => row.units)
  const [readFrom, setReadFrom] = useState<ReadonlySet<string> | null>(null)
  const [marks, setMarks] = useState<ReadonlyMap<string, StepMark>>(new Map())
  if (mode === "reading" && readFrom === null && units.length > 0) setReadFrom(new Set(units))
  if (mode === "watching" && readFrom !== null) {
    setReadFrom(null)
    setMarks(new Map())
  }
  const count = readFrom ? newCount(units, readFrom, marks) : 0
  const onSeen = useCallback((entries: { height: number; key: string | undefined }[]) => {
    setMarks((was) => markSteps(was, entries))
  }, [])

  const modeRef = useRef<ChatMode>(mode)
  modeRef.current = mode
  // what he did to the mode, written to this browser; any switch ends a Reading send's hold on the top
  const act = useCallback(
    (what: ModeAct) => {
      const before = modeRef.current
      const next = modeAfter(before, what)
      if (dropsLead(what, before, next))
        setSentIn((was) => (was?.leads ? { ...was, leads: false } : was))
      if (next === before) return
      modeRef.current = next
      saveChatPrefs(worker.name, { mode: next })
    },
    [worker.name],
  )

  const contentRef = useRef<HTMLDivElement>(null)
  const boxOf = useCallback(() => contentRef.current?.parentElement ?? null, [])
  const contentOf = useCallback(() => contentRef.current, [])
  const factsNow = useCallback(() => facts.current, [])
  // where the glide last put the view, until that write's scroll event lands (onScroll clears it)
  const glideTop = useRef<number | null>(null)
  const glideWrote = useCallback((top: number) => {
    glideTop.current = top
  }, [])
  const glide = useGlide({
    box: boxOf,
    content: contentOf,
    facts: factsNow,
    on: mode === "watching",
    onWrite: glideWrote,
    pace: paceNow(prefs.pace, Date.now()),
  })
  const stopGlide = glide.stop

  // which way the view last scrolled: an end it arrives at scrolling down (his wheel, a drag of the scrollbar, a key) is his; the room's cut moves nothing, so an end it brings him after his scroll up is not
  const lastScroll = useRef(0)
  // when his last scroll down while Watching came, so the pace rises once a scroll (startsScrollDown)
  const lastDownAt = useRef<number | null>(null)
  // when his wheel, touch, key or a press on the scrollbar last moved the view, so a scroll just after it is his (handUp, handDown)
  const handAt = useRef(Number.NEGATIVE_INFINITY)
  // and which way it pointed (HandWay): a scroll inside HAND_MS counts as his only in that way
  const handWay = useRef<HandWay>("either")
  const moved = (way: HandWay) => {
    handAt.current = performance.now()
    handWay.current = way
  }
  // a press held on the scrollbar: every scroll while it is held is his, however long the drag runs
  const dragging = useRef(false)
  // the scroller lets go of a send's anchor only on a wheel, touch or key, and takes it again when the sent row's id changes on delivery, so his scroll up or drag tells it with a wheel of no distance, which our own wheel handler skips
  const letting = useRef(false)
  const letGo = (box: HTMLElement) => {
    letting.current = true
    box.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
    letting.current = false
  }
  useEffect(() => {
    const up = () => {
      dragging.current = false
    }
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [])
  // where the view sits: whether ↑ and ↓ have somewhere to go, and, while Reading, whether rows have stayed past its bottom with the view still (pastSince), read on a scroll and when the rows change size, never per render; a timer reads them again once the hold is up
  const [toLatest, setToLatest] = useState(false)
  const [ends, setEnds] = useState({ mine: false, next: false, prev: false })
  const measureFrame = useRef(0)
  const scrolled = useRef(false)
  const pastAt = useRef<number | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const measureAgain = useRef(() => {})
  const measure = useCallback(() => {
    if (measureFrame.current) return
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0
      const box = boxOf()
      const content = contentRef.current
      if (!box || !content) return
      const end = endOf(box)
      const now = performance.now()
      pastAt.current = pastSince({
        moved: scrolled.current,
        now,
        past: rowsPast(content),
        since: pastAt.current,
      })
      scrolled.current = false
      clearTimeout(holdTimer.current)
      const shows = showsToLatest(pastAt.current, now)
      setToLatest(shows)
      if (pastAt.current !== null && !shows) {
        holdTimer.current = setTimeout(
          () => measureAgain.current(),
          pastAt.current + TO_LATEST_HOLD_MS - now,
        )
      }
      const mine = content.querySelectorAll<HTMLElement>("[data-mine=true]")
      const base = box.scrollTop - box.getBoundingClientRect().top
      const topOf = (row: HTMLElement | undefined) =>
        row ? row.getBoundingClientRect().top + base : null
      const next = jumpEnds({
        atEnd: end,
        first: topOf(mine[0]),
        last: topOf(mine[mine.length - 1]),
        margin: STREAM_SCROLL.scrollMargin,
        viewTop: box.scrollTop,
      })
      setEnds((was) =>
        was.mine === next.mine && was.next === next.next && was.prev === next.prev ? was : next,
      )
    })
  }, [boxOf])
  measureAgain.current = measure
  useEffect(
    () => () => {
      cancelAnimationFrame(measureFrame.current)
      clearTimeout(holdTimer.current)
    },
    [],
  )

  // his previous or next message, read once on the press: a click glides there, a key jumps (a key can repeat); a jump up stops to read
  const jump = useCallback(
    (dir: "down" | "up", smooth: boolean) => {
      const box = boxOf()
      const content = contentRef.current
      if (!box || !content) return
      const base = box.scrollTop - box.getBoundingClientRect().top
      const tops = [...content.querySelectorAll<HTMLElement>("[data-mine=true]")].map(
        (row) => row.getBoundingClientRect().top + base,
      )
      const margin = STREAM_SCROLL.scrollMargin
      const i = jumpTarget(tops, box.scrollTop, margin, dir)
      if (i === null) return
      if (dir === "up") {
        stopGlide()
        act("jump-up")
        // his hand, so its glide up is never taken for the browser pulling the view up (hold)
        handAt.current = performance.now()
        handWay.current = "up"
      } else if (mode === "watching") {
        // the glide waits while the click's own glide down runs, as it does for his scroll down
        glide.yieldTo()
      }
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
      box.scrollTo({
        behavior: smooth && !reduced ? "smooth" : "instant",
        top: Math.min(box.scrollHeight - box.clientHeight, Math.max(0, tops[i]! - margin)),
      })
    },
    [act, boxOf, glide.yieldTo, mode, stopGlide],
  )
  // Alt+↑ and Alt+↓ on the chat in view, unless focus sits in a text field, where they move the caret
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dir = jumpKey({
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        key: event.key,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        shown: chatShown(boxOf()),
        target: event.target instanceof HTMLElement ? event.target : null,
      })
      if (!dir) return
      event.preventDefault()
      jump(dir, false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [boxOf, jump])

  // a send while Watching jumps to live, so his message lands at the bottom and the view stays there
  const snapped = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!sentKey || snapped.current === sentKey) return
    snapped.current = sentKey
    const box = boxOf()
    if (modeRef.current !== "watching" || !box) return
    box.scrollTo({ behavior: "instant", top: box.scrollHeight })
    glide.toLive(false)
  })

  // the status line rides inside the newest row, where langsdk shows its "Answering...", and only while it says something, so an idle chat ends with langsdk's 36px; a child after the rows would hide each new row's anchor from the scroller, which looks for anchors among the rows added at the end
  const newest = rows.at(-1)?.key ?? null
  // whether the session is at work, as the board's light says: its status line shows
  const running = worker.light === "working" || worker.light === "needs-you"
  const status = running ? (
    <div className="mt-4">
      <ActivityLine step={stepOf(steps)} worker={worker} />
    </div>
  ) : null
  // while a Reading send leads, the content's bottom padding keeps the room it needs under the last row (turnRoom), so the scroller's own spacer, which it sizes only until his wheel lets go, stays at zero; the room shrinks as the rows grow
  const following = !anchored
  // where the view sat, what sat in view and where on the screen, kept on a scroll and after each change in size, so a scroll position lowered by the browser's scroll anchoring (rows dropped above the view) is not taken for a pull
  const viewTop = useRef(0)
  const inView = useRef<SeenInView | null>(null)
  // when the chat's first rows showed, and his newest send, for following the end as it opens (opensAtEnd)
  const firstRowsAt = useRef<number | null>(null)
  const sentRef = useRef(sentKey)
  sentRef.current = sentKey
  const followingRef = useRef(following)
  followingRef.current = following
  // the view held through a change in size: a pull the browser made put back (pulledUp), the room under the rows held, and where the view sits kept for the next change; the ResizeObserver runs it before paint, and so does each render while a Reading send leads, since a row React shrinks there is cut before any observer runs
  const holdView = useRef((content: HTMLDivElement, box: HTMLElement) => {
    // a glide write whose scroll event has not landed moved the view and what sat in it by ahead
    const ahead = glideTop.current === null ? 0 : glideTop.current - viewTop.current
    const before = viewTop.current + ahead
    const seenRow = inView.current
    const rowShift = seenRow
      ? viewShift(
          { at: seenRow.at - ahead, row: seenRow.rowAt - ahead },
          { at: screenTop(box, seenRow.element), row: screenTop(box, seenRow.row) },
        )
      : null
    const handMoves = performance.now() - handAt.current <= HAND_MS
    // Watching too: a pull at the end would show as the view jumping up a row's worth before the glide comes back; the room it holds is never more than the shrink, and the next rows fill it; and never while his hand moves the view short of the end (a jump up glides past where the view was last seen), while a cut to the end is put back even then
    if (
      (!followingRef.current || modeRef.current === "watching") &&
      (endOf(box) || !handMoves) &&
      rowShift !== null &&
      pulledUp(box, before, rowShift)
    ) {
      const back = box.scrollTop + rowShift
      holdRoom(content, false, back)
      box.scrollTo({ behavior: "instant", top: back })
      viewTop.current = box.scrollTop
    } else {
      holdRoom(content, followingRef.current)
      // his own scroll is left for its scroll event to read, which would otherwise see the view already there and miss his scroll up
      if (!handShift(handMoves, box.scrollTop - before, rowShift)) viewTop.current = box.scrollTop
    }
    glideTop.current = null
    inView.current = readsView(modeRef.current, box) ? seenInView(box, content) : null
  })
  // a row that shrinks at the stream's end (the status line leaving a row as a session's light flickers between turns) would pull the browser's scroll position up, a dip that comes back a frame later; the ResizeObserver runs before paint, so in Reading the room is held from where the view sat and the view put back there; Watching glides from wherever the view is, and at the end is put back as Reading is
  useEffect(() => {
    const content = contentRef.current
    const box = content?.parentElement
    if (!content || !box) return
    const hold = () => {
      holdView.current(content, box)
      const now = performance.now()
      if (firstRowsAt.current === null && content.querySelector("[data-message-id]"))
        firstRowsAt.current = now
      if (
        opensAtEnd({
          handAt: handAt.current,
          now,
          openedAt: firstRowsAt.current,
          sent: sentRef.current !== null,
        })
      ) {
        box.scrollTo({ behavior: "instant", top: box.scrollHeight })
        viewTop.current = box.scrollTop
        inView.current = readsView(modeRef.current, box) ? seenInView(box, content) : null
      }
      measure()
    }
    const resized = new ResizeObserver(hold)
    for (const child of content.children) resized.observe(child)
    resized.observe(content)
    resized.observe(box)
    const added = new MutationObserver(() => {
      for (const child of content.children) resized.observe(child)
      hold()
    })
    added.observe(content, { childList: true })
    return () => {
      resized.disconnect()
      added.disconnect()
    }
  }, [measure])
  // while a Reading send leads, its room is held before the scroller's own reaction to the rows that just landed, which would read the room as filled and keep it; no other render reads the layout
  useLayoutEffect(() => {
    const content = contentRef.current
    const box = content?.parentElement
    if (anchored && content && box) holdView.current(content, box)
  })
  const lost = lostPrompt(worker, dispatcher)
  return (
    <>
      {worker.loginExpired ? (
        <LoginExpired label={chatLabel(worker, dispatcher)} worker={worker} />
      ) : lost ? (
        <Alert variant={lost.onYou ? "destructive" : "default"} className="mt-3 mb-4">
          <AlertTitle>{lost.title}</AlertTitle>
          <AlertDescription>{lost.text}</AlertDescription>
        </Alert>
      ) : null}
      <MessageScrollerProvider defaultScrollPosition="end" {...STREAM_SCROLL}>
        {/* loading reads false for a moment when the session changes, before its fetch starts, so steps on the page are the sign they have loaded */}
        {/* keyed by session, so a target remembered in one session is not carried into the next */}
        <TargetNeed
          key={worker.sessionId}
          ready={!loading && steps.length > 0}
          onHit={() => act("jump-up")}
        />
        {mode === "reading" ? (
          <SeenSteps boxOf={boxOf} onSeen={onSeen} units={units.join("\n")} />
        ) : null}
        {/* -mx-1 with px-1 inside: the steps stay on the page gutter while their focus rings get room the scroll box would clip */}
        <MessageScroller className="-mx-1 min-h-0 w-auto flex-1">
          <MessageScrollerViewport
            aria-label={`${label}'s steps`}
            className={cn(
              // stock scroll anchoring: rows the stream drops above the view (it keeps its newest entries) leave what he reads, and a leading row, in place
              "focus-visible:ring-ring/50 flex flex-col px-1 outline-none focus-visible:ring-3 focus-visible:ring-inset",
              anchored && "scroll-smooth",
            )}
            onKeyDown={(event) => {
              // Alt+↑ and Alt+↓ are the jump's own keys, never his scroll
              if (event.altKey) return
              // the browser scrolls after the key's own default, and smoothly, so the view is read again on the frames after it
              const box = event.currentTarget
              const way = keyWay(event.key, event.shiftKey)
              watchKeyScroll(
                event.key,
                () => box.scrollTop,
                () => moved(way),
              )
            }}
            // a press on the viewport itself is on its scrollbar, as a drag of it starts; a press on a row is not a move. The scroller reads only a wheel, touch or key as his intent, so a drag would leave its anchor on his send, put back on every resize: a wheel of no distance tells it the view is his
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return
              dragging.current = true
              moved("either")
              letGo(event.currentTarget)
            }}
            onTouchMove={() => moved("either")}
            onWheel={(event) => {
              if (letting.current) return
              moved(dragging.current ? "either" : wheelWay(event.deltaY))
              if (
                !dragging.current &&
                !event.ctrlKey &&
                wheelsToEnd(event.currentTarget, mode, event.deltaY) &&
                !scrollsInside(event.target as Element, event.currentTarget, event.deltaY)
              )
                act("end")
            }}
            onScroll={(event) => {
              const box = event.currentTarget
              const top = box.scrollTop
              const delta = top - viewTop.current
              // a scroll that moves nothing (the view put back where it sat) keeps the direction he last scrolled
              if (Math.abs(delta) > 0.5) lastScroll.current = delta
              if (dragging.current) {
                moved("either")
                letGo(box)
              }
              const now = performance.now()
              const own = glide.ownScroll(top)
              // the glide's own write is never his hand carried on
              if (!own && carriesHand(delta, now - handAt.current, handWay.current))
                handAt.current = now
              const sinceHand = now - handAt.current
              const end = endOf(box)
              if (!own) {
                if (handUp(delta, sinceHand, end, handWay.current)) {
                  stopGlide()
                  letGo(box)
                  act("up")
                } else if (
                  mode === "reading" &&
                  sinceHand <= HAND_MS &&
                  end &&
                  ownEnd(delta, handWay.current)
                ) {
                  act("end")
                } else if (mode === "watching" && handDown(delta, sinceHand, handWay.current)) {
                  // his scroll down while behind reads faster: the glide learns, once a scroll, and yields to him
                  if (glide.behindNow && startsScrollDown(lastDownAt.current, now)) {
                    saveChatPrefs(worker.name, {
                      pace: paceAfterScrollDown(
                        prefsOf(readChatPrefs(), worker.name).pace,
                        Date.now(),
                      ),
                    })
                  }
                  lastDownAt.current = now
                  glide.yieldTo()
                }
              }
              viewTop.current = top
              glideTop.current = null
              scrolled.current = true
              if (contentRef.current) {
                inView.current = readsView(mode, box) ? seenInView(box, contentRef.current) : null
              }
              measure()
            }}
          >
            <OlderSteps older={entriesOlder} shown={steps.length > 0} />
            <MessageScrollerContent
              ref={contentRef}
              // pb-9 (ROOM_UNDER): langsdk's room under the last line, on the content; while a Reading send leads, the inline padding the room effect sets takes its place and the scroller's spacer stays at 0, so a short reply cannot scroll past where it rests
              className="relative min-h-0 shrink-0 grow gap-4 pb-9"
              aria-busy={entriesOlder.state === "loading"}
            >
              {loading && steps.length === 0 && pending.length === 0 ? (
                // in the middle of the pane, never at the top to jump down once the rows load, centred on both axes
                <CenterSpinner />
              ) : items.length === 0 && pending.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <RiChat3Line />
                    </EmptyMedia>
                    <EmptyTitle>
                      {streamProblem ? "Steps cannot be read" : "No steps yet"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {streamProblem
                        ? streamProblem.message
                        : `Messages and tool calls appear here as ${label} works.`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                // one keyed list, so a delivered entry keyed by rowKey takes over its pending bubble's element and stays the scroller's anchor
                [
                  ...items.map((item) => {
                    if (item.kind === "need") {
                      return (
                        <MessageScrollerItem
                          key={needsYouAnchor(item.need.item.id)}
                          className={STREAM_ROW}
                          data-step={needsYouAnchor(item.need.item.id)}
                          messageId={needsYouAnchor(item.need.item.id)}
                        >
                          <NeedsYouCard
                            item={item.need.item}
                            now={now}
                            onAnswer={config.hosted ? null : item.need.onAnswer}
                            resolution={item.need.resolution}
                          />
                          {needsYouAnchor(item.need.item.id) === newest ? status : null}
                        </MessageScrollerItem>
                      )
                    }
                    const { message } = item.entry
                    const record = sent.get(message.id) ?? null
                    const key = keyOf(message)
                    return (
                      <MessageScrollerItem
                        key={key}
                        className={STREAM_ROW}
                        data-mine={message.metadata?.kind === "human"}
                        data-step={message.metadata?.kind === "assistant" ? undefined : key}
                        messageId={message.id}
                        scrollAnchor={anchored && key === sentKey}
                      >
                        <Step
                          composer={composer}
                          marker={record?.deliveredAt ? undoOf(all, record) : null}
                          message={message}
                          newest={
                            message.id === newestMine &&
                            Boolean(record) &&
                            (record?.at ?? "") >= (chats.lastPosted(worker.name) ?? "")
                          }
                          now={now}
                          outbox={outbox}
                          sent={record}
                          waiting={waiting}
                          worker={worker}
                        />
                        {key === newest ? status : null}
                      </MessageScrollerItem>
                    )
                  }),
                  ...pending.map((message) => (
                    <MessageScrollerItem
                      key={message.id}
                      className={STREAM_ROW}
                      data-mine
                      data-step={message.id}
                      messageId={message.id}
                      scrollAnchor={anchored && message.id === sentKey}
                    >
                      <PendingMessage
                        composer={composer}
                        message={message}
                        now={now}
                        worker={worker}
                      />
                      {message.id === newest ? status : null}
                    </MessageScrollerItem>
                  )),
                ]
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
        <ChatBar
          behindText={mode === "watching" ? glide.label.text : null}
          count={count}
          label={label}
          mode={mode}
          next={ends.next}
          oldest={ends.mine && !ends.prev && entriesOlder.state !== "done"}
          picker={worker.light === "needs-you"}
          prev={ends.prev}
          queued={queuedFor(outbox.messages, worker.name).length}
          toEnd={mode === "reading" ? toLatest : glide.behindNow}
          onJump={(dir) => jump(dir, true)}
          onToEnd={(toEnd) => {
            // a one-off look at the newest: Reading stays Reading, and Watching goes live
            toEnd(true)
            if (mode === "watching") glide.toLive(true)
          }}
          onWatch={(watch, toEnd) => {
            act("click")
            if (watch) {
              toEnd(true)
              glide.toLive(true)
            }
          }}
        />
      </MessageScrollerProvider>
    </>
  )
}
