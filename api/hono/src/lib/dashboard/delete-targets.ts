import { join, resolve } from "node:path"

// What the check reads on this machine: the poster's folder and home, the main checkout's worktrees folder (null outside a checkout), and whether a path is there.
export type TargetDeps = {
  cwd: string
  exists: (path: string) => boolean
  home: string
  worktrees: string | null
}

// Pure: each word of a delete's what, stripped of the quotes and punctuation around it.
export const targetWords = (what: string): string[] =>
  what
    .split(/\s+/)
    .map((word) => word.replace(/^[`'"(]+|[`'",.;:)]+$/g, "").replace(/(.)\/$/, "$1"))
    .filter((word) => word !== "")

// The targets a delete's what names by a short name, each with the full path to write: a relative or ~ path that is there, or a worktree's bare folder name (a word of dots alone, as a stray ./, is prose), unless that full path stands in the what beside it.
export function shortTargets(what: string, deps: TargetDeps): { full: string; word: string }[] {
  const words = targetWords(what)
  const named = new Set(words.filter((word) => word.startsWith("/")))
  const short: { full: string; word: string }[] = []
  for (const word of words) {
    if (word.startsWith("/") || /^\.+$/.test(word) || /^[a-z][a-z\d+.-]*:/i.test(word)) continue
    const full =
      word === "~" || word.startsWith("~/")
        ? join(deps.home, word.slice(1))
        : word.includes("/")
          ? resolve(deps.cwd, word)
          : deps.worktrees === null
            ? null
            : join(deps.worktrees, word)
    if (full !== null && !named.has(full) && deps.exists(full)) short.push({ full, word })
  }
  return short
}

// Why ask refuses a delete decision, or null: one whose what names a target by a short name, each named with its full path to write.
export function deleteRefusal(input: unknown, deps: TargetDeps): string | null {
  if (typeof input !== "object" || input === null) return null
  const preview = (input as { preview?: unknown }).preview
  if (typeof preview !== "object" || preview === null) return null
  const { type, what } = preview as { type?: unknown; what?: unknown }
  if (type !== "delete" || typeof what !== "string") return null
  const short = shortTargets(what, deps)
  if (short.length === 0) return null
  return `a delete names each target by its full path, so the owner approves the very path that goes: ${short.map(({ full, word }) => `write ${full} for ${word}`).join("; ")}`
}
