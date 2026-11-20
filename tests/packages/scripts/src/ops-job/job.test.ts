import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  dashboardRun,
  failureOf,
  gateOf,
  hold,
  sendAs,
} from "../../../../../packages/scripts/src/ops-job/job"
import type { Context } from "../../../../../packages/scripts/src/ops-tick/tick"
import { procDir } from "../../../../scripts/fixtures/proc"

const dirs: string[] = []
// every job copy a test starts, stopped by its own handle once the file ends, so a red run leaves none running
const started: Bun.Subprocess[] = []
afterAll(() => {
  for (const proc of started) proc.kill("SIGTERM")
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ops-job-")))
  dirs.push(dir)
  return dir
}

const heartbeat = (ops: string, job: string) =>
  JSON.parse(readFileSync(join(ops, `${job}.json`), "utf8")) as {
    job: string
    lastResult: string
    pid: number
  }

describe("hold", () => {
  test("a child that exits leaves its code in the beat and as the wrapper's own", async () => {
    const ops = scratch()
    const code = await hold("ops-held", ["bash", "-c", "exit 3"], ops)
    expect(code).toBe(3)
    const beat = heartbeat(ops, "ops-held")
    expect(beat.job).toBe("ops-held")
    expect(beat.lastResult).toBe("loop exited 3")
    expect(beat.pid).toBe(process.pid)
  })

  test("a live child beats ok, and SIGTERM stops it by its handle and beats the signal", async () => {
    const ops = scratch()
    const main = join(scratch(), "main.ts")
    const job = join(import.meta.dir, "../../../../../packages/scripts/src/ops-job/job.ts")
    writeFileSync(
      main,
      `import { hold } from ${JSON.stringify(job)}\nprocess.exit(await hold("ops-held", ["sleep", "30"], process.argv[2], 100))\n`,
    )
    const proc = Bun.spawn([process.execPath, main, ops], { stderr: "pipe", stdout: "pipe" })
    let beat: { lastResult: string } | undefined
    for (let i = 0; i < 100 && beat?.lastResult !== "ok"; i++) {
      await Bun.sleep(50)
      beat = await Bun.file(join(ops, "ops-held.json"))
        .json()
        .catch(() => undefined)
    }
    expect(beat?.lastResult).toBe("ok")
    proc.kill("SIGTERM")
    const started = Date.now()
    expect(await proc.exited).toBe(143)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(heartbeat(ops, "ops-held").lastResult).toBe("loop exited: TERM")
  })
})

// A scheduled job's entry file at path, beating into ops: one beat each minute that, once started, waits for ops/pass-release, a restart that prints its call, on a 100 ms tick.
const JOB = join(import.meta.dir, "../../../../../packages/scripts/src/ops-job/job.ts")
const entry = (path: string, ops: string, tickMs = 100, head = "") => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${head}import { existsSync, writeFileSync } from "node:fs"
import { scheduled } from ${JSON.stringify(JOB)}
const ops = ${JSON.stringify(ops)}
const pass = async () => {
  writeFileSync(ops + "/pass-started", "")
  while (!existsSync(ops + "/pass-release")) await Bun.sleep(20)
}
scheduled("ops-watch", [{ cron: "* * * * *", name: "pass", run: pass, to: "ops" }], ops, {
  restart: (job: string) => console.log("restart " + job),
  tickMs: ${tickMs},
})
`,
  )
}

const git = (dir: string, ...args: string[]) =>
  new TextDecoder()
    .decode(
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t", "-C", dir, ...args]).stdout,
    )
    .trim()

// A scope's clone holding path with text, committed as an accept would; its new short revision.
const commit = (scope: string, path: string, text: string) => {
  mkdirSync(dirname(join(scope, path)), { recursive: true })
  writeFileSync(join(scope, path), text)
  git(scope, "add", "-A")
  git(scope, "commit", "-q", "-m", `write ${path}`)
  return git(scope, "rev-parse", "--short", "HEAD")
}

const spawn = (main: string) => {
  const proc = Bun.spawn([process.execPath, main], { stderr: "pipe", stdout: "pipe" })
  started.push(proc)
  return proc
}

const waitFor = async (check: () => boolean, ms = 5_000) => {
  for (let at = Date.now(); !check() && Date.now() - at < ms;) await Bun.sleep(20)
  return check()
}

// One job run from a skill's folder in an extension's clone, as a skill-run job runs in place.
// Its entry imports a sibling skill's script, as a skill-run job may.
const skillJob = (tickMs = 100) => {
  const data = scratch()
  const ops = join(data, "ops")
  mkdirSync(ops)
  const scope = join(data, "extensions", "acme")
  mkdirSync(join(scope, "skills", "shared", "scripts"), { recursive: true })
  writeFileSync(join(scope, "skills", "shared", "scripts", "lib.ts"), "export const one = 1\n")
  git(scope, "init", "-q")
  const main = join(scope, "skills", "watch", "scripts", "main.ts")
  entry(main, ops, tickMs, 'import "../../shared/scripts/lib.ts"\n')
  git(scope, "add", "-A")
  git(scope, "commit", "-q", "-m", "seed")
  return { data, first: git(scope, "rev-parse", "--short", "HEAD"), main, ops, scope }
}

describe("scheduled, on an accepted revision of the code it runs (#1880)", () => {
  test("a skill-run job stops at its next idle tick on an accept, asks up.py to start it again at once, and the new copy names the revision", async () => {
    const { first, main, ops, scope } = skillJob()
    writeFileSync(join(ops, "pass-release"), "")
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "ops-watch.json")))).toBe(true)
    const second = commit(scope, "skills/watch/scripts/lib.ts", "export const two = 2\n")
    const accepted = Date.now()
    expect(await proc.exited).toBe(0)
    expect(Date.now() - accepted).toBeLessThan(5_000)
    const out = await new Response(proc.stdout).text()
    expect(out).toContain(`ops-watch runs revision ${first}`)
    expect(out).toContain("restart ops-watch")
    expect(heartbeat(ops, "ops-watch").lastResult).toBe(
      `loop exited: revision ${second} accepted, restarting`,
    )
    const again = spawn(main)
    expect(await waitFor(() => heartbeat(ops, "ops-watch").pid === again.pid)).toBe(true)
    again.kill("SIGTERM")
    expect(await new Response(again.stdout).text()).toContain(`ops-watch runs revision ${second}`)
  }, 20_000)

  test("an accept that lands mid-pass waits for the pass to end", async () => {
    const { main, ops, scope } = skillJob()
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "pass-started")))).toBe(true)
    commit(scope, "skills/watch/scripts/lib.ts", "export const two = 2\n")
    await Bun.sleep(1_000)
    expect(proc.exitCode).toBeNull()
    writeFileSync(join(ops, "pass-release"), "")
    expect(await proc.exited).toBe(0)
  }, 20_000)

  test("an accept of a sibling skill its entry imports restarts it too (#1880)", async () => {
    const { ops, main, scope } = skillJob()
    writeFileSync(join(ops, "pass-release"), "")
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "ops-watch.json")))).toBe(true)
    const second = commit(scope, "skills/shared/scripts/lib.ts", "export const one = 2\n")
    expect(await proc.exited).toBe(0)
    expect(heartbeat(ops, "ops-watch").lastResult).toBe(
      `loop exited: revision ${second} accepted, restarting`,
    )
  }, 20_000)

  test("a beat due on the tick that finds an accept runs before the job stops (#1880)", async () => {
    const { main, ops, scope } = skillJob(1_000)
    writeFileSync(join(ops, "pass-release"), "")
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "ops-watch.json")))).toBe(true)
    commit(scope, "skills/watch/scripts/lib.ts", "export const two = 2\n")
    expect(await proc.exited).toBe(0)
    expect(existsSync(join(ops, "pass-started"))).toBe(true)
  }, 20_000)

  test("an entry that can no longer be read, as a rebase or a rename leaves it, keeps the job running (#1880)", async () => {
    const { main, ops } = skillJob()
    writeFileSync(join(ops, "pass-release"), "")
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "ops-watch.json")))).toBe(true)
    rmSync(main)
    await Bun.sleep(1_000)
    expect(proc.exitCode).toBeNull()
  }, 20_000)

  test("the controls keep running: a change outside its own skill, a proposal under proposed/, and a core job with no revision", async () => {
    const { main, ops, scope } = skillJob()
    writeFileSync(join(ops, "pass-release"), "")
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "ops-watch.json")))).toBe(true)
    commit(scope, "skills/other/scripts/main.ts", "export const other = 1\n")
    commit(scope, "proposed/skills/watch/scripts/lib.ts", "export const two = 2\n")
    const coreOps = join(scratch(), "ops")
    mkdirSync(coreOps)
    writeFileSync(join(coreOps, "pass-release"), "")
    const core = join(scratch(), "core", "main.ts")
    entry(core, coreOps)
    const plain = spawn(core)
    await Bun.sleep(1_000)
    expect([proc.exitCode, plain.exitCode]).toEqual([null, null])
    proc.kill("SIGTERM")
    plain.kill("SIGTERM")
    expect(await new Response(plain.stdout).text()).not.toContain("runs revision")
  }, 20_000)

  test("a job run from an org's script folder under ops restarts when the render writes its folder's new revision", async () => {
    const data = scratch()
    const ops = join(data, "ops")
    const main = join(ops, "watch", "main.ts")
    entry(main, ops)
    writeFileSync(join(ops, "watch", ".revision"), "aaa1111\n")
    writeFileSync(join(ops, "pass-release"), "")
    const proc = spawn(main)
    expect(await waitFor(() => existsSync(join(ops, "ops-watch.json")))).toBe(true)
    writeFileSync(join(ops, "watch", ".revision"), "bbb2222\n")
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toContain("ops-watch runs revision aaa1111")
    expect(heartbeat(ops, "ops-watch").lastResult).toBe(
      "loop exited: revision bbb2222 accepted, restarting",
    )
  }, 20_000)
})

describe("gateOf", () => {
  test("reads load5 and the memory pressure level from one sysctl", () => {
    expect(gateOf("{ 3.10 12.50 9.00 }\n1\n")).toEqual({ load5: 12.5, pressure: 1 })
  })
})

type Sent = { text: string; to: string }

const fake = (repo: string, outs: Record<string, { code: number; out: string }>) => {
  const sent: Sent[] = []
  const ran: string[][] = []
  const ctx: Context = {
    now: new Date(),
    ops: repo,
    repo,
    run: async (argv) => {
      ran.push(argv)
      return outs[argv[0]!] ?? { code: 0, out: "" }
    },
    send: async (to, text) => {
      sent.push({ text, to })
      return true
    },
  }
  return { ctx, ran, sent }
}

describe("dashboardRun", () => {
  const calm = { code: 0, out: "{ 1.00 2.00 3.00 }\n1\n" }

  test("a run that exits 0 appends its output to the log and sends nothing", async () => {
    const dir = scratch()
    const log = join(dir, "dashboard.log")
    const { ctx, ran, sent } = fake(dir, {
      [process.execPath]: { code: 0, out: "synced\n" },
      sysctl: calm,
    })
    await dashboardRun("Changelog sync", ["changelog", "sync"], log)(ctx)
    expect(ran.at(-1)).toEqual([process.execPath, "run", "--cwd", dir, "changelog", "sync"])
    expect(readFileSync(log, "utf8")).toBe("synced\n")
    expect(sent).toEqual([])
  })

  test("a failing run sends the log's last 5 lines to ops and throws its exit code", async () => {
    const dir = scratch()
    const log = join(dir, "dashboard.log")
    writeFileSync(log, "old 1\nold 2\n")
    const { ctx, sent } = fake(dir, {
      [process.execPath]: { code: 2, out: "a\nb\nc\nd\nboom\n" },
      sysctl: calm,
    })
    await expect(dashboardRun("Changelog sync", ["changelog", "sync"], log)(ctx)).rejects.toThrow(
      "exit 2",
    )
    expect(sent).toEqual([
      { text: "Changelog sync failed (exit 2): a | b | c | d | boom", to: "ops" },
    ])
  })

  test("high load or critical pressure skips the run and tells ops", async () => {
    for (const out of ["{ 1.00 12.01 3.00 }\n1\n", "{ 1.00 2.00 3.00 }\n4\n"]) {
      const dir = scratch()
      const { ctx, ran, sent } = fake(dir, { sysctl: { code: 0, out } })
      await dashboardRun("Changelog sync", ["changelog"], join(dir, "l"))(ctx)
      expect(ran.some((argv) => argv[0] === process.execPath)).toBe(false)
      expect(sent[0]?.to).toBe("ops")
      expect(sent[0]?.text).toMatch(/^Changelog sync skipped: load5 [\d.]+, pressure \d$/)
    }
  })

  test("a busy pattern in ps skips the run quietly", async () => {
    const dir = scratch()
    const { ctx, ran, sent } = fake(dir, {
      ps: { code: 0, out: "COMMAND\nbun api/hono/src/plugins/changelog/cli.ts seed\n" },
      sysctl: calm,
    })
    await dashboardRun(
      "Changelog sync",
      ["changelog", "sync"],
      join(dir, "l"),
      /changelog\/cli\.ts seed|changelog seed/,
    )(ctx)
    expect(ran.some((argv) => argv[0] === process.execPath)).toBe(false)
    expect(sent).toEqual([])
  })
})

describe("failureOf", () => {
  test("a long stack keeps its first error line and the tail's end, inside notify.sh's cut", () => {
    const frames = Array.from(
      { length: 12 },
      (_, i) =>
        `    at frame${i} (/a/very/long/path/to/node_modules/@t3-oss/env-core/dist/index.js:32:13)`,
    )
    const out = [
      "$ bun run changelog sync",
      "error: Invalid environment variables: POSTGRES_URL",
      ...frames,
      "",
      "Bun v1.4.0 (macOS arm64)",
    ].join("\n")
    const line = `Changelog sync failed (exit 1): ${failureOf(out, out)}`
    expect(line.length).toBeLessThanOrEqual(400)
    expect(line).toContain("error: Invalid environment variables: POSTGRES_URL | ")
    expect(line).toEndWith("Bun v1.4.0 (macOS arm64)")
  })

  test("an error already in the tail is not sent twice", () => {
    expect(failureOf("x\nerror: boom\n", "a\nb\nerror: boom\n")).toBe("a | b | error: boom")
  })
})

describe("sendAs", () => {
  test("queues a job named ops-<name> to ops-<name>.jsonl, not ops-ops-<name>.jsonl", async () => {
    const config = scratch()
    const before = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    process.env.PLAYGROUND_DATA_DIR = join(config, "playground")
    try {
      await sendAs("ops-changelog")("ops", "hello")
      await sendAs("tick")("ops", "control")
      await sendAs("channel-watch", true)("dispatcher", "w".repeat(1500))
      await sendAs("channel-watch")("dispatcher", "c".repeat(1500))
      await sendAs("wa", true, true)("dispatcher", "made-up owner words")
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
      delete process.env.PLAYGROUND_DATA_DIR
    }
    const outbox = join(config, "playground", "ops", "outbox")
    expect((await Array.fromAsync(new Bun.Glob("*.jsonl").scan(outbox))).sort()).toEqual([
      "ops-changelog.jsonl",
      "ops-channel-watch.jsonl",
      "ops-tick.jsonl",
      "ops-wa.jsonl",
    ])
    const watched = (await Bun.file(join(outbox, "ops-channel-watch.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { text: string }).text.length)
    expect(watched).toEqual([1500, 400])
    // a private line reaches the outbox whole and alerts.log by its length alone
    const log = await Bun.file(join(config, "playground", "ops", "alerts.log")).text()
    expect(log).toContain("[ops-wa → dispatcher] (a private line of 19 characters)")
    expect(log).not.toContain("made-up owner words")
    expect(await Bun.file(join(outbox, "ops-wa.jsonl")).text()).toContain("made-up owner words")
  })
})

// Linux has neither sysctl name: procps's sysctl names each it cannot stat and exits 255, so the gate reads /proc's text, and a reading neither gives holds the run, never reading as 0 or NaN (#2201).
describe("dashboardRun's gate where sysctl has neither name", () => {
  const LINUX = {
    code: 255,
    out: "sysctl: cannot stat /proc/sys/vm/loadavg: No such file or directory\nsysctl: cannot stat /proc/sys/kern/memorystatus_vm_pressure_level: No such file or directory\n",
  }
  const saved = process.env.PLAYGROUND_PROC
  afterAll(() => {
    process.env.PLAYGROUND_PROC = saved
  })

  test("gateOf reads /proc/loadavg and PSI's /proc/pressure/memory", () => {
    process.env.PLAYGROUND_PROC = procDir({ full: 12, load5: 13.5 })
    expect(gateOf(LINUX.out, LINUX.code)).toEqual({ load5: 13.5, pressure: 4 })
  })

  test("a calm Linux machine runs it", async () => {
    process.env.PLAYGROUND_PROC = procDir({ load5: 2 })
    const dir = scratch()
    const { ctx, ran, sent } = fake(dir, {
      [process.execPath]: { code: 0, out: "synced\n" },
      sysctl: LINUX,
    })
    await dashboardRun("Changelog sync", ["changelog", "sync"], join(dir, "l"))(ctx)
    expect(ran.at(-1)).toEqual([process.execPath, "run", "--cwd", dir, "changelog", "sync"])
    expect(sent).toEqual([])
  })

  test("critical PSI skips the run and tells ops", async () => {
    process.env.PLAYGROUND_PROC = procDir({ full: 10, some: 40 })
    const dir = scratch()
    const { ctx, ran, sent } = fake(dir, { sysctl: LINUX })
    await dashboardRun("Changelog sync", ["changelog"], join(dir, "l"))(ctx)
    expect(ran.some((argv) => argv[0] === process.execPath)).toBe(false)
    expect(sent).toEqual([{ text: "Changelog sync skipped: load5 2.5, pressure 4", to: "ops" }])
  })

  test.each([
    ["sysctl exits non-zero", LINUX],
    ["sysctl prints nothing", { code: 0, out: "" }],
    ["sysctl prints no numbers", { code: 0, out: "{ x y z }\nx\n" }],
  ])("%s and /proc gives neither reading: the run is held", async (_, answer) => {
    process.env.PLAYGROUND_PROC = procDir({}, ["loadavg", "pressure/memory"])
    const dir = scratch()
    const { ctx, ran, sent } = fake(dir, { sysctl: answer })
    await dashboardRun("Changelog sync", ["changelog"], join(dir, "l"))(ctx)
    expect(ran.some((argv) => argv[0] === process.execPath)).toBe(false)
    expect(sent).toEqual([
      { text: "Changelog sync skipped: load5 unread, pressure unread", to: "ops" },
    ])
  })
})
