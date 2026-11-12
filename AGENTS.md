# AGENTS.md

Guidance for AI coding agents working in this repository, a Bun monorepo: the `web/next` app, the `api/hono` service, and shared `packages/*` (auth, config, db, env, message, redis, safe-delete, settings), with build-only tooling in `packages/scripts`.
The canonical starter also carries the `packages/cli` npm binary and the `tests/` suite, neither of which a fork takes; this guide and every skill ship to a fork whole, rebranded to its name.
Start each task with the `codebase-map` skill to orient, then load the task skill that fits (see [Skills](#skills)).

## Workflow

- ALWAYS: Do every change in its own git worktree, never on the primary checked-out branch.
  Create it by absolute path under the main checkout's `.claude/worktrees/`, the folder beside the path `git rev-parse --path-format=absolute --git-common-dir` resolves to, so none nests in another worktree (one directory per worktree; never `/tmp`, home, or a sibling of the repo),
  and fork its branch from the latest `canary`: fetch first, then branch from `origin/canary` (`git fetch origin canary && git worktree add --no-track "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>" -b <branch> origin/canary`, then `bun install` in it, which its git hooks need,
  through `~/.playground/ops/run-slot.sh <your name> --` in a factory session), so the change builds on current main, and set up its `.env`, or none, by the `dev` skill's Start.
- ALWAYS: Settle a new or altered database schema before generating or applying a migration: work goes ahead on its own, but a breaking change goes through the owner first.
  An additive change (a new table, a new nullable column, an index) goes ahead after its reviewer's shape review and a dump of the live dashboard's database; anything else is breaking (a drop, a rename, a type change of real rows) and waits for the owner's go through the Inbox.
  The `db-migration` skill's step 0 holds both whole, with the shape to show first.
- ALWAYS: Point local database work at a disposable container of the worktree's own, published on loopback alone: `docker run -d --name playground-<worktree>-db -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1::5432 postgres:alpine`, then `docker port playground-<worktree>-db 5432` for its port.
  Never point it at the live dashboard's database, whose local Postgres holds every real session and transcript, so a migration or a rename applied there breaks the running dashboard; seed fake rows, since real rows never reach a screenshot or a PR.
  The `db-migration` skill's step 3 holds the rest whole: the two exceptions (first run's pglaunch database and a Vibeground's copy), the worktree's `.env`, the removal with `docker rm -fv`, and the merge lock's Redis container.
- ALWAYS: Keep documentation in sync with every change.
  Whenever code, structure, conventions, or tooling change, update the matching docs in the same change (e.g. `web/next/content/docs/`, `README.md`, the `llms.txt`/`llms-full.txt` context routes, skill docs under `skills/`, and these agent guides `AGENTS.md`/`CLAUDE.md`).
  Docs must never drift.
  See the `doc-sync` skill.
- ALWAYS: When code, a convention, a command, a path, or tooling changes, review the skills in `skills/` that touch it and update them in the same change, so every skill stays accurate and relevant.
  A skill that describes old behavior misleads every agent that loads it, which is worse than no skill.
  If a change makes a skill obsolete, remove it; if it reveals a gap, consider adding one.

## Code

- ALWAYS: Make the smallest change that meets the task's Done when, by YAGNI, so whatever you choose stays light with a small footprint: no speculative option, layer, setting or dependency.
  Before asking for review, ask what can be removed.
- ALWAYS: Use `@/` for imports, if applicable.
  An API file the web's tests import is the exception: it imports relatively (`api/hono/src/plugins/changelog/image-id.ts`), since `@/` resolves to `web/next/src` there.
- ALWAYS: Put every test under the repo-root `tests/` directory, mirroring the path of the file it covers (`api/hono/src/lib/dashboard/account.ts` is tested by `tests/api/hono/src/lib/dashboard/account.test.ts`).
  A package never carries its own `test/` directory or `test` script; read [.agents/testing.md](./.agents/testing.md) before you write or run a test (`bun run test`, `bun run test:file <paths>`, the sandbox, its traps).
- ALWAYS: Put a new build or tooling script in `packages/scripts/src/`, and declare the dependencies it imports on that package.
  It is a real workspace package, so `turbo prune` carries it into the Docker build without an extra COPY.
- ALWAYS: TypeScript under Bun for every script and test; the allowlist in `tests/python-allowlist.test.ts` holds the Python files still waiting for their port, and a new one fails the test.
- ALWAYS: Prefer a Bun-native API when the file runs under Bun and one exists (`Bun.file`, `Bun.write`, `Bun.spawn`); otherwise use a Node built-in with the `node:` protocol prefix (`import { join } from "node:path"`, `require("node:fs")`), never the bare specifier.
  Code that runs under Node anywhere stays on `node:`; the `runtime-apis` skill's table names where.
- ALWAYS: Keep enumerable lists alphabetical (A→Z), union/enum members, env-var schemas and their `runtimeEnv`/`turbo.json` mirrors, and the docs that list them, so the code and its docs stay in the same order.
  Use a meaningful order (flow, priority, required-then-optional) only where alphabetical would obscure intent.
  An API response schema with one key it is about leads with that key, then sorts the rest A→Z (`users`, then `hasNextPage`, `page`, `perPage`, `total`), so the subject sits in one place on every endpoint; a row's own fields are plain A→Z, `id` included.
- ALWAYS: Version every root `catalog` entry with a caret range (`^1.2.3`), never an exact pin or a tilde.
  `packages/scripts/src/deps-manager.ts` rewrites them on `postinstall`, with no opt-out ([docs/dependencies.md](./docs/dependencies.md)).
- Do not comment unnecessarily.
  Only comment if it is absolutely necessary.
- Keep comments on a single line; do not split one across multiple `//` lines or use multi-line `/* */` blocks.
- NEVER: Use em-dashes (the long dash, U+2014) in code, comments, docs, or copy.
  Regular hyphens are fine; for a pause or aside, use a comma, colon, or period.

## UI

- ALWAYS: Follow the `design` skill for UI, styling, and design decisions (it holds the canonical conventions).
  Update it in the same change when a convention changes.
- ALWAYS: For any frontend or UI change, verify it in a real browser with agent-browser before opening or updating a PR; drive the actual page or flow, do not rely on type-check and lint alone.
  Run the end-to-end flow when the change spans it or when asked.
  Capture screenshots only on a fixture stack (its `/api/health` reads `"dashboard":"fixture"`; see the dashboard section below), full page, before and after (`bun run verify screenshots --label before|after`), and attach them to the PR with `gh pr comment --attach`.
  See the `ui-verify` skill.

## Commits

- Make atomic commits in the Conventional Commits format.
  See the `gh-commit` skill.
- ALWAYS: Write repo text (docs, skills, rules, ADRs, comments, tests, commits, PR bodies, issues) that names no person and quotes no one, since the factory may be shared with colleagues.
  State each rule and its reason in neutral words, and write "the owner" where a person is needed.
  An override travels verbatim only between sessions, in `SendMessage`, and a public author's credit (a `CREDITS.md`) stays.
  A name that is data (a ticket's assignee, a routing owner, a fixture, a config default) stays, and no text, a commit, PR or ticket included, quotes anyone's judgement of a colleague's or a team's work.
  `bun run trace-count` counts each owner name and dated quote as `ownerName`, and fails when that count rises past its floor in `counts.json`.
- NEVER: Include "Co-authored-by" in commit messages.

## Working notes

- Write an audit report (any kind) as a `doc` item in your login's scope: `playground ext put <login> doc audit-YYYY-MM-DD-<topic> <file> --reason "<why>"`.
  Audits are transient working docs: once its findings are fully addressed (shipped or consciously won't-fixed), put a last revision that says so.
- Track planned, in-progress, and parked work as `doc plan-<slug>` items the same way, one per item, not in dated audits or scattered across issues; issues are the inbox, folded in and closed once captured.
- `playground ext search <words>` finds an audit or a plan.

## Compact Instructions

Write a compaction's summary as a handoff to the session that carries on under your name: what is done, what was decided and why, the constraints you work under, the next steps, and the newest ask from up the chain quoted whole.

- A worker, reviewer, tester, runner or probe keeps its PR number, branch and head sha, its brief's path, the review round and score, every open finding, the files it changed with the commands that test them, and its ETA.
- A manager (the dispatcher, a lead, the planner, the optimizer) keeps every live thread with its PR or Inbox id, each of the owner's open asks quoted word for word, what each session under it is on, and every promised follow-up with its time.

## Logging in (agents)

Sign in as `LocalAgent` by the `dev` skill's Agent login, which holds the curl: local-only (`NODE_ENV=local`), gated on `AGENT_SIGNIN_ENABLED=true` in `.env`, which is off by default, and a trusted `Origin` header.
On a worktree's stack the dashboard then shows the fixture's made-up sessions under its Test data badge, never the live ones (the dashboard section's source rule).

## Skills

ZeroStarter's skills live in `skills/zerostarter`, which `.agents/skills` (the path ZeroStarter's CLI syncs through), `.claude/skills` and `.github/skills` link to, so every agent tool reads the same files.
Before you run a ZeroStarter sync, read [scripts/README.md](./scripts/README.md#a-zerostarter-sync): it overlays files this repo keeps its own.
[skills/zerostarter/README.md](./skills/zerostarter/README.md) lists each skill, generated from its description by `skills-manager`: **custom** skills are maintained in this repo; **vendored** skills are copied verbatim from an upstream project (re-vendor to update, do not hand-edit).

## Playground

This repo is also Playground, whose own skills live in `extensions/core/skills/`.
The repo is public: write every file in it by the Commits section's people rule, naming no person, handle or internal repo, as `no-public-leak` (below) holds its pull requests, issues and comments to.
ZeroStarter's rules above govern Playground too; this section adds its own.

- Skills live under `skills/` too: `zerostarter/` the starter's, which `.agents/skills` links to, and `playground/` an index alone.
- Every promoted skill (one of Playground's own) has an entry in the top-level `README.md` and in `extensions/core/README.md`, plus a docs page at `docs/playground/<name>.md`, re-synced on every add, rename or change; read [extensions/core/README.md](./extensions/core/README.md)'s head before you add or change a skill.
- Invocation rules are in [.agents/invocation.md](./.agents/invocation.md).
  A decision with a lasting reason gets an ADR in `.agents/adr/NNNN-title.md`.
  A change to a contract or content takes the next version beside the old one, the latest is used and a pin is explicit ([ADR 0015](./.agents/adr/0015-versions-the-old-one-stays-the-latest-is-used.md)).
  Shared vocabulary is in [GLOSSARY.md](./GLOSSARY.md).
- ALWAYS: Call the Skill tool with "writing-for-agents" before you write or edit any agent-facing doc, and follow it (playbook's **writing** rule, which puts it at the core of every agent-facing doc):
  a `SKILL.md` and its sibling files, `AGENTS.md` and `CLAUDE.md`, an `.agents/dashboard` rule, `scripts/README.md` and `scripts/hooks/README.md`, a docs page, a handoff and a brief.
  That means a lean document, reference disclosed into sibling files, a completion criterion on every step, positive phrasing, and leading words.
  A PR body is written for the owner, in the pr skill's template (Shipping step 1), so it is outside this rule.
- ALWAYS: Land everything you learn in this repo, as a PR or a line to your lead (playbook's **memory** rule), so every session works better from what one learned.
  Claude Code's auto-memory stays off in both shared settings files, which `tests/scripts/factory-settings.test.ts` holds, and spawn.sh turns it on for the trial's sessions in the data folder's `memory/<role>/` ([ADR 0022](./.agents/adr/0022-auto-memory-runs-as-a-reviewed-trial.md)).
- ALWAYS: Track Playground's work as GitHub issues on the repo `factory.repo` names, so every item carries a number: an item's ID is `PG-<issue number>`, its branch `PG-<n>-<slug>`, its PR scope `(PG-<n>)`, and the issue stays open until the PR that says `Closes #<n>` merges.
  The repo tracks the factory's own work alone, since an org's work goes in that org's extension repo and a person's in their login extension ([ADR 0016](./.agents/adr/0016-playground-is-generic-with-a-small-core.md)).
  The key is written uppercase, and branch and title readers take either case; macOS ignores case, so a new branch never reuses an old one's number and slug in the other case.
  Research and findings go in issues too, labelled `research`, with no customer data, production numbers or secrets.
  For Playground this replaces the Working notes' "closed once captured": an issue stays open while its work is live, and its `doc plan-<slug>` item still holds the plan.
  A close someone makes by hand as completed cites the evidence for each Done when item in its comment, since a read that agrees is a claim and the citation is the evidence: the file:line or the test, or each ask in the body when the issue lists no Done when.
  GitHub's own close on the `Closes #<n>` merge needs no comment, since the PR's review has already checked each item.
- ALWAYS: Keep app copy generic, so anyone can run the app: the app speaks to the signed-in owner as you and names no person, and an org-specific value (a GitHub org, a Linear team, a Slack channel, the dispatcher's name, a path) comes from config with a sensible default.
  The skills stay the owner's own.
- A new worktree takes a full `bun install` through run-slot, 2 to 4 s on the warm cache, and clones a sibling's `node_modules` only on a cold cache ([scripts/README.md](./scripts/README.md#a-worktrees-node_modules)).
  Remove worktrees one at a time, never in parallel, and keep one review worktree across a PR's rounds.
- Every worktree of a checkout shares one `git stash` list, so a pop can take another worker's entry: set work aside with a commit, and take a before-shot from a separate worktree on `origin/canary`.
- Commit before a red-first swap and restore with `git checkout HEAD -- <file>` ([.agents/testing.md](./.agents/testing.md#traps)); squash by the `gh-commit` skill's Notes.
- When the owner asks to see a draft, a tree or a restructure, show it in chat and change no file until told to apply it.
- Run inscope as `npx -y inscope@latest <command>`; it is not on `PATH`.
- Format with `bun run format` (oxfmt, `.oxfmtrc.jsonc`), not prettier, whose semicolons and 80-column wraps survive an oxfmt pass.
- `scripts/link-skills.sh` installs the home skill set and links the factory's settings, its brief templates, the `playground` command and the ops scripts into the main checkout, so a pull there updates them.
  Re-run it after adding, renaming or removing a skill ([scripts/README.md](./scripts/README.md#link-skillssh-and-rerere)).
- The main checkout stays clean, since every installed skill follows it; each worktree keeps its own turbo cache ([scripts/README.md](./scripts/README.md#shared-git-hooks-and-the-turbo-cache)).
- A worktree commits, pushes or merges once it has run its own `bun install`, since each shared git hook runs the committing worktree's own lefthook; one that stops on `error: Script not found "node_modules/.bin/lefthook"` needs it ([scripts/README.md](./scripts/README.md#shared-git-hooks-and-the-turbo-cache)).
- Run `bun run test:skills`, CI's `auto-test.yml` steps, before pushing a change to a hook, a script, a skill's frontmatter, or a command that starts a database or stops a process ([scripts/README.md](./scripts/README.md#bun-run-testskills)).
- The em-dash rule above has one exception: an output format the user specified, such as linear's table, where `—` marks an empty cell.
  `scripts/check-em-dashes.sh` skips inline code and table cells that hold only an em-dash.
- ALWAYS: In every comment and review body on a repo whose owner `release-owners.json` lists, write "ship" or "publish step" where "release" (any case) would go, since an owner comment holding the word publishes to npm; `no-release-comment` refuses such a comment ([scripts/hooks/README.md](./scripts/hooks/README.md)).
- ALWAYS: File a new Linear ticket only after the owner's yes, posted as one Inbox `ticket` decision, and keep Playground's own work out of Linear (playbook's **tickets** rule); `no-linear-ticket` refuses a factory session's ticket create whose title no approval names ([scripts/hooks/README.md](./scripts/hooks/README.md)).
- ALWAYS: Keep Playground out of every ticket, PR, commit, branch, comment, chat message or DM of an org it works for, and every file in an org's repo (playbook's **classified** rule); `no-playground-leak` refuses an org write that holds a Playground term, and a post in the factory's channel without its signature ([scripts/hooks/README.md](./scripts/hooks/README.md)).
- ALWAYS: Send every link in a Slack post as a link chip in its full shape; `no-bare-slack-link` refuses a factory session's post holding a URL no chip carries, and its reason gives the chip ([scripts/hooks/README.md](./scripts/hooks/README.md)).
- ALWAYS: Feed a row of `tests/scripts/hooks/fixtures/refused-forms/` to a guard only as `check()` input, whatever HOME or folder is set, since each row is a command that does what it says and can name a path outside HOME; `tests/scripts/hooks/fixtures-are-data.test.ts` holds the fixture's importers to it.
- A factory session starts another only through `scripts/spawn.sh`, whose capacity gate, backends, models, runtimes, resume and restore are in [scripts/README.md](./scripts/README.md#spawnsh): read it before you change spawn.sh or when it refuses a start you did not expect;
  `no-raw-spawn` refuses every cmux call but its help or version, and every herdr call but a read or one to a scratch world of the session's own.
- The herdr servers belong to one ops job, `bun run ops:herdr`, on the binary and config its `pin.json` names ([scripts/README.md](./scripts/README.md#the-herdr-servers)), read before you change that job or herdr's pinned binary or config.
- The factory's hooks: read a hook's section of [scripts/hooks/README.md](./scripts/hooks/README.md) before you change it, its tests or its registration, and when it refuses a call you did not expect, since the README holds each one in full and its reason names the fix.
  Five have their own lines above (`no-bare-slack-link`, `no-linear-ticket`, `no-playground-leak`, `no-raw-spawn`, `no-release-comment`);
  the rest are `after-compact`, `after-resume`, `no-chat-question`, `no-desktop-owner-app`, `no-env-dump`, `no-extension-repo-write`, `no-extensions-write`, `no-false-green`, `no-glm-heavy-path`, `no-headless-login`,
  `no-kill-by-name`, `no-mac-web-build`, `no-main-checkout`, `no-off-palette-label`, `no-ours-merge`, `no-prompt-stop`, `no-public-leak`, `no-raw-delete`, `no-stash`, `no-unslotted-run`, `rules`, `session-state` and `writing-first`.

### The factory

Playground's sessions run as a factory: the dispatcher manages, the Builder leads the workers (`<id>-worker`), Ops leads the runners (`<id>-runner`) and the ops jobs, and a probe (`<id>-probe`) lives for one test.

- ALWAYS: Load [playbook](./extensions/core/skills/playbook/SKILL.md) when you are one of those sessions, or before you spawn, brief, rename or end a session.
  Its roles, chain, lifecycle, sweep and standing rules bind every session in the factory.
- ALWAYS: Signal only processes you started; never select pids by name or pattern.
  A pattern matches the live dashboard and every worker's stack.
  A port is no narrower: whoever holds portless's proxy port is the proxy every worktree routes through, the live dashboard's included.
  Stop a background task with `TaskStop`, a dev stack whose starting session has gone with `bun run dev:stop` (it signals only the process groups of the launcher its checkout recorded), and a child you spawned through its own pid or process group; every brief you write carries this rule.
  The `no-kill-by-name` hook refuses a kill by name, pattern or port in a factory session's command, and `tests/test_kill_by_name.py` fails on one anywhere in the repo's text.

### The dashboard app

The app in `api/hono` and `web/next` is Playground's dashboard: a local-only board of the Claude Code sessions Playground started (its herdr servers' and the one it hosts), reached at `/dashboard`.

Its rules live in one file per topic under `.agents/dashboard/`, and a change to a dashboard rule edits the topic file that holds it.
Each topic below names when to read its file, and each ALWAYS line is that file's rule in short: the file holds it whole, with its reasons.
When a dashboard rule's meaning changes, its ALWAYS line here changes with it.

- Stack: read `.agents/dashboard/stack.md` before you change how `bun run dev` starts, which machine a stack reads, the fixture (`api/hono/src/fixtures/dashboard.json`), the dashboard's data folder, the organisation's config (`packages/config/src/org.ts`), the hosted build or the `claude_*` tables.
  - ALWAYS: Start it (`bun run dev`) as a process of a herdr pane, or as a background task of an agent session in one, never detached with `( … &)` or `nohup`.
  - ALWAYS: Serve first run's setup with none of the app's database or auth code loaded: with `POSTGRES_URL` empty, `api/hono/src/main.ts` serves `firstRun()`'s setup routes, `GET /api/v1/onboard/checks`, the first run's fix routes and a `setup: true` `GET /api/health` alone until Start a local container (pglaunch's database as is) or Start without Docker (PGlite) finishes.
  - ALWAYS: A person's stack reads their own machine, while factory, test and `PLAYGROUND_FIXTURE` stacks read the fixture, the live dashboard's checkout reads the live machine and a hosted build reads none, as `dashboardSource()` in `api/hono/src/lib/dashboard/fixture.ts` decides.
  - ALWAYS: Keep it on loopback: the API, `next dev` and the live dashboard's built next server bind 127.0.0.1, and the dashboard is never deployed.
    The hosted build is the one exception (stack.md's hosted rule): it deploys, mounting only sign-in, health and Yard's routes.
  - ALWAYS: Keep the hosted build to its allowlist: `api/hono/src/index.ts` imports `hosted.ts` under `PLAYGROUND_HOSTED=1` and `local.ts` otherwise, and fails closed: `hosted.ts` without the flag, and a local build on Vercel, refuse to start.
  - ALWAYS: Carry only the GETs on `RELAY_GETS` and the POSTs on `RELAY_WRITES` that the paired key signs (`api/hono/src/lib/relay/protocol.ts`) through the relay.
  - ALWAYS: Stop `bun run dev` before running `bun run build`, `bun run check-types` or `bun run test`, or committing, in the same worktree.
  - ALWAYS: Keep the dashboard on the owner rung: every route and the WebSocket pass `requireConsoleRole("owner")`, but first run's setup routes, which serve before any user exists.
    Under `PLAYGROUND_HOSTED=1` Yard's routes take the `member` rung or the one their route names (stack.md's hosted rule).
  - ALWAYS: Keep the `claude_*` tables (`packages/db/src/schema/claude.ts`: each stored session's transcript, line by line, Playground's own alone unless the stack opts in) in the dashboard's local Postgres on 127.0.0.1, never a shared database.
  - ALWAYS: Read an organisation's own values from `packages/config/src/org.ts`, and every file the dashboard keeps outside the database from its data folder, `dataDir()`.
- Herdr: read `.agents/dashboard/herdr.md` before you change a herdr call, how a session counts as live, how often the board refreshes or the System panel's commands.
  - ALWAYS: Route every herdr call through `api/hono/src/lib/dashboard/herdr.ts`, the terminal the dashboard reads every session from.
  - ALWAYS: Count a session record as live only through `liveRecords()`, which `listLive` applies to herdr's records before any read.
  - ALWAYS: Run the System panel's commands only through `api/hono/src/lib/system/probe.ts`, whose `COMMANDS` holds each one's fixed argv.
- Messages: read `.agents/dashboard/messages.md` before you change how a message, a file or an answer reaches a session, the composer, the session the dashboard hosts on the Agent SDK, how a transcript renders, or the outbox and the stream's scroll.
  - ALWAYS: Send anything to a session through `deliver()` in `api/hono/src/lib/dashboard/deliver.ts`, and only for the owner's own clicks, since its text reads as the owner's (ADR 0020 aside).
  - ALWAYS: Send a herdr session (herdr.md) the message as one `agent.prompt` through `prompt()` in herdr.ts, from `deliver()` alone (ADR 0020 aside).
  - ALWAYS: Reach the session the dashboard hosts on the Claude Agent SDK only through `api/hono/src/lib/dashboard/sdk.ts`.
  - ALWAYS: Keep a message's files in the owner-only attachments folder, never in a database.
  - ALWAYS: Render text from a session's transcript through `TranscriptMarkdown`, or give your own Streamdown its `TRANSCRIPT_COMPONENTS` and `transcriptUrlTransform`.
  - ALWAYS: Send a message from the web through the dashboard's outbox (`useDashboard().outbox`), not `sendMessage` alone.
- Writes: read `.agents/dashboard/writes.md` before you change a dashboard write or a `bun run verify` check, and before you add, move or remove a dashboard page, a sidebar group or an owner-rung API route.
  - ALWAYS: Guard every dashboard write with `requireTrustedOrigin` and `requireLoopback` (`api/hono/src/middlewares/dashboard.ts`) before the session is read, then the owner rung; first run's writes, with no session yet, take `requireThisMachine` in place of the rung.
    Under `PLAYGROUND_HOSTED=1` Yard's writes take the `member` rung or the one their route names, no `requireLoopback`, and a browser's write `requireTrustedOrigin`.
  - ALWAYS: Test a dashboard write on a fixture stack, and reach a real session only from a live-reads stack, against a throwaway probe.
  - ALWAYS: Verify dashboard work with `bun run verify` (`--help` lists its checks) rather than a script of your own.
  - ALWAYS: Keep the dashboard map current.
    `packages/scripts/src/verify/dashboard-map.json` changes in the same PR as a dashboard page, a sidebar group or an owner-rung API route.
- Sidebar: read `.agents/dashboard/sidebar.md` before you change the sidebar's rows, groups or lights, the Scripts group, the managers' order, its header's icons, the tab's favicon dot or the user menu.
- Asks: read `.agents/dashboard/asks.md` before you change the Inbox or the aside window's tab squares, and before you run `bun run ask` or `bun run thread`.
- Apps: read `.agents/dashboard/apps.md` before you change an app under `/dashboard/apps`: Changelog, or the parked Plan, Previews and Usage.
- Dashboard: read `.agents/dashboard/dashboard.md` before you change `/dashboard`'s chat, an agent's view with its Pages tab, the System or Settings page, or `GET /api/v1/agents` and `GET /api/v1/system`.
- Roster: read `.agents/dashboard/roster.md` before you change the roster's shape or its reader, `api/hono/src/lib/dashboard/roster.ts`.
- Ingest: read `.agents/dashboard/ingest.md` before you change `bun run ingest`, and before you start or restart its follower.
- Live: read `.agents/dashboard/live.md` before you change how the live dashboard rolls onto `canary`.
- Sessions: read `.agents/dashboard/sessions.md` before you change the Sessions pages.

### Shipping a Playground PR

The owner does not review Playground PRs: the review loop is the gate ([ADR 0004](./.agents/adr/0004-an-independent-reviewer-is-the-gate.md)), inside ZeroStarter's flow.

1. Make the change on a branch from `origin/canary` in `.claude/worktrees/`, with a test or a red-first check when behaviour changes, and open it as a draft into `canary` whose body paraphrases its ask.
   The body is written with the [pr](./extensions/core/skills/pr/SKILL.md) skill, called through the Skill tool: a `## TL;DR` of two sentences or more on top, then its Summary, Evidence and Merge Danger, then `## Links` last.
   Its TL;DR is in plain words: what the owner sees or can do now, in words a person uses, with no factory or code jargon such as pane, slot or jsonb.
   The body gate (`packages/scripts/src/pr-merge/body.ts`, read by Checks, `pr:merge`, merge-on-ready and the train) takes the template, its TL;DR free of `Outcome:` label lines, and its Evidence an `A/B:` line.
   The Changelog (`api/hono/src/plugins/changelog/sources.ts`) reads a body's `Outcome:` line, else the TL;DR's first bullet or a prose TL;DR's first sentence.
   Before the review's round 1, settle in your own pass what a round should never spend its turn on (most late findings were docs, skill, body and wording ones): run doc-sync over the change, give each touched doc and skill a writing-for-agents read (a completion criterion on every step, positive phrasing, reference disclosed into sibling files, one meaning in one place),
   and fill the template above; the reviewer still judges everything.
   When the diff adds a member to an enumerated kind (a status, a type, a choice, a button), grep the repo for the wording of every list that names that kind's members (`git grep -n "Later, Archive"`) and update each hit: one such grep once found what six review rounds had found piece by piece.
   As part of that doc-sync pass, run the changed-term grep for each term whose meaning the diff changes (a behaviour, a rule, what a command does): `git grep -l <term>` over the agent-facing and web docs, then update every hit still describing the old meaning, since one PR took 7 rounds, each finding one more doc that did.
   After you merge `canary` into the branch, run that grep for what the incoming commits changed: list each term whose meaning they changed (`git log -p HEAD^1..HEAD^2` while the merge commit is `HEAD`), grep the PR's own changed docs for each,
   and fix every line still describing the old meaning in a commit after the merge before you ask for the next round, since one PR spent two docs-only rounds, about 24 minutes, on lines a merged change had made stale; done when no line of the PR's docs describes a meaning those commits changed.
   When the PR moves text out of a file, run `git grep -n <old file name>` over the whole repo too, code comments, `scripts/hooks/README.md` and `.agents/dashboard/` included, and check each hit against the moved text at the old base, since one PR's greps stayed inside the playbook folder and missed 7 hits outside it, which cost rounds 4 and 5.
   Done when the body's Evidence names each touched doc and skill with its check, doc-sync's result and each list grep and changed-term grep with its hits, the moved-text grep's included, before the review's round 1 opens.
2. Have a reviewer agent other than its author (a session started for the review, working in its own scratch clone, whose brief carries the signal rule from The factory, above) score it out of 5 through the [code-review-loop](./extensions/core/skills/code-review-loop/SKILL.md) skill, and fix what it finds, until it scores 5/5 on the latest head,
   GitHub Actions' `Audit, Lint, and Build` and `test` are green there, and nothing is left you would change.
3. Mark it ready at 5/5 and merge it with `bun run pr:merge <n>` bare and unpiped, or let merge-on-ready land it (`bun run pr:train ready`): the only ways a Playground PR reaches `canary`.
   Their gates, the merge lock and the merge queue are written in [packages/scripts/src/pr-merge/README.md](./packages/scripts/src/pr-merge/README.md); read it before a merge or gate ruling.
4. `main`, which the main checkout and so every installed skill follows, moves only through the `release` skill, run by Ops on the owner's standing go-ahead (playbook's **release** rule), whose step 5 then brings the main checkout up to it; say what landed.

Read [.agents/skill-trial.md](./.agents/skill-trial.md) before you try a skill headless before it merges.

### Standalone

Playground stands on its own: every skill runs only Playground's own scripts, and its rules come from the owner, from ZeroStarter, and from the repos the skills work in.
Other teams' agent setups, their skills, scripts and agents included, are not a source to read, copy or port from.
The upstream skills core keeps under `extensions/core/skills/` are the one exception: they change only through `bun run vendor:upstream`, and [ADR 0014](./.agents/adr/0014-upstream-skills-are-vendored-byte-for-byte.md) holds the pin, the licence and `pr`'s added blocks.
Our skills and briefs call them through the Skill tool, never forking one but `pr`, and add only Playground's own layer ([ADR 0009](./.agents/adr/0009-learnings-live-in-the-repo.md)).
