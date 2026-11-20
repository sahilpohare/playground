import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { hc } from "hono/client"

import type { HostedAppType } from "../../../../api/hono/src/index"
import { entryOf } from "../../../../api/hono/src/lib/entry"
import { importGraph, ROOT, SRC } from "./import-graph"

const API = join(ROOT, "api/hono")

// A child Bun in the API's folder, so its tsconfig's @/ resolves, with a valid environment of its own: the hosted switch is read once, when the env module loads.
const child = (script: string, env: Record<string, string>) => {
  const run = Bun.spawnSync(["bun", "-e", script], {
    cwd: API,
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      BETTER_AUTH_SECRET: "hosted-test-secret",
      GITHUB_CLIENT_ID: "hosted-test-client",
      GITHUB_CLIENT_SECRET: "hosted-test-client-secret",
      HONO_APP_URL: "http://127.0.0.1:4000",
      HONO_TRUSTED_ORIGINS: "http://127.0.0.1:3000",
      NODE_ENV: "test",
      // set, so a checkout's .env cannot fill it in through the env loader
      PLAYGROUND_HOSTED: "",
      PORT: "0",
      POSTGRES_URL: "postgres://postgres:pw@127.0.0.1:9/postgres",
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  })
  return { code: run.exitCode, err: run.stderr.toString(), out: run.stdout.toString() }
}

// Every path a hosted build may serve: Hono's own middleware on *, sign-in, health and Yard. Anything else is a local route reaching the public build.
const ALLOWED = /^\/(\*|api\/(auth|health|v1\/yard)(\/.*)?)$/

describe("the hosted mount allowlist", () => {
  test("index.ts under PLAYGROUND_HOSTED=1 mounts only auth, health and Yard", () => {
    const listed = child(
      `const { app } = await import(${JSON.stringify(join(SRC, "index.ts"))}); console.log(JSON.stringify(app.routes.map((r) => r.path))); process.exit(0)`,
      { PLAYGROUND_HOSTED: "1" },
    )
    expect(listed.err).not.toContain("error:")
    expect(listed.code).toBe(0)
    const paths: string[] = JSON.parse(listed.out.trim().split("\n").at(-1) ?? "[]")
    expect(paths.filter((path) => !ALLOWED.test(path))).toEqual([])
    expect(paths).toContain("/api/health")
    expect(paths.some((path) => path.startsWith("/api/auth/"))).toBe(true)
  })

  test("the hosted entry refuses to start without PLAYGROUND_HOSTED=1", () => {
    const run = child(`await import(${JSON.stringify(join(SRC, "hosted.ts"))})`, {})
    expect(run.code).toBe(1)
    expect(run.err).toContain("PLAYGROUND_HOSTED=1")
  })

  // Vercel hangs 60s and answers 500 on a default export that has already called listen(), as serve() does; one that never listens answers, WebSocket upgrades included.
  test("on Vercel the hosted export is a server that never listens, with the WebSocket upgrade on it", () => {
    const run = child(
      `const server = (await import(${JSON.stringify(join(SRC, "index.ts"))})).default; console.log(JSON.stringify({ listening: server.listening, upgrade: server.listenerCount("upgrade") })); process.exit(0)`,
      { PLAYGROUND_HOSTED: "1", VERCEL: "1" },
    )
    expect(run.code).toBe(0)
    expect(JSON.parse(run.out.trim().split("\n").at(-1) ?? "{}")).toEqual({
      listening: false,
      upgrade: 1,
    })
  })

  test("a local build refuses to serve on Vercel", () => {
    const run = child(`await import(${JSON.stringify(join(SRC, "index.ts"))})`, { VERCEL: "1" })
    expect(run.code).toBe(1)
    expect(run.err).toContain("Vercel")
  })

  test("sign-in offers GitHub on the hosted build alone, and a hosted build without its keys refuses to start", () => {
    const providers = `const { auth } = await import("@packages/auth"); console.log(JSON.stringify(Object.keys(auth.options.socialProviders ?? {}))); process.exit(0)`
    const hosted = child(providers, { PLAYGROUND_HOSTED: "1" })
    expect(hosted.out.trim().split("\n").at(-1)).toBe('["github"]')
    const local = child(providers, {})
    expect(local.out.trim().split("\n").at(-1)).toBe("[]")
    const keyless = child(providers, {
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      PLAYGROUND_HOSTED: "1",
    })
    expect(keyless.code).toBe(1)
    expect(keyless.err).toContain("GITHUB_CLIENT_ID")
  })

  test("entryOf picks hosted on the flag, refuses a local build on Vercel, else local", () => {
    expect(entryOf({ hosted: true, vercel: "1" })).toBe("hosted")
    expect(entryOf({ hosted: true, vercel: undefined })).toBe("hosted")
    expect(entryOf({ hosted: false, vercel: undefined })).toBe("local")
    expect(entryOf({ hosted: false, vercel: "0" })).toBe("local")
    const refused = entryOf({ hosted: false, vercel: "1" })
    expect(typeof refused === "object" && refused.refused).toContain("Vercel")
  })
})

// The packages only the local dashboard runs on, and the API folders that read this machine or serve its local pages: none may reach the hosted build.
const LOCAL_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "@packages/scripts", "@packages/settings"]
const LOCAL_DIRS = [
  "bin",
  "fixtures",
  "lib/accounts",
  "lib/apps",
  "lib/dashboard",
  "lib/dev",
  "lib/onboard",
  "lib/sessions",
  "lib/setup",
  "lib/store",
  "lib/system",
  "lib/usage",
  "plugins",
]
const HOSTED_ROUTERS = ["routers/auth.ts", "routers/relay.ts", "routers/yard.ts"]

describe("the hosted entry's import graph", () => {
  const graph = importGraph(join(SRC, "hosted.ts"))

  test("holds none of the local-only packages", () => {
    expect(graph.packages.filter((name) => LOCAL_PACKAGES.includes(name))).toEqual([])
  })

  test("reaches no API file that reads this machine, and no router but auth and Yard", () => {
    const local = graph.files.filter(
      (file) =>
        file === "local.ts" ||
        LOCAL_DIRS.some((dir) => file.startsWith(`${dir}/`)) ||
        (file.startsWith("routers/") && !HOSTED_ROUTERS.includes(file)),
    )
    expect(local).toEqual([])
    expect(graph.files).toContain("routers/yard.ts")
  })

  test("the local entry's graph does hold them, so the walk sees what it checks", () => {
    const whole = importGraph(join(SRC, "local.ts"))
    expect(whole.packages).toContain("@anthropic-ai/claude-agent-sdk")
    expect(whole.files.some((file) => file.startsWith("lib/dashboard/"))).toBe(true)
  })

  test("walks into the workspace packages, so a local-only import behind one turns it red", () => {
    expect(graph.files).toContain("packages/auth/src/index.ts")
    expect(graph.files).toContain("packages/db/src/index.ts")
  })
})

// index.ts once gave the local dashboard's RPC type alone, so a client of the hosted API reached Yard's routes untyped; check-types fails here when the route leaves the type
test("the hosted RPC type names Yard's routes", () => {
  const client = hc<HostedAppType>("http://127.0.0.1")
  expect(typeof client.api.v1.yard.channels.$get).toBe("function")
})
