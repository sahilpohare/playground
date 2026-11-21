import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"

import { managerOf } from "@packages/config/kinds"
import { cloneOf } from "@packages/config/org"
import { dataDir } from "@packages/env/data-dir"
import {
  type Clone,
  deleteWeights,
  isAgentBrowser,
  isWeights,
  linkPlaces,
  listTrash,
  type Proc,
  quarantine,
  removeReplay,
  replayPlace,
  restore,
  type Roots,
  type Refusal,
  type WorktreeGit,
  worktreeRepo,
} from "@packages/safe-delete"

import STATUSES from "../../../../scripts/roster-statuses.json"
import { ghRead, isUnreachable, type Unreachable } from "../gh-read"
import { dropPaths, peerArgv, readRecord } from "../machine-record/record"
import { mainCheckout } from "../main-checkout"
import { peersOf } from "../ops-tick/peers"
import {
  CARD_ID,
  type CardPick,
  type CardState,
  readCard,
  savedPicks,
} from "../ops-tick/unused-card"
import { sessionName } from "../trash"
import { liveBranch } from "./probe"
import { removeSet, shardSet } from "./shards"

export const RM_USAGE =
  'usage: playground rm <path> [--card <id> [--peer <machine>]] [--reason "<why>"] | --worktree <path> [--discard] [--pr <url>] [--reason "<why>"] | --list | --restore <id>'

export type RmArgs =
  | { list: true }
  | { restore: string }
  | {
      card?: string
      discard: boolean
      path: string
      peer?: string
      pr?: string
      reason: string
      worktree: boolean
    }

// playground rm's words: one path with an optional --card, or --worktree's with an optional --discard and an optional --pr, with an optional --reason; --list or --restore <id> alone.
export const rmArgs = (words: string[]): RmArgs | { error: string } => {
  if (words.length === 1 && words[0] === "--list") return { list: true }
  if (words.length === 2 && words[0] === "--restore") return { restore: words[1]! }
  let path: string | undefined
  let reason = "playground rm"
  let reasonGiven = false
  let worktree = false
  let discard = false
  let pr: string | undefined
  let card: string | undefined
  let peer: string | undefined
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === "--reason" && words[i + 1] !== undefined) {
      reason = words[++i]!
      reasonGiven = true
    } else if (word === "--card" && words[i + 1] !== undefined && card === undefined)
      card = words[++i]!
    else if (word === "--peer" && words[i + 1] !== undefined && peer === undefined)
      peer = words[++i]!
    else if (word === "--discard" && !discard) discard = true
    else if (word === "--pr" && words[i + 1] !== undefined && pr === undefined) pr = words[++i]!
    else if (word === "--worktree" && words[i + 1] !== undefined && path === undefined) {
      worktree = true
      path = words[++i]!
    } else if (!word.startsWith("--") && path === undefined) path = word
    else return { error: RM_USAGE }
  }
  return path === undefined ||
    (discard && !worktree) ||
    (pr !== undefined && !worktree) ||
    (card !== undefined && worktree) ||
    (peer !== undefined && card === undefined) ||
    (peer !== undefined && worktree) ||
    (peer !== undefined && reasonGiven)
    ? { error: RM_USAGE }
    : {
        ...(card === undefined ? {} : { card }),
        discard,
        path,
        ...(peer === undefined ? {} : { peer }),
        ...(pr === undefined ? {} : { pr }),
        reason,
        worktree,
      }
}

export type PrState = "CLOSED" | "MERGED" | "OPEN"
export type Pr = { head: string; number: number; state: PrState }
// A worktree's PR read: its PR, "none" when gh answers with no PR, unreachable when ghRead skips or stops gh, null when no PR of its own reads.
export type PrRead = Pr | "none" | Unreachable | null
// A worktree's PR once it reads MERGED or CLOSED, as the hold check's freed: its head beside its number and state, or undefined while it reads OPEN or GitHub cannot read it. The hold check frees a row naming the worktree by its branch or by this PR's number only when the PR's head is the worktree's HEAD; commits past it keep the hold, named with them.
export const freedOf = (
  pr: PrRead,
): { head: string; number: number; state: "CLOSED" | "MERGED" } | undefined =>
  pr && pr !== "none" && !isUnreachable(pr) && pr.state !== "OPEN"
    ? { head: pr.head, number: pr.number, state: pr.state }
    : undefined

// What playground rm reads and calls beyond its words, so a test hands it a mkdtemp machine: the running clones, the folders it starts from, the default branch gh names for a worktree's repo, whether a merged PR holds a commit, every process with a working folder, the ops notify line to the dispatcher, the folders read for links into a worktree, a worktree's PR read by its --pr or else its branch (PrRead), and the session's name.
export type RmDeps = {
  // Each Remove the owner picked on a nightly-clean card, read from the Inbox by its id, or why it did not read; absent where no Inbox is read, which refuses every --card.
  approvals?: (card: string) => Promise<CardPick[] | string>
  clones: () => Clone[]
  data: string
  defaultBranch: (at: string) => string | null
  home: string
  // The live.branch setting, whose worktree rm never removes; it throws when the policy does not parse.
  liveBranch: () => string
  // this machine's short name, the one a card's question names
  machine?: string
  main: string
  merged: (sha: string, at: string) => boolean | null
  // The head of the PR at url once it reads MERGED, from gh in the worktree, else null.
  mergedHead: (path: string, url: string) => string | null
  notify: (text: string) => void
  // The one ssh to a peer: one command it runs on the named peer, or why the peer cannot be reached.
  peer?: (machine: string, command: string) => Promise<{ code: number; out: string }>
  places: () => string[]
  prState: (path: string, pr?: string) => Promise<PrRead>
  procs: () => Proc[] | null
  session: () => Promise<string>
}

// lsof -F's names for each pid: its "p<pid>" line, then each "n<name>" line under it.
const namesByPid = (out: string): Map<number, string[]> => {
  const names = new Map<number, string[]>()
  let pid = 0
  for (const line of out.split("\n"))
    if (line.startsWith("p")) names.set((pid = Number(line.slice(1))), [])
    else if (line.startsWith("n")) names.get(pid)?.push(line.slice(1))
  return names
}

// Each process lsof gives a working folder, with its command line from ps and its unix socket paths from a second lsof.
export const processesOf = (cwds: string, ps: string, sockets: string): Proc[] => {
  const commands = new Map<number, string>()
  for (const line of ps.split("\n")) {
    const row = /^\s*(\d+) (.*)$/.exec(line)
    if (row) commands.set(Number(row[1]), row[2]!)
  }
  const paths = namesByPid(sockets)
  return [...namesByPid(cwds)].flatMap(([pid, [cwd]]) =>
    cwd?.startsWith("/")
      ? [
          {
            command: commands.get(pid) ?? "",
            cwd,
            pid,
            sockets: (paths.get(pid) ?? []).filter((p) => p.startsWith("/")),
          },
        ]
      : [],
  )
}

// run-slot's clone holder line, "<who> <pid> <iso>" then a tab, the source checkout, a tab and the destination, as the clone it names while its pid lives; a line with no source names none.
export const clonesOf = (line: string, alive: (pid: number) => boolean): Clone[] => {
  const [head = "", source, destination] = line.trim().split("\t")
  const [who, pidText] = head.split(" ")
  const pid = Number(pidText)
  return who && Number.isInteger(pid) && source && destination && alive(pid)
    ? [{ destination, pid, source, who }]
    : []
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The clone run-slot's clone lane runs now, from its holder record in the data folder's ops folder, or none.
const clones = (data: string) => (): Clone[] => {
  try {
    return clonesOf(readFileSync(join(data, "ops", "run-slot-clone.holder"), "utf8"), alive)
  } catch {
    return []
  }
}

const output = (argv: string[]): string =>
  Bun.spawnSync(argv, { stderr: "ignore", stdout: "pipe" }).stdout.toString()

// Every process with a working folder, as lsof and ps list them, an agent-browser one with its sockets, or null when lsof lists none.
const processes = (): Proc[] | null => {
  const cwds = output(["lsof", "-d", "cwd", "-Fpn"])
  const ps = output(["ps", "-axo", "pid=,args="])
  const browsers = processesOf(cwds, ps, "").filter((p) => isAgentBrowser(p.command))
  const sockets = browsers.length
    ? output(["lsof", "-a", "-U", "-p", browsers.map((p) => p.pid).join(","), "-Fpn"])
    : ""
  const procs = processesOf(cwds, ps, sockets)
  return procs.length ? procs : null
}

// gh's stdout in the worktree, trimmed, through ghRead, or null when gh cannot answer, a skipped or stopped read included.
const ghOut = (args: string[], at: string): string | null => {
  const run = ghRead(args, { cwd: at })
  return "code" in run && run.code === 0 ? run.out.trim() : null
}

// Whether a merged PR holds the commit, from GitHub's REST list of the commit's PRs in the worktree's own repository, or null when gh cannot answer.
const merged = (sha: string, at: string): boolean | null => {
  const out = ghOut(
    ["api", `repos/{owner}/{repo}/commits/${sha}/pulls`, "--jq", "any(.[]; .merged_at != null)"],
    at,
  )
  return out === "true" || out === "false" ? out === "true" : null
}

// The default branch gh names for the worktree's repository, or null when gh cannot answer.
const defaultBranch = (at: string): string | null =>
  ghOut(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], at) ||
  null

// Pure: a worktree's PR state, counted only when exactly one PR answers, since a branch name used twice can find another's, that PR is this worktree's own (its branch is the worktree's, or its head is HEAD, so a stacked child does not pass under its parent's PR), and its head is HEAD or an ancestor of it; "none" when gh's list is empty; else null.
export const prStateOf = (
  prs: { headRefName: string; headRefOid: string; number: number; state: PrState }[] | null,
  at: { branch: string | null; head: string },
  holds: (sha: string) => boolean,
): Pr | "none" | null => {
  if (prs?.length === 0) return "none"
  const only = prs?.length === 1 ? prs[0]! : null
  if (!only || (only.headRefName !== at.branch && only.headRefOid !== at.head)) return null
  return only.headRefOid === at.head || holds(only.headRefOid)
    ? { head: only.headRefOid, number: only.number, state: only.state }
    : null
}

// The head of the PR at url once it reads MERGED, from gh in the worktree through ghRead, by the URL so it answers for that PR's own repo; null while it reads open or closed, or when gh cannot answer, a skipped or stopped read included.
const mergedHead = (path: string, url: string): string | null =>
  ghOut(
    [
      "pr",
      "view",
      url,
      "--json",
      "state,headRefOid",
      "--jq",
      'if .state == "MERGED" then .headRefOid else "" end',
    ],
    path,
  ) || null

// The worktree's own PR number as a holder field, from rm's prState answer, none when it names no PR or gh was unreachable.
export const ownPrOf = (own: PrRead | undefined): { ownPr?: number } =>
  own && own !== "none" && !isUnreachable(own) ? { ownPr: own.number } : {}

// A worktree's PR state from gh in it through ghRead, the --pr URL's else its branch's, by prStateOf, unreachable when ghRead skips or stops gh, or null when gh or git cannot answer.
const prState = async (path: string, pr?: string): Promise<PrRead> => {
  const gh = (args: string[]): unknown => {
    try {
      const run = ghRead(args, { cwd: path })
      if (isUnreachable(run)) return run
      return run.code === 0 ? JSON.parse(run.out) : null
    } catch {
      return null
    }
  }
  const head = gitIn(path, "rev-parse", "HEAD")
  if (!head.ok) return null
  const named = gitIn(path, "symbolic-ref", "--quiet", "--short", "HEAD")
  const branch = named.ok ? named.out : null
  if (!pr && !branch) return null
  const fields = ["--json", "headRefName,headRefOid,number,state"]
  const list = pr
    ? gh(["pr", "view", pr, ...fields, "--jq", "[.]"])
    : gh(["pr", "list", "--head", branch!, "--state", "all", "--limit", "2", ...fields])
  if (isUnreachable(list)) return list
  const states = new Set(["CLOSED", "MERGED", "OPEN"])
  const prs =
    Array.isArray(list) && list.every((p) => states.has(p?.state) && Number.isInteger(p?.number))
      ? list
      : null
  return prStateOf(
    prs,
    { branch, head: head.out },
    (sha) => gitIn(path, "merge-base", "--is-ancestor", sha, "HEAD").ok,
  )
}

// This machine's: run-slot's running clone, HOME, the data folder, the main checkout, gh for a repo's default branch and a merged PR, notify.sh to the dispatcher, linkPlaces' temp and scratchpad folders, lsof and ps, and the Claude Code registry's name for this session, else "shell".
export const rmDeps = (repo: string): RmDeps => ({
  clones: clones(dataDir()),
  data: dataDir(),
  defaultBranch,
  home: homedir(),
  liveBranch,
  main: mainCheckout(repo),
  merged,
  mergedHead,
  notify: (text) =>
    void Bun.spawnSync(["bash", join(repo, "scripts", "ops", "notify.sh"), "safe-delete", text], {
      env: { ...process.env, NOTIFY_TO: "dispatcher" },
      stderr: "ignore",
      stdout: "ignore",
    }),
  // The one ssh to a peer: shape sshArgs's argv, run it, and return its code with its stdout and stderr, where the far end prints a refusal, or why the peer cannot be reached.
  peer: async (machine, command) => {
    const home = homedir()
    const cluster = await peersOf(repo, home)
    if ("why" in cluster) return { code: 1, out: cluster.why }
    const peer = cluster.peers.find((p) => p.name === machine)
    if (!peer) return { code: 1, out: `no peer ${machine} in the cluster` }
    const clone = cloneOf(repo, home)
    if (clone === null) return { code: 1, out: `this checkout is not a plain path under ${home}` }
    const argv = peerArgv(cluster.key, peer.target, clone, command)
    const ran = await Bun.spawn(argv, { stdin: "ignore", stderr: "pipe", stdout: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(ran.stdout).text(),
      new Response(ran.stderr).text(),
      ran.exited,
    ])
    return { code: ran.exitCode ?? 1, out: `${stdout}${stderr}` }
  },
  places: linkPlaces,
  prState,
  procs: processes,
  session: sessionName,
  // the card's picks, counted only on the card as nightly-clean saved it in its state file
  approvals: async (id) => {
    const item = await readCard(async (args) => {
      const read = Bun.spawnSync(
        ["bun", "run", "--silent", "--cwd", mainCheckout(repo), "ask", ...args],
        {
          stderr: "pipe",
          stdout: "pipe",
        },
      )
      // stdout is the card, stderr only on a failure, so --card's stdout parses whole
      return {
        code: read.exitCode,
        out: read.exitCode === 0 ? read.stdout.toString() : `${read.stderr}${read.stdout}`,
      }
    }, id)
    if (typeof item === "string") return item
    try {
      const roster = JSON.parse(readFileSync(join(dataDir(), "roster.json"), "utf8")) as {
        agents?: unknown
      }
      const state = JSON.parse(
        readFileSync(join(dataDir(), "ops", "tick", "nightly-clean.json"), "utf8"),
      ) as { card?: CardState }
      return savedPicks(item, managerOf(roster.agents, "ops"), state.card, id)
    } catch (error) {
      return (error as Error).message
    }
  },
  machine: hostname().split(".")[0]!,
})

const gitIn = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe", stdout: "pipe" })
  return {
    err: run.stderr.toString().trim(),
    ok: run.exitCode === 0,
    out: run.stdout.toString().trim(),
  }
}

// A worktree's git record, read before its move, or undefined when git cannot read it.
export const worktreeGit = (path: string): WorktreeGit | undefined => {
  const sha = gitIn(path, "rev-parse", "HEAD")
  const gitdir = gitIn(path, "rev-parse", "--absolute-git-dir")
  if (!sha.ok || !gitdir.ok) return undefined
  const branch = gitIn(path, "symbolic-ref", "--quiet", "--short", "HEAD")
  return { branch: branch.ok ? branch.out : null, gitdir: gitdir.out, sha: sha.out }
}

// A worktree's own repo, the main checkout or another, whose .git/worktrees/<name> its record folder is.
const repoOf = (git: WorktreeGit): string => dirname(dirname(dirname(git.gitdir)))

// Why a worktree's restore would leave it on another commit or unreadable, or null; a record folder still there is kept as it is.
const relinkRefusal = (main: string, git: WorktreeGit, bundle?: string): string | null => {
  if (existsSync(git.gitdir)) return null
  const at = git.branch
    ? gitIn(main, "rev-parse", "--verify", "--quiet", `refs/heads/${git.branch}`)
    : null
  if (at?.ok && at.out !== git.sha)
    return `the branch ${git.branch} now points at ${at.out}, not ${git.sha}, the commit the worktree held, so the restore leaves both as they are`
  if (at?.ok || gitIn(main, "cat-file", "-e", `${git.sha}^{commit}`).ok) return null
  return `the commit ${git.sha} the worktree held is gone from ${main}, so its restore would leave a folder git cannot read: ${bundle ? `git -C ${main} fetch ${bundle} HEAD brings it back from the bundle --discard kept; ` : ""}${git.branch ? `fetch that commit, run git -C ${main} branch ${git.branch} ${git.sha}, then restore it again` : "fetch that commit, then restore it again"}`
}

// Writes a gone git record back, recreates a gone branch at its commit and rebuilds the index from HEAD, keeping the files: null when done, else the step that failed.
const relink = (path: string, main: string, git: WorktreeGit): string | null => {
  if (existsSync(git.gitdir)) return null
  mkdirSync(git.gitdir, { recursive: true })
  writeFileSync(
    join(git.gitdir, "HEAD"),
    git.branch ? `ref: refs/heads/${git.branch}\n` : `${git.sha}\n`,
  )
  writeFileSync(join(git.gitdir, "commondir"), "../..\n")
  writeFileSync(join(git.gitdir, "gitdir"), `${join(path, ".git")}\n`)
  if (
    git.branch &&
    !gitIn(main, "show-ref", "--verify", "--quiet", `refs/heads/${git.branch}`).ok
  ) {
    const made = gitIn(main, "branch", git.branch, git.sha)
    if (!made.ok) return `git branch ${git.branch} ${git.sha} failed: ${made.err}`
  }
  const reset = gitIn(path, "reset", "-q")
  return reset.ok ? null : `git reset -q failed: ${reset.err}`
}

// playground rm: one quarantine, list or restore against the deps' HOME, main checkout and trash; a protected or tripwire refusal goes to the dispatcher; exit 0 done, 1 refused, 2 a usage error.
export async function runRm(words: string[], deps: RmDeps): Promise<number> {
  const args = rmArgs(words)
  if ("error" in args) {
    console.error(`playground: ${args.error}`)
    return 2
  }
  const roots: Roots = { home: deps.home, main: deps.main, trash: join(deps.data, "trash") }
  if ("list" in args) {
    for (const entry of listTrash(roots.trash))
      console.log(
        `${entry.id}  ${entry.path}  ${entry.files} files, ${entry.size} bytes, by ${entry.session}: ${entry.reason}`,
      )
    return 0
  }
  const kept =
    "restore" in args
      ? listTrash(roots.trash).find((entry) => entry.id === args.restore)
      : undefined
  const keptGit = kept?.git
  const relinkRefused = keptGit && relinkRefusal(repoOf(keptGit), keptGit, kept?.bundle)
  if (relinkRefused) {
    console.error(`playground: ${relinkRefused}`)
    return 1
  }
  if ("restore" in args) {
    const done = restore(args.restore, roots)
    if ("refused" in done) {
      if (done.kind !== "refused") deps.notify(`restore: ${done.refused}`)
      console.error(`playground: ${done.refused}`)
      return 1
    }
    const relinked = keptGit ? relink(done.path, repoOf(keptGit), keptGit) : null
    if (relinked) {
      console.error(`playground: restored ${done.path}, but git cannot read it yet: ${relinked}`)
      return 1
    }
    console.log(
      `Restored ${done.path}${kept?.stripped ? ", and a bun install in it rebuilds what the strip removed" : ""}`,
    )
    return 0
  }
  const folders = (await readRecord(deps.data).catch(() => ({ entries: [] }))).entries
    .filter((e) => e.kind === "folder")
    .map((e) => e.path)
  if (args.card !== undefined) {
    if (!CARD_ID.test(args.card)) {
      console.error(`playground: ${args.card} is not an Inbox card id`)
      return 2
    }
    return removeApproved(args, args.card, folders, roots, deps)
  }
  if (
    args.worktree &&
    !worktreeRepo(args.path, roots) &&
    replayPlace(args.path, deps.home, folders)
  ) {
    if (args.discard || args.pr !== undefined) {
      console.error(
        `playground: ${args.path} is a replay worktree, which takes neither --discard nor --pr: its work is written to ${args.path}.diff first`,
      )
      return 2
    }
    const done = removeReplay(args.path, { folders, procs: deps.procs() }, roots)
    if ("refused" in done) {
      console.error(`playground: ${done.refused}`)
      return 1
    }
    console.log(`Removed the replay worktree ${args.path}; its work is kept in ${done.diff}`)
    return 0
  }
  const moved = await removePath(args, await deps.session(), deps, (line) =>
    console.log(`playground: ${line}`),
  )
  if (!moved.ok) {
    console.error(`playground: ${moved.line}`)
    return 1
  }
  console.log(moved.line)
  return 0
}

// Pure: the far end's command for one approved weights path on a peer, each word single-quoted, since peerArgv hands it to the peer's shell.
export const rmPeerCommand = (path: string, bytes: number, card: string): string =>
  [
    "packages/scripts/src/playground/rm-peer.ts",
    ...[path, String(bytes), card].map((word) => `'${word.replaceAll("'", `'\\''`)}'`),
  ].join(" ")

// The approved weights one path names, deleted outright and logged in <trash>/deleted.jsonl: the shard set it is, if so, each shard at its own size, else the one path, or why its size changed and it stays.
const approvedWeights = (
  path: string,
  opts: {
    approved: { bytes: number; card: string }
    folders: string[]
    reason: string
    session: string
  },
  roots: Roots,
): { paths: string[]; size: number; shards?: number } | Refusal => {
  const set = shardSet(path)
  if (!set) {
    const done = deleteWeights(path, opts, roots)
    return "refused" in done ? done : { paths: [path], size: done.size }
  }
  const done = removeSet(
    set,
    { bytes: opts.approved.bytes, card: opts.approved.card },
    { folders: opts.folders, reason: opts.reason, session: opts.session },
    roots,
  )
  if ("refused" in done) return done
  return { paths: done.paths, size: done.size, shards: set.length }
}

// playground rm --card: the path removed only as the owner's Remove on that nightly-clean card names it, on this machine at the size it showed: weights deleted outright (deleteWeights), anything else moved to the trash whole (quarantine's approved), and its machine record entry dropped once it is gone.
async function removeApproved(
  args: { path: string; peer?: string; reason: string },
  card: string,
  folders: string[],
  roots: Roots,
  deps: RmDeps,
): Promise<number> {
  const picks = deps.approvals ? await deps.approvals(card) : "no Inbox is read here"
  if (typeof picks === "string") {
    console.error(`playground: card ${card} did not read: ${picks}`)
    return 1
  }
  const machine = args.peer ?? deps.machine
  const pick = picks.find((p) => p.path === args.path && p.machine === machine)
  if (!pick) {
    console.error(
      `playground: card ${card} holds no Remove answer from the owner for ${args.path} on ${args.peer ?? deps.machine ?? "this machine"}, so it stays`,
    )
    return 1
  }
  // A peer's pick: one narrow ssh to that peer, whose far end re-checks the path and deletes it there; nothing on this machine is touched, its own copy at the same path and its record included.
  const session = await deps.session()
  if (args.peer !== undefined) {
    if (!deps.peer) {
      console.error(`playground: ${args.path} is on ${args.peer}, not this machine, so it stays`)
      return 1
    }
    const ran = await deps.peer(args.peer, rmPeerCommand(args.path, pick.bytes, card))
    if (ran.code !== 0) {
      const said = ran.out.trim().replace(/^playground: /, "")
      const refused = said || "the peer did not answer"
      // a plain refusal (exit 1) stays quiet, as a local one does; a protected or tripwire one (exit 3), silence or a failed ssh reaches the dispatcher
      if (ran.code !== 1 || !said) deps.notify(`${session}: ${refused}`)
      console.error(`playground: ${args.peer}: ${refused}`)
      return 1
    }
    console.log(ran.out.trim())
    return 0
  }
  const approved = { bytes: pick.bytes, card }
  let line: string
  let drop: string[]
  if (isWeights(args.path, deps.home, folders)) {
    const done = approvedWeights(
      args.path,
      { approved, folders, reason: args.reason, session },
      roots,
    )
    if ("refused" in done) {
      if (done.kind !== "refused") deps.notify(`${session}: ${done.refused}`)
      console.error(`playground: ${done.refused}`)
      return 1
    }
    line = done.shards
      ? `Deleted the ${done.shards} shards outright (${done.size} bytes), as card ${card} approved on this machine; ${join(roots.trash, "deleted.jsonl")} logs it`
      : `Deleted ${args.path} outright (${done.size} bytes), as card ${card} approved; ${join(roots.trash, "deleted.jsonl")} logs it`
    drop = done.paths
  } else {
    const done = quarantine(args.path, { approved, reason: args.reason, session }, roots)
    if ("refused" in done) {
      if (done.kind !== "refused") deps.notify(`${session}: ${done.refused}`)
      console.error(`playground: ${done.refused}`)
      return 1
    }
    line = `Moved to the trash as ${done.id} (${done.files} files), as card ${card} approved; playground rm --restore ${done.id} brings it back`
    drop = [args.path]
  }
  const dropped = await dropPaths(deps.data, drop).catch(() => [])
  const suffix = dropped.length
    ? `its machine record ${drop.length > 1 ? "entries are" : "entry is"} dropped`
    : ""
  console.log(suffix ? `${line}; ${suffix}` : line)
  return 0
}

// One move into the trash charged to session, the name whose per-minute cap it spends: playground rm's with the session's own name, and auto-end's with the ended session's, so the holder checks, the cap and the move live here alone; a protected or tripwire refusal goes to the dispatcher.
export async function removePath(
  args: { discard: boolean; path: string; pr?: string; reason: string; worktree: boolean },
  session: string,
  deps: RmDeps,
  note: (line: string) => void,
): Promise<{ line: string; ok: boolean }> {
  const roots: Roots = { home: deps.home, main: deps.main, trash: join(deps.data, "trash") }
  const git = args.worktree ? worktreeGit(args.path) : undefined
  const repo = args.worktree ? worktreeRepo(args.path, roots) : null
  // a MERGED or CLOSED PR frees its worktree from a roster row naming its branch; an unreadable one keeps the row's hold; on gh's clean answer of no PR alone, another repo's worktree may go once archiveUnlanded, with every remote read, archives its commits no remote holds
  const own = args.worktree ? await deps.prState(args.path, args.pr) : undefined
  if (isUnreachable(own))
    return {
      line: `gh unreachable: can't check the branch's PR; retry once gh answers (${own.unreachable})`,
      ok: false,
    }
  const freed = own === undefined ? undefined : freedOf(own)
  let dashboardBranch: string | undefined
  if (args.worktree)
    try {
      dashboardBranch = deps.liveBranch()
    } catch (error) {
      return {
        line: `the live.branch setting cannot be read (${(error as Error).message}), so no worktree is removed`,
        ok: false,
      }
    }
  const done = quarantine(
    args.path,
    {
      ...(git ? { git } : {}),
      ended: { live: STATUSES.live, roster: join(deps.data, "roster.json") },
      reason: args.reason,
      session,
      worktree: args.worktree
        ? {
            ...(own === "none" ? { archive: join(deps.data, "scratchpad", "archive") } : {}),
            clones: deps.clones,
            defaultBranch: deps.defaultBranch,
            discard: args.discard,
            ...(freed ? { freed } : {}),
            live: STATUSES.live,
            ...(dashboardBranch ? { liveBranch: dashboardBranch } : {}),
            merged: deps.merged,
            mergedHead: (url: string) => deps.mergedHead(args.path, url),
            note,
            ...ownPrOf(own),
            places: deps.places,
            ...(args.pr ? { pr: args.pr } : {}),
            procs: deps.procs(),
            roster: join(deps.data, "roster.json"),
          }
        : undefined,
    },
    roots,
  )
  if ("refused" in done) {
    if (done.kind !== "refused") deps.notify(`${session}: ${done.refused}`)
    return { line: done.refused, ok: false }
  }
  if (repo) Bun.spawnSync(["git", "-C", repo, "worktree", "prune"])
  return {
    line: `Moved to the trash as ${done.id} (${done.files} files); playground rm --restore ${done.id} brings it back${done.stripped ? ", and a bun install in it rebuilds what the strip removed" : ""}${done.stripFailed ? ` (the strip stopped partway: ${done.stripFailed}; the hourly strip takes the rest)` : ""}${done.bundle ? `; its commits no remote holds are kept in ${done.bundle}, which git -C ${repo ?? deps.main} fetch ${done.bundle} HEAD brings back` : ""}`,
    ok: true,
  }
}
