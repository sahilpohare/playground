import type { Session } from "@packages/auth"
import { site } from "@packages/config/site"
import { createMiddleware } from "hono/factory"

import { currentSource, type DashboardSource } from "@/lib/dashboard/fixture"
import { ApiError } from "@/lib/error"
import { READS } from "@/middlewares/dashboard"

// The agent sign-in holds the owner rung, so a write that acts as the owner (an Inbox answer, a message, a key's pairing, the dispatcher's start and switch) refuses its account after the rung on every source but a fixture, where testers drive those flows on made-up data; a source added later refuses too. Kept out of the middlewares index, which the hosted entry imports.
export const agentRefusal = (source: () => DashboardSource) =>
  createMiddleware<{ Variables: Session }>(async (c, next) => {
    if (
      !READS.has(c.req.method) &&
      c.get("user")?.email === site.agent.email &&
      source().kind !== "fixture"
    ) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Off a fixture stack, a write that acts as the owner is the owner's own click alone",
      )
    }
    await next()
  })

export const refuseAgentOffFixture = agentRefusal(currentSource)
