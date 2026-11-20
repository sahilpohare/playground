import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { loadavg } from "node:os"
import { basename, dirname, join, relative } from "node:path"

import { makeScratch, removeScratch } from "@packages/safe-delete"

import { CORE, coreDir, extensionsDir, GUARD_LISTS, scopeDir } from "./rendered"

// Each scope's folder under the extensions root as a git repository: a write takes the one lock beside the root, changes its scope's files and any of the root's derived files, and lands as one commit in that scope whose author is who asked, whose message is the reason and whose trailers name what it touched, so the scope's git log is its history.

export type Commit = {
  // Commit even when no file changed, as a score below 5 does.
  allowEmpty?: boolean
  author: string
  reason: string
  trailers?: [string, string][]
}

export const lockPath = (data: string) => `${extensionsDir(data)}.lock`

// A lock this old outlived the write that took it.
const STALE_MS = 5 * 60_000

// With gh on PATH, the extensions' repositories are reached as the gh login that made them: gh's credential helper alone, as gh auth setup-git sets it but for this command only, so a keychain holding another login's token never answers for them (GitHub's "Repository not found").
const ghCredential = (): string[] =>
  Bun.which("gh", { PATH: process.env.PATH ?? "" })
    ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    : []

// git as the extensions run it: none of the caller's GIT_ variables (a hook's GIT_DIR or GIT_INDEX_FILE), no signing, no hooks and gh's credentials.
export const extGit = (
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  opts: { raw?: boolean } = {},
): { code: number; err: string; out: string } => {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  )
  const run = Bun.spawnSync(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...ghCredential(),
      "-C",
      dir,
      ...args,
    ],
    { env: { ...clean, ...env }, stderr: "pipe", stdout: "pipe" },
  )
  return {
    code: run.exitCode,
    err: run.stderr.toString().trim(),
    out: opts.raw ? run.stdout.toString() : run.stdout.toString().trim(),
  }
}

// extGit's output, or an error naming what failed.
export const mustGit = (dir: string, args: string[], env: Record<string, string> = {}): string => {
  const run = extGit(dir, args, env)
  if (run.code !== 0) throw new Error(`git ${args[0]} in ${dir}: ${run.err}`)
  return run.out
}

// mustGit's output as git wrote it, a file's bytes whole with its final newline, where the trimmed shape would drop it.
export const mustGitRaw = (
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): string => {
  const run = extGit(dir, args, env, { raw: true })
  if (run.code !== 0) throw new Error(`git ${args[0]} in ${dir}: ${run.err}`)
  return run.out
}

// Moves the lock aside when it still holds this holder's token; one taken over as stale meanwhile, or gone, stays as it is.
const releasable = (lock: string, aside: string, token: string): boolean => {
  try {
    if (readFileSync(join(lock, "owner"), "utf8") !== token) return false
    renameSync(lock, aside)
    return true
  } catch {
    return false
  }
}

// One write at a time across every process, the API's and the CLI's: the lock is a scratch folder made beside the root and renamed into place, so its taking is atomic and it always holds makeScratch's marker and its holder's token; a stale one is moved aside, then removed, and a release leaves a lock that holds another's token.
const holdLock = <T>(data: string, run: () => T, wait: number): T => {
  const lock = lockPath(data)
  const parent = dirname(lock)
  const drop = (dir: string) => {
    const refused = removeScratch(dir, parent)
    if (refused) console.error(`extensions' lock: ${refused}`)
  }
  mkdirSync(parent, { recursive: true })
  const mine = makeScratch(`${basename(lock)}.`, parent)
  const token = crypto.randomUUID()
  writeFileSync(join(mine, "owner"), token)
  const start = Date.now()
  for (;;) {
    try {
      // a rename keeps the folder's time, so it is stamped now, or a lock taken after a wait would read as old
      const now = new Date()
      utimesSync(mine, now, now)
      renameSync(mine, lock)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
        drop(mine)
        throw error
      }
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_MS) {
        const aside = `${lock}.stale-${crypto.randomUUID()}`
        renameSync(lock, aside)
        drop(aside)
      }
    } catch {}
    if (Date.now() - start > wait) {
      drop(mine)
      throw new Error(`another write holds the extensions' lock (${lock}); try again once it ends`)
    }
    Bun.sleepSync(20)
  }
  try {
    return run()
  } finally {
    // moved aside before its removal, so the lock is never an empty folder a waiter's rename could land on
    const aside = `${lock}.free-${token}`
    if (releasable(lock, aside, token)) drop(aside)
    else
      console.error(
        `extensions' lock: ${lock} was taken over as stale during this write; left as it is`,
      )
  }
}

// The root's file lock: macOS's user immutable flag on the root and everything under it, so a plain write from any process meets EPERM; a machine with no chflags (Linux) has no lock, and a root with no flag takes its writes as before.
const chflags = () => Bun.which("chflags", { PATH: process.env.PATH ?? "" })
export const rootLocked = (root: string): boolean =>
  Boolean(chflags()) &&
  existsSync(root) &&
  Bun.spawnSync(["stat", "-f", "%Sf", root]).stdout.toString().trim().split(",").includes("uchg")
// A tree's flag set or cleared, and the time it took: a path inside the tree gone by the time the walk reaches it is skipped, since git maintenance can remove a file of a scope's .git mid-walk, and a missing tree or any other failure throws.
const flagTree = (tree: string, locked: boolean): number => {
  if (!existsSync(tree))
    throw new Error(`chflags could not ${locked ? "lock" : "unlock"} ${tree}: it does not exist`)
  const start = performance.now()
  const run = Bun.spawnSync([chflags()!, "-R", locked ? "uchg" : "nouchg", tree], {
    stderr: "pipe",
  })
  const said = run.stderr.toString().split("\n").filter(Boolean)
  if (
    run.exitCode !== 0 &&
    (!said.length || said.some((line) => !line.endsWith(": No such file or directory")))
  )
    throw new Error(`chflags could not ${locked ? "lock" : "unlock"} ${tree}: ${run.stderr}`)
  return performance.now() - start
}

// One line per lift in the data folder's ops/log/ext-lock.log, beside the ops tick's relocks: its time, the trees it lifted, the lift and relock's duration, load5 and the caller (the entry script, and the session's role when it has one), so the log measures the lock on the live root.
const logLift = (data: string, trees: readonly string[], took: number) => {
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  const entry = process.argv[1] ?? process.argv0
  const role = process.env.PLAYGROUND_ROLE
  const by = `${basename(dirname(entry))}/${basename(entry)}${role ? ` (${role})` : ""}`
  const line = `${at} lifted ${trees.join(", ")} in ${Math.round(took)} ms load5 ${loadavg()[1].toFixed(2)} by ${by}\n`
  try {
    mkdirSync(join(data, "ops", "log"), { recursive: true })
    appendFileSync(join(data, "ops", "log", "ext-lock.log"), line)
  } catch (error) {
    console.error(`extensions' lock: could not log its lift: ${error}`)
  }
}

// A write under the one lock: a locked root has the scope folders the write names lifted for it and locked again after, or the whole root when it names none, so a write to one scope leaves every other locked; each lift and relock's time is logged (logLift), so the ops tick's log measures it on the live root.
export const withLock = <T>(
  data: string,
  run: () => T,
  { scopes, wait = 30_000 }: { scopes?: readonly string[]; wait?: number } = {},
): T =>
  holdLock(
    data,
    () => {
      const root = extensionsDir(data)
      if (!rootLocked(root)) return run()
      const trees = scopes ? scopes.map((scope) => scopeDir(data, scope)) : [root]
      let took = 0
      let lifted = false
      try {
        for (const tree of trees) took += flagTree(tree, false)
        lifted = true
        return run()
      } finally {
        for (const tree of trees) took += flagTree(tree, true)
        if (lifted) {
          console.error(
            `extensions' lock: lifted and relocked ${trees.join(", ")} in ${Math.round(took)} ms`,
          )
          logLift(data, trees, took)
        }
      }
    },
    wait,
  )

// playground ext lock and unlock: the root's file lock set or cleared, under the one lock so no write is mid-way.
export const setRootLock = (data: string, locked: boolean): void => {
  if (!chflags())
    throw new Error("this machine has no chflags, so the extensions root takes no lock")
  holdLock(data, () => void flagTree(extensionsDir(data), locked), 30_000)
}

// The ops tick's relock: true when it locked a root that stood unlocked, at its top or at a scope folder a write killed mid-way left lifted, false where all of it is locked already, it is missing, or the machine has no chflags.
export const relockRoot = (data: string): boolean => {
  const root = extensionsDir(data)
  if (!chflags() || !existsSync(root)) return false
  if (rootLocked(root) && scopesIn(data).every((scope) => rootLocked(scopeDir(data, scope))))
    return false
  setRootLock(data, true)
  return true
}

// A file written whole under a temp name, then renamed into place, so a hook reading it meets the old file or the new one.
export const writeAtomically = (path: string, data: string | Uint8Array) => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

// The root's derived files written, or removed where the value is null; call it inside commitExt's change, or under withLock.
export const writeRoot = (root: string, files: Map<string, string | null>) => {
  for (const [path, text] of files)
    if (text === null) rmSync(join(root, path), { force: true })
    else writeAtomically(join(root, path), text)
}

// Every file in the folder but git's own, as paths relative to it.
export const filesIn = (dir: string): string[] => {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
      entry.name === ".git" && at === dir
        ? []
        : entry.isDirectory()
          ? walk(join(at, entry.name))
          : [relative(dir, join(at, entry.name))],
    )
  return existsSync(dir) ? walk(dir).sort() : []
}

// A scope's script files, each <scope>/scripts/<key>/<path> split on its slashes: the folders an org's own job may run from, read alike by the jobs render and a settings write.
export const scriptFilesOf = (data: string, scope: string): string[][] =>
  filesIn(scopeDir(data, scope))
    .map((file) => file.split("/"))
    .filter((parts) => parts[0] === "scripts" && parts.length >= 3)

// The scope folders present under the root, each a git repository, by name.
export const scopesIn = (data: string): string[] => {
  const root = extensionsDir(data)
  return existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ".git")))
        .map((entry) => entry.name)
        .sort()
    : []
}

const pruneEmpty = (dir: string, at: string) => {
  for (const entry of readdirSync(at, { withFileTypes: true }))
    if (entry.isDirectory() && !(entry.name === ".git" && at === dir)) {
      pruneEmpty(dir, join(at, entry.name))
      if (!readdirSync(join(at, entry.name)).length) rmdirSync(join(at, entry.name))
    }
}

// One write to a scope: its folder made a repository on its first write, the change run under the lock with the scope's folder and the root, then everything it changed in the scope committed there as one commit; the new commit's sha, or undefined when nothing changed and allowEmpty is not set. A change that leaves the root's own files alone says so with writesRoot false, and then lifts its scope alone once the scope exists. Core ships with the checkout, so it is refused.
export const commitExt = (
  data: string,
  scope: string,
  commit: Commit,
  change: (dir: string, root: string) => void,
  writesRoot = true,
): string | undefined => {
  if (scope === CORE)
    throw new Error("core is Playground's own and read-only here: change it in the app repo")
  const scopes =
    !writesRoot && existsSync(join(scopeDir(data, scope), ".git")) ? [scope] : undefined
  return withLock(
    data,
    () => {
      const dir = scopeDir(data, scope)
      if (!existsSync(join(dir, ".git"))) {
        mkdirSync(dir, { recursive: true })
        mustGit(dir, ["init", "-q", "-b", "main"])
      }
      change(dir, extensionsDir(data))
      mustGit(dir, ["add", "-A"])
      const changed = mustGit(dir, ["status", "--porcelain"]) !== ""
      if (!changed && !commit.allowEmpty) return undefined
      const who = { email: "playground", name: commit.author }
      mustGit(
        dir,
        [
          "commit",
          "-q",
          ...(changed ? [] : ["--allow-empty"]),
          "-m",
          commit.reason,
          ...(commit.trailers ?? []).flatMap(([key, value]) => ["--trailer", `${key}: ${value}`]),
        ],
        {
          GIT_AUTHOR_EMAIL: who.email,
          GIT_AUTHOR_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
          GIT_COMMITTER_NAME: "Playground",
        },
      )
      return mustGit(dir, ["rev-parse", "HEAD"])
    },
    { scopes },
  )
}

// A scope's files made exactly these, as one commit: each written in place by rename, then every other file removed but those keep names; a file written over keeps the mode of the file it replaces, and executable says which source files run, so an import never strips a stored script's bit.
export const writeTree = (
  data: string,
  scope: string,
  files: Map<string, string | Uint8Array>,
  commit: Commit,
  keep: (path: string) => boolean = () => false,
  executable?: (path: string) => boolean,
): string | undefined =>
  commitExt(
    data,
    scope,
    commit,
    (dir) => {
      for (const [path, text] of files) {
        const at = join(dir, path)
        const ran = existsSync(at) && (statSync(at).mode & 0o111) !== 0
        writeAtomically(at, text)
        if (executable?.(path) || ran) chmodSync(at, 0o755)
      }
      for (const path of filesIn(dir)) if (!files.has(path) && !keep(path)) rmSync(join(dir, path))
      pruneEmpty(dir, dir)
    },
    false,
  )

// These files of a scope written, or removed where the value is null, as one commit, with the root's derived files given written in the same lock.
export const writeFiles = (
  data: string,
  scope: string,
  files: Map<string, string | Uint8Array | null>,
  commit: Commit,
  root: Map<string, string | null> = new Map(),
): string | undefined =>
  commitExt(
    data,
    scope,
    commit,
    (dir, at) => {
      for (const [path, text] of files)
        if (text === null) rmSync(join(dir, path), { force: true })
        else writeAtomically(join(dir, path), text)
      pruneEmpty(dir, dir)
      writeRoot(at, root)
    },
    root.size > 0,
  )

// Lists union across scopes: arrays join without repeats, objects join key by key, and a scalar keeps the first scope's value.
export const unionLists = (values: unknown[]): unknown =>
  values.reduce((all, value) =>
    Array.isArray(all) && Array.isArray(value)
      ? [...new Set([...all, ...value])]
      : all && value && typeof all === "object" && typeof value === "object" && !Array.isArray(all)
        ? Object.fromEntries(
            [...new Set([...Object.keys(all), ...Object.keys(value)])].map((key) => [
              key,
              key in all && key in value
                ? unionLists([
                    (all as Record<string, unknown>)[key],
                    (value as Record<string, unknown>)[key],
                  ])
                : key in all
                  ? (all as Record<string, unknown>)[key]
                  : (value as Record<string, unknown>)[key],
            ]),
          )
        : all,
  )

// Each guard's list as the root's hooks/<list>.json, the union of the login's, each org's and core's lists/<list>.json, so a guard sees every term any scope holds; a list no scope holds is removed, so its guard refuses. The names with no list, for the caller to report. A list that does not parse is left out, and the guard's own check refuses the shape.
export const deriveHooks = (
  data: string,
  login: string,
  root = extensionsDir(data),
  core = coreDir(),
): string[] => {
  const missing: string[] = []
  const files = new Map<string, string | null>()
  const order = [login, ...scopesIn(data).filter((scope) => scope !== login)]
  for (const name of GUARD_LISTS) {
    const found = [...order.map((scope) => scopeDir(data, scope)), core]
      .map((dir) => join(dir, "lists", `${name}.json`))
      .filter(existsSync)
    if (!found.length) missing.push(name)
    const values = found.flatMap((path) => {
      try {
        return [JSON.parse(readFileSync(path, "utf8"))]
      } catch {
        return []
      }
    })
    files.set(
      `hooks/${name}.json`,
      !found.length
        ? null
        : found.length === 1 || !values.length
          ? readFileSync(found[0]!, "utf8")
          : `${JSON.stringify(unionLists(values), null, 2)}\n`,
    )
  }
  writeRoot(root, files)
  return missing
}

export type Entry = {
  at: string
  author: string
  reason: string
  sha: string
  trailers: [string, string][]
}

const FIELD = "\x1f"
const RECORD = "\x1e"

// The commits of a scope that carry this trailer line exactly (Setting: ui.theme), newest first, an empty one included (a score below 5 changes no file, and a pathspec would hide it): what why reads.
export const extLog = (data: string, scope: string, trailer: [string, string]): Entry[] => {
  const dir = scopeDir(data, scope)
  if (!existsSync(dir)) return []
  const line = `${trailer[0]}: ${trailer[1]}`
  const { code, out } = extGit(dir, [
    "log",
    "--fixed-strings",
    "--grep",
    line,
    `--format=%H${FIELD}%aI${FIELD}%an${FIELD}%B${RECORD}`,
  ])
  if (code !== 0) return []
  return out
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, at, author, body] = record.split(FIELD) as [string, string, string, string]
      const lines = body.trimEnd().split("\n")
      const found: string[] = []
      while (lines.length && /^[A-Za-z-]+: /.test(lines.at(-1)!)) found.unshift(lines.pop()!)
      const trailers = found.map((text): [string, string] => [
        text.slice(0, text.indexOf(": ")),
        text.slice(text.indexOf(": ") + 2),
      ])
      return { entry: { at, author, reason: lines.join("\n").trim(), sha, trailers }, found }
    })
    .filter(({ found }) => found.includes(line))
    .map(({ entry }) => entry)
}
