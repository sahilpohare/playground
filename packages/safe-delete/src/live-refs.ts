// The live read of a remote's branches that unpushed (index.ts) and the push scans share: commit-trailer's pre-push step and the push-scan guards, which import this file by its relative source path, since index.ts imports @packages/config by its package name and a guard imports no workspace package (scripts/hooks/role.ts).
import { AsyncLocalStorage } from "node:async_hooks"

export type Tip = { ref: string; sha: string }

// A hook call's budget: the time every live read inside it may take in all, and each remote's read, so several scans in one call read a remote once and a hung remote holds the call for the budget alone.
type Budget = { reads: Map<string, Tip[] | null>; until: number }
const budget = new AsyncLocalStorage<Budget>()

// Runs body under one budget of ms for every heldBy read inside it, held in its async context so overlapping calls in one process never share it; a body already under one keeps that one.
export function withLiveBudget<T>(body: () => T, ms = 6_000): T {
  return budget.getStore()
    ? body()
    : budget.run({ reads: new Map(), until: performance.now() + ms }, body)
}

const run = (at: string, args: string[], env?: Record<string, string>, timeout?: number) => {
  const proc = Bun.spawnSync(["git", "-C", at, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
    timeout,
  })
  return { ok: proc.exitCode === 0, out: proc.stdout.toString() }
}

// Each branch tip git ls-remote reads from remote (a configured name or a URL) itself, as <remote>/<branch> at its sha, since a remote-tracking ref is only the remote's last fetch; null when it cannot read the remote in timeout ms, with ssh and credentials never prompting.
export function liveHeads(at: string, remote: string, timeout: number): Tip[] | null {
  // ssh's options go on the command git would run (GIT_SSH_COMMAND, else core.sshCommand, else ssh), and none under GIT_SSH alone, whose program may take no -o
  const command =
    process.env.GIT_SSH_COMMAND ||
    run(at, ["config", "--get", "core.sshCommand"]).out.trim() ||
    (process.env.GIT_SSH ? "" : "ssh")
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" }
  if (command) env.GIT_SSH_COMMAND = `${command} -o BatchMode=yes -o ConnectTimeout=10`
  const live = run(at, ["ls-remote", "--heads", "--", remote], env, timeout)
  if (!live.ok) return null
  const tips: Tip[] = []
  for (const line of live.out.split("\n")) {
    const [sha, name] = line.split("\t")
    if (/^[0-9a-f]{40,64}$/.test(sha ?? "") && name?.startsWith("refs/heads/"))
      tips.push({ ref: `${remote}/${name.slice("refs/heads/".length)}`, sha: sha! })
  }
  return tips
}

// The tips this repo has, or null when git cannot read them.
export function present(at: string, tips: Tip[]): Tip[] | null {
  if (!tips.length) return []
  const had = run(at, ["rev-list", "--no-walk", "--ignore-missing", ...tips.map((t) => t.sha)])
  if (!had.ok) return null
  const here = new Set(had.out.split("\n").filter(Boolean))
  return tips.filter((t) => here.has(t.sha))
}

// The remote a push of branch (by default the checked-out one) with none named goes to, in git's order: branch.<branch>.pushRemote, remote.pushDefault, branch.<branch>.remote, else origin.
export function pushRemote(
  at: string,
  branch = run(at, ["symbolic-ref", "-q", "--short", "HEAD"]).out.trim(),
): string {
  const config = (key: string) => run(at, ["config", "--get", key]).out.trim() || undefined
  return (
    (branch && config(`branch.${branch}.pushRemote`)) ||
    config("remote.pushDefault") ||
    (branch && config(`branch.${branch}.remote`)) ||
    "origin"
  )
}

// What a push scan to remote leaves out, as git rev-list words after --not: each live tip of remote this repo has, and for a live branch whose tip it lacks that branch's own remote-tracking ref, the remote's last fetch of it, which stands in until a fetch, since a push only moves it on unless that branch was force-pushed; none when the remote cannot be read in timeout ms, or in what is left of the call's budget (withLiveBudget), so every local commit is scanned.
export function heldBy(at: string, remote: string, timeout = 5_000): string[] {
  const call = budget.getStore()
  const key = `${at}\0${remote}`
  let live = call?.reads.get(key)
  if (live === undefined) {
    const left = call ? Math.floor(call.until - performance.now()) : timeout
    live = left > 0 ? liveHeads(at, remote, Math.min(timeout, left)) : null
    call?.reads.set(key, live)
  }
  if (!live?.length) return []
  const here = present(at, live) ?? []
  const had = new Set(here.map((t) => t.ref))
  const tracked = new Map<string, string>()
  if (live.length > here.length && !/[:/\\]/.test(remote))
    for (const line of run(at, [
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      `refs/remotes/${remote}/`,
    ]).out.split("\n")) {
      const [sha, ref] = line.split(" ")
      if (sha && ref) tracked.set(ref.slice("refs/remotes/".length), sha)
    }
  return [
    ...here.map((t) => t.sha),
    ...live.flatMap((t) => (had.has(t.ref) || !tracked.has(t.ref) ? [] : [tracked.get(t.ref)!])),
  ]
}
