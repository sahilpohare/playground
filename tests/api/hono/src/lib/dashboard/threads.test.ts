import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SQL } from "bun"

import { attachmentsDir } from "../../../../../../api/hono/src/lib/dashboard/attachments"
import { ensureFixture } from "../../../../../../api/hono/src/lib/dashboard/fixture"
import { testContainerName } from "../../../../../container"

// The store against a throwaway Postgres in Docker published on 127.0.0.1 only, migrated as the dashboard's is, so the table's own rules hold. Skipped where Docker is not running.
const MIGRATIONS = join(import.meta.dir, "../../../../../../packages/db/drizzle")
// made at run time, so no password is ever written into the repo
const PASSWORD = crypto.randomUUID()
const SESSION = "11111111-1111-4111-8111-000000000001"

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

describe.skipIf(!dockerUp())("the thread store", () => {
  let container = ""
  let admin: SQL
  let store: typeof import("../../../../../../api/hono/src/lib/dashboard/threads")
  let db: ReturnType<typeof import("../../../../../../packages/db/dist/index.mjs").createDatabase>

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("threads"),
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
    for (let i = 0; i < 60; i++) {
      try {
        admin = new SQL(url, { max: 1 })
        await admin`select 1`
        break
      } catch {
        await Bun.sleep(500)
      }
    }
    const journal = await Bun.file(join(MIGRATIONS, "meta/_journal.json")).json()
    for (const { tag } of journal.entries as { tag: string }[]) {
      for (const statement of (await Bun.file(join(MIGRATIONS, `${tag}.sql`)).text()).split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await admin.unsafe(statement)
      }
    }
    await admin`insert into claude_session (id) values (${SESSION})`
    store = await import("../../../../../../api/hono/src/lib/dashboard/threads")
    db = (await import("../../../../../../packages/db/dist/index.mjs")).createDatabase(url)
  }, 60_000)

  afterAll(async () => {
    await admin?.close()
    if (container)
      Bun.spawnSync(["docker", "rm", "-f", "-v", container], { stderr: "ignore", stdout: "ignore" })
  })

  let seq = 0

  const thread = async (
    id: string,
    updatedAt: string,
    extra: { archivedAt?: string; lastReadAt?: string; pinnedAt?: string } = {},
  ) => {
    await admin`insert into thread (id, title, updated_at, archived_at, last_read_at, pinned_at)
      values (${id}, ${`Thread ${id}`}, ${updatedAt}, ${extra.archivedAt ?? null}, ${extra.lastReadAt ?? null}, ${extra.pinnedAt ?? null})`
  }

  // A transcript line tagged to the thread, next in its order.
  const message = async (threadId: string, at: string, kind = "peer") => {
    seq += 1
    const uuid = `33333333-3333-4333-8333-${String(seq).padStart(12, "0")}`
    const [{ next }] =
      await admin`select coalesce(max(thread_seq), 0) + 1 as next from claude_entry where thread_id = ${threadId}`
    await admin`insert into claude_entry (session_id, uuid, seq, kind, type, raw, at, thread_id, thread_seq)
      values (${SESSION}, ${uuid}, ${seq}, ${kind}, 'user', '{}'::jsonb, ${at}, ${threadId}, ${next})`
    return uuid
  }

  const reset = () => admin`delete from thread`

  test("a page holds 5 open threads, pinned first with the newest pin on top, then the newest update, archived ones left out", async () => {
    await reset()
    await thread("bbb2", "2026-10-20T10:00:00.000Z")
    await thread("ccc3", "2026-10-20T12:00:00.000Z")
    await thread("ddd4", "2026-10-20T11:00:00.000Z")
    await thread("fff6", "2026-10-20T09:00:00.000Z")
    await thread("ggg7", "2026-10-20T13:00:00.000Z", { archivedAt: "2026-10-20T14:00:00.000Z" })
    await thread("hhh8", "2026-10-20T08:00:00.000Z", { pinnedAt: "2026-10-20T08:30:00.000Z" })
    await thread("jjj9", "2026-10-20T07:00:00.000Z", { pinnedAt: "2026-10-20T09:30:00.000Z" })
    await thread("kkk2", "2026-10-20T06:00:00.000Z")

    const first = await store.listThreads(db, 1)
    expect(first.threads.map((t) => t.id)).toEqual(["jjj9", "hhh8", "ccc3", "ddd4", "bbb2"])
    expect(first).toMatchObject({ hasNextPage: true, page: 1, total: 7 })

    const second = await store.listThreads(db, 2)
    expect(second.threads.map((t) => t.id)).toEqual(["fff6", "kkk2"])
    expect(second).toMatchObject({ hasNextPage: false, page: 2, total: 7 })

    expect((await store.listThreads(db, 3)).threads).toEqual([])
  })

  test("unread counts every message someone else wrote while the thread was never read, then only the ones after its read", async () => {
    await reset()
    await thread("mmm3", "2026-10-20T12:00:00.000Z")
    const first = await message("mmm3", "2026-10-20T10:00:00.000Z")
    await message("mmm3", "2026-10-20T11:00:00.000Z")
    // yours never counts, nor a meta line, which the view leaves out
    await message("mmm3", "2026-10-20T11:10:00.000Z", "human")
    await message("mmm3", "2026-10-20T11:15:00.000Z", "meta")
    const unreadOf = async () => (await store.listThreads(db, 1)).threads[0]

    expect(await unreadOf()).toMatchObject({ firstMessageId: first, lastReadAt: null, unread: 2 })

    const readAt = new Date("2026-10-20T11:30:00.000Z")
    const read = await store.patchThread(db, "mmm3", { read: true }, readAt)
    expect(read).toMatchObject({ lastReadAt: readAt.toISOString(), unread: 0 })

    await message("mmm3", "2026-10-20T11:45:00.000Z")
    expect(await unreadOf()).toMatchObject({ firstMessageId: first, unread: 1 })
  })

  test("a thread no route has tagged a message to has no first message and nothing unread", async () => {
    await reset()
    await thread("nnn4", "2026-10-20T12:00:00.000Z")
    expect((await store.listThreads(db, 1)).threads[0]).toMatchObject({
      firstMessageId: null,
      unread: 0,
    })
  })

  test("each field of a change: archived, pinned and read set their time or clear it, and title renames", async () => {
    await reset()
    await thread("ppp5", "2026-10-20T12:00:00.000Z")
    await message("ppp5", "2026-10-20T10:00:00.000Z")
    const now = new Date("2026-10-21T09:00:00.000Z")
    const at = now.toISOString()

    expect(await store.patchThread(db, "ppp5", { pinned: true }, now)).toMatchObject({
      pinnedAt: at,
    })
    expect(await store.patchThread(db, "ppp5", { pinned: false }, now)).toMatchObject({
      pinnedAt: null,
    })
    expect(await store.patchThread(db, "ppp5", { archived: true }, now)).toMatchObject({
      archivedAt: at,
    })
    expect((await store.listThreads(db, 1)).threads).toEqual([])
    expect(await store.patchThread(db, "ppp5", { archived: false }, now)).toMatchObject({
      archivedAt: null,
    })
    expect(await store.patchThread(db, "ppp5", { read: true }, now)).toMatchObject({
      lastReadAt: at,
      unread: 0,
    })
    // read false clears the read, so every message counts unread again
    expect(await store.patchThread(db, "ppp5", { read: false }, now)).toMatchObject({
      lastReadAt: null,
      unread: 1,
    })
    const renamed = await store.patchThread(db, "ppp5", { title: "Ship the sidebar" }, now)
    expect(renamed).toMatchObject({ title: "Ship the sidebar" })
    // a change is not a new message, so the thread keeps its place in the order
    expect(renamed?.updatedAt).toBe("2026-10-20T12:00:00.000Z")
  })

  test("a change to a thread that does not exist finds nothing", async () => {
    await reset()
    expect(await store.patchThread(db, "zzz9", { read: true })).toBeNull()
  })

  // A transcript line of the session, untagged, as ingest leaves it.
  const line = async (kind: string, text: string, at: string) => {
    seq += 1
    const uuid = `44444444-4444-4444-8444-${String(seq).padStart(12, "0")}`
    await admin`insert into claude_entry (session_id, uuid, seq, kind, type, raw, at, text, sender)
      values (${SESSION}, ${uuid}, ${seq}, ${kind}, 'user', '{}'::jsonb, ${at}, ${text}, ${kind === "peer" ? "k3m9px-worker" : null})`
    return uuid
  }

  const tagged = async (uuid: string) =>
    (
      await admin`select thread_id, thread_seq from claude_entry where session_id = ${SESSION} and uuid = ${uuid}`
    )[0] as { thread_id: string | null; thread_seq: number | null }

  test("a thread's messages come in its own order, each in the chat's shape, with another thread's and the untagged ones left out", async () => {
    await reset()
    await admin`delete from claude_entry where session_id = ${SESSION}`
    await thread("qqq6", "2026-10-20T12:00:00.000Z")
    await thread("rrr7", "2026-10-20T12:00:00.000Z")
    const ask = await line("human", "Ship the thread view", "2026-10-20T10:00:00.000Z")
    const update = await line("peer", "PR is open", "2026-10-20T09:00:00.000Z")
    const elsewhere = await line("human", "Another thing", "2026-10-20T10:30:00.000Z")
    await line("human", "Untagged chat", "2026-10-20T10:45:00.000Z")
    // routed out of time order: the update was filed second although stamped first
    await admin`update claude_entry set thread_id = 'qqq6', thread_seq = 1 where uuid = ${ask}`
    await admin`update claude_entry set thread_id = 'qqq6', thread_seq = 2 where uuid = ${update}`
    await admin`update claude_entry set thread_id = 'rrr7', thread_seq = 1 where uuid = ${elsewhere}`

    const found = await store.threadMessages(db, "qqq6")
    expect(found?.thread).toMatchObject({ id: "qqq6", title: "Thread qqq6", unread: 1 })
    expect(found?.entries).toEqual([
      {
        at: "2026-10-20T10:00:00.000Z",
        from: null,
        id: ask,
        kind: "human",
        text: "Ship the thread view",
        tool: null,
      },
      {
        at: "2026-10-20T09:00:00.000Z",
        from: "k3m9px-worker",
        id: update,
        kind: "peer",
        text: "PR is open",
        tool: null,
      },
    ])
    expect(await store.threadMessages(db, "zzz9")).toBeNull()
  })

  test("a route files the newest untagged message that opens with the quote as the thread's next, never one stamped before since, and leaves a filed one where it is", async () => {
    await reset()
    await admin`delete from claude_entry where session_id = ${SESSION}`
    await thread("sss8", "2026-10-20T08:00:00.000Z")
    await thread("ttt9", "2026-10-20T08:00:00.000Z")
    const old = await line("human", "ok, ship it", "2026-10-20T09:00:00.000Z")
    const route = { quote: "ok, ship it", session: SESSION, threadId: "sss8" }
    const since = new Date("2026-10-20T09:30:00.000Z")

    // ingest has not brought the new message yet: the older one with the same words is passed over
    expect(await store.routeMessage(db, { ...route, since })).toBeNull()
    expect(await tagged(old)).toEqual({ thread_id: null, thread_seq: null })

    const reply = await line("assistant", "ok, ship it now", "2026-10-20T10:00:30.000Z")
    const sent = await line("human", "  ok, ship it", "2026-10-20T10:00:00.000Z")
    expect(await store.routeMessage(db, { ...route, since })).toEqual({ seq: 1, uuid: sent })
    expect(await tagged(sent)).toEqual({ thread_id: "sss8", thread_seq: 1 })
    expect(await tagged(reply)).toEqual({ thread_id: null, thread_seq: null })
    expect((await store.threadMessages(db, "sss8"))?.thread.updatedAt).toBe(
      "2026-10-20T10:00:00.000Z",
    )

    // filed already, so a second route to another thread finds nothing after since
    expect(await store.routeMessage(db, { ...route, since, threadId: "ttt9" })).toBeNull()
    expect(await tagged(sent)).toEqual({ thread_id: "sss8", thread_seq: 1 })
  })

  test("a route finds a message past the [Image #n] marks Claude Code puts before its words", async () => {
    await reset()
    await admin`delete from claude_entry where session_id = ${SESSION}`
    await thread("www3", "2026-10-20T08:00:00.000Z")
    const since = new Date("2026-10-20T09:30:00.000Z")
    const words = await line("human", "[Image #1][Image #2]Ship it", "2026-10-20T10:00:00.000Z")
    const files = await line("human", "[Image #1]\nAttached:", "2026-10-20T10:01:00.000Z")
    const route = { session: SESSION, since, threadId: "www3" }
    expect(await store.routeMessage(db, { ...route, quote: "Ship it" })).toEqual({
      seq: 1,
      uuid: words,
    })
    expect(await store.routeMessage(db, { ...route, quote: "Attached:" })).toEqual({
      seq: 2,
      uuid: files,
    })
  })

  test("a thread leaves out a tagged meta line and reads a tagged prompt as its sender's message", async () => {
    await reset()
    await admin`delete from claude_entry where session_id = ${SESSION}`
    await thread("xxx4", "2026-10-20T12:00:00.000Z")
    const meta = await line("meta", "[Image: source: /tmp/shot.png]", "2026-10-20T10:00:00.000Z")
    const prompt = await line("prompt", "Run the checks", "2026-10-20T10:01:00.000Z")
    await admin`update claude_entry set sender = 'p4wq-worker' where uuid = ${prompt}`
    await admin`update claude_entry set thread_id = 'xxx4', thread_seq = 1 where uuid = ${meta}`
    await admin`update claude_entry set thread_id = 'xxx4', thread_seq = 2 where uuid = ${prompt}`
    expect((await store.threadMessages(db, "xxx4"))?.entries).toEqual([
      {
        at: "2026-10-20T10:01:00.000Z",
        from: "p4wq-worker",
        id: prompt,
        kind: "peer",
        text: "Run the checks",
        tool: null,
      },
    ])
  })

  // a reviewer: the route files the message alone, so the source line naming its image stays untagged
  test("an image sent with a filed message is named by the session's untagged source line of the same prompt", async () => {
    await reset()
    await admin`delete from claude_entry where session_id = ${SESSION}`
    await thread("yyy5", "2026-10-20T12:00:00.000Z")
    const png = "11111111-2222-4333-8444-555555555555.png"
    const at = "2026-10-20T10:00:00.000Z"
    const human = {
      message: {
        content: [
          { text: "[Image #1]Look at this\nAttached:", type: "text" },
          {
            source: { data: "iVBORw0KGgo=", media_type: "image/png", type: "base64" },
            type: "image",
          },
        ],
        role: "user",
      },
      imagePasteIds: [1],
      origin: { kind: "human" },
      promptId: "p-yyy5",
      timestamp: at,
      type: "user",
      uuid: "55555555-5555-4555-8555-000000000001",
    }
    const source = (uuid: string, promptId: string) => ({
      isMeta: true,
      message: {
        content: [{ text: `[Image: source: ${join(attachmentsDir(), png)}]`, type: "text" }],
        role: "user",
      },
      promptId,
      timestamp: at,
      type: "user",
      uuid,
    })
    const insert = async (raw: { uuid: string }, kind: string, text: string, tag: boolean) => {
      seq += 1
      await admin`insert into claude_entry (session_id, uuid, seq, kind, type, raw, at, text, thread_id, thread_seq)
        values (${SESSION}, ${raw.uuid}, ${seq}, ${kind}, 'user', ${JSON.stringify(raw)}::text::jsonb, ${at}, ${text}, ${tag ? "yyy5" : null}, ${tag ? 1 : null})`
    }
    await insert(human, "human", "[Image #1]Look at this\nAttached:", true)
    await insert(
      source("55555555-5555-4555-8555-000000000002", "p-yyy5"),
      "meta",
      `[Image: source: ${png}]`,
      false,
    )
    // another prompt's source line names nothing here
    await insert(
      source("55555555-5555-4555-8555-000000000003", "p-other"),
      "meta",
      `[Image: source: ${png}]`,
      false,
    )
    expect((await store.threadMessages(db, "yyy5"))?.entries).toEqual([
      {
        at,
        attachments: [{ id: png, kind: "image" }],
        from: null,
        id: human.uuid,
        kind: "human",
        text: "Look at this",
        tool: null,
      },
    ])
  })

  test("fileUnder tries again until ingest brings the message, and gives up after its wait", async () => {
    await reset()
    await admin`delete from claude_entry where session_id = ${SESSION}`
    await thread("vvv2", "2026-10-20T08:00:00.000Z")
    const route = { quote: "later words", session: SESSION, threadId: "vvv2" }
    expect(await store.fileUnder(db, route, { pollMs: 10, waitMs: 30 })).toBeNull()
    const pending = store.fileUnder(db, route, { pollMs: 20, waitMs: 5000 })
    await Bun.sleep(50)
    const uuid = await line("human", "later words", "2026-10-20T10:00:00.000Z")
    expect(await pending).toEqual({ seq: 1, uuid })
  })

  test("a stack reading the live machine never seeds the made-up threads, and neither does a refused one", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database was touched")
        },
      },
    ) as typeof db
    expect(await store.seedFixtureThreads(untouchable, { kind: "live", rule: "own" })).toBe(0)
    expect(await store.seedFixtureThreads(untouchable, { kind: "live", rule: "live-branch" })).toBe(
      0,
    )
    expect(await store.seedFixtureThreads(untouchable, { kind: "refused", reason: "no" })).toBe(0)
  })

  test("a fresh fixture stack seeds the made-up threads at start and says so on one line", async () => {
    await reset()
    const dir = join(mkdtempSync(join(tmpdir(), "threads-start-")), "fixture")
    const saved = process.env.PLAYGROUND_FIXTURE_DIR
    process.env.PLAYGROUND_FIXTURE_DIR = dir
    const lines: string[] = []
    const said = console.error
    console.error = (line: unknown) => lines.push(String(line))
    try {
      expect(await store.seedFixtureThreadsAtStart(db)).toBe(7)
      expect(lines).toEqual(["fixture: 7 made-up threads seeded at start"])
    } finally {
      console.error = said
      if (saved === undefined) delete process.env.PLAYGROUND_FIXTURE_DIR
      else process.env.PLAYGROUND_FIXTURE_DIR = saved
    }
  })

  test("a fixture stack whose table already holds a thread seeds nothing at start", async () => {
    await reset()
    await thread("zzz9", "2026-10-20T10:00:00.000Z")
    const dir = join(mkdtempSync(join(tmpdir(), "threads-start-full-")), "fixture")
    const saved = process.env.PLAYGROUND_FIXTURE_DIR
    process.env.PLAYGROUND_FIXTURE_DIR = dir
    const lines: string[] = []
    const said = console.error
    console.error = (line: unknown) => lines.push(String(line))
    try {
      expect(await store.seedFixtureThreadsAtStart(db)).toBe(0)
      expect(lines).toEqual([])
      const [{ value }] = await admin`select count(*)::int as value from thread`
      expect(value).toBe(1)
    } finally {
      console.error = said
      if (saved === undefined) delete process.env.PLAYGROUND_FIXTURE_DIR
      else process.env.PLAYGROUND_FIXTURE_DIR = saved
      await reset()
    }
  })

  test("a stack reading the live machine never seeds at start", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database was touched")
        },
      },
    ) as typeof db
    const saved = process.env.PLAYGROUND_LIVE_READS
    process.env.PLAYGROUND_LIVE_READS = "true"
    try {
      expect(await store.seedFixtureThreadsAtStart(untouchable)).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.PLAYGROUND_LIVE_READS
      else process.env.PLAYGROUND_LIVE_READS = saved
    }
  })

  test("a fixture stack seeds the shipped threads over its ingested transcript: 6 open across 2 pages, one pinned on top, and a change survives a second seed", async () => {
    await reset()
    const dir = join(mkdtempSync(join(tmpdir(), "threads-fixture-")), "fixture")
    const saved = process.env.PLAYGROUND_FIXTURE_DIR
    process.env.PLAYGROUND_FIXTURE_DIR = dir
    try {
      const source = { file: null, kind: "fixture", rule: "test" } as const
      ensureFixture(source)
      // the transcript as bun run ingest would have read it, its times moved to now as the fixture's are
      const lines = (
        await Bun.file(join(dir, `claude/projects/-fixture-playground/${SESSION}.jsonl`)).text()
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { timestamp?: string; type?: string; uuid?: string })
      await admin`delete from claude_entry where session_id = ${SESSION}`
      for (const [i, line] of lines.entries()) {
        if (!line.uuid || !line.timestamp) continue
        await admin`insert into claude_entry (session_id, uuid, seq, kind, type, raw, at)
          values (${SESSION}, ${line.uuid}, ${i + 1}, ${line.type === "assistant" ? "assistant" : "human"}, 'user', '{}'::jsonb, ${line.timestamp})`
      }

      expect(await store.seedFixtureThreads(db, source)).toBe(7)
      const first = await store.listThreads(db, 1)
      expect(first.threads.map((t) => [t.id, t.unread])).toEqual([
        ["k7mq", 1],
        ["f3cz", 0],
        ["p9wn", 1],
        ["dx4h", 0],
        ["b2rt", 1],
      ])
      expect(first).toMatchObject({ hasNextPage: true, total: 6 })
      expect(first.threads[0]).toMatchObject({
        firstMessageId: "22222222-2222-4222-8222-000000000001",
      })
      expect((await store.listThreads(db, 2)).threads.map((t) => t.id)).toEqual(["m5gs"])

      await store.patchThread(db, "k7mq", { read: true })
      expect(await store.seedFixtureThreads(db, source)).toBe(7)
      expect((await store.listThreads(db, 1)).threads[0]).toMatchObject({ id: "k7mq", unread: 0 })
    } finally {
      if (saved === undefined) delete process.env.PLAYGROUND_FIXTURE_DIR
      else process.env.PLAYGROUND_FIXTURE_DIR = saved
      await admin`delete from claude_entry where session_id = ${SESSION}`
    }
  })
})
