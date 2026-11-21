import { describe, expect, test } from "bun:test"

import {
  DELIVERED_ACTIONS,
  deliveryEvent,
  deliveryWords,
} from "../../../../../../api/hono/src/lib/dashboard/deliver"
import {
  settingCommand,
  settingRequestSchema,
  settingSchema,
  settingSummary,
} from "../../../../../../api/hono/src/lib/dashboard/setting"

const actor = { email: "owner@local.host", id: "u-1" }

describe("a session setting", () => {
  test("takes one model or one effort from its list, and nothing else", () => {
    for (const model of ["fable", "haiku", "opus", "sonnet"]) {
      expect(settingSchema.safeParse({ model }).success).toBe(true)
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(settingSchema.safeParse({ effort }).success).toBe(true)
    }
    for (const body of [
      { model: "opus; /clear" },
      { model: "claude-opus-5-5" },
      { model: "Opus" },
      { effort: "ultra" },
      { effort: "high", model: "opus" },
      { model: "opus", text: "hi" },
      { command: "/model opus" },
      {},
    ]) {
      expect(settingSchema.safeParse(body).success).toBe(false)
    }
  })

  test("its route's body takes the composer's id beside the one setting, and nothing else", () => {
    const id = "11111111-2222-4333-8444-555555555555"
    expect(settingRequestSchema.parse({ id, model: "opus" })).toEqual({ id, model: "opus" })
    expect(settingRequestSchema.parse({ effort: "low", id })).toEqual({ effort: "low", id })
    expect(settingRequestSchema.parse({ model: "opus" })).toEqual({ model: "opus" })
    expect(settingRequestSchema.parse({ id, local: "ornith-1.5-122b-nvfp4" })).toEqual({
      id,
      local: "ornith-1.5-122b-nvfp4",
    })
    for (const body of [
      { id: "not-a-uuid", model: "opus" },
      { effort: "high", id, model: "opus" },
      { id, model: "opus", text: "hi" },
      { id },
      { local: "-x" },
      { local: "a b" },
      { local: "ornith", model: "opus" },
    ]) {
      expect(settingRequestSchema.safeParse(body).success).toBe(false)
    }
  })

  test("types the one slash command its list value names, and its row names the session and the value", () => {
    expect(settingCommand({ model: "sonnet" })).toBe("/model sonnet")
    expect(settingCommand({ effort: "xhigh" })).toBe("/effort xhigh")
    expect(settingSummary("dispatcher", { model: "sonnet" })).toBe(
      "Set dispatcher's model to sonnet",
    )
    expect(settingSummary("probe-sdk", { local: "ornith-1.5-122b-nvfp4" })).toBe(
      "Set probe-sdk's model to ornith-1.5-122b-nvfp4 (local)",
    )
  })

  test("a delivery's words are the setting's command, passed with no skill check, while any other / stays refused", () => {
    expect(deliveryWords({ setting: { effort: "low" }, text: "/clear" }, true)).toEqual({
      refused: null,
      skill: null,
      words: "/effort low",
    })
    expect(deliveryWords({ text: "/effort low" }).refused).toMatchObject({ code: "COMMAND" })
    expect(deliveryWords({ text: "/review now" }, true)).toMatchObject({
      refused: null,
      skill: "review",
    })
  })

  test("a setting's row is found again by its id, as a message's is, so a retry under it types nothing", () => {
    expect(DELIVERED_ACTIONS).toContain("dashboard.setting")
    expect(DELIVERED_ACTIONS).toContain("dashboard.message")
  })

  test("a setting records a dashboard.setting row told whole, a message a dashboard.message row by size", () => {
    expect(
      deliveryEvent({ actor, id: "m-1", setting: { model: "opus" } }, "dispatcher", ""),
    ).toEqual({
      action: "dashboard.setting",
      actor,
      id: "m-1",
      summary: "Set dispatcher's model to opus",
    })
    expect(deliveryEvent({ actor }, "dispatcher", "hello")).toMatchObject({
      action: "dashboard.message",
      summary: "Sent dispatcher a message of 5 characters",
    })
  })
})
