import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  BRIEF_TEXT,
  herdrCalls,
  homes,
  launchAfterRm,
  launchOf,
  placing,
  root,
  scratch,
  spawn,
  unplugged,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("--brief gives a resumed session its first prompt", () => {
  const id = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"
  const brief = "handoffs/restart-brief.md"
  const command = launchAfterRm

  test.each([
    ["after the words", ["resume", "dispatcher", root, id, "--brief", brief]],
    ["before the mode", ["--brief", brief, "resume", "dispatcher", root, id]],
  ])("%s: the prompt names the file, and the session reads it", async (_, args) => {
    const r = await spawn(args, [], { BRIEF_FILE: brief }, undefined, {
      name: "dispatcher",
      backend: "claude",
    })
    expect(r.code).toBe(0)
    const home = join(scratch, `home-${homes}`)
    expect(unplugged(command(r))).toBe(
      `(env PLAYGROUND_ROLE=dispatcher claude --resume ${id} -n dispatcher --model claude-opus-5-5 --effort high --settings ${home}/.playground/factory-settings-400k-memory-dispatcher.json --dangerously-skip-permissions "You are dispatcher, resumed. Load the playbook skill first. Your brief is in ~/.playground/${brief}: read it in full and follow it.")`,
    )
    expect(command(r)).not.toContain("--brief")
    const seen = [...placing(r).flat(), ...(r.roster ?? []), r.out, r.err].join("\n")
    expect(seen).not.toContain(BRIEF_TEXT)
  })

  // a session idle at the restart takes no turn, so it never acts on after-resume's context until a prompt reaches it
  test("with no --brief a resume still takes one turn, so it acts on after-resume's instruction", async () => {
    const r = await spawn(
      ["resume", "dispatcher", root, id],
      [],
      { BRIEF_FILE: brief },
      undefined,
      {
        name: "dispatcher",
        backend: "claude",
      },
    )
    const home = join(scratch, `home-${homes}`)
    expect(unplugged(command(r))).toBe(
      `(env PLAYGROUND_ROLE=dispatcher claude --resume ${id} -n dispatcher --model claude-opus-5-5 --effort high --settings ${home}/.playground/factory-settings-400k-memory-dispatcher.json --dangerously-skip-permissions "You are dispatcher, resumed after a restart. Act on the after-resume instruction in your context first, then carry on.")`,
    )
  })

  test.each([
    ["a space", "b c.md"],
    ["a quote", 'b"c.md'],
    ["a dollar", "$(id).md"],
    ["a parent folder", "../brief.md"],
    ["a parent folder inside it", "handoffs/../../brief.md"],
    ["a parent folder at its end", "handoffs/.."],
  ])("a brief with %s is refused before herdr", async (_, bad) => {
    const r = await spawn(["resume", "dispatcher", root, id, "--brief", bad], [], {
      BRIEF_FILE: brief,
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain("a brief is a file name under ~/.playground")
    expect(placing(r)).toEqual([])
  })

  test("a brief that is not there is refused before herdr", async () => {
    const r = await spawn(["resume", "dispatcher", root, id, "--brief", "handoffs/missing.md"], [])
    expect(r.code).toBe(1)
    expect(r.err).toContain("~/.playground/handoffs/missing.md is not a file")
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["given twice", ["resume", "dispatcher", root, id, "--brief", brief, "--brief", brief]],
    ["with no file after it", ["resume", "dispatcher", root, id, "--brief"]],
    ["with an empty file", ["resume", "dispatcher", root, id, "--brief", ""]],
  ])("--brief %s is refused", async (_, args) => {
    const r = await spawn(args, [], { BRIEF_FILE: brief })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["worker", ["worker", "worker-brave-otter", "b.md", "--brief", brief]],
    ["runner", ["runner", "runner-calm-heron", "b.md", "--brief", brief]],
    ["column", ["column", "lead", "planner", "dispatcher", "w1:p2", "h.md", "--brief", brief]],
  ])("--brief with %s, which takes its brief as a word, is refused", async (_, args) => {
    const r = await spawn(args, [], { BRIEF_FILE: brief })
    expect(r.code).toBe(1)
    expect(r.err).toContain("--brief is for resume")
    expect(placing(r)).toEqual([])
  })
})

describe("--reports-to names the session a worker reports to (#1727)", () => {
  test.each([["worker", "worker-brave-otter"]])(
    "a %s with --reports-to planner reports to planner",
    async (mode, name) => {
      const r = await spawn([mode, name, "--reports-to", "planner", "b.md"], [])
      expect(r.code).toBe(0)
      expect(launchOf(r)).toContain("you report to planner.")
      expect(launchOf(r)).toContain("Report to planner with SendMessage (to: planner).")
      expect(r.roster).toContain("reportsTo=planner")
    },
  )

  test("a value that is not a session name is refused", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--reports-to", "Bad Name"], [])
    expect(r.code).toBe(1)
    expect(r.err).toContain("it reports to a session name, not Bad Name")
    expect(placing(r)).toEqual([])
  })

  test("given twice it is usage", async () => {
    const r = await spawn(
      [
        "worker",
        "worker-brave-otter",
        "b.md",
        "--reports-to",
        "planner",
        "--reports-to",
        "builder",
      ],
      [],
    )
    expect(r.code).toBe(2)
    expect(r.err).toContain("--reports-to takes a session name, once")
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["runner", ["runner", "runner-calm-heron", "b.md"]],
    [
      "column",
      ["column", "reviewer", "reviewer-brave-otter", "builder", "w1:p2", "b.md", "--pr", "1"],
    ],
    ["probe", ["probe", "probe-x", "ops", "b.md", "--runtime", "herdr"]],
    ["manager", ["manager", "dispatcher-2", "b.md"]],
    ["resume", ["resume", "worker-brave-otter", "/tmp"]],
    ["restore", ["restore"]],
    ["close", ["close", "worker-brave-otter"]],
  ])("a %s refuses it", async (_, args) => {
    const r = await spawn([...args, "--reports-to", "planner"], [])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--reports-to is for a worker")
    expect(placing(r)).toEqual([])
  })
})

describe("--check runs the gates and starts nothing", () => {
  test("a start that would pass prints ok and touches neither herdr nor the roster", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "brief-x.md", "--check"], [])
    expect(r.code).toBe(0)
    expect(r.out).toContain("ok: worker-brave-otter can start")
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
  })

  test("the name a live session holds passes, since the switch closes it next", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "brief-x.md", "--check"],
      [{ name: "worker-brave-otter", pid: 5002 }],
    )
    expect(r.code).toBe(0)
    expect(placing(r)).toEqual([])
  })

  test("a column beside a herdr pane checks herdr, opening nothing", async () => {
    const r = await spawn(
      ["column", "lead", "planner", "dispatcher", "w1:p2", "handoff.md", "--check"],
      [],
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain("ok: planner can start")
    expect(herdrCalls(r).map((c) => c[0])).toEqual(["--version", "status"])
    expect(placing(r)).toEqual([])
  })

  test("a column beside an old cmux surface:1 refuses as no herdr pane id", async () => {
    const r = await spawn(
      ["column", "lead", "planner", "dispatcher", "surface:1", "handoff.md", "--check"],
      [],
    )
    expect(r.code).toBe(1)
    expect(r.out).not.toContain("can start")
    expect(r.err).toContain("surface:1 is not a herdr pane id (w1:p2)")
    expect(r.cmux).toBeUndefined()
  })

  test("a gate that refuses still refuses", async () => {
    // an unreadable usage.json refuses; a missing one, never written yet, passes
    const r = await spawn(["worker", "worker-brave-otter", "brief-x.md", "--check"], [], {
      USAGE_JSON: "{ nope",
    })
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain("can start")
  })
})

describe("a brief still holding its role's template slot is refused before herdr", () => {
  const template = (role: string) =>
    readFileSync(join(root, "scripts", "briefs", `new-${role}.md`), "utf8")
  const slotsOf = (role: string) => [...new Set(template(role).match(/__[A-Z0-9]+__/g))].sort()
  const column = (role: string) => [
    "--pr",
    "1",
    "column",
    role,
    `${role}-brave-otter`,
    "worker-x",
    "w1:p2",
    "r.md",
  ]
  const holding = (text: string) => (home: string) =>
    writeFileSync(join(home, ".playground", "r.md"), text)

  test("each checker template holds slots to check against", () => {
    expect(slotsOf("reviewer")).toContain("__SPEC__")
    expect(slotsOf("tester")).toContain("__NAME__")
  })

  test.each(
    ["reviewer", "tester"].flatMap((role) => slotsOf(role).map((slot) => [role, slot] as const)),
  )("a %s's brief with %s left is refused, naming it and the brief", async (role, slot) => {
    const r = await spawn(
      column(role),
      [],
      {},
      undefined,
      undefined,
      holding(`## This PR\n\n\`${slot}\`\n`),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`~/.playground/r.md still holds the slot ${slot}`)
    expect(placing(r)).toEqual([])
  })

  test.each(["reviewer", "tester"])(
    "the %s template copied unfilled is refused, naming each of its slots",
    async (role) => {
      const r = await spawn(column(role), [], {}, undefined, undefined, holding(template(role)))
      expect(r.code).toBe(1)
      expect(r.err).toContain(`still holds the slot ${slotsOf(role).join(" ")}:`)
      expect(placing(r)).toEqual([])
    },
  )

  test.each(["reviewer", "tester"])(
    "the %s template with every slot filled starts",
    async (role) => {
      const text = template(role).replace(/`?__[A-Z0-9]+__`?/g, "filled")
      const r = await spawn(column(role), [], {}, undefined, undefined, holding(text))
      expect(r.code).toBe(0)
      expect(placing(r)).not.toEqual([])
    },
  )

  test.each([
    [
      "a slot spelled in words",
      "Leave no slot (two underscores, SPEC, two underscores) unfilled.\n",
    ],
    ["a word no template holds as a slot", "Set `__FOO__` in the config.\n"],
    ["the tester template's slot", "Your tester's brief fills `__SHA7__`.\n"],
  ])("a reviewer's brief naming %s starts", async (_, text) => {
    const r = await spawn(column("reviewer"), [], {}, undefined, undefined, holding(text))
    expect(r.code).toBe(0)
  })

  test("a worker's brief telling it to fill its reviewer's slot starts", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "r.md"],
      [],
      {},
      undefined,
      undefined,
      holding("Give the PR to your reviewer with the `__SPEC__` slot filled.\n"),
    )
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
  })

  test("a reviewer's resume with a --brief holding its slot is refused", async () => {
    const id = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"
    const r = await spawn(
      ["resume", "reviewer-brave-otter", root, id, "--brief", "r.md", "--pr", "1"],
      [],
      { BRIEF_FILE: "r.md" },
      undefined,
      { name: "reviewer-brave-otter", backend: "claude" },
      holding("`__WORKER__`\n"),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("~/.playground/r.md still holds the slot __WORKER__")
    expect(placing(r)).toEqual([])
  })
})
