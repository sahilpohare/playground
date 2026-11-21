import { describe, expect, test } from "bun:test"

import { Hono } from "hono"

import type { DashboardSource } from "../../../../../api/hono/src/lib/dashboard/fixture"
import { agentRefusal } from "../../../../../api/hono/src/middlewares/agent"
import { site } from "../../../../../packages/config/src/site"

const SOURCES: Record<string, DashboardSource> = {
  fixture: { file: null, kind: "fixture", rule: "factory" },
  hosted: { kind: "hosted" },
  "live-branch": { kind: "live", rule: "live-branch" },
  "live-reads": { kind: "live", rule: "live-reads" },
  own: { kind: "live", rule: "own" },
  refused: { kind: "refused", reason: "made up" },
}

// A route behind the refusal, signed in as the email given, on the source given.
const call = (source: DashboardSource, email: string, method = "POST") =>
  new Hono<{ Variables: { user: { email: string } } }>()
    .use("/*", async (c, next) => {
      c.set("user", { email })
      await next()
    })
    .use(
      "/*",
      agentRefusal(() => source),
    )
    .all("/write", (c) => c.text("done"))
    .request("http://127.0.0.1/write", { method })

describe("the agent sign-in's writes as the owner", () => {
  test("pass on a fixture stack, where testers drive them on made-up data", async () => {
    expect(await (await call(SOURCES.fixture!, site.agent.email)).text()).toBe("done")
  })

  test.each(["hosted", "live-branch", "live-reads", "own", "refused"])(
    "are refused with 403 on a %s source, which is not a fixture",
    async (name) => {
      const response = await call(SOURCES[name]!, site.agent.email)
      expect(response.status).toBe(403)
      expect(await response.text()).toContain("owner's own click")
    },
  )

  test.each(Object.keys(SOURCES))("the owner's own write passes on a %s source", async (name) => {
    expect(await (await call(SOURCES[name]!, site.owner.email)).text()).toBe("done")
  })

  test.each(["GET", "HEAD", "OPTIONS"])(
    "the agent's %s read passes on a live source",
    async (method) => {
      expect((await call(SOURCES["live-branch"]!, site.agent.email, method)).status).toBe(200)
    },
  )
})
