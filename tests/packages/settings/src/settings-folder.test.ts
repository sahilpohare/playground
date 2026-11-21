import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { z } from "../../../../packages/settings/node_modules/zod"
import {
  CORE_READ_ONLY,
  defineSettings,
  listSettings,
  readSetting,
  resetSetting,
  setSetting,
  settingHistory,
  extGit,
  extensionsDir,
  jobKey,
  RETIRED,
  scopeDir,
  type Who,
  writeFiles,
} from "../../../../packages/settings/src"

process.env.PLAYGROUND_LOGIN = "made-up-me"
const ME = "made-up-me"
const REPO = join(import.meta.dir, "../../../..")

defineSettings({
  "folderFixture.count": {
    aliases: ["folderFixture.oldCount"],
    default: 1,
    description: "A made-up count.",
    schema: z.number().int().min(0),
  },
  "folderFixture.name": { default: "", description: "A made-up name.", schema: z.string() },
})

const scratch = mkdtempSync(join(tmpdir(), "settings-folder-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))
let n = 0
const fresh = () => join(scratch, `data-${n++}`)

const who = (reason: string, author = "owner"): Who => ({
  actor: "cli",
  author,
  inboxRef: null,
  reason,
})
const set = (data: string, key: string, scope: string, value: unknown, by: Who) =>
  setSetting(data, { key, scope, value }, by)
const file = (data: string, path: string) =>
  JSON.parse(readFileSync(join(extensionsDir(data), path), "utf8"))
const git = (data: string, scope: string, args: string[]) => extGit(scopeDir(data, scope), args)
const commits = (data: string, scope = ME) =>
  git(data, scope, ["rev-list", "--count", "HEAD"]).out.trim()

describe("settings over the extensions folder", () => {
  test("set writes the scope's settings.json in one commit there, by who asked, with the reason, and policy.json at the root", () => {
    const data = fresh()
    expect(set(data, "folderFixture.count", ME, 4, who("four for me"))).toEqual({
      key: "folderFixture.count",
      ok: true,
      scope: ME,
      value: 4,
    })
    set(data, "folderFixture.count", "acme", 6, who("six for acme", "builder"))
    expect(file(data, `${ME}/settings.json`)).toEqual({ "folderFixture.count": 4 })
    expect(file(data, "acme/settings.json")).toEqual({ "folderFixture.count": 6 })
    expect([commits(data), commits(data, "acme")]).toEqual(["1", "1"])
    const head = git(data, "acme", ["log", "-1", "--format=%an%n%s%n%(trailers:only,unfold)"]).out
    expect(head).toContain("builder\nsix for acme\n")
    expect(head).toContain("Setting: folderFixture.count")
    expect(head).toContain("Actor: cli")
    expect(git(data, ME, ["status", "--porcelain"]).out.trim()).toBe("")
    expect(file(data, "policy.json")).toMatchObject({
      orgs: {},
      values: { "folderFixture.count": 4 },
    })
    set(data, "ext.links", ME, { acme: ["acme-inc"] }, who("acme's repos read acme"))
    set(data, "ext.order", ME, ["acme", ME], who("acme first"))
    expect(file(data, "policy.json")).toMatchObject({
      orgs: { "acme-inc": { "folderFixture.count": 6 } },
      values: { "folderFixture.count": 4 },
    })
  })

  test("get reads the login's value over a linked extension's, that one's over the default, and the default when none is set", () => {
    const data = fresh()
    expect(readSetting(data, "folderFixture.count")).toEqual({
      default: 1,
      key: "folderFixture.count",
      rows: [],
      value: 1,
    })
    set(data, "ext.links", ME, { acme: ["acme"] }, who("acme's repos read acme"))
    set(data, "folderFixture.count", "acme", 9, who("acme"))
    expect(readSetting(data, "folderFixture.count")?.value).toBe(1)
    expect(readSetting(data, "folderFixture.count", "acme")?.value).toBe(1)
    set(data, "ext.order", ME, [ME, "acme"], who("acme after me"))
    expect(readSetting(data, "folderFixture.count", "acme")?.value).toBe(9)
    set(data, "folderFixture.count", ME, 2, who("mine"))
    expect(readSetting(data, "folderFixture.count", "acme")?.value).toBe(2)
    set(data, "folderFixture.count", "other", 5, who("not linked"))
    expect(readSetting(data, "folderFixture.count", "acme")?.rows.map((row) => row.scope)).toEqual([
      "acme",
      ME,
      "other",
    ])
    expect(readSetting(data, "folderFixture.nope")).toBeNull()
  })

  test("core reads from the checkout's extensions/core/settings.json, and a write to core is refused as read-only", () => {
    const data = fresh()
    expect(scopeDir(data, "core")).toBe(join(REPO, "extensions/core"))
    expect(JSON.parse(readFileSync(join(REPO, "extensions/core/settings.json"), "utf8"))).toEqual(
      {},
    )
    const refused = set(data, "folderFixture.count", "core", 1, who("x"))
    expect(refused).toEqual({ message: CORE_READ_ONLY, ok: false, status: 409 })
    expect(resetSetting(data, { key: "folderFixture.count", scope: "core" }, who("x"))).toEqual(
      refused,
    )
  })

  test("an alias writes and reads under the current name, and an empty string is a value of its own", () => {
    const data = fresh()
    expect(set(data, "folderFixture.oldCount", ME, 3, who("old name"))).toMatchObject({
      key: "folderFixture.count",
      ok: true,
    })
    expect(readSetting(data, "folderFixture.oldCount")?.value).toBe(3)
    set(data, "folderFixture.name", ME, "", who("unset on purpose"))
    expect(file(data, `${ME}/settings.json`)).toEqual({
      "folderFixture.count": 3,
      "folderFixture.name": "",
    })
  })

  test("a value its schema refuses, a secret, an unknown key or a scope GitHub would not name is refused, and nothing is committed", () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 1, who("first"))
    const refusals = [
      set(data, "folderFixture.count", ME, -1, who("x")),
      set(data, "folderFixture.name", ME, `ghp_${"a".repeat(36)}`, who("x")),
      set(data, "folderFixture.nope", ME, 1, who("x")),
      set(data, "folderFixture.count", "org:acme", 1, who("x")),
      set(data, "folderFixture.count", "../up", 1, who("x")),
    ]
    expect(refusals.map((r) => (r.ok ? "ok" : r.status))).toEqual([400, 400, 400, 400, 400])
    expect(refusals[1]!.ok ? "" : refusals[1]!.message).toContain("a GitHub token")
    expect(commits(data)).toBe("1")
  })

  test("reset drops the key and its aliases from the scope's file, and one at its default is refused", () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 5, who("five"))
    set(data, "folderFixture.name", ME, "kept", who("kept"))
    expect(resetSetting(data, { key: "folderFixture.count", scope: ME }, who("back"))).toEqual({
      key: "folderFixture.count",
      ok: true,
      scope: ME,
    })
    expect(file(data, `${ME}/settings.json`)).toEqual({ "folderFixture.name": "kept" })
    expect(file(data, "policy.json").values).toEqual({ "folderFixture.name": "kept" })
    const again = resetSetting(data, { key: "folderFixture.count", scope: ME }, who("again"))
    expect(again.ok ? 0 : again.status).toBe(409)
    expect(commits(data)).toBe("3")
  })

  test("a key no piece defines stays in its scope's file when another key is written", async () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 2, who("two"))
    await Bun.write(
      join(scopeDir(data, ME), "settings.json"),
      JSON.stringify({ "folderFixture.count": 2, "retired.key": true }),
    )
    set(data, "folderFixture.name", ME, "x", who("x"))
    expect(file(data, `${ME}/settings.json`)["retired.key"]).toBe(true)
    expect(listSettings(data).rows.map((row) => row.key)).toContain("retired.key")
  })

  test("why reads the commits that changed a key, in every scope, under its name and its alias, newest first, with the value before and after", () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 2, who("two"))
    set(data, "folderFixture.name", ME, "y", who("not this key"))
    set(data, "folderFixture.count", ME, 7, who("seven", "builder"))
    resetSetting(data, { key: "folderFixture.count", scope: ME }, who("back to one"))
    const history = settingHistory(data, "folderFixture.oldCount")!
    expect(
      history.map(({ author, newValue, oldValue, reason, scope }) => ({
        author,
        newValue,
        oldValue,
        reason,
        scope,
      })),
    ).toEqual([
      { author: "owner", newValue: null, oldValue: 7, reason: "back to one", scope: ME },
      { author: "builder", newValue: 7, oldValue: 2, reason: "seven", scope: ME },
      { author: "owner", newValue: 2, oldValue: null, reason: "two", scope: ME },
    ])
    expect(history[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(settingHistory(data, "folderFixture.nope")).toBeNull()
  })

  test("list names every defined key with its default and aliases, and every row set", () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 2, who("two"))
    const listed = listSettings(data)
    expect(listed.keys.find((k) => k.key === "folderFixture.count")).toEqual({
      aliases: ["folderFixture.oldCount"],
      default: 1,
      description: "A made-up count.",
      key: "folderFixture.count",
    })
    expect(listed.rows).toEqual([{ key: "folderFixture.count", scope: ME, value: 2 }])
  })

  // A fresh machine's Settings page opens before ext init names a login, so its reads answer the defaults and its writes say what to run.
  test("with no login yet, a read answers the default and a write is refused naming ext init, writing nothing", () => {
    const data = fresh()
    delete process.env.PLAYGROUND_LOGIN
    try {
      expect(readSetting(data, "folderFixture.count")).toMatchObject({ rows: [], value: 1 })
      const refused = {
        message:
          "settings are written to your extensions, which need a login: run playground ext init",
        ok: false,
        status: 409,
      } as const
      expect(set(data, "folderFixture.count", ME, 2, who("two"))).toEqual(refused)
      expect(resetSetting(data, { key: "folderFixture.count", scope: ME }, who("x"))).toEqual(
        refused,
      )
      expect(existsSync(extensionsDir(data))).toBe(false)
    } finally {
      process.env.PLAYGROUND_LOGIN = ME
    }
  })
})

// PG-1196: a job turned on by its enabled field alone is stored as that field alone, and every reader (policy.json, readSetting, which merge-train's own schedule read goes through, and the Settings list the job toggles read) sees the registry's job under it.
describe("a job set by its enabled field alone (PG-1196)", () => {
  test("its row holds enabled alone, while policy.json and readSetting read the whole job, merge-train's schedule included", () => {
    const data = fresh()
    const key = "jobs.opsMergeTrain"
    expect(set(data, key, ME, { enabled: true }, who("turn the train on")).ok).toBe(true)
    expect(file(data, `${ME}/settings.json`)).toEqual({ [key]: { enabled: true } })
    const read = readSetting(data, key)!
    expect(read.rows).toEqual([{ key, scope: ME, value: { enabled: true } }])
    expect(read.value).toEqual({ ...(read.default as object), enabled: true })
    expect((read.value as { schedule: { every: number } }).schedule.every).toBeGreaterThan(0)
    expect(file(data, "policy.json").values[key]).toEqual(read.value)
    expect(listSettings(data).values[key]).toEqual(read.value)
  })

  test("a job the registry does not name is refused at write, and nothing is stored", () => {
    const data = fresh()
    expect(set(data, "jobs.opsMadeUp", ME, { enabled: true }, who("no such job")).ok).toBe(false)
    expect(existsSync(join(extensionsDir(data), ME, "settings.json"))).toBe(false)
  })
})

describe("a job row an older install stored (PG-1439)", () => {
  const key = "jobs.opsSweep"
  const stored = { enabled: true, madeUp: true, runtime: "made-up" }
  // the login's scope holding a row a write refuses: a key the schema does not name, and a runtime other than herdr
  const old = () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 2, who("make the login"))
    writeFiles(
      data,
      ME,
      new Map([["settings.json", JSON.stringify({ "folderFixture.count": 2, [key]: stored })]]),
      { author: "owner", reason: "a row an older install stored" },
    )
    return data
  }

  test("every read hands it out as the render takes it, so a toggle that sends it back lands", () => {
    const data = old()
    const held = readSetting(data, key)!.rows.find((row) => row.scope === ME)!.value
    expect(held).toEqual({ enabled: true, runtime: "herdr" })
    expect(listSettings(data).rows.find((row) => row.key === key)!.value).toEqual(held)
    expect(readSetting(data, key)!.value).toMatchObject({ enabled: true, runtime: "herdr" })
    const toggled = set(data, key, ME, { ...(held as object), enabled: false }, who("turn it off"))
    expect(toggled.ok).toBe(true)
    expect(file(data, `${ME}/settings.json`)[key]).toEqual({ enabled: false, runtime: "herdr" })
  })

  test("a write that adds a key the schema does not name is still refused, and the stored row stays", () => {
    const data = old()
    expect(set(data, key, ME, { enabled: false, madeUp: true }, who("a misspelled key"))).toEqual({
      message: expect.stringContaining('Unrecognized key: "madeUp"'),
      ok: false,
      status: 400,
    })
    expect(file(data, `${ME}/settings.json`)[key]).toEqual(stored)
  })
})

describe("a retired job's stored row (#2339)", () => {
  test.each(RETIRED.map(jobKey))("reset takes %s out and answers ok", (key) => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 2, who("make the login"))
    const stored = { ...file(data, `${ME}/settings.json`), [key]: { enabled: true } }
    writeFiles(data, ME, new Map([["settings.json", JSON.stringify(stored)]]), {
      author: "owner",
      reason: "a row kept from before the job retired",
    })
    expect(resetSetting(data, { key, scope: ME }, who("clear the retired row"))).toEqual({
      key,
      ok: true,
      scope: ME,
    })
    expect(file(data, `${ME}/settings.json`)).toEqual({ "folderFixture.count": 2 })
  })
})

describe("an org's own job row (PG-1363)", () => {
  const key = "jobs.opsWatch"
  const row = {
    callsModel: false,
    command: "{bun} --no-env-file {data}/ops/ops-watch/cli.ts",
    config: { prefixes: ["INC"] },
    description: "Watches an org's own queue.",
    enabled: true,
    heartbeat: "ops-watch",
    schedule: { every: 60 },
  }
  // a data folder whose acme scope ships the ops-watch script folder
  const shipped = () => {
    const data = fresh()
    set(data, "folderFixture.count", ME, 2, who("make the login"))
    writeFiles(data, "acme", new Map([["scripts/ops-watch/cli.ts", "console.log(1)"]]), {
      author: "owner",
      reason: "ship the script",
    })
    return data
  }

  test("set writes a row the render takes at the org's scope, and reset takes it out", () => {
    const data = shipped()
    expect(set(data, key, "acme", row, who("run acme's watch"))).toEqual({
      key,
      ok: true,
      scope: "acme",
      value: row,
    })
    expect(file(data, "acme/settings.json")[key]).toEqual(row)
    expect(resetSetting(data, { key, scope: "acme" }, who("stop acme's watch")).ok).toBe(true)
    expect(file(data, "acme/settings.json")[key]).toBeUndefined()
  })

  test.each([
    [
      "a script folder the org does not ship",
      { ...row, command: "{bun} {data}/ops/other/cli.ts" },
      "its command must run a script in a folder its org ships",
    ],
    ["a stop group", { ...row, stop: "dashboard" }, "an org's job names no stop group"],
    [
      "another job's heartbeat",
      { ...row, heartbeat: "ops-dashboard" },
      "its heartbeat must be its own name",
    ],
    ["a value that is no job", { enabled: true }, "heartbeat Invalid input"],
  ])(
    "a row with %s is refused with the render's reason, and nothing is stored",
    (_, value, why) => {
      const data = shipped()
      const result = set(data, key, "acme", value, who("a bad row"))
      expect(result).toMatchObject({ ok: false })
      expect("message" in result && result.message).toContain(why)
      expect(existsSync(join(extensionsDir(data), "acme", "settings.json"))).toBe(false)
    },
  )

  test("a row an older install stored is handed out as the render takes it, so a second org's row for its job is still refused (PG-1439)", () => {
    const data = shipped()
    const stored = { ...row, madeUp: true, runtime: "made-up" }
    writeFiles(data, "acme", new Map([["settings.json", JSON.stringify({ [key]: stored })]]), {
      author: "owner",
      reason: "a row an older install stored",
    })
    writeFiles(data, "aaa", new Map([["scripts/ops-watch/cli.ts", "console.log(2)"]]), {
      author: "owner",
      reason: "ship the script",
    })
    const held = listSettings(data).rows.find((each) => each.key === key && each.scope === "acme")
    expect(held!.value).toEqual({ ...row, runtime: "herdr" })
    const result = set(data, key, "aaa", row, who("run aaa's watch"))
    expect(result).toMatchObject({ ok: false })
    expect("message" in result && result.message).toContain("acme already adds ops-watch")
    expect(file(data, "acme/settings.json")[key]).toEqual(stored)
  })

  test("a second org's row for a job another org adds is refused with the render's reason, so an org earlier in A to Z order cannot take it over", () => {
    const data = shipped()
    writeFiles(data, "aaa", new Map([["scripts/ops-watch/cli.ts", "console.log(2)"]]), {
      author: "owner",
      reason: "ship the script",
    })
    expect(set(data, key, "acme", row, who("run acme's watch")).ok).toBe(true)
    const result = set(data, key, "aaa", row, who("run aaa's watch"))
    expect(result).toMatchObject({ ok: false })
    expect("message" in result && result.message).toContain("acme already adds ops-watch")
    expect(existsSync(join(extensionsDir(data), "aaa", "settings.json"))).toBe(false)
    expect(set(data, key, "acme", { ...row, enabled: false }, who("pause acme's watch")).ok).toBe(
      true,
    )
  })

  test("the login's scope takes no row for a job the registry lacks", () => {
    const data = shipped()
    const result = set(data, key, ME, row, who("at the login"))
    expect(result).toMatchObject({ ok: false })
    expect(file(data, `${ME}/settings.json`)[key]).toBeUndefined()
  })
})
