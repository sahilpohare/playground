import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  apiRoutesOf,
  type DashboardMap,
  driftProblems,
  groupLabelChildren,
  groupOrder,
  MAP_PATH,
  routeOf,
  showsProblems,
} from "../../../../../packages/scripts/src/verify/map"

describe("showsProblems", () => {
  test("refuses a shows that is not a list, is empty, holds an empty entry or is out of order", () => {
    const page = (shows: unknown) =>
      ({ api: [], reach: [], route: "/x", shows, title: "X" }) as never
    expect(showsProblems([page("One string.")])).toEqual([
      "/x's shows is not a list: one entry per feature, sorted A to Z",
    ])
    expect(showsProblems([page([])])).toEqual(["/x's shows is empty"])
    expect(showsProblems([page(["A feature.", " "])])).toEqual(["/x's shows holds an empty entry"])
    expect(showsProblems([page(["Zebra.", "Apple."])])).toEqual([
      '/x\'s shows is not sorted A to Z: "Apple." goes before "Zebra."',
    ])
  })
})

describe("routeOf", () => {
  test("a page file serves its folders' URL, route groups and parallel-route slots dropped", () => {
    expect(routeOf("dashboard/page.tsx")).toBe("/dashboard")
    expect(routeOf("dashboard/apps/changelog/page.tsx")).toBe("/dashboard/apps/changelog")
    expect(routeOf("(protected)/dashboard/(tools)/asks/page.tsx")).toBe("/dashboard/asks")
    expect(routeOf("dashboard/@modal/agents/[id]/page.tsx")).toBe("/dashboard/agents/[id]")
    expect(routeOf("page.tsx")).toBe("/")
  })
})

describe("groupLabelChildren", () => {
  test("reads a literal label, even past an opening tag that holds JSX of its own", () => {
    const source = `
      <SidebarGroupLabel className="pl-2.5">Workers</SidebarGroupLabel>
      <SidebarGroupLabel
        className="pl-2.5"
        render={<Link href="/dashboard/apps" onClick={close} />}
      >
        Apps
      </SidebarGroupLabel>`
    expect(groupLabelChildren(source)).toEqual([{ text: "Workers" }, { text: "Apps" }])
  })

  test("a toggle's label is its words, before the chevron it holds", () => {
    const source = `<SidebarGroupLabel render={<button type="button" />}>
        Other
        <RiArrowRightSLine className={cn("ml-auto", open && "rotate-90")} />
      </SidebarGroupLabel>`
    expect(groupLabelChildren(source)).toEqual([{ text: "Other" }])
  })

  test("a MovableGroupLabel's label is read as a SidebarGroupLabel's, and a wrapper's bare children are skipped", () => {
    const source = `<MovableGroupLabel open={open} setOpen={setOpen}>
        Scripts
        <LabelChevron open={open} />
      </MovableGroupLabel>
      <SidebarGroupLabel className="w-full pl-2.5" render={toggle}>
        {children}
      </SidebarGroupLabel>
      <MovableGroupLabel open={open} setOpen={setOpen}>
        {label}
      </MovableGroupLabel>`
    expect(groupLabelChildren(source)).toEqual([{ text: "Scripts" }, { expression: true }])
  })

  test("a label's words come before an expression it holds, as Threads before its pager", () => {
    const source = `<SidebarGroupLabel className="pl-2.5">
        Threads
        {pager && <span data-slot="group-pager">{pager.page}</span>}
      </SidebarGroupLabel>`
    expect(groupLabelChildren(source)).toEqual([{ text: "Threads" }])
  })

  test("an expression label reads as an expression, whatever it reads", () => {
    const label = (child: string) =>
      groupLabelChildren(`<SidebarGroupLabel className="x">${child}</SidebarGroupLabel>`)
    for (const child of ["{label}", "{GROUPS[role].title}", '{t("sidebar.workers")}']) {
      expect(label(child)).toEqual([{ expression: true }])
    }
  })

  test("a self-closing tag is no label, and a quoted > or a template literal does not end a tag early", () => {
    expect(groupLabelChildren(`<SidebarGroupLabel className="x" />`)).toEqual([])
    expect(
      groupLabelChildren(
        '<SidebarGroupLabel title="a>b" className={`x ${y}`}>Runners</SidebarGroupLabel>',
      ),
    ).toEqual([{ text: "Runners" }])
  })
})

test("groupOrder reads GROUP_ORDER's members alone, never another list or property in the file", () => {
  const source = `const TONE = { label: "Down" }\nexport const GROUP_ORDER = ["Managers", "Workers"] as const\nconst LIGHTS = ["Stuck"] as const`
  expect(groupOrder(source)).toEqual(["Managers", "Workers"])
  expect(groupOrder(`const GROUPS = { worker: { label: "Workers" } }`)).toEqual([])
})

describe("apiRoutesOf", () => {
  const index = `app.basePath("/api")\n  .route("/v1", dashboardRouter)\n  .route("/v1/apps", appsRouter)`
  const dashboard = `export const dashboardRouter = new Hono()\n  .use("/ws", origin)\n  .use("/*", requireConsoleRole("owner"))\n  .get(\n    "/workers",\n    describeRoute({}),\n    async (c) => c.json({ origin: (await headers()).get("origin"), user: c.get("user") }),\n  )\n  .post("/workers/:sessionId/message", handler)`
  const apps = `export const appsRouter = new Hono<{ Variables: Record<string, Session> }>().get("/", handler)`
  const asks = `export const asksRouter = new Hono()\n  .use("/*", authMiddleware, requireConsoleRole("owner"))\n  .get("/", handler)`

  test("names each chained route under the path its router is mounted at, and no handler's .get call", () => {
    expect([...apiRoutesOf(index, [dashboard, apps]).served].sort()).toEqual([
      "GET /api/v1/apps",
      "GET /api/v1/workers",
      "POST /api/v1/workers/:sessionId/message",
    ])
  })

  test("marks the routes of a router that names the owner rung, in any .use(), as the dashboard's", () => {
    const withAsks = `${index}\n  .route("/asks", asksRouter)`
    expect([...apiRoutesOf(withAsks, [dashboard, apps, asks]).owner].sort()).toEqual([
      "GET /api/asks",
      "GET /api/v1/workers",
      "POST /api/v1/workers/:sessionId/message",
    ])
  })

  test("a router another mounts sits under it and takes its owner rung, as each plugin does under the apps router", () => {
    const ownerApps = `export const appsRouter = new Hono()\n  .use("/*", requireConsoleRole("owner"))\n  .get("/usage", h)\n  .route("/", pluginsRouter)`
    const registry = `export const pluginsRouter = new Hono()\n  .use("/changelog/*", requirePlugin("changelog"))\n  .route("/changelog", changelogRouter)`
    const plugin = `export const changelogRouter = new Hono().get(\n  "/",\n  h,\n)`
    const api = apiRoutesOf(index, [ownerApps, registry, plugin])
    expect([...api.served].sort()).toEqual(["GET /api/v1/apps/changelog", "GET /api/v1/apps/usage"])
    expect([...api.owner].sort()).toEqual(["GET /api/v1/apps/changelog", "GET /api/v1/apps/usage"])
  })

  test("a file exporting two routers names each one's routes under its own mount", () => {
    const both = `${index}\n  .route("/v1/settings", settingsRouter)\n  .route("/v1/store", storeRouter)`
    const file = `const guard = requireConsoleRole("owner")\nexport const settingsRouter = new Hono().use(guard)\n  .get("/:key", h)\n\nexport const storeRouter = new Hono().use(guard)\n  .get("/items", h)`
    const api = apiRoutesOf(both, [file])
    expect([...api.served].sort()).toEqual(["GET /api/v1/settings/:key", "GET /api/v1/store/items"])
    expect([...api.owner].sort()).toEqual(["GET /api/v1/settings/:key", "GET /api/v1/store/items"])
  })

  test("a router the API never mounts serves nothing", () => {
    const lost = apiRoutesOf(index, [`export const lostRouter = new Hono().get("/x", h)`])
    expect([...lost.served]).toEqual([])
  })
})

// A small dashboard, laid out as the repo lays it out, so the drift check runs end to end on code a test controls.
describe("driftProblems", () => {
  let root = ""
  const write = (path: string, text: string) => Bun.write(join(root, path), text)

  const map: DashboardMap = {
    about: "",
    pages: [
      {
        api: ["WS /api/v1/ws"],
        reach: ["Sidebar header"],
        route: "/dashboard",
        shows: ["The chat."],
        title: "Dashboard",
      },
    ],
    sidebar: [
      { label: "Workers", shows: "" },
      { label: "Runners", shows: "" },
    ],
    unpagedApi: [{ route: "POST /api/v1/messages", use: "" }],
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dashboard-map-"))
    await write(
      "web/next/src/app/(protected)/layout.tsx",
      `import { DashboardNav } from "@/components/dashboard/app-sidebar"\nimport { Button } from "@/components/ui/button"`,
    )
    await write("web/next/src/app/(protected)/dashboard/page.tsx", "")
    await write(
      "web/next/src/components/dashboard/app-sidebar.tsx",
      `import { sessionGroups } from "@/lib/dashboard"\nimport { LIGHTS } from "@/lib/status-icons"\nimport { Rows } from "./rows"\n<SidebarGroupLabel>{group.label}</SidebarGroupLabel>`,
    )
    await write(
      "web/next/src/components/dashboard/rows.tsx",
      `const TONE = { label: "Stray" }\n<SidebarGroupLabel className="pl-2.5">Runners</SidebarGroupLabel>`,
    )
    await write(
      "web/next/src/lib/dashboard.ts",
      `const TONE = { label: "Stray", title: "Lead" }\nexport const GROUP_ORDER = ["Manager", "Workers"] as const`,
    )
    await write(
      "web/next/src/lib/status-icons.ts",
      `export const LIGHTS = { down: { label: "Down" } }`,
    )
    await write(
      "web/next/src/components/ui/button.tsx",
      `<SidebarGroupLabel>Kit</SidebarGroupLabel>`,
    )
    await write("api/hono/src/local.ts", `.route("/v1", dashboardRouter)`)
    await write("api/hono/src/routers/index.ts", `export * from "@/routers/dashboard"`)
    await write(
      "api/hono/src/routers/dashboard.ts",
      `export const dashboardRouter = new Hono()\n  .use("/*", requireConsoleRole("owner"))\n  .get("/ws", h)\n  .post("/messages", (c) => c.json({ by: c.get("user") }))`,
    )
  })

  afterAll(() => rm(root, { force: true, recursive: true }))

  test("an expression label takes GROUP_ORDER's groups, so a group added there is checked; a label: literal in an imported module (Down, Stray) is no group, and the ui kit is skipped", async () => {
    expect(await driftProblems(root, map)).toEqual([
      `Sidebar group "Manager" (web/next/src/components/dashboard/app-sidebar.tsx) is not in ${MAP_PATH}: add it`,
    ])
  })

  test("a dashboard API route no page or unpagedApi names is reported, so a page's new write cannot slip past", async () => {
    const sidebar = [...map.sidebar, { label: "Manager", shows: "" }]
    expect(await driftProblems(root, { ...map, sidebar, unpagedApi: [] })).toEqual([
      `POST /api/v1/messages is a dashboard API route ${MAP_PATH} does not name: add it to the api of the page that calls it, or to unpagedApi with what does`,
    ])
  })

  test("a route both a page's api and unpagedApi name is reported, a WebSocket by either spelling", async () => {
    const sidebar = [...map.sidebar, { label: "Manager", shows: "" }]
    const pages = [{ ...map.pages[0]!, api: ["WS /api/v1/ws", "POST /api/v1/messages"] }]
    const unpagedApi = [...map.unpagedApi, { route: "GET /api/v1/ws", use: "" }]
    expect(await driftProblems(root, { ...map, pages, sidebar, unpagedApi })).toEqual([
      `POST /api/v1/messages is in ${MAP_PATH}'s unpagedApi and in /dashboard's api: keep it in one`,
      `GET /api/v1/ws is in ${MAP_PATH}'s unpagedApi and in /dashboard's api: keep it in one`,
    ])
  })

  test("a page the map lacks, and a page, route, unpaged route or group it keeps after the code dropped it, are each named", async () => {
    await write("web/next/src/app/(protected)/dashboard/asks/page.tsx", "")
    const stale: DashboardMap = {
      ...map,
      pages: [
        ...map.pages,
        {
          api: ["GET /api/v1/asks"],
          reach: [],
          route: "/dashboard/gone",
          shows: ["A page."],
          title: "Gone",
        },
      ],
      sidebar: [...map.sidebar, { label: "Manager", shows: "" }, { label: "Old", shows: "" }],
      unpagedApi: [...map.unpagedApi, { route: "GET /api/v1/gone", use: "" }],
    }
    expect(await driftProblems(root, stale)).toEqual([
      `/dashboard/asks is a dashboard page (web/next/src/app/(protected)/dashboard/asks/page.tsx) the map lacks: add it to ${MAP_PATH}`,
      `/dashboard/gone is in ${MAP_PATH} but no page serves it: remove or fix it`,
      `GET /api/v1/asks, which ${MAP_PATH} names for /dashboard/gone, is not an API route`,
      `GET /api/v1/gone is in ${MAP_PATH}'s unpagedApi but is not an API route`,
      `Sidebar group "Old" is in ${MAP_PATH} but no sidebar renders it`,
    ])
  })

  test("a page whose shows is out of order is named, so verify map refuses it", async () => {
    const unsorted: DashboardMap = {
      ...map,
      pages: map.pages.map((page, i) =>
        i === 0 ? { ...page, shows: ["Zebra.", "Apple."] } : page,
      ),
    }
    expect(await driftProblems(root, unsorted)).toContain(
      `${map.pages[0]!.route}'s shows is not sorted A to Z: "Apple." goes before "Zebra."`,
    )
  })

  test("an expression label with no GROUP_ORDER to read is reported, not skipped, whatever labels lie in reach", async () => {
    await write("web/next/src/lib/dashboard.ts", `const GROUPS = { worker: { label: "Workers" } }`)
    const problems = await driftProblems(root, map)
    expect(
      problems.some((line) =>
        line.startsWith(
          "A sidebar group label in web/next/src/components/dashboard/app-sidebar.tsx",
        ),
      ),
    ).toBe(true)
  })
  test("an expression label in a file that does not import @/lib/dashboard is reported, never given GROUP_ORDER's groups", async () => {
    await write(
      "web/next/src/app/(protected)/layout.tsx",
      `import { DashboardNav } from "@/components/dashboard/app-sidebar"\nimport { Tools } from "@/components/dashboard/tools"`,
    )
    await write(
      "web/next/src/components/dashboard/tools.tsx",
      `import { TOOLS } from "@/lib/tools"\n<SidebarGroupLabel>{tool.label}</SidebarGroupLabel>`,
    )
    await write(
      "web/next/src/lib/dashboard.ts",
      `export const GROUP_ORDER = ["Manager", "Workers"] as const`,
    )
    const problems = await driftProblems(root, map)
    expect(problems.filter((line) => line.includes("tools.tsx"))).toEqual([
      `A sidebar group label in web/next/src/components/dashboard/tools.tsx is an expression the map cannot read: render it as text, or render GROUP_ORDER's groups from @/lib/dashboard, which that file imports and which declares GROUP_ORDER as const`,
    ])
  })
})
