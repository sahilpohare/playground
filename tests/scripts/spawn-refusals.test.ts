import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { OLD } from "../session-names"
import { pidStat } from "./fixtures/proc"
import { launchAfterRm, launchOf, LSTART, placing, root, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("a name a live session holds is refused, so no session starts under a generated name", () => {
  const lead = ["column", "lead", OLD.planner, OLD.dispatcher, "w1:p2", "handoff.md"]

  test(`a live ${OLD.planner} refuses its successor, naming the live session`, async () => {
    const r = await spawn(lead, [{ name: OLD.planner, pid: 5000 }])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain(`a live session already holds the name ${OLD.planner} (pid 5000)`)
    expect(r.err).toContain("close it first")
  })

  test("a live session refuses a resume under its name too", async () => {
    const r = await spawn(
      ["resume", "worker-brave-otter", root],
      [{ name: "worker-brave-otter", pid: 5001 }],
    )
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
  })

  test("an ended session, its pid gone or reused, frees its name", async () => {
    const gone = await spawn(lead, [{ name: OLD.planner, pid: 5002 }], { FAKE_DEAD: "5002" })
    expect(gone.code).toBe(0)
    const reused = await spawn(lead, [
      { name: OLD.planner, pid: 5003, procStart: "Mon Oct 12 01:00:00 2026" },
    ])
    expect(reused.code).toBe(0)
  })

  // Claude Code on Linux records procStart as clock ticks since boot, field 22 of /proc/<pid>/stat.
  test("a Linux session holds its name while /proc gives its pid the start its file records, and frees it once the pid started at another", async () => {
    const linux = [{ name: OLD.planner, pid: 5006, procStart: "1801742" }]
    const proc = (ticks: string) => (home: string) => {
      mkdirSync(join(home, "proc", "5006"), { recursive: true })
      writeFileSync(join(home, "proc", "5006", "stat"), pidStat(5006, ticks))
    }
    const env = { PLAYGROUND_PROC: "{home}/proc" }
    const live = await spawn(lead, linux, env, undefined, undefined, proc("1801742"))
    expect(live.err).toContain(`a live session already holds the name ${OLD.planner} (pid 5006)`)
    const reused = await spawn(lead, linux, env, undefined, undefined, proc("2900000"))
    expect(reused.code).toBe(0)
  })

  test("another live session's name does not block it", async () => {
    const r = await spawn(lead, [{ name: `${OLD.planner}-reactive-penguin`, pid: 5004 }])
    expect(r.code).toBe(0)
  })

  // Claude Code 2.1.302 writes a registry file for a `claude -p` run too, its entrypoint sdk-cli where an interactive session's reads cli.
  test("a claude -p run under the name does not block it, while an interactive or Agent SDK session does", async () => {
    const run = (entrypoint: string) => ({
      pid: 5005,
      raw: JSON.stringify({
        entrypoint,
        kind: "interactive",
        name: OLD.planner,
        procStart: LSTART,
      }),
    })
    expect((await spawn(lead, [run("sdk-cli")])).code).toBe(0)
    for (const entrypoint of ["cli", "sdk-ts"]) {
      const live = await spawn(lead, [run(entrypoint)])
      expect(live.err).toContain(`a live session already holds the name ${OLD.planner} (pid 5005)`)
    }
  })
})

describe("a session starts the same on any Mac", () => {
  const command = launchAfterRm

  test("every launch passes the factory's bypass itself, never relying on the machine's settings", async () => {
    const worker = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(command(worker)).toContain(" --dangerously-skip-permissions ")
    const checker = await spawn(
      ["column", "tester", "tester-x", "worker-x", "w1:p2", "b.md", "--pr", "1"],
      [],
    )
    expect(command(checker)).toContain(" --dangerously-skip-permissions ")
    const resume = await spawn(["resume", "worker-brave-otter", root], [], {}, undefined, {
      name: "worker-brave-otter",
      backend: "claude",
    })
    expect(command(resume)).toContain(" --dangerously-skip-permissions ")
  })

  test("with no inscope config dir the launch keeps the environment as it is", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      INSCOPE_HOOK: 'export GITHUB_TOKEN="$tok"',
    })
    expect(command(r)).toStartWith("(env PLAYGROUND_ROLE=worker claude ")
  })

  test.each([
    [
      "an inscope hook that exports a config dir",
      { INSCOPE_HOOK: 'export CLAUDE_CONFIG_DIR="$ccd"' },
    ],
    ["inscope's config dir in the environment", { INSCOPE_CCD: "/work/.claude" }],
  ])("with %s the launch drops it, so the session starts logged in", async (_, env) => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], env)
    expect(r.code).toBe(0)
    expect(command(r)).toStartWith(
      "(env -u CLAUDE_CONFIG_DIR -u INSCOPE_CCD PLAYGROUND_ROLE=worker claude ",
    )
  })

  test("with inscope, the live-name check reads the sessions under ~/.claude, where its launches run", async () => {
    const env = { CLAUDE_CONFIG_DIR: "/no/such/inscope/dir", INSCOPE_CCD: "/no/such/inscope/dir" }
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [{ name: "worker-brave-otter", pid: 1000 }],
      env,
    )
    expect(r.err).toContain("a live session already holds the name worker-brave-otter")
  })

  test("the roster write runs this checkout's roster.ts, set alone, keeping a successor's work", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.rosterScript).toBe(join(root, "scripts", "roster.ts"))
    expect(r.rosterLog).toEqual([
      "set worker-brave-otter kind=worker reportsTo=builder surface= title=Plain test work task=b.md memory=off",
    ])
  })

  test("a roster failure shows roster.ts's own words", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_ROSTER_BROKEN: "1" })
    expect(r.rosterLog?.length).toBe(1)
    expect(r.err).toContain("roster.ts says: roster broken")
    expect(r.err).toContain("worker-brave-otter started, but its roster write failed")
  })
})

describe("a worker's prompt names brief-rush.md only while that file exists (#1465)", () => {
  const rush = " ~/.playground/brief-rush.md binds you too, on this Claude lane."

  test("with the file a worker is told it binds it, without it the line is left out", async () => {
    const present = await spawn(["worker", "worker-brave-otter", "b.md"], [], { RUSH: "1" })
    expect(launchOf(present)).toContain(`read it in full and follow it.${rush} Report to builder`)
    const absent = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(launchOf(absent)).toContain("read it in full and follow it. Report to builder")
    expect(launchOf(absent)).not.toContain("brief-rush.md")
  })

  test("a GLM worker is never told, since the rush is a Claude lane's", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--backend", "glm"], [], {
      RUSH: "1",
    })
    expect(launchOf(r)).toContain("read it in full and follow it.")
    expect(launchOf(r)).not.toContain("brief-rush.md")
  })

  test("a checker is never told, file or not", async () => {
    const r = await spawn(
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "b.md", "--pr", "1"],
      [],
      {
        RUSH: "1",
      },
    )
    expect(launchOf(r)).toContain("read it in full and follow it.")
    expect(launchOf(r)).not.toContain("brief-rush.md")
  })
})

describe("it fails closed when it cannot read the machine", () => {
  // A missing registry is a Mac that never ran a session, which holds none (spawn.test.ts), so the registry case makes the path one it cannot list.
  const unlistable = (home: string) => {
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude", "sessions"), "")
  }
  test.each([
    ["a session registry it cannot list", { NO_REGISTRY: "1" }],
    ...(process.platform === "darwin"
      ? []
      : [["neither ps nor a kernel process table off macOS can be read", { FAKE_PS_BROKEN: "1" }]]),
    ["the load cannot be read", { FAKE_SYSCTL_BROKEN: "1", FAKE_UPTIME_BROKEN: "1" }],
  ] as [string, Record<string, string>][])("%s", async (_name, env) => {
    const setup = "NO_REGISTRY" in env ? unlistable : undefined
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      env,
      undefined,
      undefined,
      setup,
    )
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("spawn.sh refuses")
  })
})

describe("it refuses what it cannot spawn safely", () => {
  test.each([
    ["no mode", []],
    ["an unknown mode", ["launch", "worker-a", "b.md"]],
    ["a worker whose name reads as another kind", ["worker", "k3m9px-reviewer", "b.md"]],
    ["a worker under a manager's name", ["worker", OLD.builder, "b.md"]],
    [
      "another model, since every session runs on Opus",
      ["worker", "worker-a", "b.md", "claude-sonnet-5-5"],
    ],
    ["a name with a quote", ["worker", 'worker-a"b', "b.md"]],
    ["a brief with a space", ["worker", "worker-a", "b c.md"]],
    [
      "a checker whose name is not its role's",
      ["column", "reviewer", "tester-x", "worker-x", "w1:p2", "b.md", "--pr", "1"],
    ],
    [
      "a column role it does not know",
      ["column", "worker", "worker-x", OLD.builder, "w1:p2", "b.md"],
    ],
    [
      "a surface that is not one",
      ["column", "tester", "tester-x", "worker-x", "7", "b.md", "--pr", "1"],
    ],
    ["a resume into a folder that is not there", ["resume", "worker-x", "/no/such/dir"]],
    ["a resume of a session outside the factory", ["resume", "my-notes", "/tmp"]],
    ["a resume of an id that is not one", ["resume", "worker-x", "/tmp", "x;y"]],
  ])("%s", async (_name, args) => {
    const r = await spawn(args, [])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
  })
})

describe("a flag value that starts with -- is refused", () => {
  test.each([
    ["--account", ["worker", "worker-a", "b.md", "--account", "--backend"]],
    ["--backend", ["worker", "worker-a", "b.md", "--backend", "--brief"]],
    [
      "--brief",
      [
        "resume",
        OLD.dispatcher,
        root,
        "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27",
        "--brief",
        "--account",
      ],
    ],
  ])("%s names itself in the refusal", async (flag, args) => {
    const r = await spawn(args, [])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(`${flag} needs a value;`)
    expect(r.err).toContain(`starts with --`)
  })
})
