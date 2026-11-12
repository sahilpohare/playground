# Playground

The factory's own terms. An org's ticket skills keep their terms in that org's extension, as its `doc glossary` (`playground ext show <org> doc glossary`).

## Language

**Canary**:
Running a test against the old code to prove it goes red.

**Canary branch**:
ZeroStarter's integration branch: every PR squash-merges into `canary`, and a release promotes it to `main`.
_Avoid_: canary, alone (that is the red-first test)

**Promoted**:
A skill of Playground's own in `extensions/core/skills/`, where core's vendored upstream skills sit beside it: it gets README entries and a docs page.

**Sidebar**:
The dashboard's left column: the session groups, the dispatchers' first, the system icons in its header and the usage line in its footer.

**Chat**:
The dashboard's middle region: a session's stream with its composer, the chat on Playground's view and an agent's log elsewhere.

**Aside** (also **aside window**):
The dashboard's right half beside the chat: the Inbox, Pages and app tabs (on a phone they take the chat's place, with a tab bar at the bottom).
_Avoid_: side panel

**Inbox**:
Playground's list of what the factory needs from the owner and what the owner should know, beside the owner's chat on the Dashboard: one `inbox_item` row each in the dashboard's local Postgres, posted only with `bun run ask`, shown by its `#i<ref>` id. Its three kinds are a **decision** (a preview of exactly what Approve does: an extension accept, a change to the owner's apps, a System Settings pane for a macOS permission, a guard setting or an own account change, which the Dashboard carries out itself, a Slack message, a ship, a new ticket, a delete, a schema, a budget, or a plain ask whose words say what its poster does, answered Approve, Deny or Archive, with an optional note; or a secret ask, answered with a value its card hands to a sink and keeps nowhere), a **draft** (a Slack message or Linear comment the owner edits, then sends or discards, or for a Slack message saves as a draft in Slack for the owner to finish; or, with no link, a public post's text for the owner to post, kept to the **public** rule) and an **update** (an outcome to read: merged, shipped, an alert, a finding or a decision made for the owner). It replaced the asks; the poster carries out the owner's answer and never waits on it (playbook's **ask** rule).

**One-way door**:
A choice whose undoing costs real rows, real money or someone else's trust, such as a breaking schema change, a budget or a new Linear ticket. Of the choices a session could make itself, only these go to the owner as an **Inbox** decision, the closed set being the **ask** rule's list ([ADR 0012](./.agents/adr/0012-the-factory-decides-two-way-doors.md)).

**Two-way door**:
A choice that can be undone: a design, an order, the scope inside an ask the owner approved. The factory picks it and records it in an ADR or on the issue, telling the owner with an Inbox update only when it changes what the owner sees or does ([ADR 0012](./.agents/adr/0012-the-factory-decides-two-way-doors.md)).

**Gate**:
The set of verdicts a PR's head must hold before pr:merge squashes it: code-review-loop's 5/5 and GitHub's `Audit, Lint, and Build` and `test` checks green ([playbook](./extensions/core/skills/playbook/SKILL.md), the **gate** rule).

**Lead**:
One of the two managers under the dispatcher that run the floor (the dashboard's and the roster's Manager): the Builder leads the workers, Ops the runners and the ops jobs. Every worker and runner reports to exactly one lead, and the leads report to the dispatcher ([playbook](./extensions/core/skills/playbook/SKILL.md)).

**Thread**:
One thing the owner asked about, followed until it is done however many sessions work on it: a `thread` row in the dashboard's local Postgres with a 4-character id, each transcript line it holds tagged with its `thread_id` ([ADR 0013](./.agents/adr/0013-threads-are-the-owners-and-live-in-the-dashboards-database.md)). A review thread on a PR, the conversation code-review-loop resolves, is a different thing and keeps that full name.

**Fixture**:
A made-up machine the dashboard reads on factory, test and `PLAYGROUND_FIXTURE` stacks: fake sessions in every state, their transcripts, roster and usage, written fresh into a stack's scratch folder when it starts (`api/hono/src/fixtures/dashboard.json`), shown under a Test data badge. A full-page screenshot of a fixture stack carries no real data, so screenshots come from one alone. A person's own clone, the live dashboard's branch and a `PLAYGROUND_LIVE_READS` stack read the live machine ([ADR 0008](./.agents/adr/0008-a-persons-stack-reads-their-own-machine.md)).

**Vibeground**:
A worktree's own stack the owner starts from the Inbox's Preview row, worked on beside the chat or in a tab of its own: its branch as it stands, on a copy of the live dashboard's database seeded by one `pg_dump`, so it shows real data while its migrations reach the copy alone. Done asks the dispatcher to have its worktree's session push to the branch's open PR, else open one into its parent, never merging; Stop removes the copy and keeps the worktree. Its pages wear a Vibeground badge with its branch.

**Yard relay**:
The one outbound WebSocket this Mac's API holds to the hosted Yard, through which the owner reads this Mac's own `/dashboard` from anywhere and sends from it: the hub forwards each GET on `RELAY_GETS`, a browser's pair request and each write on `RELAY_WRITES` the paired key signs, and keeps nothing; every other write stays on the Mac ([stack.md](./.agents/dashboard/stack.md)). Distinct from [ADR 0010](./.agents/adr/0010-ops-alerts-go-through-a-relay.md)'s relay, Ops' queue that turns an ops job's alert into a cross-session message.

**Paired key**:
The one browser key this Mac takes a write from Yard from: made in the owner's browser on the hosted Yard, its private half never leaving that browser, and paired only by the owner's Approve in the Mac's own Settings. A re-pair replaces it and Revoke removes it ([ADR 0017](./.agents/adr/0017-a-write-from-yard-counts-only-when-the-paired-key-signs-it.md)).

**Trash**:
`~/.playground/trash`, where `playground rm`, and the dashboard for a fixture stack's scratch folder and a Vibeground's record and `.env`, move a deleted path as a same-disk rename, one `<UTC-ts>-<session>/<n>/` folder per delete with a `manifest.jsonl` line naming where it came from, so `playground rm --restore <id>` can put it back. `playground rm` itself removes the tree's `node_modules` folders and `web/next/.next` from the trashed copy, which an install or a build rebuilds. Two scripts of the factory's own, the Dashboard's supervisor and the jobs render, send their deletes there through a carve-out of the protected list (`CARVE_OUTS` in `packages/safe-delete`): one exact folder in the data folder (or, for the render's installed plists, `~/Library/LaunchAgents`, its own `com.playground.*.plist` files alone), with a file and byte cap, that only that script names. The `trash-purge` beat in ops-tick empties each delete after 7 days, sooner while the disk has under 50 GB free, at any load, and sweeps a told mark older than the cap's window (60 s), and strips each batch's `node_modules` folders and `web/next/.next`, which an install or a build rebuilds (`packages/safe-delete`). Its per-minute tripwire (`LIMITS.perMinute`, read by `recentMoves`) counts the moves of one session name and alerts once a burst (`firstOfBurst`, keeping the burst it told in `<trash>/.cap-told/<session>/<burst key>`), so a caller making many deletes passes a name of its own process, and tests that share a pid each take trash roots of their own. A raw recursive delete (each form `tests/no-raw-delete.test.ts` lists) outside `packages/safe-delete/`, `scripts/hooks/` and `tests/` is a named raw-delete carve-out with its reason in that test, which goes red on a new one.

**Probe**:
A throwaway session named `<id>-probe`, or `probe-<what>` when started before, spawned for one test and closed by its spawner the moment the test is done.

**Sweep**:
A lead's regular check of its own agents, for a picker waiting, a permission prompt, silence with no report, a worker off its chore, or a session gone, each acted on and recorded.

**Dispatcher**:
The dispatcher's own session: it routes each task by role, a new ask through the Planner and then a lead (the Builder or Ops), a fast lane straight to a lead, and holds no task of its own, so the sidebar lists it in its header, above the session groups, with no group title, and `/dashboard` opens its chat. The live dashboard itself belongs to a runner ([playbook](./extensions/core/skills/playbook/SKILL.md)).

**Manager**:
A session that manages under the dispatcher: the Planner, the Builder, Ops and the Optimizer, by default `planner`, `builder`, `ops` and `optimizer` by name, or any agent the dispatcher's roster gives the manager role. The dashboard lists managers under Orchestrators, below the dispatcher rows in the sidebar's header, with their tasks, A to Z by roster title until the owner drags them into an order of the owner's choosing. The factory's rules call the Builder and Ops leads (Lead).

**Picker**:
The command (`playground picker`) by which a session's manager answers one permission prompt: it allows or denies only the call the session's stuck alert named, keyed to that call (packages/scripts/src/playground/picker.ts).

**Planner**:
The Planner's session, a manager: it does every research, deep dive, comparison and plan, through read-only research workers the Builder dispatches, and never builds, so it stays free for the next ask. It keeps the roadmap, `~/.playground/bundles/plan.json`, whose lanes the Builder dispatches from ([playbook](./extensions/core/skills/playbook/SKILL.md)).

**Icebox**:
The Optimizer's parking place for an idea a retro found but nothing needs yet, one GitHub issue it keeps and reads at each retro; an idea leaves it for a `PG-<n>` issue of its own once a lead schedules it.

**Retro**:
The Optimizer's look back over what the factory did: what slowed it, what it cost and what went wrong, each lesson turned into a fix routed through the dispatcher, or parked in the icebox.

**Brief**:
The file that spawns a session and binds it: the task, its steps and its Done-when, passed to `scripts/spawn.sh` as a path, from the templates in `scripts/briefs/` ([SESSIONS.md](./extensions/core/skills/playbook/SESSIONS.md#spawn)).

**Bundle**:
The issues and backlog entries that touch one surface, such as the sidebar or the chat, grouped by the Planner into one chore: one worker, one branch, one PR, one review loop and one tester pass per head, its tester driving the pages and files it names.

**Lane**:
One surface's line in the planner's plan, `bundles/plan.json` in the data folder: the work a bundle builds next, dispatched and ordered by the Builder.

**Worker**:
A session doing one bounded chore, named `<id>-worker` by `bun run name worker` ([SESSIONS.md](./extensions/core/skills/playbook/SESSIONS.md#spawn)), such as `k3m9px-worker`; one started before keeps its name, such as `worker-brave-otter` or `worker-wrath`. The dashboard lists them under Subagents, with any the roster calls a worker, and nests each reviewer and tester checking its pull request under it. A probe, or a session with any other name, goes to the dashboard's collapsed Other group.

**Runner**:
A dedicated long-running session named `<id>-runner`, or `runner-<adjective>-<noun>` or `runner-<sin>` when started before (or one the dispatcher's roster gives the runner role, such as a headless scan Ops runs), such as the one that keeps the dashboard on its branch's latest head. The dashboard lists runner sessions in an AI Runners group of their own, and the ops jobs that run as scripts with no session in a Scripts group after it.

**Roster**:
The file the dispatcher keeps of the agents it dispatched (`~/.playground/roster.json`): each one's kind, role, task, short title, ETA and where its work went. The dashboard reads it for its Agents table, its Next up list (the roster's backlog still waiting) and its sidebar's titles and ETAs; the dispatcher and the leads write it, only through `scripts/roster.ts`.

**Slack mode**:
The owner is away and the owner's own Slack DM is the owner's remote access: the `slack.mode` setting, on until the owner turns it off. While it is on, ops-dm-watch hands each owner message in the DM to the dispatcher, to the session in the assistant seat too when no reply lands in 3 minutes while the dispatcher is not mid-turn, or the dispatcher is stuck, and nudges the dispatcher for an update every 15 minutes; every reply goes through `playground dm send` (the bundled [slack skill](./extensions/slack/skills/slack/SKILL.md)).

**WhatsApp mode**:
The owner's WhatsApp is a chat with the factory: the bundled `whatsapp` extension's switch in Settings, Extensions (`ext.bundled`). While it is on, ops-wa hands each 1:1 message from `wa.owner` to the dispatcher, to the session in the assistant seat too when no reply goes out in 3 minutes while the dispatcher is not mid-turn, or the dispatcher is stuck, and asks the dispatcher for an update every 15 minutes while the owner has written in the last 24 hours; every reply goes through `playground wa send`, in factory status alone (the bundled [whatsapp skill](./extensions/whatsapp/skills/whatsapp/SKILL.md)).

**Slot**:
One turn at a heavy run on this machine: `~/.playground/ops/run-slot.sh <name> -- <command>` takes a run slot by mkdir and gives it back however the run ends ([playbook](./extensions/core/skills/playbook/SKILL.md), the **slots** rule).
