import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { engineDataOf } from "../../../../../packages/scripts/src/ops-job/job"

const ROOT = join(import.meta.dir, "../../../../..")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "engine-data-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const repo = (branch: string) => {
  const dir = join(scratch, branch.replaceAll("/", "-"))
  Bun.spawnSync(["git", "init", "-q", "-b", branch, dir])
  return dir
}

test("--data names the folder, the live dashboard's checkout reads the real one, and any other checkout is refused", () => {
  const env = {
    CLAUDE_CONFIG_DIR: join(scratch, "config"),
    PLAYGROUND_DATA_DIR: join(join(scratch, "config"), "playground"),
  }
  expect(engineDataOf(["--data", join(scratch, "d")], repo("work"), env)).toEqual({
    data: join(scratch, "d"),
  })
  expect(engineDataOf([], repo("live/dashboard"), env)).toEqual({
    data: join(scratch, "config", "playground"),
  })
  const refused = engineDataOf([], repo("work"), env)
  expect("refusal" in refused && refused.refusal).toContain("is not the live dashboard's checkout")
  expect(engineDataOf(["--data"], repo("work"), env)).toEqual({ refusal: "--data needs a folder" })
})

test.each(["ops-machine"])(
  "%s run by hand from a worktree with no --data exits 2 before it writes anything",
  (job) => {
    const run = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(ROOT, "packages/scripts/src", job, "cli.ts"),
        "--once",
      ],
      {
        env: {
          CLAUDE_CONFIG_DIR: join(scratch, "home-config"),
          PLAYGROUND_DATA_DIR: join(join(scratch, "home-config"), "playground"),
          HOME: scratch,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        },
        stderr: "pipe",
        timeout: 20_000,
      },
    )
    expect(run.exitCode).toBe(2)
    expect(run.stderr.toString()).toContain(`${job}: `)
    expect(Bun.spawnSync(["ls", join(scratch, "home-config")]).exitCode).not.toBe(0)
  },
)
