import {
  appendFileSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"

import { hasManagerRole, placedKindOf } from "@packages/config/kinds"

import { liveHeads, present, type Tip } from "./live-refs"

// The folders a delete starts from, passed in so a test builds them on a mkdtemp root of its own.
export type Roots = { home: string; main: string; trash: string }

// protected and tripwire refusals go to the dispatcher through the ops notify line; refused is a plain no, as is a per-minute cap refusal after its burst's first (firstOfBurst), so a burst alerts once, and a session's own scratch or scratchpad folder over the tripwire, which it leaves in place at its end.
export type Refusal = { kind: "protected" | "refused" | "tripwire"; refused: string }

// A process with a working folder: its command line, and the unix sockets it holds open, read for an agent-browser daemon alone.
export type Proc = { command: string; cwd: string; pid: number; sockets: string[] }

// A running node_modules clone, from run-slot's clone holder record: the session that runs it, its pid, the checkout it copies from and the one it copies into.
export type Clone = { destination: string; pid: number; source: string; who: string }

// What tells a worktree is held: the folder another repo's worktree whose branch gh answers has no PR has its commits no remote holds archived in before it goes (archiveUnlanded), the running clones, the name gh gives another repo's default branch (null when it cannot answer), asked only when origin/HEAD names none, a reader quarantine calls again right before its move, the roster's live statuses, the folders beyond the other worktrees read for links into it (linkPlaces), every process with a working folder (null when they cannot be listed), and the roster's path; whether a merged PR holds a commit (null when that cannot be asked), --discard, which lets uncommitted or unlanded work go, its commits no remote holds bundled first, and the pull request whose session used the worktree, since another session of that PR shares its number and holds it by no more than that, under --discard only once that PR reads MERGED or CLOSED (freed); the worktree's own PR once it reads MERGED or CLOSED (freed, at its head), which no roster row naming its branch or its number holds while the worktree sits at that PR's head, and where a pass past such a row is told (note).
export type Holders = {
  archive?: string
  clones: () => Clone[]
  defaultBranch?: (at: string) => string | null
  discard: boolean
  freed?: { head: string; number: number; state: "CLOSED" | "MERGED" }
  live: string[]
  // The live Dashboard's branch (the live.branch setting): the main checkout's worktree on it is never removed, --discard included.
  liveBranch?: string
  merged: (sha: string, at: string) => boolean | null
  // The head of the PR at a URL a live row names once it reads MERGED, else null (open, closed or unreadable), asked only for a URL whose number matches the worktree and is the row's one hold: a merged PR's hold no longer counts while HEAD holds no commit past that head, as SESSIONS.md's End says, since its worker or checker is only finishing up.
  mergedHead?: (url: string) => string | null
  note?: (line: string) => void
  // The number of the worktree's own pull request, as GitHub names it by the worktree's branch, in any state: a live row listing it holds the worktree whatever the worktree's folder and branch are named.
  ownPr?: number
  places: () => string[]
  pr?: string
  procs: Proc[] | null
  roster: string
}

// An agent-browser process, its daemon or a client, by its command's first word.
export const isAgentBrowser = (command: string): boolean =>
  /^agent-browser(?:-[\w-]+)?$/.test(basename(command.split(" ")[0]!))

export type Quarantined = {
  bundle?: string
  files: number
  id: string
  size: number
  stripFailed?: string
  stripped?: number
  to: string
}

// A worktree's git record, kept in the trash since the prune after its move deletes it: its branch (null when detached), record folder and commit.
export type WorktreeGit = { branch: string | null; gitdir: string; sha: string }

export type TrashEntry = {
  at: string
  approved?: string
  bundle?: string
  carveOut?: string
  ended?: string
  files: number
  git?: WorktreeGit
  id: string
  path: string
  reason: string
  session: string
  size: number
  stripped?: number
}

// The file makeScratch leaves in each folder it makes, which removeScratch requires.
export const MARKER = ".safe-delete-scratch"

export const LIMITS = { bytes: 2 * 1024 ** 3, files: 5000, perMinute: 3 }

export const PURGE = { days: 7, minFree: 50e9 }

// The cap's window, which a burst's recent moves read and a told mark outlives by at most: past it no try can meet the key again, since the key is a stamp that never recurs.
const CAP_WINDOW_MS = 60_000

// One script's exception to the protected list: the entries directly in one exact folder in the data folder (the trash's parent, so it follows PLAYGROUND_DATA_DIR), or in HOME with home set, each at most its files and bytes, with name set only a plain file whose name it matches, and only while that folder is no symlink and sits behind none from its base; the folder itself, its parent, a sibling and anything deeper stay protected.
export type CarveOut = {
  bytes: number
  files: number
  folder: string
  home?: true
  name?: RegExp
}

// The file name of a LaunchAgent that is Playground's own, which the jobs render installs and removes, and no other.
export const PLAYGROUND_AGENT = /^com\.playground\.[\w.-]+\.plist$/

// The file name of a systemd user unit that is Playground's own, the same job's on Linux, which the jobs render installs and removes, and no other.
export const PLAYGROUND_UNIT = /^com\.playground\.[\w.-]+\.service$/

// Each script's carve-outs by the script's name, one entry per folder it removes from, A to Z, which only that script passes as quarantine's carveOut; playground rm takes none.
export const CARVE_OUTS: Record<string, CarveOut> = {
  // scripts/ops/dashboard/supervisor.sh's production builds, one folder per head; one measured 2,251 files and 78 MB on 2 Nov
  "dashboard-supervisor": {
    bytes: 256 * 1024 ** 2,
    files: 4000,
    folder: "ops/dashboard/builds",
  },
  // packages/scripts/src/playground/jobs.ts's rendered LaunchAgent plists, one file each, for a job jobs.json no longer holds
  jobs: { bytes: 64 * 1024, files: 1, folder: "ops/launch-agents" },
  // the same render's installed copies, for a launchd job now turned off: Playground's own plists alone, never another app's agent
  "jobs-installed": {
    bytes: 64 * 1024,
    files: 1,
    folder: "Library/LaunchAgents",
    home: true,
    name: PLAYGROUND_AGENT,
  },
  // the same render's installed units on Linux, for a job now turned off: Playground's own units alone, never another user unit
  "jobs-units": {
    bytes: 64 * 1024,
    files: 1,
    folder: ".config/systemd/user",
    home: true,
    name: PLAYGROUND_UNIT,
  },
  // packages/scripts/src/playground/page.ts's --remove: one kept page's HTML, caption or PDF, each at most 20 MiB, the most a file the Previews app lists holds (MAX_PREVIEW_BYTES), and never pages.jsonl beside them
  page: {
    bytes: 20 * 1024 ** 2,
    files: 1,
    folder: "previews",
    name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:html|pdf|txt)$/,
  },
}

const HOME_DIRS = [".claude", ".config", ".gnupg", ".playground", ".ssh", "Library", "Music"]
const BATCH = /^(\d{8}T\d{6}Z)-([A-Za-z0-9][A-Za-z0-9-]*)$/
const ID = /^(\d{8}T\d{6}Z-[A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]*$/

const lstat = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

// A path with every symlink resolved, the part that does not exist yet kept as written.
const real = (path: string): string => {
  const abs = resolve(path)
  try {
    return realpathSync(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(real(parent), basename(abs))
  }
}

const inside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

const worktreesOf = (roots: Roots): string => join(real(roots.main), ".claude", "worktrees")

// The repo whose .claude/worktrees directly holds a path playground rm --worktree takes: the main checkout for any folder in its own, or another repo when git proves the folder its worktree (its .git file points into that repo's .git/worktrees, and that repo's worktree list names it); else null.
export const worktreeRepo = (path: string, roots: Roots): string | null => {
  const abs = resolve(path)
  const at = join(real(dirname(abs)), basename(abs))
  const folder = dirname(at)
  if (folder === worktreesOf(roots)) return real(roots.main)
  const repo = dirname(dirname(folder))
  if (basename(folder) !== "worktrees" || basename(dirname(folder)) !== ".claude") return null
  if (!lstat(at)?.isDirectory() || !lstat(join(repo, ".git"))?.isDirectory()) return null
  let pointer = ""
  try {
    if (lstat(join(at, ".git"))?.isFile()) pointer = readFileSync(join(at, ".git"), "utf8")
  } catch {}
  const gitdir = /^gitdir: (.+)$/m.exec(pointer)?.[1]
  if (!gitdir || dirname(real(resolve(at, gitdir))) !== join(repo, ".git", "worktrees")) return null
  const list = Bun.spawnSync(["git", "-C", repo, "worktree", "list", "--porcelain"], {
    stderr: "ignore",
    stdout: "pipe",
  })
  const listed = list.stdout
    .toString()
    .split("\n")
    .some((line) => line.startsWith("worktree ") && real(line.slice(9)) === at)
  return list.exitCode === 0 && listed ? repo : null
}

// Whether a path is a worktree playground rm --worktree takes, by worktreeRepo.
export const inWorktrees = (path: string, roots: Roots): boolean =>
  worktreeRepo(path, roots) !== null

// The folders under HOME that are protected whole, and the trash's parent.
const subtreesOf = (home: string, trash: string): string[] => [
  ...HOME_DIRS.map((dir) => real(join(home, dir))),
  dirname(trash),
]

// Why path is or holds a protected root or the trash, or null.
const whyHolds = (path: string, roots: Roots): string | null => {
  const home = real(roots.home)
  const trash = real(roots.trash)
  if (inside(path, trash)) return `${path} is in the trash, which the trash-purge beat empties`
  for (const root of [home, real(roots.main), ...subtreesOf(home, trash)])
    if (inside(root, path))
      return path === root ? `${path} is protected` : `${path} holds the protected ${root}`
  return null
}

// The data folder's two session folders, scratch/<name>/ and scratchpad/<name>/, which every scratch rule below reads as one pair.
const SCRATCH_DIRS = ["scratch", "scratchpad"] as const
type ScratchDir = (typeof SCRATCH_DIRS)[number]

// The caller's own scratch in the data folder: scratch/<session> and scratchpad/<session>, symlinks resolved, path when it is the memory trial's settings file spawn.sh wrote for the session, and path, its parent resolved, when it is a loose file directly in scratch/ named <session>- or <session>. and a regular file or nothing (a restore checks a gone path), while scratch/ is a real folder reached through no symlink from the real HOME; none for a name no session may hold.
const ownScratchOf = (home: string, session: string, path: string): string[] => {
  if (!SESSION.test(session)) return []
  const name = basename(path)
  const stat = lstat(path)
  const scratch = join(home, ".playground", "scratch")
  const loose =
    real(scratch) === scratch &&
    dirname(path) === scratch &&
    (name.startsWith(`${session}-`) || name.startsWith(`${session}.`)) &&
    (!stat || stat.isFile())
  const settings = join(
    real(join(home, ".playground")),
    `factory-settings-400k-memory-${session}.json`,
  )
  return [
    ...SCRATCH_DIRS.map((dir) => real(join(home, ".playground", dir, session))),
    ...(loose ? [path] : []),
    ...(path === settings && (!stat || stat.isFile()) ? [path] : []),
  ]
}

// What tells an ended session's scratch or scratchpad folder: the roster's path and the statuses it counts as live.
export type Ended = { live: string[]; roster: string }

// The folder directly in dir (scratchpad/ or scratch/) that path is or sits in, when it is a real folder (not a symlink) no live roster row names, as its own name or as `<folder>-<role>` (a bare id's folder while any of that id's sessions runs); none while the roster cannot be read.
const endedPadOf = (
  path: string,
  home: string,
  ended: Ended,
  dir: ScratchDir,
): string | undefined => {
  const pad = real(join(home, ".playground", dir))
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  if (own === pad || !inside(own, pad)) return undefined
  const folder = join(pad, own.slice(pad.length + 1).split(sep)[0]!)
  const name = basename(folder)
  if (!SESSION.test(name) || !lstat(folder)?.isDirectory()) return undefined
  let agents: unknown
  try {
    agents = JSON.parse(readFileSync(ended.roster, "utf8")).agents
  } catch {
    return undefined
  }
  if (!Array.isArray(agents)) return undefined
  const live = agents.some(
    (agent) =>
      ended.live.includes(agent?.status) &&
      typeof agent?.name === "string" &&
      (agent.name === name || agent.name.startsWith(`${name}-`)),
  )
  return live ? undefined : folder
}

// The entry directly in scratch/ that path is, a real file or folder (not a symlink), for the nightly clean, which has found its session gone.
const goneScratchOf = (path: string, home: string): string | undefined => {
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  const stat = lstat(own)
  return dirname(own) === real(join(home, ".playground", "scratch")) &&
    (stat?.isFile() || stat?.isDirectory())
    ? own
    : undefined
}

// The top-level data folders a merged PR retired, A to Z, each with that PR: playground rm removes one whole on any machine, through the trash.
const RETIRED: Record<string, string> = {
  ci: "https://github.com/nrjdalal/playground/pull/2567",
}

// A retired folder's own place: directly in the data folder, under a name RETIRED lists; removal and restore both read it.
const retiredPlace = (own: string, home: string): boolean =>
  dirname(own) === real(join(home, ".playground")) && Object.hasOwn(RETIRED, basename(own))

// The retired folder path is, when it is that real folder (not a symlink) at its own place.
const retiredOf = (path: string, home: string): string | undefined => {
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  return retiredPlace(own, home) && lstat(own)?.isDirectory() ? own : undefined
}

// The owner's Remove on an Inbox card for one exact path: the card's id and the bytes it showed, which the path must still hold.
export type Approved = { bytes: number; card: string }

// The bytes a tree holds as the unused list shows them and an approved removal checks them: each real file once, a hard link counted once, a symlink and a folder adding nothing; 0 for a path that is gone.
export const bytesOf = (path: string, seen = new Set<string>()): number => {
  const st = lstat(path)
  if (!st || seen.has(`${st.dev}:${st.ino}`)) return 0
  seen.add(`${st.dev}:${st.ino}`)
  if (!st.isDirectory()) return st.isFile() ? st.size : 0
  return entriesOf(path).reduce((sum, e) => sum + bytesOf(join(path, e.name), seen), 0)
}

// A ship rehearsal's own place: a real rehearse<N> folder in a session's scratchpad folder, scratchpad/<session>/rehearse<N>, which only an approved card removes from outside that session, and a restore puts back.
const rehearsalPlace = (own: string, home: string): boolean =>
  dirname(dirname(own)) === real(join(home, ".playground", "scratchpad")) &&
  SESSION.test(basename(dirname(own))) &&
  /^rehearse\d+$/.test(basename(own))

const rehearsalOf = (path: string, home: string): string | undefined => {
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  return own === abs && rehearsalPlace(own, home) && lstat(own)?.isDirectory() ? own : undefined
}

// Why an approved path is not the one its card names as the owner saw it, or null: a path written relative or with a `..`, a symlink at it or on its way, or a size other than the card's.
const approvedRefusal = (path: string, approved: Approved): string | null => {
  if (!isAbsolute(path) || path.split(sep).includes(".."))
    return `${path} is not written as one absolute path with no ..; card ${approved.card} names its path whole`
  if (lstat(path)?.isSymbolicLink())
    return `${path} is a symlink; card ${approved.card} approves only a real path`
  if (real(path) !== resolve(path))
    return `${path} goes through a symlink to ${real(path)}; card ${approved.card} approves only a real path`
  const now = bytesOf(path)
  return now === approved.bytes
    ? null
    : `${path} holds ${now} bytes, and card ${approved.card} approved it at ${approved.bytes}: its size changed, so it stays; the next card names it at its new size`
}

const whyProtected = (path: string, roots: Roots, ownScratch: string[]): string | null => {
  const held = whyHolds(path, roots)
  if (held) return held
  const main = real(roots.main)
  const subtrees = subtreesOf(real(roots.home), real(roots.trash))
  for (const root of subtrees)
    if (inside(path, root)) {
      if (ownScratch.some((own) => inside(path, own))) return null
      return `${path} is inside the protected ${root}`
    }
  if (inside(path, main) && !path.startsWith(worktreesOf(roots) + sep))
    return `${path} is inside the main checkout ${main}`
  return null
}

// Why a path may not be deleted, or null: checked at the path's own place and at its symlink's target. A session's name exempts its own two scratch folders, its own loose scratch file and its own memory settings file (ownScratchOf), and the paths in `ended`, ended sessions' scratch and scratchpad folders (endedPadOf), gone sessions' entries directly in scratch/ (goneScratchOf) and the retired data folders (retiredOf), and nothing else.
export function isProtected(
  path: string,
  roots: Roots,
  session?: string,
  ended: string[] = [],
): string | null {
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  const scratch = [
    ...(session === undefined ? [] : ownScratchOf(real(roots.home), session, own)),
    ...ended,
  ]
  return whyProtected(own, roots, scratch) ?? whyProtected(real(abs), roots, scratch)
}

// The first symlink on the way from base down a carve-out's folder, a path relative to base.
const linkOn = (base: string, folder: string): string => {
  const parts = folder.split("/")
  for (let i = 1; i <= parts.length; i++) {
    const at = join(base, ...parts.slice(0, i))
    if (lstat(at)?.isSymbolicLink()) return at
  }
  return join(base, folder)
}

// The carve-out named name when path is an entry directly in its folder, real and reached through no symlink from its base, that is not and holds no protected root; else the refusal's text.
const carveOutAt = (
  path: string,
  name: string,
  roots: Roots,
  table: Record<string, CarveOut>,
): CarveOut | string => {
  const carve = Object.hasOwn(table, name) ? table[name]! : undefined
  if (!carve) return `no carve-out is named ${name}`
  const base = real(carve.home ? roots.home : dirname(roots.trash))
  const named = join(base, carve.folder)
  const folder = real(named)
  if (folder !== named)
    return `${named}, the ${name} carve-out's folder, goes through the symlink ${linkOn(base, carve.folder)} and leads to ${folder}, and a carve-out takes only a real folder`
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  if (dirname(own) !== folder || dirname(real(abs)) !== folder)
    return `${abs} is not directly in ${folder}, the ${name} carve-out's folder`
  // a restore checks a path that is gone, so only an entry that stands must be a plain file
  const stat = lstat(own)
  if (carve.name && (!carve.name.test(basename(own)) || (stat && !stat.isFile())))
    return `${abs} is not a file the ${name} carve-out names`
  return whyHolds(own, roots) ?? carve
}

// A protected path's refusal, unless carveOut names a carve-out that lets it through: then that carve-out; null for a path nothing protects.
const carveOutOf = (
  path: string,
  carveOut: string | undefined,
  roots: Roots,
  table: Record<string, CarveOut>,
  session?: string,
  ended: string[] = [],
): CarveOut | Refusal | null => {
  const why = isProtected(path, roots, session, ended)
  if (!why) return null
  const found = carveOut === undefined ? why : carveOutAt(path, carveOut, roots, table)
  return typeof found === "string"
    ? refused(found === why ? why : `${why}; ${found}`, "protected")
    : found
}

// The files and bytes under a path, symlinks not followed; the walk stops once either passes its limit, and a folder skip names, by its path relative to the tree, is neither entered nor counted.
const measure = (
  path: string,
  io: {
    limits?: { bytes: number; files: number }
    skip?: (rel: string, name: string) => boolean
  } = {},
) => {
  const limits = io.limits ?? { bytes: Infinity, files: Infinity }
  let files = 0
  let size = 0
  const stack: [string, string][] = [[path, ""]]
  while (stack.length && files <= limits.files && size <= limits.bytes) {
    const [at, rel] = stack.pop()!
    const info = lstatSync(at)
    if (info.isDirectory())
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const next = rel ? join(rel, entry.name) : entry.name
        if (entry.isDirectory() && io.skip?.(next, entry.name)) continue
        stack.push([join(at, entry.name), next])
      }
    else {
      files++
      size += info.size
    }
  }
  return { files, size }
}

const stamp = (at: Date): string => at.toISOString().replace(/[-:]|\.\d{3}/g, "")

const stampMs = (text: string): number =>
  Date.parse(text.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"))

const batches = (trash: string): string[] => {
  try {
    return readdirSync(trash)
      .filter((name) => BATCH.test(name))
      .sort()
  } catch {
    return []
  }
}

const manifestOf = (trash: string, batch: string): TrashEntry[] => {
  try {
    return readFileSync(join(trash, batch, "manifest.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TrashEntry)
  } catch {
    return []
  }
}

const recentMoves = (trash: string, session: string, now: Date): TrashEntry[] => {
  const since = now.getTime() - CAP_WINDOW_MS
  return batches(trash)
    .filter(
      (batch) =>
        BATCH.exec(batch)![2] === session && stampMs(BATCH.exec(batch)![1]!) > since - 1000,
    )
    .flatMap((batch) => manifestOf(trash, batch))
    .filter((entry) => Date.parse(entry.at) > since)
}

// How many more moves a session may make before the per-minute cap refuses one, so a caller with several moves to make can refuse before its first; read-only.
export const movesLeft = (trash: string, session: string, now = new Date()): number =>
  Math.max(0, LIMITS.perMinute - recentMoves(trash, session, now).length)

// Whether a cap refusal is its burst's first, so it alerts once: the told mark is a file named for the burst's key, made with wx, so of two tries at one instant the first alone creates it and alerts, and a later try inside the burst, whose key is already told, is a plain refusal. A mark of the old shape, a content file at the session's own path, is cleared at the session's first burst, the removal for that case alone, so a concurrent try's fresh folder stands; the design's history is in the PG-1733 commits.
const firstOfBurst = (trash: string, session: string, recent: TrashEntry[]): boolean => {
  const key =
    recent
      .map((entry) => entry.at)
      .sort()
      .at(-1) ?? ""
  const told = join(trash, ".cap-told", session, key)
  let code = ""
  try {
    writeFileSync(told, "", { flag: "wx" })
    return true
  } catch (err) {
    code = (err as { code?: string }).code ?? ""
  }
  if (code === "EEXIST") return false
  if (code !== "ENOENT" && code !== "ENOTDIR") return true
  if (code === "ENOTDIR") {
    try {
      rmSync(join(trash, ".cap-told", session), { force: true })
    } catch {}
  }
  try {
    mkdirSync(join(trash, ".cap-told", session), { recursive: true })
  } catch {
    return true
  }
  try {
    writeFileSync(told, "", { flag: "wx" })
    return true
  } catch (err) {
    return (err as { code?: string }).code !== "EEXIST"
  }
}

const otherVolume = (path: string, trash: string) =>
  `${path} is on another volume than the trash ${trash}, so a move would copy it`

const refused = (text: string, kind: Refusal["kind"] = "refused"): Refusal => ({
  kind,
  refused: text,
})

// The session's own temp folder spawn.sh made it on Linux, tmp/playground-<session>.<suffix>, a real folder directly in tmp, which its end moves whole under the byte cap alone, since a session's hook test data fills it past the file count.
const ownTempOf = (own: string, session: string, tmp: string): boolean =>
  dirname(own) === real(tmp) &&
  basename(own).startsWith(`playground-${session}.`) &&
  !!lstat(own)?.isDirectory()

// Renames a path into <trash>/<UTC-ts>-<session>/<n>/ with a manifest line, after the protected list, worktreeRefusal for a worktree (which only the worktree option's holders move), the tripwire, the volume check and, for a worktree, the running clones read again, since the walk that counts its files takes seconds and a clone can start inside it; a worktree --discard lets go has its commits no remote holds bundled beside it in that batch first (bundleUnpushed).
export function quarantine(
  path: string,
  opts: {
    approved?: Approved
    carveOut?: string
    ended?: Ended
    gone?: true
    git?: WorktreeGit
    reason: string
    session: string
    worktree?: Holders
  },
  roots: Roots,
  io: {
    carveOuts?: Record<string, CarveOut>
    dev?: (path: string) => number
    now?: Date
    tmp?: string
  } = {},
): Quarantined | Refusal {
  const abs = resolve(path)
  if (!SESSION.test(opts.session))
    return refused(`the session name ${opts.session} is not a word of letters, digits and hyphens`)
  if (!lstat(abs)) return refused(`no such path ${abs}`)
  const wrong = opts.approved && approvedRefusal(path, opts.approved)
  if (wrong) return refused(wrong)
  const rehearsal = opts.approved && rehearsalOf(abs, roots.home)
  const live = opts.ended
  const ended =
    (live && SCRATCH_DIRS.map((dir) => endedPadOf(abs, roots.home, live, dir)).find(Boolean)) ||
    (opts.gone && goneScratchOf(abs, roots.home)) ||
    retiredOf(abs, roots.home)
  const carve = carveOutOf(abs, opts.carveOut, roots, io.carveOuts ?? CARVE_OUTS, opts.session, [
    ...(ended ? [ended] : []),
    ...(rehearsal ? [rehearsal] : []),
  ])
  if (carve && "refused" in carve) return carve
  const isWorktree = inWorktrees(abs, roots)
  if (isWorktree && !opts.worktree)
    return refused(`${abs} is a worktree: playground rm --worktree removes it`)
  if (!isWorktree && opts.worktree)
    return refused(
      `--worktree takes a folder in ${worktreesOf(roots)} or a git worktree in another repo's .claude/worktrees, not ${abs}: playground rm ${abs} moves a folder outside it to the trash, with no --worktree or --discard, up to ${LIMITS.files.toLocaleString("en-US")} files or ${LIMITS.bytes / 1024 ** 3} GB; leave a bigger tree in place for your lead's cleanup`,
    )
  const held = opts.worktree && worktreeRefusal(abs, roots, opts.worktree)
  if (held) return refused(held)
  const now = io.now ?? new Date()
  const trash = real(roots.trash)
  const recent = recentMoves(trash, opts.session, now)
  if (recent.length >= LIMITS.perMinute)
    return refused(
      `refused a ${recent.length + 1}th removal: ${opts.session} moved ${recent.length} paths in the last minute, the most one session may`,
      firstOfBurst(trash, opts.session, recent) ? "tripwire" : "refused",
    )
  // The measure skips the tree's rebuildable folders, so the tripwire judges what the trash will hold and a refused rm keeps its tree whole; the strip runs on the moved tree, once every refusal is past. A carve-out's move keeps its tree whole, and an ended session's whole scratch or scratchpad folder, the session's own temp folder, a path inside the session's own scratchpad folder (a ship rehearsal's two clones), a retired data folder, or with gone a gone session's entry directly in scratch/, skips the file count, keeping the byte cap.
  const own = join(real(dirname(abs)), basename(abs))
  const temp = ownTempOf(own, opts.session, io.tmp ?? "/tmp")
  const ownPad = join(real(join(roots.home, ".playground", "scratchpad")), opts.session)
  const whole = (ended && own === ended) || temp || (own !== ownPad && inside(own, ownPad))
  // an approved path moves whole, its size already checked against the card's
  const cap =
    carve ??
    (opts.approved
      ? { ...LIMITS, bytes: Infinity, files: Infinity }
      : whole
        ? { ...LIMITS, files: Infinity }
        : LIMITS)
  const { files, size } = measure(abs, {
    limits: opts.worktree ? undefined : cap,
    skip: carve ? undefined : isRebuildable,
  })
  // A session's own folder over the tripwire is a plain no, matched at its own place and never at a symlink's target, so every other path keeps the alert.
  if (!opts.worktree && (files > cap.files || size > cap.bytes))
    return temp
      ? refused(
          `${abs} holds over ${LIMITS.bytes / 1024 ** 3} GB, past the tripwire: it stays in place`,
        )
      : SCRATCH_DIRS.some(
            (dir) => own === join(real(join(roots.home, ".playground", dir)), opts.session),
          )
        ? refused(
            `${abs} holds over ${LIMITS.files} files or ${LIMITS.bytes / 1024 ** 3} GB, past the tripwire: leave it in place whole, never split, for the nightly clean (scratch/) or your lead's cleanup (scratchpad/)`,
          )
        : refused(
            carve
              ? `${abs} holds over ${cap.files} files or ${cap.bytes} bytes, past the ${opts.carveOut} carve-out's cap`
              : `${abs} holds over ${whole ? "" : `${LIMITS.files} files or `}${LIMITS.bytes / 1024 ** 3} GB, past the tripwire`,
            "tripwire",
          )
  mkdirSync(trash, { recursive: true })
  const dev = io.dev ?? ((p: string) => lstatSync(p).dev)
  if (dev(abs) !== dev(trash)) return refused(otherVolume(abs, trash))
  const cloned = opts.worktree && cloneHolder(real(abs), opts.worktree.clones())
  if (cloned) return refused(cloned)
  const kept = opts.worktree?.discard ? bundleUnpushed(abs, trash, opts.session, now) : {}
  if ("refused" in kept) return refused(kept.refused)
  const batch = `${stamp(now)}-${opts.session}`
  mkdirSync(join(trash, batch), { recursive: true })
  let n = 1
  while (existsSync(join(trash, batch, String(n)))) n++
  const slot = join(trash, batch, String(n))
  mkdirSync(slot)
  const to = join(slot, basename(abs))
  try {
    renameSync(abs, to)
  } catch (error) {
    rmdirSync(slot)
    const code = (error as NodeJS.ErrnoException).code
    return refused(
      code === "EXDEV"
        ? otherVolume(abs, trash)
        : `${abs} did not move: ${code ?? (error as Error).message}`,
    )
  }
  // The tree's rebuildable folders go once the move is past every refusal, and the strip never throws past this line: a strip that stops partway names its error and leaves the entry unmarked, so the hourly strip's pass reaches the item and takes the rest. An install or a build puts what it removed back.
  let stripped: string[] = []
  let stripFailed: string | null = null
  if (!carve) {
    try {
      stripped = stripRebuildable(to)
    } catch (error) {
      stripFailed = (error as Error).message
    }
  }
  const id = `${batch}/${n}`
  const entry: TrashEntry = {
    at: now.toISOString(),
    ...(opts.approved ? { approved: opts.approved.card } : {}),
    ...kept,
    ...(carve ? { carveOut: opts.carveOut } : {}),
    ...(ended ? { ended } : {}),
    files,
    ...(opts.git ? { git: opts.git } : {}),
    id,
    path: abs,
    reason: opts.reason,
    session: opts.session,
    size,
    ...(stripped.length ? { stripped: stripped.length } : {}),
  }
  appendFileSync(join(trash, batch, "manifest.jsonl"), `${JSON.stringify(entry)}\n`)
  return {
    ...kept,
    files,
    id,
    size,
    ...(stripFailed ? { stripFailed } : {}),
    ...(stripped.length ? { stripped: stripped.length } : {}),
    to,
  }
}

// Every item still in the trash, oldest first.
export function listTrash(trash: string): TrashEntry[] {
  return batches(trash)
    .flatMap((batch) => manifestOf(trash, batch))
    .filter((entry) => existsSync(join(trash, entry.id)))
}

// Moves a trash item back to the path it came from, refusing a protected path (but for an item its carve-out let through, back into that carve-out's folder), one anything stands at, and one whose folder is gone.
export function restore(
  id: string,
  roots: Roots,
  carveOuts: Record<string, CarveOut> = CARVE_OUTS,
): { path: string } | Refusal {
  const trash = roots.trash
  const match = ID.exec(id)
  if (!match) return refused(`${id} is not a trash id; playground rm --list prints them`)
  const entry = manifestOf(trash, match[1]!).find((line) => line.id === id)
  const slot = join(trash, id)
  const items = existsSync(slot) ? readdirSync(slot) : []
  if (!entry || items.length !== 1) return refused(`no trash item ${id}`)
  // an ended session's item comes back only into its folder directly in scratchpad/ or scratch/, a gone session's entry directly in scratch/ or a retired data folder back to its own place, reached through no symlink (at the folder or between), and is refused anywhere else
  let back: string[] = []
  if (entry.ended) {
    const pads = SCRATCH_DIRS.map((dir) => real(join(roots.home, ".playground", dir)))
    const parent = dirname(entry.path)
    const at = existsSync(parent) ? join(real(parent), basename(entry.path)) : entry.path
    const stands = lstat(entry.ended)
    if (retiredPlace(entry.ended, roots.home)) {
      if (at !== entry.ended)
        return refused(
          `${entry.path} came from ${entry.ended}, a retired data folder, which no longer reaches it as that real folder directly in ${real(join(roots.home, ".playground"))}`,
        )
    } else if (
      !pads.includes(dirname(entry.ended)) ||
      !inside(at, entry.ended) ||
      (at !== entry.ended && stands && !stands.isDirectory())
    )
      return refused(
        `${entry.path} came from ${entry.ended}, an ended session's folder or a gone session's entry, which no longer reaches it as a real entry directly in ${pads.join(" or ")}`,
      )
    back = [entry.ended]
  } else if (entry.approved && rehearsalPlace(entry.path, roots.home)) {
    // an approved rehearsal comes back only to its own place, reached through no symlink
    if (!existsSync(dirname(entry.path)) || real(dirname(entry.path)) !== dirname(entry.path))
      return refused(
        `${entry.path} came from a rehearsal folder card ${entry.approved} approved, which no longer reaches it as a real folder`,
      )
    back = [entry.path]
  }
  const carve = carveOutOf(entry.path, entry.carveOut, roots, carveOuts, entry.session, back)
  if (carve && "refused" in carve) return carve
  if (lstat(entry.path)) return refused(`${entry.path} already exists; move it aside first`)
  if (!existsSync(dirname(entry.path)))
    return refused(`${dirname(entry.path)}, the folder ${id} came from, is gone`)
  renameSync(join(slot, items[0]!), entry.path)
  rmdirSync(slot)
  return { path: entry.path }
}

const WEIGHT_FILE = /\.(gguf|safetensors)$/

// Whether path is model weights an approved card deletes outright (rm.ts reads it to pick deleteWeights, which checks it again as its own guard), since they download again: a .gguf or .safetensors file under ~/models or a recorded weights folder, or a repo folder directly in ~/models/hf/hub; ~/models and each folder itself never.
export const isWeights = (path: string, home: string, folders: string[]): boolean => {
  const abs = resolve(path)
  const models = join(home, "models")
  const st = lstat(abs)
  if (!st) return false
  if (st.isDirectory())
    return dirname(abs) === join(models, "hf", "hub") && basename(abs).startsWith("models--")
  return (
    st.isFile() &&
    WEIGHT_FILE.test(abs) &&
    [models, ...folders].some((root) => abs !== root && inside(abs, root))
  )
}

// Deletes approved weights outright, never through the trash (a model's weights download again, and one repo can outgrow the trash's disk), after approvedRefusal, the protected list and isWeights, with one line in <trash>/deleted.jsonl naming the card.
export function deleteWeights(
  path: string,
  opts: { approved: Approved; folders: string[]; reason: string; session: string },
  roots: Roots,
  now = new Date(),
): { size: number } | Refusal {
  if (!lstat(path)) return refused(`no such path ${path}`)
  const wrong = approvedRefusal(path, opts.approved)
  if (wrong) return refused(wrong)
  const why = isProtected(path, roots)
  if (why) return refused(why, "protected")
  if (!isWeights(path, roots.home, opts.folders))
    return refused(
      `${path} is not model weights: a .gguf or .safetensors file under ${join(roots.home, "models")} or a recorded folder, or a repo folder directly in its hf/hub; a card's other items move to the trash`,
    )
  try {
    rmSync(path, { recursive: true })
  } catch (error) {
    return refused(`${path} did not delete whole: ${(error as Error).message}`)
  }
  const trash = real(roots.trash)
  mkdirSync(trash, { recursive: true })
  appendFileSync(
    join(trash, "deleted.jsonl"),
    `${JSON.stringify({ at: now.toISOString(), bytes: opts.approved.bytes, card: opts.approved.card, path, reason: opts.reason, session: opts.session })}\n`,
  )
  return { size: opts.approved.bytes }
}

// Whether path is a model test's replay worktree place: a folder in a row of ~/models/kit/runs, or one inside a recorded folder.
export const replayPlace = (path: string, home: string, folders: string[]): boolean => {
  const abs = resolve(path)
  const runs = join(home, "models", "kit", "runs")
  return (
    (dirname(dirname(abs)) === runs && abs.startsWith(runs + sep)) ||
    folders.some((root) => abs !== root && inside(abs, root))
  )
}

// Removes a model test's replay worktree through its own clone's git worktree remove --force, never a plain delete, after it writes the worktree's work beside it as <name>.diff (git diff HEAD with the untracked files), so no graded attempt is lost: only a real folder at replayPlace that is a worktree of the main checkout, detached at a commit origin/canary holds, with no process working in it, and outside ~/models/kit/runs one with no tracked edit, since under kit/runs every change is the test's output.
export function removeReplay(
  path: string,
  opts: { folders: string[]; procs: Proc[] | null },
  roots: Roots,
): { diff: string } | Refusal {
  const abs = resolve(path)
  const st = lstat(abs)
  if (!st?.isDirectory()) return refused(`no such folder ${abs}`)
  if (real(abs) !== abs) return refused(`${abs} goes through a symlink to ${real(abs)}`)
  if (!replayPlace(abs, roots.home, opts.folders))
    return refused(
      `${abs} is not a replay worktree's place: a folder in a row of ${join(roots.home, "models", "kit", "runs")} or inside a recorded folder`,
    )
  const git = (at: string, ...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", at, ...args], { stderr: "pipe", stdout: "pipe" })
    return { ok: run.exitCode === 0, out: run.stdout.toString().trim() }
  }
  const main = real(roots.main)
  const common = git(abs, "rev-parse", "--path-format=absolute", "--git-common-dir")
  if (
    !common.ok ||
    common.out !== join(main, ".git") ||
    git(abs, "rev-parse", "--show-toplevel").out !== abs
  )
    return refused(`${abs} is not a worktree of ${main}`)
  if (git(abs, "symbolic-ref", "-q", "HEAD").ok)
    return refused(`${abs} is on a branch; a replay worktree is detached at its commit`)
  const sha = git(abs, "rev-parse", "HEAD").out
  if (!git(main, "merge-base", "--is-ancestor", sha, "origin/canary").ok)
    return refused(`${abs} is at ${sha}, a commit origin/canary does not hold`)
  // a model test still running in it holds it, as a process holds any other worktree
  const working = procHolder(abs, opts.procs)
  if (working) return refused(working)
  const underRuns = inside(abs, join(roots.home, "models", "kit", "runs"))
  if (!underRuns && !git(abs, "diff", "HEAD", "--quiet").ok)
    return refused(
      `${abs} has a tracked edit and sits outside ~/models/kit/runs, where a change is the test's output alone`,
    )
  const diff = `${abs}.diff`
  if (lstat(diff)) return refused(`${diff} already exists; move it aside first`)
  // intent-to-add puts the untracked files in git diff HEAD, the index it writes going with the worktree; an ignored path is left out and goes with it, while the row's grade files sit beside the worktree, outside it
  if (!git(abs, "add", "-A", "--intent-to-add").ok) return refused(`git add -N failed in ${abs}`)
  const work = Bun.spawnSync(["git", "-C", abs, "diff", "HEAD", "--binary"], {
    stderr: "pipe",
    stdout: "pipe",
  })
  if (work.exitCode !== 0) return refused(`git diff HEAD failed in ${abs}`)
  writeFileSync(diff, work.stdout)
  const gone = Bun.spawnSync(["git", "-C", main, "worktree", "remove", "--force", abs], {
    stderr: "pipe",
  })
  if (gone.exitCode !== 0)
    return refused(
      `git worktree remove failed: ${gone.stderr.toString().trim()}; its work is kept in ${diff}`,
    )
  return { diff }
}

// The running clone that reads from or copies into a worktree, as its refusal, or null; a clone's cp only reads its source and works in whatever folder run-slot was called from, so no working folder need name either end (PG-699).
const cloneHolder = (at: string, clones: Clone[]): string | null => {
  const clone = clones.find((c) => inside(real(c.source), at) || inside(real(c.destination), at))
  return clone
    ? `${at} is held by ${clone.who}'s node_modules clone (pid ${clone.pid}) from ${clone.source} into ${clone.destination}`
    : null
}

// A folder's entries, or none when it cannot be read.
const entriesOf = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// The folders directly in a folder, or none when it cannot be read.
const dirsIn = (dir: string): string[] =>
  entriesOf(dir)
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))

// The folders worktreeRefusal reads for links beyond the other worktrees: each makeScratch folder directly in a temp folder, and each session's scratchpad (<scratchpads>/<project>/<session>/scratchpad) with each folder directly in it, where a scratch copy sits.
export function linkPlaces(
  tmps = [tmpdir(), "/tmp"],
  scratchpads = join("/tmp", `claude-${process.getuid?.() ?? 0}`),
): string[] {
  const marked = [...new Set(tmps.map(real))].flatMap((tmp) =>
    dirsIn(tmp).filter((dir) => lstat(join(dir, MARKER))?.isFile()),
  )
  const pads = dirsIn(scratchpads)
    .flatMap(dirsIn)
    .map((session) => join(session, "scratchpad"))
    .filter((pad) => lstat(pad)?.isDirectory())
  return [...marked, ...pads.flatMap((pad) => [pad, ...dirsIn(pad)])]
}

// The links outside a worktree that point into it, as its refusal naming the first three, or null: the entries of each other worktree, of the main checkout and of the worktree's own repo, and each place, and of its node_modules one level deep, as a node_modules clone makes them; a link whose target is missing or lies outside the worktree does not count.
const linkHolder = (at: string, roots: Roots, places: string[]): string | null => {
  const links: string[] = []
  const siblings = [...dirsIn(worktreesOf(roots)), ...dirsIn(dirname(at))]
  for (const folder of new Set([...siblings, ...places].map(real))) {
    if (inside(folder, at)) continue
    const modules = join(folder, "node_modules")
    const dirs = lstat(modules)?.isDirectory() ? [folder, modules] : [folder]
    for (const dir of dirs)
      for (const entry of entriesOf(dir)) {
        if (!entry.isSymbolicLink()) continue
        const link = join(dir, entry.name)
        let target: string
        try {
          target = realpathSync(link)
        } catch {
          continue
        }
        if (inside(target, at)) links.push(`${link} -> ${target}`)
      }
  }
  if (!links.length) return null
  const more = links.length > 3 ? `, and ${links.length - 3} more` : ""
  return `${at} is linked into by ${links.sort().slice(0, 3).join(", ")}${more}: repoint or remove each link first`
}

// The pull request URLs a roster row serves: its pr and every /pull/<n> entry of its prs, once each, leaving out an issue's URL and an extension item.
export const rowPullRequests = (row: { pr?: unknown; prs?: unknown }): string[] => [
  ...new Set(
    [row.pr, ...(Array.isArray(row.prs) ? row.prs : [])].filter(
      (u): u is string => typeof u === "string" && /\/pull\/\d+$/.test(u),
    ),
  ),
]

// The process working inside at, as its refusal, an agent-browser one first with the close that frees it; a list that cannot be read keeps at too.
const procHolder = (at: string, procs: Proc[] | null): string | null => {
  if (procs === null) return `the processes' folders cannot be listed, so ${at} stays`
  const held = procs.filter((p) => inside(real(p.cwd), at))
  const holder = held.find((p) => isAgentBrowser(p.command)) ?? held[0]
  if (!holder) return null
  const command =
    holder.command.length > 120 ? `${holder.command.slice(0, 117)}...` : holder.command
  const by = `${at} is held by pid ${holder.pid} (${command}) working in ${holder.cwd}`
  if (!isAgentBrowser(holder.command)) return by
  const session =
    /(?:^| )--session[= ](\S+)/.exec(holder.command)?.[1] ??
    holder.sockets.map((s) => /([^/]+)\.sock$/.exec(s)?.[1]).find(Boolean)
  // a bare daemon names its session nowhere, and sessions are machine-wide, so a guessed name could close another agent's browser
  if (!session)
    return `${by}: an agent-browser session whose name it does not show, so close your own by its name: agent-browser --session <your-name> close`
  return `${by}: agent-browser session ${session}, which agent-browser --session ${session} close frees`
}

// Why a worktree may not be removed, or null: worktreeRepo takes it, the roster reads, no live session (but a live row holds no more a worktree sitting clean, detached, at a commit its base, origin/canary or another repo's default branch, holds), running clone, link from outside it or process holds it, and, unless --discard, it holds no uncommitted change and its HEAD's work is on origin/canary, or, for another repo's worktree, on that repo's default branch (defaultBase), or, for either, on a branch the remote itself holds now (remoteHolding), or, for another repo's worktree given an archive folder, archiveUnlanded has archived, with every remote read, each of its commits no remote holds.
export function worktreeRefusal(path: string, roots: Roots, holders: Holders): string | null {
  const at = real(path)
  const repo = worktreeRepo(at, roots)
  if (repo === null)
    return `${at} is not a worktree in ${worktreesOf(roots)} or a git worktree in another repo's .claude/worktrees`
  let agents: ({
    branch?: unknown
    kind?: unknown
    name?: unknown
    pr?: unknown
    prs?: unknown
    status?: unknown
  } | null)[]
  try {
    agents = JSON.parse(readFileSync(holders.roster, "utf8")).agents
    if (!Array.isArray(agents)) throw new Error("no agents")
  } catch {
    return `the roster ${holders.roster} cannot be read, so no worktree is removed`
  }
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", at, ...args], { stderr: "pipe", stdout: "pipe" })
    return { ok: run.exitCode === 0, out: run.stdout.toString().trimEnd() }
  }
  const top = git("rev-parse", "--show-toplevel")
  if (!top.ok || real(top.out) !== at) return `${at} is not a git worktree`
  const branch = git("symbolic-ref", "--quiet", "--short", "HEAD").out
  const head = git("rev-parse", "HEAD").out
  const own = repo === real(roots.main)
  if (own && holders.liveBranch && branch === holders.liveBranch)
    return `${at} is the live Dashboard's checkout (branch ${branch}); it moves only by .agents/dashboard/live.md's roll`
  const baseOf = () => (own ? "origin/canary" : defaultBase(git, holders, at))
  const folder = basename(at).toLowerCase()
  const where = `${folder} ${branch.toLowerCase()}`
  // Each name's slug, after its PG-<n>- prefix: lint holds PG-12-lint-job, not PG-5-splint.
  const slugs = [folder, branch.toLowerCase()].map((n) => n.replace(/^pg-\d+-/, ""))
  const heads = new Map<string, string | null>()
  // Whether the merged PR at url holds all of HEAD, read once per URL: HEAD is its head or behind it, so no commit past it goes; an unreadable or open PR, or a head this clone lacks, reads false
  const atMergedHead = (url: string) => {
    if (!heads.has(url)) heads.set(url, holders.mergedHead?.(url) ?? null)
    const merged = heads.get(url)
    return !!merged && git("merge-base", "--is-ancestor", "HEAD", merged).ok
  }
  for (const agent of agents) {
    if (!agent || !holders.live.includes(String(agent.status)) || typeof agent.name !== "string")
      continue
    const name = agent.name.toLowerCase()
    // a manager seat names the work it routes, never a worktree, so its name alone holds none; its branch and PR still do
    const kind = placedKindOf(agent.name, agent.kind)
    const seat = kind !== null && hasManagerRole(kind)
    const byName = !seat && slugs.some((s) => s === name || s.startsWith(`${name}-`))
    const id = name.split("-")[0]!
    const byId = /\d/.test(id) && where.includes(id)
    const byBranch =
      typeof agent.branch === "string" && agent.branch.toLowerCase() === branch.toLowerCase()
    // a row holds by its pr and every PR in its prs, each matched by its number in the folder or branch name or as the worktree's own PR (ownPr), but, where those PRs are its one hold, not by another PR that reads merged with HEAD at or behind its head (mergedHead), so commits past it keep the hold, the worktree's own freed PR left to the freed check below; --pr lifts its own PR's hold, but under --discard only once that PR reads MERGED or CLOSED, so a live checker's clone of an open PR stays
    const liftable = !holders.discard || holders.freed !== undefined
    const matched = rowPullRequests(agent)
      .filter((u) => !(liftable && u === holders.pr))
      .flatMap((u) => {
        const n = /\/pull\/(\d+)$/.exec(u)?.[1]
        return n ? [{ n, u }] : []
      })
      .filter(
        ({ n }) => n === String(holders.ownPr) || new RegExp(`(^|\\D)${n}(\\D|$)`).test(where),
      )
    const byPrAlone = !byBranch && !byName && !byId
    const prs = (
      byPrAlone
        ? matched.filter(({ n, u }) => n === String(holders.freed?.number) || !atMergedHead(u))
        : matched
    ).map(({ n }) => n)
    const byPr = prs.length > 0
    if (!byBranch && !byPr && !byName && !byId) continue
    // a clean detached checkout at a commit its base holds (origin/canary, or another repo's default branch) is a reader of that base, not the row's work, so a live row holds it no more
    const base =
      !branch.length && !git("status", "--porcelain", "--untracked-files=all").out && baseOf()
    if (base && git("merge-base", "--is-ancestor", "HEAD", base).ok) {
      holders.note?.(
        `${at} sits clean, detached, at a commit ${base} holds, so ${agent.name}'s roster row (${agent.status}) holds it no more`,
      )
      continue
    }
    // a finished PR frees its worktree from a row that names it by its branch or by that PR's own number alone, so a row naming another PR, or the session by name or id, still holds it; commits past the freed PR's head keep the hold, named with them, so --discard cannot take unmerged work
    const freed = holders.freed
    const ownRow =
      !byName && !byId && prs.every((n) => freed !== undefined && n === String(freed.number))
    if (freed && ownRow && freed.head === head) {
      holders.note?.(
        `${at} is freed by #${freed.number}, which reads ${freed.state}, past ${agent.name}'s roster row (${agent.status})`,
      )
      continue
    }
    if (freed && ownRow) {
      const past = git("log", "--format=%h", `${freed.head}..HEAD`)
      const shas = past.ok ? past.out.split("\n").filter(Boolean).slice(0, 5) : []
      const named = shas.length ? `: ${shas.join(", ")}` : ""
      return `${at} is held by ${agent.name}, which the roster lists as ${agent.status}, and its commits past merged PR #${freed.number}'s head stay${named}`
    }
    return `${at} is held by ${agent.name}, which the roster lists as ${agent.status}`
  }
  const cloned = cloneHolder(at, holders.clones())
  if (cloned) return cloned
  const linked = linkHolder(at, roots, holders.places())
  if (linked) return linked
  const working = procHolder(at, holders.procs)
  if (working) return working
  if (holders.discard) return null
  const discard = `playground rm --worktree ${at} --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash`
  const changed = git("status", "--porcelain", "-z", "--no-renames", "--untracked-files=all")
    .out.split("\0")
    .filter(Boolean)
  if (changed.length) {
    const paths = changed.slice(0, 3).map((line) => line.slice(3))
    const more = changed.length > 3 ? `, and ${changed.length - 3} more` : ""
    return `${at} holds ${changed.length} uncommitted change${changed.length === 1 ? "" : "s"} (${paths.join(", ")}${more}): ${discard}`
  }
  const base = baseOf()
  if (landed(git, holders, at, base)) return null
  const holding = remoteHolding(git, at)
  if (holding) {
    holders.note?.(
      `${at}'s commits are all on ${holding}, which the remote still holds, so no work is lost`,
    )
    return null
  }
  const archived =
    holders.archive !== undefined && !own ? archiveUnlanded(at, holders.archive) : undefined
  if (archived && !("refused" in archived)) {
    holders.note?.(
      `archived ${counted(archived.count, "commit", "commits")} no remote holds at ${archived.path}`,
    )
    return null
  }
  const measured = `${base ?? "its repo's default branch, which neither origin/HEAD nor gh names,"} or on any remote branch (fetch origin if it merged or was pushed since)`
  return `${at}'s HEAD holds work not landed on ${measured}${archived ? `, and ${archived.refused}` : ""}: ${discard}`
}

// The ref another repo's worktree is measured against: origin/HEAD's branch, else origin/<the branch gh names as the repo's default>, else null.
const defaultBase = (
  git: (...args: string[]) => { ok: boolean; out: string },
  holders: Holders,
  at: string,
): string | null => {
  const head = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
  if (head.ok && head.out) return head.out
  const name = holders.defaultBranch?.(at)
  return name ? `origin/${name}` : null
}

// The remote branch that holds HEAD, and so every commit HEAD holds, as <remote>/<branch>, or null: once unpushed lists no commit, the first live tip it reads that is HEAD or has HEAD as an ancestor.
const remoteHolding = (
  git: (...args: string[]) => { ok: boolean; out: string },
  at: string,
): string | null => {
  const ahead = unpushed(at)
  if (!ahead || ahead.shas.length) return null
  return ahead.tips.find((t) => git("merge-base", "--is-ancestor", "HEAD", t.sha).ok)?.ref ?? null
}

// The commits HEAD holds that no remote holds now, past each branch tip ls-remote reads from each remote itself (liveHeads, live-refs.ts); tips names those this repo has, as <remote>/<branch> at its sha, and unread each remote ls-remote could not read in 30 s, which holds none. Null when the commits cannot be read.
export function unpushed(at: string): { shas: string[]; tips: Tip[]; unread: string[] } | null {
  const git = (args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", at, ...args], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
    })
    return { ok: run.exitCode === 0, out: run.stdout.toString() }
  }
  const remotes = git(["remote"])
  if (!remotes.ok) return null
  const listed: Tip[] = []
  const unread: string[] = []
  for (const remote of remotes.out.split("\n").filter(Boolean)) {
    const live = liveHeads(at, remote, 30_000)
    if (live) listed.push(...live)
    else unread.push(remote)
  }
  const tips = present(at, listed)
  if (!tips) return null
  const past = git(["rev-list", "HEAD", "--not", ...tips.map((t) => t.sha)])
  if (!past.ok) return null
  return { shas: past.out.split("\n").filter(Boolean), tips, unread }
}

// Writes each ref's commits past exclude (git rev-list words, such as origin/canary or the live tips unpushed reads) by git bundle create in repo into <trash>/<UTC-ts>-<session>/<name>.bundle, beside <name>.shas with a "<sha> <ref>" line each, then reads the bundle's heads back: its path and the refs it holds at their sha, or why none was written. The trash purge takes both with their batch.
export function bundleToTrash(
  repo: string,
  refs: { ref: string; sha: string }[],
  exclude: string[],
  at: { name: string; now: Date; session: string; trash: string },
): { held: string[]; path: string } | { refused: string } {
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "pipe", stdout: "pipe" })
    return { err: run.stderr.toString().trim(), ok: run.exitCode === 0, out: run.stdout.toString() }
  }
  const batch = join(at.trash, `${stamp(at.now)}-${at.session}`)
  const path = join(batch, `${at.name}.bundle`)
  if (!SESSION.test(at.session) || existsSync(path))
    return { refused: `its bundle ${path} is taken or not a trash path` }
  try {
    mkdirSync(batch, { recursive: true })
  } catch (error) {
    return {
      refused: `its bundle's folder ${batch} could not be made: ${(error as Error).message}`,
    }
  }
  const made = git("bundle", "create", "-q", path, ...refs.map((r) => r.ref), "--not", ...exclude)
  if (!made.ok) return { refused: `git bundle create failed: ${made.err.split("\n").at(-1)}` }
  writeFileSync(join(batch, `${at.name}.shas`), refs.map((r) => `${r.sha} ${r.ref}\n`).join(""))
  const heads = new Set(git("bundle", "list-heads", path).out.split("\n"))
  return { held: refs.filter((r) => heads.has(`${r.sha} ${r.ref}`)).map((r) => r.ref), path }
}

// --discard's first step: the worktree's commits no remote holds, kept in a bundle in the trash beside its move, its path for the trash entry; none when the remotes hold every commit now (unpushed), else why the worktree stays.
const bundleUnpushed = (
  at: string,
  trash: string,
  session: string,
  now: Date,
): { bundle?: string } | { refused: string } => {
  const head = Bun.spawnSync(["git", "-C", at, "rev-parse", "HEAD"], { stdout: "pipe" })
  const ahead = unpushed(at)
  const sha = head.stdout.toString().trim()
  if (head.exitCode !== 0 || ahead === null)
    return { refused: `${at}'s commits could not be read, so it stays` }
  if (!ahead.shas.length) return {}
  const made = bundleToTrash(
    at,
    [{ ref: "HEAD", sha }],
    ahead.tips.map((t) => t.sha),
    {
      name: basename(at),
      now,
      session,
      trash,
    },
  )
  if ("refused" in made)
    return { refused: `${at}'s commits no remote holds stay, and so does it: ${made.refused}` }
  return made.held.length
    ? { bundle: made.path }
    : { refused: `${at}'s bundle ${made.path} does not hold its HEAD ${sha}, so it stays` }
}

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// The commits a worktree's HEAD holds that no remote holds now (unpushed), archived, only while every remote reads, by git format-patch into <archive>/<repo>/<worktree>-<HEAD sha7>, written only when that folder is not there yet, then read back: its path and count once it holds a patch for each of those commits, by each patch's From line, a patch for any other commit allowed since a remote read since may list fewer, else why the worktree stays.
export function archiveUnlanded(
  at: string,
  archive: string,
): { count: number; path: string } | { refused: string } {
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", at, ...args], { stderr: "pipe", stdout: "pipe" })
    return { err: run.stderr.toString().trim(), ok: run.exitCode === 0, out: run.stdout.toString() }
  }
  const head = git("rev-parse", "HEAD")
  const listed = unpushed(at)
  if (!head.ok || listed === null) return { refused: "its commits could not be read" }
  if (listed.unread.length)
    return {
      refused: `its remote ${listed.unread.join(", ")} could not be read, so its work stays until it answers`,
    }
  const { shas } = listed
  if (!shas.length) return { refused: "it holds no commit past its remotes to archive" }
  const repo = dirname(dirname(dirname(at)))
  const path = join(archive, basename(repo), `${basename(at)}-${head.out.trim().slice(0, 7)}`)
  if (!existsSync(path)) {
    let wrote: string | null = null
    try {
      mkdirSync(path, { recursive: true })
      const patched = git(
        "format-patch",
        "-q",
        "-o",
        path,
        "--root",
        "HEAD",
        "--not",
        ...listed.tips.map((t) => t.sha),
      )
      if (!patched.ok) wrote = patched.err
    } catch (error) {
      wrote = (error as Error).message
    }
    if (wrote !== null) return { refused: `its archive at ${path} failed to write: ${wrote}` }
  }
  let patches: (string | undefined)[]
  try {
    patches = readdirSync(path)
      .filter((name) => name.endsWith(".patch"))
      .map((name) => /^From ([0-9a-f]+) /.exec(readFileSync(join(path, name), "utf8"))?.[1])
  } catch (error) {
    return { refused: `its archive at ${path} could not be read: ${(error as Error).message}` }
  }
  const held = shas.filter((sha) => patches.includes(sha)).length
  if (held !== shas.length)
    return {
      refused: `its archive at ${path} holds ${counted(patches.length, "patch", "patches")}, ${held} of its ${counted(shas.length, "commit", "commits")} no remote holds`,
    }
  return { count: shas.length, path }
}

// Whether HEAD's work is on base (origin/canary, or another repo's default branch; null when none reads): each file HEAD changed since their merge-base, named raw (-z) and matched literally so no name is quoted or globbed, reads the same there, or, since a squash merge may change those files again, a merged PR holds HEAD's commit.
const landed = (
  git: (...args: string[]) => { ok: boolean; out: string },
  holders: Holders,
  at: string,
  ref: string | null,
): boolean => {
  const base = ref === null ? { ok: false, out: "" } : git("merge-base", "HEAD", ref)
  if (base.ok && ref !== null) {
    const files = git("diff", "--name-only", "-z", "--no-renames", base.out, "HEAD")
    const paths = files.out.split("\0").filter(Boolean)
    if (
      files.ok &&
      (!paths.length ||
        git("--literal-pathspecs", "diff", "--quiet", "HEAD", ref, "--", ...paths).ok)
    )
      return true
  }
  const head = git("rev-parse", "HEAD")
  return head.ok && holders.merged(head.out, at) === true
}

// A mkdtemp folder under the temp folder, marked so removeScratch will remove it.
export function makeScratch(prefix: string, tmp = tmpdir()): string {
  const dir = mkdtempSync(join(tmp, prefix))
  writeFileSync(join(dir, MARKER), "")
  return dir
}

// Removes a folder makeScratch made, and nothing else: null once removed, else why not.
export function removeScratch(dir: string, tmp = tmpdir()): string | null {
  const abs = resolve(dir)
  if (!lstat(abs)?.isDirectory()) return `${abs} is not a folder`
  if (dirname(real(abs)) !== real(tmp))
    return `${abs} is not a folder made in the temp folder ${tmp}`
  if (!lstat(join(abs, MARKER))?.isFile()) return `${abs} has no ${MARKER} marker`
  rmSync(abs, { force: true, recursive: true })
  return null
}

// Each folder makeScratch made directly in tmp whose name starts with prefix and whose mtime is olderThanMs before now, removed through removeScratch, so an unmarked folder stays whatever its name or age: each removed path with its bytes.
export function removeStale(
  prefix: string,
  tmp: string,
  olderThanMs: number,
  now: Date,
): { bytes: number; path: string }[] {
  const root = real(tmp)
  const removed: { bytes: number; path: string }[] = []
  for (const entry of entriesOf(root)) {
    const at = join(root, entry.name)
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const st = lstat(at)
    if (!st || st.mtimeMs >= now.getTime() - olderThanMs) continue
    if (!lstat(join(at, MARKER))?.isFile()) continue
    const { size } = measure(at)
    if (removeScratch(at, root) === null) removed.push({ bytes: size, path: at })
  }
  return removed
}

// The one recursive delete of the trash: each batch over 7 days old, then the oldest while free space is under 50 GB; deleting the trash is cheap, so no load holds either, and a batch whose real path is not a folder directly in the trash root is skipped.
// A batch the delete cannot finish, a file in it flagged immutable, stays for the next pass, and stuck names it with its error code on the first pass that meets it alone, by a mark in .purge-stuck that goes with the batch.
export function purgeTrash(
  trash: string,
  io: { free: () => number; now: Date },
): { removed: string[]; skipped: string[]; stuck: string[] } {
  const root = real(trash)
  const removed: string[] = []
  const skipped: string[] = []
  const stuck: string[] = []
  const marks = join(root, ".purge-stuck")
  const remove = (batch: string) => {
    const at = join(root, batch)
    if (!lstat(at)?.isDirectory() || dirname(real(at)) !== root) {
      skipped.push(batch)
      return
    }
    try {
      rmSync(at, { force: true, recursive: true })
    } catch (error) {
      const mark = join(marks, batch)
      if (lstat(mark)) return
      try {
        mkdirSync(marks, { recursive: true })
        writeFileSync(mark, "")
      } catch {}
      stuck.push(`${batch} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`)
      return
    }
    removed.push(batch)
  }
  const cutoff = io.now.getTime() - PURGE.days * 86_400_000
  const young: string[] = []
  for (const batch of batches(root))
    if (stampMs(BATCH.exec(batch)![1]!) < cutoff) remove(batch)
    else young.push(batch)
  while (young.length && io.free() < PURGE.minFree) remove(young.shift()!)
  for (const mark of entriesOf(marks))
    if (!lstat(join(root, mark.name)))
      try {
        rmSync(join(marks, mark.name), { force: true })
      } catch {}
  // A told mark no try can meet again: a burst's key is a stamp that never recurs, so a mark older than the cap's window is swept, and the session's folder stays, since a concurrent try may be about to fill it.
  const toldCutoff = io.now.getTime() - CAP_WINDOW_MS
  const stale = (at: string) => (lstat(at)?.mtimeMs ?? Infinity) < toldCutoff
  for (const session of entriesOf(join(root, ".cap-told"))) {
    const at = join(root, ".cap-told", session.name)
    if (!session.isDirectory()) {
      if (stale(at)) {
        try {
          rmSync(at, { force: true })
        } catch {}
      }
      continue
    }
    for (const mark of entriesOf(at)) {
      const markAt = join(at, mark.name)
      if (stale(markAt)) {
        try {
          rmSync(markAt, { force: true })
        } catch {}
      }
    }
  }
  return { removed, skipped, stuck }
}

// The wait between two item strips, so the strip's deletions never run back to back.
const STRIP_PACE_MS = 250

// Whether a tree folder is one an install or a build rebuilds: a node_modules folder, at any depth, and web/next/.next.
const isRebuildable = (rel: string, name: string): boolean =>
  name === "node_modules" || rel === join("web", "next", ".next")

// Removes a tree's node_modules folders, at any depth, and its web/next/.next, the folders an install or a build rebuilds, and returns the removed paths relative to the tree; a symlink is not followed, so a link named node_modules stays.
const stripRebuildable = (tree: string): string[] => {
  const removed: string[] = []
  const walk = (dir: string, base: string): void => {
    for (const entry of entriesOf(dir)) {
      if (!entry.isDirectory()) continue
      const rel = base ? join(base, entry.name) : entry.name
      if (isRebuildable(rel, entry.name)) {
        rmSync(join(dir, entry.name), { force: true, recursive: true })
        removed.push(rel)
      } else walk(join(dir, entry.name), rel)
    }
  }
  walk(tree, "")
  return removed.sort()
}

// Strips every batch in the trash, oldest first and paced, of the folders an install or a build rebuilds, at any load; what it leaves is the tree's code, which the 7-day restore brings back, so no batch goes whole. An entry whose item it stripped gains the folder count on stripped, which the restore line names the install from, an entry a carve-out let through or one already marked keeps its item whole, and a manifest it cannot rewrite or an item it cannot finish names its batch in failed.
export async function stripTrash(
  trash: string,
  io: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ batches: string[]; failed: string[]; folders: number }> {
  const root = real(trash)
  const sleep = io.sleep ?? ((ms: number) => Bun.sleep(ms))
  const done: string[] = []
  const failed: string[] = []
  let folders = 0
  for (const batch of batches(root)) {
    const at = join(root, batch)
    if (!lstat(at)?.isDirectory() || dirname(real(at)) !== root) continue
    const entries = manifestOf(root, batch)
    let changed = false
    let held = 0
    for (const slot of dirsIn(at)
      .map((dir) => basename(dir))
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(a) - Number(b))) {
      const entry = entries.find((line) => line.id === `${batch}/${slot}`)
      if (entry?.stripped || entry?.carveOut) continue
      const item = dirsIn(join(at, slot))
      if (item.length !== 1) continue
      let stripped: string[]
      try {
        stripped = stripRebuildable(item[0]!)
      } catch {
        failed.push(batch)
        continue
      }
      if (!stripped.length) continue
      folders += stripped.length
      held += stripped.length
      await sleep(STRIP_PACE_MS)
      if (entry) {
        entry.stripped = (entry.stripped ?? 0) + stripped.length
        changed = true
      }
    }
    if (changed) {
      const tmp = join(at, "manifest.jsonl.strip")
      try {
        writeFileSync(tmp, `${entries.map((line) => JSON.stringify(line)).join("\n")}\n`)
        renameSync(tmp, join(at, "manifest.jsonl"))
      } catch {
        failed.push(batch)
      }
    }
    if (held) done.push(batch)
  }
  return { batches: done, failed: [...new Set(failed)], folders }
}
