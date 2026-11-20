import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..")
const HOOKS = join(ROOT, "scripts", "hooks")

// Each hook that refuses its call when its input never arrives: a PreToolUse guard, where the runner's timeout would let the call run.
const GUARDS = [
  "guards",
  "no-bare-slack-link",
  "no-desktop-owner-app",
  "no-env-dump",
  "no-extension-repo-write",
  "no-extensions-write",
  "no-false-green",
  "no-glm-heavy-path",
  "no-headless-login",
  "no-kill-by-name",
  "no-linear-ticket",
  "no-live-sign-in",
  "no-mac-web-build",
  "no-main-checkout",
  "no-manager-subagent",
  "no-off-palette-label",
  "no-ours-merge",
  "no-outside-pr-code",
  "no-playground-leak",
  "no-prompt-stop",
  "no-public-leak",
  "no-raw-delete",
  "no-raw-spawn",
  "no-raw-wa",
  "no-release-comment",
  "no-stash",
  "no-unslotted-run",
]
// Each hook that exits 0 with nothing written when its input never arrives: it records or informs, or fails open by its own rule on an event where exit 2 would hold the session.
const RECORDERS = [
  "after-compact",
  "after-resume",
  "no-chat-question",
  "rules",
  "session-state",
  "writing-first",
]

// A child that reads its input through the shared reader with a short deadline and a stdin left open; it is stopped by its own handle.
const open = async (kind: string) => {
  const proc = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "-e",
      `import { input } from ${JSON.stringify(join(HOOKS, "input.ts"))}\nawait input("probe", ${JSON.stringify(kind)}, 2_000)\nprocess.exit(9)`,
    ],
    { cwd: ROOT, stderr: "pipe", stdin: "pipe", stdout: "pipe" },
  )
  const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "still reading")])
  if (code === "still reading") proc.kill()
  return {
    code,
    err: await new Response(proc.stderr).text(),
    out: await new Response(proc.stdout).text(),
  }
}

// #2192: every hook reads its input by the deadline, so a stdin left open never holds one past the runner's timeout
describe("input", () => {
  test("a guard's stdin left open is refused at the deadline", async () => {
    const { code, err } = await open("guard")
    expect(code).toBe(2)
    expect(err).toContain("probe hook: the call's input did not arrive by its deadline")
  }, 20_000)

  test("a recorder's stdin left open exits 0 at the deadline with nothing written", async () => {
    const { code, err, out } = await open("recorder")
    expect(code).toBe(0)
    expect(out).toBe("")
    expect(err).toBe("")
  }, 20_000)

  test("an input that arrives is returned whole", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "--no-env-file",
        "-e",
        `import { input } from ${JSON.stringify(join(HOOKS, "input.ts"))}\nprocess.stdout.write(await input("probe", "guard", 2_000))`,
      ],
      { cwd: ROOT, stderr: "pipe", stdin: new TextEncoder().encode('{"a":1}'), stdout: "pipe" },
    )
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe('{"a":1}')
  }, 20_000)

  test("no hook reads stdin but through the shared reader, with its own name and kind", () => {
    const texts = new Map(
      readdirSync(HOOKS)
        .filter((f) => f.endsWith(".ts") && f !== "input.ts")
        .map((f) => [f.slice(0, -3), readFileSync(join(HOOKS, f), "utf8")]),
    )
    expect(
      [...texts]
        .filter(([, text]) => /\b(?:Bun|process)\.stdin\b/.test(text))
        .map(([name]) => name),
    ).toEqual([])
    const kinds = [...texts].flatMap(([name, text]) =>
      [...text.matchAll(/\binput\(\s*"([\w-]+)",\s*"(\w+)"/g)].map(
        (m) => `${name}: ${m[1]} ${m[2]}`,
      ),
    )
    expect(kinds.toSorted()).toEqual(
      [
        ...GUARDS.map((name) => `${name}: ${name} guard`),
        ...RECORDERS.map((name) => `${name}: ${name} recorder`),
      ].toSorted(),
    )
  })
})
