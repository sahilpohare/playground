import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { configDirOf } from "@packages/env/data-dir"
import {
  deriveRoot,
  filesIn,
  type Kind,
  loginOf,
  putItem,
  scopeDir,
  setSetting,
  settingRows,
  showItem,
  withLock,
} from "@packages/settings"

import { herdrPath, PIN_SOURCE } from "../ops-herdr/pin"
import { OLD_TREE_PATHS } from "../rename/rules"
import { pinHere, type Result } from "./herdr-pin"
import { moveDataFolder, moveMachine, type Step, TABLE, type Table } from "./migrate-machine"
import { originRepo } from "./setting"
import { one, parseWords } from "./store"

// playground migrate: the live machine's one move onto Playground at the switch (build-list piece 21), run once by Ops. Every value it seeds is read at run time from the archive checkout, at its old canary or at the pre-squash head, so no owner's value ships in this tree; each write is one commit in its scope, and a value already there is left as it is.

export type Source = { archive: string; old: string; org: string; preSquash: string }
// Where a seed's text comes from: a file of the archive at its old canary or at the pre-squash head, a file of this machine's data folder, the org the command names, or the GitHub repository the archive's or this checkout's origin names.
type At = "archiveOrigin" | "checkoutOrigin" | "machine" | "old" | "org" | "preSquash"

type Read = { at: At; path: string; take: (text: string) => unknown }
// show: a dry run prints the value, for a seed that arranges the extensions rather than holding anything private.
export type Seed =
  | { key: string; read: Read; show?: true; type: "setting" }
  | { key: string; kind: Kind; read: Read; type: "item" }

const quoted = (re: RegExp) => (text: string) => re.exec(text)?.[1]

// Each manager kind's name in the machine's roster, the shortest of a kind's names, so the second dispatcher's <name>-2 is passed over; none unless all four are there.
const MANAGERS = ["builder", "dispatcher", "ops", "planner"]
const managerNames = (text: string) => {
  const agents = (JSON.parse(text) as { agents?: { kind?: string; name?: string }[] }).agents ?? []
  const names = MANAGERS.map((kind) =>
    agents
      .filter((agent) => agent.kind === kind && agent.name)
      .map((agent) => agent.name!)
      .sort((a, b) => a.length - b.length)
      .at(0),
  )
  return names.every(Boolean)
    ? Object.fromEntries(MANAGERS.map((kind, i) => [kind, names[i]]))
    : undefined
}

// A Python set or list of string literals assigned to name, as an array.
const pySet = (text: string, name: string) => {
  const body = new RegExp(`^${name} = [{[]([^}\\]]*)[}\\]]`, "m").exec(text)?.[1]
  return body === undefined ? undefined : [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1])
}

// The usage scripts' account constants, joined into usage.accounts: each file after the first by its name, separated by a newline and a marker line.
const USAGE_FILES = [
  "scripts/ops/usage/login-flip.py",
  "scripts/ops/usage/near-limit.py",
  "scripts/ops/usage/week-marks.py",
  "scripts/ops/usage/glm-credits.py",
]
const USAGE = USAGE_FILES.join(" + ")
const MARK = "\n# --- migrate: next file ---\n"

// login-flip's order, ends, ending-first and renewals, near-limit's counted set and week-marks' reset table, as one Claude account a row, then the Keychain account glm-credits read its key from as the GLM row; a name in login-flip resolves through its string constants.
const accounts = (text: string) => {
  const [flip, near, week, glm] = text.split(MARK)
  if (!flip || near === undefined || week === undefined || glm === undefined) return undefined
  const glmLabel = /"-a",\s*"([a-z0-9][a-z0-9._-]*)"/.exec(glm)?.[1]
  if (!glmLabel) return undefined
  const names = new Map<string, string>()
  for (const [, left, right] of flip.matchAll(
    /^([A-Z0-9_]+(?:, [A-Z0-9_]+)*) = ("[^"\n]*"(?:, "[^"\n]*")*)$/gm,
  )) {
    const values = [...right!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
    left!.split(", ").forEach((n, i) => values[i] !== undefined && names.set(n, values[i]!))
  }
  const email = (token: string) => (token.startsWith('"') ? token.slice(1, -1) : names.get(token))
  const list = (name: string) =>
    new RegExp(`^${name}(?:, [A-Z_]+)* = \\[([^\\]]*)\\]`, "m")
      .exec(flip)?.[1]
      ?.split(",")
      .map((token) => email(token.trim()))
  const dict = (name: string) =>
    new Map(
      [
        ...(new RegExp(`^${name} = \\{([^}]*)\\}`, "m").exec(flip)?.[1] ?? "").matchAll(
          /([A-Z0-9_]+|"[^"]*"):\s*("[^"]*"|None|\d+)/g,
        ),
      ].map(
        ([, key, value]) =>
          [
            email(key!),
            value === "None" ? null : value!.startsWith('"') ? value!.slice(1, -1) : Number(value),
          ] as const,
      ),
    )
  const order = list("ACCOUNTS")
  if (!order?.length || order.some((each) => !each)) return undefined
  const ends = dict("ENDS")
  const first = new Set(list("ENDING_FIRST") ?? [])
  const renews = dict("RENEWS")
  const counted = new Set(pySet(near, "ACCOUNTS") ?? [])
  const resets = new Map(
    [...week.matchAll(/"([^"]+)": \{[^}]*"weekday": (\d), "hourZ": ([\d.+\-*/ ()]+)\}/g)].map(
      ([, at, day, hour]) => [
        at!,
        { hour: Number(Function(`return (${hour})`)()), weekday: Number(day) },
      ],
    ),
  )
  const claude = order.map((at) => ({
    email: at,
    ...(ends.has(at) ? { ends: ends.get(at) } : {}),
    ...(first.has(at) ? { endsFirst: true } : {}),
    ...(counted.has(at!) ? { nearLimit: true } : {}),
    ...(renews.has(at) ? { renews: renews.get(at) } : {}),
    ...(resets.has(at!) ? { weekReset: resets.get(at!) } : {}),
  }))
  return [...claude, { label: glmLabel, provider: "glm" }]
}

// ext.links and ext.order from the keys they replace, orgs.map and orgs.always, as the login's scope holds them, else --org as both: each owner orgs.map names is linked to its org's extension, each orgs.always org goes last in the order linked to *, and the login comes first, linked to *.
export const extFromOrgs = (
  login: string,
  org: string,
  old: { key: string; value: unknown }[] = [],
): { "ext.links": Record<string, string[]>; "ext.order": string[] } => {
  const map = (old.find((row) => row.key === "orgs.map")?.value ?? { [org]: org }) as Record<
    string,
    string
  >
  const always = (old.find((row) => row.key === "orgs.always")?.value ?? [org]) as string[]
  const links: Record<string, string[]> = { [login]: ["*"] }
  const link = (name: string, to: string) => {
    links[name] = [...new Set([...(links[name] ?? []), to])].sort()
  }
  for (const [owner, name] of Object.entries(map)) link(name, owner.toLowerCase())
  for (const name of always) link(name, "*")
  return {
    "ext.links": links,
    "ext.order": [...new Set([login, ...Object.values(map), ...always])],
  }
}

// The seeds of the login's scope, each from the file that held it before the squash; a file whose path holds an old name comes from the migration table's sources, and old holds the login's rows of the keys a seed replaces.
export const SEEDS = (
  login: string,
  sources: Record<string, string> = {},
  old: { key: string; value: unknown }[] = [],
): Seed[] => [
  {
    key: "channel.skipUser",
    read: {
      at: "old",
      path: sources.channelWatch ?? "the table's sources.channelWatch",
      take: quoted(/^const SKIP = "([A-Z0-9]+)"/m),
    },
    type: "setting",
  },
  {
    key: "channel.slackId",
    read: {
      at: "old",
      path: sources.channelWatch ?? "the table's sources.channelWatch",
      take: quoted(/^const CHANNEL = "([A-Z0-9]+)"/m),
    },
    type: "setting",
  },
  {
    key: "clock.ownerZone",
    read: {
      at: "old",
      path: OLD_TREE_PATHS.endOfDayScan,
      take: quoted(/\bTZ=([A-Za-z_]+\/[A-Za-z_]+)/),
    },
    type: "setting",
  },
  {
    key: "ext.links",
    read: { at: "org", path: "--org", take: (org) => extFromOrgs(login, org, old)["ext.links"] },
    show: true,
    type: "setting",
  },
  {
    key: "ext.order",
    read: { at: "org", path: "--org", take: (org) => extFromOrgs(login, org, old)["ext.order"] },
    show: true,
    type: "setting",
  },
  {
    key: "factory.archiveRepo",
    read: { at: "archiveOrigin", path: "the archive's origin", take: (repo) => repo },
    type: "setting",
  },
  {
    key: "factory.publicRepo",
    read: {
      at: "checkoutOrigin",
      path: "this checkout's origin",
      take: (repo) => repo.toLowerCase(),
    },
    type: "setting",
  },
  {
    key: "factory.repo",
    read: { at: "checkoutOrigin", path: "this checkout's origin", take: (repo) => repo },
    type: "setting",
  },
  {
    key: "live.branch",
    read: {
      at: "old",
      path: "api/hono/src/lib/dev/live-desk.ts",
      take: quoted(/\bbranch: "([^"]+)"/),
    },
    type: "setting",
  },
  {
    key: "live.container",
    read: {
      at: "old",
      path: "api/hono/src/lib/dev/live-desk.ts",
      take: quoted(/\bdatabase: "([^"]+)"/),
    },
    type: "setting",
  },
  {
    key: "models.glmKeychainService",
    read: {
      at: "old",
      path: "scripts/ops/usage/glm-credits.py",
      take: quoted(/"-s",\s*"([A-Za-z0-9._-]+)"/),
    },
    type: "setting",
  },
  {
    key: "owner.names",
    read: {
      at: "old",
      path: "scripts/hooks/no-chat-question.ts",
      take: (text) => /@\?\(\?:([a-z0-9._|-]+)\)/.exec(text)?.[1]?.split("|"),
    },
    type: "setting",
  },
  {
    key: "sessions.names",
    read: { at: "machine", path: "roster.json", take: managerNames },
    type: "setting",
  },
  {
    key: "slack.linkConverter",
    read: {
      at: "preSquash",
      path: TABLE,
      take: (text) => (JSON.parse(text) as Table).linkConverter,
    },
    type: "setting",
  },
  {
    key: "slack.sendServer",
    read: {
      at: "old",
      path: "api/hono/src/lib/desk/inbox.ts",
      take: quoted(/goes out through ([a-z0-9-]+)/),
    },
    type: "setting",
  },
  {
    key: "usage.accounts",
    read: { at: "old", path: USAGE, take: accounts },
    type: "setting",
  },
  {
    key: "usage.keychainService",
    read: {
      at: "old",
      path: "scripts/ops/usage/account-watch.py",
      take: quoted(/"-s",\s*"([A-Za-z0-9._-]+)"/),
    },
    type: "setting",
  },
  {
    key: "usage.switchAccount",
    read: {
      at: "old",
      path: "packages/scripts/src/ops-tick/tick.ts",
      take: quoted(/SWITCH_ACCOUNT = "([^"]+)"/),
    },
    type: "setting",
  },
  {
    key: "release-owners",
    kind: "list",
    read: {
      at: "old",
      path: "scripts/hooks/no-release-comment.ts",
      take: (text) => {
        const set = /GUARDED_OWNERS = new Set\((\[[^\]]*\])\)/.exec(text)?.[1]
        return set ? JSON.parse(set) : undefined
      },
    },
    type: "item",
  },
]

// The hand-made skills the switch brings into the company's scope (--org) from ~/.claude/skills, unless the scope's clone (piece 22) already holds them; review-bot is not among them, since the data-folder cleanup deletes it.
export const HAND_MADE = ["parity-sweep", "smoke-test"]

// Left out of a skill's import: Python's caches.
const CACHE = /(?:^|\/)__pycache__\//

export type Deps = {
  // Claude's config folder, where the old data folders sit beside its own state
  config: string
  home: string
  // the GitHub repository a checkout's origin names, owner/name, empty for none
  origin: (which: "archive" | "checkout") => string
  show: (rev: string, path: string) => string | undefined
  skills: string
}

const gitShow =
  (archive: string) =>
  (rev: string, path: string): string | undefined => {
    const run = Bun.spawnSync(["git", "-C", archive, "show", `${rev}:${path}`], {
      stderr: "pipe",
      stdout: "pipe",
    })
    return run.exitCode === 0 ? run.stdout.toString() : undefined
  }

// The checkout this file runs from, the one the factory works in after the switch.
const CHECKOUT = resolve(import.meta.dir, "../../../..")

export const depsOf = (
  source: Source,
  skills: string,
  home = homedir(),
  checkout = CHECKOUT,
  config = configDirOf(),
): Deps => ({
  config,
  home,
  origin: (which) => originRepo(which === "archive" ? source.archive : checkout),
  show: gitShow(source.archive),
  skills,
})

// A seed's text: an archive read, the usage files joined for usage.accounts, a data folder file, the org, or an origin's repository.
const textOf = (data: string, source: Source, deps: Deps, read: Read): string | undefined => {
  if (read.at === "org") return source.org
  if (read.at === "archiveOrigin" || read.at === "checkoutOrigin")
    return deps.origin(read.at === "archiveOrigin" ? "archive" : "checkout") || undefined
  if (read.at === "machine") {
    const path = join(data, read.path)
    return existsSync(path) ? readFileSync(path, "utf8") : undefined
  }
  const at = read.at
  const texts = read.path.split(" + ").map((path) => deps.show(source[at], path))
  return texts.every((text) => text !== undefined) ? texts.join(MARK) : undefined
}

const WHO = {
  actor: "playground migrate",
  author: "playground",
  inboxRef: null,
  reason: "the switch: seed what the old tree held",
}

// Each seed read and written in turn; a value no read found, or a write refused, is a step that failed, and the rest still run. With dryRun, only what each would do.
export function migrate(
  data: string,
  source: Source,
  deps: Deps,
  dryRun: boolean,
  env: Record<string, string | undefined> = process.env,
): Step[] {
  const steps: Step[] = []
  const say = (ok: boolean, line: string) => steps.push({ line, ok })
  const shown = deps.show(source.preSquash, TABLE)
  const table = shown === undefined ? undefined : (JSON.parse(shown) as Table)
  if (table) {
    const moved = moveDataFolder(data, deps.config, table, dryRun)
    steps.push(...moved.steps)
    if (moved.steps.some((step) => !step.ok)) return steps
    data = moved.data
  }
  let login: string
  try {
    login = loginOf(data, env)
  } catch (error) {
    say(false, `- the login: ${(error as Error).message}`)
    return steps
  }
  const old = settingRows(data).filter(
    (row) => row.scope === login && (row.key === "orgs.always" || row.key === "orgs.map"),
  )
  for (const seed of SEEDS(login, table?.sources, old)) {
    const { at, path } = seed.read
    const name = seed.type === "setting" ? seed.key : `${seed.kind} ${seed.key}`
    const where =
      at === "machine"
        ? join(data, path)
        : at === "old" || at === "preSquash"
          ? `${path} at ${source[at]}`
          : path
    const text = textOf(data, source, deps, seed.read)
    let value: unknown
    try {
      value = text === undefined ? undefined : seed.read.take(text)
    } catch {}
    if (value === undefined) {
      say(false, `- ${name}: none found in ${where}`)
      continue
    }
    const scope = login
    if (seed.type === "setting") {
      // a value already there is left, whatever it holds, so a later choice outlives a second run
      if (settingRows(data).some((row) => row.scope === scope && row.key === seed.key)) {
        say(true, `= ${name} at ${scope}: already set`)
        continue
      }
      if (dryRun) {
        say(
          true,
          `+ ${name} at ${scope}: from ${where}${seed.show ? `: ${JSON.stringify(value)}` : ""}`,
        )
        continue
      }
      const set = setSetting(data, { key: seed.key, scope, value }, WHO)
      say(set.ok, set.ok ? `+ ${name} at ${scope}` : `- ${name} at ${scope}: ${set.message}`)
      continue
    }
    const content =
      seed.kind === "list"
        ? { attachments: [], body: null, files: null, value }
        : { attachments: [], body: String(value), files: null, value: null }
    say(...put(data, { key: seed.key, kind: seed.kind, scope }, content, dryRun, where))
  }
  for (const skill of HAND_MADE) {
    const ref = { key: skill, kind: "skill" as const, scope: source.org }
    if (existsSync(join(scopeDir(data, ref.scope), "skills", skill))) {
      say(true, `= skill ${skill} at ${ref.scope}: its clone holds it`)
      continue
    }
    const from = join(deps.skills, skill)
    if (!existsSync(join(from, "SKILL.md"))) {
      say(false, `- skill ${skill}: no ${join(from, "SKILL.md")}`)
      continue
    }
    const files = Object.fromEntries(
      filesIn(from)
        .filter((file) => !CACHE.test(file))
        .map((file) => [file, readFileSync(join(from, file), "utf8")]),
    )
    say(...put(data, ref, { attachments: [], body: null, files, value: null }, dryRun, from))
  }
  if (!table) say(false, `- the machine: no ${TABLE} at ${source.preSquash}`)
  else steps.push(...moveMachine(data, login, deps.home, table, dryRun))
  if (!dryRun) withLock(data, () => deriveRoot(data, login))
  return steps
}

const put = (
  data: string,
  ref: { key: string; kind: Kind; scope: string },
  content: Parameters<typeof putItem>[2],
  dryRun: boolean,
  from: string,
): [boolean, string] => {
  const name = `${ref.kind} ${ref.key} at ${ref.scope}`
  // an item already there is left, whatever it holds, as a setting is
  if (showItem(data, ref)) return [true, `= ${name}: already set`]
  if (dryRun) return [true, `+ ${name}: from ${from}`]
  const put = putItem(data, ref, content, WHO, true)
  return put.ok ? [true, `+ ${name}`] : [false, `- ${name}: ${put.message}`]
}

export const MIGRATE_USAGE =
  "usage: playground migrate --archive <checkout> --pre-squash <sha> --org <org> [--old <rev>] [--dry-run]"

// The machine's last step, run whatever the others did: playground herdr pin, which puts Playground's own herdr in place; with dryRun, only what it would do.
export const herdrStep = async (dryRun: boolean, pin: () => Promise<Result>): Promise<Step> => {
  if (dryRun)
    return {
      line: `+ herdr: playground herdr pin puts herdr ${PIN_SOURCE.version} at ${herdrPath()}`,
      ok: true,
    }
  const { code, line } = await pin()
  return { line: `${code === 0 ? "+" : "-"} herdr: ${line}`, ok: code === 0 }
}

// playground migrate's words to its steps, printed one a line: 2 on a usage error, 1 when any step failed.
export async function runMigrate(
  words: string[],
  data: string,
  skills: string,
  home: string,
  out: (line: string) => void,
  checkout = CHECKOUT,
  config = configDirOf(),
  pin: () => Promise<Result> = () => pinHere(),
): Promise<number> {
  let options: Record<string, string[]>
  try {
    options = parseWords(words, ["--dry-run"]).options
  } catch {
    options = {}
  }
  const archive = one(options, "--archive")
  const preSquash = one(options, "--pre-squash")
  const org = one(options, "--org")
  if (!archive || !preSquash || !org) {
    out(MIGRATE_USAGE)
    return 2
  }
  const source = { archive, old: one(options, "--old") ?? "canary", org, preSquash }
  const dryRun = "--dry-run" in options
  const steps = migrate(data, source, depsOf(source, skills, home, checkout, config), dryRun)
  steps.push(await herdrStep(dryRun, pin))
  for (const step of steps) out(step.line)
  return steps.every((step) => step.ok) ? 0 : 1
}
