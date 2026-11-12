// First run: the doctor's checks of this Mac (GET /api/v1/onboard/checks) and the fixes the app runs for them (/api/v1/onboard/fix/:id), shown in /dashboard's pane until the done mark is written, and in Settings while one is still missing.

export type CheckStatus = "MISSING" | "ok" | "optional" | "waiting"

// One check as the API answers it: what it found, what it is needed for, the fix the app runs for it (a settings action is a step, not a fix), and plain words while it is not ok.
export type Check = {
  action: { id: string; label: string } | null
  detail: string
  name: string
  need: string | null
  note: string | null
  status: CheckStatus
}

// The checks read: every row, or none once the done mark is written, and the mark itself.
export type ChecksRead = { checks: Check[]; done: boolean }

// One fix as the API reads it back: its last output lines, a sign-in's link and one-time code (none for Claude Code's) while it waits for the owner, and a failure's reason.
export type FixJob = {
  device: { code: string | null; url: string } | null
  id: string
  lines: string[]
  reason: string | null
  state: "failed" | "idle" | "ok" | "running"
}

export const ONBOARD_QUERY_KEY = ["onboard", "checks"] as const
export const LIVE_CHECKS_QUERY_KEY = [...ONBOARD_QUERY_KEY, "live"] as const

// Pure: the checks route; live, as Settings reads it, runs every probe whatever the done mark says and never writes it, so what is missing after first run still shows.
export const checksPath = ({ live }: { live: boolean }): string =>
  live ? "checks?live=1" : "checks"

// The checks' request carries no cookie: in setup mode the API answers it before any user exists, and its CORS allows no credentials.
export const CHECKS_REQUEST: RequestInit = { cache: "no-store" }

// The settings row's action, which the steps after sign-in take, never the fix runner.
export const SETTINGS_ACTION = "settings"

const STATUSES: CheckStatus[] = ["MISSING", "ok", "optional", "waiting"]
const JOB_STATES: FixJob["state"][] = ["failed", "idle", "ok", "running"]

const isText = (value: unknown): value is string => typeof value === "string"
const isTextOrNull = (value: unknown) => value === null || isText(value)

const isCheck = (value: unknown): value is Check => {
  const check = value as Partial<Check> | null
  const action = check?.action as Check["action"] | undefined
  return (
    isText(check?.name) &&
    isText(check.detail) &&
    STATUSES.includes(check.status as CheckStatus) &&
    isTextOrNull(check.need) &&
    isTextOrNull(check.note) &&
    (action === null || (isText(action?.id) && isText(action.label)))
  )
}

// Pure: the checks read in GET /api/v1/onboard/checks's body, in the API's order, or undefined when it does not read as one.
export const checksOf = (body: unknown): ChecksRead | undefined => {
  const data = (body as { data?: { checks?: unknown; done?: unknown } } | null)?.data
  return Array.isArray(data?.checks) && data.checks.every(isCheck) && typeof data.done === "boolean"
    ? { checks: data.checks, done: data.done }
    : undefined
}

// Pure: whether first run can go on, no row missing or waiting; an optional one never holds it.
export const canContinue = (checks: Check[]): boolean =>
  checks.every((check) => check.status !== "MISSING" && check.status !== "waiting")

// Pure: the fix a row offers that the app runs, none once it is ok or for the settings step.
export const runnable = (check: Check): Check["action"] =>
  check.status !== "ok" && check.action && check.action.id !== SETTINGS_ACTION ? check.action : null

// Pure: each row still missing or offering a fix the app runs, in the API's order, which Settings lists.
export const toFix = (checks: Check[]): Check[] =>
  checks.filter((check) => check.status === "MISSING" || runnable(check) !== null)

// Pure: the fix read in GET or POST /api/v1/onboard/fix/:id's body, or undefined when it does not read as one; a read with no device reads as none.
export const fixJobOf = (body: unknown): FixJob | undefined => {
  const job = (body as { data?: Partial<FixJob> } | null)?.data
  const device = job?.device ?? null
  return isText(job?.id) &&
    Array.isArray(job.lines) &&
    job.lines.every(isText) &&
    isTextOrNull(job.reason) &&
    JOB_STATES.includes(job.state as FixJob["state"]) &&
    (device === null || (isTextOrNull(device.code) && isText(device.url)))
    ? ({ ...job, device } as FixJob)
    : undefined
}

// Pure: the button that opens a sign-in's page: GitHub's for gh, the sign-in page for the harnesses'.
export const deviceLabel = (id: string): string =>
  id === "gh-login" ? "Open GitHub" : "Open the sign-in page"

// Pure: whether a fix has ended, so the checks are read again.
export const settled = (job: FixJob): boolean => job.state === "ok" || job.state === "failed"

// Pure: the last lines of a fix's output the pane shows, none while a sign-in waits on the owner, since its link and code say it in the app's words and its lines speak to a terminal.
export const linesOf = (job: FixJob): string[] => (job.device ? [] : job.lines.slice(-3))

// Pure: Settings' heading over the rows still missing.
export const fixTitle = (count: number): string =>
  `${count} ${count === 1 ? "thing" : "things"} to fix`

// Pure: the mark a row leads with, ✓ found, ✗ missing, ○ optional and not found, – waiting on another check.
export const markOf = (status: CheckStatus): string =>
  ({ MISSING: "✗", ok: "✓", optional: "○", waiting: "–" })[status]

// Pure: what a check that is not ok is for: "needed: <need>" or "optional: <need>".
export const needOf = (check: Check): string | undefined => {
  if (!check.need) return undefined
  if (check.status === "MISSING") return `needed: ${check.need}`
  if (check.status === "optional") return `optional: ${check.need}`
  return undefined
}

// Pure: the error message in an API envelope, else the status in words.
export const refusalOf = (body: unknown, status: number): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? `The API answered ${status}`
