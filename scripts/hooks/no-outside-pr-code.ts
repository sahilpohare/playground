// PreToolUse hook: puts a reviewer or tester session (role.ts), its sub-agents included, in read mode while its roster row serves an outside author's PR or names none, and in read mode refuses a Bash or Monitor line unless every command on it is one the allowlist below names and every file it writes lands in the session's own folders outside any git folder, and refuses a file tool's write into a git folder, since a git folder's config and hooks name programs a git read runs and running the PR's tests, scripts or installs runs its author's code on this machine.
import "../../packages/env/src/aliases"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import { readPolicy } from "../../packages/settings/src/rendered"
import { ruleSettings } from "../../packages/settings/src/rules"
import { patchPaths } from "./codex"
import { input } from "./input"
import { mainCheckout } from "./no-main-checkout"
import { readsWords } from "./read-only"
import { registryName, sessionRole } from "./role"
import {
  type Command,
  type Env,
  examine,
  knownVariables,
  lex,
  marked,
  type Parsed,
  pathOf,
  run,
  SHELLS,
  shellOperand,
  slice,
  type Text,
  type Visit,
  type Word,
} from "./shell"

type Environment = Record<string, string | undefined>
type Pr = { author: string; owner: string; ownerType: string }

// What the hook reads off the machine and GitHub, a seam its tests fill with made-up sessions and PRs.
export type Lookup = {
  author: (repo: string, pr: number) => Promise<Pr | undefined>
  holds: (
    folder: string,
    entry: ".git" | "bunfig.toml" | "HEAD" | "node_modules" | "objects" | "refs",
  ) => boolean
  main: string
  // the session's registry name, which names its own scratch and scratchpad folders
  name: (sessionId: unknown) => Promise<string | undefined>
  prsOf: (sessionId: unknown) => Promise<string[]>
  // the program a script's first line runs it with (runnerOf): `env`'s program for an env line, "" for one it cannot read or a script it cannot open, undefined with no shebang
  runner: (script: string) => string | undefined
  // whether git, in the main checkout, reports a file tracked and unchanged from HEAD
  tracked: (script: string) => boolean
}

const CHECKERS = new Set(["reviewer", "tester"])
const TOOLS = new Set(["Bash", "Monitor"])
// The file tools, each by the input key that names the file it writes, A to Z
const FILE_TOOLS = new Map([
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
  ["Write", "file_path"],
])
const PULL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/
// Programs and shell words that run no file they are given, by bare name, A to Z.
const UTILITIES = new Set([
  "[",
  "basename",
  "break",
  "case",
  "cat",
  "cd",
  "comm",
  "continue",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "exit",
  "false",
  "grep",
  "head",
  "jq",
  "ls",
  "mkdir",
  "printf",
  "pwd",
  "realpath",
  "sleep",
  "tail",
  "test",
  "tr",
  "true",
  "uniq",
  "wc",
])
// Interpreters that read no config from the folder they run in, so a skill's script runs as its author wrote it; bun is left out, since it reads the folder's bunfig.toml, whose preload runs first, and the shells are judged as shells.
const INTERPRETERS = new Set(["node", "python", "python3"])
// gh's command groups a checker posts and reads with, A to Z; a checkout (`pr checkout` or `pr co`, wherever the verb sits among gh's flags, and `issue develop`) is left out, since it runs the git hooks of the folder it lands in, and so is any `--`, which hands gh's clone git's own options.
const GH = new Set(["api", "issue", "label", "pr", "repo", "run", "search"])
// git's subcommands that read the repo and run nothing it holds, A to Z, with any option but the ones that start a program or write a file.
const GIT_READS = new Set([
  "blame",
  "branch",
  "cat-file",
  "describe",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "merge-tree",
  "name-rev",
  "remote",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "status",
])
// git's options that start a program or write a file, by their full names, since git takes any unambiguous start of one (`--open=`, `--out=`); `--text` is git's own option, not a start of `--textconv`.
const GIT_RUN_NAMES = ["ext-diff", "open-files-in-pager", "output", "textconv"]
// git grep's short options that take the rest of their word as a value, so an O after one is that value's, not the pager
const GREP_VALUED = "ABCefm"
const gitRuns = (w: string, sub: string) => {
  if (sub === "grep" && /^-[^-]/.test(w))
    for (const c of w.slice(1)) {
      if (c === "O") return true
      if (GREP_VALUED.includes(c)) break
    }
  const long = /^--([^=]+)/.exec(w)?.[1]
  return long !== undefined && long !== "text" && GIT_RUN_NAMES.some((n) => n.startsWith(long))
}
// A remote's name, which a fetch takes from the clone's own config, so git reads only the clone's repository; a path names a repository the PR can ship.
const REMOTE = /^[A-Za-z0-9_][\w.-]*$/
// fetch's options that name no program and no source, A to Z
const FETCH_OPTIONS = new Set([
  "--all",
  "--force",
  "--no-tags",
  "--prune",
  "--tags",
  "--unshallow",
  "-f",
  "-p",
  "-t",
])
const QUIET = new Set(["-q", "--quiet"])
// code-review-loop's state.ts commands that run nothing the PR holds, A to Z; merge passes only with --conflict-only (runsPrTests)
const STATE_READS = new Set(["checks", "delta", "fresh", "pr", "scan", "touched-tests", "wait"])
// sed's scripts that run and write nothing: `-n` printing a range of lines or patterns, or one substitution whose flags write no file
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`
const SED_PRINT = new RegExp(`^${SED_ADDRESS}(?:,${SED_ADDRESS})?p$`)
const SED_SUBSTITUTE = /^s\/(?:[^/\\]|\\.)*\/(?:[^/\\]|\\.)*\/[gIp\d]*$/
// The playground command's verbs a checker reads with, A to Z; an item's reviewer shows and scores the item with ext's, reading a revision through `ext show --rev`; `add` and the manager verbs start a session that no read mode holds.
const PLAYGROUND_READS = new Set(["ext score", "ext search", "ext show", "ext which", "rules"])
// find's actions that run a program, delete or write a file, A to Z, BSD's and GNU's
const FIND_ACTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
])
// The devices a redirect writes to that hold no file
const DEVICES = new Set(["/dev/null", "/dev/stderr", "/dev/stdout"])
// uniq's options that take the next word as their value, BSD's and GNU's
const UNIQ_VALUED = new Set(["--check-chars", "--skip-chars", "--skip-fields", "-f", "-s", "-w"])
// Whether a redirect writes a file: >, >>, >|, <> or >& to a name, not an fd, as no-extensions-write reads it
const writer = ({ op, target }: { op: string; target?: Word }): boolean =>
  [">", ">>", ">|", "<>"].includes(op) || (op === ">&" && !/^(?:\d+|-)$/.test(target?.value ?? ""))
const GITHUB_URL = /^(?:https:\/\/github\.com\/|git@github\.com:)[\w.-]+\/[\w.-]+?(?:\.git)?$/

// Read mode's reason, by why the session is in it; a PR GitHub did not answer for names when the hook reads it again.
const unread = (repo: string, n: number) =>
  `GitHub did not answer for ${repo}#${n}, so the hook counts it as an outside author's PR until a read of it succeeds. It reads again on the first call once the github rule's poll interval (github.pollMinutes, 5 minutes by default) has passed since the failed read.`
const REASONS = {
  none: "its roster row names no PR, so the hook cannot rule out an outside author's code. A row written before spawn.sh required a checker's --pr <pull url> has none; its worker or lead names the PR it serves from the main checkout: bun scripts/roster.ts set <this session's name> pr=<pull url>. An extension item's reviewer has no PR and stays in read mode: read each revision with playground ext show <scope> <kind> <key> --rev <sha> piped into jq (.content.files, .content.body), and say in the verdict that the item was read, not run.",
  outside:
    "it serves an outside author's PR, whose tests, scripts and installs run that author's code on this machine. Read the PR instead: the Read, Grep and Glob tools, gh pr diff, git diff and git show <rev> in the clone, and move a clone with no node_modules (a fresh one, never an installed one, whose git hooks would run) with git fetch and git checkout --detach. Score on the PR's own GitHub checks, and say in the verdict that its code was read, not run.",
}

// A path with its symlinks and .. steps resolved in order, as the system resolves them, so a climb out of a folder is judged where it lands; the native call, since node's own resolves .. before it follows a link.
function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

// Whether git, run in a folder, would take a bare repository for its own: the first folder up from it that holds .git, or holds HEAD, objects and refs, decides, as git's discovery does, and a PR can ship the second as plain files whose config names the programs git runs.
function bareAt(folder: string, lookup: Lookup): boolean {
  for (let at = folder; ; at = dirname(at)) {
    if (basename(at) === ".git" || lookup.holds(at, ".git")) return false
    if (lookup.holds(at, "HEAD") && lookup.holds(at, "objects") && lookup.holds(at, "refs"))
      return true
    if (dirname(at) === at) return false
  }
}

// Whether a folder, or one above it up to its work tree's root, holds node_modules, from which a git hook's lefthook runs at that root.
function installedAt(folder: string, lookup: Lookup): boolean {
  for (let at = folder; ; at = dirname(at)) {
    if (lookup.holds(at, "node_modules")) return true
    if (lookup.holds(at, ".git") || dirname(at) === at) return false
  }
}

// Whether a path, case ignored as this Mac's file system ignores it, sits under a folder.
const under = (path: string, folder: string) =>
  (path + "/").toLowerCase().startsWith(folder.toLowerCase().replace(/\/?$/, "/"))

// Where a path a command writes or removes lands: its deepest folder that exists with its symlinks resolved, then the rest as written; a `..` step is left unplaced, since the system takes it after a link.
function placed(written: string | undefined): string | undefined {
  if (written === undefined || written.split("/").includes("..")) return undefined
  const path = resolve(written)
  for (let at = path; ; at = dirname(at)) {
    if (existsSync(at)) return join(real(at), path.slice(at.length))
    if (dirname(at) === at) return path
  }
}

// Whether a path lands in a git folder, a `.git` part or a folder holding HEAD, objects and refs at or above it, whose config and hooks name programs a later git read runs; a path the hook cannot place counts as one.
function gitFolder(path: string | undefined, lookup: Lookup): boolean {
  if (path === undefined || path.split("/").some((part) => part.toLowerCase() === ".git"))
    return true
  for (let at = path; ; at = dirname(at)) {
    if (lookup.holds(at, "HEAD") && lookup.holds(at, "objects") && lookup.holds(at, "refs"))
      return true
    if (dirname(at) === at) return false
  }
}

// git's reads, and the literal forms that fetch or place a PR's code without running a file it holds: a fetch, a fresh clone of a GitHub repo, a worktree add or list, and a detached checkout or switch in a folder with no node_modules for a git hook's lefthook to load.
function gitAllows(
  words: string[],
  folder: string | undefined,
  lookup: Lookup,
  environment: Environment,
): boolean {
  // a repository the session names by its environment is one the walk below would not find
  if ("GIT_DIR" in environment || "GIT_WORK_TREE" in environment) return false
  const dashC = words[1] === "-C"
  const [sub, ...all] = words.slice(dashC ? 3 : 1)
  // the folder git really uses, its symlinks followed as git follows them
  const written =
    dashC && folder ? (isAbsolute(words[2]) ? words[2] : `${folder}/${words[2]}`) : folder
  const at = written === undefined ? undefined : real(written)
  if (at === undefined || bareAt(at, lookup) || all.some((w) => gitRuns(w, sub))) return false
  const rest = all.filter((w) => !QUIET.has(w))
  const plain = (w: string) => !w.startsWith("-") && !w.includes("::")
  // a remote takes no verb but the two that read it, since `remote add` names a source a fetch then reads
  const verb = all.find(plain)
  if (sub === "remote" && verb !== undefined && verb !== "get-url" && verb !== "show") return false
  // a diff of two folders reads no repository, so it names neither a diff program nor a textconv for the attributes the folders can ship to start
  if (sub === "diff" && all.includes("--no-index"))
    return all.includes("--no-ext-diff") && all.includes("--no-textconv")
  if (readsWords(words) || GIT_READS.has(sub)) return true
  if (sub === "fetch") {
    const options = rest.filter((w) => w.startsWith("-"))
    const [source, ...refs] = rest.filter((w) => !w.startsWith("-"))
    return (
      options.every((w) => FETCH_OPTIONS.has(w) || /^--depth=\d+$/.test(w)) &&
      (source === undefined || REMOTE.test(source) || GITHUB_URL.test(source)) &&
      refs.every(plain)
    )
  }
  if (sub === "clone") return rest.length === 2 && GITHUB_URL.test(rest[0]) && plain(rest[1])
  if (sub === "checkout" || sub === "switch")
    return rest.length === 2 && rest[0] === "--detach" && plain(rest[1]) && !installedAt(at, lookup)
  if (sub !== "worktree") return false
  if (rest[0] === "list") return true
  if (rest[0] !== "add") return false
  const operands = rest[1] === "--detach" ? rest.slice(2) : rest.slice(1)
  return operands.length === 2 && operands.every(plain)
}

export async function inspect(
  command: string,
  directory: string | undefined,
  environment: Environment,
  lookup: Lookup,
  own: string[] = [],
): Promise<boolean> {
  const data = dataDirOf(environment)
  const extensions = join(lookup.main, "extensions")
  const slot = join(data, "ops", "run-slot.sh")
  let allowed = true
  // whether the line writes into the session's own folders, and whether it also runs a move that can put a link or a folder there first
  let ownWrites = false
  let reshapes = false
  // A script of a skill in the main checkout's extensions that git there reports tracked and unchanged, run as a program or by an interpreter with no option of its own; the data folder's installed copies are left out, since any tool can write a folder there.
  const skillScript = (written: string | undefined) => {
    if (written === undefined) return false
    const path = real(written)
    return (
      under(path, extensions) &&
      path.slice(extensions.length).toLowerCase().includes("/skills/") &&
      lookup.tracked(path)
    )
  }
  // code-review-loop's state.ts runs only as a command STATE_READS names by its literal word, or merge with --conflict-only (merge-tree alone), since merge runs the PR's tests through run-slot, a child this hook never sees; a word the shell rewrites (a brace, $IFS) or one xargs adds matches none.
  const runsPrTests = (script: string | undefined, rest: string[]): boolean =>
    script !== undefined &&
    real(script).endsWith("/code-review-loop/scripts/state.ts") &&
    !STATE_READS.has(rest[0] ?? "") &&
    !(rest[0] === "merge" && rest.includes("--conflict-only"))
  // Whether a folder sits in the main checkout's own work tree: the first folder up from it that holds .git is the main checkout, so another clone or worktree inside it, a folder outside any, and an unknown one are not.
  const inMain = (folder: string | undefined): boolean => {
    if (folder === undefined) return false
    const main = real(lookup.main)
    for (let at = real(folder); ; at = dirname(at)) {
      if (lookup.holds(at, ".git")) return at === main
      if (dirname(at) === at) return false
    }
  }
  // Whether a path a command writes or removes sits in the session's own scratch or scratchpad folder.
  const ownPath = (text: Text | undefined, here: Env) => {
    const path = text && placed(pathOf(text, here))
    return (
      path !== undefined &&
      own.some((folder) => {
        const at = placed(folder)
        return at !== undefined && under(path, at)
      })
    )
  }
  // Whether a file a command writes lands in the session's own folders, in a folder there already, since a write makes no folder and one the line makes first can be a link; a glob is refused, since it can expand to a link.
  const ownTarget = (text: Text | undefined, here: Env): boolean => {
    const path = text && !(text as Word).glob ? pathOf(text, here) : undefined
    if (path === undefined || !existsSync(dirname(resolve(path))) || !ownPath(text, here))
      return false
    if (gitFolder(placed(path), lookup)) return false
    // a link as the last part, dangling or not, carries the write where it points, and a file with a second link changes a file elsewhere too
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1)) return false
    } catch {}
    ownWrites = true
    return true
  }
  const writesOwn = (cmd: Command, here: Env): boolean =>
    cmd.redirects.every((r) => {
      if (!writer(r)) return true
      const path = r.target && !r.target.glob ? pathOf(r.target, here) : undefined
      return (path !== undefined && DEVICES.has(path)) || ownTarget(r.target, here)
    })
  const permitted = (cmd: Command, parsed: Parsed, here: Env): boolean => {
    const { args, first, local, name } = parsed
    // a bare assignment reaches a later program only through a variable the session already exports (PATH, BASH_ENV), and one on a command reaches it always
    if (name === "")
      return args.length === 0 && [...local.keys()].every((key) => !(key in environment))
    if (marked(name) || local.size > 0) return false
    const program = first ? pathOf(first, here) : undefined
    if (first && first.value.includes("/")) {
      if (program && under(program, slot) && program.length === slot.length) return true
      // bun reads files from the folder it runs in before a script (bunfig.toml's preload, .env's variables, and whatever a later bun adds), so a skill script whose shebang runs any program but one that reads no folder's files runs only from the main checkout's own tree
      if (
        !skillScript(program) ||
        runsPrTests(
          program,
          args.map((a) => a.value),
        )
      )
        return false
      const runner = lookup.runner(real(program!))
      return runner === undefined || FOLDERLESS.has(runner) || inMain(here.cwd)
    }
    const words = [name, ...args.map((a) => a.value)]
    // git first, since read-only.ts's git reads say nothing of the folder git takes its repository from
    if (name === "git") {
      const sub = words[words[1] === "-C" ? 3 : 1]
      if (["checkout", "clone", "switch", "worktree"].includes(sub)) reshapes = true
      return gitAllows(words, here.cwd, lookup, environment)
    }
    // uniq writes its second operand, wherever an option sits
    if (name === "uniq") {
      const operands: Word[] = []
      let ended = false
      for (let i = 0; i < args.length; i++) {
        const v = args[i].value
        if (ended || v === "-" || !v.startsWith("-")) operands.push(args[i])
        else if (v === "--") ended = true
        else if (UNIQ_VALUED.has(v)) i++
      }
      return operands.length < 2 || (operands.length === 2 && ownTarget(operands[1], here))
    }
    if (UTILITIES.has(name) || readsWords(words)) return true
    if (name === "find") return !words.some((w) => FIND_ACTIONS.has(w))
    // a loop's or a read's variable reaches a later program only when the session exports it, as a bare assignment's does
    if (name === "for") return !(words[1] in environment)
    if (name === "read")
      return words.slice(1).every((w) => w.startsWith("-") || !(w in environment))
    // GNU sed takes an option after its script, -i among them
    if (name === "sed") {
      const print = words[1] === "-n"
      return (
        (print ? SED_PRINT : SED_SUBSTITUTE).test(words[print ? 2 : 1] ?? "") &&
        words.slice(print ? 3 : 2).every((w) => w === "-" || !w.startsWith("-"))
      )
    }
    // a shell's -c script is walked on its own, and a script file only a tracked skill's runs
    if (SHELLS.has(name)) {
      const { inline, operand } = shellOperand(args, name)
      return inline || (operand !== undefined && skillScript(pathOf(operand, here)))
    }
    // the playground command runs under bun, which reads the folder's bunfig.toml first, the main checkout's being its own; its rm removes only inside the session's own folders
    if (name === "playground") {
      if (words[1] === "rm") reshapes = true
      return (
        (PLAYGROUND_READS.has(words[1]) ||
          PLAYGROUND_READS.has(words.slice(1, 3).join(" ")) ||
          (words[1] === "rm" &&
            args.length > 1 &&
            args.slice(1).every((a) => !a.value.startsWith("-") && ownPath(a, here)))) &&
        here.cwd !== undefined &&
        (!lookup.holds(here.cwd, "bunfig.toml") || inMain(here.cwd))
      )
    }
    if (name === "gh") {
      const [group, ...rest] = words.slice(1)
      const checkout =
        (group === "pr" && rest.some((w) => w === "checkout" || w === "co")) ||
        (group === "issue" && rest.includes("develop"))
      if (group === "repo" && rest.some((w) => w === "clone" || w === "fork")) reshapes = true
      // a run's artifacts land in -D's folder, else the one it runs in, which an artifact alone fills
      if (group === "run" && rest.includes("download")) {
        const folders = args.flatMap((a, i) => {
          if (a.value === "-D" || a.value === "--dir") return args[i + 1] ? [args[i + 1]] : [a]
          if (a.value.startsWith("--dir=")) return [slice(a, 6)]
          return a.value.startsWith("-D") ? [slice(a, a.value.startsWith("-D=") ? 3 : 2)] : []
        })
        const into = folders.length > 0 ? folders : [{ value: "." }]
        if (!into.every((folder) => ownTarget(folder, here))) return false
      }
      return GH.has(group) && !checkout && !words.includes("--")
    }
    if (INTERPRETERS.has(name) && args[0] && !args[0].value.startsWith("-")) {
      const script = pathOf(args[0], here)
      return (
        skillScript(script) &&
        !runsPrTests(
          script,
          args.slice(1).map((a) => a.value),
        )
      )
    }
    return false
  }
  const visit: Visit = async (cmd, parsed, env) => {
    if (!writesOwn(cmd, env)) allowed = false
    // the factory's run-slot runs its command after `--`, which is judged in its place
    if (parsed.name === "run-slot.sh" && parsed.first && permitted(cmd, parsed, env)) {
      const at = parsed.args.findIndex((a) => a.value === "--")
      return at === -1
        ? undefined
        : examine({ ...cmd, words: parsed.args.slice(at + 1) }, env, visit, false)
    }
    for (const reading of [parsed, ...parsed.also])
      if (!permitted(cmd, reading, env)) allowed = false
  }
  const variables = knownVariables(command, environment, directory)
  const env: Env = {
    cwd: directory,
    cwdSure: directory,
    files: new Map(),
    known: variables,
    old: { dir: directory },
    process: environment,
    vars: new Map(),
    visitShells: true,
  }
  await run(lex(command, variables), env, visit, true)
  return allowed && !(ownWrites && reshapes)
}

// Why the session is in read mode, or undefined when it serves the owner's own PRs alone: an outside PR's author is not the repo's owner, on a repo a user owns (an org repo's PRs are its colleagues'), and a PR the hook cannot read counts as outside.
export async function readMode(sessionId: unknown, lookup: Lookup): Promise<string | undefined> {
  const prs = (await lookup.prsOf(sessionId)).flatMap((url) => {
    const m = PULL.exec(url)
    return m ? [{ number: Number(m[2]), repo: m[1] }] : []
  })
  if (prs.length === 0) return REASONS.none
  for (const { number, repo } of prs) {
    const pr = await lookup.author(repo, number)
    if (!pr) return unread(repo, number)
    if (pr.ownerType === "User" && pr.author.toLowerCase() !== pr.owner.toLowerCase())
      return REASONS.outside
  }
}

export async function check(
  raw: string,
  environment: Environment = process.env,
  lookup: Lookup = live(environment),
): Promise<string | undefined> {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  const { cwd, session_id: sessionId, tool_input: toolInput, tool_name: tool } = input
  if (typeof tool !== "string") return
  const key = FILE_TOOLS.get(tool)
  // a Codex session's edit, whose command is the patch (codex.ts)
  const patch = tool === "apply_patch"
  if (!TOOLS.has(tool) && key === undefined && !patch) return
  const command = (toolInput as { command?: unknown } | undefined)?.command
  if (key === undefined && !patch && typeof command !== "string") return
  if (!CHECKERS.has(await sessionRole(environment, sessionId))) return
  const why = await readMode(sessionId, lookup)
  if (!why) return
  const directory = typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined
  // a file tool writes anywhere it wrote before, but into a git folder, and a path it cannot place counts as one
  if (key !== undefined || patch) {
    const named = patch
      ? typeof command === "string"
        ? patchPaths(command)
        : []
      : [(toolInput as Record<string, unknown> | undefined)?.[key!]]
    let git = named.length === 0
    try {
      git ||= named.some((path) => {
        if (typeof path !== "string") return true
        const at = isAbsolute(path)
          ? path
          : patch && directory
            ? resolve(directory, path)
            : undefined
        return gitFolder(at === undefined ? undefined : placed(at), lookup)
      })
    } catch {
      git = true
    }
    if (!git) return
    return `no-outside-pr-code hook keeps this reviewer or tester in read mode, which writes no file into a git folder (a .git part, or a folder holding HEAD, objects and refs), since its config and hooks name programs a later git read runs: ${why}`
  }
  if (typeof command !== "string") return
  let allowed = false
  try {
    const name = await lookup.name(sessionId)
    const data = dataDirOf(environment)
    const own = name ? [join(data, "scratch", name), join(data, "scratchpad", name)] : []
    allowed = await inspect(command, directory, environment, lookup, own)
  } catch {}
  if (allowed) return
  return `no-outside-pr-code hook keeps this reviewer or tester in read mode, which runs only reads, git's fetch, clone and detached checkout, gh, and a skill's scripts the main checkout tracks unchanged, and writes a file only into a folder already in its own scratch or scratchpad (make the folder in one call, then write in the next), outside any git folder: ${why}`
}

// A program's output when it exits 0, else its error text
async function output(argv: string[]): Promise<{ error: string; text?: string }> {
  const child = Bun.spawn(argv, { stderr: "pipe", stdout: "pipe" })
  const timer = setTimeout(() => child.kill(), 5000)
  try {
    const [text, error] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return (await child.exited) === 0 ? { error, text: text.trim() } : { error }
  } finally {
    clearTimeout(timer)
  }
}

const isPr = (read: unknown): read is Pr =>
  typeof read === "object" &&
  read !== null &&
  ["author", "owner", "ownerType"].every(
    (key) => typeof (read as Record<string, unknown>)[key] === "string",
  )

// A script's first line, or undefined when it cannot be read.
const firstLine = (script: string): string | undefined => {
  try {
    return readFileSync(script, "utf8").split("\n", 1)[0]
  } catch {
    return undefined
  }
}

// The runners that read no file from the folder they run in; every other runner (bun, bun-canary, deno, an env line read as a word it is not) is held to the main checkout's tree, so a shape runnerOf misreads fails closed.
const FOLDERLESS = new Set(["bash", "node", "python", "python3", "sh", "zsh"])
// env's options that take the next word as their value (an unset name, a folder, a search path)
const ENV_VALUED = new Set(["--chdir", "--unset", "-C", "-P", "-u"])

// Pure: the program a shebang line runs, by its name: the interpreter's own, or the word env runs after its options, assignments and -S's split (`#!/usr/bin/env -S bun --flag`, `env -u NAME bun`); undefined with no shebang, and "" for an env line it cannot read (an unknown option, a program built from a variable, no program at all).
export const runnerOf = (line: string | undefined): string | undefined => {
  if (!line?.startsWith("#!")) return undefined
  const [interpreter, ...rest] = line.slice(2).trim().split(/\s+/)
  if (!interpreter) return undefined
  if (basename(interpreter) !== "env") return basename(interpreter)
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (ENV_VALUED.has(word)) i++
    else if (word === "-S" || word === "--split-string" || /^-[iv0]+$/.test(word)) continue
    else if (/^(?:--(?:chdir|unset)=|-[CPu].)/.test(word) || word === "--ignore-environment")
      continue
    else if (word.startsWith("-S")) return /[$\\]/.test(word) ? "" : basename(word.slice(2))
    else if (word.startsWith("-")) return ""
    else if (!word.includes("=")) return /[$\\]/.test(word) ? "" : basename(word)
  }
  return ""
}

// Whether git, in the main checkout, reports a file tracked and unchanged from HEAD, with the session's GIT_ variables dropped, so the repository asked is the main checkout itself, and the path read literally, so a folder named as a glob matches no tracked file.
export function trackedIn(main: string, script: string): boolean {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  )
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "--literal-pathspecs", "-C", main, ...args], {
      env,
      stderr: "ignore",
      stdout: "ignore",
    }).exitCode === 0
  return (
    git("ls-files", "--error-unmatch", "--", script) &&
    git("diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--", script)
  )
}

// The machine's own lookup: the session's roster row by its registry name, and a PR's author by gh, kept in the data folder since it never changes; a read that fails is kept for the github rule's poll interval, so a PR GitHub cannot answer costs one call each interval and a checker waits minutes, not an hour.
export function live(environment: Environment): Lookup {
  const data = dataDirOf(environment)
  const cache = join(data, "hook-outside-pr")
  // github.pollMinutes, read at each kept failure so a change takes the next call; its default while the policy cannot be read
  const pollMs = async () => {
    const read = await readPolicy(data).catch(() => undefined)
    const settings = read?.settings ?? { schemaVersion: 1 as const, values: {} }
    return ruleSettings.get(settings, "github.pollMinutes") * 60_000
  }
  return {
    author: async (repo, pr) => {
      const file = join(cache, `${repo.replace("/", "__")}__${pr}.json`)
      try {
        const kept = (await Bun.file(file).json()) as { failedAt?: number } | Pr
        if (isPr(kept)) return kept
        if (typeof kept.failedAt === "number" && Date.now() - kept.failedAt < (await pollMs()))
          return
      } catch {}
      const jq =
        "{author: .user.login, owner: .base.repo.owner.login, ownerType: .base.repo.owner.type}"
      const argv = ["gh", "api", `repos/${repo}/pulls/${pr}`, "--jq", jq]
      const once = await output(argv)
      // a failure GitHub did not answer with a 4xx (a network error, a 5xx) is read once more after a second, so one blip does not hold the session in read mode for a poll interval
      const text =
        once.text ??
        (/HTTP 4\d\d/.test(once.error)
          ? undefined
          : (await Bun.sleep(1000).then(() => output(argv))).text)
      let read: unknown
      try {
        read = text ? JSON.parse(text) : undefined
      } catch {}
      try {
        mkdirSync(cache, { recursive: true })
        await Bun.write(file, JSON.stringify(isPr(read) ? read : { failedAt: Date.now() }))
      } catch {}
      return isPr(read) ? read : undefined
    },
    holds: (folder, entry) => existsSync(join(folder, entry)),
    // a guard runs from the main checkout (the settings' command cds there), so its folder is the checkout whose extensions hold the factory's own skills
    main: mainCheckout(process.cwd()),
    name: async (sessionId) => {
      if (typeof sessionId !== "string") return
      try {
        return await registryName(sessionId, environment)
      } catch {}
    },
    prsOf: async (sessionId) => {
      if (typeof sessionId !== "string") return []
      try {
        const name = await registryName(sessionId, environment)
        if (!name) return []
        const roster = (await Bun.file(join(data, "roster.json")).json()) as {
          agents?: { name?: unknown; pr?: unknown; prs?: unknown }[]
        }
        const row = roster.agents?.find((agent) => agent?.name === name)
        const listed = Array.isArray(row?.prs) ? row.prs : []
        return [...new Set([row?.pr, ...listed])].filter(
          (url): url is string => typeof url === "string",
        )
      } catch {
        return []
      }
    },
    runner: (script) => {
      const line = firstLine(script)
      return line === undefined ? "" : runnerOf(line)
    },
    tracked: (script) => trackedIn(mainCheckout(process.cwd()), script),
  }
}

if (import.meta.main) {
  const reason = await check(await input("no-outside-pr-code", "guard"))
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
