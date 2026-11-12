import { describe, expect, test } from "bun:test"

// The routers' auth refuses Better Auth's default secret under NODE_ENV=production, which CI's build step sets. Set before the router loads.
process.env.BETTER_AUTH_SECRET ||= "dispatcher-test-secret-not-for-use-anywhere"
const { dispatcherRouter } = await import("../../../../../api/hono/src/routers/dispatcher")
const { dispatcherSwitch } =
  await import("../../../../../api/hono/src/lib/dashboard/dispatcher-switch")
const { env } = await import("../../../../../packages/env/dist/api-hono.mjs")

const origins: unknown = env.HONO_TRUSTED_ORIGINS
const TRUSTED = Array.isArray(origins) ? String(origins[0]) : String(origins).split(",")[0]!.trim()

const peer = (address: string) => ({
  requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50000 }),
})

const post = (origin: string, address = "127.0.0.1") =>
  dispatcherRouter.request(
    "http://127.0.0.1/switch",
    {
      body: JSON.stringify({ harness: "codex" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    },
    peer(address),
  )

describe("POST /switch, Settings' Switch Alpha (#1835)", () => {
  test("is refused from another origin or off loopback before any session is read, and starts nothing", async () => {
    expect((await post("http://evil.localhost")).status).toBe(403)
    expect((await post(TRUSTED, "192.168.1.20")).status).toBe(403)
    expect(dispatcherSwitch.read().state).toBe("idle")
  })

  test("from a trusted origin over loopback it still needs the owner's session", async () => {
    expect((await post(TRUSTED)).status).toBe(401)
    expect(dispatcherSwitch.read().state).toBe("idle")
  })
})
