import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Comment, PrFacts } from "../../../../../packages/scripts/src/pr-merge/gates"
import type { Outcome, Run, RunResult } from "../../../../../packages/scripts/src/pr-merge/merge"
import { mergeReady, readyReport } from "../../../../../packages/scripts/src/pr-merge/ready"
import { TYPES_BUDGET_MS } from "../../../../../packages/scripts/src/pr-merge/types"
import { SKILL_BODY } from "./bodies"
import "./scratch-config"
import { greenChecks } from "./suite"

const scratch = mkdtempSync(join(tmpdir(), "pr-ready-"))
process.env.PLAYGROUND_MERGE_LOCK_DIR = join(scratch, "default-lock")
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const REPO = "o/r"
const OWNER = "o"
const HEAD = "a".repeat(40)
const CANARY = "c".repeat(40)
const TREE = "e".repeat(40)
const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const said = (body: string, author = OWNER): Comment => ({
  author,
  body,
  createdAt: "2026-10-19T10:00:00.000Z",
})

// A PR every gate passes at HEAD, behind canary by one commit, whose merge with canary gives TREE.
const factsOf = (over: Partial<PrFacts> = {}): PrFacts => ({
  aheadBy: 1,
  author: OWNER,
  base: "canary",
  body: SKILL_BODY,
  canary: CANARY,
  checks: greenChecks(),
  comments: [said(`## ReviewBot · round 1: 5/5 at ${HEAD.slice(0, 7)} · 0 blocking`)],
  draft: false,
  files: ["packages/scripts/src/x.ts"],
  head: HEAD,
  held: null,
  lost: [],
  mergeTree: TREE,
  n: 7,
  owner: OWNER,
  state: "OPEN",
  ...over,
})

// A stubbed gh holding one open PR, #7; it keeps each merge asked for.
function world(facts: PrFacts) {
  const merges: number[] = []
  const run: Run = async (args) => {
    const joined = args.join(" ")
    if (joined.startsWith("pr list"))
      return ok(JSON.stringify({ author: OWNER, draft: false, n: 7 }))
    return { code: 1, stderr: `unexpected gh ${joined}`, stdout: "" }
  }
  const lockRoot = mkdtempSync(join(scratch, "lock-"))
  const queue = join(lockRoot, "merge-queue.json")
  writeFileSync(queue, JSON.stringify({ queue: [{ pr: 7 }] }))
  const local = {
    facts: async () => facts,
    git: async () => ok(),
    lockRoot,
    merge: async (n: number): Promise<Outcome> => {
      merges.push(n)
      return { gates: [], kind: "merged", sha: "f".repeat(40) }
    },
    queue,
  }
  return {
    local,
    merges,
    ready: (gates?: string) => mergeReady({ repo: REPO }, run, { ...local, gates }),
  }
}

describe("pr:train ready", () => {
  test("a PR whose every gate passes merges through pr:merge, naming its checks", async () => {
    const w = world(factsOf())
    const readied = await w.ready()
    expect(w.merges).toEqual([7])
    expect(readied.merged).toMatchObject({ n: 7, why: "2 checks passed" })
  })

  // the Dashboard's Ready reads this file, so it holds pr:merge's own gates at the head, the tester's included (#2499)
  test("each call writes every read PR's failing gates at its head to the gates file it names", async () => {
    const held = world(factsOf({ files: ["web/next/src/x.tsx"] }))
    const gates = join(scratch, "gates-held", "gates.json")
    await held.ready(gates)
    expect(held.merges).toEqual([])
    const file = await Bun.file(gates).json()
    expect(file.prs).toEqual({ "o/r#7": { failed: ["tester"], head: HEAD } })
    expect(Number.isNaN(Date.parse(file.at))).toBe(false)

    const passing = world(factsOf({ draft: true }))
    const next = join(scratch, "gates-pass", "gates.json")
    await passing.ready(next)
    expect((await Bun.file(next).json()).prs).toEqual({ "o/r#7": { failed: [], head: HEAD } })
  })

  test("a gates file it cannot write still merges the ready PR", async () => {
    const w = world(factsOf({ draft: true }))
    const taken = join(scratch, "gates-taken")
    mkdirSync(join(taken, "full"), { recursive: true })
    expect((await w.ready(taken)).merged?.n).toBe(7)
  })

  test("the owner's draft whose only failing gate is ready still merges", async () => {
    const w = world(factsOf({ draft: true }))
    expect((await w.ready()).merged?.n).toBe(7)
  })

  test("a GitHub job still running, or none on the head, merges nothing", async () => {
    const running = greenChecks().map((check) => ({
      ...check,
      conclusion: null,
      status: "IN_PROGRESS",
    }))
    const wait = world(factsOf({ checks: running }))
    expect(await wait.ready()).toEqual({ refused: [], unreadable: [] })
    const none = world(factsOf({ checks: [] }))
    expect(await none.ready()).toEqual({ refused: [], unreadable: [] })
    expect([...wait.merges, ...none.merges]).toEqual([])
  })

  test("a PR template body merges, and a body that is not the template holds it", async () => {
    expect((await world(factsOf({ body: SKILL_BODY })).ready()).merged?.n).toBe(7)
    const short = world(factsOf({ body: "Outcome: one line.\n" }))
    expect(await short.ready()).toEqual({ refused: [], unreadable: [] })
    expect(short.merges).toEqual([])
  })

  // the merge train's 900s call of pr:train ready: a refused PR's types gate spends the budget the next PR's gate gets
  test("every pr:merge in one call shares one types budget", async () => {
    const run: Run = async (args) =>
      args.join(" ").startsWith("pr list")
        ? ok([7, 8].map((n) => JSON.stringify({ author: OWNER, draft: false, n })).join("\n"))
        : { code: 1, stderr: "unexpected gh", stdout: "" }
    const lockRoot = mkdtempSync(join(scratch, "lock-"))
    const queue = join(lockRoot, "merge-queue.json")
    writeFileSync(queue, JSON.stringify({ queue: [{ pr: 7 }, { pr: 8 }] }))
    const budgets: number[] = []
    const merge = async (n: number, typesBudgetMs: number): Promise<Outcome> => {
      budgets.push(typesBudgetMs)
      await Bun.sleep(20)
      return n === 7
        ? { gates: [{ detail: "could not finish", name: "types", ok: false }], kind: "refused" }
        : { gates: [], kind: "merged", sha: "f".repeat(40) }
    }
    const local = { facts: async () => factsOf(), git: async () => ok(), lockRoot, merge, queue }
    const readied = await mergeReady({ repo: REPO }, run, local)
    expect(readied.merged?.n).toBe(8)
    expect(budgets).toHaveLength(2)
    expect(budgets[0]).toBeLessThanOrEqual(TYPES_BUDGET_MS)
    expect(budgets[1]).toBeLessThanOrEqual((budgets[0] ?? 0) - 20)
  })

  // #1581: the merge train's job logs a failing run, so the error a held PR carries reaches its log as canary's throw did, while a call that merged exits 0 for the job to log the merge
  test("an unreadable PR is named on stderr, exiting 1 only when nothing merged", async () => {
    const why = "not gated: facts unreadable (gh pr view exited 1: API rate limit exceeded)"
    const three = async (mergeable: boolean) => {
      const run: Run = async (args) =>
        args.join(" ").startsWith("pr list")
          ? ok([3, 5, 7].map((n) => JSON.stringify({ author: OWNER, draft: false, n })).join("\n"))
          : { code: 1, stderr: "unexpected gh", stdout: "" }
      const lockRoot = mkdtempSync(join(scratch, "lock-"))
      const queue = join(lockRoot, "merge-queue.json")
      writeFileSync(queue, JSON.stringify({ queue: [{ pr: 3 }, { pr: 5 }, { pr: 7 }] }))
      const facts = async (_run: Run, _repo: string, n: number): Promise<PrFacts> => {
        if (n === 5) throw new Error("gh pr view exited 1: API rate limit exceeded")
        return factsOf(n === 7 && mergeable ? { n } : { comments: [], n })
      }
      const merge = async (): Promise<Outcome> => ({
        gates: [],
        kind: "merged",
        sha: "f".repeat(40),
      })
      return mergeReady({ repo: REPO }, run, {
        facts,
        git: async () => ok(),
        lockRoot,
        merge,
        queue,
      })
    }
    const unready = await three(false)
    expect(unready.merged).toBeUndefined()
    expect(unready.unreadable).toEqual([{ n: 5, why }])
    expect(readyReport(unready)).toMatchObject({ code: 1, errors: [`✗ #5 ${why}`] })
    const merged = await three(true)
    expect(merged.merged?.n).toBe(7)
    expect(readyReport(merged)).toMatchObject({ code: 0, errors: [`✗ #5 ${why}`] })
  })

  test("a refusal from pr:merge is named and nothing reads as merged", async () => {
    const w = world(factsOf())
    w.local.merge = async () => ({ gates: [], holder: "12", kind: "locked" })
    const readied = await w.ready()
    expect(readied.merged).toBeUndefined()
    expect(readied.refused).toEqual([{ n: 7, why: "the merge lock is held by 12" }])
  })
})
