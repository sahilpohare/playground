import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-raw-delete"
import { NEVER_MADE } from "./fixtures/refused-forms"

// Every form here is data passed to check(); none runs. Refused rows live in fixtures/refused-forms/, one file a source.
const SESSION = "0a1b2c3d-4e5f-6789-abcd-ef0123456789"
const SCRATCH = `/private/tmp/claude-501/-Users-x-playground/${SESSION}/scratchpad`
const WORKTREE = join(homedir(), "x", ".claude", "worktrees", "y")

const input = (command: string, extra: Record<string, unknown> = {}, cwd = WORKTREE) =>
  JSON.stringify({
    cwd,
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_input: { command },
    tool_name: "Bash",
    ...extra,
  })

describe("a delete the hook lets run", () => {
  test.each([
    "rm notes.txt",
    "rm -f a.log b.log",
    `rm ${WORKTREE}/web/next/.env.local`,
    `rm ${SCRATCH}/probe.ts`,
    `rm -f ${SCRATCH.replace("/private", "")}/out.json`,
    "rm -- -odd-name",
    "rmdir empty",
    "docker rm -fv playground-y-db",
    'docker rm -fv "$CID"',
    "bun rm left-pad",
    "git rm --cached notes.txt",
    "rm *.log",
    "git clean --dry-run -dx",
    "rsync -a src/ dst/",
    "~/.playground/ops/run-slot.sh me -- rm notes.txt",
    "~/.playground/ops/run-slot.sh me -- bun run test",
    'C="rm notes.txt"; $C',
    "W=me; ~/.playground/ops/run-slot.sh $W -- bun run test",
    "git clean -f",
    "git clean -n -d",
    "git clean -ndx",
    `git worktree remove ${WORKTREE}`,
    "chmod -R u+w web",
    "chmod -w notes.txt",
    "echo 'rm -rf x'",
    "grep -n 'rm -rf' scripts/hooks/README.md",
    `git grep -n -E "rm -r[f]?|rm -fr|worktree remove" -- '*.md'`,
    `git commit -m "docs: name rm -rf in words"`,
    "git -c alias.st=status st",
    "sed -i '' 's|rm -rf a|rm -rf b|' notes.txt",
    `bun scripts/roster.ts report ops "shipped; rm incident contained"`,
    `python3 -c "print('rm -rf x')"`,
    "ls -la",
    "rm --help",
    "while gh pr checks 1 >/dev/null 2>&1; [ $? -eq 8 ]; do sleep 120; done",
    '[ -n "$R" ] && [ -f $R/x ] && echo ok',
    "$T git clone -q $S/mirror.git $S/home",
    "$R/scripts/spawn.sh column reviewer $W --pr 1",
    "gh pr checks $N -R owner/repo",
    "'/bin/r?' -rf sub",
    // #2244's controls: a glob used only as an argument, a glob that matches no file, an array the reader resolves, and an array the reader cannot read in a call that names no delete
    "ls /bin/r?",
    "/no/such/folder/r? notes.txt",
    'A=(rm notes.txt); "${A[@]}"',
    'A=(echo hi); A+=(there); "${A[@]}"',
    // #2259's controls: a commit subject holding (…), a brace list or a subshell used only as an argument or a group, code with braces and parens a spaced word holds, and a commit scope read as a line after a cd into a folder that is gone
    "git commit -m 'fix(PG-1): rm (a|b) files'",
    'git commit -m "fix(#12): rm stale files"',
    "mkdir -p /tmp/zz/{a,b}",
    "(cd /tmp && ls)",
    `agent-browser eval 'JSON.stringify({rm: f("(a: b)"), h: g()})'`,
    `agent-browser eval "x.match(/rm[^a]{0,90}|y[^a]{0,60}/g)"`,
    `cd /no/such/folder; ~/.playground/ops/run-slot.sh w -- git commit -m "docs(PG-1): rm help"`,
    `~/.playground/ops/run-slot.sh me -- git commit -m "fix(PG-1): playground rm moves a file" -m "a (b) c"`,
    'rmdir "${S:?}/${m:?}"',
    "mv web/next/.next .turbo /tmp/claude-501/p/s/scratchpad/cold-1/",
    "playground rm sub/old",
    "playground rm --worktree .claude/worktrees/old",
    "fd . src --exec=echo",
    "rsync -a --delay-updates src/ dst/",
    "npx -y @scope/tool@1 build",
    "shred notes.txt",
    "tar -czf out.tgz src",
    "fd -tx . bin",
    "fd -Hx echo",
    "fd -te -x echo",
    "at -l",
    "echo 'ls' | at now",
    'c="ls -la"; $c',
    'c="rm -rf x"; "$c"',
    "git diff | delta",
    "redis-cli del lock",
    "docker exec playground-x-redis redis-cli del k",
    "bun add -d del-cli",
    "sudo -s <<< 'ls'",
    "su <<< 'echo hi'",
    "sudo su <<'EOF'\nls -la\nEOF",
    'sudo -s <<< "ls $NO_SUCH_VAR_1146"',
    'su <<< "echo $(curl -s example.com)"',
    'sudo -s < "$NO_SUCH_VAR_1146"',
    "{ bash; } <<< 'ls -la'",
    "bash 3<<< 'ls' <&3",
    'bash <<< "$(echo ls)"',
    'S=ls; bash <<< "$S"',
    "pkexec <<< 'ls'",
    "echo ls | pkexec su",
    "{ echo ls | bash; } <<< 'rm -rf x'",
    // #2136's controls: a program word the reader resolves, and an expansion used only as an argument
    'A=(echo hi); "${A[@]}"',
    "S='echo hi'; eval \"$S\"",
    "S='ls -la'; sh -c \"$S\"",
    "for c in echo; do $c hi; done",
    'cat "$F"',
  ])("%s", async (command) => {
    expect(await check(input(command))).toBeUndefined()
  })

  // bun run runs the nearest package.json's script of that name in place of a program, from a subfolder too (#2397)
  test("bun run del, where the package.json above the folder names a del script", async () => {
    const root = mkdtempSync(join(tmpdir(), "raw-delete-script-"))
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { del: "echo del" } }))
    expect(await check(input("bun run del", {}, root))).toBeUndefined()
    expect(await check(input("bun run del", {}, join(root, "sub")))).toBeUndefined()
    expect(await check(input(`bun run --cwd ${root} del`, {}, tmpdir()))).toBeUndefined()
  })

  // a runner's folder option is a folder, never a program word, even in a variable (#2397's 7-day replay)
  test("bunx's --cwd in a variable, before files under it", async () => {
    const w = join(tmpdir(), "raw-delete-w")
    expect(
      await check(input(`W=${w}; bunx --cwd $W oxfmt $W/tests/a.test.ts $W/b.ts`)),
    ).toBeUndefined()
  })
})

describe("a delete the hook refuses, naming playground rm", () => {
  test.each<[string, string, string]>([
    [`a recursive rm in the session's own scratchpad`, `rm -rf ${SCRATCH}/clone`, WORKTREE],
    [
      `a plain rm in another session's scratchpad`,
      `rm ${SCRATCH.replace(SESSION, "other")}/x`,
      WORKTREE,
    ],
    [`a plain rm through .. out of the worktree`, "rm ../../../../.zshrc", WORKTREE],
    [`a plain rm of the worktree from outside it`, `rm ${WORKTREE}/x`, homedir()],
    [`a plain rm with a word it cannot read`, 'rm "$F"', WORKTREE],
  ])("%s", async (_, command, cwd) => {
    const reason = await check(input(command, {}, cwd))
    expect(reason).toContain("no-raw-delete hook ")
    expect(reason).toContain("playground rm")
  })

  test("a forced worktree removal is pointed at playground rm --worktree", async () => {
    expect(await check(input(`git worktree remove --force ${WORKTREE}`))).toContain(
      "Remove a worktree with playground rm --worktree <path>",
    )
  })

  test("a tree over the trash's limit is pointed at the cleanup and a reinstall", async () => {
    const reason = await check(input("rm -rf node_modules"))
    expect(reason).toContain("leave a bigger tree or a scratch folder in place")
    expect(reason).toContain("bun install rebuild a node_modules in place")
  })

  test("a command built from a value it cannot read, in a call that names a delete, is pointed at a script file", async () => {
    const reason = await check(input(`A=(echo -rf ${NEVER_MADE}); A[0]=rm; "\${A[@]}"`))
    expect(reason).toContain("a command built from a value it cannot read")
    expect(reason).toContain("write the script to a file and run it")
  })

  test("a word it cannot read is named by its variable", async () => {
    expect(await check(input('rm "$F"'))).toContain("a word the hook cannot read ($F)")
  })

  test("a sub-agent's call, marked by agent_id and agent_type, is refused as the main session's is", async () => {
    const command = `screen -dm sh -c 'rm -rf ${NEVER_MADE}'`
    const main = await check(input(command))
    const sub = await check(input(command, { agent_id: "a1b2c3", agent_type: "general-purpose" }))
    expect(main).toContain("no-raw-delete hook ")
    expect(sub).toBe(main)
  })

  test("an input it cannot parse that reads as a delete is refused", async () => {
    expect(await check(`{"tool_name":"Bash","tool_input":{"command":"rm -rf x"`)).toContain(
      "no-raw-delete hook ",
    )
    expect(await check("not json")).toBeUndefined()
  })
})

describe("agent-browser eval's script is JavaScript, never a shell command line (PG-1695)", () => {
  const INBOX = `agent-browser eval 'document.querySelector("section[aria-busy][aria-label=Inbox]")?.outerHTML.slice(0,1500) ?? "no busy inbox"'`

  test("the cause: a spaced word read as a shell line holds a glob program word and a ?? that may expand to -r", async () => {
    expect(await check(input("a?.b ?? 1"))).toContain(
      "a program the hook cannot read (a?.b) given -r",
    )
    expect(await check(input("some-tool 'a?.b ?? 1'"))).toContain(
      "a program the hook cannot read (a?.b) given -r",
    )
  })

  test.each([
    "agent-browser eval 'a?.b ?? 1'",
    `agent-browser eval 'f("x")?.outerHTML ?? "none"'`,
    INBOX,
    "agent-browser open http://x.localhost && agent-browser eval 'a?.b ?? 1'",
    // #1887: a --session name before eval, alone or by =, and the same call's other commands
    "agent-browser --session t eval 'a?.b ?? 1'",
    "agent-browser --session=t eval 'a?.b ?? 1'",
    "agent-browser --session t open http://x.localhost && agent-browser --session t eval 'a?.b ?? 1'",
    "agent-browser --session t eval 'document.title'",
    // #2320: --args' launch flags holding no blank, --ignore-https-errors and --json before eval too
    `agent-browser --args "--no-sandbox,--mute-audio" --session t --ignore-https-errors eval 'a?.b ?? 1'`,
    "agent-browser --args=--no-sandbox --json eval 'a?.b ?? 1'",
  ])("%s runs", async (command) => {
    expect(await check(input(command))).toBeUndefined()
  })

  test.each([
    "$RM -r x",
    "r? -rf x",
    "agent-browser eval 'a?.b ?? 1' && r? -rf x",
    `agent-browser eval "$(rm -rf ${NEVER_MADE})"`,
    `agent-browser rm -rf ${NEVER_MADE}`,
    // #1887: another option before eval, a session name and no eval, and a substitution in the session's script; #2320: --args' launch flags holding a blank
    "agent-browser --profile p eval 'a?.b ?? 1'",
    `agent-browser --args "--renderer-cmd-prefix=r? -rf x" eval 'a?.b ?? 1'`,
    `agent-browser --session t rm -rf ${NEVER_MADE}`,
    `agent-browser --session t eval "$(rm -rf ${NEVER_MADE})"`,
  ])("%s is still refused", async (command) => {
    expect(await check(input(command))).toContain("no-raw-delete hook ")
  })
})
