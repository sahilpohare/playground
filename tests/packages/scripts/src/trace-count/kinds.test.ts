import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { reposOf } from "../../../../../packages/scripts/src/trace-count/kinds"

const scratch = mkdtempSync(join(tmpdir(), "kinds-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// a git checkout in the scratch folder, with the origin given or none
const checkout = (name: string, origin?: string): string => {
  const dir = join(scratch, name)
  Bun.spawnSync(["git", "init", "-q", dir])
  if (origin) Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", origin])
  return dir
}

// the public repositories reposOf reads with factory.publicRepo unset, for the checkout given, as a bundled guard reads the main checkout
const unsetFrom = (dir: string): string[] => reposOf({ schemaVersion: 1, values: {} }, dir).public

// issue 1454: with factory.publicRepo unset the public repository is the checkout's origin, never a fixed pair
test("factory.publicRepo unset reads the checkout's origin, and none with no origin", () => {
  expect(unsetFrom(checkout("https", "https://github.com/Acme/Made-Up.git"))).toEqual([
    "acme/made-up",
  ])
  expect(unsetFrom(checkout("none"))).toEqual([])
})

test("a set factory.publicRepo wins over the origin", () => {
  const repos = reposOf({
    schemaVersion: 1,
    values: { "factory.publicRepo": ["Acme/Site", "acme/yard"] },
  })
  expect(repos.public).toEqual(["acme/site", "acme/yard"])
})

test("a one-repo factory.publicRepo, as a list of one or a bare string, guards that repo alone", () => {
  for (const value of [["Acme/Site"], "Acme/Site"])
    expect(reposOf({ schemaVersion: 1, values: { "factory.publicRepo": value } }).public).toEqual([
      "acme/site",
    ])
})
