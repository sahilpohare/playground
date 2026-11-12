import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Stuck } from "../../../../../packages/scripts/src/ops-job/dispatcher"
import {
  bridge,
  type Inbox,
  type Media,
  OFF,
  REPLY,
  sender,
  toWhatsApp,
  UPDATE,
  UPDATE_MS,
} from "../../../../../packages/scripts/src/ops-wa/bridge"
import {
  type Card,
  NO_ID,
  noRow,
  notSent,
  termsOf,
  waitingLine,
} from "../../../../../packages/scripts/src/ops-wa/cards"
import { SEND } from "../../../../../packages/scripts/src/ops-wa/habits"
import { UNSET_REPOS } from "../../../../../packages/scripts/src/trace-count/kinds"
import { fakeSocket, groupJid, jid, OWNER, STRANGER } from "./fake-socket"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const HOUR = 3_600_000
const START = Date.parse("2026-11-11T03:00:00Z")
const ASSISTANT = "k3m9px-worker"

// One bridge over a fake socket in a scratch data folder: the relay's lines and who each went to, the waits it asked for and a clock the waits move; WhatsApp mode is on, the dispatcher idle and the assistant seat ASSISTANT's unless the test says otherwise.
const harness = (inbox?: Inbox, media?: Media) => {
  const dir = join(mkdtempSync(join(tmpdir(), "ops-wa-")), "whatsapp")
  dirs.push(dir)
  const fake = fakeSocket()
  const relayed: string[] = []
  const routed: { text: string; to: string }[] = []
  const logs: string[] = []
  const waits: number[] = []
  const mode = {
    busy: false,
    // a relay whose text holds it throws, as a failed sendAs would
    fails: undefined as string | undefined,
    on: true,
    seat: ASSISTANT as string | undefined,
    stuck: null as Stuck,
  }
  let now = START
  fake.setClock(() => now)
  const base = {
    dir,
    now: () => now,
    owner: OWNER,
    sleep: async (ms: number) => {
      waits.push(ms)
      now += ms
    },
  }
  const send = sender({ ...base, sock: fake.sock })
  const watched = bridge({
    ...base,
    assistant: async () => mode.seat,
    busy: async () => mode.busy,
    log: (line) => logs.push(line),
    on: async () => mode.on,
    relay: async (to: string, text: string) => {
      if (mode.fails && text.includes(mode.fails)) throw new Error("the relay failed")
      routed.push({ text, to })
      if (to === "dispatcher") relayed.push(text)
    },
    reply: send,
    stuck: async () => mode.stuck,
    inbox,
    media,
  })
  watched.attach(fake.sock)
  return {
    advance: (ms: number) => (now += ms),
    dir,
    dropped: async () =>
      (
        await Bun.file(join(dir, "dropped.log"))
          .text()
          .catch(() => "")
      )
        .split("\n")
        .filter(Boolean),
    fake,
    logs,
    mode,
    // one failover and update pass, waited out
    pass: async () => {
      watched.pass()
      await watched.idle()
    },
    relayed,
    routed,
    send,
    // the handlers queue on the emitter's turn and each writes a file, so a test waits for the queue to empty before it reads
    settle: watched.idle,
    waits,
  }
}

describe("ops-wa's bridge", () => {
  test("hands the owner's message to the dispatcher whole, with how to answer", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "is the train moving?\nsecond line")])
    await h.settle()
    expect(h.relayed).toHaveLength(1)
    expect(h.relayed[0]).toContain("is the train moving?\nsecond line")
    expect(h.relayed[0]).toContain(REPLY)
    expect(await h.dropped()).toEqual([])
  })

  test("tells the dispatcher to answer with factory status alone, door 2's line", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "status?")])
    await h.settle()
    expect(h.relayed[0]).toEndWith(
      "Answer with factory status alone, no org work, secret or customer data, through playground wa send <file>.",
    )
  })

  test("keeps every send and the owner's last message when both land at once, so the hourly cap counts them all", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "go")])
    await h.settle()
    const sends = [1, 2, 3, 4, 5].map((n) => {
      h.fake.upsert([h.fake.message(jid(OWNER), `more ${n}`)])
      return h.send(`part ${n}`)
    })
    await Promise.all(sends)
    await h.settle()
    const kept = (await Bun.file(join(h.dir, "sends.json")).json()) as { sends: number[] }
    expect(kept.sends).toHaveLength(5)
    const owner = (await Bun.file(join(h.dir, "owner.json")).json()) as { ownerAt: number }
    expect(owner.ownerAt).toBeGreaterThanOrEqual(START)
    expect(h.relayed).toHaveLength(6)
  })

  test("sends the reply to the owner's number alone, with no link preview", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "status?")])
    await h.settle()
    expect(await h.send("**3 PRs** merged, see [the board](https://example.test/b)")).toBe("sent")
    expect(h.fake.sent).toEqual([
      {
        at: expect.any(Number),
        content: {
          linkPreview: null,
          text: "*3 PRs* merged, see the board (https://example.test/b)",
        },
        jid: jid(OWNER),
      },
    ])
  })

  test("drops a stranger's message, logging its time, kind and last 4 digits alone", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(STRANGER), "a made-up stranger's words")])
    await h.settle()
    expect(h.relayed).toEqual([])
    const lines = await h.dropped()
    expect(lines).toEqual([`${new Date(START).toISOString()} stranger ...0777`])
    expect(lines.join("\n")).not.toContain("made-up stranger")
    expect(lines.join("\n")).not.toContain(STRANGER.slice(1))
  })

  test("refuses a body holding a token shape, sending nothing", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "token?")])
    await h.settle()
    const body = `here: ghp_${"a".repeat(36)}`
    await expect(h.send(body)).rejects.toThrow("a GitHub token")
    expect(h.fake.sent).toEqual([])
  })

  test("drops a group's, a status's, a broadcast's and a newsletter's message, and a call, each logged", async () => {
    const h = harness()
    h.fake.upsert([
      h.fake.message(groupJid("120363000000000001"), "group words", { participant: jid(OWNER) }),
      h.fake.message("status@broadcast", "status words", { participant: jid(OWNER) }),
      h.fake.message("1234567890@broadcast", "broadcast words"),
      h.fake.message("120363000000000002@newsletter", "news"),
    ])
    h.fake.emit("call", [{ from: jid(STRANGER), status: "offer" }])
    await h.settle()
    expect(h.relayed).toEqual([])
    expect((await h.dropped()).map((l) => l.split(" ")[1])).toEqual([
      "group",
      "status",
      "broadcast",
      "newsletter",
      "call",
    ])
  })

  test("passes over its own messages and a history sync's, and logs neither", async () => {
    const h = harness()
    h.fake.upsert([
      { ...h.fake.message(jid(OWNER), "mine"), key: { fromMe: true, remoteJid: jid(OWNER) } },
    ])
    h.fake.upsert([h.fake.message(jid(OWNER), "old")], "append")
    await h.settle()
    expect(h.relayed).toEqual([])
    expect(await h.dropped()).toEqual([])
  })

  test("knows the owner by the phone number Baileys gives beside a LID", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message("99887766554433@lid", "via lid", { remoteJidAlt: jid(OWNER) })])
    await h.settle()
    expect(h.relayed).toHaveLength(1)
    expect(h.relayed[0]).toContain("via lid")
  })

  test("tells the dispatcher of a message with no text, without its content", async () => {
    const h = harness()
    h.fake.upsert([
      { ...h.fake.message(jid(OWNER), ""), message: { imageMessage: { caption: "x" } } },
    ])
    await h.settle()
    expect(h.relayed).toHaveLength(1)
    expect(h.relayed[0]).toContain("an image")
    expect(h.relayed[0]).not.toContain("caption")
  })

  test("never starts a chat: it sends only within 24 hours of the owner's last message", async () => {
    const h = harness()
    await expect(h.send("hello first")).rejects.toThrow("has not written in the last 24 hours")
    h.fake.upsert([h.fake.message(jid(OWNER), "hi")])
    await h.settle()
    expect(await h.send("reply")).toBe("sent")
    h.advance(24 * HOUR + 1)
    await expect(h.send("late")).rejects.toThrow("has not written in the last 24 hours")
    expect(h.fake.sent).toHaveLength(1)
  })

  test("paces sends one at a time, a second apart, and a split message's parts 300 ms apart", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "go")])
    await h.settle()
    await Promise.all([h.send("one"), h.send("two")])
    const [a, b] = h.fake.sent
    expect(b!.at - a!.at).toBeGreaterThanOrEqual(SEND.gapMs)
    const long = Array.from({ length: 3 }, (_, i) => `${i}`.repeat(SEND.partChars - 10)).join(
      "\n\n",
    )
    h.advance(SEND.gapMs)
    expect(await h.send(long)).toBe("sent")
    const parts = h.fake.sent.slice(2)
    expect(parts).toHaveLength(3)
    expect(parts[1]!.at - parts[0]!.at).toBeGreaterThanOrEqual(SEND.partGapMs)
    expect(parts[2]!.at - parts[1]!.at).toBeGreaterThanOrEqual(SEND.partGapMs)
    expect(parts.map((p) => p.content.text).join("\n\n")).toBe(long)
  })

  test("refuses the 61st send in an hour, naming when it frees, and counts across restarts", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "go")])
    await h.settle()
    for (let i = 0; i < SEND.perHour; i++) await h.send(`n${i}`)
    // a new sender over the same folder stands for a restart of ops-wa
    const again = sender({
      dir: h.dir,
      now: () => START + 70_000,
      owner: OWNER,
      sleep: async () => {},
      sock: h.fake.sock,
    })
    await expect(again("one more")).rejects.toThrow(
      /the hourly cap of 60 sends is reached until \d\d:\d\dZ/,
    )
    expect(h.fake.sent).toHaveLength(SEND.perHour)
  })

  test("never marks a message read nor sends presence", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "hi")])
    await h.settle()
    await h.send("ok")
    expect(h.fake.calls).toEqual([])
  })

  test("keeps its folder to the owner (700) and its files too (600)", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "hi"), h.fake.message(jid(STRANGER), "x")])
    await h.settle()
    await h.send("ok")
    expect(statSync(h.dir).mode & 0o777).toBe(0o700)
    for (const file of ["dropped.log", "owner.json", "sends.json"])
      expect(statSync(join(h.dir, file)).mode & 0o777).toBe(0o600)
  })
})

describe("WhatsApp mode", () => {
  test("while it is off, an owner message goes no further and gets one reply an hour saying so", async () => {
    const h = harness()
    h.mode.on = false
    h.fake.upsert([h.fake.message(jid(OWNER), "status?"), h.fake.message(jid(OWNER), "hello?")])
    await h.settle()
    expect(h.routed).toEqual([])
    expect(h.fake.sent.map((s) => s.content.text)).toEqual([OFF])
    h.advance(HOUR)
    h.fake.upsert([h.fake.message(jid(OWNER), "now?")])
    await h.settle()
    expect(h.fake.sent).toHaveLength(2)
  })

  test("hands a message with no reply in 3 minutes to the assistant seat too, once", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "is it green?")])
    await h.settle()
    h.advance(2 * 60_000)
    await h.pass()
    expect(h.routed.map((r) => r.to)).toEqual(["dispatcher"])
    h.advance(60_000)
    await h.pass()
    await h.pass()
    expect(h.routed.map((r) => r.to)).toEqual(["dispatcher", ASSISTANT])
    expect(h.routed[1]!.text).toStartWith("Handed on since no reply has gone out in 3 minutes.")
    expect(h.routed[1]!.text).toContain("is it green?")
  })

  test("a reply sent in time keeps the message with the dispatcher, and a dispatcher mid-turn holds the hand-on", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "one")])
    await h.settle()
    await h.send("on it")
    h.advance(5 * 60_000)
    await h.pass()
    h.mode.busy = true
    h.fake.upsert([h.fake.message(jid(OWNER), "two")])
    await h.settle()
    h.advance(5 * 60_000)
    await h.pass()
    expect(h.routed.map((r) => r.to)).toEqual(["dispatcher", "dispatcher"])
    h.mode.busy = false
    await h.pass()
    expect(h.routed.map((r) => r.to)).toEqual(["dispatcher", "dispatcher", ASSISTANT])
  })

  test("a stuck dispatcher hands on at once, and with no assistant seat the log says it stays", async () => {
    const h = harness()
    h.mode.stuck = { at: "2026-11-11T02:55:00.000Z", state: "stuck" }
    h.fake.upsert([h.fake.message(jid(OWNER), "hi")])
    await h.settle()
    await h.pass()
    expect(h.routed[1]!.text).toStartWith(
      "Handed on since the dispatcher has read stuck since 2026-11-11T02:55:00.000Z.",
    )
    const alone = harness()
    alone.mode.seat = undefined
    alone.fake.upsert([alone.fake.message(jid(OWNER), "hi")])
    await alone.settle()
    alone.advance(3 * 60_000)
    await alone.pass()
    expect(alone.routed.map((r) => r.to)).toEqual(["dispatcher"])
    expect(alone.logs.join("\n")).toContain("stays with the dispatcher alone")
  })

  test("while it is off, a pass hands nothing on and keeps the file for when it is on again", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "still there?")])
    await h.settle()
    h.mode.on = false
    h.advance(5 * 60_000)
    await h.pass()
    expect(h.routed.map((r) => r.to)).toEqual(["dispatcher"])
    h.mode.on = true
    await h.pass()
    expect(h.routed.map((r) => r.to)).toEqual(["dispatcher", ASSISTANT])
  })

  test("a hand-on that throws keeps the marks of those sent before it, so each goes to the assistant once", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "first"), h.fake.message(jid(OWNER), "second")])
    await h.settle()
    h.advance(3 * 60_000)
    h.mode.fails = "second"
    await h.pass()
    expect(h.logs.join("\n")).toContain("the relay failed")
    h.mode.fails = undefined
    await h.pass()
    const toSeat = h.routed.filter((r) => r.to === ASSISTANT).map((r) => r.text)
    expect(toSeat).toHaveLength(2)
    expect(toSeat[0]).toContain("first")
    expect(toSeat[1]).toContain("second")
  })

  test("asks the dispatcher for an update every 15 minutes while the owner has written in the last 24 hours", async () => {
    const h = harness()
    h.fake.upsert([h.fake.message(jid(OWNER), "keep me posted")])
    await h.settle()
    await h.send("will do")
    const updates = () => h.routed.filter((r) => r.text === UPDATE).length
    h.advance(UPDATE_MS - 1)
    await h.pass()
    expect(updates()).toBe(0)
    h.advance(1)
    await h.pass()
    expect(updates()).toBe(1)
    h.advance(UPDATE_MS)
    await h.pass()
    expect(updates()).toBe(2)
    h.advance(24 * HOUR)
    await h.pass()
    expect(updates()).toBe(2)
  })
})

describe("toWhatsApp", () => {
  test("turns markdown into WhatsApp's own marks, links as plain text", () => {
    expect(toWhatsApp("# Head\n**bold** and __it__, [a](https://x.test)")).toBe(
      "*Head*\n*bold* and _it_, a (https://x.test)",
    )
    expect(toWhatsApp("```\ncode **kept**\n```")).toBe("```\ncode **kept**\n```")
  })
})

// A made-up list for no-public-leak and an Inbox held in memory: its open cards, and each answer the bridge records through it.
const TERMS = termsOf(
  { companies: ["Acmeworks"], handles: [], linearKeys: [], names: ["Quillon Barr"], slackIds: [] },
  UNSET_REPOS,
)
const card = (
  ref: number,
  over: Partial<Card> = {},
  preview: Partial<Card["preview"]> = {},
): Card => ({
  from: "builder",
  id: `id-${ref}`,
  kind: "decision",
  preview: {
    approve: "Merge it",
    deny: "Hold it",
    scope: "factory",
    text: "Merge tonight?",
    type: "ask",
    ...preview,
  },
  ref,
  status: "open",
  title: `Card ${ref}`,
  ...over,
})
const inboxOf = (open: Card[], terms: typeof TERMS | null = TERMS) => {
  const answers: { answer: unknown; id: string }[] = []
  const inbox: Inbox = {
    answer: async (id, answer) => {
      answers.push({ answer, id })
      const answering = open.find((c) => c.id === id)
      if (answering?.status !== "open") return "This item is already answered"
      answering.status = "approved"
    },
    open: async () => open.filter((c) => c.status === "open"),
    terms: async () => terms ?? undefined,
  }
  return { answers, inbox, open }
}
// the owner writes first, since ops-wa never starts a chat, then one pass sends the cards
const withCards = async (open: Card[], terms?: typeof TERMS | null) => {
  const ib = inboxOf(open, terms)
  const h = harness(ib.inbox)
  h.fake.upsert([h.fake.message(jid(OWNER), "hello")])
  await h.settle()
  await h.pass()
  const texts = () => h.fake.sent.map((s) => s.content.text)
  return { ...h, ...ib, texts }
}
const say = async (h: Awaited<ReturnType<typeof withCards>>, text: string, from = OWNER) => {
  const before = h.fake.sent.length
  h.fake.upsert([h.fake.message(jid(from), text)])
  await h.settle()
  return h.fake.sent.slice(before).map((s) => s.content.text)
}

describe("Inbox cards on WhatsApp", () => {
  test("an open ask goes out once, numbered, naming its id, and a second pass sends it again never", async () => {
    const h = await withCards([card(12)])
    expect(h.texts()).toEqual([
      "*Card 12*\nMerge tonight?\nReply 1 #i12 to Merge it\nReply 2 #i12 to Hold it",
    ])
    await h.pass()
    expect(h.texts()).toHaveLength(1)
  })

  test("a card with no scope or an org's scope stays in the Inbox and counts in the waiting line, failing closed", async () => {
    const h = await withCards([
      card(12, {}, { scope: undefined }),
      card(13, {}, { scope: "zyx-org" }),
    ])
    expect(h.texts()).toEqual([waitingLine(2)])
    expect(await say(h, "1 #i13")).toEqual([notSent(13)])
    expect(h.answers).toEqual([])
  })

  test("no card goes before the owner has written, since ops-wa never starts a chat", async () => {
    const ib = inboxOf([card(12)])
    const h = harness(ib.inbox)
    await h.pass()
    expect(h.fake.sent).toEqual([])
  })

  test("the owner's reply answers the card through the Inbox's route and says what it answered", async () => {
    const h = await withCards([card(12)])
    expect(await say(h, "1 #i12")).toEqual(["Answered #i12: Merge it."])
    expect(h.answers).toEqual([{ answer: { action: "approve" }, id: "id-12" }])
    expect(await say(h, "#i12 2")).toEqual([
      "#i12 was not answered: This item is already answered. Answer it in the Inbox.",
    ])
    expect(h.relayed.filter((line) => line.includes("#i12"))).toEqual([])
  })

  test("a lettered ask's pick names its option, and None of these denies", async () => {
    const open = [
      card(
        7,
        {},
        {
          approve: undefined,
          deny: undefined,
          options: [{ label: "Tonight" }, { label: "Tomorrow" }],
        },
      ),
    ]
    const h = await withCards(open)
    await say(h, "2 #i7")
    expect(h.answers.at(-1)).toEqual({ answer: { action: "approve", option: 1 }, id: "id-7" })
  })

  test("a bare number or id, while no card that went out waits on its rows, goes to the dispatcher", async () => {
    const h = await withCards([card(12, { kind: "update" }, { type: undefined })])
    expect(await say(h, "2")).toEqual([])
    expect(await say(h, "#i12")).toEqual([])
    expect(h.relayed.filter((line) => /reads: (2|#i12)\n/.test(line))).toHaveLength(2)
    expect(h.answers).toEqual([])
  })

  test("a bare number after its card is answered goes to the dispatcher", async () => {
    const h = await withCards([card(12)])
    await say(h, "1 #i12")
    expect(await say(h, "2")).toEqual([])
    expect(h.relayed.filter((line) => line.includes("reads: 2\n"))).toHaveLength(1)
  })

  test("a reply with no card id answers nothing and says so", async () => {
    const h = await withCards([card(12)])
    expect(await say(h, "1")).toEqual([NO_ID])
    expect(h.answers).toEqual([])
    expect(h.relayed.filter((line) => line.includes("reads: 1\n"))).toEqual([])
  })

  test("a reply naming an unknown id answers nothing and says so", async () => {
    const h = await withCards([card(12)])
    expect(await say(h, "1 #i99")).toEqual([notSent(99)])
    expect(h.answers).toEqual([])
  })

  test("a reply naming a card that never went out answers nothing, whatever its kind", async () => {
    const kept = [
      card(20, {}, { type: "delete", what: "/tmp/x", why: "old" } as never),
      card(21, {}, { key: "FAKE_KEY", type: "secret" } as never),
      card(22, {}, { amount: "$5", type: "budget", why: "a run" } as never),
      card(23, {}, { sha: "abcdef1", type: "ship" } as never),
      card(24, {}, { shape: "a table", type: "schema" } as never),
      card(25, {}, { key: "wa.owner", type: "guard", value: "15550000000" } as never),
    ]
    const h = await withCards(kept)
    expect(h.texts()).toEqual([waitingLine(6)])
    expect(h.texts().join("\n")).not.toContain("15550000000")
    for (const ref of [20, 21, 22, 23, 24, 25])
      expect(await say(h, `1 #i${ref}`)).toEqual([notSent(ref)])
    expect(h.answers).toEqual([])
  })

  test("a number past the card's rows answers nothing and says so", async () => {
    const h = await withCards([card(12)])
    expect(await say(h, "3 #i12")).toEqual([noRow(12, 2)])
    expect(h.answers).toEqual([])
  })

  test("a stranger's reply answers nothing and gets no line back, dropped as any stranger's message", async () => {
    const h = await withCards([card(12)])
    expect(await say(h, "1 #i12", STRANGER)).toEqual([])
    expect(h.answers).toEqual([])
    expect(await h.dropped()).toHaveLength(1)
  })

  test("an update goes out read-only, and a reply to it answers nothing", async () => {
    const h = await withCards([
      card(30, { kind: "update", title: "#1828 merged" }, { text: "CI is green", type: undefined }),
    ])
    expect(h.texts()).toEqual(["*#1828 merged*\nCI is green\n#i30 is an update: it asks nothing."])
    expect(await say(h, "1 #i30")).toEqual([noRow(30, 0)])
    expect(h.answers).toEqual([])
  })

  test("each kept card counts in one waiting line, sent again only when the cards it counts change", async () => {
    const open = [
      card(12),
      card(40, { from: "acme-sync" }),
      card(41, {}, { text: "for Acmeworks" }),
    ]
    const h = await withCards(open)
    expect(h.texts()).toEqual([expect.stringContaining("#i12"), waitingLine(2)])
    await h.pass()
    expect(h.texts()).toHaveLength(2)
    open.push(
      card(42, { kind: "draft" }, { text: "a reply", to: "a thread", type: undefined } as never),
    )
    await h.pass()
    expect(h.texts().at(-1)).toBe(waitingLine(3))
    expect(h.texts().join("\n")).not.toContain("Acmeworks")
  })

  test("a card that goes is redacted first", async () => {
    const h = await withCards([
      card(12, { title: "Ask Quillon Barr" }, { text: `token ghp_${"a".repeat(36)}` }),
    ])
    expect(h.texts()[0]).toStartWith("*Ask [hidden]*\ntoken [hidden]\n")
  })

  test("while no-public-leak's list cannot be read, no card goes, and the waiting line counts them all", async () => {
    const h = await withCards([card(12), card(13)], null)
    expect(h.texts()).toEqual([waitingLine(2)])
  })

  test("while WhatsApp mode is off, a reply is no answer and gets the off line", async () => {
    const h = await withCards([card(12)])
    h.mode.on = false
    expect(await say(h, "1 #i12")).toEqual([OFF])
    expect(h.answers).toEqual([])
  })

  test("a plain message still goes to the dispatcher", async () => {
    const h = await withCards([card(12)])
    await say(h, "is #i12 merged?")
    expect(h.relayed.at(-1)).toContain("is #i12 merged?")
  })
})

// A media folder beside the scratch whatsapp/, a download that hands back made-up bytes, and a transcriber that reads them as words unless the test says it cannot.
const withMedia = (words: string | null = "merge the fix tonight") => {
  const root = mkdtempSync(join(tmpdir(), "ops-wa-media-"))
  dirs.push(root)
  const calls = { download: 0, transcribe: [] as string[] }
  const media: Media = {
    dir: join(root, "wa", "media"),
    download: async () => {
      calls.download++
      return new TextEncoder().encode("made-up bytes")
    },
    transcribe: async (path) => {
      calls.transcribe.push(path)
      return words ?? undefined
    },
  }
  const h = harness(undefined, media)
  return { ...h, calls, media }
}
const photo = (h: ReturnType<typeof harness>, caption?: string, from = OWNER) => ({
  ...h.fake.message(jid(from), ""),
  message: { imageMessage: { caption, mimetype: "image/jpeg" } },
})
const voice = (h: ReturnType<typeof harness>) => ({
  ...h.fake.message(jid(OWNER), ""),
  message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } },
})
const keptPath = (line: string) => line.match(/kept at (\S+?)(?:,|\n|$)/)?.[1] ?? ""

describe("photos and voice notes", () => {
  test("a photo is kept in the media folder, the owner's alone, and the dispatcher's line names its path and caption", async () => {
    const h = withMedia()
    h.fake.upsert([photo(h, "the build page")])
    await h.settle()
    expect(h.relayed).toHaveLength(1)
    const path = keptPath(h.relayed[0]!)
    expect(path.startsWith(h.media.dir)).toBe(true)
    expect(path.endsWith(".jpg")).toBe(true)
    expect(h.relayed[0]).toContain("holds a photo, kept at")
    expect(h.relayed[0]).toContain("with the words: the build page")
    expect(await Bun.file(path).text()).toBe("made-up bytes")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(h.media.dir).mode & 0o777).toBe(0o700)
    expect(path.includes("/whatsapp/")).toBe(false)
  })

  test("a photo with no caption names its path alone", async () => {
    const h = withMedia()
    h.fake.upsert([photo(h)])
    await h.settle()
    expect(h.relayed[0]).toMatch(/holds a photo, kept at \S+\.jpg\n/)
    expect(h.calls.transcribe).toEqual([])
  })

  test("a voice note is read on this Mac, and the dispatcher reads its words", async () => {
    const h = withMedia()
    h.fake.upsert([voice(h)])
    await h.settle()
    const path = keptPath(h.relayed[0]!)
    expect(path.endsWith(".ogg")).toBe(true)
    expect(h.calls.transcribe).toEqual([path])
    expect(h.relayed[0]).toContain("holds a voice note, kept at")
    expect(h.relayed[0]).toContain("which says: merge the fix tonight")
  })

  test("a voice note no tool can read goes on as not transcribed, with its path", async () => {
    const h = withMedia(null)
    h.fake.upsert([voice(h)])
    await h.settle()
    expect(h.relayed[0]).toMatch(/holds a voice note, not transcribed, kept at \S+\.ogg\n/)
  })

  test("a download that fails is logged, and the dispatcher hears the kind alone", async () => {
    const h = withMedia()
    h.media.download = async () => {
      throw new Error("media gone")
    }
    h.fake.upsert([photo(h, "x")])
    await h.settle()
    expect(h.relayed[0]).toContain("holds an image, which ops-wa does not read yet")
    expect(h.logs.some((l) => l.includes("not kept: media gone"))).toBe(true)
  })

  test("a stranger's photo is dropped and never downloaded", async () => {
    const h = withMedia()
    h.fake.upsert([photo(h, "x", STRANGER)])
    await h.settle()
    expect(h.calls.download).toBe(0)
    expect(h.relayed).toEqual([])
    expect(await h.dropped()).toHaveLength(1)
  })

  test("while WhatsApp mode is off, nothing is downloaded", async () => {
    const h = withMedia()
    h.mode.on = false
    h.fake.upsert([photo(h, "x")])
    await h.settle()
    expect(h.calls.download).toBe(0)
    expect(h.relayed).toEqual([])
  })

  test("any other kind still reaches the dispatcher by its kind alone", async () => {
    const h = withMedia()
    h.fake.upsert([{ ...h.fake.message(jid(OWNER), ""), message: { stickerMessage: {} } }])
    await h.settle()
    expect(h.calls.download).toBe(0)
    expect(h.relayed[0]).toContain("holds a sticker, which ops-wa does not read yet")
  })
})
