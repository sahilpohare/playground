import { constants } from "node:fs"
import { appendFile, lstat, open, readdir, unlink } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"

import { z } from "zod"

// Relative, not @/: the web's tests import this file.
import { isOwnFolder, sniff } from "../dashboard/attachments"
import { fileNameOf } from "../download"
import { dataDir, livePath } from "../sessions/paths"

// What a preview is drawn as: an image as itself, an HTML page live in a sandboxed frame, so its CSS motion shows.
export type PreviewKind = "html" | "image"

// A page `playground page` kept: one line of pages.jsonl in the folder, naming its file, its title, the session that made it (by), the session it was made for (for) and when.
export type PageRecord = { at: string; by: string; for: string | null; title: string }

// A preview as the page lists it, by name, never a path: its topic (the name before its first - or .), its caption from a .txt beside it, when it last changed, its size in bytes, its record when `playground page` kept it, and for an HTML page the name of the PDF beside it, when there is one.
export type Preview = {
  caption: string | null
  kind: PreviewKind
  modifiedAt: string
  name: string
  page?: PageRecord
  pdf?: string
  size: number
  topic: string
}

// The pages a session's Pages tab lists: those it made or that were made for it, every one on the primary dispatcher's.
export type PageFilter = { dispatcher: string; session: string }

export const PAGES_FILE = "pages.jsonl"

const pageLine = z.object({
  at: z.iso.datetime(),
  by: z.string().min(1),
  file: z.string(),
  for: z.string().min(1).nullable(),
  title: z.string().min(1),
})

// A page the Pages tab deleted, or `playground page --remove` removed: its file, and when; the reader drops the file's record, and a later line for it keeps it again.
const tombstoneLine = z.strictObject({
  at: z.iso.datetime(),
  deleted: z.literal(true),
  file: z.string(),
})

// A file the serve route found: its name, kind (a preview's, or pdf for a PDF beside a page), absolute path and size.
export type PreviewFile = { kind: PreviewKind | "pdf"; name: string; path: string; size: number }

export const IMAGE_PREVIEW_EXTENSIONS = ["gif", "png", "webp"] as const
export const PREVIEW_EXTENSIONS = [...IMAGE_PREVIEW_EXTENSIONS, "html"] as const

export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024
const MAX_CAPTION_BYTES = 2 * 1024
// An image is told by its first bytes (a WebP's mark ends at the 12th); an HTML page is read whole, since only all of it shows it is text.
const SNIFF_BYTES = 16

// The only names the dashboard serves: a letter or digit, then letters, digits, ., _ or -, and one of the four extensions. A name like this holds no / and no .., so it cannot reach outside the folder; a name with .. anywhere is refused too.
export const PREVIEW_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\\.(?:${PREVIEW_EXTENSIONS.join("|")})$`,
)

export const isPreviewName = (name: string): boolean =>
  PREVIEW_NAME_PATTERN.test(name) && !name.includes("..")

const extensionOf = (name: string): string => extname(name).slice(1)

export const previewKindOf = (name: string): PreviewKind =>
  extensionOf(name) === "html" ? "html" : "image"

// Pure: the name of the PDF that stands beside a page, <page>.pdf beside <page>.html.
const pdfOf = (page: string): string => `${page.slice(0, -".html".length)}.pdf`

// Pure: the page a PDF stands beside (<page>.pdf beside <page>.html), or null when the name is not such a PDF's.
export const pdfPageOf = (name: string): string | null => {
  const page = name.endsWith(".pdf") ? `${name.slice(0, -".pdf".length)}.html` : null
  return page && isPreviewName(page) ? page : null
}

// The topic a preview is grouped under: its name up to the first - or . (spinner-light-1.png and spinner-preview.html are both spinner).
export const topicOf = (name: string): string => name.split(/[-.]/)[0] ?? name

const CONTENT_TYPES: Record<string, string> = {
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
}

// The folder previews are read from: $PLAYGROUND_PREVIEWS_DIR when set (a live-reads test stack's scratch folder), else previews in the dashboard's data folder, beside the roster; a fixture stack reads its fixture's folder whatever is set.
export const previewsDir = (): string =>
  resolve(livePath("PLAYGROUND_PREVIEWS_DIR") || join(dataDir(), "previews"))

// A file's bytes through a handle opened with O_NOFOLLOW and checked again (a regular file with one link, at most max bytes), so a symlink swapped in after the lstat is never followed: all of them, or only the first head. Null when it is not that.
async function readOwnFile(
  path: string,
  max: number,
  head?: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return null
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > max) return null
    if (head === undefined) return Uint8Array.from(await handle.readFile())
    const bytes = new Uint8Array(Math.min(head, info.size))
    await handle.read(bytes, 0, bytes.length, 0)
    return bytes
  } finally {
    await handle.close()
  }
}

// Where a preview's caption sits: <name without its extension>.txt beside it.
const captionPath = (folder: string, name: string): string =>
  join(folder, `${name.slice(0, -extname(name).length)}.txt`)

// The caption beside a preview, a regular file with one link, read as UTF-8 and trimmed. Null when there is none or it is not that.
async function captionOf(folder: string, name: string): Promise<string | null> {
  const path = captionPath(folder, name)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || info.nlink !== 1) return null
  const bytes = await readOwnFile(path, MAX_CAPTION_BYTES)
  if (!bytes) return null
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() || null
  } catch {
    return null
  }
}

// The PDF beside a page by its name, <page>.pdf: a regular file with one link whose bytes are a PDF's. Null when there is none or it is not that.
async function pdfBeside(folder: string, page: string): Promise<string | null> {
  const name = pdfOf(page)
  const bytes = await readOwnFile(join(folder, name), MAX_PREVIEW_BYTES, SNIFF_BYTES)
  return bytes && sniff(bytes, name) === "pdf" ? name : null
}

// Each page's record by its file, from pages.jsonl (a later line for the same file wins, a tombstone dropping it), and each line that is neither a page's record nor a tombstone, named (problems). A missing file holds none.
async function readPages(
  folder: string,
): Promise<{ pages: Map<string, PageRecord>; problems: string[] }> {
  const pages = new Map<string, PageRecord>()
  const problems: string[] = []
  const path = join(folder, PAGES_FILE)
  if (!(await lstat(path).catch(() => null))) return { pages, problems }
  const bytes = await readOwnFile(path, MAX_PREVIEW_BYTES)
  if (!bytes) return { pages, problems: [`${PAGES_FILE}: not a regular file with one link`] }
  new TextDecoder()
    .decode(bytes)
    .split("\n")
    .forEach((text, i) => {
      if (!text.trim()) return
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {}
      const tombstone = tombstoneLine.safeParse(json)
      if (tombstone.success && isPreviewName(tombstone.data.file)) {
        pages.delete(tombstone.data.file)
        return
      }
      const parsed = pageLine.safeParse(json)
      if (!parsed.success || !isPreviewName(parsed.data.file)) {
        problems.push(`${PAGES_FILE} line ${i + 1}: not a page's record`)
        return
      }
      const { file, ...record } = parsed.data
      pages.set(file, record)
    })
  return { pages, problems }
}

// Every preview in the folder, newest first (by name on a tie), and each file that looks like one but is not served (its name, its links, its size or bytes that are not what its name says), named with why (problems). A folder that is missing holds none; one that is a symlink or another user's is named and holds none.
// With a filter, only the pages that session's Pages tab lists, newest kept first.
export async function readPreviews(
  dir = previewsDir(),
  filter?: PageFilter,
): Promise<{ previews: Preview[]; problems: string[] }> {
  const folder = resolve(dir)
  const info = await lstat(folder).catch(() => null)
  if (!info) return { previews: [], problems: [] }
  if (!(await isOwnFolder(folder))) {
    return {
      previews: [],
      problems: [`${folder} is not a folder this user owns, so no preview is read from it`],
    }
  }
  const previews: Preview[] = []
  const { pages, problems } = await readPages(folder)
  const listed = (name: string): boolean => {
    if (!filter) return true
    const page = pages.get(name)
    if (!page) return false
    return (
      filter.session === filter.dispatcher ||
      page.by === filter.session ||
      page.for === filter.session
    )
  }
  for (const name of (await readdir(folder)).sort()) {
    if (!(PREVIEW_EXTENSIONS as readonly string[]).includes(extensionOf(name))) continue
    if (!listed(name)) continue
    if (!isPreviewName(name)) {
      problems.push(`${name}: a preview's name is letters, digits, ., _ and - only`)
      continue
    }
    const file = await lstat(join(folder, name)).catch(() => null)
    if (!file?.isFile() || file.nlink !== 1) {
      problems.push(`${name}: not a regular file with one link (a symlink or a hard link)`)
      continue
    }
    if (file.size > MAX_PREVIEW_BYTES) {
      problems.push(`${name}: larger than ${MAX_PREVIEW_BYTES / 1024 / 1024} MB`)
      continue
    }
    const kind = previewKindOf(name)
    const bytes = await readOwnFile(
      join(folder, name),
      MAX_PREVIEW_BYTES,
      kind === "image" ? SNIFF_BYTES : undefined,
    )
    if (!bytes || sniff(bytes, name) !== extensionOf(name)) {
      problems.push(`${name}: its bytes are not a ${extensionOf(name).toUpperCase()}`)
      continue
    }
    const page = pages.get(name)
    const pdf = kind === "html" ? await pdfBeside(folder, name) : null
    previews.push({
      caption: await captionOf(folder, name),
      kind,
      modifiedAt: file.mtime.toISOString(),
      name,
      ...(page && { page }),
      ...(pdf && { pdf }),
      size: file.size,
      topic: topicOf(name),
    })
  }
  const at = (preview: Preview) => (filter && preview.page?.at) || preview.modifiedAt
  previews.sort((a, b) => at(b).localeCompare(at(a)) || a.name.localeCompare(b.name))
  return { previews, problems }
}

// The file a name names, or null: the name must be one the dashboard serves (a preview's, or a PDF's while its page stands beside it), sitting directly in the folder as a regular file with one link (not a symlink, and not a hard link to a file elsewhere), in a folder its owner owns.
export async function findPreview(name: string, dir = previewsDir()): Promise<PreviewFile | null> {
  const page = pdfPageOf(name)
  const pdf = page !== null
  if (!pdf && !isPreviewName(name)) return null
  // a PDF is served only while its page stands beside it
  if (page && !(await findPreview(page, dir))) return null
  const folder = resolve(dir)
  const path = join(folder, name)
  if (dirname(path) !== folder || !(await isOwnFolder(folder))) return null
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || info.nlink !== 1) return null
  return { kind: pdf ? "pdf" : previewKindOf(name), name, path, size: info.size }
}

// The name a served file downloads under: its page's title from pages.jsonl, else its caption, else its own name, with its own extension; a PDF takes the title of the page it stands beside.
export async function previewDownloadName(name: string, dir = previewsDir()): Promise<string> {
  const folder = resolve(dir)
  const titled = pdfPageOf(name) ?? name
  const title =
    (await readPages(folder)).pages.get(titled)?.title ??
    (await captionOf(folder, titled)) ??
    titled.slice(0, -extname(titled).length)
  return fileNameOf(title, extensionOf(name))
}

// Deletes a page the Pages tab lists: only a name pages.jsonl keeps a record for, found as findPreview finds it. A tombstone is appended to pages.jsonl first, so a concurrent `playground page` append stays and a failure leaves no record naming a freed name; then its file, its caption and the PDF beside it are unlinked one by one, so a page kept later under the freed name offers no PDF of this one. False, touching nothing, for any other name.
export async function deletePage(
  name: string,
  dir = previewsDir(),
  now = new Date(),
): Promise<boolean> {
  const file = await findPreview(name, dir)
  if (!file || file.kind !== "html") return false
  const folder = dirname(file.path)
  if (!(await readPages(folder)).pages.has(name)) return false
  const line = { at: now.toISOString(), deleted: true, file: name }
  await appendFile(join(folder, PAGES_FILE), `${JSON.stringify(line)}\n`)
  // a delete running beside this one may have unlinked it already
  await unlink(file.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  for (const beside of [captionPath(folder, name), join(folder, pdfOf(name))]) {
    const info = await lstat(beside).catch(() => null)
    if (info?.isFile() && info.nlink === 1) await unlink(beside).catch(() => {})
  }
  return true
}

// A found preview's bytes, read through an O_NOFOLLOW handle and checked again, and only when its bytes are what its name says (a PNG named .png, UTF-8 text named .html). Null otherwise.
export async function readPreview(
  name: string,
  dir = previewsDir(),
): Promise<{ bytes: Uint8Array<ArrayBuffer>; file: PreviewFile } | null> {
  const file = await findPreview(name, dir)
  if (!file) return null
  const bytes = await readOwnFile(file.path, MAX_PREVIEW_BYTES)
  if (!bytes || sniff(bytes, name) !== extensionOf(name)) return null
  return { bytes, file: { ...file, size: bytes.length } }
}

// What a browser may do with a preview: show it as the type its name gives and nothing else. An image loads nothing and runs nothing; a PDF beside a page is saved, never shown. An HTML page is a sandboxed document with an opaque origin, so it runs its own inline script (a deck's keys and tabs: the owner, "why navigation is not working in html") but submits no form, opens no window and cannot read the dashboard's cookies; it may use its own inline styles and data: images and fonts, and fetches nothing else, so it cannot reach the dashboard's API. Only the dashboard's own pages may frame it.
export const previewHeaders = (
  file: Pick<PreviewFile, "kind" | "name">,
  frameAncestors: readonly string[],
): Record<string, string> => ({
  "cache-control": "private, no-cache",
  "content-disposition": file.kind === "pdf" ? "attachment" : "inline",
  "content-security-policy":
    file.kind === "html"
      ? `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`
      : "default-src 'none'; sandbox",
  "content-type": CONTENT_TYPES[extensionOf(file.name)] ?? "application/octet-stream",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
})
