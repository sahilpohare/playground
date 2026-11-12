"use client"

import { RiRobot2Line } from "@remixicon/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQueryState } from "nuqs"
import { useEffect } from "react"

import { FEED_LABELS } from "@/components/dashboard/app-sidebar"
import { Composer } from "@/components/dashboard/composer"
import { useDashboard } from "@/components/dashboard/dashboard"
import { OwnerOnly } from "@/components/dashboard/owner-only"
import { ReadOnlyLine } from "@/components/dashboard/read-only-line"
import { WorkerStream } from "@/components/dashboard/worker-stream"
import { CheckedLine, ChecksCard, readChecks } from "@/components/first-run/checks"
import { HarnessCards } from "@/components/first-run/harness-cards"
import { AddAccountDialog } from "@/components/settings/add-account-dialog"
import { SET_UP_SETTINGS_WHY, SetUpSettings } from "@/components/settings/set-up-settings"
import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { CenterSpinner, Spinner } from "@/components/ui/spinner"
import { ACCOUNTS_QUERY_KEY, readAccounts } from "@/lib/accounts"
import { chatLabel, hasChat, homeTitle } from "@/lib/agent-label"
import { config } from "@/lib/config"
import { liveState, type LiveState } from "@/lib/dashboard"
import { firstRunView, type FirstRunView } from "@/lib/first-run"
import {
  ALPHA_QUERY_KEY,
  canStart,
  HARNESSES_QUERY_KEY,
  type HarnessId,
  readAlpha,
  readHarnesses,
  saveAlpha,
} from "@/lib/harness"
import { inboxWaiting, useInbox } from "@/lib/inbox"
import { cardHref, feedNeeds, hashAnchor } from "@/lib/needs-you"
import { ONBOARD_QUERY_KEY, refusalOf } from "@/lib/onboard"

const HOME_DESCRIPTION = "Your chat: what you ask, and what the factory reports."

// Pure: what the home says once the board is read and no dispatcher's chat can open. While the feed reconnects the board is its last read, so it says so in the sidebar's words rather than that the dispatcher is not running; while a restore still brings sessions back after a restart, it says the factory is coming back.
export const noChat = (
  live: LiveState,
  title: string,
  restoring = false,
): { title: string; why: string } =>
  live === "Reconnecting"
    ? {
        title: FEED_LABELS.Reconnecting,
        why: "The last read showed no dispatcher. This page updates once the feed is back.",
      }
    : restoring
      ? {
          title: "The factory is coming back",
          why: `Your sessions are coming back after a restart. ${title}'s chat opens here once it is running.`,
        }
      : { title: `${title} is not running`, why: `${title}'s chat opens here once it is running.` }

// Pure: what the home shows while no dispatcher's chat is open, the first that holds of: the neutral frame until the board is read, the checks' failed read, the checks, the feed reconnecting, a restore still bringing sessions back (no Start, since the restore brings the dispatcher back itself), then the steps. First run leads whatever the board holds, since a fresh Mac runs no session yet.
export const homeOf = ({
  boardRead,
  checksFailed,
  live,
  restoring = false,
  view,
}: {
  boardRead: boolean
  checksFailed: boolean
  live: LiveState
  restoring?: boolean
  view: FirstRunView
}): "checks" | "error" | "frame" | "reconnecting" | "restoring" | "steps" => {
  if (!boardRead) return "frame"
  if (checksFailed) return "error"
  if (view === "checks") return "checks"
  if (live === "Reconnecting") return "reconnecting"
  if (restoring && view === "steps") return "restoring"
  return view
}

// The home's onboarding rows in order, each ticked once done; Start shows once all are. The Claude account row is Claude Code's alone, so a Codex pick drops it.
export const CHECKLIST_STEPS = ["github", "settings", "harness", "account"] as const
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number] | "start"

// Pure: the onboarding checklist while no dispatcher runs: which rows are ticked, the one row whose button is active (the first undone one, Start once all are done), and whether Start shows. The harness row is done once the picked harness's card reads Installed and Signed in with nothing refusing its start. Until every fact is read (none undefined, the pick included) it is not known: nothing is ticked or live, and the home draws a neutral frame in its place, so no step shows on a guess.
export const checklistOf = (facts: {
  claude?: boolean
  github?: boolean
  harness?: boolean
  login?: boolean
  pick?: HarnessId
}): {
  active: ChecklistStep | null
  known: boolean
  rows: { done: boolean; step: (typeof CHECKLIST_STEPS)[number] }[]
  start: boolean
} => {
  const read = {
    account: facts.claude,
    github: facts.github,
    harness: facts.harness,
    settings: facts.login,
  }
  const steps = CHECKLIST_STEPS.filter((step) => step !== "account" || facts.pick !== "codex")
  const known = facts.pick !== undefined && steps.every((step) => read[step] !== undefined)
  const rows = steps.map((step) => ({ done: known && read[step] === true, step }))
  const next = rows.find((row) => !row.done)?.step
  const start = known && next === undefined
  return { active: known ? (next ?? "start") : null, known, rows, start }
}

// A row's action shows while it is undone, and a kept one (the harness cards, whose pick can change until Start) once it is done too.
type ChecklistRow = {
  action?: React.ReactNode
  done: string
  kept?: boolean
  title: string
  todo?: string
}

const START_URL = `${config.api.url}/api/v1/dashboard/dispatcher/start`

// The first run's steps once this Mac's checks are done and no dispatcher runs: GitHub signed in, settings set up, the harness picked from its cards (harness.alpha, saved at your login's scope), a Claude account added for Claude Code, each ticked once done with only the first undone row's button live, then Start <dispatcher> on the pick, which asks the API to start it and shows a refusal's words whole beneath it, wrapped and selectable, where the owner clicked; the chat replaces this once its session is live. GitHub reads done from the done mark, which gh's sign-in check holds back until it passes.
function Checklist({ name }: { name: string }) {
  const queryClient = useQueryClient()
  const accounts = useQuery({ queryFn: readAccounts, queryKey: ACCOUNTS_QUERY_KEY })
  const alpha = useQuery({ queryFn: readAlpha, queryKey: ALPHA_QUERY_KEY })
  const harnesses = useQuery({ queryFn: readHarnesses, queryKey: HARNESSES_QUERY_KEY })
  const pick = useMutation({
    mutationFn: (id: HarnessId) => saveAlpha(id, accounts.data?.scope ?? ""),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ALPHA_QUERY_KEY }),
  })
  const picked = pick.isPending ? pick.variables : alpha.data
  const cards = harnesses.data
  const start = useMutation({
    mutationFn: async () => {
      const response = await fetch(START_URL, { credentials: "include", method: "POST" })
      if (response.ok) return
      throw new Error(refusalOf(await response.json().catch(() => null), response.status))
    },
  })
  const list = checklistOf({
    claude: accounts.data?.accounts.some((account) => account.provider === "claude"),
    github: true,
    harness: cards && picked ? canStart(cards, picked) : undefined,
    login: accounts.data?.login,
    pick: picked,
  })
  const label = cards?.find((card) => card.id === picked)?.label
  const rows: Record<(typeof CHECKLIST_STEPS)[number], ChecklistRow> = {
    account: {
      action: (
        <AddAccountDialog
          disabled={list.active !== "account"}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY })}
          trigger={<Button size="sm" />}
        >
          Add a Claude account
        </AddAccountDialog>
      ),
      done: "Added.",
      title: "Claude account",
      todo: `${name} runs on a Claude account, kept in this Mac's Keychain.`,
    },
    github: { done: "Signed in.", title: "GitHub" },
    harness: {
      action:
        list.active !== null && !["github", "settings"].includes(list.active) && cards && picked ? (
          <div className="flex w-full flex-col gap-2">
            <HarnessCards
              cards={cards}
              onPick={(id) => pick.mutate(id)}
              onSettled={() => void harnesses.refetch()}
              pick={picked}
            />
            {pick.error && <p className="text-destructive text-xs">{pick.error.message}</p>}
          </div>
        ) : undefined,
      done: `${label ?? "It"} is installed and signed in.`,
      kept: true,
      title: "Harness",
      todo: `Pick what ${name} runs on. Start turns on once it is installed and signed in.`,
    },
    settings: {
      action:
        list.active === "settings" ? (
          <SetUpSettings inline />
        ) : (
          <Button size="sm" disabled>
            Set up settings
          </Button>
        ),
      done: "Set up.",
      title: "Settings",
      todo: SET_UP_SETTINGS_WHY,
    },
  }
  const failed = accounts.error ?? alpha.error ?? harnesses.error
  if (failed)
    return (
      <EmptyDescription className="text-xs">
        The setup steps could not be read: {failed.message.replace(/\.$/, "")}. Reload the page to
        try again.
      </EmptyDescription>
    )
  if (!list.known) return <div aria-busy="true" className="h-48 w-full" />
  return (
    <>
      <ol aria-label="Set up" className="flex w-full flex-col gap-4 text-left">
        {list.rows.map(({ done, step }, index) => {
          const row = rows[step]
          return (
            <li key={step} className="flex gap-3">
              <span aria-hidden className="text-muted-foreground w-4 shrink-0 font-mono text-sm">
                {done ? "✓" : index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">
                    {row.title}
                    <span className="sr-only">{done ? ", done" : ", to do"}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">{done ? row.done : row.todo}</p>
                </div>
                {(!done || row.kept) && row.action}
              </div>
            </li>
          )
        })}
      </ol>
      {list.start && config.hosted && <ReadOnlyLine />}
      {list.start && !config.hosted && (
        <Button disabled={start.isPending || start.isSuccess} onClick={() => start.mutate()}>
          {(start.isPending || start.isSuccess) && <Spinner />}
          Start {name}
        </Button>
      )}
      {start.error && (
        <p
          role="alert"
          className="text-destructive text-xs break-words whitespace-pre-wrap select-text"
        >
          {start.error.message}
        </p>
      )}
    </>
  )
}

// The home while no dispatcher's chat can open: what it says, anything under it, and the System link.
function NoChat({
  children,
  title,
  why,
}: {
  children?: React.ReactNode
  title: string
  why: string
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiRobot2Line />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{why}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {children}
        <EmptyDescription className="text-xs">
          Every agent&apos;s state is on the <Link href="/dashboard/system">System</Link> page.
        </EmptyDescription>
      </EmptyContent>
    </Empty>
  )
}

// /dashboard: your chat with the dispatcher, the dashboard's home, since the owner talks to the dispatcher alone, or with ?worker= that session's own view: its steps as they happen with its Feed prompts under the latest step, and for a dispatcher, the assistant or a session the dashboard hosts a composer under them (hasChat). The aside window beside it (DashboardAside) holds the Inbox, Playground's chat on another session's view, and the session's Pages. A session the URL names that has ended shows your chat; every agent's status is on the System page.
export function DashboardView() {
  const {
    allowed,
    approvals,
    connected,
    dispatcher,
    feedProblem,
    problem,
    restoring,
    selected,
    workers,
  } = useDashboard()
  const title = homeTitle(dispatcher)
  const [requested] = useQueryState("worker")
  const inbox = useInbox(allowed)
  const router = useRouter()
  const checks = useQuery({
    enabled: allowed && !selected,
    queryFn: readChecks,
    queryKey: ONBOARD_QUERY_KEY,
  })

  // A link to a card with no ?worker= (a bookmark from when /dashboard was the status table) goes on to the session whose view holds that card, unless your chat holds it.
  useEffect(() => {
    if (requested || !workers || !inbox.data) return
    const href = cardHref(
      hashAnchor(window.location.hash),
      inboxWaiting(inbox.data.items),
      workers,
      dispatcher,
    )
    const here = selected ? `/dashboard?worker=${encodeURIComponent(selected.sessionId)}#` : null
    if (href && !(here && href.startsWith(here))) router.replace(href)
  }, [dispatcher, inbox.data, requested, router, selected, workers])

  if (!allowed) {
    return (
      <PageShell size="lg">
        <PageHeader title="Dashboard" description={HOME_DESCRIPTION} />
        <OwnerOnly
          title="The dashboard is for its owner"
          why="Its pages read every session's transcript"
        />
      </PageShell>
    )
  }

  // While no dispatcher is live, the page keeps the heading your chat will have, for screen readers alone as your chat's is, and its chat's top edge (no top padding), so nothing moves when the chat arrives; until the API names the dispatcher, it has none.
  if (!selected) {
    const live = liveState(connected, workers, feedProblem)
    const empty = noChat(live, title ?? "The dispatcher", restoring)
    const home = homeOf({
      boardRead: workers !== null || problem !== null,
      checksFailed: Boolean(checks.error),
      live,
      restoring,
      view: firstRunView({ done: checks.data?.done, gate: "normal", signedIn: true }),
    })
    // the chat's own frame while it loads, so the spinner centres where the chat's will and never moves when the chat arrives: Load older's 48px row above it, and under it the scroll bar's 36px row and the composer's box (74px from md up, 78px below it) with its 8px margin, less the shell's bottom padding (16px, 24px from sm up)
    const frame = (
      <div className="relative mt-12 mb-26.5 flex-1 sm:mb-24.5 md:mb-23.5">
        <CenterSpinner />
      </div>
    )
    return (
      <PageShell size="full" className="relative flex h-full flex-col pt-0 sm:pt-0 md:px-7">
        {title && <h1 className="sr-only">{title}</h1>}
        {/* the empty state sits mid-page, as the spinner before it does */}
        <div className="flex flex-1 flex-col justify-center gap-4">
          {home === "error" ? (
            <NoChat
              title={empty.title}
              why={`This Mac's checks could not be read: ${checks.error?.message.replace(/\.$/, "")}. Reload the page to try again.`}
            />
          ) : home === "checks" && checks.data ? (
            <div className="flex justify-center">
              <ChecksCard
                checking={checks.isFetching}
                read={checks.data}
                recheck={() => void checks.refetch()}
                signedIn
              />
            </div>
          ) : home === "reconnecting" || home === "restoring" ? (
            <NoChat title={empty.title} why={empty.why} />
          ) : home === "steps" ? (
            <NoChat title={empty.title} why={empty.why}>
              <CheckedLine />
              <Checklist name={title ?? "the dispatcher"} />
            </NoChat>
          ) : (
            frame
          )}
        </div>
      </PageShell>
    )
  }

  // No header: the stream starts at the top, and the heading stays for screen readers alone. No top padding, so steps scroll off the very top edge, and no bottom padding, the composer keeping its own 12px; a phone's tab bar sits under it. From md up 28px each side, so a focus ring's 3px is never cut. The stream meets the composer with no gap, so a reply's last line ends langsdk's 36px above the box.
  return (
    <PageShell size="full" className="flex h-full flex-col py-0 sm:py-0 md:px-7">
      <h1 className="sr-only">{chatLabel(selected, dispatcher)}</h1>
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkerStream
          key={selected.sessionId}
          needs={feedNeeds(selected, approvals)}
          now={new Date(inbox.dataUpdatedAt)}
          worker={selected}
        />
        {hasChat(selected) ? <Composer key={selected.name} worker={selected} /> : null}
      </div>
    </PageShell>
  )
}
