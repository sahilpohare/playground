import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { checkSetting, HARNESS_IDS } from "../../../../packages/settings/src"
import { readSetting, setSetting } from "../../../../packages/settings/src/settings-folder"

process.env.PLAYGROUND_LOGIN = "made-up-me"

const scratch = mkdtempSync(join(tmpdir(), "harness-alpha-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))
const who = { actor: "test", author: "owner", inboxRef: null, reason: "first run's pick" }

describe("harness.alpha, the harness Alpha starts on (#1835)", () => {
  test("HARNESS_IDS names every harness, for the API's schemas", () => {
    expect(HARNESS_IDS).toEqual(["claude-code", "codex"])
  })

  test("reads Claude Code until it is set", () => {
    expect(readSetting(join(scratch, "fresh"), "harness.alpha")?.value).toBe("claude-code")
  })

  test("saves codex at the login's scope and reads it back, then claude-code again", () => {
    const data = join(scratch, "data")
    const scope = "made-up-me"
    expect(setSetting(data, { key: "harness.alpha", scope, value: "codex" }, who)).toMatchObject({
      ok: true,
      value: "codex",
    })
    expect(readSetting(data, "harness.alpha")?.value).toBe("codex")
    setSetting(data, { key: "harness.alpha", scope, value: "claude-code" }, who)
    expect(readSetting(data, "harness.alpha")?.value).toBe("claude-code")
  })

  test.each(["", "glm", "openai", "Codex"])("refuses %p, which names no harness", (value) => {
    expect(checkSetting("harness.alpha", value).ok).toBe(false)
  })
})
