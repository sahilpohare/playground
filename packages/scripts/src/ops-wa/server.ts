import { chmodSync, existsSync } from "node:fs"
import { join } from "node:path"

// The one way into ops-wa: a unix socket in its own folder, mode 600, one JSON line each way ({body} in, {sent} or {refusal} out); it listens on no port.
export const socketPath = (data: string) => join(data, "whatsapp", "wa.sock")

type Reply = { refusal?: string; sent?: true }

export function serve(path: string, send: (body: string) => Promise<string>) {
  const server = Bun.listen<{ done: boolean; text: string }>({
    socket: {
      data: (socket, chunk) => {
        // one request per connection: bytes after its line never send again
        if (socket.data.done) return
        socket.data.text += chunk.toString()
        if (!socket.data.text.includes("\n")) return
        socket.data.done = true
        const answer = (reply: Reply) => {
          socket.write(`${JSON.stringify(reply)}\n`)
          socket.end()
        }
        let body: unknown
        try {
          body = (JSON.parse(socket.data.text) as { body?: unknown }).body
        } catch {}
        if (typeof body !== "string" || !body.trim()) return answer({ refusal: "an empty body" })
        send(body).then(
          () => answer({ sent: true }),
          (error: Error) => answer({ refusal: error.message }),
        )
      },
      open: (socket) => {
        socket.data = { done: false, text: "" }
      },
    },
    unix: path,
  })
  chmodSync(path, 0o600)
  return server
}

// wa send's side: the body to ops-wa and its one-line answer, or why ops-wa did not answer.
export async function request(path: string, body: string, timeoutMs = 600_000): Promise<Reply> {
  if (!existsSync(path)) return { refusal: "ops-wa is not running: its job is off or stopped" }
  const answered = Promise.withResolvers<Reply>()
  const resolve = (reply: Reply) => {
    clearTimeout(timer)
    answered.resolve(reply)
  }
  let text = ""
  const timer = setTimeout(
    () => resolve({ refusal: "ops-wa did not answer in 10 minutes" }),
    timeoutMs,
  )
  await Bun.connect({
    socket: {
      close: () => {
        try {
          resolve(JSON.parse(text) as Reply)
        } catch {
          resolve({ refusal: "ops-wa closed the socket without an answer" })
        }
      },
      data: (_, chunk) => {
        text += chunk.toString()
      },
      error: () => resolve({ refusal: "ops-wa's socket did not answer" }),
      open: (socket) => {
        socket.write(`${JSON.stringify({ body })}\n`)
      },
    },
    unix: path,
  }).catch(() => resolve({ refusal: "ops-wa is not running: its socket refuses the connect" }))
  return answered.promise
}
