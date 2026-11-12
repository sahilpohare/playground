import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dataDir } from "../../packages/env/src/data-dir"
import { USAGE } from "../../scripts/roster"
import { storeWith } from "./hooks/render-set"

const script = join(import.meta.dir, "..", "..", "scripts", "roster.ts")
const scratch = mkdtempSync(join(tmpdir(), "roster-ts-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

type Agent = Record<string, unknown> & { name: string }
type RosterFile = { agents: Agent[]; backlog?: string[]; updatedAt?: string }

let dirs = 0
// A config folder of its own per case, holding the roster as earlier writes left it (none when agents is null).
// A config folder whose store sets factory.repo to acme/app, so a bare PR number never reads the checkout's origin, which a box run has none of.
const configWith = (agents: Agent[] | null, backlog?: string[]): string => {
  const dir = join(scratch, `config-${++dirs}`)
  mkdirSync(join(dir, "playground"), { recursive: true })
  storeWith(join(dir, "playground"), {}, { "factory.repo": "acme/app" })
  if (agents)
    writeFileSync(
      join(dir, "playground", "roster.json"),
      JSON.stringify({ agents, backlog, updatedAt: "2026-10-01T00:00:00Z" }),
    )
  return dir
}

// A config folder whose store sets factory.repo, the repository a bare PR number links into.
const factoryConfig = (agents: Agent[]): string => {
  const dir = configWith(agents)
  storeWith(join(dir, "playground"), {}, { "factory.repo": "acme/factory" })
  return dir
}

const run = async (config: string, args: string[]) => {
  const proc = Bun.spawn(["bun", script, ...args], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  const code = await proc.exited
  const path = join(config, "playground", "roster.json")
  return {
    code,
    err: await new Response(proc.stderr).text(),
    out: await new Response(proc.stdout).text(),
    roster: existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RosterFile) : null,
  }
}

// A UTC ISO time the given minutes from now, as `date -u +%FT%TZ` prints one.
const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")

const agentOf = (roster: RosterFile | null, name: string) =>
  roster?.agents.find((a) => a.name === name)

const WITH_PR: Agent = {
  branch: "pg-1-x",
  kind: "worker",
  lastReport: "PR opened",
  lastReportAt: "2026-10-01T00:00:00Z",
  name: "worker-greed",
  pr: "https://github.com/acme/app/pull/1",
  repo: "acme/app",
  role: "worker",
  status: "working",
  task: "Fix the export",
  title: "Export fix",
}

describe("set", () => {
  test("a new agent takes its kind and role from kind=, its name aside", async () => {
    const r = await run(configWith([]), [
      "set",
      "k3v9q2-reviewer",
      "kind=reviewer",
      "task=Review #97",
      "worker=x7mh4d-worker",
    ])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "k3v9q2-reviewer")).toEqual({
      kind: "reviewer",
      name: "k3v9q2-reviewer",
      role: "worker",
      status: "starting",
      task: "Review #97",
      title: "",
      worker: "x7mh4d-worker",
    })
    const runner = await run(configWith([]), ["set", "x7mh4d-runner", "kind=runner", "task=t"])
    expect(agentOf(runner.roster, "x7mh4d-runner")?.role).toBe("runner")
    const builder = await run(configWith([]), ["set", "x7mh4d-builder", "kind=builder", "task=t"])
    expect(agentOf(builder.roster, "x7mh4d-builder")?.role).toBe("manager")
  })

  test("a new agent with an old name takes the kind its prefix gives", async () => {
    const r = await run(configWith([]), ["set", "runner-pride", "task=t", "workspace=workspace:3"])
    expect(agentOf(r.roster, "runner-pride")).toMatchObject({ kind: "runner", role: "runner" })
    const plain = await run(configWith([]), ["set", "dispatcher", "status=working", "task=t"])
    expect(agentOf(plain.roster, "dispatcher")).toMatchObject({ role: "manager" })
    expect(agentOf(plain.roster, "dispatcher")?.kind).toBeUndefined()
  })

  // the dashboard's schema drops an agent with no task, so a spawned probe went missing from the board.
  test("a new agent with no task, or an empty one, is refused, naming task=, and the roster is left as it was", async () => {
    const config = configWith([WITH_PR])
    const pair = "add task=<what it does>"
    for (const [args, fix] of [
      [["set", "probe-x", "kind=probe"], pair],
      [["set", "probe-x", "kind=probe", "task="], pair],
      [["set", "probe-x", "task=  "], pair],
      [["report", "probe-x", "started"], pair],
      [["assign", "probe-x", "Probe", ""], "give what it does as assign's <task> word"],
    ] as const) {
      const r = await run(config, [...args])
      expect(r.code).toBe(1)
      expect(r.err).toContain("probe-x is not on the roster yet")
      expect(r.err).toContain(fix)
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
    const kept = await run(config, ["set", "worker-greed", "status=parked", "hold=#12"])
    expect(kept.code).toBe(0)
    expect(agentOf(kept.roster, "worker-greed")).toEqual({
      ...WITH_PR,
      hold: "#12",
      status: "parked",
    })
  })

  test("a kind outside the list is refused, and the roster is left as it was", async () => {
    const config = configWith([WITH_PR])
    const r = await run(config, ["set", "worker-greed", "kind=wizard"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("kind takes one of assistant, builder, dispatcher")
    expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
  })

  test("a new task on an agent holding a pr is refused, naming assign", async () => {
    const config = configWith([WITH_PR])
    const r = await run(config, ["set", "worker-greed", "task=Something else"])
    expect(r.code).toBe(1)
    expect(r.err).toContain("worker-greed holds a pr")
    expect(r.err).toContain("roster.ts assign worker-greed")
    expect(r.roster?.agents).toEqual([WITH_PR])
    const at = inMinutes(90)
    const eta = await run(config, ["set", "worker-greed", `eta=${at}`])
    expect(eta.code).toBe(0)
    expect(agentOf(eta.roster, "worker-greed")).toEqual({ ...WITH_PR, eta: at })
  })

  // rows read by their first ask while no title was set, and set refused one on a row holding a pr.
  test("a title on an agent holding a pr is set, leaving its pr, branch and repo", async () => {
    const config = configWith([WITH_PR])
    const r = await run(config, ["set", "worker-greed", "title=Fix the CSV export"])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "worker-greed")).toEqual({ ...WITH_PR, title: "Fix the CSV export" })
  })

  // a reviewer moved to another PR by message kept its old worker, which held that worker's ended row in the sidebar.
  test("a checker's pr or worker moves only through assign, which takes both, and set or report naming either is refused", async () => {
    const checker: Agent = {
      kind: "reviewer",
      name: "k3v9q2-reviewer",
      pr: "https://github.com/acme/app/pull/1",
      role: "worker",
      status: "working",
      task: "Review #1",
      title: "Reviewer of x7mh4d-worker",
      worker: "x7mh4d-worker",
    }
    const config = configWith([checker])
    for (const args of [
      ["set", "k3v9q2-reviewer", "pr=2"],
      ["set", "k3v9q2-reviewer", "worker=b4n8tz-worker"],
      ["set", "k3v9q2-reviewer", "worker=b4n8tz-worker", "pr=2"],
      ["report", "k3v9q2-reviewer", "on #2", "pr=2"],
      ["assign", "k3v9q2-reviewer", "Reviewer", "Review #2", "pr=2"],
      ["assign", "k3v9q2-reviewer", "Reviewer", "Review #2", "worker=b4n8tz-worker"],
    ]) {
      const r = await run(config, args)
      expect(r.code).toBe(1)
      expect(r.err).toContain(
        "roster.ts assign k3v9q2-reviewer <title> <task> worker=<worker> pr=<url>",
      )
      expect(r.roster?.agents).toEqual([checker])
    }
    for (const pairs of [["worker=x7mh4d-worker", "pr=1"], ["status=waiting"]]) {
      const same = await run(config, ["set", "k3v9q2-reviewer", ...pairs])
      expect(same.code).toBe(0)
    }
    const retask = await run(config, [
      "assign",
      "k3v9q2-reviewer",
      "Reviewer of b4n8tz-worker",
      "Review #2",
      "worker=b4n8tz-worker",
      "pr=2",
    ])
    expect(retask.code).toBe(0)
    expect(agentOf(retask.roster, "k3v9q2-reviewer")).toEqual({
      ...checker,
      pr: "https://github.com/acme/app/pull/2",
      prs: ["https://github.com/acme/app/pull/1", "https://github.com/acme/app/pull/2"],
      task: "Review #2",
      title: "Reviewer of b4n8tz-worker",
      worker: "b4n8tz-worker",
    })
    const worker = await run(configWith([WITH_PR]), ["set", "worker-greed", "pr=2"])
    expect(worker.code).toBe(0)
  })

  test("an ended checker's restart moves its pr together with its prs in one set, as spawn.sh's --pr writes them, while a set naming pr alone is still refused (#1135)", async () => {
    const ended: Agent = {
      kind: "reviewer",
      name: "k3v9q2-reviewer",
      pr: "https://github.com/acme/app/pull/1",
      prs: ["https://github.com/acme/app/pull/1"],
      role: "worker",
      status: "ended",
      task: "Review #1",
      title: "Reviewer of x7mh4d-worker",
      worker: "x7mh4d-worker",
    }
    const restart = await run(configWith([ended]), [
      "set",
      "k3v9q2-reviewer",
      "status=starting",
      "prs=https://github.com/acme/app/pull/2",
      "pr=https://github.com/acme/app/pull/2",
    ])
    expect(restart.code).toBe(0)
    expect(agentOf(restart.roster, "k3v9q2-reviewer")).toEqual({
      ...ended,
      pr: "https://github.com/acme/app/pull/2",
      prs: ["https://github.com/acme/app/pull/2"],
      status: "starting",
    })
    const issue = await run(configWith([ended]), [
      "set",
      "k3v9q2-reviewer",
      "status=starting",
      "prs=https://github.com/acme/app/issues/5",
      "pr=",
    ])
    expect(issue.code).toBe(0)
    expect(agentOf(issue.roster, "k3v9q2-reviewer")?.pr).toBeUndefined()
    const alone = await run(configWith([ended]), ["set", "k3v9q2-reviewer", "pr=2"])
    expect(alone.code).toBe(1)
  })

  // the checker reaper ended a reviewer whose lead had added PRs with prs+= alone while its row still named a worker that had ended (#1839).
  describe("a checker whose worker is missing or ended takes no new PR but through assign (#1839)", () => {
    const pull = (n: number) => `https://github.com/acme/app/pull/${n}`
    const gone: Agent = {
      kind: "worker",
      name: "x7mh4d-worker",
      role: "worker",
      status: "ended",
      task: "Fix #1",
    }
    const live: Agent = { ...gone, name: "b4n8tz-worker", status: "working", task: "Fix #3" }
    const checker: Agent = {
      kind: "reviewer",
      name: "k3v9q2-reviewer",
      pr: pull(1),
      prs: [pull(1)],
      role: "worker",
      status: "working",
      task: "Review #1",
      title: "Reviewer of x7mh4d-worker",
      worker: "x7mh4d-worker",
    }
    const { pr: _pr, prs: _prs, worker: _worker, ...bare } = checker
    const FIX = "roster.ts assign k3v9q2-reviewer <title> <task> worker=<live worker> pr=<n>"

    for (const [why, agents, args] of [
      [
        "prs+= while its worker has ended",
        [gone, live, checker],
        ["set", "k3v9q2-reviewer", "prs+=2"],
      ],
      [
        "prs= while its worker has ended",
        [gone, live, checker],
        ["set", "k3v9q2-reviewer", "prs=1,2"],
      ],
      [
        "report's prs+= while its worker has ended",
        [gone, live, checker],
        ["report", "k3v9q2-reviewer", "on #2", "prs+=2"],
      ],
      [
        "assign naming an ended worker",
        [gone, live, checker],
        ["assign", "k3v9q2-reviewer", "Reviewer", "Review #2", "worker=x7mh4d-worker", "pr=2"],
      ],
      [
        "a restart of an ended checker whose worker has ended",
        [gone, { ...checker, status: "ended" }],
        ["set", "k3v9q2-reviewer", "kind=reviewer", "status=starting", "prs=3", "pr=3"],
      ],
      [
        "a restart of an ended checker on the PR it holds, whose worker has ended",
        [gone, { ...checker, status: "ended" }],
        ["set", "k3v9q2-reviewer", "kind=reviewer", "status=starting", "prs=1", "pr=1"],
      ],
      [
        "a restart of an ended checker with no worker, as a lead's column writes one",
        [{ ...bare, status: "ended" }],
        ["set", "k3v9q2-reviewer", "kind=reviewer", "status=starting", "prs=3", "pr=3"],
      ],
      ["prs+= with no worker", [bare], ["set", "k3v9q2-reviewer", "prs+=2"]],
      ["a first pr with no worker", [bare], ["set", "k3v9q2-reviewer", "pr=2"]],
    ] as [string, Agent[], string[]][])
      test(`refuses ${why}, naming assign with a live worker, and writes nothing`, async () => {
        const r = await run(configWith(agents), args)
        expect(r.code).toBe(1)
        expect(r.err).toContain(FIX)
        expect(r.roster?.agents).toEqual(agents)
      })

    test("takes prs-= and a status while its worker has ended", async () => {
      const config = configWith([gone, live, checker])
      expect((await run(config, ["set", "k3v9q2-reviewer", "prs-=1"])).code).toBe(0)
      expect((await run(config, ["set", "k3v9q2-reviewer", "status=waiting"])).code).toBe(0)
    })

    test("a checker a lead started with no worker, refused prs+=, takes the PR through the assign the refusal names", async () => {
      const config = configWith([live, bare])
      const refused = await run(config, ["set", "k3v9q2-reviewer", "prs+=2"])
      expect(refused.code).toBe(1)
      expect(refused.err).toContain(FIX)
      const assigned = await run(config, [
        "assign",
        "k3v9q2-reviewer",
        "Reviewer of b4n8tz-worker",
        "Review #2",
        "worker=b4n8tz-worker",
        "pr=2",
      ])
      expect(assigned.code).toBe(0)
      expect(agentOf(assigned.roster, "k3v9q2-reviewer")).toMatchObject({
        pr: pull(2),
        prs: [pull(2)],
        worker: "b4n8tz-worker",
      })
    })

    test("assign with a live worker moves it to the new PR", async () => {
      const r = await run(configWith([gone, live, checker]), [
        "assign",
        "k3v9q2-reviewer",
        "Reviewer of b4n8tz-worker",
        "Review #3",
        "worker=b4n8tz-worker",
        "pr=3",
      ])
      expect(r.code).toBe(0)
      expect(agentOf(r.roster, "k3v9q2-reviewer")).toMatchObject({
        pr: pull(3),
        prs: [pull(1), pull(3)],
        worker: "b4n8tz-worker",
      })
    })

    test("prs+= with a live worker passes, as spawn.sh's first write of a new checker gives it", async () => {
      const r = await run(configWith([live]), [
        "set",
        "k3v9q2-reviewer",
        "kind=reviewer",
        "task=Review #3",
        "prs+=3",
        "pr=3",
        "worker=b4n8tz-worker",
      ])
      expect(r.code).toBe(0)
      expect(agentOf(r.roster, "k3v9q2-reviewer")).toMatchObject({ pr: pull(3), prs: [pull(3)] })
    })

    test("spawn.sh's restart of an ended checker passes, by resume and by a column under a live worker", async () => {
      const ended: Agent = { ...checker, status: "ended", worker: "b4n8tz-worker" }
      const resume = await run(configWith([live, ended]), [
        "set",
        "k3v9q2-reviewer",
        "kind=reviewer",
        "status=starting",
        "prs=2",
        "pr=2",
      ])
      expect(resume.code).toBe(0)
      const column = await run(configWith([gone, live, ended]), [
        "set",
        "k3v9q2-reviewer",
        "kind=reviewer",
        "status=starting",
        "prs=3",
        "pr=3",
        "worker=b4n8tz-worker",
      ])
      expect(column.code).toBe(0)
      expect(agentOf(column.roster, "k3v9q2-reviewer")).toMatchObject({
        pr: pull(3),
        prs: [pull(3)],
        status: "starting",
        worker: "b4n8tz-worker",
      })
    })
  })

  test("a title loses a trailing (#N) and is cut to 40 characters; an empty value removes its key", async () => {
    const r = await run(configWith([]), [
      "set",
      "worker-envy",
      "task=t",
      "title=A title that runs well past forty characters (#97)",
      "kind=",
    ])
    expect(agentOf(r.roster, "worker-envy")?.title).toBe("A title that runs well past forty charac")
    expect(agentOf(r.roster, "worker-envy")).not.toHaveProperty("kind")
  })

  // code-review-loop's recovery scan holds a PR by its full URL alone, so a bare number read as lost.
  test("a bare pr number, with or without #, becomes the full URL of the call's repo, else the row's, else factory.repo's", async () => {
    const url = "https://github.com/acme/app/pull/1561"
    for (const pr of ["1561", "#1561"]) {
      const r = await run(configWith([]), ["set", "worker-envy", "task=t", `pr=${pr}`])
      expect(r.code).toBe(0)
      expect(agentOf(r.roster, "worker-envy")?.pr).toBe(url)
      const a = await run(configWith([]), [
        "assign",
        "reviewer-envy",
        "Review",
        "t",
        "worker=worker-envy",
        `pr=${pr}`,
      ])
      expect(a.code).toBe(0)
      expect(agentOf(a.roster, "reviewer-envy")?.pr).toBe(url)
    }
    const otherRepo = "acme-labs/acme-app"
    const call = await run(configWith([]), [
      "set",
      "worker-envy",
      "task=t",
      "pr=7",
      `repo=${otherRepo}`,
    ])
    expect(agentOf(call.roster, "worker-envy")?.pr).toBe(`https://github.com/${otherRepo}/pull/7`)
    const row = await run(configWith([{ ...WITH_PR, repo: otherRepo }]), [
      "set",
      "worker-greed",
      "pr=#8",
    ])
    expect(agentOf(row.roster, "worker-greed")?.pr).toBe(`https://github.com/${otherRepo}/pull/8`)
    const cleared = await run(factoryConfig([{ ...WITH_PR, repo: otherRepo }]), [
      "assign",
      "worker-greed",
      "Next",
      "t",
      "pr=9",
    ])
    expect(agentOf(cleared.roster, "worker-greed")?.pr).toBe(
      "https://github.com/acme/factory/pull/9",
    )
    const emptied = await run(factoryConfig([{ ...WITH_PR, repo: otherRepo }]), [
      "set",
      "worker-greed",
      "repo=",
      "pr=11",
    ])
    expect(agentOf(emptied.roster, "worker-greed")?.pr).toBe(
      "https://github.com/acme/factory/pull/11",
    )
    const full = `https://github.com/${otherRepo}/pull/10`
    const kept = await run(configWith([]), ["set", "worker-envy", "task=t", `pr=${full}`])
    expect(agentOf(kept.roster, "worker-envy")?.pr).toBe(full)
  })

  test("any other pr value is refused, naming the URL form, and the roster is left as it was", async () => {
    const config = configWith([WITH_PR])
    for (const args of [
      ["set", "worker-greed", "pr=abc"],
      ["set", "worker-greed", "pr=0"],
      ["set", "worker-greed", "pr=1561x"],
      ["set", "worker-greed", "pr=github.com/acme/app/pull/1"],
      ["set", "worker-greed", "repo=bad", "pr=7"],
      ["report", "worker-greed", "opened", "pr=#x"],
      ["assign", "worker-greed", "Next", "t", "pr=abc"],
    ]) {
      const r = await run(config, args)
      expect(r.code).toBe(2)
      expect(r.err).toContain("https://github.com/<owner>/<name>/pull/<n>")
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
  })

  test("every write stamps updatedAt from the clock, and a missing roster starts empty", async () => {
    const before = Date.now() - 1000
    const r = await run(configWith(null), ["set", "worker-envy", "kind=worker", "task=t"])
    expect(r.code).toBe(0)
    expect(r.roster?.agents.map((a) => a.name)).toEqual(["worker-envy"])
    expect(r.roster?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(Date.parse(r.roster?.updatedAt ?? "")).toBeGreaterThanOrEqual(before)
  })

  test("with PLAYGROUND_DATA_DIR set, the row lands in that data folder, where spawn.sh reads the roster", async () => {
    const config = configWith(null)
    const data = join(scratch, `data-${++dirs}`)
    storeWith(data, {}, { "factory.repo": "acme/app" })
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: data }
    const proc = Bun.spawn(["bun", script, "set", "p4dd1r-worker", "task=t"], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(await proc.exited).toBe(0)
    const read = JSON.parse(readFileSync(join(dataDir(env), "roster.json"), "utf8")) as RosterFile
    expect(agentOf(read, "p4dd1r-worker")?.task).toBe("t")
    expect(existsSync(join(config, "playground", "roster.json"))).toBe(false)
  })
})

// a reviewer scoring an extension item kept the ended worker it last served, since pr= took a GitHub PR alone, and the checker reaper ended it mid-review (#1851).
describe("an extension item as a checker's pr (#1851)", () => {
  const pull = (n: number) => `https://github.com/acme/app/pull/${n}`
  const REF = "acme/script/start-up"
  const gone: Agent = {
    kind: "worker",
    name: "x7mh4d-worker",
    role: "worker",
    status: "ended",
    task: "Fix #1",
  }
  const live: Agent = { ...gone, name: "b4n8tz-worker", status: "working", task: "Fix #3" }
  const checker: Agent = {
    kind: "reviewer",
    name: "k3v9q2-reviewer",
    pr: pull(1),
    prs: [pull(1)],
    role: "worker",
    status: "working",
    task: "Review #1",
    title: "Reviewer of x7mh4d-worker",
    worker: "x7mh4d-worker",
  }
  const assign = (pr: string, worker = "b4n8tz-worker") => [
    "assign",
    "k3v9q2-reviewer",
    "Review: the start-up script",
    "Score the item",
    `worker=${worker}`,
    `pr=${pr}`,
  ]

  test("assign with a live worker and an item ref sets the worker and keeps the ref in prs, leaving pr unset", async () => {
    const r = await run(configWith([gone, live, checker]), assign(REF))
    expect(r.code).toBe(0)
    const row = agentOf(r.roster, "k3v9q2-reviewer")
    expect(row).toMatchObject({ prs: [pull(1), REF], status: "working", worker: "b4n8tz-worker" })
    expect(row).not.toHaveProperty("pr")
  })

  for (const bad of ["-acme/script/start-up", "acme/widget/start-up", "acme/script/Start-Up"])
    test(`refuses the ref ${bad}, naming the form, and writes nothing`, async () => {
      const agents = [gone, live, checker]
      const r = await run(configWith(agents), assign(bad))
      expect(r.code).toBe(2)
      expect(r.err).toContain("<scope>/<kind>/<key>")
      expect(r.roster?.agents).toEqual(agents)
    })

  test("refuses an item ref with an ended worker, naming assign with a live worker", async () => {
    const agents = [gone, live, checker]
    const r = await run(configWith(agents), assign(REF, "x7mh4d-worker"))
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "roster.ts assign k3v9q2-reviewer <title> <task> worker=<live worker> pr=<n>",
    )
    expect(r.roster?.agents).toEqual(agents)
  })

  test("prs+= and prs-= take an item ref on a checker with a live worker", async () => {
    const config = configWith([live, { ...checker, worker: "b4n8tz-worker" }])
    const added = await run(config, ["set", "k3v9q2-reviewer", `prs+=${REF}`])
    expect(added.code).toBe(0)
    expect(agentOf(added.roster, "k3v9q2-reviewer")?.prs).toEqual([pull(1), REF])
    const removed = await run(config, ["set", "k3v9q2-reviewer", `prs-=${REF}`])
    expect(agentOf(removed.roster, "k3v9q2-reviewer")?.prs).toEqual([pull(1)])
  })

  test("a worker's pr takes no item ref", async () => {
    const r = await run(configWith([live]), ["set", "b4n8tz-worker", `pr=${REF}`])
    expect(r.code).toBe(2)
    expect(agentOf(r.roster, "b4n8tz-worker")).toEqual(live)
  })
})

describe("prs (#706)", () => {
  const pull = (n: number) => `https://github.com/acme/app/pull/${n}`
  const ISSUE = "https://github.com/acme/app/issues/9"
  const reviewer: Agent = {
    kind: "reviewer",
    name: "x7rv2k-reviewer",
    pr: pull(1),
    role: "worker",
    status: "working",
    task: "Review #1",
    title: "Reviewer of x7rv2k-worker",
    worker: "x7rv2k-worker",
  }

  test("prs= sets the list, prs+= adds one, prs-= removes one, and the last removal drops the key", async () => {
    const config = configWith([reviewer])
    const set = await run(config, ["set", "x7rv2k-reviewer", "prs=1,#2"])
    expect(set.code).toBe(0)
    expect(agentOf(set.roster, "x7rv2k-reviewer")?.prs).toEqual([pull(1), pull(2)])
    const added = await run(config, ["set", "x7rv2k-reviewer", `prs+=${ISSUE}`, "prs+=2"])
    expect(agentOf(added.roster, "x7rv2k-reviewer")?.prs).toEqual([pull(1), pull(2), ISSUE])
    const removed = await run(config, ["set", "x7rv2k-reviewer", "prs-=1", `prs-=${ISSUE}`])
    expect(agentOf(removed.roster, "x7rv2k-reviewer")?.prs).toEqual([pull(2)])
    const empty = await run(config, ["set", "x7rv2k-reviewer", "prs-=2"])
    expect(agentOf(empty.roster, "x7rv2k-reviewer")).toEqual(reviewer)
  })

  test("a prs entry that is no PR and no issue is refused, naming both forms, and writes nothing", async () => {
    const config = configWith([reviewer])
    const r = await run(config, ["set", "x7rv2k-reviewer", "prs+=next"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("prs takes https://github.com/<owner>/<name>/pull/<n>")
    expect(r.err).toContain("https://github.com/<owner>/<name>/issues/<n>")
    expect(r.roster?.agents).toEqual([reviewer])
  })

  test("a checker's assign keeps its list and adds the old and the next PR; a worker's assign writes none", async () => {
    const config = configWith([{ ...reviewer, prs: [pull(1), ISSUE] }, WITH_PR])
    const next = await run(config, [
      "assign",
      "x7rv2k-reviewer",
      "Reviewer of b4n8tz-worker",
      "Review #3",
      "worker=b4n8tz-worker",
      "pr=3",
    ])
    expect(next.code).toBe(0)
    expect(agentOf(next.roster, "x7rv2k-reviewer")?.prs).toEqual([pull(1), ISSUE, pull(3)])
    const worker = await run(config, ["assign", "worker-greed", "New chore", "Do it"])
    expect(agentOf(worker.roster, "worker-greed")?.prs).toBeUndefined()
  })
})

// ops-report took an ended session whose status held a sentence for one that was down.
describe("status", () => {
  const statuses = join(import.meta.dir, "..", "..", "scripts", "roster-statuses.json")

  test("is defined once, holding the words ops-report reads as finished", async () => {
    const { finished, live } = (await Bun.file(statuses).json()) as Record<string, string[]>
    expect(finished).toEqual(["closed", "done", "ended", "merged", "parked", "paused"])
    expect(live).toEqual(["starting", "waiting", "working"])
  })

  test("holds every word a roster reader compares a status with", async () => {
    const { finished, live } = (await Bun.file(statuses).json()) as Record<string, string[]>
    const root = join(import.meta.dir, "..", "..")
    // Each reader by the expression it reads a roster entry's status through.
    for (const [file, through] of [
      ["api/hono/src/lib/dashboard/agents.ts", "agent\\.status"],
      ["packages/config/src/kinds.ts", "status"],
      ["packages/scripts/src/ops-sweep/sweep.ts", "a\\.status"],
      ["packages/scripts/src/ops-tick/tick.ts", "agent\\?\\.status"],
      ["packages/scripts/src/verify/checks.ts", "a\\.status"],
      ["scripts/ops/optimizer/idle_sessions.ts", "r\\.status"],
      ["scripts/ops/up.py", 'a\\.get\\("status"\\)'],
      ["scripts/spawn.sh", 'a\\.get\\("status"\\)'],
      ["extensions/core/skills/code-review-loop/scripts/state.ts", "a\\.status"],
      ["web/next/src/components/dashboard/status-table.tsx", "agent\\.status"],
      ["web/next/src/lib/agents.ts", "agent\\.status"],
    ] as const) {
      const text = readFileSync(join(root, file), "utf8")
      const all = (pattern: string) => [...text.matchAll(new RegExp(pattern, "g"))]
      const quoted = (lists: RegExpExecArray[]) =>
        lists.flatMap((m) => [...m[1]!.matchAll(/"([a-z-]+)"/g)].map((q) => q[1]))
      const words = [
        ...all(`(?<![\\w.])${through} [!=]==? "([a-z-]+)"`).map((m) => m[1]),
        ...quoted(all(`\\[([^\\]]*)\\]\\.includes\\(${through}\\)`)),
        ...quoted(all(`${through} (?:not )?in \\(([^)]*)\\)`)),
        ...quoted(all(`(?:SEATLESS|HELD) = new Set\\(\\[(.*)\\]\\)`)),
      ]
      expect({ file, read: words.length > 0 }).toEqual({ file, read: true })
      for (const word of words)
        expect({ file, word, listed: [...live!, ...finished!].includes(word!) }).toEqual({
          file,
          word,
          listed: true,
        })
    }
  })

  test("takes every word of the list", async () => {
    const { finished, live } = (await Bun.file(statuses).json()) as Record<string, string[]>
    const config = configWith([WITH_PR])
    for (const word of [...live!, ...finished!]) {
      // a park names what it waits on
      const hold = word === "parked" ? ["hold=#12"] : []
      const r = await run(config, ["set", "worker-greed", `status=${word}`, ...hold])
      expect([r.code, agentOf(r.roster, "worker-greed")?.status]).toEqual([0, word])
    }
  })

  test("refuses any other text on set, report and assign, naming report, and writes nothing", async () => {
    const config = configWith([WITH_PR])
    for (const args of [
      ["set", "worker-greed", "status=ended: #1522 merged d2868c2"],
      ["set", "worker-greed", "status="],
      ["set", "worker-greed", "status=working", "status=free text here"],
      ["report", "worker-greed", "r3 4/5", "status=fixing S1"],
      ["assign", "worker-greed", "Chore", "Do it", "status=active"],
    ]) {
      const r = await run(config, args)
      expect(r.code).toBe(2)
      expect(r.err).toContain("status takes one of starting, waiting, working, closed, done, ended")
      expect(r.err).toContain('roster.ts report worker-greed "<text>"')
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
  })

  test("leaves a row already holding text: its other keys still write", async () => {
    const old = { ...WITH_PR, status: "#1114 r3 4/5 @7453ba1, fixing S1/S2" }
    const at = inMinutes(90)
    const r = await run(configWith([old]), ["set", "worker-greed", `eta=${at}`])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "worker-greed")).toEqual({ ...old, eta: at })
    const report = await run(configWith([old]), [
      "report",
      "worker-greed",
      "merged",
      "status=ended",
    ])
    expect(agentOf(report.roster, "worker-greed")?.status).toBe("ended")
  })
})

// a worker sent its lead the literal placeholder <ETA>, and the roster stored it.
describe("eta", () => {
  test.each([
    ["the placeholder", "<ETA>"],
    ["a clock time alone", "13:50Z"],
    ["a time a minute past", inMinutes(-1)],
    ["a date no calendar holds", "2099-02-30T00:00:00Z"],
  ])("%s is refused by set, report and assign, naming the recipe", async (_case, value) => {
    for (const args of [
      ["set", "worker-greed", `eta=${value}`],
      ["report", "worker-greed", "PR opened", `eta=${value}`],
      ["assign", "worker-greed", "Export fix", "Fix the export", `eta=${value}`],
    ]) {
      const r = await run(configWith([WITH_PR]), args)
      expect(r.code).toBe(2)
      expect(r.err).toContain("an ETA is `date -u` plus your estimate, in UTC")
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
  })

  // apply() writes every pair, the last one winning, so a refused eta= after a good one must not slip through.
  test("every eta= a call gives is read, so a bad one after a good one or an empty one is refused", async () => {
    for (const first of [`eta=${inMinutes(60)}`, "eta="]) {
      const r = await run(configWith([WITH_PR]), ["set", "worker-greed", first, "eta=<ETA>"])
      expect(r.code).toBe(2)
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
  })

  test("a future UTC ISO time is stored, and an empty eta= clears it", async () => {
    const config = configWith([WITH_PR])
    const at = inMinutes(60)
    const set = await run(config, ["set", "worker-greed", `eta=${at}`])
    expect(set.code).toBe(0)
    expect(agentOf(set.roster, "worker-greed")?.eta).toBe(at)
    const cleared = await run(config, ["report", "worker-greed", "merged abc1234", "eta="])
    expect(cleared.code).toBe(0)
    expect(agentOf(cleared.roster, "worker-greed")).not.toHaveProperty("eta")
  })
})

// owner= marks the owner's own ask a session works on, which run-slot.sh ranks after the merge gates; it names the ask, never a person
describe("owner", () => {
  test.each([
    ["a word", "me"],
    ["a session name", "dispatcher"],
    ["a bare number", "12"],
    ["a Linear URL", "https://linear.app/x/issue/AB-1"],
  ])(
    "%s is refused by set, report and assign, naming the forms, and writes nothing",
    async (_case, value) => {
      for (const args of [
        ["set", "worker-greed", `owner=${value}`],
        ["report", "worker-greed", "PR opened", `owner=${value}`],
        ["assign", "worker-greed", "Export fix", "Fix the export", `owner=${value}`],
      ]) {
        const r = await run(configWith([WITH_PR]), args)
        expect(r.code).toBe(2)
        expect(r.err).toContain("owner takes the owner's ask it serves")
        expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
      }
    },
  )

  test("an Inbox item, an issue or PR, or a decision is stored, and an empty owner= clears it", async () => {
    const config = configWith([WITH_PR])
    for (const value of [
      "#i949",
      "PG-1057",
      "#1057",
      "https://github.com/acme/app/issues/3",
      "https://github.com/acme/app/pull/4",
      "d-0935",
    ]) {
      const r = await run(config, ["set", "worker-greed", `owner=${value}`])
      expect(r.code).toBe(0)
      expect(agentOf(r.roster, "worker-greed")?.owner).toBe(value)
    }
    const cleared = await run(config, ["set", "worker-greed", "owner="])
    expect(cleared.code).toBe(0)
    expect(agentOf(cleared.roster, "worker-greed")).not.toHaveProperty("owner")
  })

  test("assign clears it with the old task's pr", async () => {
    const r = await run(configWith([{ ...WITH_PR, owner: "#i949" }]), [
      "assign",
      "worker-greed",
      "New chore",
      "Do the new chore",
    ])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "worker-greed")).not.toHaveProperty("owner")
  })
})

// a parked row names what it waits on, so the sweep tells its lead once that closes
describe("hold", () => {
  test("a park with no hold is refused by set, report and assign, naming the forms, and writes nothing", async () => {
    for (const args of [
      ["set", "worker-greed", "status=parked"],
      ["report", "worker-greed", "Parked on the load hold", "status=parked"],
      ["assign", "worker-greed", "Export fix", "Fix the export", "status=parked"],
    ]) {
      const r = await run(configWith([WITH_PR]), args)
      expect(r.code).toBe(2)
      expect(r.err).toContain("add hold=#<n>, hold=#i<n> or hold=d-<n>")
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
  })

  test("a park on an issue or PR, an Inbox item or a decision is stored", async () => {
    for (const hold of ["#12", "#i5", "d-215"]) {
      const r = await run(configWith([WITH_PR]), [
        "set",
        "worker-greed",
        "status=parked",
        `hold=${hold}`,
      ])
      expect(r.code).toBe(0)
      expect(agentOf(r.roster, "worker-greed")).toMatchObject({ hold, status: "parked" })
    }
  })

  test("any other hold is refused, naming the forms, and writes nothing", async () => {
    const r = await run(configWith([WITH_PR]), ["set", "worker-greed", "status=parked", "hold=abc"])
    expect(r.code).toBe(2)
    expect(r.err).toContain(
      "hold takes #<n> (an issue or PR), #i<n> (an Inbox item) or d-<n> (a decision), not abc",
    )
    expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
  })

  test("an empty hold= on a parked row is refused, and on any other row clears it", async () => {
    const parked = { ...WITH_PR, hold: "#12", status: "parked" }
    const refused = await run(configWith([parked]), ["set", "worker-greed", "hold="])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain("add hold=#<n>, hold=#i<n> or hold=d-<n>")
    const cleared = await run(configWith([{ ...WITH_PR, hold: "#12" }]), [
      "set",
      "worker-greed",
      "hold=",
    ])
    expect(cleared.code).toBe(0)
    expect(agentOf(cleared.roster, "worker-greed")).not.toHaveProperty("hold")
  })

  test("a row parked with no hold before this check still takes a write that leaves its park alone", async () => {
    const r = await run(configWith([{ ...WITH_PR, status: "parked" }]), [
      "set",
      "worker-greed",
      "eta=",
    ])
    expect(r.code).toBe(0)
  })

  test("leaving the park drops its hold, so a later park names a fresh one", async () => {
    const r = await run(configWith([{ ...WITH_PR, hold: "#12", status: "parked" }]), [
      "set",
      "worker-greed",
      "status=working",
    ])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "worker-greed")).not.toHaveProperty("hold")
    const again = await run(configWith([{ ...WITH_PR, hold: "#12", status: "parked" }]), [
      "assign",
      "worker-greed",
      "Next chore",
      "Do the next chore",
    ])
    expect(again.code).toBe(0)
    expect(agentOf(again.roster, "worker-greed")).not.toHaveProperty("hold")
  })

  test("a hold on a row the call leaves not parked is refused naming status=parked, and stores nothing (#1102)", async () => {
    const working = await run(configWith([WITH_PR]), ["set", "worker-greed", "hold=#5"])
    expect(working.code).toBe(2)
    expect(working.err).toContain("add status=parked to the same call")
    expect(agentOf(working.roster, "worker-greed")).toEqual(WITH_PR)
    const config = configWith([{ ...WITH_PR, hold: "#12", status: "parked" }])
    const left = await run(config, ["set", "worker-greed", "status=working", "hold=#5"])
    expect(left.code).toBe(2)
    expect(left.err).toContain("add status=parked to the same call")
    expect(agentOf(left.roster, "worker-greed")).toMatchObject({ hold: "#12", status: "parked" })
  })
})

describe("assign, report and backlog", () => {
  test("assign gives a new task, clearing the old one's pr, branch, repo and report, its kind kept", async () => {
    const r = await run(configWith([WITH_PR]), [
      "assign",
      "worker-greed",
      "New chore",
      "Do the new chore",
    ])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "worker-greed")).toEqual({
      kind: "worker",
      name: "worker-greed",
      role: "worker",
      status: "working",
      task: "Do the new chore",
      title: "New chore",
    })
  })

  test("report sets lastReport and stamps lastReportAt", async () => {
    const r = await run(configWith([WITH_PR]), ["report", "worker-greed", "CI green"])
    const agent = agentOf(r.roster, "worker-greed")
    expect(agent?.lastReport).toBe("CI green")
    expect(agent?.lastReportAt).not.toBe("2026-10-01T00:00:00Z")
  })

  test("backlog appends one entry", async () => {
    const r = await run(configWith([], ["first"]), ["backlog", "Fix: second"])
    expect(r.roster?.backlog).toEqual(["first", "Fix: second"])
  })

  test("backlog-done marks one entry with its issue, the others and the length kept", async () => {
    const r = await run(configWith([], ["first", "Fix: second", "third"]), [
      "backlog-done",
      "1",
      "1402",
    ])
    expect(r.code).toBe(0)
    expect(r.roster?.backlog).toEqual(["first", "[#1402] Fix: second", "third"])
    expect(r.roster?.updatedAt).not.toBe("2026-10-01T00:00:00Z")
  })

  test("backlog-done refuses a bad index, a bad issue and a marked entry, and writes nothing", async () => {
    const backlog = ["first", "[#7] filed"]
    const config = configWith([], backlog)
    for (const [args, code, reason] of [
      [["2", "9"], 2, "takes an index from 0 to 1, not 2"],
      [["-1", "9"], 2, "takes an index from 0 to 1, not -1"],
      [["1.5", "9"], 2, "takes an index from 0 to 1, not 1.5"],
      [["x", "9"], 2, "takes an index from 0 to 1, not x"],
      [["01", "9"], 2, "takes an index from 0 to 1, not 01"],
      [["0", "0"], 2, "takes a positive issue number, not 0"],
      [["0", "#9"], 2, "takes a positive issue number, not #9"],
      [["0", "9.5"], 2, "takes a positive issue number, not 9.5"],
      [["0"], 2, "takes a positive issue number\n"],
      [["0", "9", "extra"], 2, "takes one issue number, not also extra"],
      [["1", "9"], 1, "entry 1 is already marked: [#7] filed"],
    ] as const) {
      const r = await run(config, ["backlog-done", ...args])
      expect(r.code).toBe(code)
      expect(r.err).toContain(reason)
      expect(r.roster).toMatchObject({ backlog, updatedAt: "2026-10-01T00:00:00Z" })
    }
    const empty = await run(configWith([], []), ["backlog-done", "0", "9"])
    expect([empty.code, empty.err]).toEqual([
      1,
      "roster.ts: backlog-done finds the backlog empty\n",
    ])
    for (const [args, reason] of [
      [["x", "0"], "takes a positive issue number, not 0"],
      [["0", "9", "extra"], "takes one issue number, not also extra"],
    ] as const) {
      const r = await run(configWith([], []), ["backlog-done", ...args])
      expect(r.code).toBe(2)
      expect(r.err).toContain(reason)
    }
  })

  test("backlog-done marks an entry queued with a leading [# that is no mark", async () => {
    const config = configWith([], ["[#todo] queued by hand", "[#0] zero", "[#012] padded"])
    const runs = []
    for (const at of ["0", "1", "2"]) runs.push(await run(config, ["backlog-done", at, "9"]))
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0])
    expect(runs.at(-1)?.roster?.backlog).toEqual([
      "[#9] [#todo] queued by hand",
      "[#9] [#0] zero",
      "[#9] [#012] padded",
    ])
  })
})

describe("backfill", () => {
  test("each entry with no kind takes the one its prefix gives; a set kind and any other name stay", async () => {
    const config = configWith([
      { name: "worker-greed", role: "worker", status: "working", task: "t" },
      { name: "reviewer-greed-97", role: "worker", status: "working", task: "t" },
      { name: "runner-pride", role: "runner", status: "working", task: "t" },
      { name: "probe-history", role: "worker", status: "working", task: "t" },
      { kind: "researcher", name: "worker-envy", role: "worker", status: "working", task: "t" },
      { name: "builder", role: "manager", status: "working", task: "t" },
    ])
    const r = await run(config, ["backfill"])
    expect(r.code).toBe(0)
    expect(r.roster?.agents.map((a) => [a.name, a.kind])).toEqual([
      ["worker-greed", "worker"],
      ["reviewer-greed-97", "reviewer"],
      ["runner-pride", "runner"],
      ["probe-history", "probe"],
      ["worker-envy", "researcher"],
      ["builder", undefined],
    ])
    const again = await run(config, ["backfill"])
    expect(again.roster?.agents).toEqual(r.roster?.agents ?? [])
  })
})

describe("who", () => {
  test("prints the live entry of a manager kind, else its sessions.names name, and writes nothing", async () => {
    const config = configWith([
      { name: "builder", role: "manager", status: "working", task: "t" },
      { kind: "builder", name: "x7mh4d-builder", role: "manager", status: "working", task: "t" },
    ])
    const builder = await run(config, ["who", "builder"])
    expect([builder.code, builder.out]).toEqual([0, "x7mh4d-builder\n"])
    expect(builder.roster?.updatedAt).toBe("2026-10-01T00:00:00Z")
    const ops = await run(config, ["who", "ops"])
    expect([ops.code, ops.out]).toEqual([0, "ops\n"])
    const none = await run(configWith(null), ["who", "planner"])
    expect([none.code, none.out, none.roster]).toEqual([0, "planner\n", null])
  })

  test("who dispatcher prints the primary's live name, and who dispatcher 2 the second's", async () => {
    const config = configWith([
      { kind: "dispatcher", name: "dispatcher", role: "manager", status: "working", task: "t" },
      {
        kind: "dispatcher",
        name: "q8r2tx-dispatcher",
        role: "manager",
        slot: "2",
        status: "working",
        task: "t",
      },
    ])
    const alpha = await run(config, ["who", "dispatcher"])
    expect([alpha.code, alpha.out]).toEqual([0, "dispatcher\n"])
    const bravo = await run(config, ["who", "dispatcher", "2"])
    expect([bravo.code, bravo.out]).toEqual([0, "q8r2tx-dispatcher\n"])
    const none = await run(configWith(null), ["who", "dispatcher", "2"])
    expect([none.code, none.out]).toEqual([0, "dispatcher-2\n"])
  })

  test("who takes a slot for the dispatcher alone, and only 1 or 2", async () => {
    for (const argv of [
      ["who", "dispatcher", "3"],
      ["who", "dispatcher", "Bravo"],
      ["who", "builder", "2"],
    ]) {
      const r = await run(configWith([]), argv)
      expect(r.code).toBe(2)
      expect(r.out).toBe("")
    }
  })

  // #779: ops-dm-watch hands an unanswered DM to whoever holds the assistant seat, so the Assistant takes it under any name
  test("who assistant prints the live entry the roster gives the assistant kind, and with none exits 1 printing nothing", async () => {
    const config = configWith([
      { kind: "assistant", name: "k3m9px-worker", role: "worker", status: "working", task: "t" },
    ])
    const held = await run(config, ["who", "assistant"])
    expect([held.code, held.out]).toEqual([0, "k3m9px-worker\n"])
    const none = await run(configWith([]), ["who", "assistant"])
    expect([none.code, none.out]).toEqual([1, ""])
    expect(none.err).toContain("no live session holds the assistant seat")
    const set = await run(configWith([]), ["set", "x7mh4d-worker", "kind=assistant", "task=t"])
    expect(set.code, set.err).toBe(0)
    expect(agentOf(set.roster, "x7mh4d-worker")?.role).toBe("manager")
  })

  test("refuses a kind that is not a manager's", async () => {
    const r = await run(configWith([]), ["who", "worker"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("planner, builder, ops, optimizer, dispatcher")
    expect(r.out).toBe("")
  })
})

test("an unknown command prints the usage and writes nothing", async () => {
  const config = configWith([WITH_PR])
  const r = await run(config, ["frob", "x"])
  expect(r.code).toBe(2)
  expect(r.err.trim()).toBe(USAGE)
  expect(r.roster?.updatedAt).toBe("2026-10-01T00:00:00Z")
})

describe("name", () => {
  test("a name outside spawn.sh's word shape is refused on set, report and assign, naming it, and writes nothing", async () => {
    const config = configWith([WITH_PR])
    for (const args of [
      ["set", "worker-rail-slot 2026-10-20T14:30:00Z", "eta="],
      ["report", "worker:greed", "hello"],
      ["assign", "worker/greed", "Title", "Do it"],
      ["set", "k3m9px_worker", "task=t"],
      ["set", "--help", "task=t"],
    ]) {
      const r = await run(config, args)
      expect(r.code).toBe(2)
      expect(r.err).toContain("lowercase words joined by hyphens")
      expect(r.err).toContain(args[1]!)
      expect(r.roster).toMatchObject({ agents: [WITH_PR], updatedAt: "2026-10-01T00:00:00Z" })
    }
  })

  test("an ordinary session name still passes", async () => {
    const r = await run(configWith([]), ["set", "k3m9px-worker", "task=t"])
    expect(r.code).toBe(0)
    expect(agentOf(r.roster, "k3m9px-worker")).toMatchObject({ name: "k3m9px-worker" })
  })
})
