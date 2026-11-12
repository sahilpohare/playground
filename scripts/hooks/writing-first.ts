// Hook on PreToolUse (Edit, MultiEdit, Skill, Write), UserPromptSubmit and SessionStart: refuses a write to an agent-facing doc until the session has loaded writing-for-agents (playbook's **writing** rule); its check() reads a Bash call's direct write too, which the matcher reaches once it names Bash.
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { dataDirOf } from "../../packages/env/src/data-dir"
import { UPSTREAM_SKILLS } from "../../packages/scripts/src/vendor-upstream/stage"
import { guardInputs } from "./codex"
import { writeTargets } from "./no-main-checkout"
import { fromFactory } from "./role"
import {
  type Command,
  type Env,
  knownVariables,
  lex,
  pathOf,
  places,
  run,
  stdinOf,
  type Visit,
  type Word,
  withDeadline,
} from "./shell"

export const SKILL = "writing-for-agents"

type Environment = Record<string, string | undefined>
type Input = {
  agent_id?: unknown
  cwd?: unknown
  hook_event_name?: unknown
  prompt?: unknown
  session_id?: unknown
  source?: unknown
  tool_input?: { command?: unknown; file_path?: unknown; skill?: unknown } | null
  tool_name?: unknown
  turn_id?: unknown
}

const WRITES = new Set(["Edit", "MultiEdit", "Write"])
const ID = /^[\w-]+$/
// the bare name, or a plugin's or a folder's scoped copy (`ws-home:writing-for-agents`)
const LOADS = new RegExp(`^(?:[\\w./-]+:)?${SKILL}$`)
const TYPED = new RegExp(`^\\s*/(?:[\\w./-]+:)?${SKILL}(?:\\s|$)`)
// Codex has no Skill tool, so a Codex session loads the skill by reading its SKILL.md in the shell
const READS = new RegExp(
  `(?:^|[\\n;&|(])\\s*(?:bat|cat|head|less|more|nl|sed|tail)\\s[^\\n;&|]*${SKILL}/SKILL\\.md(?![\\w.])`,
)
// a checkout is the factory's when it holds the factory's own skill, in core or in either folder an older worktree's branch may have, so a worktree matches and another org's repository does not
const FACTORY_MARKERS = [
  join("extensions", "core", "skills", "playbook", "SKILL.md"),
  ...["playground", "engineering"].map((folder) =>
    join("skills", folder, "playground-factory", "SKILL.md"),
  ),
]

const configDir = (env: Environment) =>
  env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude")
const marks = (env: Environment) => join(dataDirOf(env), "writing-first")

// One mark per session, and per subagent within it: a subagent's hook input carries its parent's session id beside its own agent id (measured on Claude Code 2.1.296, 13 Oct), so a parent's load would otherwise let an unloaded subagent write.
function markOf(input: Input, env: Environment): string | undefined {
  const session = typeof input.session_id === "string" ? input.session_id : ""
  const agent = typeof input.agent_id === "string" ? input.agent_id : ""
  if (!ID.test(session) || (agent && !ID.test(agent))) return
  return join(marks(env), agent ? `${session}.${agent}` : session)
}

// The path as the file system resolves it, following symlinks through the deepest part that exists, so ~/.claude/skills/<name> lands in the checkout it links to.
function real(path: string): string {
  let head = path
  const tail: string[] = []
  while (!existsSync(head)) {
    const parent = dirname(head)
    if (parent === head) return path
    tail.unshift(basename(head))
    head = parent
  }
  return join(realpathSync(head), ...tail)
}

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

// The nearest folder holding .git, a file in a linked worktree and a folder in a clone.
function repoOf(path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir
    if (dirname(dir) === dir) return
  }
}

// A ZeroStarter skill (skills/zerostarter, which .agents/skills links to) is ours unless its frontmatter names a tool as its source rather than a repository: agent-browser and portless are vendored, copied verbatim from upstream.
async function vendored(repo: string, name: string): Promise<boolean> {
  const file = Bun.file(join(repo, "skills", "zerostarter", name, "SKILL.md"))
  if (!(await file.exists())) return false
  const source = /^source:\s*(\S+)/m.exec(await file.text())?.[1]
  return source !== undefined && !source.startsWith("https://")
}

// Whether the path is an agent-facing doc of the factory's, by its place in the checkout (symlinks resolved, so .agents/skills arrives as skills/zerostarter): skills and an extension's skills and rules (but vendored ZeroStarter skills and core's upstream skills, which only vendor:upstream writes), the dashboard rules, the guides directly in .agents, the agent guide, the scripts and hooks READMEs and the docs pages; or a handoff.
async function scoped(path: string, env: Environment): Promise<boolean> {
  const handoffs = real(join(dataDirOf(env), "handoffs"))
  if (inside(path, handoffs)) return true
  const repo = repoOf(path)
  if (!repo || !FACTORY_MARKERS.some((marker) => existsSync(join(repo, marker)))) return false
  const rel = relative(repo, path).split(sep).join("/")
  const upstream = /^extensions\/core\/skills\/([^/]+)\//.exec(rel)?.[1]
  if (upstream && UPSTREAM_SKILLS.includes(upstream)) return false
  const zerostarter = /^skills\/zerostarter\/([^/]+)\//.exec(rel)?.[1]
  if (zerostarter) return !(await vendored(repo, zerostarter))
  return (
    rel.startsWith("skills/") ||
    /^extensions\/[^/]+\/(skills|rules)\//.test(rel) ||
    rel.startsWith(".agents/dashboard/") ||
    rel.startsWith("docs/") ||
    /^\.agents\/[^/]+\.md$/.test(rel) ||
    ["AGENTS.md", "CLAUDE.md", "scripts/README.md", "scripts/hooks/README.md"].includes(rel)
  )
}

// each plugin installed and enabled for the user, or installed for the session's project
const plugins = async (env: Environment, cwd: string | undefined): Promise<string[]> => {
  const read = async (file: string): Promise<unknown> => {
    try {
      return await Bun.file(join(configDir(env), file)).json()
    } catch {
      return undefined
    }
  }
  const listed = (await read(join("plugins", "installed_plugins.json"))) as
    | {
        plugins?: Record<
          string,
          { installPath?: unknown; projectPath?: unknown; scope?: unknown }[]
        >
      }
    | undefined
  const enabled = (
    (await read("settings.json")) as { enabledPlugins?: Record<string, unknown> } | undefined
  )?.enabledPlugins
  return Object.entries(listed?.plugins ?? {}).flatMap(([key, installs]) =>
    (Array.isArray(installs) ? installs : []).flatMap((install) => {
      if (typeof install?.installPath !== "string") return []
      const loads =
        install.scope === "user"
          ? enabled?.[key] === true
          : typeof install.projectPath === "string" &&
            !!cwd &&
            !relative(install.projectPath, cwd).startsWith("..")
      return loads ? [install.installPath] : []
    }),
  )
}

const installed = async (env: Environment, cwd: string | undefined) =>
  [configDir(env), ...(cwd ? [join(cwd, ".claude")] : []), ...(await plugins(env, cwd))].some(
    (dir) => existsSync(join(dir, "skills", SKILL, "SKILL.md")),
  )

async function mark(input: Input, env: Environment) {
  const file = markOf(input, env)
  if (file) await Bun.write(file, "")
}

// A compaction drops the skill's text from context, so every mark of the session goes, its subagents' included.
function clear(input: Input, env: Environment) {
  const session = typeof input.session_id === "string" ? input.session_id : ""
  if (!ID.test(session) || !existsSync(marks(env))) return
  for (const name of readdirSync(marks(env)))
    if (name === session || name.startsWith(`${session}.`)) unlinkSync(join(marks(env), name))
}

// The refusal when the session has no mark and the skill is installed, else undefined.
async function refusal(
  input: Input,
  env: Environment,
  target: string,
): Promise<string | undefined> {
  const file = markOf(input, env)
  if (!file || existsSync(file)) return
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined
  if (!(await installed(env, cwd))) return
  const who =
    typeof input.agent_id === "string" && input.agent_id ? "this subagent" : "this session"
  return `writing-first hook refuses this ${String(input.tool_name)} to ${target}: it is an agent-facing doc, and ${who} has not loaded ${SKILL} since its last compaction. Call the Skill tool with skill "${SKILL}", or the scoped name your skill list shows for it (such as "ws-home:${SKILL}"), follow it, then retry this write (playbook's **writing** rule).`
}

async function judge(input: Input, env: Environment): Promise<string | undefined> {
  const target = input.tool_input?.file_path
  if (typeof target !== "string" || !markOf(input, env)) return
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined
  if (!(await scoped(real(resolve(cwd ?? "/", target)), env))) return
  return refusal(input, env, target)
}

// An interpreter of another language by its family, through a version suffix (python3.12, node18): the short letters that carry inline code (attached where `attached` says, as python's -c'…' and perl's -e'…', else the next word, so node's -pe reads its program next), those that take a value (attached or the next word), and those that take the rest of their word; a module (python -m) runs a program by name
type Family = {
  attached?: boolean
  code: string
  module?: string
  rest?: string
  takes: string[]
  values: string
}
const FAMILIES: Record<string, Family> = {
  bun: {
    code: "ep",
    takes: ["--cwd", "--env-file", "--preload", "--tsconfig-override"],
    values: "r",
  },
  deno: { code: "", takes: ["--config", "--import-map"], values: "c" },
  node: {
    code: "ep",
    takes: [
      "--conditions",
      "--env-file",
      "--import",
      "--input-type",
      "--loader",
      "--require",
      "--title",
    ],
    values: "Cr",
  },
  perl: { attached: true, code: "eE", rest: "iIlmMx0", takes: [], values: "" },
  python: {
    attached: true,
    code: "c",
    module: "m",
    takes: ["--check-hash-based-pycs"],
    values: "WX",
  },
  ruby: { attached: true, code: "e", rest: "ix0", takes: [], values: "CEIr" },
}
const FAMILY = /^(bun|deno|node|nodejs|perl|python|ruby)[\d.]*$/
// a word of code text that may name a file: one holding a slash, or a .md file's name
const PATHLIKE = /[^\s'"`()[\]{},;:=<>|&$*?!]+/g

// An interpreter call's inline code (a -c or -e program, attached, in a cluster, or as --eval=), and the index of its first operand; module is set when it runs a program by name (python -m)
function inlineCode(family: Family, args: Word[]): { code: string[]; k: number; module: boolean } {
  const code: string[] = []
  let k = 0
  for (; k < args.length; k++) {
    const v = args[k]!.value
    if (v === "--") return { code, k: k + 1, module: false }
    if (/^--(?:eval|print)=/.test(v)) code.push(v.slice(v.indexOf("=") + 1))
    else if (v === "--eval" || v === "--print") {
      if (args[k + 1]) code.push(args[++k]!.value)
    } else if (v.startsWith("--")) {
      if (family.takes.includes(v)) k++
    } else if (v.startsWith("-") && v !== "-") {
      for (let c = 1; c < v.length; c++) {
        const letter = v[c]!
        const attached = v.slice(c + 1)
        if (letter === family.module) return { code, k, module: true }
        if (family.code.includes(letter)) {
          if (attached && family.attached) code.push(attached)
          else if (args[k + 1]) code.push(args[++k]!.value)
          break
        }
        if (family.values.includes(letter)) {
          if (!attached) k++
          break
        }
        if (family.rest?.includes(letter)) break
      }
    } else break
  }
  return { code, k, module: false }
}

// The words an inline interpreter script may write to: each path-like word of its code (an inline program, deno's eval, or a heredoc or here-string it reads as its script) and of its arguments; none for a script or module run by name, which is the repo's own or the caller's file.
async function inlineTargets(
  name: string,
  args: Word[],
  cmd: Command,
  here: Env,
): Promise<string[]> {
  const base = FAMILY.exec(name)?.[1]
  if (!base) return []
  const family = FAMILIES[base === "nodejs" ? "node" : base]!
  const evaled = base === "deno" && args[0]?.value === "eval"
  const { code, k, module } = evaled
    ? { code: args.slice(1, 2).map((a) => a.value), k: 2, module: false }
    : inlineCode(family, args)
  if (module) return []
  const operand = args[k]?.value
  if (code.length === 0) {
    // a script file or a subcommand by name runs no inline code
    if (operand !== undefined && operand !== "-") return []
    const fed = await stdinOf(cmd, here)
    if (fed.unknown) return []
    code.push(fed.value)
  }
  const words = [
    ...code.flatMap((text) => text.match(PATHLIKE) ?? []),
    ...args.slice(k).map((a) => a.value),
  ]
  return words.filter((w) => w.includes("/") || w.endsWith(".md"))
}

// The options of cp, mv and install whose next word is a value, not an operand (install's mode, owner, group and suffix, GNU's suffix); -t names the target folder
const COPY_VALUES = new Set(["-g", "-m", "-o", "-S"])
// The files a cp, mv or install creates in a folder it is given: each source's name under the destination (its last operand, or -t's folder), judged beside the destination itself, so a copy into the repo root or docs/ is read by the file it lands as
function copiedInto(name: string, args: Word[]): Word[] {
  if (name !== "cp" && name !== "mv" && name !== "install") return []
  let folder: Word | undefined
  const operands: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k]!.value
    if (v === "-t" || v === "--target-directory") folder = args[++k]
    else if (v.startsWith("--target-directory=")) folder = { ...args[k]!, value: v.slice(19) }
    else if (/^-t./.test(v)) folder = { ...args[k]!, value: v.slice(2) }
    else if (COPY_VALUES.has(v)) k++
    else if (!v.startsWith("-")) operands.push(args[k]!)
  }
  const destination = folder ?? operands.pop()
  if (!destination) return []
  return [
    ...(name === "install" ? [destination] : []),
    ...operands.map((source) => ({
      ...destination,
      value: join(destination.value, basename(source.value)),
    })),
  ]
}

// The first agent-facing doc a Bash call writes directly, as the call names it: a redirect's, tee's, cp's, mv's, install's or an in-place sed's or perl's target, a cp's, mv's or install's file in the folder it is given, or a path an inline interpreter script names; a target the reader cannot place is passed, since the hook nudges and fails open.
async function bashTarget(input: Input, env: Environment): Promise<string | undefined> {
  const command = input.tool_input?.command
  if (typeof command !== "string") return
  const directory = typeof input.cwd === "string" ? input.cwd : undefined
  const home = env.HOME || homedir()
  const known = knownVariables(command, env, directory)
  const visit: Visit = async (cmd, parsed, at) => {
    const { args, name } = parsed
    for (const here of places(at, directory)) {
      const named = writeTargets(cmd, name, args)
      named.push(...copiedInto(name, args))
      for (const word of named) {
        const path = pathOf(word, here)
        if (path && (await scoped(real(path), env))) return word.value
      }
      if (!here.cwd) continue
      for (const word of await inlineTargets(name, args, cmd, here)) {
        const path = resolve(here.cwd, word.replace(/^~(?=\/)/, home))
        if (await scoped(real(path), env)) return word
      }
    }
  }
  const at: Env = {
    cwd: directory,
    cwdSure: directory,
    files: new Map(),
    known,
    old: { dir: directory },
    process: env,
    vars: new Map(),
  }
  return run(lex(command, known), at, visit, true)
}

// Fails open: input it cannot read, or an error, lets the call run, so a fault here never blocks every write.
export async function check(
  raw: string,
  env: Environment = process.env,
): Promise<string | undefined> {
  try {
    const input = JSON.parse(raw) as Input
    if (typeof input !== "object" || input === null) return
    const event = input.hook_event_name
    if (event === "PreToolUse" && input.tool_name === "Skill") {
      const skill = input.tool_input?.skill
      if (typeof skill === "string" && LOADS.test(skill)) await mark(input, env)
      return
    }
    if (event === "UserPromptSubmit") {
      if (typeof input.prompt === "string" && TYPED.test(input.prompt)) await mark(input, env)
      return
    }
    if (event === "SessionStart") {
      if (input.source === "compact") clear(input, env)
      return
    }
    if (event !== "PreToolUse") return
    const command = input.tool_input?.command
    if (
      typeof input.turn_id === "string" &&
      input.tool_name === "Bash" &&
      typeof command === "string" &&
      READS.test(command)
    ) {
      await mark(input, env)
      return
    }
    // a Codex edit reads as one Write per file its patch names; one it cannot read runs, since the hook nudges
    for (const one of guardInputs(raw) ?? []) {
      const reason = await toolCheck(JSON.parse(one) as Input, env)
      if (reason) return reason
    }
  } catch {
    return
  }
}

async function toolCheck(input: Input, env: Environment): Promise<string | undefined> {
  if (WRITES.has(String(input.tool_name))) return await judge(input, env)
  if (input.tool_name === "Bash") {
    const file = markOf(input, env)
    if (!file || existsSync(file)) return
    // past the walk's deadline the call runs, inside the hook's 15s timeout
    const target = await withDeadline(8_000, () => bashTarget(input, env))
    return target === undefined ? undefined : await refusal(input, env, target)
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
