import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { site } from "@packages/config/site"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sql/migrator"

import {
  CONTAINER_LIST,
  containersOf,
  isLiveDatabase,
  type LiveDashboard,
  liveDatabaseHeld,
  livePair,
  unreusedLiveDatabase,
} from "@/lib/dev/live-dashboard"
import { startPglite } from "@/lib/pglite"
import { provenLocal } from "@/lib/sessions/guard"

// First run's Start a local container: Postgres started by pglaunch as it is (the owner's choice for this one step: its own postgres/postgres login, published on every interface), proved local as bun run ingest proves it, migrated, and named in .env. Every call is a fixed argv: pglaunch is pinned exactly and given the checkout's container name, and nothing comes from a request.

export type RunResult = { code: number; stderr: string; stdout: string }
export type Run = (args: string[]) => Promise<RunResult>

export const DOCKER_DOWN =
  "Docker is not running. Install OrbStack (orbstack.dev) or Docker Desktop, start it, then click Try again."

// `bunx --bun pglaunch@5.5.7 -k -n <name>`: -k keeps the container, which it names <name>-<4 letters or digits>.
export const PGLAUNCH = "pglaunch@5.5.7"

const MIGRATIONS = join(import.meta.dir, "../../../../../packages/db/drizzle")
const READY_TRIES = 30

export class SetupError extends Error {}

const runner =
  (command: string): Run =>
  async (args) => {
    if (!Bun.which(command)) return { code: 127, stderr: `${command} is not on PATH`, stdout: "" }
    const child = Bun.spawn([command, ...args], { stderr: "pipe", stdin: "ignore", stdout: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stderr, stdout }
  }

// Pure: the container's name, playground-db for a checkout of its own and playground-<worktree>-db in a worktree under .claude/worktrees/, as AGENTS.md names a worktree's database.
export const containerName = (root: string): string => {
  const worktree = /\/\.claude\/worktrees\/([^/]+)\/?$/.exec(root)?.[1]
  return worktree ? `playground-${worktree.replace(/[^a-zA-Z0-9_.-]/g, "-")}-db` : "playground-db"
}

// Pure: the name setup starts, the live dashboard's database on its own branch (a fresh install's dashboard checkout), else the checkout's own.
export const setupName = (
  root: string,
  branch: string | null,
  liveDashboard: LiveDashboard = livePair(),
): string => (branch === liveDashboard.branch ? liveDashboard.database : containerName(root))

// Pure: .env with POSTGRES_URL set to url, replacing the line that names it or adding one.
export const withDatabase = (text: string, url: string): string => {
  const line = `POSTGRES_URL=${url}`
  if (/^POSTGRES_URL=.*$/m.test(text)) return text.replace(/^POSTGRES_URL=.*$/m, line)
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`
}

// Pure: the URL and container pglaunch printed, from the one it started (`name "<name> :<port>" started`) or, on a name already running, the one it found (`similar name "<name>"`, as it exits 1); null with no URL.
export const parseLaunch = (out: string): { container: string; url: string } | null => {
  const url = /postgres(?:ql)?:\/\/[\w.:@\-/%?=&]+/.exec(out)?.[0]
  if (!url) return null
  const container = (/name "([^" ]+) :\d+" started/.exec(out) ??
    /similar name "([^"]+)"/.exec(out))?.[1]
  return { container: container ?? "", url }
}

const migrate = async (url: string) => {
  const client = new SQL(url)
  try {
    await drizzleMigrate(drizzle({ client }), { migrationsFolder: MIGRATIONS })
  } finally {
    await client.close()
  }
}

export type Start = {
  branch?: string | null
  bunx?: Run
  docker?: Run
  envFile: string
  migrate?: (url: string) => Promise<void>
  name: string
  onStep: (step: string) => void
  prove?: (url: string) => Promise<string>
  wait?: (ms: number) => Promise<void>
}

// Starts Postgres and returns its URL, saved in envFile; a failure throws, and leaves the container running so Try again reuses it.
export async function startLocal({
  branch = null,
  bunx = runner("bunx"),
  docker = runner("docker"),
  envFile,
  migrate: migrateTo = migrate,
  name,
  onStep,
  prove = provenLocal,
  wait = Bun.sleep,
}: Start): Promise<string> {
  const live = livePair()
  if (name === live.database && branch !== live.branch) {
    throw new SetupError(
      `${name} holds the ${site.name} you run every day; start this checkout's own`,
    )
  }
  const before = await unsetEnv(envFile)
  onStep("Checking Docker")
  if ((await docker(["info"])).code !== 0) throw new SetupError(DOCKER_DOWN)
  if (branch === live.branch) {
    const listed = await docker(CONTAINER_LIST)
    if (listed.code !== 0) {
      throw new SetupError(
        "Docker could not list its containers, so setup cannot tell whether the live dashboard's database already exists; try again",
      )
    }
    const existing = unreusedLiveDatabase(containersOf(listed.stdout), live)
    if (existing) throw new SetupError(liveDatabaseHeld(existing))
  }
  onStep("Starting Postgres")
  const launch = async (...more: string[]) => {
    const result = await bunx(["--bun", PGLAUNCH, "-k", "-n", name, ...more])
    return { launched: parseLaunch(`${result.stdout}\n${result.stderr}`), result }
  }
  const first = await launch()
  const { launched, result } = first.launched ? first : await launch("-c")
  if (!launched?.container) {
    const said = `${result.stderr}\n${result.stdout}`.trim().slice(0, 300)
    throw new SetupError(`pglaunch printed no database address: ${said || `exit ${result.code}`}`)
  }
  // pglaunch makes its container with no restart policy, so the live dashboard's would stay stopped after a reboot
  if (isLiveDatabase(launched.container, live)) {
    onStep("Keeping Postgres running after a restart")
    const kept = await docker(["update", "--restart", "unless-stopped", launched.container])
    if (kept.code !== 0) {
      throw new SetupError(
        `docker update --restart unless-stopped ${launched.container} failed: ${kept.stderr.trim() || `exit ${kept.code}`}`,
      )
    }
  }
  onStep("Waiting for Postgres")
  let ready = false
  for (let tries = 0; tries < READY_TRIES && !ready; tries++) {
    if (tries > 0) await wait(1_000)
    ready = (await docker(["exec", launched.container, "pg_isready", "-U", "postgres"])).code === 0
  }
  if (!ready) {
    throw new SetupError(
      `Postgres in ${launched.container} did not start in ${READY_TRIES} seconds`,
    )
  }
  onStep("Checking the database is on this Mac")
  await prove(launched.url)
  onStep("Creating the tables")
  await migrateTo(launched.url)
  onStep("Saving the database address")
  saveEnv(envFile, before, launched.url)
  return launched.url
}

export type StartPglite = Pick<Start, "envFile" | "migrate" | "name" | "onStep" | "prove"> & {
  start?: (name: string) => Promise<string>
}

// First run's Start without Docker: the checkout's own PGlite (lib/pglite.ts), proved local, migrated and named in .env as startLocal's container is; a failure throws and leaves the server running so Try again reuses it.
export async function startPgliteDatabase({
  envFile,
  migrate: migrateTo = migrate,
  name,
  onStep,
  prove = provenLocal,
  start = startPglite,
}: StartPglite): Promise<string> {
  const before = await unsetEnv(envFile)
  onStep("Starting PGlite")
  const url = await start(name)
  onStep("Checking the database is on this Mac")
  await prove(url)
  onStep("Creating the tables")
  await migrateTo(url)
  onStep("Saving the database address")
  saveEnv(envFile, before, url)
  return url
}

// envFile's text, refused when it already names a database, which the next start uses.
const unsetEnv = async (envFile: string): Promise<string> => {
  const saved = Bun.file(envFile)
  const before = (await saved.exists()) ? await saved.text() : ""
  if (/^POSTGRES_URL=[ \t]*\S/m.test(before)) {
    throw new SetupError(
      `${envFile} already names a database (POSTGRES_URL), so ${site.name} uses it on its next start`,
    )
  }
  return before
}

const saveEnv = (envFile: string, before: string, url: string) => {
  if (existsSync(envFile)) chmodSync(envFile, 0o600)
  writeFileSync(envFile, withDatabase(before, url), { mode: 0o600 })
}
