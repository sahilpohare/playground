import { afterAll, describe, expect, test } from "bun:test"

import { YardError, yardClient } from "../../../../../../api/hono/src/lib/yard/client"

// A fake hosted Yard on loopback: it records each request and answers as the hosted router does.
const seen: { auth: string | null; body: string; method: string; path: string }[] = []
const MESSAGE = {
  at: "2026-10-31T10:00:00.000Z",
  channel: "c1",
  from: { device: "studio", login: "bo" },
  id: "m1",
  kind: "text",
  text: "hello",
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    seen.push({
      auth: request.headers.get("authorization"),
      body: await request.text(),
      method: request.method,
      path: `${url.pathname}${url.search}`,
    })
    if (url.pathname.includes("/refused/"))
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Yard is invite-only" } },
        { status: 403 },
      )
    if (url.pathname.endsWith("/odd")) return Response.json({ data: { channels: "no" } })
    if (url.pathname.endsWith("/messages") && request.method === "POST")
      return Response.json(
        { data: { message: { ...MESSAGE, status: "pending" } } },
        { status: 201 },
      )
    if (url.pathname.endsWith("/messages"))
      return Response.json({ data: { hasMore: false, messages: [MESSAGE] } })
    return Response.json({ data: { channels: [] } })
  },
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`

describe("the hosted Yard client", () => {
  test("sends the token as a bearer to the hosted router's paths and reads the { data } envelope", async () => {
    const client = yardClient(base, "yard_mac")
    expect(await client.channels()).toEqual([])
    expect((await client.messages("c 1", { limit: 5 })).messages[0]!.text).toBe("hello")
    expect((await client.post("c1", { kind: "steps", text: "run it" })).status).toBe("pending")
    expect(seen.map(({ auth, method, path }) => [auth, method, path])).toEqual([
      ["Bearer yard_mac", "GET", "/api/v1/yard/channels"],
      ["Bearer yard_mac", "GET", "/api/v1/yard/channels/c%201/messages?limit=5"],
      ["Bearer yard_mac", "POST", "/api/v1/yard/channels/c1/messages"],
    ])
    expect(JSON.parse(seen[2]!.body)).toEqual({ kind: "steps", text: "run it" })
  })

  test("a refusal throws Yard's own words with its status", async () => {
    const error = await yardClient(base, "yard_mac")
      .read("refused")
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(YardError)
    expect([(error as YardError).status, (error as YardError).message]).toEqual([
      403,
      "Yard is invite-only",
    ])
  })

  test("a swap posts the new secret with the old token as its bearer to the swap route", async () => {
    const swap = yardClient(base, "yard_old", (url, init) => {
      seen.push({
        auth: new Headers(init.headers).get("authorization"),
        body: String(init.body),
        method: init.method ?? "GET",
        path: new URL(url).pathname,
      })
      return Promise.resolve(Response.json({ data: { token: { id: "t1", name: "mac" } } }))
    })
    expect(await swap.swapToken("yard_new")).toEqual({ token: { id: "t1", name: "mac" } })
    expect(seen.at(-1)).toEqual({
      auth: "Bearer yard_old",
      body: '{"secret":"yard_new"}',
      method: "POST",
      path: "/api/v1/yard/tokens/swap",
    })
  })

  test("an answer in a shape it does not read is refused, never passed on", async () => {
    const odd = yardClient(base, "yard_mac", (_, init) => fetch(`${base}/odd`, init))
    expect(((await odd.channels().catch((e: unknown) => e)) as YardError).status).toBe(502)
  })
})
