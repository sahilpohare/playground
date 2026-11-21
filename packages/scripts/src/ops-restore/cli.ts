import { existsSync } from "node:fs"
import { appendFile, cp, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { quarantine, type Roots } from "@packages/safe-delete"

import { opsDir, REPO, run, scheduled, sendAs } from "../ops-job/job"
import { preToolUseGuards } from "../ops-tick/guard-probe"
import type { Beat, Context } from "../ops-tick/tick"
import { machineRoots } from "../trash"
import { writeAtomic } from "../write-atomic"

// ops-restore: puts a lost main checkout back by the playbook's restore steps (LIFECYCLE.md, Restoring the main checkout), from the Dashboard's checkout, which a loss of the main checkout's tracked files leaves standing, and with no hook, since every guard runs from the main checkout and fails closed once it is gone; with every guard there, it puts back a tracked file modified in place, which no session may restore.

// Two looks this far apart, each finding a guard gone, before it acts: a pull or an install can leave a bundle missing for a moment.
export const SECOND_LOOK_MS = 290_000

// A look this long after the one before it starts the count again, since the job was off or the Mac asleep between them: two beats of the 5-minute cron.
export const IN_A_ROW_MS = 600_000

// A run that holds the main checkout for its upkeep (the ship's step 5, `playground update`, run in a run slot, the links it runs, and any install, since a holder's command names no folder), read from each run slot's holder pid.
const UPKEEP = /playground update|playground\/update\.ts|link-skills\.sh|bun install/

type State = { failed?: string; last: string; since: string }

// Each modified file's first look in the current run of looks in a row.
type Modified = { last: string; since: Record<string, string> }

// The file a healthy look keeps origin's URL in, since a lost .git takes the URL with it, and the Dashboard's checkout, a worktree of the main checkout, reads its git through that .git too.
export const originPath = (ops: string): string => join(ops, "restore", "origin.txt")

const keptOrigin = async (ops: string): Promise<string> =>
  (
    await Bun.file(originPath(ops))
      .text()
      .catch(() => "")
  ).trim()

// The registered guards whose bundle and source are both gone from the main checkout.
export const missingGuards = (main: string, guards: string[]): string[] =>
  guards.filter(
    (name) =>
      !existsSync(join(main, "scripts", "hooks", "bundled", `${name}.js`)) &&
      !existsSync(join(main, "scripts", "hooks", `${name}.ts`)),
  )

// Whether a run slot's holder runs the main checkout's upkeep: each `<slot>.holder` names its holder's pid second, and ps reads that pid's command.
export const upkeepHeld = async (ctx: Context): Promise<boolean> => {
  const holders = [...new Bun.Glob("run-slot*.holder").scanSync({ cwd: ctx.ops, dot: true })]
  for (const holder of holders) {
    const pid = (
      await Bun.file(join(ctx.ops, holder))
        .text()
        .catch(() => "")
    ).split(/\s+/)[1]
    if (!pid || !/^\d+$/.test(pid)) continue
    const { out } = await ctx.run(["ps", "-o", "command=", "-p", pid], 10_000)
    if (UPKEEP.test(out)) return true
  }
  return false
}

// with its .git gone or broken, git walks up to a parent repository the checkout sits in, so every git call stops at the checkout's own folder
const gitIn = (main: string, ...args: string[]) => [
  "env",
  `GIT_CEILING_DIRECTORIES=${dirname(main)}`,
  "git",
  "-C",
  main,
  ...args,
]

// The tracked files git status reads as modified in the work tree, the index or both; an untracked file, an add, a delete and a rename stay as they are. Read outside ctx.run, as missingGuards reads the disk, since every healthy look reads it, and with no optional lock, so the read never holds index.lock against an upkeep's git.
const modifiedFiles = async (main: string): Promise<string[]> => {
  const status = await run(
    gitIn(main, "--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=no"),
    30_000,
  )
  if (status.code !== 0) return []
  const entries = status.out.split("\0")
  const files: string[] = []
  for (let i = 0; i < entries.length; i++) {
    // a rename or a copy names its source in the entry after it
    if (/^[RC]/.test(entries[i]!)) i++
    else if (/^(M[ M]| M) /.test(entries[i]!)) files.push(entries[i]!.slice(3))
  }
  return files
}

// A tracked file modified on two looks in a row, with no upkeep holding the main checkout, goes back to HEAD's copy: the stray copies are copied into ops-restore's own scratch folder, which safe-delete moves to the trash in one move, the undo, and one line to the ops log names each file and its copy's trash path.
const putBack = async (
  ctx: Context,
  main: string,
  roots: () => Roots,
  upkeep: (ctx: Context) => Promise<boolean>,
) => {
  const dir = join(ctx.ops, "restore")
  const path = join(dir, "modified.json")
  const files = await modifiedFiles(main)
  const prior = (await Bun.file(path)
    .json()
    .catch(() => null)) as Modified | null
  if (!files.length) {
    if (prior) await Bun.file(path).delete()
    return
  }
  const now = ctx.now.toISOString()
  const fresh = !prior || ctx.now.getTime() - Date.parse(prior.last) > IN_A_ROW_MS
  const since = Object.fromEntries(
    files.map((file) => [file, (!fresh && prior.since[file]) || now]),
  )
  await mkdir(dir, { recursive: true })
  await writeAtomic(path, JSON.stringify({ last: now, since } satisfies Modified))
  const due = files.filter((file) => ctx.now.getTime() - Date.parse(since[file]!) >= SECOND_LOOK_MS)
  if (!due.length || (await upkeep(ctx))) return
  const at = roots()
  const copies = join(
    at.home,
    ".playground",
    "scratch",
    "ops-restore",
    now.replace(/[-:]|\.\d{3}/g, ""),
  )
  for (const file of due) await cp(join(main, file), join(copies, file), { verbatimSymlinks: true })
  const moved = quarantine(
    copies,
    {
      reason: `ops-restore: the stray copies of tracked files modified in ${main}, each put back from HEAD`,
      session: "ops-restore",
    },
    at,
    { now: ctx.now },
  )
  const lines: string[] = []
  if ("refused" in moved)
    lines.push(
      `${now} kept ${due.join(", ")} as modified, since the trash refused its stray copies: ${moved.refused}`,
    )
  else
    for (const file of due) {
      const back = await ctx.run(gitIn(main, "checkout", "HEAD", "--", file), 30_000)
      const copy = `its stray copy is in the trash at ${join(moved.to, file)} (playground rm --restore ${moved.id})`
      const why = back.out.trim().split("\n").at(-1) ?? ""
      lines.push(
        back.code === 0
          ? `${now} restored ${file} from HEAD; ${copy}`
          : `${now} could not restore ${file} from HEAD (${why}); ${copy}`,
      )
    }
  await mkdir(join(ctx.ops, "log"), { recursive: true })
  await appendFile(join(ctx.ops, "log", "ops-restore.log"), `${lines.join("\n")}\n`)
}

export type Restore = {
  guards: string[] | (() => Promise<string[]>)
  main: string
  roots?: () => Roots
  upkeep?: (ctx: Context) => Promise<boolean>
}

type Stopped = { statusFile: string; step: string; why: string }

// Steps 1 to 3 of LIFECYCLE.md's restore: the files put back (from HEAD while .git is in place, else in place from origin's main), the install and link-skills.sh, then the guards read again; what the checkout held before it, or the step it stopped at with that step's last line. The beat and the Dashboard's Restore now (--now) both run it.
export const restoreSteps = async (
  ctx: Context,
  main: string,
  registered: string[],
): Promise<{ held: string } | Stopped> => {
  const dir = join(ctx.ops, "restore")
  await mkdir(dir, { recursive: true })
  const now = ctx.now.toISOString()
  let statusFile = ""
  const stop = (step: string, out: string): Stopped => ({
    statusFile,
    step,
    why: out.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 160) ?? "",
  })
  const git = (...args: string[]) => ctx.run(gitIn(main, ...args), 300_000)
  // what the checkout held before a checkout throws it away, kept whole in a file and named in the report, since the main checkout stays clean and anything but the loss is news
  const keep = async (lines: string[]) => {
    const other = lines.filter((line) => line[0] !== "D" && line[1] !== "D")
    statusFile = join(dir, `status-${now}.txt`)
    await writeAtomic(statusFile, `${lines.join("\n")}\n`)
    return `${lines.length - other.length} files deleted and ${other.length ? `also held ${other.slice(0, 5).join("; ")}${other.length > 5 ? ` and ${other.length - 5} more` : ""}` : "nothing else"} (git status in ${statusFile})`
  }
  // the checkout's git status lines, or a stop when git status fails
  const status = async (): Promise<string[] | Stopped> => {
    const read = await git("status", "--porcelain")
    return read.code === 0 ? read.out.split("\n").filter(Boolean) : stop("git status", read.out)
  }
  let held = ""
  if (existsSync(join(main, ".git"))) {
    const lines = await status()
    if (!Array.isArray(lines)) return lines
    held = `had ${await keep(lines)}`
    // from HEAD, since a loss already staged (a `git rm`, or a `git add -A` after a wipe) is gone from the index too
    const back = await git("checkout", "HEAD", "--", ".")
    if (back.code !== 0) return stop("git checkout HEAD -- .", back.out)
  } else {
    const url = await keptOrigin(ctx.ops)
    if (!url) return stop("reading origin's URL", `none kept in ${originPath(ctx.ops)}`)
    for (const args of [
      ["init"],
      ["remote", "add", "origin", url],
      ["fetch", "origin"],
      ["read-tree", "origin/main"],
    ]) {
      const step = await git(...args)
      if (step.code !== 0) return stop(`git ${args.join(" ")}`, step.out)
    }
    // read against origin/main's tree, a file the same as origin's reads `A  `, so only a change, a loss or a stray file is kept
    const lines = await status()
    if (!Array.isArray(lines)) return lines
    held = `had no .git and was restored in place; against origin/main it had ${await keep(lines.filter((line) => !line.startsWith("A  ")))}; every worktree of the lost .git, the Dashboard's included, has lost its link to it, which a fresh .git cannot repair, so Ops reattaches each`
    const back = await git("checkout", "-f", "-B", "main", "origin/main")
    if (back.code !== 0) return stop("git checkout -f -B main origin/main", back.out)
  }
  const runSlot = join(ctx.repo, "scripts", "ops", "run-slot.sh")
  const install = await ctx.run(
    ["bash", runSlot, "ops-restore", "--", "bun", "install", "--cwd", main],
    1_800_000,
  )
  if (install.code !== 0) return stop("bun install", install.out)
  const link = await ctx.run(["bash", join(main, "scripts", "link-skills.sh")], 600_000)
  if (link.code !== 0) return stop("link-skills.sh", link.out)
  const left = missingGuards(main, registered)
  if (left.length) return stop("the check after it", `still gone: ${left.join(", ")}`)
  return { held }
}

const goneOf = (missing: string[], main: string) =>
  `${missing.length} ${missing.length === 1 ? "guard was" : "guards were"} gone from ${main}`

// A stopped restore in words: the step, its last line, the status file, and what comes next, which depends on whether the guards are back.
const stoppedText = (gone: string, done: Stopped, back: boolean, next: [string, string]) =>
  `${gone}, and its restore stopped at ${done.step}${done.why ? `: ${done.why}` : ""}.${done.statusFile ? ` Its git status before it began is in ${done.statusFile}.` : ""} ${back ? next[1] : next[0]}`

const tell = async (ctx: Context, text: string) => {
  for (const to of ["ops", "dispatcher"])
    await ctx.send(to, `ops-restore: ${text}`).catch(() => false)
}

// One look: with every guard there, it puts back each tracked file modified on two looks in a row (putBack); a guard gone on two looks in a row, with no upkeep holding the main checkout, runs the restore once, records what the checkout held before it, and tells ops and the dispatcher what it did; a failed step is told once and runs no step again until the guards have come back.
export const restoreBeat =
  ({ guards, main, roots = machineRoots, upkeep = upkeepHeld }: Restore) =>
  async (ctx: Context) => {
    const dir = join(ctx.ops, "restore")
    const statePath = join(dir, "state.json")
    const registered = typeof guards === "function" ? await guards() : guards
    const missing = missingGuards(main, registered)
    const state = (await Bun.file(statePath)
      .json()
      .catch(() => null)) as State | null
    const now = ctx.now.toISOString()
    if (!missing.length) {
      if (state) await Bun.file(statePath).delete()
      const url = await ctx.run(gitIn(main, "remote", "get-url", "origin"), 30_000)
      if (url.code === 0 && url.out.trim() && (await keptOrigin(ctx.ops)) !== url.out.trim()) {
        await mkdir(dir, { recursive: true })
        await writeAtomic(originPath(ctx.ops), `${url.out.trim()}\n`)
      }
      return putBack(ctx, main, roots, upkeep)
    }
    await mkdir(dir, { recursive: true })
    const fresh = !state || ctx.now.getTime() - Date.parse(state.last) > IN_A_ROW_MS
    if (fresh) {
      const failed = state?.failed ? { failed: state.failed } : {}
      await writeAtomic(statePath, JSON.stringify({ ...failed, last: now, since: now }))
      return
    }
    await writeAtomic(statePath, JSON.stringify({ ...state, last: now }))
    if (state.failed) return
    const apart = ctx.now.getTime() - Date.parse(state.since)
    if (apart < SECOND_LOOK_MS) return
    if (await upkeep(ctx)) return
    const gone = goneOf(missing, main)
    const done = await restoreSteps(ctx, main, registered)
    if ("step" in done) {
      await writeAtomic(statePath, JSON.stringify({ ...state, failed: done.step, last: now }))
      return tell(
        ctx,
        stoppedText(gone, done, !missingGuards(main, registered).length, [
          "The guards are still gone, a true block: it runs no step again until they are back, and LIFECYCLE.md's true-block route restores the rest.",
          "The guards are back, so it runs nothing more: Ops finishes the rest by LIFECYCLE.md's steps.",
        ]),
      )
    }
    await Bun.file(statePath).delete()
    await tell(
      ctx,
      `${gone} on looks ${Math.round(apart / 60_000)} minutes from the first to the last; it restored the checkout by LIFECYCLE.md's steps, installed and ran link-skills.sh, and every guard's script is back. The checkout ${done.held}.`,
    )
  }

export type Pressed = { code: 0 | 1 | 3; text: string }

// The Dashboard's Restore now: one look, then the restore's steps at once, since the owner's press stands in for the beat's second look and for a turned-off job. A checkout whose guards are all there is left as it is (exit 3), as is one an upkeep run holds; otherwise it tells ops and the dispatcher what it did, as the beat does, and the words go back to the page, exit 0 restored, 1 stopped.
export const restoreNow = async (
  ctx: Context,
  { guards, main, upkeep = upkeepHeld }: Restore,
): Promise<Pressed> => {
  if (!existsSync(main))
    return { code: 1, text: `No checkout is at ${main}, so nothing was restored.` }
  const registered = typeof guards === "function" ? await guards() : guards
  const missing = missingGuards(main, registered)
  if (!missing.length)
    return { code: 3, text: `Every guard is in place in ${main}, so nothing was restored.` }
  if (await upkeep(ctx))
    return {
      code: 1,
      text: `An install, link-skills.sh or playground update holds ${main} now, so nothing was restored: press Restore now again once it ends.`,
    }
  const gone = goneOf(missing, main)
  const done = await restoreSteps(ctx, main, registered)
  const text =
    "step" in done
      ? stoppedText(gone, done, !missingGuards(main, registered).length, [
          "The guards are still gone: fix what the step names, then press Restore now again.",
          "The guards are back: Ops finishes the rest by LIFECYCLE.md's steps.",
        ])
      : `${gone}; Restore now on the Dashboard restored the checkout by LIFECYCLE.md's steps, installed and ran link-skills.sh, and every guard's script is back. The checkout ${done.held}.`
  await tell(ctx, text)
  return { code: "step" in done ? 1 : 0, text }
}

// The main checkout the job restores, named by --main, since the job runs from the Dashboard's checkout.
const mainOf = (argv: string[]): string => {
  const at = argv.indexOf("--main")
  const main = at === -1 ? undefined : argv[at + 1]
  if (!main) {
    console.error("ops-restore: --main <main checkout> names the checkout it restores")
    process.exit(2)
  }
  return main
}

// The guards read at each beat, from the settings the main checkout's own wrappers run while it holds them, else the Dashboard's, so a registration change needs no restart.
const guardsOf = (main: string) => async () =>
  preToolUseGuards(existsSync(join(main, "scripts", "factory-settings.json")) ? main : REPO)

if (import.meta.main) {
  const main = mainOf(process.argv)
  // --now: the Dashboard's Restore now, one run of restoreNow, its words on stdout's last line
  if (process.argv.includes("--now")) {
    const ctx = { now: new Date(), ops: opsDir(), repo: REPO, run, send: sendAs("ops-restore") }
    const pressed = await restoreNow(ctx, { guards: guardsOf(main), main })
    console.log(pressed.text)
    process.exit(pressed.code)
  }
  const beats: Beat[] = [
    {
      cron: "*/5 * * * *",
      name: "restore",
      run: restoreBeat({ guards: guardsOf(main), main }),
      to: "ops and the dispatcher, once a restore runs or stops",
    },
  ]
  scheduled("ops-restore", beats, opsDir())
}
