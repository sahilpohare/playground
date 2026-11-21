import { constants } from "node:os"
import { join } from "node:path"

import { managerOf } from "@packages/config/kinds"

import { engineData, REPO, run } from "../ops-job/job"
import { beat } from "../ops-tick/tick"
import { JOB, keep } from "./tunnel"

const data = engineData(JOB)

// The Inbox card the owner opens the link from: one update from Ops, whose title is the link.
const post = async (link: string, host: string): Promise<string | null> => {
  const roster: { agents?: unknown } | null = await Bun.file(join(data, "roster.json"))
    .json()
    .catch(() => null)
  const item = {
    from: managerOf(roster?.agents, "ops"),
    kind: "update",
    preview: {
      link,
      outcome: "finding",
      text: `This Mac reaches the Dashboard on ${host} through the tunnel job. Click the title to open it; it opens while the job runs.`,
    },
    title: `Open the Dashboard on ${host}`,
  }
  const posted = await run(
    ["bun", "run", "--silent", "--cwd", REPO, "ask", "new"],
    120_000,
    JSON.stringify(item),
  )
  const id = posted.out
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f-]{36}$/.test(line))
  if (posted.code !== 0 || !id)
    console.error(`${JOB}: card not posted: ${posted.out.trim().slice(-200)}`)
  return posted.code === 0 && id ? id : null
}

const stop = new AbortController()
let signal: NodeJS.Signals | undefined
for (const name of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
  process.on(name, () => {
    signal ??= name
    stop.abort()
  })
const startedAt = new Date()
await keep({ data, env: process.env, post, signal: stop.signal })
await beat(
  join(data, "ops", `${JOB}.json`),
  startedAt,
  new Date(),
  `loop exited: ${signal?.slice(3) ?? "stopped"}`,
  JOB,
)
process.exit(signal ? 128 + constants.signals[signal] : 0)
