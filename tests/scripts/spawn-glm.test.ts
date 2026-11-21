import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { sourceIn, SOURCES } from "../glm-refused-sources"
import { machineTest, zshMissing } from "../machine"
import { OLD } from "../session-names"
import {
  FACTORY_SETTINGS,
  launchAfterRm,
  paneRun,
  placing,
  root,
  scratch,
  script,
  spawn,
  TOKEN,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("--backend glm runs the session on Z.ai's GLM through Claude Code", () => {
  const lookup = `tk="$(security find-generic-password -s playground-glm -a zai -w)" || exit 1; [ -n "$tk" ] || { echo "The playground-glm item for zai holds an empty token; save it again with playground accounts add --provider glm --label zai, then respawn." >&2; exit 1; }; ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ANTHROPIC_AUTH_TOKEN="$tk" ANTHROPIC_DEFAULT_OPUS_MODEL='glm-5.3-flash[1m]' ANTHROPIC_DEFAULT_SONNET_MODEL='glm-5.3-flash[1m]' ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash ENABLE_TOOL_SEARCH=true `
  const command = launchAfterRm

  test("an empty key stops the pane before claude runs", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--backend", "glm"], [], {
      FAKE_EMPTY_TOKEN: "1",
    })
    const cmd = command(r)
    expect(cmd).toContain("The playground-glm item for zai holds an empty token")
    expect(cmd.indexOf('[ -n "$tk" ]')).toBeLessThan(cmd.indexOf(" claude "))
  })

  machineTest(zshMissing(), "an empty key ends the launch before claude runs", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--backend", "glm"], [], {
      FAKE_EMPTY_TOKEN: "1",
    })
    const pane = await paneRun(r, { FAKE_EMPTY_TOKEN: "1" })
    expect(pane.err).toContain("The playground-glm item for zai holds an empty token")
    expect(pane.code).toBe(1)
    expect(existsSync(join(r.home, "claude.args"))).toBe(false)
  })

  test.each([
    ["worker", ["worker", "worker-brave-otter", "b.md", "--backend", "glm"]],
    ["column", ["column", "probe", "probe-x", OLD.ops, "w1:p2", "r.md", "--backend", "glm"]],
    [
      "resume",
      ["resume", OLD.dispatcher, root, "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27", "--backend", "glm"],
    ],
    ["a flag before the mode", ["--backend", "glm", "runner", "runner-calm-heron", "b.md"]],
  ])("%s: the pane's shell reads the key, and the model is glm-5.3-flash", async (_, args) => {
    const r = await spawn(args, [])
    expect(r.code).toBe(0)
    expect(command(r)).toStartWith(`(${lookup}env PLAYGROUND_ROLE=`)
    expect(command(r)).toContain(" --model 'glm-5.3-flash[1m]' --effort high ")
    expect(command(r)).not.toContain("claude-opus")
    expect(command(r)).not.toContain("--backend")
    // A probe runs in the sandbox, from a file of its own (spawn-sandbox.test.ts holds the block).
    const sandbox = /PLAYGROUND_ROLE=probe /.test(command(r)) ? "sandbox-" : ""
    // A dispatcher or a lead reads the managers' file, which denies the Agent and Workflow tools (spawn-manager-deny.test.ts).
    const manager = /PLAYGROUND_ROLE=(dispatcher|lead) /.test(command(r)) ? "manager-" : ""
    const glm = join(r.home, ".playground", `factory-settings-glm-${manager}${sandbox}400k.json`)
    expect(command(r).split(" --settings ")).toHaveLength(2)
    expect(command(r)).toContain(` --settings ${glm} --dangerously-skip-permissions`)
    const built = JSON.parse(readFileSync(glm, "utf8"))
    if (sandbox) delete built.sandbox
    expect(built.hooks).toEqual(FACTORY_SETTINGS.hooks)
    expect(built).toEqual({
      ...FACTORY_SETTINGS,
      autoCompactWindow: 400000,
      enabledPlugins: { "ws-home@ws": false },
      env: {
        ...FACTORY_SETTINGS.env,
        CLAUDE_CODE_ENABLE_TELEMETRY: "0",
        OTEL_METRICS_EXPORTER: "none",
      },
      ...(manager ? { permissions: { deny: ["Agent", "Workflow"] } } : {}),
    })
    const seen = [...placing(r).flat(), ...(r.roster ?? []), r.out, r.err].join("\n")
    expect(seen).not.toContain(TOKEN)
    expect(r.security).toEqual(["find-generic-password -s playground-glm -a zai"])
  })

  test("a session on Claude keeps the user's telemetry", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.code).toBe(0)
    expect(command(r)).not.toContain("CLAUDE_CODE_ENABLE_TELEMETRY")
    expect(command(r).split(" --settings ")).toHaveLength(2)
    const built = join(r.home, ".playground", "factory-settings-400k.json")
    expect(command(r)).toContain(` --settings ${built} `)
    expect(JSON.parse(readFileSync(built, "utf8")).env).toEqual(FACTORY_SETTINGS.env)
  })

  const loaded =
    "Skill, Read, Bash, Edit and Write are already loaded; ToolSearch lists only deferred tools."

  test.each([
    ["start", ["worker", "worker-brave-otter", "b.md", "--backend", "glm"], {}],
    [
      "resume",
      [
        "resume",
        OLD.dispatcher,
        root,
        "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27",
        "--backend",
        "glm",
        "--brief",
        "b.md",
      ],
      { BRIEF_FILE: "b.md" },
    ],
  ])("a GLM %s's prompt says its core tools are already loaded", async (_, args, extra) => {
    const r = await spawn(args, [], extra)
    expect(r.code).toBe(0)
    expect(command(r)).toContain(`read it in full and follow it. ${loaded}`)
  })

  test("a resume whose backend pin reads glm says its core tools are already loaded", async () => {
    const r = await spawn(
      ["resume", "worker-brave-otter", root, "--brief", "b.md"],
      [],
      { BRIEF_FILE: "b.md" },
      undefined,
      { name: "worker-brave-otter", backend: "glm" },
    )
    expect(r.code).toBe(0)
    expect(command(r)).toContain(`read it in full and follow it. ${loaded}`)
  })

  test("a Claude session's prompt leaves the loaded-tools line out", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    expect(r.code).toBe(0)
    expect(command(r)).not.toContain(loaded)
  })

  test.each([
    ["--backend glm", ["--backend", "glm"]],
    ["Claude", []],
  ])(
    "with no factory settings to build from, %s is refused before herdr runs",
    async (_, extra) => {
      // a scratch checkout holding spawn.sh, run-slot.sh, its data-folder resolver and its scripts package, with no scripts/factory-settings.json beside them
      const checkout = mkdtempSync(join(scratch, "no-settings-"))
      mkdirSync(join(checkout, "scripts", "ops"), { recursive: true })
      writeFileSync(join(checkout, "scripts", "spawn.sh"), readFileSync(script))
      for (const file of [
        join("scripts", "ops", "run-slot.sh"),
        ...["aliases.ts", "data-dir.ts"].map((f) => join("packages", "env", "src", f)),
      ]) {
        mkdirSync(dirname(join(checkout, file)), { recursive: true })
        writeFileSync(join(checkout, file), readFileSync(join(root, file)))
      }
      // a GLM start reads the guarded orgs through the checkout's own setting.ts
      symlinkSync(join(root, "packages", "scripts"), join(checkout, "packages", "scripts"))
      const r = await spawn(
        ["worker", "worker-brave-otter", "b.md", ...extra],
        [],
        { NO_FACTORY_SETTINGS: "1" },
        join(checkout, "scripts", "spawn.sh"),
      )
      expect(r.code).toBe(1)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("it cannot build")
    },
  )

  test("the GLM comment names the plan Max, not Pro", () => {
    const source = readFileSync(script, "utf8")
    expect(source).toContain("Max plan")
    expect(source).not.toContain("Pro plan")
  })

  test.each([
    [
      "column reviewer",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
    ],
    ["column tester", ["column", "tester", "tester-x", "worker-x", "w1:p2", "t.md", "--pr", "1"]],
    [
      "resume reviewer-x",
      ["resume", "reviewer-x", root, "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27", "--pr", "1"],
    ],
    [
      "resume tester-x",
      ["resume", "tester-x", root, "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27", "--pr", "1"],
    ],
  ])("a %s stays on Claude: --backend glm is refused before herdr runs", async (_, args) => {
    const r = await spawn([...args, "--backend", "glm"], [])
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain("runs on Claude, so it takes no --backend glm")
  })

  test("a backend with no Keychain item is refused before herdr runs", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--backend", "glm"], [], {
      FAKE_NO_ITEM: "1",
    })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain("the Keychain holds no playground-glm item for zai")
  })

  test.each([
    [
      "another backend",
      ["worker", "worker-a", "b.md", "--backend", "openai"],
      "--backend takes glm",
    ],
    [
      "beside a Claude --account",
      ["worker", "worker-a", "b.md", "--backend", "glm", "--account", "spare@example.com"],
      "--account spare@example.com labels no GLM row in usage.accounts, which lists zai",
    ],
  ])("%s is refused before herdr runs", async (_, args, says) => {
    const r = await spawn(args, [])
    expect(r.code).toBe(1)
    expect(r.err).toContain(says)
    expect(placing(r)).toEqual([])
  })

  test("--account names a GLM row by its label, whose Keychain item the pane's shell reads", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--backend", "glm", "--account", "spare"],
      [],
      {
        SETTINGS_JSON: JSON.stringify({
          "usage.accounts": [
            { label: "zai", provider: "glm" },
            { label: "spare", provider: "glm" },
          ],
        }),
      },
    )
    expect(r.code, r.err).toBe(0)
    expect(command(r)).toStartWith(`(${lookup.replaceAll("zai", "spare")}`)
    expect(r.security).toEqual(["find-generic-password -s playground-glm -a spare"])
  })

  test("usage.accounts with no GLM row refuses GLM, naming the command that adds one", async () => {
    const r = await spawn(["worker", "worker-a", "b.md", "--backend", "glm"], [], {
      NO_GLM_ROW: "1",
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "usage.accounts lists no GLM key: add one with playground accounts add --provider glm --label <label>",
    )
    expect(placing(r)).toEqual([])
  })

  // No guarded org's data reaches GLM, so a brief naming a word of the glm-refused-sources list keeps a session on Claude; the list sits in the data folder's extensions, where a render writes it.
  const listed = (words: unknown) => (home: string) => {
    const root = join(home, ".playground", "extensions")
    mkdirSync(join(root, "hooks"), { recursive: true })
    writeFileSync(
      join(root, "policy.json"),
      JSON.stringify({ orgs: {}, schemaVersion: 1, values: {} }),
    )
    const text = typeof words === "string" ? words : JSON.stringify(words)
    writeFileSync(join(root, "hooks", "glm-refused-sources.json"), text)
  }
  // A null list leaves the extensions out, as on a fresh clone.
  const briefSays =
    (text: string, words: unknown = SOURCES) =>
    (home: string) => {
      if (words !== null) listed(words)(home)
      writeFileSync(join(home, ".playground", "b.md"), text)
    }
  const glmOn = (setup: (home: string) => void, backend = "glm") =>
    spawn(["worker", "worker-a", "b.md", "--backend", backend], [], {}, script, undefined, setup)

  test("a session in a folder named for an org ext.links guards is refused on GLM before herdr runs, with no orgs.map", async () => {
    const r = await spawn(
      ["worker", "worker-a", "b.md", "--backend", "glm", "--in", "{home}/code/acme/app"],
      [],
      { SETTINGS_JSON: JSON.stringify({ "ext.links": { acme: ["acme"] } }) },
      script,
      undefined,
      (home) => {
        mkdirSync(join(home, "code", "acme", "app"), { recursive: true })
        writeFileSync(join(home, ".playground", "b.md"), "A made-up task.\n")
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "worker-a runs in a checkout of acme, an org ext.links guards, so it runs on Claude",
    )
    expect(placing(r)).toEqual([])
  })

  test("a brief naming a listed source is refused on GLM before herdr runs", async () => {
    const r = await glmOn(briefSays("Read the Example team's Linear board.\n"))
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "b.md names linear, a source glm-refused-sources keeps off GLM, so it runs on Claude",
    )
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
  })

  test("a brief naming a listed source starts on Claude", async () => {
    const r = await spawn(
      ["worker", "worker-a", "b.md", "--backend", "claude", "--check"],
      [],
      {},
      script,
      undefined,
      briefSays("Read the Example team's Linear board.\n"),
    )
    expect(r.code).toBe(0)
  })

  test.each([
    ["a made-up database by its name", "Query ACME-DB for the rows.\n", "acme-db"],
    ["Slack", "Post the update in Slack.\n", "slack"],
  ])("a brief naming %s is refused on GLM", async (_, text, named) => {
    const r = await glmOn(briefSays(text))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`b.md names ${named}, a source glm-refused-sources keeps off GLM`)
  })

  test("a fresh clone's empty list keeps no brief off GLM", async () => {
    const r = await glmOn(briefSays("Read the Example team's Linear board.\n", null))
    expect(r.err).not.toContain("glm-refused-sources")
  })

  test.each([
    ["malformed", "{ words: ["],
    ["not a list of words", '{"words":[]}'],
  ])("a list that is %s refuses GLM, naming it", async (_, text) => {
    const r = await glmOn(briefSays("Fix the button.\n", text))
    expect(r.code).toBe(1)
    expect(r.err).toContain("glm-refused-sources.json")
    expect(placing(r)).toEqual([])
  })

  const templates = readdirSync(join(root, "scripts", "briefs")).filter((file) =>
    sourceIn(readFileSync(join(root, "scripts", "briefs", file), "utf8")),
  )
  test("the briefs folder holds a template that names a listed source", () => {
    expect(templates.length).toBeGreaterThan(0)
  })
  test.each(templates)(
    "the %s template, which names a listed source, is refused on GLM",
    async (file) => {
      const r = await glmOn(briefSays(readFileSync(join(root, "scripts", "briefs", file), "utf8")))
      expect(r.code).toBe(1)
      expect(r.err).toContain("a source glm-refused-sources keeps off GLM")
    },
  )

  test.each([
    ["no backend after it", ["worker", "worker-a", "b.md", "--backend"]],
    ["given twice", ["worker", "worker-a", "b.md", "--backend", "glm", "--backend", "glm"]],
  ])("--backend %s is refused", async (_, args) => {
    const r = await spawn(args, [])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
  })
})
