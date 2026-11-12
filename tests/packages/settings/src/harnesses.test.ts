import { describe, expect, test } from "bun:test"

import { HARNESSES, pinText, readPin } from "../../../../packages/settings/src/harnesses"

describe("a backend pin", () => {
  test("reads in the shape spawn.sh writes it, each harness then each of its backends", () => {
    for (const harness of HARNESSES)
      for (const backend of harness.backends)
        expect(readPin(`${pinText(harness.id, backend)}\n`)).toEqual({
          backend,
          harness: harness.id,
        })
  })

  test("reads a pin written before the harness split, its backend alone, as Claude Code", () => {
    expect(readPin("glm\n")).toEqual({ backend: "glm", harness: "claude-code" })
    expect(readPin("claude")).toEqual({ backend: "claude", harness: "claude-code" })
  })

  test.each(["", "gpt", "openai", "codex claude", "claude-code gpt", "claude-code glm extra"])(
    "reads %p as no pin",
    (text) => {
      expect(readPin(text)).toBeNull()
    },
  )
})
