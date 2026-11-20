import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  PullSections,
  WorkPulls,
} from "../../../../../../web/next/src/components/dashboard/pull-requests"
import type { PullSection } from "../../../../../../web/next/src/lib/pulls"
import { pullsSetup } from "../../../../../../web/next/src/lib/setup"

const web = join(import.meta.dir, "../../../../../../web/next")
const { createElement } = (await import(Bun.resolveSync("react", web))) as {
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
}
const { renderToStaticMarkup } = (await import(Bun.resolveSync("react-dom/server", web))) as {
  renderToStaticMarkup: (element: unknown) => string
}

const queued: PullSection = {
  groups: [
    {
      pulls: [
        {
          approvals: 0,
          ci: "none",
          conflicts: false,
          draft: false,
          gates: null,
          head: "",
          etaMerge: null,
          number: 50,
          place: 1,
          queued: true,
          reviewed: false,
          round: null,
          score: null,
          state: "open",
          tester: null,
          title: "Queue tab",
          unpaired: true,
          updatedAt: null,
          url: "https://github.com/acme/factory/pull/50",
          verdict: null,
        },
      ],
      repo: "acme/factory",
    },
  ],
  kind: "queued",
}

const render = (problem: { reason: string; setup: boolean } | null) =>
  renderToStaticMarkup(
    createElement(PullSections, { now: 0, sections: [queued], setup: pullsSetup(problem) }),
  )

// a tester: with every pull read failed, the queue's unpaired rows still list, so the tab must still say why GitHub was not read.
describe("the Pull requests tab's sections", () => {
  test("say GitHub refused the read, with the read's reason, above the queued pulls no read reached", () => {
    const html = render({ reason: "API rate limit exceeded", setup: false })
    expect(html).toContain("GitHub refused the read.")
    expect(html).toContain("The read failed: API rate limit exceeded.")
    expect(html).toContain("Pull requests in acme/factory")
    expect(html.indexOf("GitHub refused")).toBeLessThan(
      html.indexOf("Pull requests in acme/factory"),
    )
  })

  test("carry no setup line while every read landed", () => {
    expect(render(null)).not.toContain("GitHub")
  })
})

// The owner's words: "pull requests too", after "inbox should be inside accordion".
describe("the Pull requests tab's sections fold as an accordion", () => {
  const parked: PullSection = {
    groups: [{ pulls: queued.groups[0]!.pulls, repo: "acme/parked" }],
    kind: "parked",
  }
  // the opening tag of the trigger whose words these are
  const trigger = (html: string, words: string) =>
    html
      .split("<button")
      .find((button) => button.split("</button>")[0]!.includes(`>${words}<`))
      ?.split(">")[0] ?? ""
  const html = renderToStaticMarkup(
    createElement(PullSections, { now: 0, sections: [queued, parked], setup: null }),
  )

  test("each section is an item under its title, queued open and parked folded", () => {
    expect(trigger(html, "Queued")).toContain('aria-expanded="true"')
    expect(trigger(html, "Parked")).toContain('aria-expanded="false"')
    expect(html).toContain("Pull requests in acme/factory")
    expect(html).not.toContain("Pull requests in acme/parked")
  })

  // a reviewer: Base UI's accordion header is always an h3, which set the dashboard's sections level with site.name's h3 above them
  test("a section's title sits at the tab's level, and its repositories one below it", () => {
    expect(html).toMatch(/<h3[^>]*><button[^>]*>Queued</)
    expect(html).toMatch(/<h4[^>]*>acme\/factory<\/h4>/)
    const under = renderToStaticMarkup(
      createElement(PullSections, { level: 4, now: 0, sections: [queued, parked], setup: null }),
    )
    expect(under).toMatch(/<h4[^>]*><button[^>]*>Queued</)
    expect(under).toMatch(/<h5[^>]*>acme\/factory<\/h5>/)
    expect(under).not.toContain("<h3")
  })

  test("a lone section stays as it is, with no title to fold it by", () => {
    expect(render(null)).not.toContain('data-slot="accordion"')
  })
})

type WorkQueue = Parameters<typeof WorkPulls>[0]["queue"]
type WorkPull = WorkQueue["pulls"][number]

const work = (number: number, waitsOn: WorkPull["waitsOn"]): WorkPull => ({
  approvals: "1 of 2",
  base: "main",
  number,
  repo: "example/app",
  title: `Change ${number}`,
  updatedAt: null,
  url: `https://github.com/example/app/pull/${number}`,
  waitsOn,
})

const renderWork = (queue: WorkQueue) =>
  renderToStaticMarkup(createElement(WorkPulls, { now: 0, queue }))

describe("the Pull requests tab's work queue", () => {
  // the table draws its rows in the browser alone, so a static render shows its title and columns; the order is the API's (work-queue.test.ts)
  test("titles the table by its label, with its Waits on and Approvals columns", () => {
    const html = renderWork({
      label: "Day job",
      problem: null,
      pulls: [work(9, "Nothing"), work(4, "CI failing")],
    })
    expect(html).toMatch(/data-slot="accordion-trigger"[^>]*>Day job</)
    expect(html).toContain('aria-label="Day job pull requests"')
    expect(html.indexOf("Pull request")).toBeLessThan(html.indexOf("Waits on"))
    expect(html.indexOf("Waits on")).toBeLessThan(html.indexOf("Approvals"))
  })

  test("says why when the search failed, and says so when nothing is open", () => {
    expect(
      renderWork({
        label: "Work",
        problem: { reason: "Bad credentials", setup: false },
        pulls: [],
      }),
    ).toContain("The read failed: Bad credentials.")
    expect(renderWork({ label: "Work", problem: null, pulls: [] })).toContain(
      "No open pull requests.",
    )
  })
})
