import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { stubs, usageReading } from "../../../../../packages/scripts/src/new-user-gate/stubs"

const box = realpathSync(mkdtempSync(join(tmpdir(), "gate-stubs-")))
afterAll(() => rmSync(box, { force: true, recursive: true }))

// The box's stand-ins, with a real bunx that logs what it was handed
const bin = join(box, "bin")
for (const [name, text] of Object.entries(stubs(box, join(bin, "real-bunx")))) {
  await Bun.write(join(bin, name), text)
  chmodSync(join(bin, name), 0o755)
}
writeFileSync(join(bin, "real-bunx"), `#!/bin/sh\necho "real $*"\n`)
chmodSync(join(bin, "real-bunx"), 0o755)
const call = (name: string, ...args: string[]) => {
  const out = Bun.spawnSync([join(bin, name), ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  return { code: out.exitCode, out: out.stdout.toString() }
}

test("the box's systemctl and loginctl refuse every call and log it, so the box's jobs render never reaches the user's live manager", () => {
  expect(call("systemctl", "--user", "stop", "com.playground.ops-tick.service").code).toBe(1)
  expect(call("loginctl", "enable-linger", "1000").code).toBe(1)
  const calls = readFileSync(join(box, "calls.log"), "utf8")
  expect(calls).toContain("systemctl --user stop com.playground.ops-tick.service\n")
  expect(calls).toContain("loginctl enable-linger 1000\n")
})

test("the box's bunx hands every call to the real one", () => {
  expect(call("bunx", "portless", "get", "playground").out).toBe("real portless get playground\n")
})

describe("the gate's gh stand-in", () => {
  test("answers a made-up login and logs a PR's create, so the route step can see it", () => {
    expect(call("gh", "api", "user").out).toBe("gate-user\n")
    expect(call("gh", "pr", "create", "--fill").code).toBe(0)
    expect(readFileSync(join(box, "calls.log"), "utf8")).toContain("gh pr create --fill")
  })
})

describe("the gate's claude stand-in", () => {
  test("answers a call that names no session at once, as an install's checks make it", () => {
    expect(call("claude", "auth", "status")).toEqual({ code: 0, out: '{"loggedIn": true}\n' })
    expect(call("claude", "--version").code).toBe(0)
  })
})

describe("usageReading", () => {
  test("seeds a stored login in the Keychain file and answers usage with both windows resetting after now", () => {
    const now = Date.parse("2026-10-31T00:00:00Z")
    const reading = usageReading("gate", now)
    const [service, account, secret] = reading.keychain.trimEnd().split("\t")
    expect([service, account]).toEqual(["Claude Code-credentials", "gate"])
    expect(JSON.parse(secret!).claudeAiOauth.expiresAt).toBeGreaterThan(now)
    expect(reading.usage).toEqual({
      five_hour: { resets_at: "2026-10-31T03:00:00+00:00", utilization: 5 },
      seven_day: { resets_at: "2026-11-05T00:00:00+00:00", utilization: 10 },
    })
  })
})
