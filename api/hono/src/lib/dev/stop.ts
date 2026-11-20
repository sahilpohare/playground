import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, sep } from "node:path"

import { makeScratch, removeScratch } from "@packages/safe-delete"
import { orphanReapers } from "@packages/scripts/orphan-reapers"

// The launcher records its pid, process group, start time and the stack's task groups in its checkout, so `bun run dev:stop` can end a stack whose starting session has gone, by that record alone, never by a name or a pattern.
export const RECORD = ".turbo/dev.pgid"

// DEV_RECORD lets a test keep the record out of the checkout, as DEV_TURBO_BIN stands in for turbo.
export const recordPath = (root: string, env: Record<string, string | undefined> = process.env) =>
  env.DEV_RECORD || join(root, RECORD)

export type DevRecord = { pgid: number; pid: number; started: string; groups?: GroupRecord[] }

// A task group of the stack, as turbo starts one for each task and portless its app in another: the group and its leader's start, so a reused pid is never mistaken for the stack (a leader whose start differs is a new process, left alone).
export type GroupRecord = { pgid: number; started: string }

const groupRecords = (groups: unknown): GroupRecord[] | undefined =>
  Array.isArray(groups) &&
  groups.every(
    (group): group is GroupRecord =>
      typeof group === "object" &&
      group !== null &&
      Number.isInteger((group as GroupRecord).pgid) &&
      (group as GroupRecord).pgid > 1 &&
      typeof (group as GroupRecord).started === "string" &&
      (group as GroupRecord).started !== "",
  )
    ? (groups as GroupRecord[])
    : undefined

export const formatRecord = (record: DevRecord): string => `${JSON.stringify(record)}\n`

export const parseRecord = (text: string): DevRecord | null => {
  try {
    const { pgid, pid, started, groups } = JSON.parse(text) as Record<string, unknown>
    return Number.isInteger(pid) &&
      Number.isInteger(pgid) &&
      (pid as number) > 1 &&
      (pgid as number) > 1 &&
      typeof started === "string" &&
      started
      ? {
          pgid: pgid as number,
          pid: pid as number,
          started,
          groups: groupRecords(groups),
        }
      : null
  } catch {
    return null
  }
}

export const readRecord = (path: string): DevRecord | null => {
  try {
    return parseRecord(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// Written by the launcher once turbo runs, a dry run aside.
export const writeRecord = (path: string, record: DevRecord): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, formatRecord(record))
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

// A lock left by a process that died inside the few milliseconds it is held
const LOCK_STALE_MS = 5_000

// A rename onto a lock folder that holds anything fails with one of these.
const HELD = new Set(["EEXIST", "ENOTEMPTY"])

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

// The record is only ever created by an atomic link (claimRecord) and only ever removed under this lock, after it is read again, so no start or stop removes a record it has not just judged. The lock is a scratch folder renamed into place, so it always holds makeScratch's marker and its holder's token; a stale one is moved aside, then removed, and a release leaves a lock that holds another's token.
export const underLock = <T>(path: string, run: () => T, busy: T): T => {
  const lock = `${path}.lock`
  const parent = dirname(lock)
  const drop = (dir: string) => {
    const refused = removeScratch(dir, parent)
    if (refused) console.error(`dev record lock: ${refused}`)
  }
  let mine: string
  const token = crypto.randomUUID()
  try {
    mine = makeScratch(`${basename(lock)}.`, parent)
    writeFileSync(join(mine, "owner"), token)
  } catch {
    return busy
  }
  for (let waited = 0; ; waited += 10) {
    try {
      // a rename keeps the folder's time, so it is stamped now, or a lock taken after a wait would read as old
      const now = new Date()
      utimesSync(mine, now, now)
      renameSync(mine, lock)
      break
    } catch (error) {
      if (!HELD.has(code(error) ?? "") || waited >= 2_000) {
        drop(mine)
        return busy
      }
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) {
          const aside = `${lock}.stale-${crypto.randomUUID()}`
          renameSync(lock, aside)
          drop(aside)
        }
      } catch {
        // released meanwhile
      }
      Bun.sleepSync(10)
    }
  }
  try {
    return run()
  } finally {
    // moved aside before its removal, so the lock is never an empty folder a waiter's rename could land on
    const aside = `${lock}.free-${token}`
    if (releasable(lock, aside, token)) drop(aside)
    else console.error(`dev record lock: ${lock} was taken over as stale while held; left as it is`)
  }
}

// Cleared only by the launcher that wrote it, or for it: a newer launcher's record stays.
export const clearRecord = (path: string, pid: number): void =>
  underLock(
    path,
    () => {
      if (readRecord(path)?.pid === pid) rmSync(path, { force: true })
    },
    undefined,
  )

// The launcher calls this every few seconds while its stack runs: it walks its own descendants by parent pid (parentage, never a name) and writes each task group with its leader's start into the record. A launcher killed with no stop then leaves the groups behind, and dev:stop and the next start's claim read them. A group stays on record while it still holds a checkout process, its leader gone included, since the walk no longer sees a group nobody leads.
export const recordLiveGroups = (path: string, root: string, pid: number): void => {
  const record = readRecord(path)
  if (record?.pid !== pid) return
  const procs = processes()
  const led = groupsOf(procs, stackOf(procs, pid), record.pgid)
    .filter((pgid) => pgid !== record.pgid)
    .flatMap((pgid) => {
      const started = startOf(pgid)
      return started ? [{ pgid, started }] : []
    })
  const seen = new Set(led.map((group) => group.pgid))
  const held = (record.groups ?? []).filter(
    (group) => !seen.has(group.pgid) && recordedGroupRuns(group, root, procs),
  )
  const groups = [...led, ...held]
  if (JSON.stringify(groups) === JSON.stringify(record.groups ?? [])) return
  underLock(
    path,
    () => {
      const heldRecord = readRecord(path)
      if (heldRecord?.pid !== pid) return
      // written beside the record and renamed into place, so a reader never sees it half written
      const temp = `${path}.${pid}.tick`
      try {
        writeFileSync(temp, formatRecord({ ...heldRecord, groups }))
        renameSync(temp, path)
      } finally {
        rmSync(temp, { force: true })
      }
    },
    undefined,
  )
}

// ps and lsof in the C locale and UTC, so a start time reads the same whatever the caller's TZ or LC_ALL
const PLAIN = { ...process.env, LC_ALL: "C", TZ: "UTC" }

const read = (argv: string[]): string | null => {
  const result = Bun.spawnSync(argv, { env: PLAIN, stderr: "ignore", stdin: "ignore" })
  const out = result.stdout.toString().trim()
  return result.exitCode === 0 && out ? out : null
}

export const pgidOf = (pid: number): number | null => {
  const pgid = Number(read(["ps", "-o", "pgid=", "-p", String(pid)]))
  return pgid > 0 ? pgid : null
}

// When the process started, as ps prints it: with the pid, it names one process, since a pid is reused only by a process started later.
export const startOf = (pid: number): string | null =>
  read(["ps", "-o", "lstart=", "-p", String(pid)])

export const cwdOf = (pid: number): string | null =>
  read(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    ?.split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1) ?? null

// What ps and lsof say of one pid now; nulls where it no longer runs.
export type Observed = { cwd: string | null; pgid: number | null; started: string | null }

export const observe = (pid: number): Observed => ({
  cwd: cwdOf(pid),
  pgid: pgidOf(pid),
  started: startOf(pid),
})

// Why the recorded group must not be signalled, or null while the launcher that wrote the record still runs, from this checkout, in the group it recorded, which is not the caller's own. `gone` says the launcher itself has gone.
export const unstoppable = (
  record: DevRecord,
  seen: Observed,
  root: string,
  ownPgid: number,
): { gone: boolean; reason: string } | null => {
  if (seen.pgid === null) return { gone: true, reason: `pid ${record.pid} no longer runs` }
  if (seen.started !== record.started) {
    return {
      gone: true,
      reason: `pid ${record.pid} is no longer the launcher that wrote the record`,
    }
  }
  if (seen.pgid !== record.pgid) {
    return { gone: false, reason: `pid ${record.pid} left process group ${record.pgid}` }
  }
  if (seen.cwd !== root) {
    return { gone: false, reason: `pid ${record.pid} runs in ${seen.cwd}, not ${root}` }
  }
  if (seen.pgid === ownPgid) {
    return { gone: false, reason: `process group ${record.pgid} is this command's own` }
  }
  return null
}

export type Proc = { pgid: number; pid: number; ppid: number }

// Every process on the machine with its parent and group, read to learn which of them share the recorded groups; none is signalled from this list.
export const processes = (): Proc[] =>
  (read(["ps", "-A", "-o", "pid=,ppid=,pgid="]) ?? "").split("\n").flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    return pid && pgid && ppid !== undefined ? [{ pgid, pid, ppid }] : []
  })

// The stack's processes: the launcher and all that descend from it, across the process groups they sit in.
export const stackOf = (procs: Proc[], launcher: number): Set<number> => {
  const children = new Map<number, number[]>()
  for (const proc of procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
  const stack = new Set<number>()
  const visit = (pid: number) => {
    if (stack.has(pid)) return
    stack.add(pid)
    for (const child of children.get(pid) ?? []) visit(child)
  }
  visit(launcher)
  return stack
}

// The process groups that hold the stack: the launcher's own, and each one a process of the stack leads, since turbo starts every task in a group of its own and portless its app in another.
export const groupsOf = (procs: Proc[], stack: Set<number>, launcherPgid: number): number[] => [
  ...new Set([
    launcherPgid,
    ...procs.filter((proc) => stack.has(proc.pid) && proc.pgid === proc.pid).map((p) => p.pgid),
  ]),
]

// One line for a recorded group that holds a process that is not the stack's: it is named, and left alone.
const strangerNote = (held: RecordedOutcome): string =>
  `process group ${held.pgid} also holds pid ${(held.others ?? []).join(", ")}, which is not this stack's, so it is left alone`

// The members of those groups that are not the stack's. Besides the stack itself, the launcher's group may hold what started it (the shell and `bun run`), and any of them an orphan (adopted by one of reapers: pid 1, or the user's systemd --user on Linux) whose real working directory is in this checkout, as a task whose parent died is. Anything else shares a group by chance, and stopping it is not this command's to do.
export const strangers = (
  procs: Proc[],
  { pgid, pid }: Pick<DevRecord, "pgid" | "pid">,
  ownOrphan: (pid: number) => boolean,
  reapers: Set<number>,
): number[] => {
  const stack = stackOf(procs, pid)
  const groups = new Set(groupsOf(procs, stack, pgid))
  const parent = new Map(procs.map((proc) => [proc.pid, proc.ppid]))
  const starters = new Set<number>()
  for (let at = parent.get(pid), hops = 0; at && hops < 256; at = parent.get(at), hops++) {
    starters.add(at)
  }
  return procs
    .filter((proc) => groups.has(proc.pgid))
    .filter(
      (proc) =>
        !stack.has(proc.pid) &&
        !(proc.pgid === pgid && starters.has(proc.pid)) &&
        !(reapers.has(proc.ppid) && ownOrphan(proc.pid)),
    )
    .map((proc) => proc.pid)
}

const within = (path: string | null, root: string): boolean =>
  path !== null && (path === root || path.startsWith(root + sep))

// signal 0 tests a group without touching it: it throws once no process in the group is left
const holds = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

// The signal races the group emptying: an ESRCH says the group is already gone, which is the stop's aim met, and any other error is real.
const signalGroup = (pgid: number, signal: NodeJS.Signals | number): void => {
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if (code(error) !== "ESRCH") throw error
  }
}

// Every pid in the recorded group and in the groups its processes lead, as a stack whose launcher has gone still holds them: what a person looks at before stopping anything.
export const leftIn = (procs: Proc[], pgid: number): number[] => {
  const members = procs.filter((proc) => proc.pgid === pgid).map((proc) => proc.pid)
  const reached = new Set(members.flatMap((pid) => [...stackOf(procs, pid)]))
  const groups = new Set([
    pgid,
    ...procs.filter((proc) => reached.has(proc.pid) && proc.pgid === proc.pid).map((p) => p.pgid),
  ])
  return procs.filter((proc) => groups.has(proc.pgid)).map((proc) => proc.pid)
}

// Whether a recorded group still runs as this checkout's stack: one of its members works from inside the checkout. A group number the system has since given to something else holds none, so it reads as gone.
export const groupRuns = (pgid: number, root: string): boolean =>
  holds(pgid) && processes().some((proc) => proc.pgid === pgid && within(cwdOf(proc.pid), root))

// A recorded group counts as the stack's own when a member works from inside the checkout and its leader is the recorded one or gone: a leader whose pid now runs with another start is a new process, not the stack.
const recordedGroupRuns = (group: GroupRecord, root: string, procs: Proc[]): boolean => {
  const started = startOf(group.pgid)
  if (started && started !== group.started) return false
  return procs.some((proc) => proc.pgid === group.pgid && within(cwdOf(proc.pid), root))
}

// The record stays while one of its task groups still holds a checkout process: a task that outlived its launcher, its stop or turbo can then still be ended or named by the record.
export const recordHeld = (record: DevRecord, root: string): boolean => {
  const procs = processes()
  return (record.groups ?? []).some((group) => recordedGroupRuns(group, root, procs))
}

// What became of one recorded group, its members A to Z.
type RecordedOutcome = {
  out: "own" | "quiet" | "reused" | "stopped" | "strangers"
  pgid: number
  others?: number[]
}

// Ends the task groups the record holds. A group is the recorded one while a process with its leader's pid still has the recorded start, or its leader's pid is gone and the group still holds a member working in the checkout: the kernel hands out no pid equal to a process group id that is still in use, so a leader whose pid now runs with another start is a new process, not the stack. Each group reports what became of it, and the caller's own group is never signalled.
const stopRecordedGroups = async (
  record: DevRecord,
  root: string,
  graceMs: number,
  ownPgid: number,
): Promise<RecordedOutcome[]> => {
  const outcomes: RecordedOutcome[] = []
  const procs = processes()
  for (const group of record.groups ?? []) {
    if (ownPgid && group.pgid === ownPgid) {
      outcomes.push({ out: "own", pgid: group.pgid })
      continue
    }
    const started = startOf(group.pgid)
    if (started && started !== group.started) {
      outcomes.push({ out: "reused", pgid: group.pgid })
      continue
    }
    const members = procs.filter((proc) => proc.pgid === group.pgid)
    if (!members.some((proc) => within(cwdOf(proc.pid), root))) {
      outcomes.push({ out: "quiet", pgid: group.pgid })
      continue
    }
    // a member is the stack's own when it works in this checkout, or its parent chain reaches the group's leader inside the group: an orphaned next dev keeps its next-server child in the group, and the launcher that would name the chain is gone
    const parent = new Map(procs.map((proc) => [proc.pid, proc.ppid]))
    const ours = (pid: number): boolean => {
      if (within(cwdOf(pid), root)) return true
      for (let at = parent.get(pid), hops = 0; at && hops < 256; at = parent.get(at), hops++) {
        if (at === group.pgid) return true
      }
      return false
    }
    const others = members.filter((proc) => !ours(proc.pid)).map((proc) => proc.pid)
    if (others.length > 0) {
      outcomes.push({ out: "strangers", pgid: group.pgid, others })
      continue
    }
    signalGroup(group.pgid, "SIGTERM")
    for (let waited = 0; waited < graceMs && holds(group.pgid); waited += 200) await Bun.sleep(200)
    if (holds(group.pgid)) signalGroup(group.pgid, "SIGKILL")
    outcomes.push({ out: "stopped", pgid: group.pgid })
  }
  return outcomes
}

// What of the recorded stack still runs in this checkout, or null: its launcher, or (gone) the groups the launcher left behind. With recorded groups, the orphan is named by member pid and dev:stop can end it by the record.
export const stackRuns = (
  record: DevRecord,
  root: string,
): { gone: boolean; what: string; byRecord?: boolean } | null => {
  const seen = observe(record.pid)
  if (seen.started === record.started && seen.cwd === root) {
    return { gone: false, what: `launcher pid ${record.pid}, process group ${record.pgid}` }
  }
  const procs = processes()
  const members = (record.groups ?? [])
    .filter((group) => recordedGroupRuns(group, root, procs))
    .flatMap((group) =>
      procs
        .filter((proc) => proc.pgid === group.pgid && within(cwdOf(proc.pid), root))
        .map((proc) => proc.pid),
    )
  if (members.length > 0) {
    return {
      gone: true,
      byRecord: true,
      what: `recorded groups still hold pid ${members.join(", ")} in this checkout`,
    }
  }
  if (groupRuns(record.pgid, root)) {
    return {
      gone: true,
      what: `launcher (pid ${record.pid}) has gone, but its process groups still hold pid ${leftIn(procs, record.pgid).join(", ")}`,
    }
  }
  return null
}

// The pre-commit hook's check: a commit's build rebuilds packages/* under a running stack, so it waits until this checkout's stack has stopped.
export const stackIn = (root: string, env: Record<string, string | undefined> = process.env) => {
  const record = readRecord(recordPath(root, env))
  return record && stackRuns(record, root)
}

// What the hook says while stackIn finds a stack: with the launcher gone, dev:stop ends the task groups it recorded, by the record, and anything else it left goes to where it started.
export const commitRefusal = ({
  byRecord,
  gone,
  what,
}: {
  byRecord?: boolean
  gone: boolean
  what: string
}): string =>
  gone
    ? byRecord
      ? `pre-commit: refusing: the recorded stack's ${what}; \`bun run dev:stop\` ends them by their record, then commit, since the commit's build rebuilds packages/* under them`
      : `pre-commit: refusing: the recorded stack's ${what}; end them from where they started, or report them to your lead, then commit, since the commit's build rebuilds packages/* under them`
    : `pre-commit: refusing: this checkout's dev stack runs (${what}); stop it (TaskStop on its task, or \`bun run dev:stop\`), then commit, since the commit's build rebuilds packages/* under it`

// Why a start refuses while stackRuns finds a stack: the launcher's claim says it, and so does `bun run dev`'s check before its prebuild, which would rebuild packages/* under that stack.
export const startRefusal = ({
  byRecord,
  gone,
  what,
}: NonNullable<ReturnType<typeof stackRuns>>): string =>
  gone
    ? `the recorded stack's ${what}; ${byRecord ? "`bun run dev:stop` ends them by their record" : "end them from where they started, or report them to your lead"}, before you start another`
    : `a stack already runs in this checkout (${what}); stop it from the terminal or task that started it, or with \`bun run dev:stop\``

export type Claim = { ok: true; warning?: string } | { ok: false; reason: string }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Taken by the launcher before its checks, so no second start in the checkout runs beside it. The record is written whole to a file of its own, then hard-linked into place, which is atomic and fails where a record already is, so two starts at once never both have it and none ever reads it half written. A record left behind is removed only once nothing it names still runs, under the lock and only if it still reads as judged, then the claim is tried again. A record that cannot be written leaves the stack to run without one, stoppable from where it starts.
export const claimRecord = (path: string, root: string, self: DevRecord): Claim => {
  const unrecorded = (why: string): Claim => ({
    ok: true,
    warning: `could not record the stack in ${path} (${why}), so \`bun run dev:stop\` cannot end it; stop it from here`,
  })
  const whole = `${path}.${self.pid}.${crypto.randomUUID()}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(whole, formatRecord(self))
  } catch (error) {
    return unrecorded(message(error))
  }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(whole, path)
        return { ok: true }
      } catch (error) {
        if (code(error) !== "EEXIST") return unrecorded(message(error))
      }
      let held: string
      try {
        if (!lstatSync(path).isFile()) return unrecorded("it is not a file")
        held = readFileSync(path, "utf8")
      } catch (error) {
        if (code(error) === "ENOENT") continue
        return unrecorded(message(error))
      }
      const record = parseRecord(held)
      const running = record && stackRuns(record, root)
      if (running) return { ok: false, reason: startRefusal(running) }
      // a record nothing runs under any more, or one that does not parse: removed only if it still reads as judged, then the link is tried again
      underLock(
        path,
        () => {
          try {
            if (readFileSync(path, "utf8") === held) rmSync(path, { force: true })
          } catch {
            // gone already
          }
        },
        undefined,
      )
    }
    return { ok: false, reason: `another start claimed ${path} at the same moment; try again` }
  } finally {
    rmSync(whole, { force: true })
  }
}

const branchOf = (root: string): string | null =>
  read(["git", "-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"])

export type Stopped = { groups: number[]; ok: true } | { ok: false; reason: string }

export type StopOptions = {
  // the live dashboard's checkout is stopped only when the caller says so
  liveDashboard?: boolean
  // the live dashboard's branch (live.branch), which the caller reads, since pre-commit's dev-stack step loads this file before any workspace package is built
  liveBranch?: string
  graceMs?: number
  ownPgid?: number
  path?: string
}

// Ends the stack recorded in root. SIGTERM goes to the launcher's group, which passes it to turbo, and turbo stops its tasks; after up to the grace period, SIGKILL goes to each of the stack's groups that still holds a process. A group answers signal 0 until its last member has gone, so one that still answers is the group read at the start. The recorded task groups are ended by the record, with the launcher alive or gone: a group only while a process with its leader's pid still has the recorded start, or its leader is gone and the members left are the stack's own from this checkout, and never while it also holds a stranger. It signals nothing else unless the record still names the launcher that wrote it, running from this checkout, and every member of the stack's groups is the stack's own; and it clears the record only once nothing it names still runs.
export async function stopStack(
  root: string,
  {
    graceMs = 15_000,
    liveDashboard = false,
    liveBranch,
    ownPgid = pgidOf(process.pid) ?? 0,
    path = recordPath(root),
  }: StopOptions = {},
): Promise<Stopped> {
  const record = readRecord(path)
  if (!record) return { ok: false, reason: `no stack is recorded in ${path}` }
  const live = liveDashboard ? undefined : liveBranch
  if (live && branchOf(root) === live) {
    return {
      ok: false,
      reason: `this is the live dashboard's checkout (branch ${live}), so nothing is signalled; its runner stops it, or pass --live-dashboard`,
    }
  }
  const refusal = unstoppable(record, observe(record.pid), root, ownPgid)
  if (refusal?.gone) {
    const outcomes = await stopRecordedGroups(record, root, graceMs, ownPgid)
    const stopped = outcomes.filter((o) => o.out === "stopped").map((o) => o.pgid)
    const reused = outcomes.filter((o) => o.out === "reused").map((o) => o.pgid)
    const strangers_ = outcomes.filter((o) => o.out === "strangers")
    const own_ = outcomes.filter((o) => o.out === "own").map((o) => o.pgid)
    const heldLauncherGroup = groupRuns(record.pgid, root)
    if (
      stopped.length > 0 &&
      reused.length === 0 &&
      strangers_.length === 0 &&
      own_.length === 0 &&
      !heldLauncherGroup
    ) {
      clearRecord(path, record.pid)
      return { groups: stopped, ok: true }
    }
    const notes: string[] = []
    if (stopped.length === 0 && reused.length === 0 && strangers_.length === 0 && own_.length === 0)
      notes.push("nothing in the recorded groups runs from this checkout")
    if (stopped.length > 0) notes.push(`ended process group ${stopped.join(", ")} by the record`)
    if (reused.length > 0)
      notes.push(
        `process group ${reused.join(", ")} holds a pid whose start no longer matches the record, a new process, so it is left alone`,
      )
    for (const held of strangers_) notes.push(strangerNote(held))
    for (const own of own_)
      notes.push(`process group ${own} is this command's own, so it is left alone`)
    if (heldLauncherGroup)
      notes.push(
        `process group ${record.pgid} still holds pid ${leftIn(processes(), record.pgid).join(", ")}`,
      )
    const keep = heldLauncherGroup || strangers_.length > 0 || own_.length > 0
    if (!keep) clearRecord(path, record.pid)
    const parts = [
      ...notes,
      keep
        ? "the record is kept, look at it before you stop anything"
        : "the stale record is cleared",
    ]
    return {
      ok: false,
      reason: [refusal.reason, ...parts].join("; "),
    }
  }
  if (refusal) return { ok: false, reason: `${refusal.reason}, so nothing is signalled` }
  const procs = processes()
  const others = strangers(procs, record, (pid) => within(cwdOf(pid), root), orphanReapers())
  if (others.length > 0) {
    return {
      ok: false,
      reason: `the stack's process groups also hold pid ${others.join(", ")}, which is not this stack's, so nothing is signalled; stop the stack from the terminal or task that started it`,
    }
  }
  const groups = groupsOf(procs, stackOf(procs, record.pid), record.pgid)
  if (ownPgid && groups.includes(ownPgid)) {
    return {
      ok: false,
      reason: `process group ${ownPgid} is this command's own, so nothing is signalled`,
    }
  }
  signalGroup(record.pgid, "SIGTERM")
  for (let waited = 0; waited < graceMs && groups.some(holds); waited += 200) await Bun.sleep(200)
  for (const pgid of groups.filter(holds)) signalGroup(pgid, "SIGKILL")
  // the walk above sees only the groups a live process of the stack leads: a recorded group whose leader has left holds members just the same, so it is ended by the same rule the gone branch uses
  const recorded = await stopRecordedGroups(record, root, graceMs, ownPgid)
  const stoppedRecorded = recorded.filter((outcome) => outcome.out === "stopped").map((o) => o.pgid)
  const strangersLeft = recorded.filter((outcome) => outcome.out === "strangers")
  if (strangersLeft.length > 0) {
    return {
      ok: false,
      reason: [
        `ended process group ${groups.join(", ")}`,
        ...strangersLeft.map(strangerNote),
        "the record is kept, look at it before you stop anything",
      ].join("; "),
    }
  }
  if (recordHeld(record, root)) {
    return {
      ok: false,
      reason: "the record is kept: a recorded group still holds a checkout process",
    }
  }
  clearRecord(path, record.pid)
  return { groups: [...new Set([...groups, ...stoppedRecorded])], ok: true }
}
