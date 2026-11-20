#!/usr/bin/env bun
// The roster's one writer, ported from ~/.playground/roster.py: atomic writes, times from the UTC clock, titles cut to 40 characters.
import { join } from "node:path"

import {
  dispatcherOf,
  isManagerKind,
  isRosterKind,
  kindOf,
  kindOfName,
  MANAGER_KINDS,
  managerOf,
  seatOf,
  ROSTER_KINDS,
  ROSTER_ROLE_OF_KIND,
  slotOfName,
} from "../packages/config/src/kinds"
import { dataDir } from "../packages/env/src/data-dir"
import { factoryRepoOf, loadSessionNames } from "../packages/scripts/src/playground/setting"
import { writeAtomic } from "../packages/scripts/src/write-atomic"
import { SCOPE_NAME } from "../packages/settings/src/items"
import { itemKeySchema, KINDS } from "../packages/settings/src/settings"
import STATUSES from "./roster-statuses.json"

export const USAGE = `Usage:
  roster.ts set <name> key=value [key=value ...]    (creates the agent if missing, its role from kind= or its name; a new one needs task=; status=parked needs hold=, and a hold=<ref> needs the row parked)
  roster.ts report <name> <text> [key=value ...]    (sets lastReport, stamps lastReportAt; a new one needs task=)
  roster.ts assign <name> <title> <task> [k=v ...]  (new task, or a checker's next PR with worker= pr=, or the extension item it scores with worker= item=, either joining its prs list; clears pr/item/branch/repo/owner/lastReport)
  roster.ts backlog <text>
  roster.ts backlog-done <index> <issue>            (marks the 0-based entry filed: "[#<issue>] <text>")
  roster.ts backfill                                (gives each entry with no kind the one its name's prefix gives)
  roster.ts who <kind>                              (prints the name holding a manager kind's seat; writes nothing)
  roster.ts who dispatcher [1|2]                    (prints the dispatcher in slot 1, Alpha, by default, or 2, Bravo; writes nothing)
  roster.ts who assistant                           (prints the live session the roster gives the assistant kind, else exits 1; writes nothing)
  roster.ts holders <pr>                            (prints each live row naming the PR, number or URL, in pr or prs, else exits 1, and exits 2 on a roster that does not read; writes nothing)
A checker's prs list holds every PR it serves, so auto-end keeps it while one is open: prs=<pr>,<pr> sets it, prs+=<pr> adds one, prs-=<pr> removes one, and a prs-= of the row's own pr clears pr too, so holders stops naming it and an assign has nothing to re-add; a PR not yet opened goes in as its issue's URL, and an extension item as <scope>/<kind>/<key>, which assign's item= sets as the row's item and adds to prs (pr= adds it to prs alone); a checker whose row holds a pr or item takes worker= and pr= (or item=) together on assign, pr= naming an open pull request, and a checker whose worker is unset or ended takes a new PR only through that assign with a live worker=.
Times always come from the UTC clock; titles are capped at 40 chars.`

type Agent = Record<string, unknown> & { name: string }
type Roster = { agents: Agent[]; backlog?: string[]; updatedAt?: string }

class Refusal extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

// In the data folder spawn.sh reads it from, PLAYGROUND_DATA_DIR's when set.
const path = join(dataDir(process.env), "roster.json")

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

async function load(): Promise<Roster> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { agents: [], backlog: [] }
  return (await file.json()) as Roster
}

// A prs-= clears the row's pr and prs in memory, so the row read back must show the clear: if the write-back left one of the PRs the call removed still set, the clear did not persist, so refuse, naming the entry and that PR.
async function clearedOnRead(
  cmd: string,
  name: string | undefined,
  withdrawn: string[],
): Promise<void> {
  if (cmd !== "set" || !name || !withdrawn.length) return
  const row = (await load()).agents.find((a) => a.name === name)
  if (!row) return
  const held = [...((row.prs as string[] | undefined) ?? []), row.pr].filter((pr): pr is string =>
    Boolean(pr),
  )
  const still = withdrawn.find((pr) => held.includes(pr))
  if (still)
    throw new Refusal(
      `roster.ts: ${name} cleared ${still} with prs-=, but the row read back still holds it in pr or prs, so the clear did not persist`,
      1,
    )
}

// The title cut keeps whole characters and fits the reader's 40.
const titled = (value: string): string => {
  let out = ""
  for (const ch of value.replace(/\s*\(?#\d+\)?\s*$/, "")) {
    if (out.length + ch.length > 40) break
    out += ch
  }
  return out
}

const pairsOf = (args: string[]): [string, string][] =>
  args.map((kv) => {
    const at = kv.indexOf("=")
    return at === -1 ? [kv, ""] : [kv.slice(0, at), kv.slice(at + 1)]
  })

// A new agent names its task, since the dashboard's schema drops an agent with none; assign gives it as a word.
function agent(roster: Roster, name: string, pairs: [string, string][], task?: string): Agent {
  const found = roster.agents.find((a) => a.name === name)
  if (found) return found
  if (!(task ?? pairs.find(([k]) => k === "task")?.[1])?.trim()) {
    const fix =
      task === undefined ? "add task=<what it does>" : "give what it does as assign's <task> word"
    throw new Refusal(
      `roster.ts: ${name} is not on the roster yet, and the dashboard drops an agent with no task: ${fix}`,
      1,
    )
  }
  const given = pairs.find(([k]) => k === "kind")?.[1]
  const kind = kindOf(name, given)
  const role = kind ? ROSTER_ROLE_OF_KIND[kind] : slotOfName(name) !== null ? "manager" : "worker"
  const fresh: Agent = { name, role, status: "starting", task: "" }
  if (kind) fresh.kind = kind
  roster.agents.push(fresh)
  return fresh
}

// The dashboard's schema (api/hono/src/lib/dashboard/roster.ts) and code-review-loop's scan hold a PR by its full URL alone.
const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

const prUrl = (raw: string, repo: string): string => {
  const n = /^#?([1-9]\d*)$/.exec(raw)?.[1]
  const url = n ? `https://github.com/${repo}/pull/${n}` : raw
  if (PR_URL_RE.test(url)) return url
  throw new Refusal(
    `roster.ts: pr takes https://github.com/<owner>/<name>/pull/<n>, or its number alone, not ${raw}`,
    2,
  )
}

const ISSUE_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/

// An extension item a checker scores, as playground ext names one, <scope>/<kind>/<key>; null for a word of another shape.
const itemRef = (raw: string): string | null => {
  const parts = raw.split("/")
  if (parts.length !== 3 || raw.includes(":")) return null
  const [scope, kind, key] = parts as [string, string, string]
  if (
    SCOPE_NAME.test(scope) &&
    (KINDS as readonly string[]).includes(kind) &&
    itemKeySchema.safeParse(key).success
  )
    return raw
  throw itemShape(raw)
}

const itemShape = (raw: string): Refusal =>
  new Refusal(
    `roster.ts: an extension item is <scope>/<kind>/<key> as playground ext names it, a login's or org's scope, a kind of ${KINDS.join(", ")} and a key of lowercase letters, digits, dots, dashes and underscores, not ${raw}`,
    2,
  )

// A prs entry: a PR as pr takes one, the issue of a PR not yet opened by its URL, or an extension item.
const prsEntry = (raw: string, repo: string): string => {
  if (ISSUE_URL_RE.test(raw)) return raw
  if (itemRef(raw)) return raw
  try {
    return prUrl(raw, repo)
  } catch {
    throw new Refusal(
      `roster.ts: prs takes https://github.com/<owner>/<name>/pull/<n> or its number alone, a PR not yet opened as https://github.com/<owner>/<name>/issues/<n>, or an extension item as <scope>/<kind>/<key>, not ${raw}`,
      2,
    )
  }
}

const PRS_KEYS = new Set(["prs", "prs+", "prs-"])

const isChecker = (entry: Agent): boolean =>
  ["reviewer", "tester"].includes(kindOf(entry.name, entry.kind) ?? "")

// The PRs a prs-= call withdrew, normalized as the row holds them: the ones still set on the row when the call began, so a read-back can confirm the clear took.
const prsWithdrawn = (entry: Agent, pairs: [string, string][], repo: string): string[] => {
  const held = (entry.prs as string[] | undefined) ?? []
  const removed = new Set<string>()
  for (const [, raw] of pairs.filter(([k]) => k === "prs-"))
    for (const pr of raw
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean)) {
      const url = prsEntry(pr, repo)
      if (entry.pr === url || held.includes(url)) removed.add(url)
    }
  return [...removed]
}

function apply(entry: Agent, pairs: [string, string][], factoryRepo: string): void {
  const given = pairs.find(([k]) => k === "repo")
  const repo = (given ? given[1] : (entry.repo as string | undefined)) || factoryRepo
  for (const [k, raw] of pairs) {
    if (PRS_KEYS.has(k)) {
      const named = raw
        .split(",")
        .filter((one) => one.trim())
        .map((one) => prsEntry(one.trim(), repo))
      const held = k === "prs" ? [] : ((entry.prs as string[] | undefined) ?? [])
      const next =
        k === "prs-" ? held.filter((u) => !named.includes(u)) : [...new Set([...held, ...named])]
      if (next.length) entry.prs = next
      else delete entry.prs
      // A prs-= of the row's own pr clears pr too: the row no longer serves it, so holders stops naming it and an assign has nothing to re-add
      if (k === "prs-" && typeof entry.pr === "string" && named.includes(entry.pr)) delete entry.pr
      continue
    }
    // item= names the extension item a checker is given to score: it joins prs as pr= would take one, and the row holds no pr
    if (k === "item" && raw !== "") {
      if (!itemRef(raw)) throw itemShape(raw)
      if (!isChecker(entry))
        throw new Refusal(
          `roster.ts: item takes the extension item a reviewer or tester scores, and ${entry.name} is neither`,
          2,
        )
      entry.item = raw
      entry.prs = [...new Set([...((entry.prs as string[] | undefined) ?? []), raw])]
      delete entry.pr
      continue
    }
    // an extension item joins a checker's prs and leaves its pr unset, since the dashboard reads pr as a GitHub pull request alone
    if (k === "pr" && raw !== "" && itemRef(raw)) {
      if (!isChecker(entry))
        throw new Refusal(
          `roster.ts: pr takes an extension item for a reviewer or tester alone, and ${entry.name} is neither`,
          2,
        )
      entry.prs = [...new Set([...((entry.prs as string[] | undefined) ?? []), raw])]
      delete entry.pr
      continue
    }
    const v = k === "title" ? titled(raw) : k === "pr" && raw !== "" ? prUrl(raw, repo) : raw
    if (v === "") delete entry[k]
    else entry[k] = v
  }
  // Why a row ended, which spawn.sh resume reads before it brings a session back: a done row records done, and a row back at a live status drops its reason.
  const status = pairs.find(([k]) => k === "status")?.[1]
  if (status && !pairs.some(([k]) => k === "endReason")) {
    if (STATUSES.live.includes(status)) delete entry.endReason
    else if (status === "done") entry.endReason = "done"
  }
}

// A session name is spawn.sh's word shape, lowercase words joined by hyphens: a shell loop once passed a whole sentence as a name and roster.ts made three agents of it.
function checkName(cmd: string, name: string): void {
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return
  throw new Refusal(
    `roster.ts: ${cmd} takes a name of lowercase words joined by hyphens, like spawn.sh's, not "${name}"`,
    2,
  )
}

function checkKind(pairs: [string, string][]): void {
  const kind = pairs.find(([k]) => k === "kind")?.[1]
  if (kind && !isRosterKind(kind))
    throw new Refusal(`roster.ts: kind takes one of ${ROSTER_KINDS.join(", ")}, not ${kind}`, 2)
}

// A status is one word from roster-statuses.json, which ops-report reads too, so its finished check knows every ended session.
const STATUS_WORDS: string[] = [...STATUSES.live, ...STATUSES.finished]

function checkStatus(name: string, pairs: [string, string][]): void {
  const status = pairs.find(([k, v]) => k === "status" && !STATUS_WORDS.includes(v))
  if (status)
    throw new Refusal(
      `roster.ts: status takes one of ${STATUS_WORDS.join(", ")}, not "${status[1]}": progress text goes in roster.ts report ${name} "<text>"`,
      2,
    )
}

// An ETA is a future UTC time as `date -u +%FT%TZ` prints one: a worker once sent the literal placeholder <ETA>. An empty eta= clears it, and every eta= given is read, since the last one wins.
function checkEta(pairs: [string, string][]): void {
  for (const [k, eta] of pairs) {
    if (k !== "eta" || eta === "") continue
    const at = Date.parse(eta)
    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(eta) &&
      at > Date.now() &&
      new Date(at).toISOString().startsWith(eta.slice(0, 19))
    )
      continue
    throw new Refusal(
      `roster.ts: eta takes a future UTC time, not ${eta}: an ETA is \`date -u\` plus your estimate, in UTC (date -u +%FT%TZ reads ${now()} now)`,
      2,
    )
  }
}

// owner= names the owner's own ask a session works on, which run-slot.sh ranks after the merge gates: an Inbox item, an issue, a PR or a decision, never a person. An empty owner= clears it.
const OWNER_REF =
  /^(?:#i?\d+|PG-\d+|d-\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)$/

function checkOwner(pairs: [string, string][]): void {
  const owner = pairs.find(([k, v]) => k === "owner" && v !== "" && !OWNER_REF.test(v))
  if (owner)
    throw new Refusal(
      `roster.ts: owner takes the owner's ask it serves, #i<n> (an Inbox item), PG-<n>, #<n> or an issue or PR URL, or d-<n> (a decision), not ${owner[1]}`,
      2,
    )
}

// hold= names what a parked row waits on, which playground sweep reads to tell its lead once it closes: an issue or PR, an Inbox item, or a decision for a wait on no item (a lane turn, a load hold). An empty hold= clears it.
const HOLD_REF = /^(?:#i?\d+|d-\d+)$/

function checkHold(pairs: [string, string][]): void {
  const hold = pairs.find(([k, v]) => k === "hold" && v !== "" && !HOLD_REF.test(v))
  if (hold)
    throw new Refusal(
      `roster.ts: hold takes #<n> (an issue or PR), #i<n> (an Inbox item) or d-<n> (a decision), not ${hold[1]}`,
      2,
    )
}

// Every key set, report and assign take: a mistyped one once left two rows reading working for over an hour.
const KNOWN_KEYS: readonly string[] = [
  "asks",
  "backlogNext",
  "backlogTaken",
  "branch",
  "endReason",
  "eta",
  "hold",
  "item",
  "kind",
  "lastReport",
  "lastReportAt",
  "lead",
  "memory",
  "mode",
  "owner",
  "pr",
  "priority",
  "prs",
  "prs+",
  "prs-",
  "reportsTo",
  "repo",
  "role",
  "sandbox",
  "schedule",
  "size",
  "slot",
  "status",
  "surface",
  "task",
  "ticket",
  "title",
  "worker",
  "workspace",
]

// The edit distance between two words, so a key one or two edits from a real one reads as its typo.
const editDistance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next.push(
        Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)),
      )
    row = next
  }
  return row[b.length]!
}

function checkKeys(cmd: string, pairs: [string, string][]): void {
  for (const [k] of pairs) {
    if (KNOWN_KEYS.includes(k)) continue
    let near: string | null = null
    let best = 3
    for (const known of KNOWN_KEYS) {
      const at = editDistance(k, known)
      if (at < best) {
        best = at
        near = known
      }
    }
    throw new Refusal(
      `roster.ts: ${cmd} takes a key the roster knows (${KNOWN_KEYS.join(", ")}), not "${k}"${near ? `: did you mean "${near}"?` : ""}`,
      2,
    )
  }
}

// Every key=value check set, report and assign share.
function checkPairs(cmd: string, name: string, pairs: [string, string][]): void {
  checkKeys(cmd, pairs)
  checkKind(pairs)
  checkStatus(name, pairs)
  checkEta(pairs)
  checkOwner(pairs)
  checkHold(pairs)
  checkTarget(pairs)
}

// A checker's next work is one pull request (pr=) or one extension item (item=), so a call naming both is refused before either is read.
function checkTarget(pairs: [string, string][]): void {
  const named = (k: string) => pairs.some(([p, v]) => p === k && v !== "")
  if (named("pr") && named("item"))
    throw new Refusal(
      "roster.ts: a checker takes pr= or item=, not both: pr= for a pull request, item= for an extension item it scores",
      2,
    )
}

// a call that parks a row, or clears a parked row's hold, leaves it holding one, so the sweep can tell its lead once the wait ends; a call that moves it off parked drops its hold, so a later park names a fresh one, and a hold named on a row the call leaves not parked is refused, so the caller sees why it would not stay. A row parked before this check keeps taking writes that leave its park alone.
function parkHold(entry: Agent, pairs: [string, string][], moved: boolean): void {
  const touched = moved || pairs.some(([k]) => k === "status" || k === "hold")
  if (entry.status !== "parked") {
    if (pairs.some(([k, v]) => k === "hold" && v !== ""))
      throw new Refusal(
        `roster.ts: hold names what a parked row waits on, and ${entry.name} is ${entry.status}, so add status=parked to the same call`,
        2,
      )
    if (touched) delete entry.hold
    return
  }
  if (touched && !entry.hold)
    throw new Refusal(
      `roster.ts: ${entry.name} is parked, so add hold=#<n>, hold=#i<n> or hold=d-<n> (the issue, PR, Inbox item or decision the park waits on) to the same call`,
      2,
    )
}

// A checker moved by halves keeps its old worker or pr, and the sidebar nests it under that worker's ended row; one given a new PR beside a worker that is unset or ended is ended by the checker reaper.
function checkRetask(
  roster: Roster,
  entry: Agent,
  pairs: [string, string][],
  factoryRepo: string,
  assign = false,
): void {
  const next: Agent = { ...entry }
  apply(next, pairs, factoryRepo)
  if (!isChecker(next)) return
  const moved = (k: string) => entry[k] !== undefined && next[k] !== entry[k]
  // A prs-= of the row's own pr clears it: clearing the PR a row served is not moving it, so the guard that moves a pr only through assign stays quiet
  const prClearedByPrs =
    typeof entry.pr === "string" &&
    next.pr === undefined &&
    prsWithdrawn(entry, pairs, factoryRepo).includes(entry.pr)
  const given = (k: string) => pairs.some(([p]) => p === k)
  // spawn.sh's restart of an ended checker names the PRs it serves now, prs and pr in one set
  const restart = entry.status === "ended" && given("prs")
  if (
    assign
      ? (entry.pr || entry.item) && (given("pr") || given("item")) !== given("worker")
      : (!prClearedByPrs && moved("pr") && !restart) || moved("worker") || given("item")
  )
    throw new Refusal(
      `roster.ts: ${entry.name} is a checker, so it moves to another PR through roster.ts assign ${entry.name} <title> <task> worker=<worker> pr=<url> [repo=<owner>/<name>], which sets its worker, pr, repo and title together, or item=<scope>/<kind>/<key> in place of pr= for an extension item`,
      1,
    )
  // the checker reaper ends a checker whose worker has gone (checker-worker-gone), so a new PR on a live row names a live worker
  const worker = next.worker as string | undefined
  const gone = !worker || roster.agents.find((a) => a.name === worker)?.status === "ended"
  const held = (entry.prs as string[] | undefined) ?? []
  const newPr =
    pairs.some(([k, v]) => (k === "prs" || k === "prs+") && v.trim()) ||
    ((next.prs as string[] | undefined) ?? []).some((u) => !held.includes(u)) ||
    (next.pr !== undefined && next.pr !== entry.pr)
  if (gone && newPr)
    throw new Refusal(
      `roster.ts: ${entry.name} is a checker whose worker ${worker ? `${worker} has ended` : "is not set"}, so the checker reaper would end it: give it the PR with roster.ts assign ${entry.name} <title> <task> worker=<live worker> pr=<n>`,
      1,
    )
}

// A reviewer moves a clone only on exit 1, so a roster that does not read exits 2, never 1.
async function holders(pr: string | undefined, rest: string[]): Promise<void> {
  if (!pr || rest.length || (!/^#?[1-9]\d*$/.test(pr) && !PR_URL_RE.test(pr)))
    throw new Refusal("roster.ts: holders takes one PR, its number or its URL", 2)
  const repo = PR_URL_RE.test(pr)
    ? ""
    : await factoryRepoOf().catch((error: Error) => {
        throw new Refusal(`roster.ts: ${error.message}`, 2)
      })
  const url = prUrl(pr, repo)
  const agents = await Bun.file(path)
    .json()
    .then((r: Roster) => (Array.isArray(r?.agents) ? r.agents : null))
    .catch(() => null)
  if (!agents) throw new Refusal(`roster.ts: the roster ${path} cannot be read`, 2)
  const { rowPullRequests } = await import("../packages/safe-delete/src/index")
  const names = agents
    .filter(
      (a) =>
        STATUSES.live.includes(String(a.status)) &&
        rowPullRequests({ pr: a.pr, prs: a.prs }).includes(url),
    )
    .map((a) => a.name)
  if (!names.length) throw new Refusal(`roster.ts: no live row holds ${url}`, 1)
  console.log(names.join("\n"))
}

async function main(argv: string[]): Promise<void> {
  const [cmd, name, ...rest] = argv
  // any other throw exits 1 under Bun, which reads as free, so holders turns it into 2
  if (cmd === "holders")
    return holders(name, rest).catch((error: Error) => {
      if (error instanceof Refusal) throw error
      throw new Refusal(`roster.ts: holders cannot read the roster ${path}: ${error.message}`, 2)
    })
  const known = ["assign", "backfill", "backlog", "backlog-done", "report", "set", "who"]
  if (!cmd || !known.includes(cmd) || (cmd !== "backfill" && !name)) throw new Refusal(USAGE, 2)
  if (cmd === "set" || cmd === "report" || cmd === "assign") checkName(cmd, name!)
  if (cmd === "who") {
    // the dispatcher takes a slot number, 1 (Alpha, the default) or 2 (Bravo), never a label, since labels can be renamed
    const slot = name === "dispatcher" && rest.length <= 1 ? (rest[0] ?? "1") : null
    const assistant = name === "assistant" && rest.length === 0
    if (!(isManagerKind(name) && rest.length === 0) && !assistant && slot !== "1" && slot !== "2")
      throw new Refusal(
        `roster.ts: who takes one of ${[...MANAGER_KINDS, "dispatcher [1|2]", "assistant"].join(", ")}`,
        2,
      )
    // A roster that does not read leaves today's name, so a spawn still has someone to report to.
    const agents = (await load().catch(() => null))?.agents
    // the assistant has no set name to fall back on, so a reader with no holder falls back on its own
    if (assistant) {
      const held = seatOf(agents, "assistant")
      if (!held) throw new Refusal("roster.ts: no live session holds the assistant seat", 1)
      console.log(held)
      return
    }
    console.log(
      isManagerKind(name) ? managerOf(agents, name) : dispatcherOf(agents, slot === "2" ? 2 : 1),
    )
    return
  }
  const roster = await load()
  // The PRs a prs-= withdrew, read back after the write to confirm the clear persisted.
  let withdrawn: string[] = []
  // A bare PR number links into factory.repo, read only when one is given.
  const factoryRepo = rest.some((word) => /^(?:pr|prs[+-]?)=(?:.*,)?#?[1-9]\d*(?:,|$)/.test(word))
    ? await factoryRepoOf().catch((error: Error) => {
        throw new Refusal(`roster.ts: ${error.message}`, 2)
      })
    : ""
  if (cmd === "set") {
    const pairs = pairsOf(rest)
    checkPairs(cmd, name!, pairs)
    const entry = agent(roster, name!, pairs)
    checkRetask(roster, entry, pairs, factoryRepo)
    // Captured before apply clears the row, so the read-back can confirm the clear persisted.
    withdrawn = prsWithdrawn(entry, pairs, factoryRepo)
    // A new task on an agent holding a pr would show the old PR beside it, so it goes through assign; a title alone renames the row.
    if (entry.pr && pairs.some(([k]) => k === "task"))
      throw new Refusal(
        `roster.ts: ${name} holds a pr, so a new task goes through roster.ts assign ${name} <title> <task>, which clears pr, branch, repo and lastReport`,
        1,
      )
    apply(entry, pairs, factoryRepo)
    // a prs+= of the same PR later in the call puts it back on purpose, so only what the call left removed is read back
    withdrawn = withdrawn.filter(
      (pr) => entry.pr !== pr && !((entry.prs as string[] | undefined) ?? []).includes(pr),
    )
    parkHold(entry, pairs, false)
  } else if (cmd === "report") {
    const [text, ...more] = rest
    if (text === undefined) throw new Refusal(USAGE, 2)
    const pairs = pairsOf(more)
    checkPairs(cmd, name!, pairs)
    const entry = agent(roster, name!, pairs)
    checkRetask(roster, entry, pairs, factoryRepo)
    entry.lastReport = text
    entry.lastReportAt = now()
    apply(entry, pairs, factoryRepo)
    parkHold(entry, pairs, false)
  } else if (cmd === "assign") {
    const [title, task, ...more] = rest
    if (title === undefined || task === undefined) throw new Refusal(USAGE, 2)
    const pairs = pairsOf(more)
    checkPairs(cmd, name!, pairs)
    const entry = agent(roster, name!, pairs, task)
    checkRetask(roster, entry, pairs, factoryRepo, true)
    // A checker keeps every PR it served in its prs list, and its next PR joins it, so auto-end holds it while any is open.
    const checker = isChecker(entry)
    const served =
      checker && entry.pr && !pairs.some(([k]) => PRS_KEYS.has(k)) ? [entry.pr as string] : []
    for (const k of [
      "pr",
      "endReason",
      "item",
      "branch",
      "repo",
      "lastReport",
      "lastReportAt",
      "eta",
      "ticket",
      "owner",
    ])
      delete entry[k]
    Object.assign(entry, { status: "working", task })
    apply(entry, [["title", title], ...pairs], factoryRepo)
    parkHold(entry, pairs, true)
    if (checker && (entry.pr || pairs.some(([k, v]) => (k === "pr" || k === "item") && v !== "")))
      entry.prs = [
        ...new Set([
          ...served,
          ...((entry.prs as string[] | undefined) ?? []),
          ...(entry.pr ? [entry.pr as string] : []),
        ]),
      ]
  } else if (cmd === "backlog") {
    if (rest.length > 0) throw new Refusal('usage: roster.ts backlog "<text>"', 2)
    roster.backlog = [...(roster.backlog ?? []), name!]
  } else if (cmd === "backlog-done") {
    const backlog = roster.backlog ?? []
    const [issue, ...extra] = rest
    const at = Number(name)
    if (!issue || !/^[1-9]\d*$/.test(issue))
      throw new Refusal(
        `roster.ts: backlog-done takes a positive issue number${issue ? `, not ${issue}` : ""}`,
        2,
      )
    if (extra.length > 0)
      throw new Refusal(
        `roster.ts: backlog-done takes one issue number, not also ${extra.join(" ")}`,
        2,
      )
    if (backlog.length === 0)
      throw new Refusal("roster.ts: backlog-done finds the backlog empty", 1)
    if (!/^(0|[1-9]\d*)$/.test(name!) || at >= backlog.length)
      throw new Refusal(
        `roster.ts: backlog-done takes an index from 0 to ${backlog.length - 1}, not ${name}`,
        2,
      )
    if (/^\[#[1-9]\d*\] /.test(backlog[at]!))
      throw new Refusal(`roster.ts: backlog entry ${at} is already marked: ${backlog[at]}`, 1)
    backlog[at] = `[#${issue}] ${backlog[at]}`
  } else {
    for (const entry of roster.agents) {
      const kind = kindOfName(entry.name)
      if (entry.kind === undefined && kind) entry.kind = kind
    }
  }
  roster.updatedAt = now()
  await writeAtomic(path, JSON.stringify(roster, null, 2))
  // A prs-= cleared pr and prs in memory, so the row read back must show the clear; a still-present PR means the write-back left the row holding what the call just removed.
  await clearedOnRead(cmd, name, withdrawn)
}

if (import.meta.main) {
  try {
    loadSessionNames()
    await main(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    console.error(err.message)
    process.exit(err.code)
  }
}
