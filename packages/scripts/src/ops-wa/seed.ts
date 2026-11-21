import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// alert-seed.json in ops-wa's folder: the owner's Approve of a wa.alert guard card in the Inbox stands in for that number's first message, so an alert may reach it (ADR 0028); the Inbox's guardWrite and ops-wa's wa alert-set, from the owner's own message (ADR 0032), write it.
export const alertSeedFile = (whatsappDir: string) => join(whatsappDir, "alert-seed.json")

export function seedAlert(data: string, number: string, at: number) {
  const dir = join(data, "whatsapp")
  mkdirSync(dir, { mode: 0o700, recursive: true })
  const path = alertSeedFile(dir)
  writeFileSync(path, JSON.stringify({ at, number }), { mode: 0o600 })
  chmodSync(path, 0o600)
}
