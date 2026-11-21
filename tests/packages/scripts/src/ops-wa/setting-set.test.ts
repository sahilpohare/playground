import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  keepMessage,
  keptFile,
  wordHashes,
  wordKey,
  wordKeyFile,
} from "../../../../../packages/scripts/src/ops-wa/alert-set"
import { bridge, type Inbox, sender } from "../../../../../packages/scripts/src/ops-wa/bridge"
import { type Card, NO_ID } from "../../../../../packages/scripts/src/ops-wa/cards"
import { serve, socketPath } from "../../../../../packages/scripts/src/ops-wa/server"
import {
  applyOwnerSetting,
  CONFIRM_MS,
  confirm,
  guarded,
  holds,
  ownerSettings,
  settingPropose,
  settingSet,
  type SettingSetIo,
} from "../../../../../packages/scripts/src/ops-wa/setting-set"
import { type Io, runStore } from "../../../../../packages/scripts/src/playground/store"
import { scopeDir } from "../../../../../packages/settings/src/rendered"
import { ALERT, fakeSocket, jid, OWNER, SPARE, STRANGER } from "./fake-socket"

process.env.PLAYGROUND_LOGIN = "made-up-me"

const scratch = mkdtempSync(join(tmpdir(), "ops-wa-setting-"))
// a unix socket's path must stay short, so a test that serves ops-wa's socket takes its data folder under /tmp
const short: string[] = []
afterAll(() => {
  for (const dir of [scratch, ...short]) rmSync(dir, { force: true, recursive: true })
})
let n = 0

const HOUR = 3_600_000
const START = Date.parse("2026-11-11T03:00:00Z")

// The settings CLI on a data folder of its own, as settings.test.ts runs it.
const cli = (data: string) => async (words: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const io: Io = { data, out: (l) => out.push(l), stdin: async () => "", write: Bun.write }
  const code = await runStore("settings", words, io, (l) => err.push(l))
  return { code, err: err.join("\n"), out: out.join("\n") }
}

// The login scope's stored values, none before its first write.
const stored = (data: string): Record<string, unknown> => {
  const path = join(scopeDir(data, "made-up-me"), "settings.json")
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
}

// A data folder and ops-wa's folder in it, the setting-set io over them, each line told to the owner, and a clock a test moves.
const owned = (data = join(scratch, `data-${n++}`)) => {
  const dir = join(data, "whatsapp")
  const told: string[] = []
  const logged: string[] = []
  let now = START
  let questions = 0
  const io: SettingSetIo = {
    apply: (key: string, value: string, id: string, proposed?: boolean) =>
      applyOwnerSetting(data, key, value, id, proposed),
    dir,
    log: (line: string) => void logged.push(line),
    now: () => now,
    // a question to the owner, given the id WhatsApp gives the message it sent: q1, q2 and on
    question: async (line: string) => (told.push(line), `q${++questions}`),
    tell: async (line: string) => void told.push(line),
  }
  return { advance: (ms: number) => (now += ms), data, dir, io, logged, run: cli(data), told }
}

describe("the kept record", () => {
  test("keeps a hash of each word of every owner text, in an owner-only file, never the text", async () => {
    const o = owned()
    expect(await keepMessage(o.dir, "own1", "Set the theme to dark, please.", START, OWNER)).toBe(
      false,
    )
    const raw = readFileSync(keptFile(o.dir), "utf8")
    expect(raw).not.toContain("dark")
    expect(raw).not.toContain("theme")
    const { kept } = JSON.parse(raw) as { kept: { id: string; words: string[] }[] }
    expect(kept[0]!.id).toBe("own1")
    expect(kept[0]!.words).toHaveLength(6)
    expect(statSync(keptFile(o.dir)).mode & 0o777).toBe(0o600)
  })

  test("a value matches the message's words in a row, past case, quotes and stops", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", 'Reply policy: "Factory status only." thanks', START, OWNER)
    const { kept } = (await Bun.file(keptFile(o.dir)).json()) as { kept: { words: string[] }[] }
    const key = (await wordKey(o.dir))!
    expect(holds(kept[0]!.words, "factory status only", key)).toBe(true)
    expect(holds(kept[0]!.words, "status", key)).toBe(true)
    expect(holds(kept[0]!.words, "factory only", key)).toBe(false)
    expect(holds(kept[0]!.words, "  ", key)).toBe(false)
  })

  test("the word hashes are keyed by ops-wa's own random key, an owner-only file, so a plain sha256 word list matches none", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "set the reply policy to factory status", START, OWNER)
    const key = await wordKey(o.dir)
    expect(key).toHaveLength(32)
    expect(statSync(wordKeyFile(o.dir)).mode & 0o777).toBe(0o600)
    const { kept } = (await Bun.file(keptFile(o.dir)).json()) as { kept: { words: string[] }[] }
    const plain = ["set", "the", "reply", "policy", "to", "factory", "status"].map((word) =>
      createHash("sha256").update(word).digest("hex").slice(0, 16),
    )
    expect(kept[0]!.words.filter((hash) => plain.includes(hash))).toEqual([])
    expect(wordHashes("factory status", key!)).not.toEqual(
      wordHashes("factory status", Buffer.alloc(32, 7)),
    )
    expect(wordHashes("factory status", key!)).toEqual(kept[0]!.words.slice(-2))
  })

  test("a missing or unreadable key applies no setting", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "point the repo at made-up-me/new", START, OWNER)
    rmSync(wordKeyFile(o.dir))
    await expect(settingSet(o.io, "own1", "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no word key",
    )
    writeFileSync(wordKeyFile(o.dir), "short", { mode: 0o600 })
    await expect(settingSet(o.io, "own1", "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no word key",
    )
    expect(stored(o.data)["factory.repo"]).toBeUndefined()
    expect(o.told).toEqual([])
  })
})

describe("settings set from the owner's message", () => {
  test("an owner id whose message holds the value applies it, logs the id and old value, and tells the undo", async () => {
    const o = owned()
    await o.run(["set", "factory.repo", "made-up-me/old", "--reason", "made-up start"])
    await keepMessage(o.dir, "own1", "point the repo at made-up-me/new", START, OWNER)
    const said = await settingSet(o.io, "own1", "factory.repo", "made-up-me/new")
    expect(said).toContain("set factory.repo from the owner's message own1")
    expect(stored(o.data)["factory.repo"]).toBe("made-up-me/new")
    expect(o.logged).toEqual([
      "ops-wa: factory.repo set from the owner's message own1; it was made-up-me/old",
    ])
    expect(o.told).toHaveLength(1)
    expect(o.told[0]).toContain("to undo: playground settings set factory.repo")
  })

  test.each(["wa.owner", "wa.device"])(
    "%s, the number that proves the owner or the one ops-wa links as, refuses, so no message changes it",
    async (key) => {
      const o = owned()
      await keepMessage(o.dir, "own1", "my number is now +15550100999", START, OWNER)
      await expect(settingSet(o.io, "own1", key, "+15550100999")).rejects.toThrow(
        `set ${key} on this Mac`,
      )
      expect(stored(o.data)[key]).toBeUndefined()
      expect(o.told).toEqual([])
    },
  )

  test("a value the message does not hold refuses, and nothing is set", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "point the repo at made-up-me/new", START, OWNER)
    await expect(settingSet(o.io, "own1", "factory.repo", "made-up-me/old")).rejects.toThrow(
      "does not hold the value",
    )
    expect(o.told).toEqual([])
  })

  test("an unknown id and one older than 24 hours refuse", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "point the repo at made-up-me/new", START, OWNER)
    await expect(settingSet(o.io, "own9", "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no message of the owner's",
    )
    o.advance(25 * HOUR)
    await expect(settingSet(o.io, "own1", "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no message of the owner's",
    )
    expect(o.told).toEqual([])
  })

  test("the undo line restores the old value, and a reset when there was none", async () => {
    const o = owned()
    await o.run(["set", "factory.repo", "made-up-me/old", "--reason", "made-up start"])
    await keepMessage(o.dir, "own1", "repo made-up-me/new and the db made-up-db", START, OWNER)
    const words = (said: string) =>
      [...said.split("to undo: ")[1]!.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!)
    const undo = words(await settingSet(o.io, "own1", "factory.repo", "made-up-me/new"))
    expect(undo.slice(0, 2)).toEqual(["playground", "settings"])
    expect((await o.run(undo.slice(2))).code).toBe(0)
    expect(stored(o.data)["factory.repo"]).toBe("made-up-me/old")
    const reset = words(await settingSet(o.io, "own1", "live.container", "made-up-db"))
    expect(reset.slice(0, 4)).toEqual(["playground", "settings", "reset", "live.container"])
    expect(stored(o.data)["live.container"]).toBe("made-up-db")
    expect((await o.run(reset.slice(2))).code).toBe(0)
    expect(stored(o.data)).not.toHaveProperty("live.container")
  })

  test("a guarded key asks the owner yes or no, and applies on a yes within 10 minutes", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "reply policy: factory status only", START, OWNER)
    expect(guarded("wa.replyPolicy")).toBe(true)
    expect(guarded("jobs.ops-wa")).toBe(true)
    expect(guarded("factory.repo")).toBe(false)
    const said = await settingSet(o.io, "own1", "wa.replyPolicy", "factory status only")
    expect(said).toContain("asked the owner on WhatsApp to confirm")
    expect(o.told).toEqual(["set wa.replyPolicy to factory status only? yes or no"])
    expect(stored(o.data)["wa.replyPolicy"]).toBeUndefined()
    o.advance(CONFIRM_MS - 1)
    expect(await confirm(o.io, " Yes ")).toBe(true)
    expect(stored(o.data)["wa.replyPolicy"]).toBe("factory status only")
    expect(o.told[1]).toContain("to undo: playground settings reset wa.replyPolicy")
    expect(await confirm(o.io, "yes")).toBe(false)
  })

  test.each(["yes", "Y", "yes do it", "1", "YES."])("%s applies the waiting key", async (yes) => {
    const o = owned()
    await keepMessage(o.dir, "own1", "guest policy: status only", START, OWNER)
    await settingSet(o.io, "own1", "wa.guestPolicy", "status only")
    expect(await confirm(o.io, yes)).toBe(true)
    expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
  })

  test("a masked key's question shows its last 4 alone", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "second number +15550100123", START, OWNER)
    await settingSet(o.io, "own1", "wa.alert", "+15550100123")
    expect(o.told).toEqual(["set wa.alert to ••••0123? yes or no"])
  })

  test("a no drops it and says so, and any other reply drops it and goes on", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "reply policy: factory status only", START, OWNER)
    await settingSet(o.io, "own1", "wa.replyPolicy", "factory status only")
    expect(await confirm(o.io, "No")).toBe(true)
    expect(o.told[1]).toBe("left wa.replyPolicy as it was.")
    expect(await confirm(o.io, "yes")).toBe(false)
    await settingSet(o.io, "own1", "wa.replyPolicy", "factory status only")
    expect(await confirm(o.io, "what's the status?")).toBe(false)
    expect(await confirm(o.io, "yes")).toBe(false)
    expect(stored(o.data)["wa.replyPolicy"]).toBeUndefined()
  })

  test("a second guarded ask tells the owner the first no longer waits, and the yes applies the second alone", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "reply policy: factory status only", START, OWNER)
    await keepMessage(o.dir, "own2", "guest policy: status only", START, OWNER)
    await settingSet(o.io, "own1", "wa.replyPolicy", "factory status only")
    const said = await settingSet(o.io, "own2", "wa.guestPolicy", "status only")
    expect(said).toContain(`within ${CONFIRM_MS / 60_000} minutes`)
    expect(o.told).toEqual([
      "set wa.replyPolicy to factory status only? yes or no",
      "the question on wa.replyPolicy no longer waits.",
      "set wa.guestPolicy to status only? yes or no",
    ])
    expect(await confirm(o.io, "yes")).toBe(true)
    expect(stored(o.data)["wa.replyPolicy"]).toBeUndefined()
    expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
  })

  test("silence past 10 minutes drops it, so a late yes applies nothing", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "reply policy: factory status only", START, OWNER)
    await settingSet(o.io, "own1", "wa.replyPolicy", "factory status only")
    o.advance(CONFIRM_MS)
    expect(await confirm(o.io, "yes")).toBe(false)
    expect(stored(o.data)["wa.replyPolicy"]).toBeUndefined()
  })
})

describe("settings set --propose, a session's proposal", () => {
  test("asks the owner the key and its whole value, sets nothing yet, and his yes sets exactly that value with the question's id as its reason", async () => {
    const o = owned()
    const said = await settingPropose(o.io, "wa.replyPolicy", "factory status only")
    expect(said).toContain("asked the owner on WhatsApp to confirm wa.replyPolicy")
    expect(o.told).toEqual(["set wa.replyPolicy to factory status only? Reply yes or no"])
    expect(stored(o.data)["wa.replyPolicy"]).toBeUndefined()
    expect(await confirm(o.io, "yes")).toBe(true)
    expect(stored(o.data)["wa.replyPolicy"]).toBe("factory status only")
    expect(o.logged).toEqual([
      "ops-wa: wa.replyPolicy set on the owner's yes to the question q1; it was unset",
    ])
    expect(o.told[1]).toBe(
      "set wa.replyPolicy on your yes. to undo: playground settings reset wa.replyPolicy --reason 'undo of the owner'\\''s WhatsApp yes to the question q1'",
    )
    expect((await o.run(["why", "wa.replyPolicy"])).out).toContain(
      "the owner's WhatsApp yes to the question q1 confirmed it",
    )
  })

  test("a masked key is refused, naming the Inbox secret ask, and the owner is asked nothing", async () => {
    const o = owned()
    await expect(settingPropose(o.io, "wa.alert", "+15550100123")).rejects.toThrow(
      "ask for it with an Inbox secret ask",
    )
    expect(o.told).toEqual([])
    expect(existsSync(join(o.dir, "confirm.json"))).toBe(false)
  })

  test.each(["wa.owner", "wa.device"])(
    "%s is refused, and the owner is asked nothing",
    async (key) => {
      const o = owned()
      await expect(settingPropose(o.io, key, "+15550100999")).rejects.toThrow(
        `set ${key} on this Mac`,
      )
      expect(o.told).toEqual([])
    },
  )

  test("a key no guard reads, or a value its schema refuses, is refused before the owner is asked", async () => {
    const o = owned()
    await expect(settingPropose(o.io, "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no key a guard reads",
    )
    await expect(settingPropose(o.io, "glm.readOnlyLoad5", "many")).rejects.toThrow(
      "glm.readOnlyLoad5",
    )
    expect(o.told).toEqual([])
  })

  test("a second proposal is refused while one waits, naming the open one, and the yes applies the first alone", async () => {
    const o = owned()
    await settingPropose(o.io, "wa.replyPolicy", "factory status only")
    await expect(settingPropose(o.io, "wa.guestPolicy", "status only")).rejects.toThrow(
      "the question on wa.replyPolicy (a session's proposal) still waits",
    )
    expect(o.told).toEqual(["set wa.replyPolicy to factory status only? Reply yes or no"])
    expect(await confirm(o.io, "yes")).toBe(true)
    expect(stored(o.data)["wa.replyPolicy"]).toBe("factory status only")
    expect(stored(o.data)["wa.guestPolicy"]).toBeUndefined()
  })

  test("a no sets nothing and clears it, so a later yes sets nothing and a new proposal goes out", async () => {
    const o = owned()
    await settingPropose(o.io, "wa.replyPolicy", "factory status only")
    expect(await confirm(o.io, "no")).toBe(true)
    expect(o.told[1]).toBe("left wa.replyPolicy as it was.")
    expect(await confirm(o.io, "yes")).toBe(false)
    expect(stored(o.data)).toEqual({})
    await settingPropose(o.io, "wa.guestPolicy", "status only")
    expect(o.told[2]).toBe("set wa.guestPolicy to status only? Reply yes or no")
  })

  test("a yes after 10 minutes sets nothing, and the proposal no longer blocks a new one", async () => {
    const o = owned()
    await settingPropose(o.io, "wa.replyPolicy", "factory status only")
    o.advance(CONFIRM_MS)
    expect(await confirm(o.io, "yes")).toBe(false)
    expect(stored(o.data)).toEqual({})
    await settingPropose(o.io, "wa.guestPolicy", "status only")
    expect(o.told).toHaveLength(2)
  })

  test("two proposals that land together cannot both pass the one-open check", async () => {
    const o = owned()
    const both = await Promise.allSettled([
      settingPropose(o.io, "wa.replyPolicy", "factory status only"),
      settingPropose(o.io, "wa.guestPolicy", "status only"),
    ])
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(o.told).toEqual(["set wa.replyPolicy to factory status only? Reply yes or no"])
  })

  test("while either kind of confirm waits the other is refused, naming the open one, and the yes applies only the one its question named", async () => {
    const o = owned()
    await keepMessage(o.dir, "own1", "guest policy: status only", START, OWNER)
    await settingPropose(o.io, "wa.replyPolicy", "factory status only")
    await expect(settingSet(o.io, "own1", "wa.guestPolicy", "status only")).rejects.toThrow(
      "the question on wa.replyPolicy (a session's proposal) still waits",
    )
    expect(await confirm(o.io, "yes")).toBe(true)
    expect(stored(o.data)).toEqual({ "wa.replyPolicy": "factory status only" })

    const p = owned()
    await keepMessage(p.dir, "own1", "guest policy: status only", START, OWNER)
    await settingSet(p.io, "own1", "wa.guestPolicy", "status only")
    await expect(settingPropose(p.io, "wa.replyPolicy", "factory status only")).rejects.toThrow(
      "the question on wa.guestPolicy (the owner's own message) still waits",
    )
    expect(p.told).toEqual(["set wa.guestPolicy to status only? yes or no"])
    expect(await confirm(p.io, "yes")).toBe(true)
    expect(stored(p.data)).toEqual({ "wa.guestPolicy": "status only" })
  })
})

describe("ops-wa's bridge keeps a message and takes a confirm from the owner alone", () => {
  const watched = (o: ReturnType<typeof owned>, inbox?: Inbox) => {
    const fake = fakeSocket()
    fake.setClock(() => o.io.now())
    const relayed: string[] = []
    const replied: string[] = []
    const w = bridge({
      alert: async () => ALERT,
      assistant: async () => undefined,
      busy: async () => false,
      confirm: (text, reaction) => confirm(o.io, text, reaction),
      dir: o.dir,
      inbox,
      log: () => {},
      now: o.io.now,
      on: async () => true,
      owner: OWNER,
      relay: async (_: string, text: string) => void relayed.push(text),
      reply: async (line: string) => (replied.push(line), "sent"),
      sleep: async () => {},
      stuck: async () => null,
    })
    w.attach(fake.sock)
    return { fake, relayed, replied, settle: w.idle }
  }

  test("the owner's line names its id and the settings set, and the owner's yes applies the guarded key", async () => {
    const o = owned()
    const h = watched(o)
    h.fake.upsert([h.fake.message(jid(OWNER), "guest policy: status only", { id: "own1" })])
    await h.settle()
    expect(h.relayed[0]).toContain("--from-owner-msg own1")
    await settingSet(o.io, "own1", "wa.guestPolicy", "status only")
    h.fake.upsert([h.fake.message(jid(OWNER), "yes", { id: "own2" })])
    await h.settle()
    expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
    expect(h.relayed).toHaveLength(1)
  })

  // An Inbox whose one open card, #i12, went out to the owner with two rows, so a bare number goes to it.
  const cardWaits = (o: ReturnType<typeof owned>, answers: unknown[] = []): Inbox => {
    mkdirSync(o.dir, { recursive: true })
    writeFileSync(
      join(o.dir, "cards.json"),
      JSON.stringify({
        sent: {
          "12": {
            at: START,
            id: "id-12",
            rows: [
              { go: true, label: "Merge it" },
              { go: false, label: "Hold it" },
            ],
          },
        },
      }),
    )
    const card = { id: "id-12", ref: 12, status: "open" } as Card
    return {
      answer: async (id, answer) => void answers.push([id, answer]),
      open: async () => [card],
      terms: async () => undefined,
    }
  }
  const asked = async (o: ReturnType<typeof owned>, h: ReturnType<typeof watched>) => {
    h.fake.upsert([h.fake.message(jid(OWNER), "guest policy: status only", { id: "own1" })])
    await h.settle()
    await settingSet(o.io, "own1", "wa.guestPolicy", "status only")
  }

  test("a bare 1 while a card waits on its rows goes to the card, which asks for its id, and the setting still waits for a yes", async () => {
    const o = owned()
    const answers: unknown[] = []
    const h = watched(o, cardWaits(o, answers))
    await asked(o, h)
    h.fake.upsert([h.fake.message(jid(OWNER), "1", { id: "own2" })])
    await h.settle()
    expect(h.replied).toEqual([NO_ID])
    expect(answers).toEqual([])
    expect(h.relayed).toHaveLength(1)
    expect(stored(o.data)["wa.guestPolicy"]).toBeUndefined()
    h.fake.upsert([h.fake.message(jid(OWNER), "yes", { id: "own3" })])
    await h.settle()
    expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
  })

  test.each(["yes", "y", "yes do it"])(
    "%s applies the waiting setting while a card waits",
    async (yes) => {
      const o = owned()
      const h = watched(o, cardWaits(o))
      await asked(o, h)
      h.fake.upsert([h.fake.message(jid(OWNER), yes, { id: "own2" })])
      await h.settle()
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
    },
  )

  test("a bare 1 while no card waits applies the waiting setting", async () => {
    const o = owned()
    const h = watched(o, {
      answer: async () => undefined,
      open: async () => [],
      terms: async () => undefined,
    })
    await asked(o, h)
    h.fake.upsert([h.fake.message(jid(OWNER), "1", { id: "own2" })])
    await h.settle()
    expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
  })

  test("a photo or voice note from the owner drops the waiting setting", async () => {
    const o = owned()
    const h = watched(o)
    await asked(o, h)
    h.fake.upsert([
      {
        ...h.fake.message(jid(OWNER), "", { id: "own2" }),
        message: { imageMessage: { mimetype: "image/jpeg" } },
      },
    ])
    await h.settle()
    h.fake.upsert([h.fake.message(jid(OWNER), "yes", { id: "own3" })])
    await h.settle()
    expect(stored(o.data)["wa.guestPolicy"]).toBeUndefined()
  })

  test("a reaction from the owner, a 👍 meant as yes included, sets nothing, tells the owner to reply yes, and the setting still waits", async () => {
    const o = owned()
    const h = watched(o)
    await asked(o, h)
    const reactionMessage = {
      key: { fromMe: true, id: "ours1", remoteJid: jid(OWNER) },
      text: "👍",
    }
    h.fake.upsert([
      { ...h.fake.message(jid(OWNER), "", { id: "own2" }), message: { reactionMessage } },
    ])
    await h.settle()
    expect(stored(o.data)["wa.guestPolicy"]).toBeUndefined()
    expect(o.told.at(-1)).toBe("not set: reply yes to set wa.guestPolicy")
    h.fake.upsert([h.fake.message(jid(OWNER), "yes", { id: "own3" })])
    await h.settle()
    expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
  })

  test("a value the owner's message only quotes is not held, so its id refuses", async () => {
    const o = owned()
    const h = watched(o)
    const extendedTextMessage = {
      contextInfo: { quotedMessage: { conversation: "status only" }, stanzaId: "m1" },
      text: "set the guest policy to this",
    }
    h.fake.upsert([
      { ...h.fake.message(jid(OWNER), "", { id: "own1" }), message: { extendedTextMessage } },
    ])
    await h.settle()
    expect(h.relayed[0]).toContain("It answers the message that reads: status only")
    await expect(settingSet(o.io, "own1", "wa.guestPolicy", "status only")).rejects.toThrow()
    expect(stored(o.data)["wa.guestPolicy"]).toBeUndefined()
  })

  test("a yes from the second number or a stranger applies nothing", async () => {
    const o = owned()
    const h = watched(o)
    h.fake.upsert([h.fake.message(jid(OWNER), "guest policy: status only", { id: "own1" })])
    await h.settle()
    await settingSet(o.io, "own1", "wa.guestPolicy", "status only")
    h.fake.upsert([
      h.fake.message(jid(ALERT), "yes", { id: "guest1" }),
      h.fake.message(jid(STRANGER), "yes", { id: "stranger1" }),
    ])
    await h.settle()
    expect(stored(o.data)).toEqual({})
  })

  test("a guest's or a stranger's message is never kept, so its id refuses", async () => {
    const o = owned()
    const h = watched(o)
    h.fake.upsert([
      h.fake.message(jid(ALERT), "repo made-up-me/new", { id: "guest1" }),
      h.fake.message(jid(STRANGER), "repo made-up-me/new", { id: "stranger1" }),
    ])
    await h.settle()
    await expect(settingSet(o.io, "guest1", "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no message of the owner's",
    )
    await expect(settingSet(o.io, "stranger1", "factory.repo", "made-up-me/new")).rejects.toThrow(
      "no message of the owner's",
    )
  })

  describe("a session's proposal", () => {
    test("the CLI proposes through ops-wa's socket, writing nothing, and the owner's yes from his number sets the key and sends the undo", async () => {
      const data = mkdtempSync("/tmp/wa-propose-")
      short.push(data)
      const o = owned(data)
      mkdirSync(o.dir, { recursive: true })
      const server = serve(
        socketPath(data),
        async () => "sent",
        undefined,
        undefined,
        undefined,
        (key, value) => settingPropose(o.io, key, value),
      )
      try {
        const r = await o.run(["set", "wa.guestPolicy", "status only", "--propose"])
        expect(r.err).toBe("")
        expect(r.out).toContain("asked the owner on WhatsApp to confirm wa.guestPolicy")
      } finally {
        server.stop(true)
      }
      expect(o.told).toEqual(["set wa.guestPolicy to status only? Reply yes or no"])
      expect(stored(data)).toEqual({})
      const h = watched(o)
      h.fake.upsert([h.fake.message(jid(OWNER), "yes", { id: "own1" })])
      await h.settle()
      expect(stored(data)["wa.guestPolicy"]).toBe("status only")
      expect(o.told.at(-1)).toContain("to undo: playground settings reset wa.guestPolicy")
      expect(h.relayed).toEqual([])
    })

    // The real sender and the bridge on one fake socket, so what counts as a new message in the owner's chat is what the sender sends: the owner writes first, which opens his chat and is the message a plain answer counts from.
    const chat = async (o: ReturnType<typeof owned>) => {
      const fake = fakeSocket()
      fake.setClock(() => o.io.now())
      const send = sender({
        alert: async () => ALERT,
        device: SPARE,
        dir: o.dir,
        now: o.io.now,
        owner: OWNER,
        random: () => 0.5,
        sleep: async (ms) => void o.advance(ms),
        sock: fake.sock,
      })
      o.io.question = (line: string) => send.card(line)
      o.io.tell = (line: string) => send.out(line, "reply").then((out) => out.ids)
      // the wiring cli.ts runs, so a dropped argument there fails here
      const settings = ownerSettings(o.io)
      const relayed: string[] = []
      const w = bridge({
        alert: async () => ALERT,
        assistant: async () => undefined,
        busy: async () => false,
        confirm: settings.confirm,
        dir: o.dir,
        log: () => {},
        now: o.io.now,
        on: async () => true,
        owner: OWNER,
        relay: async (_: string, text: string) => void relayed.push(text),
        reply: async () => "sent",
        sleep: async () => {},
        stuck: async () => null,
      })
      w.attach(fake.sock)
      let n = 0
      // the owner's text, plain or quoting a message by its id
      const says = async (text: string, quoting?: string) => {
        const id = `own${++n}`
        fake.upsert([
          quoting
            ? {
                ...fake.message(jid(OWNER), "", { id }),
                message: { extendedTextMessage: { contextInfo: { stanzaId: quoting }, text } },
              }
            : fake.message(jid(OWNER), text, { id }),
        ])
        await w.idle()
      }
      // the owner's reaction on a message by its id, or with no emoji, a reaction taken back
      const reacts = async (on: string, emoji: string) => {
        fake.upsert([
          {
            ...fake.message(jid(OWNER), "", { id: `own${++n}` }),
            message: {
              reactionMessage: {
                key: { fromMe: true, id: on, remoteJid: jid(OWNER) },
                text: emoji,
              },
            },
          },
        ])
        await w.idle()
      }
      await says("hi")
      const question = async () => {
        await settings.propose("wa.guestPolicy", "status only")
        return `m${fake.sent.length}`
      }
      return { fake, question, reacts, relayed, says, send }
    }
    const yesReached = (relayed: string[]) => relayed.some((line) => line.includes("reads: yes"))

    test("a yes quoting the question applies it, whatever was sent after it", async () => {
      const o = owned()
      const c = await chat(o)
      const asked = await c.question()
      await c.send("a made-up update", "reply")
      await c.says("yes", asked)
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
      expect(yesReached(c.relayed)).toBe(false)
    })

    test("a plain yes applies it while the question is the one message since the owner's last", async () => {
      const o = owned()
      const c = await chat(o)
      await c.question()
      await c.says("yes")
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
      expect(yesReached(c.relayed)).toBe(false)
    })

    test("a plain yes with another message sent since the owner's last sets nothing, reaches the dispatcher, and the proposal still waits", async () => {
      const o = owned()
      const c = await chat(o)
      await c.send("shall I go ahead?", "reply")
      const asked = await c.question()
      await c.says("yes")
      expect(stored(o.data)).toEqual({})
      expect(yesReached(c.relayed)).toBe(true)
      await c.says("yes", asked)
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
    })

    test("a yes quoting another message sets nothing and reaches the dispatcher", async () => {
      const o = owned()
      const c = await chat(o)
      await c.send("shall I go ahead?", "reply")
      const other = `m${c.fake.sent.length}`
      await c.question()
      await c.says("yes", other)
      expect(stored(o.data)).toEqual({})
      expect(yesReached(c.relayed)).toBe(true)
    })

    test("the live status edited after the question adds no message, so a plain yes still applies it", async () => {
      const o = owned()
      const c = await chat(o)
      await c.send.out("3 PRs in review", "reply", undefined, { status: true })
      await c.says("ok")
      await c.question()
      expect(
        await c.send.out("2 PRs in review", "reply", undefined, { status: true }),
      ).toMatchObject({
        said: "edited the live status",
      })
      await c.says("yes")
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
    })

    test("a new status message after the question makes a plain yes go on to the dispatcher", async () => {
      const o = owned()
      const c = await chat(o)
      await c.question()
      expect(
        await c.send.out("3 PRs in review", "reply", undefined, { status: true }),
      ).toMatchObject({
        said: "sent",
      })
      const live = (await Bun.file(join(o.dir, "status.json")).json()) as { id: string }
      expect(live.id).toBe(`m${c.fake.sent.length}`)
      await c.says("yes")
      expect(stored(o.data)).toEqual({})
      expect(yesReached(c.relayed)).toBe(true)
    })

    test("a 👍 on the question gets the reply-yes line, and the plain yes that line asks for applies it", async () => {
      const o = owned()
      const c = await chat(o)
      const asked = await c.question()
      const before = c.fake.sent.length
      await c.reacts(asked, "👍")
      expect(c.fake.sent.length).toBe(before + 1)
      await c.says("yes")
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
      expect(yesReached(c.relayed)).toBe(false)
    })

    test("a yes quoting the reply-yes line a 👍 got applies it, since that line is the proposal's own", async () => {
      const o = owned()
      const c = await chat(o)
      const asked = await c.question()
      await c.reacts(asked, "👍")
      const line = `m${c.fake.sent.length}`
      await c.send("shall I go ahead?", "reply")
      await c.says("yes", line)
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
      expect(yesReached(c.relayed)).toBe(false)
    })

    test("a reaction taken back after another send leaves that send counted, so a plain yes goes on to the dispatcher", async () => {
      const o = owned()
      const c = await chat(o)
      const asked = await c.question()
      await c.send("shall I go ahead?", "reply")
      await c.reacts(asked, "")
      await c.says("yes")
      expect(stored(o.data)).toEqual({})
      expect(yesReached(c.relayed)).toBe(true)
      await c.says("yes", asked)
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
    })

    test("a text held in quiet hours is no new message until its catch-up goes out", async () => {
      const o = owned()
      mkdirSync(o.dir, { recursive: true })
      writeFileSync(
        join(o.dir, "owner.json"),
        JSON.stringify({ jid: jid(OWNER), ownerAt: START - 2 * HOUR }),
        { mode: 0o600 },
      )
      const fake = fakeSocket()
      fake.setClock(() => o.io.now())
      const send = sender({
        alert: async () => ALERT,
        device: SPARE,
        dir: o.dir,
        now: o.io.now,
        owner: OWNER,
        quiet: async () => ({ end: 23, start: 0, zone: "UTC" }),
        random: () => 0.5,
        sleep: async (ms) => void o.advance(ms),
        sock: fake.sock,
      })
      const sentNow = () =>
        existsSync(join(o.dir, "sent.json"))
          ? (JSON.parse(readFileSync(join(o.dir, "sent.json"), "utf8")) as { messages: unknown[] })
              .messages
          : []
      expect(await send("a made-up update", "reply")).toContain("held for quiet hours")
      expect(fake.sent).toEqual([])
      expect(sentNow()).toEqual([])
      writeFileSync(
        join(o.dir, "owner.json"),
        JSON.stringify({ jid: jid(OWNER), ownerAt: o.io.now() }),
        { mode: 0o600 },
      )
      await send.catchUp()
      expect(fake.sent).toHaveLength(1)
      expect(sentNow()).toEqual([{ at: fake.sent[0]!.at, id: "m1" }])
    })

    test("a proposal in quiet hours is refused, since its question would be held, and nothing waits", async () => {
      const o = owned()
      mkdirSync(o.dir, { recursive: true })
      writeFileSync(
        join(o.dir, "owner.json"),
        JSON.stringify({ jid: jid(OWNER), ownerAt: START - 2 * HOUR }),
        { mode: 0o600 },
      )
      const fake = fakeSocket()
      fake.setClock(() => o.io.now())
      const send = sender({
        alert: async () => ALERT,
        device: SPARE,
        dir: o.dir,
        now: o.io.now,
        owner: OWNER,
        quiet: async () => ({ end: 23, start: 0, zone: "UTC" }),
        random: () => 0.5,
        sleep: async (ms) => void o.advance(ms),
        sock: fake.sock,
      })
      o.io.question = (line: string) => send.card(line)
      await expect(settingPropose(o.io, "wa.guestPolicy", "status only")).rejects.toThrow(
        "quiet hours",
      )
      expect(fake.sent).toEqual([])
      expect(existsSync(join(o.dir, "confirm.json"))).toBe(false)
    })

    test("a yes from the second number or a stranger sets nothing, and the proposal still waits for the owner's", async () => {
      const o = owned()
      const h = watched(o)
      await settingPropose(o.io, "wa.guestPolicy", "status only")
      h.fake.upsert([
        h.fake.message(jid(ALERT), "yes", { id: "guest1" }),
        h.fake.message(jid(STRANGER), "yes", { id: "stranger1" }),
      ])
      await h.settle()
      expect(stored(o.data)).toEqual({})
      h.fake.upsert([h.fake.message(jid(OWNER), "yes", { id: "own1" })])
      await h.settle()
      expect(stored(o.data)["wa.guestPolicy"]).toBe("status only")
    })
  })
})

describe("playground settings set --from-owner-msg", () => {
  test("only asks ops-wa, so with ops-wa down it refuses and writes nothing", async () => {
    const o = owned()
    const r = await o.run(["set", "wa.alert", "+15550100444", "--from-owner-msg", "own1"])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("ops-wa is not running")
    expect(stored(o.data)).toEqual({})
  })

  test("takes no --scope, --by or --reason", async () => {
    const o = owned()
    const r = await o.run([
      "set",
      "factory.repo",
      "a/b",
      "--from-owner-msg",
      "own1",
      "--scope",
      "x",
    ])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--from-owner-msg takes no --scope")
  })
})

describe("playground settings set --propose", () => {
  test("only asks ops-wa, so with ops-wa down it refuses and writes nothing", async () => {
    const o = owned()
    const r = await o.run(["set", "wa.guestPolicy", "status only", "--propose"])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("ops-wa is not running")
    expect(stored(o.data)).toEqual({})
  })

  test.each([
    ["--reason", "x"],
    ["--scope", "x"],
    ["--by", "x"],
    ["--from-owner-msg", "own1"],
  ])("takes no %s", async (flag, value) => {
    const o = owned()
    const r = await o.run(["set", "wa.guestPolicy", "status only", "--propose", flag, value])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--propose takes no")
    expect(stored(o.data)).toEqual({})
  })
})
