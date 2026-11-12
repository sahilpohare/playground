import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { dataDirOf } from "@packages/env/data-dir"

import { rosterRole } from "../../../scripts/hooks/role"

// Measures a head's hooks against a canary sha, each form or call reaching each hook's check() as data alone and never run, under --role's role and a scratch data folder, a hook canary lacks against an allow-all baseline: `sweep --forms <module>` passes the forms a module exports from the home, the data folder and a worktree, `replay` the last day's Bash calls from this machine's transcripts, `--role session` each under its own session's role; a clean head's result is stored under its key and printed again for a day without a run; started bare it queues itself through run-slot, as commit-slot.ts queues a commit's build.

export type Check = (
  raw: string,
  env: Record<string, string | undefined>,
  main?: string,
) => Promise<string | undefined> | string | undefined
type Form = { command: string; inClass?: boolean }
type Call = { command: string; cwd: string; name?: string; session?: string }
type Env = Record<string, string | undefined>
type Tally = { inClass: number; outClass: number }

const USAGE =
  "usage: bun run hooks:differential <sweep --forms <module> | replay [--hours <n>] [--role session]> --canary <sha> --hook <name> [--hook <name> ...] [--role <role>] [--all] [--fresh]"

const DAY = 24 * 3600 * 1000

// The hooks whose check() takes the main checkout third: canary's tree is unpacked by git archive and is no git checkout, so on its own default each would read that folder as main, and both sides get the head's main checkout
export const TAKES_MAIN = ["no-main-checkout", "no-unslotted-run"]

// Every file in the hooks' import graph that finds a path from its own copy's folder (import.meta's dir, path or url), and why each reads the same on both sides: canary's copy sits in an unpacked tree that is no git checkout
export const ROOT_READS: Record<string, string> = {
  "packages/scripts/src/main-checkout.ts":
    "pinned: mainCheckout() reads PLAYGROUND_REPO first, which both sides get as the head's main checkout",
  "packages/scripts/src/playground/setting.ts":
    "unreached: only stuck-alert's import.meta.main block imports it, and role.ts and no-chat-question run it for sessions.names and live.branch, data-folder reads that never take its checkout's origin",
  "packages/settings/src/rendered.ts":
    "its own tree: coreDir() is extensions/core, whose lists ship with each version",
  "scripts/hooks/no-chat-question.ts":
    "unreached: its dashboard read runs on a Stop input's last_assistant_message, which no Bash call the differential passes carries, and its PreToolUse path judges AskUserQuestion alone",
  "scripts/hooks/no-extensions-write.ts":
    "its own tree: the worker module it loads is its own code",
  "scripts/hooks/no-main-checkout.ts":
    "pinned: on TAKES_MAIN, so check() takes the head's main checkout",
  "scripts/hooks/no-playground-leak.ts":
    "its own tree: skillNames() lists the tracked skills/playground, which ships with each version",
  "scripts/hooks/no-raw-spawn.ts": "verdict-free: spawn.sh's path is only in the refusal text",
  "scripts/hooks/no-unslotted-run.ts":
    "pinned: on TAKES_MAIN, so check() takes the head's main checkout",
  "scripts/hooks/role.ts":
    "its own tree: setting.ts reads the data folder both sides share, and roster-statuses.json ships with each version",
  "scripts/hooks/session-state.ts":
    "unreached: it exports no check() for the differential to load; its own path only spawns its report",
}

// The run-slot call a bare start becomes, or the argv itself inside a ticket (whose child carries the RUN_SLOT_NICE run-slot exports) or with no executable run-slot.sh
export const routed = ({
  argv,
  cwd,
  env,
  executable,
  home,
}: {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  executable: (path: string) => boolean
  home: string
}): string[] => {
  const runSlot = `${home}/.playground/ops/run-slot.sh`
  if (env.RUN_SLOT_NICE !== undefined || !executable(runSlot)) return argv
  const folder = /\/\.claude\/worktrees\/([^/]+)/.exec(cwd)?.[1] ?? "main"
  return [runSlot, `hooks-${folder.replace(/[^A-Za-z0-9._#-]/g, "-")}`, "--", ...argv]
}

// The folders each sweep form is checked from: the home, the data folder and a worktree
export const cwdsOf = (home: string) => [
  home,
  join(home, ".playground"),
  join(home, "x", ".claude", "worktrees", "y"),
]

// PLAYGROUND_REPO set to the head's main checkout while both sides run, so mainCheckout() on canary's side reads it rather than its own unpacked folder; the caller's value is put back after
async function pinned<T>(repo: string | undefined, run: () => Promise<T>): Promise<T> {
  if (repo === undefined) return run()
  const was = process.env.PLAYGROUND_REPO
  process.env.PLAYGROUND_REPO = repo
  try {
    return await run()
  } finally {
    if (was === undefined) delete process.env.PLAYGROUND_REPO
    else process.env.PLAYGROUND_REPO = was
  }
}

// The env a call reaches check() under: the home and PATH alone unless the run gives more (envOf, below); main undefined leaves a hook's own default in place, as a call with no third argument does
const allows = (check: Check, call: Call, env: Env, main?: string, repo?: string) =>
  pinned(
    repo,
    async () =>
      (await check(
        JSON.stringify({
          cwd: call.cwd,
          hook_event_name: "PreToolUse",
          ...(call.session === undefined ? {} : { session_id: call.session }),
          tool_input: { command: call.command },
          tool_name: "Bash",
        }),
        env,
        main,
      )) === undefined,
  )

const bare = (home: string) => (): Env => ({ HOME: home, PATH: process.env.PATH })

// Each call's env: the home, PATH and the scratch data folder; PLAYGROUND_ROLE set to --role's role, or with --role session to the role the roster gives the call's session by its transcript name, its session named in a scratch registry (CLAUDE_CONFIG_DIR); a name the roster lacks keeps the default, PLAYGROUND_ROLE unset, where a hook places the session by its name itself
export const envOf =
  ({
    config,
    data,
    home,
    role,
    roles,
  }: {
    config?: string
    data: string
    home: string
    role?: string
    roles?: Map<string, string>
  }) =>
  (call: Call): Env => {
    const own = role === "session" ? roles?.get(call.name ?? "") || undefined : role
    return {
      ...(config === undefined ? {} : { CLAUDE_CONFIG_DIR: config }),
      HOME: home,
      PATH: process.env.PATH,
      PLAYGROUND_DATA_DIR: data,
      ...(own === undefined ? {} : { PLAYGROUND_ROLE: own }),
    }
  }

// The data folder's entries a check() writes, writing-first's marks, and the roster the run reads roles from, copied into the scratch folder; every other entry is linked
export const COPIED = ["roster.json", "writing-first"]

// A data folder of the run's own, so a check()'s write lands there while every read and protected path resolves to the real data folder's entry through its link
export function scratchData(real: string, base = tmpdir()): string {
  const data = mkdtempSync(join(base, "hook-differential-data-"))
  for (const entry of existsSync(real) ? readdirSync(real) : [])
    if (COPIED.includes(entry)) cpSync(join(real, entry), join(data, entry), { recursive: true })
    else symlinkSync(join(real, entry), join(data, entry))
  return data
}

// The config entries a hook reads besides the registry, linked from the real config folder: writing-first's installed skill and plugins
const CONFIG_LINKS = ["plugins", "settings.json", "skills"]

// The role the roster's kind gives each transcript name, from the real data folder, and a scratch registry naming each named session, for --role session
export async function sessionRoles(list: Call[], real: Env, base = tmpdir()) {
  const config = mkdtempSync(join(base, "hook-differential-config-"))
  mkdirSync(join(config, "sessions"))
  const own = real.CLAUDE_CONFIG_DIR || join(real.HOME || homedir(), ".claude")
  for (const entry of CONFIG_LINKS)
    if (existsSync(join(own, entry))) symlinkSync(join(own, entry), join(config, entry))
  const roles = new Map<string, string>()
  for (const { name, session } of list) {
    if (!name) continue
    if (!roles.has(name)) roles.set(name, await rosterRole(name, real))
    if (session)
      writeFileSync(
        join(config, "sessions", `${session}.json`),
        JSON.stringify({ name, sessionId: session }),
      )
  }
  return { config, roles }
}

// Each form from each folder through both hooks: the same, newly allowed and newly refused, each split by the form's class (a form with no class is outside it)
export async function sweep(
  canary: Check,
  head: Check,
  forms: Form[],
  home: string,
  main?: string,
  repo?: string,
  env: (call: Call) => Env = bare(home),
) {
  const counts = {
    cases: 0,
    forms: forms.length,
    "newly allowed": { inClass: 0, outClass: 0 } as Tally,
    "newly refused": { inClass: 0, outClass: 0 } as Tally,
    same: 0,
  }
  const changed: string[] = []
  for (const { command, inClass } of forms)
    for (const cwd of cwdsOf(home)) {
      counts.cases++
      const own = env({ command, cwd })
      const [was, now] = [
        await allows(canary, { command, cwd }, own, main, repo),
        await allows(head, { command, cwd }, own, main, repo),
      ]
      if (was === now) {
        counts.same++
        continue
      }
      counts[now ? "newly allowed" : "newly refused"][inClass ? "inClass" : "outClass"]++
      if (!now || !inClass) changed.push(`${now ? "allowed" : "refused"} ${cwd} :: ${command}`)
    }
  return { changed, counts }
}

// Every Bash call of the transcripts under `projects` newer than `since`, a sub-agent's nested ones included, one per folder and command; bySession keeps one per session, folder and command, each with its session and the name its transcript's agent-name lines last gave it
export async function calls(projects: string, since: number, bySession = false): Promise<Call[]> {
  const found = new Map<string, Call>()
  const names = new Map<string, string>()
  const files = existsSync(projects) ? readdirSync(projects, { recursive: true }) : []
  for (const file of files.map(String).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(projects, file)
    if (statSync(path).mtimeMs < since) continue
    for (const line of (await Bun.file(path).text()).split("\n")) {
      const named = bySession && line.includes('"agent-name"')
      if (!line.includes('"Bash"') && !named) continue
      let entry: {
        agentName?: unknown
        cwd?: unknown
        message?: { content?: unknown }
        sessionId?: unknown
        timestamp?: string
        type?: unknown
      }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const session = typeof entry.sessionId === "string" ? entry.sessionId : undefined
      if (named && entry.type === "agent-name" && session && typeof entry.agentName === "string") {
        names.set(session, entry.agentName)
        continue
      }
      if (Date.parse(entry.timestamp ?? "") < since || typeof entry.cwd !== "string") continue
      const content = Array.isArray(entry.message?.content) ? entry.message.content : []
      for (const part of content as {
        input?: { command?: unknown }
        name?: string
        type?: string
      }[])
        if (
          part?.type === "tool_use" &&
          part.name === "Bash" &&
          typeof part.input?.command === "string"
        )
          found.set(`${bySession ? session : ""}\0${entry.cwd}\0${part.input.command}`, {
            command: part.input.command,
            cwd: entry.cwd,
            ...(bySession ? { session } : {}),
          })
    }
  }
  const list = [...found.values()]
  for (const call of list)
    if (call.session && names.has(call.session)) call.name = names.get(call.session)
  return list
}

// Each call from its own folder through both hooks: the same, newly allowed and newly refused
export async function replay(
  canary: Check,
  head: Check,
  list: Call[],
  home: string,
  main?: string,
  repo?: string,
  env: (call: Call) => Env = bare(home),
) {
  const counts = { calls: list.length, "newly allowed": 0, "newly refused": 0, same: 0 }
  const changed: string[] = []
  for (const call of list) {
    const own = env(call)
    const [was, now] = [
      await allows(canary, call, own, main, repo),
      await allows(head, call, own, main, repo),
    ]
    if (was === now) counts.same++
    else {
      counts[now ? "newly allowed" : "newly refused"]++
      changed.push(`${now ? "allowed" : "refused"} ${call.cwd} :: ${call.command.slice(0, 300)}`)
    }
  }
  return { changed, counts }
}

const git = (cwd: string, args: string[]) => {
  const run = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString().trim()}`)
  return run.stdout.toString().trim()
}

// canary's whole tree at the sha, installed from its own lockfile with no install scripts in a folder of its own, then renamed to `base/<sha>`, so its hooks load canary's packages, extensions/core and dependencies, never the head's, and two runs against one sha never install into the same folder
export function canaryTree({
  base,
  root,
  run,
  sha,
}: {
  base: string
  root: string
  run: (argv: string[], cwd: string, stdin?: Uint8Array) => { exitCode: number; stdout: Uint8Array }
  sha: string
}): string {
  const dir = join(base, sha)
  if (existsSync(join(dir, ".installed"))) return dir
  mkdirSync(base, { recursive: true })
  const build = mkdtempSync(join(base, `${sha}.`))
  const archive = run(["git", "archive", sha], root)
  if (
    archive.exitCode !== 0 ||
    run(["tar", "-x", "-C", build], build, archive.stdout).exitCode !== 0
  )
    throw new Error(`could not unpack ${sha}`)
  if (run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], build).exitCode !== 0)
    throw new Error(`could not install ${sha}'s dependencies in ${build}`)
  writeFileSync(join(build, ".installed"), "")
  try {
    renameSync(build, dir)
  } catch (error) {
    if (!existsSync(join(dir, ".installed"))) throw error
  }
  return dir
}

const option = (args: string[], name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

type Options = {
  all: boolean
  formsAt?: string
  fresh: boolean
  hooks: string[]
  hours: number
  mode: "replay" | "sweep"
  ref: string
  role?: string
}

const SHOWN = 20

// The changed lines a hook prints and stores, each led by the hook's name: the first 20, then one line naming how many more it cut, or every one with --all
export const linesOf = (hook: string, changed: string[], all: boolean): string[] => [
  ...(all ? changed : changed.slice(0, SHOWN)).map((line) => `${hook}: ${line}`),
  ...(!all && changed.length > SHOWN
    ? [`${hook}: ${changed.length - SHOWN} more changed lines not shown (--all prints them)`]
    : []),
]

export function parse(args: string[]): Options | undefined {
  const [mode] = args
  const ref = option(args, "--canary")
  const hooks = args.flatMap((a, i) => (args[i - 1] === "--hook" ? [a] : []))
  const formsAt = option(args, "--forms")
  const hours = Number(option(args, "--hours") ?? 24)
  const role = option(args, "--role")
  if (
    (mode !== "sweep" && mode !== "replay") ||
    !ref ||
    hooks.length === 0 ||
    (mode === "sweep" && !formsAt) ||
    !(hours > 0) ||
    (args.includes("--role") && (!role || role.startsWith("-"))) ||
    (mode === "sweep" && role === "session")
  )
    return undefined
  return {
    all: args.includes("--all"),
    formsAt,
    fresh: args.includes("--fresh"),
    hooks,
    hours,
    mode,
    ref,
    role,
  }
}

// The newest mtime of the transcripts under `projects`, so a replay's key moves with each new call
const newest = (projects: string) =>
  existsSync(projects)
    ? Math.max(
        0,
        ...readdirSync(projects, { recursive: true })
          .map(String)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => statSync(join(projects, f)).mtimeMs),
      )
    : 0

type Key = { canary: string; head: string; input: string; key: string }

// The head's tree when the worktree has no modified or untracked file
const cleanTree = (root: string) =>
  git(root, ["status", "--porcelain", "--untracked-files=all"]) === ""
    ? git(root, ["rev-parse", "HEAD^{tree}"])
    : undefined

const formsBlob = (root: string, options: Options) =>
  git(root, ["hash-object", resolve(options.formsAt!)])

// A run's key: the head's tree at a clean worktree, the canary sha, the mode with its inputs (the forms module's blob, or the hours and the newest transcript), the sorted hooks, --all and --role; a worktree with any modified or untracked file has none
export function keyOf({
  canary,
  options,
  projects,
  root,
}: {
  canary: string
  options: Options
  projects: string
  root: string
}): Key | undefined {
  const head = cleanTree(root)
  if (!head) return undefined
  const input =
    options.mode === "sweep" ? formsBlob(root, options) : `${options.hours}:${newest(projects)}`
  const key = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        head,
        canary,
        options.mode,
        input,
        options.hooks.toSorted(),
        options.all,
        options.role ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16)
  return { canary, head, input, key }
}

// Whether the worktree is still clean at the key's tree, and a sweep's forms module still the key's blob, so a run whose inputs moved under it stores nothing
export const unmoved = (root: string, found: Key, options: Options) =>
  cleanTree(root) === found.head &&
  (options.mode !== "sweep" || formsBlob(root, options) === found.input)

type Result = { at: string; canary: string; changed: string[]; counts: string[]; head: string }

export const resultPath = (data: string, key: string) =>
  join(data, "hook-differential", "results", `${key}.json`)

// The result stored under the key, while it is under a day old
export async function stored(
  data: string,
  key: string,
  now = Date.now(),
): Promise<Result | undefined> {
  const file = Bun.file(resultPath(data, key))
  if (!(await file.exists())) return undefined
  const result: Result = await file.json()
  return now - Date.parse(result.at) < DAY ? result : undefined
}

export async function store(
  data: string,
  { canary, head, key }: Key,
  result: Pick<Result, "changed" | "counts">,
) {
  await Bun.write(
    resultPath(data, key),
    JSON.stringify({ at: new Date().toISOString(), canary, head, ...result }),
  )
}

const projectsOf = (env: Record<string, string | undefined>, home: string) =>
  join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")

const commitOf = (root: string, ref: string) =>
  git(root, ["rev-parse", "--verify", `${ref}^{commit}`])

// The stored result a run with these options would reproduce, printed under its `reused:` line; false when it runs fresh
export async function reuse(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const options = parse(args)
  if (!options || options.fresh) return false
  const home = env.HOME || homedir()
  let found: Key | undefined
  let result: Result | undefined
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"])
    const canary = commitOf(root, options.ref)
    found = keyOf({ canary, options, projects: projectsOf(env, home), root })
    result = found && (await stored(dataDirOf(env, home), found.key))
  } catch {
    return false
  }
  if (!found || !result) return false
  console.log(
    `reused: ${found.key} from ${result.at}, head ${result.head}, canary ${result.canary}`,
  )
  for (const line of result.counts) console.log(line)
  for (const line of result.changed) console.error(line)
  return true
}

async function main(args: string[]): Promise<number> {
  const options = parse(args)
  if (!options) {
    console.error(USAGE)
    return 2
  }
  const { formsAt, hooks, hours, mode, ref, role } = options
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])
  const missing = hooks.filter((h) => !existsSync(join(root, "scripts/hooks", `${h}.ts`)))
  if (missing.length > 0) {
    console.error(`hook-differential: no hook named ${missing.join(", ")} in scripts/hooks`)
    return 2
  }
  const home = process.env.HOME || homedir()
  const sha = commitOf(root, ref)
  const projects = projectsOf(process.env, home)
  const found = keyOf({ canary: sha, options, projects, root })
  const forms: Form[] = formsAt ? (await import(resolve(formsAt))).forms : []
  if (mode === "sweep" && !Array.isArray(forms)) {
    console.error(`hook-differential: the --forms module exports no forms array\n${USAGE}`)
    return 2
  }
  const before = canaryTree({
    base: join(tmpdir(), "hook-differential"),
    root,
    run: (argv, cwd, stdin) =>
      Bun.spawnSync(argv, { cwd, stderr: "inherit", stdin, stdout: "pipe" }),
    sha,
  })
  const list =
    mode === "replay"
      ? await calls(projects, Date.now() - hours * 3600 * 1000, role === "session")
      : []
  const real = dataDirOf(process.env, home)
  const session =
    role === "session" ? await sessionRoles(list, { ...process.env, HOME: home }) : undefined
  const env = envOf({ ...session, data: scratchData(real), home, role })
  const defaulted = session
    ? { "default role": list.filter((c) => !session.roles.get(c.name ?? "")).length }
    : {}
  const headMain = dirname(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  const result = { changed: [] as string[], counts: [] as string[] }
  for (const hook of hooks) {
    const own = join(before, "scripts/hooks", `${hook}.ts`)
    const absent = !existsSync(own)
    // A hook canary lacks is measured against a baseline that allows every call, so each refusal it makes counts as newly refused
    const canary: Check = absent ? () => undefined : (await import(own)).check
    const head: Check = (await import(join(root, "scripts/hooks", `${hook}.ts`))).check
    const main = TAKES_MAIN.includes(hook) ? headMain : undefined
    const { changed, counts } =
      mode === "sweep"
        ? await sweep(canary, head, forms, home, main, headMain, env)
        : await replay(canary, head, list, home, main, headMain, env)
    const baseline = absent ? { baseline: "allow-all: canary has no such hook" } : {}
    result.counts.push(
      JSON.stringify({ hook, ...baseline, ...(role ? { role } : {}), ...defaulted, ...counts }),
    )
    console.log(result.counts.at(-1))
    for (const line of linesOf(hook, changed, options.all)) {
      result.changed.push(line)
      console.error(line)
    }
  }
  if (found && unmoved(root, found, options))
    await store(dataDirOf(process.env, home), found, result)
  return 0
}

if (import.meta.main) {
  if (await reuse(process.argv.slice(2), process.cwd(), process.env)) process.exit(0)
  const home = process.env.HOME || homedir()
  const argv = routed({
    argv: ["bun", import.meta.path, ...process.argv.slice(2)],
    cwd: process.cwd(),
    env: process.env,
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    home,
  })
  if (argv[0] === "bun") process.exit(await main(process.argv.slice(2)))
  const room = Bun.spawnSync([argv[0]!, "room"], {
    stderr: "ignore",
    stdout: "pipe",
    timeout: 10_000,
  })
  const waiting =
    (room.exitCode === 0 && /^\d+ \d+ \d+ (\d+)$/.exec(room.stdout.toString().trim())?.[1]) || "?"
  console.error(`hook-differential: queued through run-slot behind ${waiting} waiting`)
  process.exit(await Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] }).exited)
}
