import { expect, test } from "bun:test"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../..")

// A ZeroStarter sync or a Next upgrade can rewrite next.config.ts, and a lost key shows only when the next advisory stops every session's build; the audit gates catch that advisory instead (docs/dependencies.md, `next`)
test("Next's agent-only upgrade stop is off in the web app's config", async () => {
  const { default: config } = await import("../../../web/next/next.config")
  expect(config.experimental?.agentUpgrade).toBe(false)
})

// Next reads __NEXT_AGENT_UPGRADE ahead of the config, so no env schema or turbo passthrough may carry it into a build
test("no env schema or turbo.json passes Next's upgrade policy variable to a build", async () => {
  const files = [
    "turbo.json",
    ...[...new Bun.Glob("packages/env/src/**/*.ts").scanSync({ cwd: ROOT })].sort(),
  ]
  expect(files).toContain("packages/env/src/web-next.ts")
  const carrying: string[] = []
  for (const file of files)
    if ((await Bun.file(join(ROOT, file)).text()).includes("__NEXT_AGENT_UPGRADE"))
      carrying.push(file)
  expect(carrying).toEqual([])
})
