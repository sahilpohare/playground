# Lifecycle

When each kind of factory session starts and ends, what the Dashboard shows for each role, the ops jobs that run with no session, and how the main checkout is restored.
The commands for each start and end are in [SESSIONS.md](SESSIONS.md), and every start and end lands in the roster ([ROSTER.md](ROSTER.md)).

## Roles on the Dashboard

The dashboard lists the dispatcher, and dispatcher-2 while one is started, in the sidebar's header, above the session groups, lists the Planner, both leads, the Optimizer and any other orchestrator, such as the Assistant, under Orchestrators, A to Z by roster title or in the order the owner dragged them into,
nests each checker under the worker whose PR it checks (by the `worker` key on the checker's roster entry, set at spawn, else its `pr`, else its name: `reviewer-sloth-2-sendtop` under `worker-sloth-2`),
and puts probes in Other, where they never wait on the owner.
Each row reads by a plain name with no @: a manager by its role word alone (Builder, Ops, Planner, Optimizer, Assistant, and an orchestrator's with its id, Orchestrator C8m3nr), a worker by its ticket and pull request with no role word (`AB-1591#1598`), else its title, and a reviewer,
tester or runner the same way with its role word after (`AB-1591#1598 Reviewer`, `Keep the dashboard up · runner`).
A new session is named `<id>-<kind>` by `bun run name <kind>`, a checker with an id of its own ([SESSIONS.md](SESSIONS.md#spawn)); one started before keeps the name it has.
A worker's dev stack runs only while it tests: it stops the stack through its own background task once a round of testing ends, and starts it again for the next; anything that must outlive a chore gets a runner.
No session builds or holds a demo stack for the owner, since changes are tried on the live dashboard alone: what he should try reaches him on the live dashboard once it merges into canary, and a tester's stack serves its tests alone.
A **preview worker** holds a combined preview worktree, canary plus the lane heads, so several changes can be checked together before they merge; it is a worktree for diffs, not a demo stack, and serves no one an app.
After every lane push it rebuilds the combination: from `<acc>` = `origin/canary`, for each lane head `h` in turn it takes `tree=$(git merge-tree --write-tree <acc> <h>)`, stopping when that exits 1, a conflict between the lanes, and sets `<acc>` to `$(git commit-tree $tree -p <acc> -p <h> -m preview)`.
It is done when `git diff --stat <acc> HEAD` in the preview worktree reads empty.
When it shows a diff, the hand merge drifted: move the worktree to the rebuilt one with `git -C <preview> checkout --detach <acc>`.
When the stop at a conflict fired, run `git merge-tree --write-tree origin/canary <h>`: a conflict there means lane `h` is behind canary, and its worker merges `canary`; otherwise `h` conflicts with an earlier lane, so tell both lanes' workers and leave `h` out of the preview.

## Starts and ends

The factory's sessions start and end as its work needs them; none of that waits on the owner (a request from outside the chain is the one exception, under [DISPATCH.md](DISPATCH.md)).
Sessions that work together share a workspace as full-height columns ([SPAWN.md](SPAWN.md#layout)): the managers one (the dispatcher, the Planner, the Builder, Ops), and each worker its own, with its checkers and probes beside it.

- **Workers** are spawned by the Builder, one per chore, and close with their checkers once their chore is done.
  A worker ends when its chore is done: its PR merged (or dropped with the Builder's ok), its branch pushed (`git push origin <branch>`), so its commits show on origin even with no PR,
  its probes cleaned up, and its final report sent, naming the pushed head.
  Its worktrees, their containers and its branches go when it ends ([SESSIONS.md](SESSIONS.md#end)'s cleanup), as its reviewer's and tester's do; one the cleanup keeps, named in its lead's line, the nightly clean (below) tries again once its PR is merged or closed, discarding what it holds then, or the lead removes it by hand from the main checkout with `playground rm --worktree <path>`.
  Remove a worktree another session holds only once that session is closed or off the roster and no live session's cwd is inside it: a clean tree is not a free tree, since a reviewer keeps its worktree across PRs (**rounds**).
  `playground rm --worktree` frees one from a roster row naming it by its branch or its own PR's number once that PR has merged or closed and the worktree sits at that PR's head (commits past it keep the hold, named with them), and keeps it held by a row naming it by session name, id or another PR, as a reused review clone's row does.
  It takes only a folder directly under the main checkout's `.claude/worktrees/`, so a tree nested in another goes with its parent, which AGENTS.md's worktree rule prevents.
  The Builder then closes its workspace, which takes any split still open in it, and its slot returns to the pool.
  Ending is automatic, by [SESSIONS.md](SESSIONS.md#end)'s path: `pr:merge` and the train's land end the merged PR's worker, reviewer and tester, and ops-tick's auto-end beat ends the rest every 5 minutes, each with one line to its lead.
  The Builder closes a session by hand only on a `Not ended` line, whose reason names what to fix first, and reassigns or closes a worker on a `Kept` line, whose last PR closed unmerged.
  The Builder may also end a worker mid-chore to drop or reassign the chore, recording why.
  A parked chore gets its branch pushed (`git push origin <branch>`) and a handoff note ([SESSIONS.md](SESSIONS.md#write-a-handoff)), `~/.playground/handoffs/<ID>.md`, and its worker closes, its final report naming the pushed head; the chore restarts later from the note, its branch and its PR.
- **Runners** belong to Ops.
  A long-running job joins an open runner; Ops spawns a runner when none is open, or another one for isolation or load.
  Each job runs as its own background task with its own log and health check, all listed in that runner's roster task.
  Ops closes a runner once it holds no job that is still needed.
- **Ops jobs** Ops runs as scripts with no session (ops-awake, ops-changelog, ops-dashboard, ops-dm-watch, ops-ext-sync, ops-flow, ops-herdr, ops-machine, ops-merge-train, ops-restore, ops-session-resume, ops-sweep, ops-tick, ops-unstick, ops-usage, ops-wa, ops-zai-usage) beat a heartbeat, `~/.playground/ops/<job>.json`,
  named `ops-*.json` so the Dashboard finds a new job by its file alone,
  in the shape `heartbeatSchema` in `api/hono/src/lib/dashboard/ops.ts` reads (`job`, `pid`, `startedAt`, `lastBeatAt`, `lastResult`, `cycleSeconds`), written atomically each beat by a loop that does not wait on the work.
  The Dashboard lists each under Scripts, by its plain name and its `jobs.json` `schedule`: Running while `lastResult` is `ok` and the beat is within three cycles, Waiting while it starts `waiting: ` (a job with nothing to read yet, muted and not broken), Failing on any other result, Down once the beat goes stale, the pid goes or the loop writes `loop exited <code>` or `supervisor exited`.
  Each ops-up pass's render installs and removes the launchd jobs whose label is `com.playground.*`, and leaves any other label alone.
  A launchd job turned on in Settings > Jobs is bootstrapped while `launchctl print` finds it unloaded, so a refused bootstrap is tried again on the next pass.
  Its plist is written into `~/Library/LaunchAgents` only when none is there, and a plist already there stays as it stands.
  A launchd job turned off has its plist there moved to the trash through safe-delete's `jobs-installed` carve-out, which moves `com.playground.*.plist` files alone.
  It is then booted out while `launchctl print` finds it loaded, plist or not; the plist goes first, since ops-tick's pass runs the render and its own bootout ends it.
  A launchd job still unhealthy 3 passes in a row is told to ops once, and told again only after a healthy pass, since launchd alone brings it back.
  ops-dashboard runs the dashboard checkout's own `scripts/ops/dashboard/`, swapping onto it in the same pid at each start and after a roll that changes it (`.agents/dashboard/live.md`).
  ops-merge-train is merge-on-ready, a job and never a worker: every 60 seconds it reads the open PRs' heads and checks, and on any change runs `bun run pr:train ready`, which merges the first PR in queue order whose every gate passes; its beat's `lastResult` is `ok` or the command that failed and why.
  ops-unstick (`scripts/ops/unstick/run.py`) watches for stuck sessions, by the **unstick** rule.
  ops-session-resume is `bun run ops:session-resume` in a checkout of `canary`: every 60 seconds it reads the state each session's hooks write (`session-state/<session id>.json` in the data folder),
  and to each live factory session (never a probe, nor one of the owner's own) at its usage limit whose reset passed a minute ago, unless Claude Code announced it carries on by itself (the **unstick** rule),
  it queues one resume line in the ops outbox, which the relay sends with `SendMessage` (**voice**), and one carry-on line to each such session whose turn a restart lost (its newest state `working`, written before its process started, 2 minutes on, with no Escape after it in the transcript),
  and one to each such session whose state reads `failed` on an API error, alerting its lead and the dispatcher once when a later pass finds the same record still standing or a new failure follows its line within 30 minutes;
  it tells the dispatcher of a live session still `stuck` once the `unstick.escalateMinutes` setting's minutes pass (5 by default, read at each pass), and a live session's manager of one reading `working` with no transcript write for 15 minutes (**unstick**); `--once` runs one cycle with no beat.
  ops-sweep runs from the install's checkout, `{checkout}` in `bunJob`'s default (`packages/settings/src/jobs.ts`), and reads the Dashboard's checkout from its context (`ctx.dashboard`), never from where it runs.
  It is `bun --no-env-file <checkout>/packages/scripts/src/ops-sweep/cli.ts no-headroom`, its `jobs.json` command naming the script by its absolute path so `up.py` keys it by its folder (each word after `cli.ts` a finding known at start and never told):
  every 300 seconds it brings up any ops job that is down, then reads the runners (a parked one is never down), the probes, the managers' asks, the unclosed answers (`bun run ask stale`), the heartbeats, the runner-box route (`run-slot.sh box-off`, a `box-route-off:<reasons>` finding while a run would fall back to the Mac),
  each worker's PR whose head has been ready 20 minutes with no review round and no live reviewer (told to the worker's lead once per head, a parked worker's never),
  each live worker's `PG-` branch, the one its roster row records at first push, whose head is 15 minutes old with no PR, so no CI runs on it (told to the worker's lead once per head, a row holding a `pr` never, every branch in one GraphQL read),
  the open PRs of ours (in another repo, only those a live roster row names) idle 30 minutes or at one sub-5 score 4 verdicts running (`pr-stalled` alerts written to `ops/alerts-prs.json` for ops-unstick, every PR in one GraphQL search, [SWEEP.md](SWEEP.md) step 4) and the usage forecast, writing or removing the week pace's off time by it (`scripts/ops/README.md`'s Usage forecasts),
  and the `playground-*` databases (and the older-named ones) idle 2 hours with no client (never the dashboard's own, found by `POSTGRES_URL`'s port, nor a Checks lane's `playground-chk-<k>-db` while a run holds `ops/checks/lane-chk-<k>.lock`, whose idle clock starts again after), telling ops each finding once, while it is new, and keeping its state in `ops/sweep/` in the state folder.
  Each pass also removes, with `docker rm -fv`, every `playground-test-<suite>-<pid>` container whose pid no longer runs, a killed test run's (`leakedTests`; a pid whose signal is refused counts as running), and logs each removal to `ops/ops-log.md`.
  ops-tick is `bun run ops:tick` in a checkout of `canary`: the factory's timed beats, each at its old cron in machine wall time with no model call, running the same script as before and queueing what it prints in the ops outbox for the seat or session it went to before, through `scripts/ops/notify.sh`, silent when nothing prints:
  the roll gate, the tick (usage marks, whose Inbox week alert at 97% or 98% it keeps in `tick/week-alerts.json` and resolves once `usage.json` reads that account's week under the mark, a `switch due`, load, the train's slot wait, near-limit marks, and the switch watch,
  which at a full week writes ops-unstick's move file while a second dispatcher is seated and tells the dispatchers and both leads),
  the usage-limit watch (each session on the usage-limit screen named to the builder once with its account, and the lowest-week account with its 5-hour window under 90% to move to),
  the auto-end beat every 5 minutes (`scripts/ops/optimizer/auto_end.ts` over `idle_sessions.ts`'s flags, [SESSIONS.md](SESSIONS.md#end)), each end, `Kept` or `Not ended` line to the session's lead, a `Kept` or `Not ended` line once until its words change,
  ops-up every 5 minutes (`scripts/ops/up.py`, each line it prints told to ops once until it changes, so a reboot or a herdr server that went down brings every job back with no hand step, and a reboot plan holds no step that stops the jobs first, since the reboot ends them and this beat starts them again),
  the sweep (each felled session to its lead once, never a probe or one the roster holds done, parked, paused, ended or starting, but runner-plain-relay, the relay itself, whose resume line it runs through spawn.sh's capacity gate at every sweep that prints it, with `--brief brief-runner-plain-relay.md` so the relay starts its wait task again,
  never marked told since a resume keeps the session id and the line returns with the next outage,
  rather than queueing it for a relay that is down, naming the outcome to ops, and load past 30 once a crossing), the GLM credits log line, the optimizer's wake words,
  the canary pull (every clean worktree on `canary` fast-forwarded to origin's head every 5 minutes, a main checkout that follows canary swapping its changed hook bundles in whole first, as `playground update` does ([scripts/hooks/README.md](../../../../scripts/hooks/README.md)),
  its fast-forward and install run back to back inside one run-slot slot when the incoming change touches `bun.lock` or a `package.json`, so no session runs new code on old `node_modules` while the install waits for a slot, and the install runs again each beat until one exits 0, a failed fetch, pull or install told to ops once until its words change),
  the trash purge (hourly, `purgeTrash` of `@packages/safe-delete` removing each batch in the data folder's `trash` over 7 days old, `playground rm`'s and the dashboard's alike, then the oldest while the disk has under 50 GB free, at any load, since deleting the trash is cheap, its one recursive delete, each told mark past the cap's window beside them,
  then `stripTrash` removing each batch's `node_modules` folders and `web/next/.next`, oldest first and paced, which an install or a build rebuilds, one line to `ops/log/trash-purge.log`),
  the idle compact (every 5 minutes, the idle-compact bin from the Dashboard's checkout: `/compact` into each worker or runner idle 50 to 58 minutes at 200k+ tokens with nothing waiting and an empty input box, never a dispatcher or a lead, a trial under ADR 0020, one line a session to `ops/log/idle-compact.log`),
  the nightly clean (3:00 am machine time, `packages/scripts/src/ops-tick/nightly-clean.ts`: each worktree in `.claude/worktrees` whose PR merged or closed, through the merge-time cleanup's `cleanWorktree` ([SESSIONS.md](SESSIONS.md#end)), which keeps one a symlink outside it points into, and one whose merge or close `playground rm` cannot confirm trashed as well,
  under the owner's standing approval, each move restorable with `playground rm --restore`, every move, `cleanWorktree`'s own included, paced under `playground rm`'s 3 a minute so none is refused, and a worktree the pace cannot reach within its 10-minute wait left for the next night;
  then every other repo's worktrees, in each checkout directly in the code root (`paths.codeRoot`, else the folder that holds the checkout) or in `~/<org>` for each org `ext.links` guards, the factory's own aside:
  one goes by `git worktree remove` with no force flag, so git refuses a dirty tree, only when its PR merged or closed (or it has none and a remote holds every commit), it holds nothing but build output, and no live process or roster row has it, its branch kept so `git worktree add <path> <branch>` brings it back, and each one kept is named with why;
  then each folder in the data folder's `scratch/` whose session is gone, no live session and no roster row whose status is not `ended` sharing its leading id, moved to the trash under that session's own name, the route `playground rm` gives a session for its own scratch, each restorable with `playground rm --restore`;
  then local branches merged into `origin/canary`,
  local and remote branches a merged or closed PR still holds at its head, and an unmerged branch with no PR, whose head is tagged `archive/<branch>` on origin before any delete, so the tag holds it and `git branch <name> archive/<branch>` brings the branch back, one whose tag cannot be made, or whose origin head is not the local head, kept and named in the log,
  and one whose head GitHub does not hold (a branch never pushed) kept with a local `archive/<branch>` tag alone, since a push would publish its commits, named the night that tag is made or re-pointed to the branch's head and on no night after, an old head no ancestor of the new one first kept at a tag of its own, `archive/<branch>-<old7>` (its first 7 characters),
  which `git branch <name> archive/<branch>-<old7>` brings back, and when that tag cannot be made the old tag stays as it is and the log names why;
  each exited `playground-<worktree>-db` or `-redis` container whose folder is gone, with `docker rm -fv`, dangling Docker images, the build cache, and the shared turbo cache `~/.cache/turbo/playground`'s files over 2 days old;
  every other container (the live dashboard's database, pglaunch's, a Vibeground copy, a running one, any other name) and every volume stays; a container over 1 GB (but the live dashboard's, pglaunch's and a Vibeground copy), an unused volume over 1 GB and a container whose removal failed are each named as kept;
  one line to `ops/log/nightly-clean.log` with the free disk before and after and each step's measured change, one outbox line to ops naming each removal with its trash id, archive tag, container name or `git worktree remove` and each keep with why, and an Inbox update when it freed 1 GB or more, linking the System page; it asks no decision),
  the dashboard watch (every minute: once the live dashboard's `/api/health` has failed 5 minutes in a row, a gap of over 2 minutes with no check starting the count again, one macOS banner and one ops line through `notify.sh` with `NOTIFY_MAC=1`, since the Inbox shows only on the dashboard, and one more when it answers again,
  its state in `ops/tick/dashboard-watch.json`), the relay watch (every 5 minutes:
  a line the relay would send, read by ops-outbox's `pending()`, is timed from the first cycle it reads pending, and once it has waited 10 minutes with no relay cursor moved since, the stop goes to the session that can act on it, the way unstick routes a stuck session:
  one line into the managers' waiter queue (`ops-stuck-alert.jsonl`, stuck-alert's own shape, which each alerts-wait reads within seconds without the relay, the stalled relay or sweep being the thing the stop names), then one for the dispatcher once `unstick.escalateMinutes` (5 by default) has passed with Ops yet to pick it up,
  telling it to post to the owner's Inbox only if it cannot resolve the stop;
  the Inbox alert update under the ops manager's name (`bun run ask new`, resolved with `bun run ask resolve` once a cursor moves or its item is gone) is for the owner alone, and posts only while Ops itself is down, while no alerts-wait of its own is live (`waiterLive`), the one absence no other check reports;
  while `ops/sweep-hold-until` holds a future ISO 8601 time with its zone, the watch keeps quiet, resolving an open alert of its own first and clearing its state, so it judges unheld time only, and a missing, empty, past or unreadable time leaves it on;
  Ops sets the file when it slows or pauses its sweep on purpose, a usage squeeze or maintenance (SESSIONS.md, Keep the sweep running), renewing it or leaving it to pass;
  the line says to resume runner-plain-relay on a machine with that session's roster row or resume record;
  a machine with neither relays through Ops' sweep (SWEEP.md step 2), so there a line may wait 30 minutes, two sweeps, and the line says Ops' sweep is late and Ops runs it, naming no relay session;
  with no `cursor.json`, a relay that has never run, the lines queued since the watch first found none (`ops/tick/relay-watch-start`) count as waiting, and the line says the outbox relay has never run),
  the focus card (every minute: once `playground focus` has ended, by `off` or at its end, one Inbox update under the ops manager's name naming the runs that queued while it stood and their wait, kept in `tick/focus-cards.json` and resolved once `bun run ask open --since <start> --until <end>` lists no ask posted while focus stood,
  then its record set aside as `.ended-<ts>`: `focus.json`, or the `.uncarded-<since>` copy an `on` makes of a lapsed one the beat has not carded yet, oldest first, `focusCard` in `packages/scripts/src/playground/focus.ts`),
  the priority lapse (every 5 minutes: each window `playground priority on` opened that has stood `LAPSE_HOURS`, set aside as `.lifted-<ts>` with a line in `ops/priority.log` and the same line to ops, another writer's priority file left whatever its age, `lapse` in `packages/scripts/src/playground/priority.ts`),
  the run-slot hold (every 5 minutes: each hold of one of the four heavy lanes, run-slot to run-slot-4, past 30 minutes while a live waiter is queued, told to ops once per hold, naming the holder, its slot, its age and the command `run-slot.runs.log` asked it for, `runSlotHold` in `packages/scripts/src/ops-tick/tick.ts`),
  and the guard probe (every 10 minutes: each PreToolUse guard the factory settings register run on `{}` from its bundle, else its source, without its wrapper's tail, and each that exits other than 0 or 2 named to the dispatcher with the fix, once a change of what is broken, [Restoring the main checkout](#restoring-the-main-checkout));
  `--dry` prints each beat's next due time and target, and `--once <beat>` runs one beat now.
  The relay, runner-plain-relay, sends every line `outbox/relay.py` prints to its `to`, since relay.py applies quiet mode before it prints; only the drops the relay's brief names hold a line back.
  ops-flow is `bun run ops:flow` in a checkout of `canary`, disabled in `jobs.json` by default until its registry setting `jobs.opsFlow` turns it on: while on, every 60 seconds it reads the process table and each run-slot `.holder`,
  and queues one line each for the builder and ops seats (`roster.ts who`) in the ops outbox when one session has held a run slot for 15 minutes, naming the holder, its command and its age; each hold alerts once, again only after it clears and comes back, and it signals nothing; `--once` runs one cycle with no beat.
  While it is off, ops-tick's run-slot hold beat (above) is the alert for a run-slot hold that blocks others: ops-flow tells both leads of any hold at 15 minutes, a model slot's at 120 (`MODEL_HOLD_MS`), while the beat tells ops at 30 minutes, and only while a live waiter is queued.
  ops-ext-sync is `bun run ops:ext-sync`, off until its registry setting `jobs.opsExtSync` is enabled (`packages/settings/src/jobs.ts`).
  At 02:30 machine time it syncs each scope's clone in the data folder's `extensions/` with its private repository, `<login>/playground-<scope>` unless the setting `ext.repos` names another: a pull with rebase, then a push, so every machine's commits meet in one history.
  It scans every file with the extensions' secret shapes and the history with gitleaks when installed, and pushes only when clean; a public repository is refused, a scope with no repository stays on the machine, a refusal or failure goes to ops naming the scope, the file and the kind of secret, never its text, and `--once [<scope>]` runs one sync.
  ops-zai-usage is `bun run ops:zai-usage`: every 5 minutes it reads Z.ai's quota endpoint, retrying for about 2 minutes a fetch that never reached Z.ai (DNS or the network just after boot),
  writes `zai-usage.json`, the readings the GLM spawn gate reads, with `balance` marked empty for an hour after a session-state record's `balance` failure (the quota endpoint never reports the balance) and `error` over the last windows on a failed read, and beats its own heartbeat;
  `--once` runs one read and writes only `zai-usage.json`, no beat.
  Five jobs took over what runners held as background tasks, each `bun <checkout>/packages/scripts/src/<job>/cli.ts` with its script named by absolute path, so `up.py` keys it by its folder:
  ops-awake holds `caffeinate -s -i` by default, the system awake on AC power and on battery with the display free to sleep and lock (#i19); the repo job alone reads `ops-awake.json` in its data folder, so a machine whose file sets `"lidSleep": true` runs `caffeinate -i` after a restart, to sleep with its lid shut, while a launchd `awake/run.sh` keeps its own flags and reads no setting.
  Add ops-awake to `jobs.json` only on a Mac with no launchd `com.playground.ops-awake`, since both would post the same battery alerts; the repo job runs the battery check each minute (`ops-awake/battery.ts`), as a launchd `awake/run.sh` runs its own where it is installed, and the repo job's check alone pauses the heavy runs at the red mark through `run-slot.battery` (the **battery** rule).
  ops-awake and ops-machine write only under the data folder their `--data` names, which the jobs render passes; run with no `--data` from any checkout but the live dashboard's, each exits 2 before it writes.
  ops-changelog (`bun run changelog sync`, `4-59/5 * * * *`, skipped quietly while a `bun run changelog seed` runs) runs from the live dashboard's checkout, the one holding the database's `.env`, as its runner's cron did:
  skipped with a line to ops while load5 (the third field of `sysctl -n vm.loadavg`) passes 12 or memory pressure reads critical, never overlapping, its output appended to `dashboard-changelog.log` in the data folder, and a failure sent to ops with its last 5 lines.
  ops-channel-watch is the factory channel's watch: a quick pass every 3 minutes and a full one, which also relays edits, at minutes 7 and 37, each new post sent to the dispatcher as one outbox line; each pass runs `watch.ts` under `vault.py run -e SLACK_TOKEN=local.slack.channel_token`, so the token reaches only that process.
  Each pass reads the `channel.slackId` setting first, and while it is unset prints one quiet line and ends before the vault lookup; otherwise a failure goes to ops once per kind until a pass succeeds, a missing vault as `the vault is not installed` with how to install one.
  Add ops-changelog this way only on a Mac whose `jobs.json` has no job by that name, and ops-channel-watch only on the Mac of the Slack member the `channel.skipUser` setting names, since the watch relays every post but that member's own.
  ops-dm-watch (`jobs.opsDmWatch`, off by default) is the owner's DM watch in Slack mode (the bundled `slack` extension's `slack` skill): each minute, while `slack.mode` is on and `slack.dmChannel` and `slack.dmOwner` are set, it runs that skill's `scripts/watch.ts`, which reads the token from the Keychain's `slack` item itself,
  which sends each new owner message to the dispatcher in full and to the session in the assistant seat (`roster.ts who assistant`; with none, it logs that the message stays with the dispatcher)
  when none is answered in 3 minutes while the dispatcher is not mid-turn (its session state `working` and written in the last 3 minutes), or the dispatcher's session state has read stuck or failed for 3 minutes, telling Ops of that once through ops-unstick's outbox;
  every 15 minutes it tells the dispatcher to post an update, and a failure goes to ops once per kind until a pass succeeds, the extension turned off as `Slack is not set up here`.
  ops-wa (`jobs.opsWa`, off by default) holds the WhatsApp link on the spare number (ADR 0023): while `wa.owner` and `wa.device` are set, it links as a device by a pairing code it posts as an Inbox card, and only once `no-raw-wa` is registered in `scripts/factory-settings.json` (it beats `stopped: ` with that reason until then),
  sends each 1:1 owner message to the dispatcher whole through the relay, which logs its length alone, a photo or voice note as its path in `<data>/wa/media/` with a voice note's words when whisper.cpp can read it (`packages/scripts/src/ops-wa/media.ts`), and drops every other message and call with one line in `whatsapp/dropped.log`;
  `playground wa send <file>` is the one way out, to the owner alone, and the ban-safety habits in `packages/scripts/src/ops-wa/habits.ts` hold every connect and send.
  It hands messages on only in WhatsApp mode, the bundled `whatsapp` extension's switch (`ext.bundled`), and otherwise answers the owner once an hour that the mode is off;
  in the mode, a message with no reply in 3 minutes while the dispatcher is not mid-turn, or any while the dispatcher reads stuck or failed, goes to the session in the assistant seat too, and every 15 minutes while the owner has written in the last 24 hours it asks the dispatcher for an update.
  In that window it also sends the owner each open factory `ask` decision and update once, redacted and its choices numbered, and every other card as one `N cards wait in the Inbox` line, and the owner's `1 #i12` answers that card through `bun run ask whatsapp` ([ADR 0024](../../../../.agents/adr/0024-the-owners-whatsapp-answers-an-inbox-card.md)).
  It beats `ok` only while the linked device is connected, `waiting: ` while it connects, until both numbers are set and while its pairing code waits to be typed on the spare phone, and once stopped (12 failed connects in a row, a logout, a lock another process holds) it stays up beating `stopped: <why>`, so up.py leaves it be until the job starts again.
  ops-herdr is `bun run ops:herdr` in the main checkout: every minute it starts each herdr server that is down, `playground` for every session and `playground-probes` for drills, upgrades and shell panes (names of Playground's own, since herdr keeps each server's state and logs under `~/.config/herdr/sessions/<name>`), under `env -i` with HOME, LANG, LOGNAME, PATH, SHELL, TERM and USER alone,
  on the absolute path the repo's `packages/scripts/src/ops-herdr/pin.json` names, as launchd's child, so stopping the job leaves it running.
  It refuses to start a binary whose version or sha256 differs from the pin and beats the mismatch, naming both, and never restarts a running server, since a stop exits every pane.
  Once it has started a server, any of `PLAYGROUND_HERDR_SESSIONS` (`playground,playground-probes` by default; a name that is not a word is named on its beat and skipped), it runs `spawn.sh restore` ([SPAWN.md](SPAWN.md#--runtime-herdr-and-restore)) pointed at that server,
  which resumes the sessions whose records name it and whose roster rows are not done, ended, parked or paused, each row read again once its resume finds the session gone, so a session `spawn.sh close` ended stays down, the first dispatcher first and past every gate, and again each cycle while a gate or focus holds one of them,
  printing one line of counts (restored, already running, down in the roster, passed over, waiting on each gate or focus, not restored) once, the waits as progress that keeps the beat ok and Start green, a failed restore's as its beat's problem with the log's path, and writing each session's line to `<server>.restore.log` in the herdr folder;
  `<session>.restore` beside the server's socket marks a restore still owed, set as the server starts, kept while a session waits or a restore tried none (another restore's lock, an unreadable roster), and cleared once every session is back or not restored, so the job finishes one that `start` (`bun run dev`, the dispatcher) began, or gave up on at 10s, and the gate cut short;
  herdr's own resume stays off in the pinned config (`resume_agents_on_restore = false`), since it runs a bare `claude --resume` without the session's settings.
  It copies `config.toml` from beside the pin into `~/.playground/herdr/`, so both change only through a merged PR, and applies a changed config with `server reload-config`; it copies the pin there too, for the scripts that open herdr panes.
  Its `lastResult` names a pin mismatch, a server it could not start or read, and every config warning in the server's log since its last start or reload, since herdr falls back to a default with only a warning.
  Each server's socket is `$HOME/.playground/herdr/<session>.sock`, reached with `HERDR_SESSION`, `HERDR_SOCKET_PATH` and `HERDR_CONFIG_PATH` set (`--session` would ignore the socket path); its state and log stay in `~/.config/herdr/sessions/<session>/`, so the socket follows `$HOME` too, never `$CLAUDE_CONFIG_DIR`, and every Claude login reaches the same servers.
  `start` runs one check and exits (`bun run dev` on the live dashboard or an own clone runs the main checkout's, never the dashboard checkout's), `stop <session>` refuses while the session holds a pane and names each (`stop default` stops herdr's own default server on `~/.config/herdr/herdr.sock`, which no job starts, refusing only while one of its panes runs an agent),
  `attach <session>` opens a client on a running server with its environment alone (prefix `ctrl+alt+b`), refusing a binary off the pin or a server that is down, `status` prints one line a server (down, or up with the sessions its panes hold), and `env-check`, run inside a pane, prints its environment as names and lengths only.
- **The `playground` command** (`dispatcher` is its name from before the rename) is the owner's way in from his own terminal, linked into `~/.bun/bin` by `scripts/link-skills.sh`; `playground --help` and the docs site's `/docs/cli` give its words.
  Bare `dispatcher` first runs ops-herdr's `start`, so it brings back every herdr server that is down and names each it started; then, from any terminal while the Dashboard's API does not answer 200 on `/api/health` (portless's 404 for a stack that is down is no answer), it runs ops-up (`scripts/ops/up.py`), which starts each ops job that is not healthy,
  ops-dashboard's stack and follower among them;
  it starts no Claude session, and names a missing dispatcher for you to start.
  Before ops-up it sets the Dashboard's database container (the `live.container` setting's) to restart with Docker and starts it when stopped, saying so in one line each (`ensureDatabase` in `packages/scripts/src/playground/database.ts`).
  Then it waits for the Dashboard's API, printing a progress line every 10s, and stops with an error once ops-dashboard's supervisor is gone or its heartbeat is past three cycles, else at 15 minutes (`waitOutcome` in `packages/scripts/src/playground/plan.ts`).
  It also stops on a START or RESTART roll begun after the database step that failed on the stack, in the supervisor's own words (`startFailure`); each early stop waits out a 30s grace for the start.
  Every job ops starts in a terminal (`runtime: "herdr"` in `~/.playground/ops/jobs.json`) runs as a pane labelled with its name in the Ops workspace on the factory herdr server, by the binary herdr's `pin.json` names,
  skipped while herdr fails spawn.sh's checks (its pin's sha256, its version, its server's socket and that server running).
  A job row an older install stored keeps its job: its runtime, whatever word it holds, reads as `herdr`, and a key the schema does not name is dropped on the read (`fromStored` in `packages/settings/src/jobs.ts`), so it starts in herdr on the next pass, from any terminal.
  A start that fails is logged whole in `up.log` and tried again on the next pass, with no GRACE wait.
  `playground add` starts one session through `spawn.sh` under all its gates, one start at a time (`~/.playground/spawn.lock`), under a name from `bun run name <kind>` or a given name that gives its kind, as spawn.sh asks.
  `playground view` runs ops-herdr's `attach factory`, opening the server the sessions run on, and takes no other word; probes stay on their own server.
  `playground update` touches ops-dashboard's `roll-now`, and `playground status` only reads, ops-herdr's `status` lines among its own.
  `playground sweep <lead>` reads what changed since that lead's last sweep and prints it, or `quiet`, writing only its cursor, `sweep/<lead>.json` in the data folder ([SWEEP.md](SWEEP.md)).
  `playground focus on --session <name> --reason "<why>" [--for <minutes>]` gives one session the Mac for up to 180 minutes (120 by default), recorded in the data folder's `focus.json`.
  While it stands, held-prs.json's `"*"` line holds every merge, `run-slot.focus` holds every other session's heavy run while ops-tick's, the dashboard's and the focused session's own reviewer's and tester's go on ([scripts/ops/README.md](../../../../scripts/ops/README.md#ops-switches)), and spawn.sh refuses every new session but that reviewer or tester,
  and a `--priority` start while `priority.json`, an org's own `priority-<name>.json`, a session's own window or a job's own `priority-start.json` stands ([scripts/README.md](../../../../scripts/README.md#spawnsh)).
  `playground priority on` opens a session's window and `off` lifts it ([scripts/README.md](../../../../scripts/README.md#spawnsh) holds who may open one).
  For an urgent ticket, Ops runs `run-slot.sh preempt` after focus is on, which stops each run another session already holds a slot with; the run says focus preempted it and to run it again once focus ends.
  What comes into the Inbox meanwhile is held quiet, out of its counts and the tab's dot, but an alert update ([.agents/dashboard/asks.md](../../../../.agents/dashboard/asks.md)).
  Each part ends at the focus end by itself; `playground focus off` ends them early and prints how many runs queued while it stood and how long they waited, measured from `run-slot.runs.log`, the line ops-tick's focus card posts to the Inbox once focus ends either way, and a bare `playground focus` prints the focus standing.
- **Probes** need the ok of their spawner's lead, open as a column in their spawner's workspace, and their spawner closes them by their surface the moment the test is done.
- **The Optimizer** is started by the dispatcher at its own start, with `playground optimizer`, and runs a retro after each ship to `main` and once a day, by the steps in its brief, `scripts/briefs/optimizer.md`.
  On ops-tick's `optimizer tick` (every 2 hours) it runs one once a ship has landed since the last, and on `optimizer daily` once no retro has run for 20 hours, so no day passes without one.
  It stays open between retros, so each beat finds it, and Ops resumes it after a Claude Code update ([Updating Claude Code](#updating-claude-code)).
- **the dispatcher, the Planner, the Builder and Ops** stay open: they never close, except to be respawned with their settings after a restore (below), to be resumed onto a new binary when Claude Code updates ([Updating Claude Code](#updating-claude-code)),
  or from a handoff ([SESSIONS.md](SESSIONS.md#write-a-handoff)) when their guidance changes (a rewritten brief or standing rule their running context contradicts, which the dispatcher names when it sends the change, or Ops when the change is to the dispatcher's own guidance):
  Ops respawns the dispatcher, the Planner and the Builder, the dispatcher respawns Ops, and no two managers restart at once, Ops first and alone when a change reaches it and another, and never as an Inbox item.
  The dispatcher spawns a manager under its fixed name when `ListAgents` lists none.
  A fresh the dispatcher session, after a restart, reads the previous the dispatcher transcript and re-checks its open items against the roster and the managers before it answers the owner.
  A session resumed after any restart, an account switch included, re-arms its background tasks and re-sends its unanswered messages first, by the **context** rule ([rules/context.md](../../rules/context.md)), which the `after-resume` hook puts in front of it.
  When the restart killed a commit mid pre-commit, the same hook names the patch lefthook left in the shared git folder for the session's worktree, `info/lefthook-unstaged.<worktree folder>.patch`, and the session restores it with `git -C <worktree> apply --unidiff-zero <patch>` before any commit ([scripts/hooks/README.md](../../../../scripts/hooks/README.md#after-resume)).
  No session reports Playground as running until its own `ListAgents` lists a session named `dispatcher`; a roster entry, a resume record or a Dashboard row does not count.
  Ops' sweep has each factory session resumed without the factory's hooks respawned with its settings ([SWEEP.md](SWEEP.md)).

A Mac restart clears `/private/tmp`, so every scratchpad is lost.
Anything a session needs across a restart goes under `~/.playground/scratchpad/<name>/`, which the restart leaves alone.
After a restart, a PR body is pulled back with `gh pr view <n> --json body -q .body` before it is edited, so a stale local copy never overwrites the live one.

Every start and every end, with its reason, lands in the roster the moment it happens (**roster**).

A session takes its skills from the copy written when it started (`~/.playground/orgs/<set>/<hash>/`), so after any `playground update` that prints `skills changed`, a ship or the user menu's Update now alike, the session that ran it sends each lead the folders that line names in the main checkout, and a live session reads each changed skill's files there (**release**).

## Updating Claude Code

Factory sessions and sessions started in this checkout update Claude Code only when someone runs the update: `DISABLE_AUTOUPDATER` in `scripts/factory-settings.json` and `.claude/settings.json` turns their background updates off ([Claude Code's setup docs](https://code.claude.com/docs/en/setup#disable-auto-updates)).
A Claude Code session elsewhere on this machine still updates in the background and replaces the one binary every factory session runs, so after any version change you did not run, start at step 1 and skip step 2.
An update deletes the binary every running session was started from, so each one is resumed onto the new one.
Ops runs an update when the owner asks for one:

1. List every running Claude Code process: `deleted` or `live` for its executable, its pid, its folder and its command line, whose `-n` names the session and whose `--resume` or `--session-id` value is what its resume takes.
   A line without `-n` is the owner's own session or a `claude` run outside the factory: tell him.
   A process that exits while the loop runs prints as `deleted`, and step 4's run settles it.

   ```sh
   ps -axo pid=,comm= | awk '$2 == "claude" {print $1}' | while read -r p; do
     f=$(lsof -a -p "$p" -d txt -Fn | sed -n 's/^n//p' | head -1)
     d=$(lsof -a -p "$p" -d cwd -Fn | sed -n 's/^n//p')
     [ -e "$f" ] && s=live || s=deleted
     echo "$s $p $d $(ps -o args= -p "$p")"
   done > "$LIST"
   ```

   **Done when** `$LIST`, a file in your scratchpad you set once, holds one line per `claude` pid.

2. Note what `claude --version` prints, then run `claude update`.
   **Done when** `claude --version` prints a newer version than the one you noted.
3. Resume each named session on the list onto the new binary, one at a time: close it by [SESSIONS.md](SESSIONS.md#end), then run its resume record, `bash ~/.playground/resume/<name>.sh`, which resumes it with the `--account` its start was given, the model it started with and an effort other than high ([SPAWN.md](SPAWN.md#--account) says how a resume picks a login).
   A session with no record resumes with `"${PLAYGROUND_REPO:?}/scripts/spawn.sh" resume <name> <folder> <session-id>`, adding the `--model` and the `--effort` its line shows when it runs on Claude, and `--account` with the account it started on when that is a second account ([SPAWN.md](SPAWN.md#resume), [`--account`](SPAWN.md#--account)).
   A reviewer or tester resumes by running its record's `exec` line by hand (the record forwards no arguments) with `--pr <its PRs, comma-separated>` appended: its roster row's `pr` first, then the rest of its `prs`, read before the close, since spawn.sh sets the ended row's `pr` to the first named ([SPAWN.md](SPAWN.md#modes) holds the `--pr` rule).
   A resume within 15 minutes of its close passes spawn.sh's load gate, since the close keeps when it ended a row that read live and that session already counts in the load, so run each resume right after its close; one later meets the gate as a new start does.
   The managers go in [Starts and ends](#starts-and-ends)'s order, Ops first: Ops sends the dispatcher the list's path and asks for its own resume, and once Ops runs again the dispatcher tells it to carry on at step 3.
   Ops also does dispatcher-2, when one runs, and optimizer; the Builder does its workers, Ops its runners, each worker its checkers, each spawner its probes, and the owner his own; Ops sends `$LIST`'s path to each session that resumes others.
   A session that ended on its own since step 1, its roster row `ended` with a report saying why, stays ended.
   **Done when** every other named session on the list runs again under its name.
4. Run step 1's loop again, into a second file.
   **Done when** no line with `-n` reads `deleted`; each one that does goes back to step 3.

## Restoring the main checkout

Every PreToolUse guard runs from the main checkout and fails closed ([scripts/hooks/README.md](../../../../scripts/hooks/README.md#registered-in-both-settings-files)): with its scripts gone every factory session's Bash is refused, its Edit and Write too, while with only its packages gone the guards still run, since each runs a committed bundle that needs none.
No session can then repair it, so ops-restore does (`packages/scripts/src/ops-restore/cli.ts`, `jobs.opsRestore`, off until the owner turns it on, in Settings > Jobs or by approving the Inbox guard decision Ops posts): a launchd job with no hook, run from the Dashboard's checkout, which a wiped main checkout leaves standing.
Every 5 minutes it reads the guards the factory settings register (the main checkout's while it holds them, else the Dashboard's), and keeps origin's URL in `ops/restore/origin.txt` while the checkout and its own `.git` are whole.
It restores the checkout only once a guard's bundle and source are both gone on two looks in a row, about 5 minutes apart with no gap over 10, while no run slot's holder runs upkeep (`playground update`, `link-skills.sh` or any `bun install`, read by the holder's pid):

1. It puts the files back: `git -C <main checkout> checkout HEAD -- .` while its `.git` is in place, from `HEAD` so a loss already staged comes back too, first keeping `git status --porcelain` whole in `ops/restore/status-<time>.txt`, whose path each report names, and naming in the report whatever else the checkout held besides the loss, since the main checkout stays clean.
   With `.git` gone it restores in place, since a clone refuses the folder the delete left `node_modules`, `.env` and `.claude/worktrees` in: `init`, `remote add origin` with the URL `origin.txt` kept, `fetch origin`, `read-tree origin/main` and the same status file, which reads what differed from origin, then `checkout -f -B main origin/main`.
   Every worktree of the old `.git`, the Dashboard's included, then has lost its link to it, which `git worktree repair` cannot restore against a fresh `.git`, so its report names the loss and Ops reattaches each.
2. It runs `bun install --cwd <main checkout>` through its own checkout's run-slot, then `<main checkout>/scripts/link-skills.sh`, for the hooks and scripts that run from source.
3. It checks the guards again and tells ops and the dispatcher what it did.
   A step that fails is told to them once, naming the step, and the job runs no step again until the guards have come back; a stop that leaves them back (at the install or `link-skills.sh`) is Ops' to finish by hand from a session whose guards start.
   While the guards stay gone, after a stopped restore or with the job turned off, no factory session's Bash runs: that is a true block, so the session that finds it tells the dispatcher by SendMessage, and the owner's way back is one GUI action, the Dashboard's restore control, which runs steps 1 to 3 from the dashboard's server, where no factory Bash runs (not built yet).

With every guard there, the same beat puts back a tracked file modified in place, which `no-main-checkout` keeps every session from restoring: a file `git status --porcelain` reads as ` M`, `M ` or `MM`, on two looks in a row by the same rule and with no upkeep held.
It copies each stray file into its own scratch folder, `scratch/ops-restore/<time>/`, moves that folder to the trash with safe-delete, the undo, runs `git checkout HEAD -- <file>`, and writes one line per file to `ops/log/ops-restore.log` naming the file and its copy's trash path, with no report to a session.
An untracked file, a staged add, a delete and a rename stay as they are.

**Done when** ops-restore's report reads that every guard's script is back, or Ops, else the owner's restore control on a true block, has finished a stopped restore's steps.
