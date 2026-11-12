import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

// The script must type-check a checkout with no env of its own: `env -i` strips every inherited value and bun --no-env-file loads no .env file, so the run holds nothing but its PATH and HOME, and the flags the script sets are all it has. It goes red where the script sets none, which a checkout with a root .env cannot show: auth's build loads that .env through load-dotenv even under `env -i`, so there the run passes on any script and the file skips.
test.skipIf(existsSync(join(root, ".env")))(
  "bun run check-types runs with no env of its own",
  () => {
    const run = Bun.spawnSync(
      [
        "env",
        "-i",
        `PATH=${process.env.PATH}`,
        `HOME=${process.env.HOME}`,
        "bun",
        "--no-env-file",
        "run",
        "check-types",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
    )
    if (run.exitCode !== 0) console.error((run.stderr?.toString() ?? "").slice(-4000))
    expect(run.exitCode).toBe(0)
  },
  120_000,
)
