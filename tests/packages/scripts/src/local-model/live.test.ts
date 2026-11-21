import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { peerEnvPath } from "../../../../../packages/scripts/src/local-model/live"

describe("the .env that names the peers (PG-2543)", () => {
  test("is the Dashboard's checkout's, where PLAYGROUND_PEERS lives, though the running checkout has none", () => {
    const main = mkdtempSync(join(tmpdir(), "main-"))
    const dashboard = mkdtempSync(join(tmpdir(), "dashboard-"))
    expect(peerEnvPath(main, () => dashboard)).toBe(join(dashboard, ".env"))
  })

  test("falls back to the running checkout's own when no Dashboard checkout is cut, or live.branch does not read", () => {
    const main = mkdtempSync(join(tmpdir(), "main-"))
    expect(peerEnvPath(main, () => null)).toBe(join(main, ".env"))
    expect(
      peerEnvPath(main, () => {
        throw new Error("policy.json does not parse")
      }),
    ).toBe(join(main, ".env"))
  })
})
