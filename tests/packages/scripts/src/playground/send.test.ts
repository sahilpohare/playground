import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { alertsWait } from "../../../../../packages/scripts/src/playground/alerts-wait"
import { extraWordRefusal } from "../../../../../packages/scripts/src/playground/plan"
import {
  MAX_LINE_BYTES,
  PEER_QUEUE,
  peerLine,
  sendPeer,
} from "../../../../../packages/scripts/src/playground/send"

const dir = mkdtempSync(join(tmpdir(), "send-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))
const NOW = new Date("2026-11-16T20:00:00.123Z")
const ID = "0b8f1c9e-2d4a-4e6b-9f1a-3c5d7e9f1a2b"

describe("playground send (PG-2444)", () => {
  test("builds the line {at, from, id, text, to}, at in whole seconds and the text on one line", () => {
    expect(peerLine("probe-b", "  done:\nPR #1 merged \r\n", "probe-a", NOW, ID)).toEqual({
      at: "2026-11-16T20:00:00Z",
      from: "probe-a",
      id: ID,
      text: "done: PR #1 merged",
      to: "probe-b",
    })
  })

  test.each([
    ["Probe B", "hi", "is not a session name"],
    ["-b", "hi", "is not a session name"],
    ["probe-b", " \n ", "the text is blank"],
    ["probe-b", "x".repeat(MAX_LINE_BYTES), "over 16 KB"],
  ])("refuses to %p with text of %#: %s", (to, text, why) => {
    const line = peerLine(to, text, "probe-a", NOW, ID)
    expect("error" in line && line.error).toContain(why)
  })

  test("appends each line whole to the outbox's ops-peer.jsonl", async () => {
    const outbox = join(dir, "append")
    for (const text of ["one", "two"]) {
      const line = peerLine("probe-b", text, "probe-a", NOW, `${ID}-${text}`)
      if ("error" in line) throw new Error(line.error)
      await sendPeer(outbox, line)
    }
    const rows = readFileSync(join(outbox, PEER_QUEUE), "utf8")
      .trim()
      .split("\n")
      .map((r) => JSON.parse(r))
    expect(rows.map((r) => r.text)).toEqual(["one", "two"])
    expect(Object.keys(rows[0]!)).toEqual(["at", "from", "id", "text", "to"])
  })

  test("takes a name and some text, and refuses fewer words", () => {
    expect(extraWordRefusal(["send", "probe-b", "hi", "there"])).toBeNull()
    expect(extraWordRefusal(["send", "probe-b"])).toBe("usage: playground send <name> <text>")
    expect(extraWordRefusal(["send"])).toBe("usage: playground send <name> <text>")
  })
})

describe("alerts-wait reads a peer line (PG-2444)", () => {
  const peer = (text: string, at: string, more: Record<string, string> = {}) =>
    `${JSON.stringify({ at, from: "probe-a", id: crypto.randomUUID(), text, to: "probe-b", ...more })}\n`

  test("prints it led by [ops-peer] and its sender's name", async () => {
    const outbox = join(dir, "wait")
    const waiting = alertsWait("probe-b", outbox, 5, new Date("2026-11-16T20:00:30Z"))
    await Bun.sleep(30)
    appendFileSync(join(outbox, PEER_QUEUE), peer("PR #1 merged", "2026-11-16T20:00:00Z"))
    expect(await waiting).toBe("[ops-peer] 2026-11-16T20:00:00Z probe-a: PR #1 merged")
  })

  test("a line sent during a 10-minute drop prints once, after the drop, its at the sender's, by its relayedAt", async () => {
    const outbox = join(dir, "drop")
    const file = join(outbox, PEER_QUEUE)
    await Bun.write(join(outbox, "alerts-wait", "probe-b"), JSON.stringify({ [PEER_QUEUE]: 0 }))
    await Bun.write(
      file,
      peer("too old", "2026-11-16T19:40:00Z") +
        peer("sent in the drop", "2026-11-16T19:50:00Z", { relayedAt: "2026-11-16T20:00:00Z" }),
    )
    const began = new Date("2026-11-16T20:00:05Z")
    expect(await alertsWait("probe-b", outbox, 5, began)).toBe(
      "[ops-peer] (skipped 1 older alert, queued over 5 minutes before this wait began; the relay sent each) 2026-11-16T19:50:00Z probe-a: sent in the drop",
    )
    const next = alertsWait("probe-b", outbox, 5, began)
    appendFileSync(file, peer("after", "2026-11-16T20:00:06Z"))
    expect(await next).toBe("[ops-peer] 2026-11-16T20:00:06Z probe-a: after")
  })
})
