import { existsSync } from "node:fs"

import { listening } from "@/lib/dev/proxy"
import { settledWithin } from "@/lib/settle"

// The machine onboarding's checks read: a tool on PATH, a fixed path's presence, a loopback port taking a connection, and a fixed argv's answer within 5 seconds. checks.ts names the tools and builds every argv; this file names none, so every command it runs is one checks.ts built.

export type Reader = {
  exists: (path: string) => boolean
  has: (tool: string) => boolean
  listens: (port: number) => Promise<boolean>
  run: (argv: string[]) => Promise<{ code: number; stdout: string }>
}

const TIMEOUT_MS = 5000

export const machine: Reader = {
  exists: (path) => existsSync(path),
  has: (tool) => Bun.which(tool) !== null,
  listens: (port) => listening(port),
  run: async (argv) => {
    const child = Bun.spawn(argv, {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "pipe",
      timeout: TIMEOUT_MS,
    })
    const settled = await settledWithin(
      Promise.all([new Response(child.stdout).text(), child.exited]),
      TIMEOUT_MS + 1000,
    )
    return settled ? { code: settled[1], stdout: settled[0] } : { code: 1, stdout: "" }
  },
}

// One JSON-RPC answer from a fixed argv that speaks it over stdio, as Codex's app-server does: the lines written in order, then the first stdout line whose id is id, read within 5 seconds; null for none. The child is ended by its own handle once it answers.
export const askOnce = async (argv: string[], lines: string[], id: number): Promise<unknown> => {
  const child = Bun.spawn(argv, {
    stderr: "ignore",
    stdin: "pipe",
    stdout: "pipe",
    timeout: TIMEOUT_MS,
  })
  for (const line of lines) child.stdin.write(`${line}\n`)
  await child.stdin.flush()
  const answer = async () => {
    const decoder = new TextDecoder()
    let text = ""
    for await (const chunk of child.stdout) {
      const parts = (text + decoder.decode(chunk, { stream: true })).split("\n")
      text = parts.pop() ?? ""
      for (const line of parts) {
        const read = (() => {
          try {
            return JSON.parse(line) as { id?: unknown }
          } catch {
            return null
          }
        })()
        if (read?.id === id) return read
      }
    }
    return null
  }
  const read = await settledWithin(answer(), TIMEOUT_MS + 1000)
  child.kill()
  return read ?? null
}
