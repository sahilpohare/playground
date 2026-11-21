import { afterEach, describe, expect, test } from "bun:test"

import { memoryReads } from "../../../../../../api/hono/src/lib/system/memory"
import { procDir } from "../../../../../scripts/fixtures/proc"

const MIB = 1024 * 1024
const TOTAL = 128 * 1024 * MIB

const saved = process.env.PLAYGROUND_PROC
afterEach(() => {
  process.env.PLAYGROUND_PROC = saved
})

describe("on Linux the memory readings come from /proc alone", () => {
  test("free share and used bytes from /proc/meminfo, pressure from PSI, swap from SwapTotal and SwapFree", async () => {
    process.env.PLAYGROUND_PROC = procDir({ free: 25, some: 12, swapUsedMB: 512 })
    const problems: string[] = []
    const memory = memoryReads(true, problems)
    expect(memory.sysctl.what).toBe("/proc/meminfo and /proc/pressure/memory")
    expect(memory.usedBytes.what).toBe("/proc/meminfo")
    expect(await memory.sysctl.read).toEqual({
      freePercent: 25,
      pressure: "warn",
      swap: { totalBytes: 16_384 * MIB, usedBytes: 512 * MIB },
    })
    expect(await memory.usedBytes.read).toBe(TOTAL * 0.75)
    expect(problems).toEqual([])
  })

  test("a host with no PSI still reads its free share and swap, and names the file it could not read", async () => {
    process.env.PLAYGROUND_PROC = procDir({ free: 60 }, ["pressure/memory"])
    const problems: string[] = []
    expect(await memoryReads(true, problems).sysctl.read).toEqual({
      freePercent: 60,
      pressure: null,
      swap: { totalBytes: 16_384 * MIB, usedBytes: 0 },
    })
    expect(problems).toEqual([
      "/proc/pressure/memory does not read, so the memory pressure stays empty",
    ])
  })

  test("with no /proc text every part stays empty, never 0, and each file is named", async () => {
    process.env.PLAYGROUND_PROC = procDir({}, ["meminfo", "pressure/memory"])
    const problems: string[] = []
    const memory = memoryReads(true, problems)
    expect(await memory.sysctl.read).toEqual({ freePercent: null, pressure: null, swap: null })
    await expect(memory.usedBytes.read).rejects.toThrow("MemTotal or MemAvailable does not read")
    expect(problems).toEqual([
      "/proc/meminfo does not read, so the free share and swap stay empty",
      "/proc/pressure/memory does not read, so the memory pressure stays empty",
    ])
  })
})

describe("on macOS they come from sysctl and vm_stat, as before", () => {
  test("the fixture's answers read as Activity Monitor adds them, whatever /proc holds", async () => {
    process.env.PLAYGROUND_PROC = procDir({ free: 25, some: 12, swapUsedMB: 512 })
    const problems: string[] = []
    const memory = memoryReads(false, problems)
    expect([memory.sysctl.what, memory.usedBytes.what]).toEqual(["sysctl", "vm_stat"])
    expect(await memory.sysctl.read).toEqual({
      freePercent: 41,
      pressure: "normal",
      swap: { totalBytes: 2048 * MIB, usedBytes: 640 * MIB },
    })
    expect(await memory.usedBytes.read).toBe((880_000 - 24_000 + 190_000 + 140_000) * 16_384)
    expect(problems).toEqual([])
  })
})
