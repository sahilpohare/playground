import type { Pressure } from "@/lib/system/parse"

// What one more worker costs once it runs a dev stack: its claude (about 0.5 GB), next dev, the API, turbo and its Postgres, and about a core while it builds and tests.
export const PER_WORKER = { bytes: 1.3 * 1024 ** 3, cores: 1 }

// What one more orchestrator costs: its claude alone, with no dev stack, measured on a 24 GB, 15-core Mac on 3 Nov (five managers at 134 to 615 MB and 0.01 to 0.07 cores over 18 hours each), the highest of each rounded up.
export const PER_ORCHESTRATOR = { bytes: 0.6 * 1024 ** 3, cores: 0.1 }

// The share of RAM left to macOS and the apps the owner uses, never counted as room.
export const RESERVE_SHARE = 0.15

export type Limit = "cpu" | "memory" | "pressure"

// Swap is shown but never judged: macOS adds swap files as it needs them, so the share in use rises and falls with no change in strain, and the pressure level (macOS's own, on Linux PSI's) is the word for when swapping hurts.
export type CapacityInput = {
  cores: number
  freePercent: number | null
  load5: number
  pressure: Pressure | null
  totalBytes: number
}

export type Room = { limitedBy: Limit | null; line: string; workers: number }

export type Fit = { count: number; limitedBy: Limit | null; line: string }

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

// Pure: how many more sessions of one cost fit, by whichever of memory and CPU runs out first, and none at all while the machine reports memory pressure. Memory room is the free share (on macOS the share memory_pressure prints, on Linux MemAvailable's) less the reserve; CPU room is the cores less the 5-minute load. Unknown free memory counts as no room, since a guess here spawns sessions.
export function fitOf(
  input: CapacityInput,
  cost: { bytes: number; cores: number },
  noun: string,
): Fit {
  const { cores, freePercent, load5, pressure, totalBytes } = input
  if (pressure === "warn" || pressure === "critical") {
    return { count: 0, limitedBy: "pressure", line: `No room: memory pressure is ${pressure}` }
  }
  if (freePercent === null) {
    return { count: 0, limitedBy: "memory", line: "No room: free memory could not be read" }
  }
  const memoryRoom = (freePercent / 100 - RESERVE_SHARE) * totalBytes
  const cpuRoom = cores - load5
  const byMemory = Math.max(0, Math.floor(memoryRoom / cost.bytes))
  const byCpu = Math.max(0, Math.floor(cpuRoom / cost.cores))
  const limitedBy: Limit = byCpu < byMemory ? "cpu" : "memory"
  const count = Math.min(byMemory, byCpu)
  if (count === 0) {
    return {
      count,
      limitedBy,
      line:
        limitedBy === "cpu"
          ? `No room: the 5-minute load ${load5.toFixed(1)} leaves under ${cost.cores === 1 ? "a core" : `${cost.cores} cores`} of ${cores}`
          : `No room: ${gb(Math.max(0, memoryRoom))} free past the reserve, under the ${gb(cost.bytes)} a${/^[aeiou]/.test(noun) ? "n" : ""} ${noun} takes`,
    }
  }
  return {
    count,
    limitedBy,
    line: `Room for ~${count} more ${noun}${count === 1 ? "" : "s"}, by ${limitedBy === "cpu" ? "CPU load" : "memory"}`,
  }
}

// Pure: how many more workers fit, each with its dev stack (PER_WORKER).
export function roomOf(input: CapacityInput): Room {
  const { count, limitedBy, line } = fitOf(input, PER_WORKER, "worker")
  return { limitedBy, line, workers: count }
}

// Pure: how many more orchestrators fit, each a claude alone (PER_ORCHESTRATOR).
export const orchestratorsOf = (input: CapacityInput): Fit =>
  fitOf(input, PER_ORCHESTRATOR, "orchestrator")

export type IdleStack = { bytes: number; checkout: string; idleSince: string; name: string | null }

// Pure: the line that says how much stopping idle stacks would free, or null when none is idle.
export function idleLineOf(stacks: IdleStack[]): string | null {
  if (stacks.length === 0) return null
  const bytes = stacks.reduce((sum, stack) => sum + stack.bytes, 0)
  const count = stacks.length === 1 ? "the idle dev stack" : `${stacks.length} idle dev stacks`
  return `Stop ${count} to free ${gb(bytes)}`
}
