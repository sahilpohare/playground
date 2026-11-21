// A stand-in for a local model's server on 127.0.0.1 alone, for tests and a fixture stack's drive, so nothing reaches the tunnel or a model: bun tests/local-model-stub.ts <model-id> [port] [--silent-models] [--down-for <seconds>], printing its port on its first line. GET /v1/models lists the id; POST /v1/messages streams one short reply in the Messages API's shape, and stderr says whether the request carried the hosted session's placeholder token (never the token itself). --silent-models holds /v1/models unanswered, as a server that hangs does; --down-for answers it 503 for that many seconds from the start, as a server still loading its model does.
const [id = "stub-model", port = "0", ...flags] = process.argv.slice(2)
const silent = flags.includes("--silent-models")
const downFor = Number(flags[flags.indexOf("--down-for") + 1] ?? 0)
const upAt = flags.includes("--down-for") ? Date.now() + downFor * 1000 : 0

const sse = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

const reply = (model: string) =>
  [
    sse("message_start", {
      message: {
        content: [],
        id: "msg_stub",
        model,
        role: "assistant",
        stop_reason: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    sse("content_block_start", { content_block: { text: "", type: "text" }, index: 0 }),
    sse("content_block_delta", {
      delta: { text: "Hello from the stub model.", type: "text_delta" },
      index: 0,
    }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } }),
    sse("message_stop", {}),
  ].join("")

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(port),
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" && pathname === "/v1/models") {
      if (silent) return new Promise<Response>(() => {})
      if (Date.now() < upAt) return new Response("loading", { status: 503 })
      return Response.json({ data: [{ id, object: "model" }], object: "list" })
    }
    if (request.method === "POST" && pathname === "/v1/messages") {
      const auth = request.headers.get("authorization") ?? request.headers.get("x-api-key") ?? ""
      console.error(
        `messages: ${auth.endsWith("playground-local") ? "placeholder token" : "another token"}`,
      )
      return new Response(reply(id), { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  },
})

console.log(server.port)
