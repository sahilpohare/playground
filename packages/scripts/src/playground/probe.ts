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

import { portlessCa } from "../portless-ca"
import {
  dashboardBeatOf,
  staleBeat,
  type DashboardBeat,
  type Dispatcher,
  type Probes,
} from "./plan"

// The data folder spawn.sh keeps its briefs and backend pins in: PLAYGROUND_DATA_DIR, else ~/.playground, never CLAUDE_CONFIG_DIR.
export const homeDataDir = (): string => dataDirOf(process.env)

// The Claude config folder sessions register in; under inscope's own folder spawn.sh launches from ~/.claude, so the registry is read there, as spawn.sh reads it.
const configDir = (): string =>
  process.env.INSCOPE_CCD
    ? join(homedir(), ".claude")
    : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")

const run = (argv: string[], cwd?: string, timeout = 10_000): { code: number; out: string } => {
  const child = Bun.spawnSync(argv, { cwd, stderr: "pipe", stdout: "pipe", timeout })
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

// The dashboard opens on its bare name, which its stack aliases beside its own `desk.`-prefixed ones, while its API keeps the `desk.`-prefixed name its page calls.
export const dashboardUrls = (dashboard: string): Urls | null => {
  const web = run(["bunx", "portless", "get", "playground", "--no-worktree"], dashboard).out
  const api = run(["bunx", "portless", "get", "api.playground"], dashboard).out
  return web.startsWith("http") && api.startsWith("http") ? { api, web } : null
}

// portless answers 404 for a name no stack serves, so only the stack's own answer counts as up; an https dashboard's certificate is checked against portless's CA, which Bun's own store lacks.
const answers = async (url: string, up: (status: number) => boolean): Promise<boolean> => {
  const ca = portlessCa()
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
      ...(ca ? { tls: { ca: Bun.file(ca) } } : {}),
    })
    return up(response.status)
  } catch {
    return false
  }
}

export const apiUp = (urls: Urls | null): Promise<boolean> =>
  urls ? answers(`${urls.api}/api/health`, (status) => status === 200) : Promise.resolve(false)

export const webUp = (urls: Urls | null): Promise<boolean> =>
  urls ? answers(urls.web, (status) => status < 400) : Promise.resolve(false)

// The live sessions holding a dispatcher's name: a registry file whose pid runs with the start time the file records, as spawn.sh counts them.
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
  for (const entry of entries) {
    const start = starts.get(entry.pid)
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

export const probe = async (urls: Urls | null): Promise<Probes> => ({
  api: await apiUp(urls),
  dispatchers: liveDispatchers(),
  follower: followerRunning(),
  glm: await glmSetUp(),
  web: await webUp(urls),
})
