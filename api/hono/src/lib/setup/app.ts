import { site } from "@packages/config/site"
import { getBuildVersion } from "@packages/env"
import { env } from "@packages/env/api-hono"
import { Hono } from "hono"
import { rateLimiter } from "hono-rate-limiter"
import { cors } from "hono/cors"

import { currentSource } from "@/lib/dashboard/fixture"
import { ApiError, errorHandler, jsonError } from "@/lib/error"
import { firstRunChecks } from "@/lib/onboard/checks"
import {
  busy,
  type DatabaseFix,
  type Fixes,
  fixes as shared,
  readFix,
  startFix,
} from "@/lib/onboard/fix"
import { requireLoopback, requireThisMachine, requireTrustedOrigin } from "@/middlewares/dashboard"

// The API with no database, which src/main.ts serves while POSTGRES_URL is unset: GET /api/health answers up with `setup: true` and no database, so playground's wait, ops-tick's watch and verify count the stack as up, GET /api/setup reads where setup stands, POST /api/setup/container starts a local container, GET /api/v1/onboard/checks answers the first run's checks with the database as setup stands and done false, since the done mark lives in the database, GET and POST /api/v1/onboard/fix/:id read and start the first run's fixes, the database's being Start a local container or Start without Docker (PGlite), and every other route is 404. It imports no database, auth or session code, since better-auth lives in the database setup makes, so its writes are guarded by origin and loopback alone, refused when forwarded from off this machine (a tailnet or a LAN proxy), limited to 5 a minute together and run one at a time with every fix.

export type SetupState =
  | { status: "failed"; reason: string }
  | { status: "idle" }
  | { status: "starting"; step: string }

export type Fetch = (request: Request, env: unknown) => Response | Promise<Response>

export type StartSetup = (onStep: (step: string) => void, engine: DatabaseFix) => Promise<void>

// start resolves once the database the engine names (a container, or PGlite with no Docker) is ready and the API has moved on to the normal app, or throws with words for the page.
export const setupApp = (start: StartSetup, runner: Fixes = shared) => {
  let state: SetupState = { status: "idle" }
  const database = async (line: (text: string) => void, engine: DatabaseFix) => {
    state = { status: "starting", step: "Starting" }
    try {
      await start((step) => {
        state = { status: "starting", step }
        line(step)
      }, engine)
    } catch (error) {
      state = { reason: error instanceof Error ? error.message : String(error), status: "failed" }
      throw error
    }
  }
  const writes = [
    requireTrustedOrigin,
    requireLoopback,
    requireThisMachine,
    rateLimiter({
      handler: (c) => jsonError(c, 429, "TOO_MANY_REQUESTS", "Too Many Requests"),
      keyGenerator: () => "setup",
      limit: 5,
      windowMs: 60_000,
    }),
  ] as const
  const app = new Hono().basePath("/api")
  app.use("*", cors({ allowMethods: ["GET", "POST"], origin: env.HONO_TRUSTED_ORIGINS }))
  app.onError(errorHandler)
  app.notFound((c) => jsonError(c, 404, "NOT_FOUND", "Not Found"))
  app.get("/health", (c) =>
    c.json({
      data: {
        dashboard: currentSource().kind,
        dispatcherSlots: 1,
        environment: env.NODE_ENV,
        message: "ok",
        setup: true,
        version: getBuildVersion(),
      },
    }),
  )
  app.get("/setup", (c) => c.json({ data: state }))
  app.get("/v1/onboard/checks", requireThisMachine, async (c) =>
    c.json({ data: await firstRunChecks({ database: state, mark: null }) }),
  )
  app.get("/v1/onboard/fix/:id", requireThisMachine, readFix(runner))
  app.post("/v1/onboard/fix/:id", ...writes, startFix(runner, database))
  app.post("/setup/container", ...writes, (c) => {
    if (state.status === "starting") {
      throw new ApiError(409, "CONFLICT", "Setup is already running")
    }
    if (!runner.start("database", database)) throw busy()
    return c.json({ data: state }, 202)
  })
  return app
}

// Serves setupApp until start resolves, then loads the normal app and serves it from then on, so setup's routes answer 404 with no restart.
export const firstRun = (start: StartSetup, load: () => Promise<Fetch>): Fetch => {
  let serve: Fetch = setupApp(async (onStep, engine) => {
    await start(onStep, engine)
    onStep(`Opening ${site.name}`)
    serve = await load()
  }).fetch
  return (request, env) => serve(request, env)
}
