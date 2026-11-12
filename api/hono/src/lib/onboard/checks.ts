import { homedir } from "node:os"
import { join } from "node:path"

import { site } from "@packages/config/site"
import { dataDirOf } from "@packages/env/data-dir"

import { type DashboardSource, currentSource, readFixtureMachine } from "@/lib/dashboard/fixture"
import { FALLBACK_PORT, isFallback, portlessDir, proxyDown, proxyPort } from "@/lib/dev/proxy"
import { type FixId, fixtureFixed } from "@/lib/onboard/fix-ids"
import { machine, type Reader } from "@/lib/onboard/machine"
import type { SetupState } from "@/lib/setup/app"
import { hasLogin } from "@/lib/store/extensions"

// The first run's checks, read by the API for the chat pane and Settings' Things to fix: each row says what is there and what is missing, a missing row names the fix the app runs for it (fix-ids.ts) or says in plain words what happens instead, and no row's words name a command. Every probe is a fixed argv from COMMANDS or a fixed path, each only reports, and nothing comes from a request; a fixture stack runs none and answers its fixture's rows.

export type Check = {
  action: { id: FixId | "settings"; label: string } | null
  detail: string
  name: string
  need: string | null
  note: string | null
  status: "MISSING" | "ok" | "optional" | "waiting"
}

type Tool = "bun" | "claude" | "docker" | "gh" | "git" | "herdr" | "node" | "python3" | "uv"

type Action = NonNullable<Check["action"]>

// [tool, required, what it is needed for, the fix that installs it, the note when it is missing]
const TOOLS: [Tool, boolean, string, Action | null, string][] = [
  ["bun", true, `runs ${site.name}`, null, `Bun is not installed, and ${site.name} runs on it.`],
  [
    "claude",
    true,
    "every session",
    { id: "claude", label: "Install Claude Code" },
    "Claude Code is not installed.",
  ],
  [
    "docker",
    false,
    "a database in a container",
    { id: "docker", label: "Install Docker" },
    "Docker Desktop is not installed. The database starts without it, as PGlite.",
  ],
  [
    "gh",
    true,
    "sync and private repos",
    { id: "gh-login", label: "Install GitHub CLI and sign in" },
    "GitHub CLI is not installed. Without it, your extensions stay on this Mac only.",
  ],
  ["git", true, "the checkout", { id: "git", label: "Install git" }, "git is not installed."],
  [
    "herdr",
    true,
    "the sessions' second terminal",
    { id: "herdr", label: "Install herdr" },
    "herdr is not installed.",
  ],
  [
    "node",
    true,
    "the Dashboard",
    { id: "node", label: "Install Node.js" },
    "Node.js is not installed.",
  ],
  [
    "python3",
    true,
    "the ops jobs",
    { id: "python", label: "Install Python" },
    "Python 3 is not installed.",
  ],
  ["uv", false, "the skills' tests", null, "uv is not installed. Only the skills' tests need it."],
]

export const COMMANDS = {
  caTrusted: (ca: string) => ["security", "verify-cert", "-c", ca, "-L", "-p", "ssl"],
  dockerInfo: () => ["docker", "info", "--format", "{{.ServerVersion}}"],
  ghLogin: () => ["gh", "auth", "status", "--active", "-h", "github.com"],
  version: (tool: string) => [tool, "--version"],
} as const

// Where Homebrew puts brew on Apple silicon and on Intel, read when the API's PATH holds neither.
const BREW_AT = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]

// What happens instead of a button for the two steps that need the Mac's password, which the app never asks for.
const INSTALLER_NOTE = `${site.name}'s installer sets this up, and asks for your Mac's password while it does.`

export type { Reader }

type Env = Record<string, string | undefined>

// The oldest Node the Dashboard's Next.js runs on, its engines field.
const NODE_MIN = [20, 9] as const

const versionOf = (stdout: string): string | null => /\d+\.\d+(?:\.\d+)?/.exec(stdout)?.[0] ?? null

const tooOld = (version: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major < NODE_MIN[0] || (major === NODE_MIN[0] && minor < NODE_MIN[1])
}

const okRow = (name: string, need: string | null, detail: string): Check => ({
  action: null,
  detail,
  name,
  need,
  note: null,
  status: "ok",
})

// Playground's own herdr, which install pins at the data folder's bin/herdr, off PATH; ops-herdr's pin.json names this same path (pinFor).
const pinnedHerdr = (env: Env): string => join(dataDirOf({}, env.HOME || homedir()), "bin", "herdr")

const toolCheck = async (
  [tool, required, need, install, note]: (typeof TOOLS)[number],
  reader: Reader,
  env: Env,
): Promise<Check> => {
  const missing = (detail: string, action: Action | null, why: string): Check => ({
    action,
    detail,
    name: tool,
    need,
    note: why,
    status: required ? "MISSING" : "optional",
  })
  // herdr's row reads the pinned copy first, which is the one every session runs, then PATH
  const bin = tool === "herdr" && reader.exists(pinnedHerdr(env)) ? pinnedHerdr(env) : tool
  if (bin === tool && !reader.has(tool)) return missing("not found", install, note)
  const ok = (detail: string) => okRow(tool, need, detail)
  if (tool === "docker") {
    const info = await reader.run([...COMMANDS.dockerInfo()])
    if (info.code !== 0) {
      return missing(
        "not running",
        { id: "docker", label: "Start Docker" },
        "Docker is installed but not running. The database starts without it, as PGlite.",
      )
    }
    return ok(versionOf(info.stdout) ?? "running")
  }
  const version = versionOf((await reader.run([...COMMANDS.version(bin)])).stdout)
  if (tool === "node" && version && tooOld(version)) {
    return missing(
      `${version}, needs ${NODE_MIN.join(".")} or newer`,
      { id: "node", label: "Update Node.js" },
      `Node.js ${version} is too old for the Dashboard.`,
    )
  }
  if (tool === "gh" && (await reader.run([...COMMANDS.ghLogin()])).code !== 0) {
    return missing(
      "not signed in",
      { id: "gh-login", label: "Sign in to GitHub" },
      "GitHub CLI is not signed in. Without it, your extensions stay on this Mac only.",
    )
  }
  return ok(version ?? "installed")
}

// Homebrew installs the other tools; the app never runs its installer, which asks for the Mac's password.
const homebrewCheck = (reader: Reader): Check => {
  const need = "installs the other tools"
  if (reader.has("brew") || BREW_AT.some((path) => reader.exists(path)))
    return okRow("Homebrew", need, "installed")
  return {
    action: null,
    detail: "not found",
    name: "Homebrew",
    need,
    note: `Homebrew is not on this Mac. ${INSTALLER_NOTE}`,
    status: "optional",
  }
}

// portless: its proxy runs by the dev launcher's own rule (proxyDown), on 443 or, while that is down, on 1355, which needs no password; the app sets up 443 (the proxy fix, which trusts the CA too) and trusts the CA (the trust fix) on the owner's click, any password going to macOS's own window, and reports a stopped proxy, which no running stack can show.
const portlessCheck = async (reader: Reader, env: Env): Promise<Check> => {
  const need = "the Dashboard's https address"
  const row = (detail: string, note: string, action: Action | null = null): Check => ({
    action,
    detail,
    name: "portless",
    need,
    note,
    status: "optional",
  })
  if (env.PORTLESS === "0") return okRow("portless", need, "not needed")
  const dir = portlessDir(env)
  if (await proxyDown(env, dir, reader.listens))
    return row("not running", `The local web proxy is not running. ${INSTALLER_NOTE}`)
  if (isFallback(dir) && (await proxyPort(env, dir)) === FALLBACK_PORT)
    return (await reader.listens(443))
      ? row(
          "set up",
          "The web address is set up. The Dashboard moves to it the next time it starts.",
        )
      : row(
          "not on 443",
          `The Dashboard's web address runs on port ${FALLBACK_PORT} for now. Set it up here, and it drops the port number; your Mac asks for your password in its own window.`,
          { id: "proxy", label: "Set up the web address" },
        )
  const ca = join(dir, "ca.pem")
  if (!reader.exists(ca) || (await reader.run([...COMMANDS.caTrusted(ca)])).code !== 0)
    return row(
      "not trusted",
      "Your Mac does not trust the local web proxy's certificate yet. Trust it here; your Mac may ask for your password in its own window.",
      { id: "trust", label: "Trust the certificate" },
    )
  return okRow("portless", need, "ready")
}

// Settings: a login named by Set up settings, whose step comes after these checks, so its row never holds them back.
const settingsCheck = (login: () => boolean): Check =>
  login()
    ? okRow("Settings", "your settings on GitHub", "set up")
    : {
        action: { id: "settings", label: "Set up settings" },
        detail: "not set up",
        name: "Settings",
        need: "your settings on GitHub",
        note: "Your settings have no private GitHub repository yet. The Settings step sets one up.",
        status: "optional",
      }

// The database: running whenever the normal app answers; before that, setup mode's state, started in a Docker container when docker runs and as PGlite, with no Docker, when it does not.
const databaseCheck = (database: "ok" | SetupState, docker: Check | undefined): Check => {
  const need = "the Dashboard's data"
  const row = (
    status: Check["status"],
    detail: string,
    note: string,
    action: Action | null = null,
  ): Check => ({ action, detail, name: "Database", need, note, status })
  if (database === "ok") return okRow("Database", need, "local Postgres is running")
  if (database.status === "starting") return row("waiting", database.step, "Starting it now.")
  const start =
    docker?.status === "ok"
      ? ({ id: "database", label: "Start the database" } as const)
      : ({ id: "pglite", label: "Start without Docker" } as const)
  return database.status === "failed"
    ? row("MISSING", database.reason, "Starting the database did not finish.", start)
    : row("MISSING", "not started", `${site.name} keeps its data in a database on this Mac.`, start)
}

// A made-up fix marks its id in fixtureFixed, so the fixture's row it fixes reads ok from then on.
const fixtureRows = (env: Env): Check[] => {
  const doctor = readFixtureMachine().doctor
  if (!doctor) throw new Error("the fixture holds no doctor block")
  const rows = /^(1|true)$/i.test(env.PLAYGROUND_ONBOARD_MISSING?.trim() ?? "")
    ? doctor.missing
    : doctor.checks
  return rows.map((row) =>
    row.action && fixtureFixed.has(row.action.id as FixId)
      ? { ...row, action: null, detail: "installed", note: null, status: "ok" }
      : row,
  )
}

type Read = {
  database: "ok" | SetupState
  env?: Env
  login?: () => boolean
  reader?: Reader
  source?: DashboardSource
}

// Every row in order: the machine's tools with Homebrew and portless among them (or a fixture's made-up ones, PLAYGROUND_ONBOARD_MISSING picking its missing set, read on a fixture stack alone), the database after docker, and Settings last.
export async function onboardChecks({
  database,
  env = process.env,
  login = () => hasLogin(),
  reader = machine,
  source = currentSource(),
}: Read): Promise<Check[]> {
  const rows =
    source.kind === "live"
      ? await Promise.all([
          ...TOOLS.map((tool) => toolCheck(tool, reader, env)),
          homebrewCheck(reader),
          portlessCheck(reader, env),
          settingsCheck(login),
        ])
      : fixtureRows(env)
  const byName = (a: Check, b: Check) =>
    a.name === "Settings" ? 1 : b.name === "Settings" ? -1 : a.name.localeCompare(b.name)
  const sorted = source.kind === "live" ? rows.toSorted(byName) : rows
  const at = sorted.findIndex((check) => check.name === "docker") + 1
  return [...sorted.slice(0, at), databaseCheck(database, sorted[at - 1]), ...sorted.slice(at)]
}

// The done mark in the database (done-mark.ts), absent while there is none.
export type DoneMark = { read: () => Promise<boolean>; write: () => Promise<void> }

// The first run's answer: the rows and whether they are done. Once the mark is written no probe runs again; it is written here, the first time the database runs and every row is ok or optional. A live read (Settings' Things to fix) runs every probe whatever the mark says and never writes it, and a mark that cannot be read counts as not done.
export async function firstRunChecks({
  live = false,
  mark,
  ...read
}: Read & { live?: boolean; mark: DoneMark | null }): Promise<{ checks: Check[]; done: boolean }> {
  const marked =
    read.database === "ok" && mark ? await mark.read().catch(() => null) : (false as const)
  if (marked && !live) return { checks: [], done: true }
  const checks = await onboardChecks(read)
  const passed = checks.every((check) => check.status === "ok" || check.status === "optional")
  if (live || marked === null || !mark || read.database !== "ok" || !passed)
    return { checks, done: marked === true }
  await mark.write()
  return { checks, done: true }
}
