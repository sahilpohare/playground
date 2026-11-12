import { existsSync, type FSWatcher, watch } from "node:fs"
import { join } from "node:path"

import {
  claudeEntry,
  claudeSession,
  claudeTranscript,
  createDatabase,
  type Database,
  type Transaction,
} from "@packages/db"
import type { HarnessId } from "@packages/settings"
import { Glob } from "bun"
import { and, desc, eq, gte, isNotNull, isNull, lt, ne, sql } from "drizzle-orm"

import { routeMarked } from "@/lib/dashboard/threads"
import {
  addFacts,
  costOf,
  emptyFacts,
  type EntryRow,
  kindOf,
  parentOf,
  parseJson,
  type SessionFacts,
  splitLines,
  type SubagentMeta,
  subagentMeta,
  toEntry,
  type TranscriptFile,
  transcriptFile,
} from "@/lib/sessions/lines"
import { isOwnSession } from "@/lib/sessions/own"
import {
  addRolloutFacts,
  isCompressed,
  isRollout,
  rolloutEntry,
  rolloutFile,
  threadOf,
  rolloutPaths,
} from "@/lib/sessions/rollout"

// The importer: reads each transcript from where it last stopped, and in one transaction per chunk stores its new entries, folds its facts into the session and the chunk into its count and times (token totals are re-totalled at most once a window, and a reset re-read recomputes everything from the stored entries), and moves the file's offset. A crash loses nothing and a re-run adds nothing.

const CHUNK_BYTES = 8 * 1024 * 1024
const INSERT_ROWS = 200
const THROTTLE_MS = 1000
const RESCAN_MS = 30_000
const SUMMARY_MS = 60_000
// Rescans in a row in which every read failed (the database refusing every write, say after a pull whose migration is not applied) before the follower gives up so its runner sees it stop.
const FAILED_RESCANS = 3

// One importer per database: the follower holds this advisory lock for its whole life, so a second copy (another runner, another worktree on the same DB) does nothing.
export const INGEST_LOCK = 0x6c69_6768

// The importer writes through its own client on the URL the guard proved, never the shared `db`.
export const connect = (url: string): Database => createDatabase(url)

// A follower's fence on its client: the backend pid of the connection holding INGEST_LOCK, read as the last statement of each write transaction, so a write after the lock is gone rolls back and onLost is told, and two followers never write at once.
type Fence = { onLost: (why: string) => void; pid: number }
const fences = new WeakMap<Database, Fence>()

export const fence = (db: Database, pid: number, onLost: (why: string) => void) => {
  fences.set(db, { onLost, pid })
}

const requireLock = async (db: Database, tx: Transaction) => {
  const held = fences.get(db)
  if (!held) return
  const [row] = await tx.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from pg_locks
      where pid = ${held.pid} and locktype = 'advisory' and granted
        and classid = 0 and objid = ${INGEST_LOCK} and objsubid = 1
    ) as held
  `)
  if (row?.held) return
  const why = `pid ${held.pid} no longer holds it, so a write rolled back`
  setImmediate(() => held.onLost(why))
  throw new Error(why)
}

type SessionRow = typeof claudeSession.$inferSelect

export type SessionFields = Pick<
  SessionRow,
  | "agentType"
  | "aiTitle"
  | "costUsd"
  | "costs"
  | "cwd"
  | "description"
  | "gitBranch"
  | "id"
  | "kind"
  | "model"
  | "name"
  | "parentId"
  | "prUrls"
  | "projectDir"
  | "task"
  | "version"
>

// What a chunk's facts make of the session row so far. Each chunk folds from empty facts, so what the first lines alone say (the launch directory, the task, the kind and the parent) is kept once known; a later name, title, branch, version or model replaces the earlier one; costs and PRs accumulate. A fork stays a fork, since only its first line says so.
export function mergeSession(
  file: TranscriptFile,
  prev: Partial<SessionFields> | null,
  facts: SessionFacts,
  meta: SubagentMeta | null = null,
): SessionFields {
  const costs = { ...prev?.costs }
  for (const [start, cost] of Object.entries(facts.costs)) {
    costs[start] = Math.max(costs[start] ?? 0, cost)
  }
  const cwd = prev?.cwd ?? facts.cwd
  const kind = file.subagent
    ? prev?.kind === "fork"
      ? "fork"
      : kindOf(file, facts, meta)
    : (prev?.kind ?? kindOf(file, facts))
  return {
    agentType: meta?.agentType ?? prev?.agentType ?? null,
    aiTitle: facts.aiTitle ?? prev?.aiTitle ?? null,
    costUsd: costOf(costs),
    costs,
    cwd,
    description: meta?.description ?? prev?.description ?? null,
    gitBranch: facts.gitBranch ?? prev?.gitBranch ?? null,
    id: file.id,
    kind,
    model: facts.model ?? prev?.model ?? null,
    name: facts.name ?? prev?.name ?? null,
    parentId: meta?.parentAgentId ?? prev?.parentId ?? parentOf(file, { ...facts, cwd }, meta),
    prUrls: [...new Set([...(prev?.prUrls ?? []), ...facts.prUrls])],
    projectDir: prev?.projectDir ?? file.projectDir,
    task: prev?.task ?? facts.task,
    version: facts.version ?? prev?.version ?? null,
  }
}

// Counts, first and last activity, and tokens: each message counted once from its last line (highest seq), since every content block of a message is a line and its output count grows across them.
const recompute = (tx: Transaction, id: string) =>
  tx.execute(sql`
    update claude_session s set
      entry_count = a.entry_count,
      started_at = a.started_at,
      last_active_at = a.last_active_at,
      input_tokens = t.input_tokens,
      output_tokens = t.output_tokens,
      cache_read_tokens = t.cache_read_tokens,
      cache_creation_tokens = t.cache_creation_tokens
    from (
      select
        count(*)::int as entry_count,
        min(at) as started_at,
        max(at) as last_active_at
      from claude_entry
      where session_id = ${id}
    ) a, (
      select
        coalesce(sum(input_tokens), 0) as input_tokens,
        coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
        coalesce(sum(cache_creation_tokens), 0) as cache_creation_tokens
      from (
        select distinct on (message_id) input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
        from claude_entry
        where session_id = ${id} and message_id is not null
        order by message_id, seq desc
      ) m
    ) t
    where s.id = ${id}
  `)

// A session's token totals are re-totalled at most once a window, however many chunks land in it: totalling each message's last stored line reads every entry of the session, from the covering index claude_entry_session_id_message_id_seq_idx alone, and at a 5 s window, before that index, those reads held the live dashboard's Postgres at 424 to 485% CPU in bursts. The reader flushes the sessions still waiting once more when it stops, and a one-shot import before it exits; a reset read recomputes at once.
export const TOKEN_WINDOW_MS = 60_000

type TokenDebounce = {
  chain: Promise<void>
  dirty: Set<string>
  queued: Set<string>
  timers: Map<string, ReturnType<typeof setTimeout>>
  windowMs: number
}
const debounces = new WeakMap<Database, TokenDebounce>()

const debounceOf = (db: Database): TokenDebounce => {
  let state = debounces.get(db)
  if (!state) {
    state = {
      chain: Promise.resolve(),
      dirty: new Set(),
      queued: new Set(),
      timers: new Map(),
      windowMs: TOKEN_WINDOW_MS,
    }
    debounces.set(db, state)
  }
  return state
}

// Tests shorten one database's window, so they wait seconds rather than the live minute.
export const setTokenWindow = (db: Database, ms: number) => {
  debounceOf(db).windowMs = ms
}

// Totals from a fresh read of the stored rows. The session row is locked first, as its own statement: a fire or a flush that waits behind a chunk's transaction then takes its snapshot after that chunk committed, so it never writes an older count over the chunk's.
const recomputeTokens = (db: Database, id: string) =>
  db.transaction(async (tx) => {
    await tx
      .select({ id: claudeSession.id })
      .from(claudeSession)
      .where(eq(claudeSession.id, id))
      .for("update")
    await recompute(tx, id)
    await requireLock(db, tx)
  })

// Each fire queues its recount behind the one before it, one chain a database, so windows that close together send Postgres one session's sort at a time; a session already waiting there is queued once, since its recount reads the rows when it starts, and a recount that throws marks its session again.
const markTokens = (db: Database, id: string) => {
  const state = debounceOf(db)
  if (state.timers.has(id)) return
  state.dirty.add(id)
  state.timers.set(
    id,
    setTimeout(() => {
      state.timers.delete(id)
      if (!state.dirty.delete(id) || state.queued.has(id)) return
      state.queued.add(id)
      state.chain = state.chain
        .then(() => {
          state.queued.delete(id)
          return recomputeTokens(db, id)
        })
        .then(
          () => {},
          () => markTokens(db, id),
        )
    }, state.windowMs),
  )
}

// Recomputes every session whose token totals are waiting on the window, so a one-shot import and a stopping reader leave nothing stale behind.
export const flushTokens = async (db: Database): Promise<void> => {
  const state = debounceOf(db)
  let chain: Promise<void>
  do {
    chain = state.chain
    await chain
  } while (chain !== state.chain)
  if (state.dirty.size === 0) return
  for (const timer of state.timers.values()) clearTimeout(timer)
  const ids = [...state.dirty]
  state.timers.clear()
  state.dirty.clear()
  for (const id of ids) await recomputeTokens(db, id)
}

type Stat = { dev: number; ino: number; size: number }

type Position = { byteOffset: number; size: number }

// A reset read keeps a tagged line's row through its wipe, marked by a negative seq (-1 - seq), so a re-read line takes its new content onto that row, its thread tag untouched, and the read that reaches the file's end deletes the marked rows no line took: a reader stopped part way through a reset leaves them marked, and its next pass carries on from the stored offset.
type Reread = Exclude<keyof EntryRow, "uuid">
const REREAD = Object.keys({
  at: true,
  cacheCreationTokens: true,
  cacheReadTokens: true,
  inputTokens: true,
  kind: true,
  messageId: true,
  model: true,
  outputTokens: true,
  parentUuid: true,
  raw: true,
  sender: true,
  seq: true,
  text: true,
  tool: true,
  toolUseId: true,
  type: true,
} satisfies Record<Reread, true>) as Reread[]
const reread = Object.fromEntries(
  REREAD.map((key) => [key, sql.raw(`excluded."${claudeEntry[key].name}"`)]),
)

async function applyChunk(
  db: Database,
  file: TranscriptFile,
  path: string,
  stat: Stat,
  entries: EntryRow[],
  facts: SessionFacts,
  position: Position,
  meta: SubagentMeta | null,
  reset: boolean,
  harness: HarnessId,
): Promise<{ duplicate: string | null; inserted: number }> {
  return db.transaction(async (tx) => {
    const [prev] = await tx
      .select()
      .from(claudeSession)
      .where(eq(claudeSession.id, file.id))
      .for("update")
    // A re-read from 0 replaces the session's entries and the facts its old lines gave, so a rewritten file's lines take their new places and its first lines name its task again. Two transcript files can carry one session id (a checkout copied to a new folder): the longer file owns the session's rows and its facts, so a read of the shorter one wipes nothing and folds no older name, branch or task in, and the duplicate is reported on every read of it.
    let kept: string | null = null
    const [longer] = await tx
      .select({ path: claudeTranscript.path, size: claudeTranscript.size })
      .from(claudeTranscript)
      .where(and(eq(claudeTranscript.sessionId, file.id), ne(claudeTranscript.path, path)))
      .orderBy(desc(claudeTranscript.size))
      .limit(1)
    if (longer && longer.size > stat.size) kept = longer.path
    const wiping = reset && !kept
    if (wiping) {
      // The delete goes first, so a line tagged while the wipe runs is either deleted untagged or marked tagged.
      await tx
        .delete(claudeEntry)
        .where(and(eq(claudeEntry.sessionId, file.id), isNull(claudeEntry.threadId)))
      await tx
        .update(claudeEntry)
        .set({ seq: sql`-1 - ${claudeEntry.seq}` })
        .where(
          and(
            eq(claudeEntry.sessionId, file.id),
            isNotNull(claudeEntry.threadId),
            gte(claudeEntry.seq, 0),
          ),
        )
    }
    // While a longer transcript owns the session, its facts stand: the shorter copy's older ones do not fold in.
    const row = {
      ...(kept && prev ? prev : mergeSession(file, wiping ? null : (prev ?? null), facts, meta)),
      harness,
    }
    if (row.parentId) {
      await tx.insert(claudeSession).values({ id: row.parentId }).onConflictDoNothing()
    }
    const update: Partial<typeof row> = { ...row }
    delete update.id
    await tx.insert(claudeSession).values(row).onConflictDoUpdate({
      set: update,
      target: claudeSession.id,
    })
    // A chunk folds its own rows into the count and the times instead of recomputing them from every stored entry: both read the chunk alone. The token totals wait for the window above, since totalling a message's last stored line reads every entry of the session from the covering index. A reset read recomputes from the stored entries.
    let inserted = 0
    let updated = 0
    for (let i = 0; i < entries.length; i += INSERT_ROWS) {
      // One statement cannot update a row twice, so a uuid repeated within a batch keeps its first line, as a plain insert would.
      const seen = new Set<string>()
      const batch = entries
        .slice(i, i + INSERT_ROWS)
        .filter((entry) => !seen.has(entry.uuid) && Boolean(seen.add(entry.uuid)))
      const rows = await tx
        .insert(claudeEntry)
        .values(batch.map((entry) => ({ ...entry, sessionId: file.id })))
        .onConflictDoUpdate({
          set: reread,
          setWhere: lt(claudeEntry.seq, 0),
          target: [claudeEntry.sessionId, claudeEntry.uuid],
        })
        .returning({ fresh: sql<boolean>`xmax = 0` })
      const fresh = rows.filter((row) => row.fresh).length
      inserted += fresh
      updated += rows.length - fresh
    }
    // a line that opens with a thread's marker is routed to it as it is stored
    await routeMarked(tx, file.id, entries)
    const times = entries.flatMap((entry) => (entry.at ? [entry.at] : []))
    const startedAt = times.reduce<Date | null>((min, at) => (!min || at < min ? at : min), null)
    const lastActiveAt = times.reduce<Date | null>((max, at) => (!max || at > max ? at : max), null)
    let swept = 0
    if (!kept && position.size === stat.size) {
      const rows = await tx
        .delete(claudeEntry)
        .where(and(eq(claudeEntry.sessionId, file.id), lt(claudeEntry.seq, 0)))
        .returning({ uuid: claudeEntry.uuid })
      swept = rows.length
    }
    if (wiping || swept > 0) {
      await recompute(tx, file.id)
    } else if (inserted > 0 || updated > 0) {
      await tx.execute(sql`
        update claude_session s set
          entry_count = s.entry_count + ${inserted},
          started_at = least(s.started_at, ${startedAt}::timestamptz),
          last_active_at = greatest(s.last_active_at, ${lastActiveAt}::timestamptz)
        where s.id = ${file.id}
      `)
      markTokens(db, file.id)
    }
    const read = { ...position, dev: stat.dev, ino: stat.ino, sessionId: file.id }
    await tx
      .insert(claudeTranscript)
      .values({ ...read, path })
      .onConflictDoUpdate({
        set: { ...read, updatedAt: sql`now()` },
        target: claudeTranscript.path,
      })
    await requireLock(db, tx)
    return { duplicate: kept, inserted }
  })
}

const readMeta = async (path: string) => {
  try {
    return subagentMeta(await Bun.file(path.replace(/\.jsonl$/, ".meta.json")).json())
  } catch {
    return null
  }
}

export type FileResult = { entries: number; id: string; duplicate?: string } | null

// A stop request the readers check between chunks and between files, so a shutdown ends on a committed transaction.
export type Stop = { readonly aborted: boolean }

export type ReadOptions = { chunkBytes?: number; signal?: Stop }

// How a file's lines become rows: a Claude Code transcript's or a Codex rollout's (rollout.ts).
type Format = {
  addFacts: (facts: SessionFacts, line: Record<string, unknown>) => SessionFacts
  harness: HarnessId
  toEntry: (line: Record<string, unknown>, seq: number) => EntryRow | null
}

const TRANSCRIPT: Format = { addFacts, harness: "claude-code", toEntry }
const ROLLOUT: Format = { addFacts: addRolloutFacts, harness: "codex", toEntry: rolloutEntry }

// The bytes of a file's text from start to end: a slice of the file, or of a compressed rollout's whole text.
type Bytes = (start: number, end: number) => Promise<Uint8Array>

const sliceOf =
  (path: string): Bytes =>
  async (start, end) =>
    new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer())

// Reads one transcript from its stored offset to its end in chunks, a line longer than a chunk widening it. Each chunk stores how far into the file it looked (size), so a read cut short after any chunk resumes from its offset on the next pass. A file replaced under the same path (a new inode) or cut shorter than its offset is read again from 0, its old entries and the session's facts from them replaced, and one emptied clears them. A transcript that is not Playground's own (own.ts), a subagent's judged by its parent's, is skipped unread, so another's never reaches the database.
export async function ingestFile(
  db: Database,
  projects: string,
  path: string,
  options: ReadOptions = {},
): Promise<FileResult> {
  const file = transcriptFile(projects, path)
  if (!file || !isOwnSession(file.parentId ?? file.id)) return null
  let stat: Stat
  try {
    stat = await Bun.file(path).stat()
  } catch {
    return null
  }
  const meta = file.subagent ? await readMeta(path) : null
  return readInto(db, file, path, stat, sliceOf(path), TRANSCRIPT, meta, options)
}

// The first line of a file's text, read in growing slices until its newline.
async function firstLine(bytes: Bytes, size: number): Promise<Record<string, unknown> | null> {
  for (let end = Math.min(size, 64 * 1024); ; end = Math.min(size, end * 2)) {
    const { lines } = splitLines(await bytes(0, end), 0)
    if (lines[0]) return parseJson(lines[0].text)
    if (end === size) return null
  }
}

// Reads one Codex rollout as ingestFile reads a transcript, into the session its session_meta line names (threadOf), so a rollout and its compressed copy are one session and a second read adds nothing. A compressed rollout is written once, so it is read whole once per inode, in one chunk: its read row then lands only with all its lines, and a stop or a crash part way leaves none, so the next pass reads it again. A rollout that is not Playground's own is skipped as a transcript is.
export async function ingestRollout(
  db: Database,
  sessions: string,
  path: string,
  options: ReadOptions = {},
): Promise<FileResult> {
  if (!isRollout(sessions, path)) return null
  let stat: Stat
  try {
    stat = await Bun.file(path).stat()
  } catch {
    return null
  }
  const [known] = await db.select().from(claudeTranscript).where(eq(claudeTranscript.path, path))
  const sameInode = known && known.dev === stat.dev && known.ino === stat.ino
  if (sameInode && isCompressed(path)) return { entries: 0, id: known.sessionId }
  let bytes = sliceOf(path)
  let read = options
  if (isCompressed(path)) {
    const text = Bun.zstdDecompressSync(await Bun.file(path).bytes())
    bytes = async (start, end) => text.subarray(start, end)
    stat = { ...stat, size: text.length }
    read = { ...options, chunkBytes: Math.max(1, text.length) }
  }
  const id = (sameInode && known.sessionId) || threadOf((await firstLine(bytes, stat.size)) ?? {})
  if (!id || !isOwnSession(id)) return null
  return readInto(db, rolloutFile(sessions, path, id), path, stat, bytes, ROLLOUT, null, read)
}

async function readInto(
  db: Database,
  file: TranscriptFile,
  path: string,
  stat: Stat,
  bytes: Bytes,
  format: Format,
  meta: SubagentMeta | null,
  { chunkBytes = CHUNK_BYTES, signal }: ReadOptions,
): Promise<FileResult> {
  const [known] = await db.select().from(claudeTranscript).where(eq(claudeTranscript.path, path))
  const same =
    known && known.dev === stat.dev && known.ino === stat.ino && stat.size >= known.byteOffset
  if (same && stat.size === known.size) return { entries: 0, id: file.id }
  let offset = same ? known.byteOffset : 0
  let reset = Boolean(known) && !same
  let chunk = chunkBytes
  let inserted = 0
  let duplicate: string | null = null
  let looked = offset
  const apply = (entries: EntryRow[], facts: SessionFacts, position: Position, again: boolean) =>
    applyChunk(db, file, path, stat, entries, facts, position, meta, again, format.harness)
  while (offset < stat.size && !signal?.aborted) {
    const end = Math.min(stat.size, offset + chunk)
    const { consumed, lines } = splitLines(await bytes(offset, end), offset)
    if (consumed === 0) {
      if (end === stat.size) {
        looked = end
        break
      }
      chunk *= 2
      continue
    }
    let facts = emptyFacts()
    const entries: EntryRow[] = []
    for (const line of lines) {
      const json = parseJson(line.text)
      if (!json) continue
      facts = format.addFacts(facts, json)
      const entry = format.toEntry(json, line.seq)
      if (entry) entries.push(entry)
    }
    const applied = await apply(entries, facts, { byteOffset: offset + consumed, size: end }, reset)
    inserted += applied.inserted
    duplicate ??= applied.duplicate
    reset = false
    offset += consumed
    looked = end
    chunk = chunkBytes
  }
  if (reset && !signal?.aborted) {
    const applied = await apply([], emptyFacts(), { byteOffset: offset, size: looked }, true)
    duplicate ??= applied.duplicate
  } else if (same && looked > known.size) {
    await db.transaction(async (tx) => {
      await tx.update(claudeTranscript).set({ size: looked }).where(eq(claudeTranscript.path, path))
      await requireLock(db, tx)
    })
  }
  return duplicate
    ? { duplicate, entries: inserted, id: file.id }
    : { entries: inserted, id: file.id }
}

// Every transcript under projects: sessions first, so a subagent finds its parent already read. None before Claude Code's first session makes the folder.
export async function transcriptPaths(projects: string): Promise<string[]> {
  if (!existsSync(projects)) return []
  const scan = async (pattern: string) =>
    (await Array.fromAsync(new Glob(pattern).scan({ cwd: projects, onlyFiles: true })))
      .map((rel) => join(projects, rel))
      .sort()
  return [...(await scan("*/*.jsonl")), ...(await scan("*/*/subagents/agent-*.jsonl"))]
}

export type Report = (line: string) => void

export type Pass = {
  duplicates: string[]
  entries: number
  failed: number
  firstError: string | null
  read: number
}

const describe = (path: string, err: unknown) =>
  `${path}: ${err instanceof Error ? err.message : String(err)}`

// One pass over the given transcripts and rollouts (any under sessions, Codex's folder), one at a time, until done or asked to stop. A failure skips that file for this pass and is counted, not logged per file.
export async function readAll(
  db: Database,
  projects: string,
  paths: string[],
  signal?: Stop,
  onRead?: (id: string, entries: number) => void,
  sessions?: string,
): Promise<Pass> {
  const pass: Pass = { duplicates: [], entries: 0, failed: 0, firstError: null, read: 0 }
  for (const path of paths) {
    if (signal?.aborted) break
    pass.read += 1
    try {
      const result =
        sessions && isRollout(sessions, path)
          ? await ingestRollout(db, sessions, path, { signal })
          : await ingestFile(db, projects, path, { signal })
      if (result?.entries) {
        pass.entries += result.entries
        onRead?.(result.id, result.entries)
      }
      if (result?.duplicate) {
        pass.duplicates.push(`session ${result.id}: kept ${result.duplicate} over ${path}`)
      }
    } catch (err) {
      pass.failed += 1
      pass.firstError ??= describe(path, err)
    }
  }
  return pass
}

// Every transcript under projects, then every rollout under sessions when it is given.
const allPaths = async (projects: string, sessions?: string) => [
  ...(await transcriptPaths(projects)),
  ...(sessions ? await rolloutPaths(sessions) : []),
]

export async function backfill(
  db: Database,
  projects: string,
  signal?: Stop,
  sessions?: string,
): Promise<Pass> {
  const pass = await readAll(
    db,
    projects,
    await allPaths(projects, sessions),
    signal,
    undefined,
    sessions,
  )
  await flushTokens(db)
  return pass
}

export type Follower = { stop: () => Promise<void> }

// Keeps the database current: a change under projects reads its file within a second, and at most once a second while it keeps changing; a rescan every 30s catches anything the watcher missed, and reads the rollouts under sessions when it is given. What it read, and any reads that failed, are reported once a minute, so the log stays small; a duplicate transcript is reported once. When every read fails for several rescans in a row it calls giveUp.
export function follow(
  db: Database,
  projects: string,
  report: Report,
  giveUp: (reason: string) => void,
  rescanMs = RESCAN_MS,
  sessions?: string,
): Follower {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const tally = new Map<string, number>()
  const stopper = { aborted: false }
  let failed = 0
  let firstError: string | null = null
  let failedRescans = 0
  let queue: Promise<unknown> = Promise.resolve()
  let rescanning = false
  const seenDuplicates = new Set<string>()
  const count = (id: string, entries: number) => tally.set(id, (tally.get(id) ?? 0) + entries)
  const run = (paths: string[]) => {
    const next = queue.then(async () => {
      const pass = await readAll(db, projects, paths, stopper, count, sessions)
      failed += pass.failed
      firstError ??= pass.firstError
      for (const line of pass.duplicates) {
        if (seenDuplicates.has(line)) continue
        seenDuplicates.add(line)
        report(`duplicate transcript: ${line}`)
      }
      return pass
    })
    queue = next.catch(() => {})
    return next
  }
  const touched = (path: string) => {
    if (stopper.aborted || timers.has(path) || !transcriptFile(projects, path)) return
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path)
        void run([path])
      }, THROTTLE_MS),
    )
  }
  let watcher: FSWatcher | null = null
  const startWatch = () => {
    try {
      watcher = watch(projects, { recursive: true }, (_event, name) => {
        if (name) touched(join(projects, name.toString()))
      })
    } catch (err) {
      report(`watch failed, rescanning only: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // On a Mac where Claude Code has not yet run a session there is no projects folder: wait for it, then watch it and read what it holds
  let waiting: ReturnType<typeof setInterval> | undefined
  if (existsSync(projects)) startWatch()
  else {
    report(`no ${projects} yet; waiting for Claude Code's first session`)
    waiting = setInterval(() => {
      if (stopper.aborted || !existsSync(projects)) return
      clearInterval(waiting)
      startWatch()
      void transcriptPaths(projects).then(run)
    }, THROTTLE_MS)
  }
  const rescan = setInterval(() => {
    if (rescanning || stopper.aborted) return
    rescanning = true
    void allPaths(projects, sessions)
      .then(run)
      .then((pass) => {
        failedRescans = pass.read > 0 && pass.failed === pass.read ? failedRescans + 1 : 0
        if (failedRescans >= FAILED_RESCANS) {
          giveUp(
            `every read failed for ${FAILED_RESCANS} rescans in a row, first: ${pass.firstError}`,
          )
        }
      })
      .catch(() => {})
      .finally(() => {
        rescanning = false
      })
  }, rescanMs)
  const summary = setInterval(() => {
    if (tally.size > 0) {
      const entries = [...tally.values()].reduce((sum, n) => sum + n, 0)
      report(`+${entries} entries in ${tally.size} sessions`)
      tally.clear()
    }
    if (failed > 0) {
      report(`${failed} reads failed, first: ${firstError}`)
      failed = 0
      firstError = null
    }
  }, SUMMARY_MS)
  return {
    stop: async () => {
      stopper.aborted = true
      watcher?.close()
      clearInterval(waiting)
      clearInterval(rescan)
      clearInterval(summary)
      for (const timer of timers.values()) clearTimeout(timer)
      await queue
      await flushTokens(db)
    },
  }
}
