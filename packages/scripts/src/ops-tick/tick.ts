import { realpathSync, statfsSync } from "node:fs"
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import {
  dispatcherOf,
  dispatcherSeatOf,
  kindOf,
  managerKindOfName,
  managerOf,
} from "@packages/config/kinds"
import { purgeTrash, stripTrash } from "@packages/safe-delete"
import { accountSettings, readPolicy, ruleSettings } from "@packages/settings"

import {
  sweep as autoEndSweep,
  type Line,
  liveDeps,
} from "../../../../scripts/ops/optimizer/auto_end"
import { liveInput } from "../../../../scripts/ops/optimizer/idle_sessions"
import { pending } from "../ops-outbox/drain"
import { focusCard } from "../playground/focus"
import { lapse } from "../playground/priority"
import { dashboardCheckout, NO_CHECKOUT } from "../playground/probe"
import { ALERT_JOB, waiterLive } from "../stuck-alert"
import { swapBundles, unswapBundles } from "../swap-bundles"
import { writeAtomic } from "../write-atomic"
import { dashboardWatch } from "./dashboard-watch"
import { guardProbe } from "./guard-probe"
import { nightlyClean } from "./nightly-clean"

// ops-tick: runner-steady-tick's timed beats, run as a script with no model call. Each beat runs at its old cron, in machine wall time as CronCreate ran it, runs the same script, and queues what that script prints for the session it went to before, through notify.sh and the ops relay (ADR 0010); a beat whose script prints nothing sends nothing. The Lanes keeper comes in a later change; the 98% move to GLM is retired (Inbox #i827) for the account rotation (`scripts/ops/usage/login-flip.py`).
export const CYCLE_SECONDS = 60

export type Run = (
  argv: string[],
  timeoutMs?: number,
  stdin?: string,
) => Promise<{ code: number; out: string }>
// to is a manager kind (builder, ops, optimizer), dispatcher (the primary) or a session's name, as notify.sh takes it; true once the line is queued. A beat's own send never throws: a failed one is named in the heartbeat's result (guard).
// again: the beat finds this line again by itself until it marks it told, so a failed send of it is never kept to resend.
export type Send = (to: string, text: string, again?: boolean) => Promise<boolean>

export type Context = {
  now: Date
  ops: string
  repo: string
  run: Run
  send: Send
}

export type Beat = { cron: string; name: string; run: (ctx: Context) => Promise<void>; to: string }

const fieldOf = (field: string, min: number, max: number): Set<number> | null => {
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const from = m[1] === "*" ? min : Number(m[2])
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from
    const step = m[4] ? Number(m[4]) : 1
    if (from < min || to > max || from > to || step < 1) return null
    for (let n = from; n <= to; n += step) values.add(n)
  }
  return values
}

// Whether a 5-field cron names this minute, read in machine wall time, as CronCreate read the old crons.
export function cronMatches(cron: string, at: Date): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`not a 5-field cron: ${cron}`)
  const sets = fields.map((field, i) =>
    fieldOf(field, [0, 0, 1, 1, 0][i]!, [59, 23, 31, 12, 6][i]!),
  )
  if (sets.some((set) => set === null)) throw new Error(`unreadable cron: ${cron}`)
  const now = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()]
  return sets.every((set, i) => set!.has(now[i]!))
}

// The next minute after from that the cron names, within 8 days.
export function nextDue(cron: string, from: Date): Date {
  const at = new Date(from)
  at.setSeconds(0, 0)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    at.setMinutes(at.getMinutes() + 1)
    if (cronMatches(cron, at)) return new Date(at)
  }
  throw new Error(`no time in 8 days for ${cron}`)
}

const isoSeconds = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, "Z")

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

const python = (ctx: Context, path: string, isolated = true) =>
  ctx.run(["python3", ...(isolated ? ["-I"] : []), join(ctx.ops, path)])

const readJson = async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text())

const fresh = (at: unknown, now: Date, ms: number): boolean =>
  typeof at === "string" && now.getTime() - Date.parse(at) <= ms

// The load averages, from sysctl's `{ 1m 5m 15m }`.
const loadOf = async (ctx: Context): Promise<number[]> =>
  (await ctx.run(["sysctl", "-n", "vm.loadavg"])).out
    .replace(/[{}]/g, "")
    .trim()
    .split(/\s+/)
    .map(Number)

// Names the dashboard's paused file over 30 minutes old to ops, once a file; roll-now is left to Update now and `playground update`, so the dashboard's roll holds stand.
const rollGate = async (ctx: Context) => {
  const dashboard = join(ctx.ops, "dashboard")
  const paused = await stat(join(dashboard, "paused")).catch(() => null)
  if (!paused) return
  const age = ctx.now.getTime() - paused.mtimeMs
  const told = join(ctx.ops, "tick", `paused-told-${Math.floor(paused.mtimeMs / 1000)}`)
  if (age <= 30 * 60_000 || (await Bun.file(told).exists())) return
  if (await ctx.send("ops", `ops/dashboard/paused is ${Math.floor(age / 60_000)} min old`, true))
    await Bun.write(told, "")
}

// The four processes using the most CPU, each `<command> pid <pid>: <cpu>% CPU`, so a load line names what to look at.
const loadReport = async (ctx: Context): Promise<string[]> =>
  lines((await ctx.run(["ps", "-A", "-o", "pcpu=,pid=,comm="])).out)
    .map((line) => line.trim().match(/^([\d.]+)\s+(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, cpu, pid, command]) => ({ command: basename(command!), cpu: Number(cpu), pid }))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 4)
    .map(({ command, cpu, pid }) => `${command} pid ${pid}: ${Math.round(cpu)}% CPU`)

// Posts one Inbox alert update under the ops manager's name with bun run ask, its text the line that links where the owner looks next, and answers its item's id; --silent, so a failure's last line is ask's own, not bun's "error: script ... exited" after it.
const postAlert = async (
  ctx: Context,
  title: string,
  text: string,
): Promise<{ by: string; id: string }> => {
  const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
    agents?: unknown
  } | null
  const by = managerOf(roster?.agents, "ops")
  const posted = await ctx.run(
    ["bun", "run", "--silent", "--cwd", ctx.repo, "ask", "new"],
    120_000,
    JSON.stringify({ from: by, kind: "update", preview: { outcome: "alert", text }, title }),
  )
  const id = postedId(posted.out)
  if (posted.code !== 0 || !id) throw new Error(`bun run ask new: ${lines(posted.out).at(-1)}`)
  return { by, id }
}

// The item id bun run ask new printed, the one line that is a uuid
const postedId = (out: string): string | undefined =>
  lines(out)
    .map((l) => l.trim())
    .find((l) => /^[0-9a-f-]{36}$/.test(l))

// The poster's own Inbox update resolved with bun run ask resolve, its note saying why; an item already gone or already resolved counts as resolved, and any other failure throws, so the next run tries again.
const resolveOwn = async (ctx: Context, id: string, by: string, note: string) => {
  const done = await ctx.run([
    "bun",
    "run",
    "--silent",
    "--cwd",
    ctx.repo,
    "ask",
    "resolve",
    id,
    "--by",
    by,
    "--note",
    note,
  ])
  if (done.code !== 0 && !/no inbox item|already resolved/.test(done.out))
    throw new Error(`bun run ask resolve ${id}: ${lines(done.out).at(-1)}`)
}

type FocusCardKept = { by: string; id: string; since: string; until: string }

// Once focus has ended, by off or at its end, one Inbox update under the ops manager's name names what queued while it stood (focusCard), kept in tick/focus-cards.json; a card kept at an earlier beat resolves once no ask posted while its focus stood is open, since what it pointed at is answered; a card that fails stays for the next beat, and the first failure throws once the rest are tried and the new card posted.
const focusCardBeat = async (ctx: Context) => {
  const keptPath = join(ctx.ops, "tick", "focus-cards.json")
  const kept = ((await readJson(keptPath).catch(() => [])) ?? []) as FocusCardKept[]
  const left: FocusCardKept[] = []
  let failed: Error | undefined
  for (const card of kept) {
    try {
      if (!(await settleFocusCard(ctx, card))) left.push(card)
    } catch (error) {
      left.push(card)
      failed ??= error as Error
    }
  }
  if (kept.length > 0) await writeAtomic(keptPath, JSON.stringify(left))
  await focusCard(join(ctx.ops, ".."), ctx.now, async (card, focus) => {
    const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
      agents?: unknown
    } | null
    const by = managerOf(roster?.agents, "ops")
    const posted = await ctx.run(
      ["bun", "run", "--silent", "--cwd", ctx.repo, "ask", "new"],
      120_000,
      JSON.stringify({ from: by, ...card }),
    )
    if (posted.code !== 0) throw new Error(`bun run ask new: ${lines(posted.out).at(-1)}`)
    const id = postedId(posted.out)
    if (id) {
      left.push({ by, id, since: focus.since, until: focus.until })
      await writeAtomic(keptPath, JSON.stringify(left))
    }
  })
  if (failed) throw failed
}

// Each window playground priority opened that has stood LAPSE_HOURS is lifted with a line in ops/priority.log (lapse), and that line goes to ops, so a window nobody lifted stops passing --priority starts by itself.
const priorityLapse = async (ctx: Context) => {
  for (const line of await lapse(join(ctx.ops, ".."), ctx.now)) await ctx.send("ops", line)
}

const RUN_SLOTS = ["run-slot", "run-slot-2", "run-slot-3", "run-slot-4"]
const HOLD_AFTER_MS = 30 * 60_000

const pidLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

// A run-slot hold past 30 minutes while a waiter queues is told to ops once per hold: the four queue lanes' holder lines (`<who> <pid> <iso> <units> <size>`) give the holder and its start, runs.log's ask line for that who and pid the command (a hold can-take, a reread or the merge train's own mkdir made names none), a dead pid no alert, the queue's live waiter tickets counted by each ticket's pid as run-slot.sh's own queue read prunes the dead ones, and tick/run-slot-hold-told.json holds one `<slot>:<pid>` key per told hold, pruned to the live holds on every pass, a no-waiter one included.
export const runSlotHold = async (ctx: Context) => {
  const toldPath = join(ctx.ops, "tick", "run-slot-hold-told.json")
  const told = ((await readJson(toldPath).catch(() => null)) ?? {}) as Record<string, string>
  const before = JSON.stringify(told)
  let runsLog: string | null = null
  const holds: { heldMs: number; pid: string; since: string; slot: string; who: string }[] = []
  for (const slot of RUN_SLOTS) {
    const line = (
      await Bun.file(join(ctx.ops, `${slot}.holder`))
        .text()
        .catch(() => "")
    ).trim()
    const [who, pid, since] = line.split(/\s+/)
    const heldMs = ctx.now.getTime() - Date.parse(since ?? "")
    if (
      !who ||
      !pid ||
      !Number.isFinite(heldMs) ||
      heldMs <= HOLD_AFTER_MS ||
      !pidLive(Number(pid))
    )
      continue
    holds.push({ heldMs, pid, since: since!, slot, who })
  }
  const live = new Set(holds.map((h) => `${h.slot}:${h.pid}`))
  for (const key of Object.keys(told)) if (!live.has(key)) delete told[key]
  let waiters = 0
  try {
    waiters = (await readdir(join(ctx.ops, "run-slot.waiters"))).filter((t) =>
      pidLive(Number(t.split("-")[1])),
    ).length
  } catch {}
  if (waiters > 0) {
    for (const hold of holds) {
      const key = `${hold.slot}:${hold.pid}`
      if (told[key]) continue
      runsLog ??= await Bun.file(join(ctx.ops, "run-slot.runs.log"))
        .text()
        .catch(() => "")
      const asked = runsLog.split("\n").findLast((l) => l.includes(` ask ${hold.who} ${hold.pid} `))
      const command = asked
        ? asked.replace(/^[^ ]+ ask \S+ \d+ /, "")
        : "command unread from run-slot.runs.log"
      const text = `run-slot: ${hold.who}'s run has held ${hold.slot} for ${Math.floor(hold.heldMs / 60_000)} min while ${waiters} waiter${waiters === 1 ? "" : "s"} queue${waiters === 1 ? "s" : ""}: ${command} (pid ${hold.pid}, since ${hold.since})`
      if (await ctx.send("ops", text, true)) told[key] = text
    }
  }
  if (JSON.stringify(told) !== before) await writeAtomic(toldPath, JSON.stringify(told))
}

// One kept focus card resolved, true, once no ask posted in its window is open; false while one is
const settleFocusCard = async (ctx: Context, card: FocusCardKept): Promise<boolean> => {
  const open = await ctx.run([
    "bun",
    "run",
    "--silent",
    "--cwd",
    ctx.repo,
    "ask",
    "open",
    "--since",
    card.since,
    "--until",
    card.until,
  ])
  if (open.code !== 0) throw new Error(`bun run ask open: ${lines(open.out).at(-1)}`)
  if (lines(open.out).some((line) => /^#i\d+ /.test(line.trim()))) return false
  await resolveOwn(ctx, card.id, card.by, "Everything that came in while focus stood is answered")
  return true
}

type WeekAlert = { account: string; by: string; id: string; mark: number }

// An account's week as usage.json reads it: the login's own reading, else its row among the other accounts, undefined when it holds none
const weekOf = (usage: unknown, account: string): number | undefined => {
  const u = usage as {
    account?: string
    accounts?: Record<string, { week?: number }>
    rate_limits?: { seven_day?: { used_percentage?: number } }
  } | null
  const week =
    u?.account === account
      ? u.rate_limits?.seven_day?.used_percentage
      : u?.accounts?.[account]?.week
  return typeof week === "number" ? week : undefined
}

// Each week alert the tick posted, kept in tick/week-alerts.json, resolves once usage.json reads its account's week back under its mark, which its reset does; one whose resolve fails stays for the next tick, and the first failure throws after the rest are tried.
const settleWeekAlerts = async (ctx: Context) => {
  const path = join(ctx.ops, "tick", "week-alerts.json")
  const alerts = ((await readJson(path).catch(() => [])) ?? []) as WeekAlert[]
  if (alerts.length === 0) return
  const usage = await readJson(join(ctx.ops, "..", "usage.json")).catch(() => null)
  const left: WeekAlert[] = []
  let failed: Error | undefined
  for (const alert of alerts) {
    const week = weekOf(usage, alert.account)
    if (week === undefined || week >= alert.mark) {
      left.push(alert)
      continue
    }
    try {
      await resolveOwn(
        ctx,
        alert.id,
        alert.by,
        `${alert.account}'s week reset: now ${Math.round(week)}%`,
      )
    } catch (error) {
      left.push(alert)
      failed ??= error as Error
    }
  }
  await writeAtomic(path, JSON.stringify(left))
  if (failed) throw failed
}

// A posted week alert kept by its account and mark, read from its line, so settleWeekAlerts can resolve it
const keepWeekAlert = async (ctx: Context, line: string, posted: { by: string; id: string }) => {
  const [, mark, account] = /^ALERT (9[78]) (\S+):/.exec(line) ?? []
  if (!mark || !account) return
  const path = join(ctx.ops, "tick", "week-alerts.json")
  const alerts = ((await readJson(path).catch(() => [])) ?? []) as WeekAlert[]
  await writeAtomic(path, JSON.stringify([...alerts, { account, mark: Number(mark), ...posted }]))
}

// The usage marks, the login flip, the load, the train's slot wait and the near-limit marks, each routed as the old tick routed it.
const tick = async (ctx: Context) => {
  const marks = lines((await python(ctx, "usage/week-marks.py", false)).out)
  for (const line of marks.filter((l) => l.includes("ALERT"))) {
    // an alert that fails to post is named to the builder beside its line, which prints once a week and so goes out either way
    if (/ALERT 9[78]\b/.test(line)) {
      const posted = await postAlert(ctx, line, USAGE_LINK).catch(async (error: Error) => {
        await ctx.send("builder", `Inbox alert not posted: ${error.message}`)
        return null
      })
      if (posted)
        await keepWeekAlert(ctx, line, posted).catch((error: Error) =>
          ctx.send(
            "builder",
            `Inbox week alert not kept, so it will not resolve itself: ${error.message}`,
          ),
        )
    }
    await ctx.send("builder", line)
  }
  if (ctx.now.getMinutes() === 3 && marks[0]) await ctx.send("builder", `usage: ${marks[0]}`, true)
  const flip = (await python(ctx, "usage/login-flip.py")).out.trim()
  if (flip.includes("switch due")) await ctx.send("dispatcher", flip)
  const [, load5 = 0] = await loadOf(ctx)
  if (load5 > 15) {
    await ctx.send("builder", `load5 ${load5}: ${(await loadReport(ctx)).join(" ")}`, true)
  }
  for (const line of lines((await python(ctx, "usage/near-limit.py")).out))
    await ctx.send(line.includes("ALERT") ? "builder" : "dispatcher", line)
  await switchWatch(ctx)
  await settleWeekAlerts(ctx)
}

// The account the switch watch reads, the one the factory moves off at a full week: usage.switchAccount in the data folder's policy, none while it is unset or the policy cannot be read.
export const switchAccount = async (ops: string): Promise<string> => {
  const read = await readPolicy(join(ops, ".."))
  return read.refusal === undefined ? accountSettings.get(read.settings, "usage.switchAccount") : ""
}

// While usage.json reads that account: its week at 98% told to ops, and at 100% ops-unstick's move file written for 4 hours with its text sent to both dispatchers and both leads, each once a week, marked in usage/switch-watch.json once sent (told100 once all are); with no second dispatcher seated, which the move hands the factory to, no move file is written and the first and both leads are told so, so a failed send goes again on the next tick. The move itself is the account rotation's.
const switchWatch = async (ctx: Context) => {
  const usage = (await readJson(join(ctx.ops, "..", "usage.json")).catch(() => null)) as {
    account?: string
    rate_limits?: { seven_day?: { resets_at?: number; used_percentage?: number } }
  } | null
  const account = await switchAccount(ctx.ops)
  if (!account || usage?.account !== account) return
  const handle = `${account.split("@")[0]}@`
  const week = usage.rate_limits?.seven_day ?? {}
  const used = Number(week.used_percentage ?? 0)
  const resets = Number(week.resets_at ?? 0) * 1000
  const marksPath = join(ctx.ops, "usage", "switch-watch.json")
  const marks = ((await readJson(marksPath).catch(() => ({}))) ?? {}) as Record<string, string>
  const told = (key: string) => {
    const at = Date.parse(`${marks[key]?.slice(0, 16)}Z`)
    return !Number.isNaN(at) && at > resets - 7 * 86_400_000
  }
  const mark = (key: string) => {
    marks[key] = `${isoSeconds(ctx.now).slice(0, 16)}Z`
    return writeAtomic(marksPath, JSON.stringify(marks))
  }
  if (
    used >= 98 &&
    !told("told98") &&
    (await ctx.send(
      "ops",
      `${handle} week at ${Math.round(used)}% (${isoSeconds(ctx.now).slice(11, 16)}Z)`,
      true,
    ))
  )
    await mark("told98")
  if (used >= 100 && !told("told100")) {
    const move = join(ctx.ops, "unstick", "move.json")
    const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
      agents?: unknown
    } | null
    const [first, second] = [dispatcherOf(roster?.agents, 1), dispatcherSeatOf(roster?.agents, 2)]
    if (second && !told("moved100")) {
      const text = JSON.stringify({
        to: second,
        until: isoSeconds(new Date(ctx.now.getTime() + 4 * 3_600_000)),
      })
      await writeAtomic(move, `${text}\n`)
      await mark("moved100")
    }
    const line = second
      ? `${handle} week at 100%: wrote ${move}: ${(await Bun.file(move).text()).trim()}`
      : `${handle} week at 100%: no second dispatcher is seated, so no move`
    let all = true
    for (const to of [...(second ? [second] : []), first, "builder", "ops"]) {
      if (told(`told100 ${to}`)) continue
      if (await ctx.send(to, line, true)) await mark(`told100 ${to}`)
      else all = false
    }
    if (all) await mark("told100")
  }
}

// The sessions ops-unstick reads on the usage-limit screen, each named to the builder once with the account ops-unstick read from its resume record, past the ones already told, and the account with the lowest week, by its newest usage file read in the last hour, whose 5-hour window is under spawn.sh's 90% cap, never a stuck session's own.
const limitWatch = async (ctx: Context) => {
  const state = (await readJson(join(ctx.ops, "unstick", "state.json")).catch(() => null)) as {
    blocked?: Record<string, { account?: string; kind?: string; name?: string }>
    writtenAt?: string
  } | null
  if (!state || !fresh(state.writtenAt, ctx.now, 3 * 60_000)) return
  const told = new Set(
    lines(
      await Bun.file(join(ctx.ops, "usage", "limit-told.txt"))
        .text()
        .catch(() => ""),
    ).map((l) => l.trim()),
  )
  const accounts = new Map<string, string | undefined>()
  for (const b of Object.values(state.blocked ?? {}))
    if (b.kind?.startsWith("usage-limit") && b.name && !told.has(b.name))
      accounts.set(b.name, b.account)
  if (!accounts.size) return
  const stuck = new Set(accounts.values())
  type Reading = {
    account: string
    rate_limits?: {
      five_hour?: { used_percentage?: number }
      seven_day?: { used_percentage?: number }
    }
    writtenAt: string
  }
  const newest = new Map<string, Reading>()
  for await (const path of new Bun.Glob("usage*.json").scan(join(ctx.ops, ".."))) {
    const u = (await readJson(join(ctx.ops, "..", path)).catch(() => null)) as Reading | null
    if (!u?.account || typeof u.writtenAt !== "string") continue
    if (!fresh(u.writtenAt, ctx.now, 60 * 60_000)) continue
    if ((newest.get(u.account)?.writtenAt ?? "") < u.writtenAt) newest.set(u.account, u)
  }
  let best: { account: string; week: number } | undefined
  for (const u of newest.values()) {
    const week = u.rate_limits?.seven_day?.used_percentage
    if (typeof week !== "number" || week >= 100) continue
    if ((u.rate_limits?.five_hour?.used_percentage ?? 0) >= 90) continue
    if (stuck.has(u.account)) continue
    if (!best || week < best.week) best = { account: u.account, week }
  }
  const names = [...accounts.keys()].sort()
  const sessions = names
    .map((name) => (accounts.get(name) ? `${name} (${accounts.get(name)})` : name))
    .join(" ")
  const sent = await ctx.send(
    "builder",
    `${sessions} show the usage-limit screen. ${
      best
        ? `Move each to ${best.account}, the account with the most room (week ${Math.round(best.week)}%), from its handoff.`
        : "No account has room: each waits for its reset."
    }`,
    true,
  )
  if (!sent) return
  await mkdir(join(ctx.ops, "usage"), { recursive: true })
  await appendFile(join(ctx.ops, "usage", "limit-told.txt"), `${names.join("\n")}\n`)
}

// The lead a felled session goes back to, by its kind as ops' sweep reads it: a reviewer or tester of ops' own to ops, a worker, reviewer or tester to the builder, a runner to ops, anyone else to the dispatcher.
export function leadOf(name: string, worker: unknown, kind?: unknown): string {
  const k = kindOf(name, kind)
  if ((k === "reviewer" || k === "tester") && managerKindOfName(String(worker)) === "ops")
    return "ops"
  if (k === "worker" || k === "reviewer" || k === "tester") return "builder"
  return k === "runner" ? "ops" : "dispatcher"
}

// The session that sends every queued ops line (ADR 0010), so its own resume line could never reach a lead while it is down.
const RELAY = "runner-plain-relay"
// Its brief, the resume's first prompt, since the brief has it start its wait task again, without which it relays nothing.
const RELAY_BRIEF = "brief-runner-plain-relay.md"

// The relay's resume line run here, through spawn.sh's capacity gate, rather than queued for the relay itself; never marked told, since a resume keeps the session id and the same line comes back with the next outage, so a relay still down is tried again at the next sweep; a failure is named to ops, where it waits for the relay like any other line, while relay-watch's late-stop line names the stall to whoever can act on it.
const resumeRelay = async (ctx: Context, line: string): Promise<boolean> => {
  const argv = line.trim().split(/\s+/)
  const { code, out } = await ctx.run(
    argv.includes("--brief") ? argv : [...argv, "--brief", RELAY_BRIEF],
    120_000,
  )
  if (code === 0) {
    await ctx.send("ops", `Resumed ${RELAY}: ${line.trim()}`, true)
    return true
  }
  await ctx.send(
    "ops",
    `Felled ${RELAY}; its resume failed (exit ${code}): ${lines(out).at(-1) ?? ""}`,
    true,
  )
  return false
}

// A session the roster holds on purpose, or a probe, is never named as felled.
const HELD = new Set(["done", "ended", "parked", "paused", "starting"])

type Agent = { kind?: unknown; name?: string; status?: string; worker?: unknown }

// Each resume line up.py prints, once a line, to the felled session's lead, with the SendMessage line under it.
const felled = async (ctx: Context, upPy: string, agents: Map<string | undefined, Agent>) => {
  const toldPath = join(ctx.ops, "tick", "sweep-told.txt")
  const told = new Set(
    lines(
      await Bun.file(toldPath)
        .text()
        .catch(() => ""),
    ),
  )
  const out = (await ctx.run(["python3", "-I", upPy, "--sessions"])).out.split("\n")
  const sent: string[] = []
  for (const [i, line] of out.entries()) {
    const name = /^\S*spawn\.sh resume (\S+) /.exec(line)?.[1]
    if (!name) continue
    const agent = agents.get(name)
    if (kindOf(name, agent?.kind) === "probe" || HELD.has(agent?.status ?? "")) continue
    if (name === RELAY) {
      await resumeRelay(ctx, line)
      continue
    }
    if (told.has(line)) continue
    const then = out[i + 1]?.startsWith("  then") ? ` ${out[i + 1]!.trim()}` : ""
    if (
      await ctx.send(
        leadOf(name, agent?.worker, agent?.kind),
        `Felled: ${line.trim()}${then}`,
        true,
      )
    )
      sent.push(line)
  }
  if (!sent.length) return
  await mkdir(join(ctx.ops, "tick"), { recursive: true })
  await appendFile(toldPath, sent.map((line) => `${line}\n`).join(""))
}

// ops-up every 5 minutes, so a job that went down (a reboot, a herdr server that went down) comes back with no hand step, each line it prints told to ops once until it changes.
const up = async (ctx: Context) => {
  const toldPath = join(ctx.ops, "tick", "up-told.txt")
  const told = new Set(
    lines(
      await Bun.file(toldPath)
        .text()
        .catch(() => ""),
    ),
  )
  const said = lines(
    (await ctx.run(["python3", "-I", join(ctx.repo, "scripts", "ops", "up.py")], 600_000)).out,
  )
  for (const line of said) if (!told.has(line)) await ctx.send("ops", line)
  await mkdir(join(ctx.ops, "tick"), { recursive: true })
  await Bun.write(toldPath, said.map((line) => `${line}\n`).join(""))
}

// load5 at 30 or more, told once a crossing and cleared under 22.5.
const highLoad = async (ctx: Context) => {
  const [, load5 = 0] = await loadOf(ctx)
  const toldPath = join(ctx.ops, "tick", "load-told")
  const told = await Bun.file(toldPath).exists()
  if (load5 >= 30 && !told) {
    await mkdir(join(ctx.ops, "tick"), { recursive: true })
    await Bun.write(toldPath, "")
    await ctx.send("dispatcher", `load5 ${load5} (passed 30); lanes drop to 12`)
    await ctx.send("ops", `load5 ${load5}: lanes drop to 12`)
  } else if (load5 < 22.5 && told) await unlink(toldPath)
}

// The sweep, as Ops' tick-loop runs it: felled sessions and high load, each step on its own, so one that fails is named to ops and the rest still run.
const sweep = async (ctx: Context) => {
  const upPy = join(ctx.repo, "scripts", "ops", "up.py")
  const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
    agents?: Agent[]
  } | null
  const steps: [string, () => Promise<void>][] = [
    ...(roster?.agents
      ? [
          ["felled", () => felled(ctx, upPy, new Map(roster.agents!.map((a) => [a.name, a])))] as [
            string,
            () => Promise<void>,
          ],
        ]
      : []),
    ["load", () => highLoad(ctx)],
  ]
  for (const [name, step] of steps) {
    try {
      await step()
    } catch (err) {
      await ctx.send(
        "ops",
        `ops-tick sweep: ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

const liveEnds = async (now: Date): Promise<Line[]> => {
  const input = await liveInput(1, now.getTime() / 1000)
  return autoEndSweep(input, liveDeps(input.projectsDir ?? ""))
}

// Ends each worker, reviewer and tester whose work is done (auto_end.ts), one line to its lead for each; a session it could not end is told once until its line changes.
export const autoEnd =
  (ends: (now: Date) => Promise<Line[]> = liveEnds) =>
  async (ctx: Context) => {
    const toldPath = join(ctx.ops, "tick", "auto-end-told.txt")
    const told = new Set(
      lines(
        await Bun.file(toldPath)
          .text()
          .catch(() => ""),
      ),
    )
    const said = await ends(ctx.now)
    for (const line of said) if (!told.has(line.text)) await ctx.send(line.to, line.text)
    await mkdir(join(ctx.ops, "tick"), { recursive: true })
    await Bun.write(toldPath, said.map((line) => `${line.text}\n`).join(""))
  }

// One GLM credits line in ops/log/glm-credits.log: ops-zai-usage's file while its beat is ok within 15 minutes, else the endpoint read once.
const glmCredits = async (ctx: Context) => {
  const beat = (await readJson(join(ctx.ops, "ops-zai-usage.json")).catch(() => null)) as {
    lastBeatAt?: string
    lastResult?: string
  } | null
  let line: string
  if (beat?.lastResult === "ok" && fresh(beat.lastBeatAt, ctx.now, 15 * 60_000)) {
    const usage = (await readJson(join(ctx.ops, "..", "zai-usage.json")).catch(() => null)) as {
      windows?: unknown
    } | null
    line = `cache ${JSON.stringify(usage?.windows ?? null)}`
  } else {
    line = `fresh ${lines((await python(ctx, "usage/glm-credits.py")).out)[0] ?? ""}`
  }
  await mkdir(join(ctx.ops, "log"), { recursive: true })
  await appendFile(
    join(ctx.ops, "log", "glm-credits.log"),
    `${isoSeconds(ctx.now)} ${line.slice(0, 300)}\n`,
  )
}

const freeBytes = (dir: string): number => {
  const fs = statfsSync(dir)
  return fs.bavail * fs.bsize
}

// The trash playground rm fills, beside ops in the data folder, emptied hourly: purgeTrash (@packages/safe-delete) takes each batch over 7 days old, then the oldest while its disk has under 50 GB free, deleting being cheap whatever the load, and stripTrash beside it removes each batch's node_modules folders and web/next/.next, oldest first and paced, which an install or a build rebuilds; one line in ops/log/trash-purge.log.
export const trashPurge =
  (
    trash?: string,
    free = freeBytes,
    sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) =>
  async (ctx: Context) => {
    const root = trash ?? join(dirname(ctx.ops), "trash")
    const { removed, skipped } = purgeTrash(root, { free: () => free(root), now: ctx.now })
    const strip = await stripTrash(root, { sleep })
    const line = `removed ${removed.length}${removed.length ? ` (${removed.join(", ")})` : ""}${skipped.length ? `, skipped ${skipped.join(", ")}` : ""}${strip.folders ? `, stripped ${strip.folders} folders (${strip.batches.join(", ")})` : ""}${strip.failed.length ? `, not finished (${strip.failed.join(", ")})` : ""}`
    await mkdir(join(ctx.ops, "log"), { recursive: true })
    await appendFile(join(ctx.ops, "log", "trash-purge.log"), `${isoSeconds(ctx.now)} ${line}\n`)
  }

// The idle-compaction trial (ADR 0020): the idle-compact bin sends /compact to each worker or runner of 200k+ tokens 50 to 58 minutes after its last turn, and each line it prints lands in ops/log/idle-compact.log; a failed pass throws, so the beat reads failed. PLAYGROUND_LIVE_READS names the live machine outright, since the Dashboard checkout reads it by its branch only while git answers, and a stray PLAYGROUND_FIXTURE beside it refuses into the log.
// The beat runs the bin straight from the Dashboard's checkout, not `bun run idle-compact` from ops-tick's folder: the package.json script's prebuild starts an unslotted turbo build in the main checkout right after a ship, and the bin's env validates only against the Dashboard checkout's own .env, which load-dotenv reads from the --cwd.
export const idleCompact = async (ctx: Context, checkout = dashboardCheckout(ctx.repo)) => {
  if (checkout === null) throw new Error(`idle-compact: ${NO_CHECKOUT}`)
  const pass = await ctx.run(
    [
      "env",
      "PLAYGROUND_LIVE_READS=1",
      "bun",
      "--cwd",
      join(checkout, "api/hono"),
      "--no-env-file",
      join(checkout, "api/hono/src/bin/idle-compact.ts"),
    ],
    120_000,
  )
  const said = lines(pass.out)
  if (said.length > 0) {
    await mkdir(join(ctx.ops, "log"), { recursive: true })
    await appendFile(
      join(ctx.ops, "log", "idle-compact.log"),
      said.map((line) => `${isoSeconds(ctx.now)} ${line.slice(0, 300)}\n`).join(""),
    )
  }
  if (pass.code !== 0) throw new Error(`idle-compact: ${said.at(-1) ?? `exit ${pass.code}`}`)
}

const words = (text: string) => async (ctx: Context) => void (await ctx.send("optimizer", text))

// Every worktree of the repo's clone on canary, and the leads worktree on its leads branch, kept at the head of the origin branch each tracks (canary's, and for leads the branch the install cloned, which spawn.sh's cut sets: main on a public install), so every session runs that line rather than the live checkout: a fast-forward after a fetch, never in one holding an open change, an incoming change to bun.lock or a package.json fast-forwarding and installing back to back inside one run-slot slot (a fast-forward whose install then waited 42s for a slot once left a roster.ts run on new code and old node_modules) and owing that install in tick/canary-pull-owed.json until one exits 0, and a pull or install that fails named to ops once a failure, marked by its words in tick/canary-pull-told.json and cleared once that worktree pulls and owes no install.
const canaryPull = async (ctx: Context) => {
  const list = await ctx.run(["git", "-C", ctx.repo, "worktree", "list", "--porcelain"])
  const trees = list.out
    .split("\n\n")
    .filter((block) =>
      block.split("\n").some((line) => /^branch refs\/heads\/(canary|leads)$/.test(line)),
    )
    .map((block) => block.split("\n")[0]!.replace(/^worktree /, ""))
  const toldPath = join(ctx.ops, "tick", "canary-pull-told.json")
  const told = ((await readJson(toldPath).catch(() => null)) ?? {}) as Record<string, string>
  const before = JSON.stringify(told)
  const owedPath = join(ctx.ops, "tick", "canary-pull-owed.json")
  const owed = new Set(((await readJson(owedPath).catch(() => null)) ?? []) as string[])
  const owedBefore = JSON.stringify([...owed])
  for (const tree of trees) {
    if ((await ctx.run(["git", "-C", tree, "status", "--porcelain"])).out.trim()) continue
    const fetch = await ctx.run(["git", "-C", tree, "fetch", "-q"], 120_000)
    let text = ""
    if (fetch.code !== 0)
      text = `canary-pull: ${tree} did not fetch: ${lines(fetch.out).at(-1) ?? `exit ${fetch.code}`}`
    else {
      const sha = async (ref: string) =>
        (await ctx.run(["git", "-C", tree, "rev-parse", ref])).out.trim()
      const [old, up] = [await sha("HEAD"), await sha("@{u}")]
      const incoming = await ctx.run(["git", "-C", tree, "diff", "--name-only", old, up])
      const install = owed.has(tree) || /(^|\/)(bun\.lock|package\.json)$/m.test(incoming.out)
      // a main checkout that follows canary is the one the guards load their bundles from, so its changed bundles are swapped in whole before the fast-forward (swap-bundles.ts), put back if the fast-forward fails; a swap that fails puts back what it wrote, and the pull goes on as before
      const git = (...args: string[]) => ctx.run(["git", "-C", tree, ...args])
      let swapped: string[] = []
      let putBack = { code: 0, out: "" }
      if (
        realpathSync(tree) === realpathSync(ctx.repo) &&
        (await git("merge-base", "--is-ancestor", old, up)).code === 0
      ) {
        const result = await swapBundles(tree, git, up)
        swapped = result.swapped
        putBack = result.putBack ?? putBack
      }
      const step = install
        ? await ctx.run(
            [
              join(ctx.ops, "run-slot.sh"),
              "ops-tick",
              "--",
              "bash",
              "-c",
              'git -C "$2" merge --ff-only -q "$1" && bun install --frozen-lockfile --ignore-scripts --cwd "$2"',
              "canary-pull",
              up,
              tree,
            ],
            30 * 60_000,
          )
        : await ctx.run(["git", "-C", tree, "merge", "--ff-only", "-q", up], 120_000)
      if (step.code !== 0 && swapped.length && (await sha("HEAD")) === old)
        putBack = await unswapBundles(tree, git, swapped)
      const why = lines(step.out).at(-1) ?? `exit ${step.code}`
      if (step.code === 0) {
        if (install) owed.delete(tree)
      } else if (install && ((await sha("HEAD")) !== old || old === up)) {
        owed.add(tree)
        text = `canary-pull: ${tree} did not install: ${why}`
      } else text = `canary-pull: ${tree} did not fast-forward: ${why}`
      if (putBack.code)
        text = `canary-pull: ${tree} could not put HEAD's hook bundles back: ${putBack.out}`
    }
    if (!text) delete told[tree]
    else if (told[tree] !== text && (await ctx.send("ops", text, true))) told[tree] = text
  }
  if (JSON.stringify(told) !== before) await writeAtomic(toldPath, JSON.stringify(told))
  if (JSON.stringify([...owed]) !== owedBefore)
    await writeAtomic(owedPath, JSON.stringify([...owed]))
}

// relay-watch's cycle; the relay is down once an ops line has waited two of them with no cursor of the relay's moving.
const RELAY_CYCLE_MS = 5 * 60_000

// The newest time the relay moved one of its cursors (relay.py, dm-relay.py's two), 0 with none.
const relayMovedAt = async (outbox: string): Promise<number> => {
  const times = await Promise.all(
    ["cursor.json", "dm-cursor.json", "linear-cursor.json"].map(
      async (file) => (await stat(join(outbox, file)).catch(() => null))?.mtimeMs ?? 0,
    ),
  )
  return Math.max(...times)
}

// Whether this machine runs the relay at all, by its roster row or its resume record; with neither, Ops' sweep relays the outbox (playbook SWEEP.md step 2), so the watch judges the sweep and never names the relay.
const hasRelay = async (ctx: Context): Promise<boolean> => {
  if (await Bun.file(join(ctx.ops, "..", "resume", `${RELAY}.sh`)).exists()) return true
  const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
    agents?: unknown
  } | null
  return Array.isArray(roster?.agents) && roster.agents.some((a: Agent) => a?.name === RELAY)
}

// Ops' sweep runs every 15 minutes (SESSIONS.md, Keep the sweep running), so on a machine with no relay a line may wait two sweeps before it counts as late.
const SWEEP_CYCLE_MS = 15 * 60_000

// When the watch first found no cursor.json, kept in tick/relay-watch-start until one exists: a relay that has never run leaves no cursor for pending() to read, so the lines queued since then are what it judges.
const neverRanSince = async (ctx: Context, outbox: string): Promise<string | undefined> => {
  const path = join(ctx.ops, "tick", "relay-watch-start")
  if (await Bun.file(join(outbox, "cursor.json")).exists()) {
    await unlink(path).catch(() => {})
    return undefined
  }
  const held = (
    await Bun.file(path)
      .text()
      .catch(() => "")
  ).trim()
  if (held) return held
  await writeAtomic(path, ctx.now.toISOString())
  return ctx.now.toISOString()
}

// The week-usage alert's link, a dashboard path the card resolves against the app's own URL, so no host is written here.
export const USAGE_LINK = "- 💰 Each account's week shows on the [System page](/dashboard/system)."
// Pure: the relay-down alert's link line, naming the row that relays on this machine: the relay runner under AI Runners, else Ops under Orchestrators, whose sweep relays.
export const relayLink = (relay: boolean): string =>
  relay
    ? `- 🔎 The relay's row is under AI Runners in the sidebar (${RELAY} on hover), and this Mac's state is on the [System page](/dashboard/system).`
    : "- 🔎 Ops' row is under Orchestrators in the sidebar, since its sweep relays here, and this Mac's state is on the [System page](/dashboard/system)."

// The late-stop line's text, the Inbox alert's title among its uses: the relay's own on a machine that runs it, else the sweep's, each with the next step and naming only what this machine runs.
const relayDown = (relay: boolean, moved: number): string => {
  const since = moved ? `since ${isoSeconds(new Date(moved))}` : "since the watch began"
  if (relay)
    return moved
      ? `The ops relay is down: no ops line has gone out ${since}. Resume ${RELAY}.`
      : `The ops relay has never run: no ops line has gone out ${since}. Resume ${RELAY}.`
  return moved
    ? `Ops' sweep is late: no ops line has gone out ${since}. Ops runs its sweep, whose step 2 runs ops:outbox.`
    : `The outbox relay has never run: no ops line has gone out ${since}, and this machine relays through Ops' sweep. Ops runs its sweep, whose step 2 runs ops:outbox.`
}

type RelayWatch = {
  at?: string
  by?: string
  id?: string
  pendingSince?: string
  sentAt?: string
  toldDispatcher?: string
}

// unstick.escalateMinutes in the data folder's policy, read at each pass so a change takes the next one, the window ops-session-resume gives a stuck session and the relay watch gives a late stop before the dispatcher hears of it.
export const escalateMs = async (data: string): Promise<number> => {
  const read = await readPolicy(data)
  const settings = read.settings ?? { schemaVersion: 1 as const, values: {} }
  return ruleSettings.get(settings, "unstick.escalateMinutes") * 60_000
}

// The hold Ops sets when it slows or pauses its sweep on purpose, a usage squeeze or maintenance: ops/sweep-hold-until holds a future ISO time with its zone, and while one stands the watch keeps quiet and clears its state, so it judges unheld time only and a lift never alerts for the held window; a missing, empty, past or unreadable time leaves the watch on.
const sweepHold = async (ctx: Context): Promise<boolean> => {
  const held = (
    await Bun.file(join(ctx.ops, "sweep-hold-until"))
      .text()
      .catch(() => "")
  ).trim()
  const at = held ? Date.parse(held) : Number.NaN
  return !Number.isNaN(at) && at > ctx.now.getTime()
}

// Ops itself is down when nothing reads its queue: its alerts-wait waiter holds no running pid and handed it no alert within the grace (waiterLive, the liveness the stuck alerts judge a manager by), since a roster status cannot tell a down pane from a live one, live managers reading starting for their whole run; that absence no other check reports, so the Inbox is the fallback for it alone.
const opsLive = async (ctx: Context): Promise<boolean> => {
  const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
    agents?: unknown
  } | null
  const by = managerOf(roster?.agents, "ops")
  return waiterLive(join(ctx.ops, "outbox"), by, ctx.now)
}

// One line in the managers' waiter queue (ops-stuck-alert.jsonl, stuck-alert's own shape), which each alerts-wait reads within seconds without the relay, the relay's own send of that queue standing as the backstop; the late-stop line rides it because the watch fires while the relay or the sweep that delivers every other queue is the thing that has stalled.
const queueWaiterLine = async (ctx: Context, to: string, text: string) => {
  await mkdir(join(ctx.ops, "outbox"), { recursive: true })
  await appendFile(
    join(ctx.ops, "outbox", `ops-${ALERT_JOB}.jsonl`),
    `${JSON.stringify({ at: isoSeconds(ctx.now), job: ALERT_JOB, text, to })}\n`,
  )
}

// The ops relay's watch: a line pending() reads is timed from the first cycle that reads it, and once it has waited two cycles of whoever relays (relayDown) with no cursor moved since, the stop goes to the session that can act on it, the way unstick routes a stuck session: one line into the managers' waiter queue for ops (queueWaiterLine, since the stalled relay or sweep that the stop names delivers every other channel), then one for the dispatcher once the escalation window has passed with Ops yet to pick it up; the Inbox alert under the ops manager's name posts only while Ops itself is down (opsLive), the one absence no other check reports. The state in tick/relay-watch.json keeps each stop to one line per route, the Inbox post resolved once a cursor moves after it or its item is gone, and a routed stop's state clearing once the cursor moves or nothing waits.
const relayWatch = async (ctx: Context) => {
  const outbox = join(ctx.ops, "outbox")
  const statePath = join(ctx.ops, "tick", "relay-watch.json")
  const state = (await readJson(statePath).catch(() => null)) as RelayWatch | null
  if (await sweepHold(ctx)) {
    if (state?.id && state.by)
      await resolveOwn(
        ctx,
        state.id,
        state.by,
        "The sweep hold stands: Ops set ops/sweep-hold-until, and the watch stays quiet until it passes",
      )
    if (state) await unlink(statePath)
    return
  }
  const moved = await relayMovedAt(outbox)
  const start = await neverRanSince(ctx, outbox)
  if (state?.id && state.by) {
    if (moved <= Date.parse(state.at ?? "")) return
    await resolveOwn(
      ctx,
      state.id,
      state.by,
      `The relay moved its cursor again at ${isoSeconds(new Date(moved))}`,
    )
    await unlink(statePath)
    return
  }
  if ((await pending(outbox, start)).length === 0) {
    if (state) await unlink(statePath)
    return
  }
  const since = Date.parse(state?.pendingSince ?? "")
  if (Number.isNaN(since) || moved > since) {
    await writeAtomic(statePath, JSON.stringify({ pendingSince: ctx.now.toISOString() }))
    return
  }
  const relay = await hasRelay(ctx)
  if (ctx.now.getTime() - since < 2 * (relay ? RELAY_CYCLE_MS : SWEEP_CYCLE_MS)) return
  const line = relayDown(relay, moved)
  if (!(await opsLive(ctx))) {
    if (!state?.id) {
      const { by, id } = await postAlert(ctx, line, relayLink(relay))
      await writeAtomic(
        statePath,
        JSON.stringify({ at: ctx.now.toISOString(), by, id, pendingSince: state?.pendingSince }),
      )
    }
    return
  }
  if (!state?.sentAt) {
    const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
      agents?: unknown
    } | null
    await queueWaiterLine(ctx, managerOf(roster?.agents, "ops"), line)
    await writeAtomic(
      statePath,
      JSON.stringify({ pendingSince: state?.pendingSince, sentAt: ctx.now.toISOString() }),
    )
    return
  }
  if (
    !state.toldDispatcher &&
    ctx.now.getTime() - Date.parse(state.sentAt) >= (await escalateMs(join(ctx.ops, "..")))
  ) {
    const roster = (await readJson(join(ctx.ops, "..", "roster.json")).catch(() => null)) as {
      agents?: unknown
    } | null
    await queueWaiterLine(
      ctx,
      dispatcherOf(roster?.agents, 1),
      `${line} Ops has not picked it up. Resolve it; post it to the owner's Inbox only if you cannot.`,
    )
    await writeAtomic(
      statePath,
      JSON.stringify({ ...state, toldDispatcher: ctx.now.toISOString() }),
    )
  }
}

// Each beat at its old cron, with the target its output goes to.
export const BEATS: Beat[] = [
  { cron: "*/5 * * * *", name: "roll-gate", run: rollGate, to: "ops" },
  { cron: "*/5 * * * *", name: "up", run: up, to: "ops" },
  { cron: "3,18,33,48 * * * *", name: "tick", run: tick, to: "builder, dispatcher, ops" },
  { cron: "5,15,25,35,45,55 * * * *", name: "usage-limit-watch", run: limitWatch, to: "builder" },
  { cron: "7,37 * * * *", name: "sweep", run: sweep, to: "the session's lead, ops, dispatcher" },
  { cron: "*/5 * * * *", name: "auto-end", run: autoEnd(), to: "the session's lead" },
  { cron: "43 * * * *", name: "glm-credits", run: glmCredits, to: "ops/log/glm-credits.log" },
  { cron: "7 */2 * * *", name: "optimizer-tick", run: words("optimizer tick"), to: "optimizer" },
  { cron: "13 21 * * *", name: "optimizer-daily", run: words("optimizer daily"), to: "optimizer" },
  {
    cron: "0 3 * * *",
    name: "nightly-clean",
    run: nightlyClean(),
    to: "ops/log/nightly-clean.log, the outbox line to ops, and the Inbox",
  },
  { cron: "17 * * * *", name: "trash-purge", run: trashPurge(), to: "ops/log/trash-purge.log" },
  { cron: "*/5 * * * *", name: "idle-compact", run: idleCompact, to: "ops/log/idle-compact.log" },
  { cron: "*/5 * * * *", name: "canary-pull", run: canaryPull, to: "ops, once a failed pull" },
  {
    cron: "*/5 * * * *",
    name: "relay-watch",
    run: relayWatch,
    to: "ops, then the dispatcher at unstick's escalation, and the Inbox once Ops is down",
  },
  { cron: "*/10 * * * *", name: "guard-probe", run: guardProbe, to: "dispatcher" },
  { cron: "* * * * *", name: "focus-card", run: focusCardBeat, to: "the Inbox, by bun run ask" },
  { cron: "*/5 * * * *", name: "priority-lapse", run: priorityLapse, to: "ops" },
  { cron: "*/5 * * * *", name: "run-slot-hold", run: runSlotHold, to: "ops" },
  {
    cron: "* * * * *",
    name: "dashboard-watch",
    run: dashboardWatch,
    to: "ops and a macOS banner",
  },
]

// The minute a beat last started, so a cycle that lands twice in one minute starts it once, and a beat still running is not started again.
const minuteOf = (at: Date): string => `${at.toDateString()} ${at.getHours()}:${at.getMinutes()}`

export type Runner = {
  failures: Map<string, string>
  running: Set<string>
  started: Map<string, string>
  unsent: Map<string, Unsent[]>
}
export const runner = (): Runner => ({
  failures: new Map(),
  running: new Set(),
  started: new Map(),
  unsent: new Map(),
})

export type Unsent = { text: string; to: string }

// The beat's context with a send that never throws: a failed send is named in failed and reads false, so the beat goes on and nothing it marks as told is lost, and is kept in unsent for the beat's next run unless the beat finds it again itself (again), so a line whose words change each run goes out once, as it reads then; each line is tried once a run, so a line still failing stays one copy in unsent.
export const guard = (ctx: Context, failed: string[], unsent: Unsent[] = []): Context => {
  const tried = new Map<string, Promise<boolean>>()
  const attempt = async (to: string, text: string, again?: boolean) => {
    try {
      return await ctx.send(to, text, again)
    } catch (err) {
      failed.push(`send to ${to} failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!again) unsent.push({ text, to })
      return false
    }
  }
  return {
    ...ctx,
    send: (to, text, again) => {
      const key = `${to}\n${text}`
      const known = tried.get(key)
      if (known) return known
      const result = attempt(to, text, again)
      tried.set(key, result)
      return result
    },
  }
}

// Starts every beat due this minute, each on its own so a slow one holds no other; a beat that throws or fails a send is kept by name until it next runs clean.
export function cycle(ctx: Context, state: Runner, beats: Beat[] = BEATS): Promise<void>[] {
  const minute = minuteOf(ctx.now)
  return beats
    .filter(
      (b) =>
        cronMatches(b.cron, ctx.now) &&
        state.started.get(b.name) !== minute &&
        !state.running.has(b.name),
    )
    .map(async (b) => {
      state.started.set(b.name, minute)
      state.running.add(b.name)
      const failed: string[] = []
      const unsent: Unsent[] = []
      const guarded = guard(ctx, failed, unsent)
      try {
        for (const line of state.unsent.get(b.name) ?? []) await guarded.send(line.to, line.text)
        await b.run(guarded)
        if (failed.length) state.failures.set(b.name, failed.join("; "))
        else state.failures.delete(b.name)
      } catch (err) {
        state.failures.set(b.name, err instanceof Error ? err.message : String(err))
      } finally {
        state.unsent.set(b.name, unsent)
        state.running.delete(b.name)
      }
    })
}

// The beat's result: ok, or each beat that failed and why.
export const resultOf = (state: Runner): string =>
  state.failures.size
    ? [...state.failures].map(([name, why]) => `${name}: ${why}`).join("; ")
    : "ok"

// The heartbeat api/hono/src/lib/dashboard/ops.ts reads.
export const beat = (
  path: string,
  startedAt: Date,
  now: Date,
  lastResult: string,
  job = "ops-tick",
) =>
  writeAtomic(
    path,
    `${JSON.stringify({
      cycleSeconds: CYCLE_SECONDS,
      job,
      lastBeatAt: now.toISOString(),
      lastResult,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    })}\n`,
  )
