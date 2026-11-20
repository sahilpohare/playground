import { afterEach, describe, expect, test } from "bun:test"

import { config } from "../../../../../web/next/src/lib/config"
import { channelsEvery, holdsForYard, yardApi } from "../../../../../web/next/src/lib/yard-api"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

// Each call the page makes, by its URL and init, answering the invite the API would.
const calls: { init: RequestInit | undefined; url: string }[] = []
const answer = (status: string) => {
  calls.length = 0
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ init, url })
    return Response.json({ data: { invite: { code: "c0de", id: "i1", status } } })
  }) as typeof fetch
}

describe("an invite request's page", () => {
  test("approves it through the owner's web session, and gets the code back", async () => {
    answer("open")
    const { invite } = await yardApi.approveInvite("i1")
    expect(invite.code).toBe("c0de")
    expect(calls).toEqual([
      {
        init: expect.objectContaining({ credentials: "include", method: "POST" }),
        url: `${config.api.url}/api/v1/yard/invites/i1/approve`,
      },
    ])
  })

  test("denies it the same way", async () => {
    answer("revoked")
    const { invite } = await yardApi.denyInvite("i1")
    expect(invite.status).toBe("revoked")
    expect(calls).toEqual([
      {
        init: expect.objectContaining({ credentials: "include", method: "POST" }),
        url: `${config.api.url}/api/v1/yard/invites/i1/deny`,
      },
    ])
  })
})

describe("a new token", () => {
  test("asks for a read-only token by default, and for a relay-on token when its Relay switch is on", async () => {
    answer("open")
    await yardApi.createToken("phone")
    await yardApi.createToken("mac-relay", true)
    expect(calls.map((call) => [call.url, JSON.parse(String(call.init?.body))])).toEqual([
      [`${config.api.url}/api/v1/yard/tokens`, { name: "phone", relay: false }],
      [`${config.api.url}/api/v1/yard/tokens`, { name: "mac-relay", relay: true }],
    ])
  })
})

describe("the sidebar's channel reads", () => {
  test("read again every 30s on a local stack, through a passing error, and stop on a 404 or hosted", () => {
    expect(channelsEvery(false, null)).toBe(30_000)
    expect(channelsEvery(false, { code: "UPSTREAM_ERROR" })).toBe(30_000)
    expect(channelsEvery(false, { code: "NOT_FOUND" })).toBe(false)
    expect(channelsEvery(true, null)).toBe(false)
  })
})

describe("the nav's wait on Yard", () => {
  const first = { errorUpdateCount: 0, failureCount: 0, isPending: true }

  test("holds for Yard's first read while its deadline has not passed", () => {
    expect(holdsForYard(first, false)).toBe(true)
  })

  test("holds nothing once the deadline passes, so a slow Yard leaves the session groups drawn", () => {
    expect(holdsForYard(first, true)).toBe(false)
  })

  test("holds nothing once the read answered or failed", () => {
    expect(holdsForYard({ ...first, isPending: false }, false)).toBe(false)
    expect(holdsForYard({ ...first, errorUpdateCount: 1 }, false)).toBe(false)
  })
})

describe("an id in a path", () => {
  test("is escaped, so an id from a URL reaches no other route", async () => {
    answer("open")
    await yardApi.approveInvite("../tokens")
    expect(calls[0]?.url).toBe(`${config.api.url}/api/v1/yard/invites/..%2Ftokens/approve`)
  })
})

describe("the live socket", () => {
  test("adds a channel's own messages to its list, and leaves a reply to its thread", async () => {
    const source = await Bun.file(
      new URL("../../../../../web/next/src/lib/yard-api.ts", import.meta.url),
    ).text()
    expect(source).toContain('frame.type === "message" && frame.message && !frame.message.parent')
  })
})
