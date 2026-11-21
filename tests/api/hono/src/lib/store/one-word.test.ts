import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { oneWords } from "../../../../../../api/hono/src/lib/store/one-word"

const scratch = mkdtempSync(join(tmpdir(), "one-word-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const script = (name: string, body: string): string => {
  const path = join(scratch, name)
  writeFileSync(path, body)
  return path
}

describe("the Privacy save's one-word matcher run", () => {
  test("answers with what the matcher prints", async () => {
    const cli = script(
      "prints.ts",
      'console.log(JSON.stringify([{ files: ["a.md"], name: "quillon" }]))',
    )
    expect(await oneWords(["quillon"], cli)).toEqual([{ files: ["a.md"], name: "quillon" }])
  })

  test("a run past its bound answers none, so a hung read never holds the save", async () => {
    const cli = script("hangs.ts", "await Bun.sleep(10_000)")
    const started = Date.now()
    expect(await oneWords(["quillon"], cli, 200)).toEqual([])
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
