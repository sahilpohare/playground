import { expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, machine } from "./run-slot-fake"

// a check waits on its run's exit or a file its run writes, so the timeout only catches a hang
setDefaultTimeout(60_000)

// small runs, so the lanes and their load units alone decide who runs
const SMALL = { RUN_SLOT_SIZE: "small" }
const CHILD = join(import.meta.dir, "run-slot-give-back-child.ts")

// #2644: v0.0.151's playground update held its lane about 30 minutes at 0% CPU while the Dashboard roll waited on load, and 17 runs queued behind it
test("a run that gives its lane back (RUN_SLOT_HELD) lets the next run take that lane while it still runs", async () => {
  const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
  m.hold("run-slot-2", 2, "medium")
  const a = m.start("worker-a", SMALL, SCRIPT, [process.execPath, CHILD])
  const ended = a.p.exited.then(() => true)
  while (
    !existsSync(`${a.marker}.gave`) &&
    !(await Promise.race([ended, Bun.sleep(50).then(() => false)]))
  );
  expect(existsSync(`${a.marker}.gave`), a.stderr()).toBe(true)
  expect(readFileSync(`${a.marker}.gave`, "utf8")).toBe("true")
  expect(existsSync(join(m.ops, "run-slot"))).toBe(false)
  expect(await m.runs("worker-b", SMALL)).toBe(true)
  expect(existsSync(a.marker)).toBe(false)
  writeFileSync(`${a.marker}.go`, "")
  expect(await a.ran()).toBe(true)
  expect(existsSync(join(m.ops, "run-slot"))).toBe(false)
})
