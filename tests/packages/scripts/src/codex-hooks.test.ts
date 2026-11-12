import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  CODEX_EVENTS,
  CODEX_MATCHERS,
  codexHooks,
  hookOf,
  type Hooks,
  LEFT_OUT,
} from "../../../../packages/scripts/src/codex-hooks"

const FACTORY = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../../scripts/factory-settings.json"), "utf8"),
) as { hooks: Hooks }
const handler = (hook: string) => ({
  command: `s=scripts/hooks/bundled/${hook}.js; [ -f "$s" ] || s=scripts/hooks/${hook}.ts; bun "$s"`,
  type: "command",
})

describe("the hooks.json a Codex launch loads", () => {
  test("keeps each handler in its group with its matcher, on Codex's events alone", () => {
    expect(
      codexHooks({
        Notification: [{ hooks: [handler("no-made-up")] }],
        PreToolUse: [
          { hooks: [handler("no-made-up")], matcher: "^Bash$" },
          { hooks: [handler("writing-first")], matcher: "^(Edit|MultiEdit|Skill|Write)$" },
        ],
        SessionStart: [{ hooks: [handler("writing-first")], matcher: "^compact$" }],
        Stop: [{ hooks: [handler("session-state")] }, { hooks: [handler("no-made-up")] }],
      }),
    ).toEqual({
      PreToolUse: [
        { hooks: [handler("no-made-up")], matcher: "^Bash$" },
        { hooks: [handler("writing-first")], matcher: "^(Bash|Edit|MultiEdit|Write)$" },
      ],
      SessionStart: [{ hooks: [handler("writing-first")], matcher: "^compact$" }],
      Stop: [{ hooks: [handler("no-made-up")] }],
    })
  })

  // A rename of a hook, its script or its matcher turns these red, so the render never drifts from the factory's settings unseen.
  test("every factory handler names its hook, and each hook the render treats apart is one the factory registers", () => {
    const named = Object.values(FACTORY.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hookOf(hook.command))),
    )
    expect(named).not.toContain(undefined)
    for (const hook of [...LEFT_OUT, ...Object.keys(CODEX_MATCHERS)]) expect(named).toContain(hook)
    const rendered = codexHooks(FACTORY.hooks)
    expect(JSON.stringify(rendered)).not.toContain("session-state")
    expect(Object.keys(rendered).every((event) => CODEX_EVENTS.includes(event))).toBe(true)
    const writing = rendered.PreToolUse?.find((group) =>
      group.hooks.some((hook) => hookOf(hook.command) === "writing-first"),
    )
    expect(writing?.matcher).toBe(CODEX_MATCHERS["writing-first"])
  })

  // A Codex shell call reaches every Bash guard through guards.ts's one handler, as a Claude Code Bash call does, and writing-first beside it.
  test("a Codex shell call runs guards.ts and writing-first alone", () => {
    const bash = (codexHooks(FACTORY.hooks).PreToolUse ?? [])
      .filter((group) => new RegExp(group.matcher ?? "").test("Bash"))
      .flatMap((group) => group.hooks.map((hook) => hookOf(hook.command)))
    expect(bash.sort()).toEqual(["guards", "writing-first"])
  })

  test("a Codex hook holds no onFailure, a key Codex's handler lacks", () => {
    const rendered = Object.values(codexHooks(FACTORY.hooks)).flatMap((groups) =>
      groups.flatMap((group) => group.hooks),
    )
    expect(rendered.filter((hook) => "onFailure" in hook)).toEqual([])
  })
})
