import { describe, expect, test } from "bun:test"

import {
  NEW_USER_PATHS,
  newUserFiles,
} from "../../../../../packages/scripts/src/new-user-gate/paths"

// a PR that broke curl | bash showed only at the ship's new-user gate, so a diff on what a new user meets first waits for the gate (PG-2496).
describe("the new-user gate's paths", () => {
  test.each([
    "install.sh",
    "packages/scripts/src/playground/claude-trust.ts",
    "packages/scripts/src/playground/uninstall.ts",
    "packages/scripts/src/new-user-gate/cli.ts",
    "api/hono/src/lib/onboard/fix.ts",
    "api/hono/src/lib/setup/fix.ts",
    "api/hono/src/routers/onboard.ts",
    "web/next/src/components/first-run/setup.tsx",
    "web/next/src/lib/first-run.ts",
    "scripts/spawn.sh",
  ])("%s matches", (path) => {
    expect(newUserFiles([path, "AGENTS.md"])).toEqual([path])
  })

  test.each([
    "AGENTS.md",
    "scripts/spawn.sh.bak",
    "install.sh.md",
    "api/hono/src/lib/onboarding.ts",
    "web/next/src/lib/first-run.test.ts",
    "tests/packages/scripts/src/new-user-gate/cli.test.ts",
  ])("%s matches nothing", (path) => {
    expect(newUserFiles([path])).toEqual([])
  })

  test("the list is sorted A to Z", () => {
    expect([...NEW_USER_PATHS]).toEqual([...NEW_USER_PATHS].sort())
  })
})
