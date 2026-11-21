import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { run as realRun } from "../../../../../packages/scripts/src/ops-job/job"
import {
  missingGuards,
  originPath,
  restoreBeat,
  type Restore,
  SECOND_LOOK_MS,
  upkeepHeld,
} from "../../../../../packages/scripts/src/ops-restore/cli"
import type { Context } from "../../../../../packages/scripts/src/ops-tick/tick"

const GUARDS = ["no-stash", "no-env-dump"]
const T0 = new Date(Date.UTC(2026, 10, 7, 6, 0))
const later = (ms: number) => new Date(T0.getTime() + ms)

const git = async (cwd: string, ...args: string[]) => {
  const { code, out } = await realRun(["git", "-C", cwd, ...args])
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${out}`)
  return out
}

// A main checkout and the origin it was cloned from, each guard's bundle and a README committed on main, the Dashboard's checkout as a worktree of the main checkout (as this Mac's is), and an ops folder: git runs for real, while the install, link-skills.sh and ps answer as `answers` says, each recorded.
const machine = async (answers: Record<string, { code: number; out?: string }> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "ops-restore-"))
  const origin = join(root, "origin")
  mkdirSync(join(origin, "scripts", "hooks", "bundled"), { recursive: true })
  for (const name of GUARDS)
    writeFileSync(join(origin, "scripts", "hooks", "bundled", `${name}.js`), "")
  writeFileSync(join(origin, "README.md"), "origin\n")
  await git(root, "init", "-q", "-b", "main", origin)
  await git(origin, "add", "-A")
  await git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "guards")
  const main = join(root, "main")
  await git(root, "clone", "-q", origin, main)
  const self = join(root, "self")
  await git(main, "worktree", "add", "-q", "-b", "desk", self)
  const ops = join(root, "ops")
  mkdirSync(ops)
  const runs: string[] = []
  const sent: { text: string; to: string }[] = []
  const ctx = (now: Date): Context => ({
    now,
    ops,
    repo: self,
    run: async (argv, timeout, stdin) => {
      runs.push(argv.join(" "))
      const key = Object.keys(answers).find((k) => argv.join(" ").includes(k))
      if (key) return { code: answers[key]!.code, out: answers[key]!.out ?? "" }
      if (argv[0] === "git" || argv[0] === "env") return realRun(argv, timeout, stdin)
      return { code: 0, out: "" }
    },
    send: async (to, text) => {
      sent.push({ text, to })
      return true
    },
  })
  const wipe = () => rmSync(join(main, "scripts"), { force: true, recursive: true })
  return { ctx, main, ops, root, runs, sent, wipe }
}

const noUpkeep = async () => false
const DAY = 24 * 60 * 60_000
const seed = async (ops: string, state: Record<string, unknown>) => {
  mkdirSync(join(ops, "restore"), { recursive: true })
  await Bun.write(join(ops, "restore", "state.json"), JSON.stringify(state))
}

describe("ops-restore puts a lost main checkout back (#1354)", () => {
  test("a checkout with every guard keeps origin's URL and does nothing else", async () => {
    const m = await machine()
    await restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })(m.ctx(T0))
    expect(m.runs).toEqual([
      `env GIT_CEILING_DIRECTORIES=${m.root} git -C ${m.main} remote get-url origin`,
    ])
    expect((await Bun.file(originPath(m.ops)).text()).trim()).toBe(join(m.root, "origin"))
    expect(existsSync(join(m.ops, "restore", "state.json"))).toBe(false)
  })

  test("with its .git gone but the guards present, it keeps the URL it had, never a parent repository's", async () => {
    const m = await machine()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await git(m.root, "init", "-q")
    await git(m.root, "remote", "add", "origin", "https://example.invalid/dotfiles.git")
    rmSync(join(m.main, ".git"), { force: true, recursive: true })
    expect((await git(m.main, "remote", "get-url", "origin")).trim()).toBe(
      "https://example.invalid/dotfiles.git",
    )
    await beat(m.ctx(later(300_000)))
    expect((await Bun.file(originPath(m.ops)).text()).trim()).toBe(join(m.root, "origin"))
  })

  test("with its .git broken but the guards present, it keeps the URL it had, never a parent repository's", async () => {
    const m = await machine()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await git(m.root, "init", "-q")
    await git(m.root, "remote", "add", "origin", "https://example.invalid/dotfiles.git")
    rmSync(join(m.main, ".git", "HEAD"))
    expect((await git(m.main, "remote", "get-url", "origin")).trim()).toBe(
      "https://example.invalid/dotfiles.git",
    )
    await beat(m.ctx(later(300_000)))
    expect((await Bun.file(originPath(m.ops)).text()).trim()).toBe(join(m.root, "origin"))
  })

  test("one guard gone reads in the singular", async () => {
    const m = await machine({ "bun install": { code: 1, out: "error: x\n" } })
    rmSync(join(m.main, "scripts", "hooks", "bundled", "no-stash.js"))
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.sent[0]!.text).toContain("1 guard was gone from")
  })

  test("a guard gone on one look only is recorded, and nothing runs", async () => {
    const m = await machine()
    m.wipe()
    expect(missingGuards(m.main, GUARDS)).toEqual(GUARDS)
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(SECOND_LOOK_MS - 10_000)))
    expect(m.runs).toEqual([])
    expect(m.sent).toEqual([])
  })

  test("gone on two looks 5 minutes apart, it restores, names what the checkout held, installs and links", async () => {
    const m = await machine()
    m.wipe()
    writeFileSync(join(m.main, "stray.txt"), "")
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(missingGuards(m.main, GUARDS)).toEqual([])
    expect(m.runs.some((r) => r.endsWith("checkout HEAD -- ."))).toBe(true)
    expect(m.runs.some((r) => r.includes("run-slot.sh ops-restore -- bun install --cwd"))).toBe(
      true,
    )
    expect(m.runs.some((r) => r.endsWith("scripts/link-skills.sh"))).toBe(true)
    expect(m.sent.map((s) => s.to)).toEqual(["ops", "dispatcher"])
    expect(m.sent[0]!.text).toContain("had 2 files deleted and also held ?? stray.txt")
    expect(m.sent[0]!.text).toContain("2 guards were gone from")
    expect(m.sent[0]!.text).toContain("on looks 5 minutes from the first to the last")
    expect(m.sent[0]!.text).toContain("every guard's script is back")
    const kept = readdirSync(join(m.ops, "restore")).filter((f) => f.startsWith("status-"))
    expect(kept).toHaveLength(1)
    expect(m.sent[0]!.text).toContain(`git status in ${join(m.ops, "restore", kept[0]!)}`)
    expect(existsSync(join(m.ops, "restore", "state.json"))).toBe(false)
  })

  test("a loss already staged in the index is put back from HEAD and counted as deleted", async () => {
    const m = await machine()
    await git(m.main, "rm", "-rq", "scripts")
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(missingGuards(m.main, GUARDS)).toEqual([])
    expect(m.sent[0]!.text).toContain("had 2 files deleted and nothing else")
  })

  test("a git status that fails stops the restore before anything is thrown away", async () => {
    const m = await machine({
      "status --porcelain": { code: 128, out: "fatal: index file corrupt\n" },
    })
    m.wipe()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.sent[0]!.text).toContain("stopped at git status: fatal: index file corrupt")
    expect(m.runs.some((r) => r.includes("checkout"))).toBe(false)
    expect(missingGuards(m.main, GUARDS)).toEqual(GUARDS)
  })

  test("with its .git gone too, which breaks the Dashboard's worktree, it restores in place from the URL a healthy look kept, keeping what differed from origin", async () => {
    const m = await machine()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    m.wipe()
    writeFileSync(join(m.main, "README.md"), "changed\n")
    rmSync(join(m.main, ".git"), { force: true, recursive: true })
    await beat(m.ctx(later(60_000)))
    await beat(m.ctx(later(360_000)))
    expect(missingGuards(m.main, GUARDS)).toEqual([])
    expect(await git(m.main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main\n")
    expect(m.runs.some((r) => r.endsWith("read-tree origin/main"))).toBe(true)
    expect(m.sent[0]!.text).toContain("had no .git and was restored in place")
    expect(m.sent[0]!.text).toContain(
      "against origin/main it had 2 files deleted and also held AM README.md",
    )
    expect(m.sent[0]!.text).toContain("has lost its link to it")
    const kept = readdirSync(join(m.ops, "restore")).filter((f) => f.startsWith("status-"))
    expect(kept).toHaveLength(1)
    const status = join(m.ops, "restore", kept[0]!)
    expect(m.sent[0]!.text).toContain(`git status in ${status}`)
    expect(await Bun.file(status).text()).toContain("AM README.md")
  })

  test("with its .git gone and no URL kept, it stops at reading origin's URL and says where it looked", async () => {
    const m = await machine()
    m.wipe()
    rmSync(join(m.main, ".git"), { force: true, recursive: true })
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.sent[0]!.text).toContain(
      `stopped at reading origin's URL: none kept in ${originPath(m.ops)}`,
    )
    expect(m.sent[0]!.text).toContain("The guards are still gone, a true block")
    expect(m.sent[0]!.text).toContain("true-block route")
  })

  test("a stop after the checkout brought the guards back says nothing runs again and leaves the rest to Ops", async () => {
    const m = await machine({ "bun install": { code: 1, out: "error: lockfile had changes\n" } })
    m.wipe()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.sent[0]!.text).toContain("stopped at bun install: error: lockfile had changes")
    expect(m.sent[0]!.text).toContain(
      "The guards are back, so it runs nothing more: Ops finishes the rest by LIFECYCLE.md's steps.",
    )
    expect(m.sent[0]!.text).not.toContain("true block")
  })

  test("a first look recorded a day ago starts the count again, so a passing gap is never acted on", async () => {
    const m = await machine()
    m.wipe()
    const old = new Date(T0.getTime() - DAY).toISOString()
    await seed(m.ops, { last: old, since: old })
    await restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })(m.ctx(T0))
    expect(m.runs).toEqual([])
    expect(await Bun.file(join(m.ops, "restore", "state.json")).json()).toEqual({
      last: T0.toISOString(),
      since: T0.toISOString(),
    })
  })

  test("a stopped restore stays stopped across a gap, until the guards are back", async () => {
    const m = await machine()
    m.wipe()
    const old = new Date(T0.getTime() - DAY).toISOString()
    await seed(m.ops, { failed: "git checkout HEAD -- .", last: old, since: old })
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.runs).toEqual([])
    expect(m.sent).toEqual([])
  })

  test("reads the guard list at each beat when given a reader", async () => {
    const m = await machine()
    m.wipe()
    let reads = 0
    const guards = async () => {
      reads++
      return GUARDS
    }
    const beat = restoreBeat({ guards, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(60_000)))
    expect(reads).toBe(2)
  })

  test("while upkeep holds the main checkout, it waits", async () => {
    const m = await machine()
    m.wipe()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: async () => true })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.runs).toEqual([])
    expect(missingGuards(m.main, GUARDS)).toEqual(GUARDS)
  })

  test("looks in a row count from the last look, so a restore held by upkeep for two looks acts on the fourth, 15 minutes after the first", async () => {
    const m = await machine()
    m.wipe()
    let held = 2
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: async () => held-- > 0 })
    for (const at of [0, 300_000, 600_000]) await beat(m.ctx(later(at)))
    expect(missingGuards(m.main, GUARDS)).toEqual(GUARDS)
    await beat(m.ctx(later(900_000)))
    expect(missingGuards(m.main, GUARDS)).toEqual([])
    expect(m.sent[0]!.text).toContain("on looks 15 minutes from the first to the last")
  })

  test("upkeep is a run slot whose holder runs playground update, read by its pid", async () => {
    const m = await machine({
      "ps -o command= -p 4242": {
        code: 0,
        out: "/bin/bash /x/scripts/ops/run-slot.sh ops -- bun /x/packages/scripts/src/playground/update.ts\n",
      },
    })
    expect(await upkeepHeld(m.ctx(T0))).toBe(false)
    writeFileSync(join(m.ops, "run-slot-2.holder"), "worker-a 4243 2026-11-07T06:00:00Z 1 medium\n")
    expect(await upkeepHeld(m.ctx(T0))).toBe(false)
    writeFileSync(join(m.ops, "run-slot.holder"), "ops 4242 2026-11-07T06:00:00Z 1 medium\n")
    expect(await upkeepHeld(m.ctx(T0))).toBe(true)
  })

  test("upkeep is also a holder running link-skills.sh or any bun install", async () => {
    const m = await machine({
      "ps -o command= -p 4244": { code: 0, out: "bash /x/scripts/link-skills.sh\n" },
      "ps -o command= -p 4245": { code: 0, out: "bun install --ignore-scripts\n" },
    })
    for (const pid of [4244, 4245]) {
      writeFileSync(join(m.ops, "run-slot.holder"), `ops ${pid} 2026-11-07T06:00:00Z 1 medium\n`)
      expect(await upkeepHeld(m.ctx(T0))).toBe(true)
    }
  })

  test("with no upkeep given, the beat reads the run slots' holders itself and waits on one running upkeep", async () => {
    const m = await machine({
      "ps -o command= -p 4242": { code: 0, out: "bun install --cwd /x\n" },
    })
    m.wipe()
    writeFileSync(join(m.ops, "run-slot.holder"), "ops 4242 2026-11-07T06:00:00Z 1 medium\n")
    const beat = restoreBeat({ guards: GUARDS, main: m.main })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.runs).toEqual(["ps -o command= -p 4242"])
    expect(missingGuards(m.main, GUARDS)).toEqual(GUARDS)
  })

  test("a failed step is told once and not tried again until the guards are back", async () => {
    const m = await machine({
      "checkout HEAD -- .": { code: 1, out: "error: unable to unlink old 'x'\n" },
    })
    m.wipe()
    const beat = restoreBeat({ guards: GUARDS, main: m.main, upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(m.sent).toHaveLength(2)
    expect(m.sent[0]!.text).toContain(
      "stopped at git checkout HEAD -- .: error: unable to unlink old 'x'",
    )
    expect(m.sent[0]!.text).toContain(
      `Its git status before it began is in ${join(m.ops, "restore", "status-")}`,
    )
    const runs = m.runs.length
    await beat(m.ctx(later(600_000)))
    expect(m.runs).toHaveLength(runs)
    expect(m.sent).toHaveLength(2)
    await git(m.main, "checkout", "--", ".")
    await beat(m.ctx(later(900_000)))
    expect(existsSync(join(m.ops, "restore", "state.json"))).toBe(false)
  })
})

describe("ops-restore puts back a tracked file modified in the main checkout (#1840)", () => {
  const rootsOf = (m: { main: string; root: string }) => () => ({
    home: join(m.root, "home"),
    main: m.main,
    trash: join(m.root, "data", "trash"),
  })
  const logOf = async (ops: string) =>
    (
      await Bun.file(join(ops, "log", "ops-restore.log"))
        .text()
        .catch(() => "")
    )
      .split("\n")
      .filter(Boolean)
  const readme = (main: string) => readFileSync(join(main, "README.md"), "utf8")

  test("a file modified on two looks in a row comes back as HEAD's copy, its stray copy in the trash, with one log line", async () => {
    const m = await machine()
    writeFileSync(join(m.main, "README.md"), "stray\n")
    const beat = restoreBeat({ guards: GUARDS, main: m.main, roots: rootsOf(m), upkeep: noUpkeep })
    await beat(m.ctx(T0))
    expect(readme(m.main)).toBe("stray\n")
    await beat(m.ctx(later(300_000)))
    expect(readme(m.main)).toBe("origin\n")
    expect(await git(m.main, "status", "--porcelain")).toBe("")
    const lines = await logOf(m.ops)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("restored README.md from HEAD")
    const trashed = /in the trash at (.+) \(playground rm --restore /.exec(lines[0]!)![1]!
    expect(trashed.startsWith(realpathSync(join(m.root, "data", "trash")))).toBe(true)
    expect(readFileSync(trashed, "utf8")).toBe("stray\n")
  })

  test("a staged modification is put back from HEAD too", async () => {
    const m = await machine()
    writeFileSync(join(m.main, "README.md"), "stray\n")
    await git(m.main, "add", "README.md")
    const beat = restoreBeat({ guards: GUARDS, main: m.main, roots: rootsOf(m), upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(readme(m.main)).toBe("origin\n")
    expect(await git(m.main, "status", "--porcelain")).toBe("")
    expect(await logOf(m.ops)).toHaveLength(1)
  })

  test("a file modified on one look only is left as it is", async () => {
    const m = await machine()
    writeFileSync(join(m.main, "README.md"), "stray\n")
    const beat = restoreBeat({ guards: GUARDS, main: m.main, roots: rootsOf(m), upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(SECOND_LOOK_MS - 10_000)))
    expect(readme(m.main)).toBe("stray\n")
    expect(await logOf(m.ops)).toEqual([])
  })

  test("an untracked file and a staged add stay as they are", async () => {
    const m = await machine()
    writeFileSync(join(m.main, "new.txt"), "new\n")
    writeFileSync(join(m.main, "added.txt"), "added\n")
    await git(m.main, "add", "added.txt")
    const beat = restoreBeat({ guards: GUARDS, main: m.main, roots: rootsOf(m), upkeep: noUpkeep })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(await git(m.main, "status", "--porcelain")).toBe("A  added.txt\n?? new.txt\n")
    expect(await logOf(m.ops)).toEqual([])
    expect(existsSync(join(m.root, "data", "trash"))).toBe(false)
  })

  test("while upkeep holds the main checkout, a modified file waits", async () => {
    const m = await machine()
    writeFileSync(join(m.main, "README.md"), "stray\n")
    const beat = restoreBeat({
      guards: GUARDS,
      main: m.main,
      roots: rootsOf(m),
      upkeep: async () => true,
    })
    await beat(m.ctx(T0))
    await beat(m.ctx(later(300_000)))
    expect(readme(m.main)).toBe("stray\n")
    expect(await logOf(m.ops)).toEqual([])
  })
})

// Imported at each call, so this file's other tests still run on a tree that lacks it.
const restoreNow = async (ctx: Context, restore: Restore) =>
  (await import("../../../../../packages/scripts/src/ops-restore/cli")).restoreNow(ctx, restore)

describe("the Dashboard's Restore now runs the same steps at once (#1919)", () => {
  test("with a guard gone, one look is enough: it restores, installs, links and tells ops and the dispatcher", async () => {
    const m = await machine()
    m.wipe()
    const pressed = await restoreNow(m.ctx(T0), { guards: GUARDS, main: m.main, upkeep: noUpkeep })
    expect(pressed.code).toBe(0)
    expect(missingGuards(m.main, GUARDS)).toEqual([])
    expect(m.runs.some((r) => r.includes("run-slot.sh ops-restore -- bun install --cwd"))).toBe(
      true,
    )
    expect(m.runs.some((r) => r.endsWith("scripts/link-skills.sh"))).toBe(true)
    expect(pressed.text).toContain("2 guards were gone from")
    expect(pressed.text).toContain("Restore now on the Dashboard restored the checkout")
    expect(m.sent.map((s) => s.to)).toEqual(["ops", "dispatcher"])
    expect(m.sent[0]!.text).toBe(`ops-restore: ${pressed.text}`)
  })

  test("a checkout whose guards are all there is left as it is", async () => {
    const m = await machine()
    writeFileSync(join(m.main, "README.md"), "stray\n")
    const pressed = await restoreNow(m.ctx(T0), { guards: GUARDS, main: m.main, upkeep: noUpkeep })
    expect(pressed).toEqual({
      code: 3,
      text: `Every guard is in place in ${m.main}, so nothing was restored.`,
    })
    expect(m.runs).toEqual([])
    expect(m.sent).toEqual([])
    expect(readFileSync(join(m.main, "README.md"), "utf8")).toBe("stray\n")
  })

  test("while a run slot's holder runs upkeep on the main checkout, nothing runs", async () => {
    const m = await machine({
      "ps -o command= -p 4242": { code: 0, out: "bun install --cwd /x\n" },
    })
    m.wipe()
    writeFileSync(join(m.ops, "run-slot.holder"), "ops 4242 2026-11-07T06:00:00Z 1 medium\n")
    const pressed = await restoreNow(m.ctx(T0), { guards: GUARDS, main: m.main })
    expect(pressed.code).toBe(1)
    expect(pressed.text).toContain("so nothing was restored")
    expect(m.runs).toEqual(["ps -o command= -p 4242"])
    expect(missingGuards(m.main, GUARDS)).toEqual(GUARDS)
  })

  test("a step that fails is named in the words the page shows, and runs after a beat's failed restore too", async () => {
    const m = await machine({ "bun install": { code: 1, out: "error: no network\n" } })
    m.wipe()
    await seed(m.ops, { failed: "bun install", last: T0.toISOString(), since: T0.toISOString() })
    const pressed = await restoreNow(m.ctx(T0), { guards: GUARDS, main: m.main, upkeep: noUpkeep })
    expect(pressed.code).toBe(1)
    expect(pressed.text).toContain("stopped at bun install: error: no network")
    expect(pressed.text).toContain("The guards are back: Ops finishes the rest")
  })

  test("a folder that holds no checkout is refused", async () => {
    const m = await machine()
    const pressed = await restoreNow(m.ctx(T0), {
      guards: GUARDS,
      main: join(m.root, "nowhere"),
      upkeep: noUpkeep,
    })
    expect(pressed.code).toBe(1)
    expect(m.runs).toEqual([])
  })
})
