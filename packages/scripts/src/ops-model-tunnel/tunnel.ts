import { join } from "node:path"

import type { RecordEntry } from "../local-model/model"
import { peerOf } from "../local-model/peer"
import { PORTS } from "../local-model/state"
import { beat, CYCLE_SECONDS } from "../ops-tick/tick"

// ops-model-tunnel: holds one ssh from this machine's loopback to the peer's model servers, each port in PORTS forwarded to 10000 more here, bound to 127.0.0.1 at both ends, so this machine's sessions and the Dashboard's chat reach the peer's model and nothing else on the network does. Nothing of it runs on the peer.
export const JOB = "ops-model-tunnel"

// [port on this machine, port on the peer]
export const FORWARDS = PORTS.map((port) => [port + 10_000, port] as const)

// Pure: ssh's argv: no remote command, the key alone and no prompt, every forward on loopback at both ends; a forward that cannot bind ends ssh, so the job says why. -F none keeps the user's own ssh config out of it.
export const tunnelArgv = (key: string, target: string): string[] => [
  "-N",
  "-F",
  "none",
  "-i",
  key,
  ...["BatchMode=yes", "ConnectTimeout=10", "ExitOnForwardFailure=yes", "IdentitiesOnly=yes"]
    .concat(["ServerAliveCountMax=3", "ServerAliveInterval=15"])
    .flatMap((option) => ["-o", option]),
  ...FORWARDS.flatMap(([here, there]) => ["-L", `127.0.0.1:${here}:127.0.0.1:${there}`]),
  target,
]

export type Child = { exited: Promise<number>; kill: () => void; stderr: Promise<string> }

export type KeepOptions = {
  data: string
  envText: () => Promise<string>
  // runs tick every ms until the returned stop is called
  every: (ms: number, tick: () => unknown) => () => void
  home: string
  // localModels.machine, read again on each start
  machine: () => string
  record: (entries: RecordEntry[]) => Promise<void>
  signal: AbortSignal
  spawn: (argv: string[]) => Child
  ssh: string | null
  wait: (ms: number) => Promise<void>
}

const MIN_WAIT_MS = 2_000
const MAX_WAIT_MS = 60_000

// The job's loop until signal: starts ssh, beats up each cycle while it holds, and on a drop beats down with ssh's last line and starts it again after a wait that doubles from 2 s to 60 s, from 2 s again once a link held a minute. Its heartbeat file goes in the machine record once; its ssh is ended by its own handle on the signal.
export const keep = async ({
  data,
  envText,
  every,
  home,
  machine,
  record,
  signal,
  spawn,
  ssh,
  wait,
}: KeepOptions): Promise<void> => {
  const path = join(data, "ops", `${JOB}.json`)
  const startedAt = new Date()
  const say = (state: string) => beat(path, startedAt, new Date(), state, JOB)
  await say("starting")
  await record([
    {
      added: startedAt.toISOString(),
      by: JOB,
      kind: "file",
      path,
      undo: `remove ${path}`,
      why: "the model tunnel job's heartbeat",
    },
  ]).catch((error: unknown) => console.error(`${JOB}: not recorded: ${String(error)}`))
  let next = MIN_WAIT_MS
  while (!signal.aborted) {
    const peer = peerOf(await envText(), home, machine())
    const missing = "why" in peer ? peer.why : !ssh ? "no ssh on PATH" : null
    if (missing || "why" in peer) {
      await say(`down: ${missing}`)
      await wait(MAX_WAIT_MS)
      continue
    }
    const child = spawn([ssh!, ...tunnelArgv(peer.key, peer.target)])
    const stop = () => child.kill()
    signal.addEventListener("abort", stop, { once: true })
    const upAt = Date.now()
    const up = `up: ${FORWARDS.map(([here, there]) => `127.0.0.1:${here} to ${peer.name}:${there}`).join(", ")}`
    await say(up)
    // the sweep reads a heartbeat older than its cycle as stale, so a link that holds beats up each cycle until ssh ends
    const stopBeats = every(CYCLE_SECONDS * 1000, () => say(up))
    const code = await child.exited
    stopBeats()
    signal.removeEventListener("abort", stop)
    if (signal.aborted) break
    const last = (await child.stderr).trim().split("\n").at(-1)?.slice(0, 200)
    await say(`down: ssh to ${peer.name} ended ${code}${last ? `: ${last}` : ""}`)
    if (Date.now() - upAt >= MAX_WAIT_MS) next = MIN_WAIT_MS
    await wait(next)
    next = Math.min(next * 2, MAX_WAIT_MS)
  }
}
