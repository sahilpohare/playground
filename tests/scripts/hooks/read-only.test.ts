import { describe, expect, test } from "bun:test"

import { readOnly } from "../../../scripts/hooks/read-only"

const bash = (command: string) =>
  JSON.stringify({ cwd: "/", tool_input: { command }, tool_name: "Bash" })
const mcp = (tool: string) => JSON.stringify({ cwd: "/", tool_input: {}, tool_name: tool })

describe("a call that only reads", () => {
  test.each([
    "git log --oneline -5",
    "git -C /tmp status --short",
    "git remote -v",
    "git branch --show-current",
    "git log --format=%B -n 1 | head -3",
    "gh issue list -R acme/app",
    "gh pr view 1 -R acme/app --json state",
    "gh pr view 1 --repo=acme/app --json=state",
    "git log --format=%H -n 1",
    "gh api repos/acme/app/issues",
    "gh api -X GET repos/acme/app/pulls --paginate",
    "cat .git/worktrees/a/HEAD",
    "grep gitdir .git",
    "cd /tmp && git diff HEAD~1 | wc -l",
    "( git log -1 ) | head -3",
  ])("%s reads", (command) => {
    expect(readOnly(bash(command))).toBe(true)
  })
})

describe("a call outside the read shapes", () => {
  test.each([
    "gh issue create -R acme/app -t x -b y",
    "gh api -X DELETE repos/acme/app",
    "gh api repos/acme/app/issues -f title=y",
    "gh api -iXDELETE repos/acme/app/git/refs/heads/x",
    "gh api --hostname example.com x",
    "gh api https://example.com/x",
    "gh issue --title list create -R acme/app -b y",
    "gh search issues foo",
    "git push origin main",
    "git fetch origin canary",
    "git branch -D x",
    "git branch x",
    "git config --get remote.origin.url",
    "git -c core.pager=less log",
    "git remote -v add x https://github.com/acme/app.git",
    "git log --output=/tmp/x",
    "git diff --outp=/tmp/x",
    "git constructor",
    "GIT_PAGER=less git log",
    "LESSOPEN='|gh issue create %s' git log",
    "x=1",
    "git log > /tmp/x",
    "git log -1 2>&1 | head -3",
    "{ git log; } >> /tmp/x",
    "echo $(git rev-parse HEAD)",
    "./tools/git log",
    "env git log",
    "echo 'git push' | sh",
    "git log; git push",
    "curl https://example.com",
    "sort -o/tmp/x .git/HEAD",
    "git log -1 --pretty --output=.git/config",
    "git log --format --output=.git/config",
    "git -C . log --pretty --output=.git/config",
    "git diff *",
    "git diff {--output=x,HEAD}",
    "gh issue list -R evil.example/o/r --search x",
    "gh issue list --repo=evil.example/o/r",
    "gh issue view https://evil.example/o/r/issues/1",
    "gh pr diff https://evil.example/o/r/pull/1",
    'git diff ""{--output=.git/hooks/pre-commit,HEAD}',
    'git diff ""*',
    "git diff ''*",
    "cat =(gh issue create -t a -b b)",
    'cat .git/HEAD(e:"gh issue create":)',
    "git log -1 --format=%H $=PWD",
    "git log $~HOME",
    "git log $^HOME",
    "git log $+HOME",
    "nice (git push origin main)",
    "command (git log; git push)",
  ])("%s does not read only", (command) => {
    expect(readOnly(bash(command))).toBe(false)
  })

  test("any MCP call, a read included, and a call that does not parse", () => {
    expect(readOnly(mcp("mcp__github-shared__add_issue_comment"))).toBe(false)
    expect(readOnly(mcp("mcp__github-shared__list_issues"))).toBe(false)
    expect(readOnly("not json")).toBe(false)
  })
})
