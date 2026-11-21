import { type NextRequest, NextResponse } from "next/server"

// The headers next.config.ts puts on every hosted response; the local build adds none, so it keeps the headers it sent before.
export const securityHeaders = (hosted: boolean) =>
  hosted
    ? [
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ]
    : []

// A hosted page runs only the app's own scripts and the ones Next marks with this request's nonce, since it renders relayed transcripts holding outside text; next dev's React needs eval for its error stacks.
const hostedCsp = (nonce: string, dev: boolean) =>
  [
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ")

// proxy.ts's work: on the hosted build a fresh nonce for each request, its CSP set on the request, where Next reads the nonce for its own scripts and the root layout reads x-nonce, and on the response; the local build passes every request on as it came.
export function secure(
  request: NextRequest,
  hosted: boolean,
  dev = process.env.NODE_ENV === "development",
): NextResponse {
  if (!hosted) return NextResponse.next()
  const nonce = btoa(crypto.randomUUID())
  const csp = hostedCsp(nonce, dev)
  const headers = new Headers(request.headers)
  headers.set("content-security-policy", csp)
  headers.set("x-nonce", nonce)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set("content-security-policy", csp)
  return response
}
