import { describe, expect, test } from "bun:test"

import { USAGE } from "../../../../../packages/scripts/src/machine-record/cli"

describe("record add's usage (PG-2697)", () => {
  test("the usage holds one line: an undo with a delete word comes in through --stdin", () => {
    const line = USAGE.split("\n").find((l) => /docker rm/.test(l) && /--stdin/.test(l))
    expect(line).toContain("--stdin < entry.json, a JSON list holding the entry")
    expect(line).toContain("(rm, rmdir, docker rm -fv)")
    expect(line).toContain("the no-raw-delete hook reads a quoted --undo value as a command")
  })
})
