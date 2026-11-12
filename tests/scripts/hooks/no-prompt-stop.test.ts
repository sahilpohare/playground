import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-prompt-stop"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-prompt-stop.ts")

const bash = (command: string) =>
  check(
    JSON.stringify({
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
  )

describe("a removal whose target has two or more parts that start with a variable is refused, with the fix", () => {
  test.each([
    [
      "the loop that stopped a worker",
      "S=/tmp/x; for m in a b; do rm -rf $S/$m; mkdir -p $S/$m; done",
    ],
    ["the run-slot step that stopped ops", "O=~/q; rmdir $O/$s && echo freed"],
    ["a deeper path", "rmdir $O/$s/g"],
    ["HOME counts as a variable", "rmdir $HOME/$s"],
    ["rm -r", "rm -r $O/$s"],
    ["rm that is not recursive", "rm -f $O/$s"],
    ["two unguarded beside a guarded one", 'rmdir "${O:?}"/$s/$t'],
    ["inside a compound command", "git status && rm -rf $T/$u"],
    [
      "a part that starts with a variable and ends in a name",
      "S=/x; for v in p; do rmdir $S/$v.d; done",
    ],
  ])("%s", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-prompt-stop hook refuses")
    // rmdir runs guarded, and no-raw-delete refuses a guarded rm, so an rm is sent to a literal path
    const rmdir = /refuses rmdir /.test(reason ?? "")
    expect(reason).toContain(rmdir ? "${VAR:?}" : "playground rm <literal path>")
    expect(reason).not.toContain(rmdir ? "playground rm" : "${VAR:?}")
  })
})

describe("a removal of a name directly in / is refused, with the fix", () => {
  test.each([
    [
      "the call that stopped a reviewer's sub-agent",
      "echo x > /scratchpad_$$.1; rm -f /scratchpad_*",
    ],
    ["a glob", "rm -f /scratchpad_*"],
    ["a literal name", "rm -f /scratchpad_x"],
    ["rmdir", "rmdir /scratchpad_x"],
    ["a trailing slash", "rm -rf /scratchpad_x/"],
    ["beside a removal that runs", "rm -f /tmp/x /scratchpad_x"],
  ])("%s", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-prompt-stop hook refuses")
    // no-raw-delete refuses an rm in $TMPDIR, so only an rmdir is sent there
    expect(reason).toContain("the session's scratchpad")
    if (/refuses rmdir /.test(reason ?? "")) expect(reason).toContain("$TMPDIR")
    else expect(reason).not.toContain("$TMPDIR")
  })
})

test("the reason shows where the variable and guarded parts are", async () => {
  expect(await bash("rm -rf $S/$m")).toContain("rm $…/$…:")
  expect(await bash('rmdir "${O:?}"/$s/$t')).toContain("rmdir ${…:?}/$…/$…:")
})

describe("what Claude Code runs, runs", () => {
  test.each([
    ["a guarded path", 'rm -rf "${S:?}/${m:?}"'],
    ["one guarded, one not", 'rmdir "${O:?}"/$s'],
    ["a guarded variable with a message", 'rm -rf "${OUT:?set OUT}"/dist'],
    ["one variable and a name", 'rmdir "$O"/d'],
    ["one variable alone", 'rmdir "$O"'],
    ["one variable set earlier in the command", 'W=/x; rm -rf "$W"'],
    ["the merge-lock step", "rm -f $L/pr; rmdir $L"],
    ["one variable and a literal tail", "rmdir $O/run-slot"],
    ["a variable after a name in its part", "S=/x; for v in 9; do rmdir $S/p$v; done"],
    ["PWD and a variable after a name", "rm -rf $PWD/m$n"],
    ["a literal absolute path", "rm -rf /private/tmp/claude-501/scratch/old"],
    ["a home path", "rmdir ~/.playground/ops/run-slot"],
    ["a redirect into /", "echo x > /scratchpad_$$.1"],
    ["a name two levels below /", "rm -f /scratchpad_dir/x"],
    ["a glob in a folder of /", "rm -f /usr/scratchpad_*"],
    ["a glob in $TMPDIR", "rm -f $TMPDIR/scratchpad_*"],
    ["a name in /tmp", "rm -f /tmp/scratchpad_x"],
    ["a name in home", "rm -f ~/scratchpad_x"],
    ["text that only names rm", "echo 'rm -rf $X/$Y is refused'"],
    ["a heredoc that holds it", "cat <<'EOF'\nrm -rf $X/$Y\nEOF"],
    ["no rm at all", "ls $S/$m"],
  ])("%s", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("it fails open", () => {
  test("input that is not JSON runs", async () => {
    expect(await check("rm -rf $X {")).toBeUndefined()
  })

  test("another tool runs", async () => {
    expect(
      await check(JSON.stringify({ tool_input: { file_path: "/x" }, tool_name: "Write" })),
    ).toBeUndefined()
  })

  test("as a script it exits 2 with the reason, and 0 otherwise", async () => {
    const run = async (command: string) => {
      const proc = Bun.spawn(["bun", "--no-env-file", script], {
        env: { ...process.env, PLAYGROUND_ROLE: "worker" },
        stderr: "pipe",
        stdin: new Response(JSON.stringify({ tool_input: { command }, tool_name: "Bash" })),
      })
      return { code: await proc.exited, err: await new Response(proc.stderr).text() }
    }
    const refused = await run("rm -rf $S/$m")
    expect(refused.code).toBe(2)
    expect(refused.err).toContain("no-prompt-stop hook refuses")
    expect((await run("rm -rf /tmp/literal")).code).toBe(0)
    expect((await run('rmdir "$O"/d')).code).toBe(0)
  })
})

test("the factory settings run it on Bash through guards", async () => {
  const settings = (await Bun.file(join(root, "scripts", "factory-settings.json")).json()) as {
    hooks: { PreToolUse: { hooks: { command: string }[]; matcher: string }[] }
  }
  const entry = settings.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => h.command.includes("scripts/hooks/bundled/guards.js")),
  )
  expect(entry?.matcher).toBe("^Bash$")
})
