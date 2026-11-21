import { expect, test } from "bun:test"
import { join } from "node:path"

import { LOCAL_SERVED, LOCAL_URL, storedAs } from "../../../../packages/config/src/console"

test("a dashboard action is also looked up under its old desk name, which rows written before the rename hold", () => {
  expect(storedAs("dashboard.message")).toEqual(["dashboard.message", "desk.message"])
  expect(storedAs("role.change")).toEqual(["role.change"])
})

test("spawn.sh starts a local session on the server and served name the dashboard reads, each kept once in config", async () => {
  const spawn = await Bun.file(join(import.meta.dir, "../../../../scripts/spawn.sh")).text()
  expect(spawn).toContain(`\nLOCAL_URL=${LOCAL_URL}\n`)
  expect(spawn).toContain(`\nLOCAL_SERVED=${LOCAL_SERVED}\n`)
})
