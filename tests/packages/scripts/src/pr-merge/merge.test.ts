import { afterAll, afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import type { LockStore } from "../../../../../packages/redis/src/index"
import { codeGate } from "../../../../../packages/scripts/src/pr-merge/gates"
import { FREEZE_LAPSE_MS } from "../../../../../packages/scripts/src/pr-merge/held"
import {
  gateCodeOf,
  gateOptions,
  isServerError,
  lockRootOf,
  realLockRoot,
  prMerge,
  runGh,
  shipNowLine,
  takeLock,
  unfoundTokens,
  type Run,
  type RunResult,
} from "../../../../../packages/scripts/src/pr-merge/merge"
import "./scratch-config"
import { withGhDown } from "../../../../gh-down"
import { storeWith } from "../../../../scripts/hooks/render-set"
import { PR_TEMPLATE, SKILL_BODY } from "./bodies"
import { greenChecks } from "./suite"

const HEAD = "69a6a4c5e6caf46c4abda6a89de4ce6f3b309e88"
const CANARY = "6f3db1ea4cb7ea4072e0d5454da0026c89635cab"
const TREE = "1bd05088cad7c561f74d8912abe76184760003d9"

const scratch = mkdtempSync(join(tmpdir(), "pr-merge-lock-"))
// The suite's own lock folder: no test may take the factory's real lock.
process.env.PLAYGROUND_MERGE_LOCK_DIR = join(scratch, "default")
// The suite's own held list, missing unless a test writes it: no test reads the factory's real one.
const HELD = join(scratch, "held-prs.json")
process.env.PLAYGROUND_HELD_PRS = HELD
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// The tree git merges a clean canary merge's two parents to, which is that merge's own tree.
const MERGED_TREE = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
// git merge-tree --write-tree --name-only's answer for a head that conflicts with canary, as git 2.56 prints it: the tree line is still there, then each conflicted file, then its messages, and it exits 1.
const CONFLICTED: RunResult = {
  code: 1,
  stderr: "",
  stdout: [
    "cb1b7be5c6c3fdf505305b5b2611c9e30cada77f",
    "AGENTS.md",
    "web/next/x.ts",
    "",
    "Auto-merging AGENTS.md",
    "CONFLICT (content): Merge conflict in AGENTS.md",
    "",
  ].join("\n"),
}
// git in a scratch world: canary is CANARY, the head merges into it as TREE (null: a conflict), and the lock lives in a fresh folder. parents: each commit's parents on the walk back from the head; clean: the merges among them that git re-runs to their own tree; differs: the gate code files this checkout holds apart from canary's.
const local = ({
  answer,
  canary = CANARY,
  clean = [] as string[],
  differs = [] as string[],
  parents = { [HEAD]: ["p0"] } as Record<string, string[]>,
  template = PR_TEMPLATE as string | null,
  tree = TREE as string | null,
}: {
  answer?: RunResult
  canary?: string
  clean?: string[]
  differs?: string[]
  parents?: Record<string, string[]>
  template?: string | null
  tree?: string | null
} = {}) => {
  const lockRoot = mkdtempSync(join(scratch, "lock-"))
  const git: Run = async (args) => {
    if (args[0] === "fetch") return ok("")
    if (args[0] === "diff") return ok(differs.map((file) => `${file}\n`).join(""))
    if (args[0] === "show") {
      return template === null
        ? { code: 128, stderr: "fatal: path not in tree", stdout: "" }
        : ok(template)
    }
    if (args[0] === "merge-base") return ok(`${canary}\n`)
    if (args[0] === "rev-list" && args.includes("--parents")) {
      const sha = args.at(-1) ?? ""
      return ok(`${[sha, ...(parents[sha] ?? [])].join(" ")}\n`)
    }
    if (args[0] === "rev-list") return ok("")
    if (args[0] === "rev-parse" && args.length === 4) {
      const sha = (args[1] ?? "").replace("^1", "")
      return ok(`p1\np2\n${clean.includes(sha) ? MERGED_TREE : "b".repeat(40)}\n`)
    }
    if (args[0] === "rev-parse") return ok(`${canary}\n`)
    if (args[0] === "merge-tree" && args.includes("origin/canary")) {
      return answer ?? (tree ? ok(`${tree}\n`) : CONFLICTED)
    }
    if (args[0] === "merge-tree") return ok(`${MERGED_TREE}\n`)
    return { code: 1, stderr: `unexpected git ${args.join(" ")}`, stdout: "" }
  }
  return { git, lockRoot }
}
// The factory's own repository, factory.repo in scratch-config's store, so its heads need GitGuardian's check.
const REPO = "acme/factory"

const ok = (stdout: string): RunResult => ({ code: 0, stderr: "", stdout })

const comment = (body: string, at: string, author = "acme") =>
  JSON.stringify({ author, body, createdAt: at })

const REVIEWED = comment(
  "## ReviewBot · round 1: 5/5 at 69a6a4c · 0 blocking",
  "2026-10-06T19:00:00Z",
)
const PASSING = REVIEWED

const GUARDIAN = { name: "GitGuardian Security Checks" }
const GUARDIAN_PASSED = { ...GUARDIAN, conclusion: "SUCCESS", status: "COMPLETED" }
const GUARDIAN_RUNNING = { ...GUARDIAN, conclusion: "", status: "IN_PROGRESS" }

// A stubbed gh: each call's arguments are recorded, and the merge's answers come from `merges` in order.
function stub({
  aheadBy = "0",
  author = "acme",
  body = "Closes #112",
  checks = [...greenChecks(), GUARDIAN_PASSED] as object[],
  draft = false,
  ready = ok(""),
  comments = PASSING,
  files = ["AGENTS.md", "packages/scripts/src/ship/cli.ts"],
  labels = [] as string[],
  merges = [ok("")],
  parents = {},
  stateAfter = ["MERGED"],
  title = "feat(PG-112): x",
  viewBody,
}: {
  aheadBy?: string
  author?: string
  body?: string
  checks?: object[]
  comments?: string
  draft?: boolean
  ready?: RunResult
  files?: string[]
  labels?: string[]
  merges?: RunResult[]
  parents?: Record<number, RunResult>
  stateAfter?: string[]
  title?: string
  viewBody?: string
} = {}) {
  const calls: string[][] = []
  let merge = 0
  let view = 0
  const run: Run = async (args) => {
    calls.push(args)
    const joined = args.join(" ")
    if (joined.startsWith("pr view") && joined.endsWith("--json state --jq .state")) {
      return parents[Number(args[2])] ?? { code: 1, stderr: `no PR ${args[2]}`, stdout: "" }
    }
    if (joined.startsWith("pr view") && joined.includes("baseRefName")) {
      return ok(
        JSON.stringify({
          author: { login: author },
          baseRefName: "canary",
          body: viewBody,
          headRefName: "PG-112-x",
          headRefOid: HEAD,
          isDraft: draft,
          labels: labels.map((name) => ({ name })),
          state: "OPEN",
          statusCheckRollup: checks,
          title,
        }),
      )
    }
    if (joined.includes("/files")) return ok(files.map((file) => `${file}\n`).join(""))
    if (joined.includes("/comments")) return ok(comments)
    if (joined.includes("/compare/") && joined.includes("...canary")) return ok(aheadBy)
    if (joined.startsWith("pr comment")) return ok("")
    if (joined.startsWith("pr ready")) return ready
    if (joined.startsWith("pr view") && joined.includes("--json body")) return ok(body)
    if (joined.startsWith("pr merge")) return merges[merge++] ?? ok("")
    if (joined.startsWith("pr view") && joined.includes("mergeCommit")) {
      const state = stateAfter[Math.min(view++, stateAfter.length - 1)] ?? "OPEN"
      return ok(
        JSON.stringify({ mergeCommit: state === "MERGED" ? { oid: "abc1234def" } : null, state }),
      )
    }
    return { code: 1, stderr: `unexpected gh ${joined}`, stdout: "" }
  }
  return { calls, run }
}

const merges = (calls: string[][]) =>
  calls.filter((args) => args[0] === "pr" && args[1] === "merge")

const readies = (calls: string[][]) =>
  calls.filter((args) => args[0] === "pr" && args[1] === "ready")

describe("prMerge", () => {
  test("merges a PR that passed every gate, at exactly its head, and returns the merge SHA", async () => {
    const { calls, run } = stub()
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234def" })
    expect(merges(calls)).toEqual([
      [
        "pr",
        "merge",
        "112",
        "-R",
        REPO,
        "--squash",
        "--body",
        "Closes #112",
        "--match-head-commit",
        HEAD,
      ],
    ])
    expect(calls.find((args) => args.join(" ").includes("/compare/"))?.[1]).toBe(
      `repos/${REPO}/compare/${HEAD}...canary`,
    )
  })

  // GitHub's squash took the PR's commits' Co-authored-by trailers into canary, which AGENTS.md's Commits rule keeps out.
  test("squashes with the PR body less every Co-authored-by line, in any case", async () => {
    const body = [
      "Outcome: a change.",
      "",
      "The hook refuses a Co-authored-by trailer.",
      "Co-authored-by: A <a@b.c>",
      "Co-Authored-By: Claude <noreply@example.com>",
      "co-authored-by: C <c@d.e>",
      "",
      "Closes #112",
    ].join("\n")
    const { calls, run } = stub({ body })
    expect(await prMerge(112, { repo: REPO }, run, local())).toMatchObject({ kind: "merged" })
    const squash = merges(calls)[0] ?? []
    expect(squash.slice(-4)).toEqual([
      "--body",
      "Outcome: a change.\n\nThe hook refuses a Co-authored-by trailer.\n\nCloses #112",
      "--match-head-commit",
      HEAD,
    ])
  })

  test("refuses a PR by an outside author, and merges it only when --outside-author names that author", async () => {
    const refused = stub({ author: "teammate-acme" })
    const outcome = await prMerge(165, { repo: REPO }, refused.run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "author")?.ok).toBe(false)
    expect(merges(refused.calls)).toEqual([])
    const named = stub({ author: "teammate-acme" })
    const options = { outsideAuthor: "teammate-acme", repo: REPO }
    expect(await prMerge(165, options, named.run, local())).toMatchObject({ kind: "merged" })
    const note = named.calls.find((args) => args[0] === "pr" && args[1] === "comment")
    expect(note?.at(-1)).toContain("author: by teammate-acme, named by --outside-author")
  })

  // the merged PR's worker, reviewer and tester end right after the merge, and a refusal ends nobody.
  test("ends the merged PR's sessions by its URL, after the merge comment; a refusal ends none", async () => {
    const ended: string[] = []
    const end = async (url: string, sha: string) => void ended.push(`${url} ${sha}`)
    const merged = stub()
    expect(
      await prMerge(112, { repo: REPO }, merged.run, { ...local(), ended: end }),
    ).toMatchObject({
      kind: "merged",
    })
    expect(ended).toEqual([`https://github.com/${REPO}/pull/112 abc1234def`])
    const refused = stub({ aheadBy: "1" })
    const refusal = await prMerge(112, { repo: REPO }, refused.run, {
      ...local({ tree: null }),
      ended: end,
    })
    expect(refusal.kind).toBe("refused")
    expect(refusal.gates.find((gate) => gate.name === "up to date")?.ok).toBe(false)
    expect(ended).toHaveLength(1)
    const failing = stub()
    const outcome = await prMerge(112, { repo: REPO }, failing.run, {
      ...local(),
      ended: async () => {
        throw new Error("herdr is down")
      },
    })
    expect(outcome).toMatchObject({ kind: "merged" })
  })

  // a fix for a bug live on the factory's own machine, or a feat for an ask the owner waits to see live, waited for the usual ship beat, so a ship-now label tells Ops to ship once it merges.
  test("a ship-now fix's merge and a ship-now feat's naming the owner's ask each send Ops one ship line; an unlabelled merge, a feat naming no owner ask and a refusal send none", async () => {
    const sent: string[] = []
    const shipNow = async (line: string) => void sent.push(line)
    const labelled = stub({ labels: ["bug", "ship-now"], title: "fix(PG-112): x" })
    expect(await prMerge(112, { repo: REPO }, labelled.run, { ...local(), shipNow })).toMatchObject(
      { kind: "merged" },
    )
    expect(sent).toEqual([
      "#112 carries ship-now and merged at abc1234def: ship canary now by the release skill, unless a ship you are already running pinned a canary that holds abc1234def.",
    ])
    const plain = stub({ labels: ["bug"], title: "fix(PG-112): x" })
    expect(await prMerge(112, { repo: REPO }, plain.run, { ...local(), shipNow })).toMatchObject({
      kind: "merged",
    })
    const unasked = stub({ labels: ["ship-now"], title: "feat(PG-112): x" })
    expect(await prMerge(112, { repo: REPO }, unasked.run, { ...local(), shipNow })).toMatchObject({
      kind: "merged",
    })
    expect(sent).toHaveLength(1)
    const asked = stub({
      labels: ["ship-now"],
      title: "feat(PG-112): x",
      viewBody: `${SKILL_BODY.replace("**After:** one.", "**After:** one. `AGENTS.md` checked.")}\n- Owner ask: #i1`,
    })
    expect(await prMerge(112, { repo: REPO }, asked.run, { ...local(), shipNow })).toMatchObject({
      kind: "merged",
    })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toStartWith("#112 carries ship-now and merged at abc1234def: ship canary now")
    const refused = stub({ aheadBy: "1", labels: ["ship-now"], title: "fix(PG-112): x" })
    const refusal = await prMerge(112, { repo: REPO }, refused.run, {
      ...local({ tree: null }),
      shipNow,
    })
    expect(refusal.kind).toBe("refused")
    expect(sent).toHaveLength(2)
    const failing = stub({ labels: ["ship-now"], title: "fix(PG-112): x" })
    const outcome = await prMerge(112, { repo: REPO }, failing.run, {
      ...local(),
      shipNow: async () => {
        throw new Error("notify.sh failed")
      },
    })
    expect(outcome).toMatchObject({ kind: "merged" })
  })

  test("a compare answer that is not a count refuses, never reading as up to date", async () => {
    for (const aheadBy of ["", "null", " "]) {
      const { calls, run } = stub({ aheadBy })
      const outcome = await prMerge(112, { repo: REPO }, run, local())
      expect(outcome.kind).toBe("refused")
      expect(outcome.gates.find((gate) => gate.name === "up to date")?.ok).toBe(false)
      expect(merges(calls)).toEqual([])
    }
  })

  // #2478's shape: a web/next diff at 5/5 with every check green and no tester verdict merged on ready (PG-2485).
  test("refuses a web/next diff at 5/5 with green checks and no tester verdict, and never calls gh pr merge", async () => {
    const { calls, run } = stub({ files: ["web/next/src/components/dashboard/row.tsx"] })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.filter((gate) => !gate.ok).map((gate) => gate.name)).toEqual(["tester"])
    expect(merges(calls)).toEqual([])
    const tested = stub({
      comments: `${PASSING}\n${comment("## TesterBot · PASS at 69a6a4c · both shots attached", "2026-10-06T19:05:00Z")}`,
      files: ["web/next/src/components/dashboard/row.tsx"],
    })
    expect(await prMerge(112, { repo: REPO }, tested.run, local())).toMatchObject({
      kind: "merged",
    })
  })

  // #2500's shape: a hand merge from a checkout without #2497's tester gate passed every gate it had, while the train held the PR on that gate (PG-2525).
  test("a checkout whose gate code differs from canary's refuses on the code gate, naming each file, and never calls gh pr merge", async () => {
    const differs = ["packages/config/src/verdicts.ts", "packages/scripts/src/pr-merge/gates.ts"]
    const { calls, run } = stub()
    const outcome = await prMerge(112, { repo: REPO }, run, local({ differs }))
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.filter((gate) => !gate.ok)).toEqual([
      {
        detail: `this checkout's gate code differs from origin/canary's (${differs.join(", ")}); run pr:merge from a checkout on origin/canary, or let merge-on-ready land it`,
        name: "code",
        ok: false,
      },
    ])
    expect(merges(calls)).toEqual([])
    const explained = await prMerge(112, { explain: true, repo: REPO }, run, local({ differs }))
    expect(explained.gates.find((gate) => gate.name === "code")?.ok).toBe(false)
    expect(merges(calls)).toEqual([])
  })

  test("a checkout holding canary's gate code passes the code gate", async () => {
    const { run } = stub()
    const outcome = await prMerge(112, { explain: true, repo: REPO }, run, local())
    expect(outcome.gates.find((gate) => gate.name === "code")).toEqual({
      detail: "this checkout's gate code is canary's",
      name: "code",
      ok: true,
    })
  })

  // a PR could change a check that judges it, and the same review passed it like any other diff (PG-2576).
  test("a PR deleting a refused-forms row, read from the files call's deletion count, refuses on the checks gate until its 5/5 names the file", async () => {
    const row = "tests/scripts/hooks/fixtures/refused-forms/2522.ts"
    const { calls, run } = stub({ files: ["AGENTS.md", `${row}\t\t2`] })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.filter((gate) => !gate.ok)).toEqual([
      {
        detail: `the PR changes a check that judges it (${row}): its 5/5 at 69a6a4c does not name ${row} in a \`Reviewed check change: <path>\` line`,
        name: "checks",
        ok: false,
      },
    ])
    expect(merges(calls)).toEqual([])
    const explained = await prMerge(112, { explain: true, repo: REPO }, run, local())
    expect(explained.gates.find((gate) => gate.name === "checks")?.ok).toBe(false)
    const named = comment(
      `## ReviewBot · round 1: 5/5 at 69a6a4c · 0 blocking\n\nReviewed check change: \`${row}\``,
      "2026-10-06T19:00:00Z",
    )
    const passed = stub({ comments: named, files: ["AGENTS.md", `${row}\t\t2`] })
    expect((await prMerge(112, { repo: REPO }, passed.run, local())).kind).toBe("merged")
  })

  test("a refused-forms file the PR only adds to, and a renamed file's old path, read as the files call gives them", async () => {
    const added = stub({ files: ["tests/scripts/hooks/fixtures/refused-forms/2522.ts\t\t0"] })
    const outcome = await prMerge(112, { explain: true, repo: REPO }, added.run, local())
    expect(outcome.gates.find((gate) => gate.name === "checks")).toEqual({
      detail: "the PR changes no check that judges it",
      name: "checks",
      ok: true,
    })
    const moved = stub({
      files: ["tests/scripts/hooks/rows.ts\ttests/scripts/hooks/fixtures/refused-forms/2522.ts\t0"],
    })
    const read = await prMerge(112, { explain: true, repo: REPO }, moved.run, local())
    expect(read.gates.find((gate) => gate.name === "checks")?.detail).toContain(
      "(tests/scripts/hooks/fixtures/refused-forms/2522.ts)",
    )
  })

  test("refuses a PR the held list names, saying why, and never calls gh pr merge", async () => {
    writeFileSync(HELD, JSON.stringify({ held: { [`${REPO}#112`]: "held for Merritt's notes" } }))
    try {
      const { calls, run } = stub()
      const outcome = await prMerge(112, { repo: REPO }, run, local())
      expect(outcome.kind).toBe("refused")
      expect(outcome.gates.find((gate) => gate.name === "held")).toMatchObject({
        detail: "held for Merritt's notes",
        ok: false,
      })
      expect(merges(calls)).toEqual([])
    } finally {
      rmSync(HELD, { force: true })
    }
  })

  test('a floor-wide "*" hold refuses a PR the list does not name, giving its reason, and never calls gh pr merge', async () => {
    writeFileSync(HELD, JSON.stringify({ held: { "*": "merges held until v0.0.35 ships" } }))
    try {
      const { calls, run } = stub()
      const outcome = await prMerge(112, { repo: REPO }, run, local())
      expect(outcome.kind).toBe("refused")
      expect(outcome.gates.find((gate) => gate.name === "held")).toMatchObject({
        detail: "merges held until v0.0.35 ships",
        ok: false,
      })
      expect(merges(calls)).toEqual([])
    } finally {
      rmSync(HELD, { force: true })
    }
  })

  test("refuses, and never calls gh pr merge, when canary is ahead and the head conflicts with it", async () => {
    const { calls, run } = stub({ aheadBy: "1" })
    const outcome = await prMerge(112, { repo: REPO }, run, local({ tree: null }))
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "up to date")?.ok).toBe(false)
    expect(merges(calls)).toEqual([])
  })

  // git here reads the head as holding canary, so the types gate skips; types.test.ts runs it on a real merged tree
  test("a head behind canary that merges clean merges on its own checks, with no new GitHub run", async () => {
    const { calls, run } = stub({ aheadBy: "3" })
    expect(await prMerge(112, { repo: REPO }, run, local())).toMatchObject({ kind: "merged" })
    expect(merges(calls)).toHaveLength(1)
  })

  test("refuses a review from anyone but the repo's owner", async () => {
    const comments = comment(
      "## ReviewBot · round 1: 5/5 at 69a6a4c · 0 blocking",
      "2026-10-06T19:00:00Z",
      "mallory",
    )
    const { calls, run } = stub({ comments })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.filter((gate) => !gate.ok).map((gate) => gate.name)).toEqual(["review"])
    expect(merges(calls)).toEqual([])
  })

  test("--explain judges every gate and merges nothing", async () => {
    const { calls, run } = stub()
    const outcome = await prMerge(112, { explain: true, repo: REPO }, run, local())
    expect(outcome.kind).toBe("explained")
    expect(outcome.gates.every((gate) => gate.ok)).toBe(true)
    expect(merges(calls)).toEqual([])
  })

  test("a GitHub 5xx is tried once more at the same head", async () => {
    const bad: RunResult = {
      code: 1,
      stderr: "non-200 OK status code: 502 Bad Gateway",
      stdout: "",
    }
    const { calls, run } = stub({ merges: [bad, ok("")], stateAfter: ["OPEN", "MERGED"] })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234def" })
    expect(merges(calls)).toHaveLength(2)
    expect(merges(calls).every((args) => args.includes(HEAD))).toBe(true)
    expect(merges(calls)[1]).toEqual(merges(calls)[0])
  })

  test("a 5xx after which the PR reads merged is a merge, with no second try", async () => {
    const bad: RunResult = { code: 1, stderr: "HTTP 502", stdout: "" }
    const { calls, run } = stub({ merges: [bad], stateAfter: ["MERGED"] })
    expect(await prMerge(112, { repo: REPO }, run, local())).toMatchObject({ kind: "merged" })
    expect(merges(calls)).toHaveLength(1)
  })

  test("a second 5xx, or any other failure, stops with gh's reason", async () => {
    const bad: RunResult = { code: 1, stderr: "502 Bad Gateway", stdout: "" }
    const twice = stub({ merges: [bad, bad], stateAfter: ["OPEN"] })
    expect(await prMerge(112, { repo: REPO }, twice.run, local())).toMatchObject({ kind: "failed" })
    expect(merges(twice.calls)).toHaveLength(2)
    const moved: RunResult = { code: 1, stderr: "Head branch was modified", stdout: "" }
    const once = stub({ merges: [moved], stateAfter: ["OPEN"] })
    const outcome = await prMerge(112, { repo: REPO }, once.run, local())
    expect(outcome).toMatchObject({ kind: "failed" })
    expect(outcome.kind === "failed" && outcome.reason).toContain("Head branch was modified")
    expect(merges(once.calls)).toHaveLength(1)
  })
})

describe("a hold written after the gates are read", () => {
  // git in local()'s world whose types gate, the slow step between the gates and the merge call, writes the held list as it starts
  const holdingDuringTypes = (text: string) => {
    const world = local()
    const git: Run = async (args) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") writeFileSync(HELD, text)
      return world.git(args)
    }
    return { ...world, git }
  }
  afterEach(() => rmSync(HELD, { force: true }))

  test("refuses, naming the hold's reason, and never calls gh pr merge", async () => {
    const { calls, run } = stub()
    const outcome = await prMerge(
      112,
      { repo: REPO },
      run,
      holdingDuringTypes(JSON.stringify({ held: { [`${REPO}#112`]: "held for the ship" } })),
    )
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "held")).toMatchObject({
      detail: "read again before the merge: held for the ship",
      ok: false,
    })
    expect(merges(calls)).toEqual([])
  })

  test("refuses when the held list no longer reads, and never calls gh pr merge", async () => {
    const { calls, run } = stub()
    const outcome = await prMerge(112, { repo: REPO }, run, holdingDuringTypes("{"))
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "held")).toMatchObject({
      detail: "read again before the merge: held-prs.json does not read: it is not JSON",
      ok: false,
    })
    expect(merges(calls)).toEqual([])
  })

  test('a floor-wide "*" hold written during the type check refuses at the re-read and never calls gh pr merge', async () => {
    const { calls, run } = stub()
    const outcome = await prMerge(
      112,
      { repo: REPO },
      run,
      holdingDuringTypes(JSON.stringify({ held: { "*": "merges held until v0.0.35 ships" } })),
    )
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "held")).toMatchObject({
      detail: "read again before the merge: merges held until v0.0.35 ships",
      ok: false,
    })
    expect(merges(calls)).toEqual([])
  })

  test('with "*" removed, the PR merges as before', async () => {
    writeFileSync(HELD, JSON.stringify({ held: { "*": "merges held until v0.0.35 ships" } }))
    const held = stub()
    expect((await prMerge(112, { repo: REPO }, held.run, local())).kind).toBe("refused")
    expect(merges(held.calls)).toEqual([])
    writeFileSync(HELD, JSON.stringify({ held: {} }))
    const { calls, run } = stub()
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234def" })
    expect(merges(calls)).toHaveLength(1)
  })

  // the ship flow's freeze (bun run ship:freeze) writes "*" with its time, and a ship that stopped without its --end leaves it to lapse
  test("a ship's fresh \"*\" line refuses a PR at 5/5 with green checks, one past its lapse merges, and a PR's own line as old still refuses", async () => {
    const line = "v0.0.38 ships: canary is frozen until its tag lands"
    const since = (ago: number) => new Date(Date.now() - ago).toISOString()
    try {
      writeFileSync(HELD, JSON.stringify({ held: { "*": line }, since: { "*": since(60_000) } }))
      const fresh = stub()
      const outcome = await prMerge(112, { repo: REPO }, fresh.run, local())
      expect(outcome.kind).toBe("refused")
      expect(outcome.gates.filter((gate) => !gate.ok).map((gate) => gate.name)).toEqual(["held"])
      expect(merges(fresh.calls)).toEqual([])
      const old = since(FREEZE_LAPSE_MS + 60_000)
      writeFileSync(
        HELD,
        JSON.stringify({ held: { "*": line, [`${REPO}#113`]: "own" }, since: { "*": old } }),
      )
      const lapsed = stub()
      expect(await prMerge(112, { repo: REPO }, lapsed.run, local())).toMatchObject({
        kind: "merged",
      })
      const own = stub()
      const refused = await prMerge(113, { repo: REPO }, own.run, local())
      expect(refused.gates.find((gate) => gate.name === "held")).toMatchObject({
        detail: "own",
        ok: false,
      })
      expect(merges(own.calls)).toEqual([])
    } finally {
      rmSync(HELD, { force: true })
    }
  })

  test("merges as before when the list still does not name the PR at the merge call", async () => {
    const { calls, run } = stub()
    const outcome = await prMerge(
      112,
      { repo: REPO },
      run,
      holdingDuringTypes(JSON.stringify({ held: { [`${REPO}#113`]: "held for the ship" } })),
    )
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234def" })
    expect(outcome.gates.find((gate) => gate.name === "held")).toMatchObject({
      detail: "not in held-prs.json",
      ok: true,
    })
    expect(merges(calls)).toHaveLength(1)
  })
})

// merge-on-ready skips drafts, so a green draft sat for 30 minutes while another PR merged ahead of it and made it conflict.
describe("a green draft", () => {
  test("pr:merge marks the owner's draft ready when every other gate passes, then merges it", async () => {
    const { calls, run } = stub({ draft: true })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234def" })
    expect(readies(calls)).toEqual([["pr", "ready", "112", "-R", REPO]])
    const order = calls.map((args) => `${args[0]} ${args[1]}`)
    expect(order.indexOf("pr ready")).toBeLessThan(order.indexOf("pr merge"))
    const note = calls.find((args) => args[0] === "pr" && args[1] === "comment")?.at(-1) ?? ""
    expect(note).toContain("ready: a draft whose every other gate passes; marked ready")
  })

  test("a draft missing any other gate stays a draft and is refused", async () => {
    const comments = comment(
      "## ReviewBot · round 1: 4/5 at 69a6a4c · 1 blocking",
      "2026-10-06T19:00:00Z",
    )
    for (const missing of [stub({ comments, draft: true }), stub({ aheadBy: "", draft: true })]) {
      const outcome = await prMerge(112, { repo: REPO }, missing.run, local())
      expect(outcome.kind).toBe("refused")
      expect(outcome.gates.find((gate) => gate.name === "ready")?.ok).toBe(false)
      expect(readies(missing.calls)).toEqual([])
      expect(merges(missing.calls)).toEqual([])
    }
  })

  test("an outside author's draft is never marked ready, even with --outside-author", async () => {
    const { calls, run } = stub({ author: "teammate-acme", draft: true })
    const options = { outsideAuthor: "teammate-acme", repo: REPO }
    const outcome = await prMerge(165, options, run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "ready")?.ok).toBe(false)
    expect(readies(calls)).toEqual([])
    expect(merges(calls)).toEqual([])
  })

  test("--explain names the draft it would mark ready, and marks nothing", async () => {
    const { calls, run } = stub({ draft: true })
    const outcome = await prMerge(112, { explain: true, repo: REPO }, run, local())
    expect(outcome.kind).toBe("explained")
    expect(outcome.gates.find((gate) => gate.name === "ready")).toMatchObject({
      detail: "a draft whose every other gate passes; pr:merge marks it ready before it merges",
      ok: true,
    })
    expect(readies(calls)).toEqual([])
  })

  test("a draft GitHub will not mark ready is not merged", async () => {
    const { calls, run } = stub({ draft: true, ready: { code: 1, stderr: "HTTP 502", stdout: "" } })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome).toMatchObject({ kind: "failed", reason: "gh pr ready exited 1: HTTP 502" })
    expect(merges(calls)).toEqual([])
  })
})

// dispatcher: a lead judged a merge clean from merge-tree's tree line and missed its exit code, so --explain says it in words.
describe("--explain's merge with canary", () => {
  test("a head that merges clean names canary and the tree", async () => {
    const { run } = stub({ aheadBy: "1" })
    const outcome = await prMerge(112, { explain: true, repo: REPO }, run, local())
    expect(outcome).toMatchObject({
      kind: "explained",
      merge: "#112 at 69a6a4c merges clean with canary 6f3db1e as tree 1bd0508",
    })
  })

  test("a conflicting head names its files, though merge-tree still prints a tree", async () => {
    const { run } = stub({ aheadBy: "1" })
    const outcome = await prMerge(112, { explain: true, repo: REPO }, run, local({ tree: null }))
    expect(outcome).toMatchObject({
      kind: "explained",
      merge: "#112 at 69a6a4c conflicts with canary 6f3db1e in AGENTS.md, web/next/x.ts",
    })
  })

  test("an answer that does not read is never called clean", async () => {
    for (const answer of [
      { code: 128, stderr: "fatal", stdout: "" },
      { code: 1, stderr: "", stdout: "abc\nCONFLICT" },
      { code: 0, stderr: "", stdout: "not a tree\n" },
    ]) {
      const { run } = stub({ aheadBy: "1" })
      const outcome = await prMerge(112, { explain: true, repo: REPO }, run, local({ answer }))
      expect(outcome).toMatchObject({
        kind: "explained",
        merge: "#112 at 69a6a4c: its merge with canary 6f3db1e could not be read",
      })
    }
  })
})

describe("the merge lock", () => {
  test("the suite's lock folder is never the factory's real one", () => {
    expect(lockRootOf()).toBe(join(scratch, "default"))
    expect(lockRootOf()).not.toBe(realLockRoot())
    expect(lockRootOf().startsWith(join(homedir(), ".claude"))).toBe(false)
  })

  test("a lock another merge holds refuses, naming that PR, and is left alone", async () => {
    const at = local()
    mkdirSync(join(at.lockRoot, "merge.lock"))
    writeFileSync(join(at.lockRoot, "merge.lock", "pr"), "140\n")
    const { calls, run } = stub()
    const outcome = await prMerge(112, { repo: REPO }, run, at)
    expect(outcome).toMatchObject({ holder: "140", kind: "locked" })
    expect(merges(calls)).toEqual([])
    expect(existsSync(join(at.lockRoot, "merge.lock", "pr"))).toBe(true)
  })

  test("a refusal still lets the lock go, into merge-locks/", async () => {
    const at = local()
    const { run } = stub({ aheadBy: "" })
    expect((await prMerge(112, { repo: REPO }, run, at)).kind).toBe("refused")
    expect(existsSync(join(at.lockRoot, "merge.lock"))).toBe(false)
    expect(readdirSync(join(at.lockRoot, "merge-locks"))).toEqual([
      expect.stringMatching(/^112-\d+-[0-9a-f]{8}$/),
    ])
  })

  test("a pr template the head cannot show, or one with no placeholder, stops the run with why, so the body gate fails closed", async () => {
    await expect(
      prMerge(112, { repo: REPO }, stub().run, local({ template: null })),
    ).rejects.toThrow("the body gate cannot read the pr template's placeholders")
    await expect(
      prMerge(112, { repo: REPO }, stub().run, local({ template: "no fence here\n" })),
    ).rejects.toThrow("its first markdown fence holds none")
  })

  // origin as GitHub left #2367 at 15:00Z: no refs/pull/<n>/head yet, and the PR's branch at tip
  const noPullRef = (tip: string) => {
    const at = local()
    const fetches: string[][] = []
    const git: Run = async (args) => {
      if (args[0] === "fetch") fetches.push(args)
      if (args[0] === "fetch" && args.includes("refs/pull/112/head"))
        return {
          code: 128,
          stderr: "fatal: couldn't find remote ref refs/pull/112/head\n",
          stdout: "",
        }
      if (args[0] === "rev-parse" && args[1] === "FETCH_HEAD") return ok(`${tip}\n`)
      return at.git(args)
    }
    return { fetches, local: { ...at, git } }
  }

  test("fetches the PR's branch when GitHub has not made its pull ref yet, and merges at that head (#2389)", async () => {
    const world = noPullRef(HEAD)
    const outcome = await prMerge(112, { repo: REPO }, stub().run, world.local)
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234def" })
    expect(world.fetches).toContainEqual(["fetch", "--quiet", "origin", "refs/heads/PG-112-x"])
  })

  test("refuses a branch whose tip is not the PR's head, so the gates never judge another commit (#2389)", async () => {
    const world = noPullRef("b".repeat(40))
    await expect(prMerge(112, { repo: REPO }, stub().run, world.local)).rejects.toThrow(
      "refs/pull/112/head is missing, and its branch PG-112-x is at bbbbbbb, not the head 69a6a4c",
    )
  })

  test("outside the CLI, a run without a git stub throws before it fetches or locks, whatever NODE_ENV says", async () => {
    const { calls, run } = stub()
    await expect(prMerge(112, { repo: REPO }, run, { lockRoot: local().lockRoot })).rejects.toThrow(
      "needs a git stub",
    )
    expect(calls).toEqual([])
  })

  test("two releases in the same second each land, so the lock is never left held", async () => {
    const at = local()
    for (let i = 0; i < 2; i++) {
      const { run } = stub({ aheadBy: "" })
      expect((await prMerge(112, { repo: REPO }, run, at)).kind).toBe("refused")
      expect(existsSync(join(at.lockRoot, "merge.lock"))).toBe(false)
    }
    expect(readdirSync(join(at.lockRoot, "merge-locks"))).toHaveLength(2)
  })

  test("a merge holds the lock while it merges and posts its comment after letting it go", async () => {
    const at = local()
    const seen: { args: string; locked: boolean }[] = []
    const { run } = stub()
    const watched: Run = async (args) => {
      seen.push({
        args: args.slice(0, 2).join(" "),
        locked: existsSync(join(at.lockRoot, "merge.lock")),
      })
      return run(args)
    }
    expect(await prMerge(112, { repo: REPO }, watched, at)).toMatchObject({ kind: "merged" })
    expect(seen.find((s) => s.args === "pr merge")?.locked).toBe(true)
    expect(seen.find((s) => s.args === "pr comment")?.locked).toBe(false)
  })

  test("a lock that no longer names this PR is not moved", async () => {
    const at = local()
    const { run } = stub()
    const swapping: Run = async (args) => {
      if (args[0] === "pr" && args[1] === "merge")
        writeFileSync(join(at.lockRoot, "merge.lock", "pr"), "150\n")
      return run(args)
    }
    await prMerge(112, { repo: REPO }, swapping, at)
    expect(existsSync(join(at.lockRoot, "merge.lock", "pr"))).toBe(true)
  })

  test("--explain takes no lock", async () => {
    const at = local()
    mkdirSync(join(at.lockRoot, "merge.lock"))
    writeFileSync(join(at.lockRoot, "merge.lock", "pr"), "140\n")
    const { run } = stub()
    expect((await prMerge(112, { explain: true, repo: REPO }, run, at)).kind).toBe("explained")
  })
})

// #i516: the lock's holder kept in Redis with a time to live, the lock folder its fallback. A Redis holder makes the folder too, marked with its key's value and its pid, so a taker that cannot reach Redis always finds it.
describe("the merge lock in Redis", () => {
  // Redis as the lock needs it, in memory: a key lapses at its time, and `down` makes every call fail as an unreachable server does.
  const fakeRedis = () => {
    const keys = new Map<string, { until: number; value: string }>()
    let down = false
    const live = (key: string) => {
      const entry = keys.get(key)
      if (entry && entry.until <= Date.now()) keys.delete(key)
      return keys.get(key)
    }
    const reach = () => {
      if (down) throw Object.assign(new Error("connection refused"), { name: "RedisUnreachable" })
    }
    const store: LockStore = {
      close: () => {},
      free: async (key, value) => {
        reach()
        if (live(key)?.value !== value) return false
        return keys.delete(key)
      },
      renew: async (key, value, ttlMs) => {
        reach()
        const entry = live(key)
        if (entry?.value !== value) return false
        entry.until = Date.now() + ttlMs
        return true
      },
      take: async (key, holder, ttlMs) => {
        reach()
        const entry = live(key)
        if (entry) return { holder: entry.value.slice(entry.value.indexOf(" ") + 1) }
        const value = `${crypto.randomUUID()} ${holder}`
        keys.set(key, { until: Date.now() + ttlMs, value })
        return { value }
      },
    }
    return { keys, setDown: (to: boolean) => (down = to), store }
  }
  const root = () => mkdtempSync(join(scratch, "redis-lock-"))
  const held = (lock: Awaited<ReturnType<typeof takeLock>>) => "release" in lock
  const deadPid = () => 4_194_305

  test("a holder that crashed lets its key lapse, and the next taker gets the lock", async () => {
    const at = root()
    const redis = fakeRedis()
    mkdirSync(join(at, "merge.lock"))
    writeFileSync(join(at, "merge.lock", "pr"), "140\n")
    writeFileSync(join(at, "merge.lock", "redis"), `lapsed-token 140\n${deadPid()}\n`)
    const lock = await takeLock(at, 112, { store: redis.store })
    expect(held(lock)).toBe(true)
    expect(readFileSync(join(at, "merge.lock", "pr"), "utf8")).toBe("112\n")
    if ("release" in lock) await lock.release()
  })

  test("two takers through Redis never both hold it", async () => {
    const at = root()
    const redis = fakeRedis()
    const first = await takeLock(at, 112, { store: redis.store })
    const second = await takeLock(at, 150, { store: redis.store })
    expect(held(first)).toBe(true)
    expect(second).toEqual({ holder: "112" })
    if ("release" in first) await first.release()
  })

  test("two takers that judge one crashed holder's folder stale at once: one holds it", async () => {
    const at = root()
    mkdirSync(join(at, "merge.lock"))
    writeFileSync(join(at, "merge.lock", "pr"), "140\n")
    writeFileSync(join(at, "merge.lock", "redis"), `lapsed-token 140\n${deadPid()}\n`)
    let n = 0
    const store: LockStore = {
      close: () => {},
      free: async () => true,
      renew: async () => true,
      take: async (_key, holder) => ({ value: `token${n++} ${holder}` }),
    }
    const both = await Promise.all([takeLock(at, 112, { store }), takeLock(at, 150, { store })])
    expect(both.filter(held)).toHaveLength(1)
  })

  test("a taker that cannot reach Redis while another holds the key is refused, never holding the folder beside it", async () => {
    const at = root()
    const redis = fakeRedis()
    const first = await takeLock(at, 112, { store: redis.store })
    redis.setDown(true)
    expect(await takeLock(at, 150, { store: redis.store })).toEqual({ holder: "112" })
    redis.setDown(false)
    if ("release" in first) await first.release()
  })

  test("a folder holder (Redis was down) refuses a taker that reaches Redis, which leaves no key behind", async () => {
    const at = root()
    const redis = fakeRedis()
    redis.setDown(true)
    const first = await takeLock(at, 112, { store: redis.store })
    redis.setDown(false)
    expect(await takeLock(at, 150, { store: redis.store })).toEqual({ holder: "112" })
    expect(redis.keys.size).toBe(0)
    if ("release" in first) await first.release()
  })

  test("Redis down falls back to the lock folder, released into merge-locks/ as before", async () => {
    const at = root()
    const redis = fakeRedis()
    redis.setDown(true)
    const lock = await takeLock(at, 112, { store: redis.store })
    expect(existsSync(join(at, "merge.lock", "redis"))).toBe(false)
    if ("release" in lock) await lock.release()
    expect(existsSync(join(at, "merge.lock"))).toBe(false)
    expect(readdirSync(join(at, "merge-locks"))).toHaveLength(1)
  })

  test("a holder still alive whose key lapsed (it could not renew) still refuses the next taker", async () => {
    const at = root()
    const redis = fakeRedis()
    const first = await takeLock(at, 112, { store: redis.store })
    redis.keys.clear()
    expect(await takeLock(at, 150, { store: redis.store })).toEqual({ holder: "112" })
    if ("release" in first) await first.release()
  })

  test("a holder renews its key while it holds the lock, and its release frees the key and moves the folder aside", async () => {
    const at = root()
    const redis = fakeRedis()
    const lock = await takeLock(at, 112, { store: redis.store, ttlMs: 600 })
    await Bun.sleep(1500)
    expect(redis.keys.size).toBe(1)
    if ("release" in lock) await lock.release()
    expect(redis.keys.size).toBe(0)
    expect(existsSync(join(at, "merge.lock"))).toBe(false)
  })
})

// a feat for an ask the owner waits to see live rightly carried ship-now, so a ship takes a fix( title or a Links line naming the owner's ask (PG-2469).
describe("shipNowLine", () => {
  const links = (...lines: string[]) =>
    `## TL;DR\n\nIt ships.\n\n## Links\n\n- Closes #2469\n${lines.join("\n")}`
  const SHIP =
    "#7 carries ship-now and merged at abc1234: ship canary now by the release skill, unless a ship you are already running pinned a canary that holds abc1234."

  test.each([
    ["a fix( title", "fix(PG-7): x", links()],
    ["a feat naming an Inbox id", "feat(PG-7): x", links("- Owner ask: #i162")],
    ["a feat naming a PG issue", "feat(PG-7): x", links("- **Owner ask:** PG-2437")],
    ["a feat quoting the owner", "feat(PG-7): x", links('- Owner ask: "show it live tonight"')],
    [
      "a feat quoting the owner in curly quotes",
      "feat(PG-7): x",
      links("Owner ask: “show it live”"),
    ],
  ])("%s ships", (_, title, body) => {
    expect(shipNowLine(7, "abc1234", { body, title })).toEqual({ line: SHIP, ship: true })
  })

  test.each([
    ["a feat whose Links names none", "feat(PG-7): x", links()],
    ["a feat with no body", "feat(PG-7): x", undefined],
    ["an Owner ask: line outside Links", "feat(PG-7): x", `Owner ask: #i162\n\n${links()}`],
    ["an Owner ask: line naming nothing", "feat(PG-7): x", links("- Owner ask: soon")],
    ["a title that only opens with fix", "fixture(PG-7): x", links()],
  ])("%s answers with the rule's line and no ship", (_, title, body) => {
    const answer = shipNowLine(7, "abc1234", { body, title })
    expect(answer.ship).toBe(false)
    expect(answer.line).toContain("extensions/core/rules/release.md")
    expect(answer.line).toContain("Owner ask:")
  })
})

test("isServerError knows GitHub's 5xx answers and nothing else", () => {
  expect(isServerError("non-200 OK status code: 502 Bad Gateway")).toBe(true)
  expect(isServerError("HTTP 503: Service Unavailable")).toBe(true)
  expect(isServerError("GraphQL: Pull Request is not mergeable")).toBe(false)
  expect(isServerError("acme/factory#512 is not mergeable")).toBe(false)
})

describe("a head with no finished GitGuardian check", () => {
  test("GitGuardian's check is needed on factory.repo alone, the checkout's origin while unset, and with neither the gate refuses", async () => {
    const none = { PLAYGROUND_DATA_DIR: join(scratch, "no-store") }
    // checkouts of this test's own, so the box's CI worktree, which has no GitHub origin, reads the same as a Mac's
    const checkout = (origin?: string) => {
      const dir = mkdtempSync(join(scratch, "checkout-"))
      Bun.spawnSync(["git", "init", "-q", dir])
      if (origin) Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", origin])
      return dir
    }
    const origin = checkout("git@github.com:Acme/Factory-Origin.git")
    expect((await gateOptions("acme/factory-origin", {}, none, origin)).gitGuardian).toBe(true)
    expect((await gateOptions("acme/other", {}, none, origin)).gitGuardian).toBe(false)
    await expect(gateOptions("acme/other", {}, none, checkout())).rejects.toThrow(
      "factory.repo is unset",
    )
    const set = {
      PLAYGROUND_DATA_DIR: storeWith(
        join(scratch, "factory-repo"),
        {},
        { "factory.repo": "Acme/Other" },
      ),
    }
    expect((await gateOptions("acme/other", {}, set)).gitGuardian).toBe(true)
    expect((await gateOptions(REPO, {}, set)).gitGuardian).toBe(false)
  })

  test("refuses on dispatcher with GitGuardian absent or still running", async () => {
    for (const checks of [greenChecks(), [...greenChecks(), GUARDIAN_RUNNING]]) {
      const { calls, run } = stub({ checks })
      const outcome = await prMerge(112, { repo: REPO }, run, local())
      expect(outcome.kind).toBe("refused")
      expect(outcome.gates.filter((g) => !g.ok).map((g) => g.name)).toEqual(["ci"])
      expect(merges(calls)).toEqual([])
    }
    const { run } = stub({ checks: greenChecks() })
    const refused = await prMerge(112, { repo: REPO }, run, local())
    expect(refused.gates.find((g) => g.name === "ci")?.detail).toContain("no GitGuardian check")
  })

  test("a repo GitGuardian does not scan needs no check", async () => {
    const { run } = stub({ checks: greenChecks() })
    const outcome = await prMerge(112, { repo: "acme/other" }, run, local())
    expect(outcome).toMatchObject({ kind: "merged" })
  })
})

describe("a stacked PR (PG-1274)", () => {
  const stacked = `${SKILL_BODY.replace("**After:** one.", "**After:** one. `AGENTS.md` checked.")}\n- Stacked on #12`

  test("pr:merge refuses while its parent is open, naming the parent, and never calls gh pr merge", async () => {
    const { calls, run } = stub({ parents: { 12: ok("OPEN") }, viewBody: stacked })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "parent")).toMatchObject({ ok: false })
    expect(outcome.gates.find((gate) => gate.name === "parent")?.detail).toContain("#12")
    expect(merges(calls)).toEqual([])
  })

  test("a parent whose state gh cannot read refuses too", async () => {
    const { calls, run } = stub({ viewBody: stacked })
    const outcome = await prMerge(112, { repo: REPO }, run, local())
    expect(outcome.kind).toBe("refused")
    expect(outcome.gates.find((gate) => gate.name === "parent")?.ok).toBe(false)
    expect(merges(calls)).toEqual([])
  })

  test("a merged parent, or none declared, merges as today", async () => {
    const parented = stub({ parents: { 12: ok("MERGED") }, viewBody: stacked })
    expect(await prMerge(112, { repo: REPO }, parented.run, local())).toMatchObject({
      kind: "merged",
    })
    const plain = stub({ viewBody: stacked.replace("\n- Stacked on #12", "") })
    expect(await prMerge(112, { repo: REPO }, plain.run, local())).toMatchObject({
      kind: "merged",
    })
    expect(plain.calls.some((args) => args.join(" ").endsWith("--json state --jq .state"))).toBe(
      false,
    )
  })
})

describe("the body gate's token grep at the head", () => {
  test("names the tokens no file at the head holds, and throws when git grep cannot run", async () => {
    const repo = mkdtempSync(join(scratch, "grep-"))
    const inRepo = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args])
    inRepo("init", "-q")
    writeFileSync(join(repo, "clock.ts"), "export const CLOCK_EXEMPT = []\n")
    inRepo("add", "clock.ts")
    inRepo("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "a")
    const git: Run = async (args) => {
      const proc = Bun.spawnSync(["git", "-C", repo, ...args])
      return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
    }
    expect(await unfoundTokens(git, "HEAD", ["CLOCK_EXEMPT", "SUITE_LINE"])).toEqual(["SUITE_LINE"])
    expect(await unfoundTokens(git, "HEAD", [])).toEqual([])
    await expect(unfoundTokens(git, "no-such-ref", ["SUITE_LINE"])).rejects.toThrow(
      "git grep exited",
    )
  })

  test("at this repo's own head, the gate's sample tokens stay unfound, since the grep leaves out the gate's own folders", async () => {
    const root = join(import.meta.dir, "..", "..", "..", "..", "..")
    const git: Run = async (args) => {
      const proc = Bun.spawnSync(["git", "-C", root, ...args])
      return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
    }
    expect(await unfoundTokens(git, "HEAD", ["CLOCK_EXEMPT", "SKILLS_LINE", "SUITE_LINE"])).toEqual(
      ["SKILLS_LINE", "SUITE_LINE"],
    )
  })
})

// the train's every gh call goes through runGh, so a broken gh is never flooded
test("runGh skips gh while the gh-auth beat's fresh result reads failed", async () => {
  expect(await withGhDown(() => runGh(["pr", "list"]))).toEqual({
    code: 1,
    stderr: "gh unreachable: gh token invalid",
    stdout: "",
  })
})

describe("the code gate's diff, in a real scratch checkout", () => {
  const repo = mkdtempSync(join(tmpdir(), "pr-merge-code-"))
  afterAll(() => rmSync(repo, { force: true, recursive: true }))
  const git: Run = async (args) => {
    const proc = Bun.spawnSync(["git", "-C", repo, ...args])
    return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
  }
  const at = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const GATES = "packages/scripts/src/pr-merge/gates.ts"
  const PATHS = "packages/scripts/src/new-user-gate/paths.ts"
  write(GATES, "export const gates = ['review']\n")
  write(PATHS, "export const NEW_USER_PATHS = ['install.sh']\n")
  write("README.md", "a\n")
  at("init", "-q", "-b", "canary")
  at("add", ".")
  at("commit", "-q", "-m", "behind")
  const behind = at("rev-parse", "HEAD").stdout.toString().trim()
  write(GATES, "export const gates = ['review', 'tester']\n")
  at("commit", "-q", "-am", "the tester gate")
  const canary = at("rev-parse", "HEAD").stdout.toString().trim()

  test("a checkout behind canary's added gate names its gate file, so pr:merge refuses there (PG-2525)", async () => {
    at("checkout", "-q", behind)
    expect(await gateCodeOf(git, canary)).toEqual([GATES])
    at("checkout", "-q", canary)
  })

  test("a checkout at canary names none, and a change outside the gate code names none", async () => {
    expect(await gateCodeOf(git, canary)).toEqual([])
    write("README.md", "b\n")
    expect(await gateCodeOf(git, canary)).toEqual([])
    at("checkout", "-q", "--", "README.md")
  })

  test("an edit to the new-user gate's path list counts, since the gate reads which diffs it holds from it (PG-2496)", async () => {
    write(PATHS, "export const NEW_USER_PATHS = []\n")
    expect(await gateCodeOf(git, canary)).toEqual([PATHS])
    at("checkout", "-q", "--", PATHS)
  })

  test("an uncommitted edit to the gate code counts, as a commit does", async () => {
    write(GATES, "export const gates = []\n")
    expect(await gateCodeOf(git, canary)).toEqual([GATES])
    at("checkout", "-q", "--", GATES)
  })

  test("a PR branch that changes pr-merge itself shows the code gate's ✗ from its own worktree, so its verdict is read from a checkout on origin/canary", async () => {
    at("checkout", "-q", "-b", "PG-1-gate")
    write("packages/scripts/src/pr-merge/new-gate.ts", "export {}\n")
    at("add", ".")
    at("commit", "-q", "-m", "a new gate")
    const differs = await gateCodeOf(git, canary)
    expect(differs).toEqual(["packages/scripts/src/pr-merge/new-gate.ts"])
    expect(codeGate(differs).ok).toBe(false)
    at("checkout", "-q", "canary")
  })

  test("a diff that cannot run throws, so the gate fails closed", async () => {
    await expect(gateCodeOf(git, "0".repeat(40))).rejects.toThrow(
      /git diff of the gate code exited/,
    )
  })
})
