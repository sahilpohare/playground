import { resolve } from "node:path"

import "@packages/env/api-hono"
import { Hono } from "hono"

import { branchOf } from "@/lib/dashboard/fixture"
import { createServer } from "@/lib/server"
import { type Fetch, firstRun } from "@/lib/setup/app"
import { setupName, startLocal, startPgliteDatabase } from "@/lib/setup/container"

// The dev entry (`bun run dev`): with a database it serves index.ts's app; with POSTGRES_URL unset or empty it serves setup mode (lib/setup/app.ts) until Start the database (a container) or Start without Docker (PGlite) has made one, then index.ts's app in this process. The Docker bundle serves index.ts alone, and the Vercel bundle hosted.ts alone.

const normal = async (): Promise<Fetch> =>
  ((await import("@/index")).app as unknown as { fetch: Fetch }).fetch

const root = resolve(process.cwd(), "../..")

const serve: Fetch = process.env.POSTGRES_URL
  ? await normal()
  : firstRun(async (onStep, engine) => {
      const branch = branchOf(root)
      const start = { envFile: resolve(root, ".env"), name: setupName(root, branch), onStep }
      process.env.POSTGRES_URL =
        engine === "pglite"
          ? await startPgliteDatabase(start)
          : await startLocal({ ...start, branch })
    }, normal)

const front = new Hono()
front.all("*", (c) => serve(c.req.raw, c.env))

const server = createServer(front)
export default server
