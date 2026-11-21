import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FIX, STALE } from "../../../../../packages/scripts/src/hooks-bundle"
import {
  prMerge,
  runGit,
  type Run,
  type RunResult,
} from "../../../../../packages/scripts/src/pr-merge/merge"
import {
  ciSteps,
  cloneArgs,
  slotted,
  typesGate,
  type Prepare,
  type TypeSteps,
} from "../../../../../packages/scripts/src/pr-merge/types"
import "./scratch-config"
import { PR_TEMPLATE } from "./bodies"
import { greenChecks } from "./suite"

// The repo's own tsc, run on a three-file project, so the gate's run stays fast.
const TSC = join(import.meta.dir, "../../../../../node_modules/.bin/tsc")
const REPO = "acme/factory"
const N = 7

const scratch = mkdtempSync(join(tmpdir(), "pr-merge-types-"))
process.env.PLAYGROUND_MERGE_LOCK_DIR = join(scratch, "lock")
process.env.PLAYGROUND_HELD_PRS = join(scratch, "held-prs.json")
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const ok = (stdout: string): RunResult => ({ code: 0, stderr: "", stdout })

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await runGit(["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args])
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
}

const commit = async (root: string, message: string) => {
  await sh(root, "add", "-A")
  await sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message)
  return sh(root, "rev-parse", "HEAD")
}

// A scratch origin and the checkout pr:merge runs from: canary changes add()'s arity and its one caller, and PR 7's head, branched before that, adds a caller with the old arity in a file of its own, so the two merge with no conflict. merged: the head merges canary in first, so it holds canary's tip.
async function world(name: string, { merged = false } = {}) {
  const root = join(scratch, name)
  const work = join(root, "work")
  mkdirSync(work, { recursive: true })
  await sh(work, "init", "-q", "-b", "canary")
  write(work, {
    "lib.ts": "export const add = (a: number): number => a\n",
    "main.ts": 'import { add } from "./lib"\nexport const one = add(1)\n',
    "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }),
  })
  mkdirSync(join(work, "extensions/core/skills/pr"), { recursive: true })
  write(work, { "extensions/core/skills/pr/SKILL.md": PR_TEMPLATE })
  await commit(work, "base")
  await sh(work, "switch", "-qc", "pr")
  write(work, { "extra.ts": 'import { add } from "./lib"\nexport const two = add(2)\n' })
  await commit(work, "pr: a caller")
  await sh(work, "switch", "-q", "canary")
  write(work, {
    "lib.ts": "export const add = (a: number, b: number): number => a + b\n",
    "main.ts": 'import { add } from "./lib"\nexport const one = add(1, 0)\n',
  })
  await commit(work, "canary: add takes two")
  if (merged) {
    await sh(work, "switch", "-q", "pr")
    await sh(
      work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "merge",
      "-q",
      "--no-edit",
      "canary",
    )
    write(work, { "extra.ts": 'import { add } from "./lib"\nexport const two = add(2, 0)\n' })
    await commit(work, "pr: two arguments")
  }
  const head = await sh(work, "rev-parse", "pr")
  const origin = join(root, "origin.git")
  await sh(root, "init", "-q", "--bare", origin)
  await sh(work, "push", "-q", origin, "canary", `pr:refs/pull/${N}/head`)
  const checkout = join(root, "checkout")
  await sh(root, "clone", "-q", "-b", "canary", origin, checkout)
  const git: Run = (args) => runGit(["-C", checkout, ...args])
  const lockRoot = join(root, "lock")
  mkdirSync(lockRoot)
  return { checkout, git, head, lockRoot }
}

// A scratch repo whose canary is ahead of PR 7's head and moves on while the head stays, so every check runs: check() runs the types gate on their merged tree with the given steps, and canary() commits files onto canary.
async function repo(name: string) {
  const work = join(scratch, name)
  mkdirSync(join(work, "patches"), { recursive: true })
  await sh(work, "init", "-q", "-b", "canary")
  write(work, {
    ".gitignore": ".claude/\nnode_modules/\nout/\n",
    "bun.lock": "{}\n",
    "lib.ts": "export const add = (a: number): number => a\n",
    "package.json": "{}\n",
    "patches/a.patch": "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }),
  })
  mkdirSync(join(work, "extensions/core/skills/pr"), { recursive: true })
  write(work, { "extensions/core/skills/pr/SKILL.md": PR_TEMPLATE })
  await commit(work, "base")
  await sh(work, "switch", "-qc", "pr")
  write(work, { "extra.ts": 'import { add } from "./lib"\nexport const two = add(2)\n' })
  const head = await commit(work, "pr: a caller")
  await sh(work, "switch", "-q", "canary")
  write(work, { "main.ts": "export const one = 1\n" })
  await commit(work, "canary: ahead of the head")
  const git: Run = (args) => runGit(["-C", work, ...args])
  const lockRoot = join(work, "..", `${name}-lock`)
  const check = async (steps: TypeSteps) => {
    const canary = await sh(work, "rev-parse", "canary")
    const mergeTree = await sh(work, "merge-tree", "--write-tree", canary, head)
    return typesGate({ facts: { canary, head, mergeTree, n: N }, git, lockRoot, steps })
  }
  const canary = async (files: Record<string, string>) => {
    write(work, files)
    await commit(work, "canary moves")
  }
  return { canary, check, git, work }
}

// Steps that record their names and run none of CI's: clone makes node_modules with a file in it, and the step named fail fails.
const recorder =
  (runs: string[][], fail = ""): TypeSteps =>
  (at) => {
    const steps = ciSteps(at)
    runs.push(steps.map((step) => step.name))
    return steps.map((step) => ({
      ...step,
      argv:
        step.name === fail
          ? ["false"]
          : step.name === "clone"
            ? ["sh", "-c", "mkdir node_modules && touch node_modules/kept"]
            : ["true"],
    }))
  }

// gh for PR 7 at head, every gate but types passing: canary is one commit ahead.
const gh = (head: string, aheadBy: string) => {
  const calls: string[][] = []
  const run: Run = async (args) => {
    calls.push(args)
    const joined = args.join(" ")
    if (joined.startsWith("pr view") && joined.includes("baseRefName"))
      return ok(
        JSON.stringify({
          author: { login: "acme" },
          baseRefName: "canary",
          headRefOid: head,
          isDraft: false,
          state: "OPEN",
          statusCheckRollup: [
            ...greenChecks(),
            { conclusion: "SUCCESS", name: "GitGuardian Security Checks", status: "COMPLETED" },
          ],
        }),
      )
    if (joined.includes("/files")) return ok("extra.ts\n")
    if (joined.includes("/comments"))
      return ok(
        JSON.stringify({
          author: "acme",
          body: `## ReviewBot · round 1: 5/5 at ${head.slice(0, 7)} · 0 blocking`,
          createdAt: "2026-11-01T15:00:00Z",
        }),
      )
    if (joined.includes("/compare/")) return ok(aheadBy)
    if (joined.startsWith("pr view") && joined.includes("--json body")) return ok("Closes #360")
    if (joined.startsWith("pr merge")) return ok("")
    if (joined.startsWith("pr view") && joined.includes("mergeCommit"))
      return ok(JSON.stringify({ mergeCommit: { oid: "abc1234def" }, state: "MERGED" }))
    if (joined.startsWith("pr comment")) return ok("")
    return { code: 1, stderr: `unexpected gh ${joined}`, stdout: "" }
  }
  return { calls, run }
}

const squashes = (calls: string[][]) =>
  calls.filter((args) => args[0] === "pr" && args[1] === "merge")

const tsc = () => [{ argv: [TSC, "-p", "."], name: "tsc", types: true }]

describe("the types gate", () => {
  test("refuses a head green alone whose clean merge with canary fails the type check, naming the error", async () => {
    const { checkout, git, head, lockRoot } = await world("arity")
    const { calls, run } = gh(head, "1")
    const outcome = await prMerge(N, { repo: REPO }, run, {
      git,
      lockRoot,
      store: null,
      types: tsc,
    })
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.filter((gate) => !gate.ok).map((gate) => gate.name)).toEqual(["types"])
    const types = outcome.gates.find((gate) => gate.name === "types")
    expect(types?.detail).toContain(
      "extra.ts(2,20): error TS2554: Expected 2 arguments, but got 1.",
    )
    expect(types?.detail).toContain(". Merge canary into the PR and fix the error")
    expect(squashes(calls)).toEqual([])
    // the one merge-types worktree stays for the next merge, and git still lists it
    expect(existsSync(join(checkout, ".claude", "worktrees", "merge-types"))).toBe(true)
    expect((await git(["worktree", "list"])).stdout.trim().split("\n")).toHaveLength(2)
    // the same head and canary refuse again from the kept refusal, with no second run
    const again = await prMerge(N, { repo: REPO }, gh(head, "1").run, {
      git,
      lockRoot,
      store: null,
      types: () => {
        throw new Error("ran a second time")
      },
    })
    expect(again.gates.find((gate) => gate.name === "types")?.detail).toBe(types?.detail ?? "")
  })

  test("merges a clean merged tree that type-checks, with each step's time", async () => {
    const { git, head, lockRoot } = await world("passes")
    const { calls, run } = gh(head, "1")
    const passing = () => [{ argv: ["true"], name: "tsc", types: true }]
    const outcome = await prMerge(N, { repo: REPO }, run, {
      git,
      lockRoot,
      store: null,
      types: passing,
    })
    expect(outcome.kind).toBe("merged")
    expect(outcome.gates.find((gate) => gate.name === "types")?.detail).toMatch(
      /type-checks: tsc \d+s$/,
    )
    expect(squashes(calls)).toHaveLength(1)
  })

  test("skips the type check when the head already holds canary's tip", async () => {
    const { git, head, lockRoot } = await world("holds", { merged: true })
    const { calls, run } = gh(head, "0")
    const outcome = await prMerge(N, { repo: REPO }, run, {
      git,
      lockRoot,
      store: null,
      types: () => {
        throw new Error("the gate ran on a head that holds canary")
      },
    })
    expect(outcome.kind).toBe("merged")
    expect(outcome.gates.find((gate) => gate.name === "types")?.detail).toMatch(
      /^skipped: [0-9a-f]{7} holds canary [0-9a-f]{7}, so its own checks typed this tree$/,
    )
    expect(squashes(calls)).toHaveLength(1)
  })

  test("refuses a run it cannot finish, naming the fix, and keeps the worktree", async () => {
    const { checkout, git, head, lockRoot } = await world("unfinished")
    const failing = () => [{ argv: ["false"], name: "install" }]
    const outcome = await prMerge(N, { repo: REPO }, gh(head, "1").run, {
      git,
      lockRoot,
      store: null,
      types: failing,
    })
    expect(outcome.gates.find((gate) => gate.name === "types")).toMatchObject({ ok: false })
    expect(outcome.gates.find((gate) => gate.name === "types")?.detail).toStartWith(
      "could not finish the merged-tree type check: install exited 1",
    )
    expect(readdirSync(join(checkout, ".claude", "worktrees"))).toEqual(["merge-types"])
  })

  test("refuses a step that runs past the budget, slot waits included", async () => {
    const { git, head, lockRoot } = await world("slow")
    const slow = () => [{ argv: ["sleep", "10"], name: "check-types", types: true }]
    const outcome = await prMerge(N, { repo: REPO }, gh(head, "1").run, {
      git,
      lockRoot,
      store: null,
      types: slow,
      typesBudgetMs: 2000,
    })
    expect(outcome.gates.find((gate) => gate.name === "types")?.detail).toContain(
      "check-types ran past the check's",
    )
  })

  test("--explain names the types gate and why it would run or skip, running no check", async () => {
    const behind = await world("explain-behind")
    const explained = await prMerge(N, { explain: true, repo: REPO }, gh(behind.head, "1").run, {
      git: behind.git,
      lockRoot: behind.lockRoot,
      types: () => {
        throw new Error("explain ran the check")
      },
    })
    expect(explained.kind).toBe("explained")
    expect(explained.gates.find((gate) => gate.name === "types")).toMatchObject({ ok: true })
    expect(explained.gates.find((gate) => gate.name === "types")?.detail).toMatch(
      /^runs at the merge: canary has commits [0-9a-f]{7} lacks, so pr:merge type-checks the merged tree [0-9a-f]{7}, and checks its hook bundles when the PR touches scripts\/hooks\/ or packages\/ \(--explain runs none\)$/,
    )
    const holds = await world("explain-holds", { merged: true })
    const skipped = await prMerge(N, { explain: true, repo: REPO }, gh(holds.head, "0").run, {
      git: holds.git,
      lockRoot: holds.lockRoot,
    })
    expect(skipped.gates.find((gate) => gate.name === "types")?.detail).toStartWith("skipped: ")
  })

  test("a second check with the same dependencies reuses the worktree: no clone, no install, its node_modules kept", async () => {
    const r = await repo("reuse")
    const runs: string[][] = []
    const recorded = recorder(runs)
    const worktree = join(r.work, ".claude", "worktrees", "merge-types")
    expect(await r.check(recorded)).toMatchObject({ ok: true })
    expect(runs.at(-1)?.slice(0, 2)).toEqual(["clone", "install"])
    await r.canary({ "other.ts": "export const other = 1\n" })
    expect(await r.check(recorded)).toMatchObject({ ok: true })
    expect(runs.at(-1)).not.toContain("clone")
    expect(runs.at(-1)).not.toContain("install")
    expect(existsSync(join(worktree, "node_modules", "kept"))).toBe(true)
    expect((await r.git(["worktree", "list"])).stdout.trim().split("\n")).toHaveLength(2)
    // a changed package.json, bun.lock, bunfig.toml or patch installs again into the kept node_modules, with no clone
    for (const changed of ["package.json", "bun.lock", "bunfig.toml", "patches/a.patch"]) {
      await r.canary({ [changed]: `${changed} changed\n` })
      expect(await r.check(recorded)).toMatchObject({ ok: true })
      expect(runs.at(-1)?.slice(0, 2)).toEqual(["install", "check-types"])
      expect(existsSync(join(worktree, "node_modules", "kept"))).toBe(true)
    }
  })

  test("an install that never finished runs again, even on a tree back on the dependencies installed before it", async () => {
    const r = await repo("unfinished-install")
    const runs: string[][] = []
    expect(await r.check(recorder(runs))).toMatchObject({ ok: true })
    await r.canary({ "package.json": '{ "two": true }\n' })
    expect(await r.check(recorder(runs, "install"))).toMatchObject({ ok: false })
    await r.canary({ "package.json": "{}\n" })
    expect(await r.check(recorder(runs))).toMatchObject({ ok: true })
    expect(runs.at(-1)?.slice(0, 2)).toEqual(["install", "check-types"])
  })

  test("a worktree that cannot be reused is made again with a fresh clone", async () => {
    const r = await repo("broken")
    const worktree = join(r.work, ".claude", "worktrees", "merge-types")
    const runs: string[][] = []
    expect(await r.check(recorder(runs))).toMatchObject({ ok: true })
    for (const broken of [worktree, join(r.work, ".git", "worktrees", "merge-types")]) {
      rmSync(broken, { force: true, recursive: true })
      await r.canary({ "other.ts": `export const other = "${broken}"\n` })
      expect(await r.check(recorder(runs))).toMatchObject({ ok: true })
      expect(runs.at(-1)?.slice(0, 2)).toEqual(["clone", "install"])
      expect(existsSync(join(worktree, "other.ts"))).toBe(true)
    }
  })

  test("a check reads its own merged tree alone: nothing the last check left in the worktree leaks in", async () => {
    const r = await repo("stale")
    const worktree = join(r.work, ".claude", "worktrees", "merge-types")
    const broken = "export const bad: number = 'text'\n"
    // the first check leaves an untracked file, an ignored one and an edited tracked one, each a type error, beside a file in node_modules
    const leaves = () => [
      { argv: ["mkdir", "-p", "node_modules", "out"], name: "clone" },
      {
        argv: [
          "sh",
          "-c",
          `for f in leak.ts out/leak.ts lib.ts; do echo "${broken}" > "$f"; done; touch node_modules/kept`,
        ],
        name: "leave",
      },
    ]
    expect(await r.check(leaves)).toMatchObject({ ok: true })
    await r.canary({ "other.ts": "export const other = 1\n" })
    expect(await r.check(tsc)).toMatchObject({ ok: true })
    expect(existsSync(join(worktree, "leak.ts"))).toBe(false)
    expect(existsSync(join(worktree, "out", "leak.ts"))).toBe(false)
    expect(existsSync(join(worktree, "node_modules", "kept"))).toBe(true)
  })

  // pr:merge's types step runs CI's own type filters, @packages/scripts among them for the reason turbo.json's @packages/scripts#check-types gives
  test("ciSteps' check-types takes CI's filters, @packages/scripts among them, with canary for CI's base", async () => {
    const canary = "c".repeat(40)
    const workflow = Bun.YAML.parse(
      await Bun.file(
        join(import.meta.dir, "../../../../../.github/workflows/auto-check-build.yml"),
      ).text(),
    ) as { jobs: Record<string, { steps: { run?: string }[] }> }
    const line = Object.values(workflow.jobs)
      .flatMap((job) => job.steps.flatMap((step) => (step.run ?? "").split("\n")))
      .find((each) => each.includes("turbo run check-types"))
    const ci = [...(line ?? "").matchAll(/--filter=(?:'([^']*)'|(\S+))/g)].map(
      ([, quoted, bare]) =>
        `--filter=${(quoted ?? bare)!.replace("origin/${{ github.base_ref }}", canary)}`,
    )
    const step = ciSteps({
      canary,
      checkout: "/co",
      hooks: false,
      prepare: "none",
      worktree: "/wt",
    }).find((each) => each.name === "check-types")
    expect(ci).toContain("--filter=@packages/scripts")
    expect(step?.argv.filter((arg) => arg.startsWith("--filter="))).toEqual(ci)
  })

  test("ciSteps runs CI's type steps after what node_modules needs, each through run-slot as the merge train, or bare under a held slot", () => {
    const at = { canary: "c".repeat(40), checkout: "/co", worktree: "/wt" }
    const checks = [
      [
        "check-types",
        `bunx turbo run check-types --filter=...[${"c".repeat(40)}] --filter=@packages/scripts`,
        true,
      ],
      ["build", "bunx turbo run build --filter=./packages/* --filter=@api/hono", true],
      ["metrics", "bun packages/scripts/src/data-table-metrics.ts", false],
      ["check-types:tests", "bun run check-types:tests", true],
    ]
    const flags = process.platform === "darwin" ? "-cR" : "-R --reflink=auto"
    const clone = ["clone", `cp ${flags} /co/node_modules /wt/`, false]
    const forced = ["install", "bun install --force --ignore-scripts --cwd /wt", false]
    const install = ["install", "bun install --ignore-scripts --cwd /wt", false]
    const nice = process.env.RUN_SLOT_NICE
    process.env.RUN_SLOT_NICE = "10"
    try {
      const listed = (prepare: Prepare, hooks = false) =>
        ciSteps({ ...at, hooks, prepare }).map((step) => [
          step.name,
          step.argv.join(" "),
          step.types ?? false,
        ])
      expect(listed("clone")).toEqual([clone, forced, ...checks])
      expect(listed("install")).toEqual([install, ...checks])
      expect(listed("none")).toEqual(checks)
      expect(listed("install", true)).toEqual([
        install,
        ["bundles", "bun packages/scripts/src/hooks-bundle.ts --check", false],
        ...checks,
      ])
      expect(
        ciSteps({ ...at, hooks: true, prepare: "none" })
          .filter((step) => step.bundles)
          .map((step) => step.name),
      ).toEqual(["bundles"])
      expect(
        ciSteps({ ...at, hooks: false, prepare: "install" })
          .filter((step) => step.deps)
          .map((step) => step.name),
      ).toEqual(["install"])
    } finally {
      if (nice === undefined) delete process.env.RUN_SLOT_NICE
      else process.env.RUN_SLOT_NICE = nice
    }
    expect(slotted(["tsc"], {}, "/ops/run-slot.sh")).toEqual([
      "/ops/run-slot.sh",
      "ops-merge-train",
      "--",
      "tsc",
    ])
    expect(slotted(["tsc"], { RUN_SLOT_NICE: "10" }, "/ops/run-slot.sh")).toEqual(["tsc"])
    expect(slotted(["tsc"], {}, null)).toEqual(["tsc"])
  })

  // GNU cp has no -c, so the clone's macOS flag refused every merge behind canary on Linux (#2334)
  test("cloneArgs clones with -c on macOS and with --reflink=auto on Linux", () => {
    expect(cloneArgs("darwin")).toEqual(["-cR"])
    expect(cloneArgs("linux")).toEqual(["-R", "--reflink=auto"])
  })
})

// 3 Nov: a head that changed shell.ts, branched before no-raw-delete.js was added, passed its own checks; the tree its merge wrote held that bundle, built from the shell.ts the head then changed
describe("the bundles step on the merged tree", () => {
  // a scratch repo whose canary is ahead of PR 7's head, the head adding the given file, and the hooks flag each check's steps were given
  async function touching(name: string, path: string) {
    const work = join(scratch, name)
    mkdirSync(work, { recursive: true })
    await sh(work, "init", "-q", "-b", "canary")
    write(work, { ".gitignore": ".claude/\nnode_modules/\n", "lib.ts": "export const a = 1\n" })
    await commit(work, "base")
    await sh(work, "switch", "-qc", "pr")
    mkdirSync(join(work, path, ".."), { recursive: true })
    write(work, { [path]: "export const b = 2\n" })
    const head = await commit(work, "pr: one file")
    await sh(work, "switch", "-q", "canary")
    write(work, { "main.ts": "export const one = 1\n" })
    const canary = await commit(work, "canary: ahead of the head")
    const mergeTree = await sh(work, "merge-tree", "--write-tree", canary, head)
    const git: Run = (args) => runGit(["-C", work, ...args])
    const flags: boolean[] = []
    const gate = await typesGate({
      facts: { canary, head, mergeTree, n: N },
      git,
      lockRoot: join(work, "..", `${name}-lock`),
      steps: (at) => {
        flags.push(at.hooks)
        return [{ argv: ["true"], name: "tsc", types: true }]
      },
    })
    return { flags, gate }
  }

  test("a PR touching scripts/hooks/ runs the bundles step", async () => {
    expect((await touching("hooks-source", "scripts/hooks/shell.ts")).flags).toEqual([true])
  })

  test("a PR touching only a packages/ file a hook imports runs the bundles step", async () => {
    expect((await touching("hooks-import", "packages/env/src/data-dir.ts")).flags).toEqual([true])
  })

  test("a PR touching neither scripts/hooks/ nor packages/ skips it", async () => {
    expect((await touching("hooks-none", "web/next/src/page.tsx")).flags).toEqual([false])
  })

  // the line --check prints, built from its own parts, so a change to it goes red here
  const stale = [`${STALE} no-raw-delete.js; ${FIX}`]
  const bundles = (argv: string[]) => () => [{ argv, bundles: true, name: "bundles" }]

  test("refuses a merged tree whose bundles a fresh build would write otherwise, naming them and the redo", async () => {
    const { git, head, lockRoot } = await world("bundles-stale")
    const { calls, run } = gh(head, "1")
    const outcome = await prMerge(N, { repo: REPO }, run, {
      git,
      lockRoot,
      store: null,
      types: bundles(["sh", "-c", 'printf "%s\\n" "$1" >&2; exit 1', "sh", stale[0]]),
    })
    expect(outcome.kind).toBe("refused")
    const types = outcome.gates.find((gate) => gate.name === "types")
    expect(types?.detail).toContain("stale in scripts/hooks/bundled: no-raw-delete.js")
    expect(types?.detail).toContain(
      "Merge canary into the PR plainly, run `bun run hooks:bundle`, and commit the rebuild on its own",
    )
    expect(types?.detail).not.toContain(FIX)
    expect(squashes(calls)).toEqual([])
    // the same head and canary refuse again from the kept refusal, with no second run
    const again = await prMerge(N, { repo: REPO }, gh(head, "1").run, {
      git,
      lockRoot,
      store: null,
      types: () => {
        throw new Error("ran a second time")
      },
    })
    expect(again.gates.find((gate) => gate.name === "types")?.detail).toBe(types?.detail ?? "")
  })

  test("merges the same PR once its bundles are rebuilt", async () => {
    const { git, head, lockRoot } = await world("bundles-fresh")
    const { calls, run } = gh(head, "1")
    const outcome = await prMerge(N, { repo: REPO }, run, {
      git,
      lockRoot,
      store: null,
      types: bundles(["true"]),
    })
    expect(outcome.kind).toBe("merged")
    expect(outcome.gates.find((gate) => gate.name === "types")?.detail).toMatch(/bundles \d+s$/)
    expect(squashes(calls)).toHaveLength(1)
  })

  test("a bundles step that fails without naming a stale bundle is a run it could not finish", async () => {
    const { git, head, lockRoot } = await world("bundles-crash")
    const outcome = await prMerge(N, { repo: REPO }, gh(head, "1").run, {
      git,
      lockRoot,
      store: null,
      types: bundles(["sh", "-c", "echo 'hooks-bundle: the build failed' >&2; exit 1"]),
    })
    expect(outcome.gates.find((gate) => gate.name === "types")?.detail).toStartWith(
      "could not finish the merged-tree type check: bundles exited 1",
    )
  })
})
