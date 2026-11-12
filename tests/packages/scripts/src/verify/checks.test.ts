import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  Browser,
  checkPage,
  cursorResult,
  DATA_READY,
  ended,
  endedResult,
  fixtureDirOf,
  fixtureOnly,
  health,
  problems,
  READY,
  resolveExpectation,
  screenshot,
  screenshotName,
  SHOT_VIEWPORTS,
  SIDEBAR_READY,
  signInWaitArgs,
  SIGNIN_WAIT_MS,
  systemResults,
  THEMES,
  versionMatches,
  homeHeading,
} from "../../../../../packages/scripts/src/verify/checks"
import { DASHBOARD_MAP } from "../../../../../packages/scripts/src/verify/map"
import { VERIFY_VISIT } from "../../../../../web/next/src/lib/verify-visit"

const SHA = "8064f3d1c2b0a9e8f7d6c5b4a3928170e6d5c4b3"

// A cold next dev compile of /dashboard took over 25s under load, agent-browser's default action timeout, so the wait that covers the sign-in's redirect carries its own longer budget.
describe("signInWaitArgs", () => {
  test("the sign-in wait covers a cold compile, past the 25s default", () => {
    expect(SIGNIN_WAIT_MS).toBeGreaterThanOrEqual(60_000)
    expect(signInWaitArgs()).toEqual([
      "wait",
      "--url",
      "**/dashboard",
      "--timeout",
      String(SIGNIN_WAIT_MS),
    ])
  })
})

describe("versionMatches", () => {
  test("a commit matches the version whose short sha starts it", () => {
    expect(versionMatches("0.0.0-8064f3d", { label: "HEAD", sha: SHA })).toBe(true)
    expect(versionMatches("0.0.0-3e13863", { label: "HEAD", sha: SHA })).toBe(false)
  })

  test("a version built without a sha matches no commit", () => {
    expect(versionMatches("0.0.0", { label: "HEAD", sha: SHA })).toBe(false)
  })

  test("a literal version matches only itself", () => {
    expect(
      versionMatches("0.0.0-8064f3d", { label: "0.0.0-8064f3d", version: "0.0.0-8064f3d" }),
    ).toBe(true)
    expect(versionMatches("0.0.0-8064f3d", { label: "0.0.0", version: "0.0.0" })).toBe(false)
  })
})

describe("resolveExpectation", () => {
  test("a revision resolves to its whole commit; anything else stays a literal version", () => {
    const head = resolveExpectation("HEAD")
    expect("sha" in head && /^[0-9a-f]{40}$/.test(head.sha)).toBe(true)
    expect(resolveExpectation("0.0.0-not-a-commit")).toEqual({
      label: "0.0.0-not-a-commit",
      version: "0.0.0-not-a-commit",
    })
  })
})

test("screenshotName names a route at a viewport, led by the side of the change it shows", () => {
  const at = { height: 800, width: 1280 }
  expect(screenshotName("/dashboard/apps", at, "before")).toBe("before-dashboard-apps-1280x800.png")
  expect(screenshotName("/dashboard?worker=s-1", at, "after")).toBe(
    "after-dashboard-worker-s-1-1280x800.png",
  )
  expect(screenshotName("/", { height: 972, width: 1782 }, "after")).toBe("after-home-1782x972.png")
  expect(screenshotName("/dashboard", { height: 844, width: 390 }, "after", "dark")).toBe(
    "after-dashboard-390x844-dark.png",
  )
})

test("screenshots cover a phone and both themes", () => {
  expect(SHOT_VIEWPORTS).toContainEqual({ height: 844, width: 390 })
  expect(SHOT_VIEWPORTS).toContainEqual({ height: 800, width: 1280 })
  expect([...THEMES]).toEqual(["light", "dark"])
})

describe("fixtureOnly", () => {
  // A stand-in API whose /api/health reports the dashboard source each test names.
  const serve = (dashboard: string | undefined) =>
    Bun.serve({
      fetch: () => Response.json({ data: { dashboard, environment: "local", message: "ok" } }),
      hostname: "127.0.0.1",
      port: 0,
    })

  test("passes a stack whose dashboard reads the fixture", async () => {
    const server = serve("fixture")
    const api = `http://127.0.0.1:${server.port}`
    expect((await fixtureOnly({ api, web: api })).ok).toBe(true)
    await server.stop(true)
  })

  test("refuses one that reads the live machine, or does not say, since its pages show live data", async () => {
    for (const dashboard of ["live", "refused", undefined]) {
      const server = serve(dashboard)
      const api = `http://127.0.0.1:${server.port}`
      const result = await fixtureOnly({ api, web: api })
      expect(result.ok).toBe(false)
      expect(result.detail).toContain(`reports dashboard: ${dashboard ?? "unknown"}, not fixture`)
      await server.stop(true)
    }
  })

  test("asks the web too, since its pages show the API it proxies to, whatever --api names", async () => {
    const live = serve("live")
    const fixture = serve("fixture")
    const web = `http://127.0.0.1:${live.port}`
    const api = `http://127.0.0.1:${fixture.port}`
    const result = await fixtureOnly({ api, web })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(`${web} reports dashboard: live, not fixture`)
    await live.stop(true)
    await fixture.stop(true)
  })
})

describe("problems", () => {
  // A stand-in API whose /api/health reports the database state each test names.
  const serve = (data: object) =>
    Bun.serve({
      fetch: () => Response.json({ data }),
      hostname: "127.0.0.1",
      port: 0,
    })

  test("passes a stack whose database answers", async () => {
    const server = serve({
      db: "ok",
      environment: "local",
      message: "ok",
      version: "0.0.0-8064f3d",
    })
    const api = `http://127.0.0.1:${server.port}`
    expect(await problems({ api, web: api })).toEqual({
      check: "problems",
      detail: "the database answers (0.0.0-8064f3d, local)",
      ok: true,
    })
    await server.stop(true)
  })

  test("names a database the stack cannot reach, with the error the route gave", async () => {
    const server = serve({
      db: "unreachable",
      dbError: "Connect failed: Connection refused",
      environment: "local",
      message: "degraded",
      version: "0.0.0-8064f3d",
    })
    const api = `http://127.0.0.1:${server.port}`
    expect(await problems({ api, web: api })).toEqual({
      check: "problems",
      detail:
        "the database is unreachable: Connect failed: Connection refused (0.0.0-8064f3d, local)",
      ok: false,
    })
    await server.stop(true)
  })

  test("a body that names no database passes as an older build's", async () => {
    const server = serve({ environment: "local", message: "ok", version: "0.0.0" })
    const api = `http://127.0.0.1:${server.port}`
    const result = await problems({ api, web: api })
    expect(result.ok).toBe(true)
    expect(result.detail).toBe("the body names no database (0.0.0, local)")
    await server.stop(true)
  })

  test("a stack in first run's setup passes, saying it has no database yet", async () => {
    const server = serve({ environment: "local", message: "ok", setup: true, version: "0.0.0" })
    const api = `http://127.0.0.1:${server.port}`
    expect(await problems({ api, web: api })).toEqual({
      check: "problems",
      detail: "in setup, with no database yet (0.0.0, local)",
      ok: true,
    })
    await server.stop(true)
  })

  test("a health read that fails fails as itself, naming the URL", async () => {
    const api = "http://127.0.0.1:9"
    const result = await problems({ api, web: api })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(`${api}/api/health`)
  })
})

describe("health", () => {
  test("passes a stack in first run's setup, naming it", async () => {
    const server = Bun.serve({
      fetch: () =>
        Response.json({
          data: {
            dashboard: "fixture",
            environment: "local",
            message: "ok",
            setup: true,
            version: "0.0.0-8064f3d",
          },
        }),
      hostname: "127.0.0.1",
      port: 0,
    })
    const api = `http://127.0.0.1:${server.port}`
    expect(await health({ api, web: api }, { label: "HEAD", sha: SHA })).toEqual({
      check: "health",
      detail: "0.0.0-8064f3d (local, dashboard: fixture, in setup) matches HEAD",
      ok: true,
    })
    await server.stop(true)
  })
})

describe("systemResults", () => {
  const NOW = Date.parse("2026-10-06T08:30:20.000Z")
  const SAMPLED = "2026-10-06T08:30:00.000Z"
  const capacity = {
    idle: { line: "Stop the idle dev stack to free 0.8 GB", ready: true },
    line: "Room for ~4 more workers, by CPU load",
    workers: 4,
  }

  test("the room, the idle stacks and the usage windows, one line each", () => {
    const usage = {
      fiveHour: { resetsAt: "2026-10-06T13:00:00.000Z", usedPercent: 23.6 },
      sevenDay: { resetsAt: null, usedPercent: 21 },
      stale: false,
      writtenAt: "2026-10-06T08:29:50.000Z",
    }
    expect(systemResults({ capacity, sampledAt: SAMPLED, usage }, NOW)).toEqual([
      {
        check: "system",
        detail: "Room for ~4 more workers, by CPU load (sampled 2026-10-06T08:30:00.000Z)",
        ok: true,
      },
      { check: "idle", detail: "Stop the idle dev stack to free 0.8 GB", ok: true },
      {
        check: "usage",
        detail: "5-hour 24% (resets 2026-10-06T13:00:00.000Z), week 21%",
        ok: true,
      },
      { check: "problems", detail: "none", ok: true },
    ])
  })

  test("the orchestrators' room follows the workers' when the body holds it", () => {
    const orchestrators = { line: "Room for ~13 more orchestrators, by memory" }
    expect(
      systemResults({ capacity: { ...capacity, orchestrators }, sampledAt: SAMPLED }, NOW)[1],
    ).toEqual({
      check: "orchestrators",
      detail: "Room for ~13 more orchestrators, by memory",
      ok: true,
    })
  })

  test("what did not read is printed, so a lead sees a stopped timer or a failed probe", () => {
    const results = systemResults(
      { capacity, problems: ["docker stats: ran past 10s", "timer lost"], sampledAt: SAMPLED },
      NOW,
    )
    expect(results.at(-1)).toEqual({
      check: "problems",
      detail: "docker stats: ran past 10s; timer lost",
      ok: true,
    })
  })

  test("no usage says it holds back no spawn, a stale one says to check the ops-usage job; idle stacks wait for 15 minutes of samples", () => {
    const [, idle, usage] = systemResults(
      { capacity: { ...capacity, idle: { ready: false } }, sampledAt: SAMPLED },
      NOW,
    )
    expect(idle?.detail).toBe("not judged yet: the sampler has watched under 15 minutes")
    expect(usage?.detail).toBe("no reading (usage holds back no spawn: room is the machine's)")
    const stale = systemResults(
      {
        capacity: { ...capacity, idle: { line: null, ready: true } },
        sampledAt: SAMPLED,
        usage: {
          fiveHour: { resetsAt: null, usedPercent: 40 },
          sevenDay: null,
          stale: true,
          writtenAt: "2026-10-06T08:00:00.000Z",
        },
      },
      NOW,
    )
    expect(stale[1]?.detail).toBe("no worker's dev stack has idled 15 minutes")
    expect(stale[2]?.detail).toBe(
      "5-hour 40%, stale since 2026-10-06T08:00:00.000Z: check the ops-usage job",
    )
    const lastSeen = systemResults(
      {
        capacity,
        sampledAt: SAMPLED,
        usage: {
          fiveHour: {
            resetsAt: "2026-10-06T07:00:00.000Z",
            seenAt: "2026-10-06T06:00:00.000Z",
            usedPercent: 40,
          },
          sevenDay: { resetsAt: null, usedPercent: 21 },
          stale: false,
          writtenAt: "2026-10-06T08:29:50.000Z",
        },
      },
      NOW,
    )
    expect(lastSeen[2]?.detail).toBe(
      "5-hour 40% (reset 2026-10-06T07:00:00.000Z; stale, last seen 2026-10-06T06:00:00.000Z), week 21%",
    )
  })

  test("a sample over 90s old fails, since sampling has stopped and a lead would spawn on it", () => {
    const [frozen] = systemResults({ capacity, sampledAt: SAMPLED }, NOW + 91_000)
    expect(frozen).toEqual({
      check: "system",
      detail:
        "the last sample is from 2026-10-06T08:30:00.000Z, so sampling has stopped: its room is not this machine's now",
      ok: false,
    })
    expect(systemResults({ capacity }, NOW)[0]?.ok).toBe(false)
  })

  test("a body with no room line or worker count fails, since a lead would spawn on it", () => {
    expect(systemResults({}, NOW)).toEqual([
      { check: "system", detail: "the body has no capacity line and worker count", ok: false },
    ])
    expect(
      systemResults({ capacity: { line: "Room for ~4 more workers" }, sampledAt: SAMPLED }, NOW)[0]
        ?.ok,
    ).toBe(false)
  })
})

// Network idle ignores the board's WebSocket frames, so a page counts as drawn only once its own ready marker shows.
describe("screenshot", () => {
  // A browser that records each command, whose waits for the page's marker and for its data answer after a beat or time out.
  class FakeBrowser extends Browser {
    calls: string[][] = []
    constructor(
      private marker: "late" | "never",
      private data: "late" | "never" = "late",
      private afterShot: "busy" | "fails" | "settled" = "settled",
    ) {
      super()
    }
    override async run(...args: string[]): Promise<Record<string, unknown>> {
      this.calls.push(args)
      // the data check after a shot reads busy after the first shot alone, when afterShot is busy, and fails there when it fails
      if (args[0] === "eval" && args[1] === DATA_READY[1]) {
        const shots = this.calls.filter((call) => call[0] === "screenshot").length
        if (this.afterShot === "fails" && shots === 1)
          throw new Error(`agent-browser ${args.join(" ")}: Execution context was destroyed`)
        return { result: !(this.afterShot === "busy" && shots === 1) }
      }
      const waitsOn =
        args[0] !== "wait"
          ? null
          : args[1] === READY["/dashboard/system"]![0]
            ? this.marker
            : args[2] === DATA_READY[1]
              ? this.data
              : null
      if (waitsOn) {
        await Bun.sleep(20)
        if (waitsOn === "never") throw new Error(`agent-browser ${args.join(" ")}: Wait timed out`)
      }
      return {}
    }
  }
  const at = { api: "http://api", web: "http://web" }
  const warmNone = { done: new Set<string>(), fetch: async () => {} }
  const shoot = (browser: Browser) =>
    screenshot(
      browser,
      at,
      "/dashboard/system",
      SHOT_VIEWPORTS[0]!,
      "/tmp/shots",
      "after",
      "light",
      warmNone,
    )

  // under load 48 a cold route's first open wedged the browser until the pages were fetched once by hand
  test("a cold route is fetched once before its first open, so its compile never lands on the browser", async () => {
    const order: string[] = []
    class Recording extends FakeBrowser {
      override async run(...args: string[]): Promise<Record<string, unknown>> {
        if (args[0] === "open") order.push(`open ${args[1]}`)
        return super.run(...args)
      }
    }
    const browser = new Recording("late")
    const warm = {
      done: new Set<string>(),
      fetch: async (url: string) => {
        order.push(`fetch ${url}`)
      },
    }
    for (const theme of ["light", "dark"] as const) {
      await screenshot(
        browser,
        at,
        "/dashboard/system",
        SHOT_VIEWPORTS[0]!,
        "/tmp/shots",
        "after",
        theme,
        warm,
      )
    }
    expect(order).toEqual([
      "fetch http://web/dashboard/system",
      "open about:blank",
      "open http://web/dashboard/system",
      "open about:blank",
      "open http://web/dashboard/system",
    ])
  })

  test("a warm-up that fails or hangs still lets the shot go on", async () => {
    const browser = new FakeBrowser("late")
    const warm = {
      done: new Set<string>(),
      fetch: async () => {
        throw new Error("connect ECONNREFUSED")
      },
    }
    const result = await screenshot(
      browser,
      at,
      "/dashboard/system",
      SHOT_VIEWPORTS[0]!,
      "/tmp/shots",
      "after",
      "light",
      warm,
    )
    expect(result.ok).toBe(true)
    expect(warm.done.has("/dashboard/system")).toBe(true)
  })

  test("every page verify shoots names its ready marker", () => {
    const shot = DASHBOARD_MAP.pages
      .map((page) => page.route)
      .filter((route) => !route.includes("["))
    expect(Object.keys(READY).sort()).toEqual(shot.sort())
  })

  test("every ready marker looks only in the page's own half, never the aside's Inbox beside it", () => {
    for (const [route, marker] of Object.entries(READY)) {
      const selector = marker.at(-1)!
      expect({ route, scoped: selector.includes("[data-dashboard-page]") }).toEqual({
        route,
        scoped: true,
      })
      expect({ route, main: /\bmain\b/.test(selector) }).toEqual({ route, main: false })
    }
  })

  test("a page whose marker comes late is shot after it shows", async () => {
    const browser = new FakeBrowser("late")
    const result = await shoot(browser)
    expect(result.ok).toBe(true)
    const verbs = browser.calls.map((args) => args.slice(0, 2).join(" "))
    const marker = verbs.indexOf(`wait ${READY["/dashboard/system"]![0]}`)
    const sidebar = verbs.indexOf(`wait ${SIDEBAR_READY[0]}`)
    expect(marker).toBeGreaterThan(verbs.indexOf("open http://web/dashboard/system"))
    expect(sidebar).toBeGreaterThan(marker)
    const data = browser.calls.findIndex((args) => args[0] === "wait" && args[2] === DATA_READY[1])
    expect(data).toBeGreaterThan(sidebar)
    expect(verbs.indexOf("screenshot --full")).toBeGreaterThan(data)
  })

  // An open whose URL differs from the page's only by its hash keeps the page (measured: performance.timeOrigin unchanged), so a route's later viewports and themes would shoot the page an earlier shot loaded.
  test("every shot loads its page fresh, through a blank page first", async () => {
    const browser = new FakeBrowser("late")
    await shoot(browser)
    const verbs = browser.calls.map((args) => args.slice(0, 2).join(" "))
    const route = verbs.indexOf("open http://web/dashboard/system")
    expect(route).toBeGreaterThan(0)
    expect(verbs[route - 1]).toBe("open about:blank")
  })

  test("a shot that leaves the page busy is taken again once its data is back in", async () => {
    const busy = new FakeBrowser("late", "late", "busy")
    expect((await shoot(busy)).ok).toBe(true)
    const shots = busy.calls.flatMap((args, i) => (args[0] === "screenshot" ? [i] : []))
    expect(shots).toHaveLength(2)
    const again = busy.calls.findIndex(
      (args, i) => i > shots[0]! && args[0] === "wait" && args[2] === DATA_READY[1],
    )
    expect(again).toBeGreaterThan(shots[0]!)
    expect(shots[1]).toBeGreaterThan(again)
    const settled = new FakeBrowser("late")
    await shoot(settled)
    expect(settled.calls.filter((args) => args[0] === "screenshot")).toHaveLength(1)
  })

  // #1742: the eval after a shot ran outside the wait's try, so one that failed failed the shot's check
  test("an eval after the shot that fails reads as the page not ready: its data is waited for and it is shot again", async () => {
    const failing = new FakeBrowser("late", "late", "fails")
    const result = await shoot(failing)
    expect(result.ok).toBe(true)
    const shots = failing.calls.flatMap((args, i) => (args[0] === "screenshot" ? [i] : []))
    expect(shots).toHaveLength(2)
    const again = failing.calls.findIndex(
      (args, i) => i > shots[0]! && args[0] === "wait" && args[2] === DATA_READY[1],
    )
    expect(again).toBeGreaterThan(shots[0]!)
    expect(shots[1]).toBeGreaterThan(again)
  })

  test("a route READY does not name is shot once its data is in", async () => {
    const browser = new FakeBrowser("late")
    await screenshot(
      browser,
      at,
      "/somewhere",
      SHOT_VIEWPORTS[0]!,
      "/tmp/shots",
      "after",
      "light",
      warmNone,
    )
    const data = browser.calls.findIndex((args) => args[0] === "wait" && args[2] === DATA_READY[1])
    expect(data).toBeGreaterThan(-1)
    expect(browser.calls.findIndex((args) => args[0] === "screenshot")).toBeGreaterThan(data)
  })

  test("a wait that runs out still takes the shot, and its result names that wait", async () => {
    const marker = new FakeBrowser("never")
    const late = await shoot(marker)
    expect(late.ok).toBe(false)
    expect(late.detail).toContain("the page's ready marker")
    expect(late.detail).toContain("Wait timed out")
    expect(late.detail).toContain("/tmp/shots/after-dashboard-system-1280x800.png")
    expect(marker.calls.some((args) => args[0] === "screenshot")).toBe(true)
    const data = new FakeBrowser("late", "never")
    const result = await shoot(data)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("the page's data")
    expect(result.detail).not.toContain("the page's ready marker")
    expect(data.calls.some((args) => args[0] === "screenshot")).toBe(true)
  })

  // The data wait's expression, run against a page holding only the given busy regions, each in the sidebar or outside it.
  const dataIn = (busy: ("aside" | "sidebar")[]) => {
    const element = (where: "aside" | "sidebar") => ({
      closest: (selector: string) =>
        selector === "[data-sidebar]" && where === "sidebar" ? {} : null,
    })
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '[aria-busy="true"]' ? busy.map(element) : [],
    }
    return new Function("document", `return ${DATA_READY[1]}`)(document)
  }

  // On 7 Nov a shot of `/dashboard#needs-you-<done card>` caught the Inbox before its data, so it missed the Done shelf its first data render opens.
  test("a page's data counts as in once no region outside the sidebar reads busy", () => {
    expect(DATA_READY[0]).toBe("--fn")
    expect(dataIn([])).toBe(true)
    // the Inbox's section reads busy until its first data render
    expect(dataIn(["aside"])).toBe(false)
    // a stored sidebar menu stays busy while it shows stored rows, and SIDEBAR_READY covers the sidebar
    expect(dataIn(["sidebar"])).toBe(true)
    expect(dataIn(["sidebar", "aside"])).toBe(false)
  })

  // The sidebar wait's expression, run against a page holding only the given menus at the given width.
  // each menu its state, in the nav (content) unless it is the header's dispatcher rows
  const sidebarDrawn = (width: number, menus: `${"header" | "nav"} ${"loading" | "ready"}`[]) => {
    const document = {
      querySelector: (selector: string) =>
        menus.some((menu) => {
          const [where, state] = menu.split(" ")
          const own = `[data-sidebar="menu"][data-agents="${state}"]`
          return (
            selector === own || (where === "nav" && selector === `[data-sidebar="content"] ${own}`)
          )
        })
          ? {}
          : null,
    }
    return new Function("document", "innerWidth", `return ${SIDEBAR_READY[1]}`)(document, width)
  }

  test("the sidebar counts as drawn only once a menu of the nav reads ready and none reads loading", () => {
    expect(SIDEBAR_READY[0]).toBe("--fn")
    expect(sidebarDrawn(1782, [])).toBe(false)
    expect(sidebarDrawn(1782, ["nav ready", "nav loading"])).toBe(false)
    expect(sidebarDrawn(1782, ["nav ready"])).toBe(true)
    // the header's dispatcher rows read ready while the nav has not drawn yet
    expect(sidebarDrawn(1782, ["header ready"])).toBe(false)
    expect(sidebarDrawn(1782, ["header ready", "nav ready"])).toBe(true)
    expect(sidebarDrawn(1782, ["header loading", "nav ready"])).toBe(false)
    expect(sidebarDrawn(390, [])).toBe(true)
  })
})

// The dashboard has one user, which verify signs in as: a page that writes state on load (the Changelog's read mark) would write the owner's, so every verify page runs a script first that marks the visit as verify's.
describe("verify's browser", () => {
  test("marks every page it opens as verify's visit, from its first command", async () => {
    const browser = new Browser(["/tmp/observer.js"])
    const first = await browser.command(["open", "http://dashboard/"])
    const scripts = first.flatMap((arg, i) => (first[i - 1] === "--init-script" ? [arg] : []))
    expect(scripts).toHaveLength(2)
    expect(scripts[1]).toBe("/tmp/observer.js")
    const page: Record<string, unknown> = {}
    new Function("window", await Bun.file(scripts[0]!).text())(page)
    expect(page[VERIFY_VISIT]).toBe(true)
    expect(await browser.command(["open", "http://dashboard/x"])).not.toContain("--init-script")
  })

  // headless Chrome plays sound, so a check that loads the music player played a song out loud for minutes.
  test("launches muted", async () => {
    const browser = new Browser()
    const first = await browser.command(["open", "http://dashboard/"])
    expect(first[first.indexOf("--args") + 1]).toBe("--mute-audio")
    expect(await browser.command(["open", "http://dashboard/x"])).not.toContain("--mute-audio")
  })
})

describe("cursorResult", () => {
  const right = {
    attach: "pointer",
    "plain disabled button": "not-allowed",
    rail: "w-resize",
    send: "pointer",
  }

  test("passes when every control reads its cursor, naming each", () => {
    expect(cursorResult(right)).toEqual({
      check: "cursor",
      detail: "attach pointer, plain disabled button not-allowed, rail w-resize, send pointer",
      ok: true,
    })
  })

  test("fails on an arrow Send, a pointer rail or a missing control, naming each", () => {
    const result = cursorResult({ ...right, attach: null, rail: "pointer", send: "default" })
    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      "attach reads nothing, not pointer; rail reads pointer, not e-resize or w-resize; send reads default, not pointer",
    )
  })

  const noComposer = { ...right, attach: null, send: null }

  test("skips Send and Attach, saying why, when /dashboard says the dispatcher is not running", () => {
    expect(cursorResult(noComposer, "Playground is not running")).toEqual({
      check: "cursor",
      detail:
        "skipped attach and send: no composer, Playground is not running; plain disabled button not-allowed, rail w-resize",
      ok: true,
    })
  })

  test("still fails a wrong rail or disabled button while it skips the composer", () => {
    const result = cursorResult({ ...noComposer, rail: "pointer" }, "Playground is not running")
    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      "rail reads pointer, not e-resize or w-resize (skipped attach and send: no composer, Playground is not running)",
    )
  })

  test("fails a page that draws neither the composer nor the not-running state, saying so", () => {
    const result = cursorResult(noComposer, null)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      "attach reads nothing, not pointer; send reads nothing, not pointer (no composer and no not-running state on /dashboard)",
    )
  })

  test("names what /dashboard shows instead when it draws another empty state", () => {
    const result = cursorResult(noComposer, null, "cmux isn't running")
    expect(result.ok).toBe(false)
    expect(result.detail).toBe(
      'attach reads nothing, not pointer; send reads nothing, not pointer (no composer and no not-running state on /dashboard; it shows "cmux isn\'t running")',
    )
  })

  test("fails a wrong cursor on a drawn composer, whatever the page says beside it", () => {
    const result = cursorResult({ ...right, send: "default" }, "Playground is not running")
    expect(result.ok).toBe(false)
    expect(result.detail).toBe("send reads default, not pointer")
  })
})

// A lead in cmux cannot read the factory's herdr server itself, so the Dashboard's agents read is its check that a herdr session ended.
describe("endedResult", () => {
  const NAME = "probe-herdr-x"
  const ended = { name: NAME, state: "down", status: "ended" }

  test("passes only when the roster reads ended and no session of the name is live", () => {
    expect(endedResult(NAME, [ended], null)).toEqual({
      check: "ended",
      detail: `${NAME} is down and the roster reads ended`,
      ok: true,
    })
  })

  test("a herdr session still live fails, even with the roster reading ended", () => {
    const result = endedResult(NAME, [{ ...ended, state: "working" }], null)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe(`${NAME} is still live (working)`)
    expect(endedResult(NAME, [ended, { name: NAME, state: "idle" }], null).ok).toBe(false)
  })

  test("a session down but not recorded as ended fails, naming the roster write", () => {
    const result = endedResult(NAME, [{ ...ended, status: "working" }], null)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain(`roster.ts set ${NAME} status=ended`)
  })

  test("a name nothing holds fails", () => {
    expect(endedResult(NAME, [{ ...ended, name: "other" }], null).ok).toBe(false)
  })

  test("a read that could not see live sessions fails rather than pass on them", () => {
    expect(endedResult(NAME, [ended], "cmux timed out").detail).toBe(
      "live sessions could not be read: cmux timed out",
    )
    const herdr = "herdr's factory server could not be read: bad snapshot"
    const result = endedResult(NAME, [ended], null, ["swap could not be read", herdr])
    expect(result).toEqual({ check: "ended", detail: herdr, ok: false })
    expect(endedResult(NAME, [ended], null, ["swap could not be read"]).ok).toBe(true)
  })
})

// The agents read records a hung herdr server's problem only once it settles, so the system read goes after it, or it could answer first with none listed (review round 14).
test("ended reads the system route only after the agents route has answered", async () => {
  const order: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      order.push(`start ${path}`)
      if (path === "/api/v1/agents") {
        await Bun.sleep(50)
        order.push(`end ${path}`)
        return Response.json({
          data: {
            agents: [{ name: "probe-x", state: "down", status: "ended" }],
            liveProblem: null,
          },
        })
      }
      return Response.json({ data: { problems: [] } })
    },
  })
  try {
    const at = `http://127.0.0.1:${server.port}`
    const result = await ended({ api: at, web: at }, "c=1", "probe-x")
    expect(result.ok).toBe(true)
    expect(order).toEqual(["start /api/v1/agents", "end /api/v1/agents", "start /api/v1/system"])
  } finally {
    await server.stop(true)
  }
})

// the primary reads Alpha while live, never its session name
describe("homeHeading", () => {
  const opus = {
    effort: "high",
    model: "claude-opus-5-5",
    name: "dispatcher",
    role: "dispatcher",
    sessionId: "s-1",
  }
  const second = { ...opus, model: "glm-5.3-flash", name: "dispatcher-2", sessionId: "s-2" }

  test("verify pages expects the primary's label while it is live, and its role while it is not, never a name", () => {
    expect(homeHeading({ live: [second, opus], names: ["dispatcher", "dispatcher-2"] })).toBe(
      "Alpha",
    )
    expect(homeHeading({ live: [second], names: ["dispatcher", "dispatcher-2"] })).toBe("Alpha")
  })
})

// The aside's Inbox sits in main beside every dashboard page, so a page counts as drawn only by the words in its own half.
describe("checkPage", () => {
  // A browser over a page whose main holds the Inbox's words, and whose own half holds `own`.
  class PageBrowser extends Browser {
    constructor(private own: string) {
      super()
    }
    override async run(...args: string[]): Promise<Record<string, unknown>> {
      if (args[0] === "get") return { url: "http://web/dashboard/apps" }
      if (args[0] === "wait" && args[1] === "--fn" && args[2]!.includes("[data-dashboard-page]")) {
        if (!this.own) throw new Error("agent-browser wait: Wait timed out")
        return {}
      }
      if (args[0] !== "eval") return {}
      const script = args[1]!
      if (script.includes("responseStatus")) return { result: 200 }
      if (script.includes("[data-dashboard-page]")) return { result: this.own.length }
      if (script.includes('querySelector("main")')) return { result: "1 needs you Ask".length }
      return { result: 0 }
    }
  }
  const at = { api: "http://api", web: "http://web" }

  test("fails a blank page even while the aside's Inbox fills main beside it", async () => {
    const result = await checkPage(new PageBrowser(""), at, "/dashboard/apps", undefined)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("its page is empty")
  })

  test("passes a page whose own half holds its words", async () => {
    const result = await checkPage(new PageBrowser("Apps"), at, "/dashboard/apps", undefined)
    expect(result.ok).toBe(true)
  })
})

describe("fixtureDirOf", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-fixture-"))
  afterAll(() => rmSync(root, { force: true, recursive: true }))

  test("names the folder the launcher's fixtureDir names, for a worktree, a plain clone and PLAYGROUND_FIXTURE_DIR", async () => {
    const { fixtureDir } = await import("../../../../../api/hono/src/lib/dashboard/fixture")
    const worktree = join(root, "worktree")
    mkdirSync(worktree)
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n")
    const clone = join(root, "clone")
    mkdirSync(join(clone, ".git"), { recursive: true })
    const scratch = join(root, "tmp")
    for (const [env, checkout] of [
      [{}, worktree],
      [{}, clone],
      [{ PLAYGROUND_FIXTURE_DIR: "scratch/fx" }, clone],
      [{ PLAYGROUND_FIXTURE_DIR: "/elsewhere/fx" }, worktree],
    ] as const)
      expect(fixtureDirOf(env, checkout, scratch)).toBe(fixtureDir(env, checkout, scratch))
    expect(fixtureDirOf({}, worktree, scratch)).toBe(join(worktree, ".turbo", "dashboard-fixture"))
  })
})
