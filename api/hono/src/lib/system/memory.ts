import {
  procReading,
  procSource,
  procUsedBytes,
  type SysctlName,
} from "@packages/scripts/ops-machine/readings"

import { parseSysctl, parseVmStat, type Sysctl } from "@/lib/system/parse"
import { probe } from "@/lib/system/probe"

// The sysctl names the panel reads, each by what it is called in a problem.
const LABELS = {
  "kern.memorystatus_level": "free share",
  "kern.memorystatus_vm_pressure_level": "memory pressure",
  "vm.swapusage": "swap",
} as const satisfies Partial<Record<SysctlName, string>>

const NAMES = Object.keys(LABELS) as (keyof typeof LABELS)[]

type Read<T> = { read: Promise<T>; what: string }

// Linux's free share, pressure level and swap, each from its /proc file through ops-machine's readings seam in sysctl's shape; each file that does not read is named in problems and leaves its readings empty, while the rest still show.
async function procSysctl(problems: string[]): Promise<Sysctl> {
  const read = NAMES.map((name) => ({ name, value: procReading(name) }))
  const unread = read.filter((r) => r.value === null)
  for (const source of new Set(unread.map((r) => procSource(r.name)))) {
    const labels = unread.filter((r) => procSource(r.name) === source).map((r) => LABELS[r.name])
    problems.push(
      `${source} does not read, so the ${labels.join(" and ")} ${labels.length === 1 ? "stays" : "stay"} empty`,
    )
  }
  return parseSysctl(
    read.flatMap((r) => (r.value === null ? [] : [`${r.name}: ${r.value}`])).join("\n"),
  )
}

async function procUsed(): Promise<number> {
  const used = procUsedBytes()
  if (used === null) throw new Error("MemTotal or MemAvailable does not read")
  return used
}

// The memory readings and what each is named by in problems: on Linux /proc alone, through ops-machine's readings seam, so no sysctl or vm_stat runs there, each file that does not read named in problems; else macOS's sysctl and vm_stat, which a fixture stack answers from its fixture.
export function memoryReads(
  linux: boolean,
  problems: string[],
): {
  sysctl: Read<Sysctl>
  usedBytes: Read<number | null>
} {
  if (linux) {
    return {
      sysctl: {
        read: procSysctl(problems),
        what: [...new Set(NAMES.map(procSource))].join(" and "),
      },
      usedBytes: { read: procUsed(), what: "/proc/meminfo" },
    }
  }
  return {
    sysctl: { read: probe("sysctl").then(parseSysctl), what: "sysctl" },
    usedBytes: {
      read: probe("memory").then((out) => parseVmStat(out)?.usedBytes ?? null),
      what: "vm_stat",
    },
  }
}
