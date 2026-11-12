import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Hono } from "hono"

import { jobKey } from "../../../../../packages/settings/src/jobs"
import { loginPath } from "../../../../../packages/settings/src/rendered"
import { readSetting, setSetting } from "../../../../../packages/settings/src/settings-folder"

// The router's auth refuses Better Auth's default secret under NODE_ENV=production, which CI's build step sets; any secret serves requests that carry no session. Set before the router loads.
process.env.BETTER_AUTH_SECRET ||= "settings-router-test-secret-not-for-use-anywhere"
const { settingsRouter } = await import("../../../../../api/hono/src/routers/settings")
const { env } = await import("../../../../../packages/env/dist/api-hono.mjs")
const { errorHandler } = await import("../../../../../api/hono/src/lib/error")
// Resolved from the API's own source, so the test holds the same auth instance the middlewares do.
const { auth } = await import(
  Bun.resolveSync(
    "@packages/auth",
    new URL("../../../../../api/hono/src", import.meta.url).pathname,
  )
)

const scratch = mkdtempSync(join(tmpdir(), "settings-router-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// Validated, the setting is a list; with validation skipped, as in CI, it is the raw comma-separated string.
const trusted = (): string => {
  const origins: unknown = env.HONO_TRUSTED_ORIGINS
  return Array.isArray(origins) ? String(origins[0]) : String(origins).split(",")[0]!.trim()
}

// Stands in for the Bun server hono/bun reads the peer from; with none, the peer is unknown.
const peer = (address: string) => ({
  requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50000 }),
})

// Stands in for Better Auth's session read: authMiddleware asks with returnHeaders and takes { headers, response }, requireConsoleRole asks without and takes the session.
const signedIn = (role: string) =>
  spyOn(auth.api, "getSession").mockImplementation((async (options: {
    returnHeaders?: boolean
  }) => {
    const session = {
      session: { id: "s-settings", userId: `u-${role}` },
      user: { banned: false, id: `u-${role}`, role },
    }
    return options.returnHeaders ? { headers: new Headers(), response: session } : session
  }) as never)

// Mounted with the API's error handler, so a thrown ApiError answers in its { error } envelope.
const app = new Hono().route("/", settingsRouter)
app.onError(errorHandler)

const ME = "made-up-me"
const KEY = jobKey("ops-sweep")

// Settings > Jobs' two writes, as the web sends them (jobToggleWrite and jobConfigWrite in web/next/src/lib/jobs.ts).
const WRITES = {
  "the config card's edit": {
    by: "Settings",
    reason: "Set ops-sweep's config in Settings > Jobs",
    scope: ME,
    value: { config: { hours: "09-18", made: ["up"] }, enabled: true },
  },
  "the toggle": {
    by: "Settings",
    reason: "Turned ops-sweep on in Settings > Jobs",
    scope: ME,
    value: { enabled: true },
  },
}

const put = (body: unknown, headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
  app.request(
    `http://127.0.0.1/${KEY}`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "PUT",
    },
    server,
  )

const here = () => [{ origin: trusted() }, peer("127.0.0.1")] as const

const spies: { mockRestore: () => void }[] = []
const ENV_KEYS = ["PLAYGROUND_DATA_DIR", "PLAYGROUND_LIVE_READS"] as const
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const key of ENV_KEYS)
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
})

// A scratch data folder whose extensions have your login, as Set up settings leaves it, read live so dataDir() names it.
const setUp = () => {
  const data = mkdtempSync(join(scratch, "data-"))
  mkdirSync(dirname(loginPath(data)), { recursive: true })
  writeFileSync(loginPath(data), `${ME}\n`)
  process.env.PLAYGROUND_DATA_DIR = data
  process.env.PLAYGROUND_LIVE_READS = "1"
  return data
}

// #1336: the owner's own click in Settings > Jobs writes straight through this PUT, so it takes the dashboard's write guards and the owner rung, and needs no Inbox Approve.
describe("Settings > Jobs' writes through PUT /api/v1/settings/:key (#1336)", () => {
  // The owner's session is stubbed, so each 403 can come only from guardWrites.
  test.each(Object.entries(WRITES))(
    "%s is refused with no origin, another origin, or from off this machine, even for the owner",
    async (_, body) => {
      spies.push(signedIn("owner"))
      expect((await put(body, {}, peer("127.0.0.1"))).status).toBe(403)
      expect((await put(body, { origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(
        403,
      )
      expect((await put(body, { origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
      expect((await put(body, { origin: trusted() })).status).toBe(403)
    },
  )

  test.each(Object.entries(WRITES))(
    "%s is refused with no session, and below the owner rung",
    async (_, body) => {
      expect((await put(body, ...here())).status).toBe(401)
      spies.push(signedIn("admin"))
      expect((await put(body, ...here())).status).toBe(403)
    },
  )

  test("the owner's config edit writes at once at your scope, keeping the row's other fields, with no Inbox Approve", async () => {
    const data = setUp()
    const who = { actor: "u-owner", author: "owner", inboxRef: null, reason: "seed" }
    const seed = { config: { hours: "00-23" }, enabled: true, pausedFor: "made-up" }
    expect(setSetting(data, { key: KEY, scope: ME, value: seed }, who).ok).toBe(true)
    spies.push(signedIn("owner"))
    const body = {
      ...WRITES["the config card's edit"],
      value: { ...seed, config: { hours: "09-18", made: ["up"] } },
    }
    const response = await put(body, ...here())
    expect(response.status).toBe(200)
    expect(readSetting(data, KEY)!.rows).toEqual([{ key: KEY, scope: ME, value: body.value }])
  })
})

// #1797: Settings > Extensions > WhatsApp saves its two numbers through this PUT, and the page reads each back by its last 4 digits alone, so no answer of this router carries a whole number.
describe("WhatsApp's numbers through /api/v1/settings (#1797)", () => {
  const NUMBER = "+15550100001"
  const MASKED = "••••0001"
  const write = (key: string, value: string) =>
    app.request(
      `http://127.0.0.1/${key}`,
      {
        body: JSON.stringify({
          by: "Settings",
          reason: `Set ${key} in Settings > Extensions`,
          scope: ME,
          value,
        }),
        headers: { "content-type": "application/json", origin: trusted() },
        method: "PUT",
      },
      peer("127.0.0.1"),
    )
  const read = (path: string) => app.request(`http://127.0.0.1${path}`)

  test("a bad number is refused with a plain message and nothing is saved", async () => {
    const data = setUp()
    spies.push(signedIn("owner"))
    const response = await write("wa.owner", "5550100001")
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("a phone number is + and 8 to 15 digits")
    expect(readSetting(data, "wa.owner")!.rows).toEqual([])
  })

  test.each(["wa.device", "wa.owner"])(
    "%s saves whole, and every read gives back its last 4 digits alone",
    async (key) => {
      const data = setUp()
      spies.push(signedIn("owner"))
      const response = await write(key, NUMBER)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { key, scope: ME, value: MASKED } })
      expect(readSetting(data, key)!.rows).toEqual([{ key, scope: ME, value: NUMBER }])

      const one = await read(`/${key}`)
      const oneBody = await one.text()
      expect(oneBody).not.toContain(NUMBER)
      expect(JSON.parse(oneBody).data).toMatchObject({
        rows: [{ key, scope: ME, value: MASKED }],
        value: MASKED,
      })

      const all = await read("/")
      const allBody = await all.text()
      expect(allBody).not.toContain(NUMBER)
      const listed = JSON.parse(allBody).data
      expect(listed.values[key]).toBe(MASKED)
      expect(listed.rows).toContainEqual({ key, scope: ME, value: MASKED })

      const why = await read(`/${key}/why`)
      const whyBody = await why.text()
      expect(whyBody).not.toContain(NUMBER)
      expect(JSON.parse(whyBody).data[0]).toMatchObject({ newValue: MASKED, oldValue: null })
    },
  )
})
