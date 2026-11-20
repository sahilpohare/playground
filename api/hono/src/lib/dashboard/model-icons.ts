import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { BACKEND_MAKERS, MAKER_NAME } from "@packages/config/console"

import { ApiError } from "@/lib/error"

// The makers whose icons the dashboard draws, from config alone: each backend's (BACKEND_MAKERS), then the Hugging Face org of each local model's repo id (org/repo); a bare id names no maker.
export const makersOf = (local: readonly { id: string }[]): Set<string> =>
  new Set([
    ...Object.values(BACKEND_MAKERS),
    ...local.flatMap(({ id }) => {
      const org = id.split("/")[0]
      return id.includes("/") && org && isMaker(org) ? [org] : []
    }),
  ])

// A maker's name as models.dev and Hugging Face spell one (MAKER_NAME).
const MAKER = new RegExp(`^${MAKER_NAME}$`)
export const isMaker = (maker: string): boolean => MAKER.test(maker)

export type Fetch = (url: string) => Promise<Response>

export type ModelIcon = { bytes: Uint8Array<ArrayBuffer>; type: IconType }

type IconType = "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp"

const EXT: Record<IconType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
}

const MODELS_DEV = "https://models.dev/logos"
// A maker models.dev lists under another id, whose logo there is taken as it is, its placeholder included, and cached under that id, so a real logo comes from the same place once models.dev draws one: Ornith's models are listed under DeepReinforce, the team that makes them (models.dev's models/deepreinforce), whose logo there is models.dev's placeholder for now.
export const MODELS_DEV_IDS: Record<string, string> = { "ornith-ai": "deepreinforce" }
// A provider id models.dev cannot hold: it answers any unknown id with one fallback SVG (1421 bytes, measured) and 200, so this one's body is that fallback, whatever its size.
const SENTINEL = "playground-no-such-maker"
const MAX_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
// How long a maker found to have no icon stays so before it is asked again, so an icon added later still arrives.
const NONE_FOR_MS = 24 * 60 * 60 * 1000
// How long a found logo is served before it is fetched again, so a maker's new logo, or a real one in place of models.dev's placeholder, comes in by itself.
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000

// Only the maker's name leaves the machine, and a redirect is refused, so no answer can send the fetch to another host; a source that does not answer in time counts as out of reach.
const plainFetch: Fetch = (url) =>
  fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

const huggingFace = (url: string): boolean => {
  try {
    const { hostname, protocol } = new URL(url)
    return (
      protocol === "https:" &&
      (hostname === "huggingface.co" || hostname.endsWith(".huggingface.co"))
    )
  } catch {
    return false
  }
}

// An image's type by its own first bytes, never by what its server said: PNG, JPEG or WebP, else null.
const rasterType = (bytes: Uint8Array): IconType | null => {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png"
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return null
}

// An answer's bytes up to MAX_BYTES, read no further than that: null for a 404, an empty body or one past the cap; any other failed answer (a 429, a 5xx) throws, so it reads as out of reach, never as no icon.
const body = async (answer: Response): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (answer.status === 404) return null
  if (!answer.ok) throw new Error(`${answer.url} answered ${answer.status}`)
  if (Number(answer.headers.get("content-length") ?? 0) > MAX_BYTES) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of answer.body ?? []) {
    size += chunk.length
    if (size > MAX_BYTES) {
      await answer.body?.cancel().catch(() => {})
      return null
    }
    chunks.push(chunk)
  }
  if (size === 0) return null
  const bytes = new Uint8Array(new ArrayBuffer(size))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

// A maker's icon from its source: its MODELS_DEV_IDS logo as it is, else models.dev's logo unless its answer is the fallback, else its Hugging Face org's avatar from huggingface.co's hosts alone, else null. Throws when a source cannot be reached, or when models.dev's fallback does not read (its sentinel's answer is no SVG, a 404 included), so offline is not mistaken for no icon.
const fetchIcon = async (maker: string, fetch: Fetch): Promise<ModelIcon | null> => {
  const listed = MODELS_DEV_IDS[maker]
  if (listed) {
    const logo = await body(await fetch(`${MODELS_DEV}/${listed}.svg`))
    return logo && new TextDecoder().decode(logo).includes("<svg")
      ? { bytes: logo, type: "image/svg+xml" }
      : null
  }
  const fallback = new TextDecoder().decode(
    (await body(await fetch(`${MODELS_DEV}/${SENTINEL}.svg`))) ?? new Uint8Array(),
  )
  if (!fallback.includes("<svg")) throw new Error("models.dev's fallback did not read")
  const logo = await body(await fetch(`${MODELS_DEV}/${maker.toLowerCase()}.svg`))
  const svg = logo ? new TextDecoder().decode(logo) : ""
  if (svg.includes("<svg") && svg.trim() !== fallback.trim())
    return { bytes: logo!, type: "image/svg+xml" }
  const answer = await body(await fetch(`https://huggingface.co/api/organizations/${maker}/avatar`))
  if (!answer) return null
  const { avatarUrl } = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(answer)) as { avatarUrl?: unknown }
    } catch {
      return {}
    }
  })()
  if (typeof avatarUrl !== "string" || !huggingFace(avatarUrl)) return null
  const bytes = await body(await fetch(avatarUrl))
  const type = bytes && rasterType(bytes)
  return bytes && type ? { bytes, type } : null
}

// A maker's cached icon, with its file and whether it is past REFRESH_MS; null for a none marker under a day old; undefined for nothing kept.
const cached = async (
  dir: string,
  maker: string,
  now: number,
): Promise<(ModelIcon & { file: string; stale: boolean }) | null | undefined> => {
  const names = await readdir(dir).catch(() => [] as string[])
  for (const [type, ext] of Object.entries(EXT) as [IconType, string][])
    if (names.includes(`${maker}.${ext}`)) {
      const file = join(dir, `${maker}.${ext}`)
      const { mtimeMs } = await stat(file)
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
      return { bytes, file, stale: now - mtimeMs >= REFRESH_MS, type }
    }
  if (!names.includes(`${maker}.none`)) return undefined
  const { mtimeMs } = await stat(join(dir, `${maker}.none`))
  return now - mtimeMs < NONE_FOR_MS ? null : undefined
}

const inFlight = new Map<string, Promise<ModelIcon | null>>()

// A maker's icon, from the cache in dir once fetched (under its MODELS_DEV_IDS id where it has one), fetched again once it is past REFRESH_MS, a failed fetch keeping the old one; the first ask fetches it (one fetch at a time for a maker) and keeps it, or a none marker for a day. With nothing cached, offline or any source failing gives null and keeps nothing, so a later ask tries again.
export const iconFor = async (
  maker: string,
  { dir, fetch = plainFetch, now = Date.now }: { dir: string; fetch?: Fetch; now?: () => number },
): Promise<ModelIcon | null> => {
  const id = MODELS_DEV_IDS[maker] ?? maker
  const hit = await cached(dir, id, now())
  const kept = hit ? { bytes: hit.bytes, type: hit.type } : null
  if (hit === null || hit?.stale === false) return kept
  const key = `${dir}\0${id}`
  const running = inFlight.get(key)
  if (running) return running
  const work = (async () => {
    const icon = await fetchIcon(maker, fetch).catch(() => undefined)
    // offline, or no logo found where one was, keeps the old one served
    if (icon === undefined || (icon === null && kept)) return kept
    await mkdir(dir, { recursive: true })
    // written whole under a name no reader looks for, then renamed, so a read mid-write never serves part of a file
    const name = join(dir, icon ? `${id}.${EXT[icon.type]}` : `${id}.none`)
    const part = `${name}.${process.pid}.${crypto.randomUUID()}.part`
    await writeFile(part, icon ? icon.bytes : "")
    await rename(part, name)
    if (hit && hit.file !== name) await unlink(hit.file).catch(() => {})
    return icon
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, work)
  return work
}

// How a cached icon is served: as the type the cache gave it, with no script able to run, kept a day by the browser.
export const servedIconHeaders = (type: string): Record<string, string> => ({
  "cache-control": "private, max-age=86400",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "content-type": type,
  "x-content-type-options": "nosniff",
})

// The serve route's work: the icon of a maker local names (config's, and the served local model's, iconModels), from the cache or fetched once, with servedIconHeaders; a 404 for any other name, a maker with none, or one not yet fetched while offline, which the web draws as its initials chip.
export async function serveModelIcon(
  maker: string,
  { dir, fetch, local }: { dir: string; fetch?: Fetch; local: readonly { id: string }[] },
): Promise<Response> {
  const icon =
    isMaker(maker) && makersOf(local).has(maker) ? await iconFor(maker, { dir, fetch }) : null
  if (!icon) throw new ApiError(404, "NOT_FOUND", "No icon for that maker")
  return new Response(icon.bytes, { headers: servedIconHeaders(icon.type) })
}
