import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scratchEnv } from "./scratch-env"

const ROOT = join(import.meta.dir, "..")

// The red-first run: a bare bun test outside the sandbox wrote under the real home and opened sessions on the live herdr server
test("a bare bun test outside the sandbox stops before any test runs and names bun run test:file", () => {
  const scratch = mkdtempSync(join(tmpdir(), "require-sandbox-"))
  try {
    const home = join(scratch, "home")
    mkdirSync(home)
    const fixture = join(scratch, "writes-home.test.ts")
    writeFileSync(
      fixture,
      `import { test } from "bun:test"\nimport { mkdirSync, writeFileSync } from "node:fs"\nimport { homedir } from "node:os"\ntest("writes under the home", () => {\n  mkdirSync(homedir() + "/.claude", { recursive: true })\n  writeFileSync(homedir() + "/.claude/written", "")\n})\n`,
    )
    const run = Bun.spawnSync(["bun", "test", fixture], {
      cwd: ROOT,
      env: scratchEnv(home, { TEST_SANDBOX_HOME: undefined }),
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(run.exitCode).not.toBe(0)
    expect(`${run.stdout}${run.stderr}`).toContain("bun run test:file")
    expect(existsSync(join(home, ".claude"))).toBe(false)
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})
