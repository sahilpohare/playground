import { existsSync } from "node:fs"
import { statfs } from "node:fs/promises"
import { cpus, homedir, hostname, loadavg, totalmem } from "node:os"
import { dirname, join } from "node:path"

import type { Peer } from "@packages/config/org"

import {
  accountFor,
  readAccount,
  readAccounts,
  readLogin,
  type Account,
} from "@/lib/dashboard/account"
import { agentRoleOf, matchAgents, type Agent } from "@/lib/dashboard/agents"
import { readFixtureMachine, readsLive } from "@/lib/dashboard/fixture"
import { herdrProblem } from "@/lib/dashboard/herdr"
import { dashboardHub } from "@/lib/dashboard/hub"
import { readRegistry, sessionsDir } from "@/lib/dashboard/peers"
import { checkoutPulls, pullsUrlOf } from "@/lib/dashboard/repo"
import { readRoster, type RosterAgent } from "@/lib/dashboard/roster"
import { updateCheck, type Update } from "@/lib/dashboard/update"
import { unstickProblem } from "@/lib/dashboard/workers"
import { org } from "@/lib/org"
import { ownRegistered } from "@/lib/sessions/own"
import { hasGlmAccount } from "@/lib/store/accounts"
import {
  idleLineOf,
  orchestratorsOf,
  PER_ORCHESTRATOR,
  PER_WORKER,
  roomOf,
  type Fit,
  type IdleStack,
  type Limit,
} from "@/lib/system/capacity"
import { footprintOf, type Container, type Session, type Stack } from "@/lib/system/footprint"
import { memoryReads } from "@/lib/system/memory"
import {
  parseContainers,
  parseContainerStats,
  parseCwds,
  parseDockerHost,
  parseHolders,
  parsePeer,
  parsePs,
  parseSockets,
  type MachineReading,
  type Pressure,
  type Proc,
  type Sockets,
  type Sysctl,
} from "@/lib/system/parse"
import { probe } from "@/lib/system/probe"
import { type AccountUsage, readUsage, seenWindows, type Usage, withSeen } from "@/lib/usage/window"
import { readZaiUsage, type ZaiUsage } from "@/lib/usage/zai"

// The System panel's sampler: every 30s it reads the machine, joins the processes to the sessions that own them and keeps up to an hour of the totals in memory, writing nothing anywhere. It starts on the first read and stops 20 minutes after the last, so a verify run on a worker's test stack costs a few minutes of sampling rather than its life; any open dashboard page reads every 30s through the sidebar's System item and keeps it going.
export const INTERVAL_MS = 30_000
export const HISTORY_MS = 60 * 60 * 1000
export const HISTORY_POINTS = HISTORY_MS / INTERVAL_MS
export const STOP_UNREAD_MS = 20 * 60 * 1000

// A timer that has not ticked for this long has gone: a `bun --hot` reload that fails keeps this module but clears its timers.
export const QUIET_MS = 2 * INTERVAL_MS + 5000

// A worker's stack whose processes used under 1% of a core in every sample for 15 minutes is idle: next dev and the API sit near zero between requests and climb past it while anyone builds or browses.
export const IDLE_AFTER_MS = 15 * 60 * 1000
export const IDLE_CPU_PERCENT = 1

export type SystemStack = {
  bytes: number
  checkout: string
  containers: { bytes: number | null; name: string }[]
  cpuPercent: number
  idleSince: string | null
  processes: number
}

export type SystemAgent = {
  bytes: number
  claudeBytes: number
  cpuPercent: number
  name: string
  pid: number
  role: Agent["role"]
  sessionId: string
  stacks: SystemStack[]
}

// One machine of a cluster: its reading, or why it did not read and since when, so a total never drops to fewer machines quietly.
export type SystemMachine = {
  down: { reason: string; since: string } | null
  name: string
  reading: MachineReading | null
}

// One peer's read in a sample: its reading, or the problem that kept it out.
export type PeerRead = { name: string; problem: string | null; reading: MachineReading | null }

export type SystemPoint = {
  at: string
  load1: number
  swapUsedBytes: number | null
  usedBytes: number | null
  // The signed-in account's week share as read then, so the usage tooltip can show its burn over the last hour; null with no fresh reading.
  week: { account: string; used: number } | null
}

export type SystemReport = {
  // The Claude account the usage windows reflect, which the user menu shows; null when none is known.
  account: Account | null
  // Every account's own usage file, the main login first; with fewer than two the readings come from usage alone.
  accounts: AccountUsage[]
  agents: SystemAgent[]
  capacity: {
    idle: { bytes: number; line: string | null; ready: boolean; stacks: IdleStack[] }
    limitedBy: Limit | null
    line: string
    // How many more orchestrators fit, each a claude alone, and what limits them.
    orchestrators: Fit
    perOrchestrator: { bytes: number; cores: number }
    perWorker: { bytes: number; cores: number }
    workers: number
  }
  cpu: { cores: number; load: [number, number, number] }
  detached: SystemStack[]
  disk: { freeBytes: number; totalBytes: number } | null
  docker: {
    containers: { bytes: number | null; name: string; stack: string | null }[]
    problem: string | null
    vmBytes: number | null
  }
  history: SystemPoint[]
  // This machine first, then each peer org.ts's cluster names, for the System page's sums; empty with no peers, so one machine shows alone.
  machines: SystemMachine[]
  memory: {
    freePercent: number | null
    pressure: Pressure | null
    swap: { totalBytes: number; usedBytes: number } | null
    totalBytes: number
    usedBytes: number | null
  }
  // The machine's operating system as Node names it (`darwin`, `linux`), so the panel words what differs between them; a fixture stack's made-up machine is `darwin` unless its fixture says otherwise.
  platform: string
  problems: string[]
  // The pull requests page of this checkout's GitHub origin, which the sidebar's GitHub icon links to; null with no GitHub origin.
  pulls: string | null
  sampledAt: string
  // How far this build is behind the branch its checkout follows, null when that cannot be read (the reason is in problems) or before the first check.
  update: Update | null
  usage: Usage | null
  // The GLM plan's credit windows, which the sidebar shows on a dispatcher row of their own; null while usage.accounts holds no GLM row or no file was read.
  zai: ZaiUsage | null
}

// Everything one sample read, before it is joined: a probe that failed leaves its part empty and says why in problems.
export type Readings = {
  account: Account | null
  accounts: AccountUsage[]
  cores: number
  cwds: Map<number, string>
  disk: { freeBytes: number; totalBytes: number } | null
  docker: { containers: Container[]; problem: string | null; vmPid: number | null }
  // Whether usage.accounts holds a GLM row, without which the GLM windows are a file left behind and show nowhere.
  glmAccount: boolean
  // This machine's name on the System page beside its peers.
  hostname: string
  load: [number, number, number]
  // Each peer's read, in org.ts's cluster order; empty with no peers.
  peers: PeerRead[]
  platform: string
  problems: string[]
  procs: Proc[]
  pulls: string | null
  roster: RosterAgent[]
  sessions: Session[]
  sockets: Sockets
  sysctl: Sysctl
  totalBytes: number
  update: Update | null
  usage: Usage | null
  usedBytes: number | null
  // Each live session's herdr workspace, from the dashboard's own live list when it has one, so a roster agent pairs with its session the way the dashboard pairs it.
  workspaces: Map<string, string>
  zai: ZaiUsage | null
}

// What a sample carries to the next: each process's CPU time as of sampledAt (the last sample whose ps answered), when each stack was last busy, since when each peer has not read, and the hour of totals.
export type SamplerState = {
  busyAt: Map<string, number>
  cpuSeconds: Map<number, number>
  downSince: Map<string, number>
  history: SystemPoint[]
  sampledAt: number | null
  startedAt: number
}

export const freshState = (now: number): SamplerState => ({
  busyAt: new Map(),
  cpuSeconds: new Map(),
  downSince: new Map(),
  history: [],
  sampledAt: null,
  startedAt: now,
})

// Pure: each process's share of one core since the last sample. A process the last sample did not see started since, so all its CPU time is new.
export function cpuShares(procs: Proc[], state: SamplerState, now: number): Map<number, number> {
  const shares = new Map<number, number>()
  if (state.sampledAt === null || now <= state.sampledAt) return shares
  const seconds = (now - state.sampledAt) / 1000
  for (const p of procs) {
    const before = state.cpuSeconds.get(p.pid) ?? 0
    shares.set(p.pid, (Math.max(0, p.cpuSeconds - before) / seconds) * 100)
  }
  return shares
}

const round = (n: number): number => Math.round(n * 10) / 10

// Pure: one sample's readings joined into the report, with the state the next sample starts from.
export function compose(
  readings: Readings,
  state: SamplerState,
  now: number,
  checkoutOf: (cwd: string) => string | null,
): { report: SystemReport; state: SamplerState } {
  const { procs, sysctl } = readings
  const cpu = cpuShares(procs, state, now)
  const footprint = footprintOf({
    checkoutOf,
    containers: readings.docker.containers,
    cpu,
    cwds: readings.cwds,
    procs,
    sessions: readings.sessions,
    sockets: readings.sockets,
  })

  // A stack seen for the first time counts as busy then, since nothing says how long it has idled.
  const busyAt = new Map<string, number>()
  const track = (owner: string, stack: Stack): SystemStack => {
    const key = `${owner}|${stack.checkout}`
    const busy = stack.cpuPercent >= IDLE_CPU_PERCENT ? now : (state.busyAt.get(key) ?? now)
    busyAt.set(key, busy)
    return {
      bytes: stack.bytes,
      checkout: stack.checkout,
      containers: stack.containers,
      cpuPercent: round(stack.cpuPercent),
      idleSince: now - busy >= IDLE_AFTER_MS ? new Date(busy).toISOString() : null,
      processes: stack.pids.length,
    }
  }

  // Each session pairs with its roster agent as the dashboard pairs them (by name, by name without its role prefix, else by workspace), so the System table names and ranks it as the status table above does.
  const live = footprint.sessions.map((session) => {
    const ref = readings.workspaces.get(session.sessionId)
    return { name: session.name, session, workspace: ref ? { ref } : null }
  })
  const agents: SystemAgent[] = matchAgents(readings.roster, live)
    .flatMap(({ live: paired, roster }) => {
      if (!paired) return []
      const { session } = paired
      return [
        {
          bytes: session.bytes,
          claudeBytes: session.claudeBytes,
          cpuPercent: round(session.cpuPercent),
          name: roster?.name ?? session.name,
          pid: session.pid,
          role: roster?.role ?? agentRoleOf(session.name),
          sessionId: session.sessionId,
          stacks: session.stacks.map((stack) => track(session.sessionId, stack)),
        },
      ]
    })
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
  const detached = footprint.detached
    .map((stack) => track("detached", stack))
    .sort((a, b) => b.bytes - a.bytes)

  // Only a worker's stack is offered up: a runner's keeps the live dashboard or another long job alive, a manager's is its own call, and a detached process may be shared (the portless proxy).
  const idleStacks: IdleStack[] = agents.flatMap((agent) =>
    agent.role !== "worker"
      ? []
      : agent.stacks.flatMap((stack) =>
          stack.idleSince
            ? [
                {
                  bytes: stack.bytes,
                  checkout: stack.checkout,
                  idleSince: stack.idleSince,
                  name: agent.name,
                },
              ]
            : [],
        ),
  )

  const swap = sysctl.swap
  const machine = {
    cores: readings.cores,
    freePercent: sysctl.freePercent,
    load5: readings.load[1],
    pressure: sysctl.pressure,
    totalBytes: readings.totalBytes,
  }
  const room = roomOf(machine)
  // With peers, the machines the System page sums: this one first, then each peer, one that did not read keeping since when it has not.
  const local: MachineReading = {
    cores: readings.cores,
    disk: readings.disk,
    load: readings.load.map(round) as [number, number, number],
    memory: { totalBytes: readings.totalBytes, usedBytes: readings.usedBytes },
    swap,
  }
  const downSince = new Map<string, number>()
  const machines: SystemMachine[] =
    readings.peers.length === 0
      ? []
      : [
          { down: null, name: readings.hostname, reading: local },
          ...readings.peers.map((peer): SystemMachine => {
            if (peer.reading) return { down: null, name: peer.name, reading: peer.reading }
            const since = state.downSince.get(peer.name) ?? now
            downSince.set(peer.name, since)
            return {
              down: {
                reason: peer.problem ?? "it did not read",
                since: new Date(since).toISOString(),
              },
              name: peer.name,
              reading: null,
            }
          }),
        ]
  // The hour's sparklines follow the figures beside them: the sums over every machine that read.
  const parts =
    machines.length === 0 ? [local] : machines.flatMap((m) => (m.reading ? [m.reading] : []))
  const swaps = parts.flatMap((p) => (p.swap ? [p.swap.usedBytes] : []))
  const point: SystemPoint = {
    at: new Date(now).toISOString(),
    load1: round(parts.reduce((sum, p) => sum + p.load[0], 0)),
    swapUsedBytes: swaps.length === 0 ? null : swaps.reduce((a, b) => a + b, 0),
    usedBytes: parts.some((p) => p.memory.usedBytes === null)
      ? null
      : parts.reduce((sum, p) => sum + (p.memory.usedBytes ?? 0), 0),
    week:
      readings.account && readings.usage?.sevenDay && !readings.usage.sevenDay.seenAt
        ? { account: readings.account.email, used: readings.usage.sevenDay.usedPercent }
        : null,
  }
  // The last hour by time as well as by count, since samples taken only on reads arrive further apart than the timer's.
  const history = [...state.history, point]
    .filter((p) => now - Date.parse(p.at) < HISTORY_MS)
    .slice(-HISTORY_POINTS)
  const vm = readings.docker.vmPid
  const report: SystemReport = {
    account: readings.account,
    accounts: readings.accounts,
    agents,
    capacity: {
      idle: {
        bytes: idleStacks.reduce((sum, stack) => sum + stack.bytes, 0),
        line: idleLineOf(idleStacks),
        ready: now - state.startedAt >= IDLE_AFTER_MS,
        stacks: idleStacks,
      },
      limitedBy: room.limitedBy,
      line: room.line,
      orchestrators: orchestratorsOf(machine),
      perOrchestrator: PER_ORCHESTRATOR,
      perWorker: PER_WORKER,
      workers: room.workers,
    },
    cpu: {
      cores: readings.cores,
      load: readings.load.map(round) as [number, number, number],
    },
    detached,
    disk: readings.disk,
    docker: {
      containers: footprint.containers
        .map(({ bytes, name, stack }) => ({ bytes, name, stack }))
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name)),
      problem: readings.docker.problem,
      vmBytes: vm === null ? null : (procs.find((p) => p.pid === vm)?.rssBytes ?? null),
    },
    history,
    machines,
    memory: {
      freePercent: sysctl.freePercent,
      pressure: sysctl.pressure,
      swap,
      totalBytes: readings.totalBytes,
      usedBytes: readings.usedBytes,
    },
    platform: readings.platform,
    problems: readings.problems,
    pulls: readings.pulls,
    sampledAt: point.at,
    update: readings.update,
    usage: readings.usage,
    zai: readings.glmAccount ? readings.zai : null,
  }
  // A sample whose ps failed read no process, so the CPU times of the last that did carry on, and the next one's shares span both intervals rather than charging each process its whole life.
  const read = procs.length > 0
  return {
    report,
    state: {
      busyAt,
      cpuSeconds: read ? new Map(procs.map((p) => [p.pid, p.cpuSeconds])) : state.cpuSeconds,
      downSince,
      history,
      sampledAt: read ? now : state.sampledAt,
      startedAt: state.startedAt,
    },
  }
}

// The checkout a directory sits in: the nearest one holding .git, a worktree's own (a file) before its main checkout's (a folder). A directory that is gone, a deleted worktree, is its own place rather than the checkout above it.
const checkouts = new Map<string, string | null>()

export function checkoutOf(cwd: string): string | null {
  if (checkouts.has(cwd)) return checkouts.get(cwd) ?? null
  if (checkouts.size > 2000) checkouts.clear()
  let found: string | null = existsSync(cwd) ? null : cwd
  for (let dir = cwd; !found; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) found = dir
    if (dir === dirname(dir)) break
  }
  checkouts.set(cwd, found)
  return found
}

const problemOf = (what: string, error: unknown): string =>
  `${what}: ${error instanceof Error ? error.message : String(error)}`

// Docker's VM is the host process holding the daemon's socket, so it is found by that socket rather than by its name: OrbStack's VM here, and Docker Desktop's backend where that runs. It is kept until that process is gone.
let vmPid: number | null = null

async function vmOf(procs: Proc[]): Promise<number | null> {
  if (vmPid !== null && procs.some((p) => p.pid === vmPid)) return vmPid
  const host = parseDockerHost(await probe("dockerHost").catch(() => ""))
  const holders = host ? parseHolders(await probe("socketHolder", host).catch(() => "")) : []
  vmPid = holders.sort((a, b) => a - b)[0] ?? null
  return vmPid
}

// Each peer's ssh read, all at once beside the sample's other probes, each bounded by its ConnectTimeout and probe()'s kill, so a peer that is down or hangs never holds the sample: it comes back with its problem and no reading.
export const readPeers = (peers: readonly Peer[]): Promise<PeerRead[]> =>
  Promise.all(
    peers.map(({ name, target }) =>
      probe("peer", target)
        .then((out) => {
          const reading = parsePeer(out)
          if (!reading) throw new Error("its /proc reading did not parse")
          return { name, problem: null, reading }
        })
        .catch((error: unknown) => ({
          name,
          problem: error instanceof Error ? error.message : String(error),
          reading: null,
        })),
    ),
  )

// One sample's readings, every probe at once, docker stats (the slowest, about 2s) among them. Each failure is named in problems and leaves its part empty, so one missing tool never blanks the panel.
export async function read(): Promise<Readings> {
  const problems: string[] = []
  const uid = process.getuid?.() ?? 0
  const settle = async <T>(what: string, work: Promise<T>, fallback: T): Promise<T> =>
    work.catch((error: unknown) => {
      problems.push(problemOf(what, error))
      return fallback
    })
  // A fixture stack reads its made-up machine's size, load, update, origin and account too, not this one's, and fetches nothing.
  const machine = readsLive() ? null : readFixtureMachine()
  const made = machine?.system ?? null
  const update = machine ? { problem: null, update: machine.update ?? null } : updateCheck.read()
  if (update.problem) problems.push(update.problem)
  const memory = memoryReads(!machine && process.platform === "linux", problems)
  const disk = made
    ? Promise.resolve(made.disk)
    : statfs(homedir()).then(
        (fs) => ({ freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize }),
        () => null,
      )
  const docker = Promise.allSettled([probe("containers"), probe("containerStats")])
  const peers = readPeers(made ? (made.peers ?? []) : org.cluster.peers)
  const [account, accounts, sysctl, used, procs, cwds, sockets, registry, roster, usage, zai] =
    await Promise.all([
      machine
        ? readLogin().then((login) => accountFor(login, machine.account ?? null))
        : readAccount(),
      readAccounts(),
      settle(memory.sysctl.what, memory.sysctl.read, {
        freePercent: null,
        pressure: null,
        swap: null,
      }),
      settle(memory.usedBytes.what, memory.usedBytes.read, null),
      settle("ps", probe("processes").then(parsePs), []),
      settle("lsof", probe("cwds", uid).then(parseCwds), new Map<number, string>()),
      settle("lsof", probe("sockets", uid).then(parseSockets), {
        connects: new Map(),
        listens: new Set<number>(),
      }),
      readRegistry(),
      readRoster().catch(() => null),
      readUsage().then((usage) => usage && withSeen(usage, seenWindows)),
      readZaiUsage(),
    ])
  // The dashboard proves a herdr pane's session live by Claude's registry; without it, it takes the session each pane reports at its word, which can name one that has ended, so the fallback is named rather than silent.
  if (registry === null) {
    problems.push(
      `Claude's session registry (${sessionsDir()}) cannot be read, so live sessions are judged by herdr's panes alone and one that has ended may still show`,
    )
  }
  const [listed, stats] = await docker
  const usageById = stats.status === "fulfilled" ? parseContainerStats(stats.value) : new Map()
  return {
    account,
    accounts,
    cores: made?.cores ?? cpus().length,
    cwds,
    disk: await disk,
    docker:
      listed.status === "rejected"
        ? { containers: [], problem: problemOf("Docker", listed.reason), vmPid: null }
        : {
            containers: parseContainers(listed.value).map((c) => ({
              ...c,
              bytes: usageById.get(c.id) ?? null,
            })),
            problem: stats.status === "rejected" ? problemOf("docker stats", stats.reason) : null,
            vmPid: await vmOf(procs),
          },
    glmAccount: hasGlmAccount(),
    hostname: made ? (made.hostname ?? "this machine") : hostname(),
    load: made?.load ?? (loadavg() as [number, number, number]),
    peers: await peers,
    platform: made ? (made.platform ?? "darwin") : process.platform,
    problems,
    procs,
    pulls: machine ? pullsUrlOf(machine.origin ?? null) : checkoutPulls(),
    roster: roster?.roster?.agents ?? [],
    sessions: ownRegistered(registry),
    sockets,
    sysctl,
    totalBytes: made?.totalBytes ?? totalmem(),
    update: update.update,
    usage,
    usedBytes: used,
    workspaces: new Map(
      (dashboardHub.snapshot?.workers ?? []).flatMap((w) =>
        w.workspace ? [[w.sessionId, w.workspace.ref] as const] : [],
      ),
    ),
    zai,
  }
}

export type SamplerClock = {
  cancel: (timer: unknown) => void
  checkoutOf: (cwd: string) => string | null
  now: () => number
  read: () => Promise<Readings>
  schedule: (tick: () => void, ms: number) => unknown
}

// Named in problems while the timer has stopped firing, so the panel and the leads know the hour and the idle clocks fill only as fast as reads arrive.
export const TIMER_LOST =
  "The sampler's 30s timer stopped firing (a failed bun --hot reload stops every new timer in this process), so it samples on each read until the API restarts"

// The sampler's life: started by a read, ticking every INTERVAL_MS, stopped once nobody has read it for STOP_UNREAD_MS. A timer that has gone quiet (QUIET_MS without a tick) is lost: a failed `bun --hot` reload clears this process's timers and no new one fires until the API restarts. Sampling then carries on at the pace of reads, keeping its state (the hour of totals, the idle clocks, the CPU times), and says so in problems until a tick arrives again.
export class Sampler {
  // Bumped on every start and stop, so a sample still reading when the sampler restarts cannot write into the new run.
  private generation = 0
  private latest: Promise<SystemReport> | null = null
  private lost = false
  private readAt = 0
  private sampledAt = 0
  private state: SamplerState = freshState(0)
  private tickedAt = 0
  private timer: unknown = null

  constructor(private readonly clock: SamplerClock) {}

  running(now = this.clock.now()): boolean {
    return this.timer !== null && now - this.tickedAt <= QUIET_MS
  }

  // The newest report; a stopped sampler starts, and that first read waits for one sample. With the timer lost, a read finding the newest sample an interval old waits for a fresh one.
  async report(): Promise<SystemReport> {
    const now = this.clock.now()
    this.readAt = now
    if (this.timer === null) this.start(now)
    else if (!this.running(now)) this.lost = true
    if (this.lost && now - this.sampledAt >= INTERVAL_MS) {
      // A fresh sample that fails leaves the last one answering rather than the error.
      const previous = this.latest
      const fresh = this.sample()
      this.latest = previous ? fresh.catch(() => previous) : fresh
    }
    const report = await (this.latest ??= this.sample())
    const live = [this.lost ? TIMER_LOST : null, unstickProblem(), herdrProblem()].filter(
      (p) => p !== null,
    )
    return live.length ? { ...report, problems: [...report.problems, ...live] } : report
  }

  tick(): void {
    const now = this.clock.now()
    this.tickedAt = now
    this.lost = false
    if (now - this.readAt > STOP_UNREAD_MS) {
      this.stop()
      return
    }
    // The last report keeps answering while the next is read, so no request waits on docker stats.
    const generation = this.generation
    this.sample().then(
      (report) => {
        if (generation === this.generation) this.latest = Promise.resolve(report)
      },
      () => {},
    )
  }

  private start(now: number): void {
    this.stop()
    this.state = freshState(now)
    this.tickedAt = now
    const first = this.sample()
    this.latest = first
    first.catch(() => {
      if (this.latest === first) this.latest = null
    })
    this.timer = this.clock.schedule(() => this.tick(), INTERVAL_MS)
  }

  private stop(): void {
    this.generation++
    if (this.timer !== null) this.clock.cancel(this.timer)
    this.lost = false
    this.timer = null
    this.latest = null
    this.state = freshState(0)
  }

  private async sample(): Promise<SystemReport> {
    const generation = this.generation
    this.sampledAt = this.clock.now()
    const readings = await this.clock.read()
    const next = compose(readings, this.state, this.clock.now(), this.clock.checkoutOf)
    if (generation === this.generation) this.state = next.state
    return next.report
  }
}

const sampler = new Sampler({
  cancel: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  checkoutOf,
  now: Date.now,
  read,
  schedule: (tick, ms) => setInterval(tick, ms),
})

// The commands are macOS's, while Linux's memory readings come from /proc; elsewhere each one that fails is named in problems.
export const systemReport = (): Promise<SystemReport> => sampler.report()
