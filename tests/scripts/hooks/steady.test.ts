import { expect, test } from "bun:test"

import { quotedBodiesOut } from "../../../scripts/hooks/steady"

// #1183: zsh's dash modifier keeps the next word a program word, as `command` does, so a read there leaves the line whole
test.each(["command", "-"])(
  "a read as the program word behind %s keeps the line whole",
  (modifier) => {
    const line = `${modifier} $P <<'EOF'\nbody\nEOF`
    expect(quotedBodiesOut(line)).toBe(line)
  },
)

test("a quoted heredoc's body behind the dash and a plain program reads as an empty line", () => {
  expect(quotedBodiesOut("- cat <<'EOF'\nbody\nEOF")).toBe("- cat <<'EOF'\n\nEOF")
})
