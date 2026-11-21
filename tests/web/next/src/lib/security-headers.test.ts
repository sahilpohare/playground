import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { secure, securityHeaders } from "../../../../../web/next/src/lib/security-headers"
import { config, proxy } from "../../../../../web/next/src/proxy"

const web = join(import.meta.dir, "../../../../../web/next")
const { NextRequest } = (await import(Bun.resolveSync("next/server", web))) as {
  NextRequest: typeof Request
}

const page = () =>
  new NextRequest("https://yard.example/dashboard", {
    headers: { accept: "text/html" },
  }) as Parameters<typeof secure>[0]

describe("the hosted build's headers", () => {
  test("every response carries nosniff and a same-origin referrer", () => {
    expect(securityHeaders(true)).toEqual([
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ])
  })

  test("a page's CSP allows only the app's own scripts and this request's nonce, and no frame, object or base elsewhere", () => {
    const response = secure(page(), true, false)
    const csp = response.headers.get("content-security-policy")!
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
    // the base64 of a UUID, with no padding, so the viewer can stamp it unquoted (viewer.ts)
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{48}$/)
    expect(csp).toBe(
      `script-src 'self' 'nonce-${nonce}'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
    )
    // the request carries the same policy, which Next reads to put the nonce on its own scripts, and the nonce for the layout
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp)
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce!)
  })

  test("each request takes a fresh nonce, and only next dev's policy allows eval", () => {
    const [a, b] = [secure(page(), true, false), secure(page(), true, false)]
    expect(a.headers.get("content-security-policy")).not.toBe(
      b.headers.get("content-security-policy"),
    )
    expect(secure(page(), true, true).headers.get("content-security-policy")).toContain(
      "'unsafe-eval'",
    )
    expect(a.headers.get("content-security-policy")).not.toContain("unsafe-eval")
  })
})

describe("the local build's headers", () => {
  test("it adds no header, and its proxy passes every request on untouched", () => {
    expect(securityHeaders(false)).toEqual([])
    const response = secure(page(), false, false)
    const added = [...response.headers.keys()].filter((key) => key !== "x-middleware-next")
    expect(added).toEqual([])
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })
})

describe("the wiring", () => {
  // read as text, since importing next.config.ts validates the env and generates the docs' MDX files
  test("next.config.ts sets securityHeaders by the hosted flag on every path", async () => {
    const source = await Bun.file(join(web, "next.config.ts")).text()
    expect(source).toContain("securityHeaders(env.NEXT_PUBLIC_PLAYGROUND_HOSTED)")
    expect(source).toContain('source: "/:path*"')
  })

  test("proxy.ts runs secure on pages alone, by the build's own hosted flag", () => {
    const response = proxy(page())
    // this suite runs the local build, whose proxy passes the request on untouched
    expect([...response.headers.keys()]).toEqual(["x-middleware-next"])
    const [matcher] = config.matcher
    expect(matcher!.source).toBe("/((?!api|_next/static|_next/image|favicon.ico).*)")
    expect(matcher!.missing.map(({ key }) => key)).toEqual(["next-router-prefetch", "purpose"])
  })
})
