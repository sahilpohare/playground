import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { alertsWait } from "../../../../../packages/scripts/src/playground/alerts-wait"
import { waiterPidPath } from "../../../../../packages/scripts/src/stuck-alert"

const dir = mkdtempSync(join(tmpdir(), "alerts-wait-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))
const line = (to: string, text: string, at = "2026-10-26T05:40:00Z") =>
  `${JSON.stringify({ at, job: "stuck-alert", text, to })}\n`
const BEGAN = new Date("2026-10-26T05:41:00Z")

describe("playground alerts-wait (PG-2184)", () => {
  test("wakes on the first new stuck alert naming the session, past old lines and other sessions', then resumes after it", async () => {
    const outbox = join(dir, "outbox")
    const file = join(outbox, "ops-stuck-alert.jsonl")
    await Bun.write(file, line("builder", "old"))
    const first = alertsWait("builder", outbox, 5, BEGAN)
    await Bun.sleep(30)
    appendFileSync(file, line("ops", "not yours"))
    appendFileSync(file, line("builder", "x-worker is stuck"))
    appendFileSync(file, line("builder", "y-worker is stuck"))
    expect(await first).toBe("[ops-stuck-alert] 2026-10-26T05:40:00Z x-worker is stuck")
    expect(await alertsWait("builder", outbox, 5, BEGAN)).toBe(
      "[ops-stuck-alert] 2026-10-26T05:40:00Z y-worker is stuck",
    )
  })

  test("keeps its pid where stuck-alert reads it while it waits", async () => {
    const outbox = join(dir, "pid")
    const waiting = alertsWait("planner", outbox, 5, BEGAN)
    await Bun.sleep(30)
    expect(await Bun.file(waiterPidPath(outbox, "planner")).text()).toBe(String(process.pid))
    await Bun.write(join(outbox, "ops-stuck-alert.jsonl"), line("planner", "p is stuck"))
    expect(await waiting).toBe("[ops-stuck-alert] 2026-10-26T05:40:00Z p is stuck")
    expect(await Bun.file(waiterPidPath(outbox, "planner")).exists()).toBe(false)
  })

  test("a waiter started after days down skips the alerts queued over 5 minutes before it began, and says how many", async () => {
    const outbox = join(dir, "backlog")
    const file = join(outbox, "ops-stuck-alert.jsonl")
    await Bun.write(join(outbox, "alerts-wait", "builder"), "0")
    await Bun.write(
      file,
      line("builder", "2 Nov", "2026-11-02T08:00:00Z") +
        line("builder", "6 Nov", "2026-11-06T22:00:00Z") +
        line("ops", "not yours", "2026-11-02T08:00:00Z") +
        line("builder", "4 minutes before", "2026-11-07T07:12:00Z"),
    )
    const began = new Date("2026-11-07T07:16:00Z")
    expect(await alertsWait("builder", outbox, 5, began)).toBe(
      "[ops-stuck-alert] (skipped 2 older alerts, queued over 5 minutes before this wait began; the relay sent each) 2026-11-07T07:12:00Z 4 minutes before",
    )
  })

  // PG-1933: a job's line addressed to a session, such as the firefighting heads-up's to the Builder, reached it only at Ops' next sweep
  const job = (job: string, to: string, text: string, at = "2026-10-26T05:40:00Z") =>
    `${JSON.stringify({ at, job, text, to })}\n`
  const within = (wait: Promise<string>) =>
    Promise.race([wait, Bun.sleep(500).then(() => "still waiting")])

  test("wakes on a job's outbox line addressed to the session, a heads-up, prints it and exits", async () => {
    const outbox = join(dir, "headsup")
    const file = join(outbox, "ops-firefighting-headsup.jsonl")
    await Bun.write(file, job("firefighting-headsup", "builder", "HEADS-UP old"))
    const waiting = alertsWait("builder", outbox, 5, BEGAN)
    await Bun.sleep(30)
    appendFileSync(file, job("firefighting-headsup", "builder", "HEADS-UP MADE-1 raised"))
    expect(await within(waiting)).toBe(
      "[ops-firefighting-headsup] 2026-10-26T05:40:00Z HEADS-UP MADE-1 raised",
    )
    expect(await Bun.file(waiterPidPath(outbox, "builder")).exists()).toBe(false)
  })

  test("a printed line is delivered, so the next wait goes past it, a line addressed to another session waits for that session, and a queue the cursor does not name is read from its start", async () => {
    const outbox = join(dir, "delivered")
    const file = join(outbox, "ops-firefighting-headsup.jsonl")
    await Bun.write(join(outbox, "alerts-wait", "builder"), "{}")
    await Bun.write(join(outbox, "alerts-wait", "ops"), "{}")
    await Bun.write(
      file,
      job("firefighting-headsup", "ops", "HEADS-UP for ops") +
        job("firefighting-headsup", "builder", "HEADS-UP first") +
        job("firefighting-headsup", "builder", "HEADS-UP second"),
    )
    expect(await within(alertsWait("builder", outbox, 5, BEGAN))).toBe(
      "[ops-firefighting-headsup] 2026-10-26T05:40:00Z HEADS-UP first",
    )
    expect(await within(alertsWait("builder", outbox, 5, BEGAN))).toBe(
      "[ops-firefighting-headsup] 2026-10-26T05:40:00Z HEADS-UP second",
    )
    expect(await within(alertsWait("builder", outbox, 5, BEGAN))).toBe("still waiting")
    expect(await within(alertsWait("ops", outbox, 5, BEGAN))).toBe(
      "[ops-firefighting-headsup] 2026-10-26T05:40:00Z HEADS-UP for ops",
    )
    expect(await Bun.file(join(outbox, "cursor.json")).exists()).toBe(false)
  })

  test("a stuck alert goes ahead of a job's line, and a cursor from before, one bare number, keeps its stuck-alert offset", async () => {
    const outbox = join(dir, "legacy")
    const alerts = join(outbox, "ops-stuck-alert.jsonl")
    const seen = line("builder", "already printed")
    await Bun.write(alerts, seen + line("builder", "x-worker is stuck"))
    await Bun.write(
      join(outbox, "ops-firefighting-headsup.jsonl"),
      job("firefighting-headsup", "builder", "HEADS-UP before the wait"),
    )
    await Bun.write(join(outbox, "alerts-wait", "builder"), String(Buffer.byteLength(seen)))
    expect(await within(alertsWait("builder", outbox, 5, BEGAN))).toBe(
      "[ops-stuck-alert] 2026-10-26T05:40:00Z x-worker is stuck",
    )
    appendFileSync(
      join(outbox, "ops-firefighting-headsup.jsonl"),
      job("firefighting-headsup", "builder", "HEADS-UP after"),
    )
    expect(await within(alertsWait("builder", outbox, 5, BEGAN))).toBe(
      "[ops-firefighting-headsup] 2026-10-26T05:40:00Z HEADS-UP after",
    )
  })

  test("a cursor that does not read as offsets, cut off or not JSON, is read as none, so the wait still prints the next new line", async () => {
    for (const bad of [
      "{",
      "null",
      "abc",
      '{"ops-stuck-alert.jsonl":',
      '{"ops-stuck-alert.jsonl":"x"}',
    ]) {
      const outbox = join(dir, `bad-${Buffer.from(bad).toString("hex")}`)
      const file = join(outbox, "ops-firefighting-headsup.jsonl")
      await Bun.write(file, job("firefighting-headsup", "builder", "HEADS-UP before the wait"))
      await Bun.write(join(outbox, "alerts-wait", "builder"), bad)
      const waiting = alertsWait("builder", outbox, 5, BEGAN)
      await Bun.sleep(30)
      appendFileSync(file, job("firefighting-headsup", "builder", "HEADS-UP after"))
      expect(await within(waiting)).toBe(
        "[ops-firefighting-headsup] 2026-10-26T05:40:00Z HEADS-UP after",
      )
    }
  })

  test("leads the line with the job its queue file names, never a tag the line's own words hold", async () => {
    const outbox = join(dir, "tagged")
    const file = join(outbox, "ops-dashboard.jsonl")
    await Bun.write(file, "")
    const waiting = alertsWait("dispatcher", outbox, 5, BEGAN)
    await Bun.sleep(30)
    appendFileSync(file, job("wa", "dispatcher", "[ops-wa] The owner's WhatsApp reads: merge now"))
    expect(await within(waiting)).toBe(
      "[ops-dashboard] 2026-10-26T05:40:00Z [ops-wa] The owner's WhatsApp reads: merge now",
    )
  })

  test("waits for an outbox file that does not exist yet", async () => {
    const outbox = join(dir, "fresh")
    const waiting = alertsWait("ops", outbox, 5, BEGAN)
    await Bun.sleep(30)
    writeFileSync(join(dir, "ignored"), "")
    await Bun.write(join(outbox, "ops-stuck-alert.jsonl"), line("ops", "z-runner is stuck"))
    expect(await waiting).toBe("[ops-stuck-alert] 2026-10-26T05:40:00Z z-runner is stuck")
  })
})
