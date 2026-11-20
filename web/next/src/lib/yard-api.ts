"use client"

import { env } from "@packages/env/web-next"
import type { MESSAGE_KINDS } from "@packages/message"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { unwrap } from "@/lib/api/client"
import { config } from "@/lib/config"
import { queryRetry } from "@/lib/query"
import { holdsForFirstTry } from "@/lib/threads"
import {
  catchUp,
  messagesKey,
  messagesQuery,
  retryDelay,
  socketUrl,
  upsertMessage,
  YARD_KEY,
  YARD_ROUTE,
  type YardChannel,
  type YardMessage,
} from "@/lib/yard"

export const BOTS_KEY = [...YARD_KEY, "bots"] as const
export const CHANNELS_KEY = [...YARD_KEY, "channels"] as const
export const INVITES_KEY = [...YARD_KEY, "invites"] as const
export const TOKENS_KEY = [...YARD_KEY, "tokens"] as const

// Every read and write goes to the API's Yard router with the session's cookie: the hosted API's own, or locally the routes that hold the Mac's Yard token.
async function yard<T>(path: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const { data, error } = await unwrap(
    fetch(`${config.api.url}${YARD_ROUTE}${path}`, {
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "include",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      method: init?.method ?? "GET",
    }) as Promise<{ ok: boolean; json: () => Promise<{ data: T }> }>,
  )
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return data as T
}

// A bot the owner made with `playground yard bot add`: its login, <name>[bot], the id of its DM with the owner, and whether it may read the dispatcher's log.
export type YardBot = {
  createdAt: string
  dm: string
  login: string
  name: string
  readsLog: boolean
}

// An invite as the API sends it: an invite request names who asked and for whom, and its code comes back once, when the owner opens it.
export type YardInvite = {
  code?: string
  createdAt: string
  expiresAt: string | null
  forLogin: string | null
  id: string
  requestedBy: { login: string } | null
  status: "open" | "redeemed" | "requested" | "revoked"
}

export type YardToken = {
  createdAt: string
  id: string
  lastUsedAt: string | null
  name: string
  revokedAt: string | null
}

// An id goes into a path escaped, since a page's id comes from its URL and a message's text is untrusted.
const segment = encodeURIComponent

export const yardApi = {
  approve: (id: string) =>
    yard<{ message: YardMessage }>(`/messages/${segment(id)}/approve`, { method: "POST" }),
  approveInvite: (id: string) =>
    yard<{ invite: YardInvite }>(`/invites/${segment(id)}/approve`, { method: "POST" }),
  bots: () => yard<{ bots: YardBot[] }>("/bots"),
  channels: () => yard<{ channels: YardChannel[] }>("/channels"),
  createToken: (name: string, relay = false) =>
    yard<{ token: YardToken & { secret: string } }>("/tokens", {
      body: { name, relay },
      method: "POST",
    }),
  deny: (id: string) =>
    yard<{ message: YardMessage }>(`/messages/${segment(id)}/deny`, { method: "POST" }),
  denyInvite: (id: string) =>
    yard<{ invite: YardInvite }>(`/invites/${segment(id)}/deny`, { method: "POST" }),
  invites: () => yard<{ invites: YardInvite[] }>("/invites"),
  me: () => yard<{ login: string; owner: boolean }>("/me"),
  message: (id: string) => yard<{ message: YardMessage }>(`/messages/${segment(id)}`),
  messages: (channel: string) =>
    yard<{ hasMore: boolean; messages: YardMessage[] }>(`/channels/${segment(channel)}/messages`),
  post: (channel: string, body: { kind: (typeof MESSAGE_KINDS)[number]; text: string }) =>
    yard<{ message: YardMessage }>(`/channels/${segment(channel)}/messages`, {
      body,
      method: "POST",
    }),
  read: (channel: string) =>
    yard<{ lastReadAt: string }>(`/channels/${segment(channel)}/read`, {
      body: {},
      method: "POST",
    }),
  redeem: (code: string) =>
    yard<{ member: true }>("/invites/redeem", { body: { code }, method: "POST" }),
  requestInvite: (forLogin: string) =>
    yard<{ invite: unknown }>("/invites/request", { body: { forLogin }, method: "POST" }),
  revokeBot: (name: string) =>
    yard<{ bot: YardBot }>(`/bots/${segment(name)}`, { method: "DELETE" }),
  revokeToken: (id: string) =>
    yard<{ token: YardToken }>(`/tokens/${segment(id)}`, { method: "DELETE" }),
  setReadsLog: (name: string, readsLog: boolean) =>
    yard<{ bot: YardBot }>(`/bots/${segment(name)}`, { body: { readsLog }, method: "PATCH" }),
  tokens: () => yard<{ tokens: YardToken[] }>("/tokens"),
}

// Pure: how often the sidebar reads its channels again. Locally no socket runs, so its counts read every 30s, through a passing error too; the hosted socket pushes them, and a refusal (Yard off or signed out, a 404) stops the reads.
export const channelsEvery = (hosted: boolean, error: unknown): number | false =>
  hosted || (error as { code?: string } | null)?.code === "NOT_FOUND" ? false : 30_000

// The sidebar's channels and DMs; a stack with no Yard (the local routes absent) reads an error, and the groups stay away.
export const useYardChannels = (enabled = true) =>
  useQuery({
    enabled,
    queryFn: async () => (await yardApi.channels()).channels ?? [],
    queryKey: CHANNELS_KEY,
    refetchInterval: (query) => channelsEvery(config.hosted, query.state.error),
    retry: (count, error) =>
      (error as { code?: string }).code !== "NOT_FOUND" && queryRetry(count, error),
  })

// How long the sidebar's nav waits on Yard's first read before it draws without Yard's groups, which then arrive at their place in the group order: a hosted Yard read can run to its 15s timeout.
export const YARD_HOLD_MS = 1_000

// Pure: whether the nav waits on Yard's channels read: its first try alone (holdsForFirstTry), and never once YARD_HOLD_MS has passed (late).
export const holdsForYard = (
  read: Parameters<typeof holdsForFirstTry>[0],
  late: boolean,
): boolean => !late && holdsForFirstTry(read)

// Whether YARD_HOLD_MS has passed since Yard's read was let start (started, the owner rung read), so a session that answers late still gives the read its full second.
export function useYardLate(started: boolean): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!started) return
    const timer = setTimeout(() => setLate(true), YARD_HOLD_MS)
    return () => clearTimeout(timer)
  }, [started])
  return late
}

// Who you are on Yard, read once a tab, so a channel shows your own posts on the right as the chat shows yours.
export const useYardMe = () =>
  useQuery({ queryFn: yardApi.me, queryKey: [...YARD_KEY, "me"], staleTime: Infinity })

export const useYardMessages = (channel: string) =>
  useQuery(messagesQuery(channel, async () => (await yardApi.messages(channel)).messages ?? []))

// One socket per signed-in tab: each frame lands in the query cache, and a closed socket (Vercel closes one at 800s) opens again with a fresh one-time token, backing off while it keeps failing, then reads again what it may have missed (catchUp). A token read refused as signed out (401 or 403) stops it, and any other failure backs off.
export function useYardSocket() {
  const client = useQueryClient()
  useEffect(() => {
    let socket: WebSocket | null = null
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let opened = false
    let tries = 0
    const again = () => {
      if (stopped) return
      retry = setTimeout(open, retryDelay(tries))
      tries += 1
    }
    const open = async () => {
      try {
        // the token read goes through config.api.url, which carries the session cookie; the socket goes to the API's own host
        const response = await fetch(`${config.api.url}/api/auth/one-time-token/generate`, {
          credentials: "include",
        })
        if (response.status === 401 || response.status === 403) return
        if (!response.ok) return again()
        const { token } = (await response.json()) as { token: string }
        if (stopped) return
        socket = new WebSocket(socketUrl(env, token))
        socket.onopen = () => {
          tries = 0
          if (opened) void catchUp(client)
          opened = true
        }
        socket.onmessage = (event) => {
          const frame = JSON.parse(String(event.data)) as { message?: YardMessage; type: string }
          // a reply lives in its parent's thread, which the channel's list leaves out
          if (frame.type === "message" && frame.message && !frame.message.parent) {
            const message = frame.message
            client.setQueryData<YardMessage[]>(messagesKey(message.channel), (list) =>
              list ? upsertMessage(list, message) : list,
            )
          }
          void client.invalidateQueries({ queryKey: CHANNELS_KEY })
        }
        socket.onclose = again
      } catch {
        again()
      }
    }
    void open()
    return () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [client])
}
