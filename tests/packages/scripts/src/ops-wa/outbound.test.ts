import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type Kind, sender } from "../../../../../packages/scripts/src/ops-wa/bridge"
import { SEND, typingMs, writeOwn } from "../../../../../packages/scripts/src/ops-wa/habits"
import {
  type Extra,
  messagesOf,
  outboxDir,
  readOutbound,
} from "../../../../../packages/scripts/src/ops-wa/outbound"
import { ALERT, fakeSocket, jid, OWNER, SPARE } from "./fake-socket"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const START = Date.parse("2026-11-18T03:00:00Z")
const BYTES = Buffer.from("made-up bytes")

// A sender over a fake socket in a scratch data folder, the owner and the alert number each written an hour ago, with an outbox holding made-up files.
const harness = async () => {
  const data = mkdtempSync(join(tmpdir(), "ops-wa-out-"))
  dirs.push(data)
  const dir = join(data, "whatsapp")
  const outbox = outboxDir(data)
  mkdirSync(outbox, { recursive: true })
  await writeOwn(join(dir, "owner.json"), { jid: jid(OWNER), ownerAt: START - 3_600_000 })
  await writeOwn(join(dir, "alert.json"), { alertAt: START - 3_600_000, jid: jid(ALERT) })
  const fake = fakeSocket()
  let now = START
  fake.setClock(() => now)
  const send = sender({
    alert: async () => ALERT,
    device: SPARE,
    dir,
    now: () => now,
    owner: OWNER,
    random: () => 0.5,
    sleep: async (ms) => void (now += ms),
    sock: fake.sock,
  })
  const file = (name: string, bytes: string | Buffer = BYTES) => {
    const path = join(outbox, name)
    writeFileSync(path, bytes)
    return path
  }
  return {
    advance: (ms: number) => void (now += ms),
    data,
    dir,
    fake,
    file,
    outbox,
    // a file's send by its path, the shape #2783's tests take
    send: (body: string, kind: Kind, path?: string) =>
      send(body, kind, undefined, path === undefined ? {} : { file: path }),
    // a send with its extra, no alert source
    sender: Object.assign(
      (body: string, kind: Kind, extra: Extra = {}) => send(body, kind, undefined, extra),
      {
        out: (body: string, kind: Kind, extra: Extra = {}) =>
          send.out(body, kind, undefined, extra),
      },
    ),
  }
}

describe("wa send's files (#2783)", () => {
  test("an image, a video and a document carry the body as their caption, a document its file name", async () => {
    const h = await harness()
    expect(await h.send("the new board", "reply", h.file("board.png"))).toBe("sent")
    expect(await h.send("a short run", "reply", h.file("run.mp4"))).toBe("sent")
    expect(await h.send("the week's notes", "reply", h.file("notes.pdf"))).toBe("sent")
    expect(h.fake.sent.map((s) => [s.jid, s.content])).toEqual([
      [jid(OWNER), { caption: "the new board", image: BYTES, mimetype: "image/png" }],
      [jid(OWNER), { caption: "a short run", mimetype: "video/mp4", video: BYTES }],
      [
        jid(OWNER),
        {
          caption: "the week's notes",
          document: BYTES,
          fileName: "notes.pdf",
          mimetype: "application/pdf",
        },
      ],
    ])
  })

  test("a voice note takes no caption, so the body goes first as text and the note after it", async () => {
    const h = await harness()
    expect(await h.send("listen to this", "reply", h.file("note.ogg"))).toBe("sent")
    expect(h.fake.sent.map((s) => s.content)).toEqual([
      { linkPreview: null, text: "listen to this" },
      { audio: BYTES, mimetype: "audio/ogg; codecs=opus", ptt: true },
    ])
  })

  test("a file with no body goes alone, with no caption and no empty text", async () => {
    const h = await harness()
    expect(await h.send("", "reply", h.file("shot.jpg"))).toBe("sent")
    expect(await h.send("", "reply", h.file("hello.opus"))).toBe("sent")
    expect(h.fake.sent.map((s) => s.content)).toEqual([
      { caption: undefined, image: BYTES, mimetype: "image/jpeg" },
      { audio: BYTES, mimetype: "audio/ogg; codecs=opus", ptt: true },
    ])
  })

  test("a file's caption is kept in ours.json, so the owner's reaction on the file names its words; a file with none is not", async () => {
    const h = await harness()
    await h.send("the new board", "reply", h.file("board.png"))
    await h.send("", "reply", h.file("shot.jpg"))
    const { messages } = await Bun.file(join(h.data, "whatsapp", "ours.json")).json()
    expect(messages).toEqual([{ id: "m1", text: "the new board" }])
  })

  test("a caption waits its typing time as a text does, and a file with no caption goes on the gap alone", async () => {
    const h = await harness()
    const caption = "the new board, with this week's three changes"
    await h.send("", "reply", h.file("shot.jpg"))
    await h.send(caption, "reply", h.file("board.png"))
    await h.send("", "reply", h.file("hello.opus"))
    const [bare, captioned, note] = h.fake.sent.map((s) => s.at)
    expect(bare).toBe(START)
    expect(captioned! - bare!).toBe(typingMs(caption.length, () => 0.5))
    expect(typingMs(caption.length, () => 0.5)).toBeGreaterThan(SEND.gapMs)
    expect(note! - captioned!).toBe(SEND.gapMs)
  })

  test("a long caption keeps its first part on the file, and the rest follow as text, each paced as a part", async () => {
    const parts = messagesOf(["first", "second"], {
      file: { bytes: BYTES, kind: "image", mimetype: "image/png", name: "a.png" },
    })
    expect(parts).toEqual([
      { caption: "first", image: BYTES, mimetype: "image/png" },
      { linkPreview: null, text: "second" },
    ])
    const h = await harness()
    await h.send("one", "reply")
    await h.send("two", "reply", h.file("b.png"))
    expect(h.fake.sent[1]!.at - h.fake.sent[0]!.at).toBeGreaterThanOrEqual(1_000)
  })

  test("with --to alert a file reaches the alert number alone", async () => {
    const h = await harness()
    expect(await h.send("for you", "guest", h.file("plan.md", "# made-up plan\n"))).toBe("sent")
    expect(h.fake.sent.map((s) => [s.jid, s.content.fileName, s.content.caption])).toEqual([
      [jid(ALERT), "plan.md", "for you"],
    ])
  })

  test("a file outside the outbox, through a link out of it, or of an unknown type is refused, and nothing goes", async () => {
    const h = await harness()
    const outside = join(h.data, "secret.png")
    writeFileSync(outside, BYTES)
    const link = join(h.outbox, "link.png")
    symlinkSync(outside, link)
    await expect(h.send("x", "reply", outside)).rejects.toThrow(
      `wa send takes a file from ${h.outbox} alone`,
    )
    await expect(h.send("x", "reply", link)).rejects.toThrow("takes a file from")
    await expect(h.send("x", "reply", join(h.outbox, "gone.png"))).rejects.toThrow(
      "takes a file from",
    )
    await expect(h.send("x", "reply", h.file("tool.sh"))).rejects.toThrow(
      "wa send takes a file of these types alone: csv, jpeg, jpg",
    )
    mkdirSync(join(h.outbox, "dir.png"))
    await expect(h.send("x", "reply", join(h.outbox, "dir.png"))).rejects.toThrow(
      "a regular file alone",
    )
    expect(h.fake.sent).toEqual([])
  })

  test("a text document holding a token shape is refused as a body is, and a guest's holding an email address too", async () => {
    const h = await harness()
    const token = h.file("keys.txt", `ghp_${"a".repeat(36)}`)
    await expect(h.send("", "reply", token)).rejects.toThrow("never goes over WhatsApp")
    const email = h.file("contacts.csv", `name,mail\nmade-up,${["a", "example.test"].join("@")}\n`)
    await expect(h.send("", "guest", email)).rejects.toThrow("an email address")
    expect(h.fake.sent).toEqual([])
  })

  test("a file keeps the 24 hours: none goes once the owner has not written in them", async () => {
    const h = await harness()
    await writeOwn(join(h.data, "whatsapp", "owner.json"), { jid: jid(OWNER), ownerAt: 0 })
    await expect(h.send("late", "reply", h.file("late.png"))).rejects.toThrow(
      "has not written in the last 24 hours",
    )
    expect(h.fake.sent).toEqual([])
  })

  test("sends no presence and marks nothing read", async () => {
    const h = await harness()
    await h.send("x", "reply", h.file("c.png"))
    expect(h.fake.calls).toEqual([])
  })

  test("readOutbound names the file's kind, mime and name, and reads a text document's words", async () => {
    const h = await harness()
    const read = await readOutbound(h.outbox, h.file("Notes.MD", "made-up words"))
    expect(read).toMatchObject({
      kind: "document",
      mimetype: "text/markdown",
      name: "Notes.MD",
      text: "made-up words",
    })
  })
})

describe("wa send's structure (#2799)", () => {
  // a kept message of the owner's and one of the guest's, as the bridge keeps each it hands on
  const kept = async (h: Awaited<ReturnType<typeof harness>>) =>
    writeOwn(join(h.dir, "messages.json"), {
      messages: [
        {
          at: START - 60_000,
          id: "own1",
          jid: jid(OWNER),
          text: "is the board green?",
          who: "owner",
        },
        { at: START - 60_000, id: "gst1", jid: jid(ALERT), text: "any news?", who: "alert" },
      ],
    })

  test("a location goes as one message, the body its name, and a bare one with no name", async () => {
    const h = await harness()
    expect(await h.sender("Made-up Cafe", "reply", { location: { lat: 12.5, lon: -45.25 } })).toBe(
      "sent",
    )
    expect(await h.sender("", "guest", { location: { lat: -90, lon: 180 } })).toBe("sent")
    expect(h.fake.sent.map((s) => [s.jid, s.content])).toEqual([
      [
        jid(OWNER),
        { location: { degreesLatitude: 12.5, degreesLongitude: -45.25, name: "Made-up Cafe" } },
      ],
      [jid(ALERT), { location: { degreesLatitude: -90, degreesLongitude: 180 } }],
    ])
  })

  test("a location out of range is refused, and nothing goes", async () => {
    const h = await harness()
    for (const location of [
      { lat: 91, lon: 0 },
      { lat: 0, lon: -180.5 },
      { lat: Number.NaN, lon: 0 },
    ])
      await expect(h.sender("", "reply", { location })).rejects.toThrow("a latitude from -90 to 90")
    expect(h.fake.sent).toEqual([])
  })

  test("a quoted reply's first part quotes the kept message by its id, its sender and its words", async () => {
    const h = await harness()
    await kept(h)
    expect(await h.sender("yes, all green", "reply", { quote: "own1" })).toBe("sent")
    expect(await h.sender("nothing new", "guest", { quote: "gst1" })).toBe("sent")
    expect(h.fake.sent.map((s) => [s.jid, s.content])).toEqual([
      [
        jid(OWNER),
        {
          contextInfo: {
            participant: jid(OWNER),
            quotedMessage: { conversation: "is the board green?" },
            stanzaId: "own1",
          },
          linkPreview: null,
          text: "yes, all green",
        },
      ],
      [
        jid(ALERT),
        {
          contextInfo: {
            participant: jid(ALERT),
            quotedMessage: { conversation: "any news?" },
            stanzaId: "gst1",
          },
          linkPreview: null,
          text: "nothing new",
        },
      ],
    ])
  })

  test("a quote of a kept message 24 hours old is refused, its words still in messages.json", async () => {
    const h = await harness()
    await writeOwn(join(h.dir, "messages.json"), {
      messages: [
        {
          at: START - 24 * 3_600_000,
          id: "old1",
          jid: jid(OWNER),
          text: "old words",
          who: "owner",
        },
      ],
    })
    await expect(h.sender("late", "reply", { quote: "old1" })).rejects.toThrow(
      "that message is over 24 hours old, and ops-wa quotes only inside its 24 hours",
    )
    expect(h.fake.sent).toEqual([])
  })

  test("a quote of an unknown id, or of the other chat's message, is refused, and nothing goes", async () => {
    const h = await harness()
    await kept(h)
    await expect(h.sender("x", "reply", { quote: "nope" })).rejects.toThrow(
      "no message nope from the owner is kept to quote",
    )
    await expect(h.sender("x", "reply", { quote: "gst1" })).rejects.toThrow("is kept to quote")
    await expect(h.sender("x", "guest", { quote: "own1" })).rejects.toThrow("is kept to quote")
    expect(h.fake.sent).toEqual([])
  })

  test("a send answers its messages' ids, and an edit or a delete names one of them in its own chat", async () => {
    const h = await harness()
    const first = await h.sender.out("the bord is green", "reply")
    expect(first).toEqual({ ids: ["m1"], said: "sent" })
    expect(await h.sender("the board is green", "reply", { edit: "m1" })).toBe("sent")
    expect(await h.sender("", "reply", { delete: "m1" })).toBe("sent")
    const key = { fromMe: true, id: "m1", remoteJid: jid(OWNER) }
    expect(h.fake.sent.slice(1).map((s) => [s.jid, s.content])).toEqual([
      [jid(OWNER), { edit: key, linkPreview: null, text: "the board is green" }],
      [jid(OWNER), { delete: key }],
    ])
  })

  test("a delete takes its message out of own.json and ours.json, so a second delete or an edit of it is refused (#2899)", async () => {
    const h = await harness()
    await h.sender("the board is green", "reply")
    expect(await h.sender("", "reply", { delete: "m1" })).toBe("sent")
    await expect(h.sender("", "reply", { delete: "m1" })).rejects.toThrow(
      "message m1 is not one ops-wa sent to the owner, so it cannot be deleted",
    )
    await expect(h.sender("the board is red", "reply", { edit: "m1" })).rejects.toThrow(
      "message m1 is not one ops-wa sent to the owner, so it cannot be edited",
    )
    expect((await Bun.file(join(h.dir, "own.json")).json()).messages).toEqual([])
    expect((await Bun.file(join(h.dir, "ours.json")).json()).messages).toEqual([])
    expect(h.fake.sent).toHaveLength(2)
  })

  test("an edit gives the edited message its new words in ours.json, so a reaction on it reads them, and adds no row of its own", async () => {
    const h = await harness()
    await h.sender("the bord is green", "reply")
    await h.sender("the board is green", "reply", { edit: "m1" })
    const { messages } = await Bun.file(join(h.dir, "ours.json")).json()
    expect(messages).toEqual([{ id: "m1", text: "the board is green" }])
  })

  test("a part sent before a later part fails is kept in own.json, so it can still be deleted", async () => {
    const h = await harness()
    const real = h.fake.sock.sendMessage
    let calls = 0
    h.fake.sock.sendMessage = async (to, content) => {
      if (++calls === 2) throw new Error("dropped")
      return real(to, content)
    }
    const long = ["a", "b"].map((c) => c.repeat(SEND.partChars - 10)).join("\n\n")
    await expect(h.sender(long, "reply")).rejects.toThrow("dropped")
    expect(h.fake.sent).toHaveLength(1)
    h.fake.sock.sendMessage = real
    expect(await h.sender("", "reply", { delete: "m1" })).toBe("sent")
    expect(h.fake.sent.at(-1)!.content).toEqual({
      delete: { fromMe: true, id: "m1", remoteJid: jid(OWNER) },
    })
  })

  test("the same send after a failure mid-split sends only its unsent parts, and names every part's id (#2899)", async () => {
    const h = await harness()
    const real = h.fake.sock.sendMessage
    let calls = 0
    h.fake.sock.sendMessage = async (to, content) => {
      if (++calls === 2) throw new Error("dropped")
      return real(to, content)
    }
    const long = ["a", "b", "c"].map((c) => c.repeat(SEND.partChars - 10)).join("\n\n")
    await expect(h.sender.out(long, "reply")).rejects.toThrow("dropped")
    expect(await h.sender.out(long, "reply")).toEqual({ ids: ["m1", "m2", "m3"], said: "sent" })
    expect(h.fake.sent.map((s) => s.content.text?.[0])).toEqual(["a", "b", "c"])
    await h.sender.out(long, "reply")
    expect(h.fake.sent).toHaveLength(6)
  })

  test("a part deleted after a failure mid-split goes again with the rest", async () => {
    const h = await harness()
    const real = h.fake.sock.sendMessage
    let calls = 0
    h.fake.sock.sendMessage = async (to, content) => {
      if (++calls === 2) throw new Error("dropped")
      return real(to, content)
    }
    const long = ["a", "b"].map((c) => c.repeat(SEND.partChars - 10)).join("\n\n")
    await expect(h.sender.out(long, "reply")).rejects.toThrow("dropped")
    h.fake.sock.sendMessage = real
    await h.sender("", "reply", { delete: "m1" })
    await h.sender.out(long, "reply")
    expect(h.fake.sent.slice(2).map((s) => s.content.text?.[0])).toEqual(["a", "b"])
  })

  test("an edit or a delete of a message that is not ours is refused, and nothing goes", async () => {
    const h = await harness()
    await kept(h)
    await h.sender("to the owner", "reply")
    for (const [kind, extra, why] of [
      [
        "reply",
        { edit: "own1" },
        "message own1 is not one ops-wa sent to the owner, so it cannot be edited",
      ],
      [
        "reply",
        { delete: "zzz" },
        "message zzz is not one ops-wa sent to the owner, so it cannot be deleted",
      ],
      ["guest", { delete: "m1" }, "message m1 is not one ops-wa sent to the alert number"],
    ] as const)
      await expect(h.sender("edit" in extra ? "x" : "", kind, extra)).rejects.toThrow(why)
    expect(h.fake.sent).toHaveLength(1)
  })

  test("an edit goes only in the message's first 15 minutes", async () => {
    const h = await harness()
    await h.sender("first", "reply")
    h.advance(15 * 60_000 + 1)
    await expect(h.sender("second", "reply", { edit: "m1" })).rejects.toThrow(
      "WhatsApp edits a message only in its first 15 minutes",
    )
    expect(h.fake.sent).toHaveLength(1)
  })

  test("a send takes one extra, a quote beside text alone, and wa alert takes none", async () => {
    const h = await harness()
    for (const [body, extra, why] of [
      ["x", { file: h.file("a.png"), location: { lat: 0, lon: 0 } }, "one of a file, a location"],
      ["x", { file: h.file("b.png"), quote: "own1" }, "a quoted reply is text alone"],
      ["x", { delete: "m1" }, "a delete takes no body"],
      ["", { edit: "m1" }, "an edit or a quoted reply takes a body"],
    ] as const)
      await expect(h.sender(body, "reply", extra)).rejects.toThrow(why)
    await expect(h.sender("x", "alert", { quote: "own1" })).rejects.toThrow(
      "wa alert sends text alone",
    )
    // an alert's own refusal comes before the shape's, so a bodiless edit to an alert names the alert (#2899)
    await expect(h.sender("", "alert", { edit: "m1" })).rejects.toThrow("wa alert sends text alone")
    expect(h.fake.sent).toEqual([])
  })
})

describe("the live status (#2861)", () => {
  const live = async (h: Awaited<ReturnType<typeof harness>>) =>
    (await Bun.file(join(h.dir, "status.json")).json()) as { at: number; id: string; text: string }
  const key = (id: string) => ({ fromMe: true, id, remoteJid: jid(OWNER) })

  test("the first status goes as a new message, kept live in status.json at 600", async () => {
    const h = await harness()
    expect(await h.sender.out("3 PRs in review", "reply", { status: true })).toEqual({
      ids: ["m1"],
      said: "sent",
    })
    expect(h.fake.sent.map((s) => s.content)).toEqual([
      { linkPreview: null, text: "3 PRs in review" },
    ])
    expect(await live(h)).toEqual({ at: h.fake.sent[0]!.at, id: "m1", text: "3 PRs in review" })
    expect(statSync(join(h.dir, "status.json")).mode & 0o777).toBe(0o600)
  })

  test("a changed status edits the live message, which keeps its first send's time", async () => {
    const h = await harness()
    await h.sender("3 PRs in review", "reply", { status: true })
    const at = (await live(h)).at
    h.advance(10 * 60_000)
    expect(await h.sender.out("2 PRs in review, 1 merged", "reply", { status: true })).toEqual({
      ids: ["m1"],
      said: "edited the live status",
    })
    expect(h.fake.sent.at(-1)!.content).toEqual({
      edit: key("m1"),
      linkPreview: null,
      text: "2 PRs in review, 1 merged",
    })
    expect(await live(h)).toEqual({ at, id: "m1", text: "2 PRs in review, 1 merged" })
  })

  test("an unchanged status makes no socket call", async () => {
    const h = await harness()
    await h.sender("3 PRs in review", "reply", { status: true })
    h.advance(20 * 60_000)
    expect(await h.sender.out("3 PRs in review\n", "reply", { status: true })).toEqual({
      ids: [],
      said: "unchanged: the live status already reads this",
    })
    expect(h.fake.sent).toHaveLength(1)
  })

  test("a live status past WhatsApp's 15-minute edit window gets a new message, which becomes live", async () => {
    const h = await harness()
    await h.sender("3 PRs in review", "reply", { status: true })
    h.advance(15 * 60_000)
    await h.sender("2 PRs in review", "reply", { status: true })
    expect(h.fake.sent.at(-1)!.content).toEqual({ linkPreview: null, text: "2 PRs in review" })
    expect(await live(h)).toMatchObject({ id: "m2", text: "2 PRs in review" })
  })

  test("a live status with 5 messages after it in the owner's chat has scrolled away, and 4 do not", async () => {
    const h = await harness()
    await h.sender("3 PRs in review", "reply", { status: true })
    for (const n of [1, 2, 3]) {
      h.advance(1_000)
      await h.sender(`reply ${n}`, "reply")
    }
    h.advance(1_000)
    await writeOwn(join(h.dir, "messages.json"), {
      messages: [
        { at: START - 60_000, id: "old1", jid: jid(OWNER), text: "before it", who: "owner" },
        { at: START + 60_000, id: "own1", jid: jid(OWNER), text: "thanks", who: "owner" },
        { at: START + 60_000, id: "gst1", jid: jid(ALERT), text: "any news?", who: "alert" },
      ],
    })
    await h.sender("2 PRs in review", "reply", { status: true })
    expect(h.fake.sent.at(-1)!.content).toMatchObject({ edit: key("m1") })
    await h.sender("reply 4", "reply")
    await h.sender("1 PR in review", "reply", { status: true })
    expect(h.fake.sent.at(-1)!.content).toEqual({ linkPreview: null, text: "1 PR in review" })
    expect(await live(h)).toMatchObject({ id: "m7", text: "1 PR in review" })
  })

  test("a failed edit falls back to a new message, which becomes live", async () => {
    const h = await harness()
    await h.sender("3 PRs in review", "reply", { status: true })
    const real = h.fake.sock.sendMessage
    h.fake.sock.sendMessage = async (to, content) => {
      if ("edit" in content) throw new Error("made-up edit failure")
      return real(to, content)
    }
    expect(await h.sender("2 PRs in review", "reply", { status: true })).toBe(
      "sent: the live status's edit failed (made-up edit failure), so this one is live now",
    )
    expect(h.fake.sent.map((s) => s.content)).toEqual([
      { linkPreview: null, text: "3 PRs in review" },
      { linkPreview: null, text: "2 PRs in review" },
    ])
    expect(await live(h)).toMatchObject({ id: "m2", text: "2 PRs in review" })
  })

  test("a good edit whose state write fails sends no second status", async () => {
    const h = await harness()
    await h.sender("3 PRs in review", "reply", { status: true })
    const path = join(h.dir, "status.json")
    const real = h.fake.sock.sendMessage
    h.fake.sock.sendMessage = async (to, content) => {
      const sent = await real(to, content)
      // a folder where status.json was, so the write after the edit cannot land
      if ("edit" in content) {
        rmSync(path)
        mkdirSync(join(path, "x"), { recursive: true })
      }
      return sent
    }
    await expect(h.sender("2 PRs in review", "reply", { status: true })).rejects.toThrow(
      "status.json",
    )
    expect(h.fake.sent.map((s) => s.content)).toEqual([
      { linkPreview: null, text: "3 PRs in review" },
      { edit: key("m1"), linkPreview: null, text: "2 PRs in review" },
    ])
  })

  test("a status goes to the owner's chat alone, as text alone in one message, and nothing else goes", async () => {
    const h = await harness()
    for (const [kind, extra, body, why] of [
      ["guest", { status: true }, "hi", "a status goes to the owner's chat alone"],
      ["first", { status: true }, "hi", "wa alert sends text alone"],
      ["reply", { quote: "own1", status: true }, "hi", "a status is text alone"],
      ["reply", { status: true }, " ", "a status takes a body"],
      [
        "reply",
        { status: true },
        "x".repeat(SEND.partChars + 1),
        `a status fits one message, ${SEND.partChars} characters`,
      ],
    ] as const)
      await expect(h.sender(body, kind, extra)).rejects.toThrow(why)
    expect(h.fake.sent).toEqual([])
  })
})
