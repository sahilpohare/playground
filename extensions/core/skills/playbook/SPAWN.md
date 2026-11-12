# Spawn

What [SESSIONS.md](SESSIONS.md#spawn)'s step 2 runs: each mode's command, then the gates, flags and launch spawn.sh applies to a start.
Read the section for the mode you start and for each flag you pass, and the section of a refusal's gate before you act on it.

## Modes

- **A worker** opens its own workspace, named after it, in the Playground checkout, or in the folder `--in <dir>` names under the code root or the folder of an org `ext.links` guards, reporting to the builder, or to the session `--reports-to <session>` names when its brief reports elsewhere; **a runner** the same, reporting to ops, with no `--reports-to`.
  spawn.sh names each with `roster.ts who builder` and `who ops` ([ROSTER.md](ROSTER.md)), each seat's live holder, else its `sessions.names` name, so a manager respawned under a new name takes its new workers at once:

  ```bash
  "${PLAYGROUND_REPO:?}/scripts/spawn.sh" worker <name> <brief> --title "<title>" [--reports-to <session>]
  "${PLAYGROUND_REPO:?}/scripts/spawn.sh" runner <name> <brief>
  ```

- **A checker or probe** opens as a column in its spawner's herdr workspace, to the right of the newest member's pane (the worker for its reviewer, the reviewer for its tester), run from its spawner's session, which it reports to:

  ```bash
  "${PLAYGROUND_REPO:?}/scripts/spawn.sh" column <reviewer|tester|probe> <name> <reports-to> <the newest member's herdr pane id> <brief>
  ```

  A reviewer or tester adds `--pr <pull url>`, the pull request it serves, or `--pr <scope>/<kind>/<key>`, the extension item it scores, so open the PR as a draft before its checkers ([scripts/README.md](../../../../scripts/README.md#spawnsh) holds the refusal and the row it writes).

- **A manager** opens the same way as a column in the `Managers` workspace, to the right of the newest manager, named once: `column <name> <pane> <brief>`.
  A name whose roster kind, else its name (an `<id>-<kind>`, a `sessions.names` name or a `sessions.aliases` one), is builder, ops or planner opens as a lead reporting to the first dispatcher (a new name gets its kind first, `scripts/roster.ts set <name> kind=builder task=<what it does>`, which writes a `starting` entry that `managerOf` keeps behind the live one until it answers);
  the first dispatcher (its `sessions.names` name, an alias of it, or an `<id>-dispatcher`) opens briefed by the session running spawn.sh, its prompt reporting to no one, and from outside a session (no `CLAUDE_PID`) takes the long form `column dispatcher <name> <the lead that briefs it> <pane> <brief>`.
  The first dispatcher (`sessions.names`' dispatcher, which `playground dispatcher` starts, working with the owner and reporting to no session), the second dispatcher (Inbox #i520), a dispatcher's name with `-2` or an `<id>-dispatcher` it records as `slot=2`, the optimizer (which `playground optimizer` starts), and the Planner,
  the Builder and Ops (which `playground planner`, `playground builder` and `playground ops` start the first time the dispatcher routes work to each) open instead in a workspace of their own, named after each,
  in the main checkout's `.claude/worktrees/leads` (`manager <name> <brief>`, the optimizer by its name or its roster kind, a new name given `kind=optimizer` first the same way;
  an orchestrator of any other manager kind in `kinds.ts`, such as the Assistant or the seatless `orchestrator` kind the sidebar's plus starts, any number at once, opens there too, as a lead reporting to the session its row names, once `scripts/roster.ts set <name> kind=<kind> reportsTo=<session> task=<what it does>` has given it both, and spawn.sh refuses it naming that line until it has;
  spawn.sh refuses the second dispatcher on Claude without `--account <email>`, a second account, so it never shares the first's login, and a resume of it whose pin names claude needs `--account` again, since nothing records the account).

## Capacity gate

spawn.sh holds the machine's room in code (the room is the cores in use, not a count of slots), through a capacity gate that refuses, failing closed, unless four checks pass in order, the first failure naming its gate and its reading,
and counts no live sessions or workers (no cap; Ops watches the live board for the risk of a terminal that stops answering, as cmux did at 49 live sessions and load5 97):
the higher of load1 and load5 (the third field of `sysctl -n vm.loadavg`), plus the starts of the last 5 minutes (`gates.startsWindow`), its own and each `slots.peers` folder's, each weighing half its item's load units, under the core count (`sysctl hw.ncpu`) times `PLAYGROUND_LOAD_MULT` (default 1.0),
less a quarter (`gates.smallReserve`) kept for small items unless the start is small (`--size small|medium|big`, else small for a reviewer or tester, else the roster's or plan.json's size, else medium; [rules/slots.md](../../rules/slots.md)), while a small worker keeps an eighth (`gates.reviewReserve`) in its place for the checkers,
refusing at or over that line whatever the CPU's idle share, since the owner's rule keeps the load under the cores, and the refusal names the load, the starts and the line;
a `--priority` start passes it while `priority.json`, an org's own `priority-<name>.json`, a job's own `priority-start.json` or a session's own window (`playground priority on`, [scripts/README.md](../../../../scripts/README.md#spawnsh)) stands in the data folder, since priority work comes first, as it passes focus on any of them,
and so does a resume within 15 minutes of `spawn.sh close` ending a row that read live, since that session already counts in the load it comes back into;
memory pressure level 1 or 2 with 8% or more free (`gates.memoryFreeMin`),
and for a fresh worker start alone swap-ins under 100/s (`gates.glmSwapinsMax`, `vm_stat -c 2 1`'s last second), refusing when vm_stat gives no reading, since free memory counts compressible pages and read 62% on 7 Nov while 150 pages swapped in a second; every other start keeps its pass, as at the slots gate;
for a fresh worker start alone, a run-slot lane free with the load units for a run, or an empty queue (`scripts/ops/run-slot.sh room`), so a new worker never joins a queue it has no room in, while checkers, resumes and moves skip it,
and a `--priority` start passes a full queue with a priority file standing, as at the load gate; and the launching backend's usage:
Claude's from `usage.json` (written in the last 15 minutes, the 5-hour window under 90%, the week within its pace, or under 98%, a sanity backup, while `~/.playground/usage-pace-off-until` holds a future ISO 8601 time with its zone,
which ops-sweep writes and renews while an account the split can pick projects under 100% at its week reset (`scripts/ops/README.md`'s Usage forecasts), or a person writes by hand, and the pass line names, a missing, empty, past or unreadable time leaving the pace on;
a `usage.json` never written, as on a fresh install before the ops-usage job first runs, passes every start, its pass line reading `unread (usage.json not yet written)`, while one that exists still has to read, be fresh and be under its limits;
each other login's `usage-<name>.json`, and each account login-flip probes by its reading in `login-flip.json`'s `seen`, takes the same checks, its reading valid for 60 minutes, a missing 5-hour window reading as no 5-hour limit;
`--account` naming another login skips it, since that login's usage is not this machine's, but refuses a week a reading names at 100% until its `resets_at`, or one `usage.json`'s `accounts` map names until its `weekReset`)
or GLM's from `zai-usage.json` (the 5-hour window under 95% of its credits and no empty `balance`, with no week check (full use, judged on the 5-hour window), only while the ops-zai-usage job's last beat is ok and within 3 cycles,
so every GLM spawn refuses until `bun run ops:zai-usage` has beaten once).
A GLM start takes its own load and memory gate in place of the load and memory checks above: load5 (the third field of `sysctl -n vm.loadavg`) under 30 (`gates.glmLoad5Max`), memory pressure level 1, and swap-ins under 100/s (`gates.glmSwapinsMax`, `vm_stat -c 2 1`), so GLM starts while Claude's gate holds.
Every pass and refusal is one line in `~/.playground/ops/capacity.jsonl` naming its session, which the load check counts its starts from, a refusal's carrying the words it printed as `detail`.
Every manager start takes the gate, an orchestrator's included, but the first dispatcher's, by `manager` or by `resume`, which starts past a failing gate so the owner always has one: the gates after a failing one still read and pick its login, and its one row reads `skipped`, naming each gate it went past with a refusal's words, and counts as a start.
`bun run verify system` reads how many more workers and how many more orchestrators fit now, and what limits each.
It also refuses while a live session already holds the name (below).
A refusal names its gate and what it read: close a session that is done ([End](SESSIONS.md#end)), or wait for the reading to fall, and run it again.
Its one bypass is the first dispatcher's (above); past the gate otherwise only the owner starts a session, from his own terminal, whose sessions load no factory hook, or a PR changes the gate.

## Layout

A session that works with others opens as a full-height column to the right of the newest one in their workspace, never wrapped into a grid (side by side gives the most room, so nothing wraps): a worker's workspace reads worker | reviewer | tester, and the managers' reads `dispatcher` | `planner` | `builder` | `ops`.
A session already running stays where it is until its next restart.

## Launch, model and effort

spawn.sh starts each as `env PLAYGROUND_ROLE=<role> claude -n <name> --model claude-opus-5-5 --effort high --settings $HOME/.playground/factory-settings-400k.json --dangerously-skip-permissions` (a probe's file is `factory-settings-sandbox-400k.json`, a dispatcher's or a lead's `factory-settings-manager-400k.json`):
every session starts at high effort, and another effort comes with spawn.sh's `--effort` at a start or a resume, by whoever playbook's chain names ([SKILL.md](SKILL.md#chain)) and brief-rush's model rule;
every session runs on `models.default` (Opus) unless it starts with `--model` naming another of `models.claude` (Fable, Sonnet or Haiku by default; spawn.sh refuses any other id, `--model` beside `--backend glm`, and any but `models.checker` (Opus) for a reviewer or tester, whose verdict gates a merge, and records none of them,
so a resume takes `--model` afresh and one without it runs on Opus) or with `--backend glm` (below) (Opus at extra-high effort for research and everything else, never Sonnet), and every subagent a session starts runs on Sonnet unless it names a model,
from the factory settings' `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (the owner approved #i492, 17 Oct; on GLM the alias maps to GLM), so a brief or subagent call that needs Opus names `model: opus`; a scheduled ops job that calls a model keeps its own.
A resume of a dispatcher, the Assistant or the hosted session keeps neither a model nor an effort the owner picked in its Dashboard composer ([SKILL.md](SKILL.md#chain)).
Its first prompt names the session, its role and who it reports to, and has it load this skill and read `<brief>`, a file under `~/.playground`, which spawn.sh refuses to start without (a Claude worker's adds that `brief-rush.md` binds it on its Claude lane, within the lanes its own header scopes, while that file exists; a GLM worker's leaves it out).

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
After a resume, restart any dev stack you served, then re-arm your watches: run CronList before CronCreate, since a resume keeps the session's crons and drops only its background tasks.
Done when the restarted stack answers its `/api/health` and each watch is armed once.
Before a close that a resume follows (an account move), wait until the session has no run-slot run in flight, since the close kills that run.
Before an account move, its dispatcher tells every session that serves a dev stack, so what it serves does not go down unannounced.
A resume within 15 minutes of its close passes spawn.sh's load gate (the capacity gate, above); later resumes go about 2 minutes apart, since the gate counts recent starts and refuses a burst, and a refused resume waits and runs again.

## What it records

spawn.sh prints herdr's answer (`herdr pane <id> workspace <id>`) and records the session's `kind`, a checker's `worker=<its worker's full name>`, a worker's or runner's `reportsTo=<the session it reports to>` and, for an entry with no task, a `task` as [ROSTER.md](ROSTER.md) says, in the roster,
by `set` through the checkout's `scripts/roster.ts`, which keeps a respawned session's work.
The kind comes from the mode (`worker` for a worker, `runner` for a runner, the column's role for a checker or probe) or, for a manager, from its name (through `sessions.names`, then `sessions.aliases`, or `optimizer`), else an orchestrator's roster kind; a resume reads the roster's kind for the name first and refuses a name that neither the roster's kind nor a factory name places.

## Live name and permissions

spawn.sh refuses a name a live session already holds (a `claude -p` run, whose registry file reads `entrypoint` `sdk-cli`, holds none), naming that session's pid, since Claude Code would start the new one under a generated name while the roster still pointed at the old one: a respawn under the same name spawns only once the old session has closed (after a `spawn.sh restore`).
It launches every session with `--dangerously-skip-permissions`, the factory's bypass mode, so it never rests on the machine's own settings (a session in another mode holds every cross-session message for approval);
the machine's `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`'s when that is set) should also set `"permissions": { "defaultMode": "bypassPermissions" }` and `"skipDangerousModePermissionPrompt": true`, so a session started any other way lands there too with no prompt to stop on, which setup's check reports as `bypass mode`.
On a Mac whose inscope exports a workspace's own `CLAUDE_CONFIG_DIR` (its `inscope.zsh` names it, or `INSCOPE_CCD` is set), it launches with `env -u CLAUDE_CONFIG_DIR -u INSCOPE_CCD`, where a session would otherwise start with no login, and reads the live sessions and the roster under `~/.claude`; elsewhere it leaves the environment as it is.

## --account

`--account <email>`, with any mode and anywhere among its words, has the session log in as that Claude account: the lead names it to pin a login (`spawn.sh resume dispatcher <dir> <session-id> --account <email>`, `spawn.sh worker <name> <brief> --title "<title>" --in <dir> --account <email>`), and a running session never switches accounts by itself.
spawn.sh refuses, before it opens a pane, an email that is not a plain `local@domain`, and one with no item in the Keychain under `usage.keychainService`, checking only that the item exists.
An `--account` naming the machine's own login (`oauthAccount.emailAddress` in Claude Code's `.claude.json`, under `$CLAUDE_CONFIG_DIR` else in `~`, matched in any case) starts on it as a bare start that stays there does, with no token and the account split skipped, so a lead steers a start onto the own login by naming it:
its usage is judged by that login's own reading alone (`usage.json`, or `ops/usage/stored-login.json` while `usage.json` reads the factory account), refused, naming the reading, whenever a bare start would count that login as over the gate (a `stored-login.json` missing, stale or naming another account among them), and the resume record keeps the `--account`.
It also refuses an `--account` whose `usage.accounts` row sets `parkedUntil` to a later time, naming `parkedUntil`.
It also refuses an `--account` whose week a reading names at 100% (`usage.json`, `ops/usage/stored-login.json` or a `usage-<name>.json`, until its `resets_at`, or `usage.json`'s `accounts` map, until its `weekReset`), naming the account and its reading, and, for the map's reading, the account with the most room, in any mode, a resume included.
The launch then starts with `CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s <usage.keychainService> -a <email> -w)"` as text, so the new pane's own shell reads the token into the session's environment and it never reaches herdr's argv, spawn.sh's output, the roster or a log; a read that comes back empty stops the pane there, before claude runs, naming the save-it-again command.
With no `--account`, spawn.sh picks among the machine's own login (the one in `.claude.json`'s `oauthAccount`, judged by `usage.json`, or by `ops/usage/stored-login.json` while `usage.json` reads the factory account, which then counts as another login), each other login with a `usage-<name>.json`, and each account login-flip probes with a reading in `login-flip.json`'s `seen`,
keeping those that pass the usage gate, a login whose `usage.accounts` row sets `parkedUntil` to a later time counting as over it.
It takes the one next in the account split: `ops/usage/login-flip.json`'s `split.shares`, each account's week left per hour to its week reset or, for an ending account, 2 hours before its end, whichever comes first, a fifth of that for an account whose row sets `own` while that deadline is over a day away, none for a parked one, read under 30 minutes old (two of the ops tick's 15-minute beats).
The pick is a smooth weighted round robin: each start adds every passing login's share to its credit in `ops/usage/split-picks.json`, takes the highest, and takes the shares' sum off it.
With no fresh split, or none of it passing, it takes the one with the lowest week.
It prints `no --account, so it starts on <email>, next in the account split (<share>% of new sessions)` (or `the login with the most room this week`) when that is another login, which then starts on it as `--account <email>` would, and `so it stays on <email>` when it is the machine's own.
A bare `resume` or `restore` picks the same way and prints the same line, so a session can come back on another login than it ran on: the resume record's exec line keeps only an `--account` you gave, while its `# account:` line names the login the session runs on, a pick included.
It refuses only when every login is over the gate, naming each one's reading, a stale one's file and age included.

## --backend glm

`--backend glm`, with any mode and anywhere among its words, runs the session on Z.ai's GLM through Claude Code, so its hooks, skills and transcript stay as they are: a lead picks it per spawn for the work **glm** gives GLM, and never for a reviewer or a tester, whose verdict gates a merge.
That work stays off the Opus paths: the factory's `no-glm-heavy-path` hook refuses a GLM session's `git commit` or `git push` that touches `web/next/`, `scripts/hooks/`, `scripts/spawn.sh`, the `pr-merge` or `verify` scripts, `lefthook.yml` or `.github/workflows/`, naming the files, so a worker it stops reports them to its lead, who moves that change to a Claude worker.
While load5 (the third field of `sysctl -n vm.loadavg`) is over 15 the hook also refuses a GLM session's install, node_modules clone, commit or push whatever the paths, so the session waits for the load to fall.
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
A start records its harness and backend in `~/.playground/backends/<name>` once herdr has the session, as `claude-code glm`, `claude-code claude` or `codex openai` (`--backend claude` names the default; `HARNESSES` in `packages/settings/src/harnesses.ts` lists each harness with its backends), and a resume runs that backend, reading the pin by its words whatever their spacing,
and a pin of the backend alone too,
as one written before the harness split holds: it refuses `--backend` or `--harness` while a pin stands, a resume with no pin and neither given, and a pin that reads none of those.
So a running session moves to GLM only by a close and a fresh start under `--backend glm`.
The 98% switch to GLM is retired by his decision on Inbox #i827: the account rotation moves the factory between Claude accounts in its place (`scripts/ops/usage/login-flip.py`).

## --runtime herdr and restore

`--runtime herdr`, with any mode but restore or close and anywhere among its words, opens the session in herdr, as every start does without it, on the playground server `bun run ops:herdr start` (or `dispatcher`) keeps up, by the binary its pin names; spawn.sh never starts or stops a server, and refuses while it is down.
A column's anchor is then a herdr pane id (`w1:p2`, or lettered as `wN:p1A`; your own is `$HERDR_PANE_ID`), and a name holds at most 32 characters.
A probe on a server with no pane to split beside opens in a workspace of its own, in this checkout: `spawn.sh probe <name> <reports-to> <brief>`, with no `--runtime` or with `--runtime herdr`.
It opens on the playground server; `PLAYGROUND_HERDR_SESSION=playground-probes` before the command puts it on the probes server.
When herdr refuses a placement, spawn.sh quotes herdr's own error in its refusal.
It labels the session's pane with its name, and that label is where the session is found, so the session's roster entry records no `workspace` or `surface`.
The Dashboard lists it by name, for any session to read; `herdr pane list` shows the labels only when run in a pane on the playground server, since from a pane on another server herdr's reads reach that server's socket.
It waits for Claude's REPL with `pane wait-output`, and answers the folder trust and MCP picker for you (the picker by enabling its servers, when `~/.mcp.json` alone defines them) only under the code root (`paths.codeRoot`, else the folder that holds the main checkout) and `~/<org>` for each org `ext.links` guards;
anywhere else the session waits at the prompt for the owner, and spawn.sh says so.
Every start and resume records its runtime, herdr, in `~/.playground/runtimes/<name>`, rewriting whatever word an older pin held.
With no `--runtime`, every start and resume opens in herdr, from any terminal, and spawn.sh refuses a `--runtime` other than herdr and a column anchored on anything but a herdr pane id.
After a herdr server's restart, which brings each pane back as a shell under its label, ops-herdr runs `spawn.sh restore` for that server (LIFECYCLE.md, Ops jobs), which resumes every session whose resume record in `~/.playground/resume` names it on that server (its `# server:` line, the factory's when it has none) and whose roster row is not done, ended, parked or paused,
each row read again once its resume finds the session gone and just before its launch, so a session `spawn.sh close` ends while a run goes on stays down,
each through `spawn.sh resume` and its gate with the `--account` its start was given, the `--model` it started with, an `--effort` other than high and, for a reviewer or tester, `--pr` with the PRs its roster row serves,
in the pane holding its label, printing one line a record: `restored <name>`, `skipped <name>: <reason>` (`live`, the roster row's down status, a record that does not read, or an exec line that does not parse or that it does not run),
`waiting <name>: <reason>` (a gate holding it over a reading that falls, or focus standing for another session) or `not restored <name>: <reason>` (any other refusal, a gate that cannot read its input or reads a bad setting included).
The first dispatcher's record runs first, past every gate, so the owner's dispatcher is back before any other resume takes the gate's room.
A restore whose only misses wait exits 0, since ops-herdr runs it again each cycle while a session waits; a `not restored` line exits 1.
It is safe to run again, one at a time:
while another restore holds `resume/.restore.lock` it prints `another restore is running (pid <n>)` and exits 1.
A readable record on another server gets no line, since that server's own restore reads it.
A session that never took its first turn has no transcript, so its resume starts it afresh under its name, with the prompt its start recorded in `resume/<name>.prompt`: a Claude Code session under its own id, a Codex one under the new thread its beat names.
Done when each line reads `restored`, `waiting`, `skipped <name>: live` or a roster row's down status, or you have acted on it (a gate that cannot read its input or reads a bad setting: fix it and run it again; a broken record or a missing backend pin: resume the session by hand).

## --check

`--check`, with any mode but restore or close, runs every gate but the live-name one and starts or closes nothing.

## Role and settings

`<role>` is the session's kind: `dispatcher` (both dispatchers), `lead` (the builder, ops, the planner and `optimizer`), `worker`, `reviewer`, `tester`, `runner` or `probe`.
It turns on the factory's guards, such as the `no-linear-ticket` hook (**tickets**); a session the owner opens himself has no role, so they leave it alone.
`--settings` adds the factory's own hooks, such as the `no-playground-leak` hook (**classified**), on top of the owner's settings, wherever the session works;
`scripts/link-skills.sh` links that file to the checkout's `scripts/factory-settings.json`, whose hooks find the main checkout through `PLAYGROUND_REPO`, which spawn.sh exports to every session it starts, so they run wherever the session works.
A session gets exactly one `--settings`, since Claude Code keeps only the last one given, and anything extra is merged into that file, as a GLM launch merges its telemetry off.
Every launch merges its compact window (**context**): spawn.sh rebuilds the linked file on each launch into `factory-settings-400k.json` for a worker, a runner or a checker, `factory-settings-glm-400k.json` on GLM, so a resume keeps the same window.
A dispatcher or a lead takes `factory-settings-manager-400k.json` (`factory-settings-glm-manager-400k.json` on GLM), the same file plus a deny of the Agent and Workflow tools, which its memory-trial file carries too (**workers**, scripts/README.md).
A probe takes `factory-settings-sandbox-400k.json` (`factory-settings-glm-sandbox-400k.json` on GLM), the same file plus Claude Code's sandbox around its shell commands (scripts/README.md, spawn.sh).
herdr's own resume is off (`resume_agents_on_restore = false` in ops-herdr's `config.toml`), since it would bring a session back without `--settings` or the role, as a bare `claude --resume` by hand does.
A session resumed that way gets its hooks from its folder alone: Claude Code loads `.claude/settings.json` from the session's own folder, and in a checkout whose settings carry the same hooks they load from there and read the role from the session's name, but anywhere else (a work-org checkout, an older checkout, a subfolder) nothing does,
so a factory session resumed without its settings where its own folder's `.claude/settings.json` lacks them is respawned from its handoff through spawn.sh, never left running as resumed.
Every Ops sweep runs `python3 -I <main checkout>/scripts/ops/up.py --sessions`, which names each one (and none once each is respawned), and sends each to the one it reports to (a checker's or probe's spawner; the dispatcher's goes to Ops), which respawns it, since a live session keeps its name:
the session writes a handoff ([Write a handoff](SESSIONS.md#write-a-handoff), `~/.playground/handoffs/<name>.md`), its pane closes ([End](SESSIONS.md#end)), and a spawn under the same name ([Spawn](SESSIONS.md#spawn)) briefs the respawned session with the handoff, which the respawned-session row of ROSTER.md records.
A resume's `<dir>` is a folder Claude Code already trusts (the Playground checkout or a worktree under it), never a scratchpad or /tmp path.
In a folder it has never trusted, the session stops on the folder-trust dialog, which no session may approve, and `ListAgents` never lists it.
A resumed session, a checker included, runs in the worktree or clone it ran in: spawn.sh resume refuses to move a session into the main checkout unless it started there, and refuses a removed folder, naming its branch and, for a the dispatcher worktree, the `git worktree add` line that brings it back.
