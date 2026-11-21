import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  drawingOf,
  initialsIcon,
  keepMakerIcon,
  readMakerIcon,
  useMakerIcon,
} from "../../../../../web/next/src/lib/model-icons"

// React and the icons resolve from web/next, which carries them; the tests folder does not.
type Node = unknown
const web = join(import.meta.dir, "../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: (type: unknown, props?: unknown) => Node
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}

const LOGO = '<svg viewBox="0 0 40 40"><path d="M26.9 9.8H22.1" fill="currentColor"/></svg>'
const svgData = `data:image/svg+xml;base64,${Buffer.from(LOGO).toString("base64")}`

const html = (type: unknown, props: unknown) => renderToStaticMarkup(createElement(type, props))

// What a row draws for a maker: the icon, or an empty mark while it is read; a maker with no icon draws its model's initials.
const Row = ({ maker }: { maker: string | null }) => {
  const Icon = useMakerIcon(maker, "Or")
  return Icon ? createElement(Icon, { className: "size-4" }) : "reading"
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("drawingOf", () => {
  test("an SVG draws as a mask over the text colour, so it stays muted in light and dark, a multi-colour one flattened to it", () => {
    const logo = html(drawingOf(svgData), { className: "size-4" })
    expect(logo).toContain(`href="${svgData}"`)
    expect(logo).toContain("<mask")
    expect(logo).toContain('fill="currentColor"')
    expect(logo).toContain('class="size-4"')
  })

  test("a full-colour image draws whole, clipped round", () => {
    const data = "data:image/png;base64,AAAA"
    const logo = html(drawingOf(data), {})
    expect(logo).toContain(`href="${data}"`)
    expect(logo).toContain("<clipPath")
    expect(logo).not.toContain("<mask")
  })
})

describe("useMakerIcon", () => {
  test("no maker draws the model's initials in a chip, never a robot; a maker not yet read keeps its place empty", () => {
    expect(html(Row, { maker: null })).toBe(html(initialsIcon("Or"), { className: "size-4" }))
    expect(html(Row, { maker: null })).not.toContain("<path")
    expect(html(Row, { maker: "never-read" })).toBe("reading")
  })

  test("the initials chip draws its two letters in the text colour on a faint square of it, in one size with the logos, and keeps one drawing for each initials", () => {
    const chip = html(initialsIcon("Or"), { className: "size-4" })
    expect(chip).toContain('data-initials="Or"')
    expect(chip).toContain(">Or</text>")
    expect(chip).toContain('fill="currentColor"')
    expect(chip).toContain('viewBox="0 0 24 24"')
    expect(chip).toContain('class="size-4"')
    expect(initialsIcon("Or")).toBe(initialsIcon("Or"))
  })

  test("a maker the API serves draws its icon, read once a page", async () => {
    const asked: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return new Response(LOGO, { headers: { "content-type": "image/svg+xml" } })
    }) as typeof fetch
    await readMakerIcon("RecursiveSI")
    await readMakerIcon("RecursiveSI")
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEndWith("/api/v1/model-icons/RecursiveSI")
    expect(html(Row, { maker: "RecursiveSI" })).toContain(`href="${svgData}"`)
  })

  test("a 404, or the API out of reach, draws the initials chip", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch
    await readMakerIcon("nobody")
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    await readMakerIcon("offline-maker")
    for (const maker of ["nobody", "offline-maker"])
      expect(html(Row, { maker })).toBe(html(initialsIcon("Or"), { className: "size-4" }))
  })

  test("a kept icon redraws every row that reads it", () => {
    keepMakerIcon("kept", drawingOf(svgData))
    expect(html(Row, { maker: "kept" })).toContain("<mask")
  })
})

// Ornith's icon, as the API serves it, models.dev's deepreinforce logo (its placeholder, a stroked sparkle), draws as the other makers' logos do: a mask in the text colour, never an image on a tile or the initials chip (PG-2662).
test("Ornith's served models.dev logo draws through the mask, with no image tile and no chip", () => {
  const placeholder =
    '<svg viewBox="0 0 24 24" fill="none"><path d="M9.8 15.9L9 18.7" stroke="currentColor"/></svg>'
  const drawn = html(
    drawingOf(`data:image/svg+xml;base64,${Buffer.from(placeholder).toString("base64")}`),
    { className: "size-4" },
  )
  expect(drawn).toContain("<mask")
  expect(drawn).toContain('fill="currentColor"')
  expect(drawn).not.toContain("clip-path")
  expect(drawn).not.toContain("data-initials")
})
