import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { onGlm } from "../../scripts/hooks/no-glm-heavy-path"
import { check as headless } from "../../scripts/hooks/no-headless-login"
import { spawn, usage } from "./spawn-fake"

// PLAYGROUND_DATA_DIR names one folder, away from the config folder's: spawn.sh and the hooks that read what it writes all read there.
describe("PLAYGROUND_DATA_DIR is the one data folder spawn.sh and its hooks read", () => {
  const scratch = mkdtempSync(join(tmpdir(), "data-folder-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))

  // #1296: after its cd /, spawn.sh read a relative value as a folder under /, while the API read it under api/hono
  test("spawn.sh refuses a relative PLAYGROUND_DATA_DIR with why, before any launch", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      PLAYGROUND_DATA_DIR: "data",
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("PLAYGROUND_DATA_DIR is relative (data)")
  })

  test("spawn.sh reads the usage files and the pace override there, logs its gate there, and hands the folder to the session", async () => {
    const offUntil = new Date(Math.floor(Date.now() / 1000 + 86_400) * 1000)
    const week = usage({
      rate_limits: {
        five_hour: {
          used_percentage: 10,
          resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        seven_day: {
          used_percentage: 29,
          resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        },
      },
    })
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {
        PACE_OFF_UNTIL: `${offUntil.toISOString().slice(0, 19)}Z\n`,
        PLAYGROUND_DATA_DIR: "{home}/data",
        USAGE_JSON: JSON.stringify(week),
      },
      undefined,
      undefined,
      (home) => renameSync(join(home, ".playground"), join(home, "data")),
    )
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    const launches = join(r.home, "data", "launch")
    expect(readFileSync(join(launches, readdirSync(launches)[0] ?? ""), "utf8")).toContain(
      `PLAYGROUND_DATA_DIR=${join(r.home, "data")} `,
    )
    const log = readFileSync(join(r.home, "data", "ops", "capacity.jsonl"), "utf8")
    expect(JSON.parse(log.trim().split("\n").at(-1)!)).toMatchObject({
      readings: { week: 29 },
      verdict: "pass",
    })
  })

  test("no-glm-heavy-path reads a session's backend pin there", async () => {
    const config = join(scratch, "glm-config")
    const data = join(scratch, "glm-data")
    mkdirSync(join(config, "sessions"), { recursive: true })
    mkdirSync(join(data, "backends"), { recursive: true })
    writeFileSync(
      join(config, "sessions", "1.json"),
      JSON.stringify({ name: "worker-pinned", sessionId: "s-pinned" }),
    )
    writeFileSync(join(data, "backends", "worker-pinned"), "glm\n")
    const raw = JSON.stringify({ session_id: "s-pinned", tool_input: { command: "ls" } })
    expect(await onGlm(raw, { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: data })).toBe(true)
  })

  test("no-headless-login reads a session's resume record there", async () => {
    const config = join(scratch, "headless-config")
    const data = join(scratch, "headless-data")
    mkdirSync(join(config, "sessions"), { recursive: true })
    mkdirSync(join(data, "resume"), { recursive: true })
    writeFileSync(
      join(config, "sessions", "1.json"),
      JSON.stringify({ name: "worker-picked", sessionId: "s-picked" }),
    )
    writeFileSync(
      join(data, "resume", "worker-picked.sh"),
      "# account: picked@example.com\nexec scripts/spawn.sh resume worker-picked /x 1234\n",
    )
    const raw = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s-picked",
      tool_input: { command: "claude -p hi" },
      tool_name: "Bash",
    })
    expect(await headless(raw, { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: data })).toContain(
      "-a picked@example.com -w",
    )
  })
})

// A fixture stack's hosted session ran a factory script with the machine's real HOME, and one that names the data folder by HOME alone wrote into the machine's own (#1564): each script a session can run reads it through PLAYGROUND_DATA_DIR, the machine's ~/.playground only as its default.
describe("every script a session can run reaches the data folder through PLAYGROUND_DATA_DIR", () => {
  const REPO = join(import.meta.dir, "..", "..")
  // a code line that builds the data folder from HOME alone: a shell's $HOME/.playground, Python's expanduser and a join of the home folder
  const BY_HOME =
    /"?\$\{?HOME\}?\/\.playground|expanduser\("~\/\.playground|(homedir\(\)|home), "\.playground"/
  const COMMENT = /^\s*(#|\/\/|\*)/
  // herdr's binary and sockets follow HOME alone, as ops-herdr puts them (herdrDir in packages/env/src/data-dir.ts), so every login and stack reaches the same servers
  const HERDR = /herdr/i
  const byHome = (file: string) =>
    readFileSync(join(REPO, file), "utf8")
      .split("\n")
      .flatMap((line, i) =>
        BY_HOME.test(line) &&
        !COMMENT.test(line) &&
        !HERDR.test(line) &&
        !line.includes("PLAYGROUND_DATA_DIR")
          ? [`${file}:${i + 1}`]
          : [],
      )
  // the files that held such a line before #1564
  test.each([
    "packages/scripts/src/playground/cli.ts",
    "scripts/link-skills.sh",
    "scripts/ops/merge-train/run.py",
    "scripts/ops/usage/account-watch.py",
    "scripts/ops/usage/glm-credits.py",
    "scripts/ops/usage/login-flip.py",
    "scripts/ops/usage/near-limit.py",
    "scripts/ops/usage/run.py",
    "scripts/ops/usage/week-marks.py",
  ])("%s", (file) => {
    expect(byHome(file)).toEqual([])
  })

  test("and no other script under scripts/ or the playground command does", () => {
    const files = [
      ...new Bun.Glob("scripts/**/*.{py,sh,ts}").scanSync(REPO),
      ...new Bun.Glob("packages/scripts/src/playground/**/*.ts").scanSync(REPO),
    ].filter((file) => !file.startsWith("scripts/hooks/bundled/"))
    expect(files.length).toBeGreaterThan(50)
    expect(files.flatMap((file) => byHome(relative(REPO, join(REPO, file))))).toEqual([])
  })
})
