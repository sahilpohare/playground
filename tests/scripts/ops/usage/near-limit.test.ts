import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scratchEnv } from "../../../scratch-env"

const script = join(import.meta.dir, "../../../../scripts/ops/usage/near-limit.py")
const scratch = mkdtempSync(join(tmpdir(), "near-limit-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// near-limit.py whole, under its own scratch HOME per run: a stand-in beat module gives its settings and swaps urllib's urlopen for the headers given, so no call leaves the Mac; a stand-in `security` holds the Keychain. Answers with the seen entry it wrote for the watched account
const runWhole = async (headers: Record<string, string>) => {
  const home = mkdtempSync(join(scratch, "home-"))
  const ops = join(home, ".playground", "ops")
  const stubs = join(home, "stubs")
  mkdirSync(join(ops, "usage"), { recursive: true })
  mkdirSync(stubs, { recursive: true })
  const settings = {
    "models.probe": "a-made-up-model",
    "usage.accounts": [{ email: "watched@example.org", nearLimit: true, provider: "claude" }],
    "usage.keychainService": "made-up-service",
  }
  writeFileSync(
    join(ops, "beat.py"),
    `
import io, json, os, urllib.error, urllib.request
OPS = os.path.dirname(os.path.abspath(__file__))
def urlopen(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 200, "ok", json.loads('${JSON.stringify(headers)}'), io.BytesIO(b"{}"))
urllib.request.urlopen = urlopen
def setting(key):
    return json.loads(${JSON.stringify(JSON.stringify(settings))})[key]
`,
  )
  writeFileSync(
    join(home, ".playground", "usage.json"),
    JSON.stringify({ account: "stored@example.org", rate_limits: {} }),
  )
  writeFileSync(join(stubs, "security"), "#!/bin/sh\necho made-up-token\n", { mode: 0o755 })
  const env = scratchEnv(home, {
    PATH: `${stubs}:${process.env.PATH}`,
  })
  const child = Bun.spawn(["python3", "-I", script], { env, stderr: "pipe", stdout: "pipe" })
  const [err] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(err).toBe("")
  return JSON.parse(readFileSync(join(ops, "usage", "login-flip.json"), "utf8")).seen
}

test("a probe answered with no 5-hour headers writes the account's five as none in login-flip.json, never 0%", async () => {
  const seen = await runWhole({
    "anthropic-ratelimit-unified-7d-utilization": "0.3",
    "anthropic-ratelimit-unified-7d-reset": "4000000000",
  })
  expect(seen["watched@example.org"]).toMatchObject({ five: null, fiveReset: null, week: 30 })
})

// #1587: a full week is limited until its reset whatever the status header says, so an answer with no status header marks it too
test("a probe answered with a full week and no status header marks the account limited until its reset (#1587)", async () => {
  const seen = await runWhole({
    "anthropic-ratelimit-unified-7d-utilization": "1.0",
    "anthropic-ratelimit-unified-7d-reset": "4000000000",
  })
  expect(seen["watched@example.org"]).toMatchObject({ week: 100, limitedUntil: 4000000000 })
})
