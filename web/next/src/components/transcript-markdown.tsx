"use client"

import { measureNaturalWidth, prepare } from "@chenglou/pretext"
import { PROGRESS_LANGUAGE, progressItems } from "@packages/config/inbox"
import {
  RiAlertLine,
  RiErrorWarningLine,
  RiFeedbackLine,
  RiInformationLine,
  RiLightbulbLine,
} from "@remixicon/react"
import { cn } from "cn"
import {
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react"
import {
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from "streamdown"

import { SessionsContext } from "@/components/dashboard/dashboard"
import { Hint } from "@/components/hint"
import { ProgressBlock } from "@/components/progress-block"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { remarkMentions } from "@/lib/agent-label"
import { config } from "@/lib/config"
import { remarkLineBreaks, viewWorker } from "@/lib/dashboard"
import { ownImageSrc, rehypeCallouts, transcriptLink, transcriptUrls } from "@/lib/markdown"

// Every message keeps its line breaks as written, his, a peer's and a session's own reply alike, as the terminal shows them; markdown alone would fold a single newline into its paragraph.
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkLineBreaks]

// Streamdown's own raw, sanitise and harden steps first, so a raw tag's attributes are gone before a quote is read as a callout.
const REHYPE_PLUGINS = [...Object.values(defaultRehypePlugins), rehypeCallouts]

const ORIGINS = [config.api.url, config.app.url]

export const transcriptUrlTransform = transcriptUrls(ORIGINS, config.app.url)

// The owner trusts the links opened here, so Streamdown's click-through prompt stays off; TranscriptLink is what keeps a link safe.
const LINK_SAFETY = { enabled: false }

// Markdown images and raw <img> tags alike arrive here: only our own attachments and preview images load, and any other image shows as text naming it, its URL on hover. A loaded image sits in a box of fixed height from first paint, so the rows below it never move when it arrives.
function TranscriptImage({ alt, src }: ComponentProps<"img">) {
  const own = typeof src === "string" ? ownImageSrc(src, ORIGINS) : null
  const label = alt ? `[image: ${alt}]` : "[image]"
  if (!own)
    return (
      <Hint content={typeof src === "string" ? src : undefined}>
        <span>{label}</span>
      </Hint>
    )
  return (
    <span className="block h-48 w-fit">
      <img src={own} alt={alt ?? ""} className="max-h-full max-w-full rounded-md" />
    </span>
  )
}

// A footnote's reference keeps its id, which its back-link jumps to, and both keep the attributes that name them; no other attribute of the tag passes. A raw tag's id is not prefixed, so only a footnote's (user-content-) passes, never one of the page's own.
const FOOTNOTE_PROPS = [
  "aria-describedby",
  "aria-label",
  "data-footnote-backref",
  "data-footnote-ref",
  "id",
] as const

// Markdown links, autolinks and raw <a> tags alike arrive here, after transcriptUrlTransform: an http or https link opens at once, another site's in a new tab with no opener or referrer, our own in this one, and any other href shows as its text. target and rel are set here last, so a raw tag's own cannot change them. A link to a live agent's view (an @Name) keeps the agent's raw session name on hover, as the sender label does.
function TranscriptLink({ children, href, ...props }: ComponentProps<"a">) {
  const { sessions } = use(SessionsContext)
  const link = typeof href === "string" ? transcriptLink(href, config.app.url) : null
  const worker = sessions && link && !link.external ? viewWorker(link.href, sessions) : null
  if (!link) return <span>{children}</span>
  const kept = Object.fromEntries(
    FOOTNOTE_PROPS.flatMap((name) =>
      name in props ? [[name, props[name as keyof typeof props]]] : [],
    ),
  )
  if (!String(kept.id ?? "").startsWith("user-content-")) delete kept.id
  const anchor = (
    <a
      {...kept}
      className="text-primary font-medium wrap-anywhere underline"
      data-streamdown="link"
      href={link.href}
      {...(link.external ? { rel: "noopener noreferrer", target: "_blank" } : {})}
    >
      {children}
    </a>
  )
  return worker ? <Hint content={worker.name}>{anchor}</Hint> : anchor
}

type Titled = Pick<
  Element,
  "getAttribute" | "hasAttribute" | "removeAttribute" | "setAttribute" | "textContent"
>

// Drops each element's title, so no browser box shows, first keeping it for a screen reader as the title gave it: the name of an element with no words and no aria-label (Streamdown's Copy table and Download table buttons), else its description, when it says more than the name.
export function untitle(elements: Iterable<Titled>) {
  for (const el of elements) {
    const title = el.getAttribute("title")?.trim()
    if (title) {
      const name = el.getAttribute("aria-label")?.trim() || el.textContent?.trim()
      if (!name) el.setAttribute("aria-label", title)
      else if (name !== title && !el.hasAttribute("aria-description"))
        el.setAttribute("aria-description", title)
    }
    el.removeAttribute("title")
  }
}

const UNTITLED = { attributeFilter: ["title"], childList: true, subtree: true }

// Streamdown portals its overlays (a table's fullscreen view, with its own titled buttons) to the page's body, outside each transcript's observer, so they go into one node on the body that one observer keeps free of titles, made the first time an overlay opens.
export function overlaysIn(doc: Document, Observer: typeof MutationObserver = MutationObserver) {
  const found = doc.querySelector<HTMLElement>("[data-transcript-overlays]")
  if (found) return found
  const node = doc.createElement("div")
  node.dataset.transcriptOverlays = ""
  doc.body.append(node)
  new Observer(() => untitle(node.querySelectorAll("[title]"))).observe(node, UNTITLED)
  return node
}

const transcriptOverlays = () => overlaysIn(document)

// Each GitHub callout kind's icon, colour and title, the colours from the theme's status tokens. The colour sits on the Alert, which its icon and title take (Alert's own `*:[svg]:text-current`), while its words keep the description's.
const CALLOUTS = {
  caution: { className: "text-destructive", Icon: RiErrorWarningLine, title: "Caution" },
  important: { className: "text-caution", Icon: RiFeedbackLine, title: "Important" },
  note: { className: "text-info", Icon: RiInformationLine, title: "Note" },
  tip: { className: "text-success", Icon: RiLightbulbLine, title: "Tip" },
  warning: { className: "text-warning", Icon: RiAlertLine, title: "Warning" },
} as const

const { blockquote: Blockquote, code: StreamdownCode } = defaultComponents

// A quote rehypeCallouts marked shows as shadcn's Alert under its kind's title; any other quote is Streamdown's own.
function TranscriptBlockquote(props: ComponentProps<typeof Blockquote>) {
  const kind = (props as { "data-callout"?: unknown })["data-callout"]
  const callout =
    typeof kind === "string" && kind in CALLOUTS ? CALLOUTS[kind as keyof typeof CALLOUTS] : null
  if (!callout) return <Blockquote {...props} />
  const { className, Icon, title } = callout
  return (
    <Alert role="note" data-callout={kind} className={cn("my-4", className)}>
      <Icon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{props.children}</AlertDescription>
    </Alert>
  )
}

// A session's headings read as structure, not as a billboard: every level sits near the body's size, semibold with tight margins, so a pasted heading never dwarfs the words around it and no deeper level outgrows a shallower one (the stream's words, thinking and tool output).
const transcriptHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", size: string) => {
  function Heading({
    className,
    // react-markdown's own node never reaches the DOM
    node: _node,
    ...props
  }: ComponentProps<"h1"> & { node?: unknown }) {
    return <Tag {...props} className={cn("mt-3 mb-1 font-semibold first:mt-0", size, className)} />
  }
  return Heading
}

// The language a fenced block's language-<name> class names, or none.
const languageOf = (className?: string) => /language-(\S+)/.exec(className ?? "")?.[1] ?? ""

// A fenced block draws as shadcn's CodeBlock, one border with nothing around it, its tokens from shadcn's own highlighter in the theme's light or dark colours, on the page's background so they read on any bubble, its long lines wrapping, and Copy over its top-right corner on hover and focus; a progress block whose every line reads draws as its bars instead. Streamdown's pre marks a fenced block's code data-block, so inline code stays Streamdown's, and names its language in a language-<name> class.
const transcriptCode = (card: boolean) => {
  function TranscriptCode(props: ComponentProps<typeof StreamdownCode>) {
    if (!("data-block" in props)) return <StreamdownCode {...props} />
    const { children, className } = props
    const text = typeof children === "string" ? children : ""
    const progress = languageOf(className) === PROGRESS_LANGUAGE ? progressItems(text) : null
    if (progress?.ok) return <ProgressBlock items={progress.items} />
    return <FencedCode card={card} className={className} text={text} />
  }
  return TranscriptCode
}

// A block with no language or a plain-text one is a drawing whose columns must line up.
const DRAWING = new Set(["", "ascii", "text", "txt"])

const MEASURE_PX = 100

// The stock added line is muted gray, which reads as a highlight; it takes the success tint, as removed takes the destructive one.
const ADDED = "bg-success/10 after:text-success"

// A diff's added or removed line takes code-block's own variant, whose marker shows its sign, so its text drops the sign; a file header (--- or +++) stays a plain line.
const diffLine = (line: string) =>
  /^(\+\+\+|---)( |$)/.test(line) || !/^[+-]/.test(line)
    ? null
    : { text: line.slice(1), variant: line[0] === "+" ? ("added" as const) : ("removed" as const) }

// A drawing's widest line in em, measured in its own font with pretext once the fonts load; null until then, and off the card.
function useWidestEm(code: string, drawing: boolean, pre: RefObject<HTMLPreElement | null>) {
  const [em, setEm] = useState<number | null>(null)
  useEffect(() => {
    const el = pre.current
    if (!drawing || !el) return
    let live = true
    void document.fonts.ready.then(() => {
      const font = `${MEASURE_PX}px ${getComputedStyle(el).fontFamily}`
      const width = measureNaturalWidth(prepare(code, font, { whiteSpace: "pre-wrap" }))
      if (live) setEm(width / MEASURE_PX)
    })
    return () => {
      live = false
    }
  }, [code, drawing, pre])
  return em
}

// On a card a drawing never wraps: its font shrinks from text-xs until its widest line fits the block's width less the pre's 1.25rem padding, down to 10px, and only then does it scroll sideways; the container query keeps it fitted as the card resizes, with no layout read.
export const fitWidth = (em: number) => `clamp(10px, calc((100cqi - 1.25rem) / ${em}), 12px)`

function FencedCode({
  card,
  className,
  text,
}: {
  card: boolean
  className?: string
  text: string
}) {
  const language = languageOf(className)
  const code = text.replace(/\n$/, "")
  const lines = useHighlightedCode(code, language)
  const diffs = language === "diff" ? code.split("\n").map(diffLine) : []
  const drawing = card && DRAWING.has(language)
  const pre = useRef<HTMLPreElement>(null)
  const em = useWidestEm(code, drawing, pre)
  return (
    <CodeBlock
      // the table's and a file tile's border, not the input's brighter one
      className={cn("bg-background dark:bg-background border-border my-3", drawing && "@container")}
      data-language={language || undefined}
      size={card ? "sm" : "default"}
    >
      <Hint content="Copy code" description={null}>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </Hint>
      {/* a drawing's rows sit close enough that box-drawing lines join, tree and flow alike */}
      <CodeBlockContent
        className={cn(card && "data-wrap:wrap-anywhere", DRAWING.has(language) && "leading-[1.3]")}
        ref={pre}
        style={em ? { fontSize: fitWidth(em) } : undefined}
        wrap={!drawing}
      >
        {lines.map((line, index) => {
          const diff = diffs[index]
          return (
            <CodeBlockLine
              className={diff?.variant === "added" ? ADDED : undefined}
              key={index}
              variant={diff?.variant}
            >
              {diff ? diff.text : line}
            </CodeBlockLine>
          )
        })}
      </CodeBlockContent>
    </CodeBlock>
  )
}

// react-markdown hands each component its node, which no DOM element takes
const tablePart = <P extends object>(Part: (props: P) => ReactNode) => {
  function TranscriptTablePart({ node: _node, ...props }: P & { node?: unknown }) {
    return <Part {...(props as P)} />
  }
  return TranscriptTablePart
}

// A table draws as shadcn's Table in one bordered box, with no row kept for actions above it.
function TranscriptTable(props: ComponentProps<"table">) {
  return (
    <div className="my-3 overflow-hidden rounded-md border">
      <Table {...props} />
    </div>
  )
}

// Streamdown components for any text from a session's transcript. A <picture>'s <source srcset> is a fetch no URL check sees, so it never renders; the <img> inside the picture still goes through TranscriptImage.
export const TRANSCRIPT_COMPONENTS = {
  a: TranscriptLink,
  blockquote: TranscriptBlockquote,
  code: transcriptCode(false),
  h1: transcriptHeading("h1", "text-base"),
  h2: transcriptHeading("h2", "text-sm"),
  h3: transcriptHeading("h3", "text-sm"),
  h4: transcriptHeading("h4", "text-sm"),
  h5: transcriptHeading("h5", "text-sm"),
  h6: transcriptHeading("h6", "text-sm"),
  img: TranscriptImage,
  source: () => null,
  table: tablePart(TranscriptTable),
  tbody: tablePart(TableBody),
  td: tablePart(TableCell),
  th: tablePart(TableHead),
  thead: tablePart(TableHeader),
  tr: tablePart(TableRow),
}

// An Inbox card's code reads at text-xs, so a block sits beside the card's own words, wrapping at any character so a long token never widens the card, and its table cells wrap too, so a long cell breaks onto lines within the card rather than scrolling the table a card's width sideways.
const CARD_COMPONENTS = {
  ...TRANSCRIPT_COMPONENTS,
  code: transcriptCode(true),
  td: tablePart((props: ComponentProps<typeof TableCell>) => (
    <TableCell {...props} className={cn("whitespace-normal", props.className)} />
  )),
  th: tablePart((props: ComponentProps<typeof TableHead>) => (
    <TableHead {...props} className={cn("whitespace-normal", props.className)} />
  )),
}

// Streamdown colours a link with the primary colour and inline code with the muted one, so each vanishes on a bubble of the same colour: his message sits on primary (light in the dark theme, dark in the light one), a session's own on muted. on names the bubble the text sits on, and its links and inline code take colours that stand out there; a code block keeps the page's own background and colours on every bubble.
const ON_BUBBLE = {
  default:
    "[&_[data-streamdown=link]]:text-current [&_[data-streamdown=link]]:decoration-current/60 [&_[data-streamdown=link]:hover]:decoration-current [&_[data-streamdown=inline-code]]:bg-primary-foreground/15 [&_[data-streamdown=inline-code]]:text-current",
  muted: "[&_[data-streamdown=inline-code]]:bg-background",
  none: "",
  tinted: "[&_[data-streamdown=inline-code]]:bg-background/60",
} as const

export type TranscriptSurface = keyof typeof ON_BUBBLE

// Text from a session's transcript, or on its way to one, as markdown that loads nothing from elsewhere. Every place the dashboard shows transcript text renders it through here, or passes TRANSCRIPT_COMPONENTS and transcriptUrlTransform to its own Streamdown.
export function TranscriptMarkdown({
  card = false,
  children,
  on = "none",
}: {
  card?: boolean
  children: string
  on?: TranscriptSurface
}) {
  // an @Name that names a live agent links to its view, as the sender label does
  const { mentions } = use(SessionsContext)
  const plugins = useMemo(
    () => (mentions ? [...REMARK_PLUGINS, remarkMentions(mentions)] : REMARK_PLUGINS),
    [mentions],
  )
  // Streamdown's own code and table buttons, and a raw tag a session printed, carry a native title; each loses it (untitle), so no browser box shows here
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const strip = () => untitle(el.querySelectorAll("[title]"))
    strip()
    const observer = new MutationObserver(strip)
    observer.observe(el, UNTITLED)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={root} className="contents">
      <Streamdown
        className={ON_BUBBLE[on]}
        components={card ? CARD_COMPONENTS : TRANSCRIPT_COMPONENTS}
        linkSafety={LINK_SAFETY}
        portal={transcriptOverlays}
        rehypePlugins={REHYPE_PLUGINS}
        remarkPlugins={plugins}
        urlTransform={transcriptUrlTransform}
      >
        {children}
      </Streamdown>
    </div>
  )
}
