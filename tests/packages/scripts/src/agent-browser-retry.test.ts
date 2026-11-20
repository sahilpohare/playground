import { describe, expect, test } from "bun:test"

import {
  NETWORK_CHANGED_RETRIES,
  NETWORK_CHANGED_WAIT_MS,
  networkChangedWait,
} from "../../../../packages/scripts/src/agent-browser-retry"

const CHANGED = "net::ERR_NETWORK_CHANGED at https://dashboard.localhost/"

// Docker's veth churn tripped Chromium's network-change notifier mid-open, failing a check that the same open passed a moment later.
describe("networkChangedWait", () => {
  test("waits and logs before each of two retries of an open that hit a network change, then gives up", () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    const args = ["open", "https://dashboard.localhost/"]
    expect(NETWORK_CHANGED_RETRIES).toBe(2)
    expect(networkChangedWait(args, CHANGED, 0, log)).toBe(NETWORK_CHANGED_WAIT_MS)
    expect(networkChangedWait(args, CHANGED, 1, log)).toBe(NETWORK_CHANGED_WAIT_MS)
    expect(networkChangedWait(args, CHANGED, 2, log)).toBeNull()
    expect(lines).toEqual([
      "agent-browser open https://dashboard.localhost/: net::ERR_NETWORK_CHANGED, retry 1 of 2 in 1000ms",
      "agent-browser open https://dashboard.localhost/: net::ERR_NETWORK_CHANGED, retry 2 of 2 in 1000ms",
    ])
  })

  test("throws at once on any other net error, and on a command other than open", () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    const refused = "net::ERR_CONNECTION_REFUSED at https://dashboard.localhost/"
    expect(networkChangedWait(["open", "https://dashboard.localhost/"], refused, 0, log)).toBeNull()
    expect(networkChangedWait(["wait", "--load", "networkidle"], CHANGED, 0, log)).toBeNull()
    expect(lines).toEqual([])
  })
})
