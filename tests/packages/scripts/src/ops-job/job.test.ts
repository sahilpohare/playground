import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  dashboardRun,
  failureOf,
  gateOf,
  hold,
  sendAs,
} from "../../../../../packages/scripts/src/ops-job/job"
import type { Context } from "../../../../../packages/scripts/src/ops-tick/tick"

const dirs: string[] = []
afterAll(() => {
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
