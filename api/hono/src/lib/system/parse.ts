// Pure: what each probe prints, as numbers. Each parser takes a command's stdout and returns what it found; anything it cannot read is left out rather than guessed.

export type Pressure = "critical" | "normal" | "warn"

export type Sysctl = {
  freePercent: number | null
  pressure: Pressure | null
  swap: { totalBytes: number; usedBytes: number } | null
}

const MIB = 1024 * 1024

// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical, the levels memory_pressure names.
const PRESSURE: Record<string, Pressure> = { "1": "normal", "2": "warn", "4": "critical" }

// `sysctl <names>` prints one `name: value` line each; vm.swapusage reads `total = 6144.00M  used = 4437.62M  free = ...`.
export function parseSysctl(out: string): Sysctl {
  const values = new Map<string, string>()
  for (const line of out.split("\n")) {
    const at = line.indexOf(":")
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const level = Number.parseInt(values.get("kern.memorystatus_level") ?? "", 10)
  const swap = values.get("vm.swapusage") ?? ""
  const total = /total\s*=\s*([\d.]+)M/.exec(swap)?.[1]
  const used = /used\s*=\s*([\d.]+)M/.exec(swap)?.[1]
  return {
    freePercent: Number.isFinite(level) && level >= 0 && level <= 100 ? level : null,
    pressure: PRESSURE[values.get("kern.memorystatus_vm_pressure_level") ?? ""] ?? null,
    swap: total && used ? { totalBytes: Number(total) * MIB, usedBytes: Number(used) * MIB } : null,
  }
}

// vm_stat's pages as Activity Monitor adds them: Memory Used is app memory (anonymous pages less the purgeable ones) plus wired plus what the compressor occupies.
export function parseVmStat(out: string): { usedBytes: number } | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1])
  const pages = new Map<string, number>()
  for (const match of out.matchAll(/^"?([^":\n]+)"?:\s+(\d+)\.?$/gm)) {
    pages.set((match[1] ?? "").trim(), Number(match[2]))
  }
  const anonymous = pages.get("Anonymous pages")
  const wired = pages.get("Pages wired down")
  const compressed = pages.get("Pages occupied by compressor")
  if (!pageSize || anonymous === undefined || wired === undefined || compressed === undefined) {
    return null
  }
  const app = anonymous - (pages.get("Pages purgeable") ?? 0)
  return { usedBytes: (Math.max(0, app) + wired + compressed) * pageSize }
}

export type Proc = { cpuSeconds: number; pid: number; ppid: number; rssBytes: number }

// ps's cumulative CPU time: `[[dd-]hh:]mm:ss.cc`, where the minutes run past 59 on macOS (`473:33.21`).
export function cpuSecondsOf(time: string): number | null {
  const [days, clock] = time.includes("-") ? time.split("-", 2) : ["0", time]
  const parts = (clock ?? "").split(":").map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n)) || !/^\d+$/.test(days ?? "")) {
    return null
  }
  return Number(days) * 86_400 + parts.reduce((total, n) => total * 60 + n, 0)
}

// `ps -axo pid=,ppid=,rss=,time=`: rss in KiB.
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split("\n")) {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/)
    const cpuSeconds = cpuSecondsOf(time ?? "")
    if (!/^\d+$/.test(pid ?? "") || !/^\d+$/.test(ppid ?? "") || !/^\d+$/.test(rss ?? "")) continue
    if (cpuSeconds === null) continue
    procs.push({ cpuSeconds, pid: Number(pid), ppid: Number(ppid), rssBytes: Number(rss) * 1024 })
  }
  return procs
}

// lsof's -F output: a `p<pid>` line opens each process, then an `f<fd>` and an `n<name>` line per file.
const fields = function* (out: string): Generator<{ name: string; pid: number }> {
  let pid = 0
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid) yield { name: line.slice(1), pid }
  }
}

// `lsof -d cwd -Fpn`: each process's working directory.
export function parseCwds(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  for (const { name, pid } of fields(out)) cwds.set(pid, name)
  return cwds
}

export type Sockets = { connects: Map<number, Set<number>>; listens: Set<number> }

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)$/

const split = (address: string): { host: string; port: number } => {
  const at = address.lastIndexOf(":")
  return { host: address.slice(0, at), port: Number(address.slice(at + 1)) }
}

// `lsof -iTCP -sTCP:LISTEN,ESTABLISHED -Fpn`: a name with `->` is a connection (`127.0.0.1:60681->127.0.0.1:65521`), kept when its far end is on this machine, by the far end's port; one without is a listener.
export function parseSockets(out: string): Sockets {
  const connects = new Map<number, Set<number>>()
  const listens = new Set<number>()
  for (const { name, pid } of fields(out)) {
    const [, remote] = name.split("->")
    if (remote === undefined) {
      listens.add(pid)
      continue
    }
    const { host, port } = split(remote)
    if (!LOOPBACK.test(host) || !Number.isInteger(port)) continue
    const ports = connects.get(pid) ?? new Set<number>()
    ports.add(port)
    connects.set(pid, ports)
  }
  return { connects, listens }
}

// `lsof -Fp <socket>`: the processes holding it open.
export const parseHolders = (out: string): number[] =>
  out
    .split("\n")
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number(line.slice(1)))

// `docker context inspect --format {{json .Endpoints.docker.Host}}`: the daemon's socket path, when it is one.
export function parseDockerHost(out: string): string | null {
  try {
    const host: unknown = JSON.parse(out.trim())
    return typeof host === "string" && host.startsWith("unix:///")
      ? host.slice("unix://".length)
      : null
  } catch {
    return null
  }
}

type Json = Record<string, unknown>

const jsonLines = (out: string): Json[] =>
  out.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return typeof value === "object" && value !== null ? [value as Json] : []
    } catch {
      return []
    }
  })

const str = (value: unknown): string => (typeof value === "string" ? value : "")

export type DockerContainer = { id: string; name: string; ports: number[] }

// `docker ps --format {{json .}}`: each running container with the host ports it publishes (`127.0.0.1:33522->5432/tcp`).
export const parseContainers = (out: string): DockerContainer[] =>
  jsonLines(out).flatMap((row) => {
    const id = str(row.ID)
    if (!id) return []
    const ports = [...str(row.Ports).matchAll(/:(\d+)->/g)].map((m) => Number(m[1]))
    return [{ id, name: str(row.Names).split(",")[0] ?? id, ports: [...new Set(ports)] }]
  })

const UNITS: Record<string, number> = {
  B: 1,
  GB: 1e9,
  GiB: 1024 ** 3,
  KiB: 1024,
  MB: 1e6,
  MiB: 1024 ** 2,
  kB: 1e3,
}

export const bytesOf = (size: string): number | null => {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(size.trim())
  const unit = UNITS[match?.[2] ?? ""]
  return match && unit ? Number(match[1]) * unit : null
}

// `docker stats --no-stream --format {{json .}}`: each container's memory in use (`26.32MiB / 11.73GiB`), by its short id.
export function parseContainerStats(out: string): Map<string, number> {
  const usage = new Map<string, number>()
  for (const row of jsonLines(out)) {
    const bytes = bytesOf(str(row.MemUsage).split("/")[0] ?? "")
    if (str(row.ID) && bytes !== null) usage.set(str(row.ID), bytes)
  }
  return usage
}

// One machine's size and load, the figures the System panel sums across machines; usedBytes is null when this machine's memory read failed.
export type MachineReading = {
  cores: number
  disk: { freeBytes: number; totalBytes: number } | null
  load: [number, number, number]
  memory: { totalBytes: number; usedBytes: number | null }
  swap: { totalBytes: number; usedBytes: number } | null
}

// A peer's `df -kP ~; cat /proc/loadavg /proc/meminfo /proc/stat`: df's Available and 1024-blocks for its home, null when df printed none, loadavg's line, MemTotal less MemAvailable as free counts it, SwapTotal less SwapFree, and one cpuN line per core; null when the load, the memory or the cores do not read, so a peer is never summed as zeros.
export function parsePeer(out: string): MachineReading | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(out)
    return m ? Number(m[1]) * 1024 : null
  }
  const load = (/^(\S+ \S+ \S+) \d+\/\d+ \d+$/m.exec(out)?.[1] ?? "").split(" ").map(Number)
  const df = /^Filesystem\s+1024-blocks.*\n.*?\s(\d+)\s+\d+\s+(\d+)\s+\d+%\s/m.exec(out)
  const cores = out.match(/^cpu\d+ /gm)?.length ?? 0
  const total = kb("MemTotal")
  const available = kb("MemAvailable")
  const swapTotal = kb("SwapTotal")
  const swapFree = kb("SwapFree")
  if (load.length !== 3 || !load.every(Number.isFinite) || cores === 0) return null
  if (total === null || available === null) return null
  return {
    cores,
    disk: df ? { freeBytes: Number(df[2]) * 1024, totalBytes: Number(df[1]) * 1024 } : null,
    load: load as [number, number, number],
    memory: { totalBytes: total, usedBytes: Math.max(0, total - available) },
    swap:
      swapTotal === null || swapFree === null
        ? null
        : { totalBytes: swapTotal, usedBytes: Math.max(0, swapTotal - swapFree) },
  }
}
