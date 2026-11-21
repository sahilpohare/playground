import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { OLD } from "../session-names"
import { pidStat } from "./fixtures/proc"
import { execLine, herdrPin, lw, placing, root, spawn, transcript } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them.
setDefaultTimeout(40_000)

const SID = "a1b2c3d4-0000-4000-8000-0000000000a1"
const OTHER = "a1b2c3d4-0000-4000-8000-0000000000a2"
const pin = { name: "worker-x", backend: "claude" }
const rowed = (row: object) => ({
  ROSTER_JSON: JSON.stringify({
    agents: [{ name: "worker-x", role: "worker", task: "t", ...row }],
  }),
})

describe("a resume leaves a finished session down unless --force", () => {
  const resume = ["resume", "worker-x", root, SID]

  test.each([
    [
      "ended by auto-end",
      { endReason: "worker-prs-done", status: "ended" },
      "ended (endReason worker-prs-done)",
    ],
    ["marked done", { endReason: "done", status: "done" }, "done (endReason done)"],
    ["marked done before rows took a reason", { status: "done" }, "done (endReason none)"],
  ])("a row %s is refused, naming its reason and --force", async (_, row, says) => {
    const r = await spawn(resume, [], rowed(row), undefined, pin)
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `spawn.sh refuses worker-x: its roster row reads ${says}, so it stays down: add --force to bring it back on purpose`,
    )
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["an auto-ended row", { endReason: "worker-prs-done", status: "ended" }],
    ["a done row", { endReason: "done", status: "done" }],
  ])("--force brings %s back, set to starting", async (_, row) => {
    const r = await spawn([...resume, "--force"], [], rowed(row), undefined, pin)
    expect(r.code).toBe(0)
    expect(r.roster).toContain("status=starting")
  })

  test("a row a plain close ended, with no reason, resumes as an account move does", async () => {
    const r = await spawn(resume, [], rowed({ status: "ended" }), undefined, pin)
    expect(r.code).toBe(0)
    expect(r.roster).toContain("status=starting")
  })

  test("--force is for a resume alone", async () => {
    const r = await spawn(["worker", "worker-x", "b.md", "--force"], [])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--force is for a resume, not worker")
  })
})

describe("a checker's resume record names its PRs", () => {
  const PR = "https://github.com/acme/factory/pull/7"
  test("a reviewer's column start writes its --pr on the exec line", async () => {
    const r = await spawn(
      ["column", "reviewer", "reviewer-x", "worker-y", "w1:p2", "b.md", "--pr", PR],
      [],
      {
        ROSTER_JSON: JSON.stringify({
          agents: [{ kind: "worker", name: "worker-y", status: "working", task: "t", title: "W" }],
        }),
      },
    )
    expect(r.code).toBe(0)
    expect(execLine(r, "reviewer-x")).toEndWith(` --pr ${PR}`)
  })

  test("restore runs a record's --pr as written when the row serves none, and the row's PRs in its place when it does", async () => {
    const served = "https://github.com/acme/factory/pull/8"
    const r = await spawn(
      ["restore"],
      [],
      {
        ROSTER_JSON: JSON.stringify({
          agents: [
            { kind: "reviewer", name: "reviewer-a", status: "working", task: "t" },
            { kind: "reviewer", name: "reviewer-b", pr: served, status: "working", task: "t" },
          ],
        }),
      },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        for (const dir of ["resume", "runtimes", "backends"])
          mkdirSync(lw(home, dir), { recursive: true })
        for (const [name, sid] of [
          ["reviewer-a", SID],
          ["reviewer-b", OTHER],
        ] as const) {
          writeFileSync(
            lw(home, "resume", `${name}.sh`),
            `#!/bin/bash\nexec /x/scripts/spawn.sh resume ${name} ${root} ${sid} --pr ${PR}\n`,
          )
          writeFileSync(lw(home, "runtimes", name), "herdr\n")
          writeFileSync(lw(home, "backends", name), "claude\n")
          transcript(home, sid)
        }
      },
    )
    expect(r.out).toBe("restored reviewer-a\nrestored reviewer-b\n")
    expect(execLine(r, "reviewer-a")).toEndWith(` --pr ${PR}`)
    expect(execLine(r, "reviewer-b")).toEndWith(` --pr ${served}`)
  })
})

describe("a manager's start under a live name", () => {
  const dispatcher = ["manager", OLD.dispatcher, "brief-dispatcher.md"]
  // Claude Code on Linux records procStart as clock ticks since boot, field 22 of /proc/<pid>/stat (#2310).
  const liveOnLinux = (home: string) => {
    mkdirSync(join(home, "proc", "4200"), { recursive: true })
    writeFileSync(join(home, "proc", "4200", "stat"), pidStat(4200, "1801742"))
    mkdirSync(lw(home, "resume"), { recursive: true })
    writeFileSync(
      lw(home, "resume", `${OLD.dispatcher}.sh`),
      `#!/bin/bash\nexec x resume ${OLD.dispatcher} ${root} ${SID}\n`,
    )
  }

  test("the first dispatcher's start is refused while a Linux session holds the name, and the live one's record stays as it was", async () => {
    const r = await spawn(
      dispatcher,
      [{ name: OLD.dispatcher, pid: 4200, procStart: "1801742" }],
      { PLAYGROUND_PROC: "{home}/proc" },
      undefined,
      undefined,
      liveOnLinux,
    )
    expect(r.code).toBe(3)
    expect(r.err).toContain(`a live session already holds the name ${OLD.dispatcher} (pid 4200)`)
    expect(placing(r)).toEqual([])
    expect(readFileSync(lw(r.home, "resume", `${OLD.dispatcher}.sh`), "utf8")).toBe(
      `#!/bin/bash\nexec x resume ${OLD.dispatcher} ${root} ${SID}\n`,
    )
  })
})

describe("close by session id", () => {
  // two panes under the name, each running its own claude, whose registry file names its session
  const twoPanes =
    (labels = ["worker-x", "worker-x"]) =>
    (home: string) => {
      herdrPin()(home)
      for (const dir of ["resume", "runtimes"]) mkdirSync(lw(home, dir), { recursive: true })
      writeFileSync(lw(home, "runtimes", "worker-x"), "herdr\n")
      writeFileSync(lw(home, "resume", "worker-x.sh"), `#!/bin/bash\n# server: factory\nexec x\n`)
      const panes = labels.map((label, i) => ({
        label,
        pane_id: `w2:p${i + 3}`,
        workspace_id: "w2",
      }))
      writeFileSync(join(home, "herdr.panes"), JSON.stringify({ result: { panes } }))
      mkdirSync(join(home, "herdr.process"), { recursive: true })
      for (const [i, sid] of [SID, OTHER].entries()) {
        const pid = 6100 + i
        writeFileSync(
          join(home, "herdr.process", `w2:p${i + 3}`),
          JSON.stringify({
            result: {
              process_info: {
                foreground_processes: [
                  { argv: ["bash", "launch.sh"], name: "bash", pid: 6000 + i },
                  { argv: ["claude", "--resume", sid], name: "claude", pid },
                ],
              },
            },
          }),
        )
        writeFileSync(
          join(home, ".claude", "sessions", `${pid}.json`),
          JSON.stringify({ name: "worker-x", pid, sessionId: sid }),
        )
      }
    }
  const closes = (r: { home: string }) => placing(r).filter((c) => c[1] === "close")

  test("of two panes under the name, it closes the one running that session and leaves the row and close time to the other", async () => {
    const r = await spawn(["close", "worker-x", OTHER], [], {}, undefined, undefined, twoPanes())
    expect(r.code).toBe(0)
    expect(closes(r)).toEqual([["pane", "close", "w2:p4"]])
    expect(r.rosterLog).toBeUndefined()
    expect(existsSync(lw(r.home, "closes", "worker-x"))).toBe(false)
  })

  test("the one pane under the name closes by its id as by its name, its row ended", async () => {
    const r = await spawn(
      ["close", "worker-x", SID],
      [],
      {},
      undefined,
      undefined,
      twoPanes(["worker-x", "worker-y"]),
    )
    expect(r.code).toBe(0)
    expect(closes(r)).toEqual([["pane", "close", "w2:p3"]])
    expect(r.rosterLog).toEqual(["set worker-x status=ended"])
  })

  test.each([
    [
      "an id no labelled pane runs",
      ["close", "worker-x", "a1b2c3d4-0000-4000-8000-0000000000ff"],
      "runs session",
    ],
    ["a word that is no session id", ["close", "worker-x", "nope"], "nope is not a session id"],
    ["two panes and no id", ["close", "worker-x"], "name the session id of the one to close"],
  ])("%s is refused, nothing closed", async (_, args, says) => {
    const r = await spawn(args, [], {}, undefined, undefined, twoPanes())
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(says)
    expect(closes(r)).toEqual([])
  })
})
