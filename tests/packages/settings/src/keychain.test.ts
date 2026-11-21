import { afterAll, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  hasSecret,
  removeSecret,
  settingsFor,
  storeSecret,
} from "../../../../packages/settings/src"

// A fake security first on PATH: it logs each argv and its stdin, holds one item per service and account, and fails a command when FAKE_SECURITY_FAIL is set.
const bin = mkdtempSync(join(tmpdir(), "keychain-"))
const log = join(bin, "log")
writeFileSync(
  join(bin, "security"),
  `#!/bin/sh
printf 'argv %s\\n' "$*" >> "${log}"
[ "$1" = -i ] && { printf 'stdin %s' "$(cat)" >> "${log}"; printf '\\n' >> "${log}"; }
[ -n "$FAKE_SECURITY_FAIL" ] && { echo "refused" >&2; exit 1; }
case "$*" in *"-a have@example.test"*|*"-a zai"*|-i) exit 0 ;; esac
exit 44
`,
)
chmodSync(join(bin, "security"), 0o755)
const path = process.env.PATH
process.env.PATH = `${bin}:${path}`
afterAll(() => {
  process.env.PATH = path
  rmSync(bin, { force: true, recursive: true })
})
beforeEach(() => {
  writeFileSync(log, "")
  delete process.env.FAKE_SECURITY_FAIL
})

const settings = settingsFor(
  [{ key: "usage.keychainService", scope: "me", value: "acme-claude" }],
  "me",
)
const logged = () => readFileSync(log, "utf8")

test("storeSecret hands the secret to security -i on stdin, under each provider's service", () => {
  storeSecret(settings, "claude", "have@example.test", "sk-ant-oat01-made_up")
  storeSecret(settings, "glm", "zai", "made.up")
  expect(logged()).toBe(
    [
      "argv -i",
      'stdin add-generic-password -U -s "acme-claude" -a "have@example.test" -w "sk-ant-oat01-made_up"',
      "argv -i",
      'stdin add-generic-password -U -s "playground-glm" -a "zai" -w "made.up"',
      "",
    ].join("\n"),
  )
})

test("storeSecret refuses a secret or key that would leave its quotes, and a refused write", () => {
  expect(() => storeSecret(settings, "glm", "zai", 'x" -A "y')).toThrow("no token or key holds")
  expect(() => storeSecret(settings, "glm", 'zai" -A "', "made.up")).toThrow("not an email")
  expect(logged()).toBe("")
  process.env.FAKE_SECURITY_FAIL = "1"
  expect(() => storeSecret(settings, "glm", "zai", "made.up")).toThrow(
    "the secret store refused the playground-glm item for zai",
  )
})

test("hasSecret reads attributes alone and removeSecret says whether an item was there", () => {
  expect(hasSecret(settings, "claude", "have@example.test")).toBe(true)
  expect(hasSecret(settings, "claude", "none@example.test")).toBe(false)
  expect(removeSecret(settings, "glm", "zai")).toBe(true)
  expect(removeSecret(settings, "glm", "other")).toBe(false)
  expect(logged()).not.toContain("-w")
  expect(logged()).toContain("argv find-generic-password -s acme-claude -a have@example.test")
  expect(logged()).toContain("argv delete-generic-password -s playground-glm -a zai")
})

test("with a record file, each secret is kept as its sha256 alone and security is never run", () => {
  const record = join(bin, "record", "keychain-record.json")
  const keychain = { record }
  storeSecret(settings, "claude", "made-up@example.test", "sk-ant-oat01-made_up", keychain)
  storeSecret(settings, "glm", "zai", "made.up", keychain)
  expect(hasSecret(settings, "claude", "made-up@example.test", keychain)).toBe(true)
  expect(hasSecret(settings, "glm", "other", keychain)).toBe(false)
  const kept = readFileSync(record, "utf8")
  expect(kept).not.toContain("sk-ant-oat01-made_up")
  expect(JSON.parse(kept)).toEqual({
    "claude:made-up@example.test": createHash("sha256")
      .update("sk-ant-oat01-made_up")
      .digest("hex"),
    "glm:zai": createHash("sha256").update("made.up").digest("hex"),
  })
  expect(removeSecret(settings, "glm", "zai", keychain)).toBe(true)
  expect(removeSecret(settings, "glm", "zai", keychain)).toBe(false)
  expect(Object.keys(JSON.parse(readFileSync(record, "utf8")))).toEqual([
    "claude:made-up@example.test",
  ])
  expect(logged()).toBe("")
})

test("on Linux each call goes through the factory's own security, which keeps the item in the data folder's store", () => {
  const cli = join(import.meta.dir, "../../../../packages/scripts/src/security/cli.ts")
  const shim = join(bin, "shim")
  const data = join(bin, "shim-data")
  mkdirSync(shim)
  writeFileSync(join(shim, "security"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`)
  chmodSync(join(shim, "security"), 0o755)
  const was = { data: process.env.PLAYGROUND_DATA_DIR, path: process.env.PATH }
  process.env.PATH = `${shim}:${path}`
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    storeSecret(settings, "claude", "made-up@example.test", "sk-ant-oat01-made_up")
    const item = join(data, "secrets", "keychain", "acme-claude", "made-up%40example%2Etest")
    expect(readFileSync(item, "utf8")).toBe("sk-ant-oat01-made_up")
    expect(statSync(item).mode & 0o777).toBe(0o600)
    expect(hasSecret(settings, "claude", "made-up@example.test")).toBe(true)
    expect(removeSecret(settings, "claude", "made-up@example.test")).toBe(true)
    expect(hasSecret(settings, "claude", "made-up@example.test")).toBe(false)
  } finally {
    process.env.PATH = was.path
    if (was.data === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = was.data
  }
})
