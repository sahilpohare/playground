import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runLevel, thinkingEnv } from "../../../../packages/scripts/src/local-thinking-check"

const spawn = await Bun.file(join(import.meta.dir, "../../../../scripts/spawn.sh")).text()

// A claude that sends one messages request to the stub, its thinking field as Claude Code 2.1.326 was measured sending it: CLAUDE_CODE_EXTRA_BODY's over the rest, none at MAX_THINKING_TOKENS=0, a budget under -adaptive_thinking, else adaptive.
const FAKE = `#!/usr/bin/env bun
const cap = process.env.MAX_THINKING_TOKENS
const off = (process.env.CLAUDE_CODE_MODEL_CAPABILITIES ?? "").includes("-adaptive_thinking")
const thinking = cap === "0" ? undefined : off ? { budget_tokens: Number(cap), type: "enabled" } : { type: "adaptive" }
const extra = JSON.parse(process.env.CLAUDE_CODE_EXTRA_BODY ?? "{}")
await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { body: JSON.stringify({ model: process.argv[process.argv.indexOf("--model") + 1], stream: true, thinking, ...extra }), method: "POST" })
`

const fakePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"))
  writeFileSync(join(dir, "claude"), FAKE)
  chmodSync(join(dir, "claude"), 0o755)
  return `${dir}:${process.env.PATH ?? ""}`
}

describe("local-thinking-check", () => {
  test("reads each level's variables from spawn.sh's local launch: low's disabled body, its quotes dropped, medium's cap with adaptive thinking off, and none at high", () => {
    expect(thinkingEnv(spawn, "medium")).toEqual({
      CLAUDE_CODE_MODEL_CAPABILITIES: "local=-adaptive_thinking",
      MAX_THINKING_TOKENS: "8192",
    })
    expect(thinkingEnv(spawn, "low")).toEqual({
      CLAUDE_CODE_EXTRA_BODY: '{"thinking":{"type":"disabled"}}',
    })
    expect(thinkingEnv(spawn, "high")).toEqual({})
  })

  test("its stub records each request's model and thinking field, absent when the request sent none", async () => {
    const PATH = fakePath()
    const medium = await runLevel("medium", { ...thinkingEnv(spawn, "medium"), PATH })
    expect(medium.requests).toEqual([
      { model: "local", thinking: { budget_tokens: 8192, type: "enabled" } },
    ])
    const high = await runLevel("high", { ...thinkingEnv(spawn, "high"), PATH })
    expect(high.requests).toEqual([{ model: "local", thinking: { type: "adaptive" } }])
    const low = await runLevel("low", { ...thinkingEnv(spawn, "low"), PATH })
    expect(low.requests).toEqual([{ model: "local", thinking: { type: "disabled" } }])
    const zero = await runLevel("low", { MAX_THINKING_TOKENS: "0", PATH })
    expect(zero.requests).toEqual([{ model: "local", thinking: "absent" }])
  })
})
