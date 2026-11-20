import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-protected-push"
import { originCheckout } from "../../machine"
import { storeWith } from "./render-set"
import { git } from "./scratch-git"

// Made-up repositories: made-up/app is the factory's, by factory.repo; made-up/other is any other.
const APP = "https://github.com/made-up/app.git"
const OTHER = "https://github.com/made-up/other.git"
// The closed sandbox's git env config, which turns commit signing off (scripts/spawn.sh).
const UNSIGNED = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
}
const dirs: Record<string, string> = {}
let scratch = ""
let data = ""

const ok = (dir: string, ...args: string[]) => {
  const run = git(dir, ...args)
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)
}

async function clone(name: string, branch: string, ...remotes: [string, string][]) {
  const dir = join(scratch, name)
  await mkdir(dir, { recursive: true })
  ok(dir, "init", "-q", "-b", branch)
  ok(dir, "commit", "-q", "--allow-empty", "-m", "first")
  for (const [remote, url] of remotes) ok(dir, "remote", "add", remote, url)
  return dir
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-protected-push-"))
  data = storeWith(join(scratch, "data"), {}, { "factory.repo": "made-up/app" })
  dirs.app = await clone("app", "work", ["origin", APP], ["fork", OTHER])
  dirs.canary = await clone("on-canary", "canary", ["origin", APP])
  dirs.tracks = await clone("tracks", "work", ["origin", APP])
  ok(dirs.tracks, "config", "branch.work.remote", "origin")
  ok(dirs.tracks, "config", "branch.work.merge", "refs/heads/canary")
  dirs.refspec = await clone("refspec", "work", ["origin", APP])
  ok(dirs.refspec, "config", "remote.origin.push", "refs/heads/work:refs/heads/main")
  dirs.matching = await clone("matching", "work", ["origin", APP])
  ok(dirs.matching, "config", "push.default", "matching")
  dirs.alias = await clone("alias", "work", ["origin", APP])
  ok(dirs.alias, "config", "alias.p", "push")
  ok(dirs.alias, "config", "alias.s", "status")
  dirs.instead = await clone("instead", "work", ["origin", OTHER])
  ok(dirs.instead, "config", `url.${APP}.pushInsteadOf`, "https://example.com/x")
  dirs.pushurl = await clone("pushurl", "work", ["origin", OTHER])
  ok(dirs.pushurl, "remote", "set-url", "--push", "origin", APP)
  dirs.other = await clone("other", "canary", ["origin", OTHER])
  dirs.ext = await clone("ext", "work", [
    "origin",
    "https://github.com/made-up/playground-notes.git",
  ])
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const input = (command: string, cwd: string) =>
  JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_input: { command }, tool_name: "Bash" })
const bash = (command: string, cwd = dirs.app, environment: Record<string, string> = {}) =>
  check(input(command, cwd), { PLAYGROUND_DATA_DIR: data, ...environment })

describe("a push that writes main or canary of the factory's repository is refused", () => {
  test.each([
    ["main by name", "git push origin main"],
    ["canary by name", "git push origin canary"],
    ["main in capitals", "git push origin Main"],
    ["HEAD onto canary", "git push origin HEAD:canary"],
    ["a full ref", "git push origin work:refs/heads/main"],
    ["heads/ as the destination", "git push origin work:heads/canary"],
    ["a force push", "git push -f origin +work:main"],
    ["--force-with-lease", "git push --force-with-lease origin work:canary"],
    ["a delete", "git push origin --delete canary"],
    ["a delete by an empty source", "git push origin :main"],
    ["through run-slot", "~/.playground/ops/run-slot.sh w -- git push origin main"],
    ["through env", "env NODE_ENV=production SKIP_ENV_VALIDATION=true git push origin main"],
    ["through bash -c", "bash -c 'git push origin canary'"],
    ["one of several refspecs", "git push origin work main"],
    ["with -u", "git push -u origin HEAD:main"],
    ["to the factory's URL", `git push ${APP} main`],
  ])("%s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-protected-push hook refuses this git push")
    expect(reason).toContain("pr:merge")
    expect(reason).toContain("ship:merge")
  })

  test("git -C from another folder", async () => {
    expect(await bash(`git -C ${dirs.app} push origin main`, dirs.other)).toContain(
      "writes main of made-up/app",
    )
  })

  test("cd into the checkout first", async () => {
    expect(await bash(`cd ${dirs.app} && git push origin canary`, dirs.other)).toContain(
      "writes canary",
    )
  })

  test("the factory's URL from another checkout", async () => {
    expect(await bash(`git push ${APP} HEAD:main`, dirs.other)).toContain("writes main")
  })

  test("a bare push with canary checked out", async () => {
    expect(await bash("git push", dirs.canary)).toContain("writes canary")
    expect(await bash("git push origin", dirs.canary)).toContain("writes canary")
    expect(await bash("git push origin HEAD", dirs.canary)).toContain("writes canary")
  })

  test("a bare push of a branch that tracks canary", async () => {
    expect(await bash("git push", dirs.tracks)).toContain("writes canary")
  })

  test("a push URL that is the factory's", async () => {
    expect(await bash("git push origin main", dirs.pushurl)).toContain("writes main")
  })
})

describe("a push the hook cannot read is refused where it may land in the factory's repository", () => {
  test.each([
    ["--all", "git push --all origin", "--all"],
    ["--mirror", "git push --mirror origin", "--mirror"],
    ["an abbreviated option", "git push --mir origin", "--mir"],
    ["--prune", "git push --prune origin 'refs/heads/*:refs/heads/*'", "--prune"],
    ["a glob", "git push origin 'refs/heads/*:refs/heads/*'", "many branches"],
    ["the matching refspec", "git push origin :", "many branches"],
    ["a ref built at run time", 'git push origin "$B"', "built at run time"],
    ["a remote built at run time", 'git push "$R" main', "built at run time"],
    ["HEAD after a checkout", "git checkout canary && git push", "may switch"],
    ["HEAD after a script", "bun run x && git push origin HEAD", "may switch"],
    ["-c on the push", "git -c push.default=matching push", "carries -c"],
    ["GIT_DIR", "GIT_DIR=/x/.git git push origin HEAD", "GIT_"],
    ["an inline alias", "git -c alias.p=push p origin main", "carries -c"],
    ["a subcommand built at run time", 'git "$S" origin main', "cannot read"],
    ["send-pack", "git send-pack origin main", "does not read"],
    ["subtree push", "git subtree push --prefix=x origin main", "does not read"],
    ["refs from xargs", "echo main | xargs git push origin", "xargs"],
  ])("%s", async (_, command, why) => {
    const reason = await bash(command)
    expect(reason).toContain("no-protected-push hook refuses this git push")
    expect(reason).toContain(why)
  })

  // Only the closed sandbox's exact set in the session's own environment reads as signing alone; each near miss of it stays a variable that may move the push.
  test.each([
    ["a count of 0", { ...UNSIGNED, GIT_CONFIG_COUNT: "0" }],
    ["a count of 01", { ...UNSIGNED, GIT_CONFIG_COUNT: "01" }],
    ["a count with a space", { ...UNSIGNED, GIT_CONFIG_COUNT: " 1" }],
    ["a count of 2 with one key", { ...UNSIGNED, GIT_CONFIG_COUNT: "2" }],
    ["no count", { GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" }],
    ["a missing key", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_VALUE_0: "false" }],
    ["a missing value", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign" }],
    ["a value of False", { ...UNSIGNED, GIT_CONFIG_VALUE_0: "False" }],
    ["a value of 0", { ...UNSIGNED, GIT_CONFIG_VALUE_0: "0" }],
    ["a value of no", { ...UNSIGNED, GIT_CONFIG_VALUE_0: "no" }],
    ["an empty value", { ...UNSIGNED, GIT_CONFIG_VALUE_0: "" }],
    ["the key in another case", { ...UNSIGNED, GIT_CONFIG_KEY_0: "commit.gpgSign" }],
    ["another key", { ...UNSIGNED, GIT_CONFIG_KEY_0: "push.default" }],
    [
      "a key past the count",
      { ...UNSIGNED, GIT_CONFIG_KEY_1: "push.default", GIT_CONFIG_VALUE_1: "matching" },
    ],
    ["a bare GIT_CONFIG", { ...UNSIGNED, GIT_CONFIG: "/x/config" }],
    ["GIT_CONFIG_PARAMETERS", { ...UNSIGNED, GIT_CONFIG_PARAMETERS: "'push.default'='matching'" }],
    ["GIT_CONFIG_GLOBAL", { ...UNSIGNED, GIT_CONFIG_GLOBAL: "/x/config" }],
    ["GIT_CONFIG_SYSTEM", { ...UNSIGNED, GIT_CONFIG_SYSTEM: "/x/config" }],
    ["GIT_CONFIG_NOSYSTEM", { ...UNSIGNED, GIT_CONFIG_NOSYSTEM: "1" }],
    ["GIT_DIR beside it", { ...UNSIGNED, GIT_DIR: "/x/.git" }],
  ])("a bare push with %s in the session's environment", async (_, environment) => {
    expect(await bash("git push", dirs.app, environment)).toContain(
      "no-protected-push hook refuses this git push",
    )
  })

  test.each([
    [
      "the closed sandbox's set typed on the line",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false git push",
    ],
    [
      "the set exported earlier on the line",
      "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false && git push",
    ],
    ["-c turning signing off", "git -c commit.gpgsign=false push"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("no-protected-push hook refuses this git push")
  })

  test("a closed sandbox's session still cannot write main", async () => {
    expect(await bash("git push origin main", dirs.app, UNSIGNED)).toContain("it writes main")
  })

  test("a configured alias in the alias checkout", async () => {
    expect(await bash("git p origin main", dirs.alias)).toContain("an alias that may push")
  })

  test("a push refspec in the config", async () => {
    expect(await bash("git push", dirs.refspec)).toContain("push refspec")
  })

  test("push.default matching", async () => {
    expect(await bash("git push", dirs.matching)).toContain("matching")
  })

  test("a pushInsteadOf rule that rewrites the remote", async () => {
    expect(await bash("git push https://example.com/x main", dirs.instead)).toContain(
      "pushInsteadOf",
    )
  })

  test("a folder the hook cannot read", async () => {
    expect(await bash('cd "$D" && git push origin main', dirs.other)).toContain("does not read")
  })

  test("factory.repo unset falls back to the main checkout's origin", async () => {
    const empty = join(scratch, "no-store")
    const main = originCheckout(join(scratch, "main-checkout"), "acme/made-up-factory")
    const fallback = await clone("fallback", "work", [
      "origin",
      "https://github.com/acme/made-up-factory.git",
    ])
    expect(
      await check(input("git push origin main", fallback), { PLAYGROUND_DATA_DIR: empty }, main),
    ).toContain("writes main of acme/made-up-factory")
  })
})

describe("every other push runs", () => {
  test.each([
    ["the work branch by name", "git push origin work"],
    ["HEAD onto the work branch", "git push origin HEAD:work"],
    ["HEAD with -u", "git push -u origin HEAD"],
    ["a bare push of the work branch", "git push"],
    ["a branch whose name holds main", "git push origin HEAD:main-fix"],
    ["a branch under a folder named canary", "git push origin HEAD:PG-1-canary/x"],
    ["tags alone", "git push --tags origin"],
    ["a tag named main", "git push origin work:refs/tags/main"],
    ["after a commit", "git add -A && git commit -m m && git push"],
    [
      "after a commit with a heredoc message",
      "git commit -m \"$(cat <<'EOF'\nfix\nEOF\n)\" && git push origin HEAD",
    ],
    ["a delete of the work branch", "git push origin --delete work"],
    ["main of another remote", "git push fork main"],
    ["a dry run of the work branch", "git push -n origin work"],
    ["a subcommand that is no alias", "git s"],
    ["echo", "echo git push origin main"],
    ["a commit message naming the push", "git commit -m 'git push origin main is refused'"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test.each([
    ["main of another repository", "git push origin main", "other"],
    ["canary of another repository", "git push origin canary", "other"],
    ["a bare push in another repository on canary", "git push", "other"],
    ["main of an extension repository", "git push origin HEAD:main", "ext"],
  ])("%s", async (_, command, dir) => {
    expect(await bash(command, dirs[dir])).toBeUndefined()
  })

  // The closed sandbox's settings turn commit signing off through git's env config (scripts/spawn.sh), which reaches the hook as the session's own environment.
  test.each([
    ["a bare push of the work branch", "git push"],
    ["HEAD with -u", "git push -u origin HEAD"],
    ["HEAD onto the work branch", "git push origin HEAD:work"],
  ])("%s from a closed sandbox's session", async (_, command) => {
    expect(await bash(command, dirs.app, UNSIGNED)).toBeUndefined()
  })

  test("a call that is not Bash runs", async () => {
    const raw = JSON.stringify({ tool_input: { file_path: "/x" }, tool_name: "Read" })
    expect(await check(raw, { PLAYGROUND_DATA_DIR: data })).toBeUndefined()
  })
})

// The Builder, a lead whose registry name has the roster's kind builder, and a worker, each a made-up session.
const config = () => join(scratch, "config")
const as = (session: "builder" | "worker", command: string, cwd = dirs.app, extra = {}) =>
  check(
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      session_id: `s-${session}`,
      tool_input: { command },
      tool_name: "Bash",
    }),
    {
      CLAUDE_CONFIG_DIR: config(),
      PLAYGROUND_DATA_DIR: data,
      PLAYGROUND_ROLE: session === "builder" ? "lead" : "worker",
      ...extra,
    },
  )
const tool = (name: string, input: Record<string, unknown>, session = "worker") =>
  check(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: `s-${session}`,
      tool_input: input,
      tool_name: name,
    }),
    {
      CLAUDE_CONFIG_DIR: config(),
      PLAYGROUND_DATA_DIR: data,
      PLAYGROUND_ROLE: session === "builder" ? "lead" : "worker",
    },
  )

beforeAll(async () => {
  await mkdir(join(config(), "sessions"), { recursive: true })
  await Bun.write(
    join(data, "roster.json"),
    JSON.stringify({
      agents: [
        { kind: "builder", name: "builder", status: "working" },
        { kind: "worker", name: "abc-worker", status: "working" },
      ],
    }),
  )
  for (const [session, name] of [
    ["s-builder", "builder"],
    ["s-worker", "abc-worker"],
  ])
    await Bun.write(
      join(config(), "sessions", `${session}.json`),
      JSON.stringify({ name, sessionId: session }),
    )
  await Bun.write(
    join(scratch, "resolve.graphql"),
    'mutation { resolveReviewThread(input: {threadId: "x"}) { clientMutationId } }',
  )
  await Bun.write(join(scratch, "body.md"), "Red against the source; names PLAYGROUND_ROLE.\n")
  await Bun.write(
    join(scratch, "merge.graphql"),
    'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }',
  )
  await Bun.write(
    join(scratch, "canary.json"),
    JSON.stringify({ ref: "refs/heads/canary", sha: "abc1234" }),
  )
})

const MERGE = "gh pr merge 5 --squash --match-head-commit 0123abc"

describe("a hand-run gh pr merge on the factory's repository", () => {
  test.each([
    ["by number in its checkout", MERGE, "app"],
    ["by -R from another checkout", `${MERGE} -R made-up/app`, "other"],
    [
      "by gh's own -R before the subcommand",
      "gh -R made-up/app pr merge 5 --squash --match-head-commit 0123abc",
      "other",
    ],
    [
      "by its URL",
      "gh pr merge https://github.com/made-up/app/pull/5 -s --match-head-commit 0123abc",
      "other",
    ],
  ])("passes for the Builder in the one form: %s", async (_, command, dir) => {
    expect(await as("builder", command, dirs[dir])).toBeUndefined()
  })

  test.each([
    ["by number", MERGE],
    ["bare", "gh pr merge 5"],
    ["with --admin", "gh pr merge 5 --squash --admin"],
    ["by -R", "gh pr merge 5 -R made-up/app"],
    ["through run-slot", `~/.playground/ops/run-slot.sh w -- ${MERGE}`],
    ["with the role set before it", `PLAYGROUND_ROLE=lead ${MERGE}`],
    ["with an unreadable repository", 'gh pr merge 5 -R "$R"'],
  ])("is refused for a worker: %s", async (_, command) => {
    expect(await as("worker", command)).toContain("no-protected-push hook refuses this gh pr merge")
  })

  test("is refused for a worker by its URL from another checkout", async () => {
    expect(
      await as("worker", "gh pr merge https://github.com/made-up/app/pull/5", dirs.other),
    ).toContain("no-protected-push hook refuses this gh pr merge")
  })

  test.each([
    ["without --match-head-commit", "gh pr merge 5 --squash"],
    ["without --squash", "gh pr merge 5 --merge --match-head-commit 0123abc"],
    ["with a head built at run time", 'gh pr merge 5 --squash --match-head-commit "$H"'],
    ["with the role as a prefix", `PLAYGROUND_ROLE=lead ${MERGE}`],
    ["with the role exported", `export PLAYGROUND_ROLE=lead; ${MERGE}`],
    ["with the role through env", `env PLAYGROUND_ROLE=lead ${MERGE}`],
    ["with the role declared", `declare -x PLAYGROUND_ROLE=lead; ${MERGE}`],
    ["with the role in a -c script", `bash -c 'PLAYGROUND_ROLE=lead ${MERGE}'`],
    ["after a source", `source ./roles.sh && ${MERGE}`],
    ["after a dot", `. ./roles.sh && ${MERGE}`],
  ])("is refused for the Builder %s", async (_, command) => {
    expect(await as("builder", command)).toContain(
      "no-protected-push hook refuses this gh pr merge",
    )
  })

  test("is refused past a cd the hook cannot name", async () => {
    expect(await as("worker", `cd "$D" && gh pr merge 5`)).toContain(
      "no-protected-push hook refuses",
    )
  })

  test.each([
    ["in another repository's checkout", "gh pr merge 5", "other"],
    ["by -R of another repository", "gh pr merge 5 -R made-up/other", "app"],
    [
      "by the URL of another repository",
      "gh pr merge https://github.com/made-up/other/pull/5",
      "app",
    ],
    ["for its help", "gh pr merge --help", "app"],
    ["a view", "gh pr view 5", "app"],
    ["an echo", "echo gh pr merge 5", "app"],
  ])("runs for a worker %s", async (_, command, dir) => {
    expect(await as("worker", command, dirs[dir])).toBeUndefined()
  })
})

// pr:merge's README gives the Builder's hand merge its body by file, since an inline body's text counts as the call's
describe("the Builder's hand merge takes its body by file", () => {
  test("a --body-file passes, whatever the file holds", async () => {
    const command = `gh pr merge 5 --squash --body-file ${scratch}/body.md --match-head-commit 0123abc`
    expect(await as("builder", command)).toBeUndefined()
  })

  test("an inline --body naming the role variable or source loses the pass, and the reason names --body-file", async () => {
    for (const body of [
      "red against the source and the bundle",
      "names PLAYGROUND_ROLE in no form",
    ]) {
      const reason = await as(
        "builder",
        `gh pr merge 5 --squash --body "${body}" --match-head-commit 0123abc`,
      )
      expect(reason).toContain("--body-file <file>")
    }
  })
})

describe("a call the hook cannot read is refused with the form that runs", () => {
  test.each([
    ["a query built at run time", 'gh api graphql -f query="$Q"'],
    ["a query file through a variable", "S=/x; gh api graphql -F query=@$S/resolve.graphql"],
    [
      "an endpoint built at run time",
      'gh api "repos/made-up/app/pulls/5/comments/$ID/replies" -f body=x',
    ],
  ])("%s", async (_, command) => {
    const reason = await as("worker", command)
    expect(reason).toContain("no-protected-push hook refuses")
    expect(reason).toContain("Spell the query file's path or the endpoint out literally")
  })

  test("a resolve from a query file spelled out literally runs", async () => {
    expect(
      await as("worker", `gh api graphql -F query=@${scratch}/resolve.graphql`),
    ).toBeUndefined()
  })
})

describe("a gh api write that moves main or canary of the factory's repository is refused", () => {
  test.each([
    [
      "a ref update of main",
      "gh api -X PATCH repos/made-up/app/git/refs/heads/main -f sha=abc1234",
    ],
    ["a ref delete of canary", "gh api -X DELETE repos/made-up/app/git/refs/heads/canary"],
    [
      "a ref create of canary",
      "gh api repos/made-up/app/git/refs -f ref=refs/heads/canary -f sha=abc1234",
    ],
    ["a ref create from --input", `gh api repos/made-up/app/git/refs --input ${"$S"}/canary.json`],
    [
      "a ref update with a leading slash",
      "gh api -X PATCH /repos/made-up/app/git/refs/heads/main -f sha=abc1234",
    ],
    [
      "a ref update by its full URL",
      "gh api -X PATCH https://api.github.com/repos/made-up/app/git/refs/heads/main -f sha=abc1234",
    ],
    [
      "a ref update by {owner}/{repo}",
      "gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/main -f sha=abc1234",
    ],
    [
      "a ref update of a branch built at run time",
      'gh api -X PATCH "repos/made-up/app/git/refs/heads/$B" -f sha=abc1234',
    ],
    [
      "a file write to main",
      "gh api -X PUT repos/made-up/app/contents/README.md -f message=m -f content=Zg== -f branch=main",
    ],
    [
      "a file write with no branch",
      "gh api -X PUT repos/made-up/app/contents/README.md -f message=m -f content=Zg==",
    ],
    [
      "a file delete on canary",
      "gh api -X DELETE repos/made-up/app/contents/README.md -f message=m -f sha=abc -f branch=canary",
    ],
    ["a merge into canary", "gh api repos/made-up/app/merges -f base=canary -f head=work"],
    ["a pull request merge", "gh api -X PUT repos/made-up/app/pulls/5/merge"],
  ])("%s", async (_, command) => {
    const run = command.replace("$S", scratch)
    expect(await as("worker", run)).toContain("no-protected-push hook refuses this gh api")
  })

  test.each([
    [
      "the ship step's tag",
      'gh api -X POST repos/{owner}/{repo}/git/refs -f ref=refs/tags/v1.2.3 -f sha="$MERGE"',
      "app",
    ],
    ["a read of main's ref", "gh api repos/made-up/app/git/refs/heads/main", "app"],
    [
      "a ref update of the work branch",
      "gh api -X PATCH repos/made-up/app/git/refs/heads/work -f sha=abc1234",
      "app",
    ],
    [
      "a ref create of the work branch",
      "gh api repos/made-up/app/git/refs -f ref=refs/heads/work -f sha=abc1234",
      "app",
    ],
    [
      "a file write to the work branch",
      "gh api -X PUT repos/made-up/app/contents/x -f message=m -f content=Zg== -f branch=work",
      "app",
    ],
    ["a comment", "gh api repos/made-up/app/issues/5/comments -f body=x", "app"],
    [
      "a ref update of another repository's main",
      "gh api -X PATCH repos/made-up/other/git/refs/heads/main -f sha=abc1234",
      "app",
    ],
    [
      "a file write by {owner}/{repo} in another checkout",
      "gh api -X PUT repos/{owner}/{repo}/contents/x -f message=m -f content=Zg== -f branch=main",
      "other",
    ],
  ])("runs: %s", async (_, command, dir) => {
    expect(await as("worker", command, dirs[dir])).toBeUndefined()
  })
})

describe("a gh api graphql call that merges or moves a ref is refused on any repository", () => {
  const mutation = `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`
  test.each([
    ["mergePullRequest for a worker", "worker", mutation, "app"],
    ["mergePullRequest for the Builder", "builder", mutation, "app"],
    ["mergePullRequest in another repository's checkout", "worker", mutation, "other"],
    [
      "updateRef",
      "worker",
      `gh api graphql -f query='mutation { updateRef(input: {refId: "x", oid: "y"}) { clientMutationId } }'`,
      "app",
    ],
    ["a query from a file", "worker", "gh api graphql -F query=@$S/merge.graphql", "app"],
  ] as const)("%s", async (_, session, command, dir) => {
    const reason = await as(session, command.replace("$S", scratch), dirs[dir])
    expect(reason).toContain("no-protected-push hook refuses this gh api graphql call")
    expect(reason).toContain("bun run pr:merge <n>")
    expect(reason).toContain("git push")
  })

  test.each([
    ["a read query", "gh api graphql -f query='query { viewer { login } }'"],
    [
      "createPullRequest",
      `gh api graphql -f query='mutation { createPullRequest(input: {repositoryId: "x", baseRefName: "canary", headRefName: "w", title: "t"}) { clientMutationId } }'`,
    ],
    [
      "a thread resolve",
      `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "x"}) { clientMutationId } }'`,
    ],
  ])("runs: %s", async (_, command) => {
    expect(await as("worker", command)).toBeUndefined()
  })
})

describe("a GitHub tool's write to main or canary of the factory's repository is refused", () => {
  const app = { owner: "made-up", repo: "app" }
  test.each([
    ["a merge for a worker", "merge_pull_request", { ...app, pullNumber: 5 }, "worker"],
    [
      "a merge for the Builder",
      "merge_pull_request",
      { ...app, merge_method: "squash", pullNumber: 5 },
      "builder",
    ],
    [
      "files pushed to main",
      "push_files",
      { ...app, branch: "main", files: [], message: "m" },
      "worker",
    ],
    [
      "a file written to canary",
      "create_or_update_file",
      { ...app, branch: "canary", content: "x", message: "m", path: "x" },
      "worker",
    ],
    ["a file deleted with no branch", "delete_file", { ...app, message: "m", path: "x" }, "worker"],
    [
      "a file written with no repository named",
      "create_or_update_file",
      { branch: "main", content: "x", message: "m", path: "x" },
      "worker",
    ],
  ])("%s", async (_, name, input, session) => {
    expect(await tool(`mcp__github-shared__${name}`, input, session)).toContain(
      "no-protected-push hook refuses mcp__github-shared__",
    )
  })

  test.each([
    [
      "files pushed to the work branch",
      "mcp__github-shared__push_files",
      { ...app, branch: "work", files: [], message: "m" },
    ],
    [
      "a merge in another repository",
      "mcp__github-shared__merge_pull_request",
      { owner: "made-up", pullNumber: 5, repo: "other" },
    ],
    [
      "a file written to another repository's main",
      "mcp__github-shared__create_or_update_file",
      { branch: "main", content: "x", message: "m", owner: "made-up", path: "x", repo: "other" },
    ],
    ["a read", "mcp__github-shared__get_file_contents", { ...app, path: "x" }],
    ["another server's write", "mcp__linear-shared__save_issue", { title: "x" }],
  ])("runs: %s", async (_, name, input) => {
    expect(await tool(name, input)).toBeUndefined()
  })
})

// no-playground-leak's own process takes the GitHub tools, so it runs this check on them too.
test("no-playground-leak's process refuses a GitHub tool's merge on the factory's repository", async () => {
  const proc = Bun.spawn(
    ["bun", "--no-env-file", join(import.meta.dir, "../../../scripts/hooks/no-playground-leak.ts")],
    {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: config(),
        PLAYGROUND_DATA_DIR: data,
        PLAYGROUND_ROLE: "worker",
      },
      stderr: "pipe",
      stdin: new TextEncoder().encode(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "s-worker",
          tool_input: { owner: "made-up", pullNumber: 5, repo: "app" },
          tool_name: "mcp__github-shared__merge_pull_request",
        }),
      ),
      stdout: "pipe",
    },
  )
  expect(await proc.exited).toBe(2)
  expect(await new Response(proc.stderr).text()).toContain("no-protected-push hook refuses")
})
