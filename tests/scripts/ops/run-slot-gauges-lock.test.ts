import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, machine, runSlot } from "./run-slot-fake"

// a check waits on its looks' exits, so the timeout only catches a hang
setDefaultTimeout(60_000)

type Machine = ReturnType<typeof machine>
const now = () => Math.floor(Date.now() / 1000)
const tops = (m: Machine) => {
  const path = join(m.root, "top.log")
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0
}
// a cached reading taken `age` seconds ago
const cache = (m: Machine, age: number, idle: string, swap = "0") =>
  writeFileSync(join(m.ops, "run-slot.gauges"), `${now() - age} ${idle} ${swap}\n`)
const lock = (m: Machine) => join(m.ops, "run-slot.gauges.lock")
// a lock a refresher took `age` seconds ago
const held = (m: Machine, age: number) => {
  mkdirSync(lock(m))
  utimesSync(lock(m), now() - age, now() - age)
}
// starts one look, as a waiter's poll does
const start = (m: Machine) =>
  runSlot(["bash", SCRIPT, "slots"], { cwd: m.root, env: m.env(), stderr: "pipe", ops: m.ops })
// what one look printed: how many of run-slot to run-slot-4 are held or open, and its stderr
const read = async (p: ReturnType<typeof start>) => {
  await p.exited
  return {
    err: await new Response(p.stderr).text(),
    slots: (await new Response(p.stdout).text()).trim(),
  }
}
// the slot counts `count` looks started together read
const slotsTogether = async (m: Machine, count = 1) =>
  (await Promise.all(Array.from({ length: count }, () => read(start(m))))).map((r) => r.slots)

// 3 Nov, 10:53 to 10:58Z: 26 waiters each found run-slot.gauges stale and ran top at once, 16 to 23 tops at a time, and load1 reached 56.8
describe("the gauges refresh under one lock", () => {
  test("eight looks at a stale reading run top once", async () => {
    const m = machine({ topDelay: 1 })
    cache(m, 60, "80")
    expect(await slotsTogether(m, 8)).toEqual(Array(8).fill("4"))
    expect(tops(m)).toBe(1)
  })

  test("eight looks with no reading yet run top once", async () => {
    const m = machine({ topDelay: 1 })
    await slotsTogether(m, 8)
    expect(tops(m)).toBe(1)
  })

  test("the refresher takes the lock away once it has written the reading", async () => {
    const m = machine()
    expect(await slotsTogether(m)).toEqual(["4"])
    expect(existsSync(lock(m))).toBe(false)
    // the last two fields are the swap-ins and the idle share of the reading before it, none here
    expect(readFileSync(join(m.ops, "run-slot.gauges"), "utf8")).toMatch(
      /^\d+ 80 0 120 3\.50 - -\n$/,
    )
  })

  test("a look that finds the lock held keeps the stale reading and runs no top", async () => {
    const m = machine({ idle: 80 })
    cache(m, 60, "30")
    held(m, 0)
    expect(await slotsTogether(m)).toEqual(["1"])
    expect(tops(m)).toBe(0)
  })

  test("a look that finds the lock held and no reading at all keeps the lanes shut, saying a reading is in progress", async () => {
    const m = machine({ idle: 80 })
    held(m, 0)
    const { err, slots } = await read(start(m))
    expect(slots).toBe("1")
    expect(err).toContain("another look is reading the CPU's idle share")
    expect(err).not.toContain("cannot read the CPU's idle share")
    expect(tops(m)).toBe(0)
  })

  test("a lock 30 s old is a dead refresher's, so a look takes it over and refreshes", async () => {
    const m = machine({ idle: 80 })
    cache(m, 60, "30")
    held(m, 30)
    expect(await slotsTogether(m)).toEqual(["4"])
    expect(tops(m)).toBe(1)
    expect(existsSync(lock(m))).toBe(false)
  })

  test("a lock 20 s old, a slow refresher's, still holds", async () => {
    const m = machine({ idle: 80 })
    cache(m, 60, "30")
    held(m, 20)
    expect(await slotsTogether(m)).toEqual(["1"])
    expect(tops(m)).toBe(0)
  })

  test("a refresher whose lock was taken over leaves the new holder's lock in place", async () => {
    const m = machine({ topDelay: 2 })
    const p = start(m)
    while (tops(m) === 0) await Bun.sleep(20)
    utimesSync(lock(m), now() + 100, now() + 100)
    expect((await read(p)).slots).toBe("4")
    expect(existsSync(lock(m))).toBe(true)
  })

  test("a takeover beside a leftover run-slot.gauges.lock.<pid> folder still refreshes and leaves no lock", async () => {
    const m = machine({ idle: 80 })
    cache(m, 60, "30")
    held(m, 31)
    const p = start(m)
    mkdirSync(`${lock(m)}.${p.pid}`)
    expect((await read(p)).slots).toBe("4")
    expect(tops(m)).toBe(1)
    expect(existsSync(lock(m))).toBe(false)
    expect(existsSync(join(`${lock(m)}.${p.pid}`, "run-slot.gauges.lock"))).toBe(false)
  })

  // two looks that read a dead lock's old mtime together can each take it over, so both refresh; each writes the reading whole through a rename, so the last write wins, and every other look reads the stale reading or the new one, never a torn one
  test("eight looks at a dead lock together each read the stale or the new reading, and leave one well-formed reading and no lock", async () => {
    const m = machine({ idle: 80, topDelay: 1 })
    cache(m, 60, "30")
    held(m, 31)
    const looks = await Promise.all(Array.from({ length: 8 }, () => read(start(m))))
    // the looks that read neither reading, each with its stderr, so a failure on CI names what one printed
    expect(looks.filter((l) => l.slots !== "1" && l.slots !== "4")).toEqual([])
    const slots = looks.map((l) => l.slots)
    expect(slots).toContain("4")
    expect(tops(m)).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(m.ops, "run-slot.gauges"), "utf8")).toMatch(
      /^\d+ 80 0 120 3\.50 0 30\n$/,
    )
    expect(existsSync(lock(m))).toBe(false)
  })

  // a reading that lands while a look counts: stat runs on the lock only in gauges_lock, once its mkdir finds the lock held, so the look's first lanes check has read the stale reading when the fake stat writes a new one, as a refresher's rename would
  test("a look counts slots 2 to 4 on one reading, even when a new one lands between their checks", async () => {
    const m = machine({ idle: 80 })
    cache(m, 60, "30")
    held(m, 0)
    const landed = join(m.root, "landed")
    writeFileSync(
      join(m.root, "bin", "stat"),
      `#!/bin/bash\n"${Bun.which("stat")}" "$@"; rc=$?\ncase "$*" in *run-slot.gauges.lock*) [ -e "${landed}" ] || { : > "${landed}"; printf '%s 80 0 120 3.50 0\\n' "$(date +%s)" > "${join(m.ops, "run-slot.gauges")}"; } ;; esac\nexit $rc\n`,
    )
    chmodSync(join(m.root, "bin", "stat"), 0o755)
    expect(await slotsTogether(m)).toEqual(["1"])
    expect(existsSync(landed)).toBe(true)
  })
})
