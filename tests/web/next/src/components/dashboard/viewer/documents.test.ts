import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  CODE_VIEWER,
  DOC_VIEWER,
  HTML_VIEWER,
  PageFrame,
  PDF_VIEWER,
} from "../../../../../../../web/next/src/components/dashboard/viewer/documents"
import { VIEWERS } from "../../../../../../../web/next/src/components/dashboard/viewer/registry"

// React resolves from the web app's own packages, which this directory cannot see; the calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
const web = join(import.meta.dir, "../../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: (type: unknown, props?: unknown) => Node
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}

const render = (viewer: typeof HTML_VIEWER, name: string) =>
  renderToStaticMarkup(
    createElement(viewer.View, {
      active: true,
      item: { id: "0b9c6f1e-1111-4111-8111-000000000001.html", kind: "html", name },
      onEdge: () => {},
      url: "blob:https://desk.playground.localhost/1",
    }),
  )

describe("the document viewers", () => {
  test("each non-image kind is turned on in the registry", () => {
    expect(VIEWERS.code).toBe(CODE_VIEWER)
    expect(VIEWERS.doc).toBe(DOC_VIEWER)
    expect(VIEWERS.html).toBe(HTML_VIEWER)
    expect(VIEWERS.pdf).toBe(PDF_VIEWER)
  })

  test("an HTML page's frame waits for its text, since a frame given srcdoc after an empty one can stay blank", () => {
    const html = render(HTML_VIEWER, "report.html")
    expect(html).not.toContain("<iframe")
    expect(html).toContain('role="status"')
  })

  test("an HTML page runs in a frame that allows its own script and nothing else", () => {
    const html = renderToStaticMarkup(
      createElement(PageFrame, { name: "report.html", page: "<p>hi</p>" }),
    )
    expect(html).toContain('sandbox="allow-scripts"')
    // no same-origin, ever: on the hosted build the frame's scripts carry the Dashboard page's nonce (asViewerPage), which an opaque origin keeps from the Dashboard's storage
    expect(html).not.toContain("allow-same-origin")
    expect(html).toContain('aria-label="report.html"')
    // handed in as srcdoc, never as its blob's URL, which a new tab would run with the Dashboard's origin
    expect(html).toContain("srcDoc=")
    // with its own fetch policy, since no response header reaches a srcdoc page
    expect(html).toContain("Content-Security-Policy")
    expect(html).not.toContain(" src=")
    expect(html).toContain("data-viewer-owns-pointer")
  })

  test("a PDF opens in an unsandboxed frame, where the browser's own viewer loads", () => {
    const html = render(PDF_VIEWER, "report.pdf")
    expect(html).toContain("<iframe")
    expect(html).not.toContain("sandbox")
  })

  test("a doc and a code file scroll on their own and keep Up and Down for it", () => {
    for (const viewer of [DOC_VIEWER, CODE_VIEWER]) {
      const html = render(viewer, "notes.md")
      expect(html).toContain('role="region"')
      expect(html).toContain('tabindex="0"')
      expect(html).toContain("data-viewer-owns-keys")
    }
  })

  // a reviewer: its own fill outranks the muted focus fill, so it tints as a focused pane does, opaque over the stage
  test("a doc and a code file show their focus with no ring", () => {
    for (const viewer of [DOC_VIEWER, CODE_VIEWER])
      expect(render(viewer, "notes.md")).toContain(
        "focus-visible:bg-[color-mix(in_oklab,var(--foreground)_4%,var(--background))]",
      )
  })
})
