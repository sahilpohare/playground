import type { BundledRow, ExtensionRow } from "@api/hono"

export type { BundledRow, ExtensionRow }

// An answer's data, or its error thrown with the API's own words.
export const answer = async <R extends { data: unknown; error: { message: string } | null }>(
  call: Promise<R>,
): Promise<NonNullable<R["data"]>> => {
  const { data, error } = await call
  if (error) throw new Error(error.message)
  return data as NonNullable<R["data"]>
}

export const EXTENSIONS_QUERY_KEY = ["extensions"] as const

export const BUNDLED_QUERY_KEY = ["extensions", "bundled"] as const

// What each bundled extension's card says, by its name under extensions/.
export const BUNDLED_WORDS: Record<string, { description: string; title: string }> = {
  slack: {
    description: "Your Slack DM with the factory: sessions post replies there and read yours back.",
    title: "Slack",
  },
  whatsapp: {
    description: "WhatsApp mode: text the factory from your phone and get its replies there.",
    title: "WhatsApp",
  },
}

export const EXTENSION_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/
export const ORG = /^(?:\*|[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/
export const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

const KINDS = [
  ["skill", "skills"],
  ["rule", "rules"],
  ["list", "lists"],
] as const

// Pure: an extension's items as one line, each kind counted, none included: "2 skills · 1 rule · 0 lists".
export const countsLine = (counts: Record<string, number>): string =>
  KINDS.map(([one, many]) => {
    const n = counts[one] ?? 0
    return `${n} ${n === 1 ? one : many}`
  }).join(" · ")

// Pure: a link as a chip reads it, * as everywhere.
export const linkWords = (link: string): string => (link === "*" ? "everywhere" : link)

// Pure: the names in the order a drag leaves them, core never among them, since it stays last.
export const movedNames = (rows: ExtensionRow[], from: string, to: string): string[] => {
  const names = rows.filter((row) => row.name !== "core").map((row) => row.name)
  const at = names.indexOf(from)
  const into = names.indexOf(to)
  if (at < 0 || into < 0 || at === into) return names
  const next = [...names]
  next.splice(into, 0, ...next.splice(at, 1))
  return next
}

// Pure: Why's answer as its lines, each extension by its place in the order: where the skill loads from, the copies it hides, and core's part when it has none.
export const whyLines = (
  rows: ExtensionRow[],
  found: { from: string; shadowed: string[] },
): { from: string; hides: string | null; core: string | null } => {
  const placed = (name: string) => {
    const at = rows.findIndex((row) => row.name === name)
    return at < 0 ? name : `${at + 1} ${name}`
  }
  return {
    core: found.from === "core" || found.shadowed.includes("core") ? null : "core has none",
    from: placed(found.from),
    hides: found.shadowed.length ? found.shadowed.map(placed).join(" · ") : null,
  }
}
