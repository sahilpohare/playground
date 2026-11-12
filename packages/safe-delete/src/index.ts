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
import { basename, dirname, join, resolve, sep } from "node:path"

import { hasManagerRole, placedKindOf } from "@packages/config/kinds"

// The folders a delete starts from, passed in so a test builds them on a mkdtemp root of its own.
export type Roots = { home: string; main: string; trash: string }

// protected and tripwire refusals go to the dispatcher through the ops notify line; refused is a plain no, as is a per-minute cap refusal after its burst's first (firstOfBurst), so a burst alerts once.
export type Refusal = { kind: "protected" | "refused" | "tripwire"; refused: string }

// A process with a working folder: its command line, and the unix sockets it holds open, read for an agent-browser daemon alone.
export type Proc = { command: string; cwd: string; pid: number; sockets: string[] }

// A running node_modules clone, from run-slot's clone holder record: the session that runs it, its pid, the checkout it copies from and the one it copies into.
export type Clone = { destination: string; pid: number; source: string; who: string }

// What tells a worktree is held: the running clones, a reader quarantine calls again right before its move, the roster's live statuses, the folders beyond the other worktrees read for links into it (linkPlaces), every process with a working folder (null when they cannot be listed), and the roster's path; whether a merged PR holds a commit (null when that cannot be asked), --discard, which lets uncommitted or unlanded work go, and the pull request whose session used the worktree, since another session of that PR shares its number and holds it by no more than that; the worktree's own PR once it reads MERGED or CLOSED (freed, at its head), which no roster row naming its branch or its number holds while the worktree sits at that PR's head, and where a pass past such a row is told (note).
export type Holders = {
  clones: () => Clone[]
  discard: boolean
  freed?: { head: string; number: number; state: "CLOSED" | "MERGED" }
  live: string[]
  merged: (sha: string, at: string) => boolean | null
  note?: (line: string) => void
  places: () => string[]
  pr?: string
  procs: Proc[] | null
  roster: string
}

// An agent-browser process, its daemon or a client, by its command's first word.
export const isAgentBrowser = (command: string): boolean =>
  /^agent-browser(?:-[\w-]+)?$/.test(basename(command.split(" ")[0]!))

export type Quarantined = {
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
  carveOut?: string
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

// One script's exception to the protected list: the entries directly in one exact folder in the data folder (the trash's parent, so it follows PLAYGROUND_DATA_DIR), or in HOME with home set, each at most its files and bytes, and with name set only a plain file whose name it matches; the folder itself, its parent, a sibling and anything deeper stay protected.
export type CarveOut = { bytes: number; files: number; folder: string; home?: true; name?: RegExp }

// The file name of a LaunchAgent that is Playground's own, which the jobs render installs and removes, and no other.
export const PLAYGROUND_AGENT = /^com\.playground\.[\w.-]+\.plist$/

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

// Whether a path sits directly in the main checkout's .claude/worktrees, the one folder playground rm --worktree takes.
export const inWorktrees = (path: string, roots: Roots): boolean => {
  const abs = resolve(path)
  return dirname(join(real(dirname(abs)), basename(abs))) === worktreesOf(roots)
}

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

// The caller's own scratch folders in the data folder: scratch/<session> and scratchpad/<session>, symlinks resolved, none for a name no session may hold.
const ownScratchOf = (home: string, session: string): string[] =>
  SESSION.test(session)
    ? [
        join(home, ".playground", "scratch", session),
        join(home, ".playground", "scratchpad", session),
      ].map(real)
    : []

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

// Why a path may not be deleted, or null: checked at the path's own place and at its symlink's target. A session's name exempts its own two scratch folders, and nothing else.
export function isProtected(path: string, roots: Roots, session?: string): string | null {
  const abs = resolve(path)
  const own = join(real(dirname(abs)), basename(abs))
  const scratch = session === undefined ? [] : ownScratchOf(real(roots.home), session)
  return whyProtected(own, roots, scratch) ?? whyProtected(real(abs), roots, scratch)
}

// The carve-out named name when path is an entry directly in its folder, symlinks resolved, that is not and holds no protected root; else the refusal's text.
const carveOutAt = (
  path: string,
  name: string,
  roots: Roots,
  table: Record<string, CarveOut>,
): CarveOut | string => {
  const carve = Object.hasOwn(table, name) ? table[name]! : undefined
  if (!carve) return `no carve-out is named ${name}`
  const folder = real(join(carve.home ? roots.home : dirname(roots.trash), carve.folder))
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
): CarveOut | Refusal | null => {
  const why = isProtected(path, roots, session)
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

// Renames a path into <trash>/<UTC-ts>-<session>/<n>/ with a manifest line, after the protected list, worktreeRefusal for a worktree (which only the worktree option's holders move), the tripwire, the volume check and, for a worktree, the running clones read again, since the walk that counts its files takes seconds and a clone can start inside it.
export function quarantine(
  path: string,
  opts: {
    carveOut?: string
    git?: WorktreeGit
    reason: string
    session: string
    worktree?: Holders
  },
  roots: Roots,
  io: { carveOuts?: Record<string, CarveOut>; dev?: (path: string) => number; now?: Date } = {},
): Quarantined | Refusal {
  const abs = resolve(path)
  if (!SESSION.test(opts.session))
    return refused(`the session name ${opts.session} is not a word of letters, digits and hyphens`)
  if (!lstat(abs)) return refused(`no such path ${abs}`)
  const carve = carveOutOf(abs, opts.carveOut, roots, io.carveOuts ?? CARVE_OUTS, opts.session)
  if (carve && "refused" in carve) return carve
  const isWorktree = inWorktrees(abs, roots)
  if (isWorktree && !opts.worktree)
    return refused(`${abs} is a worktree: playground rm --worktree removes it`)
  if (!isWorktree && opts.worktree)
    return refused(
      `--worktree takes a folder in ${worktreesOf(roots)}, not ${abs}: playground rm ${abs} moves a folder outside it to the trash, with no --worktree or --discard, up to ${LIMITS.files.toLocaleString("en-US")} files or ${LIMITS.bytes / 1024 ** 3} GB; leave a bigger tree in place for your lead's cleanup`,
    )
  const held = opts.worktree && worktreeRefusal(abs, roots, opts.worktree)
  if (held) return refused(held)
  const now = io.now ?? new Date()
  const trash = real(roots.trash)
  const recent = recentMoves(trash, opts.session, now)
  if (recent.length >= LIMITS.perMinute)
    return refused(
      `${opts.session} quarantined ${recent.length} paths in the last minute, the most one session may`,
      firstOfBurst(trash, opts.session, recent) ? "tripwire" : "refused",
    )
  // The measure skips the tree's rebuildable folders, so the tripwire judges what the trash will hold and a refused rm keeps its tree whole; the strip runs on the moved tree, once every refusal is past. A carve-out's move keeps its tree whole.
  const cap = carve ?? LIMITS
  const { files, size } = measure(abs, {
    limits: opts.worktree ? undefined : cap,
    skip: carve ? undefined : isRebuildable,
  })
  if (!opts.worktree && (files > cap.files || size > cap.bytes))
    return refused(
      carve
        ? `${abs} holds over ${cap.files} files or ${cap.bytes} bytes, past the ${opts.carveOut} carve-out's cap`
        : `${abs} holds over ${LIMITS.files} files or ${LIMITS.bytes / 1024 ** 3} GB, past the tripwire`,
      "tripwire",
    )
  mkdirSync(trash, { recursive: true })
  const dev = io.dev ?? ((p: string) => lstatSync(p).dev)
  if (dev(abs) !== dev(trash)) return refused(otherVolume(abs, trash))
  const cloned = opts.worktree && cloneHolder(real(abs), opts.worktree.clones())
  if (cloned) return refused(cloned)
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
    ...(carve ? { carveOut: opts.carveOut } : {}),
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
  const carve = carveOutOf(entry.path, entry.carveOut, roots, carveOuts, entry.session)
  if (carve && "refused" in carve) return carve
  if (lstat(entry.path)) return refused(`${entry.path} already exists; move it aside first`)
  if (!existsSync(dirname(entry.path)))
    return refused(`${dirname(entry.path)}, the folder ${id} came from, is gone`)
  renameSync(join(slot, items[0]!), entry.path)
  rmdirSync(slot)
  return { path: entry.path }
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

// The links outside a worktree that point into it, as its refusal naming the first three, or null: the entries of each other worktree and each place, and of its node_modules one level deep, as a node_modules clone makes them; a link whose target is missing or lies outside the worktree does not count.
const linkHolder = (at: string, roots: Roots, places: string[]): string | null => {
  const links: string[] = []
  for (const folder of new Set([...dirsIn(worktreesOf(roots)), ...places].map(real))) {
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

// Why a worktree may not be removed, or null: it sits in <main>/.claude/worktrees, the roster reads, no live session, running clone, link from outside it or process holds it, and, unless --discard, it holds no uncommitted change and its HEAD's work is on origin/canary.
export function worktreeRefusal(path: string, roots: Roots, holders: Holders): string | null {
  const at = real(path)
  if (dirname(at) !== worktreesOf(roots)) return `${at} is not a worktree in ${worktreesOf(roots)}`
  let agents: ({
    branch?: unknown
    kind?: unknown
    name?: unknown
    pr?: unknown
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
  const folder = basename(at).toLowerCase()
  const where = `${folder} ${branch.toLowerCase()}`
  // Each name's slug, after its PG-<n>- prefix: lint holds PG-12-lint-job, not PG-5-splint.
  const slugs = [folder, branch.toLowerCase()].map((n) => n.replace(/^pg-\d+-/, ""))
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
    const pr =
      typeof agent.pr === "string" && agent.pr !== holders.pr
        ? /\/pull\/(\d+)$/.exec(agent.pr)?.[1]
        : undefined
    const byPr = pr !== undefined && new RegExp(`(^|\\D)${pr}(\\D|$)`).test(where)
    if (!byBranch && !byPr && !byName && !byId) continue
    // a finished PR frees its worktree from a row that names it by its branch or by that PR's own number alone, so a row naming another PR, or the session by name or id, still holds it; commits past the freed PR's head keep the hold, named with them, so --discard cannot take unmerged work
    const freed = holders.freed
    const ownRow =
      !byName && !byId && (!byPr || (freed !== undefined && pr === String(freed.number)))
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
  if (holders.procs === null) return `the processes' folders cannot be listed, so ${at} stays`
  const held = holders.procs.filter((p) => inside(real(p.cwd), at))
  const holder = held.find((p) => isAgentBrowser(p.command)) ?? held[0]
  if (holder) {
    const command =
      holder.command.length > 120 ? `${holder.command.slice(0, 117)}...` : holder.command
    const by = `${at} is held by pid ${holder.pid} (${command}) working in ${holder.cwd}`
    if (!isAgentBrowser(holder.command)) return by
    const session =
      /(?:^| )--session[= ](\S+)/.exec(holder.command)?.[1] ??
      holder.sockets.map((s) => /([^/]+)\.sock$/.exec(s)?.[1]).find(Boolean) ??
      "default"
    return `${by}: agent-browser session ${session}, which agent-browser --session ${session} close frees`
  }
  if (holders.discard) return null
  const discard = `playground rm --worktree ${at} --discard removes it anyway, which a session runs as it is once the worktree's PR has merged or closed, else with --decision <id> once an Inbox delete decision naming it is approved`
  const changed = git("status", "--porcelain", "-z", "--no-renames").out.split("\0").filter(Boolean)
  if (changed.length) {
    const paths = changed.slice(0, 3).map((line) => line.slice(3))
    const more = changed.length > 3 ? `, and ${changed.length - 3} more` : ""
    return `${at} holds ${changed.length} uncommitted change${changed.length === 1 ? "" : "s"} (${paths.join(", ")}${more}): ${discard}`
  }
  if (!landed(git, holders, at))
    return `${at}'s HEAD holds work not landed on origin/canary (fetch origin canary if it merged since): ${discard}`
  return null
}

// Whether HEAD's work is on origin/canary: each file HEAD changed since their merge-base, named raw (-z) and matched literally so no name is quoted or globbed, reads the same there, or, since canary squash-merges and may change those files again, a merged PR holds HEAD's commit.
const landed = (
  git: (...args: string[]) => { ok: boolean; out: string },
  holders: Holders,
  at: string,
): boolean => {
  const base = git("merge-base", "HEAD", "origin/canary")
  if (base.ok) {
    const files = git("diff", "--name-only", "-z", "--no-renames", base.out, "HEAD")
    const paths = files.out.split("\0").filter(Boolean)
    if (
      files.ok &&
      (!paths.length ||
        git("--literal-pathspecs", "diff", "--quiet", "HEAD", "origin/canary", "--", ...paths).ok)
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

// The one recursive delete of the trash: each batch over 7 days old, then the oldest while free space is under 50 GB; deleting the trash is cheap, so no load holds either, and a batch whose real path is not a folder directly in the trash root is skipped.
export function purgeTrash(
  trash: string,
  io: { free: () => number; now: Date },
): { removed: string[]; skipped: string[] } {
  const root = real(trash)
  const removed: string[] = []
  const skipped: string[] = []
  const remove = (batch: string) => {
    const at = join(root, batch)
    if (!lstat(at)?.isDirectory() || dirname(real(at)) !== root) {
      skipped.push(batch)
      return
    }
    rmSync(at, { force: true, recursive: true })
    removed.push(batch)
  }
  const cutoff = io.now.getTime() - PURGE.days * 86_400_000
  const young: string[] = []
  for (const batch of batches(root))
    if (stampMs(BATCH.exec(batch)![1]!) < cutoff) remove(batch)
    else young.push(batch)
  while (young.length && io.free() < PURGE.minFree) remove(young.shift()!)
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
  return { removed, skipped }
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
