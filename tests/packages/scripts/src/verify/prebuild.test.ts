import { expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import * as prebuild from "../../../../../packages/scripts/src/verify/prebuild"

const {
  importedNames,
  isMainCheckout,
  prebuildStep,
  reach,
  sourcesIn,
  staleInstall,
  testSpecifiers,
  unbuilt,
  workspaceImports,
} = prebuild

const ROOT = join(import.meta.dir, "../../../../..")

// A spawned bun's start alone has run past bun's 30s a test on a loaded Mac, so each prebuild a test spawns holds a deadline of its own that names it, and the test's timeout covers its spawns.
const SPAWN_MS = 60_000
const within = (spawns: number): number => spawns * SPAWN_MS + 10_000
const bounded = (
  name: string,
  argv: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
) => {
  const run = Bun.spawnSync(argv, { ...options, timeout: SPAWN_MS })
  if (run.exitedDueToTimeout)
    throw new Error(`${name} ran past ${SPAWN_MS / 1000}s: ${argv.join(" ")}`)
  return run
}

// A workspace package resolves through its built dist, which a fresh worktree lacks until something builds it.
test("bun run verify builds the workspace packages it imports before it runs, when they are unbuilt", async () => {
  const pkg = await Bun.file(join(ROOT, "package.json")).json()
  expect(pkg.scripts.verify).toBe(
    "bun packages/scripts/src/verify/prebuild.ts && bun packages/scripts/src/verify/cli.ts",
  )
})

// From a checkout whose dist predates an export, pr:merge --explain stopped on "Cannot find module '@packages/config/verdicts'".
test("bun run pr:merge and pr:train build the workspace packages pr-merge imports before they run, when they are unbuilt", async () => {
  const pkg = await Bun.file(join(ROOT, "package.json")).json()
  expect(pkg.scripts["pr:merge"]).toBe(
    "bun packages/scripts/src/verify/prebuild.ts pr-merge && bun --no-env-file packages/scripts/src/pr-merge/cli.ts",
  )
  expect(pkg.scripts["pr:train"]).toBe(
    "bun packages/scripts/src/verify/prebuild.ts pr-merge && bun --no-env-file packages/scripts/src/pr-merge/train-cli.ts",
  )
})

// The live dashboard's roll onto a new head once stopped on "Cannot find module '@packages/config/org'": the launcher loads the API before turbo builds. The running-stack check comes first, since the build cleans the dist a running stack imports, and neither loads .env, which the launcher does not load either.
test("bun run dev checks for a running stack, then builds the workspace packages the API imports when they are unbuilt, before the launcher runs", async () => {
  const pkg = await Bun.file(join(ROOT, "package.json")).json()
  expect(pkg.scripts.dev).toStartWith(
    "bun --no-env-file api/hono/src/bin/dev-running.ts start && bun --no-env-file packages/scripts/src/verify/prebuild.ts api && ",
  )
})

// A lead's `bun run ask` once stopped on "Export named 'ANSWER_LEAD' not found in packages/config/dist/inbox.mjs", from a worktree whose dist predated that export.
test("bun run ask and bun run thread build the workspace packages the API imports when they are unbuilt, before their entry runs", async () => {
  const pkg = await Bun.file(join(ROOT, "package.json")).json()
  expect(pkg.scripts.ask).toBe(
    "bun --no-env-file packages/scripts/src/verify/prebuild.ts api && bun api/hono/src/bin/dashboard-ask.ts",
  )
  expect(pkg.scripts.thread).toBe(
    "bun --no-env-file packages/scripts/src/verify/prebuild.ts api && bun api/hono/src/bin/dashboard-thread.ts",
  )
})

test(
  "prebuild given api reads the API's sources, and exits 0 once they are built",
  async () => {
    const imports = workspaceImports(await sourcesIn("api"))
    expect(imports).toContain("@packages/config/org")
    expect(imports).toContain("@packages/env/data-dir")
    const run = bounded(
      "prebuild api",
      ["bun", join(ROOT, "packages/scripts/src/verify/prebuild.ts"), "api"],
      {
        cwd: ROOT,
      },
    )
    expect(run.exitCode).toBe(0)
  },
  within(1),
)

test("every workspace package the API imports is a dependency of @api/hono, so its build covers it", async () => {
  const pkg = await Bun.file(join(ROOT, "api/hono/package.json")).json()
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const imported = workspaceImports(await sourcesIn("api")).map((specifier) =>
    specifier.split("/").slice(0, 2).join("/"),
  )
  expect(imported.length).toBeGreaterThan(0)
  expect(imported.filter((name) => !declared.includes(name))).toEqual([])
})

test(
  "prebuild given pr-merge reads pr-merge's own sources, and exits 0 once they are built",
  async () => {
    expect(workspaceImports(await sourcesIn("pr-merge"))).toContain("@packages/config/verdicts")
    const run = bounded(
      "prebuild pr-merge",
      ["bun", join(ROOT, "packages/scripts/src/verify/prebuild.ts"), "pr-merge"],
      {
        cwd: ROOT,
      },
    )
    expect(run.exitCode).toBe(0)
  },
  within(1),
)

test("isMainCheckout is the factory's main checkout alone, by real path, so a person's own clone still builds", () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-main-"))
  try {
    symlinkSync(ROOT, join(dir, "link"))
    expect(isMainCheckout(ROOT, join(dir, "link"))).toBe(true)
    expect(isMainCheckout(ROOT, undefined)).toBe(false)
    expect(isMainCheckout(ROOT, dir)).toBe(false)
    expect(isMainCheckout(ROOT, join(dir, "missing"))).toBe(false)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// in process, as prebuild.ts's own entry reads a target, since a spawned bun's start alone outran bun's 30 s timeout on a loaded machine
test("in the factory's main checkout prebuild stops before any build and says where to run it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-stop-"))
  try {
    writeFileSync(join(dir, "cli.ts"), 'import "@packages/config/nope"\n')
    const sources = await sourcesIn(relative(join(ROOT, "packages/scripts/src"), dir))
    const missing = unbuilt(workspaceImports(sources), dir, importedNames(sources))
    expect(missing).toEqual(["@packages/config/nope"])
    const step = prebuildStep("verify", missing, ROOT, ROOT)
    expect(step).not.toHaveProperty("build")
    expect("refused" in step && step.refused).toContain("run it from your own worktree")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// yard.test.ts's `bun -e` scenarios import the hosted app through a path read at run time, so a fresh clone's test:file built nothing and 8 rows failed on "Cannot find module '@packages/db'"
test("testSpecifiers adds every built shared package's dist for a test:file source that spawns a child process, whose program the import scan cannot follow, through a helper or a variable too", () => {
  const built = new Set(["@api/hono", "@packages/db", "@packages/env"])
  const all = ["packages/db/dist", "packages/env/dist"]
  expect(
    testSpecifiers(['Bun.spawnSync(["bun", "-e", script], { cwd: API })'], built, false),
  ).toEqual(all)
  expect(
    testSpecifiers(['const BUN = slowChild("bun")\nBun.spawn([BUN, CLI, ...args])'], built, false),
  ).toEqual(all)
  expect(testSpecifiers(['const r = spawnSync(sh, ["-c", cmd])'], built, false)).toEqual(all)
  expect(testSpecifiers(["const out = await $`bun run ask`.text()"], built, false)).toEqual(all)
  expect(
    testSpecifiers(['import { db } from "@packages/db"\nconst m = /x/.exec(s)'], built, false),
  ).toEqual(["@packages/db"])
  expect(testSpecifiers(['Bun.spawnSync(["bun", "-e", script])'], built, true)).toEqual([])
})

test("workspaceImports finds static, dynamic and bare imports of workspace packages", () => {
  expect(
    workspaceImports([
      'import { site } from "@packages/config/site"\nimport type { X } from "@packages/env"\nexport const x: X = site',
      'const db = await import("@packages/db")\nimport "@packages/auth/access"\nimport { a } from "./map"\nexport { a, db }',
    ]),
  ).toEqual(["@packages/config/site", "@packages/db", "@packages/auth/access"])
})

// check-types:tests once read a test's string that spells an import as one, and its build stopped on "No package found with name '@packages/two'"
test("workspaceImports with types adds each type-only import at the start of a line, and leaves one a string spells", () => {
  expect(
    workspaceImports(
      [
        'import type { Plan } from "@api/hono"\nimport { type Row, row } from "@packages/db"\nexport type * from "@packages/config/kinds"\nconst s = \'import type { Two } from "@packages/two"\'\nexport const r = row',
      ],
      true,
    ).sort(),
  ).toEqual(["@api/hono", "@packages/config/kinds", "@packages/db"])
  expect(workspaceImports(['import type { Plan } from "@api/hono"\nexport const p = 1'])).toEqual(
    [],
  )
})

test("workspaceImports scans a source that starts with a shebang, which Bun's scan throws on", () => {
  expect(
    workspaceImports([
      '#!/usr/bin/env bun\nimport { site } from "@packages/config/site"\nexport const x = site',
    ]),
  ).toEqual(["@packages/config/site"])
})

// Two packages alike but for their dist, since Bun caches a resolution for the life of the process.
test("unbuilt names a package whose exports target is missing, and passes one whose file is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-"))
  try {
    for (const name of ["unbuilt", "built"]) {
      const pkg = join(dir, "node_modules/@packages", name)
      mkdirSync(join(pkg, "dist"), { recursive: true })
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ exports: { ".": "./dist/index.mjs" }, name: `@packages/${name}` }),
      )
    }
    writeFileSync(join(dir, "node_modules/@packages/built/dist/index.mjs"), "export {}\n")
    expect(unbuilt(["@packages/unbuilt", "@packages/built"], dir)).toEqual(["@packages/unbuilt"])
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// pr:merge once stopped on "Export named 'dispatcherSeatOf' not found" in a config dist built before a canary merge added it, the file there all along.
test("unbuilt names a package whose dist lacks a name the sources import, and passes one that exports every name", () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-names-"))
  try {
    for (const [name, dist] of [
      ["stale", "const a = 1\nexport { a }\n"],
      ["fresh", "const a = 1, b = 2\nexport { a, b }\n"],
    ]) {
      const pkg = join(dir, "node_modules/@packages", name)
      mkdirSync(join(pkg, "dist"), { recursive: true })
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ exports: { ".": "./dist/index.mjs" }, name: `@packages/${name}` }),
      )
      writeFileSync(join(pkg, "dist/index.mjs"), dist)
    }
    const names = { "@packages/fresh": ["a", "b"], "@packages/stale": ["a", "b"] }
    expect(unbuilt(["@packages/stale", "@packages/fresh"], dir, names)).toEqual(["@packages/stale"])
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// check-types:tests once failed after a canary merge on types a dist built before it lacked, every name the sources import still there; a rebuild under a running stack hangs it, so a stack up keeps the dist.
test("unbuilt names a package whose src holds a file newer than its dist while no stack runs, by a dist folder's newest file, and passes a file outside its dist", () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-mtime-"))
  try {
    const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds)
    const files: Record<string, string> = {}
    for (const [name, srcAt, distAt, served, folderAt = 500] of [
      ["stale", 2000, 1000, "dist/index.mjs"],
      ["fresh", 1000, 2000, "dist/index.mjs"],
      ["folder", 1500, 2000, "dist"],
      ["stale-folder", 2000, 1500, "dist", 3000],
      ["source", 2000, 1000, "src/index.ts"],
      ["root", 2000, 1000, "tsconfig.json"],
    ] as const) {
      const pkg = join(dir, name)
      mkdirSync(join(pkg, "dist"), { recursive: true })
      mkdirSync(join(pkg, "src"))
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@packages/${name}` }))
      writeFileSync(join(pkg, "src/index.ts"), "export const a = 1\n")
      writeFileSync(join(pkg, "src/other.ts"), "export const b = 2\n")
      writeFileSync(join(pkg, "dist/index.mjs"), "export const a = 1\n")
      writeFileSync(join(pkg, "tsconfig.json"), "{}\n")
      at(join(pkg, "tsconfig.json"), 1000)
      at(join(pkg, "src/index.ts"), 1000)
      at(join(pkg, "src/other.ts"), srcAt)
      at(join(pkg, "dist/index.mjs"), distAt)
      at(join(pkg, "dist"), folderAt)
      files[`@packages/${name}`] = join(pkg, served)
    }
    const resolve = (specifier: string) => files[specifier]
    expect({
      stackDown: unbuilt(Object.keys(files), dir, {}, resolve, false),
      stackUp: unbuilt(Object.keys(files), dir, {}, resolve, true),
    }).toEqual({ stackDown: ["@packages/stale", "@packages/stale-folder"], stackUp: [] })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// the whole suite's prebuild once rebuilt @packages/db for "row" and "type Row", which only a test's string spells
test("importedNames leaves a name only a string spells, as an import a line of a test's fixture holds", () => {
  expect(
    prebuild.importedNames([
      'import { site } from "@packages/config/site"\nconst text = `\nimport { row } from "@packages/db"\n`\nexport const s = [site, text]',
    ]),
  ).toEqual({ "@packages/config/site": ["site"] })
})

test("importedNames lists the value names each workspace import takes, by their exported names, with no type-only one", () => {
  expect(
    prebuild.importedNames([
      'import { a, type B, c as d } from "@packages/config/kinds"\nimport type { X } from "@packages/env"\nimport def, { e } from "@packages/db"\nexport { f } from "@packages/config/org"\nimport { g } from "./map"\nexport const y = (q: B, r: X) => [a, d, def, e, g]',
    ]),
  ).toEqual({
    "@packages/config/kinds": ["a", "c"],
    "@packages/config/org": ["f"],
    "@packages/db": ["default", "e"],
  })
})

// pr-merge reaches @packages/config/kinds only through merge.ts, ops-job and ops-tick, outside its own folder.
test("prebuild given pr-merge reads every source it reaches through a relative import, outside its own folder too", async () => {
  expect(workspaceImports(await sourcesIn("pr-merge"))).toContain("@packages/config/kinds")
})

// code-review-loop's VERIFY.md has a reviewer run a scratch test from its scratchpad that imports the clone's modules by absolute path
test("a scratch test outside the checkout reaches the packages a module it imports by absolute path imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-scratch-"))
  try {
    const file = join(dir, "scratch.test.ts")
    writeFileSync(
      file,
      `import * as probe from "${join(ROOT, "packages/scripts/src/playground/probe.ts")}"\n`,
    )
    expect(workspaceImports(await reach([file]))).toContain("@packages/config/kinds")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("a scratch test's absolute import outside the checkout stays unread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-elsewhere-"))
  try {
    const elsewhere = join(dir, "elsewhere.ts")
    writeFileSync(elsewhere, `import { slotOfName } from "@packages/config/kinds"\n`)
    const file = join(dir, "scratch.test.ts")
    writeFileSync(file, `import * as elsewhere from "${elsewhere}"\n`)
    const sources = await reach([file])
    expect(sources).toHaveLength(1)
    expect(workspaceImports(sources)).toEqual([])
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// @packages/scripts's own exports serve its src, which no build writes, so a source reaching its own package (proc-start.ts's procRoot, through probe.ts) needs no dependency
test("every workspace package verify or pr-merge imports is a dependency of @packages/scripts or itself, so its build covers it", async () => {
  const pkg = await Bun.file(join(ROOT, "packages/scripts/package.json")).json()
  const declared = [pkg.name, ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })]
  for (const sources of [await sourcesIn("verify"), await sourcesIn("pr-merge")]) {
    const imported = workspaceImports(sources).map((specifier) =>
      specifier.split("/").slice(0, 2).join("/"),
    )
    expect(imported.length).toBeGreaterThan(0)
    expect(imported.filter((name) => !declared.includes(name))).toEqual([])
  }
})

// A made-up worktree: `fresh` has its dependency linked, `added` came with a canary pull after the last install, and `hoisted` finds its own at the root.
const worktree = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-install-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
  for (const [name, dep] of [
    ["fresh", "tsdown"],
    ["added", "tsdown"],
    ["hoisted", "typescript"],
  ]) {
    mkdirSync(join(dir, "packages", name), { recursive: true })
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({ devDependencies: { [dep]: "catalog:" }, name: `@packages/${name}` }),
    )
  }
  mkdirSync(join(dir, "packages/fresh/node_modules/tsdown"), { recursive: true })
  mkdirSync(join(dir, "node_modules/typescript"), { recursive: true })
  return dir
}

// prebuild.ts and what it imports, into a made-up checkout: its verify folder, which this returns.
const copyPrebuild = (dir: string): string => {
  const verify = join(dir, "packages/scripts/src/verify")
  mkdirSync(verify, { recursive: true })
  cpSync(join(ROOT, "packages/scripts/src/verify/prebuild.ts"), join(verify, "prebuild.ts"))
  cpSync(
    join(ROOT, "packages/scripts/src/shebang.ts"),
    join(dir, "packages/scripts/src/shebang.ts"),
  )
  symlinkSync(
    join(ROOT, "packages/scripts/node_modules"),
    join(dir, "packages/scripts/node_modules"),
  )
  mkdirSync(join(dir, "api/hono/src/lib/dev"), { recursive: true })
  cpSync(join(ROOT, "api/hono/src/lib/dev/stop.ts"), join(dir, "api/hono/src/lib/dev/stop.ts"))
  mkdirSync(join(dir, "node_modules/@packages"), { recursive: true })
  symlinkSync(join(ROOT, "packages/safe-delete"), join(dir, "node_modules/@packages/safe-delete"))
  symlinkSync(join(ROOT, "packages/scripts"), join(dir, "node_modules/@packages/scripts"))
  return verify
}

// On 2 Nov pr:merge, run from a worktree installed before canary added @packages/safe-delete, stopped on "tsdown: command not found" partway through its build.
test("staleInstall refuses a worktree whose install predates a package its bun.lock added, naming the package and the install that fixes it", () => {
  const dir = worktree()
  try {
    const refusal = staleInstall("pr-merge", dir) ?? ""
    expect(refusal).toContain("packages/added (tsdown)")
    expect(refusal).not.toContain("packages/fresh")
    expect(refusal).not.toContain("packages/hoisted")
    expect(refusal).toContain(
      `~/.playground/ops/run-slot.sh <your name> -- bun install --ignore-scripts --cwd ${dir}`,
    )
    expect(refusal).toContain("then run pr-merge again")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("staleInstall passes a worktree whose every workspace package has its dependencies installed", () => {
  const dir = worktree()
  try {
    mkdirSync(join(dir, "packages/added/node_modules/tsdown"), { recursive: true })
    expect(staleInstall("pr-merge", dir)).toBeNull()
    expect(staleInstall("pr-merge", ROOT)).toBeNull()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// On 2 Nov a canary merge made packages/settings depend on @packages/safe-delete while every dist was still built, so the check never ran and pr:merge failed on "Cannot find module".
test("prebuildStep refuses pr-merge on a stale install with every dist built, naming the install, and leaves verify and the API building on", () => {
  const dir = worktree()
  try {
    expect(prebuildStep("pr-merge", [], dir, undefined)).toEqual({
      refused: staleInstall("pr-merge", dir)!,
    })
    expect(prebuildStep("pr-merge", [], dir, undefined)).toMatchObject({
      refused: expect.stringContaining("bun install --ignore-scripts"),
    })
    expect(prebuildStep("verify", [], dir, undefined)).toEqual({ build: [] })
    expect(prebuildStep("api", ["@packages/x"], dir, undefined)).toEqual({ build: ["@packages/x"] })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("prebuildStep adds no install and no refusal on an install that matches, building only what is unbuilt", () => {
  const dir = worktree()
  try {
    mkdirSync(join(dir, "packages/added/node_modules/tsdown"), { recursive: true })
    expect(prebuildStep("pr-merge", [], dir, undefined)).toEqual({ build: [] })
    expect(prebuildStep("pr-merge", ["@packages/x"], dir, undefined)).toEqual({
      build: ["@packages/x"],
    })
    expect(prebuildStep("pr-merge", ["@packages/x"], dir, dir)).toMatchObject({
      refused: expect.stringContaining("run it from your own worktree"),
    })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test(
  "bun run pr:merge's prebuild stops on a stale install even with every dist built, and passes once it is installed",
  () => {
    const dir = worktree()
    try {
      const verify = copyPrebuild(dir)
      mkdirSync(join(dir, "packages/scripts/src/pr-merge"))
      writeFileSync(join(dir, "packages/scripts/src/pr-merge/cli.ts"), "export const x = 1\n")
      const { PLAYGROUND_REPO: _, ...env } = process.env
      const run = () =>
        bounded("pr:merge's prebuild", ["bun", join(verify, "prebuild.ts"), "pr-merge"], {
          cwd: dir,
          env,
        })
      const stale = run()
      expect(stale.exitCode).toBe(1)
      expect(stale.stderr.toString()).toContain("packages/added (tsdown)")
      expect(stale.stderr.toString()).toContain("bun install --ignore-scripts")
      mkdirSync(join(dir, "packages/added/node_modules/tsdown"), { recursive: true })
      expect(run().exitCode).toBe(0)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(2),
)

// A worktree whose node_modules came from a clone, with no dist, no metrics and no .env: on 5 Nov its first test:file stopped on "Cannot find module '@packages/config/kinds'", its check-types:tests on "Cannot find module 'generated/data-table-metrics.json'", and a hand-run build without the flags on "@packages/auth:build: error: Invalid environment variables". Its turbo logs each build and writes the dist each filter names.
const clone = (): {
  dir: string
  log: () => string
  run: (args: string[], main?: boolean) => { exitCode: number; stderr: string }
} => {
  const dir = mkdtempSync(join(tmpdir(), "prebuild-clone-"))
  const log = join(dir, "build.log")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["api/*", "packages/*"] }))
  mkdirSync(join(dir, "api/hono"), { recursive: true })
  writeFileSync(
    join(dir, "api/hono/package.json"),
    JSON.stringify({
      exports: "./dist/index.mjs",
      name: "@api/hono",
      scripts: { build: "tsdown" },
    }),
  )
  for (const name of ["one", "two", "three"]) {
    mkdirSync(join(dir, "packages", name), { recursive: true })
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({
        exports: { ".": { default: "./dist/index.mjs", types: "./dist/index.d.mts" } },
        name: `@packages/${name}`,
        scripts: { build: "tsdown" },
      }),
    )
  }
  mkdirSync(join(dir, "packages/plain"))
  writeFileSync(
    join(dir, "packages/plain/package.json"),
    JSON.stringify({ name: "@packages/plain" }),
  )
  const verify = copyPrebuild(dir)
  writeFileSync(
    join(dir, "packages/scripts/src/data-table-metrics.ts"),
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"\nmkdirSync(${JSON.stringify(join(dir, ".generated"))}, { recursive: true })\nwriteFileSync(${JSON.stringify(join(dir, ".generated/data-table-metrics.json"))}, "{}")\nappendFileSync(${JSON.stringify(log)}, "metrics\\n")\n`,
  )
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true })
  writeFileSync(
    join(dir, "node_modules/.bin/turbo"),
    `#!/bin/bash\necho "$* NODE_ENV=$NODE_ENV SKIP_ENV_VALIDATION=$SKIP_ENV_VALIDATION" >> ${JSON.stringify(log)}\nfor arg; do case "$arg" in --filter=@packages/*) name=\${arg#--filter=@packages/}; mkdir -p "packages/$name/dist"; echo "export const $name = 1" > "packages/$name/dist/index.mjs"; echo "export declare const $name: 1" > "packages/$name/dist/index.d.mts" ;; --filter=@api/hono) mkdir -p api/hono/dist; echo "export {}" > api/hono/dist/index.mjs; echo "export type Plan = { id: string }" > api/hono/dist/index.d.mts ;; esac; done\n`,
  )
  chmodSync(join(dir, "node_modules/.bin/turbo"), 0o755)
  mkdirSync(join(dir, "lib"))
  writeFileSync(
    join(dir, "lib/one.ts"),
    'import { one } from "@packages/one"\nexport const x = one\n',
  )
  writeFileSync(
    join(dir, "lib/table.ts"),
    'import metrics from "generated/data-table-metrics.json"\nexport const m = metrics\n',
  )
  mkdirSync(join(dir, "tests"))
  writeFileSync(
    join(dir, "tests/one.test.ts"),
    'import { x } from "../lib/one"\nexport const y = x\n',
  )
  writeFileSync(
    join(dir, "tests/two.test.ts"),
    'import type { Two } from "@packages/two"\nexport const t: Two | null = null\n',
  )
  writeFileSync(
    join(dir, "lib/plan.ts"),
    'import type { Plan } from "@api/hono"\nexport const p: Plan | null = null\n',
  )
  writeFileSync(
    join(dir, "tests/plan.test.ts"),
    'import { p } from "../lib/plan"\nexport const q = p\n',
  )
  writeFileSync(
    join(dir, "tests/path.test.ts"),
    'const three = "../packages/three/dist/index.mjs"\nconst stale = "../packages/three/dist/nope.mjs"\nconst plain = "../packages/plain/dist/x.mjs"\nexport const paths = [three, stale, plain]\n',
  )
  writeFileSync(
    join(dir, "tests/table.test.ts"),
    'import { m } from "../lib/table"\nexport const n = m\n',
  )
  const { PLAYGROUND_REPO: _, ...env } = process.env
  return {
    dir,
    log: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    run: (args, main = false) => {
      const { exitCode, stderr } = bounded(
        "test:file's prebuild",
        ["bun", join(verify, "prebuild.ts"), "tests", ...args],
        { cwd: dir, env: { ...env, NODE_ENV: "test", ...(main ? { PLAYGROUND_REPO: dir } : {}) } },
      )
      return { exitCode, stderr: stderr.toString() }
    },
  }
}

// A turbo cache hit restores a dist as it was, older than the src that sent the build, so a prebuild that left it there would build it again on every run; a src saved while the build runs still needs the next one.
test(
  "test:file builds a package whose src is newer than its dist, when turbo's cache hit leaves the dist as it was, again only for a src saved during that build, and then nothing",
  () => {
    const { dir, log, run } = clone()
    try {
      for (const path of ["api/hono/dist", "packages/two/dist", "packages/three/dist"]) {
        mkdirSync(join(dir, path), { recursive: true })
        writeFileSync(join(dir, path, "index.mjs"), "export {}\n")
      }
      const pkg = join(dir, "packages/one")
      mkdirSync(join(pkg, "dist"))
      mkdirSync(join(pkg, "src"))
      writeFileSync(join(pkg, "src/index.ts"), "export const one = 1\n")
      writeFileSync(join(pkg, "dist/index.mjs"), "export const one = 1\n")
      utimesSync(join(pkg, "dist/index.mjs"), 1000, 1000)
      const saved = join(dir, "saved")
      writeFileSync(
        join(dir, "node_modules/.bin/turbo"),
        `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, "build.log"))}\n[ -e ${JSON.stringify(saved)} ] || { sleep 0.05; touch packages/one/src/index.ts ${JSON.stringify(saved)}; }\n`,
      )
      for (let i = 0; i < 3; i++) expect(run(["tests/one.test.ts"]).exitCode).toBe(0)
      expect(
        log()
          .split("\n")
          .filter((line) => line.startsWith("run build")),
      ).toEqual([
        "run build --filter=@packages/one --output-logs=errors-only",
        "run build --filter=@packages/one --output-logs=errors-only",
      ])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(3),
)

test(
  "test:file stamps the dist of each package the built one depends on, which turbo built first, so a dependency's cache hit reads current too (#1067's nit)",
  () => {
    const { dir, log, run } = clone()
    try {
      writeFileSync(
        join(dir, "packages/two/package.json"),
        JSON.stringify({
          dependencies: { "@packages/one": "workspace:*" },
          exports: { ".": { default: "./dist/index.mjs", types: "./dist/index.d.mts" } },
          name: "@packages/two",
          scripts: { build: "tsdown" },
        }),
      )
      writeFileSync(
        join(dir, "tests/uses-two.test.ts"),
        'import { two } from "@packages/two"\nexport const t = two\n',
      )
      const dist = join(dir, "packages/one/dist/index.mjs")
      mkdirSync(join(dir, "packages/one/dist"), { recursive: true })
      writeFileSync(dist, "export const one = 1\n")
      utimesSync(dist, 1000, 1000)
      expect(run(["tests/uses-two.test.ts"]).exitCode).toBe(0)
      expect(log()).not.toContain("--filter=@packages/one")
      expect(statSync(dist).mtimeMs).toBeGreaterThan(1_000_000)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(1),
)

test(
  "test:file in a cloned worktree builds every dist missing beside what its files import, under the flags a worktree with no .env needs, and then nothing",
  () => {
    const { dir, log, run } = clone()
    try {
      const first = run(["tests/one.test.ts"])
      expect(first.stderr).toContain(
        "test:file: building what @packages/one, api/hono/dist, packages/three/dist, packages/two/dist needs",
      )
      expect(first.exitCode).toBe(0)
      expect(log()).toBe(
        "run build --filter=@packages/one --filter=@api/hono --filter=@packages/three --filter=@packages/two --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true\n",
      )
      expect(run(["tests/one.test.ts"]).exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)).toHaveLength(1)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(2),
)

// issue 1964: a test's child process may import a package no reached source names, so test:file builds every shared package whose dist is missing, whatever its files import
test(
  "test:file builds every shared package whose dist is missing, so a child process's import the test file does not import resolves, and then nothing",
  () => {
    const { dir, log, run } = clone()
    try {
      writeFileSync(
        join(dir, "tests/child.test.ts"),
        `import { spawn as launch } from "node:child_process"\nexport const child = () =>\n  launch(process.execPath, ["-e", "import('@packages/three').then(() => process.exit(0), () => process.exit(1))"])\n`,
      )
      symlinkSync(join(dir, "packages/three"), join(dir, "node_modules/@packages/three"))
      const first = run(["tests/child.test.ts"])
      expect(first.exitCode).toBe(0)
      expect(log()).toBe(
        "run build --filter=@api/hono --filter=@packages/one --filter=@packages/three --filter=@packages/two --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true\n",
      )
      const child = bounded(
        "the spawned child",
        [
          process.execPath,
          "-e",
          `import("@packages/three").then(() => process.exit(0), () => process.exit(1))`,
        ],
        { cwd: dir },
      )
      expect(child.exitCode).toBe(0)
      expect(run(["tests/child.test.ts"]).exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)).toHaveLength(1)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(3),
)

// a package whose dist is present is not rebuilt: a clone with every dist there starts with no build, for a file that imports a package too
test(
  "test:file in a cloned worktree whose every dist is present builds nothing, for a file that imports a package too",
  () => {
    const { dir, log, run } = clone()
    try {
      for (const [path, code] of [
        ["api/hono/dist", "export {}\n"],
        ["packages/one/dist", "export const one = 1\n"],
        ["packages/three/dist", "export {}\n"],
        ["packages/two/dist", "export {}\n"],
      ] as const) {
        mkdirSync(join(dir, path), { recursive: true })
        writeFileSync(join(dir, path, "index.mjs"), code)
      }
      writeFileSync(
        join(dir, "tests/uses-one.test.ts"),
        'import { one } from "@packages/one"\nexport const o = one\n',
      )
      symlinkSync(join(dir, "packages/one"), join(dir, "node_modules/@packages/one"))
      expect(run(["tests/uses-one.test.ts"]).exitCode).toBe(0)
      expect(log()).toBe("")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(1),
)

test(
  "ask's and thread's command lines build a package whose dist is older than its src before their entry runs, and then build nothing",
  async () => {
    const { dir, log } = clone()
    try {
      const pkg = join(dir, "packages/one")
      mkdirSync(join(pkg, "dist"))
      mkdirSync(join(pkg, "src"))
      writeFileSync(join(pkg, "src/index.ts"), "export const one = 1\n")
      writeFileSync(join(pkg, "dist/index.mjs"), "export const one = 1\n")
      utimesSync(join(pkg, "dist/index.mjs"), 1000, 1000)
      symlinkSync(pkg, join(dir, "node_modules/@packages/one"))
      mkdirSync(join(dir, "api/hono/src/bin"))
      const scripts = (await Bun.file(join(ROOT, "package.json")).json()).scripts
      const { PLAYGROUND_REPO: _, ...env } = process.env
      for (const name of ["ask", "thread"]) {
        writeFileSync(
          join(dir, `api/hono/src/bin/dashboard-${name}.ts`),
          `import { appendFileSync } from "node:fs"\nimport { one } from "@packages/one"\nappendFileSync(${JSON.stringify(join(dir, "build.log"))}, "ran ${name} " + one + "\\n")\n`,
        )
      }
      const run = (name: string) =>
        bounded(`bun run ${name}`, ["bash", "-c", scripts[name]], {
          cwd: dir,
          env: { ...env, NODE_ENV: "test" },
        }).exitCode
      for (const name of ["ask", "ask", "thread"]) expect(run(name)).toBe(0)
      expect(log().split("\n").filter(Boolean)).toEqual([
        "run build --filter=@packages/one --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true",
        "ran ask 1",
        "ran ask 1",
        "ran thread 1",
      ])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(3),
)

test(
  "check-types:tests builds the packages its files import for their types alone too, and then nothing",
  () => {
    const { dir, log, run } = clone()
    try {
      expect(run(["tests/one.test.ts", "tests/two.test.ts"]).exitCode).toBe(0)
      expect(log()).toBe(
        "run build --filter=@packages/one --filter=@api/hono --filter=@packages/three --filter=@packages/two --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true\n",
      )
      for (const path of ["packages/three/dist", "packages/two/dist"])
        rmSync(join(dir, path), { recursive: true, force: true })
      const types = run(["--types", "tests/one.test.ts", "tests/two.test.ts"])
      expect(types.stderr).toContain("check-types:tests: building what @packages/two needs")
      expect(types.exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)).toEqual([
        "run build --filter=@packages/one --filter=@api/hono --filter=@packages/three --filter=@packages/two --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true",
        "run build --filter=@packages/two --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true",
      ])
      expect(run(["--types", "tests/one.test.ts", "tests/two.test.ts"]).exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)).toHaveLength(2)
      expect(existsSync(join(dir, "packages/three/dist"))).toBe(false)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(3),
)

// 5 Nov: a fresh worktree's check-types:tests stopped on 329 TS errors, "Cannot find module '@api/hono'", since the web's files take the API's types from its emitted declarations
test(
  "check-types:tests in a cloned worktree builds @api/hono, whose declarations the web's types import, before tsc, and then nothing",
  () => {
    const { dir, log, run } = clone()
    try {
      expect(run(["tests/plan.test.ts"]).exitCode).toBe(0)
      rmSync(join(dir, "api/hono/dist"), { recursive: true, force: true })
      const types = run(["--types", "tests/plan.test.ts"])
      expect(types.stderr).toContain("check-types:tests: building what @api/hono needs")
      expect(types.exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)[1]).toBe(
        "run build --filter=@api/hono --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true",
      )
      expect(existsSync(join(dir, "api/hono/dist/index.d.mts"))).toBe(true)
      expect(run(["--types", "tests/plan.test.ts"]).exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)).toHaveLength(2)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(3),
)

// round 2 of review: a path naming a file no build makes would rebuild its package on every run; round 1: with packages/env/dist moved aside, test-sandbox.test.ts alone gave 4 fails, since it, gaps.test.ts, keys.test.ts and redis's index.test.ts reach a dist file by its path
test(
  "test:file builds a package whose dist a test names by path once, a file no build makes included, and builds nothing for a workspace with no build",
  () => {
    const { dir, log, run } = clone()
    try {
      const first = run(["tests/path.test.ts"])
      expect(first.stderr).toContain("test:file: building what packages/three/dist/index.mjs")
      expect(first.exitCode).toBe(0)
      expect(log()).toBe(
        "run build --filter=@packages/three --filter=@api/hono --filter=@packages/one --filter=@packages/two --output-logs=errors-only NODE_ENV=production SKIP_ENV_VALIDATION=true\n",
      )
      expect(run(["tests/path.test.ts"]).exitCode).toBe(0)
      expect(log().split("\n").filter(Boolean)).toHaveLength(1)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(2),
)

test(
  "a test reaching the data table's metrics writes them when they are missing, and then leaves them",
  () => {
    const { dir, log, run } = clone()
    try {
      for (const path of [
        "api/hono/dist",
        "packages/one/dist",
        "packages/three/dist",
        "packages/two/dist",
      ]) {
        mkdirSync(join(dir, path), { recursive: true })
        writeFileSync(join(dir, path, "index.mjs"), "export {}\n")
      }
      expect(run(["tests/table.test.ts"]).exitCode).toBe(0)
      expect(log()).toBe("metrics\n")
      expect(existsSync(join(dir, ".generated/data-table-metrics.json"))).toBe(true)
      expect(run(["tests/table.test.ts"]).exitCode).toBe(0)
      expect(log()).toBe("metrics\n")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(2),
)

test(
  "in the factory's main checkout test:file's prebuild stops before any build and says where to run it",
  () => {
    const { dir, log, run } = clone()
    try {
      const main = run(["tests/one.test.ts"], true)
      expect(main.exitCode).toBe(1)
      expect(main.stderr).toContain("run it from your own worktree")
      expect(log()).toBe("")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
  within(1),
)

test("test:file and check-types:tests run the prebuild before their tests and types", async () => {
  const pkg = await Bun.file(join(ROOT, "package.json")).json()
  expect(pkg.scripts["check-types:tests"]).toBe(
    "if [ -d tests ]; then bun packages/scripts/src/verify/prebuild.ts tests --types && find tests -name tsconfig.json -print0 | xargs -0 -n1 tsc -p; fi",
  )
  const sandbox = await Bun.file(join(ROOT, "packages/scripts/src/test-sandbox.ts")).text()
  expect(sandbox).toContain("await prebuildTests(")
  expect(sandbox.indexOf("await prebuildTests(")).toBeLessThan(sandbox.indexOf("await runPass("))
})
