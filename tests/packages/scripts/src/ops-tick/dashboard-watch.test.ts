import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DASHBOARD_DOWN_MINUTES,
  dashboardWatch,
  STALE_MINUTES,
} from "../../../../../packages/scripts/src/ops-tick/dashboard-watch"
import { BEATS, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"
import { fakeRun } from "./fake-run"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const scratch = (): string => {
  const ops = join(mkdtempSync(join(tmpdir(), "dashboard-watch-")), "dispatcher", "ops")
  dirs.push(join(ops, "..", ".."))
  mkdirSync(ops, { recursive: true })
  return ops
}

const NOTIFY = "/repo/scripts/ops/notify.sh"

// A fresh context each minute, as a restarted ops-tick would have: what it keeps between minutes is on disk alone; notify.sh is never run, only recorded.
const minute = async (ops: string, m: number, up: boolean, banners: string[]) => {
  const { run, runs } = fakeRun()
  const ctx: Context = {
    now: new Date(Date.UTC(2026, 9, 20, 10, 48 + m, 10)),
    ops,
    repo: "/repo",
    run,
    send: async () => true,
  }
  await dashboardWatch(ctx, async () => up)
  for (const argv of runs)
    if (argv[0] === "env" && argv[1] === "NOTIFY_MAC=1" && argv.indexOf(NOTIFY) > 0)
      banners.push(argv.at(-1)!)
}

test(`one banner once the Dashboard has failed ${DASHBOARD_DOWN_MINUTES} minutes in a row, one when it answers again, and none in between (#1361)`, async () => {
  const ops = scratch()
  const banners: string[] = []
  for (let m = 0; m < DASHBOARD_DOWN_MINUTES; m++) await minute(ops, m, false, banners)
  expect(banners).toEqual([])
  await minute(ops, DASHBOARD_DOWN_MINUTES, false, banners)
  expect(banners).toEqual([`The Dashboard has not answered for ${DASHBOARD_DOWN_MINUTES} minutes`])
  for (let m = DASHBOARD_DOWN_MINUTES + 1; m < 107; m++) await minute(ops, m, false, banners)
  expect(banners).toHaveLength(1)
  await minute(ops, 107, true, banners)
  expect(banners.at(-1)).toBe("The Dashboard answers again, after 107 minutes down")
  await minute(ops, 108, true, banners)
  expect(banners).toHaveLength(2)
})

test("a minute's answer ends the run of failures, so a short roll tells no one", async () => {
  const ops = scratch()
  const banners: string[] = []
  for (let m = 0; m < 4; m++) await minute(ops, m, false, banners)
  await minute(ops, 4, true, banners)
  for (let m = 5; m < 9; m++) await minute(ops, m, false, banners)
  expect(banners).toEqual([])
})

test("a gap with no check, as the Mac asleep or ops-tick down, starts the run of failures again", async () => {
  const ops = scratch()
  const banners: string[] = []
  await minute(ops, 0, false, banners)
  for (let m = 60; m < 60 + DASHBOARD_DOWN_MINUTES; m++) await minute(ops, m, false, banners)
  expect(banners).toEqual([])
  await minute(ops, 60 + DASHBOARD_DOWN_MINUTES, false, banners)
  expect(banners).toEqual([`The Dashboard has not answered for ${DASHBOARD_DOWN_MINUTES} minutes`])
})

// PG-2417: ops-tick stopped for a test run from 16:31 to 16:38Z, and its first minute back sent "answers again, after 597 minutes down" from the run it told at 06:47Z.
const toldThenStopped = async (ops: string, banners: string[]) => {
  for (let m = 0; m <= DASHBOARD_DOWN_MINUTES; m++) await minute(ops, m, false, banners)
  expect(banners).toEqual([`The Dashboard has not answered for ${DASHBOARD_DOWN_MINUTES} minutes`])
}

test("a told run gone stale while ops-tick was stopped answers with its last down reading, never a count of minutes it did not see", async () => {
  const ops = scratch()
  const banners: string[] = []
  await toldThenStopped(ops, banners)
  await minute(ops, DASHBOARD_DOWN_MINUTES + 8, true, banners)
  expect(banners.at(-1)).toBe(
    "The Dashboard answers again; its last down reading was at 2026-10-20 10:53 UTC, and ops-tick read nothing between",
  )
  await minute(ops, DASHBOARD_DOWN_MINUTES + 9, true, banners)
  expect(banners).toHaveLength(2)
})

test(`a last down reading ${STALE_MINUTES - 1} minutes old is this run's own, and ${STALE_MINUTES} minutes old is stale`, async () => {
  const fresh = scratch()
  const banners: string[] = []
  await toldThenStopped(fresh, banners)
  await minute(fresh, DASHBOARD_DOWN_MINUTES + STALE_MINUTES - 1, true, banners)
  expect(banners.at(-1)).toBe(
    `The Dashboard answers again, after ${DASHBOARD_DOWN_MINUTES + STALE_MINUTES - 1} minutes down`,
  )
  const old = scratch()
  const late: string[] = []
  await toldThenStopped(old, late)
  await minute(old, DASHBOARD_DOWN_MINUTES + STALE_MINUTES, true, late)
  expect(late.at(-1)).toBe(
    "The Dashboard answers again; its last down reading was at 2026-10-20 10:53 UTC, and ops-tick read nothing between",
  )
})

test("a told run whose last down reading does not read as a time is stale, so it sends no count", async () => {
  const ops = scratch()
  mkdirSync(join(ops, "tick"), { recursive: true })
  writeFileSync(
    join(ops, "tick", "dashboard-watch.json"),
    JSON.stringify({ downSince: "2026-10-20T10:48:10.000Z", lastDownAt: "soon", told: true }),
  )
  const banners: string[] = []
  await minute(ops, 1, true, banners)
  expect(banners).toHaveLength(1)
  expect(banners[0]).toStartWith("The Dashboard answers again; its last down reading was at")
})

test("a run gone stale before it was told ends quietly on an answer", async () => {
  const ops = scratch()
  const banners: string[] = []
  for (let m = 0; m < 3; m++) await minute(ops, m, false, banners)
  await minute(ops, 10, true, banners)
  expect(banners).toEqual([])
})

test("a told run gone stale starts a fresh run on a down reading, told again only after its own minutes down", async () => {
  const ops = scratch()
  const banners: string[] = []
  await toldThenStopped(ops, banners)
  const back = DASHBOARD_DOWN_MINUTES + 8
  for (let m = back; m < back + DASHBOARD_DOWN_MINUTES; m++) await minute(ops, m, false, banners)
  expect(banners).toHaveLength(1)
  await minute(ops, back + DASHBOARD_DOWN_MINUTES, false, banners)
  expect(banners.at(-1)).toBe(
    `The Dashboard has not answered for ${DASHBOARD_DOWN_MINUTES} minutes`,
  )
  await minute(ops, back + DASHBOARD_DOWN_MINUTES + 1, true, banners)
  expect(banners.at(-1)).toBe(
    `The Dashboard answers again, after ${DASHBOARD_DOWN_MINUTES + 1} minutes down`,
  )
})

test("a line notify.sh fails to queue is sent again the next minute", async () => {
  const ops = scratch()
  for (let m = 0; m < DASHBOARD_DOWN_MINUTES; m++) await minute(ops, m, false, [])
  const failing: Context = {
    now: new Date(Date.UTC(2026, 9, 20, 10, 48 + DASHBOARD_DOWN_MINUTES, 10)),
    ops,
    repo: "/repo",
    run: fakeRun({ "notify.sh": { code: 1, err: "notify.sh: no outbox\n" } }).run,
    send: async () => true,
  }
  await expect(dashboardWatch(failing, async () => false)).rejects.toThrow("notify.sh")
  const banners: string[] = []
  await minute(ops, DASHBOARD_DOWN_MINUTES + 1, false, banners)
  expect(banners).toEqual([
    `The Dashboard has not answered for ${DASHBOARD_DOWN_MINUTES + 1} minutes`,
  ])
})

test("the beat runs every minute", () => {
  expect(BEATS.find((b) => b.name === "dashboard-watch")?.cron).toBe("* * * * *")
})
