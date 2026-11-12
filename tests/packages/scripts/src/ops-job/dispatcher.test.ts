import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assistantOf,
  busyOf,
  stuckOf,
} from "../../../../../packages/scripts/src/ops-job/dispatcher"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-"))
  dirs.push(dir)
  return dir
}

const ASSISTANT = "k3m9px-worker"

describe("stuckOf", () => {
  test("names the dispatcher's stuck or failed record once it has stood over 3 minutes, and nothing for another session or a fresh one", async () => {
    const data = scratch()
    const config = scratch()
    mkdirSync(join(config, "sessions"))
    mkdirSync(join(data, "session-state"))
    const live = (id: string, name: string) =>
      writeFileSync(
        join(config, "sessions", `${id}.json`),
        JSON.stringify({ name, pid: process.pid, sessionId: id }),
      )
    const state = (id: string, s: string, at: string) =>
      writeFileSync(
        join(data, "session-state", `${id}.json`),
        JSON.stringify({ at, event: "Notification", sessionId: id, state: s }),
      )
    live("a", "dispatcher")
    live("b", "builder")
    state("b", "stuck", "2026-10-31T06:00:00.000Z")
    const now = Date.parse("2026-10-31T06:10:00Z") / 1000
    expect(await stuckOf("dispatcher", data, config, now)).toBeNull()
    state("a", "stuck", "2026-10-31T06:08:00.000Z")
    expect(await stuckOf("dispatcher", data, config, now)).toBeNull()
    state("a", "failed", "2026-10-31T06:06:00.000Z")
    expect(await stuckOf("dispatcher", data, config, now)).toEqual({
      at: "2026-10-31T06:06:00.000Z",
      state: "failed",
    })
  })

  test("a stuck record its transcript has a newer turn after no longer stands, as stateNow() reads it", async () => {
    const data = scratch()
    const config = scratch()
    mkdirSync(join(config, "sessions"))
    mkdirSync(join(config, "projects", "a-project"), { recursive: true })
    mkdirSync(join(data, "session-state"))
    writeFileSync(
      join(config, "sessions", "a.json"),
      JSON.stringify({ name: "dispatcher", pid: process.pid, sessionId: "a" }),
    )
    writeFileSync(
      join(data, "session-state", "a.json"),
      JSON.stringify({
        at: "2026-10-31T06:00:00.000Z",
        event: "Notification",
        sessionId: "a",
        state: "stuck",
      }),
    )
    const now = Date.parse("2026-10-31T06:10:00Z") / 1000
    const turn = (at: string) =>
      writeFileSync(
        join(config, "projects", "a-project", "a.jsonl"),
        `${JSON.stringify({ timestamp: at, type: "assistant" })}\n`,
      )
    turn("2026-10-31T05:59:00.000Z")
    expect(await stuckOf("dispatcher", data, config, now)).toEqual({
      at: "2026-10-31T06:00:00.000Z",
      state: "stuck",
    })
    turn("2026-10-31T06:01:00.000Z")
    expect(await stuckOf("dispatcher", data, config, now)).toBeNull()
  })
})

describe("assistantOf", () => {
  test("names the live session the roster gives the assistant kind, and none while no live one holds it", async () => {
    const data = scratch()
    expect(await assistantOf(data)).toBeUndefined()
    const roster = (agents: object[]) =>
      writeFileSync(join(data, "roster.json"), JSON.stringify({ agents }))
    roster([{ kind: "assistant", name: ASSISTANT, role: "manager", status: "ended", task: "t" }])
    expect(await assistantOf(data)).toBeUndefined()
    roster([{ kind: "assistant", name: ASSISTANT, role: "manager", status: "working", task: "t" }])
    expect(await assistantOf(data)).toBe(ASSISTANT)
  })
})

describe("busyOf", () => {
  test("reads the dispatcher as busy only while a live session's working record is under 3 minutes old", async () => {
    const data = scratch()
    const config = scratch()
    mkdirSync(join(config, "sessions"))
    mkdirSync(join(data, "session-state"))
    const live = (id: string, name: string) =>
      writeFileSync(
        join(config, "sessions", `${id}.json`),
        JSON.stringify({ name, pid: process.pid, sessionId: id }),
      )
    const state = (id: string, s: string, at: string) =>
      writeFileSync(
        join(data, "session-state", `${id}.json`),
        JSON.stringify({ at, event: "PostToolUse", sessionId: id, state: s }),
      )
    const now = Date.parse("2026-10-31T06:10:00Z") / 1000
    live("a", "dispatcher")
    live("b", "builder")
    state("b", "working", "2026-10-31T06:09:00.000Z")
    expect(await busyOf("dispatcher", data, config, now)).toBe(false)
    state("a", "working", "2026-10-31T06:06:00.000Z")
    expect(await busyOf("dispatcher", data, config, now)).toBe(false)
    state("a", "idle", "2026-10-31T06:09:00.000Z")
    expect(await busyOf("dispatcher", data, config, now)).toBe(false)
    state("a", "working", "2026-10-31T06:09:00.000Z")
    expect(await busyOf("dispatcher", data, config, now)).toBe(true)
  })
})
