import type { Agent, OpsReport, Plan, PlanLane, Worker } from "@api/hono"

import { statusOf } from "@/lib/agents"
import { apiClient, unwrap } from "@/lib/api/client"

export const REPORT_QUERY_KEY = ["apps", "plan", "report"] as const

export async function fetchReport() {
  const { data, error } = await unwrap(apiClient.v1.apps.plan.report.$get())
  if (error) throw new Error(error.message)
  return data
}

// What one lane is doing now, in the parts its sentence is built from: who (the lane's worker), on what (the item in flight under that worker, else the lane's next item), that item's outcome line, its pull request, the worker's status in the Dashboard's words, and the item's estimate. availability is what the board says of the worker, so a lane the plan shows nothing in flight on never calls a busy or down worker free: busy while it works or waits, down once its session is gone or ended, free while idle, and null when the board does not hold it.
export type Availability = "busy" | "down" | "free"

export type LaneNow = {
  availability: Availability | null
  estimate: string | null
  inFlight: boolean
  item: string | null
  lane: string
  outcome: string | null
  pr: string | null
  status: string | null
  worker: string | null
}

const AVAILABILITY: Record<Agent["state"], Availability> = {
  down: "down",
  idle: "free",
  "needs-you": "busy",
  unknown: "busy",
  working: "busy",
}

// Pure: a lane's Now line. The worker's status comes from its agent on the Dashboard's board (Working, Fixing, Ready), in the sidebar's words: workers, the socket's records, give a paused light its usage limit, so the word is the sidebar light's (Paused · usage limit, not Stuck); a worker the board does not hold shows none.
export function laneNow(
  lane: PlanLane,
  plan: Plan,
  agents: Agent[] | undefined,
  now: number,
  workers: Worker[] | null = null,
): LaneNow {
  const worker = lane.worker ?? null
  const flying = worker ? plan.inFlight.find((entry) => entry.worker === worker) : undefined
  const next = lane.items[0]
  const id = flying?.id ?? next?.id ?? null
  const item = id ? (lane.items.find((entry) => entry.id === id) ?? null) : null
  const agent = worker ? agents?.find((candidate) => candidate.name === worker) : undefined
  const live = agent
    ? { worker: workers?.find((w) => w.sessionId === agent.sessionId) ?? null }
    : {}
  return {
    availability: agent ? AVAILABILITY[agent.state] : null,
    estimate: item?.estimateRange ?? null,
    inFlight: Boolean(flying),
    item: id,
    lane: lane.title,
    outcome: flying?.outcome ?? next?.outcome ?? null,
    pr: flying ? (flying.pr ?? item?.pr ?? agent?.pr?.url ?? null) : (item?.pr ?? null),
    status: agent ? statusOf(agent, now, null, false, live).text : null,
    worker,
  }
}

// Pure: how many things a report says need attention, in words.
export const attentionCount = (report: OpsReport): string =>
  report.findings.length === 0
    ? "Nothing"
    : `${report.findings.length} ${report.findings.length === 1 ? "item" : "items"}`

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

// Pure: the newest moment a report's health was read, from the readings whose now is a time; null when none is.
export function healthReadAt(report: OpsReport): string | null {
  const times = report.health
    .map((entry) => entry.now)
    .filter((value): value is string => Boolean(value && ISO_TIME.test(value)))
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
  if (times.length === 0) return null
  return new Date(Math.max(...times.map((date) => date.getTime()))).toISOString()
}
