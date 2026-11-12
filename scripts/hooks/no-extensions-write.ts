// PreToolUse hook: refuses a factory session's write into the extensions root, where every guard's list, policy.json and each scope's sources live, and its playground CLI call that changes what a guard reads to allow or deny a call, so no session edits a list in one call and makes the guarded call in the next.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

import { dataDir } from "../../packages/env/src/data-dir"
import { scopesIn } from "../../packages/settings/src/folder"
// for its side effect: the job registry's settings, each job's default row and old names, which settingFields() then lists
import "../../packages/settings/src/jobs"
import {
  CORE,
  extensionsDir,
  loginOf,
  readPolicySync,
  scopeDir,
} from "../../packages/settings/src/rendered"
import { settingFields } from "../../packages/settings/src/settings"
import { eachInput } from "./codex"
import { bunCall, FILE_TOOLS, gitCall, real } from "./no-main-checkout"
import { fromFactory, opsLead } from "./role"
import {
  codeFed,
  type Command,
  type Env,
  examine,
  filled,
  GIT_TAKES,
  knownVariables,
  lex,
  marked,
  onlyReserved,
  ownFirst,
  parse,
  type Parsed,
  pathOf,
  places,
  PRINTERS,
  program,
  READ,
  run,
  SHELLS,
  shellOperand,
  slotWords,
  stdinOf,
  stdinShell,
  type Text,
  tick,
  UNKNOWN,
  unreadWord,
  varsSince,
  visible,
  type Visit,
  withDeadline,
  type Word,
} from "./shell"
import {
  held,
  heldReadings,
  heldWord,
  namings,
  NONE,
  QUALIFIER,
  quotedBodiesOut,
  singleQuotesOut,
  type Steady,
  steadyNames,
  unquoted,
} from "./steady"

type Environment = Record<string, string | undefined>

// a word as the call wrote it, else its value, with each part the hook cannot read shown as $…
const shown = (word: Word): string =>
  (word.raw ?? word.value).replaceAll(UNKNOWN, () => "$…").replaceAll(READ, () => "$…")

// Why a write under the root is refused, which both routes below open with
const WHY_ROOT =
  "every guard reads its list and policy.json from there, so a session's write would change what a guard allows."

const ROUTE = `${WHY_ROOT} A guard's list or setting changes only by the owner typing the playground command as a ! command in the dispatcher's terminal window, which runs without hooks: tell your lead, and the dispatcher hands the owner the command. A session writes nothing there by hand.`

// The guard keys Privacy on the Dashboard's Settings page saves at your login's scope, so a write there names that page as its route.
const PRIVACY_KEYS = new Set(["factory.archiveRepo", "owner.names"])
const PRIVACY = "at your login's scope, which Privacy on the Dashboard's Settings page saves"
const PRIVACY_ROUTE =
  "every guard reads policy.json from there, so a session's write would change what a guard allows: tell your lead, and the dispatcher asks the owner to save it in Privacy on the Dashboard's Settings page. A session writes nothing there by hand."

const refuse = (what: string) =>
  `no-extensions-write hook refuses ${what}: ${what.endsWith(PRIVACY) ? PRIVACY_ROUTE : ROUTE}`

// A refusal that likely names no write (`unwritten`), which the reader most often reaches by reading text as a path, so it routes to the lead as a likely false positive
const refuseUnwritten = (what: string) =>
  `no-extensions-write hook refuses ${what}: ${WHY_ROOT} If this command writes nothing, report it to your lead as a false positive.`

// text the shell runs as code where the lexer reads a plain word (evaluatedParts), read past by the reader, so code naming the root's folders may write there
const EVALUATES_ROOT =
  "text the shell runs as code (a glob qualifier, a parameter flag, a zsh =(…) or a prompt expansion) that names the guarded folder; run its commands as calls of their own, with no expansion that evaluates"
const TOO_LONG =
  "a command too long or nested too deep to read inside the hook's time: split it into shorter calls"

// Programs that only read what they name; rg, find and git read only without the options below that run a program.
const READERS = new Set([
  "[",
  "cat",
  "cmp",
  "diff",
  "grep",
  "head",
  "jq",
  "ls",
  "readlink",
  "realpath",
  "shasum",
  "stat",
  "tail",
  "test",
  "wc",
])
// find's actions that write, remove or run
const FIND_ACTS = /^-(?:delete|exec|execdir|fls|fprint|fprint0|fprintf|ok|okdir)$/
// find's actions that write the file named by the next word, a dash-led one too
const FIND_WRITES = /^-(?:fls|fprint|fprint0|fprintf)$/
const GIT_READS = new Set([
  "blame",
  "cat-file",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
])
// The builtins run() hands visit with no command of their own.
const EXPORTS = new Set(["declare", "export", "local", "readonly", "typeset"])
// Programs that remove or move what they name, so naming a folder above the root takes the root with it, and the guards fall back to core's smaller lists.
const REMOVERS = new Set(["find", "mv", "rm", "rmdir", "rsync", "unlink"])
// The removers whose macOS build stops reading options at the first operand, as getopt does, or reads none but a leading -- (unlink), so a later dashed word is an operand
const GETOPT_REMOVERS = new Set(["mv", "rm", "rmdir", "unlink"])
// rsync's options that write the path given as their value, read by any prefix since macOS's openrsync takes a shortened long name: its backup, partial and temp folders, its log file and its batch files
const RSYNC_PATHS = [
  "backup-dir",
  "log-file",
  "only-write-batch",
  "partial-dir",
  "temp-dir",
  "write-batch",
]
// rsync's flags whose exact name is a prefix of a path option, which both builds read as the flag
const RSYNC_FLAGS = new Set(["backup", "partial"])
// rsync's -T, its temp folder, in a short cluster whose earlier letters take no value (-B, -e, -f, -M and -@ do)
const RSYNC_TEMP = /^-[^-@BefMT]*T/
// Programs that write the paths they are given and remove none, each judged on its targets (writeTargets)
const WRITERS = new Set(["cp", "dd", "install", "ln", "mkdir", "tee", "touch"])
// Homebrew's GNU coreutils and findutils under their g prefix (gcp, grm, gfind): a coreutils name reads as the remover or writer it names, and gfind and gxargs are examined again as find and xargs, so the tool lookup never yields either
const GNU_NAMED = /^g(cp|dd|find|install|ln|mkdir|mv|rm|rmdir|tee|touch|unlink|xargs)$/
// A writer's options that take a value rather than name a target, by short letter (`gnu` for a GNU build alone, `bsd` for macOS's alone) and GNU's long name, with the long flags whose exact name wins over a value option it prefixes: cp's and ln's suffix, install's suffix, flags, group, mode, owner, strip program, and macOS's destdir, hash, link flags, metalog and tags, mkdir's mode, mv's suffix, touch's adjustment, date, reference file and stamp; cp's, install's, ln's and mv's -t names their target folder, and macOS install's -M its metalog, read apart
const WRITER_TAKES: Record<
  string,
  { bsd?: string; flags?: string[]; gnu?: string; long: string[]; short: string }
> = {
  cp: { gnu: "S", long: ["no-preserve", "sparse", "suffix"], short: "" },
  install: {
    bsd: "BDfhlMT",
    flags: ["strip"],
    gnu: "S",
    long: ["group", "mode", "owner", "strip-program", "suffix"],
    short: "gmo",
  },
  ln: { gnu: "S", long: ["suffix"], short: "" },
  mkdir: { long: ["mode"], short: "m" },
  mv: { gnu: "S", long: ["suffix"], short: "" },
  touch: { long: ["date", "reference", "time"], short: "Adrt" },
}
const DUPLICATE = /^(?:\d+|-)$/
// Whether a redirect writes a file: >, >>, >|, <> or >& to a name, not an fd
const writer = ({ op, target }: { op: string; target?: Word }): boolean =>
  [">", ">>", ">|", "<>"].includes(op) || (op === ">&" && !DUPLICATE.test(target?.value ?? ""))

// Whether a line as typed holds a redirect that writes a file, a subshell's included; a redirect read out of a quoted text (`awk 'NR>1'` read as a line) is none
function redirectsWrite(commands: Command[]): boolean {
  return commands.some(
    (cmd) => cmd.redirects.some(writer) || (!!cmd.inner && redirectsWrite(cmd.inner())),
  )
}

// A case statement's opener, `case <word> in <pattern>`, its reserved words before it skipped
function caseOpener(cmd: Command): boolean {
  const at = cmd.words.findIndex((w) => w.value === "case" && !w.quoted)
  const before = cmd.words.slice(0, Math.max(at, 0))
  const word = cmd.words[at + 2]
  return (
    at !== -1 &&
    (before.length === 0 || onlyReserved({ ...cmd, words: before })) &&
    word?.value === "in" &&
    !word.quoted
  )
}

// The commands of a line that are a case statement's patterns, which the shell matches and never runs: the run of piped alternatives a ) ends, after the opener's `in` or a `;;`, with no redirect of its own
function casePatterns(commands: Command[]): Set<Command> {
  const out = new Set<Command>()
  for (let k = 0; k < commands.length; k++) {
    if (!caseOpener(commands[k]) && commands[k].follows !== ";;") continue
    let end = k
    while (commands[end + 1]?.follows === "|") end++
    const body = commands[end + 1]
    const run = commands.slice(k, end + 1)
    if (body?.follows !== ")" || run.some((c) => c.redirects.length > 0 || c.scope !== body.scope))
      continue
    for (const c of run) out.add(c)
  }
  return out
}
const GLOB = /[*?[{(]/
// Variables that make git or a pager run a program, or point git at a config file that can, so a reader with one set is judged as any other program.
const RUNS = /^(?:EDITOR|GIT_[A-Z0-9_]+|HOME|LESSOPEN|PAGER|VISUAL|XDG_CONFIG_HOME)$/
// git's variables that only name an author or a committer, text git never runs
const GIT_TEXT = /^GIT_(?:AUTHOR|COMMITTER)_/
const CLI = join("packages", "scripts", "src", "playground", "cli.ts")

// Whether a scope's variables set one that makes git or a pager run a program, each name read once.
const varsRun = new WeakMap<Map<string, Text>, [number, boolean]>()
function runsVariable(vars: Map<string, Text>): boolean {
  const [cursor, found] = varsRun.get(vars) ?? [undefined, false]
  const [keys, next] = varsSince(vars, cursor)
  const now = found || keys.some((key) => RUNS.test(key))
  varsRun.set(vars, [next, now])
  return now
}

// Whether a command only reads what it names: a reader with no option or variable that makes it run a program.
function reads(parsed: Parsed, env: Env): boolean {
  const { args, local, name } = parsed
  if ([...local.keys()].some((key) => RUNS.test(key)) || runsVariable(env.vars)) return false
  if (READERS.has(name) || PRINTERS.has(name)) return true
  if (name === "rg") return !args.some((a) => /^--(?:hostname-bin|pre)(?:=|$)/.test(a.value))
  if (name === "find") return !args.some((a) => FIND_ACTS.test(a.value))
  if (name !== "git") return false
  const { rest, sub } = gitCall(args, env)
  const before = args.slice(0, args.length - rest.length - 1).map((a) => a.value)
  return (
    !!sub &&
    (GIT_READS.has(sub) || (sub === "worktree" && rest[0] === "list")) &&
    !before.some((w) => /^-c|^--(?:config-env|exec-path)/.test(w)) &&
    !rest.some((w) => /^(?:--output|-O|--open-files-in-pager|--ext-diff|--textconv)/.test(w))
  )
}

// gh's calls that only read, a closed list, whose -q or --jq filter and -t or --template template are text that no shell runs
const GH_READS = new Set([
  "api",
  "issue list",
  "issue view",
  "pr list",
  "pr view",
  "run list",
  "run view",
  "search",
])
// a gh api option that sends, and a read's option that opens the browser, each alone or in a cluster of short flags ahead of a filter's or template's own letter
const GH_API_SENDS = /^(?:-[^-=qt]*[FXf]|--(?:cache|field|input|method|raw-field)(?:=|$))/
const GH_WEB = /^(?:-[^-=qt]*w|--web(?:=|$))/

// The words of a read-only gh call's jq filter or Go template (`-q '<filter>'`, `--jq=<filter>`, `-t '<template>'`), read as text rather than a command line; none for any other gh call. A pager or editor variable set on the line needs no check here, since an assignment or an export keeps the line from being read call by call.
function ghFilters(parsed: Parsed): Set<Word> {
  const { args, first, name } = parsed
  const filters = new Set<Word>()
  if (name !== "gh" || !first || marked(first.value)) return filters
  const [verb, sub] = args.map((a) => a.value)
  const call = verb === "api" || verb === "search" ? verb : `${verb} ${sub}`
  if (!GH_READS.has(call)) return filters
  // gh api with a method, a field, an input file or a cache writes or sends, and --web opens a browser, so neither is a reader
  if (verb === "api" && args.some((a) => GH_API_SENDS.test(a.value))) return filters
  if (args.some((a) => GH_WEB.test(a.value))) return filters
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (["-q", "--jq", "-t", "--template"].includes(value) && args[k + 1]) filters.add(args[++k])
    else if (/^(?:-[qt].|--(?:jq|template)=)/.test(value)) filters.add(args[k])
  }
  return filters
}

// gh's calls that post a title or a body, which gh sends as text and never runs
const GH_POSTS = new Set([
  "issue comment",
  "issue create",
  "issue edit",
  "pr comment",
  "pr create",
  "pr edit",
])

// The words of a gh post's title or body (`--title '<text>'`, `-b '<text>'`, `--body=<text>`), read as text rather than a command line; none for any other gh call, nor for one that opens an editor or a browser
function ghTexts(parsed: Parsed): Set<Word> {
  const { args, first, name } = parsed
  const texts = new Set<Word>()
  if (name !== "gh" || !first || marked(first.value)) return texts
  const [verb, sub] = args.map((a) => a.value)
  if (!GH_POSTS.has(`${verb} ${sub}`)) return texts
  if (args.some((a) => GH_WEB.test(a.value) || /^(?:-[^-=bt]*e|--editor(?:=|$))/.test(a.value)))
    return texts
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (["-b", "--body", "-t", "--title"].includes(value) && args[k + 1]) texts.add(args[++k])
    else if (/^(?:-[bt].|--(?:body|title)=)/.test(value)) texts.add(args[k])
  }
  return texts
}

// The values git's -c options set before its subcommand (`-c k=v`, `-ck=v`)
function gitConfigs(args: Word[]): Word[] {
  const configs: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (value === "-c" && args[k + 1]) configs.push(args[++k])
    else if (value.startsWith("-c") && value.length > 2) configs.push(args[k])
    else if (GIT_TAKES.has(value)) k++
    else if (!value.startsWith("-")) break
  }
  return configs
}

// A word past the literal prefix a writer reads its target after (`of=`, `-t`, `--target-directory=`), its raw text cut alike so held() reads the rest; with no raw text that opens with the prefix, an unread rest stays unheld
const after = (word: Word, cut: number): Word => ({
  ...word,
  raw: word.raw?.startsWith(word.value.slice(0, cut)) ? word.raw.slice(cut) : undefined,
  value: word.value.slice(cut),
})

// The words a writer writes to: dd's of= value and any word of its it cannot read, the -t folder of cp, install, ln and mv (GNU's short, attached and shortened long spellings) or else their last operand, ln's shell folder for a lone operand, and every operand of install -d, mkdir, tee and touch; and every word the shell may split (`Word.splits`), since one of its words may land as a target
function writeTargets(name: string, args: Word[], gnu: boolean, posix = false): Word[] {
  const splits = args.filter((word) => word.splits)
  if (name === "dd")
    return [
      ...new Set([
        ...args.flatMap((word) =>
          word.value.startsWith("of=")
            ? [after(word, 3)]
            : marked(word.value) && !/^[a-z]+=/.test(word.raw ?? word.value)
              ? [word]
              : [],
        ),
        ...splits,
      ]),
    ]
  const into = name === "cp" || name === "install" || name === "ln" || name === "mv"
  const takes = WRITER_TAKES[name]
  const operands: Word[] = []
  let folder: Word | undefined
  let folders = false
  // GNU's cp, install, ln and mv read an unread word before `--` that expands to -t<folder> as their target folder
  const maybe: Word[] = []
  // the file macOS's install writes its metalog to
  const logs: Word[] = []
  for (let k = 0, options = true; k < args.length; k++) {
    const word = args[k]
    const { value } = word
    if (into && gnu && options && marked(value)) maybe.push(word)
    if (!options || value === "-" || !value.startsWith("-")) {
      operands.push(word)
      // macOS's getopt stops at the first operand, as GNU's does under POSIXLY_CORRECT, so a later dashed word is an operand
      if (!gnu || posix) options = false
    } else if (value === "--") options = false
    else if (value.startsWith("--")) {
      // a long option GNU reads by any prefix, its value attached after = or as the next word
      const [, long, attached] = /^--([^=]*)(=?)/.exec(value) ?? []
      if (into && "target-directory".startsWith(long))
        folder = attached ? after(word, long.length + 3) : args[++k]
      else if (name === "install" && "directory".startsWith(long)) folders = true
      else if (
        !attached &&
        !takes?.flags?.includes(long) &&
        takes?.long.some((take) => take.startsWith(long))
      )
        k++
    } else
      // a short cluster read letter by letter up to the first that takes a value, whose value is the cluster's rest or else the next word
      for (let i = 1; i < value.length; i++) {
        const letter = value[i]
        if (name === "install" && letter === "d") folders = true
        else if (into && letter === "t") {
          folder = i + 1 < value.length ? after(word, i + 1) : args[++k]
          break
        } else if (
          takes?.short.includes(letter) ||
          (gnu ? takes?.gnu : takes?.bsd)?.includes(letter)
        ) {
          const rest = i + 1 < value.length
          if (!gnu && name === "install" && letter === "M") {
            const log = rest ? after(word, i + 1) : args[k + 1]
            if (log) logs.push(log)
          }
          if (!rest) k++
          break
        }
      }
  }
  // ln's lone operand links into the shell's folder, unless the shell splits it into more operands
  if (name === "ln" && !folder && operands.length === 1)
    return [{ quoted: false, value: "." }, ...splits]
  const targets = into && !folders ? (folder ? [folder] : operands.slice(-1)) : operands
  // macOS's cp, ln and mv take no target option and write to their last operand, so a split word moves no target there
  const moved = into && !gnu && name !== "install" ? [] : splits
  return [...new Set([...targets, ...maybe, ...logs, ...moved])]
}

// The settings keys a guard reads to allow or deny a call, A to Z: the hooks' (no-chat-question, no-glm-heavy-path, no-headless-login, no-playground-leak, no-public-leak, and role.ts, which places a session in the factory), spawn.sh's code root, and ext.repos, which names the repository each scope syncs from; every jobs.<name> is refused beside them (JOB_PREFIX).
export const GUARD_KEYS = new Set([
  "ext.links",
  "ext.order",
  "ext.repos",
  "factory.archiveRepo",
  "factory.publicRepo",
  "glm.readOnlyLoad5",
  "live.branch",
  "owner.names",
  "paths.codeRoot",
  "sessions.aliases",
  "sessions.names",
  "slack.gatedSends",
  "usage.keychainService",
])
// An ops job's setting turns it on or moves what it runs, so every jobs.<name> is refused, a name the registry lacks included, but the Ops lead's change of its interval alone (tunes()): only the owner's Approve of a guard decision, or Settings > Jobs, sets any other.
const JOB_PREFIX = "jobs."
// Whether a settings set the Ops lead makes only tunes a number, so it runs; a key that widens or names what a guard allows stays the owner's
type Tuning = (key: string, value: string, scoped: boolean) => boolean
const NO_TUNING: Tuning = () => false
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// What a job's key holds: the row the login's scope stores, {} when it stores none, whether another scope stores one or any scope one under an old name, and the whole row policy.json renders over the registry's entry, the entry itself when no scope stores a row
export type Held = { elsewhere: boolean; rendered: unknown; stored: Record<string, unknown> }

// Pure: whether a set of the key to the value text, as the CLI parses it, only tunes a number: glm.readOnlyLoad5 to a positive load limit, or a job's row equal field for field to the row the login's scope stores but a schedule of a positive integer interval, where the rendered row already runs on one; a set replaces the stored row and the render reads each field it leaves out from the registry, so the stored row is what it must keep, and a --scope, a row another scope stores, a job neither policy.json nor the registry holds and any other key tune nothing
export function tunes(
  key: string,
  text: string,
  scoped: boolean,
  held: (key: string) => Held | undefined,
): boolean {
  if (scoped) return false
  const value = parsed(text)
  if (key === "glm.readOnlyLoad5")
    return typeof value === "number" && Number.isFinite(value) && value > 0
  if (!key.startsWith(JOB_PREFIX) || !isRecord(value)) return false
  const row = held(key)
  if (row === undefined || row.elsewhere || !isRecord(row.rendered)) return false
  const ran = row.rendered.schedule
  if (!isRecord(ran) || typeof ran.every !== "number") return false
  const { schedule } = value
  return (
    isRecord(schedule) &&
    Object.keys(schedule).length === 1 &&
    typeof schedule.every === "number" &&
    Number.isInteger(schedule.every) &&
    schedule.every > 0 &&
    Bun.deepEquals({ ...value, schedule: null }, { ...row.stored, schedule: null }, true)
  )
}

const storedAt = (data: string, scope: string): Record<string, unknown> | undefined => {
  const file = join(scopeDir(data, scope), "settings.json")
  if (!existsSync(file)) return {}
  try {
    const values: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isRecord(values) ? values : undefined
  } catch {
    return undefined
  }
}

// The Ops lead's tuning read against the login's stored rows, every other scope's and policy.json's, or none when the login, a scope's settings.json or policy.json does not read
function tuningOf(environment: Environment): Tuning {
  const data = dataDir(environment)
  const policy = readPolicySync(data)
  if (policy.refusal !== undefined) return NO_TUNING
  let login: string
  try {
    login = loginOf(data, environment)
  } catch {
    return NO_TUNING
  }
  const others = [CORE, ...scopesIn(data)].filter((scope) => scope !== login)
  const own = storedAt(data, login)
  const theirs = others.map((scope) => storedAt(data, scope))
  if (own === undefined || theirs.some((values) => values === undefined)) return NO_TUNING
  const { values } = policy.settings
  const held = (key: string): Held | undefined => {
    const stored = own[key] ?? {}
    if (!isRecord(stored)) return undefined
    const field = settingFields().find((entry) => entry.key === key)?.field
    const old = field?.aliases ?? []
    return {
      elsewhere:
        old.some((name) => name in own) ||
        theirs.some((at) => at !== undefined && [key, ...old].some((name) => name in at)),
      rendered: values[key] ?? field?.default,
      stored,
    }
  }
  return (key, value, scoped) => tunes(key, value, scoped, held)
}

// Whether a line is one playground call alone, its first word the CLI's, so no assignment, export, env, wrapper, group, substitution or other command on it moves where its set lands (PLAYGROUND_LOGIN or the data folder) from the scope the hook reads
const loneCall = (commands: Command[]): boolean => {
  const [cmd] = commands
  return (
    commands.length === 1 &&
    cmd.words[0]?.value === "playground" &&
    !cmd.inner &&
    [...cmd.words, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))].every(
      (word) => !word.procs,
    )
  )
}

const BY_APPROVE =
  "a key only the owner sets: post a guard decision with playground ask new (.agents/dashboard/asks.md), whose Approve writes it"
// ext verbs that change a scope's lists or settings, or which scopes the lists and policy.json render from
const EXT_WRITES = new Set(["add", "import", "init", "link", "order", "remove", "sync", "unlink"])
// the ext verbs whose --dry-run writes nothing
const EXT_DRY = new Set(["add", "import", "init"])
// Each command's bare switches, as its parseWords call names them; every other -- word takes the next word as its value.
const SWITCHES: Record<string, string[]> = {
  ext: ["--dry-run", "--yes"],
  settings: ["--dry-run"],
}

// Whether a word is the playground CLI: the command by name in any case, as macOS's filesystem reads it, or by a path that is no folder, or the checkout's cli.ts, with or without its extension, links followed.
function isCli(word: Word, dirs: (string | undefined)[]): boolean {
  tick()
  if (marked(word.value) || word.value.startsWith("-")) return false
  const paths = dirs.map((dir) => pathOf(word, { cwd: dir } as Env))
  if (program(word.value) === "playground")
    return (
      !word.value.includes("/") ||
      !paths.some((path) => !!path && existsSync(path) && statSync(path).isDirectory())
    )
  const cli = (sep + CLI).toLowerCase()
  return paths.some(
    (path) => !!path && [path, `${path}.ts`].some((at) => real(at).toLowerCase().endsWith(cli)),
  )
}

// The words after each word of a command that is the playground CLI, so the CLI behind any wrapper (bun, npx, find -exec, arch, watch) is read as typed bare.
function cliCalls(parsed: Parsed, env: Env): Word[][] {
  const { args, first, name } = parsed
  if (!first) return []
  const words = [first, ...args]
  const dirs = [env.cwd, name === "bun" ? bunCall(args, env).cwd : undefined]
  return words.flatMap((word, at) => (isCli(word, dirs) ? [words.slice(at + 1)] : []))
}

// The variables a score's author is read from (store.ts, terminalIo); an ext score whose line clears or sets one reads as another author.
const IDENTITY = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "PLAYGROUND_ROLE"]
const SETS = /^(?:CLAUDE_CODE_SESSION_ID|CLAUDE_CONFIG_DIR|PLAYGROUND_ROLE)\+?=/
// env's options that clear the whole environment: -i alone or in any cluster of short options, --ignore-environment, or a bare -
const CLEARS = /^(?:-[^-\s]*i|--ignore-environment$|-$)/
const SCORE = /\bext\s+score\b/
const SCORE_AS_OTHER = `playground ext score on a line that clears or sets ${IDENTITY.join(", ")}, which reads as another author than the calling session`

// Whether words clear or set an identity variable: an assignment or += to one, or env beside -u or --unset naming one or an option that clears the environment.
const changes = (words: Word[]): boolean =>
  words.some((w) => SETS.test(w.value)) ||
  (words.some((w) => program(w.value) === "env") &&
    words.some((w) => CLEARS.test(w.value) || IDENTITY.some((k) => w.value.includes(k))))

// Whether any command on a line, inside its groups and substitutions included, clears or sets an identity variable.
function changesIdentity(commands: Command[]): boolean {
  return commands.some(
    (cmd) =>
      changes(cmd.words) ||
      (!!cmd.inner && changesIdentity(cmd.inner())) ||
      [...cmd.words, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))].some(
        (word) => !!word.procs && changesIdentity(word.procs),
      ),
  )
}

// Whether a playground call, its words after the CLI word, is an ext score whose own command clears or sets an identity variable, or runs after the scope set or exported one, as a line a shell reads on its own does.
function scoreAsOther(words: Word[], cmd: Command, parsed: Parsed, env: Env): boolean {
  if (words[0]?.value !== "ext" || words[1]?.value !== "score") return false
  if (IDENTITY.some((k) => parsed.local.has(k) || env.vars.has(k))) return true
  const all = parsed.first ? [parsed.first, ...parsed.args] : parsed.args
  const at = cmd.words.indexOf(all[all.length - words.length - 1])
  return changes(at === -1 ? cmd.words : cmd.words.slice(0, at))
}

const AWKS = new Set(["awk", "gawk", "mawk", "nawk"])
// what lets an awk program run a command or write a file: system(), a > redirect or an @ directive, and a | pipe outside the literals awkPipe allows, the one way a getline runs a command (`"cmd" | getline`), since a plain getline or one from a file only reads
const AWK_RUNS = /system|[>@]/
// a regex literal where awk reads only a pattern: at the program's start or after {, }, ;, !, (, ,, ~, &&, || or a newline, holding no quote, no [ and no newline, so a > in it (`/^>>>>>>> /`) is a character it matches, never a redirect
const AWK_PATTERN = /(^|[{};!(,~\n]|&&|\|\|)(\s*)\/(?:[^\\/"[\n]|\\.)*\//g
const awkRuns = (program: string) =>
  AWK_RUNS.test(program.replace(AWK_PATTERN, "$1$2RE")) || awkPipe(program)

// The literals a | may sit in without piping: a regex that is the program's whole leading pattern (`/a|b/`, `/a|b/ {…}`), and a regex or a string right after ~ (`$1 ~ /a|b/`, `$1 ~ "a|b"`), each holding no quote, no [ and no newline
const AWK_LEAD = /^\s*\/(?:[^\\/"[\n]|\\.)*\/(?=\s*(?:\{|$))/
const AWK_MATCH = /~\s*(?:\/(?:[^\\/"[\n]|\\.)*\/|"[^"\\\n]*")/g

// Whether a program holding a | may pipe: once the allowed literals are cut out, any |, quote, /, # or backslash left counts as one, as canary counted every |
function awkPipe(program: string): boolean {
  if (!program.includes("|")) return false
  return /["/#\\|]/.test(program.replace(AWK_LEAD, " ").replace(AWK_MATCH, " "))
}

// awk's program words, or undefined when a program comes from a file or an option the hook does not know: -F and -v take a value, gawk's -e and --source a program, and the first other word is the program
function awkPrograms(words: Word[]): Word[] | undefined {
  const programs: Word[] = []
  for (let k = 0; k < words.length; k++) {
    const { value } = words[k]
    if (value === "--") return programs.length ? programs : words.slice(k + 1, k + 2)
    if (/^-[Fv]$/.test(value)) k++
    else if (/^-[Fv]./.test(value)) continue
    else if (value === "-e" || value === "--source") programs.push(words[++k] ?? { value: "" })
    else if (value.startsWith("--source=")) programs.push({ ...words[k], value: value.slice(9) })
    else if (value.startsWith("-")) return undefined
    else return programs.length ? programs : [words[k]]
  }
  return programs.length ? programs : undefined
}

const EVALUATES = new Set(["-e", "-ep", "--eval", "-p", "-pe", "--print"])
// An inline evaluator's program word, JavaScript the shell never reads as a line: bun's or node's -e, --eval, -p or --print value (-pe and -ep included) among the options before any script, or agent-browser's eval script; undefined for any other call
function evalProgram({ args, name }: Parsed): Word | undefined {
  // agent-browser's eval after its options, a --name option's value (`--session foo`) included
  if (name === "agent-browser") {
    for (let k = 0; k < args.length; k++) {
      const { value } = args[k]
      if (value === "eval") return args[k + 1]
      const option = args[k - 1]?.value ?? ""
      if (!value.startsWith("-") && !(option.startsWith("--") && !option.includes("="))) return
    }
    return
  }
  if (name !== "bun" && name !== "node") return
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (EVALUATES.has(value)) return args[k + 1]
    if (/^--(?:eval|print)=/.test(value)) return args[k]
    if (!value.startsWith("-")) return
  }
}

// the tokens after which a / can only open a regex: none, opening punctuation, a binary or prefix operator (a + or - but one of a postfix ++ or --, a ! but TypeScript's non-null one), an arrow, or a reserved word that takes an expression and names no member; after any other token a / may divide, so the scan masks nothing there
const REGEX_AFTER =
  /(?:^|[(,=:[{;?~^%*&|]|=>|(?<![\w$)\]}"'`]\s*)!|(?<!\+)\+|(?<!-)-|(?<!\.\s*)(?<![\w$#])(?:case|delete|do|else|in|instanceof|new|return|throw|typeof|void))\s*$/
// a program that can turn a regex into text, so its body could reach a pipe or a file as words
const STRINGIFIES =
  /\.source\b|\btoString\b|\bString\s*\(|\bJSON\s*\.\s*stringify\b|\.concat\s*\(|\.join\s*\(|\$\{/
// A JavaScript program with each regex literal outside its strings, templates and comments masked to a word that is neither a path, a glob nor a redirect, or the program unchanged when it can turn a regex into text or the scan cannot close a literal; a regex that guarded() finds a guarded word in, one holding a quote (a division read as a regex would hide the string it runs), or one a + or a member other than test or exec follows, keeps its text
function maskRegexes(source: string, guarded: (body: string) => boolean): string {
  if (STRINGIFIES.test(source)) return source
  let out = ""
  let k = 0
  while (k < source.length) {
    const c = source[k]
    const close = (end: string, from: number) => {
      for (let j = from; j < source.length; j++) {
        if (source[j] === "\\") j++
        else if (source.startsWith(end, j)) return j + end.length
      }
      return -1
    }
    const end =
      c === '"' || c === "'" || c === "`"
        ? close(c, k + 1)
        : source.startsWith("//", k)
          ? close("\n", k + 2)
          : source.startsWith("/*", k)
            ? close("*/", k + 2)
            : undefined
    if (end === -1) return source
    if (end !== undefined) {
      out += source.slice(k, end)
      k = end
      continue
    }
    if (c === "/" && REGEX_AFTER.test(out)) {
      let j = k + 1
      let inClass = false
      for (; j < source.length && source[j] !== "\n"; j++) {
        if (source[j] === "\\") j++
        else if (source[j] === "[") inClass = true
        else if (source[j] === "]") inClass = false
        else if (source[j] === "/" && !inClass) break
      }
      if (source[j] !== "/") return source
      let flags = j + 1
      while (/[a-z]/.test(source[flags] ?? "")) flags++
      const body = source.slice(k + 1, j)
      const kept =
        guarded(body.replaceAll("\\/", "/")) ||
        /["'`]/.test(body) ||
        /^\s*(?:\+|\.(?!\s*(?:test|exec)\b))/.test(source.slice(flags))
      out += kept ? source.slice(k, flags) : "RE"
      k = flags
      continue
    }
    out += c
    k++
  }
  return out
}

// The lines an awk program runs, read whatever the line: each string literal of a program that can run a command or write a file
function programLines({ args, first }: Parsed, rooted: boolean): string[] {
  if (!AWKS.has(program(first?.value ?? ""))) return []
  return (awkPrograms(args) ?? [])
    .filter(({ value }) => rooted || awkRuns(value))
    .flatMap(({ value }) => [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]))
}

const SEDS = new Set(["gsed", "sed"])
// Whether a word is read as written: no glob and no part the hook cannot read
const literal = (w: Word) => !w.glob && !marked(w.value)
// sed's options that write nothing and read no script from elsewhere: -E, -n, -r, -s, -u and -z, alone or clustered, and their long names
const SED_FLAG =
  /^-[Enrsuz]+$|^--(?:null-data|posix|quiet|regexp-extended|separate|silent|unbuffered)$/
// a bracket expression holding no / and no [, which BSD sed reads whole and GNU sed reads to the same end, so both end its regex at one /
const SED_BRACKET = String.raw`\[\^?\]?[^\]/[\n]*\]`
// a regex's body up to its closing /, a / inside a bracket expression held by SED_BRACKET alone
const SED_BODY = String.raw`(?:[^/\\\n[]|\\.|${SED_BRACKET})*/`
// a replacement's text up to its closing /
const SED_TEXT = String.raw`(?:[^/\\\n]|\\.)*/`
const SED_ADDRESS = String.raw`(?:\d+|\$|/${SED_BODY})`
const SED_ITEM = String.raw`[ \t]*(?:${SED_ADDRESS}(?:[ \t]*,[ \t]*(?:${SED_ADDRESS}|[+~]\d+))?[ \t]*!?[ \t]*)?(?:[=dlnNpPqQ]|s/${SED_BODY}${SED_TEXT}[giImMp0-9]*)[ \t]*`
// a sed script read whole by a closed grammar: addresses, then =, d, l, n, N, p, P, q, Q or s/// with flags from g, i, I, m, M, p and digits, so it holds no w or W write, no e run and no r read of another file
const SED_SCRIPT = new RegExp(String.raw`^${SED_ITEM}(?:[;\n]${SED_ITEM})*;?$`)

// Whether a sed call only reads and prints: every option on SED_FLAG's list, and every script (each -e value, else the first operand) a literal word, unglobbed, that SED_SCRIPT holds
function sedReads(args: Word[]): boolean {
  const scripts: Word[] = []
  const operands: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (value === "-e" || value === "--expression") {
      if (!args[k + 1]) return false
      scripts.push(args[++k])
    } else if (value.startsWith("--expression="))
      scripts.push({ ...args[k], value: value.slice("--expression=".length) })
    else if (value === "--") {
      operands.push(...args.slice(k + 1))
      break
    } else if (value.startsWith("-") && value !== "-") {
      if (!SED_FLAG.test(value)) return false
    } else operands.push(args[k])
  }
  const read = scripts.length ? scripts : operands.slice(0, 1)
  return read.length > 0 && read.every((w) => literal(w) && SED_SCRIPT.test(w.value))
}

// sed's in-place option as macOS sed reads it: -i after any of -E, -n, -r, -s, -u and -z, its backup suffix attached (holding no / or *, which GNU writes into another folder) or, when nothing is attached, the next word
const SED_IN_PLACE = /^-[Enrsuz]*i([\w.~-]*)$/
// a bare -i's suffix word: empty or a dot and letters, so a GNU sed, which reads that word as its script, reads it as no command or none it knows
const SED_SUFFIX = /^(?:\.[\w.~-]*)?$/
const SED_EDIT_ADDRESS = String.raw`(?:\d+|\$|/${SED_BODY})`
const SED_EDIT_ITEM = String.raw`[ \t]*(?:${SED_EDIT_ADDRESS}(?:[ \t]*,[ \t]*${SED_EDIT_ADDRESS})?[ \t]*)?(?:[dp]|s/${SED_BODY}${SED_TEXT}[gpI0-9]*)[ \t]*`
// an in-place sed's script read whole by its allowlist: line, $ or /regex/ addresses and their ranges, then d, p, or s/// with flags from g, p, I and digits; every other command and flag (w, W, r, R, e, s///w, s///e) is off it
const SED_EDIT = new RegExp(String.raw`^${SED_EDIT_ITEM}(?:[;\n]${SED_EDIT_ITEM})*;?$`)

// The scripts of a sed call that edits its files in place and writes nothing else, or undefined, its argv read as macOS sed reads it: sed as its own program (ownProgram) with no variable set in the call, an in-place option (SED_IN_PLACE) whose bare form takes the next word as its suffix (SED_SUFFIX), every other option on -E, -n, -r, -s, -u and -z, and every script (each -e value, else the first operand) a literal word that SED_EDIT holds, while each other operand, a file it edits, is judged as any word is
function sedInPlace(cmd: Command, parsed: Parsed): Set<Word> | undefined {
  const { args, local, name } = parsed
  if (!SEDS.has(program(name)) || local.size > 0 || !ownProgram(cmd, parsed)) return undefined
  const scripts: Word[] = []
  const operands: Word[] = []
  let inPlace = false
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    const suffix = SED_IN_PLACE.exec(value)
    if (value === "-e") {
      if (!args[k + 1]) return undefined
      scripts.push(args[++k])
    } else if (value === "--") {
      operands.push(...args.slice(k + 1))
      break
    } else if (suffix) {
      inPlace = true
      if (suffix[1]) continue
      const word = args[++k]
      if (!word || !literal(word) || !SED_SUFFIX.test(word.value)) return undefined
    } else if (value.startsWith("-") && value !== "-") {
      if (!/^-[Enrsuz]+$/.test(value)) return undefined
    } else operands.push(args[k])
  }
  const read = scripts.length ? scripts : operands.slice(0, 1)
  if (!inPlace || read.length === 0) return undefined
  if (!read.every((w) => literal(w) && SED_EDIT.test(w.value))) return undefined
  return new Set(read)
}

// perl's options that run no other code and write nothing: a, l, n, p and w clustered, the last of them may be e or E, whose script is the next word; -d, -i, -I, -m, -M, -s, -x and the rest are off it
const PERL_FLAG = /^-[alnpw]*[eE]?$/
// a regex with no variable, no array and no code block (`(?{`, `(??{`, `(*{`), its $ only an anchor
const PERL_BODY = String.raw`(?:[^/\\\n@$(]|\((?![?*]\??\{)|\\.|\$(?=[/|)]))*/`
const PERL_RE = `/${PERL_BODY}`
// a match variable, $1 to $9 or $&, before no [, { or ->, since perl reads one there as a subscript and runs its expression as code
const PERL_MATCH = String.raw`\$[1-9&](?![[{]|->)`
// a value print may name: a string holding only text, \n, \t and the match variables $1 to $9 and $&, or one of those variables, or $_
const PERL_VALUE = String.raw`(?:"(?:[^"\\$@\n]|\\[nt"\\]|${PERL_MATCH})*"|\$[1-9&_])`
const PERL_PRINT = String.raw`print(?:[ \t]+${PERL_VALUE}(?:[ \t]*,[ \t]*${PERL_VALUE})*)?(?:[ \t]+(?:for|if|unless|while)[ \t]+${PERL_RE}[gimsx]*)?`
const PERL_SUB = String.raw`s/${PERL_BODY}(?:[^/\\\n@$]|\\.|${PERL_MATCH})*/[gimsx]*`
const PERL_ITEM = String.raw`[ \t]*(?:${PERL_PRINT}|${PERL_SUB})[ \t]*`
// a perl one-liner read whole by a closed grammar: print statements of match variables and plain strings, each optionally under for, if, unless or while a regex, and s/// with flags from g, i, m, s and x, so no regex holds a variable, an array or a code block and no replacement interpolates code
const PERL_SCRIPT = new RegExp(String.raw`^${PERL_ITEM}(?:;${PERL_ITEM})*;?[ \t]*$`)

// a file operand perl's -n and -p open as a file alone: its 2-arg open runs a name ending or starting in | as a command, and reads <, >, + and & as modes
const PERL_FILE = /^(?:-|[^\s|<>+&-][^|]*(?<!\s))$/

// Whether a perl call only reads and prints: every option on PERL_FLAG's list, at least one -e or -E script, every script a literal word, unglobbed, that PERL_SCRIPT holds, every file operand a literal PERL_FILE, and no PERL variable set, since PERL5OPT and PERL5LIB load code
function perlReads({ args, local }: Parsed, env: Env): boolean {
  if ([...local.keys(), ...env.vars.keys()].some((key) => key.startsWith("PERL"))) return false
  const scripts: Word[] = []
  let k = 0
  for (; k < args.length; k++) {
    const { value } = args[k]
    if (value === "--") {
      k++
      break
    }
    if (!value.startsWith("-") || value === "-") break
    if (!PERL_FLAG.test(value)) return false
    if (/[eE]$/.test(value)) {
      if (!args[k + 1]) return false
      scripts.push(args[++k])
    }
  }
  const files = args.slice(k)
  return (
    scripts.length > 0 &&
    scripts.every((w) => literal(w) && PERL_SCRIPT.test(w.value)) &&
    files.every((w) => literal(w) && PERL_FILE.test(w.value))
  )
}

// Whether a call's program is its command's own first word, read outright, bare or by a system path, so no wrapper or file of another folder runs in its place
function ownProgram(cmd: Command, { first, name }: Parsed): boolean {
  return (
    ownFirst(cmd, first) &&
    !marked(name) &&
    /^(?:\/(?:bin|opt\/homebrew\/bin|usr\/bin|usr\/local\/bin)\/)?[^/]+$/.test(first.value)
  )
}

// The line with each $'…' string outside quotes put as one letter, since it expands nothing and singleQuotesOut reads a line holding one as written, and a $ ending a single-quoted span put as a letter too
function ansiOut(text: string): string {
  let out = ""
  let quote = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      // a single-quoted span's last character a $ is text, put as a letter so singleQuotesOut reads the line
      if (c === "$" && text[i + 1] === "'") {
        out += "q"
        continue
      }
      quote = c === "'" ? "" : quote
    } else if (c === "\\") {
      out += c + (text[i + 1] ?? "")
      i++
      continue
    } else if (quote === "" && c === "$" && text[i + 1] === "'") {
      for (i += 2; i < text.length && text[i] !== "'"; i++) if (text[i] === "\\") i++
      out += "q"
      continue
    } else if (c === "'" && quote === "") quote = "'"
    else if (c === '"') quote = quote === '"' ? "" : '"'
    out += c
  }
  return out
}

// The parts of a line the shell runs as code where the lexer reads a plain word, found outside a quoted heredoc's body, single quotes and a double-quoted text with no $: a zsh e glob qualifier, an e or P parameter flag's expansion and a zsh =(…), each as written with its single-quoted spans collapsed; a prompt expansion (@P) or a glob substitution (`${~…}`, `$~…`), which runs a value set elsewhere, gives the whole line
function evaluatedParts(text: string): string[] {
  const unquoted = singleQuotesOut(quotedBodiesOut(ansiOut(text)))
  // a double-quoted text right after an e may be a qualifier's code (`f(e"…")`), so it stays
  const outside = unquoted.replace(/(?<!e)"(?:[^"\\$]|\\.)*"/g, "q")
  if (/@P\}|\$\{?~/.test(outside)) return [text]
  const parts: string[] = []
  for (const [found, pattern] of [
    [CODE_QUALIFIER, new RegExp(CODE_QUALIFIER.source, "g")],
    [FLAG, FLAGS],
    [FILE_RUN, FILE_RUNS],
  ] as const)
    if (found.test(outside)) {
      const written = [...unquoted.matchAll(pattern)].map(([part]) => part)
      parts.push(...(written.length > 0 ? written : [unquoted]))
    }
  return parts
}
// steady's QUALIFIER with an e's separator no letter, digit or _ (`:`, `{`, `"`) and its code on one line, as a session writes one, so a program's `d(open(…))` is none
const CODE_QUALIFIER = new RegExp(
  QUALIFIER.source
    .replace("([^\\s[{<])[^]*?\\1", "([^\\s[{<\\w])[^\\n]*?\\1")
    .replace("|\\+\\w+", ""),
)
// an e or P parameter flag's expansion, to its first closing brace
const FLAG = /\$\{\([^)]*[eP]/
const FLAGS = /\$\{\([^)]*[eP][^)]*\)[^}]*\}?/g
// zsh's =(…), which runs its command into a file the word names
const FILE_RUN = /(?:^|[\s;&|(<>])=\(/
const FILE_RUNS = /=\([^)]*\)?/g

// Whether a call is a closed-list reader whose quoted words are never a command line: awk, cat, cut, date, echo, git, grep, head, lsof, perl, sed, sort, tail, uniq or wc, a bash -c of a script of such readers, or a read-only gh call with a jq filter, as its own program (ownProgram), with no variable set in the call
function narrow(cmd: Command, env: Env): boolean {
  const parsed = parse(cmd)
  const { args, first } = parsed
  // a command of reserved words alone (`fi`, `done`) runs nothing; any other with no program read (`sudo -s`, a group) has its line read whole
  if (!first) {
    return (
      onlyReserved(cmd) &&
      cmd.redirects.length === 0 &&
      !cmd.inner &&
      !cmd.group &&
      parsed.local.size === 0
    )
  }
  if (!ownProgram(cmd, parsed)) return false
  const base = program(first.value)
  if (AWKS.has(base)) {
    const programs = awkPrograms(args)
    return !!programs && programs.every(({ value }) => !marked(value) && !awkRuns(value))
  }
  if (["cat", "grep", "head", "tail", "wc"].includes(base)) return reads(parsed, env)
  // a git reader with a word the hook cannot read keeps canary's reading, since that word may be an option that writes or runs (`--output=…`)
  if (base === "git") return reads(parsed, env) && !args.some(({ value }) => marked(value))
  if (SEDS.has(base)) return sedReads(args)
  if (base === "perl") return perlReads(parsed, env)
  // date prints the time and runs nothing, so a read line ending in `; date -u +%FT%TZ` keeps its readers' reading
  if (base === "cut" || base === "date" || base === "echo" || base === "lsof") return true
  // bash given one script by -c runs that script alone, which the reader walks call by call, so it is narrow when that script holds reads alone; wholeLine counts it only as its line's one command, and sh and zsh keep canary's reading
  if (base === "bash") {
    const [flag, script] = args
    return (
      args.length === 2 &&
      flag.value === "-c" &&
      script.quoted &&
      !marked(script.value) &&
      !wholeLine(lex(script.value, env.known).commands, env, true)
    )
  }
  // a read-only gh call is narrow when its jq filter is the only word that holds a space, and a gh post when its title and body are
  if (base === "gh") {
    const filters = ghFilters(parsed)
    const texts = filters.size > 0 ? filters : ghTexts(parsed)
    return texts.size > 0 && args.every((a) => texts.has(a) || !/\s/.test(a.value))
  }
  // a cd to one literal folder runs nothing, and the walk follows it, so every later call is judged where it lands
  if (base === "cd") {
    const [folder] = args
    return args.length === 1 && literal(folder) && !/^(?:-|~[-+0-9])/.test(folder.value)
  }
  if (base === "sort") return !args.some(({ value }) => /^-[a-zA-Z]*o|^--./.test(value))
  if (base === "uniq")
    return args.filter(({ value }) => value === "-" || !value.startsWith("-")).length <= 1
  return false
}

// Whether a line holds a shell reading its script from stdin (`sudo -s`, `sh`) or a command its pipe feeds as code (codeFed) anywhere, its groups' and substitutions' included, which runs whatever a reader prints into it
function rooted(commands: Command[]): boolean {
  if (codeFed(commands).size > 0) return true
  return commands.some(
    (cmd) =>
      !!stdinShell(cmd) ||
      (!!cmd.inner && rooted(cmd.inner())) ||
      [...cmd.words, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))].some(
        (word) => !!word.procs && rooted(word.procs),
      ),
  )
}

// A git commit the hook reads as text: git as its own program (ownProgram), its sub commit, no shell variable set, no git option ahead of commit that changes what git runs or where (-c, -C, --config-env, --exec-path, --git-dir, --work-tree), and every spaced word a quoted message it holds (after -m, a flag cluster ending in m, --message, or --message=), since commit runs no word it is given.
function quietCommit(cmd: Command, parsed: Parsed, env: Env): boolean {
  const { args, local, name } = parsed
  if (name !== "git" || local.size > 0 || !ownProgram(cmd, parsed)) return false
  const { rest, sub } = gitCall(args, env)
  if (sub !== "commit") return false
  const before = args.slice(0, args.length - rest.length - 1).map((a) => a.value)
  if (
    before.some(
      (w) => w === "-c" || w === "-C" || /^--(?:config-env|exec-path|git-dir|work-tree)/.test(w),
    )
  )
    return false
  return args.every(
    (word, at) =>
      !/\s/.test(word.value) ||
      (word.quoted &&
        !marked(word.value) &&
        (/^(?:-[a-zA-Z]*m|--message)$/.test(args[at - 1]?.value ?? "") ||
          word.value.startsWith("--message="))),
  )
}

// Whether a line is read whole, as canary read it, every spaced text of every program but a reader a command line; a line is read call by call only when every command, its substitutions' included, is narrow or a quiet commit, and no redirect but a quiet commit's own writes a file
function wholeLine(commands: Command[], env: Env, readsOnly = false): boolean {
  // date is a reader only on a line that edits nothing, so one beside an in-place sed or a quiet commit keeps canary's reading; readsOnly, a bash -c's script, spares neither edit
  const edited = !readsOnly && commands.some((cmd) => edits(cmd, parse(cmd), env))
  return commands.some((cmd) => {
    const words = [...cmd.words, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))]
    if (words.some((word) => word.procs && wholeLine(word.procs, env, readsOnly))) return true
    const parsed = parse(cmd)
    const base = parsed.first && program(parsed.first.value)
    // a bash -c is narrow only as its line's one command, so a shell beside another call keeps canary's reading
    if (base === "bash" && commands.length > 1) return true
    if (edited && base === "date") return true
    if (!readsOnly && quietRun(cmd, parsed, env)) return false
    const writes = cmd.redirects.some((r) => writer(r) && r.target?.value !== "/dev/null")
    return writes || !(narrow(cmd, env) || (!readsOnly && sedInPlace(cmd, parsed)))
  })
}

// a quiet commit run-slot runs is read as the commit (slotWords), and its own redirect takes what git prints, never its message, judged by where it writes as every redirect is
function quietRun(cmd: Command, parsed: Parsed, env: Env): boolean {
  const slot = slotWords(parsed)
  const commit = slot ? { ...cmd, words: slot } : cmd
  return quietCommit(commit, slot ? parse(commit) : parsed, env)
}

// Whether a call edits a file on a line read call by call: a quiet commit or an in-place sed, each judged by what it writes
const edits = (cmd: Command, parsed: Parsed, env: Env) =>
  quietRun(cmd, parsed, env) || sedInPlace(cmd, parsed) !== undefined

// Calls whose string argument a shell runs: exec and execSync in a program that names child_process, and execFile, execFileSync, spawn and spawnSync in a program that names `shell` other than as a key whose whole value is a literal `false` (true, a shell's path, a value read at run time or an expression that starts with `false` all run one). A ~ in that string expands to the home as the shell runs it, so the string is judged as its own shell line rather than left relative to the cwd.
const IMPLICIT_SHELL = new Set(["exec", "execSync"])
const SHELL_RUNNER = /\b(exec|execFile|execFileSync|execSync|spawn|spawnSync)\s*\(/g
// `shell`, a quoted key's quotes included, and the `: false` after it when that is its whole value, ended by a comma or a closing bracket.
const SHELL_WORD = /(["']?)\bshell\b\1(\s*:\s*false\b(?=\s*[,})]))?/g

// Whether a program names a `shell` other than a key whose whole value is a literal false: read across the program, since a shorthand property, a spread or an options object passed by name carries the option outside the call's own text.
function namesShell(text: string): boolean {
  return [...text.matchAll(SHELL_WORD)].some((m) => !m[2])
}

function skipSpace(src: string, k: number): number {
  while (k < src.length && /\s/.test(src[k])) k++
  return k
}

// A JavaScript string literal at `src[i]` (a ', " or ` quote): its content and the index past the close, or undefined when `src[i]` is no quote or a template holds a ${…} substitution.
function stringLiteral(src: string, i: number): { end: number; value: string } | undefined {
  const quote = src[i]
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined
  let value = ""
  let k = i + 1
  while (k < src.length && src[k] !== quote) {
    if (src[k] === "\\") {
      value += src[k + 1] ?? ""
      k += 2
    } else value += src[k++]
  }
  if (quote === "`" && value.includes("${")) return undefined
  return { end: k + 1, value }
}

// The command string a shell-running call is given, read from just after its `(`: a run of string literals joined by `+`, or undefined when the first argument is not a literal run (an array, a variable, a template with a substitution). A shell variable ($VAR) inside the literal is kept and judged as the shell reads it, so the rest of the line is still judged.
function commandString(src: string, open: number): string | undefined {
  let value = ""
  let k = open
  for (;;) {
    k = skipSpace(src, k)
    const literal = stringLiteral(src, k)
    if (!literal) return undefined
    value += literal.value
    k = skipSpace(src, literal.end)
    if (src[k] !== "+") break
    k++
  }
  return value
}

// Each command string a shell-running call in a program's text is given, so a ~ in one is judged as the shell expands it; exec and execSync count only in a program that names child_process, so a regex's or a query's `.exec` is left alone, and a spawn, spawnSync, execFile or execFileSync counts only in a program that names a `shell` other than a key whose whole value is a literal `false`.
function shellRunnerArgs(text: string): string[] {
  const out: string[] = []
  const childProcess = text.includes("child_process")
  const shell = namesShell(text)
  for (const m of text.matchAll(SHELL_RUNNER)) {
    const open = m.index + m[0].length
    const command = commandString(text, open)
    if (command === undefined) continue
    if ((IMPLICIT_SHELL.has(m[1]) && childProcess) || shell) out.push(command)
  }
  return out
}

// Every text of a variable the call sets or exports, and on a line read whole of every word, that holds a space, a leading ! dropped, each read as a command line of its own, and the command string a shell-running call in it is given; `vars` is the scope's variables set since their lines were last read.
function runsOf(parsed: Parsed, vars: Text[], whole: boolean, rootLine: boolean): string[] {
  const { args, first, local } = parsed
  const values = [...local.values(), ...vars].flatMap((text) => {
    tick()
    return text.unknown ? [] : [text.value]
  })
  for (const word of whole ? (first ? [first, ...args] : args) : [])
    for (const text of texts(word)) {
      values.push(text.value.replace(/^!/, ""))
      // printf and echo -e print a \n as a line break, which a root shell runs as one
      if (rootLine) values.push(...text.value.split("\\n"))
      values.push(...shellRunnerArgs(text.value))
    }
  values.push(...programLines(parsed, rootLine))
  return [...new Set(values)].filter((value) => /\s/.test(value) && !marked(value))
}

// What of a playground call changes what a guard reads, or undefined; its words split as that command's parseWords splits them, and a word the hook cannot read taken as the worst.
function cliWrite(words: Word[], tuning: Tuning): string | undefined {
  const [command, verb, ...rest] = words.map((w) => (marked(w.value) ? undefined : w.value))
  if (command === undefined)
    return words.length ? "playground with a command word it cannot read" : undefined
  if (command === "migrate") return "playground migrate, which seeds the lists and settings"
  if (command === "uninstall")
    return words.some((w) => w.value === "--purge")
      ? "playground uninstall --purge, which moves the data folder aside"
      : undefined
  const switches = SWITCHES[command]
  if (!switches) return
  if (verb === undefined) return `playground ${command} with a verb it cannot read`
  const unread = rest.includes(undefined)
  const positional: (string | undefined)[] = []
  let dry = false
  let scoped = false
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k]
    if (word !== undefined && switches.includes(word)) dry ||= word === "--dry-run"
    else if (word?.startsWith("--")) {
      scoped ||= word.startsWith("--scope")
      k++
    } else positional.push(word)
  }
  if (command === "settings") {
    if (verb === "import-jobs")
      return dry
        ? undefined
        : `playground settings import-jobs, which writes each listed job's jobs.<name>, ${BY_APPROVE}`
    if (verb !== "set" && verb !== "reset") return
    const key = positional[0]
    if (unread || key === undefined) return `playground settings ${verb} with a word it cannot read`
    const job = key.startsWith(JOB_PREFIX)
    if (!GUARD_KEYS.has(key) && !job) return
    const value = positional[1]
    if (verb === "set" && value !== undefined && tuning(key, value, scoped)) return
    return PRIVACY_KEYS.has(key) && !scoped
      ? `playground settings ${verb} of ${key}, a key a guard reads, ${PRIVACY}`
      : job
        ? `playground settings ${verb} of ${key}, ${BY_APPROVE}`
        : `playground settings ${verb} of ${key}, a key a guard reads`
  }
  if (verb === "accept")
    return "playground ext accept, the owner's own call: post it as an accept decision with playground ask new (.agents/dashboard/asks.md), whose Approve has the dashboard run it with no role, since the CLI refuses an accept with PLAYGROUND_ROLE set"
  if (verb === "put")
    return unread || positional[1] === "list"
      ? "playground ext put of a list, or with a word it cannot read, which may render into a guard's list"
      : undefined
  if (EXT_WRITES.has(verb) && !(dry && EXT_DRY.has(verb)))
    return `playground ext ${verb}, which changes what the guards' lists and policy.json render from`
}

// The texts a word may name a path by: the word, the value after an =, and the rest after a one-letter option (-o<path>, -C<dir>).
const texts = (word: Word): Word[] => {
  const v = word.value
  const out = [word]
  const eq = v.indexOf("=")
  if (eq > 0) out.push({ ...word, value: v.slice(eq + 1) })
  if (/^-[A-Za-z]./.test(v)) out.push({ ...word, value: v.slice(2) })
  return out
}

// unknown: the line names HOME, TMPDIR or PWD other than by expanding them, so it is read a second time with those unknown, since the shell's value may not be the environment's
async function inspect(raw: string, environment: Environment, unknown = false) {
  const { cwd, tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as Record<string, unknown>
  const input = (toolInput ?? {}) as Record<string, unknown>
  const directory = typeof cwd === "string" ? cwd : undefined
  const root = real(extensionsDir(dataDir(environment)))
  const home = environment.HOME || homedir()
  const needle = root.startsWith(real(home) + sep) ? root.slice(real(home).length) : root
  const inRoot = (path: string | undefined) => {
    if (path === undefined) return false
    const at = real(path)
    return at === root || at.startsWith(root + sep)
  }
  // a folder that holds the root, but the filesystem's own root, which only a remover names to harm
  const above = (path: string | undefined, remover: boolean) => {
    if (path === undefined) return false
    const at = real(path)
    return at === sep ? remover : root.startsWith(at + sep)
  }
  const file = typeof tool === "string" ? input[FILE_TOOLS[tool]] : undefined
  if (typeof file === "string") {
    const expanded = /^~(?:\/|$)/.test(file) ? join(home, file.slice(1)) : file
    return inRoot(resolve(directory ?? "", expanded)) ? refuse(`a write to ${file}`) : undefined
  }
  if (tool !== "Bash") return
  const { command } = input
  if (typeof command !== "string") return
  let tuning = (await opsLead(raw, environment)) ? tuningOf(environment) : NO_TUNING
  // nesting makes the lexer's time grow with the square of the length, so a longer command could outlast the hook's timeout
  if (command.length > 131_072) return refuse(TOO_LONG)
  // the root's path from a cwd above it, which a script may name it by
  const relative = (env: Env) =>
    env.cwd && above(env.cwd, false) ? root.slice(real(env.cwd).length + 1) : undefined
  const holds = (value: string, env: Env) => {
    const near = relative(env)
    return value.includes(needle) || (!!near && value.includes(near))
  }
  // a text that names the root or a folder of its path, which a glob or a variable can spell
  const touches = (body: string, env: Env) =>
    holds(body, env) ||
    needle
      .split(sep)
      .filter(Boolean)
      .some((part) => body.toLowerCase().includes(part.toLowerCase()))
  // a regex body that names the root, a folder of its path or the home, which a program could print as a path
  const guarded = (body: string, env: Env) => touches(body, env) || body.includes("~")
  // What a word of a program that is no reader names: a path in the root, a folder above it, a glob there, or the root's path in its text.
  const judged = new Map<string, string | undefined>()
  // literal: a closed-list reader's word on a line read call by call, whose quoted glob character is text the reader never expands
  const names = (word: Word, env: Env, remover: boolean, literal = false): string | undefined => {
    const quotedGlob = literal && !word.glob
    const key = `${remover}\0${quotedGlob}\0${env.cwd}\0${word.value}`
    if (!judged.has(key)) judged.set(key, judge(word, env, remover, quotedGlob))
    return judged.get(key)
  }
  const judge = (
    word: Word,
    env: Env,
    remover: boolean,
    quotedGlob: boolean,
  ): string | undefined => {
    tick()
    for (const text of texts(word)) {
      if (holds(text.value, env)) return `${root} in its text`
      const path = pathOf(text, env)
      if (inRoot(path)) return path
      if (above(path, remover)) return `${path}, which holds ${root}`
      const glob = GLOB.exec(text.value)
      if (glob && !quotedGlob && !marked(text.value)) {
        const dir = pathOf({ value: `${text.value.slice(0, glob.index)}x` }, env)
        const folder = dir && dirname(dir)
        if (folder && (inRoot(folder) || above(folder, true)))
          return `${text.value}, a glob in ${folder}`
      }
    }
  }
  // whether the hook places a write's path, the whole word, with no folder of the shell's: absolute, under ~, or through a variable the call holds
  const placed = (word: Word, env: Env, steady: Steady) =>
    pathOf(heldWord(word, env, steady) ?? word, { ...env, cwd: undefined }) !== undefined
  const afterUnreadCd = (write: string) =>
    `${write} after a cd to a folder the hook cannot read, which may be ${root}; cd to a literal path first, or name the path absolutely`
  const seen = new Set<string>()
  let steadyAt: (cmd: Command) => Steady = () => NONE
  let whole = false
  let rootLine = false
  let patterns = new Set<Command>()
  let lineWrites = false
  // how deep the walk is in a line read out of a quoted text (runsOf), whose commands no one typed
  let textDepth = 0
  // where each scope's variables were read to for their lines, and judged to for each cwd and remover, so each variable is read once rather than once a command
  type Cursors = WeakMap<Map<string, Text>, Map<string, number>>
  const varsRead: Cursors = new WeakMap()
  const varsJudged: Cursors = new WeakMap()
  const since = (store: Cursors, vars: Map<string, Text>, key: string): Text[] => {
    const cursors = store.get(vars) ?? new Map<string, number>()
    store.set(vars, cursors)
    const [keys, next] = varsSince(vars, cursors.get(key))
    cursors.set(key, next)
    return keys.flatMap((k) => {
      tick()
      return vars.get(k) ?? []
    })
  }
  // a refusal that likely names no write: no writing redirect on the typed line, a word read as a folder above the root or a glob there rather than as the root's own path, and a command read out of a quoted text or a reader that writes nothing as called
  const unwritten = (named: string, cmd: Command, env: Env) =>
    !lineWrites &&
    !named.endsWith(" in its text") &&
    !inRoot(named) &&
    (textDepth > 0 || READERS.has(program(parse(cmd).name)) || narrow(cmd, env))
  const visit: Visit = async (cmd: Command, parsed, env) => {
    // a case pattern is matched, never run, so its words are no path and no program; a substitution in it is its own command
    if (patterns.has(cmd)) return
    // the reader walks the script a shell or a source runs, so the hook judges only one it cannot read: a -c script it reads none of, or a file this line wrote with such text
    if (SHELLS.has(parsed.name) || parsed.name === "." || parsed.name === "source") {
      const shellCall = SHELLS.has(parsed.name)
      const { inline, operand } = shellCall
        ? shellOperand(parsed.args, parsed.name)
        : { inline: false, operand: parsed.args[0] }
      if (inline && operand && unreadWord(operand) && !/\S/.test(visible(operand.value)))
        return refuse(
          `a ${parsed.name} -c of ${shown({ ...operand, raw: operand.raw ?? operand.source })}, a script the hook cannot read; run its commands as calls of their own`,
        )
      // a script whose text runs as code is refused when that code names the root's folders
      if (inline && operand && evaluatedParts(operand.value).some((part) => touches(part, env)))
        return refuse(EVALUATES_ROOT)
      const path = !inline && operand ? pathOf(operand, env) : undefined
      const written = path === undefined ? undefined : env.files.get(path)
      if (written && (written.unknown || marked(written.value)))
        return refuse(
          `${parsed.name} ${shown(operand!)}, a script this line wrote with text the hook cannot read; run its commands as calls of their own`,
        )
      if (shellCall) return
    }
    const slot = slotWords(parsed)
    if (slot)
      return slot.length === 0 ? undefined : examine({ ...cmd, words: slot }, env, visit, false)
    const { args, first, name, xargs } = parsed
    // findutils' g names are read again as find and xargs, so every check those two take reads them; the words swap in place, keeping the Command steadyAt knows and the program's path
    const findutils = GNU_NAMED.exec(name)?.[1]
    if (first && (findutils === "find" || findutils === "xargs")) {
      const value = first.value.replace(new RegExp(`g${findutils}$`, "i"), findutils)
      // a g name env -S splits out of its string is no word of the command, and one written so its name is not the word's end (a trailing slash) has none to swap, so either would be examined as itself again
      if (!cmd.words.includes(first) || value === first.value)
        return refuse(
          `${name} written where the hook cannot read it as ${findutils}, inside env -S's string or with more after its name; run it as a word of its own, ${name} or ${findutils}`,
        )
      const { words } = cmd
      cmd.words = words.map((word) => (word === first ? { ...word, value } : word))
      try {
        return await examine(cmd, env, visit, false)
      } finally {
        cmd.words = words
      }
    }
    // every folder the shell may be in, so a write a cd the reader cannot be sure of would land in the root is judged there too
    for (const here of places(env)) {
      const into = cmd.redirects.find(
        (r) =>
          r.target &&
          writer(r) &&
          (inRoot(pathOf(r.target, here)) ||
            (GLOB.test(r.target.value) && !!names(r.target, here, true))),
      )
      if (into?.target) return refuse(`a write to ${pathOf(into.target, here)}`)
      // a writing redirect's target through a variable is judged by what the value the hook holds names, a for loop's literal words each in turn; one it holds no value for runs, as it did before
      for (const r of cmd.redirects) {
        if (!r.target || !writer(r) || !marked(r.target.value)) continue
        const words = heldReadings(r.target, here, steadyAt(cmd)) ?? []
        const named = words.map((word) => names(word, here, false)).find(Boolean)
        if (named) return refuse(`a write to ${named}`)
      }
    }
    // past the cap the root may be a folder places() dropped, so a writing redirect whose target leans on the shell's own folder is refused before a reader or an echo lets it run
    const blind = env.cwdAnywhere
      ? cmd.redirects.find(
          (r) =>
            r.target && writer(r) && pathOf(r.target, { ...env, cwd: undefined }) === undefined,
        )
      : undefined
    if (blind?.target)
      return refuse(
        `a write to ${blind.target.value} on a line that names more folders than the hook carries, since it cannot rule out ${root}; run it as a line of its own after a cd to a literal path`,
      )
    // after a cd to a folder the hook cannot read (`Env.cwdUnread`), the shell may be in the root, so a writing redirect the hook can place only by the shell's own folder is refused
    const unplaced = env.cwdUnread
      ? cmd.redirects.find((r) => r.target && writer(r) && !placed(r.target, env, steadyAt(cmd)))
      : undefined
    if (unplaced?.target) return refuse(afterUnreadCd(`a write to ${shown(unplaced.target)}`))
    // a reader is its command's own first word, so a wrapper's option value parse misread never stands in for one
    const reader = !rootLine && ownFirst(cmd, first) && reads(parsed, env)
    const fed = xargs ? await stdinOf(cmd, env) : undefined
    const stdinWords: Word[] = !fed
      ? []
      : fed.unknown
        ? [{ quoted: false, value: UNKNOWN }]
        : fed.value
            .split(/\s+/)
            .filter(Boolean)
            .map((value) => ({ quoted: false, value }))
    const calls = reader ? [] : cliCalls(parsed, env)
    const write =
      calls
        .map((words) => cliWrite(xargs?.replace ? words : [...words, ...stdinWords], tuning))
        .find(Boolean) ??
      (calls.some((words) => scoreAsOther(words, cmd, parsed, env)) ? SCORE_AS_OTHER : undefined)
    if (write) return refuse(write)
    // a command with no program runs nothing that reads the environment, so only its own assignments count
    const vars = !reader && first ? since(varsRead, env.vars, "") : []
    // an eval's words are its script, so one the hook cannot read (`unreadWord`: any but quoted and plain characters) is refused
    const unreadEval = name === "eval" && args.find(unreadWord)
    if (unreadEval)
      return refuse(
        `an eval of ${shown({ ...unreadEval, raw: unreadEval.raw ?? unreadEval.source })}, a value the hook cannot read; run its commands as calls of their own, with no eval`,
      )
    // a root shell's stdin is its script, so one the hook cannot read is refused
    const script: string[] = []
    if (stdinShell(cmd) === "root") {
      const text = await stdinOf(cmd, env)
      if (text.unknown || marked(text.value))
        return refuse(
          `a root shell whose script (${text.unknown ?? "a value it cannot read"}) the hook cannot read; run its commands as calls of their own, with no root shell`,
        )
      script.push(text.value)
    }
    // an inline evaluator's program is read with its regex literals masked (maskRegexes), since a regex is neither a path, a glob nor a redirect, but as written on a root-shell line or inside a substitution or subshell, whose output a shell may run, and wherever the shell may be in the root or a folder above it, where canary's reading decides
    const away = places(env).every(
      ({ cwd }) => cwd !== undefined && !above(cwd, true) && !inRoot(cwd),
    )
    const evaluated = rootLine || cmd.scope !== 0 || !away ? undefined : evalProgram(parsed)
    const masked =
      evaluated && !evaluated.glob && !marked(evaluated.value)
        ? maskRegexes(evaluated.value, (body) => guarded(body, env))
        : undefined
    const own = (word: Word): Word =>
      word === evaluated && masked !== undefined ? { ...word, value: masked } : word
    for (const raw of reader
      ? []
      : [...script, ...runsOf({ ...parsed, args: args.map(own) }, vars, whole, rootLine)]) {
      const line =
        xargs?.replace && fed ? filled(raw, xargs.replace, fed.unknown ? UNKNOWN : fed.value) : raw
      if (seen.has(line)) continue
      seen.add(line)
      textDepth++
      const verdict = await run(
        lex(line, env.known),
        { ...env, vars: new Map() },
        visit,
        true,
      ).finally(() => textDepth--)
      if (verdict) return verdict
    }
    // a quiet commit's message is text git never runs, a gated call it names included, and an in-place sed's script is text sed reads as a program of its own
    const quiet = !whole && quietCommit(cmd, parsed, env)
    const sedScripts = whole ? undefined : sedInPlace(cmd, parsed)
    // a bare assignment or export with no command, or a reader: only its redirect writes, and a variable it sets is read where a command runs with it
    if (!first || EXPORTS.has(name) || reader) return
    // a program word the hook cannot read is named as such, so a refusal always names what runs
    const verb = name && !marked(name) ? name : "a program it cannot read"
    // a GNU build named by its g prefix or reached by its gnubin path reads as the tool it builds, with GNU's options
    const tool = GNU_NAMED.exec(name)?.[1] ?? name
    const gnu = tool !== name || first.value.includes("/gnubin/")
    const remover = REMOVERS.has(tool)
    // POSIXLY_CORRECT set in the call, by a prefix or on its line, makes a GNU build stop its options at the first operand
    const posix = gnu && (parsed.local.has("POSIXLY_CORRECT") || env.vars.has("POSIXLY_CORRECT"))
    // a line that names more folders than the reader carries (`Env.cwdAnywhere` in shell.ts) may run inside this root, whatever folder it started in
    if (env.cwdAnywhere)
      return refuse(
        `${verb} on a line that names more folders than the hook carries, since it cannot rule out ${root}; run it as a line of its own after a cd to a literal path`,
      )
    const steady = steadyAt(cmd)
    // on a line read call by call, a read-only gh call's jq filter is text, never a path
    const filters = whole ? new Set<Word>() : ghFilters(parsed)
    // each folder the shell may be in, so a program a cd the reader cannot be sure of would run inside the root, or a path of its own that lands there, is judged in every one
    for (const here of places(env)) {
      if (inRoot(here.cwd)) return refuse(`${verb} run inside ${root}`)
      if (name === "git" && inRoot(gitCall(args, here).cwd))
        return refuse(`git on a clone in ${root}`)
      // a value the hook cannot read under a remover, as a writer's target, or in git's -c, could name the root, so it is refused unless the call holds it
      const unheld = (
        remover ? args : WRITERS.has(tool) ? writeTargets(tool, args, gnu, posix) : []
      ).find((word) => !held(word, here, steady))
      if (unheld)
        return refuse(
          unheld.splits
            ? `${verb} on ${shown(unheld)}, a value the hook does not hold that the shell may split into several words; quote it ("$X") and hold it in the same call, or write the path literally`
            : `${verb} on ${shown(unheld)}, a value the hook does not hold; hold it in the same call (X=<path>; ${verb} "$X") or write the path literally`,
        )
      if (name === "git") {
        const config = gitConfigs(args).find((word) => marked(word.value))
        if (config)
          return refuse(
            `git ${/^-c./.test(config.raw ?? config.value) ? "" : "-c "}${shown(config)}, a value built from a variable or a substitution; write the value literally in the call`,
          )
        // git takes --config-env's value from a variable, and a git variable other than an author's or a committer's, or a pager or editor variable, can make git run a program or write, so either from a value the hook does not hold is refused
        const { rest } = gitCall(args, here)
        const fromEnv = args
          .slice(0, args.length - rest.length - 1)
          .find((word) => /^--config-env(?:=|$)/.test(word.value))
        if (fromEnv)
          return refuse(
            `git ${shown(fromEnv)}, which takes a config value from a variable the hook cannot read; write the value literally with git -c`,
          )
        const scoped = runsVariable(here.vars) ? [...here.vars] : []
        const variable = [
          ...parsed.local,
          ...scoped.filter(([key]) => !parsed.local.has(key)),
        ].find(
          ([key, value]) =>
            RUNS.test(key) &&
            !GIT_TEXT.test(key) &&
            !held({ ...value, quoted: false }, here, steady),
        )
        if (variable)
          return refuse(
            `git with ${variable[0]} set to a value the hook does not hold, which git may run or read as config; write the value literally in the call`,
          )
      }
      const scope = since(varsJudged, here.vars, `${here.cwd}\0${remover}`)
      for (const value of [...parsed.local.values(), ...scope]) {
        const named = names({ ...value, quoted: false }, here, remover)
        if (named) return refuse(`${verb} with a variable on ${named}`)
      }
      const literal = !whole && narrow(cmd, here)
      for (const word of [first, ...args].map(
        (word) => heldWord(own(word), here, steady) ?? own(word),
      )) {
        // a quiet commit's message, an in-place sed's script and a gh filter are text, judged only when the root is in it; a filter's unquoted glob is the shell's, judged as any glob
        const text =
          (quiet && /\s/.test(word.value)) ||
          !!sedScripts?.has(word) ||
          (filters.has(word) && !word.glob)
        if (text && !texts(word).some((t) => holds(t.value, here))) continue
        const named = names(word, here, remover, literal)
        if (named)
          return (unwritten(named, cmd, here) ? refuseUnwritten : refuse)(`${verb} on ${named}`)
      }
      if (cmd.redirects.some((r) => r.body && holds(r.body.value, here)))
        return refuse(`${verb} with a script that names ${root}`)
      if (fed && remover && (fed.unknown || marked(fed.value)))
        return refuse(
          `${verb} under xargs fed by ${fed.unknown ?? "a value it cannot read"}, a value the hook does not hold; write the paths literally in the call`,
        )
      if (fed) {
        const named =
          !fed.unknown &&
          fed.value
            .split(/\s+/)
            .filter(Boolean)
            .map((value) => names({ quoted: false, value }, here, remover))
            .find(Boolean)
        if (named) return refuse(`${verb} under xargs on ${named}`)
      }
    }
    // after a cd the hook cannot read, a remover's operand or a writer's target the hook can place only by the shell's own folder may be in the root
    const end = args.findIndex((word) => word.value === "--")
    // a dash with more after it is an option, while a lone dash is an operand
    const option = (word: Word) => /^-./.test(word.value)
    // macOS unlink reads no option but a leading --
    const stop =
      !GETOPT_REMOVERS.has(tool) || (gnu && !posix)
        ? -1
        : tool === "unlink" && !gnu
          ? Number(args[0]?.value === "--")
          : args.findIndex((word) => !option(word))
    // mv's -t folder, rsync's path values and the file find's write actions name are written to, though their word opens with a dash
    const values =
      tool === "mv"
        ? writeTargets(tool, args, gnu, posix)
        : tool === "rsync"
          ? args.flatMap((word, k) => {
              const long = /^--([^=]+)=?/.exec(word.value)
              const path =
                long &&
                !RSYNC_FLAGS.has(long[1]) &&
                RSYNC_PATHS.some((name) => name.startsWith(long[1]))
              const cut = path ? long[0].length : RSYNC_TEMP.exec(word.value)?.[0].length
              if (!cut) return []
              // with no value attached, the option takes the next word, a dash-led one too
              if (cut < word.value.length) return [after(word, cut)]
              return args[k + 1] ? [args[k + 1]] : []
            })
          : tool === "find"
            ? args.flatMap((word, k) =>
                FIND_WRITES.test(word.value) && args[k + 1] ? [args[k + 1]] : [],
              )
            : []
    const operands = remover
      ? [
          ...args.filter(
            (word, k) => (end !== -1 && k > end) || (stop !== -1 && k >= stop) || !option(word),
          ),
          ...values,
        ]
      : WRITERS.has(tool)
        ? writeTargets(tool, args, gnu, posix)
        : []
    const loose = env.cwdUnread ? operands.find((word) => !placed(word, env, steady)) : undefined
    if (loose) return refuse(afterUnreadCd(`${verb} on ${shown(loose)}`))
  }
  const named = namings(command)
  const known = knownVariables(command, environment, directory)
  const steered = Object.keys(known).filter((key) => named.counts.has(key))
  if (unknown) for (const key of steered) delete known[key]
  const lexed = lex(command, known)
  if (!loneCall(lexed.commands)) tuning = NO_TUNING
  steadyAt = steadyNames(named, lexed.commands)
  const env: Env = {
    cwd: directory,
    // the line starts in the folder the tool names, which the reader has proved by the payload itself
    cwdSure: directory,
    files: new Map(),
    known,
    // zsh starts with OLDPWD at the folder it starts in
    old: { dir: directory },
    process: environment,
    vars: new Map(),
    visitShells: true,
  }
  // a line with a root shell is read whole with no reader spared, an awk program's strings its lines, since what a reader prints into the shell runs
  rootLine = rooted(lexed.commands)
  if (evaluatedParts(command).some((part) => touches(part, env))) return refuse(EVALUATES_ROOT)
  whole = rootLine || wholeLine(lexed.commands, env)
  patterns = casePatterns(lexed.commands)
  lineWrites = redirectsWrite(lexed.commands)
  // a line holding an ext score is refused whole once any command on it changes who the session reads as, so a shell it runs or pipes into carries the change
  if (SCORE.test(unquoted(command)) && changesIdentity(lexed.commands))
    return refuse(SCORE_AS_OTHER)
  const verdict = await run(lexed, env, visit, true)
  if (verdict || unknown || steered.length === 0) return verdict
  return inspect(raw, environment, true)
}

// Fails open: an error on any call lets it run, so a reader bug cannot block every Bash command or write; a RangeError, a stack overflow or the walk past its time, refuses.
export async function check(
  raw: string,
  environment: Environment = process.env,
  budget = 10_000,
): Promise<string | undefined> {
  try {
    return await withDeadline(budget, async () =>
      eachInput(raw, "no-extensions-write", (one) => inspect(one, environment)),
    )
  } catch (error) {
    if (error instanceof RangeError) return refuse(TOO_LONG)
  }
}

// The check run in a Worker and refused when it has not answered by the main thread's timer, so no synchronous step (a regex, a copy) can hold the hook past its timeout; the bundle in bundled/ starts the worker's bundle beside it.
export async function guarded(
  raw: string,
  environment: Environment = process.env,
  wait = 12_000,
  url = new URL(
    `./no-extensions-write-worker.${import.meta.path.endsWith(".js") ? "js" : "ts"}`,
    import.meta.url,
  ).href,
): Promise<string | undefined> {
  const worker = new Worker(url)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<string | undefined>((done) => {
        worker.onmessage = (event) => done(event.data)
        worker.onerror = () => done(undefined)
        worker.postMessage({ environment, raw })
      }),
      new Promise<string>((done) => {
        timer = setTimeout(() => done(refuse(TOO_LONG)), wait)
      }),
    ])
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}

if (import.meta.main) {
  const raw = await Bun.stdin.text()
  const reason = (await fromFactory(raw)) ? await guarded(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
