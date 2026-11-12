import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { dispatcherArgv, startDispatcher } =
  await import("../../../../../../api/hono/src/lib/dashboard/dispatcher-start")
const { CODEX_LIVE_REFUSAL } = await import("../../../../../../api/hono/src/lib/onboard/harness")
const { loadFixture, writeFixture } =
  await import("../../../../../../api/hono/src/lib/dashboard/fixture")
const { isLiveRecord } = await import("../../../../../../api/hono/src/lib/dashboard/workers")
const { herdrRecords } = await import("../../../../../../api/hono/src/lib/dashboard/herdr")
const { readRegistry, registryOf, startsOf } =
  await import("../../../../../../api/hono/src/lib/dashboard/peers")
type Run = import("../../../../../../api/hono/src/lib/dashboard/dispatcher-start").Run
type Pane = import("../../../../../../api/hono/src/lib/dashboard/herdr").Pane

const scratch = mkdtempSync(join(tmpdir(), "dispatcher-start-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// The CLI as a script: each argv recorded, one answer for every call.
const cli = (answer: { code: number; stderr?: string; stdout?: string }) => {
  const calls: string[][] = []
  const run: Run = async (argv) => {
    calls.push(argv)
    return { stderr: "", stdout: "", ...answer }
  }
  return { calls, run }
}

const live = (run: Run) =>
  startDispatcher({ live: true, name: "dispatcher", root: "/fixture/playground", run })

describe("startDispatcher on a stack reading its own machine", () => {
  test("runs the CLI's dispatcher step through its one fixed argv", async () => {
    const { calls, run } = cli({ code: 0, stdout: "Started dispatcher\n" })
    expect(await live(run)).toEqual({ name: "dispatcher", status: "started" })
    expect(dispatcherArgv("/fixture/playground")).toEqual([
      "bun",
      "/fixture/playground/packages/scripts/src/playground/cli.ts",
      "dispatcher",
    ])
    expect(calls).toEqual([dispatcherArgv("/fixture/playground")])
  })

  test("reads exit 3 as already running, 1 as refused with the CLI's own words, and anything else as failed", async () => {
    expect(await live(cli({ code: 3 }).run)).toEqual({ name: "dispatcher", status: "running" })
    const reason = `spawn.sh refuses dispatcher: no herdr server ${"x".repeat(400)}`
    const refused = await live(cli({ code: 1, stderr: `${reason}\n` }).run)
    expect(refused.status).toBe("refused")
    expect("detail" in refused && refused.detail).toBe(reason)
    expect((await live(cli({ code: 2 }).run)).status).toBe("failed")
  })

  test("Claude Code, harness.alpha's default, starts exactly as today: no --harness on the argv", async () => {
    const { calls, run } = cli({ code: 0 })
    const answer = await startDispatcher({
      harness: "claude-code",
      live: true,
      name: "dispatcher",
      root: "/fixture/playground",
      run,
    })
    expect(answer.status).toBe("started")
    expect(calls).toEqual([
      ["bun", "/fixture/playground/packages/scripts/src/playground/cli.ts", "dispatcher"],
    ])
  })

  test("Codex on a scratch data folder runs the CLI's dispatcher step with --harness codex (#1835)", async () => {
    const { calls, run } = cli({ code: 0 })
    const answer = await startDispatcher({
      env: { HOME: join(scratch, "home"), PLAYGROUND_DATA_DIR: join(scratch, "data") },
      harness: "codex",
      live: true,
      name: "dispatcher",
      root: "/fixture/playground",
      run,
    })
    expect(answer.status).toBe("started")
    expect(calls).toEqual([
      [
        "bun",
        "/fixture/playground/packages/scripts/src/playground/cli.ts",
        "dispatcher",
        "--harness",
        "codex",
      ],
    ])
  })

  test("Codex on the live data folder is refused in plain words, and runs nothing", async () => {
    const { calls, run } = cli({ code: 0 })
    for (const live of [true, false]) {
      const answer = await startDispatcher({
        env: { HOME: join(scratch, "home") },
        harness: "codex",
        live,
        name: "dispatcher",
        root: "/fixture/playground",
        run,
      })
      expect(answer).toEqual({ detail: CODEX_LIVE_REFUSAL, name: "dispatcher", status: "refused" })
    }
    expect(calls).toEqual([])
  })

  test("with no checkout to run from, runs nothing and fails", async () => {
    const { calls, run } = cli({ code: 0 })
    const answer = await startDispatcher({ live: true, name: "dispatcher", root: null, run })
    expect(answer.status).toBe("failed")
    expect(calls).toEqual([])
  })
})

describe("startDispatcher on a fixture stack", () => {
  // The shipped fixture with its dispatcher's pane closed, the home's no-dispatcher state.
  let made = 0
  const ended = () => {
    const dir = join(scratch, `fixture-${made++}`)
    const loaded = loadFixture(null)
    if (!loaded.ok) throw new Error(loaded.error)
    writeFixture(loaded.fixture, dir, {
      home: join(scratch, "home"),
      main: join(scratch, "main"),
      trash: join(scratch, "data", "trash"),
    })
    const path = join(dir, "herdr.json")
    const state = JSON.parse(readFileSync(path, "utf8"))
    state.panes = state.panes.filter((p: Pane) => !p.processes[0]?.argv?.includes("dispatcher"))
    writeFileSync(path, JSON.stringify(state))
    return dir
  }
  const dispatcherPane = (dir: string): Pane | undefined =>
    JSON.parse(readFileSync(join(dir, "herdr.json"), "utf8")).panes.find((p: Pane) =>
      p.processes[0]?.argv?.includes("dispatcher"),
    )

  test("runs no process, makes a made-up dispatcher the board reads as live, and a second start reads already running", async () => {
    const dir = ended()
    const { calls, run } = cli({ code: 0 })
    const start = () =>
      startDispatcher({ dir, live: false, name: "dispatcher", root: "/fixture/playground", run })
    expect(await start()).toEqual({ name: "dispatcher", status: "started" })
    const pane = dispatcherPane(dir)
    expect(pane).toMatchObject({ agent_status: "idle" })
    const machine = JSON.parse(readFileSync(join(dir, "machine.json"), "utf8"))
    const ps = Object.entries(machine.processes as Record<string, { start: string }>)
      .map(([pid, p]) => `${pid} ${p.start}`)
      .join("\n")
    const registry = registryOf(await readRegistry(join(dir, "claude", "sessions")))
    const proof = { projects: join(dir, "claude", "projects"), registry, starts: startsOf(ps) }
    const [record] = herdrRecords(
      [{ panes: pane ? [pane] : [], server: "playground", workspaces: [] }],
      registry,
      new Date().toISOString(),
    )
    expect(record && isLiveRecord(record, proof)).toBe(true)
    expect(await start()).toEqual({ name: "dispatcher", status: "running" })
    expect(calls).toEqual([])
  })
})
