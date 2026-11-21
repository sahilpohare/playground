"use client"

import type {
  AccountUsage,
  Pressure,
  SystemReport,
  Usage,
  UsageWindow,
  ZaiUsage,
  ZaiWindow,
} from "@api/hono"
import { useQuery } from "@tanstack/react-query"

import { apiClient, unwrap } from "@/lib/api/client"
import { messageTime, relativeTime } from "@/lib/time"

export const SYSTEM_QUERY_KEY = ["dashboard", "system"] as const

// The API samples every 30s, so reading as often shows each sample once.
export const SYSTEM_REFRESH_MS = 30_000

export async function fetchSystem(): Promise<SystemReport> {
  const { data, error } = await unwrap(apiClient.v1.system.$get())
  if (error) throw new Error(error.message)
  return data
}

// Restart herdr: the API starts `playground herdr restart` and answers at once, before the restart takes it down; a refusal throws its reason.
export async function restartHerdr() {
  const { data, error } = await unwrap(apiClient.v1.system.herdr.restart.$post())
  if (error) throw new Error(error.message)
  return data
}

// The sidebar's System status and the Dashboard's panel share this one query, so they read the same sample; only the owner rung may read it.
export const useSystem = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: fetchSystem,
    refetchInterval: SYSTEM_REFRESH_MS,
    staleTime: 10_000,
  })

// The user menu's account, from the same query on no timer of its own, so /console starts no polling and the Dashboard's stats keep it fresh there. A disabled query stays pending, so only an owner waits on it, and a query with no data reads pending again on every refetch, so only the first read is waited on.
export const useAccount = (enabled: boolean) => {
  const { data, errorUpdateCount, isPending } = useQuery({
    enabled,
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: fetchSystem,
    select: (report) => report.account,
    staleTime: 10_000,
  })
  return { account: data, pending: enabled && isPending && errorUpdateCount === 0 }
}

const GB = 1024 ** 3
const MB = 1024 ** 2

// Pure: a size as the panel writes it, in GB from one up and in MB below.
export const sizeLabel = (bytes: number | null): string => {
  if (bytes === null) return "-"
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`
}

// Pure: a checkout by the part that tells it apart: a worktree by its name, anything else by its last two folders.
export const checkoutLabel = (checkout: string): string => {
  const worktree = /\/\.claude\/worktrees\/([^/]+)/.exec(checkout)?.[1]
  return worktree ?? checkout.split("/").filter(Boolean).slice(-2).join("/")
}

export const PRESSURE_LABELS: Record<Pressure, string> = {
  critical: "Critical",
  normal: "Normal",
  warn: "Warn",
}

type Machine = SystemReport["machines"][number]
type MachineReading = NonNullable<Machine["reading"]>

// One System figure summed over the cluster: its value, the marker it carries while a machine does not read, its hover split by machine as a + b, and, where it differs from one machine's, its detail.
export type ClusterFigure = { detail?: string; hover: string; marker: string | null; value: string }

const tenth = (n: number): number => Math.round(n * 10) / 10

const sumOf = (parts: (number | null)[]): number | null =>
  parts.some((n) => n === null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0)

const usedOf = (size: { totalBytes: number; usedBytes: number | null } | null): string =>
  size ? `${sizeLabel(size.usedBytes)} of ${sizeLabel(size.totalBytes)}` : "-"

// Pure: a cluster's machines that read, the marker `1 of 2 machines` while one did not (null while all read), and each that did not by name with since when and its reason, which clusterOf and clusterReadings both read.
function machinesOf(machines: Machine[], now: Date) {
  const up = machines.flatMap((m) => (m.reading ? [{ name: m.name, reading: m.reading }] : []))
  const down = machines.flatMap((m) =>
    m.down
      ? [`${m.name} unreachable since ${messageTime(m.down.since, now)}: ${m.down.reason}`]
      : [],
  )
  return {
    down,
    marker: down.length > 0 ? `${up.length} of ${machines.length} machines` : null,
    up,
  }
}

// Pure: the memory, CPU load, swap and disk free figures summed over every machine that read, each hover naming each machine's part (`machine-a 3.1 on 10 + machine-b 2.4 on 10 cores`); a machine that did not read is never a zero: its figures carry the marker `1 of 2 machines`, and the hover its reason and since when. Null with one machine, so a stack with no peers shows its own figures as before.
export function clusterOf(
  machines: Machine[],
  pressure: Pressure | null,
  now: Date,
): Record<"cpu" | "disk" | "memory" | "swap", ClusterFigure> | null {
  if (machines.length < 2) return null
  const { down: why, marker, up } = machinesOf(machines, now)
  const figure = (
    value: string,
    split: (r: MachineReading) => string,
    unit = "",
    detail?: string,
  ): ClusterFigure => ({
    ...(detail === undefined ? {} : { detail }),
    hover: [up.map((m) => `${m.name} ${split(m.reading)}`).join(" + ") + unit, ...why].join("\n"),
    marker,
    value,
  })
  const readings = up.map((m) => m.reading)
  const cores = readings.reduce((sum, r) => sum + r.cores, 0)
  const loads = [0, 1, 2].map((i) => tenth(readings.reduce((sum, r) => sum + r.load[i]!, 0)))
  const memory = {
    totalBytes: readings.reduce((sum, r) => sum + r.memory.totalBytes, 0),
    usedBytes: sumOf(readings.map((r) => r.memory.usedBytes)),
  }
  const swaps = readings.flatMap((r) => (r.swap ? [r.swap] : []))
  const swap =
    swaps.length === 0
      ? null
      : {
          totalBytes: swaps.reduce((sum, s) => sum + s.totalBytes, 0),
          usedBytes: swaps.reduce((sum, s) => sum + s.usedBytes, 0),
        }
  const disks = readings.flatMap((r) => (r.disk ? [r.disk] : []))
  const disk =
    disks.length === 0
      ? null
      : {
          freeBytes: disks.reduce((sum, d) => sum + d.freeBytes, 0),
          totalBytes: disks.reduce((sum, d) => sum + d.totalBytes, 0),
        }
  const free =
    memory.usedBytes === null || memory.totalBytes === 0
      ? "Free share unknown"
      : `${Math.round(100 - (memory.usedBytes * 100) / memory.totalBytes)}% free`
  return {
    cpu: figure(
      `${loads[0]} on ${cores} cores`,
      (r) => `${tenth(r.load[0])} on ${r.cores}`,
      " cores",
      `1, 5 and 15 min.: ${loads.join(" / ")}`,
    ),
    disk: figure(
      disk ? sizeLabel(disk.freeBytes) : "-",
      (r) => (r.disk ? sizeLabel(r.disk.freeBytes) : "-"),
      "",
      disk ? `of ${sizeLabel(disk.totalBytes)}` : "Could not be read",
    ),
    memory: figure(
      usedOf(memory),
      (r) => usedOf(r.memory),
      "",
      `${free} · pressure ${pressure ? PRESSURE_LABELS[pressure] : "unknown"} on ${machines[0]!.name}`,
    ),
    swap: figure(usedOf(swap), (r) => usedOf(r.swap)),
  }
}

// The API samples every 30s, so a report older than this means sampling has stopped and its numbers are no longer the machine's.
export const SYSTEM_STALE_MS = 90_000

export const isStale = (sampledAt: string, now: number): boolean =>
  now - Date.parse(sampledAt) > SYSTEM_STALE_MS

// Pure: a share of a total as a whole percent, 0 when there is no total.
export const shareOf = (part: number | null, total: number | null): number =>
  part === null || !total ? 0 : Math.min(100, Math.max(0, Math.round((part / total) * 100)))

// Pure: when a window resets, as a time today or a weekday and time later.
export const resetLabel = (iso: string, now: number, locale?: string): string => {
  const at = new Date(iso)
  const today = new Date(now).toDateString() === at.toDateString()
  return at.toLocaleString(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(today ? {} : { weekday: "short" }),
  })
}

// Pure: a window's reset, past ("reset") or ahead ("resets"), so a remembered window shows it has ended.
const resetPhrase = (resetsAt: string, now: number): string =>
  `${Date.parse(resetsAt) <= now ? "reset" : "resets"} ${resetLabel(resetsAt, now)}`

const lastSeen = (seenAt: string, now: number): string =>
  `last seen ${relativeTime(seenAt, new Date(now))}`

const readAgo = (writtenAt: string, now: number): string =>
  `read ${relativeTime(writtenAt, new Date(now))}`

const windowPhrase = (
  label: string,
  window: UsageWindow | null,
  writtenAt: string,
  now: number,
): string | null =>
  window
    ? [
        `${Math.round(window.usedPercent)}% of the ${label}`,
        window.seenAt && "stale",
        window.resetsAt && resetPhrase(window.resetsAt, now),
        window.seenAt ? lastSeen(window.seenAt, now) : readAgo(writtenAt, now),
      ]
        .filter(Boolean)
        .join(", ")
    : null

// Pure: the usage windows in one line, or what is missing.
export const usageLine = (usage: Usage | null, now: number): string => {
  if (!usage) return "No reading yet: the usage job writes it every 5 minutes"
  return [
    windowPhrase("5-hour window", usage.fiveHour, usage.writtenAt, now),
    windowPhrase("week", usage.sevenDay, usage.writtenAt, now),
  ]
    .filter(Boolean)
    .join(" · ")
}

// How a reading, and the machine, reads: green, amber when something is worth a look (the sidebar draws it orange, its caution token), red when it needs action now.
export type Health = "amber" | "green" | "red"

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// The weekly window's pace: 9 points a day from its start, so a week that keeps to it ends at 63% with room to spare.
export const PACE_PER_DAY = 9

// Pure: the share of the weekly window spent so far at pace, or null when its reset is unknown.
export const weekPace = (sevenDay: UsageWindow | null, now: number): number | null => {
  const resets = sevenDay?.resetsAt ? Date.parse(sevenDay.resetsAt) : Number.NaN
  if (Number.isNaN(resets)) return null
  const elapsed = Math.min(WEEK_MS, Math.max(0, now - (resets - WEEK_MS)))
  return (elapsed / DAY_MS) * PACE_PER_DAY
}

export type ReadingKey = "cpu" | "disk" | "fiveHour" | "memory" | "swap" | "week"

export type ReadingLevels = { below?: true; critical: number; unit: string; warn: number }

// Memory has no row: its colour is the memory pressure (memoryLevel; macOS's level, on Linux PSI's), since the share used sits high on a Mac that is fine.
export type LevelKey = Exclude<ReadingKey, "memory">

// The one table of levels the System readings and systemHealth both read, so the sidebar and the Dashboard cannot disagree. Each reading is orange over its warning level and red over its critical one; a reading marked below is worse the lower it goes. CPU is the 5-minute load a core, disk the GB free, the rest a share used. Swap's levels sit high, since macOS grows swap as it needs it and a Mac at work sits past 85% (a permanently red mark is noise).
export const READING_LEVELS: Record<LevelKey, ReadingLevels> = {
  cpu: { critical: 1, unit: " a core", warn: 0.8 },
  disk: { below: true, critical: 20, unit: " GB", warn: 50 },
  fiveHour: { critical: 90, unit: "%", warn: 70 },
  swap: { critical: 97, unit: "%", warn: 90 },
  week: { critical: 90, unit: "%", warn: 70 },
}

// One account's row in a combined window's tooltip: its share as a 10-cell bar in its level's colour, its next reset, and its status, exhausted or its pace; none marks a 5-hour row for an account that has no 5-hour window.
export type UsageRow = {
  account: string
  cells: number
  current: boolean
  exhausted: boolean
  level: Health
  name: string
  none?: true
  reset: string
  stale: boolean
  status: string
  used: number | null
}

// One account's line under the Week's Renews: when its plan ends or renews.
export type RenewRow = { account: string; name: string; words: string }

// One reading on the System status's readings line: its value alone (57, 3.1), its level, why it reads so (a line per rule it crossed, for systemHealth), its full wording for the hover and screen readers, and stale when it is a usage window the file no longer holds. Name, measure and state are its own tooltip's three lines. A usage window combined across accounts carries its rows and, for the week, its Renews lines in their place.
export type Reading = {
  key: ReadingKey
  level: Health
  measure: string
  name: string
  reasons: string[]
  renews?: RenewRow[]
  rows?: UsageRow[]
  stale?: true
  state: string
  title: string
  value: string
}

// Each reading's name, the first line of its own tooltip and the prefix its phrase starts with.
const NAME_OF: Record<ReadingKey, string> = {
  cpu: "Load",
  disk: "Disk",
  fiveHour: "5-hour window",
  memory: "Memory",
  swap: "Swap",
  week: "Week",
}

type Hit = { level: Exclude<Health, "green">; reason: string }

// Pure: a value against its row of READING_LEVELS, as a hit when it crosses a level, else the words for where it sits.
export function levelOf(
  key: LevelKey,
  value: number,
  phrase: string,
): { hit: Hit | null; words: string } {
  const { below, critical, unit, warn } = READING_LEVELS[key]
  const past = (limit: number) => (below ? value < limit : value > limit)
  const side = below ? "under" : "over"
  if (past(critical)) {
    const reason = `${phrase}, ${side} the ${critical}${unit} critical level`
    return { hit: { level: "red", reason }, words: reason }
  }
  if (past(warn)) {
    const reason = `${phrase}, ${side} the ${warn}${unit} warning level`
    return { hit: { level: "amber", reason }, words: reason }
  }
  return {
    hit: null,
    words: `${phrase}, ${below ? "above" : "below"} the ${warn}${unit} warning level`,
  }
}

// Pure: one reading from its level against the table and any other rule it crossed, the worst setting its colour. Phrase is what was judged ("Disk 42 GB free"), the prefix its words start with, so the tooltip's measure and state split out of them, every rule it crossed naming itself in the state, the phrase left off each.
const reading = (
  key: ReadingKey,
  value: string,
  judged: { hit: Hit | null; words: string },
  phrase: string,
  others: Hit[] = [],
  judgedState = judged.words.startsWith(`${phrase}, `) ? judged.words.slice(phrase.length + 2) : "",
  state = [
    judgedState,
    ...others.map((hit) =>
      hit.reason.startsWith(`${phrase}, `) ? hit.reason.slice(phrase.length + 2) : hit.reason,
    ),
  ]
    .filter(Boolean)
    .join("; "),
): Reading => {
  const hits = judged.hit ? [judged.hit, ...others] : others
  const red = hits.filter((hit) => hit.level === "red")
  const amber = hits.filter((hit) => hit.level === "amber")
  return {
    key,
    level: red.length ? "red" : amber.length ? "amber" : "green",
    measure: phrase.slice(NAME_OF[key].length + 1),
    name: NAME_OF[key],
    reasons: [...red, ...amber].map((hit) => hit.reason),
    state,
    title: [judged.words, ...others.map((hit) => hit.reason)].join("; "),
    value,
  }
}

// Pure: memory's level from the memory pressure (macOS's level, on Linux PSI's), as the System page reads it: normal green, warn orange, critical red, whatever the share used. Unknown pressure judges nothing.
export function memoryLevel(
  pressure: Pressure | null,
  used: number | null,
): { hit: Hit | null; words: string } {
  const share = used === null ? "" : `, ${used}% used`
  if (pressure === "critical") {
    const reason = `Memory pressure critical${share}`
    return { hit: { level: "red", reason }, words: reason }
  }
  if (pressure === "warn") {
    const reason = `Memory pressure warn${share}`
    return { hit: { level: "amber", reason }, words: reason }
  }
  if (used === null) return { hit: null, words: "Memory used could not be read" }
  return { hit: null, words: `Memory ${used}% used${pressure ? ", pressure normal" : ""}` }
}

// Pure: disk free as the readings line writes it, in at most three characters: whole GB below 1000, whole TB from there (1T).
export const diskValue = (gb: number): string =>
  gb < 999.5 ? String(Math.round(gb)) : `${Math.round(gb / 1024)}T`

// Pure: every reading the System readings show, always, in its order (memory, CPU, swap, disk, the week, then the 5-hour window last), each judged by READING_LEVELS, memory by its pressure; a reading that could not be read is left out. The week is also orange over its pace, so the rule systemHealth kept before the table still counts. Values drop their unit and keep to three characters, so each takes a fixed slot in the stock sidebar; the hover says it in words. With peers (report.machines), memory, CPU, swap and disk are the cluster's sums as the table shows them (clusterReadings).
export function systemReadings(report: SystemReport, now: number): Reading[] {
  const { cpu, disk, memory } = report
  const readings: Reading[] = []
  if (report.machines.length > 1) {
    readings.push(...clusterReadings(report.machines, memory.pressure, new Date(now)))
  } else {
    const used = memory.usedBytes === null ? null : shareOf(memory.usedBytes, memory.totalBytes)
    const judgedMemory = memoryLevel(memory.pressure, used)
    if (used !== null || judgedMemory.hit) {
      readings.push(
        reading(
          "memory",
          used === null ? "-" : String(used),
          judgedMemory,
          used === null ? "Memory" : `Memory ${used}% used`,
          [],
          memory.pressure ? `pressure ${memory.pressure}` : "",
        ),
      )
    }
    const load = cpu.load[1]
    const loadPhrase = `Load ${loadLabel(load)} on ${cpu.cores} cores, 5 min.`
    readings.push(
      reading("cpu", loadLabel(load), levelOf("cpu", load / cpu.cores, loadPhrase), loadPhrase),
    )
    if (memory.swap) {
      const swap = shareOf(memory.swap.usedBytes, memory.swap.totalBytes)
      const swapPhrase = `Swap ${swap}% used`
      readings.push(reading("swap", String(swap), levelOf("swap", swap, swapPhrase), swapPhrase))
    }
  }
  if (disk && report.machines.length <= 1) {
    const gb = Math.round(disk.freeBytes / GB)
    const diskPhrase = `Disk ${gb} GB free`
    readings.push(reading("disk", diskValue(gb), levelOf("disk", gb, diskPhrase), diskPhrase))
  }
  readings.push(...combinedUsage(report, now))
  return readings
}

// Pure: memory, CPU, swap and disk free summed over every machine that read, as clusterOf sums them for the table: each value the cluster's, its level the worst machine's own with that machine named in its reason, its hover the split naming each machine, then each machine that did not read, by name, with its reason and since when. Memory pressure is this machine's alone (the first), so its reason names it.
function clusterReadings(machines: Machine[], pressure: Pressure | null, now: Date): Reading[] {
  const { down, marker, up } = machinesOf(machines, now)
  const missing = marker ? [marker, ...down] : []
  const each = marker ? " on each machine that read" : " on each machine"
  const withSplit = (r: Reading, split: string): Reading => ({
    ...r,
    title: [r.title, split, ...missing].join("\n"),
  })
  const worst = (hits: (Hit | null)[]): Hit[] => {
    const crossed = hits.filter((hit): hit is Hit => hit !== null)
    return [
      ...crossed.filter((h) => h.level === "red"),
      ...crossed.filter((h) => h.level === "amber"),
    ]
  }
  const readings: Reading[] = []

  const totalBytes = up.reduce((sum, m) => sum + m.reading.memory.totalBytes, 0)
  const usedBytes = sumOf(up.map((m) => m.reading.memory.usedBytes))
  const used = usedBytes === null ? null : shareOf(usedBytes, totalBytes)
  const here = machines[0]!.name
  const pressureHit: Hit | null =
    pressure === "critical" || pressure === "warn"
      ? {
          level: pressure === "critical" ? "red" : "amber",
          reason: `Memory pressure ${pressure} on ${here}`,
        }
      : null
  if (up.length > 0 && (used !== null || pressureHit)) {
    const phrase = used === null ? "Memory" : `Memory ${used}% used`
    readings.push(
      withSplit(
        reading(
          "memory",
          used === null ? "-" : String(used),
          {
            hit: null,
            words: pressure === "normal" ? `${phrase}, pressure normal on ${here}` : phrase,
          },
          phrase,
          pressureHit ? [pressureHit] : [],
          pressure && !pressureHit ? `pressure ${pressure} on ${here}` : "",
        ),
        up
          .map((m) => {
            const own = m.reading.memory
            return `${m.name} ${own.usedBytes === null ? "-" : `${shareOf(own.usedBytes, own.totalBytes)}%`}`
          })
          .join(" + ") + " used",
      ),
    )
  }

  if (up.length > 0) {
    const load = up.reduce((sum, m) => sum + m.reading.load[1], 0)
    const cores = up.reduce((sum, m) => sum + m.reading.cores, 0)
    const phrase = `Load ${loadLabel(load)} on ${cores} cores, 5 min.`
    const hits = worst(
      up.map(
        (m) =>
          levelOf(
            "cpu",
            m.reading.load[1] / m.reading.cores,
            `${m.name} load ${loadLabel(m.reading.load[1])} on ${m.reading.cores} cores`,
          ).hit,
      ),
    )
    const words = hits.length ? phrase : `${levelOf("cpu", load / cores, phrase).words}${each}`
    readings.push(
      withSplit(
        reading("cpu", loadLabel(load), { hit: null, words }, phrase, hits),
        up
          .map((m) => `${m.name} ${loadLabel(m.reading.load[1])} on ${m.reading.cores}`)
          .join(" + ") + " cores, 5 min.",
      ),
    )
  }

  const swapped = up.flatMap((m) =>
    m.reading.swap ? [{ name: m.name, swap: m.reading.swap }] : [],
  )
  if (swapped.length > 0) {
    const swap = shareOf(
      swapped.reduce((sum, m) => sum + m.swap.usedBytes, 0),
      swapped.reduce((sum, m) => sum + m.swap.totalBytes, 0),
    )
    const phrase = `Swap ${swap}% used`
    const shares = swapped.map((m) => ({
      name: m.name,
      share: shareOf(m.swap.usedBytes, m.swap.totalBytes),
    }))
    const hits = worst(
      shares.map((m) => levelOf("swap", m.share, `${m.name} swap ${m.share}% used`).hit),
    )
    const words = hits.length ? phrase : `${levelOf("swap", swap, phrase).words}${each}`
    readings.push(
      withSplit(
        reading("swap", String(swap), { hit: null, words }, phrase, hits),
        shares.map((m) => `${m.name} ${m.share}%`).join(" + ") + " used",
      ),
    )
  }

  const disked = up.flatMap((m) =>
    m.reading.disk ? [{ gb: Math.round(m.reading.disk.freeBytes / GB), name: m.name }] : [],
  )
  if (disked.length > 0) {
    const gb = disked.reduce((sum, m) => sum + m.gb, 0)
    const phrase = `Disk ${gb} GB free`
    const hits = worst(
      disked.map((m) => levelOf("disk", m.gb, `${m.name} disk ${m.gb} GB free`).hit),
    )
    const words = hits.length
      ? phrase
      : `${levelOf("disk", gb, phrase).words}${disked.length === up.length ? each : ""}`
    readings.push(
      withSplit(
        reading("disk", diskValue(gb), { hit: null, words }, phrase, hits),
        up
          .map((m) => {
            const own = m.reading.disk
            return `${m.name} ${own ? Math.round(own.freeBytes / GB) : "-"}`
          })
          .join(" + ") + " GB free",
      ),
    )
  }
  return readings
}

// Pure: the week and the 5-hour window from usage.json alone, as the readings read with one account or none.
const singleUsage = (usage: Usage | null, now: number): Reading[] => {
  const readings: Reading[] = []
  const resetWords = (window: UsageWindow) =>
    window.resetsAt ? `, ${resetPhrase(window.resetsAt, now)}` : ""
  const readWords = usage ? `, ${readAgo(usage.writtenAt, now)}` : ""
  // a remembered window is the last one the dashboard saw, almost always one that has since reset, so it shows as stale and judges nothing
  const remembered = (
    key: ReadingKey,
    phrase: string,
    window: UsageWindow,
    seenAt: string,
  ): Reading => {
    const title = `${phrase}, stale${resetWords(window)}; ${lastSeen(seenAt, now)}, the usage job has not written it since`
    return {
      key,
      level: "green",
      measure: phrase.slice(NAME_OF[key].length + 1),
      name: NAME_OF[key],
      reasons: [],
      stale: true,
      state: title.slice(phrase.length + 2),
      title,
      value: String(Math.round(window.usedPercent)),
    }
  }
  const week = usage?.sevenDay ?? null
  if (week?.seenAt) {
    readings.push(
      remembered("week", `Week ${Math.round(week.usedPercent)}% used`, week, week.seenAt),
    )
  } else if (week) {
    const used = Math.round(week.usedPercent)
    const phrase = `Week ${used}% used`
    const judged = levelOf("week", used, phrase)
    const pace = weekPace(week, now)
    const others: Hit[] =
      !judged.hit && pace !== null && week.usedPercent > pace
        ? [{ level: "amber", reason: `Week ${used}% used, over the ${Math.round(pace)}% pace` }]
        : []
    readings.push(
      reading(
        "week",
        String(used),
        { ...judged, words: `${judged.words}${resetWords(week)}${readWords}` },
        phrase,
        others,
      ),
    )
  }
  const fiveHour = usage?.fiveHour ?? null
  if (fiveHour?.seenAt) {
    readings.push(
      remembered(
        "fiveHour",
        `5-hour window ${Math.round(fiveHour.usedPercent)}% used`,
        fiveHour,
        fiveHour.seenAt,
      ),
    )
  } else if (usage?.fiveHourNone) {
    const state = `no 5-hour window on this account${readWords}`
    readings.push({
      key: "fiveHour",
      level: "green",
      measure: "none",
      name: NAME_OF.fiveHour,
      reasons: [],
      state,
      title: `${NAME_OF.fiveHour} none, ${state}`,
      value: "none",
    })
  } else if (fiveHour) {
    const used = Math.round(fiveHour.usedPercent)
    const phrase = `5-hour window ${used}% used`
    const judged = levelOf("fiveHour", used, phrase)
    readings.push(
      reading(
        "fiveHour",
        String(used),
        {
          ...judged,
          words: `${judged.words}${resetWords(fiveHour)}${readWords}`,
        },
        phrase,
      ),
    )
  }
  return readings
}

// Pure: the shares' plain mean, rounded, since no usage file carries its limit's size to weight it by.
const meanOf = (shares: number[]) =>
  Math.round(shares.reduce((sum, used) => sum + used, 0) / shares.length)

// Pure: the fresh accounts' mean share judged against READING_LEVELS, as if each had 100 of its own, its state the words after the reading's name.
const judgedMean = (key: "fiveHour" | "week", name: string, fresh: number[]) => {
  const mean = meanOf(fresh)
  const prefix = `${name} `
  const judged = levelOf(
    key,
    mean,
    `${prefix}${mean}% across ${fresh.length} fresh account${fresh.length === 1 ? "" : "s"}`,
  )
  return { ...judged, state: judged.words.slice(prefix.length) }
}

// Pure: the accounts soonest week reset first, so every list of them shows which frees up next; ties keep their order, and an account with no week reset goes last.
export const byWeekReset = <T extends Pick<AccountUsage, "usage">>(accounts: T[]): T[] => {
  const at = (account: T) => Date.parse(account.usage.sevenDay?.resetsAt ?? "") || Infinity
  return accounts.toSorted((a, b) => at(a) - at(b))
}

const HOUR_MS = 3600_000

// login-flip.py's ENDS_LEAD: an ending account leaves the rotation this long before its plan ends.
const ENDS_LEAD_MS = 2 * HOUR_MS

const pad2 = (n: number) => String(n).padStart(2, "0")

// Pure: a moment as the usage tooltip writes it, its weekday and 24-hour time in this browser's zone ("Mon 19:30").
export const slotLabel = (at: number): string => {
  const d = new Date(at)
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// Pure: a day as the Renews lines write it ("Nov 3").
const dayLabel = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", { day: "numeric", month: "short" })

// Pure: the next day of the month `day` falls on, today included, in this browser's zone; a short month takes its last day.
export const nextMonthDay = (day: number, now: number): number => {
  const today = new Date(now)
  const on = (months: number) => {
    const last = new Date(today.getFullYear(), today.getMonth() + months + 1, 0).getDate()
    return new Date(today.getFullYear(), today.getMonth() + months, Math.min(day, last)).getTime()
  }
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return on(0) >= start ? on(0) : on(1)
}

// Pure: a window's share and next reset now: a reset that has passed reads 0%, the week's rolled to its slot a week on, the 5-hour's unknown until the next use opens one.
const windowNow = (
  key: "fiveHour" | "week",
  window: UsageWindow | null,
  now: number,
): { resetsAt: number | null; used: number | null } => {
  if (!window) return { resetsAt: null, used: null }
  const at = window.resetsAt ? Date.parse(window.resetsAt) : null
  if (at === null || at > now) {
    return { resetsAt: at, used: Math.min(100, Math.max(0, Math.round(window.usedPercent))) }
  }
  if (key === "fiveHour") return { resetsAt: null, used: 0 }
  return { resetsAt: at + Math.ceil((now - at + 1) / WEEK_MS) * WEEK_MS, used: 0 }
}

type Rotation = NonNullable<Usage["rotation"]>

// What the combined usage readings read: the accounts, the signed-in one, usage.json, and the sampler's last hour for the current account's burn.
type UsageReport = Pick<SystemReport, "account" | "accounts" | "usage"> &
  Partial<Pick<SystemReport, "history">>

// Pure: the share a window has left an hour until it resets or its plan ends, whichever is first; under an hour left counts as one, and with no time to spread it over there is none.
export const paceOf = (used: number, until: number | null, now: number): number | null =>
  until === null ? null : (100 - used) / Math.max(1, (until - now) / HOUR_MS)

// Pure: an account's week burn over the sampler's last hour, from its first and last readings there; none under 10 minutes apart, and a reset in between reads 0.
export const burnOf = (history: SystemReport["history"], account: string): number | null => {
  const own = history.flatMap((p) =>
    p.week?.account.toLowerCase() === account.toLowerCase()
      ? [{ at: Date.parse(p.at), used: p.week.used }]
      : [],
  )
  const [first, last] = [own[0], own.at(-1)]
  if (!first || !last || last.at - first.at < 10 * 60_000) return null
  return Math.max(0, (last.used - first.used) / ((last.at - first.at) / HOUR_MS))
}

const perHour = (n: number) => `${n.toFixed(1)}%/h`

const poolOf = (report: Pick<SystemReport, "usage">): Map<string, Rotation["pool"][number]> =>
  new Map((report.usage?.rotation?.pool ?? []).map((e) => [e.account.toLowerCase(), e]))

// Pure: every account's row for one window, soonest next week reset first in both windows, named by its address's local part, the account the factory is on marked; exhausted once the window reads 100%, or, for an account whose plan ends, from 2 hours before its end, as login-flip.py drops it; else its pace to the window's reset, the week's to its plan's end when that is sooner, the current account's week adding its burn now.
export function usageRows(key: "fiveHour" | "week", report: UsageReport, now: number): UsageRow[] {
  const current = report.account?.email.toLowerCase()
  const pool = poolOf(report)
  const burn = current && key === "week" ? burnOf(report.history ?? [], current) : null
  return report.accounts
    .map(({ account, usage }) => {
      const week = windowNow("week", usage.sevenDay, now)
      const own = key === "week" ? week : windowNow("fiveHour", usage.fiveHour, now)
      const endsAt = pool.get(account.toLowerCase())?.endsAt
      const ends = endsAt ? Date.parse(endsAt) : null
      const exhausted = (own.used ?? 0) >= 100 || (ends !== null && now >= ends - ENDS_LEAD_MS)
      const isCurrent = account.toLowerCase() === current
      const until =
        key === "week" && ends !== null ? Math.min(ends, own.resetsAt ?? ends) : own.resetsAt
      const pace = own.used === null ? null : paceOf(own.used, until, now)
      const status = exhausted
        ? "exhausted"
        : [
            pace === null ? "-" : perHour(pace),
            isCurrent && burn !== null && `now ${perHour(burn)}`,
          ]
            .filter(Boolean)
            .join(" · ")
      const row: UsageRow = {
        account,
        cells: own.used === null ? 0 : Math.round(own.used / 10),
        current: isCurrent,
        exhausted,
        level:
          own.used === null
            ? "green"
            : (levelOf(key, own.used, `${account} ${own.used}%`).hit?.level ?? "green"),
        name: account.split("@")[0]!,
        ...(key === "fiveHour" && usage.fiveHourNone && { none: true as const }),
        reset: own.resetsAt === null ? "-" : slotLabel(own.resetsAt),
        stale: usage.stale,
        status,
        used: own.used,
      }
      return { order: week.resetsAt ?? Infinity, row }
    })
    .toSorted((a, b) => a.order - b.order)
    .map(({ row }) => row)
}

// Pure: the share of the pool's combined capacity still unused, every account's 100 less its share, exhausted ones at 0, averaged and rounded half up, so it always reads out of 100; "-" with no account read.
export const roomLeft = (rows: Pick<UsageRow, "exhausted" | "used">[]): string => {
  const room = rows.flatMap((r) => (r.used === null ? [] : [r.exhausted ? 0 : 100 - r.used]))
  return room.length ? `${Math.round(room.reduce((sum, n) => sum + n, 0) / room.length)}%` : "-"
}

// Pure: when each account's plan ends or renews, in the week's row order: an ending account "ends Nov 8" from its endsAt, or "ends" until it is set; a renewing one "renews Nov 3" from its renewsOn day of the month, or "renews ?" until it is set. None without a rotation in usage.json.
export function renewRows(
  rows: UsageRow[],
  report: Pick<SystemReport, "usage">,
  now: number,
): RenewRow[] | undefined {
  if (!report.usage?.rotation) return undefined
  const pool = poolOf(report)
  return rows.flatMap(({ account, name }) => {
    const entry = pool.get(account.toLowerCase())
    if (!entry) return []
    const words = entry.ending
      ? entry.endsAt
        ? `ends ${dayLabel(Date.parse(entry.endsAt))}`
        : "ends"
      : entry.renewsOn
        ? `renews ${dayLabel(nextMonthDay(entry.renewsOn, now))}`
        : "renews ?"
    return [{ account, name, words }]
  })
}

const BLOCK_NAME = { fiveHour: "5-hour", week: "Week" } as const

const rowWords = (r: UsageRow) =>
  [
    `${r.name}${r.current ? " (current)" : ""} ${r.none ? "none" : r.used === null ? "not read" : `${r.used}%`}`,
    r.reset !== "-" && `resets ${r.reset}`,
    r.status,
    r.stale && "stale",
  ]
    .filter(Boolean)
    .join(", ")

// Pure: one window combined across every account: its figure and colour the fresh accounts' mean share, judged against READING_LEVELS, a stale account and one with no such window left out of both and dimmed in the hover; with none fresh, the last shares' mean, gray, judging nothing, "none" when no fresh account has the window, and - when no account reads it. Its hover is one row an account (usageRows) under how much room the pool has left, the week's adding when each plan ends or renews.
const joinedUsage = (key: "fiveHour" | "week", report: UsageReport, now: number): Reading => {
  const name = NAME_OF[key]
  const rows = usageRows(key, report, now)
  const fresh = rows.flatMap((r) => (r.stale || r.used === null ? [] : [r.used]))
  const read = rows.flatMap((r) => (r.used === null ? [] : [r.used]))
  const judged = fresh.length ? judgedMean(key, name, fresh) : null
  const current = rows.filter((r) => !r.stale)
  const none = !judged && current.length > 0 && current.every((r) => r.none)
  const state =
    judged?.state ??
    (none
      ? "no fresh account has one"
      : report.accounts.every((a) => a.usage.stale)
        ? "every account stale"
        : "no fresh account reads it")
  const measure = `${BLOCK_NAME[key]} · room left ${roomLeft(rows)}`
  const renews = key === "week" ? renewRows(rows, report, now) : undefined
  return {
    key,
    level: judged?.hit?.level ?? "green",
    measure,
    name,
    reasons: judged?.hit ? [judged.hit.reason] : [],
    ...(renews && { renews }),
    rows,
    ...(judged || none ? {} : { stale: true as const }),
    state,
    title: [
      `${name} ${state}`,
      measure,
      ...rows.map(rowWords),
      ...(renews?.length
        ? [`Renews: ${renews.map((r) => `${r.name} ${r.words}`).join(", ")}`]
        : []),
    ].join("; "),
    value: none ? "none" : read.length ? String(meanOf(fresh.length ? fresh : read)) : "-",
  }
}

// Pure: the week and the 5-hour window, combined across every account's usage file when there are two or more, else today's readings from usage.json.
export function combinedUsage(report: UsageReport, now: number): Reading[] {
  if (report.accounts.length < 2) return singleUsage(report.usage, now)
  return [joinedUsage("week", report, now), joinedUsage("fiveHour", report, now)]
}

// Pure: the GLM plan's week and 5-hour window as the Claude windows read, each its credits' share judged by the same levels and pace, its name and words saying GLM; a file the job stopped writing shows each window's last share stale, gray, judging nothing.
export function zaiReadings(zai: ZaiUsage | null, now: number): Reading[] {
  if (!zai) return []
  const seen = zai.stale ? { seenAt: zai.writtenAt } : {}
  const share = (window: ZaiWindow | null): UsageWindow | null =>
    window && { resetsAt: window.resetsAt, usedPercent: (window.used / window.cap) * 100, ...seen }
  const usage = {
    fiveHour: share(zai.fiveHour),
    sevenDay: share(zai.week),
    stale: zai.stale,
    writtenAt: zai.writtenAt,
  }
  const named = (words: string) => `GLM ${words.charAt(0).toLowerCase()}${words.slice(1)}`
  return singleUsage(usage, now).map((r) => ({
    ...r,
    name: named(r.name),
    title: r.title
      .split("; ")
      .map((part) => (part.startsWith(r.name) ? named(part) : part))
      .join("; "),
  }))
}

// Pure: each window's room left on one line, as the System page and the Usage app show it over their per-account lines.
export const joinedLine = (report: UsageReport, now: number): string =>
  combinedUsage(report, now)
    .map((r) => r.measure)
    .join(" · ")

// Pure: the readings the sidebar's System status draws, in their order, disk shown only while it is orange or red, in its place after swap and before the week; a green disk stays in the hover, the screen-reader text and the System page.
export const glanceReadings = (readings: Reading[]): Reading[] =>
  readings.filter((r) => r.key !== "disk" || r.level !== "green")

// The readings the health judges: the hardware alone, never the usage windows, which keep their own icons' colours.
const USAGE_KEYS: ReadonlySet<ReadingKey> = new Set(["fiveHour", "week"])

// Pure: how the machine reads, the worst of its hardware readings (systemReadings, judged by READING_LEVELS, the usage windows left out) or a sample past SYSTEM_STALE_MS, and why in words, red reasons first (the sidebar header's icon group names it).
export function systemHealth(
  report: SystemReport,
  now: number,
): { level: Health; reasons: string[] } {
  const readings = systemReadings(report, now).filter((r) => !USAGE_KEYS.has(r.key))
  const red = readings.filter((r) => r.level === "red").flatMap((r) => r.reasons)
  const amber = readings.filter((r) => r.level === "amber").flatMap((r) => r.reasons)
  if (isStale(report.sampledAt, now)) amber.push("Sampling has stopped")
  const level = red.length ? "red" : amber.length ? "amber" : "green"
  return { level, reasons: [...red, ...amber] }
}

// Pure: the readings for screen readers, each named once in its own words (its level and why), so a crossed reading is not read twice beside the health's reasons.
export const spokenReadings = (readings: Reading[]): string =>
  readings.map((r) => r.title).join(". ")

// The 5-minute load as the readings line writes it: one decimal below 10 (6.4), whole from 10 up (12), so a busy machine's line still fits the stock sidebar.
export const loadLabel = (load: number): string =>
  load < 9.95 ? load.toFixed(1) : String(Math.round(load))

type Update = NonNullable<SystemReport["update"]>

// Pure: how to take an update. The live dashboard's branch is rolled to each new build by its runner, and Update now asks for that roll at once; elsewhere a pull, and once pulled a restart.
export const updateHint = (update: Pick<Update, "live" | "pulled">): string =>
  update.live
    ? "The next roll takes it, or Update now asks for it at once"
    : update.pulled
      ? "Pulled already: restart to pick it up"
      : "To update: git pull, then restart"

// Pure: the hover of the update icon on the user menu card, or null while the build is current or no check has read: how many changes, the newest, and how to take them.
export const updateHover = (update: Update | null | undefined, now: Date): string | null => {
  if (!update || update.behind < 1) return null
  return [
    `${update.behind} new ${update.behind === 1 ? "change" : "changes"} on ${update.upstream}`,
    `Newest: ${update.newest.title}, ${relativeTime(update.newest.at, now)}`,
    updateHint(update),
  ].join("\n")
}

// Pure: the user menu's second line under this Mac's name: the Claude account's email once the owner's System read lands, "No Claude account" with none linked, and nothing while the first read is pending, so the line holds its height as plain text; below the owner rung, which cannot read the report, the sign-in user's email.
export const accountLine = (
  signIn: string,
  read: { account: SystemReport["account"] | undefined; owner: boolean; pending: boolean },
): string | null =>
  !read.owner ? signIn : read.pending ? null : (read.account?.email ?? "No Claude account")

// Pure: the line a click on the user menu's Update now sends to the dispatcher's chat, or null while the build is current: the live dashboard asks for its roll now, naming the changes and the newest; anywhere else the hover's facts and how to take them, on one line in the owner's lowercase.
export const updateMessage = (update: Update | null | undefined, now: Date): string | null => {
  if (!update || update.behind < 1) return null
  const changes = `${update.behind} new ${update.behind === 1 ? "change" : "changes"} on ${update.upstream}, newest "${update.newest.title}"`
  if (update.live) return `update the dashboard now: ${changes}`
  const hint = updateHint(update)
  return `update available: ${changes} ${relativeTime(update.newest.at, now)}. ${hint[0]?.toLowerCase()}${hint.slice(1)}.`
}
