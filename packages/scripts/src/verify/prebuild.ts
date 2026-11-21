import "@packages/env/aliases"
import { existsSync, readFileSync, realpathSync, statSync, utimesSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { stackIn } from "../../../../api/hono/src/lib/dev/stop"
import { withoutShebang } from "../shebang"

// verify, pr:merge, the dev launcher, ask, thread, test:file and check-types:tests reach each workspace package through its built dist (its `types` always, its code where the entry has no `bun` condition), which a fresh worktree lacks, and which a pulled change can outgrow; it builds them only then, since a rebuild cleans the dist a running stack in this worktree imports (`bun run dev` refuses before this runs while one does). A dist that exists counts as unbuilt when a file under its package's `src` is newer than it while no stack runs in this worktree (since `bun run verify` runs beside this worktree's stack, and a rebuild under it hangs it), or when it lacks a name the target's sources import from it, those it reaches through relative, `@/` and absolute imports into this checkout included.
const VERIFY = import.meta.dir
const SRC = join(VERIFY, "..")
const ROOT = join(VERIFY, "../../../..")

// `api` reads the API's sources and builds @api/hono's dependencies; any other target is a folder under packages/scripts/src.
const dirOf = (target: string): string =>
  target === "api" ? join(ROOT, "api/hono/src") : join(SRC, target)

const transpiler = new Bun.Transpiler({ loader: "ts" })
// Bun's runtime drops an import its module never uses, a name used only as a type among them, so a dist need not export one.
const trimmer = new Bun.Transpiler({ loader: "ts", trimUnusedImports: true })
const scanners = {
  js: new Bun.Transpiler({ loader: "js" }),
  ts: transpiler,
  tsx: new Bun.Transpiler({ loader: "tsx" }),
}
const scannerOf = (file: string) =>
  file.endsWith(".tsx") ? scanners.tsx : /\.[cm]?ts$/.test(file) ? scanners.ts : scanners.js
const tsxTrimmer = new Bun.Transpiler({ loader: "tsx", trimUnusedImports: true })
// A source read as TypeScript, else as TSX, since a source string carries no file name; one that parses as neither gives nothing.
const parsed = <T>(
  source: string,
  ts: (code: string) => T,
  tsx: (code: string) => T,
  none: T,
): T => {
  const code = withoutShebang(source)
  try {
    return ts(code)
  } catch {
    try {
      return tsx(code)
    } catch {
      return none
    }
  }
}
// What a build makes: a workspace package's dist, the API's for the web's types, and the data table's metrics.
const BUILT = /^(?:@packages\/|@api\/hono(?:\/|$)|generated\/)/
// A type-only import at the start of a line, which Bun's scan drops and tsc still resolves; a string that spells one inside a line stays text.
const TYPE_IMPORT =
  /^(?:(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)|import\s*\{[^}]*\btype\s[^}]*\})\s*from\s+["']([^"']+)["']/gm

// Every built import the given sources make, statically or dynamically, and with `types` their type-only ones too.
export const workspaceImports = (sources: string[], types = false): string[] => [
  ...new Set(
    sources.flatMap((source) =>
      [
        ...parsed(
          source,
          (code) => transpiler.scanImports(code),
          (code) => scanners.tsx.scanImports(code),
          [],
        ).map(({ path }) => path),
        ...(types ? [...source.matchAll(TYPE_IMPORT)].map(([, path]) => path) : []),
      ].filter((path) => BUILT.test(path)),
    ),
  ),
]

// The value names the sources import from each workspace package, by the name it exports (`default` for a default import).
export const importedNames = (sources: string[]): Record<string, string[]> => {
  const names: Record<string, Set<string>> = {}
  for (const source of sources) {
    if (!source.includes("@packages/")) continue
    const code = parsed(
      source,
      (text) => trimmer.transformSync(text),
      (text) => tsxTrimmer.transformSync(text),
      "",
    )
    // a string that spells an import reads like one at the start of a line once printed, so a match counts only for a module the code really imports
    const real = new Set(
      parsed(
        code,
        (text) => scanners.js.scanImports(text),
        () => [],
        [],
      ).map(({ path }) => path),
    )
    for (const [, fallback, list, specifier] of code.matchAll(
      /^(?:import|export)\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+"(@packages\/[^"]+)"/gm,
    )) {
      if (!real.has(specifier)) continue
      const taken = (names[specifier] ||= new Set())
      if (fallback) taken.add("default")
      for (const item of (list || "").split(",")) {
        const name = item.trim().split(/\s+as\s+/)[0]
        if (name) taken.add(name)
      }
    }
  }
  return Object.fromEntries(
    Object.entries(names).map(([specifier, taken]) => [specifier, [...taken].sort()]),
  )
}

// The newest mtime among the files under a folder, 0 for none, read once per folder a run.
const newestTimes = new Map<string, number>()
const newestUnder = (dir: string): number => {
  const known = newestTimes.get(dir)
  if (known !== undefined) return known
  let newest = 0
  for (const name of new Bun.Glob("**/*").scanSync(dir))
    newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
  newestTimes.set(dir, newest)
  return newest
}

// A file of a package's dist older than a file under its src, as a pull leaves it; the dist folder reads by its newest file, since its own mtime moves only when an entry is added or removed, and any other file (one its package serves from src, a config at its root) or a package with no src reads as current, since no build rewrites it.
const outgrown = (file: string): boolean => {
  const real = realpathSync(file)
  let pkg = dirname(real)
  while (!existsSync(join(pkg, "package.json"))) {
    if (dirname(pkg) === pkg) return false
    pkg = dirname(pkg)
  }
  const src = join(pkg, "src")
  const dist = join(pkg, "dist")
  if (!existsSync(src) || (real !== dist && !real.startsWith(`${dist}/`))) return false
  const built = statSync(real).isDirectory() ? newestUnder(real) : statSync(real).mtimeMs
  return newestUnder(src) > built
}

// The imports that resolve to nothing yet, an exports target whose file is missing among them, those older than a file under their package's src while no stack runs in this worktree, and those whose file lacks a name the sources import from it; a file that re-exports with `export *` is taken as exporting every name.
export const unbuilt = (
  specifiers: string[],
  from: string,
  names: Record<string, string[]> = {},
  resolve: (specifier: string, from: string) => string = Bun.resolveSync,
  stackUp: boolean = Boolean(stackIn(ROOT)),
): string[] =>
  specifiers.filter((specifier) => {
    let file: string
    try {
      file = resolve(specifier, from)
    } catch {
      return true
    }
    if (!stackUp && outgrown(file)) return true
    const wanted = names[specifier] || []
    if (wanted.length === 0) return false
    const code = readFileSync(file, "utf8")
    if (/\bexport\s*\*/.test(code)) return false
    const exported = new Set(scannerOf(file).scan(code).exports)
    return wanted.some((name) => !exported.has(name))
  })

// Every source the given files run: each file, and each `.ts` or `.tsx` file it reaches through a relative or `@/` import, outside its folder too, or through an absolute import into this checkout, so a scratch test outside it that imports its modules by absolute path builds what they import, while another clone's file or a system one stays unread.
export const reach = async (files: string[]): Promise<string[]> => {
  const queue = [...files]
  const seen = new Set<string>()
  const sources: string[] = []
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue
    seen.add(file)
    const source = await Bun.file(file).text()
    sources.push(source)
    let imports: { path: string }[] = []
    try {
      imports = scannerOf(file).scanImports(withoutShebang(source))
    } catch {}
    for (const { path } of imports) {
      if (!path.startsWith(".") && !path.startsWith("@/") && !isAbsolute(path)) continue
      try {
        const next = Bun.resolveSync(path, dirname(file))
        if (isAbsolute(path) && !next.startsWith(`${ROOT}/`)) continue
        if (/\.tsx?$/.test(next) && !next.includes("/node_modules/")) queue.push(next)
      } catch {}
    }
  }
  return sources
}

// Every source one target runs: each file of its folder (a folder under packages/scripts/src, or the API), and each source those reach.
export const sourcesIn = (target: string): Promise<string[]> =>
  reach(
    [...new Bun.Glob("**/*.ts").scanSync(dirOf(target))].map((name) => join(dirOf(target), name)),
  )

// The test files a test:file or check-types:tests run takes, each path read from the working folder as bun test reads it: a file, or a folder's `.ts` and `.tsx` files; a name filter, which bun test also takes, adds none.
export const testFiles = (paths: string[]): string[] =>
  (paths.length > 0 ? paths : ["tests"]).flatMap((path) => {
    const full = resolve(path)
    if (!existsSync(full)) return []
    if (!statSync(full).isDirectory()) return /\.tsx?$/.test(path) ? [full] : []
    return [...new Bun.Glob("**/*.{ts,tsx}").scanSync(full)]
      .filter((name) => !name.split("/").includes("node_modules"))
      .map((name) => join(full, name))
  })

// Each workspace package of the checkout at root: its folder, relative and absolute, and its manifest.
const workspaces = (
  root: string,
): {
  dir: string
  path: string
  pkg: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    exports?: unknown
    name?: string
    scripts?: Record<string, string>
  }
}[] => {
  const { workspaces } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const globs: string[] = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? [])
  return globs.flatMap((glob) =>
    [...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: root })].map((manifest) => ({
      dir: dirname(manifest),
      path: join(root, dirname(manifest)),
      pkg: JSON.parse(readFileSync(join(root, manifest), "utf8")),
    })),
  )
}

// The workspace package a built import or a built path belongs to: `@packages/env/gaps` and `packages/env/dist/gaps.mjs` are both `@packages/env`, `api/hono/dist` is `@api/hono`.
const packageOf = (specifier: string): string => {
  const [first, second] = specifier.split("/")
  return first === "packages" || first === "api" ? `@${first}/${second}` : `${first}/${second}`
}

// A built file a source names by its path, as a test that imports a dist file by path or hands one to a child does: `packages/<name>/dist`, or `api/hono/dist`, and the file after it.
const BUILT_PATH = /\b(?:packages|api)\/[\w-]+\/dist(?:\/[\w.-]+)*\b/g

// Every built path the given sources name.
export const builtPaths = (sources: string[]): string[] => [
  ...new Set(sources.flatMap((source) => source.match(BUILT_PATH) ?? [])),
]

// A source that spawns a child process may start Bun on code the import scan cannot follow (a `bun -e` text, a path read at run time, a helper's binary in a variable), so test:file builds every shared package's dist for it, whatever the program.
const SPAWNS = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(|(?:^|[^\w$])\$`/m

// What test:file, or with `types` check-types:tests, builds for the given sources: their built imports and paths, and for a source that spawns a child process each built shared package's dist.
export const testSpecifiers = (
  sources: string[],
  built: Set<string | undefined>,
  types: boolean,
): string[] => [
  ...workspaceImports(sources, types),
  ...builtPaths(sources),
  ...(!types && sources.some((source) => SPAWNS.test(source))
    ? [...built]
        .filter((name): name is string => Boolean(name?.startsWith("@packages/")))
        .map((name) => `packages/${name.slice("@packages/".length)}/dist`)
    : []),
]

// Where a built import's file lives, by its workspace's exports and the conditions the reader takes (Bun's runtime, or tsc's types), so a test file outside any workspace resolves as the code it imports does; it throws when the file is not there yet.
export const builtFile = (specifier: string, root: string, conditions: string[]): string => {
  if (
    specifier.startsWith("generated/") ||
    /^(?:packages|api)\/[\w-]+\/dist(?:\/|$)/.test(specifier)
  ) {
    // a path counts as built once its dist folder is, so a file no build makes rebuilds nothing on the next run
    const file = specifier.startsWith("generated/")
      ? join(root, ".generated", specifier.slice("generated/".length))
      : join(root, specifier.match(/^(?:packages|api)\/[\w-]+\/dist/)![0])
    if (existsSync(file)) return file
    throw new Error(`${specifier} is not built`)
  }
  const sub = specifier.split("/").length > 2 ? `./${specifier.split("/").slice(2).join("/")}` : "."
  const pkg = workspaces(root).find((workspace) => workspace.pkg.name === packageOf(specifier))
  const exports = pkg?.pkg.exports as Record<string, unknown> | string | undefined
  let entry = typeof exports === "string" ? (sub === "." ? exports : undefined) : exports?.[sub]
  if (entry && typeof entry === "object")
    entry = conditions
      .map((condition) => (entry as Record<string, unknown>)[condition])
      .find(Boolean)
  const file = pkg && typeof entry === "string" ? join(pkg.path, entry) : ""
  if (file && existsSync(file)) return file
  throw new Error(`${specifier} is unbuilt`)
}

// The factory's main checkout, which spawn.sh exports as PLAYGROUND_REPO, stays clean: every installed skill follows it.
export const isMainCheckout = (root: string, repo: string | undefined): boolean => {
  if (!repo) return false
  try {
    return realpathSync(root) === realpathSync(repo)
  } catch {
    return false
  }
}

// A worktree installed before a canary pull that added a workspace package, or a dependency of one, lacks its links, and its build then stops on "tsdown: command not found" or its run on "Cannot find module"; pr:merge refuses it naming the install that fixes it, while verify and `bun run dev`, the live dashboard's serve among them, build on as before.
export const staleInstall = (target: string, root: string): string | null => {
  const missing = workspaces(root).flatMap(({ dir, pkg }) => {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
      (dep) =>
        !existsSync(join(root, dir, "node_modules", dep)) &&
        !existsSync(join(root, "node_modules", dep)),
    )
    return deps.length > 0 ? [`${dir} (${deps.join(", ")})`] : []
  })
  if (missing.length === 0) return null
  return `${target}: this worktree's install predates its bun.lock and misses ${missing.join(", ")}; run \`~/.playground/ops/run-slot.sh <your name> -- bun install --ignore-scripts --cwd ${root}\`, then run ${target} again`
}

// What prebuild does before a target runs: the refusal it stops on, else the packages it builds, none when every dist is built. pr:merge checks its install on every run, since a canary merge can add a dependency to a package whose dist is already built, which then fails on "Cannot find module".
export const prebuildStep = (
  target: string,
  missing: string[],
  root: string,
  repo: string | undefined,
): { refused: string } | { build: string[] } => {
  if (missing.length > 0 && isMainCheckout(root, repo))
    return {
      refused: `${target}: ${missing.join(", ")} is unbuilt here, and the factory's main checkout builds only packages/* after a pull; run it from your own worktree`,
    }
  const stale = target === "pr-merge" ? staleInstall(target, root) : null
  return stale ? { refused: stale } : { build: missing }
}

// The folders of the given workspace packages and of every workspace package they depend on, which turbo builds first.
const builtWith = (names: string[]): string[] => {
  const all = workspaces(ROOT)
  const seen = new Set<string>()
  for (const queue = [...names]; queue.length > 0;) {
    const name = queue.pop()!
    if (seen.has(name)) continue
    seen.add(name)
    const pkg = all.find((workspace) => workspace.pkg.name === name)?.pkg
    queue.push(...Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }))
  }
  return all.filter(({ pkg }) => pkg.name && seen.has(pkg.name)).map(({ path }) => path)
}

// Runs prebuildStep and builds what it names: each package by name (turbo builds its dependencies first) under the flags a worktree with no .env needs, then the data table's metrics when they are missing, then stamps every dist the build covered, its dependencies' included, with the build's start; the exit code.
const prebuild = (target: string, missing: string[]): number => {
  const step = prebuildStep(target, missing, ROOT, process.env.PLAYGROUND_REPO)
  if ("refused" in step) {
    console.error(step.refused)
    return 1
  }
  if (step.build.length === 0) return 0
  console.error(`${target}: building what ${step.build.join(", ")} needs`)
  const env = { ...process.env, NODE_ENV: "production", SKIP_ENV_VALIDATION: "true" }
  const packages = [
    ...new Set(
      step.build.filter((specifier) => !specifier.startsWith("generated/")).map(packageOf),
    ),
  ]
  // turbo's output goes to stderr, so `verify --json` keeps stdout to itself
  const steps = [
    ...(packages.length > 0
      ? [
          [
            join(ROOT, "node_modules/.bin/turbo"),
            "run",
            "build",
            ...packages.map((name) => `--filter=${name}`),
            "--output-logs=errors-only",
          ],
        ]
      : []),
    ...(step.build.some((specifier) => specifier.startsWith("generated/"))
      ? [[process.execPath, join(SRC, "data-table-metrics.ts")]]
      : []),
  ]
  const started = new Date()
  for (const argv of steps) {
    const run = Bun.spawnSync(argv, { cwd: ROOT, env, stdio: ["ignore", 2, "inherit"] })
    if (run.exitCode !== 0) return run.exitCode ?? 1
  }
  // a turbo cache hit leaves a dist at the mtime it had, older than the src that sent it here, though its inputs' hash says it matches that src; so each dist the build covered takes the build's start, which reads current on the next run while a src saved during the build still reads newer
  for (const path of builtWith(packages)) {
    const dist = join(path, "dist")
    if (!existsSync(dist)) continue
    for (const name of new Bun.Glob("**/*").scanSync(dist))
      utimesSync(join(dist, name), started, started)
  }
  return 0
}

// test:file's step before bun test, and with `types` check-types:tests' before tsc: what the given test paths reach, by the conditions each reader takes.
export const prebuildTests = async (paths: string[], types = false): Promise<number> => {
  const sources = await reach(testFiles(paths))
  const conditions = types ? ["types", "import", "default"] : ["bun", "import", "default"]
  // a workspace with no build script never makes a dist, so a path into one would read as unbuilt on every run
  const built = new Set(
    workspaces(ROOT)
      .filter(({ pkg }) => pkg.scripts?.build)
      .map(({ pkg }) => pkg.name),
  )
  const missing = unbuilt(
    testSpecifiers(sources, built, types).filter(
      (specifier) => specifier.startsWith("generated/") || built.has(packageOf(specifier)),
    ),
    ROOT,
    types ? {} : importedNames(sources),
    (specifier) => builtFile(specifier, ROOT, conditions),
  )
  // a test's child process may load code no source names (a path read at run time, an aliased spawn), so test:file also builds every shared package whose dist is missing, whatever its files import; a dist that is present stays as it is
  if (!types) {
    const named = new Set(missing.map(packageOf))
    missing.push(
      ...workspaces(ROOT)
        .filter(
          ({ dir, path, pkg }) =>
            pkg.scripts?.build &&
            /^(?:api|packages)\//.test(dir) &&
            !existsSync(join(path, "dist")) &&
            !named.has(packageOf(dir)),
        )
        .map(({ dir }) => `${dir}/dist`)
        .sort(),
    )
  }
  return prebuild(types ? "check-types:tests" : "test:file", missing)
}

if (import.meta.main) {
  const [target = "verify", ...rest] = process.argv.slice(2)
  if (target === "tests")
    process.exit(
      await prebuildTests(
        rest.filter((arg) => arg !== "--types"),
        rest.includes("--types"),
      ),
    )
  const sources = await sourcesIn(target)
  process.exit(
    prebuild(target, unbuilt(workspaceImports(sources), dirOf(target), importedNames(sources))),
  )
}
