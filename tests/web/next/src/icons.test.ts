import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const REPO = join(import.meta.dir, "../../../..")
const SRC = join(REPO, "web/next/src")

// Every icon in the app comes from Remix icons, so they share one look.
const REMIX = "@remixicon/react"

// Icon sets known by a name that does not say icon; any other package whose name holds "icon" is caught by that word.
const ICON_PACKAGES = /^(?:@fortawesome\/|lucide(?:-react)?|react-feather)/

// Where an <svg> is drawn on purpose: the shared ui kit (charts included), which shadcn owns. A content SVG (a logo, a diagram) outside it is listed here by its path under web/next/src, with why.
const SVG_ALLOWED: string[] = [
  // Each model maker's icon the API serves (useMakerIcon), which Remix does not carry.
  "components/dashboard/model-logo.tsx",
  // Pierre Icons' file-type marks on the Inbox's file tiles, duo-tone in its palette, which Remix does not carry.
  "components/dashboard/viewer/file-icons.tsx",
]

// Comments go and string literals stay whole, so a "/*" or "//" inside a string hides no code after it.
const stripComments = (text: string) =>
  text.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm,
    (_, literal?: string, lead?: string) => literal ?? lead ?? "",
  )

// A package an import, re-export, import() or require() names, never a module of the app's own (@/, a relative path or node:).
const packagesIn = (code: string): string[] =>
  [
    ...code.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm,
    ),
  ]
    .map(([, specifier]) => specifier ?? "")
    .filter((specifier) => !/^(?:@\/|\.|node:)/.test(specifier))

const isOtherIconPackage = (specifier: string): boolean =>
  specifier !== REMIX &&
  !specifier.startsWith(`${REMIX}/`) &&
  (ICON_PACKAGES.test(specifier) || /icon/i.test(specifier))

// An emoji as it draws: one that shows as emoji by default, or any pictograph asked to with U+FE0F. A symbol that draws as text (™, ↔, ✓) passes, as the board parser's plainText() keeps it.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u

// The words a person reads: every string literal, and in a .tsx file every run of JSX text with its {expressions} taken out.
const copyIn = (code: string, jsx: boolean): string[] => [
  ...[...code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map(
    ([literal]) => literal.slice(1, -1),
  ),
  ...(jsx
    ? [...code.matchAll(/>([^<>]*)</g)].map(([, inner]) =>
        (inner ?? "").replace(/\{[^{}]*\}/g, " "),
      )
    : []),
]

const drawsSvg = (code: string) => /<svg[\s>/]|createElement\(\s*["']svg["']/.test(code)

type Hit = { file: string; what: string }

const scan = async (): Promise<{ emoji: Hit[]; packages: Hit[]; svg: Hit[] }> => {
  const emoji: Hit[] = []
  const packages: Hit[] = []
  const svg: Hit[] = []
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
    if (file.startsWith("components/ui/")) continue
    const code = stripComments(await Bun.file(join(SRC, file)).text())
    for (const specifier of packagesIn(code))
      if (isOtherIconPackage(specifier)) packages.push({ file, what: specifier })
    if (file.endsWith(".tsx") && drawsSvg(code) && !SVG_ALLOWED.includes(file))
      svg.push({ file, what: "<svg>" })
    for (const copy of copyIn(code, file.endsWith(".tsx")))
      if (EMOJI.test(copy)) emoji.push({ file, what: copy.trim().slice(0, 60) })
  }
  return { emoji, packages, svg }
}

describe("icons come from Remix alone", async () => {
  const hits = await scan()

  test("no file outside the ui kit imports another icon set", () => {
    expect(hits.packages).toEqual([])
  })

  test("no file outside the ui kit draws its own <svg>", () => {
    expect(hits.svg).toEqual([])
  })

  test("no copy a person reads holds an emoji", () => {
    expect(hits.emoji).toEqual([])
  })

  test("the web app depends on no icon set but Remix", async () => {
    const { dependencies = {}, devDependencies = {} } = await Bun.file(
      join(REPO, "web/next/package.json"),
    ).json()
    const names = Object.keys({ ...dependencies, ...devDependencies })
    expect(names.filter(isOtherIconPackage)).toEqual([])
    expect(names).toContain(REMIX)
  })

  test("every allowed SVG still draws one, so the list never goes stale", async () => {
    for (const file of SVG_ALLOWED)
      expect(drawsSvg(stripComments(await Bun.file(join(SRC, file)).text()))).toBe(true)
  })
})

describe("the rules", () => {
  test("another icon set is caught however it is named or loaded", () => {
    for (const specifier of [
      "@fortawesome/react-fontawesome",
      "@heroicons/react/24/solid",
      "@mui/icons-material",
      "@phosphor-icons/react",
      "@radix-ui/react-icons",
      "@tabler/icons-react",
      "lucide-react",
      "react-feather",
      "react-icons/fa",
    ])
      expect(isOtherIconPackage(specifier)).toBe(true)
    expect(
      packagesIn(
        'import { X } from "lucide-react"\nexport { Y } from "react-icons/fa"\nconst z = await import("@tabler/icons-react")\nrequire("@heroicons/react")\nimport "react-feather"',
      ).filter(isOtherIconPackage),
    ).toEqual([
      "lucide-react",
      "react-icons/fa",
      "@tabler/icons-react",
      "@heroicons/react",
      "react-feather",
    ])
  })

  test("a comment opener inside a string hides no code after it", () => {
    const code = 'const a = "text/*"\nimport { X } from "lucide-react"\nconst b = "*/" // note'
    expect(packagesIn(stripComments(code))).toEqual(["lucide-react"])
    expect(stripComments('const u = "https://x" // why')).toBe('const u = "https://x" ')
  })

  test("Remix and the app's own icon modules pass", () => {
    expect(isOtherIconPackage(REMIX)).toBe(false)
    expect(packagesIn('import { A } from "@/components/dashboard/agent-state-icon"')).toEqual([])
    expect(packagesIn('import { B } from "./icons"')).toEqual([])
  })

  test("an inline <svg> is caught, a word that only starts with svg is not", () => {
    expect(drawsSvg('<svg viewBox="0 0 24 24"><path d="M0 0" /></svg>')).toBe(true)
    expect(drawsSvg("<svg\n  className='size-4'>")).toBe(true)
    expect(drawsSvg('createElement("svg", null)')).toBe(true)
    expect(drawsSvg("<svgImage />")).toBe(false)
  })

  test("an emoji is caught; a symbol that draws as text is not", () => {
    for (const copy of ["Done ✅", "Fast ⚡", "🔥 hot", "CI ❌", "Warn \u26A0\uFE0F"])
      expect(EMOJI.test(copy)).toBe(true)
    for (const copy of ["Acme™", "A ↔ B", "✓ ok", "© 2026", "5/5 · CI green"])
      expect(EMOJI.test(copy)).toBe(false)
    expect(copyIn("const a = <p>Shipped 🚀</p>", true)).toContain("Shipped 🚀")
  })
})
