// Run by yard.test.ts as `bun -e` in api/hono, so the hosted build's env loads fresh: serves the hosted app, holds a fake Mac on the relay's socket and prints one JSON line of what each request answered.
const { default: shape } = await import(process.env.YARD_HOSTED!)
const { sessionCookie } = await import("@/lib/sign-in")
const { RELAY_REPLACED_CLOSE } = await import("@/lib/relay/protocol")
const server = Bun.serve(shape)
const relay = `http://127.0.0.1:${server.port}/api/v1/yard/relay`
const web = process.env.HONO_WEB_URL!
const signedIn = async (userId: string) => {
  const { name, value } = await sessionCookie(userId)
  return { cookie: `${name}=${value}` }
}
const owner = await signedIn(process.env.OWNER_ID!)
const member = await signedIn(process.env.MEMBER_ID!)
const status = async (path: string, headers: Record<string, string>) =>
  (await fetch(`${relay}${path}`, { headers })).status
// a refused socket opens and closes at once with 4000 + the refusal's status (refusedUpgradeCloses in lib/server.ts)
const closeCode = (path: string, headers: Record<string, string>) =>
  new Promise<number>((done) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/yard/relay${path}`, {
      headers,
    } as never)
    socket.addEventListener("close", (event) => done(event.code))
  })
const body = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64")

const out: Record<string, unknown> = {}
// a browser mints a relay-on token, the owner's and a member's alike
const mint = async (headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${server.port}/api/v1/yard/tokens`, {
    body: JSON.stringify({ name: "mac-relay", relay: true }),
    headers: { ...headers, "content-type": "application/json", origin: web },
    method: "POST",
  })
out.mintMember = (await mint(member)).status
const minted = await mint(owner)
const relayToken: string = (await minted.json()).data?.token?.secret ?? ""
out.mint = [minted.status, /^yard_relay_[A-Za-z0-9_-]{32}$/.test(relayToken)]
const asRelay = { authorization: `Bearer ${relayToken}` }
// a relay-on token reads and posts as its person does; a read-only one reads alone, and neither a read-only token nor a member's relay-on one holds the relay
const yard = async (path: string, headers: Record<string, string>, body?: unknown) => {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/v1/yard${path}`,
    body === undefined
      ? { headers }
      : {
          body: JSON.stringify(body),
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
        },
  )
  return [response.status, (await response.json().catch(() => null))?.error?.message ?? null]
}
const readOnly = { authorization: `Bearer ${process.env.READ_ONLY_TOKEN}` }
out.relayMe = (await yard("/me", asRelay))[0]
out.relayRead = (await yard("/channels", asRelay))[0]
out.relayWrite = (await yard("/channels", asRelay, { name: "from-the-mac" }))[0]
out.readOnlyMe = (await yard("/me", readOnly))[0]
out.readOnlyRead = (await yard("/channels", readOnly))[0]
out.readOnlyWrite = await yard("/channels", readOnly, { name: "from-a-reader" })
out.readOnlySocket = await closeCode("/socket", readOnly)
out.memberSocket = await closeCode("/socket", {
  authorization: `Bearer ${process.env.MEMBER_TOKEN}`,
})
out.cookieSocket = await closeCode("/socket", { ...owner, origin: web })
out.offline = await status("/api/v1/workers", { ...owner, origin: web })

const requests: Record<string, unknown>[] = []
const pairs: Record<string, unknown>[] = []
const writes: Record<string, unknown>[] = []
const mac = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/yard/relay/socket`, {
  headers: asRelay,
} as never)
mac.onmessage = (event) => {
  const request = JSON.parse(String(event.data))
  // a pair request waits on the Mac for the owner's Approve, which answers it with the key's fingerprint
  // a signed write runs on the Mac, which answers with the route's own status
  if (request.type === "write") {
    writes.push(request)
    return mac.send(
      JSON.stringify({
        body: body({ data: { sent: true } }),
        headers: { "content-type": "application/json" },
        id: request.id,
        status: 201,
        type: "response",
      }),
    )
  }
  if (request.type === "pair") {
    pairs.push(request)
    return mac.send(
      JSON.stringify({
        body: body({ data: { fingerprint: "a0a2 32c2 f194 a535" } }),
        headers: { "content-type": "application/json" },
        id: request.id,
        status: 202,
        type: "response",
      }),
    )
  }
  requests.push(request)
  // an answer for an id the hub is not waiting on is dropped, and the right one still lands
  const stale = "00000000-0000-4000-8000-000000000000"
  for (const [id, data] of [
    [stale, "stale"],
    [request.id, ["w1"]],
  ])
    mac.send(
      JSON.stringify({
        body: body({ data }),
        headers: { "content-disposition": "inline", "content-type": "application/json" },
        id,
        status: 200,
        type: "response",
      }),
    )
}
out.macSocket = await new Promise((done) => {
  mac.onopen = () => done("open")
  mac.onerror = () => done("error")
})
out.status = (
  await (await fetch(`${relay}/status`, { headers: { ...owner, origin: web } })).json()
).data
const read = await fetch(`${relay}/api/v1/workers?x=1`, { headers: { ...owner, origin: web } })
out.read = [
  read.status,
  await read.json(),
  ...[
    "cache-control",
    "content-disposition",
    "content-security-policy",
    "x-content-type-options",
  ].map((name) => read.headers.get(name)),
]
out.requests = requests.map(({ login, method, path }) => ({ login, method, path }))
out.member = await status("/api/v1/workers", { ...member, origin: web })
out.wrongOrigin = await status("/api/v1/workers", { ...owner, origin: "https://elsewhere.example" })
out.onboard = await status("/api/v1/onboard/sign-in", { ...owner, origin: web })
// a made-up public key, the shape the browser's P-256 key exports to
const key = {
  crv: "P-256",
  kty: "EC",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
}
const pair = async (headers: Record<string, string>, sent: unknown = { key }) => {
  const answer = await fetch(`${relay}/pair`, {
    body: JSON.stringify(sent),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST",
  })
  return [answer.status, (await answer.json()).data ?? null]
}
out.pair = await pair({ ...owner, origin: web })
out.pairs = pairs.map(({ key, login, type }) => ({ key, login, type }))
out.pairMember = (await pair({ ...member, origin: web }))[0]
out.pairNoOrigin = (await pair(owner))[0]
out.pairNotAKey = (await pair({ ...owner, origin: web }, { key: { ...key, crv: "P-384" } }))[0]
out.write = (
  await fetch(`${relay}/api/v1/workers`, { headers: { ...owner, origin: web }, method: "POST" })
).status
// a write frame as the owner's browser signs it, whose body holds a word the hosted side never keeps
const frame = (over: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
  body: JSON.stringify({ text: "body-kept-nowhere" }),
  id: crypto.randomUUID(),
  keyId: "oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U",
  login: "ow",
  method: "POST",
  path: "/api/v1/messages",
  sig: "c2lnbmVk",
  type: "write",
  ...over,
})
const write = async (headers: Record<string, string>, sent: unknown) => {
  const answer = await fetch(`${relay}/write`, {
    body: JSON.stringify(sent),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST",
  })
  return [answer.status, (await answer.json()).data ?? null]
}
out.signedWrite = await write({ ...owner, origin: web }, frame())
out.writes = writes.map(({ login, path, type }) => ({ login, path, type }))
out.writeMember = (await write({ ...member, origin: web }, frame({ login: "bo" })))[0]
out.writeNoOrigin = (await write(owner, frame()))[0]
out.writeWrongOrigin = (await write({ ...owner, origin: "https://elsewhere.example" }, frame()))[0]
out.writeOtherLogin = (await write({ ...owner, origin: web }, frame({ login: "bo" })))[0]
out.writeOffList = (
  await write({ ...owner, origin: web }, frame({ path: "/api/v1/remote/revoke" }))
)[0]
out.writeNotAFrame = (await write({ ...owner, origin: web }, frame({ method: "DELETE" })))[0]
await new Promise((done) => {
  mac.onclose = done
  mac.close()
})
await Bun.sleep(100)
out.afterClose = await status("/api/v1/workers", { ...owner, origin: web })
const after = (
  await (await fetch(`${relay}/status`, { headers: { ...owner, origin: web } })).json()
).data
out.statusAfter = { online: after.online, since: typeof after.since }
// a socket the Mac closes as replaced goes from this instance alone, so no instance learns a since, as the bus-free gone above did
const next = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/yard/relay/socket`, {
  headers: asRelay,
} as never)
await new Promise((done) => (next.onopen = done))
await new Promise((done) => {
  next.onclose = done
  next.close(RELAY_REPLACED_CLOSE, "replaced")
})
await Bun.sleep(100)
out.statusReplaced = (
  await (await fetch(`${relay}/status`, { headers: { ...owner, origin: web } })).json()
).data
console.log(JSON.stringify(out))
process.exit(0)

export {}
