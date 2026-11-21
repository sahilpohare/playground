import { describe, expect, test } from "bun:test"

import type { ModelServer } from "../../../../../packages/scripts/src/local-model/state"
import {
  gateOf,
  LOCAL_SESSION_CAP,
  SPEED_FRESH_MINUTES,
} from "../../../../../packages/scripts/src/spawn/local-cap"

// One machine's servers as the model switch writes them (local-model/state.ts), by model folder.
const K: ModelServer = {
  busyAt: "2026-11-17T06:00:00Z",
  container: "local-vllm-k",
  maxSessions: 4,
  port: 8000,
  share: 0.7,
  startedAt: "2026-11-17T06:00:00Z",
}
const FLOORS = { maxFirstTokenSeconds: 10, minTps: 15 }
const NOW = new Date("2026-11-17T10:00:00Z")
const speed = (at: string) => ({ at, decodeTps: 18.7, ttftMean: 2.1, waiting: 0 })

describe("gateOf, what the local gate reads for this machine's model server", () => {
  test("reads maxSessions of the server on the port, with the floors beside it", () => {
    expect(gateOf({ k: K }, 8000, FLOORS, NOW)).toEqual({
      cap: 4,
      from: "models/state.json",
      maxFirstTokenSeconds: 10,
      minTps: 15,
      speed: null,
    })
  })

  test("picks the server by its port among two side by side", () => {
    const m = { ...K, maxSessions: 1, port: 8001 }
    expect(gateOf({ k: K, m }, 8001, FLOORS, NOW).cap).toBe(1)
  })

  test.each([
    ["no servers", {}],
    ["no server on the port", { k: { ...K, port: 9000 } }],
    ["a cap that is not a whole number over 0", { k: { ...K, maxSessions: 0 } }],
    ["a cap held as text", { k: { ...K, maxSessions: "4" as unknown as number } }],
  ])("%s falls back to K's limit of 6", (_, servers) => {
    expect(gateOf(servers, 8000, FLOORS, NOW)).toMatchObject({
      cap: LOCAL_SESSION_CAP,
      from: "K's limit, as models/state.json sizes no server on 8000 here",
    })
    expect(LOCAL_SESSION_CAP).toBe(6)
  })

  test("PG-2559 a speed the keep beat wrote in the last 15 minutes is read", () => {
    const fresh = speed("2026-11-17T09:50:00Z")
    expect(gateOf({ k: { ...K, speed: fresh } }, 8000, FLOORS, NOW).speed).toEqual(fresh)
  })

  test.each([
    ["older than 15 minutes, as a stopped beat leaves it", "2026-11-17T09:45:00Z"],
    ["with no time it reads", "never"],
  ])("PG-2559 a speed %s counts as a window with no samples", (_, at) => {
    expect(SPEED_FRESH_MINUTES).toBe(15)
    expect(gateOf({ k: { ...K, speed: speed(at) } }, 8000, FLOORS, NOW).speed).toBeNull()
  })
})
