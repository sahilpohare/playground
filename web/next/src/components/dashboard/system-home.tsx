"use client"

import { RiRefreshLine, RiRestartLine, RiTerminalBoxLine } from "@remixicon/react"
import { useMutation } from "@tanstack/react-query"
import { cn } from "cn"
import * as React from "react"

import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { useDashboard } from "@/components/dashboard/dashboard"
import { NeedsYou } from "@/components/dashboard/needs-you"
import { NextUp } from "@/components/dashboard/next-up"
import { OwnerOnly } from "@/components/dashboard/owner-only"
import { PausedOps } from "@/components/dashboard/paused-ops"
import { SetupEmpty } from "@/components/dashboard/setup-empty"
import { StatusTable } from "@/components/dashboard/status-table"
import { HOLD_MS, rowsCookie, systemLoading } from "@/components/dashboard/system-loading"
import { SystemPanel } from "@/components/dashboard/system-panel"
import { PageHeader } from "@/components/shell/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { useInbox } from "@/lib/inbox"
import { rosterSetup, sessionsSetup } from "@/lib/setup"
import { restartHerdr } from "@/lib/system"

export const SYSTEM_DESCRIPTION =
  "What every agent is doing, what is queued, what needs you, and this machine's room."

// Restart herdr: stops every herdr server and starts them again, then the ops jobs, the Dashboard among them, so this page drops for a moment and reconnects once the Dashboard is back.
function RestartHerdr() {
  const [open, setOpen] = React.useState(false)
  const restart = useMutation({
    mutationFn: restartHerdr,
    onError: (error) => toast.add({ title: error.message, type: "error" }),
    onSettled: () => setOpen(false),
    onSuccess: () =>
      toast.add({
        title: "Restarting herdr",
        description: "Every session stops for a moment, then comes back with this page.",
        type: "success",
      }),
  })
  return (
    <>
      <Button variant="outline" className="text-xs" onClick={() => setOpen(true)}>
        <RiRestartLine />
        Restart herdr
      </Button>
      <ConfirmDialog
        action="Restart"
        description="Every herdr server stops and starts again, then the ops jobs. Each session and this Dashboard drop for a moment and come back with their conversations kept."
        onConfirm={() => restart.mutate()}
        onOpenChange={setOpen}
        open={open}
        pending={restart.isPending}
        title="Restart herdr?"
      />
    </>
  )
}

// The System page, which the sidebar's System item opens: every agent's status at a glance, live, then what is queued, what waits on you, the machine's room for more workers, and the ops jobs paused on purpose. A row opens that agent's own view, where its stream is. It moved here from /dashboard when the dashboard became your chat.
export function SystemHome({ storedRows: stored = null }: { storedRows?: number | null }) {
  const { allowed, board, problem, workers } = useDashboard()
  const { agents, data, error, isPending, refetch } = board
  // Only a refresh asked for spins the button; the half-minute re-read stays quiet.
  const [refreshing, setRefreshing] = React.useState(false)
  const refresh = async () => {
    setRefreshing(true)
    await refetch()
    setRefreshing(false)
  }
  const roster = data?.roster
  const rosterLine =
    roster && !roster.updatedAt && !roster.problem ? rosterSetup(roster.path) : null
  const inbox = useInbox(allowed)
  const [held, setHeld] = React.useState(true)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setHeld(false), HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [])
  const loading = systemLoading({
    agentsPending: isPending,
    inboxPending: inbox.isPending,
    failed: Boolean(error),
    held,
    sessionsPending: workers === null && !problem,
    stored,
  })
  // the rows the table shows, idle Others behind Show N idle and a facet's filter left out, are what the next load reserves
  const keepRows = React.useCallback((rows: number) => {
    try {
      document.cookie = rowsCookie(rows)
    } catch {}
  }, [])

  const refreshButton = (
    <Button
      variant="outline"
      className="text-xs"
      disabled={refreshing}
      onClick={() => void refresh()}
    >
      {refreshing ? <Spinner /> : <RiRefreshLine />}
      Refresh
    </Button>
  )

  if (!allowed) {
    return (
      <>
        <PageHeader title="System" description={SYSTEM_DESCRIPTION} />
        <OwnerOnly title="System is for the owner" why="It reads every session's transcript" />
      </>
    )
  }

  return (
    <>
      <PageHeader title="System" description={SYSTEM_DESCRIPTION} actions={<RestartHerdr />} />
      <div className="flex flex-col gap-6">
        {problem && (
          <Alert variant="destructive">
            <AlertTitle>Live sessions cannot be read</AlertTitle>
            <AlertDescription>{problem.message}</AlertDescription>
          </Alert>
        )}
        {data?.liveProblem && !problem && (
          <Alert variant="destructive">
            <AlertTitle>Live sessions cannot be read</AlertTitle>
            <AlertDescription>{data.liveProblem}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>The agents could not be read</AlertTitle>
            <AlertDescription>
              {error.message}{" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                Try again
              </button>
            </AlertDescription>
          </Alert>
        )}
        <section aria-labelledby="agents" className="flex flex-col gap-2">
          <h2 id="agents" className="text-muted-foreground text-sm font-medium">
            Agents
          </h2>
          {loading.agents === "reading" && stored ? (
            <StatusTable agents={[]} readingRows={stored} actions={refreshButton} />
          ) : loading.agents === "spinner" ? (
            <Spinner />
          ) : agents && agents.length === 0 ? (
            <SetupEmpty
              icon={RiTerminalBoxLine}
              setup={sessionsSetup(problem, data?.liveProblem)}
            />
          ) : (
            agents && <StatusTable agents={agents} onRows={keepRows} actions={refreshButton} />
          )}
        </section>
        {/* laid out while hidden, so each section holds its space and shows where it stays */}
        <div className={cn("contents", !loading.below && "invisible")} inert={!loading.below}>
          {/* the roster's notes come with the board, so they wait here below the table rather than push it down as they arrive */}
          {roster?.problem && (
            <Alert>
              <AlertTitle>Part of the roster did not read</AlertTitle>
              <AlertDescription className="wrap-anywhere">{roster.problem}</AlertDescription>
            </Alert>
          )}
          {rosterLine && (
            <p className="text-muted-foreground text-sm">
              {rosterLine.title}. {rosterLine.description}
            </p>
          )}
          <NextUp backlog={roster?.backlog ?? []} />
          <NeedsYou agents={agents ?? []} />
          <SystemPanel />
          {/* last, since it shows only once the ops jobs are read and only when one is paused, so its arrival moves nothing below it */}
          <PausedOps />
        </div>
      </div>
    </>
  )
}
