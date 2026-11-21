import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LIMITS, MARKER, makeScratch } from "../../../../../packages/safe-delete/src"
import {
  clearRehearsal,
  newRehearsal,
  REHEARSAL_PREFIX,
} from "../../../../../packages/scripts/src/ship/rehearsal"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const tmp = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ship-rehearsal-")))
  dirs.push(root)
  return root
}
// A sparse file of 3 GB, past the trash's 2 GB cap, which takes no real disk.
const big = (dir: string): void => {
  const at = join(dir, "home", ".bun", "cache.bin")
  mkdirSync(join(dir, "home", ".bun"), { recursive: true })
  writeFileSync(at, "")
  truncateSync(at, 3 * 1024 ** 3)
  expect(statSync(at).size).toBeGreaterThan(LIMITS.bytes)
}

describe("ship:rehearsal", () => {
  test("clear removes the rehearsal's own folder past the trash's 2 GB cap", () => {
    const t = tmp()
    const dir = newRehearsal(t)
    expect(dir.startsWith(join(t, REHEARSAL_PREFIX))).toBe(true)
    expect(existsSync(join(dir, MARKER))).toBe(true)
    big(dir)
    expect(clearRehearsal(dir, t)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test("clear refuses a folder over 2 GB the rehearsal did not make", () => {
    const t = tmp()
    const unmarked = join(t, `${REHEARSAL_PREFIX}130b`)
    big(unmarked)
    expect(clearRehearsal(unmarked, t)).toContain(MARKER)
    const other = makeScratch("test-sandbox-", t)
    big(other)
    expect(clearRehearsal(other, t)).toContain("not a rehearsal folder")
    const deeper = newRehearsal(newRehearsal(t))
    big(deeper)
    expect(clearRehearsal(deeper, t)).toContain("temp folder")
    for (const dir of [unmarked, other, deeper]) expect(existsSync(dir)).toBe(true)
  })

  test("the command makes a folder in its TMPDIR and clears it, and refuses a usage it does not know", () => {
    const t = tmp()
    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", "packages/scripts/src/ship/rehearsal.ts", ...args], {
        cwd: join(import.meta.dir, "..", "..", "..", "..", ".."),
        env: { ...process.env, TMPDIR: t },
      })
    const made = run("new")
    expect(made.exitCode).toBe(0)
    const dir = made.stdout.toString().trim()
    expect(dir.startsWith(join(t, REHEARSAL_PREFIX))).toBe(true)
    big(dir)
    const cleared = run("clear", dir)
    expect(cleared.exitCode).toBe(0)
    expect(existsSync(dir)).toBe(false)
    const kept = run("clear", join(t, "elsewhere"))
    expect(kept.exitCode).toBe(1)
    expect(kept.stderr.toString()).toContain("kept")
    expect(run("remove").exitCode).toBe(1)
  })
})
