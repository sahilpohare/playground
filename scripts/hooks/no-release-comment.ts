// PreToolUse hook: refuses a GitHub comment or review on a repo of an owner release-owners.json names whose text contains "release" (any case), since there an owner comment with that word publishes to npm, and gh and the GitHub MCP post as that owner.
import { join } from "node:path"

import { coreDir } from "../../packages/settings/src/rendered"
import { implicitRepos, type Repo, repoOf } from "./github"
import { input } from "./input"
import { guardList, isStrings } from "./lists"
import {
  type Command,
  CURL_TAKES,
  curlData,
  curlUrls,
  type Env,
  flagFromXargs,
  fromXargs,
  ghApi,
  ghCommand,
  knownVariables,
  lex,
  marked,
  parseFlags,
  PRINTERS,
  program,
  READ,
  readPath,
  resolveText,
  run,
  slice,
  stdinOf,
  type Text,
  UNKNOWN,
  unknown,
  unreadable,
  viaXargs,
  visible,
  type Visit,
  type Word,
  type Xargs,
} from "./shell"

type Target = { guarded: boolean; label: string }
type Spec = { files: string[]; takes: Set<string>; texts: string[] }

// The owners whose repos publish on the word, from release-owners.json, read at each check() (lists.ts).
let guardedOwners = new Set<string>()
const WORD = /release/i
const UNRESOLVED = "a repository the hook cannot resolve"

const GROUPS = new Set(["api", "issue", "pr"])

const spec = (texts: string[], files: string[], others: string[] = []): Spec => ({
  files,
  takes: new Set([...files, ...others, ...texts, "-R", "--repo"]),
  texts,
})
const COMMENT = spec(["--attach", "-b", "--body"], ["-F", "--body-file"])
const CLOSING = spec(["-c", "--comment"], [])
const SPECS = new Map<string, Spec>([
  ["issue close", spec(["-c", "--comment"], [], ["--duplicate-of", "-r", "--reason"])],
  ["issue comment", COMMENT],
  ["issue reopen", CLOSING],
  ["pr close", CLOSING],
  ["pr comment", COMMENT],
  ["pr reopen", CLOSING],
  ["pr review", spec(["-b", "--body"], ["-F", "--body-file"])],
])
const PR_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/i
const API_URL = /api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/([^\s?#]+)/i
const COMMENT_PATH = /(?:^|\/)(?:comments|replies|reviews)(?:\/|$)/
const COMMENT_MUTATION =
  /\b(?:addComment|addPullRequestReview(?:Comment|Thread|ThreadReply)?|submitPullRequestReview|updateIssueComment|updatePullRequestReview(?:Comment)?)\b/
const MCP_COMMENT =
  /^mcp__.+__(?:add_comment_to_pending_review|add_issue_comment|add_reply_to_pull_request_comment|pull_request_review_write|update_issue_comment)$/
const BODY_KEY = /body/i
const GH = /\bgh\b|github/i
// A comment verb or an API call: a Bash command naming neither is left alone before any parsing.
const MAYBE_COMMENT = /\b(?:api|close|comment|reopen|review)/i
// What an internal error still refuses: a call that reads as a comment, a review or a comment endpoint.
const COMMENT_CALL =
  /(?:\b|_)(?:close|comment|reopen|review)(?:\b|_)|\bapi\b[\s\S]*(?:comments|graphql|replies|reviews)/i

const comment: Visit = async (cmd, { args, first, local, name, xargs }, env) => {
  if (name === "gh") return gh(args, cmd, env, local, xargs)
  if (first?.unknown && GROUPS.has(args[0]?.value ?? "")) return gh(args, cmd, env, local, xargs)
  if (name === "curl") return curl(args, cmd, env)
  const nested = args.findIndex(
    (a, j) => program(a.value) === "gh" && GROUPS.has(args[j + 1]?.value ?? ""),
  )
  if (nested !== -1 && !PRINTERS.has(name)) {
    return gh(args.slice(nested + 1), cmd, env, local, xargs)
  }
}

async function gh(
  args: Word[],
  cmd: Command,
  env: Env,
  local: Map<string, Text>,
  xargs: Xargs,
): Promise<string | undefined> {
  const { head, repos, rest } = ghCommand(args)
  if (head[0] === "api") return api(rest, cmd, env, local, xargs)
  const key = head.join(" ")
  const found = SPECS.get(key)
  if (!found) return
  const { flags, positionals } = parseFlags(rest, found.takes)
  const bodies: Text[] = []
  for (const { name, value } of flags) {
    const body = found.texts.includes(name) || found.files.includes(name)
    if (!value) {
      if (body) bodies.push(unknown(`${name} with no value`))
    } else if (name === "--attach") bodies.push(altText(value))
    else if (found.texts.includes(name)) bodies.push(value)
    else if (found.files.includes(name)) {
      bodies.push(
        value.value === "-" && !value.unknown
          ? await stdinOf(cmd, env)
          : await readPath(value, env),
      )
    } else if (name === "-R" || name === "--repo") repos.push(value)
  }
  if (xargs && !xargs.replace) bodies.push(unknown("the arguments xargs appends"))
  // An argument xargs fills in can become any flag (`-b release` arrives as one argument), a body included.
  if (rest.some((a) => flagFromXargs(a, xargs))) {
    bodies.push(unknown(`what xargs puts in place of ${xargs?.replace}`))
  }
  if (bodies.length === 0) return
  // A positional the hook cannot read may be a pull request URL, which picks the repository; so do arguments xargs appends.
  const named = [
    ...repos.map((r) => (fromXargs(r, xargs) ? undefined : repoOf(r))),
    ...positionals.flatMap((p) => {
      if (unreadable(p) || fromXargs(p, xargs)) return [undefined]
      return PR_URL.test(p.value) ? [repoOf(p)] : []
    }),
    ...(xargs && !xargs.replace ? [undefined] : []),
  ]
  const target = decide(named.length > 0 ? named : implicitRepos(env, local))
  return judge(
    `gh ${key}`,
    target,
    bodies.map((b) => viaXargs(b, xargs)),
    env,
  )
}

// What `--attach '<file>#<alt>'` puts in the comment: the alt text, else the file's name; a variable before the first `#`, else before the last `/`, reaches neither, so that part reads as known.
function altText(value: Word): Text {
  const tail = Math.max(value.value.lastIndexOf(UNKNOWN), value.value.lastIndexOf(READ)) + 1
  const hash = value.value.indexOf("#")
  const from = hash === -1 ? value.value.lastIndexOf("/") + 1 : hash + 1
  const alt = slice(value, from)
  return tail > 0 && from > tail ? { reads: alt.reads, value: alt.value } : alt
}

async function api(
  args: Word[],
  cmd: Command,
  env: Env,
  local: Map<string, Text>,
  xargs: Xargs,
): Promise<string | undefined> {
  const request = await ghApi(args, cmd, env, xargs)
  if (!request || ["DELETE", "GET", "HEAD"].includes(request.method)) return
  const { endpoint, fields, inputs } = request
  if (endpoint.value === "graphql") {
    const documents = [...fields.filter((f) => f.key === "query").map((f) => f.text), ...inputs]
    const resolved = await Promise.all(documents.map((d) => resolveText(d, env)))
    if (!resolved.some((d) => d.unknown || COMMENT_MUTATION.test(d.value))) return
    return judge(
      "gh api graphql",
      { guarded: true, label: "a repository named only by a GraphQL node id" },
      [...fields.map((f) => f.text), ...inputs],
      env,
      INLINE_QUERY,
    )
  }
  const path = endpoint.value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^api\/v3\//, "")
    .split("?")[0]
  const match = /^repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path)
  const rest = match?.[3] ?? /^repositories\/[^/]+\/(.+)$/.exec(path)?.[1]
  const open = marked(path) || fromXargs(endpoint, xargs)
  if (rest !== undefined ? !COMMENT_PATH.test(rest) && !open : !open) return
  let candidates: (Repo | undefined)[] = [undefined]
  if (match?.[1] === "{owner}") candidates = implicitRepos(env, local)
  else if (match && !marked(match[1]) && !fromXargs({ value: `${match[1]}/${match[2]}` }, xargs)) {
    candidates = [{ owner: match[1], repo: match[2] }]
  }
  const bodies = [
    ...fields.filter((f) => marked(f.key) || BODY_KEY.test(f.key)).map((f) => f.text),
    ...(await Promise.all(inputs.map((i) => bodyOf(i, env)))),
  ]
  return judge(
    `gh api ${path.replaceAll(UNKNOWN, "*").replaceAll(READ, "*")}`,
    decide(candidates),
    bodies,
    env,
  )
}

// The text a JSON payload would post: every string under a key holding "body", or the whole text when it is not JSON.
async function bodyOf(payload: Text, env: Env): Promise<Text> {
  const text = await resolveText(payload, env)
  if (text.unknown) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text.value)
  } catch {
    return text
  }
  const found: string[] = []
  const visit = (node: unknown, inBody: boolean): void => {
    if (typeof node === "string" && inBody) found.push(node)
    else if (Array.isArray(node)) for (const item of node) visit(item, inBody)
    else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) visit(value, inBody || BODY_KEY.test(key))
    }
  }
  visit(parsed, false)
  return { value: found.join("\n") }
}

async function curl(args: Word[], cmd: Command, env: Env): Promise<string | undefined> {
  const { flags, positionals } = parseFlags(args, CURL_TAKES)
  const url = curlUrls(flags, positionals)
    .map((u) => API_URL.exec(u.value))
    .find((m) => m !== null)
  if (!url || !COMMENT_PATH.test(url[3])) return
  const data = await curlData(flags, cmd, env)
  if (data.length === 0) return
  const owner = marked(url[1]) ? undefined : { owner: url[1], repo: url[2] }
  return judge(
    `curl to api.github.com/repos/${url[1]}/${url[2]}`,
    decide([owner]),
    await Promise.all(data.map((d) => bodyOf(d, env))),
    env,
  )
}

function decide(candidates: (Repo | undefined)[]): Target {
  if (candidates.length === 0) return { guarded: true, label: UNRESOLVED }
  const hit = candidates.findIndex((c) => !c || guardedOwners.has(c.owner.toLowerCase()))
  if (hit === -1) return { guarded: false, label: "" }
  const repo = candidates[hit]
  return { guarded: true, label: repo ? `${repo.owner}/${repo.repo}` : UNRESOLVED }
}

function refuse(what: string, target: Target, detail: string, fix: string): string {
  return `no-release-comment hook refused ${what} on ${target.label}: ${detail}. On a guarded owner's repos an owner comment containing "release" in any case publishes to npm, and gh and the GitHub MCP post as that owner. ${fix}`
}

const READABLE =
  "Put the text in the command itself, or write the text to a file with the Write tool first, then run the command again in a call of its own that names that file by its literal absolute path (--body-file /abs/body.md)."

const INLINE_QUERY =
  "Write the query and each of its fields in the command itself, not in a variable: gh api graphql -f query='query { viewer { login } }'. For a long one, write it to a file with the Write tool first and pass it by its literal absolute path (-F query=@/abs/query.graphql, -F body=@/abs/body.md)."

const REWORD =
  'Write "ship" or "publish step" instead, or leave the comment out. For a file or rule whose name holds the word, name it by what it is, such as "the ship rule" or "the comment hook", with its line number; for a patch that holds it, write the patch to a file in your scratchpad, send the PR\'s worker one SendMessage holding its absolute path and, under it, its whole text, since an auto-end moves your scratch folder to the trash, and say in the comment that a patch went to the author, since gh\'s `--attach` uploads only images and video.'

async function judge(
  what: string,
  target: Target,
  bodies: Text[],
  env: Env,
  fix = READABLE,
): Promise<string | undefined> {
  if (!target.guarded) return
  const texts = await Promise.all(bodies.map((b) => resolveText(b, env)))
  if (texts.some((t) => WORD.test(visible(t.value))))
    return refuse(what, target, 'its text contains "release"', REWORD)
  const hidden = texts.find((t) => t.unknown)
  if (hidden) {
    return refuse(
      what,
      target,
      `the hook cannot read its text before the command runs (it comes from ${hidden.unknown})`,
      fix,
    )
  }
}

function mcp(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  const what = tool.replace(/^mcp__/, "")
  if (!input)
    return refuse(what, { guarded: true, label: UNRESOLVED }, "its input is not an object", REWORD)
  const { body, owner, repo } = input
  if (body === undefined || body === null) return
  const named =
    typeof owner === "string" && owner !== ""
      ? { owner, repo: typeof repo === "string" ? repo : "?" }
      : undefined
  const target = decide([named])
  if (!target.guarded) return
  if (typeof body !== "string")
    return refuse(what, target, "its body is not text the hook can read", REWORD)
  if (WORD.test(body)) return refuse(what, target, 'its text contains "release"', REWORD)
}

const commentCall = (raw: string): boolean => GH.test(raw) && COMMENT_CALL.test(raw)

// The cheap first look, made with quotes and backslashes gone so `g\h` or `comm''ent` still counts; $'...' can spell any word, so it always counts.
function candidate(command: string): boolean {
  const bare = command.replace(/[\\'"]/g, "")
  return command.includes("$'") || (GH.test(bare) && MAYBE_COMMENT.test(bare))
}

// Fails closed only on a call that reads as a comment: an error on any other call lets it run, so a parser bug cannot block every Bash command.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
  lists = join(coreDir(), "lists"),
): Promise<string | undefined> {
  const owners = await guardList(
    "no-release-comment",
    "release-owners",
    isStrings,
    [],
    environment,
    join(lists, "release-owners.json"),
  )
  if (owners.refusal) return commentCall(subjectOf(raw)) ? owners.refusal : undefined
  guardedOwners = new Set((owners.list ?? []).map((owner) => owner.toLowerCase()))
  try {
    return await inspect(raw, environment)
  } catch (error) {
    if (!commentCall(subjectOf(raw))) return
    return `no-release-comment hook could not read this call (${error}), which reads as a GitHub comment, so it refuses it. Split it into plain commands and run them again.`
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
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (typeof payload !== "object" || payload === null) {
    return commentCall(raw)
      ? "no-release-comment hook could not parse its input, which reads as a GitHub comment, so it refuses the call."
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
    return run(lex(command, env.known), env, comment)
  }
  if (typeof tool === "string" && MCP_COMMENT.test(tool)) return mcp(tool, input)
}

if (import.meta.main) {
  const reason = await check(await input("no-release-comment", "guard"))
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
