// PreToolUse hook: refuses a command whose program name is not spelled plainly (a glob, a zsh group, a brace list, an ANSI-C escape, or an expansion but a HOME or PLAYGROUND_REPO folder), since each guard that reads a program by its name missed one new spelling of it after another; a plain name is one every guard reads.
import {
  type Env,
  knownVariables,
  lex,
  marked,
  parse,
  PLAIN_PREFIXES,
  plainProgram,
  run,
  type Visit,
} from "./shell"

// The prefix variables a line changes where the reader records no value: a `+=`, or a `${NAME=…}`, `${NAME:=…}` or `${NAME::=…}`
const changedIn = (command: string): Set<string> =>
  new Set(
    [...PLAIN_PREFIXES].filter((name) =>
      new RegExp(`(?:^|[\\s;&|(){}])${name}\\+=|\\$\\{${name}:{0,2}=`).test(command),
    ),
  )

// A zsh numeric range glob (`<->`, `<1-5>`), which zsh globs into a word with no option set while the shared reader keeps reading its `<` as a redirect, as every other guard does; found anywhere in the call's text, so a script the walk follows is covered too
const NUMERIC_RANGE = /<\d*-\d*>/

// Judges the readings that run: the primary parse's program word and the program a package runner runs (`npx oxfmt`), never another reading that takes an option's value as the program (`nice -n $N ls`)
const visitOf =
  (changed: ReadonlySet<string>): Visit =>
  async (cmd, { first, via }, at) => {
    const typed = first?.source ?? first?.value
    const primary = parse(cmd).first
    if (!first || cmd.casePattern) return
    if (!via && typed !== (primary?.source ?? primary?.value)) return
    if (plainProgram(first, at, changed)) return
    const held = /^"?\$\{?([A-Za-z_]\w*)\}?"?$/.exec(typed ?? "")?.[1]
    const value = held === undefined ? undefined : at.vars.get(held)
    const rewrite =
      value && !value.unknown && !marked(value.value) && value.value.trim()
        ? ` Here, write \`${value.value}\` in place of \`${typed}\`.`
        : ""
    const before = cmd.words.slice(0, cmd.words.indexOf(first))
    const lookup =
      before.some((w) => !w.quoted && w.value === "command") &&
      before.some((w) => !w.quoted && /^-[pvV]*[vV]/.test(w.value))
        ? " To look a program up, name it literally, or test with `type`."
        : ""
    return `no-hidden-program hook refuses a program name it cannot read as one plain name: \`${typed}\` is a pattern, a brace list, an escape, a leading = lookup or an expansion, and each guard reads a program by its name. Spell the program's name or path as plain text; a quoted or escaped name, ~, $HOME and $PLAYGROUND_REPO are fine.${rewrite}${lookup}`
  }

async function inspect(raw: string, environment: Record<string, string | undefined>) {
  const { cwd, tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as Record<string, unknown>
  if (tool !== "Bash") return
  const command = (toolInput as { command?: unknown } | null)?.command
  if (typeof command !== "string") return
  const directory = typeof cwd === "string" ? cwd : undefined
  const env: Env = {
    cwd: directory,
    files: new Map(),
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map(),
  }
  if (NUMERIC_RANGE.test(command))
    return "no-hidden-program hook refuses a call holding a zsh numeric range (`<->`, `<1-5>`), which zsh globs into a word where the shared reader reads a redirect, so the program that runs may not be the one the line spells. Spell the program's name or path as plain text, and put text holding a literal `<…-…>` in a file and pass the file (`git commit -F <file>`)."
  return run(lex(command, env.known), env, visitOf(changedIn(command)))
}

// Fails closed: a call it cannot read is refused, since a program it cannot read is the case it is for.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    return await inspect(raw, environment)
  } catch (error) {
    return `no-hidden-program hook could not read this call (${error}), so it refuses it. Split it into plain commands and run them again.`
  }
}
