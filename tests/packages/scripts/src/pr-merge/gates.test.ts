import { describe, expect, test } from "bun:test"

import {
  atHead,
  ciGate,
  gatesOf,
  marksReady,
  REQUIRED_CHECKS,
  withReadyDraft,
  type Comment,
  type PrFacts,
} from "../../../../../packages/scripts/src/pr-merge/gates"
import { SKILL_BODY } from "./bodies"
import "./scratch-config"
import { greenChecks } from "./suite"

const HEAD = "69a6a4c5e6caf46c4abda6a89de4ce6f3b309e88"
const OLD = "5740ceaa347f9c0f4e5a2f109f433e7838468b1f"
const CANARY = "6f3db1ea4cb7ea4072e0d5454da0026c89635cab"
const TREE = "1bd05088cad7c561f74d8912abe76184760003d9"

let clock = 0
const said = (body: string, author = "acme"): Comment => ({
  author,
  body,
  createdAt: new Date(Date.UTC(2026, 9, 6, 19, 0, clock++)).toISOString(),
})

const review = (sha = HEAD, score = 5) =>
  said(`## ReviewBot · round 2: ${score}/5 at ${sha.slice(0, 7)} · 0 blocking\n\nAll good.`)

const facts = (patch: Partial<PrFacts> = {}): PrFacts => ({
  aheadBy: 0,
  author: "acme",
  base: "canary",
  canary: CANARY,
  checks: greenChecks(),
  comments: [review()],
  draft: false,
  files: ["packages/scripts/src/pr-merge/gates.ts", "AGENTS.md"],
  head: HEAD,
  held: null,
  lost: [],
  mergeTree: TREE,
  n: 7,
  owner: "acme",
  state: "OPEN",
  ...patch,
})

const failing = (patch: Partial<PrFacts>) =>
  gatesOf(facts(patch))
    .filter((gate) => !gate.ok)
    .map((gate) => gate.name)

describe("atHead", () => {
  test("a verdict names the head by a prefix of seven or more characters", () => {
    expect(atHead("69a6a4c", HEAD)).toBe(true)
    expect(atHead(HEAD, HEAD)).toBe(true)
    expect(atHead("69a6a4", HEAD)).toBe(false)
    expect(atHead("5740cea", HEAD)).toBe(false)
  })
})

// Two runs of one check on a head, as a real PR's rollup listed them at 848e765.
const CANCELLED = {
  conclusion: "CANCELLED",
  name: "test",
  startedAt: "2026-10-21T14:46:01Z",
  status: "COMPLETED",
  workflowName: "Test",
}
const PASSED_RUN = { ...CANCELLED, conclusion: "SUCCESS", startedAt: "2026-10-21T14:47:24Z" }

describe("gatesOf", () => {
  test("every gate passes at the head: nothing fails", () => {
    expect(failing({})).toEqual([])
  })

  test("a PR by anyone but the repo's owner is refused unless --outside-author names its author", () => {
    const outside = facts({ author: "teammate-acme" })
    const author = (options = {}) => gatesOf(outside, options).find((g) => g.name === "author")
    expect(author()).toMatchObject({ ok: false })
    expect(author()?.detail).toContain("teammate-acme")
    expect(author({ outsideAuthor: "someone-else" })?.ok).toBe(false)
    expect(author({ outsideAuthor: "Teammate-Acme" })?.ok).toBe(true)
    expect(gatesOf(facts({ author: "ACME" })).find((g) => g.name === "author")?.ok).toBe(true)
  })

  test("a review at an earlier head, or by anyone else, does not count", () => {
    expect(failing({ comments: [review(OLD)] })).toEqual(["review"])
    expect(failing({ comments: [said(review().body, "someone-else")] })).toEqual(["review"])
    expect(failing({ comments: [review(), review(HEAD, 3)] })).toEqual(["review"])
  })

  test("behind canary, a head that merges clean passes, and a conflict waits for canary merged in", () => {
    const clean = gatesOf(facts({ aheadBy: 2 })).find((gate) => gate.name === "up to date")
    expect(clean).toMatchObject({ ok: true })
    expect(clean?.detail).toBe(
      "canary has 2 commits 69a6a4c lacks; it merges clean with canary 6f3db1e",
    )
    const conflict = gatesOf(facts({ aheadBy: 2, mergeTree: null })).find(
      (gate) => gate.name === "up to date",
    )
    expect(conflict).toMatchObject({ ok: false })
    expect(conflict?.detail).toContain("canary has 2 commits 69a6a4c lacks and conflicts with it")
  })

  test("a squash that would delete lines a canary merge dropped refuses, naming each file and merge (#1052)", () => {
    const lost = [
      { commit: CANARY, line: 4, path: "a.ts" },
      { commit: CANARY, line: 9, path: "a.ts" },
      { commit: TREE, line: 1, path: "new.ts" },
    ]
    expect(failing({ lost })).toEqual(["keeps canary"])
    const gate = gatesOf(facts({ lost })).find((g) => g.name === "keeps canary")
    expect(gate?.detail).toContain(
      "the squash would delete 3 lines canary added that a merge of canary dropped, which git's own merge keeps",
    )
    expect(gate?.detail).toContain("a.ts (dropped in 6f3db1e), new.ts (dropped in 1bd0508)")
    expect(gate?.detail).toContain("git merge origin/canary")
  })

  test("a squash whose lost lines all sit in scripts/hooks/bundled names bundles rebuilt inside the merge, and the redo (#673)", () => {
    const lost = [
      { commit: CANARY, line: 4, path: "scripts/hooks/bundled/no-stash.js" },
      { commit: CANARY, line: 9, path: "scripts/hooks/bundled/no-raw-spawn.js" },
    ]
    const gate = gatesOf(facts({ lost })).find((g) => g.name === "keeps canary")
    expect(gate).toMatchObject({ ok: false })
    expect(gate?.detail).toContain("scripts/hooks/bundled/no-stash.js (dropped in 6f3db1e)")
    expect(gate?.detail).toContain("bundles rebuilt inside the merge")
    expect(gate?.detail).toContain(
      "commit the merge with canary's bundles as they are, then run `bun run hooks:bundle` and commit the rebuild on its own",
    )
  })

  test("a squash with a lost line outside scripts/hooks/bundled keeps the plain redo (#673)", () => {
    const lost = [
      { commit: CANARY, line: 4, path: "scripts/hooks/bundled/no-stash.js" },
      { commit: CANARY, line: 9, path: "a.ts" },
    ]
    const gate = gatesOf(facts({ lost })).find((g) => g.name === "keeps canary")
    expect(gate?.detail).toContain("git merge origin/canary")
    expect(gate?.detail).not.toContain("bundles rebuilt inside the merge")
  })

  test("a squash it could not read refuses, saying why", () => {
    const gate = gatesOf(facts({ lost: "git rev-list exited 128" })).find(
      (g) => g.name === "keeps canary",
    )
    expect(gate).toMatchObject({
      detail: "could not read what the squash deletes: git rev-list exited 128",
      ok: false,
    })
  })

  test("a PR held-prs.json lists refuses, naming the reason the file gives", () => {
    const reason = "held for the tooltip notes (builder, 16 Oct)"
    expect(failing({ held: reason })).toEqual(["held"])
    expect(gatesOf(facts({ held: reason })).find((g) => g.name === "held")?.detail).toBe(reason)
  })

  test("a draft, a closed PR or another base refuses", () => {
    expect(failing({ draft: true })).toEqual(["ready"])
    expect(failing({ state: "MERGED" })).toEqual(["open"])
    expect(failing({ base: "main" })).toEqual(["base"])
  })

  test("a body that is not the PR template refuses, and one never read is not judged", () => {
    expect(failing({ body: "Closes #2410" })).toEqual(["body"])
    expect(gatesOf(facts()).some((gate) => gate.name === "body")).toBe(false)
  })

  test("the body gate refuses a changed doc the Evidence leaves out, from the PR's files", () => {
    const gate = gatesOf(facts({ body: SKILL_BODY })).find((g) => g.name === "body")
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("AGENTS.md")
    const named = SKILL_BODY.replace("**After:** one.", "**After:** one. `AGENTS.md` checked.")
    expect(gatesOf(facts({ body: named })).find((g) => g.name === "body")?.ok).toBe(true)
  })

  test("the body gate refuses an Outcome line in a PR's TL;DR, naming it", () => {
    const body = SKILL_BODY.replace("The board", "Outcome: The board")
    const gate = gatesOf(facts({ body })).find((g) => g.name === "body")
    expect(gate?.detail).toContain('labelled "Outcome:"')
  })

  test("a count of canary's lead that did not read refuses, and says so", () => {
    const gate = gatesOf(facts({ aheadBy: Number.NaN })).find((g) => g.name === "up to date")
    expect(gate).toEqual({
      detail: "could not read how far canary is ahead of 69a6a4c",
      name: "up to date",
      ok: false,
    })
  })

  test("the head's GitHub checks must all have finished and passed", () => {
    expect(ciGate([])).toEqual({ detail: "no checks reported", name: "ci", ok: true })
    const passed = [
      ...greenChecks(),
      { conclusion: "SKIPPED", name: "deploy", status: "COMPLETED" },
      { context: "ci/legacy", state: "SUCCESS" },
    ]
    expect(ciGate(passed).ok).toBe(true)
    expect(failing({ checks: passed })).toEqual([])
    const red = [
      { conclusion: "FAILURE", name: "test", status: "COMPLETED" },
      { conclusion: null, name: "lint", status: "IN_PROGRESS" },
      { context: "ci/legacy", state: "PENDING" },
    ]
    expect(ciGate(red)).toEqual({
      detail: "not passed: test failure, lint in_progress, ci/legacy pending",
      name: "ci",
      ok: false,
    })
    expect(failing({ checks: red })).toEqual(["ci"])
  })

  test("a head missing a required GitHub job refuses, naming it, until GitHub runs it", () => {
    expect(REQUIRED_CHECKS).toEqual(["Audit, Lint, and Build", "test"])
    expect(failing({ checks: [] })).toEqual(["ci"])
    const onlyTest = greenChecks().filter((check) => check.name === "test")
    expect(gatesOf(facts({ checks: onlyTest })).find((g) => g.name === "ci")).toEqual({
      detail: "no Audit, Lint, and Build check on the head yet: GitHub runs it on every push",
      name: "ci",
      ok: false,
    })
  })

  // #1676: run 42670675952 ended failure with every job it ran green and no gate job at all
  test("a run that finished green without its gate job names the rerun, while one still running waits", () => {
    const job = (name: string, status = "COMPLETED") => ({
      conclusion: status === "COMPLETED" ? "SUCCESS" : null,
      detailsUrl: `https://github.com/nrjdalal/playground/actions/runs/42670675952/job/${name.length}`,
      name,
      startedAt: "2026-11-09T18:04:17Z",
      status,
      workflowName: "auto-check-build",
    })
    const test = { ...job("test"), workflowName: "auto-test" }
    expect(
      ciGate([job("Lint and Build"), job("Suite (1)"), test], { required: REQUIRED_CHECKS }),
    ).toEqual({
      detail:
        "no Audit, Lint, and Build check on the head, though every job of its auto-check-build run passed: GitHub ended that run without creating it; rerun it with `gh run rerun 42670675952`",
      name: "ci",
      ok: false,
    })
    expect(
      ciGate([job("Lint and Build"), job("Suite (1)", "IN_PROGRESS"), test], {
        required: REQUIRED_CHECKS,
      }),
    ).toEqual({
      detail: "no Audit, Lint, and Build check on the head yet: GitHub runs it on every push",
      name: "ci",
      ok: false,
    })
  })

  test("a second run on the head with fewer shards names its own run id, not the first run's", () => {
    const job = (run: number, name: string) => ({
      conclusion: "SUCCESS",
      detailsUrl: `https://github.com/nrjdalal/playground/actions/runs/${run}/job/${name.length}`,
      name,
      startedAt: run === 42670675952 ? "2026-11-09T18:04:17Z" : "2026-11-09T17:40:00Z",
      status: "COMPLETED",
      workflowName: "auto-check-build",
    })
    const test = { ...job(42670675952, "test"), workflowName: "auto-test" }
    const checks = [
      job(42668000001, "Suite (15)"),
      job(42670675952, "Lint and Build"),
      job(42670675952, "Suite (1)"),
      test,
    ]
    expect(ciGate(checks, { required: REQUIRED_CHECKS }).detail).toContain(
      "`gh run rerun 42670675952`",
    )
  })

  test("an older cancelled run beside a newer pass of the same check passes", () => {
    expect(ciGate([CANCELLED, PASSED_RUN])).toEqual({
      detail: "1 check passed",
      name: "ci",
      ok: true,
    })
  })

  test("a cancelled run newer than the pass refuses, judged apart by workflow", () => {
    const newest = [PASSED_RUN, { ...CANCELLED, startedAt: "2026-10-21T14:48:00Z" }]
    expect(ciGate(newest)).toEqual({ detail: "not passed: test cancelled", name: "ci", ok: false })
    const apart = [
      PASSED_RUN,
      { ...CANCELLED, startedAt: "2026-10-21T14:50:00Z", workflowName: "Other" },
    ]
    expect(ciGate(apart)).toEqual({ detail: "not passed: test cancelled", name: "ci", ok: false })
  })

  test("a queued rerun, which reads no start time yet, keeps the gate pending", () => {
    const queued = {
      ...PASSED_RUN,
      conclusion: null,
      startedAt: "0001-01-01T00:00:00Z",
      status: "QUEUED",
    }
    expect(ciGate([CANCELLED, PASSED_RUN, queued])).toEqual({
      detail: "not passed: test queued",
      name: "ci",
      ok: false,
    })
  })
})

describe("marking a draft ready", () => {
  test("the owner's draft whose every other gate passes is marked ready; a failing one is not", () => {
    const draft = facts({ draft: true })
    expect(marksReady(draft, gatesOf(draft))).toBe(true)
    expect(withReadyDraft(draft, gatesOf(draft), "marked").find((g) => g.name === "ready")).toEqual(
      { detail: "marked", name: "ready", ok: true },
    )
    const red = facts({ comments: [review(HEAD, 3)], draft: true })
    expect(marksReady(red, gatesOf(red))).toBe(false)
    expect(marksReady(facts({ author: "someone", draft: true }), [])).toBe(false)
  })
})

describe("a head with no finished GitGuardian check", () => {
  const passed = { conclusion: "SUCCESS", name: "GitGuardian Security Checks", status: "COMPLETED" }
  const guarded = (patch: Partial<PrFacts>) =>
    gatesOf(facts(patch), { gitGuardian: true })
      .filter((gate) => !gate.ok)
      .map((gate) => gate.name)

  test("refuses on a guarded repo, and passes once GitGuardian has passed at the head", () => {
    expect(guarded({})).toEqual(["ci"])
    expect(guarded({ checks: [...greenChecks(), passed] })).toEqual([])
    expect(failing({})).toEqual([])
  })

  test("a GitGuardian check still running refuses ci", () => {
    const running = { conclusion: "", name: "GitGuardian Security Checks", status: "IN_PROGRESS" }
    const gates = gatesOf(facts({ checks: [...greenChecks(), running] }), { gitGuardian: true })
    expect(gates.filter((g) => !g.ok).map((g) => g.name)).toEqual(["ci"])
  })
})

// a web/next PR merged on ready while its tester's drive was still open, with no TesterBot line at its head (PG-2485).
describe("the tester gate holds a web/next diff for its tester's PASS at the head", () => {
  const tester = (word: "FAIL" | "PASS", sha = HEAD, author = "acme") =>
    said(`## TesterBot · ${word} at ${sha.slice(0, 7)} · both shots attached`, author)
  const ui = ["web/next/src/components/dashboard/row.tsx", "AGENTS.md"]
  const gate = (patch: Partial<PrFacts>) => gatesOf(facts(patch)).find((g) => g.name === "tester")

  test("a PASS at the head passes, naming the line", () => {
    expect(gate({ comments: [review(), tester("PASS")], files: ui })).toEqual({
      detail: "## TesterBot · PASS at 69a6a4c · both shots attached",
      name: "tester",
      ok: true,
    })
  })

  test.each([
    ["no verdict", [review()]],
    ["a FAIL at the head", [review(), tester("FAIL")]],
    ["a PASS at an older head", [review(), tester("PASS", OLD)]],
    ["a PASS by anyone else", [review(), tester("PASS", HEAD, "someone-else")]],
    ["a PASS then a FAIL at the head", [review(), tester("PASS"), tester("FAIL")]],
  ])("%s refuses", (_, comments) => {
    expect(failing({ comments, files: ui })).toEqual(["tester"])
  })

  test("its refusal names the line it waits for and the head", () => {
    expect(gate({ files: ui })?.detail).toBe(
      "a web/next diff waits for its tester's drive: missing ## TesterBot · PASS at 69a6a4c from acme; spawn or resume the PR's tester, which posts ## TesterBot · PASS at 69a6a4c",
    )
    expect(gate({ comments: [review(), tester("FAIL")], files: ui })?.detail).toBe(
      "newest tester verdict is not a pass: ## TesterBot · FAIL at 69a6a4c · both shots attached",
    )
  })

  test("a diff with no web/next file meets no tester gate", () => {
    expect(gate({ files: ["packages/scripts/src/pr-merge/gates.ts", "web/nextish.md"] })).toBe(
      undefined,
    )
  })
})

// a PR broke curl | bash and it showed only at the ship's new-user gate, so a diff on what a new user meets first waits for that gate's PASS at its head (PG-2496).
describe("the new-user gate holds an installer or first-run diff for the gate's PASS at the head", () => {
  const ran = (word: "FAIL" | "INCONCLUSIVE" | "PASS", sha = HEAD, why = "7 of 7 passed") =>
    said(`## NewUserGate · ${word} at ${sha.slice(0, 7)} · ${why}`)
  const files = ["install.sh", "AGENTS.md"]
  const gate = (patch: Partial<PrFacts>) => gatesOf(facts(patch)).find((g) => g.name === "new-user")

  test("a PASS at the head passes, naming the line", () => {
    expect(gate({ comments: [review(), ran("PASS")], files })).toEqual({
      detail: "## NewUserGate · PASS at 69a6a4c · 7 of 7 passed",
      name: "new-user",
      ok: true,
    })
  })

  test.each([
    ["no verdict", [review()]],
    ["a FAIL at the head", [review(), ran("FAIL", HEAD, "6 of 7 passed")]],
    ["an INCONCLUSIVE at the head", [review(), ran("INCONCLUSIVE", HEAD, "6 of 7 passed")]],
    ["a PASS at an older head", [review(), ran("PASS", OLD)]],
    ["a PASS by anyone else", [review(), said(ran("PASS").body, "someone-else")]],
  ])("%s refuses", (_, comments) => {
    expect(failing({ comments, files })).toEqual(["new-user"])
  })

  test("an INCONCLUSIVE refuses like a FAIL, printing its reason", () => {
    const why = "6 of 7 passed, 1 inconclusive; 7. Usage: spawn refused"
    expect(gate({ comments: [review(), ran("INCONCLUSIVE", HEAD, why)], files })?.detail).toBe(
      `newest new-user gate verdict is not a pass: ## NewUserGate · INCONCLUSIVE at 69a6a4c · ${why}`,
    )
  })

  test("its refusal names the matched files and the run that posts the verdict", () => {
    expect(gate({ files })?.detail).toBe(
      "install.sh waits for the new-user gate: missing ## NewUserGate · PASS at 69a6a4c from acme; run ~/.playground/ops/run-slot.sh <your name> -- bun run gate:new-user 69a6a4c5e6caf46c4abda6a89de4ce6f3b309e88 --pr 7",
    )
  })

  test("a diff matching no path meets no new-user gate", () => {
    expect(gate({})).toBe(undefined)
  })
})

describe("the parent gate refuses a stacked PR while its parent is unmerged (PG-1274)", () => {
  const stacked = (line: string) => `${SKILL_BODY}\n- ${line}`
  const parent = (patch: Partial<PrFacts>) =>
    gatesOf(facts(patch)).find((gate) => gate.name === "parent")

  test("an open parent refuses, naming it", () => {
    const gate = parent({ body: stacked("Stacked on #12"), parents: [{ n: 12, state: "OPEN" }] })
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("#12")
    expect(gate?.detail).toContain("still open")
  })

  test("a parent closed without merging refuses, saying how to clear it", () => {
    const gate = parent({ body: stacked("Stacked on #12"), parents: [{ n: 12, state: "CLOSED" }] })
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("closed without merging")
    expect(gate?.detail).toContain("remove the `Stacked on #12` line")
  })

  test("a parent whose state did not read refuses, so the gate fails closed", () => {
    const parents = [{ n: 12, state: "unreadable: gh exited 1" }]
    const gate = parent({ body: stacked("Stacked on #12"), parents })
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("could not be read")
  })

  test("a body with a Stacked on line never reaches the gates with its parents unread", () => {
    const gate = parent({ body: `${stacked("stacked on #12")}\nSTACKED ON #12` })
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("#12")
  })

  test("every parent merged, or none declared, passes as today", () => {
    const merged = [
      { n: 12, state: "MERGED" },
      { n: 13, state: "MERGED" },
    ]
    expect(parent({ body: stacked("Stacked on #12, Stacked on #13"), parents: merged })?.ok).toBe(
      true,
    )
    expect(parent({ body: SKILL_BODY, parents: [] })).toBeUndefined()
    expect(parent({ body: SKILL_BODY })).toBeUndefined()
    expect(parent({})).toBeUndefined()
  })

  test("a list of parents on one line names each, and a declared parent left out of the states reads as never read", () => {
    const merged = [
      { n: 78, state: "MERGED" },
      { n: 75, state: "MERGED" },
    ]
    for (const line of ["Stacked on #78 and #75", "stacked on #78, #75", "Stacked on #78 & #75"])
      expect(parent({ body: stacked(line), parents: merged })?.ok).toBe(true)
    const gate = parent({ body: stacked("Stacked on #78 and #75"), parents: [merged[0]!] })
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("#75")
    expect(gate?.detail).not.toContain("#78")
  })

  test("one unmerged parent among merged ones refuses, naming that one alone", () => {
    const parents = [
      { n: 12, state: "MERGED" },
      { n: 13, state: "OPEN" },
    ]
    const gate = parent({ body: stacked("Stacked on #12, Stacked on #13"), parents })
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("#13")
    expect(gate?.detail).not.toContain("#12")
  })
})

// a PR could change CI's workflows, the merge gates or a refused-forms row, and the same review passed it like any other diff (PG-2576).
describe("the checks gate holds a PR that changes a check judging it for its 5/5 to name each change", () => {
  const WORKFLOW = ".github/workflows/auto-test.yml"
  const ROW = "tests/scripts/hooks/fixtures/refused-forms/2522.ts"
  const named = (...paths: string[]) =>
    said(
      [
        "## ReviewBot · round 2: 5/5 at 69a6a4c · 0 blocking",
        "",
        ...paths.map((path) => `Reviewed check change: \`${path}\``),
      ].join("\n"),
    )
  const gate = (patch: Partial<PrFacts>) =>
    gatesOf(facts({ removed: [], ...patch })).find((g) => g.name === "checks")

  test("a workflow change with no line in its 5/5 is refused, naming the file and the line", () => {
    expect(failing({ files: [WORKFLOW, "AGENTS.md"], removed: [] })).toEqual(["checks"])
    expect(gate({ files: [WORKFLOW] })?.detail).toBe(
      "the PR changes a check that judges it (.github/workflows/auto-test.yml): its 5/5 at 69a6a4c does not name .github/workflows/auto-test.yml in a `Reviewed check change: <path>` line",
    )
  })

  test("the same change with the line in its 5/5 passes", () => {
    expect(gate({ comments: [named(WORKFLOW)], files: [WORKFLOW, "AGENTS.md"] })).toEqual({
      detail: "its 5/5 names each check change: .github/workflows/auto-test.yml",
      name: "checks",
      ok: true,
    })
  })

  test.each([
    "packages/config/src/verdicts.ts",
    "packages/scripts/src/new-user-gate/paths.ts",
    ".github/actions/install-zsh/action.yml",
    "tests/scripts/hooks/fixtures/refused-forms.ts",
    "tests/scripts/hooks/refused-forms.test.ts",
  ])("%s, a check judging the PR, needs the checks gate", (path) => {
    expect(failing({ files: [path], removed: [] })).toContain("checks")
    expect(gate({ comments: [named(path)], files: [path] })?.ok).toBe(true)
  })

  test.each([".github/assets/banner.png", "packages/scripts/src/pr-merge-notes.md"])(
    "%s, beside a check but none, meets a passing checks gate",
    (path) => {
      expect(gate({ files: [path] })?.ok).toBe(true)
    },
  )

  test("a refused-forms file the diff deletes a line from, with no line, is refused", () => {
    expect(failing({ files: [ROW], removed: [ROW] })).toEqual(["checks"])
    expect(gate({ comments: [named(ROW)], files: [ROW], removed: [ROW] })?.ok).toBe(true)
  })

  test("a refused-forms file the diff only adds to changes no check", () => {
    expect(gate({ files: [ROW] })).toEqual({
      detail: "the PR changes no check that judges it",
      name: "checks",
      ok: true,
    })
  })

  test("a PR touching none of them passes", () => {
    expect(gate({ files: ["AGENTS.md", "packages/scripts/src/ship/cli.ts"] })?.ok).toBe(true)
  })

  test("a verdict naming a path outside the diff and missing one in it is refused, naming the missing one", () => {
    const missed = "packages/scripts/src/pr-merge/gates.ts"
    const result = gate({ comments: [named(WORKFLOW, "AGENTS.md")], files: [WORKFLOW, missed] })
    expect(result?.ok).toBe(false)
    expect(result?.detail).toBe(
      "the PR changes a check that judges it (.github/workflows/auto-test.yml, packages/scripts/src/pr-merge/gates.ts): its 5/5 at 69a6a4c does not name packages/scripts/src/pr-merge/gates.ts in a `Reviewed check change: <path>` line",
    )
  })

  test.each([
    [
      "a line under a 4/5",
      () => said(`## ReviewBot · round 2: 4/5 at 69a6a4c\n\nReviewed check change: ${WORKFLOW}`),
    ],
    [
      "a line under a 5/5 at an older head",
      () => said(`## ReviewBot · round 1: 5/5 at 5740cea\n\nReviewed check change: ${WORKFLOW}`),
    ],
    [
      "a line by anyone else",
      () =>
        said(
          `## ReviewBot · round 2: 5/5 at 69a6a4c\n\nReviewed check change: ${WORKFLOW}`,
          "someone-else",
        ),
    ],
    ["a line in a comment that is no verdict", () => said(`Reviewed check change: ${WORKFLOW}`)],
  ])("%s does not count", (_, comment) => {
    expect(gate({ comments: [review(), comment()], files: [WORKFLOW] })?.ok).toBe(false)
  })

  test("facts read with no removed list, as a test's, meet no checks gate", () => {
    expect(gatesOf(facts({ files: [WORKFLOW] })).find((g) => g.name === "checks")).toBe(undefined)
  })
})
