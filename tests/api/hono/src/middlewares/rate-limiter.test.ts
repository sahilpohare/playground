import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { testContainerName } from "../../../../container"

// Better Auth refuses its default secret under NODE_ENV=production, which CI's build step sets; set one before the middleware loads.
process.env.BETTER_AUTH_SECRET ||= "rate-limiter-test-secret-not-for-use-anywhere"
const { SIGNED_IN_LIMIT, limitExempt, rateLimiterMiddleware, redisSend } =
  await import("../../../../../api/hono/src/middlewares/rate-limiter")
// Resolved from the API's own source, so the test holds the same auth instance the middleware does.
const apiSrc = new URL("../../../../../api/hono/src", import.meta.url).pathname
const { auth } = await import(Bun.resolveSync("@packages/auth", apiSrc))
const { env } = await import(Bun.resolveSync("@packages/env/api-hono", apiSrc))
const { Hono } = await import("../../../../../api/hono/node_modules/hono")

const LIMIT = env.HONO_RATE_LIMIT

const app = new Hono()
  .use("*", rateLimiterMiddleware)
  .get("/", (c) => c.text("ok"))
  .get("/api/health", (c) => c.text("ok"))

const get = async (headers: Record<string, string> = {}) =>
  (await app.request("/", { headers })).status

// Sign a session token the way Better Auth's own cookie does, so getSession accepts it.
async function signedToken(token: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token))
  return encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)
}

// A session an hour from expiry, so it is due for the refresh only authMiddleware may write.
function fakeSession(token: string) {
  const now = new Date()
  return {
    session: {
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      id: "s-rate-limit",
      token,
      updatedAt: now,
      userId: "u-rate-limit",
    },
    user: {
      createdAt: now,
      email: "agent@local.host",
      emailVerified: true,
      id: "u-rate-limit",
      name: "LocalAgent",
      updatedAt: now,
    },
  }
}

// The global limiter's state outlives a test, so the tests run in order: the first spends the shared loopback bucket, the next ones rely on it being spent.
describe("rateLimiterMiddleware", () => {
  // The clock stands still for every request a test makes, so however slow the machine, the limiter's window never rolls mid-loop or between the tests and the counts stay exact. The store also expires a bucket only after two of its sweeps with no hit, and a request keeps its client in place, so a still clock holds the spent buckets too.
  const FROZEN = Date.now()
  let clock: { mockRestore: () => void } | null = null
  beforeEach(() => {
    clock = spyOn(Date, "now").mockImplementation(() => FROZEN)
  })
  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  test("limits anonymous loopback requests, which findIp cannot place, under one key", async () => {
    const context = await auth.$context
    const lookups = spyOn(context.internalAdapter, "findSession")
    try {
      const seen: number[] = []
      for (let i = 0; i <= LIMIT; i++) seen.push(await get())
      expect(seen.slice(0, LIMIT).every((status) => status === 200)).toBe(true)
      expect(seen[LIMIT]).toBe(429)
      expect(lookups).not.toHaveBeenCalled()
    } finally {
      lookups.mockRestore()
    }
  })

  test("counts a forged session cookie as anonymous, with no session lookup", async () => {
    const context = await auth.$context
    const lookups = spyOn(context.internalAdapter, "findSession")
    try {
      const cookie = `${context.authCookies.sessionToken.name}=forged-token.bm90LWEtc2lnbmF0dXJl`
      expect(await get({ cookie })).toBe(429)
      expect(lookups).not.toHaveBeenCalled()
    } finally {
      lookups.mockRestore()
    }
  })

  test("gives a signed-in user a budget of their own, past the spent anonymous one, writing nothing", async () => {
    expect(await get()).toBe(429)
    const context = await auth.$context
    const token = "rate-limit-session-token"
    const lookups = spyOn(context.internalAdapter, "findSession").mockResolvedValue(
      fakeSession(token) as never,
    )
    const refreshes = spyOn(context.internalAdapter, "updateSession")
    try {
      const cookie = `${context.authCookies.sessionToken.name}=${await signedToken(token, context.secret)}`
      const seen: number[] = []
      for (let i = 0; i <= SIGNED_IN_LIMIT; i++) seen.push(await get({ cookie }))
      expect(SIGNED_IN_LIMIT).toBe(LIMIT * 20)
      expect(seen.slice(0, SIGNED_IN_LIMIT).every((status) => status === 200)).toBe(true)
      expect(seen[SIGNED_IN_LIMIT]).toBe(429)
      expect(lookups).toHaveBeenCalled()
      expect(refreshes).not.toHaveBeenCalled()
    } finally {
      lookups.mockRestore()
      refreshes.mockRestore()
    }
  })

  test("never limits an anonymous /api/health read on a loopback stack, while the spent anonymous budget still binds", async () => {
    const health: number[] = []
    for (let i = 0; i <= LIMIT * 3; i++) {
      health.push((await app.request("/api/health")).status)
    }
    expect(health.filter((status) => status !== 200)).toEqual([])
    expect(await get()).toBe(429)
    expect((await app.request("/api/health", { method: "POST" })).status).toBe(429)
  })

  test("exempts only GET /api/health, and only when the API binds a loopback host", () => {
    expect(limitExempt("GET", "/api/health", "127.0.0.1")).toBe(true)
    expect(limitExempt("GET", "/api/health", "::1")).toBe(true)
    expect(limitExempt("GET", "/api/health", "0.0.0.0")).toBe(false)
    expect(limitExempt("GET", "/api/health/ws", "127.0.0.1")).toBe(false)
    expect(limitExempt("GET", "/api/v1/user", "127.0.0.1")).toBe(false)
    expect(limitExempt("POST", "/api/health", "127.0.0.1")).toBe(false)
  })
})

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

// A fresh API process, as a hosted instance of its own, with KV_URL as given: each of its requests' status and time.
const INSTANCE = new URL("./two-instances.ts", import.meta.url).pathname
const instance = async (
  kvUrl?: string,
  requests = 1,
): Promise<{ ms: number; status: number }[]> => {
  const env: Record<string, string | undefined> = { ...process.env, KV_URL: kvUrl }
  if (!kvUrl) delete env.KV_URL
  const child = Bun.spawn([process.execPath, INSTANCE, String(requests)], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if ((await child.exited) !== 0) throw new Error(err)
  return JSON.parse(out)
}
const statuses = (answers: { status: number }[]) => answers.map(({ status }) => status)

// A server on loopback that takes every connection and answers nothing, as a Redis that hangs does; counts its connections.
const silent = () => {
  const server = { connections: 0, url: "" }
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open() {
        server.connections++
      },
    },
  })
  server.url = `redis://127.0.0.1:${listener.port}`
  return { server, stop: () => listener.stop(true) }
}

describe("the limiter across instances", () => {
  test("with no KV_URL, each instance counts alone, in its own memory", async () => {
    expect(statuses([...(await instance()), ...(await instance())])).toEqual([200, 200])
  }, 30_000)

  test("with a KV_URL nothing answers at, each request is answered at once, counted in the instance's memory", async () => {
    const answers = await instance("redis://127.0.0.1:1", 3)
    expect(statuses(answers)).toEqual([200, 429, 429])
    expect(answers.every(({ ms }) => ms < 500)).toBe(true)
  }, 30_000)

  test("with a Redis that takes the connection and never answers, the first request waits 2 s and the next ones count in memory at once", async () => {
    const { server, stop } = silent()
    try {
      const answers = await instance(server.url, 3)
      expect(statuses(answers)).toEqual([200, 429, 429])
      expect(answers[0]!.ms).toBeGreaterThanOrEqual(1900)
      expect(answers[0]!.ms).toBeLessThan(3000)
      expect(answers.slice(1).every(({ ms }) => ms < 500)).toBe(true)
    } finally {
      stop()
    }
  }, 30_000)
})

describe("the Redis connection", () => {
  test("after a failure it rests: the next command fails at once, with no new connection", async () => {
    const { server, stop } = silent()
    try {
      const send = redisSend(server.url)
      const start = performance.now()
      await expect(send("PING", [])).rejects.toThrow()
      expect(performance.now() - start).toBeGreaterThanOrEqual(1900)
      const again = performance.now()
      await expect(send("PING", [])).rejects.toThrow("redis failed a moment ago")
      expect(performance.now() - again).toBeLessThan(50)
      expect(server.connections).toBe(1)
    } finally {
      stop()
    }
  }, 30_000)
})

const ping = async (container: string) => {
  for (let i = 0; i < 60; i++) {
    const probe = Bun.spawnSync(["docker", "exec", container, "redis-cli", "ping"])
    if (probe.stdout.toString().trim() === "PONG") return
    await Bun.sleep(250)
  }
}

// A throwaway Redis in Docker published on 127.0.0.1 only, on a port fixed for its life so a stop and start keeps it; skipped where Docker is not running.
describe.skipIf(!dockerUp())("the limiter on Redis", () => {
  let container = ""
  let url = ""

  beforeAll(async () => {
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const port = free.port
    free.stop(true)
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--name",
      testContainerName("redis-rate-limit"),
      "-p",
      `127.0.0.1:${port}:6379`,
      "redis:alpine",
    ])
      .stdout.toString()
      .trim()
    url = `redis://127.0.0.1:${port}`
    await ping(container)
  }, 60_000)

  afterAll(() => {
    if (container)
      Bun.spawnSync(["docker", "rm", "-fv", container], { stderr: "ignore", stdout: "ignore" })
  })

  test("with KV_URL set, two instances count together: the request at the limit passes, and the next one is refused", async () => {
    expect(statuses([...(await instance(url)), ...(await instance(url))])).toEqual([200, 429])
  }, 30_000)

  test("a connection Redis drops is made again on the next command, which Redis answers", async () => {
    const send = redisSend(url)
    expect(await send("PING", [])).toBe("PONG")
    Bun.spawnSync(["docker", "exec", container, "redis-cli", "CLIENT", "KILL", "TYPE", "normal"])
    await Bun.sleep(100)
    expect(await send("PING", [])).toBe("PONG")
  }, 30_000)

  test("a Redis that stops and starts again answers once the rest after the failure has passed", async () => {
    const send = redisSend(url, 300)
    expect(await send("PING", [])).toBe("PONG")
    Bun.spawnSync(["docker", "stop", "-t", "0", container], { stderr: "ignore", stdout: "ignore" })
    await expect(send("PING", [])).rejects.toThrow()
    Bun.spawnSync(["docker", "start", container], { stderr: "ignore", stdout: "ignore" })
    await ping(container)
    await Bun.sleep(300)
    expect(await send("PING", [])).toBe("PONG")
  }, 60_000)
})
