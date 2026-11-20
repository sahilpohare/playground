// playground update: the release skill's step 5 as one script, then the Dashboard's roll.
import { basename, join } from "node:path"

import { swapBundles, unswapBundles } from "../swap-bundles"
import { giveBackSlot } from "./give-back"
import { BUNDLED_ROOT, CORE_SKILLS } from "./orgs"
import { unlinked } from "./unlinked"

// A step's argv run to its end; `show` streams its output to the terminal instead of keeping it.
export type Run = (argv: string[], show?: boolean) => Promise<{ code: number; out: string }>

export const spawnRun: Run = async (argv, show = false) => {
  const proc = Bun.spawn(argv, {
    stdio: ["inherit", show ? "inherit" : "pipe", show ? "inherit" : "pipe"],
  })
  const out = show ? "" : await new Response(proc.stdout as ReadableStream).text()
  return { code: await proc.exited, out }
}

const MANIFEST = /(^|\/)(bun\.lock|package\.json)$/
const PACKAGE = /(^|\/)package\.json$/
// core's skill roots and each bundled extension's, whose skills a session reads once ext.bundled turns it on
const SKILL_ROOTS = [...CORE_SKILLS, `${BUNDLED_ROOT}/[^/]+/skills`]

// What the merge changed asks for: an install for a lockfile or a package.json, a build for a package with a dist (packages/scripts runs from source).
export const updateSteps = (changed: string[]) => ({
  build: changed.some(
    (path) => path.startsWith("packages/") && !path.startsWith("packages/scripts/"),
  ),
  install: changed.some((path) => MANIFEST.test(path)),
  // each changed skill's folder, A to Z by name, which a live session reads the new text from (the release rule)
  skills: [
    ...new Set(
      changed.flatMap((path) =>
        SKILL_ROOTS.flatMap((root) => path.match(new RegExp(`^${root}/[^/]+(?=/)`))?.[0] ?? []),
      ),
    ),
  ].sort((a, b) => basename(a).localeCompare(basename(b))),
})

// With a tag, the checkout's main is moved to that release instead, back or on, and the Dashboard, which rolls on its own branch, is left as it is; a plain update later moves it on to origin/main again.
// `peers` then moves each peer's clone to the commit this one reached (peer-sync.ts); a failure there is logged, never the update's.
// `done` holds the commit the last finished update reached, or, for a run with no record, the reflog's last fast-forward onto origin/main, else where that run started, so a run after one cut short past its fast-forward still installs, builds and restarts what that merge changed.
export const runUpdate = async (
  repo: string,
  run: Run,
  roll: () => Promise<number>,
  log: (line: string) => void = console.log,
  to?: string,
  done?: string,
  briefs?: (old: string) => Promise<void>,
  peers?: (sha: string) => Promise<void>,
): Promise<number> => {
  const git = (...args: string[]) => run(["git", "-C", repo, ...args])
  // a step whose output the terminal shows, named before it runs and again when it fails
  const shown = async ([name, argv]: [string, string[]]): Promise<boolean> => {
    log(`playground update: ${name}`)
    if ((await run(argv, true)).code === 0) return true
    log(`playground update: ${name} failed; fix it and run playground update again`)
    return false
  }
  const head = (await git("rev-parse", "HEAD")).out.trim()
  const recorded =
    done && (await Bun.file(done).exists()) ? (await Bun.file(done).text()).trim() : ""
  // with no record, the reflog's last fast-forward merge onto origin/main is where the checkout's last update, or a hand merge, left it, so a reset made since outside update still reads as changed
  const merged =
    done && !recorded
      ? ((await git("reflog", "--format=%H %gs", "HEAD")).out
          .split("\n")
          .find((line) => line.endsWith(" merge origin/main: Fast-forward"))
          ?.split(" ")[0] ?? "")
      : ""
  if (done && !recorded)
    log(
      merged
        ? `playground update: no ${done} yet, so it reads what changed since the reflog's last fast-forward onto origin/main, ${merged.slice(0, 7)}`
        : `playground update: no ${done} yet and no fast-forward onto origin/main in the reflog, so it reads what changed since HEAD, ${head.slice(0, 7)}`,
    )
  const old =
    recorded && (await git("cat-file", "-e", `${recorded}^{commit}`)).code === 0
      ? recorded
      : merged || head
  if (done && old !== recorded) await Bun.write(done, `${old}\n`)
  const ok = { code: 0, out: "" }
  // a checkout left on another branch, such as one cloned while canary was the default, moves to main at origin/main when its tree is clean, and one on main fast-forwards; cleanTree reads the branch that prelink and move then go by
  let branch = ""
  const cleanTree = async () => {
    branch = (await git("branch", "--show-current")).out.trim()
    return branch === "main" ? ok : git("diff", "--quiet", "HEAD")
  }
  const move = async () => {
    if (branch === "main") return git("merge", "--ff-only", "-q", "origin/main")
    log(
      `playground update: on ${branch || "a detached HEAD"}, not main, so moving to main at origin/main`,
    )
    return git("checkout", "-q", "-B", "main", "origin/main")
  }
  const installArgv = [
    process.execPath,
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--cwd",
    repo,
  ]
  const target = to ? `refs/tags/${to}` : "origin/main"
  // every hook that runs its source (all but the bundled PreToolUse guards) and every ops job run this checkout's code the moment it moves, so a target that declares a dependency the checkout has not linked gets its changed manifests and that install first, while the code is still the old commit's (the install step after the move then finds it linked); a target that deletes or moves a manifest, which the old code may still read, a tree with edits or untracked files of its own, or an install that fails there moves first as before
  // a fast-forward stops on a checkout with commits of its own, so files are staged only where it will move, and a tree with edits or untracked files of its own moves as before; a checkout -B moves over them either way; read once, for prelink and swap
  let staging: Promise<boolean> | undefined
  const stages = () =>
    (staging ??= (async () => {
      const merges = !to && branch === "main"
      if (merges && (await git("merge-base", "--is-ancestor", "HEAD", target)).code !== 0)
        return false
      return !(await git("status", "--porcelain", "--untracked-files=all")).out.trim()
    })())
  const prelink = async (): ReturnType<Run> => {
    if (!(await stages())) return ok
    const lines = async (...args: string[]) => (await git(...args)).out.split("\n").filter(Boolean)
    const manifests: Record<string, string> = {}
    for (const path of await lines("ls-tree", "-r", "--name-only", target)) {
      if (!PACKAGE.test(path)) continue
      const manifest = await git("show", `${target}:${path}`)
      if (manifest.code !== 0) return manifest
      manifests[path] = manifest.out
    }
    const missing = await unlinked(repo, manifests)
    if (!missing.length) return ok
    // --no-renames, so a package the target moves reads as a deleted manifest and a new one, never as one new path staged beside the old
    const changes = (await lines("diff", "--name-status", "--no-renames", "HEAD", target))
      .map((line) => line.split("\t"))
      .filter(([, path]) => MANIFEST.test(path ?? ""))
    if (changes.some(([status]) => status === "D")) return ok
    const manifestsChanged = changes.map(([, path]) => path ?? "")
    log(
      `playground update: install the new commit's dependencies before its code, since it declares ${missing.join(", ")}, which this checkout has not linked`,
    )
    if (manifestsChanged.length) {
      const staged = await git("checkout", target, "--", ...manifestsChanged)
      if (staged.code !== 0) return staged
    }
    if ((await run(installArgv, true)).code === 0) return ok
    // an install that needs a file only the manifests were staged without (a patch, bunfig.toml) fails here, so it puts the old commit's manifests back, a manifest the old commit lacks removed, and moves first as before
    log(
      "playground update: the install before the move failed, so the checkout's files go back as they were and it moves first, installing after, as before",
    )
    if (!manifestsChanged.length) return ok
    return git(
      "restore",
      "-q",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...manifestsChanged,
    )
  }
  // the guards load their bundles from this checkout, so the move finds each changed one swapped in whole first (swap-bundles.ts), where stages() allows; a swap that fails puts back what it wrote, and a move that fails puts the swap back
  let swapped: string[] = []
  let unswapped = ""
  const swap = async (): ReturnType<Run> => {
    if (!(await stages())) return ok
    const result = await swapBundles(repo, git, target)
    swapped = result.swapped
    if (result.putBack?.code) unswapped = result.putBack.out
    return result
  }
  const swappedMove = (step: () => ReturnType<Run>) => async (): ReturnType<Run> => {
    const moved = await step()
    if (moved.code === 0 || !swapped.length) return moved
    const putBack = await unswapBundles(repo, git, swapped)
    if (putBack.code) unswapped = putBack.out
    return moved
  }
  const prelinked =
    "the checkout's files are as they were; fix the failure above and run playground update again"
  const steps: [string, () => ReturnType<Run>, string?][] = to
    ? [
        ["fetch origin main and its tags", () => git("fetch", "-q", "--tags", "origin", "main")],
        [
          "a checkout with no commits of its own",
          () => git("merge-base", "--is-ancestor", "HEAD", "origin/main"),
        ],
        ["link the new commit's dependencies", prelink, prelinked],
        ["swap in the new commit's hook bundles", swap, prelinked],
        [
          `check out ${to}`,
          swappedMove(() => git("checkout", "-q", "-B", "main", `refs/tags/${to}`)),
        ],
      ]
    : [
        ["fetch origin main", () => git("fetch", "-q", "origin", "main")],
        ["a tree with no uncommitted changes, off main", cleanTree],
        ["link the new commit's dependencies", prelink, prelinked],
        ["swap in the new commit's hook bundles", swap, prelinked],
        ["merge --ff-only origin/main, or move to main there", swappedMove(move)],
      ]
  for (const [name, step, state = "the checkout is as it was"] of steps)
    if ((await step()).code !== 0) {
      log(
        `playground update: ${name} failed; ${unswapped ? `HEAD's hook bundles could not be put back (${unswapped}), so git status names what is left` : state}`,
      )
      return 1
    }
  // link-skills.sh first, as the release skill's step 5 runs it: every later step and every ops job reads the data folder it links
  const linkSkills: [string, string[]] = [
    "link-skills",
    ["bash", join(repo, "scripts", "link-skills.sh")],
  ]
  if (!(await shown(linkSkills))) return 1
  // each manager's brief copy follows its template while unedited (brief-refresh.ts); a failure there is logged, never a reason to stop the update
  await briefs?.(old).catch((error: Error) =>
    log(`playground update: brief refresh failed: ${error.message}`),
  )
  const changed = (await git("diff", "--name-only", old, "HEAD")).out.split("\n").filter(Boolean)
  const { build, install, skills } = updateSteps(changed)
  if (skills.length)
    log(
      `playground update: skills changed: ${skills.map((folder) => basename(folder)).join(", ")}; a running session's Skill tool serves the copy it started with, so a live session reads each one's files here: ${skills.map((folder) => `${join(repo, folder)}/`).join(", ")}; send each lead these folders, for the lead to have each of its live checkers read the new text there (release)`,
    )
  const turbo = join(repo, "node_modules", ".bin", "turbo")
  const restart = join(repo, "packages", "scripts", "src", "ops-restart", "cli.ts")
  const after: [string, string[]][] = []
  if (install) after.push(["install", installArgv])
  if (build)
    after.push([
      "build",
      [
        "env",
        "NODE_ENV=production",
        "SKIP_ENV_VALIDATION=true",
        turbo,
        "run",
        "build",
        "--filter=./packages/*",
        "--cwd",
        repo,
      ],
    ])
  after.push(["ops-restart", [process.execPath, "--no-env-file", restart, repo, old, "HEAD"]])
  for (const step of after) if (!(await shown(step))) return 1
  if (done) await Bun.write(done, (await git("rev-parse", "HEAD")).out)
  if (peers) {
    const at = (await git("rev-parse", "HEAD")).out.trim()
    await peers(at).catch((error: Error) =>
      log(`playground update: peer sync failed: ${error.message}`),
    )
  }
  if (!to) {
    // the roll only waits on the supervisor, whose own steps queue in run-slot, so the lane this update holds goes back to the queue first
    if (giveBackSlot())
      log(
        "playground update: gave its run slot back for the Dashboard roll, whose own steps queue in run-slot",
      )
    return roll()
  }
  log(
    `playground update: at ${to}; the Dashboard rolls on its own, and playground update moves on to origin/main`,
  )
  return 0
}
