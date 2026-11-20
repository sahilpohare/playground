// A check for the factory's sessions, run on Bash by guards.ts and on the GitHub tools by no-playground-leak's process, so it has no main block of its own: refuses a git push, a hand-run gh pr merge (the Builder's one form aside), a gh api or GitHub tool write, and a GraphQL merge or ref move (on any repository) that writes main or canary of the factory's repository (factory.repo, else the main checkout's origin), since canary takes a pull request only through pr:merge or merge-on-ready and main moves only through the ship step's ship:merge, both of which merge through GitHub and run no git push of their own. A push it cannot read (a ref, a remote or a folder built at run time, an option it does not know, a branch an earlier command in the call may switch) is refused when it may land there; any other push passes.
import "../../packages/env/src/aliases"
import { dataDir } from "../../packages/env/src/data-dir"
import { factoryRepo } from "../../packages/scripts/src/playground/setting"
import { readPolicyOrDefaults } from "../../packages/settings/src/rendered"
import { implicitRepos, remoteRepo, type Repo, repoOf } from "./github"
import { REF_MOVE } from "./no-prepare-write"
import { gitCommand } from "./no-stash"
import { builderLead, namesRole } from "./role"
import {
  type ApiRequest,
  type Command,
  type Env,
  ghApi,
  ghCommand,
  GIT_TAKES,
  knownVariables,
  lex,
  marked,
  type Parsed,
  parseFlags,
  pathOf,
  places,
  PRINTERS,
  program,
  run,
  type Text,
  unreadable,
  type Visit,
  type Word,
} from "./shell"

type Environment = Record<string, string | undefined>

const PROTECTED = new Set(["canary", "main"])
const PUSH_TAKES = new Set([
  "--exec",
  "-o",
  "--push-option",
  "--receive-pack",
  "--recurse-submodules",
  "--repo",
])
// The options a push may carry that change no ref it writes; --tags and --delete are read on their own, and any other (--all, --mirror, --prune, an abbreviation) leaves what it writes unread.
const PLAIN = new Set([
  "--atomic",
  "--dry-run",
  "--exec",
  "--follow-tags",
  "--force",
  "--force-if-includes",
  "--force-with-lease",
  "--ipv4",
  "--ipv6",
  "--no-atomic",
  "--no-follow-tags",
  "--no-force-if-includes",
  "--no-force-with-lease",
  "--no-progress",
  "--no-signed",
  "--no-thin",
  "--no-verify",
  "--porcelain",
  "--progress",
  "--push-option",
  "--quiet",
  "--receive-pack",
  "--recurse-submodules",
  "--repo",
  "--set-upstream",
  "--signed",
  "--thin",
  "--verbose",
  "--verify",
  "-4",
  "-6",
  "-f",
  "-n",
  "-o",
  "-q",
  "-u",
  "-v",
])
// Commands an earlier part of the call may run that never switch the branch a push names by HEAD.
const KEEPS_HEAD = new Set(["cat", "date", "echo", "printf", "pwd", "true"])
const GIT_KEEPS_HEAD = new Set([
  "add",
  "commit",
  "diff",
  "fetch",
  "log",
  "ls-remote",
  "push",
  "rev-parse",
  "show",
  "status",
])

const ROUTE =
  "canary takes a pull request only through bun run pr:merge <n> or merge-on-ready, and main moves only through the release skill's ship:merge."
const FIX =
  "Push your work branch as a call of its own, a bare git push from it or git push origin HEAD:<branch>, then land it through its pull request."

const git = (dir: string, args: string[]): string | undefined => {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stderr: "ignore",
  })
  return out.exitCode === 0 ? out.stdout.toString() : undefined
}
const lines = (text: string | undefined) => (text ?? "").split("\n").filter(Boolean)

let builtins: Set<string> | undefined
const builtin = (sub: string): boolean =>
  (builtins ??= new Set(
    lines(Bun.spawnSync(["git", "--list-cmds=builtins"], { stderr: "ignore" }).stdout.toString()),
  )).has(sub)

// A branch a refspec's destination names, lowercase: a name under refs/heads/ or bare, undefined for any other ref.
function branchOf(name: string): string | undefined {
  const bare = name.replace(/^(?:refs\/)?heads\//, "")
  return bare.startsWith("refs/") ? undefined : bare.toLowerCase()
}

type Writes = { names: string[]; unread?: string }

// The branches a push writes, or why it cannot read them; dir is the folder git runs in, undefined when the hook cannot place it.
function writes(rest: Word[], dir: string | undefined, settled: boolean): Writes {
  const { flags, positionals } = parseFlags(rest, PUSH_TAKES)
  const odd = flags.find(
    (f) => !PLAIN.has(f.name) && !["--tags", "--delete", "-d"].includes(f.name),
  )
  if (odd)
    return {
      names: [],
      unread: `it carries ${odd.name}, which may push more branches than it names`,
    }
  const [, ...specs] = positionals
  // The checked-out branch, read before the call runs.
  const head = (): Writes & { branch?: string } => {
    if (!dir || !settled)
      return {
        names: [],
        unread: "it pushes the checked-out branch, which this call may switch before the push runs",
      }
    const branch = lines(git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]))[0]
    return { branch, names: branch ? [branch.toLowerCase()] : [] }
  }
  if (specs.length === 0) {
    if (flags.some((f) => f.name === "--tags")) return { names: [] }
    const base = head()
    if (base.unread || !dir) return base
    const config = lines(git(dir, ["config", "--list"]))
    if (config.some((l) => /^remote\..*\.push=/.test(l)))
      return {
        names: [],
        unread: "a push refspec in the checkout's config picks the branches it writes",
      }
    if (config.findLast((l) => l.startsWith("push.default=")) === "push.default=matching")
      return {
        names: [],
        unread: "push.default is matching, which pushes every branch the remote holds",
      }
    // push.default upstream writes the branch it tracks, whatever its name.
    const upstream =
      base.branch && config.findLast((l) => l.startsWith(`branch.${base.branch}.merge=`))
    const tracked = upstream ? branchOf(upstream.slice(upstream.indexOf("=") + 1)) : undefined
    return { names: tracked ? [...base.names, tracked] : base.names }
  }
  const names: string[] = []
  for (const spec of specs) {
    if (unreadable(spec)) return { names: [], unread: "it names a ref built at run time" }
    const text = spec.value.replace(/^\+/, "")
    if (/[*?[\\\s]/.test(text) || text === ":" || text === "")
      return { names: [], unread: `its refspec ${spec.value} may match many branches` }
    const parts = text.split(":")
    if (parts.length > 2) return { names: [], unread: `its refspec ${spec.value} does not read` }
    const destination = parts.length === 2 ? parts[1] : parts[0]
    if (/^(?:@|head)$/i.test(destination)) {
      if (parts.length === 2)
        return { names: [], unread: `its refspec ${spec.value} writes the remote's HEAD` }
      const current = head()
      if (current.unread) return current
      names.push(...current.names)
      continue
    }
    const branch = branchOf(destination)
    if (branch !== undefined) names.push(branch)
  }
  return { names }
}

// Where a push lands: the factory's repository, another, or a place the hook cannot read (then why).
function lands(
  remote: Word | undefined,
  dir: string | undefined,
  factory: string,
  carried: boolean,
): true | false | string {
  if (!factory)
    return "the factory's repository does not read (factory.repo is unset and the checkout has no GitHub origin)"
  if (carried)
    return "it carries -c, --config-env, --git-dir, --work-tree or a GIT_ variable, which can change where it pushes"
  if (remote && unreadable(remote)) return "its remote is built at run time"
  const named = (url: string) => {
    const repo = remoteRepo(url)
    return !!repo && `${repo.owner}/${repo.repo}`.toLowerCase() === factory
  }
  if (!dir)
    return remote && /[:/]/.test(remote.value) && !remote.value.startsWith(".")
      ? named(remote.value)
      : "the folder it runs in does not read"
  const listed = lines(git(dir, ["remote", "-v"])).filter((l) => l.endsWith(" (push)"))
  const configured = new Set(listed.map((l) => l.split("\t")[0]))
  // With no remote named, git may pick any remote of the checkout (pushRemote, pushDefault, the branch's remote).
  if (!remote || configured.has(remote.value))
    return listed.some(
      (l) =>
        (!remote || l.startsWith(`${remote.value}\t`)) &&
        named(l.slice(l.indexOf("\t") + 1, -" (push)".length)),
    )
  const rules = lines(git(dir, ["config", "--get-regexp", "^url\\..*\\.pushinsteadof$"]))
  if (rules.some((l) => remote.value.startsWith(l.slice(l.indexOf(" ") + 1))))
    return "a pushInsteadOf rule in the checkout's config rewrites its remote"
  return named(lines(git(dir, ["ls-remote", "--get-url", remote.value]))[0] ?? remote.value)
}

// git's own options before its subcommand: the folder -C moves it to, and whether one changes the config, the repository or the work tree it reads.
function globals(args: Word[], env: Env): { carried: boolean; dir: string | undefined } {
  let dir = env.cwd
  let carried = false
  for (let k = 0; k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value
    if (v === "-C")
      dir = dir === undefined ? undefined : pathOf(args[++k] ?? { value: "" }, { ...env, cwd: dir })
    else if (
      /^(?:-c|--config-env|--git-dir|--work-tree|--namespace)(?:=|$)/.test(v) ||
      /^-c./.test(v)
    ) {
      carried = true
      if (GIT_TAKES.has(v)) k++
    } else if (GIT_TAKES.has(v)) k++
  }
  return { carried, dir }
}

// The variables that change the repository, the work tree or the config git reads.
const gitVariable = (key: string) =>
  /^GIT_(?:COMMON_DIR|CONFIG(?:_\w+)?|DIR|NAMESPACE|WORK_TREE)$/.test(key)

// Whether the session's own environment holds the closed sandbox's git env config alone (scripts/spawn.sh): a count, each key below it commit.gpgsign and each value false, and no other git variable, a set that moves no push; a near miss, or the set typed on the line, stays a variable the hook cannot read.
function signingOff(environment: Record<string, string | undefined>): boolean {
  const count = environment.GIT_CONFIG_COUNT
  if (count === undefined || !/^[1-9]\d*$/.test(count)) return false
  const expected = new Set(["GIT_CONFIG_COUNT"])
  for (let n = 0; n < Number(count); n++) {
    const key = `GIT_CONFIG_KEY_${n}`
    const value = `GIT_CONFIG_VALUE_${n}`
    if (environment[key] !== "commit.gpgsign" || environment[value] !== "false") return false
    expected.add(key).add(value)
  }
  return Object.keys(environment)
    .filter(gitVariable)
    .every((name) => expected.has(name))
}

// Whether a subcommand other than push may push: false for one of git's own, or an alias whose text names no push; true for an alias that names one, or one the hook cannot read.
function aliasOf(sub: string, args: Word[], dir: string | undefined): boolean {
  if (builtin(sub)) return false
  const inline = gitCommand(args).aliases.findLast((a) => a.startsWith(`alias.${sub}=`))
  const body =
    inline === undefined
      ? dir && git(dir, ["config", "--get", `alias.${sub}`])
      : inline.slice(inline.indexOf("=") + 1)
  if (body === undefined) return dir === undefined
  return /push/i.test(body)
}

// One git call in one folder: the refusal, when it may write main or canary of the factory's repository.
function judge(
  args: Word[],
  parsed: Parsed,
  env: Env,
  factory: string,
  settled: boolean,
): string | undefined {
  const { sub, rest } = gitCommand(args)
  if (!sub) return
  const { carried: optioned, dir } = globals(args, env)
  const carried =
    optioned ||
    [...parsed.local.keys(), ...env.vars.keys()].some(gitVariable) ||
    (!signingOff(env.process) && Object.keys(env.process).some(gitVariable))
  if (sub.value !== "push") {
    // send-pack and subtree push write the refs they name by their own rules, which the hook does not read
    const other =
      sub.value === "send-pack" || (sub.value === "subtree" && rest[0]?.value === "push")
    const alias = other || marked(sub.value) ? undefined : aliasOf(sub.value, args, dir)
    if (alias === false) return
    const where = lands(undefined, dir, factory, carried)
    if (where === false) return
    return refuse(
      other
        ? `it runs git ${sub.value}, a push the hook does not read`
        : alias
          ? `it runs git ${sub.value}, an alias that may push`
          : "it runs a git command the hook cannot read",
      where,
    )
  }
  const { positionals, flags } = parseFlags(rest, PUSH_TAKES)
  const remote = positionals[0] ?? flags.findLast((f) => f.name === "--repo")?.value
  const written: Writes = parsed.xargs
    ? { names: [], unread: "xargs adds refs it reads at run time" }
    : writes(rest, carried ? undefined : dir, settled && !carried)
  const hit = written.names.find((n) => PROTECTED.has(n))
  if (!written.unread && !hit) return
  const where = lands(remote, dir, factory, carried)
  if (where === false) return
  if (hit && where === true)
    return `no-protected-push hook refuses this git push: it writes ${hit} of ${factory}. ${ROUTE} ${FIX}`
  return refuse(written.unread ?? `it writes ${hit}`, where)
}

const refuse = (what: string, where: true | string) =>
  `no-protected-push hook refuses this git push: ${what}, ${where === true ? "in the factory's repository" : `and ${where}`}, so it may write main or canary there. ${ROUTE} ${FIX}`

const MCP_TOOL = /^mcp__(.+?)__(.+)$/
// The GitHub tools that write a file onto the branch they name, the repository's default branch (canary) when they name none.
const FILE_TOOLS = new Set(["create_or_update_file", "delete_file", "push_files"])
// The options of gh pr merge that take a value, attached or as the next word.
const MERGE_TAKES = new Set([
  "-A",
  "--author-email",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "--match-head-commit",
  "-R",
  "--repo",
  "-t",
  "--subject",
])
const MERGE_FIX = "Land it with bun run pr:merge <n>, or let merge-on-ready land it."
const BUILDER_FORM =
  "The Builder alone merges by hand, as gh pr merge <n> --squash --body-file <file> --match-head-commit <head> in a call that names no role variable and sources no file, the body passed by file since its text counts as the call's."
// The words a refusal of a call the hook cannot read gives: the form that runs, which a thread reply, a resolve or a read takes.
const UNREAD_FIX =
  "Spell the query file's path or the endpoint out literally, with no shell variable or substitution, or put the query inline in single quotes, and a read, a thread reply or a resolve runs."

const named = (repo: Repo | undefined, factory: string): boolean =>
  !!repo && `${repo.owner}/${repo.repo}`.toLowerCase() === factory
// Whether any repository a call may act on is the factory's, or one it cannot place (undefined), or the factory's repository does not read.
const mayBe = (repos: (Repo | undefined)[], factory: string): boolean =>
  !factory || repos.some((repo) => repo === undefined || named(repo, factory))
const GH_DEFAULT = (env: Env, local: Map<string, Text>): (Repo | undefined)[] =>
  env.cwd || local.has("GH_REPO") || env.vars.has("GH_REPO") || env.process.GH_REPO
    ? implicitRepos(env, local)
    : [undefined]

// A GitHub tool's write onto main or canary of the factory's repository, or any pull request merge there.
function judgeTool(tool: string, input: Record<string, unknown>, factory: string) {
  const [, server, name] = MCP_TOOL.exec(tool) ?? []
  if (!server || !name || !/github/i.test(server)) return
  if (name !== "merge_pull_request" && !FILE_TOOLS.has(name)) return
  const { branch, owner, repo } = input
  const repos = [
    typeof owner === "string" && typeof repo === "string" ? { owner, repo } : undefined,
  ]
  if (!mayBe(repos, factory)) return
  const place = factory || "the factory's repository"
  if (name === "merge_pull_request")
    return `no-protected-push hook refuses ${tool}: it merges a pull request of ${place}, whose base is main or canary. ${ROUTE} ${MERGE_FIX}`
  if (typeof branch === "string" && branch !== "") {
    const target = branchOf(branch)
    if (target === undefined || !PROTECTED.has(target)) return
  }
  const what = typeof branch === "string" && branch !== "" ? branch : "the default branch, canary"
  return `no-protected-push hook refuses ${tool}: it writes ${what} of ${place}. ${ROUTE} ${FIX}`
}

// A gh pr merge on the factory's repository, which only the Builder runs by hand, in the one form pr:merge's README names.
async function judgeMerge(
  rest: Word[],
  repos: Word[],
  parsed: Parsed,
  env: Env,
  factory: string,
  builder: () => Promise<boolean>,
  command: string,
): Promise<string | undefined> {
  const { flags, positionals } = parseFlags(rest, MERGE_TAKES)
  if (flags.some((f) => f.name === "--help" || f.name === "-h")) return
  const given = [
    ...repos,
    ...flags
      .filter((f) => (f.name === "-R" || f.name === "--repo") && f.value)
      .map((f) => f.value!),
  ]
  const [target] = positionals
  const url =
    target && !unreadable(target)
      ? /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\//i.exec(target.value)
      : null
  const candidates: (Repo | undefined)[] = url
    ? [{ owner: url[1]!, repo: url[2]! }]
    : given.length > 0
      ? [repoOf(given.at(-1)!)]
      : GH_DEFAULT(env, parsed.local)
  if (target && unreadable(target)) candidates.push(undefined)
  if (!mayBe(candidates, factory)) return
  const head = flags.findLast((f) => f.name === "--match-head-commit")?.value
  const squash = flags.some((f) => f.name === "--squash" || f.name === "-s")
  const pinned = !!head && !unreadable(head) && /^[0-9a-f]{7,40}$/i.test(head.value)
  if (squash && pinned && !namesRole(command) && (await builder())) return
  return `no-protected-push hook refuses this gh pr merge: it merges a pull request of ${factory || "the factory's repository"}, whose base is main or canary. ${ROUTE} ${MERGE_FIX} ${BUILDER_FORM}`
}

// A field a gh api call sends, from its -f/-F fields, else its --input's JSON; unknown when the input does not read, undefined when it sends none.
function fieldOf(request: ApiRequest, key: string): Text | undefined {
  const field = request.fields.findLast((f) => f.key === key)
  if (field) return field.text
  for (const input of request.inputs) {
    if (unreadable(input)) return { unknown: "an --input the hook cannot read", value: "" }
    try {
      const value = (JSON.parse(input.value) as Record<string, unknown>)[key]
      if (typeof value === "string") return { value }
      if (value !== undefined) return { unknown: `a ${key} that is no string`, value: "" }
    } catch {
      return { unknown: "an --input that is no JSON object", value: "" }
    }
  }
}

// What a REST write does to main or canary of a repository, or undefined when it moves neither.
function restWrite(tail: string, request: ApiRequest): string | undefined {
  if (/^pulls\/[^/]+\/merge$/.test(tail))
    return "it merges a pull request, whose base is main or canary"
  const protectedBy = (key: string, absent?: string) => {
    const text = fieldOf(request, key)
    if (!text) return absent
    if (unreadable(text)) return `its ${key} is built at run time`
    const target = branchOf(text.value)
    return target !== undefined && PROTECTED.has(target) ? `it writes ${target}` : undefined
  }
  if (tail === "git/refs") return protectedBy("ref")
  const ref = /^git\/refs\/(.+)$/.exec(tail)?.[1]
  if (ref !== undefined) {
    const target = branchOf(ref)
    return target !== undefined && PROTECTED.has(target) ? `it writes ${target}` : undefined
  }
  if (/^contents\/./.test(tail))
    return protectedBy("branch", "it names no branch, so it writes the default branch, canary")
  if (tail === "merges") return protectedBy("base")
}

// A gh api write that moves main or canary of the factory's repository, or a GraphQL mutation that merges or moves a ref anywhere, since a node id names no repository.
async function judgeApi(
  rest: Word[],
  cmd: Command,
  parsed: Parsed,
  env: Env,
  factory: string,
): Promise<string | undefined> {
  const request = await ghApi(rest, cmd, env, parsed.xargs)
  if (!request) return
  const { endpoint, method } = request
  const path = decodeURIComponent(
    endpoint.value
      .replace(/^https?:\/\/[^/]+/i, "")
      .replace(/^\/+/, "")
      .replace(/^api\/v3\//, "")
      .split("?")[0]!,
  ).replace(/\/+$/, "")
  if (path === "graphql" || path === "api/graphql") {
    // the query field, xargs' appended words, and an --input's JSON, each of which may carry the mutation
    const texts = [
      ...request.fields.filter((f) => f.key === "query" || f.key === "body").map((f) => f.text),
      ...request.inputs,
    ]
    const blind = texts.some(unreadable)
    const mutation = texts.map((t) => REF_MOVE.exec(t.value)?.[0]).find(Boolean)
    if (mutation)
      return `no-protected-push hook refuses this gh api graphql call: it runs ${mutation}, which merges a pull request or moves a branch, and a node id names no repository, so the hook cannot tell it from a write to main or canary. Merge through gh pr merge's own route, bun run pr:merge <n>, and move a branch with git push.`
    if (!blind) return
    return `no-protected-push hook refuses this gh api graphql call: it sends a query the hook cannot read, which may merge a pull request or move a branch. ${UNREAD_FIX}`
  }
  if (method === "GET" || method === "HEAD") return
  const place = factory || "the factory's repository"
  if (unreadable(endpoint))
    return `no-protected-push hook refuses this gh api ${method} call: its endpoint is built at run time, so it may write main or canary of ${place}. ${UNREAD_FIX}`
  const m = /^repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path)
  if (!m) return
  const repos =
    m[1] === "{owner}" || m[2] === "{repo}"
      ? GH_DEFAULT(env, parsed.local)
      : [{ owner: m[1]!, repo: m[2]! }]
  if (!mayBe(repos, factory)) return
  const what = restWrite(m[3]!, request)
  if (!what) return
  const fix = /^pulls\/[^/]+\/merge$/.test(m[3]!) ? MERGE_FIX : FIX
  return `no-protected-push hook refuses this gh api ${method} call: ${what} of ${place}. ${ROUTE} ${fix}`
}

const isPush = (args: Word[]) => gitCommand(args).sub?.value === "push"

async function inspect(
  raw: string,
  environment: Environment,
  checkout?: string,
): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof payload !== "object" || payload === null) return
  const { cwd, tool_input: input, tool_name: tool } = payload as Record<string, unknown>
  const factoryOf = () => {
    const read = readPolicyOrDefaults(dataDir(environment))
    return read.refusal === undefined ? factoryRepo(read.settings, checkout) : ""
  }
  if (typeof tool === "string" && MCP_TOOL.test(tool))
    return judgeTool(tool, (input ?? {}) as Record<string, unknown>, factoryOf())
  if (tool !== "Bash") return
  const command = (input as { command?: unknown } | null)?.command
  if (typeof command !== "string" || !/git|push|\bgh\b|\$|`/i.test(command.replace(/[\\'"]/g, "")))
    return
  const factory = factoryOf()
  const builder = () => builderLead(raw, environment)
  const directory = typeof cwd === "string" ? cwd : undefined
  const env: Env = {
    cwd: directory,
    // the line starts in the folder the tool names
    cwdSure: directory,
    files: new Map(),
    known: knownVariables(command, environment, directory),
    process: environment,
    vars: new Map(),
  }
  // Whether every command before this one leaves the checked-out branch as it was.
  let settled = true
  const visit: Visit = async (cmd, parsed, at) => {
    const { args, first, name } = parsed
    let ghArgs: Word[] | undefined
    if (name === "gh") ghArgs = args
    else if (!PRINTERS.has(name)) {
      // gh behind a wrapper the reader does not know
      const nested = args.findIndex((a) => program(a.value) === "gh")
      if (nested !== -1) ghArgs = args.slice(nested + 1)
    }
    if (ghArgs) {
      const { head, repos, rest } = ghCommand(ghArgs)
      const folders = places(at)
      if (at.cwdUnread || at.cwdAnywhere)
        folders.push({ ...at, cwd: undefined, cwdSure: undefined })
      for (const place of folders) {
        const verdict =
          head[0] === "pr" && head[1] === "merge"
            ? await judgeMerge(rest, repos, parsed, place, factory, builder, command)
            : head[0] === "api"
              ? await judgeApi(rest, cmd, parsed, place, factory)
              : undefined
        if (verdict) return verdict
      }
    }
    let gitArgs: Word[] | undefined
    if (name === "git") gitArgs = args
    else if (first && (first.unknown || marked(first.value)) && isPush(args)) gitArgs = args
    else if (!PRINTERS.has(name)) {
      // git behind a wrapper the reader does not know (run-slot.sh <who> -- git push ...)
      const nested = args.findIndex(
        (a, j) => program(a.value) === "git" && isPush(args.slice(j + 1)),
      )
      if (nested !== -1) gitArgs = args.slice(nested + 1)
    }
    let verdict: string | undefined
    if (gitArgs) {
      // every folder the shell may be in, and none at all past a cd the reader cannot name
      const folders = places(at)
      if (at.cwdUnread || at.cwdAnywhere)
        folders.push({ ...at, cwd: undefined, cwdSure: undefined })
      for (const place of folders) verdict ??= judge(gitArgs, parsed, place, factory, settled)
    }
    const sub = gitArgs && gitCommand(gitArgs).sub?.value
    if (!(name === "git" && sub && GIT_KEEPS_HEAD.has(sub)) && !KEEPS_HEAD.has(name))
      settled = false
    return verdict
  }
  return run(lex(command, env.known), env, visit)
}

// Fails closed only on a call that names a push or another route it reads (a merge, a ref, a file write, GraphQL): an error on any other call lets it run, so a parser bug cannot block every Bash command.
export async function check(
  raw: string,
  environment: Environment = process.env,
  checkout?: string,
): Promise<string | undefined> {
  try {
    return await inspect(raw, environment, checkout)
  } catch (error) {
    if (!/push|merge|refs|contents|graphql|_file/i.test(raw)) return
    return `no-protected-push hook could not read this call (${error}), which names a route onto main or canary, so it refuses it. ${FIX}`
  }
}
