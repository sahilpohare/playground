import { unlink } from "node:fs/promises"
import { join } from "node:path"

import { apiUp, dashboardCheckout, dashboardUrls } from "../playground/probe"
import { writeAtomic } from "../write-atomic"
import type { Context } from "./tick"

// A live dashboard roll measured 15s down and a failed restart cycle about 2.5 minutes, so 5 minutes in a row is an outage no restart is fixing.
export const DASHBOARD_DOWN_MINUTES = 5

// This watch's beat runs every minute (its `* * * * *` cron in tick.ts's BEATS), so a last down reading 3 or more minutes old is 2 missed beats: ops-tick or the machine stopped in between.
export const STALE_MINUTES = 3

type DashboardWatch = { downSince: string; lastDownAt?: string; told?: boolean }

// The live dashboard's API answering 200 on /api/health, as `playground` reads it.
const dashboardUp = async (ctx: Context): Promise<boolean> => {
  const dashboard = dashboardCheckout(ctx.repo)
  return !!dashboard && apiUp(dashboardUrls(dashboard))
}

// Through the ops relay to ops, and as a macOS banner, since the Inbox shows only on the Dashboard that is down.
const banner = async (ctx: Context, text: string) => {
  const notify = join(ctx.repo, "scripts", "ops", "notify.sh")
  const sent = await ctx.run(["env", "NOTIFY_MAC=1", "bash", notify, "tick", text], 30_000)
  if (sent.code !== 0) throw new Error(`notify.sh: ${sent.out.trim().slice(0, 200)}`)
}

// An ISO time as a person reads it in a banner, to the minute: 2026-11-16 06:47 UTC.
const utcMinute = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`

const minutesSince = (ctx: Context, since: string): number =>
  Math.floor((ctx.now.getTime() - Date.parse(since)) / 60_000)

// A run this run of ops-tick did not see: its last down reading is STALE_MINUTES or more old, or either time is unreadable.
const stale = (ctx: Context, state: DashboardWatch): boolean => {
  const last = state.lastDownAt ?? state.downSince
  return (
    Number.isNaN(Date.parse(state.downSince)) ||
    Number.isNaN(Date.parse(last)) ||
    minutesSince(ctx, last) >= STALE_MINUTES
  )
}

// Each minute: the run of failures is kept in tick/dashboard-watch.json, one banner goes out once the dashboard has failed DASHBOARD_DOWN_MINUTES in a row, and one more when it answers again; an answer, or a stale run (stale), ends the run before then, quietly unless it was told, when the answer names the last down reading in place of a count no one saw.
export const dashboardWatch = async (ctx: Context, up = dashboardUp) => {
  const statePath = join(ctx.ops, "tick", "dashboard-watch.json")
  const state = (await Bun.file(statePath)
    .json()
    .catch(() => null)) as DashboardWatch | null
  if (await up(ctx)) {
    if (!state) return
    if (state.told)
      await banner(
        ctx,
        stale(ctx, state)
          ? `The Dashboard answers again; its last down reading was at ${utcMinute(state.lastDownAt ?? state.downSince)}, and ops-tick read nothing between`
          : `The Dashboard answers again, after ${minutesSince(ctx, state.downSince)} minutes down`,
      )
    await unlink(statePath)
    return
  }
  const now = ctx.now.toISOString()
  const run: DashboardWatch = !state || stale(ctx, state) ? { downSince: now } : state
  const down = minutesSince(ctx, run.downSince)
  if (!run.told && down >= DASHBOARD_DOWN_MINUTES) {
    await banner(ctx, `The Dashboard has not answered for ${down} minutes`)
    run.told = true
  }
  await writeAtomic(statePath, JSON.stringify({ ...run, lastDownAt: now }))
}
