import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scratchEnv } from "../../../scratch-env"

const script = join(import.meta.dir, "../../../../scripts/ops/usage/account-watch.py")
const scratch = mkdtempSync(join(tmpdir(), "account-watch-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// account-watch.py whole, under a scratch HOME: a stand-in beat module gives its settings and swaps urllib's urlopen for an answer with a week and no 5-hour headers, so no call leaves the Mac; a stand-in `security` holds the Keychain
test("a reading answered with no 5-hour headers omits five_hour from usage-<name>.json, never 0%", async () => {
  const ops = join(scratch, ".playground", "ops")
  const stubs = join(scratch, "stubs")
  mkdirSync(ops, { recursive: true })
  mkdirSync(stubs, { recursive: true })
  const settings = { "models.probe": "a-made-up-model", "usage.keychainService": "made-up-service" }
  writeFileSync(
    join(ops, "beat.py"),
    `
import io, json, os, urllib.error, urllib.request
OPS = os.path.dirname(os.path.abspath(__file__))
def urlopen(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 200, "ok", {"anthropic-ratelimit-unified-7d-utilization": "0.3", "anthropic-ratelimit-unified-7d-reset": "4000000000"}, io.BytesIO(b"{}"))
urllib.request.urlopen = urlopen
def setting(key):
    return json.loads(${JSON.stringify(JSON.stringify(settings))})[key]
`,
  )
  writeFileSync(join(stubs, "security"), "#!/bin/sh\necho made-up-token\n", { mode: 0o755 })
  const env = scratchEnv(scratch, { PATH: `${stubs}:${process.env.PATH}` })
  const child = Bun.spawn(["python3", "-I", script, "watched@example.org"], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(err).toBe("")
  expect(out).toContain("watched@example.org: 5h none week 30.0%")
  const reading = JSON.parse(
    readFileSync(join(scratch, ".playground", "usage-watched.json"), "utf8"),
  )
  expect(reading.rate_limits).toEqual({ seven_day: { resets_at: 4000000000, used_percentage: 30 } })
})
