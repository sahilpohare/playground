import { env } from "@packages/env/api-hono"
import type { PairKey } from "@packages/message"
import { z } from "zod"

import {
  RELAY_REPLACED_CLOSE,
  RELAY_SILENT_MS,
  RELAY_TIMEOUT_MS,
  type RelayBotRead,
  relayBotSchema,
  relayHeartbeatSchema,
  type RelayPair,
  relayPairSchema,
  type RelayRequest,
  relayRequestSchema,
  type RelayResponse,
  relayResponseSchema,
  type RelayStatus,
  type RelayWrite,
  relayWriteSchema,
} from "@/lib/relay/protocol"
import { redisChannel } from "@/lib/yard/channel"

type MacSocket = { close?: () => void; send: (data: string) => void }

// A frame the hub carries to the Mac: a read, a bot's read, a pair request or a signed write.
type Frame = RelayBotRead | RelayPair | RelayRequest | RelayWrite

// A socket the hub holds, and when it last heard from it.
type Held = { heard: number; socket: MacSocket }

type Waiting = {
  acked: boolean
  resolve: (answer: Forwarded) => void
  timers: ReturnType<typeof setTimeout>[]
  userId: string
}

// What a forward gives the route: this Mac's answer, or why there is none.
export type Forwarded = RelayResponse | { type: "offline" } | { type: "timeout" }

// How long an instance waits, from when its message reaches the bus, for the one holding the Mac's socket to say it took a request or a ping, before it reads the Mac as offline.
export const RELAY_ACK_MS = 2000

// The request ids the subscriber remembers, oldest dropped first, so a request on the bus twice (a publish whose first try landed and then reported closed) still reaches the Mac once.
const SEEN_MAX = 500

// What the instances tell each other over Redis, in transit alone: a request, a bot's read, a pair request or a signed write for the instance holding the Mac's socket, its ack, the Mac's answer, a status ping and its pong, and a socket gone.
const busSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("ack") }),
  z.object({ kind: z.literal("gone"), since: z.string(), userId: z.string() }),
  z.object({ id: z.string(), kind: z.literal("ping"), userId: z.string() }),
  z.object({ id: z.string(), kind: z.literal("pong") }),
  z.object({
    kind: z.literal("request"),
    request: z.union([relayBotSchema, relayRequestSchema, relayPairSchema, relayWriteSchema]),
    userId: z.string(),
  }),
  z.object({ kind: z.literal("response"), response: relayResponseSchema, userId: z.string() }),
])

type BusMessage = z.infer<typeof busSchema>

// How a hub reaches the other instances: listen subscribes, publish reaches every instance, this one's included.
export type Bus = { listen: () => void; publish: (data: string) => Promise<void> }

// The hosted side of the relay: the socket each owner's Mac holds on this instance, and the requests waiting on an answer, all in memory, so nothing a Mac answers is kept once its browser has it; with a bus, a request or a status read on another instance reaches the instance holding the socket. A socket silent for silentMs, a sleeping Mac's half-open one, counts as gone from the time the hub last heard it.
export function createHub({
  ackMs = RELAY_ACK_MS,
  bus,
  id = () => crypto.randomUUID(),
  now = () => new Date(),
  silentMs = RELAY_SILENT_MS,
  timeoutMs = RELAY_TIMEOUT_MS,
}: {
  ackMs?: number
  bus?: Bus
  id?: () => string
  now?: () => Date
  silentMs?: number
  timeoutMs?: number
} = {}) {
  const delivered = new Set<string>()
  const macs = new Map<string, Held>()
  const offlineSince = new Map<string, string>()
  const waiting = new Map<string, Waiting>()
  const pings = new Map<string, () => void>()

  const settle = (key: string, answer: Forwarded) => {
    const found = waiting.get(key)
    if (!found) return
    waiting.delete(key)
    for (const timer of found.timers) clearTimeout(timer)
    found.resolve(answer)
  }

  // Publishes one message, and says whether it reached the bus: a cold instance's first publish waits for its subscriber and sender to connect.
  const send = (message: BusMessage): Promise<boolean> =>
    bus
      ? bus.publish(JSON.stringify(message)).then(
          () => true,
          (error) => {
            console.error("[relay] publish failed", String(error))
            return false
          },
        )
      : Promise.resolve(false)

  const goneHere = (userId: string, since: string) => {
    offlineSince.set(userId, since)
    for (const [key, found] of waiting)
      if (found.userId === userId) settle(key, { type: "offline" })
  }

  // Whether another instance holds the owner's Mac, which answers a ping within ackMs of the ping reaching the bus, so a cold instance's connect spends none of the wait.
  const heldElsewhere = async (userId: string): Promise<boolean> => {
    if (!bus) return false
    const ping = id()
    const there = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let done = false
      const end = (answer: boolean) => {
        done = true
        clearTimeout(timer)
        resolve(answer)
      }
      pings.set(ping, () => end(true))
      void send({ id: ping, kind: "ping", userId }).then((sent) => {
        if (done) return
        if (!sent) return end(false)
        timer = setTimeout(() => end(false), ackMs)
      })
    })
    pings.delete(ping)
    return there
  }

  // Lets a held socket go, as of since, on every instance, unless the Mac has moved its socket to another instance, whose reads still get their answers.
  const drop = (userId: string, held: Held, since: string) => {
    if (macs.get(userId) !== held) return
    macs.delete(userId)
    const gone = () => {
      if (macs.has(userId)) return
      goneHere(userId, since)
      void send({ kind: "gone", since, userId })
    }
    if (!bus) return gone()
    void heldElsewhere(userId).then((there) => {
      if (!there) gone()
    })
  }

  // The socket this instance holds for the owner while it still answers; one silent past silentMs is dropped and closed here.
  const live = (userId: string): MacSocket | null => {
    const held = macs.get(userId)
    if (!held) return null
    if (now().getTime() - held.heard < silentMs) return held.socket
    drop(userId, held, new Date(held.heard).toISOString())
    try {
      held.socket.close?.()
    } catch (error) {
      console.error("[relay] closing a silent socket failed", String(error))
    }
    return null
  }

  // Hands a request to the Mac's socket on this instance, and says whether one took it.
  const deliver = (userId: string, request: Frame) => {
    const socket = live(userId)
    if (!socket) return false
    try {
      socket.send(JSON.stringify(request))
      return true
    } catch {
      return false
    }
  }

  // Takes what another instance published.
  const receive = (raw: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const message = busSchema.safeParse(parsed)
    if (!message.success) return
    const data = message.data
    if (data.kind === "ack") {
      const found = waiting.get(data.id)
      if (found) found.acked = true
    } else if (data.kind === "gone") {
      if (!macs.has(data.userId)) goneHere(data.userId, data.since)
    } else if (data.kind === "ping") {
      if (live(data.userId)) void send({ id: data.id, kind: "pong" })
    } else if (data.kind === "pong") pings.get(data.id)?.()
    else if (data.kind === "request") {
      // A repeat is dropped before the Mac sees it, so it answers once and its refusal for the copy never races the real answer; one no live socket took is left unseen, so a retry after the Mac moved still delivers.
      const key = `request:${data.request.id}`
      if (delivered.has(key)) return
      if (deliver(data.userId, data.request)) {
        delivered.add(key)
        if (delivered.size > SEEN_MAX) delivered.delete(delivered.keys().next().value!)
        void send({ id: data.request.id, kind: "ack" })
      }
    } else if (waiting.get(data.response.id)?.userId === data.userId)
      settle(data.response.id, data.response)
  }

  // Sends one frame to the owner's Mac, through the instance holding its socket, and waits for its answer.
  const carry = (userId: string, request: Frame): Promise<Forwarded> => {
    const here = live(userId) !== null
    if (!here && !bus) return Promise.resolve({ type: "offline" })
    return new Promise((resolve) => {
      const timers = [setTimeout(() => settle(request.id, { type: "timeout" }), timeoutMs)]
      const found: Waiting = { acked: here, resolve, timers, userId }
      waiting.set(request.id, found)
      if (here) {
        if (!deliver(userId, request)) settle(request.id, { type: "offline" })
        return
      }
      // the ack wait starts once the request is on the bus, so a cold instance's connect spends none of it
      void send({ kind: "request", request, userId }).then((sent) => {
        if (!waiting.has(request.id)) return
        if (!sent) return settle(request.id, { type: "offline" })
        timers.push(
          setTimeout(() => {
            if (!found.acked) settle(request.id, { type: "offline" })
          }, ackMs),
        )
      })
    })
  }

  return {
    // Holds the owner's Mac socket, a newer one replacing the old, and returns what lets it go by its close code: a socket that goes fails what waits on it on every instance, one closed as replaced goes from here alone.
    attach(userId: string, socket: MacSocket): (code?: number) => void {
      const held: Held = { heard: now().getTime(), socket }
      macs.set(userId, held)
      offlineSince.delete(userId)
      bus?.listen()
      return (code) => {
        if (code !== RELAY_REPLACED_CLOSE) return drop(userId, held, now().toISOString())
        if (macs.get(userId) === held) macs.delete(userId)
      }
    },

    // Takes a frame the owner's Mac sent on socket, which says it is there: a heartbeat is answered with one, so the Mac hears the hub too, an answer settles its own request, here or on the instance that waits on it, and anything else is dropped.
    answer(userId: string, raw: string, socket?: MacSocket): void {
      const held = macs.get(userId)
      if (held) held.heard = now().getTime()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      if (relayHeartbeatSchema.safeParse(parsed).success) {
        try {
          socket?.send(raw)
        } catch (error) {
          console.error("[relay] answering a heartbeat failed", String(error))
        }
        return
      }
      const frame = relayResponseSchema.safeParse(parsed)
      if (!frame.success) return
      const found = waiting.get(frame.data.id)
      if (found) {
        if (found.userId === userId) settle(frame.data.id, frame.data)
      } else void send({ kind: "response", response: frame.data, userId })
    },

    // Sends a bot's GET to its maker's Mac, naming the bot, with a fresh id and time, through the instance holding its socket, and waits for its answer.
    botRead(
      userId: string,
      login: string,
      { bot, dm }: { bot: string; dm: string },
      path: string,
    ): Promise<Forwarded> {
      return carry(userId, {
        at: now().toISOString(),
        bot,
        dm,
        id: id(),
        login,
        method: "GET",
        path,
        type: "bot",
      })
    },

    // Sends one GET to the owner's Mac with a fresh id and time, through the instance holding its socket, and waits for its answer.
    forward(userId: string, login: string, path: string): Promise<Forwarded> {
      return carry(userId, {
        at: now().toISOString(),
        id: id(),
        login,
        method: "GET",
        path,
        type: "request",
      })
    },

    // Sends the owner's browser's public key to the owner's Mac as a pair request, which waits there for the owner's Approve, and waits for the Mac's answer.
    pair(userId: string, login: string, key: PairKey): Promise<Forwarded> {
      return carry(userId, { at: now().toISOString(), id: id(), key, login, type: "pair" })
    },

    // Carries one write the owner's browser signed to the owner's Mac as it was signed, through the instance holding its socket, and waits for its answer: its body is kept nowhere, only in memory until the Mac has it.
    write(userId: string, write: RelayWrite): Promise<Forwarded> {
      return carry(userId, write)
    },

    // Whether this instance still needs the bus: a socket held, or a request or a ping waiting.
    busy: () => macs.size > 0 || waiting.size > 0 || pings.size > 0,

    receive,

    // Whether the owner's Mac holds the relay on any instance, and since when it is offline when an instance saw it go.
    async status(userId: string): Promise<RelayStatus> {
      if (live(userId)) return { online: true, since: null }
      if (await heldElsewhere(userId)) return { online: true, since: null }
      return { online: false, since: offlineSince.get(userId) ?? null }
    },
  }
}

export type Hub = ReturnType<typeof createHub>

// The hosted API's one hub, on Redis when KV_URL is set, so every instance reaches the one holding the Mac's socket.
export const hub: Hub = (() => {
  if (!env.KV_URL) return createHub()
  let self: Hub | null = null
  const channel = redisChannel({
    name: "relay",
    onMessage: (raw) => self?.receive(raw),
    url: env.KV_URL,
    wanted: () => self?.busy() ?? false,
  })
  self = createHub({ bus: channel })
  return self
})()
