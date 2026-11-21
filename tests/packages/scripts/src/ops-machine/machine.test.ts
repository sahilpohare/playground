import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  readMachine,
  roleOf,
  sampleMachine,
  sampleOf,
} from "../../../../../packages/scripts/src/ops-machine/machine"
import { procDir } from "../../../../scripts/fixtures/proc"

const scratch = mkdtempSync(join(tmpdir(), "ops-machine-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const SYSCTL: Record<string, string> = {
  "hw.ncpu": "12",
  "kern.memorystatus_level": "64",
  "kern.memorystatus_vm_pressure_level": "2",
  "vm.loadavg": "{ 3.10 4.20 5.30 }",
  "vm.swapusage": "total = 2048.00M  used = 512.25M  free = 1535.75M  (encrypted)",
}

test("a session's role is its seat's: a manager, a worker, checker, runner or probe, else other", () => {
  expect(roleOf("b7k2mq-planner")).toBe("manager")
  expect(roleOf("b7k2mq-reviewer")).toBe("reviewer")
  expect(roleOf("b7k2mq-runner")).toBe("runner")
  expect(roleOf("b7k2mq-researcher")).toBe("other")
  expect(roleOf("my-own-session")).toBe("other")
})

test("a sample reads load, memory and swap from sysctl, and counts sessions by role and by each Claude Code backend, a --model local one as local", () => {
  const sample = sampleOf({
    at: new Date("2026-01-02T03:04:05.678Z"),
    sessions: [
      { args: "claude --model glm-4.6", name: "b7k2mq-worker" },
      { args: "claude", name: "c8m3nr-worker" },
      { args: "claude", name: "d9n4ps-builder" },
      { args: "claude --model local --effort low", name: "h2p5qt-worker" },
      { args: "claude --model claude-opus-5-5 --effort high", name: "f3q6rv-worker" },
    ],
    sysctl: SYSCTL,
    waiters: 2,
  })
  expect(sample).toEqual({
    at: "2026-01-02T03:04:05Z",
    backends: { claude: 3, glm: 1, local: 1 },
    cores: 12,
    freePct: 64,
    load1: 3.1,
    load15: 5.3,
    load5: 4.2,
    pressure: 2,
    roles: { manager: 1, worker: 4 },
    runSlotWaiters: 2,
    sessions: 5,
    swapUsedMB: 512.25,
  })
})

test("one read appends its line to the ops folder's machine.jsonl, and a failed sysctl writes nothing", async () => {
  const ops = join(scratch, "ops")
  mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
  writeFileSync(join(ops, "run-slot.waiters", "a"), "")
  const run = async (argv: string[]) =>
    argv[0] === "sysctl"
      ? { code: 0, out: `${SYSCTL[argv[2]!]}\n` }
      : { code: 0, out: "  41 claude --model glm-4.6\n" }
  await sampleMachine(run, ops, [{ name: "b7k2mq-worker", pid: 41 }], new Date(0))
  const lines = readFileSync(join(ops, "machine.jsonl"), "utf8").trim().split("\n")
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toMatchObject({
    backends: { claude: 0, glm: 1, local: 0 },
    runSlotWaiters: 1,
    sessions: 1,
  })
  const failing = async () => ({ code: 1, out: "" })
  await expect(sampleMachine(failing, ops, [])).rejects.toThrow("sysctl hw.ncpu exited 1")
  expect(readFileSync(join(ops, "machine.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(await readMachine(run, join(scratch, "unwritten"), [])).toMatchObject({ sessions: 0 })
  expect(existsSync(join(scratch, "unwritten"))).toBe(false)
})

// Linux has none of the sysctl names, so each comes from its /proc text, and one neither gives writes no line rather than a 0 (#2201).
test("on Linux a read takes /proc's text for every sysctl name, and a missing file writes nothing", async () => {
  const saved = process.env.PLAYGROUND_PROC
  try {
    const linux = async (argv: string[]) =>
      argv[0] === "sysctl"
        ? { code: 255, out: `sysctl: cannot stat /proc/sys/${argv[2]!.replaceAll(".", "/")}\n` }
        : { code: 0, out: "" }
    process.env.PLAYGROUND_PROC = procDir({
      cores: 20,
      free: 37,
      load1: 6,
      load5: 7.5,
      some: 12,
      swapUsedMB: 512,
    })
    expect(await readMachine(linux, join(scratch, "linux"), [], new Date(0))).toMatchObject({
      cores: 20,
      freePct: 37,
      load1: 6,
      load15: 3,
      load5: 7.5,
      pressure: 2,
      swapUsedMB: 512,
    })
    process.env.PLAYGROUND_PROC = procDir({}, ["pressure/memory"])
    const ops = join(scratch, "linux-ops")
    await expect(sampleMachine(linux, ops, [])).rejects.toThrow(
      "sysctl kern.memorystatus_vm_pressure_level exited 255",
    )
    expect(existsSync(join(ops, "machine.jsonl"))).toBe(false)
  } finally {
    process.env.PLAYGROUND_PROC = saved
  }
})
