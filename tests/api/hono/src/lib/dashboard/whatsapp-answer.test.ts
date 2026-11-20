import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SQL } from "bun"

import type { Deliver } from "../../../../../../api/hono/src/lib/dashboard/inbox"
import {
  answersDir,
  whatsappAnswer,
} from "../../../../../../api/hono/src/lib/dashboard/whatsapp-answer"
import { testContainerName } from "../../../../../container"

type Database = Parameters<typeof whatsappAnswer>[0]

const ID = "00000000-0000-4000-8000-000000000012"

// A scratch data folder with ops-wa's answers folder, and an answer file in it, mode 600 unless the test says otherwise.
const scratch = () => {
  const data = mkdtempSync(join(tmpdir(), "wa-answer-"))
  mkdirSync(answersDir(data), { mode: 0o700, recursive: true })
  const write = (body: object, name = "a.json", mode = 0o600, dir = answersDir(data)) => {
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(body))
    chmodSync(path, mode)
    return path
  }
  return { data, write }
}

// the file checks refuse before the database is read, so these need none
const NO_DB = {} as Database

describe("ask whatsapp takes ops-wa's own file alone", () => {
  test("a file outside ops-wa's answers folder answers nothing", async () => {
    const { data, write } = scratch()
    const elsewhere = mkdtempSync(join(tmpdir(), "wa-elsewhere-"))
    const path = write({ action: "approve", id: ID }, "a.json", 0o600, elsewhere)
    const result = await whatsappAnswer(NO_DB, path, { data })
    expect(result).toMatchObject({ ok: false })
    expect(existsSync(path)).toBe(true)
  })

  test("a link in the answers folder to a file outside it answers nothing", async () => {
    const { data, write } = scratch()
    const outside = write(
      { action: "approve", id: ID },
      "x.json",
      0o600,
      mkdtempSync(join(tmpdir(), "wa-out-")),
    )
    const link = join(answersDir(data), "link.json")
    symlinkSync(outside, link)
    expect(await whatsappAnswer(NO_DB, link, { data })).toMatchObject({ ok: false })
  })

  test("a file others can read answers nothing", async () => {
    const { data, write } = scratch()
    const path = write({ action: "approve", id: ID }, "a.json", 0o644)
    expect(await whatsappAnswer(NO_DB, path, { data })).toEqual({
      message: "the answer file is not ops-wa's own: a regular file, mode 600, this user's",
      ok: false,
    })
  })

  test("a file of another user's answers nothing", async () => {
    const { data, write } = scratch()
    const path = write({ action: "approve", id: ID })
    expect(await whatsappAnswer(NO_DB, path, { data, uid: 4242 })).toMatchObject({ ok: false })
  })

  test("a file that is no answer is deleted and answers nothing", async () => {
    const { data, write } = scratch()
    const path = write({ action: "discard", id: ID })
    expect(await whatsappAnswer(NO_DB, path, { data })).toEqual({
      message: "the answer file is not an answer ops-wa writes",
      ok: false,
    })
    expect(existsSync(path)).toBe(false)
  })
})

const PASSWORD = crypto.randomUUID()
const MIGRATIONS = join(import.meta.dir, "../../../../../../packages/db/drizzle")
const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

describe.skipIf(!dockerUp())("an answer from WhatsApp, on the inbox store", () => {
  let container = ""
  let store: typeof import("../../../../../../api/hono/src/lib/dashboard/inbox")
  let db: Database

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("wa-answer"),
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18-alpine",
    ])
      .stdout.toString()
      .trim()
    const port = Bun.spawnSync(["docker", "port", container, "5432/tcp"])
      .stdout.toString()
      .trim()
      .split(":")
      .at(-1)
    const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`
    let admin: SQL | null = null
    for (let i = 0; i < 240; i++) {
      try {
        admin = new SQL(url, { max: 1 })
        await admin`select 1`
        break
      } catch {
        await Bun.sleep(500)
      }
    }
    const journal = await Bun.file(join(MIGRATIONS, "meta/_journal.json")).json()
    for (const { tag } of journal.entries as { tag: string }[])
      for (const statement of (await Bun.file(join(MIGRATIONS, `${tag}.sql`)).text()).split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await admin!.unsafe(statement)
    await admin!.close()
    store = await import("../../../../../../api/hono/src/lib/dashboard/inbox")
    db = (await import("../../../../../../packages/db/dist/index.mjs")).createDatabase(
      url,
    ) as Database
  }, 180_000)

  afterAll(() => {
    if (container)
      Bun.spawnSync(["docker", "rm", "-f", "-v", container], { stderr: "ignore", stdout: "ignore" })
  })

  const post = async (preview: object, kind?: "draft") => {
    const posted = await store.postItem(db, {
      from: "builder",
      ...(kind && { kind }),
      preview,
      title: "Merge tonight?",
    })
    if (!posted.ok) throw new Error(posted.message)
    return posted.item
  }
  const DRAFT = {
    link: "https://linear.app/acme/issue/MADEDUNE-2186/x",
    text: "on it, a fix lands tonight",
    to: "a colleague's thread",
  }
  // a delivery adapter that records what it would type and to whom
  const typed: { text: string; to: string }[] = []
  const deliver: Deliver = async ({ text, to }) => {
    typed.push({ text, to })
    return { at: new Date().toISOString(), ok: true, sessionId: "s-1" }
  }

  test("answers the ask through the Inbox's route, types it into its poster and records it as from WhatsApp, once", async () => {
    const item = await post({
      approve: "Merge it",
      deny: "Hold it",
      scope: "factory",
      text: "Merge the fix?",
      type: "ask",
    })
    const { data, write } = scratch()
    const path = write({ action: "approve", id: item.id })
    expect(await whatsappAnswer(db, path, { data, deliver })).toEqual({
      line: `answered #i${item.ref} from WhatsApp`,
      ok: true,
    })
    const read = await store.getItem(db, item.id)
    expect(read?.status).toBe("approved")
    expect(read?.answer).toMatchObject({ choice: "approve", via: "whatsapp" })
    expect(typed.at(-1)?.to).toBe("builder")
    expect(existsSync(path)).toBe(false)
    expect(await whatsappAnswer(db, path, { data, deliver })).toMatchObject({ ok: false })
  })

  test("a deny denies it", async () => {
    const item = await post({ scope: "factory", text: "Merge the fix?", type: "ask" })
    const { data, write } = scratch()
    await whatsappAnswer(db, write({ action: "deny", id: item.id }), { data, deliver })
    expect((await store.getItem(db, item.id))?.status).toBe("denied")
  })

  test.each([
    ["a delete", { type: "delete", what: "/tmp/made-up", why: "old" }],
    ["a budget", { amount: "$5", type: "budget", why: "a run" }],
    ["a schema", { shape: "a table", type: "schema" }],
    ["an unscoped ask", { text: "Merge the fix?", type: "ask" }],
    ["an org-scoped ask", { scope: "zyx-org", text: "Merge the fix?", type: "ask" }],
  ])("%s decision takes no answer from WhatsApp, whatever the file says", async (_, preview) => {
    const item = await post(preview)
    const { data, write } = scratch()
    expect(
      await whatsappAnswer(db, write({ action: "approve", id: item.id }), { data, deliver }),
    ).toEqual({
      message: "only a factory-scoped ask decision with one question takes an answer from WhatsApp",
      ok: false,
    })
    expect((await store.getItem(db, item.id))?.status).toBe("open")
  })

  // PG-2873: an org-scoped draft reaches the owner's own WhatsApp, and a reply there sends it through the Inbox's own Send
  test("a draft's send from WhatsApp sends it as written, through the Inbox's route, once", async () => {
    const item = await post(DRAFT, "draft")
    const { data, write } = scratch()
    const path = write({ action: "send", id: item.id })
    expect(await whatsappAnswer(db, path, { data, deliver })).toEqual({
      line: `answered #i${item.ref} from WhatsApp`,
      ok: true,
    })
    const read = await store.getItem(db, item.id)
    expect(read?.status).toBe("sent")
    expect(read?.answer).toMatchObject({ choice: "send", via: "whatsapp" })
    expect(read?.answer).not.toHaveProperty("editedText")
    expect(typed.at(-1)?.to).toBe("builder")
  })

  test("a draft's send with the owner's words sends those in its place", async () => {
    const item = await post(DRAFT, "draft")
    const { data, write } = scratch()
    await whatsappAnswer(db, write({ action: "send", id: item.id, text: "done, thanks" }), {
      data,
      deliver,
    })
    expect((await store.getItem(db, item.id))?.answer).toMatchObject({
      choice: "send",
      editedText: "done, thanks",
    })
  })

  test("a draft already sent in the Inbox takes no second send from WhatsApp", async () => {
    const item = await post(DRAFT, "draft")
    await store.answerItem(db, item.id, { action: "send" }, { actor: { label: "Inbox" }, deliver })
    const { data, write } = scratch()
    expect(
      await whatsappAnswer(db, write({ action: "send", id: item.id }), { data, deliver }),
    ).toMatchObject({ ok: false })
  })

  test("a draft its poster changed after it went to WhatsApp takes no send naming the old words, and one naming the new", async () => {
    const item = await post(DRAFT, "draft")
    const edited = await store.editItem(db, item.id, {
      from: "builder",
      kind: "draft",
      preview: { ...DRAFT, text: "a fix lands tomorrow" },
      title: "Merge tonight?",
    })
    if (!edited.ok) throw new Error(edited.message)
    const { data, write } = scratch()
    expect(
      await whatsappAnswer(db, write({ action: "send", id: item.id, seen: item.updatedAt }), {
        data,
        deliver,
      }),
    ).toEqual({ message: "This item changed since you read it; read it again", ok: false })
    expect((await store.getItem(db, item.id))?.status).toBe("open")
    await whatsappAnswer(
      db,
      write({ action: "send", id: item.id, seen: edited.item.updatedAt }, "b.json"),
      {
        data,
        deliver,
      },
    )
    expect((await store.getItem(db, item.id))?.status).toBe("sent")
  })

  test("a send takes no decision, and an approve takes no draft", async () => {
    const decision = await post({ scope: "factory", text: "Merge the fix?", type: "ask" })
    const draft = await post(DRAFT, "draft")
    const { data, write } = scratch()
    expect(
      await whatsappAnswer(db, write({ action: "send", id: decision.id }), { data, deliver }),
    ).toEqual({ message: "only a draft is sent from WhatsApp", ok: false })
    expect(
      await whatsappAnswer(db, write({ action: "approve", id: draft.id }, "b.json"), {
        data,
        deliver,
      }),
    ).toMatchObject({ ok: false })
    expect((await store.getItem(db, decision.id))?.status).toBe("open")
    expect((await store.getItem(db, draft.id))?.status).toBe("open")
  })
})
