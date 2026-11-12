import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LIFT_GAP,
  LIFT_HOLD,
  LOAD_CAP,
  runSweep,
  SWITCH_HOURS,
  SWITCHES,
} from "../../../../../packages/scripts/src/playground/sweep"

const root = mkdtempSync(join(tmpdir(), "dispatcher-sweep-"))
afterAll(() => rmSync(root, { force: true, recursive: true }))

const NOW = new Date("2026-10-23T12:00:00Z")

// A data folder holding alerts, an empty queue and a roster, as the ops jobs leave them.
const folder = (agents: unknown[] = []) => {
  const dir = mkdtempSync(join(root, "data-"))
  mkdirSync(join(dir, "ops"), { recursive: true })
  writeFileSync(join(dir, "ops", "alerts-pending.json"), JSON.stringify({ alerts: [] }))
  writeFileSync(join(dir, "merge-queue.json"), JSON.stringify({ queue: [] }))
  writeFileSync(join(dir, "roster.json"), JSON.stringify({ agents }))
  return dir
}
const sweep = (dir: string, now = NOW, load5 = 4) => runSweep("builder", dir, now, load5)

describe("playground sweep", () => {
  test("a sweep with nothing new prints quiet, the first one included", async () => {
    const dir = folder()
    expect(await sweep(dir)).toEqual(["quiet"])
    expect(await sweep(dir)).toEqual(["quiet"])
  })

  test("a passed ETA of the lead's own row prints once, and another lead's row never", async () => {
    const dir = folder([
      {
        eta: "2026-10-23T11:30:00Z",
        kind: "worker",
        name: "k3m9px-worker",
        pr: "https://github.com/acme/archive/pull/9",
        status: "working",
      },
      { eta: "2026-10-23T13:00:00Z", kind: "worker", name: "b7k2mq-worker", status: "working" },
      { eta: "2026-10-23T11:00:00Z", kind: "runner", name: "p4n8vt-runner", status: "working" },
      {
        eta: "2026-10-23T11:00:00Z",
        kind: "worker",
        lead: "ops",
        name: "w33hrq-worker",
        status: "working",
      },
      { eta: "2026-10-23T11:00:00Z", kind: "worker", name: "x2rvtb-worker", status: "ended" },
    ])
    expect(await sweep(dir)).toEqual([
      "eta passed: k3m9px-worker 2026-10-23T11:30:00Z (https://github.com/acme/archive/pull/9)",
    ])
    expect(await sweep(dir)).toEqual(["quiet"])
    expect(await sweep(dir, new Date("2026-10-23T13:05:00Z"))).toEqual([
      "eta passed: b7k2mq-worker 2026-10-23T13:00:00Z",
    ])
  })

  test("a probe's passed ETA goes to the ops lead, who takes every probe as its own", async () => {
    const dir = folder([
      {
        eta: "2026-10-23T11:00:00Z",
        kind: "probe",
        name: "m4kq7z-probe",
        status: "working",
        task: "a throwaway test",
      },
    ])
    expect(await sweep(dir)).toEqual(["quiet"])
    expect(await runSweep("ops", dir, NOW, 4)).toEqual([
      "eta passed: m4kq7z-probe 2026-10-23T11:00:00Z (a throwaway test)",
    ])
  })

  test("a name that holds no lead's seat is refused before any file is written", async () => {
    const dir = folder()
    await expect(runSweep("../roster", dir, NOW, 4)).rejects.toThrow(
      "playground sweep takes a lead's name (builder or ops), not ../roster",
    )
    expect(existsSync(join(dir, "sweep"))).toBe(false)
  })

  test("a new alert, a queue change, load5 crossing 15 and the single-slot flag each print once", async () => {
    const dir = folder()
    await sweep(dir)
    writeFileSync(
      join(dir, "ops", "alerts-pending.json"),
      JSON.stringify({
        alerts: [
          {
            kind: "pr-stalled",
            line: "no activity for 50m",
            name: "acme/archive#9",
            since: "2026-10-23T11:00:00Z",
          },
        ],
      }),
    )
    writeFileSync(
      join(dir, "merge-queue.json"),
      JSON.stringify({ queue: [{ pr: 9, readyAt: "2026-10-23T11:00:00Z" }, { pr: 10 }] }),
    )
    writeFileSync(join(dir, "ops", "run-slot.single"), "")
    expect(await sweep(dir, NOW, 28.04)).toEqual([
      "alert: pr-stalled acme/archive#9: no activity for 50m",
      "queue: #9 ready, #10",
      "load5 28.0, at or above 15",
      "single slot: on, held by load until load5 holds under 22 for 5 min (load5 28.0)",
    ])
    expect(await sweep(dir, NOW, 20)).toEqual(["quiet"])
    expect(await sweep(dir, NOW, 9)).toEqual(["load5 9.0, back under 15"])
  })

  // issue 1737: single stood by timer at load5 5.6, so the line says whether the load holds it or it has lifted under the cap
  test("the single-slot line says whether load holds it or it has lifted under the cap", async () => {
    const dir = folder()
    writeFileSync(join(dir, "ops", "run-slot.single"), "")
    writeFileSync(join(dir, "ops", "run-slot.load5-cap"), "14\n")
    const under = (seconds: number) =>
      writeFileSync(
        join(dir, "ops", "run-slot.under"),
        `${NOW.getTime() / 1000 - seconds} ${NOW.getTime() / 1000 - 10}\n`,
      )
    under(60)
    expect(await sweep(dir, NOW, 5.6)).toEqual([
      "single slot: on, held by load until load5 holds under 14 for 5 min (load5 5.6)",
    ])
    under(301)
    expect(await sweep(dir, NOW, 5.6)).toEqual([
      "single slot: on, lifted under the cap: load5 5.6 has held under 14 for 5 min",
    ])
    expect(await sweep(dir, NOW, 14.2)).toEqual([
      "single slot: on, held by load until load5 holds under 14 for 5 min (load5 14.2)",
    ])
  })

  // a reviewer: a mark whose last reading is old may hide a crossing no run read, so it holds as run-slot.sh's lifted does
  test("a mark whose last reading under the cap is over 90 s old reads held", async () => {
    const dir = folder()
    writeFileSync(join(dir, "ops", "run-slot.single"), "")
    const at = NOW.getTime() / 1000
    writeFileSync(join(dir, "ops", "run-slot.under"), `${at - 3600} ${at - 91}\n`)
    expect(await sweep(dir, NOW, 5.6)).toEqual([
      "single slot: on, held by load until load5 holds under 22 for 5 min (load5 5.6)",
    ])
  })

  test("its hold, gap and cap are run-slot.sh's", async () => {
    const script = await Bun.file(
      join(import.meta.dir, "../../../../../scripts/ops/run-slot.sh"),
    ).text()
    expect(script).toContain(`\nLIFT_HOLD=${LIFT_HOLD}\n`)
    expect(script).toContain(`\nLIFT_GAP=${LIFT_GAP}\n`)
    expect(script).toContain(
      `[ -n "$cap" ] || cap=${LOAD_CAP}; [ "$cap" -le ${LOAD_CAP} ] || cap=${LOAD_CAP}`,
    )
  })

  test("an alert whose since moves every cycle prints once, and again only after it clears", async () => {
    const dir = folder()
    const alerts = join(dir, "ops", "alerts-pending.json")
    const capped = (since: string) =>
      writeFileSync(
        alerts,
        JSON.stringify({
          alerts: [{ kind: "capped", line: "week at 100%", name: "a@b.c", since }],
        }),
      )
    await sweep(dir)
    capped("2026-10-23T12:00:00Z")
    expect(await sweep(dir)).toEqual(["alert: capped a@b.c: week at 100%"])
    capped("2026-10-23T12:02:00Z")
    expect(await sweep(dir)).toEqual(["quiet"])
    writeFileSync(alerts, JSON.stringify({ alerts: [] }))
    expect(await sweep(dir)).toEqual(["quiet"])
    capped("2026-10-23T12:30:00Z")
    expect(await sweep(dir)).toEqual(["alert: capped a@b.c: week at 100%"])
  })

  // a hand-set runner-host/slot-off kept the runner box idle for two days
  test("each switch on goes to the ops lead once an hour with its age and reason, and an expired one never", async () => {
    const dir = folder()
    const ops = join(dir, "ops")
    mkdirSync(join(ops, "runner-host"))
    writeFileSync(
      join(ops, "runner-host", "slot-off"),
      "ops 2026-10-23T10:30:00Z 2026-10-23T14:30:00Z box queue 17 deep\n",
    )
    writeFileSync(join(ops, "run-slot.3-off"), "")
    const at = (NOW.getTime() - 20 * 60_000) / 1000
    utimesSync(join(ops, "run-slot.3-off"), at, at)
    writeFileSync(
      join(ops, "run-slot.clone-off"),
      "dispatcher 2026-10-23T06:00:00Z 2026-10-23T10:00:00Z gone by now\n",
    )
    const boy = (now: Date) => runSweep("ops", dir, now, 4)
    const listed = [
      "switch on: run-slot.3-off for 0h20m, until 2026-10-23T15:40:00Z, no reason, set by hand",
      "switch on: runner-host/slot-off for 1h30m, until 2026-10-23T14:30:00Z, by ops: box queue 17 deep",
    ]
    expect(await boy(NOW)).toEqual(listed)
    expect(await boy(new Date("2026-10-23T12:45:00Z"))).toEqual(["quiet"])
    expect(await boy(new Date("2026-10-23T13:00:00Z"))).toEqual([
      "switch on: run-slot.3-off for 1h20m, until 2026-10-23T15:40:00Z, no reason, set by hand",
      "switch on: runner-host/slot-off for 2h30m, until 2026-10-23T14:30:00Z, by ops: box queue 17 deep",
    ])
    expect(await sweep(dir)).toEqual(["quiet"])
  })

  test("focus goes to the ops lead while it stands, by its session and reason", async () => {
    const dir = folder()
    writeFileSync(
      join(dir, "ops", "run-slot.focus"),
      "worker-f 2026-10-23T12:00:00Z 2026-10-23T14:00:00Z a timed demo\n",
    )
    expect(await runSweep("ops", dir, NOW, 4)).toEqual([
      "switch on: run-slot.focus for 0h0m, until 2026-10-23T14:00:00Z, by worker-f: a timed demo",
    ])
  })

  test("the switches and their default hours are run-slot.sh's", async () => {
    const script = readFileSync(
      join(import.meta.dir, "../../../../../scripts/ops/run-slot.sh"),
      "utf8",
    )
    expect(script.match(/^SWITCHES="(.*)"$/m)?.[1]?.split(" ")).toEqual(SWITCHES)
    expect(script).toContain(` -lt ${SWITCH_HOURS * 3600} ]`)
    expect(script).toContain(` span=${SWITCH_HOURS}h\n`)
  })

  // a parked row kept its ETA after its wait ended, and nothing told its lead
  describe("a parked row", () => {
    const parked = (more: Record<string, unknown>) => ({
      kind: "worker",
      name: "q7r2tn-worker",
      status: "parked",
      task: "#42 per its brief",
      ...more,
    })
    // a hold reader that answers from a table and records each hold it was asked for
    const holds = (states: Record<string, "closed" | "open" | null>) => {
      const asked: string[] = []
      const read = async (hold: string) => {
        asked.push(hold)
        return states[hold] ?? null
      }
      return { asked, read }
    }

    test("whose ETA has passed prints once a value, and again on a new passed ETA", async () => {
      const dir = folder([parked({ eta: "2026-10-23T11:30:00Z", hold: "d-215" })])
      const reader = holds({})
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual([
        "parked past eta: q7r2tn-worker 2026-10-23T11:30:00Z (#42 per its brief)",
      ])
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual(["quiet"])
      writeFileSync(
        join(dir, "roster.json"),
        JSON.stringify({ agents: [parked({ eta: "2026-10-23T11:45:00Z", hold: "d-215" })] }),
      )
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual([
        "parked past eta: q7r2tn-worker 2026-10-23T11:45:00Z (#42 per its brief)",
      ])
      expect(reader.asked).toEqual([])
    })

    test("whose hold has closed prints once, and its hold is not read again", async () => {
      const dir = folder([parked({ eta: "2026-10-23T13:00:00Z", hold: "#12" })])
      const reader = holds({ "#12": "closed" })
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual([
        "parked on closed hold: q7r2tn-worker #12 (#42 per its brief)",
      ])
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual(["quiet"])
      expect(reader.asked).toEqual(["#12"])
    })

    test("whose hold cannot be read prints one line naming it, once", async () => {
      const dir = folder([parked({ hold: "#i5" })])
      const reader = holds({ "#i5": null })
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual([
        "parked hold unreadable: q7r2tn-worker #i5 (#42 per its brief)",
      ])
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual(["quiet"])
    })

    test("whose hold is open, with a future ETA or none, prints nothing", async () => {
      const dir = folder([
        parked({ eta: "2026-10-23T13:00:00Z", hold: "#12" }),
        parked({ hold: "#i5", name: "h3w8pd-worker" }),
        parked({ name: "f6c1zs-worker" }),
      ])
      expect(
        await runSweep("builder", dir, NOW, 4, holds({ "#12": "open", "#i5": "open" }).read),
      ).toEqual(["quiet"])
    })

    test("that ended, or is another lead's, prints nothing", async () => {
      const dir = folder([
        parked({ eta: "2026-10-23T11:00:00Z", hold: "#12", status: "ended" }),
        parked({ eta: "2026-10-23T11:00:00Z", hold: "#12", lead: "ops", name: "h3w8pd-worker" }),
      ])
      const reader = holds({ "#12": "closed" })
      expect(await runSweep("builder", dir, NOW, 4, reader.read)).toEqual(["quiet"])
      expect(reader.asked).toEqual([])
    })
  })

  test("a cursor file of another shape counts as a first sweep", async () => {
    const dir = folder()
    mkdirSync(join(dir, "sweep"))
    writeFileSync(join(dir, "sweep", "builder.json"), "{}")
    expect(await sweep(dir)).toEqual(["quiet"])
    expect(await sweep(dir)).toEqual(["quiet"])
  })
})
