import { ROSTER_KINDS, ROSTER_ROLE_OF_KIND, type RosterKind } from "@packages/config/kinds"
import type { InferResponseType } from "hono/client"

import { apiClient, unwrap } from "@/lib/api/client"
import {
  EFFORT_LABELS,
  isEffort,
  isModel,
  MODEL_LABELS,
  type SessionEffort,
} from "@/lib/session-setting"

export type TemplateRow = InferResponseType<
  (typeof apiClient.v1.sessions.templates)["$get"],
  200
>["data"][number]

export const TEMPLATES_QUERY_KEY = ["session-templates"] as const

// The model a GLM template names, packages/settings' GLM_MODEL, which the web reads no package for; a test keeps the two equal.
export const GLM_MODEL = "glm"

export async function readTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await unwrap(apiClient.v1.sessions.templates.$get())
  if (error) throw new Error(error.message)
  return data
}

// Starts a template's session, or throws the API's words whole: spawn.sh's last line on a refusal.
export async function startTemplate(id: string): Promise<string> {
  const { data, error } = await unwrap(
    apiClient.v1.sessions.templates[":id"].start.$post({ param: { id } }),
  )
  if (error) throw new Error(error.message)
  return data.name
}

// Pure: a picker row as drawn: its label, then its backend or model and effort, muted, and the reason it is disabled, the API's (no second account, no brief), else a dispatcher template's while the second dispatcher already runs; null when it can start.
export const templateRowView = (
  row: TemplateRow,
  secondRunning: boolean,
): { detail: string; label: string; reason: string | null } => ({
  detail: [
    row.model === GLM_MODEL ? "GLM" : (row.model ?? "Claude"),
    row.effort && isEffort(row.effort) ? EFFORT_LABELS[row.effort] : null,
  ]
    .filter(Boolean)
    .join(" · "),
  label: row.label,
  reason:
    row.refusal ??
    (row.kind === "dispatcher" && secondRunning ? "The second dispatcher is running" : null),
})

export const TEMPLATES_KEY = "sessions.templates"

export const TEMPLATE_SETTING_QUERY_KEY = ["setting", TEMPLATES_KEY] as const

// The manager kinds a template starts, as the settings schema lists them: the roster's managers.
export const TEMPLATE_KINDS = ROSTER_KINDS.filter((kind) => ROSTER_ROLE_OF_KIND[kind] === "manager")

// One template as sessions.templates stores it, its model a Claude id or glm; the API's schema checks every field on save.
export type Template = {
  account?: string
  brief: string
  effort?: SessionEffort
  harness: TemplateRow["harness"]
  id: string
  kind: RosterKind
  label: string
  model?: string
}

// The editor's fields, each a string, empty for none: backend is claude or glm, a GLM template's model.
export type TemplateForm = {
  account: string
  backend: string
  brief: string
  effort: string
  kind: string
  label: string
  model: string
}

export type TemplateState = "added" | "default" | "edited" | "new"

export const TEMPLATE_STATE_WORDS: Record<TemplateState, string> = {
  added: "Added",
  default: "Default",
  edited: "Edited default",
  new: "New default",
}

const same = (a: Template, b: Template) => stableJson(a) === stableJson(b)

const stableJson = (template: Template) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(template).sort(([a], [b]) => a.localeCompare(b))),
  )

// Pure: a template is a default as the code holds it, a default saved with edits, or one the owner added.
export const templateState = (template: Template, defaults: Template[]): TemplateState => {
  const original = defaults.find((row) => row.id === template.id)
  return !original ? "added" : same(original, template) ? "default" : "edited"
}

// Pure: the defaults a list saved before Playground added them lacks, since a save keeps the whole list and a default is never removed from it.
export const newDefaults = (rows: Template[], defaults: Template[]): Template[] =>
  defaults.filter((original) => !rows.some((row) => row.id === original.id))

const byLabel = (rows: Template[]) => [...rows].sort((a, b) => a.label.localeCompare(b.label))

// Pure: the list with a template saved in its id's place, or added, A to Z by label as the setting keeps it.
export const withTemplate = (rows: Template[], template: Template): Template[] =>
  byLabel([...rows.filter((row) => row.id !== template.id), template])

// Pure: the list without an added template; a default stays, since only Reset changes one back.
export const withoutTemplate = (rows: Template[], id: string, defaults: Template[]): Template[] =>
  defaults.some((row) => row.id === id) ? rows : rows.filter((row) => row.id !== id)

// Pure: the list with a default's own values back in its place.
export const resetTemplate = (rows: Template[], id: string, defaults: Template[]): Template[] => {
  const original = defaults.find((row) => row.id === id)
  return original ? withTemplate(rows, original) : rows
}

const sameList = (a: Template[], b: Template[]) =>
  a.length === b.length && a.every((row) => b.some((other) => same(row, other)))

// Pure: the write a new list takes: none while it is the list read, a reset of the setting once it holds the defaults alone, else the list.
export const templatesWrite = (
  rows: Template[],
  read: Template[],
  defaults: Template[],
): { none: true } | { reset: true } | { value: Template[] } =>
  sameList(rows, read)
    ? { none: true }
    : sameList(rows, defaults)
      ? { reset: true }
      : { value: rows }

// Pure: a fresh id for an added template, from its label, unlike every id listed.
export const newTemplateId = (label: string, rows: Template[]): string => {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "template"
  const taken = new Set(rows.map((row) => row.id))
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

// Pure: the editor's fields for a template, or for a new one.
export const templateForm = (template?: Template): TemplateForm => ({
  account: template?.account ?? "",
  backend: template?.model === GLM_MODEL ? "glm" : "claude",
  brief: template?.brief ?? "",
  effort: template?.effort ?? "",
  kind: template?.kind ?? "orchestrator",
  label: template?.label ?? "",
  model: template?.model === GLM_MODEL ? "" : (template?.model ?? ""),
})

// Pure: the template the editor's fields save, on Claude Code, an empty field left out and a GLM template glm as its model, without the Claude-only account, effort and model.
export const templateOf = (form: TemplateForm, id: string): Template => {
  const claude = form.backend !== "glm"
  const effort = isEffort(form.effort) ? form.effort : undefined
  const optional = { account: form.account, effort, model: form.model.trim() }
  return {
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => claude && value)),
    ...(claude ? {} : { model: GLM_MODEL }),
    brief: form.brief.trim(),
    harness: "claude-code",
    id,
    kind: TEMPLATE_KINDS.find((kind) => kind === form.kind) ?? "orchestrator",
    label: form.label.trim(),
  }
}

const FIELDS = ["account", "backend", "brief", "effort", "kind", "label", "model"] as const
export type TemplateField = (typeof FIELDS)[number]

// Pure: a refused save's reasons, each beside the field of the template at index it names (the settings write's "✖ <reason> → at [<index>].<field>"), and the rest whole.
export const templateRefusal = (
  message: string,
  index: number,
): { fields: Partial<Record<TemplateField, string>>; rest: string | null } => {
  const fields: Partial<Record<TemplateField, string>> = {}
  const rest: string[] = []
  const body = message.replace(new RegExp(`^${TEMPLATES_KEY}: `), "")
  for (const part of body
    .split("✖")
    .map((text) => text.trim())
    .filter(Boolean)) {
    const at = /^(.*?)\s*→ at \[(\d+)\]\.(\w+)$/.exec(part)
    const field = FIELDS.find((name) => name === at?.[3])
    if (at && field && Number(at[2]) === index) fields[field] ??= at[1]!
    else rest.push(part)
  }
  return { fields, rest: rest.length ? rest.join(" ") : null }
}

// GET /api/v1/settings/sessions.templates: the list the machine reads and the defaults in code.
export async function readTemplateSetting(): Promise<{ defaults: Template[]; rows: Template[] }> {
  const { data, error } = await unwrap(
    apiClient.v1.settings[":key"].$get({ param: { key: TEMPLATES_KEY }, query: {} }),
  )
  if (error) throw new Error(error.message)
  return { defaults: data.default as Template[], rows: data.value as Template[] }
}

// Saves a new list through the settings write path, nothing while it is the list read, a reset once it holds the defaults alone, or throws the API's words whole.
export async function writeTemplates(
  rows: Template[],
  { defaults, read }: { defaults: Template[]; read: Template[] },
  { reason, scope }: { reason: string; scope: string },
): Promise<void> {
  const write = templatesWrite(rows, read, defaults)
  if ("none" in write) return
  const json = { by: "Settings", reason, scope }
  const { error } = await unwrap(
    "reset" in write
      ? apiClient.v1.settings[":key"].reset.$post({ json, param: { key: TEMPLATES_KEY } })
      : apiClient.v1.settings[":key"].$put({
          json: { ...json, value: write.value },
          param: { key: TEMPLATES_KEY },
        }),
  )
  if (error) throw new Error(error.message)
}

// A kind as a word: orchestrator is Orchestrator.
export const kindWord = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1)

// Pure: a template's settings as one muted line: its kind, its backend or model and effort, its account and its brief.
export const templateWords = (template: Template): string =>
  [
    kindWord(template.kind),
    template.model === GLM_MODEL
      ? "GLM"
      : isModel(template.model)
        ? MODEL_LABELS[template.model]
        : (template.model ?? "Claude"),
    template.effort && EFFORT_LABELS[template.effort],
    template.account,
    template.brief,
  ]
    .filter(Boolean)
    .join(" · ")
