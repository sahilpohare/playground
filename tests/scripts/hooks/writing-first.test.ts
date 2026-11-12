import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check, SKILL } from "../../../scripts/hooks/writing-first"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "writing-first.ts")
const BASE = mkdtempSync(join(tmpdir(), "writing-first-"))
afterAll(() => rmSync(BASE, { force: true, recursive: true }))

const make = (path: string, text = "x") => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

// a playground checkout, a linked worktree of it, another repository, and a Claude config folder with the skill installed
const REPO = join(BASE, "dispatcher")
mkdirSync(join(REPO, ".git"), { recursive: true })
make(join(REPO, "extensions", "core", "skills", "playbook", "SKILL.md"))
make(
  join(REPO, "skills", "zerostarter", "dev", "SKILL.md"),
  "---\nname: dev\nsource: https://github.com/acme/zerostarter\n---\n",
)
make(
  join(REPO, "skills", "zerostarter", "portless", "SKILL.md"),
  "---\nname: portless\nsource: portless\n---\n",
)
// .agents/skills links to skills/zerostarter, as in the checkout
mkdirSync(join(REPO, ".agents"), { recursive: true })
symlinkSync(join("..", "skills", "zerostarter"), join(REPO, ".agents", "skills"))
const WORKTREE = join(REPO, ".claude", "worktrees", "a")
make(join(WORKTREE, ".git"), "gitdir: ../../../.git/worktrees/a")
make(join(WORKTREE, "extensions", "core", "skills", "playbook", "SKILL.md"))
const OTHER = join(BASE, "other")
mkdirSync(join(OTHER, ".git"), { recursive: true })
const CONFIG = join(BASE, "config")
make(join(CONFIG, "skills", SKILL, "SKILL.md"))
mkdirSync(join(CONFIG, "playground"), { recursive: true })
const BARE_CONFIG = join(BASE, "bare-config")
mkdirSync(BARE_CONFIG, { recursive: true })
// a config folder whose only copy is an installed plugin's, as once the user-scope copy is retired
const PLUGIN_CONFIG = join(BASE, "plugin-config")
const PLUGIN = join(BASE, "plugin-cache", "ws-home")
make(join(PLUGIN, "skills", SKILL, "SKILL.md"))
const plugged = (name: string, installs: Record<string, unknown>[], enabled: unknown = true) => {
  const config = join(BASE, name)
  make(
    join(config, "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: { "ws-home@ws": installs.map((i) => ({ installPath: PLUGIN, ...i })) },
    }),
  )
  make(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "ws-home@ws": enabled } }))
  mkdirSync(join(config, "playground"), { recursive: true })
  return config
}
make(join(PLUGIN_CONFIG, "plugins", "installed_plugins.json"), "{}")
const USER_PLUGIN = plugged("plugin-user", [{ scope: "user" }])
const DISABLED_PLUGIN = plugged("plugin-disabled", [{ scope: "user" }], false)
const PROJECT_PLUGIN = plugged("plugin-project", [{ projectPath: REPO, scope: "project" }])
const ELSEWHERE_PLUGIN = plugged("plugin-elsewhere", [{ projectPath: OTHER, scope: "project" }])
const LINKED = join(BASE, "linked-skills")
mkdirSync(LINKED, { recursive: true })
mkdirSync(join(REPO, "skills", "playground"), { recursive: true })
symlinkSync(join(REPO, "skills", "playground"), join(LINKED, "engineering"))

let next = 0
const session = () => `session-${++next}`

const event = (input: Record<string, unknown>, config = CONFIG) =>
  check(JSON.stringify({ cwd: REPO, ...input }), {
    CLAUDE_CONFIG_DIR: config,
    PLAYGROUND_DATA_DIR: join(config, "playground"),
    HOME: "/u",
  })

const write = (id: string, path: string, extra: Record<string, unknown> = {}, tool = "Write") =>
  event({
    hook_event_name: "PreToolUse",
    session_id: id,
    tool_input: { content: "x", file_path: path },
    tool_name: tool,
    ...extra,
  })

const load = (id: string, extra: Record<string, unknown> = {}) =>
  event({
    hook_event_name: "PreToolUse",
    session_id: id,
    tool_input: { skill: SKILL },
    tool_name: "Skill",
    ...extra,
  })

const AGENT = { agent_id: "a1b2c3", agent_type: "general-purpose" }

const bash = (id: string, command: string) =>
  event({
    hook_event_name: "PreToolUse",
    session_id: id,
    tool_input: { command },
    tool_name: "Bash",
  })

// A Codex session sends an edit in two shapes, an apply_patch call or an apply_patch command run in the shell, and loads a skill by reading its SKILL.md through the shell, since it has no Skill call (codex-cli 0.167.1).
const CODEX = {
  model: "gpt-made-up",
  tool_use_id: "call-1",
  transcript_path: null,
  turn_id: "turn-1",
}
const patch = (path: string) =>
  `*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`
const codexEdit = (id: string, path: string) =>
  event({
    ...CODEX,
    hook_event_name: "PreToolUse",
    session_id: id,
    tool_input: { command: patch(path) },
    tool_name: "apply_patch",
  })
const codexShellEdit = (id: string, path: string) =>
  event({
    ...CODEX,
    hook_event_name: "PreToolUse",
    session_id: id,
    tool_input: { command: `apply_patch <<'EOF'\n${patch(path)}\nEOF` },
    tool_name: "Bash",
  })
const codexBash = (id: string, command: string) =>
  event({
    ...CODEX,
    hook_event_name: "PreToolUse",
    session_id: id,
    tool_input: { command },
    tool_name: "Bash",
  })

describe("a Codex session's edit of an agent-facing doc waits for writing-for-agents", () => {
  test("an apply_patch call and an apply_patch command in the shell are each refused before the load", async () => {
    const id = session()
    expect(await codexEdit(id, "AGENTS.md")).toContain("writing-first hook refuses")
    expect(await codexShellEdit(id, "scripts/hooks/README.md")).toContain(
      "writing-first hook refuses",
    )
    expect(await codexEdit(id, "notes.txt")).toBeUndefined()
  })

  test("its shell read of writing-for-agents' SKILL.md is the load", async () => {
    const id = session()
    expect(await codexBash(id, `cat ${join(CONFIG, "skills", SKILL, "SKILL.md")}`)).toBeUndefined()
    expect(await codexEdit(id, "AGENTS.md")).toBeUndefined()
    expect(await codexShellEdit(id, "scripts/hooks/README.md")).toBeUndefined()
  })

  test("a shell line that only names the skill's file is no load", async () => {
    const id = session()
    expect(await codexBash(id, `echo ${SKILL}/SKILL.md`)).toBeUndefined()
    expect(await codexEdit(id, "AGENTS.md")).toContain("writing-first hook refuses")
  })
})

describe("a Bash call's direct write to an agent-facing doc waits for writing-for-agents too", () => {
  test.each([
    ["a redirect", "echo x > AGENTS.md"],
    [
      "an appending redirect by absolute path",
      `echo x >> ${join(REPO, "scripts", "hooks", "README.md")}`,
    ],
    ["a redirect after a cd", "cd docs && echo x > playground/end-of-day.md"],
    ["tee", "printf x | tee docs/playground/end-of-day.md"],
    ["cp", "cp /tmp/x skills/playground/end-of-day/SKILL.md"],
    ["mv", "mv /tmp/x .agents/dashboard/stack.md"],
    ["an in-place sed", "sed -i '' 's/a/b/' AGENTS.md"],
    ["an inline interpreter script", `python3 -c "open('AGENTS.md', 'w').write('x')"`],
    [
      "an inline script by absolute path",
      `bun -e 'await Bun.write("${join(REPO, "scripts", "README.md")}", "x")'`,
    ],
    [
      "a heredoc-fed interpreter script",
      `python3 - <<'PY'\nopen("scripts/hooks/README.md", "w").write("x")\nPY`,
    ],
    [
      "an inline script handed the doc as an argument",
      `python3 - docs/playground/x.md <<'PY'\nimport sys\nopen(sys.argv[1], "w").write("x")\nPY`,
    ],
    ["install", "install -m 644 /tmp/x scripts/README.md"],
    ["an in-place perl", "perl -pi -e 's/a/b/' AGENTS.md"],
    ["cp into the repo root", "cp /tmp/AGENTS.md ."],
    ["cp into docs/", "cp /tmp/a.md docs/"],
    ["mv into the hooks folder", "mv /tmp/README.md scripts/hooks/"],
    ["mv into the dashboard rules", "mv /tmp/stack.md .agents/dashboard"],
    ["install into the repo root", "install -m 644 /tmp/AGENTS.md ."],
    ["cp -t into a folder", "cp -t docs/playground /tmp/x.md"],
    ["python's code attached to -c", `python3 -c"open('AGENTS.md', 'w').write('x')"`],
    ["python's -c in a cluster", `python3 -Ic "open('AGENTS.md', 'w').write('x')"`],
    [
      "python's -c after a valued option",
      `python3 -W ignore -c "open('AGENTS.md', 'w').write('x')"`,
    ],
    ["node's --eval=", `node --eval="require('fs').writeFileSync('AGENTS.md', 'x')"`],
    ["node's -pe", `node -pe "require('fs').writeFileSync('AGENTS.md', 'x')"`],
    ["deno eval", `deno eval "Deno.writeTextFileSync('AGENTS.md', 'x')"`],
  ])("%s", async (_, command) => {
    const reason = (await bash(session(), command)) ?? ""
    expect(reason).toContain("writing-first hook refuses this Bash")
    expect(reason).toContain(`Call the Skill tool with skill "${SKILL}"`)
  })

  test("the same write runs once the session holds the mark", async () => {
    const id = session()
    await load(id)
    expect(await bash(id, "echo x > AGENTS.md")).toBeUndefined()
    expect(await bash(id, `python3 -c "open('AGENTS.md', 'w').write('x')"`)).toBeUndefined()
  })

  test.each([
    ["a git checkout of a doc", "git checkout origin/canary -- AGENTS.md scripts/README.md"],
    ["a git merge", "git merge --no-edit origin/canary"],
    ["a git restore", "git restore skills/playground/end-of-day/SKILL.md"],
    ["bun run format", "bun run format"],
    ["a repo script by name", "bun run docs:wrap"],
    ["a repo script by path, handed a doc", "bun packages/scripts/src/docs-wrap/cli.ts AGENTS.md"],
    ["a read", "cat AGENTS.md > /dev/null"],
    ["a redirect to a file that is not agent-facing", "echo x > README.md"],
    ["a redirect outside the repository", "echo x > /tmp/AGENTS.md"],
    ["a script run by name", "python3 tools/fix.py AGENTS.md"],
    ["a module run by name", "python3 -m tools.fix AGENTS.md"],
    ["a copy of a doc out to a folder elsewhere", "cp AGENTS.md /tmp/"],
    ["a line the hook cannot read", 'echo x > "$(pick-a-doc)"'],
  ])("%s runs", async (_, command) => {
    expect(await bash(session(), command)).toBeUndefined()
  })
})

describe("an agent-facing doc waits for writing-for-agents", () => {
  test.each([
    ["a skill", join(REPO, "skills", "playground", "end-of-day", "SKILL.md")],
    ["a skill's sibling file", join(REPO, "skills", "playground", "code-review-loop", "VERIFY.md")],
    ["a new skill in a new folder", join(REPO, "skills", "in-progress", "fresh", "SKILL.md")],
    ["one of core's own skills", join(REPO, "extensions", "core", "skills", "pr", "SKILL.md")],
    ["a core rule", join(REPO, "extensions", "core", "rules", "signal.md")],
    ["one of our .agents skills", join(REPO, ".agents", "skills", "dev", "SKILL.md")],
    ["a new .agents skill", join(REPO, ".agents", "skills", "fresh", "SKILL.md")],
    ["a ZeroStarter skill by its own path", join(REPO, "skills", "zerostarter", "dev", "SKILL.md")],
    ["a dashboard rule", join(REPO, ".agents", "dashboard", "stack.md")],
    ["the invocation rules", join(REPO, ".agents", "invocation.md")],
    ["the docs-page guide", join(REPO, ".agents", "writing-docs.md")],
    ["the skill trial", join(REPO, ".agents", "skill-trial.md")],
    ["a new .agents guide", join(REPO, ".agents", "fresh.md")],
    ["AGENTS.md", join(REPO, "AGENTS.md")],
    ["CLAUDE.md", join(REPO, "CLAUDE.md")],
    ["a docs page", join(REPO, "docs", "playground", "end-of-day.md")],
    ["the scripts README", join(REPO, "scripts", "README.md")],
    ["the hooks README", join(REPO, "scripts", "hooks", "README.md")],
    ["a skill in a worktree", join(WORKTREE, "skills", "playground", "end-of-day", "SKILL.md")],
    ["AGENTS.md in a worktree", join(WORKTREE, "AGENTS.md")],
    ["a skill reached through a symlink", join(LINKED, "engineering", "end-of-day", "SKILL.md")],
    ["a handoff", join(CONFIG, "playground", "handoffs", "worker-skills.md")],
  ])("%s", async (_, path) => {
    expect(await write(session(), path)).toContain("writing-first hook refuses")
  })

  test.each(["Edit", "MultiEdit"])("through %s too", async (tool) => {
    expect(await write(session(), join(REPO, "AGENTS.md"), {}, tool)).toContain(
      "writing-first hook refuses",
    )
  })

  test("the refusal names the fix", async () => {
    const reason = (await write(session(), join(REPO, "AGENTS.md"))) ?? ""
    expect(reason).toContain(`Call the Skill tool with skill "${SKILL}"`)
    expect(reason).toContain(
      `or the scoped name your skill list shows for it (such as "ws-home:${SKILL}")`,
    )
    expect(reason).toContain("then retry")
    expect(reason).toContain("AGENTS.md")
    // a compaction clears the mark, so a refused session knows the load is wanted again
    expect(reason).toContain("since its last compaction")
  })
})

describe("loading the skill lets the session write", () => {
  test("through the Skill tool", async () => {
    const id = session()
    expect(await load(id)).toBeUndefined()
    expect(await write(id, join(REPO, "AGENTS.md"))).toBeUndefined()
    expect(await write(id, join(CONFIG, "playground", "handoffs", "h.md"))).toBeUndefined()
  })

  test("through a typed /writing-for-agents", async () => {
    const id = session()
    expect(
      await event({
        hook_event_name: "UserPromptSubmit",
        prompt: `/${SKILL} tighten this`,
        session_id: id,
      }),
    ).toBeUndefined()
    expect(await write(id, join(REPO, "AGENTS.md"))).toBeUndefined()
  })

  test("a prompt that only names the skill loads nothing", async () => {
    const id = session()
    await event({
      hook_event_name: "UserPromptSubmit",
      prompt: `use ${SKILL} later`,
      session_id: id,
    })
    expect(await write(id, join(REPO, "AGENTS.md"))).toContain("writing-first hook refuses")
  })

  for (const skill of ["ws-home:writing-for-agents", "apps/web:writing-for-agents"])
    test(`through a scoped copy, ${skill}`, async () => {
      const id = session()
      await load(id, { tool_input: { skill } })
      expect(await write(id, join(REPO, "AGENTS.md"))).toBeUndefined()
    })

  test("through a typed scoped /ws-home:writing-for-agents", async () => {
    const id = session()
    await event({
      hook_event_name: "UserPromptSubmit",
      prompt: `/ws-home:${SKILL} tighten this`,
      session_id: id,
    })
    expect(await write(id, join(REPO, "AGENTS.md"))).toBeUndefined()
  })

  for (const skill of [
    "code-review",
    "writing-for-agents-x",
    "x:writing-for-agents-y",
    "x-writing-for-agents",
    "ws-home:",
  ])
    test(`another skill loads nothing: ${skill}`, async () => {
      const id = session()
      await load(id, { tool_input: { skill } })
      expect(await write(id, join(REPO, "AGENTS.md"))).toContain("writing-first hook refuses")
    })

  test("a typed near miss loads nothing", async () => {
    const id = session()
    await event({
      hook_event_name: "UserPromptSubmit",
      prompt: `/x:${SKILL}-y now`,
      session_id: id,
    })
    expect(await write(id, join(REPO, "AGENTS.md"))).toContain("writing-first hook refuses")
  })

  test("another session's load does not count", async () => {
    await load(session())
    expect(await write(session(), join(REPO, "AGENTS.md"))).toContain("writing-first hook refuses")
  })
})

describe("a subagent carries its parent's session id, so it loads the skill for itself", () => {
  test("the parent's load does not let its subagent write", async () => {
    const id = session()
    await load(id)
    expect(await write(id, join(REPO, "AGENTS.md"), AGENT)).toContain("writing-first hook refuses")
  })

  test("the subagent's own load does", async () => {
    const id = session()
    await load(id, AGENT)
    expect(await write(id, join(REPO, "AGENTS.md"), AGENT)).toBeUndefined()
    expect(await write(id, join(REPO, "AGENTS.md"))).toContain("writing-first hook refuses")
  })
})

describe("a compaction drops the skill from context, so it clears the mark", () => {
  test("compact", async () => {
    const id = session()
    await load(id)
    await load(id, AGENT)
    expect(
      await event({ hook_event_name: "SessionStart", session_id: id, source: "compact" }),
    ).toBeUndefined()
    expect(await write(id, join(REPO, "AGENTS.md"))).toContain("writing-first hook refuses")
    expect(await write(id, join(REPO, "AGENTS.md"), AGENT)).toContain("writing-first hook refuses")
  })

  test("a resume keeps it", async () => {
    const id = session()
    await load(id)
    await event({ hook_event_name: "SessionStart", session_id: id, source: "resume" })
    expect(await write(id, join(REPO, "AGENTS.md"))).toBeUndefined()
  })
})

describe("every other write runs", () => {
  test.each([
    ["a working note", join(REPO, ".github", "notes", "plans", "x.md")],
    ["the changelog", join(REPO, "CHANGELOG.md")],
    ["the README", join(REPO, "README.md")],
    ["the docs site", join(REPO, "web", "next", "content", "docs", "x.mdx")],
    [
      "a vendored skill, whose source is a tool",
      join(REPO, ".agents", "skills", "portless", "SKILL.md"),
    ],
    [
      "an upstream skill in core, which only vendor:upstream writes",
      join(REPO, "extensions", "core", "skills", "tdd", "SKILL.md"),
    ],
    ["an ADR", join(REPO, ".agents", "adr", "0001-x.md")],
    ["the glossary", join(REPO, "GLOSSARY.md")],
    ["code", join(REPO, "api", "hono", "src", "x.ts")],
    ["a nested AGENTS.md", join(REPO, "web", "next", "AGENTS.md")],
    ["another repository's AGENTS.md", join(OTHER, "AGENTS.md")],
    ["another repository's docs", join(OTHER, "docs", "x.md")],
    ["a brief beside the handoffs", join(CONFIG, "playground", "brief-skills.md")],
    ["a file in no repository", join(BASE, "loose", "AGENTS.md")],
  ])("%s", async (_, path) => {
    expect(await write(session(), path)).toBeUndefined()
  })

  test("a read", async () => {
    expect(
      await event({
        hook_event_name: "PreToolUse",
        session_id: session(),
        tool_input: { file_path: join(REPO, "AGENTS.md") },
        tool_name: "Read",
      }),
    ).toBeUndefined()
  })

  test("any write while the skill is not installed", async () => {
    expect(
      await event(
        {
          hook_event_name: "PreToolUse",
          session_id: session(),
          tool_input: { content: "x", file_path: join(REPO, "AGENTS.md") },
          tool_name: "Write",
        },
        BARE_CONFIG,
      ),
    ).toBeUndefined()
  })

  test("a call with no session id", async () => {
    expect(await write("", join(REPO, "AGENTS.md"))).toBeUndefined()
  })

  test("input it cannot read", async () => {
    expect(
      await check("not json", {
        CLAUDE_CONFIG_DIR: CONFIG,
        PLAYGROUND_DATA_DIR: join(CONFIG, "playground"),
      }),
    ).toBeUndefined()
  })
})

describe("an installed plugin's copy counts as installed, so retiring the user-scope copy keeps the hook armed", () => {
  const attempt = (config: string) =>
    event(
      {
        hook_event_name: "PreToolUse",
        session_id: session(),
        tool_input: { content: "x", file_path: join(REPO, "AGENTS.md") },
        tool_name: "Write",
      },
      config,
    )

  test.each([
    ["a user install enabled in the settings", USER_PLUGIN],
    ["a project's install, for the folder the session runs in", PROJECT_PLUGIN],
  ])("%s: the write waits", async (_, config) => {
    expect(await attempt(config)).toContain("writing-first hook refuses")
  })

  test.each([
    ["a disabled install", DISABLED_PLUGIN],
    ["another project's install", ELSEWHERE_PLUGIN],
    ["no plugins listed", PLUGIN_CONFIG],
  ])("none for %s, so the write runs", async (_, config) => {
    expect(await attempt(config)).toBeUndefined()
  })
})

describe("the script", () => {
  const FACTORY = { PLAYGROUND_ROLE: "worker" }
  const refused = {
    hook_event_name: "PreToolUse",
    tool_input: { content: "x", file_path: join(REPO, "AGENTS.md") },
    tool_name: "Write",
  }

  const run = async (input: Record<string, unknown>, role: Record<string, string> = FACTORY) => {
    const child = Bun.spawn(["bun", "--no-env-file", script], {
      env: {
        CLAUDE_CONFIG_DIR: CONFIG,
        PLAYGROUND_DATA_DIR: join(CONFIG, "playground"),
        HOME: "/u",
        PATH: process.env.PATH,
        ...role,
      },
      stderr: "pipe",
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: REPO, ...input })),
      stdout: "pipe",
    })
    const [code, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    return { code, stderr, stdout }
  }

  test("exits 2 with the reason on a refused write in a factory session", async () => {
    const result = await run({ ...refused, session_id: session() })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("writing-first hook refuses")
  })

  test("lets a session with no factory role write, so your own sessions are unchanged", async () => {
    expect(await run({ ...refused, session_id: session() }, {})).toEqual({
      code: 0,
      stderr: "",
      stdout: "",
    })
  })

  test("prints nothing on a prompt, since a prompt hook's output joins the context", async () => {
    const result = await run({
      hook_event_name: "UserPromptSubmit",
      prompt: `/${SKILL}`,
      session_id: session(),
    })
    expect(result).toEqual({ code: 0, stderr: "", stdout: "" })
  })
})

describe("registration", () => {
  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} runs it on each event it reads, with one command so a session loading both runs it once`, async () => {
      const settings = (await Bun.file(join(root, file)).json()) as {
        hooks: Record<string, { hooks: { command: string }[]; matcher?: string }[]>
      }
      // the factory file's command for each event, which the project file must carry byte for byte; the PreToolUse one fails closed
      const factory = (await Bun.file(join(root, "scripts", "factory-settings.json")).json()) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>
      }
      const commandOf = (event: string) =>
        factory.hooks[event]!.flatMap((entry) => entry.hooks)
          .map((hook) => hook.command)
          .find((c) => /scripts\/hooks\/(bundled\/)?writing-first\.[jt]s/.test(c))
      const matchers = (event: string) =>
        settings.hooks[event]
          ?.filter((entry) => entry.hooks.some((hook) => hook.command === commandOf(event)))
          .map((entry) => entry.matcher ?? "") ?? []
      expect(commandOf("SessionStart")).toBe(commandOf("UserPromptSubmit"))
      expect(matchers("PreToolUse")).toEqual(["^(Edit|MultiEdit|Skill|Write)$"])
      expect(matchers("UserPromptSubmit")).toEqual([""])
      expect(matchers("SessionStart")).toEqual(["^compact$"])
    })
})
