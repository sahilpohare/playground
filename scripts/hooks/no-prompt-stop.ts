// PreToolUse hook: refuses the Bash shapes Claude Code stops on for permission, so a session gets a reason and carries on rather than waiting on a prompt no one answers. Claude Code stops on an rm or an rmdir whose target has two or more parts that start with an unguarded variable (`rm -rf $S/$m`, `rmdir $O/$s`, `rmdir $HOME/$s`, `rmdir $S/$v.d`), and runs one with a single such part (`rmdir "$O"/d`) or a variable after a name (`rmdir $S/p$v`); measured with headless probes. It also stops on an rm or an rmdir of a name directly in / (`rm -f /scratchpad_*`, `rmdir /x`), and runs one a level deeper (`rm -f /usr/x`) and a redirect into / (`echo x > /x`); measured.

import { input } from "./input"
import { fromFactory } from "./role"
import { type Env, lex, run, UNKNOWN, type Visit } from "./shell"

// A `${VAR:?...}` stops the shell when VAR is empty, so it does not count: it is read as this literal, shown back as ${…:?}.
const GUARDED = /\$\{[A-Za-z_][A-Za-z0-9_]*:\?[^}]*\}/g
const GUARD = "__guarded__"
const VARIABLES_TO_STOP = 2

const variables = (path: string) =>
  path.split("/").filter((part) => part.startsWith(UNKNOWN)).length

// The path with each part the shell fills in shown as $…, since the reader keeps no variable's name.
const shown = (path: string) => path.replaceAll(UNKNOWN, "$…").replaceAll(GUARD, "${…:?}")

// rmdir runs guarded, while no-raw-delete refuses an rm whose path it cannot read, guarded or not, so an rm takes a literal path.
const FIX: Record<"rm" | "rmdir", string> = {
  rm: "Name each path literally: a file in your worktree or scratchpad with rm, anything else with playground rm <literal path> (in a script, removeScratch for a folder makeScratch made), and run it again.",
  rmdir: 'Guard each one as ${VAR:?} ("${S:?}/${m:?}"), or name a literal path, and run it again.',
}

const refuse = (name: "rm" | "rmdir", path: string) =>
  `no-prompt-stop hook refuses ${name} ${shown(path)}: Claude Code stops on a removal whose target has two or more parts that start with a variable and waits for a person, who is not there. ${FIX[name]}`

// A literal name directly in /, a glob or a trailing slash included.
const AT_ROOT = /^\/[^/\u0000]+\/?$/

// no-raw-delete refuses an rm of $TMPDIR, a word it cannot read and a folder outside both roots, so an rm moves to the scratchpad.
const AT_ROOT_FIX: Record<"rm" | "rmdir", string> = {
  rm: "Write and remove in the session's scratchpad, a folder there with playground rm <literal path>, and run it again.",
  rmdir: "Write and remove in $TMPDIR or the session's scratchpad, and run it again.",
}

const refuseAtRoot = (name: "rm" | "rmdir", path: string) =>
  `no-prompt-stop hook refuses ${name} ${path}: Claude Code stops on a removal of a name directly in / and waits for a person, who is not there. ${AT_ROOT_FIX[name]}`

const visit: Visit = async (_cmd, { args, name }) => {
  if (name !== "rm" && name !== "rmdir") return
  const operands = args.filter((a) => !a.value.startsWith("-"))
  const path = operands.find((a) => variables(a.value) >= VARIABLES_TO_STOP)
  if (path) return refuse(name, path.value)
  const atRoot = operands.find((a) => AT_ROOT.test(a.value))
  if (atRoot) return refuseAtRoot(name, atRoot.value)
}

async function inspect(raw: string) {
  const {
    cwd,
    tool_input: toolInput,
    tool_name: tool,
  } = JSON.parse(raw) as {
    cwd?: unknown
    tool_input?: { command?: unknown }
    tool_name?: unknown
  }
  if (tool !== "Bash" || typeof toolInput?.command !== "string") return
  if (!/\brm(?:dir)?\b/.test(toolInput.command)) return
  const command = toolInput.command.replace(GUARDED, GUARD)
  const directory = typeof cwd === "string" ? cwd : undefined
  // HOME, PWD and TMPDIR are counted as variables too, as Claude Code counts them, so nothing is filled in
  const env: Env = {
    cwd: directory,
    files: new Map(),
    known: {},
    process: {},
    vars: new Map(),
  }
  return run(lex(command, env.known), env, visit)
}

// Fails open: a call the hook cannot read runs, so a parser bug never blocks a Bash command.
export async function check(raw: string): Promise<string | undefined> {
  try {
    return await inspect(raw)
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const raw = await input("no-prompt-stop", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
