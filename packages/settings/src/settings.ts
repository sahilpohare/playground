import { z } from "zod"

// By relative path, since the factory's hooks import this file from outside the package, where @/ is not its src.
import { CORE } from "./rendered"
import { secretIn } from "./secrets"

// Playground's settings: every knob a typed key with a default, set at a scope with a reason. A piece that adds knobs registers them with defineSettings, which hands back a typed reader; a key that is renamed keeps its old name as an alias, which reads through to the new one. SCHEMA_VERSION moves when a key's meaning or type changes.
export const SCHEMA_VERSION = 1

// The kinds an item in the store can be, A to Z.
export const KINDS = ["doc", "learning", "list", "rule", "script", "skill", "template"] as const
export type Kind = (typeof KINDS)[number]

// A list needs no review; every other kind is prose or code, so a revision a session writes waits for a 5/5.
export const REVIEWED_KINDS: readonly Kind[] = KINDS.filter((kind) => kind !== "list")

// Playground's own extension, core, in the app's checkout: its values come after every other extension's, before each key's default.
export const CORE_READ_ONLY =
  "core is read-only: it changes by a pull request to the Playground repo"

// A scope in the extensions folder is a GitHub login or org's name, as GitHub spells them, and never core, which changes by a pull request to Playground.
export const extScopeSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
    "a scope is your GitHub login or an org's name",
  )
  .refine((scope) => scope !== CORE, CORE_READ_ONLY)

export const settingKeySchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/, "a setting key is dotted camelCase")

// An item's key names a file when it renders, so it keeps to what every file system takes.
export const itemKeySchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "an item key is lowercase letters, digits, dots, dashes and underscores",
  )

// A refusal a value earns from another setting, at a path into the value, which the schema alone cannot check.
export type Refusal = { message: string; path: (number | string)[] }

export type Field<S extends z.ZodType = z.ZodType> = {
  aliases?: string[]
  // What the value's schema cannot check alone: each refusal it earns from the settings beside it, read through read, which gives a key's value or its default.
  against?(value: z.output<S>, read: (key: string) => unknown): Refusal[]
  default: z.output<S>
  description: string
  // A value the API gives the page by its last 4 characters alone, so it never reaches a browser whole (a phone number).
  masked?: boolean
  // A row holding some of the value's fields, read over the default, so the rest still follow the default as it changes (a job's row, which may hold its enabled field alone).
  merge?: boolean
  schema: S
  // How a stored value reads before its schema checks it, where a read takes more than a write: a job row's unknown keys are dropped and its runtime reads as herdr, while checkSetting refuses both.
  stored?(value: unknown): unknown
}

export type Settings = { schemaVersion: typeof SCHEMA_VERSION; values: Record<string, unknown> }

const fields = new Map<string, Field>()
const aliases = new Map<string, string>()

export const defineSettings = <T extends Record<string, Field>>(defined: T) => {
  for (const [key, field] of Object.entries(defined)) {
    settingKeySchema.parse(key)
    for (const name of [key, ...(field.aliases ?? [])])
      if (fields.has(name) || aliases.has(name)) throw new Error(`setting ${name} is defined twice`)
    field.schema.parse(field.default)
    // null stands for no value in a scope (before its first write, after a reset), so no setting may hold null itself; the empty string is the unset value a key's schema can take.
    if (field.schema.safeParse(null).success)
      throw new Error(`setting ${key}'s schema takes null, which stands for no value`)
    fields.set(key, field)
    for (const alias of field.aliases ?? []) aliases.set(alias, key)
  }
  return {
    get: <K extends keyof T & string>(settings: Settings, key: K): z.output<T[K]["schema"]> =>
      (key in settings.values ? settings.values[key] : defined[key]!.default) as z.output<
        T[K]["schema"]
      >,
  }
}

// The current name of a key, through its alias, or undefined for a key no piece defines.
export const resolveKey = (key: string): string | undefined =>
  fields.has(key) ? key : aliases.get(key)

// A stored value as its key reads it: through its field's stored where it has one, else as it stands, a key no piece defines included.
export const storedValue = (key: string, value: unknown): unknown => {
  const name = resolveKey(key)
  const field = name ? fields.get(name) : undefined
  return field?.stored ? field.stored(value) : value
}

// A key's value in the settings a session reads, through its alias, else its default; undefined for a key no piece defines.
export const settingValue = (settings: Settings, key: string): { value: unknown } | undefined => {
  const name = resolveKey(key)
  if (!name) return undefined
  return { value: name in settings.values ? settings.values[name] : fields.get(name)!.default }
}

export const settingFields = (): { field: Field; key: string }[] =>
  [...fields.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, field]) => ({ field, key }))

export type Checked = { key: string; ok: true; value: unknown } | { message: string; ok: false }

// A refusal as one line, "<key>: ✖ <reason> → at <path>" for each reason, the shape the Dashboard's Templates editor reads back.
const refusalLine = (key: string, error: z.ZodError) =>
  `${key}: ${z.prettifyError(error).replaceAll("\n", " ")}`

// A value as a write would store it: its key resolved, its value parsed by the key's schema, and nothing secret-shaped.
export const checkSetting = (key: string, value: unknown): Checked => {
  const name = resolveKey(key)
  if (!name) return { message: `no setting ${key}; playground settings list names them`, ok: false }
  const parsed = fields.get(name)!.schema.safeParse(value)
  if (!parsed.success) return { message: refusalLine(name, parsed.error), ok: false }
  const secret = secretIn(parsed.data)
  if (secret)
    return {
      message: `${name}: the value holds ${secret}; keep the secret in the Keychain or the environment and set its name`,
      ok: false,
    }
  return { key: name, ok: true, value: parsed.data }
}

// A checked value against the settings it will be read beside: each refusal its field's against gives, worded as the schema's are, or undefined when none.
export const checkAgainst = (
  key: string,
  value: unknown,
  settings: Settings,
): string | undefined => {
  const field = fields.get(key)
  const refusals = field?.against?.(value, (name) => settingValue(settings, name)?.value) ?? []
  if (!refusals.length) return undefined
  const error = new z.ZodError(
    refusals.map(({ message, path }) => ({ code: "custom" as const, input: value, message, path })),
  )
  return refusalLine(key, error)
}

// An extension's links: each GitHub org, lowercase as a repo's origin is matched, whose repos read it, or * for every repo.
export const extLinkSchema = z
  .string()
  .regex(
    /^(?:\*|[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})$/,
    "a link is a GitHub org, lowercase, or * for every repo",
  )

export const extOrderSchema = z
  .array(extScopeSchema)
  .refine((names) => new Set(names).size === names.length, "an extension is in the order once")

export const extLinksSchema = z.record(extScopeSchema, z.array(extLinkSchema))

// The extensions a session in a repo of owner reads, first wins: each in ext.order linked to the owner or to *, then core; the login's, which holds this machine's settings, is read everywhere, first unless ext.order places it, and with no owner (the home set) only the * links count. A value its schema refuses reads as unset.
export const extChain = (
  values: Record<string, unknown>,
  login: string,
  owner?: string,
): string[] => {
  const order = extOrderSchema.safeParse(values["ext.order"]).data ?? []
  const links = extLinksSchema.safeParse(values["ext.links"]).data ?? {}
  const names = login && !order.includes(login) ? [login, ...order] : order
  const linked = (name: string) =>
    name === login ||
    (links[name] ?? []).some((link) => link === "*" || link === owner?.toLowerCase())
  return [...names.filter(linked), CORE]
}

// A merge field's row over its default, so every reader sees the whole value; any other row as it is.
const mergedValue = (key: string, value: unknown): unknown => {
  const field = fields.get(key)!
  return field.merge ? { ...(field.default as object), ...(value as object) } : value
}

// The settings a session in a repo of owner reads (the home set with none), each row as its key reads a stored value (storedValue): a value at an extension earlier in extChain's order beats a later one's, core's comes last before the default; a key set under its current name beats one set under an alias at the same scope, and a row whose key no piece defines, at a scope the chain leaves out, or of an ext.* key at a scope but the login's and core's, is left out.
export const settingsFor = (
  rows: { key: string; scope: string; value: unknown }[],
  login: string,
  owner?: string,
): Settings => {
  // ext.order and ext.links come from the login's scope over core's, so no extension reorders the rest
  const ext = (key: string) =>
    (
      rows.find((row) => row.key === key && row.scope === login) ??
      rows.find((row) => row.key === key && row.scope === CORE)
    )?.value
  const chain = extChain(
    { "ext.links": ext("ext.links"), "ext.order": ext("ext.order") },
    login,
    owner,
  )
  const best = new Map<string, { score: number; value: unknown }>()
  for (const row of rows) {
    const key = resolveKey(row.key)
    const at = chain.indexOf(row.scope)
    const value = storedValue(row.key, row.value)
    if (!key || at < 0 || !fields.get(key)!.schema.safeParse(value).success) continue
    if (key.startsWith("ext.") && row.scope !== login && row.scope !== CORE) continue
    const score = (chain.length - at) * 2 + (key === row.key ? 1 : 0)
    if ((best.get(key)?.score ?? -1) < score) best.set(key, { score, value })
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    values: Object.fromEntries(
      [...best.entries()].map(([key, { value }]) => [key, mergedValue(key, value)]),
    ),
  }
}

// A value as the API gives it to the page: a masked key's non-empty string as its last 4 characters behind dots, anything else as it stands.
export const shownValue = (key: string, value: unknown): unknown => {
  const name = resolveKey(key)
  return name && fields.get(name)?.masked && typeof value === "string" && value
    ? `••••${value.slice(-4)}`
    : value
}
