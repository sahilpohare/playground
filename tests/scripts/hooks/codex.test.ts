import { describe, expect, test } from "bun:test"

import { eachInput, guardInputs } from "../../../scripts/hooks/codex"

// Codex's own fields on a hook input (codex-cli 0.167.1), which Claude Code's input lacks.
const CODEX = {
  model: "gpt-made-up",
  permission_mode: "bypassPermissions",
  session_id: "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
  tool_use_id: "call-1",
  transcript_path: null,
  turn_id: "turn-1",
}
const PATCH = [
  "*** Begin Patch",
  "*** Add File: notes/new.md",
  "+hello",
  "*** Update File: /abs/old.ts",
  "*** Move to: moved/old.ts",
  "@@",
  "-a",
  "+b",
  "  *** Delete File: gone.txt  ",
  "*** End Patch",
].join("\n")
const PATHS = ["/work/notes/new.md", "/abs/old.ts", "/work/moved/old.ts", "/work/gone.txt"]

const codex = (tool: string, command: string) =>
  JSON.stringify({
    ...CODEX,
    cwd: "/work",
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: tool,
  })
const writes = (inputs: string[] | null) =>
  (inputs ?? []).map((raw) => JSON.parse(raw) as Record<string, unknown>)

describe("a Codex edit reaches the guards as one Write per file its patch names", () => {
  test("an apply_patch call: every file it adds, updates, moves to or deletes, from the call's folder", () => {
    const read = writes(guardInputs(codex("apply_patch", PATCH)))
    expect(read.map((w) => w.tool_name)).toEqual(["Write", "Write", "Write", "Write"])
    expect(read.map((w) => (w.tool_input as { file_path: string }).file_path)).toEqual(PATHS)
    // each Write carries the whole patch as its content, and the call's own fields
    expect(read.every((w) => (w.tool_input as { content: string }).content === PATCH)).toBe(true)
    expect(read.every((w) => w.cwd === "/work" && w.turn_id === "turn-1")).toBe(true)
  })

  test("an apply_patch command in the shell: the call itself, then each file", () => {
    const raw = codex("Bash", `cd /work && apply_patch <<'EOF'\n${PATCH}\nEOF`)
    const inputs = guardInputs(raw)
    expect(inputs?.[0]).toBe(raw)
    expect(
      writes(inputs?.slice(1) ?? []).map((w) => (w.tool_input as { file_path: string }).file_path),
    ).toEqual(PATHS)
  })

  test("an apply_patch whose patch names no file is no input a guard can read", async () => {
    for (const raw of [
      codex("apply_patch", "*** Begin Patch\n*** End Patch"),
      codex("apply_patch", ""),
      codex("Bash", "apply_patch < /tmp/p.patch"),
      codex("Bash", 'applypatch "$(cat /tmp/p.patch)"'),
    ]) {
      expect(guardInputs(raw)).toBeNull()
      expect(await eachInput(raw, "no-made-up", async () => undefined)).toContain(
        "no-made-up hook refuses",
      )
    }
  })

  test("every other input reaches the guard as it came", async () => {
    const claude = JSON.stringify({
      cwd: "/work",
      hook_event_name: "PreToolUse",
      tool_input: { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` },
      tool_name: "Bash",
    })
    for (const raw of [
      claude,
      codex("Bash", "git status"),
      codex("Bash", "grep -rn apply_patch docs"),
      codex("mcp__github__add_issue_comment", "x"),
      "not json",
    ])
      expect(guardInputs(raw)).toEqual([raw])
    const seen: string[] = []
    expect(
      await eachInput(codex("apply_patch", PATCH), "no-made-up", async (one) => {
        seen.push(one)
        return seen.length === 2 ? "no-made-up hook refuses the second" : undefined
      }),
    ).toBe("no-made-up hook refuses the second")
    expect(seen).toHaveLength(2)
  })
})

// Each edit guard names itself in the refusal of a patch it cannot read, so a guard renamed without its eachInput call turns this red.
test("every edit guard refuses, in its own name, an apply_patch that names no file", async () => {
  const unread = codex("apply_patch", "*** Begin Patch\n*** End Patch")
  const env = { HOME: "/made-up-home", PLAYGROUND_ROLE: "worker" }
  const guards = {
    "no-extensions-write": (await import("../../../scripts/hooks/no-extensions-write")).check,
    "no-linear-ticket": (await import("../../../scripts/hooks/no-linear-ticket")).check,
    "no-main-checkout": (await import("../../../scripts/hooks/no-main-checkout")).check,
    "no-raw-wa": (await import("../../../scripts/hooks/no-raw-wa")).check,
  }
  for (const [guard, check] of Object.entries(guards))
    expect(await check(unread, env)).toContain(`${guard} hook refuses an apply_patch`)
})
