import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { machine } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

describe("an item's size", () => {
  test("RUN_SLOT_SIZE names it outright", async () => {
    expect(await machine().size("worker-x", { RUN_SLOT_SIZE: "big" })).toBe("big 3")
  })

  test("the roster entry's size", async () => {
    const m = machine({ roster: { agents: [{ name: "worker-x", size: "small" }] } })
    expect(await m.size("worker-x")).toBe("small 1")
  })

  test("a checker reads its worker's size", async () => {
    const m = machine({
      roster: {
        agents: [
          { name: "worker-x", size: "big" },
          { name: "reviewer-x", worker: "worker-x" },
        ],
      },
    })
    expect(await m.size("reviewer-x")).toBe("big 3")
  })

  test("Checks on PR n read the worker on that PR, not its checkers", async () => {
    const pr = "https://github.com/acme/app/pull/42"
    const m = machine({
      roster: {
        agents: [
          { name: "reviewer-x", pr, size: "big" },
          { name: "worker-x", pr, size: "small" },
        ],
      },
    })
    expect(await m.size("ops-checks-42")).toBe("small 1")
  })

  test("Checks on PR n pass over a checker named <id>-<kind> or with the roster's checker kind", async () => {
    const pr = "https://github.com/acme/app/pull/42"
    const m = machine({
      roster: {
        agents: [
          { name: "k3v9q2-reviewer", pr, size: "big" },
          { kind: "tester", name: "b7k2mq", pr, size: "big" },
          { name: "k3v9q2-worker", pr, size: "small" },
        ],
      },
    })
    expect(await m.size("ops-checks-42")).toBe("small 1")
  })

  test("Checks on PR n read only factory.repo's PR n", async () => {
    const m = machine({
      roster: {
        agents: [{ name: "worker-x", pr: "https://github.com/other/repo/pull/42", size: "small" }],
      },
    })
    expect(await m.size("ops-checks-42")).toBe("medium 2")
  })

  test("Checks under ops-checks-<n> read PR n's worker as ops-checks-<n> does", async () => {
    const pr = "https://github.com/acme/app/pull/42"
    const m = machine({ roster: { agents: [{ name: "k3v9q2-worker", pr, size: "small" }] } })
    expect(await m.size("ops-checks-42")).toBe("small 1")
  })

  test("the plan.json item its branch names, in either case", async () => {
    for (const branch of ["PG-7-thing", "pg-7-thing"]) {
      const m = machine({
        plan: { lanes: [{ items: [{ id: "PG-7", size: "big" }] }] },
        roster: { agents: [{ branch, name: "worker-x" }] },
      })
      expect(await m.size("worker-x")).toBe("big 3")
    }
  })

  test("the plan.json item whose spec is the issue its branch names", async () => {
    const m = machine({
      plan: {
        inFlight: [{ id: "x", size: "small", spec: "https://github.com/acme/app/issues/8" }],
      },
      roster: { agents: [{ branch: "pg-8-thing", name: "worker-x" }] },
    })
    expect(await m.size("worker-x")).toBe("small 1")
  })

  test("the plan.json item the checkout's branch names, when the roster names none", async () => {
    const m = machine({
      plan: { lanes: [{ items: [{ id: "PG-9", size: "big" }] }] },
      roster: { agents: [{ name: "worker-x" }] },
    })
    const repo = (branch: string) => {
      const dir = join(m.root, branch)
      mkdirSync(dir)
      Bun.spawnSync(["git", "init", "-q", "-b", branch], { cwd: dir })
      return dir
    }
    expect(await m.size("worker-x", {}, repo("pg-9-x"))).toBe("big 3")
    expect(await m.size("worker-x", {}, repo("pg-10-x"))).toBe("medium 2")
  })

  test("a commit's pre-commit build is small, whatever its branch's item", async () => {
    const m = machine({ plan: { lanes: [{ items: [{ id: "PG-9", size: "big" }] }] } })
    Bun.spawnSync(["git", "init", "-q", "-b", "pg-9-x"], { cwd: m.root })
    expect(await m.size("commit-pg-9-x")).toBe("small 1")
  })

  test("medium when nothing says", async () => {
    const m = machine({
      plan: { lanes: [] },
      roster: { agents: [{ name: "worker-x", size: "huge" }] },
    })
    expect(await m.size("worker-x")).toBe("medium 2")
    expect(await m.size("worker-none")).toBe("medium 2")
  })
})
