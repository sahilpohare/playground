// PreToolUse hook: refuses a worktree install, node_modules clone, build, type check or whole suite outside run-slot, since five worktree installs at once drove load1 to 66.8 on 18 Oct, a docker build from any folder, since one fills the Docker VM the live dashboard's Postgres shares, and a git commit whose message commitlint refuses, since commit-msg finds it only after pre-commit's slot wait.
import { existsSync, mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

import { atOnce, buildName, DOCKERS, dockerBuild, portlessCompose } from "./docker-build"
import {
  bunCall,
  cwdFlag,
  mainCheckout,
  packagedTools,
  real,
  RUNNER_TAKES,
  ranIn,
  runnerFolders,
  toolName,
  turboWords,
  unreadFolder,
  withChained,
  X,
} from "./no-main-checkout"
import { fromFactory } from "./role"
import {
  ASSIGN,
  type Command,
  type Env,
  examine,
  GIT_TAKES,
  knownVariables,
  lex,
  parse,
  parseFlags,
  pathOf,
  places,
  program,
  readPath,
  resolveText,
  run,
  slotWords,
  stdinOf,
  type Text,
  unreadable,
  visible,
  type Visit,
  type Word,
} from "./shell"

const refuse = (what: string, cd: string, command: string) =>
  `no-unslotted-run hook refuses ${what} in a worktree outside run-slot: every heavy run goes through it (playbook's **slots**), so the machine runs a few at a time. Run it as ${cd}~/.playground/ops/run-slot.sh <your name> -- ${command}`

// A docker build fills the one Docker VM every folder shares, the live dashboard's Postgres included, so it goes through run-slot from any folder, one at a time.
const refuseDocker = (what: string, cd: string, command: string, fix?: string) =>
  fix
    ? `no-unslotted-run hook refuses ${what} from any folder, which run-slot refuses too: ${fix}`
    : `no-unslotted-run hook refuses ${what} outside run-slot, from any folder: a build fills the Docker VM the live dashboard's Postgres shares (6 Nov: a parallel compose build got it killed), so run-slot runs one docker build at a time, a compose build one service at a time. Run it as ${cd}~/.playground/ops/run-slot.sh <your name> -- ${command}`

// git commit's options that take a value, so a word after one reads as git reads it
const COMMIT_TAKES = new Set([
  "--author",
  "-c",
  "-C",
  "--cleanup",
  "--date",
  "-F",
  "--file",
  "--fixup",
  "-m",
  "--message",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "-t",
  "--template",
  "--trailer",
])
// The options that take the message from another commit, whose text the hook does not read
const REUSED = new Set(["-c", "-C", "--fixup", "--reedit-message", "--reuse-message", "--squash"])
// commitlint's run is cut off past this, well inside the hook's 15 s timeout, and the commit then runs as before
const LINT_BUDGET = 8000

// git subcommands that write no file a later commit's message could be read from, unless a redirect writes one
const NO_WRITE = new Set(["add", "diff", "fetch", "log", "show", "status"])
// The shell's own commands that write no file, which a later commit's message file stays clear of
const QUIET = new Set([":", "cd", "export", "popd", "pushd", "set", "true", "unset"])
// Whether a command may write a file, which a later commit on the line may read its message from; cat writes none but by a redirect, so a commit's own $(cat …) read counts as no writer
const mayWrite = (cmd: Command, name: string, args: Word[]) =>
  cmd.redirects.some((r) => r.op.includes(">")) ||
  (name !== "cat" &&
    !QUIET.has(name) &&
    (name !== "git" || !NO_WRITE.has(args.find((a) => !a.value.startsWith("-"))?.value ?? "")))

// The message of a git commit as commit-msg would get it: its -m values joined as paragraphs, or the file or stdin -F names; undefined when the commit skips commit-msg, opens an editor, reuses another commit's message, holds a message the hook cannot read, or reads it from a file an earlier command on the line may have written.
async function message(
  cmd: Command,
  rest: Word[],
  env: Env,
  wrote: boolean,
): Promise<string | undefined> {
  const { flags } = parseFlags(rest, COMMIT_TAKES)
  const last = (names: string[]) => flags.findLast((f) => names.includes(f.name))?.name
  if (["-n", "--no-verify"].includes(last(["-n", "--no-verify", "--verify"]) ?? "")) return
  if (["-e", "--edit"].includes(last(["-e", "--edit", "--no-edit"]) ?? "")) return
  if (flags.some((f) => REUSED.has(f.name))) return
  const notes = flags.filter((f) => f.name === "-m" || f.name === "--message")
  const files = flags.filter((f) => f.name === "-F" || f.name === "--file")
  // git refuses -m beside -F itself
  if (notes.length > 0 === files.length > 0) return
  const texts: Text[] = []
  for (const { value } of [...notes, ...files.slice(-1)]) {
    if (!value) return
    // a heredoc or here-string is the line's own text, while a file, a pipe or a $(cat …) read is what is on disk when git runs
    const literal = files.length
      ? value.value === "-" &&
        !cmd.stdin &&
        Boolean(cmd.redirects.findLast((r) => r.op.startsWith("<"))?.op.startsWith("<<"))
      : !value.reads?.length
    if (wrote && !literal) return
    const text = files.length
      ? value.value === "-" && !value.unknown
        ? await stdinOf(cmd, env)
        : await readPath(value, env)
      : await resolveText(value, env)
    if (unreadable(text)) return
    texts.push(text)
  }
  return texts.map((t) => t.value).join("\n\n")
}

// A git commit's message linted by its checkout's own commitlint, which reads the checkout's config; the refusal with commitlint's problem lines, or undefined when the hook cannot read the message, the checkout holds no commitlint, or the lint passes or runs past its budget.
async function commitLint(
  cmd: Command,
  args: Word[],
  env: Env,
  wrote: boolean,
): Promise<string | undefined> {
  let dir = env.cwd
  let k = 0
  for (; k < args.length; k++) {
    const v = args[k].value
    if (v === "-C") {
      const next = args[++k]
      dir = next ? pathOf(next, { ...env, cwd: dir }) : undefined
    } else if (GIT_TAKES.has(v)) k++
    else if (!v.startsWith("-")) break
  }
  if (args[k]?.value !== "commit" || !dir) return
  const text = await message(cmd, args.slice(k + 1), { ...env, cwd: dir }, wrote)
  if (text === undefined) return
  const top = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stderr: "ignore",
  })
  const root = top.success ? top.stdout.toString().trim() : ""
  const lint = join(root, "node_modules", ".bin", "commitlint")
  if (!root || !existsSync(lint)) return
  // commit-msg runs commitlint --edit on git's message file, which reads a # line as a comment, so the message is linted from a file the same way
  const folder = mkdtempSync(join(tmpdir(), "commit-msg-"))
  const file = join(folder, "COMMIT_EDITMSG")
  let out = ""
  let err = ""
  let code: number
  let signal: unknown
  try {
    await Bun.write(file, text)
    const proc = Bun.spawn([process.execPath, lint, "--edit", file], {
      cwd: root,
      env: env.process,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      timeout: LINT_BUDGET,
    })
    ;[out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    signal = proc.signalCode
  } finally {
    rmSync(file, { force: true })
    rmdirSync(folder)
  }
  if (code === 0 || signal) return
  const problems = `${out}\n${err}`.split("\n").filter((l) => /^\s*[✖⚠]/.test(l))
  if (problems.length === 0) return
  return `no-unslotted-run hook refuses this git commit: commitlint, which commit-msg runs only after pre-commit's build has waited for its slot, refuses its message:\n${problems.join("\n")}\nFix the message by the gh-commit skill's Commit step, then commit again.`
}

// A line that names more folders than the reader carries (`Env.cwdAnywhere` in shell.ts) may run in any folder, a worktree included, so a heavy run on it goes through run-slot too.
const anywhere = (what: string, command: string) =>
  `no-unslotted-run hook refuses ${what} on a line that names more folders than the hook carries, since it cannot rule out a worktree: every heavy run goes through run-slot (playbook's **slots**). Run it as ~/.playground/ops/run-slot.sh <your name> -- ${command}, or as a line of its own after a cd to a literal path.`

// bun scripts that build packages/* or run the whole suite
const BUN_SCRIPTS = new Set(["build", "check-types", "test"])
const RUNNERS = new Set(["bunx", "npx"])
// bun test's options, and bun's runtime ones it also takes, whose next word is their value (bun test --help, bun --help), so it is no test file; --bail, -c, --changed, --config, --elide-lines, --inspect, --parallel and --shell take theirs only attached
const TEST_TAKES = new Set([
  "--conditions",
  "--console-depth",
  "--coverage-dir",
  "--coverage-reporter",
  "--define",
  "--disable-warning",
  "--dns-result-order",
  "--drop",
  "--env-file",
  "--extension-order",
  "--feature",
  "--fetch-preconnect",
  "--import",
  "--install",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--loader",
  "--main-fields",
  "--max-concurrency",
  "--max-http-header-size",
  "--parallel-delay",
  "--path-ignore-patterns",
  "--port",
  "--preload",
  "--redirect-warnings",
  "--reporter",
  "--reporter-outfile",
  "--require",
  "--rerun-each",
  "--retry",
  "--seed",
  "--shard",
  "--test-name-pattern",
  "--timeout",
  "--timings",
  "--title",
  "--tsconfig-override",
  "--unhandled-rejections",
  "--user-agent",
  "-d",
  "-l",
  "-r",
  "-t",
])

// turbo's tasks that build, type-check, test or lint, and the words that make a turbo call run none
const TURBO_TASKS = new Set(["build", "check-types", "lint", "test"])
const TURBO_LIGHT = /^(?:--help|-h|--version|--dry(?:-run)?(?:=.*)?)$/

// A program's words as the shell reads each one as a line, its quotes removed and its redirects dropped, so a script word (sh -c '<script>') shows the words of every command in it
const lineWords = (values: string[]) =>
  values.flatMap((v) => lex(v).commands.flatMap((c) => c.words.map((w) => w.value)))

// Whether a program a runner's -p puts next beside (sh -c '<script>', env) runs next build among its words.
const nextBuild = (values: string[]) =>
  lineWords(values).some((v, k, all) => program(v) === "next" && all[k + 1] === "build")

// The folder next build builds, its first word that is no option, read from the folder it runs in
const nextDir = (args: Word[], env: Env) => {
  const dir = args.find((a) => !a.value.startsWith("-"))
  return dir ? [pathOf(dir, env)] : []
}

// The heavy task a turbo call runs, as `turbo run <task>` or turbo's own `turbo <task>`, or undefined.
function turboTask(words: Word[]): string | undefined {
  const values = words.map((w) => w.value)
  // a program a runner's -p puts turbo beside (sh -c '<script>', env) may run turbo from any of its words, so each word's own words count, and a light turbo call among them makes no other light
  const beside =
    values[0] !== undefined &&
    !values[0].startsWith("-") &&
    values[0] !== "run" &&
    !TURBO_TASKS.has(values[0])
  if (!beside && values.some((v) => TURBO_LIGHT.test(v))) return
  const tasks = (beside ? lineWords(values) : values).filter((v) => v !== "" && !v.startsWith("-"))
  return (tasks[0] === "run" ? tasks.slice(1) : tasks).find((t) => TURBO_TASKS.has(t))
}

const recursive = (args: Word[]) =>
  args.some(
    (a) => /^-[a-zA-Z]*[Rra]/.test(a.value) || ["--archive", "--recursive"].includes(a.value),
  )

// What of the command is a heavy run, and the directory it runs in or writes to, or undefined.
function heavy(
  name: string,
  args: Word[],
  env: Env,
):
  | {
      also?: (string | undefined)[]
      anywhere?: true
      dir: string | undefined
      fix?: string
      what: string
    }
  | undefined {
  const compose = portlessCompose(name, args)
  if (DOCKERS.has(name) || compose) {
    const build = compose
      ? dockerBuild(compose, true)
      : dockerBuild(args, name === "docker-compose")
    return build && { anywhere: true, dir: env.cwd, fix: atOnce(build), what: buildName(build) }
  }
  if (name === "cp") {
    const paths = args.filter((a) => !a.value.startsWith("-"))
    const from = paths.slice(0, -1)
    if (
      recursive(args) &&
      from.some((a) => program(a.value.replace(/\/+$/, "")) === "node_modules")
    )
      return {
        dir: paths.at(-1) && pathOf(paths.at(-1) as Word, env),
        what: "a node_modules clone",
      }
    return
  }
  if (name === "next")
    return args[0]?.value === "build"
      ? { also: nextDir(args.slice(1), env), dir: env.cwd, what: "next build" }
      : undefined
  // turbo by name, path or versioned package, through bunx, npx or bun x past their options, read as no-main-checkout reads it
  const turbo = turboWords(name, args, env)
  if (turbo) {
    const task = turboTask(turbo)
    return task
      ? {
          also: runnerFolders(name, args, env, turbo),
          dir: cwdFlag(turbo, env),
          what: `turbo run ${task}`,
        }
      : undefined
  }
  if (RUNNERS.has(name)) {
    const words = args.filter(
      (a, k) => !a.value.startsWith("-") && !RUNNER_TAKES.has(args[k - 1]?.value ?? ""),
    )
    const values = words.map((w) => w.value)
    const base = name === "bunx" ? bunCall([X, ...args], env).chained : env.cwd
    if (program(values[0] ?? "") === "next" && values[1] === "build")
      return {
        also: [
          ...(runnerFolders(name, args, env, []) ?? []),
          ...nextDir(words.slice(2), { ...env, cwd: base }),
        ],
        dir: env.cwd,
        what: `${name} next build`,
      }
    if (packagedTools(args).includes("next") && nextBuild(values))
      return { also: runnerFolders(name, args, env, []), dir: env.cwd, what: `${name} next build` }
    return name === "bunx" ? heavy("bun", [X, ...args], env) : undefined
  }
  if (name !== "bun") return
  const { at, chained, cwd, filtered, sub, words } = bunCall(args, env)
  const rest = args.slice(at + 1)
  if (words[0] === "install" || words[0] === "i") {
    if (rest.some((a) => ["--dry-run", "--help", "-h"].includes(a.value))) return
    return { dir: cwdFlag(rest, { ...env, cwd }), what: "bun install" }
  }
  if (words[0] === "x" && program(words[1] ?? "") === "next" && rest[0]?.value === "build")
    return {
      also: [
        ...(runnerFolders(name, args, env, []) ?? []),
        ...nextDir(rest.slice(1), { ...env, cwd: chained }),
      ],
      dir: cwd,
      what: "bun x next build",
    }
  if (
    words[0] === "x" &&
    packagedTools(args.slice(sub + 1)).includes("next") &&
    nextBuild([words[1] ?? "", ...rest.map((a) => a.value)])
  )
    return { also: runnerFolders(name, args, env, []), dir: cwd, what: "bun x next build" }
  // bun x runs any program in the folder its --cwd options chain to, so that program is read as the shell would read it there
  if (words[0] === "x" && words[1] && args[at]?.value === words[1]) {
    const ran = heavy(toolName(words[1]), rest, {
      ...env,
      cwd: chained,
    })
    if (ran) {
      return { ...ran, also: withChained(ran.also, chained), what: `bun x ${ran.what}` }
    }
  }
  // bun run test:file passes its words to bun test, and with no file runs the whole suite as bun test does
  const testFile = words[0] === "run" && words[1] === "test:file"
  if (words[0] === "test" || testFile) {
    if (rest.some((a) => a.value === "--help" || a.value === "-h")) return
    let files = 0
    for (let k = 0; k < rest.length; k++) {
      if (TEST_TAKES.has(rest[k].value) || rest[k].value === "--cwd") k++
      else if (!rest[k].value.startsWith("-")) files++
    }
    if (files > 0) return
    return testFile
      ? { dir: cwd, what: "bun run test:file" }
      : { dir: cwdFlag(rest, { ...env, cwd }), what: "bun test" }
  }
  const target = words[0] === "run" ? words[1] : words[0]
  // bare, build is bun's own bundler unless a --filter names the packages whose script it runs
  if (target && BUN_SCRIPTS.has(target) && (words[0] === "run" || filtered || target !== "build"))
    return { dir: cwd, what: `bun ${words.join(" ")}` }
}

// A word as the fix shows it: a value the reader could not read as a space, and a quoted one in single quotes.
const shown = (word: Word) => {
  const value = visible(word.value)
  return word.quoted ? `'${value.replaceAll("'", "'\\''")}'` : value
}

// A directory as the fix shows it, in single quotes unless it is plain.
const quotedDir = (dir: string) =>
  /^[\w@%+=:,./~-]+$/.test(dir) ? dir : `'${dir.replaceAll("'", "'\\''")}'`

function inspect(raw: string, environment: Record<string, string | undefined>, main: string) {
  const { cwd, tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as Record<string, unknown>
  if (tool !== "Bash") return
  const command = (toolInput as { command?: unknown } | null)?.command
  if (typeof command !== "string") return
  const worktrees = [
    join(main, ".claude", "worktrees"),
    real(join(main, ".claude", "worktrees")),
  ].map((w) => w + sep)
  // a link into a worktree runs its build there, so the path is judged as written and with its links followed
  const inWorktree = (dir: string | undefined) =>
    dir !== undefined &&
    [resolve(dir), real(resolve(dir))].some((d) => worktrees.some((w) => d.startsWith(w)))
  const directory = typeof cwd === "string" ? cwd : undefined
  // the line's own commands, set once it is read below
  let line: Command[] = []
  // whether an earlier command on the line may have written a file a commit reads its message from: each one visited, and each of the line's own commands before it, since a shell or source that runs a script file is followed without a visit
  let wrote = false
  let outer: Command | undefined
  const before = (cmd: Command) => {
    const at = line.indexOf(line.includes(cmd) ? cmd : (outer ?? cmd))
    return line.slice(0, Math.max(at, 0)).some((earlier) => {
      const { args, name } = parse(earlier)
      return mayWrite(earlier, name, args)
    })
  }
  // a commit run-slot queues waits for its slot all the same, so its message is linted there too
  const commits: Visit = async (cmd, { args, name }, env) => {
    const refused =
      name === "git" ? await commitLint(cmd, args, env, wrote || before(cmd)) : undefined
    wrote ||= mayWrite(cmd, name, args)
    return refused
  }
  const visit: Visit = async (cmd, parsed, env) => {
    const { args, first, name } = parsed
    const slot = slotWords(parsed)
    // run-slot.sh queues the words after its -- as one heavy run, in a process of its own, so a cd among them moves no folder for the commands after it
    outer = cmd
    if (slot)
      return slot.length
        ? examine(
            { ...cmd, words: slot },
            { ...env, files: new Map(env.files), vars: new Map(env.vars) },
            commits,
            false,
          )
        : undefined
    const refused = await commits(cmd, parsed, env)
    if (refused) return refused
    const words = () => {
      const at = first ? cmd.words.indexOf(first) : -1
      if (at < 0) return undefined
      const assigns = cmd.words.slice(0, at).filter((w) => ASSIGN.test(w.value))
      return [
        ...(assigns.length ? ["env", ...assigns.map(shown)] : []),
        ...cmd.words.slice(at).map(shown),
      ].join(" ")
    }
    // a line that names more folders than the reader carries may run in a worktree, whatever folder it started in
    if (env.cwdAnywhere) {
      const found = heavy(name, args, { ...env, cwd: undefined })
      const line = words()
      if (found?.anywhere && line !== undefined)
        return refuseDocker(found.what, "", line, found.fix)
      if (
        found &&
        line !== undefined &&
        ranIn(found.dir, found.also).some((dir) => dir === undefined || inWorktree(dir))
      )
        return anywhere(found.what, line)
    }
    // every folder the shell may be in, so a heavy run after a cd the reader cannot be sure of is caught wherever that cd may have left it
    for (const here of places(env)) {
      const found = heavy(name, args, here)
      if (
        !found ||
        !(
          found.anywhere ||
          unreadFolder(found.also) ||
          ranIn(found.dir, found.also).some(inWorktree)
        )
      )
        continue
      // run-slot execs the first word after its --, so the fix keeps the program, its words and every assignment before it behind env, and drops every wrapper (exec, timeout, env's own options)
      const line = words()
      if (line === undefined) return
      // a cd earlier in the command moved the shell, so the fix starts in the folder the run would reach rather than in the tool's own
      const moved =
        here.cwd !== undefined &&
        (directory === undefined || resolve(here.cwd) !== resolve(directory))
      const cd = moved ? `cd ${quotedDir(here.cwd as string)} && ` : ""
      return found.anywhere
        ? refuseDocker(found.what, cd, line, found.fix)
        : refuse(found.what, cd, line)
    }
  }
  const env: Env = {
    cwd: directory,
    // the line starts in the folder the tool names, which the reader has proved by the payload itself
    cwdSure: directory,
    files: new Map(),
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map(),
  }
  const lexed = lex(command, env.known)
  line = lexed.commands
  return run(lexed, env, visit)
}

// Fails open: an error on any call lets it run, so a reader bug cannot block every Bash command.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
  main: string = mainCheckout(resolve(import.meta.dir, "..", "..")),
): Promise<string | undefined> {
  try {
    return await inspect(raw, environment, main)
  } catch {
    return
  }
}

if (import.meta.main) {
  const raw = await Bun.stdin.text()
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
