import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// jobs.ts registers the job keys, by relative path, since @/ here is web/next/src
import { JOBS, jobKey } from "../../../../../packages/settings/src/jobs"
import { loginPath } from "../../../../../packages/settings/src/rendered"
import {
  listSettings,
  readSetting,
  setSetting,
} from "../../../../../packages/settings/src/settings-folder"
import {
  jobConfigWrite,
  jobRows,
  jobToggleWrite,
  parseJobConfig,
} from "../../../../../web/next/src/lib/jobs"

const scratch = mkdtempSync(join(tmpdir(), "jobs-toggle-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const ME = "made-up-me"
const WHO = { actor: "made-up-user-id", author: "owner", inboxRef: null, reason: "test" }

// A data folder whose extensions have your login, as Set up settings leaves it.
const setUp = (name: string) => {
  const data = join(scratch, name)
  mkdirSync(dirname(loginPath(data)), { recursive: true })
  writeFileSync(loginPath(data), `${ME}\n`)
  return data
}

// A toggle's or a config edit's write as the settings API stores it: PUT /api/v1/settings/:key's body, through setSetting.
const save = (
  data: string,
  write: ReturnType<typeof jobToggleWrite> | ReturnType<typeof jobConfigWrite>,
) =>
  setSetting(
    data,
    { key: write.param.key, scope: write.json.scope, value: write.json.value },
    { ...WHO, reason: write.json.reason },
  )

describe("Settings > Jobs (PG-1196)", () => {
  test("lists every registry job by name, A to Z, with its description, schedule, state and whether a setting sets it", () => {
    const data = setUp("list")
    // on macOS, which lists every registry job, a macOS-alone one too
    const rows = jobRows(listSettings(data, "darwin"), ME)
    expect(rows.map((row) => row.name)).toEqual(Object.keys(JOBS))
    expect(rows.find((row) => row.name === "ops-sweep")).toEqual({
      config: undefined,
      description: JOBS["ops-sweep"]!.description,
      enabled: false,
      key: jobKey("ops-sweep"),
      name: "ops-sweep",
      row: undefined,
      schedule: JOBS["ops-sweep"]!.schedule,
      scope: ME,
      set: false,
    })
    expect(rows.find((row) => row.name === "ops-dashboard")).toMatchObject({
      enabled: true,
      set: false,
    })
  })

  test("the keep-awake job is listed on, with its switch, on macOS alone, and on Linux is no row, as the render gives it none there (#2906)", () => {
    const data = setUp("mac-only")
    const awake = (platform: string) =>
      jobRows(listSettings(data, platform), ME).find((row) => row.name === "ops-keep-awake")
    expect(awake("darwin")).toMatchObject({ enabled: true, set: false })
    expect(awake("linux")).toBeUndefined()
  })

  test("a toggle stores the job's enabled field alone at your login's scope, so the job still reads the registry's", () => {
    const data = setUp("toggle")
    const key = jobKey("ops-zai-usage")
    const card = jobRows(listSettings(data), ME).find((row) => row.key === key)!
    const write = jobToggleWrite(card, true)
    expect(write).toEqual({
      json: {
        by: "Settings",
        reason: "Turned ops-zai-usage on in Settings > Jobs",
        scope: ME,
        value: { enabled: true },
      },
      param: { key },
    })
    expect(save(data, write).ok).toBe(true)
    const read = readSetting(data, key)!
    expect(read.rows).toEqual([{ key, scope: ME, value: { enabled: true } }])
    expect(read.value).toEqual({ ...JOBS["ops-zai-usage"], enabled: true })
    expect(jobRows(listSettings(data), ME).find((row) => row.key === key)).toMatchObject({
      enabled: true,
      set: true,
    })
  })

  test("a toggle keeps the other fields your scope's row holds, and turns the job back off", () => {
    const data = setUp("keep")
    const key = jobKey("ops-sweep")
    expect(
      setSetting(data, { key, scope: ME, value: { enabled: true, pausedFor: "made-up" } }, WHO).ok,
    ).toBe(true)
    const row = jobRows(listSettings(data), ME).find((each) => each.key === key)!
    const write = jobToggleWrite(row, false)
    expect(write.json).toMatchObject({
      reason: "Turned ops-sweep off in Settings > Jobs",
      value: { enabled: false, pausedFor: "made-up" },
    })
    expect(save(data, write).ok).toBe(true)
    expect(readSetting(data, key)!.rows).toEqual([
      { key, scope: ME, value: { enabled: false, pausedFor: "made-up" } },
    ])
  })
})

// #1336: the owner's own edit of a job's config in Settings > Jobs writes straight through the settings PUT, one click, with no Inbox Approve after it.
describe("Settings > Jobs' config edit (#1336)", () => {
  test("a job's row shows the config it reads, its scope's row over the registry's", () => {
    const data = setUp("config-read")
    const key = jobKey("ops-sweep")
    const config = { hours: "09-18" }
    expect(setSetting(data, { key, scope: ME, value: { config } }, WHO).ok).toBe(true)
    expect(jobRows(listSettings(data), ME).find((row) => row.key === key)).toMatchObject({
      config,
      row: { config },
      set: true,
    })
  })

  test("an edit stores the new config alone over your scope's row, so its enabled field and the rest stay", () => {
    const data = setUp("config-edit")
    const key = jobKey("ops-sweep")
    const row = { config: { hours: "00-23" }, enabled: true, pausedFor: "made-up" }
    expect(setSetting(data, { key, scope: ME, value: row }, WHO).ok).toBe(true)
    const job = jobRows(listSettings(data), ME).find((each) => each.key === key)!
    const config = { hours: "09-18", made: ["up"] }
    const write = jobConfigWrite(job, config)
    expect(write).toEqual({
      json: {
        by: "Settings",
        reason: "Set ops-sweep's config in Settings > Jobs",
        scope: ME,
        value: { config, enabled: true, pausedFor: "made-up" },
      },
      param: { key },
    })
    expect(save(data, write).ok).toBe(true)
    expect(readSetting(data, key)!.rows).toEqual([
      { key, scope: ME, value: { config, enabled: true, pausedFor: "made-up" } },
    ])
  })

  test("an edit saves only a JSON object, and says why it refuses anything else", () => {
    expect(parseJobConfig('{"hours": "09-18"}')).toEqual({ config: { hours: "09-18" } })
    expect(parseJobConfig("{hours")).toEqual({ error: "This is not JSON" })
    for (const text of ["[]", "null", "7", '"made-up"'])
      expect(parseJobConfig(text)).toEqual({ error: "A config is a JSON object, {...}" })
  })
})

// #1336: an org's own job, a jobs.<camelName> row the registry lacks at an org's scope, is listed beside the registry's, and its switch and config edit write its whole row back at that org.
describe("Settings > Jobs' org jobs (#1336)", () => {
  const ORG = "made-up-org"
  const KEY = "jobs.opsMadeUpWatch"
  const row = {
    callsModel: false,
    command: "{bun} --no-env-file {data}/ops/ops-made-up-watch/cli.ts",
    config: { prefixes: ["X"] },
    description: "Watches a made-up org's queue.",
    enabled: false,
    heartbeat: "ops-made-up-watch",
    schedule: { every: 60 },
  }
  const listed = (data: string) => {
    // on macOS, which lists every registry job, a macOS-alone one too
    const read = listSettings(data, "darwin")
    return { ...read, rows: [...read.rows, { key: KEY, scope: ORG, value: row }] }
  }

  test("lists an org's own job by its name, A to Z among the registry's, read from its org's row", () => {
    const rows = jobRows(listed(setUp("org-list")), ME)
    expect(rows.map((each) => each.name)).toEqual(
      [...Object.keys(JOBS), "ops-made-up-watch"].toSorted((a, b) => a.localeCompare(b)),
    )
    expect(rows.find((each) => each.key === KEY)).toEqual({
      config: row.config,
      description: row.description,
      enabled: false,
      key: KEY,
      name: "ops-made-up-watch",
      row,
      schedule: row.schedule,
      scope: ORG,
      set: true,
    })
  })

  test("its switch and its config edit write its whole row back at its org, the one field changed", () => {
    const job = jobRows(listed(setUp("org-write")), ME).find((each) => each.key === KEY)!
    expect(jobToggleWrite(job, true).json).toMatchObject({
      scope: ORG,
      value: { ...row, enabled: true },
    })
    expect(jobConfigWrite(job, { prefixes: ["Y"] }).json).toMatchObject({
      scope: ORG,
      value: { ...row, config: { prefixes: ["Y"] } },
    })
  })

  test("lists no row at your login's scope or core's as an org's job, no alias of a registry job, and no row off a job's shape", () => {
    const read = listSettings(setUp("org-skip"), "darwin")
    const rows = jobRows(
      {
        ...read,
        rows: [
          ...read.rows,
          { key: KEY, scope: ME, value: row },
          { key: KEY, scope: "core", value: row },
          { key: "jobs.opsDesk", scope: ORG, value: { enabled: true } },
          { key: "jobs.opsMadeUpNull", scope: ORG, value: null },
          { key: "jobs.opsMadeUpList", scope: ORG, value: ["made-up"] },
          { key: "jobs.opsMadeUpPart", scope: ORG, value: { enabled: true } },
          { key: "jobs.ops_made_up", scope: ORG, value: { ...row, heartbeat: "ops_made_up" } },
          { key: "jobs.opsMadeUpOther", scope: ORG, value: row },
        ],
      },
      ME,
    )
    expect(rows.map((each) => each.name)).toEqual(Object.keys(JOBS))
  })
})
