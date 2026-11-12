// PreToolUse hook for the factory's sessions (PLAYGROUND_ROLE set, else a factory name in Claude Code's registry, role.ts): refuses creating a Linear ticket unless the dispatcher has written today's approval naming its team and title, since no ticket is created without the owner's yes, and refuses any other role a write into the approvals folder.
import "../../packages/env/src/aliases"
import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import { eachInput } from "./codex"
import { sessionOf, sessionRole } from "./role"
import {
  type Command,
  CURL_TAKES,
  curlData,
  curlUrls,
  type Env,
  flagFromXargs,
  ghApi,
  ghCommand,
  knownVariables,
  lex,
  NOT_RUN,
  type Parsed,
  parseFlags,
  pathOf,
  PRINTERS,
  program,
  resolveText,
  run,
  slice,
  stdinOf,
  type Text,
  UNKNOWN,
  unknown,
  viaXargs,
  visible,
  type Visit,
  type Word,
  type Xargs,
} from "./shell"

type Environment = Record<string, string | undefined>

// Linear's GraphQL mutations that create a ticket.
const CREATE = /\bissue(?:batch)?create\b/i
const LINEAR = /linear\.app/i
const GITHUB = /^https?:\/\/(?:[\w-]+\.)*github\.com(?:[/:?#]|$)/i
const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
const MCP_TOOL = /^mcp__(.+?)__(.+)$/
const CREATE_TOOL = /^(?:\w+_)?create_?issues?$|^issues?_?create$/i
// Claude Code's file tools, by the input key that holds the path they write.
const FILE_TOOLS = new Map([
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
  ["Write", "file_path"],
])
// The flags whose value is a program's code, per interpreter.
const CODE_FLAGS = new Map<string, Set<string>>([
  ["bun", new Set(["-e", "--eval", "-p", "--print"])],
  ["deno", new Set()],
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["perl", new Set(["-E", "-e"])],
  ["python", new Set(["-c"])],
  ["ruby", new Set(["-e"])],
])
// A Bash command naming none of these is left alone before any parsing; $'...' can spell any word, so it always counts.
const MAYBE =
  /issue(?:batch)?create|linear|ticket-approvals|curl|\bgh\b|bun|deno|node|perl|python|ruby/i
const MAX_APPROVAL_BYTES = 65_536

const interpreter = (name: string): string => (/^python[\d.]*$/.test(name) ? "python" : name)

const isDispatcher = (environment: Environment): boolean =>
  environment.PLAYGROUND_ROLE === "dispatcher"

const approvalsDir = (environment: Environment): string =>
  join(dataDirOf(environment), "ticket-approvals")

// The team as the call names it, lowercased, each run of other characters one hyphen: `AI Platform` is `ai-platform`.
const slug = (team: string): string =>
  team
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const day = (now: Date): string => now.toISOString().slice(0, 10)

const RULE =
  "A new Linear ticket needs the owner's yes first, and the factory's own work never goes in Linear."
const ASK_UP =
  "Ask up the chain with the team and the exact title; once the owner says yes, the dispatcher records it, and the same save_issue call then runs."

function refuse(what: string, detail: string, next: string): string {
  return `no-linear-ticket hook refused ${what}: ${detail}. ${RULE} ${next}`
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

const within = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}${sep}`)

// Whether a path lands in the approvals folder, through a link in its parent directory or in the folder's own path included.
async function inApprovals(path: string, environment: Environment): Promise<boolean> {
  const dir = approvalsDir(environment)
  const dirs = [dir, await real(dir)]
  const target = resolve(path)
  const targets = [target, join(await real(dirname(target)), basename(target))]
  return targets.some((t) => dirs.some((d) => within(t, d)))
}

function refuseApprovals(what: string, environment: Environment): string {
  return `no-linear-ticket hook refused ${what}: it reaches into ${approvalsDir(environment)}, which the dispatcher alone writes, to record the owner's yes to a new Linear ticket. ${ASK_UP}`
}

// Any word, assignment or redirect of the command that names a path in the approvals folder.
async function touchesApprovals(cmd: Command, parsed: Parsed, env: Env): Promise<boolean> {
  const dirs = [approvalsDir(env.process), await real(approvalsDir(env.process))]
  const texts: Text[] = [
    ...(parsed.first ? [parsed.first] : []),
    ...parsed.args,
    ...parsed.local.values(),
    ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
  ]
  for (const text of texts) {
    if (dirs.some((d) => visible(text.value).includes(d))) return true
    const path = pathOf(text, env)
    if (path && (await inApprovals(path, env.process))) return true
  }
  return false
}

const ticket: Visit = async (cmd, parsed, env) => {
  if (!isDispatcher(env.process) && (await touchesApprovals(cmd, parsed, env))) {
    return refuseApprovals(parsed.name || "this command", env.process)
  }
  return sender(cmd, parsed, env, false)
}

// `nested` marks a command found among another's arguments, whose stdin belongs to that other command.
async function sender(
  cmd: Command,
  parsed: Parsed,
  env: Env,
  nested: boolean,
): Promise<string | undefined> {
  const { args, first, name, xargs } = parsed
  if (name === "curl" || first?.unknown) return curl(args, cmd, env, xargs)
  if (name === "gh") return gh(args, cmd, env, xargs)
  const language = interpreter(name)
  if (CODE_FLAGS.has(language)) return script(language, args, cmd, env, !nested)
  if (PRINTERS.has(name)) return
  // A wrapper the reader does not know (`vault run -- curl ...`, `uv run python -c ...`) runs the command after it.
  const at = args.findIndex((a) => {
    const inner = program(a.value)
    return inner === "curl" || inner === "gh" || CODE_FLAGS.has(interpreter(inner))
  })
  if (at === -1) return
  const inner = {
    ...parsed,
    args: args.slice(at + 1),
    first: args[at],
    name: program(args[at].value),
  }
  return sender(cmd, inner, env, true)
}

async function curl(
  args: Word[],
  cmd: Command,
  env: Env,
  xargs: Xargs,
): Promise<string | undefined> {
  const { flags, positionals } = parseFlags(args, CURL_TAKES)
  const urls = curlUrls(flags, positionals)
  const sent = await curlData(flags, cmd, env)
  if (xargs && !xargs.replace) sent.push(unknown("the arguments xargs appends"))
  if (args.some((a) => flagFromXargs(a, xargs))) {
    sent.push(unknown(`what xargs puts in place of ${xargs?.replace}`))
  }
  const texts = await Promise.all(
    [...urls, ...sent].map((t) => resolveText(viaXargs(t, xargs), env)),
  )
  return judge(
    "curl",
    texts,
    urls.some((u) => LINEAR.test(visible(u.value))),
    env.process,
    urls.length,
  )
}

// gh sends a path or `graphql` to GitHub, whose schema has no issueCreate, so only a full URL off GitHub, or an endpoint that may be one, is judged.
async function gh(args: Word[], cmd: Command, env: Env, xargs: Xargs): Promise<string | undefined> {
  const { head, rest } = ghCommand(args)
  if (head[0] !== "api") return
  const request = await ghApi(rest, cmd, env, xargs)
  if (!request) return
  const where = await resolveText(request.endpoint, env)
  const open = where.value.startsWith(UNKNOWN)
  if (!open && !(URL_SCHEME.test(where.value) && !GITHUB.test(where.value))) return
  const texts = await Promise.all(
    [where, ...request.fields.map((f) => f.text), ...request.inputs].map((t) =>
      resolveText(t, env),
    ),
  )
  return judge("gh api", texts, open || LINEAR.test(visible(where.value)), env.process, 1)
}

// An interpreter's inline code (`python3 -c`, `bun -e`, `deno eval`), or, when `stdin` allows, its stdin when it is given no script.
async function script(
  language: string,
  args: Word[],
  cmd: Command,
  env: Env,
  stdin: boolean,
): Promise<string | undefined> {
  const takes = CODE_FLAGS.get(language) ?? new Set<string>()
  const code: Text[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--") break
    if (v.startsWith("--")) {
      const eq = v.indexOf("=")
      if (!takes.has(eq === -1 ? v : v.slice(0, eq))) continue
      if (eq !== -1) code.push(slice(args[k], eq + 1))
      else if (args[k + 1]) code.push(args[k + 1])
    } else if (/^-[A-Za-z]/.test(v)) {
      // A cluster such as `-pe` or `-uc` takes its code from the rest of the word or the next word, so both are read.
      const at = v
        .slice(1)
        .split("")
        .findIndex((c) => takes.has(`-${c}`))
      if (at === -1) continue
      if (at + 2 < v.length) code.push(slice(args[k], at + 2))
      if (args[k + 1]) code.push(args[k + 1])
    }
  }
  // `deno eval` takes its code after any flags of its own, so every word after it is read.
  if (language === "deno" && args[0]?.value === "eval") code.push(...args.slice(1))
  if (stdin && code.length === 0 && args.every((a) => a.value.startsWith("-"))) {
    code.push(await stdinOf(cmd, env))
  }
  const texts = await Promise.all(code.map((c) => resolveText(c, env)))
  return judge(language, texts, false, env.process)
}

function judge(
  what: string,
  texts: Text[],
  toLinear: boolean,
  environment: Environment,
  targets = 0,
): string | undefined {
  if (texts.some((t) => CREATE.test(visible(t.value)))) {
    return refuse(
      what,
      "it sends Linear's issueCreate, which files a new ticket",
      isDispatcher(environment)
        ? "Once he says yes, record it and file the ticket with the Linear MCP's save_issue, which the hook matches to the approval; a GraphQL create matches none."
        : ASK_UP,
    )
  }
  if (!toLinear) return
  const at = texts.findIndex((t) => t.unknown)
  if (at === -1) return
  const hidden = texts[at]
  // The first `targets` texts are the endpoint or URLs, which a query file cannot stand in for.
  if (at < targets) {
    return refuse(
      what,
      `the hook cannot read where it goes (it comes from ${hidden.unknown}), so it may be Linear's API and file a ticket`,
      `Name the endpoint or URL by its literal value in the command itself (gh api https://api.linear.app/graphql, or curl https://api.linear.app/graphql). ${NOT_RUN}`,
    )
  }
  return refuse(
    what,
    `it goes to Linear's API, and the hook cannot read what it sends before it runs (it comes from ${hidden.unknown}), so it may file a ticket`,
    `To read Linear, put the query in the command itself, or write the query to a file with the Write tool first, then run the command again in a call of its own that names that file by its literal absolute path (curl -d @/abs/query.json, or gh api --input /abs/query.json). ${NOT_RUN}`,
  )
}

const hasId = (input: Record<string, unknown>): boolean =>
  typeof input.id === "string" && input.id.trim() !== ""

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

// A save_issue with no id, or a Linear server's create-issue tool, files a new ticket.
function creates(tool: string, input: Record<string, unknown> | undefined): boolean {
  const [, server = "", name = ""] = MCP_TOOL.exec(tool) ?? []
  if (name === "save_issue") return !input || !hasId(input)
  return CREATE_TOOL.test(name) && /linear/i.test(server)
}

async function mcp(
  tool: string,
  input: Record<string, unknown> | undefined,
  environment: Environment,
  now: Date,
): Promise<string | undefined> {
  if (!creates(tool, input)) return
  const what = tool.replace(/^mcp__/, "")
  const team = textOf(input?.team ?? input?.teamId ?? input?.teamKey)
  const title = textOf(input?.title)
  if (slug(team) === "" || title === "") {
    return refuse(
      what,
      "it files a new Linear ticket, and the hook cannot read its team and title to match an approval",
      "Name the team and the title as the owner approved them.",
    )
  }
  const path = join(approvalsDir(environment), `${slug(team)}-${day(now)}.json`)
  const approval = await readApproval(path)
  if (approval.titles?.includes(title)) return
  const problem = approval.problem ?? `today's approval does not name ${JSON.stringify(title)}`
  const shape = `{"ask": "<the Inbox decision he approved>", "titles": [${JSON.stringify(title)}]}`
  return refuse(
    what,
    `it files a new Linear ticket in ${JSON.stringify(team)}, and ${problem}`,
    isDispatcher(environment)
      ? `Once he says yes, write ${path} as ${shape}, and the same call then runs. An approval holds for the UTC day in its name.`
      : ASK_UP,
  )
}

// Reads one approval; a problem names what is wrong without its path, which only the dispatcher is given.
async function readApproval(path: string): Promise<{ problem?: string; titles?: string[] }> {
  const file = Bun.file(path)
  let stats: Awaited<ReturnType<typeof file.stat>>
  try {
    stats = await file.stat()
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { problem: "the owner has not approved a ticket in this team today" }
    }
    return { problem: "today's approval for this team cannot be read" }
  }
  if (!stats.isFile() || stats.size > MAX_APPROVAL_BYTES) {
    return { problem: "today's approval for this team is not a small regular file" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    return { problem: "today's approval for this team is not JSON" }
  }
  const titles = (parsed as { titles?: unknown } | null)?.titles
  if (!Array.isArray(titles) || !titles.every((t) => typeof t === "string")) {
    return { problem: `today's approval for this team holds no "titles" list of strings` }
  }
  return { titles: titles.map((t) => t.trim()) }
}

async function fileTool(
  tool: string,
  path: unknown,
  cwd: unknown,
  environment: Environment,
): Promise<string | undefined> {
  if (isDispatcher(environment) || typeof path !== "string" || path === "") return
  const absolute = isAbsolute(path) ? path : resolve(typeof cwd === "string" ? cwd : "/", path)
  if (await inApprovals(absolute, environment)) return refuseApprovals(tool, environment)
}

// The cheap first look, made with quotes and backslashes gone so `cu\rl` or `issue''Create` still counts.
function candidate(command: string): boolean {
  return command.includes("$'") || MAYBE.test(command.replace(/[\\'"]/g, ""))
}

// What an internal error still refuses: a call that reads as filing a ticket.
function createCall(subject: string): boolean {
  return CREATE.test(subject) || /save_issue|create_?issue|issues?_?create/i.test(subject)
}

// Fails closed only on a call that reads as filing a ticket: an error on any other call lets it run, so a parser bug cannot block every call.
export async function check(
  raw: string,
  environment: Environment = process.env,
  now: Date = new Date(),
): Promise<string | undefined> {
  const role = await sessionRole(environment, sessionOf(raw))
  if (!role) return
  try {
    return await eachInput(raw, "no-linear-ticket", (one) =>
      inspect(one, { ...environment, PLAYGROUND_ROLE: role }, now),
    )
  } catch (error) {
    if (!createCall(subjectOf(raw))) return
    return `no-linear-ticket hook could not read this call (${error}), which reads as filing a Linear ticket, so it refuses it. Split it into plain commands and run them again.`
  }
}

// What an error is judged by: the Bash command or the tool's name, never its cwd.
function subjectOf(raw: string): string {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
      tool_input?: { command?: unknown }
      tool_name?: unknown
    }
    if (tool === "Bash" && typeof toolInput?.command === "string") return toolInput.command
    return typeof tool === "string" ? tool : raw
  } catch {
    return raw
  }
}

async function inspect(
  raw: string,
  environment: Environment,
  now: Date,
): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (typeof payload !== "object" || payload === null) {
    return createCall(raw)
      ? "no-linear-ticket hook could not parse its input, which reads as filing a Linear ticket, so it refuses the call."
      : undefined
  }
  const { cwd, tool_input: toolInput, tool_name: tool } = payload as Record<string, unknown>
  const input =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : undefined
  if (tool === "Bash") {
    const command = input?.command
    if (typeof command !== "string" || !candidate(command)) return
    const directory = typeof cwd === "string" ? cwd : undefined
    const env: Env = {
      cwd: directory,
      files: new Map(),
      known: knownVariables(command, environment, directory),
      process: environment,
      vars: new Map(),
    }
    return run(lex(command, env.known), env, ticket)
  }
  if (typeof tool !== "string") return
  const key = FILE_TOOLS.get(tool)
  if (key) return fileTool(tool, input?.[key], cwd, environment)
  return mcp(tool, input, environment, now)
}

if (import.meta.main) {
  const reason = await check(await Bun.stdin.text())
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
