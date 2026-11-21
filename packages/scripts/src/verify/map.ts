import { dirname, join, normalize } from "node:path"

import { Glob } from "bun"

import dashboardMap from "./dashboard-map.json"

export type DashboardPage = {
  api: string[]
  // The heading is the primary dispatcher's label, Alpha, which heading gives.
  dispatcherHeading?: boolean
  heading?: string
  // Partial, since TypeScript reads the JSON's pages as one union that gives each page's query the other pages' params as optional
  query?: Partial<Record<string, string>>
  reach: string[]
  route: string
  // One entry per feature, sorted A to Z, so PRs that add different features usually touch different lines; showsProblems checks it is a list, with no empty entry, in A to Z order.
  shows: string[]
  title: string
}

export type DashboardGroup = { label: string; shows: string }

export type UnpagedRoute = { route: string; use: string }

export type DashboardMap = {
  about: string
  pages: DashboardPage[]
  sidebar: DashboardGroup[]
  unpagedApi: UnpagedRoute[]
}

export const DASHBOARD_MAP: DashboardMap = dashboardMap
export const MAP_PATH = "packages/scripts/src/verify/dashboard-map.json"
export const ROOT = join(import.meta.dir, "../../../..")

const DASHBOARD_APP = "web/next/src/app/(protected)"
const DASHBOARD_LAYOUT = "app/(protected)/layout"
const WEB_SRC = "web/next/src"
const API_SRC = "api/hono/src"

// A page file's URL: route groups like (protected) and parallel-route slots like @modal name no segment.
export const routeOf = (pageFile: string): string => {
  const segments = dirname(pageFile)
    .split("/")
    .filter((segment) => segment !== "." && !/^\(.+\)$/.test(segment) && !segment.startsWith("@"))
  return `/${segments.join("/")}`
}

// A <SidebarGroupLabel>'s label: its text (the words before any element or expression, as in a toggle's Other and its chevron, or Threads and its pager), or an expression ({label}), whose groups dashboardGroups reads from GROUP_ORDER.
export type LabelChild = { text: string } | { expression: true }

// The label of every <SidebarGroupLabel> or <MovableGroupLabel> (the shell's group label, which wraps one) in a source file; a wrapper's own label, its bare {children}, is its callers', so it is skipped. Its opening tag can hold JSX of its own (a render={<Link … />}), so the tag ends at the first > outside braces and quotes.
export const groupLabelChildren = (source: string): LabelChild[] => {
  const found: LabelChild[] = []
  const tag = /<(SidebarGroupLabel|MovableGroupLabel)[\s>]/g
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    const name = match[1]!
    let depth = 0
    let quote = ""
    let end = -1
    for (let i = match.index + name.length + 1; i < source.length; i++) {
      const char = source[i]
      if (quote) {
        if (char === quote) quote = ""
      } else if (char === '"' || char === "'" || char === "`") quote = char
      else if (char === "{") depth++
      else if (char === "}") depth--
      else if (char === ">" && depth === 0) {
        end = i
        break
      }
    }
    if (end < 0 || source[end - 1] === "/") continue
    const close = source.indexOf(`</${name}>`, end)
    if (close < 0) continue
    const text = source
      .slice(end + 1, close)
      .replace(/\s+/g, " ")
      .trim()
    if (text === "{children}") continue
    const words = text.match(/^([^{}<]+?)\s*[{<]/)?.[1]
    if (!/[{}<]/.test(text)) found.push({ text })
    else if (words) found.push({ text: words })
    else found.push({ expression: true })
  }
  return found
}

// The sidebar's groups, as GROUP_ORDER in web/next/src/lib/dashboard.ts lists them: the one list every group label rendered from an expression comes from, since GROUP_OF's values are typed against it.
const GROUPS_SOURCE = "lib/dashboard"

// Pure: the members of a source file's `GROUP_ORDER = [...] as const`, and nothing else in it.
export const groupOrder = (source: string): string[] =>
  [
    ...(source.match(/\bGROUP_ORDER\s*=\s*\[([^\]]*)\]\s*as const/)?.[1] ?? "").matchAll(
      /"([^"]+)"/g,
    ),
  ].map((match) => match[1]!)

// The local imports of a web source file, @/ ones and relative ones alike, as paths under web/next/src without an extension. `from` is the file's own such path.
const webImports = (source: string, from: string): string[] =>
  [...source.matchAll(/from\s+"((?:@\/|\.{1,2}\/)[^"]+)"/g)].map(({ 1: spec }) =>
    spec!.startsWith("@/") ? spec!.slice(2) : normalize(join(dirname(from), spec!)),
  )

const readWeb = async (
  root: string,
  path: string,
): Promise<{ file: string; source: string } | null> => {
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const file = `${WEB_SRC}/${path}${ext}`
    const handle = Bun.file(join(root, file))
    if (await handle.exists()) return { file, source: await handle.text() }
  }
  return null
}

export type FoundGroup = { file: string; label: string }

// Every sidebar group the dashboard's layout can render: the components it imports, and theirs, outside the shared ui kit. A label written as text is that text; a label rendered from an expression (like {group.label}) in a file that imports @/lib/dashboard is each of GROUP_ORDER's groups, read from that list alone, never from other literals in reach; any other expression label, or one with no list to read, is reported rather than skipped, so a group never slips past the map.
export const dashboardGroups = async (
  root: string,
): Promise<{ groups: FoundGroup[]; unreadable: string[] }> => {
  const groups: FoundGroup[] = []
  const unreadable: string[] = []
  const seen = new Set<string>()
  const order = groupOrder((await readWeb(root, GROUPS_SOURCE))?.source ?? "")
  const layout = (await readWeb(root, DASHBOARD_LAYOUT))?.source ?? ""
  const queue = webImports(layout, DASHBOARD_LAYOUT)
  while (queue.length) {
    const path = queue.shift()!
    if (seen.has(path) || !path.startsWith("components/") || path.startsWith("components/ui/")) {
      continue
    }
    seen.add(path)
    const read = await readWeb(root, path)
    if (!read) continue
    const imports = webImports(read.source, path)
    queue.push(...imports)
    const listed = imports.includes(GROUPS_SOURCE) ? order : []
    for (const child of groupLabelChildren(read.source)) {
      if ("text" in child) {
        groups.push({ file: read.file, label: child.text })
        continue
      }
      if (!listed.length) unreadable.push(read.file)
      for (const label of listed) groups.push({ file: read.file, label })
    }
  }
  return { groups, unreadable }
}

// Every page under the dashboard's route group, the (protected) group whose layout draws the dashboard's sidebar.
export const dashboardRoutes = async (root: string): Promise<{ file: string; route: string }[]> => {
  const pages: { file: string; route: string }[] = []
  const glob = new Glob("**/page.{js,jsx,mdx,ts,tsx}")
  for await (const file of glob.scan({ cwd: join(root, DASHBOARD_APP) })) {
    pages.push({ file: `${DASHBOARD_APP}/${file}`, route: routeOf(file) })
  }
  return pages.sort((a, b) => a.route.localeCompare(b.route))
}

export type ApiRoutes = { owner: Set<string>; served: Set<string> }

// Every route the API's routers serve, as "METHOD /api/<mount><path>", from where local.ts mounts each router, where a mounted router mounts another in turn (the apps router mounts the plugin registry, which mounts each plugin), and the routes each one chains. `owner` holds every route of a router that names the owner rung anywhere, or that sits under one that does, so a router gating it per route or in a combined .use() is over-checked rather than skipped. Only a call chained on new Hono() or starting a line counts, so a handler's c.get("user") or (await headers()).get("x") is no route.
export const apiRoutesOf = (index: string, routers: string[]): ApiRoutes => {
  const mountRe = /\.route\(\s*"([^"]+)",\s*(\w+)\s*\)/g
  const ownerRe = /requireConsoleRole\(\s*"owner"\s*\)/
  const mounts = new Map(
    [...index.matchAll(mountRe)].map((m) => [m[2]!, { at: m[1]!, owner: false }]),
  )
  // A file may export several routers (the store's settings and store routers): each takes its own chain, from its declaration to the next, after the file's shared preamble.
  const named = routers.flatMap((file) => {
    const starts = [...file.matchAll(/export const (\w+) = new Hono/g)]
    const preamble = file.slice(0, starts[0]?.index ?? 0)
    return starts.map((m, i) => ({
      name: m[1]!,
      source: preamble + file.slice(m.index, starts[i + 1]?.index ?? file.length),
    }))
  })
  for (let grew = true; grew;) {
    grew = false
    for (const { name, source } of named) {
      const parent = mounts.get(name)
      if (!parent) continue
      const owner = parent.owner || ownerRe.test(source)
      for (const m of source.matchAll(mountRe)) {
        if (mounts.has(m[2]!)) continue
        mounts.set(m[2]!, { at: m[1] === "/" ? parent.at : `${parent.at}${m[1]}`, owner })
        grew = true
      }
    }
  }
  const chained = /(?:^\s*|new Hono(?:<.*?>)?\(\)\s*)\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm
  const api: ApiRoutes = { owner: new Set(), served: new Set() }
  for (const { name, source } of named) {
    const mount = mounts.get(name)
    if (!mount) continue
    const owner = mount.owner || ownerRe.test(source)
    for (const m of source.matchAll(chained)) {
      const route = `${m[1]!.toUpperCase()} /api${mount.at}${m[2] === "/" ? "" : m[2]}`
      api.served.add(route)
      if (owner) api.owner.add(route)
    }
  }
  return api
}

// The routers' sources: every file under routers/, the plugin registry and each plugin's router.
const apiRoutes = async (root: string): Promise<ApiRoutes> => {
  const index = await Bun.file(join(root, API_SRC, "local.ts")).text()
  const routers: string[] = []
  for (const pattern of ["routers/*.ts", "plugins/registry.ts", "plugins/*/router.ts"]) {
    for await (const file of new Glob(pattern).scan({ cwd: join(root, API_SRC) })) {
      if (file !== "routers/index.ts")
        routers.push(await Bun.file(join(root, API_SRC, file)).text())
    }
  }
  return apiRoutesOf(index, routers)
}

// A WebSocket is a GET that upgrades, so the map may name it WS.
const asServed = (ref: string): string => ref.replace(/^WS /, "GET ")

// Each page's shows is a list, one entry per feature, sorted A to Z, as a line per fault.
export const showsProblems = (pages: DashboardPage[]): string[] =>
  pages.flatMap(({ route, shows }) => {
    if (!Array.isArray(shows))
      return [`${route}'s shows is not a list: one entry per feature, sorted A to Z`]
    if (shows.length === 0) return [`${route}'s shows is empty`]
    if (shows.some((entry) => typeof entry !== "string" || !entry.trim())) {
      return [`${route}'s shows holds an empty entry`]
    }
    const at = shows.findIndex((entry, i) => i > 0 && shows[i - 1]!.localeCompare(entry) > 0)
    return at > 0
      ? [`${route}'s shows is not sorted A to Z: "${shows[at]}" goes before "${shows[at - 1]}"`]
      : []
  })

// Where the map and the code disagree, and any page whose shows is not one entry per feature, A to Z, each as a line that says what to change. Empty means the map is current.
export const driftProblems = async (
  root = ROOT,
  map: DashboardMap = DASHBOARD_MAP,
): Promise<string[]> => {
  const problems: string[] = showsProblems(map.pages)
  const [pages, { groups, unreadable }, api] = await Promise.all([
    dashboardRoutes(root),
    dashboardGroups(root),
    apiRoutes(root),
  ])

  const mapped = new Set(map.pages.map((page) => page.route))
  for (const { file, route } of pages) {
    if (!mapped.has(route)) {
      problems.push(`${route} is a dashboard page (${file}) the map lacks: add it to ${MAP_PATH}`)
    }
  }
  const real = new Set(pages.map((page) => page.route))
  for (const page of map.pages) {
    if (!real.has(page.route)) {
      problems.push(`${page.route} is in ${MAP_PATH} but no page serves it: remove or fix it`)
    }
    for (const ref of page.api) {
      if (!api.served.has(asServed(ref))) {
        problems.push(`${ref}, which ${MAP_PATH} names for ${page.route}, is not an API route`)
      }
    }
  }

  // Every route behind the owner rung is the dashboard's, so each is named: by the page that calls it, or in unpagedApi with what does.
  const named = new Set(
    [...map.pages.flatMap((page) => page.api), ...map.unpagedApi.map(({ route }) => route)].map(
      asServed,
    ),
  )
  for (const route of [...api.owner].sort()) {
    if (!named.has(route)) {
      problems.push(
        `${route} is a dashboard API route ${MAP_PATH} does not name: add it to the api of the page that calls it, or to unpagedApi with what does`,
      )
    }
  }
  for (const { route } of map.unpagedApi) {
    if (!api.served.has(asServed(route))) {
      problems.push(`${route} is in ${MAP_PATH}'s unpagedApi but is not an API route`)
    }
    for (const page of map.pages) {
      if (page.api.some((ref) => asServed(ref) === asServed(route))) {
        problems.push(
          `${route} is in ${MAP_PATH}'s unpagedApi and in ${page.route}'s api: keep it in one`,
        )
      }
    }
  }

  const labels = new Set(map.sidebar.map((group) => group.label))
  for (const { file, label } of groups) {
    if (!labels.has(label)) {
      problems.push(`Sidebar group "${label}" (${file}) is not in ${MAP_PATH}: add it`)
    }
  }
  const rendered = new Set(groups.map((group) => group.label))
  for (const { label } of map.sidebar) {
    if (!rendered.has(label)) {
      problems.push(`Sidebar group "${label}" is in ${MAP_PATH} but no sidebar renders it`)
    }
  }
  for (const file of unreadable) {
    problems.push(
      `A sidebar group label in ${file} is an expression the map cannot read: render it as text, or render GROUP_ORDER's groups from @/${GROUPS_SOURCE}, which that file imports and which declares GROUP_ORDER as const`,
    )
  }

  return [...new Set(problems)]
}
