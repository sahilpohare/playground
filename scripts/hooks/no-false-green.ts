// PreToolUse hook, acting for a factory session alone (role.ts): refuses a Bash test run that reads green while no test ran or a test failed: bun with an option given its value as the next word (--cwd <dir>, --env-file <file>) before its run or test subcommand, which then prints bun's usage and exits 0 (run) or runs package.json's test script with the paths appended in place of the tests (test), and a test run (bun's, or a pytest, ty or ruff run) or a git push piped into another command in a script that sets no pipefail and reads no pipe status of its own shell, whose exit status is then the last command's.

import { fromFactory } from "./role"
import {
  type Command,
  GIT_TAKES,
  lex,
  parse,
  parseFlags,
  type Parsed,
  program,
  pythonModule,
  SHELLS,
  shellOperand,
  shellSlot,
  slotWords,
  UV_TAKES,
  type Word,
} from "./shell"

// The package runners' options that take the next word as their value.
const TAKES = new Set([
  "-C",
  "-c",
  "--config",
  "--cwd",
  "--dir",
  "--env-file",
  "-F",
  "--filter",
  "--prefix",
  "-w",
  "--workspace",
])
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"])
const EXECS = new Set(["bunx", "npx", "pnpx"])
const TEST_BINS = new Set(["jest", "vitest"])
const PY_TOOLS = new Set(["pytest", "ruff", "ty"])
const TEST_SCRIPT = /^(?:check-types|test)(?::|$)/

const positionals = (args: Word[]): string[] => {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (TAKES.has(v)) k++
    else if (!v.startsWith("-")) out.push(v)
  }
  return out
}

// The commands a wrapper or a shell runs for it (its command, its script's words or its -c script's commands), or undefined for any other command.
function inner(cmd: Command, parsed: Parsed): Command[] | undefined {
  const { args, name } = parsed
  const slot = slotWords(parsed)
  if (slot) return slot.length === 0 ? [] : [{ ...cmd, scope: 0, words: slot }]
  if (!SHELLS.has(name)) return
  const script = shellSlot(args, name)
  if (script) return [{ ...cmd, scope: 0, words: script }]
  const { inline, operand } = shellOperand(args, name)
  return inline && operand !== undefined ? lex(operand.value).commands : []
}

// Whether the command is a git push, past git's global options (-C <dir>, -c <key=value> and the rest of GIT_TAKES).
function pushes(cmd: Command): boolean {
  const parsed = parse(cmd)
  const commands = inner(cmd, parsed)
  if (commands) return commands.some(pushes)
  const { args, name } = parsed
  if (name !== "git") return false
  let k = 0
  for (; k < args.length && args[k].value.startsWith("-"); k++)
    if (GIT_TAKES.has(args[k].value)) k++
  return args[k]?.value === "push"
}

function runsTests(cmd: Command): boolean {
  const parsed = parse(cmd)
  const commands = inner(cmd, parsed)
  if (commands) return commands.some(runsTests)
  const { args, name } = parsed
  // uvx names a tool at a version as ruff@latest
  if (TEST_BINS.has(name) || PY_TOOLS.has(name.replace(/@.*$/, ""))) return true
  const python = pythonModule(name, args)
  if (python) return PY_TOOLS.has(python.module)
  if (name === "uv" || name === "uvx") {
    const { positionals: words } = parseFlags(args, UV_TAKES)
    // uvx runs its first positional, uv run the one after run, uv tool run the next, each with its words
    const sub = words[0]?.value
    const from =
      name === "uvx"
        ? words[0]
        : sub === "run"
          ? words[1]
          : sub === "tool" && words[1]?.value === "run"
            ? words[2]
            : undefined
    return (
      from !== undefined && runsTests({ ...cmd, scope: 0, words: args.slice(args.indexOf(from)) })
    )
  }
  const [sub = "", next = ""] = positionals(args)
  if (EXECS.has(name)) return TEST_BINS.has(program(sub))
  if (!RUNNERS.has(name)) return false
  if (sub === "run" || sub === "run-script") return TEST_SCRIPT.test(next)
  if (sub === "x" || sub === "exec" || sub === "dlx") return TEST_BINS.has(program(next))
  return TEST_SCRIPT.test(sub)
}

// The option bun misreads when it comes before run or test: any option given its value as the next word (--cwd, --env-file, --preload, -r, --conditions, --define, measured on bun 1.4.2), since bun reads `--opt=value` there as asked. This shape also refuses two forms bun reads as asked: a boolean option followed by a script file and a literal run or test, and --filter <pattern> test, which runs each matching workspace's test script.
function misread(args: Word[]): string | undefined {
  let flag: string | undefined
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (!v.startsWith("-"))
      return v === "run" || v === "test"
        ? flag && `${flag} <value>, with a space, before ${v}`
        : undefined
    const next = args[k + 1]?.value ?? ""
    if (v.includes("=") || next.startsWith("-") || next === "run" || next === "test") continue
    flag ??= v
    k++
  }
}

// What keeps a pipe's failure in a script's exit, by the shell that runs it (measured in bash 3.2 and zsh 5.9): set -o pipefail in either; in bash ${PIPESTATUS[n]}; in zsh setopt pipefail in any case and with any underscores, and ${pipestatus[n]} from 1, since zsh leaves PIPESTATUS unset and pipestatus[0] empty, which exit 0.
const setsPipefail = (s: string) => /\bset\b[^;&|\n]*\bpipefail\b/.test(s)
const setoptPipefail = (s: string) =>
  [...s.matchAll(/\bsetopt\b([^;&|\n]*)/g)].some((m) =>
    /\bpipefail\b/.test(m[1].replaceAll("_", "").toLowerCase()),
  )
const KEEPS_STATUS = {
  bash: (s: string) => setsPipefail(s) || /\$\{PIPESTATUS\[/.test(s),
  zsh: (s: string) => setsPipefail(s) || setoptPipefail(s) || /\$\{?pipestatus\[[1-9]/.test(s),
}
type Dialect = keyof typeof KEEPS_STATUS
const dialect = (shell: string): Dialect => (program(shell) === "zsh" ? "zsh" : "bash")

// Each script is judged by its own guard, since a pipefail outside a shell's -c script never reaches the pipes inside it.
function judge(script: string, shell: Dialect): string | undefined {
  const guarded = KEEPS_STATUS[shell](script)
  for (const cmd of lex(script).commands) {
    const reason = judgeCommand(cmd, guarded)
    if (reason) return reason
  }
}

function judgeCommand(cmd: Command, guarded: boolean): string | undefined {
  const parsed = parse(cmd)
  const { args, name } = parsed
  const slot = slotWords(parsed)
  if (slot)
    return slot.length === 0 ? undefined : judgeCommand({ ...cmd, scope: 0, words: slot }, guarded)
  if (SHELLS.has(name)) {
    const script = shellSlot(args, name)
    if (script) return judgeCommand({ ...cmd, scope: 0, words: script }, guarded)
    const { inline, operand } = shellOperand(args, name)
    const reason = inline && operand ? judge(operand.value, dialect(name)) : undefined
    if (reason) return reason
  }
  const flag = name === "bun" ? misread(args) : undefined
  if (flag)
    return `no-false-green hook refuses bun ${flag}: bun then misreads the subcommand (run prints its usage and exits 0, test runs package.json's test script with the paths appended in place of the tests), so its exit says nothing about the tests. Join the value with = (--opt=value) or put the option after the subcommand: bun --cwd=<dir> run test:file <files>, or bun run --cwd <dir> <script>.`
  if (!guarded && cmd.stdin && runsTests(cmd.stdin))
    return `no-false-green hook refuses a test run piped into ${name || "a command group"} with no pipefail: a pipeline's exit status is its last command's, so a failing run reads 0. Drop the pipe (the Bash tool keeps long output), or set pipefail inside the script that holds the pipe (set -o pipefail; first, inside the quotes of a bash -c script) so the test's own exit status comes through.`
  if (!guarded && cmd.stdin && pushes(cmd.stdin))
    return `no-false-green hook refuses a git push piped into ${name || "a command group"} with no pipefail: a pipeline's exit status is its last command's, so a failed push reads 0. Push bare (the Bash tool keeps its output), then check it with git ls-remote origin refs/heads/<branch>, which prints the local head's sha once the push has landed.`
}

async function inspect(raw: string, shell: string) {
  const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
    tool_input?: { command?: unknown }
    tool_name?: unknown
  }
  if (tool !== "Bash" || typeof toolInput?.command !== "string") return
  const { command } = toolInput
  const words = /\b(?:bun|bunx|git|jest|npm|npx|pnpm|pnpx|pytest|ruff|ty|vitest|yarn)\b/
  if (!words.test(command.replace(/["'\\]/g, ""))) return
  return judge(command, dialect(shell))
}

// Fails open, so a parser bug never blocks a Bash command; the Bash tool runs a command in the user's shell, so its pipe status reads by $SHELL's name.
export async function check(
  raw: string,
  shell = process.env.SHELL ?? "zsh",
): Promise<string | undefined> {
  try {
    return await inspect(raw, shell)
  } catch {
    return undefined
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
