import type { RemixiconComponentType } from "@remixicon/react"
import { useEffect, useSyncExternalStore } from "react"

import { chipOf, logoOf } from "@/components/dashboard/model-logo"
import { apiClient } from "@/lib/api/client"
import { initialsOf } from "@/lib/model-label"

// What a row draws for a model whose maker has none, or none the API could fetch: its initials in a chip (chipOf), one drawing for each initials, so a row keeps the same component across renders.
const chips = new Map<string, RemixiconComponentType>()
export const initialsIcon = (initials: string): RemixiconComponentType => {
  const kept = chips.get(initials)
  if (kept) return kept
  const chip = chipOf(initials)
  chips.set(initials, chip)
  return chip
}

// What the page knows of each maker's icon: its drawing once read, null once the API has none or could not be reached, absent while unread.
const icons = new Map<string, RemixiconComponentType | null>()
const reading = new Set<string>()
const listeners = new Set<() => void>()

const redraw = () => {
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// An icon's bytes as a data URI, so it draws with no request of its own and no script in it can run (an SVG through <image>, never inline).
const dataUri = async (answer: Pick<Response, "arrayBuffer" | "headers">): Promise<string> => {
  const bytes = new Uint8Array(await answer.arrayBuffer())
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${answer.headers.get("content-type")};base64,${btoa(binary)}`
}

// Pure: a served icon's drawing, a one-colour mask for an SVG and the image whole for any other.
export const drawingOf = (data: string): RemixiconComponentType =>
  logoOf({ data, mono: data.startsWith("data:image/svg+xml;") })

// Keeps a maker's icon as known, for the page and its tests alike, and redraws every row that reads it.
export const keepMakerIcon = (maker: string, drawing: RemixiconComponentType | null): void => {
  icons.set(maker, drawing)
  redraw()
}

// Reads a maker's icon from the API once a page: a 404, or no answer at all, keeps the initials chip.
export const readMakerIcon = async (maker: string): Promise<void> => {
  if (icons.has(maker) || reading.has(maker)) return
  reading.add(maker)
  await apiClient.v1["model-icons"][":maker"]
    .$get({ param: { maker } })
    .then(async (answer) => (answer.ok ? drawingOf(await dataUri(answer)) : null))
    .catch(() => null)
    .then((drawing) => {
      reading.delete(maker)
      keepMakerIcon(maker, drawing)
    })
}

// A maker's icon for a row: its drawing, the initials chip for no maker or one with no icon (the maker's own initials unless the row names its model's), and undefined while it is still read, so the row keeps its place empty rather than flash the chip. Each maker is read once a page.
export function useMakerIcon(
  maker: string | null,
  initials: string = initialsOf(maker),
): RemixiconComponentType | undefined {
  useEffect(() => {
    if (maker) void readMakerIcon(maker)
  }, [maker])
  const known = useSyncExternalStore(
    subscribe,
    () => (maker ? icons.get(maker) : null),
    () => (maker ? icons.get(maker) : null),
  )
  return !maker || known === null ? initialsIcon(initials) : known
}
