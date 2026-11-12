import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")

// The shared files keep it off for every session spawn.sh did not start; the trial's own built files turn it on, as tests/scripts/spawn-memory.test.ts holds (ADR 0022)
describe("auto-memory", () => {
  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} turns it off`, async () => {
      const settings = (await Bun.file(join(root, file)).json()) as { autoMemoryEnabled?: unknown }
      expect(settings.autoMemoryEnabled).toBe(false)
    })
})

// The screen read drops a prompt suggestion's dimming, so deliver() reads it as a draft and refuses the message with INPUT_NOT_EMPTY; the factory's sessions start with suggestions off, and spawn.sh rebuilds the GLM settings file from this one on every launch
describe("prompt suggestions", () => {
  test("scripts/factory-settings.json turns them off", async () => {
    const settings = (await Bun.file(join(root, "scripts", "factory-settings.json")).json()) as {
      promptSuggestionEnabled?: unknown
    }
    expect(settings.promptSuggestionEnabled).toBe(false)
  })
})

type Hook = { hooks: { command: string }[]; matcher?: string }
const preToolUse = async (file: string) =>
  (
    (await Bun.file(join(root, file)).json()) as {
      hooks: { PreToolUse: Hook[] }
    }
  ).hooks.PreToolUse

// cmux restores a session after a restart without --settings, so the project settings carry the factory's hooks too; the same command in both files runs once
describe("a session cmux restored in a dispatcher checkout keeps the factory's hooks", () => {
  test("every factory PreToolUse hook is in .claude/settings.json with the same matcher and command", async () => {
    const project = await preToolUse(join(".claude", "settings.json"))
    for (const hook of await preToolUse(join("scripts", "factory-settings.json")))
      expect(project).toContainEqual(hook)
  })

  // guards runs every Bash guard (tests/scripts/hooks/guards.test.ts), and the rest keep their own entry for the tools other than Bash they guard
  test.each([
    "guards",
    "no-bare-slack-link",
    "no-extension-repo-write",
    "no-extensions-write",
    "no-glm-heavy-path",
    "no-linear-ticket",
    "no-main-checkout",
    "no-playground-leak",
    "no-release-comment",
  ])("%s is a factory hook", async (name) => {
    const commands = (await preToolUse(join("scripts", "factory-settings.json"))).flatMap((h) =>
      h.hooks.map((x) => x.command),
    )
    expect(commands.some((c) => c.includes(`scripts/hooks/bundled/${name}.js`))).toBe(true)
  })

  // spawn.sh's deny keeps a manager off the Agent and Workflow tools (tests/scripts/spawn-manager-deny.test.ts), so no hook guards them; the guard's script stays one ship past its registration, for a worktree whose settings still name it (scripts/hooks/README.md)
  test.each([join("scripts", "factory-settings.json"), join(".claude", "settings.json")])(
    "%s registers no no-manager-subagent hook",
    async (file) => {
      const hooks = await preToolUse(file)
      expect(hooks.filter((h) => /Agent|Workflow/.test(h.matcher ?? ""))).toEqual([])
      expect(hooks.flatMap((h) => h.hooks.map((x) => x.command)).join("\n")).not.toContain(
        "no-manager-subagent",
      )
    },
  )

  // a Write into the main checkout passed while no-main-checkout heard only Bash, which now reaches both through guards
  test.each(
    ["no-extensions-write", "no-main-checkout"].flatMap((name) =>
      ["Edit", "MultiEdit", "NotebookEdit", "Write"].map((tool) => [name, tool]),
    ),
  )("%s hears %s", async (name, tool) => {
    const hook = (await preToolUse(join("scripts", "factory-settings.json"))).find((h) =>
      h.hooks.some((x) => x.command.includes(`scripts/hooks/bundled/${name}.js`)),
    )
    expect(new RegExp(hook?.matcher ?? "^$").test(tool)).toBe(true)
  })
})

// A factory subagent with no model named runs on Sonnet; the alias, not a Claude id, so a GLM session's subagent maps to GLM through ANTHROPIC_DEFAULT_SONNET_MODEL. The project file leaves the owner's own sessions here on Claude Code's default
describe("subagent model", () => {
  const env = async (file: string) =>
    ((await Bun.file(join(root, file)).json()) as { env?: Record<string, string> }).env ?? {}

  test("scripts/factory-settings.json defaults a subagent to sonnet", async () => {
    expect((await env(join("scripts", "factory-settings.json"))).CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      "sonnet",
    )
  })

  test(".claude/settings.json sets no subagent model", async () => {
    expect((await env(join(".claude", "settings.json"))).CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
  })
})

// an update Claude Code ran by itself deleted the binary under every running session; the factory's sessions and a session restored here without --settings update only when someone runs `claude update` (https://code.claude.com/docs/en/setup#disable-auto-updates)
describe("auto-updates", () => {
  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} turns them off`, async () => {
      const settings = (await Bun.file(join(root, file)).json()) as {
        env?: Record<string, string>
      }
      expect(settings.env?.DISABLE_AUTOUPDATER).toBe("1")
    })
})

// a brew install at 22:10Z on 25 Oct upgraded python@3.15 and deleted its old Cellar under two running Checks lanes; a session's brew install or upgrade leaves every old Cellar in place, and an install leaves the formula it names at its installed version
describe("brew", () => {
  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} keeps an install from upgrading or cleaning up`, async () => {
      const settings = (await Bun.file(join(root, file)).json()) as {
        env?: Record<string, string>
      }
      expect(settings.env?.HOMEBREW_NO_INSTALL_CLEANUP).toBe("1")
      expect(settings.env?.HOMEBREW_NO_INSTALL_UPGRADE).toBe("1")
    })
})

test("the factory's settings skip the bypass warning, so a session spawn.sh starts in bypass never stops on it", async () => {
  const settings = (await Bun.file(join(root, "scripts", "factory-settings.json")).json()) as {
    skipDangerousModePermissionPrompt?: unknown
  }
  expect(settings.skipDangerousModePermissionPrompt).toBe(true)
})

// One 400000 window for every session: spawn.sh gives the sessions it starts the same 400000 window. A session spawn.sh did not start (a restore in this checkout, the owner's own) reads the project settings, so both files carry the default
describe("context", () => {
  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} compacts at a 400000-token window`, async () => {
      const settings = (await Bun.file(join(root, file)).json()) as { autoCompactWindow?: unknown }
      expect(settings.autoCompactWindow).toBe(400000)
    })

  // the default lives in the two settings files and spawn.sh's copy for the sessions it starts, and tests and docs may name them; any other tracked file holding the key would carry a copy a change could miss
  test("only spawn.sh names the compaction window beside the settings files", async () => {
    const proc = Bun.spawn(["git", "-C", root, "ls-files"], { stdout: "pipe" })
    const files = (await new Response(proc.stdout).text()).split("\n").filter(Boolean)
    expect(await proc.exited).toBe(0)
    const holding: string[] = []
    for (const file of files) {
      if (file.endsWith("factory-settings.json") || file.endsWith(".claude/settings.json")) continue
      if (file.startsWith("tests/") || file.endsWith(".md")) continue
      // .claude/skills is a tracked link to a directory; only a regular file can hold the key
      if (!statSync(join(root, file)).isFile()) continue
      if (
        /autoCompactWindow|CLAUDE_CODE_AUTO_COMPACT_WINDOW/.test(
          await Bun.file(join(root, file)).text(),
        )
      )
        holding.push(file)
    }
    expect(holding).toEqual(["scripts/spawn.sh"])
  })
})

// the Dashboard is to read each session's state from the file session-state.ts writes, so every event that changes it runs the hook, and SessionEnd hands a herdr pane back, in both files, for a restored session too
describe("the session-state hook", () => {
  const events = async (file: string) => {
    const hooks = (
      (await Bun.file(join(root, file)).json()) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>
      }
    ).hooks
    return Object.keys(hooks)
      .filter((event) =>
        hooks[event]?.some((entry) =>
          entry.hooks.some((x) => x.command.endsWith("scripts/hooks/session-state.ts")),
        ),
      )
      .sort()
  }

  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} runs it on the eight events that change a session's state, and on its end`, async () => {
      expect(await events(file)).toEqual([
        "Notification",
        "PermissionDenied",
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "SessionEnd",
        "Stop",
        "StopFailure",
        "UserPromptSubmit",
      ])
    })
})

// After a compaction Claude Code re-attaches a skill cut to about 5k tokens, which drops playbook's **context** rule, so a SessionStart hook with the compact matcher carries the reread instruction; the project file holds it too, for a restored session and for the owner's own sessions here (the hook skips those)
describe("the reread after a compaction", () => {
  const afterCompact = async (file: string) =>
    (
      (await Bun.file(join(root, file)).json()) as {
        hooks: { SessionStart?: { hooks: { command: string }[]; matcher?: string }[] }
      }
    ).hooks.SessionStart?.filter((hook) => hook.matcher === "compact") ?? []

  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} runs after-compact.ts when a session compacts`, async () => {
      const hooks = await afterCompact(file)
      expect(hooks).toHaveLength(1)
      expect(
        hooks[0]?.hooks
          .map((x) => x.command)
          .some((c) => c.endsWith("scripts/hooks/after-compact.ts")),
      ).toBe(true)
    })

  test("the project file and the factory file carry the same hook, so it runs once", async () => {
    expect(await afterCompact(join(".claude", "settings.json"))).toEqual(
      await afterCompact(join("scripts", "factory-settings.json")),
    )
  })
})

// a restart (an account switch, a herdr restore, an update) resumes a session with claude --resume, which fires SessionStart with source "resume" (measured on 2.1.309) and ends every background task it ran, so a hook with the resume matcher tells it to re-arm them and re-send unanswered asks
describe("the re-arm after a resume", () => {
  const afterResume = async (file: string) =>
    (
      (await Bun.file(join(root, file)).json()) as {
        hooks: { SessionStart?: { hooks: { command: string }[]; matcher?: string }[] }
      }
    ).hooks.SessionStart?.filter((hook) => hook.matcher === "resume") ?? []

  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} runs after-resume.ts when a session resumes`, async () => {
      const hooks = await afterResume(file)
      expect(hooks).toHaveLength(1)
      expect(
        hooks[0]?.hooks
          .map((x) => x.command)
          .some((c) => c.endsWith("scripts/hooks/after-resume.ts")),
      ).toBe(true)
    })

  test("the project file and the factory file carry the same hook, so it runs once", async () => {
    expect(await afterResume(join(".claude", "settings.json"))).toEqual(
      await afterResume(join("scripts", "factory-settings.json")),
    )
  })
})

// The standing rules reach every factory session at each start, resume, compaction and clear, so the rules hook takes SessionStart with no matcher
describe("the standing rules at session start", () => {
  const rules = async (file: string) =>
    (
      (await Bun.file(join(root, file)).json()) as {
        hooks: { SessionStart?: { hooks: { command: string }[]; matcher?: string }[] }
      }
    ).hooks.SessionStart?.filter((hook) =>
      hook.hooks.some((x) => x.command.endsWith("scripts/hooks/rules.ts")),
    ) ?? []

  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} runs rules.ts on every SessionStart source`, async () => {
      const hooks = await rules(file)
      expect(hooks).toHaveLength(1)
      expect(hooks[0]?.matcher).toBeUndefined()
    })

  test("the project file and the factory file carry the same hook, so it runs once", async () => {
    expect(await rules(join(".claude", "settings.json"))).toEqual(
      await rules(join("scripts", "factory-settings.json")),
    )
  })
})

// playbook's **local page**: a page for the owner is a local HTML file, since an artifact publishes under whichever account the session holds; enableArtifact false is Claude Code's own off switch, honored from a project or --settings file and turned back on by none (https://code.claude.com/docs/en/artifacts#disable-artifacts)
describe("the Artifact tool", () => {
  for (const file of [join("scripts", "factory-settings.json"), join(".claude", "settings.json")])
    test(`${file} turns it off with enableArtifact false, not a deny rule`, async () => {
      const settings = (await Bun.file(join(root, file)).json()) as {
        enableArtifact?: boolean
        permissions?: { deny?: string[] }
      }
      expect(settings.enableArtifact).toBe(false)
      expect(settings.permissions?.deny ?? []).not.toContain("Artifact")
    })
})
