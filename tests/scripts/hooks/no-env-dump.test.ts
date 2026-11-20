import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-env-dump"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-env-dump.ts")

const input = (command: string) =>
  JSON.stringify({
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: "Bash",
  })
const bash = (command: string) => check(input(command))

describe("a command that prints the environment is refused, with the fix", () => {
  test.each([
    "env",
    "arr=(a $(env) b)",
    "arr=(`env`)",
    "declare -a arr=($(env))",
    "arr+=($(env))",
    "x=( $(env) )",
    "arr=(<(env))",
    "\\env",
    "'env'",
    'e"n"v',
    "env -0",
    "env -i",
    "env FOO=1",
    "env | grep GH_",
    "echo hi && env",
    "(env)",
    "command env",
    "sudo env",
    "bash -c env",
    "sh -c 'printenv'",
    "eval env",
    "printenv",
    "printenv GITHUB_TOKEN",
    "set",
    "set | grep TOKEN",
    "export",
    "export -p",
    "declare -p",
    "declare -x",
    "typeset",
  ])("%s", async (command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-env-dump hook refuses")
    expect(reason).toContain("env VAR=x <command>")
  })
})

describe("a command that runs with the environment, or names it, runs", () => {
  test.each([
    "env VAR=x bun run test",
    "env -u FOO node x.js",
    "env PLAYGROUND_ROLE=worker claude -n worker-x",
    "set -e",
    "set -euo pipefail",
    "set -o",
    "export FOO=1",
    "FOO=/usr/bin/env",
    "declare -f",
    "typeset -F",
    'echo "$HOME"',
    "git log --format=env",
    "grep env .env.example",
    "cat .env.example",
    'echo "env"',
    "envsubst < template",
    "bun run --env-file x dev",
    'for s in bash zsh; do env -i PATH=/usr/bin:/bin $s -c "$f"; done',
    'for f in a b; do for s in bash zsh; do env -i PATH=/usr/bin:/bin $s -c "$f"; done; done',
  ])("%s", async (command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("another tool is not read", async () => {
    expect(
      await check(JSON.stringify({ tool_input: { file_path: "env" }, tool_name: "Read" })),
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
    stdin: new Blob([input("env")]),
  })
  expect(await proc.exited).toBe(2)
  expect(await new Response(proc.stderr).text()).toContain("no-env-dump hook refuses env")
})
