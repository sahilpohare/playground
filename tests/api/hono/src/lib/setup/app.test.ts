import { describe, expect, test } from "bun:test"

import type { Fetch } from "../../../../../../api/hono/src/lib/setup/app"

const { firstRun, setupApp } = await import("../../../../../../api/hono/src/lib/setup/app")
const { GuardError } = await import("../../../../../../api/hono/src/lib/sessions/guard")
const { env } = await import("../../../../../../packages/env/dist/api-hono.mjs")
const { site } = await import("../../../../../../packages/config/src/site")

// Validated, the setting is a list; with validation skipped, as in CI, it is the raw comma-separated string.
const trusted = (): string => {
  const origins: unknown = env.HONO_TRUSTED_ORIGINS
  return Array.isArray(origins) ? String(origins[0]) : String(origins).split(",")[0]!.trim()
}

// Stands in for the Bun server hono/bun reads the peer from.
const peer = (address: string) => ({
  requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50000 }),
})

type App = ReturnType<typeof setupApp>
const start = (
  app: App,
  { address = "127.0.0.1", headers = {} as Record<string, string>, origin = trusted() } = {},
) =>
  app.request(
    "http://127.0.0.1/api/setup/container",
    { headers: { origin, ...headers }, method: "POST" },
    peer(address),
  )
const read = async (app: App) => (await (await app.request("/api/setup")).json()).data

describe("setup mode", () => {
  test("reads idle until a start, and serves no other route", async () => {
    const app = setupApp(async () => {})
    expect(await read(app)).toEqual({ status: "idle" })
    for (const path of ["/api/v1/workers", "/api/auth/get-session", "/"]) {
      expect((await app.request(path)).status).toBe(404)
    }
  })

  // Every reader of health (playground's wait, ops-tick's watch, verify) counts a stack in setup as up, and the marker says why it has no database.
  test("answers health as up and in setup, with no database", async () => {
    const response = await setupApp(async () => {}).request("/api/health")
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data).toMatchObject({ dispatcherSlots: 1, message: "ok", setup: true })
    expect(typeof data.dashboard).toBe("string")
    expect(typeof data.environment).toBe("string")
    expect(typeof data.version).toBe("string")
    expect(data).not.toHaveProperty("db")
  })

  // A fresh Mac's first stack has no database, so playground's wait reads this app's health and opens the Dashboard on it.
  test("reads as up to playground's wait", async () => {
    const { apiUp } = await import("../../../../../../packages/scripts/src/playground/probe")
    const server = Bun.serve({
      fetch: setupApp(async () => {}).fetch,
      hostname: "127.0.0.1",
      port: 0,
    })
    const url = `http://127.0.0.1:${server.port}`
    expect(await apiUp({ api: url, web: url })).toBe(true)
    await server.stop(true)
  })

  test("answers onboarding's checks with the database as setup stands and done false, from this machine alone", async () => {
    const app = setupApp(async () => {})
    const res = await app.request("/api/v1/onboard/checks")
    expect(res.status).toBe(200)
    const { checks, done } = (await res.json()).data
    expect(done).toBe(false)
    expect(checks.find((c: { name: string }) => c.name === "Database")).toMatchObject({
      detail: "not started",
      status: "MISSING",
    })
    const forwarded = await app.request("/api/v1/onboard/checks", {
      headers: { "x-forwarded-for": "100.101.102.103" },
    })
    expect(forwarded.status).toBe(403)
  })

  test("lets the trusted web origin read the checks without credentials, since no user exists yet", async () => {
    const app = setupApp(async () => {})
    const res = await app.request("/api/v1/onboard/checks", { headers: { origin: trusted() } })
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe(trusted())
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
  })

  test("refuses another origin, a peer off loopback and a client forwarded from off this machine, starting nothing", async () => {
    let started = 0
    const app = setupApp(async () => {
      started++
    })
    const refused = [
      await start(app, { origin: "http://evil.localhost" }),
      await start(app, { address: "192.168.1.20" }),
      await start(app, { headers: { "x-forwarded-for": "100.101.102.103" } }),
      await start(app, { headers: { "x-forwarded-for": "127.0.0.1, 192.168.1.20" } }),
      await start(app, { headers: { "tailscale-user-login": "me@example.com" } }),
    ]
    for (const response of refused) expect(response.status).toBe(403)
    expect(started).toBe(0)
    expect(await read(app)).toEqual({ status: "idle" })
  })

  test("runs one setup at a time, showing its step", async () => {
    let finish = () => {}
    const app = setupApp(
      (onStep) =>
        new Promise<void>((resolve) => {
          onStep("Starting Postgres")
          finish = resolve
        }),
    )
    expect((await start(app, { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(202)
    expect(await read(app)).toEqual({ status: "starting", step: "Starting Postgres" })
    expect((await start(app)).status).toBe(409)
    finish()
  })

  test("shows a failure's words, and starts again on Try again", async () => {
    let calls = 0
    const app = setupApp(async () => {
      calls++
      throw new Error("Docker is not running.")
    })
    expect((await start(app)).status).toBe(202)
    await Bun.sleep(0)
    expect(await read(app)).toEqual({ reason: "Docker is not running.", status: "failed" })
    expect((await start(app)).status).toBe(202)
    expect(calls).toBe(2)
  })

  test("a start the guard refused as exposed reads so, and the next click asks start to move it", async () => {
    const moves: boolean[] = []
    const app = setupApp(async (_onStep, _engine, move) => {
      moves.push(move)
      if (moves.length === 1)
        throw new GuardError("exposed", "playground-db-Ab12 publishes beyond loopback")
    })
    expect((await start(app)).status).toBe(202)
    await Bun.sleep(0)
    expect(await read(app)).toEqual({
      exposed: true,
      reason: "playground-db-Ab12 publishes beyond loopback",
      status: "failed",
    })
    expect((await start(app)).status).toBe(202)
    await Bun.sleep(0)
    expect(moves).toEqual([false, true])
  })

  test("takes 5 starts a minute", async () => {
    const app = setupApp(async () => {
      throw new Error("no")
    })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      statuses.push((await start(app)).status)
      await Bun.sleep(0)
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429])
  })
})

describe("firstRun", () => {
  test("serves setup until the database is ready, then the normal app in the same process", async () => {
    let started = () => {}
    let loaded = (_fetch: Fetch) => {}
    const seen: unknown[] = []
    const normal: Fetch = (request, server) => {
      seen.push(server)
      return new Response(`normal ${new URL(request.url).pathname}`, { status: 404 })
    }
    const serve = firstRun(
      () => new Promise<void>((resolve) => (started = resolve)),
      () => new Promise<Fetch>((resolve) => (loaded = resolve)),
    )
    const server = peer("127.0.0.1")
    const get = () => serve(new Request("http://127.0.0.1/api/setup"), server)
    const status = async () => (await (await get()).json()).data
    expect(await status()).toEqual({ status: "idle" })
    const post = new Request("http://127.0.0.1/api/setup/container", {
      headers: { origin: trusted() },
      method: "POST",
    })
    expect((await serve(post, server)).status).toBe(202)
    started()
    await Bun.sleep(0)
    expect(await status()).toEqual({ status: "starting", step: `Opening ${site.name}` })
    loaded(normal)
    await Bun.sleep(0)
    const after = await get()
    expect([after.status, await after.text()]).toEqual([404, "normal /api/setup"])
    expect(seen).toEqual([server])
  })
})
