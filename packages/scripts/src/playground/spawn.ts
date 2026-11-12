import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { makeScratch, removeScratch } from "@packages/safe-delete"

// The lock one `playground add` holds at a time. Anything else that starts sessions and shares it takes it the same way, a folder holding `pid` renamed into place, so the lock is never seen empty.
export const SPAWN_LOCK = "spawn.lock"

const holder = (lock: string): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(join(lock, "pid"), "utf8"), 10)
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

// Takes the lock in the data folder it is given, or names the pid holding it; a lock whose holder has gone is moved aside and removed, so it is taken over. The lock appears with its pid already inside (a scratch folder of this process's own, renamed into place, which fails while a lock holds its pid), so a start never reads a lock taken a moment ago as abandoned.
export const takeLock = (dir: string): { release: () => void } | { held: number | null } => {
  const lock = join(dir, SPAWN_LOCK)
  mkdirSync(dir, { recursive: true })
  const drop = (path: string) => {
    const refused = removeScratch(path, dir)
    if (refused) console.error(`spawn lock: ${refused}`)
  }
  const mine = makeScratch(`${SPAWN_LOCK}.`, dir)
  writeFileSync(join(mine, "pid"), String(process.pid))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      renameSync(mine, lock)
      // moved aside before its removal, so the lock is never an empty folder a waiter's rename could land on
      return {
        release: () => {
          const aside = `${lock}.free-${crypto.randomUUID()}`
          renameSync(lock, aside)
          drop(aside)
        },
      }
    } catch {
      const pid = holder(lock)
      if (pid !== null) {
        drop(mine)
        return { held: pid }
      }
      const aside = `${lock}.stale-${crypto.randomUUID()}`
      try {
        renameSync(lock, aside)
        drop(aside)
      } catch {
        // released meanwhile
      }
    }
  }
  drop(mine)
  return { held: null }
}

// Runs spawn.sh with the argv addCommand built, under the lock; on a refusal it hands back spawn.sh's own refusal line (else its last stderr line, never a traceback's first) and its exit code.
export const runSpawn = async (
  spawn: string,
  argv: string[],
  dir: string,
): Promise<{ code: number; message: string }> => {
  const lock = takeLock(dir)
  if ("held" in lock)
    return {
      code: 1,
      message: `another start is running${lock.held ? ` (pid ${lock.held})` : ""}; try again once it ends`,
    }
  try {
    const child = Bun.spawn(["bash", spawn, ...argv], {
      stderr: "pipe",
      stdout: "ignore",
    })
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
    const lines = errors.split("\n").filter((line) => line.trim())
    const refusal =
      lines.find((line) => line.startsWith("spawn.sh refuses ")) ??
      lines.at(-1) ??
      `spawn.sh exited ${code}`
    return { code, message: code === 0 ? "" : refusal }
  } finally {
    lock.release()
  }
}

// Pure: the options playground dispatcher takes, --harness codex (claude-code, the default, adds nothing) and --brief <file> under the data folder, a handoff Switch wrote; else the refusal's words.
export const dispatcherOptions = (
  words: string[],
): { brief?: string; harness?: "codex" } | string => {
  const options: { brief?: string; harness?: "codex" } = {}
  for (let i = 0; i < words.length; i += 2) {
    const [flag, value] = [words[i], words[i + 1]]
    if (flag === "--harness" && (value === "codex" || value === "claude-code")) {
      if (value === "codex") options.harness = value
    } else if (flag === "--brief" && value && !value.startsWith("/") && !value.includes(".."))
      options.brief = value
    else return "usage: playground dispatcher [--harness claude-code|codex] [--brief <file>]"
  }
  return options
}

// playground dispatcher: starts the first dispatcher through spawn.sh's manager mode, its brief written once from the template so the owner's own edits stay, or the handoff --brief names, on the harness --harness names; 3 while a session holds its name, 1 with spawn.sh's refusal.
export const startDispatcher = async (o: {
  brief?: string
  data: string
  harness?: "codex"
  live: string[]
  name: string
  spawn: string
  template: string
}): Promise<{ code: 0 | 1 | 3; message: string }> => {
  if (o.live.includes(o.name)) return { code: 3, message: `${o.name} is already running` }
  const brief = o.brief ?? `brief-${o.name}.md`
  mkdirSync(o.data, { recursive: true })
  if (!o.brief && !existsSync(join(o.data, brief))) copyFileSync(o.template, join(o.data, brief))
  const harness = o.harness ? ["--harness", o.harness] : []
  const result = await runSpawn(o.spawn, ["manager", o.name, brief, ...harness], o.data)
  return result.code === 0
    ? { code: 0, message: `Started ${o.name}` }
    : { code: 1, message: result.message }
}
