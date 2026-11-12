import { lstat, readFile, realpath, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

import { factoryAsk } from "@packages/config/inbox"
import type { Database } from "@packages/db"
import { z } from "zod"

import { answerItem, type Deliver, getItem, itemTag } from "./inbox"

// The folder ops-wa writes the owner's WhatsApp answer to: inside the one no-raw-wa keeps every session out of, so a file there is ops-wa's alone (ADR 0024).
export const answersDir = (data: string) => join(data, "whatsapp", "answers")

const answerFile = z.strictObject({
  action: z.enum(["approve", "deny"]),
  id: z.uuid(),
  option: z.number().int().min(0).optional(),
})

type Answered = { line: string; ok: true } | { message: string; ok: false }
const refuse = (message: string): Answered => ({ message, ok: false })

// `bun run ask whatsapp <file>`: the owner's answer from WhatsApp, read from a file ops-wa wrote and deleted once read, so it answers once, through answerItem and deliver() as the Inbox's own Approve and Deny do, recorded as from WhatsApp; only a factory-scoped ask decision with one question takes one.
export async function whatsappAnswer(
  db: Database,
  path: string,
  {
    data,
    deliver,
    dispatcher,
    uid = process.getuid?.(),
  }: { data: string; deliver?: Deliver; dispatcher?: string; uid?: number },
): Promise<Answered> {
  const dir = await realpath(answersDir(data)).catch(() => null)
  const real = await realpath(path).catch(() => null)
  if (!dir || !real || dirname(real) !== dir)
    return refuse(`only a file ops-wa wrote in ${answersDir(data)} answers an item from WhatsApp`)
  const stat = await lstat(real)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== uid)
    return refuse("the answer file is not ops-wa's own: a regular file, mode 600, this user's")
  const text = await readFile(real, "utf8")
  await unlink(real)
  let parsed: z.infer<typeof answerFile>
  try {
    parsed = answerFile.parse(JSON.parse(text))
  } catch {
    return refuse("the answer file is not an answer ops-wa writes")
  }
  const item = await getItem(db, parsed.id)
  if (!item) return refuse("no inbox item with that id")
  if (!factoryAsk(item))
    return refuse(
      "only a factory-scoped ask decision with one question takes an answer from WhatsApp",
    )
  const result = await answerItem(
    db,
    item.id,
    { action: parsed.action, option: parsed.option },
    { actor: { label: "WhatsApp" }, deliver, dispatcher, via: "whatsapp" },
  )
  return result.ok
    ? { line: `answered ${itemTag(item.ref)} from WhatsApp`, ok: true }
    : refuse(result.message)
}
