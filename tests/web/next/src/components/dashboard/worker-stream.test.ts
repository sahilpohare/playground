import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  SessionsContext,
  sessionsOf,
} from "../../../../../../web/next/src/components/dashboard/dashboard"
import {
  OlderSteps,
  PeerStep,
  ReasoningStep,
  sameStep,
  sameTool,
  StepRow,
  ToolStep,
} from "../../../../../../web/next/src/components/dashboard/worker-stream"
import { drawingOf, keepMakerIcon } from "../../../../../../web/next/src/lib/model-icons"

// React resolves from the web app's own packages, which this directory cannot see; the two calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
type CreateElement = (type: unknown, props?: unknown, ...children: Node[]) => Node
const web = join(import.meta.dir, "../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: CreateElement
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}
const { QueryClient, QueryClientProvider } = (await import(
  Bun.resolveSync("@tanstack/react-query", web)
)) as { QueryClient: new () => unknown; QueryClientProvider: unknown }

const { RiGitBranchLine } = (await import(Bun.resolveSync("@remixicon/react", web))) as Record<
  "RiGitBranchLine",
  unknown
>

const older = { load: () => {}, state: "idle" as const }
const render = (shown: boolean) => renderToStaticMarkup(createElement(OlderSteps, { older, shown }))
const classesOf = (html: string) => new Set(/class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [])

describe("OlderSteps", () => {
  test("before any step it is laid out but invisible, so the steps arriving push nothing down (Playground's chat shifted 0.0113)", () => {
    const before = render(false)
    const after = render(true)
    expect(before).toContain("Load older")
    expect(classesOf(before).has("invisible")).toBe(true)
    expect(classesOf(after).has("invisible")).toBe(false)
    // the same row in the same box either way, the one class aside
    expect(before.replace(/ invisible/, "")).toBe(after)
  })

  // The edge of what is loaded is a Checkpoint holding its one button.
  test("its button sits in a Checkpoint, one button focusable while disabled, its state words unchanged", () => {
    const start = renderToStaticMarkup(
      createElement(OlderSteps, { older: { load: () => {}, state: "done" }, shown: true }),
    )
    for (const html of [render(true), start]) {
      expect(/<div [^>]*data-slot="marker"[^>]*>/.exec(html)?.[0]).toContain(
        'data-variant="default"',
      )
      const content = html.slice(html.indexOf('data-slot="marker-content"'))
      expect(content.split("<button").length).toBe(2)
    }
    expect(start).toContain("The start of the session")
    expect(start).toContain('data-slot="marker-icon"')
    const button = start.split("<button")[1]?.split(">")[0] ?? ""
    expect(button).toContain('aria-disabled="true"')
    expect(button).not.toMatch(/ disabled[ =]/)
  })
})

// The loading dot sat at the very top after a restart, then shifted; it holds the centre of the stream instead. The stream needs the dashboard's context to render, so its loading state is read from the source.
test("the first load's spinner sits in the middle of the pane, never at the top", async () => {
  const source = await Bun.file(join(web, "src/components/dashboard/worker-stream.tsx")).text()
  const loading = source.slice(
    source.indexOf("loading && steps.length === 0"),
    source.indexOf("<Empty>"),
  )
  expect(loading).toContain("<CenterSpinner />")
  expect(source).toContain('className="relative min-h-0 shrink-0 grow gap-4 pb-9"')
  expect(source).toContain("{key === newest ? status : null}")
})

// Sessions read by name, not by model (#i520): the status line, the empty state and the steps' name read as the heading and the box do
test("the stream names its session as its chat does, a dispatcher by its label, never its name", async () => {
  const source = await Bun.file(join(web, "src/components/dashboard/worker-stream.tsx")).text()
  expect(source).not.toContain("agentLabel(worker.name)")
  expect(source).toContain("chatLabel(worker, dispatcher)")
})

// The retry note carries its own dot before its why, so the footer adds none after it.
test("the retry note shows as written, with no dot after it", async () => {
  const source = await Bun.file(join(web, "src/components/dashboard/worker-stream.tsx")).text()
  expect(source).toContain('{note ? <span aria-hidden="true">{note}</span> : null}')
  expect(source).not.toMatch(/\{note\} ?·/)
})

const toolPart = (state: string, more: Record<string, unknown> = {}) => ({
  input: { json: '{"command":"ls"}', summary: "List files" },
  state,
  title: "Bash",
  toolCallId: "t1",
  toolName: "Bash",
  type: "dynamic-tool",
  ...more,
})
const renderTool = (state: string, more: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ToolStep, { part: toolPart(state, more) }))
const source = () => Bun.file(join(web, "src/components/dashboard/worker-stream.tsx")).text()

// a tool call is AI Elements' Tool, a Trace line opening to CodeBlocks; its thinking is its Reasoning.
describe("ToolStep", () => {
  test("its row is one Trace line at 12, its name and summary in the line", () => {
    const html = renderTool("output-available", { output: { agentId: null, text: "a.txt" } })
    expect(html).toContain('data-slot="trace-collapsible-trigger"')
    expect(html).toMatch(/data-slot="trace-line"[^>]*class="[^"]*\btext-xs\b/)
    expect(html).toContain(">Bash</span> List files")
  })

  test("a running call says so and shimmers, a failed one is red and says so, a finished one says neither", async () => {
    const running = renderTool("input-available")
    expect(running).toContain('data-status="running"')
    expect(running).toContain("Running: ")
    // the shimmer stops under reduced motion, so the pulsing dot in the icon slot is the cue that holds
    expect(running).toMatch(/data-slot="trace-icon"[^>]*><svg[^>]*data-slot="pulse-dot"/)
    const failed = renderTool("output-error", { errorText: "denied" })
    expect(failed).toContain('data-status="error"')
    expect(failed).toContain("Failed: ")
    expect(failed).not.toContain('data-slot="pulse-dot"')
    // and the warning icon in its slot, so a failure is not said by colour alone
    const { RiErrorWarningLine, RiToolsLine } = (await import(
      Bun.resolveSync("@remixicon/react", web)
    )) as Record<string, unknown>
    const warning = renderToStaticMarkup(createElement(RiErrorWarningLine))
    const icon = failed.slice(failed.indexOf('data-slot="trace-icon"'))
    expect(icon.slice(icon.indexOf(">") + 1).startsWith(warning)).toBe(true)
    expect(running).not.toContain(warning)
    expect(failed).not.toContain(renderToStaticMarkup(createElement(RiToolsLine)))
    const done = renderTool("output-available", { output: { agentId: null, text: "a.txt" } })
    expect(done).not.toContain('data-slot="pulse-dot"')
    expect(done).not.toContain('data-status="')
    expect(done).not.toContain("Running: ")
    expect(done).not.toContain("Failed: ")
  })

  test("its row starts closed", () => {
    expect(renderTool("output-available", { output: { agentId: null, text: "a.txt" } })).toContain(
      'aria-expanded="false"',
    )
  })
})

// each new step of a turn hands its older calls in as new objects, so a row compares what it shows, not the object
describe("ToolStep's redraw", () => {
  // the helper's calls carry a plain string state, so the compare is taken loosely
  const compare = sameTool as (a: unknown, b: unknown) => boolean
  const done = { output: { agentId: null, text: "a.txt" } }
  const props = (state: string, more: Record<string, unknown> = {}) => ({
    part: toolPart(state, more),
  })

  test("a copy of the same call draws nothing again", () => {
    expect(compare(props("output-available", done), props("output-available", done))).toBe(true)
  })

  test("a call whose state, input, output, error or title moved draws again", () => {
    const base = props("output-available", done)
    expect(compare(base, props("input-available"))).toBe(false)
    expect(
      compare(base, props("output-available", { output: { agentId: null, text: "b.txt" } })),
    ).toBe(false)
    expect(
      compare(
        base,
        props("output-available", { ...done, input: { json: "{}", summary: "List files" } }),
      ),
    ).toBe(false)
    expect(
      compare(
        base,
        props("output-available", {
          ...done,
          input: { json: '{"command":"ls"}', summary: "Other" },
        }),
      ),
    ).toBe(false)
    expect(compare(base, props("output-error", { errorText: "denied" }))).toBe(false)
    expect(compare(base, props("output-available", { ...done, title: "Read" }))).toBe(false)
  })
})

// the stream's now moves on every inbox read, every 5s, so a row compares what the clock shows in it (the day changing, the owner's Undo), not the moment; a row it leaves keeps its render count
describe("StepRow's redraw on a tick", () => {
  const compare = sameStep as (a: unknown, b: unknown) => boolean
  // local times, so the day a time names is the same in every zone the suite runs in
  const AT = new Date(2026, 9, 6, 12, 0, 0)
  const later = (ms: number) => new Date(AT.getTime() + ms)
  const at = AT.toISOString()
  const outbox = {}
  const worker = { name: "dispatcher", sessionId: "s1", tasks: [] }
  const assistant = {
    id: "a1",
    metadata: { at, from: null, kind: "assistant" },
    parts: [{ text: "done", type: "text" }],
    role: "assistant",
  }
  const human = {
    id: "e1",
    metadata: { at, from: null, kind: "human" },
    parts: [{ text: "hello", type: "text" }],
    role: "user",
  }
  const sent = {
    at,
    attachments: [],
    attempts: 1,
    code: null,
    deliveredAt: at,
    entryId: "e1",
    id: "m1",
    reason: null,
    retryAt: null,
    sawPicker: false,
    sessionId: "s1",
    state: "delivered",
    text: "hello",
    to: "dispatcher",
    typedAt: at,
    unanswered: false,
    unreached: 0,
  }
  const props = (message: unknown, now: Date, more: Record<string, unknown> = {}) => ({
    composer: "composer",
    marker: null,
    message,
    newest: true,
    now,
    outbox,
    sent: null,
    waiting: false,
    worker,
    ...more,
  })

  test("a tick that moves no row's shown time draws no row again", () => {
    for (const message of [assistant, human]) {
      expect(compare(props(message, later(5_000)), props(message, later(10_000)))).toBe(true)
    }
    expect(
      compare(props(human, later(30_000), { sent }), props(human, later(35_000), { sent })),
    ).toBe(true)
  })

  test("a tick into the next day draws the row again, since its time then names its day", () => {
    const night = new Date(2026, 9, 6, 23, 59, 58)
    const morning = new Date(2026, 9, 7, 0, 0, 3)
    expect(compare(props(assistant, night), props(assistant, morning))).toBe(false)
  })

  test("a tick that closes the owner's newest message's Undo draws it again", () => {
    expect(
      compare(props(human, later(119_000), { sent }), props(human, later(121_000), { sent })),
    ).toBe(false)
  })
})

describe("ToolStep's open row", () => {
  test("its input and output are plain text in CodeBlocks with no language: markup in them renders as its characters", async () => {
    const text = await source()
    const tool = text.slice(text.indexOf("function ToolText"), text.indexOf("function ToolOutput"))
    expect(tool).toContain('<CodeBlock size="sm"')
    expect(tool).toContain("<CodeBlockContent wrap")
    expect(tool).not.toContain("language")
    const { CodeBlock, CodeBlockContent } =
      await import("../../../../../../web/next/src/components/ui/code-block")
    const html = renderToStaticMarkup(
      createElement(
        CodeBlock,
        { size: "sm" },
        createElement(CodeBlockContent, { wrap: true }, '<img src="https://example.com/x.png">'),
      ),
    )
    expect(html).toContain("&lt;img src=")
    expect(html).not.toContain('<img src="https://example.com')
    expect(html).toMatch(/data-size="sm"[^>]*class="[^"]*data-\[size=sm\]:text-xs/)
    expect(html).toMatch(/<pre[^>]*class="[^"]*\bfont-mono\b/)
  })

  test("a failed call opens to its error, in the destructive block", () => {
    const html = renderToStaticMarkup(
      createElement(ToolStep, {
        defaultOpen: true,
        part: toolPart("output-error", { errorText: "denied" }),
      }),
    )
    const block = html.slice(html.indexOf('data-variant="destructive"'))
    expect(block).toContain(">Error<")
    expect(block).toContain("denied")
    expect(html).toContain("{&quot;command&quot;:&quot;ls&quot;}")
  })

  test("a call that returned opens to what it returned", () => {
    const html = renderToStaticMarkup(
      createElement(ToolStep, {
        defaultOpen: true,
        part: toolPart("output-available", { output: { agentId: null, text: "a.txt" } }),
      }),
    )
    expect(html).toContain(">Result<")
    expect(html).toContain("a.txt")
    expect(html).not.toContain('data-variant="destructive"')
  })
})

describe("ReasoningStep", () => {
  test("starts closed: a transcript's thinking is whole when read, so nothing opens it on its own", () => {
    const html = renderToStaticMarkup(createElement(ReasoningStep, { text: "weighing it" }))
    expect(html).toContain("Thought")
    expect(html).not.toContain("weighing it")
  })

  test("open, its words render through TranscriptMarkdown, so a remote image shows as its alt text", () => {
    const html = renderToStaticMarkup(
      createElement(ReasoningStep, {
        defaultOpen: true,
        text: "weighing it ![chart](https://example.com/chart.png)",
      }),
    )
    expect(html).toContain("weighing it")
    expect(html).toContain("[image: chart]")
    expect(html).not.toContain("https://example.com/chart.png")
  })
})

// The typed hold is wiring inside the stream, which needs the dashboard's context to render, so it is pinned on the source like the loading spinner above; tests/web/next/src/hooks/use-typed-hold.test.ts runs the hook itself.
test("a typed message's Dismiss waits on its own hold", async () => {
  const source = await Bun.file(join(web, "src/components/dashboard/worker-stream.tsx")).text()
  expect(source).toContain("const dismissHeld = useTypedHold(message.typedAt)")
  expect(source).toContain("pendingAction(message, { busy, held: dismissHeld })")
})

// Copy on another session's message gives the words its row shows, so copying never hands back the sender's name line the row hides.
test("another session's Copy takes the words its row shows, not the raw text", async () => {
  const source = await Bun.file(join(web, "src/components/dashboard/worker-stream.tsx")).text()
  const peer = source.slice(source.indexOf("const peer ="), source.indexOf("const ROOM_UNDER"))
  expect(peer).toContain("const shown = peer && sender ? withoutSenderName(text, sender) : text")
  expect(peer).toContain("<PeerStep chips={chips} from={from} text={shown} />")
  expect(peer).not.toContain("copy={text}")
  const row = source.slice(
    source.indexOf("export function PeerStep"),
    source.indexOf("const Step = memo"),
  )
  expect(row).toContain("<CopyMessage text={text} />")
})

// Another session's message reads as something the session received, folded as a tool row, so the chat reads as the owner and the session they talk to.
describe("another session's message", () => {
  const T0 = "2026-10-06T00:00:00.000Z"
  const TEXT = "PR #12 merged.\n\nThe sha is abc123, and the next PR is #13."
  const wrap = (node: Node) =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node))
  const row = (text = TEXT) =>
    wrap(
      createElement(StepRow, {
        composer: "composer",
        marker: null,
        message: {
          id: "p1",
          metadata: { at: T0, from: "builder", kind: "peer" },
          parts: [{ text, type: "text" }],
          role: "user",
        },
        newest: true,
        now: new Date(T0),
        outbox: {},
        sent: null,
        waiting: false,
        worker: { name: "dispatcher", sessionId: "s1", tasks: [] },
      }),
    )

  test("draws closed as a tool row as a sent message reads: Received alone bright, then from its sender and its first line", () => {
    const html = row()
    expect(html).toContain('data-slot="trace-collapsible-trigger"')
    expect(html).toMatch(/data-slot="trace-line"[^>]*class="[^"]*\btext-xs\b/)
    expect(html).toContain("Received</span> from Builder: PR #12 merged.")
    expect(html).not.toContain("The sha is abc123")
    expect(html).not.toContain('data-slot="message"')
  })

  test("a sender's own name line stays out of its row", () => {
    expect(row("builder: PR #12 merged.\nmore")).toContain(
      "Received</span> from Builder: PR #12 merged.",
    )
  })

  test("opens to its whole text, its sender linked", () => {
    const html = wrap(
      createElement(
        SessionsContext,
        {
          value: sessionsOf(
            [{ name: "builder", sessionId: "s2" }] as unknown as Parameters<typeof sessionsOf>[0],
            null,
          ),
        },
        createElement(PeerStep, { chips: [], defaultOpen: true, from: "builder", text: TEXT }),
      ),
    )
    expect(html).toContain("The sha is abc123, and the next PR is #13.")
    expect(html).toMatch(/From <a [^>]*>Builder<\/a>/)
  })
})

// A message keeps its ticks across a reload: a reload keeps only unsent records, so the owner's message the transcript holds draws Delivered with no record.
describe("StepRow's footer after a reload", () => {
  const T0 = "2026-10-06T00:00:00.000Z"
  const render = (kind: "human" | "peer") =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(StepRow, {
          composer: "composer",
          marker: null,
          message: {
            id: "e1",
            metadata: { at: T0, from: null, kind },
            parts: [{ text: "hello", type: "text" }],
            role: "user",
          },
          newest: true,
          now: new Date(T0),
          outbox: {},
          sent: null,
          waiting: false,
          worker: { name: "dispatcher", sessionId: "s1", tasks: [] },
        }),
      ),
    )
  test("his message with no outbox record draws Delivered", () => {
    expect(render("human")).toContain("Delivered")
  })
  test("another session's message draws no Delivered", () => {
    expect(render("peer")).not.toContain("Delivered")
  })
})

// an image's attachment went unseen while the message alone showed. A transcript read that misses an image's source line leaves the image with no id, which the entry cannot draw, so the outbox record's files draw instead.
test("his delivered message draws the files its outbox record holds, though the transcript's entry names none", () => {
  const T0 = "2026-10-06T00:00:00.000Z"
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(StepRow, {
        composer: "composer",
        marker: null,
        message: {
          id: "e1",
          metadata: { at: T0, from: null, kind: "human" },
          parts: [{ text: "here is the sketch", type: "text" }],
          role: "user",
        },
        newest: true,
        now: new Date(T0),
        outbox: {},
        sent: {
          at: T0,
          attachments: [
            {
              id: "3f1c2a9e-0000-4000-8000-000000000001.png",
              kind: "image",
              name: "sketch.png",
              previewUrl: null,
              size: 13_000,
            },
          ],
          attempts: 1,
          code: null,
          deliveredAt: T0,
          entryId: "e1",
          id: "m1",
          reason: null,
          retryAt: null,
          sawPicker: false,
          sessionId: "s1",
          state: "delivered",
          text: "here is the sketch",
          to: "dispatcher",
          typedAt: T0,
          unanswered: false,
          unreached: 0,
        },
        waiting: false,
        worker: { name: "dispatcher", sessionId: "s1", tasks: [] },
      }),
    ),
  )
  expect(html).toContain("sketch.png")
})

// A subagent runs on its parent session's model, so its Agent call's line draws that model's logo, by the rows' resolver; a branch when the parent's model is unknown, never a robot (PG-2651).
describe("a subagent's tool line", () => {
  const T0 = "2026-10-06T00:00:00.000Z"
  const ANTHROPIC = `data:image/svg+xml;base64,${Buffer.from('<svg data-maker="anthropic"><path d="M0 0"/></svg>').toString("base64")}`
  const ORNITH = "data:image/png;base64,iVBORw0KGgo="
  keepMakerIcon("anthropic", drawingOf(ANTHROPIC))
  keepMakerIcon("ornith-ai", drawingOf(ORNITH))
  const line = (worker: Record<string, unknown>) => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(StepRow, {
          composer: "composer",
          marker: null,
          message: {
            id: "a1",
            metadata: { at: T0, from: null, kind: "assistant" },
            parts: [
              {
                ...toolPart("output-available", {}),
                input: { json: "{}", summary: "Review the diff" },
                title: "Agent",
                toolName: "Agent",
              },
            ],
            role: "assistant",
          },
          newest: true,
          now: new Date(T0),
          outbox: {},
          sent: null,
          waiting: false,
          worker: { name: "builder", sessionId: "s1", tasks: [], ...worker },
        }),
      ),
    )
    return html.slice(html.indexOf('data-slot="trace-icon"'), html.indexOf("Review the diff"))
  }
  const branch = /<path d="([^"]+)"/.exec(renderToStaticMarkup(createElement(RiGitBranchLine)))?.[1]

  test("draws its parent's model logo: Claude's, or a local model's served maker", () => {
    expect(line({ model: "claude-opus-5-5" })).toContain(ANTHROPIC)
    expect(line({ localModel: "ornith-ai/Ornith-1.5-122B-NVFP4", model: "local" })).toContain(
      ORNITH,
    )
  })

  test("draws a branch when its parent's model is unknown", () => {
    expect(branch).toBeString()
    expect(line({ model: null })).toContain(branch ?? "none")
    expect(line({ model: "claude-opus-5-5" })).not.toContain(branch ?? "none")
  })
})
