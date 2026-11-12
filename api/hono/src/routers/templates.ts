import type { Session } from "@packages/auth"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"

import { listTemplates, startTemplate } from "@/lib/dashboard/templates"
import {
  ApiError,
  authErrorResponses,
  conflictErrorResponses,
  errorResponse,
  forbiddenErrorResponses,
  notFoundErrorResponses,
} from "@/lib/error"
import { authMiddleware, guardWrites, requireConsoleRole } from "@/middlewares"

const templateSchema = z.object({
  effort: z.string().nullable(),
  harness: z.literal("claude-code"),
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  model: z.string().nullable(),
  refusal: z.string().nullable(),
})

// The sidebar plus's templates and their start: dashboard reads and a write, behind the write guards and the owner rung, mounted before /v1/sessions so its /:id never takes them.
export const templatesRouter = new Hono<{ Variables: Session }>()
  .use("/*", guardWrites)
  .use("/*", authMiddleware)
  .use("/*", requireConsoleRole("owner"))
  .get(
    "/",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "List sessions.templates, the sessions the sidebar's plus can start, each with the reason a start would be refused now (no second Claude account, no brief), or null.",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: resolver(z.object({ data: z.array(templateSchema) })),
            },
          },
          description: "The templates",
        },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
      },
    }),
    async (c) => c.json({ data: await listTemplates() }),
  )
  .post(
    "/:id/start",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Start a session from a template: a dispatcher template starts the second dispatcher, any other kind a new lead reporting to the dispatcher, its roster row written first, each through spawn.sh's manager mode. Refused while a session holds the name, or, for a kind with a seat, while a live session holds its seat. A fixture stack starts nothing: it brings back or makes the made-up session.",
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
        ...notFoundErrorResponses,
        ...conflictErrorResponses,
        500: errorResponse("INTERNAL_SERVER_ERROR", "The session could not be started"),
        502: errorResponse("ERROR", "spawn.sh or a gate refused, its reason passed through"),
      },
    }),
    async (c) => {
      const started = await startTemplate(c.req.param("id"))
      switch (started.status) {
        case "started":
          return c.json({ data: { name: started.name, started: true as const } })
        case "missing":
          throw new ApiError(404, "NOT_FOUND", "No such template")
        case "running":
          throw new ApiError(409, "CONFLICT", `${started.name} is already running`)
        case "refused":
          throw new ApiError(502, "ERROR", started.detail)
        case "failed":
          throw new ApiError(500, "INTERNAL_SERVER_ERROR", started.detail)
      }
    },
  )
