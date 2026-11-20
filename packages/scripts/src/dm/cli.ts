import { isAbsolute } from "node:path"

import { dataDir } from "@packages/env/data-dir"
import { readPolicyOrDefaults } from "@packages/settings"

import { REPO } from "../ops-job/job"
import { SLACK_NOT_SET_UP, slackScript, slackSetUp } from "../playground/installed"
import { orgsIo } from "../playground/orgs"

// dm send <file>: the one way a session posts to the owner's DM, the dispatcher and the assistant alike; dm upload <item id>: the dashboard's share of an answered Inbox item's files, with a draft's words as their message, the place, the files and the words read from that item alone. Each runs the slack skill's own script, which reads the token from the Keychain in its own process.
const [verb, file, ...extra] = process.argv.slice(2)
const sending =
  verb === "send" && !extra.length && file && isAbsolute(file) && (await Bun.file(file).exists())
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uploading = verb === "upload" && !extra.length && !!file && ITEM_ID.test(file)
if (!sending && !uploading) {
  console.error(
    "usage: playground dm send <file>, the reply's body in a file named by its absolute path; or playground dm upload <item id>, an answered Inbox item's id",
  )
  process.exit(2)
}
// The owner's DM first, for a send alone (an upload's place comes from its item), then the slack skill, so each line names what this Mac really lacks
const policy = readPolicyOrDefaults(dataDir())
if (policy.refusal !== undefined) {
  console.error(`dm ${verb}: ${policy.refusal}`)
  process.exit(2)
}
if (sending && !slackSetUp(policy.settings)) {
  console.error(`dm send: ${SLACK_NOT_SET_UP}`)
  process.exit(2)
}
const slack = await slackScript(orgsIo(REPO, dataDir()), sending ? "send.ts" : "upload.ts")
if (slack.refusal !== undefined) {
  console.error(`dm ${verb}: ${slack.refusal}`)
  process.exit(2)
}
const proc = Bun.spawn([process.execPath, slack.script, file as string], {
  stdio: ["ignore", "inherit", "inherit"],
})
process.exit(await proc.exited)
