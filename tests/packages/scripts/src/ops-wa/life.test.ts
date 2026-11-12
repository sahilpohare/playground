import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BACKOFF,
  backoffMs,
  CONNECTS_PER_HOUR,
  KEEP_ALIVE_DAYS,
  keepAlive,
  mayConnect,
  releaseLock,
  SOCKET,
  takeLock,
} from "../../../../../packages/scripts/src/ops-wa/habits"
import { life, PAIRING, unguarded } from "../../../../../packages/scripts/src/ops-wa/life"
import { fakeSocket, OWNER, SPARE } from "./fake-socket"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ops-wa-life-")), "whatsapp")
  dirs.push(dir)
  return dir
}

const HOUR = 3_600_000
const START = Date.parse("2026-11-11T03:00:00Z")

type Fake = ReturnType<typeof fakeSocket>

// ops-wa's life over fake sockets: each connect hands the next socket, whose script runs once the life listens to it; every alert, card, wait and the reason it stopped are kept.
const harness = (
  scripts: ((fake: Fake) => void)[],
  { device = SPARE, dir = scratch(), registered = true } = {},
) => {
  let now = START
  const alerts: string[] = []
  const cards: string[] = []
  const linked: string[] = []
  const ups: boolean[] = []
  const waits: number[] = []
  const sockets: Fake[] = []
  const io = {
    alert: async (text: string) => void alerts.push(text),
    card: async (code: string) => {
      cards.push(code)
      return "card-1"
    },
    connect: async () => {
      const fake = fakeSocket(registered)
      sockets.push(fake)
      return fake.sock
    },
    device,
    dir,
    linked: async (id: string) => void linked.push(id),
    listen: () => {
      const fake = sockets.at(-1)!
      const script = scripts[sockets.length - 1]
      queueMicrotask(() => (script ? script(fake) : fake.close(408)))
    },
    now: () => now,
    owner: OWNER,
    random: () => 0.5,
    sleep: async (ms: number) => {
      waits.push(ms)
      now += ms
    },
    up: (open: boolean) => void ups.push(open),
  }
  return { alerts, cards, dir, linked, run: () => life(io), sockets, ups, waits }
}

describe("ops-wa's ban-safety habits", () => {
  test("backs off from 2 s to 30 s with random spread", () => {
    const low = Array.from({ length: BACKOFF.tries }, (_, i) => backoffMs(i + 1, () => 0))
    const high = Array.from({ length: BACKOFF.tries }, (_, i) => backoffMs(i + 1, () => 1))
    for (const ms of [...low, ...high]) {
      expect(ms).toBeGreaterThanOrEqual(BACKOFF.firstMs)
      expect(ms).toBeLessThanOrEqual(BACKOFF.maxMs)
    }
    expect(backoffMs(1, () => 0.5)).toBe(BACKOFF.firstMs)
    expect(backoffMs(BACKOFF.tries, () => 0.5)).toBe(BACKOFF.maxMs)
    expect(high[2]).not.toBe(low[2])
  })

  test("stops after 12 failed tries in a row, with one alert", async () => {
    const h = harness([])
    expect(await h.run()).toContain("12 tries")
    expect(h.sockets).toHaveLength(BACKOFF.tries)
    expect(h.waits).toHaveLength(BACKOFF.tries - 1)
    expect(h.alerts).toHaveLength(1)
  })

  test("a connect that opens starts the count of failed tries again", async () => {
    const opens = (f: Fake) => {
      f.open()
      f.close(428)
    }
    const h = harness([opens, opens])
    await h.run()
    expect(h.sockets).toHaveLength(BACKOFF.tries + 2)
  })

  test("connects at most 20 times an hour, whatever restarts it, waiting out the cap", async () => {
    const dir = scratch()
    for (let i = 0; i < CONNECTS_PER_HOUR; i++) expect(await mayConnect(dir, START + i)).toBe(true)
    // a second process over the same folder reads the same count
    expect(await mayConnect(dir, START + 100)).toBe(false)
    expect(await mayConnect(dir, START + HOUR + 1)).toBe(true)
    const h = harness([])
    for (let i = 0; i < CONNECTS_PER_HOUR; i++) await mayConnect(h.dir, START)
    await h.run()
    expect(h.waits[0]).toBe(HOUR)
    expect(h.alerts[0]).toContain("20 connects")
  })

  test("on a logout it stops, alerts once and never links again by itself", async () => {
    const dir = scratch()
    const h = harness([(f) => f.close(401)], { dir })
    expect(await h.run()).toContain("logged out")
    expect(h.sockets).toHaveLength(1)
    expect(h.alerts).toHaveLength(1)
    const again = harness([], { dir })
    expect(await again.run()).toContain("logged out")
    expect(again.sockets).toHaveLength(0)
    expect(again.alerts).toHaveLength(0)
  })

  test("links an unlinked device by a pairing code for the spare number, and marks the card linked", async () => {
    const h = harness(
      [
        (f) => {
          f.qr()
          f.qr()
          f.open()
          f.close(401)
        },
      ],
      { registered: false },
    )
    await h.run()
    expect(h.sockets[0]!.pairings).toEqual([SPARE.slice(1)])
    expect(h.cards).toEqual(["ABCD1234"])
    expect(h.linked).toEqual(["card-1"])
  })

  test("names the link up only while a connection is open, so the heartbeat tells linked from connecting", async () => {
    const h = harness([
      (f) => f.close(408),
      (f) => {
        f.open()
        f.close(401)
      },
    ])
    await h.run()
    expect(h.ups).toEqual([false, true, false])
  })

  test("holds the auth state in one process: an exclusive lock a live holder keeps and a gone one gives up", async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, "lock")
    expect(await takeLock(lock, 101, () => true)).toBeUndefined()
    expect(await takeLock(lock, 202, (pid) => pid === 101)).toBe("pid 101 holds the auth state")
    expect(await takeLock(lock, 202, () => false)).toBeUndefined()
    expect(await Bun.file(lock).text()).toBe("202")
    releaseLock(lock, 101)
    expect(await Bun.file(lock).exists()).toBe(true)
    releaseLock(lock, 202)
    expect(await Bun.file(lock).exists()).toBe(false)
  })

  test("gives a gone holder's lock to one of two starts that race for it, never both", async () => {
    for (let round = 0; round < 50; round++) {
      const dir = scratch()
      mkdirSync(dir, { recursive: true })
      const lock = join(dir, "lock")
      await Bun.write(lock, "999")
      const live = (pid: number) => pid === 101 || pid === 202
      const [a, b] = await Promise.all([takeLock(lock, 101, live), takeLock(lock, 202, live)])
      const winner = a === undefined ? 101 : 202
      expect([a, b].filter((r) => r === undefined)).toHaveLength(1)
      expect(await Bun.file(lock).text()).toBe(String(winner))
      expect(a ?? b).toBe(`pid ${winner} holds the auth state`)
      // each start's private <lock>.<pid>.new goes on every exit, the winner's and the loser's
      expect(readdirSync(dir).filter((name) => name.endsWith(".new"))).toEqual([])
    }
  })

  test("a start still writing its lock is never taken for a gone holder, so one of two starts wins", async () => {
    // every file write creates its file empty and lands its bytes 5 ms later, the gap a loaded machine leaves between the two
    const { open } = fsp
    const slow = spyOn(fsp, "writeFile").mockImplementation((async (
      file: string,
      data: string,
      options?: { flag?: string; mode?: number },
    ) => {
      const handle = await open(file, options?.flag ?? "w", options?.mode)
      try {
        await Bun.sleep(5)
        await handle.writeFile(data)
      } finally {
        await handle.close()
      }
    }) as unknown as typeof fsp.writeFile)
    try {
      for (let round = 0; round < 20; round++) {
        const dir = scratch()
        mkdirSync(dir, { recursive: true })
        const lock = join(dir, "lock")
        await Bun.write(lock, "999")
        const live = (pid: number) => pid === 101 || pid === 202
        const [a, b] = await Promise.all([takeLock(lock, 101, live), takeLock(lock, 202, live)])
        expect([a, b].filter((r) => r === undefined)).toHaveLength(1)
        expect(await Bun.file(lock).text()).toBe(a === undefined ? "101" : "202")
        expect(readdirSync(dir).filter((name) => name.endsWith(".new"))).toEqual([])
      }
      expect(slow).toHaveBeenCalled()
    } finally {
      slow.mockRestore()
    }
  })

  test("refuses to pair while no-raw-wa is not registered in the factory's settings", async () => {
    const settings = join(scratch(), "factory-settings.json")
    await Bun.write(settings, JSON.stringify({ hooks: { PreToolUse: [] } }))
    expect(await unguarded(settings)).toContain("phase 2 registers it")
    expect(await unguarded(join(scratch(), "missing.json"))).toContain(
      "no-raw-wa is not registered",
    )
  })

  test("pairs once no-raw-wa is registered in the factory's settings", async () => {
    const settings = join(scratch(), "factory-settings.json")
    const command = "bun --no-env-file scripts/hooks/bundled/no-raw-wa.js"
    await Bun.write(settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command }] }] } }))
    expect(await unguarded(settings)).toBeUndefined()
  })

  test("pairs now: the factory's own settings register no-raw-wa", async () => {
    const settings = join(import.meta.dir, "../../../../../scripts/factory-settings.json")
    expect(await unguarded(settings)).toBeUndefined()
  })

  test("the pairing card walks WhatsApp Business to Link with phone number instead, with no QR, and keeps the profile unverified", () => {
    expect(PAIRING).toContain("WhatsApp Business")
    expect(PAIRING).toContain("Linked devices")
    expect(PAIRING).toContain("Link with phone number instead")
    expect(PAIRING).toContain("no Meta Verified")
    expect(PAIRING).not.toMatch(/\bQR\b|scan/i)
  })

  test("refuses to run with the spare number as the owner's, since a self-chat number is banned fast", async () => {
    const h = harness([], { device: OWNER })
    expect(await h.run()).toContain("the owner's own number")
    expect(h.sockets).toHaveLength(0)
  })

  test("reminds the owner to open WhatsApp on the spare phone 12 days after the link, and each 12 days after", async () => {
    const reminders: number[] = []
    const remind = async () => void reminders.push(1)
    const h = harness([
      (f) => {
        f.open()
        f.close(401)
      },
    ])
    await h.run()
    const day = 24 * HOUR
    await keepAlive(h.dir, START + 11 * day, remind)
    expect(reminders).toHaveLength(0)
    await keepAlive(h.dir, START + 12 * day, remind)
    await keepAlive(h.dir, START + 13 * day, remind)
    expect(reminders).toHaveLength(1)
    await keepAlive(h.dir, START + 24 * day, remind)
    expect(reminders).toHaveLength(2)
  })

  test("keeps a quiet footprint: never online on connect, no history sync, no link previews", () => {
    expect(SOCKET.markOnlineOnConnect).toBe(false)
    expect(SOCKET.syncFullHistory).toBe(false)
    expect(SOCKET.shouldSyncHistoryMessage()).toBe(false)
    expect(SOCKET.generateHighQualityLinkPreview).toBe(false)
    expect(KEEP_ALIVE_DAYS).toBe(12)
  })
})
