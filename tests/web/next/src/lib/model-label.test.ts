import { describe, expect, test } from "bun:test"

import {
  dispatcherLabel,
  initialsOf,
  levelName,
  localName,
  modelName,
  providerOf,
  rowEffort,
  rowModelName,
  rowProvider,
  showsEffort,
} from "../../../../../web/next/src/lib/model-label"

describe("modelName", () => {
  test("a model id as people say it, with its date and context suffix dropped, else the id as written", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5")
    expect(modelName("claude-sonnet-5-5")).toBe("Sonnet 5.5")
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
    expect(modelName("claude-fable-5-1")).toBe("Fable 5.1")
    expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5")
    expect(modelName("claude-opus-5")).toBe("Opus 5")
    expect(modelName("gpt-9")).toBe("gpt-9")
    expect(modelName("claude-mystery-1-0")).toBe("claude-mystery-1-0")
    expect(modelName(null)).toBeNull()
  })

  test("a GLM id reads as people say it, its 1M suffix dropped", () => {
    expect(modelName("glm-5.3-flash")).toBe("GLM 5.3 Flash")
    expect(modelName("glm-5.3-flash[1m]")).toBe("GLM 5.3 Flash")
    expect(modelName("glm-5.3")).toBe("GLM 5.3")
    expect(modelName("glm-9")).toBe("glm-9")
  })
})

// #i520: "two dispatcher rows, each named by the model it runs ... 'Opus 5.5 High' and 'GLM 5.3 Flash High'"
describe("dispatcherLabel", () => {
  test("its newest reply's model and effort, each word capitalised", () => {
    expect(dispatcherLabel({ effort: "high", model: "claude-opus-5-5" }, true)).toBe(
      "Opus 5.5 High",
    )
    expect(dispatcherLabel({ effort: "high", model: "glm-5.3-flash" }, false)).toBe(
      "GLM 5.3 Flash High",
    )
    expect(dispatcherLabel({ effort: null, model: "claude-opus-5-5" }, true)).toBe("Opus 5.5")
  })

  // The dispatcher slots show model names, never a worker's name.
  test("with no reply read yet, or its session down, its role in the slot alone, never a session's name", () => {
    expect(dispatcherLabel(null, true)).toBe("Alpha")
    expect(dispatcherLabel(null, false)).toBe("Bravo")
    expect(dispatcherLabel({ effort: "high", model: null }, false)).toBe("Bravo")
  })
})

describe("providerOf", () => {
  test("a Claude model is Anthropic's and a GLM model Z.ai's, by their backends; an org/repo id is its org's; a bare id or anything else has no maker", () => {
    expect(providerOf("claude-opus-5-5")).toBe("anthropic")
    expect(providerOf("claude-haiku-4-5-20251001")).toBe("anthropic")
    expect(providerOf("claude-opus-5-5[1m]")).toBe("anthropic")
    expect(providerOf("glm-5.3-flash")).toBe("zai")
    expect(providerOf("ornith-ai/Ornith-1.5-122B-NVFP4")).toBe("ornith-ai")
    expect(providerOf("RecursiveSI/Thing-7B")).toBe("RecursiveSI")
    expect(providerOf("Ornith-1.5-122B-NVFP4")).toBeNull()
    expect(providerOf("../x/y")).toBeNull()
    expect(providerOf("gpt-9")).toBeNull()
    expect(providerOf(null)).toBeNull()
  })
})

// A local session's model is served as the bare name local (spawn.sh's LOCAL_SERVED); the API gives the repo id that server serves as its localModel (PG-2642).
describe("a local session's row", () => {
  const local = { localModel: "ornith-ai/Ornith-1.5-122B-NVFP4", model: "local" }
  const claude = { model: "claude-opus-5-5" }

  test("localName reads a repo id as its family and size, else its family, else the name as written", () => {
    expect(localName("ornith-ai/Ornith-1.5-122B-NVFP4")).toBe("Ornith 122B")
    expect(localName("ornith-ai/Ornith-1.5-35B-A3B-NVFP4")).toBe("Ornith 35B")
    expect(localName("Qwen/Qwen3-30B-A3B")).toBe("Qwen3 30B")
    expect(localName("RecursiveSI/Thing")).toBe("Thing")
  })

  test("the row names a local model by its served repo and local, local alone while none is known, and any other model by modelName", () => {
    expect(rowModelName(local)).toBe("Ornith 122B, local")
    expect(rowModelName({ model: "local" })).toBe("local")
    expect(rowModelName(claude)).toBe("Opus 5.5")
    expect(rowModelName({ model: null })).toBeNull()
  })

  test("a local row's maker is its served repo's org, none while no repo is known, and any other row's is providerOf's", () => {
    expect(rowProvider(local)).toBe("ornith-ai")
    expect(rowProvider({ model: "local" })).toBeNull()
    expect(rowProvider(claude)).toBe("anthropic")
  })

  test("a local row names no effort apart, since its chat template reads no effort; a Claude row does", () => {
    expect(showsEffort(local)).toBe(false)
    expect(showsEffort(claude)).toBe(true)
  })

  test("a row's icon draws its own effort, a served local session's included, but none on a local model its own list names", () => {
    expect(rowEffort({ effort: "low", model: "local" })).toBe("low")
    expect(rowEffort({ effort: null, model: "local" })).toBeNull()
    expect(rowEffort({ effort: "high", model: "claude-opus-5-5" })).toBe("high")
    const localModels = [{ id: "ornith-1.5-122b-nvfp4" }]
    expect(rowEffort({ effort: "high", localModels, model: "ornith-1.5-122b-nvfp4" })).toBeNull()
    expect(rowEffort({ effort: "high", localModels, model: "claude-opus-5-5" })).toBe("high")
  })

  test.each([
    ["high", "high: Ornith 122B, thinking"],
    ["medium", "medium: Ornith 122B, thinking capped"],
    ["low", "low: Ornith 122B, no thinking"],
    ["xhigh", "xhigh: Ornith 122B, thinking"],
    ["max", "max: Ornith 122B, thinking"],
  ])("a local row at %s names its level, its model and its thinking", (effort, words) => {
    expect(levelName({ ...local, effort })).toBe(words)
  })

  test("a local row with no known effort reads as rowModelName, one with no known repo by the served name, and a Claude row by modelName", () => {
    expect(levelName({ ...local, effort: null })).toBe("Ornith 122B, local")
    expect(levelName({ effort: "low", model: "local" })).toBe("low: local, no thinking")
    expect(levelName({ ...claude, effort: "high" })).toBe("Opus 5.5")
  })

  test("a row on a local model its own list names, as the hosted session's after a pick, shows no effort either, while a Claude model beside that list does (PG-2651)", () => {
    const localModels = [{ id: "ornith-1.5-122b-nvfp4", label: "Ornith 122B" }]
    expect(showsEffort({ localModels, model: "ornith-1.5-122b-nvfp4" })).toBe(false)
    expect(showsEffort({ localModels, model: "claude-opus-5-5" })).toBe(true)
  })

  test("initialsOf gives a chip's two letters from a model's name, its first capitalised", () => {
    expect(initialsOf("Ornith 122B, local")).toBe("Or")
    expect(initialsOf("local")).toBe("Lo")
    expect(initialsOf("GLM 5.3 Flash")).toBe("GL")
    expect(initialsOf("gpt-9")).toBe("Gp")
    expect(initialsOf(null)).toBe("")
  })
})
