import { join } from "node:path"

import type { Database } from "@packages/db"

import { readAttachment } from "@/lib/dashboard/attachments"
import { checkoutRoot, readsLive } from "@/lib/dashboard/fixture"
import { filesToUpload, getItem, type Upload } from "@/lib/dashboard/inbox"

// What dm upload shares, read from the stored item alone: the place its link names, each file's name, bytes (base64) and whether those bytes are text, which the folder's name for it says (sniffed when it was kept), and a draft's words, which go as the files' message.
export type UploadSpec = {
  channel: string
  files: { bytes: string; name: string; text: boolean }[]
  text?: string
  thread?: string
}

// The spec for an answered item whose go shares its files and has shared none yet (filesToUpload), while its send is pending, its files read from the attachments folder alone; throws why for any other item, so a caller can name only an item the owner sent, never a channel, a thread or a path.
export async function uploadSpec(
  db: Database,
  id: string,
  read: typeof readAttachment = readAttachment,
): Promise<UploadSpec> {
  const item = await getItem(db, id)
  if (!item || item.id !== id) throw new Error(`no Inbox item ${id}`)
  // only while the API's own send is in flight: an item sent before, its words gone or failed, shares nothing unasked
  const shared = item.delivery?.status === "pending" ? filesToUpload(item) : null
  if (!shared)
    throw new Error(
      `${id} holds no files a Send or an Approve shares into Slack, or its send is not in flight`,
    )
  const files = []
  for (const file of shared.files) {
    const kept = await read(file.id)
    if (!kept) throw new Error(`${file.name} is gone from the attachments folder`)
    files.push({
      bytes: Buffer.from(kept.bytes).toString("base64"),
      name: file.name,
      text: kept.file.kind === "text",
    })
  }
  return { ...shared.place, files, ...(shared.text && { text: shared.text }) }
}

// A Slack send's files, shared by `playground dm upload <item id>` from the API's own checkout, which reads the place and the files from the item itself, so the Slack token stays in that run's process (the slack skill's upload.ts reads it from the Keychain) and never passes through a session or an argv. A stack that does not read this machine (a fixture's, a test's) shares nothing and counts none, since its items are made up.
export const slackUpload =
  ({ live = readsLive(), root = checkoutRoot() } = {}): Upload =>
  async (item) => {
    if (!live) return 0
    if (!root) throw new Error("this API has no checkout to run dm upload from")
    const child = Bun.spawn(
      ["bun", "--no-env-file", join(root, "packages/scripts/src/dm/cli.ts"), "upload", item.id],
      { cwd: root, stderr: "pipe", stdin: "ignore", stdout: "ignore" },
    )
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    if (code !== 0)
      throw new Error(
        stderr
          .trim()
          .split("\n")
          .at(-1)
          ?.replace(/^error: /, "") || `exit ${code}`,
      )
    return filesToUpload(item)?.files.length ?? 0
  }
