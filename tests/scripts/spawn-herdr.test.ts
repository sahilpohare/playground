import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { OLD } from "../session-names"
import { storeWith } from "./hooks/render-set"
import {
  bin,
  BRIEF_AT,
  execLine,
  herdrPin,
  launchOf,
  lw,
  opened,
  placing,
  resumeFile,
  root,
  scratch,
  SID,
  spawn,
  TOKEN,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// OLD.dispatcher: "spawn.sh must refuse a missing brief in every start mode, not only on resume."
describe("a start refuses a brief that is not a file (#1471)", () => {
  // Every row carries a setup, since test.each hands a shorter row's callback a done function in its place.
  const none = () => {}
  const STARTS: [string, string[], string, (home: string) => void][] = [
    ["worker", ["worker", "worker-brave-otter", "brief-x.md"], "worker-brave-otter", none],
    ["runner", ["runner", "runner-calm-heron", "brief-r.md"], "runner-calm-heron", none],
    [
      "column",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "handoffs/rev.md", "--pr", "1"],
      "reviewer-x",
      none,
    ],
    [
      "manager",
      ["manager", `${OLD.dispatcher}-2`, `brief-${OLD.dispatcher}-2.md`, "--backend", "glm"],
      `${OLD.dispatcher}-2`,
      none,
    ],
    [
      "probe",
      ["probe", "probe-herdr-a", OLD.ops, "b.md", "--runtime", "herdr"],
      "probe-herdr-a",
      herdrPin(),
    ],
  ]

  test.each(STARTS)(
    "a %s start whose brief is missing refuses, naming it",
    async (_, args, __, setup) => {
      const brief = args[BRIEF_AT[args[0] ?? ""] ?? -1]
      const r = await spawn(
        [...args, "--check"],
        [],
        { NO_BRIEF_FILE: "1" },
        undefined,
        undefined,
        setup,
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(`~/.playground/${brief} is not a file`)
      expect(r.cmux).toBeUndefined()
      expect(r.roster).toBeUndefined()
      expect(existsSync(lw(r.home, "ops", "capacity.jsonl"))).toBe(false)
    },
  )

  test.each(STARTS)(
    "a %s start whose brief is there passes the check",
    async (_, args, name, setup) => {
      const r = await spawn([...args, "--check"], [], {}, undefined, undefined, setup)
      expect(r.err).not.toContain("is not a file")
      expect(r.out).toContain(`ok: ${name} can start`)
      expect(r.code).toBe(0)
      expect(existsSync(lw(r.home, "ops", "capacity.jsonl"))).toBe(true)
    },
  )

  test("a start whose brief word is empty refuses before any gate", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "", "--check"], [])
    expect(r.code).toBe(1)
    expect(r.err).toContain("a brief is a file name under ~/.playground")
    expect(r.cmux).toBeUndefined()
    expect(existsSync(lw(r.home, "ops", "capacity.jsonl"))).toBe(false)
  })
})

// OLD.builder: given the brief's absolute path, spawn.sh refused with a path nobody typed.
describe("a brief given by its path under ~/.playground starts as its file name does (#1538)", () => {
  const seen = (r: Awaited<ReturnType<typeof spawn>>) => ({
    // each herdr start takes a session id of its own
    launch: launchOf(r)
      .replaceAll(r.home, "HOME")
      .replace(/--session-id [0-9a-f-]{36}/, "--session-id SID"),
    roster: r.roster,
  })

  test.each([
    ["an absolute path", "{home}/.playground/brief-x.md"],
    ["a quoted ~ path", "~/.playground/brief-x.md"],
  ])("%s starts the same session, its prompt naming the file", async (_, path) => {
    const bare = await spawn(["worker", "worker-brave-otter", "brief-x.md"], [])
    const r = await spawn(["worker", "worker-brave-otter", path], [], { BRIEF_FILE: "brief-x.md" })
    expect(r.code, r.err).toBe(0)
    expect(launchOf(r)).toContain("Your brief is in ~/.playground/brief-x.md: read it")
    expect(seen(r)).toEqual(seen(bare))
  })

  test("a resume's --brief takes the absolute path too", async () => {
    const brief = "handoffs/restart-brief.md"
    const r = await spawn(
      ["resume", OLD.dispatcher, root, "--brief", `{home}/.playground/${brief}`],
      [],
      { BRIEF_FILE: brief },
      undefined,
      { name: OLD.dispatcher, backend: "claude" },
    )
    expect(r.code, r.err).toBe(0)
    expect(launchOf(r)).toContain(`Your brief is in ~/.playground/${brief}: read it`)
  })

  test.each([
    ["a file outside it", "/etc/hosts"],
    ["a sibling folder", `{home}/.claude/${OLD.dispatcher}-old/brief-x.md`],
    ["the folder itself", "{home}/.playground"],
  ])("%s refuses with the name rule", async (_, path) => {
    const r = await spawn(["worker", "worker-brave-otter", path], [], { BRIEF_FILE: "brief-x.md" })
    expect(r.code).toBe(1)
    expect(r.err).toContain("a brief is a file name under ~/.playground")
    expect(r.cmux).toBeUndefined()
    expect(r.roster).toBeUndefined()
    expect(existsSync(lw(r.home, "ops", "capacity.jsonl"))).toBe(false)
  })
})

describe("--runtime herdr opens the session in herdr (#909)", () => {
  test("a worker opens a labelled workspace in the playground server, its launch names its session id, and both pins and the resume record land", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--runtime", "herdr"],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    const sid = launchOf(r).match(SID)?.[1] ?? ""
    expect(sid).not.toBe("")
    expect(placing(r)).toEqual([
      ["workspace", "create", "--cwd", root, "--label", "worker-brave-otter", "--no-focus"],
      ["pane", "rename", "w5:p1", "worker-brave-otter"],
      ["pane", "run", "w5:p1", `exec bash '${lw(r.home, "launch", "worker-brave-otter.sh")}'`],
      [
        "pane",
        "wait-output",
        "w5:p1",
        "--regex",
        "Yes, I trust|New MCP server found in this project|[0-9]+ new MCP servers found|⏵⏵",
        "--source",
        "visible",
        "--timeout",
        "120000",
      ],
    ])
    const dir = lw(r.home, "herdr")
    expect(readFileSync(join(r.home, "herdr.env"), "utf8").trim()).toBe(
      `playground ${dir}/playground.sock ${dir}/config.toml`,
    )
    expect(readFileSync(lw(r.home, "runtimes", "worker-brave-otter"), "utf8")).toBe("herdr\n")
    expect(readFileSync(lw(r.home, "backends", "worker-brave-otter"), "utf8")).toBe(
      "claude-code claude\n",
    )
    expect(execLine(r, "worker-brave-otter")).toBe(
      `exec spawn.sh resume worker-brave-otter ${root} ${sid}`,
    )
    expect(resumeFile(r, "worker-brave-otter").split("\n")).toContain("# server: playground")
    expect(launchOf(r).split("\n")[1]).toBe(`cd ${root} || exit 1`)
    expect(statSync(lw(r.home, "resume", "worker-brave-otter.sh")).mode & 0o777).toBe(0o700)
    expect(r.roster?.some((w) => /^(?:surface|workspace)=./.test(w))).toBe(false)
    const prompt = lw(r.home, "resume", "worker-brave-otter.prompt")
    expect(launchOf(r)).toContain(`"${readFileSync(prompt, "utf8").trim()}")`)
    expect(readFileSync(prompt, "utf8")).toStartWith("You are worker-brave-otter, a worker")
    expect(statSync(prompt).mode & 0o777).toBe(0o600)
  })

  // A herdr server starts its panes with the shell basics alone, so a session it runs had no TMPDIR.
  test.each([
    ["with none set gets the user's temp folder", {}, "/var/folders/zz/T/"],
    ["keeps one already set", { TMPDIR: "/tmp/own/" }, "/tmp/own/"],
  ])("a herdr session %s as TMPDIR", async (_, env, expected) => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--runtime", "herdr"],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code, r.err).toBe(0)
    const shim = mkdtempSync(join(scratch, "bin-1614-"))
    writeFileSync(
      join(shim, "claude"),
      '#!/bin/bash\nprintf %s "$TMPDIR" > "$HOME/claude.tmpdir"\n',
    )
    // macOS's getconf, which names the user's temp folder; the box runs Linux, whose getconf has no such name.
    writeFileSync(
      join(shim, "getconf"),
      '#!/bin/bash\n[ "$1" = DARWIN_USER_TEMP_DIR ] && echo /var/folders/zz/T/\n',
    )
    for (const name of ["claude", "getconf"]) chmodSync(join(shim, name), 0o755)
    const run = Bun.spawn(["bash", lw(r.home, "launch", "worker-brave-otter.sh")], {
      env: { HOME: r.home, PATH: `${shim}:${bin}:${process.env.PATH}`, ...env },
      stderr: "ignore",
      stdout: "ignore",
    })
    expect(await run.exited).toBe(0)
    expect(readFileSync(join(r.home, "claude.tmpdir"), "utf8")).toBe(expected)
  })

  test("a session on the probes server records that server in its resume record", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--runtime", "herdr"],
      [],
      { PLAYGROUND_HERDR_SESSION: "probes" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(readFileSync(join(r.home, "herdr.env"), "utf8").trim()).toStartWith("probes ")
    expect(resumeFile(r, "worker-brave-otter").split("\n")).toContain("# server: probes")
  })

  test("a column splits right of the herdr pane it names, in this checkout, and takes no surface:N", async () => {
    const col = ["column", "probe", "probe-x", "worker-y", "w1:p2", "b.md", "--runtime", "herdr"]
    const r = await spawn(col, [], {}, undefined, undefined, herdrPin())
    expect(r.code).toBe(0)
    expect(placing(r)[0]).toEqual([
      "pane",
      "split",
      "w1:p2",
      "--direction",
      "right",
      "--cwd",
      root,
      "--no-focus",
    ])
    expect(r.roster?.some((w) => /^(?:surface|workspace)=./.test(w))).toBe(false)
    const bad = await spawn(col.with(4, "surface:3"), [], {}, undefined, undefined, herdrPin())
    expect(bad.code).toBe(1)
    expect(bad.err).toContain("surface:3 is not a herdr pane id (w1:p2)")
    expect(placing(bad)).toEqual([])
  })

  test("a column takes a herdr pane id with letters in either part, and refuses one missing a part (#1272)", async () => {
    const col = ["column", "probe", "probe-x", "worker-y", "w1:p2", "b.md", "--runtime", "herdr"]
    for (const id of ["wN:p1", "w1:p1A", "wH:p1"]) {
      const r = await spawn(col.with(4, id), [], {}, undefined, undefined, herdrPin())
      expect(r.err).not.toContain("is not a herdr pane id")
      expect(r.code).toBe(0)
      expect(placing(r)[0]?.slice(0, 3)).toEqual(["pane", "split", id])
    }
    for (const id of ["w1", "p1", "wN:", "x1:p1"]) {
      const bad = await spawn(col.with(4, id), [], {}, undefined, undefined, herdrPin())
      expect(bad.code).toBe(1)
      expect(bad.err).toContain(`${id} is not a herdr pane id (w1:p2)`)
      expect(placing(bad)).toEqual([])
    }
  })

  test("a probe with no pane to split beside opens a labelled workspace of its own, in this checkout (#1026)", async () => {
    const r = await spawn(
      ["probe", "probe-herdr-a", OLD.ops, "b.md", "--runtime", "herdr"],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(placing(r).slice(0, 2)).toEqual([
      ["workspace", "create", "--cwd", root, "--label", "probe-herdr-a", "--no-focus"],
      ["pane", "rename", "w5:p1", "probe-herdr-a"],
    ])
    expect(launchOf(r).split("\n")[1]).toBe(`cd ${root} || exit 1`)
    expect(launchOf(r)).toContain(`you report to ${OLD.ops}`)
    expect(r.roster).toContain("title=Probe: herdr-a")
    expect(r.roster).toContain("kind=probe")
  })

  test("a runner start writes its name as its title", async () => {
    const r = await spawn(
      ["runner", "runner-calm-heron", "b.md"],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.roster).toContain("title=runner-calm-heron")
    expect(r.roster).toContain("kind=runner")
  })

  test("a runner whose entry holds a title keeps it", async () => {
    const roster = JSON.stringify({
      agents: [{ name: "runner-calm-heron", role: "runner", title: "Keep the stack up" }],
    })
    const r = await spawn(
      ["runner", "runner-calm-heron", "b.md"],
      [],
      { ROSTER_JSON: roster },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.roster?.some((w) => w.startsWith("title="))).toBe(false)
  })

  test.each([
    [
      "a name that reads as another kind",
      ["probe", "worker-x", OLD.ops, "b.md"],
      "worker-x reads as a worker, not a probe: bun run name probe gives one",
    ],
    [
      "a reports-to that is not a session name",
      ["probe", "probe-x", "Bad Name", "b.md"],
      "it reports to a session name, not Bad Name",
    ],
    ["two words", ["probe", "probe-x", OLD.ops], "spawn.sh probe"],
  ])("a probe with %s is refused, nothing placed (#1026)", async (_, args, says) => {
    const r = await spawn([...args, "--runtime", "herdr"], [], {}, undefined, undefined, herdrPin())
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(says)
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["workspace create", { FAKE_HERDR_CREATE_FAIL: "1" }, "error: workspace limit reached", false],
    ["pane rename", { FAKE_HERDR_RENAME_FAIL: "1" }, "error: label taken", true],
    ["pane run", { FAKE_HERDR_RUN_SAYS: "error: pane exited" }, "error: pane exited", true],
  ])(
    "a probe whose %s herdr refuses quotes herdr's words, leaving no launch file (#1026)",
    async (_, env, says, placed) => {
      const r = await spawn(
        ["probe", "probe-x", OLD.ops, "b.md", "--runtime", "herdr"],
        [],
        env,
        undefined,
        undefined,
        herdrPin(),
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(`herdr opened no session for probe-x (${says})`)
      expect(existsSync(lw(r.home, "launch", "probe-x.herdr"))).toBe(false)
      expect(existsSync(lw(r.home, "launch", "probe-x.sh"))).toBe(false)
      expect(placing(r).at(-1)?.[1] === "close").toBe(placed)
      expect(r.roster).toBeUndefined()
    },
  )

  test("a refused split names herdr's own error, not no answer (#1026)", async () => {
    const r = await spawn(
      ["column", "probe", "probe-x", "worker-y", "w1:p2", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_HERDR_SPLIT_FAIL: "1" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("herdr opened no session for probe-x (error: pane w1:p2 not found)")
    expect(r.err).not.toContain("no answer from herdr")
    expect(r.roster).toBeUndefined()
  })

  test.each([
    {
      label: "a name over herdr's 32 characters",
      name: "worker-abcdefghijklmnopqrstuvwxyz",
      env: {},
      pin: {},
      says: "at most 32 characters, and worker-abcdefghijklmnopqrstuvwxyz has 33",
    },
    {
      label: "a binary that does not hash to its pin",
      name: "worker-x",
      env: {},
      pin: { sha256: "0".repeat(64) },
      says: "does not hash to its pin's sha256",
    },
    {
      label: "a binary of another version",
      name: "worker-x",
      env: { FAKE_HERDR_VERSION: "0.9.6" },
      pin: {},
      says: "reads herdr 0.9.6 on --version, and its pin names herdr 0.9.5",
    },
    {
      label: "a pin naming no path",
      name: "worker-x",
      env: {},
      pin: { path: "" },
      says: "cannot read the herdr pin",
    },
    {
      label: "a herdr folder PLAYGROUND_HERDR_DIR names with no pin",
      name: "worker-x",
      env: { PLAYGROUND_HERDR_DIR: "/nowhere/new" },
      pin: {},
      says: "cannot read the herdr pin /nowhere/new/pin.json",
    },
    {
      label: "a server that is not running",
      name: "worker-x",
      env: { FAKE_HERDR_DOWN: "1" },
      pin: {},
      says: "playground, or bun run ops:herdr start, brings it up",
    },
  ] as { env: Record<string, string>; label: string; name: string; pin: object; says: string }[])(
    "$label is refused before anything opens",
    async ({ name, env, pin, says }) => {
      const r = await spawn(
        ["worker", name, "b.md", "--runtime", "herdr"],
        [],
        env,
        undefined,
        undefined,
        herdrPin(pin),
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(says)
      expect(placing(r)).toEqual([])
      expect(r.cmux).toBeUndefined()
      expect(r.roster).toBeUndefined()
      expect(existsSync(lw(r.home, "runtimes"))).toBe(false)
    },
  )

  test("a pane herdr will not run in is closed, and nothing is pinned or rostered", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_HERDR_RUN_FAIL: "1" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "herdr opened no session for worker-x (herdr would not label pane w5:p1 or run the launch in it)",
    )
    expect(r.err).not.toContain("no answer from herdr")
    expect(r.err).not.toContain('"result"')
    expect(placing(r).at(-1)).toEqual(["pane", "close", "w5:p1"])
    expect(existsSync(lw(r.home, "launch", "worker-x.sh"))).toBe(false)
    expect(existsSync(lw(r.home, "resume", "worker-x.sh"))).toBe(false)
    expect(existsSync(lw(r.home, "runtimes"))).toBe(false)
    expect(r.roster).toBeUndefined()
  })

  test("under the code root the trust prompt and then the MCP picker are answered, one key a request", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "trust,mcp,ready" },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: { fs: {} } }))
      },
    )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([
      ["pane", "send-keys", "w5:p1", "down"],
      ["pane", "send-keys", "w5:p1", "enter"],
      ["pane", "send-keys", "w5:p1", "up"],
      ["pane", "send-keys", "w5:p1", "up"],
      ["pane", "send-keys", "w5:p1", "enter"],
    ])
  })

  // playground planner, builder and ops start their managers this way, the first time the dispatcher routes work to each.
  test.each(["builder", "ops", "planner"])(
    "manager %s opens that lead in a workspace of its own",
    async (name) => {
      const r = await spawn(
        ["manager", name, "b.md", "--runtime", "herdr"],
        [],
        { FAKE_SCREENS: "ready" },
        undefined,
        undefined,
        herdrPin(),
      )
      expect(r.err).not.toContain("a manager in a workspace of its own is")
      expect(r.code).toBe(0)
    },
  )

  // a narrow column cuts the status line, "⏵⏵ bypass permissions" at 27 columns and "⏵⏵" at 12 (measured, 24 Oct), and herdr matches one row at a time.
  test.each(["cut", "bare"])(
    "a narrow column's %s status line is ready, and no key is sent",
    async (screen) => {
      const r = await spawn(
        ["manager", "optimizer", "b.md", "--runtime", "herdr"],
        [],
        { FAKE_SCREENS: screen },
        undefined,
        undefined,
        herdrPin(),
      )
      expect(r.code).toBe(0)
      expect(r.err).not.toContain("showed no REPL")
      expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([])
    },
  )

  test("a pane that never draws a status line still times out, naming the read", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "blank" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      "optimizer showed no REPL within 2 minutes; read it with herdr pane read w5:p1",
    )
  })

  test("a narrow column's trust row, cut after its first words, is answered", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "trustcut,ready" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([
      ["pane", "send-keys", "w5:p1", "down"],
      ["pane", "send-keys", "w5:p1", "enter"],
    ])
  })

  test("a REPL whose status line names an MCP server is ready, and no key is sent", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "mcpstatus" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([])
    expect(placing(r).filter((c) => c[1] === "wait-output")).toHaveLength(1)
  })

  test("outside the two roots the trust prompt stays for the owner, and the session still lands", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "trust" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain("waits at Claude's folder trust prompt")
    expect(r.err).toContain("so it is the owner's to answer")
    expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([])
    expect(readFileSync(lw(r.home, "runtimes", "worker-x"), "utf8")).toBe("herdr\n")
  })

  test("paths.codeRoot moves the trusted root, so a session under it has its trust prompt answered", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "trust,ready" },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        storeWith(
          join(home, ".playground"),
          {},
          {
            "paths.codeRoot": dirname(realpathSync(root)),
          },
        )
        // A machine with extensions has the login ext init wrote, which the skill resolver reads first.
        writeFileSync(join(home, ".playground", "extensions", "login"), "acme-dev\n")
      },
    )
    expect(r.code).toBe(0)
    expect(r.err).not.toContain("waits at Claude's folder trust prompt")
    expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([
      ["pane", "send-keys", "w5:p1", "down"],
      ["pane", "send-keys", "w5:p1", "enter"],
    ])
  })

  test("an org ext.links guards trusts its folder in the home folder, so a session under it has its trust prompt answered", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr"],
      [],
      { FAKE_SCREENS: "trust,ready" },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        symlinkSync(dirname(realpathSync(root)), join(home, "acme-co"))
        storeWith(join(home, ".playground"), {}, { "ext.links": { acme: ["acme-co"] } })
        writeFileSync(join(home, ".playground", "extensions", "login"), "acme-dev\n")
      },
    )
    expect(r.code).toBe(0)
    expect(r.err).not.toContain("waits at Claude's folder trust prompt")
    expect(placing(r).filter((c) => c[1] === "send-keys")).toEqual([
      ["pane", "send-keys", "w5:p1", "down"],
      ["pane", "send-keys", "w5:p1", "enter"],
    ])
  })

  test("the resume record keeps the account and the model it started with, never a token", async () => {
    const r = await spawn(
      [
        "worker",
        "worker-x",
        "b.md",
        "--runtime",
        "herdr",
        "--account",
        "acme@example.net",
        "--model",
        "claude-sonnet-5-5",
      ],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    const sid = launchOf(r).match(SID)?.[1] ?? ""
    expect(execLine(r, "worker-x")).toBe(
      `exec spawn.sh resume worker-x ${root} ${sid} --account acme@example.net --model claude-sonnet-5-5`,
    )
    expect(resumeFile(r, "worker-x")).toContain("\n# account: acme@example.net\n")
    expect(resumeFile(r, "worker-x")).not.toContain(TOKEN)
  })
})
