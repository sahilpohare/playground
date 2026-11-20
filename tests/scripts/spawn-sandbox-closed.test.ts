import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import {
  bin,
  FACTORY_SETTINGS,
  LSTART,
  launchAfterRm,
  launchOf,
  placing,
  root,
  scratch,
  script,
  spawn,
  userTemp,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

const settingsOf = (r: { home: string }, file: string) => join(r.home, ".playground", file)
const builtOf = (r: { home: string }, file: string) =>
  JSON.parse(readFileSync(settingsOf(r, file), "utf8"))
// Each closed session builds a file of its own, since its allow list names its own worktree.
const closedFile = (name: string) => `factory-settings-sandbox-closed-400k-${name}.json`

// What git writes in a main checkout's common dir for a fetch, a commit and a push.
const gitWrites = (main: string) =>
  ["FETCH_HEAD", "logs", "objects", "refs"].map((entry) => join(main, ".git", entry))
// The main checkout spawn.sh resolves from this checkout, git's common dir less .git, and this checkout with its .git/worktrees entry when it is a linked worktree, where a probe or a resume here runs.
const gitOf = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", root, "rev-parse", "--path-format=absolute", ...args])
    .stdout.toString()
    .trim()
const main = dirname(gitOf("--git-common-dir"))
const here = [
  ...gitWrites(main),
  ...(gitOf("--git-dir") === join(main, ".git") ? [] : [realpathSync(root), gitOf("--git-dir")]),
]

// A main checkout of its own with spawn.sh in it and an origin on GitHub, so a fresh closed start makes its worktree here rather than in the checkout the suite runs from; it holds another session's worktree and a worktree a worker's --in can name.
const checkout = () => {
  const main = realpathSync(mkdtempSync(join(scratch, "main-2052-")))
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
  git("init", "-q", "-b", "canary")
  git("add", ".")
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x")
  git("branch", "main")
  git("remote", "add", "origin", "https://github.com/acme/app.git")
  for (const name of ["worker-other", "pg-9-x"])
    git("worktree", "add", "-q", "--detach", join(".claude", "worktrees", name))
  git("fetch", "-q", ".", "canary")
  // origin's GitHub URL fetches from a local mirror whose canary and PR heads have moved past the checkout's HEAD, with objects the checkout lacks, so a start's worktree shows the commit it was made at.
  const mirror = join(main, "..", `${main.split("/").pop()}-origin.git`)
  const ahead = `${mirror}-work`
  const run = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd,
      stderr: "ignore",
    })
  run(main, "clone", "-q", "--bare", main, mirror)
  run(main, "clone", "-q", mirror, ahead)
  run(ahead, "commit", "-q", "--allow-empty", "-m", "canary moved on")
  run(ahead, "push", "-q", "origin", "HEAD:refs/heads/canary")
  run(ahead, "commit", "-q", "--allow-empty", "-m", "a PR's head")
  run(ahead, "push", "-q", "origin", "HEAD:refs/pull/1/head", "HEAD:refs/pull/7/head")
  const shaOf = (ref: string) =>
    Bun.spawnSync(["git", "-C", mirror, "rev-parse", ref]).stdout.toString().trim()
  git("config", `url.${mirror}.insteadOf`, "https://github.com/acme/app.git")
  return {
    at: { canary: shaOf("refs/heads/canary"), pr: shaOf("refs/pull/1/head") },
    env: { PLAYGROUND_REPO: main },
    main,
    spawnSh: join(main, "scripts", "spawn.sh"),
  }
}
// The worktree a fresh closed start makes and runs in, with its .git/worktrees entry, and what git writes in the common dir.
const treeOf = (main: string, leaf: string) => join(main, ".claude", "worktrees", leaf)
const workOf = (main: string, leaf: string) => [
  treeOf(main, leaf),
  join(main, ".git", "worktrees", leaf),
  ...gitWrites(main),
]

// --sandbox starts a worker, a reviewer or a probe in the closed sandbox: the probe's block, with loopback, the Keychain and the data folder's secret files closed to its shell commands, outbound hosts held to the list a worker's loop needs, and the worktree it runs in writable.
const closedOf = (home: string, work: string[], data = join(home, ".playground")) => ({
  allowUnsandboxedCommands: false,
  enabled: true,
  enableWeakerNetworkIsolation: true,
  excludedCommands: ["docker ps", "docker ps *"],
  failIfUnavailable: true,
  filesystem: {
    allowWrite: [
      data,
      join(home, ".agent-browser"),
      join(home, ".bun", "install", "cache"),
      join(home, ".cache", "turbo"),
      join(home, ".portless"),
      userTemp,
      ...work,
    ].sort(),
    // the Keychain's folder on macOS and, on Linux, Claude Code's login file and the secret store's folder
    denyRead: [
      join(home, ".claude", ".credentials.json"),
      join(home, "Library", "Keychains"),
      join(data, "dumps"),
      join(data, "remote-key.json"),
      join(data, "secrets"),
      join(data, "whatsapp"),
    ].sort(),
    // the secret files refuse writes as well as reads, beside the probe's main-checkout and extensions-root entries
    denyWrite: expect.arrayContaining(
      ["dumps", "remote-key.json", "secrets", "whatsapp"].map((name) => join(data, name)),
    ),
  },
  network: {
    allowedDomains: ["api.github.com", "github.com", "registry.npmjs.org"],
    allowUnixSockets: [join(data, "herdr"), join(home, ".agent-browser")].sort(),
    strictAllowlist: true,
  },
})

// gpg needs writes to ~/.gnupg, which the closed sandbox keeps shut since gpg-agent runs the programs its config there names outside the sandbox, so a closed session's commits go unsigned through git's env config.
const UNSIGNED = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}

describe("--sandbox starts a worker, a reviewer or a probe in the closed sandbox", () => {
  const id = "b8f48a29-2ab2-4dc3-b37f-5a0525fe5c38"

  // A worker's start in a scratch checkout reads only, since that checkout holds no run-slot for the slots gate to read.
  test.each([
    [
      "a worker",
      "worker-brave-otter",
      "worker-brave-otter",
      ["worker", "worker-brave-otter", "b.md", "--reads-only", "--sandbox"],
    ],
    [
      "a reviewer's column",
      "reviewer-x",
      "review-1",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1", "--sandbox"],
    ],
  ])(
    "%s starts on the closed sandbox's file, and its row records it",
    async (_, name, leaf, args) => {
      const { env, main, spawnSh } = checkout()
      const r = await spawn(args, [], env, spawnSh)
      expect(r.code, r.err).toBe(0)
      expect(launchAfterRm(r)).toContain(
        ` --settings ${settingsOf(r, closedFile(name))} --dangerously-skip-permissions`,
      )
      expect(builtOf(r, closedFile(name))).toEqual({
        ...FACTORY_SETTINGS,
        autoCompactWindow: 400000,
        enabledPlugins: { "ws-home@ws": false },
        env: { ...FACTORY_SETTINGS.env, ...UNSIGNED },
        sandbox: closedOf(r.home, workOf(main, leaf)),
      })
      expect(r.roster).toContain("sandbox=on")
      expect(existsSync(settingsOf(r, "factory-settings-400k.json"))).toBe(false)
      expect(existsSync(settingsOf(r, "factory-settings-sandbox-400k.json"))).toBe(false)
    },
  )

  test.each([
    ["a probe", ["--sandbox", "probe", "probe-x", "ops", "p.md"]],
    ["a probe's column", ["column", "probe", "probe-x", "ops", "w1:p2", "p.md", "--sandbox"]],
  ])("%s starts on the closed sandbox's file in the folder it starts in today", async (_, args) => {
    const r = await spawn(args, [])
    expect(r.code, r.err).toBe(0)
    expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, closedFile("probe-x"))} `)
    expect(builtOf(r, closedFile("probe-x")).sandbox).toEqual(closedOf(r.home, here))
    expect(r.roster).toContain("sandbox=on")
  })

  test("a start without it records nothing new on its row", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.code, r.err).toBe(0)
    expect(r.roster?.some((word) => word.startsWith("sandbox="))).toBe(false)
  })

  // a respawn under the same name without the flag clears the row's sandbox=on, so a later resume or restore keeps the settings this start took
  test("a start without it over a row that records it clears the key and starts on the open file", async () => {
    const name = "worker-brave-otter"
    const r = await spawn(["worker", name, "b.md"], [], {
      ROSTER_JSON: JSON.stringify({
        agents: [{ kind: "worker", name, role: "worker", sandbox: "on", status: "ended" }],
      }),
    })
    expect(r.code, r.err).toBe(0)
    expect(r.roster).toContain("sandbox=")
    expect(r.roster).not.toContain("sandbox=on")
    expect(launchAfterRm(r)).toContain(
      ` --settings ${settingsOf(r, "factory-settings-400k.json")} `,
    )
  })

  test.each([
    [
      "a tester",
      ["column", "tester", "tester-x", "worker-x", "w1:p2", "t.md", "--pr", "1", "--sandbox"],
    ],
    ["a runner", ["runner", "runner-calm-heron", "b.md", "--sandbox"]],
    ["a manager", ["manager", "optimizer", "b.md", "--sandbox"]],
    ["a resume", ["resume", "worker-brave-otter", root, id, "--sandbox"]],
    ["a restore", ["restore", "--sandbox"]],
    ["a close", ["close", "worker-brave-otter", "--sandbox"]],
  ])("%s is refused it before herdr runs", async (_, args) => {
    const r = await spawn(args, [], {}, undefined, {
      name: "worker-brave-otter",
      backend: "claude",
    })
    expect(r.code).toBe(2)
    expect(r.err).toContain("--sandbox is for a worker's, a reviewer's or a probe's start")
    expect(r.roster).toBeUndefined()
  })

  test("a resumed worker whose row records it keeps the closed sandbox", async () => {
    const name = "worker-brave-otter"
    const r = await spawn(
      ["resume", name, root, id],
      [],
      {
        ROSTER_JSON: JSON.stringify({
          agents: [{ kind: "worker", name, role: "worker", sandbox: "on", status: "working" }],
        }),
      },
      undefined,
      { name, backend: "claude" },
    )
    expect(r.code, r.err).toBe(0)
    expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, closedFile(name))} `)
    expect(builtOf(r, closedFile(name)).sandbox).toEqual(closedOf(r.home, here))
    expect(r.roster).toContain("sandbox=on")
  })

  test("a resumed worker whose row records it is refused on Linux when bwrap cannot open the sandbox, before any pane opens", async () => {
    const name = "worker-brave-otter"
    const says = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
    const r = await spawn(
      ["resume", name, root, id],
      [],
      {
        FAKE_BWRAP_RC: "1",
        FAKE_BWRAP_SAYS: says,
        LINUX_GETCONF: "1",
        ROSTER_JSON: JSON.stringify({
          agents: [{ kind: "worker", name, role: "worker", sandbox: "on", status: "working" }],
        }),
      },
      undefined,
      { name, backend: "claude" },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `spawn.sh refuses ${name}: on this machine bwrap cannot open the sandbox's network namespace (${says})`,
    )
    expect(placing(r)).toEqual([])
  })

  // GLM's start reads settings this checkout's resolver alone holds, so it runs here, in a folder its --in names, where spawn.sh makes no worktree.
  test("a worker on GLM takes the closed sandbox in GLM's own file", async () => {
    const r = await spawn(
      [
        "worker",
        "worker-brave-otter",
        "b.md",
        "--backend",
        "glm",
        "--in",
        "{home}/code",
        "--sandbox",
      ],
      [],
    )
    expect(r.code, r.err).toBe(0)
    const built = builtOf(r, "factory-settings-glm-sandbox-closed-400k-worker-brave-otter.json")
    expect(built.sandbox).toEqual(closedOf(r.home, gitWrites(main)))
    expect(built.env).toMatchObject({ ...UNSIGNED, CLAUDE_CODE_ENABLE_TELEMETRY: "0" })
  })

  test("a worker on a scratch data folder has that folder's secret files closed", async () => {
    const { env, main, spawnSh } = checkout()
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--reads-only", "--sandbox"],
      [],
      { ...env, SCRATCH_DATA: "1" },
      spawnSh,
    )
    expect(r.code, r.err).toBe(0)
    const data = join(r.home, "scratch-data")
    const built = JSON.parse(readFileSync(join(data, closedFile("worker-brave-otter")), "utf8"))
    expect(built.sandbox).toEqual(closedOf(r.home, workOf(main, "worker-brave-otter"), data))
  })
})

// Claude Code's sandbox keeps the repository's .git/worktrees read-only but for the folder a session starts in, so a fresh closed worker or reviewer starts in a worktree spawn.sh makes for it; inside, it writes that worktree, its .git/worktrees entry, FETCH_HEAD, objects, refs and logs, but never main's or canary's ref, another session's worktree or the rest of .git (#2052).
describe("the closed sandbox lets a session work in its own worktree", () => {
  const filesystemOf = (home: string, name: string) =>
    JSON.parse(readFileSync(join(home, ".playground", closedFile(name)), "utf8")).sandbox
      .filesystem as { allowWrite: string[]; denyWrite: string[] }
  const under = (paths: string[]) => (path: string) =>
    paths.some((p) => path === p || path.startsWith(`${p}/`))
  // What a fetch, a branch made with git switch -c, a commit and a push write, measured in a scratch clone.
  const own = (main: string, leaf: string) => [
    treeOf(main, leaf),
    join(main, ".git", "worktrees", leaf),
    join(main, ".git", "FETCH_HEAD"),
    join(main, ".git", "objects", "pack"),
    join(main, ".git", "refs", "heads", "PG-1-x"),
    join(main, ".git", "refs", "remotes", "origin", "canary"),
    join(main, ".git", "logs", "refs", "heads", "PG-1-x"),
    join(main, ".git", "logs", "refs", "remotes", "origin", "canary"),
  ]
  // The branches the main checkout, the merge flow and the live dashboard (live.branch) follow, another session's worktree and the rest of .git and the checkout.
  const branchesOf = (main: string, live: string) =>
    ["canary", "main", live].flatMap((branch) => [
      join(main, ".git", "refs", "heads", branch),
      join(main, ".git", "logs", "refs", "heads", branch),
    ])
  const shut = (main: string) => [
    ...branchesOf(main, "live/dashboard"),
    treeOf(main, "worker-other"),
    join(main, ".git", "worktrees", "worker-other"),
    join(main, ".git", "config"),
    join(main, ".git", "HEAD"),
    join(main, ".git", "hooks"),
    join(main, ".git", "index"),
    join(main, ".git", "packed-refs"),
    join(main, "scripts"),
  ]
  // A worktree git lists, detached, and the launch moving into it.
  const startsIn = (r: { home: string }, main: string, leaf: string) => {
    const listed = Bun.spawnSync([
      "git",
      "-C",
      main,
      "worktree",
      "list",
      "--porcelain",
    ]).stdout.toString()
    expect(listed).toContain(`worktree ${treeOf(main, leaf)}\nHEAD `)
    expect(
      listed.split("\n\n").find((b) => b.startsWith(`worktree ${treeOf(main, leaf)}\n`)),
    ).toContain("\ndetached")
    expect(launchOf(r)).toContain(`\ncd ${treeOf(main, leaf)} || exit 1\n`)
  }

  test.each([
    [
      "a reviewer of this checkout's PR by its number, in its review clone",
      "reviewer-x",
      "review-1",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
    ],
    [
      "a reviewer of this checkout's PR by its URL, in its review clone",
      "reviewer-x",
      "review-7",
      [
        "column",
        "reviewer",
        "reviewer-x",
        "worker-x",
        "w1:p2",
        "r.md",
        "--pr",
        "https://github.com/acme/app/pull/7",
      ],
    ],
    [
      "a reviewer of another repo's PR, in a worktree by its name",
      "reviewer-x",
      "reviewer-x",
      [
        "column",
        "reviewer",
        "reviewer-x",
        "worker-x",
        "w1:p2",
        "r.md",
        "--pr",
        "https://github.com/acme/web/pull/7",
      ],
    ],
    [
      "a worker, in a worktree by its name",
      "worker-x",
      "worker-x",
      ["worker", "worker-x", "b.md", "--reads-only"],
    ],
  ])(
    "%s starts in a detached worktree spawn.sh makes, and writes it, its git entry, FETCH_HEAD, objects, refs and logs, and nothing of another session's",
    async (_, name, leaf, args) => {
      const { env, main, spawnSh } = checkout()
      const r = await spawn([...args, "--sandbox"], [], env, spawnSh)
      expect(r.code, r.err).toBe(0)
      startsIn(r, main, leaf)
      expect(launchAfterRm(r)).toContain(` --settings ${settingsOf(r, closedFile(name))} `)
      const { allowWrite, denyWrite } = filesystemOf(r.home, name)
      for (const path of own(main, leaf)) {
        expect(under(allowWrite)(path), path).toBe(true)
        expect(under(denyWrite)(path), path).toBe(false)
      }
      for (const path of shut(main)) expect(under(denyWrite)(path), path).toBe(true)
      expect(under(allowWrite)(treeOf(main, "worker-other"))).toBe(false)
      expect(under(allowWrite)(join(main, ".git", "worktrees", "worker-other"))).toBe(false)
    },
  )

  // issue 2059: the closed sandbox shuts .claude/ and skills/zerostarter/, which .claude/skills links to, so a checkout that changes either fails inside it; the worktree starts at the commit the session works from, so its first checkout changes no file.
  test.each([
    [
      "a reviewer of this checkout's PR by its number",
      "review-1",
      "pr",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
    ],
    [
      "a reviewer of this checkout's PR by its URL",
      "review-7",
      "pr",
      [
        "column",
        "reviewer",
        "reviewer-x",
        "worker-x",
        "w1:p2",
        "r.md",
        "--pr",
        "https://github.com/acme/app/pull/7",
      ],
    ],
    [
      "a reviewer of another repo's PR",
      "reviewer-x",
      "canary",
      [
        "column",
        "reviewer",
        "reviewer-x",
        "worker-x",
        "w1:p2",
        "r.md",
        "--pr",
        "https://github.com/acme/web/pull/7",
      ],
    ],
    ["a worker", "worker-x", "canary", ["worker", "worker-x", "b.md", "--reads-only"]],
  ] as const)(
    "%s starts its worktree at the commit it works from, fetched from origin",
    async (_, leaf, from, args) => {
      const { at, env, main, spawnSh } = checkout()
      const r = await spawn([...args, "--sandbox"], [], env, spawnSh)
      expect(r.code, r.err).toBe(0)
      const head = Bun.spawnSync(["git", "-C", treeOf(main, leaf), "rev-parse", "HEAD"])
        .stdout.toString()
        .trim()
      expect(head).toBe(at[from])
    },
  )

  test("a reviewer of a PR whose head origin lacks is refused, with no worktree made", async () => {
    const { env, main, spawnSh } = checkout()
    const r = await spawn(
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "9", "--sandbox"],
      [],
      env,
      spawnSh,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "git ls-remote origin refs/pull/9/head read no commit, so reviewer-x has no commit to start its worktree at",
    )
    expect(existsSync(treeOf(main, "review-9"))).toBe(false)
  })

  // GitHub makes a PR's pull ref a little after the PR opens (#2389): origin holds the PR's branch alone, at the head the mirror's PR commit is
  const branchOnly = () => {
    const made = checkout()
    const mirror = join(made.main, "..", `${made.main.split("/").pop()}-origin.git`)
    Bun.spawnSync(["git", "-C", mirror, "update-ref", "refs/heads/pg-11-x", made.at.pr])
    return made
  }
  const reviewEleven = [
    "column",
    "reviewer",
    "reviewer-x",
    "worker-x",
    "w1:p2",
    "r.md",
    "--pr",
    "11",
    "--sandbox",
  ]

  test("a reviewer of a PR whose pull ref origin lacks yet starts at its branch, at the head GitHub names (#2389)", async () => {
    const { at, env, main, spawnSh } = branchOnly()
    const r = await spawn(reviewEleven, [], { ...env, FAKE_GH_PR: `pg-11-x ${at.pr}` }, spawnSh)
    expect(r.code, r.err).toBe(0)
    const head = Bun.spawnSync(["git", "-C", treeOf(main, "review-11"), "rev-parse", "HEAD"])
      .stdout.toString()
      .trim()
    expect(head).toBe(at.pr)
  })

  test("a reviewer of a PR whose branch is not at the head GitHub names is refused, with no worktree made (#2389)", async () => {
    const { at, env, main, spawnSh } = branchOnly()
    const r = await spawn(reviewEleven, [], { ...env, FAKE_GH_PR: `pg-11-x ${at.canary}` }, spawnSh)
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `refs/pull/11/head is missing, and its branch pg-11-x is at ${at.pr.slice(0, 7)}, not the head ${at.canary.slice(0, 7)}, so reviewer-x has no commit to start its worktree at`,
    )
    expect(existsSync(treeOf(main, "review-11"))).toBe(false)
  })

  test("a worker whose --in names a worktree starts there, with no worktree made, and writes it and its git entry", async () => {
    const { env, main, spawnSh } = checkout()
    const tree = treeOf(main, "pg-9-x")
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--in", tree, "--reads-only", "--sandbox"],
      [],
      env,
      spawnSh,
    )
    expect(r.code, r.err).toBe(0)
    expect(existsSync(treeOf(main, "worker-brave-otter"))).toBe(false)
    expect(launchOf(r)).toContain(`\ncd ${tree} || exit 1\n`)
    const { allowWrite, denyWrite } = filesystemOf(r.home, "worker-brave-otter")
    for (const path of own(main, "pg-9-x")) {
      expect(under(allowWrite)(path), path).toBe(true)
      expect(under(denyWrite)(path), path).toBe(false)
    }
    for (const path of shut(main)) expect(under(denyWrite)(path), path).toBe(true)
  })

  test("a live.branch of its own stays shut in place of the default", async () => {
    const { env, main, spawnSh } = checkout()
    const r = await spawn(
      ["worker", "worker-x", "b.md", "--reads-only", "--sandbox"],
      [],
      { ...env, SETTINGS_JSON: JSON.stringify({ "live.branch": "live/board" }) },
      spawnSh,
    )
    expect(r.code, r.err).toBe(0)
    const { allowWrite, denyWrite } = filesystemOf(r.home, "worker-x")
    for (const path of branchesOf(main, "live/board")) {
      expect(under(allowWrite)(path), path).toBe(true)
      expect(under(denyWrite)(path), path).toBe(true)
    }
    expect(under(denyWrite)(join(main, ".git", "refs", "heads", "live", "dashboard"))).toBe(false)
  })

  test("a start without --sandbox makes no worktree", async () => {
    const { env, main, spawnSh } = checkout()
    const r = await spawn(["worker", "worker-x", "b.md", "--reads-only"], [], env, spawnSh)
    expect(r.code, r.err).toBe(0)
    expect(existsSync(treeOf(main, "worker-x"))).toBe(false)
  })

  // The file holds the session's own worktree, so each start writes its own, and a later start never rewrites the file a live session runs on.
  test("two starts write two files, each holding its own session's worktree alone", async () => {
    const { env, main, spawnSh } = checkout()
    // the memory trial alternates a worker's arm, and its arm on names a file of its own, so both starts keep it off
    const start = ["b.md", "--memory", "off", "--reads-only", "--sandbox"]
    const first = (home: string) => {
      const run = Bun.spawnSync(
        ["bash", spawnSh, "--title", "Plain test work", "worker", "worker-one", ...start],
        { env: { FAKE_LSTART: LSTART, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } },
      )
      expect(run.exitCode, run.stderr.toString()).toBe(0)
    }
    const r = await spawn(["worker", "worker-x", ...start], [], env, spawnSh, undefined, first)
    expect(r.code, r.err).toBe(0)
    const x = filesystemOf(r.home, "worker-x")
    const one = filesystemOf(r.home, "worker-one")
    expect(under(x.allowWrite)(treeOf(main, "worker-x"))).toBe(true)
    expect(under(x.denyWrite)(treeOf(main, "worker-one"))).toBe(true)
    expect(under(one.allowWrite)(treeOf(main, "worker-one"))).toBe(true)
    expect(under(one.allowWrite)(treeOf(main, "worker-x"))).toBe(false)
    expect(
      existsSync(join(r.home, ".playground", "factory-settings-sandbox-closed-400k.json")),
    ).toBe(false)
  })
})

// The closed sandbox refuses every Keychain read, so a start from inside it cannot tell an --account's item is there; the new pane's shell, outside the sandbox, still stops on a missing one before claude runs.
describe("a start from inside the sandbox leaves the Keychain check to the new pane", () => {
  const inside = { FAKE_NO_ITEM: "1", SANDBOX_RUNTIME: "1" }

  test("a Claude --account starts, naming the check it left", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "spare@example.com"],
      [],
      inside,
    )
    expect(r.code, r.err).toBe(0)
    expect(r.err).toContain(
      "the sandbox closes the Keychain to this shell, so the new pane checks the playground-claude-oauth item for spare@example.com",
    )
  })

  test("a GLM key starts, naming the check it left", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--backend", "glm"], [], inside)
    expect(r.code, r.err).toBe(0)
    expect(r.err).toContain(
      "the sandbox closes the Keychain to this shell, so the new pane checks the playground-glm item for zai",
    )
  })

  test("outside the sandbox a missing item is still refused", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--account", "spare@example.com"],
      [],
      { FAKE_NO_ITEM: "1" },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "the Keychain holds no playground-claude-oauth item for spare@example.com",
    )
  })
})
