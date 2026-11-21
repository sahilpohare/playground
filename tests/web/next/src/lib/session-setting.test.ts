import { describe, expect, test } from "bun:test"

import {
  choiceLabel,
  choiceSetting,
  EFFORT_LABELS,
  effortFixed,
  heldPick,
  isEffort,
  isModel,
  localChoice,
  localLoadLine,
  MODEL_LABELS,
  modelAlias,
  modelChoice,
  pickerWords,
  reportedSetting,
  shownValue,
} from "../../../../../web/next/src/lib/session-setting"

describe("the composer's model and effort picker", () => {
  test("lists the models by their family's word and the efforts least to most", () => {
    expect(MODEL_LABELS).toEqual({ fable: "Fable", haiku: "Haiku", opus: "Opus", sonnet: "Sonnet" })
    expect(Object.keys(EFFORT_LABELS)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect([
      isModel("opus"),
      isModel("claude-opus-5-5"),
      isEffort("max"),
      isEffort("ultra"),
    ]).toEqual([true, false, true, false])
  })

  test("reads a model id as the alias it runs as, and another provider's as none", () => {
    expect(modelAlias("claude-opus-5-5")).toBe("opus")
    expect(modelAlias("claude-haiku-4-5-20251001")).toBe("haiku")
    expect(modelAlias("claude-fable-5-1[1m]")).toBe("fable")
    expect(modelAlias("glm-5.3-flash")).toBeNull()
    expect(modelAlias(null)).toBeNull()
    expect(reportedSetting({ effort: "xhigh", model: "claude-sonnet-5-5" })).toEqual({
      effort: "xhigh",
      model: "sonnet",
    })
    expect(reportedSetting({ effort: "auto", model: null })).toEqual({ effort: null, model: null })
  })

  test("the hosted session's local models read by their label, and a pick of one is a local setting, never a cloud model", () => {
    const localModels = [{ id: "ornith-1.5-122b-nvfp4", label: "M" }]
    expect(modelChoice({ localModels, model: "ornith-1.5-122b-nvfp4" })).toBe(
      "local:ornith-1.5-122b-nvfp4",
    )
    expect(modelChoice({ localModels, model: "claude-opus-5-5" })).toBe("opus")
    expect(modelChoice({ model: "ornith-1.5-122b-nvfp4" })).toBeNull()
    expect(choiceSetting(localChoice("ornith-1.5-122b-nvfp4"))).toEqual({
      local: "ornith-1.5-122b-nvfp4",
    })
    expect(choiceSetting("opus")).toEqual({ model: "opus" })
    expect(choiceSetting("claude-opus-5-5")).toBeNull()
    expect(choiceLabel("local:ornith-1.5-122b-nvfp4", localModels)).toBe("M")
    expect(choiceLabel("local:other", localModels)).toBeNull()
    expect(choiceLabel("sonnet")).toBe("Sonnet")
  })

  test("the picker on a local model reads its level in words, as its row's hint does, while a Claude session keeps its effort (PG-2651)", () => {
    const localModels = [{ id: "ornith-1.5-122b-nvfp4", label: "Ornith 122B" }]
    const served = { localModel: "ornith-ai/Ornith-1.5-122B-NVFP4", model: "local" }
    expect(pickerWords(served, null, "high")).toBe("high: Ornith 122B, thinking")
    expect(pickerWords(served, null, "medium")).toBe("medium: Ornith 122B, thinking capped")
    expect(pickerWords(served, null, "low")).toBe("low: Ornith 122B, no thinking")
    expect(pickerWords(served, null, null)).toBe("Ornith 122B, local")
    expect(pickerWords({ model: "local" }, null, "high")).toBe("high: local, thinking")
    expect(
      pickerWords(
        { localModels, model: "ornith-1.5-122b-nvfp4" },
        "local:ornith-1.5-122b-nvfp4",
        "high",
      ),
    ).toBe("Ornith 122B")
    expect(pickerWords({ model: "claude-opus-5-5" }, "opus", "high")).toBe("Opus · High")
    expect(pickerWords({ model: "claude-opus-5-5" }, "opus", null)).toBe("Opus · Effort")
    expect(pickerWords({ model: null }, null, null)).toBe("Model · Effort")
    // a pick of a cloud model off the local one reads as that model's, effort and all
    expect(pickerWords(served, "sonnet", "high")).toBe("Sonnet · High")
  })

  test("the Effort group takes no pick on a session on the served local model, whose launch set its thinking; any other session's does", () => {
    expect(effortFixed({ model: "local" }, null)).toBe(true)
    expect(effortFixed({ model: "local" }, "sonnet")).toBe(false)
    expect(effortFixed({ model: "claude-opus-5-5" }, "opus")).toBe(false)
    expect(effortFixed({ model: "ornith-1.5-122b-nvfp4" }, "local:ornith-1.5-122b-nvfp4")).toBe(
      false,
    )
    expect(effortFixed({ model: null }, null)).toBe(false)
  })

  test("shows a pick until the row reports a value other than the one it was picked over", () => {
    expect(shownValue({ from: "opus", to: "sonnet" }, "opus")).toBe("sonnet")
    expect(shownValue({ from: "opus", to: "sonnet" }, "sonnet")).toBe("sonnet")
    expect(shownValue({ from: "opus", to: "sonnet" }, "haiku")).toBe("haiku")
    expect(shownValue({ from: null, to: "high" }, null)).toBe("high")
    expect(shownValue(null, "low")).toBe("low")
  })

  test("a pick the dispatcher holds (QUEUED) stays shown, while any other refusal fails it", () => {
    expect(heldPick({ code: "CONFLICT", delivery: "QUEUED", message: "holds it" })).toBe(true)
    expect(heldPick({ code: "CONFLICT", delivery: "ON_PICKER", message: "on a card" })).toBe(false)
    expect(heldPick({ code: "CONFLICT", delivery: "INTERRUPTED", message: "typed" })).toBe(false)
    expect(heldPick({ code: "NETWORK_ERROR", message: "Network request failed" })).toBe(false)
    expect(heldPick(null)).toBe(false)
  })
})

describe("the composer's line for a local model's load", () => {
  test("while it loads it says what loads and about how long; once failed it shows the API's words; with none, nothing", () => {
    expect(localLoadLine(undefined)).toBeNull()
    expect(localLoadLine({ label: "M", state: "loading" })).toEqual({
      failed: false,
      text: "Loading M on the local model server, about 10 minutes. The chat switches to it once it answers.",
    })
    expect(localLoadLine({ label: "M", reason: "M didn't come up.", state: "failed" })).toEqual({
      failed: true,
      text: "M didn't come up.",
    })
  })
})
