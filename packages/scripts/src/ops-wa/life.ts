import { join } from "node:path"

import {
  BACKOFF,
  backoffMs,
  connectFreesAt,
  type Link,
  mayConnect,
  ownFolder,
  readOwn,
  writeOwn,
} from "./habits"

// Baileys' DisconnectReason.loggedOut: WhatsApp removed the linked device.
const LOGGED_OUT = 401

type Update = {
  connection?: string
  lastDisconnect?: { error?: { output?: { statusCode?: number } } }
  qr?: string
}
// The calls the life makes on a Baileys socket, so a test hands it a fake one.
export type LinkSock = {
  authState: { creds: { registered?: boolean } }
  ev: { on(name: "connection.update", fn: (update: Update) => void): void }
  requestPairingCode(phone: string): Promise<string>
}
export type LifeIo<S extends LinkSock> = {
  alert: (text: string) => Promise<unknown>
  // posts the pairing card with its code, answering the card's id
  card: (code: string) => Promise<string | undefined>
  connect: () => Promise<S>
  // the spare number in E.164, the linked device's own
  device: string
  dir: string
  linked: (card: string) => Promise<unknown>
  // the bridge's own listeners, put on each new socket
  listen: (sock: S) => void
  now: () => number
  owner: string
  random?: () => number
  sleep: (ms: number) => Promise<void>
  // told true as a connection opens, the device linked, and false as it closes
  up: (open: boolean) => void
}

export const RELINK = "playground wa relink"

// The pairing card's steps, for the spare phone's WhatsApp Business: the code, never a QR, and a profile kept unverified, since a verified business account has been banned at the link.
export const PAIRING =
  "On the spare phone, open WhatsApp Business. On Android tap ⋮ then Linked devices; on iPhone tap Settings then Linked devices. Tap Link a device, then Link with phone number instead, and type this code.\n\nKeep the Business profile unverified, with no Meta Verified: a verified business account has been banned when it linked a device."

// Pairing waits for no-raw-wa's registration in the factory's settings, so no auth state exists while a session could still reach it.
export async function unguarded(settings: string): Promise<string | undefined> {
  const text = await Bun.file(settings)
    .text()
    .catch(() => "")
  if (/no-raw-wa\.(?:js|ts)/.test(text)) return undefined
  return "no-raw-wa is not registered in scripts/factory-settings.json, and WhatsApp's phase 2 registers it, so ops-wa pairs no device until then"
}

// ops-wa's connection, kept by the ban-safety habits: at most 20 connects an hour, a backoff from 2 s to 30 s between tries, a stop after 12 failed tries in a row, and a stop on a logout that stays until the owner links again; it answers why it stopped.
export async function life<S extends LinkSock>(io: LifeIo<S>): Promise<string> {
  const digits = (n: string) => n.replace(/\D/g, "")
  if (digits(io.device) === digits(io.owner))
    return "wa.device is the owner's own number, and a self-chat number is banned fast: set wa.device to the spare number"
  await ownFolder(io.dir)
  const marker = join(io.dir, "logged-out")
  if (await Bun.file(marker).exists())
    return `WhatsApp logged out the device earlier, so ops-wa links again only after ${RELINK}`
  let failed = 0
  let capTold = false
  let card: Promise<string | undefined> | undefined
  while (true) {
    if (!(await mayConnect(io.dir, io.now()))) {
      const wait = (await connectFreesAt(io.dir, io.now())) - io.now()
      if (!capTold)
        await io.alert(
          `ops-wa reached its 20 connects in an hour, so it waits ${Math.ceil(wait / 60_000)} minutes before the next`,
        )
      capTold = true
      await io.sleep(wait)
      continue
    }
    capTold = false
    const sock = await io.connect()
    const { code, opened } = await new Promise<{ code?: number; opened: boolean }>((resolve) => {
      let opened = false
      let asked = false
      const pending: Promise<unknown>[] = []
      sock.ev.on("connection.update", (update) => {
        if (update.qr && !sock.authState.creds.registered && !asked) {
          asked = true
          card = sock.requestPairingCode(digits(io.device)).then(io.card)
          pending.push(card.catch((e: Error) => console.error(`ops-wa: pairing: ${e.message}`)))
        }
        if (update.connection === "open") {
          opened = true
          io.up(true)
          pending.push(
            (async () => {
              const path = join(io.dir, "link.json")
              const link = await readOwn<Link>(path, {})
              if (link.linkedAt === undefined) await writeOwn(path, { linkedAt: io.now() })
              const id = await card?.catch(() => undefined)
              card = undefined
              if (id) await io.linked(id)
            })(),
          )
        }
        if (update.connection === "close") {
          io.up(false)
          void Promise.allSettled(pending).then(() =>
            resolve({ code: update.lastDisconnect?.error?.output?.statusCode, opened }),
          )
        }
      })
      io.listen(sock)
    })
    if (code === LOGGED_OUT) {
      await writeOwn(marker, { at: new Date(io.now()).toISOString() })
      await io.alert(
        `WhatsApp logged out ops-wa's linked device, so ops-wa has stopped and links again only after ${RELINK}`,
      )
      return "WhatsApp logged out the device"
    }
    failed = opened ? 0 : failed + 1
    if (failed >= BACKOFF.tries) {
      await io.alert(
        `ops-wa could not connect to WhatsApp in ${BACKOFF.tries} tries in a row, so it has stopped until its job starts again`,
      )
      return `no connect in ${BACKOFF.tries} tries`
    }
    await io.sleep(backoffMs(Math.max(1, failed), io.random))
  }
}
