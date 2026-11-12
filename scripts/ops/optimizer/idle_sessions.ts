#!/usr/bin/env bun
// idle_sessions.ts [hours]: live sessions that run with nothing to do, with each one's measured Claude spend over the last N hours (default 1).
// Ported from ~/.playground/ops/optimizer/idle_sessions.py; a session's PRs are its roster pr and prs list, its worker's, every open one on its branch and every one its transcript links, so a checker serving a second PR is never listed while that one is open.
// Flags, from Claude's session registry (live pid, status, statusUpdatedAt), roster.json and GitHub REST reads per PR (an open PR cached 5 minutes, a merged or closed one for good):
// Every flag needs 10+ minutes not busy, so a session finishing a step is never listed. ops-tick's auto-end beat ends what auto_end.ts takes of it.
//   checker-worker-gone  a reviewer or tester whose worker has no live session, with no open PR a live worker serves among its PRs
//   checker-pr-done      a reviewer or tester whose PRs are all merged or closed
//   checker-nothing      a reviewer or tester not busy for 30+ minutes whose every PR head carries its verdict or is closed
//   worker-prs-done      a worker whose roster holds a pr, whose PRs are all merged or closed, and whose /pull/ PR that closed last merged
//   worker-pr-closed     a worker whose /pull/ PR that closed last closed unmerged; its lead is asked to reassign or end it
//   roster-says-<status> any session whose roster entry reads paused or ended
// A session whose status is `shell` (a background command still running) is not busy, and is marked `+bg`, since its watcher keeps waking it.
// Prints one line per flagged session and a total; reads only, signals nothing.

import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { costOf } from "../../../api/hono/src/lib/usage/prices"
import { kindOf } from "../../../packages/config/src/kinds"
import { verdictsOf } from "../../../packages/config/src/verdicts"
import { dataDirOf } from "../../../packages/env/src/data-dir"

const CACHE_TTL_S = 300

const PR_URL = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/
// A checker's prs list names a PR not yet opened by its issue, which reads open until the PR that closes it merges.
const ISSUE_URL = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/

export type RegistryEntry = {
  cwd?: string
  name?: string
  pid?: number
  sessionId?: string
  status?: string
  statusUpdatedAt?: number
  updatedAt?: number
}

export type RosterEntry = {
  kind?: string
  lead?: string
  name?: string
  pr?: string
  // every PR a checker serves, its pr among them, or an issue whose PR is not yet opened
  prs?: string[]
  repo?: string
  status?: string
  worker?: string
}

export type PrState = {
  closedAt?: string
  head: string
  mergeSha?: string
  mergedAt?: string
  ref?: string
  state: string
  verdicts: string[]
}

export type Row = {
  donePr?: string
  kind: string | null
  lead?: string
  name: string
  quiet: number
  refs: string[]
  sessionId?: string
  sha?: string
  status: string
  usd: number
  why: string[]
  worker?: string
}

export type CollectInput = {
  hours: number
  linkedPrs?: (sessionId: string) => Promise<string[]>
  now: number
  prState: (url: string) => Promise<PrState | null>
  projectsDir?: string
  roster: Record<string, RosterEntry>
  sessions: Record<string, RegistryEntry>
  workerPrs: (worker: string) => Promise<string[]>
}

// A session's PRs: its roster prs list, its roster pr and open branch PRs, its worker's, and every PR its own or its worker's transcript links.
export async function sessionPrs(
  input: CollectInput,
  name: string,
  worker?: string,
  sessionId?: string,
): Promise<string[]> {
  const { linkedPrs, roster, sessions, workerPrs } = input
  const workerSession = worker ? sessions[worker]?.sessionId : undefined
  return [
    ...new Set([
      ...(roster[name]?.prs ?? []),
      ...(await workerPrs(name)),
      ...(worker ? await workerPrs(worker) : []),
      ...(sessionId && linkedPrs ? await linkedPrs(sessionId) : []),
      ...(workerSession && linkedPrs ? await linkedPrs(workerSession) : []),
    ]),
  ]
}

// True when a live worker session serves an open PR of the list, as workerPrs (its roster pr and open branch PRs) reads them; called only once the checker's own worker is found gone, each worker's PRs once per call.
export async function servesLiveWorker(input: CollectInput, open: string[]): Promise<boolean> {
  if (open.length === 0) return false
  const { roster, sessions, workerPrs } = input
  for (const w of Object.keys(sessions)) {
    if (kindOf(w, roster[w]?.kind) !== "worker") continue
    const served = await workerPrs(w)
    if (open.some((url) => served.includes(url))) return true
  }
  return false
}

type Usage = {
  cache_creation?: { ephemeral_1h_input_tokens?: number }
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  input_tokens?: number
  output_tokens?: number
}

type AssistantLine = {
  message?: { id?: string; model?: string; usage?: Usage }
  timestamp?: string
  type?: string
}

// The py's per-line arithmetic, priced by the repo's table: a model it lacks costs nothing.
function lineCost(line: string, windowStart: number, seen: Set<string | undefined>): number {
  let d: AssistantLine
  let t: number
  try {
    d = JSON.parse(line) as AssistantLine
    t = new Date(d.timestamp ?? "").getTime() / 1000
  } catch {
    return 0
  }
  if (!Number.isFinite(t) || t < windowStart) return 0
  if (d.type !== "assistant") return 0
  const m = d.message ?? {}
  const u = m.usage ?? {}
  const cost = costOf(m.model ?? "", {
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  })
  if (cost === null || seen.has(m.id)) return 0
  seen.add(m.id)
  return cost
}

// One session's measured spend over the window, from its transcript and its subagents' ones.
export async function spend(
  sessionId: string,
  hours: number,
  now: number,
  projectsDir: string,
): Promise<number> {
  const windowStart = now - hours * 3600
  const seen = new Set<string | undefined>()
  let usd = 0
  for (const pattern of [`*/${sessionId}.jsonl`, `*/${sessionId}/subagents/*.jsonl`]) {
    let files: string[] = []
    try {
      files = [...new Bun.Glob(pattern).scanSync({ cwd: projectsDir, onlyFiles: true })]
    } catch {
      continue
    }
    for (const rel of files) {
      try {
        const f = Bun.file(join(projectsDir, rel))
        if (f.lastModified < windowStart * 1000) continue
        for (const line of (await f.text()).split("\n")) {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
          usd += lineCost(line, windowStart, seen)
        }
      } catch {}
    }
  }
  return usd
}

// A checker's worker: its roster link, else worker-<sin> for an old reviewer-<sin> name; an <id>-<kind> checker has an id of its own, so its name names none.
export function workerOf(name: string, linked?: string): string | undefined {
  if (linked) return linked
  const sin = /^(?:reviewer|tester)-(.+)$/.exec(name)?.[1]
  return sin ? `worker-${sin}` : undefined
}

// The pure core: no network, no filesystem, no signals. Every input is injected.
export async function collect(input: CollectInput): Promise<Row[]> {
  const { hours, linkedPrs, now, prState, projectsDir, roster, sessions, workerPrs } = input
  const rows: Row[] = []
  for (const name of Object.keys(sessions).sort()) {
    const d = sessions[name]
    const status = d.status || "?"
    if (status === "busy") continue
    const quiet = (now - (d.statusUpdatedAt || d.updatedAt || now * 1000) / 1000) / 60
    if (!Number.isFinite(quiet) || quiet < 10) continue
    const r = roster[name] ?? {}
    const why: string[] = []
    if (r.status && ["ended", "paused"].includes(r.status)) why.push(`roster-says-${r.status}`)
    // A checker by the roster's kind, else by its name; its worker by the roster's link, else by the sin an old reviewer-<sin> or tester-<sin> name carries, since an <id>-<kind> name carries none.
    const kind = kindOf(name, r.kind)
    const checker = kind === "reviewer" || kind === "tester"
    const worker = checker ? workerOf(name, r.worker) : undefined
    let refs: string[] = []
    let donePr: string | undefined
    let sha: string | undefined
    if (checker || kind === "worker") {
      const prs = await sessionPrs(input, name, worker, d.sessionId)
      const states = await Promise.all(prs.map((url) => prState(url)))
      const open = states.flatMap((s, i) => (s?.state === "open" ? [prs[i]] : []))
      if (
        worker &&
        !(worker in sessions) &&
        !Object.keys(sessions).some((s) => s.startsWith("worker-") && s.startsWith(worker)) &&
        !(await servesLiveWorker(input, open))
      )
        why.push(`checker-worker-gone (${worker})`)
      refs = states.flatMap((s) => (s?.ref ? [s.ref] : []))
      // The PR that closed last decides the end, a merge by its merged_at and a close by its closed_at, so an older merged PR never names a newer close: a state with no merged_at or closed_at sorts oldest, and a tie keeps the later in the list.
      let newest: number | undefined
      let newestAt: string | undefined
      states.forEach((s, i) => {
        // An issue URL never counts as the last close: GitHub closes a PR's issue a beat after its merge, and the PR it closes decides instead.
        if (!PR_URL.test(prs[i] ?? "")) return
        const at =
          s?.state === "merged"
            ? (s.mergedAt ?? "")
            : s?.state === "closed"
              ? (s.closedAt ?? "")
              : undefined
        if (at === undefined) return
        if (newest === undefined || at >= (newestAt ?? "")) {
          newest = i
          newestAt = at
        }
      })
      if (newest !== undefined) {
        donePr = PR_URL.exec(prs[newest] ?? "")?.[2]
        if (states[newest]?.state === "merged") sha = states[newest]?.mergeSha
      }
      const done = states.every((s) => s !== null && (s.state === "merged" || s.state === "closed"))
      // The PR that closed last names the how alone: a worker whose last close was a close is kept and its lead asked, not ended.
      const how = newest !== undefined && states[newest]?.state === "merged" ? "merged" : "closed"
      // A worker only while its roster holds a pr: one with none sits between chores, since assign clears it.
      if (states.length > 0 && done && (checker || r.pr)) {
        if (checker) why.push(`checker-pr-done (${how})`)
        else if (how === "merged") why.push("worker-prs-done (merged)")
        else why.push(`worker-pr-closed (closed${donePr ? ` #${donePr}` : ""})`)
      } else if (
        checker &&
        quiet >= 30 &&
        states.length > 0 &&
        states.every(
          (s) =>
            s !== null && (s.state === "closed" || s.verdicts.some((v) => s.head.startsWith(v))),
        )
      )
        why.push("checker-nothing (head scored)")
    }
    if (why.length === 0) continue
    rows.push({
      donePr,
      kind,
      lead: r.lead ?? (worker ? roster[worker]?.lead : undefined),
      name,
      quiet,
      refs,
      sessionId: d.sessionId,
      sha,
      status,
      usd: d.sessionId && projectsDir ? await spend(d.sessionId, hours, now, projectsDir) : 0,
      why,
      worker,
    })
  }
  return rows
}

export function formatRow(row: Row, hours: number): string {
  const col = row.status === "shell" ? "+bg" : "   "
  return `${row.name.padEnd(28)} ${col} quiet ${String(Math.round(row.quiet)).padStart(5)}m  $${row.usd.toFixed(2).padStart(5)}/${hours}h  ${row.why.join(", ")}`
}

export function formatTotal(rows: Row[], hours: number): string {
  const usd = rows.reduce((sum, r) => sum + r.usd, 0)
  return `${rows.length} idle with nothing to do; $${usd.toFixed(2)} over the last ${hours}h`
}

// The wiring below is the only code that touches the machine.

export async function liveSessions(dir: string): Promise<Record<string, RegistryEntry>> {
  const out: Record<string, RegistryEntry> = {}
  let files: string[] = []
  try {
    files = [...new Bun.Glob("*.json").scanSync({ cwd: dir, onlyFiles: true })]
  } catch {
    return out
  }
  for (const file of files) {
    try {
      const d = JSON.parse(await Bun.file(join(dir, file)).text()) as RegistryEntry
      process.kill(Number(d.pid), 0)
      if (d.name) out[d.name] = d
    } catch {}
  }
  return out
}

export async function readRoster(path: string): Promise<Record<string, RosterEntry>> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as { agents?: RosterEntry[] }
    const out: Record<string, RosterEntry> = {}
    for (const a of parsed.agents ?? []) if (a.name) out[a.name] = a
    return out
  } catch {
    return {}
  }
}

async function ghApi(path: string): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", path], { stderr: "ignore", stdout: "pipe", timeout: 30_000 })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

type CachedState = PrState & { at: number }

async function readCache(path: string): Promise<Record<string, CachedState>> {
  try {
    return JSON.parse(await Bun.file(path).text()) as Record<string, CachedState>
  } catch {
    return {}
  }
}

export async function prStateLive(
  url: string,
  now: number,
  cachePath: string,
  api: (path: string) => Promise<unknown> = ghApi,
): Promise<CachedState | null> {
  const m = PR_URL.exec(url ?? "")
  const issue = ISSUE_URL.exec(url ?? "")
  if (!m && !issue) return null
  const cache = await readCache(cachePath)
  const hit = cache[url]
  // Only merged is final: go.py closes a PR and reopens it to rebuild its merge commit.
  if (hit && (hit.state === "merged" || now - hit.at < CACHE_TTL_S)) return hit
  const remember = async (fresh: CachedState) => {
    cache[url] = fresh
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      await Bun.write(cachePath, JSON.stringify(cache))
    } catch {}
    return fresh
  }
  if (!m) {
    const read = (await api(`repos/${issue![1]}/issues/${issue![2]}`)) as { state?: string } | null
    return read?.state ? remember({ at: now, head: "", state: read.state, verdicts: [] }) : null
  }
  const pr = (await api(`repos/${m[1]}/pulls/${m[2]}`)) as {
    closed_at?: string | null
    comments?: number
    head?: { ref?: string; sha?: string }
    merge_commit_sha?: string | null
    merged_at?: string | null
    state?: string
  } | null
  if (!pr?.state || !pr.head?.sha) return null
  const state = pr.merged_at ? "merged" : pr.state
  // A merged or closed PR needs no verdicts, so it costs one read; a merged one stays cached.
  const verdicts: string[] = []
  if (state === "open") {
    const page = Math.max(1, Math.ceil((pr.comments ?? 0) / 100))
    const comments = (await api(
      `repos/${m[1]}/issues/${m[2]}/comments?per_page=100&page=${page}`,
    )) as { body?: string }[] | null
    // a checker's verdict: the reviewer's score, or the tester's word
    for (const c of comments ?? []) for (const v of verdictsOf(c.body ?? "")) verdicts.push(v.at)
  }
  return remember({
    at: now,
    closedAt: pr.closed_at || undefined,
    head: pr.head.sha,
    mergeSha: (pr.merged_at && pr.merge_commit_sha) || undefined,
    mergedAt: pr.merged_at || undefined,
    ref: pr.head.ref,
    state,
    verdicts,
  })
}

async function gitIn(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stderr: "ignore", stdout: "pipe" })
  const out = (await new Response(proc.stdout).text()).trim()
  return (await proc.exited) === 0 && out ? out : null
}

async function originRepo(cwd: string): Promise<string | null> {
  const url = await gitIn(cwd, ["remote", "get-url", "origin"])
  const m = url ? /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) : null
  return m ? `${m[1]}/${m[2]}` : null
}

// The worker's roster pr, plus every open PR on the worker session's current branch.
async function workerPrsLive(
  worker: string,
  sessions: Record<string, RegistryEntry>,
  roster: Record<string, RosterEntry>,
): Promise<string[]> {
  const r = roster[worker] ?? {}
  const urls = r.pr ? [r.pr] : []
  const cwd = sessions[worker]?.cwd
  if (cwd) {
    const repo = r.repo ?? (await originRepo(cwd))
    const branch = await gitIn(cwd, ["branch", "--show-current"])
    const owner = repo?.split("/")[0]
    if (repo && branch && owner) {
      const prs = await ghApi(`repos/${repo}/pulls?head=${owner}:${branch}`)
      if (Array.isArray(prs)) {
        for (const pr of prs as { html_url?: string; state?: string }[])
          if (pr.state === "open" && pr.html_url) urls.push(pr.html_url)
      }
    }
  }
  return [...new Set(urls)]
}

// Every PR the session's transcript links (Claude Code's pr-link lines), oldest first.
export async function linkedPrsLive(sessionId: string, projectsDir: string): Promise<string[]> {
  const urls: string[] = []
  try {
    for (const rel of new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: projectsDir })) {
      for (const line of (await Bun.file(join(projectsDir, rel)).text()).split("\n")) {
        if (!line.includes('"pr-link"')) continue
        const url = (JSON.parse(line) as { prUrl?: string }).prUrl
        if (url && PR_URL.test(url)) urls.push(url)
      }
    }
  } catch {}
  return [...new Set(urls)]
}

// The live machine's inputs: Claude's registry, the roster, GitHub through the PR cache and the transcripts.
export async function liveInput(hours: number, now: number): Promise<CollectInput> {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  const lw = dataDirOf(process.env)
  const projectsDir = join(configDir, "projects")
  const sessions = await liveSessions(join(configDir, "sessions"))
  const roster = await readRoster(join(lw, "roster.json"))
  const cachePath = join(lw, "ops", "optimizer", "pr-cache.json")
  return {
    hours,
    linkedPrs: (sessionId) => linkedPrsLive(sessionId, projectsDir),
    now,
    prState: (url) => prStateLive(url, now, cachePath),
    projectsDir,
    roster,
    sessions,
    workerPrs: (worker) => workerPrsLive(worker, sessions, roster),
  }
}

async function main(argv: string[]): Promise<number> {
  const hours = argv[0] === undefined ? 1 : Number(argv[0])
  if (!Number.isFinite(hours)) {
    console.error("usage: bun scripts/ops/optimizer/idle_sessions.ts [hours]")
    return 2
  }
  const rows = await collect(await liveInput(hours, Date.now() / 1000))
  for (const row of rows) console.log(formatRow(row, hours))
  console.log(formatTotal(rows, hours))
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
