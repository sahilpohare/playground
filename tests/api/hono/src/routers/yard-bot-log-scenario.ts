// Run by yard.test.ts as `bun -e` in api/hono, so the hosted build's env loads fresh: the owner makes two made-up bots, one let read the dispatcher's log, and a fake Mac on the relay's socket answers a bot's read with a made-up page; prints one JSON line of what each request answered.
const { default: shape } = await import(process.env.YARD_HOSTED!)
const { sessionCookie } = await import("@/lib/sign-in")
const { answerRelay } = await import("@/lib/relay/mac")
const server = Bun.serve(shape)
const api = `http://127.0.0.1:${server.port}/api/v1/yard`
const web = process.env.HONO_WEB_URL!
const as = (secret: string) => ({
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
})
const owner = as(process.env.OWNER_TOKEN!)
const cookie = await sessionCookie(process.env.OWNER_ID!)
const browser = {
  "content-type": "application/json",
  cookie: `${cookie.name}=${cookie.value}`,
  origin: web,
}
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
// a token's add asks for the log and is refused, so the grant is the owner's browser's alone, as the switch is
out.tokenLog = await status("/bots", owner, { log: true, name: "scout" })
const scout = await call("/bots", browser, { log: true, name: "scout" })
const quiet = await call("/bots", owner, { name: "quiet" })
out.add = [scout.status, scout.body?.data?.bot?.readsLog, quiet.body?.data?.bot?.readsLog]
const scoutBot = as(scout.body?.data?.secret ?? "yard_none")
const quietBot = as(quiet.body?.data?.secret ?? "yard_none")
const dm: string = scout.body?.data?.bot?.dm ?? "none"
out.offline = await status("/bot/log", scoutBot)

// the owner's Mac, which answers each frame as this Mac's own relay does, its yard.logReaders binding scout's login to the DM scout was made with, and its log route a made-up page of two entries
const frames: Record<string, unknown>[] = []
const mac = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/yard/relay/socket`, {
  headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}` },
} as never)
const page = {
  data: {
    entries: [
      { at: "2026-11-12T05:00:00.000Z", kind: "assistant", seq: 5, text: "made-up step one" },
      { at: "2026-11-12T05:00:01.000Z", kind: "assistant", seq: 6, text: "made-up step two" },
    ],
    hasMore: false,
    session: "made-up-session",
  },
}
const seen = new Map<string, number>()
mac.onmessage = async (event) => {
  const raw = String(event.data)
  frames.push(JSON.parse(raw))
  const answer = await answerRelay(raw, {
    cookie: async () => "session=made-up",
    dispatch: async () => Response.json(page),
    secretValues: () => [],
    login: "lo",
    readers: () => ({ "scout[bot]": dm }),
    seen,
  })
  if (answer) mac.send(JSON.stringify(answer))
}
await new Promise((done) => {
  mac.onopen = done
  mac.onerror = done
})

await call(`/channels/${dm}/messages`, scoutBot, { kind: "text", text: "hello owner" })
await Bun.sleep(1100)
const read = await call("/bot/log?after=4", scoutBot)
out.read = [read.status, read.body?.data?.entries?.map((entry: any) => entry.seq)]
out.frames = frames.map(({ bot, dm: frameDm, login, method, path, type }) => ({
  bot,
  bindsScoutsDm: frameDm === dm,
  login,
  method,
  path,
  type,
}))
out.refused = {
  badCursor: await status("/bot/log?after=x", scoutBot),
  browser: await status("/bot/log", browser),
  owner: await status("/bot/log", owner),
  quiet: await status("/bot/log", quietBot),
}
out.frameCount = frames.length

// the read's line in the DM, from the bot, and no Inbox card for it
out.dm = (await call(`/channels/${dm}/messages`, owner)).body?.data?.messages?.map((m: any) => [
  m.from.login,
  m.kind,
  m.text,
])
out.waiting = (await call("/waiting?since=2026-01-01T00:00:00.000Z", owner)).body?.data?.items?.map(
  (item: any) => [item.message.from.login, item.message.kind],
)

// the Account page's switch, from the owner's browser alone
out.switchToken = await status("/bots/scout", owner, { readsLog: false }, "PATCH")
const off = await call("/bots/scout", browser, { readsLog: false }, "PATCH")
out.switchOff = [off.status, off.body?.data?.bot?.readsLog]
out.afterOff = await status("/bot/log", scoutBot)
out.switchOn = (
  await call("/bots/scout", browser, { readsLog: true }, "PATCH")
).body?.data?.bot?.readsLog
out.revoke = await status("/bots/scout", owner, undefined, "DELETE")
out.afterRevoke = await status("/bot/log", scoutBot)

// a bot made again under the revoked name, with the Mac's list left as it was: Yard lets it, and the Mac refuses it, since its DM is a new one
const again = await call("/bots", browser, { log: true, name: "scout" })
out.remade = [
  again.status,
  again.body?.data?.bot?.dm !== dm,
  await status("/bot/log", as(again.body?.data?.secret ?? "yard_none")),
  frames.length,
]
mac.close()
console.log(JSON.stringify(out))
process.exit(0)

export {}
