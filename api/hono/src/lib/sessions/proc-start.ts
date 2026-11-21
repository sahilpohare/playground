import { readFileSync } from "node:fs"
import { join } from "node:path"

import { procRoot } from "@packages/scripts/ops-machine/readings"

// Claude Code's registry file records when its process started (procStart) in its machine's own form: on macOS as `ps -o lstart=` prints it under C (`Mon Nov 16 07:02:17 2026`), on Linux as clock ticks since boot, field 22 of /proc/<pid>/stat (`1801742`), which this shape tells apart.
export const TICKS = /^\d+$/

// When pid's process started, in clock ticks since boot, or null when /proc lists no such process. Its command (field 2) sits in parentheses and may hold spaces or a parenthesis, so the fields are counted past its last ")".
export function ticksOf(pid: number): string | null {
  try {
    const stat = readFileSync(join(procRoot(), String(pid), "stat"), "utf8")
    const start = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[19]
    return start !== undefined && TICKS.test(start) ? start : null
  } catch {
    return null
  }
}

// starts (each pid's start as ps's lstart reads it now) with the start of each pid whose record gives procStart in ticks read from /proc instead, so each start compares with its record as the record writes it; such a pid /proc does not list is left out, as gone.
export function inRecordedForm(
  starts: ReadonlyMap<number, string>,
  records: Iterable<{ pid: number; procStart?: unknown }>,
): Map<number, string> {
  const out = new Map(starts)
  for (const { pid, procStart } of records) {
    if (typeof procStart !== "string" || !TICKS.test(procStart)) continue
    const ticks = ticksOf(pid)
    if (ticks === null) out.delete(pid)
    else out.set(pid, ticks)
  }
  return out
}
