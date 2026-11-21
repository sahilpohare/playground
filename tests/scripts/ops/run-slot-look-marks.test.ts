import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { SCRIPT, WAITING, machine, stop } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s
setDefaultTimeout(60_000)

// issue 1414, 7 Nov: a look's idle poll compares the ops folder and the script against marks the look took, and a mark taken after a read loses a change between them, so the waiter never looks again
describe("a look's marks are taken before its reads", () => {
  // a waiter behind the head came to the head as the run before it ended, read the slot's folder with its holder line gone (two units, so it did not fit), then marked the folder gone, and sat waiting for run-slot-2 alone while run-slot stayed free
  test("a waiter that comes to the head as the last run frees its slot takes the slot", async () => {
    const m = machine({ idle: 30 })
    m.hold("run-slot", 1, "small")
    m.ticket(1, "worker-made", "s2 21 1 small")
    // the look's first python3 is the queue's order (ready_line), after its read of the holders: once armed it holds there until the test says go; it is on PATH before the waiter starts, since bash keeps the path of a command it has run
    const armed = join(m.root, "python3.armed")
    const started = join(m.root, "python3.started")
    const gate = join(m.root, "python3.gate")
    writeFileSync(
      join(m.bin, "python3"),
      `#!/bin/bash\nif [ -e ${armed} ]; then touch ${started}; until [ -e ${gate} ]; do sleep 0.05; done; fi\nexec ${Bun.which("python3")} "$@"\n`,
    )
    chmodSync(join(m.bin, "python3"), 0o755)
    const waiter = m.start("worker-r", { RUN_SLOT_SIZE: "small" })
    expect(await waiter.saw(WAITING)).toBe(true)
    writeFileSync(armed, "")
    // the run's end as free() writes it, its holder line first; its ticket went at its take, so this waiter comes to the head
    rmSync(join(m.ops, "run-slot.holder"))
    rmSync(join(m.ops, "run-slot.waiters", `1-${process.pid}-worker-made`))
    while (!existsSync(started)) await Bun.sleep(20)
    rmSync(join(m.ops, "run-slot"), { recursive: true })
    writeFileSync(gate, "")
    expect(await waiter.ran()).toBe(true)
  })

  // a copy put in place between a look's stamp read and its mark was older than the mark, so no poll found the script changed and no look read its stamp again
  test("a waiter whose script is replaced as its look reads the script's stamp runs the new copy", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    const armed = join(m.root, "stat.armed")
    const started = join(m.root, "stat.started")
    const gate = join(m.root, "stat.gate")
    // a stat of the copy that, once armed, answers at the test's go with what it read before, so the look's stamp read lands before the copy is replaced and the rest of its look after
    writeFileSync(
      join(m.bin, "stat"),
      `#!/bin/bash\nout=$(${Bun.which("stat")} "$@") || exit $?\nhit=\nfor a in "$@"; do case "$a" in "${copy}") hit=1 ;; esac; done\nif [ -n "$hit" ] && [ -e ${armed} ]; then touch ${started}; until [ -e ${gate} ]; do sleep 0.05; done; fi\nprintf '%s\\n' "$out"\n`,
    )
    chmodSync(join(m.bin, "stat"), 0o755)
    const waiter = m.start("worker-m", { RUN_SLOT_SIZE: "medium" }, copy)
    while (!m.tickets().some((t) => t.endsWith("-worker-m"))) await Bun.sleep(50)
    writeFileSync(armed, "")
    // a new entry in the ops folder sets the head looking, so a look reads the stamp armed whether or not its first look already had
    writeFileSync(join(m.ops, "run-slot.poke"), "")
    while (!existsSync(started)) await Bun.sleep(20)
    const out = join(m.root, "reexec")
    writeFileSync(`${copy}.new`, `#!/bin/bash\nprintf '%s\\n' "$@" > ${out}\n`)
    renameSync(`${copy}.new`, copy)
    // bash 3.2 tells two mtimes apart by the second alone, so the look's mark lands in a later second than the copy
    await Bun.sleep(1_100)
    writeFileSync(gate, "")
    expect(await waiter.p.exited).toBe(0)
    expect(readFileSync(out, "utf8")).toBe(`worker-m\n--\ntouch\n${waiter.marker}\n`)
  })

  // #1378: a waiter a SIGKILL ended leaves its look mark, since free() never runs; a look sweeps a mark whose pid has ended
  test("a look sweeps a look mark whose pid has ended", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    const stale = join(m.ops, ".run-slot-ref-99999999")
    writeFileSync(stale, "")
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const run = m.start("worker-big", { RUN_SLOT_SIZE: "big" })
    expect(await run.saw(WAITING)).toBe(true)
    expect(existsSync(stale)).toBe(false)
    await stop(run.p)
  })
})
