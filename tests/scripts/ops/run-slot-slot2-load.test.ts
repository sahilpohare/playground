import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { SCRIPT, WAITING, machine, stop, within } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang
setDefaultTimeout(60_000)

// A machine with run-slot held by a small run, which leaves room for a medium one, and slots 3 and 4 off unless `off` is given, so a medium run can take only run-slot-2, at load1 2 and the load5 given, with run-slot.load5-cap's cap when one is given
const loaded = (load5: number, cap?: number, off = ["run-slot.3-off", "run-slot.4-off"]) => {
  const m = machine({ load1: 2, load5, off })
  m.hold("run-slot", 1, "small")
  if (cap !== undefined) writeFileSync(join(m.ops, "run-slot.load5-cap"), `${cap}\n`)
  // moves the fake load5 from one figure to another in sysctl and uptime, as a load that falls
  const setLoad5 = (from: number, to: number) => {
    for (const bin of ["sysctl", "uptime"]) {
      const path = join(m.bin, bin)
      writeFileSync(path, readFileSync(path, "utf8").split(from.toFixed(2)).join(to.toFixed(2)))
    }
  }
  const lane = (who: string) =>
    readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
      .split("\n")
      .find((l) => l.split(" ")[1] === "start" && l.split(" ")[2] === who)
      ?.split(" ")[4]
  return { ...m, lane, setLoad5 }
}
const MEDIUM = { RUN_SLOT_SIZE: "medium" }
// how many of run-slot to run-slot-4 `run-slot.sh slots` counts held or open
const slots = (m: ReturnType<typeof machine>) =>
  Bun.spawnSync(["bash", SCRIPT, "slots"], { cwd: m.root, env: m.env() }).stdout.toString()

// issue 1403, 7 Nov 11:07Z: two checker suites, one in run-slot and one in run-slot-2, took load5 to 17.96 on their own, since slot 2 took a holder at the cap unless single-slot mode was on
describe("slots 2 to 4 with single-slot mode off", () => {
  test("wait while load5 is at or over run-slot.load5-cap's cap", async () => {
    expect(await loaded(18, 15).waits("worker-m", MEDIUM)).toBe(true)
  })

  // #1378: cheap_sig read run-slot.load5-cap's first line while load_line reads its last, so a cap the operator set below its reason line moved nothing a waiter watched for
  test("a cap whose last line moves under a reason line lets a held waiter take slot 2", async () => {
    const m = loaded(16)
    writeFileSync(join(m.ops, "run-slot.load5-cap"), "raised for the shards\n14\n")
    const run = m.start("worker-m", { ...MEDIUM, RUN_SLOT_LOAD_WAIT: "600" })
    expect(await run.saw(WAITING)).toBe(true)
    writeFileSync(join(m.ops, "run-slot.load5-cap"), "raised for the shards\n20\n")
    // the check binds the run's own line, not wall time; within is the give-up if the line never comes (issue 1725: an 8 s wall-time race lost once in a 145-file batch, the look that reads the moved cap stretching under a batch's load)
    await within(() => run.stderr().includes("holds run-slot-2"), "the held waiter took slot 2", m)
    expect(await run.ran()).toBe(true)
  })

  // review round 1: the hold shut run-slot-2 alone, so a second heavy run took run-slot-3 or run-slot-4 at the cap while the lanes were open
  test("with run-slot-3 and run-slot-4 on as well", async () => {
    expect(await loaded(18, 15, []).waits("worker-m", MEDIUM)).toBe(true)
  })

  // review round 1: room and slots read the hold for a run asking now, so each counted run-slot-2 shut after the queue's head had waited out the hold
  test("and slots counts them from the queue's oldest waiter's ask", () => {
    const m = loaded(18, 15, [])
    expect(slots(m)).toBe("1\n")
    m.ticket(Math.floor(Date.now() / 1000 - 301) * 1e9, "worker-old", "s2 22 2 medium")
    expect(slots(m)).toBe("4\n")
  })

  // review round 2: a reread's new ticket took a new name, so each change of run-slot.sh started the hold's 300 s again
  test("and slots reads a ticket's first ask from its line, which a reread keeps, before its name", () => {
    const m = loaded(18, 15, [])
    const now = Math.floor(Date.now() / 1000)
    m.ticket(now * 1e9, "worker-reread", `s2 22 2 medium - ${now - 301}`)
    expect(slots(m)).toBe("4\n")
  })

  // review round 3: a short name's first 10 characters held its dashes, so the hold's sum failed and capacity counted no lanes
  test("and slots reads a short ticket name's leading number, as an older copy's or a fixture's", () => {
    const m = loaded(18, 15, [])
    m.ticket(2, "worker-a", "s2 22 2 medium")
    expect(slots(m)).toBe("4\n")
  })

  test("and one whose line's first ask is no number, by its name", () => {
    const m = loaded(18, 15, [])
    m.ticket(Math.floor(Date.now() / 1000 - 301) * 1e9, "worker-odd", "s2 22 2 medium - abc")
    expect(slots(m)).toBe("4\n")
  })

  test("but a dead waiter's old ticket times no hold", async () => {
    const m = loaded(18, 15, [])
    const gone = Bun.spawn(["true"])
    await gone.exited
    mkdirSync(join(m.ops, "run-slot.waiters"), { recursive: true })
    writeFileSync(join(m.ops, "run-slot.waiters", `2-${gone.pid}-worker-gone`), "s2 22 2 medium\n")
    expect(slots(m)).toBe("1\n")
  })

  test("and a waiter that runs a new copy of run-slot.sh keeps its first ask in its new ticket", async () => {
    const m = loaded(18, 15)
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    const run = m.start("worker-m", MEDIUM, copy)
    expect(await run.saw(WAITING)).toBe(true)
    const queue = join(m.ops, "run-slot.waiters")
    const first = readdirSync(queue)
    const asked = readFileSync(join(queue, first[0]), "utf8").split(" ")[5]
    copyFileSync(SCRIPT, `${copy}.new`)
    // copyFileSync keeps the source's mtime on macOS, so the copy takes the moment it lands, as a pull's write does
    utimesSync(`${copy}.new`, new Date(), new Date())
    renameSync(`${copy}.new`, copy)
    expect(await run.saw(/running the new copy/g)).toBe(true)
    let next = readdirSync(queue)
    while (next.length === 0 || next[0] === first[0]) {
      await Bun.sleep(50)
      next = readdirSync(queue)
    }
    const line = readFileSync(join(queue, next[0]), "utf8")
    await stop(run.p)
    expect(line.trim().split(" ")[5]).toBe(asked.trim())
  })

  test("and a run takes run-slot-2 once load5 is under the cap", async () => {
    const m = loaded(18, 15)
    const run = m.start("worker-m", MEDIUM)
    expect(await run.saw(WAITING)).toBe(true)
    m.setLoad5(18, 10)
    expect(await run.ran()).toBe(true)
    expect(m.lane("worker-m")).toBe("run-slot-2")
  })

  test("wait at load5 23 while no switch stands, since load_line's cap is then 22", async () => {
    expect(await loaded(23).waits("worker-m", MEDIUM)).toBe(true)
  })

  test("open at once under the cap", async () => {
    const m = loaded(14, 15)
    expect(await m.runs("worker-m", MEDIUM)).toBe(true)
    expect(m.lane("worker-m")).toBe("run-slot-2")
  })

  test("and open once the run has waited LOAD_WAIT s, with load5 still at the cap", async () => {
    const m = loaded(18, 15)
    expect(await m.runs("worker-m", { ...MEDIUM, RUN_SLOT_LOAD_WAIT: "2" })).toBe(true)
    expect(m.lane("worker-m")).toBe("run-slot-2")
  })

  for (const who of ["ops-dashboard", "ops-merge-train"])
    test(`but ${who} takes run-slot-2 at the cap`, async () => {
      const m = loaded(18, 15)
      expect(await m.runs(who, MEDIUM)).toBe(true)
      expect(m.lane(who)).toBe("run-slot-2")
    })
})
