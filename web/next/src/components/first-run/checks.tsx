"use client"

import { site } from "@packages/config/site"
import { cn } from "cn"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { config } from "@/lib/config"
import {
  CHECKS_REQUEST,
  type Check,
  type ChecksRead,
  checksOf,
  checksPath,
  deviceLabel,
  type FixJob,
  fixJobOf,
  linesOf,
  markOf,
  needOf,
  refusalOf,
  runnable,
  settled,
} from "@/lib/onboard"

export const ONBOARD_URL = `${config.api.url}/api/v1/onboard`
export const NO_API = "The app's server did not answer; it may be restarting"
const POLL_MS = 1_000

// GET the checks read, first run's by the done mark or Settings' live one; a refusal's words are thrown, so a query shows them.
const fetchChecks = async (live: boolean): Promise<ChecksRead> => {
  const response = await fetch(`${ONBOARD_URL}/${checksPath({ live })}`, CHECKS_REQUEST).catch(
    () => undefined,
  )
  if (!response) throw new Error(NO_API)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(refusalOf(body, response.status))
  const read = checksOf(body)
  if (!read) throw new Error("The checks did not read as a list")
  return read
}
export const readChecks = () => fetchChecks(false)
export const readLiveChecks = () => fetchChecks(true)

// POST or GET one fix: its read, or a refusal's words. The owner's cookie goes only once one is signed in; before that the API takes this Mac alone.
const fixCall = async (id: string, method: "GET" | "POST", signedIn: boolean) => {
  const response = await fetch(`${ONBOARD_URL}/fix/${encodeURIComponent(id)}`, {
    cache: "no-store",
    credentials: signedIn ? "include" : "omit",
    method,
  }).catch(() => undefined)
  if (!response) return NO_API
  const body = await response.json().catch(() => null)
  if (!response.ok) return refusalOf(body, response.status)
  return fixJobOf(body) ?? "The fix did not read as one"
}

// A row's fix: its button, then while it runs its last lines and a sign-in's link with its one-time code where it has one (gh's with Open GitHub, Codex's), read again every second; once it settles the checks are read again, and a failure says why.
function FixButton({
  action,
  onSettled,
  signedIn,
}: {
  action: NonNullable<Check["action"]>
  onSettled: () => void
  signedIn: boolean
}) {
  const [job, setJob] = useState<FixJob>()
  const [refused, setRefused] = useState<string>()
  const running = job?.state === "running"

  useEffect(() => {
    if (!running) return
    const timer = setInterval(async () => {
      const read = await fixCall(action.id, "GET", signedIn)
      if (typeof read === "string") return setRefused(read)
      setJob(read)
      if (settled(read)) onSettled()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [action.id, onSettled, running, signedIn])

  const start = async () => {
    setRefused(undefined)
    const read = await fixCall(action.id, "POST", signedIn)
    if (typeof read === "string") return setRefused(read)
    setJob(read)
    if (settled(read)) onSettled()
  }

  const failure = refused ?? (job?.state === "failed" ? job.reason : null)
  return (
    <div className="col-start-3 flex min-w-0 flex-col items-start gap-1 sm:col-end-5">
      <Button variant="outline" size="sm" disabled={running} onClick={start}>
        {running && <Spinner />}
        {action.label}
      </Button>
      {running && job.device && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {job.device.code && (
            <>
              <span className="text-muted-foreground">Your one-time code</span>
              <span className="font-mono">{job.device.code}</span>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            render={<a href={job.device.url} rel="noreferrer" target="_blank" />}
          >
            {deviceLabel(action.id)}
          </Button>
        </div>
      )}
      {running && linesOf(job).length > 0 && (
        <p className="text-muted-foreground font-mono text-xs break-all whitespace-pre-line">
          {linesOf(job).join("\n")}
        </p>
      )}
      {failure && <p className="text-destructive text-xs">{failure}</p>}
    </div>
  )
}

// One check as a row: its mark, its name and what it found; while it is not ok, its plain words and what it is for, and the fix the app runs for it, if any.
export function CheckRow({
  check,
  onSettled,
  signedIn,
}: {
  check: Check
  onSettled: () => void
  signedIn: boolean
}) {
  const action = runnable(check)
  const need = needOf(check)
  return (
    <li className="grid grid-cols-[1rem_6rem_1fr] items-baseline gap-x-2 gap-y-1 text-sm sm:grid-cols-[1rem_6rem_1fr_auto]">
      <span
        aria-hidden="true"
        className={cn(check.status === "MISSING" ? "text-destructive" : "text-muted-foreground")}
      >
        {markOf(check.status)}
      </span>
      <span className="font-mono">{check.name}</span>
      <span className="text-muted-foreground">{check.detail}</span>
      {need && (
        <span className="text-muted-foreground col-start-3 text-xs sm:col-start-4">{need}</span>
      )}
      {check.note && (
        <p className="text-muted-foreground col-start-3 text-xs sm:col-end-5">{check.note}</p>
      )}
      {action && <FixButton action={action} onSettled={onSettled} signedIn={signedIn} />}
    </li>
  )
}

// The pane's first card, "Let's check this Mac": every check with its mark, a fix button where the app has one, and Re-check; once the done mark is written it is one ✓ line. Before sign-in its footer holds Continue, which the caller gives, so the card stays whole even once done.
export function ChecksCard({
  checking,
  footer,
  read,
  recheck,
  signedIn,
}: {
  checking: boolean
  footer?: React.ReactNode
  read: ChecksRead
  recheck: () => void
  signedIn: boolean
}) {
  if (read.done && !footer) return <CheckedLine />
  return (
    <Card className="w-full max-w-2xl text-left">
      <CardHeader>
        <CardTitle>
          <h2>Let&apos;s check this Mac</h2>
        </CardTitle>
        <CardDescription>
          {`${site.name} needs these on this Mac. Each one missing that ${site.name} can set up has a button that does it for you.`}
        </CardDescription>
      </CardHeader>
      <CardContent aria-live="polite" className="grid gap-4">
        {read.done ? (
          <CheckedLine />
        ) : (
          <ul aria-label="Checks" className="grid gap-3">
            {read.checks.map((check) => (
              <CheckRow key={check.name} check={check} onSettled={recheck} signedIn={signedIn} />
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {!read.done && (
          <Button variant="outline" disabled={checking} onClick={recheck}>
            {checking && <Spinner />}
            Re-check
          </Button>
        )}
        {footer}
      </CardFooter>
    </Card>
  )
}

// The checks once the done mark is written: one ✓ line.
export function CheckedLine() {
  return (
    <p className="text-muted-foreground flex w-full max-w-2xl gap-3 text-left text-sm">
      <span aria-hidden="true" className="w-4 font-mono">
        ✓
      </span>
      This Mac has everything {site.name} needs.
    </p>
  )
}
