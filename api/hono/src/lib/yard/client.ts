import { channelSchema, MESSAGE_KINDS, messageSchema } from "@packages/message"
import { z } from "zod"

// The local Playground's client of the hosted Yard API, with the Mac's token: the local routes (routers/yard-local.ts), the mention poll and `playground yard` all call it, so it imports nothing through `@/`.

export type YardFetch = (url: string, init: RequestInit) => Promise<Response>

export class YardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const postSchema = z.strictObject({
  kind: z.enum(MESSAGE_KINDS).default("text"),
  links: messageSchema.shape.links,
  parent: z.string().min(1).optional(),
  text: messageSchema.shape.text,
})

export const pageSchema = z.strictObject({
  after: z.string().min(1).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  parent: z.string().min(1).optional(),
})

// One thing that waits on the owner: a mention, or a post of theirs Yard holds, with when it showed, which with its message's id is the next poll's mark.
const waitingSchema = z.object({
  held: z.boolean(),
  message: messageSchema,
  shownAt: z.iso.datetime(),
})

const meSchema = z.object({ login: z.string(), owner: z.boolean() })

const botSchema = z.object({
  createdAt: z.iso.datetime(),
  dm: z.string(),
  login: z.string(),
  name: z.string(),
  readsLog: z.boolean(),
})

export const yardClient = (base: string, token: string, request: YardFetch = fetch) => {
  const call = async <T extends z.ZodType>(
    path: string,
    schema: T,
    init: { body?: unknown; method?: string } = {},
  ): Promise<z.infer<T>> => {
    const response = await request(new URL(`/api/v1/yard${path}`, base).href, {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: init.method ?? "GET",
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json().catch(() => null)) as {
      data?: unknown
      error?: { message?: unknown }
    } | null
    if (!response.ok) {
      const said = typeof body?.error?.message === "string" ? body.error.message : ""
      throw new YardError(response.status, said || `Yard answered ${response.status}`)
    }
    const parsed = schema.safeParse(body?.data)
    if (!parsed.success)
      throw new YardError(502, "Yard answered in a shape this Playground does not read")
    return parsed.data
  }
  return {
    addBot: (name: string) =>
      call("/bots", z.object({ bot: botSchema, secret: z.string() }), {
        body: { name },
        method: "POST",
      }),
    channels: async () =>
      (await call("/channels", z.object({ channels: z.array(channelSchema) }))).channels,
    me: () => call("/me", meSchema),
    messages: (channel: string, page: z.infer<typeof pageSchema> = {}) => {
      const query = new URLSearchParams(
        Object.entries(page).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, String(value)]],
        ),
      )
      return call(
        `/channels/${encodeURIComponent(channel)}/messages${query.size ? `?${query}` : ""}`,
        z.object({ hasMore: z.boolean(), messages: z.array(messageSchema) }),
      )
    },
    post: async (channel: string, post: z.input<typeof postSchema>) =>
      (
        await call(
          `/channels/${encodeURIComponent(channel)}/messages`,
          z.object({ message: messageSchema }),
          {
            body: postSchema.parse(post),
            method: "POST",
          },
        )
      ).message,
    read: (channel: string) =>
      call(
        `/channels/${encodeURIComponent(channel)}/read`,
        z.object({ lastReadAt: z.iso.datetime() }),
        {
          body: {},
          method: "POST",
        },
      ),
    revokeBot: async (name: string) =>
      (
        await call(`/bots/${encodeURIComponent(name)}`, z.object({ bot: botSchema }), {
          method: "DELETE",
        })
      ).bot,
    // this token's swap of itself for secret, a new one of its own kind the Mac made (rotate.ts)
    swapToken: (secret: string) =>
      call("/tokens/swap", z.object({ token: z.object({ id: z.string(), name: z.string() }) }), {
        body: { secret },
        method: "POST",
      }),
    waiting: async ({ after, since }: { after?: string; since: string }) =>
      (
        await call(
          `/waiting?${new URLSearchParams(after ? { after, since } : { since })}`,
          z.object({ items: z.array(waitingSchema) }),
        )
      ).items,
  }
}

export type YardClient = ReturnType<typeof yardClient>
