import { describe, expect, test } from "bun:test"

import { promptKey, refusalOf } from "../../../../../packages/scripts/src/playground/prompt"
import { callKey } from "../../../../../packages/scripts/src/stuck-alert"

const RULE = "─".repeat(60)
const DASHES = "╌".repeat(60)
// A hook's confirmation prompt in the shape Claude Code draws it: a full rule, the command between two dashed rules, the hook's reason and plugin lines, then its question; a prompt taller than the pane is clipped to its last rows, with no marker row.
const hookPrompt = (command: string) =>
  [
    `⏺ Bash(${command.split("\n")[0]})`,
    RULE,
    " Bash command",
    "",
    DASHES,
    ...command.split("\n").map((line) => ` │ ${line}`),
    DASHES,
    "",
    " Hook tool.check requires confirmation for this command:",
    " made-up-guard asks before a call that writes under a made-up folder,",
    " since that folder is kept for made-up notes.",
    " (plugin: made-up-plugin)",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel",
  ].join("\n")
// What `herdr pane read --source visible` returns: the pane's last rows alone, 24 of them as a manager's pane showed on 13 Nov.
const visible = (screen: string, rows = 24) => screen.split("\n").slice(-rows).join("\n")
// A transcript whose calls all wait on their result: a Bash command by its text, any other tool as [name, input].
const waiting = (...calls: (string | [string, Record<string, unknown>])[]) =>
  calls
    .map((call, i) => {
      const [name, input] = typeof call === "string" ? ["Bash", { command: call }] : call
      return JSON.stringify({
        message: { content: [{ id: `t${i}`, input, name, type: "tool_use" }] },
        type: "assistant",
      })
    })
    .join("\n")
const SHORT = "echo made-up > /tmp/made-up/note.txt"
const LONG = [
  "cat > /tmp/made-up/notes.md <<'EOF'",
  ...Array.from({ length: 50 }, (_, i) => `made-up line ${i + 1}`),
  "EOF",
].join("\n")

describe("a hook's confirmation prompt", () => {
  test("a short command's prompt is its waiting call's", () => {
    const screen = visible(hookPrompt(SHORT))
    expect(refusalOf("k3m9px-worker", screen, waiting(SHORT), callKey({ command: SHORT }))).toBe("")
    expect(promptKey(screen, waiting(SHORT))).toBe(callKey({ command: SHORT }))
  })

  test("a long command's prompt, its top rule above the visible screen, is its waiting call's", () => {
    const screen = visible(hookPrompt(LONG))
    expect(screen).not.toContain(RULE)
    expect(refusalOf("k3m9px-worker", screen, waiting(LONG), callKey({ command: LONG }))).toBe("")
    expect(promptKey(screen, waiting(SHORT, LONG))).toBe(callKey({ command: LONG }))
  })

  test("a long command's cut prompt is not another waiting call's", () => {
    const screen = visible(hookPrompt(LONG))
    expect(
      refusalOf("k3m9px-worker", screen, waiting(SHORT, LONG), callKey({ command: SHORT })),
    ).toBe(
      "k3m9px-worker's prompt is not for the call with key " +
        `${callKey({ command: SHORT })}; nothing was pressed`,
    )
  })

  test("a long command's cut prompt is not a waiting Write's whose file name it shows", () => {
    const command = `${LONG}\nwc -l /tmp/made-up/notes.md`
    const write = { content: "made-up", file_path: "/tmp/made-up/notes.md" }
    const screen = visible(hookPrompt(command))
    expect(
      refusalOf("k3m9px-worker", screen, waiting(command, ["Write", write]), callKey(write)),
    ).toBe(
      `k3m9px-worker's prompt is not for the call with key ${callKey(write)}; nothing was pressed`,
    )
  })

  test("a long command's cut prompt may be a waiting parent's or another command's with the same last rows", () => {
    const screen = visible(hookPrompt(LONG))
    const parent: [string, Record<string, unknown>] = ["Agent", { prompt: "Made-up notes" }]
    for (const other of [parent, LONG.replace("notes.md", "other.md")])
      expect(
        refusalOf("k3m9px-worker", screen, waiting(other, LONG), callKey({ command: LONG })),
      ).toContain("k3m9px-worker's prompt may be another waiting call's")
  })

  test("a screen with no prompt still gets no key", () => {
    const screen = visible(LONG)
    expect(refusalOf("k3m9px-worker", screen, waiting(LONG), callKey({ command: LONG }))).toBe(
      "k3m9px-worker's pane shows no permission prompt; nothing was pressed",
    )
    expect(promptKey(screen, waiting(LONG))).toBeNull()
  })

  test("a question with no rule and no dashed rule above it is no prompt", () => {
    const screen = [SHORT, " Do you want to proceed?", " ❯ 1. Yes", "   2. No"].join("\n")
    expect(refusalOf("k3m9px-worker", screen, waiting(SHORT), callKey({ command: SHORT }))).toBe(
      "k3m9px-worker's pane shows no permission prompt; nothing was pressed",
    )
  })
})
