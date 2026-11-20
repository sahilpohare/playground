import { join } from "node:path"

import { site } from "@packages/config/site"
import { db } from "@packages/db"
import { getBuildVersion } from "@packages/env"
import { env } from "@packages/env/api-hono"
import { answerKind } from "@packages/message"
import { readPolicyOrDefaults, yardSettings } from "@packages/settings"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import { apiReference, serveScalarBundle } from "@/lib/api-reference"
import { baseApp } from "@/lib/base-app"
import { keepSweeping } from "@/lib/dashboard/attachments"
import { deliver } from "@/lib/dashboard/deliver"
import { readsLive } from "@/lib/dashboard/fixture"
import { endLostRoots, getItem } from "@/lib/dashboard/inbox"
import { startSdkProbe } from "@/lib/dashboard/sdk"
import { seedFixtureThreadsAtStart } from "@/lib/dashboard/threads"
import { DISPATCHER } from "@/lib/dashboard/workers"
import { globalErrorResponses } from "@/lib/error"
import { DB_TIMEOUT_MS, healthData } from "@/lib/health"
import { startRelay } from "@/lib/relay/mac"
import { checkoutEnvValues, keychainValues } from "@/lib/relay/redact"
import { createServer, upgradeWebSocket } from "@/lib/server"
import { dataDir } from "@/lib/sessions/paths"
import { sessionCookie } from "@/lib/sign-in"
import { yardClient } from "@/lib/yard/client"
import { startYardPoll } from "@/lib/yard/inbound"
import { keychain, pendingKeychain } from "@/lib/yard/keychain"
import { outboxAlert, startRotation } from "@/lib/yard/rotate"
import { requireFeature } from "@/middlewares"
import {
  accountsRouter,
  agentsRouter,
  appsRouter,
  authRouter,
  dashboardRouter,
  dispatcherRouter,
  extensionsRouter,
  extRouter,
  inboxRouter,
  localYardRouter,
  onboardRouter,
  remoteRouter,
  sessionsRouter,
  settingsRouter,
  templatesRouter,
  v1Router,
  waitlistRouter,
} from "@/routers"
import { mountOldPaths, OLD_PATHS_DOC } from "@/routers/old-paths"
import { owners } from "@/routers/onboard"

const BUILD_VERSION = getBuildVersion()

// The local dashboard's whole API, which index.ts serves unless PLAYGROUND_HOSTED picks hosted.ts.
export const app = baseApp()

const routes = app
  .get("/", (c) => {
    const data = { version: BUILD_VERSION, environment: env.NODE_ENV }
    return c.json({ data })
  })
  .get("/headers", (c) => {
    if (env.NODE_ENV !== "local" && env.NODE_ENV !== "development") {
      throw new HTTPException(403, { message: "Forbidden" })
    }
    const data = c.req.header()
    return c.json({ data })
  })
  .basePath("/api")
  .get(
    "/health",
    describeRoute({
      tags: ["System"],
      description: "Get the system health",
      ...({
        "x-codeSamples": [
          {
            lang: "typescript",
            label: "hono/client",
            source: `import { apiClient, unwrap } from "@/lib/api/client"

const { data, error } = await unwrap(apiClient.health.$get())`,
          },
        ],
      } as object),
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  data: z.object({
                    db: z.enum(["ok", "unreachable"]).meta({
                      description: `A \`select 1\` against this stack's database, answered within ${DB_TIMEOUT_MS / 1000}s of its being asked, so a hung database degrades the route instead of holding it`,
                      example: "ok",
                    }),
                    dbError: z
                      .string()
                      .optional()
                      .meta({
                        description: "Why the database is unreachable; present only when db is",
                        example: `no answer from the database within ${DB_TIMEOUT_MS}ms`,
                      }),
                    dashboard: z.enum(["fixture", "hosted", "live", "refused"]).meta({
                      description:
                        "Where this stack reads sessions and their files from: a fixture (a made-up machine, the default on every branch but the live dashboard's), the live machine, or nothing (the hosted build, or refused settings)",
                      example: "fixture",
                    }),
                    dispatcherSlots: z.number().int().min(1).meta({
                      description:
                        "How many dispatcher rows the Dashboard's sidebar header draws: the primary's, plus the second's while a session of its name is registered or the roster lists it in a status other than done or ended. A stored sidebar draws that many rows, placeholders for those it lacks, so the rows arriving move nothing below them",
                      example: 2,
                    }),
                    environment: z
                      .enum(["local", "development", "test", "staging", "production"])
                      .meta({ example: env.NODE_ENV }),
                    message: z.enum(["ok", "degraded"]).meta({
                      description: "The overall status: degraded when db is unreachable",
                      example: "ok",
                    }),
                    version: z.string().meta({ example: BUILD_VERSION }),
                    vibe: z.string().nullable().meta({
                      description:
                        "This checkout's branch while it runs as a Vibeground, started from the Inbox's Preview row on a copy of the live data, else null; its pages wear a Vibeground badge with it",
                      example: null,
                    }),
                  }),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => c.json({ data: await healthData() }),
  )
  .get(
    "/health/ws",
    describeRoute({
      tags: ["System"],
      description:
        "Live system health over a WebSocket. On connect the server sends a snapshot, then a heartbeat every 5s. Each frame is JSON: { message, version, environment, timestamp }.",
      ...({
        "x-codeSamples": [
          {
            lang: "typescript",
            label: "hono/client",
            source: `import { apiClient } from "@/lib/api/client"

const socket = apiClient.health.ws.$ws()
socket.addEventListener("message", (event) => {
  const health = JSON.parse(event.data)
})`,
          },
        ],
      } as object),
      responses: {
        101: { description: "Switching Protocols: the WebSocket handshake succeeded." },
      },
    }),
    upgradeWebSocket(() => {
      let heartbeat: ReturnType<typeof setInterval> | null = null
      const snapshot = () =>
        JSON.stringify({
          message: "ok",
          version: BUILD_VERSION,
          environment: env.NODE_ENV,
          timestamp: new Date().toISOString(),
        })
      return {
        onOpen(_event, ws) {
          ws.send(snapshot())
          heartbeat = setInterval(() => ws.send(snapshot()), 5000)
        },
        // onClose fires on every disconnect on both adapters (Bun has no error event; ws always emits close after error), so this covers all cleanup.
        onClose() {
          if (heartbeat) clearInterval(heartbeat)
        },
      }
    }),
  )
  .route("/agents", agentsRouter)
  .route("/auth", authRouter)
  // the dashboard's routes sit beside user and admin under /api/v1, the dashboard router's with no segment of its own; each mounts before v1Router, so its write guards run before v1Router's session read
  .route("/v1/onboard", onboardRouter)
  .route("/v1/dashboard/dispatcher", dispatcherRouter)
  .route("/v1", dashboardRouter)
  .route("/v1/accounts", accountsRouter)
  .route("/v1/apps", appsRouter)
  .route("/v1/ext", extRouter)
  .route("/v1/extensions", extensionsRouter)
  .route("/v1/inbox", inboxRouter)
  .route("/v1/remote", remoteRouter)
  .route("/v1/sessions/templates", templatesRouter)
  .route("/v1/sessions", sessionsRouter)
  .route("/v1/settings", settingsRouter)
  .route("/v1/yard", localYardRouter)
  .route("/v1", v1Router)
  .route("/waitlist", waitlistRouter)
  // Gate both the OpenAPI document and the Scalar UI on apiDocs; the UI fetches the spec, so gating only the UI would leave the full spec public.
  .use("/openapi.json", requireFeature("apiDocs"))
  .get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          version: BUILD_VERSION,
          title: site.name,
          description: site.apiReferenceDescription,
        },
      },
      exclude: OLD_PATHS_DOC,
      // Always-reachable errors (429/500) on every method the API serves; routes add 400/401 in their own responses. Add a method here the day a route starts using it, or its responses ship undocumented.
      defaultOptions: {
        DELETE: { responses: globalErrorResponses },
        GET: { responses: globalErrorResponses },
        PATCH: { responses: globalErrorResponses },
        POST: { responses: globalErrorResponses },
        PUT: { responses: globalErrorResponses },
      },
    }),
  )
  .use("/docs", requireFeature("apiDocs"))
  .get("/docs", apiReference)
  .use("/docs/scalar.js", requireFeature("apiDocs"))
  .get("/docs/scalar.js", serveScalarBundle)

export type AppType = typeof routes
export type {
  Agent,
  AgentsBoard,
  AgentState,
  CiState,
  Pull,
  PullProblem,
  PullsQueue,
  Report,
} from "@/lib/dashboard/agents"
export type {
  OpsFinding,
  OpsHealth,
  OpsLine,
  OpsReport,
  OpsReportRead,
} from "@/lib/apps/ops-report"
export type {
  Plan,
  PlanDone,
  PlanInFlight,
  PlanItem,
  PlanLanding,
  PlanLane,
  PlanRead,
} from "@/lib/apps/plan"
export type { PlanOrder } from "@/lib/apps/plan-order"
export type { AccountRow } from "@/lib/store/accounts"
export type { BundledRow, ExtensionRow } from "@/lib/store/extensions"
export type { Preview, PreviewKind } from "@/lib/apps/previews"
export type * from "@/plugins/registry"
export type { BatchAnswer, BatchOutcome, BatchRefusalCode } from "@/lib/batch"
export type { AttachmentKind, EntryAttachment } from "@/lib/dashboard/attachments"
export type { DashboardFrame } from "@/lib/dashboard/hub"
export type { RelayStatus } from "@/lib/relay/protocol"
export type {
  InboxAction,
  InboxAnswer,
  InboxAttachment,
  InboxAttachmentKind,
  InboxDelivery,
  InboxDraft,
  InboxItem,
  InboxKind,
  InboxList,
  InboxPreview,
  InboxUpdate,
} from "@/lib/dashboard/inbox"
export type { OpsRow, OpsStatus } from "@/lib/dashboard/ops"
export type { RosterRole } from "@/lib/dashboard/roster"
export type { Entry, SessionTask } from "@/lib/dashboard/transcript"
export type { UsageLimit } from "@/lib/dashboard/unstick"
export type { WaitsOn, WorkPull, WorkQueue } from "@/lib/dashboard/work-queue"
export type { FeedItem, Light, Question, Role, Worker } from "@/lib/dashboard/workers"
export type { IdleStack, Limit } from "@/lib/system/capacity"
export type { Pressure } from "@/lib/system/parse"
export type { SystemAgent, SystemPoint, SystemReport, SystemStack } from "@/lib/system/sampler"
export type { Forecast, PrCost, Spend, UsageReport, WindowView } from "@/lib/usage/report"
export type { AccountUsage, Usage, UsageWindow } from "@/lib/usage/window"
export type { ZaiUsage, ZaiWindow } from "@/lib/usage/zai"
export type { ErrorCode } from "@/lib/error"
export type { EntryKind, SessionKind } from "@/lib/sessions/lines"

// Files a dashboard message carried leave the attachments folder a week after they arrive.
keepSweeping()

// The session the dashboard hosts on the Agent SDK, when PLAYGROUND_SDK_PROBE_DIR names its folder.
startSdkProbe()

// A root step's run lives in the process that claimed its card, so each approved one with no result from before this start was lost: it reads failed and its poster is told, on a stack that reads this machine alone.
if (readsLive()) {
  endLostRoots(db, new Date(), {
    actor: { label: "Dashboard" },
    deliver,
    dispatcher: DISPATCHER,
  }).catch((error: unknown) =>
    console.error(
      `inbox: ending the root steps a restart cut off failed: ${error instanceof Error ? error.message : error}`,
    ),
  )
}

// Yard's mentions of the owner into the Inbox, once a minute, when YARD_API_URL names a hosted Yard.
startYardPoll(db, yardClient)

// A fresh fixture stack's threads page from its first load: an empty thread table takes the fixture's threads at start, one line saying so; a full table and any other source write nothing.
seedFixtureThreadsAtStart(db).catch((error: unknown) =>
  console.error(
    `fixture: seeding the made-up threads failed: ${error instanceof Error ? error.message : error}`,
  ),
)

// The relay to the hosted Yard, on a stack that reads this Mac alone, never a fixture's: with YARD_API_URL set and a relay-on token in the Keychain (keychain), the owner's browser on Yard reads this dashboard through one socket this API dials out, and sends the writes its paired key signs, each run here as the one local owner.
if (env.YARD_API_URL && readsLive()) {
  const api = env.YARD_API_URL
  let made: Promise<string> | null = null
  const cookie = () =>
    (made ??= (async () => {
      const found = await owners()
      if (found.length !== 1) throw new Error("the relay needs this Mac's one owner")
      const { name, value } = await sessionCookie(found[0]!)
      return `${name}=${value}`
    })().catch((error: unknown) => {
      made = null
      throw error
    }))
  // read at each bot's read, so a bot add --log or a revoke counts from the next one, and a policy.json that does not parse lets no bot read
  const readers = () => {
    const read = readPolicyOrDefaults(dataDir())
    return read.refusal === undefined ? yardSettings.get(read.settings, "yard.logReaders") : {}
  }
  const relay = keychainValues(Object.keys(readers())).then((kept) =>
    startRelay({
      api,
      cookie,
      // a session the API refuses (expired) is made again for the next read
      dispatch: async (request) => {
        const response = await app.fetch(request)
        if (response.status === 401) made = null
        return response
      },
      // a card's kind (answerKind) by its id, as its answer, schedule and dismiss read it, or by the exact `#iN` a message's reply names, never a bare `iN`
      kindOf: async (key) => {
        const item = await getItem(db, key)
        if (!item || (key !== item.id && key !== `#i${item.ref}`)) return null
        return answerKind(item)
      },
      login: async (token) => (await yardClient(api, token).me()).login,
      readers,
      // the .env read at each bot's read, the Keychain's values once, before the relay opens
      secretValues: () => [...checkoutEnvValues(), ...kept],
      token: () => keychain().read(),
    }),
  )
  // the Mac's swap of its own token once a day, with no step from the owner, which moves the relay to the new one; a failed swap tells Ops alone
  startRotation({
    alert: outboxAlert(dataDir()),
    client: (token) => yardClient(api, token),
    keychain: keychain(),
    pending: pendingKeychain(),
    renew: () => void relay.then((held) => held.renew()),
    stamp: join(dataDir(), "yard-rotated.json"),
  })
}

mountOldPaths(routes, {
  apps: appsRouter,
  dashboard: dashboardRouter,
  inbox: inboxRouter,
  sessions: sessionsRouter,
})

// Bun.serve() shape locally and self-hosted, Node http.Server on Vercel; see @/lib/server.
export default createServer(app)
