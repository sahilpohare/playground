import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setSessionNames } from "../../../../../packages/config/src/kinds"
import {
  type SessionState,
  sessionStateDir,
} from "../../../../../packages/config/src/session-state"
import {
  continuesItself,
  CYCLE_SECONDS,
  cycle,
  due,
  FAILED_WINDOW_MS,
  failedAlert,
  failedLine,
  GRACE_MS,
  interruptedAfter,
  leadName,
  liveSessions,
  lostTurn,
  opsDirOf,
  primaryDispatcher,
  RESTART_GRACE_MS,
  restartLine,
  resumeLine,
  stuckEscalation,
  thrashed,
} from "../../../../../packages/scripts/src/ops-session-resume/resume"
import { callKey } from "../../../../../packages/scripts/src/stuck-alert"
import { writeRoot } from "../../../../../packages/settings/src/folder"
import { extensionsDir } from "../../../../../packages/settings/src/rendered"
import { OLD, OLD_AS_NAMES, SEEDED_NAMES } from "../../../../session-names"

// A machine whose sessions.names keep the old names, which this file's fallbacks name.
beforeAll(() => setSessionNames(OLD_AS_NAMES))
afterAll(() => setSessionNames(SEEDED_NAMES))

const dirs: string[] = []
const DATA_DIR = process.env.PLAYGROUND_DATA_DIR
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
  if (DATA_DIR === undefined) delete process.env.PLAYGROUND_DATA_DIR
  else process.env.PLAYGROUND_DATA_DIR = DATA_DIR
})
// A scratch config folder, its data folder the playground folder in it, named by PLAYGROUND_DATA_DIR, since the config folder never places it.
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ops-session-resume-"))
  dirs.push(dir)
  process.env.PLAYGROUND_DATA_DIR = join(dir, "playground")
  return dir
}

const RESET = "2026-10-18T03:11:16.000Z"
const limited = (sessionId: string, resetsAt: string | null = RESET): SessionState => ({
  at: "2026-10-18T00:52:29.118Z",
  event: "StopFailure",
  reason: "rate_limit",
  ...(resetsAt ? { resetsAt } : {}),
  sessionId,
  state: "usage-limit",
})
// Transcript lines as Claude Code 2.1.296 and 2.1.302 wrote them, trimmed to the fields read.
const limitLine = (resetsAt: string) =>
  JSON.stringify({
    isApiErrorMessage: true,
    message: {
      content: [{ text: "You've hit your session limit · resets 12:50am", type: "text" }],
    },
    quotaLimits: { resetsAt: Date.parse(resetsAt) / 1000 },
    type: "assistant",
  })
const LIMIT_LINE = limitLine(RESET)
const LATER = "2026-10-18T08:11:16.000Z"
const LATER_LIMIT = limitLine(LATER)
const GLM_LINE = JSON.stringify({
  isApiErrorMessage: true,
  message: { content: [{ text: "API Error: Request rejected (429)", type: "text" }] },
  type: "assistant",
})
const NOTICE = JSON.stringify({
  content: "Usage limit reached · continuing automatically at 12:50am · esc to cancel",
  level: "notice",
  subtype: "informational",
  type: "system",
})
const QUEUED = JSON.stringify({ operation: "enqueue", type: "queue-operation" })
const after = (ms: number) => new Date(Date.parse(RESET) + ms)

describe("which sessions are due their resume line", () => {
  test("a usage-limited session is due once its reset and the grace have passed", () => {
    expect(due([limited("a")], new Set(), after(GRACE_MS - 1))).toEqual([])
    expect(due([limited("a")], new Set(), after(GRACE_MS))).toEqual([limited("a")])
  })

  test("a session already sent a line for that reset is not due again", () => {
    expect(due([limited("a")], new Set([`a ${RESET}`]), after(GRACE_MS))).toEqual([])
  })

  test("a limit with no reset, or a session in any other state, is never due", () => {
    const working: SessionState = { ...limited("b"), event: "UserPromptSubmit", state: "working" }
    expect(due([limited("a", null), working], new Set(), after(GRACE_MS))).toEqual([])
  })
})

describe("the session a line goes to", () => {
  test("is the live session the registry names for that id, with its pid, its folder and when its process started", async () => {
    const config = scratch()
    mkdirSync(join(config, "sessions"))
    const ended = Bun.spawn(["true"])
    await ended.exited
    const entry = (pid: number, sessionId: string, name: string, startedAt?: unknown) =>
      writeFileSync(
        join(config, "sessions", `${pid}.json`),
        JSON.stringify({ cwd: `/work/${OLD.dispatcher}`, name, pid, sessionId, startedAt }),
      )
    entry(process.pid, "a", "worker-brave-otter", 1792321696879)
    entry(ended.pid, "b", "worker-gone", 1792321696879)
    writeFileSync(
      join(config, "sessions", "no-pid.json"),
      JSON.stringify({ name: "worker-no-pid", sessionId: "d" }),
    )
    writeFileSync(join(config, "sessions", "junk.json"), "{")
    expect(await liveSessions(config)).toEqual(
      new Map([
        [
          "a",
          {
            cwd: `/work/${OLD.dispatcher}`,
            name: "worker-brave-otter",
            pid: process.pid,
            startedAt: 1792321696879,
          },
        ],
      ]),
    )
    entry(process.pid, "a", "worker-brave-otter", "Sun Oct 18 11:08:14 2026")
    expect(await liveSessions(config)).toEqual(
      new Map([
        ["a", { cwd: `/work/${OLD.dispatcher}`, name: "worker-brave-otter", pid: process.pid }],
      ]),
    )
  })
})

const STARTED = Date.parse("2026-10-18T11:08:16.000Z")
const midTurn = (sessionId: string, at = "2026-10-18T11:01:00.000Z"): SessionState => ({
  at,
  event: "UserPromptSubmit",
  sessionId,
  state: "working",
})
const since = (ms: number) => new Date(STARTED + ms)
// An Escape's line as Claude Code 2.1.302 wrote it (a probe, 19 Oct), trimmed to the fields read.
const interrupt = (timestamp: string, text = "[Request interrupted by user for tool use]") =>
  JSON.stringify({ message: { content: [{ text, type: "text" }] }, timestamp, type: "user" })
const BEFORE = "2026-10-18T11:00:00.000Z"
const AFTER = "2026-10-18T11:02:00.000Z"

describe("which sessions lost a turn to a restart", () => {
  test("a working record older than the process's start, once the start is 2 minutes old", () => {
    expect(lostTurn(midTurn("a"), STARTED, new Set(), since(RESTART_GRACE_MS - 1))).toBe(false)
    expect(lostTurn(midTurn("a"), STARTED, new Set(), since(RESTART_GRACE_MS))).toBe(true)
  })

  test("a record written since the start (a resume's first prompt) is no lost turn", () => {
    const fresh = midTurn("a", new Date(STARTED + 5_000).toISOString())
    expect(lostTurn(fresh, STARTED, new Set(), since(RESTART_GRACE_MS))).toBe(false)
  })

  test("a session idle or at a limit before the restart lost no turn", () => {
    const idle: SessionState = { ...midTurn("a"), event: "Stop", state: "idle" }
    expect(lostTurn(idle, STARTED, new Set(), since(RESTART_GRACE_MS))).toBe(false)
    expect(lostTurn(limited("a"), STARTED, new Set(), since(RESTART_GRACE_MS))).toBe(false)
  })

  test("a start already sent its line, or one the registry gives no time for, gets none", () => {
    const sent = new Set([`a restart ${STARTED}`])
    expect(lostTurn(midTurn("a"), STARTED, sent, since(RESTART_GRACE_MS))).toBe(false)
    expect(lostTurn(midTurn("a"), undefined, new Set(), since(RESTART_GRACE_MS))).toBe(false)
  })

  test("a person's Escape after the record ended the turn: its interrupt line, with or without a tool", () => {
    const at = midTurn("a").at
    expect(interruptedAfter(interrupt(AFTER), at)).toBe(true)
    expect(interruptedAfter(interrupt(AFTER, "[Request interrupted by user]"), at)).toBe(true)
    expect(interruptedAfter(`${interrupt(BEFORE)}\n${QUEUED}\n{"type":"user`, at)).toBe(false)
    expect(interruptedAfter(interrupt(AFTER, "[Request interrupted by a hook]"), at)).toBe(false)
    expect(interruptedAfter("", at)).toBe(false)
  })

  test("the line names the restart and asks the session to carry on", () => {
    expect(restartLine(STARTED)).toBe(
      "You were restarted at 2026-10-18T11:08:16Z in the middle of a turn, which was lost. Carry on with your task from where you stopped.",
    )
  })
})

describe("one cycle", () => {
  const setup = () => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    for (const id of ["a", "b"])
      writeFileSync(join(states, `${id}.json`), JSON.stringify(limited(id)))
    writeFileSync(join(states, "junk.json"), "{")
    return { config, outbox: join(config, "playground", "ops", "outbox") }
  }
  const sessions = (named: Record<string, string>, startedAt?: number) => async () =>
    new Map(Object.entries(named).map(([id, name]) => [id, { name, startedAt }]))

  test("queues one resume line through the ops relay for each live session due, once", async () => {
    const { config, outbox } = setup()
    const run = () =>
      cycle({
        configDir: config,
        live: sessions({ a: "worker-brave-otter" }),
        now: after(GRACE_MS),
      })
    expect(await run()).toEqual({ result: "ok", resumed: 1 })
    expect(await run()).toEqual({ result: "ok", resumed: 0 })
    const lines = (await readFile(join(outbox, "ops-session-resume.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      {
        at: after(GRACE_MS)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
        job: "session-resume",
        text: resumeLine(RESET),
        to: "worker-brave-otter",
      },
    ])
  })

  test("only a factory session gets a line: never a session outside it, nor a probe", async () => {
    const { config, outbox } = setup()
    for (const id of ["c", "d"])
      writeFileSync(
        join(config, "playground", "session-state", `${id}.json`),
        JSON.stringify(limited(id)),
      )
    const named = {
      a: "worker-brave-otter",
      b: "notes",
      c: "probe-sdk",
      d: OLD.builder,
    } as Record<string, string>
    expect(await cycle({ configDir: config, live: sessions(named), now: after(GRACE_MS) })).toEqual(
      { result: "ok", resumed: 2 },
    )
    const lines = (await readFile(join(outbox, "ops-session-resume.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(lines.map((line) => JSON.parse(line).to)).toEqual(["worker-brave-otter", OLD.builder])
  })

  test("the lines go in session id order, whatever order the folder lists the records in", async () => {
    const { config, outbox } = setup()
    for (const id of ["c", "d"])
      writeFileSync(
        join(config, "playground", "session-state", `${id}.json`),
        JSON.stringify(limited(id)),
      )
    const named = {
      a: "worker-ash",
      b: "worker-birch",
      c: "worker-cedar",
      d: "worker-dogwood",
    } as Record<string, string>
    expect(await cycle({ configDir: config, live: sessions(named), now: after(GRACE_MS) })).toEqual(
      { result: "ok", resumed: 4 },
    )
    const lines = (await readFile(join(outbox, "ops-session-resume.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(lines.map((line) => JSON.parse(line).to)).toEqual(Object.values(named))
  })

  test("a limit Claude Code announced it continues gets no line; one with no notice does", async () => {
    const { config, outbox } = setup()
    const project = join(config, "projects", "-w")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "a.jsonl"), `${LIMIT_LINE}\n${NOTICE}\n`)
    writeFileSync(join(project, "b.jsonl"), `${LIMIT_LINE}\n${QUEUED}\n`)
    const both = { a: "worker-brave-otter", b: "worker-calm-anchor" } as Record<string, string>
    const run = () => cycle({ configDir: config, live: sessions(both), now: after(GRACE_MS) })
    expect(await run()).toEqual({ result: "ok", resumed: 1 })
    expect(await run()).toEqual({ result: "ok", resumed: 0 })
    const lines = (await readFile(join(outbox, "ops-session-resume.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(lines.map((line) => JSON.parse(line).to)).toEqual(["worker-calm-anchor"])
  })

  test("only a continue notice after the newest limit line counts", () => {
    expect(continuesItself(`${LIMIT_LINE}\n${NOTICE}`, RESET)).toBe(true)
    expect(continuesItself(`${LIMIT_LINE}\n{"type":"system`, RESET)).toBe(false)
    expect(continuesItself("", RESET)).toBe(false)
    expect(continuesItself(`${GLM_LINE}\n${QUEUED}`, RESET)).toBe(false)
  })

  test("a message queued during the limit repeats its limit line, and the notice still counts", () => {
    expect(continuesItself(`${LIMIT_LINE}\n${NOTICE}\n${QUEUED}\n${LIMIT_LINE}`, RESET)).toBe(true)
    expect(continuesItself(`${LIMIT_LINE}\n${NOTICE}\n${LATER_LIMIT}`, RESET)).toBe(false)
    expect(continuesItself(`${LIMIT_LINE}\n${NOTICE}\n${GLM_LINE}`, RESET)).toBe(false)
  })

  test("an earlier limit's notice never covers a new limit that has none", () => {
    expect(continuesItself(`${LIMIT_LINE}\n${NOTICE}\n${QUEUED}\n${LATER_LIMIT}`, LATER)).toBe(
      false,
    )
    expect(continuesItself(`${LIMIT_LINE}\n${NOTICE}\n${LATER_LIMIT}\n${NOTICE}`, LATER)).toBe(true)
    expect(continuesItself(`${NOTICE}\n${LIMIT_LINE}`, RESET)).toBe(false)
  })

  test("the line names the reset and asks the session to carry on", () => {
    expect(resumeLine(RESET)).toBe(
      `Your usage limit reset at ${RESET}. Carry on with your task from where you stopped.`,
    )
  })

  test("with no session-state folder it does nothing", async () => {
    expect(
      await cycle({ configDir: scratch(), live: sessions({ x: "x" }), now: after(GRACE_MS) }),
    ).toEqual({ result: "ok", resumed: 0 })
  })

  test("queues one carry-on line to each factory session that lost its turn to a restart, once", async () => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    for (const id of ["a", "b", "c"])
      writeFileSync(join(states, `${id}.json`), JSON.stringify(midTurn(id)))
    const named = { a: "worker-brave-otter", b: "probe-sdk", c: "notes" }
    const run = () =>
      cycle({ configDir: config, live: sessions(named, STARTED), now: since(RESTART_GRACE_MS) })
    expect(await run()).toEqual({ result: "ok", resumed: 1 })
    expect(await run()).toEqual({ result: "ok", resumed: 0 })
    const lines = (
      await readFile(
        join(config, "playground", "ops", "outbox", "ops-session-resume.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      {
        at: since(RESTART_GRACE_MS)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
        job: "session-resume",
        text: restartLine(STARTED),
        to: "worker-brave-otter",
      },
    ])
  })

  test("a turn a person ended with Escape before the restart gets no carry-on line", async () => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    for (const id of ["a", "b"])
      writeFileSync(join(states, `${id}.json`), JSON.stringify(midTurn(id)))
    const project = join(config, "projects", "-w")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "a.jsonl"), `${interrupt(AFTER)}\n`)
    writeFileSync(join(project, "b.jsonl"), `${interrupt(BEFORE)}\n`)
    const named = { a: "worker-brave-otter", b: "worker-calm-anchor" }
    const run = () =>
      cycle({ configDir: config, live: sessions(named, STARTED), now: since(RESTART_GRACE_MS) })
    expect(await run()).toEqual({ result: "ok", resumed: 1 })
    expect(await run()).toEqual({ result: "ok", resumed: 0 })
    const lines = (
      await readFile(
        join(config, "playground", "ops", "outbox", "ops-session-resume.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
    expect(lines.map((line) => JSON.parse(line).to)).toEqual(["worker-calm-anchor"])
  })

  // The deleted-executable check queued a close-and-resume line for sessions like these; removed with no factory read of the Desktop folder left to protect. The pid runs a copy of this test's own bun binary whose file is gone, as a session on an update-deleted Claude Code runs.
  test("a session on a deleted executable, with the Desktop folder readable, queues no line (#1735)", async () => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    for (const id of ["a", "b"])
      writeFileSync(
        join(states, `${id}.json`),
        JSON.stringify({
          at: "2026-10-22T13:00:00.000Z",
          event: "Stop",
          sessionId: id,
          state: "idle",
        }),
      )
    const exe = join(config, "bun-copy")
    cpSync(process.execPath, exe)
    const proc = Bun.spawn([exe, "-e", "console.log('up'); await new Promise(() => {})"], {
      stdout: "pipe",
    })
    await proc.stdout.getReader().read()
    rmSync(exe)
    try {
      const named = { a: "worker-brave-otter", b: OLD.dispatcher } as Record<string, string>
      const run = () =>
        cycle({
          configDir: config,
          live: async () =>
            new Map(
              Object.entries(named).map(([id, name]) => [
                id,
                { cwd: `/work/${id}`, name, pid: proc.pid },
              ]),
            ),
        })
      expect(await run()).toEqual({ result: "ok", resumed: 0 })
      expect(await run()).toEqual({ result: "ok", resumed: 0 })
      expect(
        await readFile(
          join(config, "playground", "ops", "outbox", "ops-session-resume.jsonl"),
          "utf8",
        ).catch(() => ""),
      ).toBe("")
    } finally {
      proc.kill()
      await proc.exited
    }
  })
})

describe("the lead a failed turn is told to", () => {
  test(`a runner's is the ops seat and ${OLD.dispatcher}'s the builder's, by the roster beside the ops folder`, async () => {
    const ops = join(scratch(), "playground", "ops")
    expect(await leadName(ops, "runner-plain-relay")).toBe(OLD.ops)
    expect(await leadName(ops, OLD.dispatcher)).toBe(OLD.builder)
  })
})

describe("a turn that ended on an API error (#1637)", () => {
  const AT = "2026-10-22T12:10:51.120Z"
  const failed = (sessionId: string, at = AT): SessionState => ({
    at,
    event: "StopFailure",
    reason: "server_error",
    sessionId,
    state: "failed",
  })
  const pass = (n: number) => new Date(Date.parse(AT) + n * CYCLE_SECONDS * 1000)
  const setup = (ids: string[]) => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    for (const id of ids) writeFileSync(join(states, `${id}.json`), JSON.stringify(failed(id)))
    const agents = [
      { kind: "builder", name: "m4n7pq-builder", status: "working" },
      { kind: "worker", name: "k3m9px-worker", status: "working" },
    ]
    writeFileSync(join(config, "playground", "roster.json"), JSON.stringify({ agents }))
    const outbox = join(config, "playground", "ops", "outbox", "ops-session-resume.jsonl")
    const sent = async () =>
      (await readFile(outbox, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text: string; to: string })
        .map(({ text, to }) => [to, text])
    const fail = (id: string, at: Date) =>
      writeFileSync(join(states, `${id}.json`), JSON.stringify(failed(id, at.toISOString())))
    return { config, fail, sent, states }
  }
  // Claude Code 2.1.302's line for a thrashing stop (19 Oct), trimmed to the fields read.
  const THRASH_LINE = JSON.stringify({
    isApiErrorMessage: true,
    message: {
      content: [
        {
          text: "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.",
          type: "text",
        },
      ],
    },
    type: "assistant",
  })
  const named = { a: "k3m9px-worker", b: OLD.builder, c: OLD.dispatcher }
  const run = (config: string, n: number) =>
    cycle({
      configDir: config,
      live: async () => new Map(Object.entries(named).map(([id, name]) => [id, { name }])),
      now: pass(n),
    })

  test(`a live session gets one carry-on line on the next pass, and its lead and ${OLD.dispatcher} one alert a pass later`, async () => {
    const { config, sent } = setup(["a", "b", "ended"])
    expect(await run(config, 1)).toEqual({ result: "ok", resumed: 2 })
    expect(await sent()).toEqual([
      ["k3m9px-worker", failedLine("server_error", false)],
      [OLD.builder, failedLine("server_error", false)],
    ])
    expect(await run(config, 2)).toEqual({ result: "ok", resumed: 3 })
    expect(await run(config, 3)).toEqual({ result: "ok", resumed: 0 })
    const worker = failedAlert("k3m9px-worker", failed("a"), pass(2), false, false)
    expect((await sent()).slice(2)).toEqual([
      ["m4n7pq-builder", worker],
      [OLD.dispatcher, worker],
      [OLD.dispatcher, failedAlert(OLD.builder, failed("b"), pass(2), false, false)],
    ])
  })

  test(`${OLD.dispatcher}'s own failed turn alerts the builder's seat`, async () => {
    const { config, sent } = setup(["c"])
    expect(await run(config, 1)).toEqual({ result: "ok", resumed: 1 })
    expect(await run(config, 2)).toEqual({ result: "ok", resumed: 1 })
    expect(await run(config, 3)).toEqual({ result: "ok", resumed: 0 })
    expect(await sent()).toEqual([
      [OLD.dispatcher, failedLine("server_error", false)],
      ["m4n7pq-builder", failedAlert(OLD.dispatcher, failed("c"), pass(2), false, false)],
    ])
  })

  test("a new failure within the window of the last line goes to the alert at once, and one after it gets a line", async () => {
    const { config, fail, sent } = setup(["a"])
    expect(await run(config, 1)).toEqual({ result: "ok", resumed: 1 })
    for (const n of [5, 10, 15, 20]) {
      fail("a", pass(n))
      expect(await run(config, n + 1)).toEqual({ result: "ok", resumed: 2 })
      expect(await run(config, n + 2)).toEqual({ result: "ok", resumed: 0 })
    }
    const again = failedAlert(
      "k3m9px-worker",
      failed("a", pass(20).toISOString()),
      pass(21),
      false,
      true,
    )
    expect((await sent()).slice(-2)).toEqual([
      ["m4n7pq-builder", again],
      [OLD.dispatcher, again],
    ])
    const after = FAILED_WINDOW_MS / (CYCLE_SECONDS * 1000) + 5
    fail("a", pass(after))
    expect(await run(config, after + 1)).toEqual({ result: "ok", resumed: 1 })
    expect((await sent()).at(-1)).toEqual(["k3m9px-worker", failedLine("server_error", false)])
  })

  test("a thrashing stop gets small reads in its line, and its alert says to start it fresh", async () => {
    const { config, sent } = setup(["a"])
    mkdirSync(join(config, "projects", "p"), { recursive: true })
    writeFileSync(join(config, "projects", "p", "a.jsonl"), `${THRASH_LINE}\n`)
    expect(await run(config, 1)).toEqual({ result: "ok", resumed: 1 })
    expect(await run(config, 2)).toEqual({ result: "ok", resumed: 2 })
    const alert = failedAlert("k3m9px-worker", failed("a"), pass(2), true, false)
    expect(await sent()).toEqual([
      ["k3m9px-worker", failedLine("server_error", true)],
      ["m4n7pq-builder", alert],
      [OLD.dispatcher, alert],
    ])
  })

  test("a record that moved on, by a newer prompt or a Stop, gets neither line nor alert", async () => {
    const { config, sent, states } = setup(["a", "b"])
    const moved = (id: string, event: string, state: SessionState["state"]) =>
      writeFileSync(
        join(states, `${id}.json`),
        JSON.stringify({ at: pass(1).toISOString(), event, sessionId: id, state }),
      )
    moved("b", "Stop", "idle")
    expect(await run(config, 1)).toEqual({ result: "ok", resumed: 1 })
    moved("a", "UserPromptSubmit", "working")
    expect(await run(config, 2)).toEqual({ result: "ok", resumed: 0 })
    expect((await sent()).map(([to]) => to)).toEqual(["k3m9px-worker"])
  })

  test("the line asks the session to redo its step, and the alert names the session, the reason and how long it has stood", () => {
    expect(failedLine("server_error", false)).toBe(
      "Your last turn ended on an API error (server_error). Carry on with your task from where you stopped: redo the step that failed.",
    )
    expect(failedAlert("k3m9px-worker", failed("a"), pass(2), false, false)).toBe(
      "k3m9px-worker stopped on an API error (server_error) at 2026-10-22T12:10:51Z, and has stood 2m since, a pass after its carry-on line was queued. Resume it by SendMessage or respawn it from its brief.",
    )
    expect(failedAlert("k3m9px-worker", failed("a"), pass(2), true, true)).toBe(
      "k3m9px-worker stopped on autocompact thrashing again at 2026-10-22T12:10:51Z, within 30m of its last carry-on line. Start it fresh from its brief.",
    )
  })

  test("a stop is thrashing when the newest API error line says so", () => {
    expect(thrashed(`${THRASH_LINE}\n`)).toBe(true)
    expect(thrashed(`${THRASH_LINE}\n${GLM_LINE}\n`)).toBe(false)
    expect(thrashed("")).toBe(false)
  })
})

describe("the job's one folder", () => {
  test("its ledger and its heartbeat share opsDirOf, which follows PLAYGROUND_DATA_DIR, else ~/.playground", () => {
    expect(opsDirOf({ PLAYGROUND_DATA_DIR: "/data/dashboard" })).toBe("/data/dashboard/ops")
    expect(opsDirOf({ CLAUDE_CONFIG_DIR: "/elsewhere", HOME: "/home/someone" })).toBe(
      "/home/someone/.playground/ops",
    )
  })
})

// the dispatcher a failed turn's alert reaches is the one the roster seats, by its <id>-dispatcher name.
describe("the dispatcher a line goes to", () => {
  const opsWith = (agents: object[]) => {
    const config = scratch()
    mkdirSync(join(config, "ops"))
    writeFileSync(join(config, "roster.json"), JSON.stringify({ agents }))
    return join(config, "ops")
  }

  test(`the roster's live primary dispatcher, else ${OLD.dispatcher}`, async () => {
    const ops = opsWith([
      { name: OLD.dispatcher, status: "ended" },
      { name: "m4n7vw-dispatcher", status: "working" },
      { name: "q8r2tx-dispatcher", slot: "2", status: "working" },
    ])
    expect(await primaryDispatcher(ops)).toBe("m4n7vw-dispatcher")
    expect(await leadName(ops, "k3m9px-ops")).toBe("m4n7vw-dispatcher")
    expect(await leadName(ops, "m4n7vw-dispatcher")).toBe(OLD.builder)
    expect(await primaryDispatcher(opsWith([]))).toBe(OLD.dispatcher)
  })
})

// a stuck session its manager has not answered goes to OLD.dispatcher after 5 minutes, and a session working with no tool call for 15 to its manager; a session that has ended gets neither.
describe("a stuck or quiet session (PG-2184)", () => {
  const AT = "2026-10-26T05:00:00.000Z"
  const at = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000)
  const record = (sessionId: string, state: "stuck" | "working"): SessionState => ({
    at: AT,
    event: state === "stuck" ? "PermissionRequest" : "UserPromptSubmit",
    ...(state === "stuck" ? { reason: "permission", tool: "Bash" } : {}),
    sessionId,
    state,
  })
  const setup = (state: "stuck" | "working", transcriptAt = at(0)) => {
    const config = scratch()
    const states = join(config, "playground", "session-state")
    mkdirSync(states, { recursive: true })
    mkdirSync(join(config, "projects", "p"), { recursive: true })
    for (const id of ["a", "dead", "m"]) {
      writeFileSync(join(states, `${id}.json`), JSON.stringify(record(id, state)))
      const transcript = join(config, "projects", "p", `${id}.jsonl`)
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "user", timestamp: "2026-10-26T04:59:00.000Z" })}\n`,
      )
      utimesSync(transcript, transcriptAt, transcriptAt)
    }
    const agents = [
      { kind: "builder", name: "m4n7pq-builder", status: "working" },
      { kind: "worker", name: "k3m9px-worker", status: "working" },
    ]
    writeFileSync(join(config, "playground", "roster.json"), JSON.stringify({ agents }))
    const outbox = join(config, "playground", "ops", "outbox", "ops-session-resume.jsonl")
    const sent = async () =>
      (await readFile(outbox, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text: string; to: string })
    const named = { a: "k3m9px-worker", b: "m4n7pq-builder", m: OLD.dispatcher, o: "notes" }
    const run = (
      n: number,
      options: {
        localBusy?: (name: string) => Promise<boolean>
      } = {},
    ) =>
      cycle({
        configDir: config,
        live: async () => new Map(Object.entries(named).map(([id, name]) => [id, { name }])),
        now: at(n),
        ...options,
      })
    return { config, run, sent }
  }

  test(`a live session still stuck 5 minutes on goes to ${OLD.dispatcher} once; ${OLD.dispatcher}'s own and an ended session's do not`, async () => {
    const { run, sent } = setup("stuck")
    await run(4)
    expect(await sent()).toEqual([])
    await run(5)
    await run(6)
    const lines = await sent()
    expect(lines.map(({ to }) => to)).toEqual([OLD.dispatcher])
    expect(lines[0]!.text).toBe(stuckEscalation("k3m9px-worker", record("a", "stuck"), at(5)))
  })

  test(`a permission prompt's escalation carries its waiting call and the call's key, so ${OLD.dispatcher} can answer it`, async () => {
    const { config, run, sent } = setup("stuck")
    writeFileSync(
      join(config, "projects", "p", "a.jsonl"),
      `${JSON.stringify({
        message: {
          content: [
            { id: "t1", input: { command: "rm -rf build" }, name: "Bash", type: "tool_use" },
          ],
        },
        timestamp: "2026-10-26T04:59:30.000Z",
        type: "assistant",
      })}\n`,
    )
    await run(5)
    const lines = await sent()
    expect(lines.map(({ to }) => to)).toEqual([OLD.dispatcher])
    const key = callKey({ command: "rm -rf build" })
    expect(lines[0]!.text).toContain("It waits on:\nrm -rf build\n")
    expect(lines[0]!.text).toContain(`playground picker k3m9px-worker allow ${key}.`)
    expect(lines[0]!.text).toContain(`playground picker k3m9px-worker deny ${key} "`)
  })

  test("the escalation's call is the one the record names: its subagent's own, of the record's tool", async () => {
    const { config, run, sent } = setup("stuck")
    const use = (id: string, name: string, input: Record<string, unknown>) =>
      `${JSON.stringify({ message: { content: [{ id, input, name, type: "tool_use" }] }, timestamp: "2026-10-26T04:59:30.000Z", type: "assistant" })}\n`
    const states = join(config, "playground", "session-state")
    writeFileSync(
      join(states, "a.json"),
      JSON.stringify({ ...record("a", "stuck"), agentId: "s1" }),
    )
    writeFileSync(join(config, "projects", "p", "a.jsonl"), use("t1", "Bash", { command: "ls" }))
    mkdirSync(join(config, "projects", "p", "a", "subagents"), { recursive: true })
    writeFileSync(
      join(config, "projects", "p", "a", "subagents", "agent-s1.jsonl"),
      use("s1", "Bash", { command: "rm -rf a" }) + use("s2", "Read", { file_path: "/repo/x" }),
    )
    await run(5)
    const [line] = await sent()
    expect(line!.text).toContain("It waits on:\nrm -rf a\n")
    expect(line!.text).toContain(`allow ${callKey({ command: "rm -rf a" })}.`)
  })

  test("of two Bash calls in one message, the escalation names the first, the one the prompt is for", async () => {
    const { config, run, sent } = setup("stuck")
    writeFileSync(
      join(config, "projects", "p", "a.jsonl"),
      `${JSON.stringify({
        message: {
          content: [
            { id: "t1", input: { command: "ls a" }, name: "Bash", type: "tool_use" },
            { id: "t2", input: { command: "ls b" }, name: "Bash", type: "tool_use" },
          ],
        },
        timestamp: "2026-10-26T04:59:30.000Z",
        type: "assistant",
      })}\n`,
    )
    await run(5)
    const [line] = await sent()
    expect(line!.text).toContain("It waits on:\nls a\n")
  })

  test("the owner's own session, outside the factory, is not escalated", async () => {
    const { config, run, sent } = setup("stuck")
    const states = join(config, "playground", "session-state")
    for (const id of ["a", "dead", "m"]) rmSync(join(states, `${id}.json`))
    writeFileSync(join(states, "o.json"), JSON.stringify(record("o", "stuck")))
    writeFileSync(
      join(config, "projects", "p", "o.jsonl"),
      `${JSON.stringify({ type: "user", timestamp: "2026-10-26T04:59:00.000Z" })}\n`,
    )
    await run(5)
    expect(await sent()).toEqual([])
  })

  test("a stuck record the transcript has moved past (an Escape fires no hook) is not escalated", async () => {
    const { config, run, sent } = setup("stuck")
    const transcript = join(config, "projects", "p", "a.jsonl")
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", timestamp: "2026-10-26T05:01:00.000Z" })}\n`,
    )
    await run(5)
    expect(await sent()).toEqual([])
  })

  test("a live session working with no transcript write for 15 minutes tells its manager once", async () => {
    const { run, sent } = setup("working")
    await run(14)
    expect(await sent()).toEqual([])
    await run(15)
    await run(16)
    const lines = await sent()
    expect(lines.map(({ to }) => to)).toEqual(["m4n7pq-builder"])
    expect(lines[0]!.text).toStartWith("k3m9px-worker has made no tool call for 15 minutes.")
  })

  // A working session the local model serves is not quiet while the model is busy (localBusy true), so its flag is held back; it is quiet once localBusy reads false, which metricsBusy gives for an idle model and an unreadable /metrics alike (model.test.ts). A session the local model does not serve (Claude or GLM) is judged only by its idle, so localBusy is false there even while another model reads busy.
  test("a working session the local model serves is not quiet while its localBusy reads true, even after 15 minutes", async () => {
    const { run, sent } = setup("working")
    await run(15, { localBusy: async () => true })
    expect(await sent()).toEqual([])
  })

  test("a working session the model serves is quiet once 45 minutes pass, so a stuck one is flagged while others are served", async () => {
    const { run, sent } = setup("working")
    await run(45, { localBusy: async () => true })
    expect((await sent()).map(({ to }) => to)).toEqual(["m4n7pq-builder"])
  })

  test("a working session the local model serves is quiet once its localBusy reads false, still after 15 minutes", async () => {
    const { run, sent } = setup("working")
    await run(15, { localBusy: async () => false })
    const lines = await sent()
    expect(lines.map(({ to }) => to)).toEqual(["m4n7pq-builder"])
    expect(lines[0]!.text).toStartWith("k3m9px-worker has made no tool call for 15 minutes.")
  })

  // A session the local model does not serve is judged only by its idle, so localBusy is false there even while the model reads busy.
  test("a session the model does not serve is still flagged while the model reads busy", async () => {
    const { run, sent } = setup("working")
    await run(15, { localBusy: async () => false })
    expect((await sent()).map(({ to }) => to)).toEqual(["m4n7pq-builder"])
  })

  test("a session whose subagent is still writing is not quiet", async () => {
    const { config, run, sent } = setup("working")
    const subagents = join(config, "projects", "p", "a", "subagents")
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, "agent-1.jsonl"), "{}\n")
    utimesSync(join(subagents, "agent-1.jsonl"), at(10), at(10))
    await run(15)
    expect(await sent()).toEqual([])
  })

  test("the wait before the dispatcher is told is unstick.escalateMinutes, read at each pass", async () => {
    const { config, run, sent } = setup("stuck")
    const escalateAfter = (minutes: number) =>
      writeRoot(
        extensionsDir(join(config, "playground")),
        new Map([
          [
            "policy.json",
            JSON.stringify({
              orgs: {},
              schemaVersion: 1,
              values: { "unstick.escalateMinutes": minutes },
            }),
          ],
        ]),
      )
    escalateAfter(10)
    await run(6)
    expect(await sent()).toEqual([])
    escalateAfter(6)
    await run(7)
    expect((await sent()).map(({ to }) => to)).toEqual([await primaryDispatcher(opsDirOf())])
  })

  test("with PLAYGROUND_DATA_DIR set, the states and unstick.escalateMinutes come from that folder", async () => {
    const config = scratch()
    const data = join(scratch(), "data")
    const before = process.env.PLAYGROUND_DATA_DIR
    process.env.PLAYGROUND_DATA_DIR = data
    try {
      mkdirSync(sessionStateDir(data), { recursive: true })
      mkdirSync(join(config, "projects", "p"), { recursive: true })
      const stuck = (minutes: number) => {
        writeFileSync(
          join(sessionStateDir(data), "a.json"),
          JSON.stringify({ ...record("a", "stuck"), at: at(minutes).toISOString() }),
        )
        const transcript = join(config, "projects", "p", "a.jsonl")
        writeFileSync(
          transcript,
          `${JSON.stringify({ type: "user", timestamp: at(minutes - 1).toISOString() })}\n`,
        )
        utimesSync(transcript, at(minutes), at(minutes))
      }
      const agents = [{ kind: "worker", name: "k3m9px-worker", status: "working" }]
      writeFileSync(join(data, "roster.json"), JSON.stringify({ agents }))
      const escalateAfter = (minutes: number) =>
        writeRoot(
          extensionsDir(data),
          new Map([
            [
              "policy.json",
              JSON.stringify({
                orgs: {},
                schemaVersion: 1,
                values: { "unstick.escalateMinutes": minutes },
              }),
            ],
          ]),
        )
      const outbox = join(data, "ops", "outbox", "ops-session-resume.jsonl")
      const sent = async () =>
        (await readFile(outbox, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
      const run = (n: number) =>
        cycle({
          configDir: config,
          live: async () => new Map([["a", { name: "k3m9px-worker" }]]),
          now: at(n),
        })
      stuck(0)
      escalateAfter(3)
      await run(4)
      expect(await sent()).toHaveLength(1)
      stuck(10)
      escalateAfter(30)
      await run(30)
      expect(await sent()).toHaveLength(1)
    } finally {
      if (before === undefined) delete process.env.PLAYGROUND_DATA_DIR
      else process.env.PLAYGROUND_DATA_DIR = before
    }
  })
})
