import "@packages/env/aliases"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { slotOfName } from "@packages/config/kinds"
import { dataDir, dataDirOf } from "@packages/env/data-dir"
import {
  accountSettings,
  accountsOf,
  liveSettings,
  type Backend,
  modelSettings,
  readPin,
  readPolicyOrDefaults,
} from "@packages/settings"

import { inRecordedForm } from "../../../../api/hono/src/lib/sessions/proc-start"
import { portlessCa, portlessDir } from "../portless-ca"
import {
  dashboardBeatOf,
  staleBeat,
  stepQueued,
  type DashboardBeat,
  type Dispatcher,
  type Probes,
  type Redirect,
} from "./plan"

// The data folder spawn.sh keeps its briefs and backend pins in: PLAYGROUND_DATA_DIR, else ~/.playground, never CLAUDE_CONFIG_DIR.
export const homeDataDir = (): string => dataDirOf(process.env)

// The Claude config folder sessions register in; under inscope's own folder spawn.sh launches from ~/.claude, so the registry is read there, as spawn.sh reads it.
const configDir = (): string =>
  process.env.INSCOPE_CCD
    ? join(homedir(), ".claude")
    : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")

const run = (
  argv: string[],
  cwd?: string,
  timeout = 10_000,
  env?: Record<string, string | undefined>,
): { code: number; out: string } => {
  const child = Bun.spawnSync(argv, { cwd, env, stderr: "pipe", stdout: "pipe", timeout })
  return { code: child.exitCode ?? 1, out: child.stdout.toString().trim() }
}

// The live dashboard's branch, which its checkout is on (live.branch): its default until a first setting writes policy.json, so a first start runs after ext init stopped; a policy.json that does not parse throws.
export const liveBranch = (): string => {
  const read = readPolicyOrDefaults(dataDir())
  if (read.refusal !== undefined) throw new Error(read.refusal)
  return liveSettings.get(read.settings, "live.branch")
}

// What a verb that needs the Dashboard's checkout says before a first start has cut it.
export const NO_CHECKOUT = "no Dashboard checkout yet; run playground once to set it up"

// The checkout on the live dashboard's branch, from the worktrees git lists for this checkout.
export const dashboardCheckout = (
  repo: string,
  exec = run,
  branch = liveBranch(),
): string | null => {
  const { code, out } = exec(["git", "-C", repo, "worktree", "list", "--porcelain"])
  if (code !== 0) return null
  for (const block of out.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    if (path && block.split("\n").includes(`branch refs/heads/${branch}`)) return path
  }
  return null
}

// Where a fresh install's first start cuts the Dashboard's checkout.
export const dashboardPath = (repo: string): string => join(repo, ".claude", "worktrees", "desk")

// A fresh install's first start: the Dashboard's checkout cut at dashboardPath() on its branch, from origin's main, the shipped branch, whatever origin's default is (else HEAD), then installed; or the line that says which step failed.
export const cutDashboardCheckout = (
  repo: string,
  exec = run,
  branch = liveBranch(),
): { checkout: string } | { error: string } => {
  const main = exec(["git", "-C", repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/main"])
  const base = main.code === 0 && main.out ? "origin/main" : "HEAD"
  const checkout = dashboardPath(repo)
  const added = exec(["git", "-C", repo, "worktree", "add", "-b", branch, checkout, base])
  if (added.code !== 0) return { error: `could not cut the Dashboard's checkout at ${checkout}` }
  if (exec(["bun", "install"], checkout, 600_000).code !== 0)
    return { error: `bun install failed in the Dashboard's checkout, ${checkout}` }
  return { checkout }
}

export type Urls = { api: string; web: string }

// The dashboard opens on its bare name, which its stack aliases beside its own `desk.`-prefixed ones, while its API keeps the `desk.`-prefixed name its page calls. portless get reads the state folder portlessDir() picks, so each URL names the proxy that serves, the 1355 fallback's scheme and port included, never an idle ~/.portless's guess.
export const dashboardUrls = (dashboard: string): Urls | null => {
  const env = { ...process.env, PORTLESS_STATE_DIR: portlessDir() }
  const get = (...name: string[]) =>
    run(["bunx", "portless", "get", ...name], dashboard, 10_000, env).out
  const web = get("playground", "--no-worktree")
  const api = get("api.playground")
  return web.startsWith("http") && api.startsWith("http") ? { api, web } : null
}

// portless answers 404 for a name no stack serves, so only the stack's own answer counts as up; an https dashboard's certificate is checked against portless's CA, which Bun's own store lacks.
const answers = async (url: string): Promise<Response | null> => {
  const ca = portlessCa()
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
      ...(ca ? { tls: { ca: Bun.file(ca) } } : {}),
    })
  } catch {
    return null
  }
}

// The API's health read: up on a 200 alone; a 3xx, as the 1355 proxy's from http to https, keeps the URL asked and where it was sent, so the wait can name the address it should ask.
export const apiRead = async (
  urls: Urls | null,
): Promise<{ redirect: Redirect | null; up: boolean }> => {
  if (!urls) return { redirect: null, up: false }
  const from = `${urls.api}/api/health`
  const response = await answers(from)
  const status = response?.status ?? 0
  const to = response?.headers.get("location") ?? "no Location header"
  return {
    redirect: status >= 300 && status < 400 ? { from, status, to } : null,
    up: status === 200,
  }
}

export const apiUp = async (urls: Urls | null): Promise<boolean> => (await apiRead(urls)).up

export const webUp = async (urls: Urls | null): Promise<boolean> => {
  const response = urls ? await answers(urls.web) : null
  return !!response && response.status < 400
}

// The live sessions holding a dispatcher's name: a registry file whose pid runs with the start time the file records, in the form it records it (inRecordedForm), as spawn.sh counts them.
export const liveDispatchers = (): Dispatcher[] => liveSessions((name) => slotOfName(name) !== null)

// The live sessions whose name keep takes, counted as liveDispatchers counts them.
export const liveSessions = (keep: (name: string) => boolean): Dispatcher[] => {
  const folder = join(configDir(), "sessions")
  const found = new Map<number, string>()
  let files: string[] = []
  try {
    files = readdirSync(folder)
  } catch {
    return []
  }
  const starts = new Map<number, string>()
  const entries: { name: string; pid: number; procStart: unknown }[] = []
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    try {
      const data = JSON.parse(readFileSync(join(folder, file), "utf8"))
      if (typeof data?.name === "string" && keep(data.name))
        entries.push({
          name: data.name,
          pid: Number.parseInt(file, 10),
          procStart: data.procStart,
        })
    } catch {}
  }
  if (!entries.length) return []
  const ps = Bun.spawnSync(
    ["ps", "-o", "pid=,lstart=", "-p", entries.map((e) => e.pid).join(",")],
    {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdout: "pipe",
    },
  )
  for (const line of ps.stdout.toString().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (match) starts.set(Number(match[1]), match[2]!.split(/\s+/).join(" "))
  }
  const recorded = inRecordedForm(starts, entries)
  for (const entry of entries) {
    const start = recorded.get(entry.pid)
    if (start === undefined) continue
    if (typeof entry.procStart === "string" && entry.procStart.split(/\s+/).join(" ") !== start)
      continue
    found.set(entry.pid, entry.name)
  }
  return [...new Set(found.values())].map((name) => ({
    backend: backendOf(name),
    name,
  }))
}

const backendOf = (name: string): Backend | null => {
  try {
    return readPin(readFileSync(join(homeDataDir(), "backends", name), "utf8"))?.backend ?? null
  } catch {
    return null
  }
}

// Only that the Keychain item spawn.sh's GLM backend reads by default (models.glmKeychainService, the first GLM row's label) exists: no -w, so the key is never read; a render set it cannot trust reads as not set up.
export const glmSetUp = async (): Promise<boolean> => {
  const read = readPolicyOrDefaults(dataDir())
  if (read.refusal !== undefined) return false
  const service = modelSettings.get(read.settings, "models.glmKeychainService")
  const label = accountsOf(accountSettings.get(read.settings, "usage.accounts"), "glm")[0]?.label
  if (!label) return false
  return run(["security", "find-generic-password", "-s", service, "-a", label]).code === 0
}

// The lines a log gained past offset, a size in bytes read before.
export const linesSince = async (file: string, offset: number): Promise<string[]> => {
  try {
    return (await Bun.file(file).slice(offset).text()).split("\n").filter(Boolean)
  } catch {
    return []
  }
}

// The dashboard's supervisor state folder (scripts/ops/dashboard/supervisor.sh), which records each child's pid and logs each roll.
export const opsDashboard = (): string => join(dataDir(), "ops", "dashboard")

const pidAlive = (file: string): boolean => {
  try {
    process.kill(Number.parseInt(readFileSync(file, "utf8"), 10), 0)
    return true
  } catch {
    return false
  }
}

// The follower the supervisor started, by the pid it recorded; nothing reads the dashboard's database.
export const followerRunning = (): boolean => pidAlive(join(opsDashboard(), "dashboard-ingest.pid"))

// Whether the supervisor's current prebuild step still queues in run-slot (stepQueued), from its prebuild.pid and the last 3000 lines of run-slot.runs.log.
export const prebuildQueued = (): boolean => {
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  }
  const runs = (read(join(dataDir(), "ops", "run-slot.runs.log")) ?? "").split("\n").slice(-3000)
  return stepQueued(
    read(join(opsDashboard(), "prebuild.pid")),
    (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    runs,
  )
}

// The ops-dashboard job's heartbeat: its age, its cycle and whether the pid that wrote it still runs; null with no file that reads.
export const dashboardBeat = (now = Date.now()): DashboardBeat | null => {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(join(opsDashboard(), "..", "ops-dashboard.json"), "utf8"))
  } catch {
    return null
  }
  return dashboardBeatOf(json, now, (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
}

// The supervisor itself: the ops-dashboard job's heartbeat, fresh within three cycles, from a pid still running.
export const supervisorRunning = (): boolean => {
  const beat = dashboardBeat()
  return !!beat && beat.running && !staleBeat(beat)
}

// The machine's boot time, epoch seconds, from sysctl on macOS and /proc/stat btime on Linux, else 0, so a start is held only while the machine that made it still runs, mirroring up.py boot_time().
export const bootTime = (): number => {
  if (process.platform === "darwin") {
    try {
      const mac = Bun.spawnSync(["sysctl", "-n", "kern.boottime"], { stdout: "pipe" })
      const m = mac.exitCode === 0 ? mac.stdout.toString().match(/\bsec = (\d+)/) : null
      if (m) return Number(m[1])
    } catch {
      return 0
    }
  }
  try {
    for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
      if (line.startsWith("btime ")) {
        const secs = line.trim().split(/\s+/)[1]
        if (secs) return Number(secs)
      }
    }
  } catch {
    return 0
  }
  return 0
}

// The heartbeat's recorded start at, epoch seconds, else 0: up.py's beat_started, so a start at or after the one up.py made ends the grace.
const readStartedAt = (): number => {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(join(opsDashboard(), "..", "ops-dashboard.json"), "utf8"))
  } catch {
    return 0
  }
  const at =
    json && typeof (json as Record<string, unknown>)["startedAt"] === "string"
      ? Date.parse((json as Record<string, unknown>)["startedAt"] as string)
      : Number.NaN
  return Number.isNaN(at) ? 0 : Math.floor(at / 1000)
}

// Whether the start grace has already ended, so up.py will start ops-dashboard again and the wait need not hold it: the heartbeat recorded a later start, or the machine booted at or after the recorded one.
export const graceEnded = (startAt: number, beat: number, boot: number): boolean =>
  (beat > 0 && beat >= startAt) || (startAt > 0 && startAt <= boot)

// Whether up.py still holds ops-dashboard's start: its grace has not ended early, so the wait need not bail, and its start is within up.py's 600s, so the Dashboard's wait keeps waiting for it to start again, not bailing on a beat up.py has not had time to refresh.
export const upHolds = (now: number = Date.now()): boolean => {
  let starts: unknown
  try {
    starts = JSON.parse(readFileSync(join(dataDir(), "ops", "up-state.json"), "utf8"))
  } catch {
    return false
  }
  if (typeof starts !== "object" || starts === null) return false
  const start = Number((starts as Record<string, unknown>)["ops-dashboard"])
  if (!Number.isFinite(start)) return false
  if (graceEnded(start, readStartedAt(), bootTime())) return false
  return now - start * 1000 < 600 * 1000
}

export const probe = async (urls: Urls | null): Promise<Probes> => ({
  api: await apiUp(urls),
  dispatchers: liveDispatchers(),
  follower: followerRunning(),
  glm: await glmSetUp(),
  web: await webUp(urls),
})
