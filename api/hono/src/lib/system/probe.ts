import { peerSchema } from "@packages/config/org"

import { readFixtureMachine, readsLive } from "@/lib/dashboard/fixture"
import { org } from "@/lib/org"
import { settledWithin } from "@/lib/settle"
import { peerArgv } from "@/lib/system/peer"

// A kill at a timeout is bounded: SIGTERM first, then this grace, then SIGKILL, and the pipes stop being waited on a moment later.
const KILL_GRACE_MS = 3000

// The System panel reads the machine through these commands alone, each a fixed argv run without a local shell (a peer's ssh hands the peer's login shell its fixed reads), and so does the dashboard when it reads when a session's process started. Every one only reports (memory_pressure is left out, since its -l simulates pressure; sysctl is never handed a name=value; a peer's ssh runs one fixed df of its home and cat of /proc, never prompting), so nothing the panel runs can change a machine. Nothing else under lib/system starts a process.
export const COMMANDS = {
  containerStats: () => ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
  containers: () => ["docker", "ps", "--format", "{{json .}}"],
  cwds: (uid: number) => ["lsof", "-nPw", "-a", "-u", String(uid), "-d", "cwd", "-Fpn"],
  dockerHost: () => ["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
  memory: () => ["vm_stat"],
  peer: (target: string) => peerArgv(target, org.cluster.key),
  processes: () => ["ps", "-axo", "pid=,ppid=,rss=,time="],
  socketHolder: (path: string) => ["lsof", "-nPw", "-Fp", path],
  starts: (pids: readonly number[]) => ["ps", "-o", "pid=,lstart=", "-p", pids.join(",")],
  sockets: (uid: number) => [
    "lsof",
    "-nPw",
    "-a",
    "-u",
    String(uid),
    "-iTCP",
    "-sTCP:LISTEN,ESTABLISHED",
    "-Fpn",
  ],
  sysctl: () => [
    "sysctl",
    "kern.memorystatus_level",
    "kern.memorystatus_vm_pressure_level",
    "vm.swapusage",
  ],
} as const

export type Probe = keyof typeof COMMANDS

// docker stats samples each container for about two seconds, so it gets the longest wait.
const TIMEOUT_MS: Partial<Record<Probe, number>> = { containerStats: 10_000 }

// A start time is printed in the machine's zone and language unless told otherwise; Claude's registry records it in UTC, as C prints it.
const ENV: Partial<Record<Probe, Record<string, string>>> = { starts: { LC_ALL: "C", TZ: "UTC" } }

const whole = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

// Pure: the argv for one probe. A uid is a whole number, pids a list of them, a socket an absolute path and a peer user@host, so none can become a flag.
export function commandOf<K extends Probe>(name: K, ...args: Parameters<(typeof COMMANDS)[K]>) {
  const [arg] = args as unknown[]
  if (arg !== undefined) {
    const ok = Array.isArray(arg)
      ? arg.length > 0 && arg.every(whole)
      : name === "peer"
        ? peerSchema.shape.target.safeParse(arg).success
        : typeof arg === "number"
          ? whole(arg)
          : typeof arg === "string" && arg.startsWith("/") && !/[\0\n]/.test(arg)
    if (!ok) throw new Error(`${name} cannot take ${JSON.stringify(arg)}`)
  }
  return (COMMANDS[name] as (...a: unknown[]) => string[])(...args)
}

// lsof exits 1 when part of what it was asked for matched nothing (no TCP socket at all), and ps -p when no pid it was given is running, which is still an answer.
const answered = (command: string[], code: number, err: string): boolean =>
  code === 0 ||
  (code === 1 && command[0] === "lsof") ||
  (code === 1 && command[0] === "ps" && command.includes("-p") && !err.trim())

// One probe's stdout. A command that cannot start, runs past its time or exits with a failure throws, naming the command. A fixture stack runs none: its fixture holds what each would print.
export async function probe<K extends Probe>(
  name: K,
  ...args: Parameters<(typeof COMMANDS)[K]>
): Promise<string> {
  const command = commandOf(name, ...args)
  if (!readsLive()) {
    const machine = readFixtureMachine()
    if (name === "starts") {
      return (args[0] as readonly number[])
        .flatMap((pid) => {
          const process = machine.processes[String(pid)]
          return process ? [`${pid} ${process.start}`] : []
        })
        .join("\n")
    }
    const out = machine.system.probes[name === "peer" ? `peer ${String(args[0])}` : name]
    if (out === undefined) throw new Error(`${command[0]} has no answer in the fixture`)
    return out
  }
  const timeoutMs = TIMEOUT_MS[name] ?? 5000
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    // the env is passed whole, so the PATH a command is found on is the current one, not the one the process booted with
    proc = Bun.spawn(command, {
      env: { ...process.env, ...ENV[name] },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    throw new Error(`${command[0]} is not installed or not on PATH`)
  }
  let timedOut = false
  let grace: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
    grace = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS)
  }, timeoutMs)
  const settled = await settledWithin(
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
    timeoutMs + KILL_GRACE_MS + 1000,
  )
  clearTimeout(timer)
  clearTimeout(grace)
  const label = name === "peer" ? `ssh ${String(args[0])}` : command.slice(0, 2).join(" ")
  if (!settled || timedOut) throw new Error(`${label} ran past ${timeoutMs / 1000}s`)
  const [out, err, code] = settled
  if (!answered(command, code, err)) {
    throw new Error(`${label} exited ${code}: ${(err || out).trim().slice(0, 200)}`)
  }
  return out
}
