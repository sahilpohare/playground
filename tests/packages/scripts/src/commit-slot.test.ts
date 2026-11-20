import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isBuild, replays, slotted } from "../../../../packages/scripts/src/commit-slot"
import { scratchEnv } from "../../../scratch-env"

const SCRIPT = join(import.meta.dir, "../../../../packages/scripts/src/commit-slot.ts")
const DIR = mkdtempSync(join(tmpdir(), "commit-slot-"))

afterAll(() => rmSync(DIR, { force: true, recursive: true }))

const RUN_SLOT = "/home/someone/.playground/ops/run-slot.sh"
const WORKTREE = "/repo/.claude/worktrees/pg-1314-slot-commit"
const at = (
  cwd: string,
  env: Record<string, string | undefined> = {},
  runnable = true,
  cached = () => false,
) =>
  slotted({
    argv: ["bun", "run", "build"],
    cached,
    cwd,
    env,
    executable: () => runnable,
    home: "/home/someone",
  })
const dry = (...statuses: string[]) =>
  JSON.stringify({
    tasks: statuses.map((status, i) => ({
      cache: { status },
      command: "tsdown",
      taskId: `p${i}#build`,
    })),
  })

describe("slotted", () => {
  test("a worktree's step takes the run slot under its folder's name", () => {
    expect(at(WORKTREE)).toEqual([
      RUN_SLOT,
      "commit-pg-1314-slot-commit",
      "--",
      "bun",
      "run",
      "build",
    ])
  })

  test("a subfolder of a worktree is named for the worktree", () => {
    expect(at(`${WORKTREE}/web/next`)[1]).toBe("commit-pg-1314-slot-commit")
  })

  test("a folder name run-slot would refuse is cleaned to its characters", () => {
    expect(at("/repo/.claude/worktrees/a b+c")[1]).toBe("commit-a-b-c")
  })

  test("with no executable run-slot.sh the step runs bare", () => {
    expect(at(WORKTREE, {}, false)).toEqual(["bun", "run", "build"])
  })

  test("outside a worktree the step runs bare", () => {
    expect(at("/repo")).toEqual(["bun", "run", "build"])
  })

  test("a commit already under run-slot runs the step bare, so it never waits on its own slot", () => {
    expect(at(WORKTREE, { RUN_SLOT_NICE: "10" })).toEqual(["bun", "run", "build"])
  })

  test("a run-slot nice of 0, as ops-dashboard sets, still reads as under run-slot", () => {
    expect(at(WORKTREE, { RUN_SLOT_NICE: "0" })).toEqual(["bun", "run", "build"])
  })

  test("a worktree's build that turbo replays whole from its cache runs bare", () => {
    expect(at(WORKTREE, {}, true, () => true)).toEqual(["bun", "run", "build"])
  })

  test("asks turbo only when the step would otherwise take the slot", () => {
    let asked = 0
    const ask = () => ++asked > 0
    at("/repo", {}, true, ask)
    at(WORKTREE, { RUN_SLOT_NICE: "10" }, true, ask)
    at(WORKTREE, {}, false, ask)
    expect(asked).toBe(0)
  })
})

test("isBuild names the build alone, the one step turbo's cache speaks for", () => {
  expect(isBuild(["bun", "run", "build"])).toBe(true)
  expect(isBuild(["bun", "run", "check-types:tests"])).toBe(false)
  expect(isBuild(["bun", "run", "--cwd", "packages/scripts", "check-types"])).toBe(false)
})

describe("replays", () => {
  test("every task a cache hit replays", () => {
    expect(replays(dry("HIT", "HIT"))).toBe(true)
  })

  test("one task missing the cache does not", () => {
    expect(replays(dry("HIT", "MISS"))).toBe(false)
  })

  test("a task with no command is left out, as run-slot's check-types test leaves it", () => {
    const tasks = [
      { cache: { status: "HIT" }, command: "tsdown" },
      { cache: { status: "MISS" }, command: "<NONEXISTENT>" },
    ]
    expect(replays(JSON.stringify({ tasks }))).toBe(true)
  })

  test("no task, or output that is not turbo's JSON, does not", () => {
    expect(replays(dry())).toBe(false)
    expect(replays("turbo: not found")).toBe(false)
    expect(replays("{}")).toBe(false)
  })
})

describe("commit-slot.ts", () => {
  const home = join(DIR, "home")
  const ops = join(home, ".playground/ops")
  const worktree = join(DIR, "repo/.claude/worktrees/wt-one")
  mkdirSync(ops, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  const env = () => scratchEnv(home)
  const run = (args: string[]) =>
    Bun.spawnSync(["bun", "--no-env-file", SCRIPT, ...args], {
      cwd: worktree,
      env: env(),
      stderr: "pipe",
      stdout: "pipe",
    })

  // 3 Nov: a plain commit's build waited about an hour in the full queue, since run-slot gave the commit slot to git's own words alone
  test("hands the step to run-slot.sh marked as a commit's step, and keeps its exit code", () => {
    const seen = join(DIR, "seen")
    writeFileSync(
      join(ops, "run-slot.sh"),
      `#!/bin/sh\necho "$RUN_SLOT_COMMIT_STEP $@" > '${seen}'\nexit 7\n`,
    )
    chmodSync(join(ops, "run-slot.sh"), 0o755)
    let result: ReturnType<typeof run>
    try {
      result = run(["echo", "hi"])
    } finally {
      rmSync(join(ops, "run-slot.sh"))
    }
    expect(readFileSync(seen, "utf8")).toBe("1 commit-wt-one -- echo hi\n")
    expect(result.exitCode).toBe(7)
  })

  test("runs the step bare when run-slot.sh is not executable", () => {
    writeFileSync(join(ops, "run-slot.sh"), "#!/bin/sh\nexit 7\n")
    let result: ReturnType<typeof run>
    try {
      result = run(["echo", "hi"])
    } finally {
      rmSync(join(ops, "run-slot.sh"))
    }
    expect(result.stdout.toString()).toBe("hi\n")
    expect(result.exitCode).toBe(0)
  })

  const turbo = (out: string, step: () => ReturnType<typeof run>, code = 0) => {
    const seen = join(DIR, "seen-turbo")
    rmSync(seen, { force: true })
    mkdirSync(join(worktree, "node_modules/.bin"), { recursive: true })
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ scripts: { build: "echo hi" } }))
    writeFileSync(
      join(worktree, "node_modules/.bin/turbo"),
      `#!/bin/sh\necho "$@" > '${seen}'\necho '${out}'\nexit ${code}\n`,
    )
    chmodSync(join(worktree, "node_modules/.bin/turbo"), 0o755)
    const slot = join(DIR, "seen-slot")
    rmSync(slot, { force: true })
    writeFileSync(join(ops, "run-slot.sh"), `#!/bin/sh\necho "$@" > '${slot}'\nexit 7\n`)
    chmodSync(join(ops, "run-slot.sh"), 0o755)
    try {
      const result = step()
      return {
        asked: existsSync(seen) ? readFileSync(seen, "utf8") : undefined,
        result,
        slot: existsSync(slot) ? readFileSync(slot, "utf8") : undefined,
      }
    } finally {
      rmSync(join(ops, "run-slot.sh"))
      rmSync(join(worktree, "node_modules"), { force: true, recursive: true })
      rmSync(join(worktree, "package.json"))
    }
  }

  test("runs the step bare when turbo's dry run finds every build task cached", () => {
    const { asked, result, slot } = turbo(dry("HIT", "HIT"), () => run(["bun", "run", "build"]))
    expect(asked).toBe("run build --dry=json\n")
    expect(slot).toBeUndefined()
    expect(result.stdout.toString()).toBe("hi\n")
    expect(result.exitCode).toBe(0)
  })

  test("hands the step to run-slot.sh when turbo's dry run exits non-zero, whatever JSON it printed", () => {
    const { result, slot } = turbo(dry("HIT", "HIT"), () => run(["bun", "run", "build"]), 1)
    expect(slot).toBe("commit-wt-one -- bun run build\n")
    expect(result.exitCode).toBe(7)
  })

  test("hands the step to run-slot.sh as commit-<worktree> when one build task misses the cache", () => {
    const { result, slot } = turbo(dry("HIT", "MISS"), () => run(["bun", "run", "build"]))
    expect(slot).toBe("commit-wt-one -- bun run build\n")
    expect(result.exitCode).toBe(7)
  })

  // a test-only commit's build replayed in 0.83 s, then its type check, which turbo's build cache says nothing of, waited 72.57 s (PR review, 3 Nov)
  test("hands a type check to run-slot.sh even when turbo would replay every build task, and asks turbo nothing", () => {
    const { asked, result, slot } = turbo(dry("HIT", "HIT"), () =>
      run(["bun", "run", "check-types:tests"]),
    )
    expect(asked).toBeUndefined()
    expect(slot).toBe("commit-wt-one -- bun run check-types:tests\n")
    expect(result.exitCode).toBe(7)
  })

  test("runs the step bare with no run-slot.sh, keeping its output and exit code", () => {
    const ok = run(["echo", "hi"])
    expect(ok.stdout.toString()).toBe("hi\n")
    expect(ok.exitCode).toBe(0)
    expect(run(["sh", "-c", "exit 3"]).exitCode).toBe(3)
  })
})

// PG-672: a canary merge that brings a new workspace package left its dependency unlinked, and the build waited for a slot before it failed with exit 127, naming nothing
describe("commit-slot.ts on a worktree whose install predates a workspace dependency", () => {
  const home = join(DIR, "home-unlinked")
  const ops = join(home, ".playground/ops")
  const worktree = join(DIR, "repo/.claude/worktrees/wt-unlinked")
  const slot = join(DIR, "seen-unlinked-slot")
  mkdirSync(ops, { recursive: true })
  mkdirSync(join(worktree, "packages/fresh"), { recursive: true })
  writeFileSync(join(worktree, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
  writeFileSync(
    join(worktree, "packages/fresh/package.json"),
    JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }),
  )
  writeFileSync(join(ops, "run-slot.sh"), `#!/bin/sh\necho "$@" > '${slot}'\nshift 2\nexec "$@"\n`)
  chmodSync(join(ops, "run-slot.sh"), 0o755)
  const run = () =>
    Bun.spawnSync(["bun", "--no-env-file", SCRIPT, "echo", "built"], {
      cwd: worktree,
      env: scratchEnv(home),
      stderr: "pipe",
      stdout: "pipe",
    })

  test("fails before it asks for a slot, naming the package and bun install", () => {
    rmSync(slot, { force: true })
    const result = run()
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(slot)).toBe(false)
    expect(result.stdout.toString()).toBe("")
    const said = result.stderr.toString()
    expect(said).toContain("packages/fresh: left-pad")
    expect(said).toContain("bun install")
  })

  test("with every dependency linked, takes the slot and runs the step as before", () => {
    mkdirSync(join(worktree, "node_modules/left-pad"), { recursive: true })
    writeFileSync(join(worktree, "node_modules/left-pad/package.json"), "{}")
    rmSync(slot, { force: true })
    const result = run()
    expect(readFileSync(slot, "utf8")).toBe("commit-wt-unlinked -- echo built\n")
    expect(result.stdout.toString()).toBe("built\n")
    expect(result.exitCode).toBe(0)
  })
})
