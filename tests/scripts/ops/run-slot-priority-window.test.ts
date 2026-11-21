import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, WAITING, machine, runSlot } from "./run-slot-fake"

setDefaultTimeout(60_000)

type Machine = ReturnType<typeof machine>

// a window as playground priority on writes it (packages/scripts/src/playground/priority.ts), in the machine's own scratch data folder
const window = (m: Machine, session: string, since: string, name = `priority-${session}.json`) => {
  const data = m.env().PLAYGROUND_DATA_DIR
  mkdirSync(data, { recursive: true })
  writeFileSync(
    join(data, name),
    `${JSON.stringify({ by: "dispatcher", reason: "the owner's ask", session, since }, null, 2)}\n`,
  )
}

const starts = (m: Machine) =>
  readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
    .split("\n")
    .filter((l) => l.split(" ")[1] === "start")
    .map((l) => l.split(" ")[2])

// One slot, held; an older waiter of another session, then the later waiters named; the slot freed, the order the waiters started in
const order = async (setup: (m: Machine) => void, later = ["worker-p"]) => {
  const m = machine({ idle: 30 })
  setup(m)
  m.hold("run-slot", 1, "small")
  const older = m.start("worker-o", { RUN_SLOT_SIZE: "small" })
  expect(await older.saw(WAITING)).toBe(true)
  const rest = []
  for (const who of later) {
    const w = m.start(who, { RUN_SLOT_SIZE: "small" })
    expect(await w.saw(WAITING)).toBe(true)
    rest.push(w)
  }
  m.release("run-slot")
  expect(await older.ran()).toBe(true)
  for (const w of rest) expect(await w.ran()).toBe(true)
  return starts(m)
}

describe("a priority window's session", () => {
  test("takes the freed slot before an older waiter", async () => {
    expect(await order((m) => window(m, "worker-p", "2026-11-16T20:00:00.000Z"))).toEqual([
      "worker-p",
      "worker-o",
    ])
  })

  test("but not while its window is lifted", async () => {
    expect(
      await order((m) =>
        window(
          m,
          "worker-p",
          "2026-11-16T20:00:00.000Z",
          "priority-worker-p.json.lifted-20261116T210000Z",
        ),
      ),
    ).toEqual(["worker-o", "worker-p"])
  })

  test("and a job's own priority-start.json names no pick", async () => {
    expect(
      await order((m) => window(m, "worker-p", "2026-11-16T20:00:00.000Z", "priority-start.json")),
    ).toEqual(["worker-o", "worker-p"])
  })

  test("nor does an org's own priority file, or one with no since or bad JSON", async () => {
    expect(
      await order(
        (m) => {
          const data = m.env().PLAYGROUND_DATA_DIR
          mkdirSync(data, { recursive: true })
          writeFileSync(
            join(data, "priority-acme.json"),
            `${JSON.stringify({ org: "acme", reason: "x" }, null, 2)}\n`,
          )
          writeFileSync(
            join(data, "priority-worker-p.json"),
            '{\n  "session": "worker-p",\n  "since": "2026-11-16T20:00:00.000Z",\n',
          )
          writeFileSync(
            join(data, "priority-worker-q.json"),
            `${JSON.stringify({ session: "worker-q" }, null, 2)}\n`,
          )
        },
        ["worker-p", "worker-q"],
      ),
    ).toEqual(["worker-o", "worker-p", "worker-q"])
  })

  // round 1 of the review: a file whose braces were whole but whose middle broke held the pick, which off and the lapse cannot lift, since readWindow refuses it
  // round 2: a missing comma after by, or a trailing one after since, still named a pick, though JSON.parse refuses both
  test("nor a file with whole braces and a broken line, a missing or trailing comma, or a hand-written one with no by", async () => {
    const lines = (...l: string[]) => `${l.join("\n")}\n`
    expect(
      await order(
        (m) => {
          const data = m.env().PLAYGROUND_DATA_DIR
          mkdirSync(data, { recursive: true })
          writeFileSync(
            join(data, "priority-worker-p.json"),
            lines(
              "{",
              '  "by": ,',
              '  "reason": "x",',
              '  "session": "worker-p",',
              '  "since": "2026-11-16T20:00:00.000Z"',
              "}",
            ),
          )
          writeFileSync(
            join(data, "priority-worker-q.json"),
            `${JSON.stringify({ reason: "x", session: "worker-q", since: "2026-11-16T20:00:00.000Z" }, null, 2)}\n`,
          )
          writeFileSync(
            join(data, "priority-worker-r.json"),
            lines(
              "{",
              '  "by": "dispatcher"',
              '  "reason": "x",',
              '  "session": "worker-r",',
              '  "since": "2026-11-16T20:00:00.000Z"',
              "}",
            ),
          )
          writeFileSync(
            join(data, "priority-worker-s.json"),
            lines(
              "{",
              '  "by": "dispatcher",',
              '  "reason": "x",',
              '  "session": "worker-s",',
              '  "since": "2026-11-16T20:00:00.000Z",',
              "}",
            ),
          )
        },
        ["worker-p", "worker-q", "worker-r", "worker-s"],
      ),
    ).toEqual(["worker-o", "worker-p", "worker-q", "worker-r", "worker-s"])
  })

  // a window emptied mid-write names no pick, as spawn.sh's --priority passes no start on it (#2491)
  test("nor a window emptied mid-write", async () => {
    expect(
      await order((m) => {
        const data = m.env().PLAYGROUND_DATA_DIR
        mkdirSync(data, { recursive: true })
        writeFileSync(join(data, "priority-worker-p.json"), "")
      }),
    ).toEqual(["worker-o", "worker-p"])
  })

  // the shape on writes, a reason holding an escaped quote and a backslash, still names its session
  test("while a window whose reason holds an escaped quote still names its session", async () => {
    expect(
      await order((m) => {
        const data = m.env().PLAYGROUND_DATA_DIR
        mkdirSync(data, { recursive: true })
        writeFileSync(
          join(data, "priority-worker-p.json"),
          `${JSON.stringify({ by: "dispatcher", reason: 'a "quoted" word \\ and a backslash', session: "worker-p", since: "2026-11-16T20:00:00.000Z" }, null, 2)}\n`,
        )
      }),
    ).toEqual(["worker-p", "worker-o"])
  })

  test("goes oldest window first, past an older window whose session has no run waiting", async () => {
    expect(
      await order(
        (m) => {
          window(m, "worker-gone", "2026-11-16T19:00:00.000Z")
          window(m, "worker-q", "2026-11-16T20:30:00.000Z")
          window(m, "worker-p", "2026-11-16T20:00:00.000Z")
        },
        ["worker-q", "worker-p"],
      ),
    ).toEqual(["worker-p", "worker-q", "worker-o"])
  })

  test("waits behind a hand-written run-slot.priority whose session is waiting", async () => {
    expect(
      await order(
        (m) => {
          window(m, "worker-p", "2026-11-16T20:00:00.000Z")
          writeFileSync(join(m.ops, "run-slot.priority"), "worker-h\n")
        },
        ["worker-p", "worker-h"],
      ),
    ).toEqual(["worker-h", "worker-p", "worker-o"])
  })

  test("and goes ahead of a hand-written pick whose session has no run waiting", async () => {
    expect(
      await order((m) => {
        window(m, "worker-p", "2026-11-16T20:00:00.000Z")
        writeFileSync(join(m.ops, "run-slot.priority"), "worker-idle\n")
      }),
    ).toEqual(["worker-p", "worker-o"])
  })

  // a commit's build queues as commit-<worktree>, which reads as the session that last ran run-slot from that worktree (run-slot.owner/<worktree>)
  test("has its commit step, from a worktree it last ran from, take the slot before an older waiter", async () => {
    const m = machine({ idle: 30 })
    window(m, "worker-p", "2026-11-16T20:00:00.000Z")
    const tree = join(m.root, ".claude", "worktrees", "wt-p")
    mkdirSync(tree, { recursive: true })
    expect(await m.start("worker-p", {}, undefined, ["touch"], tree).ran()).toBe(true)
    m.hold("run-slot", 1, "small")
    const other = m.start("worker-o", { RUN_SLOT_SIZE: "small" })
    expect(await other.saw(WAITING)).toBe(true)
    const commit = m.start("commit-wt-p", { RUN_SLOT_SIZE: "small" })
    expect(await commit.saw(WAITING)).toBe(true)
    m.release("run-slot")
    expect(await other.ran()).toBe(true)
    expect(await commit.ran()).toBe(true)
    expect(starts(m).slice(1)).toEqual(["commit-wt-p", "worker-o"])
  })

  // the oldest waiter writes run-slot.next ("<first> <first s2> <pick's first ticket>") after each look, so a window opened while it waits shows there once a look reads it
  test("opening a window wakes the oldest waiter, which names the window's ticket next", async () => {
    const m = machine({ idle: 30, poll: 0.2 })
    m.hold("run-slot", 1, "small")
    const older = m.start("worker-o", { RUN_SLOT_SIZE: "small" })
    expect(await older.saw(WAITING)).toBe(true)
    const p = m.start("worker-p", { RUN_SLOT_SIZE: "small" })
    expect(await p.saw(WAITING)).toBe(true)
    const next = join(m.ops, "run-slot.next")
    const named = () =>
      existsSync(next) ? (readFileSync(next, "utf8").trim().split(" ")[2] ?? "") : ""
    await Bun.sleep(1000)
    expect(named()).toBe("-")
    window(m, "worker-p", "2026-11-16T20:00:00.000Z")
    const at = Date.now()
    while (!named().endsWith("-worker-p") && Date.now() - at < 10_000) await Bun.sleep(100)
    expect(named()).toEndWith("-worker-p")
    m.release("run-slot")
    expect(await p.ran()).toBe(true)
    expect(await older.ran()).toBe(true)
  })
})

// spawn.sh's --priority reads a session's own window through run-slot.sh window, the reader the queue's pick uses, so the two agree on every file (#2491)
describe("run-slot.sh window", () => {
  const read = async (name: string, text: string) => {
    const m = machine({})
    const data = m.env().PLAYGROUND_DATA_DIR
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, name), text)
    const p = runSlot(["bash", SCRIPT, "window", join(data, name)], {
      env: m.env(),
      ops: m.ops,
      stderr: "pipe",
    })
    return { code: await p.exited, out: (await new Response(p.stdout).text()).trim() }
  }
  const shaped = (session: string) =>
    `${JSON.stringify({ by: "dispatcher", reason: "the owner's ask", session, since: "2026-11-16T20:00:00.000Z" }, null, 2)}\n`

  test("prints the session of a window in playground priority on's shape", async () => {
    expect(await read("priority-worker-p.json", shaped("worker-p"))).toEqual({
      code: 0,
      out: "worker-p",
    })
  })

  test.each([
    ["an empty file", "priority-worker-p.json", ""],
    ["a truncated one", "priority-worker-p.json", shaped("worker-p").slice(0, 40)],
    [
      "one on a single line",
      "priority-worker-p.json",
      `${JSON.stringify(JSON.parse(shaped("worker-p")))}\n`,
    ],
    ["another file's session", "priority-worker-q.json", shaped("worker-p")],
    ["a job's priority-start.json", "priority-start.json", shaped("start")],
  ])("prints nothing and exits 1 on %s", async (_, name, text) => {
    expect(await read(name, text)).toEqual({ code: 1, out: "" })
  })
})
