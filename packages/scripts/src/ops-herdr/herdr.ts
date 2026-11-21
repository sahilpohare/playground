import { readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { userInfo } from "node:os"
import { join } from "node:path"

import { envValue } from "@packages/config/org"
import { dataDir, herdrDir } from "@packages/env/data-dir"

import { writeAtomic } from "../write-atomic"
import { assetOf, herdrPath, PIN_SOURCE, pinnedSum } from "./pin"

export const CYCLE_SECONDS = 60

// Two separate herdr servers: playground for every session, playground-probes for drills, upgrades and the shell-pane skill's plain shell panes. herdr keeps a server's state, its saved layout and logs included, under ~/.config/herdr/sessions/<name> (measured on 0.9.5: HERDR_HOME and XDG_STATE_HOME move none of it, and XDG_CONFIG_HOME, which would, reaches every pane), so the names are Playground's own and never a name another herdr setup on the Mac uses, such as factory or probes.
export const HERDR_SESSIONS = ["playground", "playground-probes"]

// Where herdr keeps a server's state, read by the job for its log.
export const stateDir = (home: string, session: string): string =>
  join(home, ".config", "herdr", "sessions", session)

export type Pin = { path: string; sha256: string; tag: string; version: string }
export type Found = { sha256: string; version: string }

// The pin as this machine reads it: Playground's own copy at the data folder's bin/herdr and the PR-owned sum of its release asset, tagged by the asset's key; a machine with no pinned asset reads an empty sum, which pinProblem names.
export const pinFor = (
  env: Record<string, string | undefined>,
  asset: string | null = assetOf(),
): Pin => ({
  path: herdrPath(env),
  sha256: asset ? pinnedSum(asset) : "",
  tag: asset ?? `${process.platform}-${process.arch}`,
  version: PIN_SOURCE.version,
})

// The config is PR-owned: the job copies it into the herdr folder, so it changes only through a reviewed PR.
export const CONFIG_SOURCE = readFileSync(join(import.meta.dir, "config.toml"), "utf8")

export const dataFolder = (env: Record<string, string | undefined>): string => dataDir(env)

// The sockets' folder, herdrDir in @packages/env/data-dir, which follows HOME; PLAYGROUND_HERDR_DIR and PLAYGROUND_HERDR_SESSIONS move a scratch server off the factory's socket and session names.
export { herdrDir }

// A server's name is a word, as spawn.sh takes it, since it names a socket file and a state folder, and never default, herdr's own server; any other name in the list is skipped and named on every beat.
const WORD = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const serverNames = (
  env: Record<string, string | undefined>,
): { sessions: string[]; skipped: string[] } => {
  const names =
    envValue(env, "PLAYGROUND_HERDR_SESSIONS")?.split(",").filter(Boolean) ?? HERDR_SESSIONS
  return {
    sessions: names.filter((name) => WORD.test(name) && name !== DEFAULT_SERVER),
    skipped: names.filter((name) => !WORD.test(name) || name === DEFAULT_SERVER),
  }
}

export const sessionsOf = (env: Record<string, string | undefined>): string[] =>
  serverNames(env).sessions

const BASICS = ["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "USER"] as const

// herdr's own default server, on ~/.config/herdr/herdr.sock, which no factory job starts; ops:herdr reaches it only to stop it.
export const DEFAULT_SERVER = "default"

// The servers on sockets in Playground's own herdr folder, read from its file names: each <name>.sock whose name is a word and not herdr's default, a client's socket (<name>-client.sock, measured on 0.9.5) left out, so a stop reaches only the servers this folder holds, whatever their names.
export const socketServers = (files: string[]): string[] =>
  files
    .filter((file) => file.endsWith(".sock") && !file.endsWith("-client.sock"))
    .map((file) => file.slice(0, -".sock".length))
    .filter((name) => WORD.test(name) && name !== DEFAULT_SERVER)
    .toSorted()

// A line for each server still running on a socket in the folder under a name the job no longer starts, such as factory and probes from before Playground's servers took names of their own: left running, since a stop ends its sessions, and named with the command that stops it.
export const leftOverLines = (
  servers: string[],
  sessions: string[],
  up: string[],
  dir: string,
): string[] =>
  servers
    .filter((name) => !sessions.includes(name) && up.includes(name))
    .map(
      (name) =>
        `Left for you: herdr server ${name} still runs from an older Playground in ${dir}, beside the current ones; playground herdr stop stops every server there, then playground starts the current ones`,
    )

// This uid's account name and login shell, for a start from a GUI app or env -i: Bun's userInfo() takes them from USER and SHELL, else "unknown", on macOS and on Linux alike (measured on 1.4.4), macOS has an account named unknown whose shell is /usr/bin/false, and herdr refuses every pane of a server whose SHELL it cannot find: macOS reads them through /usr/bin/dscl, Linux from `getent passwd <uid>`, else /etc/passwd's line for the uid; PLAYGROUND_DSCL, PLAYGROUND_GETENT and PLAYGROUND_PASSWD name a fake inside the test sandbox alone.
function account(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): { name?: string; shell?: string; source: string } {
  const uid = String(process.getuid?.())
  const fake = (name: string, real: string) => (env.TEST_SANDBOX_HOME && env[name]) || real
  const read = (argv: string[]): string => {
    try {
      const done = Bun.spawnSync(argv)
      return done.exitCode === 0 ? done.stdout.toString() : ""
    } catch {
      return ""
    }
  }
  if (platform === "darwin") {
    const dscl = fake("PLAYGROUND_DSCL", "/usr/bin/dscl")
    const source = `dscl . -read /Users/<name> UserShell for uid ${uid}`
    const name = read([dscl, ".", "-search", "/Users", "UniqueID", uid]).split(/\s/)[0]
    if (!name) return { source }
    const shell = read([dscl, ".", "-read", `/Users/${name}`, "UserShell"]).split("UserShell:")[1]
    return { name, shell: shell?.trim(), source }
  }
  const passwd = fake("PLAYGROUND_PASSWD", "/etc/passwd")
  const source = `getent passwd ${uid} or ${passwd}`
  let line = read([fake("PLAYGROUND_GETENT", "/usr/bin/getent"), "passwd", uid])
  if (!line) {
    try {
      line = readFileSync(passwd, "utf8")
    } catch {
      return { source }
    }
  }
  const fields = line
    .split("\n")
    .map((entry) => entry.split(":"))
    .find((entry) => entry.length === 7 && entry[2] === uid)
  return { name: fields?.[0] || undefined, shell: fields?.[6]?.trim() || undefined, source }
}

// The shell basics alone, so a herdr call with no session or socket of its own reaches the default server; with no SHELL and no login shell for this uid it throws, naming where it looked, so the job beats that and starts no server in place of guessing one.
export function basicEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const user = userInfo()
  const found = env.SHELL && env.USER && env.LOGNAME ? null : account(env, platform)
  const shell = env.SHELL || found?.shell
  if (!shell)
    throw new Error(
      `no login shell: SHELL is unset and ${found?.source} gives none, and herdr refuses every pane whose SHELL it cannot find`,
    )
  const fallback: Record<(typeof BASICS)[number], string> = {
    HOME: user.homedir,
    LANG: "en_US.UTF-8",
    LOGNAME: found?.name || user.username,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: shell,
    TERM: "xterm-256color",
    USER: found?.name || user.username,
  }
  return Object.fromEntries(BASICS.map((name) => [name, env[name] || fallback[name]]))
}

// The server's whole environment, as env -i with the basics alone, so no session's token reaches a pane. herdr's socket follows HERDR_SOCKET_PATH only when the session comes from HERDR_SESSION, not --session (measured on 0.9.5); its state and log stay in ~/.config/herdr/sessions/<name>, since only XDG_CONFIG_HOME moves them and every pane would inherit that.
export function serverEnv(
  env: Record<string, string | undefined>,
  dir: string,
  session: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    ...basicEnv(env, platform),
    HERDR_CONFIG_PATH: join(dir, "config.toml"),
    HERDR_SESSION: session,
    HERDR_SOCKET_PATH: join(dir, `${session}.sock`),
  }
}

const FORBIDDEN = /^(CLAUDE_CODE_|CMUX_)/

// What a pane's environment holds, as names and lengths alone, and the names no pane may carry.
export function envReport(env: Record<string, string | undefined>): {
  forbidden: string[]
  lines: string[]
} {
  const names = Object.keys(env).toSorted()
  return {
    forbidden: names.filter((name) => FORBIDDEN.test(name)),
    lines: names.map((name) => `${name} ${env[name]?.length ?? 0}`),
  }
}

export function pinProblem(pin: Pin, found: Found | null): string | null {
  if (!pin.sha256)
    return `the pin names no herdr ${pin.version} sha256 for release asset ${pin.tag}`
  if (!found)
    return `herdr at ${pin.path} cannot be read; the pin names ${pin.version} ${pin.sha256}`
  if (found.sha256 === pin.sha256 && found.version === pin.version) return null
  return `herdr at ${pin.path} is ${found.version} ${found.sha256}; the pin names ${pin.version} ${pin.sha256}`
}

type PaneEntry = { agent?: unknown; cwd?: unknown; pane_id?: unknown }

// The panes `pane list` answered with, or null when its answer does not read.
const panesOf = (list: unknown): PaneEntry[] | null => {
  const panes = (list as { result?: { panes?: unknown } } | null)?.result?.panes
  return Array.isArray(panes) ? (panes as PaneEntry[]) : null
}

// A stop exits every pane, a turn in flight included (L5), so it waits until the session holds none; the default server's shell panes (herdr leaves out `agent`) are no one's work, so there it waits only on a pane running an agent.
export function stopRefusal(session: string, list: unknown): string | null {
  const all = panesOf(list)
  if (!all) return `refusing to stop ${session}: cannot read its panes`
  const panes = session === DEFAULT_SERVER ? all.filter((pane) => pane.agent != null) : all
  if (panes.length === 0) return null
  const names = panes.map((pane) => `${String(pane.agent ?? pane.pane_id)} (${String(pane.cwd)})`)
  return `refusing to stop ${session}: ${panes.length} live, ${names.join(", ")}`
}

// One line for playground status: a server down, or up with the sessions its panes hold, a pane counting while it names an agent.
export function statusLine(session: string, up: boolean, list: unknown): string {
  if (!up) return `herdr ${session}: down`
  const panes = panesOf(list)
  if (!panes) return `herdr ${session}: up, its panes cannot be read`
  const n = panes.filter((pane) => Boolean(pane.agent)).length
  return `herdr ${session}: up, ${n} ${n === 1 ? "session" : "sessions"}`
}

// status's lines, one a server, its panes read only while it is up; a status that cannot be read reads down.
export async function serverStatusLines(
  sessions: string[],
  running: (session: string) => Promise<boolean>,
  paneList: (session: string) => unknown,
): Promise<string[]> {
  const lines: string[] = []
  for (const session of sessions) {
    const up = await running(session).catch(() => false)
    lines.push(statusLine(session, up, up ? paneList(session) : null))
  }
  return lines
}

// What attach opens, a client on the pinned binary with the server's own environment, or why it opens nothing: a server not in the list, a binary off the pin, or a server that is down, since a bare herdr would start one off the pin's checks and env -i.
export function attachPlan(
  env: Record<string, string | undefined>,
  dir: string,
  session: string,
  sessions: string[],
  pin: Pin,
  found: Found | null,
  up: boolean,
): { argv: string[]; env: Record<string, string> } | { error: string } {
  if (!sessions.includes(session)) return { error: `attach takes one of ${sessions.join(", ")}` }
  const pinned = pinProblem(pin, found)
  if (pinned)
    return {
      error: `${pinned}; playground herdr pin puts herdr ${pin.version} back at ${pin.path}, or move the pin in a PR to packages/scripts/src/ops-herdr/pin.json`,
    }
  if (!up)
    return {
      error: `${session} is not running; playground, or bun run ops:herdr start, brings it up`,
    }
  return { argv: [pin.path], env: serverEnv(env, dir, session) }
}

const LOADED = /herdr server started|"api\.request\.start".*method="server\.reload_config"/
const CONFIG_WARNING = /\sWARN herdr::config[\w:]*: (?:config diagnostic )?(.*)$/

// herdr falls back to a default on a bad config value with only a log warning, logged right after the server starts or a reload's request line (measured on 0.9.5), so the beat reads the warnings since the last of those, and a config fixed by a reload clears.
export function configWarnings(log: string): string[] {
  const lines = log.split("\n")
  const start = lines.findLastIndex((line) => LOADED.test(line))
  return lines
    .slice(start + 1)
    .map((line) => CONFIG_WARNING.exec(line)?.[1]?.trim())
    .filter((warning): warning is string => Boolean(warning))
}

export type CycleDeps = {
  found: () => Promise<Found | null>
  log: (session: string) => Promise<string | null>
  // Whether a server's restore is still owed (owedFile).
  owed: (session: string) => Owed
  pin: Pin
  // spawn.sh restore for one server: what failed (restoreProblem), and whether its restore stays owed (restoreResult).
  restore: (session: string) => Promise<Restored>
  running: (session: string) => Promise<boolean>
  sessions: string[]
  // The names in the list that are not a server's (serverNames).
  skipped: string[]
  start: (session: string) => Promise<string | null>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Set as a server starts, and cleared once a restore leaves no session waiting, every one back or failed, so a session a gate or focus holds comes back on a later cycle; it is there for the home to read as the factory coming back.
export type Owed = { get: () => Promise<boolean>; set: (owed: boolean) => Promise<void> }

// A file beside the server's socket, so the job finishes a restore that `start` (bun run dev, the dispatcher) began and the gate cut short.
export const owedFile = (dir: string, session: string): Owed => {
  const path = join(dir, `${session}.restore`)
  return {
    get: () => Bun.file(path).exists(),
    set: async (owed) => {
      if (owed) await writeAtomic(path, `${new Date().toISOString()}\n`)
      else await rm(path, { force: true })
    },
  }
}

// One beat: "ok", or every problem, a throw included, so the beat names it. A server that is down starts only on the pinned binary, and every server that starts restores its own sessions; one that runs is never restarted, a changed binary included, since a stop exits every pane.
export async function cycle(deps: CycleDeps): Promise<string> {
  const problems = deps.skipped.map(
    (name) => `${name}: not a herdr server name (a word of a-z, 0-9 and -), skipped`,
  )
  try {
    const pinned = pinProblem(deps.pin, await deps.found())
    if (pinned) problems.push(pinned)
    for (const session of deps.sessions) {
      let up: boolean
      try {
        up = await deps.running(session)
      } catch (err) {
        problems.push(`${session}: cannot read its status: ${messageOf(err)}`)
        continue
      }
      if (!up) {
        if (pinned) {
          problems.push(`${session}: down, not started on an unpinned binary`)
          continue
        }
        // Owed before the start, since a start that gives up at 10s leaves a server that still comes up, which the next cycle finds running.
        await deps.owed(session).set(true)
        const failed = await deps.start(session)
        if (failed) problems.push(`${session}: ${failed}`)
        up = !failed
      }
      if (up) {
        try {
          if (await deps.owed(session).get()) {
            const { owed, problem } = await deps.restore(session)
            if (problem) problems.push(`${session}: ${problem}`)
            if (!owed) await deps.owed(session).set(false)
          }
        } catch (err) {
          problems.push(`${session}: restore: ${messageOf(err)}`)
        }
      }
      for (const warning of configWarnings((await deps.log(session)) ?? "")) {
        problems.push(`${session}: ${warning}`)
      }
    }
  } catch (err) {
    problems.push(messageOf(err))
  }
  return problems.length === 0 ? "ok" : problems.join("; ")
}

// start's one check, for bun run dev and the dispatcher: a line for each server it started, then ok, that all were up when it started none, or the problems.
export async function startOnce(deps: CycleDeps): Promise<{ lines: string[]; ok: boolean }> {
  const started: string[] = []
  const result = await cycle({
    ...deps,
    start: async (session) => {
      const failed = await deps.start(session)
      if (!failed) started.push(session)
      return failed
    },
  })
  const lines = started.map((session) => `started ${session}`)
  if (result !== "ok") lines.push(result)
  else lines.push(started.length > 0 ? "ok" : `all were up: ${deps.sessions.join(", ")}`)
  return { lines, ok: result === "ok" }
}

// The job: a check now and every cycle, each beating its result, a changed binary included; a check still running at a cycle beats as failing, so one that hangs still shows.
export function runJob(deps: CycleDeps, path: string, every = CYCLE_SECONDS * 1000): () => void {
  const startedAt = new Date()
  let checking = false
  const pulse = (result: string) =>
    beat(path, startedAt, new Date(), result).catch((err) => console.error(err))
  const check = async () => {
    checking = true
    const result = await cycle(deps)
    checking = false
    console.log(`${new Date().toISOString()} ${result}`)
    await pulse(result)
  }
  void check()
  const timer = setInterval(() => {
    void (checking ? pulse("still checking herdr from the last cycle") : check())
  }, every)
  return () => clearInterval(timer)
}

// spawn.sh restore runs with the job's own environment, pointed at the server the job started, since a scratch server moves both names.
export const restoreEnv = (
  env: Record<string, string | undefined>,
  dir: string,
  session: string,
): Record<string, string | undefined> => ({
  ...env,
  PLAYGROUND_HERDR_DIR: dir,
  PLAYGROUND_HERDR_SESSION: session,
})

// spawn.sh restore prints one line a resume record (restored, skipped, waiting or not restored, each but restored with its reason), so a restore reads as counts: what came back, what ran already, what the roster keeps down, what else it passed over, what each gate or focus holds (a later cycle restores those) and what failed; null when no line names a session.
export function restoreSummary(output: string): string | null {
  const lines = output.split("\n").filter(Boolean)
  const count = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).length
  const live = count(/^skipped \S+: live$/)
  const down = count(/^skipped \S+: its roster row reads /)
  const gates = waits(output)
  const waiting = [...gates.values()].reduce((sum, n) => sum + n, 0)
  const parts = [
    [count(/^restored /), "restored"],
    [live, "already running"],
    [down, "down in the roster"],
    [count(/^skipped /) - live - down, "passed over"],
    ...[...gates]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([gate, n]) =>
          [
            n,
            gate === "load"
              ? "waiting for load to drop"
              : gate === "focus"
                ? "waiting for focus to end"
                : `waiting on the ${gate} gate`,
          ] as const,
      ),
    [count(/^not restored /), "not restored"],
  ] as const
  const shown = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`)
  if (shown.length === 0) return null
  return `${shown.join(" · ")}${waiting > 0 ? " (the waiting ones come back on their own)" : ""}`
}

// What restore prints for one server that passed: its summary and the file that holds each session's line, or its lines as they came; nothing for one that failed, whose problem (restoreProblem) the cycle names once.
export function restoreLines(session: string, code: number, output: string, log: string): string[] {
  if (code !== 0) return []
  const summary = restoreSummary(output)
  if (summary) return [`restore ${session}: ${summary}; each session's line: ${log}`]
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => `restore ${session}: ${line}`)
}

// spawn.sh restore exits 1 when a session was not restored, or when it tried none (another restore's lock, an unreadable roster), so the beat names its counts and the file that holds each session's line, else its last line; a restore whose only misses wait exits 0, which is progress and no problem.
export function restoreProblem(code: number, output: string, log: string): string | null {
  if (code === 0) return null
  const summary = restoreSummary(output)
  if (summary) return `restore: ${summary}; each session's line: ${log}`
  return `restore: ${output.split("\n").filter(Boolean).at(-1) ?? `exited ${code}`}`
}

// What holds each session spawn.sh restore printed as waiting (its restore_waits decides), a gate or focus, with how many it holds.
const waits = (output: string): Map<string, number> => {
  const held = new Map<string, number>()
  for (const line of output.split("\n")) {
    if (!line.startsWith("waiting ")) continue
    const by = /\bthe (\w+) gate holds it\b/.exec(line)?.[1] ?? "focus"
    held.set(by, (held.get(by) ?? 0) + 1)
  }
  return held
}

export type Restored = { owed: boolean; problem: string | null }

// A restore's problem, and whether the server's restore stays owed for the next cycle: while a session waits, or when a failed restore tried no session.
export const restoreResult = (code: number, output: string, log: string): Restored => ({
  owed:
    waits(output).size > 0 ||
    (code !== 0 && !/^(restored|skipped|waiting|not restored) /m.test(output)),
  problem: restoreProblem(code, output, log),
})

// The heartbeat api/hono/src/lib/dashboard/ops.ts reads.
export const beat = (path: string, startedAt: Date, now: Date, lastResult: string) =>
  writeAtomic(
    path,
    `${JSON.stringify({
      cycleSeconds: CYCLE_SECONDS,
      job: "ops-herdr",
      lastBeatAt: now.toISOString(),
      lastResult,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    })}\n`,
  )
