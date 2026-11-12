import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { OLD } from "../session-names"
import {
  bin,
  execLine,
  herdrCalls,
  herdrPin,
  launchOf,
  lw,
  placing,
  root,
  scratch,
  SID,
  spawn,
  transcript,
  unplugged,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("--effort sets the session's effort, high by default (#180)", () => {
  test("a start with no --effort launches at high and records no --effort", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr"],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(" --effort high ")
    expect(execLine(r, "worker-x")).not.toContain("--effort")
  })

  test("a start with --effort xhigh launches at xhigh, and its resume record keeps it", async () => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr", "--effort", "xhigh"],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(" --effort xhigh ")
    expect(launchOf(r)).not.toContain("--effort high")
    const sid = launchOf(r).match(SID)?.[1] ?? ""
    expect(execLine(r, "worker-x")).toBe(
      `exec spawn.sh resume worker-x ${root} ${sid} --effort xhigh`,
    )
  })

  test("a restore resumes a record's --effort at that effort", async () => {
    const sid = "eeeeeeee-0000-4000-8000-000000000005"
    const r = await spawn(["restore"], [], {}, undefined, undefined, (home) => {
      herdrPin()(home)
      for (const dir of ["resume", "runtimes", "backends"])
        mkdirSync(lw(home, dir), { recursive: true })
      writeFileSync(
        lw(home, "resume", "worker-e.sh"),
        `#!/bin/bash\nexec /x/scripts/spawn.sh resume worker-e ${root} ${sid} --effort xhigh\n`,
      )
      writeFileSync(lw(home, "runtimes", "worker-e"), "herdr\n")
      writeFileSync(lw(home, "backends", "worker-e"), "claude\n")
      transcript(home, sid)
    })
    expect(r.out).toBe("restored worker-e\n")
    expect(launchOf(r)).toContain(
      `--resume ${sid} -n worker-e --model claude-opus-5-5 --effort xhigh `,
    )
    expect(execLine(r, "worker-e")).toBe(
      `exec spawn.sh resume worker-e ${root} ${sid} --effort xhigh`,
    )
  })

  test.each([
    {
      args: ["--effort", "extreme"],
      said: "--effort takes low, medium, high, xhigh or max, not extreme",
    },
    { args: ["--effort"], said: "--effort takes one of low, medium, high, xhigh or max, once" },
    { args: ["--effort", "--title"], said: "--effort needs a value" },
    {
      args: ["--effort", "high", "--effort", "max"],
      said: "--effort takes one of low, medium, high, xhigh or max, once",
    },
  ])("$args is refused before herdr runs", async ({ args, said }) => {
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--runtime", "herdr", ...args],
      [],
      {},
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(said)
  })
})

describe("with no --runtime, a start opens in herdr whatever its spawner's terminal (#1484)", () => {
  test("from herdr, outside cmux, it opens in herdr", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { HERDR_ENV: "1" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(placing(r)[0]?.slice(0, 2)).toEqual(["workspace", "create"])
    expect(readFileSync(lw(r.home, "runtimes", "worker-brave-otter"), "utf8")).toBe("herdr\n")
  })

  test("a probe from herdr, outside cmux, passes the probe's herdr check and opens in herdr", async () => {
    const r = await spawn(
      ["probe", "probe-herdr-a", OLD.ops, "b.md"],
      [],
      { HERDR_ENV: "1" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(placing(r)[0]?.slice(0, 2)).toEqual(["workspace", "create"])
  })

  test("a column from herdr, outside cmux, splits the herdr pane it names", async () => {
    const r = await spawn(
      ["column", "probe", "probe-x", "worker-y", "w1:p2", "b.md"],
      [],
      { HERDR_ENV: "1" },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(placing(r)[0]?.slice(0, 3)).toEqual(["pane", "split", "w1:p2"])
    expect(readFileSync(lw(r.home, "runtimes", "probe-x"), "utf8")).toBe("herdr\n")
  })

  test("a column beside an old cmux surface:N, from cmux, is refused as no herdr pane id", async () => {
    const r = await spawn(
      ["column", "lead", OLD.planner, OLD.dispatcher, "surface:1", "handoff.md"],
      [],
      { CMUX_SOCKET_PATH: join(scratch, "cmux.sock") },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("surface:1 is not a herdr pane id (w1:p2)")
    expect(r.cmux).toBeUndefined()
    expect(placing(r)).toEqual([])
  })

  test("from cmux it opens in herdr", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      { CMUX_SOCKET_PATH: join(scratch, "cmux.sock") },
      undefined,
      undefined,
      herdrPin(),
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(placing(r)[0]?.slice(0, 2)).toEqual(["workspace", "create"])
    expect(readFileSync(lw(r.home, "runtimes", "worker-brave-otter"), "utf8")).toBe("herdr\n")
  })

  // spawn.sh opens every session in herdr: --runtime cmux is refused in every mode as any runtime but herdr is, before any cmux or herdr call and any pin.
  test.each([
    ["a worker", ["worker", "worker-brave-otter", "b.md"]],
    ["a column", ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"]],
    ["a probe", ["probe", "probe-x", OLD.ops, "p.md"]],
    ["a manager", ["manager", "optimizer", "b.md"]],
    ["a resume", ["resume", "worker-x", root, "0b6e3c1a-4d2f-4e8a-9c7b-1f2e3d4c5b6a"]],
    ["a --check", ["worker", "worker-brave-otter", "b.md", "--check"]],
  ])("--runtime cmux on %s is refused as any runtime but herdr is", async (_, args) => {
    const r = await spawn(
      [...args, "--runtime", "cmux"],
      [],
      { CMUX_SOCKET_PATH: join(scratch, "cmux.sock") },
      undefined,
      { name: String(args[0] === "column" ? args[2] : args[1]), backend: "claude" },
    )
    expect(r.code).toBe(2)
    expect(r.err).toContain('--runtime takes herdr alone, not "cmux"')
    expect(r.cmux).toBeUndefined()
    expect(herdrCalls(r)).toEqual([])
    expect(existsSync(lw(r.home, "runtimes"))).toBe(false)
    expect(r.roster).toBeUndefined()
  })

  test("spawn.sh runs cmux nowhere: no line calls it, bare or behind an env assignment", () => {
    const text = readFileSync(join(import.meta.dir, "../../scripts/spawn.sh"), "utf8")
    const calls = [
      ...text.matchAll(/(?:^\s*|[;&|(]\s*|\$\(\s*)(?:[A-Z_]+=\S*\s+)*cmux\s+[a-z-]/gm),
    ].map((m) => m[0].trim())
    expect(calls).toEqual([])
  })

  test.each([
    ["a worker", ["worker", "worker-brave-otter", "b.md"]],
    ["a resume", ["resume", "worker-x", root, "0b6e3c1a-4d2f-4e8a-9c7b-1f2e3d4c5b6a"]],
  ])("--runtime with any other value on %s is refused at parse", async (_, args) => {
    const r = await spawn([...args, "--runtime", "tmux"], [], {}, undefined, {
      name: String(args[1]),
      backend: "claude",
    })
    expect(r.code).toBe(2)
    expect(r.err).toContain('--runtime takes herdr alone, not "tmux"')
    expect(herdrCalls(r)).toEqual([])
    expect(existsSync(lw(r.home, "runtimes"))).toBe(false)
  })
})

describe("a resume opens in herdr, whatever runtime its start recorded", () => {
  const SESSION = "0b6e3c1a-4d2f-4e8a-9c7b-1f2e3d4c5b6a"
  const pinned = (runtime: string) => (home: string) => {
    herdrPin()(home)
    mkdirSync(lw(home, "runtimes"), { recursive: true })
    writeFileSync(lw(home, "runtimes", "worker-x"), `${runtime}\n`)
  }
  const claude = { name: "worker-x", backend: "claude" }

  test("a herdr pin resumes in herdr, in the session's folder, and its run is stamped", async () => {
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      {},
      undefined,
      claude,
      (home) => {
        pinned("herdr")(home)
        transcript(home, SESSION)
      },
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    const file = lw(r.home, "launch", "worker-x.sh")
    expect(placing(r).find((c) => c[1] === "run")).toEqual([
      "pane",
      "run",
      "w5:p1",
      `exec bash '${file}'`,
    ])
    expect(launchOf(r)).toContain(`claude --resume ${SESSION} -n worker-x`)
    expect(execLine(r, "worker-x")).toBe(`exec spawn.sh resume worker-x ${root} ${SESSION}`)
    const run = Bun.spawn(["bash", file], {
      env: { HOME: r.home, PATH: `${bin}:${process.env.PATH}` },
      stderr: "pipe",
      stdout: "pipe",
    })
    expect(await run.exited).toBe(0)
    expect(readFileSync(join(r.home, "claude.args"), "utf8")).toContain(
      `--resume ${SESSION} -n worker-x`,
    )
    expect(readFileSync(lw(r.home, "resume", "worker-x.ran"), "utf8")).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/,
    )
  })

  // a restore, a move or an account switch resumes with no --brief, and a session idle at the restart would never act on after-resume's context
  test("a herdr resume with no --brief still takes one turn, so it acts on after-resume's instruction", async () => {
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      {},
      undefined,
      claude,
      (home) => {
        pinned("herdr")(home)
        transcript(home, SESSION)
      },
    )
    expect(r.code).toBe(0)
    expect(unplugged(launchOf(r))).toContain(
      `--dangerously-skip-permissions "You are worker-x, resumed after a restart. Act on the after-resume instruction in your context first, then carry on."`,
    )
  })

  test("that first turn names whom the session reports to, from the prompt its start recorded", async () => {
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      {},
      undefined,
      claude,
      (home) => {
        pinned("herdr")(home)
        transcript(home, SESSION)
        mkdirSync(lw(home, "resume"), { recursive: true })
        writeFileSync(
          lw(home, "resume", "worker-x.prompt"),
          `You are worker-x, a worker in the Playground factory; you report to ${OLD.builder}. Load the playbook skill first.\n`,
        )
      },
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(
      `"You are worker-x, resumed after a restart; you report to ${OLD.builder}. Act on the after-resume instruction in your context first, then carry on."`,
    )
  })

  test("a herdr session with no transcript starts afresh under its own id and name, with the prompt its start recorded", async () => {
    const said = `You are worker-x, a worker in the Playground factory; you report to ${OLD.builder}.`
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      { NO_SESSION_TRANSCRIPT: "1" },
      undefined,
      claude,
      (home) => {
        pinned("herdr")(home)
        mkdirSync(lw(home, "resume"), { recursive: true })
        writeFileSync(lw(home, "resume", "worker-x.prompt"), `${said}\n`)
      },
    )
    expect(r.code).toBe(0)
    const launch = launchOf(r)
    expect(launch).toContain(`claude --session-id ${SESSION} -n worker-x --model`)
    expect(unplugged(launch)).toContain(`--dangerously-skip-permissions "${said}")`)
    expect(launch).not.toContain("--resume")
    expect(execLine(r, "worker-x")).toBe(`exec spawn.sh resume worker-x ${root} ${SESSION}`)
    expect(readFileSync(lw(r.home, "resume", "worker-x.prompt"), "utf8")).toBe(`${said}\n`)
  })

  test.each([
    ["a quote and a $", 'You are "$(touch x)"'],
    ["a backquote", "You are `touch x`"],
    ["a backslash", "You are \\"],
    ["a newline", "You are\nworker-x"],
  ])("a recorded prompt holding %s is left out and named", async (_, prompt) => {
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      { NO_SESSION_TRANSCRIPT: "1" },
      undefined,
      claude,
      (home) => {
        pinned("herdr")(home)
        mkdirSync(lw(home, "resume"), { recursive: true })
        writeFileSync(lw(home, "resume", "worker-x.prompt"), `${prompt}\n`)
      },
    )
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(`--session-id ${SESSION} -n worker-x`)
    expect(launchOf(r)).not.toContain("You are")
    expect(r.err).toContain("its recorded prompt holds a quote, $, backquote or backslash")
  })

  test("a resume reopens the session in the restored pane that holds its label, while that pane holds no agent", async () => {
    const panes = (home: string) => {
      pinned("herdr")(home)
      const pane = (id: string, label: string, over = {}) => ({
        agent_status: "unknown",
        label,
        pane_id: id,
        workspace_id: "w2",
        ...over,
      })
      writeFileSync(
        join(home, "herdr.panes"),
        JSON.stringify({
          result: {
            panes: [
              pane("w2:p1", "worker-x", { agent: OLD.dispatcher, agent_status: "idle" }),
              pane("w2:p3", "worker-x"),
              pane("w2:p4", "worker-y"),
            ],
          },
        }),
      )
    }
    const r = await spawn(["resume", "worker-x", root, SESSION], [], {}, undefined, claude, panes)
    expect(r.code).toBe(0)
    expect(placing(r).some((c) => c[0] === "workspace")).toBe(false)
    expect(placing(r).find((c) => c[1] === "run")?.[2]).toBe("w2:p3")
    expect(r.roster?.some((w) => /^(?:surface|workspace)=./.test(w))).toBe(false)
  })

  test("a resume with no pin from cmux opens in herdr (#1484)", async () => {
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      { CMUX_SOCKET_PATH: join(scratch, "cmux.sock") },
      undefined,
      claude,
      (home) => {
        herdrPin()(home)
        transcript(home, SESSION)
      },
    )
    expect(r.code).toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(
      placing(r)
        .find((c) => c[1] === "run")
        ?.slice(0, 3),
    ).toEqual(["pane", "run", "w5:p1"])
  })

  // The pin is rewritten at every resume, so one holding any word from an older install opens in herdr.
  test("a resume whose pin holds another word opens in herdr and rewrites the pin", async () => {
    const r = await spawn(
      ["resume", "worker-x", root, SESSION],
      [],
      {},
      undefined,
      claude,
      pinned("made-up"),
    )
    expect(r.code, r.err).toBe(0)
    expect(r.cmux).toBeUndefined()
    expect(
      placing(r)
        .find((c) => c[1] === "run")
        ?.slice(0, 3),
    ).toEqual(["pane", "run", "w5:p1"])
    expect(launchOf(r)).toContain(`claude --resume ${SESSION} -n worker-x`)
    expect(execLine(r, "worker-x")).toBe(`exec spawn.sh resume worker-x ${root} ${SESSION}`)
    expect(readFileSync(lw(r.home, "runtimes", "worker-x"), "utf8")).toBe("herdr\n")
  })
})
