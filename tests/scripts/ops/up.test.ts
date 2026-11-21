import { afterAll, afterEach, expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// the render_jobs harness runs jobs.ts through python, whose import graph (probe.ts's @packages/config/kinds among them) resolves through the built dists no import here reached, so a fresh checkout's render died on "Cannot find module" and its failure log then raised on the ops folder it never made (issue 1496); importing jobs.ts selects those builds
import "../../../packages/scripts/src/playground/jobs"
import { liveBusLines, systemdLog, systemdStandIns } from "../../systemd-stand-ins"

const upPy = join(import.meta.dir, "..", "..", "..", "scripts", "ops", "up.py")
const scratch = mkdtempSync(join(tmpdir(), "ops-up-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// bun first on PATH, behind a launchctl, a systemctl and a loginctl that refuse every call, so a pass's real render can never reach the real launchd or systemd whatever jobs the registry turns on
const fakeBin = join(scratch, "fake-bin")
mkdirSync(fakeBin)
writeFileSync(join(fakeBin, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
systemdStandIns(fakeBin)
const BUN_PATH = `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`
const SYS_PATH = `${fakeBin}:/usr/bin:/bin`
// a runtime folder of the scratch's own, so no systemd call finds the live bus, whatever the shell running the suite has set
const runtime = join(scratch, "run")
mkdirSync(runtime)
const SYSTEMD_ENV = {
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  XDG_RUNTIME_DIR: runtime,
}

// a render on Linux that reached the user's live manager stopped its running ops jobs, so every test fails when a systemd call named /run/user/<uid>
afterEach(() => expect(liveBusLines(systemdLog(fakeBin))).toEqual([]))

// The data folder up.py reads under a config folder: its jobs.json, roster and up.log.
const dataOf = (config: string) => join(config, "playground")

// Loads up.py from the path given first, the opening of every harness below.
const LOAD = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("up", sys.argv[1])
up = importlib.util.module_from_spec(spec)
spec.loader.exec_module(up)
`

// Loads up.py and runs --sessions with every live session's pid alive, outside the factory's folders, and running a claude with no --settings.
const SESSIONS = `${LOAD}up.alive = lambda pid: True
up.covered = lambda cwd: False
up.run = lambda argv, timeout=60: (0, "/Users/me/.bun/bin/claude --resume s")
up.sessions()
`

// --sessions reads the factory rule from kinds.ts alone, so a kind added there reaches it with no Python copy to keep.
test("--sessions names a session of a kind only kinds.ts knows", () => {
  const repo = join(scratch, "kinds-repo")
  const ops = join(repo, "scripts", "ops")
  mkdirSync(ops, { recursive: true })
  for (const file of ["beat.py", "once.py", "ptable.py", "up.py"])
    copyFileSync(join(dirname(upPy), file), join(ops, file))
  const kinds = readFileSync(
    join(dirname(upPy), "..", "..", "packages", "config", "src", "kinds.ts"),
    "utf8",
  )
  const added = kinds
    .replace(/(export const ROSTER_KINDS = \[)/, '$1\n  "auditor",')
    .replace(
      /(export const FACTORY_ROLE_OF_KIND: Record<RosterKind, string> = \{)/,
      '$1\n  auditor: "worker",',
    )
  expect(added.match(/auditor/g)).toHaveLength(2)
  mkdirSync(join(repo, "packages", "config", "src"), { recursive: true })
  writeFileSync(join(repo, "packages", "config", "src", "kinds.ts"), added)
  const config = join(scratch, "kinds-config")
  mkdirSync(join(config, "sessions"), { recursive: true })
  mkdirSync(dataOf(config), { recursive: true })
  writeFileSync(
    join(dataOf(config), "roster.json"),
    JSON.stringify({
      agents: [{ kind: "auditor", name: "a1-audit", status: "working" }],
    }),
  )
  writeFileSync(
    join(config, "sessions", "7001.json"),
    JSON.stringify({
      cwd: "/nowhere",
      name: "a1-audit",
      pid: 7001,
      sessionId: "s-7001",
    }),
  )
  const child = Bun.spawnSync(["python3", "-I", "-c", SESSIONS, join(ops, "up.py")], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: BUN_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  expect(child.stdout.toString()).toContain(
    "a1-audit (pid 7001, /nowhere) runs without the factory's hooks",
  )
})

// Loads up.py and runs main(), every job down; each start is recorded rather than made, and the exit code printed with them.
const EXIT = `${LOAD}started = []
up.healthy = lambda job: (False, "no heartbeat")
up.ptable.table = lambda: {4101: None}
up.once.running = lambda name, marker: None
up.run = lambda argv, timeout=60: (0, "")
up.start = lambda job: started.append(job["name"]) or True
up.herdr = lambda: ("/x/herdr", "")
sys.argv = ["up.py"] + sys.argv[2:]
try:
    up.main()
    code = 0
except SystemExit as e:
    code = e.code
print(json.dumps({"code": code, "started": started}))
`

// Loads up.py and runs main() with one job, every job down, its start recorded within GRACE, its heartbeat pid dead and no heartbeat.startedAt, but boot_time is BOOT, so the grace ends only when the machine booted after the recorded start.
const STARTED_AFTER_BOOT = `${LOAD}import os
started = []
up.healthy = lambda job: (False, "no heartbeat")
up.ptable.table = lambda: {4101: None}
up.once.running = lambda name, marker: None
up.run = lambda argv, timeout=60: (0, "")
up.start = lambda job: started.append(job["name"]) or True
up.herdr = lambda: ("/x/herdr", "")
up.boot_time = lambda: int(os.environ.get("BOOT") or 0)
sys.argv = ["up.py"]
try:
    up.main()
except SystemExit:
    pass
print(json.dumps({"started": started}))
`

const exitOf = (jobs: object[], ...args: string[]) => {
  const config = mkdtempSync(join(scratch, "exit-"))
  mkdirSync(join(dataOf(config), "ops"), { recursive: true })
  writeFileSync(join(dataOf(config), "ops", "jobs.json"), JSON.stringify({ jobs }))
  const child = Bun.spawnSync(["python3", "-I", "-c", EXIT, upPy, ...args], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  return {
    ...(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as {
      code: number
      started: string[]
    }),
    stderr: child.stderr.toString(),
  }
}

// a job row an older install stored may hold any runtime word, and ops-up starts it in herdr, the one runtime.
test("a pass exits 0 and starts a down job in herdr whatever runtime word its row holds", () => {
  const oldJob = {
    command: "bash /x/ops/ops-dashboard/loop.sh",
    name: "ops-dashboard",
    runtime: "made-up",
    stop: "dashboard",
  }
  const herdrJob = { command: "bash /x/ops/ops-x/loop.sh", name: "ops-x", runtime: "herdr" }
  const launchdJob = { launchd: "blue.acme.x", name: "x" }
  expect(exitOf([oldJob, herdrJob, launchdJob])).toEqual({
    code: 0,
    started: ["ops-dashboard", "ops-x"],
    stderr: "",
  })
  // a row that names no runtime and has a command starts in herdr too, as a hand-kept jobs.json row the render never parsed
  expect(exitOf([{ ...oldJob, runtime: undefined }])).toEqual({
    code: 0,
    started: ["ops-dashboard"],
    stderr: "",
  })
})

// an argument up.py does not know starts nothing.
test("an argument up.py does not know is refused with its usage and runs no pass", () => {
  const job = { command: "bash /x/ops/ops-x/loop.sh", name: "ops-x", runtime: "herdr" }
  for (const args of [["--once"], ["--restarted"], ["--sessions", "x"]])
    expect(exitOf([job], ...args)).toEqual({
      code: 1,
      started: [],
      stderr: "usage: up.py [--restarted <a,b> | --sessions]\n",
    })
})

// up.py's own clock, which the clock-ahead pass leaves real, so a start the test records is as old to up.py as the test means it.
const pyNow = () =>
  Number(
    Bun.spawnSync(["python3", "-I", "-c", "import time; print(time.time())"]).stdout.toString(),
  )

// Loads up.py and runs main() with the arguments after its path, every job down, each start printed rather than made.
const RESTARTED = `${LOAD}started = []
up.healthy = lambda job: (False, "no heartbeat")
up.ptable.table = lambda: {}
up.once.running = lambda name, marker: None
up.run = lambda argv, timeout=60: (0, "")
up.start = lambda job: started.append(job["name"]) or True
up.herdr = lambda: ("/x/herdr", "")
sys.argv = sys.argv[1:]
up.main()
print(json.dumps(started))
`

// ops-restart stops a job up.py may have started within GRACE, so --restarted drops its start under up.lock, waiting out a running pass whose own write would put it back, as the lock holder's write here does.
test("--restarted drops the named jobs' starts once any running pass ends, and starts them", async () => {
  const config = mkdtempSync(join(scratch, "restarted-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  const job = (name: string) => ({ command: `bash /x/${name}.sh`, name, runtime: "herdr" })
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs: [job("ops-x"), job("ops-y")] }))
  // each start a minute old: made before the job stopped, as ops-restart's TERM'd job's was
  const now = pyNow() - 60
  writeFileSync(join(ops, "up-state.json"), JSON.stringify({ "ops-x": now, "ops-y": now }))
  const env = {
    CLAUDE_CONFIG_DIR: config,
    PLAYGROUND_DATA_DIR: join(config, "playground"),
    HOME: scratch,
    PATH: SYS_PATH,
    ...SYSTEMD_ENV,
  }
  const pass = (...args: string[]) => {
    const child = Bun.spawnSync(["python3", "-I", "-c", RESTARTED, upPy, ...args], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(child.stderr.toString()).toBe("")
    return JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!)
  }
  expect(pass()).toEqual([])
  const holder = Bun.spawn(
    [
      "python3",
      "-I",
      "-c",
      "import fcntl, sys, time\nf = open(sys.argv[1], 'w')\nfcntl.flock(f, fcntl.LOCK_EX)\nprint('held', flush=True)\ntime.sleep(3)\nopen(sys.argv[2], 'w').write(sys.argv[3])",
      join(ops, "up.lock"),
      join(ops, "up-state.json"),
      JSON.stringify({ "ops-x": now, "ops-y": now, "ops-z": now }),
    ],
    { env: { ...SYSTEMD_ENV, PATH: SYS_PATH }, stdout: "pipe" },
  )
  const reader = holder.stdout.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held")
  expect(pass()).toEqual([])
  expect(pass("--restarted", "ops-x")).toEqual(["ops-x"])
  expect(await holder.exited).toBe(0)
  expect(Object.keys(JSON.parse(readFileSync(join(ops, "up-state.json"), "utf8")))).toEqual([
    "ops-y",
    "ops-z",
    "ops-x",
  ])
})

// Loads up.py and runs main() with the arguments after its path, every job down, each start appended to the file named first rather than made.
const RACE = `${LOAD}import fcntl
up.healthy = lambda job: (False, "process gone")
up.ptable.table = lambda: {}
up.once.running = lambda name, marker: None
up.run = lambda argv, timeout=60: (0, "")
path = sys.argv[2]
up.start = lambda job: open(path, "a").write(job["name"] + "\\n") or True
up.herdr = lambda: ("/x/herdr", "")
sys.argv = sys.argv[3:]
up.main()
`

// PG-2882: on an accept, each job of the item restarts itself through up.py --restarted <job>; the first pass starts both, so the second job's own pass, under up.lock right behind it, must not drop that fresh start and start the job again.
test("two jobs' --restarted passes at once start each job once, the second start skipped and logged", async () => {
  const config = mkdtempSync(join(scratch, "race-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  const job = (name: string) => ({ command: `bash /x/${name}.sh`, name, runtime: "herdr" })
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs: [job("ops-x"), job("ops-y")] }))
  // both last started an hour ago, past GRACE, so either pass starts both
  const old = pyNow() - 3600
  writeFileSync(join(ops, "up-state.json"), JSON.stringify({ "ops-x": old, "ops-y": old }))
  const starts = join(ops, "starts.txt")
  const env = {
    CLAUDE_CONFIG_DIR: config,
    PLAYGROUND_DATA_DIR: join(config, "playground"),
    HOME: scratch,
    PATH: SYS_PATH,
    ...SYSTEMD_ENV,
  }
  const pass = (name: string) =>
    Bun.spawn(["python3", "-I", "-c", RACE, upPy, starts, "up.py", "--restarted", name], {
      env,
      stderr: "pipe",
      stdout: "ignore",
    })
  const passes = [pass("ops-x"), pass("ops-y")]
  for (const p of passes) {
    expect(await new Response(p.stderr).text()).toBe("")
    expect(await p.exited).toBe(0)
  }
  expect(readFileSync(starts, "utf8").split("\n").filter(Boolean).sort()).toEqual([
    "ops-x",
    "ops-y",
  ])
  expect(readFileSync(join(ops, "up.log"), "utf8")).toMatch(
    /another pass started ops-[xy] within 10s of this restart's call; not starting it again/,
  )
})

// Loads up.py and runs two passes with every job healthy by its heartbeat, lsof answering the fake listing given and every other call recorded; a TERM'd pid dies, and starts are recorded rather than made.
const DELETED = `${LOAD}sys.platform = "darwin"
listing = sys.argv[2]
calls, kills, started = [], [], []
up.healthy = lambda job: (True, "ok")
up.ptable.table = lambda: {pid: None for pid in (4301, 4302, 4401, 4501, 4601, 4602, 4701)}
up.once.running = lambda name, marker: {"ops-x": 4301, "ops-y": 4501, "ops-z": 4601}.get(name)
up.run = lambda argv, timeout=60: (0, listing) if argv[0] == "lsof" else (calls.append(argv), (0, ""))[1]
up.os.kill = lambda pid, sig: kills.append([pid, sig])
up.alive = lambda pid: [pid, 15] not in kills
up.start = lambda job: started.append(job["name"]) or True
up.herdr = lambda: ("/x/herdr", "")
up.in_grid = lambda job, binary: True
up.up(True)
up.up(True)
print(json.dumps({"calls": calls, "kills": kills, "started": started}))
`

// an update that deletes a job's executable leaves it beating on a binary macOS no longer trusts, so ops-up restarts it, reports a launchd job it never started, and leaves a job with no holder to stop alone.
test("a job on a deleted executable is restarted, or reported once when launchd holds it", () => {
  const config = mkdtempSync(join(scratch, "deleted-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  const job = (name: string) => ({
    command: `bash /x/${name}.sh`,
    heartbeat: name,
    name,
    runtime: "herdr",
  })
  const jobs = [
    job("ops-w"),
    job("ops-x"),
    job("ops-y"),
    job("ops-z"),
    { heartbeat: "ops-l", launchd: "com.x.ops-l", name: "ops-l" },
  ]
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs }))
  const beats = { "ops-l": 4401, "ops-w": 4701, "ops-x": 4302, "ops-y": 4501, "ops-z": 4602 }
  for (const [name, pid] of Object.entries(beats))
    writeFileSync(join(ops, `${name}.json`), JSON.stringify({ pid }))
  const gone = join(scratch, "gone", "python3")
  const listing = [
    ["4301", gone],
    ["4302", "/bin/sh"],
    ["4401", `${gone}-l`],
    ["4501", "/bin/sh"],
    ["4601", "/bin/sh"],
    ["4602", `${gone}-z`],
    ["4701", `${gone}-w`],
  ]
    .map(([pid, exe]) => `p${pid}\nftxt\nn${exe}\nftxt\nn/usr/lib/dyld`)
    .join("\n")
  const child = Bun.spawnSync(["python3", "-I", "-c", DELETED, upPy, listing], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  const { calls, kills, started } = JSON.parse(child.stdout.toString())
  expect(kills).toEqual([
    [4301, 15],
    [4601, 15],
  ])
  expect(started).toEqual(["ops-x", "ops-z"])
  expect(calls).toEqual([
    [
      join(dirname(upPy), "notify.sh"),
      "up",
      `ops-l pid 4401 runs a deleted executable (${gone}-l); launchd job com.x.ops-l keeps it alive, so restart it there`,
    ],
  ])
  const log = readFileSync(join(ops, "up.log"), "utf8")
  expect(log).toContain(`ops-x pid 4301 runs a deleted executable (${gone}); stopped it`)
  expect(log).toContain(
    `ops-z pid 4601 holds pid 4602, which runs a deleted executable (${gone}-z); stopped it`,
  )
  expect(log).not.toContain("ops-y")
  // ops-w has no holder to stop, so a start would run a second copy beside its heartbeat pid
  expect(log).not.toContain("ops-w")
})

// a start recorded within GRACE, its heartbeat pid dead and no heartbeat.startedAt, but the machine booted after the recorded start, so ops-up ends the grace and starts the job in that pass.
test("a job recorded within GRACE starts when the machine booted after its recorded start", () => {
  const config = mkdtempSync(join(scratch, "grace-boot-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  const job = {
    command: "bash /x/ops-dashboard.sh",
    heartbeat: "ops-dashboard",
    name: "ops-dashboard",
    runtime: "herdr",
    stop: "dashboard",
  }
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs: [job] }))
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(join(ops, "up-state.json"), JSON.stringify({ "ops-dashboard": now - 30 }))
  // a dead heartbeat pid and no heartbeat.startedAt, so only the boot ends the grace
  writeFileSync(
    join(ops, "ops-dashboard.json"),
    JSON.stringify({
      pid: 4101,
      lastBeatAt: new Date((now - 60) * 1000).toISOString(),
      lastResult: "ok",
      cycleSeconds: 60,
    }),
  )
  const child = Bun.spawnSync(["python3", "-I", "-c", STARTED_AFTER_BOOT, upPy], {
    env: {
      BOOT: String(now - 20),
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  // the harness prints a line per start before its JSON summary, so read the last line
  expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!).started).toEqual([
    "ops-dashboard",
  ])
})

// Loads up.py and runs one pass per health answer given, every notify.sh call recorded rather than made.
const DOWN = `${LOAD}sys.platform = "darwin"
calls = []
up.render_jobs = lambda: None
up.ptable.table = lambda: {}
up.once.running = lambda name, marker: None
up.run = lambda argv, timeout=60: (calls.append(argv) if argv[0].endswith("notify.sh") else None, (0, ""))[1]
for answer in json.loads(sys.argv[2]):
    up.healthy = lambda job, answer=answer: tuple(answer)
    up.up(True)
print(json.dumps(calls))
`

// a launchd job turned on but never installed once logged "keeps it alive" every pass and told nobody, so a run of down passes is told to ops once, and again only after a healthy pass.
test("a launchd job down 3 passes in a row is told to ops once, and again only after it comes back and goes down", () => {
  const config = mkdtempSync(join(scratch, "down-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(
    join(ops, "jobs.json"),
    JSON.stringify({ jobs: [{ heartbeat: "ops-l", launchd: "com.x.ops-l", name: "ops-l" }] }),
  )
  const down = [false, "no heartbeat"]
  const answers = [down, down, down, down, [true, "ok"], down, down, down]
  const child = Bun.spawnSync(["python3", "-I", "-c", DOWN, upPy, JSON.stringify(answers)], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  const told = [
    join(dirname(upPy), "notify.sh"),
    "up",
    "ops-l has been unhealthy (no heartbeat) for 3 passes in a row; launchd job com.x.ops-l is not bringing it back, so check it is installed and loaded (playground doctor)",
  ]
  expect(JSON.parse(child.stdout.toString())).toEqual([told, told])
})

// Loads up.py and runs one pass per step, the herdr job ops-h always down and started, GRACE off; a step's "last" is written to ops/ops-h.last first, "age" seconds old, as once.py's reader leaves a dead copy's line. Prints each pass's started line, then every notify.sh call.
const LAST = `${LOAD}import os, time
calls, said = [], []
up.render_jobs = lambda: None
up.GRACE = 0
up.ptable.table = lambda: {}
up.once.running = lambda name, marker: None
up.herdr = lambda: ("/x/herdr", "")
up.healthy = lambda job: (False, "no heartbeat")
up.start = lambda job: True
up.run = lambda argv, timeout=60, env=None: (calls.append(argv + ["private" if (env or {}).get("NOTIFY_PRIVATE") == "1" else "public"]) if argv[0].endswith("notify.sh") else None, (0, ""))[1]
up.print = lambda line: said.append(line)
for step in json.loads(sys.argv[2]):
    path = os.path.join(up.OPS, "ops-h.last")
    if step.get("last") is not None:
        open(path, "w").write(step["last"])
        then = time.time() - step.get("age", 0)
        os.utime(path, (then, then))
    up.up(False)
print(json.dumps({"calls": calls, "said": said}))
`

const lastOf = (steps: object[]) => {
  const config = mkdtempSync(join(scratch, "last-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(
    join(ops, "jobs.json"),
    JSON.stringify({
      jobs: [{ command: "bash /x/h.sh", heartbeat: "ops-h", name: "ops-h", runtime: "herdr" }],
    }),
  )
  const child = Bun.spawnSync(["python3", "-I", "-c", LAST, upPy, JSON.stringify(steps)], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      HOME: scratch,
      PATH: SYS_PATH,
      PLAYGROUND_DATA_DIR: dataOf(config),
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  const out = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as {
    calls: string[][]
    said: string[]
  }
  return { ...out, ops, told: out.calls.map((c) => c[2]) }
}

// PG-2878: herdr closes a dead job's pane with it, so a restart tells ops the job's last line, from once.py's ops/<job>.last, once per line
test("a job restarted three times on the same last line tells ops once, and a new last line tells it again, each a private line kept out of up.log and the printed line", () => {
  const unreadable = "vault: cache unreadable: no cached copy"
  const { calls, ops, said, told } = lastOf([
    { last: unreadable },
    { last: unreadable },
    { last: unreadable },
    { last: "made-up: a new reason" },
  ])
  expect(told).toEqual([
    `ops-h stopped, and ops-up started it again; its last line: ${unreadable}`,
    "ops-h stopped, and ops-up started it again; its last line: made-up: a new reason",
  ])
  // ops-tick sends each printed line to ops in public, so the printed line keeps the last line out
  expect(said).toEqual(Array(4).fill("started ops-h in herdr (no heartbeat)"))
  expect(statSync(join(ops, "up-last-lines.json")).mode & 0o777).toBe(0o600)
  expect(calls.map((c) => c.at(-1))).toEqual(["private", "private"])
  expect(readFileSync(join(ops, "up.log"), "utf8")).not.toContain("cache unreadable")
})

test("a last line written before the job's last start is never told, and one with no file keeps today's line", () => {
  const { said, told } = lastOf([{}, { age: 3600, last: "made-up: yesterday's death" }])
  expect(told).toEqual([])
  expect(said).toEqual([
    "started ops-h in herdr (no heartbeat)",
    "started ops-h in herdr (no heartbeat)",
  ])
})

test("a last line is told at 200 characters at most", () => {
  const { told } = lastOf([{ last: "y".repeat(300) }])
  expect(told).toEqual([
    `ops-h stopped, and ops-up started it again; its last line: ${"y".repeat(200)}`,
  ])
})

// #2203: on Linux systemd holds the job as a user unit of the same label, so the report names that unit
test("on Linux a launchd job down 3 passes in a row is told to ops as its systemd user unit", () => {
  const config = mkdtempSync(join(scratch, "down-linux-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(
    join(ops, "jobs.json"),
    JSON.stringify({ jobs: [{ heartbeat: "ops-l", launchd: "com.x.ops-l", name: "ops-l" }] }),
  )
  const down = [false, "no heartbeat"]
  const linux = DOWN.replace('sys.platform = "darwin"', 'sys.platform = "linux"')
  const child = Bun.spawnSync(
    ["python3", "-I", "-c", linux, upPy, JSON.stringify([down, down, down])],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: scratch,
        PATH: SYS_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual([
    [
      join(dirname(upPy), "notify.sh"),
      "up",
      "ops-l has been unhealthy (no heartbeat) for 3 passes in a row; systemd unit com.x.ops-l.service is not bringing it back, so check it is installed and loaded (playground doctor)",
    ],
  ])
})

// Loads up.py and starts one herdr job, recording every herdr call rather than making it.
const STARTED = `${LOAD}calls = []
up.herdr = lambda: ("/x/herdr", "")
up.ops_panes = lambda binary: ([(4101, "ops-a")], "workspace:1")
up.hr = lambda binary, *args: (calls.append(args), (0, {"pane": {"pane_id": 5501}}, ""))[1]
up.start({"name": "ops-h", "runtime": "herdr", "cwd": "~/h", "command": "bash /x/h.sh"})
print(json.dumps([list(c) for c in calls]))
`

// a job's pane closes when its job exits, so the line up.py runs holds exec before the job.
test("the start line holds exec before the job", () => {
  const config = mkdtempSync(join(scratch, "started-"))
  mkdirSync(join(dataOf(config), "ops"), { recursive: true })
  const child = Bun.spawnSync(["python3", "-I", "-c", STARTED, upPy], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  const herdrLine = JSON.parse(child.stdout.toString()).find((c: unknown[]) => c[1] === "run")[3]
  expect(herdrLine).toContain("ops-h")
  expect(herdrLine).toContain("&& exec python3 -I ")
})

// Loads up.py and starts one herdr job whose command is argv[2], its rendered.ts argv[3] when given, recording every herdr call, then prints the calls, the marker and up.log.
const STARTED_EXT = `${LOAD}calls = []
up.herdr = lambda: ("/x/herdr", "")
up.ops_panes = lambda binary: ([(4101, "ops-a")], "workspace:1")
up.hr = lambda binary, *args: (calls.append(args), (0, {"pane": {"pane_id": 5501}}, ""))[1]
if len(sys.argv) > 3:
    up.RENDERED = sys.argv[3]
job = {"name": "ops-x", "runtime": "herdr", "cwd": "~/h", "command": sys.argv[2]}
started = up.start(job)
log = open(os.path.join(up.OPS, "up.log")).read() if os.path.exists(os.path.join(up.OPS, "up.log")) else ""
print(json.dumps({"started": started, "calls": [list(c) for c in calls], "marker": up.marker(job), "log": log}))
`.replace("import importlib.util, json, sys", "import importlib.util, json, os, sys")

// A data folder whose extensions root holds one scope's skill script, as an accepted revision renders it.
const withExtension = (body: string) => {
  const config = mkdtempSync(join(scratch, "ext-"))
  const data = dataOf(config)
  mkdirSync(join(data, "ops"), { recursive: true })
  const script = join(data, "extensions", "acme", "skills", "vault", "scripts", "vault.py")
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, body)
  return { config, data, script }
}

const startExt = (config: string, command: string, rendered?: string) => {
  const child = Bun.spawnSync(
    ["python3", "-I", "-c", STARTED_EXT, upPy, command, ...(rendered ? [rendered] : [])],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: dataOf(config),
        HOME: scratch,
        PATH: BUN_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  expect(child.stderr.toString()).toBe("")
  return JSON.parse(child.stdout.toString()) as {
    calls: string[][]
    log: string
    marker: string
    started: boolean
  }
}

// a jobs row names an extension script by ext:<scope>/<path>, which rendered.ts resolves at each start, so a new accepted revision reaches the job with no repoint
test("a start runs an ext: word as the path rendered.ts gives it, at each start", () => {
  const { config, script } = withExtension("print(1)\n")
  const first = startExt(config, "python3 -I ext:acme/skills/vault/scripts/vault.py run")
  expect(first.started).toBe(true)
  const line = first.calls.find((call) => call[1] === "run")![3]!
  expect(line).toContain(`exec python3 -I `)
  expect(line).toContain(`ops-x python3 -I ${script} run`)
  expect(line).not.toContain("ext:")
  expect(first.marker).toBe("/vault/scripts/")
  writeFileSync(script, "print(2)\n")
  const second = startExt(config, "python3 -I ext:acme/skills/vault/scripts/vault.py run")
  expect(second.calls.find((call) => call[1] === "run")![3]).toContain(script)
})

test("a start whose ext: word the store lacks opens no pane and logs rendered.ts's refusal", () => {
  const { config } = withExtension("print(1)\n")
  const out = startExt(config, "python3 -I ext:acme/skills/vault/scripts/gone.py")
  expect(out.started).toBe(false)
  expect(out.calls).toEqual([])
  expect(out.log).toContain("ops-x")
  expect(out.log).toContain("acme/skills/vault/scripts/gone.py")
})

test("a start with a plain path runs it as written", () => {
  const { config } = withExtension("print(1)\n")
  const out = startExt(config, "bash /x/h.sh")
  expect(out.started).toBe(true)
  expect(out.calls.find((call) => call[1] === "run")![3]).toContain("ops-x bash /x/h.sh")
})

// issue 1960: rendered.ts may warn on stderr, so the path an ext: word resolves to comes from its stdout alone
test("a start whose ext: word resolves while rendered.ts warns on stderr runs the path stdout gave", () => {
  const { config, script } = withExtension("print(1)\n")
  const rendered = join(scratch, "warn-rendered.ts")
  writeFileSync(
    rendered,
    `console.log(${JSON.stringify(script)})\nconsole.error("warn: lookup is deprecated")\n`,
  )
  const out = startExt(config, "python3 -I ext:acme/skills/vault/scripts/vault.py run", rendered)
  expect(out.started).toBe(true)
  const line = out.calls.find((call) => call[1] === "run")![3]!
  expect(line).toContain(`ops-x python3 -I ${script} run`)
  expect(line).not.toContain("warn:")
})

// the refusal's why keeps the reader's whole answer, its stdout and stderr both, as today
test("a start whose ext: word refuses keeps the refusal's why from stdout and stderr both", () => {
  const { config } = withExtension("print(1)\n")
  const rendered = join(scratch, "refused-rendered.ts")
  writeFileSync(
    rendered,
    `console.log("acme/skills/vault/scripts/gone.py")\nconsole.error("refused: no accepted revision")\nprocess.exit(1)\n`,
  )
  const out = startExt(config, "python3 -I ext:acme/skills/vault/scripts/gone.py run", rendered)
  expect(out.started).toBe(false)
  expect(out.calls).toEqual([])
  expect(out.log).toContain("ops-x")
  expect(out.log).toContain("acme/skills/vault/scripts/gone.py")
  expect(out.log).toContain("refused: no accepted revision")
})

// a failed or empty lsof read changes nothing.
test("an empty lsof read leaves every job alone", () => {
  const config = mkdtempSync(join(scratch, "deleted-empty-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(
    join(ops, "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          command: "bash /x/ops-x.sh",
          heartbeat: "ops-x",
          name: "ops-x",
          runtime: "herdr",
        },
      ],
    }),
  )
  writeFileSync(join(ops, "ops-x.json"), JSON.stringify({ pid: 4302 }))
  for (const listing of ["", "lsof: WARNING: can't stat() /nowhere"]) {
    const child = Bun.spawnSync(["python3", "-I", "-c", DELETED, upPy, listing], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: scratch,
        PATH: SYS_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(child.stderr.toString()).toBe("")
    expect(JSON.parse(child.stdout.toString())).toEqual({
      calls: [],
      kills: [],
      started: [],
    })
  }
})

// Loads up.py and runs one render of jobs.json from the store.
const RENDER = `${LOAD}up.render_jobs()
`

test("a pass renders jobs.json from the store, keeps it when the store has no policy.json yet, and keeps the last one with the reason in up.log when the set is refused", async () => {
  const { writeRoot } = await import("../../../packages/settings/src/folder")
  const { extensionsDir } = await import("../../../packages/settings/src/rendered")
  const config = join(scratch, "config-render")
  const data = dataOf(config)
  const ops = join(data, "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs: [{ name: "ops-company" }] }))
  const policy = JSON.stringify({ orgs: {}, schemaVersion: 1, values: {} })
  writeRoot(extensionsDir(data), new Map([["policy.json", policy]]))
  const pass = () =>
    Bun.spawnSync(["python3", "-I", "-c", RENDER, upPy], {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: scratch,
        PATH: BUN_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
    })
  expect(pass().stderr.toString()).toBe("")
  const names = JSON.parse(readFileSync(join(ops, "jobs.json"), "utf8")).jobs.map(
    (job: { name: string }) => job.name,
  )
  expect(names).toContain("ops-company")
  expect(names).toContain("ops-tick")
  expect(readFileSync(join(ops, "up.log"), "utf8")).toContain("jobs: rendered jobs.json")
  const rendered = readFileSync(join(ops, "jobs.json"), "utf8")
  writeRoot(extensionsDir(data), new Map([["policy.json", null]]))
  expect(pass().stderr.toString()).toBe("")
  expect(readFileSync(join(ops, "jobs.json"), "utf8")).toBe(rendered)
  expect(readFileSync(join(ops, "up.log"), "utf8")).not.toContain("jobs.json kept: ")
  writeRoot(extensionsDir(data), new Map([["policy.json", "{"]]))
  expect(pass().stderr.toString()).toBe("")
  expect(readFileSync(join(ops, "jobs.json"), "utf8")).toBe(rendered)
  expect(readFileSync(join(ops, "up.log"), "utf8")).toContain("jobs.json kept: ")
})

// issue 1538: a dead render's own error must reach up.log, so a pass makes the ops folder before its lock; on a fresh data dir the folder is missing, and the lock's open, then log()'s append, raised FileNotFoundError, hiding the render's error behind it; the pass runs main() with up() cut to its render
test("a dead render with no ops folder shows the render's own error in up.log, not a missing-folder raise", () => {
  const config = join(scratch, "config-dead-render")
  mkdirSync(dataOf(config), { recursive: true })
  const dead = join(scratch, "dead-render.ts")
  writeFileSync(dead, `console.error("the render died here"); process.exit(2)\n`)
  const pass = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      `${LOAD}up.JOBS_RENDER = sys.argv[2]\nup.up = lambda quiet: up.render_jobs()\nsys.argv = sys.argv[:1]\nup.main()`,
      upPy,
      dead,
    ],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: scratch,
        PATH: BUN_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
    },
  )
  expect(pass.stderr.toString()).not.toContain("FileNotFoundError")
  expect(readFileSync(join(dataOf(config), "ops", "up.log"), "utf8")).toContain(
    "the render died here",
  )
})

// a launchd job turned on reaches launchd only through the render's install into HOME's LaunchAgents, so each pass hands it that folder.
test("a pass hands the render HOME's LaunchAgents folder to install into", () => {
  const config = join(scratch, "config-install")
  mkdirSync(dataOf(config), { recursive: true })
  const render = join(scratch, "argv-render.ts")
  const argv = join(scratch, "argv-render.json")
  writeFileSync(
    render,
    `require("node:fs").writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)))\n`,
  )
  const pass = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      `${LOAD}sys.platform = "darwin"\nup.JOBS_RENDER = sys.argv[2]\nup.render_jobs()`,
      upPy,
      render,
    ],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: dataOf(config),
        HOME: scratch,
        PATH: BUN_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
    },
  )
  expect(pass.stderr.toString()).toBe("")
  const args = JSON.parse(readFileSync(argv, "utf8")) as string[]
  expect(args[args.indexOf("--install") + 1]).toBe(join(scratch, "Library", "LaunchAgents"))
})

// #2203: Linux has no LaunchAgents, so systemd's user unit folder in HOME is where the render installs
test("on Linux a pass hands the render HOME's systemd user unit folder to install into", () => {
  const config = join(scratch, "config-install-linux")
  mkdirSync(dataOf(config), { recursive: true })
  const render = join(scratch, "argv-render-linux.ts")
  const argv = join(scratch, "argv-render-linux.json")
  writeFileSync(
    render,
    `require("node:fs").writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)))\n`,
  )
  const pass = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      `${LOAD}sys.platform = "linux"\nup.JOBS_RENDER = sys.argv[2]\nup.render_jobs()`,
      upPy,
      render,
    ],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: dataOf(config),
        HOME: scratch,
        PATH: BUN_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
    },
  )
  expect(pass.stderr.toString()).toBe("")
  const args = JSON.parse(readFileSync(argv, "utf8")) as string[]
  expect(args[args.indexOf("--install") + 1]).toBe(join(scratch, ".config", "systemd", "user"))
})

// #2314: the render turns linger on, a change to the machine, with exit 0, so up.log keeps its line, and a refusal's, at exit 0 too
test("a pass logs the render's linger line, turned on or refused, at exit 0", () => {
  const config = join(scratch, "config-linger")
  mkdirSync(join(dataOf(config), "ops"), { recursive: true })
  const render = join(scratch, "linger-render.ts")
  writeFileSync(
    render,
    `console.error("jobs: turned on linger for user 1000")\nconsole.error("jobs: refused enable-linger of user 1001, exit 1: Access denied")\n`,
  )
  const pass = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      `${LOAD}sys.platform = "linux"\nup.JOBS_RENDER = sys.argv[2]\nup.render_jobs()`,
      upPy,
      render,
    ],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: dataOf(config),
        HOME: scratch,
        PATH: BUN_PATH,
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
    },
  )
  expect(pass.stderr.toString()).toBe("")
  const log = readFileSync(join(dataOf(config), "ops", "up.log"), "utf8")
  expect(log).toContain(
    "jobs: turned on linger for user 1000 jobs: refused enable-linger of user 1001, exit 1: Access denied",
  )
})

test("a pass writes jobs.json into the data folder dataDir() resolves, playground over an old dispatcher beside it", () => {
  const config = join(scratch, "config-fresh")
  mkdirSync(join(config, "dispatcher", "ops"), { recursive: true })
  mkdirSync(join(config, "playground"), { recursive: true })
  const pass = Bun.spawnSync(["python3", "-I", "-c", RENDER, upPy], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: BUN_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
  })
  expect(pass.stderr.toString()).toBe("")
  expect(existsSync(join(config, "playground", "ops", "jobs.json"))).toBe(true)
  expect(readFileSync(join(config, "playground", "ops", "up.log"), "utf8")).toContain(
    "jobs: rendered jobs.json",
  )
  expect(existsSync(join(config, "dispatcher", "ops", "jobs.json"))).toBe(false)
})

test("a pass moves a turned-off job's plist from ops/launch-agents to the data folder's trash, and logs one the trash keeps without calling jobs.json kept", () => {
  const config = join(scratch, "config-plists")
  const data = join(config, "playground")
  const agents = join(data, "ops", "launch-agents")
  mkdirSync(join(agents, "com.playground.ops-odd.plist"), { recursive: true })
  writeFileSync(join(agents, "com.playground.ops-gone.plist"), "stale")
  writeFileSync(join(agents, "com.playground.ops-odd.plist", "a"), "x")
  writeFileSync(join(agents, "com.playground.ops-odd.plist", "b"), "x")
  const pass = Bun.spawnSync(["python3", "-I", "-c", RENDER, upPy], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: data,
      HOME: scratch,
      PATH: BUN_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
  })
  expect(pass.stderr.toString()).toBe("")
  expect(existsSync(join(agents, "com.playground.ops-gone.plist"))).toBe(false)
  const [batch] = readdirSync(join(data, "trash"))
  expect(
    readFileSync(join(data, "trash", batch!, "1", "com.playground.ops-gone.plist"), "utf8"),
  ).toBe("stale")
  expect(existsSync(join(agents, "com.playground.ops-odd.plist", "a"))).toBe(true)
  const log = readFileSync(join(data, "ops", "up.log"), "utf8")
  expect(log).toContain("-com.playground.ops-gone.plist")
  expect(log).toContain("jobs: kept com.playground.ops-odd.plist:")
  expect(log).not.toContain("jobs.json kept: ")
})

const PR_1 = "https://github.com/o/r/pull/1"
const PR_2 = "https://github.com/o/r/pull/2"

// Loads up.py and prints --sessions' resume lines, with no session running, no factory session unguarded and no checkout around a cwd.
const RESUMES = `${LOAD}up.unguarded = lambda: []
up.run = lambda argv, timeout=60: (1, "")
up.sessions()
`

test("a resume reads the roster and its backend pin from the data folder spawn.sh keeps them in, PLAYGROUND_DATA_DIR's when set", () => {
  const config = join(scratch, "config-pins")
  const data = join(scratch, "data-pins")
  mkdirSync(join(data, "backends"), { recursive: true })
  writeFileSync(
    join(data, "roster.json"),
    JSON.stringify({
      agents: [
        { name: "p1-worker", status: "working" },
        { name: "p2-worker", status: "working" },
        { kind: "reviewer", name: "p3-reviewer", pr: PR_2, prs: [PR_1, PR_2], status: "working" },
      ],
    }),
  )
  for (const name of ["p1-worker", "p2-worker", "p3-reviewer"]) {
    mkdirSync(join(config, "projects", name), { recursive: true })
    const model = name === "p3-reviewer" ? "claude-opus-5-5" : "glm-5.3-flash"
    writeFileSync(
      join(config, "projects", name, `s-${name}.jsonl`),
      `${JSON.stringify({ agentName: name, cwd: "/nowhere", model })}\n`,
    )
  }
  writeFileSync(join(data, "backends", "p1-worker"), "glm\n")
  const child = Bun.spawnSync(["python3", "-I", "-c", RESUMES, upPy], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
      PLAYGROUND_DATA_DIR: data,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  const lines = child.stdout.toString().split("\n")
  expect(lines.find((line) => line.includes(" resume p1-worker "))).toEndWith(" s-p1-worker")
  expect(lines.find((line) => line.includes(" resume p2-worker "))).toEndWith(
    " s-p2-worker --backend glm",
  )
  expect(lines.find((line) => line.includes(" resume p3-reviewer "))).toEndWith(
    ` s-p3-reviewer --backend claude --pr ${PR_2},${PR_1}`,
  )
})

// spawn.sh resume refuses a done row without --force, so up.py prints no line that the resume would refuse, as it prints none for an ended or a paused row.
test("a done, ended or paused row prints no resume line", () => {
  const config = join(scratch, "config-down")
  const data = join(scratch, "data-down")
  mkdirSync(data, { recursive: true })
  const rows = {
    "d1-worker": "done",
    "d2-worker": "ended",
    "d3-worker": "paused",
    "d4-worker": "working",
  }
  writeFileSync(
    join(data, "roster.json"),
    JSON.stringify({ agents: Object.entries(rows).map(([name, status]) => ({ name, status })) }),
  )
  for (const name of Object.keys(rows)) {
    mkdirSync(join(config, "projects", name), { recursive: true })
    writeFileSync(
      join(config, "projects", name, `s-${name}.jsonl`),
      `${JSON.stringify({ agentName: name, cwd: "/nowhere", model: "claude-opus-5-5" })}\n`,
    )
  }
  const child = Bun.spawnSync(["python3", "-I", "-c", RESUMES, upPy], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      HOME: scratch,
      PATH: "/usr/bin:/bin",
      PLAYGROUND_DATA_DIR: data,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  const resumed = child.stdout
    .toString()
    .split("\n")
    .flatMap((line) => / resume (\S+) /.exec(line)?.[1] ?? [])
  expect(resumed).toEqual(["d4-worker"])
})

// #1296: up.py read a relative value against its own folder, as every Python reader of PLAYGROUND_DATA_DIR did
test("a relative PLAYGROUND_DATA_DIR is refused from any folder, and an absolute one names one folder", () => {
  const at = mkdtempSync(join(scratch, "relative-"))
  for (const dir of ["a", "b"]) mkdirSync(join(at, dir))
  const read = (value: string, cwd: string) => {
    const r = Bun.spawnSync(["python3", "-I", "-c", `${LOAD}\nprint(up.DATA)`, upPy], {
      cwd,
      env: {
        ...SYSTEMD_ENV,
        HOME: at,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PLAYGROUND_DATA_DIR: value,
      },
    })
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString().trim() }
  }
  expect([read(join(at, "d"), join(at, "a")).out, read(join(at, "d"), join(at, "b")).out]).toEqual([
    join(at, "d"),
    join(at, "d"),
  ])
  for (const r of [read("d", join(at, "a")), read("d", join(at, "b"))]) {
    expect(r.code).not.toBe(0)
    expect(r.out).toBe("")
    expect(r.err).toContain("PLAYGROUND_DATA_DIR is relative (d)")
  }
})

// #2613: on a Mac the host start comes from sysctl's `{ sec = N, usec = U }` line, so boot_time parses N out of it instead of falling through to 0 or the Linux /proc/stat read.
const BOOTSYSCTL = `${LOAD}import subprocess
class _R:
    returncode = 0
    stdout = """{ sec = 1700000000, usec = 500 } Tue Nov 14 10:00:00 2026"""
subprocess.run = lambda *a, **k: _R()
print(up.boot_time())
`

test("boot_time reads the macOS boot epoch out of sysctl's sec value", () => {
  const child = Bun.spawnSync(["python3", "-I", "-c", BOOTSYSCTL, upPy], {
    env: {
      HOME: scratch,
      PATH: SYS_PATH,
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  expect(parseInt(child.stdout.toString().trim(), 10)).toEqual(1700000000)
})

// #2613: a heartbeat startedAt is a UTC (Z) stamp, so beat_started must read it as its UTC epoch, not a zone-bent one that is off under DST.
test("beat_started reads a summer heartbeat start as its UTC epoch", () => {
  const config = mkdtempSync(join(scratch, "beat-dst-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs: [] }))
  writeFileSync(
    join(ops, "ops-dashboard.json"),
    JSON.stringify({
      pid: 4101,
      lastBeatAt: "2026-07-01T10:00:00Z",
      startedAt: "2026-07-01T10:00:00Z",
    }),
  )
  const expected = Math.floor(Date.parse("2026-07-01T10:00:00Z") / 1000)
  const child = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      `${LOAD}print(up.beat_started({"heartbeat": "ops-dashboard"}))\n`,
      upPy,
    ],
    {
      env: {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        HOME: scratch,
        PATH: SYS_PATH,
        // a zone that observes DST in summer, so the old mktime/time.timezone read is one hour early
        TZ: "America/New_York",
        ...SYSTEMD_ENV,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  expect(child.stderr.toString()).toBe("")
  expect(parseInt(child.stdout.toString().trim(), 10)).toEqual(expected)
})

// #2665: lastBeatAt is a UTC stamp, so under a July New York clock the old mktime read is an hour early and the minute-old beat reads 61m old.
test("healthy reads a minute-old July beat as healthy under New York's summer time", () => {
  const config = mkdtempSync(join(scratch, "healthy-dst-"))
  const ops = join(dataOf(config), "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs: [] }))
  const beat = "2026-07-01T10:00:00Z"
  writeFileSync(
    join(ops, "ops-dashboard.json"),
    JSON.stringify({
      pid: 1,
      lastBeatAt: beat,
      startedAt: beat,
      lastResult: "ok",
      cycleSeconds: 60,
    }),
  )
  const snippet = `${LOAD}up.alive = lambda pid: True
up.time.time = lambda: ${Date.parse(beat) / 1000 + 60}
print(up.healthy({"heartbeat": "ops-dashboard"})[0])
`
  const child = Bun.spawnSync(["python3", "-I", "-c", snippet, upPy], {
    env: {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      HOME: scratch,
      PATH: SYS_PATH,
      TZ: "America/New_York",
      ...SYSTEMD_ENV,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.stderr.toString()).toBe("")
  expect(child.stdout.toString().trim()).toEqual("True")
})
