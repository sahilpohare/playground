import { localModelSettings, readPolicyOrDefaults } from "@packages/settings"

import { dataDir } from "../../../env/src/data-dir"
import type { Speed } from "../local-model/speed"
import { type ModelServer, modelServers, statePath, thisMachine } from "../local-model/state"

// K's measured limit, 6 sessions at once (the 2026-11-17 test's row K with MTP), for a machine the model switch has not sized.
export const LOCAL_SESSION_CAP = 6

// A speed reading older than this counts as a window with no samples, since the beat that wrote it has stopped.
export const SPEED_FRESH_MINUTES = 15

export type LocalGate = {
  cap: number
  from: string
  maxFirstTokenSeconds: number
  minTps: number
  speed: Speed | null
}

// Pure: what the local gate reads for the server on <port>: the most sessions it takes at once and where that figure came from, a state that names no such server falling back to K's limit, and its speed while fresh.
export const gateOf = (
  servers: Record<string, ModelServer>,
  port: number,
  floors: Pick<LocalGate, "maxFirstTokenSeconds" | "minTps">,
  now: Date,
): LocalGate => {
  const server = Object.values(servers).find((each) => each?.port === port)
  const cap = server?.maxSessions
  const sized = typeof cap === "number" && Number.isInteger(cap) && cap > 0
  const at = Date.parse(server?.speed?.at ?? "")
  const fresh = Number.isFinite(at) && now.getTime() - at < SPEED_FRESH_MINUTES * 60_000
  return {
    cap: sized ? cap : LOCAL_SESSION_CAP,
    from: sized
      ? "models/state.json"
      : `K's limit, as models/state.json sizes no server on ${port} here`,
    ...floors,
    speed: fresh ? server!.speed! : null,
  }
}

// spawn.sh's local gate: `bun local-cap.ts <port>` prints gateOf's reading as one JSON line, or exits 1 naming a state file or settings that do not read.
if (import.meta.main) {
  const port = Number(process.argv[2])
  if (!Number.isInteger(port)) {
    console.error("usage: local-cap.ts <port>")
    process.exit(2)
  }
  const data = dataDir()
  let servers: Record<string, ModelServer>
  try {
    servers = await modelServers(data, thisMachine())
  } catch {
    console.error(
      `it cannot read ${statePath(data)} (does not read), so it cannot tell how many sessions the local model serves`,
    )
    process.exit(1)
  }
  const read = readPolicyOrDefaults(data)
  if (read.refusal !== undefined) {
    console.error(read.refusal)
    process.exit(1)
  }
  const floors = {
    maxFirstTokenSeconds: localModelSettings.get(read.settings, "localModels.maxFirstTokenSeconds"),
    minTps: localModelSettings.get(read.settings, "localModels.minTps"),
  }
  console.log(JSON.stringify(gateOf(servers, port, floors, new Date())))
}
