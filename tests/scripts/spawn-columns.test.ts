import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"

import { KINDS } from "../../packages/settings/src/settings"
import { OLD } from "../session-names"
import { bin, launchAfterRm, placing, root, scratch, script, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("under the gates it spawns", () => {
  test(`${OLD.dispatcher}'s successor is briefed by its lead and reports to no one`, async () => {
    const r = await spawn(["column", "dispatcher", OLD.dispatcher, OLD.ops, "w1:p2", "h.md"], [])
    expect(r.code).toBe(0)
    const command = launchAfterRm(r)
    expect(command).toContain(
      `You are ${OLD.dispatcher}, the Playground factory's dispatcher; ${OLD.ops} briefs you`,
    )
    expect(command).not.toContain("Report to")
    expect(r.roster).toEqual(["set", OLD.dispatcher, "kind=dispatcher", "task=h.md", "memory=on"])
  })

  test("a manager's column names it once: a lead reports to the dispatcher", async () => {
    const r = await spawn(["column", OLD.ops, "w1:p2", "h.md"], [], { BRIEF_FILE: "h.md" })
    expect(r.code).toBe(0)
    const command = launchAfterRm(r)
    expect(command).toContain(`env PLAYGROUND_ROLE=lead claude -n ${OLD.ops}`)
    expect(command).toContain(
      `You are ${OLD.ops}, a lead in the Playground factory; you report to dispatcher`,
    )
    expect(r.roster?.slice(0, 3)).toEqual(["set", OLD.ops, "kind=ops"])
  })

  test("a fresh install's managers start under sessions.names' role words", async () => {
    const r = await spawn(["column", "ops", "w1:p2", "h.md"], [], {
      BRIEF_FILE: "h.md",
      NO_ALIASES: "1",
    })
    expect(r.code).toBe(0)
    const command = launchAfterRm(r)
    expect(command).toContain("env PLAYGROUND_ROLE=lead claude -n ops")
    expect(command).toContain(`You are ops, a lead in the Playground factory; you report to `)
    expect(r.roster?.slice(0, 3)).toEqual(["set", "ops", "kind=ops"])
  })

  test(`a fresh install reads no old name, so ${OLD.ops} is no manager there`, async () => {
    const r = await spawn(["column", OLD.ops, "w1:p2", "h.md"], [], {
      BRIEF_FILE: "h.md",
      NO_ALIASES: "1",
    })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(`${OLD.ops} is no manager`)
  })

  test(`${OLD.dispatcher}'s column names it once, briefed by the session running spawn.sh`, async () => {
    const r = await spawn(
      ["column", OLD.dispatcher, "w1:p2", "h.md"],
      [{ name: OLD.ops, pid: 5100 }],
      {
        BRIEF_FILE: "h.md",
        CLAUDE_PID: "5100",
      },
    )
    expect(r.code).toBe(0)
    const command = launchAfterRm(r)
    expect(command).toContain(`env PLAYGROUND_ROLE=dispatcher claude -n ${OLD.dispatcher}`)
    expect(command).toContain(
      `You are ${OLD.dispatcher}, the Playground factory's dispatcher; ${OLD.ops} briefs you`,
    )
    expect(command).not.toContain("Report to")
    expect(r.roster?.slice(0, 3)).toEqual(["set", OLD.dispatcher, "kind=dispatcher"])
  })

  test("an <id>-dispatcher's column names it once, as the first dispatcher", async () => {
    const r = await spawn(
      ["column", "m4n7vw-dispatcher", "w1:p2", "h.md"],
      [{ name: OLD.ops, pid: 5100 }],
      { BRIEF_FILE: "h.md", CLAUDE_PID: "5100" },
    )
    expect(r.code).toBe(0)
    const command = launchAfterRm(r)
    expect(command).toContain("env PLAYGROUND_ROLE=dispatcher claude -n m4n7vw-dispatcher")
    expect(command).toContain(`${OLD.ops} briefs you`)
    expect(command).not.toContain("Report to")
    expect(r.roster?.slice(0, 3)).toEqual(["set", "m4n7vw-dispatcher", "kind=dispatcher"])
  })

  test("an <id>-ops column names it once and reports to the dispatcher the roster seats", async () => {
    const r = await spawn(["column", "x7mh4d-ops", "w1:p2", "h.md"], [], {
      BRIEF_FILE: "h.md",
      ROSTER_JSON: JSON.stringify({
        agents: [{ kind: "dispatcher", name: "m4n7vw-dispatcher", status: "working", task: "t" }],
      }),
    })
    expect(r.code).toBe(0)
    const command = launchAfterRm(r)
    expect(command).toContain("env PLAYGROUND_ROLE=lead claude -n x7mh4d-ops")
    expect(command).toContain("you report to m4n7vw-dispatcher")
    expect(r.roster?.slice(0, 3)).toEqual(["set", "x7mh4d-ops", "kind=ops"])
  })

  test.each([
    ["no CLAUDE_PID", {}],
    ["a registry with no entry for CLAUDE_PID", { CLAUDE_PID: "5101" }],
  ])(`${OLD.dispatcher}'s short column refuses with %s, naming the long form`, async (_, env) => {
    const r = await spawn(["column", OLD.dispatcher, "w1:p2", "h.md"], [], {
      BRIEF_FILE: "h.md",
      ...env,
    })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      `column dispatcher ${OLD.dispatcher} <the lead that briefs it> <pane> <brief>`,
    )
  })

  test.each(["worker-x", "reviewer-x"])(
    "a short column refuses %s, which is no manager, naming both forms",
    async (name) => {
      const r = await spawn(["column", name, "w1:p2", "h.md"], [], { BRIEF_FILE: "h.md" })
      expect(r.code).toBe(1)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("column <manager> <pane> <brief>")
      expect(r.err).toContain("column <reviewer|tester|probe|lead|dispatcher> <name> <reports-to>")
    },
  )

  test.each([`${OLD.dispatcher}-2`, "optimizer"])(
    "a short column refuses %s, pointing it to its own workspace",
    async (name) => {
      const r = await spawn(["column", name, "w1:p2", "h.md"], [], { BRIEF_FILE: "h.md" })
      expect(r.code).toBe(1)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(`spawn.sh manager ${name} <brief>`)
    },
  )

  test("the long column refuses the second dispatcher as the first's (PG-1644)", async () => {
    const r = await spawn(
      ["column", "dispatcher", `${OLD.dispatcher}-2`, OLD.ops, "w1:p2", "h.md"],
      [],
      {
        BRIEF_FILE: "h.md",
      },
    )
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(`spawn.sh manager ${OLD.dispatcher}-2 <brief>`)
  })

  test("a reviewer a lead spawns is not nested under the lead", async () => {
    const r = await spawn(
      ["column", "reviewer", "reviewer-changelog-700", OLD.builder, "w1:p2", "b.md", "--pr", "1"],
      [],
    )
    expect(r.code).toBe(0)
    expect(r.roster).toEqual([
      "set",
      "reviewer-changelog-700",
      "kind=reviewer",
      "prs+=1",
      "pr=1",
      "title=Plain test work",
      "task=b.md",
      "memory=off",
    ])
  })

  // the dashboard's schema drops an agent with no task, so a spawned probe went missing from the board. One spawn a case, as in the tests beside it: six in one test passed its 20s on a loaded runner.
  const rosterWith = (agent: Record<string, string>) => ({
    ROSTER_JSON: JSON.stringify({ agents: [{ name: "probe-api", role: "worker", ...agent }] }),
  })
  test.each([
    [
      "a worker takes its brief's file name",
      ["worker", "worker-brave-otter", "b-op-x.md"],
      {},
      ["task=b-op-x.md"],
    ],
    [
      "a probe takes its brief's file name",
      ["column", "probe", "probe-api", OLD.ops, "w1:p2", "p.md"],
      {},
      ["task=p.md"],
    ],
    [
      "a resumed lead takes its role and name",
      ["resume", OLD.planner, root, "--backend", "claude"],
      {},
      [`task=lead ${OLD.planner}`],
    ],
    [
      "a resumed probe takes probe and its name",
      ["resume", "probe-api", root, "--backend", "claude"],
      {},
      ["task=probe probe-api"],
    ],
    [
      "one that holds a task takes none",
      ["column", "probe", "probe-api", OLD.ops, "w1:p2", "p.md"],
      rosterWith({ status: "working", task: "Try the card" }),
      [],
    ],
    [
      "one that holds a pr takes none",
      ["column", "probe", "probe-api", OLD.ops, "w1:p2", "p.md"],
      rosterWith({ pr: "https://github.com/acme/factory/pull/1" }),
      [],
    ],
  ] as [string, string[], Record<string, string>, string[]][])(
    "a new entry takes a task: %s",
    async (_, args, env, want) => {
      const r = await spawn(args, [], env)
      expect(r.roster?.filter((a) => a.startsWith("task="))).toEqual(want)
    },
  )

  test("a resume into a workspace of its own clears the surface a column left", async () => {
    const r = await spawn(["resume", OLD.planner, root, "--backend", "claude"], [])
    expect(r.code).toBe(0)
    expect(r.roster).toContain("surface=")
  })

  // A checker's start, as a resume or a column, on the roster row given; the row's status=, prs and pr writes are what auto-end and the sweep read.
  const PR_A = "https://github.com/acme/factory/pull/1"
  const PR_B = "https://github.com/acme/factory/pull/2"
  const checkerStart = (mode: string, row: object | null, extra: string[] = []) => {
    const name = "reviewer-brave-otter"
    return spawn(
      [
        ...(mode === "resume"
          ? ["resume", name, root]
          : ["column", "reviewer", name, "worker-x", "w1:p2", "r.md"]),
        ...extra,
      ],
      [],
      row ? { ROSTER_JSON: JSON.stringify({ agents: [{ name, ...row }] }) } : {},
      undefined,
      mode === "resume" ? { name, backend: "claude" } : undefined,
    )
  }
  const statusAndPrs = (r: { roster?: string[] }) =>
    r.roster?.filter((arg) => /^(status|prs\+?|pr)=/.test(arg))

  test.each(["resume", "column"])(
    "a checker's %s on an ended row listing PR A, naming PR B, sets it live with prs and pr of PR B alone (#1135)",
    async (mode) => {
      const r = await checkerStart(mode, { pr: PR_A, prs: [PR_A], status: "ended" }, ["--pr", PR_B])
      expect(r.code).toBe(0)
      expect(statusAndPrs(r)).toEqual(["status=starting", `prs=${PR_B}`, `pr=${PR_B}`])
    },
  )

  test("a checker's resume on an ended row naming an issue beside its pull request keeps both in prs, its pr the pull request (#1135)", async () => {
    const issue = "https://github.com/acme/factory/issues/5"
    const r = await checkerStart("resume", { pr: PR_A, prs: [PR_A], status: "ended" }, [
      "--pr",
      `${issue},${PR_B}`,
    ])
    expect(r.code).toBe(0)
    expect(statusAndPrs(r)).toEqual(["status=starting", `prs=${issue},${PR_B}`, `pr=${PR_B}`])
  })

  test.each([
    ["resume", { pr: PR_A, prs: [PR_A], status: "ended" }],
    ["column", { pr: PR_A, prs: [PR_A], status: "ended" }],
    ["resume", { status: "working" }],
    ["column", { status: "working" }],
    ["column", null],
  ] as [string, object | null][])(
    "a checker's %s naming no PR is refused before any pane opens, naming --pr, on any row: %p (#1400)",
    async (mode, row) => {
      const r = await checkerStart(mode, row)
      expect(r.code).not.toBe(0)
      expect(r.err).toContain("--pr <pull url>")
      expect(r.roster).toBeUndefined()
      expect(placing(r)).toEqual([])
    },
  )

  test.each(["resume", "column"])(
    "a checker's %s writes its row's pr before its launch runs in the pane, since its first tool call reads it (#1400)",
    async (mode) => {
      const r = await checkerStart(mode, { status: "working" }, ["--pr", PR_B])
      expect(r.code).toBe(0)
      expect(r.rosterAtRun?.join("\n")).toContain(`pr=${PR_B}`)
    },
  )

  test("a worker's row is written once its session has started, as before (#1400)", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--title", "T"], [])
    expect(r.code).toBe(0)
    expect(r.rosterAtRun).toEqual([])
    expect(r.rosterLog?.length).toBe(1)
  })

  test.each([
    ["column", null, [`prs+=${PR_B}`, `pr=${PR_B}`]],
    ["column", { prs: [PR_A], status: "working" }, [`prs+=${PR_B}`, `pr=${PR_B}`]],
    ["resume", { prs: [PR_A], status: "working" }, [`prs+=${PR_B}`, `pr=${PR_B}`]],
    ["column", { pr: PR_A, prs: [PR_A], status: "working" }, [`prs+=${PR_B}`]],
    ["resume", { pr: PR_A, prs: [PR_A], status: "working" }, [`prs+=${PR_B}`]],
  ] as [string, object | null, string[]][])(
    "a checker's %s on a live row, or none, naming PR B adds it to prs, as assign does, and gives a row with no pr PR B as its pr: %p (#1135)",
    async (mode, row, sets) => {
      const r = await checkerStart(mode, row, ["--pr", PR_B])
      expect(r.code).toBe(0)
      expect(statusAndPrs(r)).toEqual(sets)
    },
  )

  test.each([
    ["resume", { pr: PR_A, prs: [PR_A], status: "ended" }],
    ["column", null],
  ] as [string, object | null][])(
    "a checker's %s naming only an issue is refused before any pane opens, since its row would name no pr: %p (#1400)",
    async (mode, row) => {
      const r = await checkerStart(mode, row, ["--pr", "https://github.com/acme/factory/issues/5"])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain("--pr <pull url>")
      expect(r.roster).toBeUndefined()
      expect(placing(r)).toEqual([])
    },
  )

  // a checker scoring an extension item could not start, since --pr took a GitHub pull request alone, and a restart of one holding an item in its prs closed its pane, then failed its resume (#1851).
  const ITEM = "acme/script/start-up"

  test("a checker's start naming only an extension item passes, its row's prs the item and its pr unset (#1851)", async () => {
    const r = await checkerStart("column", null, ["--pr", ITEM])
    expect(r.code).toBe(0)
    expect(statusAndPrs(r)).toEqual([`prs+=${ITEM}`, "pr="])
  })

  test("a checker's restart naming a pull request and an extension item passes, its pr the pull request (#1851)", async () => {
    const r = await checkerStart("resume", { pr: PR_A, prs: [PR_A, ITEM], status: "ended" }, [
      "--pr",
      `${PR_A},${ITEM}`,
    ])
    expect(r.code).toBe(0)
    expect(statusAndPrs(r)).toEqual(["status=starting", `prs=${PR_A},${ITEM}`, `pr=${PR_A}`])
  })

  test.each(["-acme/script/start-up", "acme/widget/start-up", "acme/script/Start-Up"])(
    "--pr refuses the extension item %s before any pane opens (#1851)",
    async (bad) => {
      const r = await checkerStart("column", null, ["--pr", bad])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain("<scope>/<kind>/<key>")
      expect(placing(r)).toEqual([])
    },
  )

  test("spawn.sh's extension item form names the kinds playground ext takes (#1851)", async () => {
    const source = await Bun.file(script).text()
    expect(source).toContain(`/(${KINDS.join("|")})/`)
  })

  test("a checker's failed roster write refuses its start before its pane opens (#1400)", async () => {
    const r = await spawn(
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", PR_B],
      [],
      { FAKE_ROSTER_BROKEN: "1" },
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("its roster write failed before its pane opened")
    expect(placing(r)).toEqual([])
    expect(readdirSync(join(r.home, ".playground", "launch"))).toEqual([])
  })

  test.each([
    [`${PR_A},${PR_B}`, PR_A],
    [`${PR_B},${PR_A}`, PR_B],
  ])(
    "--pr takes the PRs a restart passes, a comma list, whole, its first pull request as pr: %s (#1135)",
    async (named, first) => {
      const r = await checkerStart("resume", { pr: PR_B, prs: [PR_A, PR_B], status: "ended" }, [
        "--pr",
        named,
      ])
      expect(r.code).toBe(0)
      expect(statusAndPrs(r)).toEqual(["status=starting", `prs=${named}`, `pr=${first}`])
    },
  )

  test.each([
    ["a PR's form", ["resume", "reviewer-brave-otter", root, "--pr", "pull/2"], "--pr takes"],
    [
      "a worker's start",
      ["worker", "worker-brave-otter", "b.md", "--title", "T", "--pr", "2"],
      "--pr is for",
    ],
    [
      "a probe's column",
      ["column", "probe", "probe-brave-otter", "worker-x", "w1:p2", "p.md", "--pr", "2"],
      "not a probe's",
    ],
  ])("--pr is refused before any pane opens: %s", async (_, args, said) => {
    const r = await spawn(args, [], {}, undefined, {
      name: "reviewer-brave-otter",
      backend: "claude",
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(said)
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["ended", ["status=starting"]],
    ["working", []],
  ] as [string, string[]][])(
    "a resume of a non-checker's %s row writes %p, so only a row close ended runs again",
    async (status, want) => {
      const r = await spawn(["resume", OLD.planner, root, "--backend", "claude"], [], {
        ROSTER_JSON: JSON.stringify({ agents: [{ name: OLD.planner, status }] }),
      })
      expect(r.code).toBe(0)
      expect(r.roster?.filter((arg) => arg.startsWith("status="))).toEqual(want)
    },
  )

  test("a resume by session id, as up.py --sessions prints it", async () => {
    const id = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"
    const r = await spawn(["resume", OLD.builder, root, id], [], {}, undefined, {
      name: OLD.builder,
      backend: "claude",
    })
    expect(r.code).toBe(0)
    expect(launchAfterRm(r)).toContain(
      `env PLAYGROUND_ROLE=lead claude --resume ${id} -n ${OLD.builder}`,
    )
  })

  test("a roster write that fails after the spawn says the session started, and exits 0", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_ROSTER_BROKEN: "1" })
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
    expect(r.err).toContain("worker-brave-otter started, but its roster write failed")
  })

  test("on launchd's PATH, with no bun on it, the roster write runs bun from its install folder", async () => {
    const noBun = join(scratch, "bin-no-bun")
    mkdirSync(noBun, { recursive: true })
    for (const f of readdirSync(bin)) {
      if (f !== "bun" && !existsSync(join(noBun, f))) symlinkSync(join(bin, f), join(noBun, f))
    }
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { PATH: `${noBun}:/usr/bin:/bin` },
      script,
      undefined,
      (home) => {
        mkdirSync(join(home, ".bun", "bin"), { recursive: true })
        symlinkSync(join(bin, "bun"), join(home, ".bun", "bin", "bun"))
      },
    )
    expect(r.code).toBe(0)
    expect(r.err).not.toContain("roster write failed")
    expect(r.rosterLog?.[0]).toStartWith("set worker-brave-otter kind=worker")
  })
})
