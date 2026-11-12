import { rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { site } from "@packages/config/site"

import { chatLabel, homeTitle } from "../../../../web/next/src/lib/agent-label"
import { VERIFY_VISIT } from "../../../../web/next/src/lib/verify-visit"
import type { Shift } from "./cls-observer"
import { DASHBOARD_MAP, type DashboardPage, driftProblems } from "./map"

export type Result = { check: string; detail: string; ok: boolean }
export type Target = { api: string; web: string }
export type Expectation = { label: string; sha: string } | { label: string; version: string }
export type Viewport = { height: number; width: number }

// The fixture's scratch folder as the launcher names it (fixtureDir in api/hono/src/lib/dashboard/fixture.ts), which a test holds this mirror to.
export const fixtureDirOf = (
  env: Record<string, string | undefined>,
  root: string,
  tmp: string = tmpdir(),
): string => {
  if (env.PLAYGROUND_FIXTURE_DIR) return resolve(root, env.PLAYGROUND_FIXTURE_DIR)
  if (statSync(join(root, ".git"), { throwIfNoEntry: false })?.isFile())
    return join(root, ".turbo", "dashboard-fixture")
  return join(
    tmp,
    `playground-dashboard-fixture-${process.getuid?.() ?? 0}-${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 8)}`,
  )
}

// 1280 is the narrowest desktop the dashboard promises; 1782×972 is the ui-verify skill's default, so these screenshots pair with the ones a PR already carries.
export const VIEWPORTS: Viewport[] = [
  { height: 800, width: 1280 },
  { height: 972, width: 1782 },
]

// A PR's shots cover a phone too, and each viewport in both themes, so a reviewer sees every surface the change draws.
export const SHOT_VIEWPORTS: Viewport[] = [...VIEWPORTS, { height: 844, width: 390 }]
export const THEMES = ["light", "dark"] as const
export type Theme = (typeof THEMES)[number]

const pass = (check: string, detail: string): Result => ({ check, detail, ok: true })
const fail = (check: string, detail: string): Result => ({ check, detail, ok: false })

// fetch, with the URL it could not reach in its error: Bun's own message names neither.
const request = (url: string, init?: RequestInit): Promise<Response> =>
  fetch(url, init).catch((error: Error) => {
    throw new Error(`${url}: ${error.message}`)
  })

// A git revision names a commit; anything else is a literal version, compared whole.
export const resolveExpectation = (expect: string): Expectation => {
  const rev = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${expect}^{commit}`])
  const sha = rev.stdout.toString().trim()
  return rev.exitCode === 0 && sha ? { label: expect, sha } : { label: expect, version: expect }
}

// /api/health reports `<package version>-<short sha>`, so a commit matches when that short sha starts it.
export const versionMatches = (version: string, expected: Expectation): boolean => {
  if ("version" in expected) return version === expected.version
  const short = version.match(/-([0-9a-f]{7,40})$/)?.[1]
  return Boolean(short && expected.sha.startsWith(short))
}

type Health = {
  db?: "ok" | "unreachable"
  dbError?: string
  dashboard?: string
  environment: string
  message: string
  setup?: boolean
  version: string
}

export const readHealth = async (api: string): Promise<Health | string> => {
  const response = await request(`${api}/api/health`)
  if (!response.ok) return `${api}/api/health answered ${response.status}`
  return ((await response.json()) as { data: Health }).data
}

export const health = async ({ api }: Target, expected: Expectation): Promise<Result> => {
  const data = await readHealth(api)
  if (typeof data === "string") return fail("health", data)
  const at = `${data.version} (${data.environment}, dashboard: ${data.dashboard ?? "unknown"}${data.setup ? ", in setup" : ""})`
  if (data.message !== "ok") return fail("health", `message is ${data.message}, not ok: ${at}`)
  if (!versionMatches(data.version, expected)) {
    return fail(
      "health",
      `${at} is not ${expected.label}. \`bun run dev\` hands the API the sha HEAD had when the stack started, so a stack started before ${expected.label} was checked out still reports the older one: restart it with \`bun run dev\` and recheck`,
    )
  }
  return pass("health", `${at} matches ${expected.label}`)
}

// Pure: what /api/health flags as not well. The database is the one thing the route flags today: an older build's body names none and passes, saying so, and a stack in first run's setup has none yet and passes too.
export const problemsResult = (data: Health): Result => {
  const at = `(${data.version}, ${data.environment})`
  if (data.db === "unreachable") {
    return fail(
      "problems",
      `the database is unreachable: ${data.dbError ?? "no error given"} ${at}`,
    )
  }
  if (data.setup) return pass("problems", `in setup, with no database yet ${at}`)
  return pass(
    "problems",
    data.db === "ok" ? `the database answers ${at}` : `the body names no database ${at}`,
  )
}

// What the stack itself reports as not well, read from the same unauthenticated /api/health body the health check reads. A read that fails is the first problem.
export const problems = async ({ api }: Target): Promise<Result> => {
  const data = await readHealth(api).catch((error: Error) => error.message)
  if (typeof data === "string") return fail("problems", data)
  return problemsResult(data)
}

// The agent sign-in: a POST from the web origin, answered with the session cookie and a redirect to the dashboard.
export const signIn = async ({ api, web }: Target): Promise<{ cookie: string; result: Result }> => {
  const response = await request(`${api}/api/agents/sign-in-as`, {
    headers: { origin: web },
    method: "POST",
    redirect: "manual",
  })
  if (response.status === 404) {
    return {
      cookie: "",
      result: fail(
        "signin",
        "agent sign-in is off on that stack: it needs NODE_ENV=local and AGENT_SIGNIN_ENABLED=true",
      ),
    }
  }
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ")
  if (response.status !== 302 || !cookie) {
    return {
      cookie: "",
      result: fail("signin", `sign-in answered ${response.status}: ${await response.text()}`),
    }
  }
  const user = await request(`${api}/api/v1/user`, { headers: { cookie } })
  const email = user.ok ? ((await user.json()) as { data: { email: string } }).data.email : null
  if (email !== site.agent.email) {
    return {
      cookie: "",
      result: fail("signin", `/api/v1/user answered ${user.status} as ${email ?? "nobody"}`),
    }
  }
  return { cookie, result: pass("signin", `signed in as ${email}`) }
}

// Ends the session signIn minted, so a run against the live dashboard leaves none behind in its database. Best effort: a run that cannot sign out has still checked what it checked.
export const signOut = async ({ api, web }: Target, cookie: string): Promise<void> => {
  await fetch(`${api}/api/auth/sign-out`, {
    body: "{}",
    headers: { "content-type": "application/json", cookie, origin: web },
    method: "POST",
  }).catch(() => undefined)
}

// Bun's WebSocket sends headers with its upgrade; the DOM types this package also loads describe the browser's, which cannot.
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket

// The dashboard's WebSocket, opened as the dashboard's own page opens it: from the web origin, with the session. Its first workers frame is the board.
export const dashboardSocket = (
  { api, web }: Target,
  cookie: string,
  timeoutMs = 15_000,
): Promise<Result> =>
  new Promise((resolve) => {
    const socket = new BunWebSocket(`${api.replace(/^http/, "ws")}/api/v1/ws`, {
      headers: { cookie, origin: web },
    })
    let done = false
    const finish = (result: Result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      resolve(result)
    }
    const timer = setTimeout(
      () => finish(fail("ws", `no workers frame within ${timeoutMs / 1000}s`)),
      timeoutMs,
    )
    socket.addEventListener("message", (event) => {
      let frame: {
        code?: string
        message?: string
        type: string
        workers?: { light?: unknown; name?: unknown; sessionId?: unknown }[]
      }
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        finish(fail("ws", `a frame is not JSON: ${String(event.data).slice(0, 120)}`))
        return
      }
      if (frame.type === "error") finish(fail("ws", `error frame ${frame.code}: ${frame.message}`))
      if (frame.type !== "workers") return
      const workers = frame.workers ?? []
      const malformed = workers.filter(
        (w) => typeof w.sessionId !== "string" || typeof w.name !== "string",
      )
      if (!Array.isArray(frame.workers) || malformed.length) {
        finish(
          fail("ws", `workers frame has ${malformed.length} rows without a sessionId and name`),
        )
        return
      }
      const lights = Object.entries(Object.groupBy(workers, (w) => String(w.light)))
        .map(([light, rows]) => `${rows?.length} ${light}`)
        .join(", ")
      finish(
        pass("ws", `workers frame: ${workers.length} live sessions${lights ? ` (${lights})` : ""}`),
      )
    })
    socket.addEventListener("close", (event) =>
      finish(
        fail(
          "ws",
          `closed before a workers frame (code ${event.code}): is the session an owner, and the origin trusted?`,
        ),
      ),
    )
  })

type DevtoolsReply = { error?: { message: string }; id: number; result?: unknown }

type BrowserReply = {
  data: Record<string, unknown>
  error: string | null
  success: boolean
}

// What every verify page runs first: the flag a page reads to tell verify's visit from a person's (VERIFY_VISIT), so the Changelog leaves the owner's unread count alone.
export const VISIT_SCRIPT = `Object.defineProperty(window, ${JSON.stringify(VERIFY_VISIT)}, { value: true })`

let visitScript: Promise<string> | null = null

// VISIT_SCRIPT as the file agent-browser takes an init script from, written once per run and removed as the process exits.
const visitScriptPath = (): Promise<string> =>
  (visitScript ??= (async () => {
    const path = join(tmpdir(), `playground-verify-visit-${process.pid}.js`)
    await Bun.write(path, VISIT_SCRIPT)
    process.once("exit", () => rmSync(path, { force: true }))
    return path
  })())

// The sign-in's wait for the dashboard: a cold next dev compile of it took over 25s under load, agent-browser's default action timeout, so the wait carries its own longer budget.
export const SIGNIN_WAIT_MS = 60_000

export const signInWaitArgs = (): string[] => [
  "wait",
  "--url",
  "**/dashboard",
  "--timeout",
  String(SIGNIN_WAIT_MS),
]

// One agent-browser session per check (verify-<pid>-<check>), so parallel workers never share a browser, its cookies or its console, and a check never reconnects to the session the last check is still closing. Init scripts (paths), VISIT_SCRIPT's first, are registered on its first command and then run before every page's own.
export class Browser {
  readonly session: string
  private initScripts: string[] | null

  constructor(initScripts: string[] = [], name = "") {
    this.initScripts = initScripts
    this.session = `verify-${process.pid}${name ? `-${name}` : ""}`
  }

  // The argv for one agent-browser command; only the first, which launches the browser, carries the init scripts and the mute, since headless Chrome plays sound.
  async command(args: string[]): Promise<string[]> {
    const first = this.initScripts !== null
    const scripts = first ? [await visitScriptPath(), ...(this.initScripts ?? [])] : []
    this.initScripts = null
    const launch = first
      ? ["--args", "--mute-audio", ...scripts.flatMap((path) => ["--init-script", path])]
      : []
    return ["agent-browser", "--session", this.session, "--json", ...launch, ...args]
  }

  async run(...args: string[]): Promise<Record<string, unknown>> {
    const proc = Bun.spawn(await this.command(args), {
      stderr: "pipe",
      stdout: "pipe",
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    let reply: BrowserReply
    try {
      reply = JSON.parse(out) as BrowserReply
    } catch {
      throw new Error(`agent-browser ${args[0]} failed: ${(err || out).trim()}`)
    }
    if (!reply.success) throw new Error(`agent-browser ${args.join(" ")}: ${reply.error}`)
    return reply.data
  }

  async eval<T>(script: string): Promise<T> {
    return (await this.run("eval", script)).result as T
  }

  // Signs the browser in through a form posted from the web origin, so its cookie lands as a person's would; it posts from robots.txt, since / goes on to /dashboard, whose first-run pane signs the owner in by itself.
  async signIn({ api, web }: Target): Promise<void> {
    await this.run("open", `${web}/robots.txt`)
    await this.eval(
      `(() => { const form = Object.assign(document.createElement("form"), { method: "POST", action: ${JSON.stringify(`${api}/api/agents/sign-in-as`)} }); document.body.append(form); form.submit(); return true })()`,
    )
    await this.run(...signInWaitArgs())
  }

  // Ends the browser's session from a page on the web origin, as the user menu's sign-out would. Best effort, like signOut.
  async signOut({ api }: Target): Promise<void> {
    await this.eval(
      `fetch(${JSON.stringify(`${api}/api/auth/sign-out`)}, { body: "{}", credentials: "include", headers: { "content-type": "application/json" }, method: "POST" }).then((response) => response.status)`,
    ).catch(() => undefined)
  }

  async viewport({ height, width }: Viewport): Promise<void> {
    await this.run("set", "viewport", String(width), String(height))
  }

  // Opens a page and waits for it to settle; a page that never goes network-idle is still checked, after the wait gives up.
  async visit(url: string): Promise<void> {
    await this.run("open", url)
    await this.run("wait", "--load", "networkidle").catch(() => undefined)
  }

  // Leaves the browser as a first visit finds the current origin, still signed in: its local and session storage, the cookies a page can read (the session's is httpOnly, so it stays) and the HTTP cache, which only the DevTools protocol clears.
  async forget(): Promise<void> {
    await this.run("storage", "local", "clear")
    await this.run("storage", "session", "clear")
    await this.eval(
      `document.cookie.split(";").map((pair) => pair.split("=")[0].trim()).filter(Boolean).forEach((name) => { document.cookie = name + "=; path=/; max-age=0" }); document.cookie`,
    )
    const url = String((await this.run("get", "cdp-url")).cdpUrl)
    const devtools = new WebSocket(url)
    let id = 0
    const waiting = new Map<number, (reply: DevtoolsReply) => void>()
    devtools.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as DevtoolsReply
      waiting.get(reply.id)?.(reply)
    })
    // A socket that closes, or never answers within 10s, fails the load rather than hanging the run.
    const timer = setTimeout(() => devtools.close(), 10_000)
    const send = <T>(method: string, params: object = {}, sessionId?: string) =>
      new Promise<T>((resolve, reject) => {
        devtools.addEventListener("close", () => reject(new Error(`${method}: no answer`)))
        waiting.set(++id, (reply) =>
          reply.error
            ? reject(new Error(`${method}: ${reply.error.message}`))
            : resolve(reply.result as T),
        )
        devtools.send(JSON.stringify({ id, method, params, sessionId }))
      })
    try {
      await new Promise((resolve, reject) => {
        devtools.addEventListener("open", resolve)
        devtools.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)))
        devtools.addEventListener("close", () => reject(new Error(`cannot reach ${url}`)))
      })
      const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>(
        "Target.getTargets",
      )
      const page = targetInfos.find((target) => target.type === "page")
      if (!page) throw new Error("the browser has no page to clear the cache through")
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        flatten: true,
        targetId: page.targetId,
      })
      await send("Network.clearBrowserCache", {}, sessionId)
    } finally {
      clearTimeout(timer)
      devtools.close()
    }
  }

  async close(): Promise<void> {
    await this.run("close").catch(() => undefined)
  }
}

// a label's name without its count or the Threads group's pager
const SIDEBAR_LABELS = `[...document.querySelectorAll('[data-sidebar="group-label"]')].map((label) => { const name = label.cloneNode(true); name.querySelectorAll('[data-slot="group-count"], [data-slot="group-pager"]').forEach((count) => count.remove()); return name.textContent.trim() })`

// A reviewer or tester that leads a row marks it itself, in the sidebar and the Agents table alike; the dashboard draws none.
const ROOT_CHECKERS = `[...document.querySelectorAll("[data-root-checker]")].map((el) => el.getAttribute("data-root-checker") ?? "")`

// A live dispatcher as the board frame lists it, with what its label is made of.
export type DispatcherSession = {
  effort: string | null
  model: string | null
  name: string
  role: string
  sessionId: string
}

// The dispatchers the stack's API names on its first board frame, the primary first, and the live sessions holding the role, read from the page as the dashboard reads them; null when no frame comes within 10s.
export const dispatchersOf = (
  browser: Browser,
  { api }: Target,
): Promise<{ live: DispatcherSession[]; names: string[] } | null> =>
  browser.eval<{ live: DispatcherSession[]; names: string[] } | null>(
    `new Promise((resolve) => { const socket = new WebSocket(${JSON.stringify(`${api.replace(/^http/, "ws")}/api/v1/ws`)}); const timer = setTimeout(() => { socket.close(); resolve(null) }, 10000); socket.onmessage = (event) => { const frame = JSON.parse(String(event.data)); if (frame.type !== "workers" && frame.type !== "error") return; clearTimeout(timer); socket.close(); resolve(Array.isArray(frame.dispatchers) ? { live: (frame.workers ?? []).filter((w) => w.role === "dispatcher").map(({ effort, model, name, role, sessionId }) => ({ effort, model, name, role, sessionId })), names: frame.dispatchers } : null) }; socket.onclose = () => { clearTimeout(timer); resolve(null) } })`,
  )

// The heading /dashboard shows once the API has named its dispatchers: the primary's label, Alpha while its session is live (chatLabel), else its role (homeTitle).
export const homeHeading = ({ live, names }: { live: DispatcherSession[]; names: string[] }) => {
  const primary = names[0] ?? null
  const session = live.find((w) => w.name === primary)
  return session ? chatLabel(session, primary) : homeTitle(primary)
}

// One page, as a person at 1280 would meet it: it stays on its route and answers 200, its heading is the map's (the dispatcher's label where the map says so), it logs no error, it does not scroll sideways, on a dashboard page every sidebar group it draws is one the map knows, and no reviewer or tester sits at the root of its sidebar or Agents table.
export const checkPage = async (
  browser: Browser,
  target: Target,
  route: string,
  page: DashboardPage | undefined,
): Promise<Result> => {
  const { web } = target
  const check = `page ${route}`
  const problems: string[] = []
  await browser.run("console", "--clear")
  await browser.run("errors", "--clear")
  await browser.visit(`${web}${route}`)

  const landed = new URL(String((await browser.run("get", "url")).url))
  if (landed.pathname !== new URL(route, web).pathname)
    problems.push(`landed on ${landed.pathname}`)
  // A missing page keeps its URL and renders Page not found, so the document's own status tells it apart.
  const status = await browser.eval<number>(
    `performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`,
  )
  if (status >= 400) problems.push(`it answered ${status}`)
  // The page's own half, never the aside's Inbox beside it, and given a moment, since a page draws its words once its data answers (/dashboard's first row)
  await browser
    .run("wait", "--fn", `!!document.querySelector("[data-dashboard-page]")?.innerText.trim()`)
    .catch(() => undefined)
  if (
    !(await browser.eval<number>(
      `document.querySelector("[data-dashboard-page]")?.innerText.trim().length ?? 0`,
    ))
  ) {
    problems.push("its page is empty")
  }
  if (page?.heading) {
    // A page may name its heading only once the API answers (the dashboard's names the dispatcher), so it gets a moment to draw one.
    await browser.run("wait", "[data-dashboard-page] h1").catch(() => undefined)
    const heading = await browser.eval<string | null>(
      `document.querySelector("[data-dashboard-page] h1")?.textContent.trim() ?? null`,
    )
    const dispatchers = page.dispatcherHeading ? await dispatchersOf(browser, target) : null
    const expected = (dispatchers && homeHeading(dispatchers)) ?? page.heading
    if (heading !== expected)
      problems.push(`its heading is ${JSON.stringify(heading)}, not "${expected}"`)
  }
  const overflow = await browser.eval<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  )
  if (overflow > 0) problems.push(`it scrolls sideways by ${overflow}px`)
  if (page) {
    const known = new Set(DASHBOARD_MAP.sidebar.map((group) => group.label))
    for (const label of await browser.eval<string[]>(SIDEBAR_LABELS)) {
      if (!known.has(label))
        problems.push(`its sidebar draws a "${label}" group the dashboard map lacks`)
    }
    // The roster read re-homes a checker whose worker it names a beat after the rows draw, so a root it holds counts only once the menu says the rows' agent data is in hand.
    await browser
      .run("wait", '[data-sidebar="content"] [data-sidebar="menu"][data-agents="ready"]')
      .catch(() => undefined)
    // a reviewer or tester marks its own row when it leads one, so a root it should never hold fails the page
    for (const name of await browser.eval<string[]>(ROOT_CHECKERS)) {
      problems.push(`a reviewer or tester sits at the root: ${name}`)
    }
  }
  const messages = ((await browser.run("console")).messages ?? []) as {
    text: string
    type: string
  }[]
  for (const { text } of messages.filter((message) => message.type === "error")) {
    problems.push(`console error: ${text}`)
  }
  for (const error of ((await browser.run("errors")).errors ?? []) as unknown[]) {
    problems.push(`page error: ${typeof error === "string" ? error : JSON.stringify(error)}`)
  }

  return problems.length ? fail(check, problems.join("; ")) : pass(check, "renders clean at 1280")
}

// The pages seen to jump while loading: the sidebar, which /dashboard holds whole, and the System page.
export const CLS_ROUTES = ["/dashboard", "/dashboard/system"]
// The pages a roster changes, which load again as a stack with no roster file shows them: the System page names the missing roster.
export const CLS_NO_ROSTER_ROUTES = ["/dashboard/system"]
// Above this, a load shifted; below it is rounding.
export const CLS_LIMIT = 0.001
// How long a load is watched after it goes network-idle: the System page holds its sections up to 3s, and the sidebar settles a light after 5s.
export const CLS_SETTLE_MS = 8_000

export type Load = "cold" | "warm"

// What a load found beside its shifts, which an allowance can hinge on.
export type LoadState = { dispatcherLive: boolean }

// Known shifts, each a bug queued for its own fix, excused for one element on the routes it names, and only while its condition holds, until that fix lands and its PR removes the entry. A shift counts unless every element it moved is excused.
export const CLS_ALLOWED: {
  element: string
  routes: string[]
  when?: (state: LoadState) => boolean
  why: string
}[] = []

const excused = (route: string, shift: Shift, state: LoadState): boolean =>
  shift.sources.length > 0 &&
  shift.sources.every((source) =>
    CLS_ALLOWED.some(
      (allowed) =>
        allowed.routes.includes(route) &&
        (allowed.when?.(state) ?? true) &&
        (source.element === allowed.element || source.element.startsWith(`${allowed.element} `)),
    ),
  )

const sum = (shifts: Shift[]): number => shifts.reduce((total, shift) => total + shift.value, 0)

// Pure: one load's shifts as a result, counting only those no input caused and CLS_ALLOWED does not excuse, and naming each element that moved with its area, its y before and after, and its height when that changed too, since a part that grows moves its own content.
export const clsResult = (
  route: string,
  load: Load,
  shifts: Shift[],
  state: LoadState = { dispatcherLive: true },
): Result => {
  const check = `cls ${route} ${load}`
  const unprompted = shifts.filter((shift) => !shift.hadRecentInput)
  const counted = unprompted.filter((shift) => !excused(route, shift, state))
  const total = sum(counted)
  const known = sum(unprompted) - total
  const note = known > 0 ? ` (${known.toFixed(4)} more excused as a known bug)` : ""
  if (total <= CLS_LIMIT) {
    return pass(check, `${total.toFixed(4)} over ${CLS_SETTLE_MS / 1000}s${note}`)
  }
  const moved = new Set<string>()
  for (const shift of counted) {
    if (!shift.sources.length) moved.add(`an element since removed (${shift.value.toFixed(4)})`)
    for (const { area, element, from, to } of shift.sources) {
      const size = from.height === to.height ? "" : `, height ${from.height} -> ${to.height}`
      moved.add(`${area} ${element} y ${from.y} -> ${to.y}${size}`)
    }
  }
  return fail(check, `shifted ${total.toFixed(4)}: ${[...moved].join("; ")}${note}`)
}

// One load of a route, cold (as a first visit, though still signed in) or warm (as the next one), watched by the observer the browser was started with.
export const cls = async (
  browser: Browser,
  { api, web }: Target,
  route: string,
  load: Load,
): Promise<Result> => {
  // A dashboard page keeps writing what it stores while it is open, so storage is cleared from a page on the same origin that runs none of the app.
  if (load === "cold") {
    await browser.run("open", `${web}/api/health`)
    await browser.forget()
  }
  await browser.visit(`${web}${route}`)
  await browser.run("wait", String(CLS_SETTLE_MS))
  const shifts = await browser.eval<Shift[] | null>("window.__verifyShifts ?? null")
  if (!shifts) return fail(`cls ${route} ${load}`, "the layout-shift observer did not run")
  // Read as the sidebar reads it, by role; a list that does not read counts as a dispatcher live, so it excuses nothing.
  const dispatcherLive = await browser.eval<boolean>(
    `fetch(${JSON.stringify(`${api}/api/v1/workers`)}, { credentials: "include" }).then((response) => response.ok ? response.json() : null).then((body) => !Array.isArray(body?.data) || body.data.some((worker) => worker.role === "dispatcher")).catch(() => true)`,
  )
  return clsResult(route, load, shifts, { dispatcherLive })
}

// A chat view with no composer: a live session that is neither a dispatcher, the assistant nor hosted, whose view is read-only, so its Checkpoint bar stands under the stream alone. Null when the board has none. Read from a page of the dashboard's own origin.
export const readOnlyChat = (browser: Browser, { api }: Target): Promise<string | null> =>
  browser.eval<string | null>(
    `fetch(${JSON.stringify(`${api}/api/v1/workers`)}, { credentials: "include" }).then((response) => response.ok ? response.json() : null).then((body) => { const worker = Array.isArray(body?.data) ? body.data.find((worker) => worker.role !== "dispatcher" && !worker.hosted && !worker.assistant) : null; return worker ? "/dashboard?worker=" + encodeURIComponent(worker.sessionId) : null }).catch(() => null)`,
  )

// The chat's Checkpoint bar changing, each step a script so no input excuses its shift: a click turns Reading, a scroll up shows Scroll to end, its click hides it, the up arrow jumps, and a click turns Watching again.
const CHAT_STEPS = [
  `(() => { const toggle = document.querySelector("[data-slot=chat-mode]"); if (toggle?.dataset.mode !== "reading") toggle?.click(); return true })()`,
  `(() => { document.querySelector("[data-slot=message-scroller-viewport]")?.scrollBy(0, -400); return true })()`,
  `(() => { document.querySelector("[data-slot=chat-checkpoint] [aria-label='Scroll to end']")?.click(); return true })()`,
  `(() => { document.querySelector("[data-slot=chat-checkpoint] [aria-label='Previous message of yours']")?.click(); return true })()`,
  `(() => { const toggle = document.querySelector("[data-slot=chat-mode]"); if (toggle?.dataset.mode !== "watching") toggle?.click(); return true })()`,
]
// Long enough for each step's motion (180ms at most) and any glide it starts to have run.
const CHAT_STEP_MS = 1000

// The chat's Checkpoint bar moves nothing as it changes: on /dashboard, once loaded, with the shifts of its load set aside, every one of CHAT_STEPS.
export const clsChat = async (browser: Browser, { web }: Target): Promise<Result> => {
  const check = "cls /dashboard chat bar"
  await browser.visit(`${web}/dashboard`)
  await browser.run("wait", String(CLS_SETTLE_MS))
  if (!(await browser.eval<boolean>(`Boolean(document.querySelector("[data-slot=chat-mode]"))`)))
    return fail(check, "the chat's Checkpoint bar is not on the page")
  await browser.eval<boolean>(
    "window.__verifyShifts ? ((window.__verifyShifts.length = 0), true) : false",
  )
  for (const step of CHAT_STEPS) {
    await browser.eval<boolean>(step)
    await browser.run("wait", String(CHAT_STEP_MS))
  }
  const shifts = await browser.eval<Shift[] | null>("window.__verifyShifts ?? null")
  if (!shifts) return fail(check, "the layout-shift observer did not run")
  return { ...clsResult("/dashboard", "warm", shifts), check }
}

// Screenshots leave the machine on PRs, so they are taken only on a stack whose dashboard reads the fixture, a made-up machine: a stack that reads the live one (the live dashboard, PLAYGROUND_LIVE_READS, or a person's own clone) shows every real session's name, task and words. The web is asked as well as the API, through its own /api rewrite, since its pages show the API it proxies to, whatever --api names. cls holds to it too, since the live machine's sessions come and go as it loads, and so does send-top, since it types into the dispatcher and writes its reply into the fixture, and send-focus, which sends the dispatcher one message, and slash-menu, which needs the fixture's many skills and types into the dispatcher's box, and reply-focus and aside-bar, which post a card into this checkout's own database, and upload-keep, which uploads a file into the fixture's folder, and stream-renders and typing-lag, which write steps into the fixture's transcripts.
export const fixtureOnly = async (
  { api, web }: Target,
  check:
    | "aside-bar"
    | "cls"
    | "reply-focus"
    | "screenshots"
    | "send-focus"
    | "send-top"
    | "slash-menu"
    | "stream-renders"
    | "typing-lag"
    | "upload-keep" = "screenshots",
): Promise<Result> => {
  const bases = [...new Set([web, api])]
  for (const base of bases) {
    const data = await readHealth(base)
    if (typeof data === "string") return fail(check, data)
    if (data.dashboard !== "fixture") {
      return fail(
        check,
        `${base} reports dashboard: ${data.dashboard ?? "unknown"}, not fixture, so its pages show live data; run ${check} only on a fixture stack (a checkout under .claude/worktrees/ or a session with PLAYGROUND_ROLE, or PLAYGROUND_FIXTURE set, with PLAYGROUND_LIVE_READS unset)`,
      )
    }
  }
  return pass(check, `${bases.join(" and ")} read the fixture`)
}

export const LABELS = ["after", "before"] as const
export type Label = (typeof LABELS)[number]

// A file name for a route at a viewport, led by which side of the change it shows: /dashboard/apps at 1280×800, before, is before-dashboard-apps-1280x800.png.
export const screenshotName = (
  route: string,
  { height, width }: Viewport,
  label: Label,
  theme: Theme = "light",
): string =>
  `${label}-${
    route
      .replace(/^\/+/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/-+$/, "") || "home"
  }-${width}x${height}${theme === "dark" ? "-dark" : ""}.png`

// The agent-browser wait for each page screenshots shoots, inside the page's own half ([data-dashboard-page], since the aside beside it draws cards and empties of its own), on something it draws only once its data is in, since network idle ignores the board's WebSocket frames and a shot at idle can catch a spinner.
export const READY: Record<string, string[]> = {
  "/dashboard": ['[data-dashboard-page] [role="log"] [data-slot="message"]'],
  "/dashboard/apps": ['[data-dashboard-page] [data-slot="item"]'],
  "/dashboard/apps/changelog": ['[data-dashboard-page] input[aria-label="Search changes"]'],
  // Now's lanes come from the plan read, which can answer after the report that draws its heading
  "/dashboard/apps/plan": ['[data-dashboard-page] section[aria-labelledby="report-now"] ul'],
  "/dashboard/apps/previews": ['[data-dashboard-page] [data-slot="card"]'],
  "/dashboard/apps/usage": ["[data-dashboard-page] h2#usage-windows"],
  "/dashboard/sessions": [
    '[data-dashboard-page] [data-slot="empty"], [data-dashboard-page] tbody tr[data-state]',
  ],
  "/dashboard/settings": ['[data-dashboard-page] [data-slot="item"]'],
  // Paused shows once the board is read, and the System panel draws its lines only once its own read answers
  "/dashboard/system": ['[data-dashboard-page]:has(section[aria-labelledby="system"] p) h2#paused'],
}

// The sidebar's rows are in once a menu of the nav reads ready (the header's dispatcher rows read ready before the nav draws) and none still reads loading; a phone, under 768 wide, draws no menu until it opens.
export const SIDEBAR_READY = [
  "--fn",
  `innerWidth < 768 || (!!document.querySelector('[data-sidebar="content"] [data-sidebar="menu"][data-agents="ready"]') && !document.querySelector('[data-sidebar="menu"][data-agents="loading"]'))`,
]

// A page's data is in once no region outside the sidebar reads aria-busy, the app's loading mark (the aside's Inbox until its first data render, a settings panel, the status table); SIDEBAR_READY covers the sidebar, whose stored menu stays busy while it shows stored rows.
export const DATA_READY = [
  "--fn",
  `![...document.querySelectorAll('[aria-busy="true"]')].some((el) => !el.closest('[data-sidebar]'))`,
]

// The routes a run has fetched once, and how it fetches: a cold next dev compiles a route on its first request, and under load 48 that compile wedged the browser's first open (page_wedged on /robots.txt) until the pages were fetched by hand.
export type Warm = { done: Set<string>; fetch: (url: string) => Promise<unknown> }

// Up to 2 minutes for one cold compile, then the open goes on regardless, since a warm-up is only a head start.
export const WARM_MS = 120_000
export const warmFetch = (url: string): Promise<unknown> =>
  fetch(url, { signal: AbortSignal.timeout(WARM_MS) }).then((response) => response.arrayBuffer())

// Fetches a route once per run before the browser first opens it; a fetch that fails or times out still lets the open go on.
export const warmUp = async (warm: Warm, web: string, route: string): Promise<void> => {
  if (warm.done.has(route)) return
  warm.done.add(route)
  await warm.fetch(`${web}${route}`).catch(() => undefined)
}

// Each shot loads its page fresh through a blank page, since an open that changes only the hash keeps the page an earlier shot loaded; a route READY does not name (a session's own page) waits on its data alone; a wait that runs out still takes the shot, and the result names each wait that ran out.
export const screenshot = async (
  browser: Browser,
  { web }: Target,
  route: string,
  viewport: Viewport,
  out: string,
  label: Label,
  theme: Theme = "light",
  warm: Warm = { done: new Set(), fetch: warmFetch },
): Promise<Result> => {
  const path = join(out, screenshotName(route, viewport, label, theme))
  await warmUp(warm, web, route)
  await browser.viewport(viewport)
  await browser.run("set", "media", theme)
  await browser.run("open", "about:blank")
  await browser.visit(`${web}${route}`)
  const ready = READY[new URL(route, "http://dashboard").pathname]
  const data: [string, string[]] = ["the page's data", DATA_READY]
  const waits: [string, string[]][] = ready
    ? [["the page's ready marker", ready], ["the sidebar", SIDEBAR_READY], data]
    : [data]
  const ranOut: string[] = []
  const wait = async ([name, args]: [string, string[]]) => {
    try {
      await browser.run("wait", ...args)
    } catch (error) {
      ranOut.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  for (const step of waits) await wait(step)
  await browser.run("screenshot", "--full", path)
  // A full shot sizes the page to 1x1 and back, which can draw a region anew; a page busy again after it is shot once more when its data is back in, and an eval that fails there reads as busy, so the wait above takes it.
  if (!(await browser.eval<boolean>(DATA_READY[1]!).catch(() => false))) {
    await wait(["the page's data after the shot", DATA_READY])
    await browser.run("screenshot", "--full", path)
  }
  return ranOut.length
    ? fail(`screenshot ${route}`, `${path} was shot, but its wait ran out on ${ranOut.join("; ")}`)
    : pass(`screenshot ${route}`, path)
}

export const map = async (): Promise<Result> => {
  const problems = await driftProblems()
  return problems.length
    ? fail("map", problems.join("\n  "))
    : pass(
        "map",
        `${DASHBOARD_MAP.pages.length} pages and ${DASHBOARD_MAP.sidebar.length} sidebar groups match the code`,
      )
}

type UsageWindow = { resetsAt: string | null; seenAt?: string; usedPercent: number } | null

// The part of GET /api/v1/system a lead reads before it spawns; the rest is the panel's.
export type SystemBody = {
  capacity?: {
    idle?: { line?: string | null; ready?: boolean }
    line?: unknown
    orchestrators?: { line?: unknown }
    workers?: unknown
  }
  problems?: string[]
  sampledAt?: string
  usage?: {
    fiveHour: UsageWindow
    sevenDay: UsageWindow
    stale: boolean
    writtenAt: string
  } | null
}

const windowWords = (label: string, window: UsageWindow, now: number): string | null => {
  if (!window) return null
  const parts = [
    window.resetsAt &&
      `${Date.parse(window.resetsAt) <= now ? "reset" : "resets"} ${window.resetsAt}`,
    window.seenAt && `stale, last seen ${window.seenAt}`,
  ].filter(Boolean)
  return `${label} ${Math.round(window.usedPercent)}%${parts.length ? ` (${parts.join("; ")})` : ""}`
}

// A sample older than this means sampling has stopped (it runs every 30s), so its room is no longer this machine's.
export const SYSTEM_STALE_MS = 90_000

// Pure: the system route's body as a line each: room, the orchestrators' room when the body holds it, idle stacks, usage and what did not read (a probe that failed, or a timer a failed hot reload stopped, which a restart of the API mends). A body without a room line or a worker count, or one sampled over 90s ago, fails, since a lead would spawn on it; no usage passes and says so, since usage holds back no spawn.
export const systemResults = (body: SystemBody, now = Date.now()): Result[] => {
  const capacity = body.capacity
  if (typeof capacity?.line !== "string" || typeof capacity.workers !== "number") {
    return [fail("system", "the body has no capacity line and worker count")]
  }
  const sampled = Date.parse(body.sampledAt ?? "")
  if (Number.isNaN(sampled) || now - sampled > SYSTEM_STALE_MS) {
    return [
      fail(
        "system",
        `the last sample is from ${body.sampledAt ?? "an unknown time"}, so sampling has stopped: its room is not this machine's now`,
      ),
    ]
  }
  const idle = capacity.idle
  const usage = body.usage
  const windows = usage
    ? [windowWords("5-hour", usage.fiveHour, now), windowWords("week", usage.sevenDay, now)].filter(
        Boolean,
      )
    : []
  return [
    pass("system", `${capacity.line} (sampled ${body.sampledAt})`),
    ...(typeof capacity.orchestrators?.line === "string"
      ? [pass("orchestrators", capacity.orchestrators.line)]
      : []),
    pass(
      "idle",
      idle?.line ??
        (idle?.ready
          ? "no worker's dev stack has idled 15 minutes"
          : "not judged yet: the sampler has watched under 15 minutes"),
    ),
    pass(
      "usage",
      !usage
        ? "no reading (usage holds back no spawn: room is the machine's)"
        : `${windows.join(", ")}${usage.stale ? `, stale since ${usage.writtenAt}: check the ops-usage job` : ""}`,
    ),
    pass("problems", body.problems?.length ? body.problems.join("; ") : "none"),
  ]
}

// The machine's room for more workers, as the Dashboard's System panel shows it.
export const system = async ({ api, web }: Target, cookie: string): Promise<Result[]> => {
  const response = await request(`${api}/api/v1/system`, { headers: { cookie, origin: web } })
  if (!response.ok) {
    return [fail("system", `/api/v1/system answered ${response.status}: ${await response.text()}`)]
  }
  const { data } = (await response.json()) as { data: SystemBody }
  return systemResults(data)
}

export type AgentRow = { name: string; state: string; status?: string | null }

// Pure: whether the agents route reads a session as ended, the roster's `ended` and no live session of its name, which is how the Dashboard reads Ended; a read with no live sessions (the sessions read failed) or a herdr server that did not read would show a live session as down, so either fails rather than pass on it.
export const endedResult = (
  name: string,
  agents: AgentRow[],
  liveProblem: string | null,
  problems: string[] = [],
): Result => {
  if (liveProblem) return fail("ended", `live sessions could not be read: ${liveProblem}`)
  const herdr = problems.find((p) => p.startsWith("herdr's "))
  if (herdr) return fail("ended", herdr)
  const rows = agents.filter((a) => a.name === name)
  if (!rows.length) return fail("ended", `no roster entry or live session is named ${name}`)
  const live = rows.find((a) => a.state !== "down")
  if (live) return fail("ended", `${name} is still live (${live.state})`)
  const open = rows.find((a) => a.status !== "ended")
  if (open) {
    return fail(
      "ended",
      `${name} is down, but the roster reads ${open.status ?? "no status"}: record its end with roster.ts set ${name} status=ended`,
    )
  }
  return pass("ended", `${name} is down and the roster reads ended`)
}

// A session's end, as the Dashboard reads it (Ended), so a lead can check a herdr session whose server its own herdr reads cannot reach.
export const ended = async (
  { api, web }: Target,
  cookie: string,
  name: string,
): Promise<Result> => {
  const headers = { cookie, origin: web }
  // The agents read notes a hung herdr server only once it settles, so the system read waits for it.
  const agents = await request(`${api}/api/v1/agents`, { headers })
  const report = await request(`${api}/api/v1/system`, { headers })
  for (const [route, response] of [
    ["/api/v1/agents", agents],
    ["/api/v1/system", report],
  ] as const) {
    if (!response.ok)
      return fail("ended", `${route} answered ${response.status}: ${await response.text()}`)
  }
  const { data } = (await agents.json()) as {
    data: { agents: AgentRow[]; liveProblem: string | null }
  }
  const { data: system } = (await report.json()) as { data: { problems?: string[] } }
  return endedResult(name, data.agents, data.liveProblem, system.problems)
}

const CHECKS = [
  "all",
  "aside-bar",
  "changelog-entry",
  "cls",
  "cursor",
  "ended",
  "extension-node",
  "facets",
  "focus-marks",
  "health",
  "map",
  "memory",
  "pages",
  "problems",
  "rail",
  "reply-focus",
  "rows",
  "screenshots",
  "send-focus",
  "send-top",
  "signin",
  "slash-menu",
  "stream-renders",
  "system",
  "tooltips",
  "typing-lag",
  "upload-keep",
  "ws",
] as const

export type Check = (typeof CHECKS)[number]

// Only pages, extension-node, screenshots, cls, tooltips and all read the words after them as routes; any other check refuses them, so `verify health cursor` never reads as two checks run.
const ROUTED_CHECKS: Check[] = ["all", "cls", "extension-node", "pages", "screenshots", "tooltips"]

export const isCheck = (word: string): word is Check => (CHECKS as readonly string[]).includes(word)

// A bare `bun run verify` runs all; a first word that is no check reads as none.
export const readCheck = ([word = "all", ...routes]: string[]) =>
  isCheck(word) ? { check: word, routes } : null

export const strayRoutes = (check: Check, routes: string[]): string | null => {
  if (check === "ended") return routes.length === 1 ? null : "ended takes one session name"
  if (!routes.length || ROUTED_CHECKS.includes(check)) return null
  return routes.length === 1 && isCheck(routes[0]!)
    ? `${check} takes no route; did you mean \`verify ${check}\` then \`verify ${routes[0]}\`?`
    : `${check} takes no route: ${routes.join(" ")}`
}

// What each control's cursor must read: the composer's Send and Attach the pointer, a plain disabled button (no component's classes) not-allowed, and the sidebar rail its own resize cursor, which the base rule must not override. A disabled shadcn Button or item is pointer-events-none, so its cursor is what lies under it and is not read here.
export const CURSORS: Record<string, string[]> = {
  attach: ["pointer"],
  "plain disabled button": ["not-allowed"],
  rail: ["e-resize", "w-resize"],
  send: ["pointer"],
}

const COMPOSER = ["attach", "send"]

// notRunning is /dashboard's own empty-state title ("Playground is not running"): with it and no composer drawn, Send and Attach are skipped by name, never passed. shows is any other empty-state title there, named when neither drew.
export const cursorResult = (
  read: Record<string, string | null>,
  notRunning: string | null = null,
  shows: string | null = null,
): Result => {
  const noComposer = COMPOSER.every((name) => read[name] === null)
  const skip = notRunning !== null && noComposer
  const checked = Object.entries(CURSORS).filter(([name]) => !(skip && COMPOSER.includes(name)))
  const wrong = checked
    .filter(([name, allowed]) => !allowed.includes(read[name] ?? ""))
    .map(
      ([name, allowed]) => `${name} reads ${read[name] ?? "nothing"}, not ${allowed.join(" or ")}`,
    )
  const skipped = `skipped attach and send: no composer, ${notRunning}`
  const why = noComposer
    ? `no composer and no not-running state on /dashboard${shows ? `; it shows "${shows}"` : ""}`
    : null
  const readings = checked.map(([name]) => `${name} ${read[name]}`).join(", ")
  return {
    check: "cursor",
    detail: wrong.length
      ? `${wrong.join("; ")}${skip ? ` (${skipped})` : why ? ` (${why})` : ""}`
      : skip
        ? `${skipped}; ${readings}`
        : readings,
    ok: wrong.length === 0,
  }
}

// Reads each control's computed cursor on /dashboard at 1280, once the composer or the dispatcher's not-running state draws (within 10s); the plain disabled button is made in the page and removed again, so the check only reads.
export const cursor = async (browser: Browser, { web }: Target): Promise<Result> => {
  await browser.viewport(VIEWPORTS[0]!)
  await browser.visit(`${web}/dashboard`)
  const { notRunning, shows, ...read } = await browser.eval<Record<string, string | null>>(
    `new Promise((resolve) => { const started = Date.now(); const look = () => { const send = document.querySelector('button[aria-label^="Send to"]'); const titles = [...document.querySelectorAll('[data-slot="empty-title"]')].map((title) => title.textContent.trim()); const notRunning = titles.find((title) => title.endsWith(" is not running")) ?? null; if (!send && !notRunning && Date.now() - started < 10000) return setTimeout(look, 200); const of = (element) => (element ? getComputedStyle(element).cursor : null); const made = (html) => { const holder = document.createElement("div"); holder.innerHTML = html; document.body.append(holder); const value = of(holder.firstElementChild); holder.remove(); return value }; resolve({ attach: of(document.querySelector('button[aria-label="Attach files"]')), notRunning, "plain disabled button": made("<button disabled>x</button>"), rail: of(document.querySelector('[data-sidebar="rail"]')), send: of(send), shows: titles.join("; ") || null }) }; look() })`,
  )
  return cursorResult(read, notRunning ?? null, shows ?? null)
}
