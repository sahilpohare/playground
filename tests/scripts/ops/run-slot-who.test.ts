import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, machine, runSlot } from "./run-slot-fake"

setDefaultTimeout(60_000)

// #2118: the guards read a run-slot call's command after its first --, so a session name that starts with - could be read as that separator and the guards would judge other words than run-slot runs
describe("a session name that starts with - is refused", () => {
  const run = async (who: string, separator = ["--"]) => {
    const m = machine()
    const marker = join(m.root, "ran")
    const p = runSlot(["bash", SCRIPT, who, ...separator, "touch", marker], {
      cwd: m.root,
      env: m.env(),
      stderr: "pipe",
      ops: m.ops,
    })
    return {
      code: await p.exited,
      err: await new Response(p.stderr).text(),
      ran: existsSync(marker),
    }
  }

  for (const who of ["--", "-x", "-worker-x", "--model-bound"])
    test(who, async () => {
      const r = await run(who)
      expect(r.code).toBe(2)
      expect(r.err).toBe("run-slot.sh: <who> is a session name, which never starts with -\n")
      expect(r.ran).toBe(false)
    })

  // the guards read this call as running nothing, which holds only while run-slot refuses it
  test("a name spelled -- with no separator after it runs nothing", async () => {
    const r = await run("--", [])
    expect(r.code).toBe(2)
    expect(r.ran).toBe(false)
  })

  test("a normal name still runs", async () => {
    const r = await run("worker-x")
    expect(r.code).toBe(0)
    expect(r.ran).toBe(true)
  })
})
