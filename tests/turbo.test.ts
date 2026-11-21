import { describe, expect, test } from "bun:test"
import { dirname, join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..")
const SCRIPTS = join(ROOT, "packages/scripts/src")

type Task = { cache?: boolean; dependsOn?: string[]; inputs?: string[]; outputs?: string[] }
type Turbo = {
  globalDependencies?: string[]
  globalEnv?: string[]
  globalPassThroughEnv?: string[]
  tasks: Record<string, Task>
}

const readTurbo = async () =>
  Bun.JSONC.parse(await Bun.file(join(ROOT, "turbo.json")).text()) as Turbo

const imports = async (file: string, seen = new Set<string>()): Promise<Set<string>> => {
  if (seen.has(file)) return seen
  seen.add(file)
  const text = await Bun.file(join(SCRIPTS, file)).text()
  for (const [, spec] of text.matchAll(/from "(\.\.?\/[^"]+)"/g)) {
    const target = relative(SCRIPTS, join(SCRIPTS, dirname(file), spec))
    if (!target.startsWith(".."))
      await imports(target.endsWith(".ts") ? target : `${target}.ts`, seen)
  }
  return seen
}

const generators = async (scripts: Record<string, string>, name: string): Promise<Set<string>> => {
  const line = scripts[name] ?? ""
  const files = new Set<string>()
  for (const [, file] of line.matchAll(/(?:\.\.\/)+(?:packages\/)?scripts\/src\/(\S+\.ts)/g))
    for (const each of await imports(file)) files.add(each)
  for (const [, other] of line.matchAll(/\bbun run (?:--bun )?([\w:-]+)/g))
    for (const each of await generators(scripts, other)) files.add(each)
  return files
}

const workspaceTasks = async (turbo: Turbo) => {
  const found: { dependsOn: string[]; generators: string[]; id: string; linked: boolean }[] = []
  for await (const path of new Bun.Glob("{api,packages,web}/*/package.json").scan(ROOT)) {
    const pkg = await Bun.file(join(ROOT, path)).json()
    const scripts: Record<string, string> = pkg.scripts ?? {}
    const linked = "@packages/scripts" in { ...pkg.dependencies, ...pkg.devDependencies }
    for (const script of Object.keys(scripts)) {
      const task = turbo.tasks[`${pkg.name}#${script}`] ?? turbo.tasks[script]
      if (!task || task.cache === false) continue
      const files = [...(await generators(scripts, script))].sort()
      if (files.length)
        found.push({
          dependsOn: task.dependsOn ?? [],
          generators: files,
          id: `${pkg.name}#${script}`,
          linked,
        })
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

type DryTask = { dependencies: string[]; inputs: Record<string, string>; taskId: string }
const dry = new Map<string, DryTask[]>()
const dryRun = (filter = "@web/next") => {
  const cached = dry.get(filter)
  if (cached) return cached
  const run = Bun.spawnSync(
    ["bunx", "turbo", "run", "check-types", "build", `--filter=${filter}`, "--dry=json"],
    { cwd: ROOT, env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } },
  )
  expect(run.exitCode).toBe(0)
  const tasks = (JSON.parse(run.stdout.toString()) as { tasks: DryTask[] }).tasks
  dry.set(filter, tasks)
  return tasks
}

// Every file outside packages/scripts that its sources reach by relative import, following those files' own relative imports, less the workspace packages it declares, which turbo's graph already hashes in
const outside = async () => {
  const pkg = await Bun.file(join(SCRIPTS, "..", "package.json")).json()
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => name.startsWith("@packages/"))
    .map((name) => `packages/${name.slice("@packages/".length)}/`)
  const resolve = async (from: string, spec: string) => {
    const path = relative(ROOT, join(ROOT, dirname(from), spec))
    for (const each of [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`])
      if (await Bun.file(join(ROOT, each)).exists()) return each
  }
  const found = new Set<string>()
  const walk = async (file: string) => {
    if (!/\.tsx?$/.test(file)) return
    for (const [, spec] of (await Bun.file(join(ROOT, file)).text()).matchAll(
      /(?:from\s+|import\(\s*)["'](\.\.?\/[^"']+)["']/g,
    )) {
      const target = await resolve(file, spec!)
      if (!target || target.startsWith("packages/scripts/") || found.has(target)) continue
      if (declared.some((folder) => target.startsWith(folder))) continue
      found.add(target)
      await walk(target)
    }
  }
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(SCRIPTS))
    await walk(`packages/scripts/src/${file}`)
  return [...found].sort()
}

describe("turbo.json", () => {
  // #700: a global packages/scripts/src/** glob moved every task's hash on any edit there, so 4 in 10 merges sent each worktree's next commit build cold
  test("no packages/scripts/src glob is a global dependency, so an edit to a script no build runs keeps every build's cache", async () => {
    const { globalDependencies = [] } = await readTurbo()
    expect(globalDependencies.filter((entry) => entry.includes("packages/scripts"))).toEqual([])
  })

  // turbo runs the tasks in strict env mode, so a PLAYGROUND_* value the stack's starter exports reaches the API only through one of the two global lists; the API's process is what the Dashboard's Start button spawns every session from
  test("every PLAYGROUND_* name spawn.sh reads from its environment is on turbo's global pass-through lists", async () => {
    const turbo = await readTurbo()
    const script = await Bun.file(join(ROOT, "scripts/spawn.sh")).text()
    // a shell parameter read (${PLAYGROUND_X:-default} or $PLAYGROUND_X) or a gate's os.environ read, in its get, getenv and bracket forms; names spawn.sh only sets for a child, or names in prose, are not reads
    const reads = [
      ...new Set(
        [
          ...script.matchAll(/\$\{?(PLAYGROUND_[A-Z0-9_]+)/g),
          ...script.matchAll(/os\.(?:environ\.get|getenv)\(.(PLAYGROUND_[A-Z0-9_]+)./g),
          ...script.matchAll(/os\.environ\[.(PLAYGROUND_[A-Z0-9_]+)./g),
        ].map((match) => match[1]!),
      ),
    ].sort()
    expect(reads.length).toBeGreaterThan(0)
    const passed = new Set([...(turbo.globalEnv ?? []), ...(turbo.globalPassThroughEnv ?? [])])
    expect(reads.filter((name) => !passed.has(name))).toEqual([])
  })

  // a task's temp folder is the caller's own TMPDIR, since turbo's strict mode drops it and a tool's os.tmpdir() falls back to /tmp, which Claude Code's sandbox gives a shell no write to (a build's mkdtemp there failed in a sandboxed trial)
  test("TMPDIR is on turbo's global pass-through list", async () => {
    const { globalPassThroughEnv = [] } = await readTurbo()
    expect(globalPassThroughEnv).toContain("TMPDIR")
  })

  test("globalPassThroughEnv stays in A to Z order", async () => {
    const { globalPassThroughEnv = [] } = await readTurbo()
    expect(globalPassThroughEnv).toEqual([...globalPassThroughEnv].sort())
  })

  // turbo folds @packages/scripts#build's hash into each dependent's through ^build, so that task's inputs decide which script edits rebuild web and auth
  test("every generator a cached task's script runs, and each file it imports, is an input of @packages/scripts#build, which the task depends on", async () => {
    const turbo = await readTurbo()
    const inputs = turbo.tasks["@packages/scripts#build"]?.inputs ?? []
    const tasks = await workspaceTasks(turbo)
    expect(tasks.map((task) => task.id)).toContain("@web/next#build")
    for (const { dependsOn, generators: files, id, linked } of tasks)
      expect({
        id,
        linked,
        missing: files.filter((file) => !inputs.includes(`src/${file}`)),
        upstream: dependsOn.includes("^build"),
      }).toEqual({
        id,
        linked: true,
        missing: [],
        upstream: true,
      })
  })

  test("every @packages/scripts#build input names a file that exists", async () => {
    const inputs = (await readTurbo()).tasks["@packages/scripts#build"]?.inputs ?? []
    const missing = []
    for (const input of inputs)
      if (!(await Bun.file(join(ROOT, "packages/scripts", input)).exists())) missing.push(input)
    expect(missing).toEqual([])
  })

  // next dev keeps its Turbopack cache in .next/dev, so a build output that takes in .next/** stores it in every snapshot, and a cache hit restores another state's dev cache over the checkout's.
  test("every outputs list that takes in .next leaves out next dev's cache", async () => {
    const turbo = await readTurbo()
    const web = Object.entries(turbo.tasks).filter(([, task]) => task.outputs?.includes(".next/**"))
    expect(web.map(([name]) => name).sort()).toEqual(["@web/next#build", "build", "build:vercel"])
    expect(web.filter(([, task]) => !task.outputs?.includes("!.next/dev/**"))).toEqual([])
  })

  // check-types writes and reads .next/types while next build deletes and rewrites it, so CI's `turbo run check-types build` fails on a missing ./routes.js when the two run side by side.
  test("web's build waits for web's check-types, so the two never share .next/types at once", () => {
    expect(dryRun().find((task) => task.taskId === "@web/next#build")?.dependencies).toContain(
      "@web/next#check-types",
    )
  }, 60_000)

  test("turbo hashes @packages/scripts#build from its manifest and listed generators alone, and web's and auth's builds take that hash", async () => {
    const listed = (await readTurbo()).tasks["@packages/scripts#build"]?.inputs ?? []
    const tasks = dryRun()
    const hashed = tasks.find((task) => task.taskId === "@packages/scripts#build")?.inputs ?? {}
    expect(Object.keys(hashed).sort()).toEqual(["package.json", ...listed].sort())
    for (const id of ["@packages/auth#build", "@web/next#build"])
      expect(tasks.find((task) => task.taskId === id)?.dependencies).toContain(
        "@packages/scripts#build",
      )
  }, 60_000)

  // turbo.json's comment on @packages/scripts#check-types says why these inputs are listed by name
  test("@packages/scripts#check-types hashes every file outside the package that its sources import", async () => {
    const imported = await outside()
    expect(imported).toContain("scripts/hooks/shell.ts")
    expect(imported).toContain("scripts/hooks/role.ts")
    const task = dryRun("@packages/scripts").find(
      (each) => each.taskId === "@packages/scripts#check-types",
    )
    const hashed = new Set(
      Object.keys(task?.inputs ?? {}).map((path) => relative(ROOT, join(SCRIPTS, "..", path))),
    )
    expect(imported.filter((file) => !hashed.has(file))).toEqual([])
  }, 60_000)
})
