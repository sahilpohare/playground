import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  GH_HANGS,
  GH_STALE_MS,
  GH_TIMEOUT_MS,
  ghAuthPath,
  ghDown,
  ghRead,
  ghTimedOut,
  KEYRING_LOCKED,
} from "../../../../packages/scripts/src/gh-read"

// A scratch folder holding a fake gh first on PATH, which records each call in called and answers as gh.sh says, and a data folder the beat's result is read from.
const dir = mkdtempSync(join(tmpdir(), "gh-read-"))
const bin = join(dir, "bin")
const data = join(dir, "data")
const called = join(dir, "called")
const saved = { data: process.env.PLAYGROUND_DATA_DIR, path: process.env.PATH }

const fakeGh = (body: string) => {
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${called}"\n${body}\n`)
  chmodSync(join(bin, "gh"), 0o755)
}

const lastProbe = (ok: boolean, at = new Date(), reason = "gh token invalid") => {
  mkdirSync(join(data, "ops", "tick"), { recursive: true })
  writeFileSync(ghAuthPath(data), JSON.stringify({ at: at.toISOString(), ok, reason }))
}

beforeAll(() => {
  mkdirSync(bin, { recursive: true })
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.PLAYGROUND_DATA_DIR = data
})
afterEach(() => rmSync(called, { force: true }))
afterAll(() => {
  process.env.PATH = saved.path
  if (saved.data === undefined) delete process.env.PLAYGROUND_DATA_DIR
  else process.env.PLAYGROUND_DATA_DIR = saved.data
  rmSync(dir, { force: true, recursive: true })
})

test("a passing gh reads its stdout, and a failing one its exit code", () => {
  fakeGh("echo open; exit 0")
  expect(ghRead(["api", "x"])).toEqual({ code: 0, out: "open\n" })
  fakeGh('echo "HTTP 401" >&2; exit 1')
  expect(ghRead(["api", "x"])).toEqual({ code: 1, out: "" })
})

test("a gh that hangs past the cap stops and reads the timeout", () => {
  fakeGh("exec sleep 30")
  const start = Date.now()
  expect(ghRead(["api", "x"], { timeoutMs: 300 })).toEqual({
    unreachable: ghTimedOut(300),
  })
  expect(Date.now() - start).toBeLessThan(5_000)
})

// ghTimedOut(10 s) is the read-past-cap answer every gh caller reports, so it is pinned first.
test("ghTimedOut reports the cap in seconds", () => {
  expect(ghTimedOut(GH_TIMEOUT_MS)).toBe("gh timed out after 10 s")
})

// Written by the faked gh during the sleep, after ghRead's own ghDown(), so the read reaches the timeout branch.
test("a read past the cap keeps the keyring words while a fresh beat names a keyring failure", () => {
  const at = new Date().toISOString()
  fakeGh(
    `mkdir -p "$PLAYGROUND_DATA_DIR/ops/tick"\n` +
      `echo '{"at":"${at}","ok":false,"reason":"${GH_HANGS}"}' > "$PLAYGROUND_DATA_DIR/ops/tick/gh-auth.json"\n` +
      `exec sleep 30`,
  )
  expect(ghRead(["api", "x"], { timeoutMs: 300 })).toEqual({
    unreachable: GH_HANGS,
  })
  expect(existsSync(called)).toBe(true)
})

// The beat's other keyring failure, a locked keyring with no desktop session, keeps its own words too.
test("a read past the cap keeps the locked-keyring words while a fresh beat names them", () => {
  rmSync(ghAuthPath(data), { force: true })
  const at = new Date().toISOString()
  fakeGh(
    `mkdir -p "$PLAYGROUND_DATA_DIR/ops/tick"\n` +
      `echo '{"at":"${at}","ok":false,"reason":"${KEYRING_LOCKED}"}' > "$PLAYGROUND_DATA_DIR/ops/tick/gh-auth.json"\n` +
      `exec sleep 30`,
  )
  expect(ghRead(["api", "x"], { timeoutMs: 300 })).toEqual({ unreachable: KEYRING_LOCKED })
})

// Too old to trust a keyring failure, a past-cap read reports the timeout.
test("a stale keyring result on file reads the timeout", () => {
  fakeGh("exec sleep 30")
  lastProbe(false, new Date(Date.now() - GH_STALE_MS - 60_000), GH_HANGS)
  expect(ghRead(["api", "x"], { timeoutMs: 300 })).toEqual({
    unreachable: ghTimedOut(300),
  })
})

test("a fresh failed result stops the read with no gh call", () => {
  fakeGh("echo open; exit 0")
  lastProbe(false)
  expect(ghRead(["api", "x"])).toEqual({ unreachable: "gh token invalid" })
  expect(existsSync(called)).toBe(false)
})

// a stalled beat must not freeze every read while gh may be fine
test("a missing, passing or stale result leaves the read to gh", () => {
  fakeGh("echo open; exit 0")
  rmSync(ghAuthPath(data), { force: true })
  expect(ghRead(["api", "x"])).toEqual({ code: 0, out: "open\n" })
  lastProbe(true)
  expect(ghRead(["api", "x"])).toEqual({ code: 0, out: "open\n" })
  lastProbe(false, new Date(Date.now() - GH_STALE_MS - 60_000))
  expect(ghRead(["api", "x"])).toEqual({ code: 0, out: "open\n" })
  expect(existsSync(called)).toBe(true)
})

test("ghDown reads no result, an unreadable one and a passing one as up", () => {
  const path = join(dir, "none.json")
  expect(ghDown(path)).toBeNull()
  writeFileSync(path, "{")
  expect(ghDown(path)).toBeNull()
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ok: true }))
  expect(ghDown(path)).toBeNull()
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ok: false }))
  expect(ghDown(path)).toBe("gh fails")
})

// each job that reads gh on a cycle or per session asks the gh sign-in probe's result first, so a broken gh is never flooded (#2526)
test("every recurring gh caller checks the probe's result before gh", () => {
  const repo = join(import.meta.dir, "..", "..", "..", "..")
  const callers: [string, string, string][] = [
    ["api/hono/src/lib/dashboard/agents.ts", "ghSkipped()", 'run(["gh", "api", "graphql"'],
    ["extensions/core/skills/code-review-loop/scripts/state.ts", "ghDown()", "Bun.spawnSync(args"],
    ["packages/scripts/src/ops-sweep/cli.ts", "ghSkipped()", "Bun.spawn("],
    ["packages/scripts/src/playground/ci-wait.ts", "ghSkipped()", 'Bun.spawnSync(["gh"'],
    ["packages/scripts/src/pr-merge/merge.ts", "ghSkipped()", 'Bun.spawn(["gh"'],
    ["scripts/ops/optimizer/idle_sessions.ts", "ghDown()", 'Bun.spawn(["gh"'],
    ["scripts/ops/unstick/run.py", "gh_down()", '["gh", "pr", "list"'],
    ["scripts/ops/merge-train/run.py", "gh_down()", "fingerprint()\n"],
  ]
  for (const [file, check, call] of callers) {
    const text = readFileSync(join(repo, file), "utf8")
    const at = text.indexOf(check)
    expect([file, at > 0 && at < text.indexOf(call, at)]).toEqual([file, true])
  }
})
