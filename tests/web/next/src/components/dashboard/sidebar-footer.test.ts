import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// The sidebar's layout is the shell's order (header, then nav, then footer) filled by the dashboard's layout, and the footer's own order; each part is a server or client component that needs a session to render, so their wiring is read from the source.
const web = join(import.meta.dir, "../../../../../../web/next/src")
const read = (path: string) => Bun.file(join(web, path)).text()

const shell = await read("components/shell/sidebar-shell.tsx")
const layout = await read("app/(protected)/layout.tsx")
const footer = await read("components/dashboard/sidebar.tsx")
const dashboard = await read("components/dashboard/app-sidebar.tsx")

const order = (text: string, ...needles: string[]) => {
  const at = needles.map((needle) => text.indexOf(needle))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect(at).toEqual(at.toSorted((a, b) => a - b))
}

describe("the sidebar's rows", () => {
  // #i787: the Apps squares leave the sidebar for the aside's tab bar
  test("hold no Apps group", async () => {
    expect(layout).not.toContain("AppsNav")
    expect(await Bun.file(join(web, "components/apps/sidebar.tsx")).exists()).toBe(false)
  })

  // the dispatchers' patches need no title and sit in the header.
  test("the dispatchers' rows sit in the header under the title row, with no group title or count", () => {
    expect(layout).toContain(
      "header={<DashboardDispatchers rows={dispatcherSlotsOf(await readHealth())} />}",
    )
    expect(layout).toContain(
      "nav={<DashboardNav account={session.user.login ?? session.user.id} />}",
    )
    order(shell, "{site.name}", "{header}", "</SidebarHeader>", "<SidebarContent>{nav}")
    expect(dashboard).not.toContain('label === "Dispatchers" ? (')
    expect(dashboard).not.toContain("function DispatchersGroup")
    const rows = dashboard.slice(
      dashboard.indexOf("export function DashboardDispatchers"),
      dashboard.indexOf("export const dispatcherSlotsShown"),
    )
    expect(rows).toContain("row(worker, [], view, muted, { action, label, trailing })")
    expect(rows).toContain("<DispatcherUsage")
    expect(rows).not.toContain("<SidebarGroup")
    expect(rows).not.toContain("<GroupCount")
  })

  // the sidebar rail makes the toggle redundant, so GitHub takes its place and the machine stats move up into the room it leaves
  test("the title row holds the system icons then GitHub, in the toggle's place, all hidden on the collapsed rail; the rail toggles", () => {
    expect(shell).not.toContain("<SidebarTrigger")
    order(shell, "{site.name}", "{stats}", "{mark}", "<SidebarToggleRail />")
    const row = shell.slice(
      shell.lastIndexOf("<div", shell.indexOf("@container")),
      shell.indexOf("{header}"),
    )
    expect(row).toContain("group-data-[collapsible=icon]:hidden")
    // the icons join the row only by its width and the badge, never by a reading, so a sample landing moves nothing
    expect(row).toContain("@container")
    expect(row).toContain("@min-[238px]:[:not(:has([data-slot=badge]))>&]:row-start-1")
    expect(layout).toContain("mark={<DashboardMark />}")
    expect(layout).toContain("stats={<DashboardStats />}")
    order(
      dashboard,
      "export function DashboardMark",
      "<GithubMark",
      "export function DashboardStats",
      "<SystemIcons",
    )
    const group = dashboard.slice(
      dashboard.indexOf("export function DashboardDispatchers"),
      dashboard.indexOf("export const dispatcherSlotsShown"),
    )
    expect(group).not.toContain("<SystemIcons")
  })

  test("the header has no wordmark: the shell takes no brand and loads no extra font", () => {
    expect(shell).not.toMatch(/^\s+brand[?,:]/m)
    expect(shell).not.toContain("fraunces")
    expect(layout).not.toContain("DashboardBrand")
    expect(dashboard).not.toContain("font-fraunces")
  })
})

describe("the sidebar's footer", () => {
  // The user menu sits in the aside toolbar (#i959), and the footer holds the music player
  test("the footer is the music player alone: the usage windows sit on the dispatcher's row, and the user menu in the aside toolbar", () => {
    expect(footer).not.toContain("<DashboardUpdate")
    expect(footer).not.toContain("DashboardSystem")
    expect(footer).not.toContain("SidebarUserMenu")
    expect(dashboard).not.toContain("UpdateSlot")
    expect(dashboard).not.toContain("function DashboardSystem")
    expect(footer).toMatch(/export function DashboardFooter\(\) \{\s*return <MusicPlayer \/>/)
    expect(layout).toContain("footer={<DashboardFooter />}")
    expect(dashboard).toMatch(/i === usage \? \(\s*<DispatcherUsage now=\{now\} read=\{read\} \/>/)
  })

  test("the sidebar's footer carries no Documentation link: it lives in the user menu", async () => {
    const menu = await read("components/shell/sidebar-user-menu.tsx")
    expect(footer).not.toContain(">Documentation<")
    expect(footer).not.toContain('href="/docs"')
    expect(menu).toContain('href="/docs"')
  })
})
