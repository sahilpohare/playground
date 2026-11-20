import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { progressItems, type ProgressItem } from "../../../../../packages/config/src/inbox"
import {
  ACTIVE_BAR,
  MUTED_BAR,
  ProgressBlock,
} from "../../../../../web/next/src/components/progress-block"

// React resolves from the web app's own packages, which this directory cannot see; the two calls the test makes are typed here rather than through a path into node_modules.
type Node = unknown
const web = join(import.meta.dir, "../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: (type: unknown, props?: unknown) => Node
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (node: Node) => string
}

const items = (block: string): ProgressItem[] => {
  const read = progressItems(block)
  if (!read.ok) throw new Error(`the block does not read: ${JSON.stringify(read.fault)}`)
  return read.items
}

// Each bar's root, in order: the element holding role="progressbar" with its classes and label.
const bars = (block: string) =>
  [
    ...renderToStaticMarkup(createElement(ProgressBlock, { items: items(block) })).matchAll(
      /<[^>]*role="progressbar"[^>]*>/g,
    ),
  ].map((m) => m[0])

describe("ProgressBlock's bars (PG-2730)", () => {
  test("an active row's bar takes the palette's blue, and a waiting, held or done row's draws muted", () => {
    const [active, waiting, held, done] = bars(
      [
        "Build | 60 | Writing the parser | 2:00 pm | active",
        "Review | 0 | After the build | 4:00 pm | waiting",
        "Ship | 0 | Holds for the owner | later | held",
        "Plan | 100 | Agreed | done | done",
      ].join("\n"),
    )
    expect(active).toContain(ACTIVE_BAR)
    expect(active).not.toContain(MUTED_BAR)
    for (const bar of [waiting, held, done]) {
      expect(bar).toContain(MUTED_BAR)
      expect(bar).not.toContain(ACTIVE_BAR)
    }
  })

  test("a row's state is in its bar's name, so it never rests on colour alone", () => {
    const [active, waiting] = bars("Build | 60 | x | y | active\nReview | 0 | x | y | waiting")
    expect(active).toContain('aria-label="Build, active"')
    expect(waiting).toContain('aria-label="Review, waiting"')
  })

  test("an old 4-field row under 100 draws as an active one: the blue bar, named by its name alone", () => {
    const [bar] = bars("Sign-in | 40 | Next | 2:00 pm")
    expect(bar).toContain(ACTIVE_BAR)
    expect(bar).not.toContain(MUTED_BAR)
    expect(bar).toContain('aria-label="Sign-in"')
  })

  test("a row at 100 that names no state reads as done, so its bar draws muted", () => {
    const [bar] = bars("Mac reads | 100 | Reads every Mac | 9:10 pm")
    expect(bar).toContain(MUTED_BAR)
    expect(bar).not.toContain(ACTIVE_BAR)
    expect(bar).toContain('aria-label="Mac reads, done"')
  })
})
