"use client"

import type { Agent, OpsRow, SystemReport, Worker } from "@api/hono"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  THREADS_PER_PAGE,
  type Thread,
  type ThreadPatch,
  type ThreadsPage,
} from "@packages/config/threads"
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCalendarFill,
  RiCalendarLine,
  RiChatThreadLine,
  RiCpuFill,
  RiCpuLine,
  RiGithubFill,
  RiHardDrive3Fill,
  RiHardDrive3Line,
  RiLoader4Line,
  RiMoreLine,
  RiPlayFill,
  RiRamFill,
  RiRamLine,
  RiShutDownLine,
  RiSwapFill,
  RiSwapLine,
  RiTerminalBoxLine,
  RiTimerFill,
  RiTimerLine,
} from "@remixicon/react"
import { useForm } from "@tanstack/react-form"
import { useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { countLabel } from "@/components/dashboard/count-badge"
import { useDashboard } from "@/components/dashboard/dashboard"
import { TemplatePicker } from "@/components/dashboard/template-picker"
import { StatusIcon } from "@/components/dashboard/worker-light"
import { Hint, OFF_FOCUSABLE } from "@/components/hint"
import { GroupCount } from "@/components/shell/group-count"
import { MovableGroups, MovableGroupLabel } from "@/components/shell/movable-group"
import { ROW_BOX } from "@/components/shell/row-box"
import type { MenuUpdate } from "@/components/shell/sidebar-user-menu"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { toast } from "@/components/ui/toast"
import { YardGroup } from "@/components/yard/yard-groups"
import { agentLabel, chatLabel, kindWord, labelOf } from "@/lib/agent-label"
import {
  checksOpen,
  doingOf,
  type FirstLine,
  firstLine,
  firstLineOf,
  type InboxWait,
  labelLeads,
  rowLabel,
  rowLines,
  rowText,
  runnerNote,
  statusParts,
} from "@/lib/agents"
import { config } from "@/lib/config"
import {
  checkerOf,
  dispatcherOf,
  dispatchersOf,
  GROUP_OF,
  heldCount,
  type GroupLabel,
  keepsOther,
  LIGHT_HOLD_MS,
  LIGHT_LABELS,
  liveState,
  longIdle,
  nestCheckers,
  nestState,
  type Nested,
  otherRows,
  sessionGroups,
  sinName,
  STUCK,
  TASK_LABELS,
  useNow,
  type LiveState,
  type SessionTask,
} from "@/lib/dashboard"
import { useDrafted } from "@/lib/drafts"
import { inboxWaitOf, inboxWaiting, useInbox } from "@/lib/inbox"
import { useMakerIcon } from "@/lib/model-icons"
import {
  dispatcherLabel,
  initialsOf,
  isGlmModel,
  levelName,
  modelName,
  type Provider,
  rowEffort,
  rowModelName,
  rowProvider,
  showsEffort,
} from "@/lib/model-label"
import { needsYouAnchor, sessionWaiting, targetNeedsYou } from "@/lib/needs-you"
import {
  isBroken,
  opsLine,
  opsParts,
  scriptCount,
  scriptsRail,
  scriptsShown,
  useOps,
  whenWords,
} from "@/lib/ops"
import { MODE_LABELS } from "@/lib/permission-mode"
import { MENU_HINT, openMenuByKey } from "@/lib/row-menu"
import {
  moveGroup,
  type NavGroup,
  ORDERED_GROUPS,
  type OrderedGroup,
  useGroupOpen,
  useGroupOrder,
} from "@/lib/sidebar-groups"
import { effortIcon, LOCAL_EFFORT_ICON, PR_TONES, prTone } from "@/lib/status-icons"
import {
  glanceReadings,
  isStale,
  spokenReadings,
  systemHealth,
  systemReadings,
  updateHover,
  updateMessage,
  useSystem,
  zaiReadings,
  type Health,
  type Reading,
  type ReadingKey,
  type UsageRow,
} from "@/lib/system"
import {
  holdsForFirstTry,
  isPlainClick,
  pageAfterEmpty,
  patchThread,
  renamePatch,
  renameSchema,
  runAction,
  threadActions,
  threadHref,
  threadPager,
  THREADS_QUERY_KEY,
  useThreads,
} from "@/lib/threads"
import { yardGroups } from "@/lib/yard"
import { holdsForYard, useYardChannels, useYardLate } from "@/lib/yard-api"

const HEALTH_LABELS: Record<Health, string> = {
  amber: "Worth a look",
  green: "Healthy",
  red: "Needs action",
}

// The live feed's state in words, for the header icons' hover and screen readers, and /dashboard's empty state; lost adds the read's reason.
export const FEED_LABELS: Record<LiveState, string> = {
  Connecting: "Live feed connecting",
  Live: "Live feed connected",
  Lost: "Live feed lost",
  Reconnecting: "Live feed reconnecting",
}

export type SystemRead = { error: boolean; report: SystemReport | undefined }

// The header's three fixed slots, held from first paint so nothing moves when a sample lands; disk joins after them while orange or red, in the free space before GitHub.
const HEADER_SLOTS = ["memory", "cpu", "swap"] as const satisfies readonly ReadingKey[]

const SLOT_NAMES: Record<ReadingKey, string> = {
  cpu: "Load",
  disk: "Disk",
  fiveHour: "5-hour window",
  memory: "Memory",
  swap: "Swap",
  week: "Week",
}

// One header icon: its reading's level and number, or an outline with no number while nothing is known of it; title is its words for screen readers, hover adds the feed's state while it is not live.
export type HeaderIcon = {
  hover: string
  key: ReadingKey
  level: Health
  outline: boolean
  title: string
  value: string | null
}

// Pure: the sidebar header's system icons, after the logo and before the GitHub icon, each with its number as the status table showed it: memory, load and swap in their own levels' colours, disk after them only while orange or red, as glanceReadings picks it; three outlines with no numbers before a sample, after a failed read with none, or once sampling has stopped. The group's health is red while the live feed is lost or any hardware reading is critical, amber at any warning, a stopped sample or a failed read, green once all is well, and null before a sample; its words and the feed's state are the group's name (spoken), each reading its own icon's, so screen readers hear each once. A lost feed dims the icons and puts the read's reason on every hover.
export function headerIcons(
  { error, report }: SystemRead,
  live: LiveState,
  now: number,
  lost: string | null = null,
) {
  const feed =
    live === "Lost" ? `Live sessions cannot be read${lost ? `: ${lost}` : ""}` : FEED_LABELS[live]
  const stopped = report ? isStale(report.sampledAt, now) : false
  const readings = report && !stopped ? glanceReadings(systemReadings(report, now)) : []
  const judged = report ? systemHealth(report, now).level : error ? "amber" : null
  const health: Health | null =
    live === "Lost" ? "red" : judged === "green" && error ? "amber" : judged
  const waiting = !report
    ? error
      ? "The machine could not be read"
      : "Reading the machine"
    : stopped
      ? "Sampling has stopped"
      : null
  const withFeed = (title: string) => (live === "Live" ? title : `${title}\n${feed}`)
  const icon = (key: ReadingKey): HeaderIcon => {
    const reading = readings.find((r) => r.key === key)
    const title = reading
      ? reading.title
      : waiting
        ? `${SLOT_NAMES[key]}: ${waiting}`
        : `${SLOT_NAMES[key]} could not be read`
    return {
      hover: withFeed(title),
      key,
      level: reading?.level ?? "green",
      outline: !reading,
      title,
      value: reading?.value ?? null,
    }
  }
  const disk = readings.some((r) => r.key === "disk") ? [icon("disk")] : []
  const label = health ? HEALTH_LABELS[health] : (waiting ?? HEALTH_LABELS.green)
  return {
    dim: live === "Lost",
    health,
    icons: [...HEADER_SLOTS.map(icon), ...disk],
    spoken: `System: ${label} · ${feed}`,
  }
}

// Filled while a reading is known, its outline while it is not.
const READING_ICONS: Record<ReadingKey, { fill: typeof RiCpuLine; line: typeof RiCpuLine }> = {
  cpu: { fill: RiCpuFill, line: RiCpuLine },
  disk: { fill: RiHardDrive3Fill, line: RiHardDrive3Line },
  fiveHour: { fill: RiTimerFill, line: RiTimerLine },
  memory: { fill: RiRamFill, line: RiRamLine },
  swap: { fill: RiSwapFill, line: RiSwapLine },
  week: { fill: RiCalendarFill, line: RiCalendarLine },
}

// Green, orange, red: orange is the caution token, so the theme's amber warning stays as it is elsewhere.
const READING_TINT: Record<Health, string> = {
  amber: "text-caution",
  green: "text-success",
  red: "text-destructive",
}

// The header's system icons, on the site name's row between the name and GitHub, or a centred line of their own under it where the row holds no four readings (SidebarShell's stats slot): one 12px icon a reading and its number after it, both in its level's colour, 4px apart, the number in mono with tabular digits at its own width, the size of the footer's stats line it replaces; each reading's words are its shadcn Tooltip, on hover and on focus, and each is a link to the System page. No pulse: green icons say all is well. Dimmed while the feed is lost, as the rows are; hidden on the collapsed rail with the row.
export function SystemIcons({
  icons: { dim, icons, spoken },
  onNavigate,
}: {
  icons: ReturnType<typeof headerIcons>
  onNavigate: () => void
}) {
  return (
    <div
      role="group"
      aria-label={spoken}
      className={cn("flex h-5 items-center justify-center gap-1", dim && "opacity-60")}
    >
      {icons.map(({ hover, key, level, outline, title, value }) => {
        const Icon = outline ? READING_ICONS[key].line : READING_ICONS[key].fill
        return (
          <Hint key={key} content={hover} description={null}>
            <Link
              href="/dashboard/system"
              onClick={onNavigate}
              className="focus-visible:ring-sidebar-ring flex h-5 items-center gap-0.5 rounded-sm outline-hidden focus-visible:ring-2"
            >
              <Icon
                aria-hidden
                data-reading={key}
                className={cn("size-3 shrink-0", outline ? "text-inactive" : READING_TINT[level])}
              />
              {value !== null && (
                <span
                  aria-hidden
                  className={cn("text-2xs font-mono tabular-nums", READING_TINT[level])}
                >
                  {value}
                </span>
              )}
              <span className="sr-only">{title}</span>
            </Link>
          </Hint>
        )
      })}
    </div>
  )
}

// GitHub at the header row's right end, in the toggle's old slot, in the text's colour with no health of its own: 20px, a little over the site name's 16px type, in a 24px slot, its hit area, opening the repo's pull requests in a new tab. With no GitHub origin, nothing.
export function GithubMark({ pulls }: { pulls: string | null }) {
  if (!pulls) return null
  return (
    <Hint content="Open pull requests" description={null}>
      <a
        href={pulls}
        target="_blank"
        rel="noopener noreferrer"
        className="focus-visible:ring-sidebar-ring flex size-6 shrink-0 items-center justify-center rounded-sm outline-hidden focus-visible:ring-2"
      >
        <RiGithubFill aria-hidden className="text-foreground size-5 shrink-0" />
        <span className="sr-only">Open pull requests</span>
      </a>
    </Hint>
  )
}

// A usage row's bar cells in its level's colour, as READING_TINT tints its icon.
const BAR_TINT: Record<Health, string> = {
  amber: "bg-caution",
  green: "bg-success",
  red: "bg-destructive",
}

// One account's share as 10 cells, filled to its share in its level's colour.
function UsageBar({ row }: { row: UsageRow }) {
  return (
    <span aria-hidden className="flex gap-px">
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-2 w-1 rounded-xs",
            i < row.cells ? BAR_TINT[row.level] : "bg-background/25",
          )}
        />
      ))}
    </span>
  )
}

// A combined window's hover: how much room the pool has left, then one row an account (the factory's own marked, its name, share, bar, next reset and whether it can still be spent), the week's ending with Renews, when each plan ends or renews, in the same rows and names. A stale account dims. Its words are what the reading's sr-only line says, so the rows are drawn for the eye alone.
function UsageBlock({ reading }: { reading: Reading }) {
  return (
    <span
      aria-hidden
      className="grid grid-cols-[auto_auto_auto_auto_auto_auto] items-center gap-x-2 gap-y-1"
    >
      <span className="col-span-full font-medium">{reading.measure}</span>
      {reading.rows?.map((row) => (
        <span key={row.account} className={cn("contents", row.stale && "*:opacity-60")}>
          <span className="flex size-3 items-center">
            {row.current && <RiPlayFill className="size-3" />}
          </span>
          <span>{row.name}</span>
          <span className="text-right font-mono tabular-nums">
            {row.none ? "none" : row.used === null ? "-" : `${row.used}%`}
          </span>
          <UsageBar row={row} />
          <span className="font-mono tabular-nums">{row.reset}</span>
          <span className="opacity-70">{row.status}</span>
        </span>
      ))}
      {reading.renews && reading.renews.length > 0 && (
        <>
          <span className="col-span-full pt-1 font-medium">Renews</span>
          {reading.renews.map((renew) => (
            <Fragment key={renew.account}>
              <span />
              <span>{renew.name}</span>
              <span className="col-span-4 opacity-70">{renew.words}</span>
            </Fragment>
          ))}
        </>
      )}
    </span>
  )
}

// One usage reading: its icon tinted by its level, then its number right after it in mono with tabular digits, at its own width; across accounts, one combined figure, the fresh accounts' mean (combinedUsage), its tooltip the room the pool has left and a row an account (UsageBlock), so the bar stays short and the hover holds the detail. So every reading keeps the same gap after its icon; a stale one is gray and dimmed, since it judges nothing. Each carries its own tooltip: its icon and name, its measure, then its level or reset, one item a line; its full wording is what a screen reader hears once, from DispatcherUsage's own sr-only line, so the tooltip describes nothing (a tooltip opens on hover alone, and no stat is a Tab stop, since HTML allows no tabindex descendant of a link).
function ReadingItem({ reading }: { reading: Reading }) {
  const Icon = READING_ICONS[reading.key].line
  const tint = reading.stale ? "text-inactive" : READING_TINT[reading.level]
  return (
    <Hint
      body={reading.rows ? <UsageBlock reading={reading} /> : undefined}
      content={reading.title}
      description={null}
      lines={[
        {
          icon: <Icon aria-hidden className={cn("size-3 shrink-0", tint)} />,
          words: reading.name,
        },
        { words: reading.measure },
        { dim: reading.stale || undefined, words: reading.state },
      ].filter((line) => line.words)}
    >
      <span
        data-level={reading.level}
        className={cn("flex shrink-0 items-center gap-px", reading.stale && "opacity-60")}
      >
        <Icon aria-hidden className={cn("size-3 shrink-0", tint)} />
        <span aria-hidden>{reading.value}</span>
      </span>
    </Hint>
  )
}

const USAGE_READINGS: readonly ReadingKey[] = ["week", "fiveHour"]

// A provider's usage windows after its dispatcher's title, before its logo: the week, then the 5-hour window, each its icon and number in its level's colour, a stale one gray and dimmed (ReadingItem); their outlines with no numbers before a sample, after a failed read or once sampling has stopped. Their words are each one's tooltip and, once, the screen reader's. GLM's on a row that is not GLM's own lead with Z.ai's mark (logo). Expanded only, as the row's title is.
export function DispatcherUsage({
  logo = false,
  now,
  provider = "anthropic",
  read: { error, report },
}: {
  logo?: boolean
  now: number
  provider?: Provider
  read: SystemRead
}) {
  const glm = provider === "zai"
  const ZaiIcon = useMakerIcon("zai")
  const stale = report ? isStale(report.sampledAt, now) : false
  const readings =
    report && !stale ? (glm ? zaiReadings(report.zai, now) : systemReadings(report, now)) : []
  const known = USAGE_READINGS.map((key) => readings.find((r) => r.key === key))
  const shown = known.filter((r): r is Reading => r !== undefined)
  const words = shown.length
    ? spokenReadings(shown)
    : !report
      ? error
        ? "Could not be read"
        : "Not read yet"
      : stale
        ? "Sampling has stopped"
        : "No usage windows read"
  return (
    // the row's button sizes every icon in it to 16px, so the readings keep their 12px with an important size, as Badge does
    <span
      data-usage
      className="text-2xs flex shrink-0 items-center gap-1.5 font-mono tabular-nums group-data-[collapsible=icon]:hidden [&_svg]:size-3!"
    >
      {logo && ZaiIcon && <ZaiIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />}
      {known.map((reading, i) => {
        if (reading) return <ReadingItem key={reading.key} reading={reading} />
        const Icon = READING_ICONS[USAGE_READINGS[i]!].line
        return (
          <Icon key={USAGE_READINGS[i]} aria-hidden className="text-inactive size-3 shrink-0" />
        )
      })}
      <span className="sr-only">
        {glm ? "GLM" : "Claude"} usage: {words}
      </span>
    </span>
  )
}

type Slot = { worker: { model: string | null } | null }

// Pure: which dispatcher slot carries the Claude usage windows: the first live one not on GLM (a reply not read yet counts as Claude's), else none.
export const usageSlot = (slots: Slot[]): number =>
  slots.findIndex(({ worker }) => worker !== null && !isGlmModel(worker.model))

// Pure: which dispatcher slot carries the GLM usage windows: the first live one on GLM, else, while a GLM reading is there, the second dispatcher's row when it does not carry Claude's (Not running, or live on Claude), else none. Never beside Claude's: in the 239px row the two sets cut its name to one letter (tester).
export const glmSlot = (slots: Slot[], reading: boolean): number => {
  const own = slots.findIndex(({ worker }) => worker !== null && isGlmModel(worker.model))
  if (own !== -1 || !reading) return own
  const claude = usageSlot(slots)
  return slots.findIndex((_, i) => i > 0 && i !== claude)
}

// The machine read live through the System page's own query, so the header's readings, the dispatcher's usage and the page show one sample, with the live feed's state from the dashboard's socket.
function useSystemRead() {
  const { allowed, connected, feedProblem, workers } = useDashboard()
  const { data, error } = useSystem(allowed)
  const now = useNow()
  const read = { error: Boolean(error), report: data }
  const icons = headerIcons(
    read,
    liveState(connected, workers, feedProblem),
    now,
    feedProblem?.message ?? null,
  )
  return { allowed, icons, now, read }
}

// A link that stays in the dashboard closes the sheet on a phone, as the sidebar's own rows do.
function useCloseSheet() {
  const { isMobile, setOpenMobile } = useSidebar()
  return () => {
    if (isMobile) setOpenMobile(false)
  }
}

// Sidebar-header slot, after the title: GitHub at the row's right end. Below the owner rung, which cannot read the machine, nothing.
export function DashboardMark() {
  const { allowed, read } = useSystemRead()
  if (!allowed) return null
  return <GithubMark pulls={read.report?.pulls ?? null} />
}

// Sidebar-header slot, the title row's stats: the system icons. Below the owner rung, which cannot read the machine, nothing.
export function DashboardStats() {
  const { allowed, icons } = useSystemRead()
  const close = useCloseSheet()
  if (!allowed) return null
  return <SystemIcons icons={icons} onNavigate={close} />
}

// The user menu card's update, while the build is behind the branch its checkout follows (main or canary): its hover says how far, the newest change and how to take it (updateHover), and Update now sends that as one message to the dispatcher's chat through the outbox (updateMessage), the owner's own click, one send a click, then opens the chat; with no dispatcher live it sends nothing and opens the chat's empty state. It never updates by itself. Below the owner rung, or with no update, null.
export function useDashboardUpdate(): MenuUpdate | null {
  const { allowed, dispatcher, outbox, workers } = useDashboard()
  const { data } = useSystem(allowed)
  const now = useNow()
  const router = useRouter()
  const close = useCloseSheet()
  const hover = updateHover(data?.update, new Date(now))
  const message = updateMessage(data?.update, new Date(now))
  if (!allowed || !hover || !message || config.hosted) return null
  const live = dispatcherOf(workers, dispatcher)
  const to = live?.name ?? null
  const label = live ? chatLabel(live, dispatcher) : dispatcherLabel(null, true)
  const chat = to
    ? `Update now sends this to ${label} in your chat`
    : `Update now opens your chat with ${label}, which is not running`
  return {
    hover: `${hover}\n${chat}`,
    onUpdate: () => {
      if (to) outbox.send(to, { attachments: [], text: message })
      close()
      router.push("/dashboard")
    },
  }
}

// The dispatcher rows, in the sidebar's header under its title row, with no group title or count: a row for each dispatcher, drawn as every agent's, in the order the API names them (#i520): each one's session row, found by role, named as agentLabel gives it, Alpha and Bravo, and by its slot's label while down (dispatcherLabel), with no dropdown. The primary's opens /dashboard, your chat, and the second's its own chat. A stored sidebar draws the slots the API counts (rows, from /api/health through the layout), placeholders for those it lacks (PendingRow), so the live board's arrival moves nothing below it, and the primary's slot, with its session down, NoDispatcherRow, so the rows under it never move; the second's slot shows only while its session is live or the roster lists it in a status other than done or ended (dispatchersOf), Not running while it is down. Before the sidebar is read, as many empty rows as the API counts, so the header never grows under the nav. A bare menu, so its rows line up with the groups' rows below.
export function DashboardDispatchers({ rows = 1 }: { rows?: number }) {
  const { allowed, board, dispatchers, restoring } = useDashboard()
  const source = useSidebarSource(allowed)
  const { close, row, still } = useSessionRows(source)
  const { now, read } = useSystemRead()
  if (!allowed) return null
  // the server's paint holds the slots the API counts, so the rows arriving move nothing below the header
  if (source.kind === "pending") {
    return (
      <SidebarMenu aria-busy className="space-y-0.5">
        <PendingRow rows={rows} />
      </SidebarMenu>
    )
  }
  const workers = "workers" in source ? source.workers : null
  // before the first board names them, a stored sidebar's own dispatchers, else the primary's slot alone
  const names = dispatchers ??
    workers?.filter((w) => w.role === "dispatcher").map((w) => w.name) ?? [""]
  const agents = "agents" in source ? source.agents : board.agents
  const muted = source.kind === "stored"
  const shown = dispatcherSlotsShown(
    dispatchersOf(workers, names.length ? names : [""], agents ?? []),
    rows,
    muted,
  )
  const usage = usageSlot(shown.slots)
  const glm = glmSlot(shown.slots, Boolean(read.report?.zai))
  return (
    <SidebarMenu
      aria-busy={muted || undefined}
      className="space-y-0.5"
      data-agents={muted || (source.kind === "live" && board.agents === null) ? "loading" : "ready"}
      data-source={source.kind}
    >
      {shown.slots.map(({ name, worker }, i) => {
        const label = dispatcherRowLabel(worker, i === 0)
        const view = i === 0 ? "/dashboard" : undefined
        const trailing =
          i === usage ? (
            <DispatcherUsage now={now} read={read} />
          ) : i === glm ? (
            <DispatcherUsage
              logo={!worker || !isGlmModel(worker.model)}
              now={now}
              provider="zai"
              read={read}
            />
          ) : undefined
        // Alpha's plus, in its effort's place, starts a session from a template
        const action =
          i === 0 && !muted && !config.hosted ? (
            <TemplatePicker
              className={cn("right-1.5", PLUS_SHOWN)}
              secondRunning={shown.slots.slice(1).some((slot) => slot.worker)}
            />
          ) : undefined
        return worker ? (
          row(worker, [], view, muted, { action, label, trailing })
        ) : (
          <NoDispatcherRow
            key={name || i}
            href={i === 0 ? "/dashboard" : null}
            label={label}
            lost={source.kind === "lost"}
            muted={muted}
            onNavigate={close}
            restoring={i === 0 && restoring}
            still={still}
            trailing={trailing}
          />
        )
      })}
      {shown.held > 0 && <PendingRow rows={shown.held} />}
    </SidebarMenu>
  )
}

// Pure: a dispatcher's row names its session, Alpha for the primary and Bravo for the second (roleLabel), its model in its logo's tooltip; with no session, the slot's label (dispatcherLabel).
export const dispatcherRowLabel = (worker: { name: string } | null, primary: boolean): string =>
  worker ? agentLabel(worker.name) : dispatcherLabel(null, primary)

// Pure: the dispatcher slots the header draws and how many placeholder rows follow them. A stored sidebar keeps no down dispatcher's agent, so it draws the count the server read for this load (rows, from /api/health), cut or padded with placeholders, and the live board's arrival moves nothing below it (verify cls); the live board draws its own slots.
export const dispatcherSlotsShown = <T,>(
  slots: T[],
  rows: number,
  stored: boolean,
): { held: number; slots: T[] } =>
  stored
    ? { held: Math.max(0, rows - slots.length), slots: slots.slice(0, rows) }
    : { held: 0, slots }

// A dispatcher's row while its session is down, by its slot's label (dispatcherLabel's Alpha or Bravo, never a session's name): the slot keeps a row the placeholder's height, so the sidebar below it never moves when the board says no one holds the role (verify cls). A feed lost before any board says so rather than Not running, as the groups show no None running then, a restore that can still bring the primary back reads Coming back (its spinner stopped and the row dimmed while the feed is lost, as every row's is), and a stored sidebar is muted as its rows are. The primary's opens /dashboard, whose empty state links to the System page; the second's opens nothing (href null), since no chat of its own is there to open.
export function NoDispatcherRow({
  href = "/dashboard",
  label = dispatcherLabel(null, true),
  lost = false,
  muted = false,
  onNavigate,
  restoring = false,
  still = false,
  trailing,
}: {
  href?: string | null
  label?: string
  lost?: boolean
  muted?: boolean
  onNavigate?: () => void
  restoring?: boolean
  still?: boolean
  trailing?: React.ReactNode
}) {
  const state = lost ? "Cannot be read" : restoring ? "Coming back" : "Not running"
  return (
    <SidebarMenuItem
      aria-busy={muted || undefined}
      className={cn((muted || still) && "opacity-60")}
    >
      <SidebarMenuButton
        tooltip={{ children: `${label}: ${state}`, hidden: false }}
        aria-description={`${label}: ${state}`}
        className={ROW_BOX}
        render={href ? <Link href={href} onClick={onNavigate} /> : <span />}
      >
        {/* not running is Down, red from the one palette; a lost feed leaves the state unknown, so its mark stays gray; a restore bringing it back is progress, a gray spinner */}
        {lost ? (
          <RiShutDownLine aria-hidden className="text-inactive size-4 shrink-0" />
        ) : restoring ? (
          <RiLoader4Line
            aria-hidden
            className={cn("text-inactive size-4 shrink-0", !still && "animate-spin")}
          />
        ) : (
          <StatusIcon state="down" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs leading-3.5">{label}</span>
        {trailing}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// One subagent or background process in a row's dropdown, a plain line of what it is and its state, a process's command read to screen readers. It opens nothing, since no page shows it, and nothing opens on its hover.
function TaskRow({ task }: { task: SessionTask }) {
  const line = `${task.label} · ${TASK_LABELS[task.kind][task.state]}`
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        size="sm"
        render={<span />}
        aria-description={task.command === task.label ? undefined : task.command}
        className="text-muted-foreground hover:text-muted-foreground hover:bg-transparent"
      >
        <span>{line}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

// A reviewer or tester nested under its worker: its one icon and its own line, linking to its stream.
function MemberRow({
  agent,
  close,
  lead,
  light,
  now,
  selected,
  still,
  worker,
}: {
  agent: Agent | null
  close: () => void
  // its worker's agent, whose ticket and pull request its label takes
  lead: Agent | null
  light?: Worker["light"]
  now: number
  selected: boolean
  still: boolean
  worker: Worker
}) {
  const lines = rowLines(worker, agent, now, false, null, light, undefined, lead)
  const { first, second } = rowText(lines)
  // its name and its lines whole are its tooltip's lines
  const info = [worker.name, first, second]
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        size="sm"
        isActive={selected}
        aria-description={info.join(" · ")}
        render={
          <Link
            href={`/dashboard?worker=${encodeURIComponent(worker.sessionId)}`}
            onClick={close}
          />
        }
      >
        {/* wrapped, so the sub-button's [&>svg] colour rule does not reach the light and its state's colour shows */}
        <span className="flex shrink-0">
          <StatusIcon kind={agent?.kind} state={lines.shown} still={still} />
        </span>
        {/* one line in the stock 28px: its label leads, so the reviewer and the tester under one worker tell apart */}
        <Hint content={info.join("\n")} description={null} side="right">
          <span className="min-w-0 flex-1 truncate">{rowLabel(lines) ?? first}</span>
        </Hint>
        <ModelIcons
          effort={worker.effort}
          localModel={worker.localModel}
          localModels={worker.localModels}
          model={worker.model}
        />
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

// What closes a row's right end while it opens nothing, and gives way to its toggle when it does: the toggle shows on hover, keyboard focus, while open and always on a phone, and the effort hides by the same rules, so the two share one place.
const TOGGLE_SHOWN =
  "peer-data-active/menu-button:text-sidebar-accent-foreground md:opacity-0 md:group-hover/menu-item:opacity-100 md:group-has-[:focus-visible]/menu-item:opacity-100 group-data-[open]/menu-item:opacity-100"
const EFFORT_HIDDEN =
  "max-md:invisible md:group-hover/menu-item:invisible md:group-has-[:focus-visible]/menu-item:invisible group-data-[open]/menu-item:invisible group-has-data-[popup-open]/menu-item:invisible"
// Alpha's plus, by the toggle's rules but for hover, which counts over its own box alone, the effort's place, so with the pointer elsewhere on the row the effort stays in sight; its box takes the pointer while unseen, at opacity 0, and the effort hides on that hover only under a hover-capable pointer, as Tailwind's hover: shows the plus, so a tap leaves no blank place.
export const PLUS_SHOWN =
  "peer-data-active/menu-button:text-sidebar-accent-foreground md:opacity-0 md:hover:opacity-100 md:group-has-[:focus-visible]/menu-item:opacity-100 group-data-[open]/menu-item:opacity-100"
const PLUS_EFFORT_HIDDEN =
  "max-md:invisible md:[@media(hover:hover)]:group-has-[[data-sidebar=menu-action]:hover]/menu-item:invisible md:group-has-[:focus-visible]/menu-item:invisible group-data-[open]/menu-item:invisible group-has-data-[popup-open]/menu-item:invisible"

const MODEL_ICON = "text-muted-foreground flex shrink-0 group-data-[collapsible=icon]:hidden"

// A row's right end, ZeroSDK's: its provider's logo (its model's initials in a chip for a maker with none, nothing with no model), naming its model on hover (a local model with its level, levelName), then its effort's level, naming itself, which a local model's row with no effort set draws as a plain circle (rowEffort, LOCAL_EFFORT_ICON); with toggles, a row that opens, the effort gives way to the toggle (EFFORT_HIDDEN), and with no effort its place stays on every row, so the logos line up.
function ModelIcons({
  effort,
  effortHidden = EFFORT_HIDDEN,
  localModel,
  localModels,
  model,
  toggles = false,
}: {
  effort: string | null
  effortHidden?: string
  localModel?: string
  localModels?: { id: string }[]
  model: string | null
  toggles?: boolean
}) {
  const name = rowModelName({ localModel, model })
  const Logo = useMakerIcon(rowProvider({ localModel, model }), initialsOf(name))
  const known = effortIcon(rowEffort({ effort, localModels, model }))
  const Effort =
    known ?? (model !== null && !showsEffort({ localModels, model }) ? LOCAL_EFFORT_ICON : null)
  return (
    <>
      {model && !Logo && <span className="size-4 shrink-0 group-data-[collapsible=icon]:hidden" />}
      {model && Logo && (
        <Hint content={levelName({ effort, localModel, model })}>
          <span className={MODEL_ICON}>
            <Logo aria-hidden className="size-4" />
          </span>
        </Hint>
      )}
      {Effort ? (
        <Hint content={known ? effort : "No effort set"}>
          <span className={cn(MODEL_ICON, toggles && effortHidden)}>
            <Effort aria-hidden className="size-4" />
          </span>
        </Hint>
      ) : (
        <span className="size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
      )}
    </>
  )
}

// A manager row's moves in its menu, each null at its end.
export type RowMove = { down: (() => void) | null; up: (() => void) | null }

export type RowDrag = {
  dragging: boolean
  listeners?: ReturnType<typeof useSortable>["listeners"]
  // a pointer drop ends in a click on the row's link, which would open the session the drag only moved
  onClickCapture: (event: ReactMouseEvent) => void
  ref: (node: HTMLElement | null) => void
  style: CSSProperties
}

// A manager row's menu: Move up and Move down, the way to reorder besides the drag; every other row has no menu, its words its tooltip.
function MoveMenu({ move }: { move: RowMove }) {
  return (
    <ContextMenuContent>
      <ContextMenuGroup>
        <ContextMenuItem className="text-xs" disabled={!move.up} onClick={() => move.up?.()}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem className="text-xs" disabled={!move.down} onClick={() => move.down?.()}>
          Move down
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  )
}

// light is its held light, which its icon shows
export type RowMember = {
  agent: Agent | null
  light?: Worker["light"]
  waiting: string[]
  worker: Worker
}

// One session row, shared by every group: its one icon (Worker Lights, lightOf), then its ticket and pull request joined, then its title, then its provider's logo and its effort's icon at its right end, on one line (another repository's row: "FIX-1234#7 Dashboard home"); a worker's pull request colours its number (prTone), in words in the row's tooltip, and so is a hosted session's permission mode; the row links to its stream. The row is 32px and its title truncates on its own; its tooltip holds its name, its title whole, its model, effort, state and Draft, and what the state adds (its review round, why it is parked), the logo's the model's name and the effort's its level. No row carries a count. A row with reviewers or testers under it, subagents or background processes has a chevron that opens them beneath it, collapsed until clicked (or while one of its members is in view; a stuck one it hides turns its icon to Stuck, #i547); a dispatcher's row has none. light is the row's held light, and while the live feed is lost (still) the row dims and its spinner stops.
function SessionRowView({
  agent = null,
  close,
  action,
  drag,
  label,
  light,
  members = [],
  move,
  muted = false,
  now,
  open = false,
  onToggle = () => {},
  selected,
  selectedId = null,
  still = false,
  trailing,
  view,
  waiting = [],
  waitsOn = null,
  worker,
}: {
  // a button in its effort's place, shown as a toggle is but for hover, which counts over its own place alone (Alpha's plus, TemplatePicker, PLUS_SHOWN)
  action?: React.ReactNode
  agent?: Agent | null
  close: () => void
  // a dispatcher's name on its row (dispatcherRowLabel), which leads in place of its title
  label?: string
  light?: Worker["light"]
  members?: RowMember[]
  // a manager row's Move up and Move down, each null at its end
  move?: RowMove
  // a manager row's drag: the node and its transform for its item, the pointer and keyboard listeners for its button
  drag?: RowDrag
  // a row drawn from the stored sidebar until the live one is read: dimmed and busy
  muted?: boolean
  now: number
  open?: boolean
  onToggle?: () => void
  selected: boolean
  selectedId?: string | null
  still?: boolean
  // what sits after its title, before its logo: a dispatcher's usage windows (DispatcherUsage)
  trailing?: React.ReactNode
  // the page the row opens, when it is not the session's own ?worker= link (the dispatcher's opens /dashboard, your chat)
  view?: string
  waiting?: string[]
  // an open inbox item the session posted and depends on (playbook's ask rule)
  waitsOn?: InboxWait
  worker: Worker
}) {
  const drafted = useDrafted(worker.name)
  const lightOf = (m: RowMember) => m.light ?? m.worker.light
  // a member the usage limit alone holds waits on the reset, not a person, so it never raises the alarm
  const stuckMember = (m: RowMember) => lightOf(m) === "needs-you" && !m.worker.usageLimit
  // a reviewer or tester at work, or stuck, is a check it waits on; a stuck one leaves its worker collapsed, whose row draws the red alarm in its place (#i547)
  const memberStuck = members.some(stuckMember)
  // its members show while it is open or one of them is in view
  const membersShown = open || members.some((m) => m.worker.sessionId === selectedId)
  const checking = checksOpen(members.map(lightOf))
  const lines = rowLines(worker, agent, now, checking, waitsOn, light, label)
  const { first, prClass, prWords, second } = rowText(lines)
  // an AI runner's row says what it last did on a second, muted line, so its work shows without opening it
  const note =
    worker.role === "runner" ? runnerNote(agent ?? { report: null, task: worker.task }, now) : null
  const dispatcher = worker.role === "dispatcher"
  // the row's link opens the first card in the group: the row's own first, else the first member's
  const holder = waiting.length ? { waiting, worker } : members.find((m) => m.waiting.length)
  const card = holder?.waiting[0]
  // with no card of its own waiting, a row waiting on an inbox item opens that item in your chat
  const inboxLink = !holder && waitsOn ? waitsOn.id : null
  const href = inboxLink
    ? "/dashboard"
    : ((!holder || holder.worker === worker ? view : undefined) ??
      `/dashboard?worker=${encodeURIComponent((holder?.worker ?? worker).sessionId)}`)
  const target = card ?? inboxLink
  // Playground's row has no dropdown (Worker Lights)
  const expandable = !dispatcher && (members.length > 0 || worker.tasks.length > 0)
  // the rail hides a row's members, so a stuck one is named in the row's tooltip
  const stuck = members
    .filter(stuckMember)
    .map(
      (m) =>
        `${m.agent ? labelOf(m.agent, (name) => (name === agent?.name ? agent : undefined)) : sinName(m.worker)} ${STUCK}`,
    )
  // the row's words, a line each of its tooltip: its name, its title whole, its model, effort and state with what the state adds, its pull request in words; the name and time left show there alone, and a dispatcher's label names it in place of its session
  const info = [
    label ? null : worker.name,
    first,
    [second, drafted ? "Draft" : null, lines.eta].filter(Boolean).join(" · "),
    note?.full,
    // a hosted session's permission mode, which its composer's picker changes
    worker.permissionMode ? `${MODE_LABELS[worker.permissionMode]} mode` : null,
    prWords,
    ...stuck,
  ].filter((part): part is string => Boolean(part))
  const words = info.join(" · ")
  const what = [
    members.length ? `${members.length} checking its PR` : null,
    worker.tasks.length
      ? `${worker.tasks.length} task${worker.tasks.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(", ")
  const row = (
    <SidebarMenuButton
      isActive={selected}
      // its words show on the collapsed rail, where only its icon shows; expanded, its title's own tooltip says them
      tooltip={words}
      aria-description={move ? `${words}. ${MENU_HINT}` : words}
      {...drag?.listeners}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (move) openMenuByKey(event)
        if (!event.defaultPrevented) drag?.listeners?.onKeyDown?.(event)
      }}
      // its toggle sits in its effort's place, so a row that opens keeps the stock right padding
      className={cn(
        ROW_BOX,
        "data-active:font-normal",
        "group-has-data-[sidebar=menu-action]/menu-item:pr-2",
      )}
      // with something waiting, the row opens the session scrolled to its first card, and asks for it again when the session is already open
      render={
        <Link
          href={target ? `${href}#${needsYouAnchor(target)}` : href}
          onClick={() => {
            close()
            if (target) targetNeedsYou(target)
          }}
        />
      }
    >
      {/* a stuck member the row hides (collapsed, or on the rail) draws the row's icon as Stuck, so it never hides (#i547: "the worker row already draws the red alarm itself") */}
      {memberStuck && !membersShown ? (
        <StatusIcon state="stuck" />
      ) : memberStuck ? (
        <>
          <span className="flex shrink-0 group-data-[collapsible=icon]:hidden">
            <StatusIcon kind={agent?.kind} state={lines.shown} still={still} />
          </span>
          <span className="hidden shrink-0 group-data-[collapsible=icon]:flex">
            <StatusIcon state="stuck" />
          </span>
        </>
      ) : (
        <StatusIcon kind={agent?.kind} state={lines.shown} still={still} />
      )}
      {/* one line, ZeroSDK's, and a runner's note under it: its title, whose tooltip holds the rest, a line each, and never over the readings and icons after it, which name themselves */}
      {/* the pull request's number takes its colour, said in words for screen readers and in the row's tooltip; the title keeps the text's */}
      <Hint content={info.join("\n")} description={null} side="right">
        <span className={cn("min-w-0 flex-1", note ? "grid" : "flex")}>
          <RowFirst line={lines} prClass={prClass} prWords={prWords} />
          {note && (
            <span className="text-2xs text-muted-foreground truncate leading-3" data-part="note">
              {note.line}
            </span>
          )}
        </span>
      </Hint>
      {trailing}
      <ModelIcons
        effort={worker.effort}
        effortHidden={action ? PLUS_EFFORT_HIDDEN : undefined}
        localModel={worker.localModel}
        localModels={worker.localModels}
        model={worker.model}
        toggles={expandable || Boolean(action)}
      />
    </SidebarMenuButton>
  )
  return (
    <SidebarMenuItem
      ref={drag?.ref}
      style={drag?.style}
      onClickCapture={drag?.onClickCapture}
      aria-busy={muted || undefined}
      className={cn((muted || still || drag?.dragging) && "opacity-60")}
      data-open={open || undefined}
      // a reviewer or tester leading a row sits at a root, which never holds (verify pages fails on one)
      data-root-checker={checkerOf(worker.name, agent?.kind) ? worker.name : undefined}
    >
      {move ? (
        <ContextMenu>
          <ContextMenuTrigger render={row} />
          <MoveMenu move={move} />
        </ContextMenu>
      ) : (
        row
      )}
      {action}
      {expandable && (
        <Chevron label={`${open ? "Hide" : "Show"} ${what}`} onClick={onToggle} open={open} />
      )}
      {expandable && membersShown && (
        <SidebarMenuSub className="mr-0 gap-0.5 pr-0">
          {members.map((member) => (
            <MemberRow
              key={member.worker.sessionId}
              agent={member.agent}
              close={close}
              lead={agent}
              light={member.light}
              now={now}
              selected={member.worker.sessionId === selectedId}
              still={still}
              worker={member.worker}
            />
          ))}
          {worker.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

// An ops job keeps its own four lights, drawn from the one map: the blue spinner while it runs, the waiting mark while it has nothing to read yet, the red error while it fails, the red power mark once it is down.
const OPS_STATE = {
  down: "down",
  failing: "failing",
  running: "working",
  waiting: "waiting",
} as const

// One script under Scripts: an ops job with no Claude session behind it, so its row opens nothing and says the rest on hover. Its plain name truncates on its first line; Script, its state, when it runs and the model it calls, or AI, when jobs.json marks it callsModel, make the second, which cuts from its end and never the state. The hover adds its job id, what it does, its reason and last beat, and a schedule that disagrees with its heartbeat. A Failing or Down script reads red, since a listed job should run.
export function OpsJobRow({
  className,
  now,
  row,
  still = false,
}: {
  className?: string
  now: number
  row: OpsRow
  still?: boolean
}) {
  const { status } = opsParts(row, now)
  const when = whenWords(row.schedule)
  // a cron the reader cannot turn into words comes back as written, which reads as code
  const asWritten = when !== null && when === row.schedule?.cron
  const model = row.callsModel ? (modelName(row.model) ?? "AI") : null
  const label = [
    `${row.name} (${row.job})`,
    row.does,
    opsLine(row, now),
    model && `Calls ${model}`,
    row.problem,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <SidebarMenuItem className={cn(still && "opacity-60", className)}>
      <SidebarMenuButton
        render={<div />}
        tooltip={{ children: label, hidden: false }}
        aria-description={label}
        className={cn(ROW_BOX, "hover:bg-transparent active:bg-transparent")}
      >
        <StatusIcon state={OPS_STATE[row.status]} still={still} />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-xs leading-3.5">{row.name}</span>
          <SecondLine
            className={isBroken(row) ? "text-destructive" : "text-muted-foreground"}
            state={`Script\u00a0· ${status}`}
            tail={
              when || model ? (
                <>
                  {when && (
                    <>
                      {"\u00a0· "}
                      {asWritten ? <code className="font-mono">{when}</code> : when}
                    </>
                  )}
                  {model && (
                    <>
                      {"\u00a0· "}
                      <span className="sr-only">Calls </span>
                      <span>{model}</span>
                    </>
                  )}
                </>
              ) : null
            }
          />
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// A first line's two parts: the title starts from no width and takes only the room left (flex-1), so it gives way first, and the label, whole until the title has none, truncates only after it
const TITLE_PART = "min-w-0 flex-1 truncate"
const LABEL_PART = "text-muted-foreground min-w-0 truncate"
// When the kind follows the title, the title keeps its own width so the kind sits right after it, and the title still gives way first: the kind never shrinks, and max-w-full cuts it once the title has none
const TITLE_LEADS = "min-w-0 truncate"
const KIND_FOLLOWS = "text-muted-foreground min-w-0 max-w-full shrink-0 truncate"

// A row's first line (firstLineOf), one line in the 32px row: its label, cut only once the title is gone, so a narrow rail cuts the title first and then the label, never past the row (`AB-843#8 Reviewer Review it`, a manager's `Ops`, `Keep the dashboard up · runner`); a worker, like a session with no kind, keeps its ticket, pull request and title (`AB-843#8 Chat scroll fix`). The pull request's number takes its colour, said in words for screen readers; the worker's line is `relative`, so those words, absolutely placed past a long title, are clipped by its own truncate and never widen the sidebar's body (PG-711).
function RowFirst({
  line,
  prClass,
  prWords,
}: {
  line: FirstLine
  prClass: string | null
  prWords: string | null
}) {
  const number = line.pr !== null && (
    <span className={cn("tabular-nums", prClass ?? "text-muted-foreground")}>#{line.pr}</span>
  )
  const said = prWords && <span className="sr-only"> ({prWords})</span>
  return labelLeads(line) ? (
    <span className="flex min-w-0 text-xs leading-3.5">
      <span className={LABEL_PART} data-part="label">
        {line.ticket}
        {number}
        {`${line.kind ? `\u00a0${kindWord(line.kind)}` : ""}\u00a0`}
      </span>
      <span className={TITLE_PART}>{line.title}</span>
      {said}
    </span>
  ) : line.kind ? (
    <span className="flex min-w-0 text-xs leading-3.5">
      <span className={TITLE_LEADS}>{line.title}</span>
      <span className={KIND_FOLLOWS} data-part="label">{`\u00a0· ${line.kind}`}</span>
    </span>
  ) : (
    <span className="relative truncate text-xs leading-3.5">
      {line.ticket && <span className="text-muted-foreground">{line.ticket}</span>}
      {number}
      {(line.ticket || line.pr !== null) && " "}
      <span>{line.title}</span>
      {said}
    </span>
  )
}

// A roster worker whose session is gone, drawn from the dashboard's board: muted, its pull request, ticket and title on one line, its name, its state (Parked, or Down) and what the state holds on the hover, with the reviewers and testers still checking its pull request beneath it. It opens nothing, since it has no session to open, and shows only while one of those checks it.
function RosterRow({
  agent,
  close,
  members,
  now,
  selectedId,
  still,
}: {
  agent: Agent
  close: () => void
  members: RowMember[]
  now: number
  selectedId: string | null
  still: boolean
}) {
  const { open } = useDashboard()
  const status = statusParts(agent, now)
  const tone = prTone(agent)
  const shown = tone ? PR_TONES[tone] : null
  const line = firstLineOf(agent, doingOf(agent, false), null)
  // the name leads the hover, then the lines, like a live row's, and rides it alone
  const label = [agent.name, firstLine(line), status.text, status.detail]
    .filter(Boolean)
    .join(" · ")
  // a member the usage limit alone holds waits on the reset, not a person, so it never raises the alarm
  const lightOf = (m: RowMember) => m.light ?? m.worker.light
  const stuckMember = (m: RowMember) => lightOf(m) === "needs-you" && !m.worker.usageLimit
  const memberStuck = members.some(stuckMember)
  const what = `${members.length} checking its PR`
  const isOpen = open.has(`roster:${agent.name}`)
  const membersShown = isOpen || members.some((m) => m.worker.sessionId === selectedId)
  return (
    <SidebarMenuItem data-open={isOpen || undefined}>
      <SidebarMenuButton
        render={<div />}
        tooltip={{ children: label, hidden: false }}
        aria-description={label}
        // the roster row itself is muted, not its item: a live reviewer nested under it draws at full strength
        className={cn(ROW_BOX, "hover:bg-transparent active:bg-transparent opacity-60")}
      >
        {/* a stuck checker it hides draws its icon as Stuck, so it never hides (#i547) */}
        <StatusIcon state={memberStuck && !membersShown ? "stuck" : status.state} still={still} />
        {/* one line, its state in its tooltip (label) */}
        <span className="flex min-w-0 flex-1">
          <RowFirst line={line} prClass={shown?.className ?? null} prWords={shown?.words ?? null} />
        </span>
      </SidebarMenuButton>
      {members.length > 0 && (
        <Chevron
          label={`${isOpen ? "Hide" : "Show"} ${what}`}
          onClick={() => open.toggle(`roster:${agent.name}`)}
          open={isOpen}
        />
      )}
      {members.length > 0 && membersShown && (
        <SidebarMenuSub className="mr-0 gap-0.5 pr-0">
          {members.map((member) => (
            <MemberRow
              key={member.worker.sessionId}
              agent={member.agent}
              close={close}
              lead={agent}
              light={member.light}
              now={now}
              selected={member.worker.sessionId === selectedId}
              still={still}
              worker={member.worker}
            />
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

// The Scripts group: the ops jobs jobs.json does not pause, collapsed by default, with a Failing or Down one still under the collapsed label. Its count is the jobs it lists, collapsed or not.
function ScriptsGroup({
  muted,
  now,
  ops,
  still,
}: {
  muted: boolean
  now: number
  ops: OpsRow[]
  still: boolean
}) {
  const { open, setOpen } = useDashboard().scripts
  const { setOpen: expand } = useSidebar()
  const rows = scriptsShown(ops, open)
  const rail = scriptsRail(ops)
  return (
    <SidebarGroup>
      <MovableGroupLabel open={open} setOpen={setOpen}>
        Scripts
        <LabelChevron open={open} />
        <GroupCount count={scriptCount(ops)} />
      </MovableGroupLabel>
      <SidebarMenu
        aria-busy={muted || undefined}
        className={cn("space-y-0.5", muted && "opacity-60")}
      >
        {/* on the collapsed rail the group is this one icon, which opens the sidebar on the scripts */}
        <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
          <SidebarMenuButton
            tooltip={rail.words}
            onClick={() => {
              setOpen(true)
              expand(true)
            }}
          >
            <RiTerminalBoxLine className={cn(rail.broken && "text-destructive")} />
            <span>{rail.words}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {rows.map((job) => (
          <OpsJobRow
            key={job.job}
            className="group-data-[collapsible=icon]:hidden"
            now={now}
            row={job}
            still={still}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

// One manager row as dnd-kit sorts it: its item takes the node and the transform, its button the listeners, so the row keeps its link and its one tab stop.
function SortableManager({
  children,
  name,
  onClickCapture,
}: {
  children: (drag: RowDrag) => React.ReactNode
  name: string
  onClickCapture: (event: ReactMouseEvent) => void
}) {
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id: name })
  return children({
    dragging: isDragging,
    listeners,
    onClickCapture,
    ref: setNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition },
  })
}

// Pure: whether a closed group keeps a nested row: its lead or any member under it keeps (keepsOther), so a checker waiting under an idle manager still shows.
export const keepsNested = <T,>(lead: T, members: T[], keep: (item: T) => boolean): boolean =>
  [lead, ...members].some(keep)

// The Orchestrators group, each row by its role word (Builder, Planner): A to Z by roster title until a row is dragged, Move up and Move down in each row's menu, and Space then the arrows then Space on a focused row; a drop is its own confirmation and saves the whole order, and Reset order in the label's menu forgets it. A stored sidebar, muted until the live one is read, drags nothing.
function ManagersGroup({
  count,
  keep,
  membersOf,
  muted,
  row,
  sessions,
}: {
  count: number
  keep: (worker: Worker) => boolean
  membersOf: (worker: Worker) => Worker[]
  muted: boolean
  row: (
    worker: Worker,
    members?: Worker[],
    view?: string,
    muted?: boolean,
    extra?: { label?: string; manager?: { drag: RowDrag; move: RowMove } },
  ) => React.ReactNode
  sessions: Worker[]
}) {
  const { managers } = useDashboard()
  const [open, setOpen] = useGroupOpen("Orchestrators", true)
  // set from a drag's start until just after its drop, so the click the drop raises is swallowed
  const dragging = useRef(false)
  const settle = () => {
    setTimeout(() => {
      dragging.current = false
    })
  }
  const swallowDropClick = (event: ReactMouseEvent) => {
    if (!dragging.current) return
    event.preventDefault()
    event.stopPropagation()
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Enter follows the row's link, so Space alone starts and ends a keyboard move
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { cancel: ["Escape"], end: ["Space"], start: ["Space"] },
    }),
  )
  const names = sessions.map((worker) => worker.name)
  const moveTo = (from: number, to: number) => managers.move(arrayMove(names, from, to))
  return (
    <SidebarGroup>
      {/* the managers' order is a write, so the hosted build keeps A to Z with no Reset and no row drag */}
      <MovableGroupLabel
        open={open}
        setOpen={setOpen}
        menu={
          !config.hosted && (
            <ContextMenuItem
              className="text-xs"
              disabled={managers.order.length === 0}
              onClick={managers.reset}
            >
              Reset order to A to Z
            </ContextMenuItem>
          )
        }
      >
        Orchestrators
        <LabelChevron open={open} />
        <GroupCount count={count} />
      </MovableGroupLabel>
      <SidebarMenu
        aria-busy={muted || undefined}
        className={cn("space-y-0.5", muted && "opacity-60")}
      >
        {!open ? (
          // closed, only the rows kept as Other keeps them, a manager's for itself or a checker under it, unsorted, so no drag reorders a part of the list
          sessions
            .filter((worker) => keepsNested(worker, membersOf(worker), keep))
            .map((worker) => row(worker, membersOf(worker)))
        ) : sessions.length === 0 ? (
          // Hidden in the icon rail, where a row with no icon would show as a clipped word.
          <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuButton disabled>
              <span>None running</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : muted || config.hosted ? (
          sessions.map((worker) => row(worker, membersOf(worker)))
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => {
              dragging.current = true
            }}
            onDragCancel={settle}
            onDragEnd={({ active, over }) => {
              settle()
              if (!over || active.id === over.id) return
              moveTo(names.indexOf(String(active.id)), names.indexOf(String(over.id)))
            }}
          >
            <SortableContext items={names} strategy={verticalListSortingStrategy}>
              {sessions.map((worker, at) => (
                <SortableManager
                  key={worker.sessionId}
                  name={worker.name}
                  onClickCapture={swallowDropClick}
                >
                  {(drag) =>
                    row(worker, membersOf(worker), undefined, false, {
                      manager: {
                        drag,
                        move: {
                          down: at < names.length - 1 ? () => moveTo(at, at + 1) : null,
                          up: at > 0 ? () => moveTo(at, at - 1) : null,
                        },
                      },
                    })
                  }
                </SortableManager>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}

// The Other group: probes and sessions outside the factory's names, such as one started by hand, collapsed until opened, with any idle for over three hours behind Show N idle. One waiting on you, or open in the view, shows even while the group is collapsed.
function OtherGroup({
  count,
  now,
  row,
  selected,
  sessions,
  waitingOf,
}: {
  count: number
  now: number
  row: (worker: Worker) => React.ReactNode
  selected: string | null
  sessions: Worker[]
  waitingOf: (worker: Worker) => string[]
}) {
  const { open, setOpen, setShowIdle, showIdle } = useDashboard().other
  const { idle, rows } = otherRows(sessions, {
    idle: (w) => longIdle(w.light, w.lastActiveAt, now),
    keep: (w) => keepsOther(w.light, waitingOf(w).length > 0, w.sessionId === selected),
    open,
    showIdle,
  })
  return (
    <SidebarGroup>
      <MovableGroupLabel open={open} setOpen={setOpen}>
        Other
        <LabelChevron open={open} />
        <GroupCount count={count} />
      </MovableGroupLabel>
      <SidebarMenu className="space-y-0.5">
        {rows.map((worker) => row(worker))}
        {open && idle > 0 && (
          // Hidden in the icon rail, where a row with no icon would show as a clipped word.
          <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuButton
              className="text-muted-foreground"
              onClick={() => setShowIdle(!showIdle)}
            >
              <span>{showIdle ? "Hide idle" : `Show ${idle} idle`}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}

type SessionRowProps = Parameters<typeof SessionRowView>[0]

const sameList = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && a.every((x, i) => x === b[i])

const sameMember = (a: RowMember, b: RowMember) =>
  a.agent === b.agent &&
  a.light === b.light &&
  a.worker === b.worker &&
  sameList(a.waiting, b.waiting)

// A row draws again only when what it shows moved, so a keystroke in the composer or a board frame that left it as it was leaves it alone; its waits and members are built afresh on each render, so they compare by what they hold, and onToggle always toggles its own worker's id.
const sameRow = (a: SessionRowProps, b: SessionRowProps) =>
  (Object.keys({ ...a, ...b }) as (keyof SessionRowProps)[]).every((key) => {
    if (key === "onToggle") return true
    if (key === "waiting") return sameList(a.waiting, b.waiting)
    if (key === "waitsOn")
      return a.waitsOn?.id === b.waitsOn?.id && a.waitsOn?.ref === b.waitsOn?.ref
    if (key === "members") {
      const [x = [], y = []] = [a.members, b.members]
      return x.length === y.length && x.every((m, i) => sameMember(m, y[i]!))
    }
    return a[key] === b[key]
  })

export const SessionRow = memo(SessionRowView, sameRow)

// One item the groups' nest places: a live session, or a roster worker whose session is gone, which the dashboard's board holds as a down agent with no session of its own.
type NestItem = { kind: "roster"; agent: Agent } | { kind: "session"; worker: Worker }

// The shared parts of a session row, for every row in the groups, the dispatchers' included: the row itself (its agent, its waits, its members and whether it is open or in view), the checkers nested under their workers, and what waits in a session.
function useSessionRows(source?: SidebarSource) {
  const { allowed, board, connected, dispatcher, feedProblem, held, open, selected, workers } =
    useDashboard()
  // nothing claims work it cannot see: spinners stop while the live feed is lost
  const still = liveState(connected, workers, feedProblem) === "Lost"
  const items = useInbox(allowed).data?.items
  const inbox = inboxWaiting(items ?? [])
  const now = useNow()
  const { isMobile, setOpenMobile } = useSidebar()
  const close = useCallback(() => {
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])
  // a stored row draws the agent and waits stored with it, so its text is what the live row will show
  const shown = source?.kind === "stored" ? source : null
  const waitingOf = (worker: Worker) =>
    shown ? (shown.waiting[worker.sessionId] ?? []) : sessionWaiting(worker, inbox, dispatcher)
  const waitsOf = (worker: Worker): InboxWait =>
    shown ? (shown.waits[worker.sessionId] ?? null) : inboxWaitOf(items ?? [], worker.name)
  const agentOf = (worker: Worker) =>
    (shown ? shown.agents : board.agents)?.find((agent) => agent.sessionId === worker.sessionId) ??
    null
  const memberOf = (member: Worker): RowMember => ({
    agent: agentOf(member),
    light: held.get(member.sessionId),
    waiting: waitingOf(member),
    worker: member,
  })
  const row = (
    worker: Worker,
    members: Worker[] = [],
    view?: string,
    muted = false,
    extra: {
      action?: React.ReactNode
      label?: string
      manager?: { drag: RowDrag; move: RowMove }
      trailing?: React.ReactNode
    } = {},
  ) => (
    <SessionRow
      key={worker.sessionId}
      action={extra.action}
      drag={extra.manager?.drag}
      move={extra.manager?.move}
      agent={agentOf(worker)}
      close={close}
      label={extra.label}
      light={held.get(worker.sessionId)}
      members={members.map(memberOf)}
      muted={muted}
      now={now}
      open={open.has(worker.sessionId)}
      onToggle={() => open.toggle(worker.sessionId)}
      selected={worker.sessionId === selected?.sessionId}
      selectedId={selected?.sessionId ?? null}
      still={still}
      trailing={extra.trailing}
      view={view}
      waiting={waitingOf(worker)}
      waitsOn={waitsOf(worker)}
      worker={worker}
    />
  )
  // a roster worker whose session is gone, from the live board or the stored one: it takes the reviewers and testers of a pull request no live worker holds, and shows only while one of them checks it, so a checker nests under its muted roster row in the stored paint too and never jumps when the board arrives
  const rosterRows: Agent[] =
    source?.kind === "stored"
      ? source.agents.filter(isRosterAgent)
      : source?.kind === "live"
        ? (board.agents ?? []).filter(isRosterAgent)
        : []
  // one nest over Orchestrators and Subagents together, plus the roster workers whose session is gone, so a reviewer or tester nests under its lead wherever its group sits (a train tester under its lead, a reviewer under a roster row); each row renders in its lead's group (DashboardNav)
  const sessions = source && "workers" in source ? source.workers : []
  const placed = nestCheckers(
    [
      ...sessions
        .filter((w) => w.role === "manager" || w.role === "worker")
        .map((worker): NestItem => ({ kind: "session", worker })),
      ...rosterRows.map((agent): NestItem => ({ kind: "roster", agent })),
    ],
    {
      group: (item) => (item.kind === "session" && item.worker.role === "manager" ? 0 : 1),
      kind: (item) => (item.kind === "roster" ? item.agent : agentOf(item.worker))?.kind ?? null,
      name: (item) => (item.kind === "roster" ? item.agent.name : item.worker.name),
      pr: (item) =>
        item.kind === "roster"
          ? (item.agent.pr?.number ?? null)
          : (agentOf(item.worker)?.pr?.number ?? null),
      state: (item) =>
        item.kind === "roster"
          ? item.agent.state
          : nestState(
              item.worker.light,
              Boolean(item.worker.usageLimit),
              waitingOf(item.worker).length > 0 || waitsOf(item.worker) !== null,
            ),
      worker: (item) =>
        item.kind === "roster" ? item.agent.worker : (agentOf(item.worker)?.worker ?? null),
    },
  )
  return { close, memberOf, now, placed, row, still, waitingOf }
}

// The sidebar as this browser last showed it, so a reload paints its rows at once, at their real count and order.
// Versioned: bump it when a row reads a Worker or Agent field parseShown does not check, so an older store is dropped rather than drawn.
export const SHOWN_KEY = "dashboard.sidebar.shown.v5"

// agents, waiting and waits are what each row draws beside its session (its pull request, ticket and status, the cards its link opens, and the inbox item it waits on), so a stored row paints the same text as the live one that replaces it.
export type ShownSidebar = {
  agents: Agent[]
  ops: OpsRow[]
  waiting: Record<string, string[]>
  waits: Record<string, NonNullable<InboxWait>>
  workers: Worker[]
}

// Pure: what a row needs to draw again: each session's Feed, questions and tasks left out, the tasks since they hold background commands that should not outlive the page in storage, and a row's height never depends on them (rows start collapsed).
export const shownOf = (
  workers: Worker[],
  ops: OpsRow[],
  agents: Agent[] = [],
  waiting: Record<string, string[]> = {},
  waits: Record<string, InboxWait> = {},
): ShownSidebar => {
  const sessions = new Set(workers.map((worker) => worker.sessionId))
  return {
    // each agent's free text (its last report and task) stays out too, and a gone worker's roster agent stays in, so a checker nests under its muted row in the stored paint too
    agents: agents
      .filter(
        (agent) =>
          (agent.sessionId !== null && sessions.has(agent.sessionId)) || isRosterAgent(agent),
      )
      .map((agent) => ({ ...agent, report: null, task: null })),
    ops,
    waiting: Object.fromEntries(
      Object.entries(waiting).filter(([id, ids]) => sessions.has(id) && ids.length > 0),
    ),
    waits: Object.fromEntries(
      Object.entries(waits).filter(
        (entry): entry is [string, NonNullable<InboxWait>] =>
          sessions.has(entry[0]) && entry[1] !== null,
      ),
    ),
    workers: workers.map((worker) => ({
      ...worker,
      feed: [],
      questions: [],
      tasks: [],
    })),
  }
}

// Pure: the stored sidebar read back, or null when there is none or it is not in the shape a row needs (another version wrote it, or it was cut short).
export function parseShown(raw: string | null): ShownSidebar | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ShownSidebar> | null
    const rowsOk =
      Array.isArray(value?.workers) &&
      value.workers.every(
        (w) =>
          typeof w?.sessionId === "string" &&
          typeof w.name === "string" &&
          typeof w.role === "string" &&
          Object.hasOwn(LIGHT_LABELS, w.light) &&
          Array.isArray(w.tasks),
      )
    const opsOk =
      Array.isArray(value?.ops) &&
      value.ops.every((job) => typeof job?.job === "string" && Object.hasOwn(OPS_STATE, job.status))
    const agentsOk =
      Array.isArray(value?.agents) &&
      value.agents.every((a) => typeof a?.name === "string" && typeof a.role === "string")
    const waitingOk =
      typeof value?.waiting === "object" &&
      value.waiting !== null &&
      !Array.isArray(value.waiting) &&
      Object.values(value.waiting).every(
        (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
      )
    // a store written before inbox waits read as none
    const waits = value?.waits ?? {}
    const waitsOk =
      typeof waits === "object" &&
      waits !== null &&
      Object.values(waits).every((w) => typeof w?.id === "string" && typeof w.ref === "number")
    return rowsOk && opsOk && agentsOk && waitingOk && waitsOk
      ? {
          agents: value!.agents!,
          ops: value!.ops!,
          waiting: value!.waiting!,
          waits,
          workers: value!.workers!,
        }
      : null
  } catch {
    return null
  }
}

// Pure: the live rows in the stored order while the first load holds it, so the first live frame moves no row: rows the store held keep their places, and new ones follow in live order, at the end of their group.
export function inShownOrder(live: Worker[], shown: Worker[]): Worker[] {
  const at = new Map(shown.map((worker, i) => [worker.sessionId, i]))
  const known = live
    .filter((worker) => at.has(worker.sessionId))
    .sort((a, b) => at.get(a.sessionId)! - at.get(b.sessionId)!)
  return [...known, ...live.filter((worker) => !at.has(worker.sessionId))]
}

// What the sidebar draws its sessions from. Pending is the server's paint and a first visit before the board and the ops jobs are read: no rows, so nothing is replaced, only added below. Stored is the last-known sidebar, muted, until the live one is read. Lost is a feed lost before any board: each group its label alone, but Scripts keeps the ops jobs, a read of their own that needs no terminal.
export type SidebarSource =
  | { kind: "live"; ops: OpsRow[]; workers: Worker[] }
  | ({ kind: "stored" } & ShownSidebar)
  | { kind: "lost"; ops: OpsRow[] }
  | { kind: "pending" }

// Pure: the sidebar's source from what is read so far: the live board once it, the ops jobs and what its rows draw beside it (the agents board and the inbox, extrasRead) are, in the stored order while held; else the stored one; else lost or pending.
export function sidebarSource({
  extrasRead,
  feedLost,
  held,
  mounted,
  ops,
  stored,
  workers,
}: {
  extrasRead: boolean
  feedLost: boolean
  held: boolean
  mounted: boolean
  ops: OpsRow[] | undefined
  stored: ShownSidebar | null | undefined
  workers: Worker[] | null
}): SidebarSource {
  if (!mounted) return { kind: "pending" }
  if (workers !== null && ops !== undefined && extrasRead) {
    return {
      kind: "live",
      ops,
      workers: held && stored ? inShownOrder(workers, stored.workers) : workers,
    }
  }
  if (feedLost) return { kind: "lost", ops: ops ?? [] }
  if (stored) return { kind: "stored", ...stored }
  return { kind: "pending" }
}

// Pure: whether a mount holds the stored order: only one that has not read both the board and the ops jobs yet. A remount (the narrow-screen sidebar reopening, a breakpoint swap) finds both read, so it shows the live order at once rather than an old one it would later jump from.
export const holdsOrder = (
  workers: Worker[] | null,
  ops: OpsRow[] | undefined,
  extrasRead: boolean,
): boolean => workers === null || ops === undefined || !extrasRead

let storedRead: ShownSidebar | null | undefined
const readStored = (): ShownSidebar | null => {
  if (storedRead === undefined) {
    try {
      storedRead = parseShown(localStorage.getItem(SHOWN_KEY))
    } catch {
      storedRead = null
    }
  }
  return storedRead
}
const noChanges = () => () => {}

// The sidebar's source: the store is read once, after hydration (the server snapshot is pending), and the live board, once read, is written back on every change, keeping the cached read current for the next mount once the hold ends (in try/catch: a private window or blocked storage only loses the head start), holding the stored order for LIGHT_HOLD_MS after it arrives.
function useSidebarSource(allowed: boolean): SidebarSource {
  const { board, dispatcher, feedProblem, workers } = useDashboard()
  const opsRead = useOps(allowed)
  const ops = opsRead.isPending ? undefined : (opsRead.data ?? [])
  const inboxRead = useInbox(allowed)
  const extrasRead = !board.isPending && !inboxRead.isPending
  const mounted = useSyncExternalStore(
    noChanges,
    () => true,
    () => false,
  )
  const stored = useSyncExternalStore(noChanges, readStored, () => undefined)
  const ready = workers !== null && ops !== undefined && extrasRead
  const [held, setHeld] = useState(() => holdsOrder(workers, ops, extrasRead))
  useEffect(() => {
    if (!ready || !held) return
    const timer = setTimeout(() => setHeld(false), LIGHT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [ready, held])
  useEffect(() => {
    if (!allowed || workers === null || ops === undefined || !extrasRead) return
    const items = inboxRead.data?.items ?? []
    const inbox = inboxWaiting(items)
    const waiting = Object.fromEntries(
      workers.map((worker) => [worker.sessionId, sessionWaiting(worker, inbox, dispatcher)]),
    )
    const waits = Object.fromEntries(
      workers.map((worker) => [worker.sessionId, inboxWaitOf(items, worker.name)]),
    )
    const shown = shownOf(workers, ops, board.agents ?? [], waiting, waits)
    // not while held: every render reads the cache, so the live order would replace the stored one at the next frame
    if (!held) storedRead = shown
    try {
      localStorage.setItem(SHOWN_KEY, JSON.stringify(shown))
    } catch {}
  }, [allowed, inboxRead.data, board.agents, dispatcher, extrasRead, held, ops, workers])
  return sidebarSource({
    extrasRead,
    feedLost: feedProblem !== null,
    held,
    mounted,
    ops,
    stored,
    workers,
  })
}

// A script's second line, never wrapping: short of room it cuts with … from the end, the tail first, and never the state (Inbox #i546). The state sits in a box that does not shrink, so the tail gives way first.
function SecondLine({
  className,
  state,
  tail = null,
}: {
  className?: string
  state: string
  tail?: React.ReactNode
}) {
  return (
    <span className={cn("text-2xs flex min-w-0 leading-3", className)} data-part="line">
      <span className="flex max-w-full shrink-0" data-part="lead">
        <span className="shrink-0" data-part="state">
          {state}
        </span>
      </span>
      {tail && (
        <span className="truncate" data-part="tail">
          {tail}
        </span>
      )}
    </span>
  )
}

// A group label as its own toggle: the label is one button, its chevron after the word, open or closed as you left it (useGroupOpen).
const labelToggle = (open: boolean, setOpen: (open: boolean) => void) => (
  <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />
)

const LabelChevron = ({ open }: { open: boolean }) => (
  <RiArrowRightSLine className={cn("transition-transform", open && "rotate-90")} />
)

// A session group with no menu of its own (Subagents, AI Runners, and Orchestrators while the board is lost): its label the toggle, open to start; closed, it shows only the rows kept, as Other does.
function SessionsGroup({
  children,
  count,
  kept,
  label,
  menu,
}: {
  children: React.ReactNode
  count: number | null
  kept: React.ReactNode
  label: NavGroup
  menu: React.ComponentProps<typeof SidebarMenu> & { "data-agents": string; "data-source": string }
}) {
  const [open, setOpen] = useGroupOpen(label, true)
  return (
    <SidebarGroup>
      <MovableGroupLabel open={open} setOpen={setOpen}>
        {label}
        <LabelChevron open={open} />
        {count !== null && <GroupCount count={count} />}
      </MovableGroupLabel>
      <SidebarMenu {...menu}>{open ? children : kept}</SidebarMenu>
    </SidebarGroup>
  )
}

// A row's chevron, drawn as the docs sidebar's: the stock icon 8px in from the row's right edge, its 32px row centring the stock top offset, turning 90 degrees in 200ms on open. It stays a button of its own, since a click on the row opens the session, and nothing opens on its hover.
function Chevron({ label, onClick, open }: { label: string; onClick?: () => void; open: boolean }) {
  return (
    <SidebarMenuAction
      aria-expanded={open}
      aria-label={label}
      className={cn("right-1.5", TOGGLE_SHOWN)}
      onClick={onClick}
    >
      <RiArrowRightSLine className={cn("transition-transform duration-200", open && "rotate-90")} />
    </SidebarMenuAction>
  )
}

// A row's unread count is capped once its badge reads 99+, which gives the row's words on hover its full count and moves its menu clear of the wider badge.
const isCapped = (thread: Thread) => countLabel(thread.unread) !== String(thread.unread)

// The Threads group: your threads five to a page, pinned first, then the newest update, each opening its own view, led by a thread's icon, RiChatThreadLine, all the collapsed rail shows of it, its title on hover. Absent with no threads; past five, the label pages it and the list keeps five rows' height.
export function ThreadsGroup({
  data,
  onPage,
  onPatch,
}: {
  data: ThreadsPage
  onPage: (page: number) => void
  onPatch: (thread: Thread, patch: ThreadPatch) => void
}) {
  const close = useCloseSheet()
  const pathname = usePathname()
  const [renaming, setRenaming] = useState<Thread | null>(null)
  const [open, setOpen] = useGroupOpen("Threads", true)
  if (data.total === 0) return null
  const pager = threadPager(data)
  return (
    <SidebarGroup>
      {/* the label is the toggle, its word and chevron, with the pager's own buttons beside it */}
      <div className="flex items-center">
        <SidebarGroupLabel className="min-w-0 flex-1 pl-2.5" render={labelToggle(open, setOpen)}>
          Threads
          <LabelChevron open={open} />
        </SidebarGroupLabel>
        {open && pager && (
          <span
            className="text-sidebar-foreground/70 flex shrink-0 items-center text-xs font-medium group-data-[collapsible=icon]:hidden"
            data-slot="group-pager"
          >
            <Hint content="Previous page" description={null}>
              <Button
                {...OFF_FOCUSABLE}
                aria-label="Previous page"
                disabled={!pager.hasPrevious}
                onClick={() => onPage(pager.page - 1)}
                size="icon-xs"
                variant="ghost"
              >
                <RiArrowLeftSLine />
              </Button>
            </Hint>
            <span className="tabular-nums">
              <span aria-hidden="true">
                {pager.page} / {pager.pages}
              </span>
              <span className="sr-only">
                Page {pager.page} of {pager.pages}
              </span>
            </span>
            <Hint content="Next page" description={null}>
              <Button
                {...OFF_FOCUSABLE}
                aria-label="Next page"
                disabled={!pager.hasNext}
                onClick={() => onPage(pager.page + 1)}
                size="icon-xs"
                variant="ghost"
              >
                <RiArrowRightSLine />
              </Button>
            </Hint>
          </span>
        )}
      </div>
      <SidebarMenu className={cn("space-y-0.5", !open && "hidden")}>
        {data.threads.map((thread) => {
          const capped = isCapped(thread)
          const tip = capped ? `${thread.title} · ${thread.unread} unread` : thread.title
          return (
            <SidebarMenuItem key={thread.id}>
              <SidebarMenuButton
                render={
                  <Link
                    href={threadHref(thread)}
                    onClick={(event) => {
                      if (isPlainClick(event)) close()
                    }}
                  />
                }
                isActive={pathname === threadHref(thread)}
                tooltip={{ children: tip, hidden: false }}
                aria-description={tip}
                // below md the row's menu always shows, so it sits left of the count, and the title clears both
                className={cn(
                  ROW_BOX,
                  thread.unread > 0 &&
                    "max-md:group-has-data-[sidebar=menu-action]/menu-item:pr-14",
                  capped && "max-md:group-has-data-[sidebar=menu-action]/menu-item:pr-16",
                )}
              >
                <RiChatThreadLine />
                <span className="truncate text-xs">{thread.title}</span>
              </SidebarMenuButton>
              {thread.unread > 0 && (
                <SidebarMenuBadge className="right-1.5 group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 group-has-aria-expanded/menu-item:opacity-0">
                  {countLabel(thread.unread)}
                </SidebarMenuBadge>
              )}
              {/* each of its actions is a write, so the hosted build draws no menu */}
              {!config.hosted && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction
                        showOnHover
                        aria-label={`More for ${thread.title}`}
                        className={cn(
                          "right-1.5",
                          thread.unread > 0 && "max-md:right-7",
                          capped && "max-md:right-10",
                        )}
                      />
                    }
                  >
                    <RiMoreLine />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="right">
                    {threadActions(thread).map(({ label, patch }) => (
                      <DropdownMenuItem
                        key={label}
                        onClick={() =>
                          runAction(
                            thread,
                            { label, patch },
                            { patch: onPatch, rename: setRenaming },
                          )
                        }
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </SidebarMenuItem>
          )
        })}
        {(pager || data.page > 1) &&
          Array.from({ length: THREADS_PER_PAGE - data.threads.length }, (_, i) => (
            <li
              key={i}
              aria-hidden="true"
              className={cn(ROW_BOX, "group-data-[collapsible=icon]:hidden")}
              data-filler
            />
          ))}
      </SidebarMenu>
      <RenameThread onClose={() => setRenaming(null)} onRename={onPatch} thread={renaming} />
    </SidebarGroup>
  )
}

// A thread's Rename: its title in a box, saved on Enter or Save.
function RenameThread({
  onClose,
  onRename,
  thread,
}: {
  onClose: () => void
  onRename: (thread: Thread, patch: ThreadPatch) => void
  thread: Thread | null
}) {
  const form = useForm({
    defaultValues: { title: "" },
    validators: { onChange: renameSchema, onSubmit: renameSchema },
    onSubmit: ({ value }) => {
      const patch = thread && renamePatch(thread, value.title)
      if (patch) onRename(thread, patch)
      onClose()
    },
  })
  useEffect(() => {
    if (thread) form.reset({ title: thread.title })
  }, [form, thread])
  return (
    <Dialog open={thread !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <form
          id="rename-thread"
          onSubmit={(event) => {
            event.preventDefault()
            form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field name="title">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Title</FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      autoFocus
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      value={field.state.value}
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            </form.Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <form.Subscribe selector={(state) => state.canSubmit}>
            {(canSubmit) => (
              <Button disabled={!canSubmit} form="rename-thread" type="submit">
                Save
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The Threads group's page, its read, and each change it sends, after which the page reads again; a change refused shows its reason.
function useThreadRows(enabled: boolean) {
  const [page, setPage] = useState(1)
  const query = useThreads(enabled, page)
  const queryClient = useQueryClient()
  const back = query.data ? pageAfterEmpty(query.data) : null
  useEffect(() => {
    if (back !== null) setPage(back)
  }, [back])
  const patch = async (thread: Thread, change: ThreadPatch) => {
    try {
      await patchThread(thread.id, change)
    } catch (error) {
      toast.add({ title: (error as Error).message, type: "error" })
    }
    await queryClient.invalidateQueries({ queryKey: THREADS_QUERY_KEY })
  }
  return { data: query.data, holds: holdsForFirstTry(query), patch, setPage }
}

// The dispatcher slots a stored sidebar lacks: an empty row in a session row's own box for each, busy, so the rows that replace them move nothing, open or on the collapsed rail, and nothing shimmers.
export function PendingRow({ rows = 1 }: { rows?: number }) {
  return Array.from({ length: rows }, (_, i) => (
    <SidebarMenuItem key={i} aria-busy="true" data-loading>
      <div className={ROW_BOX} />
    </SidebarMenuItem>
  ))
}

// Pure: the nav's groups in order, Threads first once the threads are read, then every other group showing in the order you left them (groupOrder): Yard's Channels and Direct messages while each has rows (yard), and the session groups but Dispatchers, whose rows sit in the header (DashboardDispatchers).
export const navGroups = (
  threads: boolean,
  sessions: Worker[],
  yard: OrderedGroup[] = [],
  order: readonly OrderedGroup[] = ORDERED_GROUPS,
): { label: OrderedGroup | "Threads"; sessions: Worker[] }[] => {
  const shown = new Map<OrderedGroup, Worker[]>(yard.map((label) => [label, []]))
  for (const { label, sessions: held } of sessionGroups(sessions))
    if (label !== "Dispatchers") shown.set(label, held)
  return [
    ...(threads ? [{ label: "Threads" as const, sessions: [] }] : []),
    ...order.flatMap((label) => {
      const held = shown.get(label)
      return held ? [{ label, sessions: held }] : []
    }),
  ]
}

// Whether a group draws None running: Orchestrators and Subagents by their rows alone, since a manager's tester counts in their sessions yet renders under its manager; the rest by their sessions.
export const groupEmpty = (label: GroupLabel, sessions: Worker[], rows: number): boolean =>
  label === "Orchestrators" || label === "Subagents" ? rows === 0 : sessions.length === 0

// A roster worker whose session is gone: down, a worker, and no checker itself, so its reviewers and testers nest under it.
const isRosterAgent = (agent: Agent): boolean =>
  agent.sessionId === null &&
  agent.state === "down" &&
  agent.role === "worker" &&
  !checkerOf(agent.name, agent.kind)

// Sidebar-nav slot: your threads, then the other groups in the order you left them (MovableGroups, useGroupOrder), at first Yard's Channels and Direct messages (YardGroup, each while it has rows), then every live session but the dispatchers (the header's, DashboardDispatchers), grouped by role into Orchestrators, AI Runners (each with what it last did on a second line, runnerNote), Subagents (each reviewer and tester nested under its worker, a gone worker's under its muted roster row), Scripts (the ops jobs jobs.json does not pause, which have no session, collapsed until opened) and Other (each by status, as orderByStatus sets), each label with how many sessions it holds. Orchestrators, AI Runners, Subagents and Scripts always show, and Other follows while a probe or a session outside the factory's names is live; until the board is read they show the stored sidebar, muted, or nothing yet (useSidebarSource), so the first live frame replaces rows of the same count and order rather than moving any. Every group's label opens and closes it, kept across reloads (useGroupOpen), and a closed group still shows a session waiting on you or open in the view (keepsOther).
export function DashboardNav({ account }: { account: string }) {
  const { allowed, board, selected } = useDashboard()
  const [order, setOrder] = useGroupOrder(account)
  const source = useSidebarSource(allowed)
  const { close, memberOf, now, placed, row, still, waitingOf } = useSessionRows(source)
  const threads = useThreadRows(allowed)
  const yard = useYardChannels(allowed)
  const yardLate = useYardLate(allowed)

  // held for the threads' and Yard's first tries too, so neither pushes the rows below it down as it arrives; Yard's only up to YARD_HOLD_MS
  if (!allowed || source.kind === "pending" || threads.holds || holdsForYard(yard, yardLate))
    return null
  const workers = "workers" in source ? source.workers : []
  const groupOf = (lead: NestItem): GroupLabel =>
    lead.kind === "roster" ? "Subagents" : GROUP_OF[lead.worker.role]
  // a roster row draws only while a checker of its pull request nests under it; a session lead always draws
  const rowsFor = (label: GroupLabel) =>
    placed.filter(
      ({ lead, members }) =>
        groupOf(lead) === label && (lead.kind === "session" || members.length > 0),
    )
  // a lead's row: the roster row for a worker whose session is gone, else the lead session's own row, each with its checkers beneath it
  const renderRow = ({ lead, members }: Nested<NestItem>) => {
    const sessions = members.flatMap((member) => (member.kind === "session" ? [member.worker] : []))
    return lead.kind === "roster" ? (
      <RosterRow
        key={lead.agent.name}
        agent={lead.agent}
        close={close}
        members={sessions.map(memberOf)}
        now={now}
        selectedId={selected?.sessionId ?? null}
        still={still}
      />
    ) : (
      row(lead.worker, sessions)
    )
  }
  // a manager's checkers, such as a train tester, nested under it by the same nest
  const membersOf = (worker: Worker) =>
    (
      placed.find(
        ({ lead }) => lead.kind === "session" && lead.worker.sessionId === worker.sessionId,
      )?.members ?? []
    ).flatMap((member) => (member.kind === "session" ? [member.worker] : []))
  // a row a closed group still shows, as Other keeps it: one waiting on you or open in the view
  const keep = (worker: Worker) =>
    keepsOther(worker.light, waitingOf(worker).length > 0, worker.sessionId === selected?.sessionId)
  const keepsItem = ({ lead, members }: Nested<NestItem>) =>
    keepsNested(lead, members, (item) => item.kind === "session" && keep(item.worker))
  // Orchestrators and Subagents count the sessions their rows hold, a manager's tester under its manager; the rest their own sessions
  const count = (label: GroupLabel, sessions: Worker[]) =>
    label === "Orchestrators" || label === "Subagents"
      ? heldCount(rowsFor(label), (item) => item.kind === "session")
      : sessions.length

  const yardRows = yardGroups(yard.data ?? [])
  const yardShown: OrderedGroup[] = [
    ...(yardRows.channels.length > 0 ? (["Channels"] as const) : []),
    ...(yardRows.dms.length > 0 ? (["Direct messages"] as const) : []),
  ]
  const groups = navGroups(threads.data !== undefined, workers, yardShown, order)
  const sessionsOf = new Map(groups.map(({ label, sessions }) => [label, sessions]))
  const shown = groups.flatMap(({ label }) => (label === "Threads" ? [] : [label]))
  const draw = (label: OrderedGroup, sessions: Worker[]) =>
    label === "Channels" || label === "Direct messages" ? (
      <YardGroup group={label} shell="dashboard" />
    ) : label === "Scripts" ? (
      <ScriptsGroup muted={source.kind === "stored"} now={now} ops={source.ops} still={still} />
    ) : label === "Orchestrators" && source.kind !== "lost" ? (
      <ManagersGroup
        count={count(label, sessions)}
        keep={keep}
        muted={source.kind === "stored"}
        membersOf={membersOf}
        row={row}
        sessions={sessions}
      />
    ) : label === "Other" ? (
      <OtherGroup
        count={count(label, sessions)}
        now={now}
        row={row}
        selected={selected?.sessionId ?? null}
        sessions={sessions}
        waitingOf={waitingOf}
      />
    ) : (
      <SessionsGroup
        count={source.kind === "lost" ? null : count(label, sessions)}
        kept={
          source.kind === "lost"
            ? null
            : label === "Subagents"
              ? rowsFor(label).filter(keepsItem).map(renderRow)
              : sessions.filter(keep).map((worker) => row(worker))
        }
        label={label}
        menu={{
          "aria-busy": source.kind === "stored" || undefined,
          className: cn("space-y-0.5", source.kind === "stored" && "opacity-60"),
          "data-agents":
            source.kind === "stored" || (source.kind === "live" && board.agents === null)
              ? "loading"
              : "ready",
          "data-source": source.kind,
        }}
      >
        {source.kind === "lost" ? null : groupEmpty(label, sessions, rowsFor(label).length) ? (
          // Hidden in the icon rail, where a row with no icon would show as a clipped word.
          <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
            <SidebarMenuButton disabled>
              <span>None running</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : label === "Subagents" ? (
          rowsFor(label).map(renderRow)
        ) : (
          sessions.map((worker) => row(worker))
        )}
      </SessionsGroup>
    )

  return (
    <>
      {threads.data && (
        <ThreadsGroup data={threads.data} onPage={threads.setPage} onPatch={threads.patch} />
      )}
      <MovableGroups
        groups={shown}
        onMove={(from, to) => setOrder(moveGroup(order, shown, from, to))}
      >
        {(label) => draw(label, sessionsOf.get(label) ?? [])}
      </MovableGroups>
    </>
  )
}
