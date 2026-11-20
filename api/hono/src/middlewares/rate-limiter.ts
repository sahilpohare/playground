import { findIp } from "@arcjet/ip"
import { auth } from "@packages/auth"
import { env } from "@packages/env/api-hono"
import { hash, RedisClient } from "bun"
import type { Context } from "hono"
import { MemoryStore, rateLimiter, RedisStore, type Store } from "hono-rate-limiter"
import { createMiddleware } from "hono/factory"

import { jsonError } from "@/lib/error"

function generateRateLimitKey(
  c: Context,
  getUserId?: (c: Context) => string | undefined,
  getApiKey?: (c: Context) => string | undefined,
): string {
  const userId = getUserId?.(c)
  if (userId) return `userid:${userId}`

  const apiKey = getApiKey?.(c)
  if (apiKey) return `apikey:${hash(apiKey).toString(16)}`

  // findIp returns "" for a loopback or private peer (every request behind portless), so those share one key rather than each taking a fresh one that never fills.
  return `ip:${findIp(c.req.raw) || "unknown"}`
}

interface RateLimiterConfig {
  limit?: number
  windowMs?: number
  getUserId?: (c: Context) => string | undefined
  getApiKey?: (c: Context) => string | undefined
}

const REDIS_MS = 2000
const REDIS_REST_MS = 30_000

// One Redis connection for every limiter when KV_URL is set (the hosted API's), so every instance counts the same: made on the first command, and closed on any failure so the next command connects afresh. With no offline queue and a 2 s cap, a command to a Redis that stopped answering fails rather than waits, and every command for the next 30 s fails at once, so an outage costs one request 2 s rather than each one.
export const redisSend = (url: string, restMs = REDIS_REST_MS) => {
  let client: RedisClient | null = null
  let restUntil = 0
  return async (command: string, args: string[]): Promise<unknown> => {
    if (Date.now() < restUntil) throw new Error("redis failed a moment ago")
    const used = (client ??= new RedisClient(url, {
      autoReconnect: false,
      connectionTimeout: REDIS_MS,
      enableOfflineQueue: false,
    }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!used.connected) await used.connect()
      return await Promise.race([
        used.send(command, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no reply in ${REDIS_MS}ms`)), REDIS_MS)
        }),
      ])
    } catch (error) {
      restUntil = Date.now() + restMs
      used.close()
      if (client === used) client = null
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
const redis = env.KV_URL ? redisSend(env.KV_URL) : null

// Each limiter's own counters in Redis, named by its place in the module's load order, which every instance of one build shares.
let made = 0

// Counts in Redis, falling back to this instance's own memory for a call Redis cannot answer, so a Redis outage limits each instance alone, as before Redis, and refuses nothing for it.
function sharedStore(send: ReturnType<typeof redisSend>): Store {
  const shared = new RedisStore({
    client: {
      decr: (key) => send("DECR", [key]) as Promise<number>,
      del: (key) => send("DEL", [key]) as Promise<number>,
      evalsha: (sha, keys, args) =>
        send("EVALSHA", [sha, String(keys.length), ...keys, ...args.map(String)]) as never,
      scriptLoad: (script) => send("SCRIPT", ["LOAD", script]) as Promise<string>,
    },
    prefix: `rate:${made++}:`,
  })
  const own = new MemoryStore()
  return {
    decrement: (key) => shared.decrement(key).catch(() => own.decrement(key)),
    increment: (key) => shared.increment(key).catch(() => own.increment(key)),
    init: (options) => {
      shared.init(options)
      own.init(options)
    },
    localKeys: false,
    resetKey: (key) => shared.resetKey(key).catch(() => own.resetKey(key)),
  }
}

export function createRateLimiter(config: RateLimiterConfig = {}) {
  const { limit = 60, windowMs = 60000, getUserId, getApiKey } = config

  return rateLimiter({
    limit,
    windowMs,
    ...(redis && { store: sharedStore(redis) }),
    keyGenerator: (c) => generateRateLimitKey(c, getUserId, getApiKey),
    handler: (c) => jsonError(c, 429, "TOO_MANY_REQUESTS", "Too Many Requests"),
  })
}

// A signed-in request gets a budget of its own, keyed by user, so the Dashboard's polling never spends the anonymous one; at twenty times the anonymous limit it is no lower than any per-user limit authMiddleware sets, so on its routes those bind first.
export const SIGNED_IN_LIMIT = env.HONO_RATE_LIMIT * 20

const anonymousLimiter = createRateLimiter({
  limit: env.HONO_RATE_LIMIT,
  windowMs: env.HONO_RATE_LIMIT_WINDOW_MS,
})

const signedInLimiter = createRateLimiter({
  getUserId: (c) => c.get("rateLimitUserId"),
  limit: SIGNED_IN_LIMIT,
  windowMs: env.HONO_RATE_LIMIT_WINDOW_MS,
})

// A missing or forged session cookie fails its signature check before any database read, and the check never refreshes a session, which authMiddleware does.
async function signedInUserId(c: Context) {
  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableRefresh: true },
    })
    return session?.user.id
  } catch {
    return undefined
  }
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/

// Every page render reads GET /api/health with no session, and on a loopback stack every peer shares one anonymous key, so those reads spent the budget and every health read after it answered 429; on an API bound past loopback the read stays limited.
export const limitExempt = (method: string, path: string, hostname: string = env.HONO_HOSTNAME) =>
  method === "GET" && path === "/api/health" && LOOPBACK_HOST.test(hostname)

export const rateLimiterMiddleware = createMiddleware<{ Variables: { rateLimitUserId: string } }>(
  async (c, next) => {
    if (limitExempt(c.req.method, c.req.path)) return next()
    const userId = await signedInUserId(c)
    if (!userId) return anonymousLimiter(c as Context, next)
    c.set("rateLimitUserId", userId)
    return signedInLimiter(c as Context, next)
  },
)
