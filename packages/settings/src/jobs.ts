import { z } from "zod"

// By relative path, as factory.ts imports, so the web's tests import it from outside the package.
import { CORE } from "./rendered"
import { defineSettings } from "./settings"

// The ops job registry: one setting per job, `jobs.<camelName>`, whose row holds the fields it changes (its enabled field alone, for a job turned on) and reads over the job's registry entry, so turning a job on, pausing it or moving its schedule is a settings write with a reason, never a PR, and the rest still follows the registry. The runner renders <data>/ops/jobs.json and each launchd job's plist from it at the top of every pass. A fresh install has every job off but the Dashboard's (ops-dashboard) and ops-usage, so the Dashboard shows the account's week with no setting. In a command, cwd or program, {bun}, {checkout} (the install's checkout), {dashboard} (the Dashboard's checkout, on live.branch) and {data} (the data folder) are filled in by the render.
// A job row as a write takes it, every field named and none it does not have; a stored row reads through fromStored first.
export const jobSchema = z.strictObject({
  callsModel: z.boolean(),
  // A job a terminal holds (herdr): its command, run from cwd.
  command: z.string().min(1).optional(),
  // The job's own settings, which core checks only for being an object; the job reads them from its jobs.json row and checks each field itself.
  config: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().min(1).optional(),
  description: z.string().min(1),
  disabledWhy: z.string().optional(),
  enabled: z.boolean(),
  heartbeat: z.string().min(1),
  // A job launchd holds: its label, and the program its plist runs from cwd.
  launchd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  neverPause: z.boolean().optional(),
  pausedFor: z.string().optional(),
  program: z.array(z.string().min(1)).min(1).optional(),
  // The terminal a job runs in: herdr, the one runtime.
  runtime: z.enum(["herdr"]).optional(),
  schedule: z.union([
    z.strictObject({ always: z.literal(true) }),
    z.strictObject({ every: z.number().int().positive() }),
  ]),
  // The process group name a job's stop keys on (procs.sh), for a job that holds a stack.
  stop: z.string().min(1).optional(),
})
export type Job = z.infer<typeof jobSchema>

// A stored job row as a read takes it, so no row an older install wrote loses its job: each key the schema does not name is dropped, and a runtime of any word reads as herdr; a write is checked by the schema alone, so a misspelled key is refused there.
export const fromStored = (row: unknown): unknown => {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row
  const kept = Object.fromEntries(
    Object.entries(row).filter(([key]) => Object.hasOwn(jobSchema.shape, key)),
  )
  return kept.runtime === undefined ? kept : { ...kept, runtime: "herdr" }
}

// A job's stored row: any of its fields, none it does not have, read over the registry's entry (settingsFor's merge).
const jobRowSchema = jobSchema.partial()

// A job's name as its setting key: ops-merge-train is jobs.opsMergeTrain.
export const jobKey = (name: string): string =>
  `jobs.${name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`

const terminal = (
  name: string,
  command: string,
  job: Partial<Job> & Pick<Job, "description" | "schedule">,
): Job => ({
  callsModel: false,
  command,
  cwd: "{checkout}",
  enabled: false,
  heartbeat: name,
  runtime: "herdr",
  ...job,
})

const launchd = (name: string, job: Pick<Job, "description" | "schedule">): Job => ({
  callsModel: false,
  cwd: "{checkout}",
  enabled: false,
  heartbeat: name,
  launchd: `com.playground.${name}`,
  program: ["{bun}", "--no-env-file", `{checkout}/packages/scripts/src/${name}/cli.ts`],
  ...job,
})

const bunJob = (name: string, root = "{checkout}") =>
  `{bun} --no-env-file ${root}/packages/scripts/src/${name}/cli.ts`

// The jobs Playground ships, each off until the owner turns it on but the Dashboard's own; A to Z.
export const JOBS: Record<string, Job> = {
  "ops-awake": terminal("ops-awake", `${bunJob("ops-awake")} --data {data}`, {
    description:
      "Keeps the Mac awake on AC power and on battery with caffeinate, display and lock unchanged.",
    schedule: { always: true },
  }),
  // Its sync runs in its script's checkout, so it runs from the Dashboard's, which holds the database's .env.
  "ops-changelog": terminal("ops-changelog", bunJob("ops-changelog", "{dashboard}"), {
    cwd: "{dashboard}",
    description: "Syncs new canary merges and main versions into the Changelog every 5 minutes.",
    schedule: { every: 300 },
  }),
  // The one job on by default: the Dashboard serves first run and every settings write, so a store with no row for it, or no store, keeps it running. It runs from the Dashboard's checkout, since its supervisor rolls the checkout it runs in and refuses any other branch.
  "ops-dashboard": terminal("ops-dashboard", "{dashboard}/scripts/ops/dashboard/run.sh", {
    cwd: "{dashboard}",
    description: "Keeps the live dashboard running on its branch's latest head.",
    enabled: true,
    schedule: { every: 60 },
    stop: "dashboard",
  }),
  "ops-dm-watch": terminal("ops-dm-watch", bunJob("ops-dm-watch"), {
    description:
      "In Slack mode, hands each message in the owner's DM to the dispatcher, the session in the assistant seat too when no reply lands in 3 minutes.",
    schedule: { every: 60 },
  }),
  "ops-ext-sync": terminal("ops-ext-sync", bunJob("ops-ext-sync"), {
    description:
      "Syncs each extension with its private repository at 02:30, pushed only after a clean secrets scan.",
    schedule: { every: 86400 },
  }),
  "ops-flow": launchd("ops-flow", {
    description:
      "Tells the leads when a session holds a run slot over 15 minutes, or a model slot over 120.",
    schedule: { every: 60 },
  }),
  "ops-herdr": launchd("ops-herdr", {
    description:
      "Starts each herdr server that is down, on the pinned binary and the repo's config.",
    schedule: { every: 60 },
  }),
  "ops-machine": terminal("ops-machine", `${bunJob("ops-machine")} --data {data}`, {
    description:
      "Writes one line a minute of the machine's load, memory and live sessions to machine.jsonl.",
    schedule: { every: 60 },
  }),
  "ops-merge-train": terminal(
    "ops-merge-train",
    "python3 -I {checkout}/scripts/ops/merge-train/run.py",
    {
      description: "Runs the merge train: builds a train of ready PRs and checks each step.",
      neverPause: true,
      schedule: { every: 60 },
    },
  ),
  // launchd holds it and it runs from the Dashboard's checkout, so a main checkout wiped with its herdr config and scripts still has its restore.
  "ops-restore": {
    ...launchd("ops-restore", {
      description:
        "Restores a lost main checkout by the playbook's steps once a guard is gone on two looks 5 minutes apart.",
      schedule: { every: 60 },
    }),
    cwd: "{dashboard}",
    program: [
      "{bun}",
      "--no-env-file",
      "{dashboard}/packages/scripts/src/ops-restore/cli.ts",
      "--main",
      "{checkout}",
    ],
  },
  "ops-session-resume": launchd("ops-session-resume", {
    description: "Queues a carry-on line for each factory session once its usage limit resets.",
    schedule: { every: 60 },
  }),
  "ops-sweep": terminal("ops-sweep", bunJob("ops-sweep"), {
    description: "The Ops lead's sweep: runners, probes, asks, heartbeats and the forecast.",
    schedule: { every: 300 },
  }),
  "ops-tick": launchd("ops-tick", {
    description:
      "The factory's timed beats: the roll gate, the tick, the usage-limit watch and the sweeps.",
    schedule: { every: 60 },
  }),
  "ops-unstick": terminal("ops-unstick", "python3 -I {checkout}/scripts/ops/unstick/run.py", {
    description:
      "Reads every live session's screen and clears a factory session stuck on a prompt.",
    neverPause: true,
    schedule: { every: 120 },
  }),
  "ops-usage": terminal("ops-usage", "python3 -I {checkout}/scripts/ops/usage/run.py", {
    description: "Reads the account's usage windows into usage.json every 5 minutes.",
    enabled: true,
    neverPause: true,
    schedule: { every: 300 },
  }),
  "ops-wa": terminal("ops-wa", `${bunJob("ops-wa")} --data {data}`, {
    description:
      "Holds the WhatsApp link on the spare number: hands each owner message to the dispatcher, sends its replies, and drops every other message.",
    schedule: { always: true },
  }),
  "ops-zai-usage": launchd("ops-zai-usage", {
    description: "Reads the GLM plan's credits into zai-usage.json, which the spawn gate reads.",
    schedule: { every: 300 },
  }),
}

// A job's old setting keys: the switch imports jobs.json under its old names before the migration renames them.
const OLD_KEYS: Record<string, string[]> = { "ops-dashboard": ["jobs.opsDesk"] }

export const jobSettings = defineSettings(
  Object.fromEntries(
    Object.entries(JOBS).map(([name, job]) => [
      jobKey(name),
      {
        aliases: OLD_KEYS[name],
        default: job,
        description: `The ${name} ops job: ${job.description}`,
        merge: true,
        schema: jobRowSchema,
        stored: fromStored,
      },
    ]),
  ),
)

export type Fill = { bun: string; checkout: string; dashboard: string; data: string; path: string }

const filled = (text: string, fill: Fill) =>
  text
    .replaceAll("{bun}", fill.bun)
    .replaceAll("{checkout}", fill.checkout)
    .replaceAll("{dashboard}", fill.dashboard)
    .replaceAll("{data}", fill.data)

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

// A launchd job's plist: its label, its program from its cwd, kept alive, logging into its own folder under ops.
const plistOf = (name: string, job: Job, fill: Fill): string => {
  const log = `${fill.data}/ops/${name.replace(/^ops-/, "")}/launchd.log`
  const string = (text: string) => `<string>${xml(text)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>EnvironmentVariables</key><dict><key>PATH</key>${string(fill.path)}</dict>`,
    "  <key>KeepAlive</key><true/>",
    `  <key>Label</key>${string(job.launchd!)}`,
    `  <key>ProgramArguments</key><array>${job.program!.map((arg) => string(filled(arg, fill))).join("")}</array>`,
    "  <key>RunAtLoad</key><true/>",
    `  <key>StandardErrorPath</key>${string(log)}`,
    `  <key>StandardOutPath</key>${string(log)}`,
    `  <key>WorkingDirectory</key>${string(filled(job.cwd ?? fill.checkout, fill))}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

// Pure: the registry's values (policy.json's, over each job's default) and each org's own jobs (orgJobs, each row marked with its org) as jobs.json in the shape every reader parses, and an enabled launchd job's plist by label. Each value reads as a stored row (fromStored). A job jobs.json lists that neither knows (a company script kept by hand) is kept as it stands; one an org's row rendered before, whose row is now refused or gone, is kept paused, so the runner stops it, and kept as it stands when the orgs could not be read (org null).
export const renderJobs = (
  values: Record<string, unknown>,
  existing: { name?: unknown }[],
  fill: Fill,
  org: Record<string, OrgJob> | null = {},
): { jobs: Record<string, unknown>[]; plists: Map<string, string> } => {
  const plists = new Map<string, string>()
  const row = (
    name: string,
    { command, cwd, enabled, program, ...job }: Job & { org?: string },
  ) => {
    if (enabled && job.launchd && program)
      plists.set(job.launchd, plistOf(name, { ...job, cwd, enabled, program }, fill))
    return {
      name,
      ...job,
      ...(command
        ? { command: filled(command, fill), cwd: filled(cwd ?? fill.checkout, fill) }
        : {}),
      ...(enabled ? {} : { disabled: true }),
    }
  }
  const jobs: Record<string, unknown>[] = [
    ...Object.entries(JOBS).map(([name, fallback]) => {
      const set = jobSchema.safeParse(fromStored(values[jobKey(name)]))
      return row(name, set.success ? set.data : fallback)
    }),
    ...Object.entries(org ?? {}).map(([name, job]) => row(name, job)),
  ]
  const known = new Set([...Object.keys(JOBS), ...Object.keys(org ?? {})])
  jobs.push(
    ...(existing as Record<string, unknown>[])
      .filter((job) => typeof job.name === "string" && !known.has(job.name))
      .map((job) => (org && typeof job.org === "string" ? { ...job, disabled: true } : job)),
  )
  return { jobs: jobs.sort((a, b) => String(a.name).localeCompare(String(b.name))), plists }
}

// A word an org job's command passes its script, and each segment of its paths: plain text, never a shell operator, a quote or a placeholder.
const PLAIN = /^[\w.,:=@%+/-]+$/
const OPS = "{data}/ops/"

// Whether a path under ops is in one of the given script folders: <key>/<path>, every segment plain and none . or ..
const inFolder = (path: string, keys: string[]): boolean => {
  const [key, ...rest] = path.split("/")
  return (
    keys.includes(key!) &&
    PLAIN.test(path) &&
    rest.length > 0 &&
    rest.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
}

// Where an org's job runs, its cwd, or why it may not run as its row says: it beats under its own name and names no stop group, which ops stops before each start, it runs in a terminal, its command {bun} [--no-env-file] then a script in a folder its org ships, then plain words or {data}, from that folder unless its cwd names one under it.
const runsFrom = (
  name: string,
  job: Job,
  keys: string[],
): { cwd: string } | { refused: string } => {
  const refused = (why: string) => ({ refused: why })
  if (job.heartbeat !== name) return refused(`its heartbeat must be its own name, ${name}`)
  if (job.stop)
    return refused("an org's job names no stop group, which ops stops before each start")
  if (job.launchd || job.program)
    return refused(
      "an org's job runs in a terminal, with a command and no launchd label or program",
    )
  const words = (job.command ?? "").split(" ")
  if (words[0] !== "{bun}") return refused("its command must start with {bun}")
  const at = words[1] === "--no-env-file" ? 2 : 1
  const script = words[at] ?? ""
  if (!script.startsWith(OPS) || !inFolder(script.slice(OPS.length), keys))
    return refused(`its command must run a script in a folder its org ships, ${OPS}<key>/<file>`)
  if (!words.slice(at + 1).every((word) => word === "{data}" || PLAIN.test(word)))
    return refused("its command's arguments must be plain words or {data}")
  const key = script.slice(OPS.length).split("/")[0]!
  const cwd = job.cwd ?? `${OPS}${key}`
  if (
    cwd !== `${OPS}${key}` &&
    !(cwd.startsWith(`${OPS}${key}/`) && inFolder(cwd.slice(OPS.length), [key]))
  )
    return refused(`its cwd must be ${OPS}${key} or a folder under it`)
  return { cwd }
}

// An org's own job, marked with the org that adds it, which its jobs.json row keeps so a later pass can tell it from a row kept by hand.
export type OrgJob = Job & { org: string }

const REGISTRY_KEYS = new Set([...Object.keys(JOBS).map(jobKey), ...Object.values(OLD_KEYS).flat()])

// Whether a key names an org's own job: a jobs.<camelName> key the registry lacks, under any spelling, which only orgJob can say is the job's name.
export const orgJobKey = (key: string): boolean =>
  key.startsWith("jobs.") && !REGISTRY_KEYS.has(key)

// One scope's row for a job the registry lacks as that org's job, by its name, or why it is refused; a write of the row checks it the same way, as it stands, against the scope's own script folders, while a read hands it a stored row through fromStored.
export const orgJob = (
  key: string,
  scope: string,
  value: unknown,
  login: string,
  keys: string[],
): { job: OrgJob; name: string } | { refused: string } => {
  if (scope === login || scope === CORE)
    return { refused: "only an org's scope may add a job the registry lacks" }
  const name = key.slice("jobs.".length).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
  if (!/^[a-z][a-z0-9-]*$/.test(name) || jobKey(name) !== key)
    return { refused: "its key must be jobs.<camelName>, the job's name in camel case" }
  const parsed = jobSchema.safeParse(value)
  if (!parsed.success)
    return {
      refused: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "row"} ${issue.message}`)
        .join("; "),
    }
  const runs = runsFrom(name, parsed.data, keys)
  return "refused" in runs ? runs : { job: { ...parsed.data, cwd: runs.cwd, org: scope }, name }
}

// Pure: each org's own jobs from every scope's settings rows, each read through fromStored: an org scope's jobs.<camelName> row for a job the registry lacks, by its name, which runs a script from a folder that org ships (scripts[org], each <org>/scripts/<key>/), from that folder unless its cwd names one under it. Each row refused is a line naming its scope, its key and why: a login's or core's row for such a job, a row off the job's schema or out of its folder, and a second org's row for a job the first in scope order adds.
export const orgJobs = (
  rows: { key: string; scope: string; value: unknown }[],
  login: string,
  scripts: Record<string, string[]>,
): { jobs: Record<string, OrgJob>; refused: string[] } => {
  const jobs: Record<string, OrgJob> = {}
  const refused: string[] = []
  for (const { key, scope, value } of rows) {
    if (!orgJobKey(key)) continue
    const read = orgJob(key, scope, fromStored(value), login, scripts[scope] ?? [])
    if ("refused" in read) refused.push(`jobs: refused ${scope} ${key}: ${read.refused}`)
    else if (jobs[read.name])
      refused.push(
        `jobs: refused ${scope} ${key}: ${jobs[read.name]!.org} already adds ${read.name}`,
      )
    else jobs[read.name] = read.job
  }
  return { jobs, refused }
}

const LISTED_FIELDS = [
  "callsModel",
  "command",
  "config",
  "cwd",
  "description",
  "disabledWhy",
  "heartbeat",
  "launchd",
  "model",
  "neverPause",
  "pausedFor",
  "runtime",
  "schedule",
  "stop",
] as const

// The program and working folder a launchd plist runs, read from its XML; null for a plist that is not XML (a binary one) or holds no program.
export const plistProgram = (xmlText: string): { cwd?: string; program: string[] } | null => {
  const unescape = (text: string) =>
    text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
  const strings = (text: string) =>
    [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescape(match[1]!))
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xmlText)
  const program = array ? strings(array[1]!) : []
  if (!program.length) return null
  const cwd = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(xmlText)?.[1]
  return { program, ...(cwd ? { cwd: unescape(cwd) } : {}) }
}

// Pure: one job jobs.json lists as the registry's setting, its fields over the job's default read as a stored row (fromStored), enabled unless it is disabled, and a launchd job's program from its plist; a job the registry does not know is kept in jobs.json, and one its schema refuses says why.
export const importedJob = (
  listed: Record<string, unknown>,
  plist: { cwd?: string; program: string[] } | null,
): { key: string; value: Job } | { kept: string } | { problem: string } => {
  const name = String(listed.name ?? "")
  const fallback = JOBS[name]
  if (!fallback) return { kept: name }
  const fields = Object.fromEntries(
    LISTED_FIELDS.filter((f) => f in listed).map((f) => [f, listed[f]]),
  )
  const parsed = jobSchema.safeParse(
    fromStored({
      ...fallback,
      ...(listed.launchd && plist ? plist : {}),
      ...fields,
      ...(listed.launchd && !listed.command ? { command: undefined } : {}),
      ...(listed.command && !listed.launchd ? { launchd: undefined, program: undefined } : {}),
      enabled: listed.disabled !== true,
    }),
  )
  if (!parsed.success)
    return {
      problem: `${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    }
  return { key: jobKey(name), value: parsed.data }
}
