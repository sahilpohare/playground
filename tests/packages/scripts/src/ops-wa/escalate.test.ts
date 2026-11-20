import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bridge, sender, statusOf } from "../../../../../packages/scripts/src/ops-wa/bridge"
import {
  alertSentFile,
  lastFile,
  pendingDir,
  runCheck,
} from "../../../../../packages/scripts/src/ops-wa/escalate"
import { seedAlert } from "../../../../../packages/scripts/src/ops-wa/seed"
import { ALERT, fakeSocket, jid, OWNER, SPARE } from "./fake-socket"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const START = Date.parse("2026-11-11T03:00:00Z")
const MINUTE = 60_000

// ops-wa over a fake socket and a fake clock, both numbers having written: the sender, a bridge whose pass escalates through it, and the settings a test changes
const harness = (setup: { alert?: string; data?: string } = {}) => {
  const data = setup.data ?? mkdtempSync(join(tmpdir(), "ops-wa-esc-"))
  if (!setup.data) dirs.push(data)
  const dir = join(data, "whatsapp")
  const fake = fakeSocket()
  const logs: string[] = []
  const relayed: string[] = []
  const mode = {
    alert: setup.alert ?? ALERT,
    checked: [] as [string, number][],
    // the checker's answer, or none set
    check: undefined as boolean | undefined,
    delay: undefined as number | undefined,
  }
  let now = START
  fake.setClock(() => now)
  const base = {
    alert: async () => mode.alert,
    dir,
    now: () => now,
    owner: OWNER,
    sleep: async (ms: number) => void (now += ms),
  }
  const send = sender({
    ...base,
    delay: async () => mode.delay ?? 3,
    device: SPARE,
    sock: fake.sock,
  })
  const watched = bridge({
    ...base,
    assistant: async () => undefined,
    busy: async () => false,
    check: async (source, at) => {
      mode.checked.push([source, at])
      if (mode.check === undefined) return false
      return mode.check
    },
    escalate: (body) => send(body, "escalate"),
    log: (line) => logs.push(line),
    on: async () => true,
    relay: async (_to: string, text: string) => void relayed.push(text),
    reply: send,
    stuck: async () => null,
  })
  watched.attach(fake.sock)
  return {
    advance: (ms: number) => (now += ms),
    data,
    dir,
    fake,
    logs,
    mode,
    relayed,
    pass: async () => {
      watched.pass()
      await watched.idle()
    },
    react: async (id: string) => {
      fake.upsert([
        {
          key: { fromMe: false, id: `r${id}`, remoteJid: jid(OWNER) },
          message: { reactionMessage: { key: { id }, text: "👍" } },
        },
      ])
      await watched.idle()
    },
    send,
    settle: watched.idle,
    toAlert: () => fake.sent.filter((s) => s.jid === jid(ALERT)).map((s) => s.content.text),
  }
}

// both numbers have written, so an alert can reach each
const ready = async (setup: { alert?: string; data?: string } = {}) => {
  const h = harness(setup)
  h.fake.upsert([h.fake.message(jid(OWNER), "hi")])
  await h.settle()
  seedAlert(h.data, ALERT, START)
  return h
}

describe("an urgent alert goes to the owner first (ADR 0034)", () => {
  test("reaches the owner at once and keeps it pending in an owner-only file", async () => {
    const h = await ready()
    expect(await h.send("ops-tick is down", "first")).toBe(
      "sent to the owner; the alert number gets it at 03:03Z unless it is handled",
    )
    expect(h.fake.sent.map((s) => s.jid)).toEqual([jid(OWNER)])
    const [file] = readdirSync(pendingDir(h.dir))
    expect(statSync(join(pendingDir(h.dir), file!)).mode & 0o777).toBe(0o600)
  })

  test("with no owner act in wa.alertDelayMinutes, 3 by default, reaches the alert number once", async () => {
    const h = await ready()
    await h.send("ops-tick is down", "first")
    h.advance(2 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual([])
    h.advance(MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["ops-tick is down"])
    h.advance(10 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["ops-tick is down"])
  })

  test("reads wa.alertDelayMinutes for each alert: at 5 it waits 5 minutes", async () => {
    const h = await ready()
    h.mode.delay = 5
    await h.send("ops-tick is down", "first")
    h.advance(4 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual([])
    h.advance(MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["ops-tick is down"])
  })

  test("the owner's reaction on it within the delay handles it, so it never reaches the alert number", async () => {
    const h = await ready()
    await h.send("ops-tick is down", "first")
    h.advance(2 * MINUTE)
    await h.react("m1")
    h.advance(5 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual([])
    expect(h.relayed.filter((l) => l.includes("reacts"))).toEqual([])
  })

  test("an owner message on another topic handles nothing, so it still goes on", async () => {
    const h = await ready()
    await h.send("ops-tick is down", "first")
    h.advance(2 * MINUTE)
    h.fake.upsert([h.fake.message(jid(OWNER), "what is for lunch?")])
    await h.settle()
    await h.react("some-other-message")
    expect(h.relayed.at(-1)).toContain("reacts 👍 on the message some-other-message")
    h.advance(MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["ops-tick is down"])
  })

  test("a restart mid-delay keeps the pending alert and its deadline", async () => {
    const h = await ready()
    await h.send("ops-tick is down", "first")
    // a new ops-wa over the same folder, the clock past the deadline
    const again = harness({ data: h.data })
    again.advance(3 * MINUTE)
    await again.pass()
    expect(again.toAlert()).toEqual(["ops-tick is down"])
  })

  test("--now-both sends to both numbers at once and keeps nothing pending", async () => {
    const h = await ready()
    expect(await h.send("ops-tick is down", "alert")).toBe("sent")
    expect(h.fake.sent.map((s) => s.jid)).toEqual([jid(OWNER), jid(ALERT)])
    h.advance(10 * MINUTE)
    await h.pass()
    expect(h.fake.sent).toHaveLength(2)
  })

  test("while the owner has never written, it goes to the alert number at once and keeps nothing pending", async () => {
    const h = harness()
    seedAlert(h.data, ALERT, START)
    expect(await h.send("ops-tick is down", "first")).toBe(
      "sent to the alert number alone: the owner has never written to this number",
    )
    expect(h.fake.sent.map((s) => s.jid)).toEqual([jid(ALERT)])
    h.advance(10 * MINUTE)
    await h.pass()
    expect(h.fake.sent).toHaveLength(1)
  })

  test("while the alert number has never written, it goes to the owner alone, says so and keeps nothing pending", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "hi")])
    await h.settle()
    expect(await h.send("ops-tick is down", "first")).toBe(
      "sent to the owner alone: the alert number has never written to this number",
    )
    const lines = await statusOf(h.dir, { alert: ALERT, owner: OWNER }, START)
    expect(lines.filter((line) => line.startsWith("pending:"))).toEqual([])
    h.advance(10 * MINUTE)
    await h.pass()
    expect(h.fake.sent.map((s) => s.jid)).toEqual([jid(OWNER)])
  })

  test("an empty wa.alert never escalates", async () => {
    const h = await ready({ alert: "" })
    expect(await h.send("ops-tick is down", "first")).toBe("sent")
    h.advance(10 * MINUTE)
    await h.pass()
    expect(h.fake.sent.map((s) => s.jid)).toEqual([jid(OWNER)])
  })

  test("a source the checker reads as handled cancels it; one it reads as not handled goes on", async () => {
    const handled = await ready()
    handled.mode.check = true
    await handled.send("down", "first", "chat:made-up-1")
    handled.advance(3 * MINUTE)
    await handled.pass()
    expect(handled.toAlert()).toEqual([])
    expect(handled.mode.checked).toEqual([["chat:made-up-1", START]])
    const open = await ready()
    open.mode.check = false
    await open.send("down", "first", "chat:made-up-2")
    open.advance(3 * MINUTE)
    await open.pass()
    expect(open.toAlert()).toEqual(["down"])
  })

  test("a test: source with no reaction escalates once", async () => {
    const h = await ready()
    await h.send("a practice alert", "first", "test:2026-11-11T03:00Z")
    h.advance(3 * MINUTE)
    await h.pass()
    h.advance(3 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["a practice alert"])
  })

  test("wa status names a pending alert, its deadline and its source", async () => {
    const h = await ready()
    await h.send("a practice alert", "first", "test:2026-11-11T03:00Z")
    const lines = await statusOf(h.dir, { alert: ALERT, owner: OWNER }, START)
    expect(lines.at(-1)).toBe(
      "pending: the alert of 2026-11-11T03:00:00.000Z goes to the second number at 2026-11-11T03:03:00.000Z unless handled (source test:2026-11-11T03:00Z)",
    )
  })
})

// PG-2851: wa status prints the last alert's outcome and its times, so a session can tell whether it reached the second number
describe("wa status's last alert line", () => {
  const last = async (h: Awaited<ReturnType<typeof ready>>) =>
    (await statusOf(h.dir, { alert: ALERT, owner: OWNER }, START)).filter((line) =>
      line.startsWith("last alert:"),
    )

  test("none before the first alert's outcome", async () => {
    const h = await ready()
    await h.send("a practice alert", "first", "test:2026-11-11T03:00Z")
    expect(await last(h)).toEqual([])
  })

  test("handled by the owner's reaction, at the reaction's time", async () => {
    const h = await ready()
    await h.send("a practice alert", "first")
    h.advance(2 * MINUTE)
    await h.react("m1")
    expect(await last(h)).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:00:00\.000Z, at 2026-11-11T03:02:\d\d\.\d{3}Z: handled by the owner's reaction$/,
      ),
    ])
  })

  test("handled at its source, at the pass that read it", async () => {
    const h = await ready()
    h.mode.check = true
    await h.send("a practice alert", "first", "chat:made-up-1")
    h.advance(3 * MINUTE)
    await h.pass()
    expect(await last(h)).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:00:00\.000Z, at 2026-11-11T03:03:\d\d\.\d{3}Z: handled at its source$/,
      ),
    ])
  })

  test("sent to the second number, in a 0600 file that holds no body", async () => {
    const h = await ready()
    await h.send("a practice alert", "first", "test:2026-11-11T03:00Z")
    h.advance(3 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["a practice alert"])
    expect(await last(h)).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:00:00\.000Z, at 2026-11-11T03:03:\d\d\.\d{3}Z: sent to the second number$/,
      ),
    ])
    expect(statSync(lastFile(h.dir)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(lastFile(h.dir)).text()).not.toContain("practice")
  })

  test("a last-alert write that fails still sends to the second number once", async () => {
    const h = await ready()
    await h.send("a practice alert", "first", "test:2026-11-11T03:00Z")
    mkdirSync(lastFile(h.dir), { recursive: true })
    h.advance(3 * MINUTE)
    await h.pass()
    h.advance(MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["a practice alert"])
  })

  test("a last-alert write that fails on a reaction is logged as such, and the alert stays with the owner", async () => {
    const h = await ready()
    await h.send("a practice alert", "first")
    mkdirSync(lastFile(h.dir), { recursive: true })
    h.advance(2 * MINUTE)
    await h.react("m1")
    expect(h.logs.some((line) => line.startsWith("ops-wa: the last alert's outcome:"))).toBe(true)
    expect(h.logs.some((line) => line.includes("not handed on"))).toBe(false)
    h.advance(5 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual([])
  })

  test("a failed send names its reason with the number masked", async () => {
    const h = await ready()
    await h.send("a practice alert", "first")
    h.fake.sock.sendMessage = async (to: string) => {
      throw new Error(`no route to ${to}`)
    }
    h.advance(3 * MINUTE)
    await h.pass()
    const lines = await last(h)
    expect(lines).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:00:00\.000Z, at 2026-11-11T03:03:\d\d\.\d{3}Z: send to the second number failed: no route to <number>@s\.whatsapp\.net$/,
      ),
    ])
    expect(lines.join("\n")).not.toContain(ALERT.slice(1))
  })

  test("a --now-both alert shows as the newest alert, over an older alert whose outcome came after it", async () => {
    const h = await ready()
    await h.send("a practice alert", "first")
    h.advance(MINUTE)
    expect(await h.send("a second practice alert", "alert")).toBe("sent")
    h.advance(3 * MINUTE)
    await h.pass()
    expect(h.toAlert()).toEqual(["a second practice alert", "a practice alert"])
    expect(await last(h)).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:01:\d\d\.\d{3}Z, at 2026-11-11T03:01:\d\d\.\d{3}Z: sent to both numbers at once$/,
      ),
    ])
  })

  test("an alert held back because the alert number has never written shows that it reached the owner alone", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "hi")])
    await h.settle()
    await h.send("a practice alert", "first")
    expect(await last(h)).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:00:\d\d\.\d{3}Z, at 2026-11-11T03:00:\d\d\.\d{3}Z: sent to the owner alone: the alert number has never written to this number$/,
      ),
    ])
    expect(statSync(alertSentFile(h.dir)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(alertSentFile(h.dir)).text()).not.toContain("a practice alert")
  })

  test("a --now-both alert that reaches the owner and fails on the alert number shows both, its number masked", async () => {
    const h = await ready()
    const sendMessage = h.fake.sock.sendMessage
    h.fake.sock.sendMessage = async (to: string, content: unknown) => {
      if (to === jid(ALERT)) throw new Error(`no route to ${to}`)
      return sendMessage(to, content as never)
    }
    await expect(h.send("a practice alert", "alert")).rejects.toThrow("no route")
    const lines = await last(h)
    expect(lines).toEqual([
      expect.stringMatching(
        /^last alert: the alert of 2026-11-11T03:00:\d\d\.\d{3}Z, at 2026-11-11T03:00:\d\d\.\d{3}Z: sent to the owner, then the send to the alert number failed: no route to <number>@s\.whatsapp\.net$/,
      ),
    ])
    expect(lines.join("\n")).not.toContain(ALERT.slice(1))
  })
})

describe("the checker wa.alertCheck names", () => {
  const script = (body: string) => {
    const folder = mkdtempSync(join(tmpdir(), "ops-wa-check-"))
    dirs.push(folder)
    const path = join(folder, "check.ts")
    writeFileSync(path, body)
    return path
  }

  test("exit 0 reads as handled, and gets the source and the send time", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ops-wa-check-out-")), "args")
    dirs.push(out)
    const path = script(
      `await Bun.write(${JSON.stringify(out)}, process.argv.slice(2).join(" "))\nprocess.exit(0)`,
    )
    expect(await runCheck(path, "chat:made-up-1", START)).toBe(true)
    expect(await Bun.file(out).text()).toBe("chat:made-up-1 2026-11-11T03:00:00.000Z")
  })

  test("exit 1, a crash and a timeout each read as not handled", async () => {
    expect(await runCheck(script("process.exit(1)"), "chat:x", START)).toBe(false)
    expect(await runCheck(script("throw new Error('made-up crash')"), "chat:x", START)).toBe(false)
    expect(await runCheck(script("await Bun.sleep(5_000)"), "chat:x", START, 200)).toBe(false)
  })
})
