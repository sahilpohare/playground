// Pure, with no app import, so verify's checks read the same labels the dashboard draws.
import { BACKEND_MAKERS, LOCAL_SERVED, MAKER_NAME } from "@packages/config/console"
import { DISPATCHER_SLOT_LABELS } from "@packages/config/kinds"

type ModelFacts = { effort: string | null; model: string | null }

export const MODEL_FAMILIES: Record<string, string> = {
  fable: "Fable",
  haiku: "Haiku",
  opus: "Opus",
  sonnet: "Sonnet",
}

const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/

const GLM_ID = /^glm-(\d+\.\d+)((?:-[a-z]+)*)(?:\[[^\]]*\])?$/

const capitalise = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

// Pure: a model id as people say it (claude-opus-5-5 reads Opus 5.5, claude-haiku-4-5-20251001 Haiku 4.5, glm-5.3-flash GLM 5.3 Flash), else the id as written; null when none is known.
export const modelName = (model: string | null): string | null => {
  if (!model) return null
  const glm = GLM_ID.exec(model)
  if (glm)
    return ["GLM", glm[1], ...(glm[2] ?? "").split("-").filter(Boolean).map(capitalise)].join(" ")
  const match = MODEL_ID.exec(model)
  const family = match ? MODEL_FAMILIES[match[1] ?? ""] : undefined
  if (!match || !family) return model
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`
}

// Pure: whether a model id is one of Z.ai's GLM models, whose usage the Claude windows do not reflect.
export const isGlmModel = (model: string | null): boolean => Boolean(model && GLM_ID.test(model))

// A model's maker, whose icon its row draws (useMakerIcon): its backend's for a Claude or GLM model, else the Hugging Face org of a local model's repo id.
export type Provider = string

const REPO_ORG = new RegExp(`^(${MAKER_NAME})/`)

// Pure: who makes a model, for its row's icon: Anthropic for a Claude id, Z.ai for a GLM one, the org of an org/repo id (a local model's, as config or the local server names it), else null, which draws the initials chip.
export const providerOf = (model: string | null): Provider | null =>
  !model
    ? null
    : model.startsWith("claude-")
      ? BACKEND_MAKERS.claude
      : isGlmModel(model)
        ? BACKEND_MAKERS.glm
        : (REPO_ORG.exec(model)?.[1] ?? null)

// A row's model, for a session on the local model the repo its server serves (the API's localModel), and the local models the hosted session's row lists.
type RowModel = { localModel?: string; localModels?: { id: string }[]; model: string | null }

// Pure: a local model's name as people say it, from its repo id: its family and size (ornith-ai/Ornith-1.5-122B-NVFP4 reads Ornith 122B), else its family alone.
export const localName = (repo: string): string => {
  const name = repo.split("/").at(-1) ?? repo
  const [family = name, ...rest] = name.split(/[-_]/)
  const size = rest.find((part) => /^\d+(\.\d+)?[bm]$/i.test(part))
  return size ? `${family} ${size.toUpperCase()}` : family
}

// Pure: a row's model name with no level, which levelName and the initials chip read: a local session's served repo and local (Ornith 122B, local), local alone while its server names none, else modelName's.
export const rowModelName = ({ localModel, model }: RowModel): string | null =>
  model === LOCAL_SERVED
    ? localModel
      ? `${localName(localModel)}, ${LOCAL_SERVED}`
      : LOCAL_SERVED
    : modelName(model)

// What a local session's effort does to its thinking, as spawn.sh's local launch sets it: low turns it off, medium caps it, and high and above leave it uncapped.
const LOCAL_THINKING: Record<string, string> = { low: "no thinking", medium: "thinking capped" }

// Pure: the words a row's model hint and its picker give: a local session's effort, name and thinking (high: Ornith 122B, thinking), else rowModelName's, as for a local session whose effort is unknown.
export const levelName = ({
  effort,
  ...row
}: RowModel & { effort: string | null }): string | null =>
  row.model === LOCAL_SERVED && effort
    ? `${effort}: ${row.localModel ? localName(row.localModel) : LOCAL_SERVED}, ${LOCAL_THINKING[effort] ?? "thinking"}`
    : rowModelName(row)

// Pure: whose icon a row draws: a local session's served repo's maker, none while its server names none, else its model's.
export const rowProvider = ({ localModel, model }: RowModel): Provider | null =>
  providerOf(model === LOCAL_SERVED ? (localModel ?? null) : model)

// Pure: the effort a row's icon draws: its own, which a served local session's launch set as its thinking, but none on a local model its own list names (the hosted session's pick), whose effort sets nothing.
export const rowEffort = ({ effort, localModels, model }: RowModel & { effort: string | null }) =>
  localModels?.some((local) => local.id === model) ? null : effort

// Pure: whether a row's words name its effort apart: a local model's chat template reads no effort, so a session on the served `local` names its level in its model's words (levelName), and one its own list names, as the hosted session's row reports after a pick, names none; its icon is rowEffort's.
export const showsEffort = ({ localModels, model }: RowModel): boolean =>
  model !== LOCAL_SERVED && !localModels?.some((local) => local.id === model)

// Pure: the two letters a maker with no icon draws in its chip, the first two of its model's name as people say it, the first capitalised (Or for Ornith 122B, local); none with no name.
export const initialsOf = (name: string | null): string => {
  const letters = (name ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2)
  return `${letters.charAt(0).toUpperCase()}${letters.slice(1)}`
}

// Pure: a dispatcher no label names (chatLabel's fallback), from its newest reply alone: that reply's model and effort, each word capitalised (Opus 5.5 High, GLM 5.3 Flash High). With no reply read yet, or its session down, the slot's label: Alpha for the primary, Bravo for the other.
export const dispatcherLabel = (facts: ModelFacts | null, primary: boolean): string => {
  const name = facts ? modelName(facts.model) : null
  if (!name) return DISPATCHER_SLOT_LABELS[primary ? 0 : 1]
  return facts?.effort ? `${name} ${capitalise(facts.effort)}` : name
}
