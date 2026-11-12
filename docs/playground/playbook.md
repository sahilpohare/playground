## What it does

`playbook` holds the operating rules of Playground's factory, the Claude Code sessions herdr runs on the owner's behalf: who does what, who reports to whom, how sessions start and end, how the leads keep watch,
and the standing rules (ask, battery, ci, classified, clock, comments, context, correction, dashboard, eta, gate, github, glm, local page, main, memory, override, polling, public, release, roster, rounds, signal, slots, talk, terminal, tickets, unstick, upstream, usage, verify, voice, workers, writing).
It lives in the repo rather than in one session's memory, so every session loads the same rules.

## When to reach for it

| You are, or you are about to                                                                                             | It gives you                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| the dispatcher, the Planner, the Builder, Ops, the Optimizer, the Assistant, a worker, reviewer, tester, runner or probe | your role, who you report to and the rules you keep                                                                   |
| Spawn, brief, rename, check or end a session                                                                             | the lifecycle (`LIFECYCLE.md`), the herdr commands (`SESSIONS.md`) and spawn.sh's modes, gates and flags (`SPAWN.md`) |
| Answer a review round's findings                                                                                         | what a fix push carries and how nits are kept or dropped (`SESSIONS.md`, Fix pushes and nits)                         |
| Update Claude Code                                                                                                       | the update steps in `LIFECYCLE.md`                                                                                    |
| Route a new ask, or run a lead's sweep                                                                                   | `DISPATCH.md` and `SWEEP.md`                                                                                          |
| Answer the owner's DM while Slack mode is on                                                                             | the `slack` skill (`extensions/slack`) and `playground dm send`                                                       |
| Answer the owner's WhatsApp while WhatsApp mode is on                                                                    | the `whatsapp` skill (`extensions/whatsapp`) and `playground wa send`                                                 |
| Merge a Playground PR, or release `canary` to `main`                                                                     | the **gate** rule (`bun run pr:merge <n>`, `bun run pr:train`) and **release**                                        |
| Comment or review on a repo whose owner `release-owners.json` lists                                                      | the **comments** rule                                                                                                 |
| Touch the live dashboard or the roster                                                                                   | the **dashboard** and **roster** rules (`ROSTER.md`)                                                                  |
| Ask the owner something, or pass on his override                                                                         | the **ask** and **override** rules                                                                                    |
| File a Linear ticket                                                                                                     | the **tickets** rule                                                                                                  |
| Write anything an org sees                                                                                               | the **classified** rule                                                                                               |
| Post in the factory's channel, or take an ask from there                                                                 | the org's `doc channel` (`playground ext show`)                                                                       |
| Run a `vercel` command, a deploy among them                                                                              | the Vercel CLI's three traps (`VERCEL.md`)                                                                            |
| Stop a process                                                                                                           | the **signal** rule                                                                                                   |
| Hand off a build, a read or research                                                                                     | the **workers** rule                                                                                                  |
| Run long, spawn a reviewer again, or wait on something                                                                   | the **context**, **rounds** and **polling** rules                                                                     |
| Write a skill, an agent guide, a docs page, a handoff or a brief                                                         | the **writing** rule                                                                                                  |

A factory session reaches for it on its own, and every brief tells the new session to load it.
A session outside the factory has no reason to.

## How it is laid out

`SKILL.md` is the part every session keeps in view: the roles, the chain, and under **Standing rules** a pointer to where the rules live, short enough to fit inside what Claude Code re-attaches after a compaction (its first 5,000 tokens, within a budget that can drop an older skill whole).
Each rule is its own intent file, `extensions/core/rules/<name>.md`: its first line is the glance, the lines after it its what and why, with each value a `{key}` slot.
A rule that belongs to one login alone lives in that login extension's own `rules/`, and the `rules` hook shows its glance under "Your own rules:".
The lifecycle, dispatch and sweep are in `LIFECYCLE.md`, `DISPATCH.md` and `SWEEP.md`, each read when its moment comes.
`LIFECYCLE.md` also holds the main checkout's restore, which the ops-restore job runs with no hook, since with the checkout gone every guard refuses a factory session's Bash.
The same job puts back a tracked file modified in place in the main checkout, which no session may restore, once two looks in a row find it changed: the changed copy goes to the trash, HEAD's copy comes back, and one line in its log names both.
At every session start, resume and compaction the `rules` hook puts each rule file's glance in front of the session, its slots filled with this machine's settings (`playground rules <name>` prints one whole), and after a compaction a second hook tells it to load the skill again, so the rules arrive even when the skill was dropped.
A test holds `SKILL.md` under 14,000 characters and its pointer to the rules folder; another holds the rule list above to the files in `extensions/core/rules/`.

## The shape

The dispatcher keeps the owner's conversation and the Inbox, and routes each task by role: a new ask goes from the dispatcher to the Planner, which researches it, orders it and writes the plan, and stays free for the next ask, since its research goes to read-only research workers;
then to the Builder, whose workers build, review and merge it; then to Ops, which ships it, rolls the dashboard and watches the machine.
The Optimizer runs retros over everything the factory did and routes each lesson to the dispatcher as a fix, parking later ideas in its icebox, and never builds.
The Assistant runs the owner's personal errands and the dispatcher's tracker, and reports to the dispatcher.
The Builder and Ops send merges, ETA moves, new PRs, staffing and plan updates to the Planner directly, and the dispatcher only what the owner must see or decide: the status of the owner's own asks, any org work, a blocker or slip on something the owner waits for, a decision only the owner can make, and a finding for the playbook.
Each manager is found by what it does, its kind (the builder, ops, the planner and the optimizer), not by a fixed name, so a manager started again under a new name gets its reports, its alerts and the Dashboard's place for it at once:
`roster.ts who builder` prints whoever holds the builder's seat, and every script, hook and Dashboard read that looks for a manager follows the same rule, falling back to today's names.
Four routes skip the planner, which hears after: two fast lanes (a live break or a tiny fix the owner points at, straight to the Builder; a machine or ops incident, straight to Ops), a backlog fix a free slot takes, and a task the owner calls priority.
An org's work skips it too and stays outside the planner's lanes.
An issue goes in the repo where its work lives: this repo for the factory's own, an org's extension repo for that org's, and a person's login extension for their own tools ([ADR 0016](../../.agents/adr/0016-playground-is-generic-with-a-small-core.md)).
As it routes an ask, the dispatcher routes it to a thread of its own, so the Dashboard can show his chat grouped by what he asked: a message that opens with a thread's marker, `[thread:<id>]`, routes there as it is read, so the dispatcher opens each reply and update about that ask with the same marker and asks a peer to open its report with it,
and an ask with no marker gets a thread through `playground thread` (each Inbox item about it goes to the same one).
Before a fix gets a plan row or a worker, the manager greps the open PRs' diffs for the bug's file and function, and hands the fix to the PR that already holds it or drops it, so two PRs never fix one thing in parallel.
Work goes out in bundles: the Planner groups the issues that touch one surface, such as the sidebar or the chat, into one bundle, and a bundle is one worker, one PR, one review loop and one tester pass per head, its tester driving only the pages and files the bundle touches.
Two pieces of work that depend on each other in meaning stack only for no line overlap: the test is a merge-tree of the two heads against the parent's merge base with canary, and the child holds behind its parent until the parent merges.
pr:merge and merge-on-ready hold it there: they refuse a child whose `Stacked on #N` line names an unmerged parent (the `parent` gate in [pr-merge's README](../../packages/scripts/src/pr-merge/README.md)).
A stacked child merges its parent's branch in once, when the parent scores 5/5 or merges, taking the parent's final head, the head the parent merges at (DISPATCH.md's bundles), since every merge is a head its reviewer scores again.
A stacked child retargeted to canary after its parent merges pushes a merge of canary before it asks for review, since GitHub can keep a retargeted PR conflicting, with no CI run, until a push makes it recompute.
A stack held at 5/5 until the owner's try syncs with canary only on a conflict, plus once before the try, and each sync's round cites CI where CI can stand in for the local run, since every sync re-scores every PR in the stack.
A worker that merges canary or a stack's parent in keeps that merge plain and commits each edit after it on its own, since review scores an edit inside a merge as blocking.
A lane's item aims at about 1,000 changed lines or fewer, and a bigger diff splits off canary as a new PR, since a diff too big to read whole finds new blocking issues every round.
Anything else bundles into one PR or sequences one PR after the other.
A worker is spawned for one chore and ends when the chore is done, so the room it held fills again as work finishes: a fix for live breakage or security first, then a queued org ticket, else the next item of the planner's first lane with no worker, where his own asks sit ahead of the chores the factory proposed.
Before a lead spawns a worker it reads the machine's room, the Dashboard's System panel through `bun run verify system`, so the factory grows as far as the Mac allows, counting every membership rather than holding for usage.
Every factory session starts through one script, `scripts/spawn.sh`, which refuses when the machine has no room for it (its gate reads the load against the cores, memory pressure, for a new worker a free run slot with the load room for a run, or an empty run queue, and the model's usage windows, and names the reading that failed),
or a live session already holds the name it would start;
it counts no sessions, so Ops watches the live board, since cmux once stopped answering at 49 live sessions and load 97; a hook turns back a session started any other way; a worker runs its dev stack only while it tests.
A heavy run, such as a suite, takes one of a few run slots and gives it back when it ends, so nothing long-lived holds one.
Nobody builds a demo stack for the owner: he tries changes on the live dashboard alone.
A runner hosts long-running jobs and closes when none is left; the ops jobs Ops runs are scripts with no session and show on the Dashboard under Runners from the heartbeat each writes.
A job launchd runs starts on the next pass after you turn it on in Settings > Jobs and stops after you turn it off, and one still down 3 passes in a row is told to Ops once, and again only after it has run healthy.
One of them, ops-unstick, reads every session's screen every 2 minutes, clears a usage-limit dialog when there is room, takes one with no room on a probe to its spawner, names each capped account's live sessions to the builder and ops once a reset, and takes any other block no hook recorded to the session's manager,
as the session-state hook does for one it did,
and the Dashboard shows each one it finds as Stuck, with a red alarm, or as Paused · usage limit, with gray pause bars, when the usage limit alone holds it.
Each night at 3:00 am, ops-tick's nightly clean removes what no merge's cleanup reached: worktrees and branches of merged or closed PRs, exited containers of worktrees that are gone, Docker's dangling images and build cache, and turbo cache files over 2 days old.
It keeps a worktree that another worktree or a scratch folder still links into, and names the first three links.
A merged or closed PR's worktree goes to the trash whatever it holds, and one whose merge or close `playground rm` cannot confirm goes there too under the owner's standing approval, each move restorable with `playground rm --restore`.
It spaces its deletes under `playground rm`'s limit of 3 a minute, so none is refused, and leaves what does not fit in a 10-minute wait for the next night.
The same night it sweeps every other repo the factory works in: each checkout directly in the code root, or in `~/<org>` for an org `ext.links` guards.
A worktree there goes by `git worktree remove`, its branch kept, only when its PR merged or closed (or it has none and every commit is pushed), it holds nothing but build output, and no live process or roster row has it; each one kept is named with why.
It also moves to the trash each folder in the data folder's `scratch/` whose session is gone, with no live session and no roster row naming it that has not ended, each restorable with `playground rm --restore`.
An unmerged branch's head is tagged `archive/<branch>` on origin before any delete, so the tag holds it and `git branch <name> archive/<branch>` brings the branch back; one whose tag cannot be made, or whose origin head is not the local head the tag would hold, stays, named in the log.
A branch never pushed stays too, with a local `archive/<branch>` tag alone, since a push would publish commits no one has reviewed, and is named once, the night that tag is made or re-pointed to the branch's head.
A re-point that would drop an old head, one no ancestor of the new head, first keeps it at a tag of its own, `archive/<branch>-<old7>` (its first 7 characters), so `git branch <name> archive/<branch>-<old7>` brings it back; when that tag cannot be made, the old tag stays as it is and the log names why.
Each removal goes in `ops/log/nightly-clean.log` and in the outbox line to ops, which carries it to the dispatcher in its batch.
It posts an Inbox update when it freed 1 GB or more, and asks no decision: a container or unused volume over 1 GB that no rule takes is kept, and named as kept in the same log and outbox line, as is a container whose removal failed.
A worker spawns its own reviewer and tester, each briefed from a template it fills in, and the Dashboard nests them under it; the reviewer scores the PR through [code-review-loop](./code-review-loop.md).
A probe lives for one test and never waits on the owner.
The dispatcher, the Planner and the two leads never close, except to be started again with their settings after a restore or from a handoff once their guidance changes; they compact their own context in one 400k window (`autoCompactWindow` 400000) and keep their pane and name.

In herdr, sessions that work together share a workspace, each in a pane of its own: a checker opens as a column beside its worker's pane (`spawn.sh column`), and every other start opens a workspace of its own.
A session ends when the one it reports to closes its pane, never the others.
A finished worker, reviewer or tester also ends by itself: right after its PR merges, and from a check every 5 minutes, while one with work left unsaved stays open and its lead gets a `Not ended` line saying why, unless that work sits in one of Playground's own worktrees whose PR has merged or closed, which the cleanup moves to the trash.
A worker whose last PR closed unmerged stays open too, and its lead gets a `Kept` line to reassign or end it.
Sessions already running move at their next restart, so nothing is closed just to re-arrange it.

The leads keep watch with a sweep: every 15 minutes each one runs `playground sweep`, which prints only what changed since its last sweep (new alerts, the merge queue, the load, ETAs that have passed, a parked row's hold that has closed, and for Ops, once an hour, each ops switch still on with its reason) or `quiet`,
and on news it checks its own agents for a picker waiting, a permission prompt, silence with no report, or a session gone, and acts on it.
A stuck session tells its manager at once: the manager allows a permission prompt when the command is needed and otherwise denies it with a simpler way to do it (`playground picker`), and a session still stuck after 5 minutes goes to Playground; what only the owner can answer becomes a decision in Playground's Inbox, since he reads the Inbox rather than every chat.
A worker silent for an hour after a review round, with no push and no report, is asked why, and a bug it found outside its chore becomes an issue of its own at once rather than a detour, unless it blocks the PR.
The Builder also chases any open PR of ours that has seen no opening, commit, verdict or comment for 30 minutes and is not just waiting on its checks or its turn on merge-on-ready, and any whose last 4 review scores are the same score below 5, where it narrows the change, moves the check to a simpler layer, or parks the PR.
An ops job reminds the poster of every answer of the owner's in the Inbox that its poster has not confirmed within 15 minutes, whether it failed to reach the session or reached it and was never carried out, and a lead hears only when that poster is down, so an answer he gave is never left undone.
An agent confirms a go only with a link to where it landed (the Slack message, the pull request, the Linear ticket) or a reason there is none, and every draft or decision that will post somewhere names that place before he answers.
No factory session blocks on him: one that posted a decision carries on or ends its turn, and reads Waiting on your inbox, in orange, until he answers; Playground itself is always free, running nothing long and waiting on nothing.

## Focus

For a focused stretch, such as a timed test, a demo or an hour of deep work, `playground focus on --session <name> --reason "<why>"` gives one session the Mac for up to 180 minutes.
While it stands, every merge waits, every other session's heavy run waits in the queue, and no new session starts, while the factory's own upkeep and that session's own reviewer and tester keep running.
For an urgent ticket, `run-slot.sh preempt` also stops the runs other sessions already hold, and each says to run it again once focus ends.
A priority start (spawn.sh's `--priority`) passes the load gate and a full run-slot queue at the slots gate while a priority file stands, and the memory gate still applies to it.
It passes focus too on any of them: `priority.json`, an org's own `priority-<name>.json`, a session's own window or a job's own `priority-start.json`.
A session's window opens only with `playground priority on <session> --reason "<why>"`, and a lead opens one only on the owner's or the dispatcher's word; `playground priority off <session> --reason "<why>"` lifts it, ops-tick lifts one left standing after a set age, and each opening and lift is a line in `ops/priority.log`.
A resume within 15 minutes of `spawn.sh close` ending a row that read live passes the load gate as well, as a Claude Code update's close and resume do, and the memory gate still applies to it.
What comes into the Inbox meanwhile stays quiet, out of its counts and the tab's dot, but an alert such as the 5% battery one.
Everything ends by itself at the focus end, so a forgotten focus holds nothing past its time.
`playground focus off` ends it early and says how many runs queued while it stood and how long they waited.
Once focus ends, either way, one Inbox card says the same, and the quiet items count again.
The card moves to Done by itself once everything that came in while focus stood is answered.

## Tickets

A new Linear ticket waits for the owner's yes, and Playground's own work stays out of Linear, tracked in the roster (the Dashboard's status table and Next up), the login's `doc plan-<slug>` items and GitHub.
A session that needs a ticket asks up the chain; the dispatcher puts it to the owner as an Inbox decision, and on his yes writes that day's approval naming the team and title, which lets the ticket be filed.
Every spawn sets `PLAYGROUND_ROLE` (a session resumed without it is known by its name), and in a session that has it the `no-linear-ticket` hook refuses any call that would file a ticket with no approval, through the Linear MCP or a GraphQL `issueCreate` alike.
His own sessions have no role, so they file freely.
The hook is a guard that fails closed: when it cannot start (Bun missing, its bundle damaged, the checkout gone) it refuses the call, naming the fix, and only a timeout on a tool other than Bash lets the call through, where the rule still binds the session.
Only the dispatcher writes an approval, and the hook refuses any other session a write into the approvals folder.
Playground is classified: nothing about it appears in any guarded org's ticket, PR, commit, branch, comment, Slack message or DM, and file in its repos.

## Classified

Playground is classified.
Nothing about it, the factory or its sessions goes into any guarded org's ticket, PR, commit, branch, comment, Slack message or DM, and file in its repos.
Every session is spawned with the factory's own settings file, which `scripts/link-skills.sh` installs at `~/.playground/factory-settings.json` without touching your own settings, so its `no-playground-leak` hook runs wherever the session works, in a guarded org's checkout too.
A session resumed without its settings (a bare `claude --resume`; herdr's own resume is off) drops that file, so Playground's own project settings carry the hook as well, and a session resumed where its folder's settings lack the hook is started again with the file.
The hook refuses a Linear or Slack write, a write to a guarded org's repository through gh, git, curl or the GitHub MCP, and a commit or push in its checkout, when its text names Playground, one of its skills, a session by the name the roster gives it or an older one such as `worker-envy`, the roster, the live dashboard or `~/.playground`.
The fixed names are one list, the leak hook's terms file in `scripts/hooks/`, and every skill folder under `skills/` and every agent's name in the roster join them, so a new skill or a renamed session is covered at once.
The guarded org's own name always passes.
Plain words such as "dashboard", "worker" or "envy" pass, so an org's work is not blocked by everyday language, and the refusal names the term it found so the session can rephrase.
Writes to Playground's own repo pass, and so do Slack posts made through the Slack MCP's chat tools in the conversations the owner cleared for talk about Playground:
the factory's channel the owner shares with a colleague and the direct messages listed in `extensions/core/lists/slack-cleared.json`.
An org whose extension gates its Slack sends (`slack.gatedSends`) gets no such pass on its own Slack servers: there only a post to its self-DM passes, a curl to any Slack URL but an `/api/` read is refused, and every other write goes through the extension's own send path.
The channel is where the owner's and the colleague's Playgrounds talk:
a post there speaks as Playground and ends with an italic _Sent via Playground_, since it goes out through the owner's Slack account, and the hook refuses a Slack MCP chat post there without it, and refuses any curl write that names the channel.
Its links go as link chips: rich text of plain words and links alone, each link labelled with its address and shortened, ending in the italic signature, and the hook refuses any other rich content there.
The channel's own lists, limits and triage are its org's, in that org's extension (`playground ext show <org> doc channel`).
The hook also refuses a guarded org's write it cannot read.
Like the ticket guard, a hook that cannot start refuses the call, and one that times out on a tool other than Bash lets it through, where the rule still binds the session.

## It's working if

- Every session in the dashboard sidebar has a roster entry with a task, and every finished worker shows `ended` and is closed, its checkers with it, once its chore is done.
- Research and plans run in the Planner and its research workers, building in the Builder's workers, ops in Ops' runners and jobs; the dispatcher runs none of them.
- Each open Playground PR is one bundle, a fast-lane fix, or a priority of the owner's that could not wait for its bundle.
- herdr shows one workspace per live worker, its checkers in columns beside it, and no checker in a workspace of its own.
- Every working worker's ETA shows on its sidebar row's hover, and few have passed it.
- No agent sits on a prompt or a picker for longer than one sweep, unless the picker waits on the owner in its own pane.
- No session waits on a prompt for a delete Claude Code stops on: an `rm` or `rmdir` whose target has two or more parts that start with an unguarded variable, or a name directly in `/`, is turned back with a fix (the `no-prompt-stop` hook), and the session runs it again as a literal path (`playground rm <literal path>` for anything outside its worktree and scratchpad),
  an `rmdir` with each variable guarded too,
  or in its own scratchpad.
- A manager starts no hidden helper: its settings deny it the Agent and Workflow tools, so every build, read or research it hands off shows as a worker in the sidebar.
- A heavy run in a worktree (an install, a `node_modules` copy, a build, a type check or the whole test suite) waits for a free run slot, so the machine runs a few at a time: the `no-unslotted-run` hook refuses one typed without `run-slot.sh`, naming the form to use.
  A docker image build waits too, from any folder, one at a time in a builder capped at half the Docker VM's memory, so a build that grows too big fails alone and the live dashboard's database keeps running.
- No factory session starts unless the machine has room: `scripts/spawn.sh` refuses while the load is at or over the core count, while memory pressure is critical or free memory is under 8%, for a new worker while no run slot can take a run and other runs wait for one, or while the model's usage window is near its cap, naming what it read,
  and when a live session already holds the name, so a respawned session starts only once the old one has closed,
  and the `no-raw-spawn` hook refuses a session not started through it.
  A session started with `--account <email>` runs on that account, and its token shows in no command, message or log.
  A worker started with `--backend glm` runs on Z.ai's GLM model in place of Claude, with its key kept just as safe, and keeps that model when it is resumed; a reviewer or tester always runs on Claude.
  The first dispatcher started with `--harness codex` runs in Codex in place of Claude Code, and keeps it when it is resumed; a Codex session whose safety guards fail to load is stopped within a minute of starting, and a Codex start stops when PowerShell is installed.
  A GLM session takes tiny mechanical work as well as docs, skill text, research reads and plan drafts, and stays on Playground's own work, an org's work staying on Claude.
  No guarded org's data reaches GLM: spawn.sh starts a session in a checkout of an org `ext.links` guards, or on a brief naming a word of the `glm-refused-sources` list, on Claude alone, and a job that reads an org's data starts its `claude` with GLM's settings cleared.
  For a smaller build task, Claude writes the plan and a GLM worker builds it: the plan names the files the worker may touch, the lead checks that list against the hook's refused paths, and anything outside it goes back before it is edited.
  GLM's unused credits lapse at each reset (`~/.playground/zai-usage.json`, the Usage app), so the lead pulls the next eligible item forward while GLM has room before the reset.
  A GLM session's commit or push that touches the app's pages, the factory's hooks, spawn.sh, the merge and verify scripts, the commit hooks or the CI workflows is refused by the `no-glm-heavy-path` hook, naming the files, so that work goes to a Claude worker.
  While the Mac's 5-minute load is over 15, the same hook also refuses a GLM session's installs, node_modules clones, commits and pushes, so it waits for the load to fall.
  The same hook refuses a GLM session's headless Claude run, its calls to an org's tracker, chat, docs and repos, its shell reads of an org's checkout and its database clients aimed off this machine, every MCP tool or resource read, and a Read, Grep or Glob of an org's checkout once its matcher takes them, so that work goes to a Claude worker.
  A session resumed with `--brief <file>` starts by reading that brief; without one, its first prompt has it act on the after-resume hook's instruction, so it re-arms its background tasks, re-sends its unanswered messages and puts back an edit lefthook set aside when the restart killed a commit.
  A resumed session restarts any dev stack it served and re-arms its watches, CronList before CronCreate, since the resume kept its crons and dropped its background tasks.
  The factory no longer moves sessions to GLM at 98% usage (retired on Inbox #i827): the account rotation moves it between Claude accounts in its place (`scripts/ops/usage/login-flip.py`).
- A session started with no `--runtime`, from any terminal, or with `--runtime herdr`, opens in herdr, in a pane labelled with its name, and its next resume opens there too.
  spawn.sh opens every session in herdr: it refuses a `--runtime` other than herdr and a column started beside anything but a herdr pane, and every resume opens in herdr, whatever word its runtime pin held.
  Claude's folder trust and MCP prompts are answered for it only under the code root (`paths.codeRoot`, else the folder that holds the main checkout) and `~/<org>` for each org `ext.links` guards; anywhere else it waits for the owner.
  A probe on a herdr server with no pane yet opens in a workspace of its own (`spawn.sh probe`), and when herdr refuses to open one, spawn.sh shows herdr's own reason.
  After a herdr server restarts, the factory's or the probes', its ops job runs `spawn.sh restore` for it, which brings back every herdr session that ran on that server and whose roster row is not done, ended, parked or paused (that row read again once its resume finds the session gone, so a session you closed stays down), one that never got its first message included,
  the first dispatcher first and past the busy-machine check,
  on the account its start named, else the login with the most room, the model it started with, an effort other than high and, for a reviewer or tester, the PRs its roster row serves, and skips any still running.
  It prints one line for each session it brings back, leaves down or cannot bring back, naming the reason, so a session the busy-machine check held back is named with the check's words, and counts as on its way back, not as a failure.
  A factory session can only read from herdr: the `no-raw-spawn` hook refuses any herdr call that types into, closes or speaks for another pane, since herdr lets anything on the machine control it.
  The one exception is a scratch herdr server the session starts for a test, its socket in the session's own temporary folder, which it can drive through that socket alone, but never to start Claude.
  So a herdr session ends through `spawn.sh close <name>`, which closes only the pane spawn.sh opened under that name, never the caller's own, and marks the session ended on the roster.
- A new session's name reads like `k3m9px-worker`: a new 6-letter id, then what the session is, so no name is ever used twice, and its checkers get ids of their own, as `b7k2mq-reviewer` and `h4n8zt-tester`.
- Every session starts at high effort; the owner picks a dispatcher's, the Assistant's or the hosted session's (the one the Dashboard runs on the Agent SDK) in the menu left of Send in its Dashboard composer.
  A lead picks any other session's model and effort by brief-rush's model rule, with spawn.sh's `--model` and `--effort` at a start or a resume, and the owner's word in the **override** shape outranks both.
- Every session runs on `models.default` (Opus) unless it was started on GLM or with spawn.sh's `--model` naming another of `models.claude`, and every subagent it starts for work runs on Sonnet unless its call names a model,
  from the factory settings' `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (the owner approved #i492, 17 Oct; on GLM the alias maps to GLM), so a brief or subagent call that needs Opus names `model: opus`.
  The owner picks another model for a dispatcher, the Assistant or the hosted session in the menu left of Send in its Dashboard composer.
- A suggestion, from anyone, is tested before a session acts on it or repeats it, and a decision that claims no change for this machine or the owner's setup cites the command and output that measured it.
- No worker is spawned while the System panel reads No room, and the panel's idle line stays empty: no worker's dev stack idles 15 minutes.
- Of the choices the factory could make itself, only the one-way doors reach the owner's Inbox as decisions: a Slack message to anyone but a developer (a collaborator writing code in an org's repo, about that work), a new ticket, an irreversible delete or another breaking change, a breaking schema change, an org's database change on one environment, and budget.
  A production bug's port, a request for work from a session outside the chain and a step only he can take (plug in the Mac, log in, add a key; Approve means done and Deny means he can't, and a secret value he holds goes to a Vercel project or a Keychain item through a secret ask, whose card hands it straight to its sink, or anywhere else where the item says, 1Password or a file,
  never into chat or a stored row) go to him as a plain ask, its words saying exactly what Approve does,
  and ships to `main` run on his standing yes.
  Every two-way door, a design, an order or the scope inside an ask he approved, the factory picks itself and records in an ADR or on the issue, and a grilling sends him only its one-way-door questions that nothing in the repo or his past words settles, batched as one plain ask.
- No decision reaches the owner as a question in chat.
  The inbox gate, a hook on Playground and the leads, refuses to end a turn whose last reply asks him to decide (any question mark outside code, quotes and lines to other agents, rhetorical ones and headings included, or words such as "say yes", "your call" or "should I") until that reply names an item open in his Inbox, so the session names the one already open on the same thing,
  or else posts it there and says so, where a lead sends it to the dispatcher, who posts it; a pointer he is free to skip ("if you want to look") is no ask.
  It refuses a request for his own action the same way, such as "you need to", "please", "when you can" or "the owner, plug in the Mac", so a step only he can take goes to his Inbox too.
  Steps he comes back to (3 or more numbered lines, or a table) go in one Inbox card whose progress is edited in place, since chat scrolls; the gate holds the dispatcher alone to it, since a lead's steps or table in its own pane are its report up the chain, which the dispatcher folds into the owner's one card.
  Progress on tracked work, where each numbered line or table row names an issue or PR, stays in chat.
  A question quoted from someone else, or put to another agent, passes.
  Anything promised to him for later, and any later outcome of something he asked, reaches him as an Inbox update; chat answers only what he is asking now.
- Every Slack link in the Inbox opens in Slack's app: `playground ask` refuses an archives-style link, and an org extension's link script rewrites one from the org's workspace (another workspace's is named on stderr, left as it is).
- Every mention in the Inbox reads as a name (@colleague, @platform-team): `playground ask` refuses Slack's raw tokens (`<@U...>`, `<!subteam^...>`, `<#C...>`, `<!here>`), and the poster resolves each name to its ID when it posts.
- An ask that has the owner quit, restart, close or stop something says what still depends on it, since a quit of cmux once left the app not working: `playground ask` refuses it until it carries `checked`, one line from four checks (the ops jobs, the processes and sessions running under the target, and the Dashboard's health), `none` when nothing does.
- An ask leads with a picture of the point (a diff or an ASCII flow; before and after pictures once the Inbox takes them) and a one-sentence note ([plain-words](./plain-words.md)), then short bullets, then what Approve does.
  `playground ask example` prints a template for each, and `playground ask new` posts a wall of prose, an unlinked PR, ticket or commit, or a too-wide code line with a hint on how to shape it.
- Each decision is one Inbox item, with its sub-choices inside it, and a changed plan closes its old item before the new one goes up.
- Every session compacts itself in one 400k window, GLM's included, which spawn.sh sets on every start and resume (Inbox #i706), with a summary shaped by AGENTS.md's Compact Instructions.
  It keeps its surface and name; after a compaction it gets the glance lines from a hook, loads the factory skill again, and rereads its roster entry, its open Inbox items, its PRs and the register of settled decisions before it acts.
  A session spawn.sh did not start, the owner's own in a Playground checkout included, compacts at the settings files' 400k.
- Each PR has one reviewer session across all its rounds, and from round 2 it reads only what changed since its last score, plus the findings still open.
- Leads wait on a message, a background task's notification, their sweep or an ops job, rather than a `sleep` loop or a repeated `gh` read.
- A changed draft reaches the owner through its Inbox item, never as a second Slack draft for an item he has already sent.
- No session polls a PR more often than every 5 minutes, and reads and comment posts go through GitHub's REST API where they can, so the shared GraphQL quota lasts the hour; a sweep over many PRs is the exception, one batched GraphQL query ([GITHUB-BULK-READS.md](../../extensions/core/skills/playbook/GITHUB-BULK-READS.md), which also holds the read of canary's own checks).
- A check that needs a PR's whole file list (an overlap with another PR, a stack's files) reads it page by page, since the plain read stops at 100 files without saying so.
- No session writes Claude Code memory: every learning arrives as a PR to this repo.
- Every skill, agent guide, docs page, handoff and brief a session writes reads as writing-for-agents shapes it: lean, each step ending on a completion criterion, phrased as what to do, a hook turns back a factory session's write to one until it has loaded the skill,
  and the reviewer scores the changed ones against it.
- After each of the owner's meetings, Playground reads its transcript on this Mac with the login extension's meetings script, which its own **meetings** rule names, and acts on the follow-ups, so he never pastes one by hand, and no transcript text leaves Playground's own chat and the Dashboard's local tables for Slack, Linear, GitHub, Notion or another session.
- No brief agrees in advance to raising a ratchet, or loosening any check whose own rule says it never rises: that call goes to the rule's owner, on the PR or directly, before the code relies on it.
- Every Linear ticket a factory session files traces to an Inbox decision the owner approved, and none names Playground.
- No guarded org's ticket, PR, commit, branch, comment or Slack message names Playground, a lead, a factory session or the live dashboard.
- Every Playground PR merges through `bun run pr:merge <n>` or merge-on-ready (`bun run pr:train ready`), so none lands unless the repo's owner opened it (an outside author's only on the Builder's word, with `--outside-author <login>`), nor while Ops' held list names it,
  nor while a merge of `canary` inside it dropped lines `canary` added (the `keeps canary` gate in [pr-merge's README](../../packages/scripts/src/pr-merge/README.md); a factory hook also refuses `-s ours` and `-X ours`),
  nor without a 5/5 and GitHub's `Audit, Lint, and Build` and `test` checks green at its head, with GitGuardian's among the checks.
  A merge of `canary` makes a new head, which needs its own checks and 5/5.
  Merges go one at a time, under the factory's merge lock, which pr:merge takes itself.
  A wrong refusal goes to the Builder, the only one who merges by hand, on an override.
- A lead that overrules a reviewer's FAIL says so on the PR, in one `Lead ruling:` line with the evidence and the issue the fault moved to, so the next reviewer reads the FAIL as settled; the merge still waits for a fresh verdict at the head, or the Builder's merge by hand.
- No session but the dashboard's runner restarts the live dashboard.
- No session, and no fork or sub-agent one runs, stops a process it did not start: the **signal** rule.
  The one handover is a dev stack whose starting session has gone, which `bun run dev:stop` ends in its worktree from the launcher's own record, never the live dashboard's without `--live-dashboard`.
  CI checks that nothing in the repo kills by name, pattern or port; a command a session types is the rule's to hold.
- No session builds, tests, commits or writes a file in the main checkout, which every installed skill follows: the **main** rule.
  A hook refuses each of those there, naming the fix, while its upkeep (a pull, a fetch, rebuilding the shared packages with env validation off after a pull that changes them, `git reset --keep origin/main` off a stray local commit, relinking the skills) and reads run.
- Nothing types into another session's pane in the owner's name: sessions and ops alerts reach a session through `SendMessage` (the **voice** rule), and the dashboard types only for his own acts, but for the idle compact's `/compact` into an idle worker or runner, which the owner approved (ADR 0020).
  A test fails on any other caller of the dashboard's `deliver()` and on any text in the repo that types into a pane, Escape on the usage-limit dialog and a manager's `playground picker` on a permission prompt aside.
- A page for the owner (a report, a comparison, a mock, a diagram) is a local HTML file in the session's scratchpad, kept with `playground page` and posted as an Inbox card's `html` attachment, so the Inbox's viewer shows it and nothing opens on the owner's screen (the **local page** rule), since a claude.ai artifact publishes under whichever account the session holds.
  The page then stays on the Pages tab of the session's view, of the one it was made for and of the dispatcher's.
  Every page's header shows its version, "Version N · <date> · <kind>", always, and a copy made to share outside drops the label.
  The factory's settings turn the `Artifact` tool off with `enableArtifact: false`, and a test fails without it.

## Where it fits

The rules every other session runs under.
The dashboard app ([AGENTS.md's dashboard section](../../AGENTS.md#the-dashboard-app)) shows the live sessions and holds the Inbox the owner answers ([.agents/dashboard/asks.md](../../.agents/dashboard/asks.md)).
A PR built under it follows AGENTS.md's "Shipping a Playground PR".
