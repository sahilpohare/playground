import { appendFile, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"

import { placedKindOf, ROSTER_ROLE_OF_KIND } from "@packages/config/kinds"
import { HARNESSES } from "@packages/settings"

import type { Run } from "../ops-tick/tick"
import { procSource, type SysctlName, sysctlOf } from "./readings"

// ops-machine: one line a minute of this machine's room to ops/machine.jsonl, for capacity reads and before-and-after comparisons. It reads sysctl (on Linux the /proc text that stands for each name, readings.ts), ps and Claude Code's session registry only, with no model call and no terminal call.

const ROLES = new Set(["probe", "reviewer", "runner", "tester", "worker"])

type ClaudeCodeBackend = Extract<
  (typeof HARNESSES)[number],
  { id: "claude-code" }
>["backends"][number]

// Claude Code's backends, as packages/settings' HARNESSES lists them, each counted in a sample.
const BACKENDS = HARNESSES.filter((h) => h.id === "claude-code").flatMap(
  (h) => h.backends,
) as ClaudeCodeBackend[]

// Pure: the backend a session's command line runs on: glm for a glm- model, local for the local model's served name (spawn.sh's --model local), else claude.
const backendOf = (args: string): ClaudeCodeBackend =>
  /--model[= ]'?glm-/.test(args)
    ? "glm"
    : /--model[= ]'?local(?=['\s]|$)/.test(args)
      ? "local"
      : "claude"

export type Sample = {
  at: string
  backends: Record<ClaudeCodeBackend, number>
  cores: number
  freePct: number
  load1: number
  load15: number
  load5: number
  pressure: number
  roles: Record<string, number>
  runSlotWaiters: number
  sessions: number
  swapUsedMB: number | null
}

// Pure: a session's role, manager for a manager's seat, its kind for a worker, checker, runner or probe, else other.
export const roleOf = (name: string): string => {
  const kind = placedKindOf(name, null)
  if (kind && ROSTER_ROLE_OF_KIND[kind] === "manager") return "manager"
  return kind && ROLES.has(kind) ? kind : "other"
}

// Pure: one sample from sysctl's answers, each live session's name and command line, and the run-slot waiters, each session counted under its backend (backendOf).
export const sampleOf = (input: {
  at: Date
  sessions: { args: string; name: string }[]
  sysctl: Record<string, string>
  waiters: number
}): Sample => {
  const { sysctl } = input
  const [load1 = 0, load5 = 0, load15 = 0] = (sysctl["vm.loadavg"] ?? "")
    .replace(/[{}]/g, "")
    .trim()
    .split(/\s+/)
    .map(Number)
  const swap = /used = ([\d.]+)M/.exec(sysctl["vm.swapusage"] ?? "")
  const roles: Record<string, number> = {}
  const backends = Object.fromEntries(BACKENDS.map((b) => [b, 0])) as Sample["backends"]
  for (const { args, name } of input.sessions) {
    const role = roleOf(name)
    roles[role] = (roles[role] ?? 0) + 1
    backends[backendOf(args)]++
  }
  return {
    at: input.at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    backends,
    cores: Number(sysctl["hw.ncpu"]),
    freePct: Number(sysctl["kern.memorystatus_level"]),
    load1,
    load15,
    load5,
    pressure: Number(sysctl["kern.memorystatus_vm_pressure_level"]),
    roles,
    runSlotWaiters: input.waiters,
    sessions: input.sessions.length,
    swapUsedMB: swap ? Number(swap[1]) : null,
  }
}

const SYSCTLS: SysctlName[] = [
  "hw.ncpu",
  "kern.memorystatus_level",
  "kern.memorystatus_vm_pressure_level",
  "vm.loadavg",
  "vm.swapusage",
]

// Reads the machine once, writing nothing.
export const readMachine = async (
  run: Run,
  ops: string,
  live: { name: string; pid?: number }[],
  at = new Date(),
): Promise<Sample> => {
  const sysctl: Record<string, string> = {}
  for (const name of SYSCTLS) {
    const answer = await run(["sysctl", "-n", name])
    const text = sysctlOf(name, answer)
    if (text === null)
      throw new Error(`sysctl ${name} exited ${answer.code}, and ${procSource(name)} does not read`)
    sysctl[name] = text
  }
  const args = new Map<number, string>()
  const pids = live.flatMap(({ pid }) => (pid === undefined ? [] : [pid]))
  if (pids.length) {
    const { out } = await run(["ps", "-o", "pid=,args=", "-p", pids.join(",")])
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match) args.set(Number(match[1]), match[2]!)
    }
  }
  const waiters = (await readdir(join(ops, "run-slot.waiters")).catch(() => [])).length
  return sampleOf({
    at,
    sessions: live.map(({ name, pid }) => ({ args: (pid && args.get(pid)) || "", name })),
    sysctl,
    waiters,
  })
}

// Reads the machine once and appends its line to <ops>/machine.jsonl.
export const sampleMachine = async (...args: Parameters<typeof readMachine>): Promise<Sample> => {
  const sample = await readMachine(...args)
  await mkdir(args[1], { recursive: true })
  await appendFile(join(args[1], "machine.jsonl"), `${JSON.stringify(sample)}\n`)
  return sample
}
