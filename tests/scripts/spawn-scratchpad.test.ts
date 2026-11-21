import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { statSync } from "node:fs"

import { lw, root, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// A session writes its notes and logs to its own scratchpad from its first step, so spawn.sh makes the folder, owner-only, before the pane opens.
describe("spawn.sh makes the session's scratchpad folder at mode 700", () => {
  const mode = (home: string, name: string) => statSync(lw(home, "scratchpad", name)).mode & 0o777

  test("a worker's start makes it", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(mode(r.home, "worker-brave-otter")).toBe(0o700)
  })

  test("a resume makes it", async () => {
    const SESSION = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
    const r = await spawn(["resume", "worker-x", root, SESSION], [], {}, undefined, {
      backend: "claude",
      name: "worker-x",
    })
    expect(r.code).toBe(0)
    expect(mode(r.home, "worker-x")).toBe(0o700)
  })
})
