import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { originRepo } from "../packages/scripts/src/playground/setting"
import { originCheckout, rowMode, zshMissing } from "./machine"

const scratch = mkdtempSync(join(tmpdir(), "machine-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

test("a row runs with nothing missing, skips with a reason off CI, and fails with one under CI", () => {
  expect(rowMode(undefined, undefined)).toBe("run")
  expect(rowMode(undefined, "true")).toBe("run")
  expect(rowMode("zsh not on PATH", undefined)).toBe("skip")
  expect(rowMode("zsh not on PATH", "true")).toBe("fail")
})

test("zsh is missing from a PATH that holds no zsh, naming that PATH", () => {
  expect(zshMissing("/nonexistent")).toContain("zsh not on PATH /nonexistent;")
})

test("originCheckout makes a checkout whose origin reads as the made-up repo", () => {
  expect(originRepo(originCheckout(join(scratch, "c"), "acme/made-up"))).toBe("acme/made-up")
})

// GitHub CI's Suite shards install zsh, so a reason that fires there is a lost install, red rather than a quiet skip
test("under CI zsh is on PATH and in /usr/bin:/bin", () => {
  if (!process.env.CI) return
  expect(zshMissing()).toBeUndefined()
  expect(zshMissing("/usr/bin:/bin")).toBeUndefined()
})
