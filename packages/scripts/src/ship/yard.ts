// ship:yard <tag>: deploys the hosted Yard from a ship's tag, its API and then its web, checking the live host after each and recording the tag it deployed.
import { registryName, rosterKind } from "../../../../scripts/hooks/role"
import { claudeAbove, type Proc, procOf } from "../../../../scripts/hooks/session-state"

export type Project = "api" | "web"

export type YardIo = {
  changed: (from: string, to: string) => Promise<string[]>
  deploy: (project: Project, dir: string) => Promise<boolean>
  drop: (dir: string) => Promise<void>
  err: (line: string) => void
  fetch: (tags: string[]) => Promise<void>
  launch: () => Promise<Launch>
  out: (line: string) => void
  readRecord: () => Promise<string | undefined>
  status: (url: string) => Promise<number>
  worktree: (tag: string) => Promise<string>
  writeRecord: (tag: string) => Promise<void>
}

// The call's launch, as the claude process it runs under was started: that process's PLAYGROUND_ROLE, the roster's kind for its session's registry name, and what the walk found.
export type Launch = { found: string; kind?: string; role?: string }

// The Ops lead's launch, which no-raw-vercel's pass keys on too: the lead role and the ops kind, so a call by any runner, copy or link of this file stops here unless the Ops lead's claude process runs it.
export const opsLaunch = (launch: Launch): boolean =>
  launch.role === "lead" && launch.kind === "ops"

// The launch of the claude process above this call (session-state's walk), each folder read from that process's own environment and never this one's, so a prefix, an export or env on the call changes none of it; a walk that finds no claude process, or a registry or roster it cannot read, names no kind.
export async function launchAbove(
  pid: number = process.ppid,
  procs: (pid: number) => Proc | undefined = procOf,
): Promise<Launch> {
  const above = await claudeAbove(pid, procs)
  if (!above) return { found: "no Claude Code process above this call" }
  const at = `the claude process ${above.pid}`
  if (!above.sessionId || !above.config)
    return { found: `${at}, whose session its registry does not name`, role: above.role }
  if (!above.env.PLAYGROUND_DATA_DIR && !above.env.HOME)
    return { found: `${at}, which names no data folder`, role: above.role }
  const own = {
    CLAUDE_CONFIG_DIR: above.config,
    HOME: above.env.HOME,
    PLAYGROUND_DATA_DIR: above.env.PLAYGROUND_DATA_DIR,
  }
  const name = await registryName(above.sessionId, own).catch(() => undefined)
  if (!name) return { found: `${at}, whose registry it cannot read`, role: above.role }
  return { found: `${at}, session ${name}`, kind: await rosterKind(name, own), role: above.role }
}

export type YardHosts = Record<Project, string>

export type YardArgs = { schemaCleared?: string; since?: string; tag: string }

// The API first, since its build applies the migrations the web's code reads.
export const ORDER: Project[] = ["api", "web"]

// A route a bot reads with its token, which answers 401 without one, so a deploy that serves Yard's router with its auth reads right.
export const BOT_ROUTE = "/api/v1/yard/channels"

// What a deploy migrates: the API's build applies packages/db's migrations (migrate-on-deploy.ts), which the schema's files write.
const SCHEMA = /^packages\/db\/(?:drizzle|src\/schema)\//

export const schemaChanges = (files: string[]): string[] =>
  files.filter((file) => SCHEMA.test(file))

// The live host's two checks, each its URL and the status it answers when the deploy serves.
export const hostChecks = (host: string): [string, number][] => [
  [`${host}/api/health`, 200],
  [`${host}${BOT_ROUTE}`, 401],
]

export async function shipYard(args: YardArgs, hosts: YardHosts, io: YardIo): Promise<number> {
  const launch = await io.launch()
  if (!opsLaunch(launch)) {
    io.err(
      `ship:yard: the step deploys production, so it runs for the Ops lead's claude process alone (PLAYGROUND_ROLE lead, the roster's ops kind); this call runs under ${launch.found}, whose PLAYGROUND_ROLE is ${launch.role || "unset"} and kind ${launch.kind || "unknown"}`,
    )
    return 1
  }
  const recorded = await io.readRecord()
  if (recorded === args.tag) {
    io.out(`ship:yard: ${args.tag} is already deployed, by ops/yard-tag`)
    return 0
  }
  const since = recorded ?? args.since
  if (!since) {
    io.err(
      "ship:yard: no ops/yard-tag record in the data folder, so the step cannot tell what it deploys over: run it again with --since <the tag live now>, once, and the record takes over",
    )
    return 1
  }
  // step 4 makes the tag on GitHub alone, so the step fetches both tags before it reads them
  await io.fetch([since, args.tag])
  const schema = schemaChanges(await io.changed(since, args.tag))
  if (schema.length && !args.schemaCleared) {
    io.err(
      `ship:yard: ${args.tag} changes the schema since ${since} (${schema.join(", ")}), which the API's build migrates: take it through the db-migration skill's step 0 first, then run again with --schema-cleared <Inbox id> naming that decision`,
    )
    return 1
  }
  const dir = await io.worktree(args.tag)
  try {
    for (const project of ORDER) {
      if (!(await io.deploy(project, dir))) {
        io.err(`ship:yard: the ${project} deploy failed, so the step stops here`)
        return 1
      }
      for (const [url, want] of hostChecks(hosts[project])) {
        const got = await io.status(url)
        if (got !== want) {
          io.err(`ship:yard: after the ${project} deploy, ${url} answered ${got}, not ${want}`)
          return 1
        }
      }
      io.out(`ship:yard: ${project} deployed from ${args.tag}, its live checks pass`)
    }
    await io.writeRecord(args.tag)
    return 0
  } finally {
    await io.drop(dir)
  }
}

const KEYS = [
  "YARD_API_URL",
  "YARD_VERCEL_API_PROJECT_ID",
  "YARD_VERCEL_TEAM_ID",
  "YARD_VERCEL_WEB_PROJECT_ID",
  "YARD_WEB_URL",
] as const

const USAGE = `usage: bun run ship:yard <tag> [--since <tag>] [--schema-cleared <Inbox id>]

Deploys the hosted Yard from <tag>, the ship's tag: its API, then its web, each with
vercel deploy --prod from a detached worktree at the tag, fetched from origin, checking
the live host after each (/api/health answers 200, ${BOT_ROUTE} answers 401 with no
token), then records the tag in the data folder's ops/yard-tag and removes the worktree.
It runs under the Ops lead's claude process alone (its PLAYGROUND_ROLE lead, the roster's
ops kind), read from that process and never this call's environment. It stops
when the tag changes packages/db's schema or migrations since the recorded tag, until
--schema-cleared names the db-migration step 0 decision, and with no record until
--since names the tag live now.
The ids and hosts come from the environment, else the live dashboard checkout's .env:
${KEYS.join(", ")}.`

if (import.meta.main) {
  const { parseArgs } = await import("node:util")
  const { dirname, join } = await import("node:path")
  const { mkdirSync } = await import("node:fs")
  const { dataDir } = await import("../../../env/src/data-dir")
  const { dashboardCheckout } = await import("../playground/probe")
  const { setting } = await import("../playground/yard")
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { short: "h", type: "boolean" },
      "schema-cleared": { type: "string" },
      since: { type: "string" },
    },
  })
  const [tag] = positionals
  if (values.help || !tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.log(USAGE)
    process.exit(values.help ? 0 : 2)
  }
  const repo = join(import.meta.dir, "..", "..", "..", "..")
  const live = dashboardCheckout(repo)
  const read = Object.fromEntries(
    await Promise.all(KEYS.map(async (key) => [key, await setting(key, live)] as const)),
  ) as Record<(typeof KEYS)[number], string | undefined>
  const missing = KEYS.filter((key) => !read[key])
  if (missing.length) {
    console.error(
      `ship:yard: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} unset in the environment and the live dashboard checkout's .env`,
    )
    process.exit(1)
  }
  const git = (args: string[]) => {
    const ran = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "pipe", stdout: "pipe" })
    if (ran.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString().trim()}`)
    return ran.stdout.toString()
  }
  const record = join(dataDir(), "ops", "yard-tag")
  // the main checkout's worktrees folder, beside the common git dir, so a run from a worktree nests none
  const worktrees = join(
    dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()),
    ".claude",
    "worktrees",
  )
  const projects = { api: read.YARD_VERCEL_API_PROJECT_ID!, web: read.YARD_VERCEL_WEB_PROJECT_ID! }
  const io: YardIo = {
    changed: async (from, to) => git(["diff", "--name-only", from, to]).split("\n").filter(Boolean),
    deploy: async (project, dir) => {
      const ran = Bun.spawn(["vercel", "deploy", "--prod", "--yes"], {
        cwd: dir,
        env: {
          ...process.env,
          VERCEL_ORG_ID: read.YARD_VERCEL_TEAM_ID!,
          VERCEL_PROJECT_ID: projects[project],
        },
        stderr: "inherit",
        stdout: "inherit",
      })
      return (await ran.exited) === 0
    },
    // a plain remove, which keeps the folder when it holds a change, and says so
    drop: async (dir) => {
      try {
        git(["worktree", "remove", dir])
      } catch (error) {
        console.error(`ship:yard: ${dir} stays: ${(error as Error).message}`)
      }
    },
    err: console.error,
    fetch: async (tags) => {
      git(["fetch", "--quiet", "origin", ...tags.flatMap((tag) => ["tag", tag])])
    },
    launch: () => launchAbove(),
    out: console.log,
    readRecord: async () => {
      const file = Bun.file(record)
      return (await file.exists()) ? (await file.text()).trim() || undefined : undefined
    },
    status: async (url) =>
      fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
        .then((response) => response.status)
        .catch(() => 0),
    worktree: async (at) => {
      const dir = join(worktrees, `yard-ship-${at}`)
      const sha = git(["rev-parse", `${at}^{commit}`]).trim()
      if (!(await Bun.file(join(dir, ".git")).exists()))
        git(["worktree", "add", "--detach", dir, sha])
      else if (git(["-C", dir, "rev-parse", "HEAD"]).trim() !== sha)
        throw new Error(`${dir} holds another commit than ${at}`)
      return dir
    },
    writeRecord: async (at) => {
      mkdirSync(join(dataDir(), "ops"), { recursive: true })
      await Bun.write(record, `${at}\n`)
    },
  }
  process.exit(
    await shipYard(
      { schemaCleared: values["schema-cleared"], since: values.since, tag },
      { api: read.YARD_API_URL!, web: read.YARD_WEB_URL! },
      io,
    ),
  )
}
