import { readFileSync } from "node:fs"
import { join } from "node:path"

// The machine's readings for the load and memory gates and ops-tick's boot time: macOS's sysctl answer when it reads, else the Linux /proc text that stands for it, put in sysctl's shape, else null, so a reading neither gives is never 0 or NaN; spawn.sh's and run-slot.sh's own readings take the same sources in the same order.

export type Answer = { code: number; out: string }
export type Run = (argv: string[]) => Promise<Answer>

// The folder /proc's text comes from: PLAYGROUND_PROC under the test sandbox's marker alone (TEST_SANDBOX_HOME), where a test points it at recorded text, so a session that sets it cannot feed a gate a reading; else /proc.
export const procRoot = (env: Record<string, string | undefined> = process.env) =>
  (env.TEST_SANDBOX_HOME && env.PLAYGROUND_PROC) || "/proc"

const proc = (name: string): string | null => {
  try {
    return readFileSync(join(procRoot(), name), "utf8")
  } catch {
    return null
  }
}

const field = (text: string, re: RegExp): number | null => {
  const m = re.exec(text)
  return m ? Number(m[1]) : null
}

const fixed = (n: number) => n.toFixed(2)

// meminfo's value for key, in kB
const meminfo = (text: string, key: string) => field(text, new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))

// The CPU's busy and idle fields from /proc/stat's cpu line: user, nice, system, idle, iowait, irq, softirq, steal (guest time is counted in user already).
const cpuOf = (text: string | null): { idle: number; total: number } | null => {
  const m = /^cpu\s+(.*)$/m.exec(text ?? "")
  const fields = m?.[1]!.trim().split(/\s+/).slice(0, 8).map(Number)
  if (!fields || fields.length < 5 || !fields.every(Number.isInteger)) return null
  return { idle: fields[3]! + fields[4]!, total: fields.reduce((a, b) => a + b, 0) }
}

// Per sysctl name: whether sysctl's answer reads, and the Linux text that stands for it in sysctl's shape. The pressure level puts PSI's /proc/pressure/memory on macOS's scale, 4 (critical) once full avg10 is 10% or more, 2 (warn) once some avg10 is, else 1: the 10% lines are estimated, from Android's lmkd, which acts on memory stalls of 70 to 100 ms a second.
const SYSCTLS = {
  "hw.ncpu": {
    linux: () => {
      const n = (proc("stat") ?? "").match(/^cpu\d+ /gm)?.length
      return n ? String(n) : null
    },
    reads: (out: string) => /^[1-9]\d*$/.test(out),
    source: "/proc/stat",
  },
  "kern.memorystatus_level": {
    linux: () => {
      const text = proc("meminfo") ?? ""
      const total = meminfo(text, "MemTotal")
      const available = meminfo(text, "MemAvailable")
      return total && available !== null ? String(Math.floor((available * 100) / total)) : null
    },
    reads: (out: string) => /^\d+$/.test(out),
    source: "/proc/meminfo",
  },
  "kern.memorystatus_vm_pressure_level": {
    linux: () => {
      const text = proc("pressure/memory") ?? ""
      const some = field(text, /^some avg10=([\d.]+)/m)
      const full = field(text, /^full avg10=([\d.]+)/m)
      if (some === null || full === null) return null
      return full >= 10 ? "4" : some >= 10 ? "2" : "1"
    },
    reads: (out: string) => /^\d+$/.test(out),
    source: "/proc/pressure/memory",
  },
  "vm.loadavg": {
    linux: () => {
      const loads = (proc("loadavg") ?? "").trim().split(/\s+/).slice(0, 3).map(Number)
      return loads.length === 3 && loads.every(Number.isFinite)
        ? `{ ${loads.map(fixed).join(" ")} }`
        : null
    },
    reads: (out: string) => /^\{?\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\}?$/.test(out),
    source: "/proc/loadavg",
  },
  "vm.swapusage": {
    linux: () => {
      const text = proc("meminfo") ?? ""
      const total = meminfo(text, "SwapTotal")
      const free = meminfo(text, "SwapFree")
      if (total === null || free === null) return null
      const mb = (kb: number) => `${fixed(kb / 1024)}M`
      return `total = ${mb(total)}  used = ${mb(total - free)}  free = ${mb(free)}`
    },
    reads: (out: string) => /used = [\d.]+M/.test(out),
    source: "/proc/meminfo",
  },
} as const

export type SysctlName = keyof typeof SYSCTLS

// The Linux file that stands for a sysctl name, for a line that names what did not read.
export const procSource = (name: SysctlName) => SYSCTLS[name].source

// The /proc text that stands for a sysctl name, in sysctl's shape, else null; for a reader that runs no sysctl on Linux.
export const procReading = (name: SysctlName): string | null => SYSCTLS[name].linux()

// Pure but for /proc: sysctl's answer for name when it exits 0 with a reading, else the /proc text in its shape, else null.
export const sysctlOf = (name: SysctlName, answer: Answer): string | null => {
  const out = answer.out.trim()
  return answer.code === 0 && SYSCTLS[name].reads(out) ? out : procReading(name)
}

// Linux's memory in use as procps's free counts it, MemTotal less MemAvailable from /proc/meminfo, in bytes; null when either does not read.
export const procUsedBytes = (): number | null => {
  const text = proc("meminfo") ?? ""
  const total = meminfo(text, "MemTotal")
  const available = meminfo(text, "MemAvailable")
  return total !== null && available !== null ? Math.max(0, total - available) * 1024 : null
}

export const readSysctl = async (run: Run, name: SysctlName): Promise<string | null> =>
  sysctlOf(name, await run(["sysctl", "-n", name]))

// The machine's latest boot or wake from sleep, in ms since the epoch: the later of macOS's kern.boottime and kern.waketime (`{ sec = <s>, usec = <us> } <date>` lines), else /proc/stat's btime alone, since Linux keeps no wake time in /proc, else 0.
export const readUpSince = (run: Run): Promise<number> =>
  latestOf(run, ["kern.boottime", "kern.waketime"])

// The machine's latest boot alone, never a wake, since every process from before a sleep lives on: macOS's kern.boottime, else /proc/stat's btime, else 0.
export const readBootTime = (run: Run): Promise<number> => latestOf(run, ["kern.boottime"])

const latestOf = async (run: Run, names: string[]): Promise<number> => {
  const { out } = await run(["sysctl", "-n", ...names])
  const times = [...out.matchAll(/\bsec = (\d+)/g)].map((m) => Number(m[1]) * 1000)
  if (times.length) return Math.max(...times)
  return (field(proc("stat") ?? "", /^btime (\d+)$/m) ?? 0) * 1000
}

// The CPU's idle share in percent: top's second sample on macOS, else idle and iowait's share of every field over two /proc/stat reads a wait apart, else null.
export const readIdle = async (
  run: Run,
  wait: () => Promise<void> = () => Bun.sleep(1000),
): Promise<number | null> => {
  const top = (await run(["top", "-l", "2", "-s", "1", "-n", "0"])).out
  const shares = [...top.matchAll(/^CPU usage:.* ([\d.]+)% idle/gm)]
  if (shares.length === 2) return Number(shares[1]![1])
  const first = cpuOf(proc("stat"))
  if (!first) return null
  await wait()
  const second = cpuOf(proc("stat"))
  if (!second || second.total <= first.total) return null
  return Math.round(((second.idle - first.idle) * 10000) / (second.total - first.total)) / 100
}
