import { getSessionNames, kindOfName, slotOfName } from "@packages/config/kinds"
import { type Backend, HARNESSES } from "@packages/settings"

import { LAPSE_HOURS } from "./priority"

export type Dispatcher = { backend: Backend | null; name: string }
export type Probes = {
  api: boolean
  dispatchers: Dispatcher[]
  follower: boolean
  glm: boolean
  web: boolean
}
export type Step = "dispatcher" | "jobs" | "open" | "wait"

export const NEW_WORKER_BRIEF = "handoffs/new-worker.md"
// spawn.sh's --backend, Claude Code's backends; Codex takes none.
const BACKENDS: readonly string[] = HARNESSES.filter((h) => h.id === "claude-code").flatMap(
  (h) => h.backends,
)
const KINDS = ["worker", "runner"]
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

// The server playground view opens: the sessions', since probes keep to a server of their own.
export const VIEW_SERVER = "playground"

export const HELP = `playground            start herdr's servers that are down and restore their sessions, set the Dashboard's database to start again with Docker and start it when stopped, start the Dashboard's stack and follower in herdr when down, start the dispatcher when it is not running (playground dispatcher), then wait for the Dashboard (a progress line every 10s, stopping early with the reason once ops-dashboard's supervisor stops, its start fails, its alias check fails or the API's health answers a redirect, 15 minutes at most), then open it; a step that failed is named last, with why, under Left for you, and the run exits 1
playground view       open the ${VIEW_SERVER} herdr server, where the sessions run, in this terminal
playground dispatcher [--harness claude-code|codex] [--brief <file>]
                      start the dispatcher in a herdr workspace of its own, on the harness --harness names (spawn.sh --harness, the Dashboard's Start passing harness.alpha), its brief copied from scripts/briefs/dispatcher.md into the data folder as brief-<dispatcher>.md when missing (playground update keeps an unedited copy on the template, and an edited one stays), or the data folder's <file> (a handoff Switch wrote): exit 0 started, 3 already running, 1 refused with spawn.sh's reason
playground planner | builder | ops | optimizer
                      start that manager as playground dispatcher starts the dispatcher, its brief from scripts/briefs/<manager>.md; the dispatcher runs it the first time it routes work there, and the optimizer at its own start
playground status     one line each for the Dashboard, the follower, each dispatcher, GLM and each herdr server
playground sweep <lead>
                      what changed since that lead's last sweep (alerts, the merge queue, load5 crossing 15, the single-slot flag, its rows' passed ETAs, its parked rows' closed or unreadable holds, and for the builder a missing or stale merge queue), or quiet
playground focus [on --session <name> --reason "<why>" [--for <minutes>] | off]
                      give one session the Mac for up to 180 minutes (120 by default): every merge, every other session's heavy run and every new session but its own reviewer and tester and a priority start waits until off or its end, and the Inbox holds what comes in quiet but an alert; off prints how many runs queued while it stood and how long they waited, the line the Inbox's card carries once focus ends; bare, it prints the focus standing
playground priority [on <session> --reason "<why>" | off <session> --reason "<why>"]
                      the one way to open a priority window, and only on the owner's or the dispatcher's word: on writes the data folder's priority-<session>.json, naming the session, who opened it, the reason and the time, and while it stands that session's own spawn.sh --priority start passes focus and the gates playbook's SPAWN.md, Capacity gate, names for a priority start, and run-slot ranks that session's runs first after focus and a hand-written run-slot.priority; off lifts it, and ops-tick's priority-lapse beat lifts one still standing after ${LAPSE_HOURS} hours; each on, off and lapse is a line in ops/priority.log; a priority file another writer keeps it leaves alone; bare, it lists the priority files standing
playground page <file.html> --title "<title>" --by <session> [--for <session>]
                      keep a page for the Dashboard: copy it into the previews folder under a free name, with its title as its caption and a line in pages.jsonl, and print the copy's path for an Inbox card's html attachment (bun run ask new), opening nothing; it shows on the Pages tab of --by's view, of --for's and of the dispatcher's
playground page --remove <file.html>
                      take one kept page off the Pages tab: drop its line from pages.jsonl and move its HTML, caption and PDF to the trash, printing each trash id for playground rm --restore; it refuses, moving nothing, a page pages.jsonl does not list, a path outside the previews folder, a previews folder that is a symlink, a page file or pages.jsonl that is a symlink or hard link, a file over 20 MiB, and a page whose moves the trash's per-minute cap has no room for
playground update [--to <tag>]
                      fast-forward this checkout onto origin/main, re-run link-skills.sh, keep each manager's unedited brief copy on its template and send an edited one's manager the template's diff, install when a lockfile or package.json changed, build packages/* when one with a dist changed, restart the ops jobs whose source changed, move each peer PLAYGROUND_PEERS names to the same commit over ssh (its clone at the same place under its home as the main checkout fetched, checked out detached and installed, one peer <name>: line each, a clone with changes of its own, committed or not, off main or with another worktree cut from it left as it is), then give its run slot back and roll the Dashboard to the newest build: Building (Waiting while its steps queue in run-slot), Switching, then Updated to <sha7> or Failed: <reason>; --to moves the checkout to that release instead, back or on, and leaves the Dashboard as it is
playground doctor     one line per need, as ok, MISSING with its fix, or optional: the tools, the data folder, the pinned herdr, the links into this checkout, the release it is at, and each ops job launchd, or on Linux systemd, should hold
playground herdr pin [--check | --asset <file>]
                      put the pinned herdr's release asset for this machine (macOS or Linux, on arm64 or x64) at the data folder's bin/herdr, after checking its SHA-256 against the pin, refusing a mismatch with both sums; --check reads the copy alone, exit 1 when it is missing or changed; --asset installs from a file instead of downloading
playground herdr restart
                      stop every herdr server as herdr stop does, then start them and the Dashboard as playground does, every terminal job's start grace dropped (up.py --restarted) so the Dashboard's stack starts again in the same run; the Dashboard's System page runs it on Restart herdr
playground herdr stop stop every herdr server Playground started, each through its own socket in the data folder's herdr folder; every session in them ends with it, and the next playground or Start brings them back
playground version    this checkout's tag and sha, the extensions' last commit and Claude Code's version
playground ask <command> ...
                      the Inbox: post an ask, read its answer, close it (bun run ask)
playground changelog <command> ...
                      add rows to the Changelog from GitHub's merges and versions, or a line by hand (bun run changelog)
playground dm send <file>
                      post the reply in <file>, named by its absolute path, to the owner's own DM in its frame, the one way any session posts there (bun run dm)
playground dm upload <item-id>
                      share an answered Inbox item's files into the thread its link names, which the Inbox runs on Send (bun run dm)
playground ingest [--follow | status]
                      read every Claude Code session on this machine into the Dashboard's database (bun run ingest)
playground queues     print the merge queue and the work queue (bun run queues)
playground thread <command> ...
                      open, route, rename or list the Inbox's threads (bun run thread)
playground wa send [--to alert] [--file <path> | --location <lat>,<lon> | --quote <id> | --edit <id> | --delete <id> | --status] [<file>]
                      send the reply in <file>, named by its absolute path, to the owner's WhatsApp through ops-wa, or with --to alert to the wa.alert number, a guest, the one way any session writes there; with --file, an image, a document, a video or a voice note from the data folder's wa/outbox/, the reply its caption and optional; --location a location, the reply its name; --quote a reply quoting a kept message; --edit or --delete one of its own messages by the id it printed; --status the 15-minute update as the owner's one live status message, edited in place while WhatsApp takes an edit; it refuses a body holding a token shape (bun run wa)
playground wa alert [--now-both] [--source <kind>:<ref>] <file>
                      send an urgent alert, one the owner must act on now, in <file>, named by its absolute path, to the owner's WhatsApp at once and to the wa.alert number after wa.alertDelayMinutes unless the owner reacts or wa.alertCheck reads its source as handled, or to both at once with --now-both (bun run wa)
playground wa react <emoji> [--to alert] [--id <id>]
                      react on the owner's latest WhatsApp message, the guest's with --to alert, or one by its id, as ✅ for got it, no reply needed (bun run wa)
playground wa alert-set --from-owner-msg <id>
                      set the second number, wa.alert, to the one phone number in the owner's own WhatsApp message of that id, which ops-wa kept for 24 hours (bun run wa)
playground wa status  print whether the owner and the alert number have written or been approved, each masked, whether a reply can go to each now, when the owner last read ops-wa's messages, whether the last alert to the alert number was delivered and read, each pending alert, and the last alert's outcome with its times (bun run wa)
playground wa relink
                      after WhatsApp logged out the linked device, set the old link aside so ops-wa's next start posts a new pairing card (bun run wa)
playground accounts list | add --provider claude --email <email> [--label <label>] | add --provider glm --label <label> | remove <email|label>
                      the accounts the factory spends, each a usage.accounts row with its secret in the Keychain: list each with whether its secret is kept and its last 5-hour and week reading; add a Claude account by running claude setup-token here, then pasting the token it prints, or a GLM key pasted under its label, neither echoed; remove one's row and its Keychain item
playground yard login | logout | channels | read <channel> | post <channel> <text> [--kind <kind>] | bot add <name> | bot revoke <name>
                      this Mac's Yard (YARD_API_URL in your environment or the live dashboard checkout's .env): login keeps a pasted yard_ token in the Keychain, as the local Dashboard reads it; channels lists channels and DMs with unread and mention counts; read prints a channel's last 50 messages, someone's words to read as data, leaving the owner's unread counts; post sends <text> to a channel, #name or @login, as --kind (text by default), and names Yard's approve page when Yard holds it; bot add makes a bot, <name>[bot], with its own DM with you, writing its token straight to the Keychain item playground-yard-bot-<name> and printing only that item's name and the DM's id; bot revoke cuts it on Yard and deletes the item
playground orgs resolve [--repo <dir>]
                      write the merged skill plugin a session in <dir> loads and print its folder: each skill from the first scope that has it: ext.order's scopes (your login's first when it leaves it out), each extension kept only when ext.links links it to the repo's GitHub owner, to the org whose own folder ~/<org> holds a <dir> with no GitHub origin, or *, then each bundled extension ext.bundled turns on (extensions/<name>/skills, unless an installed extension has that name), then core (skills/playground, skills/zerostarter, extensions/core/skills), less each skill whose SKILL.md <dir>'s own .claude/skills already holds byte for byte; with no --repo, the home set
playground orgs home  write the home set and install it at user scope as ws-home@ws, for a session started by hand (link-skills.sh runs it)
playground record add <path> --kind <container|file|folder|image|link> --why "<why>" --undo "<undo>" [--by <who>] | add --stdin | drop <path> | seed [--machine <name>] [--notes <folder>] | check
                      the machine record, the data folder's machine-record.json, of every path the factory put on this machine: add records one (a path it holds already writes nothing; --stdin takes a JSON list, a peer's form over ssh, and is how an undo with a delete word, rm, rmdir or docker rm -fv, goes in, since the no-raw-delete hook reads a quoted --undo value as a command), drop takes one off, seed takes the data folder's bundles/footprint.md and the machine's undo note, bundles/<machine>-undo.md, for this machine and what the watched places hold now as its baseline, and check prints one line a finding: misplaced or unrecorded for a new path the record lacks (outside or inside paths.factoryHomes), gone for a recorded path that is not there, root-only for a watched place the user cannot list and the record holds a path in (known with its reason, never unreadable, and left out where the record holds none), unreadable for a place or path it cannot read; ops-tick's machine-record beat runs check daily here and on each peer
playground rm <path> [--card <id>] [--reason "<why>"] | --worktree <path> [--discard] [--pr <url>] [--reason "<why>"] | --list | --restore <id>
                      move a path into the trash (the data folder's trash/<UTC-ts>-<session>/<n>/, with a manifest.jsonl line), where it stays 7 days, sooner when the disk has under 50 GB free, its node_modules and web/next/.next stripped, which an install or a build rebuilds; refuse a protected path (HOME and the folders that hold it, ~/.ssh and its kin, the data folder but for the caller's own scratch/<name>/ and scratchpad/<name>/, its own loose regular file directly in scratch/ named <name>-* or <name>.*, its own factory-settings-400k-memory-<name>.json, an ended session's whole scratchpad/<folder>/ or scratch/<folder>/ (a real folder no live roster row names as itself or as <folder>-<role>), and a retired data folder whole (safe-delete's RETIRED list, ci today), the main checkout), a path over 5,000 files or 2 GB (an ended session's whole scratchpad/<folder>/ or scratch/<folder>/, a retired data folder, a folder inside the caller's own scratchpad/<name>/ and the caller's own /tmp/playground-<name>.* folder skip the file count), a fourth delete in a minute from one session, or a move to another volume; --worktree takes a worktree in .claude/worktrees that no live session holds (a roster row naming its branch or its PR's number holds it no more once that PR has merged or closed and the worktree sits at its head, which it prints as freed, and a row whose one hold is the number of a PR gh reads as merged, by the row's PR URL, holds it no more while the worktree sits at or behind that PR's head; commits past it keep the hold, named with them; a live row also holds no more a worktree sitting clean, detached, at a commit its base holds, origin/canary or another repo's default branch; the main checkout's worktree on the live.branch branch, the live Dashboard's checkout, is never taken, --discard included, nor any while that setting cannot be read), with no uncommitted change and its work landed on canary (another repo's on that repo's default branch, origin/HEAD's else gh's) or, for either, on a remote branch that git ls-remote still reads as holding HEAD, which it prints (every read of which commits a remote holds asks the remote live with git ls-remote, never a remote-tracking ref, and a remote it cannot read holds none), or, for another repo's worktree whose branch gh answers has no PR, its commits no remote holds archived by git format-patch into the data folder's scratchpad/archive/<repo>/<worktree>-<HEAD sha7>/ first, while every remote reads, since a remote it cannot read keeps the tree and names that remote (--discard lets those two go, with no decision, its commits no remote holds first written to a git bundle beside it in the trash (<name>.bundle and <name>.shas), which git -C <repo> fetch <bundle> HEAD brings back; --pr <url> names the PR whose session used it, so another session of that PR holds it by that PR's number no more, with --discard only once that PR reads MERGED or CLOSED), and prunes it from git; --worktree also takes a model test's replay worktree in a row of ~/models/kit/runs or in a recorded folder, detached at a commit origin/canary holds, with no process working in it, outside kit/runs with no tracked edit, and neither --discard nor --pr, writing its work to <name>.diff beside it, then removing it through the main checkout's own forced git worktree remove; --card <id> removes the path only as the owner's Remove on that nightly-clean card names it, on this machine at its size, or on a named peer over one ssh that runs playground rm --card <id> --peer <machine> <path>, which re-checks the path there before it deletes, while the card reads as nightly-clean last wrote it and was answered after that write, past the caps: weights (a .gguf or .safetensors under ~/models or a recorded folder, or a repo folder in ~/models/hf/hub) deleted outright and logged in trash/deleted.jsonl, anything else to the trash whole, a rehearsal in a session's scratchpad included, its machine record entry dropped; --list prints what the trash holds and --restore puts one item back
playground rules [<name>]
                      the standing rules a factory session starts with, each by its glance line, or one rule whole, with this machine's values in its slots
playground settings list | get <key> [--org <org>] | why <key> | set <key> <value> --reason "<why>" [--scope <scope>] | reset <key> --reason "<why>" [--scope <scope>]
                      read or change a setting in the extensions folder, each write one commit with its reason (an org's scope or your login's, your login's by default)
playground settings set <key> <value> --from-owner-msg <id>
                      ask ops-wa to set a key, a guarded one included, at your login's scope from the owner's own WhatsApp message of that id, kept 24 hours, which must hold the value; a key a guard reads waits for the owner's yes on WhatsApp within 10 minutes, and each set prints its undo
playground settings set <key> <value> --propose
                      ask ops-wa to put a guarded key and its whole value to the owner on WhatsApp, "set <key> to <value>? Reply yes or no", and set it at your login's scope on his yes to that question within 10 minutes; a key no guard reads, a masked key, wa.owner, wa.device and an ask while another confirm waits are refused
playground settings import-jobs <jobs.json> [--launch-agents <dir>] [--scope <scope>] [--dry-run]
                      once, at the switch: each ops job jobs.json lists becomes its jobs.<name> setting (your login's scope by default), a launchd job's program read from its plist; a job the registry does not know stays in jobs.json
playground ext which <skill> [--repo <dir>]
                      print the folder of the copy of <skill> a session in <dir> loads, from whichever scope holds it
playground ext init [--yes | --dry-run] | add <name> [<owner/name>] [--yes] | order | link | unlink | lock | unlock | remove | sync [<scope>] | list | show | put | why | diff | search | export <dir> | import <dir> [--dry-run] | import --from-tree <dir> | import-scripts <ops-dir> <job>... --org <org> | score | accept | reject | check-modes
                      make (on your yes, typed or --yes) or reuse your private repo and clone your login's folder from it, sync each scope with its repo now, read the extensions, put an item's next revision from a file, a folder or stdin with its reason and attachments as one commit in its scope, search them, export or import every scope as a folder of clones, seed the guards' lists from a folder of list files, bring each job folder in as an org's script once at the switch, score, accept or reject a proposal, list once the stored scripts that lost their executable bit, and set or clear the extensions folder's file lock, which every write here lifts for itself
playground migrate --archive <checkout> --pre-squash <sha> --org <org> [--old <rev>] [--dry-run]
                      once, at the switch: move the old data folder in ~/.claude to ~/.playground, seed your login's settings and the release owners' list from the archive checkout (its canary, or --old, and the pre-squash head), bring the hand-made skills into the org's scope unless its clone holds them, then, with the Dashboard's job stopped, make each move the migration table at the pre-squash head lists: renamed and dropped jobs, archived stale copies, moved state files, and renamed variables in your profiles and LaunchAgents, and last runs playground herdr pin; a value already set is left
playground uninstall [--purge]
                      remove the LaunchAgents (on Linux the systemd user units) that run from this checkout or the data folder, stop the Dashboard's stack and remove every link into this checkout; --purge also removes the Dashboard's database and moves the data folder aside to <data folder>-purged-<UTC time>, after asking
playground add [--kind worker|runner] [<name>] [--title "<title>"] [--brief <file>] [--model <id>] [--backend glm|local|claude] [--account <email>]
                      start a worker (or a runner) through spawn.sh, under the name given or one bun run name picks, on handoffs/new-worker.md by default; a worker needs --title, a plain title of up to 40 characters, and a runner takes its name and no --title; --account names the Claude login, which a worker needs while usage.accounts lists a Claude account
playground add --dispatcher --backend glm
                      start a second dispatcher on GLM
playground alerts-wait <name>
                      for a manager's background task, or a session on another machine's: wait for the next outbox line addressed to <name>, a stuck alert first, else any job's line such as a heads-up or a playground send from the other machine, led by [ops-peer] and its sender's name, print it and exit, so it wakes without waiting on the relay
playground ci-wait <pr> [--repo <owner/name>]
                      wait on a PR's CI, as a background task: poll its head over REST every 5 minutes until the two required checks (Audit, Lint, and Build and test) exist there and have concluded, then print each conclusion and exit 0 when all passed, else 1; a rate limit waits for its reset, a head that moves is waited on afresh, a check whose workflow run ended without creating it exits 1 with its rerun, a PR that conflicts with its base exits 1 at once naming the merge it needs (no CI runs on one), and a PR or repo GitHub does not know, or a refused login, exits 2; --repo is the factory's own repo when left out
playground picker <session> allow <key> [--rule <name>] | deny <key> [--rule <name>] "<reason>"
                      as the session's manager, answer the permission prompt its stuck alert named by key: allow presses Yes once, deny presses No and sends the session the reason; --rule names the standing rule that settles the answer; each answer is a line in ops/picker.log
playground model use <name> [--machine <name>]
                      start the local model server in ~/models/<name>/ on the machine named, else on the machine whose localModels.hereModel or localModels.peerModel names it (the peer when neither does): its memory share and its sessions sized from that machine's free memory above its reserve, beside a running model when both fit, else in its place once that model's requests drain; it stops only a container it started, and refuses saying why, with the memory reading, when not even one session fits
playground send <name> <text>
                      message a session on the other machine, which SendMessage does not reach: queue one line, {at, from, id, text, to}, in the outbox's ops-peer.jsonl, which the ops-peer-relay job copies to the other machine, where that session's alerts-wait prints it; from is your session's name, and a line over 16 KB is refused`

// The package scripts playground runs as its own verbs.
export const VERBS = ["ask", "changelog", "dm", "ingest", "queues", "thread", "wa"]

// playground <verb> runs the package script of that name in the Dashboard's checkout, words and all.
export const verbArgv = (verb: string, words: string[]): string[] => ["run", verb, ...words]

export const VIEW_HINT = "Sessions: playground view opens them in herdr"

// Bare playground: herdr first, since the sessions run there; a herdr failure is shown, the Dashboard's steps still run, and either failing exits 1.
// The jobs up.py recorded starting (its up-state.json), whose start grace a herdr restart ends; none when the file is missing or unread.
export const recordedJobs = async (file: string): Promise<string[]> => {
  try {
    const starts: unknown = await Bun.file(file).json()
    return starts && typeof starts === "object" ? Object.keys(starts).sort() : []
  } catch {
    return []
  }
}

export async function runStart(
  herdr: () => Promise<number>,
  dashboard: () => Promise<number>,
): Promise<number> {
  const code = await herdr()
  return (await dashboard()) === 0 ? code : 1
}

// playground status: herdr's lines first, as start runs herdr first, so they print even when the Dashboard's part stops for want of a live dashboard checkout.
export async function runStatus(
  herdr: () => Promise<number>,
  dashboard: () => Promise<void>,
): Promise<number> {
  const code = await herdr()
  await dashboard()
  return code
}

// The words each command takes, its options' values aside, a subcommand's under "<command> <subcommand>", "rest" for words its parser reads whole; a command or subcommand not named here is its parser's to refuse, as a verb's words are its script's.
export const WORDS: Record<string, number | "rest"> = {
  "accounts add": 0,
  "accounts list": 0,
  "accounts remove": 1,
  add: 1,
  "alerts-wait": 1,
  builder: 0,
  "ci-wait": 1,
  dispatcher: 0,
  doctor: 0,
  "ext accept": 4,
  "ext add": 2,
  "ext check-modes": 0,
  "ext diff": 3,
  "ext export": 1,
  "ext import": 1,
  "ext import-scripts": "rest",
  "ext init": 0,
  "ext link": 2,
  "ext list": 0,
  "ext lock": 0,
  "ext order": "rest",
  "ext put": 4,
  "ext reject": 4,
  "ext remove": 1,
  "ext score": 5,
  "ext search": "rest",
  "ext show": 3,
  "ext sync": 1,
  "ext unlink": 2,
  "ext unlock": 0,
  "ext which": 1,
  "ext why": 3,
  focus: 0,
  "focus off": 0,
  "focus on": 0,
  "herdr pin": "rest",
  "herdr restart": 0,
  "herdr stop": 0,
  migrate: 0,
  "model use": 1,
  ops: 0,
  optimizer: 0,
  "orgs home": 0,
  "orgs resolve": 0,
  page: 1,
  picker: "rest",
  planner: 0,
  priority: 0,
  "priority off": 1,
  "priority on": 1,
  record: "rest",
  rm: "rest",
  rules: 1,
  send: "rest",
  "settings get": 1,
  "settings import-jobs": 1,
  "settings list": 0,
  "settings reset": 1,
  "settings set": 2,
  "settings why": 1,
  status: 0,
  sweep: 1,
  uninstall: 0,
  update: 0,
  version: 0,
  view: 0,
  "yard channels": 0,
  "yard login": 0,
  "yard logout": 0,
  "yard post": "rest",
  "yard read": 1,
}

// The options that take no value, so the word after one is a word of its own.
const BARE = ["--dispatcher", "--dry-run", "--purge"]

const wordsOf = (words: string[]): string[] => {
  const found: string[] = []
  for (let i = 0; i < words.length; i++)
    if (BARE.includes(words[i]!)) continue
    else if (words[i]!.startsWith("--")) i++
    else found.push(words[i]!)
  return found
}

// A command's usage, read off its lines in HELP.
export const usageOf = (command: string): string =>
  HELP.split("\n")
    .filter((line) => line === `playground ${command}` || line.startsWith(`playground ${command} `))
    .map((line, i) => `${i ? "       " : "usage: "}${line.split(/ {2,}/)[0]}`)
    .join("\n")

// Why a command's words are refused, or null: a word past what WORDS gives its command or subcommand, with its usage; then the shapes uninstall, update, sweep, alerts-wait and send take.
export const extraWordRefusal = ([command, ...rest]: string[]): string | null => {
  const named = `${command} ${rest[0]}` in WORDS ? `${command} ${rest[0]}` : command
  const takes = named === undefined ? undefined : WORDS[named]
  if (typeof takes === "number") {
    const extra = wordsOf(named === command ? rest : rest.slice(1))[takes]
    if (extra !== undefined) return `playground ${named} takes no ${extra}\n${usageOf(command!)}`
  }
  if (command === "uninstall")
    return rest.length === 0 || (rest.length === 1 && rest[0] === "--purge")
      ? null
      : "usage: playground uninstall [--purge]"
  if (command === "update")
    return rest.length === 0 || (rest.length === 2 && rest[0] === "--to")
      ? null
      : "usage: playground update [--to <tag>]"
  if (command === "sweep")
    return rest.length === 1 ? null : "usage: playground sweep <lead> (builder or ops)"
  if (command === "alerts-wait")
    return rest.length === 1
      ? null
      : "usage: playground alerts-wait <name> (your own session's name)"
  if (command === "send") return rest.length >= 2 ? null : "usage: playground send <name> <text>"
  return null
}

// The help asked for as the command, or after any command, so `playground update --help` never rolls.
export const wantsHelp = ([command, ...rest]: string[]): boolean =>
  command === "--help" ||
  command === "-h" ||
  command === "help" ||
  rest.some((word) => word === "--help" || word === "-h")

// The start's closing lines: each step that failed and why, under Left for you as install.sh lists its own, so a run that exits 1 never ends on the Dashboard's lines alone.
export const leftLines = (failed: string[]): string[] =>
  failed.length ? ["Left for you:", ...failed.map((line) => `  - ${line}`)] : []

// What `playground` starts, from the probes alone: the ops jobs (the dashboard's stack and follower) while its API is down, the lead dispatcher while no session holds its slot by name (slotOfName), then the Dashboard.
export const planStart = (probes: Probes): Step[] => {
  const steps: Step[] = []
  if (!probes.api) steps.push("jobs")
  if (!probes.dispatchers.some((d) => slotOfName(d.name) === 1)) steps.push("dispatcher")
  if (!probes.api) steps.push("wait")
  steps.push("open")
  return steps
}

export const modelOf = (backend: Backend | null): string =>
  backend === "glm"
    ? "GLM"
    : backend === "local"
      ? "the local model"
      : backend === "claude"
        ? "Claude"
        : backend === "openai"
          ? "Codex"
          : "an unknown model"

export const statusLines = (probes: Probes): string[] => {
  const lead = probes.dispatchers.filter((d) => slotOfName(d.name) === 1)
  const others = probes.dispatchers.filter((d) => slotOfName(d.name) !== 1)
  return [
    `Dashboard web: ${probes.web ? "up" : "down"}`,
    `Dashboard API: ${probes.api ? "up" : "down"}`,
    `Session follower: ${probes.follower ? "running" : "stopped"}`,
    ...(lead.length ? [] : ["Dispatcher: not running"]),
    ...[...lead, ...others].map((d) => `Dispatcher on ${modelOf(d.backend)}: running`),
    `GLM: ${probes.glm ? "set up" : "not set up"}`,
  ]
}

export type AddCommand = { argv: string[]; started: string } | { error: string }

// The spawn.sh argv `playground add` runs, and the line it prints once started, its other words checked before spawn.sh runs; a given `--brief` goes to spawn.sh as typed, so spawn.sh's one brief rule reads it. `exists` says whether the fixed new-worker brief is a file under ~/.playground, and `pickName` names a session of a kind when no name is given (`bun run name`), and `models` is the --model list models.claude sets. A given name carries its kind's prefix, as spawn.sh asks, and nothing here puts one in front.
export const addCommand = (
  args: string[],
  exists: (brief: string) => boolean,
  pickName: (kind: string) => string,
  models: string[],
): AddCommand => {
  const options: Record<string, string> = {}
  const words: string[] = []
  let manager: string | undefined
  let dispatcher = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--dispatcher") dispatcher = true
    else if (
      ["--account", "--backend", "--brief", "--kind", "--manager", "--model", "--title"].includes(
        arg,
      )
    ) {
      const value = args[++i]
      if (value === undefined) return { error: `${arg} needs a value` }
      if (arg === "--manager") manager = value
      else options[arg] = value
    } else if (arg.startsWith("-")) return { error: `playground add takes no ${arg}` }
    else words.push(arg)
  }
  const brief = options["--brief"]
  const model = options["--model"]
  if (model !== undefined && !models.includes(model))
    return {
      error: `--model takes ${models.length > 1 ? `${models.slice(0, -1).join(", ")} or ` : ""}${models.at(-1)}, not ${model}`,
    }
  const backend = options["--backend"]
  if (backend !== undefined && !BACKENDS.includes(backend))
    return { error: `--backend takes claude, glm or local, not ${backend}` }
  const account = options["--account"]
  const passed = [
    ...(model ? ["--model", model] : []),
    ...(backend ? ["--backend", backend] : []),
    ...(account ? ["--account", account] : []),
  ]

  const kind = options["--kind"]
  const title = options["--title"]
  if (kind !== undefined && !KINDS.includes(kind))
    return { error: `--kind takes worker or runner, not ${kind}` }

  if (dispatcher) {
    if (
      account !== undefined ||
      manager !== undefined ||
      words.length ||
      brief !== undefined ||
      model !== undefined ||
      kind !== undefined ||
      title !== undefined
    )
      return { error: "--dispatcher takes --backend alone" }
    // spawn.sh starts the second dispatcher on Claude only under a second account, which playground add does not take.
    if (backend !== "glm")
      return {
        error:
          "a second dispatcher runs on --backend glm, since on Claude it needs a second account",
      }
    return {
      argv: [
        "manager",
        `${getSessionNames().names.dispatcher}-2`,
        `brief-${getSessionNames().names.dispatcher}-2.md`,
        ...passed,
      ],
      started: `Started a second dispatcher on ${modelOf("glm")}`,
    }
  }
  // A manager is started by its kind through spawn.sh's manager mode, which a later PR adds here.
  if (manager !== undefined)
    return {
      error: "--manager is not ready yet",
    }
  if (words.length > 1) return { error: `playground add takes one name, not ${words[1]}` }
  const mode = kind ?? "worker"
  const given = words[0]
  if (given !== undefined && !NAME.test(given))
    return {
      error: `a name is lowercase words joined by hyphens, not ${given}`,
    }
  const named = given === undefined ? null : kindOfName(given)
  if (named && named !== mode)
    return { error: `${given} reads as a ${named}, not a ${mode}: bun run name ${mode} gives one` }
  if (given !== undefined && !named)
    return { error: `${given} gives no kind: bun run name ${mode} gives one` }
  const name = given ?? pickName(mode)
  if (brief === undefined && !exists(NEW_WORKER_BRIEF))
    return {
      error: `~/.playground/${NEW_WORKER_BRIEF} is missing: run scripts/link-skills.sh`,
    }
  return {
    argv: [mode, name, brief ?? NEW_WORKER_BRIEF, ...passed, ...(title ? ["--title", title] : [])],
    started: `Started ${name}`,
  }
}

export type RollOutcome =
  | { phase: "building" | "going back" | "switching" }
  | { phase: "waiting"; why: string }
  | { done: string; ok: boolean }

// A waiting roll's line: the load it waits on, read now, when run-slot's reason is load5's line, else run-slot's own reason, said once.
export const waitingLine = (why: string, load5: number) => {
  const under = why.match(/load5 under (\d+)/)?.[1]
  if (under)
    return `Waiting for load: load5 is ${load5.toFixed(1)}, and the roll goes on under ${under}`
  return why.startsWith("waiting for ") ? `W${why.slice(1)}` : `Waiting for a run slot: ${why}`
}

// Whether the supervisor's prebuild step still queues in run-slot, as slot_step's step_started reads it: its run-slot pid (prebuild.pid) lives and run-slot.runs.log holds no start line for it yet.
export const stepQueued = (
  pid: string | undefined,
  alive: (pid: number) => boolean,
  runs: string[],
) => {
  const n = Number(pid?.trim() || Number.NaN)
  if (!Number.isInteger(n) || n <= 1 || !alive(n)) return false
  return !runs.some((line) => {
    const words = line.split(" ")
    return words[1] === "start" && words[3] === String(n)
  })
}

// The end of a roll that gave no result in 30 minutes: one still queued in run-slot, by its log or by its step's own run (`queued`, stepQueued), goes on by itself, so it reads as waiting and passes, and any other is a failure.
export const rollTimedOut = (
  last: RollOutcome,
  load5: number,
  queued = false,
): { done: string; ok: boolean } => {
  const why =
    "phase" in last && last.phase === "waiting"
      ? last.why
      : queued
        ? "the roll's next step is still queued in run-slot"
        : undefined
  return why !== undefined
    ? {
        done: `${waitingLine(why, load5)}: still waiting after 30 minutes, and the roll goes on by itself; see ops/dashboard/supervisor.log`,
        ok: true,
      }
    : {
        done: "Failed: no roll result within 30 minutes; see ops/dashboard/supervisor.log",
        ok: false,
      }
}

// Where the dashboard's supervisor is in the roll `playground update` asked for, from the lines its log and results log gained since. A failed roll goes back to the build before, and is done once that FALLBACK lands, unless it ran a migration or its build failed before the stop.
export const rollOutcome = (log: string[], results: string[]): RollOutcome => {
  let failed: string | undefined
  // a roll that moved the database onto loopback names the move and the old container's remove command on its PASS or FAIL line (supervisor.sh's move_database), which the report keeps either way
  let moved: string | undefined
  const withMove = (done: string) => (moved ? `${done}; ${moved}` : done)
  for (const line of results) {
    if (failed !== undefined) {
      // a refused roll's own line follows roll_up's FAIL and names the refusal with its count
      const refusing = line.match(/^\S+ ROLL .* FAIL (dev refusing: .*)$/)
      if (refusing) {
        failed = refusing[1]
        continue
      }
      const back = line.match(/^\S+ FALLBACK (\w+) (PASS|FAIL)/)
      if (back)
        return {
          done: withMove(
            `Failed: ${failed}; ${back[2] === "PASS" ? `back on ${back[1]}` : `going back to ${back[1]} failed too`}`,
          ),
          ok: false,
        }
      continue
    }
    const current = line.match(/^\S+ CURRENT (\w+)/)
    if (current) return { done: `Already up to date at ${current[1]}`, ok: true }
    const refused = line.match(/^\S+ (?:SKIP \w+ FAIL|ANOMALY) (.*)$/)
    if (refused) return { done: `Failed: ${refused[1]}`, ok: false }
    const roll = line.match(/^\S+ ROLL (.*?) (\w+) (PASS|FAIL)(?: (.*))?$/)
    if (!roll) continue
    moved = roll[4]?.match(/ database: (Moved .*)$/)?.[1]
    if (roll[3] === "PASS") return { done: withMove(`Updated to ${roll[2]}`), ok: true }
    failed = (roll[4] || "the roll failed").replace(/ database: Moved .*$/, "")
    // a build that failed before the stop stopped nothing, so no fallback follows
    if (failed.startsWith("build before the stop:"))
      return { done: withMove(`Failed: ${failed}`), ok: false }
    if (/\bmigrate\b/.test(roll[1]))
      return {
        done: withMove(
          `Failed: ${failed}; it changed the database, so the Dashboard stays on ${roll[2]}`,
        ),
        ok: false,
      }
  }
  if (failed !== undefined) return { phase: "going back" }
  // the supervisor builds the head after its roll-now line, before it stops the Dashboard or, for a head that migrates, after, so the roll reads as building until the head is built, or starts on a build it kept, and only then as switching
  const rolling = log.findIndex((line) => line.includes("roll-now: rolling to"))
  const starting = log.findIndex(
    (line, at) => at > rolling && / (built \w+ in |dev started)/.test(line),
  )
  if (rolling >= 0 && starting > rolling) return { phase: "switching" }
  // a prebuild step queued in run-slot, whose stderr the supervisor logs, waits until run-slot's next line of its own, the supervisor's own lines between leaving it waiting; the build, whose run-slot lines build_head captures, shows its wait only in the supervisor's still-queued line
  let why: string | undefined
  for (const line of rolling >= 0 ? log.slice(rolling + 1) : []) {
    const said = line.match(/^run-slot\.sh: (.*)$/)?.[1]
    if (said !== undefined)
      why = /^(this clone waits|waiting for|queued behind) /.test(said) ? said : undefined
    const queued = line.match(/^\S+ (prebuild \w+ still queued after \d+s.*)$/)?.[1]
    if (queued !== undefined && why === undefined) why = queued
  }
  return why === undefined ? { phase: "building" } : { phase: "waiting", why }
}

// ops-dashboard's heartbeat as read at one poll: its age, its cycle and whether its pid is alive.
export type DashboardBeat = { ageMs: number; cycleSeconds: number; running: boolean }
// A health read that answered a 3xx: the URL asked, its status and where it was sent.
export type Redirect = { from: string; status: number; to: string }
type WaitRead = {
  alias?: string | null
  api: boolean
  beat: DashboardBeat | null
  failure: string | null
  now: number
  redirect?: Redirect | null
  upHolds?: boolean
}
type WaitOutcome = { done: string; ok: boolean } | { progress: string | null }

// The results ops.ts's EXITED reads as a loop that has exited.
const EXITED = /^(supervisor exited|loop exited)/

// ops-dashboard.json's parsed text as a beat, null unless it is an object with a lastBeatAt that reads and, when given, a positive cycleSeconds; an exited loop or a gone pid is not running.
export const dashboardBeatOf = (
  json: unknown,
  now: number,
  alive: (pid: number) => boolean,
): DashboardBeat | null => {
  if (typeof json !== "object" || json === null) return null
  const beat = json as {
    cycleSeconds?: unknown
    lastBeatAt?: unknown
    lastResult?: unknown
    pid?: unknown
  }
  const at = typeof beat.lastBeatAt === "string" ? Date.parse(beat.lastBeatAt) : Number.NaN
  if (!Number.isFinite(at)) return null
  const cycleSeconds = beat.cycleSeconds ?? 60
  if (typeof cycleSeconds !== "number" || !(cycleSeconds > 0)) return null
  const exited = typeof beat.lastResult === "string" && EXITED.test(beat.lastResult)
  const pid = Number(beat.pid)
  return {
    ageMs: now - at,
    cycleSeconds,
    running: !exited && Number.isInteger(pid) && pid > 0 && alive(pid),
  }
}

// Stale past STALE_CYCLES cycles, as ops.ts's opsRowOf reads a job Down.
const STALE_CYCLES = 3
export const staleBeat = (beat: DashboardBeat): boolean =>
  beat.ageMs > STALE_CYCLES * beat.cycleSeconds * 1000

const WAIT_MS = 15 * 60_000
const PROGRESS_MS = 10_000
// up.py has only just started run.sh, so the heartbeat on disk may still be an earlier run's.
const START_GRACE_MS = 30_000
const AGAIN = "see ops/dashboard/supervisor.log, then run playground again"

const duration = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// Why the Dashboard's stack did not start, in plain words, from the supervisor's results and log since a mark: the refusal or error its newest START or RESTART names when it failed on the stack itself (its dev, its build or its web), else null. Only a roll begun after the mark counts, a RESTART by the DOWN line that opened it and a START by its supervisor's "supervisor armed" line, since an earlier roll may have met a database that has started since; a newer PASS clears a FAIL.
export const startFailure = (results: string[], log: string[]): string | null => {
  const armed = log.some((line) => /^\S+ supervisor armed /.test(line))
  let down = false
  let failure: string | null = null
  for (const line of results) {
    if (/^\S+ DOWN (?:dev|web): /.test(line)) {
      down = true
      continue
    }
    const result = line.match(/^\S+ (START|RESTART) \w+ (PASS|FAIL) (.*)$/)
    if (!result) continue
    const begun = result[1] === "START" ? armed : down
    down = false
    if (result[2] === "PASS") failure = null
    else if (begun) failure = stackFailure(result[3]!)
  }
  return failure
}

// A failed roll's words after FAIL: why its dev refused, or its build's or web's error; a dev that died with no reason in its log gets one, and a failure off the stack (its verify, its follower) is null.
const stackFailure = (failed: string): string | null => {
  const other = failed.match(/^(?:build|web): (.*)$/)?.[1]
  if (other !== undefined) return other.trim() || null
  const dev = failed.match(/^dev=DOWN \((.*)$/)?.[1]
  if (dev === undefined) return null
  const end = dev.lastIndexOf(") follower=")
  const why = (end >= 0 ? dev.slice(0, end) : dev.replace(/\)$/, ""))
    .replace(/^dev: refusing to start: /, "")
    .trim()
  return why || "its API exited with no reason in its log"
}

// The supervisor's alias check as its results since the mark leave it: the words of the newest ALIAS FAIL no ALIAS PASS has followed, which it writes only once a mismatch has held past its confirm, else null.
export const aliasFailure = (results: string[]): string | null => {
  let failure: string | null = null
  for (const line of results) {
    const alias = line.match(/^\S+ ALIAS (PASS|FAIL) (.*)$/)
    if (alias) failure = alias[1] === "FAIL" ? alias[2]! : null
  }
  return failure
}

// One poll of the wait for the Dashboard's API after the jobs step: done once it answers, once the supervisor's results name why its stack did not start or that portless does not route its addresses, once the API's health answers a redirect, once ops-dashboard's supervisor is gone or its heartbeat stale, or at 15 minutes; else a progress line at most every 10s. The wait keeps going past a missing beat while ops-up holds the job, since its grace starts it again, so it names "supervisor is not running" only up.py has let the grace run out.
export const waitOutcome = (
  read: WaitRead,
  state: { shownAt: number; startedAt: number },
): WaitOutcome => {
  const spent = read.now - state.startedAt
  if (read.api) return { done: `The Dashboard answered after ${duration(spent)}`, ok: true }
  const beat = read.beat
  if (spent >= START_GRACE_MS) {
    if (read.failure)
      return {
        done: `the Dashboard's stack could not start: ${read.failure} (waited ${duration(spent)}); ${AGAIN}`,
        ok: false,
      }
    if (read.alias)
      return {
        done: `portless does not route the Dashboard's addresses to its stack: ${read.alias} (waited ${duration(spent)}); ${AGAIN}`,
        ok: false,
      }
    if (read.redirect)
      return {
        done: `the Dashboard's API answered ${read.redirect.status} at ${read.redirect.from}, a redirect to ${read.redirect.to}, so playground asks it at an address portless does not serve (waited ${duration(spent)}); ${AGAIN}`,
        ok: false,
      }
    if (!beat?.running && !read.upHolds)
      return {
        done: `ops-dashboard's supervisor is not running, so the Dashboard will not come up (waited ${duration(spent)}); ${AGAIN}`,
        ok: false,
      }
    if (beat && staleBeat(beat) && !read.upHolds)
      return {
        done: `ops-dashboard's heartbeat is ${duration(beat.ageMs)} old, past three of its ${beat.cycleSeconds}s cycles, so its supervisor has stopped; ${AGAIN}`,
        ok: false,
      }
  }
  if (spent >= WAIT_MS)
    return { done: `the Dashboard did not answer within 15 minutes; ${AGAIN}`, ok: false }
  if (read.now - state.shownAt < PROGRESS_MS) return { progress: null }
  return { progress: `Waiting for the Dashboard's API to answer… ${duration(spent)}` }
}
