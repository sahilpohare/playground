import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const { createSwitch, handoffAsk, switchBrief } =
  await import("../../../../../../api/hono/src/lib/dashboard/dispatcher-switch")
const { CODEX_LIVE_REFUSAL } = await import("../../../../../../api/hono/src/lib/onboard/harness")
type SwitchDeps =
  import("../../../../../../api/hono/src/lib/dashboard/dispatcher-switch").SwitchDeps
type Started = import("../../../../../../api/hono/src/lib/dashboard/dispatcher-start").Started

const DATA = "/scratch/data"
const HANDOFF = join(DATA, "handoffs", "dispatcher-switch.md")

// Every part faked: the dispatcher's answers to each start in order, the close's refusal, and the handoff's mtime by poll; each call recorded in order, so no session is closed or started, and harness.alpha's saves land in saved.
const world = ({
  closed = null as string | null,
  handoff = [null, 2000, 2000] as (number | null)[],
  starts = [{ name: "dispatcher", status: "running" }] as Started[],
} = {}) => {
  const calls: string[] = []
  const saved: string[] = []
  let clock = 1000
  let polls = 0
  const deps: SwitchDeps = {
    close: async (name) => {
      calls.push(`close ${name}`)
      return closed
    },
    data: DATA,
    env: { HOME: "/scratch/home", PLAYGROUND_DATA_DIR: DATA },
    mtime: (path) => {
      calls.push(`mtime ${path}`)
      return handoff[Math.min(polls++, handoff.length - 1)] ?? null
    },
    name: "dispatcher",
    now: () => clock,
    pollMs: 10,
    save: (harness) => {
      calls.push(`save ${harness}`)
      saved.push(harness)
      return null
    },
    sleep: async (ms) => {
      clock += ms
    },
    start: async (harness, brief) => {
      calls.push(`start ${harness}${brief ? ` from ${brief}` : ""}`)
      return starts.shift() ?? { name: "dispatcher", status: "started" }
    },
    waitMs: 100,
  }
  return { calls, deps, saved }
}

describe("Switch Alpha (#1835)", () => {
  test("a running dispatcher's answer carries the handoff ask for the outbox; it is closed once the handoff is written and still, then started on the new harness from it", async () => {
    const { calls, deps } = world()
    const sw = createSwitch()
    const begun = await sw.begin("codex", deps)
    expect(typeof begun).not.toBe("string")
    expect(sw.read()).toEqual({
      ask: handoffAsk(HANDOFF, "dispatcher", "codex"),
      harness: "codex",
      reason: null,
      state: "running",
      step: "Waiting for Alpha's handoff",
      to: "dispatcher",
    })
    await (begun as { done: Promise<void> }).done
    expect(sw.read()).toMatchObject({ ask: null, reason: null, state: "ok" })
    expect(calls).toEqual([
      "start codex",
      `mtime ${HANDOFF}`,
      `mtime ${HANDOFF}`,
      `mtime ${HANDOFF}`,
      "close dispatcher",
      `start codex from ${switchBrief("dispatcher")}`,
      "save codex",
    ])
    expect(handoffAsk(HANDOFF, "dispatcher", "codex")).toContain(HANDOFF)
  })

  test("a handoff older than the ask does not count, and none in time fails with the dispatcher left running", async () => {
    const { calls, deps, saved } = world({ handoff: [500] })
    const sw = createSwitch()
    await ((await sw.begin("claude-code", deps)) as { done: Promise<void> }).done
    expect(sw.read()).toMatchObject({ ask: null, state: "failed" })
    expect(sw.read().reason).toContain("still runs as before")
    expect(calls).not.toContain("close dispatcher")
    expect(saved).toEqual([])
  })

  test("a close that fails starts nothing and saves nothing", async () => {
    const { calls, deps, saved } = world({ closed: "spawn.sh close exited 1" })
    const sw = createSwitch()
    await ((await sw.begin("codex", deps)) as { done: Promise<void> }).done
    expect(sw.read()).toMatchObject({ reason: "spawn.sh close exited 1", state: "failed" })
    expect(calls.at(-1)).toBe("close dispatcher")
    expect(saved).toEqual([])
  })

  test("a start after the close that fails says the dispatcher stopped, and saves nothing", async () => {
    const { deps, saved } = world({
      starts: [
        { name: "dispatcher", status: "running" },
        { detail: "the load gate refused", name: "dispatcher", status: "refused" },
      ],
    })
    const sw = createSwitch()
    await ((await sw.begin("codex", deps)) as { done: Promise<void> }).done
    expect(sw.read()).toMatchObject({
      reason: "dispatcher stopped, but did not start again on Codex: the load gate refused",
      state: "failed",
    })
    expect(saved).toEqual([])
  })

  test("a dispatcher that is not running starts on the new harness at once, asking nothing", async () => {
    const { calls, deps } = world({ starts: [{ name: "dispatcher", status: "started" }] })
    const sw = createSwitch()
    await ((await sw.begin("claude-code", deps)) as { done: Promise<void> }).done
    expect(sw.read()).toMatchObject({ ask: null, state: "ok", to: null })
    expect(calls).toEqual(["start claude-code", "save claude-code"])
  })

  test("a first start that fails asks, closes and saves nothing", async () => {
    const { calls, deps, saved } = world({
      starts: [{ detail: "the load gate refused", name: "dispatcher", status: "refused" }],
    })
    const sw = createSwitch()
    await ((await sw.begin("codex", deps)) as { done: Promise<void> }).done
    expect(sw.read()).toMatchObject({ ask: null, reason: "the load gate refused", state: "failed" })
    expect(calls).toEqual(["start codex"])
    expect(saved).toEqual([])
  })

  test("Codex on the live data folder is refused before anything is saved or asked", async () => {
    const { calls, deps } = world()
    const sw = createSwitch()
    expect(await sw.begin("codex", { ...deps, env: { HOME: "/scratch/home" } })).toBe(
      CODEX_LIVE_REFUSAL,
    )
    expect(calls).toEqual([])
    expect(sw.read().state).toBe("idle")
  })

  test("a second switch while one runs is refused", async () => {
    const { deps } = world()
    const sw = createSwitch()
    const first = sw.begin("codex", deps)
    expect(await sw.begin("claude-code", deps)).toBe("A switch is already running")
    await ((await first) as { done: Promise<void> }).done
  })
})
