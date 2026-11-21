import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  GithubMark,
  headerIcons,
  dispatcherSlotsShown,
  PendingRow,
  NoDispatcherRow,
  SessionRow,
  DispatcherUsage,
  glmSlot,
  SystemIcons,
  usageSlot,
} from "../../../../../../web/next/src/components/dashboard/app-sidebar"
import { ROW_BOX } from "../../../../../../web/next/src/components/shell/row-box"
import { SidebarMenu, SidebarProvider } from "../../../../../../web/next/src/components/ui/sidebar"
import { drawingOf, keepMakerIcon } from "../../../../../../web/next/src/lib/model-icons"
import { calm, FIVE, glm, NOW } from "../../lib/system.test"
import { tipsOf } from "../../tooltips"

// React resolves from the web app's own packages, which this directory cannot see; the two calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
type CreateElement = (type: unknown, props?: unknown, ...children: Node[]) => Node
const web = join(import.meta.dir, "../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: CreateElement
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}
const Remix = (await import(Bun.resolveSync("@remixicon/react", web))) as Record<string, unknown>

type Read = Parameters<typeof headerIcons>[0]
type Live = Parameters<typeof headerIcons>[1]
type Worker = Parameters<typeof SessionRow>[0]["worker"]

const render = (child: Node) =>
  renderToStaticMarkup(
    createElement(SidebarProvider, null, createElement(SidebarMenu, null, child)),
  )
const fresh = (patch?: Parameters<typeof calm>[0]): Read => ({ error: false, report: calm(patch) })

const swapAt = (share: number) => (r: ReturnType<typeof calm>) =>
  void (r.memory.swap = { totalBytes: 100, usedBytes: share })
const critical = fresh(swapAt(98))
const warn = fresh(swapAt(93))
const diskAt = (gb: number) =>
  fresh((r) => void (r.disk = { freeBytes: gb * 1024 ** 3, totalBytes: 994 * 1024 ** 3 }))
const stopped = fresh((r) => void (r.sampledAt = new Date(NOW - 120_000).toISOString()))
const none: Read = { error: false, report: undefined }

const icons = (read: Read, live: Live = "Live", lost: string | null = null) =>
  headerIcons(read, live, NOW, lost)
const healthOf = (read: Read, live: Live = "Live") => icons(read, live).health
const drawn = (read: Read) =>
  icons(read).icons.map((i) => `${i.key}:${i.outline ? "outline" : i.level}`)

const classesOf = (tag: string) => new Set(/class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [])
const linkTag = (html: string) => /<a [^>]*>/.exec(html)?.[0] ?? ""
const linkTags = (html: string) => [...html.matchAll(/<a [^>]*>/g)].map(([tag]) => tag)
const groupTag = (html: string) => /<div[^>]*role="group"[^>]*>/.exec(html)?.[0] ?? ""
const iconTags = (html: string) =>
  [...html.matchAll(/<svg[^>]*data-reading="[^"]*"[^>]*>/g)].map(([tag]) => tag)
const shapeOf = (html: string, attr: string) =>
  (new RegExp(`<svg[^>]*${attr}[^>]*>(.*?)</svg>`).exec(html)?.[1] ?? "").trim()
const iconTints = (html: string) =>
  iconTags(html).map((tag) =>
    [...classesOf(tag)].find((t) => /^text-(success|caution|destructive|inactive)$/.test(t)),
  )
const srText = (html: string) =>
  [...html.matchAll(/<span class="sr-only">(.*?)<\/span>/g)].map(([, text]) => text).join(" ")
const readingTints = (html: string) =>
  [...html.matchAll(/<span data-level="[^"]*"[^>]*><svg[^>]*class="([^"]*)"/g)].map(([, c]) =>
    c.split(" ").find((t) => /^text-(success|caution|destructive|inactive)$/.test(t)),
  )
const remix = (name: string) =>
  renderToStaticMarkup(createElement(Remix[name], { "data-shape": "x" }))

// The system icons follow the dispatcher's logo, then a white GitHub icon in place of the coloured one.
describe("headerIcons", () => {
  test("the group's health, red first: a lost feed or a critical reading, then a warning, a stopped sample or a failed read, then green; none before a sample", () => {
    expect(healthOf(warn, "Lost")).toBe("red")
    expect(healthOf(fresh(), "Lost")).toBe("red")
    expect(healthOf(critical)).toBe("red")
    expect(healthOf(diskAt(12))).toBe("red")
    expect(healthOf(warn)).toBe("amber")
    expect(healthOf(stopped)).toBe("amber")
    expect(healthOf({ error: true, report: undefined })).toBe("amber")
    expect(healthOf({ error: true, report: calm() })).toBe("amber")
    expect(healthOf(fresh())).toBe("green")
    expect(healthOf(fresh(), "Reconnecting")).toBe("green")
    expect(healthOf(none)).toBeNull()
  })

  test("memory, load and swap hold three slots, each in its own level's colour, so the worst reading is the reddest icon", () => {
    expect(drawn(fresh())).toEqual(["memory:green", "cpu:green", "swap:green"])
    expect(drawn(warn)).toEqual(["memory:green", "cpu:green", "swap:amber"])
    expect(drawn(fresh((r) => void (r.memory.pressure = "critical")))[0]).toBe("memory:red")
    // pressure judges memory, not its share
    expect(drawn(fresh((r) => void (r.memory.usedBytes = 0.95 * r.memory.totalBytes)))[0]).toBe(
      "memory:green",
    )
  })

  test("disk joins after them only while orange or red", () => {
    expect(drawn(diskAt(42))).toEqual(["memory:green", "cpu:green", "swap:green", "disk:amber"])
    expect(drawn(diskAt(12)).at(-1)).toBe("disk:red")
    expect(drawn(fresh()).some((i) => i.startsWith("disk"))).toBe(false)
  })

  test("each icon's hover gives its number and level, and the usage windows stay off the header", () => {
    const {
      icons: [, , swap],
    } = icons(warn)
    expect(swap.hover).toBe("Swap 93% used, over the 90% warning level")
    expect(icons(fresh()).icons.map((i) => i.key)).not.toContain("week")
  })

  // the status stats move as they were, numbers included
  test("each known reading carries its number, and an outline none", () => {
    expect(icons(warn).icons.map((i) => i.value)).toEqual(["60", "5.0", "93"])
    expect(icons(diskAt(12)).icons.at(-1)?.value).toBe("12")
    expect(icons(none).icons.map((i) => i.value)).toEqual([null, null, null])
    expect(icons(stopped).icons.map((i) => i.value)).toEqual([null, null, null])
  })

  test("before a sample, after a failed read and once sampling stopped, the three slots are outlines that say which, and no disk", () => {
    expect(drawn(none)).toEqual(["memory:outline", "cpu:outline", "swap:outline"])
    expect(icons(none).icons[0].hover).toBe("Memory: Reading the machine")
    expect(icons({ error: true, report: undefined }).icons[1].hover).toBe(
      "Load: The machine could not be read",
    )
    expect(drawn(stopped)).toEqual(["memory:outline", "cpu:outline", "swap:outline"])
    expect(icons(stopped).icons[2].hover).toBe("Swap: Sampling has stopped")
    expect(
      drawn({
        ...diskAt(12),
        report: { ...diskAt(12).report!, sampledAt: stopped.report!.sampledAt },
      }),
    ).toHaveLength(3)
  })

  test("a lost feed dims the icons, and every hover and the group's name give cmux's reason", () => {
    const lost = icons(fresh(), "Lost", "cmux refused the API's socket")
    expect(lost.dim).toBe(true)
    expect(lost.icons[0].hover.split("\n")).toEqual([
      "Memory 60% used, pressure normal",
      "Live sessions cannot be read: cmux refused the API's socket",
    ])
    expect(lost.spoken).toBe(
      "System: Needs action · Live sessions cannot be read: cmux refused the API's socket",
    )
    expect(icons(fresh()).dim).toBe(false)
  })

  test("the group's name says the health and the feed once, each reading left to its own icon", () => {
    expect(icons(fresh()).spoken).toBe("System: Healthy · Live feed connected")
    expect(icons(warn).spoken).toBe("System: Worth a look · Live feed connected")
    expect(icons(none).spoken).toBe("System: Reading the machine · Live feed connected")
    expect(icons(fresh(), "Connecting").spoken).toBe("System: Healthy · Live feed connecting")
    // a feed that is not live is named on every icon too, so a hover shows it
    expect(icons(fresh(), "Reconnecting").icons[0].hover).toEndWith("\nLive feed reconnecting")
    expect(icons(fresh()).icons[0].hover).not.toContain("Live feed")
  })
})

describe("SystemIcons", () => {
  const group = (read: Read, live: Live = "Live") =>
    render(
      createElement(SystemIcons, { icons: headerIcons(read, live, NOW), onNavigate: () => {} }),
    )

  test("three fixed 12px slots from first paint, before any sample, each one link to the System page", () => {
    const html = group(none)
    expect(iconTags(html)).toHaveLength(3)
    for (const tag of iconTags(html)) expect(classesOf(tag).has("size-3")).toBe(true)
    const links = linkTags(html)
    expect(links).toHaveLength(3)
    for (const link of links) expect(link).toContain('href="/dashboard/system"')
  })

  test("each icon's number follows it in its level's colour, mono and tabular at its own width; its words are its tooltip and its screen-reader text, never a title", () => {
    const html = group(warn)
    const numbers = [
      ...html.matchAll(/<\/svg><span aria-hidden="true" class="([^"]*)">([^<]*)<\/span>/g),
    ]
    expect(numbers.map(([, , v]) => v)).toEqual(["60", "5.0", "93"])
    expect(
      numbers.map(([, c]) =>
        [...classesOf(`class="${c}"`)].find((t) =>
          /^text-(success|caution|destructive|inactive)$/.test(t),
        ),
      ),
    ).toEqual(["text-success", "text-success", "text-caution"])
    for (const [, c] of numbers) {
      expect(c).toContain("text-2xs")
      expect(c).toContain("font-mono")
      expect(c).toContain("tabular-nums")
      expect(c).not.toMatch(/\bw-|\bmin-w-|\bp[xlr]?-/)
    }
    expect(group(none)).not.toMatch(/<\/svg><span aria-hidden="true"/)
    expect(html).not.toContain("title=")
    expect(tipsOf(html)).toEqual([
      "Memory 60% used, pressure normal",
      "Load 5.0 on 15 cores, 5 min., below the 0.8 a core warning level",
      "Swap 93% used, over the 90% warning level",
    ])
    expect(srText(html)).toBe(tipsOf(html).join(" "))
    expect(groupTag(html)).toContain('aria-label="System: Worth a look · Live feed connected"')
  })

  test("known readings are filled Remix icons in their level's token; outlines are text-inactive; nothing pulses", () => {
    const html = group(warn)
    expect(iconTints(html)).toEqual(["text-success", "text-success", "text-caution"])
    expect(shapeOf(html, 'data-reading="memory"')).toBe(shapeOf(remix("RiRamFill"), "data-shape"))
    const outline = group(none)
    expect(iconTints(outline)).toEqual(["text-inactive", "text-inactive", "text-inactive"])
    expect(shapeOf(outline, 'data-reading="memory"')).toBe(
      shapeOf(remix("RiRamLine"), "data-shape"),
    )
    expect(html + outline).not.toContain("animate")
  })

  test("a red disk is a fourth icon after swap", () => {
    expect(iconTints(group(diskAt(12)))).toEqual([
      "text-success",
      "text-success",
      "text-success",
      "text-destructive",
    ])
  })

  test("a lost feed dims the group, as it dims the rows", () => {
    expect(classesOf(groupTag(group(fresh(), "Lost"))).has("opacity-60")).toBe(true)
    expect(classesOf(groupTag(group(fresh()))).has("opacity-60")).toBe(false)
  })
})

describe("GithubMark", () => {
  const mark = (pulls: string | null) => render(createElement(GithubMark, { pulls }))

  test("a plain filled GitHub icon in the text's colour, 20px in a 24px slot", () => {
    const html = mark("https://github.com/acme/widgets/pulls")
    const icon = /<svg[^>]*>/.exec(html)?.[0] ?? ""
    expect(classesOf(icon).has("size-5")).toBe(true)
    expect(classesOf(icon).has("text-foreground")).toBe(true)
    expect(html).not.toMatch(/text-(success|caution|destructive|inactive)|animate/)
    expect(shapeOf(html, "")).toBe(shapeOf(remix("RiGithubFill"), "data-shape"))
    expect(classesOf(linkTag(html)).has("size-6")).toBe(true)
  })

  test("opens the pull requests in a new tab, and says so on hover and to screen readers", () => {
    const html = mark("https://github.com/acme/widgets/pulls")
    const link = linkTag(html)
    expect(link).toContain('href="https://github.com/acme/widgets/pulls"')
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
    expect(link).not.toContain("title=")
    expect(tipsOf(html)).toEqual(["Open pull requests"])
    expect(srText(html)).toBe("Open pull requests")
  })

  test("with no GitHub origin it is no link and draws nothing", () => {
    expect(mark(null)).not.toContain("<svg")
  })
})

// The AI usage reading moves to the dispatcher's row.
describe("DispatcherUsage", () => {
  const usage = (read: Read) => render(createElement(DispatcherUsage, { now: NOW, read }))

  test("the week, then the 5-hour window, each its icon and number tinted by its level", () => {
    const html = usage(diskAt(12))
    expect(readingTints(html)).toEqual(["text-success", "text-success"])
    const values = [
      ...html.matchAll(
        /data-level="[^"]*"[^>]*><svg.*?<\/svg><span aria-hidden="true">([^<]*)<\/span>/g,
      ),
    ]
    expect(values.map(([, v]) => v)).toEqual(["25", "26"])
    expect(html).toMatch(/class="[^"]*font-mono tabular-nums/)
    expect(html).not.toMatch(/w-\[\d+ch\]/)
    expect(html).not.toContain("<a ")
  })

  // the combined limits show, and a hover lists every account
  test("with several accounts, each window is one combined figure that never squeezes the model's name, every account on hover", () => {
    const html = usage(fresh((r) => void (r.accounts = FIVE)))
    const values = [
      ...html.matchAll(
        /data-level="[^"]*"[^>]*><svg.*?<\/svg><span aria-hidden="true">([^<]*)<\/span>/g,
      ),
    ]
    expect(values.map(([, v]) => v)).toEqual(["63", "21"])
    const [line, ...items] = [...html.matchAll(/<span (?:data-usage|data-level)=[^>]*>/g)].map(
      ([tag]) => tag,
    )
    expect(classesOf(line!).has("shrink-0")).toBe(true)
    expect(items).toHaveLength(2)
    for (const item of items) expect(classesOf(item).has("shrink-0")).toBe(true)
    for (const tip of tipsOf(html))
      for (const a of FIVE) expect(tip).toContain(a.account.split("@")[0]!)
  })

  test("each window carries its own tooltip, and screen readers hear the two once, no hardware reading", () => {
    const html = usage(critical)
    expect(tipsOf(html)).toHaveLength(2)
    expect(tipsOf(html).join("\n")).not.toContain("Swap")
    expect(srText(html).match(/Week 25% used/g)).toHaveLength(1)
    expect(srText(html)).toStartWith("Claude usage: ")
    expect(srText(html)).not.toContain("Swap")
    // the tooltips describe nothing, so the sr-only line is the one place a screen reader hears them
    expect(html).not.toContain("aria-description")
  })

  test("before a sample, after a failed read or once sampling stopped, two gray outlines with no numbers", () => {
    for (const read of [none, { error: true, report: undefined }, stopped]) {
      const html = usage(read)
      const tags = [...html.matchAll(/<svg[^>]*>/g)].map(([tag]) => tag)
      expect(tags).toHaveLength(2)
      for (const tag of tags) expect(classesOf(tag).has("text-inactive")).toBe(true)
      expect(html.replace(/<span class="sr-only">.*?<\/span>/g, "")).not.toMatch(/>\s*\d/)
    }
    expect(srText(usage(stopped))).toBe("Claude usage: Sampling has stopped")
    expect(srText(usage({ error: true, report: undefined }))).toBe(
      "Claude usage: Could not be read",
    )
    expect(srText(usage(none))).toBe("Claude usage: Not read yet")
  })

  test("hidden on the collapsed rail, as the row's title is", () => {
    expect(usage(fresh())).toContain("group-data-[collapsible=icon]:hidden")
  })
})

// Z.ai's vendored logo, as the GLM windows lead with it.
const zaiMark = `data:image/svg+xml;base64,${Buffer.from('<svg><path fill="currentColor" d="M0 0"/></svg>').toString("base64")}`
keepMakerIcon("zai", drawingOf(zaiMark))

// GLM usage shows as Claude usage does.
describe("DispatcherUsage for GLM", () => {
  const glmUsage = (read: Read, logo = false) =>
    render(createElement(DispatcherUsage, { logo, now: NOW, provider: "zai", read }))
  const values = (html: string) =>
    [
      ...html.matchAll(
        /data-level="[^"]*"[^>]*><svg.*?<\/svg><span aria-hidden="true">([^<]*)<\/span>/g,
      ),
    ].map(([, v]) => v)

  test("the week, then the 5-hour window, from the GLM credits, green, orange and red by the Claude windows' levels", () => {
    expect(readingTints(glmUsage(fresh((r) => void (r.zai = glm(5, 41)))))).toEqual([
      "text-success",
      "text-success",
    ])
    const html = glmUsage(fresh((r) => void (r.zai = glm(75, 95))))
    expect(readingTints(html)).toEqual(["text-caution", "text-destructive"])
    expect(values(html)).toEqual(["75", "95"])
    expect(srText(html)).toStartWith("GLM usage: GLM week 75% used")
    for (const tip of tipsOf(html)) expect(tip).toContain("GLM")
  })

  test("a reading the job stopped writing shows its last shares gray and dimmed, saying stale", () => {
    const html = glmUsage(fresh((r) => void (r.zai = glm(95, 95, 20 * 60_000))))
    expect(readingTints(html)).toEqual(["text-inactive", "text-inactive"])
    expect(values(html)).toEqual(["95", "95"])
    const items = [...html.matchAll(/<span data-level=[^>]*>/g)].map(([tag]) => tag)
    for (const item of items) expect(classesOf(item).has("opacity-60")).toBe(true)
    expect(srText(html)).toContain("stale")
  })

  test("with no GLM reading, or once sampling stopped, two gray outlines with no numbers", () => {
    for (const read of [fresh(), stopped]) {
      const html = glmUsage(read)
      const tags = [...html.matchAll(/<svg[^>]*>/g)].map(([tag]) => tag)
      expect(tags).toHaveLength(2)
      for (const tag of tags) expect(classesOf(tag).has("text-inactive")).toBe(true)
    }
    expect(srText(glmUsage(fresh()))).toBe("GLM usage: No usage windows read")
  })

  test("on a row not GLM's own, the GLM windows lead with Z.ai's mark; on GLM's own row its logo already says so", () => {
    const read = fresh((r) => void (r.zai = glm(5, 41)))
    expect(glmUsage(read, true)).toContain(zaiMark)
    // muted as the row's other logos are, not the text's own colour
    expect(glmUsage(read, true)).toMatch(/<svg[^>]*class="text-muted-foreground size-3 shrink-0"/)
    expect(glmUsage(read)).not.toContain(zaiMark)
    expect(render(createElement(DispatcherUsage, { now: NOW, read }))).not.toContain(zaiMark)
  })
})

describe("glmSlot", () => {
  const slot = (model: string | null) => ({ worker: { model } })
  test("the GLM windows sit on the first live GLM dispatcher, read or not", () => {
    expect(glmSlot([slot("claude-opus-5-5"), slot("glm-5.3-flash")], false)).toBe(1)
    expect(glmSlot([slot("glm-5.3-flash[1m]")], true)).toBe(0)
  })

  // tester review round 1: beside Claude's on one 239px row, the row's name was cut to one letter
  test("with no GLM dispatcher live, on the second dispatcher's row while a GLM reading is there, never beside Claude's nor on the primary's", () => {
    expect(glmSlot([slot("claude-opus-5-5"), { worker: null }], true)).toBe(1)
    expect(glmSlot([slot("claude-opus-5-5"), { worker: null }], false)).toBe(-1)
    expect(glmSlot([{ worker: null }, { worker: null }], true)).toBe(1)
    expect(glmSlot([{ worker: null }, slot("claude-opus-5-5")], true)).toBe(-1)
    expect(glmSlot([{ worker: null }], true)).toBe(-1)
    expect(glmSlot([slot("claude-opus-5-5")], true)).toBe(-1)
  })

  // a lead's ruling: a second dispatcher live on Claude carries no Claude windows, which sit on the first's row
  test("a second dispatcher live on Claude carries them, its row not the one with Claude's", () => {
    expect(glmSlot([slot("claude-opus-5-5"), slot("claude-opus-5-5")], true)).toBe(1)
    expect(usageSlot([slot("claude-opus-5-5"), slot("claude-opus-5-5")])).toBe(0)
  })
})

describe("usageSlot", () => {
  const slot = (model: string | null) => ({ worker: { model } })
  test("the first live dispatcher not on GLM carries the Claude windows, a reply not read yet counting as Claude's", () => {
    expect(usageSlot([slot("claude-opus-5-5"), slot("glm-5.3-flash")])).toBe(0)
    expect(usageSlot([slot(null), slot("glm-5.3-flash")])).toBe(0)
    expect(usageSlot([slot("glm-5.3-flash"), slot("claude-opus-5-5")])).toBe(1)
    expect(usageSlot([{ worker: null }, slot("claude-opus-5-5")])).toBe(1)
  })

  test("a GLM dispatcher alone, or none live, carries none", () => {
    expect(usageSlot([slot("glm-5.3-flash[1m]")])).toBe(-1)
    expect(usageSlot([{ worker: null }])).toBe(-1)
  })
})

describe("the dispatcher's row with none live", () => {
  test("carries what it is given after its name, as the GLM windows on the second slot", () => {
    const read = fresh((r) => void (r.zai = glm(5, 41)))
    const html = render(
      createElement(NoDispatcherRow, {
        href: null,
        label: "Second dispatcher",
        trailing: createElement(DispatcherUsage, { logo: true, now: NOW, provider: "zai", read }),
      }),
    )
    expect(html).toContain(zaiMark)
    expect(srText(html)).toContain("GLM usage: GLM week 5% used")
  })

  // a dispatcher slot is drawn as a placeholder row in a stored sidebar, so it keeps a row of the same height after, and nothing below it moves (verify cls: sidebar-content y 96 to 56)
  test("keeps a row the placeholder's height: the dispatcher by its slot's label, Not running, opening /dashboard's empty state", () => {
    const html = render(createElement(NoDispatcherRow, {}))
    expect(linkTag(html)).toContain('href="/dashboard"')
    expect(html).toContain(">Alpha<")
    expect(html).toContain('<span data-slot="tooltip-content">Alpha: Not running<')
    expect(html).toContain('aria-description="Alpha: Not running"')
    expect(html).toContain('data-sidebar="menu-button"')
    // the row and the placeholder read one box, the stock 32px with no padding above or below
    const button = classesOf(/<a [^>]*data-sidebar="menu-button"[^>]*>/.exec(html)?.[0] ?? "")
    for (const c of ROW_BOX.split(" ")) expect(button.has(c)).toBe(true)
    expect(button.has("min-h-8")).toBe(false)
    const placeholder = render(createElement(PendingRow))
    const box = classesOf(
      /<li[^>]*>\s*<div[^>]*>/.exec(placeholder)?.[0]?.replace(/^<li[^>]*>\s*/, "") ?? "",
    )
    for (const c of ROW_BOX.split(" ")) expect(box.has(c)).toBe(true)
  })

  test("a feed lost before any board reads Cannot be read, not Not running, and a stored sidebar is muted", () => {
    const lost = render(createElement(NoDispatcherRow, { lost: true }))
    expect(lost).toContain('<span data-slot="tooltip-content">Alpha: Cannot be read<')
    expect(lost).not.toContain("Not running")
    const stored = render(createElement(NoDispatcherRow, { muted: true }))
    expect(stored).toContain('aria-busy="true"')
    expect(stored).toContain("opacity-60")
  })

  test("Not running draws the palette's red Down mark; Cannot be read, whose state is unknown, a gray one", () => {
    const svg = (html: string) => /<svg[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ""
    expect(svg(render(createElement(NoDispatcherRow)))).toContain("text-destructive")
    expect(svg(render(createElement(NoDispatcherRow, { lost: true })))).toContain("text-inactive")
  })

  // #1682: the restore state is Alpha's alone, so Bravo's down row reads Not running as sidebar.md says
  test("the header passes the restore state to the primary's slot alone", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../../../web/next/src/components/dashboard/app-sidebar.tsx"),
    ).text()
    expect(source).toContain("restoring={i === 0 && restoring}")
  })

  // #1682: a restart should not look broken, so a dispatcher a restore still owes reads as coming back, in gray, never the red Not running
  test("while a restore is owed it reads Coming back with a gray spinner, never the red Down mark", () => {
    const html = render(createElement(NoDispatcherRow, { restoring: true }))
    expect(html).toContain('<span data-slot="tooltip-content">Alpha: Coming back<')
    expect(html).toContain('aria-description="Alpha: Coming back"')
    expect(html).not.toContain("Not running")
    const svg = /<svg[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ""
    expect(svg).toContain("text-inactive")
    expect(svg).toContain("animate-spin")
    expect(svg).not.toContain("text-destructive")
    expect(html).not.toContain('role="status"')
    // a feed lost after a board stills every row, this one's spinner included
    const still = render(createElement(NoDispatcherRow, { restoring: true, still: true }))
    expect(/<svg[^>]*class="([^"]*)"/.exec(still)?.[1] ?? "").not.toContain("animate-spin")
    expect(still).toContain("opacity-60")
    expect(linkTag(html)).toContain('href="/dashboard"')
    const lost = render(createElement(NoDispatcherRow, { lost: true, restoring: true }))
    expect(lost).toContain('<span data-slot="tooltip-content">Alpha: Cannot be read<')
  })

  // #i520: "Each row keeps its slot while its session is down, reading Not running"
  test("the second dispatcher down keeps its row, by its role, reading Not running, and opens nothing", () => {
    const html = render(createElement(NoDispatcherRow, { href: null, label: "Bravo" }))
    expect(html).toContain(">Bravo<")
    expect(html).toContain('<span data-slot="tooltip-content">Bravo: Not running<')
    expect(linkTag(html)).toBe("")
    expect(html).toContain('data-sidebar="menu-button"')
  })

  test("the header's dispatcher rows draw a slot for each dispatcher the API names, a down one's kept by NoDispatcherRow", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/app-sidebar.tsx")).text()
    const group = source.slice(
      source.indexOf("export function DashboardDispatchers"),
      source.indexOf("\n}\n", source.indexOf("export function DashboardDispatchers")),
    )
    expect(group).toContain("dispatchersOf(")
    expect(group).toMatch(/slots\.map\(/)
    expect(group).toContain("dispatcherRowLabel(")
  })

  // verify cls: a stored sidebar holds as many rows as the API says the header will draw, so the second dispatcher's row arriving moves nothing below it
  test("the dispatcher rows' placeholders draw the slot count the layout reads from /api/health", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/app-sidebar.tsx")).text()
    const group = source.slice(
      source.indexOf("export function DashboardDispatchers"),
      source.indexOf("\n}\n", source.indexOf("export function DashboardDispatchers")),
    )
    expect(group).toMatch(/dispatcherSlotsShown\(\s*dispatchersOf\([^)]*\),\s*rows,/)
    expect(group).toContain("<PendingRow rows={shown.held} />")
    // the header's first paint holds the slots too, so the nav under it never moves down
    expect(group).toMatch(
      /source\.kind === "pending"\) \{\s*return \(\s*<SidebarMenu[^>]*>\s*<PendingRow rows=\{rows\} \/>/,
    )
    const layout = await Bun.file(join(web, "src/app/(protected)/layout.tsx")).text()
    expect(layout).toContain(
      "<DashboardDispatchers rows={dispatcherSlotsOf(await readHealth())} />",
    )
  })

  // the dispatcher rows, and the placeholders after them, keep the groups' 2px gap
  test("the dispatcher rows keep the groups' gap, placeholders included", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/app-sidebar.tsx")).text()
    const group = source.slice(
      source.indexOf("export function DashboardDispatchers"),
      source.indexOf("\n}\n", source.indexOf("export function DashboardDispatchers")),
    )
    const menus = [...group.matchAll(/<SidebarMenu\b[^>]*>/g)].map((m) => m[0])
    // the server's paint, then the rows
    expect(menus).toHaveLength(2)
    for (const menu of menus) expect(menu).toContain('className="space-y-0.5"')
  })

  // a tester: the stored sidebar keeps no down dispatcher's agent, so it drew 1 row between the server's 2 placeholders and the live board's 2
  test("a stored sidebar draws the server's slot count, cut or padded with placeholders; the live board its own", () => {
    expect(dispatcherSlotsShown(["a"], 2, true)).toEqual({ held: 1, slots: ["a"] })
    expect(dispatcherSlotsShown(["a", "b"], 1, true)).toEqual({ held: 0, slots: ["a"] })
    expect(dispatcherSlotsShown(["a", "b"], 2, true)).toEqual({ held: 0, slots: ["a", "b"] })
    expect(dispatcherSlotsShown(["a"], 2, false)).toEqual({ held: 0, slots: ["a"] })
    expect(dispatcherSlotsShown(["a", "b"], 1, false)).toEqual({ held: 0, slots: ["a", "b"] })
  })

  test("the dispatcher rows never empty once read: no dispatcher draws that row, not nothing", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/app-sidebar.tsx")).text()
    const group = source.slice(
      source.indexOf("export function DashboardDispatchers"),
      source.indexOf("\n}\n", source.indexOf("export function DashboardDispatchers")),
    )
    // null only below the owner rung, where the sidebar draws no sessions at all
    expect(group.match(/return null/g)).toEqual(["return null"])
    expect(group).toContain("if (!allowed) return null")
    expect(group).toMatch(/<NoDispatcherRow\s/)
  })
})

describe("Playground's row", () => {
  const dispatcher = (fields: Partial<Worker> = {}): Worker => ({
    cwd: "/repo",
    effort: null,
    eta: null,
    failed: false,
    feed: [],
    lastActiveAt: null,
    lifecycle: "running",
    light: "working",
    model: null,
    name: "dispatcher",
    questions: [],
    role: "dispatcher",
    sessionId: "s-dispatcher",
    startedAt: null,
    task: null,
    tasks: [],
    title: "Talk with Merritt",
    updatedAt: null,
    workspace: null,
    ...fields,
  })
  const row = (waiting: string[], fields: Partial<Worker> = {}) =>
    render(
      createElement(SessionRow, {
        close: () => {},
        now: NOW,
        selected: false,
        view: "/dashboard",
        waiting,
        worker: dispatcher(fields),
      }),
    )

  test("an ordinary session row: its light, title, name and status, opening /dashboard, with no wordmark", () => {
    const html = row([])
    expect(linkTag(html)).toContain('href="/dashboard"')
    expect(html).toContain("Talk with Merritt")
    expect(html).toContain('data-sidebar="menu-button"')
    expect(html).not.toContain("fraunces")
  })

  // Worker Lights: "Every count on every row, Playground's included, and Playground's dropdown" go away
  test("the Claude usage windows sit at its right end, after its title, inside its link", () => {
    const html = render(
      createElement(SessionRow, {
        close: () => {},
        now: NOW,
        selected: false,
        trailing: createElement(DispatcherUsage, { now: NOW, read: fresh() }),
        view: "/dashboard",
        worker: dispatcher(),
      }),
    )
    const link = html.slice(html.indexOf("<a "), html.indexOf("</a>"))
    expect(link.indexOf("data-usage")).toBeGreaterThan(link.indexOf("Talk with Merritt"))
    expect(row([])).not.toContain("data-usage")
  })

  test("no count anywhere, neither beside its title nor in the rail's corner, however much waits", () => {
    const html = row(
      Array.from({ length: 12 }, (_, i) => `a${i}`),
      { light: "needs-you" },
    )
    expect(html).not.toContain('data-sidebar="menu-badge"')
    expect(html).not.toContain("group-data-[collapsible=icon]:flex")
    expect(html).not.toMatch(/>\d+\+?</)
    // its own picker still draws its red alarm, and its link still opens the first card
    expect(html).toMatch(/<svg[^>]*class="[^"]*text-destructive/)
    expect(linkTag(html)).toContain('href="/dashboard#needs-you-a0"')
  })

  test("no dropdown, whatever subagents or processes it runs", () => {
    const task = {
      endedAt: null,
      id: "t1",
      kind: "agent" as const,
      label: "Look something up",
      startedAt: "2026-10-06T11:50:00.000Z",
      state: "running" as const,
      taskId: null,
    }
    expect(row([], { tasks: [task] })).not.toContain('data-sidebar="menu-action"')
  })
})

// The header's readings sum the cluster as the System table does, so the owner's two 20-core machines read on 40 cores (#2425).
describe("headerIcons over a cluster", () => {
  const spark = (name: string, diskFree = 30) => ({
    down: null,
    name,
    reading: {
      cores: 20,
      disk: { freeBytes: diskFree * 1024 ** 3, totalBytes: 3755 * 1024 ** 3 },
      load: [10, 10, 10] as [number, number, number],
      memory: { totalBytes: 128 * 1024 ** 3, usedBytes: 64 * 1024 ** 3 },
      swap: { totalBytes: 16 * 1024 ** 3, usedBytes: 0 },
    },
  })
  test("the disk icon shows the cluster's free space, orange on its fullest machine, which its hover names beside each machine's part", () => {
    const read = fresh((r) => {
      r.machines = [spark("spark-a566", 3470), spark("spark-9dfb", 30)]
    })
    const disk = icons(read).icons.find((i) => i.key === "disk")!
    expect(disk.value).toBe("3T")
    expect(disk.hover).toBe(
      "Disk 3500 GB free; spark-9dfb disk 30 GB free, under the 50 GB warning level\nspark-a566 3470 + spark-9dfb 30 GB free",
    )
  })

  test("the load icon's number and hover are both machines', each named", () => {
    const read = fresh((r) => {
      r.machines = [spark("spark-a566"), spark("spark-9dfb")]
      r.cpu = { cores: 20, load: [10, 10, 10] }
    })
    const cpu = icons(read).icons.find((i) => i.key === "cpu")!
    expect(cpu.value).toBe("20")
    expect(cpu.hover).toBe(
      "Load 20 on 40 cores, 5 min., below the 0.8 a core warning level on each machine\nspark-a566 10 on 20 + spark-9dfb 10 on 20 cores, 5 min.",
    )
  })
})
