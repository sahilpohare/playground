import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { SQL } from "bun"

import { testContainerName } from "../../../../../container"

process.env.BETTER_AUTH_SECRET ||= "yard-store-test-secret-not-for-use-anywhere"
const { createDatabase } = await import("../../../../../../packages/db/dist/index.mjs")
const store = await import("../../../../../../api/hono/src/lib/yard/store")
const { cutoff, sweepOnceADay, take } =
  await import("../../../../../../api/hono/src/lib/yard/limits")

// Yard's store on the migration chain, on a throwaway Postgres in Docker published on 127.0.0.1 only, with made-up members. Skipped where Docker is not running.
const MIGRATIONS = join(import.meta.dir, "../../../../../../packages/db/drizzle")
const PASSWORD = crypto.randomUUID()

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

type Caller = import("../../../../../../api/hono/src/lib/yard/store").Caller

const web = (id: string, owner = false): Caller => ({
  device: "web",
  id,
  login: id,
  owner,
  via: "web",
})
const token = (id: string, owner = false): Caller => ({
  device: "studio",
  id,
  login: id,
  owner,
  via: "token",
})

// Posts with the limits out of the way, since a test posts faster than once a second; the limits have their own test.
const UNLIMITED = { channelHour: 1e6, loginDay: 1e6, loginSecond: 1e6 }

describe.skipIf(!dockerUp())("Yard's store", () => {
  let container = ""
  let sql: SQL
  let db: ReturnType<typeof createDatabase>

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("yard-store"),
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
        sql = new SQL(url, { max: 1 })
        await sql`select 1`
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
        if (statement.trim()) await sql.unsafe(statement)
    for (const [id, role] of [
      ["ada", "owner"],
      ["bo", "member"],
      ["cy", "user"],
      ["di", "member"],
      ["ed", "member"],
    ])
      await sql`insert into "user" (id, name, email, login, role) values (${id}, ${id}, ${`${id}@example.com`}, ${id}, ${role})`
    db = createDatabase(url)
  }, 60_000)

  afterAll(async () => {
    await sql?.close()
    if (container)
      Bun.spawnSync(["docker", "rm", "-fv", container], { stderr: "ignore", stdout: "ignore" })
  })

  const send = (caller: Caller, channelId: string, body: Parameters<typeof store.post>[3]) =>
    store.post(db, caller, channelId, body, UNLIMITED)

  const both = async (name: string) => {
    const channel = await store.createChannel(db, web("ada", true), { name })
    await store.joinChannel(db, web("bo"), channel.id)
    return channel
  }

  // first in the file, so #general and #releases do not exist yet when it runs
  describe("Yard's own channels, joined on a member's first list", () => {
    const own = async (userId?: string) =>
      userId
        ? await sql`select c.name, count(*)::int as n from yard_member m join yard_channel c on c.id = m.channel_id where m.user_id = ${userId} and c.name in ('general', 'releases') group by c.name order by c.name`
        : await sql`select name, post_rule, count(*)::int as n from yard_channel where name in ('general', 'releases') group by name, post_rule order by name`

    test("two first lists at once make one #general and one #releases, each listing caller joined", async () => {
      const [ada, bo] = await Promise.all([
        store.channels(db, web("ada", true)),
        store.channels(db, web("bo")),
      ])
      for (const list of [ada, bo])
        expect(list.filter((c) => c.joined).map((c) => [c.name, c.postRule])).toEqual(
          expect.arrayContaining([
            ["general", "members"],
            ["releases", "owner"],
          ]),
        )
      expect([...(await own())]).toEqual([
        { n: 1, name: "general", post_rule: "members" },
        { n: 1, name: "releases", post_rule: "owner" },
      ])
    })

    test("a second list adds no row or membership", async () => {
      await store.channels(db, web("ada", true))
      await store.channels(db, web("ada", true))
      expect([...(await own())].map((r: { n: number }) => r.n)).toEqual([1, 1])
      expect([...(await own("ada"))]).toEqual([
        { n: 1, name: "general" },
        { n: 1, name: "releases" },
      ])
    })

    test("joins the caller alone: a member who has not listed is in neither", async () => {
      expect([...(await own("ed"))]).toEqual([])
    })

    test("a member in one of the two, by a join of its own or a list cut short, joins the other on its next list", async () => {
      const general = (await store.channels(db, web("ada", true))).find(
        (c) => c.name === "general",
      )!
      await store.joinChannel(db, web("ed"), general.id)
      await store.channels(db, web("ed"))
      expect([...(await own("ed"))]).toEqual([
        { n: 1, name: "general" },
        { n: 1, name: "releases" },
      ])
    })

    test("#releases stays the owner's: a member's post there is refused", async () => {
      const releases = (await store.channels(db, web("bo"))).find((c) => c.name === "releases")!
      await expect(
        send(web("bo"), releases.id, { kind: "text", text: "can I post here?" }),
      ).rejects.toMatchObject({ status: 403 })
    })
  })

  describe("channels", () => {
    test("count a member's unread and mentions since they last read, and a read clears them", async () => {
      const { id } = await both("unread")
      await send(web("ada", true), id, { kind: "text", text: "morning" })
      await send(web("ada", true), id, { kind: "text", text: "@bo can you look?" })
      const before = (await store.channels(db, web("bo"))).find((c) => c.id === id)!
      expect([before.unread, before.mentions, before.joined]).toEqual([2, 1, true])
      await store.markRead(db, web("bo"), id)
      const after = (await store.channels(db, web("bo"))).find((c) => c.id === id)!
      expect([after.unread, after.mentions]).toEqual([0, 0])
    })

    test("waiting lists every sent mention of a member since a time, a thread's reply included, and their own held posts, oldest first", async () => {
      const { id } = await both("waiting")
      const since = new Date(Date.now() - 1000).toISOString()
      const top = await send(web("ada", true), id, { kind: "question", text: "@bo can you look?" })
      await send(web("ada", true), id, { kind: "text", text: "no mention, @bob is someone else" })
      const reply = await send(web("ada", true), id, {
        kind: "answer",
        parent: top.id,
        text: "@bo and this reply",
      })
      await send(token("ada", true), id, { kind: "steps", text: "@bo held, not sent" })
      await send(web("bo"), id, { kind: "text", text: "@bo my own" })
      const held = await send(token("bo"), id, { kind: "steps", text: "run the suite" })
      // other tests post to bo's other channels in the same second, so this reads this channel's alone
      const here = async (from: string) =>
        (await store.waiting(db, web("bo"), { since: from }))
          .filter((item) => item.message.channel === id)
          .map((item) => [item.held, item.message.id])
      expect(await here(since)).toEqual([
        [false, top.id],
        [false, reply.id],
        [true, held.id],
      ])
      const last = (await store.waiting(db, web("bo"), { since })).at(-1)!.shownAt
      expect(await here(last)).toEqual([])
      expect(
        (await store.waiting(db, web("di"), { since })).filter((i) => i.message.channel === id),
      ).toEqual([])
    })

    test("waiting lists every message a bot sends in its DM to the bot's maker, with no mention, and not to a member outside the DM", async () => {
      const since = new Date(Date.now() - 1000).toISOString()
      const { bot } = await store.createBot(db, web("ada", true), "waiter")
      const [row] = await sql`select id from "user" where login = ${bot.login}`
      const asBot: Caller = {
        bot: { madeBy: "ada" },
        device: store.BOT_DEVICE,
        id: row!.id,
        login: bot.login,
        owner: false,
        via: "token",
      }
      const said = await send(asBot, bot.dm, { kind: "question", text: "is the build green?" })
      await send(web("ada", true), bot.dm, { kind: "answer", text: "yes, all green" })
      const inDm = async (caller: Caller) =>
        (await store.waiting(db, caller, { since }))
          .filter((item) => item.message.channel === bot.dm)
          .map((item) => [item.held, item.message.id, item.message.from.login])
      expect(await inDm(web("ada", true))).toEqual([[false, said.id, "waiter[bot]"]])
      expect(await inDm(web("bo"))).toEqual([])
    })

    test("a mention held, then approved after a later mark, still waits, from when it was sent", async () => {
      const { id } = await both("approved-later")
      const asked = await send(token("ada", true), id, { kind: "question", text: "@bo approve me" })
      expect(asked.status).toBe("pending")
      await Bun.sleep(5)
      await send(web("ada", true), id, { kind: "text", text: "@bo a later one" })
      const mark = (await store.waiting(db, web("bo"), { since: asked.at }))
        .filter((i) => i.message.channel === id)
        .at(-1)!.shownAt
      await store.decide(db, web("ada", true), asked.id, "sent")
      const after = (await store.waiting(db, web("bo"), { since: mark })).filter(
        (i) => i.message.channel === id,
      )
      expect(after.map((i) => i.message.id)).toEqual([asked.id])
      expect(after[0]!.shownAt > mark).toBe(true)
    })

    test("a full list stops both lists at its last time, so the next since skips nothing", async () => {
      const channel = await store.createChannel(db, web("ada", true), { name: "full" })
      await store.joinChannel(db, web("ed"), channel.id)
      const since = new Date(Date.now() - 1000).toISOString()
      const mention = async (text: string) => {
        await Bun.sleep(3)
        return (await send(web("ada", true), channel.id, { kind: "text", text })).id
      }
      const early = [await mention("@ed 0"), await mention("@ed 1"), await mention("@ed 2")]
      await Bun.sleep(3)
      const held = (await send(token("ed"), channel.id, { kind: "steps", text: "run it" })).id
      const late = await mention("@ed 3")
      // the three mentions fill their list, so the held post after them waits for the next read
      const first = await store.waiting(db, web("ed"), { limit: 3, since })
      expect(first.map((i) => i.message.id)).toEqual(early)
      const next = await store.waiting(db, web("ed"), { limit: 3, since: first.at(-1)!.shownAt })
      expect(next.map((i) => [i.held, i.message.id])).toEqual([
        [true, held],
        [false, late],
      ])
    })

    test("rows in one millisecond on either side of a full list's limit all wait, the next read going on from the last id", async () => {
      const channel = await store.createChannel(db, web("ada", true), { name: "tie" })
      await store.joinChannel(db, web("ed"), channel.id)
      const ids: string[] = []
      for (const text of ["@ed a", "@ed b", "@ed c"])
        ids.push((await send(web("ada", true), channel.id, { kind: "text", text })).id)
      // an hour ahead, so no other test's row falls between since and the three
      const tied = new Date(Date.now() + 3_600_000)
      await sql`update yard_message set at = ${tied} where id in ${sql(ids)}`
      const since = new Date(tied.getTime() - 1).toISOString()
      const here = (items: { message: { id: string } }[]) => items.map((i) => i.message.id)
      const first = await store.waiting(db, web("ed"), { limit: 2, since })
      const last = first.at(-1)!
      const next = await store.waiting(db, web("ed"), {
        after: last.message.id,
        limit: 2,
        since: last.shownAt,
      })
      expect([...here(first), ...here(next)].sort()).toEqual([...ids].sort())
    })

    // the API answers a message's time in milliseconds, so a stored time finer than that left the message read at its own time still unread
    test("reading up to a message's own returned time clears it from unread and mentions", async () => {
      const { id } = await both("read-at")
      const message = await send(web("ada", true), id, { kind: "text", text: "@bo here" })
      await store.markRead(db, web("bo"), id, message.at)
      const after = (await store.channels(db, web("bo"))).find((c) => c.id === id)!
      expect([after.unread, after.mentions]).toEqual([0, 0])
    })

    test("a member cannot make #general or #releases before the first redeem does, so #releases stays the owner's", async () => {
      for (const name of ["general", "releases"])
        await expect(store.createChannel(db, web("bo"), { name })).rejects.toMatchObject({
          message: `#${name} is kept for Yard's own channel`,
          status: 409,
        })
    })

    test("a name already taken is a conflict", async () => {
      await store.createChannel(db, web("bo"), { name: "taken" })
      await expect(store.createChannel(db, web("di"), { name: "taken" })).rejects.toMatchObject({
        status: 409,
      })
    })

    test("a channel a member has not joined lists unjoined, with nothing unread, and reads as missing", async () => {
      const { id } = await store.createChannel(db, web("bo"), { name: "closed" })
      expect((await store.channels(db, web("di"))).find((c) => c.id === id)).toMatchObject({
        joined: false,
        unread: 0,
      })
      await expect(store.messages(db, web("di"), id, {})).rejects.toMatchObject({ status: 404 })
    })
  })

  describe("DMs", () => {
    test("both sides open the same row, named by the sorted ids, and see the other as its peer", async () => {
      const fromBo = await store.openDm(db, web("bo"), "DI")
      const fromDi = await store.openDm(db, web("di"), "bo")
      expect(fromBo.id).toBe(fromDi.id)
      expect(fromBo.name).toBe("dm:bo:di")
      expect([fromBo.peer?.login, fromDi.peer?.login]).toEqual(["di", "bo"])
    })

    test("a login with no membership, and yourself, open none", async () => {
      await expect(store.openDm(db, web("bo"), "cy")).rejects.toMatchObject({ status: 404 })
      await expect(store.openDm(db, web("bo"), "bo")).rejects.toMatchObject({ status: 400 })
    })
  })

  describe("posts", () => {
    test("a token's steps wait as pending, read by their sender alone, while a browser's send at once", async () => {
      const { id } = await both("tiers")
      const held = await send(token("bo"), id, { kind: "steps", text: "run the suite" })
      const sent = await send(web("bo"), id, { kind: "steps", text: "typed by hand" })
      expect([held.status, sent.status, held.from.device]).toEqual(["pending", "sent", "studio"])
      expect(
        (await store.messages(db, web("ada", true), id, {})).messages.map((m) => m.text),
      ).toEqual(["typed by hand"])
      expect((await store.messages(db, web("bo"), id, {})).messages.map((m) => m.text)).toEqual([
        "run the suite",
        "typed by hand",
      ])
    })

    test("a token's DM posts wait until the DM has a sent message, a denied opener included; a mention waits after", async () => {
      const { id } = await store.openDm(db, web("ada", true), "di")
      const status = async (text: string) =>
        (await send(token("ada", true), id, { kind: "text", text })).status
      const opener = await send(token("ada", true), id, { kind: "text", text: "hi" })
      expect([opener.status, await status("there")]).toEqual(["pending", "pending"])
      await store.decide(db, web("ada", true), opener.id, "denied")
      expect(await status("still there")).toBe("pending")
      const next = await send(token("ada", true), id, { kind: "text", text: "hello" })
      await store.decide(db, web("ada", true), next.id, "sent")
      expect([await status("now plain"), await status("@di see")]).toEqual(["sent", "pending"])
    })

    test("the maker's token sends its first plain post into the DM bot add made at once, while a mention and each held kind there still wait", async () => {
      const { bot } = await store.createBot(db, web("ada", true), "greeter")
      const status = async (kind: Parameters<typeof send>[2]["kind"], text: string) =>
        (await send(token("ada", true), bot.dm, { kind, text })).status
      expect(await status("text", `@${bot.login} see`)).toBe("pending")
      for (const kind of ["bug", "fix", "log", "steps"] as const)
        expect(await status(kind, "run the suite")).toBe("pending")
      expect(await status("text", "hi")).toBe("sent")
    })

    test("another member's first post into a DM with that bot still waits", async () => {
      const { bot } = await store.createBot(db, web("ada", true), "porter")
      const { id } = await store.openDm(db, web("bo"), bot.login)
      expect((await send(token("bo"), id, { kind: "text", text: "hi" })).status).toBe("pending")
    })

    test("an owner-only channel takes the owner alone, and holds the owner's token post", async () => {
      const { id } = await both("owner-only")
      await sql`update yard_channel set post_rule = 'owner' where id = ${id}`
      await expect(send(web("bo"), id, { kind: "notice", text: "shipped" })).rejects.toMatchObject({
        status: 403,
      })
      expect((await send(web("ada", true), id, { kind: "notice", text: "shipped" })).status).toBe(
        "sent",
      )
      expect((await send(token("ada", true), id, { kind: "notice", text: "shipped" })).status).toBe(
        "pending",
      )
    })

    test("a reply stays in its parent's channel", async () => {
      const a = await both("thread-a")
      const b = await both("thread-b")
      const first = await send(web("bo"), a.id, { kind: "question", text: "why?" })
      await expect(
        send(web("bo"), b.id, { kind: "answer", parent: first.id, text: "because" }),
      ).rejects.toMatchObject({
        status: 404,
      })
      const reply = await send(web("ada", true), a.id, {
        kind: "answer",
        parent: first.id,
        text: "because",
      })
      expect((await store.messages(db, web("bo"), a.id, { parent: first.id })).messages).toEqual([
        reply,
      ])
      expect((await store.messages(db, web("bo"), a.id, {})).messages.map((m) => m.id)).toEqual([
        first.id,
      ])
      await expect(
        send(web("bo"), a.id, { kind: "answer", parent: reply.id, text: "deeper" }),
      ).rejects.toMatchObject({
        status: 400,
      })
    })
  })

  describe("approving", () => {
    test("the sender sends or denies a pending message once; nobody else reaches it", async () => {
      const { id } = await both("approve")
      const held = await send(token("bo"), id, { kind: "fix", text: "patch" })
      await expect(store.ownMessage(db, web("ada", true), held.id)).rejects.toMatchObject({
        status: 404,
      })
      await expect(store.decide(db, web("ada", true), held.id, "sent")).rejects.toMatchObject({
        status: 404,
      })
      expect((await store.decide(db, web("bo"), held.id, "sent")).status).toBe("sent")
      await expect(store.decide(db, web("bo"), held.id, "denied")).rejects.toMatchObject({
        status: 409,
      })
      expect(
        await store.audienceOf(db, web("bo"), await store.ownMessage(db, web("bo"), held.id)),
      ).toEqual(expect.arrayContaining(["ada", "bo"]))
    })
  })

  describe("audience", () => {
    // a sent message's frame went to every row of the channel's members, so a banned member's open socket kept hearing the channel
    test("a sent message reaches the channel's members on the member rung, a ban or a lost rung takes a member out until it is undone, and a pending one reaches its sender alone", async () => {
      const channel = await both("audience")
      await store.joinChannel(db, web("di"), channel.id)
      const sent = await send(web("ada", true), channel.id, { kind: "text", text: "hello" })
      const audience = async () => (await store.audienceOf(db, web("ada", true), sent)).sort()
      expect(await audience()).toEqual(["ada", "bo", "di"])
      await sql`update "user" set banned = true where id = 'di'`
      expect(await audience()).toEqual(["ada", "bo"])
      await sql`update "user" set banned = false where id = 'di'`
      expect(await audience()).toEqual(["ada", "bo", "di"])
      await sql`update "user" set role = 'user' where id = 'di'`
      expect(await audience()).toEqual(["ada", "bo"])
      await sql`update "user" set role = 'member' where id = 'di'`
      const held = await send(token("bo"), channel.id, { kind: "fix", text: "patch" })
      expect(await store.audienceOf(db, token("bo"), held)).toEqual(["bo"])
    })
  })

  describe("approving after a read", () => {
    // a sent message kept the time it was held, so a mention approved after the member had read the channel never counted as unread
    test("a held mention approved after the member read the channel counts as unread and as a mention", async () => {
      const { id } = await both("late")
      const held = await send(token("bo"), id, { kind: "text", text: "@ada take a look" })
      expect(held.status).toBe("pending")
      await store.markRead(db, web("ada", true), id)
      await Bun.sleep(5)
      await store.decide(db, web("bo"), held.id, "sent")
      const channel = (await store.channels(db, web("ada", true))).find((c) => c.id === id)!
      expect([channel.unread, channel.mentions]).toEqual([1, 1])
    })
  })

  describe("retention", () => {
    test("a thread lives while its newest message is inside 90 days, and reads past it are gone before any sweep", async () => {
      const { id } = await both("retention")
      const old = new Date(cutoff().getTime() - 86_400_000)
      const kept = await send(web("bo"), id, { kind: "question", text: "old question" })
      await send(web("ada", true), id, { kind: "answer", parent: kept.id, text: "fresh answer" })
      const gone = await send(web("bo"), id, { kind: "text", text: "old note" })
      await sql`update yard_message set at = ${old} where id in (${kept.id}, ${gone.id})`
      expect((await store.messages(db, web("bo"), id, {})).messages.map((m) => m.text)).toEqual([
        "old question",
      ])
      await expect(store.ownMessage(db, web("bo"), gone.id)).rejects.toMatchObject({ status: 404 })
      await expect(
        send(web("bo"), id, { kind: "answer", parent: gone.id, text: "reviving" }),
      ).rejects.toMatchObject({ status: 404 })
      expect(await sweepOnceADay(db)).toBe(true)
      const left = await sql`select text from yard_message where channel_id = ${id} order by text`
      expect([...left].map((row) => row.text)).toEqual(["fresh answer", "old question"].sort())
    })
  })

  test("a pending post past retention can be neither sent nor denied", async () => {
    const { id } = await both("retention-pending")
    const held = await send(token("bo"), id, { kind: "steps", text: "run it" })
    await sql`update yard_message set at = ${new Date(cutoff().getTime() - 86_400_000)} where id = ${held.id}`
    await expect(store.decide(db, web("bo"), held.id, "sent")).rejects.toMatchObject({
      status: 404,
    })
  })

  test("a DM whose only sent message is past retention holds a token's post before any sweep", async () => {
    const { id } = await store.openDm(db, web("ada", true), "bo")
    const opener = await send(web("ada", true), id, { kind: "text", text: "long ago" })
    await sql`update yard_message set at = ${new Date(cutoff().getTime() - 86_400_000)} where id = ${opener.id}`
    expect((await send(token("ada", true), id, { kind: "text", text: "again" })).status).toBe(
      "pending",
    )
  })

  describe("limits", () => {
    test("count in fixed windows and refuse past the limit", async () => {
      const now = Date.UTC(2026, 9, 31, 12, 0, 0)
      expect(await take(db, "post:test", "second", 1, now)).toBe(1)
      await expect(take(db, "post:test", "second", 1, now + 500)).rejects.toMatchObject({
        status: 429,
      })
      expect(await take(db, "post:test", "second", 1, now + 1000)).toBe(1)
    })

    test("a post on the owner's limits refuses a login's second post in one second", async () => {
      const channel = await store.createChannel(db, web("ed"), { name: "limits" })
      // starts just after a second begins, so both posts fall in one window
      await Bun.sleep(1010 - (Date.now() % 1000))
      await store.post(db, web("ed"), channel.id, { kind: "text", text: "go" })
      await expect(
        store.post(db, web("ed"), channel.id, { kind: "text", text: "again" }),
      ).rejects.toMatchObject({ status: 429 })
    })

    // a fixed hour of its own, so no write crosses an hour's edge and no other test's write counts in it (PG-892)
    test("a member's token, invite and channel writes stop at the hour's cap", async () => {
      const now = Date.UTC(2026, 9, 31, 12, 30, 0)
      for (let i = 0; i < store.WRITES_HOUR; i++)
        await store.createToken(db, web("ed"), `t${i}`, now)
      await expect(store.createToken(db, web("ed"), "one-more", now)).rejects.toMatchObject({
        status: 429,
      })
    })

    // waits out an hour's last 30 s, so every call of a budget lands in one hourly window
    const inOneHour = async () => {
      const left = 3_600_000 - (Date.now() % 3_600_000)
      if (left < 30_000) await Bun.sleep(left + 10)
    }

    // a member of its own for one budget's test, so its counts reach no other test's caller
    const member = async (id: string): Promise<Caller> => {
      await sql`insert into "user" (id, name, email, login, role) values (${id}, ${id}, ${`${id}@example.com`}, ${id}, 'member')`
      return web(id)
    }

    test("joining a channel stops at 30 an hour for one caller", async () => {
      const caller = await member("joiner")
      const channel = await store.createChannel(db, caller, { name: "join-budget" })
      await inOneHour()
      for (let i = 0; i < 30; i++) await store.joinChannel(db, caller, channel.id)
      await expect(store.joinChannel(db, caller, channel.id)).rejects.toMatchObject({
        status: 429,
      })
    }, 60_000)

    test("opening a DM stops at 30 an hour for one caller", async () => {
      const caller = await member("dm-opener")
      await inOneHour()
      for (let i = 0; i < 30; i++) await store.openDm(db, caller, "di")
      await expect(store.openDm(db, caller, "di")).rejects.toMatchObject({ status: 429 })
    }, 60_000)

    test("redeeming an invite stops at 10 tries an hour for one caller, a wrong code included", async () => {
      const caller = await member("redeemer")
      await inOneHour()
      for (let i = 0; i < 10; i++)
        await expect(store.redeemInvite(db, caller, "NOPE-NOPE-NOPE")).rejects.toMatchObject({
          status: 404,
        })
      await expect(store.redeemInvite(db, caller, "NOPE-NOPE-NOPE")).rejects.toMatchObject({
        status: 429,
      })
    }, 60_000)

    test("a bot's reads of the log stop at 120 an hour, before the read reaches the Mac", async () => {
      const maker = await member("bot-maker")
      const { secret } = await store.createBot(db, maker, "log-budget", { log: true })
      const owner = (await store.tokenOwner(db, secret))!
      const bot = {
        bot: { madeBy: owner.bot!.madeBy, readsLog: true },
        device: owner.device,
        id: owner.user.id,
        login: owner.user.login!,
        owner: false,
        via: "token" as const,
      }
      await inOneHour()
      for (let i = 0; i < 120; i++) await store.logReadOf(db, bot)
      await expect(store.logReadOf(db, bot)).rejects.toMatchObject({ status: 429 })
    }, 60_000)
  })

  describe("tokens", () => {
    test("a token's secret is shown once, names its member until revoked, and a name is unique", async () => {
      const made = await store.createToken(db, web("bo"), "laptop")
      expect(made.secret).toStartWith("yard_")
      expect((await store.tokenOwner(db, made.secret))?.device).toBe("laptop")
      await expect(store.createToken(db, web("bo"), "laptop")).rejects.toMatchObject({
        status: 409,
      })
      await expect(store.createToken(db, web("bo"), "web")).rejects.toThrow()
      await store.revokeToken(db, web("bo"), made.id)
      expect(await store.tokenOwner(db, made.secret)).toBeNull()
      await expect(store.revokeToken(db, web("di"), made.id)).rejects.toMatchObject({ status: 404 })
    })

    test("any member makes a relay-on token, yard_relay_ and 32 characters, which names itself relay-on where a read-only one does not", async () => {
      // a fixed hour of its own, so these writes leave the owner's other tests under the hour's cap
      const now = Date.UTC(2026, 9, 31, 14, 0, 0)
      const member = await store.createRelayToken(db, web("bo"), "mac", now)
      expect(await store.tokenOwner(db, member.secret)).toMatchObject({
        device: "mac",
        relay: true,
      })
      const relay = await store.createRelayToken(db, web("ada", true), "mac-relay", now)
      expect(relay.secret).toMatch(/^yard_relay_[A-Za-z0-9_-]{32}$/)
      expect(await store.tokenOwner(db, relay.secret)).toMatchObject({
        device: "mac-relay",
        relay: true,
      })
      const person = await store.createToken(db, web("ada", true), "phone", now)
      expect(person.secret).toMatch(/^yard_[A-Za-z0-9_-]{32}$/)
      expect(await store.tokenOwner(db, person.secret)).toMatchObject({ relay: false })
      await store.revokeToken(db, web("ada", true), relay.id)
      expect(await store.tokenOwner(db, relay.secret)).toBeNull()
    })

    test("a token swaps itself in place for a fresh secret of its own kind, the old one reading as none after, and a revoked or other member's token swaps nothing", async () => {
      // a fixed hour of its own, so these writes leave the other tests under the hour's cap
      const now = Date.UTC(2026, 10, 13, 9, 0, 0)
      const fresh = (prefix: string, fill: string) => `${prefix}${fill.repeat(32)}`
      const relay = await store.createRelayToken(db, web("bo"), "swap-mac", now)
      const next = fresh("yard_relay_", "n")
      for (const [secret, status] of [
        [fresh("yard_", "r"), 400],
        [relay.secret, 400],
        ["yard_relay_short", 400],
      ] as const)
        await expect(
          store.swapToken(db, token("bo"), relay.secret, secret, now),
        ).rejects.toMatchObject({ status })
      await expect(store.swapToken(db, token("di"), relay.secret, next, now)).rejects.toMatchObject(
        { status: 401 },
      )
      expect(await store.swapToken(db, token("bo"), relay.secret, next, now)).toMatchObject({
        id: relay.id,
        name: "swap-mac",
        revokedAt: null,
      })
      expect(await store.tokenOwner(db, relay.secret)).toBeNull()
      expect(await store.tokenOwner(db, next)).toMatchObject({ device: "swap-mac", relay: true })
      const readOnly = await store.createToken(db, web("bo"), "swap-phone", now)
      await expect(
        store.swapToken(db, token("bo"), readOnly.secret, fresh("yard_relay_", "x"), now),
      ).rejects.toMatchObject({ status: 400 })
      expect(await store.tokenOwner(db, readOnly.secret)).toMatchObject({ relay: false })
      const nextReadOnly = fresh("yard_", "p")
      await store.swapToken(db, token("bo"), readOnly.secret, nextReadOnly, now)
      expect(await store.tokenOwner(db, nextReadOnly)).toMatchObject({ relay: false })
      await store.revokeToken(db, web("bo"), readOnly.id)
      await expect(
        store.swapToken(db, token("bo"), nextReadOnly, fresh("yard_", "q"), now),
      ).rejects.toMatchObject({ status: 401 })
    })
  })

  describe("invites", () => {
    test("an invite for a login lets that login in once, as a member in #general and the owner-only #releases", async () => {
      const invite = await store.createInvite(db, web("ada", true), { forLogin: "CY" })
      await expect(store.redeemInvite(db, web("di"), invite.code)).rejects.toMatchObject({
        status: 404,
      })
      expect(await store.redeemInvite(db, web("cy"), invite.code.toLowerCase())).toEqual({
        member: true,
      })
      await expect(store.redeemInvite(db, web("cy"), invite.code)).rejects.toMatchObject({
        status: 404,
      })
      const [row] = await sql`select role from "user" where id = 'cy'`
      expect(row.role).toBe("member")
      const joined = (await store.channels(db, web("cy"))).filter((c) => c.joined)
      expect(joined.map((c) => [c.name, c.postRule])).toEqual(
        expect.arrayContaining([
          ["general", "members"],
          ["releases", "owner"],
        ]),
      )
    })

    test("a member's request has no code until the owner opens it; the member sees their own requests alone", async () => {
      const asked = await store.requestInvite(db, web("bo"), "eve")
      expect(asked).toMatchObject({ requestedBy: { login: "bo" }, status: "requested" })
      expect((await store.invites(db, web("di"))).map((i) => i.id)).not.toContain(asked.id)
      const opened = await store.decideInvite(db, web("ada", true), asked.id, "approve")
      expect(opened).toMatchObject({ status: "open" })
      expect(opened.code).toMatch(/^[A-Z\d]{4}-[A-Z\d]{4}-[A-Z\d]{4}$/)
      await expect(
        store.decideInvite(db, web("ada", true), asked.id, "approve"),
      ).rejects.toMatchObject({ status: 409 })
      expect((await store.decideInvite(db, web("ada", true), asked.id, "deny")).status).toBe(
        "revoked",
      )
    })

    test("an expired invite lets nobody in", async () => {
      const invite = await store.createInvite(db, web("ada", true), {})
      await sql`update yard_invite set expires_at = now() - interval '1 minute' where id = ${invite.id}`
      await expect(store.redeemInvite(db, web("di"), invite.code)).rejects.toMatchObject({
        status: 404,
      })
    })
  })
})
