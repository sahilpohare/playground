import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Check } from "../../../../../packages/scripts/src/pr-merge/gates"
import {
  FREEZE_LAPSE_MS,
  freezeLine,
  startFreeze,
} from "../../../../../packages/scripts/src/pr-merge/held"
import type { Run, RunResult } from "../../../../../packages/scripts/src/pr-merge/merge"
import {
  gateLine,
  rehearsalLine,
  WAIVER_LABEL,
  waiverLine,
} from "../../../../../packages/scripts/src/pr-merge/ship-lines"
import {
  nextVersion,
  shipFactsOf,
  shipMerge,
  shipRefusals,
  type InboxItem,
  type ShipFacts,
} from "../../../../../packages/scripts/src/pr-merge/ship-merge"
import { storeWith } from "../../../../scripts/hooks/render-set"
import "./scratch-config"
import { greenChecks } from "./suite"

const HEAD = "a11fb8850c8304a91ab714b2ff46ad89fe7411a7"
const OTHER = "6d8ab5ace7734a46201c0061cb9e961fbd5f5aa3"
const REPO = "acme/factory"

const scratch = mkdtempSync(join(tmpdir(), "ship-merge-"))
// The suite's own held list: no test reads the factory's real one.
const HELD = join(scratch, "held-prs.json")
process.env.PLAYGROUND_HELD_PRS = HELD
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const ready = (): ShipFacts => ({
  base: "main",
  body: `Two sentences.\n\n${gateLine(HEAD, false)}\n${rehearsalLine(HEAD, "PASS")}\n\n## What ships\n`,
  checks: greenChecks(),
  decision: null,
  dispatcher: "dispatcher",
  freeze: freezeLine("v0.0.84"),
  head: HEAD,
  state: "OPEN",
  version: "v0.0.84",
})
const refusals = (facts: Partial<ShipFacts>) => shipRefusals({ ...ready(), ...facts })
const red = (name: string, conclusion: string): Check => ({
  ...greenChecks().find((check) => check.name === name)!,
  conclusion,
})

describe("shipRefusals (#1659)", () => {
  test("a ship PR with the pin's gate and rehearsal lines, both checks green and its freeze set may merge", () => {
    expect(shipRefusals(ready())).toEqual([])
  })

  test("(a) a body with no gate line for the pin refuses, naming the gate to run", () => {
    expect(refusals({ body: rehearsalLine(HEAD, "PASS") })).toEqual([
      expect.stringContaining(`no "${gateLine(HEAD, false)}" line`),
    ])
    expect(
      refusals({ body: `${gateLine(OTHER, false)}\n${rehearsalLine(HEAD, "PASS")}` }),
    ).toHaveLength(1)
  })

  test("(a) a FAIL gate line for the pin refuses, beside a PASS line too", () => {
    const failed = `${gateLine(HEAD, true)}\n${rehearsalLine(HEAD, "PASS")}`
    expect(refusals({ body: failed })).toEqual([expect.stringContaining("FAIL")])
    expect(refusals({ body: `${gateLine(HEAD, false)}\n${failed}` })).toHaveLength(1)
  })

  test("(b) a body with no rehearsal line for the pin refuses; a not-needed one may merge", () => {
    expect(refusals({ body: gateLine(HEAD, false) })).toEqual([
      expect.stringContaining("Invitee rehearsal at"),
    ])
    expect(
      refusals({ body: `${gateLine(HEAD, false)}\n${rehearsalLine(HEAD, "FAIL")}` }),
    ).toHaveLength(1)
    expect(
      refusals({ body: `${gateLine(HEAD, false)}\n${rehearsalLine(HEAD, "not needed")}` }),
    ).toEqual([])
  })

  test("(c) a red or a missing gate check at the pin refuses, naming it, while an other check's red does not", () => {
    expect(refusals({ checks: [red("test", "FAILURE"), greenChecks()[0]!] })).toEqual([
      expect.stringContaining("test failure"),
    ])
    expect(refusals({ checks: greenChecks().filter((c) => c.name === "test") })).toEqual([
      expect.stringContaining("Audit, Lint, and Build"),
    ])
    const other = { conclusion: "FAILURE", name: "Audit canary", status: "COMPLETED" }
    expect(refusals({ checks: [...greenChecks(), other] })).toEqual([])
  })

  test("(d) no freeze, a lapsed one or another version's refuses, naming ship:freeze", () => {
    expect(refusals({ freeze: null })).toEqual([expect.stringContaining("ship:freeze v0.0.84")])
    expect(refusals({ freeze: freezeLine("v0.0.83") })).toHaveLength(1)
    expect(refusals({ freeze: "Ops: hold for the outage" })).toHaveLength(1)
  })

  test("a PR that is not an open PR into main refuses", () => {
    expect(refusals({ base: "canary" })).toEqual([expect.stringContaining("into main")])
    expect(refusals({ state: "MERGED" })).toHaveLength(1)
  })
})

const ID = "5f0c2a7e-3b1d-4c8e-9a6f-2d4b8e1c7a90"
// A decision as playground ask get prints it, the owner's Approve on its first row.
const decision = (): InboxItem => ({
  answer: { at: "2026-11-16T09:37:11.797Z", choice: "approve", option: 0 },
  from: "dispatcher",
  id: ID,
  kind: "decision",
  preview: {
    options: [
      { label: "Ship everything now, skip the new-user check this once" },
      { label: "Copy only this fix to main now, outside the usual ship" },
    ],
    text: "Ship v0.0.84 now: the fix and two more.",
    type: "ask",
  },
  status: "approved",
  title: "Ship the fix now, or wait?",
})
const waived = `${waiverLine(HEAD, ID)}\n${rehearsalLine(HEAD, "PASS")}`
const waiver = (item: Partial<InboxItem> | string) =>
  refusals({
    body: waived,
    decision: typeof item === "string" ? item : { ...decision(), ...item },
  })

describe("shipRefusals takes a new-user gate waived by an approved Inbox decision (#2355)", () => {
  test("a waiver line for the head naming the dispatcher's decision the owner approved for this version may merge", () => {
    expect(waiver({})).toEqual([])
    expect(
      waiver({ preview: { ...decision().preview, text: "none" }, title: "Ship v0.0.84?" }),
    ).toEqual([])
  })

  test("the waiver line reads its head and Inbox id", () => {
    expect(waiverLine(HEAD, ID)).toBe(`New-user gate at ${HEAD}: waived by Inbox ${ID}`)
  })

  test("a FAIL line for the head refuses beside a waiver", () => {
    expect(refusals({ body: `${gateLine(HEAD, true)}\n${waived}`, decision: decision() })).toEqual([
      expect.stringContaining("FAIL"),
    ])
  })

  test("a waiver at another head refuses, naming the head it needs", () => {
    expect(
      refusals({
        body: `${waiverLine(OTHER, ID)}\n${rehearsalLine(HEAD, "PASS")}`,
        decision: decision(),
      }),
    ).toEqual([expect.stringContaining(`"${waiverLine(HEAD, "<id>")}"`)])
  })

  test("a decision that did not read refuses, naming why", () => {
    expect(waiver("playground ask get exited 1: no inbox item")).toEqual([
      `gate: Inbox ${ID} did not read (playground ask get exited 1: no inbox item)`,
    ])
  })

  test("a decision still open, denied or settled by its poster refuses: approved is the owner's Approve alone", () => {
    for (const status of ["open", "denied", "done"])
      expect(waiver({ status })).toEqual([
        `gate: Inbox ${ID} reads ${status}, not approved by the owner`,
      ])
  })

  test("another kind or another sender refuses; the sender is the dispatcher's configured name", () => {
    expect(waiver({ kind: "draft" })).toEqual([`gate: Inbox ${ID} is a draft, not a decision`])
    expect(waiver({ from: "builder" })).toEqual([
      `gate: Inbox ${ID} is from builder, not dispatcher`,
    ])
    const alpha = { body: waived, decision: { ...decision(), from: "alpha" } }
    expect(refusals({ ...alpha, dispatcher: "alpha" })).toEqual([])
    expect(refusals(alpha)).toEqual([`gate: Inbox ${ID} is from alpha, not dispatcher`])
  })

  test("a decision naming another version, or this one only as a prefix, refuses", () => {
    const named = `gate: Inbox ${ID} names no v0.0.84 in its title or text`
    expect(waiver({ preview: { ...decision().preview, text: "Ship v0.0.83 now." } })).toEqual([
      named,
    ])
    expect(waiver({ preview: { ...decision().preview, text: "Ship v0.0.840 now." } })).toEqual([
      named,
    ])
  })

  test("the waiver row is #i17's option 0, word for word", () => {
    expect(WAIVER_LABEL).toBe("Ship everything now, skip the new-user check this once")
    const padded = { ...decision().preview, options: [{ label: ` ${WAIVER_LABEL} ` }] }
    expect(waiver({ preview: padded })).toEqual([])
  })

  test("an Approve on any other row refuses, a negation or a near wording included, as does an Edit", () => {
    const not = (option: number, label: string) =>
      `gate: Inbox ${ID} approved option ${option} "${label}", not "${WAIVER_LABEL}"`
    expect(waiver({ answer: { choice: "approve", option: 1 } })).toEqual([
      not(1, "Copy only this fix to main now, outside the usual ship"),
    ])
    for (const label of [
      "Do not skip the new-user check",
      "Wait until the new-user check passes",
      "Ship everything now, skip the new-user check",
    ]) {
      const preview = { ...decision().preview, options: [{ label }, { label: WAIVER_LABEL }] }
      expect(waiver({ preview })).toEqual([not(0, label)])
    }
    expect(waiver({ answer: { choice: "edit", editedText: "ship it" } })).toEqual([
      `gate: Inbox ${ID} was approved by edit, whose own words name no row`,
    ])
  })

  test("a one-row ask approved with no option reads its row, as the Inbox does", () => {
    const preview = { ...decision().preview, options: [{ label: WAIVER_LABEL }] }
    expect(waiver({ answer: { choice: "approve" }, preview })).toEqual([])
  })

  test("an ask's approve label is its row, whatever the text says", () => {
    const text = "The new-user check failed on v0.0.84; skip it?"
    const held = { approve: "Hold the ship and fix it first", text, type: "ask" }
    expect(waiver({ answer: { choice: "approve" }, preview: held })).toEqual([
      `gate: Inbox ${ID} approved option 0 "Hold the ship and fix it first", not "${WAIVER_LABEL}"`,
    ])
    const skip = { ...held, approve: WAIVER_LABEL }
    expect(waiver({ answer: { choice: "approve" }, preview: skip })).toEqual([])
  })

  test("a multi-question ask refuses: a waiver takes a single-question decision", () => {
    const questions = [{ options: [{ label: WAIVER_LABEL }], question: "Ship?" }]
    const preview = { questions, text: "Ship v0.0.84?", type: "ask" }
    expect(waiver({ answer: { choice: "approve", options: [0, 0] }, preview })).toEqual([
      `gate: Inbox ${ID} is a multi-question ask: a waiver takes a single-question decision`,
    ])
  })

  test("a decision with no row its poster wrote refuses, whatever its title or text says", () => {
    const none = `gate: Inbox ${ID} has no "${WAIVER_LABEL}" row: its poster wrote none`
    const plain = { answer: { choice: "approve" }, title: `${WAIVER_LABEL}: v0.0.84` }
    expect(waiver({ ...plain, preview: { text: "Ship v0.0.84 now.", type: "ask" } })).toEqual([
      none,
    ])
    expect(waiver({ ...plain, preview: { text: "Ship v0.0.84 now.", type: "ship" } })).toEqual([
      none,
    ])
  })
})

test("nextVersion takes the last tag's patch plus one, and refuses a tag that is not vX.Y.Z", () => {
  expect(nextVersion("v0.0.83")).toBe("v0.0.84")
  expect(nextVersion("v1.2.9\n")).toBe("v1.2.10")
  expect(() => nextVersion("")).toThrow("not vX.Y.Z")
})

// A gh that answers the ship PR's view, the latest tag, and the merge.
const stub = (body: string) => {
  const calls: string[][] = []
  const ok = (stdout: string): RunResult => ({ code: 0, stderr: "", stdout })
  const run: Run = async (args) => {
    calls.push(args)
    const joined = args.join(" ")
    if (joined.startsWith("pr view") && joined.includes("statusCheckRollup"))
      return ok(
        JSON.stringify({
          baseRefName: "main",
          body,
          headRefOid: HEAD,
          state: "OPEN",
          statusCheckRollup: greenChecks(),
        }),
      )
    if (joined.includes("releases/latest")) return ok("v0.0.83\n")
    if (joined.startsWith("pr merge")) return ok("")
    if (joined.includes("mergeCommit")) return ok("c400e3cb57db6a8addfabacaea06c703ae1fa964\n")
    return { code: 1, stderr: `unexpected gh ${joined}`, stdout: "" }
  }
  return { calls, run }
}

describe("shipMerge (#1659)", () => {
  test("merges with a merge commit at exactly the head it read, and returns the merge commit", async () => {
    await startFreeze(HELD, "v0.0.84")
    const { calls, run } = stub(ready().body)
    expect(await shipMerge(run, REPO, 1633)).toEqual({
      sha: "c400e3cb57db6a8addfabacaea06c703ae1fa964",
    })
    expect(calls.filter((args) => args[1] === "merge")).toEqual([
      ["pr", "merge", "1633", "-R", REPO, "--merge", "--match-head-commit", HEAD],
    ])
  })

  test("(d) a freeze read past its lapse holds nothing, so it refuses", async () => {
    const written = Date.now()
    await startFreeze(HELD, "v0.0.84", new Date(written))
    const { run } = stub(ready().body)
    expect((await shipFactsOf(run, REPO, 1633, written + 60_000)).freeze).toBe(
      freezeLine("v0.0.84"),
    )
    const late = await shipFactsOf(run, REPO, 1633, written + FREEZE_LAPSE_MS + 60_000)
    expect(late.freeze).toBeNull()
    expect(shipRefusals(late)).toEqual([expect.stringContaining('no "*" line holds')])
  })

  test("a waived ship reads its decision through playground ask get alone, and merges on the owner's go (#2355)", async () => {
    await startFreeze(HELD, "v0.0.84")
    const asked: string[][] = []
    const ask: Run = async (args) => {
      asked.push(args)
      // playground ask get prints bun run's command line before the item
      return { code: 0, stderr: "", stdout: `$ bun ask get ${ID}\n${JSON.stringify(decision())}\n` }
    }
    const { calls, run } = stub(waived)
    expect(await shipMerge(run, REPO, 1633, ask)).toEqual({
      sha: "c400e3cb57db6a8addfabacaea06c703ae1fa964",
    })
    expect(asked).toEqual([["ask", "get", ID]])
    expect(calls.filter((args) => args[1] === "merge")).toHaveLength(1)
    asked.length = 0
    await shipFactsOf(stub(ready().body).run, REPO, 1633, Date.now(), ask)
    expect(asked).toEqual([])
  })

  test("the dispatcher's name comes from sessions.names, its default until set (#2355)", async () => {
    const data = process.env.PLAYGROUND_DATA_DIR!
    const { run } = stub(ready().body)
    expect((await shipFactsOf(run, REPO, 1633)).dispatcher).toBe("dispatcher")
    const names = { builder: "builder", dispatcher: "alpha", ops: "ops", planner: "planner" }
    storeWith(data, {}, { "factory.repo": REPO, "sessions.names": names })
    try {
      expect((await shipFactsOf(run, REPO, 1633)).dispatcher).toBe("alpha")
    } finally {
      storeWith(data, {}, { "factory.repo": REPO })
    }
  })

  test("an Inbox that does not answer refuses the waived ship, naming why (#2355)", async () => {
    await startFreeze(HELD, "v0.0.84")
    const ask: Run = async () => ({ code: 1, stderr: "no inbox item\n", stdout: "" })
    const facts = await shipFactsOf(stub(waived).run, REPO, 1633, Date.now(), ask)
    expect(shipRefusals(facts)).toEqual([
      `gate: Inbox ${ID} did not read (playground ask get ${ID} exited 1: no inbox item)`,
    ])
  })

  test("a refusal merges nothing", async () => {
    await startFreeze(HELD, "v0.0.84")
    const { calls, run } = stub(rehearsalLine(HEAD, "PASS"))
    expect(await shipMerge(run, REPO, 1633)).toEqual({ refusals: [expect.any(String)] })
    expect(calls.some((args) => args[1] === "merge")).toBe(false)
  })
})
