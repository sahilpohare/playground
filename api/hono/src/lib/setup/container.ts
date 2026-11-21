import { randomUUID } from "node:crypto"
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
import { moveToLoopback } from "@/lib/setup/move"

// First run's Start a local container: Postgres started on 127.0.0.1 alone (the owner's choice for this one step, on a random host port bound to loopback only), proved local as bun run ingest proves it, migrated, and named in .env. Every call is a fixed argv: the image, the postgres login and the checkout's container name are the only values, and nothing comes from a request.

export type RunResult = { code: number; stderr: string; stdout: string }
export type Run = (args: string[]) => Promise<RunResult>

export const DOCKER_DOWN =
  "Docker is not running. Install OrbStack (orbstack.dev) or Docker Desktop, start it, then click Try again."

const MIGRATIONS = join(import.meta.dir, "../../../../../packages/db/drizzle")
const READY_TRIES = 30

export class SetupError extends Error {}

export const runner =
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

// Pure: argv that starts first run's Postgres, published on 127.0.0.1 alone (docker maps a random host port to the container's 5432), on postgres:alpine with the postgres login and a password this run chose.
export const startArgv = (name: string, password: string): string[] => [
  "run",
  "--name",
  name,
  "-d",
  "-p",
  "127.0.0.1::5432",
  "-e",
  "POSTGRES_USER=postgres",
  "-e",
  `POSTGRES_PASSWORD=${password}`,
  "-e",
  "POSTGRES_DB=postgres",
  "postgres:alpine",
]

// Pure: a password strong enough for a container no one reaches past loopback, never reused across runs.
const randomPassword = (): string => randomUUID().replaceAll("-", "")

// Pure: 4 random letters or digits, the suffix setup adds to the checkout's name.
const randomSuffix = (): string => {
  const charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let out = ""
  for (let i = 0; i < 4; i++) out += charset[Math.floor(Math.random() * charset.length)]
  return out
}

// Pure: a container named <base>-<4 letters or digits>, the child setup expects to find running this run, or to start.
export const isNamedContainer = (base: string, container: string): boolean =>
  container.startsWith(`${base}-`) && /^[0-9a-zA-Z]{4}$/.test(container.slice(base.length + 1))

// Pure: the host port `docker port <name>` prints as `5432/tcp -> 127.0.0.1:<port>`, or null when it prints none.
export const portFromPort = (stdout: string): number | null => {
  const match = /5432\/tcp -> [\w.:@-]+:(\d+)\s*/.exec(stdout)
  return match ? Number(match[1]) : null
}

// Pure: the URL first run's container publishes, on localhost with the postgres login and this run's password.
export const urlFor = (port: number, password: string): string =>
  `postgres://postgres:${password}@localhost:${port}/postgres`

// Pure: the password a reused container was started with, read from `docker inspect`'s Config.Env, or empty when it started without one.
const passwordOf = (inspectStdout: string): string => {
  try {
    const env = JSON.parse(inspectStdout)?.[0]?.Config?.Env as string[]
    const line = env?.find((value) => value.startsWith("POSTGRES_PASSWORD="))
    return line ? line.slice("POSTGRES_PASSWORD=".length) : ""
  } catch {
    return ""
  }
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
  docker?: Run
  envFile: string
  migrate?: (url: string) => Promise<void>
  move?: boolean
  moveTo?: typeof moveToLoopback
  name: string
  onStep: (step: string) => void
  prove?: (url: string) => Promise<string>
  wait?: (ms: number) => Promise<void>
}

// Starts Postgres and returns its URL, saved in envFile; a failure throws, and leaves the container running so Try again reuses it.
export async function startLocal({
  branch = null,
  docker = runner("docker"),
  envFile,
  migrate: migrateTo = migrate,
  move = false,
  moveTo = moveToLoopback,
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
  const running = containersOf((await docker(CONTAINER_LIST)).stdout).find(
    (c) => c.state === "running" && isNamedContainer(name, c.name),
  )?.name
  const container = running ?? `${name}-${randomSuffix()}`
  let password = ""
  if (!running) {
    password = randomPassword()
    const started = await docker(startArgv(container, password))
    if (started.code !== 0) {
      throw new SetupError(
        `docker run ${container} failed: ${started.stderr.trim() || `exit ${started.code}`}`,
      )
    }
  } else {
    // The reused container's password is read from Config.Env, which the URL must match, or the import would reach the wrong Postgres.
    password = passwordOf((await docker(["inspect", container])).stdout)
  }
  const port = portFromPort((await docker(["port", container])).stdout)
  if (port === null) {
    throw new SetupError(`docker reported no port for ${container}`)
  }
  // the click that answers the guard's exposed refusal moves the reused container onto 127.0.0.1 alone, on the same port and with its data
  if (move && running) {
    onStep("Moving Postgres onto this Mac alone")
    for (const line of await moveTo(container, port, docker, wait)) onStep(line)
  }
  const url = urlFor(port, password)
  // setup's container has no restart policy, so the live dashboard's would stay stopped after a reboot
  if (isLiveDatabase(container, live)) {
    onStep("Keeping Postgres running after a restart")
    const kept = await docker(["update", "--restart", "unless-stopped", container])
    if (kept.code !== 0) {
      throw new SetupError(
        `docker update --restart unless-stopped ${container} failed: ${kept.stderr.trim() || `exit ${kept.code}`}`,
      )
    }
  }
  onStep("Waiting for Postgres")
  let ready = false
  for (let tries = 0; tries < READY_TRIES && !ready; tries++) {
    if (tries > 0) await wait(1_000)
    ready = (await docker(["exec", container, "pg_isready", "-U", "postgres"])).code === 0
  }
  if (!ready) {
    throw new SetupError(`Postgres in ${container} did not start in ${READY_TRIES} seconds`)
  }
  onStep("Checking the database is on this Mac")
  await prove(url)
  onStep("Creating the tables")
  await migrateTo(url)
  onStep("Saving the database address")
  saveEnv(envFile, before, url)
  return url
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
