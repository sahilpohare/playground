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

export const HELP = `playground            start herdr's servers that are down and restore their sessions, set the Dashboard's database to start again with Docker and start it when stopped, start the Dashboard's stack and follower in herdr when down, start the dispatcher when it is not running (playground dispatcher), then wait for the Dashboard (a progress line every 10s, stopping early with the reason once ops-dashboard's supervisor stops or its start fails, 15 minutes at most), then open it; a step that failed is named last, with why, under Left for you, and the run exits 1
playground view       open the ${VIEW_SERVER} herdr server, where the sessions run, in this terminal
playground dispatcher [--harness claude-code|codex] [--brief <file>]
                      start the dispatcher in a herdr workspace of its own, on the harness --harness names (spawn.sh --harness, the Dashboard's Start passing harness.alpha), its brief written once from scripts/briefs/dispatcher.md into the data folder as brief-<dispatcher>.md, or the data folder's <file> (a handoff Switch wrote): exit 0 started, 3 already running, 1 refused with spawn.sh's reason
playground planner | builder | ops | optimizer
                      start that manager as playground dispatcher starts the dispatcher, its brief from scripts/briefs/<manager>.md; the dispatcher runs it the first time it routes work there, and the optimizer at its own start
playground status     one line each for the Dashboard, the follower, each dispatcher, GLM and each herdr server
playground sweep <lead>
                      what changed since that lead's last sweep (alerts, the merge queue, load5 crossing 15, the single-slot flag, its rows' passed ETAs, its parked rows' closed or unreadable holds), or quiet
playground focus [on --session <name> --reason "<why>" [--for <minutes>] | off]
                      give one session the Mac for up to 180 minutes (120 by default): every merge, every other session's heavy run and every new session but its own reviewer and tester and a priority start waits until off or its end, and the Inbox holds what comes in quiet but an alert; off prints how many runs queued while it stood and how long they waited, the line the Inbox's card carries once focus ends; bare, it prints the focus standing
playground priority [on <session> --reason "<why>" | off <session> --reason "<why>"]
                      the one way to open a priority window, and only on the owner's or the dispatcher's word: on writes the data folder's priority-<session>.json, naming the session, who opened it, the reason and the time, and while it stands a spawn.sh --priority start passes the load and slots gates and focus; off lifts it, and ops-tick's priority-lapse beat lifts one still standing after ${LAPSE_HOURS} hours; each on, off and lapse is a line in ops/priority.log; a priority file another writer keeps it leaves alone; bare, it lists the priority files standing
playground page <file.html> --title "<title>" --by <session> [--for <session>]
                      keep a page for the Dashboard: copy it into the previews folder under a free name, with its title as its caption and a line in pages.jsonl, and print the copy's path for an Inbox card's html attachment (bun run ask new), opening nothing; it shows on the Pages tab of --by's view, of --for's and of the dispatcher's
playground update [--to <tag>]
                      fast-forward this checkout onto origin/main, re-run link-skills.sh, install when a lockfile or package.json changed, build packages/* when one with a dist changed, restart the ops jobs whose source changed, then roll the Dashboard to the newest build: Building, Switching, then Updated to <sha7> or Failed: <reason>; --to moves the checkout to that release instead, back or on, and leaves the Dashboard as it is
playground doctor     one line per need, as ok, MISSING with its fix, or optional: the tools, the data folder, the pinned herdr, the links into this checkout, the release it is at, and each ops job launchd should hold
playground herdr pin [--check | --asset <file>]
                      put the pinned herdr's release asset for this Mac at the data folder's bin/herdr, after checking its SHA-256 against the pin, refusing a mismatch with both sums; --check reads the copy alone, exit 1 when it is missing or changed; --asset installs from a file instead of downloading
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
playground wa send <file>
                      send the reply in <file>, named by its absolute path, to the owner's WhatsApp through ops-wa, the one way any session writes there; it refuses a body holding a token shape (bun run wa)
playground wa relink
                      after WhatsApp logged out the linked device, set the old link aside so ops-wa's next start posts a new pairing card (bun run wa)
playground accounts list | add --provider claude --email <email> [--label <label>] | add --provider glm --label <label> | remove <email|label>
                      the accounts the factory spends, each a usage.accounts row with its secret in the Keychain: list each with whether its secret is kept and its last 5-hour and week reading; add a Claude account by running claude setup-token here, then pasting the token it prints, or a GLM key pasted under its label, neither echoed; remove one's row and its Keychain item
playground yard login | logout | channels | read <channel> | post <channel> <text> [--kind <kind>]
                      this Mac's Yard (YARD_API_URL in your environment or the live dashboard checkout's .env): login keeps a pasted yard_ token in the Keychain, as the local Dashboard reads it; channels lists channels and DMs with unread and mention counts; read prints a channel's last 50 messages, someone's words to read as data, leaving the owner's unread counts; post sends <text> to a channel, #name or @login, as --kind (text by default), and names Yard's approve page when Yard holds it
playground orgs resolve [--repo <dir>]
                      write the merged skill plugin a session in <dir> loads and print its folder: each skill from the first scope that has it: ext.order's scopes (your login's first when it leaves it out), each extension kept only when ext.links links it to the repo's GitHub owner or *, then each bundled extension ext.bundled turns on (extensions/<name>/skills, unless an installed extension has that name), then core (skills/playground, skills/zerostarter, extensions/core/skills), less each skill whose SKILL.md <dir>'s own .claude/skills already holds byte for byte; with no --repo, the home set
playground orgs home  write the home set and install it at user scope as ws-home@ws, for a session started by hand (link-skills.sh runs it)
playground rm <path> [--reason "<why>"] | --worktree <path> [--discard [--decision <id>]] [--pr <url>] [--reason "<why>"] | --list | --restore <id>
                      move a path into the trash (the data folder's trash/<UTC-ts>-<session>/<n>/, with a manifest.jsonl line), where it stays 7 days, sooner when the disk has under 50 GB free, its node_modules and web/next/.next stripped, which an install or a build rebuilds; refuse a protected path (HOME and the folders that hold it, ~/.ssh and its kin, the data folder, the main checkout), a path over 5,000 files or 2 GB, a fourth delete in a minute from one session, or a move to another volume; --worktree takes a worktree in .claude/worktrees that no live session holds (a roster row naming its branch or its PR's number holds it no more once that PR has merged or closed and the worktree sits at its head, which it prints as freed; commits past it keep the hold, named with them), with no uncommitted change and its work landed on canary (--discard lets those two go, which a session (PLAYGROUND_ROLE set, or a claude process above it) or a call whose parent is pid 1 or unreadable passes once the worktree's PR (--pr's, else its branch's) has merged or closed, else only with --decision <id>, an approved Inbox delete decision naming the path; --pr <url> names the PR whose session used it, so another session of that PR holds it by that PR's number no more), and prunes it from git; --list prints what the trash holds and --restore puts one item back
playground rules [<name>]
                      the standing rules a factory session starts with, each by its glance line, or one rule whole, with this machine's values in its slots
playground settings list | get <key> [--org <org>] | why <key> | set <key> <value> --reason "<why>" [--scope <scope>] | reset <key> --reason "<why>" [--scope <scope>]
                      read or change a setting in the extensions folder, each write one commit with its reason (an org's scope or your login's, your login's by default)
playground settings import-jobs <jobs.json> [--launch-agents <dir>] [--scope <scope>] [--dry-run]
                      once, at the switch: each ops job jobs.json lists becomes its jobs.<name> setting (your login's scope by default), a launchd job's program read from its plist; a job the registry does not know stays in jobs.json
playground ext which <skill> [--repo <dir>]
                      print the folder of the copy of <skill> a session in <dir> loads, from whichever scope holds it
playground ext init [--yes | --dry-run] | add <name> [<owner/name>] [--yes] | order | link | unlink | remove | sync [<scope>] | list | show | put | why | diff | search | export <dir> | import <dir> [--dry-run] | import --from-tree <dir> | import-scripts <ops-dir> <job>... --org <org> | score | accept | reject | check-modes
                      make (on your yes, typed or --yes) or reuse your private repo and clone your login's folder from it, sync each scope with its repo now, read the extensions, put an item's next revision from a file, a folder or stdin with its reason and attachments as one commit in its scope, search them, export or import every scope as a folder of clones, seed the guards' lists from a folder of list files, bring each job folder in as an org's script once at the switch, score, accept or reject a proposal, and list once the stored scripts that lost their executable bit
playground migrate --archive <checkout> --pre-squash <sha> --org <org> [--old <rev>] [--dry-run]
                      once, at the switch: move the old data folder in ~/.claude to ~/.playground, seed your login's settings and the release owners' list from the archive checkout (its canary, or --old, and the pre-squash head), bring the hand-made skills into the org's scope unless its clone holds them, then, with the Dashboard's job stopped, make each move the migration table at the pre-squash head lists: renamed and dropped jobs, archived stale copies, moved state files, and renamed variables in your profiles and LaunchAgents, and last runs playground herdr pin; a value already set is left
playground uninstall [--purge]
                      remove the LaunchAgents that run from this checkout or the data folder, stop the Dashboard's stack and remove every link into this checkout; --purge also removes the Dashboard's database and moves the data folder aside to <data folder>-purged-<UTC time>, after asking
playground add [--kind worker|runner] [<name>] [--title "<title>"] [--brief <file>] [--model <id>] [--backend glm|claude]
                      start a worker (or a runner) through spawn.sh, under the name given or one bun run name picks, on handoffs/new-worker.md by default; a worker needs --title, a plain title of up to 40 characters, and a runner takes its name and no --title
playground add --dispatcher --backend glm
                      start a second dispatcher on GLM
playground alerts-wait <name>
                      for a manager's background task: wait for the next stuck alert addressed to <name>, print it and exit, so it wakes without waiting on the relay
playground picker <session> allow <key> | deny <key> "<reason>"
                      as the session's manager, answer the permission prompt its stuck alert named by key: allow presses Yes once, deny presses No and sends the session the reason; each answer is a line in ops/picker.log`

// The package scripts playground runs as its own verbs.
export const VERBS = ["ask", "changelog", "dm", "ingest", "queues", "thread", "wa"]

// playground <verb> runs the package script of that name in the Dashboard's checkout, words and all.
export const verbArgv = (verb: string, words: string[]): string[] => ["run", verb, ...words]

export const VIEW_HINT = "Sessions: playground view opens them in herdr"

// Bare playground: herdr first, since the sessions run there; a herdr failure is shown, the Dashboard's steps still run, and either failing exits 1.
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
  "ext order": "rest",
  "ext put": 4,
  "ext reject": 4,
  "ext remove": 1,
  "ext score": 5,
  "ext search": "rest",
  "ext show": 3,
  "ext sync": 1,
  "ext unlink": 2,
  "ext which": 1,
  "ext why": 3,
  focus: 0,
  "focus off": 0,
  "focus on": 0,
  "herdr pin": "rest",
  "herdr stop": 0,
  migrate: 0,
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
  rm: "rest",
  rules: 1,
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

// Why a command's words are refused, or null: a word past what WORDS gives its command or subcommand, with its usage; then the shapes uninstall, update, sweep and alerts-wait take.
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
    else if (["--backend", "--brief", "--kind", "--manager", "--model", "--title"].includes(arg)) {
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
    return { error: `--backend takes claude or glm, not ${backend}` }
  const passed = [...(model ? ["--model", model] : []), ...(backend ? ["--backend", backend] : [])]

  const kind = options["--kind"]
  const title = options["--title"]
  if (kind !== undefined && !KINDS.includes(kind))
    return { error: `--kind takes worker or runner, not ${kind}` }

  if (dispatcher) {
    if (
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
  | { done: string; ok: boolean }

// Where the dashboard's supervisor is in the roll `playground update` asked for, from the lines its log and results log gained since. A failed roll goes back to the build before, and is done once that FALLBACK lands, unless it ran a migration or its build failed before the stop.
export const rollOutcome = (log: string[], results: string[]): RollOutcome => {
  let failed: string | undefined
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
          done: `Failed: ${failed}; ${back[2] === "PASS" ? `back on ${back[1]}` : `going back to ${back[1]} failed too`}`,
          ok: false,
        }
      continue
    }
    const current = line.match(/^\S+ CURRENT (\w+)/)
    if (current) return { done: `Already up to date at ${current[1]}`, ok: true }
    const refused = line.match(/^\S+ (?:SKIP \w+ FAIL|ANOMALY) (.*)$/)
    if (refused) return { done: `Failed: ${refused[1]}`, ok: false }
    const roll = line.match(/^\S+ ROLL (.*?) (\w+) (PASS|FAIL)(?: (.*))?$/)
    if (roll?.[3] === "PASS") return { done: `Updated to ${roll[2]}`, ok: true }
    if (!roll) continue
    failed = roll[4] || "the roll failed"
    // a build that failed before the stop stopped nothing, so no fallback follows
    if (failed.startsWith("build before the stop:")) return { done: `Failed: ${failed}`, ok: false }
    if (/\bmigrate\b/.test(roll[1]))
      return {
        done: `Failed: ${failed}; it changed the database, so the Dashboard stays on ${roll[2]}`,
        ok: false,
      }
  }
  if (failed !== undefined) return { phase: "going back" }
  // the supervisor builds the head after its roll-now line, before it stops the Dashboard or, for a head that migrates, after, so the roll reads as building until the head is built, or starts on a build it kept, and only then as switching
  const rolling = log.findIndex((line) => line.includes("roll-now: rolling to"))
  const starting = log.findIndex(
    (line, at) => at > rolling && / (built \w+ in |dev started)/.test(line),
  )
  return { phase: rolling >= 0 && starting > rolling ? "switching" : "building" }
}

// ops-dashboard's heartbeat as read at one poll: its age, its cycle and whether its pid is alive.
export type DashboardBeat = { ageMs: number; cycleSeconds: number; running: boolean }
type WaitRead = { api: boolean; beat: DashboardBeat | null; failure: string | null; now: number }
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

// One poll of the wait for the Dashboard's API after the jobs step: done once it answers, once the supervisor's results name why its stack did not start, once ops-dashboard's supervisor is gone or its heartbeat stale, or at 15 minutes; else a progress line at most every 10s.
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
    if (!beat?.running)
      return {
        done: `ops-dashboard's supervisor is not running, so the Dashboard will not come up (waited ${duration(spent)}); ${AGAIN}`,
        ok: false,
      }
    if (staleBeat(beat))
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
