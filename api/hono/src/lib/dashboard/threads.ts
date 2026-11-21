import { ID_ALPHABET } from "@packages/config/kinds"
import {
  markerOf,
  THREAD_ID,
  THREADS_PER_PAGE,
  type Thread,
  type ThreadPatch,
  type ThreadsPage,
} from "@packages/config/threads"
import type { Database, Transaction } from "@packages/db"
import { claudeEntry, thread } from "@packages/db"
import { and, asc, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm"

import {
  currentSource,
  type DashboardSource,
  ensureFixture,
  readFixtureMachine,
} from "@/lib/dashboard/fixture"
import { imageSources, parseLine, type Entry } from "@/lib/dashboard/transcript"

// The owner's threads in the dashboard's database: a page of the open ones with each one's unread count, and the one write a thread takes from the dashboard.

const iso = (at: Date | null): string | null => (at ? at.toISOString() : null)

// Correlated subqueries name both tables in full: a single-table select strips drizzle's table names, so a bare column would bind to whichever table has it.
// Its tagged lines someone else wrote, a meta line left out as the view leaves it, stamped after lastReadAt, every one while it is null: the thread view's Unread (threadSections in web/next/src/lib/threads.ts).
export const unread = sql<number>`(select count(*)::int from "claude_entry" where "claude_entry"."thread_id" = "thread"."id" and "claude_entry"."kind" not in ('human', 'meta') and ("thread"."last_read_at" is null or "claude_entry"."at" > "thread"."last_read_at"))`

// Pinned first with the newest pin on top, then the newest updatedAt, id breaking a tie.
export const threadOrder = [
  sql`${thread.pinnedAt} is null`,
  desc(thread.pinnedAt),
  desc(thread.updatedAt),
  asc(thread.id),
]

const firstMessageId = sql<
  string | null
>`(select "claude_entry"."uuid" from "claude_entry" where "claude_entry"."thread_id" = "thread"."id" order by "claude_entry"."thread_seq" limit 1)`

const columns = {
  archivedAt: thread.archivedAt,
  createdAt: thread.createdAt,
  firstMessageId,
  id: thread.id,
  lastReadAt: thread.lastReadAt,
  pinnedAt: thread.pinnedAt,
  title: thread.title,
  unread,
  updatedAt: thread.updatedAt,
}

type Row = {
  archivedAt: Date | null
  createdAt: Date
  firstMessageId: string | null
  id: string
  lastReadAt: Date | null
  pinnedAt: Date | null
  title: string
  unread: number
  updatedAt: Date
}

const toThread = (row: Row): Thread => ({
  archivedAt: iso(row.archivedAt),
  createdAt: row.createdAt.toISOString(),
  firstMessageId: row.firstMessageId,
  id: row.id,
  lastReadAt: iso(row.lastReadAt),
  pinnedAt: iso(row.pinnedAt),
  title: row.title,
  unread: row.unread,
  updatedAt: row.updatedAt.toISOString(),
})

// Pinned first, the newest pin on top, then updatedAt newest first, archived ones left out; id breaks a tie so a page never repeats or skips a thread.
export async function listThreads(db: Database, page: number): Promise<ThreadsPage> {
  const open = isNull(thread.archivedAt)
  const [rows, counted] = await Promise.all([
    db
      .select(columns)
      .from(thread)
      .where(open)
      .orderBy(...threadOrder)
      .limit(THREADS_PER_PAGE)
      .offset((page - 1) * THREADS_PER_PAGE),
    db.select({ value: count() }).from(thread).where(open),
  ])
  const total = counted[0]?.value ?? 0
  return {
    threads: rows.map(toThread),
    hasNextPage: page * THREADS_PER_PAGE < total,
    page,
    total,
  }
}

// One thread changed as the body says, each time field set to now or cleared; null when no thread has the id.
export async function patchThread(
  db: Database,
  id: string,
  patch: ThreadPatch,
  now = new Date(),
): Promise<Thread | null> {
  const at = (on: boolean | undefined) => (on === undefined ? undefined : on ? now : null)
  const updated = await db
    .update(thread)
    .set({
      archivedAt: at(patch.archived),
      lastReadAt: at(patch.read),
      pinnedAt: at(patch.pinned),
      title: patch.title,
    })
    .where(eq(thread.id, id))
    .returning({ id: thread.id })
  if (updated.length === 0) return null
  const [row] = await db.select(columns).from(thread).where(eq(thread.id, id))
  return row ? toThread(row) : null
}

// A fixture stack's threads, written by bun run ingest once it has read the fixture's transcripts and by the API's start while the table is empty (seedFixtureThreadsAtStart): each thread missing is added, and each message it names is tagged once read, so a change made from the dashboard stays. Any other source writes nothing, so made-up threads never reach the live dashboard's database.
export async function seedFixtureThreads(
  db: Database,
  source: DashboardSource = currentSource(),
): Promise<number> {
  if (source.kind !== "fixture") return 0
  const threads = readFixtureMachine(ensureFixture(source)).threads ?? []
  if (threads.length === 0) return 0
  const date = (at: string | undefined) => (at ? new Date(at) : null)
  await db
    .insert(thread)
    .values(
      threads.map((t) => ({
        archivedAt: date(t.archivedAt),
        createdAt: new Date(t.createdAt),
        id: t.id,
        lastReadAt: date(t.lastReadAt),
        pinnedAt: date(t.pinnedAt),
        title: t.title,
        updatedAt: new Date(t.updatedAt),
      })),
    )
    .onConflictDoNothing()
  for (const t of threads) {
    for (const [seq, uuid] of t.messages.entries()) {
      await db
        .update(claudeEntry)
        .set({ threadId: t.id, threadSeq: seq + 1 })
        .where(
          and(
            eq(claudeEntry.sessionId, t.session),
            eq(claudeEntry.uuid, uuid),
            isNull(claudeEntry.threadId),
          ),
        )
    }
  }
  return threads.length
}

// A fresh fixture stack's threads from its first load: an empty thread table takes the fixture's threads and says so on one line; a full table and any other source write nothing, so a restart never replays them and made-up rows never reach the live dashboard's database.
export async function seedFixtureThreadsAtStart(db: Database): Promise<number> {
  const source = currentSource()
  if (source.kind !== "fixture") return 0
  const [row] = await db.select({ value: count() }).from(thread)
  if ((row?.value ?? 0) > 0) return 0
  const threads = await seedFixtureThreads(db, source)
  if (threads > 0) console.error(`fixture: ${threads} made-up threads seeded at start`)
  return threads
}

// what a person, a peer or a launch prompt said, as read.ts's FIRST_ASK reads a message, so the session's own reply that opens with the same words is passed over
const MESSAGE_KINDS = ["human", "peer", "prompt"]

// The untagged source lines Claude Code writes after a message it took an image in with, one prompt's beside it, for the rows' prompts: a route tags the message alone.
async function sourceLines(db: Database, rows: { raw: unknown; sessionId: string }[]) {
  const prompts = rows.flatMap((r) => {
    const promptId = (r.raw as { promptId?: unknown } | null)?.promptId
    return typeof promptId === "string" ? [promptId] : []
  })
  if (prompts.length === 0) return []
  const found = await db
    .select({ raw: claudeEntry.raw })
    .from(claudeEntry)
    .where(
      and(
        inArray(claudeEntry.sessionId, [...new Set(rows.map((r) => r.sessionId))]),
        eq(claudeEntry.kind, "meta"),
        isNull(claudeEntry.threadId),
        sql`starts_with(${claudeEntry.text}, '[Image: source: ')`,
        inArray(sql`${claudeEntry.raw}->>'promptId'`, prompts),
      ),
    )
  return found.map((r) => JSON.stringify(r.raw))
}

// One thread with its messages in its own order (threadSeq), each as the chat shows it, an image named by its source line, routed or not; a message row the chat's reader skips (a launch prompt) keeps its words as a message from its sender. Null when no thread has the id.
export async function threadMessages(
  db: Database,
  id: string,
): Promise<{ entries: Entry[]; thread: Thread } | null> {
  const [row] = await db.select(columns).from(thread).where(eq(thread.id, id))
  if (!row) return null
  const rows = await db
    .select({
      at: claudeEntry.at,
      kind: claudeEntry.kind,
      raw: claudeEntry.raw,
      sender: claudeEntry.sender,
      sessionId: claudeEntry.sessionId,
      text: claudeEntry.text,
      uuid: claudeEntry.uuid,
    })
    .from(claudeEntry)
    .where(eq(claudeEntry.threadId, id))
    .orderBy(asc(claudeEntry.threadSeq))
  const lines = rows.map((r) => JSON.stringify(r.raw))
  const images = imageSources([...lines, ...(await sourceLines(db, rows))])
  const entries = rows.flatMap((r, i): Entry[] => {
    const parsed = parseLine(lines[i] ?? "", { images })
    if (parsed.length > 0 || !MESSAGE_KINDS.includes(r.kind)) return parsed
    const kind = r.kind === "human" ? "human" : "peer"
    return [{ at: iso(r.at) ?? "", from: r.sender, id: r.uuid, kind, text: r.text, tool: null }]
  })
  return { entries, thread: toThread(row) }
}

// A random id the contract takes, drawn again until one has a letter.
const newId = (): string => {
  for (;;) {
    const id = Array.from(
      crypto.getRandomValues(new Uint8Array(4)),
      (byte) => ID_ALPHABET[byte % ID_ALPHABET.length],
    ).join("")
    if (THREAD_ID.test(id)) return id
  }
}

// Opens a thread with the title and returns its id; an id already taken inserts nothing, and the next draw tries again.
export async function createThread(db: Database, title: string): Promise<string> {
  for (;;) {
    const [row] = await db
      .insert(thread)
      .values({ id: newId(), title })
      .onConflictDoNothing()
      .returning({ id: thread.id })
    if (row) return row.id
  }
}

// Removes a thread no line has reached, as a new thread whose first message never went.
export async function dropThread(db: Database, id: string): Promise<void> {
  await db.delete(thread).where(eq(thread.id, id))
}

export async function threadExists(db: Database, id: string): Promise<boolean> {
  const [row] = await db.select({ id: thread.id }).from(thread).where(eq(thread.id, id))
  return Boolean(row)
}

// since: a message stamped before it is passed over, so a send never files an older message that opens with the same words before ingest brings its own.
export type Route = { quote: string; session: string; since?: Date; threadId: string }

// Tags one untagged line of the session as the thread's next and bumps the thread's updatedAt to the line's time, the thread's row locked first, so two tags to one thread take its next number in turn; null when the line is tagged already.
async function tag(
  tx: Database | Transaction,
  {
    at,
    session,
    threadId,
    uuid,
  }: { at: Date | null; session: string; threadId: string; uuid: string },
): Promise<{ seq: number; uuid: string } | null> {
  await tx.execute(sql`select 1 from ${thread} where ${thread.id} = ${threadId} for update`)
  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${claudeEntry.threadSeq}), 0) + 1` })
    .from(claudeEntry)
    .where(eq(claudeEntry.threadId, threadId))) as [{ next: number }]
  const tagged = await tx
    .update(claudeEntry)
    .set({ threadId, threadSeq: Number(next) })
    .where(
      and(
        eq(claudeEntry.sessionId, session),
        eq(claudeEntry.uuid, uuid),
        isNull(claudeEntry.threadId),
      ),
    )
    .returning({ uuid: claudeEntry.uuid })
  if (tagged.length === 0) return null
  await tx
    .update(thread)
    .set({
      updatedAt: sql`greatest(${thread.updatedAt}, coalesce(${at?.toISOString() ?? null}::timestamptz, now()))`,
    })
    .where(eq(thread.id, threadId))
  return { seq: Number(next), uuid }
}

// Routes the newest untagged message of the session whose text, past any [Image #n] marks Claude Code puts first, starts with the quote under the thread, as its next; null while ingest has brought none.
export async function routeMessage(
  db: Database,
  { quote, session, since, threadId }: Route,
): Promise<{ seq: number; uuid: string } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${thread} where ${thread.id} = ${threadId} for update`)
    const [entry] = await tx
      .select({ at: claudeEntry.at, uuid: claudeEntry.uuid })
      .from(claudeEntry)
      .where(
        and(
          eq(claudeEntry.sessionId, session),
          isNull(claudeEntry.threadId),
          inArray(claudeEntry.kind, MESSAGE_KINDS),
          sql`starts_with(regexp_replace(${claudeEntry.text}, '^[[:space:]]*(\\[Image #[0-9]+\\][[:space:]]*)*', ''), ${quote})`,
          since ? gte(claudeEntry.at, since) : undefined,
        ),
      )
      .orderBy(sql`${claudeEntry.at} desc nulls last`, desc(claudeEntry.seq))
      .limit(1)
    if (!entry) return null
    return tag(tx, { at: entry.at, session, threadId, uuid: entry.uuid })
  })
}

// the lines a leading marker routes: what routeMessage routes, and the session's own reply
const MARKED_KINDS = [...MESSAGE_KINDS, "assistant"]

// Routes each line of the session that opens with a thread's marker to that thread, as its next in the lines' order, inside the caller's transaction (ingest's, as it stores them); a marker naming no thread and a line already tagged are passed over.
export async function routeMarked(
  tx: Database | Transaction,
  session: string,
  lines: { at: Date | null; kind: string; text: string; uuid: string }[],
): Promise<void> {
  const marked = lines.flatMap((line) => {
    const { id } = markerOf(line.text)
    return id && MARKED_KINDS.includes(line.kind) ? [{ ...line, threadId: id }] : []
  })
  if (marked.length === 0) return
  const known = new Set(
    (
      await tx
        .select({ id: thread.id })
        .from(thread)
        .where(inArray(thread.id, [...new Set(marked.map((line) => line.threadId))]))
    ).map((row) => row.id),
  )
  for (const line of marked) {
    if (known.has(line.threadId))
      await tag(tx, { at: line.at, session, threadId: line.threadId, uuid: line.uuid })
  }
}

// routeMessage tried every pollMs until it routes the message or waitMs has passed, for a message ingest has yet to bring.
export async function fileUnder(
  db: Database,
  route: Route,
  { pollMs = 1000, waitMs = 60_000 }: { pollMs?: number; waitMs?: number } = {},
): Promise<{ seq: number; uuid: string } | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const routed = await routeMessage(db, route)
    if (routed || Date.now() >= deadline) return routed
    await Bun.sleep(pollMs)
  }
}
