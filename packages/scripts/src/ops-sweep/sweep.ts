import { appendFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { kindOf, placedKindOf, SDK_PROBE } from "@packages/config/kinds"
import { type SshLaunch, sshLaunchOf, sshProcessOf } from "@packages/config/ssh-probe"
import { verdictOf } from "@packages/config/verdicts"
import { accountKey, accountSettings, accountsOf, readPolicy, RETIRED } from "@packages/settings"

import STATUSES from "../../../../scripts/roster-statuses.json"
import { leadName } from "../ops-session-resume/resume"
import { factoryRepoOf } from "../playground/setting"
import { writeAtomic } from "../write-atomic"

export type Run = (
  argv: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
) => Promise<{ code: number; err: string; out: string }>

// cfg is Claude Code's config folder, data the factory's folder in it, ops the ops jobs' state, dashboard the live dashboard's checkout, main the main checkout, repo the checkout this job runs from, factory the factory's GitHub repository (factory.repo by default), and herdr a read of herdr's CLI on one server.
export type Context = {
  cfg: string
  data: string
  dashboard: string
  factory?: () => Promise<string>
  herdr?: (server: string, args: string[]) => Promise<string>
  load: () => number
  main: string
  now: () => number
  ops: string
  repo: string
  run: Run
}

type Json = Record<string, unknown>

// Under one 300-second sweep, so the pass after a conflict's first sighting tells it.
export const CONFLICT_AFTER = 240
export const HEADROOM = 85
export const IDLE_DB_AFTER = 7200
export const IDLE_DB_GAP = 900
export const NO_PR_AFTER = 900
export const PACE_OFF_FOR = 3600
export const PRUNE_EVERY = 21600
export const REPEATS = 4
export const REVIEWER_LATE = 1200
export const STALE_EVERY = 14_400
export const STALL_AFTER = 1800

const IDLE_SQL =
  "select count(*) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()"
const PRUNES = [
  ["docker", "volume", "prune", "-f"],
  ["docker", "builder", "prune", "-f", "--filter", "until=24h"],
]
// The usage rule's least span of an account's week readings for a forecast, since each is a whole percent.
const WEEK_SPAN = 10800
const WINDOWS = [
  ["5h", "f5", "r5", 3600, 1200],
  ["7d", "s7", "r7", 10800, 3600],
] as const

const here = (ctx: Context) => join(ctx.ops, "sweep")
const seconds = (ctx: Context) => ctx.now() / 1000
const stamp = (ctx: Context) => `${new Date(ctx.now()).toISOString().slice(0, 19)}Z`
const notifyArgv = (ctx: Context, text: string) => [
  "bash",
  join(ctx.repo, "scripts", "ops", "notify.sh"),
  "sweep",
  text,
]
const dashboardAsk = (ctx: Context, ...args: string[]) => [
  "bun",
  "run",
  "--silent",
  "--cwd",
  ctx.dashboard,
  "ask",
  ...args,
]

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await Bun.file(path).text()) as T
  } catch {
    return fallback
  }
}

const numbers = (value: unknown): Record<string, number> =>
  value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "number"))
    : {}

const alive = (pid: unknown) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Each live session's status by its name, from Claude Code's registry.
export async function registry(ctx: Context): Promise<Map<string, string>> {
  const dir = join(ctx.cfg, "sessions")
  const live = new Map<string, string>()
  for (const file of await readdir(dir).catch(() => [])) {
    if (!file.endsWith(".json")) continue
    const d = await readJson<Json | null>(join(dir, file), null)
    if (d && typeof d.name === "string" && d.name && alive(d.pid))
      live.set(d.name, typeof d.status === "string" ? d.status : "")
  }
  return live
}

// An --ssh probe's claude runs on the far box, out of this machine's registry, so it counts live while any pane labelled with its name still runs ssh, by the rule the Dashboard's live list shares (sshLaunchOf, sshProcessOf); one pane list a server, read only when such a probe is unended.
export async function sshLive(ctx: Context, names: string[]): Promise<string[]> {
  const byServer = new Map<string, SshLaunch[]>()
  for (const name of names) {
    const launch = sshLaunchOf(
      await Bun.file(join(ctx.data, "resume", `${name}.sh`))
        .text()
        .catch(() => ""),
    )
    if (launch?.name === name)
      byServer.set(launch.server, [...(byServer.get(launch.server) ?? []), launch])
  }
  if (!ctx.herdr || !byServer.size) return []
  const herdr = ctx.herdr
  const read = async (server: string, args: string[]): Promise<Json> => {
    try {
      return JSON.parse(await herdr(server, args)) as Json
    } catch {
      return {}
    }
  }
  const out: string[] = []
  for (const [server, launches] of byServer) {
    const result = (await read(server, ["pane", "list"])).result as Json | undefined
    const panes = (Array.isArray(result?.panes) ? result.panes : []) as Json[]
    for (const launch of launches) {
      for (const { label, pane_id: pane } of panes) {
        if (label !== launch.name || typeof pane !== "string") continue
        const info = (await read(server, ["pane", "process-info", "--pane", pane])).result as
          | { process_info?: { foreground_processes?: { argv?: string[] }[] } }
          | undefined
        const processes = info?.process_info?.foreground_processes ?? []
        if (sshProcessOf(launch, server, { label: launch.name, processes })) {
          out.push(launch.name)
          break
        }
      }
    }
  }
  return out
}

// Records a usage sample, then projects each window to its reset from the recent rate (5h: the last hour, 7d: the last 3 hours).
export async function forecast(ctx: Context): Promise<Record<string, number>> {
  const samples = join(here(ctx), "usage-samples.jsonl")
  let s: Json
  let rows: Json[]
  try {
    const rl = JSON.parse(await Bun.file(join(ctx.data, "usage.json")).text()).rate_limits
    s = {
      // an account with no 5-hour window (usage.json leaves it out) projects its week alone
      f5: rl.five_hour?.used_percentage,
      r5: rl.five_hour?.resets_at,
      r7: rl.seven_day.resets_at,
      s7: rl.seven_day.used_percentage,
      t: Math.floor(seconds(ctx)),
    }
    await appendFile(samples, `${JSON.stringify(s)}\n`)
    rows = (await Bun.file(samples).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json)
  } catch {
    return {}
  }
  const t = s.t as number
  const out: Record<string, number> = {}
  for (const [key, u, r, look, need] of WINDOWS) {
    const used = s[u]
    const reset = s[r]
    // a window with no reset time (Anthropic sends null once a 5-hour window has reset at 0%) has nothing to project to
    if (typeof used !== "number" || typeof reset !== "number") continue
    const first = rows.find((x) => x[r] === reset && (x.t as number) >= t - look)
    if (!first || typeof first[u] !== "number") continue
    const span = t - (first.t as number)
    if (span < need || reset - t < 600) continue
    const rate = (used - first[u]) / span
    out[key] = Math.round((used + rate * (reset - t)) * 10) / 10
  }
  return out
}

// The accounts login-flip.py's split gives a share of new sessions while it is under 30 minutes old, as spawn.sh reads it, else usage.json's account; each by its usage.accounts label, else `account <n>` by its row, else `unlisted <n>` in the order met, never its address.
const pickable = async (ctx: Context): Promise<Map<string, string>> => {
  const policy = await readPolicy(ctx.data)
  const rows =
    policy.refusal === undefined
      ? accountsOf(accountSettings.get(policy.settings, "usage.accounts"), "claude")
      : []
  let unlisted = 0
  const labelOf = (account: string) => {
    const at = rows.findIndex((row) => accountKey(row).toLowerCase() === account)
    return at === -1 ? `unlisted ${++unlisted}` : (rows[at]!.label ?? `account ${at + 1}`)
  }
  const split = (await readJson<Json>(join(ctx.ops, "usage", "login-flip.json"), {})).split as Json
  const shares =
    typeof split?.at === "number" && seconds(ctx) - split.at < 1800 ? split.shares : null
  const picked =
    shares && typeof shares === "object"
      ? Object.entries(shares).flatMap(([a, share]) => (Number(share) > 0 ? [a] : []))
      : [(await readJson<Json>(join(ctx.data, "usage.json"), {})).account].filter(
          (a): a is string => typeof a === "string",
        )
  return new Map(picked.map((a) => [a.toLowerCase(), labelOf(a.toLowerCase())]))
}

type Sample = { account: string; reset: number; t: number; week: number }

// week-marks.py's samples in one file of ops/usage, each row's account lowercased, a row that does not read left out.
const samplesOf = async (ctx: Context, file: string): Promise<Sample[]> =>
  (
    await Bun.file(join(ctx.ops, "usage", file))
      .text()
      .catch(() => "")
  )
    .split("\n")
    .flatMap((l) => {
      try {
        const r = JSON.parse(l) as Json
        return typeof r.account === "string" &&
          [r.reset, r.t, r.week].every((v) => typeof v === "number")
          ? [{ ...(r as Sample), account: r.account.toLowerCase() }]
          : []
      } catch {
        return []
      }
    })

// One account's week projected to its reset by the usage rule's forecast (scripts/ops/README.md's Usage forecasts): its pace from the first reading of this week after the last move of sessions onto it, the row where week-samples.jsonl turns to it from another account, to a reading under 30 minutes old, once the two span 3 hours.
const weekOf = (factory: Sample[], others: Sample[], account: string, t: number) => {
  const mine = [...factory, ...others].filter((r) => r.account === account)
  const last = mine.reduce<Sample | undefined>((a, r) => (a && a.t >= r.t ? a : r), undefined)
  if (!last || t - last.t >= 1800 || last.reset - t < 600) return undefined
  const away = Math.max(...factory.filter((r) => r.account !== account).map((r) => r.t))
  const onto = factory.filter((r) => r.account === account && r.t > away).map((r) => r.t)
  const moved = onto.length ? Math.min(...onto) : -Infinity
  const first = mine
    .filter((r) => Math.abs(r.reset - last.reset) < 300 && r.t >= moved)
    .reduce((a, r) => (a.t <= r.t ? a : r))
  if (last.t - first.t < WEEK_SPAN) return undefined
  const rate = (last.week - first.week) / (last.t - first.t)
  return {
    reset: last.reset,
    week: Math.round((last.week + rate * (last.reset - last.t)) * 10) / 10,
  }
}

// The week pace's off switch spawn.sh reads: while an account the split can pick projects under 100% at its own reset, the sweep writes a time PACE_OFF_FOR on, never past that reset, and records the forecast it used in pace-off.json; once none does, it removes the time it wrote. A future time it did not write, one written by hand, stays as it is.
export async function paceOff(ctx: Context): Promise<void> {
  const file = join(ctx.data, "usage-pace-off-until")
  const recordPath = join(here(ctx), "pace-off.json")
  const record = await readJson<Json>(recordPath, {})
  const held = (
    await Bun.file(file)
      .text()
      .catch(() => "")
  ).trim()
  const handSet = held !== "" && held !== record.until
  if (handSet && /(Z|[+-]\d\d:?\d\d)$/.test(held) && Date.parse(held) > ctx.now()) return
  const t = seconds(ctx)
  const factory = await samplesOf(ctx, "week-samples.jsonl")
  const others = await samplesOf(ctx, "account-samples.jsonl")
  const projected: Record<string, number> = {}
  let until: number | undefined
  for (const [account, label] of await pickable(ctx)) {
    const week = weekOf(factory, others, account, t)
    if (!week) continue
    projected[label] = week.week
    if (week.week < 100) until = Math.min(until ?? t + PACE_OFF_FOR, week.reset)
  }
  const at = stamp(ctx)
  if (until === undefined) {
    if (held && !handSet) await rm(file, { force: true })
    await writeAtomic(recordPath, JSON.stringify({ at, forecast: projected, until: null }))
    return
  }
  const iso = `${new Date(Math.floor(until) * 1000).toISOString().slice(0, 19)}Z`
  await writeAtomic(file, `${iso}\n`)
  await writeAtomic(recordPath, JSON.stringify({ at, forecast: projected, until: iso }))
}

// A steady beat that is not `ok` but is not a failure: up: for the tunnel, idle: for the relay, while waiting: (nothing to read yet) stays healthy for every job. The Dashboard reads this same list, its copy kept in step by a test.
export const HEALTHY_PREFIXES: Record<string, string[]> = {
  "ops-model-tunnel": ["up: "],
  "ops-peer-relay": ["idle: "],
  "ops-tunnel": ["up: "],
}

// The ops jobs by reading ps alone: each job's script must be running, and each heartbeat ok and fresh, but a paused job's; a RETIRED job's heartbeat file, which outlives it, goes unread.
export async function opsDown(ctx: Context): Promise<string[]> {
  const cmds = (await ctx.run(["ps", "-ax", "-o", "command="])).out
  let disabled = new Set<string>()
  try {
    const jobs = JSON.parse(await Bun.file(join(ctx.ops, "jobs.json")).text()).jobs as Json[]
    disabled = new Set(jobs.filter((j) => j.disabled).map((j) => String(j.name)))
  } catch {}
  const out = ([["dashboard", "dashboard/supervisor.sh"]] as const)
    .filter(([job, mark]) => !cmds.includes(mark) && !disabled.has(`ops-${job}`))
    .map(([job]) => `ops-down:${job}`)
  const files = (await readdir(ctx.ops).catch(() => [])).filter(
    (f) => f.startsWith("ops-") && f.endsWith(".json") && !RETIRED.includes(f.slice(0, -5)),
  )
  for (const file of files) {
    try {
      const b = JSON.parse(await Bun.file(join(ctx.ops, file)).text()) as Json
      if (disabled.has(String(b.job))) continue
      const at = Date.parse(String(b.lastBeatAt))
      if (Number.isNaN(at)) throw new Error("lastBeatAt")
      if (
        b.lastResult !== "ok" &&
        !["waiting: ", ...(HEALTHY_PREFIXES[String(b.job)] ?? [])].some((p) =>
          String(b.lastResult).startsWith(p),
        )
      )
        out.push(`ops-failing:${b.job}`)
      if (ctx.now() - at > 3 * Number(b.cycleSeconds ?? 60) * 1000) out.push(`ops-stale:${b.job}`)
    } catch {
      out.push(`ops-beat-unreadable:${file}`)
    }
  }
  return out
}

// Each answer of the owner's that its poster has not closed within 15 minutes (bun run ask stale): a live poster gets one outbox line, then at most one every STALE_EVERY seconds (4 hours) while it stays open, by the item's tag in stale-told.json; a poster with no live session is a finding.
export async function chaseStale(ctx: Context, live: Map<string, string>): Promise<string[]> {
  const r = await ctx.run(dashboardAsk(ctx, "stale", "--minutes", "15"))
  if (r.code) return ["stale-unreadable"]
  const path = join(here(ctx), "stale-told.json")
  const told = numbers(await readJson(path, {}))
  const now = seconds(ctx)
  const out: string[] = []
  const keep: Record<string, number> = {}
  for (const line of r.out.split("\n")) {
    const m = /^(#i\d+) (\S+) from ([^:]+): (.*?), answered (\d+)m ago/.exec(line)
    if (!m) continue
    const [, tag, item, who, state, minutes] = m as unknown as string[]
    const poster = who!.trim()
    keep[tag!] = told[tag!] ?? 0
    if (!live.has(poster)) {
      out.push(`stale-poster-down:${tag}:${poster}`)
      continue
    }
    if (now - keep[tag!]! < STALE_EVERY) continue
    keep[tag!] = now
    const text = `Inbox ${tag} (${item}): the owner answered ${minutes}m ago and it is not closed (${state}). Read it with \`bun run --cwd ${ctx.dashboard} ask get ${item} --ack\`; once a go is carried out, close it with \`bun run ask ack ${item} --link <url>\` (or --no-link "<why>").`
    await ctx.run(notifyArgv(ctx, text), {
      env: { ...process.env, NOTIFY_TO: poster },
      timeoutMs: 60_000,
    })
  }
  await writeAtomic(path, JSON.stringify(keep))
  return out
}

const pullOf = (pr: unknown, repo: string): number | undefined => {
  const m =
    /^#?(\d+)$/.exec(String(pr ?? "").trim()) ??
    new RegExp(`github\\.com/${repo}/pull/(\\d+)$`, "i").exec(String(pr ?? ""))
  return m ? Number(m[1]) : undefined
}

// A worker's PR whose head has been ready (its checks green) REVIEWER_LATE seconds with no review round (a ReviewBot verdict at any head) and no live session for the reviewer the roster names on it, by its pr or any entry of its prs: one line to the worker's lead, once per head, since a reviewer started late or by hand left heads ready for over an hour. A draft PR and a parked row wait by design, so neither raises a line; the runner check below reads the parked one.
// The same read finds a worker's PR, a draft's too, that conflicts with its base (mergeable CONFLICTING or mergeStateStatus DIRTY) with no GitHub Actions run at its head, which GitHub never starts on it: CONFLICT_AFTER seconds after a sweep first sees it, one line to the worker and one to its lead, once per head; conflict-told.json keeps only the PRs conflicting now, a read of UNKNOWN at the same head keeping its entry, so a fixed conflict that comes back alerts again. A conflicting PR raises no late-reviewer line, since its head is not ready.
export async function lateReviewers(
  ctx: Context,
  agents: Json[],
  live: Map<string, string>,
): Promise<string[]> {
  const open = agents.filter((a) => a.status !== "ended" && a.status !== "parked")
  if (!open.some((a) => a.pr && kindOf(String(a.name), a.kind) === "worker")) return []
  let repo: string
  try {
    repo = (await (ctx.factory ?? (() => factoryRepoOf()))()).toLowerCase()
  } catch {
    return ["reviewer-check-unreadable"]
  }
  const workers = new Map<number, string>()
  for (const a of open) {
    const n = pullOf(a.pr, repo)
    if (n !== undefined && kindOf(String(a.name), a.kind) === "worker")
      workers.set(n, String(a.name))
  }
  if (!workers.size) return []
  const fields =
    "state headRefOid isDraft mergeable mergeStateStatus comments(last: 100) { nodes { body } } commits(last: 1) { nodes { commit { checkSuites(first: 1, filterBy: { appId: 15368 }) { totalCount } statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { completedAt } ... on StatusContext { createdAt } } } } } } }"
  const [owner, name] = repo.split("/")
  const query = `{ repository(owner: "${owner}", name: "${name}") { ${[...workers.keys()].map((n) => `p${n}: pullRequest(number: ${n}) { ${fields} }`).join(" ")} } }`
  const r = await ctx.run(["gh", "api", "graphql", "-f", `query=${query}`], { timeoutMs: 60_000 })
  let pulls: Record<string, Json | null>
  try {
    pulls = JSON.parse(r.out).data.repository
  } catch {
    return ["reviewer-check-unreadable"]
  }
  const path = join(here(ctx), "reviewer-told.json")
  const told = (await readJson<Record<string, string>>(path, {})) ?? {}
  const keep: Record<string, string> = {}
  type Conflict = { at: number; sha: string; told: boolean }
  const conflictPath = join(here(ctx), "conflict-told.json")
  const conflicts = (await readJson<Record<string, Conflict>>(conflictPath, {})) ?? {}
  const conflicting: Record<string, Conflict> = {}
  const now = seconds(ctx)
  for (const [n, worker] of workers) {
    const pr = pulls?.[`p${n}`] as {
      comments?: { nodes?: { body?: string }[] }
      commits?: {
        nodes?: {
          commit?: {
            // GitHub Actions' suites alone (app 15368): one is a workflow run at the head
            checkSuites?: { totalCount?: number }
            statusCheckRollup?: {
              contexts?: { nodes?: { completedAt?: string; createdAt?: string }[] }
              state?: string
            }
          }
        }[]
      }
      headRefOid?: string
      isDraft?: boolean
      mergeStateStatus?: string
      mergeable?: string
      state?: string
    } | null
    if (!pr || pr.state !== "OPEN" || !pr.headRefOid) continue
    const commit = pr.commits?.nodes?.[0]?.commit
    const seen = conflicts[n]?.sha === pr.headRefOid ? conflicts[n]! : null
    // GitHub reads UNKNOWN while it works the answer out again, after the base moves: a conflict already seen at this head stands, telling nothing
    const real = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY"
    const conflicted = real || (pr.mergeable === "UNKNOWN" && seen !== null)
    if (conflicted && !commit?.checkSuites?.totalCount) {
      const conflict = (conflicting[n] = seen ?? { at: now, sha: pr.headRefOid, told: false })
      if (real && !conflict.told && now - conflict.at >= CONFLICT_AFTER) {
        conflict.told = true
        const text = `PR #${n} (${worker}): it conflicts with its base at head ${pr.headRefOid.slice(0, 7)}, so GitHub runs no CI on it. Merge canary into it and push.`
        for (const to of new Set([worker, await leadName(ctx.ops, worker)]))
          await ctx.run(notifyArgv(ctx, text), {
            env: { ...process.env, NOTIFY_TO: to },
            timeoutMs: 60_000,
          })
      }
    }
    // a conflicting head is not ready, even while other apps' checks read SUCCESS with no Actions run
    if (pr.isDraft || conflicted) continue
    if (told[n] === pr.headRefOid) keep[n] = pr.headRefOid
    const rollup = commit?.statusCheckRollup
    if (rollup?.state !== "SUCCESS") continue
    const readyAt = Math.max(
      0,
      ...(rollup.contexts?.nodes ?? []).map(
        (c) => Date.parse(c.completedAt ?? c.createdAt ?? "") / 1000 || 0,
      ),
    )
    if (!readyAt || now - readyAt < REVIEWER_LATE) continue
    if ((pr.comments?.nodes ?? []).some((c) => /^## ReviewBot · round /.test(c.body ?? "")))
      continue
    const reviewers = open.filter(
      (a) =>
        kindOf(String(a.name), a.kind) === "reviewer" &&
        [a.pr, ...(Array.isArray(a.prs) ? a.prs : [])].some((u) => pullOf(u, repo) === n),
    )
    if (reviewers.some((a) => live.has(String(a.name)))) continue
    if (keep[n] === pr.headRefOid) continue
    keep[n] = pr.headRefOid
    const minutes = Math.floor((now - readyAt) / 60)
    const named = reviewers.map((a) => String(a.name)).join(", ")
    const text = `PR #${n} (${worker}): its head ${pr.headRefOid.slice(0, 7)} has been ready ${minutes}m with no review round and ${named ? `no live session for ${named}` : "no reviewer on the roster"}. Start its reviewer, or ask ${worker} to.`
    await ctx.run(notifyArgv(ctx, text), {
      env: { ...process.env, NOTIFY_TO: await leadName(ctx.ops, worker) },
      timeoutMs: 60_000,
    })
  }
  await writeAtomic(path, JSON.stringify(keep))
  await writeAtomic(conflictPath, JSON.stringify(conflicting))
  return []
}

// A live worker's PG branch whose head is NO_PR_AFTER seconds old with no PR in any state: one line to the worker's lead, once per head, since CI runs only on a PR into canary, so a lead can plan around a run that never started. The branch is the one its row records at first push (playbook's ROSTER.md); a row holding a pr, or one whose status is not live, is not read, and one GraphQL read covers every branch.
export async function prlessBranches(ctx: Context, agents: Json[]): Promise<string[]> {
  const workerOf = new Map<string, string>()
  for (const a of agents)
    if (
      (STATUSES.live as string[]).includes(String(a.status)) &&
      !a.pr &&
      kindOf(String(a.name), a.kind) === "worker" &&
      /^pg-\d+/i.test(String(a.branch ?? ""))
    )
      workerOf.set(String(a.branch), String(a.name))
  if (!workerOf.size) return []
  let repo: string
  try {
    repo = await (ctx.factory ?? (() => factoryRepoOf()))()
  } catch {
    return ["branch-check-unreadable"]
  }
  const branches = [...workerOf.keys()]
  const [owner, name] = repo.split("/")
  const query = `{ repository(owner: "${owner}", name: "${name}") { ${branches.map((b, i) => `b${i}: ref(qualifiedName: ${JSON.stringify(`refs/heads/${b}`)}) { associatedPullRequests { totalCount } target { ... on Commit { committedDate oid } } }`).join(" ")} } }`
  const r = await ctx.run(["gh", "api", "graphql", "-f", `query=${query}`], { timeoutMs: 60_000 })
  let refs: Record<string, Json | null>
  try {
    refs = JSON.parse(r.out).data.repository
  } catch {
    return ["branch-check-unreadable"]
  }
  const path = join(here(ctx), "branch-told.json")
  const told = (await readJson<Record<string, string>>(path, {})) ?? {}
  const keep: Record<string, string> = {}
  const now = seconds(ctx)
  for (const [i, branch] of branches.entries()) {
    const ref = refs?.[`b${i}`] as {
      associatedPullRequests?: { totalCount?: number }
      target?: { committedDate?: string; oid?: string }
    } | null
    const oid = ref?.target?.oid
    if (!ref || !oid || ref.associatedPullRequests?.totalCount !== 0) continue
    const committed = Date.parse(ref.target?.committedDate ?? "") / 1000
    if (!committed || now - committed < NO_PR_AFTER) continue
    keep[branch] = oid
    if (told[branch] === oid) continue
    const worker = workerOf.get(branch)!
    const text = `Branch ${branch} (${worker}): its head ${oid.slice(0, 7)} is ${Math.floor((now - committed) / 60)}m old and has no PR, so no CI runs on it. Open its draft PR so CI runs.`
    await ctx.run(notifyArgv(ctx, text), {
      env: { ...process.env, NOTIFY_TO: await leadName(ctx.ops, worker) },
      timeoutMs: 60_000,
    })
  }
  await writeAtomic(path, JSON.stringify(keep))
  return []
}

// Each open PR of ours in the factory repo, and each PR a live roster row names (pr or prs) in any other repo, read in one GraphQL search into ops/alerts-prs.json, which ops-unstick folds into alerts-pending.json: one whose last REPEATS ReviewBot verdicts hold one score below 5 (a fresh round resets the idle clock, so a 3/5 every 20 minutes never idles), and one with no opening, new commit, verdict or comment for STALL_AFTER seconds that waits on neither its checks nor merge-on-ready. A PR held on purpose is left out: a park or hold label, or a line of its body or newest comment opening with Held: or Parked:.
export async function stalledPrs(ctx: Context, agents: Json[]): Promise<string[]> {
  let factory: string
  try {
    factory = (await (ctx.factory ?? (() => factoryRepoOf()))()).toLowerCase()
  } catch {
    return ["stalled-check-unreadable"]
  }
  const repos = new Set([factory])
  const named = new Set<string>()
  for (const a of agents) {
    if (!(STATUSES.live as string[]).includes(String(a.status))) continue
    for (const url of [a.pr, ...(Array.isArray(a.prs) ? a.prs : [])]) {
      const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(String(url ?? ""))
      if (!m) continue
      repos.add(m[1]!.toLowerCase())
      named.add(`${m[1]!.toLowerCase()}#${Number(m[2])}`)
    }
  }
  const search = `is:pr is:open author:@me ${[...repos]
    .sort()
    .map((r) => `repo:${r}`)
    .join(" ")}`
  const fields =
    "number body createdAt repository { nameWithOwner } labels(first: 20) { nodes { name } } comments(last: 100) { nodes { body createdAt } } reviews(last: 1) { nodes { submittedAt } } commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }"
  const query = `{ search(query: ${JSON.stringify(search)}, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${fields} } } } }`
  const r = await ctx.run(["gh", "api", "graphql", "-f", `query=${query}`], { timeoutMs: 60_000 })
  let prs: {
    body?: string
    comments?: { nodes?: { body?: string; createdAt?: string }[] }
    commits?: {
      nodes?: {
        commit?: { committedDate?: string; statusCheckRollup?: { state?: string } | null }
      }[]
    }
    createdAt?: string
    labels?: { nodes?: { name?: string }[] }
    number?: number
    repository?: { nameWithOwner?: string }
    reviews?: { nodes?: { submittedAt?: string }[] }
  }[]
  try {
    prs = JSON.parse(r.out).data.search.nodes
    if (!Array.isArray(prs)) throw new Error("no nodes")
  } catch {
    return ["stalled-check-unreadable"]
  }
  const queue = await readJson<{ queue?: { pr?: unknown; readyAt?: unknown }[] }>(
    join(ctx.data, "merge-queue.json"),
    {},
  )
  const ready = new Set(
    (Array.isArray(queue?.queue) ? queue.queue : []).filter((e) => e?.readyAt).map((e) => e.pr),
  )
  const held = (text = "") => /^\W*(held|parked)\W*:/im.test(text)
  const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`
  const alerts: Json[] = []
  for (const pr of prs) {
    const repo = pr?.repository?.nameWithOwner?.toLowerCase()
    if (!repo || typeof pr.number !== "number") continue
    if (repo !== factory && !named.has(`${repo}#${pr.number}`)) continue
    const comments = pr.comments?.nodes ?? []
    if (
      held(pr.body) ||
      held(comments.at(-1)?.body) ||
      (pr.labels?.nodes ?? []).some((l) => /\b(park|hold)/i.test(l.name ?? ""))
    )
      continue
    const commit = pr.commits?.nodes?.[0]?.commit
    const last = Math.max(
      0,
      ...[
        pr.createdAt,
        commit?.committedDate,
        comments.at(-1)?.createdAt,
        pr.reviews?.nodes?.at(-1)?.submittedAt,
      ].map((t) => Date.parse(t ?? "") || 0),
    )
    const reasons: string[] = []
    const scores = comments.flatMap((c) => {
      const v = verdictOf(c.body ?? "")
      return v?.gate === "review" ? [v] : []
    })
    const tail = scores.slice(-REPEATS)
    const score = tail[0]?.score
    if (
      tail.length === REPEATS &&
      score !== undefined &&
      score < 5 &&
      tail.every((v) => v.score === score)
    )
      reasons.push(`last ${REPEATS} verdicts ${score}/5, round ${tail.at(-1)!.round}`)
    const idle = Math.floor((ctx.now() - last) / 60_000)
    const waiting =
      ["EXPECTED", "PENDING"].includes(commit?.statusCheckRollup?.state ?? "") ||
      (repo === factory && ready.has(pr.number))
    if (idle * 60 >= STALL_AFTER && !waiting)
      reasons.push(`no new commit, verdict or comment for ${idle}m`)
    if (reasons.length)
      alerts.push({
        at: stamp(ctx),
        kind: "pr-stalled",
        lastActivityAt: iso(last),
        line: reasons.join("; "),
        name: `${repo}#${pr.number}`,
      })
  }
  await writeAtomic(
    join(ctx.ops, "alerts-prs.json"),
    `${JSON.stringify({ alerts, writtenAt: stamp(ctx) }, null, 1)}\n`,
  )
  return []
}

// run-slot's runner-box route, which falls back to this Mac without a word: one finding naming each precondition run-slot.sh box-off reports failing (no-ci-sh, no-host, no-ssh-key, runner-host-off, slot-off).
export async function boxRoute(ctx: Context): Promise<string[]> {
  const r = await ctx.run([join(ctx.ops, "run-slot.sh"), "box-off"], { timeoutMs: 60_000 })
  if (r.code) return ["box-route-unreadable"]
  const why = r.out.split(/\s+/).filter(Boolean)
  return why.length ? [`box-route-off:${why.join(",")}`] : []
}

// The dashboard database's container, the one publishing POSTGRES_URL's port from the dashboard's own .env, so it runs under any name; undefined when none passes.
export async function dashboardDb(ctx: Context): Promise<string | undefined> {
  const env = { ...process.env }
  delete env.POSTGRES_URL
  const r = await ctx.run(["bun", join(ctx.repo, "api", "hono", "src", "bin", "dashboard-db.ts")], {
    cwd: ctx.dashboard,
    env,
    timeoutMs: 60_000,
  })
  const name = r.out.trim()
  return r.code === 0 && name ? name : undefined
}

// A playground-* Postgres container with no client for IDLE_DB_AFTER seconds is a finding, read by its own client connections, since an owner's session can stay live long after its stack is down; the dashboard's own is never one, and when it cannot be found no container is judged.
export async function idleDbs(ctx: Context): Promise<string[]> {
  const ps = await ctx.run(
    ["docker", "ps", "--filter", "name=^playground-", "--format", "{{.Names}}"],
    {
      timeoutMs: 60_000,
    },
  )
  if (ps.code) return []
  const names = ps.out.split(/\s+/).filter(Boolean)
  const dashboard = names.length ? await dashboardDb(ctx) : undefined
  if (names.length && !dashboard) return ["dashboard-db-unknown"]
  const path = join(here(ctx), "idle-db.json")
  const now = seconds(ctx)
  // Only a pass that saw the containers writes the file, so one older than IDLE_DB_GAP means a blind gap a client may have come and gone in: every clock starts again.
  const written = await Bun.file(path)
    .stat()
    .then(
      (s) => s.mtimeMs / 1000,
      () => 0,
    )
  const since = now - written <= IDLE_DB_GAP ? numbers(await readJson(path, {})) : {}
  const out: string[] = []
  const keep: Record<string, number> = {}
  for (const name of names) {
    if (name === dashboard) continue
    const r = await ctx.run(["docker", "exec", name, "psql", "-U", "postgres", "-tAc", IDLE_SQL], {
      timeoutMs: 30_000,
    })
    if (r.code || r.out.trim() !== "0") continue
    keep[name] = since[name] ?? now
    if (now - keep[name]! >= IDLE_DB_AFTER) out.push(`idle-db:${name}`)
  }
  await writeAtomic(path, JSON.stringify(keep))
  return out
}

// Whether a pid runs, read for a removal: a refused signal (another user's process, or one outside a sandbox the sweep runs in) counts as running, so a removal never rests on a pid the sweep cannot see.
export const runsForDelete = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// A test container named playground-test-<suite>-<pid> whose runner pid no longer runs is a killed test run's leftover (the kill never reaches the suite's cleanup): removed with its volumes, so a killed run leaks nothing. Every other container stays: the live dashboard's database, first run's, a Vibeground copy, a worktree's, any running stack's, and any test container whose pid still runs; a name whose last field is not a pid, such as a worktree named test-x's playground-test-x-db, is never one. runs says whether a pid has a process, a test's table in its place.
export async function leakedTests(
  ctx: Context,
  runs: (pid: number) => boolean = runsForDelete,
): Promise<string[]> {
  const ps = await ctx.run(
    ["docker", "ps", "--filter", "name=^playground-test-", "--format", "{{.Names}}"],
    {
      timeoutMs: 60_000,
    },
  )
  if (ps.code) return []
  const removed: string[] = []
  for (const name of ps.out.split("\n").filter(Boolean)) {
    const pid = Number(/^playground-test-[a-z0-9-]+-(\d+)$/.exec(name)?.[1])
    if (!Number.isInteger(pid) || pid <= 0 || runs(pid)) continue
    if ((await ctx.run(["docker", "rm", "-fv", name], { timeoutMs: 60_000 })).code === 0)
      removed.push(name)
  }
  return removed
}

// One read of runners, probes, the managers' asks, unclosed answers, the ops jobs, idle databases, the runner-box route, late reviewers and conflicting PRs, branches with no PR, stalled PRs and the usage forecast.
export async function check(ctx: Context): Promise<string[]> {
  let roster: Json
  try {
    roster = JSON.parse(await Bun.file(join(ctx.data, "roster.json")).text())
  } catch (err) {
    const e = err as { code?: string; name?: string }
    return [`roster-unreadable:${e.code ?? e.name ?? "Error"}`]
  }
  const agents = (Array.isArray(roster.agents) ? roster.agents : []) as Json[]
  const kinds = new Map(agents.map((a) => [a.name, a.kind]))
  const live = await registry(ctx)
  const unended = agents
    .filter((a) => a.status !== "ended" && a.status !== "parked" && typeof a.name === "string")
    .map((a) => a.name as string)
    .filter((name) => !live.has(name) && kindOf(name, kinds.get(name)) === "probe")
  for (const name of await sshLive(ctx, unended)) live.set(name, "")
  const now = Math.floor(seconds(ctx))
  const seenPath = join(here(ctx), "probe-first-seen.json")
  const seen = numbers(await readJson(seenPath, {}))
  const recorded = new Set(agents.filter((a) => a.status !== "ended").map((a) => a.name))
  const found: string[] = []
  for (const a of agents) {
    const name = typeof a.name === "string" ? a.name : ""
    // a parked runner is down by design (runner-sharp-lynx, parked 18 Oct, read as down on every restart)
    if (a.status === "ended" || a.status === "parked") continue
    const kind = kindOf(name, kinds.get(name))
    if (kind === "runner") {
      if (!live.has(name)) found.push(`down:${name}`)
      else if (live.get(name) === "waiting") found.push(`waiting:${name}`)
    }
    if (kind === "probe" && !live.has(name)) found.push(`probe-gone-unended:${name}`)
    const placed = placedKindOf(name, kinds.get(name))
    if (placed !== "ops" && placed !== "dispatcher") continue
    for (const ask of String(a.asks ?? "")
      .split(/\s+/)
      .filter(Boolean)) {
      const r = await ctx.run(dashboardAsk(ctx, "get", /^\d+$/.test(ask) ? `#i${ask}` : ask), {
        timeoutMs: 60_000,
      })
      const brace = r.out.indexOf("{")
      let d: Json | null = null
      try {
        if (r.code === 0 && brace !== -1) d = JSON.parse(r.out.slice(brace)) as Json
      } catch {}
      if (!d || typeof d !== "object") found.push(`ask-unreadable:${ask}`)
      else if (d.status !== "open") found.push(`ask-answered:${ask}`)
    }
  }
  for (const name of Object.keys(seen)) if (!live.has(name)) delete seen[name]
  for (const name of live.keys()) {
    if (name === SDK_PROBE || kindOf(name, kinds.get(name)) !== "probe") continue
    seen[name] ??= now
    const age = Math.floor((now - seen[name]!) / 60)
    if (age >= 15) found.push(`probe-over-15m:${name}`)
    if (!recorded.has(name) && age >= 10) found.push(`probe-unrecorded:${name}`)
  }
  await writeAtomic(seenPath, JSON.stringify(seen))
  found.push(...(await chaseStale(ctx, live)))
  found.push(...(await opsDown(ctx)))
  found.push(...(await idleDbs(ctx)))
  found.push(...(await boxRoute(ctx)))
  found.push(...(await lateReviewers(ctx, agents, live)))
  found.push(...(await prlessBranches(ctx, agents)))
  found.push(...(await stalledPrs(ctx, agents)))
  const projected = Object.values(await forecast(ctx))
  if (projected.length) found.push(projected.some((v) => v > HEADROOM) ? "no-headroom" : "headroom")
  try {
    await paceOff(ctx)
  } catch (err) {
    found.push(`pace-off-unwritten:${(err as { code?: string }).code ?? "Error"}`)
  }
  return found
}

// Every 6 hours at a quiet minute, Docker's leftovers go: anonymous volumes no container uses (never --all, so no named volume) and build cache older than a day. Quiet: no dashboard roll in the last 5 minutes, no container in Created or Restarting, and a 1-minute load under 20.
export async function maybePrune(ctx: Context): Promise<void> {
  const statePath = join(here(ctx), "prune-state.json")
  const last = numbers(await readJson(statePath, {})).at ?? 0
  if (seconds(ctx) - last < PRUNE_EVERY) return
  const log = await Bun.file(join(ctx.ops, "dashboard", "supervisor.log"))
    .text()
    .catch(() => "")
  const cutoff = new Date(ctx.now() - 300_000).toISOString().slice(0, 19)
  const rolled = log
    .replace(/\n$/, "")
    .split("\n")
    .slice(-30)
    .some(
      (l) =>
        l.slice(0, 19) >= cutoff &&
        (/\b(main|canary) moved\b/.test(l) || l.includes("dev started") || l.includes("stopping")),
    )
  if (rolled) return
  const created = await ctx.run(
    ["docker", "ps", "-a", "--filter", "status=created", "--filter", "status=restarting", "-q"],
    { timeoutMs: 60_000 },
  )
  if (created.out.trim() || ctx.load() >= 20) return
  const freed: string[] = []
  for (const argv of PRUNES) {
    const r = await ctx.run(argv, { timeoutMs: 3_600_000 })
    const m = /Total(?: reclaimed space)?:\s*([\d.]+\s*[KMGT]?B)/.exec(r.out)
    freed.push(
      `\`${argv.slice(1).join(" ")}\` ${r.code ? `failed (exit ${r.code})` : `freed ${m?.[1] ?? "0B"}`}`,
    )
  }
  await writeAtomic(statePath, JSON.stringify({ at: seconds(ctx) }))
  await appendFile(
    join(ctx.ops, "ops-log.md"),
    `- ${stamp(ctx)} daily Docker prune (ops-sweep): ${freed.join("; ")}.\n`,
  )
}

// One sweep: restart any ops job that is down, clear stale run-slot holders, then tell ops each finding not already active (a known one never); a finding that clears and comes back is told again.
export async function pass(
  ctx: Context,
  active: Set<string>,
  known: Set<string>,
): Promise<{ active: Set<string>; result: string }> {
  const log = (line: string) => appendFile(join(here(ctx), "sweep.log"), `${stamp(ctx)} ${line}\n`)
  let result = "ok"
  let next = active
  await ctx.run(["python3", "-I", join(ctx.main, "scripts", "ops", "up.py")], {
    env: { ...process.env, OPS_UP_SKIP: "ops-sweep" },
    timeoutMs: 600_000,
  })
  try {
    const cleared = await ctx.run([join(ctx.ops, "run-slot.sh"), "clear-stale"], {
      timeoutMs: 60_000,
    })
    for (const line of cleared.out.split("\n")) if (line.includes("cleared")) await log(line)
  } catch {}
  try {
    const found = new Set(await check(ctx))
    const fresh = [...found].filter((f) => !active.has(f)).sort()
    next = new Set([...found, ...[...active].filter((f) => known.has(f))])
    if (fresh.length) {
      await log(fresh.join(" "))
      await ctx.run(notifyArgv(ctx, fresh.join(" ")), { timeoutMs: 60_000 })
    }
  } catch (err) {
    result = `error: ${err instanceof Error ? err.message : String(err)}`
  }
  try {
    const removed = await leakedTests(ctx)
    if (removed.length)
      await appendFile(
        join(ctx.ops, "ops-log.md"),
        `- ${stamp(ctx)} leaked test containers removed (ops-sweep): ${removed.join(", ")}.\n`,
      )
  } catch (err) {
    result = `error: leaked test containers: ${err instanceof Error ? err.message : String(err)}`
  }
  try {
    await maybePrune(ctx)
  } catch (err) {
    result = `error: prune: ${err instanceof Error ? err.message : String(err)}`
  }
  return { active: next, result }
}

export const beat = (
  path: string,
  startedAt: Date,
  now: Date,
  cycleSeconds: number,
  lastResult: string,
) =>
  writeAtomic(
    path,
    `${JSON.stringify({
      cycleSeconds,
      job: "ops-sweep",
      lastBeatAt: now.toISOString(),
      lastResult: lastResult.slice(0, 120),
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    })}\n`,
  )
