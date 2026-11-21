import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check as guards } from "../../../scripts/hooks/guards"
import { check } from "../../../scripts/hooks/no-prepare-write"

const ROOT = join(import.meta.dir, "..", "..", "..")
let config = ""
let env: Record<string, string> = {}

// Three sessions in Claude Code's registry, each session id its name: a prepare-only worker, a worker whose claim cleared its mode, and one the roster never marked.
beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), "no-prepare-write-"))
  for (const [k, name] of ["worker-made-up-1", "worker-made-up-2", "worker-made-up-3"].entries())
    await Bun.write(
      join(config, "sessions", `${k}.json`),
      JSON.stringify({ name, pid: k, sessionId: name }),
    )
  await Bun.write(
    join(config, "playground", "roster.json"),
    JSON.stringify({
      agents: [
        { kind: "worker", mode: "prepare", name: "worker-made-up-1", task: "t", ticket: "MADE-1" },
        { kind: "worker", name: "worker-made-up-2", task: "t", ticket: "MADE-2" },
      ],
    }),
  )
  env = { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") }
  await Bun.write(
    join(config, "query.json"),
    JSON.stringify({ query: "mutation { createRef(input: {}) { clientMutationId } }" }),
  )
  // A block string holding an escaped \""", then a listed mutation between it and the next block string; the second's block holds two backslashes before its three quotes.
  await Bun.write(
    join(config, "escaped.graphql"),
    String.raw`mutation { a: addComment(input: {body: """x \""" """}) { clientMutationId } c: createRef(input: {}) { clientMutationId } d: addComment(input: {body: """ """}) { clientMutationId } }`,
  )
  await Bun.write(
    join(config, "backslashes.graphql"),
    String.raw`mutation { a: addComment(input: {body: """a\\""" filler """}) { clientMutationId } c: createRef(input: {}) { clientMutationId } d: addComment(input: {body: """ """}) { clientMutationId } }`,
  )
  await Bun.write(
    join(config, "cr.graphql"),
    "# x\rmutation { createRef(input: {}) { clientMutationId } }",
  )
})

afterAll(async () => {
  await rm(config, { force: true, recursive: true })
})

const bash = (command: string, session = "worker-made-up-1") =>
  JSON.stringify({ cwd: config, session_id: session, tool_input: { command }, tool_name: "Bash" })
const tool = (name: string, session = "worker-made-up-1") =>
  JSON.stringify({ session_id: session, tool_input: {}, tool_name: name })

const WRITES = [
  "mcp__linear-shared__save_issue",
  "mcp__linear__save_comment",
  "mcp__slack-shared__chat_post_message",
  "mcp__github-shared__create_pull_request",
  "mcp__github-shared__create_branch",
  "mcp__github-shared__create_or_update_file",
  "mcp__github-shared__delete_file",
  "mcp__github__push_files",
  "mcp__github-shared__merge_pull_request",
  "mcp__github-shared__update_pull_request_branch",
]
const API_WRITES = [
  "gh api repos/made-up/app/pulls -X POST -f title=t -f head=made-up -f base=main",
  "gh api repos/made-up/app/pulls --method POST -F title=t -f head=made-up -f base=main",
  "gh api /repos/made-up/app/pulls -f title=t -f head=made-up -f base=main",
  "gh api https://api.github.com/repos/made-up/app/pulls -X post -f head=made-up",
  "gh api repos/made-up/app/git/refs -X POST -f ref=refs/heads/made-up -f sha=abc123",
  "gh api repos/made-up/app/git/refs/heads/made-up -X PATCH -f sha=abc123",
  "gh api repos/made-up/app/git/refs/heads/made-up --method=PATCH -F force=true -f sha=abc123",
  ...[
    "createPullRequest",
    "createRef",
    "updateRef",
    "updateRefs",
    "deleteRef",
    "createCommitOnBranch",
    "mergeBranch",
    "mergePullRequest",
    "updatePullRequestBranch",
  ].map((m) => `gh api graphql -f query='mutation { ${m}(input: {}) { clientMutationId } }'`),
  'gh api "$ENDPOINT" -X POST -f title=t',
  "gh api /graphql -f query='mutation { createRef(input: {}) { clientMutationId } }'",
  "gh api https://api.github.com/graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
  "gh api https://git.example.com/api/graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  "gh api repos/made-up/app/contents/README.md -X PUT -f message=m -f content=eA==",
  "gh api repos/made-up/app/contents/docs/a.md --method DELETE -f message=m -f sha=abc123",
  "gh api repos/made-up/app/merges -X POST -f base=main -f head=made-up",
  "gh api repos/made-up/app/pulls/7/merge -X PUT",
  "gh api repos/made-up/app/pulls/7/update-branch -X PUT",
  "G=gh; $G api repos/made-up/app/pulls -X POST -f head=made-up",
]
const PR_CREATES = [
  "gh pr create --draft --title made-up --body-file /made-up/body.md",
  "cd /made-up && gh -R made-up/app pr create --fill",
  "env GH_TOKEN=x gh pr create --fill",
  "git commit -m made-up && gh pr create --fill",
  "G=gh; $G pr create --fill",
]
const PUSHES = [
  "git push -u origin made-up",
  "git push -u origin made-up && gh pr create --fill",
  "git -C /made-up push origin HEAD:made-up",
  "env GIT_TRACE=0 git push",
  "uv run git push",
  "G=git; $G push -u origin made-up",
]

describe("no-prepare-write refuses a prepare-only session's writes", () => {
  test.each(WRITES)("refuses %s", async (name) => {
    expect(await check(tool(name), env)).toStartWith("no-prepare-write hook refused the tool ")
  })

  test.each(PR_CREATES)("refuses %s", async (command) => {
    expect(await check(bash(command), env)).toStartWith(
      "no-prepare-write hook refused gh pr create",
    )
  })

  test.each(PUSHES)("refuses %s", async (command) => {
    expect(await check(bash(command), env)).toStartWith("no-prepare-write hook refused git push")
  })

  test.each(API_WRITES)("refuses %s", async (command) => {
    expect(await check(bash(command), env)).toStartWith("no-prepare-write hook refused gh api")
  })

  test.each([
    `gh api graphql -f query='mutation { addComment(input: {body: "x"}) { clientMutationId } createRef(input: {}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { addComment(input: {body: "a \\" b"}) { clientMutationId } createRef(input: {}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { addComment(input: {body: "unclosed createRef(input: {}) { clientMutationId } }'`,
  ])("refuses a listed mutation beside a string, %s", async (command) => {
    expect(await check(bash(command), env)).toStartWith("no-prepare-write hook refused gh api")
  })

  test.each([
    "gh api graphql --input query.json",
    "gh api graphql --input - < query.json",
    `gh api graphql --input - <<'EOF'\n{"query":"mutation { mergePullRequest(input: {}) { clientMutationId } }"}\nEOF`,
  ])("refuses a listed mutation in a JSON body, %s", async (command) => {
    expect(await check(bash(command), env)).toStartWith("no-prepare-write hook refused gh api")
  })

  test.each([
    "gh api graphql -f query=$'# x\\rmutation { createRef(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='# x\rmutation { createRef(input: {}) { clientMutationId } }'",
    "gh api graphql -F query=@cr.graphql",
  ])("refuses a listed mutation after a comment a carriage return ends, %s", async (command) => {
    expect(await check(bash(command), env)).toStartWith("no-prepare-write hook refused gh api")
  })

  test.each([
    "gh api graphql -F query=@escaped.graphql",
    "gh api graphql -F query=@backslashes.graphql",
  ])(
    "refuses a listed mutation after a block string holding an escaped quote, %s",
    async (command) => {
      expect(await check(bash(command), env)).toStartWith("no-prepare-write hook refused gh api")
    },
  )

  test("its refusal names a file write and a merge", async () => {
    expect(await check(tool("mcp__github-shared__merge_pull_request"), env)).toContain(
      "no push, no file write, no pull request and no merge",
    )
  })

  test.each([
    "mcp__linear-shared__get_issue",
    "mcp__linear-shared__list_comments",
    "mcp__slack-shared__conversations_history",
    "mcp__github-shared__pull_request_read",
    "mcp__github-shared__get_file_contents",
    "mcp__github-shared__list_branches",
  ])("lets it read with %s", async (name) => {
    expect(await check(tool(name), env)).toBeUndefined()
  })

  test.each([
    "gh pr view 1 --json state",
    "gh pr list",
    "git commit -m made-up",
    "git fetch origin",
    "git log --oneline -1",
    "echo gh pr create",
    "echo git push",
    "gh api repos/made-up/app/pulls",
    "gh api repos/made-up/app/pulls -X GET -f state=open",
    "gh api repos/made-up/app/git/refs/heads/made-up",
    "gh api repos/made-up/app/issues/1/comments -X POST -f body=x",
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api /graphql -f query='query { viewer { login } }'",
    "gh api repos/made-up/app/contents/README.md",
    "gh api repos/made-up/app/pulls/7/merge",
    "gh api repos/made-up/app/git/commits -X POST -f message=m -f tree=abc123",
    "gh api repos/made-up/app/git/trees -X POST -f base_tree=abc123",
    "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'",
    "man git push",
    "G=git; $G fetch origin",
    "G=ls; $G -la",
  ])("lets it run %s", async (command) => {
    expect(await check(bash(command), env)).toBeUndefined()
  })
})

describe("no-prepare-write lets the same writes run for a session not marked prepare-only", () => {
  test.each(["worker-made-up-2", "worker-made-up-3", "not-in-the-registry"])(
    "%s, whose roster row reads no mode or which the roster or the registry does not hold",
    async (session) => {
      for (const name of WRITES) expect(await check(tool(name, session), env)).toBeUndefined()
      for (const command of [...PR_CREATES, ...PUSHES, ...API_WRITES])
        expect(await check(bash(command, session), env)).toBeUndefined()
    },
  )

  test("the claim's assign runs the moment roster.ts clears the mode", async () => {
    const data = join(config, "claim")
    await Bun.write(
      join(data, "roster.json"),
      JSON.stringify({
        agents: [{ kind: "worker", mode: "prepare", name: "worker-made-up-1", task: "t" }],
      }),
    )
    const claim = { ...env, PLAYGROUND_DATA_DIR: data }
    const assign = tool("mcp__linear-shared__save_issue")
    const push = bash("git push -u origin made-up")
    const ref = bash(
      "gh api repos/made-up/app/git/refs -X POST -f ref=refs/heads/made-up -f sha=abc123",
    )
    const branch = tool("mcp__github-shared__create_branch")
    const merge = bash("gh api repos/made-up/app/pulls/7/merge -X PUT")
    const mergeTool = tool("mcp__github-shared__merge_pull_request")
    expect(await check(assign, claim)).toStartWith("no-prepare-write hook refused")
    expect(await check(ref, claim)).toStartWith("no-prepare-write hook refused gh api")
    expect(await check(branch, claim)).toStartWith("no-prepare-write hook refused the tool")
    expect(await check(merge, claim)).toStartWith("no-prepare-write hook refused gh api")
    expect(await check(mergeTool, claim)).toStartWith("no-prepare-write hook refused the tool")
    expect(await check(push, claim)).toStartWith("no-prepare-write hook refused git push")
    const cleared = Bun.spawnSync(
      [process.execPath, join(ROOT, "scripts", "roster.ts"), "set", "worker-made-up-1", "mode="],
      { env: { ...process.env, ...claim } },
    )
    expect(cleared.exitCode).toBe(0)
    expect(await check(assign, claim)).toBeUndefined()
    expect(await check(push, claim)).toBeUndefined()
    expect(await check(ref, claim)).toBeUndefined()
    expect(await check(branch, claim)).toBeUndefined()
    expect(await check(merge, claim)).toBeUndefined()
    expect(await check(mergeTool, claim)).toBeUndefined()
  })
})

describe("no-prepare-write runs where its calls arrive", () => {
  test("guards.ts runs it on a Bash call", async () => {
    const reason = await guards(bash("gh pr create --fill"), { ...env, PLAYGROUND_ROLE: "worker" })
    expect(reason).toContain("no-prepare-write hook refused gh pr create")
  })

  test("no-playground-leak's own process runs it on a tracker, chat or GitHub tool", async () => {
    const hook = Bun.spawnSync(
      [process.execPath, "--no-env-file", join(ROOT, "scripts", "hooks", "no-playground-leak.ts")],
      {
        env: { ...process.env, ...env, PLAYGROUND_ROLE: "worker" },
        stdin: Buffer.from(tool("mcp__slack-shared__chat_post_message")),
      },
    )
    expect(hook.exitCode).toBe(2)
    expect(hook.stderr.toString()).toStartWith("no-prepare-write hook refused the tool ")
  })
})

describe("no-prepare-write fails open, and logs each read that fails", () => {
  test("input it cannot read runs", async () => {
    expect(await check("not json", env)).toBeUndefined()
  })

  test("a roster it cannot read lets the write run, with a line in its log", async () => {
    const data = join(config, "broken")
    await Bun.write(join(data, "roster.json"), "not json")
    const broken = { ...env, PLAYGROUND_DATA_DIR: data }
    expect(await check(tool("mcp__linear-shared__save_issue"), broken)).toBeUndefined()
    const log = (await readFile(join(data, "ops", "no-prepare-write.log"), "utf8")).trim()
    expect(JSON.parse(log)).toMatchObject({
      session: "worker-made-up-1",
      tool: "mcp__linear-shared__save_issue",
    })
  })
})
