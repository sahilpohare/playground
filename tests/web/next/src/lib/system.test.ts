import { describe, expect, test } from "bun:test"

import {
  accountLine,
  burnOf,
  byWeekReset,
  checkoutLabel,
  clusterOf,
  combinedUsage,
  diskValue,
  glanceReadings,
  isStale,
  levelOf,
  loadLabel,
  memoryLevel,
  nextMonthDay,
  paceOf,
  READING_LEVELS,
  renewRows,
  resetLabel,
  roomLeft,
  shareOf,
  sizeLabel,
  slotLabel,
  spokenReadings,
  systemHealth,
  systemReadings,
  updateHint,
  updateHover,
  updateMessage,
  usageLine,
  usageRows,
  weekPace,
  zaiReadings,
} from "../../../../../web/next/src/lib/system"
import { messageTime } from "../../../../../web/next/src/lib/time"

type SystemReport = Parameters<typeof systemReadings>[0]

const GB = 1024 ** 3
const MB = 1024 ** 2

describe("sizeLabel", () => {
  test("GB from one up, whole MB below, a dash for unknown", () => {
    expect(sizeLabel(1.3 * GB)).toBe("1.3 GB")
    expect(sizeLabel(GB)).toBe("1.0 GB")
    expect(sizeLabel(350 * MB)).toBe("350 MB")
    expect(sizeLabel(0)).toBe("0 MB")
    expect(sizeLabel(null)).toBe("-")
  })
})

describe("checkoutLabel", () => {
  test("a worktree by its name, anything else by its last two folders", () => {
    expect(checkoutLabel("/Users/you/dispatcher/.claude/worktrees/canary")).toBe("canary")
    expect(checkoutLabel("/Users/you/dispatcher/.claude/worktrees/canary/api/hono")).toBe("canary")
    expect(checkoutLabel("/Users/you/acme/archive")).toBe("acme/archive")
    expect(checkoutLabel("unknown")).toBe("unknown")
  })
})

describe("shareOf", () => {
  test("a whole percent, held between 0 and 100, and 0 with no total or no part", () => {
    expect(shareOf(17.9 * GB, 24 * GB)).toBe(75)
    expect(shareOf(30, 15)).toBe(100)
    expect(shareOf(null, 24)).toBe(0)
    expect(shareOf(5, 0)).toBe(0)
  })
})

describe("isStale", () => {
  test("a report older than 90s means sampling has stopped", () => {
    const now = Date.parse("2026-10-06T08:31:31Z")
    expect(isStale("2026-10-06T08:30:00Z", now)).toBe(true)
    expect(isStale("2026-10-06T08:30:30Z", now)).toBe(false)
  })
})

describe("usage", () => {
  const now = new Date(2026, 9, 6, 14, 0).getTime()
  const today = new Date(2026, 9, 6, 18, 30).toISOString()
  const monday = new Date(2026, 9, 12, 20, 30).toISOString()

  test("resetLabel: a time today, a weekday and time later", () => {
    expect(resetLabel(today, now, "en-US")).toBe("6:30 PM")
    expect(resetLabel(monday, now, "en-US")).toBe("Mon 8:30 PM")
  })

  test("usageLine: each window's whole share, reset and how long ago its file was written, or why there is none", () => {
    const line = usageLine(
      {
        fiveHour: { resetsAt: today, usedPercent: 23.6 },
        sevenDay: { resetsAt: null, usedPercent: 21 },
        stale: false,
        writtenAt: new Date(now - 2 * 60_000).toISOString(),
      },
      now,
    )
    expect(line).toMatch(
      /^24% of the 5-hour window, resets .+, read 2 min\. ago · 21% of the week, read 2 min\. ago$/,
    )
    expect(usageLine(null, now)).toBe("No reading yet: the usage job writes it every 5 minutes")
  })

  test("usageLine: a window the file no longer holds says when it was last seen, not when the file was written", () => {
    const line = usageLine(
      {
        fiveHour: {
          resetsAt: new Date(2026, 9, 6, 13, 0).toISOString(),
          seenAt: new Date(now - 2 * 3600_000).toISOString(),
          usedPercent: 40,
        },
        sevenDay: { resetsAt: null, usedPercent: 21 },
        stale: false,
        writtenAt: new Date(now - 5 * 60_000).toISOString(),
      },
      now,
    )
    expect(line).toMatch(
      /^40% of the 5-hour window, stale, reset .+, last seen 2 hr\. ago · 21% of the week, read 5 min\. ago$/,
    )
  })
})

// A calm machine 3 days into its week, every reading under its warning level: 25% used of a 27% pace.
export const NOW = Date.parse("2026-10-06T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

export const calm = (patch: (r: SystemReport) => void = () => {}): SystemReport => {
  const report = {
    account: null,
    accounts: [],
    agents: [],
    capacity: {
      idle: { bytes: 0, line: null, ready: true, stacks: [] },
      limitedBy: "memory",
      line: "Room for ~3 more workers, by memory",
      orchestrators: {
        count: 6,
        limitedBy: "memory",
        line: "Room for ~6 more orchestrators, by memory",
      },
      perOrchestrator: { bytes: 0.6 * GB, cores: 0.1 },
      perWorker: { bytes: 1.3 * GB, cores: 1 },
      workers: 3,
    },
    cpu: { cores: 15, load: [6.43, 5, 4] },
    detached: [],
    disk: { freeBytes: 729.4 * GB, totalBytes: 994 * GB },
    docker: { containers: [], problem: null, vmBytes: 2 * GB },
    history: [],
    machines: [],
    memory: {
      freePercent: 40,
      pressure: "normal",
      swap: { totalBytes: 10 * GB, usedBytes: 2 * GB },
      totalBytes: 48 * GB,
      usedBytes: 28.8 * GB,
    },
    platform: "darwin",
    problems: [],
    pulls: null,
    sampledAt: new Date(NOW - 10_000).toISOString(),
    update: null,
    usage: {
      fiveHour: { resetsAt: new Date(NOW + 2 * 3600_000).toISOString(), usedPercent: 26.2 },
      sevenDay: { resetsAt: new Date(NOW + 4 * DAY).toISOString(), usedPercent: 25 },
      stale: false,
      writtenAt: new Date(NOW - 5000).toISOString(),
    },
    zai: null,
  } as SystemReport
  patch(report)
  return report
}

describe("weekPace", () => {
  test("9 points a day from the window's start, held to the week, null with no reset", () => {
    expect(weekPace({ resetsAt: new Date(NOW + 4 * DAY).toISOString(), usedPercent: 0 }, NOW)).toBe(
      27,
    )
    expect(weekPace({ resetsAt: new Date(NOW + 7 * DAY).toISOString(), usedPercent: 0 }, NOW)).toBe(
      0,
    )
    expect(weekPace({ resetsAt: new Date(NOW - DAY).toISOString(), usedPercent: 0 }, NOW)).toBe(63)
    expect(weekPace({ resetsAt: null, usedPercent: 0 }, NOW)).toBeNull()
    expect(weekPace(null, NOW)).toBeNull()
  })
})

type Key = keyof typeof READING_LEVELS

// Each reading set to a value: memory and swap as a share used, CPU as the 5-minute load a core, disk as GB free, the windows as a share used.
const setReading: Record<Key | "memory", (r: SystemReport, value: number) => void> = {
  cpu: (r, value) => void (r.cpu.load = [1, value * r.cpu.cores, 1]),
  disk: (r, value) => void (r.disk = { freeBytes: value * GB, totalBytes: 994 * GB }),
  fiveHour: (r, value) => void (r.usage!.fiveHour!.usedPercent = value),
  memory: (r, value) => void (r.memory.usedBytes = (value / 100) * r.memory.totalBytes),
  swap: (r, value) =>
    void (r.memory.swap = { totalBytes: 10 * GB, usedBytes: (value / 100) * 10 * GB }),
  week: (r, value) => void (r.usage!.sevenDay!.usedPercent = value),
}

// The week's reset is dropped so its pace, a rule of its own, stays out of the table's cases.
const levelFor = (key: Key, value: number) =>
  systemReadings(
    calm((r) => {
      setReading[key](r, value)
      r.usage!.sevenDay!.resetsAt = null
    }),
    NOW,
  ).find((reading) => reading.key === key)?.level

// Below, at the warning level, past it, at the critical level and past it, per reading: green, green, orange, orange, red.
const cases: Record<Key, [number, number, number, number, number]> = {
  cpu: [0.5, 0.8, 0.9, 1, 1.2],
  disk: [100, 50, 40, 20, 10],
  fiveHour: [50, 70, 80, 90, 95],
  swap: [85, 90, 93, 97, 99],
  week: [20, 70, 75, 90, 95],
}

describe("READING_LEVELS", () => {
  test("one row per reading the System readings show but memory, which its pressure judges", () => {
    expect(Object.keys(READING_LEVELS).sort()).toEqual(Object.keys(cases).sort())
  })

  for (const key of Object.keys(cases) as Key[]) {
    test(`${key}: green below its warning level and at it, orange past it, red past its critical level`, () => {
      const [below, atWarn, warn, atCritical, critical] = cases[key]
      expect(levelFor(key, below)).toBe("green")
      expect(levelFor(key, atWarn)).toBe("green")
      expect(levelFor(key, warn)).toBe("amber")
      expect(levelFor(key, atCritical)).toBe("amber")
      expect(levelFor(key, critical)).toBe("red")
    })
  }

  test("levelOf says where a value sits in words, against the warning or the critical level it crossed", () => {
    expect(levelOf("fiveHour", 61, "5-hour window 61% used")).toEqual({
      hit: null,
      words: "5-hour window 61% used, below the 70% warning level",
    })
    expect(levelOf("swap", 92, "Swap 92% used").words).toBe(
      "Swap 92% used, over the 90% warning level",
    )
    expect(levelOf("disk", 15, "Disk 15 GB free")).toEqual({
      hit: { level: "red", reason: "Disk 15 GB free, under the 20 GB critical level" },
      words: "Disk 15 GB free, under the 20 GB critical level",
    })
    expect(levelOf("disk", 196, "Disk 196 GB free").words).toBe(
      "Disk 196 GB free, above the 50 GB warning level",
    )
  })
})

describe("systemReadings", () => {
  test("a calm machine shows every reading, in a fixed order, all green, each in words", () => {
    const readings = systemReadings(calm(), NOW)
    expect(readings.map((r) => `${r.key} ${r.value} ${r.level}`)).toEqual([
      "memory 60 green",
      "cpu 5.0 green",
      "swap 20 green",
      "disk 729 green",
      "week 25 green",
      "fiveHour 26 green",
    ])
    expect(readings.map((r) => r.title)).toEqual([
      "Memory 60% used, pressure normal",
      "Load 5.0 on 15 cores, 5 min., below the 0.8 a core warning level",
      "Swap 20% used, below the 90% warning level",
      "Disk 729 GB free, above the 50 GB warning level",
      expect.stringMatching(/^Week 25% used, below the 70% warning level, resets /),
      expect.stringMatching(/^5-hour window 26% used, below the 70% warning level, resets /),
    ])
    // its own tooltip's three lines: the name, the measure, then its level or reset
    expect(readings.map((r) => [r.name, r.measure, r.state])).toEqual([
      ["Memory", "60% used", "pressure normal"],
      ["Load", "5.0 on 15 cores, 5 min.", "below the 0.8 a core warning level"],
      ["Swap", "20% used", "below the 90% warning level"],
      ["Disk", "729 GB free", "above the 50 GB warning level"],
      ["Week", "25% used", expect.stringMatching(/^below the 70% warning level, resets /)],
      ["5-hour window", "26% used", expect.stringMatching(/^below the 70% warning level, resets /)],
    ])
    expect(readings.every((r) => r.reasons.length === 0)).toBe(true)
  })

  test("memory takes its colour from the memory pressure alone: normal green, warn orange, critical red, whatever its share or free memory", () => {
    const memory = (patch: (r: SystemReport) => void) =>
      systemReadings(calm(patch), NOW).find((r) => r.key === "memory")!
    const full = memory((r) => {
      setReading.memory(r, 95)
      r.memory.freePercent = 5
    })
    expect(full).toMatchObject({ level: "green", title: "Memory 95% used, pressure normal" })
    expect(memory((r) => void (r.memory.pressure = "warn"))).toMatchObject({
      level: "amber",
      measure: "60% used",
      reasons: ["Memory pressure warn, 60% used"],
      state: "pressure warn",
    })
    expect(memory((r) => void (r.memory.pressure = "critical"))).toMatchObject({
      level: "red",
      reasons: ["Memory pressure critical, 60% used"],
    })
    const unread = memory((r) => {
      r.memory.usedBytes = null
      r.memory.pressure = "critical"
    })
    expect(unread).toMatchObject({ level: "red", value: "-" })
  })

  test("the week turns orange over its pace, under its warning level, and its tooltip's state says why", () => {
    const week = systemReadings(
      calm((r) => void (r.usage!.sevenDay!.usedPercent = 30)),
      NOW,
    ).find((r) => r.key === "week")!
    expect(week.level).toBe("amber")
    expect(week.reasons).toEqual(["Week 30% used, over the 27% pace"])
    // a rule outside the table joins the state line, after the table's own words
    expect(week.state).toBe(
      "below the 70% warning level, resets Sat 12:00 PM, read just now; over the 27% pace",
    )
  })

  test("a window is judged by the share it shows, so 70.4% reads 70 and green, never over the 70% level", () => {
    const readings = systemReadings(
      calm((r) => {
        r.usage!.fiveHour!.usedPercent = 70.4
        r.usage!.sevenDay!.usedPercent = 90.4
      }),
      NOW,
    )
    expect(readings.find((r) => r.key === "fiveHour")).toMatchObject({
      level: "green",
      value: "70",
    })
    expect(readings.find((r) => r.key === "week")).toMatchObject({ level: "amber", value: "90" })
  })

  test("each live usage window says how long ago its file was written", () => {
    const readings = systemReadings(
      calm((r) => {
        r.usage!.writtenAt = new Date(NOW - 2 * 60_000).toISOString()
      }),
      NOW,
    )
    expect(readings.find((r) => r.key === "fiveHour")?.title).toMatch(
      /^5-hour window 26% used, below the 70% warning level, resets .+, read 2 min\. ago$/,
    )
    expect(readings.find((r) => r.key === "week")?.title).toMatch(
      /^Week 25% used, below the 70% warning level, resets .+, read 2 min\. ago$/,
    )
  })

  test("a window the file no longer holds keeps its last reading, marked stale and judged by nothing, with when it was last seen", () => {
    const readings = systemReadings(
      calm((r) => {
        r.usage!.fiveHour = {
          resetsAt: null,
          seenAt: new Date(NOW - 2 * 3600_000).toISOString(),
          usedPercent: 74,
        }
      }),
      NOW,
    )
    expect(readings.find((r) => r.key === "fiveHour")).toEqual({
      key: "fiveHour",
      level: "green",
      measure: "74% used",
      name: "5-hour window",
      reasons: [],
      stale: true,
      state: "stale; last seen 2 hr. ago, the usage job has not written it since",
      title:
        "5-hour window 74% used, stale; last seen 2 hr. ago, the usage job has not written it since",
      value: "74",
    })
    expect(readings.find((r) => r.key === "week")?.stale).toBeUndefined()
  })

  test("a reading that could not be read is left out", () => {
    const blank = calm((r) => {
      r.usage = null
      r.memory.swap = null
      r.memory.usedBytes = null
      r.disk = null
    })
    expect(systemReadings(blank, NOW).map((r) => r.key)).toEqual(["cpu"])
  })
})

describe("memoryLevel", () => {
  test("judges nothing when the pressure is unknown, and says when the share could not be read", () => {
    expect(memoryLevel(null, 60)).toEqual({ hit: null, words: "Memory 60% used" })
    expect(memoryLevel("normal", null)).toEqual({
      hit: null,
      words: "Memory used could not be read",
    })
    expect(memoryLevel("critical", null).hit).toEqual({
      level: "red",
      reason: "Memory pressure critical",
    })
  })
})

describe("diskValue", () => {
  test("whole GB below 1000 and whole TB from there, so it keeps to three characters", () => {
    expect(diskValue(9)).toBe("9")
    expect(diskValue(729)).toBe("729")
    expect(diskValue(999)).toBe("999")
    expect(diskValue(1000)).toBe("1T")
    expect(diskValue(1900)).toBe("2T")
    for (const gb of [0, 42, 999, 1000, 4096, 50_000]) expect(diskValue(gb).length).toBeLessThan(4)
  })
})

// One account's usage file as the API reads it, written `ago` before NOW, so past ten minutes it is stale.
const accountUsage = (account: string, week: number, fiveHour: number, ago = 5000) => ({
  account,
  usage: {
    fiveHour: { resetsAt: new Date(NOW + 2 * 3600_000).toISOString(), usedPercent: fiveHour },
    sevenDay: { resetsAt: new Date(NOW + 4 * DAY).toISOString(), usedPercent: week },
    stale: ago > 10 * 60_000,
    writtenAt: new Date(NOW - ago).toISOString(),
  },
})

export const FIVE = [
  accountUsage("main@example.com", 97, 40),
  accountUsage("ada@example.com", 88, 30),
  accountUsage("bo@example.com", 76, 20),
  accountUsage("cy@example.com", 31, 10),
  accountUsage("di@example.com", 23, 5),
]

const withAccounts = (accounts: SystemReport["accounts"]) =>
  calm((r) => void (r.accounts = accounts))

// The GLM plan's credit windows as the API reads zai-usage.json, `used` out of 100 credits each, written `ago` before NOW, so past ten minutes they are stale.
export const glm = (
  week: number,
  fiveHour: number,
  ago = 60_000,
): NonNullable<SystemReport["zai"]> => ({
  fiveHour: { cap: 100, resetsAt: new Date(NOW + 2 * 3600_000).toISOString(), used: fiveHour },
  stale: ago > 10 * 60_000,
  week: { cap: 100, resetsAt: new Date(NOW + 6 * DAY).toISOString(), used: week },
  writtenAt: new Date(NOW - ago).toISOString(),
})

// GLM usage shows as Claude usage does.
describe("zaiReadings", () => {
  test("the week, then the 5-hour window, each its credits' share judged by the Claude windows' levels", () => {
    const [week, fiveHour] = zaiReadings(glm(5, 41), NOW)
    expect([week?.key, fiveHour?.key]).toEqual(["week", "fiveHour"])
    expect([week?.value, fiveHour?.value]).toEqual(["5", "41"])
    expect([week?.level, fiveHour?.level]).toEqual(["green", "green"])
    expect(zaiReadings(glm(75, 95), NOW).map((r) => r.level)).toEqual(["amber", "red"])
    expect(zaiReadings(glm(95, 75), NOW).map((r) => r.level)).toEqual(["red", "amber"])
  })

  test("each names GLM, so it never reads as Claude's", () => {
    const readings = zaiReadings(glm(5, 41), NOW)
    expect(readings.map((r) => r.name)).toEqual(["GLM week", "GLM 5-hour window"])
    for (const r of readings) expect(r.title).toStartWith(`${r.name} `)
    expect(readings[1]?.title).toContain("read 1 min. ago")
  })

  test("the week is orange over its pace, as Claude's is", () => {
    const [week] = zaiReadings(glm(20, 0), NOW)
    expect(week?.level).toBe("amber")
    expect(week?.title).toContain("; GLM week 20% used, over the 9% pace")
  })

  test("a file the job stopped writing reads stale: its last shares, gray, judging nothing", () => {
    const readings = zaiReadings(glm(95, 95, 20 * 60_000), NOW)
    expect(readings.map((r) => r.value)).toEqual(["95", "95"])
    for (const r of readings) {
      expect(r.stale).toBe(true)
      expect(r.level).toBe("green")
      expect(r.reasons).toEqual([])
      expect(r.title).toContain("stale")
      expect(r.title).toContain("last seen 20 min. ago")
    }
  })

  test("a window the job could not read is left out, and no file reads nothing", () => {
    expect(zaiReadings({ ...glm(5, 41), week: null }, NOW).map((r) => r.key)).toEqual(["fiveHour"])
    expect(zaiReadings(null, NOW)).toEqual([])
  })
})

// the owner on the Week tooltip's account lines: "sort be reset date?"
describe("byWeekReset", () => {
  // an account whose week resets `days` after NOW, or has no reset time (null) or no week reading (undefined)
  const resetting = (account: string, days: number | null | undefined) => {
    const a = accountUsage(account, 50, 10)
    return {
      ...a,
      usage: {
        ...a.usage,
        sevenDay:
          days === undefined
            ? null
            : {
                resetsAt: days === null ? null : new Date(NOW + days * DAY).toISOString(),
                usedPercent: 50,
              },
      },
    }
  }

  test("soonest reset first, ties in their own order, an account with no reset time last", () => {
    const accounts = [
      resetting("none@example.com", null),
      resetting("late@example.com", 6),
      resetting("unread@example.com", undefined),
      resetting("tie-a@example.com", 2),
      resetting("soon@example.com", 1),
      resetting("tie-b@example.com", 2),
    ]
    expect(byWeekReset(accounts).map((a) => a.account)).toEqual([
      "soon@example.com",
      "tie-a@example.com",
      "tie-b@example.com",
      "late@example.com",
      "none@example.com",
      "unread@example.com",
    ])
    // the report's own list keeps its order
    expect(accounts[0]!.account).toBe("none@example.com")
  })

  test("the combined windows list the accounts in that order, in the tooltip and the joined line", () => {
    const [week, fiveHour] = combinedUsage(
      withAccounts([resetting("late@example.com", 6), resetting("soon@example.com", 1)]),
      NOW,
    )
    expect(week!.rows!.map((r) => r.name)).toEqual(["soon", "late"])
    expect(fiveHour!.rows!.map((r) => r.name)).toEqual(["soon", "late"])
  })
})

// #162: an account with no 5-hour window reads "none", never 0%, stale, or a failed read's outline
describe("an account with no 5-hour window", () => {
  const none = (account: string, week: number) => {
    const a = accountUsage(account, week, 0)
    return { ...a, usage: { ...a.usage, fiveHour: null, fiveHourNone: true as const } }
  }

  test("alone, its 5-hour reading is none, fresh and judging nothing", () => {
    const usage = none("solo@example.com", 30).usage
    const fiveHour = systemReadings(
      calm((r) => void (r.usage = usage)),
      NOW,
    ).find((r) => r.key === "fiveHour")
    expect(fiveHour).toMatchObject({ level: "green", value: "none" })
    expect(fiveHour!.stale).toBeUndefined()
    expect(fiveHour!.state).toStartWith("no 5-hour window on this account")
  })

  test("beside a read one, its row reads none and the mean leaves it out", () => {
    const [, fiveHour] = combinedUsage(
      withAccounts([accountUsage("a@example.com", 50, 40), none("b@example.com", 30)]),
      NOW,
    )
    expect(fiveHour!.value).toBe("40")
    expect(fiveHour!.stale).toBeUndefined()
    const row = fiveHour!.rows!.find((r) => r.name === "b")!
    expect(row).toMatchObject({ none: true, used: null })
    expect(fiveHour!.title).toContain("b none")
  })

  test("when no fresh account has a 5-hour window, the combined figure reads none", () => {
    const [, fiveHour] = combinedUsage(
      withAccounts([none("a@example.com", 50), none("b@example.com", 30)]),
      NOW,
    )
    expect(fiveHour).toMatchObject({ level: "green", value: "none" })
    expect(fiveHour!.stale).toBeUndefined()
  })
})

// the owner on the Week tooltip: "You think I can understand anything via this plan with me via ascii?"
describe("usage rows", () => {
  // an account whose week reads `week` and resets `days` after NOW, its 5-hour window `fiveHour`, resetting in 2 hours
  const at = (account: string, week: number, days: number, fiveHour = 0) => {
    const a = accountUsage(account, week, fiveHour)
    return {
      ...a,
      usage: {
        ...a.usage,
        sevenDay: { resetsAt: new Date(NOW + days * DAY).toISOString(), usedPercent: week },
      },
    }
  }
  const POOL = [
    { account: "nd@example.com", ending: true, endsAt: "2026-10-20T18:30:00Z", renewsOn: null },
    { account: "two@example.com", ending: true, endsAt: null, renewsOn: null },
    { account: "pride@example.com", ending: false, endsAt: null, renewsOn: 3 },
    { account: "lw@example.com", ending: false, endsAt: null, renewsOn: null },
  ]
  const tonight = (patch: (r: SystemReport) => void = () => {}) =>
    calm((r) => {
      r.account = { email: "two@example.com", name: null }
      r.accounts = [
        at("lw@example.com", 0, 6),
        at("two@example.com", 92, 2, 40),
        at("pride@example.com", 100, 1),
        at("nd@example.com", 97, 1.5, 100),
        at("merritt@example.org", 100, 1.2),
      ]
      r.usage = { ...r.usage!, rotation: { pool: POOL } }
      patch(r)
    })

  test("a row an account, soonest week reset first, named by its address's local part, the current one marked", () => {
    const rows = usageRows("week", tonight(), NOW)
    expect(rows.map((r) => r.name)).toEqual(["pride", "merritt", "nd", "two", "lw"])
    expect(rows.filter((r) => r.current).map((r) => r.name)).toEqual(["two"])
    expect(rows.find((r) => r.name === "two")).toMatchObject({
      cells: 9,
      level: "red",
      reset: "Thu 12:00",
      status: "0.2%/h",
      used: 92,
    })
    expect(rows.find((r) => r.name === "lw")).toMatchObject({ cells: 0, level: "green", used: 0 })
  })

  test("a window at 100% is exhausted, else its pace to its reset, the 5-hour judged by its own window, the rows in the week's order", () => {
    // nd 3 points over 36h, two 8 over 48h, lw 100 over 144h
    expect(usageRows("week", tonight(), NOW).map((r) => r.status)).toEqual([
      "exhausted",
      "exhausted",
      "0.1%/h",
      "0.2%/h",
      "0.7%/h",
    ])
    // every 5-hour window resets in 2 hours
    const fiveHour = usageRows("fiveHour", tonight(), NOW)
    expect(fiveHour.map((r) => `${r.name} ${r.used} ${r.status}`)).toEqual([
      "pride 0 50.0%/h",
      "merritt 0 50.0%/h",
      "nd 100 exhausted",
      "two 40 30.0%/h",
      "lw 0 50.0%/h",
    ])
  })

  test("pace is the share left an hour until the reset, or until an ending plan's end when that is sooner, an hour at least", () => {
    expect(paceOf(40, NOW + 10 * HOUR, NOW)).toBe(6)
    expect(paceOf(40, NOW + HOUR / 2, NOW)).toBe(60)
    expect(paceOf(40, NOW - 1, NOW)).toBe(60)
    expect(paceOf(40, null, NOW)).toBeNull()
    // nd's plan ends 6 hours from now, before its week resets in 36: 3 points over 6 hours
    const ending = tonight((r) => {
      r.usage!.rotation = {
        pool: POOL.map((e) =>
          e.account.startsWith("nd@")
            ? { ...e, endsAt: new Date(NOW + 6 * HOUR).toISOString() }
            : e,
        ),
      }
    })
    expect(usageRows("week", ending, NOW).find((r) => r.name === "nd")!.status).toBe("0.5%/h")
    expect(usageRows("fiveHour", ending, NOW).find((r) => r.name === "two")!.status).toBe("30.0%/h")
  })

  test("the current account's week adds its burn over the sampler's last hour, once its readings are 10 minutes apart", () => {
    const point = (minutesAgo: number, used: number, account = "two@example.com") => ({
      at: new Date(NOW - minutesAgo * 60_000).toISOString(),
      load1: 0,
      swapUsedBytes: null,
      usedBytes: null,
      week: { account, used },
    })
    const history = [point(60, 88), point(30, 10, "lw@example.com"), point(0, 92)]
    expect(burnOf(history, "two@example.com")).toBe(4)
    expect(burnOf(history, "nobody@example.com")).toBeNull()
    expect(burnOf([point(9, 88), point(0, 92)], "two@example.com")).toBeNull()
    expect(burnOf([point(60, 90), point(0, 2)], "two@example.com")).toBe(0)
    const report = tonight((r) => {
      r.history = history
    })
    const two = (key: "fiveHour" | "week") =>
      usageRows(key, report, NOW).find((r) => r.name === "two")!.status
    expect(two("week")).toBe("0.2%/h · now 4.0%/h")
    expect(two("fiveHour")).toBe("30.0%/h")
    expect(usageRows("week", report, NOW).find((r) => r.name === "lw")!.status).toBe("0.7%/h")
  })

  test("an ending account is exhausted from 2 hours before its end, as login-flip.py drops it", () => {
    const status = (now: number) =>
      usageRows("week", tonight(), now).find((r) => r.name === "nd")!.status
    // its week rolled past, so 100 points over the 2h01m to its end
    expect(status(Date.parse("2026-10-20T16:29:00Z"))).toBe("49.6%/h")
    expect(status(Date.parse("2026-10-20T16:30:00Z"))).toBe("exhausted")
  })

  test("a reset that has passed reads 0%, the week rolled to its slot a week on, the 5-hour's next reset unknown", () => {
    const report = calm((r) => {
      r.accounts = [at("old@example.com", 100, -1, 90), at("new@example.com", 50, 3)]
      r.accounts[0]!.usage.fiveHour = {
        resetsAt: new Date(NOW - 60_000).toISOString(),
        usedPercent: 90,
      }
    })
    const [week, fiveHour] = [usageRows("week", report, NOW), usageRows("fiveHour", report, NOW)]
    expect(week.map((r) => `${r.name} ${r.used} ${r.reset}`)).toEqual([
      "new 50 Fri 12:00",
      "old 0 Mon 12:00",
    ])
    expect(fiveHour.find((r) => r.name === "old")).toMatchObject({ reset: "-", used: 0 })
  })

  test("room left is the pool's unused share out of 100, exhausted accounts at 0, rounded half up", () => {
    // (0 + 0 + 3 + 8 + 100) / 5 = 22.2
    expect(roomLeft(usageRows("week", tonight(), NOW))).toBe("22%")
    expect(combinedUsage(tonight(), NOW)[0]!.measure).toBe("Week · room left 22%")
    // (100 + 100 + 0 + 60 + 100) / 5 = 72
    expect(combinedUsage(tonight(), NOW)[1]!.measure).toBe("5-hour · room left 72%")
    expect(
      roomLeft([
        { exhausted: false, used: 99 },
        { exhausted: false, used: 0 },
      ]),
    ).toBe("51%")
    // an ending plan within 2 hours of its end counts 0 whatever its share: (50 + 0 + 0) / 3
    expect(
      roomLeft([
        { exhausted: false, used: 50 },
        { exhausted: true, used: 100 },
        { exhausted: true, used: 40 },
      ]),
    ).toBe("17%")
    expect(roomLeft([])).toBe("-")
    expect(roomLeft([{ exhausted: false, used: null }])).toBe("-")
  })

  test("a share past 100% is held at 100, so room left never goes below 0", () => {
    const report = calm((r) => {
      r.accounts = [at("over@example.com", 130, 1), at("under@example.com", 100, 2)]
    })
    expect(usageRows("week", report, NOW).map((r) => r.used)).toEqual([100, 100])
    expect(roomLeft(usageRows("week", report, NOW))).toBe("0%")
  })

  test("the week's Renews: an ending plan's end, a renewing one's next billing day, a ? until it is set", () => {
    const report = tonight()
    expect(renewRows(usageRows("week", report, NOW), report, NOW)).toEqual([
      { account: "pride@example.com", name: "pride", words: "renews Nov 3" },
      { account: "nd@example.com", name: "nd", words: "ends Oct 20" },
      { account: "two@example.com", name: "two", words: "ends" },
      { account: "lw@example.com", name: "lw", words: "renews ?" },
    ])
    const [week, fiveHour] = combinedUsage(report, NOW)
    expect(week!.renews).toHaveLength(4)
    expect(week!.title).toEndWith(
      "Renews: pride renews Nov 3, nd ends Oct 20, two ends, lw renews ?",
    )
    expect(fiveHour).not.toHaveProperty("renews")
    // with no rotation in usage.json there is nothing to say
    expect(combinedUsage(withAccounts(FIVE), NOW)[0]).not.toHaveProperty("renews")
  })

  test("pride@, whose renewal day login-flip.py's RENEWS leaves unset, reads renews ?", () => {
    const report = tonight((r) => {
      r.usage!.rotation = {
        pool: POOL.map((e) => (e.account.startsWith("pride@") ? { ...e, renewsOn: null } : e)),
      }
    })
    const rows = renewRows(usageRows("week", report, NOW), report, NOW)
    expect(rows?.find((r) => r.name === "pride")?.words).toBe("renews ?")
  })

  test("times read as the owner's sketch writes them, 24-hour in the browser's zone", () => {
    expect(slotLabel(Date.parse("2026-10-26T19:30:00Z"))).toBe("Mon 19:30")
    expect(slotLabel(Date.parse("2026-10-27T09:05:00Z"))).toBe("Tue 09:05")
  })

  test("a billing day comes next this month or next, today included, a short month taking its last day", () => {
    const next = (d: number, from: string) =>
      new Date(nextMonthDay(d, Date.parse(from))).toISOString().slice(0, 10)
    expect(next(6, "2026-10-06T12:00:00Z")).toBe("2026-10-06")
    expect(next(3, "2026-10-06T12:00:00Z")).toBe("2026-11-03")
    expect(next(31, "2026-11-05T12:00:00Z")).toBe("2026-11-30")
  })
})

describe("combinedUsage", () => {
  test("with one account file, or none, the readings are today's, from usage.json", () => {
    const none = combinedUsage(withAccounts([]), NOW)
    expect(none.map((r) => `${r.key} ${r.value} ${r.level}`)).toEqual([
      "week 25 green",
      "fiveHour 26 green",
    ])
    expect(none.map((r) => r.title)).toEqual([
      expect.stringMatching(/^Week 25% used, below the 70% warning level, resets /),
      expect.stringMatching(/^5-hour window 26% used, below the 70% warning level, resets /),
    ])
    expect(combinedUsage(withAccounts([accountUsage("main@example.com", 80, 80)]), NOW)).toEqual(
      none,
    )
    expect(systemReadings(withAccounts([]), NOW).slice(-2)).toEqual(none)
  })

  test("five accounts: one combined figure, the plain mean of their shares, since no file carries its limit's size", () => {
    const [week, fiveHour] = combinedUsage(withAccounts(FIVE), NOW)
    // (97+88+76+31+23) / 5 = 63, (40+30+20+10+5) / 5 = 21
    expect(week).toMatchObject({ key: "week", value: "63" })
    expect(fiveHour).toMatchObject({ key: "fiveHour", value: "21" })
    // no sum and no fresh-accounts average over the rows: the room left, then a row an account
    expect(week!.measure).toBe("Week · room left 37%")
    // screen readers hear the figure and its level first, then the rows
    expect(week!.title).toStartWith(
      "Week 63% across 5 fresh accounts, below the 70% warning level; Week · room left 37%; main 97%, resets Sat 12:00, 0.0%/h; ",
    )
    expect(week!.rows!.map((r) => `${r.name} ${r.used} ${r.reset} ${r.status}`)).toEqual([
      "main 97 Sat 12:00 0.0%/h",
      "ada 88 Sat 12:00 0.1%/h",
      "bo 76 Sat 12:00 0.3%/h",
      "cy 31 Sat 12:00 0.7%/h",
      "di 23 Sat 12:00 0.8%/h",
    ])
  })

  test("no + list and no (+N): the figure is one number however many accounts there are", () => {
    const many = Array.from({ length: 9 }, (_, i) => accountUsage(`a${i}@example.com`, 100, 1))
    for (const reading of combinedUsage(withAccounts(many), NOW)) {
      expect(reading.value).toMatch(/^\d+$/)
      expect(reading).not.toHaveProperty("parts")
      expect(reading).not.toHaveProperty("more")
    }
  })

  test("its colour follows the combined figure, by READING_LEVELS' bands", () => {
    const pair = (a: number, b: number) =>
      combinedUsage(
        withAccounts([
          accountUsage("main@example.com", a, 0),
          accountUsage("ada@example.com", b, 0),
        ]),
        NOW,
      )[0]!
    expect(pair(60, 70)).toMatchObject({ level: "green", reasons: [], value: "65" })
    expect(pair(70, 80)).toMatchObject({
      level: "amber",
      reasons: ["Week 75% across 2 fresh accounts, over the 70% warning level"],
      value: "75",
    })
    expect(pair(95, 90)).toMatchObject({
      level: "red",
      reasons: ["Week 93% across 2 fresh accounts, over the 90% critical level"],
      value: "93",
    })
    expect(combinedUsage(withAccounts(FIVE), NOW)[0]!.state).toBe(
      "63% across 5 fresh accounts, below the 70% warning level",
    )
  })

  test("a stale account stays in the hover, marked stale, and out of the figure", () => {
    const accounts = [
      accountUsage("main@example.com", 20, 10),
      accountUsage("ada@example.com", 99, 99, 30 * 60_000),
    ]
    const [week] = combinedUsage(withAccounts(accounts), NOW)
    expect(week).toMatchObject({ level: "green", value: "20" })
    expect(week!.stale).toBeUndefined()
    expect(week!.rows![1]).toMatchObject({ name: "ada", stale: true, used: 99 })
    expect(week!.title).toContain("ada 99%, resets Sat 12:00, 0.0%/h, stale")
    expect(week!.state).toBe("20% across 1 fresh account, below the 70% warning level")
  })

  test("gray only when no account is fresh: the last shares' mean, stale, judging nothing", () => {
    const old = [
      accountUsage("main@example.com", 95, 95, 30 * 60_000),
      accountUsage("ada@example.com", 91, 91, 30 * 60_000),
    ]
    expect(combinedUsage(withAccounts(old), NOW)[0]).toMatchObject({
      level: "green",
      reasons: [],
      stale: true,
      state: "every account stale",
      value: "93",
    })
  })

  test("with fresh files holding no reading of a window, the reading judges nothing and says so", () => {
    const blank = (a: ReturnType<typeof accountUsage>): SystemReport["accounts"][number] => ({
      ...a,
      usage: { ...a.usage, fiveHour: null },
    })
    const accounts = [
      blank(accountUsage("main@example.com", 20, 0)),
      blank(accountUsage("ada@example.com", 30, 0, 30 * 60_000)),
    ]
    const fiveHour = combinedUsage(withAccounts(accounts), NOW)[1]!
    expect(fiveHour).toMatchObject({
      level: "green",
      reasons: [],
      stale: true,
      state: "no fresh account reads it",
      value: "-",
    })
  })

  test("GLM stays its own reading: only the Claude accounts' week and 5-hour windows are joined", () => {
    const readings = systemReadings(withAccounts(FIVE), NOW)
    expect(readings.filter((r) => r.rows).map((r) => r.key)).toEqual(["week", "fiveHour"])
    expect(readings.map((r) => r.key)).toEqual([
      "memory",
      "cpu",
      "swap",
      "disk",
      "week",
      "fiveHour",
    ])
  })
})

describe("spokenReadings", () => {
  test("names each reading once, a crossed one with its level", () => {
    const readings = systemReadings(
      calm((r) => setReading.swap(r, 98)),
      NOW,
    )
    const spoken = spokenReadings(readings)
    expect(spoken.match(/Swap 98% used/g)).toHaveLength(1)
    expect(spoken).toContain("Swap 98% used, over the 97% critical level")
    expect(spoken.split(". ")).toHaveLength(readings.length)
  })
})

// systemHealth's rules, case by case; each one is a reading's level too, so the item's icons and its health cannot disagree.
const amber: [string, (r: SystemReport) => void, RegExp][] = [
  [
    "memory pressure warn",
    (r) => void (r.memory.pressure = "warn"),
    /Memory pressure warn, 60% used/,
  ],
  ["swap past 90%", (r) => setReading.swap(r, 93), /Swap 93% used, over the 90% warning level/],
  ["the load past 0.8 a core", (r) => setReading.cpu(r, 0.9), /Load 14 on 15 cores/],
  ["disk under 50 GB free", (r) => setReading.disk(r, 42), /Disk 42 GB free, under the 50 GB/],
  [
    "a stale sample",
    (r) => void (r.sampledAt = new Date(NOW - 120_000).toISOString()),
    /Sampling has stopped/,
  ],
]

const red: [string, (r: SystemReport) => void, RegExp][] = [
  [
    "memory pressure critical",
    (r) => void (r.memory.pressure = "critical"),
    /Memory pressure critical, 60% used/,
  ],
  ["swap past 97%", (r) => setReading.swap(r, 98), /Swap 98% used, over the 97%/],
  ["the load past the cores", (r) => setReading.cpu(r, 1.1), /Load 17 on 15 cores/],
  ["disk under 20 GB free", (r) => setReading.disk(r, 15), /Disk 15 GB free, under the 20 GB/],
]

// The usage windows keep their own icons' colours but never colour the header's health: only hardware colours it.
const usage: [string, (r: SystemReport) => void][] = [
  ["the 5-hour window past 70%", (r) => setReading.fiveHour(r, 74)],
  ["the 5-hour window past 90%", (r) => setReading.fiveHour(r, 94)],
  ["the week over pace", (r) => void (r.usage!.sevenDay!.usedPercent = 30)],
  ["the week past 90%", (r) => setReading.week(r, 91)],
]

describe("systemHealth", () => {
  test("green when every reading is", () => {
    expect(systemHealth(calm(), NOW)).toEqual({ level: "green", reasons: [] })
  })

  test("green with memory nearly full and swap at 85%, where a Mac at work sits", () => {
    const busy = calm((r) => {
      setReading.memory(r, 92)
      setReading.swap(r, 85)
      r.memory.freePercent = 6
    })
    expect(systemHealth(busy, NOW)).toEqual({ level: "green", reasons: [] })
  })

  for (const [cause, patch, reason] of amber) {
    test(`amber: ${cause}`, () => {
      const { level, reasons } = systemHealth(calm(patch), NOW)
      expect(level).toBe("amber")
      expect(reasons.join("; ")).toMatch(reason)
    })
  }

  for (const [cause, patch, reason] of red) {
    test(`red: ${cause}, which outranks any amber and leads the reasons`, () => {
      const { level, reasons } = systemHealth(
        calm((r) => {
          setReading.swap(r, 93)
          setReading.disk(r, 42)
          patch(r)
        }),
        NOW,
      )
      expect(level).toBe("red")
      expect(reasons[0]).toMatch(reason)
      expect(reasons.slice(1).join("; ")).toMatch(/Swap 93% used|Disk 42 GB free/)
    })
  }

  for (const [cause, patch] of usage) {
    test(`hardware alone: ${cause} colours its own reading, never the health`, () => {
      const report = calm(patch)
      const levels = systemReadings(report, NOW)
        .filter((r) => r.key === "fiveHour" || r.key === "week")
        .map((r) => r.level)
      expect(levels.some((level) => level !== "green")).toBe(true)
      expect(systemHealth(report, NOW)).toEqual({ level: "green", reasons: [] })
    })
  }

  // a stale sample has no reading of its own; the item says sampling has stopped instead
  for (const [cause, patch] of [...amber, ...red].filter(([cause]) => cause !== "a stale sample")) {
    test(`its level is the worst reading's: ${cause}`, () => {
      const report = calm(patch)
      const readings = systemReadings(report, NOW)
        .filter((r) => r.key !== "fiveHour" && r.key !== "week")
        .map((r) => r.level)
      const worst = readings.includes("red")
        ? "red"
        : readings.includes("amber")
          ? "amber"
          : "green"
      expect(systemHealth(report, NOW).level).toBe(worst)
    })
  }

  test("a remembered usage window judges nothing, since it has almost always reset; a fresh one at the same share turns its own icon red", () => {
    const remembered = calm((r) => {
      r.usage!.fiveHour = {
        resetsAt: new Date(NOW - 3600_000).toISOString(),
        seenAt: new Date(NOW - 2 * 3600_000).toISOString(),
        usedPercent: 95,
      }
    })
    expect(systemHealth(remembered, NOW)).toEqual({ level: "green", reasons: [] })
    const reading = systemReadings(remembered, NOW).find((r) => r.key === "fiveHour")!
    expect(reading.title).toMatch(
      /^5-hour window 95% used, stale, reset .+; last seen 2 hr\. ago, the usage job has not written it since$/,
    )
    expect(reading.level).toBe("green")
    expect(
      systemReadings(
        calm((r) => setReading.fiveHour(r, 95)),
        NOW,
      ).find((r) => r.key === "fiveHour")?.level,
    ).toBe("red")
  })

  test("unknown readings judge nothing: no usage, no swap, no free share, no disk", () => {
    const blank = calm((r) => {
      r.usage = null
      r.memory.swap = null
      r.memory.freePercent = null
      r.memory.pressure = null
      r.disk = null
    })
    expect(systemHealth(blank, NOW).level).toBe("green")
  })
})

describe("loadLabel", () => {
  test("the load keeps one decimal below 10 and goes whole from 10, so a busy line still fits", () => {
    expect(loadLabel(6.43)).toBe("6.4")
    expect(loadLabel(9.94)).toBe("9.9")
    expect(loadLabel(9.96)).toBe("10")
    expect(loadLabel(12.3)).toBe("12")
  })
})

describe("glanceReadings", () => {
  const atGb = (gb: number) =>
    systemReadings(
      calm((r) => void (r.disk = { freeBytes: gb * 1024 ** 3, totalBytes: 994 * 1024 ** 3 })),
      NOW,
    )
  const keys = (gb: number) => glanceReadings(atGb(gb)).map((r) => `${r.key}:${r.level}`)

  test("a green disk is left out of the row, the week before the 5-hour window, which comes last", () => {
    expect(keys(729)).toEqual([
      "memory:green",
      "cpu:green",
      "swap:green",
      "week:green",
      "fiveHour:green",
    ])
  })

  test("under 50 GB free the disk shows orange, after swap and before the week, the session window last", () => {
    expect(keys(49)).toEqual([
      "memory:green",
      "cpu:green",
      "swap:green",
      "disk:amber",
      "week:green",
      "fiveHour:green",
    ])
  })

  test("under 20 GB free the disk shows red, in the same place", () => {
    expect(keys(19)[3]).toBe("disk:red")
    expect(keys(19)).toHaveLength(6)
  })
})

describe("updateHover", () => {
  const now = new Date("2026-10-12T10:00:00Z")
  const update = {
    behind: 3,
    branch: "canary",
    live: false,
    newest: { at: "2026-10-12T08:00:00Z", title: "feat: a new filter" },
    pulled: false,
    upstream: "canary" as const,
  }

  test("shows only while the build is behind", () => {
    expect(updateHover(null, now)).toBeNull()
    expect(updateHover(undefined, now)).toBeNull()
    expect(updateHover({ ...update, behind: 0 }, now)).toBeNull()
    expect(updateHover(update, now)).toBe(
      "3 new changes on canary\nNewest: feat: a new filter, 2 hr. ago\nTo update: git pull, then restart",
    )
    expect(updateHover({ ...update, behind: 1 }, now)?.split("\n")[0]).toBe(
      "1 new change on canary",
    )
  })

  // A click on update sends its message straight into chat.
  test("the message a click sends names the changes and the newest, and how to take them off the live dashboard", () => {
    expect(updateMessage(null, now)).toBeNull()
    expect(updateMessage({ ...update, behind: 0 }, now)).toBeNull()
    expect(updateMessage(update, now)).toBe(
      'update available: 3 new changes on canary, newest "feat: a new filter" 2 hr. ago. to update: git pull, then restart.',
    )
    expect(updateMessage({ ...update, behind: 1, pulled: true }, now)).toBe(
      'update available: 1 new change on canary, newest "feat: a new filter" 2 hr. ago. pulled already: restart to pick it up.',
    )
  })

  test("main and canary pull then restart, a pulled checkout only restarts, and the live dashboard rolls now or next", () => {
    expect(updateHint({ live: false, pulled: false })).toBe("To update: git pull, then restart")
    expect(updateHint({ live: false, pulled: false })).toBe("To update: git pull, then restart")
    expect(updateHint({ live: false, pulled: true })).toBe("Pulled already: restart to pick it up")
    expect(updateHint({ live: true, pulled: false })).toBe(
      "The next roll takes it, or Update now asks for it at once",
    )
    expect(updateHint({ live: true, pulled: true })).toBe(
      "The next roll takes it, or Update now asks for it at once",
    )
  })
})

describe("accountLine", () => {
  const merritt = { email: "merritt@example.com", name: "Merritt Rivera" }

  test("an owner's line is the Claude account's email once the read lands", () => {
    expect(accountLine("agent@local.host", { account: merritt, owner: true, pending: false })).toBe(
      "merritt@example.com",
    )
  })

  test("an owner with no account linked, or a read that failed, reads No Claude account", () => {
    expect(accountLine("agent@local.host", { account: null, owner: true, pending: false })).toBe(
      "No Claude account",
    )
    expect(
      accountLine("agent@local.host", { account: undefined, owner: true, pending: false }),
    ).toBe("No Claude account")
  })

  test("holds no words while the owner's first read is pending, and never the sign-in user", () => {
    expect(
      accountLine("agent@local.host", { account: undefined, owner: true, pending: true }),
    ).toBeNull()
  })

  test("below the owner rung, which cannot read the report, it is the sign-in user's email", () => {
    expect(
      accountLine("agent@local.host", { account: undefined, owner: false, pending: false }),
    ).toBe("agent@local.host")
  })
})

describe("clusterOf", () => {
  type Machine = SystemReport["machines"][number]
  const at = new Date(NOW)
  const machine = (
    name: string,
    used: number,
    load: number,
    swapUsed: number,
    diskFree: number | null = 700,
  ): Machine => ({
    down: null,
    name,
    reading: {
      cores: 20,
      disk: diskFree === null ? null : { freeBytes: diskFree * GB, totalBytes: 994 * GB },
      load: [load, load, load],
      memory: { totalBytes: 128 * GB, usedBytes: used * GB },
      swap: { totalBytes: 16 * GB, usedBytes: swapUsed * GB },
    },
  })
  const two = [machine("machine-a", 12, 3.1, 1, 700), machine("machine-b", 4, 0.4, 0, 300)]

  test("one machine, or none named, is no cluster, so the page shows its own figures as before", () => {
    expect(clusterOf([], "normal", at)).toBeNull()
    expect(clusterOf([machine("machine-a", 12, 3.1, 1)], "normal", at)).toBeNull()
  })

  test("each figure is the sum over both machines, its hover the split as a + b with each part named", () => {
    const cluster = clusterOf(two, "normal", at)!
    expect(cluster.cpu).toEqual({
      detail: "1, 5 and 15 min.: 3.5 / 3.5 / 3.5",
      hover: "machine-a 3.1 on 20 + machine-b 0.4 on 20 cores",
      marker: null,
      value: "3.5 on 40 cores",
    })
    expect(cluster.memory).toEqual({
      detail: "94% free · pressure Normal on machine-a",
      hover: "machine-a 12.0 GB of 128.0 GB + machine-b 4.0 GB of 128.0 GB",
      marker: null,
      value: "16.0 GB of 256.0 GB",
    })
    expect(cluster.swap).toEqual({
      hover: "machine-a 1.0 GB of 16.0 GB + machine-b 0 MB of 16.0 GB",
      marker: null,
      value: "1.0 GB of 32.0 GB",
    })
    expect(cluster.disk).toEqual({
      detail: "of 1988.0 GB",
      hover: "machine-a 700.0 GB + machine-b 300.0 GB",
      marker: null,
      value: "1000.0 GB",
    })
  })

  test("a machine whose disk did not read is a dash in the disk's hover, never a zero in its sum", () => {
    const cluster = clusterOf([two[0]!, machine("machine-b", 4, 0.4, 0, null)], "normal", at)!
    expect(cluster.disk).toEqual({
      detail: "of 994.0 GB",
      hover: "machine-a 700.0 GB + machine-b -",
      marker: null,
      value: "700.0 GB",
    })
  })

  test("a machine that does not read is never a zero: the sums keep the rest, the value says 1 of 2 machines, and the hover gives the reason and since when", () => {
    const since = new Date(NOW - 5 * 60_000).toISOString()
    const down: Machine = {
      down: { reason: "ssh you@10.0.0.2 ran past 5s", since },
      name: "machine-b",
      reading: null,
    }
    const cluster = clusterOf([two[0]!, down], "normal", at)!
    expect(cluster.cpu).toMatchObject({ marker: "1 of 2 machines", value: "3.1 on 20 cores" })
    expect(cluster.memory).toMatchObject({
      marker: "1 of 2 machines",
      value: "12.0 GB of 128.0 GB",
    })
    expect(cluster.cpu.hover).toBe(
      `machine-a 3.1 on 20 cores\nmachine-b unreachable since ${messageTime(since, at)}: ssh you@10.0.0.2 ran past 5s`,
    )
    expect(cluster.swap.hover.split("\n")[1]).toStartWith("machine-b unreachable since ")
  })
})

// The owner's cluster as the live System view read it on 16 Nov: two machines of 20 cores, each at a 5-minute load near 10 (#2425).
describe("systemReadings over a cluster", () => {
  type Machine = SystemReport["machines"][number]
  const spark = (
    name: string,
    load5: number,
    used: number,
    swapUsed: number,
    diskFree: number | null = 3470,
  ): Machine => ({
    down: null,
    name,
    reading: {
      cores: 20,
      disk: diskFree === null ? null : { freeBytes: diskFree * GB, totalBytes: 3755 * GB },
      load: [load5, load5, load5],
      memory: { totalBytes: 128 * GB, usedBytes: used * GB },
      swap: { totalBytes: 16 * GB, usedBytes: swapUsed * GB },
    },
  })
  const both = (a: Machine, b: Machine) =>
    calm((r) => {
      r.machines = [a, b]
      r.cpu = { cores: 20, load: [10, 10, 10] }
    })
  const pick = (report: SystemReport, key: string) =>
    systemReadings(report, NOW).find((r) => r.key === key)!

  test("memory, load, swap and disk are the cluster's sums, each hover naming every machine's part", () => {
    const report = both(
      spark("spark-a566", 10, 64, 2, 3470),
      spark("spark-9dfb", 10.4, 32, 0, 3401),
    )
    const readings = systemReadings(report, NOW)
    expect(readings.map((r) => `${r.key} ${r.value} ${r.level}`).slice(0, 4)).toEqual([
      "memory 38 green",
      "cpu 20 green",
      "swap 6 green",
      "disk 7T green",
    ])
    expect(pick(report, "cpu").title).toBe(
      "Load 20 on 40 cores, 5 min., below the 0.8 a core warning level on each machine\nspark-a566 10 on 20 + spark-9dfb 10 on 20 cores, 5 min.",
    )
    expect(pick(report, "memory").title).toBe(
      "Memory 38% used, pressure normal on spark-a566\nspark-a566 50% + spark-9dfb 25% used",
    )
    expect(pick(report, "swap").title).toBe(
      "Swap 6% used, below the 90% warning level on each machine\nspark-a566 13% + spark-9dfb 0% used",
    )
    expect(pick(report, "disk").title).toBe(
      "Disk 6871 GB free, above the 50 GB warning level on each machine\nspark-a566 3470 + spark-9dfb 3401 GB free",
    )
  })

  test("the level is the worst machine's own, its reason naming that machine, while the value stays the cluster's", () => {
    const hot = both(spark("spark-a566", 18, 64, 15), spark("spark-9dfb", 2, 32, 0))
    expect(pick(hot, "cpu")).toMatchObject({
      level: "amber",
      reasons: ["spark-a566 load 18 on 20 cores, over the 0.8 a core warning level"],
      value: "20",
    })
    expect(pick(hot, "swap")).toMatchObject({
      level: "amber",
      reasons: ["spark-a566 swap 94% used, over the 90% warning level"],
      value: "47",
    })
    expect(systemHealth(hot, NOW)).toEqual({
      level: "amber",
      reasons: [
        "spark-a566 load 18 on 20 cores, over the 0.8 a core warning level",
        "spark-a566 swap 94% used, over the 90% warning level",
      ],
    })
    const full = both(spark("spark-a566", 10, 64, 2, 3470), spark("spark-9dfb", 10, 32, 0, 30))
    expect(pick(full, "disk")).toMatchObject({
      level: "amber",
      reasons: ["spark-9dfb disk 30 GB free, under the 50 GB warning level"],
      value: "3T",
    })
    expect(systemHealth(full, NOW).reasons).toEqual([
      "spark-9dfb disk 30 GB free, under the 50 GB warning level",
    ])
    const pressed = both(spark("spark-a566", 10, 64, 2), spark("spark-9dfb", 10, 32, 0))
    pressed.memory.pressure = "warn"
    expect(pick(pressed, "memory")).toMatchObject({
      level: "amber",
      reasons: ["Memory pressure warn on spark-a566"],
      state: "Memory pressure warn on spark-a566",
    })
    const unread = spark("spark-9dfb", 10, 32, 0)
    unread.reading!.memory.usedBytes = null
    const halfRead = both(spark("spark-a566", 10, 64, 2), unread)
    halfRead.memory.pressure = "warn"
    expect(pick(halfRead, "memory").title).toBe(
      "Memory; Memory pressure warn on spark-a566\nspark-a566 50% + spark-9dfb - used",
    )
  })

  test("a peer that did not read is named with its reason and since when, beside 1 of 2 machines, and the sums keep the machine that read", () => {
    const since = new Date(NOW - 5 * 60_000).toISOString()
    const report = both(spark("spark-a566", 10, 64, 2), {
      down: { reason: "ssh you@10.0.0.2 ran past 3s", since },
      name: "spark-9dfb",
      reading: null,
    })
    const missing = `1 of 2 machines\nspark-9dfb unreachable since ${messageTime(since, new Date(NOW))}: ssh you@10.0.0.2 ran past 3s`
    expect(pick(report, "cpu")).toMatchObject({
      title: `Load 10 on 20 cores, 5 min., below the 0.8 a core warning level on each machine that read\nspark-a566 10 on 20 cores, 5 min.\n${missing}`,
      value: "10",
    })
    expect(pick(report, "memory").title).toEndWith(missing)
    expect(pick(report, "swap").title).toEndWith(missing)
    expect(pick(report, "disk")).toMatchObject({
      title: `Disk 3470 GB free, above the 50 GB warning level on each machine that read\nspark-a566 3470 GB free\n${missing}`,
      value: "3T",
    })
  })

  test("a peer that read with no disk keeps the sum to the machine that read it, its part a dash", () => {
    const report = both(spark("spark-a566", 10, 64, 2, 3470), spark("spark-9dfb", 10, 32, 0, null))
    expect(pick(report, "disk")).toMatchObject({
      title:
        "Disk 3470 GB free, above the 50 GB warning level\nspark-a566 3470 + spark-9dfb - GB free",
      value: "3T",
    })
  })
})
