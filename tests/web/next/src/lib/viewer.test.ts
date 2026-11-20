import { describe, expect, test } from "bun:test"

import {
  asViewerPage,
  documentNonce,
  fenced,
  frameLoad,
  viewerFrameMessage,
} from "../../../../../web/next/src/lib/viewer"

describe("viewerFrameMessage", () => {
  test("takes only the viewer's own messages", () => {
    expect(viewerFrameMessage({ viewer: "escape" })).toEqual({ viewer: "escape" })
    expect(viewerFrameMessage({ direction: -1, viewer: "edge" })).toEqual({
      direction: -1,
      viewer: "edge",
    })
    expect(viewerFrameMessage({ direction: 2, viewer: "edge" })).toBeNull()
    expect(viewerFrameMessage({ viewer: "edge" })).toBeNull()
    expect(viewerFrameMessage("escape")).toBeNull()
    expect(viewerFrameMessage(null)).toBeNull()
    expect(viewerFrameMessage({ viewer: "ready" })).toEqual({ viewer: "ready" })
  })

  test("takes a link to open only when it goes to the web", () => {
    expect(viewerFrameMessage({ href: "https://example.com/a", viewer: "link" })).toEqual({
      href: "https://example.com/a",
      viewer: "link",
    })
    for (const href of ["javascript:alert(1)", "data:text/html,hi", "about:srcdoc", "nope", 1]) {
      expect(viewerFrameMessage({ href, viewer: "link" })).toBeNull()
    }
  })
})

describe("frameLoad", () => {
  test("keeps the page that said it was ready", () => {
    expect(frameLoad(true, false)).toBe("keep")
    expect(frameLoad(true, true)).toBe("keep")
  })

  test("puts the page back once when another took its place, a redirect before its own load included", () => {
    expect(frameLoad(false, false)).toBe("restore")
  })

  test("stops on the second, so a page that leaves on every load sends one more request, not one a pass", () => {
    expect(frameLoad(false, true)).toBe("stop")
  })
})

describe("fenced", () => {
  test("names the block's language by the file's extension", () => {
    expect(fenced("query.TS", "const a = 1")).toBe("```ts\nconst a = 1\n```")
    expect(fenced("Makefile", "all:")).toBe("```\nall:\n```")
  })

  test("outruns every backtick run in the file, so none closes the block", () => {
    expect(fenced("notes.py", 'x = """\n```\n"""')).toBe('````py\nx = """\n```\n"""\n````')
  })
})

type Key = Partial<KeyboardEvent> & { key: string }

// The appended script run against a stand-in page: its listeners, the messages it posts and how far the page scrolls sideways.
function page(scroll = { clientWidth: 800, scrollLeft: 0, scrollWidth: 800 }) {
  const served = asViewerPage("<p>hi</p>")
  const script = /<script>([\s\S]*)<\/script>$/.exec(served)?.[1] ?? ""
  const listeners: [string, (event: Key) => void][] = []
  const posted: unknown[] = []
  const scrolled: string[] = []
  const element = (id: string) => ({ scrollIntoView: () => scrolled.push(id) })
  // the page's own changes, as the script's MutationObserver hears them, and the frames it waits for
  let changed = () => {}
  let frames: (() => void)[] = []
  class Observer {
    constructor(callback: () => void) {
      changed = callback
    }
    observe() {}
  }
  new Function(
    "addEventListener",
    "parent",
    "document",
    "scrollTo",
    "MutationObserver",
    "requestAnimationFrame",
    script,
  )(
    (type: string, listener: (event: Key) => void) => listeners.push([type, listener]),
    { postMessage: (message: unknown) => posted.push(message) },
    {
      baseURI: "https://desk.playground.localhost/dashboard",
      getElementById: (id: string) => (id === "p95" || id === "%E0" ? element(id) : null),
      getElementsByName: (name: string) => (name === "old" ? [element(name)] : []),
      scrollingElement: scroll,
    },
    () => scrolled.push("top"),
    Observer,
    (frame: () => void) => frames.push(frame),
  )
  const fire = (type: string, event: Key, page?: () => void) => {
    for (const [on, listener] of listeners) if (on === type) listener(event)
    page?.()
    for (let pass = 0; pass < 3; pass++) {
      const due = frames
      frames = []
      for (const frame of due) frame()
    }
    return posted.splice(0).map(viewerFrameMessage)
  }
  // a key, and what the page's own listeners do with it: a deck that moves its slide changes the page
  const press = (event: Key, moves = false) => fire("keydown", event, moves ? changed : undefined)
  // a click on a link: its href as written, and as the browser resolves it
  const click = (
    written: string,
    resolved: string | { baseVal: string } = written,
    defaultPrevented = false,
  ) => {
    let prevented = defaultPrevented
    const link = { getAttribute: () => written, href: resolved }
    const sent = fire("click", {
      defaultPrevented,
      key: "",
      preventDefault: () => {
        prevented = true
      },
      target: { closest: () => link } as never,
    })
    return { prevented, sent }
  }
  const load = () => fire("load", { key: "" })
  return { click, load, press, scrolled, served }
}

// a nonce as the hosted proxy makes it: the base64 of a UUID, 48 characters with no padding
const NONCE = "MGI5YzZmMWUtMTExMS00MTExLTgxMTEtMDAwMDAwMDAwMDAx"

describe("asViewerPage", () => {
  // the hosted build's page CSP reaches a srcdoc frame too, so each script in it carries the page's nonce to run; the frame's sandbox, with no same-origin (documents.test.ts), keeps the nonce from the Dashboard's storage
  test("on the hosted build, every script in the page and the keys script carries the page's nonce", () => {
    const served = asViewerPage(
      "<p>hi</p><script>a()</script><SCRIPT src=x></SCRIPT><script/><scripts><script-card></script-card>",
      NONCE,
    )
    expect(served.match(new RegExp(`<script nonce=${NONCE} `, "gi"))?.length).toBe(4)
    // a tag the nonce cannot run into: a self-closing slash stays its own, and another element named script-something stays itself
    expect(served).toContain(`<script nonce=${NONCE} />`)
    expect(served).toContain(`<script nonce=${NONCE}  src=x></SCRIPT>`)
    expect(served).toContain("<scripts><script-card></script-card>")
  })

  // the nonce goes in unquoted, as base64 with no padding needs no quotes, so a script's own string that names a script tag stays one string
  test("a script tag named inside a page's own string leaves that string whole", () => {
    const served = asViewerPage(
      `<script>const tag = "<script>"; const other = '<script>'</script>`,
      NONCE,
    )
    expect(served).toContain(
      `const tag = "<script nonce=${NONCE} >"; const other = '<script nonce=${NONCE} >'`,
    )
  })

  test("with no nonce, as on the local build, the page is served as before", () => {
    const html = "<p>hi</p><script>a()</script>"
    expect(asViewerPage(html, undefined)).toBe(asViewerPage(html))
    expect(asViewerPage(html)).not.toContain("nonce")
  })

  test("puts the policy ahead of the page's own markup, since no header reaches a srcdoc page", () => {
    const served = page().served
    expect(served).toStartWith(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';',
    )
    expect(served).toContain(
      "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    )
    expect(served).not.toContain("connect-src")
    expect(served).toContain('"><p>hi</p>\n<script>')
  })

  test("keeps the page's doctype first, so it stays in standards mode", () => {
    expect(asViewerPage("<!DOCTYPE html><html><p>hi</p></html>")).toStartWith(
      '<!DOCTYPE html><meta http-equiv="Content-Security-Policy"',
    )
  })

  test("puts the policy first on a page that opens with anything but its doctype, so it always lands in the head", () => {
    for (const html of [
      "<!-- a --><body><img><script>fetch('https://example.com')</script><!-- b --><!doctype html>",
      "<!--><!doctype html><p>hi</p>",
      "<!---><!doctype html><p>hi</p>",
      "<!-- a --!><!doctype html><p>hi</p>",
    ]) {
      expect(asViewerPage(html)).toStartWith('<meta http-equiv="Content-Security-Policy"')
    }
  })

  test("sends Escape, which closes the viewer", () => {
    expect(page().press({ key: "Escape" })).toEqual([{ viewer: "escape" }])
  })

  test("hands Left and Right back when the page leaves them alone", () => {
    const { press } = page()
    expect(press({ key: "ArrowLeft" })).toEqual([{ direction: -1, viewer: "edge" }])
    expect(press({ key: "ArrowRight" })).toEqual([{ direction: 1, viewer: "edge" }])
  })

  test("leaves the page its own keys", () => {
    const { press } = page()
    expect(press({ key: "ArrowDown" })).toEqual([])
    expect(press({ key: "Tab" })).toEqual([])
    expect(press({ defaultPrevented: true, key: "ArrowRight" })).toEqual([])
    expect(press({ key: "ArrowLeft", target: { tagName: "INPUT" } as never })).toEqual([])
    expect(press({ key: "ArrowRight", metaKey: true })).toEqual([])
  })

  test("hands a clicked link to the viewer, so the frame stays on the page", () => {
    expect(page().click("https://github.com/o/r/pull/1")).toEqual({
      prevented: true,
      sent: [{ href: "https://github.com/o/r/pull/1", viewer: "link" }],
    })
  })

  test("hands an SVG link over too, whose href is no string", () => {
    expect(
      page().click("https://example.com/a", { baseVal: "https://example.com/a" }).sent,
    ).toEqual([{ href: "https://example.com/a", viewer: "link" }])
  })

  test("says the page is ready once it has loaded, which a page it was sent off to never says", () => {
    expect(page().load()).toEqual([{ viewer: "ready" }])
  })

  test("scrolls to a place on the page itself, since a srcdoc page would load again", () => {
    const viewer = page()
    expect(viewer.click("#p95", "about:srcdoc#p95")).toEqual({ prevented: true, sent: [] })
    viewer.click("#old", "about:srcdoc#old")
    viewer.click("#", "about:srcdoc#")
    viewer.click("#nowhere", "about:srcdoc#nowhere")
    // a name that is no valid escape is looked up as written
    viewer.click("#%E0", "about:srcdoc#%E0")
    expect(viewer.scrolled).toEqual(["p95", "old", "top", "%E0"])
  })

  test("leaves a link the page took itself alone", () => {
    expect(page().click("https://example.com/", undefined, true)).toEqual({
      prevented: true,
      sent: [],
    })
  })

  test("leaves Left and Right to a deck that moves its slide on them without taking the key", () => {
    const { press } = page()
    expect(press({ key: "ArrowRight" }, true)).toEqual([])
    expect(press({ key: "ArrowLeft" }, true)).toEqual([])
    // its last slide changes nothing, so the key goes on to the next attachment
    expect(press({ key: "ArrowRight" })).toEqual([{ direction: 1, viewer: "edge" }])
  })

  test("scrolls a wide page sideways before handing the key back", () => {
    const { press } = page({ clientWidth: 800, scrollLeft: 100, scrollWidth: 1200 })
    expect(press({ key: "ArrowLeft" })).toEqual([])
    expect(press({ key: "ArrowRight" })).toEqual([])
  })
})

describe("documentNonce", () => {
  test("reads the nonce the Dashboard's own scripts carry, and none where they carry none or there is no document", () => {
    const doc = (nonce?: string) => ({
      querySelector: (selector: string) =>
        selector === "script[nonce]" && nonce ? { nonce } : null,
    })
    expect(documentNonce(doc("bm9uY2U="))).toBe("bm9uY2U=")
    expect(documentNonce(doc())).toBeUndefined()
    expect(documentNonce(undefined)).toBeUndefined()
  })
})
