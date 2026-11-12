import { apiClient, unwrap } from "@/lib/api/client"
import { config } from "@/lib/config"
import { type Check, checksOf, refusalOf } from "@/lib/onboard"

// The harness Alpha starts on (packages/settings' harness.alpha): first run's cards pick it, Settings' Switch Alpha moves it, and each card reads GET /api/v1/onboard/harnesses.

export type HarnessId = "claude-code" | "codex"

// One harness's card as the API answers it: Installed, Signed in and Plan as check rows, whether it is ready to start, and the refusal while its start would be refused.
export type HarnessCard = {
  checks: Check[]
  id: HarnessId
  label: string
  ready: boolean
  refusal: string | null
}

export type SwitchRead = {
  ask: string | null
  harness: HarnessId | null
  reason: string | null
  state: "failed" | "idle" | "ok" | "running"
  step: string | null
  to: string | null
}

// Pure: the message Switch Alpha's click sends through the outbox, the running dispatcher asked for its handoff, or null when the switch asks nothing.
export const switchMessage = (read: SwitchRead): { text: string; to: string } | null =>
  read.state === "running" && read.ask && read.to ? { text: read.ask, to: read.to } : null

export const ALPHA_KEY = "harness.alpha"
export const HARNESSES_QUERY_KEY = ["onboard", "harnesses"] as const
export const ALPHA_QUERY_KEY = ["setting", ALPHA_KEY] as const

const HARNESSES_URL = `${config.api.url}/api/v1/onboard/harnesses`
const SWITCH_URL = `${config.api.url}/api/v1/dashboard/dispatcher/switch`
const IDS: HarnessId[] = ["claude-code", "codex"]

const isId = (value: unknown): value is HarnessId => IDS.includes(value as HarnessId)

// Pure: the cards in GET /api/v1/onboard/harnesses's body, in the API's order, or undefined when they do not read as cards.
export const harnessesOf = (body: unknown): HarnessCard[] | undefined => {
  const cards = (body as { data?: { harnesses?: unknown } } | null)?.data?.harnesses
  if (!Array.isArray(cards)) return undefined
  const read = cards.map((card) => {
    const c = card as Partial<HarnessCard> | null
    const checks = checksOf({ data: { checks: c?.checks, done: false } })?.checks
    return isId(c?.id) &&
      checks &&
      typeof c.label === "string" &&
      typeof c.ready === "boolean" &&
      (c.refusal === null || typeof c.refusal === "string")
      ? ({ ...c, checks } as HarnessCard)
      : undefined
  })
  return read.every(Boolean) ? (read as HarnessCard[]) : undefined
}

// Pure: whether Start Alpha turns on for the pick: its card reads Installed and Signed in, and nothing refuses its start.
export const canStart = (cards: HarnessCard[], pick: HarnessId): boolean => {
  const card = cards.find((c) => c.id === pick)
  return Boolean(card?.ready && !card.refusal)
}

// GET the cards; the owner's cookie goes once one is signed in, as the fixes' calls do.
export const readHarnesses = async (): Promise<HarnessCard[]> => {
  const response = await fetch(HARNESSES_URL, { cache: "no-store", credentials: "include" }).catch(
    () => undefined,
  )
  if (!response) throw new Error("The app's server did not answer; it may be restarting")
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(refusalOf(body, response.status))
  const cards = harnessesOf(body)
  if (!cards) throw new Error("The harnesses did not read as cards")
  return cards
}

// GET harness.alpha's value, Claude Code when it reads as none.
export const readAlpha = async (): Promise<HarnessId> => {
  const { data, error } = await unwrap(
    apiClient.v1.settings[":key"].$get({ param: { key: ALPHA_KEY }, query: {} }),
  )
  if (error) throw new Error(error.message)
  return isId(data.value) ? data.value : "claude-code"
}

// Pure: what PUT /api/v1/settings/:key takes to save the pick at your login's scope.
export const alphaWrite = (harness: HarnessId, scope: string) => ({
  json: { by: "Dashboard", reason: "Picked Alpha's harness on first run", scope, value: harness },
  param: { key: ALPHA_KEY },
})

export const saveAlpha = async (harness: HarnessId, scope: string) => {
  const { error } = await unwrap(apiClient.v1.settings[":key"].$put(alphaWrite(harness, scope)))
  if (error) throw new Error(error.message)
}

const switchCall = async (method: "GET" | "POST", harness?: HarnessId): Promise<SwitchRead> => {
  const response = await fetch(SWITCH_URL, {
    body: harness ? JSON.stringify({ harness }) : undefined,
    cache: "no-store",
    credentials: "include",
    headers: harness ? { "content-type": "application/json" } : undefined,
    method,
  }).catch(() => undefined)
  if (!response) throw new Error("The app's server did not answer; it may be restarting")
  const body = (await response.json().catch(() => null)) as { data?: SwitchRead } | null
  if (!response.ok || !body?.data) throw new Error(refusalOf(body, response.status))
  return body.data
}

export const readSwitch = () => switchCall("GET")
export const startSwitch = (harness: HarnessId) => switchCall("POST", harness)
