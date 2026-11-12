import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { PLAYGROUND_AGENT, quarantine, type Roots } from "@packages/safe-delete"
import {
  CORE,
  type Fill,
  importedJob,
  loginOf,
  orgJobs,
  plistProgram,
  readPolicyFile,
  readRendered,
  renderJobs,
  scopesIn,
  scriptFilesOf,
  settingRows,
} from "@packages/settings"

import { engineDataOf } from "../ops-job/job"
import { dashboardPath } from "./probe"

const USAGE =
  "usage: bun packages/scripts/src/playground/jobs.ts render --jobs <jobs.json> [--launch-agents <dir>] [--install <dir>] [--data <dir>]"

const CHECKOUT = resolve(import.meta.dir, "../../../..")

const writeIfChanged = (path: string, text: string, mode = 0o644): boolean => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode })
  renameSync(temp, path)
  return true
}

// Each org's script files, <org>/scripts/<key>/<path>, by org; the login's own scripts and core's are not an org's.
const orgScripts = (data: string, login: string): Map<string, string[][]> =>
  new Map(
    scopesIn(data)
      .filter((scope) => scope !== login && scope !== CORE)
      .map((org) => [org, scriptFilesOf(data, org)]),
  )

// Each org's script folder, <org>/scripts/<key>/, into <data>/ops/<key>/, beside the state its job keeps there, which no item holds and this never touches; a file the extensions cannot vouch for is left as it was, with the reason on stderr.
const installScripts = async (
  data: string,
  scripts: Map<string, string[][]>,
  err: (line: string) => void,
): Promise<string[]> => {
  const changed: string[] = []
  for (const [org, files] of scripts)
    for (const parts of files) {
      const file = parts.join("/")
      const read = await readRendered(data, `${org}/${file}`)
      if (!read.path) {
        err(`jobs: ${read.refusal ?? `no ${org}/${file}`}`)
        continue
      }
      const to = parts.slice(1).join("/")
      const text = readFileSync(read.path, "utf8")
      if (writeIfChanged(join(data, "ops", to), text, to.endsWith(".sh") ? 0o755 : 0o644))
        changed.push(to)
    }
  return changed
}

// The folder launchd loads each agent from at login (HOME's LaunchAgents), its gui domain's uid and the launchctl that loads into it, which a test fakes.
export type Install = {
  agents: string
  launchctl: (args: string[]) => Promise<{ code: number; out: string }>
  uid: number
}

// Each enabled launchd job launchd has not loaded gets its rendered plist in install's folder when none is there, and is bootstrapped, so a refused bootstrap is tried again on the next pass; each turned-off one has its plist there, if any, moved to the trash through the jobs-installed carve-out, then is booted out while launchd holds it, so a refused bootout is tried again too. A plist already there stays as it stands, since its PATH line differs with each shell the runner starts from and a rewrite would restart the job. A label that is not Playground's own (PLAYGROUND_AGENT) is left alone, so no other app's agent is loaded or stopped.
const installAgents = async (
  install: Install,
  jobs: Record<string, unknown>[],
  plists: Map<string, string>,
  roots: Roots,
  changed: string[],
  err: (line: string) => void,
): Promise<number> => {
  let code = 0
  const domain = `gui/${install.uid}`
  for (const job of jobs) {
    const label = job.launchd
    if (typeof label !== "string" || !PLAYGROUND_AGENT.test(`${label}.plist`)) continue
    const path = join(install.agents, `${label}.plist`)
    const text = plists.get(label)
    const on = Boolean(text) && job.disabled !== true
    if (!on && job.disabled !== true) continue
    const loaded = (await install.launchctl(["print", `${domain}/${label}`])).code === 0
    if (on && !loaded) {
      if (!existsSync(path)) writeIfChanged(path, text!)
      const started = await install.launchctl(["bootstrap", domain, path])
      if (started.code === 0) changed.push(`+${label}`)
      else {
        err(`jobs: refused bootstrap of ${label}, exit ${started.code}: ${started.out.trim()}`)
        code = 1
      }
    } else if (!on) {
      // the plist goes first, since the bootout of the job this render runs under (ops-tick's) ends it inside that call
      let gone = false
      if (existsSync(path)) {
        const moved = quarantine(
          path,
          { carveOut: "jobs-installed", reason: "its launchd job is turned off", session: "jobs" },
          roots,
        )
        if ("refused" in moved) {
          err(`jobs: kept ${path}: ${moved.refused}`)
          code = 1
        } else gone = true
      }
      if (loaded) {
        const stopped = await install.launchctl(["bootout", `${domain}/${label}`])
        if (stopped.code === 0) gone = true
        else {
          err(`jobs: refused bootout of ${label}, exit ${stopped.code}: ${stopped.out.trim()}`)
          code = 1
        }
      }
      if (gone) changed.push(`-${label}`)
    }
  }
  return code
}

// The ops runner's render, at the top of each pass: jobs.json and each enabled launchd job's plist from the store's policy.json and each org's own job rows (orgJobs), and each org's script folders installed under ops; each org row refused is a `jobs: refused` line on stderr, and when the orgs cannot be read their jobs stay as jobs.json had them, said in a `jobs: kept` line, the render exiting 1 with everything else written. Exits 3 with jobs.json untouched on a machine with no store whose jobs.json is there (a fresh one gets the registry's defaults, the Dashboard's job and the usage read on, as does a store with no policy.json yet), and 2 on stderr when policy.json or jobs.json does not parse, so the runner keeps the last jobs.json and logs why. Rendered plists go into the folder it is handed; one for a job now off moves to the trash through the jobs carve-out, and one the trash refuses stays, named on stderr, the render exiting 1 with everything else written. With install, each launchd job turned on or off is installed or removed there too (installAgents).
export const renderJobsFile = async (
  options: {
    data: string
    fill: Fill
    install?: Install
    jobs: string
    launchAgents?: string
    roots: Roots
  },
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> => {
  const read = readPolicyFile(options.data)
  if (!read.path && existsSync(options.jobs)) return 3
  let values: Record<string, unknown>
  let existing: Record<string, unknown> = {}
  try {
    values = read.path ? (JSON.parse(readFileSync(read.path, "utf8")).values ?? {}) : {}
    if (existsSync(options.jobs)) existing = JSON.parse(readFileSync(options.jobs, "utf8"))
  } catch (error) {
    err(`jobs: ${(error as Error).message}`)
    return 2
  }
  const listed = Array.isArray(existing.jobs) ? (existing.jobs as { name?: unknown }[]) : []
  let scripts = new Map<string, string[][]>()
  // null when the orgs cannot be read, so each org's job stays as the last jobs.json had it
  let org: ReturnType<typeof orgJobs> | null = { jobs: {}, refused: [] }
  if (read.path)
    try {
      const login = loginOf(options.data)
      scripts = orgScripts(options.data, login)
      const keys = [...scripts].map(([name, files]) => [name, files.map((parts) => parts[1]!)])
      org = orgJobs(settingRows(options.data), login, Object.fromEntries(keys))
    } catch (error) {
      org = null
      err(
        `jobs: kept each org's job as jobs.json had it, since the orgs could not be read: ${(error as Error).message}`,
      )
    }
  for (const line of org?.refused ?? []) err(line)
  const { jobs, plists } = renderJobs(values, listed, options.fill, org?.jobs ?? null)
  const changed = [
    writeIfChanged(options.jobs, `${JSON.stringify({ ...existing, jobs }, null, 2)}\n`)
      ? "jobs.json"
      : "",
    ...(await installScripts(options.data, scripts, err)),
  ]
  let code = !org || org.refused.length ? 1 : 0
  if (options.launchAgents) {
    for (const [label, text] of plists)
      if (writeIfChanged(join(options.launchAgents, `${label}.plist`), text)) changed.push(label)
    for (const file of existsSync(options.launchAgents) ? readdirSync(options.launchAgents) : [])
      if (file.startsWith("com.playground.") && !plists.has(file.replace(/\.plist$/, ""))) {
        const moved = quarantine(
          join(options.launchAgents, file),
          { carveOut: "jobs", reason: "its job left jobs.json", session: "jobs" },
          options.roots,
        )
        if ("refused" in moved) {
          err(`jobs: kept ${file}: ${moved.refused}`)
          code = 1
        } else changed.push(`-${file}`)
      }
  }
  if (options.install)
    code = Math.max(
      code,
      await installAgents(options.install, jobs, plists, options.roots, changed, err),
    )
  const lines = changed.filter(Boolean)
  out(lines.length ? `jobs: rendered ${lines.join(", ")}` : "jobs: unchanged")
  return code
}

// playground settings import-jobs, run once at the switch: each job jobs.json lists that the registry knows becomes its jobs.<camelName> setting, a launchd job's program read from its plist; a job the registry does not know stays in jobs.json, which the render keeps.
export const importJobs = async (
  file: string,
  options: { dryRun: boolean; launchAgents?: string; scope: string },
  set: (key: string, value: unknown, reason: string) => unknown,
  out: (line: string) => void,
): Promise<number> => {
  const listed = (JSON.parse(readFileSync(file, "utf8")).jobs ?? []) as Record<string, unknown>[]
  const agents = options.launchAgents ?? join(homedir(), "Library", "LaunchAgents")
  const reason = `imported from ${file} at the switch`
  const scope = options.scope
  let problems = 0
  for (const job of listed) {
    const plist = join(agents, `${String(job.launchd)}.plist`)
    const read = job.launchd && existsSync(plist) ? plistProgram(readFileSync(plist, "utf8")) : null
    const imported = importedJob(job, read)
    if ("kept" in imported)
      out(`kept ${imported.kept}: the registry does not know it, so jobs.json keeps it`)
    else if ("problem" in imported) {
      problems++
      out(`refused ${imported.problem}`)
    } else {
      if (!options.dryRun) set(imported.key, imported.value, reason)
      out(
        `${options.dryRun ? "would set" : "set"} ${imported.key} at ${scope}, ${imported.value.enabled ? "on" : "off"}`,
      )
    }
  }
  return problems ? 1 : 0
}

export const jobsExit = async (
  argv: string[],
  environment: Record<string, string | undefined>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: argv,
      options: {
        data: { type: "string" },
        install: { type: "string" },
        jobs: { type: "string" },
        "launch-agents": { type: "string" },
      },
    })
  } catch (error) {
    err(`${(error as Error).message}\n${USAGE}`)
    return 2
  }
  const { positionals, values } = parsed
  if (positionals[0] !== "render" || !values.jobs) {
    err(USAGE)
    return 2
  }
  const found = engineDataOf(argv, CHECKOUT, environment)
  if ("refusal" in found) {
    err(`jobs: ${found.refusal}`)
    return 2
  }
  return renderJobsFile(
    {
      data: found.data,
      fill: {
        bun: process.execPath,
        checkout: CHECKOUT,
        dashboard: dashboardPath(CHECKOUT),
        data: found.data,
        path: environment.PATH ?? "/usr/bin:/bin",
      },
      install: values.install
        ? {
            agents: values.install,
            launchctl: async (args) => {
              const done = Bun.spawnSync(["launchctl", ...args])
              return {
                code: done.exitCode,
                out: `${done.stdout.toString()}${done.stderr.toString()}`,
              }
            },
            uid: process.getuid!(),
          }
        : undefined,
      jobs: values.jobs,
      launchAgents: values["launch-agents"],
      roots: {
        home: environment.HOME ?? homedir(),
        main: CHECKOUT,
        trash: join(found.data, "trash"),
      },
    },
    out,
    err,
  )
}

if (import.meta.main)
  process.exit(await jobsExit(process.argv.slice(2), process.env, console.log, console.error))
