import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// The router's auth refuses Better Auth's default secret under NODE_ENV=production, which CI's build step sets; any secret serves requests that carry no session. Set before the router loads.
process.env.BETTER_AUTH_SECRET ||= "inbox-router-test-secret-not-for-use-anywhere"
const { inboxRouter } = await import("../../../../../api/hono/src/routers/inbox")
const { env } = await import("../../../../../packages/env/dist/api-hono.mjs")
const { refuseAgent } = await import("../../../../../api/hono/src/middlewares/dashboard")
const { refuseAgentOffFixture } = await import("../../../../../api/hono/src/middlewares/agent")
const { site } = await import("../../../../../packages/config/src/site")

// Validated, the setting is a list; with validation skipped, as in CI, it is the raw comma-separated string.
const trusted = (): string => {
  const origins: unknown = env.HONO_TRUSTED_ORIGINS
  return Array.isArray(origins) ? String(origins[0]) : String(origins).split(",")[0]!.trim()
}

// Stands in for the Bun server hono/bun reads the peer from; with none, the peer is unknown.
const peer = (address: string) => ({
  requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50000 }),
})

// The router on its own, at its own root (the API mounts it at /api/v1/inbox).
const answer = (headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
  inboxRouter.request(
    "http://127.0.0.1/0b9c6f1e-1111-4111-8111-000000000001/answer",
    {
      body: JSON.stringify({ action: "approve" }),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    },
    server,
  )

describe("the inbox routes", () => {
  test("the list turns away a request with no session", async () => {
    expect((await inboxRouter.request("http://127.0.0.1/")).status).toBe(401)
  })

  test("an answer from any origin but the dashboard's own is refused before the session is read", async () => {
    expect((await answer({}, peer("127.0.0.1"))).status).toBe(403)
    expect((await answer({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
  })

  test("an answer from another machine is refused, and so is one whose peer cannot be read", async () => {
    const refused = await answer({ origin: trusted() }, peer("192.168.1.20"))
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain("this machine only")
    expect((await answer({ origin: trusted() })).status).toBe(403)
  })

  test("an answer from the dashboard's own page on this machine still needs a session", async () => {
    expect((await answer({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
    expect((await answer({ origin: trusted() }, peer("::ffff:127.0.0.1"))).status).toBe(401)
    expect((await answer({ origin: trusted() }, peer("::1"))).status).toBe(401)
  })
})

describe("scheduling an item", () => {
  test("is a write, guarded like an answer, and takes the time alone", async () => {
    const schedule = (
      body: string,
      headers: Record<string, string>,
      server?: ReturnType<typeof peer>,
    ) =>
      inboxRouter.request(
        "http://127.0.0.1/0b9c6f1e-1111-4111-8111-000000000001/schedule",
        { body, headers: { "content-type": "application/json", ...headers }, method: "POST" },
        server,
      )
    const at = JSON.stringify({ at: "2026-10-08T09:00:00.000Z" })
    expect(
      (await schedule(at, { origin: "http://evil.localhost" }, peer("127.0.0.1"))).status,
    ).toBe(403)
    expect((await schedule(at, { origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await schedule(at, { origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
    // validation runs once the write guards pass, so an unauthenticated call stops at 401, not 400
    expect(
      (await schedule(JSON.stringify({ until: at }), { origin: trusted() }, peer("127.0.0.1")))
        .status,
    ).toBe(401)
  })
})

describe("a secret ask's Submit (PG-59)", () => {
  test("is a write, guarded like an answer, and no refusal echoes the value", async () => {
    const value = `made-up-secret-${crypto.randomUUID()}`
    const submit = (headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
      inboxRouter.request(
        "http://127.0.0.1/0b9c6f1e-1111-4111-8111-000000000001/secret",
        {
          body: JSON.stringify({ value }),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
        },
        server,
      )
    const refusals = [
      await submit({ origin: "http://evil.localhost" }, peer("127.0.0.1")),
      await submit({ origin: trusted() }, peer("192.168.1.20")),
      await submit({ origin: trusted() }),
    ]
    for (const refused of refusals) {
      expect(refused.status).toBe(403)
      expect(await refused.text()).not.toContain(value)
    }
    const unsigned = await submit({ origin: trusted() }, peer("127.0.0.1"))
    expect(unsigned.status).toBe(401)
    expect(await unsigned.text()).not.toContain(value)
  })
})

describe("marking updates read", () => {
  test("is a write, guarded like an answer", async () => {
    const read = (headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
      inboxRouter.request(
        "http://127.0.0.1/read",
        { body: "{}", headers: { "content-type": "application/json", ...headers }, method: "POST" },
        server,
      )
    expect((await read({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
    expect((await read({ origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await read({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
  })
})

describe("an Approve the dashboard carries out: an accept, an apps change, a grant, a guard setting or an own account change (PG-658, PG-1090, PG-1162)", () => {
  // the same answer such a card's Approve posts; past every guard it runs the decision's step (stepOf), so each refusal below is one that runs nothing
  const approve = (headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
    inboxRouter.request(
      "http://127.0.0.1/0b9c6f1e-1111-4111-8111-000000000658/answer",
      {
        body: JSON.stringify({ action: "approve", seen: "2026-11-03T20:00:00.000Z" }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      },
      server,
    )

  test("is refused without the dashboard's own origin", async () => {
    expect((await approve({}, peer("127.0.0.1"))).status).toBe(403)
    expect((await approve({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
  })

  test("is refused off loopback, and where the peer cannot be read", async () => {
    expect((await approve({ origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await approve({ origin: trusted() })).status).toBe(403)
  })

  test("is refused with no session, so only the signed-in owner's click reaches it", async () => {
    expect((await approve({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
  })

  test("a guard setting's or an own account change's Approve takes the same guards, and the route hands it this machine's data folder alone", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../../api/hono/src/routers/inbox.ts"),
    ).text()
    expect(source).toContain("settingsData: dataDir(),")
    expect(source).toContain('import { dataDir } from "@/lib/sessions/paths"')
    expect((await approve({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
    expect((await approve({ origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await approve({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
  })

  test("a clone's Approve takes the same guards, and the route hands it the CLI only on a stack that reads this machine (PG-2205)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../../api/hono/src/routers/inbox.ts"),
    ).text()
    expect(source).toContain("clone: readsLive() ? cloneRun() : undefined,")
    expect((await approve({}, peer("127.0.0.1"))).status).toBe(403)
    expect((await approve({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
    expect((await approve({ origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await approve({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
  })

  // the one place pkexec is wired: a test or fixture stack reads no live machine, so no test reaches the password window on the owner's screen
  test("a root step's Approve gets pkexec only on a Linux stack that reads this machine (PG-2433)", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../../api/hono/src/routers/inbox.ts"),
    ).text()
    expect(source).toContain('readsLive() && process.platform === "linux"')
    expect(source).toContain("? (argv, input) => runArgv(argv, ROOT_TIMEOUT_MS, input)")
    expect(source.match(/runArgv\(argv, ROOT_TIMEOUT_MS, input\)/g)).toHaveLength(1)
  })
})

describe("a secret's two routes refuse the agent sign-in (PG-1023)", () => {
  // the agent sign-in holds the owner rung, so each route that moves a secret carries refuseAgent after it
  test("Submit and Show each carry refuseAgent", () => {
    for (const path of ["/:id/secret", "/:id/reveal"]) {
      const handlers = inboxRouter.routes.filter(
        (route) => route.method === "POST" && route.path === path,
      )
      expect(handlers.map((route) => route.handler)).toContain(refuseAgent)
    }
  })

  test("refuseAgent turns away the agent's account with 403, and lets the owner's through", async () => {
    const { Hono } = await import("hono")
    const as = (email: string) =>
      new Hono<{ Variables: { user: { email: string } } }>()
        .use("/*", async (c, next) => {
          c.set("user", { email })
          await next()
        })
        .post("/reveal", refuseAgent, (c) => c.text("shown"))
        .request("http://127.0.0.1/reveal", { method: "POST" })
    const refused = await as(site.agent.email)
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain("owner's own click")
    expect(await (await as(site.owner.email)).text()).toBe("shown")
  })
})

describe("a reveal card's Show (PG-1023)", () => {
  const reveal = (headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
    inboxRouter.request(
      "http://127.0.0.1/0b9c6f1e-1111-4111-8111-000000000001/reveal",
      { headers, method: "POST" },
      server,
    )

  test("is a write, refused off the dashboard's origin, off loopback, and with no session", async () => {
    expect((await reveal({}, peer("127.0.0.1"))).status).toBe(403)
    expect((await reveal({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
    expect((await reveal({ origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await reveal({ origin: trusted() })).status).toBe(403)
    expect((await reveal({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(401)
  })
})

describe("an Inbox answer refuses the agent sign-in off a fixture stack", () => {
  test("POST /:id/answer carries refuseAgentOffFixture", () => {
    const handlers = inboxRouter.routes
      .filter((route) => route.method === "POST" && route.path === "/:id/answer")
      .map((route) => route.handler)
    expect(handlers).toContain(refuseAgentOffFixture)
  })
})
