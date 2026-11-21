import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-extension-repo-write"
import { NOT_RUN as ENGINE_NOT_RUN } from "../../../scripts/hooks/shell"
import { storeWith } from "./render-set"

// Made-up values: the login quillco, the scope acme synced with quillco/acme-skills by ext.repos, and the scope notes synced with its default name, quillco/playground-notes.
const EXT = "https://github.com/quillco/acme-skills"
const NOTES = "git@github.com:quillco/playground-notes.git"
const OTHER = "https://github.com/acme/tools.git"
const A = "repos/quillco/acme-skills"
const NOT_RUN = "none of its commands ran"
const dirs: Record<string, string> = {}
let scratch = ""
let stored = ""

const git = (dir: string, ...args: string[]) => {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
}

async function clone(name: string, ...remotes: [string, string][]) {
  const dir = join(scratch, "work", name)
  await mkdir(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  for (const [remote, url] of remotes) git(dir, "remote", "add", remote, url)
  return dir
}

async function store(name: string, values: Record<string, unknown>, login?: string) {
  const data = storeWith(join(scratch, name), {}, values)
  for (const scope of ["acme", "notes"]) {
    await mkdir(join(data, "extensions", scope), { recursive: true })
    git(join(data, "extensions", scope), "init", "-q")
  }
  if (login) await writeFile(join(data, "extensions", "login"), `${login}\n`)
  return data
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-extension-repo-write-"))
  stored = await store("stored", { "ext.repos": { acme: "quillco/acme-skills" } }, "quillco")
  git(join(stored, "extensions", "acme"), "remote", "add", "origin", `${EXT}-renamed.git`)
  dirs.ext = await clone("ext", ["origin", `${EXT}.git`])
  dirs.other = await clone("other", ["origin", OTHER])
  dirs.pushurl = await clone("pushurl", ["origin", OTHER])
  git(dirs.pushurl, "remote", "set-url", "--push", "origin", EXT)
  dirs.multi = await clone("multi", ["origin", OTHER])
  git(dirs.multi, "remote", "set-url", "--add", "--push", "origin", OTHER)
  git(dirs.multi, "remote", "set-url", "--add", "--push", "origin", NOTES)
  dirs.second = await clone("second", ["origin", OTHER], ["mirror", NOTES])
  dirs.instead = await clone("instead", ["origin", OTHER])
  git(dirs.instead, "config", `url.${EXT}.insteadOf`, "https://example.com/x")
  git(dirs.instead, "config", `url.${EXT}.pushInsteadOf`, "https://example.com/y")
  git(dirs.instead, "remote", "add", "rewritten", "https://example.com/y")
  dirs.local = await clone("local", ["origin", join(scratch, "work", "ext")])
  dirs.named = await clone("playground-notes")
  await mkdir(join(dirs.other, "empty"))
  dirs.pushdefault = await clone("pushdefault", ["origin", OTHER])
  git(dirs.pushdefault, "config", "remote.pushDefault", `${EXT}.git`)
  dirs.pushremote = await clone("pushremote", ["origin", OTHER])
  git(dirs.pushremote, "config", "branch.main.pushRemote", NOTES)
  dirs.branchremote = await clone("branchremote", ["origin", OTHER])
  git(dirs.branchremote, "config", "branch.main.remote", EXT)
  dirs.pdname = await clone("pdname", ["origin", OTHER])
  git(dirs.pdname, "config", "remote.pushDefault", "origin")
  dirs.zed = await clone("zed", ["origin", "https://github.com/zed/acme-skills.git"])
  dirs.stale = await clone("stale", ["origin", OTHER])
  git(dirs.stale, "config", "branch.old.remote", "gone")
  git(dirs.stale, "config", "branch.dev.pushRemote", EXT)
  await mkdir(join(dirs.stale, "sub"))
  dirs.switch = await clone("switch", ["origin", OTHER])
  git(dirs.switch, "config", "branch.feat.remote", EXT)
  git(dirs.switch, "config", "alias.co", "checkout")
  dirs.alias = await clone("alias", ["origin", OTHER])
  git(dirs.alias, "config", "alias.p", "push")
  git(dirs.alias, "config", "alias.pp", "p --force")
  git(dirs.alias, "config", "alias.sh", "!git push")
  git(dirs.alias, "config", "alias.l", "log --oneline")
  git(dirs.alias, "config", "alias.dq", `push "${EXT}" main`)
  git(dirs.alias, "config", "alias.sq", "push 'git@github.com:quillco/acme-skills.git' main")
  git(dirs.alias, "config", "alias.bs", "push https://github.com/quillco/acme\\-skills main")
  git(dirs.alias, "config", "alias.open", `push "${EXT} main`)
  dirs.trunk = await clone("trunk", ["origin", `${EXT}.git`])
  git(dirs.trunk, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
  dirs.tagged = await clone("tagged", ["origin", `${EXT}.git`])
  git(
    dirs.tagged,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  )
  git(dirs.tagged, "tag", "v1")
  dirs.mapped = await clone("mapped", ["origin", `${EXT}.git`])
  git(dirs.mapped, "config", "remote.origin.push", "refs/heads/*:refs/heads/main")
  dirs.feature = await clone("feature", ["origin", `${EXT}.git`])
  git(dirs.feature, "symbolic-ref", "HEAD", "refs/heads/feature")
  dirs.trunkhead = await clone("trunkhead", ["origin", `${EXT}.git`])
  git(dirs.trunkhead, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
  git(dirs.trunkhead, "symbolic-ref", "HEAD", "refs/heads/trunk")
  dirs.detached = await clone("detached", ["origin", `${EXT}.git`])
  git(
    dirs.detached,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  )
  git(dirs.detached, "checkout", "-q", "--detach")
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const env = (data: string, extra: Record<string, string> = {}) => ({
  CLAUDE_CONFIG_DIR: scratch,
  PLAYGROUND_DATA_DIR: data,
  ...extra,
})
const bash = (command: string, cwd = dirs.other) =>
  JSON.stringify({
    cwd,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: "Bash",
  })
const tool = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_input: input,
    tool_name: `mcp__github-shared__${name}`,
  })
const run = (raw: string, data = stored, extra: Record<string, string> = {}) =>
  check(raw, env(data, extra))
const refused = async (raw: string, data = stored, extra: Record<string, string> = {}) => {
  const reason = await run(raw, data, extra)
  expect(reason).toContain("no-extension-repo-write hook refused")
  return reason as string
}

// Each row: what it is, the command, and the folder it runs in.
type Row = [string, string, string?]
const at = (dir: string) => dirs[dir]
// Every row as three, so bun:test hands the callback no done argument, which it would read as its dir.
const rows = (table: Row[]): [string, string, string][] =>
  table.map(([name, command, dir = "other"]) => [name, command, dir])

const REFUSED: Row[] = [
  ["git push by URL", `git push ${EXT} HEAD:main`],
  ["git push by remote name in a clone", "git push origin main", "ext"],
  ["git push with no remote in a clone", "git push", "ext"],
  ["git push in mixed case", "git push https://github.com/QuillCo/Acme-Skills.git main"],
  ["git push to a scope's default name", `git push ${NOTES} HEAD:main`],
  ["git push --mirror", `git push --mirror ${EXT}`],
  ["git push --delete", `git push --delete ${EXT} old`],
  ["git push behind a wrapper", `env X=1 git push ${EXT} main`],
  ["git --attr-source <tree> before a push", `git --attr-source HEAD push ${EXT} main`],
  ["git push to a remote added in the same call", `git remote add e ${EXT} && git push e main`],
  ["git push to a remote in a variable", "git push $R main"],
  ["gh api PUT on contents", `gh api -X PUT ${A}/contents/x.md -f message=m -f content=eA==`],
  ["gh api POST on git/refs", `gh api -X POST ${A}/git/refs -f ref=refs/heads/x -f sha=abc`],
  ["gh api PATCH on a ref", `gh api -X PATCH ${A}/git/refs/heads/main -f sha=abc`],
  ["gh api POST on merges", `gh api -X POST ${A}/merges -f base=main -f head=x`],
  ["gh api POST on git/blobs", `gh api -X POST ${A}/git/blobs -f content=x`],
  ["gh api POST on git/trees", `gh api -X POST ${A}/git/trees -f base_tree=abc`],
  ["gh api POST on git/commits", `gh api -X POST ${A}/git/commits -f message=m -f tree=abc`],
  ["gh api on a repository in a variable", "gh api -X PUT repos/$R/contents/x -f message=m"],
  ["gh api PATCH of the repository", `gh api -X PATCH ${A} -f default_branch=x`],
  [
    "gh api from the clone's {owner}/{repo}",
    "gh api -X PUT repos/{owner}/{repo}/contents/x -f message=m",
    "ext",
  ],
  ["gh api DELETE on contents", `gh api -X DELETE ${A}/contents/x.md -f message=m -f sha=abc`],
  ["gh api DELETE on a ref", `gh api -X DELETE ${A}/git/refs/heads/x`],
  ["gh api DELETE of the repository", `gh api -X DELETE ${A}`],
  ["gh api PUT on a pull request's merge", `gh api -X PUT ${A}/pulls/1/merge`],
  [
    "gh api past a conversation route by ..",
    `gh api -X POST ${A}/issues/../git/refs -f ref=x -f sha=y`,
  ],
  ["gh pr merge by -R", "gh pr merge 1 -R quillco/acme-skills --squash"],
  ["gh pr merge by URL", `gh pr merge ${EXT}/pull/3 --squash`],
  ["gh pr merge in a clone", "gh pr merge 3 --squash", "ext"],
  ["gh repo edit", "gh repo edit quillco/acme-skills --description x --default-branch dev"],
  ["gh repo edit in a clone", "gh repo edit --visibility public", "ext"],
  ["gh repo rename by -R", "gh repo rename new -R quillco/acme-skills --yes"],
  ["gh repo rename in a clone", "gh repo rename new --yes", "ext"],
  ["gh repo delete", "gh repo delete quillco/acme-skills --yes"],
  ["gh repo archive", "gh repo archive quillco/acme-skills -y"],
  ["gh repo unarchive", "gh repo unarchive quillco/playground-notes -y"],
  ["gh repo sync to a destination", "gh repo sync quillco/acme-skills --source acme/tools"],
  ["gh release create", "gh release create v1 -R quillco/acme-skills --notes x"],
  ["gh release edit", "gh release edit v1 -R quillco/acme-skills --notes x"],
  ["gh pr merge by -R in a variable", "gh pr merge 1 -R $R"],
  ["curl PUT on contents", `curl -X PUT -d '{}' https://api.github.com/${A}/contents/x`],
  ["curl GET of the repository", `curl https://api.github.com/${A}`],
]

describe("a write to an extension repository's git data or name is refused", () => {
  test.each(rows(REFUSED))("%s", async (_, command, dir) => {
    const reason = await refused(bash(command, at(dir)))
    expect(reason).toContain(NOT_RUN)
  })

  test("its reason names the owner's route and the repository", async () => {
    const reason = await refused(bash(`git push ${EXT} main`))
    expect(reason).toContain("quillco/acme-skills")
    expect(reason).toContain(
      "as a ! command in the dispatcher's terminal window: tell your lead what it should do, and the dispatcher hands the owner the command",
    )
  })

  test.each([
    ["create_or_update_file", { content: "x", message: "m", path: "x.md" }],
    ["push_files", { branch: "main", files: [], message: "m" }],
    ["delete_file", { branch: "main", message: "m", path: "x.md" }],
    ["merge_pull_request", { pullNumber: 1 }],
    ["create_branch", { branch: "x" }],
    ["delete_repository", {}],
    ["fork_repository", {}],
    ["update_pull_request_branch", { pullNumber: 1 }],
  ])("the GitHub MCP's %s", async (name, input) => {
    await refused(tool(name, { owner: "quillco", repo: "acme-skills", ...input }))
    await refused(tool(name, { owner: "QuillCo", repo: "playground-notes", ...input }))
  })
})

// #564: a scratch folder named git, passed to a program the hook does not know, read as that program running git
describe("a path word read as git behind a program it does not know", () => {
  test("its refusal names what it read and the ways through", async () => {
    const reason = await refused(
      bash("npx foo https://example.com $T/git push origin main", at("ext")),
    )
    expect(reason).toContain(
      "It read a word whose path ends in /git as git run by npx, a program it does not know: a folder or file passes under a path that does not end in /git, and git run by npx is read the same when written by its own name, git.",
    )
    expect(reason.endsWith(`, git. ${ENGINE_NOT_RUN}`)).toBe(true)
  })

  test("git by its own name behind it is refused as before", async () => {
    const reason = await refused(bash("npx foo git push origin main", at("ext")))
    expect(reason).not.toContain("It read a word whose path ends in")
  })
})

describe("a push resolves its target the way git does, and one it cannot place is refused", () => {
  test.each(
    rows([
      ["B1: a remote's push URL", "git push origin main", "pushurl"],
      ["B1: a remote's second push URL", "git push origin main", "multi"],
      ["B1: every remote when none is named", "git push", "second"],
      ["B1: a remote whose URL pushInsteadOf rewrites", "git push rewritten main", "instead"],
      ["B1: a literal URL insteadOf rewrites", "git push https://example.com/x main", "instead"],
      [
        "B1: a literal URL pushInsteadOf rewrites",
        "git push https://example.com/y main",
        "instead",
      ],
      ["B2: --git-dir", `git --git-dir=${"/x"}/.git push origin main`],
      ["B2: --git-dir as two words", "git --git-dir /x/.git push origin main"],
      ["B2: -c", `git -c remote.origin.pushurl=${EXT} push origin main`],
      ["B2: --config-env", "git --config-env=remote.origin.pushurl=U push origin main"],
      ["B2: a GIT_ variable on the call", "GIT_DIR=/x/.git git push origin main"],
      ["B2: a GIT_ variable set before it", "export GIT_CONFIG_COUNT=1; git push origin main"],
      ["B2: a GIT_ variable through env", "env GIT_CONFIG_PARAMETERS=x git push origin main"],
      ["B3: --repo with no remote", `git push --repo=${EXT}`],
      ["B3: --repo as two words", `git push --repo ${EXT} main`],
      ["B4: send-pack", `git send-pack ${EXT} main`],
      ["B4: subtree push", `git subtree push --prefix=x ${EXT} main`],
      ["B4: subtree push with -P", `git subtree push -P x ${EXT} main`],
      ["B4: a git alias for push", `git p ${EXT} main`, "alias"],
      ["B4: a git alias of an alias", `git pp ${EXT} main`, "alias"],
      ["B4: a ! alias", "git sh", "alias"],
      ["B4: an alias with a double-quoted URL", "git dq", "alias"],
      ["B4: an alias with a single-quoted scp URL", "git sq", "alias"],
      ["B4: an alias with a backslash escape in its URL", "git bs", "alias"],
      ["B4: an alias with an unclosed quote", "git open", "alias"],
      ["B4: an alias set by -c", `git -c alias.q=push q ${EXT} main`],
      ["B4: a gh alias set", "gh alias set m 'pr merge'"],
      ["B4: a gh alias import", "gh alias import aliases.yml"],
      ["B6: gh api on repositories/<id>", "gh api -X PUT repositories/123/contents/x -f message=m"],
      [
        "B6: curl on repositories/<id>",
        "curl -X PUT -d x https://api.github.com/repositories/1/git/refs",
      ],
      ["B8: an unknown program's repo verb", "$X repo delete quillco/acme-skills --yes"],
      ["B8: an unknown program before a push", `$X repo git push ${EXT} main`],
      ["N1: a scope clone's origin, after a rename", `git push ${EXT}-renamed main`],
      ["N1: curl to git's smart HTTP", `curl -X POST --data-binary @p ${EXT}.git/git-receive-pack`],
      ["N3: a remote whose URL is a local path", "git push origin main", "local"],
      ["N3: a local path", `git push ${join("..", "ext")} main`],
      [
        "a percent-encoded name to gh api",
        "gh api -X PUT repos/quillco/acme%2Dskills/contents/x -f message=m",
      ],
      [
        "a percent-encoded slash to gh api",
        "gh api -X PUT repos/quillco%2Facme-skills/contents/x -f message=m",
      ],
      [
        "a percent-encoded name to curl",
        "curl -X PUT -d x https://api.github.com/repos/quillco/acme%2Dskills/contents/x",
      ],
      [
        "a percent-encoded name to git push",
        "git push https://github.com/quillco/acme%2Dskills.git main",
      ],
      ["curl with a port", `curl -X PUT -d x https://api.github.com:443/${A}/contents/x`],
      ["gh pr update-branch", "gh pr update-branch 1 -R quillco/acme-skills"],
      ["a bare push to remote.pushDefault's URL", "git push", "pushdefault"],
      ["a bare push to branch.<b>.pushRemote's URL", "git push", "pushremote"],
      ["a bare push to branch.<b>.remote's URL", "git push", "branchremote"],
      [
        "gh api :owner/:repo from the clone",
        "gh api -X PUT repos/:owner/:repo/contents/x -f message=m",
        "ext",
      ],
      [
        "gh api {repo} under a literal owner",
        "gh api -X PUT repos/quillco/{repo}/contents/x -f message=m",
        "zed",
      ],
      [
        "gh api past a dot segment",
        "gh api -X PUT repos/x/../quillco/acme-skills/contents/x -f message=m",
      ],
      [
        "curl past a dot segment",
        "curl -X PUT -d x https://api.github.com/x/../repos/quillco/acme-skills/contents/x",
      ],
      [
        "curl past an escaped dot segment",
        "curl -X PUT -d x https://api.github.com/x/%2e%2e/repos/quillco/acme-skills/contents/x",
      ],
      [
        "curl to github.com past a dot segment",
        `curl -X POST --data-binary @p https://github.com/x/../quillco/acme-skills.git/git-receive-pack`,
      ],
      [
        "curl with a {} glob",
        "curl -X PUT -d x 'https://api.github.com/repos/quillco/{acme-skills}/contents/x'",
      ],
      [
        "curl with a [] glob",
        "curl -X PUT -d x 'https://api.github.com/repos/quillco/acme-skill[s-s]/contents/x'",
      ],
      [
        "curl with a glob in the host",
        "curl -X PUT -d x 'https://api.github.{com}/repos/quillco/acme-skills/contents/x'",
      ],
      [
        "curl with --request-target",
        "curl -X PUT -d x --request-target /repos/quillco/acme-skills/contents/x https://api.github.com/",
      ],
      [
        "curl with a Host header",
        `curl -X PUT -d x -H "Host: api.github.com" https://140.82.112.6/repos/quillco/acme-skills/contents/x`,
      ],
      [
        "curl to uploads.github.com",
        "curl -X POST --data-binary @a https://uploads.github.com/repos/quillco/acme-skills/assets",
      ],
      ["gh's publish-step delete", "gh release delete v1 -y --cleanup-tag -R quillco/acme-skills"],
      ["gh's publish-step upload", "gh release upload v1 x.tgz -R quillco/acme-skills"],
      ["gh pr merge by a variable in the extension clone", "gh pr merge $N", "ext"],
      ["a bare push after git switch in the same call", "git switch -c feat && git push", "switch"],
      [
        "a bare push after git checkout in the same call",
        "git checkout -b feat && git push",
        "switch",
      ],
      [
        "a bare push after gh pr checkout in the same call",
        "gh pr checkout 1 && git push",
        "switch",
      ],
      ["a bare push after a checkout alias in the same call", "git co feat && git push", "switch"],
      ["a bare push after any other git command", "git status && git push", "stale"],
      ["a bare push after a cd", "cd sub && git push", "stale"],
      ["a bare push by git -C", "git -C sub push", "stale"],
      ["a bare push after git rebase onto a branch", "git rebase main feat && git push", "switch"],
      [
        "a bare push after git add and commit",
        "git add -A && git commit -m m && git push",
        "switch",
      ],
      [
        "a bare push after git symbolic-ref in the same call",
        "git symbolic-ref HEAD refs/heads/feat && git push",
        "switch",
      ],
      [
        "a bare push after git branch -m in the same call",
        "git branch -m feat && git push",
        "switch",
      ],
      [
        "xargs appending a gh api endpoint to a write",
        "echo repos/quillco/acme-skills/git/refs | xargs gh api -X POST",
      ],
      [
        "xargs appending a gh api endpoint to a write with -X in a flag group",
        "echo repos/quillco/acme-skills/git/refs/heads/main | xargs gh api -iXDELETE",
      ],
      [
        "xargs -I placing gh pr merge's pull request",
        `echo ${EXT}/pull/1 | xargs -I{} gh pr merge {}`,
      ],
      ["xargs appending a push's URL", `echo ${EXT} main | xargs git push`],
      [
        "xargs -I placing a curl URL",
        "echo https://api.github.com/repos/quillco/acme-skills/contents/x | xargs -I{} curl -X PUT -d x {}",
      ],
      [
        "xargs -I placing a receive-pack URL",
        `echo ${EXT}.git/git-receive-pack | xargs -I{} curl -X POST --data-binary @p {}`,
      ],
      [
        "a push behind nesting too deep to read",
        `${"eval ".repeat(300)}git push origin main`,
        "ext",
      ],
      [
        "gh repo delete behind nesting too deep to read",
        `${"eval ".repeat(300)}gh repo delete --yes`,
        "ext",
      ],
      [
        "an ANSI-quoted git behind nesting too deep to read",
        `${"eval ".repeat(300)}$'\\x67it' push origin main`,
        "ext",
      ],
      [
        "a backslashed git behind nesting too deep to read",
        `${"eval ".repeat(300)}g\\it push origin main`,
        "ext",
      ],
      [
        "xargs -I placing a curl URL that writes",
        "echo https://example.com | xargs -I{} curl -X POST -d x {}",
      ],
      ["xargs appending a send-pack URL", `echo ${EXT} main | xargs git send-pack`],
      [
        "xargs appending gh repo delete's repository",
        "echo quillco/acme-skills | xargs gh repo delete --yes",
      ],
      ["xargs appending -R's value", "echo quillco/acme-skills | xargs gh pr merge 1 -R"],
      [
        "xargs appending a gh api endpoint",
        "echo repos/quillco/acme-skills/git/refs | xargs gh api -X POST -f ref=x -f sha=y",
      ],
      [
        "xargs appending a curl URL",
        "echo https://api.github.com/repos/quillco/acme-skills/contents/x | xargs curl -X PUT -d x",
      ],
    ]),
  )("%s", async (_, command, dir) => {
    await refused(bash(command, at(dir)))
  })

  test.each(
    rows([
      [
        "set-url --push, then a push",
        `git remote set-url --push origin ${EXT} && git push origin main`,
      ],
      ["set-url, then a push with no remote", `git remote set-url origin ${EXT} && git push`],
      [
        "set-url behind git -C with a subcommand for its value, then a push",
        `git -C remote remote set-url --push origin ${EXT} && git push origin HEAD:main`,
      ],
      [
        "config pushurl, then a push",
        `git config remote.origin.pushurl ${EXT}; git push origin main`,
      ],
      [
        "config pushInsteadOf, then a push",
        `git config url.${EXT}.pushInsteadOf ${OTHER} && git push origin main`,
      ],
      ["config set alias, then the alias", `git config alias.zz push && git zz ${EXT} main`],
      [
        "a config write ending in list, then the alias",
        `git config alias.p push list && git p ${EXT} main`,
      ],
      [
        "a config write ending in get, then a push",
        `git config remote.origin.pushurl ${EXT} get && git push origin main`,
      ],
      [
        "git config set, then a push",
        `git config set remote.origin.pushurl ${EXT} && git push origin main`,
      ],
      ["git config edit, then a push", "git config edit && git push origin main"],
      [
        "remote -v set-url, then a push",
        `git remote -v set-url --push origin ${EXT} && git push origin main`,
      ],
      [
        "an alias written to .git/config, then the alias",
        `printf '[alias] zz = push' >> .git/config && git zz ${EXT} main`,
      ],
      [
        "remote add and set-default, then gh pr merge",
        `git remote add e ${EXT} && gh repo set-default quillco/acme-skills && gh pr merge 1 --squash`,
      ],
      [
        "gh repo set-default, then gh repo edit",
        "gh repo set-default quillco/acme-skills && gh repo edit --visibility public",
      ],
      [
        "a clone into a folder, then git -C",
        `git clone ${EXT} empty && git -C empty push origin HEAD:main`,
      ],
      [
        "a clone into a folder, then cd",
        `git clone ${EXT} empty && cd empty && git push origin HEAD:main`,
      ],
      ["gh repo clone, then cd", "gh repo clone quillco/acme-skills empty && cd empty && git push"],
    ]),
  )("a state change earlier in the call: %s", async (_, command, dir) => {
    const reason = await refused(bash(command, at(dir)))
    expect(reason).toContain("in a call of its own first")
  })

  test("N3: the local path refusal names the fix", async () => {
    const reason = await refused(bash("git push origin main", dirs.local))
    expect(reason).toContain("a local path")
    expect(reason).toContain("in a call of its own")
  })

  test("B2: the refusal says to run the push plainly", async () => {
    const reason = await refused(bash("GIT_DIR=/x/.git git push origin main"))
    expect(reason).toContain("with no -c, --config-env, --git-dir or GIT_ variable")
  })
})

describe("B5: making a repository at a guarded name is refused", () => {
  test.each(
    rows([
      ["gh repo create", "gh repo create quillco/playground-notes --private"],
      ["gh repo create under the signed-in account", "gh repo create acme-skills --private -d x"],
      [
        "gh repo create from a --source folder",
        "gh repo create --source=. --private --push",
        "named",
      ],
      ["gh repo create with a name it cannot read", `gh repo create "$N" --private`],
      ["gh repo rename", "gh repo rename playground-notes -R quillco/other --yes"],
      ["gh repo fork --fork-name", "gh repo fork acme/tools --fork-name playground-notes"],
      [
        "gh repo fork --fork-name --org",
        "gh repo fork acme/tools --org quillco --fork-name acme-skills",
      ],
      ["gh api PATCH with a name", "gh api -X PATCH repos/quillco/other -f name=playground-notes"],
      [
        "gh api generate",
        "gh api -X POST repos/acme/tools/generate -f owner=quillco -f name=acme-skills",
      ],
      [
        "gh api transfer",
        "gh api -X POST repos/quillco/other/transfer -f new_owner=quillco -f new_name=acme-skills",
      ],
      [
        "gh api forks with a name",
        "gh api -X POST repos/acme/tools/forks -f name=playground-notes",
      ],
      ["gh api user/repos", "gh api -X POST user/repos -f name=playground-notes"],
      ["gh api orgs/<org>/repos", "gh api -X POST orgs/quillco/repos -f name=acme-skills"],
      ["gh api with a name it cannot read", `gh api -X POST user/repos -f name="$N"`],
    ]),
  )("%s", async (_, command, dir) => {
    await refused(bash(command, at(dir)))
  })

  test.each([[{ name: "playground-notes" }], [{ name: "acme-skills", organization: "quillco" }]])(
    "the GitHub MCP's create_repository %j",
    async (input) => {
      await refused(tool("create_repository", input))
    },
  )

  test.each(
    rows([
      ["gh repo create at another name", "gh repo create quillco/new-thing --private"],
      [
        "gh repo create from a template",
        "gh repo create quillco/new-thing --template quillco/acme-skills",
      ],
      ["gh repo fork at another name", "gh repo fork acme/tools --fork-name tools-2"],
      ["gh api PATCH with no name", "gh api -X PATCH repos/quillco/other -f description=x"],
      ["gh api user/repos at another name", "gh api -X POST user/repos -f name=new-thing"],
    ]),
  )("%s passes", async (_, command, dir) => {
    expect(await run(bash(command, at(dir)))).toBeUndefined()
    expect(await run(tool("create_repository", { name: "new-thing" }))).toBeUndefined()
  })
})

describe("a start folder reached through a link reads as the clone it links to", () => {
  test("a push from a link to a guarded clone is refused, and a read or a push from a link to another clone runs", async () => {
    await symlink(dirs.ext, join(scratch, "link-ext"))
    await symlink(dirs.other, join(scratch, "link-other"))
    expect(await run(bash("git push origin HEAD:main", join(scratch, "link-ext")))).toContain(
      "no-extension-repo-write hook refused",
    )
    expect(await run(bash("git log -1", join(scratch, "link-other")))).toBeUndefined()
    expect(
      await run(bash("git push origin HEAD:main", join(scratch, "link-other"))),
    ).toBeUndefined()
  })
})

describe("a push of branches other than the default passes, and every other push stays refused", () => {
  test.each(
    rows([
      ["a branch by remote name", "git push origin HEAD:feature", "ext"],
      ["a branch by its own name with -u", "git push -u origin feature", "ext"],
      ["a branch by URL", `git push ${EXT} HEAD:feature`],
      ["a branch by its full ref", "git push origin HEAD:refs/heads/feature", "ext"],
      ["a force-push to a branch", "git push --force-with-lease origin HEAD:feature", "ext"],
      ["a force-push to a branch by +", "git push origin +HEAD:feature", "ext"],
      ["main when the remote's HEAD names another branch", "git push origin HEAD:main2", "trunk"],
      ["the merge gate", "bun run ext:merge quillco/acme-skills 3"],
      ["a draft marked ready", "gh pr ready 3 -R quillco/acme-skills"],
    ]),
  )("%s", async (_, command, dir) => {
    expect(await run(bash(command, at(dir)))).toBeUndefined()
  })

  test.each(
    rows([
      ["the default by remote name", "git push origin main", "ext"],
      ["the default by HEAD:main", "git push origin HEAD:main", "ext"],
      ["the default by its full ref", "git push origin HEAD:refs/heads/main", "ext"],
      ["the default by heads/", "git push origin HEAD:heads/main", "ext"],
      ["the default in another case", "git push origin HEAD:Main", "ext"],
      ["master", `git push ${EXT} HEAD:master`],
      ["the remote's HEAD branch", "git push origin HEAD:trunk", "trunk"],
      ["a force-push to the default", `git push -f ${EXT} HEAD:main`],
      ["one of two refspecs the default", "git push origin HEAD:feature HEAD:main", "ext"],
      ["HEAD with no destination", "git push origin HEAD", "ext"],
      ["HEAD as the destination", "git push origin feature:HEAD", "ext"],
      ["@ as the destination", "git push origin feature:@", "ext"],
      ["a remote with no refspec", "git push origin", "ext"],
      ["a bare push in a clone", "git push -u", "ext"],
      ["a local tag by its name", "git push origin v1", "tagged"],
      ["a tag ref", "git push origin HEAD:refs/tags/v1", "ext"],
      ["the tag keyword", "git push origin tag v1", "ext"],
      ["--tags", "git push --tags origin HEAD:feature", "ext"],
      ["--follow-tags", "git push --follow-tags origin HEAD:feature", "ext"],
      ["--all", "git push --all origin", "ext"],
      ["--delete of a branch", "git push --delete origin feature", "ext"],
      ["a delete by an empty source", "git push origin :feature", "ext"],
      ["a glob", "git push origin 'refs/heads/*:refs/heads/*'", "ext"],
      ["--repo", "git push --repo=origin origin HEAD:feature", "ext"],
      ["a push option", "git push -o x origin HEAD:feature", "ext"],
      ["a refspec in a variable", "git push origin $B", "ext"],
      ["a remote whose push refspec remaps", "git push origin feature", "mapped"],
      [
        "a branch after a remote added in the call",
        `git remote add e ${EXT} && git push e HEAD:feature`,
      ],
      ["a branch with -c", "git -c k=v push origin HEAD:feature", "ext"],
      ["send-pack of a branch", `git send-pack ${EXT} feature`],
      ["subtree push of a branch", `git subtree push --prefix=x ${EXT} feature`],
    ]),
  )("%s is refused", async (_, command, dir) => {
    const reason = await refused(bash(command, at(dir)))
    expect(reason).toContain("bun run ext:merge <owner>/<repo> <n>")
  })
})

// A commit changes only the local clone, so in a guarded repository's clone it passes on a branch the push rule lets through, and nothing that could move HEAD or where git writes rides on the call.
describe("a commit on a branch other than the default passes, and every other commit in a guarded clone stays refused", () => {
  test.each(
    rows([
      ["a commit on a branch", "git commit -m x", "feature"],
      ["a commit -a on a branch", "git commit -a -m x", "feature"],
      ["an amend on a branch", "git commit --amend --no-edit", "feature"],
    ]),
  )("%s", async (_, command, dir) => {
    expect(await run(bash(command, at(dir)))).toBeUndefined()
  })

  test.each(
    rows([
      ["a commit on the default", "git commit -m x", "ext"],
      ["a commit on the remote's HEAD branch", "git commit -m x", "trunkhead"],
      ["a commit on a detached HEAD", "git commit -m x", "detached"],
      ["a commit with -c on a branch", "git -c user.name=x commit -m x", "feature"],
      ["a commit with --git-dir on a branch", "git --git-dir=.git commit -m x", "feature"],
      ["a commit with a GIT_ variable on a branch", "GIT_DIR=.git git commit -m x", "feature"],
      ["a commit after a switch to the default", "git switch main && git commit -m x", "feature"],
      ["a commit after a checkout in the call", "git checkout -q main; git commit -m x", "feature"],
      ["a commit after gh in the call", "gh repo set-default x && git commit -m x", "feature"],
      ["a commit after git add in the call", "git add -A && git commit -m x", "feature"],
    ]),
  )("%s is refused", async (_, command, dir) => {
    await refused(bash(command, at(dir)))
  })

  test("a commit's refusal names the commit route", async () => {
    expect(await refused(bash("git commit -m x", at("ext")))).toContain(
      "on a branch other than the default, as a git commit call of its own",
    )
  })
})

describe("what it lets through", () => {
  test.each(
    rows([
      ["a push to another repository", "git push origin feature"],
      [
        "a config read, then a push",
        "git config --get remote.origin.url && git push origin feature",
      ],
      ["a config read by key, then a push", "git config user.name && git push origin feature"],
      [
        "git config get, then a push",
        "git config get remote.origin.url && git push origin feature",
      ],
      ["git config list, then a push", "git config list && git push origin feature"],
      ["a remote listed, then a push", "git remote -v && git push origin feature"],
      ["a push, then a config write", "git push origin feature && git config x.y z"],
      ["a bare push when remote.pushDefault names a remote", "git push", "pdname"],
      [
        "gh api :owner/:repo on issues from the clone",
        "gh api -X POST repos/:owner/:repo/issues -f title=x",
        "ext",
      ],
      ["curl with a glob to another host", "curl -X POST -d x 'http://localhost:3000/x/{a,b}'"],
      ["curl to a loopback IPv6 address", "curl -X POST -d x 'http://[::1]:3000/x'"],
      [
        "curl with a {} glob and -g",
        "curl -g -X POST -d x 'https://api.github.com/repos/acme/tools/issues/{1}'",
      ],
      ["a push by URL to another repository", `git push ${OTHER} feature`],
      ["a literal URL no rewrite matches", `git push ${OTHER} main`, "instead"],
      ["a commit in another clone", "git commit -m 'Fix the export'"],
      ["a commit in a clone whose remote is a local path", "git commit -m x", "local"],
      ["a GIT_ variable on a commit", "GIT_EDITOR=true git commit --amend --no-edit"],
      ["a git alias that only reads", "git l", "alias"],
      ["xargs appending files to git add", "echo a b | xargs git add"],
      ["a bare push with a stale remote on another branch", "git push", "stale"],
      ["a bare push after a command that is not git", "ls && git push", "stale"],
      [
        "a push to a named remote after git switch",
        "git switch -c feat && git push -u origin feat",
        "switch",
      ],
      ["xargs appending a gh api read", "echo repos/acme/tools | xargs gh api"],
      [
        "xargs appending pull requests to merge in another repository's clone",
        "gh pr list --json number -q '.[].number' | xargs -n1 gh pr merge --squash",
      ],
      ["git absorb in a checkout the hook cannot read", "cd $X && git absorb"],
      ["git -C absorb in a checkout the hook cannot read", "git -C $X absorb"],
      [
        "xargs -I placing a curl URL it only reads",
        "echo https://example.com | xargs -I{} curl -sL {}",
      ],
      ["gh pr merge by a variable in another repository's clone", "gh pr merge $N"],
      [
        "gh pr merge by a variable with -R another repository",
        "gh pr merge $N -R acme/tools",
        "ext",
      ],
      ["gh api GET", `gh api ${A}/contents/x.md`],
      ["gh api HEAD", `gh api -X HEAD ${A}/contents/x.md`],
      ["gh api GET of repositories/<id>", "gh api repositories/123"],
      ["gh repo view", "gh repo view quillco/acme-skills"],
      ["gh repo clone", "gh repo clone quillco/acme-skills"],
      ["gh repo fork", "gh repo fork quillco/acme-skills --clone=false"],
      ["gh repo sync with no destination", "gh repo sync", "ext"],
      ["gh pr merge on another repository", "gh pr merge 1 -R acme/tools"],
      [
        "gh api PUT on another repository",
        "gh api -X PUT repos/acme/tools/contents/x -f message=m",
      ],
      [
        "curl to another repository",
        "curl -X PUT -d x https://api.github.com/repos/acme/tools/contents/x",
      ],
      [
        "curl to another repository on github.com",
        "curl -X POST -d x https://github.com/acme/tools",
      ],
      [
        "curl to a URL it cannot read",
        `curl -sS -X POST -H "Origin: $WEB" "$API/api/agents/sign-in-as"`,
      ],
      [
        "a GraphQL mutation that names no repository",
        `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "P_1"}) { clientMutationId } }'`,
      ],
      [
        "N3: a GraphQL mutation naming a longer name",
        `gh api graphql -f query='mutation { x(input: {repo: "quillco/acme-skills-archive"}) { y } }'`,
      ],
      [
        "N3: playground ext put of a doc",
        "playground ext put quillco doc plan-x /tmp/x.md --reason y",
      ],
    ]),
  )("%s", async (_, command, dir) => {
    expect(await run(bash(command, at(dir)))).toBeUndefined()
  })

  test("N3: a GraphQL mutation naming an extension repository is refused", async () => {
    await refused(
      bash(`gh api graphql -f query='mutation { x(input: {repo: "quillco/acme-skills"}) { y } }'`),
    )
  })

  test("the GitHub MCP's reads", async () => {
    const input = { owner: "quillco", path: "x.md", repo: "acme-skills" }
    expect(await run(tool("get_file_contents", input))).toBeUndefined()
  })
})

describe("B7: issue and pull request conversation on an extension repository passes", () => {
  const R = "-R quillco/acme-skills"
  test.each(
    rows([
      ["gh issue create", `gh issue create ${R} -t x -b y`],
      ["gh issue comment", `gh issue comment 1 ${R} -b y`],
      ["gh issue close", `gh issue close 1 ${R}`],
      ["gh label create", `gh label create bug ${R}`],
      ["gh pr create", `gh pr create ${R} -t x -b y -H topic`],
      ["gh pr comment", `gh pr comment 1 ${R} -b y`],
      ["gh pr edit", `gh pr edit 1 ${R} -t x`],
      ["gh pr review", `gh pr review 1 ${R} --approve`],
      ["gh pr close", `gh pr close 1 ${R}`],
      ["gh pr reopen", `gh pr reopen 1 ${R}`],
      ["gh issue comment in a clone", "gh issue comment 1 -b y", "ext"],
      ["gh api on issues", `gh api -X POST ${A}/issues -f title=x`],
      ["gh api on an issue's comments", `gh api -X POST ${A}/issues/1/comments -f body=x`],
      ["gh api on labels", `gh api -X POST ${A}/labels -f name=x`],
      ["gh api on pulls", `gh api -X POST ${A}/pulls -f title=x -f head=b -f base=main`],
      ["gh api PATCH on a pull request", `gh api -X PATCH ${A}/pulls/1 -f title=x`],
      ["xargs appending an issue comment's body", `echo y | xargs gh issue comment 1 ${R} -b`],
    ]),
  )("%s", async (_, command, dir) => {
    expect(await run(bash(command, at(dir)))).toBeUndefined()
  })

  test.each(["add_issue_comment", "issue_write", "create_pull_request", "update_pull_request"])(
    "the GitHub MCP's %s",
    async (name) => {
      const input = { body: "x", owner: "quillco", repo: "acme-skills" }
      expect(await run(tool(name, input))).toBeUndefined()
    },
  )
})

describe("the repositories it guards", () => {
  test("N2: the default names under both the environment's login and the login file's", async () => {
    const other = { PLAYGROUND_LOGIN: "zedco" }
    await refused(bash("git push https://github.com/zedco/playground-notes main"), stored, other)
    await refused(bash(`git push ${NOTES} main`), stored, other)
    expect(
      await run(bash("git push https://github.com/zedco/playground-acme main"), stored, other),
    ).toBeUndefined()
  })

  test("a scope ext.repos names is not guarded under its default name", async () => {
    expect(
      await run(bash("git push https://github.com/quillco/playground-acme main")),
    ).toBeUndefined()
  })

  test("with no extensions root every call passes", async () => {
    const bare = join(scratch, "bare")
    await mkdir(bare, { recursive: true })
    for (const [, command, dir] of rows(REFUSED))
      expect(await run(bash(command, at(dir)), bare)).toBeUndefined()
  })
})

describe("an alias in a config the hook can read", () => {
  test("git absorb, aliased to push in the global config, is refused in a checkout the hook cannot read", async () => {
    const global = join(scratch, "global.gitconfig")
    await writeFile(global, "[alias]\n\tabsorb = push\n")
    const before = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = global
    try {
      await refused(bash("cd $X && git absorb"))
      await refused(bash("git -C $X absorb"))
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before
    }
  })
})

describe("it fails closed", () => {
  test("a call still being read at its deadline is refused", async () => {
    const command = `${"git push origin; ".repeat(50)}ls`
    expect(await run(bash(command))).toBeUndefined()
    const reason = await check(bash(command), env(stored), 1)
    expect(reason).toContain("no-extension-repo-write hook refused")
  })

  test("a policy.json that does not parse refuses a write, and a read passes", async () => {
    const broken = await store("broken", {}, "quillco")
    await writeFile(join(broken, "extensions", "policy.json"), "{")
    await refused(bash(`git push ${OTHER} main`), broken)
    await refused(bash("gh api -X DELETE repos/acme/app/git/refs/heads/x"), broken)
    for (const read of ["ls", "cat x.md", "git log -1", "gh issue list -R acme/app"])
      expect(await run(bash(read), broken)).toBeUndefined()
  })

  test("a root with no login refuses a write, and a read passes", async () => {
    const nameless = await store("nameless", {})
    const reason = await refused(bash(`git push ${OTHER} main`), nameless)
    expect(reason).toContain("playground ext init")
    for (const read of ["ls", "cat x.md"]) expect(await run(bash(read), nameless)).toBeUndefined()
  })
})
