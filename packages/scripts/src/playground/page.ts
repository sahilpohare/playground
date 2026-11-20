import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import {
  CARVE_OUTS,
  LIMITS,
  movesLeft,
  quarantine,
  restore,
  type Roots,
} from "@packages/safe-delete"
import { z } from "zod"

// The record of every page `playground page` kept, one JSON line each, beside the pages in the previews folder.
export const PAGES_FILE = "pages.jsonl"

export type PageLine = { at: string; by: string; file: string; for: string | null; title: string }

export const PAGE_USAGE =
  'usage: playground page <file.html> --title "<title>" --by <session> [--for <session>] | --remove <file.html>'

// A name the Previews app serves: a letter or digit, then letters, digits, ., _ or -, ending .html, as PREVIEW_NAME_PATTERN in api/hono/src/lib/apps/previews.ts reads it.
const PAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/

type PageArgs = { by: string; file: string; for: string | null; title: string }

// The file and options `playground page` was given, the page --remove names, or why they are refused.
export const pageArgs = (args: string[]): PageArgs | { remove: string } | { error: string } => {
  if (args[0] === "--remove")
    return args.length === 2 ? { remove: args[1]! } : { error: PAGE_USAGE }
  const options: Record<string, string> = {}
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (["--by", "--for", "--title"].includes(arg)) {
      const value = args[++i]
      if (!value) return { error: `${arg} needs a value; ${PAGE_USAGE}` }
      options[arg] = value
    } else if (arg.startsWith("-"))
      return { error: `playground page takes no ${arg}; ${PAGE_USAGE}` }
    else words.push(arg)
  }
  const [file, ...extra] = words
  if (!file || extra.length) return { error: PAGE_USAGE }
  const title = options["--title"]?.trim()
  const by = options["--by"]
  if (!title || !by) return { error: PAGE_USAGE }
  return { by, file, for: options["--for"] ?? null, title }
}

// Every session name the roster in the data folder lists.
const rosterNames = (data: string): Set<string> => {
  try {
    const roster = JSON.parse(readFileSync(join(data, "roster.json"), "utf8")) as {
      agents?: { name?: unknown }[]
    }
    return new Set(
      (roster.agents ?? []).flatMap((a) => (typeof a.name === "string" ? [a.name] : [])),
    )
  } catch {
    return new Set()
  }
}

// The first of name, name-2, name-3… whose page and caption are both free in the folder, so a page never takes another file's caption.
export const freeName = (folder: string, name: string): string => {
  const stem = name.slice(0, -".html".length)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`
    if (
      !existsSync(join(folder, `${candidate}.html`)) &&
      !existsSync(join(folder, `${candidate}.txt`))
    )
      return `${candidate}.html`
  }
}

// Keeps a page: copies the HTML file into the previews folder under a free name, writes its title to the caption beside it and appends its line to pages.jsonl. The path of the copy, or why it is refused.
export const keepPage = (
  args: PageArgs,
  data: string,
  now = new Date(),
): { path: string } | { error: string } => {
  const name = basename(args.file)
  if (!PAGE_NAME.test(name) || name.includes(".."))
    return {
      error: `${name} is not an HTML file with a plain name (letters, digits, ., _ and -, ending .html)`,
    }
  let bytes: Buffer
  try {
    bytes = readFileSync(args.file)
  } catch {
    return { error: `no file at ${args.file}` }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return { error: `${args.file} is not text, so it is not an HTML page` }
  }
  const known = rosterNames(data)
  for (const session of [args.by, args.for]) {
    if (session !== null && !known.has(session))
      return { error: `no session named ${session} in ${join(data, "roster.json")}` }
  }
  const folder = join(data, "previews")
  mkdirSync(folder, { mode: 0o700, recursive: true })
  const file = freeName(folder, name)
  const path = join(folder, file)
  copyFileSync(args.file, path, constants.COPYFILE_EXCL)
  writeFileSync(join(folder, `${file.slice(0, -".html".length)}.txt`), `${args.title}\n`, {
    flag: "wx",
  })
  const line: PageLine = {
    at: now.toISOString(),
    by: args.by,
    file,
    for: args.for,
    title: args.title,
  }
  appendFileSync(join(folder, PAGES_FILE), `${JSON.stringify(line)}\n`)
  return { path }
}

// What removePage moves with: the trash's move (a test's stand-in), the time, the machine's roots and the calling session, whose name the trash batch takes.
export type RemoveDeps = {
  move?: typeof quarantine
  now?: Date
  roots: Roots
  session: string
}

// A page's record and a tombstone, as pageLine and tombstoneLine in api/hono/src/lib/apps/previews.ts read them.
const pageLine = z.object({
  at: z.iso.datetime(),
  by: z.string().min(1),
  file: z.string(),
  for: z.string().min(1).nullable(),
  title: z.string().min(1),
})
const tombstoneLine = z.strictObject({
  at: z.iso.datetime(),
  deleted: z.literal(true),
  file: z.string(),
})

// The pages pages.jsonl lists, as the Previews app's readPages reads it: a later line for the same file wins, a tombstone drops it, and any other line counts for nothing.
const listedPages = (folder: string): Set<string> => {
  const pages = new Set<string>()
  let text = ""
  try {
    text = readFileSync(join(folder, PAGES_FILE), "utf8")
  } catch {}
  for (const line of text.split("\n")) {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {}
    const tombstone = tombstoneLine.safeParse(json)
    if (tombstone.success) pages.delete(tombstone.data.file)
    else {
      const record = pageLine.safeParse(json)
      if (record.success) pages.add(record.data.file)
    }
  }
  return pages
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Takes one kept page off the Pages tab: its line leaves pages.jsonl by a tombstone, as the Pages tab's delete writes it, and its HTML, caption and the PDF beside it move to the trash through safe-delete's page carve-out, each move scoped to that one file. Every check runs before the first move. The trash ids of the moved files, or why it is refused.
export const removePage = (
  target: string,
  data: string,
  deps: RemoveDeps,
): { moved: { file: string; id: string }[] } | { error: string } => {
  const folder = join(data, "previews")
  if (target.split("/").includes(".."))
    return { error: `${target} takes a .. step; name the page by its file name or its kept path` }
  if (existsSync(folder) && realOrSelf(folder) !== join(realOrSelf(data), "previews"))
    return {
      error: `${folder} is a symlink or sits behind one, so it leads out of the data folder and nothing is removed`,
    }
  const name = basename(target)
  if (!PAGE_NAME.test(name) || name.includes(".."))
    return {
      error: `${name} is not an HTML file with a plain name (letters, digits, ., _ and -, ending .html)`,
    }
  if (target !== name && realOrSelf(dirname(resolve(target))) !== realOrSelf(folder))
    return { error: `${target} is not in the previews folder ${folder}` }
  const page = CARVE_OUTS.page!
  const index = lstatSync(join(folder, PAGES_FILE), { throwIfNoEntry: false })
  if (index && (!index.isFile() || index.nlink !== 1))
    return {
      error: `${PAGES_FILE} is not a regular file with one link (a symlink or a hard link), so nothing is removed`,
    }
  if (index && index.size > page.bytes)
    return {
      error: `${PAGES_FILE} is over ${page.bytes / 1024 ** 2} MiB, so nothing is removed`,
    }
  if (!listedPages(folder).has(name))
    return { error: `pages.jsonl lists no page ${name}, so nothing is removed` }
  const stem = name.slice(0, -".html".length)
  const files = [name, `${stem}.txt`, `${stem}.pdf`].filter(
    (file, i) => i === 0 || lstatSync(join(folder, file), { throwIfNoEntry: false }),
  )
  for (const file of files) {
    const info = lstatSync(join(folder, file), { throwIfNoEntry: false })
    if (!info) return { error: `${file} is not in the previews folder, so the page stays` }
    if (!info.isFile() || info.nlink !== 1)
      return {
        error: `${file} is not a regular file with one link (a symlink or a hard link), so the page stays`,
      }
    if (info.size > page.bytes)
      return {
        error: `${file} is over ${page.bytes / 1024 ** 2} MiB, the most one page's file may hold, so the page stays`,
      }
  }
  const now = deps.now ?? new Date()
  const left = movesLeft(deps.roots.trash, deps.session, now)
  if (left < files.length)
    return {
      error: `${name} takes ${files.length} moves and ${deps.session} has ${left} of the trash's ${LIMITS.perMinute} a minute left: try again in a minute`,
    }
  const move = deps.move ?? quarantine
  const toTrash = (file: string) =>
    move(
      join(folder, file),
      { carveOut: "page", reason: `playground page --remove ${name}`, session: deps.session },
      deps.roots,
      {
        carveOuts: { page: { ...page, name: new RegExp(`^${file.replaceAll(".", "\\.")}$`) } },
        now,
      },
    )
  // the HTML moves before the tombstone, unlike the Pages tab's delete, so a refused move leaves the index as it was
  const html = toTrash(name)
  if ("refused" in html)
    return { error: `${name} did not move, so the page stays: ${html.refused}` }
  try {
    appendFileSync(
      join(folder, PAGES_FILE),
      `${JSON.stringify({ at: now.toISOString(), deleted: true, file: name })}\n`,
    )
  } catch (error) {
    const back = restore(html.id, deps.roots)
    return {
      error:
        "refused" in back
          ? `pages.jsonl took no tombstone (${(error as Error).message}) and ${name} did not come back (${back.refused}): playground rm --restore ${html.id} brings it back`
          : `pages.jsonl took no tombstone (${(error as Error).message}), so ${name} was put back and the page stays`,
    }
  }
  const moved = [{ file: name, id: html.id }]
  for (const file of files.slice(1)) {
    const done = toTrash(file)
    if ("refused" in done)
      return {
        error: `${name} left the Pages tab, but ${file} stays in the previews folder as an unlisted file: ${done.refused}`,
      }
    moved.push({ file, id: done.id })
  }
  return { moved }
}
