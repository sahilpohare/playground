import { appendFile } from "node:fs/promises"

import type { Browser, Result, Target } from "./checks"
import { finishedTurn, idsOf, sessionOf, step, transcriptOf, type Board } from "./typing-lag"

// How many steps the check writes into Playground's turn, one at a time, as a working session does.
export const STEPS = 10
const STEP_GAP_MS = 400
// The components a step must leave alone: a row's name link, a row and a part's words, whose names the counter reads from the development build.
export const COUNTED = ["AgentLink", "StepRow", "TranscriptMarkdown"] as const
export type Shown = { parts: number; renders: Record<string, number>; rows: number }

// Pure: what the steps may draw of each counted component: each step its own turn's row, name link and new words, twice over for a board frame landing beside it; the stream's clock (the inbox read's time, every 5s) draws no row whose shown time it leaves alone (sameStep).
export const allowance = (steps: number): number => 2 * steps

// Pure: passes when no counted component drew more than its allowance over the steps, else names each that did, with what the stream held; a stream that drew no row measured nothing.
export const streamRendersResult = (
  check: string,
  { parts, renders, rows }: Shown,
  steps: number,
): Result => {
  if (rows === 0 || !(renders.StepRow ?? 0))
    return { check, detail: `no row drew over ${steps} steps (${rows} rows shown)`, ok: false }
  const over = COUNTED.filter((name) => (renders[name] ?? 0) > allowance(steps))
  const draws = COUNTED.map((name) => `${name} ${renders[name] ?? 0}`).join(", ")
  const shown = `${steps} steps into a stream of ${rows} rows and ${parts} parts`
  return {
    check,
    detail: over.length
      ? `${over.map((name) => `${name} drew ${renders[name]} times, over ${allowance(steps)}`).join("; ")}, ${shown}`
      : `${shown}: ${draws} draws`,
    ok: over.length === 0,
  }
}

// Runs before the page's own scripts: counts each component's renders through the DevTools hook React reports every commit to, and keeps the socket's first workers frame, which names Playground's own session. A fiber rendered when it carries the flag React sets on one it rendered (PerformedWork) and is not the object its root's last commit held, since a subtree React skipped keeps its old fibers, flags and all; each root keeps its own, since the development build's overlay commits a root of its own between the app's.
export const STREAM_RENDERS_SCRIPT = `(() => {
  const PerformedWork = 1
  const counts = new Map()
  const nameOf = (fiber) => {
    const type = fiber.type
    if (typeof type === "function") return type.displayName || type.name || null
    return null
  }
  const heldOf = new WeakMap()
  const walk = (root) => {
    const held = heldOf.get(root) ?? new WeakSet()
    const seen = new WeakSet()
    const stack = [root.current]
    while (stack.length) {
      const fiber = stack.pop()
      seen.add(fiber)
      // the same object as last commit: React skipped it and everything under it
      if (held.has(fiber)) { markHeld(fiber, seen); continue }
      if ((fiber.flags & PerformedWork) === PerformedWork) {
        const name = nameOf(fiber)
        if (name) counts.set(name, (counts.get(name) || 0) + 1)
      }
      for (let child = fiber.child; child; child = child.sibling) stack.push(child)
    }
    heldOf.set(root, seen)
  }
  const markHeld = (top, seen) => {
    const stack = [top.child]
    while (stack.length) {
      const fiber = stack.pop()
      if (!fiber) continue
      seen.add(fiber)
      stack.push(fiber.child, fiber.sibling)
    }
  }
  const renderers = new Map()
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    checkDCE: () => {},
    emit: () => {},
    inject: (renderer) => { const id = renderers.size + 1; renderers.set(id, renderer); return id },
    isDisabled: false,
    listeners: {},
    off: () => {},
    on: () => {},
    onCommitFiberRoot: (id, root) => { walk(root) },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    renderers,
    setStrictMode: () => {},
    sub: () => () => {},
    supportsFiber: true,
    supportsFlight: false,
  }
  let frame = null
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args)
      if (!String(args[0]).includes("/api/v1/ws")) return
      this.addEventListener("message", (event) => {
        if (frame) return
        try {
          const data = JSON.parse(String(event.data))
          if (data.type === "workers") frame = data
        } catch {}
      })
    }
  }
  window.__streamRenders = {
    board: () => ({
      names: frame?.dispatchers ?? [],
      sessions: (frame?.workers ?? []).map(({ name, role, sessionId }) => ({ name, role, sessionId })),
    }),
    counts: () => Object.fromEntries(counts),
    reset: () => counts.clear(),
  }
})()`

// The stream's rows and the parts they hold.
const SHOWN = `(() => { const box = document.querySelector("[data-slot=message-scroller-viewport]"); return { parts: box ? box.querySelectorAll("[data-step]").length : 0, rows: box ? box.querySelectorAll("[data-slot=message-scroller-item]").length : 0 } })()`
// Rows and parts hold this long before the steps start, so a frame still landing is never counted among them.
const STILL_MS = 1500
const POLL_MS = 250
const SETTLE_MS = 20_000

// At 1280x800 on /dashboard, with Playground's turn written past the stream's cap as the live one always is: it lets the stream settle, then writes STEPS steps into that turn, one every STEP_GAP_MS, and counts what each component drew while they landed, so a step that draws the whole stream again (every part's words, every row) fails it; the lines stay in the fixture's scratch copy until the stack restarts, the turn ended so the session reads as idle after.
export const streamRenders = async (
  browser: Browser,
  { web }: Target,
  fixture: string,
): Promise<Result> => {
  const check = "stream-renders"
  await browser.viewport({ height: 800, width: 1280 })
  await browser.visit(`${web}/dashboard`)
  await browser.run("wait", "#composer")
  const board = await browser.eval<Board>("window.__streamRenders.board()")
  const own = await transcriptOf(fixture, idsOf(board, true))
  if (!own) return { check, detail: "no dispatcher transcript in the fixture", ok: false }
  const tag = crypto.randomUUID().slice(0, 8)
  await appendFile(
    own,
    `${finishedTurn(tag, Date.now(), { cwd: "/fixture/dispatcher", sessionId: sessionOf(own) }).join("\n")}\n`,
  )
  try {
    let last = ""
    let stillFor = 0
    for (let waited = 0; stillFor < STILL_MS && waited < SETTLE_MS; waited += POLL_MS) {
      const shown = JSON.stringify(await browser.eval<Shown>(SHOWN))
      stillFor = shown === last ? stillFor + POLL_MS : 0
      last = shown
      await browser.run("wait", String(POLL_MS))
    }
    const before = await browser.eval<Omit<Shown, "renders">>(SHOWN)
    await browser.eval("window.__streamRenders.reset()")
    for (let n = 0; n < STEPS; n += 1) {
      await step(own, `verify stream-renders: step ${n}`)
      await browser.run("wait", String(STEP_GAP_MS))
    }
    // the last step's frame lands after its write
    await browser.run("wait", "1500")
    const renders = await browser.eval<Record<string, number>>("window.__streamRenders.counts()")
    return streamRendersResult(check, { ...before, renders }, STEPS)
  } finally {
    await step(own, "That is the whole reply.", true)
  }
}
