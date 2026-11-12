"use client"

import type { Worker } from "@api/hono"
import {
  RiApps2Line,
  RiChat3Line,
  RiChatThreadLine,
  RiInboxLine,
  RiPagesLine,
  RiRobot2Line,
  RiSettings3Line,
  RiWindowLine,
} from "@remixicon/react"
import { cn } from "cn"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { GroupImperativeHandle } from "react-resizable-panels"

import { AppManager } from "@/components/apps/app-manager"
import { AppPane } from "@/components/apps/app-pane"
import { AsideDocs, AsideDocsIcon, AsideDocsPane } from "@/components/dashboard/aside-docs"
import { SPLIT_MIN, letGo, splitCookie, type Split } from "@/components/dashboard/aside-split"
import { COMPOSER_ID, Composer, composerId } from "@/components/dashboard/composer"
import { CountBadge, cornerMarks } from "@/components/dashboard/count-badge"
import { useDashboard } from "@/components/dashboard/dashboard"
import { Inbox } from "@/components/dashboard/inbox"
import { AsideUserMenu } from "@/components/dashboard/owner-menu"
import { Pages } from "@/components/dashboard/pages"
import { useDotSources } from "@/components/dashboard/tab-dot"
import { WorkerStream } from "@/components/dashboard/worker-stream"
import { Hint } from "@/components/hint"
import { PAGE_PANE } from "@/components/shell/page-pane"
import { SidebarFloatingTrigger } from "@/components/shell/sidebar-floating-trigger"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { chatLabel } from "@/lib/agent-label"
import {
  APP_SQUARE,
  type DashboardAppId,
  dashboardApps,
  shownApps,
  useAppPrefs,
  writeAppPrefs,
} from "@/lib/apps"
import { type AsideDoc, closeDoc, type DocTab, docTab, openDoc } from "@/lib/aside-docs"
import { isPrimary } from "@/lib/dashboard"
import { BAR_ITEM, FLOATING_BAR } from "@/lib/floating-bar"
import { inboxTarget, inboxView, useInbox } from "@/lib/inbox"
import { feedNeeds, useNeedsYouTarget } from "@/lib/needs-you"
import { moveOldKeys } from "@/lib/old-keys"
import { sentSince } from "@/lib/outbox"
import { OPEN_PREVIEW, takeMove } from "@/lib/previews"
import {
  inboxMark,
  loudItems,
  newInInboxCount,
  useMark,
  useTabVisible,
  writeMark,
} from "@/lib/tab-dot"
import { useAppUnread } from "@/plugins/registry"

// A phone's width, read as the page renders rather than after it paints (useIsMobile's effect), so a page opened by a click draws its tabs or its halves once. The server, which has no width, draws the halves.
const PHONE = "(max-width: 767px)"

const onPhoneChange = (change: () => void) => {
  const query = window.matchMedia(PHONE)
  query.addEventListener("change", change)
  return () => query.removeEventListener("change", change)
}

const usePhone = () =>
  useSyncExternalStore(
    onPhoneChange,
    () => window.matchMedia(PHONE).matches,
    () => false,
  )

// An icon tab is one fixed square, the app squares' shape (APP_SQUARE, by import, not copied; the aside goes icon-first like the sidebar's apps), so its neighbours never move, and its corner marks sit outside the flow; bare of the trigger's own border, pill and shadow, which raised a square inside a box. Its transition leaves out the stock transition-all's visibility, so a square shows the moment its bar does, never a beat after.
export const ICON_TAB = `${APP_SQUARE} flex-none border-0 transition-[color,background-color,border-color,box-shadow] ${BAR_ITEM} focus-visible:outline-none group-data-[variant=default]/tabs-list:data-active:shadow-none`
// The bar's Settings square, after Apps: a link to the Settings page, which the user menu also lists.
const SettingsSquare = () => (
  <Hint content="Settings" description={null}>
    <Button
      aria-label="Settings"
      className={cn(APP_SQUARE, BAR_ITEM, "flex-none")}
      render={<Link href="/dashboard/settings" />}
      size="icon-sm"
      variant="ghost"
    >
      <RiSettings3Line />
    </Button>
  </Hint>
)
// a phone's Menu square stays visible while the bar waits for the socket's first frame, since it is the dashboard's only way into the sidebar there, so a dashboard that never connects still opens it
export const MENU_TAB = `visible ${ICON_TAB}`
// the bar the squares sit in, the table's floating selection bar's own look, grown past the list's stock h-8 to hold a square, its padding and its border; when the squares outgrow its width (a phone on a session's view, #i787) it keeps one row and scrolls sideways, since a second row would grow up over a pane's last line
export const TAB_BAR = `${FLOATING_BAR} group-data-horizontal/tabs:h-auto max-w-full justify-start overflow-x-auto [scrollbar-width:none]`
// An icon tab's name, its label with the marks it holds in words, on hover and to a screen reader (the issue: "each tab keeps its name as tooltip and accessible name").
export const iconTabName = (label: string, marks: Array<string | false | null> = []) =>
  [label, ...marks.filter((mark): mark is string => typeof mark === "string")].join(" · ")
// One square: its icon where its words were, named for its tooltip and screen readers, and one red corner mark: its count inside the dot, or the plain dot while something there is new.
const iconTab = (
  value: string,
  name: string,
  icon: ReactNode,
  { count = 0, dot = false }: { count?: number; dot?: boolean } = {},
) => {
  const marks = cornerMarks(count, dot)
  return (
    <Hint content={name} description={null}>
      <TabsTrigger value={value} aria-label={name} className={ICON_TAB}>
        {icon}
        {(marks.count || marks.dot) && <CountBadge count={count} />}
      </TabsTrigger>
    </Hint>
  )
}
// The space above the aside's panes, the 12px a sent message rests below the top of the chat (STREAM_SCROLL.scrollMargin; less margin above the summary tab, as in the chat).
export const SIDE_TOP = "pt-3"
// The dashboard's keys from before the rename move to their new names before anything below reads one.
if (typeof window !== "undefined") moveOldKeys(window.localStorage)

const AUTO_HIDE_KEY = "playground:aside:autoHide"
// the chat keeps the same 12px under its composer as above it; the scrolling panes run to the bottom edge, so no black band sits under the floating bar
const CHAT_BOTTOM = "mb-3"
// a wide screen's tab bar floats 12px over the aside's bottom edge, so each pane leaves the bar's 42px (a 32px square, p-1 and a border) and a 14px gap under its last line, the nearest step past 12px
export const BAR_ROOM = "pb-14"
// a scrolling pane ends 12px under its last line, as the aside starts 12px above its first: the bar hides until called and floats over it see-through, so it keeps no room of its own there; a bar kept shown (Auto-hide off) takes BAR_ROOM instead
const PANE_BOTTOM = "pb-3"
// how near the aside's bottom edge, in px, the pointer calls the hidden bar back, about twice the bar's own height
export const BAR_NEAR_PX = 96
// the wide screen's panes, laid in one cell; isolate stacks every layer a pane holds (a table's sticky z-10 header, which came after the bar and painted over it) inside the panes, so the bar's z-10 stays above them all
export const PANES =
  "isolate grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"

type SessionTab = "chat" | "inbox" | "pages"
// an app's square opens that app (#i787), by its id; apps is the Apps manager; a page or a document opened in the aside takes a tab of its own
export type AsideTab = SessionTab | DashboardAppId | "apps" | DocTab
// Your chat (/dashboard on Playground), another session's view (?worker=), or any other dashboard page.
export type AsideView = "agent" | "home" | "page"

// Pure: which view a page is, by its path and the session it selects.
export const asideView = (
  pathname: string,
  selected: Pick<Worker, "name" | "role"> | null,
  dispatcher: string | null,
): AsideView =>
  pathname !== "/dashboard" || !selected
    ? "page"
    : isPrimary(selected, dispatcher)
      ? "home"
      : "agent"

// The aside's session tabs on each view, in order (the Inbox and the chat on every page, only the session panes differing by view): the Inbox first everywhere, Playground's chat wherever the page is not already it, and a session's Pages only on its own view.
const SESSION_TABS: Record<AsideView, readonly SessionTab[]> = {
  agent: ["inbox", "chat", "pages"],
  home: ["inbox", "pages"],
  page: ["inbox", "chat"],
}

// Pure: the aside's tabs on a view, in order: the Inbox and the chat, then your shown apps in your order (#i787: "after Inbox and Chat"), so a square keeps its place from page to page, then the session's own tabs, then each page or document open in the aside in the order it opened, and the Apps manager last.
export const asideTabs = (
  view: AsideView,
  apps: readonly DashboardAppId[],
  docs: readonly DocTab[] = [],
): AsideTab[] => {
  const session = SESSION_TABS[view]
  const lead: SessionTab[] = session.filter((tab) => tab === "inbox" || tab === "chat")
  return [...lead, ...apps, ...session.filter((tab) => !lead.includes(tab)), ...docs, "apps"]
}

const PAGE_NAMES: Record<string, string> = {
  apps: "Apps",
  sessions: "Sessions",
  settings: "Settings",
  system: "System",
  threads: "Thread",
}

// Pure: a dashboard page's name on a phone's page tab, by its first segment under /dashboard.
export const pageName = (pathname: string): string =>
  PAGE_NAMES[pathname.split("/")[2] ?? ""] ?? "Page"

// Pure: a dashboard page's icon on a phone's page tab: a thread's own, else a page's.
export const pageIcon = (pathname: string) =>
  pathname.split("/")[2] === "threads" ? RiChatThreadLine : RiWindowLine

// Every dashboard page with the aside window beside it: its Inbox, Playground's chat, your apps and, on a session's own view, its Pages, then the Apps manager, in one resizable split the dashboard's layout draws once, so its sizes and its picked tab hold from page to page. A phone shows one at a time: the page's own tab first, then the aside's, in one bar at the bottom.
export function DashboardAside({ children, split }: { children: ReactNode; split: Split | null }) {
  const { allowed, approvals, asideChat, dispatcher, dispatchers, outbox, selected } =
    useDashboard()
  const pathname = usePathname()
  const view = asideView(pathname, selected, dispatcher)
  const splitRef = useRef<GroupImperativeHandle>(null)
  const prefs = useAppPrefs()
  const apps = dashboardApps()
  const shown = shownApps(apps, prefs)
  // the pages and documents open in the aside, for the page's life
  const [docs, setDocs] = useState<AsideDoc[]>([])
  const tabs = asideTabs(
    view,
    shown.map((app) => app.id),
    docs.map(docTab),
  ).filter((tab) => tab !== "chat" || asideChat)
  const home = view === "home"
  const inbox = useInbox(allowed)
  const mobile = usePhone()
  // a phone shows one tab at a time and opens each page on its own; a wide screen keeps its pick from page to page, Inbox first where the pick is not there
  const [pickedTab, setTab] = useState("page")
  const where = `${pathname}?${selected?.sessionId ?? ""}`
  const [shownAt, setShownAt] = useState(where)
  if (shownAt !== where) {
    setShownAt(where)
    setTab("page")
  }
  const tab = pickedTab === "page" || tabs.includes(pickedTab as AsideTab) ? pickedTab : "page"
  const [pickedSide, setSide] = useState<AsideTab>("inbox")
  // the bar hides as a dock does, shown only while the pointer is near the bottom or a key has focus in it
  const [barHidden, setBarHidden] = useState(true)
  // the bar hides as a dock unless the owner turns that off in its menu, kept for this browser; read after mount, so a bar kept shown starts hidden for one paint, the same as a server render would
  const [autoHide, setAutoHide] = useState(false)
  useEffect(() => setAutoHide(localStorage.getItem(AUTO_HIDE_KEY) === "1"), [])
  const hidden = autoHide && barHidden
  const paneBottom = autoHide ? PANE_BOTTOM : BAR_ROOM
  const setAutoHideKept = (on: boolean) => {
    setAutoHide(on)
    localStorage.setItem(AUTO_HIDE_KEY, on ? "1" : "0")
  }
  const side = tabs.includes(pickedSide) ? pickedSide : "inbox"
  // a page or a document opens in a tab of its own, or brings its open tab forward, on a phone too
  const openInAside = (doc: AsideDoc) => {
    const { tab: opened } = openDoc(docs, doc)
    setDocs((open) => openDoc(open, doc).docs)
    setTab(opened)
    setSide(opened)
  }
  // Playground's chat: the page itself on your chat, else the aside's Chat tab
  const showChat = () => {
    setTab(home ? "page" : "chat")
    if (!home) setSide("chat")
  }
  const primary = home ? selected : asideChat
  const handed = outbox.draft
  // words handed to the composer (Edit) bring Playground's chat forward and focus his box once it shows, on each hand alone, so a later render never takes the tab or the focus back
  useEffect(() => {
    if (!handed) return
    // words handed to the page's own session (Edit on its view) bring the page forward instead
    const page = handed.to !== primary?.name && selected?.name === handed.to
    if (page) setTab("page")
    else showChat()
    const box = page && selected ? composerId(selected, dispatcher) : COMPOSER_ID
    // the composer took the words while its tab was hidden, so its own focus missed
    requestAnimationFrame(() => document.getElementById(box)?.focus())
  }, [handed])
  // a message sent to Playground from elsewhere (Update now) brings a phone's chat forward; one from the page's own box stays there
  const seen = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const his = outbox.messages.filter((m) => m.to === primary?.name && !m.threadId)
    if (seen.current && sentSince(seen.current, his)) setTab(home ? "page" : "chat")
    seen.current = new Set(his.map((m) => m.id))
  }, [home, primary?.name, outbox.messages])
  // the brand's click opens the Inbox tab, whose Preview row it opens (openPreview)
  useEffect(() => {
    const open = () => {
      setTab("inbox")
      setSide("inbox")
    }
    window.addEventListener(OPEN_PREVIEW, open)
    return () => window.removeEventListener(OPEN_PREVIEW, open)
  }, [])
  // a brand click that moved the page ends on the Inbox, once the move has reset a phone's tab to the page; judged by the address, which every move changes, where `where` can stay
  const search = useSearchParams().toString()
  const at = `${pathname}${search ? `?${search}` : ""}`
  useEffect(() => {
    if (!takeMove(at)) return
    setTab("inbox")
    setSide("inbox")
  }, [at])
  // a link to an inbox item (a Waiting on your inbox badge, Playground's row, an answer's chip) opens the Inbox tab, where the list scrolls to it, a click opening a shut shelf's first
  useNeedsYouTarget(Boolean(inbox.data), (anchor) => {
    const { archived = [], items = [], snoozed = [] } = inbox.data ?? {}
    if (inboxTarget(anchor, [...items, ...archived, ...snoozed])) {
      setTab("inbox")
      setSide("inbox")
    }
    return true
  })

  // The inbox in front of a visible tab is a look at it, which clears the tab's dot for it (lib/tab-dot.ts).
  const visible = useTabVisible()
  const front = mobile ? tab : side
  const viewingInbox = visible && front === "inbox"
  const fresh = useDotSources()
  const inboxSeenAt = useMark("inbox")
  const unreadOf = useAppUnread(allowed)
  useEffect(() => {
    const mark = viewingInbox && inbox.data ? inboxMark(inbox.data.items) : null
    if (mark) writeMark("inbox", mark)
  }, [inbox.data, viewingInbox])

  if (!allowed)
    return (
      <div data-dashboard-page="" className="h-svh overflow-y-auto">
        {children}
        <SidebarFloatingTrigger always />
      </div>
    )

  // the bar counts what needs you and arrived since you last looked at the Inbox, so a look clears it with no answer given; what focus holds quiet counts once it ends
  const count = inbox.data
    ? newInInboxCount(inboxView(loudItems(inbox.data)).shown, inboxSeenAt)
    : 0
  // which squares show hangs on the socket's first frame (the view, Playground's chat), so the bar keeps its room but shows none until then, then all at once, never growing under the eye; an error frame sets dispatchers too, so a dashboard that cannot read its sessions still shows its Inbox
  const bar = cn(TAB_BAR, !dispatchers && "invisible")
  const squares: Partial<Record<AsideTab, ReactNode>> = {
    apps: iconTab("apps", "Apps", <RiApps2Line />),
    chat: asideChat && iconTab("chat", chatLabel(asideChat, dispatcher), <RiChat3Line />),
    inbox: iconTab(
      "inbox",
      iconTabName("Inbox", [count > 0 ? `${count} new` : fresh.inbox && "new"]),
      <RiInboxLine />,
      { count, dot: fresh.inbox },
    ),
    pages: iconTab("pages", "Pages", <RiPagesLine />),
  }
  for (const doc of docs)
    squares[docTab(doc)] = iconTab(docTab(doc), doc.name, <AsideDocsIcon doc={doc} />)
  for (const app of shown) {
    const unread = unreadOf(app.id)
    squares[app.id] = iconTab(
      app.id,
      iconTabName(app.title, [unread > 0 && `${unread} new`]),
      <app.icon />,
      { count: unread },
    )
  }
  const panes: Partial<Record<AsideTab, ReactNode>> = {
    apps: <AppManager apps={apps} onChange={writeAppPrefs} prefs={prefs} />,
    // the stream meets the composer with no gap, so a reply's last line ends langsdk's 36px above the box
    chat: asideChat && (
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkerStream
          key={asideChat.sessionId}
          needs={feedNeeds(asideChat, approvals)}
          now={new Date(inbox.dataUpdatedAt)}
          worker={asideChat}
        />
        <Composer key={asideChat.name} worker={asideChat} />
      </div>
    ),
    inbox: <Inbox viewing={viewingInbox} />,
    // holds the link to whatever the session generated, so closing the tab does not lose it
    pages: selected && <Pages all={home} session={selected.name} />,
  }
  for (const app of shown) panes[app.id] = <AppPane id={app.id} />
  for (const doc of docs)
    panes[docTab(doc)] = (
      <AsideDocsPane doc={doc} onClose={() => setDocs((open) => closeDoc(open, docTab(doc)))} />
    )

  // A phone: the page and each of the aside's panes laid in one cell, the bar in its own row under them rather than floating over the panels, which would cover a composer. The page and the chat stay mounted and laid out, invisible and inert, so a look at another tab keeps their place, their older steps and an upload in flight; the Inbox stays mounted, so a draft's edited words survive. Each aside pane sits 4px in from the edge its scroll box clips, so no focus ring is cut; relative, so the rows' sr-only text stays inside it and never lets the page scroll.
  if (mobile) {
    const PageIcon = pageIcon(pathname)
    const pageTab =
      view === "agent" && selected
        ? iconTab("page", chatLabel(selected, dispatcher), <RiRobot2Line />)
        : pathname === "/dashboard"
          ? iconTab("page", "Chat", <RiChat3Line />)
          : iconTab("page", pageName(pathname), <PageIcon />)
    return (
      <AsideDocs value={openInAside}>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(String(value))}
          className="grid h-svh grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto] pb-4 sm:pb-6"
        >
          <TabsList className={`row-start-2 justify-self-center ${bar} max-w-[calc(100%-2rem)]`}>
            {pageTab}
            {tabs.map((value) => (
              <span key={value} className="contents">
                {squares[value]}
              </span>
            ))}
            <SettingsSquare />
            <Separator className="mx-1" orientation="vertical" />
            <AsideUserMenu />
            {/* the sidebar's Menu joins the bar as its last square, in place of the shell's floating button */}
            <SidebarTrigger aria-label="Menu" className={MENU_TAB} />
          </TabsList>
          <TabsContent
            value="page"
            keepMounted
            hidden={false}
            data-dashboard-page=""
            className={cn("col-start-1 row-start-1 data-hidden:invisible", PAGE_PANE)}
          >
            {children}
          </TabsContent>
          {tabs.map((value) =>
            value === "chat" ? (
              <TabsContent
                key={value}
                value={value}
                keepMounted
                hidden={false}
                className="col-start-1 row-start-1 flex min-h-0 flex-col px-4 data-hidden:invisible sm:px-6"
              >
                {panes.chat}
              </TabsContent>
            ) : (
              <TabsContent
                key={value}
                value={value}
                keepMounted={value === "inbox"}
                className={`relative col-start-1 row-start-1 min-h-0 overflow-y-auto px-(--pane-x) pb-2 [--pane-top:--spacing(3)] [--pane-x:--spacing(5)] has-[[data-preview-frame]]:pb-0 sm:[--pane-x:--spacing(7)] ${SIDE_TOP}`}
              >
                {panes[value]}
              </TabsContent>
            ),
          )}
        </Tabs>
      </AsideDocs>
    )
  }

  // A wide screen: the page on the left, scrolling on its own, and the aside on the right in the Changelog's halves, its panes laid in one cell so the chat keeps its place behind another tab, each leaving room under its last line for the bar that floats over them.
  // the group's own inline height is 100%, which beats a class, so a box of the screen's height holds it and a long page scrolls inside its half; the server, which has no width, draws these halves, so below md the handle and the aside hide and the page takes the full width (important, past the panels' inline styles) until the phone's tabs take over
  return (
    <div className="h-svh max-md:[&>div>:first-child]:basis-full! max-md:[&>div>:not(:first-child)]:hidden!">
      <ResizablePanelGroup
        groupRef={splitRef}
        orientation="horizontal"
        defaultLayout={split ?? undefined}
        // a drag let go near the middle settles on it, and the cookie keeps where the owner let go for the next load
        onLayoutChanged={(layout, { isUserInteraction, requestedLayout }) => {
          if (!isUserInteraction) return
          const page = requestedLayout?.page ?? layout.page ?? 50
          const kept = letGo(page)
          if (kept !== page) splitRef.current?.setLayout({ aside: 50, page: 50 })
          document.cookie = splitCookie(kept)
        }}
      >
        <ResizablePanel id="page" defaultSize="50%" minSize={`${SPLIT_MIN}%`}>
          <div data-dashboard-page="" className={cn("h-full", PAGE_PANE)}>
            {children}
          </div>
        </ResizablePanel>
        {/* the grip is the drawer handle's bar stood on end, so the two read as one kind of handle */}
        <ResizableHandle
          withHandle
          className="hover:[&>div]:bg-muted-foreground focus-visible:[&>div]:bg-muted-foreground [&>div]:bg-muted-foreground/40 [&>div]:h-10 [&>div]:rounded-sm"
        />
        <ResizablePanel id="aside" defaultSize="50%" minSize={`${SPLIT_MIN}%`}>
          <AsideDocs value={openInAside}>
            <Tabs
              value={side}
              onValueChange={(value) => setSide(value as AsideTab)}
              // clips the hidden bar, which slides below the edge, as clip and not hidden, since code can scroll a hidden box: a row jump to a low card or a focus below the edge scrolled it and left the bar and its handle up the aside until a remount
              className={`relative flex h-full min-h-0 flex-col overflow-clip px-6 ${SIDE_TOP}`}
              // a portal's pointer (the viewer opened from a card) bubbles here through React, so only the aside's own DOM counts
              onPointerMove={(event) => {
                if (!event.currentTarget.contains(event.target as Node)) return
                setBarHidden(
                  event.currentTarget.getBoundingClientRect().bottom - event.clientY > BAR_NEAR_PX,
                )
              }}
              onPointerLeave={() => setBarHidden(true)}
            >
              {/* first, so Tab reaches the squares before a pane, and floating at the bottom as the table's selection bar does */}
              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-6 transition-[opacity,translate] duration-200",
                  hidden &&
                    "not-has-focus-visible:translate-y-[calc(100%+--spacing(3))] not-has-focus-visible:opacity-0",
                )}
              >
                <TabsList className={bar}>
                  {tabs.map((value) => (
                    <span key={value} className="contents">
                      {squares[value]}
                    </span>
                  ))}
                  <SettingsSquare />
                  {/* as tall as the squares, the separator's own stretch */}
                  <Separator className="mx-1" orientation="vertical" />
                  <AsideUserMenu autoHide={autoHide} onAutoHide={setAutoHideKept} />
                </TabsList>
              </div>
              {/* while the bar hides, a drawer handle marks where it comes back on hover, with a dot while something is new; a handle, since an up caret read as scroll to top */}
              {hidden && (
                <button
                  type="button"
                  aria-label="Show tabs"
                  className="group/handle focus-visible:ring-ring/50 absolute bottom-0 left-1/2 z-10 -translate-x-1/2 rounded-sm px-4 py-2 outline-none focus-visible:ring-2"
                  onClick={() => setBarHidden(false)}
                  onPointerEnter={() => setBarHidden(false)}
                >
                  {/* rounded-sm on a 4px bar draws the pill; the dot is the squares' own red mark (CountBadge) at its end */}
                  <span className="bg-muted-foreground/40 group-hover/handle:bg-muted-foreground relative block h-1 w-10 rounded-sm">
                    {(count > 0 || fresh.inbox) && <CountBadge />}
                  </span>
                </button>
              )}
              <div className={PANES}>
                {tabs.map((value) => (
                  <TabsContent
                    key={value}
                    value={value}
                    keepMounted={value === "inbox" || value === "chat"}
                    {...(value === "chat" ? { hidden: false } : {})}
                    className={
                      value === "chat"
                        ? `col-start-1 row-start-1 flex min-h-0 flex-col px-1 data-hidden:invisible ${BAR_ROOM} ${CHAT_BOTTOM}`
                        : // the Inbox rises over the aside's top padding, so its sticky first row sits at the top edge; the other panes keep a 4px top their sticky rows cover (--pane-top)
                          `relative col-start-1 row-start-1 -mx-6 min-h-0 overflow-y-auto px-(--pane-x) [--pane-x:--spacing(7)] ${value === "inbox" ? "-mt-3 has-[[data-preview-frame]]:pb-0" : "pt-(--pane-top) [--pane-top:--spacing(1)]"} ${paneBottom}`
                    }
                  >
                    {panes[value]}
                  </TabsContent>
                ))}
              </div>
            </Tabs>
          </AsideDocs>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
