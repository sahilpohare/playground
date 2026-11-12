import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  linkExtension,
  listBundled,
  listExtensions,
  orderExtensions,
  readSetting,
  removeExtension,
  scopeDir,
  setBundled,
  setSetting,
  unlinkExtension,
  type Who,
} from "../../../../packages/settings/src"

process.env.PLAYGROUND_LOGIN = "made-up-me"
const ME = "made-up-me"

const scratch = mkdtempSync(join(tmpdir(), "extensions-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))
let n = 0

const WHO: Who = { actor: "cli", author: "owner", inboxRef: null, reason: "arranged" }

// A data folder with the login's extension and acme's and corp's, each a clone holding one setting.
const fresh = () => {
  const data = join(scratch, `data-${n++}`)
  for (const scope of [ME, "acme", "corp"])
    setSetting(data, { key: "clock.ownerZone", scope, value: "Europe/Lisbon" }, WHO)
  return data
}

const value = (data: string, key: string) => readSetting(data, key)?.value

test("list names each extension in order with its links, repo and counts, the login first and core last", () => {
  const data = fresh()
  expect(listExtensions(data)).toEqual([
    {
      counts: {},
      links: ["*"],
      login: true,
      name: ME,
      repo: `${ME}/playground-${ME}`,
      syncedAt: null,
    },
    expect.objectContaining({ links: ["*"], name: "core", repo: null, syncedAt: null }),
  ])
  linkExtension(data, "acme", "Acme-Inc", WHO)
  setSetting(data, { key: "ext.repos", scope: ME, value: { acme: "acme-inc/shared" } }, WHO)
  expect(listExtensions(data).map(({ links, name, repo }) => ({ links, name, repo }))).toEqual([
    { links: ["*"], name: ME, repo: `${ME}/playground-${ME}` },
    { links: ["acme-inc"], name: "acme", repo: "acme-inc/shared" },
    { links: ["*"], name: "core", repo: null },
  ])
})

test("link adds an org, lowercase, or *, and puts an extension not yet in the order last in it", () => {
  const data = fresh()
  expect(linkExtension(data, "acme", "Acme-Inc", WHO).ok).toBe(true)
  expect(linkExtension(data, "acme", "*", WHO).ok).toBe(true)
  expect(value(data, "ext.links")).toEqual({ acme: ["*", "acme-inc"] })
  expect(value(data, "ext.order")).toEqual([ME, "acme"])
  expect(linkExtension(data, "acme", "acme-inc", WHO)).toEqual({
    message: "acme is already linked to acme-inc",
    ok: false,
    status: 409,
  })
  expect(linkExtension(data, "acme", "not an org", WHO)).toMatchObject({ ok: false, status: 400 })
  expect(linkExtension(data, "nope", "acme", WHO)).toMatchObject({ ok: false, status: 404 })
  expect(linkExtension(data, "core", "acme", WHO)).toEqual({
    message: "core is built into Playground: it is linked everywhere and always comes last",
    ok: false,
    status: 409,
  })
})

test("unlink takes a link away, one not there is refused, and the login's extension stays read everywhere", () => {
  const data = fresh()
  linkExtension(data, "acme", "acme", WHO)
  linkExtension(data, "acme", "*", WHO)
  expect(unlinkExtension(data, "acme", "*", WHO).ok).toBe(true)
  expect(value(data, "ext.links")).toEqual({ acme: ["acme"] })
  for (const refused of [unlinkExtension(data, ME, "*", WHO), linkExtension(data, ME, "acme", WHO)])
    expect(refused).toEqual({
      message: `${ME} is your login's extension, which holds your settings, so every repo reads it`,
      ok: false,
      status: 409,
    })
  expect(unlinkExtension(data, "corp", "acme", WHO)).toEqual({
    message: "corp is not linked to acme",
    ok: false,
    status: 409,
  })
})

test("order puts the names given first and keeps the rest as they stood; none, a name twice or core is refused", () => {
  const data = fresh()
  linkExtension(data, "acme", "acme", WHO)
  linkExtension(data, "corp", "*", WHO)
  expect(orderExtensions(data, ["corp"], WHO).ok).toBe(true)
  expect(value(data, "ext.order")).toEqual(["corp", ME, "acme"])
  expect(orderExtensions(data, [], WHO)).toMatchObject({ ok: false, status: 400 })
  expect(orderExtensions(data, ["acme", "acme"], WHO)).toMatchObject({ ok: false, status: 400 })
  expect(orderExtensions(data, ["core"], WHO)).toMatchObject({ ok: false, status: 409 })
})

test("remove takes an extension out of the order, links and repos and leaves its folder; the login's stays", () => {
  const data = fresh()
  linkExtension(data, "acme", "acme", WHO)
  setSetting(data, { key: "ext.repos", scope: ME, value: { acme: "acme/shared" } }, WHO)
  expect(removeExtension(data, "acme", WHO)).toEqual({ dir: scopeDir(data, "acme"), ok: true })
  expect([value(data, "ext.order"), value(data, "ext.links"), value(data, "ext.repos")]).toEqual([
    [ME],
    {},
    {},
  ])
  expect(existsSync(join(scopeDir(data, "acme"), ".git"))).toBe(true)
  expect(removeExtension(data, ME, WHO)).toMatchObject({ ok: false, status: 409 })
})

test("a bundled extension is off until its switch turns it on in ext.bundled at the login's scope, and back off (#849)", () => {
  const data = fresh()
  const off: ReturnType<typeof listBundled> = [
    { name: "slack", on: false },
    { name: "whatsapp", on: false },
  ]
  expect(listBundled(data)).toEqual(off)
  expect(value(data, "ext.bundled")).toEqual([])
  expect(setBundled(data, "slack", true, WHO)).toEqual({
    key: "ext.bundled",
    ok: true,
    scope: ME,
    value: ["slack"],
  })
  expect(listBundled(data)).toEqual([
    { name: "slack", on: true },
    { name: "whatsapp", on: false },
  ])
  expect(setBundled(data, "slack", true, WHO)).toMatchObject({ ok: false, status: 409 })
  expect(setBundled(data, "whatsapp", true, WHO)).toMatchObject({
    ok: true,
    value: ["slack", "whatsapp"],
  })
  expect(setBundled(data, "slack", false, WHO)).toMatchObject({ ok: true, value: ["whatsapp"] })
  expect(setBundled(data, "whatsapp", false, WHO)).toMatchObject({ ok: true, value: [] })
  expect(listBundled(data)).toEqual(off)
})

test("a name Playground does not ship is refused, and ext.bundled refuses one twice or one unknown", () => {
  const data = fresh()
  expect(setBundled(data, "vault", true, WHO)).toMatchObject({ ok: false, status: 404 })
  expect(
    setSetting(data, { key: "ext.bundled", scope: ME, value: ["slack", "slack"] }, WHO),
  ).toMatchObject({ ok: false })
  expect(setSetting(data, { key: "ext.bundled", scope: ME, value: ["vault"] }, WHO)).toMatchObject({
    ok: false,
  })
})
