import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  lastBeat,
  pausedColumns,
  PausedTable,
} from "../../../../../../web/next/src/components/dashboard/paused-ops"

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

type Row = Parameters<typeof PausedTable>[0]["rows"][number]

const NOW = Date.parse("2026-10-07T12:00:00Z")

const job = (job: string, fields: Partial<Row> = {}): Row => ({
  callsModel: false,
  does: "",
  job,
  lastBeatAt: null,
  model: null,
  name: job,
  paused: false,
  problem: null,
  reason: null,
  schedule: null,
  status: "running",
  ...fields,
})

const render = (rows: Row[]) => renderToStaticMarkup(createElement(PausedTable, { now: NOW, rows }))

describe("PausedTable", () => {
  test("lists only the paused jobs under Paused, with what each does and its last beat", () => {
    const html = render([
      job("ops-checks", { paused: true, reason: "No beat for over 180s", status: "down" }),
      job("ops-dashboard"),
      job("ops-fixture", { paused: true }),
    ])
    expect(html).toContain('id="paused"')
    expect(html).toContain(">Paused<")
    // a header row and the two paused jobs; the running one stays in the sidebar's Scripts
    expect(html).toContain('aria-rowcount="3"')
    for (const header of ["Script", "Does", "Runs", "Last beat"])
      expect(html).toContain(`<div>${header}</div>`)
  })

  test("a script reads by its plain name, with when it would run", () => {
    const row = job("ops-usage-post", {
      name: "Usage post",
      paused: true,
      schedule: { cron: "0 5 * * *" },
    })
    const cells = pausedColumns(NOW).map((column) =>
      renderToStaticMarkup(
        createElement(() =>
          (column.cell as (c: unknown) => Node)({
            column: { columnDef: column, id: column.id },
            row: { original: row },
          }),
        ),
      ),
    )
    expect(cells.join(" ")).toContain(">Usage post<")
    expect(cells.join(" ")).not.toContain("ops-usage-post")
    expect(cells.join(" ")).toContain(">every day at 5:00 AM<")
  })

  test("a last beat reads as the sidebar's times do, and Never with none", () => {
    expect(lastBeat(job("ops-checks", { lastBeatAt: "2026-10-07T11:00:00Z" }), NOW)).toBe(
      "1 hr. ago",
    )
    expect(lastBeat(job("ops-checks"), NOW)).toBe("Never")
  })

  test("every cell is muted and none reads Down: paused is on purpose", async () => {
    const source = await Bun.file(join(web, "src/components/dashboard/paused-ops.tsx")).text()
    const calls = [...source.matchAll(/textColumn<OpsRow>\(([^\n]*)\)/g)].map(([, args]) => args)
    expect(calls).toHaveLength(4)
    for (const args of calls) expect(args.endsWith(", true")).toBe(true)
    expect(source).not.toContain("OPS_LABELS")
  })

  test("the System page shows it last, so its late arrival moves nothing below it", async () => {
    const home = await Bun.file(join(web, "src/components/dashboard/system-home.tsx")).text()
    const panel = home.indexOf("<SystemPanel />")
    const paused = home.indexOf("<PausedOps />")
    expect(panel).toBeGreaterThan(0)
    expect(paused).toBeGreaterThan(panel)
    expect(home.slice(paused + "<PausedOps />".length).match(/<[A-Z]\w* /g)).toBeNull()
  })

  test("with no paused job there is no Paused group at all", () => {
    expect(render([job("ops-dashboard")])).toBe("")
  })
})
