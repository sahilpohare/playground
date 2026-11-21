import { hostname } from "node:os"
import { join } from "node:path"

import { writeAtomic } from "../write-atomic"
import type { Snapshot, Speed } from "./speed"

// The loopback ports a model server takes on its machine, the first free one first; on the peer, ops-model-tunnel forwards each to this machine's loopback at 10000 more.
export const PORTS = [8000, 8001] as const

// One server playground model use started: the container it started it under, the only name it ever stops; its port on its machine; the memory share and the most sessions it was sized for; when it started, and when it last had a request, which the keep beat reads; the beat's last /metrics snapshot and the speed since the one before, which the local gate reads.
export type ModelServer = {
  busyAt: string
  container: string
  maxSessions: number
  metrics?: Snapshot
  port: number
  share: number
  speed?: Speed
  startedAt: string
}

// One machine's part: each server left running there, by its model's folder, the hold while a swap runs there, the keep beat's last refusal, said once, and each entry it skips, each named once.
export type MachineState = {
  // while set, nothing starts on that machine but `for`
  hold?: { for: string; since: string }
  refused?: string
  servers?: Record<string, ModelServer>
  // each entry the keep beat skips, with the line ops was told, so each is told once
  skipped?: Record<string, string>
}

// What playground model use did, kept in this machine's data folder, by machine: this one by its short hostname, a peer by its PLAYGROUND_PEERS name. The local-worker gate and the Dashboard's chat read it.
export type ModelState = { machines?: Record<string, MachineState> }

export const statePath = (data: string): string => join(data, "models", "state.json")

// This machine's name in the state: its short hostname, as `hostname -s` prints it.
export const thisMachine = (): string => hostname().split(".")[0]!

// The state as kept, {} when there is none; a file that does not read throws, so no reader takes a broken file for an empty one.
export const readModelState = async (data: string): Promise<ModelState> => {
  const file = Bun.file(statePath(data))
  if (!(await file.exists())) return {}
  const read: unknown = await file.json()
  if (!read || typeof read !== "object" || Array.isArray(read))
    throw new Error(`${statePath(data)} is not a JSON object`)
  return read as ModelState
}

export const machineState = async (data: string, machine: string): Promise<MachineState> =>
  (await readModelState(data)).machines?.[machine] ?? {}

export const writeMachineState = async (
  data: string,
  machine: string,
  part: MachineState,
): Promise<void> => {
  const state = await readModelState(data)
  const machines = { ...state.machines, [machine]: part }
  await writeAtomic(statePath(data), `${JSON.stringify({ ...state, machines }, null, 2)}\n`)
}

// The hold a swap on machine sets: while it reads non-null, start nothing there but hold.for.
export const modelHold = async (
  data: string,
  machine: string,
): Promise<MachineState["hold"] | null> => (await machineState(data, machine)).hold ?? null

// The servers playground model use left running on machine, by model folder: each one's port, share and max sessions, the cap a local worker keeps under.
export const modelServers = async (
  data: string,
  machine: string,
): Promise<Record<string, ModelServer>> => (await machineState(data, machine)).servers ?? {}
