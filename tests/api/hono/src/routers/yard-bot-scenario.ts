// Run by yard.test.ts as `bun -e` in api/hono, so the hosted build's env loads fresh: the owner makes a made-up bot, the bot reads and posts in its DM alone, and a revoke cuts it; prints one JSON line of what each request answered.
const { default: shape } = await import(process.env.YARD_HOSTED!)
const server = Bun.serve(shape)
const api = `http://127.0.0.1:${server.port}/api/v1/yard`
const as = (secret: string) => ({
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
})
const owner = as(process.env.OWNER_TOKEN!)
const member = as(process.env.MEMBER_TOKEN!)
const call = async (
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method?: string,
) => {
  const response = await fetch(`${api}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method: method ?? (body === undefined ? "GET" : "POST"),
  })
  return { body: (await response.json().catch(() => null)) as any, status: response.status }
}
const status = async (...args: Parameters<typeof call>) => (await call(...args)).status

const out: Record<string, unknown> = {}
out.memberAdd = await status("/bots", member, { name: "grok" })
out.badName = await status("/bots", owner, { name: "Grok!" })
const added = await call("/bots", owner, { name: "grok" })
out.add = [added.status, added.body?.data?.bot, typeof added.body?.data?.secret]
const bot = as(added.body?.data?.secret ?? "yard_none")
const dm: string = added.body?.data?.bot?.dm ?? "none"
out.addAgain = await status("/bots", owner, { name: "grok" })
out.list = (await call("/bots", owner)).body?.data?.bots
out.memberList = await status("/bots", member)

// the bot's own DM: its first post sends at once, since a bot has no browser to approve it
const first = await call(`/channels/${dm}/messages`, bot, { kind: "text", text: "hello owner" })
out.botPost = [first.status, first.body?.data?.message?.status, first.body?.data?.message?.from]
await Bun.sleep(1100)
await call(`/channels/${dm}/messages`, owner, { kind: "text", text: "hello bot" })
const since = await call(
  `/channels/${dm}/messages?after=${first.body?.data?.message?.id ?? "none"}`,
  bot,
)
out.botReadAfter = [since.status, since.body?.data?.messages?.map((m: any) => m.text)]
out.botRead = (await call(`/channels/${dm}/messages`, bot)).body?.data?.messages?.map(
  (m: any) => m.text,
)

// the bot routes find the same DM from the token alone, with no DM id (#1995)
const viaRoute = await call("/bot/messages", bot, { kind: "text", text: "via the bot route" })
out.botRoutePost = [
  viaRoute.status,
  viaRoute.body?.data?.message?.status,
  viaRoute.body?.data?.message?.channel === dm,
]
const routeSince = await call(
  `/bot/messages?after=${first.body?.data?.message?.id ?? "none"}&limit=5`,
  bot,
)
out.botRouteReadAfter = [
  routeSince.status,
  routeSince.body?.data?.messages?.map((m: any) => m.text),
]
out.botRouteRead = (await call("/bot/messages", bot)).body?.data?.messages?.map((m: any) => m.text)

// everything else a bot's token tries reads 403
const general = (await call("/channels", owner)).body?.data?.channels?.find(
  (c: any) => c.name === "general",
)?.id
out.refused = {
  botRouteHeldKind: await status("/bot/messages", bot, { kind: "steps", text: "run it" }),
  botRouteMention: await status("/bot/messages", bot, {
    kind: "text",
    text: `@${process.env.MEMBER_LOGIN} look`,
  }),
  bots: await status("/bots", bot),
  channels: await status("/channels", bot),
  dms: await status("/dms", bot, { login: process.env.MEMBER_LOGIN }),
  heldKind: await status(`/channels/${dm}/messages`, bot, { kind: "steps", text: "run it" }),
  link: await status(`/channels/${dm}/messages`, bot, {
    kind: "text",
    links: ["https://example.com/a"],
    text: "see this",
  }),
  me: await status("/me", bot),
  mention: await status(`/channels/${dm}/messages`, bot, {
    kind: "text",
    text: `@${process.env.MEMBER_LOGIN} look`,
  }),
  newChannel: await status("/channels", bot, { name: "botland" }),
  otherPost: await status(`/channels/${general}/messages`, bot, { kind: "text", text: "hi all" }),
  otherRead: await status(`/channels/${general}/messages`, bot),
  read: await status(`/channels/${dm}/read`, bot, {}),
  relayStatus: await status("/relay/status", bot),
  relayWrite: await status("/relay/write", bot, {}),
  tokens: await status("/tokens", bot),
  waiting: await status("/waiting?since=2026-01-01T00:00:00.000Z", bot),
}
// a bot's token holds no relay
out.botSocket = await new Promise<number>((done) => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/yard/relay/socket`, {
    headers: { authorization: bot.authorization },
  } as never)
  socket.addEventListener("close", (event) => done(event.code))
})
// a bot's login is no GitHub login, so a new DM cannot name it
out.dmToBot = await status("/dms", member, { login: "grok[bot]" })
// a bot's login with no yard_bot row, its maker gone, is no one
out.ghost = await status(`/channels/${dm}/messages`, as(process.env.GHOST_TOKEN!))

// a person's token has no bot DM to find
out.personOnBotRoute = [
  await status("/bot/messages", member),
  await status("/bot/messages", owner, { kind: "text", text: "hi" }),
]

// a person's token works as before
out.controls = [await status("/channels", member), await status("/me", owner)]

out.memberRevoke = await status("/bots/grok", member, undefined, "DELETE")
out.revoke = await status("/bots/grok", owner, undefined, "DELETE")
out.afterRevoke = await status(`/channels/${dm}/messages`, bot)
out.afterRevokeRoute = await status("/bot/messages", bot)
out.listAfter = (await call("/bots", owner)).body?.data?.bots
out.revokeAgain = await status("/bots/grok", owner, undefined, "DELETE")
console.log(JSON.stringify(out))
process.exit(0)

export {}
