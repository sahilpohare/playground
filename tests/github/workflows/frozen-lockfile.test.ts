import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../..")
const WORKFLOWS = ".github/workflows"

// a build that installs without the lockfile frozen resolves versions bun.lock never pinned
test("every CI, Vercel and Docker install keeps to bun.lock", async () => {
  const files = [
    ...readdirSync(join(ROOT, WORKFLOWS)).map((f) => join(WORKFLOWS, f)),
    "api/hono/Dockerfile",
    "api/hono/vercel.json",
    "web/next/Dockerfile",
    "web/next/vercel.json",
  ]
  const installs: [string, string][] = []
  for (const file of files)
    for (const m of (await Bun.file(join(ROOT, file)).text()).matchAll(/bun install[^"\n]*/g))
      installs.push([file, m[0]])
  expect(installs.length).toBeGreaterThanOrEqual(8)
  for (const [file, cmd] of installs)
    expect([file, cmd, cmd.includes("--frozen-lockfile")]).toEqual([file, cmd, true])
})
