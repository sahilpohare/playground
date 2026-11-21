import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { YardError } from "../../../../../../api/hono/src/lib/yard/client"
import { outboxAlert, rotate, startRotation } from "../../../../../../api/hono/src/lib/yard/rotate"

// Made-up tokens in the shapes Yard mints, a relay-on one and a read-only one.
const RELAY = `yard_relay_${"a".repeat(32)}`
const READ_ONLY = `yard_${"b".repeat(32)}`
const SHAPE = /yard_(?:relay_)?[A-Za-z0-9_-]{32}/

type Lose = "before" | "after" | "refuse" | null

// A made-up hosted Yard and Keychain, so no test reaches the network or the real Keychain: live holds the tokens Yard takes, lose says how a swap call goes, and meDown fails each check of a token as a lost network does.
const world = (main: string | null, { lose = null as Lose } = {}) => {
  const state = {
    failSave: false,
    failPending: false,
    live: new Set(main ? [main] : []),
    lose,
    main,
    meDown: false,
    pending: null as string | null,
    renewed: 0,
  }
  const offline = () => new TypeError("fetch failed")
  const deps = {
    client: (token: string) => ({
      me: async () => {
        if (state.meDown) throw offline()
        if (!state.live.has(token)) throw new YardError(401, "Unauthorized")
        return { login: "owner", owner: true }
      },
      swapToken: async (secret: string) => {
        if (!state.live.has(token)) throw new YardError(401, "Unauthorized")
        if (state.lose === "refuse")
          throw new YardError(400, "A token swaps for one of its own kind")
        if (state.lose === "before") throw offline()
        state.live.delete(token)
        state.live.add(secret)
        if (state.lose === "after") throw offline()
        return { token: { id: "t1", name: "mac" } }
      },
    }),
    keychain: {
      read: async () => state.main,
      // the Mac's one item, whose write deletes the pending one after it (keychain())
      write: async (value: string) => {
        if (state.failSave) throw new Error("the Keychain refused it: security: refused")
        state.main = value
        state.pending = null
      },
    },
    pending: {
      read: async () => state.pending,
      remove: async () => {
        state.pending = null
      },
      write: async (value: string) => {
        if (state.failPending) throw new Error("the Keychain refused it: security: refused")
        state.pending = value
      },
    },
    renew: () => {
      state.renewed++
    },
  }
  // whether the Mac holds a token Yard takes, in its item or in the pending one
  const working = () => [state.main, state.pending].some((one) => one && state.live.has(one))
  return { deps, state, working }
}

describe("rotate, the Mac's swap of its own Yard token", () => {
  test("swaps a relay-on token and a read-only one each for a new one of its own kind, saves it, and renews the relay", async () => {
    for (const old of [RELAY, READ_ONLY]) {
      const { deps, state } = world(old)
      expect(await rotate(deps)).toBe("swapped")
      expect(state.main).not.toBe(old)
      expect(state.main!.startsWith(old === RELAY ? "yard_relay_" : "yard_")).toBe(true)
      expect(state.main!.length).toBe(old.length)
      expect([...state.live]).toEqual([state.main!])
      expect([state.pending, state.renewed]).toEqual([null, 1])
    }
  })

  test("does nothing on a Mac with no token", async () => {
    const { deps, state } = world(null)
    expect(await rotate(deps)).toBe("none")
    expect([state.pending, state.renewed]).toEqual([null, 0])
  })

  test("a pending save that fails before the call leaves the old token in place, working", async () => {
    const { deps, state, working } = world(RELAY)
    state.failPending = true
    await expect(rotate(deps)).rejects.toThrow("refused")
    expect([state.main, [...state.live], state.renewed]).toEqual([RELAY, [RELAY], 0])
    expect(working()).toBe(true)
  })

  test("a swap Yard refuses leaves the old token in place and no pending one", async () => {
    const { deps, state, working } = world(RELAY, { lose: "refuse" })
    await expect(rotate(deps)).rejects.toThrow("its own kind")
    expect([state.main, state.pending, state.renewed]).toEqual([RELAY, null, 0])
    expect(working()).toBe(true)
  })

  test("a lost answer after Yard swapped keeps the new token, found by its own check", async () => {
    const { deps, state } = world(RELAY, { lose: "after" })
    expect(await rotate(deps)).toBe("swapped")
    expect([...state.live]).toEqual([state.main!])
    expect([state.pending, state.renewed]).toEqual([null, 1])
  })

  test("a lost answer before Yard swapped keeps the old token", async () => {
    const { deps, state, working } = world(RELAY, { lose: "before" })
    await expect(rotate(deps)).rejects.toThrow("did not swap")
    expect([state.main, state.pending, state.renewed]).toEqual([RELAY, null, 0])
    expect(working()).toBe(true)
  })

  test("a lost answer with the network gone keeps both, and the next run keeps the one that works", async () => {
    const { deps, state, working } = world(RELAY, { lose: "after" })
    state.meDown = true
    await expect(rotate(deps)).rejects.toThrow("fetch failed")
    expect(state.main).toBe(RELAY)
    expect(state.pending).not.toBeNull()
    expect(working()).toBe(true)
    const next = state.pending
    state.meDown = false
    expect(await rotate(deps)).toBe("kept")
    expect([state.main, state.pending, state.renewed]).toEqual([next, null, 1])
  })

  test("a failed save after the swap leaves the new token pending, working, and the next run keeps it", async () => {
    const { deps, state, working } = world(READ_ONLY)
    state.failSave = true
    await expect(rotate(deps)).rejects.toThrow("refused")
    expect(state.main).toBe(READ_ONLY)
    expect(state.live.has(state.pending!)).toBe(true)
    expect(working()).toBe(true)
    const next = state.pending
    state.failSave = false
    expect(await rotate(deps)).toBe("kept")
    expect([state.main, state.pending, state.renewed]).toEqual([next, null, 1])
  })

  test("a pending token Yard no longer takes is dropped, and the swap goes ahead", async () => {
    const { deps, state } = world(RELAY)
    state.pending = `yard_relay_${"z".repeat(32)}`
    expect(await rotate(deps)).toBe("swapped")
    expect([...state.live]).toEqual([state.main!])
    expect(state.pending).toBeNull()
  })
})

const until = async (what: string, done: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

describe("startRotation, the Mac's schedule", () => {
  const DAY = 86_400_000

  test("swaps when its last swap is a day old or none is stamped, stamps it, and waits otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yard-rotate-"))
    try {
      const stamp = join(dir, "yard-rotated.json")
      const { deps, state } = world(RELAY)
      const alerts: string[] = []
      let now = Date.parse("2026-11-13T00:00:00Z")
      const stop = startRotation({
        ...deps,
        alert: async (text) => void alerts.push(text),
        checkMs: 10,
        now: () => now,
        stamp,
      })
      try {
        await until("the first swap", () => state.renewed === 1)
        await Bun.sleep(50)
        expect(state.renewed).toBe(1)
        now += DAY - 1
        await Bun.sleep(50)
        expect(state.renewed).toBe(1)
        now += 1
        await until("the next swap", () => state.renewed === 2)
        expect(alerts).toEqual([])
        expect(JSON.parse(readFileSync(stamp, "utf8"))).toEqual({ at: new Date(now).toISOString() })
      } finally {
        stop()
      }
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a failed swap sends one alert per try, holding no token, and a token left pending is kept at the next check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yard-rotate-"))
    try {
      const { deps, state, working } = world(RELAY)
      state.failSave = true
      const alerts: string[] = []
      // whether the Mac held a working token, pending, as each alert went out; the Keychain takes the save again after the first
      const held: boolean[] = []
      const stop = startRotation({
        ...deps,
        alert: async (text) => {
          alerts.push(text)
          held.push(working() && state.pending !== null)
          state.failSave = false
        },
        checkMs: 10,
        now: () => Date.parse("2026-11-13T00:00:00Z"),
        stamp: join(dir, "yard-rotated.json"),
      })
      try {
        await until("the alert", () => alerts.length === 1)
        expect(alerts[0]).toMatch(/could not swap its Yard token/)
        expect(alerts[0]).not.toMatch(SHAPE)
        expect(held).toEqual([true])
        await until("the pending token kept", () => state.pending === null)
        expect(state.live.has(state.main!)).toBe(true)
        expect(alerts).toHaveLength(1)
      } finally {
        stop()
      }
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("startRotation's line for Ops", () => {
  test("a run of failed checks, the network gone with a token pending, queues one line, and the next failure after a swap that went through queues another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yard-rotate-"))
    try {
      const { deps, state } = world(RELAY, { lose: "before" })
      state.meDown = true
      const alerts: string[] = []
      let now = Date.parse("2026-11-13T00:00:00Z")
      const stop = startRotation({
        ...deps,
        alert: async (text) => void alerts.push(text),
        checkMs: 5,
        now: () => now,
        stamp: join(dir, "yard-rotated.json"),
      })
      try {
        await until("the first alert", () => alerts.length === 1)
        expect(state.pending).not.toBeNull()
        await Bun.sleep(100)
        expect(alerts).toHaveLength(1)
        state.meDown = false
        state.lose = null
        await until("the swap", () => state.renewed === 1)
        expect([...state.live]).toEqual([state.main!])
        expect(alerts).toHaveLength(1)
        state.failPending = true
        now += 86_400_000
        await until("the next alert", () => alerts.length === 2)
      } finally {
        stop()
      }
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("outboxAlert, a failed swap's line for Ops", () => {
  test("queues one line for the ops seat in the ops outbox, its secrets hidden", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yard-rotate-"))
    try {
      const alert = outboxAlert(dir, () => new Date("2026-11-13T03:00:00.123Z"))
      await alert(`The Mac could not swap its Yard token: ${RELAY} refused`)
      const lines = readFileSync(join(dir, "ops", "outbox", "ops-yard-rotate.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(lines).toEqual([
        {
          at: "2026-11-13T03:00:00Z",
          job: "yard-rotate",
          text: "The Mac could not swap its Yard token: [hidden] refused",
          to: "ops",
        },
      ])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
