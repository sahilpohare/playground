import { describe, expect, test } from "bun:test"

import { inRecordedForm, ticksOf } from "../../../../../../api/hono/src/lib/sessions/proc-start"
import { pidsDir, withProc } from "../../../../../scripts/fixtures/proc"

const LSTART = "Mon Nov 16 07:02:17 2026"

describe("ticksOf", () => {
  test("reads field 22 of /proc/<pid>/stat, counting past the command's last parenthesis", async () => {
    const proc = pidsDir({ 305701: "1801742" })
    expect(await withProc(proc, () => ticksOf(305701))).toBe("1801742")
    expect(await withProc(proc, () => ticksOf(305702))).toBeNull()
  })
})

describe("inRecordedForm", () => {
  test("a Linux record's start is its pid's ticks from /proc, and a macOS record's stays ps's lstart", async () => {
    const proc = pidsDir({ 10: "1801742", 11: "2900000" })
    const starts = new Map([
      [10, LSTART],
      [11, LSTART],
      [12, LSTART],
      [13, LSTART],
    ])
    const records = [
      { pid: 10, procStart: "1801742" },
      { pid: 11, procStart: "1801742" },
      { pid: 12, procStart: LSTART },
      { pid: 13, procStart: "1801742" },
    ]
    expect(await withProc(proc, () => inRecordedForm(starts, records))).toEqual(
      new Map([
        [10, "1801742"],
        [11, "2900000"],
        [12, LSTART],
      ]),
    )
  })
})
