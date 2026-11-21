import type { Schedule } from "@packages/config/schedule"

import { apiClient, unwrap } from "@/lib/api/client"

export const JOBS_QUERY_KEY = ["settings", "jobs"] as const

const PREFIX = "jobs."

type Listed = {
  keys: { aliases?: string[]; default: unknown; key: string }[]
  rows: { key: string; scope: string; value: unknown }[]
  values: Record<string, unknown>
}

type JobValue = {
  config?: Record<string, unknown>
  description?: string
  enabled?: boolean
  schedule?: Schedule
}

export type JobRow = {
  // the job's own settings as your login reads them, which core checks only for being an object; undefined for a job with none
  config: Record<string, unknown> | undefined
  description: string
  enabled: boolean
  key: string
  name: string
  // the row the job's scope holds, which a toggle keeps all but its enabled field of
  row: Record<string, unknown> | undefined
  schedule: Schedule | undefined
  // the scope the job's writes go to: your login's for a registry job, its org's for an org's own job
  scope: string
  set: boolean
}

// jobs.opsMergeTrain reads as ops-merge-train, the job's own name.
const nameOf = (key: string) =>
  key.slice(PREFIX.length).replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)

// An org's own job's name, as the jobs render names it: its key's camel case in kebab case, digits kept as they are, which orgJob's regex takes.
const orgNameOf = (key: string) =>
  key.slice(PREFIX.length).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Pure: whether an org's row has the shape the jobs render reads as a job: an object under jobs.<camelName> whose heartbeat is its own name. Its script folder is checked by the write, which refuses a row out of it.
const orgJobShaped = (key: string, value: unknown): value is Record<string, unknown> => {
  const name = orgNameOf(key)
  return (
    isObject(value) &&
    /^[a-z][a-z0-9-]*$/.test(name) &&
    `${PREFIX}${name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}` === key &&
    value.heartbeat === name
  )
}

// Pure: each job from GET /api/v1/settings, A to Z by name, then scope: what it does, when it runs and whether it is on, and whether a setting sets it rather than its default. A registry job reads as your login does, its writes at your login's scope; an org's own job (a jobs.<camelName> row the registry lacks, at an org's scope, never your login's or core's, in the shape the jobs render reads) reads its org's row, its writes at that org.
export const jobRows = (listed: Listed, scope: string): JobRow[] => {
  const registry = new Set(listed.keys.flatMap(({ aliases, key }) => [key, ...(aliases ?? [])]))
  const orgs = listed.rows.flatMap(({ key, scope: org, value }) => {
    const skip = !key.startsWith(PREFIX) || registry.has(key) || org === scope || org === "core"
    if (skip || !orgJobShaped(key, value)) return []
    const job = value as JobValue
    return [
      {
        config: isObject(job.config) ? job.config : undefined,
        description: typeof job.description === "string" ? job.description : "",
        enabled: job.enabled === true,
        key,
        name: orgNameOf(key),
        row: value,
        schedule: job.schedule,
        scope: org,
        set: true,
      },
    ]
  })
  const own = listed.keys
    .filter(({ key }) => key.startsWith(PREFIX))
    .map(({ default: fallback, key }) => {
      const set = key in listed.values
      const job = (set ? listed.values[key] : fallback) as JobValue
      const row = listed.rows.find((each) => each.key === key && each.scope === scope)?.value
      return {
        config: job.config,
        description: job.description ?? "",
        enabled: job.enabled === true,
        key,
        name: nameOf(key),
        row: row as Record<string, unknown> | undefined,
        schedule: job.schedule,
        scope,
        set,
      }
    })
  return [...own, ...orgs].sort(
    (a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope),
  )
}

// Pure: what PUT /api/v1/settings/:key takes to turn a job on or off at its scope: its enabled field over the row its scope holds, never the registry's fields, so the rest still follow the registry, and an org's own job's whole row is written back with it.
export const jobToggleWrite = (job: JobRow, enabled: boolean) => ({
  json: {
    by: "Settings",
    reason: `Turned ${job.name} ${enabled ? "on" : "off"} in Settings > Jobs`,
    scope: job.scope,
    value: { ...job.row, enabled },
  },
  param: { key: job.key },
})

// Pure: what PUT /api/v1/settings/:key takes for the owner's own edit of a job's config at its scope: the new object over the row its scope holds, so its enabled field and the rest stay, written at once with no Inbox Approve, since the click is already the owner's.
export const jobConfigWrite = (job: JobRow, config: Record<string, unknown>) => ({
  json: {
    by: "Settings",
    reason: `Set ${job.name}'s config in Settings > Jobs`,
    scope: job.scope,
    value: { ...job.row, config } as Record<string, unknown>,
  },
  param: { key: job.key },
})

// Pure: the owner's typed config as the object it saves, or why it cannot be saved; core checks only that it is an object, and the job checks each field itself.
export const parseJobConfig = (
  text: string,
): { config: Record<string, unknown> } | { error: string } => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: "This is not JSON" }
  }
  if (!isObject(value)) return { error: "A config is a JSON object, {...}" }
  return { config: value }
}

export const readJobs = async (scope: string): Promise<JobRow[]> => {
  const { data, error } = await unwrap(apiClient.v1.settings.$get())
  if (error) throw new Error(error.message)
  return jobRows(data, scope)
}

export const saveJobToggle = async (job: JobRow, enabled: boolean) => {
  const { error } = await unwrap(apiClient.v1.settings[":key"].$put(jobToggleWrite(job, enabled)))
  if (error) throw new Error(error.message)
}

export const saveJobConfig = async (job: JobRow, config: Record<string, unknown>) => {
  const { error } = await unwrap(apiClient.v1.settings[":key"].$put(jobConfigWrite(job, config)))
  if (error) throw new Error(error.message)
}

// The job whose row in Settings > Jobs carries Restore now.
export const RESTORE_JOB = "ops-restore"

// Restore now: ops-restore's steps run once by the API on the checkout its server names; a refusal throws its reason, and the answer says what it restored or why not.
export const restoreCheckout = async () => {
  const { data, error } = await unwrap(apiClient.v1.ops.restore.$post())
  if (error) throw new Error(error.message)
  return data
}
