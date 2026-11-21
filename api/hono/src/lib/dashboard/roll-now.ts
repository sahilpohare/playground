import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { currentSource, type DashboardSource, ensureFixture } from "@/lib/dashboard/fixture"
import { dataDir } from "@/lib/sessions/paths"

// The user menu's Update now on the live dashboard: writes the supervisor's roll-now file, as `playground update` does, so the supervisor rolls to its branch's head at once, past its holds; a fixture stack writes it in the fixture's scratch folder.

export class RollNowError extends Error {}

export function requestRoll({
  data = dataDir(),
  source = currentSource(),
}: { data?: string; source?: DashboardSource } = {}): { file: string } {
  if (source.kind === "fixture") {
    const file = join(ensureFixture(source), "roll-now")
    writeFileSync(file, "")
    return { file }
  }
  if (source.kind !== "live" || source.rule !== "live-branch")
    throw new RollNowError(
      "Only the live dashboard rolls; this stack updates by git pull, then restart",
    )
  const state = join(data, "ops", "dashboard")
  if (!existsSync(state)) throw new RollNowError("The Dashboard's supervisor is not running")
  if (existsSync(join(state, "paused")))
    throw new RollNowError(`The Dashboard's supervisor is paused (${join(state, "paused")})`)
  const file = join(state, "roll-now")
  writeFileSync(file, "")
  return { file }
}
