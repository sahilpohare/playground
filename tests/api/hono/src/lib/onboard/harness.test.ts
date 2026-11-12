import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { CODEX_LIVE_REFUSAL, HARNESS_COMMANDS, codexHome, compareVersions, harnessCards } =
  await import("../../../../../../api/hono/src/lib/onboard/harness")
const { fixtureFixed } = await import("../../../../../../api/hono/src/lib/onboard/fix-ids")
type Reader = import("../../../../../../api/hono/src/lib/onboard/machine").Reader
type HarnessCard = import("../../../../../../api/hono/src/lib/onboard/harness").HarnessCard

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
  fixtureFixed.clear()
})

// A scratch HOME and a scratch data folder, so Codex's home is never the live one.
const homes = () => {
  const root = mkdtempSync(join(tmpdir(), "harness-test-"))
  roots.push(root)
  const data = join(root, "data")
  mkdirSync(data)
  return { HOME: join(root, "home"), PLAYGROUND_DATA_DIR: data }
}

// A machine as a script: the tools on PATH and each argv's answer keyed by its words, anything else exiting 1; Codex's app-server answers account/read with plan, and a file read gives files' text.
const machine = (
  on: string[],
  answers: Record<string, { code?: number; stdout?: string }>,
  { files = {}, plan }: { files?: Record<string, string>; plan?: unknown } = {},
) => {
  const ran: string[] = []
  const asked: { argv: string[]; lines: string[] }[] = []
  const reader: Reader = {
    exists: (path) => path in files,
    has: (tool) => on.includes(tool),
    listens: async () => false,
    run: async (argv) => {
      ran.push(argv.join(" "))
      return { code: 0, stdout: "", ...(answers[argv.join(" ")] ?? { code: 1 }) }
    },
  }
  const ask = async (argv: string[], lines: string[], id: number) => {
    asked.push({ argv, lines })
    return plan === undefined ? null : { id, result: { account: plan, requiresOpenaiAuth: true } }
  }
  const read = async (path: string) => files[path] ?? null
  return { ask, asked, ran, read, reader }
}

const live = { kind: "live", rule: "own" } as const
const fixture = { file: null, kind: "fixture", rule: "test" } as const
const card = (cards: HarnessCard[], id: string) => cards.find((c) => c.id === id)!
const rows = (c: HarnessCard) =>
  Object.fromEntries(c.checks.map((check) => [check.name, [check.status, check.detail]]))

const CLAUDE_OK = { "claude --version": { stdout: "2.1.322 (Claude Code)\n" } }

describe("each harness's card on a machine it reads (#1835)", () => {
  test("Claude Code at the tested version, signed in by claude auth status; its plan not read yet", async () => {
    const env = homes()
    const m = machine(["claude"], {
      ...CLAUDE_OK,
      "claude auth status": { stdout: '{"loggedIn": true, "authMethod": "claude.ai"}\n' },
    })
    const cards = await harnessCards({ ...m, env, source: live })
    expect(cards.map((c) => c.id)).toEqual(["claude-code", "codex"])
    const claude = card(cards, "claude-code")
    expect(rows(claude)).toEqual({
      Installed: ["ok", "2.1.322"],
      Plan: ["optional", "not read yet"],
      "Signed in": ["ok", "signed in"],
    })
    expect(claude).toMatchObject({ label: "Claude Code", ready: true, refusal: null })
    expect(m.ran).toContain("claude --version")
    expect(m.ran).toContain("claude auth status")
  })

  test("Claude Code signed in by ~/.claude.json's oauthAccount when auth status says no", async () => {
    const env = homes()
    const m = machine(
      ["claude"],
      { ...CLAUDE_OK, "claude auth status": { code: 1, stdout: '{"loggedIn": false}' } },
      { files: { [join(env.HOME, ".claude.json")]: '{"oauthAccount": {"emailAddress": "x"}}' } },
    )
    expect(
      rows(card(await harnessCards({ ...m, env, source: live }), "claude-code")),
    ).toMatchObject({ "Signed in": ["ok", "signed in"] })
  })

  test("Claude Code not signed in offers Sign in; newer than tested still lets it start", async () => {
    const env = homes()
    const m = machine(["claude"], {
      "claude --version": { stdout: "2.2.0 (Claude Code)\n" },
      "claude auth status": { code: 1, stdout: '{"loggedIn": false}' },
    })
    const claude = card(await harnessCards({ ...m, env, source: live }), "claude-code")
    expect(rows(claude)).toMatchObject({
      Installed: ["ok", "2.2.0, newer than tested"],
      "Signed in": ["MISSING", "not signed in"],
    })
    expect(claude.checks[1]!.action).toEqual({ id: "claude-login", label: "Sign in" })
    expect(claude.ready).toBe(false)
  })

  test("a harness missing offers Install, and its sign-in waits; older than tested offers Update", async () => {
    const env = homes()
    const missing = card(
      await harnessCards({ ...machine([], {}), env, source: live }),
      "claude-code",
    )
    expect(rows(missing)).toMatchObject({
      Installed: ["MISSING", "not installed"],
      "Signed in": ["waiting", "waits for the install"],
    })
    expect(missing.checks[0]!.action).toEqual({ id: "claude", label: "Install Claude Code" })
    const old = machine(["codex"], { "codex --version": { stdout: "codex-cli 0.160.0\n" } })
    const codex = card(await harnessCards({ ...old, env, source: live }), "codex")
    expect(rows(codex)).toMatchObject({ Installed: ["MISSING", "0.160.0, older than tested"] })
    expect(codex.checks[0]!.action).toEqual({ id: "codex", label: "Update Codex" })
  })

  test("Codex reads codex login status in its own CODEX_HOME: exit 1 is Not signed in, with Sign in", async () => {
    const env = homes()
    const m = machine(["codex"], { "codex --version": { stdout: "codex-cli 0.167.1\n" } })
    const codex = card(await harnessCards({ ...m, env, source: live }), "codex")
    expect(rows(codex)).toEqual({
      Installed: ["ok", "0.167.1"],
      Plan: ["waiting", "waits for sign-in"],
      "Signed in": ["MISSING", "not signed in"],
    })
    expect(codex.checks[1]!.action).toEqual({ id: "codex-login", label: "Sign in" })
    expect(m.ran).toContain(
      `env CODEX_HOME=${join(env.PLAYGROUND_DATA_DIR, "codex")} codex login status`,
    )
    expect(m.asked).toEqual([])
  })

  test("Codex signed in (exit 0) reads its plan from the app-server's account/read", async () => {
    const env = homes()
    const home = codexHome(env)
    const m = machine(
      ["codex"],
      {
        "codex --version": { stdout: "codex-cli 0.167.1\n" },
        [HARNESS_COMMANDS.codexLogin(home).join(" ")]: { code: 0 },
      },
      { plan: { email: "made-up@example.com", planType: "pro", type: "chatgpt" } },
    )
    const codex = card(await harnessCards({ ...m, env, source: live }), "codex")
    expect(rows(codex)).toMatchObject({ Plan: ["ok", "pro"], "Signed in": ["ok", "signed in"] })
    expect(codex.ready).toBe(true)
    expect(m.asked).toHaveLength(1)
    expect(m.asked[0]!.argv).toEqual(["env", `CODEX_HOME=${home}`, "codex", "app-server"])
    expect(m.asked[0]!.lines.map((line) => JSON.parse(line).method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ])
  })

  test("a plan the app-server does not give reads as not read, and the card still starts", async () => {
    const env = homes()
    const m = machine(["codex"], {
      "codex --version": { stdout: "codex-cli 0.167.1\n" },
      [HARNESS_COMMANDS.codexLogin(codexHome(env)).join(" ")]: { code: 0 },
    })
    const codex = card(await harnessCards({ ...m, env, source: live }), "codex")
    expect(rows(codex)).toMatchObject({ Plan: ["optional", "not read"] })
    expect(codex.ready).toBe(true)
  })

  test("Codex on the live data folder carries the refusal in plain words; a scratch folder carries none", async () => {
    const env = homes()
    const m = machine([], {})
    expect(card(await harnessCards({ ...m, env, source: live }), "codex").refusal).toBeNull()
    const liveEnv = { HOME: env.HOME }
    const cards = await harnessCards({ ...m, env: liveEnv, source: live })
    expect(card(cards, "codex").refusal).toBe(CODEX_LIVE_REFUSAL)
    expect(card(cards, "claude-code").refusal).toBeNull()
    expect(CODEX_LIVE_REFUSAL).not.toMatch(/spawn|PLAYGROUND_DATA_DIR|phase/)
  })
})

describe("on a fixture stack", () => {
  test("runs nothing: Claude Code ready, Codex installed and not signed in until its made-up sign-in", async () => {
    const env = homes()
    const m = machine([], {})
    const before = await harnessCards({ ...m, env, source: fixture })
    expect(card(before, "claude-code").ready).toBe(true)
    expect(rows(card(before, "codex"))).toMatchObject({ "Signed in": ["MISSING", "not signed in"] })
    fixtureFixed.add("codex-login")
    const after = await harnessCards({ ...m, env, source: fixture })
    expect(rows(card(after, "codex"))).toMatchObject({
      Plan: ["ok", "plus"],
      "Signed in": ["ok", "signed in"],
    })
    expect(m.ran).toEqual([])
  })
})

test("versions compare part by part", () => {
  expect(compareVersions("0.167.1", "0.167.1")).toBe(0)
  expect(compareVersions("0.170.0", "0.167.1")).toBe(1)
  expect(compareVersions("2.1.4", "2.1.322")).toBe(-1)
  expect(compareVersions("2.1", "2.1.0")).toBe(0)
})
