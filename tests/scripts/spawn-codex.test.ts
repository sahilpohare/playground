import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { bin, placing, root, spawn, type Spawned } from "./spawn-fake"

type Hook = { command: string; timeout?: number; type: string }
type Group = { hooks: Hook[]; matcher?: string }
// The factory's guards as Claude Code loads them, the source every Codex launch renders its hooks.json from.
const FACTORY = JSON.parse(
  readFileSync(join(root, "scripts", "factory-settings.json"), "utf8"),
) as {
  hooks: Record<string, Group[]>
}
// The events Codex's hooks.json takes (codex-rs/protocol/src/hooks.rs, rust-v0.167.1) that the factory registers.
const CODEX_EVENTS = [
  "PermissionRequest",
  "PostToolUse",
  "PreToolUse",
  "SessionEnd",
  "SessionStart",
  "Stop",
  "UserPromptSubmit",
]

// Every case runs spawn.sh, which starts fake processes and waits on them.
setDefaultTimeout(40_000)

const NAME = "dispatcher"
const START = ["manager", NAME, "b.md", "--harness", "codex"]
const THREAD = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"

// A case's own fakes ahead of spawn-fake's, and on a scratch data folder the thread's rollout, which Codex writes as the session starts, unless the case says it never did: codex, which logs its argv and answers each app-server request with an empty result, and sleep, the wait's clock, which ticks at once, logging each tick, and at its first tick runs the beat's own SessionStart hook from the rendered hooks.json, as Codex would, on a PATH of the case's own folders and cat and mv alone, so the machine's own PowerShell never reads as installed, unless FAKE_NO_BEAT says the hooks never loaded; and pwsh in a folder of its own, which a case puts on PATH to have PowerShell installed.
const fakes = (home: string, rollout = true) => {
  const sessions = join(home, "scratch-data", "codex", "sessions", "2026", "11", "11")
  if (existsSync(join(home, "scratch-data")) && rollout) {
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, `rollout-2026-11-11T10-00-00-${THREAD}.jsonl`), "{}\n")
  }
  const dir = join(home, "fakebin")
  mkdirSync(dir, { recursive: true })
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  write(
    "codex",
    `printf '%s\\n' "$*" >> "$HOME/codex.args"
[ "$1" = app-server ] || exit 0
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$HOME/codex-app-server.log"
  id=$(python3 -I -c 'import json, sys; print(json.loads(sys.argv[1]).get("id", ""))' "$line")
  [ -z "$id" ] || printf '{"id":%s,"result":{}}\\n' "$id"
done`,
  )
  write(
    "sleep",
    `echo "$*" >> "$HOME/sleep.calls"
[ -n "$FAKE_NO_BEAT" ] || [ -e "$HOME/beat.sent" ] && exit 0
: > "$HOME/beat.sent"
hook=$(python3 -I -c 'import json, sys; print(next(h["command"] for g in json.load(open(sys.argv[1]))["hooks"]["SessionStart"] for h in g["hooks"] if "SPAWN_CODEX_BEAT" in h["command"]))' "$PLAYGROUND_DATA_DIR/codex/hooks.json")
p="$HOME/hookbin"; IFS=:; for d in $PATH; do case "$d" in "$HOME"/*) p="$p:$d" ;; esac; done; unset IFS
printf '{"session_id":"${THREAD}","source":"startup"}\\n' | PATH="$p" SPAWN_CODEX_BEAT="$PLAYGROUND_DATA_DIR/launch/${NAME}.beat" /bin/bash -c "$hook"`,
  )
  mkdirSync(join(home, "hookbin"), { recursive: true })
  for (const tool of ["cat", "mv"])
    if (!existsSync(join(home, "hookbin", tool)))
      symlinkSync(Bun.which(tool)!, join(home, "hookbin", tool))
  mkdirSync(join(home, "pwshbin"), { recursive: true })
  writeFileSync(join(home, "pwshbin", "pwsh"), "#!/bin/bash\nexit 0\n")
  chmodSync(join(home, "pwshbin", "pwsh"), 0o755)
}

// Every case runs on a scratch data folder, the one place a Codex session starts before phase 3, unless it says LIVE_DATA.
const run = (args: string[], env: Record<string, string> = {}, pin?: string, rollout = true) =>
  spawn(
    args,
    [],
    {
      PATH: `{home}/fakebin:${bin}:${process.env.PATH}`,
      ...(env.LIVE_DATA ? {} : { SCRATCH_DATA: "1" }),
      ...env,
    },
    undefined,
    pin ? { backend: pin, name: NAME } : undefined,
    (home) => fakes(home, rollout),
  )

const data = (r: Spawned, ...parts: string[]) => join(r.home, "scratch-data", ...parts)
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null)
const launchText = (r: Spawned) => {
  const dir = data(r, "launch")
  const file = readdirSync(dir).find((f) => f.endsWith(".sh"))
  return file ? readFileSync(join(dir, file), "utf8") : ""
}

describe("spawn.sh --harness codex starts the dispatcher in Codex, failing closed", () => {
  test("hooks not loaded: start refused", async () => {
    const r = await run(START, { FAKE_NO_BEAT: "1" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("spawn.sh refuses")
    expect(r.err).toContain("SessionStart")
    // the wait ran its whole 60 seconds on the fake clock, 120 ticks of 0.5, then ended the session it had started
    expect(read(join(r.home, "sleep.calls"))?.split("\n").filter(Boolean)).toEqual(
      Array(120).fill("0.5"),
    )
    expect(placing(r).some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "w5:p1")).toBe(
      true,
    )
    expect(read(data(r, "backends", NAME))).toBeNull()
    expect(read(data(r, "resume", `${NAME}.sh`))).toBeNull()
    expect(readdirSync(data(r, "launch")).filter((f) => !f.endsWith(".herdr"))).toEqual([])
    expect(r.rosterLog ?? []).toEqual([])
  })

  test("a resume whose beat never lands is refused, its earlier pin and record left standing", async () => {
    const r = await run(["resume", NAME, root, THREAD], { FAKE_NO_BEAT: "1" }, "codex openai")
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("SessionStart")
    expect(r.err).toContain("its earlier pin and resume record stand")
    expect(placing(r).some((c) => c[0] === "pane" && c[1] === "close")).toBe(true)
    expect(read(data(r, "backends", NAME))).toBe("codex openai\n")
    expect(r.rosterLog ?? []).toEqual([])
  })

  test("a pane herdr will not close is refused in its own words, never read as closed", async () => {
    const r = await run(START, { FAKE_HERDR_CLOSE_FAIL: "1", FAKE_NO_BEAT: "1" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "herdr would not close dispatcher's pane w5:p1, so the session may still run",
    )
    expect(r.err).not.toContain("is closed")
    expect(read(data(r, "backends", NAME))).toBeNull()
  })

  test("PowerShell installed: the start stops, its pane closed, with no pin, record or roster row", async () => {
    const r = await run(START, { PATH: `{home}/pwshbin:{home}/fakebin:${bin}:${process.env.PATH}` })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("a Codex start stops when PowerShell is installed")
    expect(r.err).toContain(join(r.home, "pwshbin", "pwsh"))
    // the beat landed at once, so the wait took one tick, not its whole 60 seconds
    expect(read(join(r.home, "sleep.calls"))?.split("\n").filter(Boolean)).toEqual(["0.5"])
    expect(placing(r).some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "w5:p1")).toBe(
      true,
    )
    expect(read(data(r, "backends", NAME))).toBeNull()
    expect(read(data(r, "resume", `${NAME}.sh`))).toBeNull()
    expect(r.rosterLog ?? []).toEqual([])
  })

  test("no PowerShell: the beat's own hook names the thread and the start runs", async () => {
    const r = await run(START)
    expect(r.err).not.toContain("PowerShell")
    expect(r.code).toBe(0)
    expect(read(data(r, "resume", `${NAME}.sh`))).toContain(THREAD)
  })

  test("a start whose beat lands runs with hooks trusted, named, pinned and recorded", async () => {
    const r = await run(START)
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    const launch = launchText(r)
    expect(launch).toContain(`CODEX_HOME=${data(r, "codex")}`)
    expect(launch).toContain(`SPAWN_CODEX_BEAT=${data(r, "launch", `${NAME}.beat`)}`)
    expect(launch).toContain(
      `${join(r.home, "fakebin", "codex")} --dangerously-bypass-hook-trust "`,
    )
    expect(launch).not.toContain(" claude ")
    // the launch's own CODEX_HOME trusts the folder, keeps the login in a file, and its hooks write the beat whole, through a file moved into place
    expect(read(data(r, "codex", "config.toml"))).toContain(`[projects."`)
    expect(read(data(r, "codex", "hooks.json"))).toContain('mv \\"$f.tmp\\" \\"$f\\"')
    expect(read(join(r.home, "codex-app-server.log"))).toContain(
      `"method":"thread/name/set","params":{"name":"${NAME}","threadId":"${THREAD}"}`,
    )
    expect(read(data(r, "backends", NAME))).toBe("codex openai\n")
    expect(read(data(r, "resume", `${NAME}.sh`))).toContain(`/scripts/spawn.sh resume ${NAME} `)
    expect(read(data(r, "resume", `${NAME}.sh`))).toContain(` ${THREAD}\n`)
  })

  // Codex has no Notification, PermissionDenied, PostToolUseFailure or StopFailure, and session-state stays out, so no record reads a Codex session as idle; writing-first also matches Bash, where Codex reads a skill and may run apply_patch.
  test("its hooks.json registers the factory's guards on each event Codex has, beside the beat", async () => {
    const r = await run(START)
    expect(r.code).toBe(0)
    const rendered = JSON.parse(read(data(r, "codex", "hooks.json")) ?? "{}") as {
      hooks: Record<string, Group[]>
    }
    const guards = (groups: Group[]) =>
      groups.flatMap((g) =>
        g.hooks
          .filter((h) => !h.command.includes("session-state"))
          .map((h) => ({
            command: h.command,
            matcher:
              h.command.includes("writing-first") && g.matcher?.includes("Skill")
                ? "^(Bash|Edit|MultiEdit|Write)$"
                : (g.matcher ?? ""),
          })),
      )
    const expected = Object.fromEntries(
      CODEX_EVENTS.map((event) => [event, guards(FACTORY.hooks[event] ?? [])]).filter(
        ([, list]) => list.length > 0,
      ),
    )
    const got = Object.fromEntries(
      Object.entries(rendered.hooks).map(([event, groups]) => [
        event,
        groups.flatMap((g) =>
          g.hooks
            .filter((h) => !h.command.includes("SPAWN_CODEX_BEAT"))
            .map((h) => ({ command: h.command, matcher: g.matcher ?? "" })),
        ),
      ]),
    )
    expect(got).toEqual(expected)
    expect(JSON.stringify(rendered)).not.toContain("session-state")
    expect(Object.keys(rendered.hooks).every((event) => CODEX_EVENTS.includes(event))).toBe(true)
    expect(Object.keys(expected).length).toBeGreaterThan(2)
    expect(
      rendered.hooks.SessionStart?.some((g) =>
        g.hooks.some((h) => h.command.includes("SPAWN_CODEX_BEAT")),
      ),
    ).toBe(true)
  })

  test("a resume from a codex pin resumes its thread with hooks trusted", async () => {
    const r = await run(["resume", NAME, root, THREAD], {}, "codex openai")
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launchText(r)).toContain(
      `${join(r.home, "fakebin", "codex")} resume --dangerously-bypass-hook-trust ${THREAD} "`,
    )
    expect(read(data(r, "backends", NAME))).toBe("codex openai\n")
  })

  test("a resume of a thread that never wrote its rollout starts afresh, under the thread its beat names", async () => {
    const r = await run(["resume", NAME, root, THREAD], {}, "codex openai", false)
    expect(r.err).toBe("")
    expect(r.code).toBe(0)
    expect(launchText(r)).toEndWith(
      `${join(r.home, "fakebin", "codex")} --dangerously-bypass-hook-trust)`,
    )
    expect(read(data(r, "resume", `${NAME}.sh`))).toContain(` ${THREAD}\n`)
  })

  // Until phase 3 lifts it, the live data folder takes no Codex start or resume, guards wired or not.
  test.each([
    ["a start", START, undefined],
    ["a resume", ["resume", NAME, root, THREAD], "codex openai"],
  ])("refuses %s on the live data folder, naming phase 3", async (_, args, pin) => {
    const r = await run(args, { LIVE_DATA: "1" }, pin)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("spawn.sh refuses")
    expect(r.err).toContain("phase 3")
    expect(placing(r)).toEqual([])
    expect(read(join(r.home, "codex.args"))).toBeNull()
  })

  test.each([
    ["a worker", ["worker", "worker-brave-otter", "b.md", "--harness", "codex"]],
    ["GLM", [...START, "--backend", "glm"]],
    ["a second account", [...START, "--account", "second@example.org"]],
    ["a Claude model", [...START, "--model", "opus"]],
  ])("refuses %s in Codex", async (_, args) => {
    const r = await run(args)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("Codex")
    expect(read(join(r.home, "codex.args"))).toBeNull()
  })
})
