import { sValidator } from "@hono/standard-validator"
import type { Session } from "@packages/auth"
import { HARNESS_IDS } from "@packages/settings"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"

import { startDispatcher } from "@/lib/dashboard/dispatcher-start"
import { dispatcherSwitch, switchDeps } from "@/lib/dashboard/dispatcher-switch"
import {
  ApiError,
  authErrorResponses,
  conflictErrorResponses,
  errorResponse,
  forbiddenErrorResponses,
  validationErrorResponses,
} from "@/lib/error"
import { authMiddleware, guardWrites, requireConsoleRole } from "@/middlewares"
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
export const dispatcherRouter = new Hono<{ Variables: Session }>()
  .use("/*", guardWrites)
  .use("/*", authMiddleware)
  .use("/*", requireConsoleRole("owner"))
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
