import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { herdrCalls, herdrPin, lw, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them.
setDefaultTimeout(40_000)

const SID = "aaaaaaaa-0000-4000-8000-0000000000a1"

// A probe spawn.sh opened on the probes server: its resume record names the server, and the stub herdr lists a pane under each label given.
const opened =
  (labels = ["probe-far"], record = "#!/bin/bash\n# server: playground-probes\nexec x\n") =>
  (home: string) => {
    herdrPin()(home)
    mkdirSync(lw(home, "resume"), { recursive: true })
    if (record) writeFileSync(lw(home, "resume", "probe-far.sh"), record)
    const panes = labels.map((label, i) => ({ label, pane_id: `w3:p${i + 1}`, workspace_id: "w3" }))
    writeFileSync(join(home, "herdr.panes"), JSON.stringify({ result: { panes } }))
  }
const writes = (r: { home: string }) =>
  herdrCalls(r).filter(
    (c) => !["--version", "status"].includes(c[0] ?? "") && c[1] !== "list" && c[1] !== "read",
  )

describe("spawn.sh read prints a pane spawn.sh opened, on its own server", () => {
  test("it reads the one pane under the name on the server its record names, and writes nothing", async () => {
    const r = await spawn(
      ["read", "probe-far"],
      [],
      { FAKE_PANE_TEXT: "claude: Refusing to start" },
      undefined,
      undefined,
      opened(),
    )
    expect(r.code).toBe(0)
    expect(r.out).toBe("claude: Refusing to start\n")
    expect(herdrCalls(r).at(-1)).toEqual([
      "pane",
      "read",
      "w3:p1",
      "--source",
      "recent-unwrapped",
      "--lines",
      "200",
    ])
    expect(readFileSync(join(r.home, "herdr.env"), "utf8")).toBe(
      `playground-probes ${lw(r.home, "herdr", "playground-probes.sock")} ${lw(r.home, "herdr", "config.toml")}\n`,
    )
    expect(writes(r)).toEqual([])
    expect(r.rosterLog).toBeUndefined()
  })

  test.each([
    ["no resume record", opened(["probe-far"], ""), "it has no resume record"],
    [
      "no pane under the name",
      opened(["probe-other"]),
      "no pane on the herdr server playground-probes carries the label probe-far, so spawn.sh opened none it can read",
    ],
    [
      "two panes under the name",
      opened(["probe-far", "probe-far"]),
      "2 panes on the herdr server playground-probes carry the label probe-far, so it cannot tell which one spawn.sh opened; name the session id of the one to read",
    ],
  ])("it refuses %s, reading no pane", async (_, setup, says) => {
    const r = await spawn(["read", "probe-far"], [], {}, undefined, undefined, setup)
    expect(r.code).toBe(1)
    expect(r.err).toContain(`spawn.sh refuses probe-far: ${says}`)
    expect(herdrCalls(r).some((c) => c[1] === "read")).toBe(false)
  })

  test.each([
    ["no name", ["read"]],
    ["a third word", ["read", "probe-far", SID, "x"]],
    ["--check", ["read", "probe-far", "--check"]],
    ["--harness", ["read", "probe-far", "--harness", "codex"]],
    ["--priority", ["read", "probe-far", "--priority"]],
  ])("it takes a name and a session id alone: %s", async (_, args) => {
    const r = await spawn(args, [], {}, undefined, undefined, opened())
    expect(r.code).toBe(2)
    expect(r.err).toContain(
      "read takes a session's name, and its session id to pick one of two panes under the name",
    )
  })
})
