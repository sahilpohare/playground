import { describe, expect, test } from "bun:test"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BUNDLED,
  bundle,
  entries,
  FIX,
  HOOKS,
  ROOT,
  stale,
  treeAt,
} from "../../../../packages/scripts/src/hooks-bundle"

test("every bundle in scripts/hooks/bundled is what a fresh build of its source writes", async () => {
  const drift = await stale(ROOT)
  expect(drift, `stale: ${drift.join(", ")}; ${FIX}`).toEqual([])
})

test("scripts/hooks/bundled holds one bundle per PreToolUse guard and per worker, and nothing else", async () => {
  const names = (await entries(ROOT)).map((name) => `${name}.js`).sort()
  expect(readdirSync(join(ROOT, BUNDLED)).sort()).toEqual(names)
})

// A guard that imports another guard keeps that guard's main block live when both are entry points of one build, and the imported block then reads stdin first and judges the call by its own rules.
test("each guard bundle runs one main block, its own, and the worker bundle none", async () => {
  for (const name of await entries(ROOT)) {
    const text = readFileSync(join(ROOT, BUNDLED, `${name}.js`), "utf8")
    const blocks = text.match(/\bif \(import\.meta\.main\)/g)?.length ?? 0
    expect({ blocks, name }).toEqual({ blocks: name.endsWith("-worker") ? 0 : 1, name })
  }
})

// Each call goes in as stdin to the bundle as its wrapper runs it and to its source, which judge it as data; the forms are this test's own, none from the refused-forms fixture.
describe("a bundle run as its wrapper runs it gives its source's verdict", () => {
  const worktree = join(ROOT, ".claude", "worktrees", "a")
  const call = (cwd: string, command: string) =>
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    })
  test.each([
    [
      "guards",
      "an ours merge",
      call(ROOT, "git merge -s ours origin/canary"),
      2,
      "no-ours-merge hook refuses",
    ],
    ["guards", "a plain call", call(ROOT, "true"), 0, ""],
    [
      "guards",
      "a worktree's suite with no slot",
      call(worktree, `bun run --cwd ${worktree} test`),
      2,
      "no-unslotted-run hook refuses",
    ],
  ])("%s on %s", async (name, _, raw, code, says) => {
    for (const file of [join(BUNDLED, `${name}.js`), join(HOOKS, `${name}.ts`)]) {
      const proc = Bun.spawn(["bun", "--no-env-file", file], {
        cwd: ROOT,
        env: { ...process.env, PLAYGROUND_REPO: "", PLAYGROUND_ROLE: "worker" },
        stderr: "pipe",
        stdin: new Blob([raw]),
        stdout: "pipe",
      })
      const exit = await proc.exited
      const stderr = await new Response(proc.stderr).text()
      expect({ code: exit, file, refusal: stderr.includes(says) }).toEqual({
        code,
        file,
        refusal: true,
      })
      if (!says) expect(stderr).toBe("")
    }
  })
})

// A main checkout made in a scratch folder outside any repo, as the factory's sits, holding the bundle: with PLAYGROUND_REPO unset, as cmux restores a session, the bundle finds that checkout from its own folder, as the source does from its own, so an ask note there runs and the same note from another folder is refused.
test("no-desktop-owner-app, run by guards' bundle, finds the main checkout it sits in, with PLAYGROUND_REPO unset", async () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "hooks-bundle-main-")))
  expect(Bun.spawnSync(["git", "-C", main, "init", "-q"]).exitCode).toBe(0)
  mkdirSync(join(main, BUNDLED), { recursive: true })
  mkdirSync(join(main, "api", "hono", "src", "bin"), { recursive: true })
  mkdirSync(join(main, "elsewhere"))
  writeFileSync(join(main, "scripts", "spawn.sh"), "#!/bin/sh\n")
  writeFileSync(join(main, "api", "hono", "src", "bin", "dashboard-ask.ts"), "")
  writeFileSync(
    join(main, "package.json"),
    `${JSON.stringify({ scripts: { ask: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.ask } })}\n`,
  )
  for (const name of ["guards", "no-extensions-write-worker"])
    copyFileSync(join(ROOT, BUNDLED, `${name}.js`), join(main, BUNDLED, `${name}.js`))
  const note = (cwd: string) =>
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command: `bun run ask x "note; agent-desktop 1.0 ok"` },
      tool_name: "Bash",
    })
  const run = async (cwd: string) => {
    const proc = Bun.spawn(["bun", "--no-env-file", join(main, BUNDLED, "guards.js")], {
      cwd: main,
      env: { ...process.env, PLAYGROUND_REPO: "", PLAYGROUND_ROLE: "worker" },
      stderr: "pipe",
      stdin: new Blob([note(cwd)]),
      stdout: "pipe",
    })
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
  }
  expect(await run(main)).toEqual({ code: 0, stderr: "" })
  const elsewhere = await run(join(main, "elsewhere"))
  expect(elsewhere.code).toBe(2)
  expect(elsewhere.stderr).toContain("no-desktop-owner-app")
})

// A bundle that imports only Bun's and Node's own modules reaches no node_modules, so a missing or damaged install cannot crash it.
test("every bundle imports nothing but Bun's and Node's own modules", () => {
  for (const file of readdirSync(join(ROOT, BUNDLED))) {
    const text = readFileSync(join(ROOT, BUNDLED, file), "utf8")
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...text.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]!)
    expect(
      specifiers.filter((s) => !isBuiltin(s) && !s.startsWith("bun:") && s !== "bun"),
      file,
    ).toEqual([])
  }
})

// Each bundle copied to a folder with no node_modules above it, as a damaged install leaves the checkout, starts and allows an empty call.
test("every bundled guard runs on {} with no node_modules reachable and exits 0", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hooks-bundle-")))
  const bundled = join(scratch, BUNDLED)
  mkdirSync(bundled, { recursive: true })
  for (const file of readdirSync(join(ROOT, BUNDLED)))
    copyFileSync(join(ROOT, BUNDLED, file), join(bundled, file))
  expect(() => Bun.resolveSync("zod", bundled)).toThrow()
  for (const name of await entries(ROOT)) {
    if (name.endsWith("-worker")) continue
    const proc = Bun.spawn(["bun", "--no-env-file", join(bundled, `${name}.js`)], {
      cwd: scratch,
      env: { ...process.env, PLAYGROUND_ROLE: "" },
      stderr: "pipe",
      stdin: new Blob(["{}"]),
      stdout: "pipe",
    })
    const code = await proc.exited
    expect({ code, name, stderr: await new Response(proc.stderr).text() }).toEqual({
      code: 0,
      name,
      stderr: "",
    })
  }
}, 60_000)

// A scratch checkout holding hooks-bundle's own source and one guard, so `bun run hooks:bundle` runs there as it does in the repo, its ROOT that checkout; a merge left uncommitted puts MERGE_HEAD in place, as a merge of canary that stops for its conflicts does.
describe("hooks:bundle during a merge (#673)", () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
  }
  const checkout = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hooks-bundle-merge-")))
    const git = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", "-C", root, ...args], { env })
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
    }
    for (const file of ["hooks-bundle.ts", "ops-tick/guard-probe.ts", "write-atomic.ts"]) {
      const to = join(root, "packages", "scripts", "src", file)
      mkdirSync(join(to, ".."), { recursive: true })
      copyFileSync(join(ROOT, "packages", "scripts", "src", file), to)
    }
    mkdirSync(join(root, HOOKS), { recursive: true })
    writeFileSync(
      join(root, "scripts", "factory-settings.json"),
      `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "bun scripts/hooks/bundled/a-guard.js" }] }] } })}\n`,
    )
    writeFileSync(join(root, HOOKS, "a-guard.ts"), 'console.log("a")\n')
    writeFileSync(join(root, HOOKS, "no-extensions-write-worker.ts"), "export {}\n")
    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "start")
    const merging = () => {
      git("checkout", "-q", "-b", "side")
      writeFileSync(join(root, "side.txt"), "side\n")
      git("add", "-A")
      git("commit", "-q", "--no-verify", "-m", "side")
      git("checkout", "-q", "main")
      git("merge", "-q", "--no-commit", "--no-ff", "side")
    }
    const run = (...args: string[]) => {
      const proc = Bun.spawnSync(
        [
          "bun",
          "--no-env-file",
          join(root, "packages", "scripts", "src", "hooks-bundle.ts"),
          ...args,
        ],
        { cwd: root, env },
      )
      return { code: proc.exitCode, stderr: proc.stderr.toString() }
    }
    const written = () => readdirSync(join(root, BUNDLED)).sort()
    return { git, merging, root, run, written }
  }

  test("with a merge in progress it exits non-zero, writes no file and names committing the merge first", () => {
    const { merging, root, run } = checkout()
    merging()
    const { code, stderr } = run()
    expect(code).toBe(1)
    expect(stderr).toContain("a merge is in progress")
    expect(stderr).toContain(
      "commit the merge first, taking canary's bundles in scripts/hooks/bundled as they are, then run `bun run hooks:bundle` again and commit the rebuild on its own",
    )
    expect(() => readdirSync(join(root, BUNDLED))).toThrow()
  })

  test("with no merge in progress it writes each bundle, as before", () => {
    const { run, written } = checkout()
    expect(run().code).toBe(0)
    expect(written()).toEqual(["a-guard.js", "no-extensions-write-worker.js"])
  })

  test("write mode removes a bundle no build writes, a removed guard's, so --check passes after it (#694)", () => {
    const { git, root, run, written } = checkout()
    expect(run().code).toBe(0)
    writeFileSync(join(root, BUNDLED, "gone-guard.js"), "old\n")
    git("add", "-A")
    expect(run("--check").stderr).toContain("gone-guard.js")
    expect(run().code).toBe(0)
    git("add", "-A")
    expect(written()).toEqual(["a-guard.js", "no-extensions-write-worker.js"])
    expect(run("--check")).toEqual({ code: 0, stderr: "" })
  })

  test("write mode leaves a file in the bundled folder that is no .js bundle, and a folder there (#694)", () => {
    const { root, run, written } = checkout()
    mkdirSync(join(root, BUNDLED, "kept.js"), { recursive: true })
    writeFileSync(join(root, BUNDLED, "notes.txt"), "kept\n")
    expect(run().code).toBe(0)
    expect(written()).toEqual([
      "a-guard.js",
      "kept.js",
      "no-extensions-write-worker.js",
      "notes.txt",
    ])
    expect(readFileSync(join(root, BUNDLED, "notes.txt"), "utf8")).toBe("kept\n")
  })

  test("--check runs during a merge as before: fresh bundles pass, a stale one is named", () => {
    const { git, merging, root, run } = checkout()
    expect(run().code).toBe(0)
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "bundles")
    merging()
    expect(run("--check")).toEqual({ code: 0, stderr: "" })
    writeFileSync(join(root, BUNDLED, "a-guard.js"), "stale\n")
    git("add", "-A")
    const stale = run("--check")
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain(`stale in ${BUNDLED}: a-guard.js`)
  })
})

// A scratch checkout whose guard imports a module beside it, its bundles committed, so `--check` can be read against the index (#1320) and against the head merged with another branch (#1365); every root is a mkdtemp folder.
describe("--check reads a tree git holds, never the working files", () => {
  const MID = `${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `export const m${n} = ${n}`).join("\n")}\n`
  const guard = (extra = "") =>
    `import { lib } from "./lib"\nimport { m1, m2, m3, m4, m5, m6, m7, m8 } from "./mid"\n\n${extra}console.log("a", lib, m1, m2, m3, m4, m5, m6, m7, m8)\n`
  const env = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
  }
  const checkout = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hooks-bundle-tree-")))
    const git = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", "-C", root, ...args], { env })
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
    }
    for (const file of ["hooks-bundle.ts", "ops-tick/guard-probe.ts", "write-atomic.ts"]) {
      const to = join(root, "packages", "scripts", "src", file)
      mkdirSync(join(to, ".."), { recursive: true })
      copyFileSync(join(ROOT, "packages", "scripts", "src", file), to)
    }
    mkdirSync(join(root, HOOKS), { recursive: true })
    writeFileSync(
      join(root, "scripts", "factory-settings.json"),
      `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "bun scripts/hooks/bundled/a-guard.js" }] }] } })}\n`,
    )
    const write = (name: string, text: string) => writeFileSync(join(root, HOOKS, name), text)
    // mid sits between lib and the guard in each bundle, so a change to lib's lines and one to the guard's merge apart
    write("a-guard.ts", guard())
    write("lib.ts", 'export const lib = "one"\n')
    write("mid.ts", MID)
    write("no-extensions-write-worker.ts", "export {}\n")
    writeFileSync(
      join(root, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { paths: { "@/*": ["./scripts/hooks/*"] } } })}\n`,
    )
    const run = (...args: string[]) => {
      const proc = Bun.spawnSync(
        [
          "bun",
          "--no-env-file",
          join(root, "packages", "scripts", "src", "hooks-bundle.ts"),
          ...args,
        ],
        { cwd: root, env },
      )
      return { code: proc.exitCode, stderr: proc.stderr.toString() }
    }
    git("init", "-q", "-b", "main")
    expect(run().code).toBe(0)
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "start")
    // a side's change, its bundles rebuilt and committed: canary's on a branch of that name, the head's on main
    const side = (branch: "canary" | "main", change: () => void) => {
      git("checkout", "-q", ...(branch === "canary" ? ["-b", "canary"] : ["main"]))
      change()
      expect(run().code).toBe(0)
      git("add", "-A")
      git("commit", "-q", "--no-verify", "-m", branch)
    }
    const mergeTree = () =>
      Bun.spawnSync(["git", "-C", root, "merge-tree", "--write-tree", "main", "canary"]).exitCode
    return { git, mergeTree, root, run, side, write }
  }

  test("an unstaged guard edit beside a staged file leaves the check green (#1320)", () => {
    const { git, root, run, write } = checkout()
    write("a-guard.ts", 'import { lib } from "./lib"\n\nconsole.log("b", lib)\n')
    writeFileSync(join(root, "README.md"), "docs\n")
    git("add", "README.md")
    expect(run("--check")).toEqual({ code: 0, stderr: "" })
  })

  test("a staged guard edit with no rebuild is refused, as before", () => {
    const { git, run, write } = checkout()
    write("a-guard.ts", 'import { lib } from "./lib"\n\nconsole.log("b", lib)\n')
    git("add", "-A")
    const stale = run("--check")
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain(`stale in ${BUNDLED}: a-guard.js`)
  })

  test("a staged guard edit whose rebuilt bundle is left unstaged is refused, since the commit carries the old bundle", () => {
    const { git, run, write } = checkout()
    write("a-guard.ts", 'import { lib } from "./lib"\n\nconsole.log("b", lib)\n')
    git("add", join(HOOKS, "a-guard.ts"))
    expect(run().code).toBe(0)
    const stale = run("--check")
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain(`stale in ${BUNDLED}: a-guard.js`)
  })

  // canary gives lib a top-level name and the head gives the guard the same one, each side rebuilt: git merges the two bundles cleanly, as it merged #1302's, while a build of the merged sources renames one of the two, so the merged bundle reads stale
  test("--merged reads the head merged with the ref, so canary's change to a bundle input stales a clean head (#1365)", () => {
    const { mergeTree, run, side, write } = checkout()
    side("canary", () =>
      write("lib.ts", 'const helper = (x: string) => `${x}!`\nexport const lib = helper("two")\n'),
    )
    side("main", () => write("a-guard.ts", guard("const helper = 3\nconsole.log(helper)\n")))
    expect(mergeTree()).toBe(0)
    expect(run("--check")).toEqual({ code: 0, stderr: "" })
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(1)
    expect(merged.stderr).toContain(`stale in ${BUNDLED}: a-guard.js`)
    expect(merged.stderr).toContain("merged with canary")
    expect(merged.stderr).toContain("run `bun run hooks:bundle`")
  })

  test("--merged reads a merge that conflicts in the bundles alone with its markers, which read stale", () => {
    const { git, mergeTree, root, run } = checkout()
    // each side ends the guard's bundle with a line of its own, its sources untouched
    const bundled = join(root, BUNDLED, "a-guard.js")
    const sides: [string[], string][] = [
      [["-b", "canary"], "canary"],
      [["main"], "head"],
    ]
    for (const [checkoutArgs, by] of sides) {
      git("checkout", "-q", ...checkoutArgs)
      writeFileSync(bundled, `${readFileSync(bundled, "utf8")}// ${by}\n`)
      git("add", "-A")
      git("commit", "-q", "--no-verify", "-m", by)
    }
    expect(mergeTree()).toBe(1)
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(1)
    expect(merged.stderr).toContain(`stale in ${BUNDLED}: a-guard.js once merged with canary`)
  })

  test("--merged with a ref the head already holds reads the head's own tree", () => {
    const { git, run } = checkout()
    git("branch", "canary")
    expect(run("--check", "--merged", "canary")).toEqual({ code: 0, stderr: "" })
  })

  test("--merged with a ref git cannot read fails, naming it", () => {
    const { run } = checkout()
    const merged = run("--check", "--merged", "no-such-ref")
    expect(merged.code).toBe(1)
    expect(merged.stderr).toContain("git merge-tree HEAD no-such-ref")
  })

  // canary adds a source the head's checkout lacks, reached by a tsconfig alias as packages/settings reaches its own, or by a relative path: the merged build reads it from the merged tree itself and passes, where the old on-disk build could not resolve it
  test.each([
    ["a tsconfig alias", "@/more"],
    ["a relative path", "./more"],
  ])(
    "--merged builds a merged source the head's checkout lacks, reached by %s, and passes",
    (_, specifier) => {
      const { root, run, side, write } = checkout()
      side("canary", () => {
        write(
          "lib.ts",
          `import { more } from "${specifier}"\n\nexport const lib = \`two \${more}\`\n`,
        )
        write("more.ts", 'export const more = "more"\n')
      })
      side("main", () => write("a-guard.ts", guard('console.log("head")\n')))
      expect(() => readFileSync(join(root, HOOKS, "more.ts"))).toThrow()
      const merged = run("--check", "--merged", "canary")
      expect(merged.code).toBe(0)
      expect(merged.stderr).toBe("")
    },
  )

  // canary adds a path mapping and an import that needs it, and the head's tsconfig predates it: the merged build resolves with the merged tree's own tsconfigs, so the check passes where the on-disk mapping could not resolve the import
  test("--merged resolves a mapping the merged tsconfig adds, which the head's on-disk one lacks", () => {
    const { git, root, run, side, write } = checkout()
    side("canary", () => {
      writeFileSync(
        join(root, "tsconfig.json"),
        `${JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./scripts/hooks/*"], "@cfg/*": ["./pkgs/cfg/*"] } },
        })}\n`,
      )
      mkdirSync(join(root, "pkgs", "cfg"), { recursive: true })
      writeFileSync(join(root, "pkgs", "cfg", "kinds.ts"), 'export const kind = "cfg"\n')
      write("lib.ts", 'import { kind } from "@cfg/kinds"\n\nexport const lib = `two ${kind}`\n')
    })
    git("checkout", "-q", "main")
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(0)
    expect(merged.stderr).toBe("")
  })

  test("--merged resolves a bare import a merged source reaches, from the checkout's node_modules", () => {
    const { git, root, run, side, write } = checkout()
    // a hand-made link, no install
    const link = () => {
      mkdirSync(join(root, "node_modules", "demo"), { recursive: true })
      writeFileSync(
        join(root, "node_modules", "demo", "package.json"),
        `${JSON.stringify({ name: "demo", main: "index.js" })}\n`,
      )
      writeFileSync(join(root, "node_modules", "demo", "index.js"), 'export const demo = "demo"\n')
    }
    link()
    side("canary", () => {
      // a source the head's checkout lacks, whose import is bare: only the tree holds it
      write("more.ts", 'import { demo } from "demo"\n\nexport const more = demo\n')
      write("lib.ts", 'import { more } from "./more"\n\nexport const lib = `two ${more}`\n')
    })
    git("checkout", "-q", "main")
    // the checkout drops canary's committed link, so the head's own is back before the read
    link()
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(0)
    expect(merged.stderr).toBe("")
  })

  test("--merged resolves a workspace package's own tsconfig the merged tree changes, reached by its bare name", () => {
    const { git, root, run, side, write } = checkout()
    // a made-up workspace package, linked as an install links one, whose own tsconfig only the merged tree's copy may rule the build
    const sd = join(root, "pkgs", "sd")
    mkdirSync(join(sd, "src"), { recursive: true })
    writeFileSync(join(sd, "package.json"), `${JSON.stringify({ name: "@w/sd" })}\n`)
    writeFileSync(
      join(sd, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { paths: { "@s/*": ["./src/*"] } } })}\n`,
    )
    writeFileSync(join(sd, "src", "kind.ts"), 'export const kind = "one"\n')
    writeFileSync(
      join(sd, "index.ts"),
      'import { kind } from "@s/kind"\n\nexport const sd = kind\n',
    )
    mkdirSync(join(root, "node_modules", "@w"), { recursive: true })
    symlinkSync(sd, join(root, "node_modules", "@w", "sd"))
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "sd")
    side("canary", () => {
      write("lib.ts", 'import { sd } from "@w/sd"\n\nexport const lib = `two ${sd}`\n')
      writeFileSync(
        join(sd, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { paths: { "@s/*": ["./src/*"], "@cfg/*": ["./src/cfg/*"] } } })}\n`,
      )
      writeFileSync(
        join(sd, "index.ts"),
        'import { kind } from "@cfg/kind"\n\nexport const sd = `cfg ${kind}`\n',
      )
      mkdirSync(join(sd, "src", "cfg"), { recursive: true })
      writeFileSync(join(sd, "src", "cfg", "kind.ts"), 'export const kind = "cfg"\n')
    })
    side("main", () => write("a-guard.ts", guard('console.log("head")\n')))
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(0)
    expect(merged.stderr).toBe("")
  })

  test("--merged reads a changed folder an unchanged importer reaches, by a relative path", () => {
    const { git, root, run, side, write } = checkout()
    const pkgs = join(root, "pkgs")
    mkdirSync(join(pkgs, "a"), { recursive: true })
    mkdirSync(join(pkgs, "b"), { recursive: true })
    writeFileSync(join(pkgs, "a", "a.ts"), 'import { b } from "../b/b"\n\nexport const a = b\n')
    writeFileSync(join(pkgs, "b", "b.ts"), 'export const b = "one"\n')
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "pkgs")
    side("canary", () => {
      write("lib.ts", 'import { a } from "../../pkgs/a/a"\n\nexport const lib = `two ${a}`\n')
      writeFileSync(join(pkgs, "b", "b.ts"), 'export const b = "two"\n')
    })
    side("main", () => write("a-guard.ts", guard('console.log("head")\n')))
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(0)
    expect(merged.stderr).toBe("")
  })

  test("--merged reads a changed folder an unchanged importer reaches, by a bare name", () => {
    const { git, root, run, side, write } = checkout()
    const pkgs = join(root, "pkgs")
    mkdirSync(join(pkgs, "a"), { recursive: true })
    mkdirSync(join(pkgs, "b"), { recursive: true })
    writeFileSync(join(pkgs, "a", "a.ts"), 'import { b } from "@w/b"\n\nexport const a = b\n')
    writeFileSync(
      join(pkgs, "b", "package.json"),
      `${JSON.stringify({ name: "@w/b", main: "./b.ts" })}\n`,
    )
    writeFileSync(join(pkgs, "b", "b.ts"), 'export const b = "one"\n')
    mkdirSync(join(root, "node_modules", "@w"), { recursive: true })
    symlinkSync(join(pkgs, "b"), join(root, "node_modules", "@w", "b"))
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "pkgs")
    side("canary", () => {
      write("lib.ts", 'import { a } from "../../pkgs/a/a"\n\nexport const lib = `two ${a}`\n')
      writeFileSync(join(pkgs, "b", "b.ts"), 'export const b = "two"\n')
    })
    side("main", () => write("a-guard.ts", guard('console.log("head")\n')))
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(0)
    expect(merged.stderr).toBe("")
  })

  test("--merged names a conflict outside the bundles and exits 0, since pr:merge's gate reports it", () => {
    const { git, run, write } = checkout()
    git("checkout", "-q", "-b", "canary")
    write("lib.ts", 'export const lib = "canary"\n')
    expect(run().code).toBe(0)
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "canary")
    git("checkout", "-q", "main")
    write("lib.ts", 'export const lib = "head"\n')
    expect(run().code).toBe(0)
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "head")
    const merged = run("--check", "--merged", "canary")
    expect(merged.code).toBe(0)
    expect(merged.stderr).toContain(`conflicts with canary outside ${BUNDLED}`)
    expect(merged.stderr).toContain(join(HOOKS, "lib.ts"))
  })

  // A tree file holding a leading UTF-8 BOM reads with the BOM git holds, so a BOM'd source is never read as a change it does not carry
  test("a tree file's leading UTF-8 BOM reads as git holds it", () => {
    const { git, root, write } = checkout()
    const text = '\uFEFFexport const lib = "one"\n'
    write("lib.ts", text)
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "bom")
    expect(treeAt(root, "HEAD").text(join(HOOKS, "lib.ts"))).toBe(text)
  })

  // cat-file names a blob the object store has lost as `<sha> missing` in its header, and the read says so instead of stopping silently
  test("a tree blob the object store has lost throws, naming the header", () => {
    const { root } = checkout()
    const sha = Bun.spawnSync(["git", "-C", root, "rev-parse", `HEAD:${join(HOOKS, "lib.ts")}`])
      .stdout.toString()
      .trim()
    expect(sha).toMatch(/^[0-9a-f]{40,64}$/)
    rmSync(join(root, ".git", "objects", sha.slice(0, 2), sha.slice(2)))
    expect(() => treeAt(root, "HEAD").text(join(HOOKS, "lib.ts"))).toThrow("missing")
  })

  // A source whose name is longer than the filesystem takes makes the mirror's write throw, and the mirror goes with it; the wait rides out a mirror another test's check holds up at the same moment
  test("a throw while the mirror is written leaves no temp folder behind", async () => {
    const { root } = checkout()
    const mirrors = () =>
      readdirSync(realpathSync(tmpdir())).filter((name) => name.startsWith("hooks-bundle-merged-"))
    const before = new Set(mirrors())
    const blob = Bun.spawnSync(["git", "-C", root, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode("export const big = 1\n"),
    })
      .stdout.toString()
      .trim()
    const oid = Bun.spawnSync(["git", "-C", root, "mktree"], {
      stdin: new TextEncoder().encode(`100644 blob ${blob}\t${"n".repeat(300)}.ts\n`),
    })
      .stdout.toString()
      .trim()
    expect(oid).toMatch(/^[0-9a-f]{40,64}$/)
    await expect(bundle(root, treeAt(root, oid))).rejects.toThrow()
    let extra = mirrors().filter((name) => !before.has(name))
    for (let tick = 0; tick < 100 && extra.length; tick++) {
      await Bun.sleep(50)
      extra = mirrors().filter((name) => !before.has(name))
    }
    expect(extra).toEqual([])
  })

  // A dangling entry in the checkout's own node_modules, one nothing imports, links through as it does at the base, where the entry's own read fails soft
  test("a dangling node_modules entry no import reaches leaves both checks green", () => {
    const { git, root, run } = checkout()
    mkdirSync(join(root, "node_modules", "@w"), { recursive: true })
    symlinkSync(
      join(root, "node_modules", "gone-package"),
      join(root, "node_modules", "@w", "gone"),
    )
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", "dangling")
    git("branch", "canary")
    expect(run("--check")).toEqual({ code: 0, stderr: "" })
    expect(run("--check", "--merged", "canary")).toEqual({ code: 0, stderr: "" })
  })
})
