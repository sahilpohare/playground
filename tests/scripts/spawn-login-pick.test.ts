import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  capacityLog,
  execLine,
  herdrPin,
  launchOf,
  minutesAgo,
  offUntilUtc,
  placing,
  resumeFile,
  root,
  script,
  spawn,
  usage,
  weekAt,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("the capacity gate refuses and spawns nothing", () => {
  // a bare spawn starts on the login with the most room this week, among usage.json and each usage-<name>.json.
  const login = (account: string, week: number, written = minutesAgo(0)) =>
    JSON.stringify({ ...JSON.parse(weekAt(week)), account, writtenAt: written })
  const loginFiles =
    (files: Record<string, string>) =>
    (home: string): void => {
      for (const [name, raw] of Object.entries(files))
        writeFileSync(join(home, ".playground", name), raw)
    }

  test("a bare spawn whose own login is at 98% starts on the login with the most room, and says which", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: weekAt(98) },
      script,
      undefined,
      loginFiles({
        "usage-nd941z.json": login("quilla@example.net", 30, minutesAgo(50)),
        "usage-pride.json": login("pride@example.com", 82),
      }),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on quilla@example.net, the login with the most room this week: its week is at 30% (usage-nd941z.json)",
    )
    expect(r.security).toContain(
      "find-generic-password -s playground-claude-oauth -a quilla@example.net",
    )
    expect(launchOf(r)).toContain("-a quilla@example.net -w")
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        verdict: "pass",
        readings: expect.objectContaining({ account: "quilla@example.net", week: 30 }),
      }),
    ])
  })

  test("a bare spawn stays on its own login when that has the most room", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {},
      script,
      undefined,
      loginFiles({ "usage-pride.json": login("pride@example.com", 25) }),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "spawn.sh: no --account, so it stays on quilla@example.org, the login with the most room this week: its week is at 20% (usage.json)",
    )
    expect((r.security ?? []).join("\n")).not.toContain("pride@example.com")
    expect(launchOf(r)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  // a bare spawn follows login-flip.json's account split, by smooth weighted round robin over split-picks.json's credits
  const splitFiles =
    (shares: Record<string, number>, credit?: Record<string, number>, age = 0) =>
    (home: string): void => {
      const dir = join(home, ".playground", "ops", "usage")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "login-flip.json"),
        JSON.stringify({ split: { at: Date.now() / 1000 - age * 60, shares } }),
      )
      if (credit) writeFileSync(join(dir, "split-picks.json"), JSON.stringify(credit))
    }

  test("a bare spawn starts on the ending login next in the split, short of 100%, over a login with more room, so its last week is spent before it ends", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc },
      script,
      undefined,
      (h) => {
        loginFiles({
          "usage-spare.json": login("spare@example.com", 10),
          "usage-second.json": login("second@example.com", 95),
        })(h)
        splitFiles({ "spare@example.com": 0.3, "second@example.com": 0.7 })(h)
      },
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on second@example.com, next in the account split (70% of new sessions): its week is at 95% (usage-second.json)",
    )
    expect(launchOf(r)).toContain("-a second@example.com -w")
    const credit = JSON.parse(
      readFileSync(join(r.home, ".playground", "ops", "usage", "split-picks.json"), "utf8"),
    )
    expect(credit["spare@example.com"]).toBeCloseTo(0.3)
    expect(credit["second@example.com"]).toBeCloseTo(-0.3)
  })

  test("the next bare spawn goes to the login whose credit the split has raised highest", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc },
      script,
      undefined,
      (h) => {
        loginFiles({
          "usage-spare.json": login("spare@example.com", 10),
          "usage-second.json": login("second@example.com", 95),
        })(h)
        splitFiles(
          { "spare@example.com": 0.3, "second@example.com": 0.7 },
          { "spare@example.com": 0.3, "second@example.com": -0.3 },
        )(h)
      },
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain("no --account, so it starts on spare@example.com, next in")
  })

  test("a split 30 minutes old is not followed: the bare spawn takes the login with the most room", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc },
      script,
      undefined,
      (h) => {
        loginFiles({
          "usage-spare.json": login("spare@example.com", 10),
          "usage-second.json": login("second@example.com", 95),
        })(h)
        splitFiles({ "spare@example.com": 0.3, "second@example.com": 0.7 }, undefined, 30)(h)
      },
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on spare@example.com, the login with the most room this week: its week is at 10% (usage-spare.json)",
    )
  })

  // login-flip.json's split shares accounts it probes with no usage-<name>.json, each reading in its `seen` (#85)
  const probedFiles =
    (seen: Record<string, object>, shares: Record<string, number>) =>
    (home: string): void => {
      const dir = join(home, ".playground", "ops", "usage")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "login-flip.json"),
        JSON.stringify({ seen, split: { at: Date.now() / 1000, shares } }),
      )
    }
  const probed = (week: number, minutes = 10) => ({
    at: Date.now() / 1000 - minutes * 60,
    five: 5,
    fiveReset: Date.now() / 1000 + 3600,
    via: "token",
    week,
    weekReset: Date.now() / 1000 + 5 * 86_400,
  })

  test("a bare spawn whose own login is over its pace starts on an account login-flip probes, by its share in the split (#85)", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { USAGE_JSON: weekAt(98) },
      script,
      undefined,
      probedFiles({ "probed@example.com": probed(20) }, { "probed@example.com": 0.5 }),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on probed@example.com, next in the account split (50% of new sessions): its week is at 20% (login-flip.json seen)",
    )
    expect(launchOf(r)).toContain("-a probed@example.com -w")
  })

  test("a probed reading with no 5-hour window passes on its week, and one whose 5-hour window is at 95% does not (#85)", async () => {
    const run = (five: number | null) =>
      spawn(
        ["worker", "worker-brave-otter", "b.md"],
        [],
        { USAGE_JSON: weekAt(98) },
        script,
        undefined,
        probedFiles(
          {
            "probed@example.com": {
              ...probed(20),
              five,
              fiveReset: five === null ? null : Date.now() / 1000 + 3600,
            },
          },
          { "probed@example.com": 0.5 },
        ),
      )
    const none = await run(null)
    expect(none.code).toBe(0)
    expect(launchOf(none)).toContain("-a probed@example.com -w")
    expect((await run(95)).code).not.toBe(0)
  })

  test("a probed reading 60 minutes old is not followed, and the refusal names its age (#85)", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { USAGE_JSON: weekAt(98) },
      script,
      undefined,
      probedFiles({ "probed@example.com": probed(20, 61) }, { "probed@example.com": 0.5 }),
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "probed@example.com (login-flip.json seen): login-flip.json seen was written 61 minutes ago (writtenAt), 60 is its limit",
    )
  })

  test("a stale usage-<name>.json leaves the same account's fresh probed reading in the pick (#85)", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { USAGE_JSON: weekAt(98) },
      script,
      undefined,
      (h) => {
        loginFiles({ "usage-probed.json": login("probed@example.com", 20, minutesAgo(90)) })(h)
        probedFiles({ "probed@example.com": probed(20) }, { "probed@example.com": 0.5 })(h)
      },
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on probed@example.com, next in the account split (50% of new sessions): its week is at 20% (login-flip.json seen)",
    )
  })

  test("a bare spawn refuses when every login is over the gate, naming each one's reading", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: weekAt(98) },
      script,
      undefined,
      loginFiles({
        "usage-spare.json": login("spare@example.com", 99),
        "usage-nd941z.json": login("quilla@example.net", 30, minutesAgo(75)),
      }),
    )
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    for (const fragment of [
      "the usage gate holds it: every login is over it:",
      "quilla@example.org (usage.json): the week is at 98% (usage.json seven_day.used_percentage)",
      "spare@example.com (usage-spare.json): the week is at 99% (usage-spare.json seven_day.used_percentage)",
      "quilla@example.net (usage-nd941z.json): usage-nd941z.json was written 75 minutes ago (writtenAt), 60 is its limit",
    ])
      expect(r.err).toContain(fragment)
  })

  // a resume takes the same pick a start does, a pick stays out of the resume record, and a week at 100% refuses any --account.
  test("a resume given no --account starts on the login with the most room, and says which", async () => {
    const r = await spawn(
      ["resume", "worker-brave-otter", root],
      [],
      { PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: weekAt(98) },
      script,
      { name: "worker-brave-otter", backend: "claude" },
      loginFiles({ "usage-nd941z.json": login("quilla@example.net", 30) }),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on quilla@example.net, the login with the most room this week: its week is at 30% (usage-nd941z.json)",
    )
    expect(launchOf(r)).toContain("-a quilla@example.net -w")
  })

  test("the login a bare start picks stays off its resume record's exec line, so a restore picks again, and on its account line", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: weekAt(98) },
      script,
      undefined,
      (home) => {
        herdrPin()(home)
        loginFiles({ "usage-nd941z.json": login("quilla@example.net", 30) })(home)
      },
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain("-a quilla@example.net -w")
    expect(execLine(r, "worker-x")).not.toContain("--account")
    expect(resumeFile(r, "worker-x")).toContain("\n# account: quilla@example.net\n")
  })

  test.each([
    ["a start", ["worker", "worker-brave-otter", "b.md"]],
    ["a resume", ["resume", "worker-brave-otter", root]],
  ])(
    "%s refuses an --account whose week reads 100%%, naming it and its reading",
    async (_, args) => {
      const r = await spawn(
        [...args, "--account", "quilla@example.net"],
        [],
        {},
        script,
        { name: "worker-brave-otter", backend: "claude" },
        loginFiles({ "usage-nd941z.json": login("quilla@example.net", 100) }),
      )
      expect(r.code).not.toBe(0)
      expect(r.cmux).toBeUndefined()
      expect(r.err).toContain(
        "the usage gate holds it: --account quilla@example.net: its week reads 100% (usage-nd941z.json seven_day.used_percentage)",
      )
    },
  )

  test("an --account whose week reads under 100% still starts, the pace left to its own login", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "quilla@example.net"],
      [],
      {},
      script,
      undefined,
      loginFiles({ "usage-nd941z.json": login("quilla@example.net", 99) }),
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain("-a quilla@example.net -w")
  })

  test("an --account whose 100% week has since reset still starts", async () => {
    const reset = JSON.parse(login("quilla@example.net", 100))
    reset.rate_limits.seven_day.resets_at = new Date(Date.now() - 3_600_000).toISOString()
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "quilla@example.net"],
      [],
      {},
      script,
      undefined,
      loginFiles({ "usage-nd941z.json": JSON.stringify(reset) }),
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain("-a quilla@example.net -w")
  })

  // On 4 Nov an --account start on a full account passed: the gate read a usage file only when its top-level account was the one named, so usage.json's accounts map, which held it at 100%, went unread.
  const accounts = (map: Record<string, object>) => ({
    USAGE_JSON: JSON.stringify(usage({ accounts: map })),
  })
  const resetIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds
  const full = { readAt: minutesAgo(4), week: 100, weekReset: resetIn(86_400) }

  test("an --account usage.json's accounts map holds at 100% is refused, naming the account with the lowest week under 100", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "full@example.net"],
      [],
      accounts({
        "busy@example.net": { week: 60, weekReset: resetIn(86_400) },
        "full@example.net": full,
        "renewed@example.net": { week: 100, weekReset: resetIn(-60) },
      }),
    )
    expect(r.code).not.toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(r.err).toContain(
      "the usage gate holds it: --account full@example.net: its week reads 100% (usage.json accounts) until",
    )
    expect(r.err).toContain(
      "Name renewed@example.net, the account with the most room (its week reads 0%)",
    )
  })

  test("an --account the accounts map holds at 100% while no other account has room is refused, saying so", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "full@example.net"],
      [],
      accounts({ "full@example.net": full, "other@example.net": full }),
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "No account in usage.json's accounts has room; wait for a week to reset",
    )
  })

  test.each([
    ["under 100%", { week: 99, weekReset: resetIn(86_400) }],
    ["at 100% past its weekReset", { week: 100, weekReset: resetIn(-60) }],
  ])("an --account the accounts map holds %s still starts", async (_, entry) => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "full@example.net"],
      [],
      accounts({ "full@example.net": entry }),
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain("-a full@example.net -w")
  })

  test("a usage-<name>.json naming this machine's own login is not another login", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: weekAt(98) },
      script,
      undefined,
      loginFiles({ "usage-quilla.json": login("quilla@example.org", 10) }),
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the usage gate holds it: the week is at 98% (usage.json seven_day.used_percentage)",
    )
  })

  // usage.json reads the factory account, while a bare start runs on the config's own login, which ops-usage reads into ops/usage/stored-login.json. usage.json carries no storedLogin here, as when ops-usage cannot read the stored login.
  const factoryUsage = (week: number) => login("factory@example.com", week)
  const storedLogin =
    (account: string, week: number, age = 0) =>
    (home: string) => {
      mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
      writeFileSync(
        join(home, ".playground", "ops", "usage", "stored-login.json"),
        login(account, week, minutesAgo(age)),
      )
    }
  const ownLogin = JSON.stringify({ oauthAccount: { emailAddress: "own@example.com" } })

  test("a bare start is judged by the login it runs on: own login at 98%, factory at 53%, it starts on the factory with --account", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {
        CLAUDE_JSON: ownLogin,
        PACE_OFF_UNTIL: offUntilUtc,
        USAGE_JSON: factoryUsage(53),
      },
      script,
      undefined,
      storedLogin("own@example.com", 98),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on factory@example.com, the login with the most room this week: its week is at 53% (usage.json)",
    )
    expect(r.security).toContain(
      "find-generic-password -s playground-claude-oauth -a factory@example.com",
    )
    expect(launchOf(r)).toContain("-a factory@example.com -w")
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ account: "factory@example.com", week: 53 }),
      }),
    ])
  })

  test("a bare start whose own login and factory are both over the gate refuses, naming the own login's reading", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {
        CLAUDE_JSON: ownLogin,
        PACE_OFF_UNTIL: offUntilUtc,
        USAGE_JSON: factoryUsage(99),
      },
      script,
      undefined,
      storedLogin("own@example.com", 98),
    )
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "own@example.com (stored-login.json): the week is at 98% (ops/usage/stored-login.json seven_day.used_percentage)",
    )
  })

  test("a bare start stays on its own stored login when that has the most room, and names it", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {
        CLAUDE_JSON: ownLogin,
        PACE_OFF_UNTIL: offUntilUtc,
        USAGE_JSON: factoryUsage(53),
      },
      script,
      undefined,
      storedLogin("own@example.com", 20),
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "spawn.sh: no --account, so it stays on own@example.com, the login with the most room this week: its week is at 20% (stored-login.json)",
    )
    expect(launchOf(r)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  test.each([
    ["missing", () => {}, "ops/usage/stored-login.json (no such file)"],
    [
      "stale",
      storedLogin("own@example.com", 20, 20),
      "ops/usage/stored-login.json was written 20 minutes ago (writtenAt), 15 is its limit",
    ],
    [
      "naming another account",
      storedLogin("other@example.com", 20),
      "ops/usage/stored-login.json reads other@example.com, not own@example.com",
    ],
  ])(
    "a %s stored-login.json fails the own login, so a bare start never runs on it unjudged",
    async (_, files, reason) => {
      const r = await spawn(
        ["worker", "worker-brave-otter", "b.md"],
        [],
        {
          CLAUDE_JSON: ownLogin,
          PACE_OFF_UNTIL: offUntilUtc,
          USAGE_JSON: factoryUsage(99),
        },
        script,
        undefined,
        files,
      )
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("the usage gate holds it: every login is over it:")
      expect(r.err).toContain(reason)
    },
  )

  // #1756: a lead steers a start onto the own login by naming it, past a split that would send it to the factory
  const splitToFactory = (home: string) => {
    storedLogin("own@example.com", 20)(home)
    writeFileSync(
      join(home, ".playground", "ops", "usage", "login-flip.json"),
      JSON.stringify({
        split: { at: Date.now() / 1000, shares: { "factory@example.com": 1 } },
        seen: {},
      }),
    )
  }

  test("--account naming the own login starts on it, the split skipped and its usage judged", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "own@example.com"],
      [],
      { CLAUDE_JSON: ownLogin, PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: factoryUsage(10) },
      script,
      undefined,
      splitToFactory,
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "--account own@example.com is this machine's own login, so it starts there, the split skipped: its week is at 20% (stored-login.json)",
    )
    expect(launchOf(r)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(r.security).toBeUndefined()
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({ readings: expect.objectContaining({ week: 20 }) }),
    ])
    expect(() =>
      readFileSync(join(r.home, ".playground", "ops", "usage", "split-picks.json")),
    ).toThrow()
    expect(execLine(r, "worker-brave-otter")).toContain("--account own@example.com")
  })

  test.each([
    ["missing", () => {}],
    ["stale", storedLogin("own@example.com", 20, 20)],
  ])(
    "--account naming the own login is refused while its stored-login.json is %s, though the factory has room",
    async (_, files) => {
      const r = await spawn(
        ["worker", "worker-brave-otter", "b.md", "--account", "own@example.com"],
        [],
        { CLAUDE_JSON: ownLogin, PACE_OFF_UNTIL: offUntilUtc, USAGE_JSON: factoryUsage(10) },
        script,
        undefined,
        files,
      )
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("--account own@example.com, this machine's own login: ")
    },
  )

  test("a usage.json without five_hour is an account with no 5-hour limit, read as none rather than 0%, and passes (#85)", async () => {
    const raw = JSON.stringify(usage({ rate_limits: { seven_day: usage().rate_limits.seven_day } }))
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { USAGE_JSON: raw })
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        verdict: "pass",
        readings: expect.objectContaining({ fiveHour: "none", week: 20 }),
      }),
    ])
  })

  // #1560: a usage.accounts row parked until a future time keeps new sessions off its login, the split's pick and the lowest-week fallback alike, and an --account naming it is refused.
  const iso = (ms: number) => `${new Date(Date.now() + ms).toISOString().slice(0, 19)}Z`
  const until = iso(86_400_000)
  const parkedRows = (parkedUntil = until) =>
    JSON.stringify({
      "usage.accounts": [
        { email: "spare@example.com", parkedUntil },
        { label: "zai", provider: "glm" },
      ],
    })
  const parkedFiles = (h: string): void => {
    loginFiles({
      "usage-spare.json": login("spare@example.com", 10),
      "usage-second.json": login("second@example.com", 95),
    })(h)
    splitFiles({ "spare@example.com": 0.7, "second@example.com": 0.3 })(h)
  }

  test("a parked login is passed over for the next one in the split, though it has the larger share and the most room", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PACE_OFF_UNTIL: offUntilUtc, SETTINGS_JSON: parkedRows(), USAGE_JSON: weekAt(98) },
      script,
      undefined,
      parkedFiles,
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on second@example.com, next in the account split",
    )
    expect(launchOf(r)).toContain("-a second@example.com -w")
  })

  test("a parked login that is the only one under its pace is never picked: the start refuses with the usage gate's line", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { SETTINGS_JSON: parkedRows(), USAGE_JSON: weekAt(98) },
      script,
      undefined,
      parkedFiles,
    )
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    for (const fragment of [
      "the usage gate holds it: every login is over it:",
      `spare@example.com (usage-spare.json): it is parked until ${until} (usage.accounts parkedUntil)`,
      "second@example.com (usage-second.json): the week is at 95%",
    ])
      expect(r.err).toContain(fragment)
  })

  test("a login whose parkedUntil has passed is picked as before", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { SETTINGS_JSON: parkedRows(iso(-60_000)), USAGE_JSON: weekAt(98) },
      script,
      undefined,
      parkedFiles,
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      "no --account, so it starts on spare@example.com, next in the account split",
    )
  })

  test.each([
    ["a start", ["worker", "worker-brave-otter", "b.md"]],
    ["a resume", ["resume", "worker-brave-otter", root]],
  ])("%s refuses an --account that names a parked login, naming parkedUntil", async (_, args) => {
    const r = await spawn(
      [...args, "--account", "spare@example.com"],
      [],
      { SETTINGS_JSON: parkedRows() },
      script,
      { name: "worker-brave-otter", backend: "claude" },
      loginFiles({ "usage-spare.json": login("spare@example.com", 10) }),
    )
    expect(r.code).not.toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(r.err).toContain(
      `the usage gate holds it: --account spare@example.com is parked until ${until} (usage.accounts parkedUntil).`,
    )
  })
})
