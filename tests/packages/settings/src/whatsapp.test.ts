import { describe, expect, test } from "bun:test"

import {
  checkSetting,
  DEFAULT_POLICY,
  GUARD_SETTING_KEYS,
  shownValue,
  whatsappSettings,
} from "../../../../packages/settings/src"

// Made-up numbers alone: 555-01xx is the range set aside for fiction.
const GOOD = "+15550100001"

describe("WhatsApp's numbers (#1797, #2748)", () => {
  test.each(["wa.alert", "wa.device", "wa.owner"])(
    "%s takes + and 8 to 15 digits, or empty",
    (key) => {
      expect(checkSetting(key, GOOD)).toEqual({ key, ok: true, value: GOOD })
      expect(checkSetting(key, "+15550100")).toMatchObject({ ok: true })
      expect(checkSetting(key, "+155501000012345")).toMatchObject({ ok: true })
      expect(checkSetting(key, "")).toMatchObject({ ok: true })
    },
  )

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

describe("WhatsApp's policy lines (#2756)", () => {
  test.each(["wa.guestPolicy", "wa.replyPolicy"] as const)(
    "%s defaults to factory status alone, takes a line of words, refuses an empty one, and is a guard key",
    (key) => {
      expect(whatsappSettings.get({ schemaVersion: 1, values: {} } as never, key)).toBe(
        DEFAULT_POLICY,
      )
      expect(DEFAULT_POLICY).toBe("factory status; no secrets or customer personal data")
      expect(checkSetting(key, "a made-up policy")).toMatchObject({ ok: true })
      expect(checkSetting(key, "  ")).toMatchObject({ ok: false })
      expect(checkSetting(key, "x".repeat(401))).toMatchObject({ ok: false })
      expect(GUARD_SETTING_KEYS).toContain(key)
    },
  )
})

describe("an urgent alert's delay and checker (#2776)", () => {
  test("wa.alertDelayMinutes defaults to 3 and takes a positive whole number alone", () => {
    expect(
      whatsappSettings.get({ schemaVersion: 1, values: {} } as never, "wa.alertDelayMinutes"),
    ).toBe(3)
    expect(checkSetting("wa.alertDelayMinutes", 5)).toMatchObject({ ok: true, value: 5 })
    for (const bad of [0, -1, 2.5, "3"])
      expect(checkSetting("wa.alertDelayMinutes", bad)).toMatchObject({ ok: false })
    expect(GUARD_SETTING_KEYS).not.toContain("wa.alertDelayMinutes")
  })

  test("wa.alertCheck is empty by default, names a file, and is a guard key", () => {
    expect(whatsappSettings.get({ schemaVersion: 1, values: {} } as never, "wa.alertCheck")).toBe(
      "",
    )
    expect(checkSetting("wa.alertCheck", "scripts/made-up/check.ts")).toMatchObject({ ok: true })
    expect(GUARD_SETTING_KEYS).toContain("wa.alertCheck")
  })
})

describe("quiet hours (#2887)", () => {
  test("wa.quietStartHour and wa.quietEndHour default to 0 and 6, take a whole hour from 0 to 23, and are no guard keys", () => {
    const none = { schemaVersion: 1, values: {} } as never
    expect(whatsappSettings.get(none, "wa.quietStartHour")).toBe(0)
    expect(whatsappSettings.get(none, "wa.quietEndHour")).toBe(6)
    for (const key of ["wa.quietEndHour", "wa.quietStartHour"] as const) {
      expect(checkSetting(key, 23)).toMatchObject({ ok: true, value: 23 })
      for (const bad of [-1, 24, 2.5, "6"])
        expect(checkSetting(key, bad)).toMatchObject({ ok: false })
      expect(GUARD_SETTING_KEYS).not.toContain(key)
    }
  })
})
