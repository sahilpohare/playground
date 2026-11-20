import { describe, expect, test } from "bun:test"

import type { Pull } from "../../../../../../api/hono/src/lib/dashboard/agents"
import { gatesAt, parseGates } from "../../../../../../api/hono/src/lib/dashboard/gates"

const HEAD = "a".repeat(40)

const pull = (fields: Partial<Pull> = {}): Pull => ({
  approvals: 0,
  ci: "passing",
  conflicts: false,
  draft: false,
  gates: null,
  head: HEAD,
  number: 7,
  queued: false,
  reviewed: true,
  round: 1,
  score: "5/5",
  state: "open",
  tester: null,
  title: "",
  updatedAt: null,
  url: "https://github.com/o/r/pull/7",
  verdict: "5/5",
  ...fields,
})

const file = (prs: unknown) => JSON.stringify({ at: "2026-11-17T00:00:00.000Z", prs })

describe("the merge train's gate reads (#2499)", () => {
  test("a PR reads the gates the train found failing at its own head", () => {
    const gates = parseGates(file({ "o/r#7": { failed: ["tester"], head: HEAD } }))
    expect(gatesAt(gates, pull())).toEqual(["tester"])
    expect(gatesAt(parseGates(file({ "o/r#7": { failed: [], head: HEAD } })), pull())).toEqual([])
  })

  test("a read at another head, of another PR or repo, or of a PR no longer open, is no read", () => {
    const gates = parseGates(file({ "o/r#7": { failed: [], head: "b".repeat(40) } }))
    expect(gatesAt(gates, pull())).toBeNull()
    const here = parseGates(file({ "o/r#7": { failed: [], head: HEAD } }))
    expect(gatesAt(here, pull({ number: 8, url: "https://github.com/o/r/pull/8" }))).toBeNull()
    expect(gatesAt(here, pull({ url: "https://github.com/o/other/pull/7" }))).toBeNull()
    expect(gatesAt(here, pull({ state: "merged" }))).toBeNull()
    expect(gatesAt(here, pull({ head: "" }))).toBeNull()
  })

  test("a file that does not read holds no read, and an entry that does not read costs only itself", () => {
    expect(parseGates("not json").size).toBe(0)
    expect(parseGates(JSON.stringify({ prs: [] })).size).toBe(0)
    const mixed = parseGates(
      file({
        "o/r#7": { failed: ["review"], head: HEAD },
        "o/r#8": { failed: "review", head: HEAD },
        "o/r#9": { failed: [3], head: HEAD },
        "o/r#10": { failed: [] },
      }),
    )
    expect([...mixed.keys()]).toEqual(["o/r#7"])
  })
})
