import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-stash"
import { overBaseline, stepsOf } from "./pace"

// The worktree path every refusal gives: absolute, beside the main checkout's .git, so none nests in another worktree (AGENTS.md's Workflow rule).
const ABS_WORKTREE =
  '"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>"'

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-stash.ts")
const SHA = "86efa61deb2f0d83e16c8feaee69a5cd12eaf99a"

const bash = (command: string) =>
  check(
    JSON.stringify({
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    {},
  )

describe("a git stash that can take another worktree's work is refused", () => {
  test.each([
    ["a bare stash", "git stash"],
    ["a stash inside an array assignment", "arr=($(git stash))"],
    ["push without a message", "git stash push"],
    ["push with options but no message", "git stash push -u --keep-index"],
    ["an implied push without a message", "git stash -u"],
    ["save, even with a positional message", "git stash save wip"],
    ["push with an empty message", 'git stash push -m ""'],
    ["pop", "git stash pop"],
    ["pop by index", "git stash pop stash@{0}"],
    ["apply with no target", "git stash apply"],
    ["apply by index", "git stash apply stash@{1}"],
    ["apply by a short SHA", "git stash apply 86efa61"],
    ["drop", "git stash drop"],
    ["drop by index", "git stash drop stash@{0}"],
    ["clear", "git stash clear"],
    ["branch, which pops", "git stash branch fix"],
    ["an action it does not know", "git stash frobnicate"],
    ["git -C <dir>", "git -C /tmp/other stash pop"],
    ["git with -c and --no-pager first", "git -c core.pager=cat --no-pager stash drop"],
    ["a quoted subcommand", "git 'stash' pop"],
    ["an alias defined with -c", "git -c alias.s=stash s pop"],
    ["git --attr-source <tree> first, a separate value", "git --attr-source HEAD stash push"],
    ["git --attr-source=<tree> first, an attached value", "git --attr-source=HEAD stash pop"],
    ["an alias with --attr-source before its use", "git -c alias.s=stash --attr-source HEAD s pop"],
    ["after &&", "git add -A && git stash && git checkout canary"],
    ["after ;", "echo hi; git stash pop"],
    ["in a pipeline", "git stash pop | cat"],
    ["in a subshell", "(git stash pop)"],
    ["in a substitution", 'echo "$(git stash pop)"'],
    ["through bash -c", "bash -c 'git stash pop'"],
    ["through a heredoc into bash", "bash <<'EOF'\ngit stash pop\nEOF"],
    ["through env", "env GIT_PAGER=cat git stash clear"],
    ["under xargs", "echo pop | xargs git stash"],
    ["an action it cannot read", "git stash $ACTION"],
    ["a subcommand it cannot read", "git $(echo stash) pop"],
    ["git named by a variable it cannot read", "$GIT stash pop"],
    ["git named by a variable set before it", "G=git; $G stash pop"],
    ["git named by a substitution", '"$(which git)" stash pop'],
    ["git behind a wrapper it does not know", "uv run git stash pop"],
    ["git behind vault", "vault run -- git stash drop"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("no-stash hook refuses")
  })

  test("the refusal says what to do instead", async () => {
    const reason = (await bash("git stash pop")) ?? ""
    expect(reason).toContain("WIP commit")
    expect(reason).toContain("git commit -m 'chore: wip <what>'")
    expect(reason).toContain(`git worktree add --detach ${ABS_WORKTREE} origin/canary`)
    expect(reason).toContain("git stash apply <full sha>")
  })
})

describe("a long run of closing braces", () => {
  // a scan back for each brace's open grows with the square of their count, where the stack of opens grows with the count
  test("ahead of a stash is read in a time linear in its length", async () => {
    const command = `${"ls; }\n".repeat(60_000)}git stash`
    expect(await bash(command)).toBeDefined()
    expect(await overBaseline(bash, command, "; git stash")).toBeLessThan(100)
  }, 60_000)
})

describe("a stash found by name or SHA, and every other call, runs", () => {
  test.each([
    ["list", "git stash list"],
    ["list with a format", "git stash list --format='%h %gd %s'"],
    ["show", "git stash show --name-only stash@{0}"],
    ["push -m", 'git stash push -m "wip: labels before shots"'],
    ["push --message=", "git stash push --message=wip"],
    ["push -m attached", "git stash push -mwip"],
    ["an implied push with -m", "git stash -u -m wip"],
    ["push -m with paths", "git stash push -m wip -- web/next/src"],
    ["apply by full SHA", `git stash apply ${SHA}`],
    ["apply --index by full SHA", `git stash apply --index ${SHA}`],
    ["git -C with apply by full SHA", `git -C /tmp/other stash apply ${SHA}`],
    ["git --attr-source <tree> with push -m", "git --attr-source HEAD stash push -m wip"],
    ["store, which restores an entry", `git stash store -m restored ${SHA}`],
    ["create", "git stash create"],
    ["help", "git stash --help"],
    ["a plain commit, whose lint-staged writes no stash", 'git commit -m "feat: x"'],
    ["a commit that mentions stash in its message", 'git commit -m "fix: the stash hook"'],
    ["another git command", "git status --short"],
    ["a word that is not stash", "git stashed"],
    ["no git at all", "ls stash"],
    ["grep for the word", "grep -rn 'git stash' scripts"],
    ["a printer that names it", "echo git stash pop"],
    ["a name it cannot read with no stash after it", "$EDITOR notes.md"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("40 wrapper options it does not know before a stash are read in a bounded count of steps, and the stash refused", async () => {
    const [reason, steps] = await stepsOf(() => bash(`sudo ${"-Z ".repeat(40)}true; git stash`))
    expect(reason).toContain("no-stash hook")
    expect(steps).toBeLessThan(5_000)
  })

  test("a tool other than Bash passes", async () => {
    expect(
      await check(JSON.stringify({ tool_input: { file_path: "/x" }, tool_name: "Read" }), {}),
    ).toBeUndefined()
  })
})

describe("an agent-browser teardown of every session is refused", () => {
  test.each([
    ["close --all", "agent-browser close --all"],
    ["quit --all", "agent-browser quit --all"],
    ["exit --all", "agent-browser exit --all"],
    ["--all before close", "agent-browser --all close"],
    ["with a session named too", "agent-browser --session lm117 close --all"],
    ["through npx", "npx agent-browser close --all"],
    ["through bunx -y", "bunx agent-browser close --all"],
    ["inside a batch", 'agent-browser batch "open https://x" "close --all"'],
    ["after &&", "agent-browser --session a close && agent-browser close --all"],
    ["in a heredoc into bash", "bash <<'EOF'\nagent-browser close --all\nEOF"],
    ["by an unreadable name", "$AB close --all"],
    ["with an action it cannot read", "agent-browser $ACTION --all"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("closes every session's browser")
  })

  test("the refusal says to close only the browser you opened", async () => {
    expect(await bash("agent-browser close --all")).toContain(
      "agent-browser --session <name> close",
    )
  })
})

describe("a bare agent-browser close, which closes the shared default session, is refused", () => {
  test.each([
    ["close", "agent-browser close"],
    ["quit", "agent-browser quit"],
    ["exit", "agent-browser exit"],
    ["through npx", "npx agent-browser close"],
    ["inside a batch", 'agent-browser batch "open https://x" "close"'],
    ["after &&", "agent-browser open https://x && agent-browser close"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("closes the shared default session")
  })

  test("the refusal says to pass --session <name>", async () => {
    expect(await bash("agent-browser close")).toContain(
      "Close only the browser you opened; pass --session <name>",
    )
  })

  test("a session named in the session's own environment counts", async () => {
    const command = "agent-browser close"
    const raw = JSON.stringify({ cwd: root, tool_input: { command }, tool_name: "Bash" })
    expect(await check(raw, { AGENT_BROWSER_SESSION: "lm117" })).toBeUndefined()
  })

  test("an unread program beside a close is not judged as agent-browser", async () => {
    expect(await bash("$EDITOR close")).toBeUndefined()
  })
})

describe("closing your own browser, and every other agent-browser call, runs", () => {
  test.each([
    ["close by session", "agent-browser --session lm117 close"],
    ["close with its session after", "agent-browser close --session lm117"],
    ["close with --session=", "agent-browser --session=lm117 close"],
    ["close with its session in an assignment", "AGENT_BROWSER_SESSION=lm117 agent-browser close"],
    [
      "close after exporting its session",
      "export AGENT_BROWSER_SESSION=lm117; agent-browser close",
    ],
    ["a tab close, which keeps the browser", "agent-browser tab close"],
    ["a batch whose session is named", 'agent-browser --session a batch "open https://x" "close"'],
    ["a session list", "agent-browser session list"],
    ["open", "agent-browser --session lm117 open https://example.com"],
    ["a select-all key press", "agent-browser --session a press Control+a"],
    ["help that names --all", "agent-browser close --help"],
    ["echo of the command", 'echo "agent-browser close --all"'],
    ["grep for it", "grep -rn 'close --all' scripts"],
    ["typed text that says it", 'agent-browser --session a fill "#q" "please close --all of it"'],
    ["an unread program with --all and another variable", '"$BIN" list --all "$FILTER"'],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("it fails closed only on a call that reads as a stash", () => {
  test("input it cannot parse that names git stash is refused", async () => {
    expect(await check("not json git stash pop", {})).toContain("could not parse")
  })

  test("input it cannot parse that names no stash passes", async () => {
    expect(await check("not json at all", {})).toBeUndefined()
  })
})

describe("the factory settings run it through guards", () => {
  type Entry = { hooks: { command: string; timeout?: number; type: string }[]; matcher: string }

  const entry = async (): Promise<Entry> => {
    const settings = (await Bun.file(join(root, "scripts", "factory-settings.json")).json()) as {
      hooks: { PreToolUse: Entry[] }
    }
    const found = settings.hooks.PreToolUse.find((e) =>
      e.hooks.some((h) => h.command.includes("scripts/hooks/bundled/guards.js")),
    )
    if (!found) throw new Error("scripts/factory-settings.json registers no guards hook")
    return found
  }

  test("its matcher takes Bash alone", async () => {
    const matcher = new RegExp((await entry()).matcher)
    expect(matcher.test("Bash")).toBe(true)
    for (const tool of ["Read", "Write", "BashOutput", "mcp__github-shared__create_pull_request"])
      expect(matcher.test(tool)).toBe(false)
  })

  // CLAUDE_PROJECT_DIR is a folder in no repository, so only PLAYGROUND_REPO can name the checkout
  const hook = async (home: string, command: string, repo: string, role = "worker") => {
    const proc = Bun.spawn(["bash", "-c", (await entry()).hooks[0].command], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: home,
        GIT_CEILING_DIRECTORIES: tmpdir(),
        HOME: home,
        PLAYGROUND_REPO: repo,
        PLAYGROUND_ROLE: role,
      },
      stderr: "pipe",
      stdin: new Blob([JSON.stringify({ tool_input: { command }, tool_name: "Bash" })]),
      stdout: "pipe",
    })
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
  }

  test("its command runs the script from the checkout PLAYGROUND_REPO names, with no skills in HOME, exits 2 to refuse and 0 to allow", async () => {
    const home = await mkdtemp(join(tmpdir(), "no-stash-home-"))
    const refused = await hook(home, "git stash pop", root)
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("no-stash hook refuses git stash pop")
    expect(await hook(home, "git stash list", root)).toEqual({ code: 0, stderr: "" })
  })

  test("a hook that finds no checkout refuses a factory session's call and lets any other through", async () => {
    const home = await mkdtemp(join(tmpdir(), "no-stash-nohome-"))
    const refused = await hook(home, "git stash pop", "")
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("Restoring the main checkout")
    expect(await hook(home, "git stash pop", "", "")).toEqual({ code: 0, stderr: "" })
  })

  test("the script runs on its own", async () => {
    const proc = Bun.spawn(["bun", script], {
      env: { ...process.env, PLAYGROUND_ROLE: "worker" },
      stderr: "pipe",
      stdin: new Blob([
        JSON.stringify({ tool_input: { command: "git stash" }, tool_name: "Bash" }),
      ]),
    })
    expect(await proc.exited).toBe(2)
  })
})
