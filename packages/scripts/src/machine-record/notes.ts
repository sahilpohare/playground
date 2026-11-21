import { lstatSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import type { Entry, Kind } from "./record"

// The seed's reading of the data folder's two hand-kept notes: bundles/footprint.md's tree for one machine (each line a path, a comment its why) and that machine's undo note, bundles/<machine>-undo.md, for each path it names.

export const FOOTPRINT_NOTE = "footprint.md"
export const undoNote = (machine: string): string => `${machine}-undo.md`

const TREE = /^((?:│ {3}| {4})*)(?:├── |└── )(.+)$/
// a trailing aside the note keeps beside a name, such as "postgres:alpine (the box's runs)", which is no part of the name
const ASIDE = /\s+\([^()]*\)$/

// a name the seed takes as written: no space and no bracket, a `<...>` placeholder already read as *, and a * in its last part alone
const PLAIN_NAME = /^[^\s<>()*]*(?:\*[^\s<>()/]*)*\/?$/

export type TreePath = { comment: string; folder: boolean; path: string }

// Pure: each path the footprint tree lists under the machine whose heading line starts with its name, with the line's comment: ~/ read under home, a comma list's later item in its first item's folder unless it names a folder of its own, a `<...>` placeholder read as a glob, and `docker:` items as images (a name holding a colon) or containers. An item the seed cannot take as written (a space in it, a glob before its last part) is skipped, as the note's line has it.
export function treePaths(
  text: string,
  machine: string,
  home: string,
): { paths: TreePath[]; skipped: string[] } {
  const paths: TreePath[] = []
  const skipped: string[] = []
  let mine = false
  const parents: string[] = []
  for (const line of text.split("\n")) {
    if (/^\S/.test(line) && !TREE.test(line)) {
      mine = line.split(/\s/)[0] === machine
      parents.length = 0
      continue
    }
    const found = mine && TREE.exec(line)
    if (!found) continue
    const depth = found[1]!.length / 4
    const [names, comment = ""] = found[2]!.split(/\s+#\s*/)
    const items = names!
      .trim()
      .split(/,\s*/)
      .map((item) => item.replace(ASIDE, "").replace(/<[^<>]*>/g, "*"))
    if (depth === 0 && items[0]!.startsWith("docker:")) {
      items[0] = items[0]!.slice("docker:".length).trim()
      for (const item of items)
        if (/^[^\s*]+$/.test(item))
          paths.push({
            comment,
            folder: false,
            path: `docker ${item.includes(":") ? "image" : "container"} ${item}`,
          })
        else skipped.push(`docker ${item}`)
      continue
    }
    const first = items[0]!
    const base = depth === 0 ? "" : parents[depth - 1]!
    const at = (name: string) =>
      name === "~/" || name === "~"
        ? home
        : base
          ? join(base, name)
          : name.replace(/^~\//, `${home}/`)
    parents[depth] = at(first).replace(/\/+$/, "")
    const shared = dirname(first.replace(/\/+$/, ""))
    for (const [i, item] of items.entries()) {
      const own = i === 0 || shared === "." || item.replace(/\/+$/, "").includes("/")
      const name = own ? item : `${shared}/${item}`
      const path = at(name)
      if (!PLAIN_NAME.test(name) || /\s/.test(path)) {
        skipped.push(path)
        continue
      }
      if (path === home) continue
      paths.push({ comment, folder: item.endsWith("/"), path: path.replace(/\/+$/, "") })
    }
  }
  return { paths, skipped }
}

// Pure: the undo line of the undo note's first step that names this path, as ~/ or whole, else a pointer to both notes.
export function undoOf(text: string, path: string, home: string, machine: string): string {
  const forms = [path, path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : null]
  for (const step of text.split(/\n(?=\d+\. |## |- `)/)) {
    if (!forms.some((form) => form && step.includes(form))) continue
    const undo = step
      .split("\n")
      .map((line) => line.trim().replace(/^- /, ""))
      .find((line) => /^Undo\b/.test(line))
    if (undo) return undo
  }
  return `see bundles/${FOOTPRINT_NOTE} and bundles/${undoNote(machine)}`
}

const kindOf = (path: string, folder: boolean): Kind => {
  if (path.startsWith("docker image ")) return "image"
  if (path.startsWith("docker container ")) return "container"
  const stat = (() => {
    try {
      return lstatSync(path)
    } catch {
      return null
    }
  })()
  if (stat?.isSymbolicLink()) return "link"
  if (stat?.isDirectory()) return "folder"
  return stat ? "file" : folder ? "folder" : "file"
}

// Each path a glob's last part matches on this machine, none when nothing does or its folder is missing, so the seed never records a glob as a path; a plain path as written, so one that never was reads gone.
const expand = (path: string): string[] => {
  if (!path.includes("*")) return [path]
  try {
    return [
      ...new Bun.Glob(basename(path)).scanSync({ cwd: dirname(path), dot: true, onlyFiles: false }),
    ]
      .map((name) => join(dirname(path), name))
      .sort()
  } catch {
    return []
  }
}

// The seed's entries for one machine from the two notes' text, and each item it skipped: one it cannot take as written, or a glob nothing matches.
export function seedEntries(
  footprint: string,
  undo: string,
  machine: string,
  home: string,
  now: Date,
): { entries: Entry[]; skipped: string[] } {
  const { paths, skipped } = treePaths(footprint, machine, home)
  const entries = paths.flatMap(({ comment, folder, path }) => {
    const each = path.startsWith("docker ") ? [path] : expand(path)
    if (!each.length) skipped.push(path)
    return each.map((one) => ({
      added: now.toISOString(),
      by: "seed",
      kind: kindOf(one, folder),
      path: one,
      undo: undoOf(undo, path, home, machine),
      why: `seeded from bundles/${FOOTPRINT_NOTE}${comment ? `: ${comment}` : ""}`,
    }))
  })
  return { entries, skipped }
}
