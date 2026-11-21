import { describe, expect, test } from "bun:test"

import {
  iconModels,
  localModel,
  servedRoot,
  withLocalModel,
} from "../../../../../../api/hono/src/lib/dashboard/local-model"
import { makersOf } from "../../../../../../api/hono/src/lib/dashboard/model-icons"

// vLLM's answer for the one model it serves as local, its root the repo the weights came from (measured on this machine's server, 2026-11-17).
const VLLM = {
  data: [
    { id: "local", object: "model", owned_by: "vllm", root: "ornith-ai/Ornith-1.5-122B-NVFP4" },
  ],
  object: "list",
}

describe("servedRoot", () => {
  test("the repo id of the model served as local, else null", () => {
    expect(servedRoot(VLLM)).toBe("ornith-ai/Ornith-1.5-122B-NVFP4")
    expect(servedRoot({ data: [{ id: "other", root: "a/b" }] })).toBeNull()
    expect(servedRoot({ data: [{ id: "local", root: "/models/weights" }] })).toBeNull()
    expect(servedRoot({ data: [{ id: "local" }] })).toBeNull()
    expect(servedRoot(null)).toBeNull()
    expect(servedRoot("not json")).toBeNull()
  })
})

describe("withLocalModel", () => {
  const live: { workers: { localModel?: string; model: string; name: string }[] } = {
    workers: [
      { model: "local", name: "local-worker" },
      { model: "claude-opus-5-5", name: "claude-worker" },
    ],
  }

  test("gives the served repo to each session on local alone", () => {
    expect(withLocalModel(live, "ornith-ai/Ornith-1.5-122B-NVFP4").workers).toEqual([
      { localModel: "ornith-ai/Ornith-1.5-122B-NVFP4", model: "local", name: "local-worker" },
      { model: "claude-opus-5-5", name: "claude-worker" },
    ])
  })

  test("leaves every row as it was while no repo is known", () => {
    expect(withLocalModel(live, null)).toBe(live)
  })
})

describe("localModel", () => {
  test("a test or fixture stack reads the made-up machine's served repo and asks no server", async () => {
    let asked = 0
    const fetcher = (async () => {
      asked += 1
      return Response.json(VLLM)
    }) as unknown as typeof fetch
    expect(await localModel(fetcher)).toBe("ornith-ai/Ornith-1.5-122B-NVFP4")
    expect(asked).toBe(0)
  })

  test("a live stack asks the local server once a minute, and keeps null when it answers nothing in time", async () => {
    const asked: string[] = []
    const answering = (async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return Response.json(VLLM)
    }) as unknown as typeof fetch
    const at = 1_000_000_000
    expect(await localModel(answering, true, at)).toBe("ornith-ai/Ornith-1.5-122B-NVFP4")
    expect(await localModel(answering, true, at + 59_000)).toBe("ornith-ai/Ornith-1.5-122B-NVFP4")
    expect(asked).toEqual(["http://127.0.0.1:8000/v1/models"])
    const down = (async () => {
      throw new DOMException("timed out", "TimeoutError")
    }) as unknown as typeof fetch
    expect(await localModel(down, true, at + 61_000)).toBeNull()
  })
})

describe("iconModels", () => {
  test("the served repo joins config's local models, so its maker's logo is served though config names none", () => {
    const served = "ornith-ai/Ornith-1.5-122B-NVFP4"
    expect(makersOf(iconModels([], served))).toEqual(new Set(["anthropic", "zai", "ornith-ai"]))
    expect(iconModels([{ id: "Qwen/Qwen3-30B-A3B" }], served)).toEqual([
      { id: "Qwen/Qwen3-30B-A3B" },
      { id: served },
    ])
    expect(iconModels([{ id: "Qwen/Qwen3-30B-A3B" }], null)).toEqual([{ id: "Qwen/Qwen3-30B-A3B" }])
  })
})
