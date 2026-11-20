import type { Worker } from "@api/hono"
import { LOCAL_SERVED, SESSION_EFFORTS, SESSION_MODELS } from "@packages/config/console"

import { apiClient, unwrap } from "@/lib/api/client"
import { levelName, MODEL_FAMILIES, showsEffort } from "@/lib/model-label"

export type SessionModel = (typeof SESSION_MODELS)[number]
export type SessionEffort = (typeof SESSION_EFFORTS)[number]
export type SessionSetting = { model: SessionModel } | { effort: SessionEffort } | { local: string }

// Each model by its family's word, as the session's row names it.
export const MODEL_LABELS = Object.fromEntries(
  SESSION_MODELS.map((alias) => [alias, MODEL_FAMILIES[alias] ?? alias]),
) as Record<SessionModel, string>

// In the order Claude Code's /effort takes them, least to most.
export const EFFORT_LABELS: Record<SessionEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

export const isModel = (value: unknown): value is SessionModel =>
  SESSION_MODELS.some((alias) => alias === value)

export const isEffort = (value: unknown): value is SessionEffort =>
  SESSION_EFFORTS.some((level) => level === value)

// Pure: the alias a model id runs as (claude-opus-5-5 is opus), or null for one none of the aliases names, such as another provider's.
export const modelAlias = (model: string | null): SessionModel | null =>
  SESSION_MODELS.find((alias) => model?.split(/[-/.]/).includes(alias)) ?? null

// Pure: the model and effort the session's row reports, each null when its newest reply named none the pickers know.
export const reportedSetting = (
  worker: Pick<Worker, "effort" | "model">,
): { effort: SessionEffort | null; model: SessionModel | null } => ({
  effort: isEffort(worker.effort) ? worker.effort : null,
  model: modelAlias(worker.model),
})

const LOCAL = "local:"

// Pure: the model menu's value for the row's model: a local model's (local:<id>) while the hosted session runs on one its row lists, else the cloud alias it runs as; null for none the menu knows.
export const modelChoice = (worker: Pick<Worker, "localModels" | "model">): string | null =>
  worker.localModels?.some((local) => local.id === worker.model)
    ? `${LOCAL}${worker.model}`
    : modelAlias(worker.model)

// Pure: the composer's line for the hosted session's load of a local model: while it loads, what it waits on and about how long; once failed, the API's own words; null with none.
export const localLoadLine = (
  load: Worker["localLoad"],
): { failed: boolean; text: string } | null =>
  !load
    ? null
    : load.state === "failed"
      ? { failed: true, text: load.reason ?? `${load.label} couldn't load.` }
      : {
          failed: false,
          text: `Loading ${load.label} on the local model server, about 10 minutes. The chat switches to it once it answers.`,
        }

// Pure: the menu value of one local model.
export const localChoice = (id: string): string => `${LOCAL}${id}`

// Pure: the setting a model menu value picks, or null for one it does not offer.
export const choiceSetting = (choice: string): SessionSetting | null =>
  choice.startsWith(LOCAL)
    ? { local: choice.slice(LOCAL.length) }
    : isModel(choice)
      ? { model: choice }
      : null

// Pure: a model menu value's words: a cloud model by its family's word, a local one by the label config gives it.
export const choiceLabel = (
  choice: string,
  localModels: Worker["localModels"] = [],
): string | null =>
  choice.startsWith(LOCAL)
    ? (localModels.find((local) => localChoice(local.id) === choice)?.label ?? null)
    : isModel(choice)
      ? MODEL_LABELS[choice]
      : null

// Pure: whether the picker's Effort group takes no pick: a session on the served local model, whose launch set its thinking from its effort, so a later /effort would change its words and not its thinking.
export const effortFixed = (worker: Pick<Worker, "model">, model: string | null): boolean =>
  model === null && worker.model === LOCAL_SERVED

// Pure: the picker's words, the shown model then its effort, which a local model leaves out as its row does (showsEffort); a session on the served local model reads its level in words for both (levelName).
export const pickerWords = (
  worker: Pick<Worker, "localModel" | "localModels" | "model">,
  model: string | null,
  effort: SessionEffort | null,
): string => {
  const served = model === null && !showsEffort(worker)
  const name =
    (model && choiceLabel(model, worker.localModels)) ||
    (served && levelName({ ...worker, effort })) ||
    "Model"
  return model?.startsWith(LOCAL) || served
    ? name
    : `${name} · ${effort ? EFFORT_LABELS[effort] : "Effort"}`
}

// A pick not yet on the session's row: the value picked, and the value the row showed when it was picked; a dispatcher's row takes a new model or effort only from its next reply, while the hosted session's shows it at once.
export type Pending<T> = { from: T | null; to: T }

// Pure: the value a picker shows: a pick from the moment it is made until the row reports a value other than the one it was picked over.
export const shownValue = <T>(pending: Pending<T> | null, reported: T | null): T | null =>
  pending && reported === pending.from ? pending.to : reported

// Pure: whether the API's refusal is a dispatcher holding an effort pick (QUEUED, as while it compacts), which Claude Code runs once free, so the pick stays shown rather than failing.
export const heldPick = (error: object | null): boolean =>
  error !== null && "delivery" in error && error.delivery === "QUEUED"

// Sets a dispatcher's, the assistant's or the hosted session's model or effort through the API, which sets it on the session and records it in the console's activity (a local model, the hosted session's alone, restarts it on that model's server); the pick's own id lets a dispatcher that holds an effort pick while it compacts read QUEUED.
export async function changeSetting(sessionId: string, setting: SessionSetting) {
  return unwrap(
    apiClient.v1.workers[":sessionId"].setting.$post({
      json: { ...setting, id: crypto.randomUUID() },
      param: { sessionId },
    }),
  )
}
