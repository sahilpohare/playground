import { describe, expect, test } from "bun:test"

// The routers' auth refuses Better Auth's default secret under NODE_ENV=production, which CI's build step sets. Set before the router loads.
process.env.BETTER_AUTH_SECRET ||= "remote-router-test-secret-not-for-use-anywhere"
const { remoteRouter } = await import("../../../../../api/hono/src/routers/remote")
const { refuseAgentOffFixture } = await import("../../../../../api/hono/src/middlewares/agent")

describe("a remote key's Approve and Revoke refuse the agent sign-in off a fixture stack", () => {
  test("the router carries refuseAgentOffFixture on every path", () => {
    const handlers = remoteRouter.routes.filter((r) => r.path === "/*").map((r) => r.handler)
    expect(handlers).toContain(refuseAgentOffFixture)
  })
})
