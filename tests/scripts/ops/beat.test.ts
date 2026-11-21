import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GH_STALE_MS } from "../../../packages/scripts/src/gh-read"

const ops = join(import.meta.dir, "..", "..", "..", "scripts", "ops")

const checkout = (env: Record<string, string>, cwd: string, dir = ops) => {
  const run = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(dir)}); import beat; print(beat.checkout())`,
    ],
    { cwd, env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", ...env } },
  )
  expect(run.exitCode).toBe(0)
  return run.stdout.toString().trim()
}

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "beat-checkout-")))

test("checkout() is PLAYGROUND_REPO first", () => {
  expect(checkout({ PLAYGROUND_REPO: "/set/by/env" }, scratch())).toBe("/set/by/env")
})

test("checkout() is the main checkout of the folder it runs in, from a worktree too", () => {
  const main = scratch()
  mkdirSync(join(main, "scripts"))
  writeFileSync(join(main, "scripts", "spawn.sh"), "")
  const git = (...args: string[]) =>
    expect(Bun.spawnSync(["git", "-C", main, ...args]).exitCode).toBe(0)
  git("init", "-q")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "t")
  const tree = join(main, "wt")
  git("worktree", "add", "-q", tree, "-b", "wt")
  expect(checkout({}, tree)).toBe(main)
})

test("checkout() is its own checkout where the job's folder is none, else the code root's playground", () => {
  const code = scratch()
  const copy = join(code, "copy", "scripts", "ops")
  mkdirSync(copy, { recursive: true })
  writeFileSync(join(copy, "beat.py"), readFileSync(join(ops, "beat.py")))
  const from = (dir: string) => checkout({ HOME: scratch() }, scratch(), dir)
  expect(from(copy)).toBe(join(code, "playground"))
  writeFileSync(join(code, "copy", "scripts", "spawn.sh"), "")
  expect(from(copy)).toBe(join(code, "copy"))
})

// the merge train's job reads gh every cycle, so it skips gh while ops-tick's gh sign-in probe reads failed (#2526)
describe("gh_down", () => {
  const ghDownOf = (result: unknown, now: number) => {
    const dir = scratch()
    const path = join(dir, "gh-auth.json")
    writeFileSync(path, typeof result === "string" ? result : JSON.stringify(result))
    const run = Bun.spawnSync(
      [
        "python3",
        "-I",
        "-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(ops)}); import beat; print(beat.gh_down(${JSON.stringify(path)}, ${now / 1000}))`,
      ],
      { cwd: dir, env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" } },
    )
    expect(run.exitCode).toBe(0)
    return run.stdout.toString().trim()
  }
  const AT = "2026-11-17T01:50:00.000Z"
  const at = Date.parse(AT)

  test("reads a fresh failed result's reason, and anything else as None", () => {
    expect(ghDownOf({ at: AT, ok: false, reason: "gh token invalid" }, at + 60_000)).toBe(
      "gh token invalid",
    )
    expect(ghDownOf({ at: AT, ok: false }, at)).toBe("gh fails")
    expect(ghDownOf({ at: AT, ok: false, reason: "x" }, at + GH_STALE_MS + 1_000)).toBe("None")
    expect(ghDownOf({ at: AT, ok: true }, at)).toBe("None")
    expect(ghDownOf("{", at)).toBe("None")
  })

  test("holds gh-read.ts's stale age", () => {
    const beat = readFileSync(join(ops, "beat.py"), "utf8")
    expect(Number(beat.match(/^GH_STALE = (\d+)/m)?.[1]) * 1000).toBe(GH_STALE_MS)
  })
})
