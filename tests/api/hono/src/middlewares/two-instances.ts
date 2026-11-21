import { Hono } from "../../../../../api/hono/node_modules/hono"
import { createRateLimiter } from "../../../../../api/hono/src/middlewares/rate-limiter"

// One API instance whose requests pass two limiters of 1 a minute, as a Yard request passes the global one and its own; prints the status and time of each of argv[2]'s anonymous requests, one by default. rate-limiter.test.ts runs it as one instance or two, with KV_URL set or unset.
const app = new Hono()
  .use("*", createRateLimiter({ limit: 1, windowMs: 60_000 }))
  .use("*", createRateLimiter({ limit: 1, windowMs: 60_000 }))
  .get("/", (c) => c.text("ok"))

const answers: { ms: number; status: number }[] = []
for (let i = 0; i < Number(process.argv[2] ?? 1); i++) {
  const start = performance.now()
  const { status } = await app.request("/")
  answers.push({ ms: Math.round(performance.now() - start), status })
}
console.log(JSON.stringify(answers))
process.exit(0)
