import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The repo's own code carries no license file: the root NOTICE is the only notice, held to its exact text, while each vendored folder keeps the license it shipped with.
const ROOT = join(import.meta.dir, "..")
const NOTICE = `All rights reserved. Not licensed for use.

This notice covers only this repository's own code; each vendored folder keeps its own license.
`

describe("the root NOTICE", () => {
  test("holds its exact text", () => {
    expect(readFileSync(join(ROOT, "NOTICE"), "utf8")).toBe(NOTICE)
  })

  test("the root holds no LICENSE file, any case or extension, while the vendored one stays", () => {
    const licenses = readdirSync(ROOT).filter((name) => /^license(\..*)?$/i.test(name))
    expect(licenses).toEqual([])
    expect(existsSync(join(ROOT, "extensions", "core", "upstream", "mattpocock", "LICENSE"))).toBe(
      true,
    )
  })
})
