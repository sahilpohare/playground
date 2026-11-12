import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mainCheckout } from "../../../scripts/hooks/no-main-checkout"
import { roleOfName, sessionRole } from "../../../scripts/hooks/role"
import { OLD_NAMES } from "../../session-names"
import { storeWith } from "./render-set"

const root = join(import.meta.dir, "..", "..", "..")
let config = ""

beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), "role-"))
  await Bun.write(
    join(config, "sessions", "1.json"),
    JSON.stringify({ name: "builder", pid: 1, sessionId: "s-restored" }),
  )
  await Bun.write(
    join(config, "sessions", "2.json"),
    JSON.stringify({ name: "notes", pid: 2, sessionId: "s-own" }),
  )
  // The second dispatcher as cmux restores it: in the registry by name, with no PLAYGROUND_ROLE.
  await Bun.write(
    join(config, "sessions", "3.json"),
    JSON.stringify({ name: "dispatcher-2", pid: 3, sessionId: "s-second" }),
  )
  // A session whose name carries no role, placed by its roster kind alone.
  await Bun.write(
    join(config, "sessions", "4.json"),
    JSON.stringify({ name: "k3v9q2-reviewer", pid: 4, sessionId: "s-kinded" }),
  )
  // A manager respawned under a new name (a later PR), placed by its roster kind.
  await Bun.write(
    join(config, "sessions", "5.json"),
    JSON.stringify({ name: "x7mh4d-builder", pid: 5, sessionId: "s-builder" }),
  )
  await Bun.write(
    join(config, "playground", "roster.json"),
    JSON.stringify({
      agents: [
        { kind: "reviewer", name: "k3v9q2-reviewer", role: "worker", worker: "x7mh4d-worker" },
        { kind: "wizard", name: "notes", role: "worker" },
        { kind: "builder", name: "x7mh4d-builder", role: "manager", status: "working" },
      ],
    }),
  )
  // A machine past the switch, so a hook that reads the names places the old ones too.
  storeWith(
    join(config, "playground"),
    {},
    { "ext.repos": { acme: "quillco/acme-skills" }, "sessions.aliases": OLD_NAMES },
  )
})

afterAll(async () => {
  await rm(config, { force: true, recursive: true })
})

describe("a session's factory role", () => {
  test.each([
    ["dispatcher", "dispatcher"],
    ["dispatcher-2", "dispatcher"],
    ["dispatcher", "dispatcher"],
    ["dispatcher-2", "dispatcher"],
    ["dispatcher-3", ""],
    ["builder", "lead"],
    ["optimizer", "lead"],
    ["planner", "lead"],
    ["worker-brave-otter", "worker"],
    ["reviewer-brave-otter", "reviewer"],
    ["probe-sdk", "probe"],
    ["notes", ""],
    ["worker-", ""],
    ["k3m9px-worker", "worker"],
    ["k3m9px-tester", "tester"],
    ["k3m9px-researcher", "worker"],
    ["k3m9px-builder", "lead"],
    ["k3m9px-wizard", ""],
    ["kemapx-worker", ""],
  ])("%s reads as %p", (name, role) => {
    expect(roleOfName(name)).toBe(role)
  })

  // every guard imports role.ts from the main checkout and fails open, so it reads @packages/config's and @packages/env's source, never a dist a failed build left stale or missing
  test("places a name from a checkout whose packages were never built", async () => {
    const bare = await mkdtemp(join(tmpdir(), "role-bare-"))
    try {
      for (const path of [
        "scripts/hooks/role.ts",
        "packages/config/src/kinds.ts",
        "packages/env/src/aliases.ts",
        "packages/env/src/data-dir.ts",
      ]) {
        await Bun.write(join(bare, path), Bun.file(join(root, path)))
      }
      const run = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { roleOfName } from "./scripts/hooks/role"; console.log(roleOfName("builder"))`,
        ],
        { cwd: bare },
      )
      expect(run.stderr.toString()).toBe("")
      expect(run.stdout.toString().trim()).toBe("lead")
    } finally {
      await rm(bare, { force: true, recursive: true })
    }
  })

  test("PLAYGROUND_ROLE wins, else the registry name, else none", async () => {
    expect(
      await sessionRole(
        {
          CLAUDE_CONFIG_DIR: config,
          PLAYGROUND_DATA_DIR: join(config, "playground"),
          PLAYGROUND_ROLE: "worker",
        },
        "s-own",
      ),
    ).toBe("worker")
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        "s-restored",
      ),
    ).toBe("lead")
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        "s-second",
      ),
    ).toBe("dispatcher")
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        "s-own",
      ),
    ).toBe("")
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        undefined,
      ),
    ).toBe("")
    expect(
      await sessionRole(
        {
          CLAUDE_CONFIG_DIR: join(config, "nowhere"),
          PLAYGROUND_DATA_DIR: join(join(config, "nowhere"), "playground"),
        },
        "s-restored",
      ),
    ).toBe("")
  })

  // A Codex session writes no Claude registry file: its name is its thread's, the last line for its id in CODEX_HOME's session_index.jsonl, as codex app-server's thread/name/set writes it (measured on codex-cli 0.167.1).
  test("a Codex session resumed with no PLAYGROUND_ROLE reads its role from its thread's name", async () => {
    const codex = join(config, "codex")
    const thread = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"
    await Bun.write(
      join(codex, "session_index.jsonl"),
      [
        { id: thread, thread_name: "notes", updated_at: "2026-11-11T09:00:00Z" },
        { id: "01a1c9e5-2922-7d80-938b-4d9553bcd7fe", thread_name: "builder", updated_at: "x" },
        { id: thread, thread_name: "dispatcher", updated_at: "2026-11-11T09:01:00Z" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    )
    const environment = {
      CLAUDE_CONFIG_DIR: config,
      CODEX_HOME: codex,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
    }
    expect(await sessionRole(environment, thread)).toBe("dispatcher")
    expect(await sessionRole(environment, "0f9a1c2e-0000-4e5f-8a6b-7c8d9e0f1a2b")).toBe("")
    expect(await sessionRole({ ...environment, CODEX_HOME: join(codex, "none") }, thread)).toBe("")
    // a Claude session's registry name still comes first
    expect(await sessionRole(environment, "s-restored")).toBe("lead")
  })

  test("a name with no role reads its roster kind; a kind off the list reads as none", async () => {
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        "s-kinded",
      ),
    ).toBe("reviewer")
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        "s-builder",
      ),
    ).toBe("lead")
    expect(
      await sessionRole(
        { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
        "s-own",
      ),
    ).toBe("")
  })
})

// Each hook the project settings load for every session in a playground checkout acts for a factory session alone, so the owner's own sessions pass untouched.
describe("a hook that guards the factory passes a session with no factory role", () => {
  const leaky = {
    tool_input: { text: "dispatcher" },
    tool_name: "mcp__slack-shared__chat_post_message",
  }
  const bash = (command: string, cwd = root) => ({
    cwd,
    tool_input: { command },
    tool_name: "Bash",
  })
  const cases: [string, object][] = [
    ["no-env-dump", bash("env")],
    ["no-extension-repo-write", bash("gh repo delete quillco/acme-skills --yes")],
    ["no-extensions-write", bash("playground ext put login list x /tmp/l.json --reason y")],
    ["no-false-green", bash("bun test x | tail")],
    // split, since tests/test_kill_by_name.py reads the repo's text for the whole name
    ["no-kill-by-name", bash("p" + "kill node")],
    ["no-playground-leak", leaky],
    ["no-main-checkout", bash("lefthook run pre-commit", mainCheckout(root))],
    ["no-ours-merge", bash("git merge -s ours origin/canary")],
    ["no-prompt-stop", bash("rm -rf $S/$m")],
    ["no-raw-spawn", bash("cmux new-workspace --command claude")],
    ["no-stash", bash("git stash pop")],
  ]

  const run = async (hook: string, payload: object, env: Record<string, string>) => {
    const { PLAYGROUND_ROLE: _role, ...inherited } = process.env
    const proc = Bun.spawn(["bun", "--no-env-file", join(root, "scripts", "hooks", `${hook}.ts`)], {
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        ...env,
      },
      stderr: "pipe",
      stdin: new Blob([JSON.stringify(payload)]),
    })
    return proc.exited
  }

  test.each(cases)(
    "%s refuses a factory session by its role or by its registry name",
    async (hook, payload) => {
      expect(await run(hook, payload, { PLAYGROUND_ROLE: "worker" })).toBe(2)
      expect(await run(hook, { ...payload, session_id: "s-restored" }, {})).toBe(2)
    },
  )

  test.each(cases)(
    "%s refuses a restored session its roster kind places in the factory",
    async (hook, payload) => {
      expect(await run(hook, { ...payload, session_id: "s-kinded" }, {})).toBe(2)
    },
  )

  test("no-playground-leak refuses a restored dispatcher-2 by its registry name", async () => {
    expect(await run("no-playground-leak", { ...leaky, session_id: "s-second" }, {})).toBe(2)
  })

  test.each(cases)(
    "%s passes a session with no role and no factory name",
    async (hook, payload) => {
      expect(await run(hook, { ...payload, session_id: "s-own" }, {})).toBe(0)
      expect(await run(hook, payload, {})).toBe(0)
    },
  )
})
