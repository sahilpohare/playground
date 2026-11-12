import { afterAll } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { GUARD_LISTS, loginPath } from "../../packages/settings/src/rendered"
import { OLD_NAMES } from "../session-names"
import { storeWith } from "./hooks/render-set"

// spawn.sh's fakes and its spawn() for the spawn*.test.ts files, split so the parallel pass spreads them; test-sandbox's --parallel loads this afresh for each file, so the afterAll is that file's own
export const root = join(import.meta.dir, "..", "..")

// The guard lists the checkout ships, by file name: a store a case seeds holds them, as a render of a fresh machine does, since a guard fails closed on an extensions root that lacks its list.
const CHECKOUT_LISTS = Object.fromEntries(
  GUARD_LISTS.flatMap((name) => {
    const path = join(root, "extensions", "core", "lists", `${name}.json`)
    return existsSync(path) ? [[`${name}.json`, readFileSync(path, "utf8")]] : []
  }),
)
export const script = join(root, "scripts", "spawn.sh")
export const scratch = mkdtempSync(join(tmpdir(), "spawn-sh-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

export const LSTART = "Tue Oct 13 04:43:59 2026"

// Fake cmux (which spawn.sh never calls), ps, sysctl, uptime and bun on PATH, each logging what it was asked; bun fakes spawn.sh's roster write alone.
export const bin = join(scratch, "bin")
const sharedOrgs = join(scratch, "orgs")
mkdirSync(sharedOrgs, { recursive: true })
mkdirSync(bin)
export const fake = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
fake("cmux", `printf '%s\\n' "$@" > "$HOME/cmux.args"`)
fake(
  "ps",
  `[ -n "$FAKE_PS_BROKEN" ] && exit 1
while [ $# -gt 0 ]; do [ "$1" = -p ] && pids=$2; shift; done
for pid in \${pids//,/ }; do
  case " $FAKE_DEAD " in *" $pid "*) continue ;; esac
  printf '%5s %s\\n' "$pid" "$FAKE_LSTART"
done
exit 0`,
)
// A fake Keychain: it holds an item unless FAKE_NO_ITEM, and gives TOKEN for -w (nothing when FAKE_EMPTY_TOKEN is set), so a leak would show.
export const TOKEN = "sk-ant-oat-fake-token"
fake(
  "security",
  `printf '%s\\n' "$*" >> "$HOME/security.args"
[ -n "$FAKE_NO_ITEM" ] && exit 44
case " $* " in *" -w "*) [ -n "$FAKE_EMPTY_TOKEN" ] || echo "${TOKEN}" ;; *) echo 'keychain: "/fake.keychain-db"' ;; esac
exit 0`,
)
// A leads worktree's install, bun install <args>: the args as one line to bun-install.log, failing as a frozen lockfile does under FAKE_INSTALL_FAIL. The roster write, bun <checkout>/scripts/roster.ts <args>: the script's path to roster.script, the args one a line to roster.args and as one line to roster.log. A read, roster.ts who, and the data folder's and a setting's reads (bun --no-env-file) run the real bun, but the skill resolver, orgs.ts, the settings reader, setting.ts, and playground's cli.ts run from this checkout, since a case's copy of spawn.sh sits in a scratch checkout without them.
fake(
  "bun",
  `[ "$1" = install ] && { printf '%s\\n' "$*" >> "$HOME/bun-install.log"; [ -z "$FAKE_INSTALL_FAIL" ] || { echo "error: lockfile had changes, but lockfile is frozen"; exit 1; }; exit 0; }
case "$2" in */playground/orgs.ts) exec "${process.execPath}" "$1" "${join(root, "packages", "scripts", "src", "playground", "orgs.ts")}" "\${@:3}" ;; esac
case "$2" in */playground/cli.ts) exec "${process.execPath}" "$1" "${join(root, "packages", "scripts", "src", "playground", "cli.ts")}" "\${@:3}" ;; esac
case "$1" in */setting.ts) shift; exec "${process.execPath}" "${join(root, "packages", "scripts", "src", "playground", "setting.ts")}" "$@" ;; esac
[ "$2" = who ] || [ "$1" = --no-env-file ] && exec "${process.execPath}" "$@"
printf '%s' "$1" > "$HOME/roster.script"
shift
printf '%s\\n' "$*" >> "$HOME/roster.log"
(IFS=$'\\n'; printf '%s' "$*") > "$HOME/roster.args"
[ -n "$FAKE_ROSTER_BROKEN" ] && { echo "roster broken" >&2; exit 1; }
exit 0`,
)
// The launch file runs claude once its pane starts, which only the self-removal test does; the fake logs and stops there.
fake(
  "claude",
  `printf '%s\\n' "$*" >> "$HOME/claude.args"
exit 0`,
)
fake(
  "sysctl",
  // spawn.sh always reads with -n, so the name is $2.
  `[ -n "$FAKE_SYSCTL_BROKEN" ] && exit 1
[ -n "$FAKE_SYSCTL_SANDBOXED" ] && { echo "sysctl: sysctl fmt -1 1024 1: Operation not permitted" >&2; exit 1; }
[ "$1" = -n ] || exit 1
case "$2" in
  vm.loadavg) echo "{ \${FAKE_LOAD1:-1.00} \${FAKE_LOAD5:-2.00} 3.00 }" ;;
  hw.ncpu) echo "\${FAKE_NCPU:-15}" ;;
  kern.memorystatus_vm_pressure_level) echo "\${FAKE_PRESSURE:-1}" ;;
  kern.memorystatus_level) echo "\${FAKE_FREE:-50}" ;;
  *) exit 1 ;;
esac`,
)
// The CPU read, top -l 2 -n 0, which run-slot's gauges take and spawn.sh does not: each call logged to top.calls, idle at FAKE_CPU_IDLE (0 by default).
fake(
  "top",
  `echo "$*" >> "$HOME/top.calls"
echo "CPU usage: 30.00% user, 20.00% sys, 50.00% idle"
echo "CPU usage: 60.00% user, 40.00% sys, \${FAKE_CPU_IDLE:-0.00}% idle"`,
)
// The load read where sysctl is refused, uptime: the line it prints inside Claude Code's sandbox, which drops the up field, at FAKE_LOAD1 and FAKE_LOAD5 as the sysctl fake gives them.
fake(
  "uptime",
  `[ -n "$FAKE_UPTIME_BROKEN" ] && exit 1
echo "22:15  2 users, load averages: \${FAKE_LOAD1:-1.00} \${FAKE_LOAD5:-2.00} 3.00"`,
)
// The swap-in read, vm_stat -c 2 1: its first row the totals since boot, its second the last second's, swap-ins at FAKE_SWAPINS (0 by default).
fake(
  "vm_stat",
  `[ -n "$FAKE_VMSTAT_BROKEN" ] && exit 1
echo "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
echo "    free  pageins  pageout  swapins swapouts"
echo "    8023  346118K   502178  9966113 12153731"
echo "    7698      542        0  \${FAKE_SWAPINS:-0}        0"`,
)
// grep as it is, but a resume's name check over a folder's transcripts, its one call naming customTitle, is logged to grep.calls first, so a case sees whether that read ran.
fake(
  "grep",
  `case "$*" in *customTitle*) printf '%s\\n' "$*" >> "$HOME/grep.calls" ;; esac
exec /usr/bin/grep "$@"`,
)

export let homes = 0
// A brief's text, which must never reach herdr's argv, the roster or the output.
export const BRIEF_TEXT = "secret-handoff-text"
export type Session = { name?: string; pid: number; procStart?: string; raw?: string }
// The factory's settings as link-skills.sh links them, which every launch rebuilds into its own file with the factory's one compact window.
export const FACTORY_SETTINGS = {
  autoCompactWindow: 400000,
  autoMemoryEnabled: false,
  env: { KEEP: "1" },
  hooks: {
    PreToolUse: [{ hooks: [{ command: "no-env-dump", type: "command" }], matcher: "Bash" }],
  },
  skipDangerousModePermissionPrompt: true,
}

// Healthy usage readings, one per backend, which a test replaces with raw JSON of its own to opt a refusal in.
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
export const usage = (over: object = {}) => ({
  account: "quilla@example.org",
  rate_limits: {
    // epoch seconds, what the real usage.json holds; an ISO string reads too (the cap and pace cases pass one).
    five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3_600 },
    seven_day: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 5 * 86_400 },
  },
  writtenAt: new Date().toISOString(),
  ...over,
})
export const beat = (over: object = {}) => ({
  cycleSeconds: 300,
  job: "ops-zai-usage",
  lastBeatAt: minutesAgo(1),
  lastResult: "ok",
  pid: 1,
  startedAt: minutesAgo(30),
  ...over,
})
// The meter's file (ops-zai-usage/sync.ts): the plan's credit windows, Max's 28k a 5 hours and 140k a week.
export const zai = (fiveHourUsed: number, weekUsed: number) => ({
  windows: {
    fiveHour: {
      cap: 28000,
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      used: fiveHourUsed,
    },
    week: {
      cap: 140000,
      resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      used: weekUsed,
    },
  },
  writtenAt: new Date().toISOString(),
})

// The options spawn.sh reads a value after, so a word after one is that value, not the mode's.
const VALUED = [
  "--account",
  "--backend",
  "--brief",
  "--effort",
  "--model",
  "--pr",
  "--reports-to",
  "--runtime",
  "--title",
]
// Where each start mode takes its brief among its words, the mode first.
export const BRIEF_AT: Record<string, number> = {
  column: 5,
  manager: 2,
  probe: 3,
  runner: 2,
  worker: 2,
}
// A session named <name> that ran in <dir>: a transcript in the project folder Claude Code names from the folder's real path.
export const projectOf = (dir: string) =>
  (existsSync(dir) ? realpathSync(dir) : dir).replace(/[^A-Za-z0-9]/g, "-")
export const ranIn = (
  config: string,
  dir: string,
  name: string,
  file = "a1b2c3d4-0000-4000-8000-000000000001",
) => {
  const folder = join(config, "projects", projectOf(dir))
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `${file}.jsonl`),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n${JSON.stringify({ type: "custom-title", customTitle: name, sessionId: file })}\n${JSON.stringify({ type: "agent-name", agentName: name, sessionId: file })}\n`,
  )
}

export async function spawn(
  args: string[],
  sessions: Session[],
  env: Record<string, string> = {},
  path = script,
  pin?: { name: string; backend: string },
  setup?: (home: string) => void,
) {
  const home = join(scratch, `home-${++homes}`)
  // A word or an env value may name a path inside this run's own home, which is made only here.
  args = args.map((word) => word.replaceAll("{home}", home))
  env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replaceAll("{home}", home)]))
  const registry = join(home, ".claude", "sessions")
  mkdirSync(join(home, ".playground"), { recursive: true })
  if (pin) {
    mkdirSync(join(home, ".playground", "backends"), { recursive: true })
    writeFileSync(join(home, ".playground", "backends", pin.name), `${pin.backend}\n`)
  }
  if (!env.NO_REGISTRY) mkdirSync(registry, { recursive: true })
  // The leads worktree a manager opens in, installed with the mark a finished install leaves, which NO_LEADS leaves off, as on a Mac that has not made it.
  if (!env.NO_LEADS) {
    const modules = join(home, "code", "factory", ".claude", "worktrees", "leads", "node_modules")
    mkdirSync(modules, { recursive: true })
    writeFileSync(join(modules, ".playground-installed"), "")
  }
  // The roster as earlier sessions left it, which a title default reads before it writes.
  if (env.ROSTER_JSON !== undefined)
    writeFileSync(join(home, ".playground", "roster.json"), env.ROSTER_JSON)
  // The managers' old names, which a machine past the switch holds as sessions.aliases (NO_ALIASES leaves them off, as on a fresh install), its one GLM key's row (NO_GLM_ROW leaves it off), then the case's own SETTINGS_JSON.
  const settings = {
    ...(env.NO_ALIASES ? {} : { "sessions.aliases": OLD_NAMES }),
    ...(env.NO_GLM_ROW ? {} : { "usage.accounts": [{ label: "zai", provider: "glm" }] }),
    ...(env.SETTINGS_JSON ? JSON.parse(env.SETTINGS_JSON) : {}),
  }
  if (!env.PLAYGROUND_DATA_DIR && Object.keys(settings).length) {
    storeWith(join(home, ".playground"), CHECKOUT_LISTS, settings)
    // A machine with extensions has the login ext init wrote, which the skill resolver reads first.
    writeFileSync(loginPath(join(home, ".playground")), "tester\n")
  }
  if (!env.NO_FACTORY_SETTINGS) {
    writeFileSync(
      join(home, ".playground", "factory-settings.json"),
      JSON.stringify(FACTORY_SETTINGS),
    )
  }
  // The gate reads both backends' usage, so every test starts from healthy files and opts a refusal in;
  // a fixture of "absent" leaves the file off, as it is on a machine the meter has not reached.
  const acme = join(home, ".playground")
  mkdirSync(join(acme, "ops"), { recursive: true })
  // The skill plugin the resolver writes for each launch is named by what it holds, so every case's orgs folder is one shared folder and the checkout's skills are copied once.
  symlinkSync(sharedOrgs, join(home, ".playground", "orgs"))
  const file = (name: string, raw: string | undefined, good: object) => {
    if (raw === "absent") return
    writeFileSync(join(acme, name), raw ?? JSON.stringify(good))
  }
  file("usage.json", env.USAGE_JSON, usage())
  file("zai-usage.json", env.ZAI_USAGE_JSON, zai(1400, 7000))
  file(join("ops", "ops-zai-usage.json"), env.ZAI_HEARTBEAT_JSON, beat())
  if (env.CAPACITY_JSONL !== undefined)
    writeFileSync(join(acme, "ops", "capacity.jsonl"), env.CAPACITY_JSONL)
  // The week-pace override the dispatcher writes; unset leaves the file off, as it is on most days.
  if (env.PACE_OFF_UNTIL !== undefined)
    writeFileSync(join(acme, "usage-pace-off-until"), env.PACE_OFF_UNTIL)
  // Claude Code's own config, which names this machine's login: ~/.claude.json, or the config folder's with CONFIG_DIR_CLAUDE_JSON.
  if (env.CLAUDE_JSON !== undefined) writeFileSync(join(home, ".claude.json"), env.CLAUDE_JSON)
  if (env.CONFIG_DIR_CLAUDE_JSON !== undefined)
    writeFileSync(join(home, ".claude", ".claude.json"), env.CONFIG_DIR_CLAUDE_JSON)
  if (env.BRIEF_FILE) {
    const brief = join(home, ".playground", env.BRIEF_FILE)
    mkdirSync(dirname(brief), { recursive: true })
    writeFileSync(brief, `${BRIEF_TEXT}\n`)
  }
  if (env.RUSH) writeFileSync(join(acme, "brief-rush.md"), "rush")
  if (env.INSCOPE_HOOK) {
    mkdirSync(join(home, ".config", "inscope"), { recursive: true })
    writeFileSync(join(home, ".config", "inscope", "inscope.zsh"), env.INSCOPE_HOOK)
  }
  for (const s of sessions) {
    writeFileSync(
      join(registry, `${s.pid}.json`),
      s.raw ??
        JSON.stringify({
          name: s.name,
          pid: s.pid,
          procStart: s.procStart ?? LSTART,
          status: "idle",
        }),
    )
  }
  // A resume with no id finds its session by name in its folder's transcripts, as Claude's picker does, and herdr resumes an id only once
  // its transcript exists, so each case's session has run there unless NO_SESSION_TRANSCRIPT says it never did.
  const words = args.filter(
    (word, i) => !word.startsWith("--") && !VALUED.includes(args[i - 1] ?? ""),
  )
  const [mode, name, dir, id] = words
  // A start refuses a brief that is not a file, so each case's brief exists unless NO_BRIEF_FILE leaves it off.
  const brief = words[BRIEF_AT[mode ?? ""] ?? -1]
  if (brief && /^[^/~]/.test(brief) && !`/${brief}/`.includes("/../") && !env.NO_BRIEF_FILE) {
    mkdirSync(dirname(join(acme, brief)), { recursive: true })
    writeFileSync(join(acme, brief), `${BRIEF_TEXT}\n`)
  }
  if (mode === "resume" && name && dir && !env.NO_SESSION_TRANSCRIPT)
    for (const config of new Set([
      join(home, ".claude"),
      env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    ]))
      ranIn(config, dir, name, id)
  // Every case runs in herdr, the one runtime spawn.sh starts in, so each home holds the fake herdr's pin; a case's own setup replaces it.
  herdrPin()(home)
  // SCRATCH_DATA runs the case on a scratch data folder, as a run beside the live one does: the seeded folder moves out of the home's .playground, and PLAYGROUND_DATA_DIR names it.
  if (env.SCRATCH_DATA) {
    renameSync(join(home, ".playground"), join(home, "scratch-data"))
    env = { ...env, PLAYGROUND_DATA_DIR: join(home, "scratch-data") }
  }
  setup?.(home)
  // a worker or checker starts with a title, so each case gives one unless it names its own or NO_TITLE leaves it off.
  const titled =
    mode?.startsWith("worker") || (mode === "column" && ["reviewer", "tester"].includes(name ?? ""))
  const title =
    titled && !args.includes("--title") && !env.NO_TITLE ? ["--title", "Plain test work"] : []
  const proc = Bun.spawn(["bash", path, ...title, ...args], {
    env: {
      FAKE_LSTART: LSTART,
      HOME: home,
      PLAYGROUND_REPO: join(home, "code", "factory"),
      PATH: `${bin}:${process.env.PATH}`,
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  const code = await proc.exited
  const read = async (file: string) => {
    const f = Bun.file(join(home, file))
    return (await f.exists()) ? (await f.text()).split("\n") : undefined
  }
  return {
    cmux: await read("cmux.args"),
    code,
    err: await new Response(proc.stderr).text(),
    home,
    out: await new Response(proc.stdout).text(),
    roster: await read("roster.args"),
    rosterScript: (await read("roster.script"))?.[0],
    rosterLog: (await read("roster.log"))?.filter(Boolean),
    rosterAtClose: (await read("roster-at-close.log"))?.filter(Boolean),
    rosterAtRun: (await read("roster-at-run.log"))?.filter(Boolean),
    security: (await read("security.args"))?.filter(Boolean),
  }
}
export type Spawned = Awaited<ReturnType<typeof spawn>>
// A usage.json whose week is at week%, its 5-hour window at fiveHour%, daysIn days into the week.
export const weekAt = (week: number, fiveHour = 10, daysIn = 2) =>
  JSON.stringify(
    usage({
      rate_limits: {
        five_hour: {
          used_percentage: fiveHour,
          resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        seven_day: {
          used_percentage: week,
          resets_at: new Date(Date.now() + (7 - daysIn) * 86_400_000).toISOString(),
        },
      },
    }),
  )
// A whole-second time a day out, for usage-pace-off-until, and the UTC form a pass line names.
export const offUntil = new Date(Math.floor(Date.now() / 1000 + 86_400) * 1000)
export const offUntilUtc = `${offUntil.toISOString().slice(0, 19)}Z`
// The capacity gate's log of a spawn's home, one verdict a line.
export const capacityLog = (r: { home: string }) =>
  (readFileSync(join(r.home, ".playground", "ops", "capacity.jsonl"), "utf8") || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

// The typed line names a launch file (macOS types at most 1,024 bytes into a pane), so what the launch holds is the file's text. Each spawn runs in a home of its own, so its launch folder holds the one file.
export const launchOf = (r: { home: string }): string => {
  const dir = join(r.home, ".playground", "launch")
  return readFileSync(join(dir, readdirSync(dir)[0] ?? ""), "utf8")
}
// The launch's command, the text after its PLAYGROUND_REPO export, less a start's --session-id, which the herdr cases read on their own.
export const launchAfterRm = (r: { home: string }): string => {
  const lines = launchOf(r).split("\n")
  return lines
    .slice(lines.findIndex((l) => l.startsWith("export PLAYGROUND_REPO=")) + 1)
    .join("\n")
    .replace(/ --session-id [0-9a-f-]{36}(?= -n )/, "")
}
// A launch less its --plugin-dir, whose folder is named by the skills it holds; the skill set's own case reads it.
export const unplugged = (line: string): string => line.replace(/ --plugin-dir \S+/, "")
// The line herdr's pane run types into the pane.
export const typed = (r: { home: string }): string =>
  placing(r).find((c) => c[0] === "pane" && c[1] === "run")?.[3] ?? ""
// Where a start opened: herdr's workspace create, or a column's pane split.
export const opened = (r: { home: string }) =>
  placing(r).find(
    (c) => c.join(" ").startsWith("workspace create") || c.join(" ").startsWith("pane split"),
  )
// The pane's shell runs the typed line, which execs the launch file, so a run of it here shows what the pane runs.
export const paneRun = async (
  r: Awaited<ReturnType<typeof spawn>>,
  env: Record<string, string> = {},
) => {
  const pane = Bun.spawn(["zsh", "-c", typed(r)], {
    env: { HOME: r.home, PATH: `${bin}:${process.env.PATH}`, ...env },
    stderr: "pipe",
    stdout: "pipe",
  })
  const code = await pane.exited
  return {
    code,
    err: await new Response(pane.stderr).text(),
    out: await new Response(pane.stdout).text(),
  }
}

export const others = (n: number, from = 1000): Session[] =>
  Array.from({ length: n }, (_, k) => ({ name: `reviewer-x-${k}`, pid: from + k }))
export const workers = (n: number, from = 2000): Session[] =>
  Array.from({ length: n }, (_, k) => ({ name: `worker-w-${k}`, pid: from + k }))

// A fake herdr at the path its pin names: it logs each call as one line of words each ended by a unit separator, answers placement as herdr 0.9.5 does, and shows the screens FAKE_SCREENS lists (trust, trustcut, mcp, mcpother, mcpmany, mcpmanyother, mcpplugin, mcpseven, mcpsevenother, mcpstatus, cut, bare, blank, ready) one row per wait, each matched against the wait's regex, and a picker's whole screen to a read, its pointer moved by the keys sent since, FAKE_LOST_KEY naming one herdr dropped.
const herdrBin = join(bin, "herdr-fake")
writeFileSync(
  herdrBin,
  `#!/bin/bash
printf '%s\\037' "$@" >> "$HOME/herdr.calls"; echo >> "$HOME/herdr.calls"
echo "$HERDR_SESSION $HERDR_SOCKET_PATH $HERDR_CONFIG_PATH" > "$HOME/herdr.env"
# a spawn.sh close of the named session landing during this call, which ends its roster row
ends() {
  python3 -I -c 'import json, sys
p = sys.argv[1]
r = json.load(open(p))
for a in r["agents"]:
    if a.get("name") == sys.argv[2]:
        a["status"] = "ended"
json.dump(r, open(p, "w"))' "$HOME/.playground/roster.json" "$1"
}
case "$1 \${2:-}" in
  "--version "*) echo "herdr \${FAKE_HERDR_VERSION:-0.9.5}" ;;
  "status server") [ -n "$FAKE_HERDR_DOWN" ] && echo '{"running":false}' || echo '{"running":true}' ;;
  "workspace create")
    [ -z "$FAKE_HERDR_CREATE_FAIL" ] || { echo "error: workspace limit reached" >&2; exit 1; }
    echo '{"result":{"root_pane":{"pane_id":"w5:p1","workspace_id":"w5"}}}' ;;
  "pane split")
    [ -z "$FAKE_HERDR_SPLIT_FAIL" ] || { echo "error: pane w1:p2 not found" >&2; exit 1; }
    echo '{"result":{"pane":{"pane_id":"w1:p7","workspace_id":"w1"}}}' ;;
  "pane list")
    [ -z "$FAKE_HERDR_LIST_FAIL" ] || exit 1
    [ -z "$FAKE_HERDR_LIST_ENDS" ] || ends "$FAKE_HERDR_LIST_ENDS"
    cat "$HOME/herdr.panes" 2>/dev/null || echo '{"result":{"panes":[]}}' ;;
  "pane rename")
    [ -z "$FAKE_HERDR_RENAME_EATS" ] || rm -f "$HOME"/.playground/launch/*.herdr
    [ -z "$FAKE_HERDR_RENAME_FAIL" ] || { echo "error: label taken" >&2; exit 1; } ;;
  "pane close")
    # the roster writes made before the pane closes, which a restore running beside the close reads
    cp "$HOME/roster.log" "$HOME/roster-at-close.log" 2>/dev/null || : > "$HOME/roster-at-close.log"
    [ -z "$FAKE_HERDR_CLOSE_FAIL" ] || { echo "error: pane w2:p3 not found" >&2; exit 1; } ;;
  "pane run")
    # the roster writes made before the session's launch runs, which a checker's first tool call reads
    cp "$HOME/roster.log" "$HOME/roster-at-run.log" 2>/dev/null || : > "$HOME/roster-at-run.log"
    [ -z "$FAKE_HERDR_RUN_ENDS" ] || ends "$FAKE_HERDR_RUN_ENDS"
    [ -z "$FAKE_HERDR_RUN_SAYS" ] || { echo "$FAKE_HERDR_RUN_SAYS" >&2; exit 1; }
    [ -z "$FAKE_HERDR_RUN_FAIL" ] || exit 1 ;;
  "pane wait-output")
    n=$(cat "$HOME/herdr.screen" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$HOME/herdr.screen"
    IFS=, read -ra screens <<<"\${FAKE_SCREENS:-ready}"
    case "\${screens[$n]:-ready}" in
      trust) l="❯ 1. Yes, I trust this folder" ;;
      trustcut) l="❯ 1. Yes, I trust" ;;
      mcp) l="New MCP server found in this project: fs" ;;
      mcpother) l="New MCP server found in this project: evil" ;;
      mcpmany | mcpmanyother | mcpplugin) l="2 new MCP servers found in this project" ;;
      mcpseven | mcpsevenother) l="7 new MCP servers found in this project" ;;
      mcpstatus) l="⏵⏵ bypass permissions on · 1 MCP server failed" ;;
      cut) l="⏵⏵ bypass permissions" ;;
      bare) l="⏵⏵" ;;
      blank) l="❯" ;;
      *) l="⏵⏵ bypass permissions on (shift+tab to cycle)" ;;
    esac
    # herdr matches the regex against one screen row at a time, so a row it does not match times out
    [[ $l =~ $5 ]] || { echo '{"error":{"code":"timeout","message":"timed out waiting for output match"}}'; exit 1; }
    printf '{"result":{"matched_line":"%s"}}\\n' "$l" ;;
  "pane read")
    n=$(( $(cat "$HOME/herdr.screen" 2>/dev/null || echo 1) - 1 ))
    IFS=, read -ra screens <<<"\${FAKE_SCREENS:-ready}"
    one= many=
    case "\${screens[$n]:-ready}" in
      mcp) one=fs ;;
      mcpother) one=evil ;;
      mcpmany) many="fs|git" ;;
      mcpmanyother) many="fs|evil" ;;
      mcpplugin) many="fs|git (from plugin tools)" ;;
      mcpseven) many="fs|git|a|b|c|d|e" ;;
      mcpsevenother) many="fs|git|a|b|c|d|evil" ;;
    esac
    # the keys sent since the screen's wait, less the FAKE_LOST_KEY-th, which herdr dropped
    keys=$(tr '\\037' ' ' < "$HOME/herdr.calls" | awk -v lost="\${FAKE_LOST_KEY:-0}" '$2 == "wait-output" {k = ""; c = 0} $2 == "send-keys" && ++c != lost {k = k " " $4} END {print k}')
    ups=0 downs=0
    for key in $keys; do
      [ "$key" = up ] && ups=$((ups + 1))
      [ "$key" = down ] && downs=$((downs + 1))
    done
    if [ -n "$one" ]; then
      rows=("Use this MCP server" "Use this and all future MCP servers in this project" "Continue without using this MCP server")
      focus=$((2 - ups + downs))
      [ "$focus" -ge 0 ] || focus=0
      [ "$focus" -le 2 ] || focus=2
      printf '%s\\n' "New MCP server found in this project: $one" "MCP servers may execute code or access system resources."
      for i in 0 1 2; do
        [ "$i" = "$focus" ] && p="❯" || p=" "
        printf '%s %s\\n' "$p" "\${rows[$i]}"
      done
    elif [ -n "$many" ]; then
      IFS="|" read -ra names <<<"$many"
      # the picker shows five servers at a time and scrolls with the focus; a down past the last server marks "Enable selected"
      focus=$downs
      [ "$focus" -le "\${#names[@]}" ] || focus=\${#names[@]}
      shown=$((focus < \${#names[@]} ? focus : \${#names[@]} - 1))
      from=$((shown > 4 ? shown - 4 : 0))
      printf '%s\\n' "\${#names[@]} new MCP servers found in this project" "Select any you wish to enable." "MCP servers may execute code or access system resources."
      for ((i = from; i < from + 5 && i < \${#names[@]}; i++)); do
        [ "$i" = "$focus" ] && p="❯" || p=" "
        printf '%s [✔] %s\\n' "$p" "\${names[$i]}"
      done
      [ "$focus" = "\${#names[@]}" ] && echo "❯   Enable selected" || echo "    Enable selected"
    fi ;;
esac
exit 0
`,
)
chmodSync(herdrBin, 0o755)
const herdrSha = new Bun.CryptoHasher("sha256").update(readFileSync(herdrBin)).digest("hex")
export const lw = (home: string, ...parts: string[]) => join(home, ".playground", ...parts)
export const herdrPin =
  (over: object = {}) =>
  (home: string) => {
    mkdirSync(lw(home, "herdr"), { recursive: true })
    writeFileSync(
      lw(home, "herdr", "pin.json"),
      JSON.stringify({ path: herdrBin, sha256: herdrSha, version: "0.9.5", ...over }),
    )
  }
export const herdrCalls = (r: { home: string }): string[][] => {
  const f = join(r.home, "herdr.calls")
  if (!existsSync(f)) return []
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f").slice(0, -1))
}
export const placing = (r: { home: string }) =>
  herdrCalls(r).filter((c) => !["--version", "status"].includes(c[0] ?? ""))
export const resumeFile = (r: { home: string }, name: string) =>
  readFileSync(lw(r.home, "resume", `${name}.sh`), "utf8")
export const SID = /--session-id ([0-9a-f-]{36}) /
// A session's transcript, which Claude Code writes only once the session takes its first message.
// A transcript in the project of the checkout the tests resume in, where the session ran.
export const transcript = (home: string, sid: string) => {
  mkdirSync(join(home, ".claude", "projects", projectOf(root)), { recursive: true })
  writeFileSync(join(home, ".claude", "projects", projectOf(root), `${sid}.jsonl`), "{}\n")
}
export const execLine = (r: { home: string }, name: string) =>
  resumeFile(r, name)
    .split("\n")
    .find((l) => l.startsWith("exec "))
    ?.replace(/^exec \S+\/scripts\/spawn\.sh /, "exec spawn.sh ")

const LANES = ["run-slot", "run-slot-2", "run-slot-3", "run-slot-4"]

// run-slot's state in the case's own home (spawn-fake's mkdtemp scratch): `held` lanes held by this live test process with `units` load units each, and `waiters` live tickets in its queue.
export const slots =
  (held: number, waiters: number, units = 2) =>
  (home: string): void => {
    const ops = join(home, ".playground", "ops")
    for (const lane of LANES.slice(0, held)) {
      mkdirSync(join(ops, lane), { recursive: true })
      writeFileSync(
        join(ops, `${lane}.holder`),
        `worker-held ${process.pid} 2026-11-02T18:00:00Z ${units} medium\n`,
      )
    }
    const queue = join(ops, "run-slot.waiters")
    mkdirSync(queue, { recursive: true })
    for (let i = 0; i < waiters; i++)
      writeFileSync(
        join(queue, `${1_000_000 + i}-${process.pid}-worker-wait${i}`),
        "s2 22 2 medium\n",
      )
  }
