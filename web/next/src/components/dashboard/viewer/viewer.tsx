"use client"

import type { InboxAttachmentKind } from "@api/hono"
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileLine,
  RiFullscreenLine,
  RiLayoutRightLine,
} from "@remixicon/react"
import { cn } from "cn"
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { useText } from "@/components/dashboard/viewer/documents"
import { type ViewerItem, VIEWERS } from "@/components/dashboard/viewer/registry"
import {
  attachmentDownloadUrl,
  useAttachment,
} from "@/components/dashboard/viewer/use-attachment-url"
import { Hint, OFF_FOCUSABLE } from "@/components/hint"
import { Button } from "@/components/ui/button"
import { Carousel, type CarouselApi, CarouselContent, CarouselItem } from "@/components/ui/carousel"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { opensInAside } from "@/lib/aside-docs"
import { saveFrom } from "@/lib/download"
import { BAR_ITEM, FLOATING_BAR } from "@/lib/floating-bar"
import { documentNonce, pageTab } from "@/lib/viewer"

const KIND_LABELS: Record<InboxAttachmentKind, string> = {
  code: "Code",
  doc: "Doc",
  html: "HTML",
  image: "Image",
  pdf: "PDF",
}

// The arrows that move the slide: Left and Up back, Right and Down on.
export const STEP_OF_KEY: Record<string, -1 | 1> = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
}

export const OWNS_POINTER = "[data-viewer-owns-pointer]"
export const OWNS_KEYS = "[data-viewer-owns-keys]"

// Pure: the slide a step lands on, past either end wrapping to the other, and whether it wrapped, so the move jumps rather than sweeping across every slide.
export function wrapStep(index: number, direction: -1 | 1, count: number) {
  const next = (index + direction + count) % count
  return { next, wraps: next !== index + direction }
}

// The kinds a slide draws in a frame, which keeps a touch to itself, so no tap on it can raise the bars.
const FRAME_KINDS: readonly InboxAttachmentKind[] = ["html", "pdf"]

// Pure: whether the bars stay up whatever the pointer does: a frame kind on a screen with no hover, where nothing else could raise them.
export const pinsBars = (kind: InboxAttachmentKind, touch: boolean): boolean =>
  touch && FRAME_KINDS.includes(kind)

const NO_HOVER = "(hover: none)"
const watchNoHover = (change: () => void) => {
  const query = window.matchMedia(NO_HOVER)
  query.addEventListener("change", change)
  return () => query.removeEventListener("change", change)
}
const useNoHover = () =>
  useSyncExternalStore(
    watchNoHover,
    () => window.matchMedia(NO_HOVER).matches,
    () => false,
  )

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

// A drag swipes the slide unless it starts inside a renderer that owns its pointer events.
const watchDrag = (_api: unknown, event: MouseEvent | TouchEvent) =>
  !(event.target instanceof Element && event.target.closest(OWNS_POINTER))

function Slide({
  active,
  item,
  near,
  onEdge,
}: {
  active: boolean
  item: ViewerItem
  near: boolean
  onEdge: (direction: -1 | 1) => void
}) {
  const viewer = VIEWERS[item.kind]
  const { failed, missing, url } = useAttachment(item.id, near && Boolean(viewer), item.page?.url)
  const Icon = viewer?.icon ?? RiFileLine
  return (
    <CarouselItem
      aria-label={item.name}
      className="flex h-full items-center justify-center"
      inert={!active}
    >
      {viewer && url ? (
        <viewer.View active={active} item={item} onEdge={onEdge} url={url} />
      ) : (
        <span className="text-muted-foreground flex flex-col items-center gap-2 text-xs">
          <Icon className="size-8" />
          {missing || failed ? <Missing failed={failed} /> : null}
        </span>
      )}
    </CarouselItem>
  )
}

// What a file that did not arrive shows in its place: Missing for a 404, Did not load for any other failure
export const Missing = ({ failed = false }: { failed?: boolean }) => (
  <span className="text-muted-foreground text-xs">{failed ? "Did not load" : "Missing"}</span>
)

const CAROUSEL_ITEM = '[data-slot="carousel-item"]'

// A slide holding focus turns inert as it leaves, which drops focus to the page, out of the dialog, so the stage takes it first and the next arrow still moves the slide (a tester: Down from the compare slider left Left, Right and Up dead).
export const keepFocus = (focused: Element | null, stage: HTMLElement | null) => {
  if (focused?.closest(CAROUSEL_ITEM)) stage?.focus({ preventScroll: true })
}

// embla emits select only when the slide changes (a swipe and scrollTo alike), before the old one turns inert, so the hand-off lives here and an arrow that moves nothing (a lone page's edge) leaves focus in the page
export const onSelect = (
  snap: number,
  focused: Element | null,
  stage: HTMLElement | null,
  onIndexChange: (index: number) => void,
) => {
  keepFocus(focused, stage)
  onIndexChange(snap)
}

// How near the bottom edge, in px, the pointer brings the bar up.
const REVEAL_PX = 96

// A square in the floating bar, the aside bar's own size (APP_SQUARE), lit as every bar's square is (BAR_ITEM), a full-size hover background with no focus ring.
const SQUARE = `size-8 ${BAR_ITEM}`

// The bar's count and name at fixed widths, so it holds one width from slide to slide.
export const BAR_COUNT =
  "text-muted-foreground w-16 shrink-0 text-center font-mono text-xs tabular-nums"
export const BAR_NAME = "w-48 min-w-0 shrink truncate px-1 text-xs font-normal"

// The kinds a tab may open: an image or a PDF as its blob URL, which runs with the Dashboard's origin, so only those that run no script, an image being a GIF, JPEG, PNG or WebP (`IMAGE_EXTENSIONS`), never an SVG or code; an HTML page at its own address on Previews, else held in a sandboxed frame (pageTab).
export const OPENS_IN_TAB: readonly InboxAttachmentKind[] = ["html", "image", "pdf"]

// A square's blank room in a bar, where a kind takes no button, so the bar holds one width.
const ROOM = <span aria-hidden className="size-8 shrink-0" />

// Pure: what a tab opens for a file of a kind OPENS_IN_TAB takes: a kept page's own address, a card's page held in pageTab (framed, made once its text has arrived), and an image's or a PDF's own blob; null until it can.
export const tabHref = (item: ViewerItem, blob: string | null, framed: string | null) =>
  item.page ? item.page.url : item.kind === "html" ? framed : blob

// A card's page held in pageTab as a blob URL while its square shows, freed once it goes, since the URL holds the whole page; a tab it opened keeps its document.
function useFramedPage(name: string, html: string | null | false): string | null {
  const [framed, setFramed] = useState<string | null>(null)
  useEffect(() => {
    if (typeof html !== "string") return
    const href = URL.createObjectURL(
      new Blob([pageTab(name, html, documentNonce())], { type: "text/html" }),
    )
    setFramed(href)
    return () => {
      URL.revokeObjectURL(href)
      setFramed(null)
    }
  }, [name, html])
  return framed
}

// The shown file on a tab of its own, at full size, off until it can open; a kind OPENS_IN_TAB leaves out has no button at all, keeping its room where keepRoom asks, as the viewer's bar does so it holds one width.
export function OpenInNewTab({ item, keepRoom = false }: { item: ViewerItem; keepRoom?: boolean }) {
  const opens = OPENS_IN_TAB.includes(item.kind)
  const { url } = useAttachment(item.id, opens && !item.page && Boolean(VIEWERS[item.kind]))
  const text = useText(item.kind === "html" && !item.page ? url : null)
  const href = tabHref(item, url, useFramedPage(item.name, text))
  if (!opens) return keepRoom ? ROOM : null
  return (
    // the off square is a button and the live one a link, so the element is swapped once the file arrives; the key remounts the tooltip with it, whose trigger would stay bound to the gone button
    <Hint key={href ? "open" : "off"} content="Open in new tab" description={null}>
      {href ? (
        <Button
          aria-label="Open in new tab"
          className={SQUARE}
          render={<a href={href} rel="noreferrer" target="_blank" />}
          size="icon-sm"
          variant="ghost"
        >
          <RiExternalLinkLine />
        </Button>
      ) : (
        <Button
          aria-label="Open in new tab"
          className={cn(SQUARE, OFF_FOCUSABLE.className)}
          disabled
          focusableWhenDisabled={OFF_FOCUSABLE.focusableWhenDisabled}
          size="icon-sm"
          variant="ghost"
        >
          <RiExternalLinkLine />
        </Button>
      )}
    </Hint>
  )
}

// A page's square that opens it full screen, in the viewer over the page.
export function FullScreen({ onClick }: { onClick: () => void }) {
  return (
    <Hint content="Full screen" description={null}>
      <Button
        aria-label="Full screen"
        className={SQUARE}
        onClick={onClick}
        size="icon-sm"
        variant="ghost"
      >
        <RiFullscreenLine />
      </Button>
    </Hint>
  )
}

// A page's square that opens it in an aside tab of its own, beside the chat.
export function SidePanel({ onClick }: { onClick: () => void }) {
  return (
    <Hint content="Open in side panel" description={null}>
      <Button
        aria-label="Open in side panel"
        className={SQUARE}
        onClick={onClick}
        size="icon-sm"
        variant="ghost"
      >
        <RiLayoutRightLine />
      </Button>
    </Hint>
  )
}

// Saves a file, or both sides of a before/after pair one after the other, through the Inbox's route in its download mode, under the name the API builds from its item's title.
export async function saveItem(item: ViewerItem): Promise<void> {
  if (item.page) return saveFrom(item.page.download)
  for (const file of item.pair ? [item.pair.before, item.pair.after] : [item])
    await saveFrom(attachmentDownloadUrl(file.id))
}

// Saves the shown file, or both sides of a before/after pair, under its item's title, as the API names it, Download in its tooltip; off while it saves, and a failed save shows a warning in its place and says so in its name and tooltip, so another press tries again. label names it where several sit together, a tile's naming its file.
export function Download({
  className = SQUARE,
  item,
  label = "Download",
}: {
  className?: string
  item: ViewerItem
  label?: string
}) {
  const [state, setState] = useState<"failed" | "idle" | "saving">("idle")
  const save = async () => {
    setState("saving")
    try {
      await saveItem(item)
      setState("idle")
    } catch {
      setState("failed")
    }
  }
  return (
    <Hint
      content={state === "failed" ? "Download failed, try again" : "Download"}
      description={null}
    >
      <Button
        aria-label={state === "failed" ? `${label} failed, try again` : label}
        className={cn(className, state === "saving" && OFF_FOCUSABLE.className)}
        disabled={state === "saving"}
        focusableWhenDisabled={OFF_FOCUSABLE.focusableWhenDisabled}
        onClick={save}
        size="icon-sm"
        variant="ghost"
      >
        {state === "failed" ? (
          <RiErrorWarningLine className="text-destructive" />
        ) : (
          <RiDownloadLine />
        )}
      </Button>
    </Hint>
  )
}

// The Inbox's viewer: full screen over the page on a see-through stage, the stock Dialog overlay's dim and blur, in Slider mode, one file filling the screen at a time, as slides, the file filling it edge to edge, fitted to whichever side runs out first, and one floating bar, the aside's own (FLOATING_BAR), that rises only while the pointer is near the bottom edge or a key has focus in it. The arrows, a swipe or the ‹ › buttons move it (a jump where motion is reduced), Esc or X closes it, and focus stays inside, the stock Dialog's. The bar holds ‹, where it stands ("2 / 6") and ›, the file's name, then Download, Open in new tab, Open in side panel where the viewer opens from the aside (onSidePanel) and X, each naming itself in a tooltip. index is the slide shown, which the viewer reports as it moves.
export function Viewer({
  index,
  items,
  onIndexChange,
  onOpenChange,
  onSidePanel,
  open,
}: {
  index: number
  items: ViewerItem[]
  onIndexChange: (index: number) => void
  onOpenChange: (open: boolean) => void
  onSidePanel?: (item: ViewerItem) => void
  open: boolean
}) {
  const [api, setApi] = useState<CarouselApi>()
  const [near, setNear] = useState(false)
  const pinned = pinsBars(items[index]?.kind ?? "image", useNoHover())
  // the slide it opens on, held while it is open: a startIndex that followed index would re-init the carousel on every move, so no slide ever animated; the bars go down at each open or close, since closing with X fires no pointerleave
  const [start, setStart] = useState(index)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    setNear(false)
    if (open) setStart(index)
  }
  // focus opens on the stage, not a button in the bar, so the first arrow moves the slide and the bar stays down until wanted
  const stage = useRef<HTMLDivElement>(null)
  // a touch has no hover: a tap on the stage shows or hides the bottom bar, the corner Close staying (a swipe's click embla swallows), and a lifted finger's pointerleave leaves it be
  const touched = useRef(false)
  const item = items[index]

  useEffect(() => {
    if (!api) return
    const select = () =>
      onSelect(api.selectedScrollSnap(), document.activeElement, stage.current, onIndexChange)
    api.on("select", select)
    return () => {
      api.off("select", select)
    }
  }, [api, onIndexChange])

  const go = useCallback(
    (direction: -1 | 1) => {
      const { next, wraps } = wrapStep(index, direction, items.length)
      if (api) api.scrollTo(next, wraps || reducedMotion())
      else onIndexChange(next)
    },
    [api, index, items.length, onIndexChange],
  )

  // Caught on the way down, ahead of the Carousel's own Left and Right, so every arrow moves the slide one way; a renderer that keeps its own keys marks itself OWNS_KEYS.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP_OF_KEY[event.key]
    if (!step || (event.target instanceof Element && event.target.closest(OWNS_KEYS))) return
    event.preventDefault()
    event.stopPropagation()
    go(step)
  }

  if (!item) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* a key in the viewer stays in it: React passes a portal's keys up to the card's Questionnaire, which would read a digit as Approve or Deny */}
      <DialogContent
        className="dark text-foreground top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-transparent p-0 ring-0 sm:max-w-none"
        data-slot="viewer"
        initialFocus={stage}
        onKeyDownCapture={onKeyDownCapture}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return
          setNear(false)
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return
          setNear(event.clientY >= window.innerHeight - REVEAL_PX)
        }}
        showCloseButton={false}
      >
        <DialogDescription className="sr-only">
          {KIND_LABELS[item.kind]}. Slider: the arrow keys or a swipe move between the files.
        </DialogDescription>
        {/* The viewer moves the slides itself (onKeyDownCapture above): the Carousel's own Left and Right go, since they also fired inside a renderer that owns its keys. */}
        <Carousel
          className="min-h-0 flex-1 outline-none focus-visible:bg-transparent [&>[data-slot=carousel-content]]:h-full"
          onClick={() => {
            if (!touched.current) return
            setNear(!near)
          }}
          onKeyDownCapture={undefined}
          onPointerDown={(event) => {
            touched.current = event.pointerType === "touch"
          }}
          opts={{ startIndex: start, watchDrag }}
          ref={stage}
          setApi={setApi}
          tabIndex={-1}
        >
          <CarouselContent className="h-full">
            {items.map((slide, i) => (
              <Slide
                key={slide.id}
                active={i === index}
                item={slide}
                near={Math.abs(i - index) <= 1}
                onEdge={go}
              />
            ))}
          </CarouselContent>
        </Carousel>
        {/* the top-right corner keeps a Close of its own, the place a full-screen view keeps it, always shown: a one-square floating bar, the bottom bar's own look and size */}
        <div className={cn(FLOATING_BAR, "absolute top-2 right-2 z-10")}>
          <DialogClose
            render={<Button aria-label="Close" className={SQUARE} size="icon-sm" variant="ghost" />}
          >
            <RiCloseLine />
          </DialogClose>
        </div>
        {/* a frame keeps the pointer's moves to itself, so a thin strip along the bottom edge brings the bar up over an HTML page or a PDF too */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-10 h-4"
          onPointerEnter={() => setNear(true)}
        />
        {/* while the bar hides, the aside's thin pill marks where it rises, for the pointer alone, since Tab raises the bar itself once it has passed the corner Close */}
        {!near && !pinned && (
          <button
            type="button"
            aria-label="Show controls"
            tabIndex={-1}
            className="group/handle focus-visible:ring-ring/50 absolute bottom-0 left-1/2 z-10 -translate-x-1/2 rounded-sm px-4 py-2 outline-none focus-visible:ring-2"
            onClick={() => setNear(true)}
            onPointerEnter={() => setNear(true)}
          >
            <span className="bg-popover group-hover/handle:bg-accent block h-1.5 w-10 rounded-full border shadow-md" />
          </button>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
          <div
            className={cn(
              FLOATING_BAR,
              "max-w-full transition duration-200 motion-reduce:transition-none",
              !near &&
                !pinned &&
                "pointer-events-none translate-y-[calc(100%+1rem)] opacity-0 has-focus-visible:pointer-events-auto has-focus-visible:translate-y-0 has-focus-visible:opacity-100",
            )}
            data-shown={near || pinned || undefined}
          >
            <Button
              aria-label="Previous"
              className={SQUARE}
              disabled={items.length < 2}
              onClick={() => go(-1)}
              size="icon-sm"
              variant="ghost"
            >
              {/* a chevron's glyph fills less of its box than the bar's other icons, so it takes 20px to read the same size */}
              <RiArrowLeftSLine className="size-5" />
            </Button>
            <span className={BAR_COUNT}>
              {index + 1} / {items.length}
            </span>
            <Button
              aria-label="Next"
              className={SQUARE}
              disabled={items.length < 2}
              onClick={() => go(1)}
              size="icon-sm"
              variant="ghost"
            >
              <RiArrowRightSLine className="size-5" />
            </Button>
            <Separator className="mx-1 h-5" orientation="vertical" />
            <DialogTitle className={BAR_NAME}>{item.name}</DialogTitle>
            <Download item={item} />
            <OpenInNewTab item={item} keepRoom />
            {/* a file the aside takes no tab for keeps the square's room, so the bar holds one width */}
            {onSidePanel &&
              (!item.pair && opensInAside(item.kind) ? (
                <SidePanel onClick={() => onSidePanel(item)} />
              ) : (
                ROOM
              ))}
            <Hint content="Close" description={null}>
              <DialogClose
                render={
                  <Button aria-label="Close" className={SQUARE} size="icon-sm" variant="ghost" />
                }
              >
                {/* every bar icon reads one size, 16px, the cross included */}
                <RiCloseLine />
              </DialogClose>
            </Hint>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
