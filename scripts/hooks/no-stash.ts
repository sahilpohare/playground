// PreToolUse hook: refuses a git stash that can take another worktree's work, since every worktree of a checkout shares one stash list (worker-prose's bare `git stash pop` took worker-labels' lint-staged backup), and an agent-browser teardown of every session, since one closed seven other sessions' browsers.

import { input } from "./input"
import { fromFactory } from "./role"
import {
  type Env,
  GIT_TAKES,
  decodedText,
  globSpells,
  knownVariables,
  lex,
  marked,
  PRINTERS,
  program,
  run,
  spelledText,
  unreadRun,
  visible,
  type Visit,
  type Word,
  type Xargs,
} from "./shell"

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const READS = new Set(["list", "show"])
const WRITES = new Set(["create", "store"])
const INSTEAD = `Every worktree shares one stash list, so a stash taken by position or without a name can be another session's work. Commit a WIP commit on your own branch instead (git commit -m 'chore: wip <what>'), or take before-shots from a separate worktree on origin/canary, made by absolute path under the main checkout so it nests in no other worktree (git worktree add --detach "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" origin/canary). git stash list, git stash show, git stash push -m <message> and git stash apply <full sha> stay allowed.`

const refuse = (what: string, why: string) => `no-stash hook refuses ${what}: ${why}. ${INSTEAD}`

const UNREAD = refuse(
  "a command built from a value it cannot read, in a call that names git stash",
  "it may be a stash by position. Write the program and its words out in the call, or write the script to a file and run it",
)

// agent-browser's close and its aliases; with --all it closes every session's browser, not only this session's.
const BROWSER_CLOSE = new Set(["close", "exit", "quit"])
const BROWSER_INSTEAD =
  "Close only the browser you opened; pass --session <name>: agent-browser --session <name> close."

// An agent-browser call's words, only a batch's quoted commands split into theirs, so `batch "close --all"` counts and typed text does not. `named` is false when the hook only guesses the program is agent-browser (an unread name), where a bare close or an unread action is not judged.
function judgeBrowser(args: Word[], session: boolean, named: boolean): string | undefined {
  const batch = args.findIndex((a) => a.value === "batch")
  const words = args
    .flatMap((a, k) => (batch !== -1 && k > batch ? a.value.split(/\s+/) : [a.value]))
    .filter(Boolean)
  if (words.some((w) => w === "-h" || w === "--help")) return
  const closes = words.some((w, k) => BROWSER_CLOSE.has(w) && words[k - 1] !== "tab")
  const all = words.some((w) => w === "--all" || w.startsWith("--all="))
  const hidden = words.find((w) => marked(w))
  if (all && (closes || (named && hidden)))
    return `no-stash hook refuses agent-browser ${hidden && !closes ? "with an action it cannot read and" : "close"} --all: it closes every session's browser, other sessions' included. ${BROWSER_INSTEAD}`
  const hasSession = session || words.some((w) => w === "--session" || w.startsWith("--session="))
  if (named && closes && !hasSession)
    return `no-stash hook refuses a bare agent-browser close: with no --session it closes the shared default session, which another session may be using. ${BROWSER_INSTEAD}`
}

// Whether the command names its agent-browser session in its environment: an assignment before it, an export earlier in the command, or the session's own environment.
const sessionIn = (local: Map<string, unknown>, env: Env): boolean =>
  ["AGENT_BROWSER_SESSION", "AGENT_BROWSER_SESSION_NAME"].some(
    (key) => local.has(key) || env.vars.has(key) || Boolean(env.process[key]),
  )

// The message a push names, from -m <msg>, -m<msg>, --message <msg> or --message=<msg>; an empty one names nothing.
function message(args: Word[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--") break
    if (v === "-m" || v === "--message") return args[k + 1]?.value || undefined
    const attached = /^(?:-m|--message=)(.+)$/.exec(v)?.[1]
    if (attached) return attached
  }
}

function judgeStash(args: Word[], xargs: boolean): string | undefined {
  if (xargs) return refuse("git stash under xargs", "the hook cannot read the arguments xargs adds")
  const action = args[0]
  if (!action)
    return refuse("a bare git stash", "it saves your changes with no name to find them by")
  if (marked(action.value))
    return refuse("this git stash", `the hook cannot read its action (${visible(action.value)})`)
  const name = action.value
  if (args.some((a) => a.value === "-h" || a.value === "--help")) return
  if (READS.has(name) || WRITES.has(name)) return
  if (name === "push" || name === "save" || name.startsWith("-")) {
    const implied = name.startsWith("-")
    if (message(implied ? args : args.slice(1))) return
    return refuse(
      `${implied ? "git stash" : `git stash ${name}`} without -m <message>`,
      "an unnamed stash is found again only by its position, which another session's stash moves",
    )
  }
  if (name === "apply") {
    const target = args.slice(1).find((a) => !a.value.startsWith("-"))
    if (target && !marked(target.value) && FULL_SHA.test(target.value)) return
    return refuse(
      "git stash apply without a full commit SHA",
      "stash@{n} and the default name whatever entry is newest, which can be another session's",
    )
  }
  if (name === "pop" || name === "drop" || name === "clear" || name === "branch")
    return refuse(
      `git stash ${name}`,
      "it removes an entry by position from the list every worktree shares",
    )
  return refuse(`git stash ${name}`, "it is not a stash action the hook knows to be safe")
}

// git's subcommand after its own options: undefined when there is none, the word itself when the hook cannot read it.
export function gitCommand(args: Word[]): { aliases: string[]; rest: Word[]; sub?: Word } {
  const aliases: string[] = []
  let k = 0
  while (k < args.length && args[k].value.startsWith("-")) {
    const v = args[k].value
    if (v === "-c") aliases.push(args[k + 1]?.value ?? "")
    else if (v.startsWith("-c")) aliases.push(v.slice(2))
    k += GIT_TAKES.has(v) ? 2 : 1
  }
  return { aliases, rest: args.slice(k + 1), sub: args[k] }
}

const stashes = (args: Word[]) => gitCommand(args).sub?.value === "stash"

// git itself, a name the hook cannot read with a stash after it (`$GIT stash pop`), or git behind a wrapper the reader does not know (`uv run git stash pop`), as the other hooks find gh and git.
const visit: Visit = async (_cmd, { args, first, local, name, xargs }, env) => {
  const session = sessionIn(local, env)
  if (name === "agent-browser") return judgeBrowser(args, session, true)
  if (name === "git") return judgeGit(args, xargs)
  if (first && (first.unknown || marked(first.value))) {
    if (stashes(args)) return judgeGit(args, xargs)
    const verdict = judgeBrowser(args, session, false)
    if (verdict) return verdict
  }
  if (PRINTERS.has(name)) return
  const browser = args.findIndex((a) => program(a.value) === "agent-browser")
  if (browser !== -1) {
    const verdict = judgeBrowser(args.slice(browser + 1), session, true)
    if (verdict) return verdict
  }
  const nested = args.findIndex((a, j) => program(a.value) === "git" && stashes(args.slice(j + 1)))
  if (nested !== -1) return judgeGit(args.slice(nested + 1), xargs)
}

function judgeGit(args: Word[], xargs: Xargs): string | undefined {
  const { aliases, rest, sub } = gitCommand(args)
  if (!sub) return
  if (marked(sub.value))
    return refuse(
      "this git call",
      `the hook cannot read which git command it runs (${visible(sub.value)})`,
    )
  if (sub.value === "stash") return judgeStash(rest, xargs !== undefined)
  const alias = aliases.find((a) => a.startsWith(`alias.${sub.value}=`))
  if (alias && /\bstash\b/.test(alias))
    return refuse(`git ${sub.value}`, "it is an alias for git stash")
}

const BARE = (command: string) => command.replace(/[\\'"]/g, "")

// agent-browser named beside a close or its aliases.
const teardown = (command: string): boolean =>
  /agent-browser/i.test(BARE(command)) && /\b(?:close|exit|quit)\b/.test(BARE(command))

// The cheap first look, with quotes and backslashes gone so `st''ash` still counts: a stash, an --all or an agent-browser close; git and agent-browser need not be named (`$GIT stash`), and $'...' can spell any word, so it always counts.
const candidate = (command: string): boolean =>
  command.includes("$'") || /stash|--all\b/.test(BARE(command)) || teardown(command)

const stashCall = (command: string): boolean =>
  (/\bgit\b/i.test(BARE(command)) && /\bstash\b/.test(BARE(command))) || teardown(command)

function commandOf(raw: string): string | undefined {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
      tool_input?: { command?: unknown }
      tool_name?: unknown
    }
    return tool === "Bash" && typeof toolInput?.command === "string" ? toolInput.command : undefined
  } catch {
    return undefined
  }
}

async function inspect(raw: string, environment: Record<string, string | undefined>) {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (typeof payload !== "object" || payload === null)
    return stashCall(raw)
      ? "no-stash hook could not parse its input, which reads as a git stash, so it refuses the call."
      : undefined
  const { cwd, tool_input: toolInput, tool_name: tool } = payload as Record<string, unknown>
  if (tool !== "Bash") return
  const command = (toolInput as { command?: unknown } | null)?.command
  if (typeof command !== "string" || !candidate(command)) return
  const directory = typeof cwd === "string" ? cwd : undefined
  const env: Env = {
    cwd: directory,
    files: new Map(),
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map(),
  }
  // an array run whole or a glob program word the reader cannot read (unreadRun) may be any stash, in a call that names stash and git, written out, in an ANSI-C string, by a brace list or zsh group spelled out (spelledText) or as a glob that may match it
  const text = BARE(spelledText(decodedText(command)))
  const named = /\bstash\b/.test(text) && (/\bgit\b/i.test(text) || globSpells(text, ["git"]))
  return run(lex(command, env.known), env, (cmd, parsed, at) =>
    named && unreadRun(parsed) ? Promise.resolve(UNREAD) : visit(cmd, parsed, at),
  )
}

// Fails closed only on a call that reads as a git stash: an error on any other call lets it run, so a parser bug cannot block every Bash command.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    return await inspect(raw, environment)
  } catch (error) {
    if (!stashCall(commandOf(raw) ?? raw)) return
    return `no-stash hook could not read this call (${error}), which reads as a git stash, so it refuses it. Split it into plain commands and run them again.`
  }
}

if (import.meta.main) {
  const raw = await input("no-stash", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
