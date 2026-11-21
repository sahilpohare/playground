import { readFileSync } from "node:fs"
import { join } from "node:path"

// By relative path, so a test outside the package type-checks it, where @/ is not its src.
import { stableJson } from "./diff"
import { guardedOrgs } from "./ext"
import {
  deriveHooks,
  extGit,
  extLog,
  scopesIn,
  scriptFilesOf,
  writeFiles,
  writeRoot,
} from "./folder"
import {
  fromStored,
  jobKey,
  JOBS,
  jobSchema,
  orgJob,
  orgJobKey,
  retiredJobKey,
  runsOn,
} from "./jobs"
import { CORE, extensionsDir, loginOf, scopeDir } from "./rendered"
import { secretIn } from "./secrets"
import {
  checkAgainst,
  checkSetting,
  CORE_READ_ONLY,
  extScopeSchema,
  resolveKey,
  SCHEMA_VERSION,
  settingFields,
  settingsFor,
  storedValue,
} from "./settings"

// The settings half of the extensions folder: each scope's values in <scope>/settings.json, each write one commit in that scope's clone whose author is who asked, whose message is the reason and whose Setting trailer names the key, with the root's policy.json rebuilt from every scope beside it.

type Who = { actor: string; author: string; inboxRef: number | null; reason: string }
export type Result<T> = ({ ok: true } & T) | { message: string; ok: false; status: 400 | 404 | 409 }
export type Row = { key: string; scope: string; value: unknown }

const FILE = "settings.json"

const readValues = (data: string, scope: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(scopeDir(data, scope), FILE), "utf8"))
  } catch {
    return {}
  }
}

// Every value set at a scope, core's (in the checkout, where scopeDir finds it) first, each as the read takes it (storedValue, and fromStored for an org's own job row, which no field defines), so a write that sends a row back with its change, as Settings > Jobs' toggle and the Inbox's Approve do, sends it as the read takes it; a key no piece defines stays a row, so a write of another key keeps it.
export const settingRows = (data: string): Row[] =>
  [CORE, ...scopesIn(data).filter((scope) => scope !== CORE)].flatMap((scope) =>
    Object.entries(readValues(data, scope)).map(([key, value]) => ({
      key,
      scope,
      value: orgJobKey(key) ? fromStored(value) : storedValue(key, value),
    })),
  )

// policy.json: the settings a session in the home set reads, and those of a session in each guarded org's repos.
export const policyJson = (rows: Row[], login: string): string => {
  const values = settingsFor(rows, login).values
  return stableJson({
    orgs: Object.fromEntries(
      guardedOrgs(values).map((org) => [org, settingsFor(rows, login, org).values]),
    ),
    schemaVersion: SCHEMA_VERSION,
    values,
  })
}

// The root's derived files rebuilt from every scope, policy.json and the guards' lists, after a clone or a pull brought commits no write here made; call it under withLock.
export const deriveRoot = (data: string, login: string): void => {
  writeRoot(extensionsDir(data), new Map([["policy.json", policyJson(settingRows(data), login)]]))
  deriveHooks(data, login)
}

const byScopeKey = (a: Row, b: Row) => (`${a.scope} ${a.key}` < `${b.scope} ${b.key}` ? -1 : 1)

// Every key with its default, every row, and the values a session of your login reads (each merge field's row over its default), which Settings > Jobs shows; a MAC_ONLY job's key on darwin alone, since the render gives it no row elsewhere.
export const listSettings = (data: string, platform: string = process.platform) => {
  const rows = settingRows(data).sort(byScopeKey)
  const elsewhere = Object.keys(JOBS)
    .filter((name) => !runsOn(name, platform))
    .map(jobKey)
  return {
    keys: settingFields()
      .filter(({ key }) => !elsewhere.includes(key))
      .map(({ field, key }) => ({
        aliases: field.aliases ?? [],
        default: field.default,
        description: field.description,
        key,
      })),
    rows,
    schemaVersion: SCHEMA_VERSION,
    values: settingsFor(rows, loginOrNone(data) ?? "").values,
  }
}

const namesOf = (key: string): string[] => [
  key,
  ...(settingFields().find((entry) => entry.key === key)!.field.aliases ?? []),
]

// The login, or none before playground ext init names one, when a read takes core's values and the defaults.
const loginOrNone = (data: string): string | undefined => {
  try {
    return loginOf(data)
  } catch {
    return undefined
  }
}

// What a session of the org reads for one key: its value and every row that sets it, or its default.
export const readSetting = (data: string, key: string, org?: string) => {
  const name = resolveKey(key)
  if (!name) return null
  const rows = settingRows(data)
  const values = settingsFor(rows, loginOrNone(data) ?? "", org).values
  const field = settingFields().find((entry) => entry.key === name)!.field
  return {
    default: field.default,
    key: name,
    rows: rows.filter((row) => resolveKey(row.key) === name).sort(byScopeKey),
    value: name in values ? values[name] : field.default,
  }
}

// A write's refusal: core, a scope GitHub would not name, or a machine whose extensions have no login yet.
const badScope = (data: string, scope: string): Result<never> | undefined =>
  scope === CORE
    ? { message: CORE_READ_ONLY, ok: false, status: 409 }
    : !extScopeSchema.safeParse(scope).success
      ? { message: "a scope is your GitHub login or an org's name", ok: false, status: 400 }
      : loginOrNone(data) === undefined
        ? {
            message:
              "settings are written to your extensions, which need a login: run playground ext init",
            ok: false,
            status: 409,
          }
        : undefined

// Every scope's rows once the scope's settings.json holds values.
const rowsWith = (data: string, scope: string, values: Record<string, unknown>): Row[] => [
  ...settingRows(data).filter((row) => row.scope !== scope),
  ...Object.entries(values).map(([key, value]) => ({ key, scope, value })),
]

// One commit of the scope's new settings.json, with policy.json rebuilt at the root from every scope.
const commit = (
  data: string,
  scope: string,
  key: string,
  values: Record<string, unknown>,
  who: Who,
) => {
  const rows = rowsWith(data, scope, values)
  const trailers: [string, string][] = [
    ["Setting", key],
    ["Actor", who.actor],
  ]
  if (who.inboxRef !== null) trailers.push(["Inbox", `#i${who.inboxRef}`])
  writeFiles(
    data,
    scope,
    new Map([[FILE, stableJson(values)]]),
    { author: who.author, reason: who.reason, trailers },
    new Map([["policy.json", policyJson(rows, loginOf(data))]]),
  )
}

// The script folders a scope ships, each <scope>/scripts/<key>/, by key.
const scriptKeys = (data: string, scope: string): string[] => [
  ...new Set(scriptFilesOf(data, scope).map((parts) => parts[1]!)),
]

// An org's own job row as a write stores it, checked as the render reads it (orgJob), as it stands, so a misspelled key is refused: the job's schema, its own heartbeat, no stop group, a command and cwd in a script folder the scope ships, and no other org already adding the job, since the render runs the first org's row in A to Z order and refuses the rest.
const orgJobRow = (
  data: string,
  input: { key: string; scope: string; value: unknown },
): Result<{ value: unknown }> => {
  const read = orgJob(
    input.key,
    input.scope,
    input.value,
    loginOf(data),
    scriptKeys(data, input.scope),
  )
  if ("refused" in read) return { message: `${input.key}: ${read.refused}`, ok: false, status: 400 }
  const login = loginOf(data)
  const holder = scopesIn(data).find(
    (scope) =>
      scope !== input.scope &&
      input.key in readValues(data, scope) &&
      !(
        "refused" in
        orgJob(
          input.key,
          scope,
          fromStored(readValues(data, scope)[input.key]),
          login,
          scriptKeys(data, scope),
        )
      ),
  )
  if (holder)
    return { message: `${input.key}: ${holder} already adds ${read.name}`, ok: false, status: 400 }
  const secret = secretIn(input.value)
  if (secret)
    return {
      message: `${input.key}: the value holds ${secret}; keep the secret in the Keychain or the environment and set its name`,
      ok: false,
      status: 400,
    }
  return { ok: true, value: jobSchema.parse(input.value) }
}

export const setSetting = (
  data: string,
  input: { key: string; scope: string; value: unknown },
  who: Who,
): Result<{ key: string; scope: string; value: unknown }> => {
  const bad = badScope(data, input.scope)
  if (bad) return bad
  if (orgJobKey(input.key)) {
    const row = orgJobRow(data, input)
    if (!row.ok) return row
    const values = { ...readValues(data, input.scope), [input.key]: row.value }
    commit(data, input.scope, input.key, values, who)
    return { key: input.key, ok: true, scope: input.scope, value: row.value }
  }
  const checked = checkSetting(input.key, input.value)
  if (!checked.ok) return { message: checked.message, ok: false, status: 400 }
  const values = readValues(data, input.scope)
  values[checked.key] = checked.value
  const refused = checkAgainst(
    checked.key,
    checked.value,
    settingsFor(rowsWith(data, input.scope, values), loginOf(data)),
  )
  if (refused) return { message: refused, ok: false, status: 400 }
  commit(data, input.scope, checked.key, values, who)
  return { key: checked.key, ok: true, scope: input.scope, value: checked.value }
}

// Takes a setting back to its default at a scope by dropping it from the scope's file, under its name and each alias; an org's job row or a retired job's goes under its own key.
export const resetSetting = (
  data: string,
  input: { key: string; scope: string },
  who: Who,
): Result<{ key: string; scope: string }> => {
  const bad = badScope(data, input.scope)
  if (bad) return bad
  const own = orgJobKey(input.key) || retiredJobKey(input.key)
  const key = resolveKey(input.key) ?? (own ? input.key : undefined)
  if (!key) return { message: `no setting ${input.key}`, ok: false, status: 404 }
  const values = readValues(data, input.scope)
  const names = (resolveKey(key) ? namesOf(key) : [key]).filter((name) => name in values)
  if (!names.length)
    return {
      message: `${key} has no value at ${input.scope}: it is at its default`,
      ok: false,
      status: 409,
    }
  for (const name of names) delete values[name]
  commit(data, input.scope, key, values, who)
  return { key, ok: true, scope: input.scope }
}

const valueAt = (data: string, scope: string, rev: string, key: string): unknown => {
  const shown = extGit(scopeDir(data, scope), ["show", `${rev}:${FILE}`])
  if (shown.code !== 0) return null
  try {
    return JSON.parse(shown.out)[key] ?? null
  } catch {
    return null
  }
}

// Every commit that changed a key, in every scope, under its current name and each alias, newest first, with its value before and after: playground settings why.
export const settingHistory = (data: string, key: string) => {
  const name = resolveKey(key)
  if (!name) return null
  return scopesIn(data)
    .flatMap((scope) =>
      namesOf(name).flatMap((each) =>
        extLog(data, scope, ["Setting", each]).map((entry) => {
          const inbox = entry.trailers.find(([trailer]) => trailer === "Inbox")?.[1]
          return {
            actor: entry.trailers.find(([trailer]) => trailer === "Actor")?.[1] ?? null,
            at: entry.at,
            author: entry.author,
            inboxRef: inbox ? Number(inbox.slice(2)) : null,
            key: each,
            newValue: valueAt(data, scope, entry.sha, each),
            oldValue: valueAt(data, scope, `${entry.sha}^`, each),
            reason: entry.reason,
            scope,
            sha: entry.sha,
          }
        }),
      ),
    )
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
