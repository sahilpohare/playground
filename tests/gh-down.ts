import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Runs fn with the data folder a scratch one whose gh sign-in probe result reads failed now, as ops-tick's gh-auth beat leaves it while gh cannot read, then puts PLAYGROUND_DATA_DIR back.
export const withGhDown = async <T>(
  fn: () => T | Promise<T>,
  reason = "gh token invalid",
): Promise<T> => {
  const data = mkdtempSync(join(tmpdir(), "gh-down-"))
  mkdirSync(join(data, "ops", "tick"), { recursive: true })
  writeFileSync(
    join(data, "ops", "tick", "gh-auth.json"),
    JSON.stringify({ at: new Date().toISOString(), ok: false, reason }),
  )
  const saved = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = saved
    rmSync(data, { force: true, recursive: true })
  }
}
