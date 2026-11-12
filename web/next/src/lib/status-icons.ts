import type { Agent, AgentState, Pull, UsageLimit } from "@api/hono"
import {
  RiAlarmWarningLine,
  RiAnthropicFill,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiEyeFill,
  RiGlobalFill,
  RiGroupLine,
  RiHammerFill,
  RiLoader4Line,
  RiPauseCircleLine,
  RiPauseLine,
  RiQuestionLine,
  RiSearchEyeLine,
  RiShutDownLine,
  RiSignalCellular1Fill,
  RiSignalCellular2Fill,
  RiSignalCellular3Fill,
  RiSkull2Fill,
  RiSkullFill,
  RiTestTubeFill,
  RiTimeLine,
  RiUserLine,
  RiZzzLine,
  type RemixiconComponentType,
} from "@remixicon/react"

import { ZaiLogo } from "@/components/dashboard/zai-logo"
import { checkerOf, LIGHT_LABELS, STUCK } from "@/lib/dashboard"
import type { Provider } from "@/lib/model-label"

// Worker Lights: every agent's one icon, the most urgent state first (lightOf, below), so the sidebar, its collapsed rail and the Agents table draw the same mark for the same state. Its shape says what the agent is doing, its colour whether anyone needs to act. A reviewer or tester that has given its verdict at the head reads done.
export type ShownState =
  | "stuck"
  | "usage-limit"
  | "merged"
  | "down"
  | "ended"
  | "failing"
  | "no-progress"
  | "fixing"
  | "working"
  | "waiting"
  | "approval"
  | "approvals"
  | "ready"
  | "parked"
  | "unknown"
  | "idle"
  | "done"

export type StatusTone = "caution" | "destructive" | "inactive" | "info" | "success"

// Each tone's theme token, Tailwind 600 in light mode and 500 in dark, set once in the theme: the one palette every status icon draws from.
export const STATUS_TONES: Record<StatusTone, string> = {
  caution: "text-caution",
  destructive: "text-destructive",
  inactive: "text-inactive",
  info: "text-info",
  success: "text-success",
}

export type StatusIconSpec = {
  Icon: RemixiconComponentType
  // The state in the Dashboard's words, as the row writes it beside the icon.
  label: string
  spins: boolean
  tone: StatusTone
}

// The power icon a session that went without being closed draws, red, and gray as Ended when it was closed on purpose.
export const DOWN_ICON = RiShutDownLine

const ICONS: Record<ShownState, StatusIconSpec> = {
  stuck: { Icon: RiAlarmWarningLine, label: STUCK, spins: false, tone: "destructive" },
  // its own pause, so it never reads as Parked's circled one
  "usage-limit": {
    Icon: RiPauseLine,
    label: "Paused · usage limit",
    spins: false,
    tone: "inactive",
  },
  merged: { Icon: RiCheckboxCircleLine, label: "Merged", spins: false, tone: "success" },
  down: { Icon: DOWN_ICON, label: "Down", spins: false, tone: "destructive" },
  ended: { Icon: DOWN_ICON, label: "Ended", spins: false, tone: "inactive" },
  failing: { Icon: RiErrorWarningLine, label: "Failing", spins: false, tone: "destructive" },
  "no-progress": { Icon: RiTimeLine, label: "No progress", spins: false, tone: "destructive" },
  fixing: { Icon: RiLoader4Line, label: "Fixing", spins: true, tone: "caution" },
  working: { Icon: RiLoader4Line, label: LIGHT_LABELS.working, spins: true, tone: "info" },
  waiting: { Icon: RiSearchEyeLine, label: "Waiting", spins: false, tone: "caution" },
  approval: { Icon: RiUserLine, label: "Waiting on approvals", spins: false, tone: "caution" },
  approvals: { Icon: RiGroupLine, label: "Waiting on approvals", spins: false, tone: "caution" },
  ready: { Icon: RiZzzLine, label: "Ready", spins: false, tone: "success" },
  parked: { Icon: RiPauseCircleLine, label: "Parked", spins: false, tone: "inactive" },
  // a session whose state no record tells, a Codex one, which writes none
  unknown: { Icon: RiQuestionLine, label: LIGHT_LABELS.unknown, spins: false, tone: "inactive" },
  idle: {
    Icon: RiCheckboxBlankCircleLine,
    label: LIGHT_LABELS.idle,
    spins: false,
    tone: "inactive",
  },
  done: { Icon: RiCheckboxCircleLine, label: "Done", spins: false, tone: "success" },
}

export const STATES = Object.keys(ICONS) as ShownState[]

export const statusIcon = (state: ShownState): StatusIconSpec => ICONS[state]

export const iconTone = (state: ShownState): string => STATUS_TONES[ICONS[state].tone]

// The task icons, by roster kind: while its light works or fixes, a row draws what its session does in that light's tone.
const TASK_ICONS: Partial<Record<string, RemixiconComponentType>> = {
  researcher: RiGlobalFill,
  reviewer: RiEyeFill,
  tester: RiTestTubeFill,
  worker: RiHammerFill,
}

export const taskIcon = (
  kind: string | null | undefined,
  state: ShownState,
): RemixiconComponentType | null =>
  (state === "working" || state === "fixing") && kind && Object.hasOwn(TASK_ICONS, kind)
    ? (TASK_ICONS[kind] ?? null)
    : null

// The effort icons, low to max; an effort outside them draws none.
const EFFORT_ICONS: Record<string, RemixiconComponentType> = {
  high: RiSignalCellular3Fill,
  low: RiSignalCellular1Fill,
  max: RiSkull2Fill,
  medium: RiSignalCellular2Fill,
  xhigh: RiSkullFill,
}

export const effortIcon = (effort: string | null): RemixiconComponentType | null =>
  effort && Object.hasOwn(EFFORT_ICONS, effort) ? (EFFORT_ICONS[effort] ?? null) : null

// ZeroSDK's provider logos, by providerOf's provider: Remix's Anthropic mark, which is ZeroSDK's, and ZeroSDK's own Z for Z.ai.
export const PROVIDER_ICONS: Record<Provider, RemixiconComponentType> = {
  anthropic: RiAnthropicFill,
  zai: ZaiLogo,
}

// A session busy with no new transcript line for this long is hung (a stuck command, a frozen Docker, a network call that never returns).
export const NO_PROGRESS_MS = 30 * 60_000

// What an idle agent is still waiting on, the most telling first: its reviewer or tester at work, CI, the merge queue, a helper agent, a background job, or an inbox decision it posted.
export type Wait = "checks" | "ci" | "queue" | "helper" | "job" | "inbox"

export const WAIT_WORDS: Record<Wait, string> = {
  checks: "Waiting on checks",
  ci: "Waiting on CI",
  queue: "Waiting on the merge queue",
  helper: "Waiting on a helper",
  job: "Waiting on a job",
  inbox: "Waiting on your inbox",
}

// What an agent's light is worked out from, all of it data the Dashboard already reads.
export type LightFacts = {
  // a reviewer's or tester's own verdict stands at its pull request's head
  checked?: boolean
  dispatcher?: boolean
  // the roster closed it on purpose
  ended?: boolean
  // its newest reply is an API error
  failed?: boolean
  // how long since its transcript last changed, when known
  idleFor?: number | null
  // its light as the board holds it (Stuck shows at once, the rest once they have held), or down
  light: AgentState
  // why its pull request is held, while it is
  parked?: string | null
  // its own pull request (a worker's), never a reviewer's or tester's
  pr?: Pull | null
  // the roster has it parked while its session is gone
  rosterParked?: boolean
  // set while the account's usage limit alone holds it, with when it resets
  usageLimit?: UsageLimit | null
  waits?: Wait[]
}

// Pure: an agent's one state, the most urgent that applies: Stuck (Paused · usage limit when the account's usage limit alone holds it, since it waits on the reset rather than a person), Merged, Down (Ended when closed on purpose, Parked when the roster has it parked), Failing, No progress, Fixing (at work on a pull request whose CI fails or whose review is below 5/5), Working, Waiting (idle with something it waits on still open), Waiting on approvals (one still needed, or two and more), Ready (5/5 at the head, CI green or none, no approval missing), Parked, Idle (State unknown for a session whose state no record tells, a Codex one). A reviewer or tester idle after its verdict at the head is done.
export function lightOf(facts: LightFacts): ShownState {
  const { light, pr = null } = facts
  if (light === "needs-you") return facts.usageLimit ? "usage-limit" : "stuck"
  if (pr?.state === "merged") return "merged"
  if (light === "down") return facts.ended ? "ended" : facts.rosterParked ? "parked" : "down"
  if (facts.failed) return "failing"
  if (light === "working") {
    if ((facts.idleFor ?? 0) > NO_PROGRESS_MS) return "no-progress"
    const open = pr?.state === "open"
    // the score at the head, else the newest verdict at an older head: a push or a canary merge after a 5/5 is not a fix
    const review = pr?.score ?? pr?.verdict ?? null
    if (open && (pr.ci === "failing" || (review !== null && review !== "5/5"))) return "fixing"
    return "working"
  }
  if (facts.waits?.length) return "waiting"
  if (facts.checked) return "done"
  if (pr?.state === "open") {
    if (pr.approvals > 0) return pr.approvals === 1 ? "approval" : "approvals"
    if (pr.score === "5/5" && (pr.ci === "passing" || pr.ci === "none")) return "ready"
  }
  if (facts.parked) return "parked"
  return light === "unknown" ? "unknown" : "idle"
}

// Pure: a state in words, as the row's tooltip and the table's Status column write it: the waiting state names what it waits on first, and Playground's own Stuck is on you, since his pickers are yours to answer.
export function stateWords(
  state: ShownState,
  facts: Pick<LightFacts, "dispatcher" | "waits">,
): string {
  if (state === "stuck" && facts.dispatcher) return LIGHT_LABELS["needs-you"]
  const wait = facts.waits?.[0]
  if (state === "waiting" && wait) return WAIT_WORDS[wait]
  return ICONS[state].label
}

// A worker's pull request at a glance, green once Ready or merged. It colours the pull request's number, never the icon, which says what the worker is doing.
export type PrTone = "closed" | "draft" | "failing" | "merged" | "ready" | "review"

// Each tone's theme token, and the words its hover says, since colour is never the only signal.
export const PR_TONES: Record<PrTone, { className: string; words: string }> = {
  closed: { className: "text-inactive", words: "PR closed" },
  draft: { className: "text-inactive", words: "PR draft, not reviewed yet" },
  failing: { className: "text-destructive", words: "PR CI failing" },
  merged: { className: "text-success", words: "PR merged" },
  ready: { className: "text-success", words: "PR ready: 5/5 at its head" },
  review: { className: "text-caution", words: "PR in review" },
}

// Pure: an agent's own pull request, only a worker's (a reviewer's or tester's is its worker's, and a manager's branch is not its work).
export const ownPr = (agent: Agent): Pull | null =>
  agent.pr && agent.role === "worker" && !checkerOf(agent.name, agent.kind) ? agent.pr : null

// Pure: a pull request's tone: merged, closed, red while CI fails, green at 5/5 on its head (the score the API reads is the head's alone), gray for a draft no review has ever scored (reviewed, at any head, so a push keeps a reviewed draft orange), else orange.
export function pullTone(pr: Pull): PrTone {
  if (pr.state !== "open") return pr.state
  if (pr.ci === "failing") return "failing"
  if (pr.score === "5/5") return "ready"
  return pr.draft && !pr.reviewed ? "draft" : "review"
}

// Pure: the tone of a worker's own pull request.
export function prTone(agent: Agent): PrTone | null {
  const pr = ownPr(agent)
  return pr ? pullTone(pr) : null
}

// Pure: whether a reviewer's or tester's verdict stands at the head of the pull request it checks: a reviewer's 5/5, a tester's PASS.
export function checkedOf(agent: Agent): boolean {
  const checker = checkerOf(agent.name, agent.kind)
  if (!checker || !agent.pr) return false
  return checker === "reviewer" ? agent.pr.score === "5/5" : agent.pr.tester === "pass"
}
