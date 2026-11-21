import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { capacityLog, lw, placing, root, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

const ID = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"
type Row = { name: string; status: string; priority?: string }
const row = (name: string, status = "working", extra: Partial<Row> = {}) => ({
  name,
  role: "worker",
  status,
  task: "t",
  ...extra,
})
// Two live rows the count reads, a new name's and an old one's, beside rows it leaves out: an ended worker, a live runner, probe and lead.
const FLOOR = [
  row("b9dqhp-worker"),
  row("reviewer-brave-otter", "waiting"),
  row("w82s8w-worker", "ended"),
  row("k3m9qz-runner"),
  row("probe-x"),
  { ...row("builder"), role: "manager", kind: "builder" },
]
const env = (cap: number | undefined, rows: object[]) => ({
  FAKE_CPU_IDLE: "80",
  ROSTER_JSON: JSON.stringify({ agents: rows }),
  ...(cap === undefined ? {} : { SETTINGS_JSON: JSON.stringify({ "gates.sessionCap": cap }) }),
})
const worker = ["worker", "t4n7vx-worker", "b.md"]
const reviewer = [
  "column",
  "reviewer",
  "t4n7vx-reviewer",
  "b9dqhp-worker",
  "w1:p2",
  "b.md",
  "--pr",
  "1",
]
const start = (
  args: string[],
  cap: number | undefined,
  rows: object[] = FLOOR,
  setup?: (home: string) => void,
) => spawn(args, [], env(cap, rows), undefined, undefined, setup)
const priorityFile = (home: string) =>
  writeFileSync(join(home, ".playground", "priority.json"), "{}")

describe("the sessions gate caps the live workers and checkers at gates.sessionCap", () => {
  test.each([
    ["a worker", worker],
    ["a reviewer", reviewer],
  ])(
    "%s start at the cap is refused before a pane opens, naming the count and the cap",
    async (_, args) => {
      const r = await start(args, 2)
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(
        "the sessions gate holds it: 2 live workers and checkers in the roster (b9dqhp-worker, reviewer-brave-otter), and gates.sessionCap is 2",
      )
      expect(capacityLog(r)).toEqual([
        expect.objectContaining({
          gate: "sessions",
          readings: expect.objectContaining({ session_cap: 2, sessions: 2 }),
          verdict: "refused",
        }),
      ])
    },
  )

  test.each([
    ["a worker", worker],
    ["a reviewer", reviewer],
  ])("%s start under the cap passes", async (_, args) => {
    const r = await start(args, 3)
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ session_cap: 3, sessions: 2 }),
        verdict: "pass",
      }),
    ])
  })

  test("with the setting unset, no count holds a start", async () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`worker-n${i}`))
    const r = await start(worker, undefined, many)
    expect(r.code).toBe(0)
    const [line] = capacityLog(r)
    expect(line).toEqual(expect.objectContaining({ verdict: "pass" }))
    expect(line.readings.sessions).toBeUndefined()
  })

  test("a session's own live row, as roster.ts assign leaves it, is not counted twice", async () => {
    const r = await start(reviewer, 3, [...FLOOR, row("t4n7vx-reviewer")])
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ sessions: 2 }),
        verdict: "pass",
      }),
    ])
  })

  test("a --priority start at the cap passes while a priority file stands, and its row is marked", async () => {
    const r = await start([...worker, "--priority"], 2, FLOOR, priorityFile)
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          priority: expect.stringMatching(/\/\.playground\/priority\.json$/),
        }),
        verdict: "pass",
      }),
    ])
    expect(r.roster).toContain("priority=1")
  })

  test("at the cap by raw rows, a row a --priority start marked counts against no other start", async () => {
    const r = await start(worker, 3, [...FLOOR, row("x9cqmz-worker", "working", { priority: "1" })])
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ sessions: 2 }),
        verdict: "pass",
      }),
    ])
  })

  test("a start without --priority clears the mark a row kept", async () => {
    const r = await start(worker, 3, [...FLOOR, row("t4n7vx-worker", "ended", { priority: "1" })])
    expect(r.code).toBe(0)
    expect(r.roster).toContain("priority=")
    expect(r.roster).not.toContain("priority=1")
  })

  test("a resume of a row already counted passes over the cap", async () => {
    const r = await spawn(
      ["resume", "t4n7vx-worker", root, ID],
      [],
      env(2, [...FLOOR, row("t4n7vx-worker")]),
      undefined,
      { name: "t4n7vx-worker", backend: "claude" },
    )
    expect(r.err).not.toContain("the sessions gate holds it")
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ counted: true, sessions: 2 }),
        verdict: "pass",
      }),
    ])
  })

  test("a resume of an ended row at the cap is refused as a new start is", async () => {
    const r = await spawn(
      ["resume", "t4n7vx-worker", root, ID],
      [],
      env(2, [...FLOOR, row("t4n7vx-worker", "ended")]),
      undefined,
      { name: "t4n7vx-worker", backend: "claude" },
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("the sessions gate holds it")
  })

  // a Claude Code update closes a live row, ending it, then resumes it: the count held it before the close
  test("a resume 2 minutes after spawn.sh close ended its live row passes at the cap", async () => {
    const r = await spawn(
      ["resume", "t4n7vx-worker", root, ID],
      [],
      env(2, [...FLOOR, row("t4n7vx-worker", "ended")]),
      undefined,
      { name: "t4n7vx-worker", backend: "claude" },
      (home) => {
        mkdirSync(lw(home, "closes"), { recursive: true })
        const at = new Date(Date.now() - 2 * 60_000)
        writeFileSync(
          lw(home, "closes", "t4n7vx-worker"),
          `${Math.floor(at.getTime() / 1000)} ${at.toISOString().slice(0, 19)}Z working\n`,
        )
      },
    )
    expect(r.err).not.toContain("the sessions gate holds it")
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          counted: true,
          just_closed: expect.stringContaining("its working row closed at "),
          sessions: 2,
        }),
        verdict: "pass",
      }),
    ])
  })
})
