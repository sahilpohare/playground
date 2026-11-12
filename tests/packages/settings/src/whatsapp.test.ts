import { describe, expect, test } from "bun:test"

import { checkSetting, shownValue } from "../../../../packages/settings/src"

// Made-up numbers alone: 555-01xx is the range set aside for fiction.
const GOOD = "+15550100001"

describe("WhatsApp's two numbers (#1797)", () => {
  test.each(["wa.device", "wa.owner"])("%s takes + and 8 to 15 digits, or empty", (key) => {
    expect(checkSetting(key, GOOD)).toEqual({ key, ok: true, value: GOOD })
    expect(checkSetting(key, "+15550100")).toMatchObject({ ok: true })
    expect(checkSetting(key, "+155501000012345")).toMatchObject({ ok: true })
    expect(checkSetting(key, "")).toMatchObject({ ok: true })
  })

  test.each([
    ["15550100001"],
    ["+1555010"],
    ["+1555010000123456"],
    ["+1 555 0100 001"],
    ["+0555010001"],
  ])("%s is refused with a plain message", (value) => {
    const checked = checkSetting("wa.owner", value)
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.message).toContain("a phone number is + and 8 to 15 digits")
  })

  test("a saved number reads back as its last 4 digits alone", () => {
    expect(shownValue("wa.device", GOOD)).toBe("••••0001")
    expect(shownValue("wa.owner", GOOD)).toBe("••••0001")
    expect(shownValue("wa.owner", "")).toBe("")
    expect(shownValue("wa.owner", null)).toBeNull()
    expect(shownValue("clock.ownerZone", "Asia/Kolkata")).toBe("Asia/Kolkata")
  })
})
