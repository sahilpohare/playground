# Sessions

The commands behind the factory's lifecycle, for the sessions it runs in herdr.
A session's place is its herdr pane, labelled with its name ([SPAWN.md](SPAWN.md#--runtime-herdr-and-restore)); sessions that work together share a workspace, each in a pane of its own, so a command aimed at one session names its pane.
Sessions run in bypass-permissions mode, yet some commands still prompt (`rm`, an `sh -c` wrapper) and a subagent may not inherit bypass, so a session can sit waiting on a prompt.

## Spawn

1. Pick the name: `bun run name <kind>` in the Playground checkout prints a new one, `<id>-<kind>`, a 6-letter id that no roster entry, ended ones included, no registry file and no backend pin holds, then the session's kind, as `k3m9px-worker` (a reused name would bring back an old session's history, a bloated context).
   Every new session takes one, a checker with an id of its own: spawn.sh writes its worker into the roster's `worker` key, which nests it under that worker.
   spawn.sh takes lowercase words joined by hyphens that give the kind its mode names, as `<id>-<kind>` or an old `<kind>-<words>` (the Dashboard capitalises each word it can see, so `probe-anne-liaison`, never `probe-anneliaison`), and refuses a name that gives no kind or another (`k3m9px-reviewer` started as a worker).
   Give a worker its title with `--title "<title>"`: plain words of up to 40 characters saying what it does, which the sidebar shows in place of its first ask; spawn.sh refuses a worker without one.
   Keep it to 32 characters, so `Review: ` before it still fits the roster's 40.
   A checker takes `Review: <worker's title>` or `Test: <worker's title>` from its worker's roster row by itself, so a checker's start needs no `--title` while its worker has one.
   A runner's title is its own name: a new one whose roster row holds none takes it, as a probe takes `Probe: <name>`, so neither row shows its first ask, and it takes no `--title`.
   A lead or manager also starts under its `sessions.names` name (`builder`, `dispatcher`, `ops`, `planner` by default, the second dispatcher the dispatcher's with `-2`), an old name `sessions.aliases` maps to its kind, `optimizer`, or one the roster gives its kind, and a resume keeps whatever name the session has.
   A session started under an old name (`worker-brave-otter`, `reviewer-brave-otter`, `probe-sdk`) keeps it, and a checker spawned again for a PR takes the name it had (**rounds**).
   A session respawned after a restore takes the name of the session it replaces, since it starts fresh from a handoff rather than resumed.
   Live means `ListAgents` lists it or `herdr pane list` shows a pane running it; a roster entry, or a resume record in `~/.playground/resume`, proves nothing about life.
   Done when the name is one `bun run name <kind>` printed, or one of the names above that the session keeps or takes, and no live session holds it.
2. Spawn a new session only for a chore that needs its own context; a short job (a probe-sized check, a one-off script) runs as a background task in the session that wants it.
   Run spawn.sh by its absolute path, `"${PLAYGROUND_REPO:?}/scripts/spawn.sh"` (every launch exports `PLAYGROUND_REPO`, the main checkout), from your own folder, so your shell stays out of the main checkout, where `no-main-checkout` refuses git moves.
   A pane started by hand has no `PLAYGROUND_REPO`, so the `:?` stops the call with its name; set it there to the main checkout as the factory's hooks find it: `export PLAYGROUND_REPO="$(dirname "$(git -C <any playground worktree> rev-parse --path-format=absolute --git-common-dir)")"`.
   Start it in the background that way, the one way a factory session starts another:
   the factory's `no-raw-spawn` hook refuses every cmux call but its help or version, a `claude --resume` or `--continue`, and every herdr call but its reads (`get`, `list`, `read`, `agent wait`, `pane wait-output` and the like)
   and a scratch world's of the session's own ([scripts/README.md](../../../../scripts/README.md#spawnsh)),
   naming the script; type every program by its literal name, since one held in a variable (`$V integration add`) reads as herdr when a herdr command group follows it.
   A lead starting a checker runs `roster.ts assign <checker> "Review: <its worker's title>" <task> worker=<live worker> pr=<n>` (`Test: ` for a tester) before spawn.sh, since spawn.sh writes `worker=` only for a worker's column and roster.ts refuses a checker's PR with no live worker (step 4).
   Read [SPAWN.md](SPAWN.md) for the command of the mode you start (a worker, a runner, a checker's or probe's column, a manager) and for each flag you pass,
   and before you act on a refusal: it holds the capacity gate, the launch line with its model and effort, the resume, `--account`, `--backend glm`, `--runtime herdr` with `spawn.sh restore`, `--check`, and the role and settings every launch carries.
   Done when spawn.sh has printed herdr's `herdr pane <id> workspace <id>` line for the session, or a refusal you have acted on by its gate's section in SPAWN.md.

3. Brief it with `SendMessage` once `ListAgents` lists the name, writing the brief with writing-for-agents loaded (SKILL.md's **writing** rule).
   The brief carries its name and role, who it reports to, the task (for a bundle, its items and its test area, the pages and files it touches, and each `.agents/dashboard/<topic>.md` its item touches, since AGENTS.md holds only their pointers and ALWAYS lines),
   the words the task came from quoted verbatim, the done criterion (the **gate** for a PR; a worker marks its PR ready at 5/5, and the merge path marks a green draft ready itself), "load the playbook skill",
   an ETA with its first reply (**eta**),
   for a GLM worker's brief that it paste the raw `date -u +%FT%TZ` output into every report, beside the ETA it computes from it, since brief-rush never reaches the GLM lane,
   and that it runs only commands that need no approval: one plain command per call, no `sh -c` or `bash -c` wrapper, no `rm`, no `cd` (absolute paths, `git -C` and `bun run --cwd` instead: inscope's zsh hook runs 1Password's `op` on every `cd` and new shell, prompting the owner's fingerprint)
   apart from the one at a worker's end (LIFECYCLE.md), which prompts once, the **signal** rule, a literal absolute path for `gh --body-file`, since `no-playground-leak` and `no-release-comment` each refuse a path built from a shell variable (`brief-rush.md` holds the three-call body edit), a scratch script written through the Write tool and run as `bun <path>` (new-worker.md says why),
   that a worker starts its fixture stack outside run-slot, only while it takes shots, since a command that never exits would hold a slot until it is stopped (**slots**), that a multi-stack ask (a bisect, an A/B) builds one stack at a time, and the **writing** rule: load writing-for-agents with the Skill tool before writing any agent-facing doc, a handoff included.
   A worker's brief says that any change under `web/next/`, a docs `.mdx` included, gets its tester's drive, posted as a `## TesterBot · PASS at <sha7>` comment.
   A guard's plan and its brief (a hook or a gate that refuses calls) each name its threat model as a closed list of literal forms (for a path guard: an Edit or Write tool call on the path, and a shell write, copy, move or delete that names the path literally),
   say plainly that a same-user session can still get past the guard by a form outside that list, and hold a Done when that names only forms from that list.
   A guard's brief tells its worker that it, and every harness it starts, tests each form only as data, through the hook's own `check()` or test entry point, and runs no recursive-delete form at all, since a form can name a path outside HOME, so pointing HOME at a scratch folder contains nothing.
   A guard's false positive that has a working form takes the docs path first: name the working form once, in the skill that hits it.
   A loosening goes ahead only when no working form exists or the refusal recurs.
   A loosening's plan and brief name the one class of forms it lets run, and every other form keeps canary's verdict, as `tests/scripts/hooks/refused-forms.test.ts` checks row by row.
   By round 3 on that guard, or at its reviewer's ask for a scope ruling, the lead narrows the PR to that list or moves the protection to a layer that parses no shell, since a guard asked to stop every form never closes: on 1 Nov one ran 16 rounds over 299 minutes, each finding one more shell form, then shipped refusing read-only awk.
   A worker starts its checkers in one step, once its PR's head is ready (its checks green at it): its reviewer always, and its tester (`bun run name tester`) with it when a tester's drive is due, since a reviewer started later left heads waiting over an hour; ops-sweep tells the worker's lead of a head ready 20 minutes with no review round and no live reviewer.
   Done when both are briefed, or the reviewer alone for a PR with no `web/next/` change.
   A worker's brief says that before a push it runs only the touched tests, the list `extensions/core/skills/code-review-loop/scripts/state.ts touched-tests <worktree> origin/canary HEAD` writes to a file it checks is non-empty before passing it to xargs (code-review-loop's two steps), and check-types, through run-slot, and leaves the full suite to GitHub Actions,
   whose `Audit, Lint, and Build` and `test` checks gate the head (**ci**).
   A brief names a `CLOCK_AHEAD_DAYS=30` run only for touched test files outside `CLOCK_EXEMPT` (`packages/scripts/src/clock-exempt.ts`), since a run over exempt files alone runs nothing, a no-op its report names as one rather than a pass: on one PR all 3 files a brief named were exempt.
   A brief that has its session clone a repo no org guards places the clone under `.claude/worktrees/<name>` in the Playground checkout and has the session name the clone's path in its last report, since no automated cleanup reaches a plain clone (two clones left in a session's scratch folder stayed behind), so its lead removes it by hand with `playground rm --worktree <path>`;
   under `~/.playground` only the caller's own `scratch/<name>/` and `scratchpad/<name>/` clear, through a plain `playground rm <path>`, and every other path there stays refused.
   A guarded org's clone goes where `scripts/briefs/new-reviewer.md` puts it, in the org's folder (code-review-loop says why).
   A worker's brief says that a PR holding a long-lived connection (a socket, a pub/sub subscriber, a retrying client) puts code-review-loop's lifecycle table in its Evidence before round 1, one row per path from connect to close.
   A worker's brief says that a PR loosening a guard puts code-review-loop's refusal table in its Evidence before round 1: a `canary | head` row for each row it adds to `tests/scripts/hooks/fixtures/refused-forms/` or names in a source file's `allowed` list, and the refused-forms test's pass count at canary and at the head for the rest.
   It also says that before each review round the worker sweeps: it runs canary's hook and the head's hook over that fixture plus forms of its own around the loosened class (a `source`, a function or alias defined in the same call, a name hashed in the same call), and fixes each form outside the class whose verdict differs, pinning each one canary refuses as a fixture row,
   since on 2 Nov the one hook PR that swept about 75 forms before round 3 found three classes there that the reviewer would otherwise have found one a round.
   The sweep is done when every form it ran outside the class gets canary's verdict at the head under review.
   The body labels both counts apart: the refused-forms test's own result as `refused-forms.test.ts: N/M` passing, and the sweep harness's form count as forms swept, since on 2 Nov a body gave a harness's 1,248 forms as the test's pass count and round 1 filed it as a should-fix.
   A worker's brief says that CI starts only on a pull request into `canary`, so the worker opens its draft PR before it waits on CI, cites a run by its run id or link, and records its branch on the roster at its first push (ROSTER.md's It pushes its branch), so ops-sweep tells its lead when the branch goes 15 minutes with no PR.
   A worker's brief says that a docs-only worktree still runs `bun install` through run-slot before its first commit, since lefthook's hook runs the worktree's own `node_modules/.bin/lefthook` and the commit stops without it, while a review worktree that only reads needs no install.
   It also says that after a merge of canary that moves a path a test fixture uses, the worker points the fixture's reader at a missing path, confirms each fixture-reading case goes red, then restores the reader with `git checkout --`, since a reader that fails open passes a fixture at the old path.
   It also says that a worker that merges `canary` or its stack's parent into its PR keeps the merge commit a plain merge, holding its conflict resolutions alone, and lands each edit after it as a commit of its own, since code-review-loop scores an edit inside a merge as blocking, and that a stacked child takes its parent's final head, by DISPATCH.md's bundles.
   It also says that a stacked child retargeted to `canary` after its parent merges pushes a merge of `canary` before it asks for review, since on 2 Nov GitHub kept one retargeted PR CONFLICTING with no CI run while a local `git merge-tree` was clean, and only a push made it recompute.
   A lead's instruction or a reviewer's brief leaves any raise of a ratchet, or bend of a check whose own rule says it never rises, to that rule's owner, asked on the PR or directly, before the code relies on it, and lists one as agreed only with the owner's words quoted (23 Oct: a raise a brief listed as agreed reached 5/5, and the code owner blocked it).
   A worker started `--in` another repository takes that folder's MCP tools, so its brief names the capability it needs (search Slack, read Datadog logs) and has the worker find the tool with its own `ToolSearch` (21 Oct: a brief named a Slack tool by the factory's own server, and the worker found it under its folder's server).
   A worker briefs its checker by filling a template: it copies `~/.playground/handoffs/new-reviewer.md`, or `new-tester.md` for a Playground PR, to a file of its own under `~/.playground/`, since the linked template is the main checkout's file, fills each slot and passes that file to spawn.sh as `<brief>`.
   The fill rule: a slot is a word of capitals and digits with two underscores on each side, in backticks since the formatter turns a bare one bold, such as `__NAME__` for the session's own name, and a fill replaces those tokens alone, every one of them:
   a `sed` fill takes `/g`, since a slot can sit twice on one line (`__PR__` does in both templates) and a bare `s/…/…/` fills only the first, which spawn.sh then refuses as a slot left.
   So `<owner>/<name>` and every other angle-bracket word stays as written for the reader (22 Oct: a fill of `<name>` by `sed` also rewrote `--repo <owner>/<name>`), and a brief or template that names a token in its own text spells it in words (two underscores, NAME, two underscores), so a fill leaves that text alone.
   Fill the brief and read it back in one call, then run spawn.sh in a later call, once the read shows every slot filled: spawn.sh refuses a brief still holding a slot of its role's template, naming each one, and a fill a hook refused in the same batch as the spawn would leave one.
   The template points at code-review-loop, dev and ui-verify for every step, so the filled brief adds only what its PR needs beyond them.
   The reviewer template's `__SPEC__` slot, under its This PR heading, holds the PR's scope as the lead ruled it, the bar the review scores against and any harness the reviewer re-runs, so the reviewer scores the ruled scope rather than the issue's first Done when.
   Fill it from the lead's ruling and the PR body's scope, and where the lead ruled nothing beyond the ticket, say so.
   Unlike the other slots, the `__SPEC__` fill replaces the backticked token together with its backticks, since the spec runs to paragraphs that inline code would break; the template keeps the backticks only so the slots test, which wants every slot backticked, stays green.
   Done when the filled brief's This PR section names the scope, the bar and the harness, or that there is none, and spawn.sh starts the reviewer, since it refuses a brief still holding the `__SPEC__` token, naming it.
   The tester template carries no such slot, since a tester drives the diff's surfaces for CI and posts PASS or FAIL, not a score against the scope.
   A probe's brief adds that it ends by telling its spawner it is done, so the spawner closes its pane (End).
   A brief that has a script written for `/bin/bash` keeps it to macOS's bash 3.2.57, which stops on a fractional `read -t 0.5` (`invalid timeout specification`): wait in whole seconds (`read -t 1`), or run the script under zsh or bun.
   A rule that changes while a checker is live goes to it at once from its worker's lead by `SendMessage`, as an addition to its brief, since a checker that never heard of the change scores it as a finding (12 Oct).
4. Record the start by [ROSTER.md](ROSTER.md)'s start rows (a session respawned after a restore, by the respawned-session row, which keeps the entry's work).
   A worker that spawned a checker or a probe sends the Builder its name, and adds `pr=<its PR's URL>` to a checker's entry beside the `worker=` spawn.sh wrote, which the Dashboard nests it under its worker by.
   A checker's next PR goes on its row with `roster.ts assign <checker> <title> <task> worker=<live worker> pr=<n>` whenever its row's `worker` is unset or ended, since the checker reaper ends a checker whose worker has gone (`checker-worker-gone`).
   roster.ts refuses `prs+=`, `prs=` or a new `pr` on such a row, spawn.sh's restart of an ended checker included, naming that assign.

Send the brief with `notify_when_idle: true`, so its next idle arrives as a notice.
Done when `ListAgents` shows the session busy on the brief and the roster shows the task.

## Fix pushes and nits

A reviewer's round sorts its findings into blocking, should-fix and nits; the worker's answer follows these rules, so a PR's rounds stay short and its nits land where they cost nothing.

- A fix push carries only blocking and should-fix items, plus the `canary` merge the reviewer asks for (code-review-loop's step 8), and a body-only fix is a `gh pr edit` with no push, so a push always moves the head for a reason the reviewer named.
- Keep a nit only if it fixes a wrong statement, a misleading name or comment, or a real readability problem; drop a style-only nit with a one-line note.
- A head at 5/5 with green checks merges as it stands; fold each kept nit into the next PR that touches the same file, never a nits-only PR.
- Post one sort comment per PR, naming each nit kept, with the PR it waits for, or dropped, with why.
  Done when every finding of the round is fixed in the push, kept in the sort comment with its PR, or dropped there with its reason.

## Write a handoff

A handoff, for a respawn, a parked chore or a priority close, counts as written only once `TZ=UTC ls -l <path>` prints its file, and the report that names it quotes that line.
A handoff names the session's open items, each PR with its head, its next step and its own transcript path, which `ls ~/.claude/projects/*/<id>.jsonl` prints, `<id>` the session id in `~/.playground/resume/<name>.sh`, so whoever picks the work up can read there a detail the handoff dropped.
A hook can refuse the write and leave nothing on disk, so a session whose write a hook refused answers the hook and retries the same write before it reports.
Done when `TZ=UTC ls -l <path>` prints the file, `ls` prints the transcript path it names, and the report quotes the `ls -l` line.

## Rename

A session takes its name at spawn (`claude -n <name>`), and that name is the one `ListAgents` and the dashboard show.
Nothing renames it later: typing `/rename` into its pane would read as the owner, and a `/rename` sent by `SendMessage` arrives as plain text, which Claude Code never runs.
Its pane's label carries that name too, and `spawn.sh close` and `spawn.sh restore` find the session by it, so the label stays as spawn.sh set it; the `no-raw-spawn` hook refuses `herdr pane rename`, which is no read.

The roster keeps the name the session took at spawn, since the dashboard pairs a roster agent with its session by that name.
Done when the roster and the pane's label both carry the name the session took at spawn.

## Check a session

A sweep reads each agent's state from four places:

- `ListAgents`: its row says whether the session is busy, idle or waiting, and its absence means the session is down.
- `herdr pane list`, run in a pane on the session's server: the pane whose `label` is the session's name has `agent_status`, which reads `blocked` while the session waits on a person, `working` while it runs, and `idle` or `done` while it waits.
- `herdr pane read <pane id> --source visible --lines 40` (raise `--lines` for more): what it waits on, a picker or a permission prompt; `visible` reads the screen as it shows now, where `recent` would scroll the session.
- the session-state record at `session-state/<session id>.json` in the data folder: its `state` reads `working`, `idle`, `stuck`, `failed` or `usage-limit`.
  The way from a session's name to its id: the `~/.claude/sessions/<pid>.json` file that names the session holds its `sessionId`.
  A `stuck` or `usage-limit` record goes stale once the transcript holds a newer turn (`stateNow()` in `packages/config/src/session-state.ts` reads it as over), so the positive check is the record reading `working` with `at` after the send.

## Message a session

`SendMessage` takes a live session's name.
A send that reports `Failed to send` may still arrive, so a sender re-sends it once at most, its first line marked `re-send`, and a receiver drops a `re-send` copy of a message it already holds.
When the failed send went by name to a session `ListAgents` lists, that one re-send goes to the `uds:/tmp/cc-socks/<pid>.sock` address the session's newest message came from (its `from`).
The after-resume re-send ([SPAWN.md](SPAWN.md#resume)) takes the same `re-send` marker.
Before you report that a session is acting on your message, read its session-state record as Check a session reads it: a record still holding `stuck` or `usage-limit` holds the message unread.
Done when the send, or its one re-send, returns success.

## A headless run

A Claude session whose own toolset lacks a docs tool's MCP server writes that tool's pages through headless `claude -p` runs from `~`, which loads the server (`<server>` below, with its `<fetch>` and `<update>` tools; the path is a Claude session's alone, the **glm** rule).
Every run takes the shape the [no-headless-login](../../../../scripts/hooks/README.md#no-headless-login) hook's refusal gives: `CLAUDE_CODE_OAUTH_TOKEN` read from the Keychain item its account names, `PLAYGROUND_ROLE=<your role>` and `env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY`.
Every run also carries `--permission-mode dontAsk`, since the machine's bypass default leaves `--allowedTools` blocking nothing, and puts `--allowedTools` last, after the prompt, since that flag takes every word after it.
A run from `~` loads none of the factory's hooks, so `dontAsk` with `--allowedTools` is the only limit on what the run writes.
The write run's `--allowedTools` is `"mcp__<server>__<fetch>,mcp__<server>__<update>"`, and its prompt tells the run not to quote the page text in its reply, which a safety-classifier cut-off otherwise stops mid-way.
Before the write, the worker takes the backup itself, in a first, fetch-only run whose `--allowedTools` carries `mcp__<server>__<fetch>` alone and whose prompt calls `<fetch>` on the page and replies with nothing, on `--output-format stream-json --verbose`:
the worker copies that call's `tool_result` content into `<scratchpad>/backup-<page id>-<utc>.md`, reading the page into neither its own context nor a message, and the model never repeats the page, so a reply cut-off has nothing to stop.
The backup outlives a stop because the worker writes the file, not the run.
The worker writes nothing until the fetch call's `tool_result` carries no error and the file passes `test -s` and a grep for the page's id; a cut-off, an empty file or a missing id means no write, and the worker reports it.
After the write, a second fetch-only run copies the page to an after-file the same way, and the worker checks the after-file with a grep for the change.
When the write stops or the after-file does not hold the change, the next write run restores the page from the backup piped on its stdin, and a third fetch-only run copies the page to a third file, which passes the backup's checks (no error in its `tool_result`, `test -s`, the page's id) before the worker greps it for the change gone.
The worker reports each write's read-back, and each restore with the after-file's check and the third file's.
Done when the after-file holds the change, or, after a restore, the third file passes the backup's checks and shows the change gone, with the restore and both checks reported.

## Answer a permission prompt

A manager answers the permission prompt its session's stuck alert names, by the key the alert gives its call (**unstick**), the session-state hook's alert or ops-unstick's alike:

```bash
playground picker <session> allow <key>
playground picker <session> deny <key> "<why, and the simpler shape to run instead>"
```

Allow presses Yes once in the session's herdr pane while its prompt shows that call, a subagent's command included; deny presses No (Escape), and the relay sends the session the reason.
Each answer is a line in `ops/picker.log`: the time, the manager, the answer, the session and the command's first 120 characters.
Done when it prints that line; it refuses any caller but the session's manager or the primary dispatcher, a deny with no reason, a dispatcher's session, a session in no herdr pane, and a key no waiting call or shown prompt matches, which means the prompt changed: wait for its next alert.
An ops-unstick alert that says picker cannot answer the prompt found no waiting call surely its own, and names the close and resume below.
Picker also refuses a prompt that may be another waiting call's, as a subagent's file or URL prompt always is while its parent waits.
A herdr pane takes no key from your hand, since `no-raw-spawn` refuses every herdr call but a read, so end that prompt by a close and a resume under the session's name:

```bash
"${PLAYGROUND_REPO:?}/scripts/spawn.sh" close <session>
# the exec line ~/.playground/resume/<session>.sh holds, whole but its exec, so the session keeps its account, model and effort
<that line> --brief <a file under ~/.playground of the reason and the simpler shape to run>
```

The session comes back by its session id with its transcript, and the prompted call never runs.
Done when the session works again from its brief.

## Keep the sweep running

A lead keeps two cron jobs in its own session:

1. The sweep: `CronCreate` with `cron: "*/15 * * * *"` and the sweep as its prompt, which starts with `playground sweep <your name>` ([SWEEP.md](SWEEP.md)).
2. Its renewal: recurring jobs lapse after 7 days, so `CronCreate` with `recurring: false` 6 days out, whose prompt deletes the sweep job (`CronDelete`), creates it afresh, and schedules the next renewal.

Done when `CronList` shows both.
A lead's new session creates both again.
Ops, when it slows or pauses its own sweep on purpose, a usage squeeze or maintenance, writes `~/.playground/ops/sweep-hold-until` one future ISO 8601 time with its zone, so ops-tick's relay watch stays quiet until it passes (it lapses on its own, and a missing, empty, past or unreadable time leaves the watch on; [LIFECYCLE.md](LIFECYCLE.md#starts-and-ends), the relay watch).

Every manager (the dispatcher, the Planner and each lead) also keeps one background task waiting on its queue of alerts (ops-stuck-alert.jsonl, where a session's own hook queues its stuck alerts and ops-tick's relay watch queues its late-stop line), so a stuck session reaches it in seconds rather than after the relay's turn (**unstick**), and a late sweep reaches Ops, then the dispatcher,
the same way:

```bash
playground alerts-wait <your name>
```

Run it with Bash `run_in_background`; when it exits it has printed one alert: start it again at once, then act on the alert, a stuck session's or a late sweep's, whose line Ops answers by running its sweep or resuming the relay, and the dispatcher by resolving the stop, posting to the owner's Inbox only if it cannot.
A waiter started after time down skips the alerts queued over 5 minutes before it began and names how many, since the relay sent each; while none runs, each alert also goes to Ops to send on, which is fast only while Ops' own waiter runs, so each line to Ops names Ops' restart while it does not.
A worker a probe reports to keeps no waiter, and its probe's alert comes by the relay alone.
Done when the task is running; the relay sends the same alert later, so drop that copy.

## Wait on a signal

A lead waits on the signals the **polling** rule names, never a `sleep` loop or a repeated `gh` read.
A signal that stops coming may be the Mac asleep: read `pmset -g log | grep -E ' (Sleep|Wake) {2,}'` before you name a gap in a relay, a tick or a sampled series, and leave the sleep out of any rate.
A Monitor or watch script runs under zsh, which does not word-split `$list`: loop over literal values or write `${=list}`, since zsh reads `$list` as one item.
Run each measurement as its own background task, since a chained task signals only when the whole chain ends, and a stall in its first stage once stayed hidden for 41 minutes.
A wait on an owner step starts with two checks: the step's card is open in the Inbox as an ask the owner can answer, and its precondition can come true (whatever writes the file or state it waits on is running).
When either check fails, report it to your lead at once, since a dead waiter, one whose condition can never come true, waits for good: one sat about 3 hours on a file only a job that was off could write.
Wait on CI with `gh run watch <run id> --interval 300`; `gh pr checks --watch --required` exits 1 here, since the repo reports no required checks.
Before you report CI green, read the check-runs at the head sha once in the foreground (`gh api repos/<repo>/commits/<head sha>/check-runs`).
A background or Monitor event alone is not a green.
Done when every wait ends on a signal, each background task holds one measurement, every wait on an owner step has its open card and a precondition that can come true, every CI green you report was read in the foreground at the head, and every gap you name is checked against the sleep log.

## Answer a picker

Sessions in the chain ask by `SendMessage`, and `no-chat-question` refuses `AskUserQuestion` to a worker, checker, runner or probe.
A picker that shows anyway (a session the hook cannot place, or a manager's) sits in a herdr pane, which takes no key from your hand, as Answer a permission prompt says:

- When a rule or a sound default decides it, end it by that section's close and resume, with a brief that gives the answer.
- When only the owner decides it, give the resume brief the choice to post as an Inbox decision (**ask**), so the session carries on.
- When the owner is answering the picker in that pane or on the Dashboard, leave it to the owner and wait for the session's report.

Done when the session's state record reads `working` with `at` after the resume, or the owner has the picker.

## End

A finished worker, reviewer or tester ends automatically (`scripts/ops/optimizer/auto_end.ts`), so a lead ends one by hand only on a `Not ended` line, and reassigns or ends a worker on a `Kept` line:

- `pr:merge` and the train's land end the merged PR's sessions by their roster `pr`, right after the merge; a worker `assign` gave a next task holds no `pr` of it, a checker whose worker's row names another PR stays to serve it, and a session with another of its PRs open, its roster `prs` list's among them, stays, as the sweep holds it.
- ops-tick's auto-end beat, every 5 minutes, ends a checker whose PRs are all merged or closed or whose worker is gone with no live worker serving one of its open PRs (the rule in full: `scripts/ops/README.md`'s `optimizer/` entry),
  a worker whose PRs are all merged or closed and whose PR that closed last merged, an issue's URL among them never counting, while one whose last closed unmerged is kept as `worker-pr-closed` and its lead asked to reassign or end it,
  and a reviewer idle 30+ minutes whose every head carries its verdict.
  A session's PRs are its roster `pr` and `prs` list, its open branch PRs, its worker's, and every PR its own or its worker's transcript links, so one still open keeps it.
- Each end runs `spawn.sh close <name>`, then `roster.ts report <name> "ended automatically: <why>" status=ended`, the merged sha in the why, and sends its lead one line: its roster `lead`, else its worker's.
- Then it cleans each worktree the session used, one at a time (`cleanWorktree`), and the lead's line names what went and what stayed, with why; a reviewer ended idle keeps its worktrees for its resume.
  A Playground worktree in `.claude/worktrees/` with uncommitted work, unpushed commits or work not on canary stays until `playground rm` confirms its PR has merged or closed (its own PR, by its branch or its exact head), then goes through `playground rm --worktree <path> --discard` whatever it holds, with no Inbox decision; another repo's such worktree stays.
  The live dashboard's checkout stays, by its branch.
  A Playground worktree in `.claude/worktrees/` that a live session or a clone holds stays, where a hold by the merged PR's number alone, from the worker still merging it, does not count, nor does a row naming it by its branch or its own PR's number once that PR has merged or closed and the worktree sits at that PR's head (`playground rm`'s `freed by` line;
  commits past that head keep the hold, named with them).
  So does one a symlink outside it points into (another worktree's, a marked scratch folder's or a session scratchpad's, at its top level or one level into its `node_modules`), and its line names the first three links.
  Any other whose `.turbo/dev.pgid` records a stack has it stopped first (`bun run dev:stop` there, whose refusal keeps it), so a clone with no record, a reviewer's with no `node_modules` among them, goes on with nothing to stop.
  Then it goes to the 7-day trash through `playground rm --worktree` (`--pr <url>` at a merge), which keeps one a process holds,
  its `node_modules` folders and `web/next/.next` removed from the trashed copy, which a `bun install` rebuilds, and then loses its `playground-<worktree>-db` and `-redis` containers (`docker rm -fv`, each name matched whole, never the live dashboard's database) and its local branch.
  Another repo's worktree goes through `git -C <repo> worktree remove <path>` with no force flag, then `git worktree prune` and `git branch -D`; the main checkout is never one.
  A session clears its own scratch itself before it ends, with `playground rm <path>`: its `~/.playground/scratch/<name>/` and `scratchpad/<name>/`, each path resolved past symlinks, are the one place `playground rm` clears there, for that session alone, and every other path there, another session's scratch included, stays refused.
  A `scratch/` folder left once its session is gone, with no live session and no roster row naming it that has not ended, the nightly clean moves to the trash ([LIFECYCLE.md](LIFECYCLE.md)).
- Guards: only a worker, reviewer or tester, not busy for 10+ minutes, with no uncommitted or unpushed work in a worktree it used (the main checkout, where every session starts, is not one, nor a Playground worktree whose PR `playground rm` confirms merged or closed, which the cleanup discards); otherwise its lead gets a `Not ended` line saying why, and the session waits.
- A reviewer ended idle is resumed by its worker on the next push, under the same name (**rounds**): `"${PLAYGROUND_REPO:?}/scripts/spawn.sh" resume <name> <dir> --pr <its PR's URL>`, or its extension item as `<scope>/<kind>/<key>` (the `--pr` rule is [SPAWN.md](SPAWN.md#modes)'s); its `Ended` line goes to its worker too.

A session ends by closing its pane, so the workspace's other sessions live on, by the one it reports to, through spawn.sh, since the `no-raw-spawn` hook refuses `herdr pane close` to every factory session (herdr's socket has no access control):

```bash
"${PLAYGROUND_REPO:?}/scripts/spawn.sh" close <name>
```

A session does not close its own pane, since that kills its claude mid-call: it tells the one it reports to that it is done (a checker or a probe, its spawner), who closes it.
Before you close a checker by hand, read its roster entry and ask it which rounds it still holds, since it may be serving another PR (on one PR a reviewer closed mid-round).
It closes the one pane spawn.sh opened for that name, found by the label it set, on the server the session's resume record names (the factory's when the record has no `# server:` line), and prints `closed <name> (pane <id> on <server>)`.
It refuses a session whose runtime pin does not read herdr or that has no resume record, a server that is down or a herdr that is not the pinned one, no pane or two panes carrying the label, and your own pane, quoting herdr's words when herdr refuses the close.
It sets the session's roster row to `ended` itself just before the pane closes, so a restore that finds the session gone leaves it down, and puts the old status back when herdr refuses the close;
it leaves the pins and the resume record in place, so `spawn.sh resume` can reopen the session, setting the row back to `starting`, as any new start of that name does;
a reviewer or tester comes back with `--pr <the PR it serves now>`, which replaces the PRs its row lists ([SPAWN.md](SPAWN.md#modes), scripts/README.md's spawn.sh).

Record why it ended with `report <name> "<why it ended>"` (ROSTER.md, It ends).
`"${PLAYGROUND_REPO:?}/scripts/spawn.sh" resume <name> <dir>` reopens the session later if it is needed, in the folder it ran in, or anywhere with its session id after `<dir>`: a resume by name alone refuses a folder whose transcripts hold no session of that name.
A herdr session's end is its roster `ended`: with any status but done, ended, parked or paused, `spawn.sh restore` brings it back after the server's next restart.
Done for a herdr session when `bun run --cwd <dashboard checkout> verify ended <name>`, read-only against the live dashboard, which it finds through portless from that checkout (`.agents/dashboard/writes.md`), passes:
it reads the session Ended as the Dashboard does, the roster showing `ended` and no live session holding its name, and fails while live sessions or a herdr server could not be read.
A session that closes to be respawned after a restore ([SPAWN.md](SPAWN.md#role-and-settings)) records no end, since the respawned session keeps the entry, and comes back by Spawn instead, briefed with its handoff, since a resume brings the old context back.
