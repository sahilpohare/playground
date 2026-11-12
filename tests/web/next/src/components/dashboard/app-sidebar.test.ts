import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  groupEmpty,
  dispatcherRowLabel,
  keepsNested,
  navGroups,
  OpsJobRow,
  PLUS_SHOWN,
  SessionRow,
  ThreadsGroup,
} from "../../../../../../web/next/src/components/dashboard/app-sidebar"
import { SidebarMenu, SidebarProvider } from "../../../../../../web/next/src/components/ui/sidebar"
import { iconTone, STATES, statusIcon } from "../../../../../../web/next/src/lib/status-icons"
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
const { RiAnthropicFill, RiHammerFill, RiSignalCellular3Fill, RiSkull2Fill, RiZhipuAiFill } =
  (await import(Bun.resolveSync("@remixicon/react", web))) as Record<
    "RiAnthropicFill" | "RiHammerFill" | "RiSignalCellular3Fill" | "RiSkull2Fill" | "RiZhipuAiFill",
    unknown
  >

type Worker = Parameters<typeof SessionRow>[0]["worker"]

const NOW = Date.parse("2026-10-06T12:00:00.000Z")

const worker = (name: string, role: Worker["role"], fields: Partial<Worker> = {}): Worker => ({
  cwd: "/repo",
  effort: null,
  eta: null,
  failed: false,
  feed: [],
  lastActiveAt: null,
  lifecycle: "running",
  light: "working",
  model: null,
  name,
  questions: [],
  role,
  sessionId: `s-${name}`,
  startedAt: null,
  task: null,
  tasks: [],
  title: "Message dispatcher from the dashboard",
  updatedAt: null,
  workspace: null,
  ...fields,
})

const inSidebar = (child: Node) =>
  renderToStaticMarkup(
    createElement(SidebarProvider, null, createElement(SidebarMenu, null, child)),
  )

const row = (
  name: string,
  role: Worker["role"],
  waiting: string[] = [],
  fields: Partial<Worker> = {},
) =>
  inSidebar(
    createElement(SessionRow, {
      close: () => {},
      now: NOW,
      selected: false,
      waiting,
      worker: worker(name, role, fields),
    }),
  )

const openTag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? ""

// The text inside an element that opens with tag, its nested spans included, up to its own close.
const textOf = (html: string, tag: string): string => {
  const start = html.indexOf(tag)
  if (start === -1) return ""
  let depth = 0
  let at = start
  const pattern = /<(\/?)span\b[^>]*>/g
  pattern.lastIndex = start
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    depth += m[1] ? -1 : 1
    at = m.index
    if (depth === 0) break
  }
  return html
    .slice(start + tag.length, at)
    .replace(/<span class="sr-only">.*?<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/<!-- -->/g, "")
}

// Each icon a row draws, as its Worker Lights state, read off the icon's own path.
const STATE_PATHS = STATES.map(
  (state) =>
    [
      state,
      /<path d="([^"]+)"/.exec(renderToStaticMarkup(createElement(statusIcon(state).Icon)))?.[1] ??
        "",
    ] as const,
)
const icons = (html: string) =>
  [...html.matchAll(/<svg[^>]*class="([^"]*)"[^>]*>(?:<!-- -->)?<path d="([^"]+)"/g)]
    .map(([, classes, path]) => {
      const tone =
        (classes ?? "")
          .split(" ")
          .find((c) => /^text-(destructive|caution|info|success|inactive)$/.test(c)) ?? null
      // states that share a shape (Working and Fixing, Down and Ended) tell apart by their colour
      const icon =
        STATE_PATHS.filter(([state, p]) => p === path && iconTone(state) === tone).at(0)?.[0] ??
        STATE_PATHS.find(([, p]) => p === path)?.[0] ??
        "other"
      return { icon, tone }
    })
    .filter(({ icon }) => icon !== "other")
// The row's own icon, left of its lines: the first the menu button draws.
const leftIcon = (html: string) => {
  const button = /<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ""
  const [first] = icons(button)
  return first ? { icon: first.icon, tone: first.tone } : null
}

// A session row's description, the words its menu carries, which a screen reader hears as the hover's words before.
const descriptionOf = (html: string) =>
  (/<a[^>]*data-sidebar="menu-button"[^>]*aria-description="([^"]*)"/.exec(html)?.[1] ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")

const secondLine = (html: string) =>
  textOf(html, openTag(html, /<span class="[^"]*text-2xs[^"]*"[^>]*>/)).replaceAll("\u00a0", " ")
// The row's tooltip, a line each: its first tooltip's words, which hold the row's words whole.
const tipLines = (html: string) => tipsOf(html)[0]?.split("\n") ?? []
// What a row draws as text, its tooltips and screen reader words left out.
const shownText = (html: string) =>
  html
    .replace(/<span class="sr-only">.*?<\/span>/g, "")
    .replace(
      /<span data-slot="tooltip-content">[\s\S]*?<span data-slot="tooltip-end"><\/span><\/span>/g,
      "",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
// An icon's path, to find it in a row.
const pathOf = (Icon: unknown) =>
  /<path d="([^"]+)"/.exec(renderToStaticMarkup(createElement(Icon)))?.[1] ?? "none"
const classesOf = (tag: string) => new Set(/class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [])

// A runner's or a script's row by its parts (#i546): the line, the lead box holding the head (model and effort) and the state, and the tail after them, each with its classes and its text.
const partsOf = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<span class="([^"]*)" data-part="(\w+)">/g)].map(([tag, classes, part]) => [
      part,
      {
        classes: [...classesOf(`class="${classes}"`)].sort(),
        text: textOf(html, tag).replaceAll("\u00a0", " "),
      },
    ]),
  )

// The parts of a rendered menu item that decide its height: the item's own classes, the button's size, its height, padding and margin classes, and any inline style.
const shape = (html: string) => {
  const item = openTag(html, /<li[^>]*data-sidebar="menu-item"[^>]*>/)
  const button = openTag(html, /<(a|button)[^>]*data-sidebar="menu-button"[^>]*>/)
  const sizing = (tag: string) =>
    [...classesOf(tag)]
      .filter((c) => /(^|:)(h|min-h|max-h|size|p|py|pt|pb|m|my|mt|mb)-/.test(c))
      .sort()
  return {
    button: sizing(button),
    item: sizing(item),
    size: /data-size="([^"]*)"/.exec(button)?.[1],
    // a manager row's menu trigger keeps a long press from opening the phone's own link menu, which sizes nothing
    style: /\sstyle="(?!-webkit-touch-callout:none")/.test(button),
  }
}

describe("SessionRow", () => {
  // every row is the stock 32px, its one line between no vertical padding, so no row grows taller
  const stock = shape(row("worker-greed", "worker"))
  for (const [name, role] of [
    ["dispatcher", "dispatcher"],
    ["builder", "manager"],
    ["worker-greed", "worker"],
    ["runner-pride", "runner"],
  ] as const) {
    test(`a ${role} row keeps the stock menu button's 32px height and its padding across, with none above or below`, () => {
      const rowShape = shape(row(name, role))
      expect(rowShape.size).toBe("default")
      expect(rowShape.button).toEqual([
        "[&amp;_svg]:size-4",
        "group-data-[collapsible=icon]:p-2!",
        "group-data-[collapsible=icon]:size-8!",
        "h-8",
        "p-2",
        "py-0",
      ])
      expect(rowShape).toEqual(stock)
    })
  }

  test("Playground's row opens /dashboard, his chat, and its first card there, not a ?worker= link", () => {
    const dispatcher = (waiting: string[]) =>
      inSidebar(
        createElement(SessionRow, {
          close: () => {},
          now: NOW,
          selected: true,
          view: "/dashboard",
          waiting,
          worker: worker("dispatcher", "dispatcher"),
        }),
      )
    expect(dispatcher([])).toContain('href="/dashboard"')
    expect(dispatcher(["20261006-090000-aaaaaa"])).toContain(
      'href="/dashboard#needs-you-20261006-090000-aaaaaa"',
    )
    expect(dispatcher([])).not.toContain("?worker=")
  })

  test("Playground's own picker keeps its red alarm and reads Waiting on you, with no count, at the stock height", () => {
    const html = row(
      "dispatcher",
      "dispatcher",
      ["20261006-090000-aaaaaa", "s-dispatcher-picker"],
      {
        light: "needs-you",
      },
    )
    expect(shape(html)).toEqual(stock)
    expect(leftIcon(html)).toEqual({ icon: "stuck", tone: "text-destructive" })
    expect(html).not.toContain('data-sidebar="menu-badge"')
    expect(html).not.toContain("waiting)</span>")
    expect(html).not.toContain("text-2xs")
    expect(tipLines(html)).toContain("Alpha · Waiting on you")
  })

  // everything on the left, one icon a row, red when stuck
  test("a stuck worker, manager or runner: the red alarm on the left alone, Stuck on hover, no count anywhere, and it still opens the card", () => {
    // the tooltip's model line leads with its model, none here, then its state
    for (const [name, role, second] of [
      ["worker-greed", "worker", "Stuck"],
      ["builder", "manager", "Stuck"],
      ["runner-pride", "runner", "Stuck"],
    ] as const) {
      const html = row(name, role, ["20261006-090000-aaaaaa", `s-${name}-picker`], {
        light: "needs-you",
      })
      expect(shape(html)).toEqual(stock)
      expect(leftIcon(html)).toEqual({
        icon: "stuck",
        tone: "text-destructive",
      })
      expect(icons(html)).toHaveLength(1)
      expect(html).not.toContain('data-sidebar="menu-badge"')
      expect(html).not.toContain("group-data-[collapsible=icon]:flex")
      expect(tipLines(html)).toContain(second)
      expect(descriptionOf(html)).toStartWith(
        `${name} · Message dispatcher from the dashboard · ${second}`,
      )
      expect(html).toContain(`href="/dashboard?worker=s-${name}#needs-you-20261006-090000-aaaaaa"`)
    }
  })

  test("a hosted session's permission mode is in its row's tooltip, beside its one icon", () => {
    const html = row("probe-sdk", "other", [], {
      hosted: true,
      permissionMode: "acceptEdits",
    })
    expect(icons(html)).toHaveLength(1)
    expect(descriptionOf(html)).toMatch(/^probe-sdk · .* · Accept edits mode$/)
    expect(descriptionOf(row("worker-greed", "worker"))).not.toContain(" mode.")
  })

  // a row's words are its multiline tooltip, with no menu of its own for them
  test("its words are a tooltip a line each, on hover and focus while expanded too, which a screen reader hears as one line, and it opens no menu", () => {
    const html = row("worker-greed", "worker", [], {
      permissionMode: "acceptEdits",
    })
    const lines = [
      "worker-greed",
      "Message dispatcher from the dashboard",
      "Working",
      "Accept edits mode",
    ]
    expect(tipsOf(html)).toEqual([lines.join("\n")])
    expect(descriptionOf(html)).toBe(lines.join(" · "))
    expect(html).not.toContain('data-slot="context-menu-trigger"')
    expect(html).not.toContain("Shift+F10")
  })

  // a builder: "manager rows keep Move up and Move down. Every other row gets the tooltip."
  test("a manager row keeps its tooltip and adds its Move up and Move down menu, whose keyboard path its description names", () => {
    const html = inSidebar(
      createElement(SessionRow, {
        close: () => {},
        move: { down: () => {}, up: null },
        now: NOW,
        selected: false,
        worker: worker("builder", "manager"),
      }),
    )
    expect(html).toContain('data-slot="context-menu-trigger"')
    expect(tipsOf(html)).toHaveLength(1)
    expect(descriptionOf(html)).toEndWith(". Shift+F10 opens its menu")
  })

  test("its held light draws the icon, so a pause between steps does not flash idle", () => {
    const html = inSidebar(
      createElement(SessionRow, {
        close: () => {},
        light: "working",
        now: NOW,
        selected: false,
        worker: worker("worker-greed", "worker", { light: "idle" }),
      }),
    )
    expect(leftIcon(html)).toEqual({ icon: "working", tone: "text-info" })
  })

  test("while the live feed is lost its spinner stops", () => {
    const render = (still: boolean) =>
      inSidebar(
        createElement(SessionRow, {
          close: () => {},
          now: NOW,
          selected: false,
          still,
          worker: worker("worker-greed", "worker"),
        }),
      )
    expect(render(false)).toContain("animate-spin")
    expect(render(true)).not.toContain("animate-spin")
  })

  test("while the live feed is lost the row dims, as the stored sidebar's do", () => {
    const item = (still: boolean) =>
      openTag(
        inSidebar(
          createElement(SessionRow, {
            close: () => {},
            now: NOW,
            selected: false,
            still,
            worker: worker("worker-greed", "worker"),
          }),
        ),
        /<li[^>]*data-sidebar="menu-item"[^>]*>/,
      )
    expect(classesOf(item(true)).has("opacity-60")).toBe(true)
    expect(classesOf(item(false)).has("opacity-60")).toBe(false)
    const ops = (still: boolean) =>
      openTag(
        inSidebar(
          createElement(OpsJobRow, {
            now: NOW,
            row: {
              does: "",
              job: "ops-dashboard",
              lastBeatAt: "2026-10-06T11:59:50.000Z",
              name: "Dashboard updates",
              paused: false,
              problem: null,
              reason: null,
              schedule: null,
              status: "running",
            },
            still,
          }),
        ),
        /<li[^>]*data-sidebar="menu-item"[^>]*>/,
      )
    expect(classesOf(ops(true)).has("opacity-60")).toBe(true)
  })

  test("a roster row dims by its button alone, so a live checker nested under it draws at full strength", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../../../web/next/src/components/dashboard/app-sidebar.tsx"),
      "utf8",
    )
    const roster = source.slice(
      source.indexOf("function RosterRow"),
      source.indexOf("function useSessionRows"),
    )
    expect(roster).not.toMatch(/<SidebarMenuItem className="[^"]*opacity-60/)
    expect(roster).toContain("opacity-60")
  })

  // #i547: a stuck checker leaves its roster row collapsed too, whose icon reads Stuck while it hides the checker
  test("a roster row stays collapsed while a checker under it is stuck, and its icon draws the alarm", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../../../web/next/src/components/dashboard/app-sidebar.tsx"),
      "utf8",
    )
    const roster = source.slice(
      source.indexOf("function RosterRow"),
      source.indexOf("function useSessionRows"),
    )
    expect(roster).not.toContain("isOpen || memberStuck")
    expect(roster).toContain('state={memberStuck && !membersShown ? "stuck" : status.state}')
  })

  test("a roster row reads the live row's shape: its title stripped of the ids it shows on one line, its name and state on the hover", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../../../web/next/src/components/dashboard/app-sidebar.tsx"),
      "utf8",
    )
    const roster = source.slice(
      source.indexOf("function RosterRow"),
      source.indexOf("function useSessionRows"),
    )
    // no plaid repeat: the title loses the copy of the id the first line already shows (firstLineOf strips it), and the line reads as a live row's (RowFirst)
    expect(roster).toContain("firstLineOf(agent, doingOf(agent, false), null)")
    expect(roster).toContain("<RowFirst")
    // one line in the stock 32px, its state in its tooltip (label)
    expect(roster).not.toContain("<SecondLine")
    expect(roster).toContain("status.text")
    expect(roster).toContain("ROW_BOX")
    expect(roster).not.toContain("{second}")
    expect(roster).not.toContain("flex-wrap")
  })

  test("a row with nothing waiting has no bubble and links to the session alone", () => {
    const html = row("worker-greed", "worker")
    expect(html).not.toContain('data-sidebar="menu-badge"')
    expect(html).toContain('href="/dashboard?worker=s-worker-greed"')
  })

  // ZeroSDK's row, one line
  test("its row is one line, its title alone in the stock 32px, and what its second line said is a line of its tooltip", () => {
    const html = row("worker-greed", "worker")
    const first = openTag(html, /<span class="[^"]*text-xs[^"]*">/)
    expect(textOf(html, first)).toBe("Message dispatcher from the dashboard")
    expect(html).not.toContain("text-2xs")
    expect(html).not.toContain("data-part")
    expect(shownText(html)).toBe("Message dispatcher from the dashboard")
    expect(tipLines(html)).toEqual([
      "worker-greed",
      "Message dispatcher from the dashboard",
      "Working",
    ])
  })

  test("a working worker's time left sits after its state on the hover alone, and keeps the stock height either way", () => {
    const html = row("worker-greed", "worker", [], {
      eta: "2026-10-06T12:20:00.000Z",
    })
    expect(tipLines(html)).toContain("Working · ~20m")
    expect(descriptionOf(html)).toStartWith(
      "worker-greed · Message dispatcher from the dashboard · Working · ~20m",
    )
    expect(shape(html)).toEqual(stock)
    const overdue = row("worker-greed", "worker", [], {
      eta: "2026-10-06T11:00:00.000Z",
    })
    expect(tipLines(overdue)).toContain("Working")
    expect(overdue).not.toContain("~20m")
    expect(shape(overdue)).toEqual(stock)
  })

  test("its model and effort are icons at its right end, its provider's logo and the effort's level, each naming itself on hover, and its tooltip still says both", () => {
    const html = row("worker-greed", "worker", [], {
      effort: "high",
      model: "claude-opus-5-5",
    })
    const button = /<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ""
    const logo = button.indexOf(pathOf(RiAnthropicFill))
    const effort = button.indexOf(pathOf(RiSignalCellular3Fill))
    expect(logo).toBeGreaterThan(button.indexOf("Message dispatcher from the dashboard"))
    expect(effort).toBeGreaterThan(logo)
    expect(tipsOf(html)).toEqual([
      "worker-greed\nMessage dispatcher from the dashboard\nOpus 5.5 high · Working",
      "Opus 5.5",
      "high",
    ])
    expect(shownText(html)).toBe("Message dispatcher from the dashboard")
    expect(shape(html)).toEqual(stock)
    // a GLM model draws Z.ai's own Z, ZeroSDK's mark, and a row with no model or effort draws neither
    const glm = row("worker-greed", "worker", [], { model: "glm-5.3-flash" })
    expect(glm).toContain('d="M20.1312 7.50002L17.4088')
    expect(glm).not.toContain(pathOf(RiZhipuAiFill))
    expect(tipsOf(glm)).toContain("GLM 5.3 Flash")
    const bare = row("worker-greed", "worker")
    expect(bare).not.toContain(pathOf(RiAnthropicFill))
    expect(tipsOf(bare)).toHaveLength(1)
  })

  for (const [name, role] of [
    ["ops", "manager"],
    ["runner-pride", "runner"],
    ["worker-greed", "worker"],
  ] as const) {
    test(`a ${role} row that opens nothing keeps the effort's place with no effort, so its logo lines up with a row that has one`, () => {
      const html = row(name, role, [], { model: "claude-opus-5-5" })
      const logo = html.indexOf(pathOf(RiAnthropicFill))
      expect(logo).toBeGreaterThan(-1)
      expect(
        html.indexOf(
          '<span class="size-4 shrink-0 group-data-[collapsible=icon]:hidden"></span>',
          logo,
        ),
      ).toBeGreaterThan(logo)
    })
  }

  test("an idle worker, a runner and a manager show no ETA", () => {
    const eta = "2026-10-06T12:20:00.000Z"
    expect(tipLines(row("worker-greed", "worker", [], { eta, light: "idle" }))).toContain("Idle")
    expect(row("worker-greed", "worker", [], { eta, light: "idle" })).not.toContain("~20m")
    expect(tipLines(row("runner-pride", "runner", [], { eta }))).toContain("Working")
    expect(tipLines(row("builder", "manager", [], { eta }))).toContain("Working")
  })

  test("a checker leading its row carries data-root-checker with its name; a worker's row carries none", () => {
    expect(row("reviewer-greed-97", "worker", [])).toContain(
      'data-root-checker="reviewer-greed-97"',
    )
    expect(row("worker-greed", "worker", [])).not.toContain("data-root-checker")
  })

  // Inbox #i454, narrowed by #i493: "dispatcher keeps Playground; only managers drop names".
  test("a manager row shows its roster title alone while the dispatcher's keeps its name, and both keep the full name for screen readers", () => {
    const shown = shownText
    const manager = row("builder", "manager", [], {
      model: "claude-opus-5-5",
      title: "Builder",
    })
    expect(shown(manager)).toBe("Builder")
    expect(descriptionOf(manager)).toStartWith("builder · Builder")
    const dispatcher = row("dispatcher", "dispatcher", [], {
      title: "Dispatcher",
    })
    expect(shown(dispatcher)).toBe("Dispatcher")
    expect(descriptionOf(dispatcher)).toStartWith("dispatcher · Dispatcher")
    // the header's row names its dispatcher Alpha (agentLabel), its model in its logo's tooltip
    const header = inSidebar(
      createElement(SessionRow, {
        close: () => {},
        label: "Alpha",
        now: NOW,
        selected: false,
        worker: worker("dispatcher", "dispatcher", {
          effort: "high",
          model: "claude-opus-5-5",
        }),
      }),
    )
    expect(shown(header)).toBe("Alpha")
    expect(tipsOf(header)).toEqual(["Alpha\nWorking", "Opus 5.5", "high"])
  })

  test("a dispatcher's row reads Alpha for dispatcher and Bravo for dispatcher-2, and its slot's role while no session holds it", () => {
    expect(dispatcherRowLabel({ name: "dispatcher" }, true)).toBe("Alpha")
    expect(dispatcherRowLabel({ name: "dispatcher-2" }, false)).toBe("Bravo")
    expect(dispatcherRowLabel({ name: "glm-dispatcher" }, false)).toBe("GlmDispatcher")
    expect(dispatcherRowLabel(null, true)).toBe("Alpha")
    expect(dispatcherRowLabel(null, false)).toBe("Bravo")
  })
})

describe("keepsNested", () => {
  const waiting = new Set(["checker"])
  const keep = (name: string) => waiting.has(name)

  test("a closed group keeps a row whose nested member waits on you or is open, its lead idle", () => {
    expect(keepsNested("manager", ["checker"], keep)).toBe(true)
  })

  test("and keeps a row whose lead keeps, and drops one where nothing does", () => {
    expect(keepsNested("checker", [], keep)).toBe(true)
    expect(keepsNested("manager", ["tester"], keep)).toBe(false)
  })
})

describe("a group's None running", () => {
  test("a Subagents group whose only session is a manager's tester is empty, its rows alone judged", () => {
    const tester = worker("tester-greed-97", "worker")
    expect(groupEmpty("Subagents", [tester], 0)).toBe(true)
    expect(groupEmpty("Subagents", [tester], 1)).toBe(false)
    expect(groupEmpty("Subagents", [], 0)).toBe(true)
    expect(groupEmpty("Orchestrators", [tester], 0)).toBe(true)
    expect(groupEmpty("Other", [], 0)).toBe(true)
    expect(groupEmpty("Other", [tester], 0)).toBe(false)
    expect(groupEmpty("AI Runners", [], 0)).toBe(true)
  })
})

describe("SessionRow's dropdown and group", () => {
  type Props = Parameters<typeof SessionRow>[0]
  type Task = Worker["tasks"][number]
  const task = (id: string, kind: Task["kind"], state: Task["state"], label = id): Task => ({
    endedAt: null,
    id,
    kind,
    label,
    startedAt: "2026-10-06T11:50:00.000Z",
    state,
    taskId: null,
  })
  const render = (props: Partial<Props>, fields: Partial<Worker> = {}) =>
    inSidebar(
      createElement(SessionRow, {
        close: () => {},
        now: NOW,
        selected: false,
        worker: worker("worker-greed", "worker", fields),
        ...props,
      }),
    )
  const tasks = [
    task("t1", "agent", "running", "Review the diff"),
    task("t2", "agent", "done", "Check the schema"),
    task("t3", "process", "running", "Watch the log"),
  ]

  test("a row with no members, subagents or processes has no chevron", () => {
    expect(render({})).not.toContain('data-sidebar="menu-action"')
  })

  test("a row with tasks has a chevron, collapsed by default, that names what it holds", () => {
    const html = render({}, { tasks })
    expect(html).toMatch(/<button[^>]*data-sidebar="menu-action"[^>]*aria-expanded="false"/)
    expect(html).toContain('aria-label="Show 3 tasks"')
    expect(html).not.toContain('data-sidebar="menu-sub"')
  })

  // the menu opens on a click alone, never on hover, and the chevron is centred, as the docs draw it
  test("only the row's own tooltip opens on hover, nothing under it, and its chevron is the docs sidebar's: the stock icon at the row's right edge, turning in 200ms", () => {
    const html = render({ open: true }, { tasks })
    expect(tipsOf(html)).toHaveLength(1)
    expect(tipsOf(html)[0]).toStartWith("worker-greed\n")
    const action = openTag(html, /<button[^>]*data-sidebar="menu-action"[^>]*>/)
    // the stock 20px box at 6px from the edge puts the 16px icon 8px in, where the docs row's padding puts its own; in the 32px row its top-1.5 centres it
    expect(classesOf(action).has("right-1.5")).toBe(true)
    expect(classesOf(action).has("top-1.5")).toBe(true)
    const icon = openTag(action.length ? html.slice(html.indexOf(action)) : "", /<svg[^>]*>/)
    expect([...classesOf(icon)].sort()).toEqual([
      "duration-200",
      "remixicon",
      "rotate-90",
      "transition-transform",
    ])
  })

  // a row's toggle takes its effort's place, and both follow one set of rules
  test("its toggle sits in its effort icon's place, showing on hover, keyboard focus, while open and always on a phone, the effort hidden by the same rules", () => {
    const toggle = [
      "group-data-[open]/menu-item:opacity-100",
      "md:group-has-[:focus-visible]/menu-item:opacity-100",
      "md:group-hover/menu-item:opacity-100",
      "md:opacity-0",
      "peer-data-active/menu-button:text-sidebar-accent-foreground",
    ]
    const hidden = [
      "group-data-[open]/menu-item:invisible",
      "max-md:invisible",
      "md:group-has-[:focus-visible]/menu-item:invisible",
      "md:group-hover/menu-item:invisible",
    ]
    for (const open of [false, true]) {
      const html = render({ open }, { effort: "high", model: "claude-opus-5-5", tasks })
      const action = classesOf(openTag(html, /<button[^>]*data-sidebar="menu-action"[^>]*>/))
      expect(toggle.filter((c) => action.has(c))).toEqual(toggle)
      const effort = openTag(
        html,
        new RegExp(`<span[^>]*>(?=<svg[^>]*><path d="${pathOf(RiSignalCellular3Fill)}")`),
      )
      expect(hidden.filter((c) => classesOf(effort).has(c))).toEqual(hidden)
      // the effort sits where the toggle does, at the row's right padding, and no pr-8 holds room for it
      const button = classesOf(openTag(html, /<a[^>]*data-sidebar="menu-button"[^>]*>/))
      expect(button.has("group-has-data-[sidebar=menu-action]/menu-item:pr-2")).toBe(true)
      expect(button.has("pr-8")).toBe(false)
      const item = openTag(html, /<li[^>]*data-sidebar="menu-item"[^>]*>/)
      expect(item.includes("data-open")).toBe(open)
    }
    // a row with nothing to open keeps its effort in sight
    const plain = render({}, { effort: "high", model: "claude-opus-5-5" })
    expect(plain).not.toContain("max-md:invisible")
  })

  // Alpha's plus shows only while the pointer is over its own box, the effort's place, so the effort stays in sight with the pointer elsewhere on the row
  test("the dispatcher's plus shows on hover over the effort's place alone, keyboard focus, while open and on a phone, and the effort hides only while it shows", () => {
    const plus = new Set(PLUS_SHOWN.split(" "))
    expect(plus.has("md:hover:opacity-100")).toBe(true)
    expect(plus.has("md:group-hover/menu-item:opacity-100")).toBe(false)
    for (const kept of [
      "group-data-[open]/menu-item:opacity-100",
      "md:group-has-[:focus-visible]/menu-item:opacity-100",
      "md:opacity-0",
    ])
      expect(plus.has(kept)).toBe(true)
    const action = createElement("button", {
      "data-sidebar": "menu-action",
      type: "button",
    }) as Props["action"]
    const html = render({ action }, { effort: "high", model: "claude-opus-5-5" })
    const effort = classesOf(
      openTag(
        html,
        new RegExp(`<span[^>]*>(?=<svg[^>]*><path d="${pathOf(RiSignalCellular3Fill)}")`),
      ),
    )
    expect(
      effort.has(
        "md:[@media(hover:hover)]:group-has-[[data-sidebar=menu-action]:hover]/menu-item:invisible",
      ),
    ).toBe(true)
    expect(effort.has("md:group-hover/menu-item:invisible")).toBe(false)
    for (const kept of [
      "group-data-[open]/menu-item:invisible",
      "group-has-data-[popup-open]/menu-item:invisible",
      "max-md:invisible",
      "md:group-has-[:focus-visible]/menu-item:invisible",
    ])
      expect(effort.has(kept)).toBe(true)
  })

  test("the header hands Alpha's plus PLUS_SHOWN, never the toggle's rule", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/app-sidebar.tsx")).text()
    const start = source.indexOf("export function DashboardDispatchers")
    const group = source.slice(start, source.indexOf("\n}\n", start))
    const picker = group.slice(
      group.indexOf("<TemplatePicker"),
      group.indexOf("/>", group.indexOf("<TemplatePicker")),
    )
    expect(picker).toContain("PLUS_SHOWN")
    expect(picker).not.toContain("TOGGLE_SHOWN")
  })

  test("open, it lists each subagent and running process with its state, a finished subagent as Done", () => {
    const html = render({ open: true }, { tasks })
    expect(html).toMatch(/aria-expanded="true"/)
    expect(html).toContain('data-sidebar="menu-sub"')
    expect(html).toContain(">Review the diff · Running<")
    expect(html).toContain(">Check the schema · Done<")
    expect(html).toContain(">Watch the log · Running<")
  })

  test("a process named by its description reads its command to screen readers, one named by its command adds nothing", () => {
    const html = render(
      { open: true },
      {
        tasks: [
          {
            ...task("t1", "process", "running", "Watch the 5-hour pace"),
            command: "python3 -I /tmp/pace.py",
          },
          {
            ...task("t2", "process", "running", "tail -f ops.log"),
            command: "tail -f ops.log",
            startedAt: "2026-10-06T11:40:00.000Z",
          },
        ],
      },
    )
    const buttons = html.match(/<[a-z]+[^>]*data-sidebar="menu-sub-button"[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toContain('aria-description="python3 -I /tmp/pace.py"')
    expect(buttons[1]).not.toContain("aria-description")
  })

  type Agent = NonNullable<Props["agent"]>
  type Pull = NonNullable<Agent["pr"]>
  const pull = (fields: Partial<Pull> = {}): Pull => ({
    approvals: 0,
    ci: "passing",
    draft: false,
    number: 197,
    queued: false,
    reviewed: true,
    round: 2,
    score: "5/5",
    state: "open",
    tester: null,
    title: "",
    updatedAt: null,
    url: "https://github.com/o/r/pull/197",
    verdict: null,
    ...fields,
  })
  const agent = (fields: Partial<Agent> = {}): Agent => ({
    branch: null,
    branchTicket: null,
    eta: null,
    kind: null,
    lastActivityAt: null,
    name: "worker-greed",
    parked: null,
    pr: pull(),
    pullProblem: null,
    report: null,
    role: "worker",
    schedule: null,
    sessionId: "s-worker-greed",
    state: "working",
    status: null,
    task: null,
    ticket: "MADECEDAR-1234",
    title: null,
    worker: null,
    workspace: null,
    ...fields,
  })

  test("its reviewers and testers nest under it, each linking to its own stream; one at work makes its idle worker wait on checks", () => {
    const reviewer = worker("reviewer-greed", "worker")
    const html = render(
      {
        agent: agent({ pr: pull({ score: null }), state: "idle" }),
        members: [{ agent: null, waiting: [], worker: reviewer }],
        open: true,
      },
      { light: "idle" },
    )
    expect(html).toContain('aria-label="Hide 1 checking its PR"')
    expect(html).toContain('href="/dashboard?worker=s-reviewer-greed"')
    expect(leftIcon(html)).toEqual({ icon: "waiting", tone: "text-caution" })
    expect(tipLines(html)).toContain("Waiting on checks · review round 2")
  })

  test("a member row is one line, its label with its model's logo and effort at its right, its lines whole in its tooltip", () => {
    const reviewer = worker("reviewer-greed", "worker", {
      model: "claude-opus-5-5",
      effort: "high",
    })
    const html = render(
      {
        members: [{ agent: null, waiting: [], worker: reviewer }],
        open: true,
      },
      { light: "idle" },
    )
    const link =
      /<a[^>]*href="\/dashboard\?worker=s-reviewer-greed"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ??
      ""
    expect(link).not.toContain("text-2xs")
    expect(shownText(link)).toBe("Message dispatcher from the dashboard")
    expect(link.indexOf(pathOf(RiSignalCellular3Fill))).toBeGreaterThan(
      link.indexOf(pathOf(RiAnthropicFill)),
    )
    const button = openTag(html, /<a[^>]*href="\/dashboard\?worker=s-reviewer-greed"[^>]*>/)
    expect([...classesOf(button)].filter((c) => /^(h|min-h)-/.test(c))).toEqual(["h-7"])
    // its name and both lines are its tooltip, a line each (a reviewer: a reviewer and a tester otherwise read the same), and a screen reader hears them as one line
    expect(tipsOf(html)).toContain(
      "reviewer-greed\nMessage dispatcher from the dashboard\nOpus 5.5 high · Working",
    )
    expect(button).toContain(
      'aria-description="reviewer-greed · Message dispatcher from the dashboard · Opus 5.5 high · Working"',
    )
    expect(button).not.toContain('data-slot="context-menu-trigger"')
  })

  test("a runner's schedule, after its state, is a line of its tooltip", () => {
    const html = render(
      {
        agent: agent({
          name: "runner-pride",
          role: "runner",
          schedule: "always",
        }),
      },
      {
        effort: "high",
        model: "claude-opus-5-5",
        name: "runner-pride",
        role: "runner",
      },
    )
    expect(html).not.toContain("text-2xs")
    expect(tipLines(html)).toContain("Opus 5.5 high · Working · always running")
  })

  // #i547, approved: "a worker row stays collapsed while its nested reviewer or tester is stuck; the worker row already draws the red alarm itself, so nothing hides"
  test("a stuck checker leaves its worker collapsed, whose row draws the red alarm and names it, so nothing hides; its worker draws no count", () => {
    const tester = worker("tester-greed", "worker", { light: "needs-you" })
    const members = [{ agent: null, waiting: ["20261006-090000-aaaaaa"], worker: tester }]
    const html = render({ agent: agent({ state: "idle" }), members }, { light: "idle" })
    expect(html).not.toContain('href="/dashboard?worker=s-tester-greed"')
    const button = /<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ""
    expect(icons(button)).toEqual([{ icon: "stuck", tone: "text-destructive" }])
    expect(descriptionOf(html)).toMatch(/^worker-greed · .* · TesterGreed Stuck$/)
    expect(html).not.toContain('data-sidebar="menu-badge"')
    // the row's link opens the member's card
    expect(html).toContain(
      'href="/dashboard?worker=s-tester-greed#needs-you-20261006-090000-aaaaaa"',
    )
  })

  test("opened, a stuck checker draws its own red alarm under its worker, which draws its own state, and the rail keeps the alarm", () => {
    const tester = worker("tester-greed", "worker", { light: "needs-you" })
    const html = render(
      {
        agent: agent({ state: "idle" }),
        members: [{ agent: null, waiting: [], worker: tester }],
        open: true,
      },
      { light: "idle" },
    )
    const link = /<a[^>]*href="\/dashboard\?worker=s-tester-greed"[^>]*>([\s\S]*?)<\/a>/.exec(html)
    // outside the sub-button's [&>svg] colour rule, so its state's colour shows
    expect(link?.[0]).toContain("[&amp;&gt;svg]:text-sidebar-accent-foreground")
    expect(link?.[1]).toMatch(/^<span class="flex shrink-0"><svg[^>]*class="[^"]*text-destructive/)
    expect(icons(link?.[1] ?? "")).toEqual([{ icon: "stuck", tone: "text-destructive" }])
    // expanded: the worker's own state over its stuck member; on the rail, which hides members: the red alarm
    const button = /<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ""
    const [own, rail] = [...button.matchAll(/<span class="([^"]*)">(<svg[\s\S]*?<\/svg>)<\/span>/g)]
    expect(own?.[1]).toContain("group-data-[collapsible=icon]:hidden")
    expect(icons(own?.[2] ?? "")).toEqual([{ icon: "waiting", tone: "text-caution" }])
    expect(rail?.[1]).toContain("hidden")
    expect(rail?.[1]).toContain("group-data-[collapsible=icon]:flex")
    expect(icons(rail?.[2] ?? "")).toEqual([{ icon: "stuck", tone: "text-destructive" }])
    // a worker whose members are not stuck draws one icon, on the rail too
    const calm = render({
      members: [{ agent: null, waiting: [], worker: worker("tester-greed", "worker") }],
    })
    expect(
      icons(/<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(calm)?.[1] ?? ""),
    ).toHaveLength(1)
  })

  test("a member the usage limit alone holds raises no alarm on the rail and is not named as stuck", () => {
    const tester = worker("tester-greed", "worker", {
      light: "needs-you",
      usageLimit: { resets: "3pm (UTC)", resetsAt: null },
    })
    const html = render(
      {
        agent: agent({ state: "idle" }),
        members: [{ agent: null, waiting: [], worker: tester }],
      },
      { light: "idle" },
    )
    const button = /<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ""
    expect(icons(button)).not.toContainEqual({
      icon: "stuck",
      tone: "text-destructive",
    })
    expect(html).not.toContain("TesterGreed Stuck")
  })

  test("a member in view shows under its collapsed worker, so the view always has its row", () => {
    const reviewer = worker("reviewer-greed", "worker")
    const member = { agent: null, waiting: [], worker: reviewer }
    expect(render({ members: [member] })).not.toContain('href="/dashboard?worker=s-reviewer-greed"')
    const html = render({ members: [member], selectedId: "s-reviewer-greed" })
    const link = openTag(html, /<a[^>]*href="\/dashboard\?worker=s-reviewer-greed"[^>]*>/)
    expect(link).toContain("data-active")
  })

  test(`its line leads with the ticket and the pull request joined (PG-12#173), and its tooltip says the rest`, () => {
    const html = render({ agent: agent({ state: "idle" }) }, { light: "idle" })
    expect(textOf(html, openTag(html, /<span class="[^"]*text-xs[^"]*">/))).toBe(
      "MADECEDAR-1234#197 Message dispatcher from the dashboard",
    )
    expect(leftIcon(html)).toEqual({ icon: "ready", tone: "text-success" })
    expect(html).not.toContain("text-2xs")
    expect(descriptionOf(html)).toBe(
      "worker-greed · MADECEDAR-1234#197 Message dispatcher from the dashboard · Ready · PR ready: 5/5 at its head",
    )
    expect(tipsOf(html)[0]).toBe(
      [
        "worker-greed",
        "MADECEDAR-1234#197 Message dispatcher from the dashboard",
        "Ready",
        "PR ready: 5/5 at its head",
      ].join("\n"),
    )
  })

  test("a worker's label is its ticket and pull request with no role word", () => {
    const html = render({ agent: agent({ kind: "worker" }) })
    expect(
      textOf(html, openTag(html, /<span class="[^"]*text-xs[^"]*">/)).replaceAll("\u00a0", " "),
    ).toBe("MADECEDAR-1234#197 Message dispatcher from the dashboard")
  })

  test("with neither id the kind follows the title at once, a worker's title alone, the title giving way first", () => {
    const first = (html: string) =>
      textOf(html, openTag(html, /<span class="[^"]*text-xs[^"]*">/)).replaceAll("\u00a0", " ")
    expect(first(render({ agent: agent({ kind: "worker", pr: null, ticket: null }) }))).toBe(
      "Message dispatcher from the dashboard",
    )
    const html = render({
      agent: agent({ kind: "runner", pr: null, ticket: null }),
    })
    expect(first(html)).toBe("Message dispatcher from the dashboard · runner")
    // a title that grew (flex-1) would push the kind to the row's right edge, 45 to 99px from its words
    expect(html).toContain(
      '<span class="min-w-0 truncate">Message dispatcher from the dashboard</span>',
    )
    expect(partsOf(html).label?.classes).toEqual([
      "max-w-full",
      "min-w-0",
      "shrink-0",
      "text-muted-foreground",
      "truncate",
    ])
  })

  test("the pull request's number takes its colour, said in words; the icon says what the worker does", () => {
    const html = render({
      agent: agent({ pr: pull({ ci: "failing", score: "4/5" }) }),
    })
    expect(html).toContain('<span class="tabular-nums text-destructive">#197</span>')
    expect(html).toContain("<span>Message dispatcher from the dashboard</span>")
    expect(html).toContain('<span class="sr-only"> (PR CI failing)</span>')
    expect(leftIcon(html)).toEqual({ icon: "fixing", tone: "text-caution" })
    expect(tipLines(html)[2]).toStartWith("Fixing")
    const draft = render({
      agent: agent({ pr: pull({ draft: true, reviewed: false, score: null }) }),
    })
    expect(draft).toContain('<span class="tabular-nums text-inactive">#197</span>')
  })

  // Worker Lights, a test per state: the row's one icon and its colour token
  const cases: [string, Partial<Agent> | null, Partial<Worker>, string, string][] = [
    ["stuck", null, { light: "needs-you" }, "stuck", "text-destructive"],
    [
      "merged",
      { pr: pull({ state: "merged" }), state: "idle" },
      { light: "idle" },
      "merged",
      "text-success",
    ],
    ["failing", { state: "idle" }, { failed: true, light: "idle" }, "failing", "text-destructive"],
    [
      "no progress",
      { pr: null },
      { lastActiveAt: "2026-10-06T11:00:00.000Z" },
      "no-progress",
      "text-destructive",
    ],
    ["fixing", { pr: pull({ score: "3/5" }) }, {}, "fixing", "text-caution"],
    ["working", { pr: null }, {}, "working", "text-info"],
    [
      "waiting",
      { pr: pull({ ci: "pending", score: null }), state: "idle" },
      { light: "idle" },
      "waiting",
      "text-caution",
    ],
    [
      "one approval",
      { pr: pull({ approvals: 1 }), state: "idle" },
      { light: "idle" },
      "approval",
      "text-caution",
    ],
    [
      "approvals",
      { pr: pull({ approvals: 3 }), state: "idle" },
      { light: "idle" },
      "approvals",
      "text-caution",
    ],
    ["ready", { state: "idle" }, { light: "idle" }, "ready", "text-success"],
    [
      "parked",
      { parked: "held for the reset", pr: null, state: "idle" },
      { light: "idle" },
      "parked",
      "text-inactive",
    ],
    ["idle", { pr: null, state: "idle" }, { light: "idle" }, "idle", "text-inactive"],
    // its own pause, so it never reads as Parked, on the rail too
    [
      "usage-limit",
      { pr: null, state: "needs-you" },
      {
        light: "needs-you",
        usageLimit: { resets: "3pm (UTC)", resetsAt: null },
      },
      "usage-limit",
      "text-inactive",
    ],
  ]
  for (const [name, agentFields, fields, icon, tone] of cases)
    test(`${name}: one icon, on the left, in its colour`, () => {
      const html = render({ agent: agentFields ? agent(agentFields) : null }, fields)
      expect(leftIcon(html)).toEqual({ icon, tone })
      expect(icons(html)).toHaveLength(1)
    })

  test("while it works or fixes, its icon is its kind's task in the light's tone, still, and any other light or kind keeps the light", () => {
    const button = (html: string) =>
      /<a[^>]*data-sidebar="menu-button"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ""
    const working = button(render({ agent: agent({ kind: "worker", pr: null }) }))
    expect(working).toMatch(
      new RegExp(`<svg[^>]*class="[^"]*text-info[^"]*"[^>]*><path d="${pathOf(RiHammerFill)}"`),
    )
    expect(working).not.toContain("animate-spin")
    const runner = button(
      render(
        {
          agent: agent({
            kind: "runner",
            name: "runner-pride",
            pr: null,
            role: "runner",
          }),
        },
        { name: "runner-pride", role: "runner" },
      ),
    )
    expect(leftIcon(runner ? `<a data-sidebar="menu-button">${runner}</a>` : "")).toEqual({
      icon: "working",
      tone: "text-info",
    })
    const idle = render(
      { agent: agent({ kind: "worker", pr: null, state: "idle" }) },
      { light: "idle" },
    )
    expect(leftIcon(idle)).toEqual({ icon: "idle", tone: "text-inactive" })
  })

  test("parked says why on hover", () => {
    const html = render(
      {
        agent: agent({ parked: "held for the reset", pr: null, state: "idle" }),
      },
      { light: "idle" },
    )
    expect(tipLines(html)).toContain("Parked · held for the reset")
    expect(html).toContain(
      "worker-greed · MADECEDAR-1234 Message dispatcher from the dashboard · Parked · held for the reset",
    )
  })
})

describe("OpsJobRow", () => {
  type Row = Parameters<typeof OpsJobRow>[0]["row"]
  const job = (fields: Partial<Row>): Row => ({
    callsModel: false,
    does: "Keeps the Dashboard on the newest canary",
    job: "ops-dashboard",
    lastBeatAt: "2026-10-06T11:59:50.000Z",
    model: null,
    name: "Dashboard updates",
    paused: false,
    problem: null,
    reason: null,
    schedule: { every: 300 },
    status: "running",
    ...fields,
  })
  const render = (row: Row) => inSidebar(createElement(OpsJobRow, { now: NOW, row }))

  test("its plain name over Script, its state and when it runs, opening nothing", () => {
    const html = render(job({}))
    expect(html).toContain("Dashboard updates")
    expect(secondLine(html)).toBe("Script · Running · every 5 min")
    expect(html).not.toContain("href=")
    expect(html).toContain("animate-spin")
  })

  test("its title truncates like a worker row's, and its second line is one line whose state is never cut, when it runs and its model cut first (#i546)", () => {
    const html = render(job({ callsModel: true, model: "claude-haiku-4-5" }))
    const first = classesOf(openTag(html, /<span class="[^"]*text-xs[^"]*">/))
    expect(first.has("truncate")).toBe(true)
    const parts = partsOf(html)
    expect(parts.line?.classes).not.toContain("flex-wrap")
    expect(parts.state).toEqual({
      classes: ["shrink-0"],
      text: "Script · Running",
    })
    expect(parts.tail).toEqual({
      classes: ["truncate"],
      text: " · every 5 min · Haiku 4.5",
    })
    expect(parts.head).toBeUndefined()
    const button = classesOf(openTag(html, /<div[^>]*data-sidebar="menu-button"[^>]*>/))
    expect(button.has("h-8") && button.has("py-0")).toBe(true)
  })

  test("a job that calls a model ends its second line with the model's name, or AI, and says Calls for hover and screen readers", () => {
    const labelled = render(job({ callsModel: true, model: "claude-haiku-4-5" }))
    expect(secondLine(labelled)).toBe("Script · Running · every 5 min · Haiku 4.5")
    expect(tipsOf(labelled)).toContain(
      "Dashboard updates (ops-dashboard) · Keeps the Dashboard on the newest canary · Running · beat just now · Calls Haiku 4.5",
    )
    expect(labelled).toContain('<span class="sr-only">Calls </span>')
    expect(secondLine(render(job({ callsModel: true })))).toBe(
      "Script · Running · every 5 min · AI",
    )
    expect(secondLine(render(job({})))).not.toContain("AI")
  })

  // partsOf normalizes the row's non-breaking spaces away, so the parts' first characters are read off the raw markup: a part that follows another leads with a non-breaking space, which holds where a plain space collapses
  test("the tail leads with a non-breaking space, so the dot never loses the gap before it", () => {
    for (const html of [
      render(job({ callsModel: true, model: "claude-haiku-4-5" })),
      render(job({})),
      render(job({ callsModel: true, schedule: null })),
    ]) {
      expect(/data-part="state">(.)/.exec(html)?.[1], "the state leads bare").toBe("S")
      expect(/data-part="tail">(.)/.exec(html)?.[1]).toBe("\u00a0")
    }
    expect(render(job({ schedule: null }))).not.toContain('data-part="tail"')
  })

  // a cron the reader cannot turn into words shows as written, in code font
  test("a cron it cannot read shows as written, in code font", () => {
    expect(render(job({ schedule: { cron: "*/7 1-3 * * 2" } }))).toContain(
      '<code class="font-mono">*/7 1-3 * * 2</code>',
    )
    expect(render(job({}))).not.toContain("<code")
  })

  test("its hover names the job id, what it does, its last beat and a schedule drift", () => {
    const html = render(
      job({
        problem: "Its schedule says every 5 min, its heartbeat every 60s",
      }),
    )
    expect(tipsOf(html)).toContain(
      "Dashboard updates (ops-dashboard) · Keeps the Dashboard on the newest canary · Running · beat just now · Its schedule says every 5 min, its heartbeat every 60s",
    )
    expect(html).toContain('aria-description="Dashboard updates (ops-dashboard)')
    expect(render(job({ does: "", schedule: null }))).not.toContain("null")
  })

  test("Failing and Down read red, with the reason on hover", () => {
    const failing = render(job({ reason: "check failing", status: "failing" }))
    expect(secondLine(failing)).toBe("Script · Failing · every 5 min")
    expect(tipsOf(failing).join()).toContain("Failing: check failing")
    expect(failing).toContain("text-destructive")
    const down = render(job({ lastBeatAt: null, reason: "No heartbeat file", status: "down" }))
    expect(tipsOf(down).join()).toContain("Down: No heartbeat file")
    // an ops job keeps its own three lights: the red power mark for down, since a listed job should run, the red error for failing, the blue spinner while it runs
    expect(icons(down)).toEqual([{ icon: "down", tone: "text-destructive" }])
    expect(icons(failing)).toEqual([{ icon: "failing", tone: "text-destructive" }])
    expect(icons(render(job({})))).toEqual([{ icon: "working", tone: "text-info" }])
  })
})

describe("ThreadsGroup", () => {
  type Page = Parameters<typeof ThreadsGroup>[0]["data"]
  type Thread = Page["threads"][number]
  const thread = (id: string, fields: Partial<Thread> = {}): Thread => ({
    archivedAt: null,
    createdAt: "2026-10-22T10:00:00.000Z",
    firstMessageId: `msg-${id}`,
    id,
    lastReadAt: null,
    pinnedAt: null,
    title: `Follow up on ${id}`,
    unread: 0,
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...fields,
  })
  const page = (threads: Thread[], fields: Partial<Page> = {}): Page => ({
    threads,
    hasNextPage: false,
    page: 1,
    total: threads.length,
    ...fields,
  })
  const render = (data: Page) =>
    renderToStaticMarkup(
      createElement(
        SidebarProvider,
        null,
        createElement(ThreadsGroup, { data, onPage: () => {}, onPatch: () => {} }),
      ),
    ).replaceAll("<!-- -->", "")
  const rows = (html: string) => [...html.matchAll(/<li[^>]*data-sidebar="menu-item"[^>]*>/g)]
  const badges = (html: string) =>
    [...html.matchAll(/data-sidebar="menu-badge"[^>]*>([^<]*)</g)].map(([, text]) => text)

  // the dispatchers' rows sit in the header, so Threads leads the nav, and Yard's Channels and Direct messages follow it, above Orchestrators
  test("is the nav's first group once the threads are read, and is left out before; Yard's groups next; no Dispatchers group", () => {
    expect(navGroups(true, []).map(({ label }) => label)).toEqual([
      "Threads",
      "Yard",
      "Orchestrators",
      "Subagents",
      "AI Runners",
      "Scripts",
    ])
    expect(navGroups(false, []).map(({ label }) => label)).toEqual([
      "Yard",
      "Orchestrators",
      "Subagents",
      "AI Runners",
      "Scripts",
    ])
  })

  test("is absent when there are no threads", () => {
    expect(render(page([]))).not.toContain('data-sidebar="group"')
  })

  test("each row shows its title, opens the thread's own view and gives its full title as its tooltip", () => {
    const long = "Follow up on the merge lock's Redis fallback once the box restarts"
    const html = render(page([thread("k7mq", { title: long }), thread("p2zz")]))
    expect(rows(html)).toHaveLength(2)
    expect(html).toContain('href="/dashboard/threads/k7mq"')
    expect(html).toContain('href="/dashboard/threads/p2zz"')
    expect(tipsOf(html)).toEqual([long, "Follow up on p2zz"])
    expect(html).not.toContain(" title=")
  })

  test("the unread count sits in the row's badge, and a read thread shows none", () => {
    const html = render(page([thread("k7mq", { unread: 3 }), thread("p2zz")]))
    expect(badges(html)).toEqual(["3"])
  })

  test("an unread count past 99 reads 99+, its full number in the tooltip", () => {
    const html = render(page([thread("k7mq", { unread: 142 })]))
    expect(badges(html)).toEqual(["99+"])
    expect(tipsOf(html)).toEqual(["Follow up on k7mq · 142 unread"])
    expect(descriptionOf(html)).toBe("Follow up on k7mq · 142 unread")
  })

  test("an unread count of 99 or less reads in full, with the title alone in the tooltip", () => {
    const html = render(page([thread("k7mq", { unread: 7 }), thread("p2zz", { unread: 99 })]))
    expect(badges(html)).toEqual(["7", "99"])
    expect(tipsOf(html)).toEqual(["Follow up on k7mq", "Follow up on p2zz"])
  })

  test("a row's menu takes the badge's place on hover", () => {
    const html = render(page([thread("k7mq", { unread: 3 })]))
    const action = openTag(html, /<button[^>]*data-sidebar="menu-action"[^>]*>/)
    expect(action).toContain('aria-label="More for Follow up on k7mq"')
    expect(classesOf(action).has("md:opacity-0")).toBe(true)
    const badge = openTag(html, /<div[^>]*data-sidebar="menu-badge"[^>]*>/)
    expect(classesOf(badge).has("group-hover/menu-item:opacity-0")).toBe(true)
    expect(classesOf(badge).has("group-focus-within/menu-item:opacity-0")).toBe(true)
  })

  test("has no pager at five threads or fewer", () => {
    const html = render(page(["a2bc", "d3ef", "g4hj", "k5mn", "p6qr"].map((id) => thread(id))))
    expect(rows(html)).toHaveLength(5)
    expect(html).not.toContain("Previous page")
    expect(html).not.toContain("Next page")
  })

  test("past five, an arrow each side of the page number pages it, live only where a page lies", () => {
    const first = render(
      page(
        ["a2bc", "d3ef", "g4hj", "k5mn", "p6qr"].map((id) => thread(id)),
        {
          hasNextPage: true,
          total: 7,
        },
      ),
    )
    expect(first).toContain('<span aria-hidden="true">1 / 2</span>')
    expect(openTag(first, /<button[^>]*aria-label="Previous page"[^>]*>/)).toContain(
      'aria-disabled="true"',
    )
    expect(openTag(first, /<button[^>]*aria-label="Next page"[^>]*>/)).toContain(
      'aria-disabled="false"',
    )
    // the label is the group's toggle button, and the pager sits beside it
    const label = openTag(first, /<button[^>]*data-sidebar="group-label"[^>]*>/)
    expect(first.indexOf("Previous page")).toBeGreaterThan(first.indexOf(label))
    expect(first.indexOf("Next page")).toBeGreaterThan(first.indexOf("1 / 2"))
    expect(first.indexOf("Previous page")).toBeLessThan(first.indexOf("1 / 2"))
  })

  test("a short last page keeps five rows' height, so the list never jumps as it pages", () => {
    const html = render(page([thread("s7tu"), thread("v8wx")], { page: 2, total: 7 }))
    expect(rows(html)).toHaveLength(2)
    expect([...html.matchAll(/<li[^>]*data-filler[^>]*>/g)]).toHaveLength(3)
    expect(openTag(html, /<button[^>]*aria-label="Next page"[^>]*>/)).toContain(
      'aria-disabled="true"',
    )
  })

  test("a page past the first keeps its height while an archive drops the pager, until it steps back", () => {
    const html = render(page([thread("s7tu")], { page: 2, total: 5 }))
    expect(html).not.toContain('data-slot="group-pager"')
    expect([...html.matchAll(/<li[^>]*data-filler[^>]*>/g)]).toHaveLength(4)
  })

  test("an unread count sits on the group counts' column at every width, and below md, where the row's menu always shows, the menu sits left of it", () => {
    const html = render(page([thread("k7mq", { unread: 3 }), thread("p2zz")]))
    const badge = classesOf(openTag(html, /<div[^>]*data-sidebar="menu-badge"[^>]*>/))
    expect(badge.has("right-1.5")).toBe(true)
    expect([...badge].filter((c) => c.includes("right-"))).toEqual(["right-1.5"])
    const actions = [...html.matchAll(/<button[^>]*data-sidebar="menu-action"[^>]*>/g)].map(
      ([tag]) => classesOf(tag),
    )
    expect(actions[0].has("max-md:right-7")).toBe(true)
    expect(actions[0].has("right-1.5")).toBe(true)
    expect(actions[1].has("max-md:right-7")).toBe(false)
    expect(actions[1].has("right-1.5")).toBe(true)
    const buttons = [...html.matchAll(/<a[^>]*data-sidebar="menu-button"[^>]*>/g)].map(
      ([tag]) => tag,
    )
    const clear = "max-md:group-has-data-[sidebar=menu-action]/menu-item:pr-14"
    expect(classesOf(buttons[0]).has(clear)).toBe(true)
    expect(classesOf(buttons[1]).has(clear)).toBe(false)
  })

  test("below md, a 99+ count moves the row's menu and the title's clearance one step further left", () => {
    const html = render(page([thread("k7mq", { unread: 142 }), thread("p2zz", { unread: 99 })]))
    const actions = [...html.matchAll(/<button[^>]*data-sidebar="menu-action"[^>]*>/g)].map(
      ([tag]) => [...classesOf(tag)].filter((c) => c.startsWith("max-md:right-")),
    )
    expect(actions).toEqual([["max-md:right-10"], ["max-md:right-7"]])
    const buttons = [...html.matchAll(/<a[^>]*data-sidebar="menu-button"[^>]*>/g)].map(([tag]) =>
      [...classesOf(tag)].filter((c) => c.startsWith("max-md:group-has-data-")),
    )
    expect(buttons).toEqual([
      ["max-md:group-has-data-[sidebar=menu-action]/menu-item:pr-16"],
      ["max-md:group-has-data-[sidebar=menu-action]/menu-item:pr-14"],
    ])
  })
})

describe("Alpha's effort icon is the original effort symbol", () => {
  test("Alpha on Opus 5.5 at high effort draws high's own icon beside the Anthropic logo, and the skull stays max's", () => {
    const alphaRow = row("dispatcher", "dispatcher", [], {
      effort: "high",
      model: "claude-opus-5-5",
    })
    expect(alphaRow).toContain(pathOf(RiSignalCellular3Fill))
    expect(alphaRow).toContain(pathOf(RiAnthropicFill))
    expect(alphaRow).not.toContain(pathOf(RiSkull2Fill))
    expect(tipsOf(alphaRow)).toContain("high")
    const maxRow = row("dispatcher", "dispatcher", [], { effort: "max", model: "claude-opus-5-5" })
    expect(maxRow).toContain(pathOf(RiSkull2Fill))
  })
})
