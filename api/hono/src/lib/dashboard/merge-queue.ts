import { join } from "node:path"

import { z } from "zod"

import { readFixtureMachine, readsLive } from "@/lib/dashboard/fixture"
import { checkoutRepo, pullsUrlOf, repoOf } from "@/lib/dashboard/repo"
import { entries } from "@/lib/entries"
import { dataDir } from "@/lib/sessions/paths"

// The leads' merge queue (merge-queue.json in the data folder): each open pull request in the order it will merge, with when it is expected to merge and the leads' words for it, and the parked ones, beside other keys that belong to the leads. The Builder writes it (playbook's SWEEP.md); the dashboard only reads it, and reads only what the Pull requests tab shows. Its numbers belong to this checkout's repository.
const isoTime = z.iso.datetime({ offset: true })

const queueEntrySchema = z.object({
  etaMerge: isoTime.optional(),
  item: z.string().optional(),
  pr: z.number().int().positive(),
})

const parkedEntrySchema = z.object({
  pr: z.number().int().positive(),
})

const envelopeSchema = z.object({
  parked: z.unknown().optional(),
  queue: z.unknown().optional(),
})

export type MergeQueueEntry = z.infer<typeof queueEntrySchema>
export type MergeQueueParked = z.infer<typeof parkedEntrySchema>
export type MergeQueue = { parked: MergeQueueParked[]; queue: MergeQueueEntry[] }

export const mergeQueuePath = (): string => join(dataDir(), "merge-queue.json")

// The repository the tab matches the queue by, the stack's own, so a number alone never matches another repository's pull: the live checkout's origin, or, on a fixture stack, the fixture's own, so no fixture read ever runs git.
export const queueRepo = (): string =>
  (readsLive() ? checkoutRepo() : repoOf(pullsUrlOf(readFixtureMachine().origin ?? null))) ?? ""

// Each entry is checked on its own, so one bad entry drops only that entry, and a pull listed twice keeps its first place, so a place number counts rows.
export function parseMergeQueue(text: string): MergeQueue | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) return null
  const problems: string[] = []
  const queue = entries<MergeQueueEntry>(
    queueEntrySchema,
    envelope.data.queue,
    ["queue"],
    problems,
    (row) => String(row.pr),
  )
  const parked = entries<MergeQueueParked>(
    parkedEntrySchema,
    envelope.data.parked,
    ["parked"],
    problems,
    (row) => String(row.pr),
  )
  return { parked, queue }
}

let cached: { key: string; read: MergeQueue | null } | null = null

// Read again only when the file changes: every caller on a refresh loop shares one parse per write. A file that is missing, goes between the stat and the read, or cannot be read (a directory, no permission) is no queue, never a thrown error.
export async function readMergeQueue(path = mergeQueuePath()): Promise<MergeQueue | null> {
  try {
    const stat = await Bun.file(path).stat()
    const key = `${path}:${stat.mtimeMs}:${stat.size}`
    if (cached?.key === key) return cached.read
    const read = parseMergeQueue(await Bun.file(path).text())
    cached = { key, read }
    return read
  } catch {
    return null
  }
}
