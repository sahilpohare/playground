import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { setSessionNames } from "../../../../../packages/config/src/kinds"
import {
  autoEnd,
  BEATS,
  type Context,
  cronMatches,
  cycle,
  idleCompact,
  leadOf,
  nextDue,
  resultOf,
  runSlotHold,
  runner,
  switchAccount,
  trashPurge,
} from "../../../../../packages/scripts/src/ops-tick/tick"
import { NO_CHECKOUT } from "../../../../../packages/scripts/src/playground/probe"
import { storeWith } from "../../../../scripts/hooks/render-set"
import { OLD, OLD_AS_NAMES, SEEDED_NAMES } from "../../../../session-names"
import { watchTorn } from "../torn-reads"
import { type Answers, fakeRun } from "./fake-run"

// A machine whose sessions.names keep the old names, which this file's fallbacks name.
beforeAll(() => setSessionNames(OLD_AS_NAMES))
afterAll(() => setSessionNames(SEEDED_NAMES))

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A scratch acme folder: ops under it, the roster beside it.
const scratch = (): string => {
  const acme = join(realpathSync(mkdtempSync(join(tmpdir(), "ops-tick-"))), OLD.dispatcher)
  dirs.push(acme)
  mkdirSync(join(acme, "ops"), { recursive: true })
  return join(acme, "ops")
}

// Machine wall time, as the old crons read it.
const at = (hour: number, minute: number) => new Date(2026, 9, 19, hour, minute, 10)

// A fake context: each script's answer by a word of its argv (fakeRun), every run and every line sent recorded; a line holding a word of fails throws, as notify.sh failing does.
const fake = (ops: string, now: Date, answers: Answers = {}, fails: string[] = []) => {
  const { inputs, run, runs } = fakeRun(answers)
  const sent: { text: string; to: string }[] = []
  const ctx: Context = {
    now,
    ops,
    repo: "/repo",
    run,
    send: async (to, text) => {
      if (fails.some((word) => text.includes(word))) throw new Error("notify.sh exited 1")
      sent.push({ text, to })
      return true
    },
  }
  return { ctx, inputs, runs, sent }
}

const beat = (name: string) => BEATS.find((b) => b.name === name)!

const QUIET_LOAD = { "vm.loadavg": "{ 2.10 3.40 4.00 }" }

// ps's lines as the load report reads them: CPU, pid, command
const PS =
  "  300.0  4242 /Users/me/.bun/bin/bun\n   90.0   311 /Applications/cmux.app/Contents/MacOS/cmux\n   10.0   12 launchd\n    0.0  1 kernel_task\n    0.0  2 idle"

// bun run ask new's stdout, the posted item's id on a line of its own
const ASKED = { "ask new": "f167b6b9-f570-4f15-a4b4-eb15b8c4876f\n#i601\n" }

// The Inbox alerts a beat posted, by their titles
const alertTitles = (inputs: string[]) => inputs.map((input) => JSON.parse(input).title)

describe("up", () => {
  test("runs ops-up every 5 minutes and tells ops each line it prints once, until the line changes (#1275)", async () => {
    const ops = scratch()
    const up = beat("up")
    expect(up.cron).toBe("*/5 * * * *")
    const said = "started ops-dashboard in herdr (heartbeat 7m old)"
    const first = fake(ops, at(13, 5), { "up.py": said })
    await up.run(first.ctx)
    expect(first.runs).toEqual([["python3", "-I", "/repo/scripts/ops/up.py"]])
    expect(first.sent).toEqual([{ text: said, to: "ops" }])
    const failed = "could not start ops-dashboard in herdr (process gone); see up.log"
    const again = fake(ops, at(13, 10), { "up.py": `${said}\n${failed}` })
    await up.run(again.ctx)
    expect(again.sent).toEqual([{ text: failed, to: "ops" }])
    const quiet = fake(ops, at(13, 15), { "up.py": failed })
    await up.run(quiet.ctx)
    expect(quiet.sent).toEqual([])
  })
})

// the sweep's ends, each line to its lead, and a session it could not end told once until its line changes.
describe("auto-end", () => {
  test("runs every 5 minutes, sends each end to its lead, and a refusal once", async () => {
    const ops = scratch()
    expect(beat("auto-end").cron).toBe("*/5 * * * *")
    const refused = {
      text: "Not ended q6dmtb-worker (worker-prs-done (merged)): uncommitted work in /wt; push it, then close it",
      to: "builder",
    }
    const ended = { text: "Ended m4tqzr-reviewer: checker-pr-done (merged)", to: "builder" }
    const first = fake(ops, at(13, 5))
    await autoEnd(async () => [ended, refused])(first.ctx)
    expect(first.sent).toEqual([ended, refused])
    const again = fake(ops, at(13, 10))
    await autoEnd(async () => [refused])(again.ctx)
    expect(again.sent).toEqual([])
  })
})

describe("cron", () => {
  test("reads minute lists, steps and hours in machine wall time", () => {
    expect(cronMatches("3,18,33,48 * * * *", at(13, 33))).toBe(true)
    expect(cronMatches("3,18,33,48 * * * *", at(13, 34))).toBe(false)
    expect(cronMatches("*/5 * * * *", at(9, 55))).toBe(true)
    expect(cronMatches("7 */2 * * *", at(14, 7))).toBe(true)
    expect(cronMatches("7 */2 * * *", at(13, 7))).toBe(false)
    expect(cronMatches("13 21 * * *", at(21, 13))).toBe(true)
  })

  test("names the next due minute", () => {
    expect(nextDue("13 21 * * *", at(13, 0))).toEqual(new Date(2026, 9, 19, 21, 13))
    expect(nextDue("*/5 * * * *", at(13, 3))).toEqual(new Date(2026, 9, 19, 13, 5))
  })

  test("refuses a cron it cannot read", () => {
    expect(() => cronMatches("every 5", at(1, 1))).toThrow()
    expect(() => cronMatches("61 * * * *", at(1, 1))).toThrow()
  })
})

describe("roll gate", () => {
  test("names a paused file over 30 minutes old to ops, once a file, and leaves roll-now unwritten (#1253)", async () => {
    const ops = scratch()
    mkdirSync(join(ops, "dashboard"))
    writeFileSync(join(ops, "dashboard", "paused"), "")
    const now = at(13, 0)
    utimesSync(
      join(ops, "dashboard", "paused"),
      (now.getTime() - 45 * 60_000) / 1000,
      (now.getTime() - 45 * 60_000) / 1000,
    )
    const first = fake(ops, now)
    await beat("roll-gate").run(first.ctx)
    expect(await Bun.file(join(ops, "dashboard", "roll-now")).exists()).toBe(false)
    expect(first.sent).toEqual([{ text: "ops/dashboard/paused is 45 min old", to: "ops" }])
    const again = fake(ops, at(13, 5))
    await beat("roll-gate").run(again.ctx)
    expect(again.sent).toEqual([])
  })

  test("a paused chase whose minutes change each run goes out once, as it reads then, after the relay was down for 5 runs", async () => {
    const ops = scratch()
    mkdirSync(join(ops, "dashboard"))
    const paused = join(ops, "dashboard", "paused")
    writeFileSync(paused, "")
    utimesSync(paused, at(13, 0), at(13, 0))
    const jobs = runner()
    const lines: string[] = []
    for (const minute of [35, 40, 45, 50, 55]) {
      const { ctx } = fake(ops, at(13, minute), {}, ["paused is"])
      await Promise.all(cycle(ctx, jobs, [beat("roll-gate")]))
      expect(resultOf(jobs)).toBe("roll-gate: send to ops failed: notify.sh exited 1")
    }
    for (const hour of [14, 15]) {
      const { ctx, sent } = fake(ops, new Date(2026, 9, 19, hour, 0, 10))
      await Promise.all(cycle(ctx, jobs, [beat("roll-gate")]))
      lines.push(...sent.map((line) => `${line.to}: ${line.text}`))
    }
    expect(lines).toEqual(["ops: ops/dashboard/paused is 60 min old"])
    expect(resultOf(jobs)).toBe("ok")
  })

  test("a quiet run, with no paused file, writes nothing, so the dashboard's roll holds stand", async () => {
    const ops = scratch()
    const { ctx, sent } = fake(ops, at(13, 0))
    await beat("roll-gate").run(ctx)
    expect(await Bun.file(join(ops, "dashboard", "roll-now")).exists()).toBe(false)
    expect(sent).toEqual([])
  })
})

// #1779: a run-slot hold past 30 minutes while a waiter queues is told to ops once per hold.
describe("run-slot hold", () => {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
  // A pid known dead: a child spawned and awaited is gone by the time it returns
  const deadPid = async (): Promise<number> => {
    const child = Bun.spawn(["true"])
    await child.exited
    return child.pid
  }
  const hold = (
    ops: string,
    slot: string,
    who: string,
    pid: number,
    sinceMs: number,
    waiters: string[],
  ) => {
    writeFileSync(join(ops, `${slot}.holder`), `${who} ${pid} ${iso(sinceMs)} 4 3\n`)
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    for (const ticket of waiters) writeFileSync(join(ops, "run-slot.waiters", ticket), "")
    appendFileSync(
      join(ops, "run-slot.runs.log"),
      `2026-10-19T12:00:00Z ask ${who} ${pid} bun run test:file tests/scripts/long.test.ts\n`,
    )
  }
  // Counts the Bun.file calls that name run-slot.runs.log during run()
  const runsLogReads = async (run: () => Promise<void>): Promise<number> => {
    const spy = spyOn(Bun, "file")
    try {
      await run()
      return spy.mock.calls.filter((c) => String(c[0]).endsWith("run-slot.runs.log")).length
    } finally {
      spy.mockRestore()
    }
  }

  test("a hold past 30 minutes with a waiter queued tells ops once, naming the holder, its command and its run time", async () => {
    const ops = scratch()
    const now = at(13, 10)
    const since = now.getTime() - 40 * 60_000
    hold(ops, "run-slot", "g7wkr2-worker", process.pid, since, [
      `1760000000-${process.pid}-y8wqk2-worker`,
    ])
    hold(ops, "run-slot-2", "k3v9q2-worker", process.pid, now.getTime() - 10 * 60_000, [])
    const { ctx, sent } = fake(ops, now)
    await runSlotHold(ctx)
    expect(sent).toEqual([
      {
        text: `run-slot: g7wkr2-worker's run has held run-slot for 40 min while 1 waiter queues: bun run test:file tests/scripts/long.test.ts (pid ${process.pid}, since ${iso(since)})`,
        to: "ops",
      },
    ])
  })

  test("a hold past 30 minutes with no live waiter queued tells ops nothing", async () => {
    const ops = scratch()
    const now = at(13, 10)
    const dead = await deadPid()
    hold(ops, "run-slot", "g7wkr2-worker", process.pid, now.getTime() - 40 * 60_000, [
      `1760000000-${dead}-y8wqk2-worker`,
    ])
    const { ctx, sent } = fake(ops, now)
    await runSlotHold(ctx)
    expect(sent).toEqual([])
  })

  test("a due hold with no waiter at all reads no runs.log and sends nothing", async () => {
    const ops = scratch()
    const now = at(13, 10)
    hold(ops, "run-slot", "g7wkr2-worker", process.pid, now.getTime() - 40 * 60_000, [])
    const { ctx, sent } = fake(ops, now)
    const reads = await runsLogReads(() => runSlotHold(ctx))
    expect(sent).toEqual([])
    expect(reads).toBe(0)
  })

  test("a second pass on the same hold tells nothing more", async () => {
    const ops = scratch()
    const now = at(13, 10)
    hold(ops, "run-slot", "g7wkr2-worker", process.pid, now.getTime() - 40 * 60_000, [
      `1760000000-${process.pid}-y8wqk2-worker`,
    ])
    const first = fake(ops, now)
    await runSlotHold(first.ctx)
    expect(first.sent).toHaveLength(1)
    const second = fake(ops, at(13, 15))
    const reads = await runsLogReads(() => runSlotHold(second.ctx))
    expect(second.sent).toEqual([])
    expect(reads).toBe(0)
  })

  test("a pass with no hold due reads no runs.log, and sends nothing", async () => {
    const ops = scratch()
    const now = at(13, 10)
    hold(ops, "run-slot", "g7wkr2-worker", process.pid, now.getTime() - 10 * 60_000, [
      `1760000000-${process.pid}-y8wqk2-worker`,
    ])
    const { ctx, sent } = fake(ops, now)
    const reads = await runsLogReads(() => runSlotHold(ctx))
    expect(sent).toEqual([])
    expect(reads).toBe(0)
  })

  test("a due hold still alerts once, reading runs.log once", async () => {
    const ops = scratch()
    const now = at(13, 10)
    const since = now.getTime() - 40 * 60_000
    hold(ops, "run-slot", "g7wkr2-worker", process.pid, since, [
      `1760000000-${process.pid}-y8wqk2-worker`,
    ])
    const { ctx, sent } = fake(ops, now)
    const reads = await runsLogReads(() => runSlotHold(ctx))
    expect(sent).toEqual([
      {
        text: `run-slot: g7wkr2-worker's run has held run-slot for 40 min while 1 waiter queues: bun run test:file tests/scripts/long.test.ts (pid ${process.pid}, since ${iso(since)})`,
        to: "ops",
      },
    ])
    expect(reads).toBe(1)
  })
})

describe("tick", () => {
  const MARKS = [
    "acme@example.com: week 91% (resets Tue 14:00Z), rate 1.2%/h; today 10% spent",
    "ALERT 90 acme@example.com: week at 91%, past 90%",
    "ALERT 98 pride@example.com: week at 98%, past 98%",
  ].join("\n")

  test(`routes each alert as the old tick did: usage marks to the builder, a switch due and near-limit lines to ${OLD.dispatcher}`, async () => {
    const { ctx, inputs, sent } = fake(scratch(), at(13, 3), {
      ...ASKED,
      "login-flip.py": "switch due: move to pride@",
      "near-limit.py": "ALERT 5h acme@: 5-hour window at 86%\nweek passed 80% on pride@",
      "pcpu=": PS,
      "vm.loadavg": "{ 12.00 16.50 9.00 }",
      "week-marks.py": MARKS,
    })
    await beat("tick").run(ctx)
    expect(sent).toEqual([
      { text: "ALERT 90 acme@example.com: week at 91%, past 90%", to: "builder" },
      { text: "ALERT 98 pride@example.com: week at 98%, past 98%", to: "builder" },
      { text: `usage: ${MARKS.split("\n")[0]}`, to: "builder" },
      { text: "switch due: move to pride@", to: "dispatcher" },
      {
        text: "load5 16.5: bun pid 4242: 300% CPU cmux pid 311: 90% CPU launchd pid 12: 10% CPU kernel_task pid 1: 0% CPU",
        to: "builder",
      },
      { text: "ALERT 5h acme@: 5-hour window at 86%", to: "builder" },
      { text: "week passed 80% on pride@", to: "dispatcher" },
    ])
    expect(alertTitles(inputs)).toEqual(["ALERT 98 pride@example.com: week at 98%, past 98%"])
    expect(JSON.parse(inputs[0]!).preview.text).toContain("[System page](/dashboard/system)")
  })

  test("an Inbox alert that fails to post is named to the builder, and its line still goes", async () => {
    const { ctx, sent } = fake(scratch(), at(13, 3), {
      ...QUIET_LOAD,
      "ask new": { code: 1, err: "error: the dashboard is down\n" },
      "week-marks.py": MARKS,
    })
    await beat("tick").run(ctx)
    expect(sent.slice(0, 3)).toEqual([
      { text: "ALERT 90 acme@example.com: week at 91%, past 90%", to: "builder" },
      {
        text: "Inbox alert not posted: bun run ask new: error: the dashboard is down",
        to: "builder",
      },
      { text: "ALERT 98 pride@example.com: week at 98%, past 98%", to: "builder" },
    ])
  })

  test("a failed send mid-beat posts the Inbox alert, keeps the beat's other sends, is named on the heartbeat and goes again at the next run", async () => {
    const ops = scratch()
    const state = runner()
    const first = fake(
      ops,
      at(13, 3),
      {
        ...QUIET_LOAD,
        ...ASKED,
        "near-limit.py": "week passed 80% on pride@",
        "week-marks.py": MARKS,
      },
      ["ALERT 98"],
    )
    await Promise.all(cycle(first.ctx, state, [beat("tick")]))
    expect(first.sent.map((line) => line.text)).toEqual([
      "ALERT 90 acme@example.com: week at 91%, past 90%",
      `usage: ${MARKS.split("\n")[0]}`,
      "week passed 80% on pride@",
    ])
    expect(alertTitles(first.inputs)).toEqual(["ALERT 98 pride@example.com: week at 98%, past 98%"])
    expect(resultOf(state)).toBe("tick: send to builder failed: notify.sh exited 1")
    const next = fake(ops, at(13, 18), QUIET_LOAD)
    await Promise.all(cycle(next.ctx, state, [beat("tick")]))
    expect(next.sent).toEqual([
      { text: "ALERT 98 pride@example.com: week at 98%, past 98%", to: "builder" },
    ])
    expect(resultOf(state)).toBe("ok")
  })

  test("a load line whose reading changes each tick goes out once, as it reads then, after the relay was down for 5 ticks", async () => {
    const ops = scratch()
    const jobs = runner()
    const busy = (load5: number) => ({
      "pcpu=": "  300.0  4242 bun",
      "vm.loadavg": `{ 12.00 ${load5}.00 9.00 }`,
    })
    for (const [i, hour] of [13, 14, 15, 16, 17].entries()) {
      const { ctx } = fake(ops, at(hour, 18), busy(16 + i), ["load5"])
      await Promise.all(cycle(ctx, jobs, [beat("tick")]))
      expect(resultOf(jobs)).toBe("tick: send to builder failed: notify.sh exited 1")
    }
    const { ctx, sent } = fake(ops, at(18, 18), busy(25))
    await Promise.all(cycle(ctx, jobs, [beat("tick")]))
    expect(sent).toEqual([{ text: "load5 25: bun pid 4242: 300% CPU", to: "builder" }])
    expect(resultOf(jobs)).toBe("ok")
  })

  test("a quiet run sends nothing and posts no Inbox alert", async () => {
    const { ctx, inputs, sent } = fake(scratch(), at(13, 18), {
      ...QUIET_LOAD,
      "week-marks.py": "acme@example.com: week 40%",
    })
    await beat("tick").run(ctx)
    expect(sent).toEqual([])
    expect(inputs).toEqual([])
  })

  // PG-1349: a week alert waited in the owner's Inbox for the owner's Done after its week had reset
  test("an Inbox week alert resolves itself once usage.json reads that account's week back under its mark, and stays while the week is over it (PG-1349)", async () => {
    const ops = scratch()
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({ agents: [{ kind: "ops", name: OLD.ops, role: "manager" }] }),
    )
    const reading = (login: number, spare: number) =>
      writeFileSync(
        join(ops, "..", "usage.json"),
        JSON.stringify({
          account: "acme@example.com",
          accounts: { "pride@example.com": { week: spare } },
          rate_limits: { seven_day: { used_percentage: login } },
        }),
      )
    const resolves = (runs: string[][]) => runs.filter((argv) => argv.includes("resolve"))
    const quiet = { ...QUIET_LOAD, "week-marks.py": "acme@example.com: week 91%" }
    reading(91, 98)
    const posted = fake(ops, at(13, 3), { ...QUIET_LOAD, ...ASKED, "week-marks.py": MARKS })
    await beat("tick").run(posted.ctx)
    expect(alertTitles(posted.inputs)).toEqual([
      "ALERT 98 pride@example.com: week at 98%, past 98%",
    ])
    const over = fake(ops, at(13, 18), quiet)
    await beat("tick").run(over.ctx)
    expect(resolves(over.runs)).toEqual([])
    reading(91, 2)
    const reset = fake(ops, at(13, 33), quiet)
    await beat("tick").run(reset.ctx)
    expect(resolves(reset.runs)).toEqual([
      [
        "bun",
        "run",
        "--silent",
        "--cwd",
        "/repo",
        "ask",
        "resolve",
        "f167b6b9-f570-4f15-a4b4-eb15b8c4876f",
        "--by",
        OLD.ops,
        "--note",
        "pride@example.com's week reset: now 2%",
      ],
    ])
    const after = fake(ops, at(13, 48), quiet)
    await beat("tick").run(after.ctx)
    expect(resolves(after.runs)).toEqual([])
  })

  test("a week alert whose item is gone is dropped, and one whose resolve fails is tried again on the next tick (PG-1349)", async () => {
    const ops = scratch()
    writeFileSync(
      join(ops, "..", "usage.json"),
      JSON.stringify({
        account: "pride@example.com",
        rate_limits: { seven_day: { used_percentage: 98 } },
      }),
    )
    const posted = fake(ops, at(13, 3), {
      ...QUIET_LOAD,
      ...ASKED,
      "week-marks.py": "ALERT 97 pride@example.com: week at 97%, past 97%",
    })
    await beat("tick").run(posted.ctx)
    writeFileSync(
      join(ops, "..", "usage.json"),
      JSON.stringify({
        account: "pride@example.com",
        rate_limits: { seven_day: { used_percentage: 1 } },
      }),
    )
    const quiet = { ...QUIET_LOAD, "week-marks.py": "pride@example.com: week 1%" }
    const failing = fake(ops, at(13, 18), {
      ...quiet,
      "ask resolve": { code: 1, err: "ask: the dashboard is down\n" },
    })
    await expect(beat("tick").run(failing.ctx)).rejects.toThrow("ask: the dashboard is down")
    const gone = fake(ops, at(13, 33), {
      ...quiet,
      "ask resolve": { code: 1, err: "ask: no inbox item f167b6b9-f570-4f15-a4b4-eb15b8c4876f\n" },
    })
    await beat("tick").run(gone.ctx)
    expect(gone.runs.filter((argv) => argv.includes("resolve"))).toHaveLength(1)
    const after = fake(ops, at(13, 48), quiet)
    await beat("tick").run(after.ctx)
    expect(after.runs.filter((argv) => argv.includes("resolve"))).toEqual([])
  })
})

describe("usage-limit watch", () => {
  const state = (ops: string, writtenAt: Date) => {
    mkdirSync(join(ops, "unstick"), { recursive: true })
    mkdirSync(join(ops, "usage"), { recursive: true })
    writeFileSync(
      join(ops, "unstick", "state.json"),
      JSON.stringify({
        blocked: {
          a: { account: "own@example.org", kind: "usage-limit", name: "worker-b" },
          b: { account: "own@example.org", kind: "usage-limit-stuck", name: "worker-a" },
          c: { kind: "permission", name: "worker-c" },
          d: { account: "own@example.org", kind: "usage-limit", name: "worker-told" },
          e: { account: "pride@example.com", kind: "usage-limit", name: "worker-other" },
        },
        writtenAt: writtenAt.toISOString(),
      }),
    )
    writeFileSync(join(ops, "usage", "limit-told.txt"), "worker-told\n")
    usage(ops, "usage.json", "own@example.org", 97, writtenAt)
    usage(ops, "usage-pride.json", "pride@example.com", 100, writtenAt)
    usage(ops, "usage-spare.json", "spare@example.com", 40, writtenAt)
    usage(ops, "usage-burst.json", "burst@example.com", 5, writtenAt, 90)
    usage(
      ops,
      "usage-spare-old.json",
      "spare@example.com",
      10,
      new Date(writtenAt.getTime() - 30 * 60_000),
    )
    usage(
      ops,
      "usage-stale.json",
      "stale@example.com",
      10,
      new Date(writtenAt.getTime() - 2 * 3_600_000),
    )
  }
  const usage = (
    ops: string,
    file: string,
    account: string,
    week: number,
    writtenAt: Date,
    fiveHour = 0,
  ) =>
    writeFileSync(
      join(ops, "..", file),
      JSON.stringify({
        account,
        rate_limits: {
          five_hour: { used_percentage: fiveHour },
          seven_day: { used_percentage: week },
        },
        writtenAt: writtenAt.toISOString(),
      }),
    )
  const LINE =
    "worker-a (own@example.org) worker-b (own@example.org) worker-other (pride@example.com) show the usage-limit screen. Move each to spare@example.com, the account with the most room (week 40%), from its handoff."

  test("names each new session on the usage-limit screen to the builder once", async () => {
    const ops = scratch()
    const now = at(13, 5)
    state(ops, now)
    const first = fake(ops, now)
    await beat("usage-limit-watch").run(first.ctx)
    expect(first.sent).toEqual([{ text: LINE, to: "builder" }])
    const again = fake(ops, now)
    await beat("usage-limit-watch").run(again.ctx)
    expect(again.sent).toEqual([])
  })

  test("a line the relay fails twice is tried once a run, never kept to resend since the watch finds it again, and marked told only once it goes", async () => {
    const ops = scratch()
    state(ops, at(13, 5))
    const jobs = runner()
    const tries: number[] = []
    const lines: string[][] = []
    for (const [minute, failing] of [
      [5, true],
      [15, true],
      [25, false],
      [35, false],
    ] as const) {
      const path = join(ops, "unstick", "state.json")
      const written = JSON.parse(readFileSync(path, "utf8"))
      writeFileSync(path, JSON.stringify({ ...written, writtenAt: at(13, minute).toISOString() }))
      const { ctx, sent } = fake(ops, at(13, minute), {}, failing ? ["usage-limit"] : [])
      const send = ctx.send
      let n = 0
      ctx.send = async (to, text) => {
        n++
        return send(to, text)
      }
      await Promise.all(cycle(ctx, jobs, [beat("usage-limit-watch")]))
      tries.push(n)
      lines.push(sent.map((line) => line.text))
      expect(jobs.unsent.get("usage-limit-watch")).toEqual([])
      expect(resultOf(jobs)).toBe(
        failing ? "usage-limit-watch: send to builder failed: notify.sh exited 1" : "ok",
      )
      expect(readFileSync(join(ops, "usage", "limit-told.txt"), "utf8")).toBe(
        failing ? "worker-told\n" : "worker-told\nworker-a\nworker-b\nworker-other\n",
      )
    }
    expect(tries).toEqual([1, 1, 1, 0])
    expect(lines).toEqual([[], [], [LINE], []])
  })

  test("names no account to move to when every fresh reading is spent or a stuck session's own", async () => {
    const ops = scratch()
    const now = at(13, 5)
    state(ops, now)
    usage(ops, "usage.json", "own@example.org", 30, now)
    usage(ops, "usage-spare.json", "spare@example.com", 100, now)
    const { ctx, sent } = fake(ops, now)
    await beat("usage-limit-watch").run(ctx)
    expect(sent.map((line) => line.text)).toEqual([
      "worker-a (own@example.org) worker-b (own@example.org) worker-other (pride@example.com) show the usage-limit screen. No account has room: each waits for its reset.",
    ])
  })

  test("a state file over 3 minutes old sends nothing", async () => {
    const ops = scratch()
    state(ops, new Date(at(13, 5).getTime() - 4 * 60_000))
    const { ctx, sent } = fake(ops, at(13, 5))
    await beat("usage-limit-watch").run(ctx)
    expect(sent).toEqual([])
  })
})

describe("sweep", () => {
  const UP = [
    "/m/scripts/spawn.sh resume worker-x /m 1111 --backend claude",
    '  then SendMessage worker-x: "cmux restarted; re-read your roster task."',
    `/m/scripts/spawn.sh resume ${OLD.planner} /m 2222`,
    "/m/scripts/spawn.sh resume reviewer-q /m 3333",
    "/m/scripts/spawn.sh resume runner-y /m 4444",
    "/m/scripts/spawn.sh resume worker-parked /m 5555",
    "/m/scripts/spawn.sh resume probe-z /m 6666",
    "/m/scripts/spawn.sh resume worker-done /m 7777",
    "runner-y (pid 42, /m) runs without the factory's hooks: respawn it from its handoff",
  ].join("\n")

  const withRoster = (ops: string) => {
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({
        agents: [
          { name: "worker-x", status: "working" },
          { name: OLD.planner },
          { name: "reviewer-q", worker: OLD.ops },
          { name: "runner-y" },
          { name: "worker-parked", status: "parked" },
          { name: "worker-done", status: "done" },
        ],
      }),
    )
  }

  test("sends each felled session to its lead once, and names a load past 30 once", async () => {
    const ops = scratch()
    const now = at(13, 7)
    withRoster(ops)
    const { ctx, sent } = fake(ops, now, {
      "--sessions": UP,
      "vm.loadavg": "{ 30.00 31.00 20.00 }",
    })
    await beat("sweep").run(ctx)
    expect(sent).toEqual([
      {
        text: 'Felled: /m/scripts/spawn.sh resume worker-x /m 1111 --backend claude then SendMessage worker-x: "cmux restarted; re-read your roster task."',
        to: "builder",
      },
      { text: `Felled: /m/scripts/spawn.sh resume ${OLD.planner} /m 2222`, to: "dispatcher" },
      { text: "Felled: /m/scripts/spawn.sh resume reviewer-q /m 3333", to: "ops" },
      { text: "Felled: /m/scripts/spawn.sh resume runner-y /m 4444", to: "ops" },
      { text: "load5 31 (passed 30); lanes drop to 12", to: "dispatcher" },
      { text: "load5 31: lanes drop to 12", to: "ops" },
    ])
    const again = fake(ops, at(13, 37), { "--sessions": UP, "vm.loadavg": "{ 25.00 25.00 20.00 }" })
    withRoster(ops)
    await beat("sweep").run(again.ctx)
    expect(again.sent).toEqual([])
    const cleared = fake(ops, at(14, 7), { "vm.loadavg": "{ 10.00 20.00 20.00 }" })
    await beat("sweep").run(cleared.ctx)
    expect(existsSync(join(ops, "tick", "load-told"))).toBe(false)
  })

  test("a quiet run sends nothing and runs no ops-up", async () => {
    const ops = scratch()
    const now = at(13, 37)
    withRoster(ops)
    const { ctx, runs, sent } = fake(ops, now, { "vm.loadavg": "{ 29.00 29.00 10.00 }" })
    await beat("sweep").run(ctx)
    expect(sent).toEqual([])
    expect(runs.some((argv) => argv.join(" ") === "python3 -I /repo/scripts/ops/up.py")).toBe(false)
  })

  test("a step that fails is named to ops and the others still run", async () => {
    const ops = scratch()
    const now = at(13, 7)
    withRoster(ops)
    const { ctx, sent } = fake(ops, now, QUIET_LOAD)
    const run = ctx.run
    ctx.run = async (argv, timeoutMs) => {
      if (argv.join(" ").includes("--sessions")) throw new Error("up.py timed out")
      return run(argv, timeoutMs)
    }
    await beat("sweep").run(ctx)
    expect(sent).toEqual([{ text: "ops-tick sweep: felled failed: up.py timed out", to: "ops" }])
  })

  test("a felled line whose send fails is not marked told and goes once at the next sweep", async () => {
    const ops = scratch()
    withRoster(ops)
    const state = runner()
    const first = fake(ops, at(13, 7), { ...QUIET_LOAD, "--sessions": UP }, [
      `resume ${OLD.planner}`,
    ])
    await Promise.all(cycle(first.ctx, state, [beat("sweep")]))
    expect(first.sent.map((line) => line.to)).toEqual(["builder", "ops", "ops"])
    expect(resultOf(state)).toBe("sweep: send to dispatcher failed: notify.sh exited 1")
    withRoster(ops)
    const next = fake(ops, at(13, 37), { ...QUIET_LOAD, "--sessions": UP })
    await Promise.all(cycle(next.ctx, state, [beat("sweep")]))
    expect(next.sent).toEqual([
      { text: `Felled: /m/scripts/spawn.sh resume ${OLD.planner} /m 2222`, to: "dispatcher" },
    ])
    withRoster(ops)
    const after = fake(ops, at(14, 7), { ...QUIET_LOAD, "--sessions": UP })
    await Promise.all(cycle(after.ctx, state, [beat("sweep")]))
    expect(after.sent).toEqual([])
    expect(resultOf(state)).toBe("ok")
  })

  test(`routes a felled session by its name, as ${OLD.ops}'s sweep does`, () => {
    expect([
      leadOf("worker-a", undefined),
      leadOf("reviewer-a", "worker-a"),
      leadOf("tester-a", OLD.ops),
      leadOf("runner-a", undefined),
      leadOf(OLD.builder, undefined),
    ]).toEqual(["builder", "builder", "ops", "ops", "dispatcher"])
  })

  test("routes an <id>-<kind> name by its kind, and a roster kind over the name", () => {
    expect([
      leadOf("h4t9vz-worker", undefined),
      leadOf("b7k2mq-reviewer", "h4t9vz-worker"),
      leadOf("x7mh4d-tester", OLD.ops),
      leadOf("k3m9px-runner", undefined),
      leadOf("plain", undefined, "runner"),
      leadOf("x7mh4d-builder", undefined),
    ]).toEqual(["builder", "builder", "ops", "ops", "ops", "dispatcher"])
  })

  test(`routes a checker of an <id>-ops to ops, as it does ${OLD.ops}'s (PG-1644)`, () => {
    expect(leadOf("x7mh4d-tester", "k3v9q2-ops")).toBe("ops")
    expect(leadOf("ops-dashboard", undefined)).toBe("dispatcher")
  })

  test("skips a felled probe by its kind, whatever its name", async () => {
    const ops = scratch()
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({ agents: [{ kind: "probe", name: "plain" }, { name: "k3m9px-runner" }] }),
    )
    const { ctx, sent } = fake(ops, at(13, 7), {
      "--sessions": [
        "/m/scripts/spawn.sh resume k3m9px-probe /m 1111",
        "/m/scripts/spawn.sh resume plain /m 2222",
        "/m/scripts/spawn.sh resume k3m9px-runner /m 3333",
      ].join("\n"),
      ...QUIET_LOAD,
    })
    await beat("sweep").run(ctx)
    expect(sent).toEqual([
      { text: "Felled: /m/scripts/spawn.sh resume k3m9px-runner /m 3333", to: "ops" },
    ])
  })
})

describe("switch watch, in the tick", () => {
  // usage.json reading that account, in a data folder whose policy sets usage.switchAccount to switch@, and a roster seating both dispatchers unless `second` is false.
  const usage = (ops: string, account: string, used: number, second = true) => {
    storeWith(join(ops, ".."), {}, { "usage.switchAccount": "switch@example.test" })
    const agents = [
      { kind: "dispatcher", name: OLD.dispatcher, status: "working" },
      { kind: "dispatcher", name: `${OLD.dispatcher}-2`, status: second ? "working" : "ended" },
    ]
    writeFileSync(join(ops, "..", "roster.json"), JSON.stringify({ agents }))
    writeFileSync(
      join(ops, "..", "usage.json"),
      JSON.stringify({
        account,
        rate_limits: {
          seven_day: { resets_at: at(13, 0).getTime() / 1000 + 86_400, used_percentage: used },
        },
      }),
    )
  }

  test("tells ops at 98% and, at 100%, writes the move file and sends its text to both dispatchers and both leads, each once a week", async () => {
    const ops = scratch()
    usage(ops, "switch@example.test", 100)
    const { ctx, sent } = fake(ops, at(13, 18), QUIET_LOAD)
    await beat("tick").run(ctx)
    const move = await Bun.file(join(ops, "unstick", "move.json")).json()
    expect(move.to).toBe(`${OLD.dispatcher}-2`)
    expect(Date.parse(move.until) - at(13, 18).getTime()).toBe(4 * 3_600_000)
    expect(sent[0]!.to).toBe("ops")
    expect(sent[0]!.text).toStartWith("switch@ week at 100% (")
    expect(sent.slice(1).map((m) => m.to)).toEqual([
      `${OLD.dispatcher}-2`,
      OLD.dispatcher,
      "builder",
      "ops",
    ])
    expect(sent[1]!.text).toContain(`"to":"${OLD.dispatcher}-2"`)
    const again = fake(ops, at(13, 33), QUIET_LOAD)
    await beat("tick").run(again.ctx)
    expect(again.sent).toEqual([])
  })

  // the move hands the factory to the second dispatcher, which resumes every stopped session; with none running, ops-unstick's own alerts carry on
  test("at 100% with no second dispatcher seated, writes no move file and tells the first and both leads", async () => {
    const ops = scratch()
    usage(ops, "switch@example.test", 100, false)
    const { ctx, sent } = fake(ops, at(13, 18), QUIET_LOAD)
    await beat("tick").run(ctx)
    expect(existsSync(join(ops, "unstick", "move.json"))).toBe(false)
    expect(sent.slice(1).map((m) => m.to)).toEqual([OLD.dispatcher, "builder", "ops"])
    expect(sent[1]!.text).toBe("switch@ week at 100%: no second dispatcher is seated, so no move")
    const again = fake(ops, at(13, 33), QUIET_LOAD)
    await beat("tick").run(again.ctx)
    expect(again.sent).toEqual([])
  })

  test("at 100%, the move and its text go to the dispatchers the roster seats by slot (PG-1644)", async () => {
    const ops = scratch()
    usage(ops, "switch@example.test", 100)
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({
        agents: [
          { kind: "dispatcher", name: "m4n7vw-dispatcher", status: "working" },
          { kind: "dispatcher", name: "q8r2tx-dispatcher", slot: "2", status: "working" },
        ],
      }),
    )
    const { ctx, sent } = fake(ops, at(13, 18), QUIET_LOAD)
    await beat("tick").run(ctx)
    expect((await Bun.file(join(ops, "unstick", "move.json")).json()).to).toBe("q8r2tx-dispatcher")
    expect(sent.slice(1).map((m) => m.to)).toEqual([
      "q8r2tx-dispatcher",
      "m4n7vw-dispatcher",
      "builder",
      "ops",
    ])
  })

  test("a failed send at 100% goes again on the next tick alone, after a restart too, with the same move file, and the others are told once", async () => {
    const ops = scratch()
    usage(ops, "switch@example.test", 100)
    const jobs = runner()
    const first = fake(ops, at(13, 18), QUIET_LOAD)
    const send = first.ctx.send
    first.ctx.send = async (to, text) => {
      if (to === "builder") throw new Error("notify.sh exited 1")
      return send(to, text)
    }
    await Promise.all(cycle(first.ctx, jobs, [beat("tick")]))
    expect(first.sent.map((m) => m.to)).toEqual([
      "ops",
      `${OLD.dispatcher}-2`,
      OLD.dispatcher,
      "ops",
    ])
    expect(resultOf(jobs)).toBe("tick: send to builder failed: notify.sh exited 1")
    const move = readFileSync(join(ops, "unstick", "move.json"), "utf8")
    const restarted = runner()
    const next = fake(ops, at(13, 33), QUIET_LOAD)
    await Promise.all(cycle(next.ctx, restarted, [beat("tick")]))
    expect(next.sent.map((m) => m.to)).toEqual(["builder"])
    expect(next.sent[0]!.text).toContain(move.trim())
    expect(readFileSync(join(ops, "unstick", "move.json"), "utf8")).toBe(move)
    expect(resultOf(restarted)).toBe("ok")
    const after = fake(ops, at(13, 48), QUIET_LOAD)
    await Promise.all(cycle(after.ctx, restarted, [beat("tick")]))
    expect(after.sent).toEqual([])
  })

  test("another account, or a week under 98%, sends nothing and writes no move file", async () => {
    for (const [account, used] of [
      ["other@example.test", 100],
      ["switch@example.test", 97],
    ] as const) {
      const ops = scratch()
      usage(ops, account, used)
      const { ctx, sent } = fake(ops, at(13, 18), QUIET_LOAD)
      await beat("tick").run(ctx)
      expect(sent).toEqual([])
      expect(existsSync(join(ops, "unstick", "move.json"))).toBe(false)
    }
  })
})

describe("the beats that send no line", () => {
  test("GLM credits writes one log line from ops-zai-usage's file while its beat is fresh", async () => {
    const ops = scratch()
    const now = at(13, 43)
    writeFileSync(
      join(ops, "ops-zai-usage.json"),
      JSON.stringify({ lastBeatAt: now.toISOString(), lastResult: "ok" }),
    )
    writeFileSync(
      join(ops, "..", "zai-usage.json"),
      JSON.stringify({ windows: { week: { used: 5 } } }),
    )
    const { ctx, runs, sent } = fake(ops, now)
    await beat("glm-credits").run(ctx)
    expect(sent).toEqual([])
    expect(runs).toEqual([])
    expect(await Bun.file(join(ops, "log", "glm-credits.log")).text()).toContain(
      'cache {"week":{"used":5}}',
    )
  })

  test("GLM credits reads the endpoint once when the beat is stale", async () => {
    const ops = scratch()
    const { ctx, runs } = fake(ops, at(13, 43), { "glm-credits.py": "5h 10/100" })
    await beat("glm-credits").run(ctx)
    expect(runs.length).toBe(1)
    expect(await Bun.file(join(ops, "log", "glm-credits.log")).text()).toContain("fresh 5h 10/100")
  })

  test("the trash purge runs hourly on the trash beside ops, removing batches over 7 days old", async () => {
    expect(beat("trash-purge").cron).toBe("17 * * * *")
    const ops = scratch()
    const trash = join(ops, "..", "trash")
    const now = new Date("2026-11-02T12:17:00Z")
    mkdirSync(join(trash, "20261020T000000Z-s", "1"), { recursive: true })
    mkdirSync(join(trash, "20261101T000000Z-s", "1"), { recursive: true })
    const { ctx, runs, sent } = fake(ops, now)
    await trashPurge(undefined, () => 100e9)(ctx)
    expect(existsSync(join(trash, "20261020T000000Z-s"))).toBe(false)
    expect(existsSync(join(trash, "20261101T000000Z-s"))).toBe(true)
    expect(runs).toEqual([])
    expect(sent).toEqual([])
    expect(await Bun.file(join(ops, "log", "trash-purge.log")).text()).toContain(
      "removed 1 (20261020T000000Z-s)",
    )
  })

  test("the trash purge removes its batch at any load", async () => {
    const ops = scratch()
    const trash = join(ops, "..", "trash")
    const now = new Date("2026-11-02T12:17:00Z")
    mkdirSync(join(trash, "20261020T000000Z-s", "1"), { recursive: true })
    mkdirSync(join(trash, "20261101T000000Z-s", "1"), { recursive: true })
    const { ctx, runs, sent } = fake(ops, now)
    await trashPurge(
      undefined,
      () => 100e9,
      async () => {},
    )(ctx)
    expect(existsSync(join(trash, "20261020T000000Z-s"))).toBe(false)
    expect(existsSync(join(trash, "20261101T000000Z-s"))).toBe(true)
    expect(runs).toEqual([])
    expect(sent).toEqual([])
    const log = await Bun.file(join(ops, "log", "trash-purge.log")).text()
    expect(log).toContain("removed 1 (20261020T000000Z-s)")
    expect(log).not.toContain("left for load")
  })

  test("the trash purge strips rebuildables from the batches it keeps", async () => {
    const ops = scratch()
    const trash = join(ops, "..", "trash")
    const now = new Date("2026-11-02T12:17:00Z")
    mkdirSync(join(trash, "20261020T000000Z-s", "1"), { recursive: true })
    mkdirSync(join(trash, "20261101T000000Z-s", "1", "review-clone", "node_modules", "react"), {
      recursive: true,
    })
    writeFileSync(
      join(trash, "20261101T000000Z-s", "1", "review-clone", "node_modules", "react", "index.js"),
      "x",
    )
    writeFileSync(
      join(trash, "20261101T000000Z-s", "manifest.jsonl"),
      `${JSON.stringify({
        at: "2026-11-01T00:00:00.000Z",
        files: 1,
        id: "20261101T000000Z-s/1",
        path: "/desk/wt",
        reason: "playground rm",
        session: "s",
        size: 10,
      })}\n`,
    )
    const { ctx, runs, sent } = fake(ops, now)
    await trashPurge(
      undefined,
      () => 100e9,
      async () => {},
    )(ctx)
    expect(existsSync(join(trash, "20261020T000000Z-s"))).toBe(false)
    expect(existsSync(join(trash, "20261101T000000Z-s"))).toBe(true)
    expect(existsSync(join(trash, "20261101T000000Z-s", "1", "review-clone", "node_modules"))).toBe(
      false,
    )
    expect(runs).toEqual([])
    expect(sent).toEqual([])
    expect(await Bun.file(join(ops, "log", "trash-purge.log")).text()).toContain(
      "removed 1 (20261020T000000Z-s), stripped 1 folders (20261101T000000Z-s)",
    )
  })

  test("the idle compact runs the Dashboard checkout's idle-compact bin straight every 5 minutes and logs each line it prints", async () => {
    expect(beat("idle-compact").cron).toBe("*/5 * * * *")
    const ops = scratch()
    const said = "compacted aaaaaa-worker: 250k tokens, idle 55 min\n"
    const { ctx, runs, sent } = fake(ops, at(20, 5), { "idle-compact": said })
    await idleCompact(ctx, "/desk")
    expect(runs).toEqual([
      [
        "env",
        "PLAYGROUND_LIVE_READS=1",
        "bun",
        "--cwd",
        "/desk/api/hono",
        "--no-env-file",
        "/desk/api/hono/src/bin/idle-compact.ts",
      ],
    ])
    expect(runs[0]).not.toContain("run")
    expect(runs[0]).toContain("/desk/api/hono/src/bin/idle-compact.ts")
    expect(sent).toEqual([])
    expect(await Bun.file(join(ops, "log", "idle-compact.log")).text()).toContain(
      "compacted aaaaaa-worker: 250k tokens, idle 55 min",
    )
  })

  test("the idle compact refuses with no Dashboard checkout, writes no log line on a quiet pass, and a failed pass reads failed", async () => {
    const ops = scratch()
    await expect(idleCompact(fake(ops, at(20, 5)).ctx, null)).rejects.toThrow(NO_CHECKOUT)
    expect(existsSync(join(ops, "log", "idle-compact.log"))).toBe(false)
    const quiet = fake(ops, at(20, 5))
    await idleCompact(quiet.ctx, "/desk")
    expect(existsSync(join(ops, "log", "idle-compact.log"))).toBe(false)
    const failing = fake(ops, at(20, 10), { "idle-compact": { code: 1, err: "herdr is down\n" } })
    await expect(idleCompact(failing.ctx, "/desk")).rejects.toThrow("idle-compact: herdr is down")
  })
})

describe("the optimizer's beats", () => {
  test.each([
    ["optimizer-tick", "optimizer tick"],
    ["optimizer-daily", "optimizer daily"],
  ])("%s sends its words to the optimizer", async (name, words) => {
    const { ctx, sent } = fake(scratch(), at(14, 7))
    await beat(name).run(ctx)
    expect(sent).toEqual([{ text: words, to: "optimizer" }])
  })
})

describe("cycle", () => {
  test("starts only the beats due this minute, once a minute, and names a beat that failed", async () => {
    const ran: string[] = []
    const beats = [
      { cron: "*/5 * * * *", name: "five", run: async () => void ran.push("five"), to: "x" },
      { cron: "3 * * * *", name: "three", run: async () => void ran.push("three"), to: "x" },
      {
        cron: "*/5 * * * *",
        name: "broken",
        run: async () => {
          throw new Error("no file")
        },
        to: "x",
      },
    ]
    const state = runner()
    const { ctx } = fake(scratch(), at(13, 5))
    await Promise.all(cycle(ctx, state, beats))
    await Promise.all(cycle({ ...ctx, now: new Date(at(13, 5).getTime() + 20_000) }, state, beats))
    expect(ran).toEqual(["five"])
    expect(resultOf(state)).toBe("broken: no file")
  })
})

describe("canary pull", () => {
  // A real git: an origin, a clone on main with two canary-side worktrees (one clean, one with an open change) and one on another branch, then a commit on origin's canary.
  const git = (cwd: string, ...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe", stdout: "pipe" })
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
    return proc.stdout.toString().trim()
  }
  const realRun: Context["run"] = async (argv) => {
    const proc = Bun.spawnSync(argv, { stderr: "pipe", stdout: "pipe" })
    return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() }
  }
  const world = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "canary-pull-")))
    dirs.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    git(seed, "init", "-q", "-b", "main")
    git(
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    )
    git(seed, "branch", "canary")
    const origin = join(root, "origin.git")
    git(root, "clone", "-q", "--bare", seed, origin)
    const repo = join(root, "repo")
    git(root, "clone", "-q", origin, repo)
    const leads = join(repo, ".claude", "worktrees", "leads")
    git(repo, "worktree", "add", "-q", "-b", "canary", leads, "origin/canary")
    git(leads, "branch", "-q", "--set-upstream-to", "origin/canary")
    const other = join(repo, ".claude", "worktrees", "other")
    git(repo, "worktree", "add", "-q", "-b", "pg-1-x", other, "origin/canary")
    git(seed, "checkout", "-q", "canary")
    git(
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "two",
    )
    git(seed, "push", "-q", origin, "canary")
    return { leads, origin, other, repo, root, seed }
  }

  test("fast-forwards a clean canary worktree to origin's head and leaves every other branch as it is", async () => {
    const w = world()
    const before = git(w.other, "rev-parse", "HEAD")
    const { ctx, sent } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run: realRun })
    expect(git(w.leads, "rev-parse", "HEAD")).toBe(git(w.origin, "rev-parse", "canary"))
    expect(git(w.other, "rev-parse", "HEAD")).toBe(before)
    expect(sent).toEqual([])
  })

  test("fast-forwards a clean leads worktree to the origin branch it tracks, main on a public install", async () => {
    const w = world()
    const leads = join(w.repo, ".claude", "worktrees", "public-leads")
    git(w.repo, "worktree", "add", "-q", "--track", "-B", "leads", leads, "origin/main")
    git(w.seed, "checkout", "-q", "main")
    git(
      w.seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "three",
    )
    git(w.seed, "push", "-q", w.origin, "main")
    const { ctx, sent } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run: realRun })
    expect(git(leads, "rev-parse", "HEAD")).toBe(git(w.origin, "rev-parse", "main"))
    expect(sent).toEqual([])
  })

  test("leaves a canary worktree holding an open change as it is, and says nothing", async () => {
    const w = world()
    const before = git(w.leads, "rev-parse", "HEAD")
    writeFileSync(join(w.leads, "draft.txt"), "open")
    const { ctx, sent } = fake(scratch(), at(14, 10))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run: realRun })
    expect(git(w.leads, "rev-parse", "HEAD")).toBe(before)
    expect(sent).toEqual([])
  })

  // A main checkout that follows canary is the one every guard loads its bundles from, so its pull swaps each changed bundle in whole, as playground update does.
  test("swaps a changed hook bundle in whole when the worktree it pulls is the main checkout, so a reader never finds it missing or half-written", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "canary-pull-main-")))
    dirs.push(root)
    const bundle = join("scripts", "hooks", "bundled", "no-raw-delete.js")
    const before = `${"// a\n".repeat(6_000_000)}export {}\n`
    const after = `${"// bb\n".repeat(6_000_000)}export {}\n`
    const seed = join(root, "seed")
    mkdirSync(join(seed, "scripts", "hooks", "bundled"), { recursive: true })
    writeFileSync(join(seed, bundle), before)
    git(seed, "init", "-q", "-b", "canary")
    git(seed, "add", ".")
    git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one")
    const origin = join(root, "origin.git")
    git(root, "clone", "-q", "--bare", seed, origin)
    const repo = join(root, "repo")
    git(root, "clone", "-q", "-b", "canary", origin, repo)
    writeFileSync(join(seed, bundle), after)
    git(seed, "add", ".")
    git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two")
    git(seed, "push", "-q", origin, "canary")
    const stopWatch = await watchTorn(join(repo, bundle), [before.length, after.length], root)
    const { ctx, sent } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo, run: realRun })
    const { reads, torn } = await stopWatch()
    expect(reads).toBeGreaterThan(0)
    expect({ torn }).toEqual({ torn: 0 })
    expect(git(repo, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "canary"))
    expect(readFileSync(join(repo, bundle), "utf8") === after).toBe(true)
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(sent).toEqual([])
  })

  test("names a pull that cannot fast-forward to ops", async () => {
    const w = world()
    git(
      w.leads,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "local",
    )
    const { ctx, sent } = fake(scratch(), at(14, 15))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run: realRun })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe("ops")
    expect(sent[0]!.text).toStartWith(`canary-pull: ${w.leads} did not fast-forward:`)
  })

  test("names the same failed pull once, and again after the worktree has pulled and failed anew", async () => {
    const w = world()
    git(
      w.leads,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "local",
    )
    const ops = scratch()
    const first = fake(ops, at(14, 15))
    await beat("canary-pull").run({ ...first.ctx, repo: w.repo, run: realRun })
    const second = fake(ops, at(14, 20))
    await beat("canary-pull").run({ ...second.ctx, repo: w.repo, run: realRun })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toEqual([])
    git(w.leads, "reset", "-q", "--hard", "origin/canary")
    const pulled = fake(ops, at(14, 25))
    await beat("canary-pull").run({ ...pulled.ctx, repo: w.repo, run: realRun })
    expect(pulled.sent).toEqual([])
    expect(existsSync(join(ops, "tick", "canary-pull-told.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(ops, "tick", "canary-pull-told.json"), "utf8"))).toEqual({})
    git(
      w.leads,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "again",
    )
    git(
      w.seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "three",
    )
    git(w.seed, "push", "-q", w.origin, "canary")
    const anew = fake(ops, at(14, 30))
    await beat("canary-pull").run({ ...anew.ctx, repo: w.repo, run: realRun })
    expect(anew.sent).toHaveLength(1)
  })

  test("keeps no mark for a failed pull whose line was not queued, so the next beat names it", async () => {
    const w = world()
    git(
      w.leads,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "local",
    )
    const ops = scratch()
    const lost = fake(ops, at(14, 15))
    await beat("canary-pull").run({
      ...lost.ctx,
      repo: w.repo,
      run: realRun,
      send: async () => false,
    })
    const next = fake(ops, at(14, 20))
    await beat("canary-pull").run({ ...next.ctx, repo: w.repo, run: realRun })
    expect(next.sent).toHaveLength(1)
  })

  // git runs for real; run-slot.sh is stubbed: it records its argv and the worktree's head as it starts, then runs its command with a bun of its own that exits with code, printing a frozen lockfile's error when it fails.
  const slotted = (code = 0) => {
    const installs: string[][] = []
    const heads: string[] = []
    const bin = realpathSync(mkdtempSync(join(tmpdir(), "canary-pull-bin-")))
    dirs.push(bin)
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh\n[ ${code} -eq 0 ] && exit 0\necho "error: lockfile had changes, but lockfile is frozen"\nexit ${code}\n`,
    )
    chmodSync(join(bin, "bun"), 0o755)
    const run: Context["run"] = async (argv, timeoutMs, stdin) => {
      if (!argv[0]!.endsWith("run-slot.sh")) return realRun(argv, timeoutMs, stdin)
      installs.push(argv)
      heads.push(git(argv.at(-1)!, "rev-parse", "HEAD"))
      const proc = Bun.spawnSync(argv.slice(argv.indexOf("--") + 1), {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stderr: "pipe",
        stdout: "pipe",
      })
      return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() }
    }
    return { heads, installs, run }
  }
  const pushLock = (w: ReturnType<typeof world>, file = "bun.lock") => {
    mkdirSync(dirname(join(w.seed, file)), { recursive: true })
    writeFileSync(join(w.seed, file), "{}")
    git(w.seed, "add", file)
    git(w.seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "lock")
    git(w.seed, "push", "-q", w.origin, "canary")
  }

  test("installs through run-slot in a worktree whose pull changed bun.lock (#1628)", async () => {
    const w = world()
    pushLock(w)
    const ops = scratch()
    const { installs, run } = slotted()
    const { ctx, sent } = fake(ops, at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run })
    expect(installs).toHaveLength(1)
    expect(installs[0]!.slice(0, 3)).toEqual([join(ops, "run-slot.sh"), "ops-tick", "--"])
    expect(installs[0]!.at(-1)).toBe(w.leads)
    expect(installs[0]!.join(" ")).toContain("bun install --frozen-lockfile --ignore-scripts")
    expect(sent).toEqual([])
  })

  // On 2 Nov the leads worktree fast-forwarded onto a new workspace dependency, then its install waited 42s for a slot, and a roster.ts run in that gap failed on "Cannot find module".
  test("takes the slot before it fast-forwards a pull that changed bun.lock, so the worktree never runs new code on old node_modules (#599)", async () => {
    const w = world()
    const old = git(w.leads, "rev-parse", "HEAD")
    pushLock(w)
    const { heads, run } = slotted()
    const { ctx, sent } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run })
    expect(heads).toEqual([old])
    expect(git(w.leads, "rev-parse", "HEAD")).toBe(git(w.origin, "rev-parse", "canary"))
    expect(sent).toEqual([])
  })

  test("names a pull that changed bun.lock and cannot fast-forward as a pull, not an install", async () => {
    const w = world()
    git(
      w.leads,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "local",
    )
    pushLock(w)
    const { run } = slotted()
    const { ctx, sent } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toStartWith(`canary-pull: ${w.leads} did not fast-forward:`)
  })

  test("installs in a worktree whose pull changed a nested package.json alone", async () => {
    const w = world()
    pushLock(w, "web/next/package.json")
    const { installs, run } = slotted()
    const { ctx } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run })
    expect(installs).toHaveLength(1)
  })

  test("runs no install for a pull that changed no bun.lock or package.json", async () => {
    const w = world()
    const { installs, run } = slotted()
    const { ctx } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run })
    expect(git(w.leads, "rev-parse", "HEAD")).toBe(git(w.origin, "rev-parse", "canary"))
    expect(installs).toEqual([])
  })

  test("names a failed install to ops", async () => {
    const w = world()
    pushLock(w)
    const { run } = slotted(1)
    const { ctx, sent } = fake(scratch(), at(14, 5))
    await beat("canary-pull").run({ ...ctx, repo: w.repo, run })
    expect(sent).toEqual([
      {
        text: `canary-pull: ${w.leads} did not install: error: lockfile had changes, but lockfile is frozen`,
        to: "ops",
      },
    ])
  })

  test("retries a failed install on the next beat with nothing pulled, until one exits 0", async () => {
    const w = world()
    pushLock(w)
    const ops = scratch()
    await beat("canary-pull").run({
      ...fake(ops, at(14, 5)).ctx,
      repo: w.repo,
      run: slotted(1).run,
    })
    const retry = slotted()
    await beat("canary-pull").run({ ...fake(ops, at(14, 10)).ctx, repo: w.repo, run: retry.run })
    expect(retry.installs).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(ops, "tick", "canary-pull-told.json"), "utf8"))).toEqual({})
    const after = slotted()
    await beat("canary-pull").run({ ...fake(ops, at(14, 15)).ctx, repo: w.repo, run: after.run })
    expect(after.installs).toEqual([])
  })

  // Another session's fetch can move @{u} while a beat runs, so the beat reads it once after its own fetch and works from that sha alone.
  test("fast-forwards to the head it read, so a bun.lock change fetched mid-beat waits for the next beat's install", async () => {
    const w = world()
    const s = slotted()
    let raced = false
    const run: Context["run"] = async (argv, timeoutMs, stdin) => {
      if (!raced && argv[0] === "git" && argv.includes("merge")) {
        raced = true
        pushLock(w)
        git(w.leads, "fetch", "-q")
      }
      return s.run(argv, timeoutMs, stdin)
    }
    const ops = scratch()
    await beat("canary-pull").run({ ...fake(ops, at(14, 5)).ctx, repo: w.repo, run })
    expect(existsSync(join(w.leads, "bun.lock"))).toBe(false)
    const next = slotted()
    await beat("canary-pull").run({ ...fake(ops, at(14, 10)).ctx, repo: w.repo, run: next.run })
    expect(next.installs).toHaveLength(1)
    expect(existsSync(join(w.leads, "bun.lock"))).toBe(true)
  })

  test("owes a failed install even when canary moves on before the beat reads the result", async () => {
    const w = world()
    pushLock(w)
    const s = slotted(1)
    const run: Context["run"] = async (argv, timeoutMs, stdin) => {
      const result = await s.run(argv, timeoutMs, stdin)
      if (argv[0]!.endsWith("run-slot.sh")) {
        git(
          w.seed,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "later",
        )
        git(w.seed, "push", "-q", w.origin, "canary")
        git(w.leads, "fetch", "-q")
      }
      return result
    }
    const ops = scratch()
    const first = fake(ops, at(14, 5))
    await beat("canary-pull").run({ ...first.ctx, repo: w.repo, run })
    expect(first.sent.map((line) => line.text)).toEqual([
      `canary-pull: ${w.leads} did not install: error: lockfile had changes, but lockfile is frozen`,
    ])
    const next = slotted()
    await beat("canary-pull").run({ ...fake(ops, at(14, 10)).ctx, repo: w.repo, run: next.run })
    expect(next.installs).toHaveLength(1)
  })
})

describe("relay watch", () => {
  const ID = "f167b6b9-f570-4f15-a4b4-eb15b8c4876f"

  // The relay's outbox with its three cursors last moved at moved, and the ops manager in the roster, beside the relay's own row unless the machine has no relay. Every Inbox post below runs while Ops' waiter is down, the alerts-wait pid file absent, the one down sign the watch reads; a live wait is process.pid, which kill(pid, 0) reads live.
  const outbox = (ops: string, moved: Date, relay = true) => {
    mkdirSync(join(ops, "outbox"), { recursive: true })
    for (const file of ["cursor.json", "dm-cursor.json", "linear-cursor.json"]) {
      writeFileSync(join(ops, "outbox", file), "{}")
      utimesSync(join(ops, "outbox", file), moved, moved)
    }
    const agents: { kind: string; name: string; role: string }[] = [
      { kind: "ops", name: OLD.ops, role: "manager" },
    ]
    if (relay) agents.push({ kind: "runner", name: "runner-plain-relay", role: "runner" })
    writeFileSync(join(ops, "..", "roster.json"), JSON.stringify({ agents }))
  }

  // A live alerts-wait for name, its pid file holding this run's own pid.
  const waiterUp = (ops: string, name: string) => {
    mkdirSync(join(ops, "outbox", "alerts-wait"), { recursive: true })
    writeFileSync(join(ops, "outbox", "alerts-wait", `${name}.pid`), String(process.pid))
  }

  // The waiter queue's lines, each {at, job, text, to}, the late-stop route's record.
  const waiterLines = (ops: string): { at: string; job: string; text: string; to: string }[] =>
    existsSync(join(ops, "outbox", "ops-stuck-alert.jsonl"))
      ? readFileSync(join(ops, "outbox", "ops-stuck-alert.jsonl"), "utf8")
          .trimEnd()
          .split("\n")
          .map((l) => JSON.parse(l))
      : []

  // A context whose runs answer bun run ask, recording each call with its stdin; a "pending" peek leaves a line in a queue past cursor.json's offset for drain.ts's peek to read, any other leaves none.
  const watch = (ops: string, now: Date, peek: string, code = 0) => {
    const queue = join(ops, "outbox", "ops-unstick.jsonl")
    if (peek.startsWith("pending")) writeFileSync(queue, `${JSON.stringify({ text: "x" })}\n`)
    else rmSync(queue, { force: true })
    const asks: { argv: string[]; stdin?: string }[] = []
    const { ctx, sent } = fake(ops, now)
    const { run } = fakeRun({ ask: { code, out: `${ID}\n#i601\n` } })
    ctx.run = async (argv, timeoutMs, stdin) => {
      asks.push({ argv, stdin })
      return run(argv, timeoutMs, stdin)
    }
    return { asks, ctx, sent }
  }

  test("posts one Inbox alert once Ops' waiter is down and a line has waited past two cycles with no relay cursor moving, and resolves it once a cursor moves", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    const seen = watch(ops, at(14, 20), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(seen.ctx)
    expect(seen.asks).toEqual([])
    const waiting = watch(ops, at(14, 25), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(waiting.ctx)
    expect(waiting.asks).toEqual([])
    const first = watch(ops, at(14, 30), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(first.ctx)
    expect(first.asks).toHaveLength(1)
    expect(first.asks[0]!.argv).toEqual(["bun", "run", "--silent", "--cwd", "/repo", "ask", "new"])
    expect(JSON.parse(first.asks[0]!.stdin!)).toEqual({
      from: OLD.ops,
      kind: "update",
      preview: {
        outcome: "alert",
        text: "- 🔎 The relay's row is under AI Runners in the sidebar (runner-plain-relay on hover), and this Mac's state is on the [System page](/dashboard/system).",
      },
      title: `The ops relay is down: no ops line has gone out since ${at(14, 7)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")}. Resume runner-plain-relay.`,
    })
    expect(first.sent).toEqual([])
    const still = watch(ops, at(14, 35), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(still.ctx)
    expect(still.asks).toEqual([])
    outbox(ops, at(14, 38))
    const back = watch(ops, at(14, 40), "timeout")
    await beat("relay-watch").run(back.ctx)
    expect(back.asks.map((a) => a.argv)).toEqual([
      [
        "bun",
        "run",
        "--silent",
        "--cwd",
        "/repo",
        "ask",
        "resolve",
        ID,
        "--by",
        OLD.ops,
        "--note",
        `The relay moved its cursor again at ${at(14, 38)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")}`,
      ],
    ])
    expect(existsSync(join(ops, "tick", "relay-watch.json"))).toBe(false)
  })

  const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z")

  test("a machine with no relay judges Ops' sweep: a line may wait two sweeps, then the alert names the sweep and no relay session", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7), false)
    const early: unknown[] = []
    for (const minute of [20, 25, 35, 45]) {
      const tick = watch(ops, at(14, minute), "pending: ops-session-resume.jsonl")
      await beat("relay-watch").run(tick.ctx)
      early.push(...tick.asks)
    }
    expect(early).toEqual([])
    const late = watch(ops, at(14, 50), "pending: ops-session-resume.jsonl")
    await beat("relay-watch").run(late.ctx)
    expect(late.asks).toHaveLength(1)
    const { title } = JSON.parse(late.asks[0]!.stdin!)
    expect(title).toBe(
      `Ops' sweep is late: no ops line has gone out since ${iso(at(14, 7))}. Ops runs its sweep, whose step 2 runs ops:outbox.`,
    )
    expect(title).not.toContain("runner-plain-relay")
    expect(JSON.parse(late.asks[0]!.stdin!).preview.text).toBe(
      "- 🔎 Ops' row is under Orchestrators in the sidebar, since its sweep relays here, and this Mac's state is on the [System page](/dashboard/system).",
    )
    expect(late.sent).toEqual([])
  })

  test("a machine with no relay posts nothing while Ops' sweep drains within its cadence", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7), false)
    const asks: unknown[] = []
    for (const minute of [20, 35, 50, 65, 80]) {
      const tick = watch(ops, at(14, minute), "pending: ops-unstick.jsonl")
      await beat("relay-watch").run(tick.ctx)
      asks.push(...tick.asks)
      outbox(ops, at(14, minute + 2), false)
    }
    expect(asks).toEqual([])
  })

  test("a resume record alone makes it a relay machine, whose alert names the relay as today", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7), false)
    mkdirSync(join(ops, "..", "resume"), { recursive: true })
    writeFileSync(join(ops, "..", "resume", "runner-plain-relay.sh"), "exit 0\n")
    await beat("relay-watch").run(watch(ops, at(14, 20), "pending: ops-session-resume.jsonl").ctx)
    const due = watch(ops, at(14, 30), "pending: ops-session-resume.jsonl")
    await beat("relay-watch").run(due.ctx)
    expect(due.asks).toHaveLength(1)
    expect(JSON.parse(due.asks[0]!.stdin!).title).toBe(
      `The ops relay is down: no ops line has gone out since ${iso(at(14, 7))}. Resume runner-plain-relay.`,
    )
  })

  test("a relay that has never run, with no cursor at all, alerts on the lines queued since the watch began, and a caught-up relay reads none", async () => {
    const ops = scratch()
    mkdirSync(join(ops, "outbox"), { recursive: true })
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({ agents: [{ kind: "ops", name: OLD.ops, role: "manager" }] }),
    )
    const queue = join(ops, "outbox", "ops-session-resume.jsonl")
    const line = (date: Date) =>
      `${JSON.stringify({ at: iso(date), job: "session-resume", text: "carry on", to: "w" })}\n`
    writeFileSync(queue, line(at(13, 0)))
    const before = watch(ops, at(14, 0), "timeout")
    await beat("relay-watch").run(before.ctx)
    expect(before.asks).toEqual([])
    appendFileSync(queue, line(at(14, 5)))
    const quiet: unknown[] = []
    for (const minute of [10, 25]) {
      const tick = watch(ops, at(14, minute), "timeout")
      await beat("relay-watch").run(tick.ctx)
      quiet.push(...tick.asks)
    }
    expect(quiet).toEqual([])
    const due = watch(ops, at(14, 40), "timeout")
    await beat("relay-watch").run(due.ctx)
    expect(due.asks).toHaveLength(1)
    expect(JSON.parse(due.asks[0]!.stdin!).title).toBe(
      "The outbox relay has never run: no ops line has gone out since the watch began, and this machine relays through Ops' sweep. Ops runs its sweep, whose step 2 runs ops:outbox.",
    )
    writeFileSync(
      join(ops, "outbox", "cursor.json"),
      JSON.stringify({ "ops-session-resume.jsonl": readFileSync(queue).length }),
    )
    utimesSync(join(ops, "outbox", "cursor.json"), at(14, 45), at(14, 45))
    const resolved = watch(ops, at(14, 50), "timeout")
    await beat("relay-watch").run(resolved.ctx)
    expect(resolved.asks.map((a) => a.argv)).toEqual([
      [
        "bun",
        "run",
        "--silent",
        "--cwd",
        "/repo",
        "ask",
        "resolve",
        ID,
        "--by",
        OLD.ops,
        "--note",
        `The relay moved its cursor again at ${at(14, 45)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")}`,
      ],
    ])
    const caughtUp = watch(ops, at(15, 30), "timeout")
    await beat("relay-watch").run(caughtUp.ctx)
    expect(caughtUp.asks).toEqual([])
    expect(existsSync(join(ops, "tick", "relay-watch-start"))).toBe(false)
  })

  test("a relay that has never run counts no line queued before the watch began, and on a relay machine names the relay", async () => {
    const ops = scratch()
    mkdirSync(join(ops, "outbox"), { recursive: true })
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({
        agents: [
          { kind: "ops", name: OLD.ops, role: "manager" },
          { kind: "runner", name: "runner-plain-relay", role: "runner" },
        ],
      }),
    )
    const queue = join(ops, "outbox", "ops-session-resume.jsonl")
    const line = (date: Date) =>
      `${JSON.stringify({ at: iso(date), job: "session-resume", text: "carry on", to: "w" })}\n`
    writeFileSync(queue, line(at(13, 0)))
    const old: unknown[] = []
    for (const minute of [0, 10, 20, 30]) {
      const tick = watch(ops, at(14, minute), "timeout")
      await beat("relay-watch").run(tick.ctx)
      old.push(...tick.asks)
    }
    expect(old).toEqual([])
    appendFileSync(queue, line(at(14, 35)))
    await beat("relay-watch").run(watch(ops, at(14, 40), "timeout").ctx)
    const due = watch(ops, at(14, 50), "timeout")
    await beat("relay-watch").run(due.ctx)
    expect(due.asks).toHaveLength(1)
    expect(JSON.parse(due.asks[0]!.stdin!).title).toBe(
      "The ops relay has never run: no ops line has gone out since the watch began. Resume runner-plain-relay.",
    )
  })

  test("posts nothing while nothing waits, and times the wait itself, not the cursors' age", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    const quiet = watch(ops, at(15, 0), "timeout")
    await beat("relay-watch").run(quiet.ctx)
    expect(quiet.asks).toEqual([])
    const lands = watch(ops, at(15, 5), "pending: ops-sweep.jsonl")
    await beat("relay-watch").run(lands.ctx)
    expect(lands.asks).toEqual([])
    const gone = watch(ops, at(15, 10), "timeout")
    await beat("relay-watch").run(gone.ctx)
    const again = watch(ops, at(15, 15), "pending: ops-sweep.jsonl")
    await beat("relay-watch").run(again.ctx)
    const late = watch(ops, at(15, 20), "pending: ops-sweep.jsonl")
    await beat("relay-watch").run(late.ctx)
    expect([gone.asks, again.asks, late.asks]).toEqual([[], [], []])
  })

  test("a cursor that moves while a line waits starts the wait over", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    await beat("relay-watch").run(watch(ops, at(14, 20), "pending: a.jsonl").ctx)
    outbox(ops, at(14, 27))
    const moved = watch(ops, at(14, 30), "pending: b.jsonl")
    await beat("relay-watch").run(moved.ctx)
    const early = watch(ops, at(14, 35), "pending: b.jsonl")
    await beat("relay-watch").run(early.ctx)
    expect([moved.asks, early.asks]).toEqual([[], []])
    const due = watch(ops, at(14, 40), "pending: b.jsonl")
    await beat("relay-watch").run(due.ctx)
    expect(due.asks).toHaveLength(1)
  })

  test("a post or a resolve that fails throws for the heartbeat and keeps its state, so the next cycle tries again", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    await beat("relay-watch").run(watch(ops, at(14, 20), "pending: ops-unstick.jsonl").ctx)
    const refused = watch(ops, at(14, 30), "pending: ops-unstick.jsonl", 1)
    await expect(beat("relay-watch").run(refused.ctx)).rejects.toThrow("bun run ask new")
    expect(
      JSON.parse(readFileSync(join(ops, "tick", "relay-watch.json"), "utf8")).id,
    ).toBeUndefined()
    const posted = watch(ops, at(14, 35), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(posted.ctx)
    expect(posted.asks).toHaveLength(1)
    outbox(ops, at(14, 38))
    const stuck = watch(ops, at(14, 40), "timeout", 1)
    await expect(beat("relay-watch").run(stuck.ctx)).rejects.toThrow(`bun run ask resolve ${ID}`)
    expect(JSON.parse(readFileSync(join(ops, "tick", "relay-watch.json"), "utf8")).id).toBe(ID)
  })

  test("an alert whose item is gone counts as resolved, so the next outage is reported", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    await beat("relay-watch").run(watch(ops, at(14, 20), "pending: ops-unstick.jsonl").ctx)
    await beat("relay-watch").run(watch(ops, at(14, 30), "pending: ops-unstick.jsonl").ctx)
    outbox(ops, at(14, 38))
    const gone = watch(ops, at(14, 40), "timeout")
    gone.ctx.run = fakeRun({ ask: { code: 1, err: `dashboard-ask: no inbox item ${ID}\n` } }).run
    await beat("relay-watch").run(gone.ctx)
    expect(existsSync(join(ops, "tick", "relay-watch.json"))).toBe(false)
    await beat("relay-watch").run(watch(ops, at(15, 0), "pending: ops-unstick.jsonl").ctx)
    const next = watch(ops, at(15, 10), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(next.ctx)
    expect(next.asks).toHaveLength(1)
  })

  test("queues the late-stop line for ops' waiter once a line has waited past two cycles, then the dispatcher's at the escalation window, and posts no Inbox alert while Ops' waiter is live", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    waiterUp(ops, OLD.ops)
    const ramp: unknown[][] = []
    for (const minute of [20, 25]) {
      const tick = watch(ops, at(14, minute), "pending: ops-unstick.jsonl")
      await beat("relay-watch").run(tick.ctx)
      ramp.push(waiterLines(ops))
      expect(tick.asks).toEqual([])
      expect(tick.sent).toEqual([])
    }
    expect(ramp).toEqual([[], []])
    const told = watch(ops, at(14, 30), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(told.ctx)
    expect(waiterLines(ops)).toEqual([
      {
        at: iso(at(14, 30)),
        job: "stuck-alert",
        text: `The ops relay is down: no ops line has gone out since ${iso(at(14, 7))}. Resume runner-plain-relay.`,
        to: OLD.ops,
      },
    ])
    expect(told.sent).toEqual([])
    expect(told.asks).toEqual([])
    const escalated = watch(ops, at(14, 35), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(escalated.ctx)
    expect(waiterLines(ops)).toEqual([
      {
        at: iso(at(14, 30)),
        job: "stuck-alert",
        text: `The ops relay is down: no ops line has gone out since ${iso(at(14, 7))}. Resume runner-plain-relay.`,
        to: OLD.ops,
      },
      {
        at: iso(at(14, 35)),
        job: "stuck-alert",
        text: `The ops relay is down: no ops line has gone out since ${iso(at(14, 7))}. Resume runner-plain-relay. Ops has not picked it up. Resolve it; post it to the owner's Inbox only if you cannot.`,
        to: OLD.dispatcher,
      },
    ])
    expect(escalated.asks).toEqual([])
    const again = watch(ops, at(14, 40), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(again.ctx)
    expect(waiterLines(ops)).toHaveLength(2)
    expect(again.asks).toEqual([])
  })

  test("posts the Inbox alert once Ops has no live waiter, and never while its waiter runs", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    for (const minute of [20, 25])
      await beat("relay-watch").run(watch(ops, at(14, minute), "pending: ops-unstick.jsonl").ctx)
    const down = watch(ops, at(14, 30), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(down.ctx)
    expect(waiterLines(ops)).toEqual([])
    expect(down.asks).toHaveLength(1)
    expect(JSON.parse(down.asks[0]!.stdin!).title).toBe(
      `The ops relay is down: no ops line has gone out since ${iso(at(14, 7))}. Resume runner-plain-relay.`,
    )
    const up = scratch()
    outbox(up, at(14, 7))
    waiterUp(up, OLD.ops)
    for (const minute of [20, 25])
      await beat("relay-watch").run(watch(up, at(14, minute), "pending: ops-unstick.jsonl").ctx)
    const live = watch(up, at(14, 30), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(live.ctx)
    expect(live.asks).toEqual([])
    expect(waiterLines(up).map((l) => l.to)).toEqual([OLD.ops])
  })

  test("a hold set over an open Inbox alert resolves the item before the watch goes quiet", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    for (const minute of [20, 25])
      await beat("relay-watch").run(watch(ops, at(14, minute), "pending: ops-unstick.jsonl").ctx)
    await beat("relay-watch").run(watch(ops, at(14, 30), "pending: ops-unstick.jsonl").ctx)
    writeFileSync(join(ops, "sweep-hold-until"), `${iso(at(16, 0))}\n`)
    const held = watch(ops, at(14, 35), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(held.ctx)
    expect(held.asks.map((a) => a.argv)).toEqual([
      [
        "bun",
        "run",
        "--silent",
        "--cwd",
        "/repo",
        "ask",
        "resolve",
        ID,
        "--by",
        OLD.ops,
        "--note",
        "The sweep hold stands: Ops set ops/sweep-hold-until, and the watch stays quiet until it passes",
      ],
    ])
    expect(existsSync(join(ops, "tick", "relay-watch.json"))).toBe(false)
  })

  test("posts nothing while ops/sweep-hold-until holds a future time, judges fresh once it passes, and reads an empty or unreadable hold as none", async () => {
    const ops = scratch()
    outbox(ops, at(14, 7))
    writeFileSync(join(ops, "sweep-hold-until"), `${iso(at(15, 0))}\n`)
    const held: unknown[] = []
    for (const minute of [30, 40, 50]) {
      const tick = watch(ops, at(14, minute), "pending: ops-unstick.jsonl")
      await beat("relay-watch").run(tick.ctx)
      held.push(...tick.asks)
      expect(waiterLines(ops)).toEqual([])
    }
    expect(held).toEqual([])
    writeFileSync(join(ops, "sweep-hold-until"), `${iso(at(14, 45))}\n`)
    const fresh = watch(ops, at(14, 50), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(fresh.ctx)
    expect(fresh.sent).toEqual([])
    expect(fresh.asks).toEqual([])
    writeFileSync(join(ops, "sweep-hold-until"), "")
    waiterUp(ops, OLD.ops)
    const due = watch(ops, at(15, 20), "pending: ops-unstick.jsonl")
    await beat("relay-watch").run(due.ctx)
    expect(due.asks).toEqual([])
    expect(waiterLines(ops).map((l) => l.to)).toEqual([OLD.ops])
    writeFileSync(join(ops, "sweep-hold-until"), "not a time at all")
    await beat("relay-watch").run(watch(ops, at(15, 50), "pending: ops-unstick.jsonl").ctx)
    expect(waiterLines(ops).map((l) => l.to)).toEqual([OLD.ops, OLD.dispatcher])
  })
})

describe("the relay's own resume", () => {
  const UP = "/m/scripts/spawn.sh resume runner-plain-relay /m 7777 --backend claude"
  const RUN = [...UP.split(" "), "--brief", "brief-runner-plain-relay.md"]

  test("runs the relay's resume line itself rather than queueing it for the relay, once, and tells ops", async () => {
    const ops = scratch()
    writeFileSync(join(ops, "..", "roster.json"), JSON.stringify({ agents: [] }))
    writeFileSync(
      join(ops, "ops-linear-dm.json"),
      JSON.stringify({ lastBeatAt: at(14, 7).toISOString(), lastResult: "ok" }),
    )
    const { ctx, runs, sent } = fake(ops, at(14, 7), { ...QUIET_LOAD, "--sessions": UP })
    await beat("sweep").run(ctx)
    expect(runs).toContainEqual(RUN)
    expect(sent).toEqual([{ text: `Resumed runner-plain-relay: ${UP}`, to: "ops" }])
    const up = fake(ops, at(14, 37), QUIET_LOAD)
    await beat("sweep").run(up.ctx)
    expect(up.runs).not.toContainEqual(RUN)
  })

  test("the same resume line returns with the next outage and runs again, since a resume keeps the session id", async () => {
    const ops = scratch()
    writeFileSync(join(ops, "..", "roster.json"), JSON.stringify({ agents: [] }))
    writeFileSync(
      join(ops, "ops-linear-dm.json"),
      JSON.stringify({ lastBeatAt: at(14, 7).toISOString(), lastResult: "ok" }),
    )
    await beat("sweep").run(fake(ops, at(14, 7), { ...QUIET_LOAD, "--sessions": UP }).ctx)
    await beat("sweep").run(fake(ops, at(14, 37), QUIET_LOAD).ctx)
    const next = fake(ops, at(15, 7), { ...QUIET_LOAD, "--sessions": UP })
    await beat("sweep").run(next.ctx)
    expect(next.runs).toContainEqual(RUN)
  })

  test("a resume that fails is named to ops and runs again at the next sweep", async () => {
    const ops = scratch()
    writeFileSync(join(ops, "..", "roster.json"), JSON.stringify({ agents: [] }))
    writeFileSync(
      join(ops, "ops-linear-dm.json"),
      JSON.stringify({ lastBeatAt: at(14, 7).toISOString(), lastResult: "ok" }),
    )
    const first = fake(ops, at(14, 7), {
      "--brief brief-runner-plain-relay.md": {
        code: 2,
        err: "spawn.sh: refused: load 40 over 16\n",
      },
      ...QUIET_LOAD,
      "--sessions": UP,
    })
    await beat("sweep").run(first.ctx)
    expect(first.sent).toEqual([
      {
        text: "Felled runner-plain-relay; its resume failed (exit 2): spawn.sh: refused: load 40 over 16",
        to: "ops",
      },
    ])
    const next = fake(ops, at(14, 37), { ...QUIET_LOAD, "--sessions": UP })
    await beat("sweep").run(next.ctx)
    expect(next.runs).toContainEqual(RUN)
  })
})

test("the switch watch reads no account on a machine with no extensions, so it stays quiet", async () => {
  const data = mkdtempSync(join(tmpdir(), "ops-tick-switch-"))
  expect(await switchAccount(join(data, "ops"))).toBe("")
  rmSync(data, { force: true, recursive: true })
})

describe("the focus card", () => {
  test("posts one Inbox update under the ops manager's name once focus.json has lapsed, and none while it stands (#974)", async () => {
    const ops = scratch()
    const focus = (until: string) =>
      writeFileSync(
        join(ops, "..", "focus.json"),
        JSON.stringify({
          reason: "a timed demo",
          session: "worker-f",
          since: "2026-10-19T08:00:00.000Z",
          until,
        }),
      )
    focus("2026-10-19T09:00:00.000Z")
    const standing = fake(ops, new Date("2026-10-19T08:30:00.000Z"))
    await beat("focus-card").run(standing.ctx)
    expect(standing.runs).toEqual([])
    const ended = fake(ops, new Date("2026-10-19T09:00:30.000Z"))
    await beat("focus-card").run(ended.ctx)
    expect(ended.runs).toEqual([["bun", "run", "--silent", "--cwd", "/repo", "ask", "new"]])
    expect(JSON.parse(ended.inputs[0]!)).toMatchObject({
      from: OLD.ops,
      kind: "update",
      preview: { outcome: "finding" },
      title: "Focus for worker-f ended: 0 runs queued while it stood, 0m0s in all",
    })
    await beat("focus-card").run(ended.ctx)
    expect(ended.runs).toHaveLength(1)
  })

  // PG-1349: the focus card waited for the owner's Done after everything it pointed at was answered
  test("resolves itself once no ask that came in while focus stood is open, and stays while one is (PG-1349)", async () => {
    const ops = scratch()
    writeFileSync(
      join(ops, "..", "roster.json"),
      JSON.stringify({ agents: [{ kind: "ops", name: OLD.ops, role: "manager" }] }),
    )
    writeFileSync(
      join(ops, "..", "focus.json"),
      JSON.stringify({
        reason: "a timed demo",
        session: "worker-f",
        since: "2026-10-19T08:00:00.000Z",
        until: "2026-10-19T09:00:00.000Z",
      }),
    )
    const ended = fake(ops, new Date("2026-10-19T09:00:30.000Z"), ASKED)
    await beat("focus-card").run(ended.ctx)
    expect(ended.runs).toEqual([["bun", "run", "--silent", "--cwd", "/repo", "ask", "new"]])
    const open = [
      "bun",
      "run",
      "--silent",
      "--cwd",
      "/repo",
      "ask",
      "open",
      "--since",
      "2026-10-19T08:00:00.000Z",
      "--until",
      "2026-10-19T09:00:00.000Z",
    ]
    const waiting = fake(ops, new Date("2026-10-19T09:05:00.000Z"), {
      "ask open": "#i600 decision from worker-q · Ship the made-up fix?\n",
    })
    await beat("focus-card").run(waiting.ctx)
    expect(waiting.runs).toEqual([open])
    const clear = fake(ops, new Date("2026-10-19T09:10:00.000Z"), { "ask open": "" })
    await beat("focus-card").run(clear.ctx)
    expect(clear.runs).toEqual([
      open,
      [
        "bun",
        "run",
        "--silent",
        "--cwd",
        "/repo",
        "ask",
        "resolve",
        "f167b6b9-f570-4f15-a4b4-eb15b8c4876f",
        "--by",
        OLD.ops,
        "--note",
        "Everything that came in while focus stood is answered",
      ],
    ])
    const after = fake(ops, new Date("2026-10-19T09:15:00.000Z"))
    await beat("focus-card").run(after.ctx)
    expect(after.runs).toEqual([])
  })

  // PG-1349 round 1: a kept card that had resolved stayed after a later card failed, and every beat after threw on it, so no new card posted
  test("a kept card already resolved is dropped, one whose resolve fails stays for the next beat, and the beat still posts a new card", async () => {
    const ops = scratch()
    mkdirSync(join(ops, "tick"), { recursive: true })
    const window = { since: "2026-10-19T07:00:00.000Z", until: "2026-10-19T07:30:00.000Z" }
    const doneCard = { by: OLD.ops, id: "aaaaaaaa-0000-4000-8000-000000000001", ...window }
    const downCard = { by: OLD.ops, id: "bbbbbbbb-0000-4000-8000-000000000002", ...window }
    writeFileSync(join(ops, "tick", "focus-cards.json"), JSON.stringify([doneCard, downCard]))
    writeFileSync(
      join(ops, "..", "focus.json"),
      JSON.stringify({
        reason: "a timed demo",
        session: "worker-f",
        since: "2026-10-19T08:00:00.000Z",
        until: "2026-10-19T09:00:00.000Z",
      }),
    )
    const ended = fake(ops, new Date("2026-10-19T09:00:30.000Z"), {
      ...ASKED,
      "ask open": "",
      [`resolve ${doneCard.id}`]: { code: 1, err: "ask: This update is already resolved\n" },
      [`resolve ${downCard.id}`]: { code: 1, err: "ask: the dashboard is down\n" },
    })
    await expect(beat("focus-card").run(ended.ctx)).rejects.toThrow("ask: the dashboard is down")
    expect(ended.runs.at(-1)).toEqual(["bun", "run", "--silent", "--cwd", "/repo", "ask", "new"])
    const kept = JSON.parse(readFileSync(join(ops, "tick", "focus-cards.json"), "utf8")) as {
      id: string
    }[]
    expect(kept.map((card) => card.id)).toEqual([
      downCard.id,
      "f167b6b9-f570-4f15-a4b4-eb15b8c4876f",
    ])
  })

  test("a post that fails throws, so the beat names it and the next one tries again", async () => {
    const ops = scratch()
    writeFileSync(
      join(ops, "..", "focus.json"),
      JSON.stringify({
        reason: "r",
        session: "worker-f",
        since: "2026-10-19T08:00:00.000Z",
        until: "2026-10-19T09:00:00.000Z",
      }),
    )
    const failing = fake(ops, new Date("2026-10-19T09:01:00.000Z"), {
      "ask new": { code: 1, err: "ask: refused\n" },
    })
    await expect(beat("focus-card").run(failing.ctx)).rejects.toThrow(
      "bun run ask new: ask: refused",
    )
    expect(existsSync(join(ops, "..", "focus.json"))).toBe(true)
  })
})

// 31 Oct: tick ran five helpers no checkout held, and the beats' stubs above passed, so their alerts never fired on a real machine.
describe("every script a beat runs", () => {
  const REPO = join(import.meta.dir, "../../../../..")
  // where each base tick.ts joins from lives in a checkout: the ops folder is scripts/ops, linked into the data folder by link-skills.sh
  const BASES: Record<string, string> = {
    "ctx.ops": join(REPO, "scripts", "ops"),
    "ctx.repo": REPO,
    outbox: join(REPO, "scripts", "ops", "outbox"),
  }
  const source = readFileSync(join(REPO, "packages/scripts/src/ops-tick/tick.ts"), "utf8")
  const scripts = [
    ...[...source.matchAll(/join\((ctx\.ops|ctx\.repo|outbox)((?:, "[^"]+")+)\)/g)].map(
      ([, base, rest]) =>
        join(BASES[base!]!, ...[...rest!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)),
    ),
    ...[...source.matchAll(/python\(ctx, "([^"]+)"/g)].map(([, path]) =>
      join(BASES["ctx.ops"]!, path!),
    ),
  ].filter((path) => /\.(py|sh|ts)$/.test(path))

  test("is a file in the repo", () => {
    expect(scripts.length).toBeGreaterThan(0)
    expect(
      scripts.filter((path) => !existsSync(path)).map((path) => path.slice(REPO.length + 1)),
    ).toEqual([])
  })
})
