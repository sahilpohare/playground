// Stop hook, the inbox gate, and PreToolUse guard on AskUserQuestion: a session with a manager (PLAYGROUND_ROLE probe, reviewer, runner, tester or worker, else the roster's kind or the registry name, the hosted session aside) is refused the picker, since no one can answer one in its pane, and asks its manager by SendMessage. The gate: refuses a manager's stop while its final reply asks the owner for a decision or for their own action in chat, or keeps steps or a table the owner comes back to (keepsForOwner), until it is an item in the owner's Inbox (playbook's ask rule), so nothing the owner needs scrolls away in chat; steps or a table refuse the dispatcher's stop alone, since every other manager's reply is its report up the chain, which the dispatcher folds into the owner's card. It acts for the dispatcher and the leads (PLAYGROUND_ROLE lead, dispatcher or manager, else the roster's kind for the session's registry name, else that name), judges the hook input's `last_assistant_message` (the transcript can lag the turn's last message, ADR 0001), and refuses every stop that still asks, a lead's with the route up to the dispatcher, who posts it, `stop_hook_active` included, Claude Code's own cap on continuations in a row with no tool call between them bounding it. A reply naming an #iN passes once one of them reads open (or, for steps, is listed in the Inbox, as a progress card is) through bun run ask in the live dashboard's checkout; when none does, one it cannot read included, it fails closed for that reply. Anything else it cannot read lets the stop through.

import "../../packages/env/src/aliases"
import { join } from "node:path"

import { CLOCKS_STOPPED_AT } from "../../packages/config/src/inbox"
import {
  DISPATCHER_SLOT_LABELS,
  ID_NAME_SOURCE,
  kindOfName,
  MANAGER_KINDS,
} from "../../packages/config/src/kinds"
import { dataDir } from "../../packages/env/src/data-dir"
import { ownerSettings } from "../../packages/settings/src/owner"
import { readPolicy } from "../../packages/settings/src/rendered"
import { loadNames, MANAGER_ROLES, registryName, roleOfName, rosterNames, rosterRole } from "./role"

export const REASON =
  "name the open #iN on the same thing if one exists (playground ask open lists them), else post it with playground ask new, then say in chat that it's in the inbox as #iN"
// A lead's line: a lead sends an owner decision up the chain, and the dispatcher posts it (playbook's Chain)
export const LEAD_REASON =
  "send the decision to the dispatcher with SendMessage, which posts it to the Inbox, and keep the question out of chat; once the dispatcher names its #iN, say in chat that it's in the inbox as #iN"
// Chat scrolls, so steps the owner comes back to go in one card whose progress is edited in place.
export const STEPS_REASON =
  "put these steps in one Inbox card (playground ask new; the open #iN on the same thing if one exists, playground ask open lists them), edit each step's progress into that card, then name it in chat as #iN in one line"
// git worktree list, then each bun run ask get (all at once), is killed past its limit; one bun run ask get took 5.9s under load.
const GIT_TIMEOUT_MS = 3000
const READ_TIMEOUT_MS = 10_000
// A backstop for a read whose pipes outlive its killed process: past it, the item counts as unread, so the hook ends inside its 15s.
export const DASHBOARD_DEADLINE_MS = GIT_TIMEOUT_MS + READ_TIMEOUT_MS
const MAX_REFS = 5

const within = <T>(read: Promise<T>): Promise<T> =>
  Promise.race([
    read,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`no answer in ${DASHBOARD_DEADLINE_MS / 1000}s`)),
        DASHBOARD_DEADLINE_MS,
      ).unref(),
    ),
  ])

// "say" told to him: opening a line, a bullet, a sentence or a clause (past one of first, now, simply, so or then), or after and, or, just, or you with a modal ("you can say"), never a third person's ("The PR will say `Refs #1`")
const SAY_TO_HIM = String.raw`(?:(?:^\s*(?:(?:[-*]|\d+[.)])\s+)?|[.!?]\s+|[,;:(]\s*)(?:(?:first|now|simply|so|then)\s+)?|\b(?:and|just|or|you(?:'d|'ll|\s+(?:can|could|just|may|might|will|would))?)\s+)say\s+`
const SAY = new RegExp(String.raw`${SAY_TO_HIM}(?:["'\`][^"'\`\n]+["'\`]|yes\b|go\b)`, "im")
const PHRASES =
  /\b(?:can we|do you want|if you (?:still )?want|if you'd rather|is yours to|let me know which|one[\s-]word answer|settles it|shall I|should I|should we|tell me if|want me to|which do you|your call|your pick)\b/i
// After these a need describes, never asks ("Nothing you need to do", "If you need to roll back", "## What you need to know").
const NOT_ASKED = String.raw`(?<!\b(?:anything|if|nothing|what|whatever)\s)`
// A request for his own action, second person plus a need or a request: "please" alone, never inside a name (#projects-status-eob-please); no one, nobody or nothing waiting on him, a page only he can see, and "it yourself" after a past tense (an -ed verb, did, made, ran, saw, wrote) or a bare "you can <verb>" pass.
const ACTION = new RegExp(
  String.raw`\b(?:could you|(?<!\b(?:no one|nobody|nothing)\s)is waiting on you\b(?!')|only you can(?!'|\s(?:access|open|read|see|view)\b)|(?<![-#\w])please(?![-\w])|when you can(?!')|when you get a chance|${NOT_ASKED}you have to|${NOT_ASKED}you must|${NOT_ASKED}you need to|${NOT_ASKED}you(?:'ll| will) need to|(?<!\byou can\s)(?!(?:\w+ed|did|made|ran|saw|wrote)\s)\w+ it yourself)\b`,
  "i",
)
// A ? that is not inside a word or a URL's query (x?status=todo).
const QUESTION = /\?(?![\w/=&%#-])/
const BLOCKQUOTE = /^\s*>/
// A fenced code block, or one left open to the reply's end.
const FENCE = /```[\s\S]*?(?:```|$)/g
// Someone else's words: a line that says who asked ("A colleague asks: …", "A colleague asks in Slack: …"), never I or we, whose words are the session's own.
const QUOTED =
  /^\s*(?:[-*]\s+)?(?!(?:i|we)\s)[@\w][\w@.' -]{0,40}?\s(?:asks|asked|wrote|writes|said|says|replied|replies)(?:\s(?:in|on|via|from|over)\s[\w#@.-]+(?:\s[\w#@.-]+)?)?\s*:/i
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// The owner's names and handles (owner.names) as one alternation, or none while unset.
const ownerOf = (owner: string[]) => owner.map(escape).join("|")
// An agent's name (an old prefix or `<id>-<kind>`) or mention; the owner's own handles are not an agent.
const agentOf = (owner: string[]) =>
  String.raw`(?:@${owner.length ? String.raw`(?!(?:${ownerOf(owner)})\b)` : ""}[\w-]+|light(?:man|kid|boy|plan)|${ID_NAME_SOURCE}|(?:worker|reviewer|tester|runner|probe)-[\w-]+)`
const BULLET = String.raw`(?:(?:[-*]|\d+[.)])\s+)?`

// A role label opening a line ("Ops: should I restart the dashboard?") is a heading to the owner, never a line put to a session, so a roster name that reads as one (optimizer) stays out.
const ROLE_LABELS = new Set(
  [...DISPATCHER_SLOT_LABELS, ...MANAGER_KINDS].map((label) => label.toLowerCase()),
)

// Pure: each roster name as chat names it, its role word dropped (`worker-plain-fern` is plain-fern, `k3m9px-worker` k3m9px), as a pattern; a word that names no session (well-known) or a role label stays out.
const shownNames = (names: string[]): string[] =>
  names.flatMap((name) => {
    const kind = kindOfName(name)
    const shown = !kind
      ? name
      : name.startsWith(`${kind}-`)
        ? name.slice(kind.length + 1)
        : name.slice(0, -kind.length - 1)
    return shown && !ROLE_LABELS.has(shown.toLowerCase())
      ? [shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]
      : []
  })
// A line addressed to the owner by name, then a verb that asks them to act ("<owner>, plug in the Mac"); a bulleted "- <owner>:" is a label, as a bulleted "- builder:" is a status line, and a status to them ("<owner>, quick update: …") opens on no such verb.
const toOwner = (owner: string[]) =>
  owner.length
    ? new RegExp(
        String.raw`^\s*(?:(?:[-*]|\d+[.)])\s+@?(?:${ownerOf(owner)})\s*,|@?(?:${ownerOf(owner)})\s*[,:])\s*(?:accept|add|allow|answer|approve|check|click|close|confirm|connect|copy|create|decide|delete|deny|enable|generate|give|grant|install|log|look|merge|move|open|pass|paste|pick|plug|press|pull|put|reload|remove|reply|restart|review|rotate|run|send|share|sign|start|switch|tap|try|turn|type|unplug|upgrade|visit)\b(?!')`,
        "i",
      )
    : undefined
// A question to another agent: a line saying it was put to one ("Sent builder: …", "I asked builder: …", "To builder: …"), addressing one ("builder, …"), or opening on its name ("builder: …") with no bullet, since a bulleted "- builder: idle, …" is a status line that exempts nothing. A roster name as chat names it counts too (shownNames).
const toAgent = (names: string[], owner: string[]) => {
  const agent = [agentOf(owner), ...shownNames(names)].join("|")
  return new RegExp(
    String.raw`^\s*(?:${BULLET}(?:(?:i\s+)?(?:sent|asked|told|messaged|pinged)|to)\s+(?:${agent})\s*[,:]|${BULLET}(?:${agent})\s*,|(?:${agent})\s*:)`,
    "i",
  )
}
// An optional pointer leaves him free to skip it: "if you want to look" or "to see", and an "if you want" closing a sentence of a bare "you can" ("You can withdraw it yourself if you want."), but never an "if" later in a clause of "ask me", "let me know", "need to know", "say" or "tell me" (us too).
const IF_NOT_ASKED = String.raw`(?<!\b(?:ask (?:me|us)|let (?:me|us) know|need to know|say|tell (?:me|us))\b[^,.?!;]*)\bif you (?:still )?want`
const POINTER = new RegExp(
  String.raw`${IF_NOT_ASKED} to (?:check|look|read|see|view|watch)\b|(?<=(?<!\b(?:only|when)\s)\byou can\b(?!')[^,.?!;]*)${IF_NOT_ASKED}(?=\s*(?:[.!]|$))`,
  "gi",
)
// A quoted span is someone else's words, unless it is the word the owner is told to say (Say "go").
const QUOTE_SPAN = new RegExp(String.raw`(?<!${SAY_TO_HIM})"[^"\n]*"`, "gim")
// An inline code span is code, unless it is the word he is told to say (Say `go`).
const CODE_SPAN = new RegExp(String.raw`(?<!${SAY_TO_HIM})\`[^\`\n]*\``, "gim")
// The quoted span or the sentence that follows a QUOTED or TO_AGENT prefix: a sentence ends at its first . ? ! or ; before a space or the line's end.
const FIRST_SENTENCE = /^\s*(?:"[^"\n]*"|.*?[.?!;]+["')\]]*(?=\s|$))/

// Pure: the line's own words, with someone else's words or a line put to an agent (its prefix and first sentence) taken out, so an ask after them still counts.
function ownWords(line: string, toAgentLine: RegExp): string {
  const prefix = line.match(QUOTED) ?? line.match(toAgentLine)
  if (!prefix) return line
  const rest = line.slice(prefix[0].length)
  return FIRST_SENTENCE.test(rest) ? rest.replace(FIRST_SENTENCE, "") : ""
}

// Pure: whether the reply asks the owner for a decision or for their own action, code, quotes and lines to others (names, the roster's as chat names them) left out.
export function asksDecision(reply: string, names: string[] = [], owner: string[] = []): boolean {
  const toAgentLine = toAgent(names, owner)
  const toOwnerLine = toOwner(owner)
  const lines = reply
    .replace(FENCE, "")
    .replace(CODE_SPAN, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // bold and underline marks, so a bold label ("**A colleague asks:**") reads as its words
    .replace(/\*\*|__/g, "")
    .split("\n")
    .filter((line) => line.trim() && !BLOCKQUOTE.test(line))
  return lines.some((line, i) => {
    const own = ownWords(line, toAgentLine).replace(QUOTE_SPAN, '""').replace(POINTER, "")
    return (
      SAY.test(own) ||
      PHRASES.test(own) ||
      (QUESTION.test(own) && !answeredRow(line, lines[i + 1])) ||
      ACTION.test(own) ||
      !!toOwnerLine?.test(own)
    )
  })
}

const STEP = /^\s*\d+[.)]\s/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|\s*:?-{3,}/

// Pure: whether a table row answers its own questions, so its ? puts none to the owner: a header (the rule follows it, "| PR | Merged? |"), or a row whose every cell holding a ? has a later cell holding words and no ? ("| Did it still answer then? | yes |").
function answeredRow(line: string, next: string | undefined): boolean {
  if (!TABLE_ROW.test(line)) return false
  if (next !== undefined && TABLE_RULE.test(next)) return true
  const cells = line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim())
  return cells.every(
    (cell, n) =>
      !QUESTION.test(cell) || cells.slice(n + 1).some((later) => later && !QUESTION.test(later)),
  )
}
// Pure: the reply's lines with fenced code and blockquotes left out.
const ownLines = (reply: string) =>
  reply
    .replace(FENCE, "")
    .split("\n")
    .filter((line) => !BLOCKQUOTE.test(line))

// An issue or PR a line names: a #<n> (never an Inbox #iN or an HTML entity's &#<n>) or a GitHub issue or PR link.
const TRACKED = /(?<![\w&])#\d+\b|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/

// Pure: whether the reply keeps steps or a table the owner comes back to, 3 or more numbered lines or a markdown table, code and blockquotes left out, so a bulleted list passes; steps or a table whose every step or body row names an issue or PR are progress on tracked work, which stays in chat.
export function keepsForOwner(reply: string): boolean {
  const lines = ownLines(reply)
  const steps = lines.filter((line) => STEP.test(line))
  if (steps.length >= 3 && !steps.every((line) => TRACKED.test(line))) return true
  return lines.some((line, i) => {
    if (!TABLE_ROW.test(line) || !TABLE_RULE.test(lines[i + 1] ?? "")) return false
    const rows: string[] = []
    for (let j = i + 2; TABLE_ROW.test(lines[j] ?? ""); j++) rows.push(lines[j])
    return rows.length === 0 || !rows.every((row) => TRACKED.test(row))
  })
}

export type Deps = {
  itemStatus: (ref: string) => Promise<string>
  ownerNames?: (env: Record<string, string | undefined>) => Promise<string[]>
  sessionName: (sessionId: string) => Promise<string | undefined> | string | undefined
}

// Every dashboard read still running; Bun.spawn's timeout is a timer in this process, so a read left behind at exit would run on unbounded.
const running = new Set<Bun.Subprocess>()

async function output(command: string[], cwd: string, timeoutMs: number) {
  const run = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe", timeout: timeoutMs })
  running.add(run)
  void run.exited.finally(() => running.delete(run))
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  if (run.signalCode) throw new Error(`${command[0]} timed out after ${timeoutMs / 1000}s`)
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `${command[0]} exited ${code}`)
  return out
}

let dashboard: Promise<string> | undefined

// The live dashboard's checkout, the worktree on the branch live.branch names, whose database is the owner's Inbox.
function dashboardCheckout(): Promise<string> {
  const setting = join(import.meta.dir, "../../packages/scripts/src/playground/setting.ts")
  dashboard ??= Promise.all([
    output(["bun", setting, "--text", "live.branch"], import.meta.dir, READ_TIMEOUT_MS),
    output(["git", "worktree", "list", "--porcelain"], import.meta.dir, GIT_TIMEOUT_MS),
  ]).then(([read, listed]) => {
    const branch = read.trim()
    const block = listed
      .split("\n\n")
      .find((b) => b.split("\n").includes(`branch refs/heads/${branch}`))
    const path = block?.match(/^worktree (.+)$/m)?.[1]
    if (!path) throw new Error(`no ${branch} checkout in git worktree list`)
    return path
  })
  return dashboard
}

// An Inbox item as bun run ask get prints it, the fields the list's rule reads.
export type AskedItem = {
  answer?: Record<string, unknown> | null
  delivery?: { status?: unknown } | null
  kind?: unknown
  readAt?: string | null
  status?: unknown
  updatedAt?: string
}

// Pure: whether the Inbox lists the item, inboxView's listed rule in web/next/src/lib/inbox.ts restated, since the hook reads bun run ask's JSON and loads no web code (a test runs both over the same items); an archived item is out of the list, as the API keeps it out of the items it sends, while a card the owner put off with Later still counts, the one card the list hides that the hook counts, since it comes back on its own and a copy would notify the owner of what they put off.
export function listedItem(item: AskedItem): boolean {
  const answer = item.answer ?? null
  const dismissedAt = answer?.dismissedAt ? answer.dismissedAt : null
  if (answer && "archivedAt" in answer && !("dismissedAt" in answer)) return false
  const chosen = item.kind !== "update" && answer && "choice" in answer ? answer : null
  const sendFailed = item.kind !== "update" && item.delivery?.status === "failed" && !dismissedAt
  const needsYou =
    item.kind === "update"
      ? item.readAt === null
      : (item.status === "open" && chosen?.choice !== "replied") || sendFailed
  const reopenable = item.status === "open" && chosen?.choice === "replied" && !chosen.ackedAt
  return (
    needsYou ||
    (reopenable && !dismissedAt) ||
    (item.kind === "update" &&
      !dismissedAt &&
      !(answer && "choice" in answer) &&
      Date.parse(item.readAt ?? item.updatedAt ?? "") >= Date.parse(CLOCKS_STOPPED_AT))
  )
}

// One item's standing (standingOf), read by the checkout's own bun run ask, killed past the limit: open, or listed for one the Inbox lists that is not open (an update), else what was done with it when that left its status as it was (archived or dismissed by the owner, settled by its poster), else its status.
export async function readStatus(
  ref: string,
  checkout: string,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<string> {
  const item = JSON.parse(
    await output(
      ["bun", join(checkout, "api/hono/src/bin/dashboard-ask.ts"), "get", ref],
      checkout,
      timeoutMs,
    ),
  ) as AskedItem
  const standing = standingOf(item)
  if (!standing) throw new Error(`bun run ask printed no status for ${ref}`)
  return standing
}

// Pure: what the gate reads an item as (readStatus), or null for one with no status.
function standingOf(item: AskedItem): string | null {
  if (typeof item.status !== "string") return null
  if (listedItem(item)) return item.status === "open" ? "open" : "listed"
  if (item.answer?.choice === "settled") return "settled"
  if (item.answer?.dismissed === true) return "dismissed"
  if (item.answer?.archivedAt && !item.answer.dismissedAt)
    return item.status === "open" ? "archived while open" : "archived"
  return item.status
}

// The owner's names from the extensions' policy; none when it cannot be read, so the gate still reads every other ask.
const policyOwnerNames = async (env: Record<string, string | undefined>): Promise<string[]> => {
  const read = await readPolicy(dataDir(env))
  return read.settings ? ownerSettings.get(read.settings, "owner.names") : []
}

const live: Deps = {
  itemStatus: async (ref) => readStatus(ref, await dashboardCheckout()),
  ownerNames: policyOwnerNames,
  sessionName: registryName,
}

// The session's factory role: PLAYGROUND_ROLE, else the roster's kind for its registry name, else that name; "" for a session outside the factory.
async function factoryRole(
  env: Record<string, string | undefined>,
  sessionId: unknown,
  deps: Deps,
): Promise<string> {
  const role = env.PLAYGROUND_ROLE ?? ""
  if (role) return role
  if (typeof sessionId !== "string") return ""
  const name = (await deps.sessionName(sessionId)) ?? ""
  const rostered = name && (await rosterRole(name, env))
  if (rostered) return rostered
  await loadNames(env)
  return roleOfName(name)
}

// The session's manager role (dispatcher, lead or manager), or "" for every other session.
async function managerRole(
  env: Record<string, string | undefined>,
  sessionId: unknown,
  deps: Deps,
): Promise<string> {
  const role = await factoryRole(env, sessionId, deps)
  return MANAGER_ROLES.has(role) ? role : ""
}

// The roles that report to a manager, which answers their questions by SendMessage.
const REPORTING_ROLES = new Set(["probe", "reviewer", "runner", "tester", "worker"])

export const PICKER_REASON =
  "no-chat-question hook refuses AskUserQuestion to a session with a manager: no one can answer a picker in its pane. Send the question to your manager (your brief names it) with SendMessage."

// The hosted session runs as a probe (PLAYGROUND_ROLE=probe, sdk.ts) and its pickers reach the owner as the Dashboard's cards; the Agent SDK it runs on sets this entrypoint.
const HOSTED_ENTRYPOINT = "sdk-ts"

async function picker(
  input: { session_id?: unknown; tool_name?: unknown },
  env: Record<string, string | undefined>,
  deps: Deps,
): Promise<string | undefined> {
  if (input.tool_name !== "AskUserQuestion") return
  if (env.CLAUDE_CODE_ENTRYPOINT === HOSTED_ENTRYPOINT) return
  if (REPORTING_ROLES.has(await factoryRole(env, input.session_id, deps))) return PICKER_REASON
}

// An ask of the owner waits on an open item alone, one the owner archived included, as it waited before the listed rule, so the session is never sent to post a copy of a decision it already posted; steps take any card the Inbox lists, a progress card (an update) the owner has not sent to Done, dismissed or seen resolved, and no archived card, which the Inbox no longer lists.
const ASK_COUNTS = ["open", "archived while open"]
const STEPS_COUNTS = ["open", "listed"]

// Fails closed: the stop passes only when some #iN the reply names reads a status `counted` holds; the reason says what each one read as.
async function gate(
  reply: string,
  deps: Deps,
  reason: string,
  counted: readonly string[],
): Promise<string | undefined> {
  const refs = [...new Set(reply.match(/#i\d+\b/g) ?? [])].slice(0, MAX_REFS)
  if (!refs.length) return reason
  const anyCounts = Promise.withResolvers<"counted">()
  const reads = Promise.all(
    refs.map((ref) =>
      within(deps.itemStatus(ref)).then(
        (status) => {
          if (counted.includes(status)) anyCounts.resolve("counted")
          return { ref, status }
        },
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
          ref,
        }),
      ),
    ),
  )
  const read = await Promise.race([reads, anyCounts.promise]).finally(() => {
    for (const run of running) run.kill("SIGKILL")
  })
  if (read === "counted") return
  const why = read.map((r) =>
    "status" in r
      ? `${r.ref} is ${r.status}, not ${counted.join(" or ")}`
      : `${r.ref} could not be read with bun run ask (${r.error}), so it does not count`,
  )
  return `${reason} (${why.join("; ")})`
}

async function inspect(raw: string, env: Record<string, string | undefined>, deps: Deps) {
  const input = JSON.parse(raw) as {
    hook_event_name?: unknown
    last_assistant_message?: unknown
    session_id?: unknown
    tool_name?: unknown
  }
  if (input.hook_event_name === "PreToolUse") return picker(input, env, deps)
  const { last_assistant_message: reply, session_id: sessionId } = input
  if (typeof reply !== "string") return
  const owner = await (deps.ownerNames ?? policyOwnerNames)(env)
  const asks = asksDecision(reply, [], owner)
  const keeps = keepsForOwner(reply)
  if (!asks && !keeps) return
  const role = await managerRole(env, sessionId, deps)
  if (!role) return
  if (asks && asksDecision(reply, await rosterNames(env), owner))
    return gate(reply, deps, role === "lead" ? LEAD_REASON : REASON, ASK_COUNTS)
  if (!keeps || role !== "dispatcher") return
  return gate(reply, deps, STEPS_REASON, STEPS_COUNTS)
}

// Fails open: an input the hook cannot read, or a session it cannot place, lets the session stop or the call run.
export async function check(
  raw: string,
  env: Record<string, string | undefined> = process.env,
  deps: Deps = live,
): Promise<string | undefined> {
  try {
    return await inspect(raw, env, deps)
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const reason = await check(await Bun.stdin.text())
  // PreToolUse blocks a call on exit 2 alone, with the reason on stderr
  if (reason === PICKER_REASON) {
    console.error(reason)
    process.exit(2)
  }
  // additionalContext continues the turn without the "Stop hook error" notice a block shows (ADR 0001)
  if (reason)
    console.log(
      JSON.stringify({ hookSpecificOutput: { additionalContext: reason, hookEventName: "Stop" } }),
    )
  // a read past its deadline may still hold a pipe open, which would keep the hook running
  process.exit(0)
}
