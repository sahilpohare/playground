import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listTools } from "../../../../../../packages/scripts/src/parity/replay/snapshot"

const HERE = join(import.meta.dir, "../../../../../../packages/scripts/src/parity/replay")

const scratch = mkdtempSync(join(tmpdir(), "parity-snapshot-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

test("lists a stdio server's tools by name, read here from a replay's own stub", async () => {
  const fixture = join(scratch, "slack-shared.json")
  writeFileSync(fixture, "{}\n")
  const schemas = join(scratch, "schemas.json")
  writeFileSync(
    schemas,
    JSON.stringify(
      ["search_messages", "chat_post_message"].map((name) => ({ inputSchema: {}, name })),
    ),
  )
  const tools = await listTools({
    args: [
      join(HERE, "stub-mcp.ts"),
      "--server",
      "slack-shared",
      "--recording",
      fixture,
      "--schemas",
      schemas,
      "--log",
      "/dev/null",
    ],
    command: process.execPath,
  })
  expect(tools.map((t) => t.name)).toEqual(["chat_post_message", "search_messages"])
})
