import type { NextRequest } from "next/server"

import { config as app } from "@/lib/config"
import { secure } from "@/lib/security-headers"

export const proxy = (request: NextRequest) => secure(request, app.hosted)

// pages alone: static files, images and the API rewrite take no CSP, and a link's prefetch takes the page's own when it renders
export const config = {
  matcher: [
    {
      missing: [
        { key: "next-router-prefetch", type: "header" },
        { key: "purpose", type: "header", value: "prefetch" },
      ],
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
    },
  ],
}
