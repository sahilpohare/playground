import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"

import {
  capacityLog,
  lw,
  minutesAgo,
  offUntil,
  offUntilUtc,
  placing,
  root,
  spawn,
  usage,
  weekAt,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("the capacity gate refuses and spawns nothing", () => {
  const SPARE_SKIPPED =
    "skipped (--account spare@example.com: this machine holds no usage-spare.json for it under 60 minutes old, which the ops tick's other-logins beat writes)"
  const capResetsAt = new Date(Date.now() + 3_600_000)
  // Each row builds its file inside the test, so no stamp is older than the moment the case runs.
  const claudeUsageRefusals: [string, () => string, ...string[]][] = [
    [
      "usage.json unreadable",
      () => "{ nope",
      "the usage gate holds it: it cannot read",
      "usage.json (does not read)",
    ],
    [
      "usage.json stale",
      () => JSON.stringify(usage({ writtenAt: minutesAgo(16) })),
      "the usage gate holds it: usage.json was written 16 minutes ago (writtenAt), 15 is its limit",
      "The ops-usage job writes it every 5 minutes; wait for its next run and try again.",
    ],
    [
      "the 5-hour window at its cap",
      () =>
        JSON.stringify(
          usage({
            rate_limits: {
              five_hour: { used_percentage: 90, resets_at: capResetsAt.toISOString() },
              seven_day: {
                used_percentage: 20,
                resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
              },
            },
          }),
        ),
      "the usage gate holds it: the 5-hour window is at 90% (usage.json five_hour.used_percentage), 90 is its cap",
      `. It resets ${capResetsAt.toISOString().slice(11, 16)} UTC.`,
    ],
    [
      "the week past its pace",
      () =>
        JSON.stringify(
          usage({
            rate_limits: {
              five_hour: {
                used_percentage: 10,
                resets_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
              seven_day: {
                used_percentage: 29,
                resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
              },
            },
          }),
        ),
      "the usage gate holds it: the week is at 29% (usage.json seven_day.used_percentage), past 14.3 points a day (2.0 days in, 28.6 is its pace)",
    ],
    [
      "no week share",
      () => JSON.stringify(usage({ rate_limits: { five_hour: usage().rate_limits.five_hour } })),
      "the usage gate holds it: usage.json holds no week share",
    ],
  ]
  for (const [name, raw, ...says] of claudeUsageRefusals) {
    test(`Claude usage: ${name} is refused`, async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { USAGE_JSON: raw() })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      for (const fragment of says) expect(r.err).toContain(fragment)
      // the row carries the words the refusal printed, so the log alone names why
      const detail = r.err.match(/the usage gate holds it: (.*)/)?.[1]
      expect(capacityLog(r)).toEqual([
        expect.objectContaining({ detail, gate: "usage", verdict: "refused" }),
      ])
    })
  }

  // A fresh install has no usage.json until its usage job first runs, which nothing in the app starts: a file never written passes every start, the dispatcher's and each worker's it starts, and its row says so; one that exists still has to read, be fresh and be under its limits.
  test.each([
    ["a worker", ["worker", "worker-brave-otter", "b.md"]],
    ["the dispatcher", ["manager", "dispatcher", "b.md"]],
  ])("Claude usage: %s starts while usage.json has never been written", async (_, args) => {
    const r = await spawn(args, [], { USAGE_JSON: "absent" })
    expect(r.err).not.toContain("the usage gate holds it")
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        gate: null,
        readings: expect.objectContaining({ usage: "unread (usage.json not yet written)" }),
        verdict: "pass",
      }),
    ])
  })

  test("a session on --account with no usage.json and no usage-spare.json skips the usage check", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "spare@example.com"],
      [],
      { USAGE_JSON: "absent" },
    )
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          usage: SPARE_SKIPPED,
        }),
        verdict: "pass",
      }),
    ])
  })

  // The week-pace override: a future time in usage-pace-off-until lets a week past its pace through,
  // the 5-hour cap and a 98% sanity backup still hold, and anything else leaves the pace check on.
  // offUntil written as OLD.dispatcher would (IST).
  const offUntilIst = `${new Date(offUntil.getTime() + 19_800_000).toISOString().slice(0, 19)}+05:30`
  const paceMessage =
    "the usage gate holds it: the week is at 29% (usage.json seven_day.used_percentage), past 14.3 points a day (2.0 days in, 28.6 is its pace)"

  test("Claude usage: a future pace-off time lets a week past its pace through, and the pass line names the skip", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      PACE_OFF_UNTIL: `${offUntilIst}\n`,
      USAGE_JSON: weekAt(29),
    })
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        verdict: "pass",
        readings: expect.objectContaining({
          pace: `skipped until ${offUntilUtc} (usage-pace-off-until)`,
          week: 29,
        }),
      }),
    ])
  })

  // the pace never sits below one day's share, so a week that has just reset is not refused for its first points.
  test("Claude usage: a week at 2% that reset 0.1 days ago passes, on its first day's share", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      USAGE_JSON: weekAt(2, 10, 0.1),
    })
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
  })

  test("Claude usage: a week at 30% one day in is still refused, past that first day's share", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      USAGE_JSON: weekAt(30, 10, 1),
    })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the usage gate holds it: the week is at 30% (usage.json seven_day.used_percentage), past 14.3 points a day (1.0 days in, 14.3 is its pace)",
    )
  })

  const paceStaysOn: { label: string; until?: string }[] = [
    { label: "a past time", until: `${new Date(Date.now() - 60_000).toISOString().slice(0, 19)}Z` },
    { label: "a missing file" },
    { label: "an empty file", until: "" },
    { label: "a time that does not parse", until: "Tuesday 21:29 IST" },
    { label: "a time with no zone", until: offUntilUtc.slice(0, 19) },
  ]
  for (const { label, until } of paceStaysOn) {
    test(`Claude usage: the week past its pace is still refused with ${label} in usage-pace-off-until`, async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        ...(until === undefined ? {} : { PACE_OFF_UNTIL: until }),
        USAGE_JSON: weekAt(29),
      })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(paceMessage)
    })
  }

  test("Claude usage: the 5-hour cap still refuses at 90% with a future pace-off time", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      PACE_OFF_UNTIL: offUntilUtc,
      USAGE_JSON: weekAt(29, 90),
    })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the usage gate holds it: the 5-hour window is at 90% (usage.json five_hour.used_percentage), 90 is its cap",
    )
  })

  test("Claude usage: with a future pace-off time, a week at 97.9% passes and one at 98% meets the sanity backup", async () => {
    const under = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      PACE_OFF_UNTIL: offUntilUtc,
      USAGE_JSON: weekAt(97.9),
    })
    expect(under.code).toBe(0)
    expect(placing(under)).not.toEqual([])
    const at = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      PACE_OFF_UNTIL: offUntilUtc,
      USAGE_JSON: weekAt(98),
    })
    expect(at.code).not.toBe(0)
    expect(placing(at)).toEqual([])
    expect(at.err).toContain(
      `the usage gate holds it: the week is at 98% (usage.json seven_day.used_percentage), and 98% is the sanity backup while the pace check is off until ${offUntilUtc} (usage-pace-off-until)`,
    )
  })

  // A resume of a live row, or of one spawn.sh closed live in the last 15 minutes, brings back work already running, so the 98% backstop alone holds it; an ended row's resume and a fresh start still meet the pace line.
  const ID = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"
  const RESUMED = "t4n7vx-worker"
  const roster = (status: string) =>
    JSON.stringify({ agents: [{ name: RESUMED, role: "worker", status, task: "t" }] })
  const resume = (status: string, week: number, setup?: (home: string) => void) =>
    spawn(
      ["resume", RESUMED, root, ID],
      [],
      { ROSTER_JSON: roster(status), USAGE_JSON: weekAt(week) },
      undefined,
      { name: RESUMED, backend: "claude" },
      setup,
    )
  const closedMinutesAgo = (minutes: number) => (home: string) => {
    mkdirSync(lw(home, "closes"), { recursive: true })
    const at = new Date(Date.now() - minutes * 60_000)
    writeFileSync(
      lw(home, "closes", RESUMED),
      `${Math.floor(at.getTime() / 1000)} ${at.toISOString().slice(0, 19)}Z working\n`,
    )
  }
  const RESUME_PACE = "skipped (a resume of a live session: the 98% backstop alone)"

  test.each([
    ["a live row", () => resume("working", 29)],
    ["a row spawn.sh closed live 2 minutes ago", () => resume("ended", 29, closedMinutesAgo(2))],
  ])("Claude usage: a resume of %s passes a week past its pace", async (_, run) => {
    const r = await run()
    expect(r.err).not.toContain("the usage gate holds it")
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ pace: RESUME_PACE, week: 29 }),
        verdict: "pass",
      }),
    ])
  })

  test("Claude usage: a resume of a live row at 98% meets the backstop", async () => {
    const r = await resume("working", 98)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the usage gate holds it: the week is at 98% (usage.json seven_day.used_percentage), and 98% is the sanity backup for a resume of a live session",
    )
  })

  test.each([
    ["a resume of an ended row", () => resume("ended", 29)],
    ["a fresh start", () => spawn(["worker", RESUMED, "b.md"], [], { USAGE_JSON: weekAt(29) })],
  ])("Claude usage: %s still meets the pace line", async (_, run) => {
    const r = await run()
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(paceMessage)
  })

  test("a session on --account skips usage.json, whose readings name another login", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "spare@example.com"],
      [],
      { USAGE_JSON: JSON.stringify(usage({ writtenAt: minutesAgo(16) })) },
    )
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        verdict: "pass",
        readings: expect.objectContaining({
          usage: SPARE_SKIPPED,
        }),
      }),
    ])
  })

  // --account spare@example.com is judged on its own usage-spare.json, which the ops tick's other-logins beat writes every 30 minutes, at a bare start's pace while under 60 minutes old.
  const spareWeek = (week: number, written = minutesAgo(10)) =>
    JSON.stringify({
      ...JSON.parse(weekAt(week)),
      account: "spare@example.com",
      writtenAt: written,
    })
  const onSpare = (env: Record<string, string>) =>
    spawn(["worker", "worker-brave-otter", "b.md", "--account", "spare@example.com"], [], env)

  test("a session on --account with a fresh usage-spare.json past its pace is refused", async () => {
    const r = await onSpare({ SPARE_USAGE_JSON: spareWeek(29) })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the usage gate holds it: --account spare@example.com: the week is at 29% (usage-spare.json seven_day.used_percentage), past 14.3 points a day (2.0 days in, 28.6 is its pace)",
    )
  })

  test("a session on --account with a fresh usage-spare.json under its pace starts, and its row reads that week", async () => {
    const r = await onSpare({ SPARE_USAGE_JSON: spareWeek(20) })
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({ readings: expect.objectContaining({ week: 20 }), verdict: "pass" }),
    ])
  })

  test("a session on --account with a fresh usage-spare.json past its pace starts while the pace check is off", async () => {
    const r = await onSpare({ PACE_OFF_UNTIL: offUntilUtc, SPARE_USAGE_JSON: spareWeek(29) })
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          pace: `skipped until ${offUntilUtc} (usage-pace-off-until)`,
        }),
        verdict: "pass",
      }),
    ])
  })

  test.each([
    ["60 minutes old", () => spareWeek(29, minutesAgo(60))],
    [
      "naming another account",
      () => JSON.stringify({ ...JSON.parse(spareWeek(29)), account: "spare@other.example" }),
    ],
    ["that does not read", () => "{ nope"],
  ])(
    "a session on --account with a usage-spare.json %s past its pace skips the usage check",
    async (_, raw) => {
      const r = await onSpare({ SPARE_USAGE_JSON: raw() })
      expect(r.code).toBe(0)
      expect(capacityLog(r)).toEqual([
        expect.objectContaining({
          readings: expect.objectContaining({ usage: SPARE_SKIPPED }),
          verdict: "pass",
        }),
      ])
    },
  )
})
