import { join } from "node:path"

import type { Context } from "./tick"

// The signal rule's one case beyond a session's own processes: a factory script's orphan, which the nightly-clean beat ends by its own pid once its parent is an orphan's reaper (pid 1, or the user's systemd --user, orphan-reapers.ts) and either its command runs a script from a worktree of this checkout that no longer exists (issue 1346), or its working folder sits under a test run's sandbox that no longer exists (issue 2177) and the session whose temp folder holds that sandbox has ended, so no session and no owner step is left to end it.

// cwd is the process's working folder as lsof names it, read only for a process whose parent is a reaper.
export type Proc = { age: string; command: string; cwd?: string; pid: number; ppid: number }
export type Orphan = Proc & ({ sandbox: string } | { worktree: string })

// Every process with its parent, its age as ps prints it and its whole command; -ww keeps a long command whole.
export const PS = ["ps", "-A", "-ww", "-o", "pid=,ppid=,etime=,command="]
// The working folder of each pid given, whose list follows; lsof still names a folder removed since the process entered it (measured on macOS).
export const CWDS = ["lsof", "-a", "-d", "cwd", "-F", "pn", "-p"]
export const GRACE_MS = 5000

// Pure: ps's rows, each read once.
export const procsOf = (out: string): Proc[] =>
  out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    return m ? [{ age: m[3]!, command: m[4]!, pid: Number(m[1]), ppid: Number(m[2]) }] : []
  })

// Pure: lsof -F pn's rows, each pid with the working folder named after it.
export const cwdsOf = (out: string): Map<number, string> => {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// A dependency's file, never this repo's script: portless's shared proxy runs detached from a stack's node_modules with a reaper as its parent, and every stack routes through it.
const DEPENDENCY = /(^|\/)node_modules(\/|$)/
// A script file, since an app opened on a worktree's folder or a reader of a log there can have a reaper as its parent too.
const SCRIPT = /\.(?:c?js|mjs|py|sh|tsx?)$/
// The innermost test-sandbox-* folder a working folder sits under (sandbox.ts's makeScratch folder), which its run removes as it ends.
const SANDBOX = /^(.*\/test-sandbox-[^/]+)(?:\/|$)/
// The session a sandbox's run belongs to: on Linux each session's temp folder, which spawn.sh makes as /tmp/playground-<name>.<random>, holds the sandboxes its runs make, a sandbox nested in one of them included, so the outermost such folder names it; macOS's per-user temp folder names none.
const SESSION = /\/playground-([^/]+)\.[^./]+\/test-sandbox-/

// Pure but for exists: each process whose parent is in reapers and whose command names a script file of this repo inside a worktree folder of worktrees, never one under node_modules, with every worktree its command names gone; a worktree is read by its whole folder name, so foo never stands for foo-2. Else one whose working folder sits under a test sandbox that is gone, so a live run's child is left alone, and whose session, when the sandbox's path names one, has ended, so a live session's daemon its own test run left is kept too.
export const orphansOf = (
  procs: Proc[],
  worktrees: string,
  exists: (path: string) => boolean,
  reapers: Set<number>,
  ended: (session: string) => boolean,
): Orphan[] => {
  const inside = new RegExp(`${escaped(worktrees)}/([^/\\s'"]+)/([^\\s'"]*)`, "g")
  return procs.flatMap((p): Orphan[] => {
    if (!reapers.has(p.ppid)) return []
    const paths = [...p.command.matchAll(inside)]
    const script = paths.find((m) => SCRIPT.test(m[2]!) && !DEPENDENCY.test(m[2]!))
    const named = new Set(paths.map((m) => join(worktrees, m[1]!)))
    if (script && [...named].every((path) => !exists(path)))
      return [{ ...p, worktree: join(worktrees, script[1]!) }]
    const sandbox = p.cwd && SANDBOX.exec(p.cwd)?.[1]
    if (!sandbox || exists(sandbox)) return []
    const session = SESSION.exec(sandbox)?.[1]
    return !session || ended(session) ? [{ ...p, sandbox }] : []
  })
}

// Each orphan gets TERM, then after the grace KILL when ps still lists its pid with the same command, so a pid reused since the read is never signalled twice; each one is named with how it ended or why it is kept.
export async function endOrphans(
  found: Orphan[],
  run: Context["run"],
  sleep: (ms: number) => Promise<void>,
): Promise<{ ended: string[]; kept: string[] }> {
  const out = { ended: [] as string[], kept: [] as string[] }
  if (!found.length) return out
  for (const o of found) await run(["kill", "-TERM", String(o.pid)])
  await sleep(GRACE_MS)
  const still = procsOf((await run(PS)).out)
  for (const o of found) {
    const gone = "sandbox" in o ? `test sandbox ${o.sandbox}` : `worktree ${o.worktree}`
    const about = `(age ${o.age}, its ${gone} gone): ${o.command}`
    if (!still.some((p) => p.pid === o.pid && p.command === o.command)) {
      out.ended.push(`orphan pid ${o.pid} ended by TERM ${about}`)
      continue
    }
    const kill = await run(["kill", "-KILL", String(o.pid)])
    if (kill.code === 0) out.ended.push(`orphan pid ${o.pid} ended by KILL ${about}`)
    else out.kept.push(`orphan pid ${o.pid} kept: its KILL failed: ${kill.out.trim()} ${about}`)
  }
  return out
}
