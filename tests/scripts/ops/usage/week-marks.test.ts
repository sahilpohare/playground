import { afterAll, expect, test } from "bun:test"
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scratchEnv } from "../../../scratch-env"

const script = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "ops",
  "usage",
  "week-marks.py",
)
const scratch = mkdtempSync(join(tmpdir(), "ops-week-marks-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// usage.accounts and clock.ownerZone as a stand-in bun on PATH answers them for the settings reader beat.py runs
const ACCOUNTS = [{ email: "login@example.test" }, { email: "spare@example.test" }]

// usage.json is read through ~/.claude/acme, a link to ~/.playground as on the Mac, and the marks and samples stay in the state folder
const setup = (
  name: string,
  week: number,
  fiveHour: number,
  accounts?: Record<
    string,
    {
      limitedUntil?: number
      readAt: string
      week: number
      weekReset: number
    }
  >,
  zone = "UTC",
) => {
  const home = join(scratch, name)
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  symlinkSync(join(script, "..", "..", "beat.py"), join(home, ".playground", "ops", "beat.py"))
  mkdirSync(join(home, "bin"))
  writeFileSync(
    join(home, "bin", "bun"),
    `#!/bin/bash\n[ "$2" = usage.accounts ] && echo '${JSON.stringify(ACCOUNTS)}'\n[ "$2" = clock.ownerZone ] && echo '${JSON.stringify(zone)}'\n[ "$2" = -e ] && echo '${join(home, ".playground")}'\nexit 0\n`,
  )
  chmodSync(join(home, "bin", "bun"), 0o755)
  const now = Date.now() / 1000
  writeFileSync(
    join(home, ".playground", "usage.json"),
    JSON.stringify({
      account: "login@example.test",
      ...(accounts && { accounts }),
      rate_limits: {
        five_hour: { resets_at: now + 3600, used_percentage: fiveHour },
        seven_day: { resets_at: now + 86400, used_percentage: week },
      },
    }),
  )
  return home
}

const samples = (home: string, file: string) => join(home, ".playground", "ops", "usage", file)

// One sample per account half an hour back, half a point lower, so each account reads 1%/h; the logged-in account's go to week-samples.jsonl, the others' to account-samples.jsonl
const history = (home: string, accounts: [string, number, number][]) => {
  const t = Date.now() / 1000 - 1800
  for (const [account, week, reset] of accounts)
    appendFileSync(
      samples(
        home,
        account === "login@example.test" ? "week-samples.jsonl" : "account-samples.jsonl",
      ),
      `${JSON.stringify({ account, reset, t, week: week - 0.5 })}\n`,
    )
}

const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")

// one run of the script under the scratch HOME, its output's lines
const run = (home: string) => {
  const env = scratchEnv(home, {
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  })
  const child = Bun.spawnSync(["python3", "-I", script], { env })
  expect(child.exitCode).toBe(0)
  return child.stdout.toString().split("\n")
}

const status = (home: string) => run(home)[0]

const alerts = (home: string) =>
  run(home)
    .filter((line) => line.startsWith("ALERT"))
    .map((line) => line.split(" ").slice(0, 2).join(" "))

test("a week past 90% and a 5-hour window past 85% each alert once", () => {
  const home = setup("high", 91, 86)
  expect(alerts(home)).toEqual(["ALERT 90", "ALERT 5h"])
  expect(alerts(home)).toEqual([])
})

// the owner's drain order: every account is used to 100%, where a seated second dispatcher switches, so no mark parks or stops work
test("the 97% and 98% alerts say nothing parks and a seated second dispatcher switches at 100%", () => {
  const home = setup("drain", 99, 20)
  const env = scratchEnv(home, {
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  })
  const out = Bun.spawnSync(["python3", "-I", script], { env }).stdout.toString()
  const lines = out.split("\n").filter((line) => /^ALERT 9[78] /.test(line))
  expect(lines).toHaveLength(2)
  for (const line of lines) {
    expect(line).toContain(
      "nothing parks: at 100% a seated second dispatcher switches the factory to the next account",
    )
    expect(line).not.toMatch(/push WIP|stops now/)
  }
})

// the zone's last midnight at or before now, in seconds
const midnight = (zone: string, now: number) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    second: "numeric",
    timeZone: zone,
  }).formatToParts(new Date(now * 1000))
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Math.floor(now) - (part("hour") * 3600 + part("minute") * 60 + part("second"))
}

// a sample a minute before the zone's midnight at 10% and one a minute after at 20%, so the day's spend to 50% is 30 only when the day turns at that midnight
for (const zone of ["UTC", "Asia/Kolkata"])
  test(`the day's spend counts from midnight in clock.ownerZone, at ${zone}`, () => {
    const now = Date.now() / 1000
    const home = setup(`day-${zone.replace("/", "-")}`, 50, 20, undefined, zone)
    const start = midnight(zone, now)
    for (const [t, week] of [
      [start - 60, 10],
      [start + 60, 20],
    ])
      appendFileSync(
        samples(home, "week-samples.jsonl"),
        `${JSON.stringify({ account: "login@example.test", reset: now + 86400, t, week })}\n`,
      )
    expect(status(home)).toContain("today 30% spent")
  })

// an offset the setting takes (Intl reads it) but zoneinfo does not still prints the line and its alerts, the day in UTC, and says why
test("a clock.ownerZone zoneinfo cannot read runs the day in UTC and says so", () => {
  const now = Date.now() / 1000
  const home = setup("day-offset", 91, 20, undefined, "+05:30")
  const start = midnight("UTC", now)
  for (const [t, week] of [
    [start - 60, 10],
    [start + 60, 20],
  ])
    appendFileSync(
      samples(home, "week-samples.jsonl"),
      `${JSON.stringify({ account: "login@example.test", reset: now + 86400, t, week })}\n`,
    )
  const line = status(home)
  expect(line).toContain("today 71% spent")
  expect(line).toEndWith("; clock.ownerZone +05:30 is no zone Python reads, so today runs in UTC")
  expect(alerts(setup("day-offset-alerts", 91, 20, undefined, "+05:30"))).toEqual(["ALERT 90"])
})

test("a reading under every mark alerts nothing", () => {
  expect(alerts(setup("low", 40, 20))).toEqual([])
})

test("the factory's accounts at 1%/h each read 2%/h combined", () => {
  const now = Date.now() / 1000
  const home = setup("two", 50, 20, {
    "spare@example.test": { readAt: iso(now), week: 30, weekReset: now + 172800 },
    "login@example.test": { readAt: iso(now), week: 50, weekReset: now + 86400 },
  })
  history(home, [
    ["login@example.test", 50, now + 86400],
    ["spare@example.test", 30, now + 172800],
  ])
  const line = status(home)
  expect(line).toContain("rate 1.0%/h over 1h")
  expect(line).toContain("; combined 2.0%/h across 2 accounts")
  const accounts = (file: string) =>
    [...readFileSync(samples(home, file), "utf8").matchAll(/"account": "([^"]+)"/g)].map(
      (m) => m[1],
    )
  expect(new Set(accounts("week-samples.jsonl"))).toEqual(new Set(["login@example.test"]))
  expect(new Set(accounts("account-samples.jsonl"))).toEqual(new Set(["spare@example.test"]))
})

// #2735: a whole-point step in the 1-hour window inflated the combined line; reading the 6-hour rate keeps it 1.0 plus 0.7, not 1.0 plus 2.0
test("a whole-point step in the 1-hour window reads the 6-hour rate, so the combined line does not inflate (#2735)", () => {
  const now = Date.now() / 1000
  const home = setup("step-2735", 50, 20, {
    "spare@example.test": { readAt: iso(now - 900), week: 70, weekReset: now + 172800 },
  })
  history(home, [["login@example.test", 50, now + 86400]])
  const second = [
    [10800, 68],
    [9900, 68],
    [9000, 68],
    [8100, 68],
    [7200, 68],
    [6300, 68],
    [5400, 68],
    [4500, 68],
    [3600, 69],
    [2700, 69],
    [1800, 70],
    [900, 70],
  ]
  for (const [back, week] of second)
    appendFileSync(
      samples(home, "account-samples.jsonl"),
      `${JSON.stringify({ account: "spare@example.test", reset: now + 172800, t: now - back, week })}\n`,
    )
  const line = status(home)
  expect(line).toContain("rate 1.0%/h over 1h")
  expect(line).toContain("; combined 1.7%/h across 2 accounts")
})

// #2735: under an hour of readings the 6-hour window holds no older reading, so a single step reads over the hour and its words name 1h, as before
test("a step under an hour of readings reads over 1h, not over 6h (#2735)", () => {
  const home = setup("sub-hour-step", 11, 20)
  readings(home, [
    [2700, 10],
    [1800, 10],
    [900, 11],
  ])
  expect(status(home)).toContain("rate 1.3%/h over 1h")
})

// #1587: a full week's reading parks in the map until its reset with a readAt that stops moving, so it counts 0%/h and the combined figure stays a number
test("a full-week account counts 0%/h, so the combined figure stays a number (#1587)", () => {
  const now = Date.now() / 1000
  const home = setup("full-week-spare", 50, 20, {
    "spare@example.test": { readAt: iso(now - 7200), week: 100, weekReset: now + 172800 },
  })
  history(home, [["login@example.test", 50, now + 86400]])
  expect(status(home)).toContain("; combined 1.0%/h across 2 accounts")
})

// #1587: an account limited below 100% parks the same way through fresh()'s limitedUntil line, so it counts 0%/h while its limit stands
test("an account limited below 100 counts 0%/h while its limit stands (#1587)", () => {
  const now = Date.now() / 1000
  const home = setup("limited-spare", 50, 20, {
    "spare@example.test": {
      limitedUntil: now + 7200,
      readAt: iso(now - 7200),
      week: 40,
      weekReset: now + 172800,
    },
  })
  history(home, [["login@example.test", 50, now + 86400]])
  expect(status(home)).toContain("; combined 1.0%/h across 2 accounts")
})

test("the spare account logged in counts as a factory account", () => {
  const home = setup("nd941z", 50, 20)
  const usage = join(home, ".playground", "usage.json")
  writeFileSync(
    usage,
    readFileSync(usage, "utf8").replace("login@example.test", "spare@example.test"),
  )
  expect(status(home)).toStartWith("spare@example.test: week 50%")
})

test("one account alone reads as before, with no combined pace", () => {
  const now = Date.now() / 1000
  const home = setup("one", 50, 20)
  history(home, [["login@example.test", 50, now + 86400]])
  const line = status(home)
  expect(line).toContain("rate 1.0%/h over 1h")
  expect(line).not.toContain("combined")
})

// the logged-in account's readings, each `[seconds back, week %]`, in this week
const readings = (home: string, rows: [number, number][]) => {
  const now = Date.now() / 1000
  for (const [back, week] of rows)
    appendFileSync(
      samples(home, "week-samples.jsonl"),
      `${JSON.stringify({ account: "login@example.test", reset: now + 86400, t: now - back, week })}\n`,
    )
}

// #2100: the whole-percent reading holds at 91% through the last hour while the week rose 5 points in 5 hours, so the line reads 1%/h over 6 hours and keeps the 98% time
test("a flat hour inside a rising week reads the 6-hour rate and names its window (#2100)", () => {
  const home = setup("flat-hour", 91, 20)
  readings(home, [
    [5 * 3600, 86],
    [50 * 60, 91],
  ])
  const lines = run(home)
  expect(lines[0]).toContain("rate 1.0%/h over 6h, 98% in ~7.0h;")
  expect(lines.find((line) => line.startsWith("ALERT 90"))).toContain(
    "burning 1.0%/h over 6h, 98% in ~7.0h",
  )
})

// #2100: a reading that held through every window with data reads as under one point over the span it covers, rounded up, never 0.0%/h
test("a reading flat through every window reads under one point over its span (#2100)", () => {
  const home = setup("flat-all", 50, 20)
  readings(home, [[45 * 60, 50]])
  const line = status(home)
  expect(line).toContain("rate under 1.4%/h over 45m;")
  expect(line).not.toContain("0.0%/h")
})

// #2100: two accounts flat for 45 minutes each read under 1.4%/h, so their combined pace is a bound too
test("a combined pace holding a flat account reads as under the sum of the bounds (#2100)", () => {
  const now = Date.now() / 1000
  const home = setup("flat-combined", 50, 20, {
    "spare@example.test": { readAt: iso(now), week: 30, weekReset: now + 172800 },
  })
  readings(home, [[45 * 60, 50]])
  appendFileSync(
    samples(home, "account-samples.jsonl"),
    `${JSON.stringify({ account: "spare@example.test", reset: now + 172800, t: now - 45 * 60, week: 30 })}\n`,
  )
  const line = status(home)
  expect(line).toContain("; combined under 2.8%/h across 2 accounts")
  expect(line).not.toContain("0.0%/h")
})

test("an account usage.accounts does not list counts nothing", () => {
  const home = setup("other", 95, 90)
  const usage = join(home, ".playground", "usage.json")
  writeFileSync(
    usage,
    readFileSync(usage, "utf8").replace("login@example.test", "other@example.test"),
  )
  expect(status(home)).toStartWith("other@example.test: not a factory account; nothing counted")
})

// #152: a spare account's own week crosses the marks too, once per its own week reset, while the logged-in account sits below them
test("a spare account at 97% alerts once per its week reset, with the logged-in account below 90% (#152)", () => {
  const now = Date.now() / 1000
  const spare = (weekReset: number) => ({
    "spare@example.test": { readAt: iso(now), week: 97, weekReset },
  })
  const home = setup("spare-97", 50, 20, spare(now + 172800))
  const marks = () => {
    const env = scratchEnv(home, {
      PATH: `${join(home, "bin")}:${process.env.PATH}`,
    })
    const child = Bun.spawnSync(["python3", "-I", script], { env })
    expect(child.exitCode).toBe(0)
    return child.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("ALERT"))
      .map((line) => line.split(" ").slice(0, 3).join(" "))
  }
  expect(marks()).toEqual(["ALERT 90 spare@example.test:", "ALERT 97 spare@example.test:"])
  expect(marks()).toEqual([])
  const usage = join(home, ".playground", "usage.json")
  writeFileSync(
    usage,
    JSON.stringify({
      ...JSON.parse(readFileSync(usage, "utf8")),
      accounts: spare(now + 172800 + 7 * 86400),
    }),
  )
  expect(marks()).toEqual(["ALERT 90 spare@example.test:", "ALERT 97 spare@example.test:"])
})

test("a listed spare's marks fire while the logged-in account is outside usage.accounts (#152)", () => {
  const now = Date.now() / 1000
  const home = setup("spare-foreign-login", 50, 20, {
    "spare@example.test": { readAt: iso(now), week: 97, weekReset: now + 172800 },
  })
  const usage = join(home, ".playground", "usage.json")
  writeFileSync(
    usage,
    readFileSync(usage, "utf8").replace(
      '"account":"login@example.test"',
      '"account":"other@example.test"',
    ),
  )
  const env = scratchEnv(home, {
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
  })
  const run = () => Bun.spawnSync(["python3", "-I", script], { env }).stdout.toString().split("\n")
  const lines = run()
  expect(lines[0]).toStartWith("other@example.test: not a factory account")
  expect(
    lines
      .filter((line) => line.startsWith("ALERT"))
      .map((line) => line.split(" ").slice(0, 3).join(" ")),
  ).toEqual(["ALERT 90 spare@example.test:", "ALERT 97 spare@example.test:"])
  expect(run().filter((line) => line.startsWith("ALERT"))).toEqual([])
})

test("an unlisted login with only a 5-hour window still lets a listed spare's marks fire", () => {
  const now = Date.now() / 1000
  const home = setup("spare-foreign-login-no-week", 50, 20, {
    "spare@example.test": { readAt: iso(now), week: 97, weekReset: now + 172800 },
  })
  const usage = join(home, ".playground", "usage.json")
  const data = JSON.parse(readFileSync(usage, "utf8"))
  data.account = "other@example.test"
  delete data.rate_limits.seven_day
  writeFileSync(usage, JSON.stringify(data))
  expect(alerts(home)).toEqual(["ALERT 90", "ALERT 97"])
})
