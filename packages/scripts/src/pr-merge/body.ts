// A PR body's shape, which ops-checks, merge-on-ready and pr:merge's Checks gate each read.

// Pure: each line's ## heading, lowercased with TLDR read as TL;DR, or "" for a line that is none; a heading inside a code fence is a sample, not a section.
function headingsOf(lines: string[]): string[] {
  let fenced = false
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
    return fenced
      ? ""
      : (/^##\s+(.+?)\s*$/
          .exec(line)?.[1]
          ?.toLowerCase()
          .replace(/^tldr$/, "tl;dr") ?? "")
  })
}

// Pure: whether a PR body is the PR template: a TL;DR of 2 sentences or more first, its bullets or its prose, then the pr skill's Summary, Evidence and Merge Danger, then Links, each a heading of its own, in that order; a TL;DR may open with an `Outcome:` label.
export function templateBody(body: string): boolean {
  const lines = body.split(/\r?\n/).filter((line) => line.trim())
  const headings = headingsOf(lines)
  const at = ["tl;dr", "summary", "evidence", "merge danger", "links"].map((name) =>
    headings.indexOf(name),
  )
  const end = at[1] ?? -1
  // a bullet is a sentence of its own, its closing stop optional
  const tldr = lines
    .slice(1, end)
    .map(
      (line) =>
        /^\s*[-*+]\s+(.*)$/
          .exec(line)?.[1]
          ?.replace(/\s*$/, "")
          .replace(/(?<![.!?])$/, ".") ?? line,
    )
    .join(" ")
    .replace(/^\**Outcome\**\s*:\**\s*/, "")
  const sentences = tldr.match(/[^.!?]*\w[^.!?]*[.!?](?=\s|$)/g)?.length ?? 0
  return at[0] === 0 && at.every((i, k) => k === 0 || i > (at[k - 1] ?? -1)) && sentences >= 2
}

// Pure: the Outcome label a line of a body's TL;DR opens with, up to its next ## heading, a bullet's, a numbered item's, a quote's or a bold one included, else null.
export function tldrLabel(body: string): string | null {
  const lines = body.split(/\r?\n/)
  const at = lines.findIndex((line) => /^##\s+tl;?dr\s*$/i.test(line))
  if (at === -1) return null
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(line)) break
    const label = /^\s*(?:(?:[-*+>]|\d+[.)])\s*)?(?:\*\*|__)?(Outcome)(?:\*\*|__)?\s*:/i.exec(
      line,
    )?.[1]
    if (label) return label
  }
  return null
}

// Pure: the text of a body's section by its lowercased heading, up to its next ## heading, each read as templateBody reads them.
function sectionOf(body: string, name: string): string {
  const lines = body.split(/\r?\n/)
  const headings = headingsOf(lines)
  const at = headings.indexOf(name)
  if (at === -1) return ""
  const end = headings.findIndex((heading, i) => i > at && heading !== "")
  return lines.slice(at + 1, end === -1 ? undefined : end).join("\n")
}

const evidenceOf = (body: string): string => sectionOf(body, "evidence")

// Pure: whether a body's Links holds a line opening `Owner ask:`, as a bullet or in bold, that names the owner's ask: an Inbox #i id, a PG issue or the owner's quoted words (the release rule's ship-now).
export const ownerAsk = (body: string): boolean =>
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?Owner ask:(?:\*\*|__)?\s*(?:#i\d+|PG-\d+|"[^"]+"|“[^”]+”)/im.test(
    sectionOf(body, "links"),
  )

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Pure: each changed doc (a *.md path) that a body's Evidence leaves out, a path counting as named where its full repo-relative path stands whole in that section's text.
export function unnamedDocs(body: string, files: string[]): string[] {
  const evidence = evidenceOf(body)
  return files.filter(
    (path) =>
      /\.md$/i.test(path) &&
      !new RegExp(`(?<![\\w./-])${escaped(path)}(?![\\w/-]|\\.\\w)`).test(evidence),
  )
}

// Pure: whether a body's Evidence holds a line that opens with A/B:, as a bullet, in bold or as plain text, outside a code fence: the PR's measured comparison, A and B against the bar, or No runtime metric and the check that stands in.
export function abLine(body: string): boolean {
  let fenced = false
  return evidenceOf(body)
    .split(/\r?\n/)
    .some((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
      return !fenced && /^\s*(?:[-*+]\s+)?(?:\*\*|__)?A\/B(?::(?:\*\*|__)?|(?:\*\*|__):)/.test(line)
    })
}

// An inline code span, which the gate reads past as code, never as prose.
const CODE_SPAN = /(`+)[^`\n]*?\1/g

// Pure: the first Evidence line whose prose, outside a code fence and inline code, holds the word TBD in any case, trimmed, else null.
export function tbdLine(body: string): string | null {
  let fenced = false
  for (const line of evidenceOf(body).split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /\btbd\b/i.test(line.replace(CODE_SPAN, " "))) return line.trim()
  }
  return null
}

// Pure: the pr template's own placeholders, each <...> inside the first markdown fence of its SKILL.md (extensions/core/skills/pr/SKILL.md), read from the file so the gate holds no copy.
export function templatePlaceholders(skill: string): string[] {
  const fence = /^```markdown\n([\s\S]*?)^```$/m.exec(skill)?.[1] ?? ""
  return [...new Set(fence.match(/<[^<>\n]+>/g) ?? [])]
}

// Pure: a body's text outside code fences and inline code, where a placeholder would be read as prose.
function proseOf(body: string): string {
  let fenced = false
  return body
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced
        return false
      }
      return !fenced
    })
    .join("\n")
    .replace(CODE_SPAN, " ")
}

const BARE_TOKEN = /(?<![\w-])[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9](?![\w-])/g

// Pure: each bare all-caps token with an underscore in a text that is already prose, once.
const tokensIn = (prose: string): string[] => [...new Set(prose.match(BARE_TOKEN) ?? [])]

// Pure: each bare all-caps token with an underscore in a body's prose (SUITE_LINE), once, the shape a fill token left unfilled takes.
export const bareTokens = (body: string): string[] => tokensIn(proseOf(body))

// Pure: why the gate refuses a PR's body, or null when it takes it: the PR template, its TL;DR holding no Outcome label line, its Evidence holding an A/B line and no TBD (tbdLine), its prose holding no unfilled placeholder (the template's own, or a bare all-caps token in unfound, which no file at the head holds outside the gate's own folders), and its Evidence naming each changed doc in files (.agents/shipping.md).
export function bodyRefusal(
  body: string,
  files: string[] = [],
  { placeholders = [], unfound = [] }: { placeholders?: string[]; unfound?: string[] } = {},
): string | null {
  const label = tldrLabel(body)
  if (label) {
    return `its body's TL;DR holds a line labelled "${label}:", which the pr skill's template (extensions/core/skills/pr/SKILL.md) leaves out; delete that line`
  }
  if (!templateBody(body)) {
    return "its body needs the PR template: a TL;DR of 2 sentences or more, the pr skill's Summary, Evidence and Merge Danger, then Links (extensions/core/skills/pr/SKILL.md)"
  }
  if (!abLine(body)) {
    return "its body's Evidence holds no A/B line: open one with `A/B:` and give A and B against the bar (`A/B: <metric>, A canary <value>, B branch <value>, n=<N>`), or `A/B: No runtime metric` and the check that stands in"
  }
  const tbd = tbdLine(body)
  if (tbd) {
    return `its body's Evidence holds TBD: "${tbd}"; write what was measured, or say what is pending and when`
  }
  const prose = proseOf(body)
  const unfilled = [
    ...placeholders.filter((placeholder) => prose.includes(placeholder)),
    ...tokensIn(prose).filter((token) => unfound.includes(token)),
  ]
  if (unfilled.length > 0) {
    return `its body holds ${unfilled.length === 1 ? "an unfilled placeholder" : `${unfilled.length} unfilled placeholders`}: ${unfilled.join(", ")}; fill each in, or put a real identifier in inline code (a <...> of the pr template, extensions/core/skills/pr/SKILL.md, or a bare all-caps token no file at the head holds)`
  }
  const unnamed = unnamedDocs(body, files)
  if (unnamed.length === 0) return null
  return `its body's Evidence leaves out ${unnamed.length === 1 ? "a changed doc" : `${unnamed.length} changed docs`}: ${unnamed.join(", ")}; name each by its full path with its check (.agents/shipping.md)`
}
