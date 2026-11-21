import "@/bin/needs-database"
import { createDatabase } from "@packages/db"
import { env } from "@packages/env/db"

import { branchOf, checkoutRoot } from "@/lib/dashboard/fixture"
import { uploadSpec } from "@/lib/dashboard/slack-upload"
import { livePair, othersLiveDashboard } from "@/lib/dev/launch"
import { locate, prove } from "@/lib/sessions/guard"

// dm upload's read of what to share: prints the UploadSpec of one answered Inbox item, named by its id alone, from this checkout's own database, proved as bun run thread proves it; it holds no Slack token and refuses any item whose go shares no files.
const fail = (message: string, code = 1): never => {
  console.error(`dashboard-upload: ${message}`)
  process.exit(code)
}

const args = process.argv.slice(2)
if (args.length !== 1 || !args[0]) fail("usage: dashboard-upload.ts <inbox item id>", 2)
const id = args[0] as string

try {
  const located = locate(env.POSTGRES_URL)
  if (othersLiveDashboard(located.owner.name, branchOf(checkoutRoot()))) {
    fail(`refusing ${livePair().database}, the live dashboard's database, off its own checkout`)
  }
  await prove(env.POSTGRES_URL, located)
} catch (error) {
  fail(`refusing to use the database: ${(error as Error).message}`)
}
const db = createDatabase(env.POSTGRES_URL)

try {
  console.log(JSON.stringify(await uploadSpec(db, id)))
  process.exit(0)
} catch (error) {
  fail((error as Error).message)
}
