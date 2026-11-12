import { readFileSync, statSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"

import { dispatcherOf, isManagerKind, kindOf, managerOf } from "@packages/config/kinds"

import { leadOf } from "../ops-tick/tick"
import { writeAtomic } from "../write-atomic"

const LOAD_LINE = 15
// run-slot.sh's load_line and lifted: single stands lifted once load5 has read under its cap (run-slot.load5-cap's last line while it stands, else 22, 22 at most) for LIFT_HOLD s, from the first of the readings run-slot.under holds no more than LIFT_GAP s apart; a test holds them equal to run-slot.sh's
export const LOAD_CAP = 22
export const LIFT_HOLD = 300
export const LIFT_GAP = 90
const HOUR = 3_600_000
// scripts/ops/run-slot.sh's SWITCHES, and the hours one with no expiry line stands from its mtime
export const SWITCHES = [
  "run-slot.3-off",
  "run-slot.4-off",
  "run-slot.battery",
  "run-slot.clone-off",
  "run-slot.focus",
  "run-slot.idle-min",
  "run-slot.load1-max",
  "run-slot.load5-cap",
  "run-slot.single",
  "runner-host/off",
  "runner-host/slot-off",
]
export const SWITCH_HOURS = 4

// What the last sweep saw, kept in the lead's own state file: the alerts and passed ETAs it printed (a parked row's as `parked <name> <eta>`), the closed and unreadable holds it printed, the queue line, which side of 15 the load was on, which state the single-slot flag was in and when it last listed the switches on.
type SweepState = {
  alerts: string[]
  etas: string[]
  holds?: string[]
  loadHigh: boolean
  queue: string
  single: Single | boolean
  switchesAt?: number
}

// The single-slot flag: off, on and holding slots 2 to 4, or on and lifted by the load (issue 1737)
type Single = "held" | "lifted" | "off"

type Switch = { by: string; name: string; reason: string; set: number; until: number }

// What a parked row's hold reads as: its issue, PR or Inbox item open or closed, or null when it cannot be read.
export type HoldState = "closed" | "open" | null

type Readings = {
  alerts: unknown
  cap: number
  holds: Record<string, HoldState>
  load5: number
  now: Date
  queue: unknown
  roster: unknown
  single: Single
  switches: Switch[]
}

type Row = {
  eta?: unknown
  hold?: unknown
  kind?: unknown
  lead?: unknown
  name?: unknown
  pr?: unknown
  status?: unknown
  task?: unknown
  worker?: unknown
}

const listOf = (value: unknown, key: string): unknown[] => {
  const list = (value as Record<string, unknown> | null)?.[key]
  return Array.isArray(list) ? list : []
}

const queueLine = (queue: unknown): string => {
  const prs = listOf(queue, "queue").flatMap((e) => {
    const { pr, readyAt } = (e ?? {}) as { pr?: unknown; readyAt?: unknown }
    return typeof pr === "number" ? [`#${pr}${readyAt ? " ready" : ""}`] : []
  })
  return prs.length ? prs.join(", ") : "empty"
}

// Pure: the lines this sweep prints and the state to keep. A first sweep compares every reading with a calm baseline, so it prints once what stands now.
function sweep(
  lead: string,
  r: Readings,
  prev: SweepState | null,
): { lines: string[]; next: SweepState } {
  const lines: string[] = []

  // An alert is keyed by kind and name alone, since ops-unstick rewrites some kinds' `since` every cycle; one that clears and comes back prints again.
  const alerts = listOf(r.alerts, "alerts").map((a) => {
    const { kind, line, name } = (a ?? {}) as Record<string, unknown>
    return { key: `${kind} ${name}`, text: `alert: ${kind} ${name}: ${line}` }
  })
  for (const a of alerts) if (!prev?.alerts.includes(a.key)) lines.push(a.text)

  const queue = queueLine(r.queue)
  if (queue !== (prev?.queue ?? "empty")) lines.push(`queue: ${queue}`)

  const loadHigh = r.load5 >= LOAD_LINE
  if (loadHigh !== (prev?.loadHigh ?? false))
    lines.push(
      `load5 ${r.load5.toFixed(1)}, ${loadHigh ? "at or above" : "back under"} ${LOAD_LINE}`,
    )
  // a cursor from before issue 1737 kept the flag as a boolean
  const was = typeof prev?.single === "string" ? prev.single : prev?.single ? "held" : "off"
  if (r.single !== was) {
    const load = `load5 ${r.load5.toFixed(1)}`
    lines.push(
      r.single === "off"
        ? "single slot: off"
        : r.single === "held"
          ? `single slot: on, held by load until load5 holds under ${r.cap} for 5 min (${load})`
          : `single slot: on, lifted under the cap: ${load} has held under ${r.cap} for 5 min`,
    )
  }

  const agents = listOf(r.roster, "agents") as Row[]
  const mine = agents.filter(
    (row) =>
      typeof row.name === "string" && row.status !== "ended" && ownerOf(agents, row) === lead,
  )
  const about = (row: Row) =>
    typeof row.pr === "string"
      ? ` (${row.pr})`
      : typeof row.task === "string"
        ? ` (${row.task})`
        : ""
  const passed = mine.flatMap((row) => {
    const { eta, name } = row
    if (typeof eta !== "string") return []
    const at = Date.parse(eta)
    if (isNaN(at) || at > r.now.getTime()) return []
    return row.status === "parked"
      ? [{ key: `parked ${name} ${eta}`, text: `parked past eta: ${name} ${eta}${about(row)}` }]
      : [{ key: `${name} ${eta}`, text: `eta passed: ${name} ${eta}${about(row)}` }]
  })
  for (const p of passed) if (!prev?.etas.includes(p.key)) lines.push(p.text)

  // a parked row's hold that has closed, or that no read reaches, prints once a row and hold; one known closed stays in the cursor, so it is not read again
  const holds = mine.flatMap((row) => {
    const hold = readableHold(row)
    if (hold === null) return []
    const { name } = row
    const closed = `closed ${name} ${hold}`
    if (prev?.holds?.includes(closed)) return [{ key: closed, text: "" }]
    const state = r.holds[hold]
    if (state === "closed")
      return [{ key: closed, text: `parked on closed hold: ${name} ${hold}${about(row)}` }]
    if (state === null)
      return [
        {
          key: `unreadable ${name} ${hold}`,
          text: `parked hold unreadable: ${name} ${hold}${about(row)}`,
        },
      ]
    return []
  })
  for (const h of holds) if (h.text && !prev?.holds?.includes(h.key)) lines.push(h.text)

  // a hand-set switch kept the runner box idle for two days, so each one on is listed once an hour
  const now = r.now.getTime()
  let switchesAt = r.switches.length ? (prev?.switchesAt ?? 0) : 0
  if (r.switches.length && now - switchesAt >= HOUR) {
    switchesAt = now
    for (const s of r.switches) {
      const age = Math.max(0, now - s.set)
      const why = s.by ? `by ${s.by}: ${s.reason}` : "no reason, set by hand"
      lines.push(
        `switch on: ${s.name} for ${Math.floor(age / HOUR)}h${Math.floor((age % HOUR) / 60_000)}m, until ${new Date(s.until).toISOString().slice(0, 19)}Z, ${why}`,
      )
    }
  }

  return {
    lines,
    next: {
      alerts: alerts.map((a) => a.key),
      etas: passed.map((p) => p.key),
      holds: holds.map((h) => h.key),
      loadHigh,
      queue,
      single: r.single,
      switchesAt,
    },
  }
}

// The lead a row reports to: its own lead=, else every probe's is ops' and a manager kind's its seat holder, else the dispatcher.
const ownerOf = (agents: Row[], row: Row): string => {
  const name = row.name as string
  const kind = kindOf(name, row.kind) === "probe" ? "ops" : leadOf(name, row.worker, row.kind)
  if (typeof row.lead === "string") return row.lead
  return isManagerKind(kind) ? managerOf(agents, kind) : dispatcherOf(agents, 1)
}

// A hold the sweep reads: an issue or PR (#<n>) or an Inbox item (#i<n>); a decision (d-<n>) never closes, so its row is caught by its ETA alone.
const HELD_ON = /^#i?\d+$/

// The hold a parked row names that the sweep reads, else null.
const readableHold = (row: Row): string | null =>
  row.status === "parked" &&
  typeof row.name === "string" &&
  typeof row.hold === "string" &&
  HELD_ON.test(row.hold)
    ? row.hold
    : null

// Reads each hold on this machine: an issue or PR through gh in factory.repo, an Inbox item through bun run ask get in the Dashboard's checkout, which holds the Inbox's database; null when neither reads.
export const readHold =
  (repo: string, factory: string) =>
  async (hold: string): Promise<HoldState> => {
    try {
      if (hold.startsWith("#i")) {
        const { dashboardCheckout } = await import("./probe")
        const checkout = dashboardCheckout(repo)
        if (!checkout) return null
        const run = Bun.spawnSync(["bun", "run", "--cwd", checkout, "ask", "get", hold], {
          stderr: "ignore",
          stdout: "pipe",
        })
        const out = run.stdout.toString()
        if (run.exitCode !== 0) return null
        const { status } = JSON.parse(out.slice(out.indexOf("{"))) as { status?: unknown }
        return typeof status === "string" ? (status === "open" ? "open" : "closed") : null
      }
      const run = Bun.spawnSync(
        ["gh", "api", `repos/${factory}/issues/${hold.slice(1)}`, "--jq", ".state"],
        { stderr: "ignore", stdout: "pipe" },
      )
      const state = run.stdout.toString().trim()
      return run.exitCode === 0 && (state === "open" || state === "closed") ? state : null
    } catch {
      return null
    }
  }

// The leads a sweep serves: whoever holds the builder's and ops' seats in the roster.
const leadsOf = (roster: unknown): string[] =>
  (["builder", "ops"] as const).map((kind) => managerOf(listOf(roster, "agents"), kind))

// A cursor file of another shape counts as no cursor, so the sweep after it starts afresh.
const isState = (value: unknown): SweepState | null => {
  const v = value as Partial<SweepState> | null
  return v && Array.isArray(v.alerts) && Array.isArray(v.etas) ? (v as SweepState) : null
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// Each switch on, read as run-slot.sh reads it: its "<who> <iso set> <iso expiry> <reason>" line, else set at its mtime for SWITCH_HOURS.
const switchesOn = (ops: string, now: Date): Switch[] =>
  SWITCHES.flatMap((name) => {
    const path = join(ops, name)
    let line: string
    let mtime: number
    try {
      line = readFileSync(path, "utf8").split("\n")[0] ?? ""
      mtime = statSync(path).mtimeMs
    } catch {
      return []
    }
    const m = /^(\S+) ([\d-]{10}T[\d:]{8}Z) ([\d-]{10}T[\d:]{8}Z) (.*)/.exec(line)
    const s = m
      ? { by: m[1]!, name, reason: m[4]!, set: Date.parse(m[2]!), until: Date.parse(m[3]!) }
      : { by: "", name, reason: "", set: mtime, until: mtime + SWITCH_HOURS * HOUR }
    return s.until > now.getTime() ? [s] : []
  })

// run-slot.sh's load_line: the cap single's lift reads
const capOf = (ops: string, switches: Switch[]): number => {
  if (!switches.some((s) => s.name === "run-slot.load5-cap")) return LOAD_CAP
  try {
    const last = readFileSync(join(ops, "run-slot.load5-cap"), "utf8").trimEnd().split("\n").at(-1)
    return last && /^\d{1,3}$/.test(last) ? Math.min(Number(last), LOAD_CAP) : LOAD_CAP
  } catch {
    return LOAD_CAP
  }
}

// run-slot.sh's lifted, read with no write: whether load5 under the cap has held LIFT_HOLD s from run-slot.under's first second, its last reading no more than LIFT_GAP s back
const singleOf = (ops: string, on: boolean, cap: number, load5: number, now: Date): Single => {
  if (!on) return "off"
  let first = NaN
  let last = NaN
  try {
    const parts = readFileSync(join(ops, "run-slot.under"), "utf8").trim().split(" ")
    first = Number(parts[0])
    last = Number(parts[1])
  } catch {
    // no reading under the cap yet
  }
  const at = now.getTime() / 1000
  return load5 < cap && at - last <= LIFT_GAP && at - first >= LIFT_HOLD ? "lifted" : "held"
}

// `playground sweep <lead>`: one read of what changed since that lead's last sweep (and, for ops' lead, each switch on, once an hour), `quiet` when nothing did, its cursor in sweep/<lead>.json in the data folder.
export async function runSweep(
  lead: string,
  dir: string,
  now = new Date(),
  load5 = loadavg()[1],
  hold: (hold: string) => Promise<HoldState> = async () => null,
): Promise<string[]> {
  const roster = readJson(join(dir, "roster.json"))
  const leads = leadsOf(roster)
  const [, opsLead] = leads
  if (!leads.includes(lead))
    throw new Error(`playground sweep takes a lead's name (${leads.join(" or ")}), not ${lead}`)
  const statePath = join(dir, "sweep", `${lead}.json`)
  const prev = isState(readJson(statePath))
  const ops = join(dir, "ops")
  const switches = switchesOn(ops, now)
  const cap = capOf(ops, switches)
  // only the lead's own parked rows' holds are read, and none already known closed
  const agents = listOf(roster, "agents") as Row[]
  const holds: Record<string, HoldState> = {}
  for (const row of agents) {
    const held = readableHold(row)
    if (
      held === null ||
      ownerOf(agents, row) !== lead ||
      prev?.holds?.includes(`closed ${row.name} ${held}`) ||
      held in holds
    )
      continue
    holds[held] = await hold(held)
  }
  const { lines, next } = sweep(
    lead,
    {
      alerts: readJson(join(dir, "ops", "alerts-pending.json")),
      cap,
      holds,
      load5,
      now,
      queue: readJson(join(dir, "merge-queue.json")),
      roster,
      single: singleOf(
        ops,
        switches.some((s) => s.name === "run-slot.single"),
        cap,
        load5,
        now,
      ),
      switches: lead === opsLead ? switches : [],
    },
    prev,
  )
  await writeAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`)
  return lines.length ? lines : ["quiet"]
}
