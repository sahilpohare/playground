// Runs this machine's claude at each local effort, with the variables spawn.sh's local launch sets, against a loopback stub of the messages route, and prints the `thinking` field each request carried: no login, no model, a scratch HOME.
import { join } from "node:path"

import { makeScratch, removeScratch } from "@packages/safe-delete"

const SPAWN = join(import.meta.dir, "../../../scripts/spawn.sh")
const LEVELS = ["low", "medium", "high"] as const

// The VAR=value pairs spawn.sh's local case gives a level, with $LOCAL_SERVED read as the served name, local.
export const thinkingEnv = (spawn: string, level: string): Record<string, string> => {
  const line = spawn
    .split("\n")
    .find((row) => row.trim().startsWith(`${level === "high" ? "*" : level}) THINKING=`))
  if (!line) throw new Error(`spawn.sh has no THINKING line for ${level}`)
  const value = (/THINKING="(.*)" ;;/.exec(line)?.[1] ?? "").replaceAll('\\"', '"')
  const words = value.slice(value.indexOf(";") + 1)
  return Object.fromEntries(
    words
      .replaceAll("$LOCAL_SERVED", "local")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((pair) => [
        pair.slice(0, pair.indexOf("=")),
        pair.slice(pair.indexOf("=") + 1).replace(/^'(.*)'$/, "$1"),
      ]),
  )
}

const sse = (events: object[]) =>
  events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("")

const MESSAGE = {
  content: [],
  id: "msg_stub",
  model: "local",
  role: "assistant",
  stop_reason: null,
  stop_sequence: null,
  type: "message",
  usage: { input_tokens: 1, output_tokens: 1 },
}

const REPLY = sse([
  { message: MESSAGE, type: "message_start" },
  { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
  { delta: { text: "ok", type: "text_delta" }, index: 0, type: "content_block_delta" },
  { index: 0, type: "content_block_stop" },
  {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    type: "message_delta",
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
])

// The shell's environment with nothing that could move claude off the stub or onto a login: every ANTHROPIC_ and Claude Code variable dropped, as parity's replayEnv drops them.
const shellEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("ANTHROPIC_") &&
        !/^CLAUDE_CODE_/.test(key) &&
        !["CLAUDECODE", "CLAUDE_CONFIG_DIR"].includes(key),
    ),
  ) as Record<string, string>

// One level's run: every messages request claude sent, as its model and thinking field (absent when it sent none).
export const runLevel = async (level: string, env: Record<string, string>) => {
  const seen: { model: unknown; thinking: unknown }[] = []
  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST") return new Response("{}", { status: 404 })
      const body = (await request.json()) as Record<string, unknown>
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 })
      if (!url.pathname.endsWith("/v1/messages")) return new Response("{}", { status: 404 })
      seen.push({ model: body.model, thinking: "thinking" in body ? body.thinking : "absent" })
      if (body.stream)
        return new Response(REPLY, { headers: { "content-type": "text/event-stream" } })
      return Response.json({
        ...MESSAGE,
        content: [{ text: "ok", type: "text" }],
        stop_reason: "end_turn",
      })
    },
    hostname: "127.0.0.1",
    port: 0,
  })
  const home = makeScratch("local-thinking-")
  const run = Bun.spawn(["claude", "-p", "say ok", "--model", "local", "--effort", level], {
    cwd: home,
    env: {
      ...shellEnv(),
      ANTHROPIC_AUTH_TOKEN: "local",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "local",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "local",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "local",
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ENABLE_TOOL_SEARCH: "true",
      HOME: home,
      ...env,
    },
    stderr: "ignore",
    stdout: "ignore",
  })
  const timer = setTimeout(() => run.kill(), 90_000)
  const code = await run.exited
  clearTimeout(timer)
  server.stop(true)
  const refused = removeScratch(home)
  if (refused) console.error(`local-thinking-check: ${refused}`)
  return { code, env, level, requests: seen }
}

if (import.meta.main) {
  const spawn = await Bun.file(SPAWN).text()
  const levels = process.argv.slice(2).length ? process.argv.slice(2) : [...LEVELS]
  for (const level of levels)
    console.log(JSON.stringify(await runLevel(level, thinkingEnv(spawn, level))))
}
