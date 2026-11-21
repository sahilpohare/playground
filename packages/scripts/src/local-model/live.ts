import { homedir } from "node:os"
import { join } from "node:path"

import { LOCAL_URL } from "@packages/config/console"
import { cloneOf } from "@packages/config/org"
import { dataDir } from "@packages/env/data-dir"
import { localModelSettings, readPolicyOrDefaults } from "@packages/settings"

import { addEntries, peerRecordArgv } from "../machine-record/record"
import { mainCheckout } from "../main-checkout"
import { REPO, run } from "../ops-job/job"
import { dashboardCheckout } from "../playground/probe"
import { FIXED, keepUp, type Machine, type ModelDeps, useModel } from "./model"
import { peerOf } from "./peer"
import { thisMachine } from "./state"

// The live seams of playground model use and the keep beat: the settings, this machine and the peer from the Dashboard's .env, commands through ops-job's run, and the machine record here and on the peer.

const settingsOf = (data: string) => {
  const read = readPolicyOrDefaults(data)
  if (read.refusal !== undefined) throw new Error(read.refusal)
  const get = <K extends Parameters<typeof localModelSettings.get>[1]>(key: K) =>
    localModelSettings.get(read.settings, key)
  return {
    boxLanes: get("localModels.boxLanes"),
    boxRunGiB: get("localModels.boxRunGiB"),
    hereModel: get("localModels.hereModel"),
    hereReserveGiB: get("localModels.hereReserveGiB"),
    idleMinutes: get("localModels.idleMinutes"),
    machine: get("localModels.machine"),
    models: get("localModels.models"),
    peerModel: get("localModels.peerModel"),
  }
}

// The .env that names the peers: the Dashboard's checkout's, where PLAYGROUND_PEERS lives, else this checkout's, as playground update's peer sync reads it; the dashboard argument is a test's seam.
export const peerEnvPath = (
  repo: string,
  dashboard: () => string | null = () => dashboardCheckout(repo),
): string => {
  let checkout: string | null = null
  try {
    checkout = dashboard()
  } catch {}
  return join(checkout ?? repo, ".env")
}

export const peerEnvText = (repo = REPO): Promise<string> =>
  Bun.file(peerEnvPath(repo))
    .text()
    .catch(() => "")

// The deps for one machine: this one when named by its own name, else the peer, named or the one localModels.machine picks.
const depsFor = async (
  data: string,
  where: { here: true } | { peer: string },
  say: (line: string) => void,
): Promise<ModelDeps | { why: string }> => {
  const settings = settingsOf(data)
  const home = process.env.HOME || homedir()
  let machine: Machine
  let key: string | undefined
  if ("here" in where) machine = { name: thisMachine() }
  else {
    const peer = peerOf(await peerEnvText(), home, where.peer || settings.machine)
    if ("why" in peer) return peer
    machine = { name: peer.name, target: peer.target }
    key = peer.key
  }
  const here = !machine.target
  return {
    config: {
      ...FIXED,
      idleMinutes: settings.idleMinutes,
      keep: here ? settings.hereModel : settings.peerModel,
      models: settings.models,
      reserveGiB: here
        ? settings.hereReserveGiB
        : FIXED.minFreeGiB + settings.boxLanes * settings.boxRunGiB,
    },
    data,
    key,
    machine,
    now: () => new Date(),
    // this machine's entries go straight in its record; the peer's through its own clone's record CLI, over one ssh
    record: async (entries, where) => {
      if (where === "here") return void (await addEntries(data, entries))
      const clone = cloneOf(mainCheckout(REPO), home)
      if (!clone || !machine.target)
        throw new Error(
          "the main checkout is not a plain path under home, so the peer's clone is not known",
        )
      const ran = await run(
        peerRecordArgv(key, machine.target, clone, "add"),
        60_000,
        JSON.stringify(entries),
      )
      if (ran.code !== 0) throw new Error(ran.out.trim().split("\n")[0] || `exit ${ran.code}`)
    },
    run: (argv, timeoutMs) => run(argv, timeoutMs),
    say,
    sleep: (ms) => Bun.sleep(ms),
  }
}

export const MODEL_USAGE = "usage: playground model use <name> [--machine <name>]"

// playground model use <name> [--machine <name>]: the machine named, else the one that keeps that model (localModels.hereModel here), else the peer.
export const runModel = async (words: string[]): Promise<number> => {
  const [verb, name, flag, named, ...extra] = words
  if (
    verb !== "use" ||
    !name ||
    (flag !== undefined && (flag !== "--machine" || !named)) ||
    extra.length
  ) {
    console.error(MODEL_USAGE)
    return 2
  }
  const machine = named ?? (name === settingsOf(dataDir()).hereModel ? thisMachine() : "")
  const deps = await depsFor(
    dataDir(),
    machine === thisMachine() ? { here: true } : { peer: machine },
    console.log,
  )
  if ("why" in deps) {
    console.error(`playground model use: ${deps.why}`)
    return 1
  }
  const result = await useModel(name, deps)
  ;(result.code === 0 ? console.log : console.error)(result.line)
  return result.code
}

// The keep beat's lines for ops: each machine whose kept model is set, this one and then the peer; a peer that does not read throws, so the beat's failure says why.
export const keepBeat = async (data: string): Promise<string[]> => {
  const settings = settingsOf(data)
  const lines: string[] = []
  const wheres = [
    ...(settings.hereModel ? [{ here: true as const }] : []),
    ...(settings.peerModel ? [{ peer: "" }] : []),
  ]
  for (const where of wheres) {
    const deps = await depsFor(data, where, () => {})
    if ("why" in deps) throw new Error(deps.why)
    const line = await keepUp(deps)
    if (line) lines.push(line)
  }
  return lines
}

// The local model's current /metrics, read at LOCAL_URL, where every local session reaches it with or without a model record, so a session's stuck read can skip a session the model still serves; null when the read fails or its status is not 200.
export const readModelMetrics = async (url = LOCAL_URL): Promise<string | null> => {
  try {
    const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5_000) })
    return res.status === 200 ? await res.text() : null
  } catch {
    return null
  }
}
