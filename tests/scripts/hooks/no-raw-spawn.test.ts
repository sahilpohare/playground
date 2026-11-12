import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-raw-spawn"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-raw-spawn.ts")

const bash = (command: string) =>
  check(
    JSON.stringify({
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
  )

const SETTINGS = "--settings $HOME/.playground/factory-settings.json"

describe("a session not started through scripts/spawn.sh is refused, naming the script", () => {
  test.each([
    ["a spawn inside an array assignment", "arr=($(cmux new-workspace --command claude))"],
    [
      "SESSIONS.md's old worker spawn",
      `CMUX_QUIET=1 cmux new-workspace --name worker-x --cwd /w --command "env PLAYGROUND_ROLE=worker claude -n worker-x ${SETTINGS}" --focus false`,
    ],
    [
      "the rush brief's old reviewer spawn",
      `CMUX_QUIET=1 cmux new-split right --workspace "$CMUX_WORKSPACE_ID" --command "env PLAYGROUND_ROLE=reviewer claude -n reviewer-x ${SETTINGS}" --focus false`,
    ],
    ["--command= attached", "cmux new-split right --command='claude -n x' --focus false"],
    ["claude by its path", "cmux new-workspace --command '/opt/homebrew/bin/claude -n x'"],
    ["claude inside a shell", `cmux new-workspace --command "zsh -lc 'claude -n x'"`],
    ["claude after another command", `cmux new-workspace --command "cd /w && claude"`],
    ["a resume in a new workspace", `cmux new-workspace --command "claude --resume worker-x"`],
    ["a --command the hook cannot read", 'cmux new-split right --command "$CMD"'],
    ["cmux behind env", "env CMUX_QUIET=1 cmux new-workspace --command claude"],
    ["after other commands", "date && cmux new-workspace --command claude"],
    ["a resume in this shell", "claude --resume worker-x"],
    ["a resume by -r", "claude -r worker-x -p hi"],
    ["a resume with =", "claude --resume=worker-x"],
    ["a continue", "claude --continue"],
    ["a terminal surface after --", "cmux surface new-terminal --machine local -- claude -n x"],
    [
      "a terminal surface whose command it cannot read",
      "cmux surface new-terminal --machine local -- $CMD",
    ],
    ["a resume command after --", "cmux surface resume set -- claude --resume x"],
    ["a resume command by --shell", "cmux surface resume set --shell 'claude -n x'"],
    ["a fork of a Claude session", "cmux fork claude 0f1e2d"],
    ["a fork with its surface first", "cmux fork --surface surface:3 claude 0f1e2d"],
    ["a fork whose kind it cannot read", "cmux fork $KIND 0f1e2d"],
    ["a vault fork of a Claude session", "cmux vault fork --agent claude --session s1 --open"],
    ["a cloud Claude agent", "cmux agent claude -- fix the bug"],
    ["a cloud Claude agent by --agent=", "cmux agent --agent=claude -- fix the bug"],
    ["a hibernated agent woken", "cmux agent-hibernation wake surface:3"],
    ["a hibernated agent woken by its alias", "cmux agent wake surface:3"],
    ["a fork behind a program it cannot read", "$CMUX fork claude 0f1e2d"],
    ["a fork of whatever the surface held", "cmux fork --surface surface:2"],
    ["a restore of a Claude session", "cmux restore claude 0f1e2d"],
    ["a restore of whatever the surface held", "cmux restore --surface surface:2"],
    ["a session restore", "cmux session restore --session s1"],
    ["a restore of the whole app session", "cmux restore-session"],
    ["Claude teams", "cmux claude-teams -n x"],
    ["Claude teams behind a global option's value", "cmux --password pw claude-teams"],
    ["a session restore behind --id-format", "cmux --id-format both restore-session"],
    ["Oh My Claude Code", "cmux omc"],
    ["a tmux session behind a variable", "X=cmux; $X local-tmux start x --command claude"],
    ["an Oh My Claude Code team", 'cmux omc team 3:claude "x"'],
    ["a recovered session", "cmux recover --session 0f1e2d"],
    ["a recovered session by --session=", "cmux recover --session=0f1e2d"],
    [
      "a layout surface that runs claude",
      `cmux new-workspace --layout '{"pane":{"surfaces":[{"type":"terminal","command":"claude -n x"}]}}'`,
    ],
    [
      "a layout agent-session surface",
      `cmux new-workspace --layout='{"pane":{"surfaces":[{"type":"agent-session","provider":"claude"}]}}'`,
    ],
    ["a layout it cannot read", 'cmux new-workspace --layout "$L"'],
    ["a command whose program it cannot read", "cmux new-workspace --command 'c=claude; $c -n x'"],
    ["a continue by -c", "claude -c -p hi"],
    ["a new pane", 'cmux new-pane --direction right --command "claude -n x"'],
    ["a new surface", 'cmux new-surface --pane pane:1 --command "claude -n x"'],
    ["a Claude agent-session surface", "cmux new-surface --type agent-session --provider claude"],
    ["a provider given with =", "cmux new-surface --type=agent-session --provider=claude"],
    ["a provider it cannot read", 'cmux new-surface --type agent-session --provider "$P"'],
    [
      "a respawned pane by --command",
      'cmux respawn-pane --surface surface:3 --command "claude -n x"',
    ],
    ["a respawned pane by its trailing words", "cmux respawn-pane --surface surface:3 claude -n x"],
    ["a respawned pane whose words it cannot read", "cmux respawn-pane --surface surface:3 $CMD"],
  ])("%s", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-raw-spawn hook refuses")
    expect(reason).toContain(join(root, "scripts", "spawn.sh"))
  })
})

describe("everything else runs", () => {
  test.each([
    ["spawn.sh itself", `${root}/scripts/spawn.sh worker worker-x brief-x.md`],
    [
      "spawn.sh by its home path",
      "~/.claude/skills/playbook/../../../scripts/spawn.sh runner runner-x b.md",
    ],
    ["a headless trial", "claude -p 'read the skill' < /dev/null"],
    ["claude's version", "claude --version"],
    ["text that names a spawn", "echo 'cmux new-workspace --command claude'"],
    ["a grep for it", "grep -rn 'claude --resume' docs"],
    ["another program behind a variable", "$EDITOR -- $FILE"],
    ["an MCP server whose command follows --", 'claude mcp add foo -- bash -c "echo hi"'],
  ])("%s", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

// #665's D4 (a): every session runs in herdr and no factory session calls cmux, so every cmux call but its help or version alone is refused, by any path, behind env or a global option, and as a program it cannot read followed by one of cmux's session commands.
describe("cmux runs only for its help or version", () => {
  test.each([
    ["a split with a plain shell", "cmux new-split right --command zsh --focus false"],
    ["a split with no command", "cmux new-split right --workspace workspace:3"],
    ["cmux reads", "cmux tree --workspace workspace:3"],
    ["closing a surface", "cmux close-surface --surface surface:4"],
    ["a codex agent-session surface", "cmux new-surface --type agent-session --provider codex"],
    ["a browser surface", "cmux new-surface --type browser --url https://example.com"],
    ["a pane with a plain shell", "cmux new-pane --direction right"],
    ["a terminal surface with no command", "cmux surface new-terminal --machine local"],
    ["a terminal surface with a shell", "cmux surface new-terminal --machine local -- zsh"],
    ["a message that names claude", 'cmux agent message builder "claude is fine"'],
    ["a fork of a Codex session", "cmux fork codex 0f1e2d"],
    ["a vault search for Claude sessions", "cmux vault sessions --agent claude"],
    ["an agent put to sleep", "cmux agent-hibernation hibernate surface:3"],
    ["a screen read with a variable", "cmux read-screen --surface $S --lines 40"],
    ["a restore of a Codex session", "cmux restore codex 0f1e2d"],
    ["a cloud Codex agent", "cmux agent codex -- fix the bug"],
    ["keystrokes after --", 'cmux send --surface surface:2 -- "hello $USER"'],
    ["a notification after --", 'cmux notify --title hi -- "claude done"'],
    ["a message with a variable", 'cmux agent message builder "done, see $PR"'],
    ["agent's help", "cmux agent --help"],
    ["fork's help", "cmux fork -h"],
    ["a search for sessions to recover", "cmux recover --query export"],
    ["a read behind --id-format", "cmux --id-format both tree --all"],
    [
      "a layout of shells",
      `cmux new-workspace --layout '{"pane":{"surfaces":[{"type":"terminal","command":"vim"}]}}'`,
    ],
    ["a respawned pane with a shell", "cmux respawn-pane --surface surface:3 zsh"],
    ["cmux by its path", "/Applications/cmux.app/Contents/Resources/bin/cmux tree --all"],
    ["cmux behind env", "env CMUX_QUIET=1 cmux tree --all"],
    ["a bare cmux", "cmux"],
    ["help with more words", "cmux --help tree"],
    ["cmux in capitals", "CMUX tree"],
    ["cmux capitalised", "Cmux tree --all"],
    ["cmux in capitals by its path", "/usr/local/bin/CMUX tree"],
    ["cmux in capitals opening claude", "CMUX new-workspace --command claude"],
    [
      "a program it cannot read before a cmux split (D4's form 11)",
      "$X new-split right --workspace workspace:3",
    ],
  ])("%s is refused", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-raw-spawn hook refuses a cmux")
    expect(reason).toContain("no factory session calls cmux")
  })

  test.each([
    ["cmux --help"],
    ["cmux -h"],
    ["cmux --version"],
    ["cmux version"],
    ["/Applications/cmux.app/Contents/Resources/bin/cmux --version"],
  ])("%s runs", async (command) => {
    expect(await bash(command)).toBeUndefined()
  })

  // D4's form 12: a call the hook cannot read that names cmux, in any case, beside a word that opens or restores a session is refused, and any other runs.
  const deep = "$(".repeat(200_000)
  test.each([
    ["claude"],
    ["claude-teams"],
    ["fork"],
    ["omc"],
    ["recover"],
    ["restore"],
    ["restore-session"],
    ["wake"],
  ])("a call it cannot read is refused when it names cmux and %s", async (word) => {
    expect(await bash(`cmux ${word} x && echo ${deep}`)).toContain("could not read this call")
    expect(await bash(`CMUX ${word} x && echo ${deep}`)).toContain("could not read this call")
  })

  test("a call it cannot read runs when it names cmux and no such word", async () => {
    expect(await bash(`cmux --version && echo ${deep}`)).toBeUndefined()
  })
})

const PANE = "w9:p9"
const ID = "00000000-0000-0000-0000-000000000000"

// #1123: macOS runs herdr named in any case, so a session start by herdr in another case gets the refusal of the same call in lower case; the whole forms are rows of refused-forms/1123.ts.
describe("herdr named in another case", () => {
  test.each([
    ["in capitals", "HERDR"],
    ["capitalised", "Herdr"],
    ["in capitals by its path", "/opt/homebrew/bin/HERDR"],
  ])("herdr %s gets herdr's own refusal", async (_, name) => {
    const call = `herdr agent start probe-x --kind claude --pane ${PANE}`
    const refusal = await bash(call)
    expect(refusal).toBeDefined()
    expect(await bash(call.replace(/^herdr/, name))).toBe(refusal)
  })
})

// HO3's cases (comment 6241491508), with its allow-list: herdr's socket has no access control, so only its reads run.
describe("a herdr call that is not one of herdr's reads is refused", () => {
  test.each([
    ["R1 an agent started as claude", `herdr agent start probe-x --kind claude --pane ${PANE}`],
    [
      "R2 an agent started as claude with a resume after --",
      `herdr agent start probe-x --kind claude --pane ${PANE} -- --resume ${ID}`,
    ],
    [
      "R3 a pane that runs claude",
      `herdr pane run ${PANE} 'claude -n probe-x --dangerously-skip-permissions'`,
    ],
    ["R4 a pane that resumes claude", `herdr pane run ${PANE} 'claude --resume ${ID}'`],
    ["R5 a pane that runs a launch file", `herdr pane run ${PANE} "bash '/tmp/none.sh'"`],
    [
      "R6 text typed into a pane, then Enter",
      `herdr pane send-text ${PANE} 'claude -n probe-x' && herdr pane send-keys ${PANE} enter`,
    ],
    ["R7 a new workspace", "herdr workspace create --cwd /tmp --no-focus"],
    ["R8 a split pane", `herdr pane split ${PANE} --direction right --no-focus`],
    ["R9 a prompt to another session", "herdr agent prompt builder 'run this for me'"],
    ["R10 keys sent to an agent", "herdr agent send-keys builder enter"],
    ["R11 a server stop", "herdr server stop"],
    ["R12 herdr's own Claude integration", "herdr integration install claude"],
    ["R13 a plugin linked", "herdr plugin link /tmp/none"],
    ["R14 a worktree created", "herdr worktree create --help-not-a-flag x"],
    [
      "R15 a raw pane.run written to the socket",
      `printf '%s\\n' '{"id":"1","method":"pane.run","params":{"pane_id":"${PANE}","command":"claude -n probe-x"}}' | nc -U /nonexistent/herdr.sock`,
    ],
    [
      "R16 herdr pointed at another socket",
      `env HERDR_SOCKET_PATH=/nonexistent/herdr.sock herdr pane run ${PANE} claude`,
    ],
    [
      "R17 a pane whose command opens cmux",
      `herdr pane run ${PANE} 'cmux new-workspace --command claude'`,
    ],
    ["R18 an attach to another session", "herdr --session other"],
    ["a prompt through a variable wrapper", `H=/x/h.sh; $H agent prompt ${PANE} hello`],
    [
      "F3 a pane run through a variable wrapper",
      `H=/x/h.sh; $H pane run ${PANE} 'claude -n probe-x'`,
    ],
    [
      "an agent start through a variable wrapper",
      `H=/x/h.sh; $H agent start probe-x --kind claude --pane ${PANE}`,
    ],
    ["a bare herdr, which starts a server", "herdr"],
    ["herdr by its absolute path", `/opt/homebrew/bin/herdr pane run ${PANE} claude`],
    [
      "the pinned herdr by its path in the data folder",
      `~/.playground/bin/herdr pane run ${PANE} claude`,
    ],
    ["herdr by HERDR_BIN_PATH", `"$HERDR_BIN_PATH" pane send-text ${PANE} hi`],
    ["a bare herdr by HERDR_BIN_PATH, which starts a server", `"$HERDR_BIN_PATH"`],
    ["nc on HERDR_SOCKET_PATH", `printf '{"method":"pane.run"}' | nc -U "$HERDR_SOCKET_PATH"`],
    ["socat on HERDR_SOCKET_PATH", "socat - UNIX-CONNECT:$HERDR_SOCKET_PATH"],
    ["nc on a variable assigned from HERDR_SOCKET_PATH", 'S=$HERDR_SOCKET_PATH; nc -U "$S"'],
    ["nc with options on an unreadable socket", 'nc -w 1 -U "$(cat /tmp/where)"'],
    ["socat on an unreadable socket", 'S=$HERDR_SOCKET_PATH; socat - "UNIX-CONNECT:$S"'],
    ["curl on an unreadable socket", 'curl --unix-socket "$S" http://x/'],
    ["nc -vU on an unreadable socket", 'nc -vU "$S"'],
    ["nc on a relative socket after a cd", "cd /Users/x/.playground/herdr && nc -U factory.sock"],
    [
      "socat on a relative socket after a cd",
      "cd /Users/x/.playground/herdr && socat - UNIX-CONNECT:factory.sock",
    ],
    ["nc on a relative socket under an unreadable cd", 'cd "$D" && nc -U factory.sock'],
    ["a plain assignment of HERDR_SOCKET_PATH", "HERDR_SOCKET_PATH=/x/o.sock; herdr pane list"],
    [
      "a local assignment of HERDR_SESSION",
      "f() { local HERDR_SESSION=other; herdr agent list; }; f",
    ],
    ["a server list", "herdr server list"],
    ["a server status", "herdr server status"],
    ["nc -Uv on an unreadable socket", 'nc -Uv "$S"'],
    ["socat on a lowercase unix address", "socat - unix-connect:$S"],
    ["socat on an abstract address", "socat - ABSTRACT-CONNECT:$S"],
    ["socat on a bare unreadable path", 'socat - "$S"'],
    ["ncat --unixsock on an unreadable socket", 'ncat --unixsock "$S"'],
    ["curl on an unreadable abstract socket", 'curl --abstract-unix-socket "$S" http://x/'],
    ["an export of HERDR_SOCKET_PATH", "export HERDR_SOCKET_PATH=/x/o.sock; herdr pane list"],
    ["an export of HERDR_SESSION", "export HERDR_SESSION=other && herdr agent list"],
    ["HERDR_BIN_PATH on another session", `"$HERDR_BIN_PATH" --session other`],
    ["HERDR_BIN_PATH unquoted in braces", `\${HERDR_BIN_PATH} pane close ${PANE}`],
    ["a read carrying HERDR_SESSION", "HERDR_SESSION=factory herdr pane list"],
    ["a read carrying HERDR_SOCKET_PATH", "env HERDR_SOCKET_PATH=/x/factory.sock herdr agent list"],
    ["a focus, which clears done", `herdr agent focus ${PANE}`],
    ["a pane closed", `herdr pane close ${PANE}`],
    [
      "a state report from the Bash tool",
      `herdr pane report-agent ${PANE} --source x --agent y --state idle`,
    ],
    ["a plugin installed", "herdr plugin install x"],
    ["an update", "herdr update"],
    ["herdr's agent skill installed", "npx skills add herdrdev/herdr"],
    [
      "the factory's socket written by python",
      `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX); s.connect("/Users/x/.playground/herdr/factory.sock")'`,
    ],
    ["a socket written by socat", "socat - UNIX-CONNECT:/Users/x/.config/herdr/herdr.sock"],
    ["B1 a pane run with a trailing help", `herdr pane run ${PANE} 'claude -n x' --help`],
    ["B1 a send-text with a trailing -h", `herdr pane send-text ${PANE} hello -h`],
    ["B1 a send-keys with a trailing version", `herdr pane send-keys ${PANE} enter --version`],
    ["B1 a prompt with a trailing help", "herdr agent prompt builder 'run this' --help"],
    ["B1 a version after a command", `herdr pane close ${PANE} -V`],
    [
      "B2 a wrapper given a session first",
      `H=/x/h.sh; $H --session factory pane run ${PANE} 'claude -n x'`,
    ],
    ["B2 a wrapper given a machine first", `H=/x/h.sh; $H --machine m pane send-text ${PANE} hi`],
    ["an unreadable program then agent", `"$(command -v herdr)" agent prompt builder hi`],
  ])("%s", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-raw-spawn hook refuses")
    expect(reason).toContain(join(root, "scripts", "spawn.sh"))
    expect(reason).toContain("SendMessage")
    expect(reason).not.toContain("Run it instead")
  })
})

// a tester's `$AB tab new <url>` was refused as "a herdr tab new", which named herdr for an agent-browser call.
describe("a refusal for a program it cannot read names what the program is", () => {
  test.each([
    [
      "a shell variable",
      "AB=agent-browser; $AB tab new https://example.com",
      "`tab new` whose program is a shell variable",
    ],
    [
      "a command substitution",
      '"$(command -v agent-browser)" tab new https://example.com',
      "`tab new` whose program is a command substitution",
    ],
    [
      "a file's text",
      "$(cat f) tab new https://example.com",
      "`tab new` whose program is a word it cannot read",
    ],
    [
      "a herdr pane split",
      `H=/x/h.sh; $H pane split ${PANE}`,
      "`pane split` whose program is a shell variable",
    ],
  ])("%s", async (_name, command, what) => {
    const reason = await bash(command)
    expect(reason).toContain(`refuses ${what}, which it cannot tell from herdr`)
    expect(reason).toContain(
      "type the program by its literal name, such as `agent-browser` or `herdr`",
    )
    expect(reason).not.toContain("refuses a herdr")
  })

  test("a literal herdr keeps naming herdr", async () => {
    expect(await bash("herdr tab new")).toContain(
      "refuses a herdr tab new, which is not one of its reads",
    )
  })

  test("a literal agent-browser runs", async () => {
    expect(await bash("agent-browser tab new https://example.com")).toBeUndefined()
    expect(await bash("agent-browser --session x tab new https://example.com")).toBeUndefined()
  })
})

// A scratch herdr world of the session's own: its server's socket under the session's TMPDIR, its session a word of its own.
const TMP = "/var/folders/zz/abc/T/"
const WORLD = `HERDR_SESSION=hd-probe HERDR_SOCKET_PATH=${TMP}hd-probe.Ab12/s.sock`
const inWorld = (command: string, environment: Record<string, string | undefined> = {}) =>
  check(
    JSON.stringify({
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    { HOME: "/Users/x", TMPDIR: TMP, ...environment },
  )

describe("a scratch herdr world of the session's own runs", () => {
  test.each([
    ["its headless server", `${WORLD} herdr server`],
    ["its server through env", `env ${WORLD} herdr server`],
    ["its server stopped", `${WORLD} herdr server stop`],
    ["a workspace in it", `${WORLD} herdr workspace create --cwd /tmp --no-focus`],
    ["a pane running a shell in it", `${WORLD} herdr pane run ${PANE} 'printf hi'`],
    ["text sent to its pane", `${WORLD} herdr pane send-text ${PANE} 'hello there'`],
    ["a word that holds claude inside it", `${WORLD} herdr pane send-text ${PANE} claudette`],
    [
      "a workspace in a worktree, under the .claude folder",
      `${WORLD} herdr workspace create --cwd /Users/x/dispatcher/.claude/worktrees/review-2019 --no-focus`,
    ],
    [
      "a pane that runs a test in a worktree",
      `${WORLD} herdr pane run ${PANE} 'cd /Users/x/dispatcher/.claude/worktrees/w && bun test'`,
    ],
    ["keys sent to its pane", `${WORLD} herdr pane send-keys ${PANE} enter`],
    ["a pane read", `${WORLD} herdr pane read ${PANE}`],
    ["a pane closed", `${WORLD} herdr pane close ${PANE}`],
    [
      "a state report",
      `${WORLD} herdr pane report-agent ${PANE} --source x --agent y --state idle`,
    ],
    ["its status", `${WORLD} herdr status server`],
  ])("%s", async (_name, command) => {
    expect(await inWorld(command)).toBeUndefined()
  })

  test.each([
    [
      "(a) a write carrying HERDR_SESSION alone",
      `HERDR_SESSION=hd-probe herdr pane close ${PANE}`,
      "carrying HERDR_SESSION",
    ],
    [
      "(a) a write carrying HERDR_SOCKET_PATH alone",
      `HERDR_SOCKET_PATH=${TMP}x/s.sock herdr pane close ${PANE}`,
      "carrying HERDR_SOCKET_PATH",
    ],
    [
      "(a) both exported first",
      `export ${WORLD}; herdr pane close ${PANE}`,
      "export of HERDR_SESSION or HERDR_SOCKET_PATH",
    ],
    [
      "(b) the factory's socket",
      `HERDR_SESSION=hd-probe HERDR_SOCKET_PATH=/Users/x/.playground/herdr/factory.sock herdr pane close ${PANE}`,
      "not a literal path under your TMPDIR",
    ],
    [
      "(b) herdr's default socket",
      "HERDR_SESSION=hd-probe HERDR_SOCKET_PATH=/Users/x/.config/herdr/herdr.sock herdr server",
      "not a literal path under your TMPDIR",
    ],
    [
      "(b) a socket that climbs out of TMPDIR",
      `HERDR_SESSION=hd-probe HERDR_SOCKET_PATH=${TMP}../../x.sock herdr server`,
      "not a literal path under your TMPDIR",
    ],
    [
      "(b) a socket it cannot read",
      'HERDR_SESSION=hd-probe HERDR_SOCKET_PATH="$S/s.sock" herdr server',
      "not a literal path under your TMPDIR",
    ],
    [
      "(b) a relative socket",
      "HERDR_SESSION=hd-probe HERDR_SOCKET_PATH=s.sock herdr server",
      "not a literal path under your TMPDIR",
    ],
    [
      "(c) the factory's session",
      `HERDR_SESSION=factory HERDR_SOCKET_PATH=${TMP}x/s.sock herdr server`,
      "not a word of its own",
    ],
    [
      "(c) the probes session",
      `HERDR_SESSION=probes HERDR_SOCKET_PATH=${TMP}x/s.sock herdr server`,
      "not a word of its own",
    ],
    [
      "(c) herdr's default",
      `HERDR_SESSION=default HERDR_SOCKET_PATH=${TMP}x/s.sock herdr server`,
      "not a word of its own",
    ],
    [
      "(c) a session that is not a word",
      `HERDR_SESSION=Made_Probe HERDR_SOCKET_PATH=${TMP}x/s.sock herdr server`,
      "not a word of its own",
    ],
    [
      "(c) a session it cannot read",
      `HERDR_SESSION="$N" HERDR_SOCKET_PATH=${TMP}x/s.sock herdr server`,
      "not a word of its own",
    ],
    [
      "(d) --session, which wins over the socket",
      `${WORLD} herdr --session factory pane close ${PANE}`,
      "--session, --machine or --remote",
    ],
    [
      "(d) --session after the command",
      `${WORLD} herdr pane close ${PANE} --session=factory`,
      "--session, --machine or --remote",
    ],
    [
      "(d) --machine",
      `${WORLD} herdr --machine m pane close ${PANE}`,
      "--session, --machine or --remote",
    ],
    [
      "(d) --remote",
      `${WORLD} herdr --remote host pane close ${PANE}`,
      "--session, --machine or --remote",
    ],
    ["(e) an update", `${WORLD} herdr update`, "not one of the groups"],
    [
      "(e) herdr's own Claude integration",
      `${WORLD} herdr integration install claude`,
      "not one of the groups",
    ],
    ["(e) a config reset", `${WORLD} herdr config reset-keys`, "not one of the groups"],
    [
      "(e) an attach to a named session",
      `${WORLD} herdr session attach factory`,
      "not one of the groups",
    ],
    ["(e) a bare herdr", `${WORLD} herdr`, "with no command"],
    [
      "(f) a pane that runs claude",
      `${WORLD} herdr pane run ${PANE} 'claude -n probe-x'`,
      "may start claude",
    ],
    [
      "(f) claude by its path",
      `${WORLD} herdr pane run ${PANE} '/opt/homebrew/bin/claude'`,
      "may start claude",
    ],
    [
      "(f) an agent started as claude",
      `${WORLD} herdr agent start probe-x --kind claude --pane ${PANE}`,
      "may start claude",
    ],
    [
      "(f) an agent started as claude, its kind attached",
      `${WORLD} herdr agent start probe-x --kind=claude --pane w1-1`,
      "may start claude",
    ],
    [
      "(f) claude by its npm package",
      `${WORLD} herdr pane run w1-1 'npx @anthropic-ai/claude-code'`,
      "may start claude",
    ],
    [
      "(f) claude by its package's bin name",
      `${WORLD} herdr pane run w1-1 'claude-code'`,
      "may start claude",
    ],
    [
      "(f) claude in capitals, which a case-insensitive disk finds",
      `${WORLD} herdr pane run w1-1 'CLAUDE'`,
      "may start claude",
    ],
    [
      "(f) claude under the .claude folder",
      `${WORLD} herdr pane run w1-1 '~/.claude/local/claude'`,
      "may start claude",
    ],
    [
      "a program it cannot read, which is not judged as a scratch call",
      `${WORLD} $CMD pane run w1-1 hi`,
      "carrying HERDR_SESSION",
    ],
    [
      "(f) a pane command it cannot read",
      `${WORLD} herdr pane run ${PANE} "$CMD"`,
      "may start claude",
    ],
  ])("but %s is refused", async (_name, command, why) => {
    const reason = await inWorld(command)
    expect(reason).toContain("no-raw-spawn hook refuses")
    expect(reason).toContain(why)
  })

  test("(b) with no TMPDIR, no socket is a scratch one", async () => {
    expect(await inWorld(`${WORLD} herdr server`, { TMPDIR: undefined })).toContain(
      "not a literal path under your TMPDIR (unset)",
    )
  })

  test("(c) a server PLAYGROUND_HERDR_SESSIONS names stays the factory's", async () => {
    const command = `HERDR_SESSION=night HERDR_SOCKET_PATH=${TMP}x/s.sock herdr server`
    expect(await inWorld(command, { PLAYGROUND_HERDR_SESSIONS: "factory,night" })).toContain(
      "not a word of its own",
    )
  })
})

describe("herdr's reads run", () => {
  test.each([
    [
      "F1, F2 and F4 an agent read through a variable wrapper",
      "H=/Users/owner/.playground/scratch/herdr-ho3/h.sh; $H agent get w2:p1",
    ],
    [
      "F5 an agent read by the wrapper's absolute path",
      "/Users/owner/.playground/scratch/herdr-ho3/h.sh agent get w2:p1",
    ],
    ["an agent list", "herdr agent list"],
    ["a pane read", `herdr pane read ${PANE} --source visible --lines 40`],
    ["a pane's process", `herdr pane process-info ${PANE}`],
    ["the current pane", "herdr pane current"],
    ["a layout", `herdr pane layout ${PANE}`],
    ["a wait on an agent", `herdr agent wait ${PANE} --until idle --until blocked --timeout 60000`],
    ["a wait on output", `herdr pane wait-output ${PANE} --regex 'trust' --timeout 30000`],
    ["an explain", `herdr agent explain ${PANE}`],
    ["the API's snapshot", "herdr api snapshot"],
    ["the server's status", "herdr status server --json"],
    ["the version", "herdr --version"],
    ["help", "herdr pane split --help"],
    ["help on its own", "herdr -h"],
    ["a group's help", "herdr pane --help"],
    ["help on a named session", "herdr --session factory agent start --help"],
    ["a read on a named session", "herdr --session factory pane list"],
    ["herdr by its absolute path", "/opt/homebrew/bin/herdr workspace list"],
    ["the pinned herdr by its path under HOME", '"$HOME/.playground/bin/herdr" workspace list'],
    ["herdr by HERDR_BIN_PATH", `"$HERDR_BIN_PATH" agent get ${PANE}`],
    ["a plugin's actions listed", "herdr plugin action list"],
    ["a terminal observed", "herdr terminal session observe t1"],
    ["the sessions listed", "herdr session list"],
    ["the factory's socket listed", "ls -l /Users/x/.playground/herdr/factory.sock"],
    ["a commit that names the socket", "git commit -m 'docs: herdr.sock is the default socket'"],
    ["a read of HERDR_SOCKET_PATH", 'ls -l "$HERDR_SOCKET_PATH"'],
    ["nc on a socket the hook can read", "nc -U /tmp/other.sock"],
    ["nc to a host held in a variable", 'nc -z "$HOST" 443'],
    ["socat to a TCP address", "socat - TCP:example.com:80"],
    ["nc on a relative socket outside herdr", "cd /tmp && nc -U other.sock"],
    ["the server's agent manifests", "herdr server agent-manifests"],
    ["curl to a URL held in a variable", 'curl -sS "$URL"'],
    ["an export of another variable", "export FOO=1; herdr pane list"],
  ])("%s", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

// herdr-core (hc): the factory stays on herdr, so every hc call is refused but its help and version, the old trial world's wrapper at <data folder>/hc-trial/hc included.
const HC = "/Users/x/.playground/hc-trial/hc"
const hc = (command: string, environment: Record<string, string | undefined> = {}) =>
  check(
    JSON.stringify({
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    { HOME: "/Users/x", TMPDIR: TMP, ...environment },
  )

describe("an hc call is refused", () => {
  test.each([
    ["exec", "hc exec ls"],
    ["exec on another machine", "hc exec --on vps ls"],
    ["a file read", "hc file read /etc/hosts"],
    ["a file write", "printf x | hc file write /tmp/x"],
    ["keys", "hc keys t1 enter"],
    ["a forced send", "hc send --force t1 hi"],
    ["a send", "hc send t1 hi"],
    ["the server started", "hc server start"],
    ["the server stopped", "hc server stop"],
    ["a run of claude", "hc run --bg claude"],
    ["a list", "hc ls"],
    ["a bare hc, which attaches", "hc"],
    ["herdr-core by its name", "herdr-core server status"],
    [
      "the trial's binary by its path, past the wrapper",
      "/Users/x/.playground/hc-trial/bin/herdr-core send t1 hi",
    ],
    ["hc installed under HOME", "/Users/x/.local/bin/hc exec ls"],
    ["hc in capitals", "HC keys t1 enter"],
    ["hc behind env with the world's session word", "env HC_SESSION=pgtrial hc send t1 hi"],
    [
      "the world's word assigned before a bare hc",
      "HC_SESSION=pgtrial XDG_STATE_HOME=/Users/x/.playground/hc-trial/state hc ls",
    ],
    ["a program it cannot read, then exec", "$X exec ls"],
    ["a program it cannot read, then keys", "$X keys t1 enter"],
    ["a program it cannot read, then send", "$X send --force t1 hi"],
    ["a program it cannot read, then file", "$X file read /etc/hosts"],
    ["nc on the trial world's socket", `nc -U ${TMP}pghc.Ab12/herdr-core/pgtrial.sock`],
    [
      "curl on the trial world's socket",
      `curl --unix-socket ${TMP}pghc.Ab12/herdr-core/pgtrial.sock http://x/`,
    ],
    ["a list", `${HC} ls`],
    ["a terminal's state", `${HC} get t1`],
    ["a screen read", `${HC} read t1`],
    ["a send", `${HC} send t1 'hello there'`],
    ["keys", `${HC} keys t1 enter`],
    ["a wait", `${HC} wait t1`],
    ["an interrupt", `${HC} interrupt t1`],
    ["the probe ended", `${HC} kill t1`],
    ["the server restarted", `${HC} server restart`],
    ["the server stopped by the old wrapper", `${HC} server stop`],
    ["events followed", `${HC} events`],
    ["the old wrapper by its path under HOME", '"$HOME/.playground/hc-trial/hc" get t1'],
    ["a run, which only spawn.sh starts", `${HC} run --bg claude`],
    ["a run of a shell", `${HC} run bash`],
    ["an update, which swaps the checked binary", `${HC} update`],
    ["another machine added", `${HC} machine add vps`],
    ["exec on another machine", `${HC} exec --on vps ls`],
    ["the API over stdin", `${HC} connect`],
    ["a verb held in a variable", `X=run; ${HC} $X --bg claude`],
    ["a verb from a command substitution", `${HC} $(echo run) --bg claude`],
    ["a verb from a quoted variable", `${HC} "$V" --bg claude`],
    ["a later word the hook cannot read", `${HC} exec $FLAG ls`],
    ["the wrapper run by bash", `bash ${HC} run --bg claude`],
    ["the wrapper run by sh", `sh ${HC} run --bg claude`],
    ["the wrapper run by zsh", `zsh ${HC} run --bg claude`],
    ["the wrapper run by bash with an option", `bash -e ${HC} run --bg claude`],
    ["the wrapper sourced", `source ${HC} run`],
    ["the wrapper dotted", `. ${HC} run`],
    ["a copy of herdr-core run by a shell", `bash /tmp/herdr-core send t1 hi`],
    ["the old wrapper under PLAYGROUND_DATA_DIR", "/d/hc-trial/hc ls"],
  ])("%s", async (_name, command) => {
    expect(await hc(command, { PLAYGROUND_DATA_DIR: "/d" })).toMatch(/^no-raw-spawn hook refuses /)
  })

  test("the refusal says only hc's --help and --version run", async () => {
    expect(await hc("hc exec ls")).toContain("runs only hc's --help and --version")
  })
})

describe("hc's help and version run anywhere", () => {
  test.each([
    ["help", "hc --help"],
    ["a command's help", "hc send --help"],
    ["the version", "hc -V"],
    ["the version by its long name", "herdr-core --version"],
  ])("%s", async (_name, command) => {
    expect(await hc(command)).toBeUndefined()
  })
})

describe("it fails open", () => {
  test("input that is not JSON runs", async () => {
    expect(await check("claude --resume {")).toBeUndefined()
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
    const refused = await run("cmux new-workspace --command 'claude -n x'")
    expect(refused.code).toBe(2)
    expect(refused.err).toContain("no-raw-spawn hook refuses")
    expect((await run("cmux --version")).code).toBe(0)
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
