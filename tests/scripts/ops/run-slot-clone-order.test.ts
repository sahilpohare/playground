import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { SCRIPT, deadline, machine, startOf, stop, within } from "./run-slot-fake"

// a check waits on a line its run prints or logs, so the timeout only catches a hang
setDefaultTimeout(60_000)

type Machine = ReturnType<typeof machine>
const SPACED = /^run-slot\.sh: this clone waits /gm
const cloning = (m: Machine, who: string, script = SCRIPT) => {
  mkdirSync(join(m.root, "node_modules"), { recursive: true })
  return m.start(who, {}, script, ["cp", "-R", "node_modules"])
}
// whether the clone waited (printed its spacing line and had not run when stopped) or ran
const clone = async (m: Machine, who: string) => {
  const run = cloning(m, who)
  if (await run.saw(SPACED)) {
    await stop(run.p)
    return existsSync(run.marker) ? "ran" : "waited"
  }
  return (await run.ran()) ? "ran" : "ended"
}
const log = (m: Machine) => {
  const path = join(m.ops, "run-slot.runs.log")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}
// the sessions whose clones have started, in the runs log's order
const started = (m: Machine) =>
  log(m)
    .split("\n")
    .map(startOf)
    .filter((f): f is string[] => f?.[2] === "run-slot-clone")
    .map((f) => f[0])
// both waiters' places listed in the order clone_first's glob reads them, the older ask time first
const ordered = (m: Machine) => {
  const names = readdirSync(join(m.ops, "run-slot.clone-waiters")).sort()
  return (
    names.length === 2 &&
    names.map((n) => n.split("-").slice(3).join("-")).join(",") === "worker-older,worker-newer"
  )
}

// issue 1314, 7 Nov: after a ship the Dashboard roll's clone waited about 17 minutes behind a worker's big test run on run-slot-2, so the live Dashboard stayed on the old version
describe("a big run on a CPU slot", () => {
  test("lets the Dashboard roll's clone start", async () => {
    const m = machine()
    m.hold("run-slot-2", 3, "big")
    expect(await clone(m, "ops-dashboard")).toBe("ran")
  })

  test("while it still holds a worker's clone", async () => {
    const m = machine()
    m.hold("run-slot-2", 3, "big")
    expect(await clone(m, "worker-c")).toBe("waited")
  })

  // issue 1317, 7 Nov 10:24 to 11:55Z: about 11 clones asked and none started while back-to-back big runs held a slot
  test("but a worker's clone that has waited CLONE_WAIT_MAX s passes it", async () => {
    const m = machine()
    m.hold("run-slot-2", 3, "big")
    mkdirSync(join(m.root, "node_modules"), { recursive: true })
    const run = m.start("worker-c", { RUN_SLOT_CLONE_WAIT_MAX: "2" }, SCRIPT, [
      "cp",
      "-R",
      "node_modules",
    ])
    expect(await run.ran()).toBe(true)
  })

  test("and the roll's clone still waits for the load brake", async () => {
    expect(await clone(machine({ cores: 8, load1: 2, load5: 4 }), "ops-dashboard")).toBe("waited")
  })
})

// issue 1317, 7 Nov: the first waiter to mkdir the clone lane won, so a reviewer's clone asked at 20:47:36Z waited 13385 s, passed by five clones asked after it
describe("the clone lane", () => {
  test("starts the older of two waiting clones first", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const older = cloning(m, "worker-older")
    expect(await older.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const newer = cloning(m, "worker-newer")
    // the order is decided once both places are listed, the older's ask time first, so the lane frees with the order decided; the two waits share one budget, since chained waits of their own can outlast bun's hang ceiling
    const chain = deadline()
    await within(() => ordered(m), "both waiters listed, the older first", m, chain)
    m.release("run-slot-clone")
    await within(() => started(m).length > 0, "a clone started", m, chain)
    await Promise.all([stop(older.p), stop(newer.p)])
    expect(started(m)[0]).toBe("worker-older")
  })

  // issues 1619 and 1688: the ask field was second-resolved, so two clones that asked in one second tied and the name's glob fell to the pid, which does not track ask order
  test("and one that asked later within the same second waits behind the earlier one", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const older = cloning(m, "worker-older")
    expect(await older.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const mine = readdirSync(join(m.ops, "run-slot.clone-waiters")).find((n) =>
      n.endsWith("-worker-older"),
    )!
    const [seconds, ns] = mine.split("-")[1]!.split(".")
    // the same second, just after the older's ask, in the format the asker writes its asked field
    const later =
      ns === undefined
        ? seconds!
        : ns === "999999999"
          ? `${Number(seconds!) + 1}.000000000`
          : `${seconds}.${String(Number(ns) + 1).padStart(9, "0")}`
    // pid 1 always sorts ahead of a real waiter's pid at the same asked field, so a second-resolved ask hands the lane to this later one
    const one = Bun.spawnSync(["ps", "-o", "lstart=", "-p", "1"], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })
      .stdout.toString()
      .trim()
    writeFileSync(join(m.ops, "run-slot.clone-waiters", `2-${later}-1-worker-later`), `${one}\n`)
    m.release("run-slot-clone")
    await within(() => started(m).length > 0, "a clone started", m)
    await stop(older.p)
    expect(started(m)[0]).toBe("worker-older")
  })

  // the stamp intake takes digits and dots alone, as RUN_SLOT_ASKED's does, so a value with /, - or a space cannot name a ticket; the waiter stamps itself fresh instead
  test("and takes no ask stamp that holds a character outside digits and dots", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const run = m.start("worker-stamped", { RUN_SLOT_ASK_STAMP: "a9.1b -c" }, SCRIPT, [
      "cp",
      "-R",
      "node_modules",
    ])
    expect(await run.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const mine = readdirSync(join(m.ops, "run-slot.clone-waiters")).find((n) =>
      n.endsWith("-worker-stamped"),
    )!
    await stop(run.p)
    expect(mine.split("-")[1]).toMatch(/^\d+\.\d{9}$/)
  })

  // a clock read that fails at the first ask still hands the reread a stamp, so the new copy names the ticket as the first copy did and no waiter waits behind one of its own names
  test("and a waiter whose first clock read fails keeps its one ticket across a reread", async () => {
    const m = machine()
    const armed = join(m.root, "python-armed")
    writeFileSync(
      join(m.bin, "python3"),
      `#!/bin/bash\n[ -e "${armed}" ] || exit 1\nexec ${Bun.which("python3")} "$@"\n`,
    )
    chmodSync(join(m.bin, "python3"), 0o755)
    m.hold("run-slot-clone", 1, "small")
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    const older = m.start("worker-clocked", {}, copy, ["cp", "-R", "node_modules"])
    expect(await older.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const queue = join(m.ops, "run-slot.clone-waiters")
    const first = readdirSync(queue)
    expect(first).toHaveLength(1)
    writeFileSync(armed, "")
    copyFileSync(SCRIPT, `${copy}.new`)
    // copyFileSync keeps the source's mtime on macOS, so the copy takes the moment it lands, as a pull's write does
    utimesSync(`${copy}.new`, new Date(), new Date())
    renameSync(`${copy}.new`, copy)
    expect(await older.saw(/running the new copy/g)).toBe(true)
    // the new copy's own waiting line comes after its ticket is written, so the count below reads both copies' tickets and cannot pass before the reread's write
    expect(await older.saw(/^run-slot\.sh: waiting for the clone slot/gm, 2)).toBe(true)
    await within(() => readdirSync(queue).length === 1, "one ticket across the reread", m)
    expect(readdirSync(queue)).toEqual(first)
    await stop(older.p)
  })

  test("but the Dashboard roll's clone, class 0, goes before an older worker's", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const worker = cloning(m, "worker-older")
    expect(await worker.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const roll = cloning(m, "ops-dashboard")
    expect(await roll.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    m.release("run-slot-clone")
    await within(() => started(m).length > 0, "a clone started", m)
    await Promise.all([stop(worker.p), stop(roll.p)])
    expect(started(m)[0]).toBe("ops-dashboard")
  })

  // issue 1722: the class decides the line a waiting ship's clone prints, so the row reads either and the start order decides
  test("and a ship's clone, class 0 as ops-ship, goes before an older worker's", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const waiting = /^run-slot\.sh: (waiting for the clone slot|this clone waits behind)/gm
    const worker = cloning(m, "worker-older")
    expect(await worker.saw(waiting)).toBe(true)
    const ship = cloning(m, "ops-ship")
    expect(await ship.saw(waiting)).toBe(true)
    m.release("run-slot-clone")
    await within(() => started(m).length > 0, "a clone started", m)
    await Promise.all([stop(worker.p), stop(ship.p)])
    expect(started(m)[0]).toBe("ops-ship")
  })

  // issue 1317's added Done when: a queue read sees each clone waiter
  test("lists each waiting clone in run-slot.clone-waiters", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const run = cloning(m, "worker-listed")
    expect(await run.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const listed = readdirSync(join(m.ops, "run-slot.clone-waiters"))
    const heavy = join(m.ops, "run-slot.waiters")
    const queued = existsSync(heavy) ? readdirSync(heavy) : []
    await stop(run.p)
    expect(listed.map((n) => n.split("-").slice(3).join("-"))).toEqual(["worker-listed"])
    // the heavy queue, which room and spawn.sh's gate count, holds no clone
    expect(queued.filter((n) => n.endsWith("-worker-listed"))).toEqual([])
  })

  // the lead's check on the round 1 fix: a waiter no gate holds keeps its place across a reread
  test("and an older waiter that runs a new copy keeps its place ahead of a newer one", async () => {
    const m = machine()
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    m.hold("run-slot-clone", 1, "small")
    const older = cloning(m, "worker-older", copy)
    expect(await older.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    const newer = cloning(m, "worker-newer")
    const chain = deadline()
    await within(() => ordered(m), "both waiters listed, the older first", m, chain)
    copyFileSync(SCRIPT, `${copy}.new`)
    utimesSync(`${copy}.new`, new Date(), new Date())
    renameSync(`${copy}.new`, copy)
    expect(await older.saw(/running the new copy/g)).toBe(true)
    m.release("run-slot-clone")
    await within(() => started(m).length > 0, "a clone started", m, chain)
    await Promise.all([stop(older.p), stop(newer.p)])
    expect(started(m)[0]).toBe("worker-older")
  })

  // review round 1: a reread's exec kept the entry while the new copy waited in clone_held, so a clone clone-allow names waited behind a waiter clone-off parked
  test("and a waiter a gate holds after its reread holds back no clone the gate lets through", async () => {
    const m = machine({ pressure: 4 })
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    m.hold("run-slot-clone", 1, "small")
    const parked = cloning(m, "worker-parked", copy)
    expect(await parked.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    writeFileSync(join(m.ops, "run-slot.clone-off"), "")
    writeFileSync(join(m.ops, "run-slot.clone-allow"), "worker-allowed\n")
    copyFileSync(SCRIPT, `${copy}.new`)
    // copyFileSync keeps the source's mtime on macOS, so the copy takes the moment it lands, as a pull's write does
    utimesSync(`${copy}.new`, new Date(), new Date())
    renameSync(`${copy}.new`, copy)
    expect(await parked.saw(/running the new copy/g)).toBe(true)
    const queue = join(m.ops, "run-slot.clone-waiters")
    const parkedListed = () => readdirSync(queue).some((n) => n.endsWith("-worker-parked"))
    // the new copy drops its place in clone-off's loop; the old one held it there for good
    let deadline = Date.now() + 20_000
    while (parkedListed() && Date.now() < deadline) await Bun.sleep(50)
    const dropped = !parkedListed()
    m.release("run-slot-clone")
    const allowed = cloning(m, "worker-allowed", copy)
    // its start line follows its holds line, so the check reads the runs log
    deadline = Date.now() + 20_000
    while (started(m).length === 0 && Date.now() < deadline) await Bun.sleep(50)
    await Promise.all([stop(parked.p), stop(allowed.p)])
    expect(dropped).toBe(true)
    expect(started(m)).toEqual(["worker-allowed"])
  })

  // issue 1316: a run-slot.sh waiter can outlive its test or die without a clean exit, so no stale place may hold the lane
  test("and a waiter stopped by TERM gives up its place, so the next one takes the lane", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const stopped = cloning(m, "worker-stopped")
    expect(await stopped.saw(/^run-slot\.sh: waiting for the clone slot/gm)).toBe(true)
    stopped.p.kill("SIGTERM")
    await stopped.p.exited
    expect(readdirSync(join(m.ops, "run-slot.clone-waiters"))).toEqual([])
    m.release("run-slot-clone")
    expect(await clone(m, "worker-c")).toBe("ran")
  })

  const place = (m: Machine, pid: number, started: string) => {
    mkdirSync(join(m.ops, "run-slot.clone-waiters"), { recursive: true })
    writeFileSync(join(m.ops, "run-slot.clone-waiters", `2-1-${pid}-worker-gone`), `${started}\n`)
  }

  test("and a dead waiter's place holds back no clone", async () => {
    const m = machine()
    const gone = Bun.spawn(["true"])
    await gone.exited
    place(m, gone.pid, "Thu Jan 1 00:00:00 1970")
    expect(await clone(m, "worker-c")).toBe("ran")
  })

  test("nor does one whose pid a later process has taken", async () => {
    const m = machine()
    place(m, process.pid, "Thu Jan 1 00:00:00 1970")
    expect(await clone(m, "worker-c")).toBe("ran")
  })
})
