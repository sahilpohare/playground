# Sweep (leads)

Each lead sweeps its own agents every 15 minutes, from a session cron job kept running as [SESSIONS.md](SESSIONS.md#keep-the-sweep-running) says.
The cron is the backstop: every event a lead acts on already reaches it as a message (a worker's ready CI, ops-sweep's alerts), and each turn re-reads the lead's whole context, so the Builder's sweep spends one call while nothing has changed, and Ops' adds only step 2's reads (Inbox #i706).
A sweep is the lead's one look at its sessions between turns: it finds each agent's state and acts on it, so nothing waits unseen.
Work the steps in order.

## 1. Read what changed

Run `playground sweep <your name>`.
It prints only what changed since your last sweep, one line each: a new alert from `ops/alerts-pending.json`, the merge queue when it changes, load5 (the third field of `sysctl -n vm.loadavg`) crossing 15,
the single-slot flag turning on or off or moving between held by load and lifted under the cap, each of your roster rows whose ETA has passed, and for Ops, once an hour, each ops switch on with its age and reason;
its cursor is `sweep/<your name>.json` in the data folder.
A parked row's passed ETA reads `parked past eta` where any other row's reads `eta passed`, and its `hold` ([ROSTER.md](ROSTER.md)) prints once when it has closed (`parked on closed hold`), and once when it reads as neither open nor closed (`parked hold unreadable`).
For each `switch on:` line, Ops checks whether its reason still holds: one that does is set again with a fresh reason through `run-slot.sh set`, and any other is lifted by moving it to `<name>.lifted-<ts>` ([scripts/ops/README.md](../../../../scripts/ops/README.md#ops-switches)); `run-slot.focus` ends only with `playground focus off`, which lifts its merge hold too.
`run-slot.battery` is ops-awake's, so Ops leaves it standing, since ops-awake lifts it on the check that sees the charge rise.
When it prints `quiet`, the Builder's sweep ends there, and Ops' goes on to step 2 and ends after it.

Done when it printed `quiet` and your sweep has ended (Ops' after step 2), or you have each line it printed in hand for the steps below.

## 2. Run Ops' extra reads (Ops)

Ops' sweep takes every probe (its roster kind `probe`, else a `probe-*` or `<id>-probe` name) into step 3 as its own.
On a machine that runs the relay, runner-plain-relay (its roster row or its resume record), the outbox's ops lines reach their `to` through it,
and it runs `outbox/relay.py` and owns its cursor ([LIFECYCLE.md](LIFECYCLE.md#starts-and-ends), ops-tick's relay watch and the line that starts "The relay, runner-plain-relay"), so the sweep runs neither relay.py nor `drain.py` beside it (`drain.py` fights relay.py's cursor and sends lines twice).
On a machine with no `outbox/relay.py`, the sweep is the relay: it runs `bun run --cwd <main checkout> ops:outbox`, which prints each line queued since its last run as JSON, oldest first, and sends each one's `text` to its `to` with `SendMessage`; its first run prints nothing and starts the cursor at every queue's end, and it refuses an outbox where relay.py sits.
ops-tick's relay watch times this sweep there and tells Ops, then the dispatcher once Ops has not picked it up, when it runs late ([LIFECYCLE.md](LIFECYCLE.md#starts-and-ends), the relay watch).
It also runs `python3 -I <main checkout>/scripts/ops/up.py --sessions` and sends each session that a `runs without the factory's hooks` line names (one resumed without its settings where its own folder's settings lack the hooks) to the one it reports to (the dispatcher's to Ops), to respawn by [SESSIONS.md](SESSIONS.md#spawn).

Done when every probe is in step 3's list, every line `ops:outbox` printed has gone to its `to`, and every session a `runs without the factory's hooks` line names is with the one it reports to.

## 3. Act on each agent's state

For every agent of yours that `ListAgents` lists, or the roster shows with a status other than `ended`, find which of these it is ([SESSIONS.md](SESSIONS.md#check-a-session) reads a session's state) and act:

- **Waiting** on a picker, which **ask** keeps factory sessions from raising: end it by a close and a resume whose brief gives the answer when a rule or a sound default decides it, or has the session post anything only the owner decides to the Inbox; otherwise leave it for the owner in that pane ([SESSIONS.md](SESSIONS.md#answer-a-picker)).
- **Stuck** on a permission prompt: allow it when the command is needed, else deny it with a simpler shape ([SESSIONS.md](SESSIONS.md#answer-a-permission-prompt), **unstick**).
  When the command's shape prompted (a shell wrapper, a compound one-liner), deny it and have the session rerun it as plain commands.
  When the action itself prompted and you cannot judge it (a delete, a protected path), deny it and send it to the dispatcher as a decision, which it posts (**ask**).
  An allow is your own call as its manager, never presented as the owner's, and the action never moves to another session to dodge the prompt.
- **Idle**, and its last turn ended without a report to you: ask it for its report, unless it idles under an urgent ticket's stop, which holds it idle until the all-clear (its brief's **stop**).
- **Silent**: a worker with no push and no report to you for 60 minutes after a review round, the time under a stop left out (one worker chased a side bug for 3.5 hours unreported).
  Ask it why, then record its answer in the roster or redirect it.
- **Off scope**: a worker chasing a bug outside its chore.
  Have it file the bug as its own issue at once (an issue in the repo where the bug's work lives, by [ADR 0016](../../../../.agents/adr/0016-playground-is-generic-with-a-small-core.md); a work-org ticket goes up the chain under **tickets**) and go back to its chore, unless the bug blocks its PR.
- **Down**: `ListAgents` lists no session by that name.
  Close what is left of it ([End](SESSIONS.md#end): by its surface, or by its workspace when it is the last one there), end it in the roster with the reason, and re-dispatch its chore when one is unfinished.
- **Done**: its roster entry reads `ended`, or its PR has merged and its final report is in, and its session is still live.
  Ending is automatic ([End](SESSIONS.md#end)); act on its `Not ended` line, then close it by hand, its checkers first, and on a `Kept` line reassign the worker or close it.

Before you staff a fix this step turns up (an off-scope bug, a down worker's chore), run DISPATCH.md's **open-PR check** on it.

When spawn.sh's load gate refuses a worker's new checker, give that PR to a reviewer already running, one `ListAgents` lists when you check it before the PR moves (a done worker's, before you close it), as another PR in its own rounds, reporting to that PR's worker, since a running reviewer adds no load.
Move its roster row in the same step, by [ROSTER.md](ROSTER.md)'s `A checker takes another PR` row, so the sidebar nests it under its new worker and run-slot ranks its runs by that worker's size (a stale row once queued a reviewer's install 1,211 s for a 0 s run).
`assign` on a checker whose row reads `ended` sets it to `working` and starts nothing itself: only while ops-herdr still owes that server a restore (`<server>.restore`, kept while any session waits) does its next cycle resume the checker from its record, within a minute when that resume passes its gate.
So give the PR to one `ListAgents` lists, since one assign on an ended checker once left a PR with two reviewers; to bring an ended checker back on purpose, resume it by [SESSIONS.md](SESSIONS.md#end)'s `spawn.sh resume <name> <dir> --pr <its PR's URL>`, and it is back once `ListAgents` lists it.
With no reviewer `ListAgents` lists, that PR's checker is **held**: the worker reports the refusal to you, and you hold the PR on your list, since a refused start leaves only a `capacity.jsonl` row, which names the session and starts nothing.
When a slot opens, the held checker starts in it ahead of any dispatch ([ROSTER.md](ROSTER.md)'s step 1): tell its worker to spawn it again.
Done when each held checker's roster row reads `working` and `ListAgents` lists it.

Done when every agent of yours is working, has reported, or has had its state acted on and recorded.

## 4. Run the recovery scan and chase stalled PRs (the Builder)

The Builder runs code-review-loop's [recovery scan](../code-review-loop/SKILL.md#the-recovery-scan) and acts on every row it leaves, and chases at once each `pr-stalled` entry in `~/.playground/ops/alerts-pending.json`, leaving a PR whose sessions idle under an urgent ticket's stop until the all-clear.
ops-sweep writes them to `ops/alerts-prs.json` every 5 minutes (`stalledPrs` in `packages/scripts/src/ops-sweep/sweep.ts`) and ops-unstick folds that in, one entry per open PR of ours in the factory repo, and per PR a live roster row names (its `pr` or `prs`) in any other repo, for either reason:

- an idle PR: no opening, new commit, verdict or comment for 30 minutes (after one sat two hours unnoticed), unless it waits on its checks or merge-on-ready;
- a repeated score: its last 4 ReviewBot verdicts hold one score below 5, its line reading like `last 4 verdicts 3/5, round 12`, since each fresh round resets the idle clock (one PR parked after 12 rounds, all 3/5).

A PR held on purpose is left out: one with a park or hold label, or whose body or newest comment has a line opening with `Held:` or `Parked:`.

For a repeated score, the Builder picks one of three with the PR's worker, since another round of the same fix scores the same:

- narrow the change to a literal list of the cases it handles;
- move the guard to a layer that parses no shell;
- park it with the workaround written down, in its body's line opening with `Parked:`.

Every clean-or-conflict call (a head that conflicts with canary, or one behind it) comes from a tool that reads git's exit code, never a tree line read by eye: `bun run pr:train forecast` for the queue, `bun run pr:merge <n> --explain` for one PR, whose first line says whether its head merges clean with canary now and as which tree,
or the files it conflicts in.

Done when every row the recovery scan leaves and every stalled PR is acted on, each repeated score's pick named in the Builder's message to the worker.

## 5. Act on your Inbox decisions

Run `playground ask get <id> --ack` (it runs in the live Dashboard's checkout; any other has its own database) for each Inbox decision your roster entry still lists ([ROSTER.md](ROSTER.md)),
act on each whose `status` is no longer `open` (`approved`, `denied`, `sent`, `drafted`, `discarded`, `cleared` or `provided`, with the owner's note in `answer.note` and a draft's changed words in `answer.editedText`),
and take its id off the list once it is closed: a go with `playground ask ack <id> --link <url>` or `--no-link "<why>"` after you carry it out, a deny, a clear, a discard or a provided secret by that read.
Ops also checks the `asks` on the dispatcher's entry and sends the dispatcher any answer it missed.
ops-sweep chases an answer of the owner's its poster has not acked (`bun run ask stale`; on 9 Oct, 11 answers failed unseen and #i76's Send never went out), reminding each live poster once, then at most every 4 hours, so a lead hears only `stale-poster-down` findings: an answer whose poster is down, which Ops passes to the Builder to carry out or re-dispatch.
An answer the dashboard relayed to the dispatcher because its poster had ended (its `[inbox-answer]` line carries `relay`, `textsOf` in `inbox.ts`) is the dispatcher's to carry out and ack, so the Builder asks the dispatcher before it carries out any `stale-poster-down` answer, and takes only the ones the dispatcher did not receive.
Anything only the owner can answer becomes an Inbox decision (**ask**).

Done when no Inbox decision your roster entry lists has left `open` unacted on, and, for the Builder, every `stale-poster-down` finding is acted on.
