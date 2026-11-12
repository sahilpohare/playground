import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  jobName,
  jobsListed,
  OPS_DOES,
  opsJobs,
  opsRowOf,
  readOps,
  RUNNER_NAMES,
} from "../../../../../../api/hono/src/lib/dashboard/ops"
import {
  cycle,
  beat as herdrBeat,
  restoreResult,
} from "../../../../../../packages/scripts/src/ops-herdr/herdr"
import { liveReads } from "../../../../../live-reads"

// readOps asks ps whether this process runs, a live read.
liveReads()

const NOW = Date.parse("2026-10-06T12:00:00.000Z")

// The hover line of a job whose own setting gives no description, in place of one core would name.
const NO_DESCRIPTION = "No description in this job's settings"

const beat = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    cycleSeconds: 60,
    job: "ops-dashboard",
    lastBeatAt: "2026-10-06T11:59:45Z",
    lastResult: "ok",
    pid: 4242,
    startedAt: "2026-10-06T10:00:00Z",
    ...fields,
  })

describe("opsRowOf", () => {
  test("Running while the last result is ok and it beat within three cycles", () => {
    expect(opsRowOf("ops-dashboard", beat(), true, NOW)).toEqual({
      callsModel: false,
      does: "Keeps the Dashboard on its branch's latest head",
      job: "ops-dashboard",
      lastBeatAt: "2026-10-06T11:59:45.000Z",
      model: null,
      name: "Dashboard updates",
      paused: false,
      problem: null,
      reason: null,
      schedule: null,
      status: "running",
    })
    // whether the pid runs is unknown when ps could not be read, which judges nothing
    expect(opsRowOf("ops-dashboard", beat(), null, NOW).status).toBe("running")
  })

  // #1336: a job that refuses its config writes why to its heartbeat, which Settings > Jobs' card shows beside the config
  test("carries the heartbeat's configRefused, its last refusal of its config, and none while it holds none (#1336)", () => {
    const why = "config.hours takes HH-HH, not made-up"
    expect(opsRowOf("ops-dashboard", beat({ configRefused: why }), true, NOW)).toMatchObject({
      configRefused: why,
      status: "running",
    })
    expect(opsRowOf("ops-dashboard", beat(), true, NOW)).not.toHaveProperty("configRefused")
    expect(opsRowOf("ops-dashboard", beat({ configRefused: 7 }), true, NOW)).not.toHaveProperty(
      "configRefused",
    )
  })

  test("carries the callsModel and model jobs.json marks, whatever the id says", () => {
    expect(
      opsRowOf("ops-dashboard", beat(), true, NOW, false, {
        callsModel: true,
        model: "glm-5.3-flash",
      }),
    ).toMatchObject({ callsModel: true, model: "glm-5.3-flash" })
    expect(
      opsRowOf("ops-dashboard", beat(), true, NOW, false, { callsModel: true, model: null }),
    ).toMatchObject({ callsModel: true, model: null })
  })

  test("Failing with its last result when that is not ok", () => {
    const row = opsRowOf(
      "ops-linear",
      beat({ job: "ops-linear", lastResult: "check failing" }),
      true,
      NOW,
    )
    expect(row).toMatchObject({ reason: "check failing", status: "failing" })
  })

  test("Waiting, not Failing, while its last result says it waits, with the reason after it", () => {
    const row = opsRowOf(
      "ops-usage",
      beat({
        job: "ops-usage",
        lastResult: "waiting: no Claude account yet; add one in the Dashboard",
      }),
      true,
      NOW,
    )
    expect(row).toMatchObject({
      reason: "no Claude account yet; add one in the Dashboard",
      status: "waiting",
    })
  })

  test("Down by age: no beat for over three cycles", () => {
    const row = opsRowOf(
      "ops-checks",
      beat({ job: "ops-checks", lastBeatAt: "2026-10-06T11:56:59Z" }),
      true,
      NOW,
    )
    expect(row).toMatchObject({ reason: "No beat for over 180s", status: "down" })
    expect(
      opsRowOf(
        "ops-checks",
        beat({ job: "ops-checks", lastBeatAt: "2026-10-06T11:57:00Z" }),
        true,
        NOW,
      ).status,
    ).toBe("running")
  })

  test("Down when its loop has exited or its process is gone, even with a fresh beat", () => {
    expect(
      opsRowOf("ops-dashboard", beat({ lastResult: "loop exited 1" }), true, NOW),
    ).toMatchObject({
      reason: "loop exited 1",
      status: "down",
    })
    expect(
      opsRowOf("ops-dashboard", beat({ lastResult: "supervisor exited" }), true, NOW).status,
    ).toBe("down")
    expect(opsRowOf("ops-dashboard", beat(), false, NOW)).toMatchObject({
      reason: "Process 4242 is gone",
      status: "down",
    })
  })

  test("Down with the reason when the file is missing, does not parse or is malformed", () => {
    expect(opsRowOf("ops-dashboard", null, null, NOW)).toMatchObject({
      lastBeatAt: null,
      reason: "No heartbeat file",
      status: "down",
    })
    expect(opsRowOf("ops-dashboard", "{not json", null, NOW)).toMatchObject({
      reason: "Heartbeat file does not parse",
      status: "down",
    })
    expect(opsRowOf("ops-dashboard", beat({ lastBeatAt: "yesterday" }), null, NOW)).toMatchObject({
      reason: "Heartbeat lastBeatAt is malformed",
      status: "down",
    })
    expect(opsRowOf("ops-dashboard", beat({ pid: "x" }), null, NOW).status).toBe("down")
    expect(opsRowOf("ops-checks", beat({ job: "ops-dashboard" }), true, NOW)).toMatchObject({
      reason: "Heartbeat names ops-dashboard",
      status: "down",
    })
  })
})

describe("readOps", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-ops-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))

  test("every job whose heartbeat file is in the folder, A to Z: a live one Running, a malformed one Down", async () => {
    writeFileSync(join(dir, "ops-dashboard.json"), beat({ pid: process.pid }))
    writeFileSync(join(dir, "ops-linear.json"), "[]")
    const rows = await readOps(dir, NOW)
    expect(rows.map((row) => [row.job, row.status, row.reason])).toEqual([
      ["ops-dashboard", "running", null],
      ["ops-linear", "down", "Heartbeat file is malformed"],
    ])
  })

  test("a new job's file shows it with no code change and the generic line for its hover, while report.json and alerts.log beside it are not jobs", async () => {
    writeFileSync(join(dir, "ops-report.json"), beat({ job: "ops-report", pid: process.pid }))
    writeFileSync(join(dir, "report.json"), beat({ job: "report", pid: process.pid }))
    writeFileSync(join(dir, "alerts.log"), "an alert\n")
    const rows = await readOps(dir, NOW)
    expect(rows.map((row) => row.job)).toEqual(["ops-dashboard", "ops-linear", "ops-report"])
    expect(rows.at(-1)).toMatchObject({
      does: NO_DESCRIPTION,
      job: "ops-report",
      status: "running",
    })
    expect(rows[0]?.does).toBe("Keeps the Dashboard on its branch's latest head")
  })

  test("jobs.json pauses a disabled job, which keeps its row marked paused, heartbeat or not, and a job it expects with no heartbeat is down", async () => {
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            callsModel: true,
            heartbeat: "ops-dashboard",
            model: "claude-haiku-4-5",
            name: "ops-dashboard",
          },
          { disabled: true, heartbeat: "ops-linear", name: "ops-linear" },
          { heartbeat: "ops-sweep", name: "ops-sweep" },
          { disabled: true, heartbeat: "ops-zai-usage", name: "ops-zai-usage" },
        ],
      }),
    )
    const rows = await readOps(dir, NOW)
    // a paused job with no heartbeat still has its row, so the Scripts count and the System page's Paused table hold it
    expect(rows.map((row) => [row.job, row.status, row.paused])).toEqual([
      ["ops-dashboard", "running", false],
      ["ops-linear", "down", true],
      ["ops-report", "running", false],
      ["ops-sweep", "down", false],
      ["ops-zai-usage", "down", true],
    ])
    expect(rows.find((row) => row.job === "ops-dashboard")).toMatchObject({
      callsModel: true,
      model: "claude-haiku-4-5",
    })
    expect(rows.find((row) => row.job === "ops-sweep")?.reason).toBe("No heartbeat file")
    rmSync(join(dir, "jobs.json"))
  })

  test("a job outside core's registry shows its own jobs.json description, and one with none the generic line (#1866)", async () => {
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify({
        jobs: [
          { description: "Reads the tracker's tickets", name: "ops-linear" },
          { heartbeat: "ops-report", name: "ops-report" },
          { description: "Not this job's own line", name: "ops-dashboard" },
        ],
      }),
    )
    const does = new Map((await readOps(dir, NOW)).map((row) => [row.job, row.does]))
    expect(does.get("ops-linear")).toBe("Reads the tracker's tickets")
    expect(does.get("ops-report")).toBe(NO_DESCRIPTION)
    // a registry job keeps core's own plain line
    expect(does.get("ops-dashboard")).toBe("Keeps the Dashboard on its branch's latest head")
    rmSync(join(dir, "jobs.json"))
  })

  test("a folder that is not there holds no jobs", async () => {
    expect(await opsJobs(join(dir, "missing"))).toEqual([])
  })
})

// The sidebar's runners read when they run (every 5 min, every day at 5:00 AM) under a plain name that never repeats a word.
describe("job names and schedules", () => {
  test("every job Playground ships has a plain name and a hover line (#1160)", async () => {
    // by its path at run time: the jobs registry imports @/ against the settings package, which this folder's config maps to the API's src
    const registry = join(import.meta.dir, "../../../../../../packages/settings/src/jobs.ts")
    const { JOBS } = (await import(registry)) as { JOBS: Record<string, unknown> }
    for (const job of Object.keys(JOBS))
      expect([job, RUNNER_NAMES[job], OPS_DOES[job]]).toEqual([
        job,
        expect.any(String),
        expect.any(String),
      ])
  })

  test("the API's own names and hover lines are for core's registry jobs alone, so it names no org's job (#1866)", async () => {
    const registry = join(import.meta.dir, "../../../../../../packages/settings/src/jobs.ts")
    const { JOBS } = (await import(registry)) as { JOBS: Record<string, unknown> }
    for (const job of [...Object.keys(OPS_DOES), ...Object.keys(RUNNER_NAMES)])
      expect([job, job in JOBS]).toEqual([job, true])
  })

  test("every job the API describes has a plain name, and no shown name holds ops", () => {
    for (const job of Object.keys(OPS_DOES)) expect(RUNNER_NAMES[job]).toBeString()
    for (const name of Object.values(RUNNER_NAMES)) expect(name).not.toMatch(/ops/i)
    expect(jobName("ops-usage")).toBe("Claude usage readings")
    // a job the table does not name yet reads as its id without the prefix, in words
    expect(jobName("ops-new-thing")).toBe("New thing")
  })

  // the shipped fixture is what every shot and tester run draws, so its jobs and runners keep their names and schedules
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../../api/hono/src/fixtures/dashboard.json"),
      "utf8",
    ),
  ) as {
    files: Record<string, unknown>
  }
  const fixtureJobs = (
    fixture.files["playground/ops/jobs.json"] as {
      jobs: { description?: string; name: string; schedule?: unknown }[]
    }
  ).jobs
  const fixtureRunners = (
    fixture.files["playground/roster.json"] as { agents: { role: string; title?: string }[] }
  ).agents.filter((agent) => agent.role === "runner")

  test("a fixture job outside core's registry is labelled by its own jobs.json row, with one set and one on the generic line (#1866)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-ops-fixture-"))
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(fixture.files["playground/ops/jobs.json"]))
    const rows = await readOps(dir, NOW)
    rmSync(dir, { force: true, recursive: true })
    const own = fixtureJobs.filter(({ name }) => !(name in OPS_DOES))
    const does = own.map(({ name }) => rows.find((row) => row.job === name)?.does ?? null)
    expect(does).toEqual(own.map((job) => job.description ?? NO_DESCRIPTION))
    expect(does).toContain(NO_DESCRIPTION)
    expect(does.some((line) => line !== NO_DESCRIPTION)).toBe(true)
  })

  test("no name the shipped fixture shows holds ops", () => {
    for (const { name } of fixtureJobs) expect(jobName(name)).not.toMatch(/\bops\b/i)
    for (const { title } of fixtureRunners) expect(title ?? "").not.toMatch(/\bops\b/i)
    expect(fixtureRunners.length).toBeGreaterThan(0)
  })

  test("every job in the shipped fixture has a schedule", () => {
    for (const { name, schedule } of fixtureJobs)
      expect([name, schedule]).toEqual([name, expect.anything()])
  })

  test("a row carries its schedule, and a schedule whose every differs from the heartbeat's cycle is a problem", () => {
    expect(
      opsRowOf("ops-dashboard", beat(), true, NOW, false, undefined, { every: 60 }),
    ).toMatchObject({
      problem: null,
      schedule: { every: 60 },
    })
    expect(
      opsRowOf("ops-dashboard", beat(), true, NOW, false, undefined, { every: 300 }).problem,
    ).toBe("Its schedule says every 300s, its heartbeat every 60s")
    expect(
      opsRowOf("ops-dashboard", beat(), true, NOW, false, undefined, { always: true }).problem,
    ).toBeNull()
  })

  test("jobs.json's schedule reaches each job, read on its own, so one off its shape is dropped and the job kept", () => {
    const { enabled, schedules } = jobsListed(
      JSON.stringify({
        jobs: [
          { heartbeat: "ops-a", name: "ops-a", schedule: { every: 300 } },
          { name: "ops-b", schedule: { always: true } },
          { name: "ops-c", schedule: { cron: "0 5 * * *" } },
          { name: "ops-d", schedule: { every: "often" } },
          { name: "ops-e" },
        ],
      }),
    )
    expect(enabled).toEqual(["ops-a", "ops-b", "ops-c", "ops-d", "ops-e"])
    expect(Object.fromEntries(schedules)).toEqual({
      "ops-a": { every: 300 },
      "ops-b": { always: true },
      "ops-c": { cron: "0 5 * * *" },
    })
  })
})

describe("jobsListed", () => {
  test("a disabled job is paused and any other is expected to run, by its heartbeat name, else its name", () => {
    const { enabled, paused } = jobsListed(
      JSON.stringify({
        jobs: [
          { disabled: true, heartbeat: "ops-checks", name: "ops-checks" },
          { name: "ops-report" },
          { disabled: false, heartbeat: "ops-dashboard", name: "dashboard" },
        ],
      }),
    )
    expect([...paused]).toEqual(["ops-checks"])
    expect(enabled).toEqual(["ops-report", "ops-dashboard"])
  })

  test("each job's callsModel mark and model land by its heartbeat name, off entries read alone", () => {
    const { calls } = jobsListed(
      JSON.stringify({
        jobs: [
          { callsModel: true, heartbeat: "ops-linear", model: "claude-haiku-4-5", name: "x" },
          { callsModel: true, heartbeat: "ops-usage", name: "ops-usage" },
          { heartbeat: "ops-report", name: "ops-report" },
        ],
      }),
    )
    expect(calls.get("ops-linear")).toEqual({ callsModel: true, model: "claude-haiku-4-5" })
    expect(calls.get("ops-usage")).toEqual({ callsModel: true, model: null })
    expect(calls.get("ops-report")).toEqual({ callsModel: false, model: null })
  })

  test("an entry off its shape or naming no ops job drops alone, and a missing or broken file pauses nothing", () => {
    const { calls, enabled, paused } = jobsListed(
      JSON.stringify({
        jobs: [{ disabled: "yes", name: "ops-a" }, { name: "awake" }, { name: "ops-b" }],
      }),
    )
    expect(enabled).toEqual(["ops-b"])
    expect(paused.size).toBe(0)
    expect([...calls]).toEqual([["ops-b", { callsModel: false, model: null }]])
    for (const text of [null, "{not json", "[]", '{"jobs": {}}']) {
      expect(jobsListed(text)).toEqual({
        calls: new Map(),
        descriptions: new Map(),
        enabled: [],
        paused: new Set(),
        schedules: new Map(),
      })
    }
  })
})

describe("the ops-herdr job's heartbeat", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-ops-herdr-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))

  test("reads as running on ok and as failing with its result otherwise", async () => {
    const path = join(dir, "ops-herdr.json")
    const started = new Date(NOW - 60_000)
    await herdrBeat(path, started, new Date(NOW), "ok")
    const ok = opsRowOf("ops-herdr", readFileSync(path, "utf8"), true, NOW)
    expect([ok.status, ok.reason, ok.does]).toEqual([
      "running",
      null,
      "Keeps the herdr terminal servers up",
    ])

    await herdrBeat(
      path,
      started,
      new Date(NOW),
      "factory: down, not started on an unpinned binary",
    )
    const failing = opsRowOf("ops-herdr", readFileSync(path, "utf8"), true, NOW)
    expect([failing.status, failing.reason]).toEqual([
      "failing",
      "factory: down, not started on an unpinned binary",
    ])
  })

  // #1682: a restore a gate alone held beat its waits as the job's result, so Scripts read Herdr servers as Failing while the sessions were only waiting.
  test.each([
    ["a gate alone held", 0, "waiting a-worker: the load gate holds it: x\n", "running"],
    ["a real failure", 1, "not restored a-worker: its brief is gone\n", "failing"],
  ] as const)("a cycle whose restore %s reads as %s", async (_, code, output, status) => {
    const path = join(dir, "ops-herdr.json")
    const owed = new Set(["playground"])
    const result = await cycle({
      found: async () => ({ sha256: "a".repeat(64), version: "0.9.5" }),
      log: async () => null,
      owed: (session) => ({
        get: async () => owed.has(session),
        set: async (on) => void (on ? owed.add(session) : owed.delete(session)),
      }),
      pin: { path: "/h", sha256: "a".repeat(64), tag: "t", version: "0.9.5" },
      restore: async () => restoreResult(code, output, "/h/p.log"),
      running: async () => true,
      sessions: ["playground"],
      skipped: [],
      start: async () => null,
    })
    await herdrBeat(path, new Date(NOW - 60_000), new Date(NOW), result)
    expect(opsRowOf("ops-herdr", readFileSync(path, "utf8"), true, NOW).status).toBe(status)
  })
})
