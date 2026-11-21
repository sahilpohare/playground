import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { jsonb } from "@/columns"
import { thread } from "@/schema/thread"

// Playground's Inbox: what the factory posts for the owner through bun run ask, a decision to approve, a Slack draft to send or an outcome to read. It lives only in the dashboard's local Postgres on 127.0.0.1. Each column's shape is checked by the zod schemas in api/hono/src/lib/dashboard/inbox.ts, not by a database constraint.
export const inboxItem = pgTable("inbox_item", {
  // What the owner chose, once chosen: { at, choice, editedText? }.
  answer: jsonb("answer"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // How the answer reached the posting session: { at, status, via }, or a failure's code and reason.
  delivery: jsonb("delivery"),
  // The session that posted it, by the name the dashboard shows.
  from: text("from").notNull(),
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // decision, draft or update.
  kind: text("kind").notNull(),
  // When the owner pinned it, or null; pinned cards sort first in their tab.
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  // The kind's own payload: a decision's preview of what Approve does, a draft's recipient and text, an update's outcome and link.
  preview: jsonb("preview").notNull(),
  // The owner's manual place within its tab, a fractional key, or null for today's order; a move writes this one row.
  rank: text("rank"),
  readAt: timestamp("read_at", { withTimezone: true }),
  // Its short id, shown as #i<ref>: a sequence, so it is stable and never reused.
  ref: integer("ref").generatedAlwaysAsIdentity().unique().notNull(),
  // open, approved, cleared, denied, sent, drafted, discarded, provided (a secret ask's value went to its sink) or done.
  status: text("status").notNull(),
  // The thread the item belongs to, if any; unindexed, since nothing reads items by thread yet and the table is small enough for a thread delete to scan it.
  threadId: text("thread_id").references(() => thread.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  // Bumped on every write, which names the version it read, so two writes to one item cannot both land.
  version: integer("version").default(0).notNull(),
})
