import { homedir } from "node:os"
import { join } from "node:path"

import { dataDirOf } from "@packages/env/data-dir"
import { readPin } from "@packages/settings"

import { readModelMetrics } from "../local-model/live"
import { metricsBusy } from "../local-model/model"
import { beat, cycle, CYCLE_SECONDS, liveSessions, opsDirOf } from "./resume"

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
const beatPath = join(opsDirOf(), "ops-session-resume.json")
const isLocal = (name: string): Promise<boolean> =>
  Bun.file(join(dataDirOf(process.env), "backends", name))
    .text()
    .catch(() => "")
    .then((text) => readPin(text)?.backend === "local")
// A working session the local model serves is not quiet while its /metrics reads busy, so a 15-minute compaction is never read as stuck from the pane's idle; only a session whose backend pin reads local is checked, and an unreadable pin is not local.
const localBusy = async (name: string): Promise<boolean> =>
  (await isLocal(name)) && metricsBusy(await readModelMetrics())
const once = () =>
  cycle({
    configDir,
    live: () => liveSessions(configDir),
    localBusy,
  })

if (process.argv.includes("--once")) {
  const { result, resumed } = await once()
  console.log(`ops-session-resume: ${result}, ${resumed} resumed`)
  process.exit(result === "ok" ? 0 : 1)
}

const startedAt = new Date()
let lastResult = "ok"
let reading = false

const pulse = (result: string) =>
  beat(beatPath, startedAt, new Date(), result).catch((err) => console.error(err))

const run = async () => {
  if (reading) return
  reading = true
  const { result, resumed } = await once().finally(() => {
    reading = false
  })
  lastResult = result
  if (resumed || result !== "ok")
    console.log(`${new Date().toISOString()} ${result}, ${resumed} resumed`)
  await pulse(result)
}

// The beat runs on its own timer, so a cycle that hangs still beats, as failing, and never runs beside the next.
void run()
setInterval(() => {
  void pulse(reading ? "still resuming from the last cycle" : lastResult)
  void run()
}, CYCLE_SECONDS * 1000)
