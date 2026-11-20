import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  contentType,
  EXTENSIONS,
  IMAGE_EXTENSIONS,
} from "../../../../../../../api/hono/src/lib/dashboard/attachments"
import { INBOX_ATTACHMENT_KINDS } from "../../../../../../../api/hono/src/lib/dashboard/inbox"
import {
  BAR_COUNT,
  BAR_NAME,
  keepFocus,
  onSelect,
  OpenInNewTab,
  OPENS_IN_TAB,
  pinsBars,
  saveItem,
  tabHref,
  wrapStep,
} from "../../../../../../../web/next/src/components/dashboard/viewer/viewer"
import { pageTab } from "../../../../../../../web/next/src/lib/viewer"

describe("Open in new tab opens a blob URL with the Dashboard's origin only for a file that runs no script", () => {
  test("it opens an image, a PDF or an HTML page, and code and a doc have no button", () => {
    expect([...OPENS_IN_TAB]).toEqual(["html", "image", "pdf"])
    expect(INBOX_ATTACHMENT_KINDS.filter((kind) => !OPENS_IN_TAB.includes(kind))).toEqual([
      "code",
      "doc",
    ])
  })

  const CARD_PAGE = {
    id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.html",
    kind: "html",
    name: "demo.html",
  } as const
  const KEPT_PAGE = {
    id: "page-sidebar-mock.html",
    kind: "html",
    name: "Sidebar spacing",
    page: {
      download: "https://api.test/api/v1/apps/previews/sidebar-mock.html?download=1",
      url: "https://api.test/api/v1/apps/previews/sidebar-mock.html",
    },
  } as const

  test("a kept page opens at its own address on Previews, which serves it sandboxed", () => {
    expect(tabHref(KEPT_PAGE, null, null)).toBe(KEPT_PAGE.page.url)
  })

  // the builder's ruling on #1716: the tab's blob takes the Dashboard's origin, so the page runs only in a frame with no same-origin
  test("a card's page opens as a blob that holds it in a sandboxed frame, and runs no script of its own", () => {
    expect(tabHref(CARD_PAGE, "blob:x", null)).toBeNull()
    expect(tabHref(CARD_PAGE, "blob:x", "blob:framed")).toBe("blob:framed")
    const tab = pageTab("demo.html", "<script>alert(1)</script><p>hi</p>")
    expect(tab).toContain(
      '<iframe sandbox="allow-scripts" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;hi&lt;/p&gt;"',
    )
    expect(tab).not.toContain("allow-same-origin")
    expect(tab).not.toContain("<script")
  })

  // the blob tab takes the Dashboard page's CSP, so on the hosted build the page's scripts carry its nonce, held in the same frame with no same-origin
  test("on the hosted build, a card's page in its tab carries the page's nonce on each script, still in a frame with no same-origin", () => {
    const tab = pageTab(
      "demo.html",
      "<script>a()</script><p>hi</p>",
      "MGI5YzZmMWUtMTExMS00MTExLTgxMTEtMDAwMDAwMDAwMDAx",
    )
    expect(tab).toContain(
      'srcdoc="&lt;script nonce=MGI5YzZmMWUtMTExMS00MTExLTgxMTEtMDAwMDAwMDAwMDAx &gt;a()&lt;/script&gt;',
    )
    expect(tab).toContain('<iframe sandbox="allow-scripts" srcdoc=')
    expect(tab).not.toContain("allow-same-origin")
    expect(tab).not.toContain("<script")
  })

  test("an image or a PDF opens its own blob", () => {
    expect(tabHref({ ...CARD_PAGE, kind: "pdf", name: "a.pdf" }, "blob:pdf", null)).toBe("blob:pdf")
  })

  // a reviewer: the framed page's blob URL held the whole page for the dashboard tab's life
  test("the framed page's blob URL is freed once its square goes", async () => {
    const source = await Bun.file(
      join(
        import.meta.dir,
        "../../../../../../../web/next/src/components/dashboard/viewer/viewer.tsx",
      ),
    ).text()
    expect(source).toMatch(/return \(\) => \{\s+URL\.revokeObjectURL\(href\)/)
  })

  test("a kept page saves from its own download address", async () => {
    const fetched: string[] = []
    const scope = globalThis as { document?: unknown; fetch: typeof fetch }
    const [realFetch, realDocument] = [scope.fetch, scope.document]
    scope.fetch = (async (url: string) => {
      fetched.push(String(url))
      return new Response("<p>page</p>")
    }) as typeof fetch
    scope.document = { createElement: () => ({ click: () => {}, download: "", href: "" }) }
    try {
      await saveItem(KEPT_PAGE)
    } finally {
      scope.fetch = realFetch
      scope.document = realDocument
    }
    expect(fetched).toEqual([KEPT_PAGE.page.download])
  })

  test("an image is never an SVG, and no file is served as HTML or SVG, whatever it holds", () => {
    expect(IMAGE_EXTENSIONS as readonly string[]).not.toContain("svg")
    for (const extension of [...EXTENSIONS, "htm", "html", "svg"])
      expect(contentType(`3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.${extension}`)).not.toMatch(
        /html|svg|xml|javascript/,
      )
  })
})

describe("a step past either end wraps", () => {
  test("Next on the last goes to the first and Previous on the first to the last, each a jump", () => {
    expect(wrapStep(19, 1, 20)).toEqual({ next: 0, wraps: true })
    expect(wrapStep(0, -1, 20)).toEqual({ next: 19, wraps: true })
  })

  test("a step inside sweeps to its neighbour", () => {
    expect(wrapStep(15, 1, 20)).toEqual({ next: 16, wraps: false })
    expect(wrapStep(15, -1, 20)).toEqual({ next: 14, wraps: false })
  })

  test("one file stays put", () => {
    expect(wrapStep(0, 1, 1).next).toBe(0)
    expect(wrapStep(0, -1, 1).next).toBe(0)
  })
})

describe("a frame keeps a touch to itself, so on a screen with no hover its bars stay up", () => {
  test("an HTML page or a PDF on a touch screen keeps the bar and the X up", () => {
    expect(pinsBars("html", true)).toBe(true)
    expect(pinsBars("pdf", true)).toBe(true)
  })

  test("a picture on touch, and every kind with a pointer that hovers, leave the bars to the pointer", () => {
    expect(pinsBars("image", true)).toBe(false)
    for (const kind of INBOX_ATTACHMENT_KINDS) expect(pinsBars(kind, false)).toBe(false)
  })
})

describe("the bar holds one width from slide to slide", () => {
  const web = join(import.meta.dir, "../../../../../../../web/next")
  const render = async (kind: (typeof INBOX_ATTACHMENT_KINDS)[number]) => {
    const { createElement } = await import(Bun.resolveSync("react", web))
    const { renderToStaticMarkup } = await import(Bun.resolveSync("react-dom/server", web))
    const { QueryClient, QueryClientProvider } = await import(
      Bun.resolveSync("@tanstack/react-query", web)
    )
    const item = { id: "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png", kind, name: "a.png" }
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(OpenInNewTab, { item, keepRoom: true }),
      ),
    ) as string
  }

  test("the count and the name take fixed widths", () => {
    expect(BAR_COUNT.split(" ")).toEqual(
      expect.arrayContaining(["w-16", "shrink-0", "text-center"]),
    )
    expect(BAR_NAME.split(" ")).toEqual(expect.arrayContaining(["w-48", "truncate"]))
  })

  test("a kind with no Open in new tab keeps a square's room in its place", async () => {
    expect(await render("code")).toBe('<span aria-hidden="true" class="size-8 shrink-0"></span>')
    expect(await render("image")).toContain('aria-label="Open in new tab"')
    expect(await render("html")).toContain('aria-label="Open in new tab"')
  })
})

// a tester: Down from the compare slider moved the slide and dropped focus to the page, so Left, Right and Up did nothing after
describe("a slide holding focus hands it to the stage before it goes inert", () => {
  const stage = () => {
    const calls: unknown[] = []
    return {
      calls,
      el: { focus: (options: unknown) => calls.push(options) } as unknown as HTMLElement,
    }
  }
  const inSlide = (yes: boolean) =>
    ({
      closest: (selector: string) =>
        yes && selector === '[data-slot="carousel-item"]' ? {} : null,
    }) as unknown as Element

  test("focus in a slide moves to the stage, without scrolling", () => {
    const { calls, el } = stage()
    keepFocus(inSlide(true), el)
    expect(calls).toEqual([{ preventScroll: true }])
  })

  test("focus on the stage, the bar or nowhere stays where it is", () => {
    const { calls, el } = stage()
    keepFocus(inSlide(false), el)
    keepFocus(null, el)
    expect(calls).toEqual([])
  })

  // as embla-carousel 8.6.0 does: scrollTo emits select only when the index changes
  const embla = (count: number, onIndexChange: (index: number) => void, el: HTMLElement) => {
    let current = 0
    return (direction: -1 | 1) => {
      const { next } = wrapStep(current, direction, count)
      if (next === current) return
      current = next
      onSelect(next, inSlide(true), el, onIndexChange)
    }
  }

  test("a select hands the old slide's focus to the stage, then moves the index", () => {
    const { calls, el } = stage()
    const indexes: number[] = []
    embla(3, (index) => indexes.push(index), el)(1)
    expect(calls).toEqual([{ preventScroll: true }])
    expect(indexes).toEqual([1])
  })

  test("an arrow on a lone item moves nothing, so focus stays in its page", () => {
    const { calls, el } = stage()
    const indexes: number[] = []
    const go = embla(1, (index) => indexes.push(index), el)
    go(1)
    go(-1)
    expect(calls).toEqual([])
    expect(indexes).toEqual([])
  })
})

// a reviewer: the stage took the muted focus fill once the keyboard was used
describe("the stage stays see-through while it holds focus", () => {
  test("its focus takes no fill", async () => {
    const web = join(import.meta.dir, "../../../../../../../web/next")
    const viewer = await Bun.file(join(web, "src/components/dashboard/viewer/viewer.tsx")).text()
    expect(viewer).toContain('className="min-h-0 flex-1 outline-none focus-visible:bg-transparent')
  })
})

describe("the viewer's Close", () => {
  const viewer = () =>
    Bun.file(
      join(
        import.meta.dir,
        "../../../../../../../web/next/src/components/dashboard/viewer/viewer.tsx",
      ),
    ).text()

  // the Close matches the bottom bar: one square, always shown
  test("sits always shown at the top right, one square on a floating bar of its own, the bottom bar's look", async () => {
    const source = await viewer()
    expect(source).toContain('<div className={cn(FLOATING_BAR, "absolute top-2 right-2 z-10")}>')
    expect(source).not.toContain("setCorner")
  })

  // the bar's icons read one size, the chevrons a step up for their thinner glyph
  test("the bottom bar's chevrons take 20px, since their glyph fills less of its box, and its cross reads 16px as every other icon", async () => {
    const source = await viewer()
    expect(source).toContain('<RiArrowLeftSLine className="size-5" />')
    expect(source).toContain('<RiArrowRightSLine className="size-5" />')
    expect(source).not.toContain('<RiCloseLine className="size-5" />')
  })
})

// #1716: the full-screen viewer's bar holds the page bars' squares in their order, each named in a tooltip
describe("the viewer's bar", () => {
  const viewer = () =>
    Bun.file(
      join(
        import.meta.dir,
        "../../../../../../../web/next/src/components/dashboard/viewer/viewer.tsx",
      ),
    ).text()

  test("holds the name, then Download, Open in new tab, Open in side panel from the aside, and Close", async () => {
    const source = await viewer()
    const at = (part: string) => {
      const index = source.indexOf(part)
      expect(index).toBeGreaterThan(-1)
      return index
    }
    const order = [
      at("<DialogTitle className={BAR_NAME}>"),
      at("<Download item={item} />"),
      at("<OpenInNewTab item={item} keepRoom />"),
      at("<SidePanel onClick={() => onSidePanel(item)} />"),
      at('<Hint content="Close" description={null}>'),
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  // the stock Dialog closes on Escape, and a page in its frame sends Escape out to it
  test("Escape closes it, from the page too", async () => {
    const source = await viewer()
    expect(source).not.toContain("onEscapeKeyDown")
    const documents = await Bun.file(
      join(
        import.meta.dir,
        "../../../../../../../web/next/src/components/dashboard/viewer/documents.tsx",
      ),
    ).text()
    expect(documents).toContain('message?.viewer === "escape"')
  })
})
