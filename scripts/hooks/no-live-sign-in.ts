// PreToolUse hook on Bash, acting for a factory session alone (role.ts): refuses a call naming the owner sign-in, first run's finish or the agent sign-in together with the live dashboard's host, since each of them mints a session holding the owner rung there. The live host is a bare name (playground.localhost, api.playground.localhost), every name portless's route file gives the bare names' ports, and a loopback address on one of those ports. A worktree's own stack, by its own name or port, passes.
import { join } from "node:path"

import { portlessDir } from "../../api/hono/src/lib/dev/proxy"
import { input } from "./input"
import { fromFactory } from "./role"

type Environment = Record<string, string | undefined>

const SIGN_IN = /\/api\/(?:v1\/onboard\/(?:sign-in|finish)|agents\/sign-in-as)\b/
const BARE = ["api.playground.localhost", "playground.localhost"]
const LOOPBACK = /(?<![\w.-])(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|0\.0\.0\.0):(\d+)/g

// The live stack's names and ports: the bare names, every name on a bare name's port, and those ports, from portless's route file; with no file to read, the bare names alone.
async function liveOf(
  environment: Environment,
): Promise<{ hosts: Set<string>; ports: Set<number> }> {
  const hosts = new Set(BARE)
  const ports = new Set<number>()
  try {
    const routes = (await Bun.file(join(portlessDir(environment), "routes.json")).json()) as {
      hostname?: unknown
      port?: unknown
    }[]
    for (const { hostname, port } of routes)
      if (typeof port === "number" && BARE.includes(String(hostname))) ports.add(port)
    for (const { hostname, port } of routes)
      if (typeof hostname === "string" && typeof port === "number" && ports.has(port))
        hosts.add(hostname)
  } catch {}
  return { hosts, ports }
}

const names = (text: string, host: string) =>
  new RegExp(`(?<![\\w.-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text)

export async function check(
  raw: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
      tool_input?: { command?: unknown }
      tool_name?: unknown
    }
    if (tool !== "Bash" || typeof toolInput?.command !== "string") return
    // quotes and backslashes go first, since the shell reads "sign"-in and sign\-in as sign-in
    const text = toolInput.command.replace(/["'\\]/g, "")
    if (!SIGN_IN.test(text)) return
    const live = await liveOf(environment)
    const host = [...live.hosts].find((name) => names(text, name))
    const port = [...text.matchAll(LOOPBACK)]
      .map((m) => Number(m[1]))
      .find((p) => live.ports.has(p))
    if (!host && port === undefined) return
    return `no-live-sign-in hook refuses a sign-in call to the live dashboard (${host ?? `loopback port ${port}`}): the owner sign-in, first run's finish and the agent sign-in each mint a session holding the owner rung there. Sign in on your own worktree's stack instead, by the dev skill's Agent login, whose names \`bunx portless get api.playground\` prints in your worktree.`
  } catch {
    // Fails open: a call the hook cannot read runs, so a parser bug never blocks a Bash command.
    return undefined
  }
}

if (import.meta.main) {
  const raw = await input("no-live-sign-in", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
