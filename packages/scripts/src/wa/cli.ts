import { rename, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { dataDir } from "@packages/env/data-dir"

import { refusalOf } from "../ops-wa/bridge"
import { request, socketPath } from "../ops-wa/server"

// wa send <file>: the one way a session writes to the owner on WhatsApp, through ops-wa's socket, to the owner's number alone; wa relink: after a logout, sets the old link aside so ops-wa's next start posts a new pairing card.
const [verb, file, ...extra] = process.argv.slice(2)
if (verb === "relink" && !file) {
  const dir = join(dataDir(), "whatsapp")
  // the old auth state is set aside inside the guarded folder, never deleted, so nothing leaves it
  await rename(join(dir, "auth"), join(dir, `auth.${Date.now()}.old`)).catch(() => {})
  await rm(join(dir, "logged-out"), { force: true })
  console.log("wa relink: the old link is set aside; restart ops-wa for a new pairing card")
  process.exit(0)
}
if (
  verb !== "send" ||
  extra.length ||
  !file ||
  !isAbsolute(file) ||
  !(await Bun.file(file).exists())
) {
  console.error(
    "usage: playground wa send <file>, the reply's body in a file named by its absolute path; or playground wa relink",
  )
  process.exit(2)
}
const body = (await Bun.file(file).text()).trimEnd()
const refusal = refusalOf(body)
const reply = refusal ? { refusal } : await request(socketPath(dataDir()), body)
if (reply.refusal) {
  console.error(`wa send: ${reply.refusal}`)
  process.exit(1)
}
console.log("wa send: sent")
