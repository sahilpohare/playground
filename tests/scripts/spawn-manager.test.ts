import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { OLD } from "../session-names"
import {
  bin,
  launchAfterRm,
  launchOf,
  opened,
  others,
  placing,
  root,
  scratch,
  script,
  spawn,
  TOKEN,
  typed,
  usage,
  zai,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// A manager with a workspace of its own: OLD.dispatcher-2, the second dispatcher, beside OLD.dispatcher in the leads worktree.
describe("a manager starts in a workspace of its own, in the leads worktree", () => {
  const lookup = `tk="$(security find-generic-password -s playground-glm -a zai -w)" || exit 1; [ -n "$tk" ] || { echo "The playground-glm item for zai holds an empty token; save it again with playground accounts add --provider glm --label zai, then respawn." >&2; exit 1; }; ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ANTHROPIC_AUTH_TOKEN="$tk" ANTHROPIC_DEFAULT_OPUS_MODEL='glm-5.3-flash[1m]' ANTHROPIC_DEFAULT_SONNET_MODEL='glm-5.3-flash[1m]' ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash ENABLE_TOOL_SEARCH=true `
  const leads = (home: string) => join(home, "code", "factory", ".claude", "worktrees", "leads")
  const pinOf = (r: Awaited<ReturnType<typeof spawn>>, name: string) =>
    readFileSync(join(r.home, ".playground", "backends", name), "utf8").trim()

  test(`${OLD.dispatcher}-2 starts as a dispatcher on GLM, in a workspace named for it`, async () => {
    const r = await spawn(
      ["manager", `${OLD.dispatcher}-2`, `brief-${OLD.dispatcher}-2.md`, "--backend", "glm"],
      others(3),
    )
    expect(r.code).toBe(0)
    expect(opened(r)).toEqual([
      "workspace",
      "create",
      "--cwd",
      leads(r.home),
      "--label",
      `${OLD.dispatcher}-2`,
      "--no-focus",
    ])
    const command = launchAfterRm(r)
    expect(command).toStartWith(
      `(${lookup}env PLAYGROUND_ROLE=dispatcher claude -n ${OLD.dispatcher}-2 `,
    )
    expect(command).toContain(" --model 'glm-5.3-flash[1m]' --effort high ")
    // The second dispatcher passes work to OLD.dispatcher while it is live (brief-OLD.dispatcher-2.md), so OLD.dispatcher is who it answers to.
    expect(command).toContain(
      `You are ${OLD.dispatcher}-2, the Playground factory's dispatcher; dispatcher briefs you`,
    )
    expect(command).toContain(`~/.playground/brief-${OLD.dispatcher}-2.md`)
    expect(command).not.toContain("Report to")
    expect(pinOf(r, `${OLD.dispatcher}-2`)).toBe("claude-code glm")
    expect(r.roster).toEqual([
      "set",
      `${OLD.dispatcher}-2`,
      "kind=dispatcher",
      "surface=",
      `task=brief-${OLD.dispatcher}-2.md`,
      "memory=off",
    ])
  })

  // Only the dispatcher takes a second account, or GLM where it is set up. On Claude it runs on a second account, so OLD.dispatcher's own usage never pays for both.
  test(`${OLD.dispatcher}-2 starts on Claude as a second account with --account, on Opus`, async () => {
    const r = await spawn(
      [
        "manager",
        `${OLD.dispatcher}-2`,
        `brief-${OLD.dispatcher}-2.md`,
        "--account",
        "acme@example.net",
      ],
      [],
    )
    expect(r.code).toBe(0)
    expect(opened(r)).toEqual([
      "workspace",
      "create",
      "--cwd",
      leads(r.home),
      "--label",
      `${OLD.dispatcher}-2`,
      "--no-focus",
    ])
    const command = launchAfterRm(r)
    expect(command).toContain(
      `CLAUDE_CODE_OAUTH_TOKEN="$tk" env PLAYGROUND_ROLE=dispatcher claude -n ${OLD.dispatcher}-2 --model claude-opus-5-5 `,
    )
    expect(command).not.toContain("api.z.ai")
    expect(pinOf(r, `${OLD.dispatcher}-2`)).toBe("claude-code claude")
  })

  test.each([
    { label: "no --backend and no --account", extra: [] as string[] },
    { label: "--backend claude and no --account", extra: ["--backend", "claude"] },
  ])(`${OLD.dispatcher}-2 with $label is refused before herdr runs`, async ({ extra }) => {
    const r = await spawn(
      ["manager", `${OLD.dispatcher}-2`, `brief-${OLD.dispatcher}-2.md`, ...extra],
      [],
    )
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      `${OLD.dispatcher}-2, the second dispatcher, runs on --backend glm, or on Claude with --account <email>, a second account`,
    )
  })

  test(`a resume of ${OLD.dispatcher}-2 reopens it as a dispatcher on GLM, from its pin`, async () => {
    const r = await spawn(["resume", `${OLD.dispatcher}-2`, root], [], {}, undefined, {
      name: `${OLD.dispatcher}-2`,
      backend: "glm",
    })
    expect(r.code).toBe(0)
    expect(opened(r)).toEqual([
      "workspace",
      "create",
      "--cwd",
      root,
      "--label",
      `${OLD.dispatcher}-2`,
      "--no-focus",
    ])
    expect(launchAfterRm(r)).toStartWith(
      `(${lookup}env PLAYGROUND_ROLE=dispatcher claude --resume ${OLD.dispatcher}-2 -n ${OLD.dispatcher}-2 `,
    )
    expect(r.roster).toContain("kind=dispatcher")
  })

  test(`a resume of ${OLD.dispatcher}-2 whose pin reads claude, with no --account, is refused before herdr runs`, async () => {
    const r = await spawn(["resume", `${OLD.dispatcher}-2`, root], [], {}, undefined, {
      name: `${OLD.dispatcher}-2`,
      backend: "claude",
    })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      `${OLD.dispatcher}-2, the second dispatcher, runs on --backend glm, or on Claude with --account <email>, a second account`,
    )
  })

  test(`a resume of ${OLD.dispatcher}-2 whose pin reads claude reopens it on the --account it is given`, async () => {
    const r = await spawn(
      ["resume", `${OLD.dispatcher}-2`, root, "--account", "acme@example.net"],
      [],
      {},
      undefined,
      { name: `${OLD.dispatcher}-2`, backend: "claude" },
    )
    expect(r.code).toBe(0)
    expect(launchAfterRm(r)).toContain(
      `CLAUDE_CODE_OAUTH_TOKEN="$tk" env PLAYGROUND_ROLE=dispatcher claude --resume ${OLD.dispatcher}-2 -n ${OLD.dispatcher}-2 `,
    )
  })

  const managers = [
    {
      label: `${OLD.dispatcher}-2`,
      args: ["manager", `${OLD.dispatcher}-2`, "b.md", "--backend", "glm"] as string[],
    },
    { label: "optimizer", args: ["manager", "optimizer", "b.md"] as string[] },
  ]
  const git = (dir: string, ...args: string[]) => {
    const r = Bun.spawnSync([
      "git",
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      ...args,
    ])
    expect(r.exitCode).toBe(0)
    return r.stdout.toString().trim()
  }
  // The factory's checkout as a fresh install leaves it: a clone on main of an origin that also has canary (none with canary: false), with no local canary and no leads worktree yet, or a clone on canary; seed is where a later push to origin is made.
  const checkoutOf =
    ({ canary = true, on = "main" }: { canary?: boolean; on?: string } = {}) =>
    (home: string) => {
      const seed = join(home, "seed")
      mkdirSync(seed, { recursive: true })
      git(seed, "init", "-q", "-b", "main")
      git(seed, "commit", "-q", "--allow-empty", "-m", "seed")
      if (canary) git(seed, "branch", "canary")
      git(home, "init", "-q", "--bare", join(home, "origin.git"))
      git(seed, "push", "-q", join(home, "origin.git"), "main", ...(canary ? ["canary"] : []))
      git(home, "clone", "-q", "-b", on, join(home, "origin.git"), join(home, "code", "factory"))
    }
  const checkout = checkoutOf()
  // The installs the fake bun was handed, through the repo's own run-slot.
  const installs = (home: string) =>
    existsSync(join(home, "bun-install.log"))
      ? readFileSync(join(home, "bun-install.log"), "utf8").trim().split("\n")
      : []

  // A fresh checkout's first manager start cuts the leads worktree from the branch the checkout was cloned on, main for a public install, so its managers run what it shipped rather than canary.
  test.each(managers)(
    "$label with no leads worktree cuts one from main, tracking origin's, and starts in it",
    async ({ args }) => {
      const r = await spawn(args, [], { NO_LEADS: "1" }, undefined, undefined, checkout)
      expect(r.err).not.toContain("is not a folder")
      expect(r.code).toBe(0)
      expect(opened(r)).toContain(leads(r.home))
      expect(readFileSync(join(leads(r.home), ".git"), "utf8")).toStartWith("gitdir: ")
      expect(git(leads(r.home), "symbolic-ref", "HEAD")).toBe("refs/heads/leads")
      expect(git(leads(r.home), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main")
      expect(installs(r.home)).toEqual([
        `install --frozen-lockfile --ignore-scripts --cwd ${leads(r.home)}`,
      ])
      // a fast-forward pull then moves it to origin's newer main.
      const seed = join(r.home, "seed")
      git(seed, "commit", "-q", "--allow-empty", "-m", "newer")
      git(seed, "push", "-q", join(r.home, "origin.git"), "main")
      git(leads(r.home), "pull", "--ff-only", "-q")
      expect(git(leads(r.home), "rev-parse", "HEAD")).toBe(git(seed, "rev-parse", "HEAD"))
    },
  )

  // A restore runs spawn.sh from launchd, on /usr/bin:/bin with no bun, and a missing leads is cut there too.
  test("on launchd's PATH, with no bun on it, a new leads worktree installs with bun from its install folder", async () => {
    const noBun = join(scratch, "bin-no-bun")
    mkdirSync(noBun, { recursive: true })
    for (const f of readdirSync(bin)) {
      if (f !== "bun" && !existsSync(join(noBun, f))) symlinkSync(join(bin, f), join(noBun, f))
    }
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { NO_LEADS: "1", PATH: `${noBun}:/usr/bin:/bin` },
      script,
      undefined,
      (home) => {
        checkout(home)
        mkdirSync(join(home, ".bun", "bin"), { recursive: true })
        symlinkSync(join(bin, "bun"), join(home, ".bun", "bin", "bun"))
        // run-slot where an earlier round looked for it, so a bare bun is what that round trips on
        mkdirSync(join(home, ".playground", "ops"), { recursive: true })
        symlinkSync(
          join(root, "scripts", "ops", "run-slot.sh"),
          join(home, ".playground", "ops", "run-slot.sh"),
        )
      },
    )
    expect(r.err).not.toContain("failed")
    expect(r.code).toBe(0)
    expect(installs(r.home)).toEqual([
      `install --frozen-lockfile --ignore-scripts --cwd ${leads(r.home)}`,
    ])
  })

  // A public install clones main alone, so a cut from canary had no branch to take.
  test.each(["optimizer", "builder"])(
    "a clone of an origin with main alone cuts the leads worktree from main: %s",
    async (name) => {
      const r = await spawn(
        ["manager", name, "b.md"],
        [],
        { NO_LEADS: "1" },
        undefined,
        undefined,
        checkoutOf({ canary: false }),
      )
      expect(r.err).not.toContain("invalid reference")
      expect(r.code).toBe(0)
      expect(git(leads(r.home), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main")
    },
  )

  test("a checkout cloned on canary on purpose cuts the leads worktree from canary", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { NO_LEADS: "1" },
      undefined,
      undefined,
      checkoutOf({ on: "canary" }),
    )
    expect(r.code).toBe(0)
    expect(git(leads(r.home), "symbolic-ref", "HEAD")).toBe("refs/heads/leads")
    expect(git(leads(r.home), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/canary")
  })

  // A cut whose install failed removes the worktree and leaves its branch, which the next cut takes again from origin's.
  test("a leads branch an earlier cut left is reset to origin's main and tracks it", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { NO_LEADS: "1" },
      undefined,
      undefined,
      (home) => {
        checkout(home)
        git(join(home, "code", "factory"), "branch", "--no-track", "leads", "origin/main")
      },
    )
    expect(r.code).toBe(0)
    expect(git(leads(r.home), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main")
  })

  test.each(managers)(
    "$label whose new leads worktree fails to install is refused before herdr runs, the worktree moved to the trash for the next start",
    async ({ args }) => {
      const r = await spawn(
        args,
        [],
        { FAKE_INSTALL_FAIL: "1", NO_LEADS: "1", ROSTER_JSON: '{"agents":[]}' },
        undefined,
        undefined,
        checkout,
      )
      expect(r.code).toBe(1)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("bun install in the new leads worktree")
      expect(r.err).toContain("moved to the trash")
      expect(r.err).toContain("lockfile is frozen")
      expect(existsSync(leads(r.home))).toBe(false)
      expect(git(join(r.home, "code", "factory"), "worktree", "list")).not.toContain("leads")
      const trash = join(r.home, ".playground", "trash")
      const [batch] = readdirSync(trash).filter((name) => name !== "manifest.jsonl")
      expect(existsSync(join(trash, batch!, "1", "leads"))).toBe(true)
    },
  )

  test("a kept leads worktree with no node_modules is installed at the next manager start", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { NO_LEADS: "1" },
      undefined,
      undefined,
      (home) => {
        checkout(home)
        const factory = join(home, "code", "factory")
        git(
          factory,
          "worktree",
          "add",
          "-q",
          "--track",
          "-B",
          "leads",
          join(factory, ".claude", "worktrees", "leads"),
          "origin/main",
        )
      },
    )
    expect(r.code).toBe(0)
    expect(installs(r.home)).toHaveLength(1)
  })

  test("a leads worktree whose node_modules a failed install left, with no install mark, is installed at the next manager start", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { NO_LEADS: "1" },
      undefined,
      undefined,
      (home) => {
        checkout(home)
        const factory = join(home, "code", "factory")
        git(factory, "worktree", "add", "-q", "--track", "-B", "leads", leads(home), "origin/main")
        mkdirSync(join(leads(home), "node_modules", "partial"), { recursive: true })
      },
    )
    expect(r.code).toBe(0)
    expect(installs(r.home)).toHaveLength(1)
    expect(existsSync(join(leads(r.home), "node_modules", ".playground-installed"))).toBe(true)
  })

  test("an installed leads worktree is not installed again", async () => {
    const r = await spawn(["manager", "optimizer", "b.md"], [])
    expect(r.code).toBe(0)
    expect(installs(r.home)).toHaveLength(0)
  })

  test("a failed install of a leads worktree this start did not cut keeps it and moves nothing", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { FAKE_INSTALL_FAIL: "1", NO_LEADS: "1", ROSTER_JSON: '{"agents":[]}' },
      undefined,
      undefined,
      (home) => {
        checkout(home)
        const factory = join(home, "code", "factory")
        git(factory, "worktree", "add", "-q", "--track", "-B", "leads", leads(home), "origin/main")
      },
    )
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("this start did not cut it, so it stays")
    expect(existsSync(leads(r.home))).toBe(true)
    expect(existsSync(join(r.home, ".playground", "trash"))).toBe(false)
  })

  test("a failed leads install that playground rm refuses keeps the worktree and names the refusal", async () => {
    const r = await spawn(
      ["manager", "optimizer", "b.md"],
      [],
      { FAKE_INSTALL_FAIL: "1", NO_LEADS: "1" },
      undefined,
      undefined,
      checkout,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("refused to move it, so it stays")
    expect(r.err).toContain("roster")
    expect(existsSync(leads(r.home))).toBe(true)
  })

  test.each(managers)(
    "$label with no leads worktree and no git checkout to cut it from is refused before herdr runs",
    async ({ args }) => {
      const r = await spawn(args, [], { NO_LEADS: "1" })
      expect(r.code).toBe(1)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("git worktree add")
      expect(r.err).toContain("/code/factory/.claude/worktrees/leads")
      expect(existsSync(leads(r.home))).toBe(false)
    },
  )

  test.each(managers)(
    "$label with a leads path that is not a folder is refused before herdr runs",
    async ({ args }) => {
      const r = await spawn(args, [], { NO_LEADS: "1" }, undefined, undefined, (home) => {
        checkout(home)
        mkdirSync(dirname(leads(home)), { recursive: true })
        writeFileSync(leads(home), "")
      })
      expect(r.code).toBe(1)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("/code/factory/.claude/worktrees/leads is not a folder")
    },
  )

  test(`a live ${OLD.dispatcher}-2 refuses a second start under its name`, async () => {
    const r = await spawn(
      ["manager", `${OLD.dispatcher}-2`, `brief-${OLD.dispatcher}-2.md`, "--backend", "glm"],
      [{ name: `${OLD.dispatcher}-2`, pid: 4100 }],
    )
    expect(r.code).toBe(3)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(`a live session already holds the name ${OLD.dispatcher}-2 (pid 4100)`)
  })

  test("a manager of another name is refused: a worker", async () => {
    const r = await spawn(["manager", "worker-brave-otter", "b.md", "--backend", "glm"], [])
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "a manager in a workspace of its own is the first dispatcher (sessions.names' dispatcher), the second (an <id>-dispatcher, or sessions.names' dispatcher with -2), the optimizer, the builder, ops or the planner",
    )
    expect(r.err).toContain("roster.ts set <name> kind=<kind>")
  })

  test.each([
    { label: "with no brief", args: ["manager", "optimizer"] },
    { label: "with a word after the brief", args: ["manager", "optimizer", "b.md", "extra"] },
  ])("a manager $label prints the usage before herdr runs", async ({ args }) => {
    const r = await spawn([...args], [])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("spawn.sh manager")
  })

  test("the usage prints whole: every mode from worker, every option to the runtime record's line, and --effort (#180)", async () => {
    const r = await spawn(["manager", "optimizer"], [])
    const lines = r.err
      .trimEnd()
      .split("\n")
      .filter((l) => !l.startsWith("spawn.sh: "))
    expect(lines[0]).toStartWith("  spawn.sh worker ")
    expect(r.err).toContain("  --effort <level> ")
    expect(lines.at(-1)).toStartWith("    The runtime is recorded at every start and resume")
  })

  // The optimizer is a manager that reports to OLD.dispatcher and runs on Claude (brief-optimizer.md), so it starts as a lead.
  test("the optimizer starts as a lead on Claude, reporting to the dispatcher", async () => {
    const r = await spawn(["manager", "optimizer", "brief-optimizer.md"], others(3))
    expect(r.code).toBe(0)
    expect(opened(r)).toEqual([
      "workspace",
      "create",
      "--cwd",
      leads(r.home),
      "--label",
      "optimizer",
      "--no-focus",
    ])
    const command = launchAfterRm(r)
    expect(command).toStartWith(
      "(env PLAYGROUND_ROLE=lead claude -n optimizer --model claude-opus-5-5 --effort high ",
    )
    expect(command).toContain(
      `You are optimizer, a lead in the Playground factory; you report to dispatcher.`,
    )
    expect(command).toContain("~/.playground/brief-optimizer.md")
    expect(command).toContain("(to: dispatcher)")
    expect(pinOf(r, "optimizer")).toBe("claude-code claude")
    expect(r.roster).toEqual([
      "set",
      "optimizer",
      "kind=optimizer",
      "surface=",
      "task=brief-optimizer.md",
      "memory=off",
    ])
  })

  test("a resume of the optimizer reopens it as a lead, on the backend its pin names", async () => {
    const r = await spawn(["resume", "optimizer", root], [], {}, undefined, {
      name: "optimizer",
      backend: "claude",
    })
    expect(r.code).toBe(0)
    expect(opened(r)).toEqual([
      "workspace",
      "create",
      "--cwd",
      root,
      "--label",
      "optimizer",
      "--no-focus",
    ])
    expect(launchAfterRm(r)).toStartWith(
      "(env PLAYGROUND_ROLE=lead claude --resume optimizer -n optimizer --model claude-opus-5-5 ",
    )
    expect(r.roster).toContain("kind=optimizer")
  })
})

// macOS types at most MAX_CANON 1024 bytes into a pane, and a GLM worker's launch crossed it at 1,025 (OLD.ops measured 17 Oct), so the launch runs from a file and the typed line names it alone.
describe("the typed launch line stays under the 1,024-byte typed-line limit", () => {
  // A name as long as herdr takes (32 characters) and a brief longer than any factory session carries, so the cap holds for whatever the leads write.
  const NAME = "worker-a-long-name-of-many-words"
  const BRIEF =
    "briefs/a-most-unusually-long-brief-file-name-no-lead-would-write-but-spawn-takes.md"
  const email = "acme@example.net"

  // Each row is one object: bun's test.each appends its done callback after a spread tuple, and a 4th tuple element would take it.
  const rows: {
    args: string[]
    files?: Record<string, string>
    label: string
    pin?: { name: string; backend: string }
  }[] = [
    { label: "a worker", args: ["worker", NAME, BRIEF] },
    { label: "a glm worker", args: ["worker", NAME, BRIEF, "--backend", "glm"] },
    { label: "an account worker", args: ["worker", NAME, BRIEF, "--account", email] },
    {
      label: "a checker column",
      args: [
        "column",
        "reviewer",
        "reviewer-long-name-of-many-words",
        "worker-x",
        "w1:p2",
        BRIEF,
        "--pr",
        "1",
      ],
    },
    {
      label: "a resume with a brief",
      args: ["resume", NAME, root, "--brief", "handoffs/restart-brief.md"],
      pin: { name: NAME, backend: "claude" },
      files: { BRIEF_FILE: "handoffs/restart-brief.md" },
    },
  ]
  test.each(rows)(
    "$label types a short line that names a 0700 file holding the launch",
    async ({ label, args, pin, files }) => {
      const r = await spawn(args, [], files ?? {}, undefined, pin)
      expect(r.code, r.err).toBe(0)
      const line = typed(r)
      expect(line.length).toBeLessThan(1_024)
      const name = label === "a checker column" ? String(args[2]) : String(args[1])
      const file = join(r.home, ".playground", "launch", `${name}.sh`)
      expect(line).toBe(`exec bash '${file}'`)
      expect(statSync(file).mode & 0o777).toBe(0o700)
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
      const launch = launchOf(r)
      expect(launch).toStartWith('rm -f -- "$0"\n')
      expect(launch).toContain("PLAYGROUND_ROLE=")
      expect(launch).toContain(
        label === "a resume with a brief" ? "handoffs/restart-brief.md" : BRIEF,
      )
      expect(launch).not.toContain(TOKEN)
      expect([...placing(r).flat(), r.out, r.err].join("\n")).not.toContain(TOKEN)
    },
  )
})

describe("a launch file removes itself once its launch starts", () => {
  test("so no past launch outlives its pane to be rerun past spawn.sh's refusals", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.code).toBe(0)
    const file = join(r.home, ".playground", "launch", "worker-brave-otter.sh")
    // The harness PATH, so the launch's claude is the fake and nothing real starts.
    const run = Bun.spawn(["bash", file], {
      env: { ...process.env, HOME: r.home, PATH: `${bin}:${process.env.PATH}` },
      stderr: "ignore",
      stdout: "ignore",
    })
    await run.exited
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(join(r.home, "claude.args"), "utf8")).toContain("-n worker-brave-otter")
  })
})

// The factory's hooks read PLAYGROUND_REPO before the session's own folder, so a session spawn.sh starts runs the main checkout's guards, from a worktree or outside any OLD.dispatcher checkout.
describe("a launch names the main checkout in PLAYGROUND_REPO", () => {
  test("spawn.sh run from a worktree names the checkout the worktree belongs to, and the session gets it", async () => {
    const main = realpathSync(mkdtempSync(join(scratch, "main-917-")))
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", ...args], { cwd: main, stderr: "ignore" }).exitCode).toBe(0)
    mkdirSync(join(main, "scripts"))
    writeFileSync(join(main, "scripts", "spawn.sh"), readFileSync(script))
    // A worker start's slots gate reads the checkout's own run-slot.sh.
    mkdirSync(join(main, "scripts", "ops"))
    writeFileSync(
      join(main, "scripts", "ops", "run-slot.sh"),
      readFileSync(join(root, "scripts", "ops", "run-slot.sh")),
    )
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
    const worktree = join(main, "wt")
    git("worktree", "add", "-q", "-b", "side", worktree)
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {},
      join(worktree, "scripts", "spawn.sh"),
    )
    expect(r.code, r.err).toBe(0)
    expect(opened(r)?.[3]).toBe(worktree)
    const launch = launchOf(r)
    expect(launch.split("\n")).toContain(`export PLAYGROUND_REPO=${main}`)
    // a claude that records the PLAYGROUND_REPO it was started with
    const shim = join(scratch, "bin-917")
    mkdirSync(shim, { recursive: true })
    writeFileSync(
      join(shim, "claude"),
      '#!/bin/bash\nprintf %s "$PLAYGROUND_REPO" > "$HOME/claude.repo"\n',
    )
    chmodSync(join(shim, "claude"), 0o755)
    const file = join(r.home, ".playground", "launch", "worker-brave-otter.sh")
    const run = Bun.spawn(["bash", file], {
      env: {
        ...process.env,
        HOME: r.home,
        PLAYGROUND_REPO: "",
        PATH: `${shim}:${bin}:${process.env.PATH}`,
      },
      stderr: "ignore",
      stdout: "ignore",
    })
    expect(await run.exited).toBe(0)
    expect(readFileSync(join(r.home, "claude.repo"), "utf8")).toBe(main)
  })
})
