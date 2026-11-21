import { afterEach, describe, expect, test } from "bun:test"
import { renameSync } from "node:fs"
import { join } from "node:path"

import {
  procRoot,
  procUsedBytes,
  readIdle,
  readSysctl,
  readBootTime,
  readUpSince,
  type SysctlName,
  sysctlOf,
} from "../../../../../packages/scripts/src/ops-machine/readings"
import { procDir } from "../../../../scripts/fixtures/proc"

// Linux has no such sysctl name: procps's sysctl says so and exits 255.
const LINUX_SYSCTL = async (argv: string[]) => ({
  code: 255,
  out: `sysctl: cannot stat /proc/sys/${argv.at(-1)!.replaceAll(".", "/")}: No such file or directory\n`,
})

const saved = process.env.PLAYGROUND_PROC
afterEach(() => {
  process.env.PLAYGROUND_PROC = saved
})
const onLinux = (dir: string) => {
  process.env.PLAYGROUND_PROC = dir
}

describe("each sysctl name reads its /proc text where sysctl does not answer", () => {
  test("the load averages come from /proc/loadavg in sysctl's shape", async () => {
    onLinux(procDir({ load1: 12.5, load5: 16.25 }))
    expect(await readSysctl(LINUX_SYSCTL, "vm.loadavg")).toBe("{ 12.50 16.25 3.00 }")
  })

  test("the core count is /proc/stat's cpu lines", async () => {
    onLinux(procDir({ cores: 20 }))
    expect(await readSysctl(LINUX_SYSCTL, "hw.ncpu")).toBe("20")
  })

  test("the free share is MemAvailable's whole share of MemTotal in /proc/meminfo", async () => {
    onLinux(procDir({ free: 37 }))
    expect(await readSysctl(LINUX_SYSCTL, "kern.memorystatus_level")).toBe("37")
  })

  test.each([
    [0, 0, "1"],
    [9.99, 0, "1"],
    [10, 0, "2"],
    [42.5, 9.99, "2"],
    [42.5, 10, "4"],
  ])(
    "PSI's some avg10 %d% and full avg10 %d% read as pressure level %s",
    async (some, full, level) => {
      onLinux(procDir({ full, some }))
      expect(await readSysctl(LINUX_SYSCTL, "kern.memorystatus_vm_pressure_level")).toBe(level)
    },
  )

  test("the swap in use is SwapTotal less SwapFree, in vm.swapusage's shape", async () => {
    onLinux(procDir({ swapUsedMB: 512 }))
    expect(await readSysctl(LINUX_SYSCTL, "vm.swapusage")).toBe(
      "total = 16384.00M  used = 512.00M  free = 15872.00M",
    )
  })

  test("the memory in use is MemTotal less MemAvailable, as procps's free counts it, in bytes", () => {
    onLinux(procDir({ free: 25 }))
    expect(procUsedBytes()).toBe(96 * 1024 ** 3)
  })
})

describe("a reading that cannot be taken is unread, never 0", () => {
  test.each([
    ["vm.loadavg", "loadavg"],
    ["hw.ncpu", "stat"],
    ["kern.memorystatus_level", "meminfo"],
    ["kern.memorystatus_vm_pressure_level", "pressure/memory"],
    ["vm.swapusage", "meminfo"],
  ])("%s with no sysctl answer and no /proc/%s", async (name, file) => {
    onLinux(procDir({}, [file]))
    expect(await readSysctl(LINUX_SYSCTL, name as SysctlName)).toBeNull()
  })

  test.each([
    ["an empty answer", { code: 0, out: "" }],
    ["a non-zero exit", { code: 1, out: "{ 1.00 2.00 3.00 }\n" }],
    ["an answer that is not a number", { code: 0, out: "{ x y z }\n" }],
  ])("%s from sysctl, with no /proc text, is unread", (_, answer) => {
    onLinux(procDir({}, ["loadavg"]))
    expect(sysctlOf("vm.loadavg", answer)).toBeNull()
  })

  test("a PSI file without its full line is unread, as an old kernel's cpu file prints", async () => {
    const dir = procDir()
    await Bun.write(
      join(dir, "pressure", "memory"),
      "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    )
    onLinux(dir)
    expect(await readSysctl(LINUX_SYSCTL, "kern.memorystatus_vm_pressure_level")).toBeNull()
  })

  test("macOS's answer stands as it reads, and /proc is never read", async () => {
    onLinux(procDir({ load1: 30, load5: 30 }))
    const mac = async () => ({ code: 0, out: "{ 1.00 2.00 3.00 }\n" })
    expect(await readSysctl(mac, "vm.loadavg")).toBe("{ 1.00 2.00 3.00 }")
  })

  test("the memory in use with no /proc/meminfo", () => {
    onLinux(procDir({}, ["meminfo"]))
    expect(procUsedBytes()).toBeNull()
  })
})

describe("the machine's latest boot or wake", () => {
  // sysctl's line for a kern time, as measured on macOS: `{ sec = <s>, usec = <us> } <date>`, sec 0 for a wake the machine has not had.
  const kern = (sec: number) => `{ sec = ${sec}, usec = 147343 } Sat Nov 14 05:25:54 2026\n`

  test("is /proc/stat's btime where sysctl has no kern.boottime, since Linux keeps no wake time", async () => {
    onLinux(procDir({ boot: 1_763_000_000 }))
    expect(await readUpSince(LINUX_SYSCTL)).toBe(1_763_000_000_000)
  })

  test("is 0 with no sysctl answer and no /proc/stat", async () => {
    onLinux(procDir({}, ["stat"]))
    expect(await readUpSince(LINUX_SYSCTL)).toBe(0)
  })

  test("is the later of macOS's boot and wake, and /proc is never read", async () => {
    onLinux(procDir({ boot: 1_799_999_999 }))
    const mac = async () => ({ code: 0, out: kern(1_763_000_000) + kern(1_763_050_000) })
    expect(await readUpSince(mac)).toBe(1_763_050_000_000)
  })

  test("the boot alone asks macOS for kern.boottime, never a wake, and is btime on Linux", async () => {
    onLinux(procDir({ boot: 1_763_000_000 }))
    const asked: string[][] = []
    const mac = async (argv: string[]) => {
      asked.push(argv)
      return { code: 0, out: kern(1_763_010_000) }
    }
    expect(await readBootTime(mac)).toBe(1_763_010_000_000)
    expect(asked).toEqual([["sysctl", "-n", "kern.boottime"]])
    expect(await readBootTime(LINUX_SYSCTL)).toBe(1_763_000_000_000)
  })
})

describe("the CPU's idle share", () => {
  const LINUX_TOP = async () => ({ code: 1, out: "top: unknown option 'l'\n" })

  test("comes from two /proc/stat reads a wait apart: idle and iowait over every busy and idle field", async () => {
    const dir = procDir({ idle: 37.5 }, [], [["stat"]])
    onLinux(dir)
    const wait = async () => renameSync(join(dir, "later", "1", "stat"), join(dir, "stat"))
    expect(await readIdle(LINUX_TOP, wait)).toBe(37.5)
  })

  test("is unread when /proc/stat does not move between the reads", async () => {
    onLinux(procDir())
    expect(await readIdle(LINUX_TOP, async () => {})).toBeNull()
  })

  test("is unread with no /proc/stat", async () => {
    onLinux(procDir({}, ["stat"]))
    expect(await readIdle(LINUX_TOP, async () => {})).toBeNull()
  })

  test("is top's second sample on macOS", async () => {
    const top = async () => ({
      code: 0,
      out: "CPU usage: 10.0% user, 5.0% sys, 85.0% idle\nCPU usage: 30.5% user, 9.0% sys, 60.5% idle\n",
    })
    expect(await readIdle(top, async () => {})).toBe(60.5)
  })
})

describe("PLAYGROUND_PROC", () => {
  test("is read under the test sandbox alone, so a session cannot feed the gates a reading", () => {
    expect(procRoot({ PLAYGROUND_PROC: "/x", TEST_SANDBOX_HOME: "/s" })).toBe("/x")
    expect(procRoot({ PLAYGROUND_PROC: "/x" })).toBe("/proc")
    expect(procRoot({ PLAYGROUND_PROC: "/x", TEST_SANDBOX_HOME: "" })).toBe("/proc")
  })
})
