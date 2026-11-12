import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { launchAfterRm, placing, root, spawn, usage, zai } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("--model picks the Claude model a session runs on", () => {
  const command = launchAfterRm
  const MODELS = "claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5 or claude-haiku-5-5"
  const claudePin = { name: "worker-brave-otter", backend: "claude" }

  test.each([
    {
      label: "--model claude-sonnet-5-5",
      args: ["worker", "worker-brave-otter", "b.md", "--model", "claude-sonnet-5-5"],
      model: "claude-sonnet-5-5",
    },
    {
      label: "--model claude-haiku-5-5 before the mode",
      args: ["--model", "claude-haiku-5-5", "runner", "runner-calm-heron", "b.md"],
      model: "claude-haiku-5-5",
    },
    {
      label: "--model claude-opus-5-5 on a column",
      args: ["column", "probe", "probe-x", "ops", "w1:p2", "r.md", "--model", "claude-opus-5-5"],
      model: "claude-opus-5-5",
    },
    {
      label: "--model claude-fable-5-1",
      args: ["worker", "worker-brave-otter", "b.md", "--model", "claude-fable-5-1"],
      model: "claude-fable-5-1",
    },
    {
      label: "no --model",
      args: ["worker", "worker-brave-otter", "b.md"],
      model: "claude-opus-5-5",
    },
  ])("$label launches on $model", async ({ args, model }) => {
    const r = await spawn([...args], [])
    expect(r.code).toBe(0)
    expect(command(r).split(" --model ")).toHaveLength(2)
    expect(command(r)).toContain(` --model ${model} --effort high `)
    expect(command(r)).not.toContain("ANTHROPIC_BASE_URL")
  })

  test.each([
    {
      label: "an unknown id",
      args: ["worker", "worker-a", "b.md", "--model", "claude-opus-4"],
      says: `--model takes ${MODELS}, not claude-opus-4`,
    },
    {
      label: "an empty value",
      args: ["worker", "worker-a", "b.md", "--model", ""],
      says: `--model takes one of ${MODELS}, once`,
    },
    {
      label: "a missing value",
      args: ["worker", "worker-a", "b.md", "--model"],
      says: `--model takes one of ${MODELS}, once`,
    },
    {
      label: "a value that starts with --",
      args: ["worker", "worker-a", "b.md", "--model", "--check"],
      says: '--model needs a value; "--check" starts with --',
    },
    {
      label: "a second --model",
      args: [
        "worker",
        "worker-a",
        "b.md",
        "--model",
        "claude-sonnet-5-5",
        "--model",
        "claude-haiku-5-5",
      ],
      says: `--model takes one of ${MODELS}, once`,
    },
  ])("$label is refused before herdr runs", async ({ args, says }) => {
    const r = await spawn([...args], [])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain(says)
  })

  test("--model beside --backend glm is refused, since GLM maps every model itself", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--backend", "glm", "--model", "claude-sonnet-5-5"],
      [],
    )
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("a session on GLM takes no --model")
  })

  test("--model on the resume of a session pinned to glm is refused too", async () => {
    const r = await spawn(
      ["resume", "worker-brave-otter", root, "--model", "claude-sonnet-5-5"],
      [],
      {},
      undefined,
      { name: "worker-brave-otter", backend: "glm" },
    )
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("a session on GLM takes no --model")
  })

  test("a resume takes --model afresh: on Sonnet with it, on Opus without, and records no model", async () => {
    const sonnet = await spawn(
      ["resume", "worker-brave-otter", root, "--model", "claude-sonnet-5-5"],
      [],
      {},
      undefined,
      claudePin,
    )
    expect(sonnet.code).toBe(0)
    expect(command(sonnet)).toStartWith(
      "(env PLAYGROUND_ROLE=worker claude --resume worker-brave-otter -n worker-brave-otter --model claude-sonnet-5-5 --effort high ",
    )
    const plain = await spawn(["resume", "worker-brave-otter", root], [], {}, undefined, claudePin)
    expect(plain.code).toBe(0)
    expect(command(plain)).toContain(" --model claude-opus-5-5 --effort high ")
    // A start on Sonnet leaves only the backend pin behind, so nothing carries the model to a resume.
    const start = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--model", "claude-sonnet-5-5"],
      [],
    )
    expect(start.code).toBe(0)
    const pins = join(start.home, ".playground", "backends")
    expect(readdirSync(pins)).toEqual(["worker-brave-otter"])
    expect(readFileSync(join(pins, "worker-brave-otter"), "utf8")).toBe("claude-code claude\n")
  })

  test.each([
    {
      label: "a worker",
      args: ["worker", "worker-brave-otter", "b.md"],
      name: "worker-brave-otter",
    },
    {
      label: "a planner",
      args: ["column", "lead", "planner", "dispatcher", "w1:p2", "handoff.md"],
      name: "planner",
    },
  ])("$label passes --check on claude-fable-5-1", async ({ args, name }) => {
    const r = await spawn([...args, "--model", "claude-fable-5-1", "--check"], [])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`ok: ${name} can start`)
    expect(placing(r)).toEqual([])
  })

  test("the usage header names --model and its four ids", async () => {
    const r = await spawn([], [])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--model <id>")
    expect(r.err).toContain("claude-opus-5-5")
    expect(r.err).toContain("claude-fable-5-1")
    expect(r.err).toContain("claude-sonnet-5-5")
    expect(r.err).toContain("claude-haiku-5-5")
  })

  // A checker never runs on a fast small model: a checker's verdict gates a merge, so it stays on Opus.
  const checkerColumn = (role: string, name: string): string[] => [
    "--pr",
    "1",
    "column",
    role,
    name,
    "worker-x",
    "w1:p2",
    "r.md",
  ]
  test.each([
    {
      label: "a reviewer column on claude-sonnet-5-5",
      args: [...checkerColumn("reviewer", "reviewer-x"), "--model", "claude-sonnet-5-5"],
      role: "reviewer",
      pin: undefined,
    },
    {
      label: "a tester column on claude-haiku-5-5",
      args: [...checkerColumn("tester", "tester-x"), "--model", "claude-haiku-5-5"],
      role: "tester",
      pin: undefined,
    },
    {
      label: "a reviewer column on claude-fable-5-1",
      args: [...checkerColumn("reviewer", "reviewer-x"), "--model", "claude-fable-5-1"],
      role: "reviewer",
      pin: undefined,
    },
    {
      label: "a tester column on claude-fable-5-1",
      args: [...checkerColumn("tester", "tester-x"), "--model", "claude-fable-5-1"],
      role: "tester",
      pin: undefined,
    },
    {
      label: "a reviewer's resume on claude-haiku-5-5",
      args: ["resume", "reviewer-x", root, "--model", "claude-haiku-5-5", "--pr", "1"],
      role: "reviewer",
      pin: { name: "reviewer-x", backend: "claude" },
    },
    {
      label: "a tester's resume on claude-sonnet-5-5",
      args: ["resume", "tester-x", root, "--model", "claude-sonnet-5-5", "--pr", "1"],
      role: "tester",
      pin: { name: "tester-x", backend: "claude" },
    },
  ])("$label is refused before herdr runs, naming why", async ({ args, role, pin }) => {
    const r = await spawn([...args], [], {}, undefined, pin)
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain(`a ${role} runs on claude-opus-5-5, since its verdict gates a merge`)
  })

  test.each([
    {
      label: "a reviewer column",
      args: [...checkerColumn("reviewer", "reviewer-x"), "--model", "claude-opus-5-5"],
      pin: undefined,
    },
    {
      label: "a tester's resume",
      args: ["resume", "tester-x", root, "--model", "claude-opus-5-5", "--pr", "1"],
      pin: { name: "tester-x", backend: "claude" },
    },
  ])("$label takes --model claude-opus-5-5", async ({ args, pin }) => {
    const r = await spawn([...args], [], {}, undefined, pin)
    expect(r.code).toBe(0)
    expect(command(r)).toContain(" --model claude-opus-5-5 --effort high ")
  })

  // The models are settings: a render set that sets them changes what spawn.sh takes and launches, with no edit to spawn.sh.
  const withModels = (values: Record<string, unknown>) => ({
    SETTINGS_JSON: JSON.stringify(values),
  })

  test("a model models.claude adds launches, and models.default names the one a start gives none", async () => {
    const env = withModels({
      "models.claude": ["claude-opus-5-5", "claude-opus-6"],
      "models.default": "claude-opus-6",
    })
    const added = await spawn(
      ["worker", "worker-brave-otter", "b.md", "--model", "claude-opus-6"],
      [],
      env,
    )
    expect(added.code, added.err).toBe(0)
    expect(command(added)).toContain(" --model claude-opus-6 --effort high ")
    const plain = await spawn(["worker", "worker-brave-otter", "b.md"], [], env)
    expect(command(plain)).toContain(" --model claude-opus-6 --effort high ")
    const gone = await spawn(
      ["worker", "worker-a", "b.md", "--model", "claude-sonnet-5-5"],
      [],
      env,
    )
    expect(gone.err).toContain(
      "--model takes claude-opus-5-5 or claude-opus-6, not claude-sonnet-5-5",
    )
  })

  test("a checker runs on models.checker, with no --model and with it", async () => {
    const env = withModels({
      "models.checker": "claude-opus-6",
      "models.claude": ["claude-opus-5-5", "claude-opus-6"],
    })
    const plain = await spawn(checkerColumn("reviewer", "reviewer-x"), [], env)
    expect(plain.code, plain.err).toBe(0)
    expect(command(plain)).toContain(" --model claude-opus-6 --effort high ")
    const opus = await spawn(
      [...checkerColumn("tester", "tester-x"), "--model", "claude-opus-5-5"],
      [],
      env,
    )
    expect(opus.err).toContain("a tester runs on claude-opus-6, since its verdict gates a merge")
  })

  test("models.glm is the model a GLM session runs on, its key under models.glmKeychainService", async () => {
    const env = withModels({
      "models.glm": "glm-6-flash",
      "models.glmKeychainService": "acme-glm",
    })
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--backend", "glm"], [], env)
    expect(r.code, r.err).toBe(0)
    expect(command(r)).toContain(" --model 'glm-6-flash[1m]' --effort high ")
    expect(command(r)).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-6-flash ")
    expect(command(r)).toContain('tk="$(security find-generic-password -s acme-glm -a zai -w)"')
    expect(r.security).toEqual(["find-generic-password -s acme-glm -a zai"])
  })
})
