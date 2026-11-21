"use client"

import { RiCodeSSlashLine, RiFilePdf2Line, RiHtml5Line, RiMarkdownLine } from "@remixicon/react"
import dynamic from "next/dynamic"
import { type Ref, useEffect, useRef, useState } from "react"

import type { KindViewer, ViewProps } from "@/components/dashboard/viewer/registry"
import { TranscriptMarkdown } from "@/components/transcript-markdown"
import { Spinner } from "@/components/ui/spinner"
import {
  asViewerPage,
  documentNonce,
  fenced,
  frameLoad,
  isPatch,
  viewerFrameMessage,
} from "@/lib/viewer"

// The patch view's package loads only when a diff or patch is shown, so every other page carries none of it.
const PatchView = dynamic(() => import("@/components/dashboard/viewer/patch-view"), {
  loading: () => <Spinner />,
  ssr: false,
})

// The file's text, read from the blob the viewer fetched it into; null while it loads or while there is no blob yet, and false when it cannot be read.
export function useText(url: string | null): string | null | false {
  const [text, setText] = useState<{ url: string; text: string | false } | null>(null)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    const show = (next: string | false) => {
      if (!cancelled) setText({ url, text: next })
    }
    fetch(url)
      .then((response) => response.text())
      .then(show, () => show(false))
    return () => {
      cancelled = true
    }
  }, [url])
  return text?.url === url ? text.text : null
}

const LOAD_GRACE_MS = 300

// An HTML page runs in a frame whose sandbox allows its own script and nothing else: no same-origin, so it reads none of the Dashboard's cookies or storage, and no popups, forms or top navigation. It is handed in as srcdoc alone, since its blob is plain text, and its Open in new tab holds it in the same sandbox (pageTab). Keys pressed in it stay in it, but for Escape, which closes the viewer, and Left or Right where the page does nothing with them, which move to the next attachment (the keys script asViewerPage puts after the page sends both, beside the policy that lets it fetch nothing). A link clicked in it opens in a tab of its own, http or https alone, and one to a place on the page scrolls there, so the frame stays on the page; a load whose page never said it was ready (a script or a refresh sent the frame off) puts the page back once, then stops on a notice, though each request that took it off has left. The frame mounts once the text has arrived, since a sandboxed frame handed its srcdoc after an empty one can stay blank.
function HtmlView({ active, item, onEdge, url }: ViewProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const page = useText(url)
  const ready = useRef(false)
  const restored = useRef(false)
  const judging = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [stopped, setStopped] = useState(false)
  useEffect(() => () => clearTimeout(judging.current), [])
  const judge = () => {
    judging.current = undefined
    const act = frameLoad(ready.current, restored.current)
    ready.current = false
    if (act === "keep") return
    // the page that left took the focus with it (to the frame, or the body), so the viewer takes it, where the arrows and Esc still reach
    const held = document.activeElement
    if (frame.current && (held === frame.current || held === document.body)) {
      frame.current.closest<HTMLElement>("[data-slot=viewer]")?.focus()
    }
    if (act === "stop") setStopped(true)
    else if (act === "restore" && frame.current && typeof page === "string") {
      restored.current = true
      frame.current.srcdoc = asViewerPage(page, documentNonce())
    }
  }
  // each load takes the ready that came with it; one still waiting when the next arrives never had one, and a ready that lands just after its load gets a moment's grace
  const onLoad = () => {
    if (judging.current) {
      clearTimeout(judging.current)
      ready.current = false
      judge()
    }
    if (ready.current) {
      ready.current = false
      return
    }
    judging.current = setTimeout(judge, LOAD_GRACE_MS)
  }
  // the shown page takes the focus once loaded, so its own arrows run it, a deck's slides included; a slide moved away from hands it back to the viewer
  const loaded = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    const el = frame.current
    if (!el) return
    if (active && loaded.current) el.focus()
    else if (!active && document.activeElement === el)
      el.closest<HTMLElement>("[data-slot=viewer]")?.focus()
  }, [active])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const el = frame.current
      if (!el || event.source !== el.contentWindow) return
      const message = viewerFrameMessage(event.data)
      if (message?.viewer === "escape") {
        el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
      } else if (message?.viewer === "edge") onEdge(message.direction)
      else if (message?.viewer === "link")
        window.open(message.href, "_blank", "noopener,noreferrer")
      else if (message?.viewer === "ready") {
        ready.current = true
        loaded.current = true
        if (activeRef.current) el.focus()
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [onEdge])
  if (page === null) return <Spinner />
  if (page === false) return <Unreadable />
  if (stopped) {
    return (
      <p className="text-muted-foreground text-xs">
        This page kept leaving for another site, so it was stopped.
      </p>
    )
  }
  return <PageFrame name={item.name} onLoad={onLoad} page={page} ref={frame} />
}

export function PageFrame({
  name,
  onLoad,
  page,
  ref,
}: {
  name: string
  onLoad?: () => void
  page: string
  ref?: Ref<HTMLIFrameElement>
}) {
  return (
    <iframe
      ref={ref}
      aria-label={name}
      className="size-full border-0 bg-white"
      data-viewer-owns-pointer
      onLoad={onLoad}
      sandbox="allow-scripts"
      srcDoc={asViewerPage(page, documentNonce())}
    />
  )
}

// A PDF opens in the browser's own viewer, which a sandboxed frame would refuse to load.
function PdfView({ item, url }: ViewProps) {
  return (
    <iframe
      aria-label={item.name}
      className="size-full border-0"
      data-viewer-owns-pointer
      src={url}
    />
  )
}

function Unreadable() {
  return <p className="text-muted-foreground text-xs">This file could not be read.</p>
}

const EDGE_OF_KEY: Record<string, -1 | 1> = { ArrowLeft: -1, ArrowRight: 1 }

// A markdown file rendered as a session's message is, or a source file highlighted, in a column that scrolls on its own. While it has focus Up and Down scroll it, and Left and Right still move the slide.
function TextView({ code, item, onEdge, url }: ViewProps & { code?: boolean }) {
  const text = useText(url)
  return (
    <div
      aria-label={item.name}
      className="bg-background size-full overflow-auto focus-visible:bg-[color-mix(in_oklab,var(--foreground)_4%,var(--background))]"
      data-viewer-owns-keys
      onKeyDown={(event) => {
        const direction = EDGE_OF_KEY[event.key]
        if (!direction) return
        event.preventDefault()
        onEdge(direction)
      }}
      role="region"
      tabIndex={0}
    >
      {/* code takes the screen's full width, prose a column wide enough to read */}
      <div className={code ? "p-6" : "mx-auto max-w-4xl p-6"}>
        {text === null ? (
          <Spinner />
        ) : text === false ? (
          <Unreadable />
        ) : (
          <ShownText code={code} name={item.name} text={text} />
        )}
      </div>
    </div>
  )
}

// A diff or patch shows as a patch view, and as the highlighted text when it holds no patch the view can draw.
export function ShownText({ code, name, text }: { code?: boolean; name: string; text: string }) {
  const shown = <TranscriptMarkdown>{code ? fenced(name, text) : text}</TranscriptMarkdown>
  return code && isPatch(name) ? <PatchView fallback={shown} text={text} /> : shown
}

export const HTML_VIEWER: KindViewer = { icon: RiHtml5Line, View: HtmlView }

export const PDF_VIEWER: KindViewer = { icon: RiFilePdf2Line, View: PdfView }

function CodeView(props: ViewProps) {
  return <TextView {...props} code />
}

export const DOC_VIEWER: KindViewer = { icon: RiMarkdownLine, View: TextView }

export const CODE_VIEWER: KindViewer = { icon: RiCodeSSlashLine, View: CodeView }
