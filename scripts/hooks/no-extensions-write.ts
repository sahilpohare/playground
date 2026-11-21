// PreToolUse hook: refuses a factory session's write into the extensions root, where every guard's list, policy.json and each scope's sources live, and its playground CLI call that changes what a guard reads to allow or deny a call, so no session edits a list in one call and makes the guarded call in the next.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
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
import { input } from "./input"
import {
  bunCall,
  FILE_TOOLS,
  gitCall,
  inPlace,
  real,
  runnerReadings,
  runnerTarget,
  STARTED_RUNNERS,
  toolName,
  UNREAD_CWD,
  X,
} from "./no-main-checkout"
import { fromFactory, opsLead } from "./role"
import {
  BRACE,
  braceWords,
  casePatterns,
  codeFed,
  type Command,
  type Env,
  examine,
  filled,
  GIT_TAKES,
  globSwitch,
  isFolder,
  knownVariables,
  lex,
  marked,
  NO_GLOB,
  onlyReserved,
  outputOf,
  ownFirst,
  parse,
  type Parsed,
  pathOf,
  places,
  PRINTERS,
  program,
  READ,
  readPath,
  remoteEnv,
  run,
  SHELLS,
  shellOperand,
  slotWords,
  sshCall,
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
  WRAPPERS,
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
  startingVariables,
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

// A hook file written with a remover or text the hook cannot read (hookRemover), which names its own route
const HOOK_TEXT = "which a hook file may not hold"
const HOOK_ROUTE =
  "a hook learns a remover's target only when it runs, so no reading of its text can rule out the guarded folder. Write the hook as text the hook can read, with no remover word (in a comment too), no program built from a variable or a substitution or named by a glob, and no eval, or tell your lead what it needs to remove."
const hookRemoval = (file: string, what: string) => `${file} written with ${what}, ${HOOK_TEXT}`
// A hook file written on a line whose other text holds a remover or names the root (PG-2258), which names its own route
const LINE_TEXT = "which the hook reads as the hook's own text"
const LINE_ROUTE =
  "a line that writes a hook file has every text on it read as the hook's, since text can reach a hook by many paths. Run the hook's write as a call of its own, apart from the command that holds that text."

const refuse = (what: string) =>
  `no-extensions-write hook refuses ${what}: ${what.endsWith(PRIVACY) ? PRIVACY_ROUTE : what.endsWith(HOOK_TEXT) ? HOOK_ROUTE : what.endsWith(LINE_TEXT) ? LINE_ROUTE : ROUTE}`

// A refusal that likely names no write (`unwritten`), which the reader most often reaches by reading text as a path, so it routes to the lead as a likely false positive
const refuseUnwritten = (what: string) =>
  `no-extensions-write hook refuses ${what}: ${WHY_ROOT} If this command writes nothing, report it to your lead as a false positive.`
// The same, for code bun or node runs inline from a folder in or above the root, which may write there by a relative path, so it names the form that runs
const refuseNearEval = (program: string) => (what: string) =>
  `no-extensions-write hook refuses ${what}: ${WHY_ROOT} Code ${program} -e runs from this folder may write there by a relative path; run ${program} -e from a worktree, with absolute paths built from process.env.HOME.`

// text the shell runs as code where the lexer reads a plain word (evaluatedParts), read past by the reader, so code naming the root's folders may write there
const EVALUATES_ROOT =
  "text the shell runs as code (a glob qualifier, a parameter flag, a zsh =(…) or a prompt expansion) that names the guarded folder; run its commands as calls of their own, with no expansion that evaluates"
// a shell feature that changes what a glob matches, on a line a remote shell runs, which the hook refuses in any spelling rather than reads (globSwitch in shell.ts)
const GLOB_SWITCH = (found: string) =>
  `no-extensions-write hook refuses a glob-option switch (${found.slice(0, 80)}) on a line a remote shell runs, which the hook refuses rather than reads, wider than the risk on purpose, since a switch can let a glob in the remote home match the data folder: drop the option, or run the line locally; a shell's options run there only as a cluster with no O or 4, and a -o or a long option (--login) naming ${[...NO_GLOB].join(", ")}, as in set -euo pipefail`
const TOO_LONG =
  "a command too long or nested too deep to read inside the hook's time: split it into shorter calls"

// Programs that only read what they name; rg, find and git read only without the options below that run a program.
const READERS = new Set([
  "[",
  "cat",
  "cmp",
  "df",
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
// the programs a pipe from a fed ssh may run into with its file still read (sshText): readers, and the filters that write no file
const PIPE_READERS = new Set([...READERS, "cut", "tr"])
// find's actions that write, remove or run
const FIND_ACTS = /^-(?:delete|exec|execdir|fls|fprint|fprint0|fprintf|ok|okdir)$/
// xargs' -a (GNU's --arg-file), -0 (--null) and -d (--delimiter), after any of its flags in one cluster or by any prefix of the long name
const XARGS_ARG_FILE = /^-[0oprtx]*a|^--a(?:r(?:g(?:-(?:f(?:i(?:le?)?)?)?)?)?)?(?:=|$)/
const XARGS_NUL = /^-[0oprtx]*0|^--nu(?:ll?)?$/
const XARGS_DELIMITER = /^-[0oprtx]*d|^--d(?:e(?:l(?:i(?:m(?:i(?:t(?:er?)?)?)?)?)?)?)?(?:=|$)/

// xargs' own words, from its name to the parsed program word itself, so an option value spelled like the program (`-E rm`) ends none; with no program found, every word after the name, so a misplaced program reads as more options, never fewer
function xargsOptions(cmd: Command, first: Word | undefined): string[] {
  const start = cmd.words.findIndex((word) => /(?:^|\/)g?xargs$/i.test(word.value))
  if (start === -1) return []
  const end = first ? cmd.words.indexOf(first) : -1
  return cmd.words.slice(start + 1, end > start ? end : undefined).map((word) => word.value)
}

// The words xargs reads from stdin with no -0 or -d: blanks and newlines separate them, a pair of ' or " groups its text and is dropped, and a backslash keeps the next character; a quote left open is undefined, read as words the hook cannot read
function xargsWords(text: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === "\n") return undefined
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      word ??= ""
    } else if (c === "\\") word = (word ?? "") + (text[++i] ?? "")
    else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else word = (word ?? "") + c
  }
  if (quote) return undefined
  if (word !== undefined) words.push(word)
  return words
}
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
// Homebrew's GNU builds under their g prefix (gcp, grm, gfind, gsed, gtar): a g name reads as the program it names, a remover, a writer or one unreadCdWrites reads, and gfind and gxargs are examined again as find and xargs, so the tool lookup never yields either
const GNU_NAMED =
  /^g(chmod|cp|dd|find|install|ln|mkdir|mktemp|mv|rm|rmdir|sed|shred|sort|tar|tee|touch|truncate|unlink|xargs)$/
// GNU sed's long options, which getopt_long reads by any unique prefix (longOf); --file sorts before --follow-symlinks, so their shared prefix reads as a script file, failing closed
const SED_LONG = [
  "--debug",
  "--expression",
  "--file",
  "--follow-symlinks",
  "--help",
  "--in-place",
  "--line-length",
  "--null-data",
  "--posix",
  "--quiet",
  "--regexp-extended",
  "--sandbox",
  "--separate",
  "--silent",
  "--unbuffered",
  "--version",
  "--zero-terminated",
]
// Whether perl takes its script from an -e or -E: a letter of an option cluster before its first operand, read as perl reads one, so a letter that takes the rest of its cluster as its value (-i's suffix, -M's module, -I's folder) ends it, so -pie is -p and -i with the suffix e
function perlInline(args: Word[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--" || v === "-" || !v.startsWith("-")) return false
    // -l and -0 take only the digits after them, so a letter past those digits is an option of its own (-lne)
    const cluster = v.slice(1).replace(/l\d*|0(?:x[\da-f]*|\d*)/gi, (m) => m[0])
    for (const c of cluster) {
      if (c === "e" || c === "E") return true
      if ("CdDFiImMVx".includes(c)) break
    }
  }
  return false
}
// The words a text written into a hook file may not hold, whatever they name, since a hook learns its targets only when it runs: REMOVERS, find's -delete, shred, and their kin in other tools and languages
const HOOK_REMOVERS = new Set([
  ...REMOVERS,
  "-delete",
  "rimraf",
  "rm_f",
  "rm_r",
  "rm_rf",
  "rmdirsync",
  "rmsync",
  "rmtree",
  "shred",
  "srm",
  "trash",
  "trash-put",
  "unlinksync",
  "wipe",
])
// whether a word, in any case as macOS's filesystem reads a program's name, is a remover (HOOK_REMOVERS), a GNU build's g name read as the tool it builds
const hookRemoverWord = (word: string) => {
  const lower = word.toLowerCase()
  return HOOK_REMOVERS.has(GNU_NAMED.exec(lower)?.[1] ?? lower)
}
// What of a text makes it one a hook file may not hold, `hook` asked whether the file is one only once the text holds such a thing: a remover word anywhere in it, its quotes and backslashes dropped, else, in a text holding an expansion, a glob, a brace, a paren or an eval, a command of it whose program the shell reads as a remover, an eval, a program built from a variable or a substitution, or one named by a glob, a zsh group or a brace list, which may be any remover; text the hook cannot read (undefined) counts for a file `hook` is sure of
function hookRemover(
  text: string | undefined,
  hook: (sure: boolean) => boolean,
): string | undefined {
  if (text === undefined) return hook(true) ? "text it cannot read" : undefined
  // read with each backslash-newline joined, since the shell joins a word across one, and as typed, since a comment ends at its newline even after a backslash
  const word = [text.replace(/\\\n/g, ""), text]
    .flatMap((each) => each.replace(/[\\'"]/g, "").split(/[^\w-]+/))
    .find(hookRemoverWord)
  if (word) return hook(false) ? word : undefined
  if (!/[$`?*{(]|\[[^\]]*\]|\beval\b/.test(text) || !hook(false)) return
  for (const cmd of lex(text).commands) {
    const { first, name } = parse(cmd)
    if (marked(name)) return "a program built from a variable or a substitution"
    // a glob the shell sees in the program word (`/bin/r?`) or a zsh group (`/bin/r(m|x)`) picks the program at run time, and a brace list (`/bin/r{m,}`) spells it; test's own `[` and `[[` hold no pattern
    if (first?.unknown === BRACE) return "a program named by a brace list"
    if (first?.glob && /[?*(]|\[[^\]]*\]/.test(name)) return "a program named by a glob"
    if (name === "eval" || hookRemoverWord(program(name))) return program(name)
  }
}
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

// A path a copy reads its stdin through
const STDIN_PATH = /^\/dev\/(?:stdin|fd\/0)$/

// Every file a typed line writes: each writing redirect's target and each copy's (cp, dd, install, ln, mv), those of its groups, subshells and substitutions included, so a copy's source the line writes first reads as one the hook cannot see yet
function writtenWords(commands: Command[]): Word[] {
  return commands.flatMap((cmd) => {
    const { args, name } = parse(cmd)
    const tool = GNU_NAMED.exec(program(name))?.[1] ?? program(name)
    return [
      ...cmd.redirects.flatMap((r) => (r.target && writer(r) ? [r.target] : [])),
      ...(["cp", "dd", "install", "ln", "mv"].includes(tool)
        ? writeTargets(tool, args, tool !== program(name) || onLinux())
        : []),
      ...cmd.words.flatMap((word) => (word.procs ? writtenWords(word.procs) : [])),
      ...(cmd.inner ? writtenWords(cmd.inner()) : []),
    ]
  })
}

// Every text a typed line holds: each command's words as one text and each heredoc's or here-string's body, but a command's whose stdout its own redirect sends to a file, which reaches a hook only through that file (readPath) or as printed text, and those of each substitution, group, subshell and function body on it
function lineTextsOf(commands: Command[]): string[] {
  return commands.flatMap((cmd) => [
    ...(fdFiles(cmd.redirects, new Map()).has("1")
      ? []
      : [
          cmd.words.map((word) => word.value).join(" "),
          ...cmd.redirects.flatMap((r) => (r.body ? [r.body.value] : [])),
        ]),
    ...cmd.words.flatMap((word) => (word.procs ? lineTextsOf(word.procs) : [])),
    ...(cmd.inner ? lineTextsOf(cmd.inner()) : []),
  ])
}

const GLOB = /[*?[{(]/
// Whether a glob's path segment may match a name, read wider than any shell reads it: a backslash's next character as itself, a bracket expression as any one character, and from a group, brace or numeric range (or a ksh operator before a group) on, any text; a segment holding a zsh negation, exclusion or repeat (`^`, `~`, `#`), or a bracket expression holding a bracket (`[[:alpha:]]`), may match any name
function mayMatch(segment: string, name: string): boolean {
  let source = ""
  for (let k = 0; k < segment.length; k++) {
    const c = segment[k]
    if (c === "\\") source += (segment[++k] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    else if ("#^~".includes(c)) return true
    else if ("({<".includes(c) || ("*?+@!".includes(c) && segment[k + 1] === "(")) {
      source += ".*"
      break
    } else if (c === "*") source += ".*"
    else if (c === "?") source += "."
    else if (c === "[") {
      // its close: a ] right after the opening [, or after its ! or ^, is a member, and so is an escaped one
      let close = k + ("!^".includes(segment[k + 1]) ? 2 : 1)
      if (segment[close] === "[") return true
      for (close++; close < segment.length && segment[close] !== "]"; close++) {
        if (segment[close] === "[") return true
        if (segment[close] === "\\") close++
      }
      if (close >= segment.length) source += "\\["
      else {
        source += "."
        k = close
      }
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`, "is").test(name)
}
// The words a zsh group of plain alternatives spells (`(unconfined)`, `(a|.b)`), each group no `*`, `?`, `+`, `@` or `!` leads and holding no glob or group of its own, so one ksh operator's or zsh qualifier's group stays a glob
function alternatives(word: string): string[] {
  const group = /(?<![*?+@!\\])\(([^()*?[\]#^~<>]*)\)/.exec(word)
  if (!group || word.split("(").length > 7) return [word]
  const [before, after] = [word.slice(0, group.index), word.slice(group.index + group[0].length)]
  return group[1].split("|").flatMap((alt) => alternatives(before + alt + after))
}
// Whether a glob's path segment may match a name as bash and zsh read it: each word its brace lists expand to (braceWords), a brace with no list in it kept as text, read by mayMatch past the dot rule: with `dots` off (a fully static remote line, which holds no glob-option switch once visit has refused one), a name led by a dot matches only a segment led by one, so a `*`, `?` or `[…]` first reaches no `.playground`, unless a group holding `|` follows, since visit refused any other group or zsh qualifier as a switch
function globMatches(segment: string, name: string, dots: boolean): boolean {
  const words = braceWords(segment)?.flatMap(alternatives)
  if (!words || words.length > 64) return true
  return words.some((word) => {
    const text = word.replace(/(?<!\\)[{}]/g, "\\$&")
    if (!dots && name.startsWith(".") && /^[*?[]/.test(text) && !text.includes("(")) return false
    return mayMatch(text, name)
  })
}
// Variables that make git or a pager run a program, or point git at a config file that can, so a reader with one set is judged as any other program.
const RUNS = /^(?:EDITOR|GIT_[A-Z0-9_]+|HOME|LESSOPEN|PAGER|VISUAL|XDG_CONFIG_HOME)$/
// the variables that make a program run another, gh's (GH_EDITOR, GH_PAGER) and agent-browser's own among them, so a line setting one keeps a jq filter's and an eval script's canary reading
const TEXT_RUNS = new RegExp(`${RUNS.source}|^(?:AGENT_BROWSER_[A-Z0-9_]+|BROWSER|GH_[A-Z0-9_]+)$`)
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
    !rest.some((w) => /^(?:--out|-O|--op|--ext(?:-|$)|--textc)/.test(w))
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

// The shell's own folder, which a program that writes there by no operand (tar extracting, curl -O) names after an unread cd, so the hook can place it no more than the cd
const SHELL_FOLDER: Word = { quoted: false, value: "." }
// The long option of `long` a word names, by its full name or any prefix of one letter or more, as getopt_long reads a unique one; an ambiguous prefix names one of them, so the reading stays fail-closed
const longOf = (name: string, long: string[]): string | undefined =>
  long.find((l) => l === name) ??
  (name.length > 2 ? long.find((l) => l.startsWith(name)) : undefined)
// A program's words past its options, each option's value skipped: a short letter in `takes` takes the rest of its cluster or the next word, as does a long option in `long` with no = of its own
function operandsPast(args: Word[], takes: string, long: string[]): Word[] {
  const out: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--") return [...out, ...args.slice(k + 1)]
    if (v.startsWith("--")) {
      if (!v.includes("=") && longOf(v, long)) k++
    } else if (/^-./.test(v)) {
      const at = v
        .slice(1)
        .split("")
        .findIndex((c) => takes.includes(c))
      if (at !== -1 && at === v.length - 2) k++
    } else out.push(args[k])
  }
  return out
}
// The values an option of `short` or `long` names, attached, after an = or as the next word, read past a cluster's letters until one in `takes` takes the rest of the cluster, or the next word when it ends it; a long one by any prefix, or by its exact name alone under `exact`, as curl reads it
function optionValues(
  args: Word[],
  short: string,
  takes: string,
  long: string[],
  exact = false,
): Word[] {
  const out: Word[] = []
  for (let k = 0; k < args.length && args[k].value !== "--"; k++) {
    const v = args[k].value
    const eq = v.indexOf("=")
    if (v.startsWith("--")) {
      const name = eq === -1 ? v : v.slice(0, eq)
      if (exact ? long.includes(name) : longOf(name, long))
        if (eq !== -1) out.push(after(args[k], eq + 1))
        else if (args[k + 1]) out.push(args[++k])
    } else if (/^-./.test(v))
      for (let j = 1; j < v.length; j++) {
        if (!takes.includes(v[j])) continue
        const last = j + 1 === v.length
        const value = last ? args[++k] : after(args[k], j + 1)
        if (short.includes(v[j]) && value) out.push(value)
        break
      }
  }
  return out
}
// tar's short options that take a value, and both tars' long ones that do, so a value word that looks like -C reads as that value; bsdtar's --cd is its -C
const TAR_TAKES = "bCfFgHIKLNTVX"
const TAR_LONG_TAKES = [
  "--block-size",
  "--blocking-factor",
  "--cd",
  "--directory",
  "--exclude",
  "--exclude-from",
  "--exclude-tag",
  "--file",
  "--files-from",
  "--format",
  "--gid",
  "--gname",
  "--group",
  "--include",
  "--index-file",
  "--label",
  "--listed-incremental",
  "--mode",
  "--mtime",
  "--newer",
  "--newer-mtime",
  "--newer-mtime-than",
  "--newer-than",
  "--older",
  "--older-mtime",
  "--older-mtime-than",
  "--older-than",
  "--options",
  "--owner",
  "--passphrase",
  "--record-size",
  "--strip-components",
  "--suffix",
  "--to-command",
  "--transform",
  "--uid",
  "--uname",
  "--use-compress-program",
]
// Where tar extracting writes: each -C, --directory or --cd folder, read past the values tar's other options take, an old-style first word's letters taking the words after it in turn, or the shell's own folder when it names none; nothing when it does not extract
function tarWrites(args: Word[]): Word[] {
  const into: Word[] = []
  let extracts = false
  let k = 0
  const first = args[0]?.value ?? ""
  if (/^[A-Za-z]+$/.test(first)) {
    k = 1
    for (const c of first) {
      if (c === "x") extracts = true
      if (!TAR_TAKES.includes(c) || !args[k]) continue
      if (c === "C") into.push(args[k])
      k++
    }
  }
  for (; k < args.length && args[k].value !== "--"; k++) {
    const v = args[k].value
    const eq = v.indexOf("=")
    if (v.startsWith("--")) {
      const name = eq === -1 ? v : v.slice(0, eq)
      if (longOf(name, ["--extract", "--get"])) extracts = true
      const takes = longOf(name, TAR_LONG_TAKES)
      if (!takes) continue
      const value = eq !== -1 ? after(args[k], eq + 1) : args[++k]
      if ((takes === "--directory" || takes === "--cd") && value) into.push(value)
    } else if (/^-./.test(v))
      for (let j = 1; j < v.length; j++) {
        if (v[j] === "x") extracts = true
        if (!TAR_TAKES.includes(v[j])) continue
        const value = j + 1 === v.length ? args[++k] : after(args[k], j + 1)
        if (v[j] === "C" && value) into.push(value)
        break
      }
  }
  if (!extracts) return []
  return into.length > 0 ? into : [SHELL_FOLDER]
}
// chmod's mode word, octal or symbolic, which names no file
const MODE = /^(?:[0-7]+|[ugoa]*[-+=][-+=rwxXstugo,]*)$/
// curl's short options that take a value, of which -o, -c and -D write the file they name, and its long ones that write, each taken by its exact name alone, as curl takes it (--cookie is no --cookie-jar)
const CURL_TAKES = "AbcCdDeEFHKmoPQrtTuUwxXyYz"
const CURL_WRITES = [
  "--alt-svc",
  "--cookie-jar",
  "--dump-header",
  "--etag-save",
  "--hsts",
  "--libcurl",
  "--output",
  "--output-dir",
  "--stderr",
  "--trace",
  "--trace-ascii",
]
// A short cluster that holds curl's -O before any letter whose value takes the rest of the cluster (-sSO, not -XPOST)
function remoteName(v: string): boolean {
  if (!/^-[^-]/.test(v)) return false
  for (const c of v.slice(1)) {
    if (c === "O") return true
    if (CURL_TAKES.includes(c)) return false
  }
  return false
}

// Programs on neither REMOVERS nor WRITERS that unreadCdWrites judges by the words they write; after a cd the hook cannot read, any other program but a reader (reads()), sed or perl as their closed grammars read them (scriptRead) or one of NO_WRITES is refused, since it may write in the shell's folder
const UNREAD_CD_JUDGED = new Set(["chmod", "curl", "mktemp", "shred", "sort", "tar", "truncate"])
// Programs and builtins that write no file but through a redirect, each by its macOS man page or zsh's builtins (a for opener runs no command of its own)
const NO_WRITES = new Set([
  ":",
  "basename",
  "break",
  "cd",
  "continue",
  "cut",
  "date",
  "dirname",
  "exit",
  "false",
  "for",
  "id",
  "popd",
  "printenv",
  "pushd",
  "pwd",
  "read",
  "return",
  "set",
  "shift",
  "sleep",
  "sysctl",
  "tr",
  "true",
  "type",
  "uname",
  "unset",
  "wait",
  "which",
  "whoami",
])
// portless's subcommands that print its routes (`portless --help`), run bare or by bunx
const PORTLESS_READS = new Set(["get", "list"])
const portlessRead = (tool: string, args: Word[]): boolean => {
  const words = tool === "bunx" && args[0]?.value === "portless" ? args.slice(1) : args
  return (tool === "portless" || words !== args) && PORTLESS_READS.has(words[0]?.value ?? "")
}

// The folder git works in by its -C options alone, each read from the one before it; undefined when it has none or one the hook cannot read, since git reads its paths from the shell's folder for every other option, a --git-dir or --work-tree included (a --work-tree holding the shell's folder places nothing)
const gitPlaced = (args: Word[], env: Env): string | undefined => {
  let cwd: string | undefined
  for (let k = 0; k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value
    if (v === "-C") {
      const word = args[++k]
      cwd = word && pathOf(word, { ...env, cwd })
      if (cwd === undefined) return undefined
    } else if (GIT_TAKES.has(v)) k++
  }
  return cwd
}

// read at each call rather than once, so a test's stub of process.platform reaches every site
const onLinux = () => process.platform === "linux"
// whether a GNU build stops its options at its first operand: on Linux both readings, since POSIXLY_CORRECT can reach a bare build by a route the hook does not carry; elsewhere the one the call gives
const gnuReadings = (stops: boolean) => (onLinux() ? [false, true] : [stops])

// a word macOS chmod takes as a dash-led mode (-w, -go+x) rather than an option
const CHMOD_DASH_MODE = /^-[gorstuwXx]/
// a word GNU chmod reads as setting the mode: a cluster past its -R, -c, -f and -v flags that reaches a mode letter, operator or digit (-w, -=r, -0, -Rw), or --reference by any prefix down to --ref, the shortest --recursive does not share
const GNU_CHMOD_MODE = /^-[Rcfv]*[rwxXstugoa,+=0-7]/
const gnuChmodMode = (value: string) => {
  const long = value.split("=")[0]
  return GNU_CHMOD_MODE.test(value) || (long.length >= 5 && "--reference".startsWith(long))
}

// The words a program on neither REMOVERS nor WRITERS writes after a cd the hook cannot read: an in-place sed's or perl's files, every file chmod, truncate or shred names, tar's -C folder or the shell's when it extracts, curl's and sort's output files, git rm's pathspecs from git's own folder or its pathspec file's, and a mktemp template outside the temp folder
function unreadCdWrites(tool: string, args: Word[], env: Env, stopsAtOperand: boolean): Word[] {
  if (tool === "sed" || tool === "perl") return inPlace(tool, args)
  if (tool === "chmod") {
    // macOS chmod stops its options at its first operand, the mode, a dash-led one (-w) too, so every later word is a file, a dashed one too
    const at = args.findIndex((w) => !/^-./.test(w.value) || CHMOD_DASH_MODE.test(w.value))
    const files = stopsAtOperand
      ? args.slice(at === -1 ? args.length : at)
      : operandsPast(args, "", [])
    // GNU chmod, Linux's, takes its mode from a dash-led word or --reference when the call gives one (gnuChmodMode), so its first operand is then a file
    const given = onLinux() && !stopsAtOperand && args.some((w) => gnuChmodMode(w.value))
    return !given && MODE.test(files[0]?.value ?? "") ? files.slice(1) : files
  }
  if (tool === "truncate") return operandsPast(args, "rs", ["--reference", "--size"])
  if (tool === "shred")
    return operandsPast(args, "ns", ["--iterations", "--random-source", "--size"])
  if (tool === "tar") return tarWrites(args)
  if (tool === "curl") {
    const files = optionValues(args, "cDo", CURL_TAKES, CURL_WRITES, true)
    const named = args.some((a) => a.value.startsWith("--remote-name") || remoteName(a.value))
    return named && !args.some((a) => a.value.startsWith("--output-dir"))
      ? [...files, SHELL_FOLDER]
      : files
  }
  if (tool === "sort") return optionValues(args, "o", "koStT", ["--output"])
  if (tool === "git") {
    const { rest, sub } = gitCall(args, { ...env, cwd: undefined })
    if (sub !== "rm") return []
    const cwd = gitPlaced(args, env)
    const words = args.slice(args.length - rest.length)
    // a pathspec file names paths the hook does not read, each from git's own folder
    const listed = words.some((w) => longOf(w.value.split("=")[0], ["--pathspec-from-file"]))
    const specs = [
      ...operandsPast(words, "", ["--pathspec-from-file"]),
      ...(listed ? [SHELL_FOLDER] : []),
    ]
    return cwd === undefined
      ? specs
      : specs.map((w) => (w.value.startsWith("/") ? w : { ...w, value: join(cwd, w.value) }))
  }
  if (tool === "mktemp") {
    if (args.some((a) => a.value === "--tmpdir")) return []
    // macOS's -t takes a prefix, and makes a template given beside it where that template says; GNU's takes none, so its lone template reads as that value
    if (args.some((a) => /^-[^-]*t/.test(a.value))) return operandsPast(args, "pt", ["--suffix"])
    const into = optionValues(args, "p", "p", ["--tmpdir"])
    return into.length > 0 ? into : operandsPast(args, "p", ["--suffix"])
  }
  return []
}

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
  // the words an option took as its value
  const values: Word[] = []
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
      else if (!takes?.flags?.includes(long) && takes?.long.some((take) => take.startsWith(long)))
        values.push(...(attached ? [after(word, long.length + 3)] : args.slice(++k, k + 1)))
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
          values.push(...(rest ? [after(word, i + 1)] : args.slice(++k, k + 1)))
          break
        }
      }
  }
  // ln's lone operand links into the shell's folder, unless the shell splits it into more operands
  if (name === "ln" && !folder && operands.length === 1)
    return [{ quoted: false, value: "." }, ...splits]
  const targets = into && !folders ? (folder ? [folder] : operands.slice(-1)) : operands
  // on Linux, install -d with a -t folder or no operand writes nothing only because a GNU check after its parse fails, so that folder and the values its options took are judged as targets; read by the platform rather than `gnu`, so a g-named install on macOS keeps canary's verdict
  if (onLinux() && name === "install" && folders) {
    if (folder) targets.push(folder)
    if (operands.length === 0) targets.push(...values)
  }
  // macOS's cp, ln and mv take no target option and write to their last operand, so a split word moves no target there
  const moved = into && !gnu && name !== "install" ? [] : splits
  return [...new Set([...targets, ...maybe, ...logs, ...moved])]
}

// The settings keys a guard reads to allow or deny a call, A to Z: the hooks' (no-chat-question, no-glm-heavy-path, no-headless-login, no-outside-pr-code, no-playground-leak, no-public-leak, and role.ts, which places a session in the factory), spawn.sh's code root, ext.repos, which names the repository each scope syncs from, yard.logReaders, the bots this Mac answers a read of the dispatcher's log for, wa.alert, whose Approve stands in for that number's first WhatsApp message (ADR 0028), and wa.device and wa.owner, which choose the number ops-wa links as and the one it takes orders from; every jobs.<name> is refused beside them (JOB_PREFIX).
export const GUARD_KEYS = new Set([
  "ext.links",
  "ext.order",
  "ext.repos",
  "factory.archiveRepo",
  "factory.publicRepo",
  "github.pollMinutes",
  "glm.readOnlyLoad5",
  "live.branch",
  "owner.names",
  "paths.codeRoot",
  "sessions.aliases",
  "sessions.names",
  "slack.gatedSends",
  "usage.keychainService",
  "wa.alert",
  "wa.alertCheck",
  "wa.device",
  "wa.guestPolicy",
  "wa.owner",
  "wa.replyPolicy",
  "yard.logReaders",
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
  settings: ["--dry-run", "--propose"],
}

// Whether a word is the playground CLI in any one of the folders it may be read from: the command by name in any case, as macOS's filesystem reads it, or by a path that is no folder, or the checkout's cli.ts, with or without its extension, links followed; in a folder the hook cannot read, a relative word is the CLI by its last part alone (playground, cli or cli.ts).
function isCli(word: Word, dirs: (string | undefined)[]): boolean {
  tick()
  if (marked(word.value) || word.value.startsWith("-")) return false
  const paths = dirs.map((dir) => pathOf(word, { cwd: dir } as Env))
  if (program(word.value) === "playground")
    return !word.value.includes("/") || paths.some((path) => !path || !isFolder(path))
  const cli = (sep + CLI).toLowerCase()
  return paths.some((path) =>
    path === undefined
      ? /^cli(?:\.ts)?$/.test(program(word.value))
      : [path, `${path}.ts`].some((at) => real(at).toLowerCase().endsWith(cli)),
  )
}

// The folders a bun, bunx or npx call's word may land in: bun's last --cwd, for bun x and bunx also the folder their --cwd options chain to, and for a bun, bunx or npx that bunx, bun x, npx or bun run starts, its own folders read from the folder the runner starts it in, as no-main-checkout's runs() reads a bun x program.
function runnerDirs(name: string, args: Word[], env: Env, depth = 0): (string | undefined)[] {
  // each reading of the runner's options (runnerReadings), and an unread folder past them; past RUNNER_DEPTH runners, whose readings multiply at each one, the folder is unread
  if (depth > RUNNER_DEPTH) return [undefined]
  return runnerReadings(name, args).flatMap((reading) => readingDirs(name, reading, env, depth))
}
const RUNNER_DEPTH = 3
function readingDirs(name: string, args: Word[], env: Env, depth: number): (string | undefined)[] {
  if (args[1] === UNREAD_CWD) return [undefined]
  if (name === "bunx") return readingDirs("bun", [X, ...args], env, depth)
  if (name === "npx") return startedDirs(args.slice(runnerTarget(args)), env, depth)
  if (name !== "bun") return []
  const { at, chained, cwd, words } = bunCall(args, env)
  const x = words[0] === "x"
  const own = x ? [cwd, chained] : [cwd]
  const started = x || words[0] === "run" ? args.slice(at) : []
  return [...own, ...startedDirs(started, { ...env, cwd: x ? chained : cwd }, depth)]
}

// The folders of a package runner that a runner starts in env's folder, behind any wrapper the reader parses (env, nice), whose env -C moves it
function startedDirs(words: Word[], env: Env, depth: number): (string | undefined)[] {
  if (words.length === 0) return []
  const { args, chdir, name } = parse({ redirects: [], scope: 0, words })
  const tool = toolName(name)
  if (!STARTED_RUNNERS.has(tool)) return []
  // a runner started straight by a runner is already read both ways in the outer reading (runnerReadings), so only one behind a wrapper is read again
  if (toolName(words[0]?.value) === tool) return readingDirs(tool, args, env, depth)
  return runnerDirs(tool, args, chdir ? { ...env, cwd: pathOf(chdir, env) } : env, depth + 1)
}

// The words after each word of a command that is the playground CLI, so the CLI behind any wrapper (bun, npx, find -exec, arch, watch) is read as typed bare, a package runner's word read in each folder runnerDirs names too.
function cliCalls(parsed: Parsed, env: Env): Word[][] {
  const { args, first, name } = parsed
  if (!first) return []
  const words = [first, ...args]
  const dirs = [env.cwd, ...runnerDirs(name, args, env)]
  // a runner behind a wrapper the reader does not parse (find -exec, arch, watch) reads its folders from each one found before it (the shell's, an outer runner's), all unread past 16, and find's -execdir runs it in a folder the hook cannot read
  for (const [at, word] of words.entries()) {
    const tool = toolName(word.value)
    const bases = [...new Set(dirs)]
    if (at > 0 && STARTED_RUNNERS.has(tool))
      for (const here of bases.length > 16 ? [undefined] : bases)
        dirs.push(...runnerDirs(tool, words.slice(at + 1), { ...env, cwd: here }))
    if (word.value === "-execdir" || word.value === "-okdir") dirs.push(undefined)
  }
  const unique = [...new Set(dirs)]
  return words.flatMap((word, at) => (isCli(word, unique) ? [words.slice(at + 1)] : []))
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
// what lets an awk program run a command or write a file: system(), an @ directive, a > redirect (awkRedirects), and a | pipe outside the literals awkPipe allows, the one way a getline runs a command (`"cmd" | getline`), since a plain getline or one from a file only reads
const AWK_RUNS = /system|@/
// a regex literal where awk reads only a pattern: at the program's start or after {, }, ;, !, (, ,, ~, &&, || or a newline, holding no quote, no [ and no newline, so a > in it (`/^>>>>>>> /`) is a character it matches, never a redirect
const AWK_PATTERN = /(^|[{};!(,~\n]|&&|\|\|)(\s*)\/(?:[^\\/"[\n]|\\.)*\//g
// AWK_PATTERN's regex, a bracket expression in it read whole (`/^[a-z/]+:/`), for awkRedirects alone, which needs no / left
const AWK_BRACKETED =
  /(^|[{};!(,~\n]|&&|\|\|)(\s*)\/(?:[^\\/"[\n]|\\.|\[\^?\]?(?:[^\]\\\n]|\\.)*\])*\//g
const awkRuns = (program: string) =>
  AWK_RUNS.test(program.replace(AWK_PATTERN, "$1$2RE")) ||
  awkRedirects(program.replace(AWK_BRACKETED, "$1$2RE")) ||
  awkPipe(program)

// Whether an awk program may redirect with >: awk reads one only in a print or printf statement outside parentheses, so a > in a pattern, a condition or a parenthesized expression compares; its strings are masked first, a statement's continued lines joined, and a program still holding a / (a division, or a regex the pattern mask left) counts every > as canary did
function awkRedirects(program: string): boolean {
  // a backslash-newline, or a newline after a comma, && or ||, continues the statement, as awk reads it
  const text = program.replace(/"(?:[^"\\\n]|\\.)*"/g, "S").replace(/\\\n|(,|&&|\|\|)\s*\n/g, "$1 ")
  if (!text.includes(">")) return false
  if (/["/]/.test(text)) return true
  let depth = 0
  let printing = false
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (c === "(") depth++
    else if (c === ")") depth = Math.max(0, depth - 1)
    else if (/[;{}\n]/.test(c)) {
      depth = 0
      printing = false
    } else if (c === ">" && printing && depth === 0) return true
    else if (/^printf?\b/.test(text.slice(k)) && !/[\w$]/.test(text[k - 1] ?? "")) printing = true
  }
  return false
}

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

// awk's program words as text, or none: every program a literal word holding no | (a pipe, which awkPipe would weigh against a regex's alternation), no " (a string, so it prints only what it reads, never a command line of its own into a file that runs) and nothing awkRuns finds
function awkTexts(args: Word[]): Word[] {
  const programs = awkPrograms(args) ?? []
  return programs.every((w) => literal(w) && !/[|"]/.test(w.value) && !awkRuns(w.value))
    ? programs
    : []
}

const EVALUATES = new Set(["-e", "-ep", "--eval", "-p", "-pe", "--print"])
// An inline evaluator's program word, JavaScript the shell never reads as a line: bun's or node's -e, --eval, -p or --print value (-pe and -ep included) among the options before any script, or agent-browser's eval script or wait --fn expression; undefined for any other call
function evalProgram({ args, name }: Parsed): Word | undefined {
  // agent-browser's eval, or its wait whose next word is --fn, after its options, a --name option's value (`--session foo`) included
  if (name === "agent-browser") {
    for (let k = 0; k < args.length; k++) {
      const { value } = args[k]
      if (value === "eval") return args[k + 1]
      if (value === "wait") return args[k + 1]?.value === "--fn" ? args[k + 2] : undefined
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
const SED_ITEM = String.raw`[ \t]*(?:${SED_ADDRESS}(?:[ \t]*,[ \t]*(?:${SED_ADDRESS}|[+~]\d+))?[ \t]*!?[ \t]*)?(?:[=dlnNpPqQ]|s/${SED_BODY}(${SED_TEXT})[giImMp0-9]*)[ \t]*`
// a sed script read whole by a closed grammar: addresses, then =, d, l, n, N, p, P, q, Q or s/// with flags from g, i, I, m, M, p and digits, so it holds no w or W write, no e run and no r read of another file
const SED_SCRIPT = new RegExp(String.raw`^${SED_ITEM}(?:[;\n]${SED_ITEM})*;?$`)
// one item of a read-only sed's script and its separator, its s/// replacement captured, read in turn from where the last ended
const SED_STEP = new RegExp(String.raw`${SED_ITEM}(?:[;\n]|$)`, "y")

// The scripts of a sed call that only reads and prints, or undefined: every option on SED_FLAG's list, and every script (each -e value, else the first operand) a literal word, unglobbed, that SED_SCRIPT holds
function sedReadScripts(args: Word[]): Word[] | undefined {
  const scripts: Word[] = []
  const operands: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (value === "-e" || value === "--expression") {
      if (!args[k + 1]) return undefined
      scripts.push(args[++k])
    } else if (value.startsWith("--expression="))
      scripts.push({ ...args[k], value: value.slice("--expression=".length) })
    else if (value === "--") {
      operands.push(...args.slice(k + 1))
      break
    } else if (value.startsWith("-") && value !== "-") {
      if (!SED_FLAG.test(value)) return undefined
    } else operands.push(args[k])
  }
  const read = scripts.length ? scripts : operands.slice(0, 1)
  return read.length > 0 && read.every((w) => literal(w) && SED_SCRIPT.test(w.value))
    ? read
    : undefined
}

// The options of a playground call whose value is free text for a person to read, never a path or a command; gh's posts have their own reading (ghTexts)
const TEXT_FLAGS = new Set(["--body", "--reason", "--title"])

// The words of a playground call that are a text flag's value: the word after --body, --reason or --title, and the word that attaches one with =
function textFlagValues({ args, name }: Parsed): Word[] {
  if (program(name) !== "playground") return []
  return args.filter(
    (word, k) =>
      TEXT_FLAGS.has(args[k - 1]?.value ?? "") ||
      [...TEXT_FLAGS].some((flag) => word.value.startsWith(`${flag}=`)),
  )
}

// sed's in-place option: -i after any of -E, -n, -r, -s, -u and -z, its backup suffix attached (holding no / or *, which GNU writes into another folder) or, when nothing is attached, macOS's next word (sedEdits reads Linux's)
const SED_IN_PLACE = /^-[Enrsuz]*i([\w.~-]*)$/
// a bare -i's suffix word: empty or a dot and letters, so a GNU sed, which reads that word as its script, reads it as no command or none it knows
const SED_SUFFIX = /^(?:\.[\w.~-]*)?$/
const SED_EDIT_ADDRESS = String.raw`(?:\d+|\$|/${SED_BODY})`
// one item of an in-place sed's script, its s/// replacement captured
const SED_EDIT_ITEM = String.raw`[ \t]*(?:${SED_EDIT_ADDRESS}(?:[ \t]*,[ \t]*${SED_EDIT_ADDRESS})?[ \t]*)?(?:[dp]|s/${SED_BODY}(${SED_TEXT})[gpI0-9]*)[ \t]*`
// an in-place sed's script read whole by its allowlist: line, $ or /regex/ addresses and their ranges, then d, p, or s/// with flags from g, p, I and digits; every other command and flag (w, W, r, R, e, s///w, s///e) is off it
const SED_EDIT = new RegExp(String.raw`^${SED_EDIT_ITEM}(?:[;\n]${SED_EDIT_ITEM})*;?$`)
// Whether a path's parts can match each of `want`'s in turn, the parts after them free: each a glob of its own, a ** matching the rest, a zsh (a|b) read as {a,b}, and a lone ( or ), a subshell's, dropped
function follows(have: string[], want: string[]): boolean {
  for (let k = 0; k < want.length; k++) {
    const part = have[k]
    if (part === "**") return true
    if (part === undefined) return false
    const glob =
      part.includes("(") && part.includes(")")
        ? part.replace(/\(/g, "{").replace(/\)/g, "}").replace(/\|/g, ",")
        : part.replace(/[()]/g, "")
    if (!new Bun.Glob(glob).match(want[k])) return false
  }
  return true
}
// a variable a script's text sets, by an assignment or a for loop, its name and its value or list captured
const SETS_NAME = /(?:^|[\s;&|(`])([A-Za-z_]\w*)=(\S*)|\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*)/g
// a substitution that prints the home itself: a ~, ~login, $HOME or ${HOME…} word with at most a / after it, or a bare cd (to the home)
const HOME_NAMED =
  /(?:^|[\s(`])(~[\w.-]*|\$HOME|\$\{HOME(?:[^}\w][^}]*)?\})\/?(?=$|[\s;&|)`])|\bcd\s*(?:$|[;&|)`])/
// a word the shell expands to the home: ~, $HOME, or ${HOME} with any operator (${HOME:?}, ${HOME:-x})
const HOME_WORD = /^(?:~|\$HOME|\$\{HOME(?:[^}\w][^}]*)?\})(?=[/*]|$)/
// ~ and a login name, the home of the login it names, which for the caller's own is its home
const LOGIN_HOME = /^~([A-Za-z_][\w.-]*)(?=[/*]|$)/
// whether a word names a remover (REMOVERS), by its path's last part, a GNU build's g name read as the tool it builds
const removerWord = (word: string) => {
  const name = word.split(sep).at(-1) ?? ""
  return REMOVERS.has(GNU_NAMED.exec(name)?.[1] ?? name)
}
// one item of an in-place sed's script and its separator, read in turn from where the last ended
const SED_EDIT_STEP = new RegExp(String.raw`${SED_EDIT_ITEM}(?:[;\n]|$)`, "y")
// the character a code spells in its base, its blanks and underscores dropped as perl drops them, a * for a code that is no number in that base, or the escape as written when no character has that code
const coded = (digits: string, base: number, escape: string) => {
  const clean = digits.replace(/[\s_]/g, "")
  if (!(base === 16 ? /^[\da-f]+$/i : base === 8 ? /^[0-7]+$/ : /^\d+$/).test(clean)) return "*"
  const point = Number.parseInt(clean, base)
  return point <= 0x10ffff ? String.fromCodePoint(point) : escape
}
// a sed replacement as sed writes it: GNU's \xHH, \oNNN and \dNNN as the character they spell on every platform, any other backslash dropped (`\/` reads as /, `\n` as a line break) and the matched text (&, \1 to \9) read as a *, since it can be anything
const sedText = (text: string) =>
  text.replace(
    /\\(?:x([\da-fA-F]{1,2})|o([0-7]{1,3})|d(\d{1,3})|(.))|&/gs,
    (m, hex?: string, octal?: string, decimal?: string, c?: string) =>
      hex
        ? coded(hex, 16, m)
        : octal
          ? coded(octal, 8, m)
          : decimal
            ? coded(decimal, 10, m)
            : m === "&" || /[1-9]/.test(c ?? "")
              ? "*"
              : c === "n"
                ? "\n"
                : (c ?? m),
  )
// The text each s/// of a sed script writes (or a perl one's, by its step and its read, its print's text too), its items read in turn by `step`, which captures each replacement and a print's values, and spelled as `read` writes it; the whole script read so when its items do not read in turn
function sedWrites(script: string, step = SED_EDIT_STEP, read = sedText): string[] {
  const writes: string[] = []
  step.lastIndex = 0
  while (step.lastIndex < script.length) {
    const at = step.lastIndex
    const item = step.exec(script)
    if (!item || step.lastIndex === at) return [read(script)]
    if (item[1]) writes.push(read(item[1].slice(0, -1)))
    if (item[2]) writes.push(read(printText(item[2])))
  }
  return writes
}

// The scripts of a sed call that edits its files in place and writes nothing else, or undefined, its argv read as macOS sed reads it, or GNU's on Linux (sedEdits): sed as its own program (ownProgram) with no variable set in the call, an in-place option (SED_IN_PLACE) whose bare form takes the next word as its suffix (SED_SUFFIX) on macOS, every other option on -E, -n, -r, -s, -u and -z, and every script (each -e value, else the first operand) a literal word that SED_EDIT holds, while each other operand, a file it edits, is judged as any word is
function sedInPlace(cmd: Command, parsed: Parsed): Set<Word> | undefined {
  const { args, local, name } = parsed
  if (!SEDS.has(program(name)) || local.size > 0 || !ownProgram(cmd, parsed)) return undefined
  return sedEdits(args)
}
// The scripts of a sed call's words that edit its files in place and write nothing else, by sedInPlace's reading of them
function sedEdits(args: Word[]): Set<Word> | undefined {
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
      // GNU sed, Linux's, takes a suffix only attached, so the word after its bare -i is a script or a file
      if (suffix[1] || onLinux()) continue
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

// An in-place perl edit read call by call as an in-place sed is: perl as its own program with no PERL variable set, its options l, n, p and w clustered with a bare i (`-pi`), each -e script a literal word PERL_SCRIPT holds, and each file a literal PERL_FILE; its scripts are the words it returns, text perl reads as its program
function perlInPlace(cmd: Command, parsed: Parsed, env: Env): Set<Word> | undefined {
  if (program(parsed.name) !== "perl" || !ownProgram(cmd, parsed)) return undefined
  return perlEdits(parsed, env)
}
// The scripts of a perl call's words that edit its files in place and write nothing else, by perlInPlace's reading of them
function perlEdits({ args, local }: Parsed, env: Env): Set<Word> | undefined {
  if ([...local.keys(), ...env.vars.keys()].some((key) => key.startsWith("PERL"))) return undefined
  const scripts: Word[] = []
  let inPlace = false
  let k = 0
  for (; k < args.length && args[k].value.startsWith("-") && args[k].value !== "-"; k++) {
    const { value } = args[k]
    if (value === "--") {
      k++
      break
    }
    if (!PERL_IN_PLACE.test(value)) return undefined
    if (value.endsWith("i")) inPlace = true
    if (value.endsWith("e")) {
      if (!args[k + 1]) return undefined
      scripts.push(args[++k])
    }
  }
  const files = args.slice(k)
  if (!inPlace || scripts.length === 0 || files.length === 0) return undefined
  if (!scripts.every((w) => literal(w) && PERL_SCRIPT.test(w.value))) return undefined
  if (!files.every((w) => literal(w) && PERL_FILE.test(w.value))) return undefined
  return new Set(scripts)
}
// an in-place perl edit's option clusters of l, n, p and w: one ending in i, which takes the rest of its cluster as a backup suffix and so ends it bare (`-pi`), or one whose last letter is e, whose script is the next word
const PERL_IN_PLACE = /^-[lnpw]*[ei]?$/
// Whether sed or perl is read whole by its closed grammars, a read or an in-place edit whose files unreadCdWrites places, so after a cd the hook cannot read any other call of either is refused
function scriptRead(tool: string, parsed: Parsed, env: Env): boolean {
  // xargs hands an in-place edit its files, judged by placement as any of its words
  const edits = { ...parsed, args: parsed.xargs ? [...parsed.args, XARGS_FILE] : parsed.args }
  return tool === "sed"
    ? !!(sedReadScripts(parsed.args) || (parsed.local.size === 0 && sedEdits(edits.args)))
    : tool === "perl" && (perlReads(parsed, env) || !!perlEdits(edits, env))
}
const XARGS_FILE: Word = { quoted: false, value: "/dev/stdin" }
// Each word an in-place sed or perl edit reads as its script, or undefined for any other call
const inPlaceScripts = (cmd: Command, parsed: Parsed, env: Env) =>
  sedInPlace(cmd, parsed) ?? perlInPlace(cmd, parsed, env)

// perl's options that run no other code and write nothing: a, l, n, p and w clustered, the last of them may be e or E, whose script is the next word; -d, -i, -I, -m, -M, -s, -x and the rest are off it
const PERL_FLAG = /^-[alnpw]*[eE]?$/
// a regex with no variable, no array and no code block (`(?{`, `(??{`, `(*{`), its $ only an anchor
const PERL_BODY = String.raw`(?:[^/\\\n@$(]|\((?![?*]\??\{)|\\.|\$(?=[/|)]))*/`
const PERL_RE = `/${PERL_BODY}`
// a match variable, $1 to $9 or $&, before no [, { or ->, since perl reads one there as a subscript and runs its expression as code
const PERL_MATCH = String.raw`\$[1-9&](?![[{]|->)`
// a value print may name: a string holding only text, \n, \t and the match variables $1 to $9 and $&, or one of those variables, or $_
const PERL_VALUE = String.raw`(?:"(?:[^"\\$@\n]|\\[nt"\\]|${PERL_MATCH})*"|\$[1-9&_])`
// a print's values are captured, the text it writes
const PERL_PRINT = String.raw`print(?:[ \t]+(${PERL_VALUE}(?:[ \t]*,[ \t]*${PERL_VALUE})*))?(?:[ \t]+(?:for|if|unless|while)[ \t]+${PERL_RE}[gimsx]*)?`
const PERL_SUB = String.raw`s/${PERL_BODY}((?:[^/\\\n@$]|\\.|${PERL_MATCH})*/)[gimsx]*`
// s/// first, so its replacement is the first capture and a print's values the second, as sedWrites reads them
const PERL_ITEM = String.raw`[ \t]*(?:${PERL_SUB}|${PERL_PRINT})[ \t]*`
// a perl one-liner read whole by a closed grammar: print statements of match variables and plain strings, each optionally under for, if, unless or while a regex, and s/// with flags from g, i, m, s and x, so no regex holds a variable, an array or a code block and no replacement interpolates code
const PERL_SCRIPT = new RegExp(String.raw`^${PERL_ITEM}(?:;${PERL_ITEM})*;?[ \t]*$`)
// the text a print of its values writes: perl joins them with nothing ($, is empty), each string as its text and each variable as $1, which perlText reads as a *
const PRINT_VALUE = new RegExp(PERL_VALUE, "g")
const printText = (values: string) =>
  [...values.matchAll(PRINT_VALUE)]
    .map(([v]) => (v.startsWith('"') ? v.slice(1, -1) : "$1"))
    .join("")
// one item of a PERL_SCRIPT one-liner and its separator, its s/// replacement captured, read in turn from where the last ended
const PERL_STEP = new RegExp(String.raw`${PERL_ITEM}(?:;[ \t]*|$)`, "y")
// the characters of the root's path perl's \N{NAME} spells by a Unicode name, as perl's charnames reads one: SOLIDUS, FULL STOP, HYPHEN-MINUS, LOW LINE, a DIGIT and a LATIN SMALL or CAPITAL LETTER; any other name reads as a *, since it spells some character
function charName(name: string): string {
  const spelled = name.trim().toUpperCase().replace(/\s+/g, " ")
  const fixed: Record<string, string> = {
    "FULL STOP": ".",
    "HYPHEN-MINUS": "-",
    "LOW LINE": "_",
    SOLIDUS: "/",
  }
  const digits = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"]
  const letter = /^LATIN (SMALL|CAPITAL) LETTER ([A-Z])$/.exec(spelled)
  const digit = /^DIGIT ([A-Z]+)$/.exec(spelled)
  if (letter) return letter[1] === "SMALL" ? letter[2].toLowerCase() : letter[2]
  if (digit && digits.includes(digit[1])) return String(digits.indexOf(digit[1]))
  return fixed[spelled] ?? "*"
}
// a perl escape and what it spells: a code (\xHH, \x{…}, \N{U+…}, \o{…}, an octal of up to three digits led by 0 or of two or three led by 1 to 7, blanks and underscores in braces dropped), a Unicode name (\N{NAME}), or any other escaped character; or a match variable ($1 to $9, $&)
const PERL_ESCAPE =
  /\\(?:x\{(?<hexBraced>[^}]*)\}|x(?<hex>[\da-fA-F]{1,2})|N\{\s*U\+(?<point>[^}]*)\}|N\{(?<name>[^}]*)\}|o\{(?<octalBraced>[^}]*)\}|(?<octal>0[0-7]{0,2}|[1-7][0-7]{1,2})|(?<char>.))|\$[1-9&]/gs
// a perl replacement as perl writes it, a double-quoted string: each code as the character it spells, each name by charName, any other backslash dropped (`\/` reads as /, `\n` and `\t` as a line break and a tab) and the matched text ($1 to $9, $&, and \1 to \9, which perl reads as $1 to $9) read as a *
const perlText = (text: string) =>
  text.replace(PERL_ESCAPE, (m, ...rest) => {
    const g = rest.at(-1) as Record<string, string | undefined>
    const hex = g.hexBraced ?? g.hex ?? g.point
    const octal = g.octalBraced ?? g.octal
    if (hex !== undefined) return coded(hex, 16, m)
    if (octal !== undefined) return coded(octal, 8, m)
    if (g.name !== undefined) return charName(g.name)
    const c = g.char
    return c === undefined || /[1-9]/.test(c) ? "*" : c === "n" ? "\n" : c === "t" ? "\t" : c
  })

// a file operand perl's -n and -p open as a file alone: its 2-arg open runs a name ending or starting in | as a command, and reads <, >, + and & as modes
const PERL_FILE = /^(?:-|[^\s|<>+&-][^|]*(?<!\s))$/

// The scripts of a perl call that only reads and prints, or undefined: every option on PERL_FLAG's list, at least one -e or -E script, every script a literal word, unglobbed, that PERL_SCRIPT holds, every file operand a literal PERL_FILE, and no PERL variable set, since PERL5OPT and PERL5LIB load code
function perlReadScripts({ args, local }: Parsed, env: Env): Word[] | undefined {
  if ([...local.keys(), ...env.vars.keys()].some((key) => key.startsWith("PERL"))) return undefined
  const scripts: Word[] = []
  let k = 0
  for (; k < args.length; k++) {
    const { value } = args[k]
    if (value === "--") {
      k++
      break
    }
    if (!value.startsWith("-") || value === "-") break
    if (!PERL_FLAG.test(value)) return undefined
    if (/[eE]$/.test(value)) {
      if (!args[k + 1]) return undefined
      scripts.push(args[++k])
    }
  }
  const files = args.slice(k)
  return scripts.length > 0 &&
    scripts.every((w) => literal(w) && PERL_SCRIPT.test(w.value)) &&
    files.every((w) => literal(w) && PERL_FILE.test(w.value))
    ? scripts
    : undefined
}
// Whether a perl call only reads and prints, by perlReadScripts' reading of it
const perlReads = (parsed: Parsed, env: Env) => !!perlReadScripts(parsed, env)

// What a sed or perl call that edits no file in place writes, for the root reading its literal twin gets: a read's s/// replacements and perl's print text as sed or perl writes them (sedWrites), else, off both grammars, each word with its escaped slashes and the characters its codes spell read as written (sedText, perlText); none for any other program
function escapedWrites(parsed: Parsed, env: Env): string[] {
  const tool = program(parsed.name)
  const unescaped = (read: (text: string) => string) => parsed.args.map((word) => read(word.value))
  if (SEDS.has(tool))
    return (
      sedReadScripts(parsed.args)?.flatMap((w) => sedWrites(w.value, SED_STEP)) ??
      unescaped(sedText)
    )
  if (tool !== "perl") return []
  return (
    perlReadScripts(parsed, env)?.flatMap((w) => sedWrites(w.value, PERL_STEP, perlText)) ??
    unescaped(perlText)
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

// The parts of a line the shell runs as code, found outside a quoted heredoc's body, single quotes and a double-quoted text with no $: a zsh e glob qualifier and an e or P parameter flag's expansion, where the lexer reads a plain word, and a zsh =(…), whose commands the lexer reads too, each as written with its single-quoted spans collapsed; a prompt expansion (@P) or a glob substitution (`${~…}`, `$~…`), which runs a value set elsewhere, gives the whole line
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

// Whether a call is grep that xargs starts, read as a direct grep is: xargs its command's own first word, bare or by a system path, then only its own options, each read one way (no other reading in `also`, no wrapper's name among them), no variable set, its own --process-slot-var included, no replace string inside grep's own word, which stdin would put in place of the program, and grep bare or by a system path
function xargsGrep(cmd: Command, parsed: Parsed, env: Env): boolean {
  const { also, chdir, first, local, name, xargs } = parsed
  const lead = cmd.words.find((word) => /(?:^|\/)xargs$/.test(word.value))
  const system = /^(?:\/(?:bin|opt\/homebrew\/bin|usr\/bin|usr\/local\/bin)\/)?[^/]+$/
  return (
    !!xargs &&
    !!first &&
    name === "grep" &&
    also.length === 0 &&
    !chdir &&
    local.size === 0 &&
    ownFirst(cmd, lead) &&
    system.test(lead.value) &&
    system.test(first.value) &&
    (xargs.replace === undefined || !first.value.includes(xargs.replace)) &&
    xargsOptions(cmd, first).every(
      (value) =>
        !marked(value) &&
        !WRAPPERS.has(program(value)) &&
        !/^--process-slot-var(?:=|$)/.test(value),
    ) &&
    reads(parsed, env)
  )
}

// Each descriptor's file words once a command's redirects apply, from those it inherits (a group around it, an earlier exec): a writing redirect names its file (&> and >&<file> for stdout and stderr both), a duplicate (>&N) takes N's, or the file a later redirect of the same command opens on N, and any other redirect onto a descriptor leaves it no file
function fdFiles(redirects: Command["redirects"], inherited: Map<string, Word[]>) {
  const fds = new Map(inherited)
  const fdOf = (r: Command["redirects"][number]) =>
    r.fd === "&" || (r.fd === "" && r.op !== "<>") ? "1" : r.fd || "0"
  const opened = (fd: string) =>
    redirects.flatMap((r) => (r.target && writer(r) && fdOf(r) === fd ? [r.target] : []))
  for (const r of redirects) {
    if (!r.target || !(r.op.startsWith(">") || r.op === "<>")) continue
    const fd = fdOf(r)
    const n = r.target.value
    const dup = r.op === ">&" && /^\d+$/.test(n)
    const files = dup ? [...(fds.get(n) ?? []), ...opened(n)] : writer(r) ? [r.target] : []
    fds.set(fd, files)
    if (r.fd === "&" || (r.op === ">&" && r.fd === "" && !dup)) fds.set("2", files)
  }
  return fds
}
// reserved words a command's opener or closer may follow
const LEADS = new Set(["!", "(", "do", "elif", "else", "then", "{"])
const OPENERS = new Set(["case", "for", "if", "select", "until", "while"])
const CLOSERS = new Set(["done", "esac", "fi"])
// The commands each compound's closer (fi, done, esac) holds, its opener's included, in every scope of a line, so a redirect on the closer writes what they print
function compoundBodies(commands: Command[], bodies = new WeakMap<Command, Command[]>()) {
  const open: number[] = []
  commands.forEach((cmd, k) => {
    const lead = cmd.words.find((w) => w.quoted || !LEADS.has(w.value))
    if (lead && !lead.quoted && OPENERS.has(lead.value)) open.push(k)
    else if (lead && !lead.quoted && CLOSERS.has(lead.value) && open.length > 0)
      bodies.set(cmd, commands.slice(open.pop(), k))
    if (cmd.inner) compoundBodies(cmd.inner(), bodies)
  })
  return bodies
}
// Programs that print nothing to their stdout, so a hook file takes no text from them
const SILENT = new Set([":", "[", "cd", "false", "test", "true"])
// the commands a group, a subshell or a compound's closer holds, none for any other command
type Kids = (cmd: Command) => Command[] | undefined
// What a command prints that a hook file may take: a printer's, a bare cat's or tee's output as the shell prints it (outputOf), a sed's or perl's that edits no file in place (escapedWrites), or the commands' a group, subshell or compound holds whose stdout is its own; none for a program that prints nothing (SILENT), and undefined for another program or text the hook cannot read
async function printed(cmd: Command, env: Env, kids: Kids): Promise<(string | undefined)[]> {
  const held = kids(cmd)
  if (held) {
    const own = held.filter((c) => !fdFiles(c.redirects, new Map()).has("1"))
    return (await Promise.all(own.map((c) => printed(c, env, kids)))).flat()
  }
  const parsed = parse(cmd)
  const { args, name } = parsed
  if (SILENT.has(name)) return []
  // cat's text is its stdin's alone, since the hook reads no file's text into a hook
  const files = name === "cat" && args.some((a) => a.value !== "-" && !a.value.startsWith("-"))
  if (!files && (name === "" || PRINTERS.has(name) || name === "cat" || name === "tee")) {
    const out = await outputOf(cmd, env)
    return [out.unknown ? undefined : out.value]
  }
  const tool = GNU_NAMED.exec(name)?.[1] ?? name
  if (files || (!SEDS.has(program(name)) && tool !== "perl")) return [undefined]
  return inPlace(tool, parsed.args).length > 0 ? [] : escapedWrites(parsed, env)
}
// the folder git runs a folder's repo's hooks from (core.hooksPath, else .git/hooks), read by git itself with every GIT_ variable dropped, in the C locale and under a 2 s cap, at its nearest folder that exists, so a folder the same line makes is read too: false outside a repo, and true, any folder may be one, when git fails another way or runs past the cap
function readHookFolder(dir: string): string | boolean {
  let at = dir
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "LC_ALL"),
  )
  try {
    const read = Bun.spawnSync(["git", "-C", at, "rev-parse", "--git-path", "hooks"], {
      env: { ...env, LC_ALL: "C" },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 2000,
    })
    if (read.exitCode === 0) return real(resolve(at, read.stdout.toString().trim()))
    return read.exitCode !== 128 || !read.stderr.toString().includes("not a git repository")
  } catch {
    return true
  }
}
// each folder's hook folder (readHookFolder), read once a folder
const hookFolders = new Map<string, string | boolean>()
// Whether a path is a hook file: one in a .git/hooks folder, or in the folder its repo's hooks run from, or, unless `sure`, any file in a folder git could not answer for; never a device under /dev
function hookFile(path: string | undefined, sure = false): boolean {
  if (!path) return false
  if (/(?:^|\/)\.git\/hooks\//.test(path)) return true
  if (resolve(path).startsWith("/dev/")) return false
  const dir = dirname(path)
  if (!hookFolders.has(dir)) hookFolders.set(dir, readHookFolder(dir))
  const folder = hookFolders.get(dir)
  return (!sure && folder === true) || folder === real(dir)
}
// Each spelling of a text that a hook may run: as typed, with its backslash-newlines joined as the shell joins a word across one, with its escapes read as a sed's or perl's replacement reads them (\U, \L, \E and their kin dropped, \n a newline, any other escaped character itself) and then joined, and each of those in lower case outside its variables, since macOS's filesystem reads a path in any case
function hookSpellings(text: string): string[] {
  const joined = text.replace(/\\\n/g, "")
  const escaped = text
    .replace(/\\[ELQUlu]/g, "")
    .replace(/\\([\s\S])/g, (_, c: string) => (c === "n" ? "\n" : c))
    .replace(/\\\n/g, "")
  const lower = (each: string) =>
    each.replace(/\$\{[^}]*\}|\$\w+|[^$]+|\$/g, (part) =>
      part.startsWith("$") ? part : part.toLowerCase(),
    )
  return [...new Set([text, joined, escaped].flatMap((each) => [each, lower(each)]))]
}

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
  if (SEDS.has(base)) return !!sedReadScripts(args)
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
function rooted(commands: Command[], files?: Files): boolean {
  if (codeFed(commands).size > 0) return true
  return commands.some(
    (cmd) =>
      (!!stdinShell(cmd) && !sshSpared(cmd, files)) ||
      (!!cmd.inner && rooted(cmd.inner())) ||
      [...cmd.words, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))].some(
        (word) => !!word.procs && rooted(word.procs),
      ),
  )
}

// The text an xargs reads: its own stdin or pipe (stdinOf), else the pipe into its brace group (braceFed), since every command of the group reads it, so a writing xargs anywhere in one gets its plain twin's verdict; a group's own input redirect stays unread, as stdinOf leaves it (PG-1175)
async function xargsStdin(cmd: Command, env: Env): Promise<Text> {
  const own = cmd.redirects.some((r) => /^0?$/.test(r.fd) && r.op.startsWith("<"))
  return stdinOf(cmd.braceFed && !own && !cmd.stdin ? { ...cmd, stdin: cmd.braceFed } : cmd, env)
}

// Whether an ssh a redirect feeds leaves the line's readers spared: the remote side runs the redirect's text, whose readers print back to ssh rather than into a shell, so only a text the hook cannot read (`sshText`), or one rooted itself, roots the line
function sshSpared(cmd: Command, files: Files | undefined): boolean {
  if (cmd.stdin || !sshCall(parse(cmd))) return false
  const text = sshText(cmd, files)
  return text !== undefined && !rooted(lex(text).commands)
}

// The last redirect onto an ssh's stdin, whose text the remote side reads
const sshInput = (cmd: Command) =>
  cmd.redirects.findLast((r) => (r.fd === "" || r.fd === "0") && r.op.startsWith("<"))
// Whether sshText may read a fed file: only on a line whose other commands cannot write it first (rootLine's alone), from `from` (the tool's folder on a line that moves no folder) for a relative path
type Files = { from?: string }
// The text a redirect hands an ssh on stdin: its last here-string's or heredoc's body, or, when `files` allows, a file named by a literal path, absolute or from its `from`, read when it is a regular file within 1 MiB; undefined for any other
function sshText(cmd: Command, files: Files | undefined): string | undefined {
  const input = sshInput(cmd)
  if (input?.body)
    return input.body.unknown || marked(input.body.value) ? undefined : input.body.value
  const path = input?.op === "<" ? input.target?.value : undefined
  if (!files || !path || marked(path) || input?.target?.glob) return undefined
  if (!path.startsWith(sep) && !files.from) return undefined
  const file = resolve(files.from ?? sep, path)
  try {
    const stat = statSync(file)
    return stat.isFile() && stat.size <= 1_048_576 ? readFileSync(file, "utf8") : undefined
  } catch {
    return undefined
  }
}

// a -C word naming, as one literal absolute path, the folder every place the shell may be in resolves to
const ownFolder = (word: Word | undefined, env: Env) =>
  !!word &&
  literal(word) &&
  word.value.startsWith("/") &&
  env.cwdSure !== undefined &&
  places(env).every(({ cwd }) => cwd === resolve(word.value))
// A git commit the hook reads as text: git as its own program (ownProgram), its sub commit, no shell variable set, no git option ahead of commit that changes what git runs or where (-c, -C, --config-env, --exec-path, --git-dir, --work-tree) but a -C naming the folder the shell is surely in, which moves git nowhere, and every spaced word a quoted message it holds (after -m, a flag cluster ending in m, --message, or --message=), since commit runs no word it is given.
function quietCommit(cmd: Command, parsed: Parsed, env: Env): boolean {
  const { args, local, name } = parsed
  if (name !== "git" || local.size > 0 || !ownProgram(cmd, parsed)) return false
  const { rest, sub } = gitCall(args, env)
  if (sub !== "commit") return false
  const before = args.slice(0, args.length - rest.length - 1)
  if (
    before.some(
      ({ value }, k) =>
        value === "-c" ||
        /^--(?:config-env|exec-path|git-dir|work-tree)/.test(value) ||
        (value === "-C" && !ownFolder(before[k + 1], env)),
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
    return writes || !(narrow(cmd, env) || (!readsOnly && inPlaceScripts(cmd, parsed, env)))
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
  quietRun(cmd, parsed, env) || inPlaceScripts(cmd, parsed, env) !== undefined

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

// Every text of a variable the call sets or exports, and on a line read whole of every word, that holds a space, a leading ! dropped, each read as a command line of its own, and the command string a shell-running call in it is given; `vars` is the scope's variables set since their lines were last read, and `plain` the words a line read whole keeps as text (wholeText).
function runsOf(
  parsed: Parsed,
  vars: Text[],
  whole: boolean,
  rootLine: boolean,
  plain: Set<Word>,
): string[] {
  const { args, first, local } = parsed
  const values = [...local.values(), ...vars].flatMap((text) => {
    tick()
    return text.unknown ? [] : [text.value]
  })
  for (const word of whole ? (first ? [first, ...args] : args) : [])
    for (const piece of plain.has(word) ? [] : texts(word)) {
      values.push(piece.value.replace(/^!/, ""))
      // printf and echo -e print a \n as a line break, which a root shell runs as one
      if (rootLine) values.push(...piece.value.split("\\n"))
      values.push(...shellRunnerArgs(piece.value))
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
  const options: string[] = []
  let ownerId: string | undefined
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k]
    if (word !== undefined && switches.includes(word)) {
      dry ||= word === "--dry-run"
      options.push(word)
    } else if (word?.startsWith("--")) {
      scoped ||= word.startsWith("--scope")
      if (word === "--from-owner-msg") ownerId = rest[k + 1]
      options.push(word)
      k++
    } else positional.push(word)
  }
  // --from-owner-msg <id> as the call's one option, beside the key and value alone, so a CLI from before the flag stops at its missing --reason before it writes
  const ownerMsg =
    options.length === 1 &&
    options[0] === "--from-owner-msg" &&
    !!ownerId &&
    positional.length === 2
  // --propose as the call's one option, beside the key and value alone: ops-wa asks the owner and writes on his yes, and a CLI from before the flag stops at it needing a value (ADR 0041)
  const proposal = options.length === 1 && options[0] === "--propose" && positional.length === 2
  if (command === "settings") {
    if (verb === "import-jobs")
      return dry
        ? undefined
        : `playground settings import-jobs, which writes each listed job's jobs.<name>, ${BY_APPROVE}`
    if (verb !== "set" && verb !== "reset") return
    const key = positional[0]
    if (unread || key === undefined) return `playground settings ${verb} with a word it cannot read`
    // the CLI only asks ops-wa, which proves the owner's own WhatsApp message and writes it itself (ADR 0035)
    if (verb === "set" && ownerMsg) return
    if (verb === "set" && proposal) return
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

// unknown: the line names a variable it reads (HOME, TMPDIR, PWD or one from the starting environment) other than by expanding it, so it is read a second time with those unknown, since the shell's value may not be the environment's
async function inspect(
  raw: string,
  environment: Environment,
  rootNames: () => string[],
  unknown = false,
) {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool,
    turn_id: turn,
  } = JSON.parse(raw) as Record<string, unknown>
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
  // the names in a folder above the root, but the filesystem's own, through which a glob there may reach it: the next folder down to the root and each link there into the root's path, each folder read once
  const reachSeen = new Map<string, string[]>()
  const reachNames = (folder: string): string[] => {
    const at = real(folder)
    const seen = reachSeen.get(at)
    if (seen) return seen
    const names = root.startsWith(at + sep) ? [root.slice(at.length + 1).split(sep)[0]] : []
    try {
      for (const entry of readdirSync(at)) {
        const path = join(at, entry)
        if (lstatSync(path).isSymbolicLink() && (inRoot(path) || above(path, false)))
          names.push(entry)
      }
    } catch {
      // a folder it cannot list adds no link
    }
    reachSeen.set(at, names)
    return names
  }
  const file = typeof tool === "string" ? input[FILE_TOOLS[tool]] : undefined
  if (typeof file === "string") {
    const expanded = /^~(?:\/|$)/.test(file) ? join(home, file.slice(1)) : file
    const path = resolve(directory ?? "", expanded)
    if (inRoot(path)) return refuse(`a write to ${file}`)
    // the text a file tool writes is judged as a shell's text written into a hook file is, and a Codex patch's (codex.ts) (a Write with codex.ts's turn_id) by the lines it adds in any of its files, read apart from its headers and the shell command an apply_patch heredoc stands in
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    const patch =
      typeof turn === "string" &&
      typeof input.content === "string" &&
      input.content.includes("*** Begin Patch")
    const removes = [
      patch
        ? String(input.content)
            .split("\n")
            .filter((line) => line.startsWith("+"))
            .map((line) => line.slice(1))
            .join("\n")
        : input.content,
      input.new_string,
      input.new_source,
      ...edits.map((e) => e?.new_string),
    ]
      .filter((text): text is string => typeof text === "string")
      .map((text) => hookRemover(text, () => hookFile(path)))
      .find(Boolean)
    return removes ? refuse(hookRemoval(file, removes)) : undefined
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
    const key = `${remover}\0${quotedGlob}\0${env.cwd}\0${!!env.remote}\0${!!env.remoteDots}\0${word.value}`
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
        // a glob in the filesystem's own root, where no session adds a name without root, reaches the root only through a name it may match there (mayMatch), so regex or comment text read as a path (`/__[A-Z]+__/`) names none; any other folder above the root fails closed on a glob, since code text (`node -e '…'`, an awk program) reads as one there
        const segment = text.value.slice(text.value.lastIndexOf("/", glob.index) + 1).split("/")[0]
        // on ssh's remote line (`env.remote`), which canary read from the local folder, a glob in a folder above the root reaches the root only through the next folder down to it or a link there (globMatches), so `{{.Names}}` or `[c]laude` names none, while a remover's glob and one a `..` after it climbs back from still reach it; a dot-led name matches only on a line not fully static (`remoteDots`), since visit refuses one holding a glob-option switch first (`remoteSwitch`)
        const climbs = text.value.slice(glob.index).split("/").includes("..")
        const reaches = (folder: string) =>
          inRoot(folder) ||
          (real(folder) === sep
            ? rootNames().some((entry) => mayMatch(segment, entry))
            : !env.remote ||
              remover ||
              climbs ||
              reachNames(folder).some((name) => globMatches(segment, name, !!env.remoteDots)))
        if (folder && (inRoot(folder) || above(folder, true)) && reaches(folder))
          return `${text.value}, a glob in ${folder}`
      }
    }
  }
  // What an in-place sed's or perl's script writes that a shell may run later (sedWrites), or what a printer or another sed or perl writes into a hook file (printed), its quotes dropped, read as written, with each variable it sets filled in, with a substitution that names the home itself read as the home and with a pipeline into an xargs remover read as that remover's command: the root in its text, else a word, a part of a brace list or a word its brace lists expand to (braceWords), under ~, $HOME (any ${HOME…}), ~<login> or / that can name the root, a path in it or a folder between the home and it, or, for a word after a remover in its own command (REMOVERS), the home or any other folder that holds the root (reaches), a relative one holding a / or a glob that can from the cwd, its .. collapsed, or, after a remover, a relative one that names the root, a path in it or a folder between the home and it from the home, or one that holds the root's own parts after a / whose text before it the shell may expand to the home ($, ~ or a backtick in it, follows), so a remover a script runs later, from a folder the hook cannot know, is judged the same from every working folder
  const scriptNames = (text: string, env: Env): string | undefined => {
    const plain = text.replace(/['"]/g, "")
    if (holds(plain, env)) return `${root} in its text`
    // each variable the text sets, by an assignment or a for loop, read as the values it is set to, and then a substitution that names the home itself (HOME_NAMED) as the home word it prints
    const values = new Map<string, string[]>()
    for (const set of plain.matchAll(SETS_NAME)) {
      const name = set[1] ?? set[3]
      values.set(name, [
        ...(values.get(name) ?? []),
        ...(set[1] ? [set[2]] : set[4].split(/\s+/).filter(Boolean)),
      ])
    }
    const filled = plain.replace(
      /\$\{([A-Za-z_]\w*)[^}]*\}|\$([A-Za-z_]\w*)/g,
      (spelled, braced?: string, bare?: string) =>
        values.get(braced ?? bare ?? "")?.join(" ") ?? spelled,
    )
    const homed = filled.replace(/\$\([^()]*\)|`[^`]*`/g, (sub) => {
      const named = HOME_NAMED.exec(sub)
      return named ? (named[1] ?? "~") : sub
    })
    // a pipeline that feeds xargs running a remover reads as that remover's command, the words fed to it after it
    const fed = homed
      .split(/(\|\||[;&\n])/)
      .map((chunk) =>
        /\|\s*\S*xargs\b/.test(chunk) &&
        chunk
          .slice(chunk.search(/\S*xargs\b/))
          .split(/\s+/)
          .some(removerWord)
          ? `rm ${chunk.replace(/\|/g, " ")}`
          : chunk,
      )
      .join("")
    for (const source of new Set([plain, filled, homed, fed])) {
      // whether the words read now follow a remover word in their own command, which a ;, & or line break ends, and a |, ( or backtick inside a token ends where the shell starts another
      let removing = false
      for (const [token] of source.matchAll(/[^\s;&<>=]+|[\s;&<>=]+/g)) {
        if (/^[\s;&<>=]/.test(token)) {
          if (/[;&\n]/.test(token)) removing = false
          continue
        }
        const expanded = braceWords(token)
        if (!expanded) return `${token}, a brace list of more words than the hook reads`
        const parts = token.split(/[|()`]/)
        const removed: boolean =
          removing || parts.some(removerWord) || expanded.some((word) => removerWord(word))
        removing = parts.length > 1 ? removerWord(parts.at(-1)!) : removed
        for (const word of new Set([token, ...token.split(/[{},]/), ...expanded])) {
          const tilde = HOME_WORD.exec(word)
          const login = LOGIN_HOME.exec(word)
          const value = tilde
            ? home + word.slice(tilde[0].length)
            : login
              ? join(dirname(home), login[1]) + word.slice(login[0].length)
              : word
          if (value.startsWith(sep) && reaches(value, removed)) return value
          if (
            !value.startsWith(sep) &&
            ((env.cwd && /[/*?[(]/.test(value) && reaches(resolve(env.cwd, value))) ||
              (removed && reaches(resolve(home, value))))
          )
            return word
          const parts = word.split(sep)
          const expands = (k: number) => parts.slice(0, k).some((part) => /[$~`]/.test(part))
          if (parts.some((_, k) => expands(k) && follows(parts.slice(k), rootParts))) return word
        }
      }
    }
  }
  // the root's parts as a script may spell them: from the home when the root is under it, else from /
  const rootParts = needle.split(sep).filter(Boolean)
  // the home's part count (1 when the root is not under the home), which a folder holding the root must pass, so the home itself and every folder above it are no such folder
  const floor = needle === root ? 1 : real(home).split(sep).length
  // Whether an absolute path or glob can name the root, a path in it or a folder below the floor that holds it, or for a remover any folder that holds it, the home and / included: its folder before the first glob part with links followed, then each later part matching the root's part at its place, a ** or a zsh (…) matching any; for a folder that holds the root a glob part matches a dot name only when it or one of its brace or zsh group alternatives starts with a dot, as the shell's globs do
  const reaches = (path: string, remover = false) => {
    const parts = path.split(sep)
    const at = parts.findIndex((part) => GLOB.test(part))
    const want = root.split(sep)
    const base = real(at < 0 ? path : parts.slice(0, at).join(sep) || sep)
    const have = [...(base === sep ? [""] : base.split(sep)), ...(at < 0 ? [] : parts.slice(at))]
    const spelled = have.at(-1) === "" ? have.slice(0, -1) : have
    // a folder below the floor that holds the root only adds a refusal, so canary's reading stands for every other path
    if (
      spelled.length > (remover ? 1 : floor) &&
      spelled.length < want.length &&
      spelled.every((part, k) => !want[k].startsWith(".") || /(?:^|[{(|,])\./.test(part)) &&
      follows(spelled, want.slice(0, spelled.length))
    )
      return true
    return at < 0 ? inRoot(path) || (remover && above(path, true)) : follows(have, want)
  }
  // whether the hook places a write's path, the whole word, with no folder of the shell's: absolute, under ~, or through a variable the call holds
  const placed = (word: Word, env: Env, steady: Steady) =>
    pathOf(heldWord(word, env, steady) ?? word, { ...env, cwd: undefined }) !== undefined
  const afterUnreadCd = (write: string) =>
    `${write} after a cd to a folder the hook cannot read, which may be ${root}; cd to a literal path first, or name the path absolutely`
  // what in a text a hook file may not take, in any spelling a hook may run it (hookSpellings): a remover (hookRemover), else the root (scriptNames)
  type HookFinding = { named?: string; removes?: string; text: string }
  const hookFinding = (text: string, env: Env): HookFinding | undefined => {
    for (const spelled of hookSpellings(text)) {
      const removes = hookRemover(spelled, () => true)
      if (removes) return { removes, text }
      const named = scriptNames(spelled, env)
      if (named) return { named, text }
    }
  }
  // each line text's finding, by the folder it was judged from
  let lineFindings = new Map<string, HookFinding[]>()
  const seen = new Set<string>()
  let steadyAt: (cmd: Command) => Steady = () => NONE
  // the typed command each run-slot.sh call's own words came from, so a cd or env -C among them holds the steady variables the line set before that call
  const slotOf = new WeakMap<Command, Command>()
  let whole = false
  let rootLine = false
  // the commands whose output an ssh's remote side reads as code, and ssh's own words with its remote line taken out, judged as any program's
  let sshFed = new Set<Command>()
  const sshOwn = new WeakSet<Command>()
  let patterns = new Set<Command>()
  // each compound closer's commands (compoundBodies), and the files an exec with no command has opened on each descriptor for the rest of the line
  let bodies = new WeakMap<Command, Command[]>()
  let execFds = new Map<string, Word[]>()
  let lineWrites = false
  let lineTexts: string[] = []
  let lineWritten: Word[] = []
  // the inline evaluator (bun or node) whose code the walk reads from a folder in or above the root, so a likely false positive in it names the form that runs
  let nearEval: string | undefined
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
    // a glob-option switch on a remote line or in the script a remote shell reads is refused, never read, so a spelling no list names is refused too
    if (env.remote && env.remoteSwitch) return GLOB_SWITCH(env.remoteSwitch)
    // ssh runs each ProxyCommand, LocalCommand and KnownHostsCommand value here, judged as a line typed here, and the words after its host as one command line, on this machine when the host is this machine, so that line is judged as one typed in the login's home, where a remote shell starts, and ssh itself by its own words up to the host, a local redirect included
    // a command ssh's stdin reads as code was typed here, so its text is judged from the remote home too, as its local twin there would be
    if (sshFed.has(cmd) && !env.remote) {
      const fed = cmd.words.map((word) => word.value).join(" ")
      const verdict = await visit(cmd, parsed, remoteEnv(env, "", true, fed))
      if (verdict) return verdict
    }
    const ssh = sshOwn.has(cmd) ? undefined : sshCall(parsed)
    // a here-string or heredoc the remote shell runs as its script, holding a part the hook cannot read (`<<< "$(printf …)"`), is a script it cannot judge
    const fedText = ssh && stdinShell(cmd) ? sshInput(cmd)?.body : undefined
    if (fedText && (fedText.unknown || marked(fedText.value)))
      return refuse(
        "an ssh whose remote shell runs a here-string or heredoc holding a part the hook cannot read; write the script literally",
      )
    // a SetEnv or SendEnv value starts the remote shell with its variable, whatever its line says
    const envSwitch = globSwitch((ssh?.env ?? []).map((w) => w.value).join(" "))
    if (envSwitch) return GLOB_SWITCH(`ssh -o ${envSwitch}`)
    // a SendEnv pattern (`SendEnv=BASH*`) sends whichever of this shell's variables it matches, so it is a name the hook cannot read
    const envUnread = ssh?.env.find((w) => marked(w.value) || /[*?]/.test(w.value))
    if (envUnread)
      return refuse(
        `an ssh -o SetEnv or SendEnv of ${shown(envUnread)}, a value or pattern the hook cannot read, which may start the remote shell with a glob-option switch; name each variable literally`,
      )
    for (const local of ssh?.local ?? []) {
      if (marked(local.value.split(/[=\s]/)[0] ?? ""))
        return refuse(
          `an ssh -o of ${shown(local)}, a value the hook cannot read, which may name a command ssh runs on this machine through a shell; write the option literally`,
        )
      const verdict = await run(
        lex(local.value, env.known),
        { ...env, vars: new Map() },
        visit,
        true,
      )
      if (verdict) return verdict
    }
    if (ssh?.host && ssh.remote.length > 0 && cmd.words.includes(ssh.host)) {
      const line = ssh.remote.map((w) => w.value).join(" ")
      const at = remoteEnv(env, line)
      const own = { ...cmd, words: cmd.words.filter((word) => !ssh.remote.includes(word)) }
      sshOwn.add(own)
      const remote = lex(line, at.known)
      // the remote line reads ssh's stdin, so each remote xargs with no pipe, input or brace group's pipe of its own takes the words piped into ssh, ssh's own here-string or heredoc, or a file ssh reads, its path taken from this folder, as its local twin does, the words read from the login's home; under ssh -n it reads /dev/null's empty text, and a stdin the hook cannot read is refused as its local twin's is (PG-2553)
      const input: Command["redirects"][number] | undefined = ssh.noStdin
        ? { body: { value: "" }, fd: "", op: "<<<" }
        : sshInput(cmd)
      const target = input?.op === "<" ? input.target : undefined
      const path = target && pathOf(target, env)
      for (const each of remote.commands) {
        if (each.stdin || each.braceFed || sshInput(each) || !parse(each).xargs) continue
        if (input?.body) each.redirects = [input, ...each.redirects]
        else if (input && target && path)
          each.redirects = [{ ...input, target: { ...target, value: path } }, ...each.redirects]
        else if (!input && cmd.stdin) each.stdin = cmd.stdin
      }
      return (await visit(own, parse(own), env)) ?? run(remote, at, visit, true)
    }
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
      // a script file a shell runs, or stdin it reads that the hook cannot, after a cd the hook cannot read may write in the shell's folder, as any program off every list may (below)
      if (shellCall && !inline && env.cwdUnread && textDepth === 0) {
        const fed = operand ? undefined : await stdinOf(cmd, env)
        const script = operand
          ? shown(operand)
          : fed && (fed.unknown || marked(fed.value))
            ? "stdin it cannot read"
            : undefined
        if (script)
          return refuse(
            afterUnreadCd(
              `${parsed.name} running ${script}, a script that may write in the shell's folder,`,
            ),
          )
      }
      if (shellCall) return
    }
    const slot = slotWords(parsed)
    if (slot) {
      const inner = { ...cmd, words: slot }
      slotOf.set(inner, slotOf.get(cmd) ?? cmd)
      return slot.length === 0
        ? undefined
        : examine(
            inner,
            // run-slot.sh runs its words in a process of its own, so a cd among them moves no folder for the commands after it
            { ...env, files: new Map(env.files), vars: new Map(env.vars) },
            visit,
            false,
          )
    }
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
    // the text a printer or a sed or perl that edits no file in place writes (printed) into a hook file, by its stdout's redirect or one of a group, subshell or compound around it, a descriptor its stdout is duplicated to or an earlier exec opened included (fdFiles), or as the input of a tee, piped or fed a heredoc or here-string, is refused when it holds a remover or text the hook cannot read (hookRemover), else judged as an in-place edit's script is (scriptNames)
    const kids: Kids = (c) => c.inner?.() ?? bodies.get(c)
    const intoHook = async (targets: Word[], source: Command) => {
      if (targets.length === 0) return
      for (const text of await printed(source, env, kids))
        for (const here of places(env)) {
          // text the hook cannot read counts only for a file it is sure is a hook, since every write of another program's output asks git where its folder's hooks run
          let into: Word | undefined
          const removes = hookRemover(
            text,
            (sure) => !!(into = targets.find((word) => hookFile(pathOf(word, here), sure))),
          )
          if (removes && into) return hookRemoval(shown(into), removes)
          if (text === undefined) continue
          const named = scriptNames(text, here)
          const hook = named && targets.find((word) => hookFile(pathOf(word, here)))
          if (hook) return `${shown(hook)}, a hook file, written with a script that names ${named}`
        }
    }
    const outOf = async (
      c: Command,
      inherited: Map<string, Word[]>,
    ): Promise<string | undefined> => {
      const fds = fdFiles(c.redirects, inherited)
      if (fds.size === 0) return
      const held = kids(c)
      if (!held) return intoHook(fds.get("1") ?? [], c)
      for (const each of held) {
        const named = await outOf(each, fds)
        if (named) return named
      }
    }
    if (cmd.words.length === 1 && cmd.words[0].value === "exec" && !cmd.words[0].quoted)
      execFds = fdFiles(cmd.redirects, execFds)
    const teeTool = program(name)
    const hookWrite =
      (await outOf(cmd, execFds)) ??
      ((GNU_NAMED.exec(teeTool)?.[1] ?? teeTool) === "tee"
        ? await intoHook(
            args.filter((word) => !/^-./.test(word.value)),
            cmd.stdin ?? cmd,
          )
        : undefined)
    if (hookWrite) return refuse(hookWrite)
    // a command that writes, moves or copies into a hook file by a path printed does not follow (any program's stdout by a redirect, tee, dd's of=, the target of cp, install, ln or mv, an in-place sed's or perl's file) takes every text on the typed line (lineTexts) as the hook's text, and the text of each file or stdin a copy reads from (cp, install, ln, mv, dd, a sed's or perl's input) as well, each in every spelling a hook may run (hookSpellings), so text that reaches a hook through another program, a function, a file or a case-changed spelling is judged as printed text is; a command read out of a quoted text (textDepth), which no one typed, writes no hook
    const copier = GNU_NAMED.exec(program(name))?.[1] ?? program(name)
    const copies = ["cp", "dd", "install", "ln", "mv"].includes(copier)
    const into = copies ? writeTargets(copier, args, copier !== program(name) || onLinux()) : []
    const hookEdits = copier === "sed" || copier === "perl" ? inPlace(copier, args) : []
    const hookTargets = [
      ...(fdFiles(cmd.redirects, execFds).get("1") ?? []),
      ...(copier === "tee" ? args.filter((word) => !/^-./.test(word.value)) : []),
      ...into,
      ...hookEdits,
    ]
    // the files a copy reads from: dd's if=, and every operand of cp, install, ln, mv, sed or perl but the files it writes, a sed's or perl's script read as a path that names no file
    const sources =
      copies || copier === "sed" || copier === "perl"
        ? args.flatMap((word) =>
            copier === "dd"
              ? word.value.startsWith("if=")
                ? [after(word, 3)]
                : []
              : !word.value.startsWith("-") && !into.includes(word) && !hookEdits.includes(word)
                ? [word]
                : [],
          )
        : []
    // a symbolic link's relative source names a file from the link's own folder, unless -r reads it from the shell's folder
    const linked =
      copier === "ln" &&
      args.some((word) => /^-[^-]*s/.test(word.value) || word.value === "--symbolic") &&
      !args.some((word) => /^-[^-]*r/.test(word.value) || word.value === "--relative")
    // a copy that reads its stdin: dd with no if=, or a copy of /dev/stdin
    const readsStdin =
      copier === "dd"
        ? sources.length === 0 || sources.some((word) => STDIN_PATH.test(word.value))
        : copies && sources.some((word) => STDIN_PATH.test(word.value))
    // the command's own texts: its heredoc's or here-string's body, and its words past its program, so mv's own name is no remover, but a copy's, whose operands name files and whose text reaches the hook through them alone
    const ownText = cmd.words.map((word) => word.value).join(" ")
    const ownTexts = [
      ...(copies ? [] : [args.map((word) => word.value).join(" ")]),
      ...cmd.redirects.flatMap((r) => (r.body ? [r.body.value] : [])),
    ]
    for (const here of hookTargets.length > 0 && textDepth === 0 ? places(env) : []) {
      // a target that is a hook file, or a hook folder a copy writes its sources into, read only where git answers, since every write on such a line asks git where its folder's hooks run
      const hookAt = () =>
        hookTargets.find((word) => {
          const path = pathOf(word, here)
          return hookFile(path, true) || (copies && !!path && hookFile(join(path, "x"), true))
        })
      // the folder a symbolic link is made in: its target when that is a folder or ends in a slash, else the target's own folder; undefined when the reader cannot settle it
      const linkFolder = () => {
        const target = into.length === 1 ? pathOf(into[0], here) : undefined
        if (!target) return undefined
        return into[0].value.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())
          ? target
          : dirname(target)
      }
      // what a copy reads: each source resolved to one file, whose text is read, and its stdin; any other source reads as text the hook cannot read (a glob, a folder, a value it cannot hold, a piped program's output, a file a redirect or an earlier copy on the line writes before the copy reads it), while a source no file is at and the line writes none of names nothing a copy can take
      const copied: string[] = []
      let unread = false
      for (const typed of sources) {
        if (STDIN_PATH.test(typed.value)) continue
        if (typed.glob) {
          unread = true
          continue
        }
        let word = typed
        if (linked && !/^[/~]/.test(typed.value)) {
          const folder = linkFolder()
          if (!folder || typed.unknown) {
            unread = true
            continue
          }
          word = { ...typed, value: resolve(folder, typed.value) }
        }
        const path = pathOf(word, here)
        const written = !!path && lineWritten.some((each) => pathOf(each, here) === path)
        // a file the line writes holds, when the copy reads it, the text the line gave it (here.files), else text the hook cannot see yet
        if (written && !here.files.has(path)) {
          if (copies) unread = true
          continue
        }
        if (path && !written && !existsSync(path)) continue
        // a word no file can be named by (a script read as a path past the name limit) is no file, so it adds no text
        const read = await readPath(word, here).catch(() => undefined)
        if (read && !read.unknown) copied.push(read.value)
        else if (read && copies) unread = true
      }
      if (readsStdin && (cmd.stdin || cmd.redirects.some((r) => r.op.startsWith("<")))) {
        const input = await stdinOf(cmd, here)
        if (input.unknown) unread = true
        else copied.push(input.value)
      }
      const unreadInto = unread && hookAt()
      if (unreadInto) return refuse(hookRemoval(shown(unreadInto), "text it cannot read"))
      // the line's texts that would make a hook's text refused, judged once a folder the shell may be in, so a line of many writes reads each text once
      const key = here.cwd ?? ""
      if (!lineFindings.has(key))
        lineFindings.set(
          key,
          lineTexts.flatMap((text) => hookFinding(text, here) ?? []),
        )
      // a finding in another command's text on the line names the line as its source and routes to splitting the calls (LINE_TEXT), and one in the command's own text or a file it copies names the hook's text
      for (const { named, removes } of (lineFindings.get(key) ?? []).filter(
        (each) => each.text !== ownText,
      )) {
        const hook = hookAt()
        if (hook)
          return refuse(
            `${shown(hook)}, a hook file, on a line whose other text ${removes ? `holds ${removes}` : `names ${named}`}, ${LINE_TEXT}`,
          )
      }
      for (const [texts, how] of [
        [ownTexts, "written with a text that"],
        [copied, "copied from a file whose text"],
      ] as const)
        for (const { named, removes } of texts.flatMap((text) => hookFinding(text, here) ?? [])) {
          const hook = hookAt()
          if (hook && removes) return refuse(hookRemoval(shown(hook), removes))
          if (hook) return refuse(`${shown(hook)}, a hook file, ${how} names ${named}`)
        }
    }
    // a reader is its command's own first word, so a wrapper's option value parse misread never stands in for one, or grep that xargs starts as its own first word (xargsGrep)
    const reader =
      !rootLine && ((ownFirst(cmd, first) && reads(parsed, env)) || xargsGrep(cmd, parsed, env))
    // on a line read whole with no root shell and no variable set that makes a program run another (TEXT_RUNS), a read-only gh call's jq filter, agent-browser's eval script or wait --fn expression, an awk program holding no ", no | and nothing awkRuns finds, a read-only sed's script, an in-place sed's script whose every other word the hook holds (no substitution, no variable it cannot read) and a playground text flag's value stay text, as on a line read call by call, since no program runs them as a shell line; each is still refused when it names the root, and the awk's and sed's files are judged as any word is
    const browserCode = name === "agent-browser" ? evalProgram(parsed) : undefined
    const edits = SEDS.has(program(name)) ? sedInPlace(cmd, parsed) : undefined
    const editsHeld =
      !!edits &&
      parsed.args.every(
        (word) => edits.has(word) || (!word.procs && held(word, env, steadyAt(cmd))),
      )
    const wholeText = new Set<Word>(
      whole &&
        !rootLine &&
        ownProgram(cmd, parsed) &&
        ![...parsed.local.keys(), ...env.vars.keys()].some(
          (key) => TEXT_RUNS.test(key) || marked(key),
        )
        ? [
            ...ghFilters(parsed),
            ...(browserCode ? [browserCode] : []),
            ...(AWKS.has(program(name)) ? awkTexts(parsed.args) : []),
            ...(SEDS.has(program(name))
              ? (sedReadScripts(parsed.args) ?? (editsHeld ? [...edits] : []))
              : []),
            ...textFlagValues(parsed),
          ]
        : [],
    )
    const xargsOwn = xargs ? xargsOptions(cmd, first) : []
    const delimiter = xargsOwn.some((word) => XARGS_DELIMITER.test(word))
    // GNU xargs' -a reads its words from a file in place of stdin; a word read as -a may be another option's value, so stdin is still judged as xargs' words, and the file adds a word the hook cannot read (argWord)
    const argFile = xargsOwn.some((word) => XARGS_ARG_FILE.test(word))
    const argWord: Word | undefined = argFile ? { quoted: false, value: UNKNOWN } : undefined
    const fed = xargs ? await xargsStdin(cmd, env) : undefined
    // xargs' own words: under -0 or -d its quotes and backslashes stay, else xargsWords reads them
    const fedSplit =
      !fed || fed.unknown
        ? undefined
        : delimiter || xargsOwn.some((word) => XARGS_NUL.test(word))
          ? fed.value.split(/\s+/).filter(Boolean)
          : xargsWords(fed.value)
    const stdinWords: Word[] = [
      ...(!fed
        ? []
        : fedSplit
          ? fedSplit.map((value) => ({ quoted: false, value }))
          : [{ quoted: false, value: UNKNOWN }]),
      ...(argWord ? [argWord] : []),
    ]
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
    const near =
      !away && (name === "bun" || name === "node") && evalProgram(parsed) ? name : nearEval
    const unwrittenRefusal = near ? refuseNearEval(near) : refuseUnwritten
    const masked =
      evaluated && !evaluated.glob && !marked(evaluated.value)
        ? maskRegexes(evaluated.value, (body) => guarded(body, env))
        : undefined
    const shownEval =
      evaluated && masked !== undefined ? { ...evaluated, value: masked } : undefined
    const own = (word: Word): Word => (word === evaluated && shownEval ? shownEval : word)
    const shownText = new Set([...wholeText].map(own))
    // a shell a package runner starts runs its script in the runner's folders too, an unread one included
    const started = STARTED_RUNNERS.has(name)
      ? places(env).flatMap((here) => runnerDirs(name, args, here))
      : []
    const ranIn = started.filter((dir): dir is string => dir !== undefined)
    const textEnv: Env =
      started.length === 0
        ? env
        : {
            ...env,
            cwd: undefined,
            cwdMaybe: [...new Set([...places(env).flatMap(({ cwd }) => cwd ?? []), ...ranIn])],
            cwdSure: undefined,
            cwdUnread: env.cwdUnread || started.length > ranIn.length,
          }
    for (const raw of reader
      ? []
      : [
          ...script,
          ...runsOf({ ...parsed, args: args.map(own) }, vars, whole, rootLine, shownText),
        ]) {
      const line =
        xargs?.replace && fed ? filled(raw, xargs.replace, fed.unknown ? UNKNOWN : fed.value) : raw
      if (seen.has(line)) continue
      seen.add(line)
      textDepth++
      const outer = nearEval
      nearEval = near
      const verdict = await run(
        lex(line, env.known),
        { ...textEnv, vars: new Map() },
        visit,
        true,
      ).finally(() => {
        textDepth--
        nearEval = outer
      })
      if (verdict) return verdict
    }
    // a quiet commit's message is text git never runs, a gated call it names included, and an in-place sed's script is text sed reads as a program of its own
    const quiet = !whole && quietCommit(cmd, parsed, env)
    const sedScripts = whole ? undefined : inPlaceScripts(cmd, parsed, env)
    // a bare assignment or export with no command, or a reader: only its redirect writes, and a variable it sets is read where a command runs with it
    if (!first || EXPORTS.has(name) || reader) return
    // a program word the hook cannot read is named as such, so a refusal always names what runs
    const verb = name && !marked(name) ? name : "a program it cannot read"
    // a GNU build named by its g prefix or reached by its gnubin path reads as the tool it builds, with GNU's options, as every bare build does on Linux, whose builds are GNU's
    const tool = GNU_NAMED.exec(name)?.[1] ?? name
    const gnu = tool !== name || first.value.includes("/gnubin/") || onLinux()
    const remover = REMOVERS.has(tool)
    // an in-place sed's scripts for the root reading (scriptNames): sedInPlace's, the sed half of sedScripts but on a line read whole too, else on a sed spelled off its list (-I, --in-place=, s|||) every word but the files inPlace reads, each read whole by sedWrites
    const edited = new Set(inPlace(tool, args))
    const sedEdit =
      sedInPlace(cmd, parsed) ??
      (tool === "sed" && edited.size > 0 ? args.filter((word) => !edited.has(word)) : [])
    // what those scripts write, and an in-place perl edit's replacements (perlInPlace, else on a perl spelled off its grammar, such as s|||, every word but the files inPlace reads, read whole), each read as sed or perl writes it (sedWrites)
    const perlEdit = [
      ...(perlInPlace(cmd, parsed, env) ??
        (tool === "perl" && edited.size > 0 ? args.filter((word) => !edited.has(word)) : [])),
    ]
    const written = [
      ...[...sedEdit].flatMap((script) => sedWrites(script.value)),
      ...perlEdit.flatMap((script) => sedWrites(script.value, PERL_STEP, perlText)),
    ]
    // a sed's script from a file (-f after any of GNU's and macOS's no-value flags, -l counted as one so GNU's -l value fails closed, or --file by any prefix getopt_long reads) and its in-place edit by any spelling (-i, or a prefix of --in-place), which inPlace reads by their full names alone
    const sedLong = (word: Word) => longOf(word.value.split("=")[0], SED_LONG)
    const sedFile =
      tool === "sed" && args.some((w) => /^-[Eablnrsuz]*f/.test(w.value) || sedLong(w) === "--file")
    const sedEditFlag =
      tool === "sed" &&
      args.some((w) => /^-[Eablnrsuz]*i/.test(w.value) || sedLong(w) === "--in-place")
    // the files an in-place edit edits (inPlace), else for such a sed every operand, since none of them is its script
    const editedFiles =
      edited.size > 0
        ? [...edited]
        : sedFile && sedEditFlag
          ? args.filter((w) => !w.value.startsWith("-"))
          : []
    // what makes an in-place edit's text one a hook file may not hold: a script it cannot read (a word built from a variable or a substitution, sed's script file, a perl given no -e, whose first operand is its script), else a remover in what it writes (hookRemover)
    const unreadScript =
      editedFiles.length > 0 &&
      (args.some((word) => !edited.has(word) && marked(word.value)) ||
        sedFile ||
        (tool === "perl" && !perlInline(args)))
    // what any other sed or perl call writes, judged for the root as its literal twin is (escapedWrites)
    const escaped = [...sedEdit, ...perlEdit].length > 0 ? [] : escapedWrites(parsed, env)
    // POSIXLY_CORRECT set in the call, by a prefix or on its line, makes a GNU build stop its options at the first operand
    const posix = gnu && (parsed.local.has("POSIXLY_CORRECT") || env.vars.has("POSIXLY_CORRECT"))
    // on Linux POSIXLY_CORRECT can reach a bare build by a route the hook does not carry (a shell's -c, eval, a function, a sourced file), so gnuReadings judges its words both permuted and stopped at the first operand
    const readings = gnuReadings(posix)
    const writes = (typed: Word[]) =>
      readings.flatMap((stops) => writeTargets(tool, typed, gnu, stops))
    // a line that names more folders than the reader carries (`Env.cwdAnywhere` in shell.ts) may run inside this root, whatever folder it started in
    if (env.cwdAnywhere)
      return refuse(
        `${verb} on a line that names more folders than the hook carries, since it cannot rule out ${root}; run it as a line of its own after a cd to a literal path`,
      )
    const steady = steadyAt(cmd)
    // a read-only gh call's jq filter is text, never a path, and on a line read whole so is each word wholeText keeps as text
    const filters = whole ? shownText : ghFilters(parsed)
    // each folder the shell may be in, so a program a cd the reader cannot be sure of would run inside the root, or a path of its own that lands there, is judged in every one
    for (const here of places(env)) {
      if (inRoot(here.cwd)) return refuse(`${verb} run inside ${root}`)
      if (name === "git" && inRoot(gitCall(args, here).cwd))
        return refuse(`git on a clone in ${root}`)
      // a value the hook cannot read under a remover, as a writer's target, as a file an in-place sed or perl edit edits, or in git's -c, could name the root, so it is refused unless the call holds it
      const unheld = (remover ? args : WRITERS.has(tool) ? writes(args) : inPlace(tool, args)).find(
        (word) => !held(word, here, steady),
      )
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
      let hook: Word | undefined
      const isHook = () => !!(hook = editedFiles.find((file) => hookFile(pathOf(file, here))))
      const hookText =
        editedFiles.length === 0
          ? undefined
          : unreadScript
            ? isHook() && "a script it cannot read"
            : written.map((text) => hookRemover(text, isHook)).find(Boolean)
      if (hookText && hook) return refuse(hookRemoval(shown(hook), hookText))
      for (const text of written) {
        const named = scriptNames(text, here)
        if (named) return refuse(`${verb} with a script that names ${named}`)
      }
      if (escaped.some((text) => holds(text, here)))
        return refuse(`${verb} with a script that names ${root} in its text`)
      const literal = !whole && narrow(cmd, here)
      for (const [at, word] of [first, ...args]
        .map((word) => heldWord(own(word), here, steady) ?? own(word))
        .entries()) {
        // a `.` in the program word is the shell's source builtin, never the folder it spells, so `. /etc/os-release` from the home names its operand alone
        if (at === 0 && first?.value === "." && word.value === ".") continue
        // a quiet commit's message, an in-place sed's or perl's script, a gh filter and a browser eval's script on a line read whole are text, judged only when the root is in it; a filter's unquoted glob is the shell's, judged as any glob
        const text =
          (quiet && /\s/.test(word.value)) ||
          !!sedScripts?.has(word) ||
          (filters.has(word) && !word.glob)
        if (text && !texts(word).some((t) => holds(t.value, here))) continue
        const named = names(word, here, remover, literal)
        if (named)
          return (unwritten(named, cmd, here) ? unwrittenRefusal : refuse)(`${verb} on ${named}`)
      }
      // tee copies its heredoc to the targets the loop above judged, so the body is data, unless the line feeds code
      if (
        !(name === "tee" && !rootLine) &&
        cmd.redirects.some((r) => r.body && holds(r.body.value, here))
      )
        return refuse(`${verb} with a script that names ${root}`)
      // a remover, or a writer the line typed that reads stdin (no -a), fed stdin the hook cannot read may write under the root; a writer read out of a quoted text (a sed script's replacement, textDepth) is judged by the words it can read, since that text is most often data (PG-2553)
      const unreadFeed =
        fed && (remover || (WRITERS.has(tool) && textDepth === 0 && !argFile))
          ? argFile
            ? "the file its -a names"
            : fed.unknown || marked(fed.value) || !fedSplit
              ? (fed.unknown ??
                (fedSplit ? "a value it cannot read" : "stdin holding a quote it does not close"))
              : undefined
          : undefined
      if (unreadFeed)
        return refuse(
          `${verb} under xargs fed by ${unreadFeed}, a value the hook does not hold; write the paths literally in the call`,
        )
      if (fed) {
        // each word as written and as xargs reads it, so a quote or backslash xargs drops hides no root path
        const named =
          !fed.unknown &&
          [...fed.value.split(/\s+/), ...(fedSplit ?? [])]
            .filter(Boolean)
            .map((value) => names({ quoted: false, value }, here, remover))
            .find(Boolean)
        if (named) return refuse(`${verb} under xargs on ${named}`)
      }
    }
    // after a cd the hook cannot read, a remover's operand or a writer's target the hook can place only by the shell's own folder may be in the root
    if (!env.cwdUnread) return
    // a typed program off every list may write in the shell's folder, and git but a read, git rm or a call that an absolute -C places (gitPlaced) may write its clone there; a command read out of a quoted text is judged by the lists alone, since its words are most often no program
    const git = tool === "git" ? gitCall(args, { ...env, cwd: undefined }) : undefined
    if (
      textDepth === 0 &&
      !remover &&
      !WRITERS.has(tool) &&
      !NO_WRITES.has(tool) &&
      !portlessRead(tool, args) &&
      !reads(parsed, env) &&
      !scriptRead(tool, parsed, env) &&
      (git ? git.sub !== "rm" && gitPlaced(args, env) === undefined : !UNREAD_CD_JUDGED.has(tool))
    )
      return refuse(
        afterUnreadCd(
          `${git ? `git ${git.sub && !marked(git.sub) ? git.sub : "with a subcommand it cannot read"}, which may write in the shell's folder (an absolute git -C places it),` : `${verb}, which may write in the shell's folder,`}`,
        ),
      )
    // stdin xargs splits where the hook cannot see (a NUL, a part it cannot read, GNU's -d delimiter, a quote left open) is read as one value it cannot read
    const unsplit = fed && !fed.unknown && (marked(fed.value) || delimiter || !fedSplit)
    const fedWords: Word[] = unsplit
      ? [{ quoted: false, value: UNKNOWN }, ...(argWord ? [argWord] : [])]
      : stdinWords
    const replace = xargs?.replace
    const fromStdin = new Set<Word>(fedWords)
    const fromArgFile = new Set<Word>(argWord ? [argWord] : [])
    // xargs puts each stdin word in place of its -I or -J string
    const putIn = (word: Word) =>
      args.map((arg) => {
        if (!replace || !arg.value.includes(replace)) return arg
        const put = { ...arg, value: arg.value.replaceAll(replace, word.value) }
        fromStdin.add(put)
        if (fromArgFile.has(word)) fromArgFile.add(put)
        return put
      })
    // the call as typed, then each call xargs may build: its stdin words appended to one call or split over several (-n, -L, -s, its own size cap), so each word may end a call of its own, or put in place of its -I or -J string
    const shapes = [
      args,
      ...(!xargs
        ? []
        : replace
          ? fedWords.map(putIn)
          : [[...args, ...fedWords], ...fedWords.map((word) => [...args, word])]),
    ]
    // a dash with more after it is an option, while a lone dash is an operand
    const option = (word: Word) => /^-./.test(word.value)
    const operandsOf = (typed: Word[]) => {
      // find with no path before its expression searches the shell's own folder; GNU's -D takes the next word, while GNU's -H, -L, -P and -O<n> and BSD's -E, -X, -d, -s and -x, alone or clustered, take none, and BSD's -f names a path
      const lead = typed.findIndex(
        (word, i) => !/^-(?:[EHLPXdsx]+|O\d*|D)$/.test(word.value) && typed[i - 1]?.value !== "-D",
      )
      const given =
        tool === "find" &&
        (lead === -1 || (/^[-(!]/.test(typed[lead].value) && typed[lead].value !== "-f"))
          ? [{ quoted: false, value: "." }, ...typed]
          : typed
      const end = given.findIndex((word) => word.value === "--")
      // macOS unlink reads no option but a leading --
      const stop =
        !GETOPT_REMOVERS.has(tool) || (gnu && !readings.includes(true))
          ? -1
          : tool === "unlink" && !gnu
            ? Number(given[0]?.value === "--")
            : given.findIndex((word) => !option(word))
      // mv's -t folder, rsync's path values and the file find's write actions name are written to, though their word opens with a dash
      const values =
        tool === "mv"
          ? writes(given)
          : tool === "rsync"
            ? given.flatMap((word, k) => {
                const long = /^--([^=]+)=?/.exec(word.value)
                const path =
                  long &&
                  !RSYNC_FLAGS.has(long[1]) &&
                  RSYNC_PATHS.some((name) => name.startsWith(long[1]))
                const cut = path ? long[0].length : RSYNC_TEMP.exec(word.value)?.[0].length
                if (!cut) return []
                // with no value attached, the option takes the next word, a dash-led one too
                if (cut < word.value.length) return [after(word, cut)]
                return given[k + 1] ? [given[k + 1]] : []
              })
            : tool === "find"
              ? given.flatMap((word, k) =>
                  FIND_WRITES.test(word.value) && given[k + 1] ? [given[k + 1]] : [],
                )
              : []
      return remover
        ? [
            ...given.filter(
              (word, k) => (end !== -1 && k > end) || (stop !== -1 && k >= stop) || !option(word),
            ),
            ...values,
          ]
        : WRITERS.has(tool)
          ? writes(given)
          : []
    }
    // a program on neither list is judged in every call xargs may build too (unreadCdWrites), so a file an in-place edit takes from stdin counts
    const unlisted =
      !remover && !WRITERS.has(tool)
        ? shapes.flatMap((typed) =>
            gnuReadings(!gnu || posix).flatMap((stops) => unreadCdWrites(tool, typed, env, stops)),
          )
        : []
    const loose = [...shapes.flatMap(operandsOf), ...unlisted].find(
      (word) => !placed(word, env, steady),
    )
    if (!loose) return
    const unread = fromArgFile.has(loose)
      ? "the file its -a names"
      : fed && fromStdin.has(loose) && (fed.unknown || unsplit)
        ? (fed.unknown ??
          (delimiter
            ? "stdin split on its -d delimiter"
            : fedSplit
              ? "stdin holding a part it cannot read"
              : "stdin holding a quote it does not close"))
        : undefined
    return refuse(
      afterUnreadCd(
        unread
          ? `${verb} under xargs on the words it reads from ${unread}`
          : `${verb} on ${shown(loose)}`,
      ),
    )
  }
  const named = namings(command)
  const own = knownVariables(command, environment, directory)
  const known = { ...own, ...startingVariables(command, environment, own) }
  const steered = Object.keys(known).filter((key) => named.counts.has(key))
  if (unknown) for (const key of steered) delete known[key]
  const lexed = lex(command, known)
  if (!loneCall(lexed.commands)) tuning = NO_TUNING
  // a writer's file a cd's && chain sets to a literal is held past the chain too, never a folder, since a failed cd leaves it empty and a cd to it then stays put
  steadyAt = steadyNames(named, lexed.commands, true)
  const env: Env = {
    cwd: directory,
    // the line starts in the folder the tool names, which the reader has proved by the payload itself
    cwdSure: directory,
    files: new Map(),
    // a cd or env -C through a steady variable holding a literal absolute path is read by that path (landsHeld in shell.ts)
    hold: (word, cmd, here) =>
      heldWord(word, here, { ...steadyAt(slotOf.get(cmd) ?? cmd), past: undefined }),
    known,
    // zsh starts with OLDPWD at the folder it starts in
    old: { dir: directory },
    process: environment,
    vars: new Map(),
    visitShells: true,
  }
  // a line with a root shell is read whole with no reader spared, an awk program's strings its lines, since what a reader prints into the shell runs
  // a file fed to ssh is read only when every command before the ssh, and every one its pipe feeds (`| head -80`), is a reader with no redirect but a descriptor's copy, and every other runs after it and feeds no shell (`; ssh box grep …`), since any other could write the file before ssh reads it
  const shellAt = lexed.commands.findIndex((cmd) => !!stdinShell(cmd))
  const fed = lexed.commands[shellAt]
  const plain = (cmd: Command) =>
    !cmd.inner &&
    ![...cmd.words, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))].some(
      (word) => word.procs,
    )
  const fedBy = (cmd: Command) => {
    for (let from = cmd.stdin; from; from = from.stdin) if (from === fed) return true
    return false
  }
  const reader = (cmd: Command) =>
    plain(cmd) &&
    PIPE_READERS.has(program(parse(cmd).name)) &&
    cmd.redirects.every((r) => r.op === ">&" && /^\d$/.test(r.target?.value ?? ""))
  const feedUnwritten =
    !!fed &&
    plain(fed) &&
    lexed.commands.every(
      (cmd, k) =>
        k === shellAt ||
        (k < shellAt || fedBy(cmd)
          ? reader(cmd)
          : plain(cmd) && !stdinShell(cmd) && cmd.follows !== "&"),
    )
  rootLine = rooted(
    lexed.commands,
    feedUnwritten
      ? { from: /\b(?:cd|popd|pushd)\b/.test(command) ? undefined : directory }
      : undefined,
  )
  sshFed = new Set(
    [...codeFed(lexed.commands)]
      .filter(([, { consumer }]) => !!sshCall(parse(consumer)))
      .map(([producer]) => producer),
  )
  if (evaluatedParts(command).some((part) => touches(part, env))) return refuse(EVALUATES_ROOT)
  whole = rootLine || wholeLine(lexed.commands, env)
  patterns = casePatterns(lexed.commands)
  bodies = compoundBodies(lexed.commands)
  execFds = new Map()
  lineWrites = redirectsWrite(lexed.commands)
  lineTexts = lineTextsOf(lexed.commands)
  lineWritten = writtenWords(lexed.commands)
  lineFindings = new Map()
  // a line holding an ext score is refused whole once any command on it changes who the session reads as, so a shell it runs or pipes into carries the change
  if (SCORE.test(unquoted(command)) && changesIdentity(lexed.commands))
    return refuse(SCORE_AS_OTHER)
  const verdict = await run(lexed, env, visit, true)
  if (verdict || unknown || steered.length === 0) return verdict
  return inspect(raw, environment, rootNames, true)
}

// Fails open: an error on any call lets it run, so a reader bug cannot block every Bash command or write; a RangeError, a stack overflow or the walk past its time, refuses.
// rootNames lists the filesystem's root, which a test fixes so a verdict never depends on what a machine's / holds
export async function check(
  raw: string,
  environment: Environment = process.env,
  budget = 10_000,
  rootNames: () => string[] = () => readdirSync(sep),
): Promise<string | undefined> {
  try {
    return await withDeadline(budget, async () =>
      eachInput(raw, "no-extensions-write", (one) => inspect(one, environment, rootNames)),
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
  const raw = await input("no-extensions-write", "guard")
  const reason = (await fromFactory(raw)) ? await guarded(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
