import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  type Run,
  runUpdate,
  spawnRun,
  updateSteps,
} from "../../../../../packages/scripts/src/playground/update"
import { watchTorn } from "../torn-reads"

// a run under run-slot would give its own real lane back from the rows that roll, so every row starts with none
delete process.env.RUN_SLOT_HELD

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "playground-update-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

describe("updateSteps", () => {
  test("a lockfile or a package.json changed installs", () => {
    expect(updateSteps(["bun.lock"]).install).toBe(true)
    expect(updateSteps(["api/hono/package.json"]).install).toBe(true)
    expect(updateSteps(["README.md", "package.json.bak"]).install).toBe(false)
  })

  test("the skills a merge changed are each one folder, once, A to Z by name, for a live session to read the new text from", () => {
    expect(
      updateSteps([
        "extensions/core/skills/pr/SKILL.md",
        "extensions/core/skills/code-review-loop/scripts/state.ts",
        "extensions/core/skills/code-review-loop/SKILL.md",
        "skills/zerostarter/ui-verify/SKILL.md",
        "skills/playground/README.md",
        "skills/playground/inbox/SKILL.md",
        "extensions/slack/skills/slack/scripts/send.ts",
        "extensions/slack/README.md",
        "extensions/core/rules/ci.md",
      ]).skills,
    ).toEqual([
      "extensions/core/skills/code-review-loop",
      "skills/playground/inbox",
      "extensions/core/skills/pr",
      "extensions/slack/skills/slack",
      "skills/zerostarter/ui-verify",
    ])
    expect(updateSteps(["README.md"]).skills).toEqual([])
  })

  test("a package with a dist changed builds; packages/scripts runs from source", () => {
    expect(updateSteps(["packages/db/src/schema/claude.ts"]).build).toBe(true)
    expect(updateSteps(["packages/scripts/src/playground/update.ts"]).build).toBe(false)
    expect(updateSteps(["api/hono/src/main.ts"]).build).toBe(false)
  })
})

// A run that answers each argv from the script given, by its first matching word, and records every call.
const fakeRun = (answers: Record<string, { code?: number; out?: string }> = {}) => {
  const calls: string[][] = []
  // the checkout is on main unless the script says otherwise
  const script: typeof answers = { "--show-current": { out: "main\n" }, ...answers }
  const run: Run = async (argv) => {
    calls.push(argv)
    const hit = Object.entries(script).find(([word]) => argv.includes(word))
    return { code: hit?.[1].code ?? 0, out: hit?.[1].out ?? "" }
  }
  return { calls, run }
}

describe("runUpdate", () => {
  const repo = "/repo"
  const quiet = () => {}

  test("nothing changed: fetch, read the target's manifests, merge, link-skills first (every later step reads the data folder it links), ops-restart, then the roll, with no install or build", async () => {
    const { calls, run } = fakeRun({ "rev-parse": { out: "old\n" } })
    let rolled = 0
    const code = await runUpdate(repo, run, async () => (rolled++, 0), quiet)
    expect(code).toBe(0)
    expect(rolled).toBe(1)
    expect(calls).toEqual([
      ["git", "-C", repo, "rev-parse", "HEAD"],
      ["git", "-C", repo, "fetch", "-q", "origin", "main"],
      ["git", "-C", repo, "branch", "--show-current"],
      ["git", "-C", repo, "merge-base", "--is-ancestor", "HEAD", "origin/main"],
      ["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"],
      ["git", "-C", repo, "ls-tree", "-r", "--name-only", "origin/main"],
      ["git", "-C", repo, "diff", "-z", "--name-status", "--no-renames", "HEAD", "origin/main"],
      ["git", "-C", repo, "merge", "--ff-only", "-q", "origin/main"],
      ["bash", `${repo}/scripts/link-skills.sh`],
      ["git", "-C", repo, "diff", "--name-only", "old", "HEAD"],
      [
        process.execPath,
        "--no-env-file",
        `${repo}/packages/scripts/src/ops-restart/cli.ts`,
        repo,
        "old",
        "HEAD",
      ],
    ])
  })

  test("the brief refresh runs after link-skills with the commit the update started from, and its failure is logged while the update goes on (#2317)", async () => {
    const { calls, run } = fakeRun({ "rev-parse": { out: "old\n" } })
    const seen: { calls: number; old: string }[] = []
    const briefs = async (old: string) => {
      seen.push({ calls: calls.length, old })
    }
    expect(await runUpdate(repo, run, async () => 0, quiet, undefined, undefined, briefs)).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.old).toBe("old")
    expect(calls[seen[0]!.calls - 1]).toEqual(["bash", `${repo}/scripts/link-skills.sh`])
    const said: string[] = []
    const failing = async () => {
      throw new Error("a made-up git failure")
    }
    expect(
      await runUpdate(
        repo,
        fakeRun().run,
        async () => 0,
        (l) => said.push(l),
        undefined,
        undefined,
        failing,
      ),
    ).toBe(0)
    expect(said).toContain("playground update: brief refresh failed: a made-up git failure")
  })

  test("the peer sync runs after ops-restart and before the roll, with the commit HEAD reached, on --to too, and its failure is logged while the update succeeds (#2449)", async () => {
    const order: string[] = []
    const { calls, run } = fakeRun({ "rev-parse": { out: "new\n" } })
    const peers = async (sha: string) => {
      order.push(`peers ${sha} after ${calls.at(-1)?.join(" ")}`)
    }
    const roll = async () => (order.push("roll"), 0)
    expect(await runUpdate(repo, run, roll, quiet, undefined, undefined, undefined, peers)).toBe(0)
    expect(order).toEqual([`peers new after git -C ${repo} rev-parse HEAD`, "roll"])
    expect(calls.at(-2)?.[2]).toContain("ops-restart")
    const tagged = fakeRun({ "rev-parse": { out: "tagged\n" } })
    const seen: string[] = []
    const atTag = async (sha: string) => {
      seen.push(sha)
    }
    expect(
      await runUpdate(repo, tagged.run, roll, quiet, "v1.0.0", undefined, undefined, atTag),
    ).toBe(0)
    expect(seen).toEqual(["tagged"])
    const said: string[] = []
    const failing = async () => {
      throw new Error("a made-up ssh failure")
    }
    expect(
      await runUpdate(
        repo,
        fakeRun().run,
        async () => 0,
        (l) => said.push(l),
        undefined,
        undefined,
        undefined,
        failing,
      ),
    ).toBe(0)
    expect(said).toContain("playground update: peer sync failed: a made-up ssh failure")
  })

  test("a merge that changed a skill names it and the folder in the checkout a live session reads it from; one that changed none says nothing of skills", async () => {
    const said: string[] = []
    const { run } = fakeRun({
      diff: { out: "extensions/core/skills/pr/SKILL.md\nskills/zerostarter/dev/SKILL.md\n" },
    })
    expect(
      await runUpdate(
        repo,
        run,
        async () => 0,
        (l) => said.push(l),
      ),
    ).toBe(0)
    expect(said).toContain(
      `playground update: skills changed: dev, pr; a running session's Skill tool serves the copy it started with, so a live session reads each one's files here: ${repo}/skills/zerostarter/dev/, ${repo}/extensions/core/skills/pr/; send each lead these folders, for the lead to have each of its live checkers read the new text there (release)`,
    )
    const quietSaid: string[] = []
    expect(
      await runUpdate(
        repo,
        fakeRun().run,
        async () => 0,
        (l) => quietSaid.push(l),
      ),
    ).toBe(0)
    expect(quietSaid.some((l) => l.includes("skills changed"))).toBe(false)
  })

  test("a changed lockfile and package install and build before the restart", async () => {
    const { calls, run } = fakeRun({ diff: { out: "bun.lock\npackages/db/src/index.ts\n" } })
    expect(await runUpdate(repo, run, async () => 0, quiet)).toBe(0)
    expect(calls).toContainEqual([
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--cwd",
      repo,
    ])
    expect(calls).toContainEqual([
      "env",
      "NODE_ENV=production",
      "SKIP_ENV_VALIDATION=true",
      `${repo}/node_modules/.bin/turbo`,
      "run",
      "build",
      "--filter=./packages/*",
      "--cwd",
      repo,
    ])
  })

  test("a run after one cut short past its fast-forward diffs from the commit the last finished update reached, and records the new one once its steps pass", async () => {
    const done = join(scratch, "fake-update-head")
    writeFileSync(done, "old\n")
    const { calls, run } = fakeRun({
      diff: { out: "bun.lock\npackages/db/src/index.ts\n" },
      "rev-parse": { out: "new\n" },
    })
    expect(await runUpdate(repo, run, async () => 0, quiet, undefined, done)).toBe(0)
    expect(calls).toContainEqual(["git", "-C", repo, "diff", "--name-only", "old", "HEAD"])
    expect(calls.some((argv) => argv.includes("install"))).toBe(true)
    expect(calls.some((argv) => argv.includes("build"))).toBe(true)
    expect(calls.find((argv) => argv.includes("--no-env-file"))?.slice(-2)).toEqual(["old", "HEAD"])
    expect(readFileSync(done, "utf8")).toBe("new\n")
  })

  test("a recorded commit the checkout lacks diffs from HEAD, and a failed step leaves the record as it was", async () => {
    const done = join(scratch, "fake-update-head-gone")
    writeFileSync(done, "gone\n")
    const { calls, run } = fakeRun({ "cat-file": { code: 128 }, "rev-parse": { out: "new\n" } })
    expect(await runUpdate(repo, run, async () => 0, quiet, undefined, done)).toBe(0)
    expect(calls).toContainEqual(["git", "-C", repo, "diff", "--name-only", "new", "HEAD"])
    writeFileSync(done, "old\n")
    const failed = fakeRun({ "rev-parse": { out: "new\n" }, "--no-env-file": { code: 1 } })
    expect(await runUpdate(repo, failed.run, async () => 0, quiet, undefined, done)).toBe(1)
    expect(readFileSync(done, "utf8")).toBe("old\n")
  })

  test("a merge that is not a fast-forward stops the update, names the step, and rolls nothing", async () => {
    const { calls, run } = fakeRun({ merge: { code: 128 } })
    const said: string[] = []
    let rolled = false
    const code = await runUpdate(
      repo,
      run,
      async () => ((rolled = true), 0),
      (l) => said.push(l),
    )
    expect(code).toBe(1)
    expect(rolled).toBe(false)
    expect(calls.at(-1)).toContain("merge")
    expect(said.at(-1)).toContain("merge")
  })

  test("--to fetches the tags, checks the checkout has no commits of its own, moves main to the tag, and rolls nothing", async () => {
    const { calls, run } = fakeRun({ "rev-parse": { out: "old\n" } })
    const said: string[] = []
    let rolled = false
    const code = await runUpdate(
      repo,
      run,
      async () => ((rolled = true), 0),
      (l) => said.push(l),
      "v0.0.20",
    )
    expect(code).toBe(0)
    expect(rolled).toBe(false)
    expect(calls.slice(1, 7)).toEqual([
      ["git", "-C", repo, "fetch", "-q", "--tags", "origin", "main"],
      ["git", "-C", repo, "merge-base", "--is-ancestor", "HEAD", "origin/main"],
      ["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"],
      ["git", "-C", repo, "ls-tree", "-r", "--name-only", "refs/tags/v0.0.20"],
      [
        "git",
        "-C",
        repo,
        "diff",
        "-z",
        "--name-status",
        "--no-renames",
        "HEAD",
        "refs/tags/v0.0.20",
      ],
      ["git", "-C", repo, "checkout", "-q", "-B", "main", "refs/tags/v0.0.20"],
    ])
    expect(said.at(-1)).toStartWith("playground update: at v0.0.20; the Dashboard rolls on its own")
  })

  test("--to on a checkout with commits of its own stops before it moves anything", async () => {
    const { calls, run } = fakeRun({ "merge-base": { code: 1 } })
    expect(await runUpdate(repo, run, async () => 0, quiet, "v0.0.20")).toBe(1)
    expect(calls.some((argv) => argv.includes("checkout"))).toBe(false)
  })

  // a target whose settings package declares x, which nothing in /repo links
  const declares = {
    "ls-tree": { out: "package.json\npackages/settings/package.json\n" },
    show: { out: JSON.stringify({ dependencies: { x: "^1" }, workspaces: ["packages/*"] }) },
  }

  test("a target that declares an unlinked dependency checks out its changed manifests and installs before the merge", async () => {
    const { calls, run } = fakeRun({
      ...declares,
      "--name-status": {
        out: "M\tbun.lock\nM\tpackages/settings/package.json\nM\tpackages/settings/src/a.ts\n",
      },
    })
    expect(await runUpdate(repo, run, async () => 0, quiet)).toBe(0)
    const at = (argv: string[]) => calls.findIndex((call) => call.join(" ") === argv.join(" "))
    const checkout = at([
      "git",
      "-C",
      repo,
      "checkout",
      "origin/main",
      "--",
      "bun.lock",
      "packages/settings/package.json",
    ])
    const install = at([
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--cwd",
      repo,
    ])
    const merge = at(["git", "-C", repo, "merge", "--ff-only", "-q", "origin/main"])
    expect(checkout).toBeGreaterThan(-1)
    expect([checkout < install, install < merge]).toEqual([true, true])
  })

  test("a target that deletes a file that is not a manifest still installs before the merge", async () => {
    const { calls, run } = fakeRun({
      ...declares,
      "--name-status": { out: "D\tdocs/old.md\nM\tpackages/settings/package.json\n" },
    })
    expect(await runUpdate(repo, run, async () => 0, quiet)).toBe(0)
    const install = calls.findIndex((argv) => argv[1] === "install")
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(calls.findIndex((argv) => argv.includes("merge")))
  })

  test("a link already missing on a hop that changes no manifest installs before the merge and checks out nothing", async () => {
    const { calls, run } = fakeRun({
      ...declares,
      "--name-status": { out: "M\tpackages/settings/src/a.ts\n" },
    })
    expect(await runUpdate(repo, run, async () => 0, quiet)).toBe(0)
    expect(calls.some((argv) => argv.includes("checkout"))).toBe(false)
    const install = calls.findIndex((argv) => argv[1] === "install")
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(calls.findIndex((argv) => argv.includes("merge")))
  })

  test("a tree with edits or untracked files of its own merges first as before, leaving them to the fast-forward", async () => {
    const { calls, run } = fakeRun({ "--porcelain": { out: "?? notes.md\n" }, ...declares })
    expect(await runUpdate(repo, run, async () => 0, quiet)).toBe(0)
    expect(calls.some((argv) => argv.includes("ls-tree") || argv[1] === "install")).toBe(false)
  })

  test("a target that deletes a manifest merges first as before, since the old code may still read it", async () => {
    const { calls, run } = fakeRun({
      ...declares,
      "--name-status": { out: "D\tpackages/old/package.json\nM\tbun.lock\n" },
    })
    expect(await runUpdate(repo, run, async () => 0, quiet)).toBe(0)
    expect(calls.some((argv) => argv.includes("--") || argv.includes("install"))).toBe(false)
  })

  test("a failed install before the merge puts the old manifests back and moves first, installing after, as before", async () => {
    const said: string[] = []
    const fake = fakeRun({
      ...declares,
      "--name-status": { out: "M\tpackages/settings/package.json\n" },
    })
    // the first install, before the move, fails as one needing a patch file the prelink did not stage does; the one after the move passes
    let installs = 0
    const run: Run = async (argv, show) =>
      argv[1] === "install" && ++installs === 1 ? { code: 1, out: "" } : fake.run(argv, show)
    expect(
      await runUpdate(
        repo,
        run,
        async () => 0,
        (l) => said.push(l),
      ),
    ).toBe(0)
    const at = (word: string) => fake.calls.findIndex((argv) => argv.includes(word))
    expect(fake.calls[at("restore")]).toEqual([
      "git",
      "-C",
      repo,
      "restore",
      "-q",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      "packages/settings/package.json",
    ])
    expect(at("restore")).toBeLessThan(at("merge"))
    expect(said).toContain(
      "playground update: the install before the move failed, so the checkout's files go back as they were and it moves first, installing after, as before",
    )
  })

  test("the roll's own code is the update's", async () => {
    const { run } = fakeRun()
    expect(await runUpdate(repo, run, async () => 3, quiet)).toBe(3)
  })

  // #2644: the roll only waits on the supervisor, whose own clone queues in run-slot, so an update run through run-slot gives its lane back first, and the queue behind it moves while the roll waits
  describe("under run-slot (RUN_SLOT_HELD)", () => {
    const slot = join(scratch, "ops", "run-slot")
    const hold = (pid: number) => {
      mkdirSync(slot, { recursive: true })
      writeFileSync(`${slot}.holder`, `ops-ship ${pid} 2026-11-17T12:00:00Z 2 medium\n`)
      writeFileSync(`${slot}.child`, "4243\n")
    }
    const update = async (roll: () => Promise<number>, said: string[] = [], to?: string) => {
      const was = process.env.RUN_SLOT_HELD
      process.env.RUN_SLOT_HELD = `${slot} 4242`
      try {
        const { run } = fakeRun({ "rev-parse": { out: "old\n" } })
        return await runUpdate(repo, run, roll, (line) => said.push(line), to)
      } finally {
        if (was === undefined) delete process.env.RUN_SLOT_HELD
        else process.env.RUN_SLOT_HELD = was
      }
    }

    test("the lane is given back before the roll starts", async () => {
      hold(4242)
      const said: string[] = []
      let held: boolean | undefined
      expect(
        await update(
          async () => ((held = existsSync(slot) || existsSync(`${slot}.holder`)), 0),
          said,
        ),
      ).toBe(0)
      expect(held).toBe(false)
      expect(existsSync(`${slot}.child`)).toBe(false)
      expect(said).toContain(
        "playground update: gave its run slot back for the Dashboard roll, whose own steps queue in run-slot",
      )
    })

    test("a lane another run has taken since stays that run's", async () => {
      hold(9999)
      let held: boolean | undefined
      await update(async () => ((held = existsSync(slot)), 0))
      expect(held).toBe(true)
      expect(readFileSync(`${slot}.holder`, "utf8")).toStartWith("ops-ship 9999 ")
      rmSync(slot, { force: true, recursive: true })
    })

    test("--to rolls nothing, so it keeps its lane to the end", async () => {
      hold(4242)
      await update(async () => 0, [], "v1.0.0")
      expect(existsSync(slot)).toBe(true)
      rmSync(slot, { force: true, recursive: true })
    })
  })
})

test("runUpdate fast-forwards a real checkout onto origin/main and runs its own link-skills and ops-restart", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
  const origin = join(scratch, "origin")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const marks = join(scratch, "marks")
  write(join(origin, "scripts", "link-skills.sh"), `echo linked >> ${marks}\n`)
  write(
    join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"),
    `require("node:fs").appendFileSync(${JSON.stringify(marks)}, "restart " + process.argv.slice(3).join(" ") + "\\n")\n`,
  )
  git(scratch, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(scratch, "checkout")
  git(scratch, "clone", "-q", origin, checkout)
  write(join(origin, "README.md"), "two\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  const head = git(origin, "rev-parse", "HEAD").stdout.toString().trim()
  const old = git(checkout, "rev-parse", "HEAD").stdout.toString().trim()

  expect(
    await runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      () => {},
    ),
  ).toBe(0)
  expect(git(checkout, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
  expect(readFileSync(marks, "utf8")).toBe(`linked\nrestart ${old} HEAD\n`)
})

// On 6 Nov a guard's Bash call was refused with no-raw-delete.js throwing "Unexpected end of script" in the same second the main checkout's fast-forward rewrote 22 bundles: git unlinks a changed file and writes it again, so a guard that starts in between loads a missing or half-written bundle.
test("a real update swaps each changed hook bundle in whole, so a reader of it mid-update finds the old file or the new one, never a missing or half-written one", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
  const root = join(scratch, "torn")
  const origin = join(root, "origin")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const bundle = join("scripts", "hooks", "bundled", "no-raw-delete.js")
  const before = `${"// a\n".repeat(6_000_000)}export {}\n`
  const after = `${"// bb\n".repeat(6_000_000)}export {}\n`
  write(join(origin, "scripts", "link-skills.sh"), "true\n")
  write(join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"), "\n")
  write(join(origin, bundle), before)
  git(root, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(root, "checkout")
  git(root, "clone", "-q", origin, checkout)
  write(join(origin, bundle), after)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  const stopWatch = await watchTorn(join(checkout, bundle), [before.length, after.length], root)
  expect(
    await runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      () => {},
    ),
  ).toBe(0)
  const { reads, torn } = await stopWatch()
  expect(reads).toBeGreaterThan(0)
  expect({ torn }).toEqual({ torn: 0 })
  expect(readFileSync(join(checkout, bundle), "utf8") === after).toBe(true)
  expect(git(checkout, "status", "--porcelain").stdout.toString()).toBe("")
})

test("a real update whose move fails after its bundles swapped in puts HEAD's bundles back, a bundle HEAD lacks removed, and stops", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
  const root = join(scratch, "unswap")
  const origin = join(root, "origin")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const bundled = join("scripts", "hooks", "bundled")
  write(join(origin, "scripts", "link-skills.sh"), "true\n")
  write(join(origin, bundled, "no-raw-delete.js"), "export const old = 1\n")
  git(root, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(root, "checkout")
  git(root, "clone", "-q", origin, checkout)
  write(join(origin, bundled, "no-raw-delete.js"), "export const changed = 2\n")
  write(join(origin, bundled, "no-new.js"), "export const added = 3\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  const head = git(checkout, "rev-parse", "HEAD").stdout.toString().trim()
  const failMerge: Run = async (argv, show) =>
    argv.includes("merge") && argv.includes("--ff-only")
      ? { code: 1, out: "merge refused" }
      : spawnRun(argv, show)
  const lines: string[] = []
  expect(
    await runUpdate(
      checkout,
      failMerge,
      async () => 0,
      (line) => lines.push(line),
    ),
  ).toBe(1)
  expect(git(checkout, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
  expect(readFileSync(join(checkout, bundled, "no-raw-delete.js"), "utf8")).toBe(
    "export const old = 1\n",
  )
  expect(existsSync(join(checkout, bundled, "no-new.js"))).toBe(false)
  expect(git(checkout, "status", "--porcelain").stdout.toString()).toBe("")
  expect(lines.at(-1)).toContain("merge --ff-only origin/main, or move to main there failed")
})

// A swap that stopped before its git add once left a bundle the target adds untracked, which git restore refused and the next fast-forward stopped on ("would be overwritten"), so every later update stuck.
test("a real update whose swap fails at its git add leaves the checkout at HEAD, a bundle the target adds removed, and the next update moves it", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
  const root = join(scratch, "swap-fails")
  const origin = join(root, "origin")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const bundled = join("scripts", "hooks", "bundled")
  write(join(origin, "scripts", "link-skills.sh"), "true\n")
  write(join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"), "\n")
  write(join(origin, bundled, "no-raw-delete.js"), "export const old = 1\n")
  git(root, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(root, "checkout")
  git(root, "clone", "-q", origin, checkout)
  write(join(origin, bundled, "no-raw-delete.js"), "export const changed = 2\n")
  write(join(origin, bundled, "no-new.js"), "export const added = 3\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  const head = git(checkout, "rev-parse", "HEAD").stdout.toString().trim()
  const failAdd: Run = async (argv, show) =>
    argv.includes("add") ? { code: 1, out: "index.lock exists" } : spawnRun(argv, show)
  const lines: string[] = []
  expect(
    await runUpdate(
      checkout,
      failAdd,
      async () => 0,
      (line) => lines.push(line),
    ),
  ).toBe(1)
  expect(git(checkout, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
  expect(readFileSync(join(checkout, bundled, "no-raw-delete.js"), "utf8")).toBe(
    "export const old = 1\n",
  )
  expect(existsSync(join(checkout, bundled, "no-new.js"))).toBe(false)
  expect(git(checkout, "status", "--porcelain").stdout.toString()).toBe("")
  expect(lines.at(-1)).toContain("swap in the new commit's hook bundles failed")
  expect(
    await runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      () => {},
    ),
  ).toBe(0)
  expect(readFileSync(join(checkout, bundled, "no-new.js"), "utf8")).toBe(
    "export const added = 3\n",
  )
})

test("a real update cut short after its fast-forward is finished by the next run, which restarts from the commit the last finished update reached", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
      .stdout.toString()
      .trim()
  const origin = join(scratch, "rerun-origin")
  const marks = join(scratch, "rerun-marks")
  const cut = join(scratch, "rerun-cut")
  const done = join(scratch, "rerun-update-head")
  mkdirSync(join(origin, "scripts"), { recursive: true })
  mkdirSync(join(origin, "packages", "scripts", "src", "ops-restart"), { recursive: true })
  writeFileSync(join(origin, "scripts", "link-skills.sh"), "true\n")
  // an ops-restart that fails while the cut file exists, standing in for an update cut short after its fast-forward
  writeFileSync(
    join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"),
    `const fs = require("node:fs"); if (fs.existsSync(${JSON.stringify(cut)})) process.exit(1); fs.appendFileSync(${JSON.stringify(marks)}, "restart " + process.argv.slice(3).join(" ") + "\\n")\n`,
  )
  git(scratch, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(scratch, "rerun-checkout")
  git(scratch, "clone", "-q", origin, checkout)
  const one = git(checkout, "rev-parse", "HEAD")
  const update = () =>
    runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      () => {},
      undefined,
      done,
    )

  expect(await update()).toBe(0)
  writeFileSync(join(origin, "README.md"), "two\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  const two = git(origin, "rev-parse", "HEAD")
  writeFileSync(cut, "")
  expect(await update()).toBe(1)
  expect(git(checkout, "rev-parse", "HEAD")).toBe(two)
  rmSync(cut)
  expect(await update()).toBe(0)
  expect(readFileSync(marks, "utf8")).toBe(`restart ${one} HEAD\nrestart ${one} HEAD\n`)
  expect(readFileSync(done, "utf8").trim()).toBe(two)
})

test("runUpdate --to moves a real checkout's main back to a tag, and a plain update moves it on again", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
      .stdout.toString()
      .trim()
  const origin = join(scratch, "to-origin")
  mkdirSync(join(origin, "scripts"), { recursive: true })
  mkdirSync(join(origin, "packages", "scripts", "src", "ops-restart"), { recursive: true })
  writeFileSync(join(origin, "scripts", "link-skills.sh"), "true\n")
  writeFileSync(join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"), "\n")
  git(scratch, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  git(origin, "tag", "v0.0.1")
  const one = git(origin, "rev-parse", "HEAD")
  writeFileSync(join(origin, "README.md"), "two\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  const two = git(origin, "rev-parse", "HEAD")
  const checkout = join(scratch, "to-checkout")
  git(scratch, "clone", "-q", origin, checkout)

  expect(
    await runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      () => {},
      "v0.0.1",
    ),
  ).toBe(0)
  expect([git(checkout, "rev-parse", "HEAD"), git(checkout, "branch", "--show-current")]).toEqual([
    one,
    "main",
  ])
  expect(
    await runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      () => {},
    ),
  ).toBe(0)
  expect(git(checkout, "rev-parse", "HEAD")).toBe(two)
})

describe("runUpdate on a checkout left on another branch", () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
      .stdout.toString()
      .trim()
  // an origin whose main moved on after the clone, and a checkout on canary with a commit main lacks
  const setup = (name: string) => {
    const origin = join(scratch, `${name}-origin`)
    mkdirSync(join(origin, "scripts"), { recursive: true })
    mkdirSync(join(origin, "packages", "scripts", "src", "ops-restart"), { recursive: true })
    writeFileSync(join(origin, "scripts", "link-skills.sh"), "true\n")
    writeFileSync(join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"), "\n")
    writeFileSync(join(origin, "README.md"), "one\n")
    git(scratch, "init", "-q", "-b", "main", origin)
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "one")
    const checkout = join(scratch, `${name}-checkout`)
    git(scratch, "clone", "-q", origin, checkout)
    git(checkout, "checkout", "-q", "-b", "canary")
    writeFileSync(join(checkout, "canary.txt"), "canary\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "-q", "-m", "canary")
    writeFileSync(join(origin, "README.md"), "two\n")
    git(origin, "commit", "-q", "-am", "two")
    return { checkout, main: git(origin, "rev-parse", "HEAD") }
  }

  test("a clean one moves to main at origin/main and says so", async () => {
    const { checkout, main } = setup("canary-clean")
    const said: string[] = []
    expect(
      await runUpdate(
        checkout,
        spawnRun,
        async () => 0,
        (l) => said.push(l),
      ),
    ).toBe(0)
    expect([git(checkout, "branch", "--show-current"), git(checkout, "rev-parse", "HEAD")]).toEqual(
      ["main", main],
    )
    expect(said).toContain(
      "playground update: on canary, not main, so moving to main at origin/main",
    )
  })

  test("one with uncommitted changes is refused and left as it was", async () => {
    const { checkout } = setup("canary-dirty")
    writeFileSync(join(checkout, "README.md"), "mine\n")
    const head = git(checkout, "rev-parse", "HEAD")
    expect(
      await runUpdate(
        checkout,
        spawnRun,
        async () => 0,
        () => {},
      ),
    ).toBe(1)
    expect([git(checkout, "branch", "--show-current"), git(checkout, "rev-parse", "HEAD")]).toEqual(
      ["canary", head],
    )
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("mine\n")
  })
})

test("a run cut short after its fast-forward with no record yet is finished by the next run, which restarts from where the first one started", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
      .stdout.toString()
      .trim()
  const origin = join(scratch, "first-origin")
  const marks = join(scratch, "first-marks")
  const cut = join(scratch, "first-cut")
  const done = join(scratch, "first-update-head")
  mkdirSync(join(origin, "scripts"), { recursive: true })
  mkdirSync(join(origin, "packages", "scripts", "src", "ops-restart"), { recursive: true })
  writeFileSync(join(origin, "scripts", "link-skills.sh"), "true\n")
  writeFileSync(
    join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"),
    `const fs = require("node:fs"); if (fs.existsSync(${JSON.stringify(cut)})) process.exit(1); fs.appendFileSync(${JSON.stringify(marks)}, "restart " + process.argv.slice(3).join(" ") + "\\n")\n`,
  )
  git(scratch, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(scratch, "first-checkout")
  git(scratch, "clone", "-q", origin, checkout)
  const one = git(checkout, "rev-parse", "HEAD")
  const lines: string[] = []
  const update = () =>
    runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      (line) => lines.push(line),
      undefined,
      done,
    )
  writeFileSync(join(origin, "README.md"), "two\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  writeFileSync(cut, "")
  expect(await update()).toBe(1)
  expect(lines).toContain(
    `playground update: no ${done} yet and no fast-forward onto origin/main in the reflog, so it reads what changed since HEAD, ${one.slice(0, 7)}`,
  )
  rmSync(cut)
  expect(await update()).toBe(0)
  expect(readFileSync(marks, "utf8")).toBe(`restart ${one} HEAD\n`)
})

test("with no record, a checkout reset past its last fast-forward reads what changed since that fast-forward, and says so", async () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
      .stdout.toString()
      .trim()
  const origin = join(scratch, "reset-origin")
  const marks = join(scratch, "reset-marks")
  const done = join(scratch, "reset-update-head")
  mkdirSync(join(origin, "scripts"), { recursive: true })
  mkdirSync(join(origin, "packages", "scripts", "src", "ops-restart"), { recursive: true })
  writeFileSync(join(origin, "scripts", "link-skills.sh"), "true\n")
  writeFileSync(
    join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"),
    `require("node:fs").appendFileSync(${JSON.stringify(marks)}, "restart " + process.argv.slice(3).join(" ") + "\\n")\n`,
  )
  git(scratch, "init", "-q", "-b", "main", origin)
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "one")
  const checkout = join(scratch, "reset-checkout")
  git(scratch, "clone", "-q", origin, checkout)
  writeFileSync(join(origin, "README.md"), "two\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "two")
  git(checkout, "fetch", "-q", "origin", "main")
  git(checkout, "merge", "--ff-only", "-q", "origin/main")
  const two = git(checkout, "rev-parse", "HEAD")
  writeFileSync(join(origin, "README.md"), "three\n")
  git(origin, "commit", "-q", "-am", "three")
  git(checkout, "fetch", "-q", "origin", "main")
  git(checkout, "reset", "-q", "--keep", "origin/main")
  const lines: string[] = []

  expect(
    await runUpdate(
      checkout,
      spawnRun,
      async () => 0,
      (line) => lines.push(line),
      undefined,
      done,
    ),
  ).toBe(0)
  expect(readFileSync(marks, "utf8")).toBe(`restart ${two} HEAD\n`)
  expect(lines).toContain(
    `playground update: no ${done} yet, so it reads what changed since the reflog's last fast-forward onto origin/main, ${two.slice(0, 7)}`,
  )
  expect(readFileSync(done, "utf8").trim()).toBe(git(checkout, "rev-parse", "HEAD"))
})

// the hooks read the checkout's code as soon as it moves, so a commit whose code imports a workspace dependency this checkout has not linked gets that install before any of its code lands
describe("runUpdate onto a commit that declares a dependency the checkout has not linked", () => {
  const env = { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH }
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
      .stdout.toString()
      .trim()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const FOLDER = join("packages", "settings", "src", "folder.ts")
  const LINK = join(
    "packages",
    "settings",
    "node_modules",
    "@packages",
    "safe-delete",
    "package.json",
  )
  // an origin whose second commit makes settings import safe-delete, and a checkout of its first with every declared dependency linked
  const setup = (name: string) => {
    const origin = join(scratch, `${name}-origin`)
    write(join(origin, "scripts", "link-skills.sh"), "true\n")
    write(join(origin, "packages", "scripts", "src", "ops-restart", "cli.ts"), "\n")
    write(join(origin, ".gitignore"), "node_modules\n")
    write(join(origin, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
    write(join(origin, "bun.lock"), "one\n")
    write(join(origin, "packages", "safe-delete", "package.json"), "{}")
    write(
      join(origin, "packages", "settings", "package.json"),
      JSON.stringify({ dependencies: {} }),
    )
    write(join(origin, FOLDER), "export const one = 1\n")
    git(scratch, "init", "-q", "-b", "main", origin)
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "one")
    const checkout = join(scratch, `${name}-checkout`)
    git(scratch, "clone", "-q", origin, checkout)
    write(join(origin, "bun.lock"), "two\n")
    write(
      join(origin, "packages", "settings", "package.json"),
      JSON.stringify({ dependencies: { "@packages/safe-delete": "workspace:*" } }),
    )
    write(join(origin, FOLDER), 'import "@packages/safe-delete"\n')
    git(origin, "add", ".")
    git(origin, "commit", "-q", "-m", "two")
    git(origin, "tag", "v0.0.2")
    return { checkout, two: git(origin, "rev-parse", "HEAD") }
  }

  test.each([
    ["a plain update", undefined, "prelink"],
    ["--to", "v0.0.2", "prelink-to"],
    ["a plain update on a checkout left on canary", undefined, "prelink-canary"],
  ])(
    "%s links it before the commit's code lands, from the commit's own manifests",
    async (_, to, name) => {
      const { checkout, two } = setup(name)
      if (name === "prelink-canary") git(checkout, "checkout", "-q", "-b", "canary")
      // what a hook would read at each install: the code it loads and the manifest that declares its imports
      const seen: string[] = []
      // the install and the build stand in for bun's and turbo's, which the scratch checkout lacks
      const run: Run = async (argv, show) => {
        if (argv.includes("build")) return { code: 0, out: "" }
        if (argv[1] !== "install") return spawnRun(argv, show)
        seen.push(
          `${readFileSync(join(checkout, FOLDER), "utf8").trim()} | ${readFileSync(join(checkout, "bun.lock"), "utf8").trim()}`,
        )
        write(join(checkout, LINK), "{}")
        return { code: 0, out: "" }
      }
      const lines: string[] = []
      expect(
        await runUpdate(
          checkout,
          run,
          async () => 0,
          (l) => lines.push(l),
          to,
        ),
      ).toBe(0)
      expect([
        git(checkout, "rev-parse", "HEAD"),
        git(checkout, "branch", "--show-current"),
      ]).toEqual([two, "main"])
      expect(seen[0]).toBe("export const one = 1 | two")
      expect(lines).toContain(
        "playground update: install the new commit's dependencies before its code, since it declares packages/settings: @packages/safe-delete, which this checkout has not linked",
      )
      expect(git(checkout, "status", "--short")).toBe("")
    },
  )

  test("a target that moves a package moves first as before, never staging its new manifest beside the old", async () => {
    const { checkout } = setup("prelink-mv")
    const origin = join(scratch, "prelink-mv-origin")
    // the checkout at the second commit, its link still missing, so the move below is a rename git pairs whole
    git(checkout, "fetch", "-q", "origin", "main")
    git(checkout, "merge", "--ff-only", "-q", "origin/main")
    git(origin, "mv", join("packages", "settings"), join("packages", "prefs"))
    git(origin, "commit", "-q", "-m", "three")
    const three = git(origin, "rev-parse", "HEAD")
    // bun refuses a workspace whose name two package.json files claim, as the old and the moved one would
    const run: Run = async (argv, show) => {
      if (argv.includes("build")) return { code: 0, out: "" }
      if (argv[1] !== "install") return spawnRun(argv, show)
      const both = ["settings", "prefs"].every((name) =>
        existsSync(join(checkout, "packages", name, "package.json")),
      )
      return { code: both ? 1 : 0, out: "" }
    }
    expect(
      await runUpdate(
        checkout,
        run,
        async () => 0,
        () => {},
      ),
    ).toBe(0)
    expect(git(checkout, "rev-parse", "HEAD")).toBe(three)
    expect(git(checkout, "status", "--short")).toBe("")
  })
})
