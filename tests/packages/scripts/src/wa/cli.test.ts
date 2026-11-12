import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { serve, socketPath } from "../../../../../packages/scripts/src/ops-wa/server"

const CLI = join(import.meta.dir, "../../../../../packages/scripts/src/wa/cli.ts")
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// A data folder of its own, under /tmp so its socket's path stays inside the 104 bytes macOS takes, with a body file holding the text given.
const machine = (text: string) => {
  const data = mkdtempSync("/tmp/wa-cli-")
  dirs.push(data)
  mkdirSync(join(data, "whatsapp"), { mode: 0o700 })
  const body = join(data, "body.md")
  writeFileSync(body, text)
  return { body, data }
}

const wa = async (data: string, args: string[]) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
    env: { ...process.env, PLAYGROUND_DATA_DIR: data },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, out: (out + err).trim() }
}

describe("ops-wa's socket", () => {
  test("sends one connection's body once, whatever bytes follow its line", async () => {
    const { data } = machine("")
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      return "sent"
    })
    try {
      const answer = Promise.withResolvers<string>()
      let text = ""
      const socket = await Bun.connect({
        socket: {
          close: () => answer.resolve(text),
          data: (_, chunk) => void (text += chunk.toString()),
        },
        unix: socketPath(data),
      })
      socket.write('{"body":"first"}\n')
      await Bun.sleep(5)
      socket.write('{"body":"second"}\n')
      expect(await answer.promise).toBe('{"sent":true}\n')
      expect(got).toEqual(["first"])
    } finally {
      server.stop(true)
    }
  })
})

describe("playground wa send", () => {
  test("takes a body by its absolute path alone", async () => {
    const { data } = machine("hi")
    const { code, out } = await wa(data, ["send", "body.md"])
    expect(code).toBe(2)
    expect(out).toStartWith("usage: playground wa send <file>")
  })

  test("refuses a token-shaped body before it reaches ops-wa", async () => {
    const { body, data } = machine(`the key is xoxb-${"1".repeat(12)}-made-up`)
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      return "sent"
    })
    try {
      expect(await wa(data, ["send", body])).toEqual({
        code: 1,
        out: "wa send: the body holds a Slack token, which never goes over WhatsApp",
      })
      expect(got).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("says so when ops-wa is not running", async () => {
    const { body, data } = machine("hi")
    const { code, out } = await wa(data, ["send", body])
    expect(code).toBe(1)
    expect(out).toStartWith("wa send: ops-wa is not running")
  })

  test("hands the body to ops-wa's socket, mode 600, and prints its answer", async () => {
    const { body, data } = machine("all green\n")
    const got: string[] = []
    const server = serve(socketPath(data), async (b) => {
      got.push(b)
      if (got.length > 1) throw new Error("the hourly cap of 60 sends is reached until 04:00Z")
      return "sent"
    })
    try {
      expect(statSync(socketPath(data)).mode & 0o777).toBe(0o600)
      expect(await wa(data, ["send", body])).toEqual({ code: 0, out: "wa send: sent" })
      expect(got).toEqual(["all green"])
      expect(await wa(data, ["send", body])).toEqual({
        code: 1,
        out: "wa send: the hourly cap of 60 sends is reached until 04:00Z",
      })
    } finally {
      server.stop(true)
    }
  })
})
