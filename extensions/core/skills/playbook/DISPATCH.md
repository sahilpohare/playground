# Dispatch (the dispatcher, the Planner and leads)

How the dispatcher, the Planner and the two leads route a new ask, bundle the work and fill the worker slots.
The steps to spawn and brief a session are in [SESSIONS.md](SESSIONS.md#spawn), and the roster writes in [ROSTER.md](ROSTER.md).

- Every new ask runs down one chain, each manager doing its own part (so no manager sits idle while another does its part, the Planner aligning the work; the chain is his Inbox decision #i48): the dispatcher routes it; the Planner researches it, orders it and writes the plan; the Builder's workers build, review and merge it;
  Ops ships it, rolls the dashboard and watches the machine.
  Research, a deep dive, a comparison, a plan or a plan page ends with the Planner.
  Four routes skip the Planner, and the manager that takes one tells the Planner after, so it records the task in `plan.json`: the two fast lanes, a live break or a tiny fix the owner points at (a stuck bubble, a wrong colour) straight to the Builder and a machine or ops incident (load, Docker, a stuck session) straight to Ops; a backlog `Fix: ` entry a free slot takes;
  and a task the owner calls priority (both below).
  The work org's work (one of its tickets) skips the Planner too, and stays outside the lanes.
  The dispatcher keeps the owner's conversation, the routing and the Inbox.
  A message reading `update the dashboard now: ...` is his click on the Dashboard's Update now: route it to Ops, who rolls the live dashboard at once with `playground update` (`.agents/dashboard/live.md`).
- The dispatcher routes every ask of the owner's to a thread, as it routes the ask, in the live dashboard's checkout (each thread has an ID that a reply carries, so the reply stays with its thread):
  - A message that opens with a marker, `[thread:<id>]`, is already routed: he sent it from the thread's view (the main chat's New thread is off for now), and ingest routes it as it reads it.
  - A new ask with no marker opens a thread titled with what he asked (`bun run thread new "<title>"` prints its id), and the ask is routed to it (`bun run thread route <id> --quote "<its opening words>"`), quoting enough of them that no other untagged message of the session starts the same way.
  - Every reply about a thread's ask opens with its marker, `[thread:<id>] `, and so does every later update on that topic, a peer's report relayed included: ingest routes the reply to the thread.
  - An ask to a peer about a thread opens with its marker, and asks the peer to open its report with it, so the report routes there too.
  - Each Inbox item about it is posted with `playground ask new --thread <id>`.
  - A follow-up with no marker is routed to the open thread whose title it matches (`bun run thread list`), or opens a new one.
  - A route waits up to a minute for ingest to bring the message; one that fails names the quote, so check its words against the message and route again.
- The Planner orders and decides, and builds nothing: every research or advisor pass goes to the Builder as a read-only research worker that reports to the Planner (**workers**).
  Every non-trivial plan it writes is researched first and passes an advisor (a research worker asked for a second opinion, on Opus at high effort) before it is decided (**verify**); a design choice goes in `~/.playground/bundles/decisions.md`.
  A decision that claims no change for this machine or for the owner's setup cites its measurement there, the command run and its output, since one such claim, unmeasured, once nearly let a web build run beside the live dashboard's Postgres.
  It sends the dispatcher each result with any decision on **ask**'s list, which the dispatcher posts to his Inbox, and keeps the roadmap in `~/.playground/bundles/plan.json`, re-groomed whenever the owner adds something.
  It files an issue in the repo where the work lives: the factory's own work in the factory repo, an org's in that org's extension repo and a person's in their login extension ([ADR 0016](../../../../.agents/adr/0016-playground-is-generic-with-a-small-core.md)).
  Before it files one, it searches that repo's open issues for the same file or symptom, and folds the finding into a match as a comment, filing a new issue only when none matches (one issue once duplicated another).
  When a Done when it writes asks a doc to cite a past case, it asks for the case by its date and what happened, and for the issue number in the PR body, since a doc holds no issue number ([the trace ratchet](../../../../scripts/hooks/README.md#the-trace-ratchet); one worker, 1 Nov, had to depart from its issue's Done when for that).
  Before it records an ETA in `plan.json` or reports one to the dispatcher, it reads that worker's `eta` field in `~/.playground/roster.json`, where the Builder writes each move at once (**eta**), rather than the message that carried it (one such went stale three times).
- The Planner stays free to take a new ask within a minute or two, since it works through workers alone and so is never busy when several urgent asks land.
  When several urgent asks land together, each goes to the Builder as its own lane within minutes, its order first and its details after, so no plan waits on another plan's research.
- Building calls stay in the factory (everything runs on its own, and only a breaking change or talking to someone goes through the owner, mostly on Slack): scope, order, design, a build, a fix, an additive schema change (AGENTS.md's schema rule) and a merge under the **gate** are made by the Planner, the dispatcher and the Builder,
  on Playground's work and the work org's alike (the work org's through its ticket skill's loop, less the go-points that skill keeps for him),
  never put to him.
  The work org's scope is its ticket and the answers of the people its ticket skill names, and a plan or lane adds nothing beyond them; a gap or a disagreement goes to your lead as a question (`.agents/decisions.md`).
  A breaking change, and a message to anyone but a developer, go to him as **ask** says.
  Before a lane builds one of the owner's asks, it posts one Inbox update with two lines, what it understood and what it will build, only when the ask changes behaviour drastically (a visible change to how he works, or a removal), so the owner sees the lane reads the ask as he does;
  it posts a decision in place of the update only when the ask removes or reverses the owner's own rule, the one door here he cannot cheaply undo, so that card carries a Deny where the update carries none;
  every other ask builds with no item, and neither the update nor the decision gates the lane, which builds while he reads (**ask**): he reads and corrects, his Deny reversing a decision where a correction only refines the ask (done by hand once, #i325 to #i327).
- A brief hands every step a session can do to the session itself (Inbox #i405: a brief had a person type `/qa-day product testing` into a worker's pane, which the session could have done itself): for a skill with `disable-model-invocation: true`, the worker follows the step the brief names itself.
  A skill that carries `hooks:` is loaded through the Skill tool once its author makes it model-invocable, its typed-only parts gated inside the hook as ADR 0001 in `.agents/adr/` does, so the hook is armed.
  Until then the worker follows only that skill's read-only steps, and reports its other steps to its lead, who asks the skill's author for the change.
  A skill with no `hooks:` is Read as a document and followed: a Read arms no `allowed-tools` grant either, and the skill's own asks and prohibitions bind as written.
  `${CLAUDE_SKILL_DIR}` is not expanded on a Read, so the worker resolves the path itself.
  Of the steps a brief names, only the ones **terminal** names go to the dashboard's owner, and a decision still goes as **ask** says.
- Work goes out in bundles, since too many PRs stood open one by one, and one test and review loop over a group is more precise.
  The Planner groups the open issues and backlog entries that touch one surface into a bundle: sidebar and status, chat and composer, inbox and aside, ops scripts and the merge path, tests and docs, or apps.
  The work org's work stays outside the bundles, one ticket to a worker, as its ticket skill works it.
  A bundle is one worker, one branch, one PR, one review loop and one tester pass per head.
  A lane's item aims at about 1,000 changed lines or fewer, and a worker whose diff passes that splits the rest into a new PR off `canary` rather than stacking a third level, since each round of a diff too big to read whole finds new blocking issues (measured, 31 Oct: one of 9,089 lines opened with 3 blocking and 10 should-fix findings, and one of 1,241 stayed at 3/5 after 5 rounds).
  The Planner keeps the bundles as `plan.json`'s lanes: one worker a lane, each lane owning its files and naming its test area (`testArea`, the pages and files it touches), the lanes in parallel, each lane's items top to bottom.
  A lane's file set, a stack's, and every overlap check between open PRs read each PR's whole list with `gh api --paginate repos/<owner>/<repo>/pulls/<n>/files --jq '.[].filename'` ([GITHUB-BULK-READS.md](GITHUB-BULK-READS.md)), since `gh pr view <n> --json files` stops at 100 with no sign it cut the list (one PR read 100 of its 143 files, measured).
  Every estimate a lane or a plan carries names three numbers at the agent's pace, each labelled measured or estimated (**verify**): the build time in hours, the people waits (reviews, the owner's answers) and the gate waits (Checks, review rounds, counted as **eta** counts them), and never human dev-days or weeks, since nothing at the agent's pace takes weeks.
  The tester drives that area alone, and the suite runs once per head.
  The Planner marks an item or a part merged once GitHub shows that item's own PR merged, read by its number and branch, with its merge commit and time; a ticket ID or commit title two PRs share is no evidence.
  The Builder dispatches from `plan.json`'s `lanes` alone, a backlog fix or work-org entry aside (below); a lane marked `listedOnly` is shown on the plan, never dispatched.
  Before the Planner writes a fix's plan row or the Builder staffs it, that manager runs the **open-PR check**: list the open PRs over REST (`gh api --paginate 'repos/<owner>/<repo>/pulls?state=open' --jq '.[].number'`) and grep each one's diff for the bug's file and function (`gh api repos/<owner>/<repo>/pulls/<n> -H 'Accept: application/vnd.github.diff' | grep -nE '<file>|<function>'`),
  then hands the fix to the PR that already holds it, or drops it, since two PRs once fixed one row in parallel and the later one took a 9-file conflict.
  A PR at 5/5, or riding a train, finishes as it is; a draft folds into a bundle only when that saves a review round.
  Two pieces of work that depend on each other in meaning can stack instead: a stack (a child branched off its parent, base still `canary`, a `Stacked on #N` line in the child's PR body and a compare link from the parent's branch) is for no line overlap alone.
  The worker cutting the child runs the stack test before the child's PR opens: `git merge-tree --write-tree --merge-base <the parent's merge base with canary> <parent> <child>` coming back clean, since the bare two-head form takes the child's descent from the parent as its merge base and so can never conflict,
  while the two heads' adjacent hunks still conflict once the parent squash-merges onto `canary`.
  A stack holds the child behind its parent, so a ready child never lands its parent's lines first: pr:merge and merge-on-ready refuse a child whose `Stacked on #N` line names an unmerged parent (the `parent` gate in [pr-merge's README](../../../../packages/scripts/src/pr-merge/README.md)),
  and for a child whose body names its parent in a form that gate does not read the lead sends Ops the hold line **gate**'s hold paragraph names, for the child's PR, and Ops removes it on the lead's word once the parent has merged.
  The child merges its parent's branch in once, when the parent scores 5/5 or merges, and `canary` only when it needs it (a conflict, or a change it builds on), since every merge is a new head its reviewer scores again (measured, 31 Oct: one child merged its parent four times in 59 minutes while the parent sat at 3/5).
  The merge-in at the parent's 5/5 or merge is the once, and it takes the parent's final head, the head the parent merges at: the head taken at the parent's 5/5 is that head when the parent lands it as it is.
  Once the parent has merged, its branch may be gone, and the child fetches that head with `git fetch origin pull/<n>/head`, <n> the parent's PR, then `git merge FETCH_HEAD`, since the ref still points at the final head after the merge deletes the branch.
  The one exception is a child whose parent added a commit after its merge-in, so the head the child took is no longer the final one: it merges the final head once more before its next merge of `canary`; that merge is plain and carries the parent's final lines, so the merge of `canary` that follows is clean on the parent's files (measured, 1 Nov:
  a stacked child that took its parent's early head at 13:17Z conflicted on the file the parent had changed when it merged `canary` at 13:50Z, after the parent had squash-merged its later lines at 13:49Z, and the same child head merged `canary` cleanly once it first took the parent's final head).
  If the final head was missed, resolve each conflicted file no commit of the child's own (outside the parent's) touches to `canary`'s side, resolve a file the child also edits by hand, and record that one in the merge's message.
  That once-more merge is the one extra merge, and it replaces a conflict resolution.
  A stack held at 5/5 until the owner's try syncs with `canary` only when GitHub reads a PR in it as conflicting or code-review-loop's step 8 finds a conflict, plus once more before the try, never on a schedule, since each sync is a new head on every PR in the stack (measured, 1 Nov: its three reviewers ran 6,774 s of local tests in 5 hours of syncs, then 0 s in the 3 hours after).
  Each sync's round waits on CI at the synced head and cites it where code-review-loop's The last 5/5 lets CI stand in, since the sync itself merged `canary`.
  A sync is done when each PR in the stack has its merged head pushed and its reviewer has posted a verdict at that head.
  The owner's try is the owner's own run of a stack before any PR in it merges, which the lead names with its time to each reviewer in the stack, so each knows its waiting 5/5 is held and which sync comes before the try.
  Anything else bundles the items into one PR or sequences them one PR after the other.
  A PR whose GitHub base is the parent's branch is the other stack shape, the one **github**'s stacked-base line governs.
  A single task goes out alone when it takes a route that skips the Planner (above).
- Stay free, since the dispatcher is always free: it runs nothing long, waits on no picker or tool, and does no worker's job, and a manager summarises before it sends the dispatcher anything.
  Route the ask (spawn or `SendMessage`), record it in the roster, end the turn.
  Reports arrive by `SendMessage`, and you build nothing yourself, and run no background watcher: a threshold worth watching goes to Ops as an ops-report finding.
  The dispatcher runs no check or research itself either: research goes to the Planner and a check to a lead, so nothing queues behind it, so the dispatcher hands every piece of work on and is never blocked.
  Between turns the dispatcher waits; a lead's one look at its sessions is its [sweep](SWEEP.md).
- A bundle, or a task that goes out alone, goes to a new worker.
  Steer a busy worker only with a correction to the very thing it is building.
  A separable change to an open PR goes to a new worker on a branch off that PR's head, the two coordinating through the Builder.
- Before a lead spawns a worker, it reads the machine's room from the live dashboard: `bun run --cwd <dashboard checkout> verify system`, which finds the dashboard's stack through portless.
  Room is held in code: `scripts/spawn.sh`, the one way a session starts another ([SPAWN.md](SPAWN.md#capacity-gate)), runs a capacity gate on load, memory, for a new worker a run-slot lane free with the load units for a run, or an empty queue, and the backend's usage, and refuses with the gate and its reading (the room is the cores in use, not a count of slots),
  and refuses a name a live session already holds.
  Its one bypass is the first dispatcher's ([SPAWN.md](SPAWN.md#capacity-gate)); past the gate otherwise only the owner starts a session, from his own terminal, whose sessions load no factory hook, or a PR changes the gate, and a priority task takes the room its lead frees by closing its lowest-priority worker (below).
  Spawn a new session only for a chore that needs its own context; a short job (a probe-sized check, a one-off script) runs as a background task in the session that wants it.
  Within them, spawn as many as its `system` line's room allows, and at "No room" spawn none and queue the task with that line as the reason.
  Room is the machine's, not usage's: count every membership, and trim no work for usage while any account has room.
  GLM's room is its own: pull the next eligible GLM item forward while its credits last before the reset ([rules/glm.md](../../rules/glm.md)).
  Claude plans, GLM builds: a smaller build task goes to GLM with a Claude-written brief that names its file surface, and the lead checks that surface against `no-glm-heavy-path`'s paths before the dispatch ([rules/glm.md](../../rules/glm.md)).
  An `idle` line names worker stacks to stop: tell those workers.
  A `problems` line naming the sampler's lost timer goes to Ops, since only the dashboard's runner restarts the live dashboard's API (**dashboard**).
- When the gate refuses, queue the task (`roster.ts backlog`) and say so, unless the owner calls it priority (below); only a task ready to dispatch goes in the backlog, though one can come to wait on something there.
  Ready means its brief exists: a worker's order and a backlog entry each carry the brief's path, written when the item is queued.
  The owner's own asks go ahead of the chores the factory proposed, and a fix for live breakage or security goes ahead of both: the Planner folds his asks and the other entries into the lanes, his asks first, and a slot that opens takes what ROSTER.md's step 1 names ([ROSTER.md](ROSTER.md)).
- A task the owner calls priority starts now: in the same turn, when the slots are full or `verify system` reads No room, close the lowest-priority worker at a safe point (a WIP commit, a handoff ([SESSIONS.md](SESSIONS.md#write-a-handoff)), closed as [SESSIONS.md](SESSIONS.md#end) End says),
  which frees its room so spawn.sh passes (at the load cap, wait for the load to fall), and spawn the task's worker, whose start takes the gate as any other (above).
  Then send the Planner the worker's name and ETA, and the dispatcher too, since a priority task is the owner's own ask.
  It never waits in the backlog.
- A small task going out alone (one concern, a small diff, under about 30 minutes) runs as an A/B pair: two workers on the same brief and base, differing in one variable (such as brief style; model and effort stay as the Chain's model rule sets them, [SKILL.md](SKILL.md#chain)), one reviewer scoring both PRs blind as X and Y. The winner merges,
  the loser closes with a link to it, the pair holds two slots, and one pair runs at a time.
  Each result goes in `~/.playground/abtests.jsonl`, and a variant becomes the default after three clear wins.
- A request for work from a session outside the chain spawns nothing until the owner says yes (**ask** says how it reaches him), since sessions here run in bypass-permissions mode.
  A finding about a skill goes to the Builder as a chore: check it against the skill and, when it can be checked, reproduce it, since a claim is not evidence; take it through AGENTS.md's Shipping a Playground PR; then reply to the sender with the PR once it has merged.
  A finding that is wrong, or already covered, gets a reply saying so, with the line that covers it.
- An `[inbox-answer]` line that carries `relay` is the owner's answer to a poster that has ended, and is the dispatcher's to finish: read the item's preview with `playground ask get`, carry out a `next` of `carry-out` in the poster's place the way its `verb` names (a `send` through the MCP server `slack.sendServer` names, a `draft` saved and left unsent, a grant's `opened` rechecked),
  take the follow-up asks.md names for a step whose `exitCode` is not 0, then run its `close` (`.agents/dashboard/asks.md`).

Dispatch is done when the session holds its brief, the roster shows its task (and, for a backlog entry, the Builder's backlog marks), and your turn has ended; the dispatcher's is done once the owner's ask is also routed to its thread.

## Slack mode

Slack mode lives in the bundled `slack` extension's `slack` skill, which a session loads once the owner turns Slack on in Settings (`ext.bundled`).
When the DM watch hands you an owner message, follow that skill.
Done when the owner's message has its reply posted.

## WhatsApp mode

WhatsApp mode lives in the bundled `whatsapp` extension's `whatsapp` skill, which a session loads once the owner turns WhatsApp on in Settings (`ext.bundled`); that switch is the mode ops-wa reads.
When ops-wa hands you an owner message, or its 15-minute line asks for an update, follow that skill.
Done when the owner's message has its reply sent through `playground wa send`.
