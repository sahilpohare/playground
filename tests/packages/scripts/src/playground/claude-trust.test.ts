import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { boxEnv } from "../../../../../packages/scripts/src/box-env"
import { trust, withTrust } from "../../../../../packages/scripts/src/playground/claude-trust"

const SCRIPT = join(
  import.meta.dir,
  "../../../../../packages/scripts/src/playground/claude-trust.ts",
)
const FOLDER = "/code/playground"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true })
})
// A scratch HOME, so the real ~/.claude.json is never read or written.
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-trust-"))
  homes.push(dir)
  return dir
}

describe("withTrust", () => {
  test("adds the yes for the folder and keeps every other key and project", () => {
    const text = JSON.stringify({
      oauthAccount: { emailAddress: "made-up@example.com" },
      projects: {
        "/elsewhere": { hasTrustDialogAccepted: false },
        [FOLDER]: { allowedTools: ["Bash"] },
      },
    })
    expect(JSON.parse(withTrust(text, FOLDER)!)).toEqual({
      oauthAccount: { emailAddress: "made-up@example.com" },
      projects: {
        "/elsewhere": { hasTrustDialogAccepted: false },
        [FOLDER]: { allowedTools: ["Bash"], hasTrustDialogAccepted: true },
      },
    })
  })

  test("starts a config when there is none, and leaves one that does not read as an object", () => {
    expect(JSON.parse(withTrust(null, FOLDER)!)).toEqual({
      projects: { [FOLDER]: { hasTrustDialogAccepted: true } },
    })
    for (const text of ["{", "[]", "null", '"text"']) expect(withTrust(text, FOLDER)).toBeNull()
  })
})

describe("trust", () => {
  test("writes the yes into the home's .claude.json, keeping its mode, and a new one at 600", () => {
    const dir = home()
    const config = join(dir, ".claude.json")
    expect(trust(dir, FOLDER)).toEqual({ code: 0, line: `Claude Code trusts ${FOLDER}` })
    expect(statSync(config).mode & 0o777).toBe(0o600)
    writeFileSync(config, JSON.stringify({ numStartups: 3 }))
    chmodSync(config, 0o644)
    expect(trust(dir, FOLDER).code).toBe(0)
    expect(statSync(config).mode & 0o777).toBe(0o644)
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      numStartups: 3,
      projects: { [FOLDER]: { hasTrustDialogAccepted: true } },
    })
  })

  // install.sh runs it on every run, and a second run changes nothing
  test("leaves a config that already trusts the folder as it is, the same file and bytes", () => {
    const dir = home()
    const config = join(dir, ".claude.json")
    const text = JSON.stringify({ projects: { [FOLDER]: { hasTrustDialogAccepted: true } } })
    writeFileSync(config, text)
    const inode = statSync(config).ino
    expect(trust(dir, FOLDER)).toEqual({ code: 0, line: `Claude Code already trusts ${FOLDER}` })
    expect(statSync(config).ino).toBe(inode)
    expect(readFileSync(config, "utf8")).toBe(text)
  })

  test("leaves a config that does not read as it is and says so", () => {
    const dir = home()
    writeFileSync(join(dir, ".claude.json"), "{")
    const done = trust(dir, FOLDER)
    expect(done.code).toBe(1)
    expect(done.line).toContain("does not read as Claude Code's config")
    expect(readFileSync(join(dir, ".claude.json"), "utf8")).toBe("{")
  })

  test("the script trusts the folder it is given in HOME's config", () => {
    const dir = home()
    const run = Bun.spawnSync(["bun", "--no-env-file", SCRIPT, FOLDER], {
      env: boxEnv(dir),
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).projects).toEqual({
      [FOLDER]: { hasTrustDialogAccepted: true },
    })
  })
})
