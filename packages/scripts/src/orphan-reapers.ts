// The user's own service manager, the subreaper Linux hands a desktop session's orphans to in place of pid 1.
export const USER_MANAGER = /(^|\/)systemd --user(\s|$)/

export type Row = { command: string; pid: number; ppid: number }

// Pure: who adopts an orphan here: pid 1, or the user manager among self's ancestors, which proves it is this user's, since each user runs one; a shell or launcher between them adopts nothing.
export const reapersOf = (procs: Row[], self: number): Set<number> => {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const reapers = new Set([1])
  const seen = new Set<number>()
  for (let at = byPid.get(self); at && at.pid > 1 && !seen.has(at.pid); at = byPid.get(at.ppid)) {
    seen.add(at.pid)
    if (USER_MANAGER.test(at.command)) reapers.add(at.pid)
  }
  return reapers
}

// Pure: ps -A -o pid=,ppid=,command= rows, each read once.
export const rowsOf = (out: string): Row[] =>
  out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return m ? [{ command: m[3]!, pid: Number(m[1]), ppid: Number(m[2]) }] : []
  })

// reapersOf for this process, from one ps read.
export const orphanReapers = (): Set<number> =>
  reapersOf(
    rowsOf(Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,ppid=,command="]).stdout.toString()),
    process.pid,
  )
