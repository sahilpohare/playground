import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { reposOf } from "../../../packages/scripts/src/trace-count/kinds"
import { currentDir } from "../../../packages/settings/src/rendered"
import { storeMarker } from "../../../scripts/hooks/lists"
import { check } from "../../../scripts/hooks/no-public-leak"
import { originCheckout } from "../../machine"
import { storeWith } from "./render-set"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-public-leak.ts")
// Made-up values, one per list key.
const TERMS = {
  companies: ["Vantorix"],
  handles: ["quillco", "qmarsh"],
  linearKeys: ["MADEVX"],
  names: ["Quilla Marsh"],
  slackIds: ["C0MADE0401"],
}
let scratch = ""
let stored = ""
let stranger = ""
// the checkout the guard reads its origin from, a scratch one with a made-up GitHub origin
let checkout = ""
const ORIGIN = "acme/made-up-origin"

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-public-leak-"))
  stored = join(scratch, "stored")
  stranger = join(scratch, "stranger")
  await mkdir(stranger, { recursive: true })
  checkout = originCheckout(join(scratch, "checkout"), ORIGIN)
  storeWith(
    stored,
    { "no-public-leak.json": JSON.stringify(TERMS) },
    { "factory.archiveRepo": "acme/archive", "factory.publicRepo": "quillco/playground" },
  )
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const env = (data: string) => ({ CLAUDE_CONFIG_DIR: scratch, PLAYGROUND_DATA_DIR: data })
const bash = (command: string) =>
  JSON.stringify({
    cwd: scratch,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: "Bash",
  })
const run = (raw: string, data = stored) => check(raw, env(data), checkout)

const R = "--repo quillco/playground"
// The checkout's origin, the one repository the guard keeps while factory.publicRepo is unset.
const UNSET_R = `--repo ${ORIGIN}`

// A made-up owner, Quilla (@qmarsh), whose names owner.names lists, and an outside contributor, Ostra Vell (@ovell).
const OWNER_TERMS = {
  ...TERMS,
  companies: ["Acme"],
  handles: ["ovell", "qmarsh"],
  names: ["Ostra Vell", "Quilla"],
}
const CONTRIBUTORS = "### ❤️ Contributors\n\n"

describe("a ship's notes may name the owner on the owner's own Contributors line alone", () => {
  let owned = ""
  beforeAll(async () => {
    owned = join(scratch, "owned")
    storeWith(
      owned,
      { "no-public-leak.json": JSON.stringify(OWNER_TERMS) },
      {
        "factory.archiveRepo": "acme/archive",
        "factory.publicRepo": "quillco/playground",
        "owner.names": ["qmarsh", "quilla"],
      },
    )
  })
  const notes = async (text: string) => {
    const file = join(scratch, `notes-${Bun.hash(text)}.md`)
    await Bun.write(file, text)
    return file
  }
  const OWN = `## v2\n\n${CONTRIBUTORS}- Quilla @qmarsh\n- @someone\n`

  test("the owner's line holding the login alone passes", async () => {
    const file = await notes(`${CONTRIBUTORS}- @qmarsh\n- @someone\n`)
    expect(await run(bash(`gh release create v2 ${R} --notes-file ${file}`), owned)).toBeUndefined()
  })

  test("the owner's line written with CRLF line ends passes", async () => {
    const file = await notes(OWN.replaceAll("\n", "\r\n"))
    expect(await run(bash(`gh release create v2 ${R} --notes-file ${file}`), owned)).toBeUndefined()
  })

  test.each(["create v2", "edit v2"])("gh release %s passes the owner's line", async (verb) => {
    expect(
      await run(bash(`gh release ${verb} ${R} --notes-file ${await notes(OWN)}`), owned),
    ).toBeUndefined()
  })

  test.each([
    [
      "the owner's name on another line of the notes",
      `### 🩹 Fixes\n\n- Quilla's fix\n\n${CONTRIBUTORS}- Quilla @qmarsh\n`,
    ],
    [
      "an outside contributor's name on a Contributors line",
      `${CONTRIBUTORS}- Ostra Vell @ovell\n`,
    ],
    ["an outside handle alone on a Contributors line", `${CONTRIBUTORS}- @ovell\n`],
    ["the archive's owner as a name on the owner's line", `${CONTRIBUTORS}- Acme @qmarsh\n`],
    ["the archive's owner as name and login", `${CONTRIBUTORS}- Acme @acme\n`],
    ["a heading that ends in Contributors", "### 🩹 Fixes for Contributors\n\n- Quilla @qmarsh\n"],
    [
      "an indented heading after the section",
      `${CONTRIBUTORS}- @x\n   ### 🩹 Fixes\n\n- Quilla @qmarsh\n`,
    ],
    [
      "an HTML heading after the section",
      `${CONTRIBUTORS}- @x\n<h3>Fixes</h3>\n\n- Quilla @qmarsh\n`,
    ],
    ["a fence after the section", `${CONTRIBUTORS}- @x\n\`\`\`\n- Quilla @qmarsh\n`],
    ["an outside name on the owner's login", `${CONTRIBUTORS}- Ostra Vell @qmarsh\n`],
    ["the owner's line outside the Contributors section", `### 🩹 Fixes\n\n- Quilla @qmarsh\n`],
  ])("a ship's notes holding %s are refused", async (_, text) => {
    expect(
      await run(bash(`gh release create v2 ${R} --notes-file ${await notes(text)}`), owned),
    ).toContain("no-public-leak hook refused")
  })

  test.each([
    [
      "a ship's title",
      (f: string) => `gh release create v2 ${R} --title "Quilla's ship" --notes-file ${f}`,
    ],
    [
      "an edited ship's title",
      (f: string) => `gh release edit v2 ${R} --title "Quilla @qmarsh" --notes-file ${f}`,
    ],
    ["an issue's body", (f: string) => `gh issue create ${R} -t x --body-file ${f}`],
    ["a pull request's body", (f: string) => `gh pr create ${R} -t x --body-file ${f}`],
    ["a comment", (f: string) => `gh pr comment 1 ${R} --body-file ${f}`],
    [
      "a ship's create joined to a comment",
      (f: string) =>
        `gh release create v2 ${R} --notes-file ${f} && gh pr comment 1 ${R} --body-file ${f}`,
    ],
  ])("the owner's line in %s is refused", async (_, command) => {
    expect(await run(bash(command(await notes(OWN))), owned)).toContain(
      "no-public-leak hook refused",
    )
  })
})

describe("a write to the public repository holding private text is refused", () => {
  test.each([
    ["gh pr create", `gh pr create ${R} --title "Fix export" --body "Asked by Quilla Marsh"`],
    ["gh pr edit", `gh pr edit 1 ${R} --title "Quilla Marsh's fix"`],
    ["gh pr comment", `gh pr comment 1 ${R} --body "Quilla Marsh asked"`],
    ["gh pr review", `gh pr review 1 ${R} --approve -b "Quilla Marsh approves"`],
    ["gh issue create", `gh issue create ${R} -t "From Quilla Marsh" -b x`],
    ["gh issue edit", `gh issue edit 2 ${R} -b "Quilla Marsh"`],
    ["gh issue comment", `gh issue comment 2 ${R} -b "Quilla Marsh"`],
    [
      "gh api POST to a comment",
      `gh api -X POST repos/quillco/playground/issues/1/comments -f body="Quilla Marsh"`,
    ],
    [
      "gh api PATCH to a pull request",
      `gh api -X PATCH repos/quillco/playground/pulls/1 -f title="Quilla Marsh"`,
    ],
  ])("%s", async (_, command) => {
    const reason = await run(bash(command))
    expect(reason).toContain("no-public-leak hook refused")
    expect(reason).toContain("a person's name")
    expect(reason).not.toContain("Quilla")
  })

  test("the GitHub MCP's comment", async () => {
    const reason = await run(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_input: {
          body: "Quilla Marsh asked",
          issue_number: 1,
          owner: "quillco",
          repo: "playground",
        },
        tool_name: "mcp__github-shared__add_issue_comment",
      }),
    )
    expect(reason).toContain("a person's name")
    expect(reason).not.toContain("Quilla")
  })

  test.each([
    ["a handle", "thanks @qmarsh", "qmarsh"],
    ["a company term", "built for Vantorix", "Vantorix"],
    ["a Slack id", "settled in C0MADE0401", "C0MADE0401"],
    ["a Linear key", "fixes MADEVX-42", "MADEVX-42"],
    ["an email address", "mail quilla@madeup.test", "quilla@madeup.test"],
    ["an archive link", "see https://github.com/acme/archive/pull/9", "acme/archive"],
  ])("its reason names %s, never the text", async (kind, body, term) => {
    const reason = await run(bash(`gh pr comment 1 ${R} --body "${body}"`))
    expect(reason).toContain(kind)
    expect(reason).not.toContain(term)
  })

  // RFC 2606's example domains name no one; each other address is built at run time, so the trace ratchet reads none in this file
  const address = (domain: string) => ["quilla", domain].join("@")
  test.each([
    ["example.com"],
    ["example.org"],
    ["example.net"],
    ["mail.example.com"],
    ["EXAMPLE.COM"],
  ])("an address on %s, an example domain, passes (#2403)", async (domain) => {
    expect(await run(bash(`gh pr comment 1 ${R} --body "mail ${address(domain)}"`))).toBeUndefined()
  })

  test.each([
    ["example.com.evil.io"],
    ["examplecom.io"],
    ["notexample.com"],
    ["example.co"],
    ["sub.exampleXcom"],
    ["subXexample.com"],
    ["gmail.com"],
    ["madeup.test"],
  ])("an address on %s, no example domain, still refuses (#2403)", async (domain) => {
    expect(await run(bash(`gh pr comment 1 ${R} --body "mail ${address(domain)}"`))).toContain(
      "an email address",
    )
  })

  test("an example address beside another address still refuses (#2403)", async () => {
    const body = `mail ${address("example.com")} or ${address("gmail.com")}`
    expect(await run(bash(`gh pr comment 1 ${R} --body "${body}"`))).toContain("an email address")
  })

  test("a body it cannot read refuses", async () => {
    expect(await run(bash(`gh pr comment 1 ${R} --body "$BODY"`))).toContain(
      "no-public-leak hook refused",
    )
  })
})

// Checkouts of the public repository with nothing pushed: `mailed`, whose newest commit's message holds a made-up address, and `clean`, whose messages hold none; gh pr create reads the commits it may push before a push the same call runs first.
describe("a refusal names the text that held the term", () => {
  const dirs = { clean: "", mailed: "", separated: "" }
  let sha = ""
  let separated = ""
  const git = (dir: string, ...args: string[]): string => {
    const proc = Bun.spawnSync(
      ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { stderr: "pipe" },
    )
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
    return proc.stdout.toString().trim()
  }
  const checkout = async (name: string, message: string): Promise<string> => {
    const dir = join(scratch, name)
    await mkdir(dir, { recursive: true })
    git(dir, "init", "-q", "-b", "main")
    git(dir, "remote", "add", "origin", "https://github.com/quillco/playground.git")
    git(dir, "commit", "-q", "--allow-empty", "-m", "Fix the export")
    git(dir, "commit", "-q", "--allow-empty", "-m", message)
    return dir
  }
  const at = (command: string, cwd: string) =>
    run(
      JSON.stringify({
        cwd,
        hook_event_name: "PreToolUse",
        tool_input: { command },
        tool_name: "Bash",
      }),
    )
  const CHAIN = `git push origin HEAD:fix && gh pr create --title "Fix the import"`

  beforeAll(async () => {
    dirs.mailed = await checkout("mailed", "Fix the import\n\nReported-by: quilla@madeup.test")
    dirs.clean = await checkout("clean", "Fix the import")
    sha = git(dirs.mailed, "rev-parse", "--short", "HEAD")
    dirs.separated = await checkout(
      "separated",
      "Fix the import\x1eReported-by: quilla@madeup.test",
    )
    separated = git(dirs.separated, "rev-parse", "--short", "HEAD")
  })

  test("a commit message holding the byte that splits the log keeps the text after it, under that commit", async () => {
    const reason = await at(`gh pr create --title "Fix the import" --body ok`, dirs.separated)
    expect(reason).toContain(
      `an email address, in the message of commit ${separated}, which it may push`,
    )
  })

  test("a ship's notes file names its notes file", async () => {
    const file = join(scratch, "notes-mailed.md")
    await Bun.write(file, "Mail quilla@madeup.test\n")
    const reason = await at(`gh release create v1 ${R} -F ${file}`, dirs.clean)
    expect(reason).toContain("an email address, in its notes file")
  })

  test("a commit message alone holding an address names that commit, which gh pr create may push", async () => {
    const reason = await at(`${CHAIN} --body "Fixes the import"`, dirs.mailed)
    expect(reason).toContain("no-public-leak hook refused gh pr create")
    expect(reason).toContain(`an email address, in the message of commit ${sha}, which it may push`)
    expect(reason).toContain("git commit --amend")
    expect(reason).not.toContain("quilla@madeup.test")
  })

  test("gh pr create alone names that commit too", async () => {
    const reason = await at(`gh pr create --title "Fix the import" --body ok`, dirs.mailed)
    expect(reason).toContain(`an email address, in the message of commit ${sha}, which it may push`)
  })

  // the scan no-playground-leak's engine shares: what gh pr create may push is read against origin's live branches, which an insteadOf rule serves from a local bare repo, so a commit only a stale tracking ref holds is read
  test("gh pr create reads a commit only a stale tracking ref holds", async () => {
    const dir = await checkout("stale", "Fix the import\n\nReported-by: quilla@madeup.test")
    const bare = join(scratch, "stale.git")
    git(scratch, "init", "-q", "--bare", "-b", "main", bare)
    git(dir, "config", `url.${bare}.insteadOf`, "https://github.com/quillco/playground.git")
    git(dir, "push", "-q", "origin", "HEAD:gone")
    git(bare, "branch", "-D", "gone")
    const stale = git(dir, "rev-parse", "--short", "HEAD")
    const reason = await at(`gh pr create --title "Fix the import" --body ok`, dir)
    expect(reason).toContain(
      `an email address, in the message of commit ${stale}, which it may push`,
    )
  })

  test("a body alone holding an address names gh pr create and its body", async () => {
    const reason = await at(`${CHAIN} --body "Mail quilla@madeup.test"`, dirs.clean)
    expect(reason).toContain("no-public-leak hook refused gh pr create")
    expect(reason).toContain("an email address, in its body")
    expect(reason).not.toContain("quilla@madeup.test")
  })

  test("a title holding an address names its title", async () => {
    const reason = await at(`gh pr create --title "quilla@madeup.test" --body ok`, dirs.clean)
    expect(reason).toContain("an email address, in its title")
  })

  test.each([
    ["the chain with clean messages and body", `${CHAIN} --body "Fixes the import"`],
    ["git log", "git log --oneline -5"],
  ])("lets %s run", async (_, command) => {
    expect(await at(command, dirs.clean)).toBeUndefined()
  })

  test("leaves git push alone, since its policy reads no git push", async () => {
    expect(await at("git push origin HEAD:fix", dirs.mailed)).toBeUndefined()
  })
})

describe("what it lets through", () => {
  test.each([
    ["plain words", `gh pr comment 1 ${R} --body "Fixes the export button"`],
    [
      "a link to the repository itself",
      `gh pr comment 1 ${R} --body "see github.com/quillco/playground/pull/3"`,
    ],
    [
      "a write to another repository",
      `gh pr comment 1 --repo acme/app --body "Quilla Marsh asked"`,
    ],
    ["a read", `gh pr view 1 ${R}`],
    ["a git commit", `git commit -m "Quilla Marsh"`],
  ])("%s", async (_, command) => {
    expect(await run(bash(command))).toBeUndefined()
  })

  test("factory.publicRepo, once set, is the repository it guards", async () => {
    const moved = storeWith(
      join(scratch, "moved"),
      { "no-public-leak.json": JSON.stringify(TERMS) },
      {
        "factory.publicRepo": "acme/public",
      },
    )
    const said = `--body "Quilla Marsh asked"`
    expect(await run(bash(`gh pr comment 1 --repo acme/public ${said}`), moved)).toContain(
      "a person's name",
    )
    expect(await run(bash(`gh pr comment 1 ${R} ${said}`), moved)).toBeUndefined()
  })

  test("factory.publicRepo set empty leaves the guard on the repository it guards while unset", async () => {
    const empty = storeWith(
      join(scratch, "empty-public"),
      { "no-public-leak.json": JSON.stringify(TERMS) },
      { "factory.publicRepo": "" },
    )
    expect(
      await run(bash(`gh pr comment 1 ${UNSET_R} --body "Quilla Marsh asked"`), empty),
    ).toContain("a person's name")
  })

  // issue 1454: unset, the guard keeps the checkout's origin alone, with no fixed second repository
  test("while factory.publicRepo is unset it guards the origin alone, and another repository's write passes", async () => {
    const empty = storeWith(
      join(scratch, "unset-other"),
      { "no-public-leak.json": JSON.stringify(TERMS) },
      { "factory.publicRepo": "" },
    )
    expect(reposOf({ schemaVersion: 1, values: {} }, checkout).public).toEqual([ORIGIN])
    expect(
      await run(
        bash(`gh pr comment 1 --repo quillco/made-up-yard --body "Quilla Marsh asked"`),
        empty,
      ),
    ).toBeUndefined()
  })

  test("factory.publicRepo set to a list guards each, and reads past each one's name", async () => {
    const both = storeWith(
      join(scratch, "public-list"),
      { "no-public-leak.json": JSON.stringify(TERMS) },
      { "factory.publicRepo": ["quillco/playground", "quillco/yard"] },
    )
    const said = `--body "Quilla Marsh asked"`
    for (const repo of ["quillco/playground", "quillco/yard"])
      expect(await run(bash(`gh pr comment 1 --repo ${repo} ${said}`), both)).toContain(
        "a person's name",
      )
    expect(
      await run(
        bash(`gh pr comment 1 --repo quillco/yard --body "see github.com/quillco/yard/pull/3"`),
        both,
      ),
    ).toBeUndefined()
  })

  test("a stranger's clone with no store still refuses the built-in kinds, and lets a key through, since keys come from the list alone", async () => {
    expect(
      await run(bash(`gh pr comment 1 ${UNSET_R} --body "mail quilla@madeup.test"`), stranger),
    ).toContain("an email address")
    expect(
      await run(bash(`gh pr comment 1 ${UNSET_R} --body "closes MADEVX-1"`), stranger),
    ).toBeUndefined()
    expect(
      await run(bash(`gh pr comment 1 ${UNSET_R} --body "Quilla Marsh"`), stranger),
    ).toBeUndefined()
  })
})

describe("it fails closed on its list", () => {
  const write = bash(`gh pr comment 1 ${R} --body "Fixes it"`)
  const data = (name: string) => join(scratch, name)

  test("a store that lacks the list refuses a write, naming the file, the write that seeds it and its shape", async () => {
    const reason = await run(write, storeWith(data("lacks"), {}))
    expect(reason).toContain("no-public-leak hook refused this call:")
    expect(reason).toContain("holds no hooks/no-public-leak.json")
    expect(reason).toContain(
      "tell your lead, and the dispatcher hands the owner ! playground ext put <login> list no-public-leak <file> --reason <why> to type in the dispatcher's terminal window",
    )
    expect(reason).toContain(
      "The list is a JSON object with an array of strings under each of companies, handles, linearKeys, names, slackIds",
    )
    expect(reason).not.toContain("ext import")
  })

  describe("a store that lacks the list", () => {
    const lacks = () => storeWith(data("lacks-reads"), {})
    const mcp = (tool: string, input: Record<string, unknown>) =>
      JSON.stringify({
        cwd: scratch,
        hook_event_name: "PreToolUse",
        tool_input: input,
        tool_name: tool,
      })

    test.each([
      ["git log", bash("git log --oneline -5")],
      ["git remote -v", bash("git remote -v")],
      ["gh issue list", bash(`gh issue list ${R}`)],
      ["gh pr view", bash(`gh pr view 1 ${R}`)],
      ["gh api GET", bash("gh api repos/quillco/playground/issues")],
      ["a read over a .git path", bash("cat .git/worktrees/a/HEAD")],
      ["a grep over a worktree's .git file", bash("grep gitdir .git")],
    ])("lets %s run", async (_, raw) => {
      expect(await run(raw, lacks())).toBeUndefined()
    })

    test.each([
      ["gh issue create", bash(`gh issue create ${R} -t "Fix export" -b "Fixes it"`)],
      ["git push", bash("git push https://github.com/quillco/playground.git main")],
      ["git push to a remote it cannot place", bash("git push origin main")],
      ["gh api DELETE", bash("gh api -X DELETE repos/quillco/playground/issues/1/labels/x")],
      [
        "gh api POST",
        bash(`gh api -X POST repos/quillco/playground/issues/1/comments -f body="Fixes it"`),
      ],
      [
        "the GitHub MCP's read",
        mcp("mcp__github-shared__list_issues", { owner: "quillco", repo: "playground" }),
      ],
      [
        "the GitHub MCP's comment",
        mcp("mcp__github-shared__add_issue_comment", {
          body: "Fixes it",
          issue_number: 1,
          owner: "quillco",
          repo: "playground",
        }),
      ],
      [
        "a Slack MCP post",
        mcp("mcp__slack-shared__chat_post_message", { channel: "C0MADE0404", text: "hi" }),
      ],
    ])("refuses %s", async (_, raw) => {
      expect(await run(raw, lacks())).toContain("holds no hooks/no-public-leak.json")
    })
  })

  test("an empty store folder refuses a write", async () => {
    await mkdir(storeMarker({ PLAYGROUND_DATA_DIR: data("unrendered") }), { recursive: true })
    expect(await run(write, data("unrendered"))).toContain("holds no hooks/no-public-leak.json")
  })

  test.each([
    ["empty", ""],
    ["{}", "{}"],
    ["malformed", "{ names: ["],
  ])("a list that is %s refuses a write", async (name, text) => {
    expect(
      await run(write, storeWith(data(`list-${name}`), { "no-public-leak.json": text })),
    ).toContain("no-public-leak hook refused this call: its list")
  })

  test("a store that lacks policy.json refuses a write", async () => {
    const bad = storeWith(data("policy-bad"), { "no-public-leak.json": JSON.stringify(TERMS) })
    await rm(join(currentDir(bad), "policy.json"))
    const reason = await run(write, bad)
    expect(reason).toContain("no-public-leak hook refused this call:")
    expect(reason).toContain("holds no policy.json")
  })

  test("a broken list leaves a call that writes nowhere alone", async () => {
    const broken = storeWith(data("list-broken"), { "no-public-leak.json": "{}" })
    expect(await run(bash("ls -la"), broken)).toBeUndefined()
  })
})

describe("as Claude Code runs it", () => {
  test("the script exits 2 with the reason on stderr for a factory session", async () => {
    const proc = Bun.spawn(["bun", script], {
      env: { ...process.env, ...env(stored), PLAYGROUND_ROLE: "worker" },
      stderr: "pipe",
      stdin: new Blob([bash(`gh pr comment 1 ${R} --body "closes MADEVX-1"`)]),
    })
    expect(await proc.exited).toBe(2)
    expect(await new Response(proc.stderr).text()).toContain("no-public-leak hook refused")
  })
})
