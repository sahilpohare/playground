import { describe, expect, test } from "bun:test"

import { cookieConfig, localhostHost } from "../../../../../packages/auth/src/lib/utils"

const forUrl = (url: string) => {
  const host = localhostHost(url)
  if (!host) throw new Error(`${url} is not a .localhost host`)
  return cookieConfig(host)
}

// Every portless stack shares the Domain its web and api hosts have in common, so a sign-in on one stack replaced the live dashboard's cookie.
describe("cookieConfig on a portless .localhost host", () => {
  test("shares one Domain between a stack's web and api hosts", () => {
    expect(forUrl("https://desk.api.playground.localhost").cookieDomain).toBe(
      ".playground.localhost",
    )
  })

  test("names the cookie by the branch prefix, so two stacks never replace each other's", () => {
    expect(forUrl("https://desk.api.playground.localhost").cookiePrefix).toBe("desk")
    expect(forUrl("https://stack-1.api.playground.localhost").cookiePrefix).toBe("stack-1")
  })

  test("a stack on 443, or on no port, keeps today's names byte for byte, so the Mac's own signed-in users stay signed in (PG-2207)", () => {
    for (const url of ["https://api.playground.localhost", "https://api.playground.localhost:443"])
      expect(forUrl(url).cookiePrefix).toBeUndefined()
    expect(forUrl("https://desk.api.playground.localhost:443").cookiePrefix).toBe("desk")
  })

  test("a stack on any other port names its cookie by its port too, so a tunnelled Dashboard and this Mac's keep their own (PG-2207)", () => {
    expect(forUrl("https://api.playground.localhost:1355")).toEqual({
      cookieDomain: ".playground.localhost",
      cookiePrefix: "p1355",
      isPrivate: false,
    })
    expect(forUrl("https://desk.api.playground.localhost:1355").cookiePrefix).toBe("desk.p1355")
    expect(forUrl("https://api.playground.localhost:1356").cookiePrefix).toBe("p1356")
  })

  test("keeps the default name on a stack with no branch prefix", () => {
    expect(forUrl("https://api.playground.localhost")).toEqual({
      cookieDomain: ".playground.localhost",
      cookiePrefix: undefined,
      isPrivate: false,
    })
  })
})

describe("cookieConfig on a custom domain", () => {
  const host = (subdomain: string | null) => ({
    domain: "example.com",
    isIp: false,
    isPrivate: false,
    publicSuffix: "com",
    subdomain,
  })

  test("drops the api leaf for the Domain and prefixes by the label under it", () => {
    expect(cookieConfig(host("api.canary"))).toEqual({
      cookieDomain: ".canary.example.com",
      cookiePrefix: "canary",
      isPrivate: false,
    })
  })

  test("a single-label api subdomain shares the apex with no prefix", () => {
    expect(cookieConfig(host("api"))).toEqual({
      cookieDomain: ".example.com",
      cookiePrefix: undefined,
      isPrivate: false,
    })
  })
})
