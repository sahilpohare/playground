import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-linear-ticket"
import { OLD_NAMES } from "../../session-names"
import { storeWith } from "./render-set"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-linear-ticket.ts")
const NOT_RUN = "none of its commands ran"
const NOW = new Date("2026-10-06T12:00:00Z")
const CREATE_BODY = String.raw`{"query":"mutation { issueCreate(input: {teamId: \"t1\", title: \"Approved title\"}) { success } }"}`
const READ_BODY = String.raw`{"query":"{ viewer { id } }"}`
let scratch = ""
let config = ""
let work = ""

const approvals = () => join(config, "playground", "ticket-approvals")
const factory = (role = "worker") => ({
  CLAUDE_CONFIG_DIR: config,
  PLAYGROUND_DATA_DIR: join(config, "playground"),
  PLAYGROUND_ROLE: role,
})

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-linear-ticket-"))
  config = join(scratch, "config")
  work = join(scratch, "work")
  storeWith(join(config, "playground"), {}, { "sessions.aliases": OLD_NAMES })
  await Bun.write(
    join(approvals(), "ai-platform-2026-10-06.json"),
    JSON.stringify({ ask: "a1", titles: ["Approved title"] }),
  )
  await Bun.write(
    join(approvals(), "data-2026-10-05.json"),
    JSON.stringify({ titles: ["Yesterday's title"] }),
  )
  await Bun.write(join(approvals(), "example-team-2026-10-06.json"), "{ not json")
  await Bun.write(
    join(approvals(), "acme-2026-10-06.json"),
    JSON.stringify({ titles: "Acme title" }),
  )
  await mkdir(join(approvals(), "devops-2026-10-06.json"), { recursive: true })
  await Bun.write(join(work, "create.json"), CREATE_BODY)
  await Bun.write(join(work, "read.json"), READ_BODY)
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const bash = (command: string, environment: Record<string, string> = factory()) =>
  check(
    JSON.stringify({
      cwd: work,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    environment,
    NOW,
  )

const mcp = (
  tool_name: string,
  tool_input: unknown,
  environment: Record<string, string> = factory(),
  now = NOW,
) =>
  check(
    JSON.stringify({ cwd: work, hook_event_name: "PreToolUse", tool_input, tool_name }),
    environment,
    now,
  )

const save = "mcp__linear-shared__save_issue"

describe("a new Linear ticket through an MCP tool is refused without an approval", () => {
  test.each([
    ["save_issue with no id", save, { team: "AI Platform", title: "Unasked title" }],
    ["save_issue with an empty id", save, { id: "", team: "AI Platform", title: "Unasked" }],
    ["save_issue on another server's name", "mcp__claude_ai_Linear__save_issue", { team: "Data" }],
    ["a create_issue tool", "mcp__linear__create_issue", { team: "MADE", title: "x" }],
    [
      "a prefixed create tool",
      "mcp__linear-server__linear_create_issue",
      { teamId: "t", title: "x" },
    ],
    ["a camelCase create tool", "mcp__linear__createIssue", { team: "Data", title: "x" }],
    ["an issue_create tool", "mcp__linear__issue_create", { team: "Data", title: "x" }],
    ["a batch create", "mcp__linear__create_issues", { issues: [{ team: "Data", title: "x" }] }],
    ["a ticket for dispatcher work", save, { team: "dispatcher", title: "Track the dashboard" }],
    ["a sub-issue", save, { parentId: "ACME-1", team: "Example Team", title: "Child" }],
  ] as const)("%s", async (_, tool, input) => {
    expect(await mcp(tool, input)).toContain("no-linear-ticket hook refused")
  })

  test.each([
    ["no team", { title: "Approved title" }],
    ["no title", { team: "AI Platform" }],
    ["a team that is not text", { team: { key: "MADE" }, title: "Approved title" }],
    ["a team with no letters or digits", { team: "!!", title: "Approved title" }],
    ["no input object", null],
  ] as const)("fails closed on %s", async (_, input) => {
    expect(await mcp(save, input)).toContain("cannot read its team and title")
  })

  test("gives dispatcher the approval file and its shape", async () => {
    const reason = await mcp(save, { team: "Data", title: "New title" }, factory("dispatcher"))
    expect(reason).toContain(`write ${join(approvals(), "data-2026-10-06.json")} as`)
    expect(reason).toContain('"titles": ["New title"]')
  })

  test.each(["lead", "worker", "reviewer"])(
    "gives a %s neither the approval file nor its shape, only the ask up the chain",
    async (role) => {
      const reason = await mcp(save, { team: "Data", title: "New title" }, factory(role))
      expect(reason).toContain("the owner has not approved a ticket in this team today")
      expect(reason).toContain("Ask up the chain")
      expect(reason).not.toContain(approvals())
      expect(reason).not.toContain('"titles"')
    },
  )
})

describe("the approvals folder", () => {
  const file = () => join(approvals(), "data-2026-10-06.json")

  test.each([
    ["Write", { content: "{}", file_path: "" }],
    ["Edit", { file_path: "", new_string: "b", old_string: "a" }],
    ["MultiEdit", { edits: [], file_path: "" }],
    ["NotebookEdit", { new_source: "x", notebook_path: "" }],
  ] as const)("refuses %s into it from any role but dispatcher", async (tool, input) => {
    const key = "notebook_path" in input ? "notebook_path" : "file_path"
    const into = { ...input, [key]: file() }
    expect(await mcp(tool, into)).toContain("which the dispatcher alone writes")
    expect(await mcp(tool, into, factory("lead"))).toContain("which the dispatcher alone writes")
    expect(await mcp(tool, into, factory("dispatcher"))).toBeUndefined()
  })

  test("refuses a path that reaches it relative to the session's directory", async () => {
    const relative = join("..", "config", "playground", "ticket-approvals", "x.json")
    expect(await mcp("Write", { content: "{}", file_path: relative })).toContain(
      "the dispatcher alone",
    )
  })

  test("refuses a path through a link into it", async () => {
    const link = join(scratch, "link")
    await symlink(approvals(), link)
    expect(await mcp("Write", { content: "{}", file_path: join(link, "x.json") })).toContain(
      "the dispatcher alone",
    )
  })

  test("leaves a write anywhere else alone", async () => {
    expect(
      await mcp("Write", { content: "{}", file_path: join(work, "ticket-approvals.json") }),
    ).toBeUndefined()
  })

  test.each([
    ["a redirect", () => `echo '{"titles": ["x"]}' > ${file()}`],
    ["a heredoc", () => `cat > ${file()} <<'EOF'\n{"titles": ["x"]}\nEOF`],
    ["cp", () => `cp /dev/null ${approvals()}/`],
    [
      "tee after a cd",
      () => `cd ${join(config, "playground")} && echo x | tee ticket-approvals/x.json`,
    ],
    ["an inline script", () => `python3 -c "open('${file()}', 'w')"`],
    ["a variable holding it", () => `DIR=${approvals()} touch "$DIR"`],
  ])("refuses Bash reaching it through %s from any role but dispatcher", async (_, command) => {
    expect(await bash(command())).toContain("which the dispatcher alone writes")
    expect(await bash(command(), factory("dispatcher"))).toBeUndefined()
  })

  test("leaves a search for its name alone", async () => {
    expect(await bash("grep -rn ticket-approvals skills")).toBeUndefined()
  })
})

describe("an approval", () => {
  test("lets the create it names run", async () => {
    expect(await mcp(save, { team: "AI Platform", title: "Approved title" })).toBeUndefined()
  })

  test("matches the team by its slug and the title with its ends trimmed", async () => {
    expect(await mcp(save, { team: " ai  platform", title: " Approved title " })).toBeUndefined()
    expect(await mcp(save, { team: "AI-Platform", title: "Approved title" })).toBeUndefined()
  })

  test("covers a create tool on a Linear server too", async () => {
    expect(
      await mcp("mcp__linear__create_issue", { teamKey: "AI Platform", title: "Approved title" }),
    ).toBeUndefined()
  })

  test.each([
    ["another title", { team: "AI Platform", title: "Approved title, and more" }, "does not name"],
    [
      "the title in another case",
      { team: "AI Platform", title: "approved title" },
      "does not name",
    ],
    ["another team", { team: "Data", title: "Approved title" }, "has not approved"],
    ["a file that is not JSON", { team: "Example Team", title: "x" }, "is not JSON"],
    ["a file with no titles list", { team: "Acme", title: "Acme title" }, 'holds no "titles"'],
    ["a directory", { team: "DevOps", title: "x" }, "not a small regular file"],
  ] as const)("refuses %s", async (_, input, why) => {
    expect(await mcp(save, input)).toContain(why)
  })

  test("is stale once its UTC day has passed", async () => {
    const yesterday = new Date("2026-10-05T23:59:00Z")
    const input = { team: "Data", title: "Yesterday's title" }
    expect(await mcp(save, input, factory(), yesterday)).toBeUndefined()
    expect(await mcp(save, input, factory("dispatcher"))).toContain("data-2026-10-06.json")
  })

  test("never lets a GraphQL create through Bash run", async () => {
    const command = `curl -d '${CREATE_BODY}' https://api.linear.app/graphql`
    expect(await bash(command)).toContain("save_issue")
    expect(await bash(command, factory("dispatcher"))).toContain("a GraphQL create matches none")
  })
})

describe("MCP calls that file no new Linear ticket are allowed", () => {
  test.each([
    ["an update", save, { id: "ACME-1120", state: "In Review" }],
    ["a move to another team", save, { id: "ACME-2046", team: "Data" }],
    ["a GitHub issue", "mcp__github__create_issue", { owner: "acme-owner", repo: "x", title: "y" }],
    ["a GitHub issue_write", "mcp__github-shared__issue_write", { method: "create", title: "y" }],
    ["a label", "mcp__linear-shared__create_issue_label", { name: "x" }],
    ["a comment", "mcp__linear-shared__save_comment", { body: "x", issueId: "ACME-1" }],
    ["a read", "mcp__linear-shared__get_issue", { id: "ACME-1" }],
  ] as const)("%s", async (_, tool, input) => {
    expect(await mcp(tool, input)).toBeUndefined()
  })
})

describe("a GraphQL issueCreate through Bash is refused", () => {
  test.each([
    [
      "curl with an inline body",
      `curl -X POST https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -d '${CREATE_BODY}'`,
    ],
    [
      "curl reading the body from a file",
      "curl --data-binary @create.json https://api.linear.app/graphql",
    ],
    ["curl to a URL the hook cannot read", 'curl -d @create.json "$LINEAR_URL"'],
    [
      "curl with a heredoc body",
      `curl https://api.linear.app/graphql --json @- <<'EOF'\n${CREATE_BODY}\nEOF`,
    ],
    ["curl with a substituted body", 'curl -d "$(cat create.json)" https://api.linear.app/graphql'],
    [
      "curl with a body written earlier in the command",
      `cat > q.json <<'EOF'\n${CREATE_BODY}\nEOF\ncurl -d @q.json https://api.linear.app/graphql`,
    ],
    [
      "a batch create",
      `curl -d '{"query":"mutation { issueBatchCreate(input: {}) { success } }"}' https://api.linear.app/graphql`,
    ],
    ["curl spelled with a backslash", `cu\\rl -d '${CREATE_BODY}' https://api.linear.app/graphql`],
    ["curl run by a variable", `$CURL -d '${CREATE_BODY}' https://api.linear.app/graphql`],
    ["curl behind env", `env FOO=1 curl -d '${CREATE_BODY}' https://api.linear.app/graphql`],
    [
      "curl behind a wrapper the reader does not know",
      `vault run LINEAR_API_KEY -- curl -d '${CREATE_BODY}' https://api.linear.app/graphql`,
    ],
    ["curl inside bash -c", `bash -c "curl -d @create.json https://api.linear.app/graphql"`],
    ["curl inside eval", "eval curl -d @create.json https://api.linear.app/graphql"],
    [
      "gh api to Linear's URL",
      `gh api https://api.linear.app/graphql -f query='mutation { issueCreate(input: {}) { id } }'`,
    ],
    ["gh api to an endpoint it cannot read", 'gh api "$ENDPOINT" --input create.json'],
    [
      "python -c",
      `python3 -c 'import requests; requests.post(URL, json={"query": "mutation { issueCreate(input: {}) { success } }"})'`,
    ],
    [
      "python reading its program from a heredoc",
      `python3 - <<'EOF'\nquery = "mutation { issueCreate(input: {}) { success } }"\nEOF`,
    ],
    [
      "bun -e",
      `bun -e 'await fetch(url, { body: JSON.stringify({ query: "mutation { issueCreate(input: {}) { id } }" }) })'`,
    ],
    ["node -pe", `node -pe '"mutation { issueCreate(input: {}) { id } }"'`],
    ["deno eval", `deno eval 'fetch(url, { body: "mutation { issueCreate(input: {}) { id } }" })'`],
    ["deno eval -p", `deno eval -p '"mutation { issueCreate(input: {}) { id } }"'`],
    ["deno eval --ext=ts", `deno eval --ext=ts 'const q = "mutation { issueCreate { id } }"'`],
    ["uv run python -c", `uv run python -c 'q = "mutation { issueCreate(input: {}) { id } }"'`],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("it sends Linear's issueCreate")
  })

  test.each([
    ["a variable", 'curl -d "$BODY" https://api.linear.app/graphql'],
    ["a file that does not exist yet", "curl -d @missing.json https://api.linear.app/graphql"],
    ["stdin it cannot see", "make-body | curl -d @- https://api.linear.app/graphql"],
  ])("fails closed on a Linear API call whose body comes from %s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("cannot read what it sends")
    expect(reason).toContain("write the query to a file with the Write tool first")
    expect(reason).toContain("curl -d @/abs/query.json")
    expect(reason).toContain(NOT_RUN)
  })

  test.each([
    ["gh api", (dir: string) => `gh api "$ENDPOINT" --input ${dir}/read.json`],
    ["curl", (dir: string) => `curl -d @${dir}/read.json "https://api.linear.app/$ROUTE"`],
  ])("tells a call whose endpoint it cannot read to name it (%s)", async (_, shape) => {
    const reason = await bash(shape(work))
    expect(reason).toContain("cannot read where it goes")
    expect(reason).toContain("Name the endpoint or URL by its literal value")
    expect(reason).not.toContain("write the query to a file")
    expect(reason).toContain(NOT_RUN)
  })

  test.each([
    ["curl", (dir: string) => `curl -d @${dir}/read.json https://api.linear.app/graphql`],
    ["gh api", (dir: string) => `gh api https://api.linear.app/graphql --input ${dir}/read.json`],
  ])("passes the recipe it names, a read from a literal absolute path (%s)", async (_, shape) => {
    expect(await bash(shape(work))).toBeUndefined()
  })
})

describe("Bash commands that file no Linear ticket are allowed", () => {
  test.each([
    ["a Linear read", `curl -d '${READ_BODY}' https://api.linear.app/graphql`],
    ["a Linear read from a file", "curl -d @read.json https://api.linear.app/graphql"],
    ["a request elsewhere whose body it cannot read", 'curl -d "$BODY" http://localhost:4000/api'],
    ["a search for the mutation", "grep -rn issueCreate scripts/hooks"],
    ["rg for it", "rg issueCreate --glob '*.ts'"],
    ["a commit message naming it", 'git commit -m "refuse issueCreate"'],
    ["a GitHub comment naming it", 'gh pr comment 3 --body "the hook refuses issueCreate"'],
    [
      "a GitHub review comment through gh api naming it",
      "gh api repos/acme/archive/pulls/99/comments -f body='the hook refuses issueCreate'",
    ],
    [
      "a GitHub GraphQL mutation naming it",
      `gh api graphql -f query='mutation { addComment(input: {body: "issueCreate"}) { clientMutationId } }'`,
    ],
    ["gh api graphql reading a file naming it", "gh api graphql --input create.json"],
    [
      "gh api to a full GitHub URL naming it",
      "gh api https://api.github.com/repos/o/r/issues/1/comments -f body=issueCreate",
    ],
    [
      "gh api to a GitHub path built from a variable",
      'gh api "repos/$REPO/pulls/1/comments" -f body="$MESSAGE"',
    ],
    ["echo", "echo issueCreate"],
    ["a GitHub issue", "gh issue create --title x --body y"],
    ["a test run filtered by name", 'bun test -t "refuses issueCreate"'],
    [
      "a script file, which the hook does not read (its own source names the mutation)",
      "bun scripts/hooks/no-linear-ticket.ts",
    ],
    [
      "a grep for an interpreter's name in a file naming the mutation",
      "cat create.json | grep python",
    ],
    ["plain commands", "ls -la && git status"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("only a factory session is guarded", () => {
  test.each(["dispatcher", "lead", "worker", "reviewer", "tester", "runner", "probe"])(
    "PLAYGROUND_ROLE=%s refuses a create",
    async (role) => {
      expect(await mcp(save, { team: "Data", title: "x" }, factory(role))).toContain("refused")
      expect(
        await bash("curl -d @create.json https://api.linear.app/graphql", factory(role)),
      ).toContain("refused")
    },
  )

  test.each([
    ["absent", { CLAUDE_CONFIG_DIR: "" }],
    ["empty", { CLAUDE_CONFIG_DIR: "", PLAYGROUND_ROLE: "" }],
  ])("with PLAYGROUND_ROLE %s, the owner's own session creates freely", async (_, environment) => {
    expect(await mcp(save, { team: "Data", title: "x" }, environment)).toBeUndefined()
    expect(
      await bash("curl -d @create.json https://api.linear.app/graphql", environment),
    ).toBeUndefined()
  })
})

describe("a session cmux restored without PLAYGROUND_ROLE is placed by its registry name (#558)", () => {
  const restored = (sessionId: string) =>
    check(
      JSON.stringify({
        cwd: work,
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_input: { team: "Data", title: "x" },
        tool_name: save,
      }),
      { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground") },
      NOW,
    )

  beforeAll(async () => {
    for (const [pid, sessionId, name] of [
      ["101", "s-lead", "builder"],
      ["102", "s-worker", "worker-brave-otter"],
      ["103", "s-own", "notes"],
    ])
      await Bun.write(
        join(config, "sessions", `${pid}.json`),
        JSON.stringify({ name, pid: Number(pid), sessionId }),
      )
    await Bun.write(join(config, "sessions", "104.json"), "{ not json")
  })

  test.each(["s-lead", "s-worker"])("%s, a factory name, is refused a create", async (id) => {
    expect(await restored(id)).toContain("refused")
  })

  test.each(["s-own", "s-unknown"])("%s, no factory name, creates freely", async (id) => {
    expect(await restored(id)).toBeUndefined()
  })
})

describe("its input", () => {
  test("refuses input it cannot parse that reads as a create", async () => {
    expect(await check("{ not json: save_issue", factory(), NOW)).toContain("could not parse")
    expect(await check("{ not json: issueCreate", factory(), NOW)).toContain("could not parse")
  })

  test("allows input it cannot parse that reads as no create", async () => {
    expect(await check("{ not json: get_issue", factory(), NOW)).toBeUndefined()
  })

  test("an error inside the hook refuses a create call and lets any other call run", async () => {
    const deep = "$(".repeat(200_000)
    expect(await bash(`curl https://example.com && echo ${deep}`)).toBeUndefined()
    expect(await bash(`curl -d issueCreate https://api.linear.app && echo ${deep}`)).toContain(
      "could not read this call",
    )
  })
})

type Entry = { hooks: { command: string; timeout?: number; type: string }[]; matcher: string }

describe("as Claude Code runs it", () => {
  const settings = async () =>
    (await Bun.file(join(root, ".claude", "settings.json")).json()) as {
      hooks: { PreToolUse: Entry[] }
    }

  const entry = async () => {
    const found = (await settings()).hooks.PreToolUse.find((e) =>
      e.hooks.some((h) => h.command.includes("scripts/hooks/bundled/no-linear-ticket.js")),
    )
    if (!found) throw new Error(".claude/settings.json registers no no-linear-ticket hook")
    return found
  }

  // The skill a factory session loads outside playground's checkout, registering the hook in its frontmatter.
  const SKILLS = ["playbook"]

  const skillEntry = async (skill: string) => {
    const text = await Bun.file(
      join(root, "extensions", "core", "skills", skill, "SKILL.md"),
    ).text()
    const front = Bun.YAML.parse(text.split("---\n")[1]) as {
      hooks?: { PreToolUse?: Entry[] }
    }
    const found = front.hooks?.PreToolUse?.find((e) =>
      e.hooks.some((h) => h.command.includes("scripts/hooks/bundled/no-linear-ticket.js")),
    )
    if (!found) throw new Error(`the ${skill} skill registers no no-linear-ticket hook`)
    return found
  }

  // Bash reaches it through guards (tests/scripts/hooks/guards.test.ts).
  test("the matcher takes the file tools and every tool that can create an issue, and nothing else", async () => {
    const matcher = new RegExp((await entry()).matcher)
    for (const tool of [
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Write",
      "mcp__linear-shared__save_issue",
      "mcp__claude_ai_Linear__save_issue",
      "mcp__linear__create_issue",
      "mcp__linear__create_issues",
      "mcp__linear-server__linear_create_issue",
      "mcp__linear__createIssue",
      "mcp__linear__issue_create",
      "mcp__github__create_issue",
    ]) {
      expect(matcher.test(tool)).toBe(true)
    }
    for (const tool of [
      "Bash",
      "Read",
      "BashOutput",
      "mcp__linear-shared__get_issue",
      "mcp__linear-shared__list_issues",
      "mcp__linear-shared__save_comment",
      "mcp__linear-shared__create_issue_label",
    ]) {
      expect(matcher.test(tool)).toBe(false)
    }
  })

  // The skill keeps Bash, which the settings give guards, since a session with the skill alone runs no guards.
  test.each(SKILLS)(
    "the %s skill registers the same hook for sessions outside dispatcher, Bash included",
    async (skill) => {
      const [found, project] = [await skillEntry(skill), await entry()]
      expect(found.matcher).toBe(project.matcher.replace(/^\^\(/, "^(Bash|"))
      expect(found.hooks[0].timeout).toBe(project.hooks[0].timeout)
    },
  )

  const hook = async (
    command: string,
    payload: object,
    env: Record<string, string | undefined>,
    cwd = work,
  ) => {
    const merged = Object.entries({
      ...process.env,
      GIT_CEILING_DIRECTORIES: scratch,
      PLAYGROUND_REPO: env.CLAUDE_PROJECT_DIR,
      ...env,
    }).filter(([, v]) => v !== undefined)
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      env: Object.fromEntries(merged),
      stderr: "pipe",
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: "pipe",
    })
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
  }

  const create = { tool_input: { team: "Data", title: "x" }, tool_name: save }

  test("its command exits 2 with the reason on stderr when it refuses", async () => {
    const [{ command }] = (await entry()).hooks
    const result = await hook(command, create, {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      CLAUDE_PROJECT_DIR: root,
      PLAYGROUND_ROLE: "worker",
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("no-linear-ticket hook refused")
  })

  test("its command exits 0 and says nothing outside the factory, or when it allows", async () => {
    const [{ command }] = (await entry()).hooks
    expect(
      await hook(command, create, { CLAUDE_PROJECT_DIR: root, PLAYGROUND_ROLE: undefined }),
    ).toEqual({ code: 0, stderr: "" })
    expect(
      await hook(
        command,
        { tool_input: { id: "ACME-1", state: "Done" }, tool_name: save },
        { CLAUDE_PROJECT_DIR: root, PLAYGROUND_ROLE: "worker" },
      ),
    ).toEqual({ code: 0, stderr: "" })
  })

  test.each(SKILLS)(
    "the %s skill's command finds the script through the checkout spawn.sh exports, from any folder",
    async (skill) => {
      const [{ command }] = (await skillEntry(skill)).hooks
      const result = await hook(command, create, {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        PLAYGROUND_REPO: root,
        PLAYGROUND_ROLE: "worker",
      })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("no-linear-ticket hook refused")
      const lost = await hook(command, create, {
        PLAYGROUND_REPO: undefined,
        PLAYGROUND_ROLE: "worker",
      })
      expect(lost.code).toBe(2)
      expect(lost.stderr).toContain("Restoring the main checkout")
      expect(
        await hook(command, create, { PLAYGROUND_REPO: undefined, PLAYGROUND_ROLE: undefined }),
      ).toEqual({ code: 0, stderr: "" })
    },
  )

  test("a hook that finds no checkout refuses a factory session's call and lets any other through", async () => {
    const [{ command }] = (await entry()).hooks
    const refused = await hook(command, create, {
      CLAUDE_PROJECT_DIR: scratch,
      PLAYGROUND_ROLE: "worker",
    })
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("Restoring the main checkout")
    expect(
      await hook(command, create, { CLAUDE_PROJECT_DIR: scratch, PLAYGROUND_ROLE: undefined }),
    ).toEqual({ code: 0, stderr: "" })
  })

  test("the script runs on its own", async () => {
    const proc = Bun.spawn(["bun", script], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        PLAYGROUND_ROLE: "worker",
      },
      stderr: "pipe",
      stdin: new Blob([JSON.stringify(create)]),
    })
    expect(await proc.exited).toBe(2)
  })
})
