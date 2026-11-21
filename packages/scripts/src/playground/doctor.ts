#!/usr/bin/env -S bun --no-env-file
// playground doctor: one line per need, as check.sh lays them out: ok, MISSING with its fix, or optional. Imports no workspace package (the store's reader imports only node: modules), so install.sh runs `doctor.ts --tools` before `bun install`.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { type CaTrust, chromiumSteps, readCaTrust } from "../../../../api/hono/src/lib/dev/ca-trust"
import {
  FALLBACK_PORT,
  portlessDir,
  proxyDown,
  serviceDir,
} from "../../../../api/hono/src/lib/dev/proxy"
import { readPolicyFile } from "../../../settings/src/rendered"
import { assetOf, herdrPath, PIN_SOURCE, pinnedSum } from "../ops-herdr/pin"
import { userSystemctl } from "../user-systemctl"
import { probe } from "./ca-trust"
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

// A tool's fix: one for every OS, or a Mac's and Linux's.
type Fix = string | { darwin: string; linux: string }

// What playground runs on: [command, required, fix, what for].
const TOOLS: [string, boolean, Fix, string][] = [
  ["bun", true, "curl -fsSL https://bun.sh/install | bash", "runs playground"],
  ["claude", true, "install Claude Code: https://claude.com/claude-code", "every session"],
  [
    "claude-codex",
    false,
    "curl -fsSL https://raw.githubusercontent.com/fcakyon/claude-code-with-codex/main/scripts/install.sh | bash",
    "routes Claude Code to a Codex (ChatGPT) subscription too",
  ],
  [
    "docker",
    false,
    {
      darwin: "install Docker Desktop",
      linux: "install Docker Engine: https://docs.docker.com/engine/install/",
    },
    "a database in a container; PGlite needs none",
  ],
  [
    "gh",
    true,
    {
      darwin: "brew install gh",
      linux: "install gh: https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
    },
    "clones, PRs and ext sync",
  ],
  [
    "git",
    true,
    {
      darwin: "brew install git",
      linux: "your distro's git package, such as sudo apt install git",
    },
    "the checkout",
  ],
  [
    "node",
    true,
    {
      darwin: `brew install node (${NODE_MIN.join(".")} or newer)`,
      linux: `install Node from https://nodejs.org/en/download (${NODE_MIN.join(".")} or newer)`,
    },
    "the Dashboard's next dev",
  ],
  [
    "python3",
    true,
    {
      darwin: "brew install python",
      linux: "your distro's python3 package, such as sudo apt install python3",
    },
    "the ops jobs",
  ],
  [
    "uv",
    false,
    { darwin: "brew install uv", linux: "curl -LsSf https://astral.sh/uv/install.sh | sh" },
    "the skills' tests",
  ],
  [
    "whisper-cli",
    false,
    {
      darwin: "brew install whisper-cpp ffmpeg, and a model at <data>/wa/whisper-model.bin",
      linux:
        "build whisper.cpp from https://github.com/ggml-org/whisper.cpp, your distro's ffmpeg package, and a model at <data>/wa/whisper-model.bin",
    },
    "WhatsApp voice notes and videos as text",
  ],
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
  platform: NodeJS.Platform = process.platform,
): Check[] => {
  const checks = TOOLS.map(([cmd, required, fix, why]) => {
    const version = cmd === "node" && has(cmd) ? nodeVersion() : null
    const fixHere = typeof fix === "string" ? fix : platform === "linux" ? fix.linux : fix.darwin
    return check(
      cmd,
      required,
      has(cmd) && (version === null || nodeAtLeast(version)),
      fixHere,
      why,
    )
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

// The test browser on Linux arm64, where Chrome for Testing has no build: Playwright's pinned Chromium, named in agent-browser's own user config (`agent-browser --help`: "~/.agent-browser/config.json  User-level defaults"), which every agent-browser call reads first; `--no-sandbox` since AppArmor blocks Chromium's sandbox.
export const AGENT_BROWSER_PIN = "0.43.0"
export const PLAYWRIGHT_PIN = "1.65.1"
export const linuxChromium = (home: string): string =>
  join(home, ".cache", "ms-playwright", "chromium-1255", "chrome-linux-arm64", "chrome")
export const agentBrowserConfig = (home: string): string =>
  join(home, ".agent-browser", "config.json")

// ok while agent-browser is on PATH, the pinned Chromium is installed whole and runs, and agent-browser's config launches it without the sandbox; else MISSING with each step still to do.
export const browserCheck = (
  home: string,
  has: (cmd: string) => boolean,
  runs: (argv: string[]) => boolean,
): Check => {
  const chrome = linuxChromium(home)
  const config = agentBrowserConfig(home)
  let read: { args?: unknown; executablePath?: unknown } = {}
  try {
    read = JSON.parse(readFileSync(config, "utf8"))
  } catch {
    // no config, or one that does not parse, launches agent-browser's own Chrome
  }
  const fixes = [
    !has("agent-browser") && `bun add -g agent-browser@${AGENT_BROWSER_PIN}`,
    !(
      existsSync(join(chrome, "..", "..", "INSTALLATION_COMPLETE")) && runs([chrome, "--version"])
    ) && `npx -y playwright@${PLAYWRIGHT_PIN} install chromium`,
    !(
      read.executablePath === chrome &&
      typeof read.args === "string" &&
      read.args.split(/[\n,]/).includes("--no-sandbox")
    ) && `write ${config} as {"executablePath": "${chrome}", "args": "--no-sandbox"}`,
  ].filter((fix): fix is string => typeof fix === "string")
  return check(
    "test browser",
    true,
    fixes.length === 0,
    fixes.join(", then "),
    `agent-browser ${AGENT_BROWSER_PIN} on Playwright ${PLAYWRIGHT_PIN}'s Chromium, from ${config}`,
  )
}

// On Linux, the browsers' trust of portless's CA, as first run's Certificate row reads it (ca-trust.ts) save one case: MISSING with its steps while a Firefox profile does not trust it, certutil missing included, which first run reads as optional so it can finish, and optional naming a Chromium-family browser's own import, which no file shows, unless the chromium-ca policy covers it.
export const certificateCheck = (read: CaTrust, ca: string, repo: string): Check => {
  const name = "browser certificate"
  const chromium = read.chromium.length > 0 ? chromiumSteps(read.chromium, ca) : ""
  if (read.untrusted.length > 0)
    return check(
      name,
      true,
      false,
      `${read.certutil ? "" : "install your distro's NSS tools (libnss3-tools on Debian and Ubuntu, nss-tools on Fedora), then "}run bun ${repo}/packages/scripts/src/playground/ca-trust.ts or click Trust it in Firefox in Settings' Things to fix, then restart Firefox${chromium ? `. ${chromium}` : ""}`,
      `Firefox profiles that do not trust ${ca}: ${read.untrusted.join(", ")}`,
    )
  if (chromium) return { detail: `check by hand: ${chromium}`, name, status: "optional" }
  return check(
    name,
    true,
    true,
    "",
    [
      read.firefox.length > 0 && `Firefox trusts ${ca}`,
      read.policy.length > 0 && `${read.policy.join(", ")} trusts ${ca} through the browser policy`,
    ]
      .filter(Boolean)
      .join("; ") || "no browser found",
  )
}

// The certificate line while portless's proxy has made its CA, none before.
const certificateOf = async (home: string, repo: string): Promise<Check[]> => {
  const ca = join(portlessDir(), "ca.pem")
  return existsSync(ca) ? [certificateCheck(await readCaTrust(ca, home, probe), ca, repo)] : []
}

// portless's proxy, which serves the Dashboard's https://playground.localhost: ok by the stack's own rule, proxyDown, and optional while it is down, since `bun run dev` then starts it on FALLBACK_PORT with no password; Settings' Things to fix or install.sh sets it up with the Mac's password.
export const proxyCheck = (repo: string, down: number | null): Check =>
  check(
    "portless proxy",
    false,
    down === null,
    `the Dashboard runs on port ${FALLBACK_PORT} meanwhile; click Set up the web address in Settings' Things to fix, or run bash ${repo}/install.sh again in a terminal, which asks for your Mac's password once`,
    "the Dashboard's https://playground.localhost",
  )

// Each job jobs.json turns on that launchd runs, checked loaded, or on Linux its systemd user unit, checked active; a job ops-tick runs has no label to check.
// The data folder this machine reads, named so a fresh install shows which one is in use; link-skills.sh makes it.
export const dataCheck = (data: string, exists: (path: string) => boolean): Check =>
  check("data folder", true, exists(data), `run scripts/link-skills.sh, which makes ${data}`, data)

export const jobChecks = (
  jobsText: string | null,
  loaded: (label: string) => boolean,
  platform: NodeJS.Platform = process.platform,
) => {
  const linux = platform === "linux"
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
      linux
        ? `systemctl --user enable --now ${launchd}.service`
        : `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${launchd}.plist`,
      linux ? `${launchd}.service active` : `${launchd} loaded`,
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

// The tunnel job's line (ops-tunnel), when jobs.json turns it on: ok while its heartbeat is fresh and reads up, else MISSING with the why it beats, such as a key the far machine refused or a port this Mac already holds.
export const tunnelChecks = (
  jobsText: string | null,
  beatText: string | null,
  now: Date,
): Check[] => {
  let on = false
  try {
    const jobs = JSON.parse(jobsText ?? "").jobs as { disabled?: boolean; name?: string }[]
    on = jobs.some((job) => job.name === "ops-tunnel" && job.disabled !== true)
  } catch {}
  if (!on) return []
  let beat: { cycleSeconds?: number; lastBeatAt?: string; lastResult?: string } = {}
  try {
    beat = JSON.parse(beatText ?? "")
  } catch {}
  const age = Math.floor((now.getTime() - Date.parse(beat.lastBeatAt ?? "")) / 60_000)
  const result = beat.lastResult ?? ""
  const detail = !beat.lastBeatAt
    ? "the ops-tunnel job has not started: the ops runner starts it on its next pass"
    : age * 60 > 3 * (beat.cycleSeconds ?? 60)
      ? `its heartbeat is ${age}m old, so the ops-tunnel job is not running: ${result}`
      : result.includes("exited")
        ? `the ops-tunnel job is not running: ${result}`
        : result
  return [{ detail, name: "tunnel", status: detail.startsWith("up: ") ? "ok" : "MISSING" }]
}

// The tunnel's line from the data folder's jobs.json and the job's heartbeat.
const tunnelOfData = (data: string): Check[] => {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null)
  return tunnelChecks(
    read(join(data, "ops", "jobs.json")),
    read(join(data, "ops", "ops-tunnel.json")),
    new Date(),
  )
}

export const line = ({ detail, name, status }: Check): string =>
  `${status.padEnd(8)} ${name.padEnd(22)} ${detail}`

export const missing = (checks: Check[]): boolean => checks.some((c) => c.status === "MISSING")

// A program that is not there reads as a nonzero exit, so a machine with no systemctl gets its MISSING line, not a crash.
const exitsZero = (argv: string[]): boolean => {
  try {
    return Bun.spawnSync(argv, { stderr: "ignore", stdout: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}

// Whether a launchd job runs: launchd holds its label on macOS, and on Linux systemd runs its user unit of the same name.
export const jobLoaded =
  (platform: NodeJS.Platform) =>
  (label: string): boolean =>
    platform === "linux"
      ? exitsZero(userSystemctl(["is-active", "--quiet", `${label}.service`]))
      : exitsZero(["launchctl", "print", `gui/${process.getuid!()}/${label}`])

const tools = (): Check[] =>
  toolChecks(
    (cmd) => Bun.which(cmd) !== null,
    () => exitsZero(["gh", "auth", "status", "--active", "-h", "github.com"]),
    () =>
      Bun.spawnSync(["node", "--version"], { stderr: "ignore" }).stdout.toString().trim() || null,
    // install.sh's INSTALL_OS stand-in under the test sandbox, so its list names the fixes of the OS it was handed
    ((process.env.TEST_SANDBOX_HOME && process.env.INSTALL_OS?.toLowerCase()) as NodeJS.Platform) ||
      process.platform,
  )

// Pure: on Linux, whether linger is on for the user (loginctl's Linger, "yes", "no" or null when it does not read), which keeps the ops jobs systemd runs going with no one logged in; optional, since they run while the user is logged in and the jobs pass turns it on itself.
export const lingerCheck = (linger: string | null, uid: number): Check =>
  check(
    "linger",
    false,
    linger === "yes",
    `loginctl enable-linger ${uid}`,
    "keeps the ops jobs running with no one logged in",
  )

const readLinger = (uid: number): string | null => {
  try {
    const shown = Bun.spawnSync(
      ["loginctl", "show-user", String(uid), "--property=Linger", "--value"],
      { stderr: "ignore" },
    )
    return shown.exitCode === 0 ? shown.stdout.toString().trim() : null
  } catch {
    return null
  }
}

// The jobs launchd, or on Linux systemd, should hold, from the job registry on a machine whose extensions hold policy.json, else from jobs.json.
export const launchdChecks = async (
  data: string,
  loaded: (label: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<Check[]> => {
  const read = readPolicyFile(data)
  if (read.path)
    return jobChecks(registryJobsText(readFileSync(read.path, "utf8")), loaded, platform)
  const jobs = join(data, "ops", "jobs.json")
  return jobChecks(existsSync(jobs) ? readFileSync(jobs, "utf8") : null, loaded, platform)
}

// The whole doctor: the tools, the data folder, the pinned herdr, the links into the checkout, the release it is at, on macOS portless's proxy service, on Linux arm64 the test browser, on Linux the browsers' trust of portless's CA, the jobs launchd, or on Linux systemd, should hold, on Linux linger, and the tunnel's state while its job is on.
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
    ? [proxyCheck(repo, await proxyDown(process.env, serviceDir(portlessDir())))]
    : []),
  ...(process.platform === "linux" && process.arch === "arm64"
    ? [browserCheck(home, (cmd) => Bun.which(cmd) !== null, exitsZero)]
    : []),
  ...(process.platform === "linux" ? await certificateOf(home, repo) : []),
  ...(process.platform === "darwin" || process.platform === "linux"
    ? await launchdChecks(data, jobLoaded(process.platform))
    : []),
  ...(process.platform === "linux"
    ? [lingerCheck(readLinger(process.getuid!()), process.getuid!())]
    : []),
  ...tunnelOfData(data),
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
