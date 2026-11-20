import "@packages/env/aliases"
import { rename } from "node:fs/promises"
import { join } from "node:path"

import { dataDir } from "@packages/env/data-dir"

// The merge train's newest read of every open PR's pr:merge gates, in the data folder (data-dir.ts), which the Dashboard's Ready reads (api/hono/src/lib/dashboard/gates.ts), so a gate added to gatesOf reaches it with no second copy.
export const gatesPath = (): string => join(dataDir(), "ops", "merge-train", "gates.json")

// One PR's read: the gates it fails at its head, none when it would merge.
export type GateRead = { failed: string[]; head: string; n: number }

export type GatesFile = { at: string; prs: Record<string, { failed: string[]; head: string }> }

// Pure: the file's shape, each PR by `owner/name#number`, as held-prs.json keys them.
export const gatesFile = (repo: string, reads: GateRead[], at: string): GatesFile => ({
  at,
  prs: Object.fromEntries(reads.map(({ failed, head, n }) => [`${repo}#${n}`, { failed, head }])),
})

// Written whole beside the file, then moved over it, so a reader never sees half a file.
export async function writeGates(path: string, file: GatesFile): Promise<void> {
  const next = `${path}.${process.pid}.tmp`
  await Bun.write(next, `${JSON.stringify(file, null, 2)}\n`)
  await rename(next, path)
}
