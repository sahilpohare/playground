import { expect, test } from "bun:test"
import { join } from "node:path"

// bun run test builds packages/* first, and a checkout with no .env holds none of the values auth's build validates, so the script sets the two flags itself, as CI sets them for its job and check-types sets them in its own script
test("bun run test's build step runs under NODE_ENV=production SKIP_ENV_VALIDATION=true", async () => {
  const { scripts } = await Bun.file(join(import.meta.dir, "..", "package.json")).json()
  expect(scripts.test).toContain(
    "env NODE_ENV=production SKIP_ENV_VALIDATION=true turbo run build --filter='./packages/*'",
  )
})
