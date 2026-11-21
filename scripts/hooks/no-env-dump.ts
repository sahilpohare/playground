// PreToolUse hook, acting for a factory session alone (role.ts): refuses a Bash command that prints the whole environment (a bare declare, env, export, printenv, set or typeset), since the environment holds tokens and the output lands in the transcript (13 Oct: a planning subagent's `env` printed this machine's GitHub and Slack tokens). `env VAR=x cmd` runs a command and passes, as do `set -e` and `export VAR=x`.

import { input } from "./input"
import { fromFactory } from "./role"
import { lex, program, run, type Visit } from "./shell"

const DECLARES = new Set(["declare", "export", "typeset"])

const refuse = (what: string) =>
  `no-env-dump hook refuses ${what}: it prints environment variables, tokens included, into the transcript. To check that a variable is set, run [ -n "\${VAR:-}" ] && echo set; to run a command with a variable, run env VAR=x <command>.`

const visit: Visit = async (cmd, { args, name }) => {
  if (name === "") {
    // an assignment (FOO=/usr/bin/env) is a value, not a program
    if (cmd.words.some((w) => !/^[A-Za-z_]\w*=/.test(w.value) && program(w.value) === "env"))
      return refuse("env with no command")
    return
  }
  if (name === "printenv") return refuse("printenv")
  if (name === "set" && args.length === 0) return refuse("a bare set")
  if (!DECLARES.has(name)) return
  const operands = args.filter((a) => !/^[-+]/.test(a.value))
  // -f and -F list functions, not variables
  if (operands.length === 0 && !args.some((a) => /^[-+]\w*[fF]/.test(a.value)))
    return refuse(`a bare ${name}`)
}

async function inspect(raw: string) {
  const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
    tool_input?: { command?: unknown }
    tool_name?: unknown
  }
  if (tool !== "Bash" || typeof toolInput?.command !== "string") return
  // quotes and backslashes go first, since the shell reads e"n"v and \env as env
  if (
    !/\b(?:declare|env|export|printenv|set|typeset)\b/.test(
      toolInput.command.replace(/["'\\]/g, ""),
    )
  )
    return
  const env = { files: new Map(), known: {}, process: {}, vars: new Map() }
  return run(lex(toolInput.command), env, visit, true)
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
  const raw = await input("no-env-dump", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
