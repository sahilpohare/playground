// PreToolUse hook for the factory's sessions, loaded from the factory settings file and, for a session resumed without its settings, the project settings, acting only for a factory session (role.ts): refuses a write to a guarded org's surface (Linear, Slack, a repository of an org ext.links guards, through gh, git, curl or the GitHub MCP) whose text holds a factory term, since the factory is private and stays out of every company write in any shape; a Slack MCP chat posting tool's post to a conversation in slack-cleared.json passes, signed where its entry names a signature; on the servers of an org whose extension gates its Slack sends (slack.gatedSends), every Slack write but a post to that org's self-DM is refused, and so is a curl that writes to Slack's API.
import "../../packages/env/src/aliases"
import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"

import { dataDir, dataDirOf } from "../../packages/env/src/data-dir"
import { heldBy, pushRemote, withLiveBudget } from "../../packages/safe-delete/src/live-refs"
import { guardedOrgs } from "../../packages/settings/src/ext"
import { coreDir, readPolicy, readPolicySync } from "../../packages/settings/src/rendered"
import { gatedSendsSchema } from "../../packages/settings/src/slack"
import { implicitRepos, type Repo, remoteRepo, remotes, repoOf } from "./github"
import { input } from "./input"
import { guardList, isRecord, isStrings } from "./lists"
import { check as prepareWrite } from "./no-prepare-write"
import { check as protectedPush } from "./no-protected-push"
import { readOnly } from "./read-only"
import { fromFactory } from "./role"
import {
  type ApiRequest,
  type Command,
  CURL_TAKES,
  curlData,
  curlUrls,
  type Env,
  type Flag,
  flagFromXargs,
  fromXargs,
  ghApi,
  ghCommand,
  GIT_TAKES,
  knownVariables,
  lex,
  marked,
  NOT_RUN,
  type Parsed,
  parseFlags,
  pastDeadline,
  pathOf,
  PRINTERS,
  program,
  readPath,
  resolveText,
  run,
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
import { startingVariables } from "./steady"

type Environment = Record<string, string | undefined>
// Where a write lands: on a surface the guard guards, off it, or somewhere the hook cannot tell; `byText` marks one only the network or the run could place (a GraphQL node id, a URL the run computes), which anyWrite judges by its text alone.
type Target = { byText?: true; label: string; where: "guarded" | "other" | "unknown" }
// What a hit in a write's text is, and the plain-words fix its refusal names.
export type Hit = { detail: string; fix: string }
// A text a write publishes, with the place in the write it fills and that place's own fix, so a refusal names which text held the term.
type Placed = Text & { where?: { fix?: string; name: string } }
const withPlace = (text: Text, name: string, fix?: string): Placed => ({
  ...text,
  where: { fix, name },
})
// What one guard guards, so another guard (no-public-leak, no-extension-repo-write) reads every write as this one does: the repositories it guards, what in a text it refuses, how its refusal reads, whether Linear and Slack (hosts) and git commits and pushes count, and whether any write that changes a guarded repository's git data or name is refused whatever its text (anyWrite), a git push that writes only branches other than the default passing (branchPush).
export type Policy = {
  anyWrite?: true
  branchPush?: true
  find: (text: string) => Hit | undefined
  gates?: Gate[]
  git: boolean
  guard: string
  guarded: (repo: Repo) => boolean
  hosts: boolean
  place: string
  what: string
  why: string
}
// An org whose extension gates its Slack sends (slack.gatedSends): a post on its servers passes only to its self-DM, and a declaration that does not read refuses every posting call, since the hook cannot tell which servers it covers.
type Gate = { org: string } & (
  | { broken: string }
  | { path: string; selfDm: string; servers: string[] }
)
type Terms = {
  aliases: string[]
  everyday: string[]
  names: string[]
  paths: string[]
  probe: string
  sessions: { roles: string[]; sins: string[] }
}

const EMPTY_TERMS: Terms = {
  aliases: [],
  everyday: [],
  names: [],
  paths: [],
  probe: "probe",
  sessions: { roles: [], sins: [] },
}
const isTerms = (value: unknown): value is Terms =>
  isRecord(value) &&
  ["aliases", "everyday", "names", "paths"].every((key) => isStrings(value[key])) &&
  typeof value.probe === "string" &&
  isRecord(value.sessions) &&
  isStrings(value.sessions.roles) &&
  isStrings(value.sessions.sins)
// Read at each check() from its lists folder, never at load, so a broken list refuses (lists.ts) rather than crash the hook open.
let terms = EMPTY_TERMS
// Slack conversations the owner cleared for talk about the factory, by id, a channel with a signature passing only posts that end with it.
type Cleared = Record<string, { name: string; signature?: string }>
const isCleared = (value: unknown): value is Cleared =>
  isRecord(value) &&
  Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      (entry.signature === undefined || typeof entry.signature === "string"),
  )
// The Slack MCP tools that post to the conversation their `channel` names; any other tool naming a `channel` (a user group) writes elsewhere. Curl is never cleared, since the hook cannot parse its data exactly as Slack does.
const CHAT_TOOL = /^chat_(?:me_message|post_ephemeral|post_message|schedule_message|update)$/
// Each cleared posting tool, by the key naming its conversation and the key holding its text; the claude.ai Slack connector's tool is cleared for a signed channel alone.
const POST_KEYS = { channel: "channel", text: "text" }
const CONNECTOR_TOOL = "slack_send_message"
const CONNECTOR_KEYS = { channel: "channel_id", text: "message" }
// The cleared conversations that take only signed posts, which curl may never write to.
const signed = (): string[] => {
  const { cleared } = state()
  return Object.keys(cleared).filter((c) => cleared[c].signature)
}
// A key naming a destination beside the tool's own channel key, which a Slack server may post to instead.
const OTHER_DESTINATION = /channel|conversation/i
// Fields Slack shows in place of a post's text, where a signature in the text would not show; blocks pass only as link chips (chipsSigned).
const RICH = ["attachments", "blocks", "markdown_text"]

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Link chips in a signed channel: blocks, an array or its JSON text, made only of rich_text blocks of rich_text_section elements holding text and links, whose last line is one italic text element reading the signature's words.
function chipsSigned(blocks: unknown, signature: string): boolean {
  let parsed = blocks
  if (typeof blocks === "string") {
    try {
      parsed = JSON.parse(blocks)
    } catch {
      return false
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) return false
  const children: Json[] = []
  // Each section starts a line of its own.
  const starts = new Set<Json>()
  for (const block of parsed) {
    if (!isJson(block) || block.type !== "rich_text" || !Array.isArray(block.elements)) return false
    if (!block.elements.length) return false
    for (const section of block.elements) {
      if (!isJson(section) || section.type !== "rich_text_section") return false
      if (!Array.isArray(section.elements)) return false
      if (isJson(section.elements[0])) starts.add(section.elements[0])
      for (const child of section.elements) {
        if (!isJson(child)) return false
        const text = child.type === "text" && typeof child.text === "string"
        const link =
          child.type === "link" &&
          typeof child.url === "string" &&
          (child.text === undefined || typeof child.text === "string")
        if (!text && !link) return false
        children.push(child)
      }
    }
  }
  const last = children.findLast((c) => c.type !== "text" || String(c.text).trim())
  const style = last?.style
  if (last?.type !== "text" || !isJson(style) || style.italic !== true) return false
  const text = String(last.text).trimEnd()
  const before = children[children.indexOf(last) - 1]
  const opensLine =
    text.includes("\n") || starts.has(last) || String(before?.text ?? "").endsWith("\n")
  return opensLine && text.split("\n").at(-1)?.trim() === signature.replace(/^_(.*)_$/, "$1")
}
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const HANDLE = /^[a-z\d][\w.-]{1,63}$/i
const MAX_ROSTER_BYTES = 1_048_576
// The checkout this hook runs from, whose skills/ holds the factory's skills.
const CHECKOUT = join(import.meta.dir, "..", "..")

// Every agent's name in the roster, since sessions are renamed and no list in the repo keeps up; a name that is an everyday word (`builder`) is left out so a guarded org's own words pass, and a roster that is missing or unreadable adds none.
export function rosterNames(environment: Environment): string[] {
  const path = join(dataDirOf(environment), "roster.json")
  try {
    if (statSync(path).size > MAX_ROSTER_BYTES) return []
    const agents = (JSON.parse(readFileSync(path, "utf8")) as { agents?: unknown })?.agents
    if (!Array.isArray(agents)) return []
    return agents.flatMap((a) => {
      const name = (a as { name?: unknown } | null)?.name
      return typeof name === "string" && notEveryday(name) ? [name] : []
    })
  } catch {
    return []
  }
}

const notEveryday = (name: string): boolean =>
  HANDLE.test(name) && !terms.everyday.some((w) => w.toLowerCase() === name.toLowerCase())

// Our own skills' names (`skills/playground/<name>/SKILL.md`), read each call so a new skill is covered with no edit; ZeroStarter's in `skills/zerostarter` are everyday words (dev, design, release), and so is the skill named for the company.
export function skillNames(checkout = CHECKOUT): string[] {
  const ours = join(checkout, "skills", "playground")
  try {
    return readdirSync(ours, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ours, d.name, "SKILL.md")))
      .map((d) => d.name)
      .filter(notEveryday)
  } catch {
    return []
  }
}

// A term stands alone: no letter or digit touches it, so `_` and `-` count as edges (`PLAYGROUND_ROLE` holds playground), and a name ending in `_` is a prefix (`PLAYGROUND_` holds `PLAYGROUND_ROLE`). A session pattern takes only the seven sins, so `worker-pool` and `probe-path` are not one; other probes are matched by their roster name.
function pattern(environment: Environment, checkout = CHECKOUT): RegExp {
  const sources = [
    ...[...terms.names, ...terms.aliases, ...rosterNames(environment), ...skillNames(checkout)].map(
      (n) => escape(n).replace(/ /g, "[\\s_-]+") + (n.endsWith("_") ? "[a-z\\d_]*" : ""),
    ),
    ...terms.paths.map(escape),
    ...(terms.sessions.sins.length
      ? [
          `${escape(terms.probe)}-(?:(?:${terms.sessions.roles.join("|")})-)?(?:${terms.sessions.sins.join("|")})`,
          `(?:${terms.sessions.roles.join("|")})-(?:${terms.sessions.sins.join("|")})`,
        ]
      : []),
  ]
  // with no term at all, a pattern that matches nothing, since an empty alternation matches everywhere
  if (!sources.length) return /(?!)/
  return new RegExp(`(?<![a-z\\d])(?:${sources.join("|")})(?![a-z\\d])`, "i")
}

export const REPHRASE = "Say it without the term: name the work, not who did it or how it is run."
const READABLE = `Put the text in the command itself, or write the text to a file with the Write tool first, then run the command again in a call of its own that names that file by its literal absolute path (--body-file /abs/body.md, or -F /abs/msg.md for a commit). ${NOT_RUN}`
const MCP_READABLE = "Pass the input as an object whose fields are strings."

type Spec = { files: string[]; takes: Set<string>; texts: string[] }

const spec = (texts: string[], files: string[], others: string[] = []): Spec => ({
  files,
  takes: new Set([...files, ...others, ...texts, "-R", "--repo"]),
  texts,
})
const BODY = ["-b", "--body"]
// The place each gh text flag fills, by its long name, which a refusal names.
const FLAG_PLACES: Record<string, string> = {
  "--body": "its body",
  "--body-file": "its body file",
  "--comment": "its comment",
  "--notes": "its notes",
  "--notes-file": "its notes file",
  "--title": "its title",
}
// A flag's long name in its write's spec, where each short flag sits just before its long one, so -F reads as --notes-file for a ship and --body-file for a pull request.
function longName(name: string, flags: string[]): string {
  const next = flags[flags.indexOf(name) + 1]
  return name.startsWith("--") || !next?.startsWith("--") ? name : next
}
const BODY_FILE = ["-F", "--body-file"]
const CLOSING = spec(["-c", "--comment"], [], ["-r", "--reason", "--duplicate-of"])
const EDIT = [
  "--add-assignee",
  "--add-label",
  "--add-project",
  "--add-reviewer",
  "-B",
  "--base",
  "-m",
  "--milestone",
  "--remove-assignee",
  "--remove-label",
  "--remove-project",
  "--remove-reviewer",
]
const NEW = [
  "-a",
  "--assignee",
  "-B",
  "--base",
  "-l",
  "--label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "-r",
  "--reviewer",
  "--recover",
  "-T",
  "--template",
]
// Each gh write, by the flags holding the text it posts, the flags naming a file of that text, and its other flags that take a value.
const GH_WRITES = new Map<string, Spec>([
  ["issue close", CLOSING],
  ["issue comment", spec([...BODY, "--attach"], BODY_FILE)],
  ["issue create", spec([...BODY, "-t", "--title"], BODY_FILE, NEW)],
  ["issue edit", spec([...BODY, "-t", "--title"], BODY_FILE, EDIT)],
  ["issue reopen", CLOSING],
  ["label create", spec(["-d", "--description"], [], ["-c", "--color"])],
  ["label edit", spec(["-d", "--description", "-n", "--name"], [], ["-c", "--color"])],
  ["pr close", CLOSING],
  ["pr comment", spec([...BODY, "--attach"], BODY_FILE)],
  ["pr create", spec([...BODY, "--attach", "-H", "--head", "-t", "--title"], BODY_FILE, NEW)],
  ["pr edit", spec([...BODY, "-t", "--title"], BODY_FILE, EDIT)],
  [
    "pr merge",
    spec([...BODY, "-t", "--subject"], BODY_FILE, ["-A", "--author-email", "--match-head-commit"]),
  ],
  ["pr reopen", CLOSING],
  ["pr review", spec(BODY, BODY_FILE)],
  [
    "release create",
    spec(
      ["-n", "--notes", "-t", "--title"],
      ["-F", "--notes-file"],
      ["--discussion-category", "--notes-start-tag", "--target"],
    ),
  ],
  [
    "release edit",
    spec(
      ["-n", "--notes", "-t", "--title", "--tag"],
      ["-F", "--notes-file"],
      ["--discussion-category", "--target"],
    ),
  ],
])
const GH_GROUPS = new Set(["api", "issue", "label", "pr", "release"])
const PR_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/i
const COMMIT_TAKES = new Set([
  "--author",
  "-c",
  "-C",
  "--cleanup",
  "--date",
  "-F",
  "--file",
  "--fixup",
  "-m",
  "--message",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "-t",
  "--template",
  "--trailer",
])
const PUSH_TAKES = new Set(["--exec", "-o", "--push-option", "--receive-pack", "--repo"])
// Under anyWrite: the gh repo verbs that change a repository's git data or name, each by its flags that take a value, and the issue and pull request conversation that passes.
const REPO_WRITES = new Map<string, string[]>([
  ["repo archive", []],
  ["repo delete", []],
  [
    "repo edit",
    [
      "--add-topic",
      "-d",
      "--default-branch",
      "--description",
      "-h",
      "--homepage",
      "--remove-topic",
      "--visibility",
    ],
  ],
  ["repo rename", []],
  ["repo sync", ["-b", "--branch", "-s", "--source"]],
  ["repo unarchive", []],
])
const CONVERSATION = new Set([
  "pr close",
  "pr comment",
  "pr create",
  "pr edit",
  "pr reopen",
  "pr review",
])
const CONVERSATION_TOOL =
  /^(?:add_comment_to_pending_review|add_issue_comment|add_reply_to_pull_request_comment|create_pull_request|issue_write|pull_request_review_write|request_copilot_review|sub_issue_write|update_issue_comment|update_pull_request)$/
const CREATE_TAKES = [
  "-d",
  "--description",
  "-g",
  "--gitignore",
  "-h",
  "--homepage",
  "-l",
  "--license",
  "-p",
  "--template",
  "-r",
  "--remote",
  "-s",
  "--source",
  "-t",
  "--team",
]
const SUBTREE_TAKES = new Set(["-b", "--branch", "-m", "--message", "--onto", "-P", "--prefix"])
const PLACE_FIX = `Run any setup (a git config or remote change, a clone, gh repo set-default) in a call of its own first, then name where the write goes by its literal value in a call of its own: a git push run plainly, with no -c, --config-env, --git-dir or GIT_ variable, to a remote or URL the hook can read (a remote whose URL is a local path cannot be placed, so push from a clone of its GitHub URL), gh -R <owner>/<repo>, or repos/<owner>/<name>/... for gh api. ${NOT_RUN}`
// Under anyWrite: the gh verbs outside GH_WRITES that change git data, placed as pr merge is; a command that changes the git or gh state a later write is placed by; and whether one ran earlier in the call.
const ANY_GH_WRITES = new Map<string, Spec>([
  ["pr update-branch", spec([], [])],
  ["release delete", spec([], [])],
  ["release upload", spec([], [])],
])
// gh api fills these from the checkout's repository.
const PLACEHOLDER = /^(?::owner|:repo|\{owner\}|\{repo\})$/
const GH_STATE = new Set(["config set", "repo clone", "repo fork", "repo set-default"])
const GIT_CONFIG_PATH = /(?:^|\/)\.git(?:\/|$)|\.gitconfig|(?:^|\/)git\/config$/
const CONFIG_WRITE =
  /^--(?:add|edit|remove-section|rename-section|replace-all|unset|unset-all)$|^-e$/
const CONFIG_READ = /^--(?:get|get-all|get-color|get-colorbool|get-regexp|get-urlmatch|list)$|^-l$/
const CONFIG_TAKES = new Set(["--blob", "--default", "-f", "--file", "--type"])
let builtins: Set<string> | undefined
const MCP_TOOL = /^mcp__(.+?)__(.+)$/
const READ_TOOL =
  /^(?:download|extract|fetch|get|list|read|search)_|_(?:history|info|list|read|replies|search|unreads)$/
const INNER = new Set(["curl", "gh", "git"])
// A Bash command naming none of these is left alone before any parsing; $'...' can spell any word, so it always counts.
const MAYBE = /curl|gh|git/i
// anyWrite's too: an unknown program's gh repo or alias verb, or git's send-pack or subtree.
const MAYBE_ANY = /alias|curl|gh|git|repo|send-pack|subtree/i
// What an internal error still refuses: a call to a guarded org's tool or a writing command.
const WRITE_CALL = /\b(?:curl|gh|git)\b|github|linear|slack/i

// term is the pattern check() builds each call, from the terms file, the roster and the skills as they stand; one matching nothing outside a check
const leakPolicy = (orgs: Set<string>, term = /(?!)/): Policy => ({
  find: (text) => {
    const found = term.exec(visible(text))?.[0]
    return found ? { detail: `"${found}", a factory term`, fix: REPHRASE } : undefined
  },
  git: true,
  guard: "no-playground-leak",
  guarded: (repo) => orgs.has(repo.owner.toLowerCase()),
  hosts: true,
  place: "a guarded org",
  what: "a factory term",
  why: "the factory is private, so nothing about it, its skills or its sessions goes into anything a guarded org sees, in any shape.",
})
// One inspectAs call's own state, held in its async context so checks that overlap in one process never read each other's: its policy, Slack's cleared conversations and the folder the call starts in.
// Under anyWrite, `changed` and `moved` say whether the call has run a git or gh command or a program the hook cannot name, and `movedBefore` whether one ran before the command being read, which may have moved the branch a bare push reads its remote from.
type Call = {
  changed: boolean
  cleared: Cleared
  moved: boolean
  movedBefore: boolean
  policy: Policy
  startCwd?: string
}
const calls = new AsyncLocalStorage<Call>()
const IDLE: Call = {
  changed: false,
  cleared: {},
  moved: false,
  movedBefore: false,
  policy: leakPolicy(new Set()),
}
const state = (): Call => calls.getStore() ?? IDLE

const lower = (text: string) => text[0].toLowerCase() + text.slice(1)

function refuse(what: string, target: Target, detail: string, fix: string): string {
  return `${state().policy.guard} hook refused ${what} to ${target.label}: ${detail}. ${state().policy.why} ${fix}`
}

// Under anyWrite, a write to a guarded repository, or one the hook cannot place, whatever its text.
function refuseAny(what: string, target: Target, fix = NOT_RUN): string {
  return target.where === "guarded"
    ? refuse(what, target, `it writes to ${state().policy.place}`, fix)
    : refuse(
        what,
        target,
        `the hook cannot tell whether it writes to ${state().policy.place}`,
        PLACE_FIX,
      )
}

// `texts` must be read before the write runs; `extras` (a PR number, a URL) are searched only when the hook can read them.
async function judge(
  what: string,
  target: Target,
  texts: Placed[],
  env: Env,
  extras: Text[] = [],
): Promise<string | undefined> {
  if (target.where === "other") return
  if (state().policy.anyWrite && !target.byText) return refuseAny(what, target)
  const resolved = await Promise.all(texts.map((t) => resolveText(t, env)))
  const seen = (await Promise.all(extras.map((t) => resolveText(t, env)))).filter((t) => !t.unknown)
  const hits = [...resolved, ...seen].map((t) => state().policy.find(t.value))
  const at = hits.findIndex(Boolean)
  const hit = hits[at]
  const where = texts[at]?.where
  const holds = hit && `${hit.detail}${where ? `, in ${where.name}` : ""}`
  const fix = hit && (where?.fix ? `${hit.fix} ${where.fix}` : hit.fix)
  if (target.where === "unknown") {
    if (!hit) return
    return refuse(
      what,
      target,
      `the hook cannot tell whether it writes to ${state().policy.place}, and its text holds ${holds}`,
      `Name where it goes by its literal value in a call of its own (gh -R <owner>/<repo>, the pull request number or URL, git -C /abs/checkout, the URL itself, or a REST endpoint naming the repository in place of a GraphQL node id), or ${lower(fix ?? "")} ${NOT_RUN}`,
    )
  }
  if (hit) return refuse(what, target, `its text holds ${holds}`, fix ?? hit.fix)
  const hidden = resolved.find((t) => t.unknown)
  if (hidden) {
    return refuse(
      what,
      target,
      `the hook cannot read its text before it runs (it comes from ${hidden.unknown}), so it may hold ${state().policy.what}`,
      READABLE,
    )
  }
}

// Guarded when any candidate is a repository the policy guards, unknown when one cannot be read or none is named, else not guarded.
function decide(candidates: (Repo | undefined)[]): Target {
  const ours = candidates.find((c) => c && state().policy.guarded(c))
  if (ours) return { label: `${ours.owner}/${ours.repo}`, where: "guarded" }
  if (candidates.length === 0 || candidates.some((c) => !c)) {
    return { label: "a repository the hook cannot resolve", where: "unknown" }
  }
  return { label: "", where: "other" }
}

// Under anyWrite, the arguments an xargs with no replace string appends from its input, which the hook cannot read.
const XARGS_INPUT: Word = { quoted: false, unknown: "xargs's input", value: UNKNOWN }

const leak: Visit = async (cmd, parsed, env) => {
  const { first, name, xargs } = parsed
  if (state().policy.anyWrite) pastDeadline()
  const appended = state().policy.anyWrite && xargs && xargs.replace === undefined
  const args =
    appended && parsed.args.at(-1) !== XARGS_INPUT ? [...parsed.args, XARGS_INPUT] : parsed.args
  if (state().policy.anyWrite && changesState(cmd, parsed)) state().changed = true
  if (state().policy.anyWrite) {
    state().movedBefore = state().moved
    if (MOVERS.has(name) || first?.unknown) state().moved = true
  }
  const head = args[0]?.value ?? ""
  const group =
    GH_GROUPS.has(head) || (state().policy.anyWrite && (head === "alias" || head === "repo"))
  if (name === "gh" || (first?.unknown && group)) {
    const verdict = await gh(args, cmd, env, parsed.local, xargs)
    // Under anyWrite, an unknown program whose words read as no gh write may still run one after them.
    if (verdict || name === "gh" || !state().policy.anyWrite) return verdict
  }
  const pusher = state().policy.anyWrite && (head === "send-pack" || head === "subtree")
  if (name === "git" || (first?.unknown && (head === "commit" || head === "push" || pusher)))
    return state().policy.git ? git(args, cmd, env, parsed.local) : undefined
  if (name === "curl") return curl(args, cmd, env, xargs)
  if (PRINTERS.has(name)) return
  // A wrapper the reader does not know (`vault run -- gh ...`, `uv run git ...`) runs the command after it.
  const at = args.findIndex((a) => INNER.has(program(a.value)))
  if (at === -1) return
  const inner: Parsed = {
    ...parsed,
    args: args.slice(at + 1),
    first: args[at],
    name: program(args[at].value),
  }
  const verdict = await leak(cmd, inner, env)
  // A path word read as the program may be a folder or file the program the hook does not know takes, so the refusal says what it read.
  if (!verdict || args[at].value === inner.name) return verdict
  const read = `It read a word whose path ends in /${inner.name} as ${inner.name} run by ${name}, a program it does not know: a folder or file passes under a path that does not end in /${inner.name}, and ${inner.name} run by ${name} is read the same when written by its own name, ${inner.name}.`
  return verdict.endsWith(NOT_RUN)
    ? `${verdict.slice(0, -NOT_RUN.length)}${read} ${NOT_RUN}`
    : `${verdict} ${read}`
}

// Under anyWrite, whether a command changes what a later write in the call is placed by: a git config write, a remote added, renamed, removed or repointed, a clone, init or submodule, gh's clone, fork, set-default or config set, or any other command naming a .git path or a git config file.
function changesState(cmd: Command, { args, name }: Parsed): boolean {
  const words = args.map((a) => a.value)
  if (name === "gh") return GH_STATE.has(ghCommand(args).head.join(" "))
  if (name === "git") {
    let k = 0
    while (k < words.length && words[k].startsWith("-")) k += GIT_TAKES.has(words[k]) ? 2 : 1
    const [sub, ...rest] = words.slice(k)
    if (sub === "clone" || sub === "init" || sub === "submodule") return true
    const verb = rest.find((w) => !w.startsWith("-"))
    if (sub === "remote") return ["add", "remove", "rename", "rm", "set-url"].includes(verb ?? "")
    if (sub !== "config") return false
    // get and list are verbs only as the first word, since `git config <key> <value> list` sets the key
    const { flags, positionals } = parseFlags(args.slice(k + 1), CONFIG_TAKES)
    const first = positionals[0]?.value ?? ""
    if (flags.some((f) => CONFIG_WRITE.test(f.name))) return true
    if (first === "get" || first === "list") return false
    if (["edit", "remove-section", "rename-section", "set", "unset"].includes(first)) return true
    if (flags.some((f) => CONFIG_READ.test(f.name))) return false
    return positionals.length > 1
  }
  const targets = cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))
  return [...args, ...targets].some((w) => GIT_CONFIG_PATH.test(w.value))
}

// Under anyWrite, the programs after which a bare push reads every branch's remote keys, since any of them may move HEAD.
const MOVERS = new Set(["gh", "git"])

// The repositories gh falls back to, none it can trust under anyWrite once an earlier command in the call changed them.
const implicit = (env: Env, local: Map<string, Text>) =>
  state().policy.anyWrite && state().changed ? [undefined] : implicitRepos(env, local)

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
  if (state().policy.anyWrite) {
    if (key === "alias import" || key === "alias set") {
      return refuse(
        `gh ${key}`,
        decide([]),
        "an alias can run any gh write under a name the hook does not read",
        `Run the gh command itself, in a call of its own. ${NOT_RUN}`,
      )
    }
    if (head[0] === "issue" || head[0] === "label" || CONVERSATION.has(key)) return
    if (key === "repo create" || key === "repo fork" || key === "repo rename") {
      const refused = created(key, rest, env, xargs)
      if (refused || key !== "repo rename") return refused
    }
    const takes = REPO_WRITES.get(key)
    if (takes) return repoWrite(key, rest, repos, env, local, xargs, takes)
  }
  const found = GH_WRITES.get(key) ?? (state().policy.anyWrite ? ANY_GH_WRITES.get(key) : undefined)
  if (!found) return
  const { flags, positionals } = parseFlags(rest, found.takes)
  const texts: Placed[] = []
  for (const { name, value } of flags) {
    const posts = found.texts.includes(name) || found.files.includes(name)
    const long = longName(name, found.texts.includes(name) ? found.texts : found.files)
    const place = FLAG_PLACES[long] ?? `its ${long} value`
    if (!value) {
      if (posts) texts.push(unknown(`${name} with no value`))
    } else if (found.texts.includes(name)) texts.push(withPlace(value, place))
    else if (found.files.includes(name)) {
      const file =
        value.value === "-" && !value.unknown ? await stdinOf(cmd, env) : await readPath(value, env)
      texts.push(withPlace(file, place))
    } else if (name === "-R" || name === "--repo") repos.push(value)
  }
  if (xargs && !xargs.replace) texts.push(unknown("the arguments xargs appends"))
  if (rest.some((a) => flagFromXargs(a, xargs))) {
    texts.push(unknown(`what xargs puts in place of ${xargs?.replace}`))
  }
  const flagged = repos.map((r) => (fromXargs(r, xargs) ? undefined : repoOf(r)))
  // A positional the hook cannot read may be a pull request URL, which picks the repository; under anyWrite a shell value or the input a plain xargs appends is placed as a number is, by -R or the checkout, while an xargs -I string stays unplaced.
  const urls = positionals.flatMap((p) => {
    if (fromXargs(p, xargs)) return [undefined]
    if (p === XARGS_INPUT || p.unknown || p.reads?.length || p.value.includes(UNKNOWN))
      return state().policy.anyWrite ? [] : [undefined]
    return PR_URL.test(p.value) ? [repoOf(p)] : []
  })
  const named = [...flagged, ...urls]
  const placed = urls.some(Boolean)
  const fallback = flagged.length > 0 || placed ? [] : implicit(env, local)
  if (!placed) {
    const refused = unplaced(`gh ${key}`, flagged.length > 0 ? flagged : fallback, env)
    if (refused) return refused
  }
  const target = decide(named.length > 0 ? named : fallback)
  if (key === "pr create" && target.where !== "other") texts.push(...prCreate(rest, flags, env))
  return judge(
    `gh ${key}`,
    target,
    texts.map((t) => viaXargs(t, xargs)),
    env,
    positionals,
  )
}

// Under anyWrite, a repository a write creates or renames to, refused at a guarded name or a name it cannot read; an owner gh picks itself (the signed-in account) is *, which a guarded repository of that name matches.
function destination(
  what: string,
  owner?: string,
  name?: string,
  fix?: string,
): string | undefined {
  if (owner === undefined || name === undefined) return refuseAny(what, decide([undefined]))
  if (!state().policy.guarded({ owner, repo: name })) return
  const label = owner === "*" ? `a repository named ${name}` : `${owner}/${name}`
  return refuseAny(what, { label, where: "guarded" }, fix)
}

// The name gh repo create or rename makes, from its positional or create's --source folder, and gh repo fork's --fork-name under its --org.
function created(key: string, rest: Word[], env: Env, xargs: Xargs): string | undefined {
  const takes = key === "repo create" ? CREATE_TAKES : ["--fork-name", "--org", "--remote-name"]
  const { flags, positionals } = parseFlags(rest, new Set([...takes, "-R", "--repo"]))
  const flag = (...names: string[]) => flags.findLast((f) => names.includes(f.name))
  const read = (w?: Word) =>
    !w || w.unknown || w.reads?.length || marked(w.value) || fromXargs(w, xargs)
      ? undefined
      : w.value
  const what = `gh ${key}`
  if (key === "repo fork") {
    const name = flag("--fork-name")
    if (!name) return
    const org = flag("--org")
    return destination(what, org ? read(org.value) : "*", read(name.value))
  }
  const [given] = positionals
  if (given || key === "repo rename") {
    const parts = read(given)?.split("/").filter(Boolean) ?? []
    const owner = key === "repo create" && parts.length > 1 ? parts.at(-2) : "*"
    return destination(what, owner, parts.at(-1))
  }
  const source = flag("-s", "--source")?.value
  const path = source && read(source) !== undefined ? pathOf(source, env) : undefined
  return destination(what, "*", path && basename(path))
}

// A gh repo verb under anyWrite, on the repository its first positional names (rename's is the new name), else -R, else the one gh falls back to; sync with no destination writes only the local clone.
function repoWrite(
  key: string,
  rest: Word[],
  repos: Word[],
  env: Env,
  local: Map<string, Text>,
  xargs: Xargs,
  takes: string[],
): Promise<string | undefined> {
  const { flags, positionals } = parseFlags(rest, new Set([...takes, "-R", "--repo"]))
  for (const { name, value } of flags)
    if (value && (name === "-R" || name === "--repo")) repos.push(value)
  const named = key === "repo rename" ? [] : positionals.slice(0, 1)
  if (key === "repo sync" && named.length === 0) return Promise.resolve(undefined)
  const given = (named.length > 0 ? named : repos).map((w) =>
    fromXargs(w, xargs) || marked(w.value) ? undefined : repoOf(w),
  )
  return judge(`gh ${key}`, decide(given.length > 0 ? given : implicit(env, local)), [], env)
}

// A gh write whose repository comes from a value the hook cannot read (-R $R, GH_REPO=$R, repos/$R) or a directory it lost (a cd, popd or env -C it cannot follow) may write to a guarded org, so it is refused before its text is judged.
function unplaced(what: string, source: (Repo | undefined)[], env: Env): string | undefined {
  const lost = source.length === 0 && !env.cwd
  if (!lost && source.every(Boolean)) return
  if (state().policy.anyWrite && state().changed)
    return refuse(
      what,
      decide([]),
      "an earlier command in the call changes the git or gh state it is placed by",
      PLACE_FIX,
    )
  return refuse(
    what,
    decide([]),
    lost
      ? "the hook cannot tell which repository it writes to, since it names none and runs in a directory the hook lost (after a cd, popd or env -C it cannot follow)"
      : "the hook cannot tell which repository it writes to, since it names it through a value the hook cannot read",
    `Name the repository by its literal value (--repo <owner>/<name>, or repos/<owner>/<name>/... for gh api), or cd to a literal path, in a call of its own. ${NOT_RUN}`,
  )
}

// What `gh pr create` publishes beyond its flags: with no --head, the branch it opens from and the commits it may push, those its branch's push remote holds no live branch of (heldBy) (with --head it opens from that branch, already pushed, and pushes nothing; gh keeps the last --head, and only a non-empty literal counts, so one empty, only whitespace, unreadable, or holding $, a backtick, a glob character or a quote reads as none), and with --fill the messages it reads.
function prCreate(rest: Word[], flags: Flag[], env: Env): Placed[] {
  const values = rest.map((w) => w.value)
  const texts: Placed[] = []
  const head = flags.findLast((f) => f.name === "-H" || f.name === "--head")?.value
  if (!head || unreadable(head) || !head.value.trim() || /[$`*?[\]'"]/.test(head.value))
    texts.push(
      ...commitTexts(
        env.cwd,
        ["HEAD", "--not", ...(env.cwd ? heldBy(env.cwd, pushRemote(env.cwd)) : [])],
        "the commits it may push",
        ", which it may push",
      ),
      withPlace(branch(env.cwd), "the branch it opens from"),
    )
  if (values.some((v) => v === "-f" || v.startsWith("--fill"))) {
    const at = values.findIndex((v) => /^(?:-B|--base)(?:=|$)/.test(v))
    const base =
      at === -1 ? "HEAD" : values[at].includes("=") ? values[at].split("=")[1] : values[at + 1]
    texts.push(
      ...(base && !base.includes(UNKNOWN)
        ? commitTexts(
            env.cwd,
            [`origin/${base}..HEAD`],
            "the commits --fill reads",
            ", which --fill reads",
          )
        : [unknown("the base --fill reads from")]),
    )
  }
  return texts
}

const branch = (dir: string | undefined): Text =>
  gitText(dir, ["branch", "--show-current"], "the current branch")

// gh api fields whose value is text a write posts; the rest (a number, a SHA) are searched only when readable.
const TEXT_FIELD =
  /body|branch|comment|description|head|message|name|notes|query|ref|subject|text|title/i

async function api(
  args: Word[],
  cmd: Command,
  env: Env,
  local: Map<string, Text>,
  xargs: Xargs,
): Promise<string | undefined> {
  const request = await ghApi(args, cmd, env, xargs)
  if (!request || ["GET", "HEAD"].includes(request.method)) return
  // Under anyWrite, a plain xargs before a gh api with no method, field or input of its own reads, since only the words it appends make it a write.
  if (state().policy.anyWrite && xargs && !xargs.replace) {
    const method = args.some((a) => /^(?:-[A-Za-z]*X|--method)/.test(a.value))
    if (!method && request.fields.length === 1 && request.inputs.length === 0) return
  }
  if (request.method === "DELETE" && !state().policy.anyWrite) return
  const { endpoint, fields, inputs } = request
  const posted = (f: { key: string }) =>
    endpoint.value === "graphql" || f.key.includes(UNKNOWN) || TEXT_FIELD.test(f.key)
  const texts = [...fields.filter(posted).map((f) => f.text), ...inputs]
  const extras = [endpoint, ...fields.filter((f) => !posted(f)).map((f) => f.text)]
  if (endpoint.value === "graphql") {
    const documents = await Promise.all(
      [...fields.filter((f) => f.key === "query").map((f) => f.text), ...inputs].map((d) =>
        resolveText(d, env),
      ),
    )
    if (!documents.some((d) => d.unknown || /\bmutation\b/.test(d.value))) return
    const target: Target = {
      byText: true,
      label: "a repository named only by a GraphQL node id",
      where: "unknown",
    }
    return judge("gh api graphql", target, texts, env, extras)
  }
  const value = endpoint.value
  const host = hostTarget(value)
  if (host) return judge(`gh api ${host.label}`, host, texts, env, extras)
  const typed = value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^api\/v3\//, "")
  const path = state().policy.anyWrite ? dotless(typed) : typed
  const repo = /^repos\/([^/]+)\/([^/]+)/.exec(path)
  const org = /^orgs\/([^/]+)/.exec(path)
  const what = `gh api ${path.split("?")[0]}`
  if (state().policy.anyWrite) {
    const refused = await apiDestination(what, request, path, env)
    if (refused) return refused
  }
  if (state().policy.anyWrite && repo && conversation(path.slice(repo[0].length))) return
  if (state().policy.anyWrite && path.startsWith("repositories/"))
    return judge(what, { label: "a repository named only by its id", where: "unknown" }, [], env)
  let candidates: (Repo | undefined)[]
  if (fromXargs(endpoint, xargs)) candidates = [undefined]
  else if (
    state().policy.anyWrite &&
    repo &&
    (PLACEHOLDER.test(repo[1]) || PLACEHOLDER.test(repo[2]))
  )
    candidates = implicit(env, local).map(
      (r) =>
        r && {
          owner: PLACEHOLDER.test(repo[1]) ? r.owner : repo[1],
          repo: PLACEHOLDER.test(repo[2]) ? r.repo : repo[2],
        },
    )
  else if (repo?.[1] === "{owner}") candidates = implicit(env, local)
  else if (repo) candidates = [marked(repo[0]) ? undefined : { owner: repo[1], repo: repo[2] }]
  else if (org) candidates = [marked(org[0]) ? undefined : { owner: org[1], repo: "*" }]
  else if (marked(value) && (/^(repos|orgs)\//.test(path) || marked(path.split("/")[0])))
    candidates = [undefined]
  else if (marked(value)) return judge(what, decide([undefined]), texts, env, extras)
  else return
  return unplaced(what, candidates, env) ?? judge(what, decide(candidates), texts, env, extras)
}

// Under anyWrite, the repository a REST call creates, renames, generates, forks under a new name or transfers to, read from its fields.
async function apiDestination(
  what: string,
  request: ApiRequest,
  path: string,
  env: Env,
): Promise<string | undefined> {
  const { fields, inputs, method } = request
  const route = path.split(/[?#]/)[0].replace(/\/+$/, "")
  const has = (key: string) => fields.some((f) => f.key === key)
  const repo = /^repos\/([^/]+)\/([^/]+)(?:\/(forks|generate|transfer))?$/.exec(route)
  const org = /^orgs\/([^/]+)\/repos$/.exec(route)
  const fixed = (owner: string) => (PLACEHOLDER.test(owner) || marked(owner) ? "*" : owner)
  // A part is a field the call sends, by its key, or a literal owner or name.
  type Part = { key: string } | { value: string }
  const key = (k: string): Part => ({ key: k })
  const lit = (v: string): Part => ({ value: v })
  let dest: [Part, Part] | undefined
  if (method === "PATCH" && repo && !repo[3] && has("name"))
    dest = [lit(fixed(repo[1])), key("name")]
  else if (method !== "POST") return
  else if (repo?.[3] === "generate") dest = [has("owner") ? key("owner") : lit("*"), key("name")]
  else if (repo?.[3] === "transfer") {
    if (!has("new_name") && PLACEHOLDER.test(repo[2])) return destination(what)
    dest = [key("new_owner"), has("new_name") ? key("new_name") : lit(repo[2])]
  } else if (repo?.[3] === "forks" && has("name"))
    dest = [has("organization") ? key("organization") : lit("*"), key("name")]
  else if (route === "user/repos") dest = [lit("*"), key("name")]
  else if (org) dest = [lit(fixed(org[1])), key("name")]
  if (!dest) return
  if (inputs.length > 0) return destination(what)
  const value = async (part: Part) => {
    if ("value" in part) return part.value
    const text = fields.findLast((f) => f.key === part.key)?.text
    const read = text && (await resolveText(text, env))
    return read && !read.unknown && !marked(read.value) ? read.value : undefined
  }
  return destination(what, await value(dest[0]), await value(dest[1]))
}

// A path with its dot segments resolved and empty ones dropped, as a URL reader resolves them, so repos/x/../<owner>/<name> is read where it lands.
function dotless(path: string): string {
  const [route, ...query] = path.split(/(?=[?#])/)
  const kept: string[] = []
  for (const segment of route.split("/")) {
    const plain = segment.toLowerCase().replaceAll("%2e", ".")
    if (plain === "..") kept.pop()
    else if (plain !== "." && plain !== "") kept.push(segment)
  }
  return [kept.join("/"), ...query].join("")
}

// An issue, label or pull request route, but a pull request's merge or branch update, with no dot segment or escape that could step past it; under anyWrite it is conversation, which passes.
function conversation(route: string): boolean {
  const segments = route.split(/[?#]/)[0].split("/").filter(Boolean)
  if (/[%\\]/.test(route) || segments.some((s) => s === "." || s === "..")) return false
  if (segments[0] === "issues" || segments[0] === "labels") return true
  return segments[0] === "pulls" && !segments.some((s) => s === "merge" || s === "update-branch")
}

// A URL's host, lowercased, past any user info and with no trailing dot.
const hostOf = (url: string): string | undefined =>
  /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i
    .exec(url)?.[1]
    ?.toLowerCase()
    .replace(/\.+$/, "")
const slackHost = (host: string | undefined): boolean =>
  host === "slack.com" || !!host?.endsWith(".slack.com")

// A URL on Linear's or Slack's API is a guarded org's; GitHub's API is judged by the repository in its path.
function hostTarget(url: string): Target | undefined {
  const host = hostOf(url)
  if (!host || !state().policy.hosts) return
  if (host === "linear.app" || host.endsWith(".linear.app"))
    return { label: "Linear", where: "guarded" }
  if (slackHost(host)) return { label: "Slack", where: "guarded" }
}

async function curl(
  args: Word[],
  cmd: Command,
  env: Env,
  xargs: Xargs,
): Promise<string | undefined> {
  const { flags, positionals } = parseFlags(args, CURL_TAKES)
  const urls = curlUrls(flags, positionals)
  const globs =
    state().policy.anyWrite === true &&
    !flags.some((f) => f.name === "-g" || f.name === "--globoff")
  if (state().policy.anyWrite) {
    // A Host header, --connect-to, --request-target or --resolve beside a word naming GitHub sends the request somewhere its URL does not name.
    const redirect = args.some(
      (a, i) =>
        /^--(?:connect-to|request-target|resolve)(?:=|$)/.test(a.value) ||
        ((a.value === "-H" || a.value === "--header") &&
          /^\s*host\s*:/i.test(args[i + 1]?.value ?? "")) ||
        /^(?:-H|--header=)\s*host\s*:/i.test(a.value),
    )
    if (redirect && args.some((a) => /github/i.test(a.value)))
      return judge("curl", { label: "a host the call redirects to", where: "unknown" }, [], env)
  }
  const targets = urls.map((u): Target => {
    if (u.unknown === XARGS_INPUT.unknown || (state().policy.anyWrite && fromXargs(u, xargs)))
      return u.unknown || curlWrites(flags)
        ? { label: "a URL xargs supplies from its input", where: "unknown" }
        : { label: "", where: "other" }
    const value = visible(u.value)
    if (u.unknown || u.reads?.length || value.includes(UNKNOWN) || fromXargs(u, xargs))
      return { byText: true, label: "a URL the hook cannot read", where: "unknown" }
    // curl takes a URL with no scheme as http.
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
    const host = hostTarget(url)
    if (host) return host
    if (state().policy.anyWrite) return curlTarget(url, globs)
    if (/^https?:\/\/api\.github\.com(?::\d+)?\/graphql(?:[/?#]|$)/i.test(url))
      return {
        byText: true,
        label: "a repository named only by a GraphQL node id",
        where: "unknown",
      }
    const repo = /api\.github\.com\/repos\/([^/\s]+)\/([^/\s?#]+)/i.exec(value)
    return repo ? decide([{ owner: repo[1], repo: repo[2] }]) : { label: "", where: "other" }
  })
  const target =
    targets.find((t) => t.where === "guarded") ?? targets.find((t) => t.where === "unknown")
  if (!target) return
  if (targets.some((t) => t.label === "Slack")) {
    const gated = gatedCurl(urls)
    if (gated) return gated
  }
  const data = await curlData(flags, cmd, env)
  // A read (no data, or -G turning data into a query) names a channel without writing to it; a chat method writes even from its query alone.
  const get = flags.some((f) => f.name === "-G" || f.name === "--get")
  const writes = (data.length > 0 && !get) || urls.some((u) => /\/api\/chat\./i.test(u.value))
  if (writes && targets.some((t) => t.label === "Slack")) {
    const read = await Promise.all([...urls, ...data].map((t) => resolveText(t, env)))
    const id = signed().find((c) => read.some((t) => t.value.includes(c)))
    if (id) {
      return `no-playground-leak hook refused curl to ${state().cleared[id].name}: post there through the Slack MCP chat tools, which check that its last line is ${state().cleared[id].signature}.`
    }
  }
  if (xargs && !xargs.replace) data.push(unknown("the arguments xargs appends"))
  return judge(
    "curl",
    target,
    data.map((t) => viaXargs(t, xargs)),
    env,
    urls,
  )
}

// Under anyWrite, whether a curl may write: a method other than GET or HEAD (or one the hook cannot read), a form or an upload, or data -G does not turn into a query.
function curlWrites(flags: Flag[]): boolean {
  const method = flags.find((f) => f.name === "-X" || f.name === "--request")?.value
  if (method && (unreadable(method) || !/^(?:GET|HEAD)$/i.test(method.value))) return true
  if (flags.some((f) => /^(?:-F|--form(?:-string)?|-T|--upload-file)$/.test(f.name))) return true
  const get = flags.some((f) => f.name === "-G" || f.name === "--get")
  return !get && flags.some((f) => /^(?:-d|--data(?:-[a-z]+)?|--json)$/.test(f.name))
}

// Under anyWrite, where a curl URL lands as curl sends it: its host and path read as a URL reads them, dot segments resolved; a glob curl would expand on a GitHub host, or a URL naming GitHub that does not parse, cannot be placed.
function curlTarget(url: string, globs: boolean): Target {
  const cannot: Target = { label: "a URL the hook cannot place", where: "unknown" }
  const other: Target = { label: "", where: "other" }
  const host = /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]*)/i.exec(url)?.[1] ?? ""
  if (globs && /[{[]/.test(host) && !/^\[[\da-f:.]+\]$/i.test(host)) return cannot
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return /github/i.test(url) ? cannot : other
  }
  const name = parsed.hostname.toLowerCase().replace(/\.$/, "")
  if (!/(?:^|\.)github\.com$/.test(name)) return other
  if (globs && /[{[]/.test(url)) return cannot
  const [first, second, third] = parsed.pathname.split("/").filter(Boolean)
  if (name === "api.github.com" || name === "uploads.github.com") {
    if (first === "graphql")
      return {
        byText: true,
        label: "a repository named only by a GraphQL node id",
        where: "unknown",
      }
    if (first === "repositories")
      return { label: "a repository named only by its id", where: "unknown" }
    return first === "repos" && second && third ? decide([{ owner: second, repo: third }]) : other
  }
  if (name !== "github.com" && name !== "www.github.com") return other
  return first && second ? decide([{ owner: first, repo: second.replace(/\.git$/i, "") }]) : other
}

// A Slack MCP post to a cleared conversation, its channel and text read at `at`: "" when it passes, why it is refused when a signed conversation's post is not signed, or undefined when it names a conversation not cleared (or, `signedOnly`, one with no signature) or another destination, to be judged as any write to a guarded org.
function clearedPost(
  what: string,
  input: Record<string, unknown>,
  at: { channel: string; text: string },
  signedOnly: boolean,
): string | undefined {
  const keys = Object.keys(input)
  if (keys.some((k) => k !== at.channel && OTHER_DESTINATION.test(k))) return
  const channel = input[at.channel]
  const text = input[at.text]
  if (typeof channel !== "string" || !Object.hasOwn(state().cleared, channel)) return
  const { name, signature } = state().cleared[channel]
  if (!signature) return signedOnly ? undefined : ""
  const signed = typeof text === "string" && text.trimEnd().split("\n").at(-1) === signature
  const rich = keys.filter((k) => RICH.includes(k))
  if (signed && rich.every((k) => k === "blocks" && chipsSigned(input.blocks, signature))) return ""
  return `no-playground-leak hook refused ${what} to ${name}: every post there ends with the line ${signature}, since it goes out through the owner's Slack account and must never read as the owner's own. Put that line last in its text, with no attachments or markdown_text; blocks pass only as rich_text sections of text and links whose last line is that signature as italic text, then run it again.`
}

const COMMIT_FIX =
  "Reword that commit's message (git commit --amend for the newest one), then run it again."
// The message of each commit a git log range reads, one text per commit named by its short sha, or the one unknown when the read fails; a piece that opens with no sha is a message's own 0x1e and its text, kept on the commit before it.
function commitTexts(dir: string | undefined, range: string[], what: string, after = ""): Placed[] {
  const log = gitText(dir, ["log", "--format=%h%x00%B%x1e", "-n", "500", ...range], what)
  if (log.unknown) return [log]
  const texts: Placed[] = []
  for (const entry of log.value.split("\x1e")) {
    const sha = /^\n?([\da-f]{4,64})\0/.exec(entry)
    const last = texts.at(-1)
    if (sha) {
      const name = `the message of commit ${sha[1]}${after}`
      texts.push(withPlace({ value: entry.slice(sha[0].length) }, name, COMMIT_FIX))
    } else if (last) last.value += `\x1e${entry}`
    else texts.push({ value: entry })
  }
  return texts
}

// The text of a git read in a checkout, or an unknown naming what it stood for when the read fails.
function gitText(dir: string | undefined, args: string[], what: string): Text {
  if (!dir) return unknown(`${what}, in a checkout the hook cannot resolve`)
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stderr: "ignore",
  })
  return proc.exitCode === 0 ? { value: proc.stdout.toString() } : unknown(what)
}

async function git(
  args: Word[],
  cmd: Command,
  env: Env,
  local: Map<string, Text> = new Map(),
  depth = 0,
): Promise<string | undefined> {
  let dir = env.cwd
  let k = 0
  // -c, --config-env, --git-dir or a GIT_ variable can move where a push goes, or define an alias.
  let carried = [...local.keys(), ...env.vars.keys()].some((name) => name.startsWith("GIT_"))
  let aliasSet = false
  // Each alias -c or --config-env sets, by its name in lower case as git reads it: its value when -c gives it literally, else undefined; any is set when a -c word the hook cannot read may set one.
  const aliases = new Map<string, string | undefined>()
  let anyAlias = false
  for (; k < args.length; k++) {
    const v = args[k].value
    if (v === "-C") {
      const next = args[++k]
      dir = next ? pathOf(next, { ...env, cwd: dir }) : undefined
    } else if (GIT_TAKES.has(v)) {
      if (v === "-c" || v === "--config-env" || v === "--git-dir") carried = true
      const next = args[k + 1]?.value ?? ""
      if (v !== "--git-dir" && /^alias\./i.test(next)) {
        aliasSet = true
        const eq = next.indexOf("=")
        const name = next.slice("alias.".length, eq === -1 ? undefined : eq)
        if (marked(name)) anyAlias = true
        else if (eq > 0)
          aliases.set(
            name.toLowerCase(),
            v === "-c" && !marked(next) ? next.slice(eq + 1) : undefined,
          )
      } else if (v === "-c" && marked(next)) anyAlias = true
      k++
    } else if (/^--(?:config-env|git-dir)=/.test(v)) {
      carried = true
      const alias = /^--config-env=alias\.([^=]+)=/i.exec(v)
      if (alias) {
        aliasSet = true
        if (marked(alias[1])) anyAlias = true
        else aliases.set(alias[1].toLowerCase(), undefined)
      }
    } else if (!v.startsWith("-")) break
  }
  const sub = args[k]?.value
  const rest = args.slice(k + 1)
  const here = { ...env, cwd: dir }
  // Outside anyWrite, an alias -c sets is followed when its value is literal git words, and refused when it runs a command, cannot be read or names another alias, or when the alias's name or the subcommand cannot be read.
  const maybeAlias = anyAlias || (aliasSet && !!sub && marked(sub))
  if (
    !state().policy.anyWrite &&
    sub &&
    (maybeAlias || aliases.has(sub.toLowerCase())) &&
    !builtin(sub)
  ) {
    const value = aliases.get(sub.toLowerCase())
    const words =
      value === undefined || value.trim().startsWith("!") ? undefined : splitCmdline(value)
    const head = words?.[0]?.value
    if (!words || !head || aliases.has(head.toLowerCase()) || depth > 8)
      return refuse(
        "git",
        decide([]),
        `its alias ${sub}, set with -c or --config-env, runs a command, holds a value the hook cannot read, or names another alias`,
        `Write the git command out in full in place of the alias, then run it again. ${NOT_RUN}`,
      )
    return git([...args.slice(0, k), ...words, ...rest], cmd, env, local, depth + 1)
  }
  if (state().policy.anyWrite) {
    const cannot = (detail: string) => refuse("git", decide([]), detail, PLACE_FIX)
    if (aliasSet)
      return cannot(
        "it sets a git alias with -c or --config-env, which can run a push under a name the hook does not read",
      )
    if (sub && marked(sub)) return cannot("its subcommand is a value the hook cannot read")
    if (sub && !["commit", "push", "send-pack", "subtree"].includes(sub) && !builtin(sub)) {
      if (carried)
        return cannot(
          `it runs ${sub}, which -c, --config-env, --git-dir or a GIT_ variable may define as an alias`,
        )
      if (state().changed)
        return cannot(`it runs ${sub}, which an earlier command in the call may define as an alias`)
      // In a checkout the hook cannot resolve, only the global and system configs, which git reads from /, can define the alias.
      const alias = gitText(dir ?? "/", ["config", "--get", `alias.${sub}`], `alias ${sub}`)
      if (!alias.unknown) {
        if (alias.value.trim().startsWith("!") || depth > 8)
          return cannot(`its alias ${sub} runs a command the hook does not read`)
        const words = splitCmdline(alias.value)
        if (!words) return cannot(`its alias ${sub} has an unclosed quote or a trailing backslash`)
        return git([...args.slice(0, k), ...words, ...rest], cmd, env, local, depth + 1)
      }
    }
    const subtree = sub === "subtree" && rest[0]?.value === "push"
    if (sub === "push" || sub === "send-pack" || subtree) {
      if (carried)
        return refuse(
          "git push",
          decide([]),
          "it carries -c, --config-env, --git-dir or a GIT_ variable, which can change where it pushes",
          PLACE_FIX,
        )
      return subtree
        ? push(rest.slice(1), here, [], SUBTREE_TAKES)
        : push(rest, here, [], PUSH_TAKES, sub === "push")
    }
  }
  if (sub !== "commit" && sub !== "push") return
  const checkout = dir ? remotes(dir) : []
  if (sub === "push") return push(rest, here, checkout)
  // A checkout with no remote publishes nothing; one the hook cannot find may be a guarded org's.
  if (dir && checkout.length === 0) return
  if (state().policy.anyWrite) {
    // A commit changes only the local clone, so under anyWrite it is refused only in a guarded repository's clone, and under branchPush it passes there on a branch the push rule lets through, while nothing in the call could move HEAD or where git writes first.
    const target = decide(dir ? checkout : [undefined])
    if (target.where !== "guarded") return
    const onBranch =
      state().policy.branchPush && dir && !carried && !state().movedBefore && branchHead(dir)
    return onBranch ? undefined : judge("git commit", target, [], env)
  }
  const { flags } = parseFlags(rest, COMMIT_TAKES)
  const texts: Text[] = [branch(dir)]
  const extras: Text[] = []
  for (const { name, value } of flags) {
    if (!value) continue
    if (name === "-m" || name === "--message") texts.push(value)
    else if (name === "-F" || name === "--file") {
      texts.push(
        value.value === "-" && !value.unknown
          ? await stdinOf(cmd, here)
          : await readPath(value, here),
      )
    } else if (["-C", "-c", "--reedit-message", "--reuse-message"].includes(name)) {
      texts.push(
        value.unknown || value.reads?.length
          ? unknown("the message of a commit the hook cannot name")
          : gitText(
              dir,
              ["log", "-1", "--format=%B", value.value],
              `the message of ${value.value}`,
            ),
      )
    } else extras.push(value)
  }
  return judge("git commit", decide(dir ? checkout : [undefined]), texts, env, extras)
}

// Whether git runs a word as its own command, which no alias can replace.
function builtin(sub: string): boolean {
  builtins ??= new Set(
    Bun.spawnSync(["git", "--list-cmds=builtins"], { stderr: "ignore" })
      .stdout.toString()
      .split("\n")
      .filter(Boolean),
  )
  return builtins.has(sub)
}

// git's split_cmdline: quotes group and drop, a backslash escapes outside single quotes, and an unclosed quote or a trailing backslash fails the alias.
function splitCmdline(body: string): Word[] | undefined {
  const words: Word[] = []
  let word: string | undefined
  let quote = ""
  for (let i = 0; i < body.length; i++) {
    let c = body[i]
    if (!quote && /\s/.test(c)) {
      if (word !== undefined) words.push({ quoted: false, value: word })
      word = undefined
      continue
    }
    word ??= ""
    if (!quote && (c === "'" || c === '"')) quote = c
    else if (c === quote) quote = ""
    else {
      if (c === "\\" && quote !== "'") {
        c = body[++i]
        if (c === undefined) return
      }
      word += c
    }
  }
  if (quote) return
  if (word !== undefined) words.push({ quoted: false, value: word })
  return words
}

// A URL git reaches over the network, by owner and name; undefined for a local path, a file:// URL or a remote helper's <transport>::<address>, which the hook cannot place.
function placeUrl(url: string): Repo | undefined {
  if (url.includes("::") || /^file:/i.test(url)) return
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url) || /^[^/:]+:/.test(url)) return remoteRepo(url)
}

// Under anyWrite, where a push goes as git resolves it: a configured remote's every push URL (pushurl, each url, pushInsteadOf applied), every remote's when none is named, else the literal URL, which is unknown when an insteadOf or pushInsteadOf rule's prefix matches it.
function pushTarget(remote: Word | undefined, dir: string | undefined): Target {
  if (
    state().changed ||
    !dir ||
    (remote && (remote.unknown || remote.reads?.length || marked(remote.value)))
  )
    return decide([undefined])
  const lines = (args: string[]) => {
    const text = gitText(dir, args, "a remote")
    return text.unknown ? undefined : text.value.split("\n").filter(Boolean)
  }
  const urls = (name: string) =>
    lines(["remote", "get-url", "--push", "--all", name])?.map(placeUrl)
  const rules = () => lines(["config", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]) ?? []
  // A literal URL, unknown when an insteadOf or pushInsteadOf rule's prefix matches it.
  const literal = (url: string) => {
    const rewritten = rules().some((line) => {
      const prefix = line.slice(line.indexOf(" ") + 1)
      return line.includes(" ") && prefix !== "" && url.startsWith(prefix)
    })
    return rewritten ? undefined : placeUrl(url)
  }
  if (!remote) {
    const names = lines(["remote"])
    // remote.pushDefault and the current branch's pushRemote and remote pick the push's remote, and each may hold a URL; after another git or gh command or an unnamed program earlier in the call, or in a folder other than the one the call starts in (a cd, git -C), any branch's may.
    const branch = lines(["symbolic-ref", "--short", "HEAD"])?.[0]
    const name =
      state().movedBefore || dir !== state().startCwd
        ? ".*"
        : branch?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const current = name ? `|branch\\.${name}\\.(pushremote|remote)` : ""
    const keys = lines(["config", "--get-regexp", `^(remote\\.pushdefault${current})$`])
    const picked = (keys ?? [])
      .map((line) => line.slice(line.indexOf(" ") + 1))
      .filter((value) => value !== "" && value !== "." && !names?.includes(value))
    return decide([
      ...(names ? names.flatMap((name) => urls(name) ?? [undefined]) : [undefined]),
      ...picked.map(literal),
    ])
  }
  return decide(urls(remote.value) ?? [literal(remote.value)])
}

// Under branchPush, the flags a push of branches may carry; any other (--all, --mirror, --tags, --delete, --repo, -o) leaves it refused.
const BRANCH_PUSH_FLAGS = new Set([
  "--dry-run",
  "--force",
  "--force-if-includes",
  "--force-with-lease",
  "--no-verify",
  "--quiet",
  "--set-upstream",
  "--verbose",
  "-f",
  "-n",
  "-q",
  "-u",
  "-v",
])

// Under branchPush, whether a push names its remote and writes only branches other than the default (main, master and the remote's HEAD), each refspec read as a literal: no HEAD or @ as the branch, glob, tag, other refs/ path, delete, or refspec remote.<name>.push could remap.
function branchOnly(flags: Flag[], positionals: Word[], dir: string): boolean {
  const [remote, ...specs] = positionals
  if (!remote || specs.length === 0 || flags.some((f) => !BRANCH_PUSH_FLAGS.has(f.name)))
    return false
  const defaults = new Set(["main", "master"])
  if (!/[:/]/.test(remote.value)) {
    const config = gitText(dir, ["config", "--list"], "the checkout's git config")
    if (
      config.unknown ||
      config.value.split("\n").some((line) => line.startsWith(`remote.${remote.value}.push=`))
    )
      return false
    const head = gitText(
      dir,
      ["symbolic-ref", "--short", `refs/remotes/${remote.value}/HEAD`],
      "the remote's default branch",
    )
    if (!head.unknown)
      defaults.add(
        head.value
          .trim()
          .slice(remote.value.length + 1)
          .toLowerCase(),
      )
  }
  return specs.every((spec) => {
    if (unreadable(spec) || /[*?[\\\s]/.test(spec.value)) return false
    const [source, destination, more] = spec.value.replace(/^\+/, "").split(":")
    if (more !== undefined || !source || destination === "") return false
    // With no destination, git pushes the local ref of that name, so a tag of that name pushes the tag.
    if (destination === undefined) {
      const tags = gitText(
        dir,
        ["for-each-ref", "--format=%(refname)", `refs/tags/${source}`],
        "the tags of that name",
      )
      if (tags.unknown || tags.value.trim() !== "") return false
    }
    const name = (destination ?? source).replace(/^(?:refs\/)?heads\//, "")
    return (
      name !== "" && !/^(?:refs\/|@$|head$|tag$)/i.test(name) && !defaults.has(name.toLowerCase())
    )
  })
}

// Under branchPush, whether the checkout's HEAD, read before the call runs, is a named branch the push rule lets through: not main, master or any remote's HEAD branch.
function branchHead(dir: string): boolean {
  const head = gitText(dir, ["symbolic-ref", "--short", "-q", "HEAD"], "the checkout's branch")
  const name = head.value.trim().toLowerCase()
  if (head.unknown || name === "") return false
  const remotes = gitText(dir, ["remote"], "the checkout's remotes")
  if (remotes.unknown) return false
  const defaults = new Set(["main", "master"])
  for (const remote of remotes.value.split("\n").filter(Boolean)) {
    const ref = gitText(
      dir,
      ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`],
      "the remote's default branch",
    )
    if (!ref.unknown)
      defaults.add(
        ref.value
          .trim()
          .slice(remote.length + 1)
          .toLowerCase(),
      )
  }
  return !defaults.has(name)
}

// git push publishes the names of the refs it pushes and the messages of every commit the remote it pushes to (the one it names, else git's push remote) holds no live branch of (heldBy), each one when that remote cannot be read.
async function push(
  rest: Word[],
  env: Env,
  checkout: Repo[],
  takes = PUSH_TAKES,
  plain = false,
): Promise<string | undefined> {
  const { flags, positionals } = parseFlags(rest, takes)
  if (state().policy.anyWrite) {
    const remote = positionals[0] ?? flags.findLast((f) => f.name === "--repo")?.value
    const target = pushTarget(remote, env.cwd)
    if (
      plain &&
      state().policy.branchPush &&
      target.where === "guarded" &&
      env.cwd &&
      branchOnly(flags, positionals, env.cwd)
    )
      return
    return judge("git push", target, [], env)
  }
  const names = new Set(flags.map((f) => f.name))
  const [remote, ...refspecs] = positionals
  let target: Target
  let pushTo: string | undefined
  if (!remote) {
    target = decide(env.cwd ? checkout : [undefined])
    pushTo = env.cwd && pushRemote(env.cwd)
  } else if (remote.unknown || remote.reads?.length || remote.value.includes(UNKNOWN))
    target = decide([undefined])
  else if (/[:/]/.test(remote.value)) {
    target = decide([remoteRepo(remote.value)])
    pushTo = remote.value
  } else {
    pushTo = remote.value
    const url = gitText(
      env.cwd,
      ["remote", "get-url", remote.value],
      `the URL of remote ${remote.value}`,
    )
    target = decide([url.unknown ? undefined : remoteRepo(url.value)])
  }
  if (target.where === "other") return
  const texts: Placed[] = flags.flatMap((f) =>
    f.value && (f.name === "-o" || f.name === "--push-option")
      ? [withPlace(f.value, "a push option")]
      : [],
  )
  const sources: string[] = []
  if (names.has("--all") || names.has("--branches") || names.has("--mirror")) {
    texts.push(
      withPlace(
        gitText(
          env.cwd,
          ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
          "the branches it pushes",
        ),
        "the branch names it pushes",
      ),
    )
    sources.push("--branches")
  }
  if (names.has("--tags") || names.has("--follow-tags") || names.has("--mirror")) {
    texts.push(
      withPlace(
        gitText(
          env.cwd,
          ["for-each-ref", "--format=%(refname:short)%0a%(contents)", "refs/tags"],
          "the tags it pushes",
        ),
        "the tags it pushes",
      ),
    )
  }
  const deleting = names.has("--delete") || names.has("-d")
  for (const spec of refspecs) {
    texts.push(withPlace(spec, "a ref it pushes"))
    if (spec.unknown || spec.reads?.length || spec.value.includes(UNKNOWN)) continue
    const [source, destination] = spec.value.replace(/^\+/, "").split(":")
    // `git push origin HEAD` names the remote branch after the current one.
    if (destination === undefined && (source === "HEAD" || source === "@"))
      texts.push(withPlace(branch(env.cwd), "the branch name it pushes"))
    if (source !== "" && !deleting) sources.push(source)
  }
  if (refspecs.length === 0 && sources.length === 0) {
    texts.push(withPlace(branch(env.cwd), "the branch name it pushes"))
    sources.push("HEAD")
  }
  if (sources.length > 0) {
    const held = env.cwd && pushTo ? heldBy(env.cwd, pushTo) : []
    texts.push(
      ...commitTexts(
        env.cwd,
        [...sources, "--not", ...held],
        "the messages of the commits it pushes",
      ),
    )
  }
  return judge("git push", target, texts, env)
}

// The gates' verdict on a Slack MCP tool: why it is refused, or undefined when it reads, when no gate covers its server, or when it is a posting tool whose one destination is the gate's self-DM, which the rest of the check then judges; a declaration that does not read refuses every Slack write, since the hook cannot tell which servers it covers.
// Two Slack reads READ_TOOL's shape misses, which a gate lets through while the rest of the hook still judges their input's terms.
const GATED_READS = new Set(["usergroups_me", "users_conversations"])
function gatedPost(
  tool: string,
  server: string,
  name: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const read = name.replace(/^slack_/, "")
  if (READ_TOOL.test(read) || GATED_READS.has(read)) return
  const connector = name === CONNECTOR_TOOL
  const posting = CHAT_TOOL.test(name) || connector
  const what = tool.replace(/^mcp__/, "")
  for (const gate of state().policy.gates ?? []) {
    if ("broken" in gate) {
      if (/slack/i.test(server)) return brokenGate(what, gate)
      continue
    }
    if (!gate.servers.includes(server)) continue
    const keys = connector ? CONNECTOR_KEYS : POST_KEYS
    const alone =
      posting &&
      input !== undefined &&
      input[keys.channel] === gate.selfDm &&
      !Object.keys(input).some((k) => k !== keys.channel && OTHER_DESTINATION.test(k))
    if (!alone)
      return `no-playground-leak hook refused ${what}: the ${gate.org} extension gates its Slack sends on ${server}, so every write there goes through ${gate.path}; only a post whose one destination is its self-DM (${gate.selfDm}) passes here. Send it through that path.`
  }
}

const brokenGate = (what: string, gate: { broken: string; org: string }): string =>
  `no-playground-leak hook refused ${what}: the ${gate.org} extension's slack.gatedSends does not read (${gate.broken}), so the hook cannot tell which Slack writes its gate covers. Tell your lead: it is set in that extension's settings as {"path": "<its send path>", "selfDm": "D…", "servers": ["<MCP server>"]}, or "" for no gate; then run the call again.`

// While any org gates its Slack sends, a curl to any Slack URL is refused, since the hook cannot tell which workspace its token posts to: only /api/<a read method> (conversations.history, users.info, search.messages) and /api/auth.test pass.
const SLACK_READ_METHOD =
  /^(?:auth\.test|search\.[a-z]+|(?:[a-z]+\.)+(?:history|info|list|replies|unreads|get[A-Za-z]*|lookup[A-Za-z]*))$/
function gatedCurl(urls: Word[]): string | undefined {
  const gates = state().policy.gates ?? []
  if (!gates.length) return
  const writes = urls.some((u) => {
    const value = visible(u.value)
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
    if (!slackHost(hostOf(url))) return false
    const method = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*\/api\/([^/?#]+)(?:[?#]|$)/i.exec(url)?.[1]
    return !method || !SLACK_READ_METHOD.test(method)
  })
  if (!writes) return
  const broken = gates.find((g) => "broken" in g)
  if (broken && "broken" in broken) return brokenGate("curl", broken)
  const paths = gates.flatMap((g) => ("path" in g ? [`${g.org}'s ${g.path}`] : []))
  return `no-playground-leak hook refused curl to Slack's API: an org gates its Slack sends (slack.gatedSends), so a Slack write goes through ${paths.join(" or ")}, and curl passes only a read method on /api/. Send it through that path.`
}

function strings(node: unknown): string[] {
  if (typeof node === "string") return [node]
  if (Array.isArray(node)) return node.flatMap(strings)
  if (typeof node === "object" && node !== null) return Object.values(node).flatMap(strings)
  return []
}

function mcp(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  const [, server = "", name = ""] = MCP_TOOL.exec(tool) ?? []
  const gated = gatedPost(tool, server, name, input)
  if (gated) return gated
  const surface = /linear/i.test(server)
    ? "Linear"
    : /slack/i.test(server)
      ? "Slack"
      : /github/i.test(server)
        ? "GitHub"
        : undefined
  if (!surface || READ_TOOL.test(name) || (surface !== "GitHub" && !state().policy.hosts)) return
  const what = tool.replace(/^mcp__/, "")
  let target: Target = { label: surface, where: "guarded" }
  if (!input)
    return refuse(what, target, "its input is not an object the hook can read", MCP_READABLE)
  if (surface === "Slack" && (CHAT_TOOL.test(name) || name === CONNECTOR_TOOL)) {
    const connector = name === CONNECTOR_TOOL
    const verdict = clearedPost(what, input, connector ? CONNECTOR_KEYS : POST_KEYS, connector)
    if (verdict !== undefined) return verdict || undefined
  }
  if (surface === "GitHub" && state().policy.anyWrite && name === "create_repository") {
    const owner = input.organization ?? "*"
    const named = input.name
    return destination(
      what,
      typeof owner === "string" ? owner : undefined,
      typeof named === "string" ? named : undefined,
      "",
    )
  }
  if (surface === "GitHub") {
    const owner = input.owner ?? input.organization
    if (owner === undefined) return
    if (typeof owner !== "string") {
      return refuse(
        what,
        { label: "GitHub", where: "unknown" },
        "its owner is not text the hook can read",
        MCP_READABLE,
      )
    }
    const repo = { owner, repo: typeof input.repo === "string" ? input.repo : "*" }
    if (!state().policy.guarded(repo)) return
    target = { label: `${repo.owner}/${repo.repo}`, where: "guarded" }
    if (state().policy.anyWrite)
      return CONVERSATION_TOOL.test(name) ? undefined : refuseAny(what, target, "")
  }
  const hit = strings(input).map(state().policy.find).find(Boolean)
  if (hit) return refuse(what, target, `its text holds ${hit.detail}`, hit.fix)
}

// The cheap first look, made with quotes and backslashes gone so `g\it` or `cu''rl` still counts.
function candidate(command: string): boolean {
  const maybe = state().policy.anyWrite ? MAYBE_ANY : MAYBE
  return command.includes("$'") || maybe.test(command.replace(/[\\'"]/g, ""))
}

// The factory-term pattern the hook reads a write with, for a check outside it (the public-draft check, public-draft.ts): the terms list read as the hook reads it, with the roster and the skills as they stand, or the list's refusal.
export async function factoryTerms(
  environment: Environment = process.env,
  checkout = CHECKOUT,
  lists = join(coreDir(), "lists"),
): Promise<{ pattern: RegExp; refusal?: undefined } | { pattern?: undefined; refusal: string }> {
  const loaded = await guardList(
    "no-playground-leak",
    "playground-terms",
    isTerms,
    EMPTY_TERMS,
    environment,
    join(lists, "playground-terms.json"),
  )
  if (loaded.refusal !== undefined) return { refusal: loaded.refusal }
  terms = loaded.list
  return { pattern: pattern(environment, checkout) }
}

// Fails closed only on a call that may carry a factory term to a guarded org (leakPolicy, over the orgs the data folder's policy names, or a policy it cannot read): an error on any other call lets it run, so a parser bug cannot block every call.
export async function check(
  raw: string,
  environment: Environment = process.env,
  checkout = CHECKOUT,
  lists = join(coreDir(), "lists"),
): Promise<string | undefined> {
  const loadedTerms = await factoryTerms(environment, checkout, lists)
  if (loadedTerms.refusal !== undefined) return refusedList(raw, loadedTerms.refusal)
  const loadedCleared = await guardList(
    "no-playground-leak",
    "slack-cleared",
    isCleared,
    {},
    environment,
    join(lists, "slack-cleared.json"),
  )
  if (loadedCleared.refusal !== undefined) return refusedList(raw, loadedCleared.refusal)
  const read = await readPolicy(dataDir(environment))
  if (read.refusal !== undefined)
    return refusedList(
      raw,
      `no-playground-leak hook refused this call: ${read.refusal}, then run the call again.`,
    )
  const orgs = guardedOrgs(read.settings.values)
  const gates = orgs.flatMap((org) =>
    gateOf(org, readPolicySync(dataDir(environment), org).settings?.values ?? {}),
  )
  return inspectAs(
    { ...leakPolicy(new Set(orgs), loadedTerms.pattern), gates },
    raw,
    environment,
    loadedCleared.list,
  )
}

// An org's declared gate, none when it declares none, or why its declaration does not read.
function gateOf(org: string, values: Record<string, unknown>): Gate[] {
  const value = values["slack.gatedSends"]
  if (value === undefined || value === "") return []
  const parsed = gatedSendsSchema.safeParse(value)
  return [
    parsed.success
      ? { org, ...parsed.data }
      : {
          broken: parsed.error.issues
            .map((i) => `${i.path.join(".") || "its value"}: ${i.message}`)
            .join("; "),
          org,
        },
  ]
}

// A list's refusal, given only to a call that may write somewhere: one that names a writing command or tool and does more than read (read-only.ts).
export const refusedList = (raw: string, refusal: string): string | undefined =>
  WRITE_CALL.test(subjectOf(raw)) && !readOnly(raw) ? refusal : undefined

// Reads the call as a write under the policy given: an error refuses only a writing call whose text holds a hit.
export async function inspectAs(
  given: Policy,
  raw: string,
  environment: Environment,
  cleared: Cleared = {},
): Promise<string | undefined> {
  const call: Call = { changed: false, cleared, moved: false, movedBefore: false, policy: given }
  return await withLiveBudget(() =>
    calls.run(call, async () => {
      try {
        return await inspect(raw, environment)
      } catch (error) {
        const subject = subjectOf(raw)
        // Under anyWrite a call that may write is refused whatever it names, since an error it caused may hide where it writes.
        const writes = WRITE_CALL.test(subject) || (given.anyWrite && candidate(subject))
        if (!writes || (!given.anyWrite && !given.find(subject))) return
        if (given.anyWrite)
          return `${given.guard} hook refused this call: it could not read it (${error}), so it cannot tell whether it is ${given.what}. Split it into plain commands and run them again.`
        return `${given.guard} hook could not read this call (${error}), which may carry ${given.what} to ${given.place}, so it refuses it. Split it into plain commands and run them again.`
      }
    }),
  )
}

// What an error is judged by: the Bash command, or the tool's name and input, never its cwd.
function subjectOf(raw: string): string {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
      tool_input?: { command?: unknown }
      tool_name?: unknown
    }
    if (tool === "Bash" && typeof toolInput?.command === "string") return toolInput.command
    return `${String(tool)} ${JSON.stringify(toolInput)}`
  } catch {
    return raw
  }
}

async function inspect(raw: string, environment: Environment): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (typeof payload !== "object" || payload === null) {
    return WRITE_CALL.test(raw) && state().policy.find(raw)
      ? `${state().policy.guard} hook could not parse its input, which may carry ${state().policy.what} to ${state().policy.place}, so it refuses the call.`
      : undefined
  }
  const { cwd, tool_input: toolInput, tool_name: tool } = payload as Record<string, unknown>
  state().startCwd = typeof cwd === "string" ? cwd : undefined
  const input =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : undefined
  if (tool === "Bash") {
    const command = input?.command
    if (typeof command !== "string" || !candidate(command)) return
    const directory = typeof cwd === "string" ? cwd : undefined
    const own = knownVariables(command, environment, directory)
    const env: Env = {
      cwd: directory,
      files: new Map(),
      // a variable of the session's starting environment is read as its value, so `git -C "$PLAYGROUND_REPO" push` is placed by the clone it names
      known: { ...own, ...startingVariables(command, environment, own) },
      process: environment,
      vars: new Map(),
    }
    return run(lex(command, env.known), env, leak)
  }
  if (typeof tool === "string") return mcp(tool, input)
}

if (import.meta.main) {
  const raw = await input("no-playground-leak", "guard")
  // a prepare-only session's tracker, chat and pull request writes wait for its claim (no-prepare-write), and a GitHub tool's write to main or canary of the factory's repository is refused (no-protected-push), checked here since this hook's matcher takes those MCP tools
  const reason = (await fromFactory(raw))
    ? ((await prepareWrite(raw)) ?? (await protectedPush(raw)) ?? (await check(raw)))
    : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
