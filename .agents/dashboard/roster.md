- The roster is the file the dispatcher keeps of the agents it dispatched, at `~/.playground/roster.json` (in `$PLAYGROUND_DATA_DIR` when it is set).
  `api/hono/src/lib/dashboard/roster.ts` is its one reader, which any dashboard code that needs the roster imports: `rosterSchema` (zod), and `readRoster()`, cached by the file's mtime, which returns `{ problem, roster }`.
  Each agent is checked on its own and every fault is named in `problem`, an ended row's excepted: an optional key off its schema (a title over 40 characters, a malformed time) is ignored and the agent kept, a bad required key drops that agent alone, a missing file is no roster and no problem, and one that cannot be read (a directory, no permission) is a problem rather than an error.
  The dispatcher and its leads write it, only through `scripts/roster.ts` in the main checkout; the dashboard only reads it.
  Its shape, keys A to Z, unknown keys ignored, times ISO 8601 with an offset (`date -u +%FT%TZ`), optional keys omitted when unknown:

  ```json
  {
    "agents": [
      {
        "backlogNext": "1",
        "backlogTaken": "2",
        "kind": "builder",
        "name": "the Builder",
        "role": "manager",
        "status": "working",
        "task": "Lead the workers",
        "title": "Lead: workers"
      },
      {
        "branch": "feat/agents-app",
        "eta": "2026-10-05T22:40:00Z",
        "kind": "worker",
        "lastReport": "Plan sent",
        "lastReportAt": "2026-10-05T22:09:11Z",
        "name": "worker-lust",
        "pr": "https://github.com/acme/app/pull/37",
        "repo": "acme/app",
        "role": "worker",
        "status": "working",
        "task": "Dashboard: what every agent is doing, what is queued, what needs you",
        "title": "Dashboard home",
        "workspace": "workspace:52"
      },
      {
        "kind": "reviewer",
        "name": "reviewer-lust-37",
        "pr": "https://github.com/acme/app/pull/37",
        "role": "worker",
        "status": "working",
        "task": "Review PR 37 round by round until it scores 5/5",
        "worker": "worker-lust"
      }
    ],
    "backlog": [
      "P2b: the stream folds newlines in multi-line messages",
      "An ETA beside every working agent",
      "Fix: pglaunch publishes on every interface"
    ],
    "updatedAt": "2026-10-05T22:10:00Z"
  }
  ```

  `name` (the session's full name), `role` (`manager`, `worker` or `runner`), `status` (one word from `scripts/roster-statuses.json`, which roster.ts checks on every write) and `task` are required; `title` is the triaged task title, at most 40 characters.
  `kind` says what the session is, whatever its name: one of `ROSTER_KINDS` in `packages/config/src/kinds.ts` (assistant, builder, dispatcher, ops, optimizer, orchestrator, planner, probe, researcher, reviewer, runner, tester, worker), which spawn.sh writes at every start;
  `roleOf` in `workers.ts` places a session by it before its name's prefix (a dispatcher by its name still, a probe in Other), and an unknown kind is named and ignored, the agent kept.
  `slot` is a dispatcher's slot, `2` for the second (Bravo), which spawn.sh writes for a second `<id>-dispatcher` and `roster.ts who dispatcher` reads.
  `memory` is the session's auto-memory trial arm, `on` or `off`, which spawn.sh writes at every start and a resume keeps ([ADR 0022](../adr/0022-auto-memory-runs-as-a-reviewed-trial.md)).
  `eta` is when a worker expects its chore done, the time it last sent its lead (playbook's **eta** rule); the sidebar row's tooltip counts down to it on a worker that is working, fixing or stuck (`timeLeft` in `web/next/src/lib/agents.ts`), showing nothing once it passes, once its pull request is merged or while it sits paused on a usage limit,
  and one that is not a time is named and ignored.
  `backlog` lists what is queued for the next free agent, in the order it was queued, and only grows (playbook's ROSTER.md says which entry a slot takes next): the lead that dispatches from it keeps two marks on its own entry,
  `backlogNext` (0-based, every entry below it settled) and `backlogTaken` (the indices at or past it settled already, dispatched out of turn, folded into a lane or dropped), each read as roster.ts writes it (`"5"`, `"3 7"`) or as a JSON number or array,
  from the builder's entry alone (`managerOf(agents, "builder")` in `packages/config/src/kinds.ts`, the rule `roster.ts who builder` prints, `builder` until a builder of another name is live), so a stray mark elsewhere hides nothing; with none, the cursor is 0 and nothing is taken.
  The dashboard shows the entries still waiting as Next up: `Fix: ` entries (live breakage or security), then `<PLAYGROUND_OWNER_NAME>: ` entries (what the owner asked for themself, `queued()` in `api/hono/src/lib/dashboard/agents.ts`), then the rest, each oldest first (a free slot takes a `Fix: ` entry, else an org's one, and the Planner folds the rest into its lanes);
  a backlog that is not a list of strings is named and read as empty.
  `schedule` is when a runner runs, `always` or a 5-field cron (`0 5 * * *`), which its sidebar row's tooltip holds.
  `ticket` (a Linear ID, such as `FIX-1234`) is the ticket the agent works on, which its sidebar row shows before its title.
  `worker` is a reviewer's or tester's own worker, by its full name, set when the worker spawns it, so its row nests under that worker whatever the two are named.
  `prs` lists every PR a reviewer or tester serves, its `pr` among them, a PR not yet opened as its issue's URL, and an extension item it scores as `<scope>/<kind>/<key>`, which the dashboard shows nowhere and its restart passes on through `--pr` beside a pull request.
  roster.ts gives a checker's row a new entry only beside a live `worker`; `roster.ts assign` adds each next PR, and `spawn.sh --pr` sets an ended row's `prs` and `pr` (the first pull URL named) and joins a live row's `prs`, giving a row with no `pr` the first pull URL named;
  auto-end (`scripts/ops/optimizer/auto_end.ts`) keeps the checker while any of them is open, and the dashboard's restart reads `pr` and `prs` to pass `--pr` (`restartPrs()` in `api/hono/src/lib/dashboard/restart.ts`).
  `hold` is what a parked row waits on, `#<n>` (an issue or PR), `#i<n>` (an Inbox item) or `d-<n>` (a decision), which roster.ts requires on a park and `playground sweep` reads (playbook's ROSTER.md); the dashboard does not read it.
  `branch`, `repo` (`owner/name`) and `pr` (a GitHub pull request URL) say where the work went, and the dashboard uses them when the session is down, its checkout is on a default branch, or another live session shares its checkout; a session on a branch of its own shows that branch's pull request instead.
  `lastReport` and `lastReportAt` stand in for a report the transcript does not hold; the later of the two is shown, and a time more than five minutes ahead of the clock counts as none.
  A roster agent pairs with the live session of its name, or of that name without its role prefix (`worker-greed` with a session launched as `greed`), else with the one session in its `workspace` (`workspace:<n>`).
