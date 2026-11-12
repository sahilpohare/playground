import { describe, expect, test } from "bun:test"

import { STREAM_SCROLL } from "../../../../../../web/next/src/components/dashboard/chat-scroll"
import {
  BAR_NEAR_PX,
  BAR_ROOM,
  ICON_TAB,
  MENU_TAB,
  PANES,
  SIDE_TOP,
  TAB_BAR,
  asideTabs,
  asideView,
  iconTabName,
  pageIcon,
  pageName,
} from "../../../../../../web/next/src/components/dashboard/dashboard-aside"
import { APP_SQUARE, dashboardApps, shownApps } from "../../../../../../web/next/src/lib/apps"
import { BAR_ITEM, FLOATING_BAR, GLASS } from "../../../../../../web/next/src/lib/floating-bar"

const source = (path: string) =>
  Bun.file(new URL(`../../../../../../web/next/src/${path}`, import.meta.url)).text()

const dispatcher = { name: "dispatcher", role: "dispatcher" as const }
const worker = { name: "k3m9px-worker", role: "worker" as const }
const APPS = ["changelog", "plan", "previews", "usage"] as const
const tabsOn = (pathname: string, selected: typeof dispatcher | typeof worker | null) =>
  asideTabs(asideView(pathname, selected, "dispatcher"), [])

describe("the aside window on every dashboard page", () => {
  test("holds the Inbox and Playground's chat beside Apps, Sessions, Settings, System and a thread", () => {
    for (const path of [
      "/dashboard/apps",
      "/dashboard/apps/changelog",
      "/dashboard/sessions",
      "/dashboard/sessions/abc",
      "/dashboard/settings",
      "/dashboard/system",
      "/dashboard/threads/mws9",
    ]) {
      expect(tabsOn(path, dispatcher)).toEqual(["inbox", "chat", "apps"])
      expect(tabsOn(path, null)).toEqual(["inbox", "chat", "apps"])
    }
  })

  // the Inbox, Changelog and Documents alone: the bar as DashboardAside builds it, from the default app squares
  test("holds the Inbox, Playground's chat, Changelog, Pages and Apps, and no parked app or Pull requests", () => {
    const bar = (selected: typeof dispatcher | typeof worker) =>
      asideTabs(
        asideView("/dashboard", selected, "dispatcher"),
        shownApps(dashboardApps(), { hidden: [], order: [] }).map((app) => app.id),
      )
    expect(bar(worker)).toEqual(["inbox", "chat", "changelog", "pages", "apps"])
    expect(bar(dispatcher)).toEqual(["inbox", "changelog", "pages", "apps"])
  })

  test("holds the Inbox and Pages on your chat, which is Playground's chat itself, Pull requests off the bar", () => {
    expect(tabsOn("/dashboard", dispatcher)).toEqual(["inbox", "pages", "apps"])
  })

  test("gives the second dispatcher's chat a session view's aside, the Inbox included, Playground's chat beside it (its slots, by role and name)", () => {
    const second = { name: "dispatcher-2", role: "dispatcher" as const }
    expect(asideView("/dashboard", second, "dispatcher")).toBe("agent")
    expect(asideTabs(asideView("/dashboard", second, "dispatcher"), [])).toEqual([
      "inbox",
      "chat",
      "pages",
      "apps",
    ])
  })

  test("holds the Inbox, Playground's chat and Pages on another session's view", () => {
    expect(tabsOn("/dashboard", worker)).toEqual(["inbox", "chat", "pages", "apps"])
  })

  // #i787: "The Apps squares (Linear, Plan, Previews, Usage, Changelog) leave the sidebar and join the aside's floating tab bar, after Inbox and Chat."
  test("takes your shown apps after the Inbox and the chat, in your order, and the Apps manager last", () => {
    expect(asideTabs("page", APPS)).toEqual(["inbox", "chat", ...APPS, "apps"])
    expect(asideTabs("home", ["usage", "plan"])).toEqual([
      "inbox",
      "usage",
      "plan",
      "pages",
      "apps",
    ])
    expect(asideTabs("agent", ["plan"])).toEqual(["inbox", "chat", "plan", "pages", "apps"])
  })

  test("puts each open page or document's tab after the session's tabs and before Apps, the Inbox first as ever", () => {
    const docs = ["doc:file-a1", "doc:page-report-2.html"] as const
    expect(asideTabs("page", APPS, docs)).toEqual(["inbox", "chat", ...APPS, ...docs, "apps"])
    expect(asideTabs("agent", [], docs)).toEqual(["inbox", "chat", "pages", ...docs, "apps"])
    expect(asideTabs("home", [], docs)[0]).toBe("inbox")
  })

  test("opens an app's square in the aside, beside the page, rather than going to its page", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toContain("<AppPane")
    expect(aside).not.toContain("app.href")
  })

  // #i787: "Changelog keeps its unread count on its square, and a phone shows the same squares in its bottom bar."
  test("puts each app's count of what is new on its square, the Changelog's unread changes", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toContain("useAppUnread(allowed)")
    expect(aside).toContain("const unread = unreadOf(app.id)")
    expect(aside).toContain("{ count: unread }")
  })

  // a click made only to clear the bar's dot
  test("counts on the Inbox square what needs you and came since your last look, so a look clears it", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toContain('const inboxSeenAt = useMark("inbox")')
    expect(aside).toContain("newInInboxCount(inboxView(loudItems(inbox.data)).shown, inboxSeenAt)")
    expect(aside).toContain('count > 0 ? `${count} new` : fresh.inbox && "new"')
    expect(aside).not.toContain("inbox.data?.count")
  })

  test("names a phone's page tab for its page", () => {
    expect(pageName("/dashboard/apps/plan")).toBe("Apps")
    expect(pageName("/dashboard/system")).toBe("System")
    expect(pageName("/dashboard/threads/mws9")).toBe("Thread")
  })

  // a thread is RiChatThreadLine wherever it shows
  test("gives a thread's page tab the thread icon, and any other page the window", async () => {
    const icons = (await import(
      Bun.resolveSync(
        "@remixicon/react",
        new URL("../../../../../../web/next", import.meta.url).pathname,
      )
    )) as Record<"RiChatThreadLine" | "RiWindowLine", ReturnType<typeof pageIcon>>
    expect(pageIcon("/dashboard/threads/mws9")).toBe(icons.RiChatThreadLine)
    expect(pageIcon("/dashboard/system")).toBe(icons.RiWindowLine)
  })

  test("is drawn once, by the dashboard's layout, around every dashboard page", async () => {
    const layout = await source("app/(protected)/dashboard/layout.tsx")
    expect(layout.match(/<DashboardAside[ >]/g)).toHaveLength(1)
    expect(await source("components/dashboard/dashboard-view.tsx")).not.toContain("<DashboardAside")
  })
})

// a reviewer: Update now sends from the sidebar, so on a phone the Chat tab must come forward to show it
describe("a message sent from outside the chat", () => {
  test("brings the phone's Chat tab forward once it joins the outbox", async () => {
    expect(await source("components/dashboard/dashboard-aside.tsx")).toContain(
      'if (seen.current && sentSince(seen.current, his)) setTab(home ? "page" : "chat")',
    )
  })
})

describe("the aside's tabs", () => {
  test("rest as far below the top as a sent message does in the chat, with less margin above the summary tab", () => {
    expect(SIDE_TOP).toBe(`pt-${STREAM_SCROLL.scrollMargin / 4}`)
  })

  test("name their top padding as --pane-top, so a stuck Changelog header covers it and no text shows above it", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toContain(
      `[--pane-top:--spacing(${SIDE_TOP.slice(3)})] [--pane-x:--spacing(5)] has-[[data-preview-frame]]:pb-0 sm:[--pane-x:--spacing(7)] \${SIDE_TOP}`,
    )
    expect(aside).toContain("pt-(--pane-top) [--pane-top:--spacing(1)]")
  })

  test("draw one square each, the Apps squares' own shape by import, so a neighbour never moves when a mark arrives", () => {
    expect(ICON_TAB.split(" ")).toEqual(expect.arrayContaining(APP_SQUARE.split(" ")))
    expect(ICON_TAB.split(" ")).toEqual(
      expect.arrayContaining([
        "border-0",
        "flex-none",
        "data-active:bg-foreground/10",
        "hover:bg-foreground/10",
        "focus-visible:ring-0",
        // the trigger's own focus outline goes too, so a focused square shows the fill alone (a reviewer's finding)
        "focus-visible:outline-none",
      ]),
    )
  })

  test("end, on a wide screen, with the user menu's initials square after a separator, not a tab of its own (#i959)", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toMatch(
      /\{squares\[value\]\}\s*<\/span>\s*\)\)\}\s*<SettingsSquare \/>\s*\{\/\*[^*]*\*\/\}\s*<Separator className="mx-1" orientation="vertical" \/>\s*<AsideUserMenu autoHide=\{autoHide\} onAutoHide=\{setAutoHideKept\} \/>\s*<\/TabsList>/,
    )
  })

  test("hold a Settings square after Apps on a wide screen and a phone, a link to the Settings page with its tooltip", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(
      aside.match(/\{squares\[value\]\}\s*<\/span>\s*\)\)\}\s*<SettingsSquare \/>/g),
    ).toHaveLength(2)
    expect(aside).toMatch(/<Hint content="Settings"[^>]*>\s*<Button\s+aria-label="Settings"/)
    expect(aside).toContain('render={<Link href="/dashboard/settings" />}')
    expect(aside).toContain("<RiSettings3Line />")
  })

  test("show the moment their bar does: no square transitions its visibility, which held a mounted one hidden after the bar showed", () => {
    const transitions = ICON_TAB.split(" ").filter((c) => c.startsWith("transition"))
    expect(transitions).toEqual(["transition-[color,background-color,border-color,box-shadow]"])
  })

  test(`sit in the table's floating selection bar's own look, at the bottom and with icons`, () => {
    expect(FLOATING_BAR.split(" ").sort()).toEqual([
      "backdrop-blur-md",
      "bg-popover/60",
      "border",
      "border-border",
      "flex",
      "gap-1",
      "items-center",
      "p-1",
      "pointer-events-auto",
      "rounded-md",
      "shadow-md",
    ])
    expect(TAB_BAR.split(" ")).toEqual(expect.arrayContaining(FLOATING_BAR.split(" ")))
    // the owner on #i949: "one glass, one way to light a control"
    expect(FLOATING_BAR.split(" ")).toEqual(expect.arrayContaining(GLASS.split(" ")))
    expect(ICON_TAB.split(" ")).toEqual(expect.arrayContaining(BAR_ITEM.split(" ")))
    expect(TAB_BAR.split(" ")).toContain("group-data-horizontal/tabs:h-auto")
  })

  // on a phone the Menu joins the bar
  test("on a phone end with the sidebar's Menu as a square of their own, and the shell's floating Menu leaves the dashboard", async () => {
    expect(await source("components/dashboard/dashboard-aside.tsx")).toContain(
      '<SidebarTrigger aria-label="Menu" className={MENU_TAB} />',
    )
    expect(await source("components/shell/sidebar-floating-trigger.tsx")).toContain(
      'if (!always && pathname.startsWith("/dashboard")) return null',
    )
  })

  test("below the owner rung, where no bar draws, keep the floating Menu on a phone", async () => {
    expect(await source("components/dashboard/dashboard-aside.tsx")).toMatch(
      /if \(!allowed\)\s*return \(\s*<div data-dashboard-page="" className="h-svh overflow-y-auto">\s*\{children\}\s*<SidebarFloatingTrigger always \/>\s*<\/div>/,
    )
  })

  test("keep Menu in view while the rest of the bar waits for the socket's first frame, so a dashboard that never connects still opens the sidebar", () => {
    expect(MENU_TAB.split(" ")).toEqual(expect.arrayContaining(["visible", ...ICON_TAB.split(" ")]))
  })

  test("keep one row and scroll sideways when they outgrow the bar's width, so the bar never grows up over a pane", () => {
    expect(TAB_BAR.split(" ")).toEqual(
      expect.arrayContaining(["justify-start", "max-w-full", "overflow-x-auto"]),
    )
    expect(TAB_BAR.split(" ")).not.toContain("flex-wrap")
  })

  // a bar that hides itself, shows on a hover near it, and is see-through rather than black, down to its bottom
  test("hide as a dock does: shut at first, shown while the pointer is within 96px of the bottom or a key has focus in it", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toContain("const [barHidden, setBarHidden] = useState(true)")
    expect(aside).toContain(
      "event.currentTarget.getBoundingClientRect().bottom - event.clientY > BAR_NEAR_PX",
    )
    expect(BAR_NEAR_PX).toBe(96)
    expect(aside).toContain("onPointerLeave={() => setBarHidden(true)}")
    // the viewer's portal bubbles through React, so its pointer near the bottom keeps the bar shut (#i949)
    expect(aside).toContain("if (!event.currentTarget.contains(event.target as Node)) return")
    expect(aside).toContain(
      "not-has-focus-visible:translate-y-[calc(100%+--spacing(3))] not-has-focus-visible:opacity-0",
    )
  })

  test("leave a handle while hidden that brings the bar back on hover or a click, with a dot while something is new", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    const handle = aside.slice(
      aside.indexOf('aria-label="Show tabs"'),
      aside.indexOf("</button>", aside.indexOf('aria-label="Show tabs"')),
    )
    expect(aside).toMatch(/\{hidden && \(\n\s+<button\n\s+type="button"\n\s+aria-label="Show tabs"/)
    expect(handle).toContain("onClick={() => setBarHidden(false)}")
    expect(handle).toContain("onPointerEnter={() => setBarHidden(false)}")
    // its dot is the squares' own red mark, so the bar draws one kind of dot (count-badge.test.ts)
    expect(handle).toContain("{(count > 0 || fresh.inbox) && <CountBadge />}")
  })

  // the tab bar can stay shown, by a choice kept in this browser
  test("stay shown by default and while Auto-hide tab bar is unticked in the user menu, kept for this browser", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    const menu = await source("components/dashboard/owner-menu.tsx")
    expect(aside).toContain('const AUTO_HIDE_KEY = "playground:aside:autoHide"')
    expect(aside).toContain("const hidden = autoHide && barHidden")
    expect(aside).toContain('setAutoHide(localStorage.getItem(AUTO_HIDE_KEY) === "1")')
    expect(aside).toContain('localStorage.setItem(AUTO_HIDE_KEY, on ? "1" : "0")')
    expect(aside).toContain("<AsideUserMenu autoHide={autoHide} onAutoHide={setAutoHideKept} />")
    expect(menu).toContain(
      "<DropdownMenuCheckboxItem checked={autoHide} onCheckedChange={onAutoHide}>",
    )
    expect(menu).toContain("Auto-hide tab bar")
  })

  // a reviewer: a phone's bar never hides, so its menu offers no Auto-hide
  test("offer Auto-hide on a wide screen alone, since a phone's bar is always shown", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    const menu = await source("components/dashboard/owner-menu.tsx")
    expect(aside).toMatch(/<AsideUserMenu \/>\s*\{\/\*[^*]*\*\/\}\s*<SidebarTrigger/)
    expect(
      aside.match(/<AsideUserMenu autoHide=\{autoHide\} onAutoHide=\{setAutoHideKept\} \/>/g),
    ).toHaveLength(1)
    expect(menu).toContain("{onAutoHide && (")
  })

  test("leave a kept-shown bar its room under each scrolling pane, so it never covers a pane's last line", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(aside).toContain("const paneBottom = autoHide ? PANE_BOTTOM : BAR_ROOM")
    expect(aside).toContain('"pt-(--pane-top) [--pane-top:--spacing(1)]"} ${paneBottom}`')
  })

  // no padding at the bottom
  test("show the pane under it through a see-through bar, each pane ending 12px under its last line and the chat keeping its 12px and its room", async () => {
    const aside = await source("components/dashboard/dashboard-aside.tsx")
    expect(TAB_BAR).toContain(GLASS)
    expect(aside).toContain('const bar = cn(TAB_BAR, !dispatchers && "invisible")')
    expect(aside).toContain('const CHAT_BOTTOM = "mb-3"')
    expect(aside).toContain('const PANE_BOTTOM = "pb-3"')
    expect(aside).toContain(
      "className={`relative flex h-full min-h-0 flex-col overflow-clip px-6 ${SIDE_TOP}`}",
    )
    expect(aside).toContain(
      '${value === "inbox" ? "-mt-3 has-[[data-preview-frame]]:pb-0" : "pt-(--pane-top) [--pane-top:--spacing(1)]"} ${paneBottom}`',
    )
    // a phone's Inbox pane drops its padding under the Preview frame too (a tester at 390)
    expect(aside).toContain(
      "pb-2 [--pane-top:--spacing(3)] [--pane-x:--spacing(5)] has-[[data-preview-frame]]:pb-0",
    )
    expect(aside).not.toContain("SIDE_BOTTOM")
  })

  test("the table's selection bar draws the same look", async () => {
    expect(await source("components/data-table.tsx")).toContain("cn(FLOATING_BAR,")
  })

  test("leave each pane room under its last line for the bar (a 32px square, p-1 and a border) and a 12px gap", () => {
    const room = Number(/^pb-(\d+)$/.exec(BAR_ROOM)?.[1]) * 4
    expect(room).toBeGreaterThanOrEqual(32 + 8 + 2 + 12)
  })

  test("stay above every pane, whose layers (a table's sticky header) stack inside the panes alone", () => {
    expect(PANES.split(" ")).toContain("isolate")
  })

  test("keep the tab's name first, with its marks in words after it", () => {
    expect(iconTabName("Inbox")).toBe("Inbox")
    expect(iconTabName("Inbox", [false, null])).toBe("Inbox")
    expect(iconTabName("Inbox", [false, "new"])).toBe("Inbox · new")
    expect(iconTabName("Inbox", ["3 waiting", false])).toBe("Inbox · 3 waiting")
    expect(iconTabName("Inbox", ["3 waiting", "new"])).toBe("Inbox · 3 waiting · new")
  })
})
