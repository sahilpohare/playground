// PreToolUse hook: refuses a build, a test run, lefthook, turbo (but for the packages build a pull needs, run with env validation off), a git command that moves HEAD, the index or the files (but for the release skill's step 5 fast-forward and the keep reset off a stray local commit; a worker's hard reset there ran another branch's code under every hook for 3.5 minutes) or a file write (a Bash command's, or a Write, Edit, MultiEdit or NotebookEdit), run-slot.sh's command read as typed bare, in the main checkout, which every installed skill follows and so stays clean (a reviewer's `lefthook run pre-commit` from the Bash tool's default cwd rebuilt packages' dist and wrote .turbo/runs there). It also refuses a git write in the live Dashboard's checkout to every factory session but its runner and the ops lead, since that checkout serves the owner's Dashboard.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import { liveSettings } from "../../packages/settings/src/live"
import { readPolicySync } from "../../packages/settings/src/rendered"
import { eachInput } from "./codex"
import { fromFactory, registryName, rosterKind, sessionOf, sessionRole } from "./role"
import {
  codeFed,
  type Command,
  type Env,
  examine,
  GIT_TAKES,
  isFolder,
  kernelPath,
  knownVariables,
  lex,
  marked,
  pathOf,
  places,
  program,
  run,
  slotWords,
  stdinFed,
  stdinOf,
  stdinShell,
  type Text,
  unreadWord,
  type Visit,
  type Word,
} from "./shell"
import { heldWord, namings, steadyNames } from "./steady"

// The checkout a worktree's .git file points into, or the checkout itself where .git is a directory.
export function mainCheckout(dir: string): string {
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(join(dir, ".git"), "utf8"))?.[1]
    const main = gitdir && /^(.+)\/\.git\/worktrees\/[^/]+$/.exec(resolve(dir, gitdir.trim()))?.[1]
    if (main) return main
  } catch {
    // a directory, or no .git: the checkout is its own
  }
  return dir
}

// The live Dashboard's checkout: the worktree of the main checkout's repository on the branch live.branch names, read from its .git/worktrees, or undefined when none is on it.
export function liveCheckout(
  main: string,
  environment: Record<string, string | undefined>,
): string | undefined {
  const settings = readPolicySync(dataDirOf(environment)).settings ?? {
    schemaVersion: 1,
    values: {},
  }
  const head = `ref: refs/heads/${liveSettings.get(settings, "live.branch")}`
  const worktrees = join(main, ".git", "worktrees")
  let names: string[]
  try {
    names = readdirSync(worktrees)
  } catch {
    return
  }
  for (const name of names) {
    try {
      if (readFileSync(join(worktrees, name, "HEAD"), "utf8").trim() !== head) continue
      // git writes gitdir absolute, but worktree.useRelativePaths writes it relative to this admin folder
      return dirname(
        resolve(
          join(worktrees, name),
          readFileSync(join(worktrees, name, "gitdir"), "utf8").trim(),
        ),
      )
    } catch {
      // a worktree whose files went with it
    }
  }
}

// Whether a path under the worktrees folder sits in one worktree: inside a folder there that holds a .git, or one not there yet, which the line may make into a new worktree (`git worktree add <path> && cd <path>`), or a file there, which nothing walks up from; the worktrees folder itself and a plain folder in it hold no checkout of their own, so git, turbo and bun walk up from there to the main checkout.
function inWorktree(path: string, worktrees: string): boolean {
  if (!path.startsWith(worktrees)) return false
  const tree = join(worktrees, path.slice(worktrees.length).split(sep)[0])
  return existsSync(join(tree, ".git")) || !isFolder(tree)
}

// A path with its nearest existing folder's links followed, so a write through a link into the checkout (link-skills' ~/.claude/skills) is judged where it lands.
export function real(path: string): string {
  const found = resolved(path)
  if (found !== undefined || !isAbsolute(path)) return found ?? nearest(path)
  // a folder exists whenever one below it does, so a binary search over the depth finds the nearest one in a few calls, where a walk up costs time that grows with the square of a long path's length
  const parts = normalize(path).split(sep).filter(Boolean)
  let low = 0
  let high = parts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (resolved(sep + parts.slice(0, mid).join(sep)) === undefined) high = mid - 1
    else low = mid
  }
  return join(resolved(sep + parts.slice(0, low).join(sep)) ?? sep, ...parts.slice(low))
}

const resolved = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

// A relative path's nearest existing folder, walked up from the path.
function nearest(path: string): string {
  const rest: string[] = []
  for (let dir = path; ; dir = dirname(dir)) {
    const found = resolved(dir)
    if (found !== undefined) return join(found, ...rest.reverse())
    if (dir === dirname(dir)) return path
    rest.push(basename(dir))
  }
}

// The file tools' path field
export const FILE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Write: "file_path",
}

const INSTEAD = `the main checkout is what every installed skill follows, so it stays clean. Run it in your own worktree under the main checkout's .claude/worktrees/, made by absolute path so it nests in no other worktree (git worktree add --no-track "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" -b <branch> origin/canary), or start lefthook from a script with cwd set to a scratch repo, as tests/lefthook.test.ts does.`

const refuse = (what: string, fix = INSTEAD) => `no-main-checkout hook refuses ${what}: ${fix}`

// This hook's fail-closed rule for a command the shared reader cannot place in one folder (a cd the shell may not run or may run many times, a cd to a word it cannot read, a popd): the command is judged in every folder the shell may be in, and in the folder the line started in when a cd's landing folder cannot be named at all, so a refusal names the folder it would reach.
const UNKNOWN_FIX =
  "the hook cannot tell which folder it runs in, since a cd before it may not run, may run many times, or names a path it cannot read, so it reads every folder the shell may be in. Name the folder instead: git -C <your worktree>, bun --cwd <your worktree>, or cd by a literal path."

// This hook's rule for a line that names more folders than the reader carries (`Env.cwdAnywhere`): the shell may be in any folder, the main checkout included, so a guarded command is refused wherever the line started.
const ANYWHERE_FIX =
  "the line names more folders than the hook carries, so it cannot rule out the main checkout. Name the folder on the command instead: git -C <your worktree>, bun --cwd <your worktree>, or run it as a line of its own after a cd to a literal path."

// A refusal's fix: the command's own where the reader named the folder it runs in, else the one for a folder the hook cannot pin down.
const fixFor = (sure: boolean, own = INSTEAD) => (sure ? own : UNKNOWN_FIX)

// bun scripts that rebuild packages/* or write turbo's runs
const BUN_SCRIPTS = new Set(["build", "check-types", "test", "test:file"])
const RUNNERS = new Set(["npx"])
// bunx is bun x, read as one
export const X: Word = { quoted: false, value: "x" }
const TOOLS = new Set(["lefthook", "turbo"])
const DUPLICATE = /^(?:\d+|-)$/
// The one turbo call the main checkout runs, after a pull that changes packages/ (the release skill's step 5): its CLI imports their dist
const PACKAGES_BUILD = ["run", "build", "--filter=./packages/*"]
const BUILD_FIX =
  "the main checkout has no .env, so the packages' env checks fail. Run it as playground update's build step types it, env NODE_ENV=production SKIP_ENV_VALIDATION=true <main checkout>/node_modules/.bin/turbo run build --filter='./packages/*' --cwd <main checkout>."

// Whether turbo's words are that build alone, wherever its --cwd points.
function packagesBuild(args: Word[]): boolean {
  const words: string[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--cwd") k++
    else if (v === "--filter") words.push(`--filter=${args[++k]?.value}`)
    else if (!v.startsWith("--cwd=")) words.push(v)
  }
  return words.length === PACKAGES_BUILD.length && words.every((w, i) => w === PACKAGES_BUILD[i])
}

// The directory the last --cwd among a command's words names, turbo's anywhere among them.
export function cwdFlag(args: Word[], env: Env): string | undefined {
  let cwd = env.cwd
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--cwd") cwd = args[k + 1] && pathOf(args[++k], env)
    else if (v.startsWith("--cwd=")) cwd = pathOf({ ...args[k], value: v.slice(6) }, env)
  }
  return cwd
}

// bun's own --cwd and --filter count only before the script, tool or file it runs, which takes every word after it; the words are bun's subcommand (run, x, test) and that target.
export function bunCall(
  args: Word[],
  env: Env,
): {
  at: number
  chained: string | undefined
  cwd: string | undefined
  filtered: boolean
  sub: number
  words: string[]
  xCwd?: { dir: string | undefined }
} {
  let cwd = env.cwd
  // bun x's own last --cwd, read from the shell's folder
  let xCwd: { dir: string | undefined } | undefined
  // the folder bun runs in: each --cwd read from the one before, as bun does
  let chained = env.cwd
  let filtered = false
  let sub = -1
  const words: string[] = []
  let k = 0
  for (; k < args.length; k++) {
    const v = args[k].value
    const value =
      v === "--cwd"
        ? args[k + 1]
        : v.startsWith("--cwd=")
          ? { ...args[k], value: v.slice(6) }
          : undefined
    if (v === "--cwd" || v.startsWith("--cwd=")) {
      if (v === "--cwd") k++
      cwd = value && pathOf(value, env)
      chained = value && pathOf(value, { ...env, cwd: chained })
      if (words[0] === "x") xCwd = { dir: cwd }
    } else if (v === "--filter" || v === "-F") {
      filtered = true
      k++
    } else if (v.startsWith("--filter=")) filtered = true
    // bun x's options that take a value (-p, --registry), so the word after one is the tool
    else if (words[0] === "x" && RUNNER_TAKES.has(v)) k++
    else if (!v.startsWith("-")) {
      // when bun reads an option's value as its subcommand, it drops the next word naming that subcommand, so the tool is the word after it
      if (
        v === "x" &&
        words.length === 1 &&
        words[0] === "x" &&
        args[sub - 1]?.value.startsWith("-")
      ) {
        sub = k
        continue
      }
      if (words.push(v) === 1) sub = k
      if (v !== "run" && v !== "x") break
    }
  }
  return { at: k, chained, cwd, filtered, sub, words, xCwd }
}

// Where git lands on a path, read as the kernel reads it: a link is followed before a `..` after it, so `<link>/..` is the folder above the link's target; a path that is not there yet is read by real().
const landing = (word: Word | undefined, env: Env, from: string | undefined) => {
  if (!word || pathOf(word, { ...env, cwd: from }) === undefined) return undefined
  return kernelPath(word, from, real(resolve(from ?? "", word.value)))
}

// git's subcommand and its words, and the tree it acts on: the checkout a --git-dir of `<checkout>/.git` names, whose HEAD and index move, else its --work-tree, else the folder its -C options name (each from where the one before lands, by landing()); each counts only before the subcommand.
// `also` holds the trees GIT_DIR and GIT_WORK_TREE name, read the same way from where the -C options land, from the call's own assignments and env wrapper (`local`) or the line's earlier ones; a value the hook cannot read is undefined there, since it may name any tree.
export function gitCall(
  args: Word[],
  env: Env,
  local?: Map<string, Text>,
): {
  also: (string | undefined)[]
  cwd: string | undefined
  rest: string[]
  sub: string | undefined
} {
  let cwd = env.cwd
  let gitDir: string | undefined
  let workTree: string | undefined
  const value = (k: number, flag: string) =>
    args[k].value === flag
      ? args[k + 1]
      : { ...args[k], value: args[k].value.slice(flag.length + 1) }
  let k = 0
  for (; k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value
    if (v === "-C") cwd = args[k + 1] && landing(args[++k], env, cwd)
    else if (v === "--git-dir" || v.startsWith("--git-dir=")) {
      const word = value(k, "--git-dir")
      if (v === "--git-dir") k++
      gitDir = landing(word, env, cwd)
    } else if (v === "--work-tree" || v.startsWith("--work-tree=")) {
      const word = value(k, "--work-tree")
      if (v === "--work-tree") k++
      workTree = landing(word, env, cwd)
    } else if (GIT_TAKES.has(v)) k++
  }
  const checkout = (dir: string | undefined) => {
    const repo = dir?.replace(/\/+$/, "")
    return repo?.endsWith(`${sep}.git`) ? dirname(repo) : undefined
  }
  const also: (string | undefined)[] = []
  for (const key of ["GIT_DIR", "GIT_WORK_TREE"]) {
    const set = local?.get(key) ?? env.vars.get(key)
    if (!set || set.value === "") continue
    const word = { ...set, quoted: true }
    const at = unreadWord(word) ? undefined : landing(word, env, cwd)
    also.push(key === "GIT_DIR" ? (checkout(at) ?? at) : at)
  }
  return {
    also,
    cwd: checkout(gitDir) ?? workTree ?? cwd,
    rest: args.slice(k + 1).map((a) => a.value),
    sub: args[k]?.value,
  }
}

// these subcommands move HEAD, the index or the files, whatever their words
const GIT_MOVES = new Set([
  "am",
  "bisect",
  "checkout",
  "cherry-pick",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "switch",
  "update-ref",
])
// apply's options that only report, unless --apply is given too
const APPLY_READS = new Set(["--check", "--numstat", "--stat", "--summary"])
// The release skill's step 5 moves the main checkout by this fast-forward alone.
const STEP_FIVE = /^(?:-q |--quiet )?--ff-only (?:-q |--quiet )?origin\/main$/
const GIT_FIX = `it moves the HEAD, index or files of the main checkout, which every installed skill, hook and ops job runs from. Name your own tree on every git call, git -C <your worktree> ..., after git -C <your worktree> rev-parse --show-toplevel names it; the main checkout moves only by the release skill's step 5, git -C <main checkout> fetch -q origin main && git -C <main checkout> merge --ff-only -q origin/main, a stray local commit on its main goes by git -C <main checkout> reset --keep origin/main while its tree is clean, and a worktree is made by absolute path under the main checkout's .claude/worktrees/, so it nests in no other worktree, by git worktree add --no-track "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" -b <branch> origin/canary.`

const LIVE_FIX =
  "it moves the live Dashboard's checkout, which serves the owner's Dashboard, and only the runner that holds it and the ops lead change it. Ask Ops: its supervisor rolls the checkout onto each canary head, and a change it needs goes through a PR into canary."

// A git call that writes the live Dashboard's checkout: a commit, or any move gitMoves reads, every merge and reset included, since step 5 and the keep reset are the main checkout's own.
function liveWrite(
  args: Word[],
  env: Env,
  local: Map<string, Text>,
): { also: (string | undefined)[]; cwd: string | undefined; what: string } | undefined {
  const { also, cwd, rest, sub } = gitCall(args, env, local)
  if (sub && (sub === "commit" || sub === "merge" || gitMoves(sub, rest)))
    return { also, cwd, what: `git ${sub}` }
}

// Whether a session writes the live Dashboard's checkout by its role: the runner holding it, or the ops lead, whose name in Claude Code's registry has the roster's ops kind; a read that throws (no registry folder) names no writer, so check()'s fail-open never lets the call through.
async function liveWriter(
  raw: string,
  environment: Record<string, string | undefined>,
): Promise<boolean> {
  try {
    const session = sessionOf(raw)
    const role = await sessionRole(environment, session)
    if (role === "runner") return true
    if (role !== "lead" || typeof session !== "string") return false
    const name = await registryName(session, environment)
    return name !== undefined && (await rosterKind(name, environment)) === "ops"
  } catch {
    return false
  }
}

// The one reset the main checkout takes, back to origin/main from its own main with the tree clean and every commit it drops (origin/main..main) on no remote, so it removes only a stray local commit nobody else holds; --keep refuses to drop uncommitted work too.
function keepReset(sub: string | undefined, rest: string[], cwd: string | undefined): boolean {
  if (sub !== "reset" || rest.join(" ") !== "--keep origin/main" || !cwd) return false
  const git = (...args: string[]) => {
    const read = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore", stdout: "pipe" })
    return read.exitCode === 0 ? read.stdout.toString() : undefined
  }
  if (git("symbolic-ref", "-q", "HEAD")?.trim() !== "refs/heads/main") return false
  if (git("status", "--porcelain") !== "") return false
  const dropped = git("rev-list", "origin/main..main")
  return (
    dropped !== undefined && dropped === git("rev-list", "origin/main..main", "--not", "--remotes")
  )
}

// Whether a git subcommand and its words move HEAD, the index or the files: stash's list and show, add's and clean's dry runs and apply's checks only read.
function gitMoves(sub: string, rest: string[]): boolean {
  if (GIT_MOVES.has(sub)) return true
  if (sub === "merge") return !STEP_FIVE.test(rest.join(" "))
  if (sub === "stash") return !["list", "show"].includes(rest[0] ?? "push")
  if (sub === "clean") return !rest.some((w) => w === "--dry-run" || /^-[a-z]*n/.test(w))
  if (sub === "add") return !rest.some((w) => w === "--dry-run" || /^-[a-zA-Z]*n/.test(w))
  if (sub === "apply") return rest.includes("--apply") || !rest.some((w) => APPLY_READS.has(w))
  if (sub === "branch") return rest.some((w) => w === "--force" || /^-[a-zA-Z]*f/.test(w))
  return false
}

// turbo's own words, however it is called: by name or path, through npx, bunx or bun x (runs reads bunx as bun x), as their tool or the package their -p names.
export function turboWords(name: string, args: Word[], env: Env): Word[] | undefined {
  if (name === "turbo") return args
  if (RUNNERS.has(name) || name === "bunx") return runnerTurbo(args)
  if (name !== "bun") return
  const { at, sub, words } = bunCall(args, env)
  if (words[0] === "x") return runnerTurbo(args.slice(sub + 1))
  const target = words[0] === "run" ? words[1] : words[0]
  return isTurbo(target) ? args.slice(at + 1) : undefined
}

// A package runner's turbo words: after turbo as its tool, or from its tool on when its -p names turbo, since the runner then runs whatever it names with turbo on PATH.
function runnerTurbo(args: Word[]): Word[] | undefined {
  const at = runnerTarget(args)
  if (isTurbo(args[at]?.value)) return args.slice(at + 1)
  return packagedTools(args).includes("turbo") ? args.slice(at) : undefined
}

// npx's and bunx's options whose next word is their value (bun x --help, npx's -p)
export const RUNNER_TAKES = new Set([
  "--ca",
  "--cafile",
  "--cwd",
  "--env-file",
  "--minimum-release-age",
  "--package",
  "--registry",
  "-p",
])

// The tools a package runner's -p or --package names among its options: it puts that package's programs on PATH and may run any program there (a shell, env), so naming the tool runs it.
export function packagedTools(args: Word[]): string[] {
  const tools: string[] = []
  for (let k = 0; k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value
    if (v === "-p" || v === "--package") tools.push(toolName(args[++k]?.value))
    else if (v.startsWith("--package=") || v.startsWith("-p="))
      tools.push(toolName(v.slice(v.indexOf("=") + 1)))
    else if (RUNNER_TAKES.has(v)) k++
  }
  return tools
}

// The folders bunx or bun x may run its tool in, judged beside the one runs() reads: the folder bun runs it in (each --cwd among bun's own options and bun x's read from the one before, as only x chains them, then the tool's own --cwd from there), and bun x's last --cwd read from the shell's folder; an entry is undefined when a path cannot be read, and the call is undefined for any other program or subcommand.
export function runnerFolders(
  name: string,
  args: Word[],
  env: Env,
  tool: Word[],
): (string | undefined)[] | undefined {
  if (name === "bunx") return runnerFolders("bun", [X, ...args], env, tool)
  if (name !== "bun") return
  const { chained, words, xCwd } = bunCall(args, env)
  if (words[0] !== "x") return
  const folders = [cwdFlag(tool, { ...env, cwd: chained })]
  return xCwd ? [...folders, xCwd.dir] : folders
}

// The word a package runner runs, past its options and their values (-y, --yes, -p turbo).
function runnerTarget(args: Word[]): number {
  let k = 0
  while (k < args.length && args[k].value.startsWith("-"))
    k += RUNNER_TAKES.has(args[k].value) ? 2 : 1
  return k
}

// A tool by name or path, or as a package at a version (turbo@latest)
export const toolName = (word: string | undefined) =>
  program((word ?? "").replace(/(?<=.)@[^/]*$/, ""))
const isTurbo = (word: string | undefined) => toolName(word) === "turbo"

// Whether the build's settings reach turbo: from its own assignments or env wrapper, an export before it, or the session's environment.
function validationOff(local: Map<string, Text>, env: Env): boolean {
  const read = (key: string) =>
    local.get(key)?.value ?? env.vars.get(key)?.value ?? env.process[key]
  return !!read("NODE_ENV") && read("SKIP_ENV_VALIDATION") === "true"
}

// The folders beside a program bun x runs: its own, and an unread one when the hook cannot read the folder bun's --cwd options chain to
export const withChained = (
  also: (string | undefined)[] | undefined,
  chained: string | undefined,
) => [...(also ?? []), ...(chained === undefined ? [undefined] : [])]

// Every folder a hit runs in: its own, and those runnerFolders adds beside it.
export const ranIn = (dir: string | undefined, also?: (string | undefined)[]) => [
  dir,
  ...(also ?? []),
]

// Whether a folder runnerFolders adds is one the hook cannot read, which could be any folder, so both hooks refuse it on every branch
export const unreadFolder = (also?: (string | undefined)[]) => also?.includes(undefined) ?? false

// What of the command would build, test, run lefthook or turbo, commit, or move the checkout with git, or undefined; fix, when set, replaces INSTEAD.
function runs(
  name: string,
  args: Word[],
  local: Map<string, Text>,
  env: Env,
):
  | { also?: (string | undefined)[]; cwd: string | undefined; fix?: string; what: string }
  | undefined {
  if (name === "bunx") return runs("bun", [X, ...args], local, env)
  const turbo = turboWords(name, args, env)
  if (turbo && packagesBuild(turbo)) {
    if (validationOff(local, env)) return
    return {
      also: runnerFolders(name, args, env, turbo),
      cwd: cwdFlag(turbo, env),
      fix: BUILD_FIX,
      what: "the packages build without NODE_ENV and SKIP_ENV_VALIDATION=true",
    }
  }
  if (TOOLS.has(name)) return { cwd: cwdFlag(args, env), what: name }
  if (RUNNERS.has(name)) {
    const tool = [toolName(args[runnerTarget(args)]?.value), ...packagedTools(args)].find((t) =>
      TOOLS.has(t),
    )
    if (tool) return { cwd: cwdFlag(args, env), what: `${name} ${tool}` }
  }
  if (name === "git") {
    const { also, cwd, rest, sub } = gitCall(args, env, local)
    if (sub === "commit") return { also, cwd, what: "git commit, which runs lefthook's pre-commit" }
    if (keepReset(sub, rest, cwd)) return
    return sub && gitMoves(sub, rest) ? { also, cwd, fix: GIT_FIX, what: `git ${sub}` } : undefined
  }
  if (name !== "bun") return
  const { at, chained, cwd, filtered, sub, words } = bunCall(args, env)
  const target = words[0] === "run" || words[0] === "x" ? words[1] : words[0]
  const packaged = words[0] === "x" ? packagedTools(args.slice(sub + 1)) : []
  const tool = [toolName(target), ...packaged].find((t) => TOOLS.has(t))
  // bun runs a tool by its path, as lefthook.yml does, or as a script or package by its name; a tool reads its own --cwd too, and bun x is judged in the shell's folder and in every folder runnerFolders names (also)
  if (tool) {
    const dir = words[0] === "x" ? env.cwd : cwd
    return {
      also: runnerFolders(name, args, env, args.slice(at + 1)),
      cwd: cwdFlag(args.slice(at + 1), { ...env, cwd: dir }),
      what: `bun ${words.join(" ")}`,
    }
  }
  // bun test runs no script, so a --cwd after test is still its own
  if (words[0] === "test")
    return { cwd: cwdFlag(args.slice(at + 1), { ...env, cwd }), what: "bun test" }
  // bare, a script name runs the script, but build is bun's own bundler unless a --filter names the packages whose script it runs
  if (target && BUN_SCRIPTS.has(target) && (words[0] === "run" || filtered || target !== "build"))
    return { cwd, what: `bun ${words.join(" ")}` }
  // bun x runs any program in the folder its --cwd options chain to, so that program is read as the shell would read it there
  if (words[0] === "x" && target && args[at]?.value === target) {
    const ran = runs(toolName(target), args.slice(at + 1), local, { ...env, cwd: chained })
    return (
      ran && {
        ...ran,
        also: withChained(ran.also, chained),
        what: `bun x ${ran.what}`,
      }
    )
  }
}

// How sed and perl read each flag letter that is more than a switch: edit (in place, -i and BSD sed's -I), script (carries the script) and value, each holding the rest of its word, else the next word; rest, holding the rest of its word alone; digits, holding the octal or x-hex digits after it, then reading on
type Letter = "digits" | "edit" | "rest" | "script" | "value"
const LETTERS: Record<string, Record<string, Letter>> = {
  perl: {
    "0": "digits",
    C: "rest",
    D: "rest",
    E: "script",
    F: "rest",
    I: "rest",
    M: "rest",
    V: "rest",
    d: "rest",
    e: "script",
    i: "edit",
    l: "digits",
    m: "rest",
    x: "rest",
  },
  sed: { I: "edit", e: "script", f: "script", i: "edit", l: "value" },
}
// sed's long options with a value, after an = or as the next word
const SED_VALUES = new Set(["--expression", "--file", "--line-length"])
// a word BSD sed's bare -i or -I takes as its backup suffix: empty, or a dot and a name
const BSD_SUFFIX = /^(\.[\w.-]*)?$/

// The files sed -i or perl -i edits in place (none without -i): every positional, but the first when no script flag gave the script.
function inPlace(name: string, args: Word[]): Word[] {
  const letters = LETTERS[name]
  if (!letters) return []
  let edits = false
  let scripted = false
  const positionals: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--") {
      positionals.push(...args.slice(k + 1))
      break
    }
    if (name === "sed" && v.startsWith("--")) {
      const flag = v.split("=")[0]
      if (flag === "--in-place") edits = true
      else if (SED_VALUES.has(flag)) {
        scripted ||= flag !== "--line-length"
        if (!v.includes("=")) k++
      }
    } else if (/^-[^-]/.test(v)) {
      for (let j = 1; j < v.length; j++) {
        const kind = letters[v[j]]
        const rest = v.slice(j + 1)
        if (kind === "digits") j += /^(x[0-9A-Fa-f]*|[0-7]*)/.exec(rest)![0].length
        else if (kind === "edit") {
          edits = true
          if (name === "sed" && rest === "" && BSD_SUFFIX.test(args[k + 1]?.value ?? "-")) k++
          break
        } else if (kind === "script" || kind === "value") {
          scripted ||= kind === "script"
          if (rest === "") k++
          break
        } else if (kind === "rest") break
      }
    } else if (!v.startsWith("-")) positionals.push(args[k])
  }
  if (!edits) return []
  return scripted ? positionals : positionals.slice(1)
}

// The files a command writes by name, besides its redirects.
function writes(name: string, args: Word[]): Word[] {
  const positionals = args.filter((a) => !a.value.startsWith("-"))
  if (name === "sed" || name === "perl") return inPlace(name, args)
  if (name === "touch" || name === "tee") return positionals
  if (name === "cp" || name === "mv") return positionals.slice(-1)
  if (name !== "curl") return []
  const out: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (["-c", "--cookie-jar", "-o", "--output"].includes(v) && args[k + 1]) out.push(args[++k])
    const attached = /^--(?:cookie-jar|output)=(.+)$/.exec(v)?.[1]
    if (attached) out.push({ ...args[k], value: attached })
  }
  return out
}

// agent-browser's subcommands that save the page at the path they are given
const BROWSER_SAVES = new Set(["pdf", "screenshot"])
const BROWSER_FIX =
  "agent-browser saves a relative path in the folder its browser started in, which can be the main checkout, where playground rm cannot clean it. Name an absolute path under your scratchpad or your worktree: agent-browser screenshot <your scratchpad>/<name>.png."

// The subcommand of an agent-browser screenshot or pdf that names no absolute path, else undefined: the subcommand is the first word past its options and their values, and the path any later word that reads as an absolute one, so a selector, --full and --session stand anywhere.
function browserPathless(args: Word[], env: Env): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (BROWSER_SAVES.has(v))
      return args.slice(k + 1).some((w) => pathOf(w, { ...env, cwd: undefined })) ? undefined : v
    if (!v.startsWith("-") && !args[k - 1]?.value.startsWith("-")) return
  }
}

// The files a command writes, by a redirect or by name, each one the hook can place.
export function writeTargets(cmd: Command, name: string, args: Word[]): Word[] {
  const targets = [
    ...cmd.redirects
      .filter(
        (r) =>
          [">", ">>", ">|"].includes(r.op) ||
          (r.op === ">&" && !DUPLICATE.test(r.target?.value ?? "")),
      )
      .flatMap((r) => (r.target ? [r.target] : [])),
    ...writes(name, args),
  ]
  return targets.filter((t) => !["-", "/dev/null"].includes(t.value))
}

// A shell whose script the hook cannot read, refused where the shell would run in the main checkout: a script the hook reads is judged command by command by the shared reader, which runs a shell's script itself.
async function unreadScript(
  shell: Command,
  here: Env,
  sure: boolean,
  inMain: (path: string | undefined) => boolean,
): Promise<string | undefined> {
  const script = await stdinOf(shell, here)
  if (!script.unknown || !inMain(here.cwd)) return
  return refuse(`a shell whose script (${script.unknown}) the hook cannot read`, fixFor(sure))
}

// The builtins run() hands visit beside a bare wrapper and a bare copy of a followed command, each with no command of its own to judge.
const EXPORTS = new Set(["declare", "export", "local", "readonly", "typeset"])

// The shell a here-string, a heredoc, a pipeline, a file or a process substitution feeds runs that text as its script: one the hook cannot read is refused where the shell would run in the main checkout, and a root shell's here-string, heredoc, file or process substitution, which the shared reader leaves, is judged command by command (the reader runs a plain shell's itself, and a root shell's piped script).
async function fedScript(
  cmd: Command,
  here: Env,
  sure: boolean,
  inMain: (path: string | undefined) => boolean,
  visit: Visit,
): Promise<string | undefined> {
  const shell = cmd.bareOf ?? cmd
  if (!stdinFed(shell) && shell.stdin === undefined) return
  const kind = stdinShell(shell)
  if (!kind || kind === "code") return
  const script = await stdinOf(shell, here)
  const unread = script.unknown ?? (marked(script.value) ? "a value it cannot read" : undefined)
  if (unread) {
    if (!inMain(here.cwd)) return
    return refuse(`a shell whose script (${unread}) the hook cannot read`, fixFor(sure))
  }
  if (kind === "root" && !cmd.bareOf)
    return run(lex(script.value, here.known), { ...here, vars: new Map() }, visit, true)
}

async function inspect(raw: string, environment: Record<string, string | undefined>, main: string) {
  const { cwd, tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as Record<string, unknown>
  const input = (toolInput ?? {}) as Record<string, unknown>
  const directory = typeof cwd === "string" ? cwd : undefined
  const checkout = real(main)
  const worktrees = join(checkout, ".claude", "worktrees") + sep
  const inMain = (raw: string | undefined) => {
    const path = raw === undefined ? undefined : real(resolve(directory ?? "", raw))
    return (
      path !== undefined &&
      (path === checkout || path.startsWith(checkout + sep)) &&
      !inWorktree(path, worktrees)
    )
  }
  // the live checkout is read only for a Bash call, so a file tool's write pays nothing for it
  let live: string | undefined
  const inLive = (raw: string | undefined) => {
    const path = raw === undefined ? undefined : real(resolve(directory ?? "", raw))
    return (
      live !== undefined && path !== undefined && (path === live || path.startsWith(live + sep))
    )
  }
  let writer: Promise<boolean> | undefined
  // a git write whose tree lands in the live checkout, by the caller's test of its trees, or that a GIT_DIR or GIT_WORK_TREE the hook cannot read may land anywhere, refused unless the session writes it
  const liveRefusal = async (
    args: Word[],
    local: Map<string, Text>,
    env: Env,
    lands: (cwd: string | undefined) => boolean,
    fix: string,
  ) => {
    const move = liveWrite(args, env, local)
    if (!move || !(ranIn(move.cwd, move.also).some(lands) || unreadFolder(move.also))) return
    if (await (writer ??= liveWriter(raw, environment))) return
    return refuse(`${move.what} in the live Dashboard's checkout`, fix)
  }
  const file = typeof tool === "string" ? input[FILE_TOOLS[tool]] : undefined
  if (typeof file === "string") return inMain(file) ? refuse(`a write to ${file}`) : undefined
  if (tool !== "Bash") return
  const { command } = input
  if (typeof command !== "string") return
  // a policy or worktree read that throws guards no live checkout, so check()'s fail-open never takes the main checkout's guard with it
  try {
    const found = liveCheckout(main, environment)
    live = found === undefined ? undefined : real(found)
  } catch {
    live = undefined
  }
  const known = knownVariables(command, environment, directory)
  const lexed = lex(command, known)
  // the shell each pipeline feeds, by the command whose output it reads, since the walk judges that command in the folder the pipeline runs in and never visits a shell of its own
  const fed = codeFed(lexed.commands)
  // the call's own commands, when each opens with the bare word agent-browser, as no-raw-delete reads an eval
  const browserOnly = new Set(
    lexed.commands.every((c) => c.words[0]?.source === "agent-browser") ? lexed.commands : [],
  )
  const visit: Visit = async (cmd, parsed, env) => {
    const pathless = browserOnly.has(cmd) ? browserPathless(parsed.args, env) : undefined
    if (pathless)
      return refuse(`agent-browser ${pathless} with a relative path or none`, BROWSER_FIX)
    // a builtin run() hands over (a bare `sudo -s`, which it hands every hook once a redirect feeds it, a bare copy of a followed shell, an export) is read only for the script a here-string, a heredoc or a pipeline feeds it; one that feeds a shell (a loop's `done`) is judged in full, as the reader hands it to every hook
    if ((parsed.name === "" && !cmd.feedsShell) || EXPORTS.has(parsed.name)) {
      for (const here of places(env, directory)) {
        const sure = env.cwdSure !== undefined && here.cwd === env.cwdSure
        const verdict = await fedScript(cmd, here, sure, inMain, visit)
        if (verdict) return verdict
      }
      return
    }
    const slot = slotWords(parsed)
    if (slot)
      return slot.length === 0 ? undefined : examine({ ...cmd, words: slot }, env, visit, false)
    const { args, local, name } = parsed
    // a line that names more folders than the reader carries may run anywhere, the main checkout included, so what it guards is refused with no folder to name
    if (env.cwdAnywhere) {
      const blind: Env = { ...env, cwd: undefined }
      const ran = runs(name, args, local, blind)
      // a folder the command names itself is judged by that path, as everywhere else; one the shell gives it could be the main checkout
      if (ran && ranIn(ran.cwd, ran.also).some((dir) => dir === undefined || inMain(dir)))
        return refuse(ran.what, ANYWHERE_FIX)
      const blindWrite = writeTargets(cmd, name, args).find((t) => {
        const path = pathOf(t, blind)
        return path === undefined || inMain(path)
      })
      if (blindWrite) return refuse(`a write to ${blindWrite.value}`, ANYWHERE_FIX)
      const blindLive =
        name === "git"
          ? await liveRefusal(
              args,
              local,
              blind,
              (cwd) => cwd === undefined || inLive(cwd),
              ANYWHERE_FIX,
            )
          : undefined
      if (blindLive) return blindLive
    }
    // every folder the shell may be in, so a cd the reader cannot be sure of is judged wherever it may have left the command, by the fail-closed rule above
    for (const here of places(env, directory)) {
      // only the folder the reader proved takes the command's own fix, so a refusal in any other folder names the fix for a folder the hook cannot pin down
      const sure = env.cwdSure !== undefined && here.cwd === env.cwdSure
      // the command this command's output feeds runs whatever it prints as code, so a script the hook cannot read is refused where it would run in the main checkout, and one in another language always is
      const pipedTo = fed.get(cmd)
      if (pipedTo?.kind === "code" && inMain(here.cwd))
        return refuse(
          `a pipe into an interpreter whose script, the piped input, the hook cannot read`,
          fixFor(sure),
        )
      if (pipedTo) {
        const verdict = await unreadScript(pipedTo.consumer, here, sure, inMain)
        if (verdict) return verdict
      }
      const script = await fedScript(cmd, here, sure, inMain, visit)
      if (script) return script
      const ran = runs(name, args, local, here)
      if (ran && (ranIn(ran.cwd, ran.also).some((dir) => inMain(dir)) || unreadFolder(ran.also)))
        return refuse(ran.what, fixFor(sure, ran.fix))
      const moved =
        name === "git"
          ? await liveRefusal(args, local, here, inLive, fixFor(sure, LIVE_FIX))
          : undefined
      if (moved) return moved
      const wrote = writeTargets(cmd, name, args).find((t) => inMain(pathOf(t, here)))
      if (wrote) return refuse(`a write to ${pathOf(wrote, here)}`, fixFor(sure))
    }
  }
  // a cd through a steady variable is read by the folder that variable names
  const steadyAt = steadyNames(namings(command), lexed.commands)
  const env: Env = {
    cwd: directory,
    // the line starts in the folder the tool names, which the reader has proved by the payload itself
    cwdSure: directory,
    files: new Map(),
    hold: (word, cmd, here) => heldWord(word, here, steadyAt(cmd)),
    known,
    // zsh starts with OLDPWD at the folder it starts in
    old: { dir: directory },
    process: environment,
    vars: new Map(),
  }
  return run(lexed, env, visit, true)
}

// Fails open: an error on any call lets it run, so a reader bug cannot block every Bash command or write.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
  main: string = mainCheckout(resolve(import.meta.dir, "..", "..")),
): Promise<string | undefined> {
  try {
    return await eachInput(raw, "no-main-checkout", (one) => inspect(one, environment, main))
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
