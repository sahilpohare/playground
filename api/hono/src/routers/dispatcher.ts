import { sValidator } from "@hono/standard-validator"
import type { Session } from "@packages/auth"
import { db } from "@packages/db"
import { HARNESS_IDS } from "@packages/settings"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"

import { startDispatcher } from "@/lib/dashboard/dispatcher-start"
import { dispatcherSwitch, switchDeps } from "@/lib/dashboard/dispatcher-switch"
import { DISPATCHER, listLive } from "@/lib/dashboard/workers"
import {
  ApiError,
  authErrorResponses,
  conflictErrorResponses,
  errorResponse,
  forbiddenErrorResponses,
  notFoundErrorResponses,
  validationErrorResponses,
} from "@/lib/error"
import { readEntriesAfter } from "@/lib/sessions/read"
import { authMiddleware, guardWrites, requireConsoleRole } from "@/middlewares"
import { refuseAgentOffFixture } from "@/middlewares/agent"
import { invalid } from "@/routers/store"

// The home's Start <dispatcher>, for a dashboard with an account and no dispatcher, and Settings' Switch Alpha, which moves it to the other harness: dashboard writes, behind the write guards and the owner rung.

const switchRead = z.object({
  ask: z.string().nullable(),
  harness: z.enum(HARNESS_IDS).nullable(),
  reason: z.string().nullable(),
  state: z.enum(["failed", "idle", "ok", "running"]),
  step: z.string().nullable(),
  to: z.string().nullable(),
})
const switchAnswer = (status: 200 | 202) => ({
  [status]: {
    content: { "application/json": { schema: resolver(z.object({ data: switchRead })) } },
    description: status === 200 ? "OK" : "Started",
  },
})
// The lines a page of the dispatcher's log holds, the page a bot reads through the relay.
export const LOG_PAGE = 100

export const dispatcherRouter = new Hono<{ Variables: Session }>()
  .use("/*", guardWrites)
  .use("/*", authMiddleware)
  .use("/*", requireConsoleRole("owner"))
  .use("/*", refuseAgentOffFixture)
  .post(
    "/start",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Start the dispatcher: runs the CLI's dispatcher step, which writes its brief when missing and starts it with spawn.sh. Refused while a session holds the dispatcher's name. A fixture stack starts nothing: it brings its made-up dispatcher back, or makes one when it has none.",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: resolver(
                z.object({ data: z.object({ name: z.string(), started: z.literal(true) }) }),
              ),
            },
          },
          description: "Started",
        },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...conflictErrorResponses,
        500: errorResponse("INTERNAL_SERVER_ERROR", "The dispatcher could not be started"),
        502: errorResponse("ERROR", "spawn.sh refused or failed, its reason passed through"),
      },
    }),
    async (c) => {
      const started = await startDispatcher()
      if (started.status === "started") {
        return c.json({ data: { name: started.name, started: true as const } })
      }
      if (started.status === "running") {
        throw new ApiError(409, "CONFLICT", `${started.name} is already running`)
      }
      if (started.status === "refused") throw new ApiError(502, "ERROR", started.detail)
      throw new ApiError(500, "INTERNAL_SERVER_ERROR", started.detail)
    },
  )
  .get(
    "/switch",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Reads Switch Alpha: idle, running with the step it is on (waiting for the dispatcher's handoff, then starting it on the new harness), ok, or failed with why.",
      responses: { ...switchAnswer(200), ...authErrorResponses, ...forbiddenErrorResponses },
    }),
    (c) => c.json({ data: dispatcherSwitch.read() }),
  )
  // the one route BOT_GETS names (`api/hono/src/lib/relay/protocol.ts`): the Mac answers a bot's read here as its owner, then redacts it before it leaves
  .get(
    "/log",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "A page of the live dispatcher's own log after a seq (0 for its first line), in file order: the lines a bot the owner lets read the log reads through the relay, with hasMore while more wait and the session the seqs belong to, which a new dispatcher changes",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    sValidator("query", z.object({ after: z.coerce.number().int().min(0).default(0) }), invalid),
    async (c) => {
      const { workers } = await listLive()
      const session = workers.find(
        (w) => w.role === "dispatcher" && w.name === DISPATCHER,
      )?.sessionId
      if (!session) throw new ApiError(404, "NOT_FOUND", "No dispatcher runs now")
      const page = await readEntriesAfter(db, session, {
        after: c.req.valid("query").after,
        limit: LOG_PAGE,
      })
      return c.json({ data: { ...page, session } })
    },
  )
  .post(
    "/switch",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Switch Alpha to a harness: starts the dispatcher on it when none runs; for a running one the answer's ask holds the words that ask it for its handoff, which Settings sends through the outbox, and once the handoff is written the switch closes it and starts it again on the new harness from it. harness.alpha saves once the new dispatcher has started. Refused while a switch runs, and for Codex on the live data folder.",
      responses: {
        ...switchAnswer(202),
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...conflictErrorResponses,
        ...validationErrorResponses,
      },
    }),
    sValidator("json", z.strictObject({ harness: z.enum(HARNESS_IDS) }), invalid),
    async (c) => {
      const begun = await dispatcherSwitch.begin(
        c.req.valid("json").harness,
        switchDeps({ id: c.get("user").id }),
      )
      if (typeof begun === "string") throw new ApiError(409, "CONFLICT", begun)
      return c.json({ data: dispatcherSwitch.read() }, 202)
    },
  )
