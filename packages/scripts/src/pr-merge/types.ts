// The types gate: a head behind canary that merges with it clean merges on its own checks, which typed the head alone, so pr:merge type-checks the tree the squash makes before it squashes, since two PRs green alone once broke canary together on a changed signature.
import { accessSync, constants, existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { dataDir } from "@packages/env/data-dir"
import type { Subprocess } from "bun"

import { STALE } from "../hooks-bundle"
import { BASE, type Gate } from "./gates"
import type { Run } from "./merge"
import { onStop } from "./stop"

// One step of the check, run in the kept worktree: its name for the timing line, its argv, whether a failure is the tree's own type error rather than the run's, whether it brings node_modules up to the tree's dependencies, and whether it checks the hook bundles, whose stale file is the tree's own fault too.
export type TypeStep = {
  argv: string[]
  bundles?: boolean
  deps?: boolean
  name: string
  types?: boolean
}

// What node_modules needs before the check: a clone and a forced install when the worktree has none, a plain install when the tree's dependencies changed since the last install or that install never finished, or nothing.
export type Prepare = "clone" | "install" | "none"

// The steps for one merged tree: the worktree it is checked out in, the checkout pr:merge runs from (whose node_modules it clones), canary's sha, which the turbo filter diffs against, whether the PR touches the hook bundles' inputs, and what node_modules needs.
export type TypeSteps = (at: {
  canary: string
  checkout: string
  hooks: boolean
  prepare: Prepare
  worktree: string
}) => TypeStep[]

// How long the whole check may take, slot waits included, so a run that cannot finish refuses inside the merge train's 900s call of pr:train ready, whose gates share it (ready.ts).
export const TYPES_BUDGET_MS = 10 * 60_000

const NAME = "types"

const runSlot = (): string => join(dataDir(), "ops", "run-slot.sh")

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Pure: argv through the machine's run slot (**slots**) as the merge train's own runs take it, since the gate holds the merge lock as theirs do (run-slot.sh puts ops-merge-train in class 0, outside the queue); bare under a run that already holds a slot (run-slot exports RUN_SLOT_NICE to its child) or on a machine with no run-slot, as commit-slot.ts does.
export const slotted = (
  argv: string[],
  env: Record<string, string | undefined>,
  script: string | null,
): string[] =>
  env.RUN_SLOT_NICE === undefined && script ? [script, "ops-merge-train", "--", ...argv] : argv

// `hooks-bundle.ts --check` on the merged tree, since a PR branched before another rebuilt a bundle passes its own checks while the squash writes that bundle beside the source this PR changed.
const BUNDLES: TypeStep = {
  argv: ["bun", "packages/scripts/src/hooks-bundle.ts", "--check"],
  bundles: true,
  name: "bundles",
}

// Pure: whether a PR's changed paths reach a hook bundle: scripts/hooks/, or packages/, whose files a hook imports.
const touchesHooks = (paths: string[]): boolean =>
  paths.some((path) => /^(scripts\/hooks|packages)\//.test(path))

// Pure: cp's flags for a copy-on-write clone of a folder, by scripts/README.md's "A worktree's node_modules": -c on macOS (APFS), --reflink=auto elsewhere, since GNU cp has no -c and reflink clones where the file system can and copies where it cannot.
export const cloneArgs = (platform: NodeJS.Platform = process.platform): string[] =>
  platform === "darwin" ? ["-cR"] : ["-R", "--reflink=auto"]

// CI's own type steps (.github/workflows/auto-check-build.yml), after what node_modules needs: a clone by scripts/README.md's "A worktree's node_modules" then its forced install, or a plain install into the kept node_modules, since a forced one rewrites every package; each through the run slot.
export const ciSteps: TypeSteps = ({ canary, checkout, hooks, prepare, worktree }) => {
  const clone = {
    argv: ["cp", ...cloneArgs(), join(checkout, "node_modules"), `${worktree}/`],
    name: "clone",
  }
  const install = {
    argv: [
      "bun",
      "install",
      ...(prepare === "clone" ? ["--force"] : []),
      "--ignore-scripts",
      "--cwd",
      worktree,
    ],
    deps: true,
    name: "install",
  }
  const steps: TypeStep[] = [
    ...(prepare === "clone" ? [clone] : []),
    ...(prepare === "none" ? [] : [install]),
    ...(hooks ? [BUNDLES] : []),
    {
      argv: [
        "bunx",
        "turbo",
        "run",
        "check-types",
        `--filter=...[${canary}]`,
        "--filter=@packages/scripts",
      ],
      name: "check-types",
      types: true,
    },
    {
      argv: ["bunx", "turbo", "run", "build", "--filter=./packages/*", "--filter=@api/hono"],
      name: "build",
      types: true,
    },
    { argv: ["bun", "packages/scripts/src/data-table-metrics.ts"], name: "metrics" },
    { argv: ["bun", "run", "check-types:tests"], name: "check-types:tests", types: true },
  ]
  const script = runSlot()
  const slot = executable(script) ? script : null
  return steps.map((step) => ({ ...step, argv: slotted(step.argv, process.env, slot) }))
}

// Pure: what a failed step printed, as a refusal shows it: its first TypeScript errors, else its last lines.
export function firstErrors(output: string, count = 5): string[] {
  const lines = output.split("\n").map((line) => line.trim())
  const errors = lines.filter((line) => /\berror TS\d+:/.test(line))
  return (errors.length > 0 ? errors : lines.filter(Boolean).slice(-count)).slice(0, count)
}

const gitOk = async (git: Run, args: string[]): Promise<string> => {
  const result = await git(args)
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

// Whether the head already holds canary's tip, so its own checks typed this very tree: true, false, or why it could not be read.
export async function holdsCanary(
  git: Run,
  canary: string,
  head: string,
): Promise<boolean | string> {
  const result = await git(["merge-base", "--is-ancestor", canary, head])
  if (result.code === 0 || result.code === 1) return result.code === 0
  return `git merge-base --is-ancestor exited ${result.code}: ${result.stderr.trim()}`
}

// The gate as --explain prints it: whether it would run at the merge, and why; it runs no type check.
export async function typesExplained(
  git: Run,
  facts: { canary: string; head: string; mergeTree: string | null },
): Promise<Gate> {
  const held = await holdsCanary(git, facts.canary, facts.head)
  if (typeof held === "string") return { detail: `could not read: ${held}`, name: NAME, ok: false }
  return {
    detail: held
      ? skipped(facts)
      : facts.mergeTree
        ? `runs at the merge: ${BASE} has commits ${facts.head.slice(0, 7)} lacks, so pr:merge type-checks the merged tree ${facts.mergeTree.slice(0, 7)}, and checks its hook bundles when the PR touches scripts/hooks/ or packages/ (--explain runs none)`
        : `runs at the merge once ${facts.head.slice(0, 7)} merges clean with ${BASE}`,
    name: NAME,
    ok: true,
  }
}

const skipped = (facts: { canary: string; head: string }) =>
  `skipped: ${facts.head.slice(0, 7)} holds ${BASE} ${facts.canary.slice(0, 7)}, so its own checks typed this tree`

const FIX = `Merge ${BASE} into the PR and fix the error; the new head then needs its checks, a 5/5 and each PASS its diff calls for`

const REBUILD = `Merge ${BASE} into the PR plainly, run \`bun run hooks:bundle\`, and commit the rebuild on its own; the new head then needs its checks, a 5/5 and each PASS its diff calls for`

// Removes the worktree and its folder, whatever state a run left them in, for a worktree that cannot be reused.
async function clear(git: Run, worktree: string): Promise<void> {
  await git(["worktree", "remove", "--force", "--force", worktree])
  await rm(worktree, { force: true, recursive: true })
  await git(["worktree", "prune"])
}

// The file in the kept node_modules naming the dependencies it was last installed for; it goes with node_modules, and a run removes it before an install, so an install that never finished leaves none.
const stampOf = (worktree: string) => join(worktree, "node_modules", ".merge-types-deps")

// What the tree's node_modules depends on: the blobs of bun.lock, bunfig.toml, every package.json and every file under patches/, so a change to any of them installs again.
async function depsOf(git: Run, commit: string): Promise<string> {
  const listed = await gitOk(git, ["ls-tree", "-r", commit])
  return listed
    .split("\n")
    .filter((line) => /\t(bun\.lock|bunfig\.toml|(.*\/)?package\.json|patches\/.*)$/.test(line))
    .join("\n")
}

// The kept worktree at commit, exactly: tracked files forced to the tree, and every untracked and ignored file removed but node_modules, so nothing from the last merge's check reads into this one; false when it cannot be reused.
async function reuse(git: Run, worktree: string, commit: string): Promise<boolean> {
  if (!existsSync(join(worktree, ".git"))) return false
  const inside = ["-C", worktree, "-c", "core.hooksPath=/dev/null"]
  if ((await git([...inside, "checkout", "--quiet", "--force", "--detach", commit])).code !== 0)
    return false
  return (await git([...inside, "clean", "-ffdxq", "-e", "node_modules"])).code === 0
}

// The types gate at the merge, inside the merge lock: skipped when the head holds canary's tip; else the merged tree, checked out detached in the one merge-types worktree under the repo's .claude/worktrees/ that every merge reuses, its node_modules kept and installed again only when the dependencies change, through steps, with the hook bundles checked when the PR touches scripts/hooks/ or packages/. A type error or a stale bundle refuses and is kept beside the lock (by head and canary), so the merge train's next cycle refuses the same pair without a second run; a run it cannot finish refuses, naming the fix.
export async function typesGate({
  budgetMs = TYPES_BUDGET_MS,
  facts,
  git,
  lockRoot,
  steps,
}: {
  budgetMs?: number
  facts: { canary: string; head: string; mergeTree: string | null; n: number }
  git: Run
  lockRoot: string
  steps: TypeSteps
}): Promise<Gate> {
  const { canary, head, mergeTree, n } = facts
  const held = await holdsCanary(git, canary, head)
  if (held === true) return { detail: skipped(facts), name: NAME, ok: true }
  const unfinished = (why: string): Gate => ({
    detail: `could not finish the merged-tree type check: ${why}. Run pr:merge again, and take a second failure to the Builder`,
    name: NAME,
    ok: false,
  })
  if (typeof held === "string") return unfinished(held)
  if (!mergeTree) return unfinished(`#${n} has no clean merged tree with ${BASE}`)
  const memo = join(lockRoot, "merge-types", `${head}-${canary}`)
  const kept = Bun.file(memo)
  if (await kept.exists()) return { detail: await kept.text(), name: NAME, ok: false }
  if (budgetMs <= 0)
    return unfinished("this call's shared budget ran out on the gates before it, so no check ran")
  const deadline = Date.now() + budgetMs
  const at = `the merged tree ${mergeTree.slice(0, 7)} (#${n} at ${head.slice(0, 7)} onto ${BASE} ${canary.slice(0, 7)})`
  let running: Subprocess | null = null
  // a signal ends the gate as its deadline does: the running step killed and waited for, and the worktree kept for the next merge
  const unlisten = onStop(async () => {
    running?.kill("SIGTERM")
    await running?.exited
  })
  try {
    const common = await gitOk(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    const checkout = await gitOk(git, ["rev-parse", "--show-toplevel"])
    const worktree = join(dirname(common), ".claude", "worktrees", "merge-types")
    const commit = await gitOk(git, [
      "-c",
      "user.email=pr-merge@localhost",
      "-c",
      "user.name=pr:merge",
      "commit-tree",
      mergeTree,
      "-p",
      canary,
      "-p",
      head,
      "-m",
      `pr:merge types #${n}`,
    ])
    if (!(await reuse(git, worktree, commit))) {
      await clear(git, worktree)
      await mkdir(dirname(worktree), { recursive: true })
      await gitOk(git, [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "--detach",
        worktree,
        commit,
      ])
    }
    const changed = await gitOk(git, ["diff", "--name-only", "--no-renames", `${canary}...${head}`])
    const hooks = touchesHooks(changed.split("\n"))
    const deps = await depsOf(git, commit)
    const stamp = Bun.file(stampOf(worktree))
    const prepare: Prepare = !existsSync(join(worktree, "node_modules"))
      ? "clone"
      : (await stamp.exists()) && (await stamp.text()) === deps
        ? "none"
        : "install"
    if (prepare !== "none") await rm(stampOf(worktree), { force: true })
    const times: string[] = []
    for (const step of steps({ canary, checkout, hooks, prepare, worktree })) {
      const left = deadline - Date.now()
      if (left <= 0)
        return unfinished(
          `it ran past its ${Math.round(budgetMs / 1000)}s before ${step.name}, waiting on the machine's run slots`,
        )
      const started = Date.now()
      const proc = (running = Bun.spawn(step.argv, {
        cwd: worktree,
        env: {
          ...process.env,
          NODE_ENV: "production",
          SKIP_ENV_VALIDATION: "true",
          TURBO_CACHE_DIR:
            process.env.TURBO_CACHE_DIR || join(homedir(), ".cache", "turbo", "playground"),
        },
        killSignal: "SIGTERM",
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
        timeout: left,
      }))
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const seconds = Math.round((Date.now() - started) / 1000)
      if (code === 0) {
        if (step.deps) await Bun.write(stampOf(worktree), deps)
        times.push(`${step.name} ${seconds}s`)
        continue
      }
      // read from the clock: run-slot traps the TERM and exits 143 itself, so its kill leaves no signalCode
      if (Date.now() >= deadline)
        return unfinished(
          `${step.name} ran past the check's ${Math.round(budgetMs / 1000)}s, slot waits included`,
        )
      const output = `${stdout}\n${stderr}`
      const errors = firstErrors(output)
      const typeError = step.types && errors.some((line) => /\berror TS\d+:/.test(line))
      const drift = step.bundles
        ? output.split("\n").find((line) => line.includes(STALE))
        : undefined
      const refusal = typeError
        ? `${errors.join(" | ")} ${FIX}`
        : drift && `${drift.trim().split("; ")[0]}. ${REBUILD}`
      if (refusal) {
        const detail = `${at} fails ${step.name}: ${refusal}`
        await mkdir(dirname(memo), { recursive: true })
        await Bun.write(memo, detail)
        return { detail, name: NAME, ok: false }
      }
      return unfinished(`${step.name} exited ${code}: ${errors.join(" | ")}`)
    }
    return { detail: `${at} type-checks: ${times.join(", ")}`, name: NAME, ok: true }
  } catch (err) {
    return unfinished(err instanceof Error ? err.message : String(err))
  } finally {
    unlisten()
  }
}
