# Spawn

What [SESSIONS.md](SESSIONS.md#spawn)'s step 2 runs: each mode's command, then the gates, flags and launch spawn.sh applies to a start.
Read the section for the mode you start and for each flag you pass, and the section of a refusal's gate before you act on it.

## Modes

- **A worker** opens its own workspace, named after it, in the Playground checkout, or in the folder `--in <dir>` names under the code root or the folder of an org `ext.links` guards, reporting to the builder, or to the session `--reports-to <session>` names when its brief reports elsewhere; **a runner** the same, reporting to ops, with no `--reports-to`.
  spawn.sh names each with `roster.ts who builder` and `who ops` ([ROSTER.md](ROSTER.md)), each seat's live holder, else its `sessions.names` name, so a manager respawned under a new name takes its new workers at once:

  ```bash
  "${PLAYGROUND_REPO:?}/scripts/spawn.sh" worker <name> <brief> --title "<title>" --account <email> [--reports-to <session>]
  "${PLAYGROUND_REPO:?}/scripts/spawn.sh" runner <name> <brief>
  ```

- **A checker or probe** opens as a column in its spawner's herdr workspace, to the right of the newest member's pane (the worker for its reviewer, the reviewer for its tester), run from its spawner's session, which it reports to:

  ```bash
  "${PLAYGROUND_REPO:?}/scripts/spawn.sh" column <reviewer|tester|probe> <name> <reports-to> <the newest member's herdr pane id> <brief> --account <email>
  ```

  A reviewer or tester adds `--pr <pull url>`, the pull request it serves, or `--pr <scope>/<kind>/<key>`, the extension item it scores, which its resume record keeps, so open the PR as a draft before its checkers ([scripts/README.md](../../../../scripts/README.md#spawnsh) holds the refusal and the row it writes).

- **A manager** opens the same way as a column in the `Managers` workspace, to the right of the newest manager, named once: `column <name> <pane> <brief>`.
  A name whose roster kind, else its name (an `<id>-<kind>`, a `sessions.names` name or a `sessions.aliases` one), is builder, ops or planner opens as a lead reporting to the first dispatcher (a new name gets its kind first, `scripts/roster.ts set <name> kind=builder task=<what it does>`, which writes a `starting` entry that `managerOf` keeps behind the live one until it answers);
  the first dispatcher (its `sessions.names` name, an alias of it, or an `<id>-dispatcher`) opens briefed by the session running spawn.sh, its prompt reporting to no one, and from outside a session (no `CLAUDE_PID`) takes the long form `column dispatcher <name> <the lead that briefs it> <pane> <brief>`.
  The first dispatcher (`sessions.names`' dispatcher, which `playground dispatcher` starts, working with the owner and reporting to no session), the second dispatcher (Inbox #i520), a dispatcher's name with `-2` or an `<id>-dispatcher` it records as `slot=2`, the optimizer (which `playground optimizer` starts), and the Planner,
  the Builder and Ops (which `playground planner`, `playground builder` and `playground ops` start the first time the dispatcher routes work to each) open instead in a workspace of their own, named after each,
  in the main checkout's `.claude/worktrees/leads` (`manager <name> <brief>`, the optimizer by its name or its roster kind, a new name given `kind=optimizer` first the same way;
  an orchestrator of any other manager kind in `kinds.ts`, such as the Assistant or the seatless `orchestrator` kind the sidebar's plus starts, any number at once, opens there too, as a lead reporting to the session its row names, once `scripts/roster.ts set <name> kind=<kind> reportsTo=<session> task=<what it does>` has given it both, and spawn.sh refuses it naming that line until it has;
  spawn.sh refuses the second dispatcher on Claude without `--account <email>`, a second account, so it never shares the first's login, and a resume of it whose pin names claude needs `--account` again, since nothing records the account).

## Capacity gate

This section is the one list of spawn.sh's start gates, each with its rule; every other doc and spawn.sh's own comments point here, so a gate changes in this section alone.
spawn.sh holds the machine's room in code (the room is the cores in use, not a count of slots), through a capacity gate of five gates in order that refuses, failing closed, the first failure naming its gate and its reading (while no session cap is set, Ops watches the live board for the risk of a terminal that stops answering, as cmux did at 49 live sessions and load5 97).
A **priority start** below is a `--priority` start while a priority file stands in the data folder: `priority.json`, an org's own `priority-<name>.json`, a job's own `priority-start.json` or a session's own window (`playground priority on`, [scripts/README.md](../../../../scripts/README.md#spawnsh)) for that session's own start, since priority work comes first;
with no priority file that passes it, a `--priority` start is refused, naming each file that stands and why it passes none, or the command that opens one when none stands.
A window passes as run-slot's queue reads it (`run-slot.sh window`), a `priority*.json` that is no JSON object, such as a window emptied mid-write, passes no start, and the row's `readings.priority` names the file the start passed on.
A session's own window also ranks that session's heavy runs first in run-slot's queue, after focus and a lead's hand-written `run-slot.priority`, while it has a run waiting ([scripts/ops/README.md](../../../../scripts/ops/README.md)).
A **just-closed resume** below is a resume within 15 minutes of `spawn.sh close` ending a row that read live (not `ended`, `parked`, `paused` or `done`), which the close keeps in the data folder's `closes/<name>` with its time and the row's status.

1. **load**: the higher of load1 and load5 (the third field of `sysctl -n vm.loadavg`, on Linux `/proc/loadavg`), plus the starts of the last 5 minutes (`gates.startsWindow`) in its own `capacity.jsonl` and in each `slots.peers` folder's,
   each weighing half its item's load units (small 1, medium 2, big 3: `--size small|medium|big`, else small for a reviewer or tester, else what `scripts/ops/run-slot.sh size <name>` reads from the roster and plan.json; [rules/slots.md](../../rules/slots.md)),
   under the core count (`sysctl hw.ncpu`, on Linux `/proc/stat`'s `cpu<n>` lines) times `PLAYGROUND_LOAD_MULT` (default 1.0), less a quarter (`gates.smallReserve`) kept for small items unless the start is small, so a big plan never blocks the small ones, while a small worker keeps an eighth (`gates.reviewReserve`) in its place for the reviewers and testers, which start small,
   so a held review starts ahead of a new worker.
   It refuses at or over that line whatever the CPU's idle share, since the owner's rule keeps the load under the cores so a worker or two can be closed to make room, the refusal naming the load, the starts and the line.
   A priority start passes it, and so does a just-closed resume, its row's `readings.just_closed` naming the close, since that session already counts in the load it comes back into.
   A manager's start or resume (role dispatcher or lead, an orchestrator's included, by every path: `spawn.sh restore`, `playground <manager>`, the Dashboard's start, switch and restart) passes it while the CPU reads 40% idle or more (`top -l 2 -n 0`'s second sample, on Linux two `/proc/stat` reads a second apart, run-slot's default bar for slots 2 to 4),
   its row's `readings.cpu_idle` naming the share,
   since after a reboot load5 still carries the boot's spike and each settled start still counts, which held the managers' restore at 63% idle; under 40%, or with no reading, the line holds it and its refusal names the share.
2. **memory**: memory pressure level 1 or 2 (`kern.memorystatus_vm_pressure_level`, on Linux PSI's `/proc/pressure/memory`) with 8% or more free (`gates.memoryFreeMin`, `kern.memorystatus_level`, on Linux `/proc/meminfo`'s `MemAvailable` share),
   and for a fresh worker start alone swap-ins under 100/s (`gates.glmSwapinsMax`, the median of 3 one-second samples, `vm_stat -c 4 1`'s rows after its since-boot row, on Linux `/proc/vmstat`'s `pswpin` rise over each of 3 seconds, so one second's burst holds no start), refusing when neither gives a reading,
   since free memory counts compressible pages and read 62% on 7 Nov while 150 pages swapped in a second; every other start keeps its pass, as at the slots gate.
   A priority start still meets it.
3. **slots**, for a fresh worker start alone: room for its runs, `scripts/ops/run-slot.sh room`'s lanes, held lanes, free lanes (open and unheld while the queue's next run fits its load units by run-slot's one gate, `unit_fits`, or a medium run with no waiter, `slots.peers`' holders counted; none while focus's hold stands, which the wait loop obeys too) and live waiters,
   refusing while no lane is free and a run waits in the queue, or when room gives no reading, so a new worker never joins a queue it has no room in.
   A priority start passes a full queue, and a `--reads-only` worker start passes it with its row's `readings.reads_only` true, since a worker that only reads runs nothing through run-slot, while the other four gates still hold it; a reviewer, tester or resume skips it, so work already admitted finishes.
4. **sessions**, while `gates.sessionCap` is set (0, the default, caps nothing): a worker, reviewer or tester start under that many live workers and checkers in the roster, rows reading `starting`, `waiting` or `working` named `<id>-worker`, `-reviewer` or `-tester`, or with that word first, the starting name's own row left out, so a checker `roster.ts assign` wrote first counts once,
   refusing at or over the cap, naming the count, the rows and the cap, its row's `readings.sessions` and `readings.session_cap` naming the count and the cap, and failing closed on a roster file that does not read, while no roster file at all counts none.
   A priority start passes it and marks its row `priority=1`, which the count leaves out, so a job's own priority starts sit outside the cap (a start without the flag clears the mark, as for `sandbox=on`); a resume of a row reading live passes it, and so does a just-closed resume, its row's `readings.counted` true, since the count held that session.
5. **usage**, the launching backend's own window, which a priority start still meets.
   Claude's from `usage.json`: written in the last 15 minutes, the 5-hour window under 90%, the week within its pace, which never sits below one day's share of 14.3 points, so a week that has just reset passes its first day,
   or under 98%, a sanity backup, while `~/.playground/usage-pace-off-until` holds a future ISO 8601 time with its zone, which ops-sweep writes and renews while an account the split can pick projects under 100% at its week reset (`scripts/ops/README.md`'s Usage forecasts), or a person writes by hand, and the pass line names, a missing, empty, past or unreadable time leaving the pace on.
   A resume of a session whose own roster row reads live, or a just-closed resume, is judged against the 98% backstop alone in place of the pace, on every login and `--account` reading, since it brings back work already running; its row's `readings.pace` names the skip.
   A `usage.json` never written, as on a fresh install before the ops-usage job first runs, passes every start, its pass line reading `unread (usage.json not yet written)`, while one that exists still has to read, be fresh and be under its limits.
   Each other login's `usage-<name>.json`, and each account login-flip probes by its reading in `login-flip.json`'s `seen`, takes the same checks, its reading valid for 60 minutes, a missing 5-hour window reading as no 5-hour limit, never 0%.
   A start with no `--account` runs on the passing login next in login-flip.py's account split, else the one with the lowest week, naming it, and refuses only when every login is over, naming each one's reading, a stale one's file and age included ([--account](#--account) holds the pick).
   A login whose `usage.accounts` row sets `parkedUntil` to a later time counts as over, `it is parked until <time> (usage.accounts parkedUntil)`, so neither the split nor the lowest week picks it, and an `--account` naming it is refused with that line, a past time read as none.
   When this machine reads one login alone and it is parked, the refusal also names each `usage.accounts` Claude row neither parked nor read here, and says to sign one in with Add account in the Dashboard's Settings; with none, it stays that one line.
   A bare start runs on the login in Claude Code's config (`.claude.json`'s `oauthAccount.emailAddress`), so while `usage.json` reads another account, the factory's, that login is judged by `ops/usage/stored-login.json` (ops-usage's full reading of it, written in the last 15 minutes and naming that login, else it fails), and the factory account counts as another login, reached by `--account`.
   An `--account` start naming that login whose `stored-login.json` gives no reading (stale, missing, or its Claude Code login ended, which ops-usage writes to `ops/usage/stored-login-status.json` as `loginEnded`) starts on the login's seat token under `usage.keychainService`, as a second login does.
   That start is judged as a probed login is, by `login-flip.json`'s `seen` reading of it (its week, its 5-hour window and its `limitedUntil`), valid for 60 minutes.
   spawn.sh checks only that the seat item exists, and inside the sandbox leaves that check to the new pane with a line saying so; with none, an ended login is refused naming the owner's `/login` and `playground accounts add`, and a live one's stale reading is refused as before.
   While ops-usage's status, under 15 minutes old, reads `tokenExpired` (the login's access token expired, which Claude Code refreshes only while it runs), every refusal from the login's stale reading, `stored-login.json`'s or, while it names that login, `usage.json`'s, names that cause and its fixes: opening Claude Code, the owner's `/login` or `playground accounts add`.
   A seat that `login-flip.json` lists in neither its `accounts` nor its rotation pool is never probed, so its refusal says to add it to `usage.accounts`, or to `login-flip.json`'s `accounts` while that list is set, rather than to wait for a run.
   `--account X` naming another login is judged by X's own `usage-<local part>.json`, which ops-tick's `other-logins` beat writes every 30 minutes for each Claude row of `usage.accounts` but the stored login: the same 5-hour cap and week pace as a bare start, or the 98% backup while the pace is off, refused as `--account X: <reading>`.
   The check skips only while this machine holds no such file naming X under 60 minutes old, its pass line naming the beat, and the beat tells ops once when a login's read fails twice in a row, so a skip never lasts unseen.
   Either way `--account` refuses a week a reading names at 100% until its `resets_at`, `usage.json`'s `accounts` map among those readings (its `week` until its `weekReset`), naming the account with the most room, the lowest `week` under 100, as ops-unstick's limit alert names it.
   GLM's from `zai-usage.json`: the 5-hour window under 95% of its credits, with no week check, since its credits run on the 5-hour window alone, and no empty `balance`, which an hour after the failure that set it lets GLM starts try again, only while the ops-zai-usage job's last beat is ok and within 3 cycles, so every GLM spawn refuses until `bun run ops:zai-usage` has beaten once.
   The local model's: fewer live local sessions (roster rows live, each pinned `claude-code local`) than the `maxSessions` the model switch's `models/state.json` gives this machine's server on port 8000 (`packages/scripts/src/spawn/local-cap.ts`), 6 when the file, the machine's entry or that server is missing (K's measured limit, `LOCAL_SESSION_CAP`),
   and while that server's speed from the keep beat is under 15 minutes old: no request waiting, and where its window holds samples, `ttftMean` under `localModels.maxFirstTokenSeconds` and, beside n live local sessions (n of 1 or more), `decodeTps` times n/(n+1) at or over `localModels.minTps`;
   a resume of a live row passes the count, as at gate 4, and a file that exists but does not read refuses.

An `--ssh` probe's gates 1 and 2 read its target in place of this machine, through the System view's peer read (`peerArgv` in `api/hono/src/lib/system/peer.ts`, run with its `--key` by `packages/scripts/src/spawn/peer-gate.ts`), since its claude runs there:
the load gate takes the target's load1, load5 and cores, and counts the starts whose row's `readings.host` names the target, while a start here counts only rows with no host;
the memory gate takes the target's `MemAvailable` share against `gates.memoryFreeMin` alone, since the peer read holds no pressure level or swap-ins; a read that fails refuses, naming ssh's words.
A GLM or local start here takes its own load and memory gate in place of gates 1 and 2: load5 (the third field of `sysctl -n vm.loadavg`, on Linux `/proc/loadavg`) under 30 (`gates.glmLoad5Max`), memory pressure level 1, and swap-ins under 100/s (`gates.glmSwapinsMax`, the median of 3 one-second samples, as gate 2 reads them), so GLM and the local model start while Claude's gate holds.
Under Claude Code's sandbox, which refuses the `sysctl` command, every `kern.memorystatus_*` reading and the setuid `ps`, spawn.sh reads the load from `uptime`, the cores from Python's `os.cpu_count()`, and each live session's start from the kernel's process table (`scripts/ops/ptable.py`),
and where the sandbox refuses the pressure level the memory gate passes on swap-ins under `gates.glmSwapinsMax` in place of the pressure level and free share.
On Linux each reading macOS's command does not give comes from `/proc`'s text, as above, and a reading neither gives refuses, never reading as 0; the pressure level puts PSI on macOS's scale, 4 once `full avg10` is 10% or more, 2 once `some avg10` is, else 1 (the 10% lines are estimated, from Android's lmkd, which acts on memory stalls of 70 to 100 ms a second).
A test points `PLAYGROUND_PROC` at recorded `/proc` text (`tests/scripts/fixtures/proc.ts`), which the readings take under the test sandbox's marker (`TEST_SANDBOX_HOME`) alone, so a session that sets it reads the real machine.
Every pass and refusal is one line in `~/.playground/ops/capacity.jsonl` naming its session (`session`), which the load gate counts its starts from, a refusal's carrying the words it printed as `detail`.
Every manager start takes the gate, an orchestrator's included, but the first dispatcher's, by `manager` or by `resume` (`first_dispatcher`), which starts past a failing gate so the owner always has one:
every gate still reads past a failing one and the login pick runs, a failing usage gate leaving it on the config's own login, and its one row reads `skipped`, naming each gate it went past with a refusal's words, and counts as a start.
`bun run verify system` reads how many more workers and how many more orchestrators fit now, and what limits each.
It also refuses while a live session already holds the name (below).
A refusal names its gate and what it read: close a session that is done ([End](SESSIONS.md#end)), or wait for the reading to fall, and run it again.
Its one bypass is the first dispatcher's (above); past the gate otherwise only the owner starts a session, from his own terminal, whose sessions load no factory hook, or a PR changes the gate.

## Layout

A session that works with others opens as a full-height column to the right of the newest one in their workspace, never wrapped into a grid (side by side gives the most room, so nothing wraps): a worker's workspace reads worker | reviewer | tester, and the managers' reads `dispatcher` | `planner` | `builder` | `ops`.
A session already running stays where it is until its next restart.

## Launch, model and effort

spawn.sh starts each as `env PLAYGROUND_ROLE=<role> claude -n <name> --model claude-opus-5-5 --effort high --settings $HOME/.playground/factory-settings-400k.json --dangerously-skip-permissions` (a probe's file is `factory-settings-sandbox-400k.json`, a `--sandbox` start's its own `factory-settings-sandbox-closed-400k-<name>.json`, a dispatcher's or a lead's `factory-settings-manager-400k.json`):
every session starts at high effort, and another effort comes with spawn.sh's `--effort` at a start or a resume, by whoever playbook's chain names ([SKILL.md](SKILL.md#chain)) and brief-rush's model rule;
every session runs on `models.default` (Opus) unless it starts with `--model` naming another of `models.claude` (Fable, Sonnet or Haiku by default; spawn.sh refuses any other id, `--model` beside `--backend glm` or `--backend local`, and any but `models.checker` (Opus) for a reviewer or tester, whose verdict gates a merge, and records none of them,
so a resume takes `--model` afresh and one without it runs on Opus) or with `--backend glm` or `--backend local` (below) (Opus at extra-high effort for research and everything else, never Sonnet), and every subagent a session starts runs on Sonnet unless it names a model,
from the factory settings' `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (the owner approved #i492, 17 Oct; on GLM the alias maps to GLM), so a brief or subagent call that needs Opus names `model: opus`; a scheduled ops job that calls a model keeps its own.
A resume of a dispatcher, the Assistant or the hosted session keeps neither a model nor an effort the owner picked in its Dashboard composer ([SKILL.md](SKILL.md#chain)).
Its first prompt names the session, its role and who it reports to, and has it load this skill and read `<brief>`, a file under `~/.playground`, which spawn.sh refuses to start without (a Claude worker's adds that `brief-rush.md` binds it on its Claude lane, within the lanes its own header scopes, while that file exists; a GLM or local worker's leaves it out).
spawn.sh reads `<brief>` relative to `~/.playground` (`handoffs/brief-<name>.md`), so a bare file name fails with `is not a file`.
Every start and resume makes the session's scratchpad, the data folder's `scratchpad/<name>/`, at mode 700 before the pane opens, so its first note or log lands there.
Its skills come by `--plugin-dir` from the folder `playground orgs resolve --repo <its folder>` writes fresh from each scope's accepted copy at every start: an org's worker, in a checkout whose GitHub origin the org owns, or in a folder with no GitHub origin inside the org's own folder in the home folder (`~/<org>`), gets that org's extension's skills over core's.

`--harness codex` starts the first dispatcher in Codex in place of Claude Code: `spawn.sh manager <dispatcher> <brief> --harness codex`, and its resume, alone; spawn.sh refuses it for any other session and beside `--backend`, `--account`, `--model` or `--effort`, since Codex runs on the one login and the model its `CODEX_HOME` holds.
That `CODEX_HOME` is the data folder's `codex/`, whose `config.toml` (the login kept in its `auth.json`, no update check, the session's folder trusted), `hooks.json` and `app-server-daemon/settings.json` (no self-update) spawn.sh writes at each launch, and the launch runs the `codex` on spawn.sh's `PATH` with `--dangerously-bypass-hook-trust`,
since Codex silently drops a hook with no recorded trust.
It fails closed: the SessionStart hook writes a beat naming the session's thread, and a start or resume whose beat does not land within 60 seconds has its pane closed and is refused, with no new pin, resume record or roster row (a resume keeps its earlier pin and record, so a later resume tries again), so a Codex session whose guards did not load is stopped within a minute of starting;
when herdr will not close that pane, the refusal names the pane, since the session may still run, for you to close it yourself;
a Codex start also stops when PowerShell is installed: the beat's hook names a `pwsh` or `powershell` on `PATH`, or `/usr/local/bin/pwsh`, in place of the thread, and spawn.sh closes the pane and refuses the start or resume at once, naming it, with the same pin, record and roster row as above;
its brief rides the launch as Codex's first prompt, so it may work on that brief until then.
The beat's thread is the session id its resume record keeps, and it takes the session's name through `codex app-server`'s `thread/name/set`.
Its `hooks.json` carries the factory's guards beside the beat (`scripts/hooks/README.md`, A Codex session's calls).
Until phase 3 of the harness layer (the `plan-harness-layer` doc) lifts it, in the change it makes once a live Codex probe has passed, a Codex start or resume runs only on a scratch data folder (`PLAYGROUND_DATA_DIR` naming one), and spawn.sh refuses it on the live one, naming phase 3.

## Resume

After a restart, `python3 scripts/ops/up.py --sessions` prints the `spawn.sh resume <name> <dir> <session-id>` line that brings each session back, with `--backend glm` for a session whose newest turn ran on GLM and, for a reviewer or tester, `--pr` with the PRs its roster row serves, its `pr` first;
`--brief <file>`, with resume alone, makes the resumed session's first prompt tell it to read `~/.playground/<file>` and follow it, so it comes back working rather than idle.
Without it, the first prompt has the session act on the `after-resume` hook's instruction (the **context** rule's re-arm and re-send, and a killed commit's edit put back), so a session idle at the restart still takes a turn, and names whom it reports to now, from its roster row ([scripts/README.md](../../../../scripts/README.md#spawnsh) holds the order).
A resume leaves a finished session down: it refuses a name whose roster row reads `done`, or `ended` with an `endReason` (auto-end writes the check that ended it, [ROSTER.md](ROSTER.md)), naming the status and reason, and `--force`, anywhere among its words, brings it back on purpose, as auto-end's own resume line for a reviewer does.
A plain `spawn.sh close` writes no reason, so a close then a resume (an account move) needs no `--force`.
Before you resume a checker that auto-end ended (`checker-worker-gone`), point its row at a live worker with `roster.ts assign <checker> <title> <task> worker=<live worker> pr=<an open pull request of that worker>`, then add the issues it serves with `prs+=`, since spawn.sh refuses the resume while the row's worker has ended;
the assign sets the row back to `working`, so the resume then needs no `--force`, and a tester's resume names that pull request with `--pr`.
When the session's last folder is gone, `spawn.sh resume <name> <dir> <session-id>` needs its session id, which `~/.playground/resume/<name>.sh` holds on its `exec` line, since with no id spawn.sh refuses a folder the session never ran in.
After a resume, restart any dev stack you served, then re-arm your watches: run CronList before CronCreate, since a resume keeps the session's crons and drops only its background tasks.
Done when the restarted stack answers its `/api/health` and each watch is armed once.
Before a close that a resume follows (an account move), wait until the session has no run-slot run in flight, since the close kills that run.
Before an account move, its dispatcher tells every session that serves a dev stack, so what it serves does not go down unannounced.
A just-closed resume passes the load and sessions gates and meets the usage gate's 98% backstop in place of its pace (the capacity gate, above); later resumes go about 2 minutes apart, since the gate counts recent starts and refuses a burst, and a refused resume waits and runs again.

## What it records

spawn.sh prints herdr's answer (`herdr pane <id> workspace <id>`) and records the session's `kind`, a checker's `worker=<its worker's full name>`, a worker's or runner's `reportsTo=<the session it reports to>` and, for an entry with no task, a `task` as [ROSTER.md](ROSTER.md) says, in the roster,
by `set` through the checkout's `scripts/roster.ts`, which keeps a respawned session's work.
The kind comes from the mode (`worker` for a worker, `runner` for a runner, the column's role for a checker or probe) or, for a manager, from its name (through `sessions.names`, then `sessions.aliases`, or `optimizer`), else an orchestrator's roster kind; a resume reads the roster's kind for the name first and refuses a name that neither the roster's kind nor a factory name places.
Ops' sweep raises `probe-unrecorded` for a live probe the roster has not recorded after 10 minutes, and `probe-over-15m` for one live past 15 (`packages/scripts/src/ops-sweep/sweep.ts`).
It leaves out `probe-sdk` (`SDK_PROBE` in `packages/config/src/kinds.ts`), the session the Dashboard hosts on the Agent SDK, which runs as a probe for the factory's hooks while spawn.sh never starts or records it.

## Live name and permissions

spawn.sh refuses a name a live session already holds (a `claude -p` run, whose registry file reads `entrypoint` `sdk-cli`, holds none), naming that session's pid, since Claude Code would start the new one under a generated name while the roster still pointed at the old one: a respawn under the same name spawns only once the old session has closed (after a `spawn.sh restore`).
It refuses so in every mode, a manager's `manager <name>` start included, before any pane opens or any record is written, so the live session's resume record stays as it was.
It launches every session with `--dangerously-skip-permissions`, the factory's bypass mode, so it never rests on the machine's own settings (a session in another mode holds every cross-session message for approval);
the machine's `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`'s when that is set) should also set `"permissions": { "defaultMode": "bypassPermissions" }` and `"skipDangerousModePermissionPrompt": true`, so a session started any other way lands there too with no prompt to stop on, which setup's check reports as `bypass mode`.
On a Mac whose inscope exports a workspace's own `CLAUDE_CONFIG_DIR` (its `inscope.zsh` names it, or `INSCOPE_CCD` is set), it launches with `env -u CLAUDE_CONFIG_DIR -u INSCOPE_CCD`, where a session would otherwise start with no login, and reads the live sessions and the roster under `~/.claude`; elsewhere it leaves the environment as it is.

## --account

`--account <email>`, with any mode and anywhere among its words, has the session log in as that Claude account: the lead names it to pin a login (`spawn.sh resume dispatcher <dir> <session-id> --account <email>`, `spawn.sh worker <name> <brief> --title "<title>" --in <dir> --account <email>`), and a running session never switches accounts by itself.
A start script resolves the login into `$acct` first, `acct=$(bun packages/scripts/src/playground/cli.ts accounts list | grep -o "<pattern>" | head -1)`, and passes `--account "$acct"`,
so no call's input holds a full email address, which makes the privacy hook ask the owner to confirm.
`<pattern>` matches the whole address while it spells only the login's local part, such as `<local part>@[^:]*`, since `grep -o` prints only the text it matches and a domain alone can match two logins.
A worker's, reviewer's or tester's Claude start names its login by full email, never its domain alone, since one domain can match two logins: while `usage.accounts` lists a Claude row, spawn.sh refuses one with no `--account`, listing those rows in their order, a parked one with its `parkedUntil`,
since the account split below ranks logins by week left per hour and cannot follow which login takes which work.
A fresh install lists no Claude row, so its bare start stays on the machine's own login; a runner, probe, manager, resume or restore starts bare as below, a probe's `--account` being optional.
spawn.sh refuses, before it opens a pane, an email that is not a plain `local@domain`, and one with no item in the Keychain under `usage.keychainService`, checking only that the item exists; on Linux the secret store answers the same `security` calls (scripts/README.md, The secret store on Linux).
An `--account` naming the machine's own login (`oauthAccount.emailAddress` in Claude Code's `.claude.json`, under `$CLAUDE_CONFIG_DIR` else in `~`, matched in any case) starts on it as a bare start that stays there does, with no token and the account split skipped, so a lead steers a start onto the own login by naming it:
its usage is judged by that login's own reading alone (`usage.json`, or `ops/usage/stored-login.json` while `usage.json` reads the factory account), refused, naming the reading, whenever a bare start would count that login as over the gate (a `stored-login.json` missing, stale or naming another account among them, but the seat-token start above), and the resume record keeps the `--account`.
It also refuses an `--account` whose `usage.accounts` row sets `parkedUntil` to a later time, naming `parkedUntil`.
It also refuses an `--account` whose week a reading names at 100% (`usage.json`, `ops/usage/stored-login.json` or a `usage-<name>.json`, until its `resets_at`, or `usage.json`'s `accounts` map, until its `weekReset`), naming the account and its reading, and, for the map's reading, the account with the most room, in any mode, a resume included.
The launch then starts with `CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s <usage.keychainService> -a <email> -w)"` as text, so the new pane's own shell reads the token into the session's environment and it never reaches herdr's argv, spawn.sh's output, the roster or a log; a read that comes back empty stops the pane there, before claude runs, naming the save-it-again command.
A bare start the rule above passes picks among the machine's own login (the one in `.claude.json`'s `oauthAccount`, judged by `usage.json`, or by `ops/usage/stored-login.json` while `usage.json` reads the factory account, which then counts as another login), each other login with a `usage-<name>.json`, and each account login-flip probes with a reading in `login-flip.json`'s `seen`,
keeping those that pass the usage gate, a login whose `usage.accounts` row sets `parkedUntil` to a later time counting as over it.
It takes the one next in the account split: `ops/usage/login-flip.json`'s `split.shares`, each account's week left per hour to its week reset or, for an ending account, 2 hours before its end, whichever comes first, a fifth of that for an account whose row sets `own` while that deadline is over a day away, none for a parked one, read under 30 minutes old (two of the ops tick's 15-minute beats).
The pick is a smooth weighted round robin: each start adds every passing login's share to its credit in `ops/usage/split-picks.json`, takes the highest, and takes the shares' sum off it.
With no fresh split, or none of it passing, it takes the one with the lowest week.
It prints `no --account, so it starts on <email>, next in the account split (<share>% of new sessions)` (or `the login with the most room this week`) when that is another login, which then starts on it as `--account <email>` would, and `so it stays on <email>` when it is the machine's own.
A bare `resume` or `restore` picks the same way and prints the same line, so a session can come back on another login than it ran on: the resume record's exec line keeps only an `--account` you gave, while its `# account:` line names the login the session runs on, a pick included.
It refuses only when every login is over the gate, naming each one's reading, a stale one's file and age included.

## --backend glm

`--backend glm`, with any mode and anywhere among its words, runs the session on Z.ai's GLM through Claude Code, so its hooks, skills and transcript stay as they are: a lead picks it per spawn for the work **glm** gives GLM, and never for a reviewer or a tester, whose verdict gates a merge.
That work stays off the Opus paths: the factory's `no-glm-heavy-path` hook refuses a GLM session's edit of a file under them (`Edit`, `MultiEdit`, `NotebookEdit` or `Write`), and its `git commit` or `git push` that touches `web/next/`, `scripts/hooks/`, `scripts/spawn.sh`, the `pr-merge` or `verify` scripts, `lefthook.yml` or `.github/workflows/`, naming the files,
so a worker it stops reports them to its lead, who moves that change to a Claude worker.
While load5 (the third field of `sysctl -n vm.loadavg`, on Linux `/proc/loadavg`) is over 15 the hook also refuses a GLM session's install, node_modules clone, commit or push whatever the paths, so the session waits for the load to fall.
The same hook refuses a GLM session's headless `claude -p`, its calls to an org's tracker, chat, docs and repos, its shell reads of an org's checkout and its database clients aimed off this machine, every MCP tool or resource read, and a Read, Grep or Glob of an org's checkout once its matcher takes them.
Each refusal names the **glm** rule, so the session reports to its lead and the task goes to a Claude worker (`scripts/hooks/README.md`).
spawn.sh refuses `--backend glm` for a reviewer or tester, as a column or on resume, and for a session in a checkout of an org `ext.links` guards (a folder on its path, or its GitHub origin's owner) or on a brief naming a word of the `glm-refused-sources` guard list ([rules/glm.md](../../rules/glm.md)).
`tests/guarded-on-glm.test.ts` holds the repo's jobs (`scripts/ops`, `packages/scripts/src`, `api/hono/src` and `skills`) to the same line: it fails on a file that names a refused source and wires GLM, or that starts a headless `claude` on the environment it inherits; a job kept under `~/.playground/ops/`, outside the repo, is outside that scan, so the rule alone holds it.
Its key is a `usage.accounts` row of provider `glm`: the one `--account <label>` names, else the first; `playground accounts add --provider glm --label <label>` adds one.
It refuses another backend, an `--account` that labels no GLM row, `usage.accounts` with no GLM row, and a Keychain with no item for the label under `models.glmKeychainService` (default `playground-glm`), before any herdr call.
The launch starts with `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_AUTH_TOKEN="$(security find-generic-password -s <models.glmKeychainService> -a <label> -w)"` as text (an empty read stops the pane there, before claude runs, naming the save-it-again command) and every model mapped to GLM (`models.glm` with `[1m]`, `glm-5.3-flash[1m]` by default,
which carries 3x the plan's quota of glm-5.3 and keeps the 1M window the `[1m]` gives Claude Code; the small fast one `models.glm` bare), `ENABLE_TOOL_SEARCH=true`, since on a base URL that is not Anthropic's Claude Code would load every MCP tool's schema at start, past that window, and runs `--model 'glm-5.3-flash[1m]'` with `--settings ~/.playground/factory-settings-glm-400k.json`,
which spawn.sh rebuilds from the factory's settings on every GLM launch with the telemetry turned off (`CLAUDE_CODE_ENABLE_TELEMETRY=0`, `OTEL_METRICS_EXPORTER=none`), since the user settings may export usage to an org's usage collector, which counts Claude usage alone; that file's env outranks the user settings' env, and it holds every factory hook.
The session compacts in the factory's one 400k window (**context**).
A start records its harness and backend in `~/.playground/backends/<name>` once herdr has the session, as `claude-code glm`, `claude-code local`, `claude-code claude` or `codex openai` (`--backend claude` names the default; `HARNESSES` in `packages/settings/src/harnesses.ts` lists each harness with its backends), and a resume runs that backend, reading the pin by its words whatever their spacing,
and a pin of the backend alone too,
as one written before the harness split holds: it refuses `--backend` or `--harness` while a pin stands, a resume with no pin and neither given, and a pin that reads none of those.
So a running session moves to GLM only by a close and a fresh start under `--backend glm`.
The 98% switch to GLM is retired by his decision on Inbox #i827: the account rotation moves the factory between Claude accounts in its place (`scripts/ops/usage/login-flip.py`).

## --backend local

`--backend local` runs the session on this machine's local model (K) through Claude Code, on its loopback port 8000, under GLM's limits: a lead picks it for the same small, bounded build tasks **glm** gives GLM.
The `no-glm-heavy-path` hook fences it as a GLM session, its pin or its base URL on port 8000 telling it, so the fenced paths, the load line and the org fence hold alike.
spawn.sh refuses it where it refuses GLM (a reviewer or tester, an org's checkout, a brief naming a `glm-refused-sources` word) and also for a planner and a researcher, since Claude plans and researches; it refuses `--account`, `--model` and an `--ssh` probe beside it, since the model listens on this machine's loopback alone.
Before the gate it GETs `http://127.0.0.1:8000/v1/models` (`LOCAL_URL`) with a 5 s timeout and refuses when the server is silent or lists no model named `local`, the name `serve.sh` gives each model (`LOCAL_SERVED`).
Its gate (Capacity gate, gate 5) admits at most the `maxSessions` the model switch's state gives this machine's server, else 6, and only above the speed floors that server's speed reading holds; M runs on the other machine, so no M swap holds a local start.
The model's chat template reads no effort, so each `--effort` sets Claude Code's thinking instead: `low` turns it off (`CLAUDE_CODE_EXTRA_BODY='{"thinking":{"type":"disabled"}}'`), `medium` caps it at 8192 tokens (`MAX_THINKING_TOKENS=8192` with `CLAUDE_CODE_MODEL_CAPABILITIES=local=-adaptive_thinking`), and `high`, `xhigh` and `max` leave it uncapped.
Off Anthropic's API Claude Code sends no `thinking` field at `MAX_THINKING_TOKENS=0` and adaptive thinking whatever the cap says, and the server thinks without a field, so low names `disabled` in the body itself; `bun packages/scripts/src/local-thinking-check.ts` prints what each level sends to a loopback stub.
The launch starts with a no-op label naming both, such as `: effort low, thinking off;`, then those variables, then `ANTHROPIC_BASE_URL=http://127.0.0.1:8000`, `ANTHROPIC_AUTH_TOKEN=local` (a placeholder: no Keychain read), every model mapped to `local`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `ENABLE_TOOL_SEARCH=true`,
and runs `--model local --effort <effort>` with `--settings ~/.playground/factory-settings-local-120k.json`, GLM's file with the telemetry off, in a 120k window.
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` declares the server's own window, since Claude Code assumes 1M for a model name it does not know and so never compacted before the server refused: the `local` card's `max_model_len` from that GET, less 8192 for the reply, which shares the window; a card with no number above 16384 takes 120000.
The 120k compact window is capped at the declared one, so a session on a smaller server compacts inside it.
A start records `claude-code local`, which a resume runs on.
A `--backend local` session always starts and resumes at `--effort high`, so its thinking stays uncapped, per the model rule (`scripts/briefs/brief-rush.md`), and a resume passes `--effort high` explicitly rather than the effort its record carries.

## --runtime herdr and restore

`--runtime herdr`, with any mode but restore, close or read and anywhere among its words, opens the session in herdr, as every start does without it, on the playground server `bun run ops:herdr start` (or `dispatcher`) keeps up, by the binary its pin names; spawn.sh never starts or stops a server, and refuses while it is down.
A column's anchor is then a herdr pane id (`w1:p2`, or lettered as `wN:p1A`; your own is `$HERDR_PANE_ID`), and a name holds at most 32 characters.
A probe on a server with no pane to split beside opens in a workspace of its own, in this checkout: `spawn.sh probe <name> <reports-to> <brief>`, with no `--runtime` or with `--runtime herdr`.
It opens on the playground server; `PLAYGROUND_HERDR_SESSION=playground-probes` before the command puts it on the probes server.
When herdr refuses a placement, spawn.sh quotes herdr's own error in its refusal.
It labels the session's pane with its name, and that label is where the session is found, so the session's roster entry records no `workspace` or `surface`.
The Dashboard lists it by name, for any session to read; `herdr pane list` shows the labels only when run in a pane on the playground server, since from a pane on another server herdr's reads reach that server's socket.
It waits for Claude's REPL with `pane wait-output`, and answers the folder trust and MCP picker for you (the picker by enabling its servers, when `~/.mcp.json` alone defines them) only under the code root (`paths.codeRoot`, else the folder that holds the main checkout) and `~/<org>` for each org `ext.links` guards;
anywhere else the session waits at the prompt for the owner, and spawn.sh says so.
In the main checkout and its worktrees it answers no folder trust prompt: it refuses a Claude start there until Claude Code's config holds the owner's yes for the checkout, which install.sh records for the checkout it cloned and first run's **Trust this folder** on Claude Code's card records.
An `--ssh` probe skips that check, since its claude runs on the other machine and reads that machine's config.
Every start and resume records its runtime, herdr, in `~/.playground/runtimes/<name>`, rewriting whatever word an older pin held.
With no `--runtime`, every start and resume opens in herdr, from any terminal, and spawn.sh refuses a `--runtime` other than herdr and a column anchored on anything but a herdr pane id.
After a herdr server's restart, which brings each pane back as a shell under its label, ops-herdr runs `spawn.sh restore` for that server (LIFECYCLE.md, Ops jobs), which resumes every session whose resume record in `~/.playground/resume` names it on that server (its `# server:` line, the factory's when it has none) and whose roster row is not done, ended, parked or paused,
each row read again once its resume finds the session gone and just before its launch, so a session `spawn.sh close` ends while a run goes on stays down,
each through `spawn.sh resume` and its gate with the `--account` its start was given, the `--model` it started with, an `--effort` other than high and, for a reviewer or tester, `--pr` with the PRs its roster row serves, else the `--pr` its record names,
in the pane holding its label, printing one line a record: `restored <name>`, `skipped <name>: <reason>` (`live`, the roster row's down status, a record that does not read, an exec line that does not parse or that it does not run, or a probe's record carrying `--ssh` or `--remote-control`, which restore leaves down),
`waiting <name>: <reason>` (a gate holding it over a reading that falls, or focus standing for another session) or `not restored <name>: <reason>` (any other refusal, a gate that cannot read its input or reads a bad setting included).
The first dispatcher's record runs first, past every gate, so the owner's dispatcher is back before any other resume takes the gate's room, then every other manager's, so the managers are back before the workers, then the rest.
A skip line takes `kind_of_name` alone and a run line takes `kind_of`, since a full `kind_of` on every skip line (608 on the live log) adds about 20 s.
A restore whose only misses wait exits 0, since ops-herdr runs it again each cycle while a session waits; a `not restored` line exits 1.
It is safe to run again, one at a time:
while another restore holds `resume/.restore.lock` it prints `a restore is already running (pid <n>), so this one stops; nothing is wrong` and exits 1.
A readable record on another server gets no line, since that server's own restore reads it.
A session that never took its first turn has no transcript, so its resume starts it afresh under its name, with the prompt its start recorded in `resume/<name>.prompt`: a Claude Code session under its own id, a Codex one under the new thread its beat names.
Done when each line reads `restored`, `waiting`, `skipped <name>: live` or a roster row's down status, or you have acted on it (a gate that cannot read its input or reads a bad setting: fix it and run it again; a broken record or a missing backend pin: resume the session by hand).

## --check

`--check`, with any mode but restore, close or read, runs every gate but the live-name one and starts or closes nothing.

## Role and settings

`<role>` is the session's kind: `dispatcher` (both dispatchers), `lead` (the builder, ops, the planner and `optimizer`), `worker`, `reviewer`, `tester`, `runner` or `probe`.
It turns on the factory's guards, such as the `no-linear-ticket` hook (**tickets**); a session the owner opens himself has no role, so they leave it alone.
`--settings` adds the factory's own hooks, such as the `no-playground-leak` hook (**classified**), on top of the owner's settings, wherever the session works;
spawn.sh reads that file as `scripts/factory-settings.json` by its real path in its own checkout, so `~/.playground/factory-settings.json`, the link `scripts/link-skills.sh` makes for other readers, decides nothing a session can repoint; its hooks find the main checkout through `PLAYGROUND_REPO`, which spawn.sh exports to every session it starts, so they run wherever the session works.
A session gets exactly one `--settings`, since Claude Code keeps only the last one given, and anything extra is merged into that file, as a GLM launch merges its telemetry off.
Every launch merges its compact window (**context**): spawn.sh rebuilds that file on each launch into `factory-settings-400k.json` for a worker, a runner or a checker, `factory-settings-glm-400k.json` on GLM and `factory-settings-local-120k.json` on the local model, in its own smaller window, so a resume keeps the same window.
A dispatcher or a lead takes `factory-settings-manager-400k.json` (`factory-settings-glm-manager-400k.json` on GLM, `factory-settings-local-manager-120k.json` on the local model), the same file plus a deny of the Agent and Workflow tools, which its memory-trial file carries too (**workers**, scripts/README.md).
A probe takes `factory-settings-sandbox-400k.json` (`factory-settings-glm-sandbox-400k.json` on GLM, `factory-settings-local-sandbox-120k.json` on the local model), the same file plus Claude Code's sandbox around its shell commands (scripts/README.md, spawn.sh); an `--ssh` probe's is one of its own ([--remote-control and --ssh](#--remote-control-and---ssh)).
On Linux that sandbox needs `bwrap` and `socat` on PATH and a `bwrap` that opens a network namespace, which Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1` refuses without an AppArmor profile for `bwrap`, and its settings' `failIfUnavailable` exits claude in its pane without them,
so before the pane opens, a probe's or a `--sandbox` start (a resume of a row recording it too, and `--check`) runs `bwrap --ro-bind / / --unshare-net true` and refuses, naming each missing piece and quoting bwrap's first error line, and installs nothing.
herdr's own resume is off (`resume_agents_on_restore = false` in ops-herdr's `config.toml`), since it would bring a session back without `--settings` or the role, as a bare `claude --resume` by hand does.
A session resumed that way gets its hooks from its folder alone: Claude Code loads `.claude/settings.json` from the session's own folder, and in a checkout whose settings carry the same hooks they load from there and read the role from the session's name, but anywhere else (a work-org checkout, an older checkout, a subfolder) nothing does,
so a factory session resumed without its settings where its own folder's `.claude/settings.json` lacks them is respawned from its handoff through spawn.sh, never left running as resumed.
Every Ops sweep runs `python3 -I <main checkout>/scripts/ops/up.py --sessions`, which names each one (and none once each is respawned), and sends each to the one it reports to (a checker's or probe's spawner; the dispatcher's goes to Ops), which respawns it, since a live session keeps its name:
the session writes a handoff ([Write a handoff](SESSIONS.md#write-a-handoff), `~/.playground/handoffs/<name>.md`), its pane closes ([End](SESSIONS.md#end)), and a spawn under the same name ([Spawn](SESSIONS.md#spawn)) briefs the respawned session with the handoff, which the respawned-session row of ROSTER.md records.
A resume's `<dir>` is a folder Claude Code already trusts (the Playground checkout or a worktree under it), never a scratchpad or /tmp path.
In a folder it has never trusted, the session stops on the folder-trust dialog, which no session may approve, and `ListAgents` never lists it.
A resumed session, a checker included, runs in the worktree or clone it ran in: spawn.sh resume refuses to move a session into the main checkout unless it started there, and refuses a removed folder, naming its branch and, for a the dispatcher worktree, the `git worktree add` line that brings it back.

## --sandbox

`--sandbox`, with a worker's or probe's start or a reviewer's or probe's column, starts the session in the closed sandbox, a file of its own, `factory-settings-sandbox-closed-400k-<name>.json` (`factory-settings-glm-sandbox-closed-400k-<name>.json` on GLM), since its allow list names the session.
That is a probe's sandbox that also closes loopback, Keychain reads (on Linux, Claude Code's login file), and reads and writes of the data folder's secret files to its shell commands, holds outbound hosts to GitHub's and the npm registry, and commits unsigned (scripts/README.md, spawn.sh).
A session works in the worktree it starts in, since Claude Code's own sandbox rule (2.1.323) reads "The repository's `.git/worktrees` is read-only in the sandbox, apart from this session's own worktrees", so `git worktree add` inside it fails and no allow in the settings file opens it.
So a fresh worker or reviewer start with no `--in` runs in a detached worktree spawn.sh makes before launch, outside the sandbox, at the commit it works from, fetched from origin: a reviewer of the checkout's own PR in `.claude/worktrees/review-<n>` at the PR's head, the clone code-review-loop reuses, and any other in `.claude/worktrees/<name>` at origin's `canary`;
while GitHub has not made the PR's pull ref yet, the reviewer's starts at the PR's branch, refused unless that branch sits at the head GitHub names;
a probe starts where it does today.
Claude Code's sandbox also keeps the session's own `.claude/` read-only, and with it `skills/zerostarter/`, which `.claude/skills` links to (measured in a closed review): a checkout or merge that changes a file there fails on `unable to unlink old '<path>': Operation not permitted` and leaves it stale, and a later checkout over it aborts on local changes.
So the worktree starts at the commit its session works from, and `--sandbox` fits a start whose PR touches neither folder and merges no `canary` that does.
In it a worker makes its branch with `git fetch origin canary`, then `git switch -c <branch> --no-track origin/canary`, since a branch that tracks `origin/canary` writes the shut `.git/config`, and a reviewer takes the PR's head as code-review-loop's step 1 does, with `git fetch origin <branch>` and `git checkout --detach <head>`, since a new PR's pull ref can be missing for a while.
It writes that worktree, its `.git/worktrees` entry, and the main checkout's `.git/FETCH_HEAD`, `objects`, `refs` and `logs`; every other session's worktree, the `canary`, `main` and `live.branch` (the live dashboard's, `live/dashboard` by default) refs and their logs, `packed-refs`, `config`, `hooks`, `HEAD`, `index` and the rest of the checkout stay shut.
It pushes with `git push origin HEAD:<branch>`, since `-u` writes the shut `.git/config`.
It fits a worker with no stack: inside it nothing listens on loopback or reaches a stack, so a tester, which drives one, stays off it, and spawn.sh refuses it for every other role and mode.
On Linux it needs what a probe's sandbox needs, `bwrap`, `socat` and the AppArmor profile for `bwrap`, which spawn.sh checks before the pane opens ([Role and settings](#role-and-settings)).
Its roster row records `sandbox=on`, which a resume and `spawn.sh restore` keep, and a start without the flag under the same name clears.
A start from inside it leaves the `--account` and GLM key check to the new pane's shell, which runs outside the sandbox and stops on a missing item before claude runs.

## --remote-control and --ssh

Both take a probe's own start alone, `spawn.sh probe <name> <reports-to> <brief>`, anywhere among its words; spawn.sh refuses each in every other mode, a probe's column and a resume included, naming the flag and the mode, since a session that does real work stays where its gate, guards and restore read it.

- `--remote-control <name>` starts the probe's claude with Claude Code's `--remote-control <name>`, "Start an interactive session with Remote Control enabled (optionally named)" (`claude --help`, 2.1.325); the name is lowercase words joined by hyphens.
  Remote Control forms no link for a start on a token (`CLAUDE_CODE_OAUTH_TOKEN`), measured on 16 Nov 2026: its session record's `bridgeSessionId` stays null, while a start on this machine's claude.ai sign-in forms one within 7 s.
  So spawn.sh warns, and starts it anyway, when the flag meets an `--account` start, or an `--ssh` one whose machine holds no `~/.claude/.credentials.json`, which the sandbox read checks by its presence alone.
- `--ssh <user@host> --key <file>` runs the probe's claude on that machine, each flag needing the other.
  Before any gate or pane, spawn.sh refuses a host that is not a plain `user@host` (so none reads as an ssh option) and a key that is not an absolute path to a readable file.
  The pane opens here, on this machine's herdr, and its launch runs two ssh calls, each `ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes`, so a key that fails or an unknown host key stops it rather than prompting:
  the first pipes a tar of the launch's settings file, skill plugin and brief into a new folder there, the probe's temp folder (on Linux this machine's own one's name, else a new name under `/tmp`), which `mkdir -m 700` refuses to reuse;
  the second, `ssh -tt`, runs the launch there, `--settings` and `--plugin-dir` pointing into that folder, in the same checkout path, so that machine holds the checkout, claude and the secret store at this one's paths.
  The remote command also puts that machine's own `$HOME/.bun/bin` on PATH, expanded by its shell, since ssh hands a command the system PATH alone: bun and the `security` link to the secret store, both in `~/.bun/bin`, are found there with no shell-file line.
  The prompt names the brief's copy there, `<folder>/<brief's file name>`, since this machine's data folder is not on that one.
  Its settings file is one of its own, `factory-settings-sandbox-400k-<name>.json` (`-closed-` with `--sandbox`), whose sandbox writes that folder, its TMPDIR there.
  With `--account`, the other machine's own shell reads the token from its own store, as [--account](#--account)'s launch does here, so no token crosses from this machine.
  Its prompt's report line names `playground send <reports-to> <text>` and a background `playground alerts-wait <name>` in place of SendMessage, which reaches no other machine ([SESSIONS.md](SESSIONS.md#message-a-session)); a probe started here keeps SendMessage.
- The probe keeps a probe's roster row, kind `probe`, written here.
  Its load and memory gates read that machine ([Capacity gate](#capacity-gate)), and the other gates read this one, where its roster row and usage live.
  Before the pane opens, one more `ssh` with the same options reads that machine under the launch's PATH, its `~/.bun/bin` first:
  it refuses when `~/.claude.json` there lacks `"hasCompletedOnboarding": true`, since claude would wait on its first-run screens, and on what that machine's sandbox lacks, as a probe's own check here reads it ([Role and settings](#role-and-settings)), or with ssh's own words when the call fails.
  `spawn.sh close <name>` closes the pane, and the hangup ends the remote claude.
  Its resume record carries the flags, so `spawn.sh restore` leaves it down, naming why, and `spawn.sh resume` refuses it while that record stands, since a resume would run it here without them; start it again instead.
  The live-name check reads this machine's sessions alone, so it misses a name live on the other one.
  Ops' sweep counts it live while any pane labelled with its name, on its resume record's server, still runs `ssh` (`sshLive` in `packages/scripts/src/ops-sweep/sweep.ts`): past 15 minutes it raises `probe-over-15m`, and once no such pane runs `ssh`, `probe-gone-unended`.
  The Dashboard's live list counts it live by the same rule (`packages/config/src/ssh-probe.ts`), as a remote row with no transcript, which it neither types into nor restarts.
