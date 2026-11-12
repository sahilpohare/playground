---
name: db-migration
description: Create and apply a Drizzle schema change. Use when adding or altering tables, columns, or indexes in @packages/db, or when asked for a migration.
source: https://github.com/nrjdalal/zerostarter
---

# Database Migration

PostgreSQL with Drizzle ORM. Schema lives in `packages/db/src/schema/`, migrations in `packages/db/drizzle/`. Schema, SQL, and snapshot travel together in one PR.

## 0. Settle the shape first

Generate nothing until the shape is settled (the owner, 9 Oct: everything is autonomous, but a breaking change or talking to somebody goes through the owner, mostly Slack; besides that, most things a session can do and manage itself, and on this step's text, the owner's Inbox #i54 asked that the rule say what happens and how everything works). Write out the table or the altered columns and name the choices that are hard to reverse (nullability, what a null means, foreign keys and their delete behaviour, indexes, whether anything is derived or generated, retention). Then, by its kind:

- **Additive** (a new table, a new nullable column, an index): push the schema change to your draft PR, its reviewer session reviews the shape on Opus at high effort (code-review-loop's step 4, for any diff under `packages/db/`), and you settle what it finds, then go on. Before the PR merges, you ask the dashboard runner's lead for a dump of the live dashboard's database (Notes, below) and name the dump's path in the PR body, since the dashboard's reset runs `db:migrate` with no dump of its own.
- **Breaking**, anything else (a drop, a rename, a type change of real rows, a change others depend on, anything that cannot be undone): post the shape to the owner's Inbox as a `schema` decision and stop until the owner answers.

Done when the reviewer's findings on the shape are settled and, before the merge, the PR names the dump's path (additive), or the owner has said go (breaking).

Two reasons this is a hard step rather than a courtesy. A shape is cheap to argue about and expensive to change once rows exist, so the review has to happen before the write. And the live dashboard's database already holds every real session and transcript, and the runner hosting the dashboard applies a migration there on its first roll onto canary after the merge, so a shape that slips past review lands under the running dashboard.

## 1. Edit the schema

- `auth.ts` is generated, never edited: declare a plugin or an `additionalFields` column in `packages/auth/src/schema.ts`, run `bun run auth:schema`, then continue below with the regenerated file. A hand edit fails `tests/packages/db/src/schema/auth.test.ts`.
- Schema files group by concern, not one per table: `auth.ts` holds the Better Auth tables, `console.ts` the ones the console owns. A new table joins the file for its concern, or starts a new one when it is a new concern, and that file needs an export from `index.ts`: `export * from "@/schema/<name>"`. Miss that export and the table never reaches a migration.
- For examples, read `auth.ts` (tables, relations, indexes) and `waitlist.ts` (a minimal non-auth table).
- A JSON column takes `jsonb` from `@/columns` (`packages/db/src/columns.ts`), never `json` or `jsonb` from `drizzle-orm/pg-core`: drizzle's own hand Bun's SQL client a JSON string, which Bun binds as json, so every object or array lands as one JSON string (`jsonb_typeof` reads `string`). `tests/packages/db/src/columns.test.ts` fails on a schema file that imports either of drizzle's.
- Conventions: `text` primary keys (`.$defaultFn(() => crypto.randomUUID())` on non-auth tables), `timestamp("created_at").defaultNow().notNull()`, snake_case columns, `onDelete: "cascade"` on FKs, and an `index()` on every FK column. Both bend for the same kind of column: use `onDelete: "set null"` when the row outlives the reference and the column is only provenance, and skip the index when nothing queries by it and the table is small enough that the delete-time scan is free. The `console.ts` tables are both: their `actor_id` must not take a rule or a history entry with it when an account is deleted, and although the lists join, search and sort through it, every one of those drives off `user`'s primary key rather than this column, so an index here would serve only the delete-time sweep. Index a FK when a query narrows on the column itself, or when the table is large enough for the sweep to matter. When a `set null` column is the only record of who acted, store the readable text beside it (`activity.actor`, `allowlist.actor`) so a row does not become anonymous, and can name an actor that was never an account at all.
- `tests/packages/db/src/conventions.test.ts` holds the on-delete and index rules over every table the schema exports, and counts only a full index (no WHERE): a column that bends one goes in `NOT_CASCADE` with the action its bend allows, in `UNINDEXED`, or in `PARTIAL_INDEX` when its only index is partial, each with its reason, in the same PR as the column.

## 2. Generate and review

```bash
bun run db:generate
```

Read the generated `packages/db/drizzle/NNNN_*.sql`. Done when that SQL, its `meta/NNNN_snapshot.json`, and a new `meta/_journal.json` entry all appear and the SQL matches the schema edit.

## 3. Point at a throwaway database first

**Local work runs against a disposable container of the worktree's own, never the live dashboard's database** (`live.container`, which the live dashboard checkout's `.env` names). It holds every real session and transcript, so a migration applied there lands under the running dashboard, and a column renamed under running code takes that code down. This is not hypothetical: on ZeroStarter's shared database it has happened, and step 0 and this step both exist because of it. One read of it is allowed: a Vibeground's Start seeds its own copy with one `pg_dump` inside the live database's container, and its branch's migrations run on that copy alone (`.agents/dashboard/stack.md`).

```bash
docker run -d --name playground-<worktree>-db -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1::5432 postgres:alpine
docker port playground-<worktree>-db 5432    # 127.0.0.1:<port>, the host port Docker picked
```

With `POSTGRES_URL` left empty, `bun run dev` opens `/dashboard` on first run's checks, whose Database row's Start a local container starts its container with pglaunch instead, listening on every interface with pglaunch's own credentials (or, with Docker not running, Start without Docker starts the checkout's own PGlite on loopback), then migrates and writes the URL into `.env` (`.agents/dashboard/stack.md`); a worktree's test database keeps the loopback `docker run` above.

`127.0.0.1::5432` publishes the database on loopback alone, so nothing on the network reaches it. Start the worktree's `.env` from `.env.example` rather than a copy of another checkout's, which carries that checkout's database (the live dashboard's included), and set `POSTGRES_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres` in it; then migrate and seed into it. Docker picks a new port each time the container starts again (`docker start` of a stopped container, `docker restart`, or Docker itself restarting), so read it again with `docker port playground-<worktree>-db 5432` then and update `POSTGRES_URL` in `.env`; a password unique to the worktree makes a stale URL fail to sign in rather than reach whichever container took its old port. One container per worktree, so two branches with different migrations cannot corrupt each other. Two things follow:

- Seed your own fake rows rather than copying real ones. The live dashboard's database holds real sessions, secrets and customer data among them, and a screenshot or a response body from it must never reach a PR.
- Applying to the live dashboard's database is the dashboard runner's act, after the change merges, not while it is being built.

Two containers stand apart from that rule, each by the owner's choice: first run's pglaunch database, on all interfaces (above), and a Vibeground's copy, which holds real data so a Vibeground shows real rows while its database changes stay in a copy that is thrown away, seeded by the one read above (`api/hono/src/lib/dashboard/vibe.ts`). Its real rows stay out of every screenshot and PR, and only the owner's own clicks start or stop one.

A worktree that works on the merge lock's Redis (`@packages/redis`) runs its own the same way, `docker run -d --name playground-<worktree>-redis -p 127.0.0.1::6379 redis:alpine`, with `REDIS_URL` in its `.env`; left blank, the lock keeps to its folder.

When the worktree goes, remove the container with `docker rm -fv playground-<worktree>-db`, and its Redis with `docker rm -fv playground-<worktree>-redis` when it has one: the `v` drops its data volume, which a remove would otherwise leave behind, and `tests/test_docker_rm_volumes.py` refuses a remove without it.

Done when `docker port` prints a `127.0.0.1:` line and the worktree's `.env` names that port.

## 4. Apply

```bash
bun run db:migrate
```

Apply with `db:migrate` alone: with no TTY attached, `drizzle-kit push` stops at its rename prompt, prints "Interactive prompts require a TTY terminal", applies none of its changes, and still exits 0, so a schema it never applied reads as done. Give each app its own database, since in a shared one a second app's push reads the first app's tables as renames.

For the dashboard, which is never deployed, this is local or ad-hoc only, so ZeroStarter's deploy-time auto-apply never runs for it: the runner hosting the live dashboard runs `bun run db:migrate` in its checkout after a reset that brings a migration (the dev skill's "The live dashboard's build").
The hosted build (Yard, `PLAYGROUND_HOSTED=1`) is the one deploy: `api/hono/vercel.json` runs that auto-apply, `packages/scripts/src/migrate-on-deploy.ts`, before `build:vercel`, so a production or `canary` deploy applies pending migrations to the hosted database, while a PR preview skips them.

Done when `bun run db:migrate` exits 0 and `docker exec playground-<worktree>-db psql -U postgres -d postgres -c '\d <table>'` lists the new table or column.

## 5. Make the running stack see it

```bash
bunx turbo run build --filter=@packages/db
```

The API consumes `@packages/db`'s built dist. If dev is running and the API imports the new table, restart dev entirely: `bun --hot` does not pick up new files or exports reliably (see the `dev` skill).

## 6. Inspect data

```bash
bun run db:studio
```

## Notes

- `POSTGRES_URL` comes from the worktree's own `.env`, started from `.env.example`; the live dashboard's checkout is the one whose `.env` names `live.container`, which is why a copy of it is the wrong start.
- Never edit an applied migration; generate a new one instead.
- A one-off repair of rows already written, with no schema change, is a SQL file in `packages/db/repairs/`, run with psql by the dashboard runner's lead after a dump of the tables it touches, never by the worker who wrote it. It batches large tables (each batch its own commit), changes only the rows still wrong so a re-run is a no-op, ends with a check that reads zero, and has a test under `tests/packages/db/repairs/` that runs it through psql across a batch boundary.
- Dump or repair a container's database from inside it, since the host's `pg_dump` can be older than the server and refuses it: `docker exec <container> pg_dump -U postgres -d <db> ...` and `docker exec -i <container> psql -X -v ON_ERROR_STOP=1 -U postgres -d <db> -f - < <file>.sql`. A dump of the live dashboard's database holds real rows, so it goes outside the repo (`~/.playground/`).
