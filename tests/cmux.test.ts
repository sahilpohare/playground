import { expect, test } from "bun:test"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const HISTORY = "dated history"
const GUARD =
  "one of the three guards against the cmux app (no-raw-spawn's cmux branch, the PATH shim filter, the CMUX_* env strip), or a doc stating it, live while cmux.app is installed (#1478)"
const RUNNER = "the pre-commit job that runs this test, naming it by its path"
const PROOF =
  "a doc stating a test that nothing calls, opens or types through the cmux app (herdr.test.ts's pane typing, fixture.test.ts, unstick's run.test.ts, cmux-open.test.ts), live while cmux.app is installed (#1478)"

// Every line outside tests/ that names cmux (#414), counted per file; a file not listed names it nowhere. The test checks each file's count, and each class records for its reader why those lines stay.
const ALLOWED: Record<string, [number, string]> = {
  ".agents/adr/0010-ops-alerts-go-through-a-relay.md": [1, HISTORY],
  ".agents/dashboard/herdr.md": [1, PROOF],
  ".agents/dashboard/messages.md": [2, `${PROOF}; ${GUARD}`],
  ".agents/dashboard/stack.md": [1, PROOF],
  "AGENTS.md": [1, GUARD],
  "api/hono/src/lib/claude-binary.ts": [2, GUARD],
  "api/hono/src/plugins/changelog/seed.json": [2, HISTORY],
  "docs/playground/playbook.md": [2, HISTORY],
  "extensions/core/skills/code-review-loop/SKILL.md": [1, HISTORY],
  "extensions/core/skills/playbook/SESSIONS.md": [1, GUARD],
  "extensions/core/skills/playbook/SPAWN.md": [1, HISTORY],
  "lefthook.yml": [1, RUNNER],
  "packages/scripts/src/ops-herdr/cli.ts": [1, GUARD],
  "packages/scripts/src/ops-herdr/herdr.ts": [1, GUARD],
  "packages/scripts/src/parity/replay/run.ts": [1, GUARD],
  "scripts/README.md": [4, `${HISTORY}; ${GUARD}`],
  "scripts/hooks/bundled/guards.js": [10, `${GUARD}, bundled beside every other Bash guard`],
  "scripts/hooks/no-raw-spawn.ts": [17, GUARD],
  "scripts/ops/README.md": [2, PROOF],
}

test("no line outside tests/ names cmux but dated history and the guards against the installed app (#414)", () => {
  const out = Bun.spawnSync(["git", "-C", ROOT, "grep", "-c", "-i", "cmux", "--", ".", ":!tests"], {
    stdout: "pipe",
  })
  const counts = Object.fromEntries(
    out.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.lastIndexOf(":")
        return [line.slice(0, at), Number(line.slice(at + 1))]
      }),
  )
  expect(counts).toEqual(
    Object.fromEntries(Object.entries(ALLOWED).map(([file, [count]]) => [file, count])),
  )
})
