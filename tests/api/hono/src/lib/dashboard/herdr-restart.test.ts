import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  HerdrRestartError,
  restartHerdr,
} from "../../../../../../api/hono/src/lib/dashboard/herdr-restart"

const scratch = mkdtempSync(join(tmpdir(), "herdr-restart-"))
const saved = process.env.PLAYGROUND_FIXTURE_DIR
beforeAll(() => {
  process.env.PLAYGROUND_FIXTURE_DIR = join(scratch, "fixture")
})
afterAll(() => {
  if (saved === undefined) delete process.env.PLAYGROUND_FIXTURE_DIR
  else process.env.PLAYGROUND_FIXTURE_DIR = saved
  rmSync(scratch, { force: true, recursive: true })
})

const fixture = { file: null, kind: "fixture", rule: "test" } as const
// The hold is the module's own, so each test presses at a time past the one before it.
const HOUR = 3_600_000

test("a fixture stack spawns nothing and records the press in its scratch folder", () => {
  const { log } = restartHerdr({ main: "/nowhere", now: HOUR, source: fixture })
  expect(existsSync(log)).toBe(true)
  expect(JSON.parse(readFileSync(log, "utf8")).at).toBe(new Date(HOUR).toISOString())
})

test("a second press while a restart runs is refused", () => {
  restartHerdr({ main: "/nowhere", now: 2 * HOUR, source: fixture })
  expect(() => restartHerdr({ main: "/nowhere", now: 2 * HOUR + 1000, source: fixture })).toThrow(
    HerdrRestartError,
  )
})

test("a hosted build, or a live stack with no main checkout, is refused", () => {
  expect(() =>
    restartHerdr({ main: "/nowhere", now: 3 * HOUR, source: { kind: "hosted" } }),
  ).toThrow("This stack runs no herdr")
  expect(() =>
    restartHerdr({ main: null, now: 4 * HOUR, source: { kind: "live", rule: "own" } }),
  ).toThrow("This stack runs no herdr")
})
