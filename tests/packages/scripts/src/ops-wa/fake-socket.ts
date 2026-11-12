import { EventEmitter } from "node:events"

// Made-up numbers alone: the owner's, a stranger's and the spare phone's, none a real one.
export const OWNER = "+15550100001"
export const STRANGER = "+15550100777"
export const SPARE = "+15550100002"
export const jid = (e164: string) => `${e164.slice(1)}@s.whatsapp.net`
// A group's chat id, by WhatsApp's group suffix.
export const groupJid = (id: string) => `${id}@g.us`

type Content = { linkPreview?: null; text: string }

// A Baileys socket held in memory, answering the calls ops-wa makes: its events are fired by the test, each send and pairing code request recorded, and end and logout close it as Baileys does.
export function fakeSocket(registered = true) {
  const ev = new EventEmitter()
  const sent: { at: number; content: Content; jid: string }[] = []
  const pairings: string[] = []
  const calls: string[] = []
  let clock = () => Date.now()
  const sock = {
    authState: { creds: { registered } },
    end: async () => {
      calls.push("end")
    },
    ev: {
      on: (name: string, fn: (arg: never) => void) =>
        void ev.on(name, fn as (arg: unknown) => void),
    },
    readMessages: async () => void calls.push("readMessages"),
    requestPairingCode: async (phone: string) => {
      pairings.push(phone)
      return "ABCD1234"
    },
    sendMessage: async (to: string, content: Content) => {
      sent.push({ at: clock(), content, jid: to })
      return { key: { id: `m${sent.length}` } }
    },
    sendPresenceUpdate: async () => void calls.push("sendPresenceUpdate"),
  }
  const message = (from: string, text: string, extra: Record<string, unknown> = {}) => ({
    key: { fromMe: false, id: `in${Math.random()}`, remoteJid: from, ...extra },
    message: { conversation: text },
    messageTimestamp: Math.floor(clock() / 1000),
  })
  return {
    calls,
    close: (statusCode: number) =>
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode } } },
      }),
    emit: (name: string, payload: unknown) => ev.emit(name, payload),
    message,
    open: () => ev.emit("connection.update", { connection: "open" }),
    pairings,
    qr: () => ev.emit("connection.update", { qr: "made-up-qr" }),
    sent,
    setClock: (fn: () => number) => (clock = fn),
    sock,
    upsert: (messages: unknown[], type = "notify") =>
      ev.emit("messages.upsert", { messages, type }),
  }
}
