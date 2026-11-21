#!/usr/bin/env bun
// The new-user gate: a fresh scratch HOME installs Playground at a given sha the way `curl | bash` does, then each step a new user meets is checked in turn, printed PASS, FAIL or INCONCLUSIVE and screenshotted; it exits 1 when any step does not pass.
// Usage: bun run gate:new-user <tag|sha> [--box <parent dir>] [--keep] [--pr <n>], or --clean <box> for a box a --keep run left; --pr posts the run's verdict on PR n, which pr-merge's new-user gate reads. The box (makeBox's /tmp/pg-gate-<sha7>-<random> unless --box names its folder, short since herdr's socket path must fit 104 bytes) holds the HOME, the stand-ins, a bare source repo and the screenshots.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { makeScratch, removeScratch } from "@packages/safe-delete"
import { gateSettings, SCHEMA_VERSION } from "@packages/settings"

import { networkChangedWait } from "../agent-browser-retry"
import { boxEnv } from "../box-env"
import { procSource, type SysctlName, sysctlOf } from "../ops-machine/readings"
import { gateLine } from "../pr-merge/ship-lines"
import { BOX_LABEL } from "./docker"
import { stubs, usageReading } from "./stubs"

const REPO = resolve(import.meta.dir, "../../../..")
const PROXY_PORT = "14155"
const PORTLESS = join(REPO, "node_modules", ".bin", "portless")
const INSTALL_LIMIT_S = 1200
const ROUTE_WAIT_MS = 180_000
const SCRIPTS_WAIT_MS = 150_000
const USAGE_WAIT_MS = 60_000
const ROOM_WAIT_MS = 600_000
// The box's PLAYGROUND_LOAD_MULT: the gate checks what a new user meets on a quiet Mac, so spawn.sh's load gate in the box allows this many times the cores and the host's other sessions never hold a start; its memory and usage gates stay as they are.
export const BOX_LOAD_MULT = 10

// A step is inconclusive when it failed while spawn.sh's capacity gate refused a start, since that gate reads this Mac, not the build.
export type Step = {
  detail: string
  inconclusive?: boolean
  name: string
  ok: boolean
  shot?: string
}

// The steps main checks, in order, so a run that stopped short of its last one is no pass.
export const STEP_COUNT = 7

// Pure: the gate's last line, which ship:merge reads in the ship PR's body: PASS only for a run that reached every step with none reading FAIL.
export const resultLine = (sha: string, steps: Step[]): string =>
  gateLine(sha, steps.length < STEP_COUNT || steps.some((s) => !s.ok && !s.inconclusive))

// Pure: the verdict --pr posts on a PR, which pr-merge's new-user gate reads at the head: FAIL as resultLine reads it, else INCONCLUSIVE when a step was, else PASS, then the count and each step that did not pass.
export const verdictLine = (sha: string, steps: Step[]): string => {
  const short = steps.length < STEP_COUNT
  const unsure = steps.filter((s) => s.inconclusive).length
  const word =
    short || steps.some((s) => !s.ok && !s.inconclusive) ? "FAIL" : unsure ? "INCONCLUSIVE" : "PASS"
  const why = [
    `${steps.filter((s) => s.ok).length} of ${STEP_COUNT} passed${unsure ? `, ${unsure} inconclusive` : ""}`,
    ...steps.flatMap((s, i) =>
      s.ok ? [] : [`${i + 1}. ${s.name}${s.detail ? `: ${s.detail.replace(/\s+/g, " ")}` : ""}`],
    ),
    ...(short ? [`stopped after ${steps.length} of ${STEP_COUNT} steps`] : []),
  ]
  return `## NewUserGate · ${word} at ${sha.slice(0, 7)} · ${why.join("; ")}`
}

// Writes the verdict to a file in dir and returns the gh call that posts it, the file named by its literal path, since the comment hooks read a body from a file.
export const verdictPost = (n: number, line: string, dir: string): string[] => {
  const file = join(dir, `new-user-verdict-${n}.md`)
  writeFileSync(file, `${line}\n`)
  return ["gh", "pr", "comment", String(n), "--body-file", file]
}

// Pure: the report a run prints, a PASS, FAIL or INCONCLUSIVE line per step with its detail and any shot it could not take, then the count.
export const report = (steps: Step[]): string => {
  const unsure = steps.filter((s) => s.inconclusive).length
  return [
    ...steps.map(
      (s, i) =>
        `${s.ok ? "PASS" : s.inconclusive ? "INCONCLUSIVE" : "FAIL"} ${i + 1}. ${s.name}${s.detail ? `: ${s.detail}` : ""}${s.shot?.startsWith("no shot: ") ? ` (${s.shot})` : ""}`,
    ),
    `${steps.filter((s) => s.ok).length} of ${steps.length} passed${unsure ? `, ${unsure} inconclusive` : ""}`,
  ].join("\n")
}

// Pure: each start spawn.sh's capacity gate refused at or after since, from the lines of its capacity.jsonl, as `<gate> gate: <its words>`.
export const capacityRefusals = (log: string, since: string): string[] =>
  log.split("\n").flatMap((line) => {
    try {
      const row = JSON.parse(line) as {
        at?: unknown
        detail?: unknown
        gate?: unknown
        verdict?: unknown
      }
      return row.verdict === "refused" && typeof row.at === "string" && row.at >= since
        ? [`${row.gate} gate: ${row.detail}`]
        : []
    } catch {
      return []
    }
  })

// A second-precision UTC time, as capacity.jsonl writes its rows' at.
const isoNow = () => `${new Date().toISOString().slice(0, 19)}Z`

// Pure: the words the dispatcher row's usage says to a screen reader, or null when it shows no reading.
export const usageWords = (text: string): string | null => {
  const words = /Claude usage: ([^\n]+)/.exec(text)?.[1]?.trim() ?? null
  if (!words) return null
  return /^(Could not be read|No usage windows read|Not read yet|Sampling has stopped)$/.test(words)
    ? null
    : words
}

// Pure: the finish list's "Left for you" lines from install.sh's output, empty when it left nothing.
export const leftForYou = (out: string): string[] => {
  const at = out.lastIndexOf("Left for you:")
  if (at < 0) return []
  return out
    .slice(at)
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.slice(4))
}

// Pure: the box's .zshenv and .zprofile. Every zsh the stack's jobs start reads .zshenv, and a login one has path_helper reorder PATH after it, so .zprofile puts the stand-ins first again; a Claude account's profile read and ops-usage's probe go to a closed loopback port and ops-usage's stored-login reads to the box's usage reading, so no made-up token leaves the Mac; and spawn.sh's load gate takes BOX_LOAD_MULT.
export const zshStartup = (box: string): string =>
  `export PATH="${join(box, "stubs")}:$PATH"\nexport PLAYGROUND_PROFILE_URL=http://127.0.0.1:9/profile\nexport PLAYGROUND_PROBE_URL=http://127.0.0.1:9/v1/messages\nexport PLAYGROUND_LOAD_MULT=${BOX_LOAD_MULT}\nexport PLAYGROUND_USAGE_API=file://${join(box, "usage-api")}\n`

// Each stand-in that the box's zsh, plain and login, finds anywhere but the box's stubs folder, as `mode name path`; a job the box starts runs in one of the two, so an empty list means none of them reaches the real binary.
export const strayStandIns = (box: string, home: string, names: string[]): string[] =>
  ["-c", "-lc"].flatMap((mode) =>
    Bun.spawnSync(
      ["zsh", mode, `for n in ${names.join(" ")}; do print -r -- "$n $(whence -p $n)"; done`],
      { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stderr: "ignore" },
    )
      .stdout.toString()
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.slice(line.indexOf(" ") + 1).startsWith(`${join(box, "stubs")}/`))
      .map((line) => `${mode} ${line}`),
  )

// Pure: whether a page's text shows the sidebar's Scripts group, whose header reads the word and its count.
export const scriptsGroup = (text: string): boolean =>
  text.split("\n").some((line) => /^Scripts(\s*\d+)?$/.test(line.trim()))

// A program missing from PATH reads as exit 127 with its error, never a throw, so a finally's later steps (the box's clean) still run.
export const run = (argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  try {
    const out = Bun.spawnSync(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stderr: "pipe",
      stdout: "pipe",
    })
    return { code: out.exitCode, err: out.stderr.toString(), out: out.stdout.toString() }
  } catch (error) {
    return { code: 127, err: error instanceof Error ? error.message : String(error), out: "" }
  }
}

const realBin = (name: string) => {
  const found = Bun.which(name)
  if (!found) throw new Error(`${name} is not on PATH`)
  return found
}

// The box's tools folder on its PATH: this host's uv linked alone, as a Mac's /opt/homebrew/bin gives it, so install.sh's uv step finds it and downloads nothing; its own folder (~/.local/bin on Linux) can hold other real programs.
export const hostTools = (box: string, uv: string | null): string => {
  const tools = join(box, "tools")
  mkdirSync(tools, { recursive: true })
  if (uv) symlinkSync(uv, join(tools, "uv"))
  return tools
}

// The box's PATH: the stand-ins first, then tools (hostTools' folder), the host's bun, node and docker, and the system's folders.
export const boxPath = (box: string, tools: string): string => {
  const node = dirname(
    Bun.spawnSync(["realpath", realBin("node")])
      .stdout.toString()
      .trim(),
  )
  return [
    join(box, "stubs"),
    tools,
    join(homedir(), ".bun", "bin"),
    node,
    dirname(realBin("docker")),
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":")
}

// A box for sha: a scratch folder in parent named pg-gate-<sha7>-<random>, which dropBox alone removes.
export const makeBox = (sha: string, parent = "/tmp") =>
  makeScratch(`pg-gate-${sha.slice(0, 7)}-`, parent)

// Removes a box makeBox made, or leaves it and says why.
export const dropBox = (box: string) => {
  const refused = removeScratch(box, dirname(box))
  if (refused) console.error(`gate: ${refused}`)
}

// The made-up stored login where the box's security reads it: the stand-in's Keychain file on a Mac, and on Linux, where install links Playground's own security first on PATH, Claude's ~/.claude/.credentials.json (packages/scripts/src/security/cli.ts).
export const plantLogin = (box: string, home: string, reading: ReturnType<typeof usageReading>) => {
  writeFileSync(join(box, "keychain"), reading.keychain)
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(join(home, ".claude", ".credentials.json"), reading.credentials, { mode: 0o600 })
}

// A box at sha: the HOME, the stand-ins first on PATH, a bare source.git holding sha as pinned and as main, as a ship leaves it, beside origin's canary (HEAD main, as GitHub's), its clone at HOME/playground where install.sh finds it, and the box's own portless proxy on a high port with no TLS, so the box's stack never routes through this Mac's proxy.
const prep = (box: string, sha: string) => {
  const home = join(box, "h")
  mkdirSync(join(box, "stubs"), { recursive: true })
  mkdirSync(join(box, "shots"), { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [name, text] of Object.entries(
    stubs(box, realBin("bunx"), realBin("curl"), realBin("docker")),
  )) {
    writeFileSync(join(box, "stubs", name), text)
    chmodSync(join(box, "stubs", name), 0o755)
  }
  writeFileSync(join(box, "tty"), "y\n")
  for (const rc of [".zshenv", ".zprofile"]) writeFileSync(join(home, rc), zshStartup(box))
  writeFileSync(join(box, "proxy-up"), "")
  const path = boxPath(box, hostTools(box, Bun.which("uv")))
  run(["git", "fetch", "-q", "origin"], { cwd: REPO })
  run(["git", "init", "-q", "--bare", join(box, "source.git")])
  const pushed = run(
    [
      "git",
      "push",
      "-q",
      "--no-verify",
      join(box, "source.git"),
      `${sha}:refs/heads/pinned`,
      `${sha}:refs/heads/main`,
      "refs/remotes/origin/canary:refs/heads/canary",
    ],
    { cwd: REPO },
  )
  if (pushed.code !== 0) throw new Error(`could not push ${sha} into the box: ${pushed.err.trim()}`)
  run(["git", "-C", join(box, "source.git"), "symbolic-ref", "HEAD", "refs/heads/main"])
  run(["git", "clone", "-q", "-b", "pinned", join(box, "source.git"), join(home, "playground")])
  // the made-up stored login goes in only where ops-usage reads PLAYGROUND_USAGE_API, since an older run.py would send it to Claude's usage read
  const usageJob = join(home, "playground", "scripts", "ops", "usage", "run.py")
  if (existsSync(usageJob) && readFileSync(usageJob, "utf8").includes("PLAYGROUND_USAGE_API")) {
    const reading = usageReading(process.env.USER ?? "", Date.now())
    plantLogin(box, home, reading)
    mkdirSync(join(box, "usage-api"))
    writeFileSync(join(box, "usage-api", "profile"), JSON.stringify(reading.profile))
    writeFileSync(join(box, "usage-api", "usage"), JSON.stringify(reading.usage))
  }
  const proxy = run([PORTLESS, "proxy", "start", "-p", PROXY_PORT, "--no-tls"], {
    env: boxEnv(home, { PORTLESS_SYNC_HOSTS: "0" }),
  })
  if (proxy.code !== 0)
    throw new Error(`the box's portless proxy did not start: ${proxy.err.trim()}`)
  return { home, path }
}

// install.sh's whole env in the box: the box's HOME and the test sandbox's stand-ins for the terminal, Homebrew and portless's service, with no INSTALL_OS, so install.sh takes this host's from uname as a new user's run does.
export const installEnv = (box: string, home: string, path: string): Record<string, string> => ({
  BUN_INSTALL_CACHE_DIR: join(homedir(), ".bun", "install", "cache"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  HOME: home,
  INSTALL_BREW_PREFIXES: "",
  INSTALL_PORTLESS_PLIST: join(box, "plist"),
  INSTALL_PROXY_UP: join(box, "proxy-up"),
  INSTALL_TTY: join(box, "tty"),
  LOGNAME: process.env.USER ?? "",
  PATH: path,
  PLAYGROUND_LOAD_MULT: String(BOX_LOAD_MULT),
  PORTLESS_SYNC_HOSTS: "0",
  SHELL: "/bin/zsh",
  TERM: "dumb",
  TEST_SANDBOX_HOME: home,
  USER: process.env.USER ?? "",
})

// install.sh piped to bash as `curl | bash` runs it, with installEnv's clean environment.
const install = async (box: string, home: string, path: string): Promise<string> => {
  const child = Bun.spawn(["timeout", String(INSTALL_LIMIT_S), "bash"], {
    cwd: home,
    env: installEnv(box, home, path),
    stderr: "pipe",
    stdin: Bun.file(join(home, "playground", "install.sh")),
    stdout: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  writeFileSync(join(box, "install.log"), `${out}\n${err}\ninstall.sh exit ${code}\n`)
  return `${out}\n${err}\ninstall.sh exit ${code}`
}

// The made-up account the gate adds through the Dashboard's Add a Claude account.
const GATE_ACCOUNT = "gate@example.com"

// Whether Add account kept account's token where this host's security keeps it: the stand-in's Keychain file on a Mac, and on Linux Playground's own security's file under the box's data folder, secrets/keychain/<service>/<account> with its dots encoded too (fileOf in security/cli.ts).
export const accountKept = (box: string, home: string, account: string): boolean => {
  const keychain = join(box, "keychain")
  if (existsSync(keychain) && readFileSync(keychain, "utf8").includes(account)) return true
  const store = join(home, ".playground", "secrets", "keychain")
  const file = encodeURIComponent(account).replaceAll(".", "%2E")
  return (
    existsSync(store) &&
    readdirSync(store).some((service) => existsSync(join(store, service, file)))
  )
}

// Adds a Claude account through the Dashboard's own Add, on the stand-ins: setup-token is the repo's made-up one; null once this host's security keeps the token (accountKept), else why not. A commit with no PLAYGROUND_PROFILE_URL would send the made-up token to Claude's profile read, so the gate adds none there.
const addAccount = (browser: Browser, box: string, home: string): string | null => {
  const setup = join(home, "playground", "api", "hono", "src", "lib", "accounts", "claude-setup.ts")
  if (!existsSync(setup) || !readFileSync(setup, "utf8").includes("PLAYGROUND_PROFILE_URL"))
    return "Alpha waits on a Claude account, which this commit cannot add without a profile read off the Mac (it predates PLAYGROUND_PROFILE_URL)"
  browser.cmd("find", "role", "button", "click", "--name", "Add a Claude account")
  browser.cmd("find", "label", "Email of the account to add", "fill", GATE_ACCOUNT)
  browser.cmd("find", "role", "button", "click", "--name", "Open sign-in")
  browser.cmd("wait", "3000")
  browser.cmd("find", "label", "Code", "fill", "gate-code")
  browser.cmd("find", "role", "button", "click", "--name", "Add account")
  for (let i = 0; i < 30; i++) {
    if (accountKept(box, home, GATE_ACCOUNT)) return null
    Bun.sleepSync(1000)
  }
  return "Add account kept no token where this host's security keeps it within 30s"
}

// The shot a step ends on, taken once the page settles: a settle or screenshot that fails is named in the shot's place, so the step's verdict stays its own check's.
export const shotAfter = (take: () => string, settle?: () => void): string => {
  try {
    settle?.()
    return take()
  } catch (error) {
    return `no shot: ${(error as Error).message}`
  }
}

// A read a settle wait goes before: a wait that fails leaves the page not yet settled, so the read still runs and its text is what the step judges.
export const readAfter = (settle: () => void, read: () => string): string => {
  try {
    settle()
  } catch {}
  return read()
}

// Step 1's check: install.sh's exit and its Left for you lines, judged before the shot's settle opens the page.
export const installCheck = (out: string, shot: () => string): Omit<Step, "name"> => {
  const left = leftForYou(out)
  const code = Number(/install\.sh exit (\d+)/.exec(out)?.[1] ?? -1)
  const ok = code === 0 && !left.length
  return {
    detail: ok ? "" : `exit ${code}${left.length ? `; left for you: ${left.join(" | ")}` : ""}`,
    ok,
    shot: shot(),
  }
}

// The box's own live.container, named after its folder: the box shares this Mac's Docker, so with the default name its first run reused the live dashboard's running database as its own.
export const boxContainer = (box: string): string => `${basename(box)}-db`

// Pure: the containers in a `docker ps -a` name list that first run made under name, name-<4 letters or digits>, the only ones the gate counts as its own or removes.
export const boxContainers = (listed: string, name: string): string[] =>
  listed
    .split("\n")
    .map((line) => line.trim())
    .filter((c) => c.startsWith(`${name}-`) && /^[0-9a-zA-Z]{4}$/.test(c.slice(name.length + 1)))

// Pure: step 2's FAIL detail when calls.log's text holds a call the box's docker refused (docker.ts), or null when it holds none.
export const dockerRefusal = (calls: string): string | null => {
  const refused = calls
    .split("\n")
    .filter((line) => line.startsWith("docker refused "))
    .map((line) => line.slice("docker refused ".length))
  return refused.length
    ? `the box's docker refused ${refused.join("; ")}, a container or call the box did not make`
    : null
}

// Pure: why the gate refuses to run from a checkout whose gate code is not the sha's, or null when it is: an older gate's box once reached the live dashboard's database.
export const gateDrift = (diffCode: number, sha: string): string | null =>
  diffCode === 0
    ? null
    : `this checkout's packages/scripts/src/new-user-gate/ differs from ${sha.slice(0, 7)}'s, so its box is not the one that sha ships; run the gate from a checkout at that sha: git worktree add --detach <dir> ${sha.slice(0, 7)}, bun install there, then bun run --cwd <dir> gate:new-user ${sha.slice(0, 7)}`

// Pure: the POSTGRES_URL a dotenv file sets, or "" when it sets none.
export const postgresUrl = (env: string): string =>
  (/^POSTGRES_URL=(.*)/m.exec(env)?.[1] || "").trim()

// Pure: the port a postgres:// URL names, or NaN when the URL names none or does not parse, so step 2 fails with its own detail and screenshot.
export const urlPort = (url: string): number => {
  const port = URL.parse(url)?.port
  return port ? Number(port) : NaN
}

// Pure: the host ports `docker port <name> 5432` prints, one per line like 127.0.0.1:33210 or [::]:33210, de-duped.
export const hostPorts = (out: string): number[] =>
  Array.from(
    new Set(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const m = /:(\d+)/.exec(l)
          return m ? Number(m[1]) : NaN
        })
        .filter((n) => !Number.isNaN(n)),
    ),
  )

// Pure: the box's own `playground settings set` of its live.container, run with its checkout's CLI.
export const seedArgv = (home: string, name: string): string[] => [
  "bun",
  "--no-env-file",
  join(home, "playground", "packages", "scripts", "src", "playground", "cli.ts"),
  "settings",
  "set",
  "live.container",
  name,
  "--reason",
  "the new-user gate's box keeps a database of its own",
]

// The box's own database, so a first run that shares this Mac's Docker fails closed when it has no container of the box's own.
export const ownDatabaseVerdict = ({
  error,
  made,
  own,
  saved,
  seeded,
  port,
  ports,
  refused,
}: {
  error: string
  made: number
  own: string
  saved: { detail: string; ok: boolean }
  seeded: boolean
  port?: number
  ports?: number[]
  refused?: string | null
}): { detail: string; ok: boolean } => {
  // fail closed: with no live.container of its own the click would reuse the host's live database
  if (!seeded) {
    return { detail: `the box could not set its own live.container ${own}: ${error}`, ok: false }
  }
  if (refused) {
    return { detail: `the box did not make its own database: ${refused}`, ok: false }
  }
  if (saved.ok && made === 0) {
    return {
      detail: `first run saved a database, but no container of the box's own (${own}-<4>) exists`,
      ok: false,
    }
  }
  if (saved.ok && ports && port !== undefined && !ports.includes(port)) {
    return {
      detail: `the saved database's port ${port} is not a host port of the box's own containers`,
      ok: false,
    }
  }
  return { detail: saved.detail, ok: saved.ok }
}

// Step 2's wait: the click can land before the button renders under load, so the click retries each poll until POSTGRES_URL lands, the way step 3 retries Continue; the button has buttonMs to show, after which the step gives up and names it, and the URL has urlMs, whose miss names it. Each poll the button is missing, reopen runs before the next click, since a page read before the box's name registered stays a 404.
export const databaseCheck = async (
  click: () => boolean,
  saved: () => boolean,
  waits: { buttonMs: number; pollMs: number; urlMs: number } = {
    buttonMs: 60_000,
    pollMs: 2_000,
    urlMs: 120_000,
  },
  reopen: () => void = () => {},
): Promise<Pick<Step, "detail" | "ok">> => {
  let clicked = false
  for (
    const urlEnd = Date.now() + waits.urlMs, buttonEnd = Date.now() + waits.buttonMs;
    Date.now() < urlEnd;
    await Bun.sleep(waits.pollMs)
  ) {
    if (click()) clicked = true
    if (saved()) return { detail: "", ok: true }
    if (!clicked && Date.now() >= buttonEnd)
      return {
        detail: `the Start the database button never showed in ${waits.buttonMs / 1000}s`,
        ok: false,
      }
    if (!clicked) reopen()
  }
  if (click()) clicked = true
  if (saved()) return { detail: "", ok: true }
  return {
    detail: clicked
      ? `no POSTGRES_URL in the desk's .env after ${waits.urlMs / 1000}s`
      : `the Start the database button never showed in ${waits.buttonMs / 1000}s`,
    ok: false,
  }
}

// One agent-browser session for the run, its screenshots in the box.
export class Browser {
  readonly session = `pg-gate-${process.pid}`
  constructor(readonly shots: string) {}
  // One command, tried again up to twice when the daemon took it but sent no reply (os error 35 while the browser starts), and an open as networkChangedWait allows.
  cmd(...args: string[]) {
    for (let tries = 0; ; tries++) {
      const out = run(["agent-browser", "--session", this.session, "--json", ...args])
      let reply: { data?: Record<string, unknown>; error?: string; success?: boolean } = {}
      try {
        reply = JSON.parse(out.out || "{}")
      } catch {}
      if (reply.success) return reply.data ?? {}
      const error = reply.error ?? out.err.trim()
      const noReply =
        tries < 2 && /no response came back|Resource temporarily unavailable/.test(error)
      const wait = networkChangedWait(args, error, tries) ?? (noReply ? 3_000 : null)
      if (wait === null) throw new Error(`agent-browser ${args[0]}: ${error}`)
      Bun.sleepSync(wait)
    }
  }
  text(): string {
    return String(this.cmd("eval", "document.body.innerText").result ?? "")
  }
  shot(name: string, settle?: () => void): string {
    const path = join(this.shots, `${name}.png`)
    return shotAfter(() => {
      this.cmd("screenshot", "--full", path)
      return path
    }, settle)
  }
  // Clicks the button whose words are name once it is enabled; false while there is none.
  clickEnabled(name: string): boolean {
    const script = `(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(name)} && !b.disabled); b?.click(); return Boolean(b) })()`
    return this.cmd("eval", script).result === true
  }
  close() {
    run(["agent-browser", "--session", this.session, "close"])
  }
}

const waitFor = async (ok: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(2_000)) if (ok()) return true
  return ok()
}

// A failed step whose time saw spawn.sh's capacity gate refuse a start in the box (capacity, its log) is inconclusive, and names the refusal.
const step = async (
  steps: Step[],
  name: string,
  check: () => Promise<Omit<Step, "name">>,
  capacity: { log: string; since: string },
) => {
  let got: Step
  try {
    got = { name, ...(await check()) }
  } catch (error) {
    got = { detail: (error as Error).message, name, ok: false }
  }
  const held =
    !got.ok && existsSync(capacity.log)
      ? capacityRefusals(readFileSync(capacity.log, "utf8"), capacity.since)
      : []
  steps.push(
    held.length
      ? {
          ...got,
          detail: `spawn.sh's capacity gate refused a start (${held.at(-1)})`,
          inconclusive: true,
        }
      : got,
  )
  console.log(report(steps).split("\n").at(-2))
}

// The cores and max(load1, load5) as spawn.sh's load gate reads them: sysctl's answer, else Linux's /proc text (sysctlOf), each null when neither reads.
export const roomReadings = (sysctl: (name: SysctlName) => { code: number; out: string }) => {
  const cores = sysctlOf("hw.ncpu", sysctl("hw.ncpu"))
  const loads = sysctlOf("vm.loadavg", sysctl("vm.loadavg"))
  const [load1, load5] = (loads ?? "").replace(/[{}]/g, "").trim().split(/\s+/).map(Number)
  return {
    cores: cores === null ? null : Number(cores),
    load: loads === null ? null : Math.max(load1!, load5!),
  }
}

const sysctlRun = (name: SysctlName) => {
  const { code, out } = run(["sysctl", "-n", name])
  return { code: code ?? 1, out }
}

// Waits up to ROOM_WAIT_MS for this machine's load to fall under the line spawn.sh's load gate holds a dispatcher's start to, and says how long it waited.
const waitForRoom = async () => {
  const { cores } = roomReadings(sysctlRun)
  if (cores === null)
    throw new Error(`gate: neither sysctl hw.ncpu nor ${procSource("hw.ncpu")} reads`)
  const mult = Number(process.env.PLAYGROUND_LOAD_MULT) || 1
  const line =
    cores *
    mult *
    (1 - gateSettings.get({ schemaVersion: SCHEMA_VERSION, values: {} }, "gates.smallReserve"))
  // an unread load fails the gate, since it is never 0
  const load = (): number => {
    const read = roomReadings(sysctlRun).load
    if (read === null)
      throw new Error(`gate: neither sysctl vm.loadavg nor ${procSource("vm.loadavg")} reads`)
    return read
  }
  if (!(load() >= line)) return
  const started = Date.now()
  console.log(
    `gate: load ${load().toFixed(2)} is at or over the box's line ${line}; waiting up to ${ROOM_WAIT_MS / 60_000} minutes`,
  )
  const fell = await waitFor(() => load() < line, ROOM_WAIT_MS)
  console.log(
    `gate: waited ${Math.round((Date.now() - started) / 1000)}s; load ${load().toFixed(2)} ${fell ? "is under" : "is still at or over"} ${line}`,
  )
}

// Stops what the box started, each by its own handle: herdr's servers (whose panes run the ops jobs) through ops-herdr's own stop, the supervisor by the pid its job wrote, the dashboard's stack by the process groups procs.sh recorded, the box's proxy through portless on its own port, since a bare stop probes 443, 80 and 1355 and stops the machine's proxy there, and the gate's containers by the names its label lists.
export const clean = (box: string, home: string, portless = PORTLESS, docker = "docker") => {
  const env = boxEnv(home)
  const desk = join(home, "playground", ".claude", "worktrees", "desk")
  const checkout = existsSync(desk) ? desk : join(home, "playground")
  const herdrCli = join(checkout, "packages", "scripts", "src", "ops-herdr", "cli.ts")
  if (existsSync(herdrCli)) run(["bun", "--no-env-file", herdrCli, "stop-all"], { env })
  const supervisor = join(home, ".playground", "ops", "ops-dashboard.pid")
  const pid = existsSync(supervisor) ? Number(readFileSync(supervisor, "utf8").trim()) : 0
  if (pid > 1) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  const procs = join(checkout, "scripts", "ops", "dashboard", "procs.sh")
  for (const job of ["dashboard-dev", "dashboard-ingest", "dashboard-web", "dashboard-web-next"])
    if (existsSync(procs)) run(["bash", procs, "stop", job], { env })
  run([portless, "proxy", "stop", "-p", PROXY_PORT], { env })
  const names = run([
    docker,
    "ps",
    "-a",
    "--filter",
    `label=${BOX_LABEL}=${basename(box)}`,
    "--format",
    "{{.Names}}",
  ])
    .out.split("\n")
    .filter(Boolean)
  const own = boxContainers(
    run([docker, "ps", "-a", "--format", "{{.Names}}"]).out,
    boxContainer(box),
  )
  for (const name of [...names, ...own]) run([docker, "rm", "-fv", name])
  dropBox(box)
}

const main = async (args: string[]) => {
  if (args[0] === "--clean" && args[1]) {
    clean(resolve(args[1]), join(resolve(args[1]), "h"))
    return 0
  }
  const sha = args.find((a) => !a.startsWith("--"))
  const pr = args.includes("--pr") ? (args[args.indexOf("--pr") + 1] ?? "") : null
  if (!sha || (pr !== null && !/^\d+$/.test(pr))) {
    console.error(
      "usage: bun run gate:new-user <tag|sha> [--box <parent dir>] [--keep] [--pr <n>] | --clean <box>",
    )
    return 2
  }
  // a tag reads from origin, since a checkout can hold a stale local tag of the same name
  const tagged = run(["git", "ls-remote", "origin", `refs/tags/${sha}`, `refs/tags/${sha}^{}`], {
    cwd: REPO,
  })
    .out.split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
  const fromTag = (tagged.find(([, ref]) => ref?.endsWith("^{}")) ?? tagged[0])?.[0]
  if (fromTag) run(["git", "fetch", "-q", "origin", fromTag], { cwd: REPO })
  const full = run(["git", "rev-parse", `${fromTag ?? sha}^{commit}`], { cwd: REPO }).out.trim()
  if (!full) {
    console.error(`gate: ${sha} is no commit in this checkout`)
    return 2
  }
  const drift = gateDrift(
    run(["git", "diff", "--quiet", full, "--", "packages/scripts/src/new-user-gate"], { cwd: REPO })
      .code,
    full,
  )
  if (drift) {
    console.error(`gate: ${drift}`)
    return 2
  }
  const keep = args.includes("--keep")
  const steps: Step[] = []
  await waitForRoom()
  const box = makeBox(
    full,
    args.includes("--box") ? resolve(args[args.indexOf("--box") + 1]!) : undefined,
  )
  const { home, path } = prep(box, full)
  const stray = strayStandIns(box, home, Object.keys(stubs(box, "")))
  if (stray.length) {
    clean(box, home)
    console.error(
      `gate: the box's zsh reaches past a stand-in, so a job could call the real one:\n${stray.join("\n")}`,
    )
    return 2
  }
  const desk = join(home, "playground", ".claude", "worktrees", "desk")
  const browser = new Browser(join(box, "shots"))
  console.log(`gate: ${full.slice(0, 10)} in ${box}`)
  console.log(
    `gate: the box sets PLAYGROUND_LOAD_MULT=${BOX_LOAD_MULT}, so spawn.sh's load gate there is relaxed to ${BOX_LOAD_MULT}x the cores; its memory and usage gates are not`,
  )
  // each step is judged against the capacity refusals since the one before it ended, the first since before the install
  const capacity = { log: join(home, ".playground", "ops", "capacity.jsonl"), since: isoNow() }
  const check = async (name: string, judge: () => Promise<Omit<Step, "name">>) => {
    await step(steps, name, judge, capacity)
    capacity.since = isoNow()
  }
  let postFailed = false
  try {
    const out = await install(box, home, path)
    // the bare name the live checkout aliases, as a new user opens it, on the box's own proxy
    const web = `http://playground.localhost:${PROXY_PORT}`
    await check("curl | bash exits 0 with no Left for you", async () => {
      return installCheck(out, () =>
        browser.shot("1-install", () => {
          browser.cmd("open", `${web}/dashboard`)
          browser.cmd("wait", "--load", "networkidle")
        }),
      )
    })
    const own = boxContainer(box)
    const seeded = run(seedArgv(home, own), { env: boxEnv(home) })
    await check("first run starts the database with one click", async () => {
      if (seeded.code !== 0) {
        return ownDatabaseVerdict({
          error: (seeded.err || seeded.out).trim().slice(-200),
          made: 0,
          own,
          saved: { detail: "", ok: true },
          seeded: false,
        })
      }
      const env = join(desk, ".env")
      const saved = await databaseCheck(
        () => browser.clickEnabled("Start the database"),
        () => existsSync(env) && /^POSTGRES_URL=\S/m.test(readFileSync(env, "utf8")),
        undefined,
        () => {
          try {
            if (/\b404\b/.test(browser.text())) browser.cmd("open", `${web}/dashboard`)
          } catch {}
        },
      )
      const made = boxContainers(run(["docker", "ps", "-a", "--format", "{{.Names}}"]).out, own)
      const calls = join(box, "calls.log")
      const refused = dockerRefusal(existsSync(calls) ? readFileSync(calls, "utf8") : "")
      const port = saved.ok ? urlPort(postgresUrl(readFileSync(env, "utf8"))) : NaN
      const ports = made.flatMap((name) => hostPorts(run(["docker", "port", name, "5432"]).out))
      const verdict = ownDatabaseVerdict({
        error: "",
        made: made.length,
        own,
        saved,
        seeded: true,
        port,
        ports,
        refused,
      })
      return {
        ...verdict,
        shot: browser.shot("2-database"),
      }
    })
    await check("the Dashboard shows Alpha", async () => {
      browser.cmd("open", `${web}/dashboard`)
      // first run's Continue makes and signs in the owner once every needed check passes; a click before the page hydrates does nothing, so it is clicked again until the dashboard shows
      let firstRun = false
      const shown = await waitFor(() => {
        const text = browser.text()
        if (text.includes("Alpha")) return true
        firstRun = text.includes("Let's check this Mac")
        if (firstRun) browser.clickEnabled("Continue")
        return false
      }, 120_000)
      return {
        detail: shown
          ? ""
          : firstRun
            ? "first run still showed after 120s of Continue"
            : "no Alpha on /dashboard after 120s",
        ok: shown,
        shot: browser.shot("3-alpha"),
      }
    })
    await check(
      "Alpha routes one small task: a manager starts and a worker opens a PR",
      async () => {
        browser.cmd("find", "text", "Alpha", "click")
        // Alpha's chat opens once it runs; until then its pane names the step it waits on, the first numbered one, or offers Start Alpha once every step is done
        const waitsOn = () => {
          const text = browser.text()
          const at = text.indexOf("Alpha is not running")
          if (at < 0) return null
          // the pane alone, which ends on its System line, since the panes beside it hold counts too
          const pane = text.slice(at).split("Every agent's state")[0]!
          const step = /\n\s*\d+\s*\n\s*([^\n]+)/.exec(pane)?.[1]?.trim()
          return step ?? (pane.includes("Start Alpha") ? "Start Alpha" : "")
        }
        if (waitsOn() === "Claude account") {
          const added = addAccount(browser, box, home)
          if (added) return { detail: added, ok: false, shot: browser.shot("4-route") }
          await waitFor(() => waitsOn() !== "Claude account", 30_000)
        }
        if (waitsOn() === "Start Alpha") {
          browser.clickEnabled("Start Alpha")
          await waitFor(() => waitsOn() === null, 60_000)
        }
        const waiting = waitsOn()
        if (waiting !== null)
          return {
            detail:
              waiting === "Start Alpha"
                ? "Alpha is not running 60s after Start Alpha"
                : `Alpha is not running${waiting ? `; it waits on ${waiting}` : ""}`,
            ok: false,
            shot: browser.shot("4-route"),
          }
        browser.cmd("find", "role", "textbox", "fill", "Add a line to the README saying hello")
        browser.cmd("press", "Enter")
        const calls = join(box, "calls.log")
        const opened = await waitFor(
          () => existsSync(calls) && readFileSync(calls, "utf8").includes("gh pr create"),
          ROUTE_WAIT_MS,
        )
        return {
          detail: opened ? "" : `no gh pr create in ${ROUTE_WAIT_MS / 1000}s`,
          ok: opened,
          shot: browser.shot("4-route"),
        }
      },
    )
    await check("Usage shows", async () => {
      // a read can land before the machine's reading does, when the row still says Not read yet, so the last read is the one judged
      let text = ""
      await waitFor(() => {
        browser.cmd("open", `${web}/dashboard`)
        text = readAfter(
          () => browser.cmd("wait", "--load", "networkidle"),
          () => browser.text(),
        )
        return usageWords(text) !== null
      }, USAGE_WAIT_MS)
      const words = usageWords(text)
      return {
        detail: words ?? "no usage reading on the dispatcher's row",
        ok: words !== null,
        shot: browser.shot("5-usage"),
      }
    })
    await check("the Scripts group has no Failing row", async () => {
      // the supervisor checks its follower each 30s, so a row that failed before the database started has a few ticks to clear
      // a read can land before the sidebar renders, so the last read that shows the group is the one judged
      let text = ""
      await waitFor(() => {
        browser.cmd("open", `${web}/dashboard`)
        const read = readAfter(
          () => browser.cmd("wait", "--load", "networkidle"),
          () => browser.text(),
        )
        if (scriptsGroup(read) || !text) text = read
        return scriptsGroup(read) && !/\bFailing\b/.test(read)
      }, SCRIPTS_WAIT_MS)
      const failing = text.split("\n").filter((line) => /\bFailing\b/.test(line))
      const listed = scriptsGroup(text)
      const results = join(home, ".playground", "ops", "dashboard", "results.log")
      const last = existsSync(results)
        ? readFileSync(results, "utf8").trim().split("\n").at(-1)?.slice(21, 200)
        : ""
      return {
        detail: listed
          ? failing.length
            ? `${failing.join(" | ")} after ${SCRIPTS_WAIT_MS / 1000}s; results.log: ${last}`
            : ""
          : "no Scripts group on /dashboard",
        ok: listed && failing.length === 0,
        shot: browser.shot("6-scripts"),
      }
    })
    await check("the Dashboard follows main", async () => {
      const upstream = run(["bash", join(desk, "scripts", "ops", "dashboard", "upstream.sh")], {
        cwd: desk,
      }).out.trim()
      const log = join(home, ".playground", "ops", "dashboard", "supervisor.log")
      const canary = existsSync(log) && readFileSync(log, "utf8").includes("canary moved")
      return {
        detail: `upstream.sh reads ${upstream || "nothing"}${canary ? "; supervisor.log rolled on canary" : ""}`,
        ok: upstream === "main" && !canary,
        shot: browser.shot("7-follows-main"),
      }
    })
  } finally {
    browser.close()
    console.log(report(steps))
    if (keep) console.log(`gate: kept ${box}; bun run gate:new-user --clean ${box} removes it`)
    else {
      const shots = join(dirname(box), `${box.split("/").at(-1)}-shots`)
      if (existsSync(join(box, "shots"))) run(["cp", "-R", join(box, "shots"), shots])
      mkdirSync(shots, { recursive: true })
      const logs = join(home, ".playground", "ops", "dashboard")
      for (const file of [
        join(box, "install.log"),
        join(box, "calls.log"),
        join(logs, "supervisor.log"),
        join(logs, "results.log"),
        join(logs, "dev.log"),
        join(home, ".playground", "dashboard-ingest.log"),
        join(home, ".playground", "ops", "ops-dashboard.json"),
        join(home, ".playground", "ops", "ops-usage.json"),
      ])
        if (existsSync(file)) run(["cp", file, shots])
      clean(box, home)
      console.log(`gate: screenshots and logs in ${shots}`)
    }
    console.log(resultLine(full, steps))
    if (pr !== null) {
      const posted = run(verdictPost(Number(pr), verdictLine(full, steps), dirname(box)), {
        cwd: REPO,
      })
      postFailed = posted.code !== 0
      if (postFailed)
        console.error(`gate: posting the verdict on #${pr} failed: ${posted.err.trim()}`)
      else console.log(`gate: posted the verdict on #${pr}: ${posted.out.trim()}`)
    }
  }
  return steps.every((s) => s.ok) && !postFailed ? 0 : 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
