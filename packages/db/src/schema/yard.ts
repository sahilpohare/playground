import { MAX_TEXT, MESSAGE_KINDS, MESSAGE_STATUSES } from "@packages/message"
import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { jsonValue } from "@/columns"
import { user } from "@/schema/auth"

// A check that a text column holds one of values, so a value the code adds later (a channel kind) needs a new check, never a new type.
const oneOf = (name: string, column: string, values: readonly string[]) =>
  check(name, sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(", ")})`))

export const CHANNEL_KINDS = ["channel", "dm"] as const
export const INVITE_STATUSES = ["open", "redeemed", "requested", "revoked"] as const
export const POST_RULES = ["members", "owner"] as const

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

// A single-use way in, for one GitHub login or, with for_login null, for whoever redeems it first: a member's request waits as requested, with no code, until the owner's web session makes it open; the code is stored only as its hash; it goes with the account that made, asked for or redeemed it, since a spent or unused way in has no history worth keeping.
export const yardInvite = pgTable(
  "yard_invite",
  {
    id: id(),
    codeHash: text("code_hash").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    forLogin: text("for_login"),
    madeBy: text("made_by").references(() => user.id, { onDelete: "cascade" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedBy: text("redeemed_by").references(() => user.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: INVITE_STATUSES }).notNull(),
  },
  (table) => [
    index("yard_invite_requested_by_idx").on(table.requestedBy),
    oneOf("yard_invite_status_check", "status", INVITE_STATUSES),
  ],
)

// A named channel, or a DM named dm:<user id>:<user id> with the two ids sorted, so both sides open the same one; post_rule owner lets only the owner rung post (#releases).
export const yardChannel = pgTable(
  "yard_channel",
  {
    id: id(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    kind: text("kind", { enum: CHANNEL_KINDS }).notNull(),
    name: text("name").notNull().unique(),
    postRule: text("post_rule", { enum: POST_RULES }).default("members").notNull(),
    topic: text("topic"),
  },
  (table) => [
    check("yard_channel_dm_name_check", sql`(${table.kind} = 'dm') = (${table.name} like 'dm:%')`),
    oneOf("yard_channel_kind_check", "kind", CHANNEL_KINDS),
    oneOf("yard_channel_post_rule_check", "post_rule", POST_RULES),
  ],
)

export const yardMember = pgTable(
  "yard_member",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => yardChannel.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId] }),
    index("yard_member_user_idx").on(table.userId),
  ],
)

// One message as @packages/message shapes it: login and device are its from, kept as text so a removed member's messages stay attributed once user_id goes null; device is the token's name, or web for a post from the browser; parent makes it a reply in a thread; a tier-two post waits as pending, seen by its sender alone, until the sender's web session sends or denies it at decided_at.
export const yardMessage = pgTable(
  "yard_message",
  {
    id: id(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => yardChannel.id, { onDelete: "cascade" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    device: text("device").notNull(),
    kind: text("kind", { enum: MESSAGE_KINDS }).notNull(),
    links: jsonValue("links").$type<string[]>(),
    login: text("login").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => yardMessage.id, {
      onDelete: "cascade",
    }),
    status: text("status", { enum: MESSAGE_STATUSES }).default("sent").notNull(),
    text: text("text").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    oneOf("yard_message_kind_check", "kind", MESSAGE_KINDS),
    oneOf("yard_message_status_check", "status", MESSAGE_STATUSES),
    check(
      "yard_message_text_check",
      sql`char_length(${table.text}) between 1 and ${sql.raw(String(MAX_TEXT))}`,
    ),
    index("yard_message_channel_status_at_idx").on(table.channelId, table.status, table.at),
    index("yard_message_parent_idx").on(table.parentId),
    index("yard_message_user_idx").on(table.userId),
  ],
)

// An API token, stored only as its hash and shown once; revoking sets revoked_at, so a revoked token's next call reads 401; a name is unique per user, so a post's device names one of its sender's tokens.
export const yardToken = pgTable(
  "yard_token",
  {
    id: id(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    hash: text("hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    name: text("name").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("yard_token_user_name_idx").on(table.userId, table.name)],
)

// A user row that is a bot, which its maker (the owner) made with `playground yard bot add`: its token reaches only its DM with made_by, and reads_log lets it read the dispatcher's log; the row goes with its maker while the bot's user and token stay, and a bot's login with no row here reads as no one (yardCaller).
export const yardBot = pgTable(
  "yard_bot",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    madeBy: text("made_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    readsLog: boolean("reads_log").default(false).notNull(),
  },
  (table) => [index("yard_bot_made_by_idx").on(table.madeBy)],
)

// A fixed-window counter: key names what is counted (a login per second or per day, a channel per hour), window_start the window's start.
export const yardRate = pgTable(
  "yard_rate",
  {
    count: integer("count").default(0).notNull(),
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
)
