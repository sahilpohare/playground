import { expect, test } from "bun:test"

import {
  checkSetting,
  gateSettings,
  settingsFor,
  settingValue,
} from "../../../../packages/settings/src"

test("each gate key defaults to the line spawn.sh holds a start to today", () => {
  const unset = settingsFor([], "me")
  expect(gateSettings.get(unset, "gates.glmLoad5Max")).toBe(30)
  expect(gateSettings.get(unset, "gates.glmSwapinsMax")).toBe(100)
  expect(gateSettings.get(unset, "gates.memoryFreeMin")).toBe(8)
  expect(gateSettings.get(unset, "gates.reviewReserve")).toBe(0.125)
  expect(settingValue(unset, "gates.sessionCap")?.value).toBe(0)
  expect(gateSettings.get(unset, "gates.smallReserve")).toBe(0.25)
  expect(gateSettings.get(unset, "gates.startsWindow")).toBe(300)
})

test("a line no gate can hold is refused", () => {
  expect(checkSetting("gates.reviewReserve", 1).ok).toBe(false)
  expect(checkSetting("gates.smallReserve", 1).ok).toBe(false)
  expect(checkSetting("gates.memoryFreeMin", 101).ok).toBe(false)
  expect(checkSetting("gates.startsWindow", 0).ok).toBe(false)
  expect(checkSetting("gates.sessionCap", -1).ok).toBe(false)
  expect(checkSetting("gates.sessionCap", 2.5).ok).toBe(false)
  expect(checkSetting("gates.glmLoad5Max", 12.5).ok).toBe(true)
})
