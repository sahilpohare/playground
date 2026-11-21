import { describe, expect, test } from "bun:test"

import { ROLE_OPTIONS } from "../../../../../../web/next/src/components/dashboard/status-table"

describe("ROLE_OPTIONS", () => {
  test("offers every group an agent's row can sit in, and not Scripts, which holds the ops jobs alone", () => {
    expect(ROLE_OPTIONS.map(({ value }) => value)).toEqual([
      "Dispatchers",
      "Orchestrators",
      "AI Runners",
      "Subagents",
      "Other",
    ])
  })
})
