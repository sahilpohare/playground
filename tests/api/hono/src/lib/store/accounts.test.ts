import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadFixture, writeFixture } from "../../../../../../api/hono/src/lib/dashboard/fixture"
import {
  addAccount,
  hasGlmAccount,
  listAccounts,
  removeAccount,
} from "../../../../../../api/hono/src/lib/store/accounts"
import { readSetting, setSetting } from "../../../../../../packages/settings/src/settings-folder"
import { liveReads } from "../../../../../live-reads"

// The live branch reaches the Keychain through the fake security below; the fixture cases turn live reads off for themselves.
liveReads()

const TOKEN = "sk-ant-fake-token"
const GLM_KEY = "made.up.glm.key"

// A fake security first on PATH: it logs each argv and its stdin, and keeps one line per service and account in a file, so find answers what add left.
const bin = mkdtempSync(join(tmpdir(), "accounts-"))
const log = join(bin, "log")
const items = join(bin, "items")
writeFileSync(
  join(bin, "security"),
  `#!/bin/sh
printf 'argv %s\\n' "$*" >> "${log}"
touch "${items}"
if [ "$1" = -i ]; then
  input=$(cat); printf 'stdin %s\\n' "$input" >> "${log}"
  echo "$input" | sed -E 's/.*-s "([^"]*)" -a "([^"]*)".*/\\1 \\2/' >> "${items}"; exit 0
fi
case "$1" in
  find-generic-password) grep -qx "$3 $5" "${items}" ;;
  delete-generic-password) grep -qx "$3 $5" "${items}" && { grep -vx "$3 $5" "${items}" > "${items}.new"; mv "${items}.new" "${items}"; } ;;
  *) exit 1 ;;
esac
`,
)
chmodSync(join(bin, "security"), 0o755)
const path = process.env.PATH
const login = process.env.PLAYGROUND_LOGIN
process.env.PATH = `${bin}:${path}`
process.env.PLAYGROUND_LOGIN = "made-up-me"
afterAll(() => {
  process.env.PATH = path
  if (login === undefined) delete process.env.PLAYGROUND_LOGIN
  else process.env.PLAYGROUND_LOGIN = login
  rmSync(bin, { force: true, recursive: true })
})
beforeEach(() => {
  writeFileSync(log, "")
  writeFileSync(items, "")
})

let n = 0
const fresh = () => join(bin, `data-${n++}`)
const who = (reason: string) => ({ actor: "test", author: "owner", inboxRef: null, reason })
const logged = () => readFileSync(log, "utf8")
const argvs = () =>
  logged()
    .split("\n")
    .filter((line) => line.startsWith("argv "))
const listed = (data: string) => readSetting(data, "usage.accounts")?.value

describe("Settings' accounts on a stack that reads this machine", () => {
  test("add lists a Claude row and hands its token to the Keychain on stdin alone, never in an argv or the answer", () => {
    const data = fresh()
    const added = addAccount(
      { email: "made-up@example.test", label: "work", provider: "claude", token: TOKEN },
      who("add"),
      data,
    )
    expect(added).toEqual({
      account: {
        email: "made-up@example.test",
        key: "made-up@example.test",
        label: "work",
        own: false,
        provider: "claude",
        stored: true,
      },
      ok: true,
    })
    expect(JSON.stringify(added)).not.toContain(TOKEN)
    expect(listed(data)).toEqual([
      { email: "made-up@example.test", label: "work", provider: "claude" },
    ])
    expect(logged()).toContain(
      `stdin add-generic-password -U -s "playground-claude-oauth" -a "made-up@example.test" -w "${TOKEN}"`,
    )
    expect(argvs().join("\n")).not.toContain(TOKEN)
    expect(existsSync(join(data, "keychain-record.json"))).toBe(false)
  })

  test("the record branch is the stack's own choice: an input naming a record still reaches security", () => {
    const data = fresh()
    const record = join(data, "asked-record.json")
    const input = { label: "zai", provider: "glm", record, token: GLM_KEY } as const
    expect(addAccount(input, who("add"), data)).toMatchObject({ ok: true })
    expect(logged()).toContain(`-a "zai" -w "${GLM_KEY}"`)
    expect(existsSync(record)).toBe(false)
    expect(existsSync(join(data, "keychain-record.json"))).toBe(false)
  })

  test("a GLM key is listed and kept by its label, and the list says whose token is kept", () => {
    const data = fresh()
    addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("add"), data)
    addAccount(
      { email: "made-up@example.test", provider: "claude", token: TOKEN },
      who("add"),
      data,
    )
    writeFileSync(items, "playground-glm zai\n")
    expect(listAccounts(data)).toEqual([
      { email: null, key: "zai", label: "zai", own: false, provider: "glm", stored: true },
      {
        email: "made-up@example.test",
        key: "made-up@example.test",
        label: null,
        own: false,
        provider: "claude",
        stored: false,
      },
    ])
    expect(argvs()).toContain("argv find-generic-password -s playground-glm -a zai")
    expect(logged()).not.toContain(" -w playground")
  })

  test("the list says which Claude rows set own, the mark Settings' Own account switch writes", () => {
    const data = fresh()
    addAccount(
      { email: "made-up@example.test", provider: "claude", token: TOKEN },
      who("add"),
      data,
    )
    addAccount({ email: "other@example.test", provider: "claude", token: TOKEN }, who("add"), data)
    const rows = listed(data) as Record<string, unknown>[]
    const marked = rows.map((row) =>
      row.email === "other@example.test" ? { ...row, own: true } : row,
    )
    expect(
      setSetting(data, { key: "usage.accounts", scope: "made-up-me", value: marked }, who("own")),
    ).toMatchObject({ ok: true })
    expect(listAccounts(data).map((row) => [row.key, row.own])).toEqual([
      ["made-up@example.test", false],
      ["other@example.test", true],
    ])
  })

  test("hasGlmAccount reads a GLM row in usage.accounts without the Keychain", () => {
    const data = fresh()
    expect(hasGlmAccount(data)).toBe(false)
    addAccount(
      { email: "made-up@example.test", provider: "claude", token: TOKEN },
      who("add"),
      data,
    )
    expect(hasGlmAccount(data)).toBe(false)
    addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("add"), data)
    writeFileSync(log, "")
    expect(hasGlmAccount(data)).toBe(true)
    expect(logged()).toBe("")
  })

  test("an account listed already with its token kept, or a row its schema refuses, stores nothing", () => {
    const data = fresh()
    addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("add"), data)
    writeFileSync(log, "")
    expect(
      addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("again"), data),
    ).toEqual({ message: "zai is already listed", ok: false, status: 409 })
    const bad = addAccount(
      { label: "Not A Label", provider: "glm", token: GLM_KEY },
      who("bad"),
      data,
    )
    expect(bad).toMatchObject({ ok: false, status: 400 })
    expect(logged()).not.toContain("add-generic-password")
  })

  test("a row listed with no token kept, as one carried over from another machine, keeps the token and stays as it is", () => {
    const data = fresh()
    const row = { email: "made-up@example.test", label: "mac", provider: "claude" }
    setSetting(data, { key: "usage.accounts", scope: "made-up-me", value: [row] }, who("carry"))
    expect(
      addAccount(
        { email: "made-up@example.test", provider: "claude", token: TOKEN },
        who("sign in"),
        data,
      ),
    ).toEqual({
      account: {
        email: "made-up@example.test",
        key: "made-up@example.test",
        label: "mac",
        own: false,
        provider: "claude",
        stored: true,
      },
      ok: true,
    })
    expect(logged()).toContain(
      `stdin add-generic-password -U -s "playground-claude-oauth" -a "made-up@example.test" -w "${TOKEN}"`,
    )
    expect(listed(data)).toEqual([row])
  })

  test("a refused token is not saved and its words never echo it", () => {
    const data = fresh()
    const refused = addAccount(
      { label: "zai", provider: "glm", token: 'made"up' },
      who("add"),
      data,
    )
    expect(refused).toMatchObject({ ok: false, status: 400 })
    expect(JSON.stringify(refused)).not.toContain('made"up')
    expect(listed(data)).toEqual([])
  })

  test("remove drops the row, then its Keychain item", () => {
    const data = fresh()
    addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("add"), data)
    expect(removeAccount("glm", "zai", who("remove"), data)).toEqual({
      key: "zai",
      ok: true,
      provider: "glm",
    })
    expect(listed(data)).toEqual([])
    expect(argvs()).toContain("argv delete-generic-password -s playground-glm -a zai")
    expect(removeAccount("glm", "zai", who("remove"), data)).toEqual({
      message: "no glm account zai",
      ok: false,
      status: 404,
    })
  })

  test("with no login for the settings, the list is empty and a write says how to set one up", () => {
    delete process.env.PLAYGROUND_LOGIN
    try {
      const data = fresh()
      expect(listAccounts(data)).toEqual([])
      expect(
        addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("add"), data),
      ).toMatchObject({
        message:
          "Accounts are kept in your settings, which are not set up yet: click Set up settings",
        status: 409,
      })
      expect(logged()).toBe("")
    } finally {
      process.env.PLAYGROUND_LOGIN = "made-up-me"
    }
  })
})

describe("Settings' accounts on a fixture stack", () => {
  test("the shipped fixture lists a made-up Claude and GLM account under a made-up login, and Add works there", () => {
    delete process.env.PLAYGROUND_LIVE_READS
    delete process.env.PLAYGROUND_LOGIN
    try {
      const loaded = loadFixture(null)
      if (!loaded.ok) throw new Error(loaded.error)
      const dir = join(bin, `fixture-${n++}`)
      writeFixture(loaded.fixture, dir, {
        home: join(bin, "home"),
        main: join(bin, "main"),
        trash: join(bin, "data", "trash"),
      })
      const data = join(dir, "claude", "playground")
      expect(listAccounts(data).map(({ key, provider }) => `${provider}:${key}`)).toEqual([
        "claude:pat@example.com",
        "glm:zai",
      ])
      expect(
        addAccount({ label: "zai-2", provider: "glm", token: GLM_KEY }, who("add"), data),
      ).toMatchObject({ ok: true })
      expect(listAccounts(data).at(-1)).toEqual({
        email: null,
        key: "zai-2",
        label: "zai-2",
        own: false,
        provider: "glm",
        stored: true,
      })
      expect(logged()).toBe("")
    } finally {
      process.env.PLAYGROUND_LIVE_READS = "1"
      process.env.PLAYGROUND_LOGIN = "made-up-me"
    }
  })

  test("add, list and remove keep a sha256 in the data folder and never run security", () => {
    delete process.env.PLAYGROUND_LIVE_READS
    try {
      const data = fresh()
      addAccount({ label: "zai", provider: "glm", token: GLM_KEY }, who("add"), data)
      expect(listAccounts(data)).toEqual([
        { email: null, key: "zai", label: "zai", own: false, provider: "glm", stored: true },
      ])
      const record = readFileSync(join(data, "keychain-record.json"), "utf8")
      expect(Object.keys(JSON.parse(record))).toEqual(["glm:zai"])
      expect(record).not.toContain(GLM_KEY)
      removeAccount("glm", "zai", who("remove"), data)
      expect(JSON.parse(readFileSync(join(data, "keychain-record.json"), "utf8"))).toEqual({})
      expect(logged()).toBe("")
    } finally {
      process.env.PLAYGROUND_LIVE_READS = "1"
    }
  })
})
