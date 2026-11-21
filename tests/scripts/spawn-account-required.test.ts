import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// A worker or checker names its login with --account while usage.accounts lists a Claude row, since the account split ranks logins by week left per hour and cannot follow which login takes which work.
describe("a worker or checker start names its login with --account", () => {
  const parkedUntil = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, "Z")
  const rows = {
    SETTINGS_JSON: JSON.stringify({
      "usage.accounts": [
        { email: "blue@example.com" },
        { email: "pride@example.com", parkedUntil },
        { email: "co@example.com" },
        { label: "zai", provider: "glm" },
      ],
    }),
  }
  const starts: [string, string[]][] = [
    ["a worker", ["worker", "worker-brave-otter", "b.md"]],
    ["a reviewer", ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"]],
    ["a tester", ["column", "tester", "tester-x", "worker-x", "w1:p2", "t.md", "--pr", "1"]],
  ]

  test.each(starts)(
    "%s with no --account is refused, naming usage.accounts' order",
    async (_, args) => {
      const r = await spawn(args, [], rows)
      expect(r.code).toBe(1)
      expect(r.err).toContain(
        `names its login with --account <email>, since the account split cannot follow which login takes which work: usage.accounts lists blue@example.com, pride@example.com (parked until ${parkedUntil}), co@example.com`,
      )
      expect(r.roster).toBeUndefined()
    },
  )

  test.each(starts)("%s with --account starts", async (_, args) => {
    const r = await spawn([...args, "--account", "blue@example.com"], [], rows)
    expect(r.code, r.err).toBe(0)
  })

  test.each([
    ["a runner", ["runner", "runner-calm-heron", "b.md"]],
    ["a probe", ["probe", "probe-x", "ops", "p.md"]],
  ])("%s with no --account starts as before", async (_, args) => {
    const r = await spawn(args, [], rows)
    expect(r.code, r.err).toBe(0)
  })

  // a fresh install lists no Claude row, so a bare start has no order to follow and stays on this machine's own login
  test("a worker with no --account starts while usage.accounts lists no Claude row", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.code, r.err).toBe(0)
  })
})
