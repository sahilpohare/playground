import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { titleRefusal } from "../../../../../packages/scripts/src/ship/title"

const ROOT = join(import.meta.dir, "../../../../..")

// `gh release view <tag> --json name,tagName` as GitHub prints it, read live as {"name":"v0.0.129","tagName":"v0.0.129"}.
const view = (name: string, tagName: string) => JSON.stringify({ name, tagName })

describe("ship:title reads a new version's name against its tag (#2234)", () => {
  test("a version named by its tag passes", () => {
    expect(titleRefusal(view("v0.0.130", "v0.0.130"))).toBeNull()
  })

  test("a version named by its commit's subject fails, with the fix line", () => {
    expect(titleRefusal(view("Merge pull request #2271 from nrjdalal/canary", "v0.0.130"))).toBe(
      'ship:title: v0.0.130 is named "Merge pull request #2271 from nrjdalal/canary", not its tag: run gh release edit v0.0.130 --title v0.0.130',
    )
  })

  test("the release skill's step 4 creates with --title and runs ship:title after it", async () => {
    const text = await Bun.file(join(ROOT, "skills/zerostarter/release/SKILL.md")).text()
    expect(text).toContain(
      "gh release create vX.Y.Z --verify-tag --latest --title vX.Y.Z --notes-file /tmp/notes-vX.Y.Z.md\nbun run ship:title vX.Y.Z\n",
    )
  })
})
