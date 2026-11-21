import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { capacityLog, placing, root, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// Claude Code's sandbox refuses the sysctl command's name lookup, every kern.memorystatus_* reading and the setuid ps; the fakes refuse them the same way.
const SANDBOXED = { FAKE_SYSCTL_SANDBOXED: "1" }
const worker = ["worker", "worker-brave-otter", "b.md"]
const glm = [...worker, "--backend", "glm"]

describe("spawn.sh reads the machine where Claude Code's sandbox refuses sysctl", () => {
  test("a start reads the load from uptime and the memory from the swap-ins", async () => {
    const r = await spawn(worker, [], SANDBOXED)
    expect(r.code, r.err).toBe(0)
    const [row] = capacityLog(r)
    expect(row.verdict).toBe("pass")
    expect(row.readings).toMatchObject({
      load5: 2,
      memory: "pressure level and free share refused by the sandbox",
      swapins: 0,
    })
  })

  test("the load from uptime holds a start over the line", async () => {
    const r = await spawn(worker, [], { ...SANDBOXED, FAKE_LOAD5: "40.00" })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("the load gate holds it: max(load1, load5) is 40.00")
  })

  test("swap-ins at the line hold a start", async () => {
    const r = await spawn(worker, [], { ...SANDBOXED, FAKE_SWAPINS: "150" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: the sandbox refuses the pressure level, and swap-ins are 150/s (vm_stat), 100/s is the line",
    )
  })

  test("swap-ins it cannot read hold a start", async () => {
    const r = await spawn(worker, [], { ...SANDBOXED, FAKE_VMSTAT_BROKEN: "1" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: the sandbox refuses the pressure level, and it cannot read the swap-ins (vm_stat -c 4 1)",
    )
  })

  test("a GLM start reads the load from uptime and lets the swap-ins decide", async () => {
    const r = await spawn(glm, [], SANDBOXED)
    expect(r.code, r.err).toBe(0)
    expect(capacityLog(r)[0].readings).toMatchObject({
      load5: 2,
      memory: "pressure level refused by the sandbox, so the swap-ins alone decide",
      swapins: 0,
    })
  })

  test("a GLM start at swap-ins 150/s is still refused", async () => {
    const r = await spawn(glm, [], { ...SANDBOXED, FAKE_SWAPINS: "150" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("swap-ins are 150/s (vm_stat), and a GLM session starts under 100/s")
  })
})

// The kernel's process table is read through macOS's sysctl kern.proc, so these run on a Mac alone.
describe.skipIf(process.platform !== "darwin")(
  "spawn.sh reads the kernel's process table where the sandbox refuses ps",
  () => {
    test("a start lists the live sessions through the kernel's table", async () => {
      const r = await spawn(worker, [], { FAKE_PS_BROKEN: "1" })
      expect(r.code, r.err).toBe(0)
    })

    test("a live session that holds the name is seen through the kernel's table, and refused", async () => {
      const SESSION = "0b6e3c1a-4d2f-4e8a-9c7b-1f2e3d4c5b6a"
      const live = Bun.spawn(["sleep", "60"])
      try {
        const lstart = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(live.pid)], {
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        })
          .stdout.toString()
          .trim()
          .split(/\s+/)
          .join(" ")
        const r = await spawn(
          worker,
          [
            {
              pid: live.pid,
              raw: JSON.stringify({
                cwd: root,
                name: "worker-brave-otter",
                pid: live.pid,
                procStart: lstart,
                sessionId: SESSION,
              }),
            },
          ],
          { FAKE_PS_BROKEN: "1" },
        )
        expect(r.code).toBe(3)
        expect(r.err).toContain(
          `a live session already holds the name worker-brave-otter (pid ${live.pid})`,
        )
        expect(placing(r)).toEqual([])
      } finally {
        live.kill()
      }
    })
  },
)
