import { z } from "zod"

import { apiClient, unwrap } from "@/lib/api/client"

// The two numbers WhatsApp mode needs (packages/settings/src/whatsapp.ts): the spare number the bridge links, and yours, the one it takes messages from.
export const WHATSAPP_KEYS = { device: "wa.device", owner: "wa.owner" } as const

export type WhatsappKey = (typeof WHATSAPP_KEYS)[keyof typeof WHATSAPP_KEYS]

export const whatsappQueryKey = (key: WhatsappKey) => ["setting", key] as const

// Checked as its setting's schema checks it: + and 8 to 15 digits, or empty to keep what is saved.
const number = z
  .string()
  .trim()
  .regex(/^(?:\+[1-9]\d{7,14})?$/, "A phone number is + and 8 to 15 digits, as +15550100001")

export const whatsappFormSchema = z.object({ device: number, owner: number })

export type WhatsappForm = z.input<typeof whatsappFormSchema>

// Pure: the fields a Save writes, each you typed a number into, since a saved number never comes back to its field whole.
export const whatsappWrites = (form: WhatsappForm): { key: WhatsappKey; value: string }[] =>
  (["device", "owner"] as const)
    .map((field) => ({ key: WHATSAPP_KEYS[field], value: form[field].trim() }))
    .filter((field) => field.value.length > 0)

// Pure: what PUT /api/v1/settings/:key takes to save one number at your login's scope.
export const whatsappWrite = (key: WhatsappKey, value: string, scope: string) => ({
  json: { by: "Settings", reason: `Set ${key} in Settings > Extensions`, scope, value },
  param: { key },
})

// GET one number as the API gives it, by its last 4 digits alone, or empty while unset.
export const readWhatsappSetting = async (key: WhatsappKey): Promise<string> => {
  const { data, error } = await unwrap(
    apiClient.v1.settings[":key"].$get({ param: { key }, query: {} }),
  )
  if (error) throw new Error(error.message)
  return typeof data.value === "string" ? data.value : ""
}

export const saveWhatsappSetting = async (key: WhatsappKey, value: string, scope: string) => {
  const { error } = await unwrap(
    apiClient.v1.settings[":key"].$put(whatsappWrite(key, value, scope)),
  )
  if (error) throw new Error(error.message)
}
