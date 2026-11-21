import { rename, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { dataDir } from "@packages/env/data-dir"
import { readPolicy, whatsappSettings } from "@packages/settings"

import { refusalOf, statusOf } from "../ops-wa/bridge"
import { type Extra, extraRefusal } from "../ops-wa/outbound"
import { reactRequest, request, requestAlertSet, socketPath } from "../ops-wa/server"

// wa send <file>: the one way a session writes to the owner on WhatsApp, through ops-wa's socket, to the owner's number alone, with --file <path> a file from the outbox beside it (outbound.ts), the body its caption, --location <lat>,<lon> a location, the body its name, --quote <id> a reply quoting a kept message, --edit <id> or --delete <id> one of our own sent messages, --status the owner's one live status message, edited in place; it prints the sent messages' ids; wa send --to alert <file>: a reply to the alert number, a guest of the chat; wa alert <file>: an urgent alert alone, to the owner first and on to the alert number after wa.alertDelayMinutes unless handled, or to both at once with --now-both; wa react <emoji> [--to alert] [--id <id>]: a reaction on the latest message of the owner's, or the guest's, or on the one named; wa status: whether each number has written or been approved, whether a reply can go to each now, when the owner last read our messages, whether the last alert to the alert number was delivered and read, each pending alert, and the last alert's outcome with its times; wa relink: after a logout, sets the old link aside so ops-wa's next start posts a new pairing card; wa alert-set --from-owner-msg <id>: the second number becomes the one number in the owner's own message of that id.
const args = process.argv.slice(2)
const [verb, ...rest] = args
let guest = false
// wa send --status: the update as the owner's one live status message, edited in place (ops-wa's statusNow)
let status = false
// wa alert's flags: --now-both sends to both numbers at once, --source <kind>:<ref> names what a checker reads to tell whether it was handled
let nowBoth = false
let source: string | undefined
const sendFlags: Record<string, string> = {}
const words: string[] = []
for (let i = 0; i < rest.length; i++) {
  const flag = rest[i]!.slice(2)
  if (verb === "alert" && rest[i] === "--now-both" && !nowBoth) nowBoth = true
  else if (verb === "alert" && rest[i] === "--source" && source === undefined) {
    if (!/^[a-z][\w-]*:\S+$/.test(rest[i + 1] ?? "")) {
      console.error("wa alert: --source takes <kind>:<ref>, such as test:2026-11-11T03:00Z")
      process.exit(2)
    }
    source = rest[i + 1]
    i++
  } else if (verb === "send" && rest[i] === "--status" && !status) status = true
  else if (verb === "send" && !guest && rest[i] === "--to" && rest[i + 1] === "alert") {
    guest = true
    i++
  } else if (
    verb === "send" &&
    ["delete", "edit", "file", "location", "quote"].includes(flag) &&
    rest[i] === `--${flag}` &&
    sendFlags[flag] === undefined
  ) {
    sendFlags[flag] = rest[i + 1] ?? ""
    i++
  } else words.push(rest[i]!)
}
const [lat, lon, ...more] = (sendFlags.location ?? "")
  .split(",")
  .map((n) => (n.trim() ? Number(n) : NaN))
const sending: Extra = {
  ...(sendFlags.delete !== undefined && { delete: sendFlags.delete }),
  ...(sendFlags.edit !== undefined && { edit: sendFlags.edit }),
  ...(sendFlags.file !== undefined && { file: sendFlags.file }),
  ...(sendFlags.location !== undefined && {
    location: { lat: lat!, lon: more.length ? NaN : lon! },
  }),
  ...(sendFlags.quote !== undefined && { quote: sendFlags.quote }),
  ...(status && { status: true as const }),
}
const [file, ...extra] = words
const named = async (path: string | undefined) =>
  !!path && isAbsolute(path) && (await Bun.file(path).exists())
if (verb === "relink" && !file) {
  const dir = join(dataDir(), "whatsapp")
  // the old auth state is set aside inside the guarded folder, never deleted, so nothing leaves it
  await rename(join(dir, "auth"), join(dir, `auth.${Date.now()}.old`)).catch(() => {})
  await rm(join(dir, "logged-out"), { force: true })
  console.log("wa relink: the old link is set aside; restart ops-wa for a new pairing card")
  process.exit(0)
}
if (args[0] === "react") {
  const [, emoji, ...flags] = args
  const on: { id?: string; who?: "alert" } = {}
  let bad = flags.length % 2 === 1
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === "--to" && flags[i + 1] === "alert" && !on.who) on.who = "alert"
    else if (flags[i] === "--id" && flags[i + 1] && !on.id) on.id = flags[i + 1]
    else bad = true
  }
  // one emoji, as WhatsApp's reaction takes, never words
  const one =
    /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\u200d\ufe0f\p{Emoji_Modifier}]*$/u
  if (bad || !emoji || !one.test(emoji)) {
    console.error("usage: playground wa react <emoji> [--to alert] [--id <id>]")
    process.exit(2)
  }
  const reply = await reactRequest(socketPath(dataDir()), emoji, on)
  if (reply.refusal) {
    console.error(`wa react: ${reply.refusal}`)
    process.exit(1)
  }
  console.log("wa react: sent")
  process.exit(0)
}
if (verb === "status" && !file) {
  const policy = await readPolicy(dataDir())
  if (policy.refusal !== undefined) {
    console.error(`wa status: the settings refuse: ${policy.refusal}`)
    process.exit(1)
  }
  const lines = await statusOf(
    join(dataDir(), "whatsapp"),
    {
      alert: whatsappSettings.get(policy.settings, "wa.alert"),
      owner: whatsappSettings.get(policy.settings, "wa.owner"),
    },
    Date.now(),
  )
  for (const line of lines) console.log(`wa status: ${line}`)
  process.exit(0)
}
if (verb === "alert-set") {
  if (file !== "--from-owner-msg" || extra.length !== 1 || !extra[0]) {
    console.error("usage: playground wa alert-set --from-owner-msg <id>")
    process.exit(2)
  }
  const reply = await requestAlertSet(socketPath(dataDir()), extra[0])
  if (reply.refusal) {
    console.error(`wa alert-set: ${reply.refusal}`)
    process.exit(1)
  }
  console.log(`wa alert-set: ${reply.note}`)
  process.exit(0)
}
if (
  (verb !== "send" && verb !== "alert") ||
  extra.length ||
  !(file ? await named(file) : (sending.file ?? sending.location ?? sending.delete)) ||
  (sending.file !== undefined && !(await named(sending.file))) ||
  Object.values(sendFlags).some((v) => !v)
) {
  console.error(
    "usage: playground wa send [--to alert] <file>, the reply's body in a file named by its absolute path, to the owner or to the alert number; playground wa send [--to alert] --file <path> [<file>], an image, a document, a video or a voice note in the data folder's wa/outbox/, named by its absolute path, the body its caption; playground wa send [--to alert] --location <lat>,<lon> [<file>], a location, the body its name; playground wa send [--to alert] --quote <id> <file>, a reply quoting a kept message of that id; playground wa send [--to alert] --edit <id> <file> or --delete <id>, an edit or a delete of a message wa send sent, by the id it printed; playground wa send --status <file>, the update as your one live status message, edited in place while WhatsApp takes an edit; playground wa alert [--now-both] [--source <kind>:<ref>] <file>, an urgent alert alone, to the owner first and to the alert number unless handled before wa.alertDelayMinutes passes, or to both at once; playground wa react <emoji> [--to alert] [--id <id>]; playground wa status; playground wa alert-set --from-owner-msg <id>; or playground wa relink",
  )
  process.exit(2)
}
const body = file ? (await Bun.file(file).text()).trimEnd() : ""
const refusal = refusalOf(body) ?? extraRefusal(sending, body)
const reply: Awaited<ReturnType<typeof request>> = refusal
  ? { refusal }
  : await request(
      socketPath(dataDir()),
      body,
      verb === "alert" ? (nowBoth ? "alert" : "first") : guest ? "guest" : "reply",
      600_000,
      source,
      sending,
    )
if (reply.refusal) {
  console.error(`wa ${verb}: ${reply.refusal}`)
  process.exit(1)
}
const ids = reply.ids?.length
  ? ` (${reply.ids.length > 1 ? "ids" : "id"} ${reply.ids.join(", ")})`
  : ""
console.log(`wa ${verb}: ${reply.note ?? "sent"}${ids}`)
