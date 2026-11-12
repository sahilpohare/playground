// The Bash reader the PreToolUse hooks share: it lexes a command and walks it as the shell would run it, reading the heredocs, files and substitutions it can see and marking the rest unknown.
import { AsyncLocalStorage } from "node:async_hooks"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, resolve } from "node:path"

// `variable` names the first shell variable a text expands, so a hook can tell `"$HERDR_BIN_PATH"` from any other unknown program.
// `splits` marks a text holding a value the lexer cannot read that may expand to several words: any unquoted expansion, since a line may set an option or make an array the hook cannot see, and a quoted one in no form every shell keeps as one word (`QUOTED_ONE_WORD`).
// `tilde` marks a word that opens with an unquoted ~- or ~+, which zsh expands to the folder it last left or the one it is in.
export type Text = {
  reads?: Text[]
  splits?: boolean
  tilde?: boolean
  unknown?: string
  value: string
  variable?: string
}
// `glob` marks a word with a glob character the shell sees outside quotes, so `'{print $1}'` holds none and `{a,'b'}` one.
// `raw` keeps the source of a word that holds a value the lexer cannot read, so a hook can lex it again once the call has set its variables.
// `source` is the word as written, quotes and expansions included, so a hook can judge what a word expands rather than what it came to.
export type Word = Text & {
  glob?: boolean
  procs?: Command[]
  quoted: boolean
  raw?: string
  source?: string
}
// `bodyFed` is the compound command's input redirect this one is run()'s copy of, on a command in its body, which stdinOf passes over
type Redirect = { body?: Text; bodyFed?: Redirect; fd: string; op: string; target?: Word }
export type Command = {
  // Set on a while's or an until's condition outside every other loop, and on the script an eval or a source there reads, which the shell runs at least once: a cd there leaves the folder before it behind, as a sure cd does, while `repeated` reads each later pass
  atLeastOnce?: boolean
  // Set on the bare copy run() hands a hook's visit for a followed command with a redirect: the command it stands for
  bareOf?: Command
  // The token of the run of commands this one belongs to: it changes at each operator that runs a command whatever the one before it did (a `;`, a newline, an `&`, an `||`), and carries into every group, body and pipeline the run reaches, so a cd is read as having moved the shell only for the commands whose token is its own
  chain?: number
  // Set when the command runs only if the one before it succeeded (it sits on the right of an `&&`), so a cd of its own has certainly run for every command the same chain joins after it
  chained?: boolean
  detached?: boolean
  // Set when the command's output feeds a shell that reads its script from stdin, so the walk visits it even with no program of its own (a loop's `done`), and a hook judges the pipe there
  feedsShell?: boolean
  // the operator that ended the command before it in its scope (`;`, `&&`, `||`, `|`, `&`, `)` or `;;`), none for a scope's first
  follows?: string
  group?: boolean
  // Set on the command that opens a body the shell keeps for a later call (a function's, a brace group's, a coproc's), so a cd there may move the shell at any point of the line; a later command of the body is read where it stands
  held?: boolean
  inner?: () => Command[]
  // Set on every command of a body the shell may keep for a later call (`held`'s, up to its close), so a word's ~- there may expand at that call, wherever the shell has moved by then
  kept?: boolean
  // Set on a zsh head whose body is a brace group in its own words (`repeat 3 { cd ..; }`, `while true { … }`, `if true { … }`), which the reader does not read, so the shell reads as able to be in any folder after it (`Env.cwdAnywhere`)
  opaque?: boolean
  // Set on each command of a run an `||` opened, those in a group or a substitution it holds included, so `orElse` finds what a cd's `||` runs whichever command of that run the walk reaches first
  orRun?: boolean
  redirects: Redirect[]
  // Set when a count or a loop may run the command more than once, so a relative cd of its own may climb or descend any number of folders
  repeated?: boolean
  // Set when the command's piped input may run as shell code (codeFed), so the walk judges that input as a script the command runs
  runsStdin?: boolean
  scope: number
  stdin?: Command
  unsure?: boolean
  words: Word[]
}
type Lexer = {
  commands: Command[]
  i: number
  known: Record<string, string>
  scope: number
  scopes: number[]
  // Whether an `||` opened the run the walk is in
  orRun?: boolean
  src: string
  // The run of commands the walk is in, carried into every group and substitution it enters, so one reached through a chain keeps that chain's token
  token: number
}
type Lexed = { commands: Command[]; scopes: number[] }
type Pending = { delim: string; quoted: boolean; redirect: Redirect; strip: boolean }
// `old` is set by a hook that follows zsh's ~-, `old.dir` the folder the shell last left (unset when the hook cannot tell), which an assignment to OLDPWD leaves as it is, so a cd's or pushd's ~- or ~+, and a word opening with either, reads a folder there; a hook that leaves it unset reads both as typed.
export type Env = {
  // The folder a cd names where the reader can read it, taken as the shell's own: the reading every hook had before the proven folder arrived, kept so a hook that reads this field alone keeps its verdicts. A hook reads the proven folder, and every folder the shell may be in, through `places` instead.
  cwd?: string
  // Set once the line names more folders than the reader carries, so the shell may be in any folder, the one a hook guards included: a hook refuses the command it guards outright, since `places` can enumerate no such set
  cwdAnywhere?: boolean
  // Every folder a cd on the line has named, which `cd -`, `popd` and a bare `pushd` go back to
  cwdBack?: string[]
  // The folders the shell was in before a cd an `&&` alone made sure, which become the shell's again at the first command outside that cd's own run, since such a command runs whether or not the cd did
  cwdChain?: string[]
  // The `Command.chain` token of that cd, so only a command of its own run keeps the folder it named
  cwdChainToken?: number
  // The folders the cd that opens a body on the line may reach, which no later cd clears, since the shell may run that body at any point of the line
  cwdHeld?: string[]
  // The folders a cd the reader could not be sure of may have left the shell in, beside `cwdSure`; `cwdSure` is unnamed whenever one of them is the shell's instead
  cwdMaybe?: string[]
  // A sure cd whose run an `||` may follow (`orElse`): the folders the shell was in before it, its run's token, and whether a later command joined that run; once the `||`'s command arrives, that command's token, where the shell was, and whether the commands after it return there
  cwdOr?: CdOr
  // The folder the reader proved the shell is in: a cd it is sure the shell runs once, into one folder it reads. Unnamed wherever the reader cannot prove one, which is what `places` enumerates instead.
  cwdSure?: string
  // Set once a cd's landing folder cannot be named at all (`cd "$X"`, a popd, zsh's two-operand cd), so each hook reads it by its own fail-closed rule, through `places`'s fallback
  cwdUnread?: boolean
  files: Map<string, Text>
  // Set by a hook that holds the line's steady variables (`steady.ts`): a cd's folder word with those it reads put in, else undefined, so a cd through one is read by the folder it names
  hold?: (word: Word, cmd: Command, env: Env) => Word | undefined
  known: Record<string, string>
  old?: { dir?: string }
  // In a hook that follows ~-, each folder the shell may have left at its last cd, which a word's ~- names; `pathOf` reads ~- only when this holds one folder, and before any cd it is `old.dir` alone
  oldFrom?: string[]
  process: Record<string, string | undefined>
  vars: Map<string, Text>
  // Set by a hook that judges a shell the line starts as a program too, so its visit sees the shell's own words and assignments before the walk follows its script; a script file the walk cannot read is otherwise followed as an empty one
  visitShells?: boolean
}
export type Flag = { name: string; value?: Word }
export type Field = { key: string; text: Text }
export type ApiRequest = { endpoint: Word; fields: Field[]; inputs: Text[]; method: string }

// Marks the part of a word the shell fills in at run time, which the hook cannot know.
export const UNKNOWN = "\u0000"
// Marks where a `$(cat file)` puts a file's text; Text.reads lists those files in order.
export const READ = "\u0001"
// A refusal stops the whole Bash call, so a reason for a value the hook cannot read ends with this.
export const NOT_RUN =
  "The refusal stopped this whole Bash call, so none of its commands ran: once it is fixed, run again each one you still need."
const MAX_BYTES = 1_048_576
const MAX_SCRIPT = 131_072
const LARGE = "a text too large to read"

// The performance.now() past which every lex, expansion and walk step throws a RangeError, set by a hook that must answer inside its timeout; each withDeadline call holds its own in its async context, so overlapping checks in one process never share one.
const deadlines = new AsyncLocalStorage<number>()

// Runs body with a deadline budget ms away, so any slow route through the lexer or the walk refuses, whatever made it slow.
export async function withDeadline<T>(budget: number, body: () => Promise<T>): Promise<T> {
  return await deadlines.run(performance.now() + budget, body)
}

// Throws once the walk is past its deadline, for a visit whose spawns take time no tick sees.
export function pastDeadline(): void {
  const deadline = deadlines.getStore()
  if (deadline !== undefined && performance.now() > deadline)
    throw new RangeError("past the hook's time")
}

let steps = 0

// The steps tick() has counted so far, so a test bounds a reader's work by a count that holds under any load.
export const stepsTaken = (): number => steps

// The one choke point every lex, expansion and walk step passes through; it counts each step and reads the clock once every 1024 under a deadline, so a tight loop pays for a counter alone.
export function tick(): void {
  if (++steps % 1024 === 0) pastDeadline()
}

// A script a shell, eval or source reads, held under a deadline to the size of a command the hook reads.
function lexScript(value: string, env: Env): Lexed {
  if (deadlines.getStore() !== undefined && value.length > MAX_SCRIPT)
    throw new RangeError("a script too large to read")
  return lex(value, env.known)
}

// A script with xargs' -I string filled in from stdin, refused before it is built when it would outgrow a script the hook reads.
export function filled(script: string, mark: string, value: string): string {
  const count = script.split(mark).length - 1
  if (deadlines.getStore() !== undefined && script.length + count * value.length > MAX_SCRIPT)
    throw new RangeError("a script too large to read")
  return script.replaceAll(mark, value)
}

// A text a command writes or reads from stdin, unknown past the size of a file the hook reads, so a text that doubles stops growing.
const held = (text: Text): Text => (text.value.length > MAX_BYTES ? unknown(LARGE) : text)

const BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"])
const REDIRECT = /^(\d*|&)(<<<|<<-|<<|<>|<&|>&!?|>>[!|]?|>[!|]|<|>)/
const RESERVED = new Set([
  "!",
  "{",
  "}",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "if",
  "then",
  "until",
  "while",
])
// The reserved words that open a body the shell may run no time or many (a conditional, a loop, a case, a function, a brace group), and those that close one; `function` opens none of its own, since its body's `{` opens it
const OPENS = new Set(["case", "coproc", "for", "if", "select", "until", "while", "{"])
const CLOSES = new Set(["done", "esac", "fi", "}"])
// The openers whose own command the shell may not run as typed: a brace group's, which a function keeps for a later call, and a coproc's, which runs in a subshell. An `if`, `while` or `until` runs its condition, and a `for` or `case` opener runs no command of its own.
const HELD = new Set(["coproc", "function", "{"])
// The operators that run the next command whatever the one before it did, so the run of commands a `cd` moved the shell for ends there; `&&` carries the run on, and `|` keeps a pipeline inside it.
const FREES = new Set(["\n", ";", ";;", "&", "||"])
// Tokens are handed out across every script the hook reads, so a script's own run never shares one with the line that read it.
let tokens = 0
const freshToken = () => ++tokens
// The reserved words a body's own commands carry, which the shell may not run
const BODIES = new Set(["do", "elif", "else", "then"])
// Every reserved word the walk counts, each read in command position alone: `grep -q done` names a pattern, not a loop's end
const MARKERS = new Set([...RESERVED, ...OPENS, ...CLOSES, ...BODIES])

// The reserved words a command carries in command position, in order: those before the program it runs, the program's own word when it is one too (`fi`, `done`), and `function f {`'s own, since a function's name follows it.
function markers(words: Word[]): string[] {
  const out: string[] = []
  for (let k = 0; k < words.length;) {
    const w = words[k]
    if (w.quoted) break
    if (w.value === "function") {
      out.push("function")
      k += 2
    } else if (MARKERS.has(w.value)) {
      out.push(w.value)
      k++
    } else if (ASSIGN.test(w.value)) k++
    else break
  }
  return out
}
// Whether a program is its command's own first word, a reserved word before it (`!`, `then`, `do`) skipped, rather than one a wrapper or an assignment runs
export const ownFirst = (cmd: Command, first: Word | undefined): first is Word =>
  !!first && first === cmd.words.find((w) => w.quoted || !RESERVED.has(w.value))
// Whether every word of a command is an unquoted reserved word (`fi`, `done`), so it names no program of its own
export const onlyReserved = (cmd: Command): boolean =>
  cmd.words.length > 0 && cmd.words.every((w) => !w.quoted && RESERVED.has(w.value))
// The words that close a compound command, whose output the hook does not follow.
const GROUPING = new Set(["}", "done", "esac", "fi"])
export const ASSIGN = /^[A-Za-z_]\w*=/
// Each wrapper's options, A to Z: its flags, then the options that take a value, short and long; parse reads a cluster (`-Hp`) letter by letter and a value attached (`-pwc`, `--prompt=wc`) or as the next word, and reads an option missing here both as a flag and as taking the next word, so a hook judges the program under each
type Options = { flags: Set<string>; values: Set<string> }
// run-slot.sh's CHAIN_WRAPPER_OPTIONS mirrors these lists, which a test holds equal, so its chain reader reads past the same options
export const WRAPPERS = new Map<string, Options>(
  Object.entries({
    builtin: ["", ""],
    busybox: ["", ""],
    caffeinate: ["-d -i -m -s -u", "-t -w"],
    command: ["-p -V -v", ""],
    doas: ["-L -n -s", "-a -C -u"],
    env: ["-0 -i -v --debug --ignore-environment --null", "-P -S -u --unset"],
    exec: ["-c -l", "-a"],
    nice: ["", "-n --adjustment"],
    nocorrect: ["", ""],
    noglob: ["", ""],
    nohup: ["", ""],
    pkexec: ["--disable-internal-agent --help --keep-cwd --version", "--user"],
    repeat: ["", ""],
    stdbuf: ["", "-e -i -o --error --input --output"],
    sudo: [
      "-A -B -b -E -e -H -i -K -k -l -N -n -P -S -s -V -v --askpass --background --bell --edit --help --list --login --non-interactive --preserve-env --preserve-groups --remove-timestamp --reset-timestamp --set-home --shell --stdin --validate --version",
      "-C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user",
    ],
    time: [
      "-a -h -l -p -q -V -v --append --portability --quiet --verbose",
      "-f -o --format --output",
    ],
    timeout: ["-f -p -v --foreground --preserve-status --verbose", "-k -s --kill-after --signal"],
    xargs: [
      "-0 -o -p -r -t -x --exit --interactive --no-run-if-empty --null --open-tty --show-limits --verbose",
      "-a -d -E -L -n -P -R -S -s --arg-file --delimiter --max-args --max-chars --max-lines --max-procs --process-slot-var",
    ],
  }).map(([name, [flags, values]]) => [
    name,
    { flags: new Set(flags.split(" ")), values: new Set(values.split(" ")) },
  ]),
)

// Where a wrapper's option word leaves its value: "own" when it takes none or carries it, "next" when the next word is its value, or undefined for an option the wrapper's list lacks
function optionValue(word: string, { flags, values }: Options): "next" | "own" | undefined {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=")
    const name = eq === -1 ? word : word.slice(0, eq)
    if (values.has(name)) return eq === -1 ? "next" : "own"
    return flags.has(name) ? "own" : undefined
  }
  for (let k = 1; k < word.length; k++) {
    const option = `-${word[k]}`
    if (values.has(option)) return k === word.length - 1 ? "next" : "own"
    if (!flags.has(option)) return undefined
  }
  return "own"
}

// The privilege wrappers' options that start a root shell, which reads its script from stdin when no command follows them: a closed list, which startsRootShell reads; pkexec takes none, since one with no program starts the root shell itself (BARE_ROOT)
const ROOT_SHELLS = new Map([
  ["doas", new Set(["-s"])],
  ["pkexec", new Set<string>()],
  ["sudo", new Set(["--login", "--shell", "-i", "-s"])],
])
// The privilege wrappers that start a root shell when no program follows them (pkexec(1): "If no program is specified, the default shell will be run"); a bare `pkexec --help` or `pkexec --version` reads as one too, a refusal kept on purpose so no text canary refused as its program's stdin is newly let run
const BARE_ROOT = new Set(["pkexec"])
// Whether a command starts a shell that reads its script from stdin, with no command of its own, under any of parse's readings (a shortened long option is one its lists lack, so it is read as taking the next word too); once the readings ran out, any privilege wrapper or su among its words counts as a root shell and any shell's name as a shell: "root" for a privilege wrapper's shell or su not handed a command (`sudo -s`, `nice doas -s`, `su root`, `busybox su`, an option or program in a variable taken as one), "shell" for a shell given no script or stdin's name as one (`sh`, `sudo bash`, `sh -`, `. /dev/fd/0`), and for a shell, an eval, a source or a program the hook cannot read that a pipe or xargs feeds, whatever its arguments; "code" for an interpreter of another language (`python3`, `node18`) that a pipe or xargs feeds, whatever its options or inline program, unless it runs a script file or a module of its own; a reserved word, a function's name or an assignment before it skipped
export function stdinShell(cmd: Command): StdinKind | undefined {
  cmd = spreadSplit(cmd)
  const parsed = parse(cmd)
  const kinds = readings(parsed).map((reading) => stdinShellOf(cmd, reading))
  if (parsed.capped) {
    const names = cmd.words.map((w) => program(w.value))
    if (names.some((n) => ROOT_SHELLS.has(n) || n === "su")) kinds.push("root")
    else if (names.some((n) => SHELLS.has(n))) kinds.push("shell")
  }
  return kinds.includes("root") ? "root" : kinds.includes("shell") ? "shell" : kinds.find(Boolean)
}

// The command with each env's split string (`env -S 'sudo -s'`) spread into the words env runs, every env read, quoted or behind another wrapper, in one linear pass over a stack of the words still to read; the grammar is the stdin-shell lines of scripts/hooks/README.md
function spreadSplit(cmd: Command): Command {
  if (!cmd.words.some((w) => program(w.value) === "env")) return cmd
  const options = WRAPPERS.get("env") as Options
  const out: Word[] = []
  const rest = [...cmd.words].reverse()
  let inEnvOptions = false
  let spreadOne = false
  for (let w = rest.pop(); w; w = rest.pop()) {
    const v = w.value
    const long = inEnvOptions ? envLong(v) : undefined
    const split =
      long?.name === "split-string"
        ? (long.value ?? "")
        : long || !inEnvOptions
          ? undefined
          : SPLIT.exec(v)?.[1]
    if (split !== undefined) {
      const text = (split || rest.pop()?.value || "")
        .replace(/\$\{[^}]*\}/g, UNKNOWN)
        .replace(/\\[_fnrtv]/g, " ")
        .replace(/['"\\]/g, "")
      const words = text.split(/\s+/).filter(Boolean)
      for (let j = words.length - 1; j >= 0; j--) rest.push({ quoted: false, value: words[j] })
      spreadOne = true
      continue
    }
    // a lone `-` is env's `-i`, and BSD env reads its options on after it (GNU env's end there, so this reads more than GNU runs); it is written as `-i` for parse
    if (inEnvOptions && v === "-") {
      out.push({ ...w, value: "-i" })
      continue
    }
    out.push(w)
    if (program(v) === "env") inEnvOptions = true
    else if (!inEnvOptions || ASSIGN.test(v)) continue
    else if (!v.startsWith("-") || v === "--") inEnvOptions = false
    else if (
      long
        ? ENV_LONG_VALUES.has(long.name) && long.value === undefined
        : ENV_SHORT_VALUE.test(v) || optionValue(v, options) === "next"
    ) {
      const value = rest.pop()
      if (value) out.push(value)
    }
  }
  return spreadOne ? { ...cmd, words: out } : cmd
}

// GNU env's long options, each read by any unique prefix as its getopt_long reads it (`--split`, `--u X`), and the ones that take a value; its short ones that take a value end a cluster of its flags (`-a name`, `-iu X`)
const ENV_LONG = [
  "argv0",
  "block-signal",
  "chdir",
  "debug",
  "default-signal",
  "help",
  "ignore-environment",
  "ignore-signal",
  "list-signal-handling",
  "null",
  "split-string",
  "unset",
  "version",
]
const ENV_LONG_VALUES = new Set(["argv0", "chdir", "split-string", "unset"])
const ENV_SHORT_VALUE = /^-[0iv]*[aCu]$/

// env's long option a word names, by its full name or a unique prefix, with the value attached after `=`
function envLong(v: string): { name: string; value?: string } | undefined {
  const m = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(v)
  if (!m) return undefined
  const hits = ENV_LONG.filter((o) => o.startsWith(m[1]!))
  const name = hits.includes(m[1]!) ? m[1] : hits.length === 1 ? hits[0] : undefined
  return name ? { name, value: m[2] } : undefined
}

export type StdinKind = "code" | "root" | "shell"
// A command whose piped input may run as code, with the kind stdinShell gives it
type Fed = { consumer: Command; kind: StdinKind }

function stdinShellOf(cmd: Command, { args, first, name, xargs }: Parsed): StdinKind | undefined {
  // piped input, or input xargs hands on as words, reaches whatever the command runs, so a command that can run code takes it as code whatever its arguments say
  const fed = !!cmd.stdin || !!xargs
  if (first && !marked(first.value)) {
    if (name === "." || name === "source" || name === "eval")
      return fed || (name !== "eval" && STDIN_PATHS.has(args[0]?.value ?? "")) ? "shell" : undefined
    const family = familyOf(name)
    if (family) return fed && interpreted(family, args, xargs) ? "code" : undefined
    // su, busybox's applet included, with no command of its own starts a root shell that reads its script from stdin, as `sudo -s` does
    if (name === "su") return suCommand(args) ? undefined : "root"
    if (!SHELLS.has(name)) return undefined
    if (fed) return "shell"
    const { inline, operand } = shellOperand(args, name)
    return inline || (operand && !STDIN_PATHS.has(operand.value)) ? undefined : "shell"
  }
  let at = 0
  for (let w = cmd.words[at]; w && !w.quoted; w = cmd.words[at]) {
    if (w.value === "function") at += 2
    else if (RESERVED.has(w.value) || ASSIGN.test(w.value)) at++
    else break
  }
  const end = first ? cmd.words.indexOf(first) : -1
  const before = cmd.words.slice(at, end === -1 ? undefined : end)
  // the first unquoted word naming a wrapper, by its basename, as the reading before quoted words were read
  const firstWrapper = before.find((w) => !w.quoted && ROOT_SHELLS.has(program(w.value)))
  const wrappers: string[] = []
  for (const w of before) {
    if (wrappers.some((wrapper) => startsRootShell(wrapper, w.value))) return "root"
    // a wrapper: that first one, or a word whose unquoted value is a wrapper's bare name (`'sudo'`, `\doas`, `doas sudo`)
    if (w === firstWrapper || ROOT_SHELLS.has(w.value.toLowerCase()))
      wrappers.push(program(w.value))
  }
  // a program the hook cannot read, behind a wrapper, may be a root shell
  if (first && wrappers.length) return "root"
  if (!first && wrappers.some((wrapper) => BARE_ROOT.has(wrapper))) return "root"
  // a program the hook cannot read (`$SHELL`, `"$X"`) may be a shell
  return fed && first ? "shell" : undefined
}

// The option words su takes before -c or --command for its line to read as a command of its own, each known exactly; any other option word reads as a root shell, so an option's value never hides a -c
const SU_PLAIN = new Set(["-", "-f", "-l", "-m"])
// Whether su's words hand it a command: -c or --command with its command, after option words of SU_PLAIN and words the hook reads whole alone (`su root -c <cmd>`, `su - -c <cmd>`), since a value it cannot read, or a glob, may be any option
const suCommand = (args: Word[]) => {
  for (const [at, word] of args.entries()) {
    const { value } = word
    if (word.unknown !== undefined || word.glob || marked(value)) return false
    if (value === "-c" || value === "--command") return at + 1 < args.length
    if (value.startsWith("--command=")) return true
    if (value.startsWith("-") && !SU_PLAIN.has(value)) return false
  }
  return false
}
// Whether a word, by its unquoted value, starts a wrapper's root shell: a listed option, alone, as a long one's unambiguous prefix (`--sh`) or in a cluster of the wrapper's flags ahead of its first value-taking letter, or a word the hook cannot read
function startsRootShell(wrapper: string, value: string): boolean {
  if (marked(value)) return true
  const shells = ROOT_SHELLS.get(wrapper) as Set<string>
  const { flags, values } = WRAPPERS.get(wrapper) as Options
  if (value.startsWith("--")) {
    const named = [...flags, ...values].filter((o) => o.startsWith(value))
    return shells.has(named.length === 1 ? named[0] : value)
  }
  if (!/^-[A-Za-z]/.test(value)) return false
  let shell = false
  for (const c of value.slice(1)) {
    if (values.has(`-${c}`)) return shell
    if (!flags.has(`-${c}`)) return false
    shell ||= shells.has(`-${c}`)
  }
  return shell
}

// Interpreters of another language, whose script the hook cannot read, each by its family: the options that take the next word as their value when none is attached (`values` short, `takes` long), so its script operand is found past them; `own` names an option whose value is a program of its own (a module, a file), which the line does not hold either; any other option, inline code's among them, reads as code
type Family = { own?: string; takes: string[]; values: string }
const FAMILIES: Record<string, Family> = {
  bun: { takes: ["--cwd", "--env-file", "--preload", "--tsconfig-override"], values: "r" },
  deno: { takes: ["--config", "--import-map"], values: "c" },
  lua: { takes: [], values: "l" },
  node: {
    takes: [
      "--conditions",
      "--env-file",
      "--experimental-loader",
      "--import",
      "--input-type",
      "--inspect-port",
      "--loader",
      "--max-old-space-size",
      "--require",
      "--stack-size",
      "--title",
    ],
    values: "Cr",
  },
  osascript: { takes: [], values: "ls" },
  perl: { takes: [], values: "I" },
  php: { own: "f", takes: [], values: "cdf" },
  python: { own: "m", takes: ["--check-hash-based-pycs"], values: "WXm" },
  ruby: { takes: [], values: "CEIr" },
}
// An interpreter's name, by its family, through a version suffix (`python3.12`, `node18`, `lua5.4`) and the family's other names (`nodejs`, `luajit`)
const FAMILY = /^(bun|deno|lua|luajit|node|nodejs|osascript|perl|php|python|ruby)[\d.]*$/
const familyOf = (name: string): Family | undefined => {
  const base = FAMILY.exec(name)?.[1]
  return base ? FAMILIES[base === "nodejs" ? "node" : base === "luajit" ? "lua" : base] : undefined
}
// Whether a piped interpreter may take its piped input as code: whatever its options say, unless it runs a script file or a module of its own past options its family's table names, named by a literal word the input does not fill in (`node x.js`, `python3 -m json.tool`), whose text is outside the line
function interpreted(family: Family, args: Word[], xargs: Xargs): boolean {
  const filled = (word: Word) =>
    marked(word.value) || (!!xargs?.replace && word.value.includes(xargs.replace))
  const own = (word: Word | undefined) => !!word && !filled(word) && !STDIN_PATHS.has(word.value)
  // bun and deno run a bare name as a package script, a subcommand or a program on PATH (`bun run sh`, `bun x sh`, `bun repl`, `deno task x`), so there only a JavaScript or TypeScript file's name is a script of its own
  const runner = family === FAMILIES.bun || family === FAMILIES.deno
  const script = (word: Word | undefined) =>
    own(word) && (!runner || /\.[cm]?[jt]sx?$/.test(word?.value ?? ""))
  let sub = false
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (value === "--") return !script(args[k + 1])
    if (value.startsWith("--")) {
      if (!family.takes.includes(value.split("=")[0])) return true
      if (!value.includes("=")) k++
      continue
    }
    if (value.startsWith("-") && value !== "-") {
      const [letter, attached] = [value[1], value.slice(2)]
      if (!family.values.includes(letter)) return true
      if (letter === family.own)
        return !own(attached ? { ...args[k], value: attached } : args[k + 1])
      if (!attached) k++
      continue
    }
    if (runner && !sub && value === "run") {
      sub = true
      continue
    }
    return !script(args[k])
  }
  return true
}

// Every command whose piped input may run as code, by the command whose output it reads, with the kind stdinShell gives it: one stdinShell names, or one that opens a loop, a conditional or a brace group whose body up to its closing word holds a command that would be one under the same pipe, since every command of the body reads that stdin; "code" wins over "shell", since the hook can read none of it
export function codeFed(commands: Command[]): Map<Command, Fed> {
  const fed = new Map<Command, Fed>()
  const add = (cmd: Command, kind: StdinKind | undefined) => {
    if (!kind || !cmd.stdin) return
    const known = fed.get(cmd.stdin)
    if (known?.kind !== "code") fed.set(cmd.stdin, { consumer: cmd, kind })
  }
  for (const [k, cmd] of commands.entries()) {
    if (!cmd.stdin) continue
    add(cmd, stdinShell(cmd))
    let depth = 0
    for (let j = k; j < commands.length; j++) {
      const body = commands[j]
      for (const m of markers(body.words)) depth += OPENS.has(m) ? 1 : CLOSES.has(m) ? -1 : 0
      if (j > k) add(cmd, stdinShell({ ...body, stdin: cmd.stdin }))
      if (depth <= 0) break
    }
  }
  return fed
}

// A compound command's input redirects (`{ sh; } <<< x`, `( sh ) < f`, `while read l; do sh; done <<< x`, `{ sh <&3; } 3<<< x`) apply to every command in its body before that command's own, as the shell runs them, a pipe into one keeping its stdin; the last close is read first, so an outer one reaches an inner one's body too
function feedBodies(commands: Command[]): void {
  for (let k = commands.length - 1; k >= 0; k--) {
    const close = commands[k]
    const inputs = close.redirects.filter((r) => r.op.startsWith("<") || dupOnto0(r))
    if (inputs.length === 0) continue
    const region = CLOSES.has(markers(close.words)[0] ?? "") ? bodyOf(commands, k) : undefined
    const body = close.inner ? close.inner() : (region ?? [])
    // a pipe from a command inside the body, or inside the subshell, is the body command's own; one into the group from outside gives way to the group's redirect, as the shell applies it after
    const ownPipe = (cmd: Command): boolean =>
      !!cmd.stdin && (region ? region.includes(cmd.stdin) : cmd.stdin.scope > close.scope)
    const fed = inputs.map((r) => ({ ...r, bodyFed: r.bodyFed ?? r }))
    const origins = new Set(fed.map((r) => r.bodyFed))
    for (const cmd of body) {
      if (cmd === close) continue
      // the group's redirects apply before the command's own, so its own stdin, its own pipe included, wins; an outer group's copy already there gives way to the inner group's, which carries it first
      const own = cmd.redirects.filter((r) => !r.bodyFed || !origins.has(r.bodyFed))
      cmd.redirects.splice(
        0,
        cmd.redirects.length,
        ...(ownPipe(cmd) ? fed.filter((r) => fdOf(r) !== "0") : fed),
        ...own,
      )
    }
  }
}

// The body a closing word at k ends: the commands from the one that opens it up to k, by the reserved words in command position
function bodyOf(commands: Command[], k: number): Command[] {
  let depth = 0
  for (let j = k; j >= 0; j--) {
    for (const m of markers(commands[j].words)) depth += CLOSES.has(m) ? 1 : OPENS.has(m) ? -1 : 0
    if (depth <= 0) return commands.slice(j, k + 1)
  }
  return []
}

// Wrappers that take one positional argument (a count or a duration) before the command.
export const COUNTED = new Set(["repeat", "timeout"])
export const SHELLS = new Set(["bash", "csh", "dash", "fish", "ksh", "sh", "tcsh", "zsh"])
// A double-quoted expansion every shell reads as one word: a plain parameter, one with an operator after its name (a default, a pattern cut, a replacement), arithmetic, a command substitution or a backtick; a zsh flag, a subscript, `$@`, `$*` or a default's or alternate's text holding an `@` is none
const QUOTED_ONE_WORD =
  /^(?:\$(?:[A-Za-z_]\w*|\d|\{(?:[A-Za-z_]\w*|\d+)(?::?[-+=?][^}@]*|(?:[#%]{1,2}|\/{1,2})[^}]*)?\}|\([\s\S]*\))|`[\s\S]*`)$/
// The script names a shell or a source reads stdin through
const STDIN_PATHS = new Set(["-", "/dev/fd/0", "/dev/stdin", "/proc/self/fd/0"])
const EXPORTS = new Set(["declare", "export", "local", "readonly", "typeset"])
export const PRINTERS = new Set(["echo", "printf"])
// Every git-reading hook's one list of the words git 2.56 steps over before its subcommand: each option that takes the next word as its value, and --exec-path, which takes none but whose bare form prints git's folder and exits, so the word after it never runs.
export const GIT_TAKES = new Set([
  "-C",
  "-c",
  "--attr-source",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
])

const API_FIELDS = new Set(["-F", "--field", "-f", "--raw-field"])
const API_TAKES = new Set([
  ...API_FIELDS,
  "--cache",
  "-H",
  "--header",
  "--hostname",
  "--input",
  "-p",
  "--preview",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-X",
  "--method",
])
const CURL_DATA = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-F",
  "--form",
  "--form-string",
  "--json",
  "-T",
  "--upload-file",
])
export const CURL_TAKES = new Set([
  ...CURL_DATA,
  "-A",
  "--user-agent",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "-D",
  "--dump-header",
  "-e",
  "--referer",
  "-H",
  "--header",
  "-K",
  "--config",
  "-m",
  "--max-time",
  "-o",
  "--output",
  "-u",
  "--user",
  "--url",
  "-w",
  "--write-out",
  "-X",
  "--request",
  "-x",
  "--proxy",
])
const ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'",
  "?": "?",
  "\\": "\\",
  a: "\x07",
  b: "\b",
  E: "\x1b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

export const unknown = (why: string): Text => ({ unknown: why, value: UNKNOWN })

// Each scope's variable names in the order they were set, so a hook reads only those set since it last looked, where a read of them all before each command grows with the square of their count; every set here goes through setVar.
const setLog = new WeakMap<Map<string, Text>, string[]>()
const setVar = (vars: Map<string, Text>, key: string, value: Text): void => {
  vars.set(key, value)
  const log = setLog.get(vars)
  if (log) log.push(key)
  else setLog.set(vars, [key])
}

// The names a scope's variables were set by since a hook's cursor, every name on its first look (a copied scope's included), and the cursor that marks where it read to.
export function varsSince(vars: Map<string, Text>, cursor: number | undefined): [string[], number] {
  const log = setLog.get(vars) ?? []
  return [cursor === undefined ? [...vars.keys()] : log.slice(cursor), log.length]
}

const merge = (out: Text, part: Text): void => {
  out.value += part.value
  if (part.splits) out.splits = true
  if (part.unknown) out.unknown ??= part.unknown
  if (part.variable) out.variable ??= part.variable
  if (part.reads?.length) (out.reads ??= []).push(...part.reads)
}

const join = (parts: Text[], separator = ""): Text => {
  const out: Text = { value: "" }
  parts.forEach((part, k) => {
    if (k > 0) out.value += separator
    merge(out, part)
  })
  return out
}

export const slice = (word: Word, from: number): Word => {
  const dropped = word.value.slice(0, from).split(READ).length - 1
  return { ...word, reads: word.reads?.slice(dropped), value: word.value.slice(from) }
}

export const visible = (value: string): string =>
  value.replaceAll(UNKNOWN, " ").replaceAll(READ, " ")

export const marked = (value: string): boolean => value.includes(UNKNOWN) || value.includes(READ)
// The bare characters no glob option makes an operator without a paren
const PLAIN = /^[\w./=,:@%-]$/
// Whether an eval takes a word as other than written: an unread part, or a bare character outside PLAIN, which some shell option makes a glob whose file names run as code
export const unreadWord = (word: Word): boolean => {
  if (word.unknown !== undefined || marked(word.value)) return true
  const src = word.source
  if (src === undefined) return ![...word.value].every((c) => PLAIN.test(c))
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "\\") i++
    else if (c === "'") {
      i = src.indexOf("'", i + 1)
      if (i === -1) return true
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++)
        if (src[i] === "\\") i++
        else if (src[i] === "$" && src[i + 1] === "(") i = balanced(src, i + 1, "(", ")") - 1
        else if (src[i] === "`") i = src.indexOf("`", i + 1)
      if (i === -1 || i >= src.length) return true
    } else if (!PLAIN.test(c)) return true
  }
  return false
}

// The shell's own builtins whose effect a hook follows (its folder, its variables, its aliases, a name's lookup): the shell matches them by their exact case, and in another case one runs no builtin (macOS's /usr/bin/cd and the like run `builtin cd` in a child), so it changes nothing of the shell's
const SHELL_OWN = new Set([
  ".",
  "alias",
  "cd",
  "declare",
  "eval",
  "export",
  "hash",
  "let",
  "local",
  "popd",
  "pushd",
  "read",
  "readonly",
  "set",
  "shift",
  "source",
  "trap",
  "type",
  "typeset",
  "unalias",
  "unset",
])
// Homebrew coreutils' second copies of the wrappers, each run with its plain name's options
const G_WRAPPERS = new Map([
  ["genv", "env"],
  ["gnice", "nice"],
  ["gnohup", "nohup"],
  ["gstdbuf", "stdbuf"],
  ["gtimeout", "timeout"],
])
// A command word's program by its basename, in lower case, since macOS's filesystem ignores case and runs a program named in any case; a builtin of SHELL_OWN keeps the word as written unless it is the bare lower-case name, since in another case or by a path it runs macOS's /usr/bin stand-in in a child, and a g-wrapper reads as its plain name
export const program = (value: string): string => {
  const base = basename(value.replace(/^=/, ""))
  const lower = base.toLowerCase()
  if (SHELL_OWN.has(lower) && value !== lower) return value
  return G_WRAPPERS.get(lower) ?? lower
}

// uv's and uvx's options that take the next word as their value, so the word after is not the program
export const UV_TAKES = new Set([
  "--cache-dir",
  "--config-file",
  "--directory",
  "--env-file",
  "--extra",
  "--extra-index-url",
  "--from",
  "--group",
  "--index",
  "--index-url",
  "--package",
  "--project",
  "-p",
  "--python",
  "--with",
  "--with-editable",
  "--with-requirements",
])

const PYTHON = /^python(?:\d+(?:\.\d+)*)?$/
// The module a `python -m <module>` runs and the words after it, or undefined for any other command.
export function pythonModule(
  name: string,
  args: Word[],
): { module: string; rest: Word[] } | undefined {
  if (!PYTHON.test(name)) return
  const at = args.findIndex((a) => a.value === "-m")
  const module = at === -1 ? undefined : args[at + 1]
  return module && { module: module.value, rest: args.slice(at + 2) }
}

// Expands the backslash escapes of $'...', echo and printf.
function decode(raw: string): string {
  return raw.replace(
    /\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|0?([0-7]{1,3})|([\s\S]))/g,
    (whole, hex?: string, u4?: string, u8?: string, octal?: string, other?: string) => {
      tick()
      const point =
        hex || u4 || u8
          ? Number.parseInt(hex ?? u4 ?? u8 ?? "", 16)
          : Number.parseInt(octal ?? "", 8)
      if (!Number.isNaN(point)) return point <= 0x10ffff ? String.fromCodePoint(point) : whole
      return ESCAPES[other ?? ""] ?? whole
    },
  )
}

export function lex(src: string, known: Record<string, string> = {}): Lexed {
  const lx: Lexer = { commands: [], i: 0, known, scope: 0, scopes: [-1], src, token: freshToken() }
  list(lx, 0, false)
  calledAgain(lx.commands, src)
  braced(lx.commands)
  return { commands: lx.commands, scopes: lx.scopes }
}

// The heads after which zsh takes a brace group as the body, in the head's own words
const BRACED = new Set([
  "elif",
  "else",
  "for",
  "foreach",
  "if",
  "repeat",
  "select",
  "until",
  "while",
])

// Marks each zsh head that holds an unquoted `{` past its command position, closed by a later `}`, as opaque: bash reads `if grep -q { f` with no `}` after it, so that one stays read as typed
function braced(commands: Command[]): void {
  for (const [k, c] of commands.entries()) {
    const head = c.words[0]
    if (!head || head.quoted || !BRACED.has(head.value)) continue
    const at = c.words.findIndex((w, i) => i > 0 && !w.quoted && w.value === "{")
    if (at < 0 || markers(c.words).length > at) continue
    if (commands.slice(k + 1).some((d) => d.words.some((w) => !w.quoted && w.value === "}")))
      c.opaque = true
  }
}

// A function's body runs each time the line calls it, so its commands are marked repeated unless the line names the function just twice, by its definition and by one call that runs at most once: a call in a loop, in another body, or one the line names anywhere else (an eval's text, a recursive call) may run it again; a name the reader cannot read as a plain word, a call through a word it cannot read, and any eval or source may call it again too
function calledAgain(commands: Command[], src: string): void {
  for (const [k, open] of commands.entries()) {
    const [first, second] = open.words
    if (!open.held || !first || first.quoted) continue
    // `function f {` names it in its own words, and `f() {` (or `f() if`, any compound) in the one word before the `()` the lexer reads as an empty group
    const before = commands[k - 1]?.words
    const word =
      first.value === "function"
        ? second
        : open.group && before?.length === 1
          ? before[0]
          : undefined
    if (!word) continue
    let end = k
    for (let balance = 0; end < commands.length; end++) {
      const reserved = markers(commands[end].words)
      balance +=
        reserved.filter((w) => OPENS.has(w)).length - reserved.filter((w) => CLOSES.has(w)).length
      if (balance <= 0) break
    }
    const body = commands.slice(k, end + 1)
    const name = word.value.replace(/\(\)$/, "")
    if (word.quoted || !/^[\w.:-]+$/.test(name)) {
      for (const c of body) c.repeated = true
      continue
    }
    const outside = commands.filter((_, at) => at < k - 1 || at > end).map(callee)
    const calls = outside.filter((w) => w?.value === name)
    const others = outside.some(
      (w) =>
        w !== undefined &&
        (w.unknown !== undefined ||
          (!w.quoted && (w.value === "eval" || w.value === "source" || w.value === "."))),
    )
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // a redirect's target names a file, never a call, so a file of the function's name is no mention of it
    const files = commands
      .flatMap((c) => c.redirects)
      .filter((r) => r.target?.value === name).length
    const mentions =
      (src.match(new RegExp(`(?<![\\w.:-])${escaped}(?![\\w.:-])`, "g"))?.length ?? 0) - files
    const call = commands.find((c, at) => (at < k - 1 || at > end) && callee(c)?.value === name)
    const once = mentions === 2 && calls.length === 1 && !others && !call?.repeated && !call?.kept
    if (!once) for (const c of body) c.repeated = true
  }
}

// The word a command runs as its program, past its assignments, its reserved words and `builtin` or `command` with their options, quoted or not, so `$'\x66'` reads as the `f` it calls
function callee(cmd: Command): Word | undefined {
  return cmd.words.find(
    (w) =>
      w.quoted ||
      !(
        ASSIGN.test(w.value) ||
        MARKERS.has(w.value) ||
        BUILTIN.has(w.value) ||
        w.value.startsWith("-")
      ),
  )
}

// A subshell or a substitution is a scope of its own, so a cd inside it stays inside it.
function nest(lx: Lexer, inherit?: Command): void {
  list(lx, lx.scopes.push(lx.scope) - 1, true, inherit)
}

function list(lx: Lexer, scope: number, nested: boolean, inherit?: Command): void {
  const outer = lx.scope
  lx.scope = scope
  try {
    walk(lx, scope, nested, inherit)
  } finally {
    lx.scope = outer
  }
}

function walk(lx: Lexer, scope: number, nested: boolean, inherit?: Command): void {
  const { src } = lx
  const pending: Pending[] = []
  const fresh = (): Command => ({ redirects: [], scope, stdin: inherit, words: [] })
  let cmd = fresh()
  const opens: number[] = []
  // How many bodies the walk is inside, how many of them a loop runs, and the operator that joined the last command to this one, so a command the shell may not run is marked unsure and one it runs only on the command before it succeeding is marked chained.
  let depth = 0
  let loops = 0
  let after = ""
  // each body the walk is inside, true for one the shell may keep for a later call
  const bodies: boolean[] = []
  // each loop whose `do` the walk has not reached, true for a while's or an until's, whose condition the shell runs once for each pass and once more
  const heads: boolean[] = []
  // A pipeline's commands and a backgrounded one run in subshells: a cd there leaves the shell where it was.
  const end = (op: string) => {
    const done = cmd
    const pipe = op === "|" || op === "|&"
    const brace = (c: Command, value: string) => c.words[0]?.value === value && !c.words[0].quoted
    if (brace(done, "}")) {
      const open = opens.pop()
      if (open !== undefined) {
        const { commands } = lx
        const close = commands.length
        done.inner = () => topLevel(commands.slice(open, close), scope)
      }
    }
    if (pipe || op === "&") done.detached = true
    if (done.words.length > 0 || done.redirects.length > 0 || done.group) {
      // the reserved words in command position alone, so an argument that holds one (`grep -q done`, `echo if`) opens and closes no body
      const reserved = markers(done.words)
      const opened = reserved.filter((w) => OPENS.has(w)).length
      const closed = reserved.filter((w) => CLOSES.has(w)).length
      const body = reserved.some((w) => HELD.has(w) || BODIES.has(w))
      const loop = reserved.includes("do")
      // an `&&` is left out: a command on its right runs only if the one before it succeeded, so it is chained rather than unsure, and every command the chain joins after it runs only if it did too
      if (after === "||" || depth > 0 || body) done.unsure = true
      if (after === "&&") done.chained = true
      done.chain = lx.token
      if (lx.orRun) done.orRun = true
      // `f() if …`, a function whose body is a compound other than a brace group, keeps that body for each call as `f() {` keeps its own
      const last = lx.commands[lx.commands.length - 1]?.words
      const compound =
        !!done.group &&
        last?.length === 1 &&
        OPENS.has(reserved[0] ?? "") &&
        !HELD.has(reserved[0] ?? "")
      if (reserved.some((w) => HELD.has(w)) || compound) done.held = true
      if (done.held || bodies.includes(true)) done.kept = true
      for (const [at, w] of reserved.entries()) {
        if (OPENS.has(w)) bodies.push(HELD.has(w) || (compound && at === 0))
        else if (CLOSES.has(w)) bodies.pop()
      }
      // zsh's foreach runs its body up to an `end`, with no `do`
      const each = done.words[0]?.quoted ? undefined : done.words[0]?.value
      const outer = heads.length === 0 && loops === 0
      let head = heads.length > 0
      for (const w of reserved) {
        if (w === "while" || w === "until" || w === "for" || w === "select")
          heads.push(w === "while" || w === "until")
        else if (w === "do") heads.pop()
        head ||= heads.length > 0
      }
      if (each === "foreach") heads.push(false)
      else if (each === "end" && heads.length > 0 && !loop) heads.pop()
      // every command between a loop's head and its `do` runs once for each pass: a while's or an until's condition, and the body of zsh's short loops, which have no `do`
      if (loops > 0 || loop || head || each === "foreach") done.repeated = true
      if (outer && !loop && reserved.some((w) => w === "while" || w === "until"))
        done.atLeastOnce = true
      depth = Math.max(0, depth + opened - closed)
      loops = Math.max(0, loops + (loop ? 1 : 0) - (reserved.includes("done") ? 1 : 0))
      // a run ends only at an operator that runs the next command whatever this one did, and only outside every body: a `|` keeps the pipeline in the run, and entering a group, a body or a script keeps the run it was reached through
      if (depth === 0 && FREES.has(op)) {
        lx.token = freshToken()
        lx.orRun = op === "||"
      }
      after = op
      for (const w of done.words) {
        if (w.value !== "{" || w.quoted) break
        opens.push(lx.commands.length)
      }
      lx.commands.push(done)
    }
    cmd = fresh()
    cmd.follows = op
    if (pipe) {
      cmd.stdin = done
      cmd.detached = true
    }
  }
  while (lx.i < src.length) {
    tick()
    const c = src[lx.i]
    const redirect = REDIRECT.exec(src.slice(lx.i, lx.i + 8))
    if (c === " " || c === "\t") lx.i++
    else if (c === "\\" && src[lx.i + 1] === "\n") lx.i += 2
    else if (c === "\n") {
      lx.i++
      heredocs(lx, pending, nested)
      end(";")
    } else if (c === "#") {
      while (lx.i < src.length && src[lx.i] !== "\n") lx.i++
    } else if (c === ")") {
      lx.i++
      end(")")
      if (nested) return
    } else if (c === "(") {
      lx.i++
      const piped = cmd.words.length === 0 && cmd.redirects.length === 0 ? cmd.stdin : undefined
      end(";")
      const from = lx.commands.length
      const scope = lx.scopes.length
      nest(lx, piped)
      cmd.group = true
      const members = topLevel(lx.commands.slice(from), scope)
      cmd.inner = () => members
    } else if ((c === "<" || c === ">") && src[lx.i + 1] === "(") {
      cmd.words.push(procSub(lx))
    } else if (redirect) {
      lx.i += redirect[0].length
      while (src[lx.i] === " " || src[lx.i] === "\t") lx.i++
      const [, fd] = redirect
      // zsh's >!, >>! and >&! override noclobber as >| does
      const op = redirect[2].replace(/!$/, "|").replace(/^(>[>&])\|$/, "$1")
      const target = src.startsWith("<(", lx.i) ? procSub(lx) : word(lx)
      const entry: Redirect = { fd, op, target }
      if (op === "<<" || op === "<<-") {
        pending.push({
          delim: target.value,
          quoted: target.quoted,
          redirect: entry,
          strip: op === "<<-",
        })
      } else if (op === "<<<") entry.body = { ...target, value: `${target.value}\n` }
      cmd.redirects.push(entry)
    } else if (c === ";" || c === "&" || c === "|") {
      const two = src.slice(lx.i, lx.i + 2)
      const op = ["&&", ";;", "|&", "||"].includes(two) ? two : c
      lx.i += op.length
      end(op)
    } else {
      const from = lx.i
      cmd.words.push(word(lx))
      if (lx.i === from) lx.i++
    }
  }
  heredocs(lx, pending, nested)
  end(";")
}

// The commands of one scope whose output leaves it, so not piped into another.
function topLevel(cmds: Command[], scope: number): Command[] {
  const fed = new Set(cmds.map((c) => c.stdin))
  return cmds.filter((c) => !fed.has(c) && c.scope === scope)
}

// A process substitution, carrying the commands whose output leaves it, so a shell that reads it as a script can read that output.
function procSub(lx: Lexer): Word {
  lx.i += 2
  const from = lx.commands.length
  const scope = lx.scopes.length
  nest(lx)
  return {
    procs: topLevel(lx.commands.slice(from), scope),
    quoted: false,
    ...unknown("a process substitution"),
  }
}

function heredocs(lx: Lexer, pending: Pending[], nested: boolean): void {
  for (const doc of pending.splice(0)) {
    const lines: string[] = []
    while (lx.i < lx.src.length) {
      tick()
      const start = lx.i
      const newline = lx.src.indexOf("\n", start)
      const stop = newline === -1 ? lx.src.length : newline
      const raw = lx.src.slice(start, stop)
      const line = doc.strip ? raw.replace(/^\t+/, "") : raw
      lx.i = stop + 1
      if (line === doc.delim) break
      // bash 3.2 ends a heredoc inside $( ) at `EOF)`, leaving the `)` to close the substitution.
      if (nested && line.startsWith(`${doc.delim})`)) {
        lx.i = start + raw.length - line.length + doc.delim.length
        break
      }
      lines.push(line)
    }
    const body = lines.map((line) => `${line}\n`).join("")
    doc.redirect.body = doc.quoted ? { value: body } : expandHeredoc(body)
    if (!doc.quoted) textCommands(lx, body)
  }
}

// Lexes the commands the shell runs in text whose quotes are plain characters (an unquoted heredoc's body, a `${…}` or `$((…))` inside double quotes or such a body): each `$(…)` and backquoted command, through the word lexer's own dollar() and backtick(), so they join the line's commands as a word's substitution does; a backslash keeps the character after it (a `\`, `$`, backquote or line break) as text.
function textCommands(lx: Lexer, text: string): void {
  const sub = { ...lx, i: 0, src: text }
  while (sub.i < text.length) {
    tick()
    const c = text[sub.i]
    if (c === "\\") sub.i += 2
    else if (c === "$") dollar(sub, true)
    else if (c === "`") backtick(sub)
    else sub.i++
  }
}

function expandHeredoc(body: string): Text {
  const joined = body.replaceAll("\\\n", "")
  const value = joined.replace(/\\([\\$`])/g, "$1")
  return /\$[\w{(@*#?!$-]|`/.test(joined.replace(/\\[\\$`]/g, ""))
    ? { unknown: "an expansion in an unquoted heredoc", value }
    : { value }
}

function word(lx: Lexer): Word {
  const { src } = lx
  const start = lx.i
  const out: Word = { quoted: false, value: "" }
  let bare = ""
  while (
    lx.i < src.length &&
    (!BREAK.has(src[lx.i]) || (src[lx.i] === "(" && lx.i > start && src[lx.i + 1] !== ")"))
  ) {
    tick()
    const c = src[lx.i]
    const next = src[lx.i + 1] ?? ""
    if (c === "(") {
      const end = balanced(src, lx.i, "(", ")")
      out.value += src.slice(lx.i, end)
      bare += src.slice(lx.i, end)
      inner(lx, src.slice(lx.i + 1, end - 1))
      lx.i = end
    } else if (c === "\\") {
      out.quoted = true
      if (next !== "\n") out.value += next
      lx.i += 2
    } else if (c === "'") {
      out.quoted = true
      const close = src.indexOf("'", lx.i + 1)
      const stop = close === -1 ? src.length : close
      out.value += src.slice(lx.i + 1, stop)
      lx.i = stop + 1
    } else if (c === '"') {
      out.quoted = true
      lx.i++
      merge(out, double(lx))
    } else if (c === "$" && next === "'") {
      out.quoted = true
      merge(out, ansi(lx))
    } else if (c === "$" && next === '"') lx.i++
    else if (c === "$" || c === "`") {
      // an unquoted expansion's value is globbed too
      const text = c === "$" ? dollar(lx) : backtick(lx)
      merge(out, text)
      if (GLOB_CHARS.test(text.value)) out.glob = true
      if (marked(text.value)) out.splits = true
    } else if (c === "~" && lx.i === start && ends(next)) {
      out.value += homedir()
      lx.i++
    } else {
      // a value the hook could not read, pasted into a line read again (an eval's, a script's), is unquoted text there
      if (c === UNKNOWN || c === READ) out.splits = true
      out.value += c
      bare += c
      lx.i++
    }
  }
  // the lookahead finds the close once, so a { with no } costs its length rather than its square
  if (/\{(?=[^{}]*\})[^{}]*(?:,|\.\.)/.test(bare)) out.unknown ??= "a brace expansion"
  if (GLOB_CHARS.test(bare)) out.glob = true
  out.source = src.slice(start, lx.i)
  if (marked(out.value)) out.raw = out.source
  // zsh expands ~- and ~+ after removing quotes and filling in expansions, so a word opening with an unquoted ~ is read by its value (`~-"/f"`, `~"-"/f`, `~-$Y/f`)
  if (src[start] === "~" && TILDE.test(out.value)) out.tilde = true
  return out
}

const GLOB_CHARS = /[*?[{(]/

// A word's value that opens with ~- or ~+ as zsh expands it: followed by its end, a slash, or a part the shell fills in at run time
const TILDE = /^~[-+](?=\/|$|\u0000)/

// Whether the character after a word's opening ~ ends that part, so the shell expands it: the word's end, a slash or a break
const ends = (c = ""): boolean => c === "" || c === "/" || BREAK.has(c)

function double(lx: Lexer): Text {
  const { src } = lx
  const out: Text = { value: "" }
  while (lx.i < src.length && src[lx.i] !== '"') {
    const c = src[lx.i]
    const next = src[lx.i + 1] ?? ""
    if (c === "\\") {
      if (next !== "\n") out.value += '$`"\\'.includes(next) ? next : c + next
      lx.i += 2
    } else if (c === "$" || c === "`") {
      const from = lx.i
      const text = c === "$" ? dollar(lx, true) : backtick(lx)
      merge(out, text)
      if (marked(text.value) && !QUOTED_ONE_WORD.test(src.slice(from, lx.i))) out.splits = true
    } else {
      out.value += c
      lx.i++
    }
  }
  lx.i++
  return out
}

function ansi(lx: Lexer): Text {
  const { src } = lx
  let i = lx.i + 2
  while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1
  const raw = src.slice(lx.i + 2, Math.min(i, src.length))
  lx.i = i + 1
  return { value: decode(raw) }
}

// `plain` is set where a quote is a plain character (inside double quotes, an unquoted heredoc's body), so a `${…}` or `$((…))` ends at its brace or parenthesis whatever quote sits before it and its text is read by textCommands(), which reaches each substitution past a quote.
function dollar(lx: Lexer, plain = false): Text {
  tick()
  const { src } = lx
  const readText = plain ? textCommands : inner
  const next = src[lx.i + 1] ?? ""
  const variable = (name: string | undefined): Text =>
    name !== undefined && lx.known[name] !== undefined
      ? { value: lx.known[name], variable: name }
      : { ...unknown("a shell variable"), variable: name }
  if (src.startsWith("$((", lx.i)) {
    const end = balanced(src, lx.i + 1, "(", ")", plain)
    readText(lx, src.slice(lx.i + 3, end - 2))
    lx.i = end
    return unknown("an arithmetic expansion")
  }
  if (next === "(") {
    lx.i += 2
    const from = lx.commands.length
    nest(lx)
    return substituted(lx.commands.slice(from), lx.known)
  }
  if (next === "{") {
    const end = balanced(src, lx.i + 1, "{", "}", plain)
    const name = /^\$\{([A-Za-z_]\w*)\}$/.exec(src.slice(lx.i, end))?.[1]
    readText(lx, src.slice(lx.i + 2, end - 1))
    lx.i = end
    return variable(name)
  }
  // zsh's $=X, $~X and $^X read X with a flag (a split, a glob, an array join)
  const flagged = /[=~^]/.test(next) && /[A-Za-z_]/.test(src[lx.i + 2] ?? "")
  if (flagged || /[A-Za-z_]/.test(next)) {
    lx.i += flagged ? 2 : 1
    const from = lx.i
    while (/\w/.test(src[lx.i] ?? "")) lx.i++
    return variable(src.slice(from, lx.i))
  }
  // the shell's pid is digits whatever its value, so a path built around it is judged by where it lands
  if (next === "$") {
    lx.i += 2
    return { value: "99999" }
  }
  if (/[\d@*#?$!-]/.test(next)) {
    lx.i += 2
    return unknown("a shell variable")
  }
  lx.i++
  return { value: "$" }
}

// Lexes an expansion's own text for the substitutions in it, so their commands are read.
function inner(lx: Lexer, src: string): void {
  const sub = { ...lx, i: 0, src }
  while (sub.i < src.length) {
    tick()
    const from = sub.i
    if ((src[sub.i] === "<" || src[sub.i] === ">") && src[sub.i + 1] === "(") procSub(sub)
    else word(sub)
    if (sub.i === from) sub.i++
  }
}

function balanced(src: string, from: number, open: string, close: string, plain = false): number {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    tick()
    const c = src[i]
    if (c === "\\") i++
    else if (c === "'" && !plain) {
      const end = src.indexOf("'", i + 1)
      i = end === -1 ? src.length : end
    } else if (c === open) depth++
    else if (c === close && --depth === 0) return i + 1
  }
  return src.length
}

function backtick(lx: Lexer): Text {
  const { src } = lx
  let i = lx.i + 1
  let inner = ""
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\" && i + 1 < src.length) {
      inner += "$`\\".includes(src[i + 1]) ? src[i + 1] : src[i] + src[i + 1]
      i += 2
    } else inner += src[i++]
  }
  lx.i = i + 1
  list({ ...lx, i: 0, src: inner }, lx.scopes.push(lx.scope) - 1, false)
  return unknown("a command substitution")
}

// `$(cat <<'EOF' ... EOF)`, `$(cat file)` and `$(< file)` are read; any other command substitution is unknown.
// Set while hereStringEchoed lexes a here-string's source again, the one reading in which a substitution's echo is read as its words
let echoes = false

function substituted(inner: Command[], known: Record<string, string>): Text {
  const [only] = inner
  if (inner.length !== 1 || only.stdin || only.group) return unknown("a command substitution")
  const made = mktempPath(only, known)
  if (made) return { value: made }
  const [first, ...args] = only.words
  const plainCat = first?.value === "cat" && !first.unknown && !first.reads?.length
  const input = only.redirects[0]
  if (only.redirects.length === 1 && input.body && plainCat && args.length === 0) {
    return input.body.unknown
      ? input.body
      : { ...input.body, value: input.body.value.replace(/\n+$/, "") }
  }
  if (
    only.redirects.length === 0 &&
    plainCat &&
    args.length === 1 &&
    !args[0].value.startsWith("-")
  ) {
    return { reads: [args[0]], value: READ }
  }
  if (only.words.length === 0 && only.redirects.length === 1 && input.op === "<" && input.target) {
    return { reads: [input.target], value: READ }
  }
  // `$(echo …)` prints its words joined by spaces, when none is an option or a part it cannot read; zsh's echo reads a `\n` as a line break, and any other backslash as an escape it leaves unread
  const printed = args.map((w) => w.value.replaceAll("\\n", "\n"))
  const words =
    args.every((w) => !w.unknown && !w.glob && !marked(w.value)) &&
    printed.every((v) => !v.includes("\\"))
  if (
    echoes &&
    first?.value === "echo" &&
    !first.quoted &&
    only.redirects.length === 0 &&
    words &&
    !args[0]?.value.startsWith("-")
  )
    return { value: printed.join(" ") }
  return unknown("a command substitution")
}

// mktemp's flags that leave it making a fresh name under TMPDIR; a dry run (-u) makes none, so its name can be one that exists
const MKTEMP_FLAGS = new Set(["d", "q"])
const MKTEMP_LONG = new Set(["--directory", "--quiet"])

// The path a plain `mktemp` makes, on a line that never sets TMPDIR (knownVariables drops it then), with no -p, --tmpdir or -t to steer it: its one held template as written, judged where it lands from the call's folder, else a name under TMPDIR standing in for its random part
function mktempPath(cmd: Command, known: Record<string, string>): string | undefined {
  const [first, ...args] = cmd.words
  if (!first || first.quoted || first.value !== "mktemp" || cmd.redirects.length > 0) return
  if (!known.TMPDIR) return
  const flag = ({ quoted, value }: Word) =>
    !quoted &&
    (MKTEMP_LONG.has(value) ||
      (/^-[a-z]+$/.test(value) &&
        value
          .slice(1)
          .split("")
          .every((c) => MKTEMP_FLAGS.has(c))))
  const templates = args.filter((word) => !flag(word))
  const [template] = templates
  if (templates.length > 1 || template?.value.startsWith("-") || marked(template?.value ?? ""))
    return
  return template ? template.value : `${known.TMPDIR.replace(/\/$/, "")}/tmp.mktemp`
}

// xargs in front of a command: `replace` is its -I (or BSD -J) string, which marks where stdin goes; without one, stdin is appended as arguments.
export type Xargs = { replace?: string } | undefined

export type Parsed = {
  // the other readings of a wrapper's option it cannot read, each judged as the command too
  also: Parsed[]
  args: Word[]
  // the parse ran out of other readings (READINGS), so an option it cannot read was read as a flag alone
  capped?: boolean
  chdir?: Word
  first?: Word
  local: Map<string, Text>
  name: string
  xargs: Xargs
}

// env's split-string option, attached or not, with the text it carries attached
const SPLIT = /^(?:-[0iv]*S|--split-string(?:=|$))(.*)$/

type State = { chdir?: Word; local: Map<string, Text>; rest: Word[]; xargs: Xargs }
// The other readings one command's parse makes at most, so options it cannot read cost a bounded time; past them it reads each as canary did, a flag
const READINGS = 16
type Budget = { capped?: boolean; left: number }

export function parse(cmd: Command): Parsed {
  // the words still to read, the next one last, so env -S puts its words back in front in the time of their own count
  const state: State = { local: new Map(), rest: cmd.words.toReversed(), xargs: undefined }
  const { rest } = state
  for (let w = rest.at(-1); w && !w.quoted; w = rest.at(-1)) {
    if (RESERVED.has(w.value)) rest.pop()
    else if (w.value === "function") rest.length = Math.max(0, rest.length - 2)
    else break
  }
  while (ASSIGN.test(rest.at(-1)?.value ?? "")) assign(state.local, rest.pop() as Word)
  const budget: Budget = { left: READINGS }
  const parsed = unwrap(state, undefined, budget)
  return budget.capped ? { ...parsed, capped: true } : parsed
}

// A parse's primary reading, then each other reading in `also`, depth first.
const readings = (parsed: Parsed): Parsed[] => [parsed, ...parsed.also.flatMap(readings)]

const assign = (local: Map<string, Text>, w: Word) => {
  const eq = w.value.indexOf("=")
  local.set(w.value.slice(0, eq), slice(w, eq + 1))
}

// The program behind the wrappers at the front of the words, resumed inside `inside`'s options for a second reading: an option the wrapper's lists lack is read as a flag, as a value-less option, and again as taking the next word, and a value in a variable again as expanding to no word and to more than one, each other reading kept in `also`.
function unwrap(state: State, inside: string | undefined, budget: Budget): Parsed {
  const { local, rest } = state
  const peek = (): Word | undefined => rest[rest.length - 1]
  const take = (): Word | undefined => rest.pop()
  const also: Parsed[] = []
  const fork = (wrapper: string, drop: number) => {
    tick()
    if (budget.left-- <= 0) {
      budget.capped = true
      return
    }
    also.push(
      unwrap(
        {
          chdir: state.chdir,
          local: new Map(local),
          rest: rest.slice(0, Math.max(0, rest.length - drop)),
          xargs: state.xargs && { ...state.xargs },
        },
        wrapper,
        budget,
      ),
    )
  }
  for (let wrapper = inside; ; wrapper = undefined) {
    if (!wrapper) {
      wrapper = program(peek()?.value ?? "")
      if (!WRAPPERS.has(wrapper)) break
      if (wrapper === "xargs") state.xargs ??= {}
      take()
    }
    const options = WRAPPERS.get(wrapper) as Options
    for (let w = peek(); w; w = peek()) {
      const v = w.value
      if (ASSIGN.test(v)) assign(local, take() as Word)
      // env -S splits its one string into the words it runs
      else if (wrapper === "env" && SPLIT.test(v)) {
        const attached = SPLIT.exec(v)?.[1] ?? ""
        take()
        const split = (attached || take()?.value || "").split(/\s+/).filter(Boolean)
        for (let j = split.length - 1; j >= 0; j--) rest.push({ quoted: false, value: split[j] })
      } else if (wrapper === "env" && (v === "-C" || v === "--chdir")) {
        take()
        state.chdir = take()
      } else if (wrapper === "env" && /^(?:-C|--chdir=)./.test(v)) {
        state.chdir = slice(w, v.startsWith("-C") ? 2 : "--chdir=".length)
        take()
      } else if (state.xargs && /^(?:-[IiJ]|--replace)/.test(v)) {
        const attached = /^(?:-[IiJ]|--replace=?)(.*)$/.exec(v)?.[1] ?? ""
        take()
        state.xargs.replace = v === "-I" || v === "-J" ? take()?.value : attached || "{}"
      } else if (wrapper === "env" && v === "-") {
        // a lone `-` is env's -i, and BSD env reads its options on after it
        take()
      } else if (v === "--") {
        take()
        while (ASSIGN.test(peek()?.value ?? "")) assign(local, take() as Word)
        break
      } else if (v.startsWith("-") && v !== "-") {
        // nice's own -<number> is its adjustment
        const end =
          wrapper === "nice" && /^-\d+$/.test(v)
            ? "own"
            : marked(v)
              ? undefined
              : optionValue(v, options)
        if (!end) fork(wrapper, 2)
        else if (end === "next" && marked(rest[rest.length - 2]?.value ?? "")) {
          fork(wrapper, 1)
          fork(wrapper, 3)
        }
        rest.length = Math.max(0, rest.length - (end === "next" ? 2 : 1))
      } else break
    }
    if (COUNTED.has(wrapper)) take()
  }
  const first = take()
  return {
    also,
    args: rest.reverse(),
    chdir: state.chdir,
    first,
    local,
    name: first ? program(first.value) : "",
    xargs: state.xargs,
  }
}

// run-slot.sh runs the words after its -- as the command: those words (none when it has no --), or undefined for any other command, so a hook that calls it reads a slotted command as the command itself.
export function slotWords({ args, name }: Parsed): Word[] | undefined {
  if (name !== "run-slot.sh") return
  const at = args.findIndex((a) => a.value === "--")
  return at === -1 ? [] : args.slice(at + 1)
}

// A shell whose script file is run-slot.sh runs that run-slot call: its words from the script on, the shell's own flags before it dropped, or undefined for any other shell call.
export function shellSlot(args: Word[], shell: string): Word[] | undefined {
  const { inline, operand } = shellOperand(args, shell)
  if (inline || !operand || program(operand.value) !== "run-slot.sh") return
  return args.slice(args.indexOf(operand))
}

// A hook's judgement of one command, given everything but the shell's own builtins, the shells it starts, eval, and source or . of a process substitution or /dev/stdin, which run() follows itself.
export type Visit = (cmd: Command, parsed: Parsed, env: Env) => Promise<string | undefined>

// builtins: visit also each bare assignment or wrapper with no command (name "", as a bare `env`), each declare, export, local, readonly or typeset, and a bare copy of each followed command that has a redirect.
export async function run(
  lexed: Lexed,
  env: Env,
  visit: Visit,
  builtins = false,
): Promise<string | undefined> {
  // each script a shell, eval or source reads holds its text until it returns, so a deep chain of them can outgrow the hook's memory and time
  if (running >= MAX_RUNS) throw new RangeError("scripts nested too deep")
  running++
  try {
    return await runAll(lexed, env, visit, builtins)
  } finally {
    running--
  }
}

let running = 0
const MAX_RUNS = 256

async function runAll(
  lexed: Lexed,
  env: Env,
  visit: Visit,
  builtins: boolean,
): Promise<string | undefined> {
  const envs = new Map<number, Env>([[0, env]])
  const envOf = (scope: number): Env => {
    const found = envs.get(scope)
    if (found) return found
    const parent = envOf(lexed.scopes[scope])
    const child: Env = { ...parent, vars: new Map(parent.vars) }
    envs.set(scope, child)
    return child
  }
  feedBodies(lexed.commands)
  for (const [producer, { consumer, kind }] of codeFed(lexed.commands)) {
    producer.feedsShell = true
    // a script in another language is not read as shell
    consumer.runsStdin = kind !== "code"
  }
  for (const cmd of lexed.commands) {
    const verdict = await examine(cmd, envOf(cmd.scope), visit, builtins)
    if (verdict) return verdict
  }
}

const subshell = (env: Env): Env => ({ ...env, vars: new Map(env.vars) })

// One command as run() reads it, cd, the shells it starts, eval, source or . of a process substitution or stdin's name, and piped input a command may run as code followed, for a hook that finds a command inside another (a wrapper's words).
export async function examine(
  cmd: Command,
  env: Env,
  visit: Visit,
  builtins: boolean,
): Promise<string | undefined> {
  tick()
  orElse(cmd, env)
  unchain(cmd, env)
  if (cmd.opaque) {
    env.cwdAnywhere = true
    env.cwdSure = undefined
    env.cwdUnread = true
  }
  const [primary, ...others] = readings(parse(cmd))
  const expanded = expandTilde(cmd, primary.name, env)
  // only the primary reading moves the folder, sets variables and records files, as canary's one reading did; each other runs on a copy of the env before the command
  const before = others.length > 0 || expanded.length > 0 ? apart(env) : env
  const verdict = await examineReading(cmd, primary, env, visit, builtins)
  if (verdict) return verdict
  for (const parsed of others) {
    const verdict = await examineReading(cmd, parsed, apart(before), visit, builtins)
    if (verdict) return verdict
  }
  for (const variant of expanded) {
    const verdict = await examineExpanded(cmd, variant, before, visit, builtins)
    if (verdict) return verdict
  }
  // piped input the command may run as code is judged as a script it runs, unless its own reading took that input as its script already
  if (!cmd.runsStdin || stdinScript(primary)) return
  for (const script of await scriptStdin(cmd, env)) {
    const verdict = await nested(cmd, env, () =>
      run(lexScript(known(script), env), subshell(env), visit, builtins),
    )
    if (verdict) return verdict
  }
}

// Whether a shell or a source reads its script from stdin, as shell() and examineReading read it
function stdinScript({ args, name }: Parsed): boolean {
  if (name === "." || name === "source") return STDIN_PATHS.has(args[0]?.value ?? "")
  if (!SHELLS.has(name)) return false
  const { inline, operand } = shellOperand(args, name)
  return !operand || (!inline && STDIN_PATHS.has(operand.value))
}

const BLIND = "zsh's ~-, the folder the shell last left, which the hook cannot name on this line"

// In a hook that follows ~-, the words a command's unquoted ~- and ~+ expand to, each set judged beside the typed reading so the hook is never looser than that reading: ~+ as the folder each place reads, ~- as the one folder the shell left when the reader can name it, else as unknown, as a variable the hook cannot expand is, so each guard's own rule for one applies. A command of a body the shell may keep for later is judged both ways, since its ~- may expand now or at a later call. A cd's own folder word keeps the reading chdirTo gives it, and its redirects, which the shell opens before it moves, expand as any other command's.
function expandTilde(cmd: Command, name: string, env: Env): Command[] {
  if (!env.old) return []
  const opens = (w?: Word): w is Word => !!w?.tilde && TILDE.test(w.value)
  const moves = name === "cd" || name === "popd" || name === "pushd"
  const words = moves ? [] : cmd.words.filter(opens)
  const targets = cmd.redirects.filter((r) => opens(r.target))
  if (words.length === 0 && targets.length === 0) return []
  const left = leftFolder(env)
  const lefts = cmd.kept ? [...(left === undefined ? [] : [left]), undefined] : [left]
  return lefts.map((dir) => {
    const expand = (w: Word): Word => {
      if (!opens(w)) return w
      const rest = w.value.slice(2)
      if (w.value[1] === "+") return { ...w, tilde: undefined, value: `.${rest}` }
      return dir === undefined
        ? { ...w, tilde: undefined, unknown: BLIND, value: UNKNOWN + rest }
        : { ...w, tilde: undefined, value: dir + rest }
    }
    return {
      ...cmd,
      redirects: cmd.redirects.map((r) =>
        opens(r.target) ? { ...r, target: expand(r.target) } : r,
      ),
      words: moves ? cmd.words : cmd.words.map(expand),
    }
  })
}

// The expanded words are judged on the command itself, swapped in and back, since hooks key their notes on the command, and on a copy of the env before it, as every other reading is.
async function examineExpanded(
  cmd: Command,
  expanded: Command,
  before: Env,
  visit: Visit,
  builtins: boolean,
): Promise<string | undefined> {
  const { redirects, words } = cmd
  cmd.redirects = expanded.redirects
  cmd.words = expanded.words
  try {
    for (const parsed of readings(parse(cmd))) {
      const verdict = await examineReading(cmd, parsed, apart(before), visit, builtins)
      if (verdict) return verdict
    }
  } finally {
    cmd.redirects = redirects
    cmd.words = words
  }
}

// The one folder a ~- names in a hook that follows it, when the reader can name it
function leftFolder(env: Env): string | undefined {
  const left = env.oldFrom ?? (env.old?.dir === undefined ? [] : [env.old.dir])
  return left.length === 1 ? left[0] : undefined
}

const apart = (env: Env): Env => ({
  ...env,
  files: new Map(env.files),
  known: { ...env.known },
  process: { ...env.process },
  vars: new Map(env.vars),
})

async function examineReading(
  cmd: Command,
  parsed: Parsed,
  env: Env,
  visit: Visit,
  builtins: boolean,
): Promise<string | undefined> {
  const { args, chdir, local, name } = parsed
  // env -C runs the command in the folder it names, wherever the shell is, so its own reading of the folder replaces every other
  const into = chdir && pathOf(chdir, env)
  const here: Env = chdir
    ? {
        ...env,
        cwd: into,
        cwdHeld: [],
        cwdMaybe: [],
        cwdSure: into,
        cwdUnread: into === undefined,
      }
    : env
  let verdict: string | undefined
  const followed = SHELLS.has(name) || [".", "cd", "eval", "popd", "pushd", "source"].includes(name)
  if (followed && builtins && cmd.redirects.length > 0) {
    const bare = { ...cmd, bareOf: cmd, words: [] }
    verdict = await visit(bare, parse(bare), here)
    if (verdict) return verdict
  }
  if (name === "") {
    for (const [key, value] of local) setVar(env.vars, key, value)
    // a root shell with no program of its own (`sudo -s <<< …`) is visited when a redirect feeds it, so a hook can read that script
    if (builtins || cmd.feedsShell || rootFed(cmd)) verdict = await visit(cmd, parsed, here)
  } else if (name === "cd" || name === "popd" || name === "pushd") {
    // a glob in the folder is judged as any program's words are, since it may land anywhere it matches
    if (name !== "popd" && args.some((a) => GLOB_CHARS.test(a.value)))
      verdict = await visit(cmd, parsed, here)
    await chdirTo(name, cmd, parsed, env)
  } else if (EXPORTS.has(name)) {
    for (const w of args.filter((a) => ASSIGN.test(a.value))) {
      const eq = w.value.indexOf("=")
      setVar(env.vars, w.value.slice(0, eq), slice(w, eq + 1))
    }
    if (builtins) verdict = await visit(cmd, parsed, here)
  } else if (SHELLS.has(name))
    verdict =
      (here.visitShells ? await visit(cmd, parsed, here) : undefined) ??
      (await nested(cmd, env, () => shell(name, args, cmd, here, visit, builtins, parsed.xargs)))
  else if (
    (name === "source" || name === ".") &&
    (args[0]?.procs || STDIN_PATHS.has(args[0]?.value ?? ""))
  ) {
    const scripts = await scriptOf(args[0], cmd, here)
    verdict = scripts[0].unknown ? await visit(cmd, parsed, here) : undefined
    for (const script of verdict ? [] : scripts) {
      verdict = await nested(cmd, env, () =>
        run(again(lexScript(known(script), env), cmd, parsed), here, visit, builtins),
      )
      if (verdict) break
    }
  } else if (name === "eval") {
    // an eval of an unread word runs code the hook never sees, so a hook judges the eval itself, as the source branch does
    verdict =
      (args.some(unreadWord) ? await visit(cmd, parsed, here) : undefined) ??
      (await nested(cmd, env, () =>
        run(
          again(lexScript(args.map((a) => a.value).join(" "), env), cmd, parsed),
          here,
          visit,
          builtins,
        ),
      ))
  } else verdict = await visit(cmd, parsed, here)
  await record(cmd, name, args, here)
  return verdict
}

// A script an eval or a source reads in the line's own shell runs again each time a count or a loop runs that command, so each of its commands is marked repeated, as the line's own would be
function again(lexed: Lexed, cmd: Command, parsed: Parsed): Lexed {
  if (!manyTimes(cmd, parsed)) return lexed
  const more = onceOrMore(cmd, parsed)
  for (const c of lexed.commands) {
    if (more && !c.repeated) c.atLeastOnce = true
    c.repeated = true
  }
  return lexed
}

// Runs a script a command of the line reads (a shell, an eval, a source). The line's own run does not reach into it, since every command of the script runs because that command ran, so the script reads with no chain of the line's; what the script's own trailing chain leaves joins the line's on the way out, under the reading command's own token, since a cd an `&&` made sure at the end of an eval or a source may not have run either.
async function nested<T>(cmd: Command, env: Env, body: () => Promise<T>): Promise<T> {
  const chain = env.cwdChain
  const token = env.cwdChainToken
  // the script's commands carry runs of their own, so a cd's `||` the line holds stays where it was until the line's next command, and a sure cd the script ends on is the line's, under the reading command's run
  const lineOr = env.cwdOr
  env.cwdChain = []
  env.cwdChainToken = undefined
  env.cwdOr = undefined
  try {
    return await body()
  } finally {
    // the body moved it, which the narrowing after `env.cwdOr = undefined` above cannot see
    const scriptOr = env.cwdOr as CdOr | undefined
    env.cwdOr =
      scriptOr && scriptOr.orChain === undefined
        ? { ...scriptOr, cdChain: cmd.chain, scope: cmd.scope }
        : lineOr
    const left = [...new Set([...(chain ?? []), ...(env.cwdChain ?? [])])]
    env.cwdChain = keep(left, env)
    env.cwdChainToken = left.length > 0 ? (chain?.length ? token : cmd.chain) : undefined
  }
}

// The two wrappers that run a shell builtin, so `builtin cd X` and `command cd X` move the shell as a bare `cd` does; every other wrapper (`env`, `nice`, `xargs`) runs no builtin at all.
const BUILTIN = new Set(["builtin", "command"])
// Whether the shell is sure to run a command once, so the folder a cd of its own lands in is the folder the commands after it run from: it reaches its program as its own first word or through `builtin` or `command` alone, and the lexer marked it neither detached (a pipeline, a background) nor unsure (an `||`'s right side, a body the shell may run no time or many) nor repeated. A command on an `&&`'s right side is sure in this sense, since every command that chain joins after it runs only if it ran and succeeded; `unchain` ends that where the chain does.
const sureToRun = (cmd: Command, parsed: Parsed): boolean =>
  !cmd.detached &&
  !cmd.unsure &&
  !cmd.repeated &&
  (ownFirst(cmd, parsed.first) || throughBuiltin(cmd, parsed))

// Whether the shell runs a command at least once and may run it again: a while's or an until's condition, sure to run as `sureToRun` reads it but for `repeated`, so a count in front of it (`repeat 0`), a body kept for a later call, or an `&&` before the loop (`false && while …`, which may skip it) keeps it out
const onceOrMore = (cmd: Command, parsed: Parsed): boolean =>
  !!cmd.atLeastOnce &&
  !cmd.chained &&
  !cmd.detached &&
  !cmd.kept &&
  !cmd.unsure &&
  (ownFirst(cmd, parsed.first) || throughBuiltin(cmd, parsed))

// Whether `builtin` or `command` runs the command's program, with nothing but their own options, reserved words and assignments in front of it; each counts only as its bare lower-case word, since `COMMAND` runs macOS's /usr/bin/command in a child and `BUILTIN` is not found.
const throughBuiltin = (cmd: Command, { first }: Parsed): boolean => {
  if (!first) return false
  const before = cmd.words.slice(0, cmd.words.indexOf(first))
  return (
    before.some((w) => !w.quoted && BUILTIN.has(w.value)) &&
    before.every(
      (w) =>
        !w.quoted &&
        (BUILTIN.has(w.value) ||
          w.value.startsWith("-") ||
          MARKERS.has(w.value) ||
          ASSIGN.test(w.value)),
    )
  )
}

// Whether a count or a loop may run a command more than once, so a relative cd of its own climbs or descends once for each run.
const manyTimes = (cmd: Command, { first }: Parsed): boolean =>
  !!cmd.repeated ||
  cmd.words
    .slice(0, first ? cmd.words.indexOf(first) : 0)
    .some((w) => !w.quoted && COUNTED.has(program(w.value)))

// The folders the shell may be in before a command runs: the one the reader proved, else each one a cd it could not be sure of may have reached.
const startFolders = (env: Env): string[] => [
  ...(env.cwdSure === undefined ? [] : [env.cwdSure]),
  ...(env.cwdMaybe ?? []),
]

// Each folder the shell may be in when a command runs, as an Env of its own, so a hook judges the command in every folder it cannot rule out: the folder the reader proved, each one a cd it could not be sure of may have reached, and each one a body on the line may cd into. `fallback` is the folder a hook reads when a cd's landing folder cannot be named at all (`cd "$X"`), by its own fail-closed rule. Each Env carries its own folder as both `cwd` and `cwdSure`, so a hook reads the folder it is judging in by either field, and tells the folder the reader proved by `cwdSure` matching the reader's own; a command the reader can place in no folder is judged once with none named. The proven folder comes first.
export function places(env: Env, fallback?: string): Env[] {
  const folders = [
    ...startFolders(env),
    ...(env.cwdHeld ?? []),
    ...(env.cwdUnread && fallback !== undefined ? [fallback] : []),
  ]
  const out: Env[] = []
  const seen = new Set<string>()
  for (const cwd of folders) {
    tick()
    if (seen.has(cwd)) continue
    seen.add(cwd)
    out.push({ ...env, cwd, cwdSure: cwd })
  }
  // a command the reader can place in no folder is judged once with none named, so the hook's own fail-closed rule reads it
  return out.length > 0 ? out : [{ ...env, cwd: undefined, cwdSure: undefined }]
}

// Every folder above a path, up to the root, since a relative cd a loop runs climbs one for each run.
function ancestors(path: string): string[] {
  const out: string[] = []
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    tick()
    out.push(dir)
    if (dir === dirname(dir)) return out
  }
}

// The sign of a cd's or pushd's folder word that opens with an unquoted ~- or ~+, as zsh expands it, in a hook that follows ~-: the word the lexer marks, whose folder the reader can read
const tildeSign = (name: string, dir: Word | undefined, env: Env): string | undefined =>
  (name === "cd" || name === "pushd") && env.old && dir?.tilde && !dir.unknown && !dir.reads?.length
    ? dir.value[1]
    : undefined

// The one folder a cd names, taken as the shell's own wherever the reader reads it: `Env.cwd`'s own rule, which every hook read before the proven folder arrived and a hook outside `places` reads still.
async function cdTarget(name: string, args: Word[], env: Env): Promise<string | undefined> {
  const dir = args.find((a) => !(a.value.startsWith("-") && a.value.length > 1))
  if (!dir) return homedir()
  const lexical = dir.value === "-" ? undefined : pathOf(dir, env)
  const typed = await folder(
    lexical && physicalCd(args) ? kernelPath(dir, env.cwd, lexical) : lexical,
  )
  // in a hook that follows ~-, a cd's or pushd's unquoted ~- is the folder the shell last left and ~+ the current one, as the shell expands them; beside a folder named ~- or ~+ the typed reading stays, though the shell still expands the word
  const sign = typed ? undefined : tildeSign(name, dir, env)
  const base = sign && (sign === "-" ? env.old?.dir : env.cwd)
  return base ? await folder(base + dir.value.slice(2)) : typed
}

async function folder(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  return isFolder(path) ? path : undefined
}

// Where a cd or pushd may leave the shell: each folder its own words name, whether its target names a folder the reader cannot read at all, and `back` for a form that returns to a folder the line named before, so every one of those is a candidate too. `cd -` and a bare `pushd` are such forms, and so is zsh's two-operand cd, which replaces part of the path the shell is in: its operands go in as candidates, since one of them is the folder a one-operand reading would reach. A bare `pushd` takes the home as well, which zsh's PUSHD_TO_HOME makes it reach.
type Move = { back?: boolean; paths: string[]; unread: boolean }

function cdTargets(name: string, cmd: Command, parsed: Parsed, env: Env, from: string[]): Move {
  const dirs = parsed.args.filter((a) => !(a.value.startsWith("-") && a.value.length > 1))
  const [dir] = dirs
  if (!dir) {
    return name === "cd"
      ? { paths: [homedir()], unread: false }
      : { back: true, paths: [homedir()], unread: true }
  }
  if (dir.value === "-") return { back: true, paths: [], unread: true }
  const paths = new Set<string>()
  const many = manyTimes(cmd, parsed)
  const physical = physicalCd(parsed.args)
  let unread = dirs.length > 1
  for (const typed of dirs.length > 1 ? dirs : [dir]) {
    // a steady variable's value is read in, so its target, and whether it climbs, is the folder it names; the unread reading the cd had stays beside it, so it is never read looser than before
    const word = env.hold?.(typed, cmd, env) ?? typed
    if (word !== typed) unread = true
    for (const base of from.length > 0 ? from : [undefined]) {
      tick()
      const path = pathOf(word, { ...env, cwd: base })
      if (path === undefined) {
        unread = true
        continue
      }
      const landed = physical ? kernelPath(word, base, path) : path
      paths.add(landed)
      // a loop or a count runs the cd again from wherever the last run left it, so a target that climbs reaches every folder above
      if (many && word.value.split("/").includes("..")) {
        for (const up of ancestors(landed)) paths.add(up)
      }
    }
  }
  return { back: dirs.length > 1, paths: [...paths], unread }
}

// Whether a cd or pushd is physical (`cd -P`), changing into the folder a link names before a `..` after it, as the kernel does, where a plain one folds the `..` by text; any -P among its options counts, whatever else is there (`-qP`, `-PL`, `-P -L`), since zsh lands physical for each and a guard fails closed
const physicalCd = (args: Word[]): boolean =>
  args.some((a) => /^-[^-]/.test(a.value) && a.value.includes("P"))

// Where a physical cd from `base` lands on a word it has read as `lexical`, as git's -C lands too: the kernel's path, each link followed, else `lexical` when it is not there
export function kernelPath(word: Word, base: string | undefined, lexical: string): string {
  try {
    return realpathSync.native(isAbsolute(word.value) ? word.value : `${base}/${word.value}`)
  } catch {
    return lexical
  }
}

// In a hook that follows zsh's ~- (`Env.old` set), a cd's or pushd's unquoted ~- returns to a folder the shell was in and ~+ stays in the one it is in; the reader takes every folder `cd -` would go back to, or each one the shell may be in, beside the typed reading and the folder `Env.cwd`'s own reading lands in, so it is never looser than that reading.
function tildeMove(
  move: Move,
  name: string,
  parsed: Parsed,
  env: Env,
  from: string[],
  back: string[],
): Move {
  const dir = parsed.args.find((a) => !(a.value.startsWith("-") && a.value.length > 1))
  const sign = tildeSign(name, dir, env)
  if (!sign || !dir) return move
  const bases = sign === "-" ? back : from
  const paths = [
    ...move.paths,
    ...bases.map((base) => base + dir.value.slice(2)),
    ...(env.cwd === undefined ? [] : [env.cwd]),
  ]
  return {
    back: move.back || sign === "-",
    paths: [...new Set(paths)],
    unread: move.unread || bases.length === 0,
  }
}

// Where a cd, pushd or popd leaves the folder. A cd the shell is sure to run once, into one folder the reader reads, moves it there and clears each folder it may have been in, since the shell is certainly in that one; any other leaves `cwd` unnamed with every folder it may have reached a candidate, so each hook judges the commands after it in all of them. A cd inside a body the shell keeps for a later call moves nothing now, and its folder stays a candidate through every later cd, since the line may call that body at any point.
async function chdirTo(name: string, cmd: Command, parsed: Parsed, env: Env): Promise<void> {
  // `cwd` moves by the reading every hook had before the proven folder arrived, so a hook that reads it alone keeps its verdicts; it is read first, since it resolves a relative target against the folder this cd leaves
  const left = env.cwd
  env.cwd = name === "popd" || cmd.detached ? undefined : await cdTarget(name, parsed.args, env)
  if (env.old) env.old = name === "popd" ? {} : { dir: env.cwd === undefined ? undefined : left }
  // a word's ~- names a folder only after a cd the reader is sure of, set below
  if (env.old) env.oldFrom = []
  const from = startFolders(env)
  const back = [...new Set([...(env.cwdBack ?? []), ...from])]
  // a relative target resolves against each folder a body's cd may have reached too, since a brace group's cd, or a called function's, runs before this one
  const bases = [...new Set([...from, ...(env.cwdHeld ?? [])])]
  const move: Move =
    name === "popd"
      ? { back: true, paths: [], unread: true }
      : tildeMove(cdTargets(name, cmd, parsed, env, bases), name, parsed, env, from, back)
  const { paths, unread } = move
  // the folder `Env.cwd`'s own reading left and the one it lands in join them, so the one folder `Env.old` names is always one a `cd -` or a `pushd ~-` of the reader's may go back to
  const named = [left, env.cwd].filter((dir): dir is string => dir !== undefined)
  env.cwdBack = keep([...new Set([...back, ...paths, ...named])], env)
  if (cmd.held) {
    env.cwdHeld = keep([...new Set([...(env.cwdHeld ?? []), ...paths])], env)
    env.cwdUnread ||= unread
    return
  }
  // a cd an `&&` joins to what follows needs no folder there to read: one into a folder that is not there fails, and then nothing the chain joins after it runs
  const chained = cmd.chained && !negated(cmd)
  if (sureToRun(cmd, parsed) && !unread && paths.length === 1 && (chained || isFolder(paths[0]))) {
    env.cwdSure = paths[0]
    env.cwdMaybe = []
    env.cwdUnread = false
    env.cwdOr = chained ? undefined : { before: from, cdChain: cmd.chain, scope: cmd.scope }
    if (env.old) env.oldFrom = bases
    // the chain holds only to the first command it does not reach, so the folders from before this cd are kept for that one
    if (chained) {
      env.cwdChain = keep([...new Set([...(env.cwdChain ?? []), ...from])], env)
      env.cwdChainToken = cmd.chain
    }
    return
  }
  env.cwdSure = undefined
  env.cwdOr = undefined
  // a while's or an until's condition runs at least once, so a cd there into folders that are there leaves the ones before it behind, and the shell is in one its passes reach
  const behind =
    onceOrMore(cmd, parsed) &&
    !unread &&
    !move.back &&
    paths.length > 0 &&
    (chained || paths.every(isFolder))
  // a form that returns to a folder the line named before takes every one of them, since the reader cannot tell which the shell goes back to
  env.cwdMaybe = keep([...new Set([...(move.back ? back : behind ? [] : from), ...paths])], env)
  env.cwdUnread = env.cwdUnread || unread || (from.length === 0 && paths.length === 0)
}

// Whether a `!` inverts the command's own status, which an `&&` after it reads: a cd negated an odd number of times carries the chain on when it fails, so the commands after it run in the folder the shell never left and the reader keeps that folder a candidate.
const negated = (cmd: Command): boolean =>
  markers(cmd.words).filter((word) => word === "!").length % 2 === 1

// `before` the folders from before the cd, `cdChain` its run's token, `exits` whether the `||`'s run is an exit in the line's own shell, `joined` once a later command joins the cd's run, `landed` the folders the shell was in as the `||`'s run began, `orChain` that run's token, `scope` the cd's own
type CdOr = {
  before: string[]
  cdChain: number | undefined
  exits?: boolean
  joined?: boolean
  landed?: { maybe: string[]; sure?: string }
  orChain?: number
  scope: number
}

// The words that end the line where they run, so a cd's `||` that runs one leaves the commands after it where the cd landed; a top-level `return` is not one, since bash -c fails it and carries on
const EXITS = new Set(["exit"])

// What an `||` after a sure cd's run runs may run where the cd failed, so it and its own run, a subshell, a substitution or a script it holds included, are judged in the folders from before the cd too, beside where the shell was. The commands after that run keep both when the `||` follows the cd itself (`cd <path> || echo no; git commit`), and return to the folder the cd named when the `||` follows a later command of the cd's run, or what it runs is an exit in the line's own shell, which ends the line where the cd failed; one in a subshell or a pipeline ends that alone.
function orElse(cmd: Command, env: Env): void {
  const or = env.cwdOr
  if (!or) return
  if (cmd.chain === or.orChain) {
    // a pipeline stage or a background runs in a subshell, a brace group's `}` among them, so an exit in that run ends that alone
    if (or.exits && cmd.detached) env.cwdOr = { ...or, exits: false }
    return
  }
  if (cmd.chain === or.cdChain) {
    if (!or.joined) env.cwdOr = { ...or, joined: true }
    return
  }
  if (or.orChain === undefined && cmd.orRun) {
    env.cwdOr = {
      ...or,
      exits: EXITS.has(parse(cmd).name) && !cmd.detached && cmd.scope === or.scope,
      landed: { maybe: env.cwdMaybe ?? [], sure: env.cwdSure },
      orChain: cmd.chain,
    }
    env.cwdMaybe = keep([...new Set([...startFolders(env), ...or.before])], env)
    env.cwdSure = undefined
    return
  }
  if ((or.joined || or.exits) && or.landed) {
    env.cwdMaybe = or.landed.maybe
    env.cwdSure = or.landed.sure
  }
  env.cwdOr = undefined
}

// A cd an `&&` alone made sure holds for its own run of commands alone: any other command runs whether or not that cd did, so the folders from before it are the shell's again beside the one it named. A command keeps the folder only by proof, its own token matching the cd's, which every operator that frees a command takes away and no group, body, pipeline or script grants.
function unchain(cmd: Command, env: Env): void {
  if (!env.cwdChain?.length || cmd.chain === env.cwdChainToken) return
  env.cwdMaybe = keep(
    [...new Set([...(env.cwdMaybe ?? []), ...(env.cwdSure ? [env.cwdSure] : []), ...env.cwdChain])],
    env,
  )
  env.cwdSure = undefined
  // the chain's cd may not have run, so the folder a ~- names is no longer one the reader is sure of
  if (env.old) env.oldFrom = []
  env.cwdChain = []
  env.cwdChainToken = undefined
}

// At most this many folders are carried for one line, since each hook judges every command in all of them.
const MAX_FOLDERS = 32

// The folders kept, and `Env.cwdAnywhere` set once a line names more than that: dropping a folder would let a line name a guarded one past the cap and run there, so past it the shell reads as able to be in any folder, and each hook refuses the command it guards. It stays set for the rest of the line, since a folder the reader dropped stays one the shell may be in.
function keep(folders: string[], env: Env): string[] {
  if (folders.length <= MAX_FOLDERS) return folders
  env.cwdAnywhere = true
  env.cwdSure = undefined
  env.cwdUnread = true
  return folders.slice(0, MAX_FOLDERS)
}

export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// A shell's options that take the next word as their value; -O and +O take one in bash and sh alone, since zsh's take none.
const SHELL_TAKES = new Set(["-o", "+o", "--init-file", "--rcfile"])
const BASH_TAKES = new Set([...SHELL_TAKES, "-O", "+O"])

// A shell's first operand, and whether -c makes it the script's text rather than a script file's name; no operand means the shell reads its script from stdin.
export function shellOperand(args: Word[], shell: string): { inline: boolean; operand?: Word } {
  const takes = shell === "bash" || shell === "sh" ? BASH_TAKES : SHELL_TAKES
  let inline = false
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (takes.has(v)) k++
    else if (/^[-+][A-Za-z]+$/.test(v)) inline ||= v.startsWith("-") && v.includes("c")
    else if (!v.startsWith("--")) return { inline, operand: args[k] }
  }
  return { inline }
}

async function shell(
  name: string,
  args: Word[],
  cmd: Command,
  env: Env,
  visit: Visit,
  builtins: boolean,
  xargs?: Xargs,
): Promise<string | undefined> {
  const slot = shellSlot(args, name)
  if (slot) return examine({ ...cmd, words: slot }, env, visit, builtins)
  const { inline, operand } = shellOperand(args, name)
  if (operand && inline) {
    let script = operand.value
    if (xargs?.replace && script.includes(xargs.replace)) {
      const fed = await stdinOf(cmd, env)
      script = filled(script, xargs.replace, fed.unknown ? UNKNOWN : fed.value.trim())
    }
    return run(lexScript(script, env), subshell(env), visit, builtins)
  }
  for (const script of await scriptOf(operand, cmd, env)) {
    const text = known(script)
    const verdict = await run(lexScript(text, env), subshell(env), visit, builtins)
    if (verdict) return verdict
  }
}

// A script's parts the hook can read, each part it cannot read (a `curl`'s output in a group) taken as a line break, so the rest is still walked.
export const known = (script: Text): string => script.value.replaceAll(UNKNOWN, "\n")

// A shell's or source's scripts: stdin's readings with no operand or stdin's name (`-`, `/dev/stdin`, `/dev/fd/0`), a process substitution's output, else unknown; a walk with a budget throws on one too large to hold.
async function scriptOf(operand: Word | undefined, cmd: Command, env: Env): Promise<Text[]> {
  const scripts =
    !operand || STDIN_PATHS.has(operand.value)
      ? await scriptStdin(cmd, env)
      : [operand.procs ? await outputs(operand.procs, env) : unknown("a script file")]
  if (deadlines.getStore() !== undefined && scripts.some((s) => s.unknown === LARGE))
    throw new RangeError(LARGE)
  return scripts
}

// The output of a list of commands run in order, unknown when any part is.
async function outputs(cmds: Command[], env: Env): Promise<Text> {
  return join(await Promise.all(cmds.map((c) => outputOf(c, env))))
}

async function record(cmd: Command, name: string, args: Word[], env: Env): Promise<void> {
  for (const r of cmd.redirects) {
    if (r.op !== ">" && r.op !== ">>" && r.op !== ">|") continue
    const path = r.target && pathOf(r.target, env)
    if (!path) continue
    const stdout = r.fd === "" || r.fd === "1" || r.fd === "&"
    const out = stdout
      ? await outputOf(cmd, env)
      : unknown(`what ${name || "a command"} writes to stderr`)
    env.files.set(path, held(r.op === ">>" ? join([await existing(path, env), out]) : out))
  }
  if (name !== "tee") return
  const input = await stdinOf(cmd, env)
  const append = args.some((a) => a.value === "-a" || a.value === "--append")
  for (const a of args) {
    const path = a.value.startsWith("-") ? undefined : pathOf(a, env)
    if (path) env.files.set(path, held(append ? join([await existing(path, env), input]) : input))
  }
}

async function existing(path: string, env: Env): Promise<Text> {
  return env.files.get(path) ?? (await readFile(path)) ?? { value: "" }
}

async function outputOf(cmd: Command, env: Env): Promise<Text> {
  tick()
  const { args, name } = parse(cmd)
  if (name === "") {
    if (cmd.inner) return outputs(cmd.inner(), env)
    return cmd.group || cmd.words.some((w) => GROUPING.has(w.value) && !w.quoted)
      ? unknown("the output of a command group")
      : { value: "" }
  }
  if (name === "cat") {
    const sources = args.filter((a) => a.value === "-" || !a.value.startsWith("-"))
    if (sources.length === 0) return stdinOf(cmd, env)
    // the first `-` reads all of stdin, so a later one reads nothing; the sources are read in turn until their text outgrows what the hook holds
    const first = sources.findIndex((s) => s.value === "-")
    const parts: Text[] = []
    let size = 0
    for (const [k, s] of sources.entries()) {
      tick()
      const part =
        s.value !== "-"
          ? await readPath(s, env)
          : k === first
            ? await stdinOf(cmd, env)
            : { value: "" }
      size += part.value.length
      if (size > MAX_BYTES) return unknown(LARGE)
      parts.push(part)
    }
    return join(parts)
  }
  if (name === "tee") return stdinOf(cmd, env)
  if (!PRINTERS.has(name)) return unknown(`the output of ${name}`)
  const values = await Promise.all(args.map((a) => resolveText(a, env)))
  const hidden = values.find((v) => v.unknown)
  if (hidden) return hidden
  if (name === "printf") return { value: printf(values.map((v) => v.value)) }
  let k = 0
  while (k < values.length && /^-[neE]+$/.test(values[k].value)) k++
  return {
    value: `${values
      .slice(k)
      .map((v) => decode(v.value))
      .join(" ")}\n`,
  }
}

// printf reuses its format while arguments remain; a pass that takes none ends it.
function printf([format = "", ...args]: string[]): string {
  const conversion = /%(?:%|[-+ #0']*(?:[1-9]\d*)?(?:\.\d+)?([a-zA-Z]))/g
  const pattern = decode(format)
  let out = ""
  let k = 0
  for (;;) {
    tick()
    const before = k
    out += pattern.replace(conversion, (_, kind?: string) => {
      if (!kind) return "%"
      const value = args[k++] ?? ""
      return kind === "b" ? decode(value) : value
    })
    if (k === before || k >= args.length) return out
  }
}

// A command's stdin as every hook reads it: the last file, here-string, heredoc or process substitution on fd 0 of its own, else its pipe, else unknown; a duplicated descriptor, a compound command's redirect, a here-string's echo or one variable the line set stay unknown here, so a hook that refuses stdin it cannot read keeps that refusal
export async function stdinOf(cmd: Command, env: Env): Promise<Text> {
  tick()
  const input = cmd.redirects.findLast((r) => !r.bodyFed && ownFeed(r))
  if (!input)
    return held(cmd.stdin ? await outputOf(cmd.stdin, env) : unknown("stdin the hook cannot see"))
  return held(await redirectText(input, env, false))
}

// The scripts a shell may read from stdin: stdinOf's reading and, where it differs, the shell's own (stdinText), each judged as a script of its own, so a delete either reading finds is judged and a cd in one moves no folder for the other
export async function scriptStdin(cmd: Command, env: Env): Promise<Text[]> {
  const own = await stdinOf(cmd, env)
  tick()
  const fed = held(await stdinText(cmd, env))
  return fed.value === own.value && fed.unknown === own.unknown ? [own] : [own, fed]
}

const ownFeed = ({ fd, op }: Redirect): boolean =>
  (fd === "" || fd === "0") && op.startsWith("<") && op !== "<&"

// The redirect whose text reaches a command's stdin, its input redirects applied left to right as the shell applies them: a file, a here-string, a heredoc or a process substitution on fd 0, or through a duplicate onto fd 0 (`<&N`, `0>&N`, the move `<&N-`) the one that last fed descriptor N (`3<<< x <&3`), none after a `<&-` or a descriptor it cannot read
function stdinRedirect(cmd: Command): Redirect | undefined {
  const fed = new Map<string, Redirect | undefined>()
  for (const r of cmd.redirects) {
    const dup = r.op === "<&" || dupOnto0(r)
    if (!r.op.startsWith("<") && !dup) continue
    const from = (r.target?.value ?? "").replace(/^(\d+)-$/, "$1")
    fed.set(fdOf(r), dup ? (/^\d+$/.test(from) ? fed.get(from) : undefined) : r)
  }
  return fed.get("0")
}

const fdOf = (r: Redirect): string => (r.fd === "" ? (r.op.startsWith(">") ? "1" : "0") : r.fd)

// `0>&N` duplicates N onto stdin, as `<&N` does
const dupOnto0 = (r: Redirect): boolean => r.op === ">&" && r.fd === "0"

// Whether a command's stdin is a redirect, by stdinOf's reading or stdinRedirect's
export const stdinFed = (cmd: Command): boolean =>
  stdinRedirect(cmd) !== undefined || cmd.redirects.some(ownFeed)

// Whether a redirect feeds a root shell its script (`sudo -s <<< …`, `su < <(…)`), which run() hands every hook and leaves each to read
export const rootFed = (cmd: Command): boolean => stdinFed(cmd) && stdinShell(cmd) === "root"

async function stdinText(cmd: Command, env: Env): Promise<Text> {
  const input = stdinRedirect(cmd)
  if (!input) return cmd.stdin ? outputOf(cmd.stdin, env) : unknown("stdin the hook cannot see")
  return redirectText(input, env, true)
}

// stdin's text from one redirect; the shell's own reading (`shells`) also reads a here-string's `$(echo …)` and a here-string of one variable the line set, which stdinOf leaves unknown as canary did
async function redirectText(input: Redirect, env: Env, shells: boolean): Promise<Text> {
  if (input.target?.procs) return outputs(input.target.procs, env)
  if (input.op === "<" || input.op === "<>")
    return input.target ? readPath(input.target, env) : unknown("an input redirect")
  if (!input.body) return unknown("a heredoc the hook could not read")
  // a here-string of one variable the line set earlier (`S=x; sh <<< "$S"`) is that variable's value
  const set = shells && input.body.variable ? env.vars.get(input.body.variable) : undefined
  if (input.body.unknown && input.body.value === `${UNKNOWN}\n` && set && !set.unknown)
    return resolveText({ ...set, value: `${set.value}\n` }, env)
  return resolveText((shells && hereStringEchoed(input, env)) || input.body, env)
}

// A here-string's text with each `$(echo …)` read as its words, lexed again from its source, when its own text holds a part it cannot read
function hereStringEchoed(input: Redirect, env: Env): Text | undefined {
  const source = input.target?.source
  if (input.op !== "<<<" || !input.body?.unknown || !source?.includes("$(")) return undefined
  echoes = true
  try {
    // a substitution's commands lex ahead of the one that holds it, so the here-string is the last command's
    const outer = lex(`: <<< ${source}`, env.known).commands.at(-1)
    return outer?.redirects.find((r) => r.op === "<<<")?.body
  } finally {
    echoes = false
  }
}

export async function resolveText(text: Text, env: Env): Promise<Text> {
  if (text.unknown || !text.reads?.length) return text
  // each read fills the next READ mark in turn; splitting once keeps the cost to the text's length
  const pieces = text.value.split(READ)
  let value = pieces[0]
  for (const [k, path] of text.reads.entries()) {
    tick()
    const file = await readPath(path, env)
    if (file.unknown) return file
    if (k + 1 < pieces.length) value += file.value + pieces[k + 1]
    if (value.length > MAX_BYTES) return unknown(LARGE)
  }
  for (const piece of pieces.slice(text.reads.length + 1)) value += READ + piece
  return { value }
}

export function pathOf(text: Text, env: Env): string | undefined {
  if (text.unknown || text.reads?.length || text.value === "") return undefined
  if (isAbsolute(text.value)) return text.value
  return env.cwd ? resolve(env.cwd, text.value) : undefined
}

// Reads a regular file of at most MAX_BYTES; undefined when there is no file at the path.
async function readFile(path: string): Promise<Text | undefined> {
  const file = Bun.file(path)
  try {
    const stats = await file.stat()
    if (!stats.isFile()) return unknown(`${path}, which is not a regular file`)
    if (stats.size > MAX_BYTES) return unknown(`${path}, which is too large to read`)
    return { value: await file.text() }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined
    return unknown(`${path}, which the hook cannot read`)
  }
}

export async function readPath(path: Text, env: Env): Promise<Text> {
  const resolved = pathOf(path, env)
  if (!resolved && path.unknown)
    return unknown(
      `a file path built from ${path.unknown}, which the hook cannot expand: name the file by its literal absolute path`,
    )
  if (!resolved) return unknown("a file path the hook cannot resolve")
  return (
    env.files.get(resolved) ??
    (await readFile(resolved)) ??
    unknown(`${resolved}, which does not exist yet`)
  )
}

export function parseFlags(
  args: Word[],
  takes: Set<string>,
): { flags: Flag[]; positionals: Word[] } {
  const flags: Flag[] = []
  const positionals: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    const v = w.value
    if (v === "--") {
      positionals.push(...args.slice(k + 1))
      break
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=")
      const name = eq === -1 ? v : v.slice(0, eq)
      flags.push({
        name,
        value: eq !== -1 ? slice(w, eq + 1) : takes.has(name) ? args[++k] : undefined,
      })
    } else if (v.startsWith("-") && v.length > 1) {
      for (let c = 1; c < v.length; c++) {
        const name = `-${v[c]}`
        if (!takes.has(name)) {
          flags.push({ name })
          continue
        }
        const rest = c + 1 < v.length ? slice(w, v[c + 1] === "=" ? c + 2 : c + 1) : args[++k]
        flags.push({ name, value: rest })
        break
      }
    } else positionals.push(w)
  }
  return { flags, positionals }
}

export const unreadable = (text: Text): boolean =>
  Boolean(text.unknown) || Boolean(text.reads?.length) || marked(text.value)

export const fromXargs = (text: Text, xargs: Xargs): boolean =>
  Boolean(xargs?.replace) && text.value.includes(xargs?.replace ?? "")

// An argument that starts with xargs' -I string, or is a flag holding it (`-{}`, `--{}`), can become any flag.
export const flagFromXargs = (text: Text, xargs: Xargs): boolean =>
  fromXargs(text, xargs) &&
  (text.value.startsWith(xargs?.replace ?? "") || text.value.startsWith("-"))

// A text holding xargs' -I string is filled in from stdin, so the hook cannot read it.
export function viaXargs(text: Text, xargs: Xargs): Text {
  return fromXargs(text, xargs) ? unknown(`what xargs puts in place of ${xargs?.replace}`) : text
}

// gh's subcommand words (`pr comment`, or `api` alone), the repositories its -R flags name, and the arguments after the subcommand.
export function ghCommand(args: Word[]): { head: string[]; repos: Word[]; rest: Word[] } {
  const repos: Word[] = []
  const head: string[] = []
  let k = 0
  while (k < args.length && head.length < (head[0] === "api" ? 1 : 2)) {
    const v = args[k].value
    if (v === "-R" || v === "--repo") {
      if (args[k + 1]) repos.push(args[k + 1])
      k += 2
    } else if (v.startsWith("--repo=")) repos.push(slice(args[k++], 7))
    else if (v.startsWith("-R")) repos.push(slice(args[k++], 2))
    else if (v.startsWith("-")) k++
    else head.push(args[k++].value)
  }
  return { head, repos, rest: args.slice(k) }
}

// What `gh api` sends: its endpoint, its -f/-F fields (a file's text for `@file`), its --input and its method; undefined with no endpoint.
export async function ghApi(
  args: Word[],
  cmd: Command,
  env: Env,
  xargs: Xargs,
): Promise<ApiRequest | undefined> {
  const { flags, positionals } = parseFlags(args, API_TAKES)
  const [endpoint] = positionals
  if (!endpoint) return
  const fields: Field[] = []
  const inputs: Text[] = []
  let method: string | undefined
  for (const { name, value } of flags) {
    if (!value) continue
    if (name === "-X" || name === "--method")
      method = value.unknown ? "POST" : value.value.toUpperCase()
    else if (name === "--input")
      inputs.push(value.value === "-" ? await stdinOf(cmd, env) : await readPath(value, env))
    else if (API_FIELDS.has(name)) {
      const eq = value.value.indexOf("=")
      const key = eq === -1 ? value.value : value.value.slice(0, eq)
      const field = eq === -1 ? { quoted: false, value: "" } : slice(value, eq + 1)
      const fromFile =
        (name === "-F" || name === "--field") && field.value.startsWith("@") && !field.unknown
      const text = !fromFile
        ? field
        : field.value === "@-"
          ? await stdinOf(cmd, env)
          : await readPath(slice(field, 1), env)
      fields.push(
        fromXargs(value, xargs) ? { key: "body", text: viaXargs(value, xargs) } : { key, text },
      )
    }
  }
  if (xargs && !xargs.replace) {
    fields.push({
      key: "body",
      text: unknown("the arguments xargs appends; a read passes with -X GET"),
    })
  }
  if (args.some((a) => flagFromXargs(a, xargs))) {
    fields.push({ key: "body", text: unknown(`what xargs puts in place of ${xargs?.replace}`) })
  }
  const sent = fields.length + inputs.length > 0
  return { endpoint, fields, inputs, method: method ?? (sent ? "POST" : "GET") }
}

export const curlUrls = (flags: Flag[], positionals: Word[]): Word[] => [
  ...positionals,
  ...flags.filter((f) => f.name === "--url" && f.value).map((f) => f.value as Word),
]

// What curl sends: each data, form or upload flag's text, a file's text for `@file` and stdin's for `@-`.
export async function curlData(flags: Flag[], cmd: Command, env: Env): Promise<Text[]> {
  const data: Text[] = []
  for (const { name, value } of flags) {
    if (!value || !CURL_DATA.has(name)) continue
    if (name === "-T" || name === "--upload-file") data.push(await readPath(value, env))
    else if (value.value.startsWith("@") && name !== "--data-raw" && name !== "--form-string") {
      data.push(
        value.value === "@-" ? await stdinOf(cmd, env) : await readPath(slice(value, 1), env),
      )
    } else data.push(value)
  }
  return data
}

// HOME and TMPDIR resolve in paths, and PWD while the command never changes directory, unless the command assigns them itself.
export function knownVariables(
  command: string,
  environment: Record<string, string | undefined>,
  cwd: string | undefined,
): Record<string, string> {
  const values: Record<string, string | undefined> = {
    HOME: environment.HOME,
    PWD: /\b(?:cd|popd|pushd)\b/.test(command) ? undefined : cwd,
    TMPDIR: environment.TMPDIR,
  }
  const known: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value && !command.includes(`${name}=`)) known[name] = value
  }
  return known
}
