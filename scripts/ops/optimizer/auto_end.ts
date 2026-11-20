// auto_end.ts: ends a worker, reviewer or tester once its work is done, by SESSIONS.md#end (spawn.sh close, then its roster report), so no finished session sits idle.
// Two callers: ops-tick's auto-end beat every 5 minutes (sweep, over idle_sessions.ts's flags), and pr:merge and the train's land right after a merge (endMerged, over the PR's roster rows).
// Guards: only a worker, reviewer or tester is ever ended, never a manager, the dispatcher, a runner, the optimizer or a probe; it must be not busy for 10+ minutes, and a worker not in `shell`, since its background task is a step of its chore; uncommitted or unpushed work in a worktree it used keeps it open, told to its lead.
// After a close, each worktree the session used is cleaned (cleanWorktree): its dev stack stopped, the worktree moved to the trash, its containers and branch removed, or kept with the reason; a checker's end cleans the other kind's clones of its PR an earlier end kept the same way, once no other checker of that PR is live.
// Then its leftovers go to the trash too: its scratch and scratchpad folders, its memory settings file and its temp folders. Every move is charged to the ended session under safe-delete's cap of 3 a minute, and a move past the cap is carried to the next auto-end beat.
// Every end and every refusal is one line for its lead; it signals nothing itself but through bun run dev:stop, which signals only the process groups that worktree's stack recorded.

import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
} from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { recordPath } from "../../../api/hono/src/lib/dev/stop"
import { kindOf, managerKindOfName } from "../../../packages/config/src/kinds"
import { dataDir } from "../../../packages/env/src/data-dir"
import {
  freedOf,
  ownPrOf,
  type PrRead,
  type RmDeps,
} from "../../../packages/scripts/src/playground/rm"
import STATUSES from "../../roster-statuses.json"
import {
  type CollectInput,
  collect,
  liveInput,
  type Row,
  sessionPrs,
  workerOf,
} from "./idle_sessions"

export const QUIET_MINUTES = 10

const ENDABLE = new Set(["reviewer", "tester", "worker"])

// A roster status that already reads finished, so the row is left as it is.
const FINISHED = new Set(["closed", "done", "ended", "merged", "parked", "paused"])

export type Target = {
  kind: string | null
  lead?: string
  name: string
  pr?: string
  refs: string[]
  sessionId?: string
  worker?: string
}

export type Line = { text: string; to: string }

export type EndDeps = {
  carried?: () => Promise<Line[]>
  cleanup?: (target: Target) => Promise<string[]>
  close: (name: string) => Promise<{ ok: boolean; out: string }>
  report: (name: string, text: string) => Promise<void>
  resumeDir?: string
  unsaved: (target: Target) => Promise<string | null>
}

// The flag that ends a session, or null: checker-nothing ends a reviewer alone, which its worker resumes under the same name on its next push (rounds).
export function endsOn(row: Row): string | null {
  for (const why of row.why) {
    if (/^(?:checker-pr-done|checker-worker-gone|worker-prs-done)\b/.test(why)) return why
    if (why.startsWith("checker-nothing") && row.kind === "reviewer") return why
  }
  return null
}

// The lead a session's line goes to: its roster lead, else its worker's (resolved by the caller), else the builder seat, or ops for a checker whose worker holds the ops seat.
const leadOf = (lead?: string, worker?: string) =>
  lead ?? (managerKindOfName(worker ?? "") === "ops" ? "ops" : "builder")

// One session ended, its unsaved work checked first; the line for its lead either way, and a reviewer ended idle tells its worker too, who resumes it on the account its resume record names, read before the close.
export async function endOne(target: Target, why: string, deps: EndDeps): Promise<Line[]> {
  const to = leadOf(target.lead, target.worker)
  if (!ENDABLE.has(target.kind ?? ""))
    return [{ text: `Not ended ${target.name} (${why}): a ${target.kind} is never ended`, to }]
  const unsaved = await deps.unsaved(target)
  if (unsaved)
    return [{ text: `Not ended ${target.name} (${why}): ${unsaved}; push it, then close it`, to }]
  const idle = why.startsWith("checker-nothing")
  const account = idle ? await accountOf(target.name, deps.resumeDir) : undefined
  const closed = await deps.close(target.name)
  if (!closed.ok)
    return [
      { text: `Not ended ${target.name} (${why}): spawn.sh close refused: ${closed.out}`, to },
    ]
  await deps.report(target.name, `ended automatically: ${why}`)
  const cleaned = deps.cleanup && !idle ? await deps.cleanup(target) : []
  const after = cleaned.length ? `; cleanup: ${cleaned.join("; ")}` : ""
  if (!idle) return [{ text: `Ended ${target.name}: ${why}${after}`, to }]
  const text = `Ended ${target.name}: ${why}${after}; resume it on the next push: scripts/spawn.sh resume ${target.name} <dir> --force --pr ${target.pr ?? "<PR url>"}${account ? ` --account ${account}` : ""}`
  return target.worker && target.worker !== to
    ? [
        { text, to },
        { text, to: target.worker },
      ]
    : [{ text, to }]
}

// ops-tick's sweep: first each cleanup move an earlier end carried past the cap, then every session idle_sessions.ts flags with a flag that ends it; a worker whose PR closed last unmerged is kept instead, one line asking its lead to reassign or end it.
export async function sweep(input: CollectInput, deps: EndDeps): Promise<Line[]> {
  const out: Line[] = deps.carried ? await deps.carried() : []
  for (const row of await collect(input)) {
    const kept = row.why.find((w) => w.startsWith("worker-pr-closed"))
    if (kept) {
      out.push({
        text: `Kept ${row.name}: ${kept}; reassign it or end it`,
        to: leadOf(row.lead, row.worker),
      })
      continue
    }
    const why = endsOn(row)
    if (!why) continue
    // A pr-done end names the PR that decided it: a merge with its sha, a close by number alone.
    const mark = /^(?:checker-pr-done|worker-prs-done)\b/.test(why)
      ? row.sha
        ? `, #${row.donePr} merged as ${row.sha.slice(0, 7)}`
        : why.endsWith("(closed)") && row.donePr
          ? `, #${row.donePr} closed`
          : ""
      : ""
    out.push(...(await endOne(row, `${why}${mark}`, deps)))
  }
  return out
}

// Right after a merge: the PR's worker, reviewer and tester by their roster pr. A worker the roster gave a next task holds no pr of this PR (assign clears it), and a checker whose worker's row names another PR may serve it, so neither is ended, nor is one with another of its PRs open, as the sweep holds it, nor one whose roster prs list holds a PR or issue not merged or closed. One with no live session has its row ended; a busy one, one quiet under 10 minutes or a worker in `shell` is left to the sweep.
export async function endMerged(
  url: string,
  sha: string,
  input: CollectInput,
  deps: EndDeps,
): Promise<Line[]> {
  const pr = await input.prState(url)
  const why = `#${/\/pull\/(\d+)/.exec(url)?.[1]} merged as ${sha.slice(0, 7)}`
  const out: Line[] = []
  for (const r of Object.values(input.roster)) {
    const name = r.name
    if (!name || r.pr !== url || FINISHED.has(r.status ?? "")) continue
    const kind = kindOf(name, r.kind)
    if (!ENDABLE.has(kind ?? "")) continue
    const worker = kind === "worker" ? undefined : workerOf(name, r.worker)
    const next = worker ? input.roster[worker]?.pr : undefined
    if (next && next !== url) continue
    const lead = r.lead ?? (worker ? input.roster[worker]?.lead : undefined)
    const queued = await Promise.all(
      (r.prs ?? []).filter((u) => u !== url).map((u) => input.prState(u)),
    )
    if (queued.some((s) => s === null || (s.state !== "merged" && s.state !== "closed"))) continue
    const d = input.sessions[name]
    if (!d) {
      await deps.report(name, `ended automatically: ${why}, with no live session`)
      out.push({
        text: `Ended ${name}'s row: ${why}, with no live session`,
        to: leadOf(lead, worker),
      })
      continue
    }
    const quiet = (input.now - (d.statusUpdatedAt || d.updatedAt || input.now * 1000) / 1000) / 60
    if (d.status === "busy" || !(quiet >= QUIET_MINUTES)) continue
    if (kind === "worker" && d.status === "shell") continue
    const others = (await sessionPrs(input, name, worker, d.sessionId)).filter((u) => u !== url)
    const states = await Promise.all(others.map((u) => input.prState(u)))
    // A failed read (null) holds too, as collect holds on it: a rate limit is no proof a PR closed.
    if (states.some((s) => s === null || s.state === "open")) continue
    const target = {
      kind,
      lead,
      name,
      pr: url,
      refs: pr?.ref ? [pr.ref] : [],
      sessionId: d.sessionId,
      worker,
    }
    out.push(...(await endOne(target, why, deps)))
  }
  return out
}

// The wiring below is the only code that touches the machine.

const REPO = join(import.meta.dir, "..", "..", "..")

const runIn = async (argv: string[]): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(argv, { stderr: "pipe", stdout: "pipe", timeout: 120_000 })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: `${out}${err}`.trim() }
}

const git = async (dir: string, args: string[]) => {
  const { code, out } = await runIn(["git", "-C", dir, ...args])
  return code === 0 ? out : null
}

// The account a session's resume record names, which spawn.sh writes at every herdr start and resume: its account line, a login the usage gate picked included, else its --account, as no-headless-login reads it.
async function accountOf(name: string, resumeDir?: string): Promise<string | undefined> {
  if (!resumeDir) return
  try {
    const record = await Bun.file(join(resumeDir, `${name}.sh`)).text()
    return /^# account: (\S+)/m.exec(record)?.[1] ?? /--account (\S+)/.exec(record)?.[1]
  } catch {
    return
  }
}

// The folders a session's transcript ran in, or null when it could not be read.
async function cwdsOf(sessionId: string, projectsDir: string): Promise<string[] | null> {
  const cwds = new Set<string>()
  try {
    for (const rel of new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: projectsDir })) {
      const text = await Bun.file(join(projectsDir, rel)).text()
      for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) cwds.add(JSON.parse(`"${m[1]}"`))
    }
  } catch {
    return null
  }
  return [...cwds]
}

// The managers' shared worktree under a main checkout, where spawn.sh's manager mode starts every manager, so what sits there is no single session's work (a test pins it to spawn.sh's line).
export const LEADS_WORKTREE = ".claude/worktrees/leads"

// The worktrees a session used: each linked worktree its transcript ran in, but the managers' leads worktree, for a worker each worktree on its PRs' branches, and, given the main checkout, a checker's clones of that checkout's PR n, a reviewer's review-<n> and a tester's test-<n> and test-<n>-before, which no cwd names when read from outside (the other kind's clones of PR n are cleanupLive's, once no other checker of it is live); null when its transcript cannot be read.
export async function worktreesOf(
  target: Target,
  projectsDir: string,
  main?: string,
): Promise<string[] | null> {
  const dirs = new Set<string>()
  const cwds = target.sessionId ? await cwdsOf(target.sessionId, projectsDir) : []
  if (!cwds) return null
  for (const cwd of cwds) {
    const top = await git(cwd, ["rev-parse", "--show-toplevel"])
    if (!top) continue
    // Every session starts in the main checkout (its git dir is the common one), so what sits there untracked is not this session's work.
    const [gitDir, commonDir] = (
      (await git(top, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])) ??
      ""
    ).split("\n")
    // The managers' leads worktree is theirs alone, so a session that ran there, a worker resumed from it included, neither waits on its files nor cleans it.
    const leads = !!commonDir && top === join(dirname(commonDir), LEADS_WORKTREE)
    if ((!gitDir || gitDir !== commonDir) && !leads) dirs.add(top)
    if (target.kind !== "worker" || !target.refs.length) continue
    const list = (await git(top, ["worktree", "list", "--porcelain"])) ?? ""
    for (const block of list.split("\n\n")) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      if (path && branch && target.refs.includes(branch)) dirs.add(path)
    }
  }
  const leaves = CLONES[target.kind ?? ""]
  const n = main && leaves ? await ownPr(target.pr, main) : undefined
  if (main && leaves && n) for (const clone of clonesAt(leaves, n, main)) dirs.add(clone)
  return [...dirs]
}

// A checker's clones of its PR n in .claude/worktrees: code-review-loop's for a reviewer, new-tester.md's for a tester.
const CLONES: Record<string, string[]> = {
  reviewer: ["review-<n>"],
  tester: ["test-<n>", "test-<n>-before"],
}

// The clones of PR n in <main>/.claude/worktrees that exist, one per leaf.
const clonesAt = (leaves: string[], n: string, main: string): string[] =>
  leaves
    .map((leaf) => join(main, ".claude", "worktrees", leaf.replace("<n>", n)))
    .filter(existsSync)

// A checker's PR n and the other checker kinds' clones of it that exist, which an earlier end kept while this checker held them; none for a worker or another repo's PR.
async function otherClones(
  target: Target,
  main: string,
): Promise<{ clones: string[]; n: string; pr: string } | null> {
  const n = CLONES[target.kind ?? ""] ? await ownPr(target.pr, main) : undefined
  if (!n || !target.pr) return null
  const leaves = Object.entries(CLONES).flatMap(([kind, l]) => (kind === target.kind ? [] : l))
  return { clones: clonesAt(leaves, n, main), n, pr: target.pr }
}

// Pure: the live reviewer and tester rows a roster's text has on a PR, as their pr or in their prs list, by name; null when the text holds no agents list.
export const checkersOf = (text: string, pr: string): string[] | null => {
  try {
    const { agents } = JSON.parse(text) as { agents: unknown }
    if (!Array.isArray(agents)) return null
    return agents.flatMap(
      (a: { kind?: unknown; name?: unknown; pr?: unknown; prs?: unknown; status?: unknown }) =>
        a &&
        typeof a.name === "string" &&
        (a.pr === pr || (Array.isArray(a.prs) && a.prs.includes(pr))) &&
        STATUSES.live.includes(String(a.status)) &&
        CLONES[kindOf(a.name, a.kind) ?? ""]
          ? [a.name]
          : [],
    )
  } catch {
    return null
  }
}

// The number of a PR on the main checkout's own origin repository, else undefined.
async function ownPr(pr: string | undefined, main: string): Promise<string | undefined> {
  const origin = await git(main, ["config", "--get", "remote.origin.url"])
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin ?? "")?.[1]
  const prefix = `https://github.com/${repo}/pull/`
  return repo && pr?.startsWith(prefix) ? /^\d+$/.exec(pr.slice(prefix.length))?.[0] : undefined
}

// Why the work in a worktree the session used is not saved, or null; a Playground worktree whose PR has merged or closed holds no end, since its cleanup discards it.
export async function unsavedLive(
  target: Target,
  projectsDir: string,
  done?: Pick<CleanupDeps, "finished" | "main">,
): Promise<string | null> {
  const dirs = await worktreesOf(target, projectsDir)
  if (!dirs) return `could not check its transcript in ${projectsDir}`
  // A failed read is no proof the work is saved, so it holds the end too.
  for (const dir of dirs) {
    const status = await git(dir, ["status", "--porcelain"])
    if (status === null) return `could not check ${dir}`
    const ahead = status
      ? null
      : await git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"])
    if (!status && ahead === null) return `could not check ${dir}`
    const unsaved = status ? "uncommitted work" : Number(ahead) > 0 ? "unpushed commits" : null
    if (!unsaved) continue
    const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    const ours =
      done &&
      common &&
      dirname(common) === done.main &&
      dirname(dir) === join(done.main, ".claude", "worktrees")
    if (ours && (await done.finished(dir, target.pr))) continue
    return `${unsaved} in ${dir}`
  }
  return null
}

// What one worktree's cleanup reads and runs, so a test hands it fakes: the live reviewer and tester roster rows on a PR (null when the roster cannot be read), which cleanupLive alone reads, git in a folder, the main checkout, the live dashboard's branch, whether a worktree's PR has merged or closed, the live session or clone holding a worktree, its dev stack's stop, playground rm's move of a worktree with or without --discard, charged to who (else this process's own session name), the containers docker lists and its remove, whether a name is the live dashboard's database, and, for an ended session's leftovers, the folders and files named for it (leftovers), the live process still running in one (heldBy), the move of one of them charged to it (rmOwn), and whether one more move charged to a name fits the per-minute cap (room), and the record of a move it held back for the next beat (carry).
export type CleanupDeps = {
  carry?: (item: Carried) => Promise<void>
  checkers?: (pr: string) => Promise<string[] | null>
  containers: () => Promise<string[] | null>
  devStop: (dir: string) => Promise<{ ok: boolean; out: string }>
  finished: (path: string, pr?: string) => Promise<boolean>
  git: (dir: string, args: string[]) => Promise<string | null>
  held: (path: string, pr?: string) => Promise<string | null>
  heldBy?: (path: string) => string | null
  leftovers?: (name: string) => string[]
  live: (container: string) => boolean
  liveBranch: string
  main: string
  removeContainer: (name: string) => Promise<boolean>
  rm: (
    path: string,
    reason: string,
    pr?: string,
    discard?: boolean,
    who?: string,
  ) => Promise<{ ok: boolean; out: string }>
  rmOwn?: (path: string, reason: string, who: string) => Promise<{ ok: boolean; out: string }>
  room?: (who: string) => boolean
}

// A move the per-minute cap held back, which the next auto-end beat makes.
export type Carried = { path: string; pr?: string; reason: string; who: string; worktree: boolean }

// The cap check before a move charged to an ended session: true when it may go now, else the item carried and false.
const roomFor = async (item: Carried, deps: CleanupDeps): Promise<boolean> => {
  if (!deps.room || deps.room(item.who)) return true
  await deps.carry?.(item)
  return false
}

const carriedLine = ({ path, who }: Carried) =>
  `kept ${path}: carried to the next auto-end beat, since ${who} has made its moves for this minute`

// Pure: the containers a worktree's cleanup may remove, playground-<worktree>-db and -redis as AGENTS.md names a worktree's own, for a folder directly in <main>/.claude/worktrees alone and never the live dashboard's database.
export const containersFor = (
  path: string,
  main: string,
  live: (container: string) => boolean,
): string[] => {
  if (dirname(path) !== join(main, ".claude", "worktrees")) return []
  const name = basename(path).replace(/[^a-zA-Z0-9_.-]/g, "-")
  return [`playground-${name}-db`, `playground-${name}-redis`].filter((c) => !live(c))
}

// One worktree a closed session used, cleaned once its work is saved or, for a Playground worktree, its PR has merged or closed (then through --discard to the trash, whatever it holds), a hold by its PR's number alone from another session of that PR (the merging worker, a sibling checker) not counting, and a commit pushed counts as saved (a PR's head GitHub keeps after its branch is deleted on merge): a Playground worktree's dev stack stopped, the worktree moved to the trash by playground rm (which refuses one a live session or a process holds), then its containers removed by exact name; another repo's worktree removed by git with no force flag, then pruned; then its branch deleted. The line saying what went, or why it stayed.
export async function cleanWorktree(
  path: string,
  reason: string,
  deps: CleanupDeps,
  { pr, pushed, who }: { pr?: string; pushed?: string; who?: string } = {},
): Promise<string> {
  const [gitDir, commonDir] = (
    (await deps.git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ])) ?? ""
  ).split("\n")
  if (!gitDir || !commonDir || gitDir === commonDir) return `kept ${path}: not a linked worktree`
  const branch = await deps.git(path, ["symbolic-ref", "--short", "-q", "HEAD"])
  if (branch === deps.liveBranch) return `kept ${path}: the live dashboard's checkout`
  const status = await deps.git(path, ["status", "--porcelain"])
  if (status === null) return `kept ${path}: could not read its git status`
  const ahead = status
    ? null
    : await deps.git(path, [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        "--remotes",
        ...(pushed ? [pushed] : []),
      ])
  if (!status && ahead === null) return `kept ${path}: could not count its unpushed commits`
  const unsaved = status ? "uncommitted work" : Number(ahead) > 0 ? "unpushed commits" : null
  const repo = dirname(commonDir)
  const discard = unsaved !== null && repo === deps.main && (await deps.finished(path, pr))
  if (unsaved && !discard) return `kept ${path}: ${unsaved}`
  const gone: string[] = []
  let listed: string[] | null = []
  if (repo === deps.main) {
    const own = containersFor(path, deps.main, deps.live)
    if (!own.length)
      return `kept ${path}: not a worktree in ${join(deps.main, ".claude", "worktrees")}`
    const holder = await deps.held(path, pr)
    if (holder) return `kept ${path}: ${holder}`
    // a clone with no stack record has no stack to stop, and a reviewer's clone with no node_modules cannot load dev:stop at all
    const stopped = existsSync(recordPath(path)) ? await deps.devStop(path) : { ok: true, out: "" }
    if (!stopped.ok && !stopped.out.includes("no stack is recorded"))
      return `kept ${path}: ${stopped.out}`
    const item = { path, ...(pr ? { pr } : {}), reason, who: who ?? "", worktree: true }
    if (who && !(await roomFor(item, deps))) return carriedLine(item)
    let moved = await deps.rm(path, reason, pr, discard, who)
    // rm's refusal of work landed on neither canary nor a branch origin holds names --discard, which a finished PR's worktree takes
    if (!moved.ok && !discard && moved.out.includes("--discard removes it anyway"))
      if (await deps.finished(path, pr)) moved = await deps.rm(path, reason, pr, true, who)
    if (!moved.ok) return `kept ${path}: ${moved.out}`
    listed = await deps.containers()
    if (listed)
      for (const name of own)
        if (listed.includes(name) && (await deps.removeContainer(name))) gone.push(name)
  } else {
    if ((await deps.git(repo, ["worktree", "remove", path])) === null)
      return `kept ${path}: git worktree remove refused it`
    await deps.git(repo, ["worktree", "prune"])
  }
  const deleted = branch ? (await deps.git(repo, ["branch", "-D", branch])) !== null : false
  const containers = listed
    ? gone.length
      ? `, containers ${gone.join(", ")}`
      : ""
    : ", its containers kept since docker ps could not list them"
  return `removed ${path}${containers}${deleted ? `, branch ${branch}` : ""}`
}

// Whether a worktree's PR, as rm's reader returns it (its head beside its number and state, or none), is finished: merged or closed, rm's freed reading.
export const finishedOf = (pr: PrRead): boolean => freedOf(pr) !== undefined

// Why the cleanup's held check keeps a worktree, with rm's roster, clone and link holders and the worktree's own PR's freed state among them: null when nothing holds it. Its process check reads none, since the stack dev:stop is about to stop, and rm's saved-work checks run after it.
export const cleanupHeld = async (
  path: string,
  pr: string | undefined,
  rm: RmDeps,
): Promise<string | null> => {
  const { worktreeRefusal } = await import("../../../packages/safe-delete/src/index")
  const own = await rm.prState(path, pr)
  return worktreeRefusal(
    path,
    { home: rm.home, main: rm.main, trash: join(rm.data, "trash") },
    {
      clones: rm.clones,
      discard: true,
      freed: freedOf(own),
      live: STATUSES.live,
      merged: () => null,
      mergedHead: (url: string) => rm.mergedHead(path, url),
      ...ownPrOf(own),
      places: rm.places,
      ...(pr ? { pr } : {}),
      procs: [],
      roster: join(rm.data, "roster.json"),
    },
  )
}

// Bun's version footer, the last line a crash under Bun prints, which names no error.
const BUN_FOOTER = /^Bun v\d+\.\d+\.\d+\S* \(.+\)$/

// Pure: the line a kept worktree names from a command's output: dev:stop's own line, else Bun's error: line, else the last line that is neither blank nor Bun's footer, since a kept line once read only "Bun v1.4.4 (Linux arm64)".
export const reasonOf = (out: string): string => {
  const lines = out.split("\n").map((line) => line.trim())
  return (
    lines.find((line) => line.startsWith("dev:stop:")) ??
    lines.find((line) => line.startsWith("error: ")) ??
    lines.findLast((line) => line && !BUN_FOOTER.test(line)) ??
    ""
  )
}

// This machine's cleanup deps: git, the main checkout this one belongs to, bun run dev:stop in the worktree, playground rm's PR state, playground rm's move in this process, charged to the name given, else this process's own, with safe-delete's cap read before it, docker ps -a and docker rm -fv, the live dashboard's database name, and an ended session's leftovers.
export async function cleanupDeps(): Promise<CleanupDeps | null> {
  const common = await git(REPO, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (!common) return null
  const { isLiveDatabase, livePair } = await import("../../../api/hono/src/lib/dev/live-dashboard")
  const { removePath, rmDeps } = await import("../../../packages/scripts/src/playground/rm")
  const { movesLeft } = await import("../../../packages/safe-delete/src/index")
  const pair = livePair()
  const rm = rmDeps(REPO)
  // playground rm's own move, in this process and charged to who; a throw's message stands as its line
  const moveOf = async (args: Parameters<typeof removePath>[0], who: string) => {
    try {
      const moved = await removePath(args, who, rm, () => {})
      return { ok: moved.ok, out: moved.line }
    } catch (err) {
      return { ok: false, out: reasonOf(err instanceof Error ? err.message : String(err)) }
    }
  }
  return {
    carry: async (item) => {
      await mkdir(dirname(CARRIED), { recursive: true })
      await appendFile(CARRIED, `${JSON.stringify(item)}\n`)
    },
    checkers: async (pr) =>
      checkersOf(
        await Bun.file(join(rm.data, "roster.json"))
          .text()
          .catch(() => ""),
        pr,
      ),
    containers: async () => {
      const { code, out } = await runIn(["docker", "ps", "-a", "--format", "{{.Names}}"])
      return code === 0 ? out.split("\n").filter(Boolean) : null
    },
    devStop: async (dir) => {
      const { code, out } = await runIn(["bun", "run", "--cwd", dir, "dev:stop"])
      return { ok: code === 0, out: reasonOf(out) }
    },
    finished: async (path, pr) => finishedOf(await rm.prState(path, pr)),
    git,
    held: (path, pr) => cleanupHeld(path, pr, rm),
    heldBy: (path) => {
      const held =
        process.platform === "linux"
          ? procHoldersOf(path)
          : (rm.procs() ?? [])
              .filter((p) => p.cwd === path || p.cwd.startsWith(`${path}/`))
              .map((p) => ({ command: basename(p.command.split(" ")[0] ?? ""), pid: p.pid }))
      return held.length
        ? `held by ${held.map((p) => `pid ${p.pid} (${p.command})`).join(", ")}, which still runs in it`
        : null
    },
    leftovers: (name) =>
      leftoversOf(name, rm.data, readdirSync("/tmp"), process.platform).filter(existsSync),
    live: (container) => isLiveDatabase(container, pair),
    liveBranch: pair.branch,
    main: dirname(common),
    removeContainer: async (name) => (await runIn(["docker", "rm", "-fv", name])).code === 0,
    rm: async (path, reason, pr, discard, who) =>
      moveOf(
        { discard: !!discard, path, ...(pr ? { pr } : {}), reason, worktree: true },
        who ?? (await rm.session()),
      ),
    rmOwn: (path, reason, who) => moveOf({ discard: false, path, reason, worktree: false }, who),
    room: (who) => movesLeft(join(rm.data, "trash"), who) > 0,
  }
}

// Each process but this one whose working folder or an open file sits in path, read from proc's pid folders (Linux's /proc), a pid whose links cannot be read counting as none; [] when path or proc cannot be read.
export const procHoldersOf = (path: string, proc = "/proc"): { command: string; pid: number }[] => {
  let root: string
  let pids: string[]
  try {
    root = realpathSync(path)
    pids = readdirSync(proc).filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
  } catch {
    return []
  }
  const inside = (link: string) => link === root || link.startsWith(`${root}/`)
  const read = (at: string, fn: () => string[]) => {
    try {
      return fn()
    } catch {
      return [] as string[]
    }
  }
  return pids.flatMap((pid) => {
    const at = join(proc, pid)
    const links = [
      "cwd",
      ...read(at, () => readdirSync(join(at, "fd")).map((fd) => join("fd", fd))),
    ]
    if (!links.some((link) => read(at, () => [readlinkSync(join(at, link))]).some(inside)))
      return []
    return [
      {
        command: read(at, () => [readFileSync(join(at, "comm"), "utf8").trim()])[0] ?? "",
        pid: Number(pid),
      },
    ]
  })
}

// Pure: the folders and files an ended session leaves, named for it: its scratch and scratchpad folders, the memory trial's settings file spawn.sh wrote for it, and on Linux each temp folder spawn.sh made it (/tmp/playground-<name>.XXXXXX, one per start), of tmp's entries; the caller keeps the ones that exist.
export const leftoversOf = (
  name: string,
  data: string,
  tmp: string[],
  platform: string,
): string[] => [
  join(data, "scratch", name),
  join(data, "scratchpad", name),
  join(data, `factory-settings-400k-memory-${name}.json`),
  ...(platform === "linux"
    ? tmp
        .filter((entry) => entry.startsWith(`playground-${name}.`))
        .map((entry) => join("/tmp", entry))
    : []),
]

// The record of each move the cap held back, which the next auto-end beat takes.
const CARRIED = join(dataDir(), "ops", "tick", "auto-end-carried.jsonl")

// The moves an earlier end carried, each whose path is still there made now, or carried again.
export async function drainCarried(
  items: Carried[],
  deps: CleanupDeps,
  exists: (path: string) => boolean = existsSync,
): Promise<string[]> {
  const lines: string[] = []
  for (const item of items.filter((it) => exists(it.path)))
    lines.push(
      item.worktree
        ? await cleanWorktree(item.path, item.reason, deps, {
            ...(item.pr ? { pr: item.pr } : {}),
            who: item.who,
          })
        : await cleanLeftover(item.path, item.reason, item.who, deps),
    )
  return lines
}

// After a session closes, each worktree it used, one at a time; then, for a checker, each other checker kind's clone of its PR an earlier end kept, while no other reviewer or tester row on that PR is live; then its leftovers (its scratch and scratchpad folders, its memory settings file and its temp folders). Every move is charged to the session itself, so an end never spends its worker's cap or any other session's, and one past the cap is carried to the next beat.
export const cleanupLive =
  (projectsDir: string, depsOf: () => Promise<CleanupDeps | null> = cleanupDeps) =>
  async (target: Target): Promise<string[]> => {
    const deps = await depsOf()
    const dirs = await worktreesOf(target, projectsDir, deps?.main)
    if (!dirs) return [`could not read its transcript in ${projectsDir}, so nothing was cleaned`]
    const leftovers = deps?.leftovers?.(target.name) ?? []
    if (!dirs.length && !leftovers.length && !deps?.checkers) return []
    if (!deps) return ["could not find the main checkout, so nothing was cleaned"]
    const reason = `${target.name} ended`
    const who = target.name
    const lines: string[] = []
    for (const dir of dirs)
      lines.push(await cleanWorktree(dir, reason, deps, { pr: target.pr, who }))
    const { checkers } = deps
    const kept = checkers && (await otherClones(target, deps.main))
    if (checkers && kept?.clones.length) {
      const { clones, n, pr } = kept
      const others = (await checkers(pr))?.filter((name) => name !== target.name)
      for (const dir of clones)
        lines.push(
          !others
            ? `kept ${dir}: the roster could not be read`
            : others.length
              ? `kept ${dir}: ${others.join(", ")} still checks #${n}`
              : await cleanWorktree(dir, reason, deps, { pr: target.pr, who }),
        )
    }
    for (const path of leftovers) lines.push(await cleanLeftover(path, reason, who, deps))
    return lines
  }

// One leftover of an ended session, moved to the trash charged to it, or kept with why: carried to the next beat by the cap, or safe-delete's refusal (a folder over the tripwire among them).
async function cleanLeftover(
  path: string,
  reason: string,
  who: string,
  deps: CleanupDeps,
): Promise<string> {
  if (!deps.rmOwn) return `kept ${path}: nothing here moves it`
  const held = deps.heldBy?.(path)
  if (held) return `kept ${path}: ${held}`
  const item = { path, reason, who, worktree: false }
  if (!(await roomFor(item, deps))) return carriedLine(item)
  const moved = await deps.rmOwn(path, reason, who)
  return moved.ok ? `removed ${path}` : `kept ${path}: ${moved.out}`
}

// Pure: the roster write that ends a row, its endReason the flag that ended it (the why's first word, a merge's "merged"), so spawn.sh resume brings it back only with --force.
export const reportArgv = (name: string, text: string): string[] => [
  process.execPath,
  join(REPO, "scripts", "roster.ts"),
  "report",
  name,
  text,
  `endReason=${/^ended automatically: ([a-z][a-z-]*)/.exec(text)?.[1] ?? "merged"}`,
  "status=ended",
]

export const liveDeps = (projectsDir: string): EndDeps => ({
  carried: async () => {
    const taking = `${CARRIED}.${process.pid}`
    try {
      renameSync(CARRIED, taking)
    } catch {
      return []
    }
    const text = await Bun.file(taking).text()
    const items = text.split("\n").flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as Carried] : []
      } catch {
        return []
      }
    })
    const deps = await cleanupDeps()
    if (!deps) {
      await appendFile(CARRIED, text)
      await Bun.file(taking).delete()
      return []
    }
    const lines = await drainCarried(items, deps)
    await Bun.file(taking).delete()
    return lines.map((line) => ({ text: `Cleanup an earlier end carried: ${line}`, to: "ops" }))
  },
  cleanup: cleanupLive(projectsDir),
  close: async (name) => {
    const { code, out } = await runIn(["bash", join(REPO, "scripts", "spawn.sh"), "close", name])
    return { ok: code === 0, out: out.split("\n").at(-1) ?? "" }
  },
  report: async (name, text) => void (await runIn(reportArgv(name, text))),
  resumeDir: join(dataDir(), "resume"),
  unsaved: async (target) => unsavedLive(target, projectsDir, (await cleanupDeps()) ?? undefined),
})

// pr:merge's and the train's end of a merged PR's sessions on the live machine, each line sent to its lead.
export async function endMergedLive(
  url: string,
  sha: string,
  send: (to: string, text: string) => Promise<boolean>,
): Promise<void> {
  const input = await liveInput(1, Date.now() / 1000)
  for (const line of await endMerged(url, sha, input, liveDeps(input.projectsDir ?? "")))
    await send(line.to, line.text)
}
