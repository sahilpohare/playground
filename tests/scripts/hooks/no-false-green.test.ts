import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-false-green"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-false-green.ts")
const slot = "~/.playground/ops/run-slot.sh worker-x --"

const input = (command: string) =>
  JSON.stringify({
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: "Bash",
  })
// The Bash tool runs in the user's shell; zsh unless a row names another
const bash = (command: string, shell = "/bin/zsh") => check(input(command), shell)

describe("bun with an option whose value is the next word, before run or test, is refused with the working form", () => {
  test.each([
    { $label: "--cwd before run", command: "bun --cwd /w run check-types" },
    { $label: "--env-file then --cwd=", command: "bun --env-file /w/.env --cwd=/w test x" },
    { $label: "--cwd before test", command: "bun --cwd /w test tests/a.test.ts" },
    { $label: "--env-file before test", command: "bun --env-file /w/.env test /w/a.test.ts" },
    { $label: "--preload before test", command: "bun --preload ./setup.ts test x" },
    { $label: "-r before test", command: "bun -r ./setup.ts test x" },
    { $label: "an option no list names, before test", command: "bun --conditions dev test x" },
    { $label: "--define before run", command: "bun --define X=1 run test" },
    { $label: "through run-slot", command: `${slot} bun --cwd /w test tests/a.test.ts` },
    { $label: "through bash run-slot", command: `bash ${slot} bun --cwd /w test tests/a.test.ts` },
    { $label: "inside bash -c", command: "bash -c 'bun --cwd /w run test'" },
    { $label: "run-slot inside bash -c", command: `bash -c '${slot} bun --cwd /w run test'` },
  ])("$label", async ({ command }) => {
    const reason = await bash(command)
    expect(reason).toContain("no-false-green hook refuses bun -")
    expect(reason).toContain("with a space")
    expect(reason).toContain("bun --cwd=<dir> run test:file <files>")
    // a bare bun test from the repo root stops at tests/require-sandbox.ts, so the fix names none
    expect(reason).not.toContain("bun test ")
  })
})

describe("a test run piped with no pipefail is refused, naming the fix", () => {
  test.each([
    { $label: "bun test into tail", command: "bun test tests/a.test.ts 2>&1 | tail -5" },
    { $label: "bun run test into tail", command: "bun run --cwd /w test | tail -20" },
    { $label: "test:skills into grep", command: "bun run test:skills | grep -c pass" },
    { $label: "check-types into tail", command: "bun run --cwd /w check-types | tail -3" },
    { $label: "through run-slot", command: `${slot} bun run --cwd /w test 2>&1 | tail -5` },
    { $label: "through sh -e run-slot", command: `sh -e ${slot} bun run --cwd /w test | tail -5` },
    {
      $label: "inside zsh -O -c, whose -O takes no value",
      command: "zsh -O -c 'bun test x | tail'",
    },
    { $label: "inside run-slot's bash -c", command: `${slot} bash -c 'bun test x | tail -5'` },
    { $label: "a shell running a test, piped", command: "bash -c 'bun test x' | tail" },
    { $label: "a shell with -- before its script", command: "bash -c -- 'bun test x' | tail" },
    { $label: "|& into tail", command: "bun test x |& tail" },
    { $label: "the second pipe", command: "bun test x | grep fail | head" },
    { $label: "chained into a commit", command: "bun test x | tail -3 && git commit -m x" },
    { $label: "bunx vitest", command: "bunx vitest run | tail" },
    { $label: "pnpm test", command: "pnpm --filter web test | tail" },
    {
      $label: "pipefail outside a bash -c script",
      command: `set -o pipefail; ${slot} bash -c 'bun test x | tail -5'`,
    },
    { $label: "PIPESTATUS under zsh", command: "bun test x | tail -5; exit ${PIPESTATUS[0]}" },
    { $label: "zsh pipestatus[0]", command: "bun test x | tail -5; exit ${pipestatus[0]}" },
    { $label: "setopt under bash", command: "bash -c 'setopt pipe_fail; bun test x | tail'" },
    {
      $label: "pipestatus inside bash -c",
      command: "bash -c 'bun test x | tail; exit ${pipestatus[1]}'",
    },
    { $label: "pytest into tail", command: "pytest -q | tail -5" },
    { $label: "uv run pytest", command: "uv run pytest -q tests/x.py 2>&1 | tail -20" },
    { $label: "python -m pytest", command: ".venv/bin/python -m pytest -q | tail -5" },
    {
      $label: "python -m pytest through env and run-slot",
      command: `${slot} /usr/bin/env PYTHONPATH=src .venv/bin/python -m pytest -q x 2>&1 | tail -12`,
    },
    { $label: "ty check into tail", command: "ty check src | tail -3" },
    { $label: "uv run with options, ty", command: "uv run --python 3.13 ty check | tail" },
    { $label: "uvx ruff", command: "uvx ruff check . | head" },
    {
      $label: "uv run with requirements, pytest",
      command: "uv run --with-requirements r.txt pytest | tail",
    },
    { $label: "uv tool run pytest", command: "uv tool run pytest -q | tail" },
    { $label: "uvx ruff at a version", command: "uvx ruff@latest check | tail" },
    { $label: "ruff format --check", command: "ruff format --check src | tail -1" },
  ])("$label", async ({ command }) => {
    const reason = await bash(command)
    expect(reason).toContain("no-false-green hook refuses a test run piped into")
    expect(reason).toContain("inside the script that holds the pipe")
    expect(reason).toContain("set -o pipefail")
  })
})

describe("a run whose exit status is the test's own runs", () => {
  test.each([
    { $label: "bun run --cwd", command: "bun run --cwd /w check-types" },
    { $label: "bun test --cwd", command: "bun test --cwd /w tests/a.test.ts" },
    { $label: "bun test --env-file", command: "bun test --env-file /w/.env /w/a.test.ts" },
    { $label: "the briefs' bun run --cwd", command: "bun run --cwd /w/wt test:skills" },
    {
      $label: "the briefs' bun test --env-file",
      command: "bun test --env-file /w/wt/.env /w/wt/tests/a.test.ts",
    },
    { $label: "the briefs' run-slot suite", command: `${slot} bun run test` },
    { $label: "the briefs' run-slot check-types", command: `${slot} bun run --cwd /w check-types` },
    { $label: "output written to a file", command: `${slot} bun run test > /w/test.log 2>&1` },
    { $label: "output appended to a file", command: "bun test x >> /w/test.log 2>&1" },
    { $label: "a commit read whole", command: "git -C /w commit -F /w/msg.txt 2>&1" },
    {
      $label: "a commit through run-slot, tailed",
      command: `${slot} git -C /w commit -F /w/m 2>&1 | tail -3`,
    },
    { $label: "bun --cwd install", command: "bun --cwd /w install" },
    { $label: "--cwd= before test", command: "bun --cwd=/w test tests/a.test.ts" },
    { $label: "--cwd= before run", command: "bun --cwd=/w run test" },
    { $label: "--env-file= before test", command: "bun --env-file=/w/.env test /w/a.test.ts" },
    { $label: "--preload= before test", command: "bun --preload=./setup.ts test x" },
    { $label: "--conditions= before test", command: "bun --conditions=dev test x" },
    { $label: "a boolean option before test", command: "bun --bun test x" },
    { $label: "bun x after an option", command: "bun --bun x vitest run" },
    {
      $label: "the reviewer brief's single-test form",
      command: "env NODE_ENV=production SKIP_ENV_VALIDATION=true bun --cwd=/w test tests/a.test.ts",
    },
    { $label: "a shell script file, piped", command: "bash scripts/x.sh | tail" },
    { $label: "bun --no-env-file test", command: "bun --no-env-file test x" },
    { $label: "a hook script", command: "bun --no-env-file scripts/hooks/no-stash.ts" },
    { $label: "run-slot, no pipe", command: `${slot} bun run --cwd /w test` },
    {
      $label: "a test run piped into run-slot with no --, which runs nothing",
      command: "bun test x | ~/.playground/ops/run-slot.sh worker-x",
    },
    {
      $label: "a test run piped into run-slot with nothing after its --, which runs nothing",
      command: "bun test x | ~/.playground/ops/run-slot.sh worker-x --",
    },
    {
      $label: "a test run piped into bash run-slot with nothing after its --, which runs nothing",
      command: "bun test x | bash ~/.playground/ops/run-slot.sh worker-x --",
    },
    {
      $label: "a test run piped into bash run-slot with no --, which runs nothing",
      command: "bun test x | bash ~/.playground/ops/run-slot.sh worker-x",
    },
    { $label: "pipefail first", command: "set -o pipefail; bun test x | tail -5" },
    {
      $label: "PIPESTATUS after",
      command: `${slot} bash -c 'cd /w && bun test x 2>&1 | tail -5; exit \${PIPESTATUS[0]}'`,
    },
    { $label: "zsh pipestatus", command: "bun test x | tail -5; exit ${pipestatus[1]}" },
    { $label: "zsh pipestatus unbraced", command: "bun test x | tail -5; exit $pipestatus[1]" },
    { $label: "zsh setopt pipe_fail", command: "setopt pipe_fail; bun test x | tail -5" },
    { $label: "zsh setopt PIPEFAIL", command: "setopt PIPEFAIL; bun test x | tail -5" },
    { $label: "bash set -euo pipefail", command: "bash -c 'set -euo pipefail; bun test x | tail'" },
    {
      $label: "PIPESTATUS under bash",
      command: "bun test x | tail -5; exit ${PIPESTATUS[0]}",
      shell: "/bin/bash",
    },
    {
      $label: "pipefail inside run-slot's bash -c",
      command: `${slot} bash -c 'set -o pipefail; bun test x | tail -5'`,
    },
    { $label: "into a file", command: "bun test x > /tmp/log 2>&1" },
    { $label: "a build piped", command: "bun run build | tail" },
    { $label: "git log piped", command: "git log --oneline | head -5" },
    { $label: "test output read", command: "cat test.log | tail" },
    { $label: "a test named in an echo", command: "echo bun test | tail" },
    { $label: "pytest with pipefail first", command: "set -o pipefail; pytest -q | tail -5" },
    { $label: "ty into a file, then its status", command: 'ty check > out.txt; echo "rc: $?"' },
    {
      $label: "pytest with zsh pipestatus",
      command: 'pytest -q | tail -5; echo "rc: ${pipestatus[1]}"',
    },
    { $label: "ruff with no pipe", command: "ruff check src" },
    { $label: "a python script piped", command: "python3 scripts/x.py | tail" },
    { $label: "uv run of a script piped", command: "uv run scripts/x.py | tail" },
    { $label: "pip list piped", command: "uv pip list | grep pytest" },
  ])("$label", async ({ command, shell }: { command: string; shell?: string }) => {
    expect(await bash(command, shell)).toBeUndefined()
  })

  test("another tool is not read", async () => {
    expect(
      await check(JSON.stringify({ tool_input: { file_path: "bun" }, tool_name: "Read" })),
    ).toBeUndefined()
  })

  test("input it cannot read runs", async () => {
    expect(await check("not json")).toBeUndefined()
  })
})

test("the script exits 2 with the reason on stderr", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", script], {
    env: { ...process.env, PLAYGROUND_ROLE: "worker" },
    stderr: "pipe",
    stdin: new Blob([input("bun test x | tail")]),
  })
  expect(await proc.exited).toBe(2)
  expect(await new Response(proc.stderr).text()).toContain("no-false-green hook refuses")
})

describe("a git push piped with no pipefail is refused, naming the bare push and its check (#1764)", () => {
  test.each([
    { $label: "into grep", command: "git push origin feat-quill-77 | grep error" },
    { $label: "into tail", command: "git push -u origin feat-quill-77 2>&1 | tail -3" },
    { $label: "through git -C", command: "git -C /w/wt push origin feat-quill-77 | tail -5" },
    { $label: "through git -c", command: "git -c push.default=current push | grep -v hint" },
    { $label: "inside bash -c", command: "bash -c 'git push origin feat-quill-77 | tail'" },
    { $label: "through run-slot", command: `${slot} git push origin feat-quill-77 | tail` },
  ])("$label", async ({ command }) => {
    const reason = await bash(command)
    expect(reason).toContain("no-false-green hook refuses a git push piped into")
    expect(reason).toContain("git ls-remote origin refs/heads/<branch>")
  })

  test.each([
    { $label: "a bare push", command: "git push origin feat-quill-77" },
    { $label: "a bare push with its output", command: "git push -u origin feat-quill-77 2>&1" },
    {
      $label: "a piped push under pipefail",
      command: "set -o pipefail; git push origin feat-quill-77 | tail -3",
    },
    {
      $label: "a piped push under pipefail inside bash -c",
      command: "bash -c 'set -o pipefail; git push origin feat-quill-77 | tail -3'",
    },
    {
      $label: "the check after it, piped",
      command: "git ls-remote origin refs/heads/feat-quill-77 | cut -f1",
    },
    { $label: "another git command piped", command: "git log --oneline | head -3" },
  ])("allowed: $label", async ({ command }) => {
    expect(await bash(command)).toBeUndefined()
  })
})
