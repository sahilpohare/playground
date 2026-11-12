import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// whatsapp.ts registers the two keys, by relative path, since @/ here is web/next/src
import "../../../../../packages/settings/src/whatsapp"
import { loginPath } from "../../../../../packages/settings/src/rendered"
import { readSetting, setSetting } from "../../../../../packages/settings/src/settings-folder"
import {
  WHATSAPP_KEYS,
  whatsappFormSchema,
  whatsappWrite,
  whatsappWrites,
} from "../../../../../web/next/src/lib/whatsapp"

const scratch = mkdtempSync(join(tmpdir(), "whatsapp-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const ME = "made-up-me"
const WHO = { actor: "made-up-user-id", author: "owner", inboxRef: null, reason: "test" }
// Made-up numbers alone: 555-01xx is the range set aside for fiction.
const DEVICE = "+15550100001"
const OWNER = "+15550100002"

describe("Settings > Extensions > WhatsApp's numbers (#1797)", () => {
  test("the form takes + and 8 to 15 digits, or empty, and refuses the rest with a plain message", () => {
    expect(whatsappFormSchema.safeParse({ device: DEVICE, owner: " " + OWNER }).success).toBe(true)
    expect(whatsappFormSchema.safeParse({ device: "", owner: "" }).success).toBe(true)
    const refused = whatsappFormSchema.safeParse({ device: "5550100001", owner: "+1555" })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ["device", "A phone number is + and 8 to 15 digits, as +15550100001"],
      ["owner", "A phone number is + and 8 to 15 digits, as +15550100001"],
    ])
  })

  test("a Save writes only the fields you typed in, since a saved number never comes back to the field", () => {
    expect(whatsappWrites({ device: DEVICE, owner: "" })).toEqual([
      { key: WHATSAPP_KEYS.device, value: DEVICE },
    ])
    expect(whatsappWrites({ device: ` ${DEVICE} `, owner: OWNER })).toEqual([
      { key: WHATSAPP_KEYS.device, value: DEVICE },
      { key: WHATSAPP_KEYS.owner, value: OWNER },
    ])
    expect(whatsappWrites({ device: "", owner: "" })).toEqual([])
  })

  test("saving each field writes its setting at your login's scope", () => {
    const data = join(scratch, "data")
    mkdirSync(dirname(loginPath(data)), { recursive: true })
    writeFileSync(loginPath(data), `${ME}\n`)
    for (const field of whatsappWrites({ device: DEVICE, owner: OWNER })) {
      const write = whatsappWrite(field.key, field.value, ME)
      expect(write.param.key).toBe(field.key)
      const saved = setSetting(
        data,
        { key: write.param.key, scope: write.json.scope, value: write.json.value },
        { ...WHO, reason: write.json.reason },
      )
      expect(saved.ok).toBe(true)
      expect(readSetting(data, field.key)?.value).toBe(field.value)
    }
  })
})
