import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"

import { withoutShebang } from "../shebang"
import { userSystemctl } from "../user-systemctl"

export type Run = (argv: string[]) => Promise<{ code: number; out: string }>

type Job = {
  command?: string
  disabled?: boolean
  heartbeat: string
  launchd?: string
  name: string
  stop?: string
}

// ops-herdr starts every herdr server, so a restart of it is Ops' call; ops-dashboard (stop: dashboard) rolls onto its own checkout's code itself.
const kept = (job: Job) => job.name === "ops-herdr" || job.stop === "dashboard"

const entryOf = (argv: string[]) =>
  argv
    .map((word) => word.replace(/^~\//, `${homedir()}/`))
    .find((word) => word.startsWith("/") && !/\/(bash|bun|env|python3)$/.test(word))

// A job's entry file: the first path in its jobs.json command, or, for a launchd job, in its plist's ProgramArguments, on Linux in its systemd user unit's ExecStart as systemd loaded it.
const entry = async (job: Job, run: Run, platform: NodeJS.Platform) => {
  if (job.command) return entryOf(job.command.split(/\s+/))
  if (!job.launchd) return undefined
  if (platform === "linux") {
    const unit = `${job.launchd}.service`
    const shown = await run(userSystemctl(["show", "--property=ExecStart", "--value", unit]))
    const argv = /argv\[\]=([^;]*)/.exec(shown.out)?.[1]
    return shown.code === 0 && argv ? entryOf(argv.trim().split(/\s+/)) : undefined
  }
  const plist = join(homedir(), "Library", "LaunchAgents", `${job.launchd}.plist`)
  const read = await run(["plutil", "-convert", "json", "-o", "-", plist])
  if (read.code !== 0) return undefined
  return entryOf((JSON.parse(read.out) as { ProgramArguments?: string[] }).ProgramArguments ?? [])
}

const resolveTs = (from: string, spec: string) => {
  const base = join(dirname(from), spec)
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  )
}

// What a job runs, as checkout-relative paths (a folder ends in /): the entry's folder, each repo file it imports, followed through TypeScript's relative imports, and each workspace package it imports whole, with the workspace packages that package depends on.
export const sourceOf = (checkout: string, file: string): string[] => {
  const found = new Set([`${relative(checkout, dirname(file))}/`])
  const seen = new Set<string>()
  const pkg = (name: string) => {
    if (found.has(`packages/${name}/`)) return
    found.add(`packages/${name}/`)
    let deps: Record<string, string> = {}
    try {
      deps = JSON.parse(
        readFileSync(join(checkout, "packages", name, "package.json"), "utf8"),
      ).dependencies
    } catch {}
    for (const dep of Object.keys(deps ?? {}))
      if (dep.startsWith("@packages/")) pkg(dep.slice("@packages/".length))
  }
  const walk = (path: string) => {
    if (seen.has(path) || !path.startsWith(`${checkout}/`)) return
    seen.add(path)
    found.add(relative(checkout, path))
    const text = readFileSync(path, "utf8")
    if (path.endsWith(".py")) {
      const mods = [
        ...[...text.matchAll(/^\s*from\s+(\w+)\s+import\b/gm)].map((m) => m[1]!),
        ...[...text.matchAll(/^\s*import\s+([\w, ]+)/gm)].flatMap((m) => m[1]!.split(",")),
      ]
      for (const mod of mods) {
        const near = [dirname(path), dirname(dirname(path))].map((dir) =>
          join(dir, `${mod.trim()}.py`),
        )
        const hit = near.find((p) => existsSync(p))
        if (hit) walk(hit)
      }
      return
    }
    if (!/\.tsx?$/.test(path)) return
    for (const { path: spec } of new Bun.Transpiler({
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
    }).scanImports(withoutShebang(text))) {
      const ws = spec.match(/^@packages\/([^/]+)/)
      if (ws) pkg(ws[1]!)
      else if (spec.startsWith(".")) {
        const hit = resolveTs(path, spec)
        if (hit) walk(hit)
      }
    }
  }
  walk(file)
  return [...found]
}

const beatPid = (ops: string, job: Job) => {
  try {
    return Number(JSON.parse(readFileSync(join(ops, `${job.heartbeat}.json`), "utf8")).pid) || 0
  } catch {
    return 0
  }
}

const holds = async (run: Run, pid: number, file: string) =>
  (await run(["ps", "-o", "command=", "-p", String(pid)])).out.includes(file)

// TERM the pid, then wait up to 60s for it to stop running the entry; true once it has
const stop = async (run: Run, pid: number, file: string, sleep: (ms: number) => Promise<void>) => {
  await run(["kill", "-TERM", String(pid)])
  for (let i = 0; i < 60; i++) {
    if (!(await holds(run, pid, file))) return true
    await sleep(1000)
  }
  return !(await holds(run, pid, file))
}

// After a checkout moved from one head to another, render jobs.json from the settings with the new code, TERM each running ops job whose source the move changed, by its heartbeat's pid, then start the terminal ones again in herdr, and any the new code turns on that runs nowhere yet, with one up.py pass; launchd, or on Linux systemd, starts its own.
export const restart = async (opts: {
  checkout: string
  from: string
  ops: string
  platform?: NodeJS.Platform
  run: Run
  sleep?: (ms: number) => Promise<void>
  to: string
}): Promise<string[]> => {
  const { checkout, ops, platform = process.platform, run, sleep = Bun.sleep } = opts
  const diff = await run(["git", "-C", checkout, "diff", "--name-only", opts.from, opts.to])
  const changed = diff.out.split("\n").filter(Boolean)
  if (diff.code !== 0 || !changed.length) return []
  const list = join(ops, "jobs.json")
  if (!existsSync(list)) return [`no ${list}, so no job to restart`]
  // up.py's own render, so a job whose default the move turned on reads as on; a refused render keeps the last jobs.json
  await run([
    process.execPath,
    "--no-env-file",
    join(checkout, "packages", "scripts", "src", "playground", "jobs.ts"),
    "render",
    "--data",
    dirname(ops),
    "--jobs",
    list,
    "--launch-agents",
    join(ops, "launch-agents"),
  ])
  const jobs = (JSON.parse(readFileSync(list, "utf8")) as { jobs: Job[] }).jobs
  const lines: string[] = []
  const stopped: Job[] = []
  for (const job of jobs) {
    if (job.disabled || kept(job)) continue
    const file = await entry(job, run, platform)
    if (!file || !existsSync(file)) continue
    // an entry linked into the checkout (ops-checks-go's go.py) counts by its target, while holds() matches the link path its argv names
    const real = realpathSync(file)
    if (!real.startsWith(`${checkout}/`)) continue
    const source = sourceOf(checkout, real)
    if (!changed.some((f) => source.some((s) => (s.endsWith("/") ? f.startsWith(s) : f === s))))
      continue
    const pid = beatPid(ops, job)
    if (!(pid > 1 && (await holds(run, pid, file))))
      lines.push(
        `${job.name}: source changed, but no running copy of ${file} holds its heartbeat's pid; left alone`,
      )
    else if (await stop(run, pid, file, sleep)) {
      stopped.push(job)
      lines.push(`${job.name}: source changed, stopped pid ${pid}`)
    } else lines.push(`${job.name}: source changed, but pid ${pid} still runs after 60s`)
  }
  const ours = stopped.filter((job) => !job.launchd)
  if (!ours.length) {
    const down: Job[] = []
    for (const job of jobs) {
      if (job.disabled || kept(job) || job.launchd || !job.command) continue
      const pid = beatPid(ops, job)
      if (!(pid > 1 && (await run(["ps", "-p", String(pid)])).code === 0)) down.push(job)
    }
    if (!down.length) return lines
    const up = await run(["python3", "-I", join(checkout, "scripts", "ops", "up.py")])
    lines.push(
      `${down.map((job) => job.name).join(", ")}: on, but not running; up.py exited ${up.code}${up.out.trim() ? `: ${up.out.trim()}` : ""}`,
    )
    return lines
  }
  // up.py skips a job it started within GRACE (10 minutes), so --restarted drops each stopped job's start under its lock, and the pass judges it by its health
  const up = await run([
    "python3",
    "-I",
    join(checkout, "scripts", "ops", "up.py"),
    "--restarted",
    ours.map((job) => job.name).join(","),
  ])
  lines.push(`up.py exited ${up.code}${up.out.trim() ? `: ${up.out.trim()}` : ""}`)
  return lines
}
