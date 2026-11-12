import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const REPO = join(import.meta.dir, "../../../../../..")
const scratch = mkdtempSync(join(tmpdir(), "parity-replay-cli-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// A data folder whose extensions hold one scope with a made-up replay and its layout, and core with none.
const DATA = join(scratch, "data")
const SCOPE = join(DATA, "extensions", "acme")
for (const [path, text] of Object.entries({
  "replays/fixtures/made-up-triage/gh.json": "[]",
  "replays/fixtures/made-up-triage/linear-shared.json": "{}",
  "replays/map.json": JSON.stringify({
    "made-up-triage": { paths: ["skills/triage/"], skill: "skills/triage" },
  }),
  "replays/replays.json": JSON.stringify({
    "made-up-triage": {
      allowed: ["Read"],
      args: "",
      compare: "triage",
      model: "claude-opus-5-5",
      runs: 3,
      servers: ["linear-shared"],
    },
  }),
  "scripts/parity-replay/schemas/linear-shared.json": "[]",
  "skills/triage/SKILL.md": "# triage\n",
})) {
  mkdirSync(dirname(join(SCOPE, path)), { recursive: true })
  writeFileSync(join(SCOPE, path), text)
}

// The same scope with no layout, as a machine holds it before its org's layouts are put.
const BARE = join(scratch, "bare")
for (const path of ["replays", "skills"])
  cpSync(join(SCOPE, path), join(BARE, "extensions", "acme", path), { recursive: true })

const parity = (data: string, ...args: string[]) => {
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "", PLAYGROUND_DATA_DIR: data }
  const run = Bun.spawnSync(
    [process.execPath, join(REPO, "packages/scripts/src/parity/cli.ts"), "replay", ...args],
    { cwd: REPO, env },
  )
  return { code: run.exitCode, err: run.stderr.toString(), out: run.stdout.toString() }
}

describe("bun run parity replay", () => {
  test("--runs 0 checks every scope's replays and runs no model", () => {
    const r = parity(DATA, "--runs", "0")
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe(
      "parity replay: made-up-triage ready (acme/skills/triage, linear-shared)",
    )
  })

  test("a machine with no extension holds no replay, and says so", () => {
    const r = parity(join(scratch, "empty"), "--runs", "0")
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe("parity replay: no scope holds a replay")
  })

  test("a replay whose scope holds no layout says so plainly, and runs no model", () => {
    const r = parity(BARE, "--runs", "0")
    expect(r.code).toBe(1)
    expect(r.err.trim()).toBe(
      "parity replay: made-up-triage: no layout for linear-shared: the scope holds no scripts/parity-replay/schemas/linear-shared.json",
    )
  })

  test("--only takes one replay, and refuses a name it does not have", () => {
    expect(parity(DATA, "--only", "made-up-triage", "--runs", "0").out).toStartWith(
      "parity replay: made-up-triage ready",
    )
    expect(parity(DATA, "--only", "nothing").code).toBe(2)
  })

  test("a live run needs the account's token, so none starts without it", () => {
    const r = parity(DATA, "--only", "made-up-triage", "--runs", "1")
    expect(r.code).toBe(2)
    expect(r.err).toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })
})
