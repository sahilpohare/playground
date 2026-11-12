#!/usr/bin/env -S bun --no-env-file
// playground doctor: one line per need, as check.sh lays them out: ok, MISSING with its fix, or optional. Imports no workspace package (the store's reader imports only node: modules), so install.sh runs `doctor.ts --tools` before `bun install`.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  FALLBACK_PORT,
  portlessDir,
  proxyDown,
  serviceDir,
} from "../../../../api/hono/src/lib/dev/proxy"
import { readPolicyFile } from "../../../settings/src/rendered"
import { assetOf, herdrPath, PIN_SOURCE, pinnedSum } from "../ops-herdr/pin"
import { checkHerdr } from "./herdr-pin"
import { type Link, linksInto } from "./links"

export type Check = { detail: string; name: string; status: "MISSING" | "ok" | "optional" }

// The oldest Node the Dashboard's Next.js runs on, its engines field.
const NODE_MIN = [20, 9] as const

// Whether a `node --version` line is at NODE_MIN or newer.
const nodeAtLeast = (version: string): boolean => {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number)
  return major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1])
}

// What playground runs on: [command, required, fix, what for].
const TOOLS: [string, boolean, string, string][] = [
  ["bun", true, "curl -fsSL https://bun.sh/install | bash", "runs playground"],
  ["claude", true, "install Claude Code: https://claude.com/claude-code", "every session"],
  [
    "claude-codex",
    false,
    "curl -fsSL https://raw.githubusercontent.com/fcakyon/claude-code-with-codex/main/scripts/install.sh | bash",
    "routes Claude Code to a Codex (ChatGPT) subscription too",
  ],
  ["docker", false, "install Docker Desktop", "a database in a container; PGlite needs none"],
  ["gh", true, "brew install gh", "clones, PRs and ext sync"],
  ["git", true, "brew install git", "the checkout"],
  ["node", true, `brew install node (${NODE_MIN.join(".")} or newer)`, "the Dashboard's next dev"],
  ["python3", true, "brew install python", "the ops jobs"],
  ["uv", false, "brew install uv", "the skills' tests"],
]

const check = (name: string, required: boolean, ok: boolean, fix: string, why: string): Check =>
  ok
    ? { detail: why, name, status: "ok" }
    : required
      ? { detail: `fix: ${fix} (${why})`, name, status: "MISSING" }
      : { detail: `missing; fix: ${fix} (${why})`, name, status: "optional" }

export const toolChecks = (
  has: (cmd: string) => boolean,
  ghLogin: () => boolean,
  nodeVersion: () => string | null = () => null,
): Check[] => {
  const checks = TOOLS.map(([cmd, required, fix, why]) => {
    const version = cmd === "node" && has(cmd) ? nodeVersion() : null
    return check(cmd, required, has(cmd) && (version === null || nodeAtLeast(version)), fix, why)
  })
  if (has("gh"))
    checks.push(
      ghLogin()
        ? check("gh login", false, true, "", "ext sync and private clones")
        : {
            detail: "sync is off; fix: gh auth login, then playground ext init",
            name: "gh login",
            status: "optional",
          },
    )
  return checks
}

// The release this checkout is at, from its tag and how far origin/main, as last fetched, is ahead: held at a tag behind main after playground update --to, else at its tag or sha.
export const versionCheck = (at: string, tag: string | null, behind: number): Check =>
  check(
    "version",
    true,
    true,
    "",
    behind === 0
      ? `at ${at}`
      : `${tag ? `held at ${tag}` : `at ${at}`}, ${behind} commit${behind === 1 ? "" : "s"} behind origin/main: playground update moves it on`,
  )

const gitOut = (repo: string, ...args: string[]): string | null => {
  const run = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "ignore" })
  return run.exitCode === 0 ? run.stdout.toString().trim() : null
}

export const linkChecks = (links: Link[], repo: string, exists: (path: string) => boolean) => {
  if (links.length === 0)
    return [check("links", true, false, "run scripts/link-skills.sh", `none into ${repo}`)]
  const gone = links.filter(({ target }) => !exists(target))
  if (gone.length === 0) return [check("links", true, true, "", `${links.length} into ${repo}`)]
  return gone.map(({ path, target }): Check => ({
    detail: `fix: ${target} is gone; run scripts/link-skills.sh, which removes the link`,
    name: `link ${path}`,
    status: "MISSING",
  }))
}

// Playground's own pinned herdr, which every session runs in: ok while its path holds the pinned sum; a herdr of the human's own on PATH is named and never run.
export const herdrCheck = (path: string, want: string, version: string, own: string | null) =>
  checkHerdr(path, want).code === 0
    ? check(
        "herdr",
        true,
        true,
        "",
        `${version} pinned at ${path}${own && own !== path ? `; your own herdr at ${own} is left alone` : ""}`,
      )
    : check(
        "herdr",
        true,
        false,
        "playground herdr pin",
        existsSync(path) ? `${path} is not the pinned ${version}` : `${path} is missing`,
      )

// portless's proxy, which serves the Dashboard's https://playground.localhost: ok by the stack's own rule, proxyDown, and optional while it is down, since `bun run dev` then starts it on FALLBACK_PORT with no password; Settings' Things to fix or install.sh sets it up with the Mac's password.
export const proxyCheck = (repo: string, down: number | null): Check =>
  check(
    "portless proxy",
    false,
    down === null,
    `the Dashboard runs on port ${FALLBACK_PORT} meanwhile; click Set up the web address in Settings' Things to fix, or run bash ${repo}/install.sh again in a terminal, which asks for your Mac's password once`,
    "the Dashboard's https://playground.localhost",
  )

// Each job jobs.json turns on that launchd runs, checked loaded; a job ops-tick runs has no label to check.
// The data folder this machine reads, named so a fresh install shows which one is in use; link-skills.sh makes it.
export const dataCheck = (data: string, exists: (path: string) => boolean): Check =>
  check("data folder", true, exists(data), `run scripts/link-skills.sh, which makes ${data}`, data)

export const jobChecks = (jobsText: string | null, loaded: (label: string) => boolean) => {
  let jobs: { disabled?: boolean; launchd?: string; name?: string }[] = []
  try {
    const parsed = JSON.parse(jobsText ?? "").jobs
    if (Array.isArray(parsed)) jobs = parsed
  } catch {}
  const on = jobs.filter((job) => job.disabled !== true && job.launchd && job.name)
  if (on.length === 0) return [check("jobs", true, true, "", "every ops job is off")]
  return on.map(({ launchd, name }) =>
    check(
      `job ${name}`,
      true,
      loaded(launchd!),
      `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${launchd}.plist`,
      `${launchd} loaded`,
    ),
  )
}

// Pure: the job registry's values in the store's policy.json as jobs.json's shape, so jobChecks reads them: a job no value turns on is off, as a fresh install has every job.
export const registryJobsText = (policyText: string): string => {
  let values: Record<string, unknown> = {}
  try {
    values = JSON.parse(policyText).values ?? {}
  } catch {}
  const jobs = Object.entries(values)
    .filter(([key]) => key.startsWith("jobs."))
    .map(([key, value]) => {
      const job = (value ?? {}) as { enabled?: unknown; launchd?: unknown }
      return {
        disabled: job.enabled !== true,
        launchd: job.launchd,
        name: key.slice("jobs.".length).replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`),
      }
    })
  return JSON.stringify({ jobs })
}

export const line = ({ detail, name, status }: Check): string =>
  `${status.padEnd(8)} ${name.padEnd(22)} ${detail}`

export const missing = (checks: Check[]): boolean => checks.some((c) => c.status === "MISSING")

const exitsZero = (argv: string[]): boolean =>
  Bun.spawnSync(argv, { stderr: "ignore", stdout: "ignore" }).exitCode === 0

const tools = (): Check[] =>
  toolChecks(
    (cmd) => Bun.which(cmd) !== null,
    () => exitsZero(["gh", "auth", "status", "--active", "-h", "github.com"]),
    () =>
      Bun.spawnSync(["node", "--version"], { stderr: "ignore" }).stdout.toString().trim() || null,
  )

// The jobs launchd should hold, from the job registry on a machine whose extensions hold policy.json, else from jobs.json.
export const launchdChecks = async (
  data: string,
  loaded: (label: string) => boolean,
): Promise<Check[]> => {
  const read = readPolicyFile(data)
  if (read.path) return jobChecks(registryJobsText(readFileSync(read.path, "utf8")), loaded)
  const jobs = join(data, "ops", "jobs.json")
  return jobChecks(existsSync(jobs) ? readFileSync(jobs, "utf8") : null, loaded)
}

// The whole doctor: the tools, the data folder, the pinned herdr, the links into the checkout, the release it is at, and on macOS portless's proxy service and the jobs launchd should hold.
export const doctor = async (repo: string, home: string, data: string): Promise<Check[]> => [
  ...tools(),
  dataCheck(data, existsSync),
  herdrCheck(herdrPath(), pinnedSum(assetOf() ?? ""), PIN_SOURCE.version, Bun.which("herdr")),
  ...linkChecks(linksInto(repo, home, data), repo, existsSync),
  versionCheck(
    gitOut(repo, "describe", "--tags", "--always") ?? "an unknown commit",
    gitOut(repo, "describe", "--tags", "--exact-match"),
    Number(gitOut(repo, "rev-list", "--count", "HEAD..origin/main") ?? 0),
  ),
  ...(process.platform === "darwin"
    ? [
        proxyCheck(repo, await proxyDown(process.env, serviceDir(portlessDir()))),
        ...(await launchdChecks(data, (label) =>
          exitsZero(["launchctl", "print", `gui/${process.getuid!()}/${label}`]),
        )),
      ]
    : []),
]

export const report = (checks: Check[]): number => {
  for (const c of checks) console.log(line(c))
  return missing(checks) ? 1 : 0
}

// doctor.ts --tools prints the tool lines; with --json, the same checks as one JSON list, the list install.sh installs from.
if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2)
  const json = rest.length === 1 && rest[0] === "--json"
  if (first !== "--tools" || (rest.length > 0 && !json)) {
    console.error(
      "doctor.ts: run playground doctor, or doctor.ts --tools [--json] for the tools alone",
    )
    process.exit(2)
  }
  const checks = tools()
  if (!json) process.exit(report(checks))
  console.log(JSON.stringify(checks))
  process.exit(missing(checks) ? 1 : 0)
}
