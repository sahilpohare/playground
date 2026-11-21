import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import {
  capacityLog,
  execLine,
  herdrPin,
  launchAfterRm,
  launchOf,
  lw,
  placing,
  projectOf,
  ranIn,
  root,
  scratch,
  script,
  spawn,
  transcript,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// no factory session, script, skill or job uses a path under the Desktop folder.
const DESKTOP = "Desktop" // the folder the factory left
describe("a resume into a Desktop folder moves to the same tree under the code root", () => {
  const SESSION = "0b6e3c1a-4d2f-4e8a-9c7b-1f2e3d4c5b6a"
  const claude = { name: "worker-x", backend: "claude" }
  const project = (home: string, dir: string) =>
    join(home, ".claude", "projects", projectOf(dir), `${SESSION}.jsonl`)
  // The session ran in the Desktop folder, whose transcript sits in that folder's project; the Desktop folder itself is never made, as macOS keeps it from a new pane.
  const ranOnDesktop = (from: string, to: string) => (home: string) => {
    herdrPin()(home)
    mkdirSync(join(home, to), { recursive: true })
    const old = project(home, join(home, from))
    mkdirSync(dirname(old), { recursive: true })
    writeFileSync(old, "{}\n")
  }

  test.each([
    [`${DESKTOP}/code/factory`, "code/factory"],
    [`${DESKTOP}/acme-labs/acme-app`, "code/acme-labs/acme-app"],
  ])("~/%s resumes in ~/%s with its transcript", async (from, to) => {
    const r = await spawn(
      ["resume", "worker-x", `{home}/${from}`, SESSION, "--runtime", "herdr"],
      [],
      {},
      undefined,
      claude,
      ranOnDesktop(from, to),
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    const dir = join(r.home, to)
    expect(launchOf(r)).toContain(`cd ${dir} || exit 1\n`)
    expect(launchOf(r)).toContain(`claude --resume ${SESSION} -n worker-x`)
    expect(execLine(r, "worker-x")).toBe(`exec spawn.sh resume worker-x ${dir} ${SESSION}`)
    expect(readFileSync(project(r.home, dir), "utf8")).toBe("{}\n")
  })

  test("--check copies no transcript", async () => {
    const from = `${DESKTOP}/code/factory`
    const to = "code/factory"
    const r = await spawn(
      ["resume", "worker-x", `{home}/${from}`, SESSION, "--runtime", "herdr", "--check"],
      [],
      {},
      undefined,
      claude,
      ranOnDesktop(from, to),
    )
    expect(r.code).toBe(0)
    expect(existsSync(project(r.home, join(r.home, to)))).toBe(false)
  })

  test("with no code root, a Desktop folder that exists resumes where it is", async () => {
    const from = `${DESKTOP}/visitor/factory`
    const r = await spawn(
      ["resume", "worker-x", `{home}/${from}`, SESSION, "--runtime", "herdr", "--check"],
      [],
      { NO_LEADS: "1" },
      undefined,
      claude,
      (home) => {
        herdrPin()(home)
        mkdirSync(join(home, from), { recursive: true })
      },
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(r.out).toContain("ok: worker-x can start")
  })

  test("with its twin under the code root beside it, a Desktop folder still resumes in the twin", async () => {
    const from = `${DESKTOP}/code/factory`
    const to = "code/factory"
    const r = await spawn(
      ["resume", "worker-x", `{home}/${from}`, SESSION, "--runtime", "herdr"],
      [],
      {},
      undefined,
      claude,
      (home) => {
        ranOnDesktop(from, to)(home)
        mkdirSync(join(home, from), { recursive: true })
      },
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(`cd ${join(r.home, to)} || exit 1\n`)
  })

  test.each([
    ["with the code root", {}, ["code", "gone"]],
    ["with no code root", { NO_LEADS: "1" }, [DESKTOP, "code", "gone"]],
  ])(
    "%s, a folder missing from both trees refuses naming where it would resume",
    async (_, env, named) => {
      const r = await spawn(
        ["resume", "worker-x", `{home}/${DESKTOP}/code/gone`, SESSION, "--runtime", "herdr"],
        [],
        env,
        undefined,
        claude,
        herdrPin(),
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(`${join(r.home, ...named)} is not a folder`)
    },
  )
})

// the main rule keeps every session out of the main checkout, so a resume never moves one there, and a resume into a removed worktree names its branch.
describe("a resume keeps a session out of the main checkout and out of a removed worktree (#1691)", () => {
  const SESSION = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
  const claude = { name: "worker-x", backend: "claude" }
  // Each case writes the transcripts it means, so the harness writes none.
  const NONE = { NO_SESSION_TRANSCRIPT: "1" }
  // A main checkout of its own with spawn.sh in it, so the script's main checkout is this one, and a worktree folder under it.
  const checkout = () => {
    const main = realpathSync(mkdtempSync(join(scratch, "main-1691-")))
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", ...args], { cwd: main, stderr: "ignore" }).exitCode).toBe(0)
    mkdirSync(join(main, "scripts"))
    writeFileSync(join(main, "scripts", "spawn.sh"), readFileSync(script))
    // spawn.sh resolves its data folder through the checkout's own resolver.
    mkdirSync(join(main, "packages", "env", "src"), { recursive: true })
    for (const file of ["aliases.ts", "data-dir.ts"])
      writeFileSync(
        join(main, "packages", "env", "src", file),
        readFileSync(join(root, "packages", "env", "src", file)),
      )
    git("init", "-q", "-b", "main")
    git("add", ".")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x")
    return {
      main,
      spawnSh: join(main, "scripts", "spawn.sh"),
      tree: join(main, ".claude", "worktrees", "pg-9-x"),
    }
  }
  // The session's transcript in the project of the folder it ran in, naming that folder and its branch as Claude Code's lines do.
  const ranIn1691 =
    (dir: string, made = true) =>
    (home: string) => {
      herdrPin()(home)
      if (made) mkdirSync(dir, { recursive: true })
      const folder = join(home, ".claude", "projects", projectOf(dir))
      mkdirSync(folder, { recursive: true })
      writeFileSync(
        join(folder, `${SESSION}.jsonl`),
        `${JSON.stringify({ cwd: dir, gitBranch: "pg-9-x", sessionId: SESSION, type: "user" })}\n`,
      )
    }

  test("a session that ran in its worktree is refused the main checkout at --check, naming that worktree", async () => {
    const { main, spawnSh, tree } = checkout()
    const r = await spawn(
      ["resume", "worker-x", main, SESSION, "--runtime", "herdr", "--check"],
      [],
      NONE,
      spawnSh,
      claude,
      ranIn1691(tree),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `${main} is the main checkout, and worker-x ran in ${tree}: resume it in ${tree}`,
    )
  })

  test("a session whose worktree is gone is refused the main checkout, naming the worktree add that brings it back", async () => {
    const { main, spawnSh, tree } = checkout()
    const r = await spawn(
      ["resume", "worker-x", main, SESSION, "--runtime", "herdr"],
      [],
      NONE,
      spawnSh,
      claude,
      ranIn1691(tree, false),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`git -C ${main} worktree add ${tree} pg-9-x, then resume it there`)
    expect(existsSync(lw(r.home, "resume", "worker-x.sh"))).toBe(false)
  })

  test("a session that started in the main checkout resumes there", async () => {
    const { main, spawnSh } = checkout()
    const r = await spawn(
      ["resume", "worker-x", main, SESSION, "--runtime", "herdr"],
      [],
      NONE,
      spawnSh,
      claude,
      ranIn1691(main),
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(execLine(r, "worker-x")).toBe(`exec spawn.sh resume worker-x ${main} ${SESSION}`)
  })

  test("a resume into a removed worktree refuses, naming the folder and its branch", async () => {
    const { spawnSh, tree } = checkout()
    const r = await spawn(
      ["resume", "worker-x", tree, SESSION, "--runtime", "herdr"],
      [],
      NONE,
      spawnSh,
      claude,
      ranIn1691(tree, false),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`${tree} is not a folder, and its branch is pg-9-x`)
  })

  test("a transcript holding a byte that is not UTF-8 still gives the refusal its branch", async () => {
    const { spawnSh, tree } = checkout()
    const r = await spawn(
      ["resume", "worker-x", tree, SESSION, "--runtime", "herdr"],
      [],
      { LC_ALL: "en_US.UTF-8" },
      spawnSh,
      claude,
      (home) => {
        ranIn1691(tree, false)(home)
        appendFileSync(
          join(home, ".claude", "projects", projectOf(tree), `${SESSION}.jsonl`),
          Buffer.from([0xff, 0x0a]),
        )
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`${tree} is not a folder, and its branch is pg-9-x`)
  })

  test("a resume into a missing folder outside the main checkout's worktrees names its branch, with no worktree add", async () => {
    const { spawnSh } = checkout()
    const gone = join(scratch, "acme-1691", "x")
    const r = await spawn(
      ["resume", "worker-x", gone, SESSION, "--runtime", "herdr"],
      [],
      NONE,
      spawnSh,
      claude,
      ranIn1691(gone, false),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `${gone} is not a folder, and its branch is pg-9-x: bring it back on pg-9-x, then resume it there`,
    )
    expect(r.err).not.toContain("worktree add")
  })

  test("the newest copy of the transcript names the folder, never a stale one a Desktop move left", async () => {
    const { main, spawnSh, tree } = checkout()
    const r = await spawn(
      ["resume", "worker-x", main, SESSION, "--runtime", "herdr", "--check"],
      [],
      NONE,
      spawnSh,
      claude,
      (home) => {
        ranIn1691(tree)(home)
        const stale = join(home, ".claude", "projects", "-A-stale")
        mkdirSync(stale, { recursive: true })
        const copy = join(stale, `${SESSION}.jsonl`)
        writeFileSync(
          copy,
          `${JSON.stringify({ cwd: join(home, DESKTOP, "old"), gitBranch: "old", sessionId: SESSION, type: "user" })}\n`,
        )
        utimesSync(copy, new Date(2000, 0, 1), new Date(2000, 0, 1))
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`worker-x ran in ${tree}: resume it in ${tree}`)
    expect(r.err).not.toContain(DESKTOP)
  })

  test("restore names a refused resume as not restored and runs the rest", async () => {
    const { main, spawnSh, tree } = checkout()
    const other = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
    const r = await spawn(["restore"], [], {}, spawnSh, undefined, (home) => {
      ranIn1691(tree, false)(home)
      const started = join(home, ".claude", "projects", projectOf(main))
      mkdirSync(started, { recursive: true })
      writeFileSync(join(started, `${other}.jsonl`), "{}\n")
      for (const dir of ["resume", "runtimes", "backends"])
        mkdirSync(lw(home, dir), { recursive: true })
      for (const [name, dir, sid] of [
        ["worker-a", main, other],
        ["worker-x", tree, SESSION],
      ] as const) {
        writeFileSync(
          lw(home, "resume", `${name}.sh`),
          `#!/bin/bash\nexec /x/scripts/spawn.sh resume ${name} ${dir} ${sid}\n`,
        )
        writeFileSync(lw(home, "runtimes", name), "herdr\n")
        writeFileSync(lw(home, "backends", name), "claude\n")
      }
    })
    expect(r.out).toContain("restored worker-a\n")
    expect(r.out).toContain(
      `not restored worker-x: ${tree} is not a folder, and its branch is pg-9-x`,
    )
    expect(r.code).toBe(1)
  })
})

describe("restore resumes the herdr sessions its resume files list", () => {
  const ids = {
    a: "aaaaaaaa-0000-4000-8000-000000000001",
    b: "bbbbbbbb-0000-4000-8000-000000000002",
    c: "cccccccc-0000-4000-8000-000000000003",
    d: "dddddddd-0000-4000-8000-000000000004",
  }
  const listed = (home: string) => {
    herdrPin()(home)
    for (const dir of ["resume", "runtimes", "backends"])
      mkdirSync(lw(home, dir), { recursive: true })
    for (const [k, sid] of Object.entries(ids)) {
      const name = `worker-${k}`
      const extra = k === "a" ? " --account acme@example.net --model claude-sonnet-5-5" : ""
      writeFileSync(
        lw(home, "resume", `${name}.sh`),
        `#!/bin/bash\nexec /x/scripts/spawn.sh resume ${name} ${root} ${sid}${extra}\n`,
      )
      // worker-c's pin holds a word from an older install, which restore reads as herdr
      writeFileSync(lw(home, "runtimes", name), k === "c" ? "made-up\n" : "herdr\n")
      writeFileSync(lw(home, "backends", name), "claude\n")
      transcript(home, sid)
    }
  }
  const roster = JSON.stringify({
    agents: [
      { name: "worker-b", role: "worker", status: "ended", task: "t" },
      { name: "worker-a", role: "worker", status: "working", task: "t" },
    ],
  })

  test("it resumes each one not live with its account and model, a pin holding another word included, and skips what the roster ended and a live one", async () => {
    const r = await spawn(
      ["restore"],
      [{ name: "worker-d", pid: 5100 }],
      { ROSTER_JSON: roster },
      undefined,
      undefined,
      listed,
    )
    expect(r.out).toBe(
      "restored worker-a\nskipped worker-b: its roster row reads ended\nrestored worker-c\nskipped worker-d: live\n",
    )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([
      ["pane", "run", "w5:p1", `exec bash '${lw(r.home, "launch", "worker-a.sh")}'`],
      ["pane", "run", "w5:p1", `exec bash '${lw(r.home, "launch", "worker-c.sh")}'`],
    ])
    expect(readFileSync(lw(r.home, "runtimes", "worker-c"), "utf8")).toBe("herdr\n")
    // two sessions restore here, and a folder lists its files in no fixed order on Linux, so worker-a's launch is read by its name
    const launch = readFileSync(lw(r.home, "launch", "worker-a.sh"), "utf8")
    expect(launch).toContain(`--resume ${ids.a} -n worker-a --model claude-sonnet-5-5`)
    expect(launch).toContain("acme@example.net")
    expect(execLine(r, "worker-a")).toBe(
      `exec spawn.sh resume worker-a ${root} ${ids.a} --account acme@example.net --model claude-sonnet-5-5`,
    )
  })

  test("with the load gate held, the first dispatcher comes back first and past it, the next record waits, and the restore exits 0 (#1682)", async () => {
    const sids = { "2bcdfg-worker": ids.a, dispatcher: ids.b }
    const r = await spawn(
      ["restore"],
      [],
      { FAKE_LOAD5: "24.00" },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        for (const dir of ["resume", "runtimes", "backends"])
          mkdirSync(lw(home, dir), { recursive: true })
        for (const [name, sid] of Object.entries(sids)) {
          writeFileSync(
            lw(home, "resume", `${name}.sh`),
            `#!/bin/bash\nexec /x/scripts/spawn.sh resume ${name} ${root} ${sid}\n`,
          )
          writeFileSync(lw(home, "runtimes", name), "herdr\n")
          writeFileSync(lw(home, "backends", name), "claude\n")
          transcript(home, sid)
        }
      },
    )
    const [first, second] = r.out.split("\n")
    expect(first).toBe("restored dispatcher")
    expect(second).toStartWith("waiting 2bcdfg-worker: ")
    expect(second).toContain("the load gate holds it")
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toHaveLength(1)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({ gate: "load", session: "dispatcher", verdict: "skipped" }),
      expect.objectContaining({ gate: "load", session: "2bcdfg-worker", verdict: "refused" }),
    ])
  })

  test("a checker's resume carries the PRs its roster row serves, its pr first, and one whose row names none is not restored (#1400)", async () => {
    const [pr1, pr2] = [1, 2].map((n) => `https://github.com/acme/factory/pull/${n}`)
    const rows = [
      {
        kind: "reviewer",
        name: "reviewer-a",
        pr: pr2,
        prs: [pr1, pr2],
        status: "working",
        task: "t",
      },
      { kind: "tester", name: "tester-b", status: "working", task: "t" },
    ]
    const r = await spawn(
      ["restore"],
      [],
      { ROSTER_JSON: JSON.stringify({ agents: rows }) },
      undefined,
      undefined,
      (home) => {
        herdrPin()(home)
        for (const dir of ["resume", "runtimes", "backends"])
          mkdirSync(lw(home, dir), { recursive: true })
        for (const [name, sid] of [
          ["reviewer-a", ids.a],
          ["tester-b", ids.b],
        ]) {
          writeFileSync(
            lw(home, "resume", `${name}.sh`),
            `#!/bin/bash\nexec /x/scripts/spawn.sh resume ${name} ${root} ${sid}\n`,
          )
          writeFileSync(lw(home, "runtimes", name), "herdr\n")
          writeFileSync(lw(home, "backends", name), "claude\n")
          transcript(home, sid)
        }
      },
    )
    expect(r.out).toContain("restored reviewer-a\n")
    expect(r.out).toContain("not restored tester-b: a tester starts with --pr <pull url>")
    expect(r.roster).toContain(`prs+=${pr2},${pr1}`)
    expect(r.code).toBe(1)
  })

  test("a session whose roster row reads done stays down, as an ended one does", async () => {
    const r = await spawn(
      ["restore"],
      [{ name: "worker-d", pid: 5100 }],
      {
        ROSTER_JSON: JSON.stringify({
          agents: [
            { name: "worker-b", role: "worker", status: "ended", task: "t" },
            { name: "worker-a", role: "worker", status: "done", task: "t" },
          ],
        }),
      },
      undefined,
      undefined,
      listed,
    )
    expect(r.out).toBe(
      "skipped worker-a: its roster row reads done\nskipped worker-b: its roster row reads ended\nrestored worker-c\nskipped worker-d: live\n",
    )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([
      ["pane", "run", "w5:p1", `exec bash '${lw(r.home, "launch", "worker-c.sh")}'`],
    ])
  })

  test("under inscope it reads the roster roster.ts writes, ~/.claude's", async () => {
    const r = await spawn(
      ["restore"],
      [],
      {
        CLAUDE_CONFIG_DIR: "/no/such/inscope/dir",
        INSCOPE_CCD: "/no/such/inscope/dir",
        ROSTER_JSON: roster,
      },
      undefined,
      undefined,
      listed,
    )
    expect(r.out).toContain("restored worker-a")
    expect(r.out).toContain("skipped worker-b: its roster row reads ended\n")
  })

  test("a resume that fails is named and the run exits 1", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { ROSTER_JSON: roster, FAKE_HERDR_RUN_FAIL: "1" },
      undefined,
      undefined,
      listed,
    )
    expect(r.out).toContain("not restored worker-a: herdr opened no session for worker-a")
    expect(r.code).toBe(1)
  })

  test("a record holding any other option is not restored", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { ROSTER_JSON: roster },
      undefined,
      undefined,
      (home) => {
        listed(home)
        writeFileSync(
          lw(home, "resume", "worker-a.sh"),
          `exec /x/scripts/spawn.sh resume worker-a ${root} ${ids.a} --brief x.md\n`,
        )
      },
    )
    expect(r.out).toBe(
      "skipped worker-a: its exec line is not a resume restore runs\nskipped worker-b: its roster row reads ended\nrestored worker-c\nrestored worker-d\n",
    )
  })

  const onProbes = (home: string) => {
    listed(home)
    writeFileSync(
      lw(home, "resume", "worker-d.sh"),
      `#!/bin/bash\n# server: probes\nexec /x/scripts/spawn.sh resume worker-d ${root} ${ids.d}\n`,
    )
  }

  test("each server restores only the sessions its records place there, a record with no server line being playground's", async () => {
    const factory = await spawn(
      ["restore"],
      [],
      { ROSTER_JSON: roster },
      undefined,
      undefined,
      onProbes,
    )
    expect(factory.out).toBe(
      "restored worker-a\nskipped worker-b: its roster row reads ended\nrestored worker-c\n",
    )
    const probes = await spawn(
      ["restore"],
      [],
      { PLAYGROUND_HERDR_SESSION: "probes", ROSTER_JSON: roster },
      undefined,
      undefined,
      onProbes,
    )
    expect(probes.out).toBe("restored worker-d\n")
    expect(readFileSync(join(probes.home, "herdr.env"), "utf8").trim()).toStartWith("probes ")
  })

  test("a restore pointed at a server that is not a word restores nothing", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { PLAYGROUND_HERDR_SESSION: "../x", ROSTER_JSON: roster },
      undefined,
      undefined,
      listed,
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("PLAYGROUND_HERDR_SESSION is a word, not ../x")
  })

  const held = (pid: number) => (home: string) => {
    listed(home)
    symlinkSync(`${pid} Sun Oct 18 09:00:00 2026`, lw(home, "resume", ".restore.lock"))
  }

  test("while another restore holds the lock it restores nothing and exits 1", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { FAKE_LSTART: "Sun Oct 18 09:00:00 2026", ROSTER_JSON: roster },
      undefined,
      undefined,
      held(4242),
    )
    expect(r.out).toBe(
      "a restore is already running (pid 4242), so this one stops; nothing is wrong\n",
    )
    expect(r.code).toBe(1)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([])
    expect(readlinkSync(lw(r.home, "resume", ".restore.lock"))).toBe(
      "4242 Sun Oct 18 09:00:00 2026",
    )
  })

  test("a lock whose holder has gone is taken, and let go once the restore ends", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { FAKE_DEAD: "4242", FAKE_LSTART: "Sun Oct 18 09:00:00 2026", ROSTER_JSON: roster },
      undefined,
      undefined,
      held(4242),
    )
    expect(r.out).toContain("restored worker-a")
    expect(r.code).toBe(0)
    expect(existsSync(lw(r.home, "resume", ".restore.lock"))).toBe(false)
  })

  test("with nothing to restore it says nothing and exits 0", async () => {
    const r = await spawn(["restore"], [], {}, undefined, undefined, herdrPin())
    expect(r.code).toBe(0)
    expect(r.out).toBe("")
  })

  test.each([
    ["a name", ["worker-a"]],
    ["--harness", ["--harness", "codex"]],
    ["--priority", ["--priority"]],
  ])("it takes no other words: %s", async (_, words) => {
    const r = await spawn(["restore", ...words], [], {})
    expect(r.code).toBe(2)
    expect(r.err).toContain("restore takes no other words")
  })
})

describe("close ends a herdr session by closing the pane it opened (#994)", () => {
  // The session as spawn.sh leaves it: its runtime pin, its resume record naming its server, and the panes herdr lists.
  const opened =
    (
      over: {
        panes?: { label: string; pane_id: string }[]
        record?: string | null
        runtime?: string | null
      } = {},
    ) =>
    (home: string) => {
      herdrPin()(home)
      mkdirSync(lw(home, "runtimes"), { recursive: true })
      mkdirSync(lw(home, "resume"), { recursive: true })
      if (over.runtime !== null)
        writeFileSync(lw(home, "runtimes", "worker-x"), `${over.runtime ?? "herdr"}\n`)
      if (over.record !== null)
        writeFileSync(
          lw(home, "resume", "worker-x.sh"),
          over.record ??
            `#!/bin/bash\n# server: factory\nexec ${root}/scripts/spawn.sh resume worker-x ${root} x\n`,
        )
      const panes = over.panes ?? [
        { label: "worker-x", pane_id: "w2:p3" },
        { label: "worker-y", pane_id: "w2:p4" },
      ]
      writeFileSync(
        join(home, "herdr.panes"),
        JSON.stringify({ result: { panes: panes.map((p) => ({ ...p, workspace_id: "w2" })) } }),
      )
    }
  const closes = (r: { home: string }) => placing(r).filter((c) => c[1] === "close")
  const socketOf = (r: { home: string }) =>
    readFileSync(join(r.home, "herdr.env"), "utf8").trim().split(" ")[1]

  test("it closes the one pane labelled with the name on the server its resume record names, ends its roster row before the pane closes and keeps its pins and record", async () => {
    const r = await spawn(["close", "worker-x"], [], {}, undefined, undefined, opened())
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(r.out).toBe("closed worker-x (pane w2:p3 on factory)\n")
    expect(closes(r)).toEqual([["pane", "close", "w2:p3"]])
    expect(socketOf(r)).toBe(lw(r.home, "herdr", "factory.sock"))
    expect(r.cmux).toBeUndefined()
    expect(r.rosterLog).toEqual(["set worker-x status=ended"])
    // the row reads ended before the pane closes, so a restore that finds the session gone leaves it down (#1696)
    expect(r.rosterAtClose).toEqual(["set worker-x status=ended"])
    expect(readFileSync(lw(r.home, "runtimes", "worker-x"), "utf8")).toBe("herdr\n")
    expect(existsSync(lw(r.home, "resume", "worker-x.sh"))).toBe(true)
  })

  test("a roster write that fails after the close says the pane closed, names the write, and exits 0", async () => {
    const r = await spawn(
      ["close", "worker-x"],
      [],
      { FAKE_ROSTER_BROKEN: "1" },
      undefined,
      undefined,
      opened(),
    )
    expect(r.code).toBe(0)
    expect(r.out).toBe("closed worker-x (pane w2:p3 on factory)\n")
    expect(r.err).toContain("roster.ts says: roster broken")
    expect(r.err).toContain("worker-x closed, but its roster write failed; record it with ")
    expect(r.err).toContain("set worker-x status=ended")
  })

  test.each([
    ["probes", "#!/bin/bash\n# server: probes\nexec x\n", "probes"],
    ["playground, with no server line", "#!/bin/bash\nexec x\n", "playground"],
  ])("a record naming %s closes the pane there", async (_, record, server) => {
    const r = await spawn(["close", "worker-x"], [], {}, undefined, undefined, opened({ record }))
    expect(r.code).toBe(0)
    expect(closes(r)).toEqual([["pane", "close", "w2:p3"]])
    expect(socketOf(r)).toBe(lw(r.home, "herdr", `${server}.sock`))
  })

  test("your own pane id on another server is not your pane", async () => {
    const r = await spawn(
      ["close", "worker-x"],
      [],
      { HERDR_PANE_ID: "w2:p3", HERDR_SESSION: "probes" },
      undefined,
      undefined,
      opened(),
    )
    expect(r.code).toBe(0)
    expect(closes(r)).toEqual([["pane", "close", "w2:p3"]])
  })

  test.each([
    [
      "a session whose pin holds another word",
      {},
      opened({ runtime: "made-up" }),
      "does not read herdr",
    ],
    ["a session with no resume record", {}, opened({ record: null }), "has no resume record"],
    [
      "a server name that is not a word",
      {},
      opened({ record: "#!/bin/bash\n# server: ../x\nexec x\n" }),
      "names its server ../x",
    ],
    [
      "no pane with its label",
      {},
      opened({ panes: [{ label: "worker-y", pane_id: "w2:p4" }] }),
      "no pane on the herdr server factory carries the label worker-x",
    ],
    [
      "two panes with its label",
      {},
      opened({
        panes: [
          { label: "worker-x", pane_id: "w2:p3" },
          { label: "worker-x", pane_id: "w2:p5" },
        ],
      }),
      "2 panes on the herdr server factory carry the label worker-x",
    ],
    [
      "your own pane",
      { HERDR_PANE_ID: "w2:p3", HERDR_SESSION: "factory" },
      opened(),
      "pane w2:p3 is your own",
    ],
    ["a server that is down", { FAKE_HERDR_DOWN: "1" }, opened(), "is not running"],
    [
      "a herdr that is not the pinned one",
      { FAKE_HERDR_VERSION: "0.9.6" },
      opened(),
      "its pin names herdr 0.9.5",
    ],
  ])("it refuses %s and closes nothing", async (_, env, setup, said) => {
    const r = await spawn(["close", "worker-x"], [], env, undefined, undefined, setup)
    expect(r.code).toBe(1)
    expect(r.err).toContain("spawn.sh refuses worker-x: ")
    expect(r.err).toContain(said)
    expect(closes(r)).toEqual([])
    expect(r.roster).toBeUndefined()
  })

  test("a session whose start stopped before its runtime pin closes by its record and its one labelled pane, writing the pin first (#2112)", async () => {
    const r = await spawn(
      ["close", "worker-x"],
      [],
      {},
      undefined,
      undefined,
      opened({ runtime: null }),
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(r.out).toBe("closed worker-x (pane w2:p3 on factory)\n")
    expect(closes(r)).toEqual([["pane", "close", "w2:p3"]])
    expect(r.rosterLog).toEqual(["set worker-x status=ended"])
    expect(readFileSync(lw(r.home, "runtimes", "worker-x"), "utf8")).toBe("herdr\n")
  })

  test.each([
    ["no resume record", opened({ runtime: null, record: null }), "it has no resume record"],
    [
      "no pane with its label",
      opened({ runtime: null, panes: [{ label: "worker-y", pane_id: "w2:p4" }] }),
      "no pane on the herdr server factory carries the label worker-x",
    ],
    [
      "two panes with its label",
      opened({
        runtime: null,
        panes: [
          { label: "worker-x", pane_id: "w2:p3" },
          { label: "worker-x", pane_id: "w2:p5" },
        ],
      }),
      "2 panes on the herdr server factory carry the label worker-x",
    ],
  ])(
    "a session with no runtime pin and %s is refused with that reason, and no pin is written (#2112)",
    async (_, setup, said) => {
      const r = await spawn(["close", "worker-x"], [], {}, undefined, undefined, setup)
      expect(r.code).toBe(1)
      expect(r.err).toContain("spawn.sh refuses worker-x: ")
      expect(r.err).toContain(said)
      expect(r.err).toContain("and it has no runtime pin")
      expect(closes(r)).toEqual([])
      expect(r.roster).toBeUndefined()
      expect(existsSync(lw(r.home, "runtimes", "worker-x"))).toBe(false)
    },
  )

  test.each([
    ["working", {}, "status=working"],
    ["parked", { hold: "#12" }, "status=parked hold=#12"],
  ])(
    "a close herdr refuses names herdr's own words and puts a %s row back",
    async (status, extra, back) => {
      const r = await spawn(
        ["close", "worker-x"],
        [],
        {
          FAKE_HERDR_CLOSE_FAIL: "1",
          ROSTER_JSON: JSON.stringify({
            agents: [{ name: "worker-x", role: "worker", status, task: "t", ...extra }],
          }),
        },
        undefined,
        undefined,
        opened(),
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain("herdr would not close pane w2:p3 (error: pane w2:p3 not found)")
      expect(r.rosterLog).toEqual(["set worker-x status=ended", `set worker-x ${back}`])
      expect(existsSync(lw(r.home, "closes", "worker-x"))).toBe(false)
    },
  )

  test.each([
    ["no name", ["close"]],
    [
      "a word past the session id",
      ["close", "worker-x", "a1b2c3d4-0000-4000-8000-0000000000a1", "worker-y"],
    ],
    ["an option", ["close", "worker-x", "--runtime", "herdr"]],
    ["a size", ["close", "worker-x", "--size", "small"]],
    ["--harness", ["close", "worker-x", "--harness", "codex"]],
    ["--priority", ["close", "worker-x", "--priority"]],
  ])("it takes a session's name and its session id alone, so %s is usage", async (_, args) => {
    const r = await spawn(args, [], {}, undefined, undefined, opened())
    expect(r.code).toBe(2)
    expect(r.err).toContain("close takes a session's name, and its session id to pick one")
    expect(r.err).toContain("--runtime herdr    with any mode but restore, close or read,")
    expect(closes(r)).toEqual([])
    expect(r.roster).toBeUndefined()
  })
})

describe("a resume with no id finds its session by name in its folder (#1201)", () => {
  const SESSION = "0b6e3c1a-4d2f-4e8a-9c7b-1f2e3d4c5b6a"
  const claude = { name: "worker-x", backend: "claude" }
  const NONE = { NO_SESSION_TRANSCRIPT: "1" }

  test("with no transcript naming it in the folder, it refuses before any pane opens, naming the fix", async () => {
    const r = await spawn(["resume", "worker-x", root], [], NONE, undefined, claude)
    expect(r.code).toBe(1)
    expect(r.err).toContain("spawn.sh refuses worker-x: ")
    expect(r.err).toContain(`no session named worker-x ran in ${root}`)
    expect(r.err).toContain("pass its session id, or resume it in the folder it ran in")
    expect(r.cmux).toBeUndefined()
    expect(r.roster).toBeUndefined()
  })

  test.each([
    [
      "it ran in another folder",
      (home: string) => ranIn(join(home, ".claude"), "/elsewhere", "worker-x"),
    ],
    [
      "another session ran in the folder",
      (home: string) => ranIn(join(home, ".claude"), root, "worker-y"),
    ],
  ])("it refuses when %s", async (_, setup) => {
    const r = await spawn(["resume", "worker-x", root], [], NONE, undefined, claude, setup)
    expect(r.code).toBe(1)
    expect(r.err).toContain(`no session named worker-x ran in ${root}`)
    expect(r.cmux).toBeUndefined()
  })

  test("a session that ran in the folder resumes by name, as before", async () => {
    const r = await spawn(["resume", "worker-x", root], [], NONE, undefined, claude, (home) =>
      ranIn(join(home, ".claude"), root, "worker-x"),
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launchAfterRm(r)).toContain("claude --resume worker-x -n worker-x ")
  })

  test("a resume with an id needs no transcript naming it, and herdr starts it afresh under that id", async () => {
    const r = await spawn(["resume", "worker-x", root, SESSION], [], NONE, undefined, claude)
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(`claude --session-id ${SESSION} -n worker-x `)
  })

  test("the folder is read through its real path, as Claude Code names it", async () => {
    const link = join(scratch, `link-${Bun.hash(String(Math.random()))}`)
    symlinkSync(root, link)
    const r = await spawn(["resume", "worker-x", link], [], NONE, undefined, claude, (home) =>
      ranIn(join(home, ".claude"), root, "worker-x"),
    )
    expect(r.code).toBe(0)
  })

  // The name check reads every transcript in the folder's project (4.1 GB in the main checkout's on 6 Nov), so a resume the gate refuses must not pay for it: a lead retrying a refused resume would feed the load the gate waits on.
  const scans = (r: { home: string }) => {
    const log = join(r.home, "grep.calls")
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []
  }
  const ranHere = (home: string) => ranIn(join(home, ".claude"), root, "worker-x")
  // each verdict the gate logged, none when it never ran
  const verdicts = (r: { home: string }) =>
    existsSync(join(r.home, ".playground", "ops", "capacity.jsonl"))
      ? capacityLog(r).map((row) => row.verdict)
      : []

  test.each([
    ["load", { FAKE_LOAD1: "40.00", FAKE_LOAD5: "40.00" }, "max(load1, load5) is 40.00"],
    ["memory", { FAKE_PRESSURE: "4" }, "pressure level is 4"],
    ["usage", { USAGE_JSON: "{ nope" }, "usage.json (does not read)"],
  ])("a resume the %s gate refuses reads no transcript of the folder", async (gate, env, said) => {
    const r = await spawn(
      ["resume", "worker-x", root],
      [],
      { ...NONE, ...env },
      undefined,
      claude,
      ranHere,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(said)
    expect(capacityLog(r)).toEqual([expect.objectContaining({ gate, verdict: "refused" })])
    expect(scans(r)).toEqual([])
    expect(r.cmux).toBeUndefined()
  })

  test("a resume past the gate reads the folder's transcripts once, and --check still refuses a folder it never ran in", async () => {
    const passed = await spawn(["resume", "worker-x", root], [], NONE, undefined, claude, ranHere)
    expect(passed.code).toBe(0)
    expect(scans(passed)).toEqual([expect.stringContaining(`/projects/${projectOf(root)}/`)])
    const checked = await spawn(
      ["resume", "worker-x", root, "--check"],
      [],
      NONE,
      undefined,
      claude,
    )
    expect(checked.code).toBe(1)
    expect(checked.err).toContain(`no session named worker-x ran in ${root}`)
    expect(checked.out).not.toContain("can start")
    expect(scans(checked)).toHaveLength(1)
  })

  // The load gate counts each pass row as a start, so a resume the name check refuses must log none, or each retry of it would add a start that never happened.
  test("a resume the name check refuses past the gate logs no pass row, and one that goes ahead logs one", async () => {
    const refused = await spawn(["resume", "worker-x", root], [], NONE, undefined, claude)
    expect(refused.code).toBe(1)
    expect(refused.err).toContain(`no session named worker-x ran in ${root}`)
    expect(verdicts(refused)).toEqual(["check"])
    const passed = await spawn(["resume", "worker-x", root], [], NONE, undefined, claude, ranHere)
    expect(passed.code).toBe(0)
    expect(verdicts(passed).filter((v) => v === "pass")).toHaveLength(1)
  })

  test("a live session holding the name refuses before the folder's transcripts are read, with the live session's exit 3", async () => {
    const r = await spawn(
      ["resume", "worker-x", root],
      [{ name: "worker-x", pid: 5002 }],
      NONE,
      undefined,
      claude,
    )
    expect(r.code).toBe(3)
    expect(r.err).toContain("a live session already holds the name worker-x (pid 5002)")
    expect(scans(r)).toEqual([])
  })
})

// the checker reaper ends a checker whose roster worker has ended, so one resumed to serve another worker with its old row would be ended again on its next pass
describe("a resume of a checker whose roster worker has ended", () => {
  const SESSION = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
  const roster = (name: string, kind: string, status: string) => ({
    NO_SESSION_TRANSCRIPT: "1",
    ROSTER_JSON: JSON.stringify({
      agents: [
        { kind, name, worker: "v2pq8t-worker" },
        { kind: "worker", name: "v2pq8t-worker", status },
      ],
    }),
  })

  test.each([
    ["k3m9px-reviewer", "reviewer"],
    ["k3m9px-tester", "tester"],
  ])(
    "%s refuses before any pane opens, naming the assign to a live worker, else ending its row",
    async (name, kind) => {
      const r = await spawn(
        ["resume", name, root, SESSION],
        [],
        roster(name, kind, "ended"),
        undefined,
        {
          name,
          backend: "claude",
        },
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(
        `spawn.sh refuses ${name}: its roster row names v2pq8t-worker as its worker, which has ended`,
      )
      expect(r.err).toContain(
        `bun scripts/roster.ts assign ${name} "<title>" review worker=<live worker> pr=<url>`,
      )
      expect(r.err).toContain(`bun scripts/roster.ts set ${name} status=ended`)
      expect(r.cmux).toBeUndefined()
      expect(existsSync(lw(r.home, "resume", `${name}.sh`))).toBe(false)
    },
  )

  test.each([
    ["no worker= on its row", [{ kind: "reviewer", name: "k3m9px-reviewer" }]],
    [
      "a worker the roster has no row for",
      [{ kind: "reviewer", name: "k3m9px-reviewer", worker: "v2pq8t-worker" }],
    ],
  ])("a checker with %s resumes as before", async (_, agents) => {
    const name = "k3m9px-reviewer"
    const env = { NO_SESSION_TRANSCRIPT: "1", ROSTER_JSON: JSON.stringify({ agents }) }
    const r = await spawn(["resume", name, root, SESSION, "--pr", "1"], [], env, undefined, {
      name,
      backend: "claude",
    })
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
  })

  test("a checker whose worker is live resumes as before", async () => {
    const name = "k3m9px-reviewer"
    const r = await spawn(
      ["resume", name, root, SESSION, "--pr", "1"],
      [],
      roster(name, "reviewer", "working"),
      undefined,
      {
        name,
        backend: "claude",
      },
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(`claude --session-id ${SESSION} -n ${name} `)
  })
})
