import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"

import { unlinked } from "./playground/unlinked"

// Runs a pre-commit step (the build or a type check) or the pre-push test:skills step through the machine's commit slot, `~/.playground/ops/run-slot.sh commit-<worktree> -- <step>` marked `RUN_SLOT_COMMIT_STEP=1`, which run-slot gives `run-slot-commit` as it gives `run-slot.sh <who> -- git commit` (3 Nov: a plain commit's build waited about an hour in the full queue), when the commit is in a worktree under `.claude/worktrees/` and that script is executable; it runs the step bare anywhere else, in a commit already running under run-slot (whose child carries the `RUN_SLOT_NICE` it exports), so a commit never waits on a slot it holds, and for the build when turbo can replay every build task from its cache, since a replay ran 2 s or less after waits of up to 1,788 s (2 Nov, run-slot.runs.log); a type check reads no such cache, so it takes the slot whenever it would.

const WORKTREE = /\/\.claude\/worktrees\/([^/]+)/

const DRY_RUN = ["bun", "run", "turbo", "run", "build", "--dry=json"]

// The one step whose cost turbo's cache speaks for.
const BUILD = ["bun", "run", "build"]
export const isBuild = (step: string[]): boolean => step.join(" ") === BUILD.join(" ")

export const replays = (dry: string): boolean => {
  try {
    const tasks = (
      JSON.parse(dry).tasks as { cache?: { status?: string }; command?: string }[]
    ).filter((task) => task.command !== "<NONEXISTENT>")
    return tasks.length > 0 && tasks.every((task) => task.cache?.status === "HIT")
  } catch {
    return false
  }
}

export const slotted = ({
  argv,
  cached,
  cwd,
  env,
  executable,
  home,
}: {
  argv: string[]
  cached: () => boolean
  cwd: string
  env: Record<string, string | undefined>
  executable: (path: string) => boolean
  home: string
}): string[] => {
  const folder = WORKTREE.exec(cwd)?.[1]
  const runSlot = `${home}/.playground/ops/run-slot.sh`
  if (!folder || env.RUN_SLOT_NICE !== undefined || !executable(runSlot) || cached()) return argv
  return [runSlot, `commit-${folder.replace(/[^A-Za-z0-9._#-]/g, "-")}`, "--", ...argv]
}

// Pure: why the step stops before it asks for a slot, or null: a workspace dependency no node_modules holds, which a canary merge that adds a package leaves until the worktree installs (PG-672: the build waited for a slot, then failed with exit 127, naming nothing).
export const unlinkedRefusal = (missing: string[], cwd: string): string | null =>
  missing.length === 0
    ? null
    : [
        "commit-slot: this checkout's install predates its workspace packages, so the build would fail; unlinked:",
        ...missing.map((line) => `  ${line}`),
        `run \`~/.playground/ops/run-slot.sh <your name> -- bun install --ignore-scripts --cwd ${cwd}\`, then commit again`,
      ].join("\n")

if (import.meta.main) {
  const refusal = unlinkedRefusal(await unlinked(process.cwd()), process.cwd())
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const step = process.argv.slice(2)
  const argv = slotted({
    argv: step,
    cached: () => {
      if (!isBuild(step)) return false
      const dry = Bun.spawnSync(DRY_RUN, { stderr: "ignore", stdout: "pipe", timeout: 10_000 })
      return dry.exitCode === 0 && replays(dry.stdout.toString())
    },
    cwd: process.cwd(),
    env: process.env,
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    home: process.env.HOME || homedir(),
  })
  const child = Bun.spawn(argv, {
    env: argv === step ? process.env : { ...process.env, RUN_SLOT_COMMIT_STEP: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await child.exited)
}
