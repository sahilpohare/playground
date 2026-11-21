import { homedir, constants } from "node:os"
import { dirname, join } from "node:path"

import { engineData, REPO, sendAs } from "../ops-job/job"
import { beat } from "../ops-tick/tick"
import { JOB, keep } from "./relay"

const data = engineData(JOB)

// The far end runs from the far machine's main checkout, at this machine's main checkout's path, as spawn.sh --ssh assumes.
const common = Bun.spawnSync([
  "git",
  "-C",
  REPO,
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
])
const checkout = common.exitCode === 0 ? dirname(common.stdout.toString().trim()) : REPO

const stop = new AbortController()
let signal: NodeJS.Signals | undefined
for (const name of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
  process.on(name, () => {
    signal ??= name
    stop.abort()
  })
const startedAt = new Date()
const tell = sendAs(JOB)
await keep({
  checkout,
  data,
  envText: () =>
    Bun.file(join(REPO, ".env"))
      .text()
      .catch(() => ""),
  home: process.env.HOME || homedir(),
  notify: (text) => tell("ops", text),
  signal: stop.signal,
})
await beat(
  join(data, "ops", `${JOB}.json`),
  startedAt,
  new Date(),
  `loop exited: ${signal?.slice(3) ?? "stopped"}`,
  JOB,
)
process.exit(signal ? 128 + constants.signals[signal] : 0)
