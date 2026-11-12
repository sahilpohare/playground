import { describe, expect, test } from "bun:test"

import {
  opsLine,
  pausedOps,
  scriptCount,
  scriptsRail,
  scriptsShown,
  shownOps,
} from "../../../../../web/next/src/lib/ops"

type Row = Parameters<typeof shownOps>[0][number]

const job = (job: string, fields: Partial<Row> = {}): Row => ({
  callsModel: false,
  does: "",
  job,
  lastBeatAt: null,
  model: null,
  name: job.replace(/^ops-/, ""),
  paused: false,
  problem: null,
  reason: null,
  schedule: null,
  status: "running",
  ...fields,
})

describe("shownOps", () => {
  test("Runners lists a running job and one down while enabled, and leaves a paused one out", () => {
    const rows = [
      job("ops-checks", { paused: true, reason: "No beat for over 180s", status: "down" }),
      job("ops-dashboard"),
      job("ops-report", { reason: "Process 5120 is gone", status: "down" }),
    ]
    expect(shownOps(rows).map((row) => [row.job, row.status])).toEqual([
      ["ops-dashboard", "running"],
      ["ops-report", "down"],
    ])
  })

  test("a row stored before jobs were paused, with no paused field, still shows", () => {
    const { paused: _, ...stored } = job("ops-dashboard")
    expect(shownOps([stored as Row])).toHaveLength(1)
  })
})

describe("pausedOps", () => {
  test("the System page's Paused group holds only the jobs jobs.json pauses, whatever their beat", () => {
    const rows = [
      job("ops-checks", { paused: true, reason: "No beat for over 180s", status: "down" }),
      job("ops-dashboard"),
      job("ops-fixture", { paused: true }),
      job("ops-report", { reason: "Process 5120 is gone", status: "down" }),
    ]
    expect(pausedOps(rows).map((row) => row.job)).toEqual(["ops-checks", "ops-fixture"])
  })
})

describe("the Scripts group", () => {
  const rows = [
    job("ops-a"),
    job("ops-b", { reason: "Linear 500", status: "failing" }),
    job("ops-c", { reason: "No heartbeat file", status: "down" }),
    job("ops-d", { paused: true }),
  ]

  test("counts the jobs it lists, leaving out the paused ones it hides", () => {
    expect(scriptCount(rows)).toBe(3)
  })

  test("collapsed, it still shows each failing or down script, so nothing broken hides; open, every job it lists", () => {
    expect(scriptsShown(rows, false).map((row) => row.job)).toEqual(["ops-b", "ops-c"])
    expect(scriptsShown(rows, true).map((row) => row.job)).toEqual(["ops-a", "ops-b", "ops-c"])
  })

  test("on the collapsed rail it is one icon, red while a script it lists fails or is down, a paused one aside", () => {
    expect(scriptsRail(rows)).toEqual({ broken: true, words: "Scripts 3 · 2 failing or down" })
    expect(scriptsRail([job("ops-a"), job("ops-d", { paused: true, status: "down" })])).toEqual({
      broken: false,
      words: "Scripts 1",
    })
  })

  test("a Waiting script, with nothing to read yet, is not broken: the rail stays calm and the collapsed group hides it", () => {
    const waiting = [job("ops-a"), job("ops-usage", { reason: "no account", status: "waiting" })]
    expect(scriptsRail(waiting)).toEqual({ broken: false, words: "Scripts 2" })
    expect(scriptsShown(waiting, false)).toEqual([])
    expect(opsLine(waiting[1]!, 0)).toBe("Waiting: no account")
  })
})
