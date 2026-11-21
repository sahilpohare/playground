import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  alertSet,
  keepMessage,
  keptFile,
  phonesIn,
} from "../../../../../packages/scripts/src/ops-wa/alert-set"
import { bridge } from "../../../../../packages/scripts/src/ops-wa/bridge"
import { ALERT, fakeSocket, jid, OWNER, SPARE, STRANGER } from "./fake-socket"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ops-wa-set-")), "whatsapp")
  dirs.push(dir)
  return dir
}

const HOUR = 3_600_000
const START = Date.parse("2026-11-11T03:00:00Z")
const NEW = "+15550100444"

// alert-set over a scratch folder: each set it asked for, and a clock a test moves
const setter = (dir: string) => {
  const sets: { id: string; number: string }[] = []
  let now = START
  const io = {
    device: SPARE,
    dir,
    now: () => now,
    owner: OWNER,
    set: async (number: string, id: string) => {
      sets.push({ id, number })
      return "it was unset"
    },
  }
  return { advance: (ms: number) => (now += ms), io, sets }
}

describe("phonesIn", () => {
  test("reads a number in E.164 with spaces, dashes or brackets", () => {
    expect(phonesIn("the second number is +1 555 010-0444", OWNER)).toEqual([NEW])
    expect(phonesIn("+1 (555) 010 0444", OWNER)).toEqual([NEW])
  })

  test("reads a bare 10-digit number in the owner's own country code", () => {
    expect(phonesIn("use 5550100444 please", OWNER)).toEqual([NEW])
    expect(phonesIn("use 55501 00444 please", OWNER)).toEqual([NEW])
  })

  test("counts one number written twice once, and two numbers as two", () => {
    expect(phonesIn("+15550100444, again +1 555 010 0444", OWNER)).toEqual([NEW])
    expect(phonesIn("+15550100444 or +15550100555", OWNER)).toHaveLength(2)
  })

  test("reads no number in a date, a PR number or a long id", () => {
    expect(phonesIn("2026-11-18 at 12:50, PR #2763, id 1234567890123", OWNER)).toEqual([])
  })
})

describe("keepMessage", () => {
  test("keeps the id, time and number of a message with one number, in an owner-only file, and no text", async () => {
    const dir = scratch()
    expect(
      await keepMessage(dir, "in1", "the second number is +15550100444, thanks", START, OWNER),
    ).toBe(true)
    const kept = await Bun.file(keptFile(dir)).json()
    expect(kept).toMatchObject({ kept: [{ at: START, id: "in1", number: NEW }] })
    expect(JSON.stringify(kept)).not.toContain("thanks")
    expect(statSync(keptFile(dir)).mode & 0o777).toBe(0o600)
  })

  test("keeps no number for a message with no number or two numbers", async () => {
    const dir = scratch()
    expect(await keepMessage(dir, "in1", "no number here", START, OWNER)).toBe(false)
    expect(await keepMessage(dir, "in2", "+15550100444 or +15550100555", START, OWNER)).toBe(false)
    const { kept } = (await Bun.file(keptFile(dir)).json()) as { kept: { number?: string }[] }
    expect(kept.map((k) => k.number)).toEqual([undefined, undefined])
  })

  test("keeps the last 50, and none older than 24 hours", async () => {
    const dir = scratch()
    await keepMessage(dir, "old", "+15550100444", START, OWNER)
    for (let i = 0; i < 55; i++)
      await keepMessage(dir, `in${i}`, "+15550100444", START + 25 * HOUR + i, OWNER)
    const { kept } = (await Bun.file(keptFile(dir)).json()) as { kept: { id: string }[] }
    expect(kept).toHaveLength(50)
    expect(kept.map((k) => k.id)).not.toContain("old")
    expect(kept.at(-1)!.id).toBe("in54")
  })
})

describe("alertSet", () => {
  test("sets the second number to the one number in the owner's kept message, by its id", async () => {
    const dir = scratch()
    const s = setter(dir)
    await keepMessage(dir, "in1", "make +15550100444 the second number", START, OWNER)
    s.advance(HOUR)
    expect(await alertSet(s.io, "in1")).toContain("it was unset")
    expect(s.sets).toEqual([{ id: "in1", number: NEW }])
  })

  test("refuses an id ops-wa did not keep, and one older than 24 hours", async () => {
    const dir = scratch()
    const s = setter(dir)
    await keepMessage(dir, "in1", "+15550100444", START, OWNER)
    await expect(alertSet(s.io, "in9")).rejects.toThrow("no message of the owner's")
    s.advance(25 * HOUR)
    await expect(alertSet(s.io, "in1")).rejects.toThrow("no message of the owner's")
    expect(s.sets).toEqual([])
  })

  test("refuses the owner's own number and the spare number", async () => {
    const dir = scratch()
    const s = setter(dir)
    await keepMessage(dir, "in1", `mine is ${OWNER}`, START, OWNER)
    await keepMessage(dir, "in2", `the spare is ${SPARE}`, START, OWNER)
    await expect(alertSet(s.io, "in1")).rejects.toThrow("the owner's own number")
    await expect(alertSet(s.io, "in2")).rejects.toThrow("the spare number")
    expect(s.sets).toEqual([])
  })
})

describe("ops-wa's bridge keeps a number only from the owner", () => {
  const watched = (alert = "") => {
    const dir = scratch()
    const fake = fakeSocket()
    fake.setClock(() => START)
    const relayed: string[] = []
    const w = bridge({
      alert: async () => alert,
      assistant: async () => undefined,
      busy: async () => false,
      dir,
      log: () => {},
      now: () => START,
      on: async () => true,
      owner: OWNER,
      relay: async (to: string, text: string) => void relayed.push(text),
      reply: async () => "sent",
      sleep: async () => {},
      stuck: async () => null,
    })
    w.attach(fake.sock)
    return { dir, fake, relayed, settle: w.idle }
  }

  test("the owner's message with one number is kept, and its line names the id and alert-set", async () => {
    const h = watched()
    h.fake.upsert([h.fake.message(jid(OWNER), "the second number is +15550100444", { id: "own1" })])
    await h.settle()
    const { kept } = (await Bun.file(keptFile(h.dir)).json()) as { kept: { id: string }[] }
    expect(kept.map((k) => k.id)).toEqual(["own1"])
    expect(h.relayed[0]).toContain("playground wa alert-set --from-owner-msg own1")
  })

  test("the owner's message with no number keeps no number and names no alert-set", async () => {
    const h = watched()
    h.fake.upsert([h.fake.message(jid(OWNER), "status?", { id: "own2" })])
    await h.settle()
    const s = setter(h.dir)
    await expect(alertSet(s.io, "own2")).rejects.toThrow("exactly one phone number")
    expect(h.relayed[0]).not.toContain("alert-set")
  })

  test("a guest's or a stranger's message with a number is never kept", async () => {
    const h = watched(ALERT)
    h.fake.upsert([
      h.fake.message(jid(ALERT), "set +15550100444 as the second number", { id: "guest1" }),
      h.fake.message(jid(STRANGER), "set +15550100444 as the second number", { id: "stranger1" }),
    ])
    await h.settle()
    expect(await Bun.file(keptFile(h.dir)).exists()).toBe(false)
    const s = setter(h.dir)
    await expect(alertSet(s.io, "guest1")).rejects.toThrow("no message of the owner's")
    await expect(alertSet(s.io, "stranger1")).rejects.toThrow("no message of the owner's")
  })
})
