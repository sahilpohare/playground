import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const web = join(import.meta.dir, "../../../../../../web/next")
const home = await Bun.file(join(web, "src/components/settings/settings-home.tsx")).text()

describe("the Settings page", () => {
  test("shows nothing of the machine below the owner rung", () => {
    expect(home).toMatch(/allowed \?[\s\S]*<Accounts \/>[\s\S]*: \(\s*<OwnerOnly/)
  })

  test("lists Harness, then Templates, between Accounts and Extensions", () => {
    expect(home).toMatch(/<Accounts \/>\s*<Harness \/>\s*<Templates \/>\s*<Extensions \/>/)
  })

  test("holds Privacy after Extensions, above the owner rung's fallback", () => {
    expect(home).toMatch(/<Extensions \/>\s*<Privacy \/>[\s\S]*: \(\s*<OwnerOnly/)
  })

  // PG-1196: Jobs follows Privacy, so the sections a person sets up first stay on top
  test("lists Jobs after Privacy, above Remote", () => {
    expect(home).toMatch(/<Privacy \/>\s*<Jobs \/>\s*<Remote \/>/)
  })
})
