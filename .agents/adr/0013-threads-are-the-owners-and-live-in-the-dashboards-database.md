# Threads are the owner's and live in the dashboard's database

The dashboard shows each Claude Code session as its own row, so one thing the owner asked about, worked on by a manager, a worker and its reviewer, is spread over three sessions and the Inbox items they post. This decision groups it as a **thread**, the word and the shape ZeroSDK settled in two decisions of its own: a thread belongs to the human and to no session (threads, not sessions), and a session's lines are stored whole while a thread groups them through `threadId` and `threadSeq`.

## Decision

A thread is the owner's: the `thread` table keeps no session id, since its lines can come from any number of sessions, and it holds only what changes about it, its `title` and the owner's `lastReadAt`, `pinnedAt` and `archivedAt`. It lives in the dashboard's local Postgres beside `claude_entry`, whose lines it groups, so the unread count is one join and never a read of a file.

Four choices differ from zerosdk or are costly to reverse:

- **A 4-character id, not a UUID v7.** The owner cites a thread in chat the way the owner cites an Inbox item's `#iN`, so its id is short and typed: 4 characters of `ID_ALPHABET` with at least one letter (`THREAD_ID`). Its creation time is a column, since the id no longer holds it.
- **Tag columns on `claude_entry`, not a link table.** A line belongs to at most one thread, so `thread_id` and `thread_seq` sit on the line, with a partial unique index on the pair, and a deleted thread clears `thread_id` rather than taking transcript lines with it; `thread_seq` is read only beside a `thread_id`.
  A reset read keeps a tagged line's row through its wipe at `seq = -1 - seq` until the re-read reaches it (`ingestFile` in `api/hono/src/lib/sessions/ingest.ts`), and the session readers in `api/hono/src/lib/sessions/read.ts` read only `seq >= 0`.
- **`updatedAt` stored, bumped by each route.** The sidebar orders by it on every read, so it is a column the route that tags a line updates, rather than a max over `claude_entry`; a change made from the dashboard leaves it alone.
- **No status column.** A thread's done state waits for the routing that would set it, as it does in zerosdk; `archivedAt` is the owner's own put-away until then.

## Consequences

- Read state is the one owner's, as the dashboard has one owner; read state per person waits for a second.
- The live dashboard's database takes the table on its next roll onto canary, so the migration is additive only: a new table, three nullable columns and one partial index.
- A fixture stack's made-up threads are written by `bun run ingest` and, while the thread table is empty, by the API's start; never by a read, and only on a fixture source (`.agents/dashboard/asks.md`).
- A later change routes a line by a leading `[thread:<id>]` marker as ingest stores it, so the session's own replies route too, not only the owner's and a peer's messages; it needs no column beyond `thread_id` and `thread_seq` (`.agents/dashboard/asks.md`, Threads).
