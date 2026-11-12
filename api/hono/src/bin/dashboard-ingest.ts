import { claudeSession, claudeTranscript } from "@packages/db"
import { env } from "@packages/env/db"
import { SQL } from "bun"
import { count, max, sum } from "drizzle-orm"

import { seedFixtureThreads } from "@/lib/dashboard/threads"
import { provenLocal } from "@/lib/sessions/guard"
import {
  backfill,
  connect,
  fence,
  follow,
  type Follower,
  INGEST_LOCK,
  transcriptPaths,
} from "@/lib/sessions/ingest"
import { codexSessionsDir, projectsDir } from "@/lib/sessions/paths"

// Puts every Claude Code session on this machine into the dashboard's database: `bun run ingest` reads every transcript up to its end and exits; `bun run ingest --follow` does that, then keeps reading new lines until stopped; `bun run ingest status` says whether a follower is running and how much of the files the database has not read. See `.agents/dashboard/ingest.md` for how the runner hosting the dashboard keeps the follower going.
const USAGE = `usage: bun run ingest            read every transcript to its end, then exit
       bun run ingest --follow   the same, then keep reading new lines
       bun run ingest status     is a follower running, and how much is not yet read
transcripts are read from ${projectsDir()}, Codex rollouts from ${codexSessionsDir()}`

const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

// How often the follower checks that its connection still holds the lock, and how long a check may go unanswered.
const LOCK_CHECK_MS = 2_000
const LOCK_DEADLINE_MS = 10_000

const lost = (why: string): never => {
  say(`lost the connection holding the lock (${why}); exiting so the runner restarts the follower`)
  process.exit(1)
}

const fail = (message: string, code = 1): never => {
  console.error(`ingest: ${message}`)
  process.exit(code)
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// A filesystem error carries the call that failed; anything else status meets comes from the database
const fromFiles = (err: unknown) => err instanceof Error && "syscall" in err

// Which importer holds the lock on this database, by the application_name it set on the connection holding it.
const holderOf = async (lock: SQL): Promise<string | null> => {
  const [row] = await lock`
    select a.application_name as name
    from pg_locks l join pg_stat_activity a using (pid)
    where l.locktype = 'advisory' and l.granted and l.classid = 0 and l.objid = ${INGEST_LOCK} and l.objsubid = 1
      and l.database = (select oid from pg_database where datname = current_database())
  `
  return row ? String(row.name) : null
}

async function status(db: ReturnType<typeof connect>, lock: SQL): Promise<boolean> {
  const holder = await holderOf(lock)
  const known = new Map((await db.select().from(claudeTranscript)).map((row) => [row.path, row]))
  let unreadFiles = 0
  let unreadBytes = 0
  let fresh = 0
  for (const path of await transcriptPaths(projectsDir())) {
    const row = known.get(path)
    const size = await Bun.file(path)
      .stat()
      .then(
        (s) => s.size,
        () => 0,
      )
    if (!row) {
      if (size > 0) fresh += 1
    } else if (size > row.byteOffset) {
      unreadFiles += 1
      unreadBytes += size - row.byteOffset
    }
  }
  // the totals ingest keeps on each session, since a scan of every entry outlasts the client's idle timeout under load
  const [totals] = await db
    .select({
      entries: sum(claudeSession.entryCount),
      newest: max(claudeSession.lastActiveAt),
      sessions: count(),
    })
    .from(claudeSession)
  const following = holder === "dashboard-ingest follow"
  const oneShot = holder === "dashboard-ingest once" ? " (a one-shot import is)" : ""
  console.log(`follower: ${following ? "running" : `not running${oneShot}`}`)
  console.log(
    `transcripts: ${known.size} read, ${fresh} never read, ${unreadFiles} with unread bytes (${unreadBytes} bytes)`,
  )
  console.log(
    `sessions: ${totals?.sessions ?? 0}, entries: ${Number(totals?.entries ?? 0)}, newest entry: ${totals?.newest?.toISOString() ?? "none"}`,
  )
  return following
}

const args = process.argv.slice(2)
const mode =
  args.length === 0
    ? "once"
    : args[0] === "--follow" && args.length === 1
      ? "follow"
      : args[0] === "status" && args.length === 1
        ? "status"
        : null
if (!mode) fail(USAGE, 2)

let proof = ""
try {
  proof = await provenLocal(env.POSTGRES_URL)
} catch (err) {
  fail(`refusing to write: ${errorText(err)}`)
}

const db = connect(env.POSTGRES_URL)
const lock = await new SQL(env.POSTGRES_URL, { max: 1 }).reserve()

if (mode === "status") {
  try {
    process.exit((await status(db, lock)) ? 0 : 1)
  } catch (err) {
    fail(
      fromFiles(err)
        ? `could not read the transcripts under ${projectsDir()} (${errorText(err)})`
        : `the database is not ready (${errorText(err)}); is the latest migration applied?`,
    )
  }
}

// Named before it locks, so status never meets a holder without its name.
await lock.unsafe(`set application_name = 'dashboard-ingest ${mode}'`)
const [got] = await lock`select pg_try_advisory_lock(${INGEST_LOCK}) as ok`
if (!got?.ok) {
  say("another importer holds the lock; nothing to do")
  process.exit(0)
}
const [held] = await lock`select pg_backend_pid() as pid`
fence(db, Number(held?.pid), lost)

// The lock lives on this one connection: if it drops, a second importer could start, so this one stops within seconds and the runner restarts it, from the lock on: through the backfill, a one-shot run and the follow. A connection dropped without a reset hangs rather than errs, so a check with no answer by its deadline counts as lost.
let checking = false
setInterval(() => {
  if (checking) return
  checking = true
  const deadline = setTimeout(
    () => lost(`no answer in ${LOCK_DEADLINE_MS / 1000}s`),
    LOCK_DEADLINE_MS,
  )
  lock`
    select exists (
      select 1 from pg_locks
      where pid = pg_backend_pid() and locktype = 'advisory' and granted
        and classid = 0 and objid = ${INGEST_LOCK} and objsubid = 1
    ) as held
  `.then(
    ([row]) => {
      clearTimeout(deadline)
      checking = false
      if (!row?.held) lost("it no longer holds the lock")
    },
    (err) => lost(errorText(err)),
  )
}, LOCK_CHECK_MS)

// A stop finishes the chunk in hand, so the last thing written is a whole transaction.
const stopping = new AbortController()
let follower: Follower | null = null
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping.signal.aborted) return
    stopping.abort()
    if (follower) {
      void follower.stop().then(() => {
        say(`stopped by ${signal}`)
        process.exit(0)
      })
    }
  })
}

say(`writing to ${proof}`)
const projects = projectsDir()
const sessions = codexSessionsDir()
const started = Date.now()
const pass = await backfill(db, projects, stopping.signal, sessions)
const seconds = Math.round((Date.now() - started) / 1000)
say(`read ${pass.read} transcripts in ${seconds}s: ${pass.entries} new entries`)
for (const line of pass.duplicates) say(`duplicate transcript: ${line}`)
if (pass.failed > 0) say(`${pass.failed} reads failed, first: ${pass.firstError}`)
const threads = await seedFixtureThreads(db)
if (threads > 0) say(`fixture: ${threads} made-up threads in place`)
if (stopping.signal.aborted) {
  say("stopped before reading everything; the next run picks up where this one stopped")
  process.exit(0)
}
if (mode === "once") process.exit(pass.read > 0 && pass.failed === pass.read ? 1 : 0)

// INGEST_RESCAN_MS lets a test shorten the rescan that catches a change the watcher missed.
follower = follow(
  db,
  projects,
  say,
  (reason) => {
    say(`giving up: ${reason}; exiting so the runner restarts the follower`)
    process.exit(1)
  },
  Number(process.env.INGEST_RESCAN_MS) || undefined,
  sessions,
)
say(`following ${projects}, and ${sessions} on each rescan`)
