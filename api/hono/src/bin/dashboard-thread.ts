import "@/bin/needs-database"
import { THREAD_TITLE_MAX } from "@packages/config/threads"
import { claudeSession, createDatabase, thread } from "@packages/db"
import { env as apiEnv } from "@packages/env/api-hono"
import { dataDir } from "@packages/env/data-dir"
import { env } from "@packages/env/db"
import { readSessionNames } from "@packages/settings"
import { eq, isNull, sql } from "drizzle-orm"

import { branchOf, checkoutRoot, readsLive } from "@/lib/dashboard/fixture"
import {
  createThread,
  fileUnder,
  patchThread,
  threadExists,
  threadOrder,
  unread,
} from "@/lib/dashboard/threads"
import { livePair, othersLiveDashboard } from "@/lib/dev/launch"
import { locate, prove } from "@/lib/sessions/guard"

// How Playground routes each ask, and each update about it, to a thread, beside the `[thread:<id>]` marker ingest routes by: `new` opens one and prints its id, `route` tags the newest untagged message of a session that starts with the quoted words, once ingest has brought it, `title` renames one, and `list` prints the open threads. See `.agents/dashboard/asks.md` for threads.
const USAGE = `usage: bun run thread new "<title>"     opens a thread, prints its id
       bun run thread route <id> --quote "<opening words>" [--session <session id>] [--wait <seconds>]
                                                routes the newest untagged message (a person's, a peer's or a
                                                prompt) of that session (the dispatcher's by default) whose
                                                text starts with the quote to the thread, waiting up to
                                                --wait (60) for ingest
       A message or reply that opens with [thread:<id>] needs no route: ingest routes it as it reads it.
       bun run thread title <id> "<title>"  renames the thread
       bun run thread list                 prints the open threads, pinned first then newest, with unread counts`

const WAIT_S = 60

const fail = (message: string, code = 1): never => {
  console.error(`thread: ${message}`)
  process.exit(code)
}

if (!readsLive()) {
  console.error(
    "thread: this checkout reads the fixture, and the live Dashboard never shows its threads; for a real thread, run bun run --cwd <the live dashboard's checkout> thread",
  )
}

const [command, key, ...rest] = process.argv.slice(2)

// Pure: `--name value` pairs, each named at most once and only from allowed; null for anything else.
const flagsOf = (args: string[], allowed: string[]): Record<string, string> | null => {
  if (args.length % 2 !== 0) return null
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, "") ?? ""
    if (!args[i]?.startsWith("--") || !allowed.includes(name) || name in flags) return null
    flags[name] = args[i + 1] ?? ""
  }
  return flags
}

const flags = command === "route" ? flagsOf(rest, ["quote", "session", "wait"]) : {}
const valid =
  (command === "new" && !!key?.trim() && rest.length === 0) ||
  (command === "route" && key && flags !== null && !!flags.quote?.trim()) ||
  (command === "title" && !!key && rest.length === 1) ||
  (command === "list" && key === undefined)
if (!valid) fail(USAGE, 2)
if (command === "title" && !rest[0]?.trim()) fail("a title takes words")
// the dashboard's change path caps a title at threadPatchSchema's cap, so a longer one would land and then leave the thread untouchable
const title = (command === "new" ? key : command === "title" ? rest[0] : "")?.trim() ?? ""
if ([...title].length > THREAD_TITLE_MAX)
  fail(`a title takes at most ${THREAD_TITLE_MAX} characters`)

try {
  const located = locate(env.POSTGRES_URL)
  if (othersLiveDashboard(located.owner.name, branchOf(checkoutRoot()))) {
    fail(
      `refusing ${livePair().database}, the live dashboard's database, off its own checkout (branch ${livePair().branch}); run bun run --cwd <the live dashboard's checkout> thread`,
    )
  }
  await prove(env.POSTGRES_URL, located)
} catch (error) {
  fail(`refusing to use the database: ${(error as Error).message}`)
}
const db = createDatabase(env.POSTGRES_URL)

if (command === "new") {
  console.log(await createThread(db, title))
} else if (command === "route") {
  const wait = Number(flags?.wait ?? WAIT_S)
  if (!Number.isFinite(wait) || wait < 0) fail("--wait takes a number of seconds")
  if (!(await threadExists(db, key as string))) fail(`no thread ${key}`)
  let session = flags?.session
  if (!session) {
    const name = apiEnv.PLAYGROUND_DISPATCHER || readSessionNames(dataDir()).names.dispatcher
    const [dispatcher] = await db
      .select({ id: claudeSession.id })
      .from(claudeSession)
      .where(eq(claudeSession.name, name))
      .orderBy(sql`${claudeSession.lastActiveAt} desc nulls last`)
      .limit(1)
    if (!dispatcher) fail(`no session named ${name}; name one with --session`)
    session = dispatcher?.id as string
  }
  const quote = flags?.quote?.trim() ?? ""
  const routed = await fileUnder(
    db,
    { quote, session: session as string, threadId: key as string },
    { waitMs: wait * 1000 },
  )
  if (!routed)
    fail(`no untagged message of session ${session} starts with "${quote}" after ${wait}s`)
  console.log(`${routed?.uuid} routed to ${key} as #${routed?.seq}`)
} else if (command === "title") {
  const patched = await patchThread(db, key as string, { title })
  if (!patched) fail(`no thread ${key}`)
  console.log(`${patched?.id} · ${patched?.title}`)
} else {
  const rows = await db
    .select({ id: thread.id, pinnedAt: thread.pinnedAt, title: thread.title, unread })
    .from(thread)
    .where(isNull(thread.archivedAt))
    .orderBy(...threadOrder)
  for (const row of rows) {
    console.log(`${row.id} ${row.unread} unread${row.pinnedAt ? ", pinned" : ""} · ${row.title}`)
  }
}
process.exit(0)
