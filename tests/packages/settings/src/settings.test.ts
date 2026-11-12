import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

import { z } from "../../../../packages/settings/node_modules/zod"
import {
  checkSetting,
  defineSettings,
  extChain,
  extScopeSchema,
  guardedOrgs,
  KINDS,
  resolveKey,
  SCHEMA_VERSION,
  settingFields,
  settingsFor,
} from "../../../../packages/settings/src"

// A fixture key registered the way a piece adds its knobs, so the path is proved with no real key added early.
const fixture = defineSettings({
  "fixture.limit": {
    aliases: ["fixture.oldLimit"],
    default: 3,
    description: "A made-up limit.",
    schema: z.number().int().min(0),
  },
  "fixture.name": { default: "none", description: "A made-up name.", schema: z.string() },
})

describe("defineSettings", () => {
  test("every settings file that defines keys loads from the index, so a key two files define throws there", async () => {
    const src = join(import.meta.dir, "../../../../packages/settings/src")
    const index = await Bun.file(join(src, "index.ts")).text()
    for (const file of readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "settings.ts")) {
      const text = await Bun.file(join(src, file)).text()
      if (text.includes("defineSettings("))
        expect([file, index.includes(`from "@/${file.slice(0, -3)}"`)]).toEqual([file, true])
    }
  })

  test("registers each key, and a typed reader returns its default until a row sets it", () => {
    expect(
      settingFields()
        .map(({ key }) => key)
        .filter((key) => !key.startsWith("jobs.")),
    ).toEqual([
      "battery.alert",
      "battery.ask",
      "channel.skipUser",
      "channel.slackId",
      "clock.ownerZone",
      "context.window",
      "ext.bundled",
      "ext.links",
      "ext.order",
      "ext.repos",
      "factory.archiveRepo",
      "factory.publicRepo",
      "factory.repo",
      "fixture.limit",
      "fixture.name",
      "gates.glmLoad5Max",
      "gates.glmSwapinsMax",
      "gates.memoryFreeMin",
      "gates.reviewReserve",
      "gates.smallReserve",
      "gates.startsWindow",
      "github.pollMinutes",
      "glm.readOnlyLoad5",
      "harness.alpha",
      "live.branch",
      "live.container",
      "models.checker",
      "models.claude",
      "models.default",
      "models.glm",
      "models.glmKeychainService",
      "models.probe",
      "owner.names",
      "paths.codeRoot",
      "release.hours",
      "release.merges",
      "sessions.aliases",
      "sessions.names",
      "sessions.templates",
      "slack.dmChannel",
      "slack.dmOwner",
      "slack.gatedSends",
      "slack.linkConverter",
      "slack.mode",
      "slack.sendServer",
      "slots.modelBound",
      "slots.peers",
      "tickets.tracker",
      "unstick.escalateMinutes",
      "usage.accounts",
      "usage.keychainService",
      "usage.switchAccount",
      "wa.device",
      "wa.owner",
    ])
    const zone = settingFields().find(({ key }) => key === "clock.ownerZone")!.field.schema
    expect(zone.safeParse("Asia/Kolkata").success).toBe(true)
    expect(zone.safeParse("Mars/Base").success).toBe(false)
    const unset = settingsFor([], "me")
    expect(fixture.get(unset, "fixture.limit")).toBe(3)
    const set = settingsFor([{ key: "fixture.limit", scope: "me", value: 7 }], "me")
    expect(fixture.get(set, "fixture.limit")).toBe(7)
    expect(set.schemaVersion).toBe(SCHEMA_VERSION)
  })

  test("refuses a key or an alias defined twice, and a default its schema refuses", () => {
    const again = { default: 1, description: "", schema: z.number() }
    expect(() => defineSettings({ "fixture.limit": again })).toThrow("defined twice")
    expect(() => defineSettings({ "fixture.oldLimit": again })).toThrow("defined twice")
    expect(() =>
      defineSettings({
        "fixture.bad": { default: -1, description: "", schema: z.number().min(0) },
      }),
    ).toThrow()
  })

  test("refuses a schema that takes null, since null stands for no value in a scope", () => {
    expect(() =>
      defineSettings({
        "fixture.nullable": { default: "a", description: "", schema: z.string().nullable() },
      }),
    ).toThrow("takes null")
    expect(() =>
      defineSettings({ "fixture.anything": { default: 1, description: "", schema: z.unknown() } }),
    ).toThrow("takes null")
    expect(resolveKey("fixture.nullable")).toBeUndefined()
  })
})

describe("checkSetting", () => {
  test("parses a value by its key's schema, through an alias to the current name", () => {
    expect(checkSetting("fixture.oldLimit", 4)).toEqual({
      key: "fixture.limit",
      ok: true,
      value: 4,
    })
    expect(resolveKey("fixture.oldLimit")).toBe("fixture.limit")
  })

  test("refuses an unknown key, a value of the wrong type and a secret-shaped value", () => {
    expect(checkSetting("fixture.nope", 1)).toMatchObject({ ok: false })
    expect(checkSetting("fixture.limit", "four")).toMatchObject({ ok: false })
    const secret = checkSetting("fixture.name", `ghp_${"a".repeat(36)}`)
    expect(secret).toMatchObject({ ok: false })
    expect(secret.ok || secret.message).toContain("a GitHub token")
  })
})

describe("settingsFor", () => {
  test("an extension earlier in the order beats a later one, core comes last before the default, and an extension the repo's org does not link is left out", () => {
    const rows = [
      { key: "ext.links", scope: "me", value: { acme: ["acme"], corp: ["*"] } },
      { key: "ext.order", scope: "me", value: ["acme", "me", "corp", "other"] },
      { key: "fixture.limit", scope: "core", value: 5 },
      { key: "fixture.name", scope: "core", value: "core" },
      { key: "fixture.limit", scope: "acme", value: 2 },
      { key: "fixture.limit", scope: "other", value: 9 },
      { key: "fixture.name", scope: "corp", value: "corp" },
      { key: "fixture.name", scope: "acme", value: "us" },
    ]
    expect(settingsFor(rows, "me", "Acme").values).toMatchObject({
      "fixture.limit": 2,
      "fixture.name": "us",
    })
    expect(settingsFor(rows, "me").values).toMatchObject({
      "fixture.limit": 5,
      "fixture.name": "corp",
    })
    expect(settingsFor(rows.slice(2, 4), "me").values).toEqual({
      "fixture.limit": 5,
      "fixture.name": "core",
    })
  })

  test("the order and links come from the login's scope over core's, never another extension's", () => {
    const rows = [
      { key: "ext.links", scope: "core", value: { corp: ["*"] } },
      { key: "ext.order", scope: "core", value: ["corp"] },
      { key: "ext.order", scope: "corp", value: ["other"] },
      { key: "ext.links", scope: "corp", value: { other: ["*"] } },
      { key: "fixture.limit", scope: "corp", value: 4 },
      { key: "fixture.limit", scope: "other", value: 8 },
    ]
    expect(settingsFor(rows, "me").values).toEqual({
      "ext.links": { corp: ["*"] },
      "ext.order": ["corp"],
      "fixture.limit": 4,
    })
  })

  test("a key set under its current name beats its alias at the same scope, and an alias alone reads through", () => {
    const both = [
      { key: "fixture.oldLimit", scope: "me", value: 1 },
      { key: "fixture.limit", scope: "me", value: 2 },
    ]
    expect(settingsFor(both, "me").values["fixture.limit"]).toBe(2)
    expect(settingsFor(both.slice(0, 1), "me").values["fixture.limit"]).toBe(1)
  })

  test("a row no piece defines, or whose value its schema now refuses, is left out", () => {
    const rows = [
      { key: "fixture.gone", scope: "me", value: 1 },
      { key: "fixture.limit", scope: "me", value: "x" },
    ]
    expect(settingsFor(rows, "me").values).toEqual({})
  })
})

describe("extChain", () => {
  test("the login's is read everywhere, first unless the order places it, each other extension only where linked, and core last", () => {
    expect(extChain({}, "me")).toEqual(["me", "core"])
    expect(extChain({}, "")).toEqual(["core"])
    const values = {
      "ext.links": { acme: ["acme"], corp: ["*"] },
      "ext.order": ["acme", "corp", "spare"],
    }
    expect(extChain(values, "me", "acme")).toEqual(["me", "acme", "corp", "core"])
    expect(extChain(values, "me", "other")).toEqual(["me", "corp", "core"])
    expect(extChain(values, "me")).toEqual(["me", "corp", "core"])
    const placed = { "ext.links": { corp: ["*"], me: [] }, "ext.order": ["corp", "me"] }
    expect(extChain(placed, "me", "acme")).toEqual(["corp", "me", "core"])
  })

  test("an order naming one twice, or a link GitHub would not name, reads as unset", () => {
    expect(checkSetting("ext.order", ["me", "me"]).ok).toBe(false)
    expect(checkSetting("ext.links", { acme: ["Acme"] }).ok).toBe(false)
    expect(checkSetting("ext.links", { core: ["*"] }).ok).toBe(false)
    expect(extChain({ "ext.order": ["acme", "acme"] }, "me")).toEqual(["me", "core"])
  })
})

test("the guarded orgs are every org a link names, * aside, A to Z, and none with no links", () => {
  expect(guardedOrgs({})).toEqual([])
  expect(guardedOrgs({ "ext.links": { a: ["zeta", "*"], b: ["acme", "zeta"] } })).toEqual([
    "acme",
    "zeta",
  ])
  expect(() => guardedOrgs({ "ext.links": { a: ["Not An Org"] } })).toThrow()
})

test("an extension's scope is a GitHub login or org's name but never core, and the kinds run A to Z", () => {
  for (const scope of ["me", "made-up-me", "Acme1", "a".repeat(39)])
    expect(extScopeSchema.safeParse(scope).success).toBe(true)
  for (const scope of [
    "",
    "core",
    "org:acme",
    "-acme",
    "acme-",
    "a--b",
    "a/b",
    "..",
    "a".repeat(40),
  ])
    expect(extScopeSchema.safeParse(scope).success).toBe(false)
  expect([...KINDS]).toEqual([...KINDS].sort())
  expect(KINDS).toContain("script")
})
