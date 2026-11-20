import { join } from "node:path"

import { engineData, hold } from "../ops-job/job"

const JOB = "ops-keep-awake"

// One child, caffeinate's idle and system sleep holds, beating while it lives; its exit ends the job, and up.py starts it again. The registry renders it on macOS alone, so a hand run anywhere else holds nothing and says why.
if (process.platform === "darwin") {
  process.exit(await hold(JOB, ["caffeinate", "-i", "-s"], join(engineData(JOB), "ops")))
}
console.error(`${JOB}: caffeinate is macOS's alone, so this job runs on a Mac only`)
process.exit(2)
