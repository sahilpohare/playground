// The Bash reader the PreToolUse hooks share: it lexes a command and walks it as the shell would run it, reading the heredocs, files and substitutions it can see and marking the rest unknown.
import { AsyncLocalStorage } from "node:async_hooks"
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
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
  vanishes?: boolean
  variable?: string
}
// `vanishes` marks a variable a builtin or a loop's later pass may have changed (`change`, `repass`), whose value may be no word.
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
  // Set on every command of a brace group a pipe feeds (`echo x | { true; xargs touch; }`), past its first, which stdin holds: the command whose output the group reads, which a later command reads too once the ones before it leave it
  braceFed?: Command
  // Set on a case statement's pattern (casePatterns), which the shell matches and never runs, so its words name no program
  casePattern?: boolean
  // Set on every command of a line that defines a function named cd or chpwd, or holds a word that, its quotes and backslashes removed, starts with chpwd (`chpwd_functions=(f)`, `chp""wd_functions`, `add-zsh-hook chpwd f`), so each cd there is unread
  cdRedefined?: boolean
  // The token of the run of commands this one belongs to: it changes at each operator that runs a command whatever the one before it did (a `;`, a newline, an `&`, an `||`), and carries into every group, body and pipeline the run reaches, so a cd is read as having moved the shell only for the commands whose token is its own
  chain?: number
  // Set when the command runs only if the one before it succeeded (it sits on the right of an `&&`), so a cd of its own has certainly run for every command the same chain joins after it
  chained?: boolean
  detached?: boolean
  // Set when the command's output feeds a shell that reads its script from stdin, so the walk visits it even with no program of its own (a loop's `done`), and a hook judges the pipe there
  feedsShell?: boolean
  // the operator that ended the command before it in its scope (`;`, `&&`, `||`, `|`, `&`, `)` or `;;`), none for a scope's first
  follows?: string
  // Set on a wrapper whose program word is a paren globOpens opens: the words and redirects zsh's glob reading gives the command, which run() judges at the wrapper's turn beside the subshell reading the command list keeps, so a hook that reads the command list itself reads the line as it did without the glob reading
  glob?: Pick<Command, "detached" | "redirects" | "words">
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
  // Set when the shell's folder was unread before that cd, so it is unread again there
  cwdChainUnread?: boolean
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
  // Set by a hook that holds the line's steady variables (`steady.ts`): a cd's folder word with those it reads put in, else undefined, so a cd through one is read by the folder it names, and one through a literal absolute path (`landsHeld`) is read as a cd to that path
  hold?: (word: Word, cmd: Command, env: Env) => Word | undefined
  known: Record<string, string>
  // How many times the whole line names each name, a whole array run as a program word aside (`namings`), so `arrayRun` reads an array only where its one assignment names it
  namings?: Map<string, number>
  old?: { dir?: string }
  // In a hook that follows ~-, each folder the shell may have left at its last cd, which a word's ~- names; `pathOf` reads ~- only when this holds one folder, and before any cd it is `old.dir` alone
  oldFrom?: string[]
  process: Record<string, string | undefined>
  // Set on the line ssh runs on the remote side, read from the login's home (`remoteEnv`), where a hook may read a glob by the names it can match there rather than as any code it fails closed on
  remote?: boolean
  // Set on a remote line that is not fully static, whose shell may turn dot matching on by a name the hook cannot read, so a glob there may match a dot-led name
  remoteDots?: boolean
  // The glob-option switch a remote line or the script a remote shell reads holds (globSwitch), which no-extensions-write refuses rather than reads
  remoteSwitch?: string
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
// A redirect's operator, bash's and zsh's, the lexer's REDIRECT and optionSwitch's OPTION_REDIRECT alike
const REDIRECT_OP = "(<<<|<<-|<<|<>|<&|>&!?|>>[!|]?|>[!|]|<|>)"
const REDIRECT = new RegExp(`^(\\d*|&)${REDIRECT_OP}`)
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
// The words that open zsh's `repeat N` body: a `do` up to its `done`, or a brace up to its own
const REPEAT_BODY = new Set(["do", "{"])
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
    } else if (
      w.value === "repeat" &&
      REPEAT_BODY.has(words[k + 2]?.value ?? "") &&
      !words[k + 2].quoted
    ) {
      // zsh's `repeat N do … done` and `repeat N { … }` are loops: the count is skipped so the do or the brace opens the body
      k += 2
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
    "-": ["", ""],
    builtin: ["", ""],
    busybox: ["", ""],
    caffeinate: ["-d -i -m -s -u", "-t -w"],
    chrt: [
      "-a -b -d -e -f -i -m -o -p -R -r -v --all-tasks --batch --deadline --ext --fifo --idle --max --other --pid --reset-on-fork --rr --verbose",
      "-D -P -T --sched-deadline --sched-period --sched-runtime",
    ],
    command: ["-p -V -v", ""],
    doas: ["-L -n -s", "-a -C -u"],
    env: ["-0 -i -v --debug --ignore-environment --null", "-P -S -u --unset"],
    exec: ["-c -l", "-a"],
    flock: [
      "-F -n -o -s -u -x --close --exclusive --fcntl --nb --no-fork --nonblocking --shared --unlock --verbose",
      "-E -w --conflict-exit-code --length --start --timeout --wait",
    ],
    ionice: ["-t --ignore", "-c -n -P -p -u --class --classdata --pgid --pid --uid"],
    nice: ["", "-n --adjustment"],
    nocorrect: ["", ""],
    noglob: ["", ""],
    nohup: ["", ""],
    pkexec: ["--disable-internal-agent --help --keep-cwd --version", "--user"],
    repeat: ["", ""],
    setsid: ["-c -f -w --ctty --fork --wait", ""],
    stdbuf: ["", "-e -i -o --error --input --output"],
    sudo: [
      "-A -B -b -E -e -H -i -K -k -l -N -n -P -S -s -V -v --askpass --background --bell --edit --help --list --login --non-interactive --preserve-env --preserve-groups --remove-timestamp --reset-timestamp --set-home --shell --stdin --validate --version",
      "-C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user",
    ],
    taskset: ["-a -c -p --all-tasks --cpu-list --pid", ""],
    time: [
      "-a -h -l -p -q -V -v --append --portability --quiet --verbose",
      "-f -o --format --output",
    ],
    timeout: ["-f -p -v --foreground --preserve-status --verbose", "-k -s --kill-after --signal"],
    xargs: [
      "-0 -o -p -r -t -x --exit --interactive --max-lines --no-run-if-empty --null --open-tty --show-limits --verbose",
      "-a -d -E -L -n -P -R -S -s --arg-file --delimiter --max-args --max-chars --max-procs --process-slot-var",
    ],
  }).map(([name, [flags, values]]) => [
    name,
    { flags: new Set(flags.split(" ")), values: new Set(values.split(" ")) },
  ]),
)

// A package runner's options before its program, as a wrapper's are, with those whose value is a shell script it runs (`script`), the flags that run its words joined as one script (`joined`, true for a runner that always does), whether its program word is a package name a version may follow (`spec`), whether tool names sit before a `--` and the program (`tools`), and the options naming the folder it runs its program in (`folder`, `bunx --cwd`, `pnpm -C`), which move the program's reading as env -C does
type Runner = Options & {
  folder: Set<string>
  joined: Set<string> | true
  script: Set<string>
  spec: boolean
  tools: boolean
}
const runner = (
  flags: string,
  values: string,
  more: {
    always?: true
    folder?: string
    joined?: string
    script?: string
    spec?: true
    tools?: true
  } = {},
): Runner => ({
  flags: new Set(flags.split(" ")),
  folder: new Set(more.folder?.split(" ")),
  joined: more.always ?? new Set(more.joined?.split(" ")),
  script: new Set(more.script?.split(" ")),
  spec: !!more.spec,
  tools: !!more.tools,
  values: new Set(values.split(" ")),
})
// Each runner's options, measured from its --help (npm 11.20, bun 1.4.4, pnpm 12.21) or, for one not installed here, from its docs: yarnpkg.com/cli/dlx, /cli/exec, /cli/workspace and /cli/workspaces/foreach, mise.jdx.dev/cli/exec, docs.volta.sh/reference/run, docs.deno.com's run reference, github.com/nodejs/corepack; an option missing here is read both ways, as a wrapper's is
const NPM = runner(
  "-y --dangerously-allow-all-scripts --include-workspace-root --no --strict-allow-scripts --workspaces --yes",
  "-c -w --allow-scripts --call --package --workspace",
  { script: "-c --call", spec: true },
)
const BUNX = runner(
  "--bun --ignore-scripts --no-install --silent --trust --verbose",
  "-p --ca --cafile --cwd --env-file --minimum-release-age --package --registry",
  { folder: "--cwd", spec: true },
)
const PNPM_FLAGS =
  "-c -r -w -y --aggregate-output --color --fail-if-no-match --ignore-workspace --include-workspace-root --no-fail-if-no-match --no-include-workspace-root --no-progress --no-sort --parallel --recursive --reverse --shell-mode --sort --stream --use-stderr --workspace-root --yes"
const PNPM_VALUES =
  "-C -F --changed-files-ignore-pattern --dir --env-file --filter --filter-prod --http-proxy --https-proxy --loglevel --no-proxy --npmrc-auth-file --registry --reporter --state-dir --store-dir --test-pattern --userconfig --workspace-concurrency --workspace-packages"
const PNPM_DLX = runner(
  `${PNPM_FLAGS} -v --version`,
  `${PNPM_VALUES} --allow-build --cpu --libc --os --package`,
  { folder: "-C --dir", joined: "-c --shell-mode", spec: true },
)
const MISE = runner(
  "--deny-all --deny-env --deny-net --deny-read --deny-unix --deny-write --fresh-env --no-deps --raw --secrets-all",
  "-c -j --allow-env --allow-net --allow-read --allow-unix --allow-write --command --jobs --secrets",
  { script: "-c --command", tools: true },
)
const BUN_FLAGS =
  "-b -i --bun --check --hot --if-present --no-clear-screen --no-exit-on-error --no-install --no-orphans --parallel --sequential --silent --smol --watch --workspaces"
const BUN_VALUES =
  "-e -F -p -r --cwd --elide-lines --env-file --eval --filter --import --preload --print --require --shell"
const DENO = runner(
  "-A -q -r --allow-all --allow-env --allow-ffi --allow-import --allow-net --allow-read --allow-run --allow-scripts --allow-sys --allow-write --cached-only --check --coverage --deny-env --deny-ffi --deny-import --deny-net --deny-read --deny-run --deny-sys --deny-write --env-file --frozen --hmr --inspect --inspect-brk --inspect-wait --lock --no-check --no-clear-screen --no-code-cache --no-config --no-lock --no-npm --no-remote --node-modules-dir --quiet --reload --unsafely-ignore-certificate-errors --unstable --use-env-proxy --v8-flags --vendor --watch",
  "-c --cert --conditions --config --ext --import-map --location --min-dep-age --node-modules-linker --preload --require --seed --watch-exclude",
  { spec: true },
)
export const RUNNERS = new Map<string, Runner>([
  ["bun exec", runner(BUN_FLAGS, BUN_VALUES, { always: true, folder: "--cwd" })],
  ["bun run", runner(BUN_FLAGS, BUN_VALUES, { folder: "--cwd" })],
  ["bun x", BUNX],
  ["bunx", BUNX],
  ["corepack", runner("", "", { spec: true })],
  ["deno run", DENO],
  ["deno x", DENO],
  ["mise exec", MISE],
  ["mise x", MISE],
  ["npm exec", NPM],
  ["npm x", NPM],
  ["npx", NPM],
  ["pnpm dlx", PNPM_DLX],
  ["pnpm exec", runner(PNPM_FLAGS, PNPM_VALUES, { folder: "-C --dir", joined: "-c --shell-mode" })],
  ["pnpx", PNPM_DLX],
  ["volta run", runner("--bundled-npm --no-yarn --quiet --verbose", "--env --node --npm --yarn")],
  ["yarn dlx", runner("-q --quiet", "-p --package", { spec: true })],
  ["yarn exec", runner("", "", { always: true })],
])
// The package managers whose subcommand names a runner, each with the runner whose options it reads before that subcommand (`pnpm -r exec`, `npm -w app exec`)
const MANAGERS = new Map([
  ["bun", "bun run"],
  ["deno", "deno run"],
  ["mise", "mise exec"],
  ["npm", "npm exec"],
  ["pnpm", "pnpm exec"],
  ["volta", "volta run"],
  ["yarn", "yarn dlx"],
])
// A manager's scoping words, read past before its runner's subcommand (`yarn workspace app exec`, `yarn workspaces foreach -A exec`), with the names that follow them and their own options
const SCOPES = new Map<string, { names: number; options: Options }>([
  ["yarn workspace", { names: 1, options: { flags: new Set(), values: new Set() } }],
  [
    "yarn workspaces foreach",
    {
      names: 0,
      options: {
        flags: new Set(
          "-A -i -n -p -R -t -v -W --all --dry-run --interlaced --no-private --parallel --recursive --topological --topological-dev --verbose --worktree".split(
            " ",
          ),
        ),
        values: new Set("-j --exclude --from --include --jobs".split(" ")),
      },
    },
  ],
])
// pnpm 12.21's own commands and their aliases (`pnpm help --all`); pnpm runs any other name as `pnpm exec` runs it, a script of that name first
const PNPM_COMMANDS = new Set(
  "access add adduser approve approve-builds audit bin bugs c cache cat-file cat-index change ci clean clean-install completion config create dedupe deploy deprecate dislink dist-tag dist-tags dlx docs doctor edit env exec fetch find find-hash fund get help home i ic ignored-builds import info init install install-clean install-test issues it la lane licences licenses link list ll ln login logout ls m multi outdated owner owners pack pack-app patch patch-commit patch-remove peers permissions ping pipeline pkg prefix profile prune publish purge rb rebuild recursive remove repo restart rm root rt run run-script runtime s sbom se search self-update set set-script setup shim show ss stage star stars start stop store t tasks team test token tst un undeprecate uni uninstall unlink unpublish unstar up update upgrade v version view whoami why with xmas".split(
    " ",
  ),
)

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

// The commands of a line that are a case statement's patterns, which the shell matches and never runs: the run of piped alternatives a ) ends, after the opener's `in` or a `;;`, with no redirect of its own; `scoped` reads past the commands of a substitution in the body's words (`*) echo "$(date)"`), which the lexer lists before the body
export function casePatterns(all: Command[], scoped = false): Set<Command> {
  const out = new Set<Command>()
  for (let k = 0; k < all.length; k++) {
    if (!caseOpener(all[k]) && all[k].follows !== ";;") continue
    const commands = scoped ? all.slice(k).filter((c) => c.scope === all[k].scope) : all.slice(k)
    let end = 0
    while (commands[end + 1]?.follows === "|") end++
    const body = commands[end + 1]
    const run = commands.slice(0, end + 1)
    if (body?.follows !== ")" || run.some((c) => c.redirects.length > 0 || c.scope !== body.scope))
      continue
    for (const c of run) out.add(c)
  }
  return out
}

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

// ssh's flags and its options that take a value (OpenSSH's getopt string), and the -o keywords whose value ssh runs as a command line: on this machine through the user's shell (`local`), or on the remote side in place of a command
const SSH_FLAGS = "46AaCfGgKkMNnqsTtVvXxYy"
const SSH_VALUES = "BbcDEeFIiJLlmOoPpQRSWw"
const SSH_LOCAL = new Set(["knownhostscommand", "localcommand", "proxycommand"])
export type Ssh = {
  // each SetEnv and SendEnv value, a variable the remote shell starts with
  env: Word[]
  host?: Word
  // each ProxyCommand, LocalCommand and KnownHostsCommand value, which ssh runs here; a -o the hook cannot read is one too
  local: Word[]
  // -n: the remote side reads /dev/null in place of stdin
  noStdin: boolean
  // the command line the remote shell runs: the words after the host, which ssh joins with blanks, else a RemoteCommand's value
  remote: Word[]
  // an option off ssh's lists, or a host the hook cannot read, which may be an option, so the remote side may be any command; a remote line's own unread program is read by lexing it
  unread: boolean
}
// An ssh call read as OpenSSH reads its words: options before the host and again after it, until a `--` or the first other word, which starts the remote command; undefined for a program other than ssh
export function sshCall({ args, first }: Pick<Parsed, "args" | "first">): Ssh | undefined {
  if (program(first?.value ?? "") !== "ssh") return
  const call: Ssh = { env: [], local: [], noStdin: false, remote: [], unread: false }
  let remoteCommand: Word | undefined
  const option = (word: Word) => {
    const m = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)([\s\S]*)$/.exec(word.value)
    const key = m?.[1]?.toLowerCase() ?? ""
    if (marked(word.value.split(/[=\s]/)[0] ?? "")) call.local.push(word)
    else if (SSH_LOCAL.has(key)) call.local.push({ ...word, value: m?.[2] ?? "" })
    else if (key === "remotecommand") remoteCommand = { ...word, value: m?.[2] ?? "" }
    else if (key === "sendenv" || key === "setenv") call.env.push({ ...word, value: m?.[2] ?? "" })
  }
  for (let k = 0; k < args.length; k++) {
    const { value } = args[k]
    if (value === "--" || !value.startsWith("-") || value === "-") {
      const at = value === "--" ? k + 1 : k
      if (call.host || value === "--") {
        call.host ??= args[at]
        call.remote = args.slice(call.host === args[at] ? at + 1 : at)
        break
      }
      call.host = args[k]
      call.unread ||= marked(value)
      continue
    }
    for (let c = 1; c < value.length; c++) {
      if (value[c] === "n") call.noStdin = true
      if (SSH_VALUES.includes(value[c])) {
        const attached = value.slice(c + 1)
        const given = attached ? { ...args[k], value: attached } : args[++k]
        if (value[c] === "o" && given) option(given)
        break
      }
      if (!SSH_FLAGS.includes(value[c])) return { ...call, unread: true }
    }
  }
  if (call.remote.length === 0 && remoteCommand) call.remote = [remoteCommand]
  return call
}

// What ssh fed stdin does with it: the remote side reads it as its script when it runs no command (the login shell), when its command line reads stdin as code by stdinShellOf's own reading, or when the hook cannot read that line; -n gives it /dev/null instead
function sshStdin(cmd: Command, call: Ssh): StdinKind | undefined {
  if (call.noStdin) return undefined
  if (call.unread || call.remote.length === 0) return "shell"
  const kinds = lex(call.remote.map((w) => w.value).join(" ")).commands.map((c) =>
    stdinShell({ ...c, stdin: c.stdin ?? cmd }),
  )
  return kinds.includes("root") ? "root" : kinds.includes("shell") ? "shell" : kinds.find(Boolean)
}

// A remote line that may set a glob option by a name the hook cannot read: one holding a `$` or a backquote, or a word, as the lexer reads it and by its basename, naming eval, a source, or a program that starts a shell or an interpreter that can (DYNAMIC); its backslash-newline pairs are joined first, as the shell joins them
const DYNAMIC =
  /^(?:\.|bash|bun|busybox|dash|deno|env|eval|exec|expect|fish|g?awk|ksh|lua|mawk|mksh|node|perl|php|python[\d.]*|ruby|script|sh|source|su|sudo|tclsh|watch|zsh)$/
function staticLine(line: string): boolean {
  const joined = line.replace(/\\\n/g, "")
  if (marked(joined) || /[$`]/.test(joined)) return false
  const words = (cmds: Command[]): Word[] =>
    cmds.flatMap((c) => [...c.words, ...(c.inner ? words(c.inner()) : [])])
  return !words(lex(joined).commands).some(
    (w) => marked(w.value) || DYNAMIC.test(basename(w.value).toLowerCase()),
  )
}
// A shell feature that changes what a glob matches, any spelling of which the hook refuses on a remote line rather than reads, since reading it name by name kept missing one: a shopt, setopt, unsetopt, emulate or zsh options key, a name that turns dot matching on (dotglob, GLOB_DOTS, tcsh's globdot, GLOBIGNORE, BASHOPTS, ksh93's FIGNORE), or a zsh qualifier or ksh group after a glob character (`*(D)`, `?x(#qN)`), but after a `*` a digit follows (awk's `*100/(…)`), which is DIGIT_QUALIFIER's; a set or a started shell's options are optionSwitch's
const GLOB_SWITCHES = [
  /\b(?:emulate|setopt|shopt|unsetopt)\b|\boptions\[/i,
  /bashopts|dotglob|fignore|globdot|globignore/i,
  /(?:[?[]|\*(?!\d))[^\s;&|()]*\([^()\s|]*\)/,
]
// A qualifier after a `*` a digit follows, which awk's arithmetic (`*100/(…)`) is spelled as: no switch, so it runs, but its line counts dots as on (remoteDots), so a dot-led link such a glob could match is still judged
const DIGIT_QUALIFIER = /\*\d[^\s;&|()]*\([^()\s|]*\)/
// A text read as the shell reads a name: its backslash-newline pairs joined, and past quotes, backslashes and underscores (`g_l_o_b_d_o_t_s`, `dot''glob`)
const bareText = (text: string) => text.replace(/\\\n/g, "").replace(/['"\\_]/g, "")
// The option names a -o or a long option may give that change no glob, so a strict-mode header (`set -euo pipefail`) and a login shell run
export const NO_GLOB = new Set([
  "errexit",
  "errtrace",
  "functrace",
  "login",
  "noclobber",
  "noprofile",
  "norc",
  "nounset",
  "pipefail",
  "verbose",
  "xtrace",
])
// A set or a started shell, as a whole command word (rbash, rzsh and a versioned name such as bash-5.2 too, but not bash-completion.d), whose options, read until its first other word or a `--`, past a -c cluster and a redirect (`>x`, `2>&1`, `> x`) as bash and zsh read them, hold a switch: a cluster holding O or zsh's 4, one holding o with a name off NO_GLOB (zsh's, the rest of the cluster after its o, and bash's, the next word), a long option off NO_GLOB past case and dashes (`--extended-glob`), or any other -/+ word, which it does not read; each head is read on its own, so a set inside a -c script is read too; else undefined
// A redirect a shell drops before it reads on: a number, `&` or a `{name}` descriptor, then REDIRECT_OP's operator (`2>&1`, `{fd}>x`, zsh's `>!`)
const OPTION_REDIRECT = `(?:\\d*|&|\\{[A-Za-z_]\\w*\\})${REDIRECT_OP}`
const SHELL_HEAD = new RegExp(
  `(?<=^|[\\s;&|(/])(r?(?:bash|ksh|zsh)|dash|ksh93|mksh|set|sh|yash)(?:-?[\\d.]*\\d)?(?=[\\s<>;&|)]|$)(?=((?:${OPTION_REDIRECT}|[^;&|\\n])*))`,
  "gi",
)
const LEADING_REDIRECT = new RegExp(`^${OPTION_REDIRECT}`)
function optionSwitch(bare: string): string | undefined {
  for (const [, head, rest] of bare.matchAll(SHELL_HEAD)) {
    const words = rest!.split(/\s+/).filter(Boolean)
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!
      const redirect = LEADING_REDIRECT.exec(word)
      if (redirect) {
        if (redirect[0] === word) i++
        continue
      }
      if (word === "--" || !/^[-+]/.test(word)) break
      const long = /^--([a-zA-Z][a-zA-Z0-9-]*)$/.exec(word)
      if (long) {
        if (!NO_GLOB.has(long[1]!.replace(/-/g, "").toLowerCase())) return `${head} ${word}`
        continue
      }
      if (!/^[-+][a-zA-Z0-9]+$/.test(word) || /[O4]/.test(word)) return `${head} ${word}`
      const o = word.indexOf("o")
      if (o >= 0) {
        const names = [word.slice(o + 1), words[i + 1] ?? ""].filter(Boolean)
        if (names.length === 0 || names.some((name) => !NO_GLOB.has(name.toLowerCase())))
          return `${head} ${word}${words[i + 1] ? ` ${words[i + 1]}` : ""}`
        i++
      }
    }
  }
}
// The first glob-option switch a text holds, read bare (bareText) and past case, else undefined
export function globSwitch(text: string): string | undefined {
  const bare = bareText(text)
  for (const pattern of GLOB_SWITCHES) {
    const found = pattern.exec(bare)
    if (found) return found[0].trim()
  }
  return optionSwitch(bare)
}
// The env a remote command line runs in: ssh's remote shell, this machine's included, starts in the login's home with none of the line's variables, so a relative path reads from there; PWD is known as the home until the line moves; a line not fully static (staticLine), a script the remote side reads from stdin (`fed`), or a text holding a DIGIT_QUALIFIER, may match dot-led names (`remoteDots`); the glob-option switch the line, or the fed script's `text`, holds is kept as `remoteSwitch`
export function remoteEnv(env: Env, line: string, fed = false, text = line): Env {
  const home = env.process.HOME || undefined
  const { PWD: _pwd, ...known } = env.known
  return {
    ...env,
    cwd: home,
    cwdAnywhere: undefined,
    cwdBack: [],
    cwdChain: undefined,
    cwdChainToken: undefined,
    cwdChainUnread: undefined,
    cwdHeld: [],
    cwdMaybe: [],
    cwdOr: undefined,
    cwdSure: home,
    cwdUnread: home === undefined,
    known: home && !/\b(?:cd|popd|pushd)\b/.test(line) ? { ...known, PWD: home } : known,
    old: { dir: home },
    oldFrom: undefined,
    remote: true,
    remoteDots: fed || !staticLine(line) || DIGIT_QUALIFIER.test(bareText(text)),
    remoteSwitch: env.remoteSwitch ?? globSwitch(text),
    vars: new Map(),
  }
}

function stdinShellOf(cmd: Command, { args, first, name, xargs }: Parsed): StdinKind | undefined {
  // piped input, or input xargs hands on as words, reaches whatever the command runs, so a command that can run code takes it as code whatever its arguments say
  const fed = !!cmd.stdin || !!xargs
  if (first && !marked(first.value)) {
    // ssh hands its stdin, a redirect's included, to the remote side
    if (name === "ssh") {
      const call = sshCall({ args, first })
      return call && (fed || stdinFed(cmd)) ? sshStdin(cmd, call) : undefined
    }
    if (name === "." || name === "source" || name === "eval")
      return fed || (name !== "eval" && STDIN_PATHS.has(args[0]?.value ?? "")) ? "shell" : undefined
    const family = familyOf(name)
    if (family) return fed && interpreted(family, args, xargs) ? "code" : undefined
    // su, busybox's applet included, with no command of its own starts a root shell that reads its script from stdin, as `sudo -s` does
    if (name === "su") return suCommand(args) ? undefined : "root"
    if (!SHELLS.has(name) || noExec(args, name)) return undefined
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
  // `command -v` or `-V` looks up the names after it and runs none of them, so no shell starts
  if (
    before.some(
      (w, k) =>
        !w.quoted && program(w.value) === "command" && /^-p?[vV]/.test(before[k + 1]?.value ?? ""),
    )
  )
    return undefined
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

// Wrappers that take one positional argument (a count, a duration, a lock file or a CPU mask) before the command; chrt's priority, which may be left out, is taken only when it is digits.
export const COUNTED = new Set(["flock", "repeat", "taskset", "timeout"])
// The counted wrappers whose count or duration manyTimes reads
const REPEATS = new Set(["repeat", "timeout"])
export const SHELLS = new Set(["bash", "csh", "dash", "fish", "ksh", "sh", "tcsh", "zsh"])
// A double-quoted expansion every shell reads as one word: a plain parameter, one with an operator after its name (a default, a pattern cut, a replacement), arithmetic, a command substitution or a backtick; a zsh flag, a subscript, `$@`, `$*` or a default's or alternate's text holding an `@` is none
const QUOTED_ONE_WORD =
  /^(?:\$(?:[A-Za-z_]\w*|\d|\{(?:[A-Za-z_]\w*|\d+)(?::?[-+=?][^}@]*|(?:[#%]{1,2}|\/{1,2})[^}]*)?\}|\([\s\S]*\))|`[\s\S]*`)$/
// The script names a shell or a source reads stdin through
const STDIN_PATHS = new Set(["-", "/dev/fd/0", "/dev/stdin", "/proc/self/fd/0"])
export const EXPORTS = new Set(["declare", "export", "local", "readonly", "typeset"])
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
  "--cacert",
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
  if (lx.commands.some((c) => c.words.some((w) => /^chpwd/.test(w.value))))
    for (const c of lx.commands) c.cdRedefined = true
  braced(lx.commands)
  for (const c of casePatterns(lx.commands, true)) c.casePattern = true
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
    // a line's own cd function or zsh chpwd hook may move the shell anywhere at each cd
    if (name === "cd" || name === "chpwd") for (const c of commands) c.cdRedefined = true
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
  // the pipe into each brace group the walk is inside, beside opens, so every command of the body reads it (braceFed)
  const fedOpens: (Command | undefined)[] = []
  const fresh = (): Command => {
    const braceFed = fedOpens.at(-1)
    return { ...(braceFed && { braceFed }), redirects: [], scope, stdin: inherit, words: [] }
  }
  let cmd = fresh()
  // each group command whose paren globOpens also reads as zsh's glob word, with that reading's command
  const twins = new Map<Command, Twin>()
  // the twin a word or a redirect starting at `from` joins, once the walk is past the glob word's end
  const past = (from: number): Twin | undefined => {
    const twin = twins.get(cmd)
    return twin && from >= twin.from ? twin : undefined
  }
  const opens: number[] = []
  // How many bodies the walk is inside, how many of them a loop runs, and the operator that joined the last command to this one, so a command the shell may not run is marked unsure and one it runs only on the command before it succeeding is marked chained.
  let depth = 0
  let loops = 0
  // the depth each zsh `repeat N {` body sits at, a loop until its closing brace
  const counted: number[] = []
  let after = ""
  // each body the walk is inside, true for one the shell may keep for a later call
  const bodies: boolean[] = []
  // each loop whose `do` the walk has not reached, true for a while's or an until's, whose condition the shell runs once for each pass and once more
  const heads: boolean[] = []
  // A pipeline's commands and a backgrounded one run in subshells: a cd there leaves the shell where it was.
  const end = (op: string) => {
    const done = cmd
    const twin = twins.get(done)
    const pipe = op === "|" || op === "|&"
    const brace = (c: Command, value: string) => c.words[0]?.value === value && !c.words[0].quoted
    if (brace(done, "}")) {
      const open = opens.pop()
      fedOpens.pop()
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
      // zsh's `repeat N {` opens a loop's body that its closing brace ends (markers reads the brace)
      const counting = each === "repeat" && reserved.includes("{")
      // every command between a loop's head and its `do` runs once for each pass: a while's or an until's condition, and the body of zsh's short loops, which have no `do`
      if (loops > 0 || loop || head || each === "foreach" || counting) done.repeated = true
      if (outer && !loop && reserved.some((w) => w === "while" || w === "until"))
        done.atLeastOnce = true
      depth = Math.max(0, depth + opened - closed)
      loops = Math.max(0, loops + (loop ? 1 : 0) - (reserved.includes("done") ? 1 : 0))
      if (counting) {
        counted.push(depth)
        loops++
      }
      while (counted.length > 0 && depth < counted[counted.length - 1]) {
        counted.pop()
        loops = Math.max(0, loops - 1)
      }
      // a run ends only at an operator that runs the next command whatever this one did, and only outside every body: a `|` keeps the pipeline in the run, and entering a group, a body or a script keeps the run it was reached through
      if (depth === 0 && FREES.has(op)) {
        lx.token = freshToken()
        lx.orRun = op === "||"
      }
      after = op
      if (counting) {
        opens.push(lx.commands.length)
        fedOpens.push(fedOpens.at(-1))
      }
      for (const w of done.words) {
        if (w.value !== "{" || w.quoted) break
        opens.push(lx.commands.length)
        fedOpens.push(done.stdin ?? done.braceFed)
      }
      // an exec with a redirect swaps the group's descriptors (`{ exec 0<&3; xargs …; }`), so the commands after it read the pipe no more
      const called = done.words.find((w) => w.value !== "{" || w.quoted)
      if (
        fedOpens.length > 0 &&
        called?.value === "exec" &&
        !called.quoted &&
        done.redirects.length > 0
      )
        fedOpens[fedOpens.length - 1] = undefined
      lx.commands.push(done)
      if (twin && lx.i >= twin.from) {
        const { of, redirects, words } = twin
        of.glob = { detached: of.detached || done.detached, redirects, words }
      }
    }
    cmd = fresh()
    // a paren inside the glob word (`(r|x)(m|y)`) ends a group command there, so its twin waits for the next
    if (twin && lx.i < twin.from) twins.set(cmd, twin)
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
      const twin = globOpens(cmd, src, lx.i) ? globTwin(lx, cmd) : undefined
      lx.i++
      const piped = cmd.words.length === 0 && cmd.redirects.length === 0 ? cmd.stdin : undefined
      end(";")
      const from = lx.commands.length
      const scope = lx.scopes.length
      nest(lx, piped)
      cmd.group = true
      const members = topLevel(lx.commands.slice(from), scope)
      cmd.inner = () => members
      if (twin) twins.set(cmd, twin)
    } else if ((c === "<" || c === ">" || c === "=") && src[lx.i + 1] === "(") {
      const from = lx.i
      cmd.words.push(procSub(lx))
      past(from)?.words.push(cmd.words[cmd.words.length - 1])
    } else if (redirect) {
      const from = lx.i
      lx.i += redirect[0].length
      while (src[lx.i] === " " || src[lx.i] === "\t") lx.i++
      const [, fd] = redirect
      // zsh's >!, >>! and >&! override noclobber as >| does
      const op = redirect[2].replace(/!$/, "|").replace(/^(>[>&])\|$/, "$1")
      const target =
        src.startsWith("<(", lx.i) || src.startsWith("=(", lx.i) ? procSub(lx) : word(lx)
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
      past(from)?.redirects.push(entry)
    } else if (c === ";" || c === "&" || c === "|") {
      const two = src.slice(lx.i, lx.i + 2)
      const op = ["&&", ";;", "|&", "||"].includes(two) ? two : c
      lx.i += op.length
      end(op)
    } else {
      const from = lx.i
      cmd.words.push(word(lx))
      if (lx.i === from) lx.i++
      else past(from)?.words.push(cmd.words[cmd.words.length - 1])
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

// A process substitution (`<(…)`, `>(…)`, zsh's `=(…)`), carrying the commands whose output leaves it, so a shell that reads it as a script can read that output.
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

// Whether a paren opens a zsh glob word where a wrapper's program word goes (`command (r|x)m`), as zsh reads one after a program word; README's shared reader section lists where it reads as a subshell alone
function globOpens(cmd: Command, src: string, at: number): boolean {
  const program = cmd.words.findIndex((w) => w.quoted || !MARKERS.has(w.value))
  if (program < 0) return false
  const lead = cmd.words.slice(program)
  const next: Word = { quoted: false, value: "(" }
  let words = [...cmd.words, next]
  let { first } = parse({ ...cmd, words })
  // a word that may expand to no word leaves the next one the program, as emptyProgram reads it
  while (first && first !== next && words.includes(first) && maySkip(first)) {
    const dropped = first
    words = words.filter((w) => w !== dropped)
    ;({ first } = parse({ ...cmd, words }))
  }
  const close = balanced(src, at, "(", ")", false, true)
  const group = src.slice(at, close)
  return (
    first === next &&
    src[at + 1] !== ")" &&
    !group.includes("/") &&
    plainAlternative(group, close < src.length && !/[\s;&|<>)]/.test(src[close])) &&
    !subshellPrefix(lead) &&
    !HEADERS.has(cmd.words[0]?.value ?? "")
  )
}
// Whether a group holds an alternative with no unquoted blank or command separator, the one kind that can spell a program's name, an empty one only with text glued after the group (`(|x y)rm`); a paren whose every alternative holds one (`nice (ls -la)`, `nice (pkill;x)`, `nice (a || b)`) keeps its subshell reading alone
function plainAlternative(group: string, glued: boolean): boolean {
  let depth = 0
  let plain = true
  let empty = true
  for (let i = 1; i < group.length - 1; i++) {
    const c = group[i]
    if (c === "|" && depth === 0) {
      if (plain && (glued || !empty)) return true
      plain = true
      empty = true
      continue
    }
    empty = false
    if (c === "\\") i++
    else if (c === "'") {
      const end = group.indexOf("'", i + 1)
      i = end === -1 ? group.length : end
    } else if (c === '"') {
      i++
      while (i < group.length && group[i] !== '"') i += group[i] === "\\" ? 2 : 1
    } else if (c === "(") depth++
    else if (c === ")") depth--
    else if (/[\s;&]/.test(c)) plain = false
  }
  return plain && (glued || !empty)
}
// Whether the words before a paren are a stack of zsh's own prefixes, after which it runs a subshell (`time repeat 1 (…)`); a `time` right after a `time` is the external program, which globs the paren (`time time (r|x)m`)
function subshellPrefix(lead: Word[]): boolean {
  let at = 0
  while (at < lead.length && !lead[at].quoted)
    if (lead[at].value === "time" && lead[at - 1]?.value === "time") break
    else if (lead[at].value === "time" || lead[at].value === "nocorrect") at++
    else if (lead[at].value === "repeat" && at + 1 < lead.length) at += 2
    else break
  return at > 0 && at === lead.length
}
// Whether a word the reader read none of may expand to no word, before any value is known (mayVanish, read without the env)
const maySkip = (w: Word): boolean =>
  !!w.source &&
  /^\u0000+$/.test(w.value) &&
  (/^\u0000+$/.test(w.source) || vanishingParts(w.source))
const HEADERS = new Set(["case", "for", "foreach", "function", "select"])

// The command a paren globOpens opens reads as under zsh's glob reading: its words past its reserved ones, the glob word, and each word and redirect the walk reads from `from`, the glob word's end, on; the glob word is read on a copy of the lexer, so its substitutions' commands come from the subshell reading alone
type Twin = { from: number; of: Command; redirects: Redirect[]; words: Word[] }
function globTwin(lx: Lexer, of: Command): Twin {
  const copy: Lexer = { ...lx, commands: [], scopes: [...lx.scopes] }
  const glob = word(copy, true)
  const program = of.words.findIndex((w) => w.quoted || !MARKERS.has(w.value))
  return {
    from: copy.i,
    of,
    redirects: [...of.redirects],
    words: [...of.words.slice(program), glob],
  }
}

function word(lx: Lexer, opening = false): Word {
  const { src } = lx
  const start = lx.i
  const out: Word = { quoted: false, value: "" }
  let bare = ""
  while (
    lx.i < src.length &&
    (!BREAK.has(src[lx.i]) ||
      (src[lx.i] === "(" && (lx.i > start || opening) && src[lx.i + 1] !== ")"))
  ) {
    tick()
    const c = src[lx.i]
    const next = src[lx.i + 1] ?? ""
    if (
      c === "(" &&
      /^(?:[A-Za-z_]\w*(?:\[[^\]]*\])?|\[[^\]]*\])\+?==$/.test(src.slice(start, lx.i))
    ) {
      // zsh's `=(…)` as an assignment's value (`x==(…)`, `x[1]==(…)`, `typeset x==(…)`) or an array's indexed or keyed value (`a=([1]==(…))`), its commands lexed as at a word's start
      out.value = out.value.slice(0, -1)
      bare = bare.slice(0, -1)
      lx.i--
      merge(out, procSub(lx))
    } else if (c === "(") {
      const end = balanced(src, lx.i, "(", ")", false, opening)
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
  if (BRACE_LIST.test(bare)) out.unknown ??= BRACE
  if (GLOB_CHARS.test(bare)) out.glob = true
  out.source = src.slice(start, lx.i)
  if (marked(out.value)) out.raw = out.source
  // zsh expands ~- and ~+ after removing quotes and filling in expansions, so a word opening with an unquoted ~ is read by its value (`~-"/f"`, `~"-"/f`, `~-$Y/f`)
  if (src[start] === "~" && TILDE.test(out.value)) out.tilde = true
  return out
}

const GLOB_CHARS = /[*?[{(]/

// A brace list or sequence the shell expands, its close found by a lookahead once, so a { with no } costs its length rather than its square
const BRACE_LIST = /\{(?=[^{}]*\})[^{}]*(?:,|\.\.)/

// The mark a word holding a brace list or sequence the shell sees carries
export const BRACE = "a brace expansion"

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
    // ${NAME:?message} and ${NAME?message} expand to NAME's value whenever it is set and not empty, the only way a known one is
    const name = /^\$\{([A-Za-z_]\w*)(?::?\?[^}]*)?\}$/.exec(src.slice(lx.i, end))?.[1]
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
    // zsh applies a history modifier after an unbraced name, quoted or not (`$W:h`, `"$W:t"`), so the word is one the reader cannot know
    if (/^:[A-Za-z&]/.test(src.slice(lx.i, lx.i + 2))) return unknown("a zsh modifier")
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
    if ((src[sub.i] === "<" || src[sub.i] === ">" || src[sub.i] === "=") && src[sub.i + 1] === "(")
      procSub(sub)
    else word(sub)
    if (sub.i === from) sub.i++
  }
}

// `doubles` skips double-quoted text too, its backslashes escaping, as a zsh glob word's group reads it
function balanced(
  src: string,
  from: number,
  open: string,
  close: string,
  plain = false,
  doubles = false,
): number {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    tick()
    const c = src[i]
    if (c === "\\") i++
    else if (c === "'" && !plain) {
      const end = src.indexOf("'", i + 1)
      i = end === -1 ? src.length : end
    } else if (c === '"' && doubles) {
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1
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

// xargs in front of a command: `replace` is its -I (or BSD -J) string, which marks where stdin goes; without one, stdin is appended as arguments. `filled` holds each word in a program position after it (a wrapper's name or the program) that holds that string or an outer xargs' one in `outer`, which an inner xargs' own leaves in force, each with the string it holds, which xargs fills from its input. GNU's input options: `files` holds each file -a or --arg-file reads in place of stdin, with env -C's folder word before xargs (`chdir`) and whether a privilege wrapper before it may move the folder or the root (`moved`), and `delimiters` each string -d, --delimiter, -0 or --null splits the input at, undefined for an escape the reader cannot decode.
export type Xargs =
  | {
      delimiters?: (string | undefined)[]
      files?: { chdir?: Word; file: Word; moved?: boolean }[]
      filled?: [Word, string][]
      outer?: string[]
      replace?: string
    }
  | undefined

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
  // Set by examine on a reading whose program word, or whose eval's or shell -c's script, is built from an expansion no reading of the command resolves, so each guard applies its own rule for a command it cannot read
  unread?: boolean
  // the package runner (a RUNNERS key, "pnpm" for the name pnpm runs as exec does, or "deno" for an npm: package deno runs with no subcommand) whose program this reading is, beside the reading of the runner itself
  via?: string
  xargs: Xargs
}

// env's split-string option, attached or not, with the text it carries attached
const SPLIT = /^(?:-[0iv]*S|--split-string(?:=|$))(.*)$/
// GNU xargs' long options, each of which it takes by any unique prefix (`--delim=,`)
const XARGS_LONG = [
  "arg-file",
  "delimiter",
  "eof",
  "exit",
  "help",
  "interactive",
  "max-args",
  "max-chars",
  "max-lines",
  "max-procs",
  "no-run-if-empty",
  "null",
  "open-tty",
  "process-slot-var",
  "replace",
  "show-limits",
  "verbose",
  "version",
]
// GNU's and BSD's short xargs options that take no value, as a cluster (`-rJ`, `-0I`) reads them before the one that takes a value
const XARGS_FLAGS = "0oprtx"
// The one character GNU xargs' -d names, itself or a backslash escape: a letter $'…' reads, an octal number, or \x and a hex one; undefined when the reader cannot decode it
function delimiterOf(word: Word | undefined): string | undefined {
  if (!word || word.unknown) return
  if (word.value.length === 1) return word.value
  const [, hex, octal, letter] = /^\\(?:x([\da-f]+)|([0-7]+)|(.))$/i.exec(word.value) ?? []
  const code = hex ? parseInt(hex, 16) : octal ? parseInt(octal, 8) : undefined
  if (code !== undefined) return code < 256 ? String.fromCharCode(code) : undefined
  return letter ? ESCAPES[letter] : undefined
}

// xargs' replace options as unwrap reads and takes them itself: -I, -J, -i and --replace, each leading its word
const XARGS_REPLACE = /^(?:-[IiJ]|--replace)/

// Records what one xargs option word sets beside unwrap's own reading, which still takes the word and forks as before, so the parse keeps every reading it made: GNU's -a and --arg-file (the input), -d, --delimiter, -0 and --null (its split), and a replace string XARGS_REPLACE misses, at the end of a cluster of flags (`-rJ`) or by a long prefix GNU takes (`--repl=`); its value attached or the next word, and a file with the folder `state` holds before xargs
function xargsOption(
  xargs: NonNullable<Xargs>,
  w: Word,
  next: Word | undefined,
  state: State,
): void {
  const split = (delimiter: string | undefined) => {
    xargs.delimiters = [...(xargs.delimiters ?? []), delimiter]
  }
  if (XARGS_REPLACE.test(w.value)) return
  const long = /^--([^=]+)(=?)/.exec(w.value)
  let name: string | undefined
  let value: Word | undefined
  if (long) {
    const names = XARGS_LONG.filter((n) => n.startsWith(long[1]))
    name = names.includes(long[1]) ? long[1] : names.length === 1 ? names[0] : undefined
    if (long[2]) value = slice(w, long[0].length)
  } else if (w.value.startsWith("-")) {
    let k = 1
    while (XARGS_FLAGS.includes(w.value[k] ?? "-")) k++
    if (w.value.slice(1, k).includes("0")) split("\0")
    name = w.value[k]
    if (k + 1 < w.value.length) value = slice(w, k + 1)
  }
  if (name === "i" || name === "replace") xargs.replace = value?.value || "{}"
  else if (name === "null") split("\0")
  else if (name === "I" || name === "J") xargs.replace = (value ?? next)?.value
  else if (name === "a" || name === "arg-file")
    xargs.files = [
      ...(xargs.files ?? []),
      ...[value ?? next]
        .filter((file) => file !== undefined)
        .map((file) => ({ chdir: state.chdir, file, moved: state.moved })),
    ]
  else if (name === "d" || name === "delimiter") split(delimiterOf(value ?? next))
}

// Each word env -S splits out of its string, to the typed word in cmd.words that string came from, so xargsFilled fills the typed word; keyed on parse's own words alone, so no call's state is kept
const splitFrom = new WeakMap<Word, Word>()

// `moved`: a privilege wrapper came before, which may run the rest in another folder or root (sudo -D, -i or -R, pkexec without --keep-cwd)
type State = { chdir?: Word; local: Map<string, Text>; moved?: boolean; rest: Word[]; xargs: Xargs }
// env's folder word, which a second -C leaves unread, since one env moves by each in turn and another by the last alone
const chdirOf = (state: State, word: Word | undefined): Word | undefined =>
  state.chdir && word ? { ...word, ...unknown("a second env -C") } : word
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
  const next = (): Word | undefined => rest[rest.length - 2]
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
          moved: state.moved,
          rest: rest.slice(0, Math.max(0, rest.length - drop)),
          xargs: state.xargs && { ...state.xargs },
        },
        wrapper,
        budget,
      ),
    )
  }
  // a spec runner's program word is a package name, read as the program it names
  let spec = false
  for (let wrapper = inside; ; wrapper = undefined) {
    if (!wrapper) {
      const word = peek()
      const held = [state.xargs?.replace ?? "", ...(state.xargs?.outer ?? [])]
      for (const replace of held.filter((r) => r && word?.value.includes(r)))
        if (word) {
          const typed = splitFrom.get(word) ?? word
          state.xargs = {
            ...state.xargs,
            filled: [...(state.xargs?.filled ?? []), [typed, replace]],
          }
        }
      wrapper = program(word?.value ?? "")
      if (!WRAPPERS.has(wrapper)) break
      if (ROOT_SHELLS.has(wrapper)) state.moved = true
      if (wrapper === "xargs" && state.xargs?.replace)
        state.xargs = { ...state.xargs, outer: [...(state.xargs.outer ?? []), state.xargs.replace] }
      if (wrapper === "xargs") state.xargs ??= {}
      take()
    }
    const runs = RUNNERS.get(wrapper)
    const options = (WRAPPERS.get(wrapper) ?? runs) as Options
    spec = !!runs?.spec
    let joined = runs?.joined === true
    for (let w = peek(); w; w = peek()) {
      const v = w.value
      const script = runs && namedOption(v, runs, runs.script)
      const folder = runs && namedOption(v, runs, runs.folder)
      if (wrapper === "xargs") xargsOption((state.xargs ??= {}), w, next(), state)
      if (runs && runs.joined !== true && joinsWords(v, runs.joined)) joined = true
      if (ASSIGN.test(v)) assign(local, take() as Word)
      // env -S splits its one string into the words it runs
      else if (wrapper === "env" && SPLIT.test(v)) {
        const attached = SPLIT.exec(v)?.[1] ?? ""
        take()
        const from = attached ? w : take()
        const split = (attached || from?.value || "").split(/\s+/).filter(Boolean)
        for (let j = split.length - 1; j >= 0; j--) {
          const word = { quoted: false, value: split[j] }
          if (from) splitFrom.set(word, splitFrom.get(from) ?? from)
          rest.push(word)
        }
      } else if (wrapper === "env" && (v === "-C" || v === "--chdir")) {
        take()
        state.chdir = chdirOf(state, take())
      } else if (wrapper === "env" && /^(?:-C|--chdir=)./.test(v)) {
        state.chdir = chdirOf(state, slice(w, v.startsWith("-C") ? 2 : "--chdir=".length))
        take()
      } else if (wrapper === "xargs" && XARGS_REPLACE.test(v)) {
        const attached = /^(?:-[IiJ]|--replace=?)(.*)$/.exec(v)?.[1] ?? ""
        take()
        state.xargs ??= {}
        state.xargs.replace = v === "-I" || v === "-J" ? take()?.value : attached || "{}"
      } else if (wrapper === "env" && v === "-") {
        // a lone `-` is env's -i, and BSD env reads its options on after it
        take()
      } else if (folder !== undefined) {
        // a runner's folder option is where its program runs, read as env -C's folder is, with no reading of its value as the program
        take()
        state.chdir = chdirOf(state, folder === -1 ? take() : slice(w, folder))
      } else if (script !== undefined) {
        // a runner's script option runs its value in a shell, read as `sh -c` reads it
        take()
        const text = script === -1 ? take() : slice(w, script)
        if (text) rest.push(text, ...SH_C)
        break
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
        else if (end === "next" && marked(next()?.value ?? "")) {
          fork(wrapper, 1)
          fork(wrapper, 3)
        }
        rest.length = Math.max(0, rest.length - (end === "next" ? 2 : 1))
      } else if (runs?.tools && rest.some((r) => !r.quoted && r.value === "--")) take()
      else break
    }
    // pnpm's shell mode and yarn exec run the words left joined by spaces as one shell script
    if (joined && rest.length > 0) {
      const text = rest
        .toReversed()
        .map((r) => r.value)
        .join(" ")
      rest.length = 0
      rest.push({ quoted: true, value: text }, ...SH_C)
    }
    if (COUNTED.has(wrapper)) take()
    if (wrapper === "chrt" && /^\d+$/.test(peek()?.value ?? "")) take()
    // flock's -c or --command after its file runs the next word in a shell
    if (wrapper === "flock" && !peek()?.quoted && FLOCK_SCRIPT.has(peek()?.value ?? "")) {
      take()
      const text = take()
      if (text) rest.push(text, ...SH_C)
    }
    // zsh's `repeat N do … done` and `repeat N { … }` run their body's first command after the do or the brace
    if (wrapper === "repeat" && REPEAT_BODY.has(peek()?.value ?? "") && !peek()?.quoted) take()
  }
  const typed = take()
  const first = spec && typed ? packageName(typed) : typed
  const parsed: Parsed = {
    also,
    args: rest.reverse(),
    chdir: state.chdir,
    first,
    local,
    name: first ? program(first.value) : "",
    xargs: state.xargs,
  }
  const via = viaRunner(parsed, state, budget)
  if (via) also.push(via)
  return parsed
}

// The words a runner's script option, flock's -c and a joined script become, pushed after the script's own word so the stack reads `sh -c <script>`
const SH_C: Word[] = [
  { quoted: false, value: "-c" },
  { quoted: false, value: "sh" },
]
const FLOCK_SCRIPT = new Set(["-c", "--command"])

// Where a runner's option word names one of `names`, an option that takes a value: the offset of its value attached (`--call=x`, `-cx`), -1 for a value in the next word, or undefined for an option word naming none of them
function namedOption(v: string, { values }: Options, names: Set<string>): number | undefined {
  if (!v.startsWith("-") || v === "-" || v === "--") return
  if (v.startsWith("--")) {
    const eq = v.indexOf("=")
    if (!names.has(eq === -1 ? v : v.slice(0, eq))) return
    return eq === -1 ? -1 : eq + 1
  }
  for (let k = 1; k < v.length; k++) {
    const option = `-${v[k]}`
    if (values.has(option)) return names.has(option) ? (k === v.length - 1 ? -1 : k + 1) : undefined
  }
}

// Whether a runner's option word turns on the mode that runs its words joined: the flag itself, a short cluster holding its letter (`-rc`), or the long flag with any value attached (`--shell-mode=true`), each read as on
function joinsWords(v: string, joined: Set<string>): boolean {
  if (v.startsWith("--")) return joined.has(v.split("=")[0])
  return v.startsWith("-") && [...v.slice(1)].some((letter) => joined.has(`-${letter}`))
}

// A runner's package word as the program it names: deno's npm: prefix and a trailing @<version or tag> read past (`npm:portless@0.15.11`, `inscope@0.18.0`), its typed source cut the same way when it is spelled plain
function packageName(word: Word): Word {
  const from = word.value.startsWith("npm:") ? 4 : 0
  const name = word.value.slice(from).replace(/(?<=.)@[^@/]*$/, "")
  if (from === 0 && name === word.value) return word
  const cut = slice(word, from)
  return { ...cut, source: word.source === word.value ? name : word.source, value: name }
}

// The index of a manager's subcommand in its words, past the options it reads before it (`pnpm -r exec`); an option its runner's lists lack is read as a flag, unless the word after its next names the subcommand
function subcommandAt(manager: string, args: Word[], options: Options): number {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (!v.startsWith("-") || v === "-" || v === "--") return k
    const end = optionValue(v, options)
    if (end === "next") k++
    else if (
      end === undefined &&
      !RUNNERS.has(`${manager} ${args[k + 1]?.value}`) &&
      RUNNERS.has(`${manager} ${args[k + 2]?.value}`)
    )
      k++
  }
  return args.length
}

// The reading of the program a package runner runs (`npx oxfmt`, `pnpm exec sh -c …`, `bun run x`), its `via` the runner, judged beside the reading of the runner itself, so a hook that reads the runner by its name reads it as before; pnpm runs a name none of its commands takes as `pnpm exec` does (`via` "pnpm"), and deno runs an `npm:` package with no subcommand as `deno run` does (`via` "deno"); a file bun run or deno run runs (`bun run scripts/x.ts`, `deno run main.ts`) is no program, while deno's `npm:` package is
function viaRunner(parsed: Parsed, state: State, budget: Budget): Parsed | undefined {
  const { args, name } = parsed
  let key = RUNNERS.has(name) ? name : undefined
  let words = args
  let implicit = false
  const manager = MANAGERS.get(name)
  if (!key && manager) {
    let at = subcommandAt(name, args, RUNNERS.get(manager) as Options)
    const from = at
    for (let scope = scopeAt(name, args, at); scope; scope = scopeAt(name, args, at)) {
      const after = at + scope.words + scope.names
      at = after + subcommandAt(name, args.slice(after), scope.options)
    }
    const sub = args[at]?.value
    if (sub === undefined) return
    if (RUNNERS.has(`${name} ${sub}`)) {
      key = `${name} ${sub}`
      words = args.toSpliced(from, at + 1 - from)
    } else if (
      (name === "pnpm" && !PNPM_COMMANDS.has(sub)) ||
      (name === "deno" && sub.startsWith("npm:"))
    ) {
      key = manager
      implicit = true
    }
  }
  if (!key) return
  tick()
  if (budget.left-- <= 0) {
    budget.capped = true
    return
  }
  const reading = unwrap(
    {
      chdir: parsed.chdir,
      local: new Map(parsed.local),
      moved: state.moved,
      rest: words.toReversed(),
      xargs: parsed.xargs && { ...parsed.xargs },
    },
    key,
    budget,
  )
  if (!reading.first) return
  const file = reading.first.value
  if (key === "bun run" && (file.includes("/") || SCRIPT_FILE.test(file))) return
  if (key === "deno run" && words.includes(reading.first)) return
  return { ...reading, via: implicit ? name : key }
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/

// The scope a manager's words name at `at`, with how many words name it (`workspaces foreach` two)
function scopeAt(name: string, args: Word[], at: number) {
  const two = `${name} ${args[at]?.value} ${args[at + 1]?.value}`
  const one = `${name} ${args[at]?.value}`
  const scope = SCOPES.get(two) ?? SCOPES.get(one)
  return scope && { ...scope, words: SCOPES.has(two) ? 2 : 1 }
}

// Whether bun run's or pnpm's name is a script of the nearest package.json at or above the folder it runs in (readingEnv), which each runs in place of a program of that name (measured: `bun run echo` and `pnpm echo` run a script named echo, from a subfolder too); false wherever the folder is unread
export function runsScript({ first, via }: Parsed, env: Env): boolean {
  if (via !== "bun run" && via !== "pnpm") return false
  const name = first?.value
  const unsure = env.cwdUnread || env.cwdAnywhere || (env.cwdMaybe?.length ?? 0) > 0
  const start = env.cwdSure ?? (unsure ? undefined : env.cwd)
  if (!name || marked(name) || !start) return false
  for (let dir = start; ; dir = dirname(dir)) {
    const scripts = packageScripts(`${dir}/package.json`)
    if (scripts) return Object.hasOwn(scripts, name)
    if (dirname(dir) === dir) return false
  }
}

// A package.json's scripts, an empty set of them for one the hook cannot parse, or undefined where no package.json is
function packageScripts(path: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return
  }
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts
    return scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// run-slot.sh runs the words after the -- that follows its <who> as the command: those words (none when it has no such --), or undefined for any other command, so a hook that calls it reads a slotted command as the command itself; <who> is never the separator, even spelled --, which run-slot refuses.
export function slotWords({ args, name }: Parsed): Word[] | undefined {
  if (name !== "run-slot.sh") return
  const at = args.findIndex((a, i) => i > 0 && a.value === "--")
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
  // a script the line runs keeps the whole line's count, which a hook's own reading of the line again leaves as it is
  env.namings ??= namings(lexed.commands)
  const unbind = new Map<Command, () => void>()
  for (const [k, cmd] of lexed.commands.entries()) {
    const at = envOf(cmd.scope)
    if (cmd.repeated && !lexed.commands[k - 1]?.repeated) repass(lexed.commands.slice(k), envs)
    const verdict =
      (await examine(cmd, at, visit, builtins)) ??
      (cmd.glob && (await examine({ ...cmd, ...cmd.glob, glob: undefined }, at, visit, builtins)))
    if (verdict) return verdict
    unbind.get(cmd)?.()
    bind(lexed.commands, k, at, unbind)
    change(cmd, at)
  }
}

// The builtins that set a variable by a name among their words, from bash 5.3's bash(1), SHELL BUILTIN COMMANDS, and zsh 5.9's zshbuiltins(1) and zshmodules(1)
export const NAME_SETTERS = new Set([
  "compgen",
  "declare",
  "export",
  "float",
  "getln",
  "getopts",
  "integer",
  "let",
  "local",
  "mapfile",
  "nameref",
  "pcre_match",
  "print",
  "printf",
  "private",
  "read",
  "readarray",
  "readonly",
  "set",
  "shift",
  "stat",
  "strftime",
  "syserror",
  "sysopen",
  "sysread",
  "syswrite",
  "typeset",
  "unset",
  "vared",
  "wait",
  "zcurses",
  "zformat",
  "zgdbmpath",
  "zgetattr",
  "zlistattr",
  "zmodload",
  "zparseopts",
  "zpty",
  "zregexparse",
  "zselect",
  "zsocket",
  "zstat",
  "zstyle",
  "zsystem",
  "ztcp",
  "ztie",
  "zuntie",
])
// the setters that name a variable only by their v option, so their other words are text they print
export const PRINTS = new Set(["print", "printf"])
// the builtins that run text or load code as the line's own shell, which can set any variable: a trap's text runs there (a DEBUG trap's before each command), as do zsh's sched's, emulate -c's, a zstyle -e value's and a zregexparse action's, bash's mapfile -C callback, an alias on a later line, a history event fc or r runs, and the code autoload, zmodload and enable -f load
export const RUNS_TEXT = new Set([
  ".",
  "alias",
  "autoload",
  "emulate",
  "enable",
  "eval",
  "fc",
  "mapfile",
  "r",
  "readarray",
  "sched",
  "source",
  "trap",
  "zmodload",
  "zregexparse",
  "zstyle",
])

// A variable a builtin may have changed: unread, and maybe no word, so the empty reading drops it as a program word; the split reading still reads the value it held before (heldResolved), so no reading is lost
const CHANGED: Text = { ...unknown("a value a builtin may change"), vanishes: true }
const DECLARES = new Set([...EXPORTS, "float", "integer", "private"])

// Marks each held variable a command may change, wherever on the line it is, since a change the shell may make is one the reader cannot rule out: from bash 3.2's bash(1), SHELL BUILTIN COMMANDS (bash 5.3's for the nameref `declare -n`), and zsh 5.9's zshbuiltins(1) and zshmodules(1), every variable after text a RUNS_TEXT builtin runs or loads (an eval's only when the reader cannot read it, since the walk follows it otherwise) and after a setter (NAME_SETTERS) whose name word the reader cannot read; else unset's names (every one under zsh's -m), read's (REPLY when it names none), and print -v's and printf -v's but for a format of plain text, which end of input or an empty format leaves empty, a declaration's names under an option, but for an assignment under an array's -a alone (`declare -a A=(…)`), or, but for export and readonly, with no `=` (a local of its own in a function), zsh's `set -A` or `+A` name, and every name any other setter's words hold but getopts', which always takes an option letter or `?`; a program word the reader cannot read is the program a split reading resolves it to, or an array run whole its elements (arrayRun), and one none resolves is read as an eval when an argument is unread too (d-2047r)
function change(cmd: Command, env: Env): void {
  const { args, first, name } = parse(cmd)
  const words = args.map((a) => a.value)
  // a program word a split reading resolves (`U=unset; $U X`), or an array run whole (`A=(tool …); "${A[@]}" …`, `A=(unset X)`), changes what that program changes; one none resolves may be any builtin: with an argument it cannot read either, as an eval's, it may change every variable, and else the names its arguments hold
  if (marked(name)) {
    const array = arrayRun(cmd, first, env)
    // an array's text-runner runs text the walk never follows (`A=(eval 'unset X')`), and one the reader cannot read whole may hold any builtin
    if (array === null || (array && RUNS_TEXT.has(parse(array).name))) {
      for (const key of env.vars.keys()) setVar(env.vars, key, CHANGED)
      return
    }
    const variants = array
      ? [array]
      : [...splitHeld(cmd, name, env), ...splitHeld(cmd, name, env, true)].filter(
          (variant) => !marked(parse(variant).name),
        )
    for (const variant of variants) change(variant, env)
    if (variants.length > 0) return
    const known = heldKnown(env)
    const unread = args.some((a) => {
      const value = marked(a.value) && a.raw ? relexedValue(a.raw, known) : a.value
      return value === undefined || marked(value)
    })
    const names = unread ? [...env.vars.keys()] : words.filter((w) => NAME.test(w))
    for (const key of names) if (env.vars.has(key)) setVar(env.vars, key, CHANGED)
    return
  }
  // an element's assignment or an append (`A[1]=x`, `A[1]+=x`, zsh's `A[1]=()`, `A+=(x)`) reads as a program word, and changes its array
  const element = (first?.source ?? first?.value ?? "").match(SUBSCRIPTED)?.[1]
  if (element) {
    if (env.vars.has(element)) setVar(env.vars, element, CHANGED)
    return
  }
  const options = words.filter((w) => /^[-+]./.test(w) && w !== "--")
  const prints = PRINTS.has(name)
  // print and printf name one only by a v in an option cluster (`-v N`, `-vN`, `-rv N`), as steadyNames reads them
  const vNames = prints
    ? words.flatMap((w, k) =>
        /^-[^-\s]*v/.test(w) ? [w.slice(w.indexOf("v") + 1), words[k + 1] ?? ""] : [],
      )
    : []
  const nameWords = prints ? vNames : words.map((w) => w.split("=")[0])
  const all =
    (RUNS_TEXT.has(name) && (name !== "eval" || args.some(unreadWord))) ||
    (NAME_SETTERS.has(name) && nameWords.some(marked)) ||
    (name === "unset" && options.some((w) => w.includes("m")))
  const read = name === "read" ? binds(cmd) : []
  const names = all
    ? [...env.vars.keys()]
    : name === "unset"
      ? options.some((w) => w.includes("f"))
        ? []
        : words
      : name === "read"
        ? read.length > 0
          ? read
          : ["REPLY"]
        : prints
          ? printsText(words)
            ? []
            : vNames
          : DECLARES.has(name)
            ? words.filter(
                (w) =>
                  options.some((o) => o !== "-a") ||
                  (!ASSIGN.test(w) &&
                    (options.length > 0 || (name !== "export" && name !== "readonly"))),
              )
            : name === "set"
              ? words.flatMap((w, k) =>
                  /^[-+]\w*A$/.test(w) && words[k + 1] ? [words[k + 1]] : [],
                )
              : NAME_SETTERS.has(name) && name !== "getopts"
                ? words.flatMap((w) => w.match(/[A-Za-z_]\w*/g) ?? [])
                : []
  // a subscripted name (`unset 'A[0]'`, `read 'A[1]'`) changes its array
  for (const key of names.map((w) => w.split("=")[0].replace(/\[[\s\S]*$/, ""))) {
    if (!NAME.test(key)) continue
    // a name a read or a v option sets is set, maybe empty; one any other builtin names is changed only where the line holds it, since an unset one already reads as no word
    if (env.vars.has(key) || name === "read" || prints) setVar(env.vars, key, CHANGED)
  }
}

// Each time the line names a variable, counted, a whole array run as a program word aside: an expansion as written (`$A`, `${A[1]}`, `${#A[@]}`), and a word whose value names it as a setter or an assignment takes a name (`A`, `A[0]`, `A=x`, `A+=(x)`, `x=A`, `-vA[0]`)
function namings(commands: Command[]): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (name: string): void => void counts.set(name, (counts.get(name) ?? 0) + 1)
  const count = (source: string | undefined, value: string | undefined): void => {
    for (const [, name] of (source ?? "").matchAll(/\$\{?[#!+^=~]?([A-Za-z_]\w*)/g)) add(name)
    const text = value ?? ""
    for (const [, name] of text.matchAll(/(?<=^|=)([A-Za-z_]\w*)(?=\[|\+?=|$)/g)) add(name)
    const cluster = text.match(/^-(\w+)/)?.[1] ?? ""
    for (let k = 1; k < cluster.length; k++) {
      const name = cluster.slice(k).match(/^[A-Za-z_]\w*/)?.[0]
      if (name && /^(?:\[|\+?=|$)/.test(text.slice(k + 1 + name.length))) add(name)
    }
  }
  for (const cmd of commands) {
    const { args, first, name } = parse(cmd)
    // eval's text runs in the line's own shell, so every name it holds counts as the line's, read in one pass so a deep chain of evals stays linear
    if (name === "eval")
      for (const a of args) for (const [key] of a.value.matchAll(/[A-Za-z_]\w*/g)) add(key)
    for (const w of cmd.words)
      if (w !== first || !WHOLE_RUN.test(w.raw ?? w.source ?? "")) count(w.source ?? w.raw, w.value)
    for (const r of cmd.redirects) {
      count(r.target?.source, r.target?.value)
      count(r.body?.value, undefined)
    }
  }
  return counts
}

// An array the line holds, run whole as the program word (`"${A[@]}"`, or unquoted `${A[@]}` and `${A[*]}`, whose elements split again at the line's IFS), runs its elements as the command's first words: the command with them in its place when each is a word the reader reads as written, null when one is not, when something may have changed the array, or when the line names it beside its one whole assignment and its runs (`namings`), so the program may be any; undefined for any other program word, or a name the line never set to an array
function arrayRun(cmd: Command, first: Word | undefined, env: Env): Command | null | undefined {
  const run = (first?.raw ?? first?.source)?.match(WHOLE_RUN)
  const key = run?.[1] ?? run?.[2]
  const set = key ? env.vars.get(key) : undefined
  if (!key || !set) return
  // an array the line names anywhere but its one whole assignment and its runs may have changed there (`read "A[0]"`, `export "A[1]=x"`, `: ${A[1]}`)
  if ((env.namings?.get(key) ?? 0) > 1) return null
  if (set.unknown !== undefined || set.vanishes) return null
  // an assignment's word keeps its source in the line's variables, an array's `A=(…)` as written
  const inner = (set as Partial<Word>).source?.match(/^[A-Za-z_]\w*=\(([\s\S]*)\)$/)?.[1]
  if (inner === undefined) return
  const { commands } = lex(inner)
  const elements = commands.length === 1 ? commands[0].words : []
  // an element's leading unquoted ~ is the home, as the shell expands it in the assignment
  const asWritten = (w: Word): boolean =>
    !unreadWord({ ...w, source: w.source?.replace(/^~(?=\/|$)/, "") })
  if (elements.length === 0 || commands[0].redirects.length > 0 || !elements.every(asWritten))
    return null
  // an unquoted run splits each element at the line's IFS, dropping an empty one, as splitHeld splits a held value (`A=('git push' x); ${A[@]}`)
  const seps = ifsSplit(env)
  const words = run?.[2] ? elements.flatMap((w) => splitValue(w.value, seps)) : elements
  if (words.length === 0) return null
  return { ...cmd, words: cmd.words.flatMap((w) => (w === first ? words : [w])) }
}

// A program word holding a glob the shell sees (`/usr/bin/pk?ll`, `pk*ll`, `/bin/r[m]`) or a typed zsh group (`/usr/bin/pk(i|x)ll`, groupWords) runs the file it matches: the command with each match in its place, read from the disk segment by segment from the line's folder; null when the reader cannot tell what it matches (a group groupWords cannot read, zsh's glob qualifiers on a pattern that matches a file or that may vanish, a relative pattern under a folder it cannot read, a folder it cannot list, more matches than READINGS), so the command reads as unread; undefined for any other program word, and for a pattern that matches no file, which runs as typed; a pattern zsh refuses as bad keeps the glob reading alone
function globRun(
  cmd: Command,
  first: Word | undefined,
  env: Env,
  glob = !!first?.glob,
): Command[] | null | undefined {
  const pattern = first?.value ?? ""
  if (!first || !glob || marked(pattern) || SUBSCRIPTED.test(first.source ?? "")) return
  // a paren the shell sees, its backslash-newlines joined and its quoted parts masked at their length, since zsh reads a quoted paren as a plain character
  const seen = (first.source ?? "").replace(/\\\n/g, "").replace(QUOTED, maskQuoted)
  const grouped = seen.includes("(")
  // zsh reads a closing group with no | or ( in it as glob qualifiers, which pick among the files the rest matches and may run code there, and whose N lets a pattern that matches nothing vanish
  const qualifiers = grouped ? /\(([^()|]*)\)$/.exec(seen) : null
  const joined = pattern.replace(/\\\n/g, "")
  const groups = grouped
    ? groupWords(qualifiers ? joined.slice(0, joined.length - qualifiers[0].length) : joined)
    : [pattern]
  if (groups === null || qualifiers?.[1].includes("N")) return null
  // a pattern groupWords reads as bad keeps canary's glob reading, so the group reading only adds refusals
  const patterns = groups ?? [pattern]
  if ((!grouped || !groups) && !GLOB_PATTERN.test(pattern)) return
  const [only, ...more] = patterns
  // a group with no | and no glob character names one path (`pk(i)ll`), so under a folder the reader cannot read it is read as that path, which zsh runs when the folder holds it
  const unsure = !env.cwd || env.cwdUnread || env.cwdAnywhere
  if (more.length === 0 && !GLOB_PATTERN.test(only) && !isAbsolute(only) && unsure)
    return [
      { ...cmd, words: cmd.words.map((w) => (w === first ? { quoted: true, value: only } : w)) },
    ]
  const found: string[] = []
  for (const each of patterns) {
    const matched = globMatches(each, env)
    if (matched === null) return null
    found.push(...matched)
  }
  if (found.length > READINGS || (qualifiers && found.length > 0)) return null
  if (found.length === 0) return
  return found.map((value) => ({
    ...cmd,
    words: cmd.words.map((w) => (w === first ? { quoted: true, value } : w)),
  }))
}

// The paths a pattern matches, read from the disk segment by segment from the line's folder, a pattern with no glob character matching its own path when it exists; null when the reader cannot tell (globRun)
function globMatches(pattern: string, env: Env): string[] | null {
  const absolute = isAbsolute(pattern)
  if (!absolute && (!env.cwd || env.cwdUnread || env.cwdAnywhere)) return null
  const base = absolute ? "/" : (env.cwd as string)
  let paths = [""]
  for (const [k, part] of pattern.split("/").entries()) {
    const join = (path: string, name: string) => (k === 0 ? name : `${path}/${name}`)
    if (!GLOB_PATTERN.test(part)) {
      paths = paths.map((path) => join(path, part))
      continue
    }
    const glob = shellGlob(part)
    const next: string[] = []
    for (const path of paths) {
      let names: string[]
      try {
        names = readdirSync(resolve(base, path || "."))
      } catch (error) {
        if (/^(?:ENOENT|ENOTDIR)$/.test((error as { code?: string }).code ?? "")) continue
        return null
      }
      for (const name of names)
        if ((part.startsWith(".") || !name.startsWith(".")) && glob.match(name))
          next.push(join(path, name))
    }
    if (next.length > READINGS) return null
    paths = next
  }
  const found: string[] = []
  for (const path of paths) {
    try {
      lstatSync(resolve(base, path))
      found.push(path)
    } catch (error) {
      if (!/^(?:ENOENT|ENOTDIR)$/.test((error as { code?: string }).code ?? "")) return null
    }
  }
  return found
}

// The patterns a zsh group makes of a pattern word, each alternative of `(a|b)` in its place, nested groups expanded, a quoted part still in the word (a call's text, or a raw paren span the lexer keeps) holding its parens and bars as text and its quotes dropped, as zsh's glob matches it against files; undefined for a pattern zsh refuses as bad (an unclosed group, a / inside one), which globRun reads as canary did; null for one the reader cannot read: an extended glob character (#, ^, ~) inside a group, or more patterns than READINGS; spelling, for a guard's first look, reads #, ^ and ~ as text, as zsh does without EXTENDED_GLOB, and their alternative as any text too, up to braceWords' cap
function groupWords(pattern: string, spelling = false): string[] | null | undefined {
  // a quoted part, masked at its length, keeps its parens, bars and glob characters as text
  const seen = pattern.replace(QUOTED, maskQuoted)
  const open = seen.indexOf("(")
  if (open < 0) return seen.includes(")") ? undefined : [pattern.replace(QUOTED, unquote)]
  const cuts = [open]
  let close = -1
  for (let k = open, depth = 0; k < seen.length && close < 0; k++) {
    if (seen[k] === "(") depth++
    else if (seen[k] === "|" && depth === 1) cuts.push(k)
    else if (seen[k] === ")" && --depth === 0) close = k
  }
  if (close < 0 || pattern.slice(open, close).includes("/")) return undefined
  if (!spelling && /[#^~]/.test(seen.slice(open, close))) return null
  const out: string[] = []
  for (const [n, from] of cuts.entries()) {
    const alternative = pattern.slice(from + 1, cuts[n + 1] ?? close)
    // an alternative that holds an extended glob character spells as itself and as any text, which EXTENDED_GLOB may let it match
    const extended = spelling && /[#^~]/.test(seen.slice(from + 1, cuts[n + 1] ?? close))
    for (const each of extended ? [alternative, "*"] : [alternative]) {
      const words = groupWords(pattern.slice(0, open) + each + pattern.slice(close + 1), spelling)
      if (!words || out.push(...words) > (spelling ? BRACE_WORDS : READINGS))
        return words === undefined ? undefined : null
    }
  }
  return out
}

// A quoted part's text, its quotes and a backslash's escape dropped
const unquote = (part: string): string =>
  part.startsWith("\\")
    ? part.slice(1)
    : part.slice(1, part.endsWith(part[0]) && part.length > 1 ? -1 : undefined)

// A program word holding a brace list the shell sees (`/usr/bin/pk{i,x}ll`) runs as the words its expansion makes (braceWords), each lexed again, the first the program and the rest its first arguments, a brace or comma inside quotes or after a backslash kept as text, and a zsh group in them globbed after (`/usr/bin/pk{(i|x),y}ll`), as zsh expands braces first; null when the reader cannot expand it (a sequence, a list past braceWords' cap, an expansion in the word), so the command reads as unread; undefined for a word that also holds a paren the shell sees whose words do not lex as one command, code a guard reads as a line (`f({a, b})`), and for any other program word
function braceRun(cmd: Command, first: Word | undefined): Command | null | undefined {
  if (first?.unknown !== BRACE) return
  const source = (first.source ?? "").replace(/\\\n/g, "")
  if (/[$`]/.test(source)) return null
  const masked = source.replace(QUOTED, (part) => part.replace(/[{,}()]/g, hide))
  const grouped = masked.includes("(")
  const expanded = braceWords(masked)
  if (!expanded || expanded.some((w) => BRACE_LIST.test(w))) return null
  const words: Word[] = []
  for (const each of expanded) {
    const { commands } = lex(unhide(each))
    if (commands.length > 1 || commands[0]?.redirects.length) return grouped ? undefined : null
    words.push(...(commands[0]?.words ?? []))
  }
  if (words.length === 0) return null
  return { ...cmd, words: cmd.words.flatMap((w) => (w === first ? words : [w])) }
}

// A quoted part of a word, or a character after a backslash, whose braces and commas the shell's brace expansion leaves as text
const QUOTED = /'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|\\[\s\S]/g

// A brace, comma or paren as a private character braceWords passes over, put back once the words are made
const HIDDEN = "{,}()"
// A quoted part as one private character per character, past HIDDEN's, so a paren or bar inside it is never read as the shell's
const maskQuoted = (part: string) => "\uE005".repeat(part.length)
const hide = (c: string) => String.fromCharCode(0xe000 + HIDDEN.indexOf(c))
const HIDDEN_CHARS = new RegExp(`[${[...HIDDEN].map(hide).join("")}]`, "g")
const unhide = (text: string) => text.replace(HIDDEN_CHARS, (c) => HIDDEN[c.charCodeAt(0) - 0xe000])

// A program word that joins a read the split reading leaves whole (a quoted `"$X"`) to a typed glob part (`"$X"/pk?ll`), its read resolved with the held variables and then globbed; a glob character inside the held value is matched too, which errs toward a match
function heldGlob(cmd: Command, first: Word | undefined, env: Env): Command[] | null | undefined {
  if (!first?.glob || !first.raw || !marked(first.value)) return
  const value = relexedValue(first.raw, heldKnown(env))
  if (value === undefined || marked(value)) return
  const word = { ...first, value }
  return globRun({ ...cmd, words: cmd.words.map((w) => (w === first ? word : w)) }, word, env, true)
}

// The characters a glob reads as a pattern, a lone `[` aside, which is test's own name
const GLOB_PATTERN = /[*?]|\[[^\]]*\]/

// One path part's pattern as the shell reads it, where a leading `!` is a plain character rather than Bun.Glob's negation, and a POSIX class (`[:alpha:]`), equivalence class (`[=a=]`) or collating symbol (`[.a.]`) inside a bracket is the set it names, which Bun.Glob does not read; a class it cannot spell as ranges takes every printable character, so it errs toward a match
const shellGlob = (part: string) =>
  new Bun.Glob(
    part.replace(/^!/, "\\!").replace(BRACKET, (bracket: string) =>
      bracket
        .slice(1, -1)
        .replace(/\[:([a-z]+):\]/g, (_, name: string) => POSIX_CLASSES[name] ?? " -~")
        .replace(/\[([=.])(.)\1\]/g, "$2")
        .replace(/^/, "[")
        .concat("]"),
    ),
  )

// A bracket expression, its classes inside it whole, so `[[:alpha:]]` is one set while a lone `[:k:]` is a set of `:` and `k`
const BRACKET = /\[[!^]?\]?(?:\[:[a-z]+:\]|\[([=.]).\1\]|[^\]])*\]/g

// The POSIX bracket classes as Bun.Glob's ranges, in the C locale
const POSIX_CLASSES: Record<string, string> = {
  alnum: "0-9A-Za-z",
  alpha: "A-Za-z",
  blank: " \t",
  digit: "0-9",
  lower: "a-z",
  space: " \t\n\r\f\v",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
}

// Whether a call's text holds a glob whose last path part may match one of these program names (`pk?ll`, `/usr/bin/g*`, `[p][k]ill`), so a guard's first look at a call, and its rule for a command it cannot read, count the call as naming that program; a part of `*` and `?` alone names none, since it matches every name of its length
export function globSpells(text: string, names: string[]): boolean {
  for (const token of text.split(/[\s;&|<>()`"'\\]+/)) {
    const part = token.slice(token.lastIndexOf("/") + 1)
    if (!GLOB_PATTERN.test(part) || /^[*?]+$/.test(part)) continue
    const glob = shellGlob(part)
    if (names.some((name) => glob.match(name))) return true
  }
  return false
}

// A call's text, then each word holding a brace list or a zsh group again as the words it makes, its backslash-newlines joined, its backslashes dropped and, once the words are made, its quotes (braceWords, groupWords, which keeps a quoted part's parens as text, a closing group with no | dropped as zsh's qualifiers), so a guard's first look for a program's name sees `pk{i,x}ll`, `p"k"{i,x}ll` and `pk(i|x)ll` as the name they spell; a brace sequence is spelled as a glob beside its word (sequenceSpelling) and a list or group past the cap as any text (anyText), which globSpells matches, and a spelled word whose last path part keeps no literal character as ANY_NAME too; each token is read again cut before each `$(` and at a pipe before a paren, each part without a leading paren, `$(` or quote, beside its typed form
export function spelledText(text: string): string {
  const plain = text.replace(/\\\n/g, "").replace(/\\/g, "")
  const spelled = [...plain.split(/[\s;&<>`]+/), ...blankGroups(plain)]
    .flatMap((token) => {
      // a subshell's, a substitution's or a zsh `=(…)` process substitution's opening paren (an assignment's value or an array's element too), a script's opening quote, or a pipe before a subshell, glued to the program word after it; the line split already cuts `<(` and `>(` at their `<` and `>`
      const parts = token
        .split(/(?=[$=]\()|\|+(?=\()/)
        .map((part) => part.replace(/^(?:[$=]?\(|['"])+/, ""))
      return [token, ...parts.filter((part) => part !== token)]
    })
    .filter((token) => /[{(]/.test(token))
    .flatMap((token) =>
      (braceWords(token) ?? anyText(token, /\{[^{}]*\}/g)).flatMap((word) => {
        const sequenced = word.replace(SEQUENCE, sequenceSpelling)
        const unqualified = sequenced.replace(/\([^()|]*\)$/, "")
        const words = groupWords(unqualified, true)
        const out = words === null ? anyText(unqualified, /\([^()]*\)/g) : (words ?? [word])
        return sequenced === word ? out : [word, ...out]
      }),
    )
    .map((word) => word.replace(/["']/g, ""))
    .flatMap((word) =>
      /^[*?]+$/.test(word.slice(word.lastIndexOf("/") + 1)) ? [word, ANY_NAME] : [word],
    )
  return spelled.length > 0 ? `${text} ${spelled.join(" ")}` : text
}

// Each zsh group holding a blank (`(r|x y)m`), with the word's parts glued to it, which the line split cuts apart, so spelledText spells it too
function blankGroups(text: string): string[] {
  const out: string[] = []
  for (const { 0: group, index } of text.matchAll(/\([^()\s]*\s[^()]*\)/g)) {
    let from = index
    while (from > 0 && !BETWEEN.test(text[from - 1])) from--
    let to = index + group.length
    while (to < text.length && !BETWEEN.test(text[to])) to++
    out.push(text.slice(from, to))
  }
  return out
}
const BETWEEN = /[\s;&<>`]/

// A brace sequence (`{a..c}`, `{1..9..2}`), which braceWords leaves as written
const SEQUENCE = /\{(-?\d+|[^{},.\s])\.\.(-?\d+|[^{},.\s])(?:\.\.-?\d+)?\}/g

// A sequence of letters as the bracket of its range, any increment read as 1, one of numbers as text led by a digit or a minus, which no guarded program's name is, and any other as any text, since a bracket can read its ends as a negation or a close
const sequenceSpelling = (_: string, from: string, to: string): string =>
  /^[A-Za-z]$/.test(from) && /^[A-Za-z]$/.test(to)
    ? `[${from < to ? from : to}-${from < to ? to : from}]`
    : /^-?\d+$/.test(from) && /^-?\d+$/.test(to)
      ? "[0-9-]*"
      : "*"

// A word whose lists or groups make more words than the cap, each innermost one as any text until none is left, so a guard's first look reads it as a glob that may spell its program
function anyText(word: string, part: RegExp): string[] {
  const spelled = word.replace(part, "*")
  return spelled === word ? [word] : anyText(spelled, part)
}

// A glob every program name matches that globSpells still reads, for a spelled word whose last path part keeps no literal character, which globSpells passes over as matching every name
const ANY_NAME = "[!.]*"

// A loop runs its body again after every change the pass before made, so a run of commands a loop or a count may repeat takes, before its first is read, each change its commands make and an unread value for each held variable it assigns, which a later pass reads (d-2047r); a scope the walk has not entered yet copies these from the one around it
function repass(commands: Command[], envs: Map<number, Env>): void {
  for (const cmd of commands) {
    if (!cmd.repeated) return
    const env = envs.get(cmd.scope)
    if (!env) continue
    change(cmd, env)
    const { local, name } = parse(cmd)
    if (name !== "") continue
    for (const key of local.keys()) if (env.vars.has(key)) setVar(env.vars, key, CHANGED)
  }
}

// Whether print -v or printf -v sets its name to a format of plain text with a word in it, which no argument can leave empty: no `%` and no `\\`
function printsText(words: string[]): boolean {
  const v = words.findIndex((w) => w === "-v" || /^-v\w/.test(w))
  const format = words[v + (words[v] === "-v" ? 2 : 1)]
  return v >= 0 && format !== undefined && !marked(format) && /^[^%\\]*\S[^%\\]*$/.test(format)
}

// A binder (`binds`) gives its names a value the reader cannot read in walk order, or a for or select list's one literal word (loopWord), in its own scope: a for or select header for its body, its value captured in place of the one held before (heldResolved), and changed at its close, where its captured value (the loop's word, or the one its body set) and the one held before the loop (loopBefore) are both read, since its list may be empty and its body may set them; any other binder for the commands after it, where the shell runs it unconditionally there
function bind(commands: Command[], k: number, env: Env, unbind: Map<Command, () => void>): void {
  const cmd = commands[k]
  const names = binds(cmd)
  if (names.length === 0 || cmd.detached) return
  const close = loopHeader(cmd) ? loopClose(commands, k) : undefined
  if (!close && (loopHeader(cmd) || cmd.unsure || cmd.chained || cmd.kept)) return
  const value = close ? loopWord(cmd) : undefined
  const held = close ? heldKnown(env) : {}
  const prior = names.flatMap((name) => (name in held ? [[name, held[name]] as const] : []))
  for (const name of names) setVar(env.vars, name, value ?? unknown("a value a builtin gives"))
  if (!close) return
  for (const name of names) capture(env, name, value)
  unbind.set(close, () => {
    for (const name of names) setVar(env.vars, name, CHANGED)
    if (prior.length === 0) return
    let record = loopBefore.get(env.vars)
    if (!record) loopBefore.set(env.vars, (record = {}))
    for (const [name, was] of prior) record[name] = was
  })
}

// A loop's name captured as its one literal word, or with no capture, so a value set before the loop is not read in its place
function capture(env: Env, key: string, value?: Word): void {
  if (value) recordHeld(env, key, value)
  else delete heldResolved.get(env.vars)?.[key]
}

// The one word a for or select header's literal list holds (`for c in git`, `for c in 'git push'`), which its body reads as written; undefined for any other list, which binds a value the reader cannot read
function loopWord({ words }: Command): Word | undefined {
  const at = words.findIndex((w) => w.value === "in" && !w.quoted)
  const list = at < 0 ? [] : words.slice(at + 1)
  return list.length === 1 && !unreadWord(list[0]) ? list[0] : undefined
}

// The leading words of a command the shell reads as reserved, an opening or a closing word, in order (`do for`, `done`, `{ read`)
function heads({ words }: Command): string[] {
  const out: string[] = []
  for (const w of words) {
    if (w.quoted || !(RESERVED.has(w.value) || OPENS.has(w.value) || CLOSES.has(w.value))) break
    out.push(w.value)
  }
  return out
}

const loopHeader = (cmd: Command): boolean => {
  const last = heads(cmd).at(-1)
  return last === "for" || last === "select"
}

// The command whose `done` closes the loop the header at k opens, by counting the opening and closing words after it
function loopClose(commands: Command[], k: number): Command | undefined {
  let depth = 1
  for (const cmd of commands.slice(k + 1))
    for (const word of heads(cmd)) {
      if (CLOSES.has(word) && --depth === 0) return cmd
      if (OPENS.has(word)) depth++
    }
}

const subshell = (env: Env): Env => ({ ...env, vars: new Map(env.vars) })

// Whether a program word is spelled plainly: one name once its quotes and backslashes are removed, with no glob, zsh group, brace list or extendedglob operator (`#`, `^`, a `~` past the start) outside quotes, no leading `=` (zsh's path lookup), no ANSI-C escape, and no expansion but a folder the session's starting env names (`PLAIN_PREFIXES`) as a plain `$NAME`, `${NAME}`, `${NAME:?…}` or `${NAME:-<a default with no $ or backquote>}` before a slash, never one the line sets or `changed` names; `[` and `[[` stay plain, as zsh reads a bracket with no close as itself
export function plainProgram(
  first: Word,
  env: Env,
  changed: ReadonlySet<string> = new Set(),
): boolean {
  const source = first.source ?? first.value
  if (marked(first.value) && !/[$`]/.test(source)) return false
  let bare = ""
  let quote = ""
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quote === "'") {
      if (c === "'") quote = ""
    } else if (c === "\\") i++
    else if (quote === "" && c === "'") quote = "'"
    else if (quote === "" && c === "$" && source[i + 1] === "'") {
      const close = source.indexOf("'", i + 2)
      if (close < 0 || source.slice(i + 2, close).includes("\\")) return false
      i = close
    } else if (c === '"') quote = quote === '"' ? "" : '"'
    else if (c === "`") return false
    else if (c === "$") {
      const named = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)(?::[?-][^}$`]*)?\})/.exec(
        source.slice(i),
      )
      const name = named?.[1] ?? named?.[2]
      if (!named || !name || !PLAIN_PREFIXES.has(name) || env.vars.has(name) || changed.has(name))
        return false
      i += named[0].length - 1
      if (
        !source
          .slice(i + 1)
          .replace(/^"/, "")
          .startsWith("/")
      )
        return false
    } else if (quote === "") {
      if ((c === "=" && i === 0) || (c === "~" && i > 0)) return false
      bare += c
    }
  }
  return !/[*?(#^]|\[[^\]]*\]|\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(bare)
}
// The variables a program word may name a folder by: the session's home, and the Playground checkout the factory's docs spell spawn.sh's path with
export const PLAIN_PREFIXES = new Set(["HOME", "PLAYGROUND_REPO"])

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
  const vanished = emptyProgram(cmd, env)
  const array = arrayRun(cmd, primary.first, env)
  // a name a loop bound reads after its done as the value it held before the loop too (loopBefore), as canary's reader read it; that reading is judged but resolves nothing, so a loop value the reader cannot read still marks the command unread
  const prior = splitHeld(cmd, primary.name, env, true)
  const split = splitHeld(cmd, primary.name, env)
  // a held value split into the program word is globbed as the shell globs an unquoted expansion (`X=/usr/bin; $X/pk?ll`)
  const brace = braceRun(cmd, primary.first)
  const globs = [
    brace === null ? null : undefined,
    globRun(cmd, primary.first, env),
    heldGlob(cmd, primary.first, env),
    ...[...split, ...prior].map((v) => globRun(v, parse(v).first, env, true)),
    ...(brace ? [globRun(brace, parse(brace).first, env)] : []),
    ...vanished.map((v) => globRun(v, parse(v).first, env)),
  ]
  const resolving = [
    ...split,
    ...(array ? [array] : []),
    ...(brace ? [brace] : []),
    ...heldScripts(cmd, primary, env),
    ...globs.flatMap((globbed) => globbed ?? []),
  ]
  if (globs.includes(null) || unreadCommand(cmd, primary, resolving))
    for (const parsed of [primary, ...others]) parsed.unread = true
  const expanded = [
    ...expandTilde(cmd, primary.name, env),
    ...resolving,
    ...prior,
    ...vanished,
    ...(await xargsFilled(cmd, [primary, ...others], env)),
  ]
  // only the primary reading moves the folder, sets variables and records files, as canary's one reading did; each other runs on a copy of the env before the command
  const before = others.length > 0 || expanded.length > 0 ? apart(env) : env
  const verdict = await examineReading(cmd, primary, env, visit, builtins)
  if (verdict) return verdict
  for (const parsed of others) {
    if (runsScript(parsed, readingEnv(cmd, parsed, before))) continue
    const verdict = await examineReading(cmd, parsed, apart(before), visit, builtins)
    if (verdict) return verdict
  }
  for (const variant of expanded) {
    const verdict = await examineExpanded(cmd, variant, before, visit, builtins)
    if (verdict) return verdict
  }
  // a cd behind words that may expand to none may run or not, so the folder it names joins those the shell may be in, as an `||`'s cd does
  for (const variant of vanished) {
    const parsed = parse(variant)
    if (MOVES.has(parsed.name))
      await chdirTo(parsed.name, { ...variant, unsure: true }, parsed, env)
  }
  // piped input the command may run as code is judged as a script it runs, unless its own reading took that input as its script already; ssh's stdin, a redirect's included, as one the remote side runs from the login's home
  const remote =
    primary.name === "ssh" && ["root", "shell"].includes(stdinShellOf(cmd, primary) ?? "")
  if (!remote && (!cmd.runsStdin || stdinScript(primary))) return
  for (const script of await scriptStdin(cmd, env)) {
    const at = remote ? remoteEnv(env, known(script), true) : subshell(env)
    const verdict = await nested(cmd, env, () =>
      run(lexScript(known(script), at), at, visit, builtins),
    )
    if (verdict) return verdict
  }
}

// The words of an eval, and a shell's -c script, that hold an expansion the lexer could not read, each re-lexed with the variables the line set (`S='git push'; eval "$S"`, `sh -c "$S"`), so the script is read as the shell builds it; none when no such word resolves to more than it was
function heldScripts(cmd: Command, parsed: Parsed, env: Env): Command[] {
  const scripts = scriptWords(parsed).filter((w) => w.raw && marked(w.value))
  if (scripts.length === 0) return []
  const known = heldKnown(env)
  let resolved = false
  const words = cmd.words.map((w): Word => {
    if (!scripts.includes(w) || !w.raw) return w
    const value = relexedValue(w.raw, known)
    if (value === undefined || value === w.value) return w
    resolved = true
    return { quoted: true, value }
  })
  return resolved ? [{ ...cmd, words }] : []
}

// The words that are a command's script: an eval's arguments past a leading `--`, or a shell's -c operand
function scriptWords({ args, name }: Parsed): Word[] {
  if (name === "eval") return args[0]?.value === "--" ? args.slice(1) : args
  if (!SHELLS.has(name)) return []
  const { inline, operand } = shellOperand(args, name)
  return inline && operand ? [operand] : []
}

// Whether a command's program word, or its eval's or shell -c's script, is built from an expansion the reader cannot read and no other reading resolves: the program word marked, written as an expansion, with no split or array reading naming a readable one, or a script word marked with none reading it whole
function unreadCommand(cmd: Command, parsed: Parsed, resolving: Command[]): boolean {
  const others = resolving.map(parse)
  // a program word the walk lexed from a script's unread part (`eval "$X"`'s) carries no expansion of its own: the script word that held it is the unread one
  if (marked(parsed.name))
    return /[$`]/.test(parsed.first?.source ?? "") && others.every((p) => marked(p.name))
  if (!scriptWords(parsed).some((w) => marked(w.value))) return false
  return others.every((p) => scriptWords(p).some((w) => marked(w.value)))
}

// A call's text, then again with each ANSI-C string decoded in its place, so a guard's look for a program's name in the text sees `$'\x67it'` and `g$'\x69't` as git, in an array's list too
export const decodedText = (command: string): string =>
  command.includes("$'")
    ? `${command} ${command.replace(/\$'(?:[^'\\]|\\[\s\S])*'/g, (ansiC) =>
        lex(ansiC)
          .commands.flatMap((c) => c.words.map((w) => w.value))
          .join(" "),
      )}`
    : command

// Whether an unread reading's program word is an array run whole (`"${A[@]}"`) or a glob, the unread commands no-stash and no-raw-delete refuse in a call that names their program
export const unreadRun = ({ first, unread }: Parsed): boolean =>
  !!unread && (!!first?.glob || WHOLE_RUN.test(first?.raw ?? first?.source ?? ""))

// Whether a shell or a source reads its script from stdin, as shell() and examineReading read it
function stdinScript({ args, name }: Parsed): boolean {
  if (name === "." || name === "source") return STDIN_PATHS.has(args[0]?.value ?? "")
  if (!SHELLS.has(name)) return false
  const { inline, operand } = shellOperand(args, name)
  return !operand || (!inline && STDIN_PATHS.has(operand.value))
}

// The text GNU xargs' -a reads in place of stdin: a process substitution's output, else the file, which readPath reads only when it is a regular file within MAX_BYTES, so any other reads as unread; a relative path from env -C's folder before xargs, as examineReading's `here` reads it, and any file as unread after a privilege wrapper, which may move the folder or the root
async function argFile(
  { chdir, file, moved }: NonNullable<NonNullable<Xargs>["files"]>[number],
  cmd: Command,
  env: Env,
): Promise<Text> {
  if (file.procs) return held(await outputs(file.procs, env))
  if (moved)
    return unknown(
      `${file.value}, which a privilege wrapper before xargs may read from another folder or root`,
    )
  const cwd = chdir && pathOf(landsHeld(chdir, cmd, env) ?? chdir, env)
  return held(await readPath(file, chdir && !isAbsolute(file.value) ? { ...env, cwd } : env))
}

// The texts xargs may fill in from one input: by default (`split` null) the whole, each line and each blank-separated item (-n), and under a -d or -0 delimiter the whole and each item it splits off; undefined when the reader cannot read the input or decode the delimiter
const itemsOf = (fed: Text, split: string | null | undefined): string[] | undefined => {
  if (fed.unknown || split === undefined) return
  if (split === null) return [fed.value, ...fed.value.split("\n"), ...fed.value.split(/\s+/)]
  return [fed.value, ...fed.value.split(split)]
}

// The readings of a command whose program word, or a wrapper's name after xargs, holds xargs' replace string (GNU -I, -i, --replace, BSD -J) or an outer xargs' one, which xargs fills from its input, so it runs a program no typed word names: each such word filled with each text itemsOf reads from stdin and from each file GNU's -a names (stdin's name aside, which stdin's reading covers), split by default and at each -d or -0 delimiter, a text holding a quote or a backslash with them stripped, as xargs strips them, and split at blanks into the words xargs runs; or unread when the hook cannot read an input or decode a delimiter, one input's split holds more texts than READINGS, or a text holds a quote or a backslash, so each guard's rule for an unread program applies. Each is judged beside the typed reading, so a verdict only moves to refused.
async function xargsFilled(cmd: Command, parsed: Parsed[], env: Env): Promise<Command[]> {
  const filled = new Map<Word, string[]>()
  for (const [word, replace] of parsed.flatMap((p) => p.xargs?.filled ?? []))
    filled.set(word, [...new Set([...(filled.get(word) ?? []), replace])])
  if (filled.size === 0) return []
  const xargs = parsed.map((p) => p.xargs)
  const files = xargs.flatMap((x) => x?.files ?? []).filter((f) => !STDIN_PATHS.has(f.file.value))
  const splits = [null, ...new Set(xargs.flatMap((x) => x?.delimiters ?? []))]
  const inputs = [
    await stdinOf(cmd, env),
    ...(await Promise.all(files.map((f) => argFile(f, cmd, env)))),
  ]
  const texts = new Set<string | undefined>()
  for (const raw of inputs.flatMap((fed) => splits.map((split) => itemsOf(fed, split)))) {
    const items = [...new Set(raw?.map((text) => text.replace(/["'\\]/g, "").trim()))].filter(
      Boolean,
    )
    if (!raw || items.length > READINGS) texts.add(undefined)
    else for (const text of items) texts.add(text)
    if (raw?.some((text) => /["'\\]/.test(text))) texts.add(undefined)
  }
  const fill = (text: string | undefined) => ({
    ...cmd,
    words: cmd.words.flatMap((w): Word[] => {
      const held = filled.get(w)
      if (!held) return [w]
      if (text === undefined)
        return [{ ...w, ...unknown(`the program xargs puts in place of ${held.join(" or ")}`) }]
      return held
        .reduce((value, replace) => value.replaceAll(replace, text), w.value)
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => ({ quoted: false, value }))
    }),
  })
  return [...texts].map(fill)
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

// A word that is one or more bare variable reads and nothing else (`$C`, `${C}`, `$C""`, `$P$Q`, zsh's braced `${=C}` and bare `$=C`), its quotes and split flag stripped: splitting such a word reveals a held command or a held run-slot framing. A word that holds a read among literal text (`$C/x`, `/usr/bin/$C`, `$C.sh`) is split only where it is the program word, since resplitting such an argument (`$D/README.md`) would re-judge what the typed reading already read.
const holdsCommand = (w: Word): boolean =>
  !!w.source &&
  /^(?:\$\{\w+\}|\$\w+)+$/.test(
    w.source
      .replace(/["']/g, "")
      .replace(/\$\{[=~^]+/g, "${")
      .replace(/\$[=~^](?=\w)/g, "$"),
  )

// The split readings of a command: each word that holds a command (holdsCommand), and the program word where it holds a read among literal text (`$C/x`, `/usr/bin/$C`), re-lexed with the variables the line set, resolved through one another, and split at blanks and the line's IFS, each unread part kept as one unread word so the program word is still judged (`C="git push"; $C`, `$C""`, `${=C}`, a copy `A=git; C=$A; $C`, a partial `C="git push $X"; $C`). A word whose read resolves to nothing the reader can build (an unset variable, a loop's own `$n`) keeps its typed reading, so the split never hands a guard an unread word the typed reading did not already hold. It is judged beside the typed reading, so a verdict only moves to refused; none when no word resolves to a readable part, and a cd keeps its own words, which chdirTo reads.
export function splitHeld(cmd: Command, name: string, env: Env, prior = false): Command[] {
  if (name === "cd" || name === "popd" || name === "pushd") return []
  // the program word is resolved only when a read sharing its word with literal text could be it, so an ordinary line pays no extra parse
  const first = cmd.words.some((w) => w.splits && w.raw && !holdsCommand(w))
    ? parse(cmd).first
    : undefined
  const holds = (w: Word): boolean => !!w.splits && !!w.raw && (holdsCommand(w) || w === first)
  if (!cmd.words.some(holds)) return []
  const known = heldKnown(env)
  const seps = ifsSplit(env)
  const splitWith = (known: Record<string, string>): Command[] => {
    let split = false
    const words = cmd.words.flatMap((w): Word[] => {
      if (!holds(w) || !w.raw) return [w]
      const value = relexedValue(w.raw, known)
      if (value === undefined) return [w]
      const parts = splitValue(value, seps)
      // nothing the reader could build, so the word stays as typed and the split adds no unread word of its own
      if (!parts.some((part) => !part.unknown)) return [w]
      split = true
      return parts
    })
    return split ? [{ ...cmd, words }] : []
  }
  if (!prior) return splitWith(known)
  const before = loopBefore.get(env.vars)
  return before && Object.keys(before).length > 0 ? splitWith({ ...known, ...before }) : []
}

// A raw word re-lexed with the known variables, its value kept even where an unread part stays; undefined when the lexer makes other than one word (a substitution of its own), as relexed drops it. zsh's `${=V}` split flag is stripped so the braced read resolves, since the split reading splits the value anyway.
function relexedValue(raw: string, known: Record<string, string>): string | undefined {
  const words = lex(raw.replace(/\$\{[=~^]+/g, "${"), known).commands.at(-1)?.words
  return words?.length === 1 ? words[0].value : undefined
}

// The home an unquoted assignment expands the value's leading ~ to (`S=~/x`), which the held value keeps as written; a quoted value (`S="~/x"`) keeps its ~ literal, as bash does, so a quoted assignment passes quoted true; splitValue still reads each split word's leading ~ as the home, which errs toward refusing.
const tildeHome = (value: string, quoted = false): string =>
  quoted || marked(value) ? value : value.replace(/^~(?=\/|$)/, homedir())

// The variables the line set whose value the reader can build, each resolved through those set before it and an unread part kept, over the base environment; a copy's raw holds `key=value`, so its value is read after the first `=`. A copy's value captured where it was set (heldResolved) overrides this read, so a later reassignment of its source does not leak in; the read stands alone across a scope copy, whose fresh vars map carries no capture.
function heldKnown(env: Env): Record<string, string> {
  const known: Record<string, string> = { ...env.known }
  for (const [key, text] of env.vars) {
    if (!text.unknown && !marked(text.value))
      known[key] = tildeHome(text.value, "quoted" in text && text.quoted === true)
    else if ("raw" in text && typeof text.raw === "string") {
      const value = relexedValue(text.raw, known)
      const eq = value?.indexOf("=") ?? -1
      if (value !== undefined && eq >= 0) known[key] = tildeHome(value.slice(eq + 1))
    }
  }
  return Object.assign(known, heldResolved.get(env.vars))
}

// Each scope's loop names after their loop's done, each with the value it held before the loop, which the split reading reads beside its captured one, so a read after the loop is judged as both the loop's word and the value before it
const loopBefore = new WeakMap<Map<string, Text>, Record<string, string>>()

// Each scope's variables resolved to the value they held where they were set, so a copy reads its source's value at the copy and a later reassignment of that source does not change it; recordHeld fills it at each assignment the reader reads.
const heldResolved = new WeakMap<Map<string, Text>, Record<string, string>>()
function recordHeld(env: Env, key: string, value: Text): void {
  delete loopBefore.get(env.vars)?.[key]
  let record = heldResolved.get(env.vars)
  if (!record) heldResolved.set(env.vars, (record = {}))
  if (!value.unknown && !marked(value.value))
    record[key] = tildeHome(value.value, "quoted" in value && value.quoted === true)
  else if ("raw" in value && typeof value.raw === "string") {
    const built = relexedValue(value.raw, { ...env.known, ...record })
    const eq = built?.indexOf("=") ?? -1
    if (built !== undefined && eq >= 0) record[key] = tildeHome(built.slice(eq + 1))
  }
}

// The separators the shell splits a word at: blanks always, and the characters a line set IFS to a literal, so `IFS=:; C="a:b"; $C` splits at the colon too; an IFS the reader cannot read stays blanks alone, a residual the README names.
function ifsSplit(env: Env): RegExp {
  const ifs = env.vars.get("IFS")
  if (!ifs || ifs.unknown || marked(ifs.value) || !ifs.value) return /\s+/
  return new RegExp(`[\\s${ifs.value.replace(/[\]\\^-]/g, "\\$&")}]+`)
}

// The words a value splits into, each unread part (a `$X` or a substitution the reader could not build) kept as one unread word in its place, so the program word stays literal and every guard judges it.
function splitValue(value: string, seps: RegExp): Word[] {
  return value
    .split(seps)
    .filter(Boolean)
    .map((part) =>
      marked(part)
        ? { quoted: false, unknown: "a shell variable", value: part }
        : { quoted: false, value: tildeHome(part) },
    )
}

// One part of a word the shell may expand to no word: a bare read (`$X`, `$@`, `$*`, `$1`, zsh's `$=X`, `$~X`), a braced read of a name, an array or an indirection whose operator yields nothing on an unset or empty value (`${X}`, `${X:-}`, `${X=}`, `${X:+y}`, `${X#a}`, `${X/a/b}`, `${X:0}`, `${X[@]}`, `${!X}`, zsh's `${=X}`), or a quoted `"$@"` or `"${X[@]}"`, which expands to no word with no elements
const VANISHING_PART =
  /\$[=~^]*(?:\w+|[@*])|\$\{[=~^]*!?(?:\w+|[@*])(?:\[[@*]\])?(?::?[-=]|:?\+[^{}]*|(?:#|%|\/|:(?![-=?+]))[^{}]*)?\}|"\$(?:@|\{@\}|\{\w+\[@\]\})"/y
const MOVES = new Set(["cd", "popd", "pushd"])

// Whether a source is made of VANISHING_PART alone
const vanishingParts = (source: string): boolean => {
  VANISHING_PART.lastIndex = 0
  while (VANISHING_PART.lastIndex < source.length) if (!VANISHING_PART.exec(source)) return false
  return true
}

// read's options that take a value, which binds no name (bash manual, Bourne Shell Builtins and Bash Builtins: read)
const READ_VALUES = new Set(["d", "i", "n", "N", "p", "t", "u"])
const NAME = /^[A-Za-z_]\w*$/
// An array element's assignment or an append as written, its name captured: `A[1]=x`, `A[$k]+=x`, zsh's `A[1]=()`, `A+=(x)`
const SUBSCRIPTED = /^([A-Za-z_]\w*)(?:\[[^\]]*\]\+?|\+)=/
// A whole array run as written, its name captured: `"${A[@]}"`, `${A[@]}`
const WHOLE_RUN = /^(?:"\$\{([A-Za-z_]\w*)\[@\]\}"|\$\{([A-Za-z_]\w*)\[[@*]\]\})$/

// The names one command gives a value without an `=` (bind reads them), each at its builtin's binding place as the bash manual gives it: `for NAME in`, `select NAME in`, `read [options] NAME…` and its `-a NAME`, `getopts OPTSTRING NAME` and `printf -v NAME`; a declaration builtin gives none, its `=` part read as an assignment
function binds({ words }: Command): string[] {
  let at = 0
  while (
    at < words.length &&
    ((!words[at].quoted && RESERVED.has(words[at].value)) || ASSIGN.test(words[at].value))
  )
    at++
  const [head, ...rest] = words.slice(at).map((w) => w.value)
  if (head === "for" || head === "select") return rest[0] && NAME.test(rest[0]) ? [rest[0]] : []
  if (head === "getopts") return rest[1] && NAME.test(rest[1]) ? [rest[1]] : []
  if (head === "printf") {
    const v = rest.findIndex((w) => w === "-v" || /^-v\w/.test(w))
    const name = v < 0 ? undefined : rest[v] === "-v" ? rest[v + 1] : rest[v].slice(2)
    return name && NAME.test(name) ? [name] : []
  }
  if (head !== "read") return []
  const names: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]
    if (w === "--" || !w.startsWith("-") || w.length < 2) {
      names.push(...rest.slice(w === "--" ? i + 1 : i))
      break
    }
    // a cluster's last letter takes its value attached or as the next word: `-a NAME` binds it, every other value binds none
    const letters = w.slice(1)
    const taker = [...letters].findIndex((c) => c === "a" || READ_VALUES.has(c))
    if (taker < 0) continue
    const value = letters.slice(taker + 1) || rest[++i]
    if (letters[taker] === "a" && value) names.push(value)
  }
  return names.filter((w) => NAME.test(w))
}

// Whether a word may expand to no word: the reader read none of it, and it is VANISHING_PART alone with every variable it names one the line never set (a binder sets one, `binds`), set to nothing or blanks alone, or one a builtin may have changed (`change`), or an unread part of a word a script the line built carries (`eval $X …`, `bash -c "$X …"`), which keeps no source of its own
const mayVanish = (w: Word, env: Env): boolean =>
  maySkip(w) &&
  [...(w.source ?? "").matchAll(/\$\{?[=~^]*!?(\w+)/g)].every(([, name]) => {
    const set = env.vars.get(name)
    // a value of blanks alone splits to no word under bash's default IFS and any IFS holding them
    return !set || !!set.vanishes || (!set.unknown && /^[ \t\n]*$/.test(set.value))
  })

// The empty reading of a command: each program word that may expand to no word (mayVanish) dropped, until one that stays leads, so the word after it is judged as the program (`$X git commit`, `nice $X git commit`, `$X $Y git commit`); none when the program word stays. It is judged beside the typed reading, so a verdict only moves to refused.
function emptyProgram(cmd: Command, env: Env): Command[] {
  if (!cmd.words.some((w) => mayVanish(w, env))) return []
  let words = cmd.words
  for (let { first } = parse(cmd); first && words.includes(first) && mayVanish(first, env);) {
    const dropped = first
    words = words.filter((w) => w !== dropped)
    ;({ first } = parse({ ...cmd, words }))
  }
  return words === cmd.words ? [] : [{ ...cmd, words }]
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

// The folder a reading runs in: env -C's or a runner's folder option runs the command in the folder it names, wherever the shell is, so its own reading of the folder, or the literal absolute path a steady variable there holds, replaces every other; a runner's program whose folder the reader cannot place is judged in the shell's own folder, as the runner's own reading is
function readingEnv(cmd: Command, { chdir, via }: Parsed, env: Env): Env {
  const into = chdir && pathOf(landsHeld(chdir, cmd, env) ?? chdir, env)
  if (!chdir || (via && into === undefined)) return env
  return {
    ...env,
    cwd: into,
    cwdHeld: [],
    cwdMaybe: [],
    cwdSure: into,
    cwdUnread: into === undefined,
  }
}

async function examineReading(
  cmd: Command,
  parsed: Parsed,
  env: Env,
  visit: Visit,
  builtins: boolean,
): Promise<string | undefined> {
  const { args, local, name } = parsed
  const here = readingEnv(cmd, parsed, env)
  let verdict: string | undefined
  const followed = SHELLS.has(name) || [".", "cd", "eval", "popd", "pushd", "source"].includes(name)
  if (followed && builtins && cmd.redirects.length > 0) {
    const bare = { ...cmd, bareOf: cmd, words: [] }
    verdict = await visit(bare, parse(bare), here)
    if (verdict) return verdict
  }
  if (name === "") {
    for (const [key, value] of local) {
      setVar(env.vars, key, value)
      recordHeld(env, key, value)
    }
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
      const value = slice(w, eq + 1)
      setVar(env.vars, w.value.slice(0, eq), value)
      recordHeld(env, w.value.slice(0, eq), value)
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
        run(again(lexScript(evalText(args), env), cmd, parsed), here, visit, builtins),
      ))
  } else verdict = await visit(cmd, parsed, here)
  await record(cmd, name, args, here)
  return verdict
}

// The script an eval runs: its words joined by spaces, past a leading `--`, which bash's and zsh's eval take as the end of its options
const evalText = (args: Word[]): string =>
  (args[0]?.value === "--" ? args.slice(1) : args).map((a) => a.value).join(" ")

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
    .some((w) => !w.quoted && REPEATS.has(program(w.value)))

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
async function cdTarget(
  name: string,
  cmd: Command,
  args: Word[],
  env: Env,
): Promise<string | undefined> {
  const typedDir = args.find((a) => !(a.value.startsWith("-") && a.value.length > 1))
  if (!typedDir) return homedir()
  // a steady variable holding a literal absolute path reads as that path typed (landsHeld), so a hook that reads `cwd` alone judges the folder it lands in
  const dir = landsHeld(typedDir, cmd, env) ?? typedDir
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

// The folder word a steady variable holds as a literal absolute path with no glob, colon or blank (`W=/abs; cd "$W"`), which a cd or env -C lands in as if typed; undefined for any other value, a relative one included, which stays unread, and so for one holding a colon or a blank, which sh_word_split splits into zsh's two-operand cd
const landsHeld = (word: Word, cmd: Command, env: Env): Word | undefined => {
  const held = env.hold?.(word, cmd, env)
  return held && isAbsolute(held.value) && !held.glob && !/[:\s]/.test(held.value)
    ? held
    : undefined
}

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
    // a steady variable's value is read in, so its target, and whether it climbs, is the folder it names; the unread reading the cd had stays beside it, so it is never read looser than before, unless that value is a literal absolute path
    const word = env.hold?.(typed, cmd, env) ?? typed
    if (word !== typed && !landsHeld(typed, cmd, env)) unread = true
    // a relative target after a cd the reader cannot read lands under that folder, so it stays unread
    if (env.cwdUnread && pathOf(word, { ...env, cwd: undefined }) === undefined) unread = true
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
  env.cwd =
    name === "popd" || cmd.detached ? undefined : await cdTarget(name, cmd, parsed.args, env)
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
  const { paths } = move
  const unread = move.unread || !!cmd.cdRedefined
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
    // the cd may not run, or may fail, so a command after its chain is where the shell was before it, an unread folder too
    if (chained) env.cwdChainUnread ||= env.cwdUnread
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
  if ((!env.cwdChain?.length && !env.cwdChainUnread) || cmd.chain === env.cwdChainToken) return
  if (env.cwdChainUnread) env.cwdUnread = true
  env.cwdChainUnread = undefined
  env.cwdMaybe = keep(
    [
      ...new Set([
        ...(env.cwdMaybe ?? []),
        ...(env.cwdSure ? [env.cwdSure] : []),
        ...(env.cwdChain ?? []),
      ]),
    ],
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

// Whether a shell's options before its first operand leave -n (noexec) set, the last -n or +n winning, so it reads its script and runs none of it; a cluster holding o or O (-o, +xo, -eO) or a long option (zsh's --no-noexec), each of which can set an option by name, keeps it unset.
export function noExec(args: Word[], shell: string): boolean {
  const takes = shell === "bash" || shell === "sh" ? BASH_TAKES : SHELL_TAKES
  let set = false
  for (const { value } of args) {
    if (/^[-+][A-Za-z]*[oO]/.test(value) || (value.startsWith("--") && value !== "--")) return false
    if (takes.has(value) || !/^[-+][A-Za-z]+$/.test(value)) break
    if (value.includes("n")) set = value.startsWith("-")
  }
  return set
}

// A shell's first operand, and whether -c makes it the script's text rather than a script file's name; no operand means the shell reads its script from stdin.
export function shellOperand(args: Word[], shell: string): { inline: boolean; operand?: Word } {
  const takes = shell === "bash" || shell === "sh" ? BASH_TAKES : SHELL_TAKES
  let inline = false
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (takes.has(v)) k++
    else if (/^[-+][A-Za-z0-9]+$/.test(v)) inline ||= v.startsWith("-") && v.includes("c")
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
  if (noExec(args, name)) return
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

export async function outputOf(cmd: Command, env: Env): Promise<Text> {
  tick()
  const { args, name, xargs } = parse(cmd)
  // xargs hands the program words from its stdin, which the hook does not split as xargs does
  if (xargs) return unknown(`the output of ${name || "echo"} under xargs`)
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
  // printf's leading -- ends its options, so the format is the word after it
  if (name === "printf")
    return { value: printf(values.slice(values[0]?.value === "--" ? 1 : 0).map((v) => v.value)) }
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

const BRACE_WORDS = 64
// The words a shell's brace expansion makes of a word, in the shell's order, each list's prefix and suffix kept and nested lists expanded, or undefined past BRACE_WORDS; a brace with no comma at its own depth stays text
export function braceWords(word: string): string[] | undefined {
  const done: string[] = []
  const todo = [word]
  while (todo.length > 0) {
    if (done.length + todo.length > BRACE_WORDS) return undefined
    const next = todo.pop()!
    let split: string[] | undefined
    for (let open = next.indexOf("{"); open >= 0 && !split; open = next.indexOf("{", open + 1)) {
      const cuts = [open]
      let depth = 0
      for (let k = open; k < next.length; k++) {
        if (next[k] === "{") depth++
        else if (next[k] === "," && depth === 1) cuts.push(k)
        else if (next[k] === "}" && --depth === 0) {
          if (cuts.length > 1)
            split = [...cuts, k]
              .slice(1)
              .map(
                (end, n) => next.slice(0, open) + next.slice(cuts[n] + 1, end) + next.slice(k + 1),
              )
          break
        }
      }
    }
    if (split) todo.push(...split.reverse())
    else done.push(next)
  }
  return done
}
