import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  customType,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { jsonb } from "@/columns"
import { thread } from "@/schema/thread"

// Every Claude Code session on this machine, read from its transcript under ~/.claude/projects, and every Codex session, read from its rollout under ~/.codex/sessions, so the dashboard can list past sessions and show full logs after Claude Code's 30-day cleanup deletes the files. These rows hold secrets and customer data: they belong only in the dashboard's local Postgres, never a shared database. Named claude_* because Better Auth already owns `session`.

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" })

// One row per session id, or per agent id for a subagent. Whether a session is live is not stored: the dashboard reads that from ~/.claude/sessions and herdr at request time.
export const claudeSession = pgTable(
  "claude_session",
  {
    agentType: text("agent_type"),
    aiTitle: text("ai_title"),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).default(0).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
    // Claude Code writes a cost only when a process exits, so this is null while a session has never exited.
    costUsd: numeric("cost_usd", { mode: "number" }),
    // Claude Code's running cost total keyed by the startTime it reports (a resumed session continues the same key), so the cost is the highest per key.
    costs: jsonb("costs").$type<Record<string, number>>().default({}).notNull(),
    cwd: text("cwd"),
    description: text("description"),
    entryCount: integer("entry_count").default(0).notNull(),
    gitBranch: text("git_branch"),
    // The harness that ran the session, a HarnessId of HARNESSES in packages/settings/src/harnesses.ts; every session stored before Codex's rollouts were read is Claude Code's.
    harness: text("harness").default("claude-code").notNull(),
    id: text("id").primaryKey(),
    inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
    // interactive, headless, subagent or fork; null for a session known only as another's parent, whose transcript was never read.
    kind: text("kind"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    model: text("model"),
    name: text("name"),
    outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
    // The session or subagent that started this one, or whose scratchpad a headless run was launched from. Provenance only: a row outlives its parent's.
    parentId: text("parent_id").references((): AnyPgColumn => claudeSession.id, {
      onDelete: "set null",
    }),
    prUrls: text("pr_urls")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    projectDir: text("project_dir"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    task: text("task"),
    version: text("version"),
  },
  (table) => [
    index("claude_session_last_active_at_idx").on(table.lastActiveAt.desc()),
    index("claude_session_parent_id_idx").on(table.parentId),
  ],
)

// One row per transcript line that has a uuid, in file order by seq (the line's byte offset), which a tagged line holds as -1 - seq while a reset read has not reached it (ingestFile in api/hono/src/lib/sessions/ingest.ts). raw is the line itself, minus base64 media, thinking signatures and the toolUseResult that repeats the tool result.
export const claudeEntry = pgTable(
  "claude_entry",
  {
    at: timestamp("at", { withTimezone: true }),
    // An assistant line's usage so far: each content block of a message is its own line, input and cache counts repeat and output grows, so a total takes each message_id's last line (highest seq). Null on other lines.
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    // human, peer, prompt, assistant, thinking, tool, result, system, attachment or meta.
    kind: text("kind").notNull(),
    messageId: text("message_id"),
    model: text("model"),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    parentUuid: text("parent_uuid"),
    raw: jsonb("raw").notNull(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, left("text", 100000))`,
    ),
    sender: text("sender"),
    seq: bigint("seq", { mode: "number" }).notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => claudeSession.id, { onDelete: "cascade" }),
    text: text("text").default("").notNull(),
    // The thread the line was routed to, at most one, and its place there, read only beside thread_id; a deleted thread clears thread_id alone.
    threadId: text("thread_id").references(() => thread.id, { onDelete: "set null" }),
    threadSeq: integer("thread_seq"),
    tool: text("tool"),
    toolUseId: text("tool_use_id"),
    type: text("type").notNull(),
    uuid: text("uuid").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.uuid] }),
    index("claude_entry_search_idx").using("gin", table.search),
    // The token recount's index: its migration adds INCLUDE (at and the four token counts) by hand, since drizzle 0.45 cannot declare one, so the recount reads this index alone. seq is NULLS FIRST to match the recount's plain `seq desc`, so its distinct on reads the index's order with no sort.
    index("claude_entry_session_id_message_id_seq_idx").on(
      table.sessionId,
      table.messageId,
      table.seq.desc().nullsFirst(),
    ),
    index("claude_entry_session_id_seq_idx").on(table.sessionId, table.seq),
    uniqueIndex("claude_entry_thread_id_thread_seq_idx")
      .on(table.threadId, table.threadSeq)
      .where(sql`${table.threadId} is not null`),
  ],
)

// How far the importer has read each transcript file. A changed inode or a file shorter than byte_offset is read again from 0.
export const claudeTranscript = pgTable(
  "claude_transcript",
  {
    byteOffset: bigint("byte_offset", { mode: "number" }).default(0).notNull(),
    dev: bigint("dev", { mode: "number" }).notNull(),
    ino: bigint("ino", { mode: "number" }).notNull(),
    path: text("path").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => claudeSession.id, { onDelete: "cascade" }),
    size: bigint("size", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("claude_transcript_session_id_idx").on(table.sessionId)],
)

// The removed AI Summary's speaker notes, one row per session: nothing reads or writes it now, and dropping it is a breaking change that waits for the owner's go. Its words came from the transcript, so it stays in the dashboard's local Postgres with the rows above.
export const claudeSummary = pgTable("claude_summary", {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // The last call's token counts, so a glance at the table shows what the summaries weigh.
  inputTokens: integer("input_tokens").default(0).notNull(),
  model: text("model").notNull(),
  outputTokens: integer("output_tokens").default(0).notNull(),
  // The transcript's byte offset summarised so far: the end of the newest finished turn the summary covers.
  readTo: bigint("read_to", { mode: "number" }).default(0).notNull(),
  sessionId: text("session_id").notNull().unique(),
  summary: jsonb("summary")
    .$type<{ changedAt?: string; markdown: string; status: string }>()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})
