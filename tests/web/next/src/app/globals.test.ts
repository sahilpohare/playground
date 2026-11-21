import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

const REPO = join(import.meta.dir, "../../../../..")
const SRC = join(REPO, "web/next/src")
const CSS = join(SRC, "app/globals.css")

// Status colours are Tailwind's 500 in dark mode and 600 in light.
const STATUS_TOKENS = ["bravo", "caution", "destructive", "inactive", "info", "success", "warning"]

const block = (css: string, selector: string): string =>
  css.match(new RegExp(`^${selector.replace(".", "\\.")} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? ""

// A token's palette colour in one mode, as `var(--color-<hue>-<shade>)`, or null when it is anything else.
const shadeOf = (body: string, token: string) => {
  const match = body.match(new RegExp(`--${token}: var\\(--color-([a-z]+)-(\\d+)\\);`))
  return match ? { hue: match[1], shade: match[2] } : null
}

const stripComments = (text: string) =>
  text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm,
    (_, literal?: string, lead?: string) => literal ?? lead ?? "",
  )

describe("status colours", () => {
  test("each status token is Tailwind's 600 of its hue in light mode and 500 in dark", async () => {
    const css = await Bun.file(CSS).text()
    const light = block(css, ":root")
    const dark = block(css, ".dark")
    for (const token of STATUS_TOKENS) {
      const day = shadeOf(light, token)
      const night = shadeOf(dark, token)
      expect({ token, day, night }).toEqual({
        token,
        day: { hue: night?.hue ?? "", shade: "600" },
        night: { hue: day?.hue ?? "", shade: "500" },
      })
    }
  })

  test("no component hard-codes a shade of a status hue, so every status colour goes through a token", async () => {
    const css = await Bun.file(CSS).text()
    const hues = STATUS_TOKENS.map((token) => shadeOf(block(css, ":root"), token)?.hue)
    expect(hues.every(Boolean)).toBe(true)
    const shade = new RegExp(`[\\w-]*[a-z]-(?:${hues.join("|")})-\\d{2,3}\\b`, "g")
    const hits: string[] = []
    for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ absolute: true, cwd: SRC })) {
      const code = stripComments(await Bun.file(path).text())
      for (const [found] of code.matchAll(shade)) hits.push(`${relative(SRC, path)}: ${found}`)
    }
    expect(hits).toEqual([])
  })
})

describe("code text", () => {
  test("code turns the mono font's ligatures off, so `-<` shows as typed (#2337)", async () => {
    const css = await Bun.file(CSS).text()
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      body: body ?? "",
      selectors: (selector ?? "").split(",").map((part) => part.trim()),
    }))
    const off = rules
      .filter(({ body }) => /font-variant-ligatures:\s*none/.test(body))
      .flatMap(({ selectors }) => selectors)
    expect(["code", "kbd", "pre", "samp"].filter((tag) => !off.includes(tag))).toEqual([])
  })
})
