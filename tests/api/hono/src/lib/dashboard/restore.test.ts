import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"

// The router's auth refuses Better Auth's default secret under NODE_ENV=production, which CI's build step sets; any secret serves requests that carry no session. Set before the router loads.
process.env.BETTER_AUTH_SECRET ||= "restore-route-test-secret-not-for-use-anywhere"
const { dashboardRouter } = await import("../../../../../../api/hono/src/routers/dashboard")
const { ensureFixture } = await import("../../../../../../api/hono/src/lib/dashboard/fixture")
const { errorHandler } = await import("../../../../../../api/hono/src/lib/error")
const { env } = await import("../../../../../../packages/env/dist/api-hono.mjs")
// Resolved from the API's own source, so the test holds the same auth instance the middlewares do.
const { auth } = await import(
  Bun.resolveSync(
    "@packages/auth",
    new URL("../../../../../../api/hono/src", import.meta.url).pathname,
  )
)

// Imported in each test that needs it, so the guards' controls still run on a tree that lacks it.
const RESTORE = "../../../../../../api/hono/src/lib/dashboard/restore"

const scratch = mkdtempSync(join(tmpdir(), "restore-route-"))
const saved = {
  fixtureDir: process.env.PLAYGROUND_FIXTURE_DIR,
  liveReads: process.env.PLAYGROUND_LIVE_READS,
}
// A test run reads a fixture, and its scratch copy sits in this file's own folder, so the checkout the route restores is <scratch>/fixture/checkout and never a real one.
beforeAll(() => {
  process.env.PLAYGROUND_FIXTURE_DIR = join(scratch, "fixture")
  delete process.env.PLAYGROUND_LIVE_READS
})
afterAll(() => {
  for (const [key, value] of [
    ["PLAYGROUND_FIXTURE_DIR", saved.fixtureDir],
    ["PLAYGROUND_LIVE_READS", saved.liveReads],
  ] as const)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  rmSync(scratch, { force: true, recursive: true })
})

const spies: { mockRestore: () => void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

// Validated, the setting is a list; with validation skipped, as in CI, it is the raw comma-separated string.
const trusted = (): string => {
  const origins: unknown = env.HONO_TRUSTED_ORIGINS
  return Array.isArray(origins) ? String(origins[0]) : String(origins).split(",")[0]!.trim()
}

// Stands in for the Bun server hono/bun reads the peer from; with none, the peer is unknown.
const peer = (address: string) => ({
  requestIP: () => ({ address, family: "IPv4", port: 50000 }),
})

// Stands in for Better Auth's session read: authMiddleware asks with returnHeaders and takes { headers, response }, requireConsoleRole asks without and takes the session.
const signedIn = (role: string) =>
  spyOn(auth.api, "getSession").mockImplementation((async (options: {
    returnHeaders?: boolean
  }) => {
    const session = {
      session: { id: "s-restore", userId: `u-${role}` },
      user: { banned: false, id: `u-${role}`, role },
    }
    return options.returnHeaders ? { headers: new Headers(), response: session } : session
  }) as never)

const app = new Hono().route("/", dashboardRouter)
app.onError(errorHandler)

const press = (headers: Record<string, string>, server?: ReturnType<typeof peer>) =>
  app.request("http://127.0.0.1/ops/restore", { headers, method: "POST" }, server)

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe", stdout: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
  return run.stdout.toString()
}

// A scratch main checkout at the place the route reads on a fixture stack: one guard's bundle that the checkout's own factory settings register, a link-skills.sh that leaves a mark, and a package.json with nothing to install, cloned from an origin of its own.
const scratchCheckout = (link = 'touch "$(dirname "$0")/../linked"\n'): string => {
  const main = join(ensureFixture(), "checkout")
  rmSync(main, { force: true, recursive: true })
  const origin = mkdtempSync(join(scratch, "origin-"))
  mkdirSync(join(origin, "scripts", "hooks", "bundled"), { recursive: true })
  writeFileSync(join(origin, "scripts", "hooks", "bundled", "no-stash.js"), "")
  writeFileSync(
    join(origin, "scripts", "factory-settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: "bun scripts/hooks/bundled/no-stash.js" }] }] },
    }),
  )
  writeFileSync(join(origin, "scripts", "link-skills.sh"), link)
  writeFileSync(join(origin, "package.json"), '{ "name": "scratch-main", "private": true }\n')
  writeFileSync(join(origin, ".gitignore"), "linked\nbun.lock\nnode_modules\n")
  git(origin, "init", "-q", "-b", "main")
  git(origin, "add", "-A")
  git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "guards")
  git(scratch, "clone", "-q", origin, main)
  return main
}

const GUARD = ["scripts", "hooks", "bundled", "no-stash.js"]
const wipe = (main: string) =>
  rmSync(join(main, "scripts", "hooks"), { force: true, recursive: true })

describe("Restore now's checkout comes from the server alone (#1919)", () => {
  test("a fixture or test stack restores the fixture's scratch checkout", async () => {
    const { restoreMain } = await import(RESTORE)
    expect(restoreMain()).toBe(join(scratch, "fixture", "checkout"))
  })

  test("a stack that reads this machine restores the main checkout its own checkout sits in", async () => {
    const { restoreMain } = await import(RESTORE)
    expect(
      restoreMain("/Users/p/playground/.claude/worktrees/desk", {
        kind: "live",
        rule: "live-branch",
      }),
    ).toBe("/Users/p/playground")
    expect(restoreMain("/Users/p/playground", { kind: "live", rule: "own" })).toBe(
      "/Users/p/playground",
    )
  })

  test("a hosted or refused stack restores nothing", async () => {
    const { restoreMain } = await import(RESTORE)
    expect(restoreMain("/x", { kind: "hosted" })).toBeNull()
    expect(restoreMain("/x", { kind: "refused", reason: "no" })).toBeNull()
  })
})

describe("POST /ops/restore (#1919)", () => {
  test("with its guard gone, the owner's press puts the checkout back, installs and links, and says so", async () => {
    const main = scratchCheckout()
    wipe(main)
    spies.push(signedIn("owner"))
    const response = await press({ origin: trusted() }, peer("127.0.0.1"))
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: { status: string; text: string } }
    expect(data.status).toBe("restored")
    expect(data.text).toContain(`1 guard was gone from ${main}`)
    expect(existsSync(join(main, ...GUARD))).toBe(true)
    expect(existsSync(join(main, "linked"))).toBe(true)
  }, 120_000)

  test("with its .git gone too, the press restores it in place from the origin URL ops-restore kept, and says every worktree of the lost .git has lost its link (#1382)", async () => {
    const main = scratchCheckout()
    const origin = git(main, "remote", "get-url", "origin").trim()
    git(main, "worktree", "add", "-q", "-b", "desk", join(main, ".claude", "worktrees", "desk"))
    const { dataDir } = await import("../../../../../../api/hono/src/lib/sessions/paths")
    mkdirSync(join(dataDir(), "ops", "restore"), { recursive: true })
    writeFileSync(join(dataDir(), "ops", "restore", "origin.txt"), `${origin}\n`)
    wipe(main)
    rmSync(join(main, ".git"), { force: true, recursive: true })
    spies.push(signedIn("owner"))
    const response = await press({ origin: trusted() }, peer("127.0.0.1"))
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: { status: string; text: string } }
    expect(data.status).toBe("restored")
    expect(data.text).toContain("had no .git and was restored in place")
    expect(data.text).toContain("has lost its link to it")
    expect(existsSync(join(main, ...GUARD))).toBe(true)
    expect(existsSync(join(main, "linked"))).toBe(true)
    expect(git(main, "remote", "get-url", "origin").trim()).toBe(origin)
    expect(git(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main\n")
  }, 120_000)

  test("a checkout whose guards are all there is left as it is", async () => {
    const main = scratchCheckout()
    spies.push(signedIn("owner"))
    await press({ origin: trusted() }, peer("127.0.0.1"))
    expect(existsSync(join(main, "linked"))).toBe(false)
    expect(git(main, "status", "--porcelain")).toBe("")
  }, 60_000)

  test("for a checkout whose guards are all there, the page's words say nothing was restored", async () => {
    const main = scratchCheckout()
    spies.push(signedIn("owner"))
    const response = await press({ origin: trusted() }, peer("127.0.0.1"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        status: "intact",
        text: `Every guard is in place in ${main}, so nothing was restored.`,
      },
    })
  }, 60_000)

  test("a press with no origin, another origin, or from off this machine is refused before the session is read, and nothing runs", async () => {
    const main = scratchCheckout()
    wipe(main)
    const session = signedIn("owner")
    spies.push(session)
    expect((await press({}, peer("127.0.0.1"))).status).toBe(403)
    expect((await press({ origin: "http://evil.localhost" }, peer("127.0.0.1"))).status).toBe(403)
    expect((await press({ origin: trusted() }, peer("192.168.1.20"))).status).toBe(403)
    expect((await press({ origin: trusted() })).status).toBe(403)
    expect(session).not.toHaveBeenCalled()
    expect(existsSync(join(main, ...GUARD))).toBe(false)
  })

  test("a session below the owner rung is refused, and nothing runs", async () => {
    const main = scratchCheckout()
    wipe(main)
    spies.push(signedIn("admin"))
    expect((await press({ origin: trusted() }, peer("127.0.0.1"))).status).toBe(403)
    expect(existsSync(join(main, ...GUARD))).toBe(false)
  })

  // A real install and link-skills.sh outlast Bun.serve's 10 s idle limit, which drops a quiet request, so the press runs on a real server with a link-skills.sh that takes 15 s, past the 12 s a dropped request was measured to fail at; a second press while it runs is refused.
  test("a restore longer than the server's idle limit still answers with its words, and a second press meanwhile is refused", async () => {
    const main = scratchCheckout('sleep 15\ntouch "$(dirname "$0")/../linked"\n')
    wipe(main)
    spies.push(signedIn("owner"))
    const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
    try {
      const first = fetch(`http://127.0.0.1:${server.port}/ops/restore`, {
        headers: { origin: trusted() },
        method: "POST",
      })
      await Bun.sleep(1_000)
      const second = await press({ origin: trusted() }, peer("127.0.0.1"))
      expect(second.status).toBe(409)
      expect(await second.text()).toContain("A restore is already running")
      const response = await first
      expect(response.status).toBe(200)
      expect(((await response.json()) as { data: { status: string } }).data.status).toBe("restored")
      expect(existsSync(join(main, ...GUARD))).toBe(true)
      expect(existsSync(join(main, "linked"))).toBe(true)
    } finally {
      await server.stop(true)
    }
  }, 60_000)

  test("a stack with no checkout to restore refuses the press", async () => {
    spies.push(signedIn("owner"))
    const hosted = process.env.PLAYGROUND_HOSTED
    process.env.PLAYGROUND_HOSTED = "1"
    try {
      const response = await press({ origin: trusted() }, peer("127.0.0.1"))
      expect(response.status).toBe(409)
      expect(await response.text()).toContain("This stack has no checkout to restore")
    } finally {
      if (hosted === undefined) delete process.env.PLAYGROUND_HOSTED
      else process.env.PLAYGROUND_HOSTED = hosted
    }
  })
})
