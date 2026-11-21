import { spawn } from "node:child_process"
import { mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { spawnEnv } from "@packages/env/api-hono"

import { currentSource, type DashboardSource, ensureFixture } from "@/lib/dashboard/fixture"
import { restoreMain } from "@/lib/dashboard/restore"
import { dataDir } from "@/lib/sessions/paths"

// The System page's Restart herdr: `playground herdr restart` from the main checkout, started detached in its own process group, since it stops the herdr servers this API runs in and so outlives it; its lines go to the data folder's ops/herdr-restart.log. A fixture stack spawns nothing: it records the press in the fixture's scratch folder.

export class HerdrRestartError extends Error {}

// A restart takes this API down within seconds, so a second press inside this long is the same restart.
const HOLD_MS = 120_000

let startedAt = 0

export function restartHerdr({
  main = restoreMain(),
  now = Date.now(),
  source = currentSource(),
}: { main?: string | null; now?: number; source?: DashboardSource } = {}): { log: string } {
  if (now - startedAt < HOLD_MS) throw new HerdrRestartError("A restart is already running")
  if (source.kind === "fixture") {
    const file = join(ensureFixture(source), "herdr-restart.json")
    writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString() }))
    startedAt = now
    return { log: file }
  }
  if (source.kind !== "live" || !main) throw new HerdrRestartError("This stack runs no herdr")
  const ops = join(dataDir(), "ops")
  mkdirSync(ops, { recursive: true })
  const log = join(ops, "herdr-restart.log")
  const out = openSync(log, "a")
  const child = spawn(
    process.execPath,
    ["--no-env-file", join(main, "packages/scripts/src/playground/cli.ts"), "herdr", "restart"],
    { cwd: main, detached: true, env: spawnEnv(), stdio: ["ignore", out, out] },
  )
  child.unref()
  startedAt = now
  return { log }
}
