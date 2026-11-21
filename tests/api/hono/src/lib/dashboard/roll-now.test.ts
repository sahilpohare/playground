import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RollNowError, requestRoll } from "../../../../../../api/hono/src/lib/dashboard/roll-now"

const scratch = mkdtempSync(join(tmpdir(), "roll-now-"))
const saved = process.env.PLAYGROUND_FIXTURE_DIR
beforeAll(() => {
  process.env.PLAYGROUND_FIXTURE_DIR = join(scratch, "fixture")
})
afterAll(() => {
  if (saved === undefined) delete process.env.PLAYGROUND_FIXTURE_DIR
  else process.env.PLAYGROUND_FIXTURE_DIR = saved
  rmSync(scratch, { force: true, recursive: true })
})

const live = { kind: "live", rule: "live-branch" } as const

test("the live dashboard writes the supervisor's roll-now file", () => {
  const data = join(scratch, "data")
  mkdirSync(join(data, "ops", "dashboard"), { recursive: true })
  const { file } = requestRoll({ data, source: live })
  expect(file).toBe(join(data, "ops", "dashboard", "roll-now"))
  expect(existsSync(file)).toBe(true)
})

test("a fixture stack writes it in its scratch folder", () => {
  const { file } = requestRoll({ source: { file: null, kind: "fixture", rule: "test" } })
  expect(file.startsWith(join(scratch, "fixture"))).toBe(true)
  expect(existsSync(file)).toBe(true)
})

test("a paused supervisor, a missing one, or a stack the supervisor does not roll is refused", () => {
  const paused = join(scratch, "paused")
  mkdirSync(join(paused, "ops", "dashboard"), { recursive: true })
  writeFileSync(join(paused, "ops", "dashboard", "paused"), "")
  expect(() => requestRoll({ data: paused, source: live })).toThrow("paused")
  expect(() => requestRoll({ data: join(scratch, "none"), source: live })).toThrow("not running")
  expect(() => requestRoll({ data: paused, source: { kind: "live", rule: "own" } })).toThrow(
    RollNowError,
  )
  expect(() => requestRoll({ source: { kind: "hosted" } })).toThrow(RollNowError)
})
