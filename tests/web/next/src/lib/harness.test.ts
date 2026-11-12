import { describe, expect, test } from "bun:test"

import {
  alphaWrite,
  canStart,
  type HarnessCard,
  harnessesOf,
  type SwitchRead,
  switchMessage,
} from "../../../../../web/next/src/lib/harness"
import { deviceLabel, fixJobOf } from "../../../../../web/next/src/lib/onboard"

const row = (name: string, status: "MISSING" | "ok" | "optional" | "waiting") => ({
  action: null,
  detail: status,
  name,
  need: null,
  note: null,
  status,
})

const claude: HarnessCard = {
  checks: [row("Installed", "ok"), row("Signed in", "ok"), row("Plan", "optional")],
  id: "claude-code",
  label: "Claude Code",
  ready: true,
  refusal: null,
}
const codex: HarnessCard = {
  checks: [row("Installed", "ok"), row("Signed in", "MISSING"), row("Plan", "waiting")],
  id: "codex",
  label: "Codex",
  ready: false,
  refusal: null,
}

describe("the harness cards (#1835)", () => {
  test("read from the API's body in its order, and nothing else reads as cards", () => {
    expect(harnessesOf({ data: { harnesses: [claude, codex] } })).toEqual([claude, codex])
    expect(harnessesOf({ data: { harnesses: [{ ...codex, id: "gpt" }] } })).toBeUndefined()
    expect(harnessesOf({ data: { harnesses: [{ ...codex, checks: [{}] }] } })).toBeUndefined()
    expect(harnessesOf({ data: {} })).toBeUndefined()
  })

  test("Start turns on for a pick that is ready with nothing refusing it", () => {
    expect(canStart([claude, codex], "claude-code")).toBe(true)
    expect(canStart([claude, codex], "codex")).toBe(false)
    const ready = { ...codex, ready: true }
    expect(canStart([claude, ready], "codex")).toBe(true)
    expect(canStart([claude, { ...ready, refusal: "Not on this Mac yet." }], "codex")).toBe(false)
  })

  test("the pick saves as harness.alpha at your login's scope", () => {
    expect(alphaWrite("codex", "made-up-me")).toEqual({
      json: {
        by: "Dashboard",
        reason: "Picked Alpha's harness on first run",
        scope: "made-up-me",
        value: "codex",
      },
      param: { key: "harness.alpha" },
    })
  })

  test("a sign-in with a link and no code reads as one, and its button names the sign-in page", () => {
    const job = { device: { code: null, url: "https://claude.ai/oauth/x" }, id: "claude-login" }
    expect(
      fixJobOf({ data: { ...job, lines: [], reason: null, state: "running" } })?.device,
    ).toEqual(job.device)
    expect(deviceLabel("claude-login")).toBe("Open the sign-in page")
    expect(deviceLabel("gh-login")).toBe("Open GitHub")
  })
})

describe("Switch Alpha's message (#1835)", () => {
  const read: SwitchRead = {
    ask: "Switch Alpha to Codex: write your handoff now",
    harness: "codex",
    reason: null,
    state: "running",
    step: "Waiting for Alpha's handoff",
    to: "dispatcher",
  }

  test("sends the running dispatcher its handoff ask through the outbox", () => {
    expect(switchMessage(read)).toEqual({ text: read.ask!, to: "dispatcher" })
  })

  test("sends nothing when the switch asks nothing, or is no longer running", () => {
    expect(switchMessage({ ...read, ask: null, to: null })).toBeNull()
    expect(switchMessage({ ...read, state: "ok" })).toBeNull()
    expect(switchMessage({ ...read, state: "failed" })).toBeNull()
  })
})
