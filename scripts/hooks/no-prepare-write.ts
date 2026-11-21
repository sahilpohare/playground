// A check for a prepare-only session (its roster row reads mode=prepare, which an org's start job sets at a prepare-only start): it refuses the writes that would reach the org before the session claims its ticket, a tracker issue save (an assign or a state change), a tracker comment, a chat post, a new pull request (`gh pr create` or the GitHub tool), a `git push`, and the `gh api` and GitHub tool writes that open or merge a pull request, write a file or move a branch (README's closed list), and lets them run once the mode clears at the claim. guards.ts runs it on Bash and no-playground-leak's process on the MCP tools, so it has no main block of its own. It fails open, since the session's brief is the first bar: a read that fails lets the call run and writes a line to the data folder's ops/no-prepare-write.log.
import "../../packages/env/src/aliases"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import { gitCommand } from "./no-stash"
import { registryName } from "./role"
import {
  type Command,
  type Env,
  type Parsed,
  ghApi,
  ghCommand,
  knownVariables,
  lex,
  PRINTERS,
  program,
  run,
  unreadable,
  type Visit,
  type Word,
} from "./shell"

type Environment = Record<string, string | undefined>

const MCP_TOOL = /^mcp__(.+?)__(.+)$/
// Each MCP server's write tools a prepare-only session waits on, by a word its server's name holds.
const WRITES: [RegExp, Set<string>][] = [
  [
    /github/i,
    new Set([
      "create_branch",
      "create_or_update_file",
      "create_pull_request",
      "delete_file",
      "merge_pull_request",
      "push_files",
      "update_pull_request_branch",
    ]),
  ],
  [/linear/i, new Set(["save_comment", "save_issue"])],
  [/slack/i, new Set(["chat_post_message"])],
]

const refuse = (what: string): string =>
  `no-prepare-write hook refused ${what}: this session is preparing a ticket it has not claimed (its roster row reads mode=prepare), so nothing reaches the org yet: no tracker write, no chat post, no push, no file write, no pull request and no merge. Work on the local branch alone. Its waiter clears the mode the moment it prints its Claim line, and this call then runs.`

const log = (environment: Environment, entry: Record<string, unknown>) => {
  try {
    const dir = join(dataDirOf(environment), "ops")
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, "no-prepare-write.log"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    )
  } catch {}
}

const mcpWrite = (tool: string): boolean => {
  const [, server, name] = MCP_TOOL.exec(tool) ?? []
  return !!server && !!name && WRITES.some(([word, tools]) => word.test(server) && tools.has(name))
}

const prCreate = (args: Word[]): boolean => {
  const { head } = ghCommand(args)
  return head[0] === "pr" && head[1] === "create"
}

const pushes = (args: Word[]): boolean => gitCommand(args).sub?.value === "push"

// The GraphQL mutations that merge a pull request or move a ref, which no-protected-push refuses too; with createPullRequest, the ones that open or merge a pull request or move a ref, and the REST endpoints a write method does the same at.
export const REF_MOVE =
  /\b(?:createCommitOnBranch|createRef|deleteRef|mergeBranch|mergePullRequest|updatePullRequestBranch|updateRef|updateRefs)\b/
const REF_MUTATION = new RegExp(`${REF_MOVE.source}|\\bcreatePullRequest\\b`)
const REF_ENDPOINT =
  /^repos\/[^/]+\/[^/]+\/(?:contents\/.+|git\/refs(?:\/.+)?|merges|pulls|pulls\/\d+\/(?:merge|update-branch))$/

// Whether a gh api call opens a pull request or moves a ref: a graphql query naming such a mutation or one it cannot read, a write method to such an endpoint, or a write method to an endpoint it cannot read.
async function apiWrite(
  rest: Word[],
  cmd: Command,
  env: Env,
  xargs: Parsed["xargs"],
): Promise<boolean> {
  const request = await ghApi(rest, cmd, env, xargs)
  if (!request) return false
  const { endpoint, fields, inputs, method } = request
  const path = endpoint.value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^api\/v3\//, "")
    .split("?")[0]!
  if (path === "graphql" || path === "api/graphql")
    return [...fields.filter((f) => f.key === "query").map((f) => f.text), ...inputs].some(
      (d) => unreadable(d) || REF_MUTATION.test(d.value),
    )
  if (method === "GET" || method === "HEAD") return false
  if (unreadable(endpoint)) return true
  return REF_ENDPOINT.test(path)
}

const ghWrite = async (args: Word[], cmd: Command, env: Env, xargs: Parsed["xargs"]) => {
  if (prCreate(args)) return "gh pr create"
  const { head, rest } = ghCommand(args)
  return head[0] === "api" && (await apiWrite(rest, cmd, env, xargs)) ? "gh api" : undefined
}

const visit: Visit = async (cmd, { args, name, xargs }, env) => {
  if (name === "gh") return ghWrite(args, cmd, env, xargs)
  if (name === "git") return pushes(args) ? "git push" : undefined
  if (PRINTERS.has(name) || name === "man") return
  const nested = args.findIndex((a) => program(a.value) === "gh" || program(a.value) === "git")
  if (nested === -1) return
  const rest = args.slice(nested + 1)
  if (program(args[nested].value) === "git") return pushes(rest) ? "git push" : undefined
  return ghWrite(rest, cmd, env, xargs)
}

// The write the call makes, named, or undefined for any other call.
async function writeOf(
  tool: string,
  input: Record<string, unknown> | undefined,
  cwd: unknown,
  environment: Environment,
): Promise<string | undefined> {
  if (mcpWrite(tool)) return `the tool ${tool}`
  const command = input?.command
  if (tool !== "Bash" || typeof command !== "string" || !/gh|git/.test(command)) return
  const directory = typeof cwd === "string" ? cwd : undefined
  const env: Env = {
    cwd: directory,
    files: new Map(),
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map(),
  }
  return run(lex(command, env.known), env, visit)
}

// Whether the session's roster row reads mode=prepare; a session the registry or the roster does not hold is not marked, and a roster that does not read throws.
async function marked(sessionId: unknown, environment: Environment): Promise<boolean> {
  if (typeof sessionId !== "string") return false
  const name = await registryName(sessionId, environment)
  if (!name) return false
  const roster = (await Bun.file(join(dataDirOf(environment), "roster.json")).json()) as {
    agents?: { mode?: unknown; name?: unknown }[]
  }
  return roster.agents?.find((agent) => agent?.name === name)?.mode === "prepare"
}

export async function check(
  raw: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  let input: {
    cwd?: unknown
    session_id?: unknown
    tool_input?: Record<string, unknown>
    tool_name?: unknown
  }
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  const { cwd, session_id: session, tool_input: toolInput, tool_name: tool } = input
  if (typeof tool !== "string") return
  let write: string | undefined
  try {
    write = await writeOf(tool, toolInput, cwd, environment)
    if (!write) return
    return (await marked(session, environment)) ? refuse(write) : undefined
  } catch (error) {
    log(environment, { error: String(error), session, tool, write })
    return
  }
}
