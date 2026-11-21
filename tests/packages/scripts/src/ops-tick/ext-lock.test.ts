import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { extLock } from "../../../../../packages/scripts/src/ops-tick/ext-lock"
import { BEATS, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"

// The scratch folder stays for the system to clear, since a test removes no tree.
const scratch = mkdtempSync(join(tmpdir(), "ext-lock-"))

// One beat run on a data folder of its own, its relock faked to report whether it locked the root.
const beat = async (locked: boolean) => {
  const data = mkdtempSync(join(scratch, "data-"))
  const asked: string[] = []
  const ctx: Context = {
    now: new Date(Date.UTC(2026, 10, 12, 20, 30, 5)),
    ops: join(data, "ops"),
    repo: scratch,
    run: async () => ({ code: 0, out: "" }),
    send: async () => true,
  }
  await extLock((folder) => (asked.push(folder), locked))(ctx)
  return { asked, data, log: join(data, "ops", "log", "ext-lock.log") }
}

test("the ops tick relocks an unlocked root of the data folder, one line in ops/log/ext-lock.log", async () => {
  const { asked, data, log } = await beat(true)
  expect(asked).toEqual([data])
  expect(readFileSync(log, "utf8")).toBe(
    `2026-11-12T20:30:05Z locked ${join(data, "extensions")}\n`,
  )
})

test("a root already locked, or one with no lock to take, writes no line", async () => {
  const { log } = await beat(false)
  expect(existsSync(log)).toBe(false)
})

test("the beat runs every 5 minutes", () => {
  expect(BEATS.find((b) => b.name === "ext-lock")).toMatchObject({
    cron: "*/5 * * * *",
    to: "ops/log/ext-lock.log",
  })
})
