import { reachesConsole } from "@packages/auth/access"
import type { Metadata } from "next"
import { cookies, headers } from "next/headers"

import { ApiRetry } from "@/components/common/api-retry"
import {
  DashboardDispatchers,
  DashboardMark,
  DashboardNav,
  DashboardStats,
} from "@/components/dashboard/app-sidebar"
import { DashboardProvider } from "@/components/dashboard/dashboard"
import { OwnerMenuProvider } from "@/components/dashboard/owner-menu"
import { RelayGate } from "@/components/dashboard/relay-gate"
import { DashboardFooter } from "@/components/dashboard/sidebar"
import { TabDot } from "@/components/dashboard/tab-dot"
import { FirstRun, SignInKept } from "@/components/first-run/first-run"
import { SidebarShell } from "@/components/shell/sidebar-shell"
import { YardLive } from "@/components/yard/yard-live"
import { auth } from "@/lib/auth"
import { sessionOrUnavailable, UNAVAILABLE } from "@/lib/auth/session"
import { config } from "@/lib/config"
import { gateOf, readSetup } from "@/lib/first-run"
import { dispatcherSlotsOf, readHealth } from "@/lib/health"
import { localPagesOnly } from "@/lib/local-pages"
import { thisMachine } from "@/lib/machine"
import { tabTitle, testDataBadge, vibeBadge } from "@/lib/test-data"

// The API's word on where the dashboard's data comes from: a fixture stack wears the Test data badge beside the brand and in the tab's title, a Vibeground its own with its branch. A read that fails or is slow shows none.
const readBadge = async () => {
  const health = await readHealth()
  return testDataBadge(health) ?? vibeBadge(health)
}

export async function generateMetadata(): Promise<Metadata> {
  const badge = await readBadge()
  return { title: { absolute: tabTitle(badge) } }
}

// Past the cookie cache, like the console's own gate. The Console cross-link is drawn from this, and the browser holds a session snapshot for the cache window, so a cached read leaves someone you just promoted unable to see the console they now have: the link is how they would find it, and /console already lets them in. Costs a session lookup on the API side of a round trip that happens anyway.
const readSession = () =>
  sessionOrUnavailable(() => auth.api.getSession({ disableCookieCache: true }))

// Once the API answers its setup route 404 it stays the normal app for the life of this process, so a normal stack asks once.
let normal = false

export default async function Layout({ children }: { children: React.ReactNode }) {
  // the hosted build reads its session first, so the owner rung decides before anything else is read
  const hosted = config.hosted ? await readSession() : null
  if (hosted === UNAVAILABLE) return <ApiRetry />
  localPagesOnly(config.hosted, hosted?.user ?? null)
  // First run comes before any session read: with no database the API serves only its setup routes, so the first-run pane stands in for the dashboard. The hosted build has no first run.
  if (!normal && !config.hosted) {
    const gate = gateOf(await readSetup(config.api.internalUrl || config.api.url))
    if (gate === "setup") return <FirstRun gate="setup" />
    normal = gate === "normal"
  }
  const session = config.hosted ? hosted : await readSession()

  if (session === UNAVAILABLE) return <ApiRetry />
  if (!session?.user) return <FirstRun gate="normal" />

  if (!session.session.activeOrganizationId) {
    const cookieStore = await cookies()
    const lastOrgId = cookieStore.get(`last-active-org_${session.user.id}`)?.value
    if (lastOrgId) {
      const url = `${config.api.internalUrl || config.api.url}/api/auth/organization/set-active`
      const reqHeaders = Object.fromEntries((await headers()).entries())
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...reqHeaders, "content-type": "application/json" },
          body: JSON.stringify({ organizationId: lastOrgId }),
        })
        if (!response.ok) {
          console.error(
            `failed to restore active organization: ${response.status} ${response.statusText}`,
          )
        }
      } catch (error) {
        console.error("failed to restore active organization", error)
      }
    }
  }

  const badge = await readBadge()
  const machine = thisMachine(await readHealth())

  const shell = (
    // The dashboard has no use for organizations, so the sidebar carries its live status and its sessions (manager, workers, runners) instead of the org switcher.
    <DashboardProvider allowed={reachesConsole(session.user, "owner")}>
      <TabDot />
      <SignInKept />
      {/* the hosted build pushes Yard's channel counts down its socket rather than polling them (channelsEvery), so the dashboard holds the socket there as Yard's own shell does */}
      {config.hosted && <YardLive />}
      <SidebarShell
        badge={badge}
        mark={<DashboardMark />}
        opensPreview
        stats={<DashboardStats />}
        header={<DashboardDispatchers rows={dispatcherSlotsOf(await readHealth())} />}
        nav={<DashboardNav account={session.user.login ?? session.user.id} />}
        footer={<DashboardFooter />}
      >
        <OwnerMenuProvider canAccessConsole={reachesConsole(session.user)} machine={machine}>
          {children}
        </OwnerMenuProvider>
      </SidebarShell>
    </DashboardProvider>
  )
  // the hosted build draws the dashboard only while the owner's Mac holds the relay
  return config.hosted ? <RelayGate>{shell}</RelayGate> : shell
}
