import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  apiRead,
  apiUp,
  bootTime,
  cutDashboardCheckout,
  dashboardCheckout,
  dashboardUrls,
  graceEnded,
  homeDataDir,
  liveBranch,
  linesSince,
  liveSessions,
  upHolds,
  webUp,
} from "../../../../../packages/scripts/src/playground/probe"
import { pidsDir, withProc } from "../../../../scripts/fixtures/proc"

const dir = mkdtempSync(join(tmpdir(), "dispatcher-probe-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))

describe("linesSince", () => {
  test("reads from a byte offset, so a multi-byte character before it moves nothing", async () => {
    const log = join(dir, "results.log")
    await Bun.write(log, "2026-10-18T02:00:00Z ROLL x ✗ FAIL verify ✗\n")
    const from = Bun.file(log).size
    await Bun.write(log, `${await Bun.file(log).text()}2026-10-18T02:01:00Z CURRENT abc1234\n`)
    expect(await linesSince(log, from)).toEqual(["2026-10-18T02:01:00Z CURRENT abc1234"])
  })

  test("reads a file that is not there as no lines", async () => {
    expect(await linesSince(join(dir, "missing.log"), 0)).toEqual([])
  })
})

// portless answers 404 for a name no stack serves, so only the stack's own answer reads as up.
describe("apiUp and webUp", () => {
  const serve = (status: number) =>
    Bun.serve({ fetch: () => new Response("", { status }), hostname: "127.0.0.1", port: 0 })

  test("an API whose health answers 200 is up", async () => {
    const server = serve(200)
    const url = `http://127.0.0.1:${server.port}`
    expect(await apiUp({ api: url, web: url })).toBe(true)
    server.stop(true)
  })

  test("a 404 from the proxy reads as down for both", async () => {
    const server = serve(404)
    const url = `http://127.0.0.1:${server.port}`
    expect(await apiUp({ api: url, web: url })).toBe(false)
    expect(await webUp({ api: url, web: url })).toBe(false)
    server.stop(true)
  })

  test("a web page that redirects is up", async () => {
    const server = serve(307)
    const url = `http://127.0.0.1:${server.port}`
    expect(await webUp({ api: url, web: url })).toBe(true)
    server.stop(true)
  })

  // the 1355 proxy with TLS answers an http address with a 302 to https (#2301)
  test("a health read that answers a redirect is down, and names the URL asked and where it was sent", async () => {
    const server = Bun.serve({
      fetch: () => Response.redirect("https://api.example.localhost:1355/api/health", 302),
      hostname: "127.0.0.1",
      port: 0,
    })
    const url = `http://127.0.0.1:${server.port}`
    expect(await apiRead({ api: url, web: url })).toEqual({
      redirect: {
        from: `${url}/api/health`,
        status: 302,
        to: "https://api.example.localhost:1355/api/health",
      },
      up: false,
    })
    server.stop(true)
  })

  test("no URLs reads as down", async () => {
    expect(await apiUp(null)).toBe(false)
    expect(await webUp(null)).toBe(false)
  })
})

// An https dashboard serves a certificate from portless's CA, which Bun's own store lacks.
describe("apiUp over https", () => {
  const ca = join(dir, "ca.pem")
  const key = join(dir, "key.pem")
  const made = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      key,
      "-out",
      ca,
    ],
    { stderr: "pipe", stdout: "pipe" },
  )
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  const saved = { extra: process.env.NODE_EXTRA_CA_CERTS, state: process.env.PORTLESS_STATE_DIR }
  afterAll(() => {
    for (const [name, value] of [
      ["NODE_EXTRA_CA_CERTS", saved.extra],
      ["PORTLESS_STATE_DIR", saved.state],
    ] as const)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  })

  const upUnder = async (state: string) => {
    delete process.env.NODE_EXTRA_CA_CERTS
    process.env.PORTLESS_STATE_DIR = state
    const server = Bun.serve({
      fetch: () => new Response(""),
      port: 0,
      tls: { cert: Bun.file(ca), key: Bun.file(key) },
    })
    try {
      const url = `https://localhost:${server.port}`
      return await apiUp({ api: url, web: url })
    } finally {
      server.stop(true)
    }
  }

  test("reads as up under portless's CA", async () => {
    expect(await upUnder(dir)).toBe(true)
  })

  test("reads as down with no CA in portless's state folder", async () => {
    expect(await upUnder(join(dir, "missing"))).toBe(false)
  })
})

// On Linux no portless service runs on 443, so the stack's API starts the 1355 proxy in ~/.portless/fallback with TLS on, and ~/.portless stays idle (#2299).
describe("dashboardUrls", () => {
  test("names the 1355 fallback proxy's https URLs while only it serves, not an idle ~/.portless's", () => {
    const home = mkdtempSync(join(tmpdir(), "probe-urls-home-"))
    const dashboard = mkdtempSync(join(tmpdir(), "probe-urls-desk-"))
    symlinkSync(
      join(import.meta.dir, "../../../../../node_modules"),
      join(dashboard, "node_modules"),
    )
    mkdirSync(join(home, ".portless", "fallback"), { recursive: true })
    writeFileSync(join(home, ".portless", "routes.json"), "[]")
    // a stand-in for the fallback proxy: a port of the test's own, under the test's own pid
    const proxy = Bun.serve({ fetch: () => new Response(""), hostname: "127.0.0.1", port: 0 })
    const fallback = join(home, ".portless", "fallback")
    writeFileSync(join(fallback, "proxy.pid"), String(process.pid))
    writeFileSync(join(fallback, "proxy.port"), String(proxy.port))
    writeFileSync(join(fallback, "proxy.tls"), "1")
    // every PORTLESS* key is set aside, as install.test.ts's gitEnv drops them, so portless reads only the folders this test made
    const saved = Object.entries(process.env).filter(([key]) => key.startsWith("PORTLESS"))
    const savedHome = process.env.HOME
    process.env.HOME = home
    for (const [key] of saved) delete process.env[key]
    try {
      expect(dashboardUrls(dashboard)).toEqual({
        api: `https://api.playground.localhost:${proxy.port}`,
        web: `https://playground.localhost:${proxy.port}`,
      })
    } finally {
      process.env.HOME = savedHome
      for (const [key, value] of saved) process.env[key] = value
      proxy.stop(true)
      rmSync(home, { force: true, recursive: true })
      rmSync(dashboard, { force: true, recursive: true })
    }
  })
})

describe("a fresh install's first start", () => {
  // A clone of a made-up repo with one commit on main, as install.sh leaves one: origin's HEAD names main, and no checkout is on the live branch.
  const clone = () => {
    const root = mkdtempSync(join(tmpdir(), "fresh-checkout-"))
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root })
    git("init", "-q", "-b", "main", "origin")
    git(
      "-C",
      "origin",
      "-c",
      "user.email=fixture",
      "-c",
      "user.name=a",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    )
    git("clone", "-q", "origin", "repo")
    return join(root, "repo")
  }
  const real = (argv: string[], cwd?: string) => {
    const child = Bun.spawnSync(argv, { cwd, stderr: "pipe", stdout: "pipe" })
    return { code: child.exitCode ?? 1, out: child.stdout.toString().trim() }
  }

  test("cuts the Dashboard's checkout on its branch from origin's main, installs it, and finds it after", () => {
    const repo = clone()
    expect(dashboardCheckout(repo)).toBeNull()
    const installs: string[] = []
    const exec = (argv: string[], cwd?: string) =>
      argv[0] === "bun" ? (installs.push(cwd!), { code: 0, out: "" }) : real(argv, cwd)
    const made = cutDashboardCheckout(repo, exec)
    const checkout = join(repo, ".claude", "worktrees", "desk")
    expect(made).toEqual({ checkout })
    expect(installs).toEqual([checkout])
    expect(real(["git", "-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"]).out).toBe(
      liveBranch(),
    )
    expect(dashboardCheckout(repo)?.endsWith(join(".claude", "worktrees", "desk"))).toBe(true)
  })

  test("cuts the Dashboard's checkout from origin's main, the shipped branch, though origin's default branch is canary", () => {
    const root = mkdtempSync(join(tmpdir(), "fresh-checkout-"))
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=fixture", "-c", "user.name=a", ...args], {
        cwd: root,
      })
        .stdout.toString()
        .trim()
    git("init", "-q", "-b", "main", "origin")
    git("-C", "origin", "commit", "-q", "--allow-empty", "-m", "shipped")
    git("-C", "origin", "checkout", "-q", "-b", "canary")
    git("-C", "origin", "commit", "-q", "--allow-empty", "-m", "unshipped")
    git("clone", "-q", "-b", "main", "origin", "repo")
    const repo = join(root, "repo")
    const exec = (argv: string[], cwd?: string) =>
      argv[0] === "bun" ? { code: 0, out: "" } : real(argv, cwd)
    const made = cutDashboardCheckout(repo, exec)
    expect(made).toEqual({ checkout: join(repo, ".claude", "worktrees", "desk") })
    expect(git("-C", join(repo, ".claude", "worktrees", "desk"), "log", "-1", "--format=%s")).toBe(
      "shipped",
    )
  })

  test("names the step that failed: the cut, or the install", () => {
    const repo = clone()
    const noInstall = (argv: string[], cwd?: string) =>
      argv[0] === "bun" ? { code: 1, out: "" } : real(argv, cwd)
    expect(cutDashboardCheckout(repo, noInstall)).toEqual({
      error: `bun install failed in the Dashboard's checkout, ${join(repo, ".claude", "worktrees", "desk")}`,
    })
    expect(cutDashboardCheckout(repo, noInstall)).toEqual({
      error: `could not cut the Dashboard's checkout at ${join(repo, ".claude", "worktrees", "desk")}`,
    })
  })
})

describe("homeDataDir", () => {
  test("follows PLAYGROUND_DATA_DIR as spawn.sh does, else playground under HOME's ~/.claude", () => {
    const saved = { config: process.env.CLAUDE_CONFIG_DIR, data: process.env.PLAYGROUND_DATA_DIR }
    try {
      process.env.CLAUDE_CONFIG_DIR = join(dir, "config")
      process.env.PLAYGROUND_DATA_DIR = join(dir, "data")
      expect(homeDataDir()).toBe(join(dir, "data"))
      delete process.env.PLAYGROUND_DATA_DIR
      expect(homeDataDir()).toBe(join(homedir(), ".playground"))
    } finally {
      for (const [key, value] of [
        ["CLAUDE_CONFIG_DIR", saved.config],
        ["PLAYGROUND_DATA_DIR", saved.data],
      ] as const)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
  })
})

// A first start reads live.branch before any setting has written policy.json, as when ext init stopped after making the extensions root.
describe("liveBranch before a first setting", () => {
  const withData = (data: string, read: () => void) => {
    const saved = process.env.PLAYGROUND_DATA_DIR
    try {
      process.env.PLAYGROUND_DATA_DIR = data
      read()
    } finally {
      if (saved === undefined) delete process.env.PLAYGROUND_DATA_DIR
      else process.env.PLAYGROUND_DATA_DIR = saved
    }
  }

  test("a data folder with no extensions root reads the default branch", () => {
    withData(join(dir, "no-root"), () => expect(liveBranch()).toBe("live/dashboard"))
  })

  test("an extensions root with no policy.json reads the default branch", () => {
    const data = join(dir, "root-only")
    mkdirSync(join(data, "extensions"), { recursive: true })
    withData(data, () => expect(liveBranch()).toBe("live/dashboard"))
  })

  test("a policy.json that does not parse is still refused", () => {
    const data = join(dir, "bad-policy")
    mkdirSync(join(data, "extensions"), { recursive: true })
    writeFileSync(join(data, "extensions", "policy.json"), "{")
    withData(data, () => expect(() => liveBranch()).toThrow("does not parse"))
  })
})

// Claude Code on Linux records procStart as its process's start in clock ticks since boot, field 22 of /proc/<pid>/stat, where macOS records ps's lstart.
describe("liveSessions on Linux", () => {
  test("a record whose procStart is clock ticks is live while /proc gives its pid that start, and gone once the pid started at another", async () => {
    const config = join(dir, "linux-config")
    mkdirSync(join(config, "sessions"), { recursive: true })
    writeFileSync(
      join(config, "sessions", `${process.pid}.json`),
      JSON.stringify({ name: "dispatcher", pid: process.pid, procStart: "1801742" }),
    )
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    try {
      const names = (ticks: string) =>
        withProc(pidsDir({ [process.pid]: ticks }), () =>
          liveSessions((name) => name === "dispatcher").map((d) => d.name),
        )
      expect(await names("1801742")).toEqual(["dispatcher"])
      expect(await names("2900000")).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
})

// Mirrors up.py's grace_ended: a start within grace is over only when the heartbeat recorded a later start, or the machine booted at or after the recorded one.
describe("graceEnded", () => {
  test("is over when the heartbeat recorded a start at or after the one up.py made", () => {
    expect(graceEnded(100, 150, 0)).toBe(true)
  })

  test("is over when the machine booted at or after the one up.py made", () => {
    expect(graceEnded(100, 50, 100)).toBe(true)
  })

  test("still holds when the heartbeat recorded an earlier start and the machine booted before it", () => {
    expect(graceEnded(100, 50, 0)).toBe(false)
  })
})

describe("upHolds", () => {
  const writeOps = (data: string, state: unknown, beat?: Record<string, unknown>): void => {
    const ops = join(data, "ops")
    mkdirSync(ops, { recursive: true })
    writeFileSync(join(ops, "up-state.json"), JSON.stringify(state))
    if (beat) writeFileSync(join(ops, "ops-dashboard.json"), JSON.stringify(beat))
  }
  const withData = (data: string, read: () => boolean): boolean => {
    const saved = process.env.PLAYGROUND_DATA_DIR
    try {
      process.env.PLAYGROUND_DATA_DIR = data
      return read()
    } finally {
      if (saved === undefined) delete process.env.PLAYGROUND_DATA_DIR
      else process.env.PLAYGROUND_DATA_DIR = saved
    }
  }

  test("holds a start still within grace, so the wait keeps waiting for up.py to start it", () => {
    const boot = bootTime()
    const data = join(dir, "up-holds-holds")
    const start = boot + 100
    const beat = { startedAt: new Date((start - 10) * 1000).toISOString() }
    writeOps(data, { "ops-dashboard": start }, beat)
    expect(withData(data, () => upHolds(start * 1000 + 50_000))).toBe(true)
  })

  test("ends early when the heartbeat recorded a start at or after the one up.py made, so the wait stops holding it", () => {
    const boot = bootTime()
    const data = join(dir, "up-holds-beat")
    const start = boot + 100
    const beat = { startedAt: new Date((start + 10) * 1000).toISOString() }
    writeOps(data, { "ops-dashboard": start }, beat)
    expect(withData(data, () => upHolds(start * 1000 + 50_000))).toBe(false)
  })

  test("ends early when the machine booted at or after the start up.py made, so the wait stops holding it", () => {
    const start = bootTime()
    const data = join(dir, "up-holds-boot")
    const beat = { startedAt: new Date((start - 10) * 1000).toISOString() }
    writeOps(data, { "ops-dashboard": start }, beat)
    expect(withData(data, () => upHolds(start * 1000 + 50_000))).toBe(false)
  })

  test("drops a start past its 600s grace, so the wait bails, even with a heartbeat up.py made later", () => {
    const boot = bootTime()
    const data = join(dir, "up-holds-past")
    const start = boot + 100
    const beat = { startedAt: new Date((start - 10) * 1000).toISOString() }
    writeOps(data, { "ops-dashboard": start }, beat)
    expect(withData(data, () => upHolds(start * 1000 + 700_000))).toBe(false)
  })
})
