import { describe, expect, test } from "bun:test"

import type { Delivery } from "../../../../../api/hono/src/lib/dashboard/deliver"
import type { SettingChanging } from "../../../../../api/hono/src/lib/dashboard/sdk"

// The router's auth refuses Better Auth's default secret under NODE_ENV=production, which CI's build step sets; any secret serves requests that carry no session. Set before the router loads.
process.env.BETTER_AUTH_SECRET ||= "dashboard-router-test-secret-not-for-use-anywhere"
const {
  answerPrompt,
  attachmentLimiter,
  changeMode,
  changeSetting,
  dashboardRouter,
  feedAnswerSchema,
  feedParamsSchema,
  managersOrderLimiter,
  messageLimiter,
  modeLimiter,
  modeSchema,
  pasteReportBody,
  pasteReportBodyLimit,
  pasteReportLimiter,
  quoteOf,
  sendMessage,
  serveAttachment,
  servedHeaders,
  settingLimiter,
  threadParamsSchema,
  threadsQuerySchema,
  uploadAttachment,
  uploadBodyLimit,
  uploadForm,
} = await import("../../../../../api/hono/src/routers/dashboard")
const { errorHandler } = await import("../../../../../api/hono/src/lib/error")
const { MAX_ATTACHMENT_BYTES, storeAttachment, readAttachment } =
  await import("../../../../../api/hono/src/lib/dashboard/attachments")
const { mkdtempSync, rmSync } = await import("node:fs")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const { DISPATCHER, DISPATCHER_SECONDARY } =
  await import("../../../../../api/hono/src/lib/dashboard/workers")
const { changeHostedMode, SDK_PROBE, SdkHost } =
  await import("../../../../../api/hono/src/lib/dashboard/sdk")
const { DELIVERY_FAILURES } = await import("../../../../../api/hono/src/lib/dashboard/deliver")
const { Hono } = await import("../../../../../api/hono/node_modules/hono")
const { env } = await import("../../../../../packages/env/dist/api-hono.mjs")
const { refuseAgentOffFixture } = await import("../../../../../api/hono/src/middlewares/agent")

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
)

// The router on its own, at its own root (the API mounts it at /api/v1): the API's entry reads a version constant only its build defines. ApiError is an HTTPException, so its status survives without the API's error handler.
const request = (path: string, headers: Record<string, string> = {}) =>
  dashboardRouter.request(`http://127.0.0.1${path}`, { headers })

// A Bun server's requestIP, as hono/bun's getConnInfo reads it from the fetch's second argument: where the connection came from.
const from = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 50000 }) })

const post = (
  path: string,
  headers: Record<string, string>,
  body: unknown,
  server?: ReturnType<typeof from>,
) =>
  dashboardRouter.request(
    `http://127.0.0.1${path}`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    },
    server,
  )

const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" }

// The first trusted origin, whether the setting arrives validated as a list or as its raw comma-separated string.
const trusted = (): string => {
  const origins: unknown = env.HONO_TRUSTED_ORIGINS
  return Array.isArray(origins) ? String(origins[0]) : String(origins).split(",")[0]!.trim()
}

describe("the dashboard routes", () => {
  test("every route turns away a request with no session", async () => {
    for (const path of [
      "/agents",
      "/workers",
      "/workers/s-1/transcript",
      "/workers/s-1/skills",
      "/attachments/11111111-2222-4333-8444-555555555555.png",
      "/model-icons/anthropic",
      "/threads",
      "/threads?page=2",
      "/threads/k7mq/messages",
    ]) {
      expect((await request(path)).status).toBe(401)
    }
  })

  test("the WebSocket refuses any origin but the dashboard's own, before it looks at the session", async () => {
    expect((await request("/ws", upgrade)).status).toBe(403)
    expect((await request("/ws", { ...upgrade, origin: "http://evil.localhost" })).status).toBe(403)
  })

  test("the WebSocket from the dashboard's own origin still needs a session", async () => {
    expect((await request("/ws", { ...upgrade, origin: trusted() })).status).toBe(401)
  })

  test("a write from any origin but the dashboard's own is refused before anything else", async () => {
    const body = { text: "hi", to: "dispatcher" }
    expect((await post("/messages", {}, body, from("127.0.0.1"))).status).toBe(403)
    expect(
      (await post("/messages", { origin: "http://evil.localhost" }, body, from("127.0.0.1")))
        .status,
    ).toBe(403)
  })

  test("a write from the dashboard's origin over a connection that is not loopback is refused", async () => {
    const body = { text: "hi", to: "dispatcher" }
    expect(
      (await post("/messages", { origin: trusted() }, body, from("192.168.1.20"))).status,
    ).toBe(403)
    expect((await post("/messages", { origin: trusted() }, body)).status).toBe(403)
  })

  test("an upload is a write: it needs the dashboard's origin, a loopback connection and a session, in that order", async () => {
    const upload = (headers: Record<string, string>, server?: ReturnType<typeof from>) => {
      const form = new FormData()
      form.append("file", new File(["hello"], "a.txt", { type: "text/plain" }))
      return dashboardRouter.request(
        "http://127.0.0.1/attachments",
        { body: form, headers, method: "POST" },
        server,
      )
    }
    expect((await upload({}, from("127.0.0.1"))).status).toBe(403)
    expect((await upload({ origin: trusted() }, from("192.168.1.20"))).status).toBe(403)
    expect((await upload({ origin: trusted() }, from("127.0.0.1"))).status).toBe(401)
  })

  test("answering a prompt is a write: it needs the dashboard's origin, a loopback connection and a session, in that order", async () => {
    const path = "/workers/s-1/feed/A70A45B3-D38A-48D9-8D56-CE30BEED2681"
    const body = { kind: "permission", mode: "deny" }
    expect((await post(path, {}, body, from("127.0.0.1"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("192.168.1.20"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("127.0.0.1"))).status).toBe(401)
  })

  test("a write from the dashboard's origin over loopback still needs a session", async () => {
    const body = { text: "hi", to: "dispatcher" }
    for (const address of ["127.0.0.1", "::1"]) {
      expect((await post("/messages", { origin: trusted() }, body, from(address))).status).toBe(401)
    }
  })

  // A message to the second dispatcher goes only from the owner's click on its composer: the route's guards refuse it as they refuse the primary's
  test("a message to the second dispatcher is refused from another origin, off loopback, and without a session", async () => {
    const body = { text: "hi", to: DISPATCHER_SECONDARY }
    expect((await post("/messages", {}, body, from("127.0.0.1"))).status).toBe(403)
    expect(
      (await post("/messages", { origin: trusted() }, body, from("192.168.1.20"))).status,
    ).toBe(403)
    expect((await post("/messages", { origin: trusted() }, body, from("127.0.0.1"))).status).toBe(
      401,
    )
  })
})

describe("the thread routes", () => {
  const patch = (path: string, headers: Record<string, string>, server?: ReturnType<typeof from>) =>
    dashboardRouter.request(
      `http://127.0.0.1${path}`,
      {
        body: JSON.stringify({ read: true }),
        headers: { "content-type": "application/json", ...headers },
        method: "PATCH",
      },
      server,
    )

  test("a change to a thread is a write: it needs the dashboard's origin, a loopback connection and a session, in that order", async () => {
    expect((await patch("/threads/k7mq", {}, from("127.0.0.1"))).status).toBe(403)
    expect(
      (await patch("/threads/k7mq", { origin: "http://evil.localhost" }, from("127.0.0.1"))).status,
    ).toBe(403)
    expect((await patch("/threads/k7mq", { origin: trusted() }, from("192.168.1.20"))).status).toBe(
      403,
    )
    expect((await patch("/threads/k7mq", { origin: trusted() }, from("127.0.0.1"))).status).toBe(
      401,
    )
  })

  test("a thread's id is 4 characters of the id alphabet with a letter among them, and nothing a path could carry", () => {
    const id = (value: string) => threadParamsSchema.safeParse({ id: value }).success
    expect(id("k7mq")).toBe(true)
    for (const value of ["", "2345", "k7m", "k7mqx", "K7MQ", "a7mq", "../x", "k7%2F"])
      expect(id(value)).toBe(false)
  })

  test("the list's page is a whole number from 1, the first when none is named", () => {
    expect(threadsQuerySchema.parse({})).toEqual({ page: 1 })
    expect(threadsQuerySchema.parse({ page: "2" })).toEqual({ page: 2 })
    for (const page of ["0", "-1", "1.5", "two"])
      expect(threadsQuerySchema.safeParse({ page }).success).toBe(false)
  })
})

describe("answerPrompt", () => {
  const input = {
    actor: { email: "owner@local.host", id: "u-1" },
    answer: { kind: "permission" as const, mode: "deny" as const },
    approver: { role: "owner" },
    requestId: "A70A45B3-D38A-48D9-8D56-CE30BEED2681",
    sessionId: "s-1",
  }

  test("an answer that lands returns when", async () => {
    const answer = async () => ({ at: "2026-10-06T03:00:00.000Z", ok: true as const })
    expect(await answerPrompt(input, answer)).toEqual({ at: "2026-10-06T03:00:00.000Z" })
  })

  // While approvals are off, a permission answer is a 403 that names DISABLED; a sign-in below the owner a 403 that names FORBIDDEN.
  test("every refusal becomes the API's error, with its reason and its code under feed", async () => {
    const expected: Record<string, [number, string]> = {
      BUSY: [409, "CONFLICT"],
      DISABLED: [403, "FORBIDDEN"],
      FORBIDDEN: [403, "FORBIDDEN"],
      INVALID: [400, "VALIDATION_ERROR"],
      NOT_FOUND: [404, "NOT_FOUND"],
      NOT_PENDING: [409, "CONFLICT"],
      SESSIONS_FAILED: [502, "SESSIONS_FAILED"],
      UNCONFIRMED: [502, "SESSIONS_FAILED"],
    }
    for (const [code, [status, apiCode]] of Object.entries(expected)) {
      const answer = async () => ({
        code: code as "BUSY",
        ok: false as const,
        reason: `because ${code}`,
      })
      const error = await answerPrompt(input, answer).catch((thrown) => thrown)
      expect(error).toMatchObject({
        code: apiCode,
        extra: { feed: code },
        message: `because ${code}`,
        status,
      })
    }
  })

  // The route's own schema turns away a mode that would approve more than the one action, before anything reads a session.
  test("the route's body takes only once or deny for a permission, manual or deny for a plan, and named choices", () => {
    for (const mode of ["always", "all", "bypass"]) {
      expect(feedAnswerSchema.safeParse({ kind: "permission", mode }).success).toBe(false)
    }
    for (const mode of ["ultraplan", "bypassPermissions", "autoAccept"]) {
      expect(feedAnswerSchema.safeParse({ kind: "plan", mode }).success).toBe(false)
    }
    const question = (choices: string[], text: string | null) => ({
      answers: [{ choices, text }],
      kind: "question",
    })
    expect(feedAnswerSchema.safeParse(question([""], null)).success).toBe(false)
    expect(feedAnswerSchema.safeParse(question([], "x".repeat(4001))).success).toBe(false)
    expect(feedAnswerSchema.safeParse(question(["Red"], null)).success).toBe(true)
    expect(feedAnswerSchema.safeParse({ kind: "permission", mode: "once" }).success).toBe(true)
  })

  // a herdr card's id is its tool call's, so the route takes one, and answerFeed answers it by keys into its pane
  test("the route's params take a herdr card's tool call id, and nothing a path could carry", () => {
    const params = (requestId: string) =>
      feedParamsSchema.safeParse({ requestId, sessionId: "s" }).success
    expect(params("3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe(true)
    expect(params("toolu_01L4bXq9wZ7dK2mN8pR3sT6v")).toBe(true)
    for (const id of ["", "../x", "toolu_01 x", "a/b", "x".repeat(101)])
      expect(params(id)).toBe(false)
  })
})

describe("sendMessage", () => {
  const actor = { email: "owner@local.host", id: "u-1" }

  test("phase 2a sends to the dispatcher and the hosted session only, before anything is delivered", async () => {
    let called = false
    const send = async () => {
      called = true
      return { at: "now", ok: true as const, sessionId: "s" }
    }
    const refused = await sendMessage({ text: "hi", to: "worker-envy" }, actor, send).catch(
      (error: { status: number }) => error,
    )
    expect(refused).toMatchObject({ code: "FORBIDDEN", status: 403 })
    expect(called).toBe(false)
  })

  test("a message to the session the dashboard hosts goes on its input, never typed into a terminal", async () => {
    const typed: Delivery[] = []
    const hosted: Delivery[] = []
    const send = async (delivery: Delivery) => {
      typed.push(delivery)
      return { at: "now", ok: true as const, sessionId: "s-1" }
    }
    const sendHosted = async (delivery: Delivery) => {
      hosted.push(delivery)
      return { at: "now", ok: true as const, sessionId: "s-2" }
    }
    const find = async () => null
    expect(await sendMessage({ text: "hi", to: SDK_PROBE }, actor, send, find, sendHosted)).toEqual(
      { at: "now", sessionId: "s-2" },
    )
    expect(hosted.map((d) => d.to)).toEqual([SDK_PROBE])
    expect(typed).toEqual([])
  })

  // #i520: each dispatcher has its own chat, so a click on either's composer sends to it, typed into its terminal
  test("a message to the second dispatcher is typed into its terminal, as the primary's is", async () => {
    const typed: Delivery[] = []
    const hosted: Delivery[] = []
    const send = async (delivery: Delivery) => {
      typed.push(delivery)
      return { at: "now", ok: true as const, sessionId: "s-glm" }
    }
    const sendHosted = async (delivery: Delivery) => {
      hosted.push(delivery)
      return { at: "now", ok: true as const, sessionId: "s-2" }
    }
    expect(
      await sendMessage(
        { text: "hi", to: DISPATCHER_SECONDARY },
        actor,
        send,
        async () => null,
        sendHosted,
      ),
    ).toEqual({ at: "now", sessionId: "s-glm" })
    expect(typed.map((d) => d.to)).toEqual([DISPATCHER_SECONDARY])
    expect(hosted).toEqual([])
  })

  test("a delivery comes back as its time and session", async () => {
    const send = async () => ({
      at: "2026-10-06T12:00:00.000Z",
      ok: true as const,
      sessionId: "s-1",
    })
    expect(await sendMessage({ text: "hi", to: DISPATCHER }, actor, send)).toEqual({
      at: "2026-10-06T12:00:00.000Z",
      sessionId: "s-1",
    })
  })

  // #780: the Assistant's own chat sends through deliver() too, to the session the roster seats as the assistant and to no other manager
  test("a message to the session in the assistant seat goes through deliver(), and one to another manager is FORBIDDEN before anything is sent", async () => {
    const sent: Delivery[] = []
    const send = async (delivery: Delivery) => {
      sent.push(delivery)
      return { at: "2026-11-03T21:00:00.000Z", ok: true as const, sessionId: "s-a" }
    }
    const seat = async () => "errands"
    const message = (to: string) =>
      sendMessage({ text: "hi", to }, actor, send, undefined, undefined, undefined, undefined, seat)
    expect(await message("errands")).toEqual({ at: "2026-11-03T21:00:00.000Z", sessionId: "s-a" })
    expect(sent).toEqual([expect.objectContaining({ actor, text: "hi", to: "errands" })])
    expect(await message("builder").catch((error: unknown) => error)).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    })
    const none = await sendMessage(
      { text: "hi", to: "errands" },
      actor,
      send,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => undefined,
    ).catch((error: unknown) => error)
    expect(none).toMatchObject({ code: "FORBIDDEN", status: 403 })
    expect(sent).toHaveLength(1)
  })

  test("a thread is the dispatcher's alone, so the assistant's chat opens none", async () => {
    const send = async () => ({ at: "now", ok: true as const, sessionId: "s-a" })
    const refused = await sendMessage(
      { newThread: true, text: "hi", to: "errands" },
      actor,
      send,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => "errands",
    ).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
  })

  test("a message naming an inbox item records the reply once it is out, never on a failed send and never for words that name none", async () => {
    const replies: number[] = []
    const recordReply = async (ref: number) => {
      replies.push(ref)
    }
    const send = async () => ({ at: "now", ok: true as const, sessionId: "s-1" })
    const find = async () => null
    const sendHosted = async () => ({ at: "now", ok: true as const, sessionId: "s-2" })
    await sendMessage(
      { text: "re #i7: on it", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
    )
    expect(replies).toEqual([7])
    const refused = await sendMessage(
      { text: "re #i7: on it", to: DISPATCHER },
      actor,
      async () => ({ code: "ON_PICKER", ok: false as const, reason: "busy" }),
      find,
      sendHosted,
      recordReply,
    ).catch((error: { code: string }) => error)
    expect(refused).toMatchObject({ code: "CONFLICT" })
    expect(replies).toEqual([7])
    await sendMessage(
      { text: "hello there", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
    )
    expect(replies).toEqual([7])
  })

  test("a message to the hosted session never records a reply, so a probe quoting an item takes nothing off his list", async () => {
    const replies: number[] = []
    const recordReply = async (ref: number) => {
      replies.push(ref)
    }
    const send = async () => ({ at: "now", ok: true as const, sessionId: "s-1" })
    const find = async () => null
    const sendHosted = async () => ({ at: "now", ok: true as const, sessionId: "s-2" })
    await sendMessage(
      { text: "re #i7: on it", to: SDK_PROBE },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
    )
    expect(replies).toEqual([])
  })

  // #i520: the Inbox stays on the primary's chat, so a quote typed to the second dispatcher takes nothing off his list
  test("a message to the second dispatcher never records a reply", async () => {
    const replies: number[] = []
    const recordReply = async (ref: number) => {
      replies.push(ref)
    }
    const send = async () => ({ at: "now", ok: true as const, sessionId: "s-3" })
    const sendHosted = async () => ({ at: "now", ok: true as const, sessionId: "s-2" })
    await sendMessage(
      { text: "re #i7: on it", to: DISPATCHER_SECONDARY },
      actor,
      send,
      async () => null,
      sendHosted,
      recordReply,
    )
    expect(replies).toEqual([])
  })

  test("the composer's id for the message reaches the delivery, so a retry is answered by its row", async () => {
    const deliveries: Delivery[] = []
    const send = async (delivery: Delivery) => {
      deliveries.push(delivery)
      return { at: "2026-10-06T12:00:00.000Z", ok: true as const, sessionId: "s-1" }
    }
    const id = "7d0c6a8e-1f2b-4c3d-9e4f-5a6b7c8d9e0f"
    await sendMessage({ id, text: "hi", to: DISPATCHER }, actor, send)
    await sendMessage({ text: "hi", to: DISPATCHER }, actor, send)
    expect(deliveries.map((d) => d.id)).toEqual([id, undefined])
  })

  test("every refusal becomes the API's error, with its reason and its code under delivery", async () => {
    const expected: Record<string, [number, string]> = {
      AMBIGUOUS: [409, "CONFLICT"],
      BUSY: [409, "CONFLICT"],
      COMMAND: [400, "VALIDATION_ERROR"],
      EMPTY: [400, "VALIDATION_ERROR"],
      INPUT_NOT_EMPTY: [409, "CONFLICT"],
      INTERRUPTED: [502, "SESSIONS_FAILED"],
      LOST: [409, "CONFLICT"],
      NOT_FOUND: [404, "NOT_FOUND"],
      ON_PICKER: [409, "CONFLICT"],
      QUEUED: [409, "CONFLICT"],
      SESSIONS_FAILED: [502, "SESSIONS_FAILED"],
      TOO_LONG: [400, "VALIDATION_ERROR"],
    }
    expect(Object.keys(expected)).toEqual([...DELIVERY_FAILURES])
    for (const code of DELIVERY_FAILURES) {
      const send = async () => ({ code, ok: false as const, reason: `because ${code}` })
      const error = await sendMessage({ text: "hi", to: DISPATCHER }, actor, send).catch(
        (thrown: { code: string; extra: unknown; message: string; status: number }) => thrown,
      )
      expect(error).toMatchObject({
        code: expected[code]![1],
        extra: { delivery: code },
        message: `because ${code}`,
        status: expected[code]![0],
      })
    }
  })
})

describe("sendMessage to a thread", () => {
  const actor = { email: "owner@local.host", id: "u-1" }
  const find = async () => null
  const recordReply = async () => {}
  const sendHosted = async () => ({ at: "now", ok: true as const, sessionId: "s-2" })

  const store = (exists: boolean) => {
    const created: string[] = []
    const dropped: string[] = []
    return {
      created,
      dropped,
      threads: {
        create: async (title: string) => {
          created.push(title)
          return "n3wt"
        },
        drop: async (id: string) => {
          dropped.push(id)
        },
        exists: async () => exists,
      },
    }
  }

  const sent = () => {
    const texts: string[] = []
    const send = async ({ text }: { text: string }) => {
      texts.push(text)
      return { at: "2026-10-23T10:00:00.000Z", ok: true as const, sessionId: "s-1" }
    }
    return { send, texts }
  }

  // the marker files the message once ingest brings it, with no wait on its opening words
  test("a message sent from a thread reaches the session with the thread's marker first, and names the thread", async () => {
    const { send, texts } = sent()
    const data = await sendMessage(
      { text: "  Ship it\nand tell me", threadId: "k7mq", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
      store(true).threads,
    )
    expect(texts).toEqual(["[thread:k7mq] Ship it\nand tell me"])
    expect(data).toEqual({ at: "2026-10-23T10:00:00.000Z", sessionId: "s-1", threadId: "k7mq" })
  })

  test("a message of files alone carries the marker before its files", async () => {
    const { send, texts } = sent()
    const png = "11111111-2222-4333-8444-555555555555.png"
    await sendMessage(
      { attachments: [png], text: "", threadId: "k7mq", to: DISPATCHER },
      actor,
      send,
      async () => ({ id: png, kind: "image" as const, path: `/files/${png}`, size: 10 }),
      sendHosted,
      recordReply,
      store(true).threads,
    )
    expect(texts).toEqual(["[thread:k7mq] "])
  })

  test("an empty message to a thread stays empty, for the delivery to refuse", async () => {
    const { send, texts } = sent()
    await sendMessage(
      { text: "  ", threadId: "k7mq", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
      store(true).threads,
    )
    expect(texts).toEqual(["  "])
  })

  test("newThread opens a thread titled from the first line and sends the message marked as its first", async () => {
    const { send, texts } = sent()
    const { created, threads } = store(false)
    const data = await sendMessage(
      { newThread: true, text: "Rename the sidebar\nto Threads", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
      threads,
    )
    expect(created).toEqual(["Rename the sidebar"])
    expect(texts).toEqual(["[thread:n3wt] Rename the sidebar\nto Threads"])
    expect(data.threadId).toBe("n3wt")
  })

  test("a new thread whose message was refused before typing is dropped, and one cut off while typing is kept and named for a retry", async () => {
    const refuse = (code: "INTERRUPTED" | "ON_PICKER") => async () => ({
      code,
      ok: false as const,
      reason: "no",
    })
    const { dropped, threads } = store(false)
    const errors: unknown[] = []
    for (const code of ["ON_PICKER", "INTERRUPTED"] as const) {
      await sendMessage(
        { newThread: true, text: "hi", to: DISPATCHER },
        actor,
        refuse(code),
        find,
        sendHosted,
        recordReply,
        threads,
      ).catch((error: { extra: unknown }) => errors.push(error.extra))
    }
    expect(dropped).toEqual(["n3wt"])
    expect(errors).toEqual([
      { delivery: "ON_PICKER" },
      { delivery: "INTERRUPTED", threadId: "n3wt" },
    ])
  })

  // a New thread message whose paste sits unsent waits for its retry's Enter, marker and all, so its thread stays and is named for that retry
  test("a new thread whose message was left pasted and unsent is kept and named for its retry", async () => {
    const { created, dropped, threads } = store(false)
    const held = async () => ({
      code: "INPUT_NOT_EMPTY" as const,
      ok: false as const,
      pasted: true as const,
      reason: "sits unsent",
    })
    const error = await sendMessage(
      { newThread: true, text: "hi", to: DISPATCHER },
      actor,
      held,
      find,
      sendHosted,
      recordReply,
      threads,
    ).catch((thrown: { extra: unknown }) => thrown.extra)
    expect(created).toEqual(["hi"])
    expect(dropped).toEqual([])
    expect(error).toEqual({ delivery: "INPUT_NOT_EMPTY", threadId: "n3wt" })
  })

  // a reviewer: a retry its first try delivered opened a second, empty thread
  test("a newThread retry answered from its first try's row drops the thread it opened and names none", async () => {
    const { created, dropped, threads } = store(false)
    const replay = async () => ({
      at: "2026-10-23T10:00:00.000Z",
      ok: true as const,
      replayed: true as const,
      sessionId: "s-1",
    })
    const data = await sendMessage(
      {
        id: "11111111-2222-4333-8444-555555555555",
        newThread: true,
        text: "Rename the sidebar",
        to: DISPATCHER,
      },
      actor,
      replay,
      find,
      sendHosted,
      recordReply,
      threads,
    )
    expect(created).toEqual(["Rename the sidebar"])
    expect(dropped).toEqual(["n3wt"])
    expect(data).toEqual({ at: "2026-10-23T10:00:00.000Z", sessionId: "s-1" })
  })

  // a reviewer: a skill command sent to a thread was typed as plain words behind the marker
  test("a / or ! command goes unmarked, so a skill still runs, and New thread opens no thread for it", async () => {
    const { send, texts } = sent()
    const { created, threads } = store(true)
    const data = await sendMessage(
      { text: "/linear today", threadId: "k7mq", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
      threads,
    )
    await sendMessage(
      { newThread: true, text: "  /linear", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
      threads,
    )
    expect(texts).toEqual(["/linear today", "  /linear"])
    expect(data.threadId).toBeUndefined()
    expect(created).toEqual([])
  })

  test("a message with no thread goes as typed", async () => {
    const { send, texts } = sent()
    const { created, threads } = store(true)
    await sendMessage(
      { text: "[thread:k7mq] hi", to: DISPATCHER },
      actor,
      send,
      find,
      sendHosted,
      recordReply,
      threads,
    )
    expect(texts).toEqual(["[thread:k7mq] hi"])
    expect(created).toEqual([])
  })

  test("a thread's message goes to the primary dispatcher alone, to a thread that exists, refused before anything is sent", async () => {
    let called = false
    const send = async () => {
      called = true
      return { at: "now", ok: true as const, sessionId: "s" }
    }
    const { created, threads } = store(true)
    const to = async (
      target: string,
      exists: boolean,
      thread: { newThread?: boolean; threadId?: string } = { threadId: "k7mq" },
    ) =>
      sendMessage(
        { text: "hi", ...thread, to: target },
        actor,
        send,
        find,
        sendHosted,
        recordReply,
        exists ? threads : store(false).threads,
      ).catch((error: { status: number }) => error)
    expect(await to(DISPATCHER_SECONDARY, true)).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })
    expect(await to(SDK_PROBE, true)).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
    expect(await to(DISPATCHER, false)).toMatchObject({ code: "NOT_FOUND", status: 404 })
    expect(await to(DISPATCHER_SECONDARY, true, { newThread: true })).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })
    expect(await to(DISPATCHER, true, { newThread: true, threadId: "k7mq" })).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    })
    expect(called).toBe(false)
    expect(created).toEqual([])
  })

  test("the quote is the first line as typed, tabs as spaces, up to a space before a path, at most 80 characters", () => {
    expect(quoteOf("  first line  \nsecond", 0)).toBe("first line")
    expect(quoteOf("a\tb", 0)).toBe("a    b")
    expect(quoteOf("x".repeat(100), 0)).toBe("x".repeat(80))
    // a paste Claude Code splits at a space before a path keeps only what comes before it on its first line
    expect(quoteOf("look at /tmp/shot.png now", 1)).toBe("look at")
    // an emoji is never cut in half
    expect(quoteOf(`${"x".repeat(79)}😀`, 0)).toBe(`${"x".repeat(79)}😀`)
    expect(quoteOf("", 0)).toBe("")
    expect(quoteOf("", 2)).toBe("Attached:")
  })
})

describe("sendMessage with attachments", () => {
  const actor = { email: "owner@local.host", id: "u-1" }
  const png = "11111111-2222-4333-8444-555555555555.png"
  const found = { id: png, kind: "image" as const, path: `/files/${png}`, size: 10 }

  test("each id is found in the attachments folder and handed to the delivery as its path and size", async () => {
    let delivered: unknown = null
    const send = async (delivery: unknown) => {
      delivered = delivery
      return { at: "now", ok: true as const, sessionId: "s-1" }
    }
    await sendMessage(
      { attachments: [png, png], text: "see", to: DISPATCHER },
      actor,
      send,
      async (id) => (id === png ? found : null),
    )
    expect(delivered).toEqual({ actor, attachments: [found], text: "see", to: DISPATCHER })
  })

  test("an id that finds nothing is NOT_FOUND, and nothing is delivered", async () => {
    let called = false
    const send = async () => {
      called = true
      return { at: "now", ok: true as const, sessionId: "s-1" }
    }
    const error = await sendMessage(
      { attachments: [png], text: "see", to: DISPATCHER },
      actor,
      send,
      async () => null,
    ).catch((thrown: { code: string; status: number }) => thrown)
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      extra: { attachment: "GONE", id: png },
      status: 404,
    })
    expect(called).toBe(false)
  })
})

describe("the attachment routes", () => {
  const handlersOf = (method: string, path: string) =>
    dashboardRouter.routes
      .filter((r) => r.method === method && r.path === path)
      .map((r) => r.handler)

  test("an upload passes its limiter, its body limit and its form check, behind the router's guards", () => {
    const upload = handlersOf("POST", "/attachments")
    expect(upload).toContain(attachmentLimiter)
    expect(upload).toContain(uploadBodyLimit)
    expect(upload).toContain(uploadForm)
    expect(upload.indexOf(attachmentLimiter)).toBeLessThan(upload.indexOf(uploadBodyLimit))
    expect(upload.indexOf(uploadBodyLimit)).toBeLessThan(upload.indexOf(uploadForm))
    expect(handlersOf("GET", "/attachments/:id").length).toBeGreaterThan(0)
  })

  const uploads = () =>
    new Hono()
      .onError(errorHandler)
      .post("/", uploadBodyLimit, uploadForm, (c) =>
        c.json({ name: c.req.valid("form").file.name }),
      )

  test("a body larger than a file and its form is cut off as TOO_LARGE before it is read", async () => {
    const form = new FormData()
    form.append("file", new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 128 * 1024)], "big.txt"))
    const response = await uploads().request("/", { body: form, method: "POST" })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { attachment: "TOO_LARGE", code: "PAYLOAD_TOO_LARGE" },
    })
  })

  test("anything but one file in the form field file is a validation error", async () => {
    const other = new FormData()
    other.append("upload", new File(["x"], "a.txt"))
    const text = new FormData()
    text.append("file", "not a file")
    for (const body of [other, text]) {
      expect((await uploads().request("/", { body, method: "POST" })).status).toBe(400)
    }
    const json = await uploads().request("/", {
      body: JSON.stringify({ file: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(json.status).toBe(400)
    const good = new FormData()
    good.append("file", new File(["x"], "a.txt"))
    expect(await (await uploads().request("/", { body: good, method: "POST" })).json()).toEqual({
      name: "a.txt",
    })
  })

  test("an image is served inline and anything else as a download, never sniffed and never run", () => {
    const file = (id: string, kind: "image" | "pdf" | "text") => ({
      id,
      kind,
      path: `/f/${id}`,
      size: 1,
    })
    const common = {
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    }
    expect(servedHeaders(file("a.png", "image"))).toEqual({
      ...common,
      "content-disposition": "inline",
      "content-type": "image/png",
    })
    expect(servedHeaders(file("a.pdf", "pdf"))).toEqual({
      ...common,
      "content-disposition": "attachment",
      "content-type": "application/pdf",
    })
    for (const id of ["a.html", "a.txt", "a.md"]) {
      expect(servedHeaders(file(id, "text"))).toEqual({
        ...common,
        "content-disposition": "attachment",
        "content-type": "text/plain; charset=utf-8",
      })
    }
  })

  test("serveAttachment gives the file's bytes with those headers, and a 404 once it is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-serve-"))
    try {
      const stored = await storeAttachment(new TextEncoder().encode("<b>hi</b>"), "a.html", { dir })
      if (!stored.ok) throw new Error("not stored")
      const response = await serveAttachment(stored.id, (id) => readAttachment(id, dir))
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(response.headers.get("content-disposition")).toBe("attachment")
      expect(await response.text()).toBe("<b>hi</b>")
      const gone = await serveAttachment("11111111-2222-4333-8444-555555555555.png", (id) =>
        readAttachment(id, dir),
      ).catch((thrown: { status: number }) => thrown)
      expect(gone).toMatchObject({ status: 404 })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("with download, a kept file saves under the name it gives for the stored file, and an id outside the folder is a 404 that asks for no name (#783)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-serve-download-"))
    try {
      const stored = await storeAttachment(PNG, "shot.png", { dir })
      if (!stored.ok) throw new Error("not stored")
      const asked: string[] = []
      const download = async (id: string) => {
        asked.push(id)
        return "Weekly plan, updated draft.png"
      }
      const read = (id: string) => readAttachment(id, dir)
      const response = await serveAttachment(stored.id, read, download)
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename=\"Weekly plan, updated draft.png\"; filename*=UTF-8''Weekly%20plan%2C%20updated%20draft.png",
      )
      expect(response.headers.get("content-type")).toBe("image/png")
      expect(asked).toEqual([stored.id])
      for (const id of [`../${stored.id}`, "../../etc/passwd", `${dir}/${stored.id}`]) {
        const gone = await serveAttachment(id, read, download).catch(
          (thrown: { status: number }) => thrown,
        )
        expect(gone).toMatchObject({ status: 404 })
      }
      expect(asked).toEqual([stored.id])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("uploadAttachment", () => {
  test("a stored file comes back as its id, kind and size", async () => {
    const file = new File(["hello"], "a.txt")
    const stored = await uploadAttachment(file, async () => ({
      id: "11111111-2222-4333-8444-555555555555.txt",
      kind: "text",
      ok: true,
      size: 5,
    }))
    expect(stored).toEqual({
      id: "11111111-2222-4333-8444-555555555555.txt",
      kind: "text",
      size: 5,
    })
  })

  test("every refusal becomes the API's error, with its reason and its code under attachment", async () => {
    const expected: Record<string, [number, string]> = {
      EMPTY: [400, "VALIDATION_ERROR"],
      FULL: [507, "INSUFFICIENT_STORAGE"],
      TOO_LARGE: [413, "PAYLOAD_TOO_LARGE"],
      UNSUPPORTED: [415, "UNSUPPORTED_MEDIA_TYPE"],
    }
    for (const [code, [status, apiCode]] of Object.entries(expected)) {
      const error = await uploadAttachment(new File(["x"], "x"), async () => ({
        code: code as "EMPTY",
        ok: false,
        reason: `because ${code}`,
      })).catch(
        (thrown: { code: string; extra: unknown; message: string; status: number }) => thrown,
      )
      expect(error).toMatchObject({
        code: apiCode,
        extra: { attachment: code },
        message: `because ${code}`,
        status,
      })
    }
  })
})

describe("attachmentLimiter", () => {
  test("lets one person upload 30 files a minute and refuses the 31st", async () => {
    const app = new Hono<{ Variables: { session: { userId: string } } }>()
      .use("*", async (c, next) => {
        c.set("session", { userId: "u-upload-limit" })
        await next()
      })
      .use("*", attachmentLimiter)
      .post("/", (c) => c.text("ok"))
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await app.request("/", { method: "POST" })).status)
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe("messageLimiter", () => {
  test("lets one person send 20 messages a minute and refuses the 21st", async () => {
    const app = new Hono<{ Variables: { session: { userId: string } } }>()
      .use("*", async (c, next) => {
        c.set("session", { userId: "u-limit" })
        await next()
      })
      .use("*", messageLimiter)
      .post("/", (c) => c.text("ok"))
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) statuses.push((await app.request("/", { method: "POST" })).status)
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true)
    expect(statuses[20]).toBe(429)
  })
})

describe("the mode route", () => {
  const handlersOf = (method: string, path: string) =>
    dashboardRouter.routes
      .filter((r) => r.method === method && r.path === path)
      .map((r) => r.handler)

  test("changing a hosted session's mode is a write: it needs the dashboard's origin, a loopback connection and a session, in that order", async () => {
    const path = "/workers/s-1/mode"
    const body = { mode: "bypassPermissions" }
    expect((await post(path, {}, body, from("127.0.0.1"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("192.168.1.20"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("127.0.0.1"))).status).toBe(401)
  })

  test("it passes its own limiter and takes only the four modes the picker offers", () => {
    expect(handlersOf("POST", "/workers/:sessionId/mode")).toContain(modeLimiter)
    for (const mode of ["acceptEdits", "bypassPermissions", "default", "plan"]) {
      expect(modeSchema.safeParse({ mode }).success).toBe(true)
    }
    for (const mode of ["auto", "dontAsk", "", "PLAN"]) {
      expect(modeSchema.safeParse({ mode }).success).toBe(false)
    }
  })

  test("with approvals off a switch to bypass is refused as FORBIDDEN, naming DISABLED; every other refusal keeps its code under mode", async () => {
    const input = {
      actor: { email: "owner@local.host", id: "u-1" },
      approver: { role: "owner" },
      mode: "bypassPermissions" as const,
      sessionId: "s-1",
    }
    const host = new SdkHost()
    const off = await changeMode(input, (changing) =>
      changeHostedMode(changing, {
        approvals: false,
        host,
        now: () => new Date(),
        record: async () => {},
      }),
    ).catch((thrown) => thrown)
    expect(off).toMatchObject({ code: "FORBIDDEN", extra: { mode: "DISABLED" }, status: 403 })
    // the route's own wiring reads PLAYGROUND_APPROVALS_ENABLED: off (as by default), it refuses before it looks for a session; on, it finds no session hosted here
    const wired = await changeMode(input).catch((thrown) => thrown)
    expect(wired).toMatchObject(
      env.PLAYGROUND_APPROVALS_ENABLED
        ? { code: "NOT_FOUND", extra: { mode: "NOT_FOUND" }, status: 404 }
        : { code: "FORBIDDEN", extra: { mode: "DISABLED" }, status: 403 },
    )
    const expected: Record<string, [number, string]> = {
      DISABLED: [403, "FORBIDDEN"],
      FORBIDDEN: [403, "FORBIDDEN"],
      NOT_FOUND: [404, "NOT_FOUND"],
    }
    for (const [code, [status, apiCode]] of Object.entries(expected)) {
      const error = await changeMode(input, async () => ({
        code: code as "DISABLED",
        ok: false as const,
        reason: `because ${code}`,
      })).catch((thrown) => thrown)
      expect(error).toMatchObject({ code: apiCode, extra: { mode: code }, status })
    }
    expect(
      await changeMode(input, async () => ({
        at: "2026-10-08T17:00:00.000Z",
        mode: "plan",
        ok: true,
      })),
    ).toEqual({ at: "2026-10-08T17:00:00.000Z", mode: "plan" })
  })
})

describe("the setting route", () => {
  const handlersOf = (method: string, path: string) =>
    dashboardRouter.routes
      .filter((r) => r.method === method && r.path === path)
      .map((r) => r.handler)
  const actor = { email: "owner@local.host", id: "u-1" }
  const board =
    (workers: { assistant?: true; hosted?: true; name: string; sessionId: string }[]) => async () =>
      ({ workers }) as never
  const ok = (sessionId: string) => async () => ({
    at: "2026-11-03T06:00:00.000Z",
    ok: true as const,
    sessionId,
  })

  test("setting a model or effort is a write: it needs the dashboard's origin, a loopback connection and a session, in that order", async () => {
    const path = "/workers/s-1/setting"
    const body = { model: "opus" }
    expect((await post(path, {}, body, from("127.0.0.1"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("192.168.1.20"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("127.0.0.1"))).status).toBe(401)
    expect(handlersOf("POST", "/workers/:sessionId/setting")).toContain(settingLimiter)
  })

  test("a dispatcher's setting goes through deliver() as the setting alone, and the hosted session's to changeHostedSetting() by its id", async () => {
    const sent: { via: string; delivery: unknown }[] = []
    const live = board([
      { name: DISPATCHER, sessionId: "s-d" },
      { name: DISPATCHER_SECONDARY, sessionId: "s-d2" },
      { hosted: true, name: SDK_PROBE, sessionId: "s-h" },
    ])
    const send = (via: string) => async (delivery: Delivery | SettingChanging) => {
      sent.push({ delivery, via })
      return ok("sessionId" in delivery ? delivery.sessionId : "s-d")()
    }
    await changeSetting(
      { sessionId: "s-d", setting: { model: "sonnet" } },
      actor,
      live,
      send("deliver"),
      send("hosted"),
    )
    await changeSetting(
      { sessionId: "s-d2", setting: { effort: "low" } },
      actor,
      live,
      send("deliver"),
      send("hosted"),
    )
    await changeSetting(
      { sessionId: "s-h", setting: { effort: "max" } },
      actor,
      live,
      send("deliver"),
      send("hosted"),
    )
    expect(sent).toEqual([
      {
        delivery: { actor, setting: { model: "sonnet" }, text: "", to: DISPATCHER },
        via: "deliver",
      },
      {
        delivery: { actor, setting: { effort: "low" }, text: "", to: DISPATCHER_SECONDARY },
        via: "deliver",
      },
      { delivery: { actor, sessionId: "s-h", setting: { effort: "max" } }, via: "hosted" },
    ])
  })

  test("the assistant's setting goes through deliver() as the setting alone, as a dispatcher's does", async () => {
    const sent: unknown[] = []
    await changeSetting(
      { sessionId: "s-a", setting: { model: "sonnet" } },
      actor,
      board([{ assistant: true, name: "errands", sessionId: "s-a" }]),
      async (delivery) => {
        sent.push(delivery)
        return ok("s-a")()
      },
    )
    expect(sent).toEqual([{ actor, setting: { model: "sonnet" }, text: "", to: "errands" }])
  })

  test("a dispatcher's setting carries the composer's id to deliver(), and one Claude Code holds reads QUEUED under delivery", async () => {
    const sent: unknown[] = []
    const id = "11111111-2222-4333-8444-555555555555"
    const held = await changeSetting(
      { id, sessionId: "s-d", setting: { model: "opus" } },
      actor,
      board([{ name: DISPATCHER, sessionId: "s-d" }]),
      async (delivery) => {
        sent.push(delivery)
        return { code: "QUEUED", ok: false, pasted: true, reason: "holds it" }
      },
    ).catch((thrown) => thrown)
    expect(sent).toEqual([{ actor, id, setting: { model: "opus" }, text: "", to: DISPATCHER }])
    expect(held).toMatchObject({ extra: { delivery: "QUEUED" }, status: 409 })
  })

  test("a local model goes to the hosted session alone: a dispatcher or the assistant gets FORBIDDEN, with nothing typed", async () => {
    const sent: { via: string; delivery: unknown }[] = []
    const send = (via: string) => async (delivery: Delivery | SettingChanging) => {
      sent.push({ delivery, via })
      return ok("s-h")()
    }
    const live = board([
      { name: DISPATCHER, sessionId: "s-d" },
      { assistant: true, name: "errands", sessionId: "s-a" },
      { hosted: true, name: SDK_PROBE, sessionId: "s-h" },
    ])
    const setting = { local: "ornith-1.5-122b-nvfp4" }
    for (const sessionId of ["s-d", "s-a"]) {
      const refused = await changeSetting(
        { sessionId, setting },
        actor,
        live,
        send("deliver"),
        send("hosted"),
      ).catch((thrown) => thrown)
      expect(refused).toMatchObject({ code: "FORBIDDEN", status: 403 })
    }
    expect(sent).toEqual([])
    await changeSetting({ sessionId: "s-h", setting }, actor, live, send("deliver"), send("hosted"))
    expect(sent).toEqual([{ delivery: { actor, sessionId: "s-h", setting }, via: "hosted" }])
  })

  test("any other session is FORBIDDEN and an unknown one NOT_FOUND, before anything is sent; a delivery's refusal keeps its code under delivery", async () => {
    let sends = 0
    const send = async () => {
      sends++
      return ok("s-d")()
    }
    const live = board([
      { name: DISPATCHER, sessionId: "s-d" },
      { name: "k3m9px-worker", sessionId: "s-w" },
    ])
    const worker = await changeSetting(
      { sessionId: "s-w", setting: { model: "opus" } },
      actor,
      live,
      send,
      send,
    ).catch((thrown) => thrown)
    expect(worker).toMatchObject({ code: "FORBIDDEN", status: 403 })
    const gone = await changeSetting(
      { sessionId: "s-x", setting: { model: "opus" } },
      actor,
      live,
      send,
      send,
    ).catch((thrown) => thrown)
    expect(gone).toMatchObject({ code: "NOT_FOUND", status: 404 })
    expect(sends).toBe(0)
    const busy = await changeSetting(
      { sessionId: "s-d", setting: { model: "opus" } },
      actor,
      live,
      async () => ({ code: "ON_PICKER", ok: false, reason: "waiting on a card" }),
      send,
    ).catch((thrown) => thrown)
    expect(busy).toMatchObject({ extra: { delivery: "ON_PICKER" } })
  })
})

describe("settingLimiter", () => {
  test("lets one person set 10 a minute and refuses the 11th", async () => {
    const app = new Hono<{ Variables: { session: { userId: string } } }>()
      .use("*", async (c, next) => {
        c.set("session", { userId: "u-setting-limit" })
        await next()
      })
      .use("*", settingLimiter)
      .post("/", (c) => c.text("ok"))
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await app.request("/", { method: "POST" })).status)
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

describe("modeLimiter", () => {
  test("lets one person change modes 10 times a minute and refuses the 11th", async () => {
    const app = new Hono<{ Variables: { session: { userId: string } } }>()
      .use("*", async (c, next) => {
        c.set("session", { userId: "u-mode-limit" })
        await next()
      })
      .use("*", modeLimiter)
      .post("/", (c) => c.text("ok"))
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await app.request("/", { method: "POST" })).status)
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

describe("the managers order routes", () => {
  const handlersOf = (method: string, path: string) =>
    dashboardRouter.routes
      .filter((r) => r.method === method && r.path === path)
      .map((r) => r.handler)

  test("saving and clearing the order are writes: they need the dashboard's origin, a loopback connection and a session, in that order", async () => {
    const path = "/managers/order"
    const body = { names: ["builder"] }
    expect((await post(path, {}, body, from("127.0.0.1"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("192.168.1.20"))).status).toBe(403)
    expect((await post(path, { origin: trusted() }, body, from("127.0.0.1"))).status).toBe(401)
    const clear = (headers: Record<string, string>, address: string) =>
      dashboardRouter.request(
        `http://127.0.0.1${path}`,
        { headers, method: "DELETE" },
        from(address),
      )
    expect((await clear({}, "127.0.0.1")).status).toBe(403)
    expect((await clear({ origin: trusted() }, "192.168.1.20")).status).toBe(403)
    expect((await clear({ origin: trusted() }, "127.0.0.1")).status).toBe(401)
  })

  test("both pass the limiter", () => {
    expect(handlersOf("POST", "/managers/order")).toContain(managersOrderLimiter)
    expect(handlersOf("DELETE", "/managers/order")).toContain(managersOrderLimiter)
  })

  test("the limiter lets one person save 30 times a minute and refuses the 31st", async () => {
    const app = new Hono<{ Variables: { session: { userId: string } } }>()
      .use("*", async (c, next) => {
        c.set("session", { userId: "u-managers-limit" })
        await next()
      })
      .use("*", managersOrderLimiter)
      .post("/", (c) => c.text("ok"))
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await app.request("/", { method: "POST" })).status)
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe("the paste report route (PG-1015)", () => {
  test("passes its limiter, its body limit and its shape check, behind the router's guards", () => {
    const route = dashboardRouter.routes
      .filter((r) => r.method === "POST" && r.path === "/debug/paste")
      .map((r) => r.handler)
    expect(route.indexOf(pasteReportLimiter)).toBeGreaterThanOrEqual(0)
    expect(route.indexOf(pasteReportLimiter)).toBeLessThan(route.indexOf(pasteReportBodyLimit))
    expect(route.indexOf(pasteReportBodyLimit)).toBeLessThan(route.indexOf(pasteReportBody))
  })

  const send = (body: string) =>
    new Hono()
      .onError(errorHandler)
      .post("/", pasteReportBodyLimit, pasteReportBody, (c) =>
        c.json({ entries: c.req.valid("json").entries.length }),
      )
      .request("/", { body, headers: { "content-type": "application/json" }, method: "POST" })

  test("a body over 128 KB is cut off before it is read", async () => {
    const response = await send(JSON.stringify({ entries: [], pad: "x".repeat(129 * 1024) }))
    expect(response.status).toBe(413)
  })

  test("a body that is not a paste log is a validation error", async () => {
    expect(
      (await send(JSON.stringify({ entries: [{ text: "words" }], miss: "no-paste" }))).status,
    ).toBe(400)
  })

  test("lets one person report 6 misses a minute and refuses the 7th", async () => {
    const app = new Hono<{ Variables: { session: { userId: string } } }>()
      .use("*", async (c, next) => {
        c.set("session", { userId: "u-paste-limit" })
        await next()
      })
      .use("*", pasteReportLimiter)
      .post("/", (c) => c.text("ok"))
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await app.request("/", { method: "POST" })).status)
    expect(statuses.slice(0, 6).every((status) => status === 200)).toBe(true)
    expect(statuses[6]).toBe(429)
  })
})

describe("a composer message refuses the agent sign-in off a fixture stack", () => {
  test("POST /messages carries refuseAgentOffFixture", () => {
    const handlers = dashboardRouter.routes
      .filter((r) => r.method === "POST" && r.path === "/messages")
      .map((r) => r.handler)
    expect(handlers).toContain(refuseAgentOffFixture)
  })
})
