import { createHash, randomBytes } from "node:crypto"

import { reachesConsole } from "@packages/auth/access"
import {
  type Database,
  user,
  yardBot,
  yardChannel,
  yardInvite,
  yardMember,
  yardMessage,
  yardToken,
} from "@packages/db"
import {
  botLogin,
  botNameSchema,
  type Channel,
  type Message,
  tokenNameSchema,
} from "@packages/message"
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"

import { ApiError } from "@/lib/error"
import { live, take } from "@/lib/yard/limits"
import { isRelayToken, sameKind, tokenSecret as secret } from "@/lib/yard/secret"
import { HELD_KINDS, heldBecause, mentionsOf } from "@/lib/yard/tier"

type YardChannel = typeof yardChannel.$inferSelect

// Who is calling: a member signed in on the web, or one of their tokens, whose name is the device a post carries; bot names the member who made a bot's token's user (yard_bot), and whether the owner lets it read the dispatcher's log; relay marks a relay-on token (createRelayToken), which writes and may hold the relay, where any other member's token reads alone.
export type Caller = {
  bot?: { madeBy: string; readsLog?: boolean }
  device: string
  id: string
  login: string
  owner: boolean
  relay?: true
  via: "token" | "web"
}

// The channels every member joins on redeeming an invite or on a first list of channels: #general, where every member posts, and #releases, where the owner rung alone posts.
export const JOINED_ON_REDEEM = [
  { name: "general", postRule: "members" },
  { name: "releases", postRule: "owner" },
] as const

// The token, invite and channel writes a member makes in an hour.
export const WRITES_HOUR = 20

// A caller's hourly budget on the calls with no other: a bot's reads of the log, each a relay round trip to its maker's Mac, and a member's DM opens, channel joins and invite tries.
export const CALL_LIMITS = { dmHour: 30, joinHour: 30, logReadHour: 120, redeemHour: 10 } as const

export const hashOf = (secret: string): string => createHash("sha256").update(secret).digest("hex")

// A unique-constraint violation, which a write that can lose a race answers as 409; drizzle wraps the driver's error as its cause.
const taken = (error: unknown): boolean => {
  for (
    let at = error as { cause?: unknown; errno?: string } | undefined;
    at;
    at = at.cause as typeof at
  )
    if (at.errno === "23505") return true
  return false
}

const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`)

// A DM's name, by both user ids sorted, so either side opens the same row.
const dmName = (a: string, b: string) => `dm:${[a, b].sort().join(":")}`

type MessageRow = typeof yardMessage.$inferSelect

export const toMessage = (row: MessageRow): Message => ({
  at: row.at.toISOString(),
  channel: row.channelId,
  from: { device: row.device, login: row.login },
  id: row.id,
  kind: row.kind,
  ...(row.links?.length ? { links: row.links } : {}),
  ...(row.parentId ? { parent: row.parentId } : {}),
  status: row.status,
  text: row.text,
})

// A Postgres pattern for a message that names @login, as tier.ts's mentionsOf reads one: not inside a word, an email or a longer login.
const mentionPattern = (login: string) => `(^|[^\\w@])@${login}([^\\w-]|$)`

// Makes #general and #releases once and joins the member to both: the name's unique constraint and on-conflict-do-nothing inserts keep two at once to one row each.
const joinOwnChannels = async (tx: Pick<Database, "insert" | "select">, userId: string) => {
  for (const { name, postRule } of JOINED_ON_REDEEM) {
    await tx
      .insert(yardChannel)
      .values({ id: crypto.randomUUID(), kind: "channel", name, postRule })
      .onConflictDoNothing()
    const [channel] = await tx
      .select({ id: yardChannel.id })
      .from(yardChannel)
      .where(eq(yardChannel.name, name))
    await tx.insert(yardMember).values({ channelId: channel!.id, userId }).onConflictDoNothing()
  }
}

// Every channel and DM a caller sees, each with its unread and mention counts since the caller last read it: every channel, joined or not, and the DMs the caller is in; a member not in both of Yard's own channels joins the one it lacks on a list, so one cut short mends on the next, since the owner reaches Yard with no invite to redeem.
export const channels = async (db: Database, caller: Caller, id?: string): Promise<Channel[]> => {
  if (!id) {
    const [{ joined }] = await db
      .select({ joined: sql<number>`count(*)::int` })
      .from(yardMember)
      .innerJoin(yardChannel, eq(yardChannel.id, yardMember.channelId))
      .where(
        and(
          eq(yardMember.userId, caller.id),
          inArray(
            yardChannel.name,
            JOINED_ON_REDEEM.map((channel) => channel.name),
          ),
        ),
      )
    if (joined < JOINED_ON_REDEEM.length) await joinOwnChannels(db, caller.id)
  }
  const rows = await db.execute<{
    id: string
    joined: boolean
    kind: "channel" | "dm"
    last_message_at: Date | string | null
    mentions: number
    name: string
    peer: Channel["peer"]
    post_rule: "members" | "owner"
    topic: string | null
    unread: number
  }>(sql`
    select c.id, c.kind, c.name, c.post_rule, c.topic, m.user_id is not null as joined,
      (select max(x.at) from yard_message x where x.channel_id = c.id and x.status = 'sent' and ${live("x")}) as last_message_at,
      (select count(*)::int from yard_message x where x.channel_id = c.id and x.status = 'sent'
        and x.user_id is distinct from ${caller.id} and x.at > coalesce(m.last_read_at, m.joined_at) and ${live("x")}) as unread,
      (select count(*)::int from yard_message x where x.channel_id = c.id and x.status = 'sent'
        and x.user_id is distinct from ${caller.id} and x.at > coalesce(m.last_read_at, m.joined_at)
        and x.text ~* ${mentionPattern(caller.login)} and ${live("x")}) as mentions,
      case when c.kind = 'dm' then (
        select json_build_object('id', u.id, 'image', u.image, 'login', u.login, 'name', u.name)
        from yard_member o join "user" u on u.id = o.user_id
        where o.channel_id = c.id and o.user_id <> ${caller.id} limit 1
      ) end as peer
    from yard_channel c
    left join yard_member m on m.channel_id = c.id and m.user_id = ${caller.id}
    where (c.kind = 'channel' or m.user_id is not null) ${id ? sql`and c.id = ${id}` : sql``}
    order by c.kind, c.name
  `)
  return [...rows].map((row) => ({
    id: row.id,
    joined: row.joined,
    kind: row.kind,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    mentions: row.mentions,
    name: row.name,
    peer: row.peer ?? null,
    postRule: row.post_rule,
    topic: row.topic,
    unread: row.unread,
  }))
}

const channelFor = async (db: Database, caller: Caller, id: string): Promise<Channel> => {
  const [channel] = await channels(db, caller, id)
  if (!channel) throw notFound("Channel")
  return channel
}

export const createChannel = async (
  db: Database,
  caller: Caller,
  { name, topic }: { name: string; topic?: string },
): Promise<Channel> => {
  // Yard's own channels are made by the first redeem or list alone, so a member who named one first cannot set #releases open to every member
  if (JOINED_ON_REDEEM.some((channel) => channel.name === name))
    throw new ApiError(409, "CONFLICT", `#${name} is kept for Yard's own channel`)
  await take(db, `writes:${caller.id}`, "hour", WRITES_HOUR)
  const id = crypto.randomUUID()
  try {
    await db.transaction(async (tx) => {
      await tx.insert(yardChannel).values({ id, kind: "channel", name, topic })
      await tx.insert(yardMember).values({ channelId: id, userId: caller.id })
    })
  } catch (error) {
    if (taken(error)) throw new ApiError(409, "CONFLICT", `#${name} already exists`)
    throw error
  }
  return channelFor(db, caller, id)
}

export const joinChannel = async (db: Database, caller: Caller, id: string): Promise<Channel> => {
  const [row] = await db.select().from(yardChannel).where(eq(yardChannel.id, id))
  if (!row || row.kind !== "channel") throw notFound("Channel")
  await take(db, `join:${caller.id}`, "hour", CALL_LIMITS.joinHour)
  await db.insert(yardMember).values({ channelId: id, userId: caller.id }).onConflictDoNothing()
  return channelFor(db, caller, id)
}

// The DM between the caller and another member, named by both user ids sorted so either side opens the same row.
export const openDm = async (db: Database, caller: Caller, login: string): Promise<Channel> => {
  const [peer] = await db
    .select({ banned: user.banned, id: user.id, role: user.role })
    .from(user)
    .where(sql`lower(${user.login}) = ${login.toLowerCase()}`)
  if (!peer || !reachesConsole(peer, "member")) throw notFound("Member")
  if (peer.id === caller.id) throw new ApiError(400, "BAD_REQUEST", "A DM is between two members")
  await take(db, `dm:${caller.id}`, "hour", CALL_LIMITS.dmHour)
  const name = dmName(caller.id, peer.id)
  await db.transaction(async (tx) => {
    await tx
      .insert(yardChannel)
      .values({ id: crypto.randomUUID(), kind: "dm", name })
      .onConflictDoNothing()
    const [row] = await tx
      .select({ id: yardChannel.id })
      .from(yardChannel)
      .where(eq(yardChannel.name, name))
    await tx
      .insert(yardMember)
      .values([caller.id, peer.id].map((userId) => ({ channelId: row!.id, userId })))
      .onConflictDoNothing()
  })
  const [row] = await db
    .select({ id: yardChannel.id })
    .from(yardChannel)
    .where(eq(yardChannel.name, name))
  return channelFor(db, caller, row!.id)
}

// The channel, when the caller is a member of it; a channel the caller is not in reads as missing.
const memberOf = async (db: Database, caller: Caller, id: string): Promise<YardChannel> => {
  const [row] = await db
    .select({ channel: yardChannel })
    .from(yardChannel)
    .innerJoin(
      yardMember,
      and(eq(yardMember.channelId, yardChannel.id), eq(yardMember.userId, caller.id)),
    )
    .where(eq(yardChannel.id, id))
  if (!row) throw notFound("Channel")
  return row.channel
}

// A bot's token reaches one channel alone, its DM with its maker, so any other reads 403 before anything about it is read.
const fenceBot = async (db: Database, caller: Caller, channelId: string) => {
  if (!caller.bot) return
  const [dm] = await db
    .select({ id: yardChannel.id })
    .from(yardChannel)
    .where(eq(yardChannel.name, dmName(caller.id, caller.bot.madeBy)))
  if (dm?.id !== channelId)
    throw new ApiError(403, "FORBIDDEN", "A bot reaches only its DM with its maker")
}

// A channel's messages, newest page first and each page oldest first: every sent one, and the caller's own pending and denied ones; with parent, that message's thread; with after, the page that follows that message, oldest first, so a client without a socket reads what is new.
export const messages = async (
  db: Database,
  caller: Caller,
  channelId: string,
  {
    after,
    before,
    limit = 50,
    parent,
  }: { after?: string; before?: string; limit?: number; parent?: string },
): Promise<{ hasMore: boolean; messages: Message[] }> => {
  await fenceBot(db, caller, channelId)
  await memberOf(db, caller, channelId)
  const seen = and(
    eq(yardMessage.channelId, channelId),
    or(eq(yardMessage.status, "sent"), eq(yardMessage.userId, caller.id)),
    parent ? eq(yardMessage.parentId, parent) : isNull(yardMessage.parentId),
    live(),
  )
  const id = sql`${yardMessage.id} collate "C"`
  if (after) {
    const [mark] = await db
      .select({ at: yardMessage.at, id: yardMessage.id })
      .from(yardMessage)
      .where(and(eq(yardMessage.id, after), seen))
    if (!mark) throw notFound("Message")
    const rows = await db
      .select()
      .from(yardMessage)
      .where(and(seen, sql`(${yardMessage.at}, ${id}) > (${mark.at}, ${mark.id} collate "C")`))
      .orderBy(asc(yardMessage.at), asc(id))
      .limit(limit + 1)
    return { hasMore: rows.length > limit, messages: rows.slice(0, limit).map(toMessage) }
  }
  const rows = await db
    .select()
    .from(yardMessage)
    .where(and(seen, before ? lt(yardMessage.at, new Date(before)) : undefined))
    .orderBy(desc(yardMessage.at), desc(yardMessage.id))
    .limit(limit + 1)
  return { hasMore: rows.length > limit, messages: rows.slice(0, limit).reverse().map(toMessage) }
}

// When a message showed to others, at the millisecond: a held post shows when its sender sends it, so an approved mention counts from then, never from when it was written.
const shownAt = sql<string>`date_trunc('milliseconds', coalesce(${yardMessage.decidedAt}, ${yardMessage.at}))`

export type Waiting = { held: boolean; message: Message; shownAt: string }

// What waits on the caller past a mark, which the local Playground cards in its Inbox (a bot's message told to its dispatcher instead), oldest first by when it showed, then by id: every sent message that names them in a channel or DM they are in, a thread's reply included, from when they joined it, every message a bot they made sends, which reaches only its DM with them, but the line each read of the log posts (kind log, which no bot posts itself), and their own posts held for their approval; the mark is a time and, from the second read on, the last item's id, so rows in that item's millisecond still wait; each list reads at most limit rows, and when one comes back full both stop at the earlier full list's last row, so the next mark skips no row either list left out.
export const waiting = async (
  db: Database,
  caller: Caller,
  { after, limit = 100, since }: { after?: string; limit?: number; since: string },
): Promise<Waiting[]> => {
  const from = new Date(since)
  const id = sql`${yardMessage.id} collate "C"`
  const past = after
    ? sql`(${shownAt}, ${id}) > (${from}, ${after} collate "C")`
    : sql`${shownAt} > ${from}`
  const mentions = await db
    .select({ message: yardMessage, shownAt })
    .from(yardMessage)
    .innerJoin(
      yardMember,
      and(eq(yardMember.channelId, yardMessage.channelId), eq(yardMember.userId, caller.id)),
    )
    .where(
      and(
        eq(yardMessage.status, "sent"),
        sql`${yardMessage.userId} is distinct from ${caller.id}`,
        past,
        sql`${shownAt} > ${yardMember.joinedAt}`,
        or(
          sql`${yardMessage.text} ~* ${mentionPattern(caller.login)}`,
          sql`${yardMessage.kind} <> 'log' and exists (select 1 from ${yardBot} where ${yardBot.userId} = ${yardMessage.userId} and ${yardBot.madeBy} = ${caller.id})`,
        ),
        live(),
      ),
    )
    .orderBy(shownAt, id)
    .limit(limit)
  const held = await db
    .select({ message: yardMessage, shownAt })
    .from(yardMessage)
    .where(and(eq(yardMessage.userId, caller.id), eq(yardMessage.status, "pending"), past, live()))
    .orderBy(shownAt, id)
    .limit(limit)
  const at = (row: { shownAt: string | Date }) => new Date(row.shownAt).toISOString()
  const key = (item: Waiting) => `${item.shownAt} ${item.message.id}`
  const items = (rows: typeof held, isHeld: boolean): Waiting[] =>
    rows.map((row) => ({ held: isHeld, message: toMessage(row.message), shownAt: at(row) }))
  const lists = [items(held, true), items(mentions, false)]
  const cut = lists
    .filter((list) => list.length === limit)
    .map((list) => key(list.at(-1)!))
    .sort()[0]
  return lists
    .flat()
    .filter((item) => !cut || key(item) <= cut)
    .sort((a, b) => (key(a) < key(b) ? -1 : 1))
}

// The owner's #i6 limits: a login posts once a second and 200 times a day, and a channel takes 60 posts an hour.
export const POST_LIMITS = { channelHour: 60, loginDay: 200, loginSecond: 1 } as const

// What one channel kind checks before a post: whether the caller may post there, and what decides a token's hold. A later kind (a self channel) adds its own.
const POST_RULES: Record<
  YardChannel["kind"],
  (db: Database, caller: Caller, channel: YardChannel) => Promise<{ firstInDm: boolean }>
> = {
  channel: async (_db, caller, channel) => {
    if (channel.postRule === "owner" && !caller.owner)
      throw new ApiError(403, "FORBIDDEN", `Only the owner posts in #${channel.name}`)
    return { firstInDm: false }
  },
  // A token's post waits while the DM has no sent message, so a held or denied opener lets nothing through after it; the DM bot add made between a bot and its maker is one the maker chose to open, so the maker's first post there sends.
  dm: async (db, caller, channel) => {
    const [sent, made] = await Promise.all([
      db
        .select({ id: yardMessage.id })
        .from(yardMessage)
        .where(and(eq(yardMessage.channelId, channel.id), eq(yardMessage.status, "sent"), live()))
        .limit(1),
      db
        .select({ id: yardBot.userId })
        .from(yardMember)
        .innerJoin(yardBot, eq(yardBot.userId, yardMember.userId))
        .where(and(eq(yardMember.channelId, channel.id), eq(yardBot.madeBy, caller.id)))
        .limit(1),
    ])
    return { firstInDm: sent.length === 0 && made.length === 0 }
  },
}

export const post = async (
  db: Database,
  caller: Caller,
  channelId: string,
  body: { kind: Message["kind"]; links?: string[]; parent?: string; text: string },
  limits: Record<keyof typeof POST_LIMITS, number> = POST_LIMITS,
): Promise<Message> => {
  await fenceBot(db, caller, channelId)
  // a bot has no browser to approve a held post, so it posts only what no rule holds: no held kind, mention or link
  if (
    caller.bot &&
    ((HELD_KINDS as readonly string[]).includes(body.kind) ||
      mentionsOf(body.text).length > 0 ||
      body.links?.length)
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "A bot posts plain text alone: no held kind, mention or link",
    )
  const channel = await memberOf(db, caller, channelId)
  const { firstInDm } = await POST_RULES[channel.kind](db, caller, channel)
  if (body.parent) {
    // a thread past retention is gone, so a reply cannot bring it back before the sweep removes it
    const [parent] = await db
      .select({ channelId: yardMessage.channelId, parentId: yardMessage.parentId })
      .from(yardMessage)
      .where(and(eq(yardMessage.id, body.parent), live()))
    if (parent?.channelId !== channelId) throw notFound("Parent message")
    // Threads are one level deep, a first message and its replies, so retention reads a thread's newest message in one step.
    if (parent.parentId)
      throw new ApiError(400, "BAD_REQUEST", "Reply to the thread's first message")
  }
  await take(db, `post:${caller.login}`, "second", limits.loginSecond)
  await take(db, `post:${caller.login}`, "day", limits.loginDay)
  await take(db, `channel:${channelId}`, "hour", limits.channelHour)
  const held = caller.bot
    ? null
    : heldBecause({ ...body, firstInDm, postRule: channel.postRule, via: caller.via })
  const [row] = await db
    .insert(yardMessage)
    .values({
      // the app's clock in milliseconds, as the API answers it, so reading up to a message's own time clears it; the column's default keeps microseconds
      at: new Date(),
      channelId,
      device: caller.device,
      kind: body.kind,
      links: body.links,
      login: caller.login,
      parentId: body.parent,
      status: held ? "pending" : "sent",
      text: body.text,
      userId: caller.id,
    })
    .returning()
  return toMessage(row!)
}

export const markRead = async (db: Database, caller: Caller, channelId: string, at?: string) => {
  await memberOf(db, caller, channelId)
  const now = new Date()
  const lastReadAt = at && new Date(at) < now ? new Date(at) : now
  await db
    .update(yardMember)
    .set({ lastReadAt })
    .where(and(eq(yardMember.channelId, channelId), eq(yardMember.userId, caller.id)))
  return { lastReadAt: lastReadAt.toISOString() }
}

// One of the caller's own messages; anyone else's reads as missing.
export const ownMessage = async (db: Database, caller: Caller, id: string): Promise<Message> => {
  const [row] = await db
    .select()
    .from(yardMessage)
    .where(and(eq(yardMessage.id, id), eq(yardMessage.userId, caller.id), live()))
  if (!row) throw notFound("Message")
  return toMessage(row)
}

// Sends or denies one of the caller's pending messages, stamping decided_at, and on send moving its time to the send, so a member who read the channel meanwhile counts it as unread; a message already decided is a conflict.
export const decide = async (
  db: Database,
  caller: Caller,
  id: string,
  status: "denied" | "sent",
): Promise<Message> => {
  const now = new Date()
  const [row] = await db
    .update(yardMessage)
    .set(status === "sent" ? { at: now, decidedAt: now, status } : { decidedAt: now, status })
    .where(
      and(
        eq(yardMessage.id, id),
        eq(yardMessage.userId, caller.id),
        eq(yardMessage.status, "pending"),
        live(),
      ),
    )
    .returning()
  if (row) return toMessage(row)
  const existing = await ownMessage(db, caller, id)
  throw new ApiError(409, "CONFLICT", `The message is already ${existing.status}`)
}

const tokenOut = (row: typeof yardToken.$inferSelect) => ({
  createdAt: row.createdAt.toISOString(),
  id: row.id,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  name: row.name,
  revokedAt: row.revokedAt?.toISOString() ?? null,
})

export const tokens = async (db: Database, caller: Caller) =>
  (
    await db
      .select()
      .from(yardToken)
      .where(eq(yardToken.userId, caller.id))
      .orderBy(asc(yardToken.name))
  ).map(tokenOut)

// A new token: its secret, its prefix and 32 random characters, is returned this once and kept only as its hash.
const mintToken = async (
  db: Database,
  caller: Caller,
  name: string,
  prefix: string,
  now: number,
) => {
  tokenNameSchema.parse(name)
  await take(db, `writes:${caller.id}`, "hour", WRITES_HOUR, now)
  const value = secret(prefix)
  try {
    const [row] = await db
      .insert(yardToken)
      .values({ hash: hashOf(value), name, userId: caller.id })
      .returning()
    return { ...tokenOut(row!), secret: value }
  } catch (error) {
    if (taken(error)) throw new ApiError(409, "CONFLICT", `A token named ${name} exists`)
    throw error
  }
}

export const createToken = (db: Database, caller: Caller, name: string, now = Date.now()) =>
  mintToken(db, caller, name, "yard_", now)

// A relay-on token, a Mac's one token with its Relay switch on: it reads and posts as its member does, and the owner's alone holds the relay (relayRouter's socket).
export const createRelayToken = (db: Database, caller: Caller, name: string, now = Date.now()) =>
  mintToken(db, caller, name, "yard_relay_", now)

export const revokeToken = async (db: Database, caller: Caller, id: string) => {
  const [row] = await db
    .update(yardToken)
    .set({ revokedAt: sql`coalesce(${yardToken.revokedAt}, now())` })
    .where(and(eq(yardToken.id, id), eq(yardToken.userId, caller.id)))
    .returning()
  if (!row) throw notFound("Token")
  return tokenOut(row)
}

// A token's swap of itself, in place: its row takes next's hash, keeping its name, its member and so its kind, which next must share (sameKind), and makes no other token; old's next call reads 401. A swap counts on the member's token writes.
export const swapToken = async (
  db: Database,
  caller: Caller,
  old: string,
  next: string,
  now = Date.now(),
) => {
  if (!sameKind(old, next))
    throw new ApiError(400, "BAD_REQUEST", "A token swaps for a new one of its own kind")
  await take(db, `writes:${caller.id}`, "hour", WRITES_HOUR, now)
  try {
    const [row] = await db
      .update(yardToken)
      .set({ hash: hashOf(next) })
      .where(
        and(
          eq(yardToken.hash, hashOf(old)),
          eq(yardToken.userId, caller.id),
          isNull(yardToken.revokedAt),
        ),
      )
      .returning()
    if (!row) throw new ApiError(401, "UNAUTHORIZED", "Unauthorized")
    return tokenOut(row)
  } catch (error) {
    if (taken(error)) throw new ApiError(409, "CONFLICT", "That secret is taken")
    throw error
  }
}

// The member a token names, when it is live, stamping its last use, with the bot row when its user is a bot, and whether it is relay-on.
export const tokenOwner = async (db: Database, value: string) => {
  const [row] = await db
    .select({ bot: yardBot, name: yardToken.name, tokenId: yardToken.id, user })
    .from(yardToken)
    .innerJoin(user, eq(user.id, yardToken.userId))
    .leftJoin(yardBot, eq(yardBot.userId, yardToken.userId))
    .where(and(eq(yardToken.hash, hashOf(value)), isNull(yardToken.revokedAt)))
  if (!row) return null
  await db.update(yardToken).set({ lastUsedAt: new Date() }).where(eq(yardToken.id, row.tokenId))
  return {
    bot: row.bot ? { madeBy: row.bot.madeBy, readsLog: row.bot.readsLog } : null,
    device: row.name,
    relay: isRelayToken(value),
    user: row.user,
  }
}

// The device a bot's one token names on its posts.
export const BOT_DEVICE = "bot"

type BotRow = { createdAt: Date; id: string; name: string; readsLog: boolean }

const botOut = (row: BotRow, dm: string | undefined) => ({
  createdAt: row.createdAt.toISOString(),
  dm: dm ?? "",
  login: botLogin(row.name),
  name: row.name,
  readsLog: row.readsLog,
})

// The bots the caller made, A to Z by name, each with its DM's id, which the bot reads and posts in.
export const bots = async (db: Database, caller: Caller) => {
  const rows = await db
    .select({
      createdAt: yardBot.createdAt,
      id: user.id,
      name: user.name,
      readsLog: yardBot.readsLog,
    })
    .from(yardBot)
    .innerJoin(user, eq(user.id, yardBot.userId))
    .where(eq(yardBot.madeBy, caller.id))
    .orderBy(asc(user.name))
  const names = rows.map((row) => dmName(row.id, caller.id))
  const dms = names.length
    ? await db
        .select({ id: yardChannel.id, name: yardChannel.name })
        .from(yardChannel)
        .where(inArray(yardChannel.name, names))
    : []
  return rows.map((row) => botOut(row, dms.find((dm) => dm.name === dmName(row.id, caller.id))?.id))
}

// A bot the owner makes: its own user, on the member rung with a login no GitHub sign-in can claim (botLogin), its DM with its maker, its one token, whose secret is returned this once and kept only as its hash, and with log, the owner's leave to read the dispatcher's log.
export const createBot = async (
  db: Database,
  caller: Caller,
  name: string,
  { log = false }: { log?: boolean } = {},
) => {
  botNameSchema.parse(name)
  await take(db, `writes:${caller.id}`, "hour", WRITES_HOUR)
  const id = crypto.randomUUID()
  const dm = crypto.randomUUID()
  const value = secret("yard_")
  let row: BotRow
  try {
    row = await db.transaction(async (tx) => {
      const now = new Date()
      await tx.insert(user).values({
        email: `${id}@bot.yard.invalid`,
        id,
        login: botLogin(name),
        name,
        role: "member",
        roleSetAt: now,
      })
      const [bot] = await tx
        .insert(yardBot)
        .values({ madeBy: caller.id, readsLog: log, userId: id })
        .returning()
      await tx.insert(yardToken).values({ hash: hashOf(value), name: BOT_DEVICE, userId: id })
      await tx.insert(yardChannel).values({ id: dm, kind: "dm", name: dmName(id, caller.id) })
      await tx
        .insert(yardMember)
        .values([id, caller.id].map((userId) => ({ channelId: dm, userId })))
      return { createdAt: bot!.createdAt, id, name, readsLog: bot!.readsLog }
    })
  } catch (error) {
    if (taken(error)) throw new ApiError(409, "CONFLICT", `A bot named ${name} exists`)
    throw error
  }
  return { bot: botOut(row, dm), secret: value }
}

// Revokes a bot the caller made: its user goes, with its token, its bot row and its DM, so its next call reads 401 and nothing it said stays behind.
export const revokeBot = async (db: Database, caller: Caller, name: string) => {
  const [row] = await db
    .select({
      createdAt: yardBot.createdAt,
      id: user.id,
      name: user.name,
      readsLog: yardBot.readsLog,
    })
    .from(yardBot)
    .innerJoin(user, eq(user.id, yardBot.userId))
    .where(and(eq(yardBot.madeBy, caller.id), eq(user.login, botLogin(name))))
  if (!row) throw notFound("Bot")
  const [dm] = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(yardChannel)
      .where(eq(yardChannel.name, dmName(row.id, caller.id)))
      .returning({ id: yardChannel.id })
    await tx.delete(user).where(eq(user.id, row.id))
    return gone
  })
  return botOut(row, dm?.id)
}

// The Account page's log switch: whether a bot the caller made may read the dispatcher's log, from its next read.
export const setReadsLog = async (
  db: Database,
  caller: Caller,
  name: string,
  readsLog: boolean,
) => {
  const [found] = await db
    .select({ id: user.id })
    .from(yardBot)
    .innerJoin(user, eq(user.id, yardBot.userId))
    .where(and(eq(yardBot.madeBy, caller.id), eq(user.login, botLogin(name))))
  if (!found) throw notFound("Bot")
  await db.update(yardBot).set({ readsLog }).where(eq(yardBot.userId, found.id))
  return (await bots(db, caller)).find((bot) => bot.name === name)!
}

// A bot's one DM, with the owner who made it, found from its token alone.
export const botDm = async (
  db: Database,
  caller: Caller & { bot: { madeBy: string } },
): Promise<string> => {
  const [dm] = await db
    .select({ id: yardChannel.id })
    .from(yardChannel)
    .where(eq(yardChannel.name, dmName(caller.id, caller.bot.madeBy)))
  if (!dm) throw notFound("Bot")
  return dm.id
}

// A bot's read of the log reaches its maker's Mac: the maker's login, which the Mac checks against its own token's, and the bot's DM, where the read's line goes.
export const logReadOf = async (db: Database, caller: Caller & { bot: { madeBy: string } }) => {
  await take(db, `logread:${caller.id}`, "hour", CALL_LIMITS.logReadHour)
  const [maker] = await db
    .select({ login: user.login })
    .from(user)
    .where(eq(user.id, caller.bot.madeBy))
  if (!maker?.login) throw notFound("Bot")
  return { dm: await botDm(db, caller), login: maker.login }
}

// The line a read of the log leaves in the bot's DM, as the bot's, kind log, so its maker sees each read and the Inbox cards none (waiting).
export const logLine = async (
  db: Database,
  caller: Caller,
  dm: string,
  text: string,
): Promise<Message> => {
  const [row] = await db
    .insert(yardMessage)
    .values({
      at: new Date(),
      channelId: dm,
      device: caller.device,
      kind: "log",
      login: caller.login,
      status: "sent",
      text,
      userId: caller.id,
    })
    .returning()
  return toMessage(row!)
}

const inviteOut = (row: typeof yardInvite.$inferSelect, requestedBy: string | null) => ({
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  forLogin: row.forLogin,
  id: row.id,
  requestedBy: requestedBy ? { login: requestedBy } : null,
  status: row.status,
})

const inviteCode = (): string =>
  randomBytes(9)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "X")
    .slice(0, 12)
    .replace(/(.{4})(?=.)/g, "$1-")

const DAY_MS = 86_400_000

// How long an invite stays open when its maker names no other span, and when the owner opens a request.
const INVITE_DAYS = 7

// The owner sees every invite; a member sees the requests they made.
export const invites = async (db: Database, caller: Caller) => {
  const rows = await db
    .select({ invite: yardInvite, requester: user.login })
    .from(yardInvite)
    .leftJoin(user, eq(user.id, yardInvite.requestedBy))
    .where(caller.owner ? undefined : eq(yardInvite.requestedBy, caller.id))
    .orderBy(desc(yardInvite.createdAt))
  return rows.map(({ invite, requester }) => inviteOut(invite, requester))
}

export const createInvite = async (
  db: Database,
  caller: Caller,
  { expiresInDays = INVITE_DAYS, forLogin }: { expiresInDays?: number; forLogin?: string },
) => {
  await take(db, `writes:${caller.id}`, "hour", WRITES_HOUR)
  const code = inviteCode()
  const [row] = await db
    .insert(yardInvite)
    .values({
      codeHash: hashOf(code),
      expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
      forLogin: forLogin?.toLowerCase(),
      madeBy: caller.id,
      status: "open",
    })
    .returning()
  return { ...inviteOut(row!, null), code }
}

export const requestInvite = async (db: Database, caller: Caller, forLogin: string) => {
  await take(db, `writes:${caller.id}`, "hour", WRITES_HOUR)
  const [row] = await db
    .insert(yardInvite)
    .values({ forLogin: forLogin.toLowerCase(), requestedBy: caller.id, status: "requested" })
    .returning()
  return inviteOut(row!, caller.login)
}

// The owner opens a member's request, which mints its code, or revokes a request or an open invite.
export const decideInvite = async (
  db: Database,
  caller: Caller,
  id: string,
  action: "approve" | "deny",
) => {
  const code = action === "approve" ? inviteCode() : null
  const [row] = await db
    .update(yardInvite)
    .set(
      code
        ? {
            codeHash: hashOf(code),
            expiresAt: new Date(Date.now() + INVITE_DAYS * DAY_MS),
            madeBy: caller.id,
            status: "open",
          }
        : { status: "revoked" },
    )
    .where(
      and(
        eq(yardInvite.id, id),
        inArray(yardInvite.status, action === "approve" ? ["requested"] : ["open", "requested"]),
      ),
    )
    .returning()
  if (!row) {
    const [existing] = await db.select().from(yardInvite).where(eq(yardInvite.id, id))
    if (!existing) throw notFound("Invite")
    throw new ApiError(409, "CONFLICT", `The invite is already ${existing.status}`)
  }
  const [requester] = row.requestedBy
    ? await db.select({ login: user.login }).from(user).where(eq(user.id, row.requestedBy))
    : []
  return { ...inviteOut(row, requester?.login ?? null), ...(code ? { code } : {}) }
}

// Redeems an open, unexpired invite meant for the caller (or for anyone): the caller takes the member rung, unless already above it, and joins #general and #releases.
export const redeemInvite = async (db: Database, caller: Caller, code: string) => {
  await take(db, `redeem:${caller.id}`, "hour", CALL_LIMITS.redeemHour)
  const now = new Date()
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(yardInvite)
      .set({ redeemedAt: now, redeemedBy: caller.id, status: "redeemed" })
      .where(
        and(
          eq(yardInvite.codeHash, hashOf(code.trim().toUpperCase())),
          eq(yardInvite.status, "open"),
          or(isNull(yardInvite.expiresAt), sql`${yardInvite.expiresAt} > ${now}`),
          or(isNull(yardInvite.forLogin), eq(yardInvite.forLogin, caller.login.toLowerCase())),
        ),
      )
      .returning()
    if (!row) throw new ApiError(404, "NOT_FOUND", "No open invite matches that code")
    await tx
      .update(user)
      .set({ role: "member", roleSetAt: now })
      .where(and(eq(user.id, caller.id), or(isNull(user.role), eq(user.role, "user"))))
    await joinOwnChannels(tx, caller.id)
  })
  return { member: true as const }
}

// Who a message's frame reaches: every member of its channel who still holds the member rung once it is sent, so a banned member's open socket hears nothing, and its sender alone while it is pending or denied.
export const audienceOf = async (db: Database, caller: Caller, message: Message) =>
  message.status === "sent"
    ? (
        await db
          .select({ banned: user.banned, id: user.id, role: user.role })
          .from(yardMember)
          .innerJoin(user, eq(user.id, yardMember.userId))
          .where(eq(yardMember.channelId, message.channel))
      )
        .filter((row) => reachesConsole(row, "member"))
        .map((row) => row.id)
    : [caller.id]
