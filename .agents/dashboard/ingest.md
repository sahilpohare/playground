- `bun run ingest` fills the `claude_*` tables: it reads every transcript under `$CLAUDE_CONFIG_DIR/projects` (else `~/.claude/projects`; on a fixture stack, the fixture's) from where it last stopped, one transaction per chunk, so a crash or a stop loses nothing and a re-run adds nothing;
  on a stack that reads this machine it skips, unread, each transcript that is not Playground's own (`isOwnSession()`, a subagent's judged by its parent's, stack.md) unless the stack opts in with `PLAYGROUND_ALL_SESSIONS`, so another's never reaches the database;
  `--follow` then keeps reading new lines (a changed file is read within a second, at most once a second while it keeps changing, and every transcript is rescanned every 30s).
- It reads Codex's rollouts the same way, from `$CODEX_HOME/sessions` (else `~/.codex/sessions`; on a fixture stack, the `codex/sessions` folder inside the fixture's config folder): `ingestRollout` in `api/hono/src/lib/sessions/ingest.ts`, each line kinded by `api/hono/src/lib/sessions/rollout.ts` at Codex's pinned line shapes.
  A rollout's session is the thread its `session_meta` line names, and a line's uuid is its byte offset in the plain text, so a `.jsonl` and its `.jsonl.zst` copy are one session and a second read adds nothing; a `.jsonl.zst` is read whole, once per inode, in one chunk, so a read stopped part way stores none of it and the next pass reads it again.
  The same own-session rule skips another's rollout unread, and `--follow` reads rollouts on its 30s rescan alone.
  Each session row's `harness` says which tool ran it, `claude-code` (every row stored before rollouts were read) or `codex`, a `HarnessId` of `packages/settings/src/harnesses.ts`.
  Before Claude Code's first session makes the projects folder, a pass reads no transcript and `--follow` logs `no <folder> yet; waiting for Claude Code's first session`, checks for the folder each second, and watches and reads it once it appears, so a fresh Mac's follower stays up; `status` blames the database only for a database error.
  Before its first write it proves the target is a Postgres container on this machine and prints that proof, or refuses: the URL's host is loopback, one running Docker container publishes the URL's port on loopback only, and the server the URL reaches has that container's system identifier, so a tunnel or proxy to a remote database fails.
  A pg advisory lock allows one importer per database, so a second copy prints `another importer holds the lock; nothing to do` and exits 0.
  It reads only files, so it needs no herdr socket.
  On a fixture stack, once the backfill is in, it writes the fixture's made-up threads and tags their lines (`seedFixtureThreads`, `.agents/dashboard/asks.md`); on any other source it writes none.
  A transcript replaced under its path (a new inode) or cut shorter is read again from 0 and its rows replaced (`ingestFile` in `api/hono/src/lib/sessions/ingest.ts`).
  A thread-tagged row stays through that wipe at a negative seq until a re-read line with its uuid takes it, keeping its tag, and the read that reaches the file's end deletes the tagged rows the new file dropped, so a reader stopped part way keeps every tag and its next pass carries on.
- The runner hosting the dashboard keeps the follower running beside `bun run dev`, from the same checkout (its `.env` points at the dashboard's Postgres), as a second background task with its own log.
  The first start backfills every transcript (about 30s for 450 files) before it follows:

  ```bash
  mkdir -p "${PLAYGROUND_DATA_DIR:-$HOME/.playground}"
  bun run ingest --follow >> "${PLAYGROUND_DATA_DIR:-$HOME/.playground}/dashboard-ingest.log" 2>&1   # start: Bash run_in_background, never ( … &) or nohup
  bun run ingest status   # health: exits 0 while a follower holds the lock; prints transcripts read, never read and with unread bytes
  ```

  Healthy is `follower: running`, with `never read` and `with unread bytes` small and back at 0 once the sessions go quiet (a line still being written counts as unread until its newline lands).
  The log has one line a minute while it reads anything, and a `reads failed` line when any read failed.
  When status exits 1, or the unread counts keep climbing for a minute, stop the background task (a stop finishes the chunk in hand) and start it again: a restart reads only what changed while it was down.
  The importer exits 1 by itself on any of these, its two lock checks running from the moment it takes the lock, through the backfill as well as the follow; start it again after fixing what the log names:
  - the connection holding its lock drops, no longer holds the lock, or leaves a check unanswered for 10s (`LOCK_CHECK_MS`, `LOCK_DEADLINE_MS` in `dashboard-ingest.ts`), since a connection dropped without a reset hangs rather than errs;
  - a write finds the lock gone, since every write transaction checks it last, so that write rolls back;
  - every read fails for three rescans in a row.
  After a pull, or the live dashboard's roll onto a new canary head, restart it as well, since a running follower keeps the code it started with: when that changes `packages/*`, restart `bun run dev` first (its build of `packages/*` is what the follower imports) and run `bun run db:migrate` when a migration landed, then the follower.
