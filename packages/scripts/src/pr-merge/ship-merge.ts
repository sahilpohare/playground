// ship:merge <n>: merges the ship PR into main with a merge commit at its head, only when its body holds the pin's gate line (or its waiver by the owner's Inbox go) and rehearsal line, both gate checks are green there, and the ship's freeze names the next version.

import { rowOfAnswer } from "@packages/config/inbox"
import { dataDir } from "@packages/env/data-dir"
import { readSessionNames } from "@packages/settings"

import { ciGate, REQUIRED_CHECKS, type Check } from "./gates"
import { freezeLine, freezeStatus, heldPath } from "./held"
import { gh, repoOf, runGh, type Run } from "./merge"
import { gateLine, REHEARSAL_RESULTS, rehearsalLine, WAIVER_LABEL, waiverLine } from "./ship-lines"

// An Inbox item as playground ask get prints it: the fields a waiver reads.
export type InboxItem = {
  answer?: { choice?: string; option?: number; options?: number[]; [key: string]: unknown }
  from?: string
  id?: string
  kind?: string
  preview?: {
    approve?: string
    options?: { label: string }[]
    questions?: unknown[]
    text?: string
    type?: string
  }
  status?: string
  title?: string
}

export type ShipFacts = {
  base: string
  body: string
  checks: Check[]
  // The Inbox decision the body's waiver line for the head names, or why it did not read; null when the body holds no such line.
  decision: InboxItem | string | null
  // The dispatcher's session name, sessions.names' own, the one sender a waiver's decision may come from.
  dispatcher: string
  // The `"*"` line while it holds, null when none is set or it has lapsed.
  freeze: string | null
  head: string
  state: string
  // The version this ship tags: the last tag's patch plus one.
  version: string
}

// An Inbox id as playground ask get takes it, a uuid or #iN, so a waiver line passes no flag to it.
const INBOX_ID = /^(#i\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

const bodyLines = (body: string) => new Set(body.split(/\r?\n/).map((line) => line.trim()))

// Pure: the Inbox id the body's waiver line for this head names, else null.
export function waiverId(body: string, head: string): string | null {
  const prefix = waiverLine(head, "")
  for (const line of bodyLines(body)) {
    const id = line.startsWith(prefix) ? line.slice(prefix.length) : ""
    if (INBOX_ID.test(id)) return id
  }
  return null
}

// Pure: why the decision a waiver names does not skip this ship's gate: the dispatcher's decision, the owner's Approve (only the owner's own answer sets approved, .agents/dashboard/asks.md), on the row labelled WAIVER_LABEL, for this version.
function waiverRefusals(
  id: string,
  item: InboxItem | string | null,
  version: string,
  dispatcher: string,
): string[] {
  const at = `gate: Inbox ${id}`
  if (item === null || typeof item === "string")
    return [`${at} did not read (${item ?? "not read"})`]
  const refusals: string[] = []
  if (item.kind !== "decision") refusals.push(`${at} is a ${item.kind}, not a decision`)
  if (item.from !== dispatcher) refusals.push(`${at} is from ${item.from}, not ${dispatcher}`)
  if (item.status !== "approved")
    refusals.push(`${at} reads ${item.status}, not approved by the owner`)
  const words = `${item.title ?? ""}\n${item.preview?.text ?? ""}`
  const named = new RegExp(`(?<![\\w.])${version.replaceAll(".", "\\.")}(?!\\w|\\.\\d)`)
  if (!named.test(words)) refusals.push(`${at} names no ${version} in its title or text`)
  if (item.status !== "approved") return refusals
  const { approve, options, questions, type } = item.preview ?? {}
  const { choice, option } = item.answer ?? {}
  if (questions || item.answer?.options)
    refusals.push(`${at} is a multi-question ask: a waiver takes a single-question decision`)
  else if (choice !== "approve")
    refusals.push(`${at} was approved by ${choice}, whose own words name no row`)
  // The row the owner's Approve picked, read as the Inbox reads it; a decision whose rows its poster did not write has no waiver row.
  else if (type !== "ask" || !(options || approve))
    refusals.push(`${at} has no "${WAIVER_LABEL}" row: its poster wrote none`)
  else {
    const label = rowOfAnswer({ approve, options, type }, { choice, option })?.label ?? ""
    if (label.trim() !== WAIVER_LABEL)
      refusals.push(`${at} approved option ${option ?? 0} "${label}", not "${WAIVER_LABEL}"`)
  }
  return refusals
}

// Pure: why the ship PR may not merge, one line each; none means it may.
export function shipRefusals(facts: ShipFacts): string[] {
  const refusals: string[] = []
  if (facts.state !== "OPEN" || facts.base !== "main")
    refusals.push(
      `pr: it is ${facts.state.toLowerCase()} into ${facts.base}: ship:merge merges an open ship PR into main`,
    )
  const lines = bodyLines(facts.body)
  const pass = gateLine(facts.head, false)
  const fail = gateLine(facts.head, true)
  if (lines.has(fail))
    refusals.push(
      `gate: the body holds "${fail}": a FAIL holds the ship, by the ship skill's step 1 line for a ship that stops`,
    )
  else if (!lines.has(pass)) {
    const id = waiverId(facts.body, facts.head)
    if (id) refusals.push(...waiverRefusals(id, facts.decision, facts.version, facts.dispatcher))
    else
      refusals.push(
        `gate: the body holds no "${pass}" line nor a "${waiverLine(facts.head, "<id>")}" line: run bun run gate:new-user ${facts.head} and write its last line into the body on a line of its own, or name the owner's approved Inbox decision that skips it`,
      )
  }
  if (!REHEARSAL_RESULTS.some((result) => lines.has(rehearsalLine(facts.head, result))))
    refusals.push(
      `rehearsal: the body holds no ${REHEARSAL_RESULTS.map((r) => `"${rehearsalLine(facts.head, r)}"`).join(" or ")} line, on a line of its own`,
    )
  const gateChecks = facts.checks.filter((check) => REQUIRED_CHECKS.includes(check.name ?? ""))
  const ci = ciGate(gateChecks, { required: REQUIRED_CHECKS })
  if (!ci.ok) refusals.push(`ci: ${ci.detail}`)
  if (facts.freeze !== freezeLine(facts.version))
    refusals.push(
      `freeze: ${facts.freeze ? `the "*" line reads "${facts.freeze}"` : 'no "*" line holds'}, so run bun run ship:freeze ${facts.version} (the ship skill's step 1)`,
    )
  return refusals
}

// Pure: the version after a tag, its patch plus one.
export function nextVersion(tag: string): string {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (!match) throw new Error(`the last tag ${tag || "(none)"} is not vX.Y.Z`)
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

// Runs playground with these arguments, whose verbs read the live Dashboard's Inbox; a test hands in a stub.
export const runPlayground: Run = async (args) => {
  const proc = Bun.spawn(["playground", ...args], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stderr, stdout }
}

// The Inbox item playground ask get prints, else why it did not read: its stderr less bun run's own command line.
async function readItem(ask: Run, id: string): Promise<InboxItem | string> {
  const said = `playground ask get ${id}`
  try {
    const { code, stderr, stdout } = await ask(["ask", "get", id])
    if (code !== 0) {
      const why = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("$ "))
        .join("; ")
      return `${said} exited ${code}: ${why}`
    }
    return JSON.parse(stdout.slice(stdout.indexOf("{"))) as InboxItem
  } catch (error) {
    return `${said}: ${(error as Error).message}`
  }
}

export async function shipFactsOf(
  run: Run,
  repo: string,
  n: number,
  now = Date.now(),
  ask: Run = runPlayground,
): Promise<ShipFacts> {
  const view = JSON.parse(
    await gh(run, [
      "pr",
      "view",
      String(n),
      "-R",
      repo,
      "--json",
      "baseRefName,body,headRefOid,state,statusCheckRollup",
    ]),
  ) as {
    baseRefName: string
    body: string | null
    headRefOid: string
    state: string
    statusCheckRollup: Check[] | null
  }
  const tag = await gh(run, ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"])
  const status = await freezeStatus(heldPath(), now)
  const id = waiverId(view.body ?? "", view.headRefOid)
  return {
    base: view.baseRefName,
    body: view.body ?? "",
    checks: view.statusCheckRollup ?? [],
    decision: id ? await readItem(ask, id) : null,
    dispatcher: readSessionNames(dataDir()).names.dispatcher,
    freeze: status && !status.lapsed ? status.line : null,
    head: view.headRefOid,
    state: view.state,
    version: nextVersion(tag),
  }
}

// Reads the ship PR, and merges it at exactly the head it read when nothing refuses: `--match-head-commit` refuses if the head moved since.
export async function shipMerge(
  run: Run,
  repo: string,
  n: number,
  ask: Run = runPlayground,
): Promise<{ refusals: string[] } | { sha: string }> {
  const facts = await shipFactsOf(run, repo, n, Date.now(), ask)
  const refusals = shipRefusals(facts)
  if (refusals.length > 0) return { refusals }
  await gh(run, [
    "pr",
    "merge",
    String(n),
    "-R",
    repo,
    "--merge",
    "--match-head-commit",
    facts.head,
  ])
  const sha = await gh(run, [
    "pr",
    "view",
    String(n),
    "-R",
    repo,
    "--json",
    "mergeCommit",
    "--jq",
    ".mergeCommit.oid",
  ])
  return { sha }
}

const USAGE = `Usage: bun run ship:merge <n>

Merges ship PR <n> into main with a merge commit at its head, the ship skill's step 3, and refuses,
naming each reason, unless its body holds the new-user gate's PASS line (or its waiver line naming
an Inbox decision the owner approved to skip it for this version) and the invitee rehearsal's line
for that head, Audit, Lint, and Build and test are green there, and ship:freeze holds the
next version.`

if (import.meta.main) {
  const [arg = "", ...rest] = process.argv.slice(2)
  if (!/^\d+$/.test(arg) || rest.length > 0) {
    console.log(USAGE)
    process.exit(arg === "-h" || arg === "--help" ? 0 : 1)
  }
  try {
    const repo = await repoOf(runGh)
    const outcome = await shipMerge(runGh, repo, Number(arg))
    if ("refusals" in outcome) {
      console.error(
        `ship:merge: #${arg} not merged:\n${outcome.refusals.map((r) => `- ${r}`).join("\n")}`,
      )
      process.exit(1)
    }
    console.log(`ship:merge: merged #${arg} at ${outcome.sha}`)
  } catch (error) {
    console.error(`ship:merge: ${(error as Error).message}`)
    process.exit(1)
  }
}
