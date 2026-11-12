import { join, sep } from "node:path"

import { claudeEntry, claudeSession, type Database } from "@packages/db"
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm"

import { attachmentsDir } from "@/lib/dashboard/attachments"
import { readsLive } from "@/lib/dashboard/fixture"
import {
  processStarts,
  type Registered,
  registeredSessions,
  sessionsDir,
} from "@/lib/dashboard/peers"
import { commandOf, type Entry, parseLine, typedOf } from "@/lib/dashboard/transcript"
import type { EntryKind, SessionKind } from "@/lib/sessions/lines"
import { claudeDir } from "@/lib/sessions/paths"
import { escapeLike } from "@/lib/sql"

// What the dashboard reads back from the claude_* tables the importer fills: every session, past and present, newest activity first, with whether it is running now from Claude Code's own registry, and any one session's whole log a page at a time.

// Shown text is cut here: a tool's output or a pasted file can run to 256K characters, which the page has no use for.
const SHOWN_TEXT = 8000

// The line of a matching entry a row shows is drawn from its first characters only, so a match is looked for there too.
const SNIPPET_TEXT = 4000

const SNIPPET = 'MaxFragments=1, MaxWords=24, MinWords=8, StartSel="", StopSel=""'

const CHILDREN = 50

// Sessions listed on each side of one in its chain; the Sessions list's name filter shows them all.
const CHAIN = 5

// How much of a session's first ask is read for the handover note it names.
const ASK_TEXT = 4000

const MATCH_CANDIDATES = 5

export type Live = { status: string | null }

// Signal 0 delivers nothing: it only asks whether the pid exists (EPERM means it does, under another user). Asked only when ps cannot be run, and never on a fixture stack, whose pids are not this machine's.
const alive = (pid: number): boolean => {
  if (!readsLive()) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === "EPERM"
  }
}

// Pure: the registered sessions running now, by the board's proof (isLiveRecord in lib/dashboard/workers.ts): the pid's process runs and, where the file gives procStart, started then, which a recycled pid's never did. starts is each running pid's start as ps reads it now, or null when ps could not be run, and then exists alone decides.
export function liveRegistered(
  sessions: Registered[],
  starts: Map<number, string> | null,
  exists: (pid: number) => boolean,
): Map<string, Live> {
  const live = new Map<string, Live>()
  for (const session of sessions) {
    const running =
      starts === null
        ? exists(session.pid)
        : starts.has(session.pid) &&
          (session.procStart === undefined || starts.get(session.pid) === session.procStart)
    if (running) live.set(session.sessionId, { status: session.status ?? null })
  }
  return live
}

// Claude Code writes ~/.claude/sessions/<pid>.json while a session runs and removes it when the session exits; a crash leaves it, and macOS hands its pid to the next process that starts. The .key files beside them are secrets and are never read. Subagents get no file of their own. A fixture stack's ps answers from its fixture's processes, never this machine's.
export async function liveSessions(dir = sessionsDir()): Promise<Map<string, Live>> {
  const sessions = await registeredSessions(dir)
  const starts = await processStarts(sessions.map((session) => session.pid))
  return liveRegistered(sessions, starts, alive)
}

const sessionColumns = {
  agentType: claudeSession.agentType,
  aiTitle: claudeSession.aiTitle,
  costUsd: claudeSession.costUsd,
  cwd: claudeSession.cwd,
  description: claudeSession.description,
  entryCount: claudeSession.entryCount,
  gitBranch: claudeSession.gitBranch,
  id: claudeSession.id,
  kind: claudeSession.kind,
  lastActiveAt: claudeSession.lastActiveAt,
  model: claudeSession.model,
  name: claudeSession.name,
  parentId: claudeSession.parentId,
  startedAt: claudeSession.startedAt,
  task: claudeSession.task,
}

const iso = (at: Date | null) => (at ? at.toISOString() : null)

// Rows imported before a person's slash command was read back hold its tags, so stored text is shown as the command it ran. A stored task kept only its line's first tag: the command's name without its slash, and for some commands (/init) a sentence after it.
const STORED_COMMAND = /^\s*<command-message>([^\s<]+)/

const asCommand = (text: string | null): string | null => {
  if (text === null) return null
  const stored = STORED_COMMAND.exec(text)?.[1]
  return commandOf(text) ?? (stored ? `/${stored}` : text)
}

// A message the dashboard sent with files names each by its path in the attachments folder; stored text drops the folder in the query, before it is cut to what a page shows, so each file shows by its id alone, as the worker view's chips do, and no page prints the machine's own folders, whole or cut short.
const withoutAttachmentsFolder = (text: SQL): SQL<string> =>
  sql<string>`replace(${text}, ${`${attachmentsDir()}${sep}`}, '')`

// A log line that starts with a command's tags, as a Postgres pattern.
const COMMAND_LINE = "^\\s*<command-"

// live is null where the registry cannot tell: a subagent or fork runs inside its parent's process and has no registry file.
const summarize = <
  T extends {
    id: string
    kind: string | null
    lastActiveAt: Date | null
    startedAt: Date | null
    task: string | null
  },
>(
  row: T,
  live: Map<string, Live>,
) => ({
  ...row,
  lastActiveAt: iso(row.lastActiveAt),
  ...(row.kind === "subagent" || row.kind === "fork"
    ? { live: null, status: null }
    : { live: live.has(row.id), status: live.get(row.id)?.status ?? null }),
  startedAt: iso(row.startedAt),
  task: asCommand(row.task),
})

// One tuple feeds the route's enum and the column map, so a sortable column cannot exist in one and not the other.
export const SESSION_SORTS = ["cost", "entries", "lastActive", "started"] as const

const sortColumns = {
  cost: claudeSession.costUsd,
  entries: claudeSession.entryCount,
  lastActive: claudeSession.lastActiveAt,
  started: claudeSession.startedAt,
} satisfies Record<(typeof SESSION_SORTS)[number], unknown>

export type ListInput = {
  dir: "asc" | "desc"
  kinds: SessionKind[]
  names?: string[]
  page: number
  perPage: number
  q?: string
  sort: (typeof SESSION_SORTS)[number]
}

// Correlated subqueries name both tables in full: a bare column inside one would bind to whichever table has it.
const ENTRY_OF_SESSION = sql.raw(`"claude_entry"."session_id" = "claude_session"."id"`)
// A reset read keeps a thread-tagged line it has not reached yet at a negative seq (ingestFile in lib/sessions/ingest.ts), so a log, a search and a first ask leave it out until the read reaches it, as they do every other line it has not reached.
const REACHED = sql.raw(`"claude_entry"."seq" >= 0`)
const reached = gte(claudeEntry.seq, 0)
const SESSION_ID = sql.raw(`"claude_session"."id"`)

// A fixture stack shows only the sessions read from its own fixture's transcripts and rollouts, both inside its config folder: its database may hold rows imported from a live config folder before, and those never reach its pages. Nothing on the live dashboard. `session` is the column holding the session's id, named in full, in the query it joins.
export const shownHere = (session: SQL = SESSION_ID): SQL | undefined =>
  readsLive()
    ? undefined
    : sql`exists (select 1 from "claude_transcript" where "claude_transcript"."session_id" = ${session} and "claude_transcript"."path" like ${`${escapeLike(claudeDir())}/%`})`

// A query matches a session by its name, task, title or the start of its id, or by any word of its log ('simple' parsing, so ids and paths match as written). match is a line of the newest entry whose first characters hold the words, null when none does, so the row falls back to its task.
export async function listSessions(db: Database, input: ListInput, live: Map<string, Live>) {
  const q = input.q?.trim()
  const query = q ? sql`websearch_to_tsquery('simple', ${q})` : null
  const where: SQL[] = [isNotNull(claudeSession.kind)]
  const here = shownHere()
  if (here) where.push(here)
  if (input.kinds.length > 0) where.push(inArray(claudeSession.kind, input.kinds))
  if (input.names?.length) where.push(inArray(claudeSession.name, input.names))
  if (q && query) {
    const like = `%${escapeLike(q)}%`
    where.push(
      or(
        ilike(claudeSession.name, like),
        ilike(claudeSession.task, like),
        ilike(claudeSession.aiTitle, like),
        ilike(claudeSession.id, `${escapeLike(q)}%`),
        sql`exists (select 1 from "claude_entry" where ${ENTRY_OF_SESSION} and ${REACHED} and "claude_entry"."search" @@ ${query})`,
      )!,
    )
  }
  const filter = and(...where)
  // The newest entries holding the words come first off the search index; only those few are checked for the words in the part a line is drawn from, so the cost stays a short index read per row.
  // A person's slash command stored before it was read back is its tags, which the headline drops, so its own text goes back for asCommand to read.
  const match = query
    ? sql<string | null>`(
        select case
          when recent.kind = 'human' and recent.text ~ ${COMMAND_LINE}
            then left(recent.text, ${SNIPPET_TEXT})
          else ts_headline('simple', left(recent.text, ${SNIPPET_TEXT}), ${query}, ${SNIPPET})
        end
        from (
          select "claude_entry"."seq", "claude_entry"."kind", ${withoutAttachmentsFolder(sql`"claude_entry"."text"`)} as "text"
          from "claude_entry"
          where ${ENTRY_OF_SESSION} and ${REACHED} and "claude_entry"."search" @@ ${query}
          order by "claude_entry"."seq" desc
          limit ${MATCH_CANDIDATES}
        ) recent
        where to_tsvector('simple', left(recent.text, ${SNIPPET_TEXT})) @@ ${query}
        order by recent.seq desc
        limit 1
      )`
    : sql<string | null>`null`
  const [rows, counted] = await Promise.all([
    db
      .select({ ...sessionColumns, match })
      .from(claudeSession)
      .where(filter)
      .orderBy(
        sql`${sortColumns[input.sort]} ${sql.raw(input.dir === "asc" ? "asc" : "desc")} nulls last`,
        asc(claudeSession.id),
      )
      .limit(input.perPage)
      .offset((input.page - 1) * input.perPage),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(claudeSession)
      .where(filter),
  ])
  return {
    rows: rows.map((row) => ({ ...summarize(row, live), match: asCommand(row.match) })),
    total: counted[0]?.value ?? 0,
  }
}

// How a session began, read from its first ask: /clear carries on the session before it under the same name, an ask that hands it a note in the data folder's handoffs/, ~/.playground or a folder in .claude whatever its name for a session from before the move, picks up from that note, and anything else is a fresh start.
export type Start = { kind: "clear" | "fresh" | "handover"; note: string | null }

// A note's path, its name ending at .md with nothing after it but a sentence's full stop (x.md.bak is no note).
const HANDOVER_NOTE =
  /(?:\.playground|\.claude\/[\w.-]+)\/handoffs\/([A-Za-z0-9][\w.-]*?\.md)(?![\w-]|\.\w)/g

// Words that hand a session a note in the clause that names it, as against citing one ("spec notes: ...", "read the behaviour in ...").
const HANDOVER_CUE =
  /\b(?:hand-?offs?|hand-?overs?|handed over|resum(?:e|es|ing)|pick(?:s|ed)? up|continu(?:e|es|ing)|carr(?:y|ies) on|take over|takes over)\b/i

// The clause a path sits in: back to the last line break, comma, ; or :, or a full stop before a space.
const clauseBefore = (text: string, at: number): string => {
  const before = text.slice(0, at).replace(/\S*$/, "")
  return before.split(/\n|,|;|:|\.\s/).at(-1) ?? ""
}

// A note handed over is named by a cue in its clause, or is the session's own (`builder-2026-10-12.md` is `builder`'s), so a brief citing a spec kept in the folder stays a fresh start.
export const startOf = (ask: string | null, name: string | null = null): Start => {
  const text = asCommand(ask) ?? ""
  if (text.trim() === "/clear") return { kind: "clear", note: null }
  for (const match of text.matchAll(HANDOVER_NOTE)) {
    const note = match[1]
    if (!note) continue
    const stem = note.slice(0, -".md".length)
    const own = name !== null && (stem === name || stem.startsWith(`${name}-`))
    if (own || HANDOVER_CUE.test(clauseBefore(text, match.index))) return { kind: "handover", note }
  }
  return { kind: "fresh", note: null }
}

type Span = { lastActiveAt: Date | null; startedAt: Date | null }

// Where another session of the same name sits beside this one: two whose activity overlaps ran alongside (two copies under one name), else the other came before or after.
export const relationOf = (session: Span, other: Span): "after" | "alongside" | "before" => {
  const [start, last] = [session.startedAt?.getTime(), session.lastActiveAt?.getTime()]
  const [otherStart, otherLast] = [other.startedAt?.getTime(), other.lastActiveAt?.getTime()]
  if (
    start !== undefined &&
    last !== undefined &&
    otherStart !== undefined &&
    otherLast !== undefined &&
    otherStart < last &&
    otherLast > start
  ) {
    return "alongside"
  }
  return otherStart !== undefined && start !== undefined && otherStart < start ? "before" : "after"
}

// A session's first ask: what a person, a peer, a launch prompt or a slash command asked first.
const FIRST_ASK = sql<string | null>`(
  select left("claude_entry"."text", ${ASK_TEXT}) from "claude_entry"
  where ${ENTRY_OF_SESSION} and ${REACHED} and "claude_entry"."kind" in ('human', 'peer', 'prompt')
  order by "claude_entry"."seq" limit 1
)`

// The sessions sharing a session's name, nearest first on each side, each with how it began and where it sits beside this one. Subagents and forks run inside another session and are never part of one.
async function readChain(
  db: Database,
  session: Span & { id: string; name: string; startedAt: Date },
  live: Map<string, Live>,
) {
  const sameName = and(
    eq(claudeSession.name, session.name),
    ne(claudeSession.id, session.id),
    isNotNull(claudeSession.kind),
    notInArray(claudeSession.kind, ["fork", "subagent"]),
    shownHere(),
  )
  const columns = { ...sessionColumns, ask: FIRST_ASK }
  const [before, after, counted] = await Promise.all([
    db
      .select(columns)
      .from(claudeSession)
      .where(and(sameName, lt(claudeSession.startedAt, session.startedAt)))
      .orderBy(desc(claudeSession.startedAt), desc(claudeSession.id))
      .limit(CHAIN),
    db
      .select(columns)
      .from(claudeSession)
      .where(and(sameName, gte(claudeSession.startedAt, session.startedAt)))
      .orderBy(asc(claudeSession.startedAt), asc(claudeSession.id))
      .limit(CHAIN),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(claudeSession)
      .where(sameName),
  ])
  return {
    sessions: [...before.reverse(), ...after].map(({ ask, ...row }) => ({
      ...summarize(row, live),
      relation: relationOf(session, row),
      start: startOf(ask, session.name),
    })),
    total: counted[0]?.value ?? 0,
  }
}

export const sessionExists = async (db: Database, id: string): Promise<boolean> =>
  (
    await db
      .select({ id: claudeSession.id })
      .from(claudeSession)
      .where(and(eq(claudeSession.id, id), shownHere()))
  ).length > 0

// One session with what its row in the list lacks: tokens, PRs, where it was read from, how it began, the session that started it, the first sessions it started (childCount says how many there are in all) and its chain, the sessions sharing its name (null for one with no name or no start, or a subagent or fork).
export async function readSession(db: Database, id: string, live: Map<string, Live>) {
  const [found] = await db
    .select({
      ...sessionColumns,
      ask: FIRST_ASK,
      cacheCreationTokens: claudeSession.cacheCreationTokens,
      cacheReadTokens: claudeSession.cacheReadTokens,
      inputTokens: claudeSession.inputTokens,
      outputTokens: claudeSession.outputTokens,
      prUrls: claudeSession.prUrls,
      projectDir: claudeSession.projectDir,
      version: claudeSession.version,
    })
    .from(claudeSession)
    .where(and(eq(claudeSession.id, id), shownHere()))
  if (!found) return null
  const { ask, ...row } = found
  const { name, startedAt } = row
  const [chain, children, counted, parent] = await Promise.all([
    name && startedAt && row.kind !== "subagent" && row.kind !== "fork"
      ? readChain(db, { ...row, name, startedAt }, live)
      : Promise.resolve(null),
    db
      .select(sessionColumns)
      .from(claudeSession)
      .where(and(eq(claudeSession.parentId, id), shownHere()))
      .orderBy(sql`${claudeSession.startedAt} asc nulls last`, asc(claudeSession.id))
      .limit(CHILDREN),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(claudeSession)
      .where(and(eq(claudeSession.parentId, id), shownHere())),
    row.parentId
      ? db
          .select({
            agentType: claudeSession.agentType,
            aiTitle: claudeSession.aiTitle,
            cwd: claudeSession.cwd,
            description: claudeSession.description,
            id: claudeSession.id,
            name: claudeSession.name,
          })
          .from(claudeSession)
          .where(and(eq(claudeSession.id, row.parentId), shownHere()))
      : Promise.resolve([]),
  ])
  return {
    ...summarize(row, live),
    chain,
    childCount: counted[0]?.value ?? 0,
    children: children.map((child) => summarize(child, live)),
    parent: parent[0] ?? null,
    start: startOf(ask, row.name),
  }
}

// One page of a session's log, newest page first and each page in file order, holding only the kinds asked for (all when none are): before is the seq the page starts at, so paging back never skips or repeats a line however fast the session writes. A tool step sends only its first line, the summary the page shows.
export async function readEntries(
  db: Database,
  id: string,
  input: { before?: number; kinds: EntryKind[]; limit: number },
) {
  if (!readsLive() && !(await sessionExists(db, id))) return { entries: [], before: null }
  const shown = withoutAttachmentsFolder(
    sql`case when ${claudeEntry.kind} = 'tool' then split_part(${claudeEntry.text}, E'\\n', 1) else ${claudeEntry.text} end`,
  )
  const rows = await db
    .select({
      at: claudeEntry.at,
      kind: claudeEntry.kind,
      sender: claudeEntry.sender,
      seq: claudeEntry.seq,
      text: sql<string>`left(${shown}, ${SHOWN_TEXT})`,
      textLength: sql<number>`length(${shown})`,
      tool: claudeEntry.tool,
      type: claudeEntry.type,
      uuid: claudeEntry.uuid,
    })
    .from(claudeEntry)
    .where(
      and(
        eq(claudeEntry.sessionId, id),
        reached,
        input.before === undefined ? undefined : lt(claudeEntry.seq, input.before),
        input.kinds.length > 0 ? inArray(claudeEntry.kind, input.kinds) : undefined,
      ),
    )
    .orderBy(desc(claudeEntry.seq))
    .limit(input.limit + 1)
  const page = rows.slice(0, input.limit).reverse()
  return {
    entries: page.map(({ at, textLength, ...entry }) => ({
      ...entry,
      at: iso(at),
      clipped: textLength > SHOWN_TEXT,
      text: entry.kind === "human" ? typedOf(entry.text) : entry.text,
    })),
    before: rows.length > input.limit ? (page[0]?.seq ?? null) : null,
  }
}

// The kinds a worker's live view shows; its parser makes the same steps from a stored line as from the file.
const STEP_KINDS: EntryKind[] = ["assistant", "human", "peer", "result", "thinking", "tool"]

// A step's id is its line's uuid, with `:<block>` after it for each block of an assistant line; the blocks before the given one are steps that come earlier.
const blockOf = (stepId: string): number | null => {
  const block = stepId.split(":")[1]
  return block === undefined ? null : Number(block)
}

export type StepsInput = { before?: number; beforeId?: string; limit: number }

// A worker's steps before one the live view already shows, read from the database and made by the live view's own parser, so ids, text and attachments match what the file tail gives. The first page starts from a step's id (beforeId); each page answers before, the seq of the oldest line it read, to start the next from, so paging moves on even past lines that make no step. anchored is false when the database has not read the step's line yet.
export async function readSteps(
  db: Database,
  id: string,
  input: StepsInput,
): Promise<{ entries: Entry[]; anchored: boolean; before: number | null; hasMore: boolean }> {
  if (!readsLive() && !(await sessionExists(db, id))) {
    return { entries: [], anchored: false, before: null, hasMore: false }
  }
  let anchor: { block: number | null; seq: number } | null = null
  if (input.before === undefined) {
    const stepId = input.beforeId ?? ""
    const [line] = await db
      .select({ seq: claudeEntry.seq })
      .from(claudeEntry)
      .where(
        and(
          eq(claudeEntry.sessionId, id),
          reached,
          eq(claudeEntry.uuid, stepId.split(":")[0] ?? ""),
        ),
      )
    if (!line) return { entries: [], anchored: false, before: null, hasMore: false }
    anchor = { block: blockOf(stepId), seq: line.seq }
  }
  const rows = await db
    .select({ raw: claudeEntry.raw, seq: claudeEntry.seq })
    .from(claudeEntry)
    .where(
      and(
        eq(claudeEntry.sessionId, id),
        reached,
        anchor ? lte(claudeEntry.seq, anchor.seq) : lt(claudeEntry.seq, input.before ?? 0),
        inArray(claudeEntry.kind, STEP_KINDS),
      ),
    )
    .orderBy(desc(claudeEntry.seq))
    .limit(input.limit + 1)
  const page = rows.slice(0, input.limit).reverse()
  const entries = page.flatMap((row) => {
    const steps = parseLine(JSON.stringify(row.raw))
    if (!anchor || row.seq !== anchor.seq) return steps
    // The anchor's own line keeps only the blocks before the step it names; a single-step line keeps none.
    const block = anchor.block
    return block === null ? [] : steps.filter((step) => (blockOf(step.id) ?? 0) < block)
  })
  return {
    entries,
    anchored: true,
    before: page[0]?.seq ?? null,
    hasMore: rows.length > input.limit,
  }
}
