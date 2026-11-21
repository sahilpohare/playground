import { describe, expect, test } from "bun:test"

import { hideSecrets, secretIn } from "../../../../packages/settings/src"

const body = (n: number) =>
  "madeUpTestOnly0123456789AbCdEfGhIjKlMnOpQrStUvWxYz".repeat(4).slice(0, n)

// Made-up tokens, one per shape, each built from parts so no scanner reads one as real; none is a real token or key.
const MADE_UP: [string, string][] = [
  ["a Bearer token", ["Bear", "er ", body(40)].join("")],
  ["a Google API key", ["AI", "za", body(35)].join("")],
  ["a JWT", ["ey", "J", body(20), ".ey", "J", body(30), ".", body(43)].join("")],
  ["a Slack token", ["xa", "pp-", "1-A0000000000-0000000000000-", body(20)].join("")],
  ["a Slack token", ["xo", "xe-", "1-", body(40)].join("")],
  ["a Stripe key", ["sk", "_live_", body(24)].join("")],
  ["a Stripe key", ["rk", "_live_", body(24)].join("")],
  ["a Vercel token", ["vc", "p_", body(24)].join("")],
  ["a Vercel token", ["vc", "i_", body(56)].join("")],
  ["a Yard token", ["ya", "rd_", body(32)].join("")],
  ["a Yard token", ["ya", "rd_relay_", body(32)].join("")],
  ["an npm token", ["np", "m_", body(36)].join("")],
]

// Ordinary text near each shape, which neither names nor hides.
const ORDINARY = [
  "Authorization: Bearer ${token}",
  "a bearer of good news",
  "AIza is how a Google key starts",
  "eyJhbGciOiJIUzI1NiJ9 alone is a header, not a token",
  "sk_test_ keys stay in tests",
  "vcp_ is Vercel's prefix",
  "yard_message and yard_channel are tables",
  "npm_config_registry is an env name",
]

describe("the secret shapes", () => {
  test.each(MADE_UP)("%s is named and hidden", (kind, token) => {
    expect(secretIn({ note: `ran with ${token} here` })).toBe(kind)
    const said = hideSecrets(`ran with ${token} here`)
    expect(said).toStartWith("ran with [hidden]")
    expect(said).not.toContain(token.slice(-12))
  })

  test.each(ORDINARY)("%s is ordinary text", (text) => {
    expect(secretIn(text)).toBeUndefined()
    expect(hideSecrets(text)).toBe(text)
  })
})
