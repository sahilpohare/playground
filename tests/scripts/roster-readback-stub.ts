// preload for roster.test.ts: roster.ts set reads the row back through Bun.file(path) alone, so a stale roster for the on-disk roster makes the read-back hold a prs-= the write-back just cleared, which the read-back check refuses, so the check has a row that drives it.
import { readFileSync } from "node:fs"

import type { BunFile } from "bun"

// The stale roster the read-back reads: the row with the PR still set, as it would be if the write-back had left the clear unpersisted.
const readback = JSON.parse(readFileSync(process.env.ROSTER_READBACK_FILE!, "utf8")) as {
  agents: Array<Record<string, unknown>>
}

// roster.ts set reads the roster once to apply against, and once more in the read-back check, both through the same Bun.file(path). A prs-= applies against the first copy in place, so any later copy must be an independent clone: otherwise the read-back reads the row apply just cleared, which never diverges. A bare PR number links into factory.repo, read only when one is given, so a non-roster path is left to the real reader.
const real = Bun.file
Bun.file = ((target: string | URL) =>
  String(target).endsWith("roster.json")
    ? ({
        exists: async () => true,
        json: async () => structuredClone(readback),
      } as unknown as BunFile)
    : (real as unknown as (p: string | URL) => BunFile)(target)) as typeof Bun.file
