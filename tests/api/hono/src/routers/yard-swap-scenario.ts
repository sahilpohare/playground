// Run by yard.test.ts as `bun -e` in api/hono, so the hosted build's env loads fresh: a made-up relay-on token and a read-only one each swap themselves for a new one of their own kind, and a bot's token, a signed-in browser and a swap to the other kind are refused; prints one JSON line of what each request answered.
const { default: shape } = await import(process.env.YARD_HOSTED!)
const { sessionCookie } = await import("@/lib/sign-in")
const server = Bun.serve(shape)
const api = `http://127.0.0.1:${server.port}/api/v1/yard`
const as = (secret: string) => ({
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
})
const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
  const response = await fetch(`${api}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method: body === undefined ? "GET" : "POST",
  })
  return { body: (await response.json().catch(() => null)) as any, status: response.status }
}
const status = async (...args: Parameters<typeof call>) => (await call(...args)).status
const made = (prefix: string, fill: string) => `${prefix}${fill.repeat(32).slice(0, 32)}`

const relay = process.env.RELAY_TOKEN!
const readOnly = process.env.READ_ONLY_TOKEN!
const cookie = await sessionCookie(process.env.OWNER_ID!)
const browser = {
  "content-type": "application/json",
  cookie: `${cookie.name}=${cookie.value}`,
  origin: process.env.HONO_WEB_URL!,
}

const out: Record<string, unknown> = {}
out.toOtherKind = await status("/tokens/swap", as(relay), { secret: made("yard_", "k") })
out.badShape = await status("/tokens/swap", as(relay), { secret: "yard_relay_short" })
out.browser = await status("/tokens/swap", browser, { secret: made("yard_relay_", "b") })
out.bot = await status("/tokens/swap", as(process.env.BOT_TOKEN!), {
  secret: made("yard_", "g"),
})
// a read-only token asking for a relay-on secret is refused, and each refused token still works
out.readOnlyToRelay = await status("/tokens/swap", as(readOnly), {
  secret: made("yard_relay_", "u"),
})
out.afterRefusals = [await status("/me", as(relay)), await status("/me", as(readOnly))]

const nextRelay = made("yard_relay_", "n")
const swapped = await call("/tokens/swap", as(relay), { secret: nextRelay })
out.relaySwap = [swapped.status, swapped.body?.data?.token?.name]
// the answer names the token, never a secret
out.answerKeys = Object.keys(swapped.body?.data?.token ?? {}).sort()
out.answerHoldsSecret = JSON.stringify(swapped.body).includes("yard_")
out.oldRelay = await status("/me", as(relay))
out.newRelay = await status("/me", as(nextRelay))
// the new one keeps its kind: it still posts
out.newRelayWrites = await status("/channels", as(nextRelay), { name: "after-swap" })
out.oldAgain = await status("/tokens/swap", as(relay), { secret: made("yard_relay_", "m") })

const nextReadOnly = made("yard_", "r")
out.readOnlySwap = (await call("/tokens/swap", as(readOnly), { secret: nextReadOnly })).status
out.oldReadOnly = await status("/me", as(readOnly))
out.newReadOnly = await status("/me", as(nextReadOnly))
// and it still reads alone
out.newReadOnlyWrites = await status("/channels", as(nextReadOnly), { name: "read-only" })
out.tokens = (await call("/tokens", browser)).body?.data?.tokens?.map(
  (one: { name: string; revokedAt: string | null }) => [one.name, one.revokedAt],
)

console.log(JSON.stringify(out))
process.exit(0)

export {}
