// PreToolUse hook: refuses a git merge or git pull with the ours strategy or the ours strategy option, since the PR's squash onto canary then deletes whatever canary added that the merge ignored, while canary reads as merged in and every gate stays green; a git merge, pull or commit with its hooks off (--no-verify, a commit's -n), since its commit then skips commit-msg and a commit's pre-commit; and a git call that defines an alias on its own line, which can carry either.

import { input } from "./input"
import { gitCommand } from "./no-stash"
import { fromFactory } from "./role"
import {
  BRACE,
  braceWords,
  type Env,
  GIT_TAKES,
  knownVariables,
  lex,
  marked,
  PRINTERS,
  program,
  run,
  visible,
  type Visit,
  type Word,
} from "./shell"

const SUBS = new Set(["merge", "pull"])
// The subcommands whose --no-verify turns off the hooks of the commit they make
const VERIFIED = new Set(["commit", "merge", "pull"])
// Short options of git merge and git pull that take a value, attached or as the next word; ATTACHED's take only an attached one.
const SHORT_TAKES = new Set(["F", "X", "m", "o", "s"])
// Short options whose value is only an attached one, so the next word is an option of its own: -S (merge, pull, commit), pull's -j, commit's -u
const ATTACHED = new Set(["S", "j", "u"])
// How deep the hook follows an alias whose text names another alias; a deeper chain is refused
const ALIAS_DEPTH = 8
// A brace sequence ({x..y}), which braceWords leaves as written
const SEQUENCE = /\{[^{}]*\.\.[^{}]*\}/
const INSTEAD =
  "Merge canary in plainly instead: git merge origin/canary, and resolve each conflict keeping both sides' meaning. With ours, the PR's squash onto canary deletes whatever canary added that the merge ignored, while every gate still reads green."

const AGAIN =
  "Run it again without --no-verify (or a commit's -n), so git runs the hooks of the commit it makes. A reviewer's local merge of canary drops --no-verify too: git -C <clone> merge --no-edit origin/canary runs the clone's own hooks."

// The values of options a merge, pull or commit takes as the next word, so a value spelled --no-verify is read as git reads it
const TAKES: Record<string, Set<string>> = {
  commit: new Set([
    "--author",
    "--cleanup",
    "--date",
    "--file",
    "--fixup",
    "--message",
    "--pathspec-from-file",
    "--reedit-message",
    "--reuse-message",
    "--squash",
    "--template",
    "--trailer",
  ]),
  merge: new Set([
    "--cleanup",
    "--file",
    "--into-name",
    "--message",
    "--strategy",
    "--strategy-option",
  ]),
  pull: new Set(["--cleanup", "--file", "--strategy", "--strategy-option", "--upload-pack"]),
}
// A commit's short options that take a value, attached or as the next word
const COMMIT_SHORT = new Set(["C", "F", "c", "m", "t"])

// One walk of a merge's, pull's or commit's options as git reads them, past each option's value and up to --: the first word read there, an option's value included, that holds a brace list braceWords cannot expand, since its words may be options, and the option that turns the hooks off, as written, when it is the last word of --no-verify and --verify; a commit also takes -n, alone or in a cluster of short options, and an abbreviation of --no-verify longer than the ambiguous --no-ver; a merge's and a pull's -n is --no-stat.
function walk(sub: string, args: Word[]): { off?: string; unread?: Word } {
  let off: string | undefined
  let unread: Word | undefined
  const commit = sub === "commit"
  const value = (k: number) => {
    if (args[k]?.unknown === BRACE) unread ??= args[k]
    return k
  }
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--") break
    if (args[k].unknown === BRACE) unread ??= args[k]
    else if (v.startsWith("--")) {
      if (v === "--verify") off = undefined
      else if (v === "--no-verify" || (commit && v.length > 8 && "--no-verify".startsWith(v)))
        off = v
      else if (TAKES[sub]?.has(v)) k = value(k + 1)
      continue
    }
    if (!v.startsWith("-") || v === "-") continue
    for (let c = 1; c < v.length; c++) {
      const letter = v[c]
      if (commit && letter === "n") off = "-n"
      else if (ATTACHED.has(letter)) break
      else if ((commit ? COMMIT_SHORT : SHORT_TAKES).has(letter)) {
        if (c === v.length - 1) k = value(k + 1)
        break
      }
    }
  }
  return { off, unread }
}

// A long option git reads as --strategy or --strategy-option: either name whole, or an abbreviation of --strategy-option longer than --strategy (a shorter one is ambiguous, which git refuses).
const strategyLong = (name: string): boolean =>
  name === "strategy" || (name.length > "strategy".length && "strategy-option".startsWith(name))

// Every -s, -X, --strategy and --strategy-option value a merge or pull names, with the option as written.
function strategies(args: Word[]): { flag: string; value?: Word }[] {
  const found: { flag: string; value?: Word }[] = []
  for (let k = 0; k < args.length; k++) {
    const v = args[k].value
    if (v === "--") break
    if (v.startsWith("--")) {
      const eq = v.indexOf("=")
      const name = v.slice(2, eq === -1 ? undefined : eq)
      if (!strategyLong(name)) continue
      if (eq !== -1)
        found.push({ flag: `--${name}`, value: { ...args[k], value: v.slice(eq + 1) } })
      else found.push({ flag: v, value: args[++k] })
      continue
    }
    if (!v.startsWith("-") || v === "-") continue
    for (let c = 1; c < v.length; c++) {
      const letter = v[c]
      if (ATTACHED.has(letter)) break
      if (!SHORT_TAKES.has(letter)) continue
      const attached = v.slice(c + 1)
      const value = attached ? { ...args[k], value: attached } : args[++k]
      if (letter === "s" || letter === "X") found.push({ flag: `-${letter}`, value })
      break
    }
  }
  return found
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

// A non-! alias's words as git's split_cmdline makes them: split at whitespace, single and double quotes grouping, a backslash outside single quotes taking the next character as written; undefined on an unclosed quote, which git refuses
function aliasWords(text: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  let quoted = ""
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (!quoted && /\s/.test(c)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (!quoted && (c === "'" || c === '"')) {
      quoted = c
      word ??= ""
    } else if (c === quoted) quoted = ""
    else if (c === "\\" && quoted !== "'") word = (word ?? "") + (text[++k] ?? "")
    else word = (word ?? "") + c
  }
  if (quoted) return
  if (word !== undefined) words.push(word)
  return words
}

// Whether a -c or --config-env value may define an alias: its key (the part before the first =) reads alias.<name> in any case, or, when the program is surely git, holds a part the hook cannot read
const aliasKey = (value: string, git: boolean): boolean => {
  const key = value.split("=")[0]
  return /^alias\./i.test(key) || (git && (marked(key) || key.includes("{")))
}

// The word on git's own line, before its subcommand, that defines an alias by aliasKey
function aliasDefined(args: Word[], git = true): Word | undefined {
  for (let k = 0; k < args.length && args[k].value.startsWith("-"); k++) {
    const v = args[k].value
    if (v.startsWith("--config-env=")) {
      if (aliasKey(v.slice("--config-env=".length), git)) return args[k]
    } else if (GIT_TAKES.has(v)) {
      const value = args[++k]
      if (!value || (v !== "-c" && v !== "--config-env")) continue
      if (aliasKey(value.value, git)) return value
    }
  }
}

// A factory session's git call that defines an alias on its own line is refused, whatever it runs, once the reading below finds nothing more precise; git (the program is surely git) counts an unread -c value, and cluster a short option holding n beside an unread subcommand, both of which a git nested in another program's words (grep git -c "$f") leaves out
async function judgeGit(
  args: Word[],
  env: Env,
  depth: number,
  git = true,
  cluster = true,
): Promise<string | undefined> {
  const found = await readGit(args, env, depth, cluster)
  if (found) return found
  const alias = aliasDefined(args, git)
  if (alias)
    return `no-ours-merge hook refuses this git call: it defines a git alias on its own line (${visible(alias.source ?? alias.value)}), which can run a merge, pull or commit with its hooks off or with ours under a name the hook may not read. Run the git command directly, its words written out in place of the alias.`
}

async function readGit(
  args: Word[],
  env: Env,
  depth: number,
  cluster: boolean,
): Promise<string | undefined> {
  const { aliases, rest, sub } = gitCommand(args)
  if (!sub) return
  if (marked(sub.value)) {
    if (rest.some((a) => a.value === "ours"))
      return `no-ours-merge hook refuses this git call: it cannot read which git command runs (${visible(sub.value)}) beside ours. ${INSTEAD}`
    const off = rest.find(
      (a) => a.value.startsWith("--no-veri") || (cluster && /^-[^-]*n/.test(a.value)),
    )
    if (off)
      return `no-ours-merge hook refuses this git call: it cannot read which git command runs (${visible(sub.value)}) beside ${visible(off.value)}, which may turn a commit's hooks off. ${AGAIN}`
    const alias = rest.find((a) => /^(?:--config-env=)?alias\./i.test(a.value))
    if (alias)
      return `no-ours-merge hook refuses this git call: it cannot read which git command runs (${visible(sub.value)}) beside ${visible(alias.value)}, which may define a git alias. Run the git command directly, its words written out in place of the alias.`
    return
  }
  // git runs an alias for any name but its own commands, which the hook applies to the three it judges, commit, merge and pull; the last -c for a name wins, its key read in any case
  const key = `alias.${sub.value.toLowerCase()}`
  const found = aliases.findLast(
    (a) => a.includes("=") && a.slice(0, a.indexOf("=")).toLowerCase() === key,
  )
  const text = found?.slice(found.indexOf("=") + 1)
  if (text !== undefined && !VERIFIED.has(sub.value)) {
    if (depth >= ALIAS_DEPTH)
      return `no-ours-merge hook refuses git ${sub.value}: it is an alias chain deeper than the ${ALIAS_DEPTH} aliases the hook follows, so it cannot read what runs. Call the git command the chain ends in. ${AGAIN}`
    // a ! alias is a shell line git runs with the typed words after it; any other is git with its own options, the alias's words and the typed words
    if (text.startsWith("!")) {
      const line = `${text.slice(1)} ${rest.map((w) => quote(w.value)).join(" ")}`
      return run(lex(line, env.known), env, visitor(depth + 1))
    }
    const words = aliasWords(text)
    if (!words) return
    const own = words.map((value) => ({
      ...sub,
      raw: undefined,
      source: value,
      unknown: undefined,
      value,
    }))
    return judgeGit([...args.slice(0, args.indexOf(sub)), ...own, ...rest], env, depth + 1)
  }
  if (!VERIFIED.has(sub.value)) return
  // a -h or --help lets no refused call through, since the walk may read a word as help that git takes as an option's value
  const { off, unread } = walk(sub.value, rest)
  if (unread)
    return `no-ours-merge hook refuses git ${sub.value} with a brace list it cannot expand (${visible(unread.source ?? unread.value)}), which may spell --no-verify${SUBS.has(sub.value) ? " or ours" : ""}: write the words out. ${SUBS.has(sub.value) ? `${INSTEAD} ` : ""}${AGAIN}`
  if (off)
    return `no-ours-merge hook refuses git ${sub.value} ${off}, which turns its hooks off. ${AGAIN}`
  if (!SUBS.has(sub.value)) return
  for (const { flag, value } of strategies(rest)) {
    if (value && (marked(value.value) || value.unknown === BRACE))
      return `no-ours-merge hook refuses git ${sub.value} ${flag} with a value it cannot read (${visible(value.source ?? value.value)}). ${INSTEAD}`
    if (value?.value === "ours")
      return `no-ours-merge hook refuses git ${sub.value} ${flag} ours. ${INSTEAD}`
  }
}

const verified = (args: Word[]) => VERIFIED.has(gitCommand(args).sub?.value ?? "")

// A nested git's subcommand the hook judges: commit, merge, pull, or one it cannot read
const judged = (args: Word[]) => {
  const sub = gitCommand(args).sub?.value
  return sub !== undefined && (VERIFIED.has(sub) || marked(sub))
}

// Each word as the shell's brace expansion makes it; a list past braceWords' cap or holding a sequence keeps its BRACE mark, as a word the hook cannot read
const expanded = (args: Word[]): Word[] =>
  args.flatMap((w) => {
    if (w.unknown !== BRACE) return [w]
    const words = braceWords(w.value)
    if (!words || words.some((v) => SEQUENCE.test(v))) return [w]
    return words.map((value) => ({ ...w, unknown: undefined, value }))
  })

// git itself, a name the hook cannot read with a merge, pull or commit after it, or git behind a wrapper the reader does not know (run-slot.sh <who> -- git merge ...); depth counts the aliases followed to reach it.
const visitor =
  (depth: number): Visit =>
  async (_cmd, { args: typed, first, name }, env) => {
    const args = expanded(typed)
    if (name === "git") return judgeGit(args, env, depth)
    if (
      first &&
      (first.unknown || marked(first.value)) &&
      (verified(args) || aliasDefined(args, false))
    )
      return judgeGit(args, env, depth, false)
    if (PRINTERS.has(name)) return
    const nested = args.findIndex(
      (a, j) =>
        program(a.value) === "git" &&
        (judged(args.slice(j + 1)) || aliasDefined(args.slice(j + 1), false)),
    )
    if (nested !== -1) return judgeGit(args.slice(nested + 1), env, depth, false, false)
  }

const BARE = (command: string) => command.replace(/[\\'"]/g, "")

// The cheap first look: ours, veri (--no-verify and its abbreviations), a short option holding n, a brace list or sequence, alias, a -c or --config-env named anywhere, quotes gone so o'u'rs still counts; $'...' can spell any word, so it always counts.
const candidate = (command: string): boolean =>
  command.includes("$'") ||
  /ours|veri|alias|config-env|(?:^|\s)-c\s|(?:^|[\s{,])-[^\s-]*n|\{[^}]*(?:,|\.\.)/i.test(
    BARE(command),
  )

// A call that reads as a merge or pull with ours, a merge, pull or commit with its hooks off, or a git call that defines an alias, which the hook refuses when it cannot read it
const mergeCall = (command: string): boolean => {
  const bare = BARE(command)
  if (!/\bgit\b/i.test(bare)) return false
  if (/alias\./i.test(bare)) return true
  if (/\b(?:merge|pull)\b/.test(bare) && /ours/.test(bare)) return true
  if (/\b(?:commit|merge|pull)\b/.test(bare) && /--no-veri/.test(bare)) return true
  return /\bcommit\b/.test(bare) && /(?:^|[\s{,])-[^\s-]*n/.test(bare)
}

async function inspect(raw: string, environment: Record<string, string | undefined>) {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (typeof payload !== "object" || payload === null)
    return mergeCall(raw)
      ? "no-ours-merge hook could not parse its input, which reads as a merge with ours, a git call with its hooks off or one that defines an alias, so it refuses the call."
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
  return run(lex(command, env.known), env, visitor(0))
}

// Fails closed only on a call that reads as a merge with ours, a git call with its hooks off or one that defines an alias: an error on any other call lets it run, so a parser bug cannot block every Bash command.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    return await inspect(raw, environment)
  } catch (error) {
    let command = raw
    try {
      const parsed = JSON.parse(raw) as { tool_input?: { command?: unknown } }
      if (typeof parsed.tool_input?.command === "string") command = parsed.tool_input.command
    } catch {}
    if (!mergeCall(command)) return
    return `no-ours-merge hook could not read this call (${error}), which reads as a merge with ours, a git call with its hooks off or one that defines an alias, so it refuses it. Split it into plain commands and run them again.`
  }
}

if (import.meta.main) {
  const raw = await input("no-ours-merge", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
