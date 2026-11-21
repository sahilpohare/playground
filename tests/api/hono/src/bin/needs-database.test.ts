import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A folder that is no git clone, two levels deep so load-dotenv's ../../.env stays inside it, with no .env: so no hand-off to a live checkout and no database to reach.
const BIN = join(import.meta.dir, "../../../../../api/hono/src/bin")
const scratch = mkdtempSync(join(tmpdir(), "playground-needs-database-"))
const cwd = join(scratch, "a", "b")
mkdirSync(cwd, { recursive: true })
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const run = (bin: string, ...args: string[]) => {
  const { SKIP_ENV_VALIDATION: _, SKIP_ENV_VALIDATION_SERVER: __, ...rest } = process.env
  return Bun.spawnSync([process.execPath, join(BIN, bin), ...args], {
    cwd,
    env: { ...rest, PLAYGROUND_DATA_DIR: join(scratch, "data"), POSTGRES_URL: "" },
    stderr: "pipe",
    stdout: "pipe",
  })
}

for (const [bin, args, issue] of [
  ["dashboard-ask.ts", ["open"], 2318],
  ["dashboard-ingest.ts", ["status"], 2460],
  ["dashboard-thread.ts", ["list"], 2318],
  ["dashboard-upload.ts", ["i1"], 2460],
] as const)
  test(`${bin} with an empty POSTGRES_URL says there is no database yet, in one line with no stack, and exits 1 (#${issue})`, () => {
    const done = run(bin, ...args)
    expect(done.stderr.toString()).toBe(
      "No database yet: finish first-run setup on the Dashboard, then run this again.\n",
    )
    expect(done.stdout.toString()).toBe("")
    expect(done.exitCode).toBe(1)
  })
