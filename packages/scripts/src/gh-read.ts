import { readFileSync } from "node:fs"
import { join } from "node:path"

import { dataDir } from "@packages/env/data-dir"

// gh's cap on one read, since every gh call on a locked keyring once hung until its caller's own timeout: past it, ghRead stops gh and answers as its comment says.
export const GH_TIMEOUT_MS = 10_000
export const GH_HANGS = "gh hangs: keyring locked"
export const KEYRING_LOCKED = "sign in at the desktop to unlock the keyring"
export const ghTimedOut = (ms: number): string => `gh timed out after ${ms / 1000} s`
// The gh-auth beat probes each minute while gh fails, its result at most about 90 s old with a 10 s probe and a cycle's 20 s lag, so an older one means the beat has stopped, and reads go back to gh rather than freeze while gh may be fine.
export const GH_STALE_MS = 2 * 60_000

// The gh-auth beat's last probe: when, whether gh read, why not, and the Inbox alert it posted while it failed.
export type GhAuth = { at: string; by?: string; id?: string; ok: boolean; reason?: string }

export const ghAuthPath = (data = dataDir()): string => join(data, "ops", "tick", "gh-auth.json")

// Why gh fails, from the beat's last result while it reads failed and is fresh, else null, so no caller floods a broken gh.
export const ghDown = (path = ghAuthPath(), now = Date.now()): string | null => {
  try {
    const last = JSON.parse(readFileSync(path, "utf8")) as Partial<GhAuth>
    return last.ok === false && now - Date.parse(String(last.at)) <= GH_STALE_MS
      ? last.reason || "gh fails"
      : null
  } catch {
    return null
  }
}

// A gh read ghRead skipped or stopped, with why.
export type Unreachable = { unreachable: string }

export type GhRead = { code: number; out: string } | Unreachable

export const isUnreachable = (value: unknown): value is Unreachable =>
  typeof value === "object" && value !== null && "unreachable" in value

// The line a gh caller answers in place of gh while ghDown names why, else null.
export const ghSkipped = (): string | null => {
  const down = ghDown()
  return down ? `gh unreachable: ${down}` : null
}

// One gh read: skipped while ghDown names a reason, else gh under GH_TIMEOUT_MS, a read past it unreachable as the timeout, or as a keyring failure only while a fresh beat names one; out is stdout alone, and env is passed so gh is found on PATH as it stands now, not as the process started.
export const ghRead = (
  args: string[],
  { cwd, timeoutMs = GH_TIMEOUT_MS }: { cwd?: string; timeoutMs?: number } = {},
): GhRead => {
  const down = ghDown()
  if (down) return { unreachable: down }
  const run = Bun.spawnSync(["gh", ...args], {
    cwd,
    env: process.env,
    stderr: "ignore",
    stdout: "pipe",
    timeout: timeoutMs,
  })
  if (run.exitedDueToTimeout) {
    const beat = ghDown()
    if (beat && [GH_HANGS, KEYRING_LOCKED].some((words) => beat.includes(words)))
      return { unreachable: beat }
    return { unreachable: ghTimedOut(timeoutMs) }
  }
  return { code: run.exitCode ?? 1, out: run.stdout.toString() }
}
