import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeRoot } from "../../../packages/settings/src/folder"
import { extensionsDir } from "../../../packages/settings/src/rendered"
import { check, heavy, onGlm, refusal } from "../../../scripts/hooks/no-glm-heavy-path"
import { storeWith } from "./render-set"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-glm-heavy-path.ts")
const DIR = mkdtempSync(join(tmpdir(), "glm-heavy-"))
const REPO = join(DIR, "repo")
const REMOTE = join(DIR, "remote.git")
const GLM = { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }

// nothing from this machine's git settings: git exports GIT_DIR into hooks, and a global hooksPath or signing would reach outside the scratch repo
const GIT_ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
    ),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

const git = (cwd: string, ...args: string[]) => {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: GIT_ENV, stdin: "ignore" },
  )
  expect(proc.exitCode).toBe(0)
}
const write = (path: string, text = "x\n") => Bun.write(join(REPO, path), text)

const input = (command: string, cwd = REPO, session = "s-glm") =>
  JSON.stringify({
    cwd,
    hook_event_name: "PreToolUse",
    session_id: session,
    tool_input: { command },
    tool_name: "Bash",
  })
// a calm machine, so a path rule reads alone; the load rule's own tests name their load
const CALM = 1
const bash = (command: string, cwd = REPO) => check(input(command, cwd), GLM, CALM)
const slot = "~/.playground/ops/run-slot.sh worker-x --"

// a scratch repo with a pushed base: a clone of a bare remote, so a push's range is what the remote lacks
beforeAll(async () => {
  git(DIR, "init", "-q", "--bare", "-b", "canary", REMOTE)
  git(DIR, "clone", "-q", REMOTE, REPO)
  await write("docs/a.md")
  await write("web/next/src/a.ts")
  git(REPO, "add", ".")
  git(REPO, "commit", "-q", "-m", "base")
  git(REPO, "push", "-q", "origin", "HEAD:canary")
})

afterAll(() => rmSync(DIR, { force: true, recursive: true }))

describe("the Opus paths", () => {
  test.each([
    { label: "a web file", path: "web/next/src/x.ts", want: true },
    { label: "a hook", path: "scripts/hooks/no-stash.ts", want: true },
    { label: "spawn.sh", path: "scripts/spawn.sh", want: true },
    { label: "the merge gates", path: "packages/scripts/src/pr-merge/merge.ts", want: true },
    { label: "verify", path: "packages/scripts/src/verify/cli.ts", want: true },
    { label: "a workflow", path: ".github/workflows/test.yml", want: true },
    { label: "lefthook.yml", path: "lefthook.yml", want: true },
    { label: "a doc", path: "docs/x.md", want: false },
    { label: "a skill", path: "skills/playground/x/SKILL.md", want: false },
    { label: "another script", path: "packages/scripts/src/env-keys.ts", want: false },
    { label: "a file beside spawn.sh", path: "scripts/spawn.sh.bak", want: false },
    { label: "a folder named like web/next", path: "web/nextra/x.ts", want: false },
  ])("$label", ({ path, want }) => {
    expect(heavy(path)).toBe(want)
  })
})

describe("a GLM session's commit", () => {
  test("staging a web file is refused, naming the file and the fix", async () => {
    await write("web/next/src/x.ts")
    git(REPO, "add", "web/next/src/x.ts")
    const reason = await bash("git commit -m 'feat: x'")
    expect(reason).toContain("web/next/src/x.ts")
    expect(reason).toContain("report to your lead with this file list")
    git(REPO, "reset", "-q", "HEAD", "web/next/src/x.ts")
  })

  test("staging a doc alone passes", async () => {
    await write("docs/x.md")
    git(REPO, "add", "docs/x.md")
    expect(await bash("git commit -m 'docs: x'")).toBeUndefined()
    expect(await bash(`git -C ${REPO} commit -m 'docs: x'`, DIR)).toBeUndefined()
    git(REPO, "reset", "-q", "HEAD", "docs/x.md")
  })

  test("-a and a named path commit tracked changes that are not staged", async () => {
    await write("web/next/src/a.ts", "changed\n")
    expect(await bash("git commit -m x")).toBeUndefined()
    expect(await bash("git commit -am x")).toContain("web/next/src/a.ts")
    expect(await bash("git commit --all -m x")).toContain("web/next/src/a.ts")
    expect(await bash("git commit web/next/src/a.ts -m x")).toContain("web/next/src/a.ts")
    expect(await bash("git commit docs/a.md -m x")).toBeUndefined()
    git(REPO, "checkout", "-q", "--", "web/next/src/a.ts")
  })

  test("a file list it cannot read is refused", async () => {
    expect(await bash('git -C "$NOWHERE" commit -m x')).toContain("cannot read")
    expect(await bash("git commit -m x", DIR)).toContain("cannot read the files it commits")
    expect(await bash("git commit --pathspec-from-file=list.txt -m x")).toContain(
      "cannot read the paths --pathspec-from-file names",
    )
  })

  test("a global option that takes a value, --config-env included, is stepped over", async () => {
    await write("web/next/src/x.ts", "config\n")
    git(REPO, "add", "web/next/src/x.ts")
    expect(await bash("git --config-env core.x=HOME commit -m x")).toContain("web/next/src/x.ts")
    expect(await bash("git -c core.x=y commit -m x")).toContain("web/next/src/x.ts")
    git(REPO, "reset", "-q", "HEAD", "web/next/src/x.ts")
  })

  test("git in capitals is read as git, since macOS runs it", async () => {
    await write("web/next/src/x.ts", "caps\n")
    git(REPO, "add", "web/next/src/x.ts")
    expect(await bash("GIT commit -m x")).toContain("web/next/src/x.ts")
    git(REPO, "reset", "-q", "HEAD", "web/next/src/x.ts")
  })

  // a GLM worker merging canary in and resolving a conflict commits canary's files as they stand, which are not its work
  test("concluding a merge lists only what differs from both sides: canary's files pass, a hand edit is refused", async () => {
    const dir = join(DIR, "merging")
    const put = (path: string, text: string) => Bun.write(join(dir, path), text)
    git(DIR, "init", "-q", "-b", "canary", dir)
    await put("docs/a.md", "base\n")
    await put("web/next/c.ts", "base\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "checkout", "-q", "-b", "feat")
    await put("docs/a.md", "feat\n")
    git(dir, "commit", "-q", "-am", "feat")
    git(dir, "checkout", "-q", "canary")
    await put("docs/a.md", "canary\n")
    await put("web/next/c.ts", "canary\n")
    git(dir, "commit", "-q", "-am", "canary")
    git(dir, "checkout", "-q", "feat")
    const conflicted = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "canary"],
      {
        cwd: dir,
        env: GIT_ENV,
        stderr: "ignore",
        stdout: "ignore",
      },
    )
    expect(conflicted.exitCode).toBe(1)
    await put("docs/a.md", "both\n")
    git(dir, "add", "docs/a.md")
    expect(await bash("git commit --no-edit", dir)).toBeUndefined()
    expect(await bash("git commit -a --no-edit", dir)).toBeUndefined()
    await put("web/next/c.ts", "a hand edit\n")
    git(dir, "add", "web/next/c.ts")
    expect(await bash("git commit --no-edit", dir)).toContain("web/next/c.ts")
  })

  // a fresh repo whose canary changes web/next/c.ts and whose feat changes a doc, so the two merge clean; other changes web/next/e.ts
  const sides = async (name: string) => {
    const dir = join(DIR, name)
    const put = (path: string, text: string) => Bun.write(join(dir, path), text)
    git(DIR, "init", "-q", "-b", "canary", dir)
    await put("docs/a.md", "base\n")
    await put("web/next/c.ts", "base\n")
    await put("web/next/e.ts", "base\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "checkout", "-q", "-b", "other")
    await put("web/next/e.ts", "other\n")
    git(dir, "commit", "-q", "-am", "other")
    git(dir, "checkout", "-q", "-b", "feat", "canary")
    await put("docs/a.md", "feat\n")
    git(dir, "commit", "-q", "-am", "feat")
    git(dir, "checkout", "-q", "canary")
    await put("web/next/c.ts", "canary\n")
    git(dir, "commit", "-q", "-am", "canary")
    git(dir, "checkout", "-q", "feat")
    return dir
  }

  test("concluding a merge that keeps our copy of a file canary changed is refused, since the squash would revert canary's change", async () => {
    const dir = await sides("keeping")
    git(dir, "merge", "-q", "--no-commit", "--no-ff", "canary")
    expect(await bash("git commit --no-edit", dir)).toBeUndefined()
    git(dir, "checkout", "HEAD", "--", "web/next/c.ts")
    expect(await bash("git commit --no-edit", dir)).toContain("web/next/c.ts")
  })

  test("an octopus merge reads every side it brings in", async () => {
    const dir = await sides("octopus")
    git(dir, "merge", "-q", "--no-commit", "--no-ff", "canary", "other")
    expect(await bash("git commit --no-edit", dir)).toBeUndefined()
    git(dir, "checkout", "HEAD", "--", "web/next/e.ts")
    const reason = await bash("git commit --no-edit", dir)
    expect(reason).toContain("web/next/e.ts")
    expect(reason).not.toContain("web/next/c.ts")
  })

  test("a first commit, with no HEAD yet, is read against the empty tree", async () => {
    const dir = join(DIR, "first")
    git(DIR, "init", "-q", dir)
    await Bun.write(join(dir, "docs/a.md"), "x\n")
    git(dir, "add", ".")
    expect(await bash("git commit -m first", dir)).toBeUndefined()
    await Bun.write(join(dir, "web/next/a.ts"), "x\n")
    git(dir, "add", ".")
    expect(await bash("git commit -m first", dir)).toContain("web/next/a.ts")
  })
})

describe("a GLM session's push", () => {
  test("commits the remote lacks that touch spawn.sh are refused", async () => {
    await write("scripts/spawn.sh")
    git(REPO, "add", "scripts/spawn.sh")
    git(REPO, "commit", "-q", "-m", "spawn")
    expect(await bash("git push")).toContain("scripts/spawn.sh")
    expect(await bash("git push origin HEAD:canary")).toContain("scripts/spawn.sh")
    expect(await bash("git push --all origin")).toContain("scripts/spawn.sh")
  })

  test("once the remote holds them, a push of a doc commit passes", async () => {
    git(REPO, "push", "-q", "origin", "HEAD:canary")
    await write("docs/b.md")
    git(REPO, "add", "docs/b.md")
    git(REPO, "commit", "-q", "-m", "doc")
    expect(await bash("git push")).toBeUndefined()
    expect(await bash("git push origin --delete old")).toBeUndefined()
  })

  test("refs it cannot read are refused", async () => {
    expect(await bash('git push origin "$BRANCH"')).toContain("cannot read the refs it pushes")
  })

  // a change made inside a merge commit lists under no file in plain git log --name-only
  test("a merge commit that adds a web file itself is refused; a clean merge passes", async () => {
    git(REPO, "push", "-q", "origin", "HEAD:canary")
    git(REPO, "checkout", "-q", "-b", "side")
    await write("docs/c.md")
    git(REPO, "add", "docs/c.md")
    git(REPO, "commit", "-q", "-m", "side")
    git(REPO, "checkout", "-q", "canary")
    git(REPO, "merge", "-q", "--no-ff", "--no-commit", "side")
    await write("web/next/evil.ts")
    git(REPO, "add", "web/next/evil.ts")
    git(REPO, "commit", "-q", "-m", "evil merge")
    expect(await bash("git push")).toContain("web/next/evil.ts")
    git(REPO, "reset", "-q", "--hard", "origin/canary")
    git(REPO, "merge", "-q", "--no-ff", "-m", "clean merge", "side")
    expect(await bash("git push")).toBeUndefined()
  })

  // git merge -s ours keeps our tree whole, so the squash would revert what the other side changed
  test("a merge commit that keeps our copy of a web file the other side changed is refused", async () => {
    git(REPO, "push", "-q", "origin", "HEAD:canary")
    git(REPO, "checkout", "-q", "-b", "ui")
    await write("web/next/src/a.ts", "ui work\n")
    git(REPO, "commit", "-q", "-am", "ui")
    git(REPO, "push", "-q", "origin", "ui")
    git(REPO, "checkout", "-q", "canary")
    git(REPO, "merge", "-q", "-s", "ours", "-m", "keep ours", "ui")
    expect(await bash("git push")).toContain("web/next/src/a.ts")
    git(REPO, "reset", "-q", "--hard", "origin/canary")
  })
})

// a GLM branch brings canary in after both sides changed spawn.sh: git merges the file by itself, so the result differs from each side yet holds no change of the GLM session's
describe("bringing canary in", () => {
  const lines = (edit: Record<number, string> = {}) =>
    Array.from({ length: 8 }, (_, i) => `${edit[i] ?? i}\n`).join("")
  // a pushed feat branch whose commit changed spawn.sh's first line, a canary that changed its last, and docs/a.md changed on both, so it conflicts
  const behind = async (name: string) => {
    const dir = join(DIR, name)
    const put = (path: string, text: string) => Bun.write(join(dir, path), text)
    git(DIR, "init", "-q", "--bare", "-b", "canary", `${dir}.git`)
    git(DIR, "clone", "-q", `${dir}.git`, dir)
    await put("docs/a.md", "base\n")
    await put("scripts/spawn.sh", lines())
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "push", "-q", "origin", "HEAD:canary")
    git(dir, "checkout", "-q", "-b", "feat")
    await put("docs/a.md", "feat\n")
    await put("scripts/spawn.sh", lines({ 0: "feat" }))
    git(dir, "commit", "-q", "-am", "feat")
    git(dir, "push", "-q", "origin", "feat")
    git(dir, "checkout", "-q", "canary")
    await put("docs/a.md", "canary\n")
    await put("scripts/spawn.sh", lines({ 7: "canary" }))
    git(dir, "commit", "-q", "-am", "canary")
    git(dir, "push", "-q", "origin", "canary")
    git(dir, "checkout", "-q", "feat")
    // git stops on docs/a.md's conflict, which the session resolves
    const stop = async (...args: string[]) => {
      const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: dir,
        env: GIT_ENV,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      })
      expect(proc.exitCode).not.toBe(0)
      await put("docs/a.md", "both\n")
      git(dir, "add", "docs/a.md")
    }
    const handEdit = async () => {
      await put("scripts/spawn.sh", lines({ 0: "feat", 3: "a hand edit", 7: "canary" }))
      git(dir, "add", "scripts/spawn.sh")
    }
    return { dir, handEdit, stop }
  }

  test("a merge whose only fenced change comes from canary passes", async () => {
    const { dir, stop } = await behind("bring-merge")
    await stop("merge", "-q", "origin/canary")
    expect(await bash("git commit --no-edit", dir)).toBeUndefined()
    git(dir, "commit", "-q", "--no-edit")
    expect(await bash("git push origin feat", dir)).toBeUndefined()
  })

  test("a merge whose resolution edits a fenced file is refused", async () => {
    const { dir, handEdit, stop } = await behind("bring-merge-edit")
    await stop("merge", "-q", "origin/canary")
    await handEdit()
    expect(await bash("git commit --no-edit", dir)).toContain("scripts/spawn.sh")
    git(dir, "commit", "-q", "--no-edit")
    expect(await bash("git push origin feat", dir)).toContain("scripts/spawn.sh")
  })

  test("a rebase whose only fenced change comes from canary passes", async () => {
    const { dir, stop } = await behind("bring-rebase")
    await stop("rebase", "-q", "origin/canary")
    git(dir, "-c", "core.editor=true", "rebase", "--continue")
    expect(await bash("git push --force-with-lease origin feat", dir)).toBeUndefined()
    expect(await bash("git push -f", dir)).toBeUndefined()
  })

  test("a rebase whose resolution edits a fenced file is refused", async () => {
    const { dir, handEdit, stop } = await behind("bring-rebase-edit")
    await stop("rebase", "-q", "origin/canary")
    await handEdit()
    git(dir, "-c", "core.editor=true", "rebase", "--continue")
    expect(await bash("git push --force-with-lease origin feat", dir)).toContain("scripts/spawn.sh")
    expect(await bash("git push -f", dir)).toContain("scripts/spawn.sh")
  })
})

// the hook reads the checkout before any part of the call runs, so a chain is judged only where that read covers what the chain will commit
describe("a chained commit or push", () => {
  const fresh = async (name: string) => {
    const dir = join(DIR, name)
    git(DIR, "init", "-q", "-b", "canary", dir)
    await Bun.write(join(dir, "docs/a.md"), "x\n")
    await Bun.write(join(dir, "web/next/a.ts"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    return dir
  }

  test("a commit after git add reads every change on disk, untracked files included", async () => {
    const dir = await fresh("chain-add")
    await Bun.write(join(dir, "web/next/new.ts"), "x\n")
    expect(await bash("git add -A && git commit -m m && git push", dir)).toContain(
      "web/next/new.ts",
    )
    expect(await bash("git add web/next/new.ts && git commit -m m", dir)).toContain(
      "web/next/new.ts",
    )
    await Bun.write(join(dir, "web/next/a.ts"), "an edit\n")
    expect(await bash("git status && git add -u && git commit -m m", dir)).toContain(
      "web/next/a.ts",
    )
  })

  // ls-files lists only the cwd and below, relative to it, unless told otherwise
  test("from a subfolder, a chained commit still reads every untracked file, by its full name", async () => {
    const dir = await fresh("chain-subfolder")
    await Bun.write(join(dir, "web/next/new.ts"), "x\n")
    const docs = join(dir, "docs")
    expect(await bash("git add -A && git commit -m m", docs)).toContain("web/next/new.ts")
    expect(
      await bash("git add ../web/next/new.ts && git commit -m m ../web/next/new.ts", docs),
    ).toContain("web/next/new.ts")
    expect(await bash("git add -A && git commit -m m a.md", docs)).toBeUndefined()
  })

  test("git add -f stages ignored files under the paths it names, so a commit after it reads those", async () => {
    const dir = await fresh("chain-forced")
    await Bun.write(join(dir, ".gitignore"), "gen/\n")
    await Bun.write(join(dir, "web/next/gen/x.ts"), "x\n")
    await Bun.write(join(dir, "docs/gen/x.md"), "x\n")
    expect(await bash("git add -A && git commit -m m", dir)).toBeUndefined()
    expect(await bash("git add -f docs/gen/x.md && git commit -m m", dir)).toBeUndefined()
    expect(await bash("git add -f . && git commit -m m", join(dir, "docs"))).toBeUndefined()
    expect(
      await bash("git add -f :/web/next/gen/x.ts && git commit -m m", join(dir, "docs")),
    ).toContain("web/next/gen/x.ts")
    for (const command of [
      "git add -f web/next/gen/x.ts && git commit -m m",
      "git add -fA && git commit -m m",
      "git add --fo -A && git commit -m m",
      "git add --f web/next/gen/x.ts && git commit -m m",
      "git add -f ':(glob)web/next/gen/*' && git commit -m m",
    ])
      expect(await bash(command, dir)).toContain("web/next/gen/x.ts")
  })

  // git quotes and escapes such a path in its line output, which then matches no Opus path
  test("a path holding a non-ASCII byte is read as it is, staged or untracked", async () => {
    const dir = await fresh("chain-cafe")
    await Bun.write(join(dir, "web/next/café.ts"), "x\n")
    expect(await bash("git add -A && git commit -m m", dir)).toContain("web/next/café.ts")
    git(dir, "add", "web/next/café.ts")
    expect(await bash("git commit -m m", dir)).toContain("web/next/café.ts")
  })

  test("an Opus file on disk that nothing staged yet gets the chain's fix; a staged one gets the lead's", async () => {
    const dir = await fresh("chain-stray")
    await Bun.write(join(dir, "docs/b.md"), "x\n")
    await Bun.write(join(dir, "web/next/stray.ts"), "x\n")
    const stray = await bash("git add docs/b.md && git commit -m m", dir)
    expect(stray).toContain("web/next/stray.ts is on disk and not staged")
    expect(stray).toContain("Run git commit as its own call")
    expect(stray).not.toContain("report to your lead")
    git(dir, "add", "web/next/stray.ts")
    expect(await bash("git add docs/b.md && git commit -m m", dir)).toContain("report to your lead")
  })

  test("a commit after git add passes when nothing on disk is Opus work, and cd never chains", async () => {
    const dir = await fresh("chain-doc")
    await Bun.write(join(dir, "docs/b.md"), "x\n")
    expect(await bash("git add -A && git commit -m m", dir)).toBeUndefined()
    expect(await bash(`cd ${dir} && git commit -m m`, DIR)).toBeUndefined()
  })

  let others = 0
  test.each([
    "sed -i '' s/x/y/ web/next/a.ts && git commit -a -m m",
    "touch x; git commit -m m",
    "git rm -q web/next/a.ts && git commit -m m",
    "git commit -m a && git commit -m b",
  ])("a commit after a command that may make the change is refused: %s", async (command) => {
    const dir = await fresh(`chain-other-${others++}`)
    expect(await bash(command, dir)).toContain(
      "Run git commit as its own call, or after git add alone",
    )
  })

  // Claude Code's own commit shape: the reader visits the message's cat before the commit
  const heredoc = "git commit -m \"$(cat <<'EOF'\ndocs: a note\n\nIts body.\nEOF\n)\""

  test("a commit message built by cat, printf or echo does not chain", async () => {
    const dir = await fresh("chain-message")
    await Bun.write(join(dir, "docs/b.md"), "x\n")
    git(dir, "add", "docs/b.md")
    expect(await bash(heredoc, dir)).toBeUndefined()
    expect(await bash('git commit -m "$(printf x)"', dir)).toBeUndefined()
    expect(await bash('git commit -m "$(echo x) $(date)"', dir)).toBeUndefined()
    await Bun.write(join(dir, "docs/c.md"), "x\n")
    expect(await bash(`git add -A && ${heredoc}`, dir)).toBeUndefined()
  })

  test("a web file staged before a heredoc commit is still refused, and a redirect chains", async () => {
    const dir = await fresh("chain-message-web")
    await Bun.write(join(dir, "web/next/b.ts"), "x\n")
    git(dir, "add", "web/next/b.ts")
    expect(await bash(heredoc, dir)).toContain("web/next/b.ts")
    expect(await bash("echo y > web/next/a.ts && git commit -a -m m", dir)).toContain(
      "Run git commit as its own call",
    )
  })

  test("a push with --follow-tags still pushes the branch, so its commits are read", async () => {
    const dir = join(DIR, "push-tags")
    git(DIR, "init", "-q", "--bare", "-b", "canary", `${dir}.git`)
    git(DIR, "clone", "-q", `${dir}.git`, dir)
    await Bun.write(join(dir, "docs/a.md"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "push", "-q", "origin", "HEAD:canary")
    await Bun.write(join(dir, "web/next/a.ts"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "web")
    expect(await bash("git push --follow-tags", dir)).toContain("web/next/a.ts")
    expect(await bash("git push origin --follow-tags", dir)).toContain("web/next/a.ts")
  })

  test("a push naming its ref by a read of the current branch pushes HEAD; any other built ref gets the literal fix", async () => {
    const dir = join(DIR, "push-branch")
    git(DIR, "init", "-q", "--bare", "-b", "canary", `${dir}.git`)
    git(DIR, "clone", "-q", `${dir}.git`, dir)
    await Bun.write(join(dir, "docs/a.md"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "push", "-q", "origin", "HEAD:canary")
    git(dir, "checkout", "-q", "-b", "side")
    await Bun.write(join(dir, "docs/b.md"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "doc")
    const reads = [
      "git push --set-upstream origin $(git branch --show-current)",
      'git push origin "$(git rev-parse --abbrev-ref HEAD)"',
    ]
    for (const command of reads) expect(await bash(command, dir)).toBeUndefined()
    await Bun.write(join(dir, "web/next/a.ts"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "web")
    for (const command of reads) expect(await bash(command, dir)).toContain("web/next/a.ts")
    const literal = "naming each ref literally"
    expect(await bash("git push origin $(echo side)", dir)).toContain(literal)
    expect(await bash("git branch --show-current; git push origin $(echo side)", dir)).toContain(
      literal,
    )
    expect(await bash("git push origin HEAD:$(git branch --show-current)", dir)).toContain(literal)
    expect(await bash(`git push origin $(git -C ${REPO} branch --show-current)`, dir)).toContain(
      literal,
    )
  })

  test("a push to a remote not fetched yet reads against every remote, so a docs commit passes", async () => {
    const dir = join(DIR, "push-fork")
    git(DIR, "init", "-q", "--bare", "-b", "canary", `${dir}.git`)
    git(DIR, "init", "-q", "--bare", "-b", "canary", `${dir}-fork.git`)
    git(DIR, "clone", "-q", `${dir}.git`, dir)
    await Bun.write(join(dir, "web/next/a.ts"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "push", "-q", "origin", "HEAD:canary")
    git(dir, "remote", "add", "fork", `${dir}-fork.git`)
    await Bun.write(join(dir, "docs/a.md"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "doc")
    expect(await bash("git push fork HEAD", dir)).toBeUndefined()
    await Bun.write(join(dir, "web/next/b.ts"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "web")
    expect(await bash("git push fork HEAD", dir)).toContain("web/next/b.ts")
  })

  test("a pushed commit's path holding a non-ASCII byte is read as it is", async () => {
    const dir = join(DIR, "push-cafe")
    git(DIR, "init", "-q", "--bare", "-b", "canary", `${dir}.git`)
    git(DIR, "clone", "-q", `${dir}.git`, dir)
    await Bun.write(join(dir, "docs/a.md"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "base")
    git(dir, "push", "-q", "origin", "HEAD:canary")
    await Bun.write(join(dir, "web/next/café.ts"), "x\n")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "cafe")
    expect(await bash("git push origin HEAD:canary", dir)).toContain("web/next/café.ts")
  })

  test("a push after any command is refused; after cd it is read as usual", async () => {
    const dir = await fresh("chain-push")
    expect(await bash("git status && git push", dir)).toContain("Run git push as its own call")
    expect(await bash("git commit -m m && git push", dir)).toContain("Run git push as its own call")
    expect(await bash(`cd ${dir} && git push origin HEAD`, DIR)).toContain("web/next/a.ts")
  })

  test("a commit or push run through run-slot.sh is read as the command after its --", async () => {
    const dir = await fresh("chain-slot")
    const slot = "~/.playground/ops/run-slot.sh worker-x --"
    await Bun.write(join(dir, "web/next/a.ts"), "y\n")
    expect(await bash(`${slot} git commit -a -m x`, dir)).toContain("web/next/a.ts")
    expect(await bash(`${slot} git push origin HEAD`, dir)).toContain("web/next/a.ts")
    expect(await bash(`git add -A && ${slot} git commit -m x`, dir)).toContain("web/next/a.ts")
    expect(await bash(`${slot} bash -c 'git commit -a -m x'`, dir)).toContain("web/next/a.ts")
    expect(await bash(`${slot} bash -c 'git push origin HEAD'`, dir)).toContain("web/next/a.ts")
    expect(await bash(`${slot} eval git commit -a -m x`, dir)).toContain("web/next/a.ts")
    expect(await bash(`${slot} bash -c 'cd ${dir} && git push origin HEAD'`, DIR)).toContain(
      "web/next/a.ts",
    )
    expect(await bash(`bash ${slot} git commit -a -m x`, dir)).toContain("web/next/a.ts")
    expect(await bash(`zsh -f ${slot} git push origin HEAD`, dir)).toContain("web/next/a.ts")
    expect(await bash(`${slot} git status`, dir)).toBeUndefined()
    expect(await bash(`bash ${slot} git status`, dir)).toBeUndefined()
    expect(await bash("bash scripts/other.sh worker-x -- git commit -a -m x", dir)).toBeUndefined()
  })
})

describe("what it passes and how it fails", () => {
  test("any other command passes", async () => {
    expect(await bash("git status")).toBeUndefined()
    expect(await bash("git log --oneline -5")).toBeUndefined()
    expect(await bash("echo commit")).toBeUndefined()
  })

  test("input it cannot parse is refused only when it reads as a git commit or push", async () => {
    expect(await check("{not json: git commit -m x", GLM, CALM)).toContain(
      "could not read this call",
    )
    expect(await check("{not json: git push", GLM, CALM)).toContain("could not read this call")
    expect(await check("{not json: echo hi", GLM, CALM)).toBeUndefined()
  })

  test("a runner the prefilter lets through to the parse runs when the parse fails, since the catch path reads its own prefilter", async () => {
    expect(await check("{not json: bun run build", GLM, CALM)).toBeUndefined()
    expect(await check("{not json: cd $D && ./cli.ts", GLM, CALM)).toBeUndefined()
    expect(await check("{not json: gh pr list", GLM, CALM)).toContain("glm rule")
  })
})

describe("a GLM session while load5 is over 15", () => {
  const at = (load5: number, command: string) => check(input(command), GLM, load5)

  test("the limit is glm.readOnlyLoad5, read at each call", async () => {
    const data = join(DIR, "load-data")
    const environment = { ...GLM, PLAYGROUND_DATA_DIR: data }
    const limit = (load5: number) =>
      writeRoot(
        extensionsDir(data),
        new Map([
          [
            "policy.json",
            JSON.stringify({ orgs: {}, schemaVersion: 1, values: { "glm.readOnlyLoad5": load5 } }),
          ],
        ]),
      )
    limit(25)
    expect(await check(input("bun install"), environment, 20)).toBeUndefined()
    limit(18)
    const reason = await check(input("bun install"), environment, 20)
    expect(reason).toContain("read-only while load5 is over 18")
    expect(reason).toContain("Wait until load5 is 18 or under")
  })

  test("a commit is refused at load5 20, naming the load and the rule, and passes at load5 10", async () => {
    await write("docs/load.md")
    git(REPO, "add", "docs/load.md")
    const reason = await at(20, "git commit -m 'docs: load'")
    expect(reason).toContain("load5 is 20.0")
    expect(reason).toContain("read-only while load5 is over 15")
    expect(reason).toContain("no install, node_modules clone, commit or push")
    expect(await at(10, "git commit -m 'docs: load'")).toBeUndefined()
    expect(await at(15, "git commit -m 'docs: load'")).toBeUndefined()
    git(REPO, "reset", "-q", "HEAD", "docs/load.md")
  })

  test("a commit of an Opus path names the path, the stronger rule", async () => {
    await write("web/next/src/load.ts")
    git(REPO, "add", "web/next/src/load.ts")
    const reason = await at(20, "git commit -m x")
    expect(reason).toContain("web/next/src/load.ts")
    expect(reason).toContain("Opus work")
    git(REPO, "reset", "-q", "HEAD", "web/next/src/load.ts")
  })

  test.each([
    { $label: "a push", command: "git push origin HEAD:canary" },
    { $label: "bun install", command: "bun install" },
    { $label: "bun i", command: "bun i --frozen-lockfile" },
    { $label: "bun add", command: "bun add zod" },
    { $label: "bun install after --cwd=", command: "bun --cwd=/w install" },
    { $label: "npm ci", command: "npm ci" },
    { $label: "pnpm install", command: "pnpm install" },
    { $label: "bare yarn", command: "yarn" },
    { $label: "uv sync", command: "uv sync --frozen" },
    { $label: "pip install", command: "pip install ruff" },
    { $label: "pip3 install", command: "pip3 install ruff" },
    { $label: "pipx install", command: "pipx install ruff" },
    { $label: "uv pip install", command: "uv pip install ruff" },
    { $label: "uv tool install", command: "uv tool install ruff" },
    { $label: "uv run pip install", command: "uv run pip install ruff" },
    { $label: "python -m pip install", command: ".venv/bin/python3 -m pip install ruff" },
    { $label: "uv run python -m pip install", command: "uv run python -m pip install ruff" },
    { $label: "uv pip sync", command: "uv pip sync requirements.txt" },
    { $label: "uv run with --python, pip install", command: "uv run --python 3.13 pip install x" },
    { $label: "uv run with --with, pip install", command: "uv run --with x pip install y" },
    { $label: "uv sync after --directory", command: "uv --directory /w sync" },
    { $label: "uv sync after --project", command: "uv --project /w sync" },
    { $label: "pip3.12 install", command: "pip3.12 install ruff" },
    { $label: "npm install-ci-test", command: "npm install-ci-test" },
    { $label: "yarn workspace add", command: "yarn workspace web add zod" },
    { $label: "npm up", command: "npm up" },
    { $label: "npm upgrade", command: "npm upgrade" },
    { $label: "npm it", command: "npm it" },
    { $label: "pnpm up", command: "pnpm up" },
    { $label: "yarn up", command: "yarn up" },
    { $label: "yarn upgrade", command: "yarn upgrade" },
    { $label: "yarn global add", command: "yarn global add turbo" },
    { $label: "an install through run-slot", command: `${slot} bun install` },
    { $label: "an install through bash run-slot", command: `bash ${slot} bun install` },
    { $label: "a node_modules clone", command: "cp -cR /w/a/node_modules /w/b/" },
    {
      $label: "a node_modules clone by ditto",
      command: "ditto /w/a/node_modules /w/b/node_modules",
    },
    {
      $label: "a node_modules clone by rsync",
      command: "rsync -a /w/a/node_modules/ /w/b/node_modules",
    },
    { $label: "a node_modules clone by its contents", command: "cp -R a/node_modules/* b/" },
    {
      $label: "a node_modules clone through run-slot",
      command: `${slot} cp -cR ../a/node_modules/ .`,
    },
    { $label: "an install after cd", command: "cd /w && bun install" },
  ])("$label is refused at load5 20 and passes the load rule at load5 10", async ({ command }) => {
    const reason = await at(20, command)
    expect(reason).toContain("load5 is 20.0")
    expect(reason).toContain("read-only while load5 is over 15")
    expect((await at(10, command)) ?? "").not.toContain("load5")
  })

  test.each([
    { $label: "git status", command: "git status" },
    { $label: "git log", command: "git log --oneline -3" },
    { $label: "a test run", command: `${slot} bun run test:file tests/a.test.ts` },
    { $label: "a file read", command: "cat package.json" },
    { $label: "a plain copy", command: "cp a.txt b.txt" },
    { $label: "a script run", command: "bun --no-env-file scripts/hooks/no-stash.ts" },
    { $label: "an install named in an echo", command: "echo bun install" },
    { $label: "bun upgrading itself", command: "bun upgrade" },
    { $label: "yarn's version", command: "yarn --version" },
    { $label: "yarn's help", command: "yarn -h" },
    { $label: "a file under node_modules copied", command: "cp a/node_modules/foo b" },
    { $label: "pip list", command: "uv pip list" },
    { $label: "a python module that is not pip", command: "python3 -m pytest -q" },
    { $label: "uv run of a script", command: "uv run scripts/x.py" },
  ])("$label passes at load5 20", async ({ command }) => {
    expect(await at(20, command)).toBeUndefined()
  })

  test("input it cannot parse is refused when it reads as an install", async () => {
    expect(await check("{not json: bun install", GLM, 20)).toContain("could not read this call")
    expect(await check("{not json: bun install", GLM, 10)).toBeUndefined()
  })
})

describe("which sessions it acts for", () => {
  const CONFIG = join(DIR, "config")
  const HOME = join(DIR, "home")
  const env = { CLAUDE_CONFIG_DIR: CONFIG, PLAYGROUND_DATA_DIR: join(CONFIG, "playground"), HOME }
  const pin = (name: string, backend: string) =>
    Bun.write(join(CONFIG, "playground", "backends", name), `${backend}\n`)

  beforeAll(async () => {
    mkdirSync(join(CONFIG, "sessions"), { recursive: true })
    await Bun.write(
      join(CONFIG, "sessions", "101.json"),
      JSON.stringify({ name: "worker-glm-pin", sessionId: "s-glm" }),
    )
    await Bun.write(
      join(CONFIG, "sessions", "102.json"),
      JSON.stringify({ name: "worker-claude-pin", sessionId: "s-claude" }),
    )
    await Bun.write(
      join(CONFIG, "sessions", "103.json"),
      JSON.stringify({ name: "worker-harness-glm-pin", sessionId: "s-harness-glm" }),
    )
    await Bun.write(
      join(CONFIG, "sessions", "104.json"),
      JSON.stringify({ name: "worker-harness-claude-pin", sessionId: "s-harness-claude" }),
    )
    await pin("worker-glm-pin", "glm")
    await pin("worker-claude-pin", "claude")
    await pin("worker-harness-glm-pin", "claude-code glm")
    await pin("worker-harness-claude-pin", "claude-code claude")
  })

  test.each([
    { label: "GLM's base URL", env: { ...env, ...GLM }, session: "s-none", want: true },
    { label: "a glm pin with no base URL", env, session: "s-glm", want: true },
    { label: "a claude pin", env, session: "s-claude", want: false },
    { label: "a claude-code glm pin", env, session: "s-harness-glm", want: true },
    { label: "a claude-code claude pin", env, session: "s-harness-claude", want: false },
    { label: "no pin and no base URL", env, session: "s-none", want: false },
    {
      label: "a base URL that only holds z.ai in its path",
      env: { ...env, ANTHROPIC_BASE_URL: "https://example.com/api.z.ai" },
      session: "s-none",
      want: false,
    },
  ])("$label", async ({ env: environment, session, want }) => {
    expect(await onGlm(input("git status", REPO, session), environment)).toBe(want)
  })

  test("a Claude session's commit at load5 20 passes, a GLM pin's is refused", async () => {
    await write("docs/busy.md")
    git(REPO, "add", "docs/busy.md")
    const commit = (session: string) => refusal(input("git commit -m busy", REPO, session), env, 20)
    expect(await commit("s-claude")).toBeUndefined()
    expect(await commit("s-glm")).toContain("load5 is 20.0")
    git(REPO, "reset", "-q", "HEAD", "docs/busy.md")
  })

  // the script as Claude Code runs it: a Claude worker commits web/next freely, a GLM worker is refused
  test("a Claude session's commit of web/next passes, a GLM session's exits 2", async () => {
    await write("web/next/src/y.ts")
    git(REPO, "add", "web/next/src/y.ts")
    const hook = (extra: Record<string, string>, session: string) => {
      const { PLAYGROUND_ROLE: _role, ...inherited } = GIT_ENV
      const proc = Bun.spawnSync(["bun", "--no-env-file", script], {
        env: { ...inherited, ...env, PLAYGROUND_ROLE: "worker", ...extra },
        stdin: new TextEncoder().encode(input("git commit -m y", REPO, session)),
      })
      return { code: proc.exitCode, err: proc.stderr.toString() }
    }
    const env_ = { ANTHROPIC_BASE_URL: "" }
    expect(hook(env_, "s-claude")).toEqual({ code: 0, err: "" })
    const refused = hook(env_, "s-glm")
    expect(refused.code).toBe(2)
    expect(refused.err).toContain("web/next/src/y.ts")
    expect(hook(GLM, "s-none").code).toBe(2)
    // a session outside the factory (no role, a name the registry does not hold) passes, as the owner's own do
    expect(hook({ ...GLM, PLAYGROUND_ROLE: "" }, "s-none")).toEqual({ code: 0, err: "" })
    git(REPO, "reset", "-q", "HEAD", "web/next/src/y.ts")
  }, 30_000)
})

describe("a GLM session's org tools", () => {
  // a data folder whose ext.links guards the made-up org acme-blue, and a checkout of one of its repositories
  const DATA = storeWith(
    join(DIR, "org-data"),
    {},
    { "ext.links": { "made-up-org": ["acme-blue"] } },
  )
  const ORG = join(DIR, "org-repo")
  const ON_GLM = { ...GLM, PLAYGROUND_DATA_DIR: DATA }
  const ON_CLAUDE = { PLAYGROUND_DATA_DIR: DATA }
  beforeAll(() => {
    git(DIR, "init", "-q", ORG)
    git(ORG, "remote", "add", "origin", "git@github.com:acme-blue/demo.git")
  })
  const tool = (name: string, toolInput: Record<string, unknown> = {}) =>
    JSON.stringify({
      cwd: REPO,
      hook_event_name: "PreToolUse",
      session_id: "s-none",
      tool_input: toolInput,
      tool_name: name,
    })
  const both = async (raw: string) => ({
    claude: await refusal(raw, ON_CLAUDE, CALM),
    glm: await refusal(raw, ON_GLM, CALM),
  })

  test.each([
    { $label: "a headless claude run", command: "claude -p hi", names: "headless Claude run" },
    {
      $label: "a headless claude run through npx --package=",
      command: "npx --package=@anthropic-ai/claude-code claude -p hi",
      names: "headless Claude run",
    },
    {
      $label: "curl to the tracker",
      command: "curl -s https://api.linear.app/graphql",
      names: "linear.app",
    },
    {
      $label: "curl to the chat",
      command: "curl https://slack.com/api/auth.test",
      names: "slack.com",
    },
    {
      $label: "wget of the docs",
      command: "wget https://api.notion.com/v1/x",
      names: "notion.com",
    },
    {
      $label: "gh on an org repo",
      command: "gh pr list -R acme-blue/demo",
      names: "acme-blue/demo",
    },
    { $label: "gh api of an org", command: "gh api orgs/acme-blue/teams", names: "acme-blue" },
    {
      $label: "gh api of an org repo past options that take a value",
      command: "gh api -X GET -H 'Accept: x' repos/acme-blue/demo/pulls",
      names: "acme-blue/demo",
    },
    {
      $label: "git clone of an org repo",
      command: "git clone https://github.com/acme-blue/x",
      names: "acme-blue",
    },
    {
      $label: "gh on a repo it cannot read",
      command: "gh pr list -R $R",
      names: "--repo <owner>/<name>",
    },
    { $label: "gh search with no scope", command: "gh search prs fix", names: "every org" },
    {
      $label: "gh graphql scoped to a repo no org guards",
      command: `gh api graphql -f query='{ repository(owner: "qzx-labs", name: "x") { pullRequest(number: 1) { id } } }'`,
      names: "REST",
    },
    {
      $label: "gh graphql mutation",
      command: `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "PRRT_x"}) { thread { isResolved } } }'`,
      names: "REST",
    },
  ])(
    "$label is refused on GLM, naming it and the glm rule, and passes on Claude",
    async ({ command, names }) => {
      const { claude, glm } = await both(input(command))
      expect(claude).toBeUndefined()
      expect(glm).toContain(names)
      expect(glm).toContain("glm rule")
      expect(glm).toContain("report to your lead")
    },
  )

  test("a runner's call that resolves into an org script's folder is refused on GLM, whatever the runner, and passes on Claude", async () => {
    const scripts = join(DIR, "scripts-repo")
    mkdirSync(join(scripts, "packages", "scripts"), { recursive: true })
    await Bun.write(
      join(scripts, "package.json"),
      JSON.stringify({
        scripts: {
          build: "turbo build",
          dm: "bun --no-env-file packages/scripts/src/dm/cli.ts",
          "linear:read": "bun --no-env-file packages/scripts/src/linear-read/cli.ts",
        },
      }),
    )
    for (const [command, names] of [
      ["bun run linear:read MADE-1", "Linear script"],
      ["bun linear:read MADE-1", "Linear script"],
      ["pnpm linear:read MADE-1", "Linear script"],
      ["npm run-script linear:read MADE-1", "Linear script"],
      ["yarn linear:read MADE-1", "Linear script"],
      ["bun run --cwd packages/scripts linear:read MADE-1", "Linear script"],
      ["bun --cwd packages/scripts run linear:read MADE-1", "Linear script"],
      ["cd packages/scripts && bun src/linear-read/cli.ts MADE-1", "Linear script"],
      ["bun --cwd packages/scripts src/linear-read/cli.ts MADE-1", "Linear script"],
      ["bun --cwd=packages/scripts src/linear-read/cli.ts MADE-1", "Linear script"],
      ["bun dm send x.md", "DM sender"],
      ["node ./packages/scripts/src/dm/cli.ts send", "DM sender"],
      ["./packages/scripts/src/linear-read/cli.ts MADE-1", "Linear script"],
      ["bun --cwd $D run linear:read MADE-1", "a folder a value it cannot read names"],
      ["cd $D && bun run dm hi", "a folder a value it cannot read names"],
      ["cd $D && bun run build", "a folder a value it cannot read names"],
      ["cd $D && ./cli.ts MADE-1", "names its program"],
      ["$P/cli.ts MADE-1", "names its program"],
    ]) {
      const { claude, glm } = await both(input(command, scripts))
      expect(claude).toBeUndefined()
      expect(glm).toContain(names)
      expect(glm).toContain("glm rule")
    }
    for (const command of [
      "bun run build",
      "bun run test:file tests/packages/scripts/src/linear-read/cli.test.ts",
      "cd packages/scripts && git log -1 -- src/linear-read/",
    ])
      expect(await refusal(input(command, scripts), ON_GLM, CALM)).toBeUndefined()
  })

  test("a policy it cannot read refuses gh, git and a fetcher on GLM, naming the fix, and passes on Claude", async () => {
    const broken = join(DIR, "broken-data")
    writeRoot(extensionsDir(broken), new Map([["policy.json", "{not json"]]))
    for (const command of ["gh pr list -R qzx-labs/x", "git status", "curl https://example.com"]) {
      const raw = input(command)
      expect(await refusal(raw, { PLAYGROUND_DATA_DIR: broken }, CALM)).toBeUndefined()
      const glm = await refusal(raw, { ...GLM, PLAYGROUND_DATA_DIR: broken }, CALM)
      expect(glm).toContain("cannot read which orgs ext.links guards")
      expect(glm).toContain("glm rule")
    }
  })

  test("a call it cannot parse that reads as an org tool names the glm rule", async () => {
    expect(await check("{not json: gh pr list", ON_GLM, CALM)).toContain("glm rule")
  })

  test("git reaching an org's checkout past -C is refused on GLM, naming the org", async () => {
    for (const command of [
      "git --git-dir=../org-repo/.git log -1",
      "GIT_DIR=../org-repo/.git git log -1",
      "git --work-tree=../org-repo status",
    ]) {
      const { claude, glm } = await both(input(command))
      expect(claude).toBeUndefined()
      expect(glm).toContain("acme-blue/demo")
    }
  })

  test("git and gh in an org's checkout are refused on GLM, naming the org, and pass on Claude", async () => {
    for (const command of ["git log -1", "gh pr list"]) {
      const { claude, glm } = await both(input(command, ORG))
      expect(claude).toBeUndefined()
      expect(glm).toContain("acme-blue/demo")
    }
  })

  test.each([
    { $label: "the tracker", name: "mcp__linear-shared__list_issues" },
    {
      $label: "the chat",
      name: "mcp__slack-shared__conversations_history",
      input: { channel: "C0" },
    },
    { $label: "the docs", name: "mcp__notion-shared__authenticate" },
    {
      $label: "the repos",
      name: "mcp__github-shared__get_file_contents",
      input: { owner: "qzx", repo: "x" },
    },
    { $label: "Claude Code's resource list", name: "ListMcpResourcesTool" },
    {
      $label: "Claude Code's resource read",
      name: "ReadMcpResourceTool",
      input: { server: "linear-shared", uri: "made-up://MADE-1" },
    },
    {
      $label: "Claude Code's resource folder read",
      name: "ReadMcpResourceDirTool",
      input: { server: "linear-shared", uri: "made-up://MADE" },
    },
  ])(
    "an MCP tool of $label is refused on GLM and passes on Claude",
    async ({ name, input: given }) => {
      const { claude, glm } = await both(tool(name, given))
      expect(claude).toBeUndefined()
      expect(glm).toContain(name)
      expect(glm).toContain("glm rule")
      expect(glm).toContain("report to your lead")
    },
  )

  test.each([
    { $label: "claude's version", command: "claude --version" },
    { $label: "an interactive claude", command: "claude --resume" },
    { $label: "a name in echo", command: "echo claude -p and https://slack.com" },
    { $label: "curl to another host", command: "curl -s https://example.com/x" },
    { $label: "gh on a repo no org guards", command: "gh pr view 1 -R qzx-labs/playground" },
    { $label: "gh api of a repo no org guards", command: "gh api repos/qzx-labs/playground/pulls" },
    {
      $label: "gh search scoped to a repo no org guards",
      command: "gh search prs fix --repo qzx-labs/playground",
    },
    { $label: "git in a checkout no org owns", command: "git status" },
    { $label: "git searching its log for slack.com", command: "git log --grep slack.com" },
    // a Linear script named, read, tested or committed, not run
    {
      $label: "sed of a Linear script",
      command: "sed -n 1,5p packages/scripts/src/linear-read/cli.ts",
    },
    { $label: "ls of a Linear script's folder", command: "ls packages/scripts/src/linear-read/" },
    {
      $label: "rg in a Linear script's folder",
      command: "rg token packages/scripts/src/linear-write/",
    },
    {
      $label: "a test of a Linear script",
      command: "bun run test:file tests/packages/scripts/src/linear-read/cli.test.ts",
    },
    {
      $label: "git add of a Linear script",
      command: "git add packages/scripts/src/linear-read/cli.ts",
    },
    {
      $label: "git log of a Linear script's folder",
      command: "git log --oneline -- packages/scripts/src/linear-write/",
    },
    { $label: "grep for the Linear scripts", command: "grep -n linear: package.json" },
    { $label: "the account's own repo list", command: "gh repo list" },
    { $label: "gh api of the signed-in user", command: "gh api user" },
    {
      $label: "gh api of the checkout's own repo by gh's placeholders",
      command: "gh api repos/{owner}/{repo}/pulls",
    },
    {
      $label: "gh api of a repo no org guards by its full URL",
      command: "gh api https://api.github.com/repos/qzx-labs/playground/pulls",
    },
    { $label: "gh api's markdown render", command: "gh api markdown -f text=hi" },
  ])("$label passes on GLM", async ({ command }) => {
    expect(await refusal(input(command), ON_GLM, CALM)).toBeUndefined()
  })
})

describe("a GLM session's reads of an org's checkout and its database calls", () => {
  // a data folder whose ext.links guards the made-up org acme-blue, its checkout, a checkout whose remotes git cannot read, and a folder in no checkout
  const DATA = storeWith(
    join(DIR, "read-data"),
    {},
    { "ext.links": { "made-up-org": ["acme-blue"] } },
  )
  const ORG = join(DIR, "read-org-repo")
  const BROKEN = join(DIR, "read-broken-repo")
  const LOOSE = join(DIR, "read-loose")
  const ON_GLM = { ...GLM, PLAYGROUND_DATA_DIR: DATA }
  const ON_CLAUDE = { PLAYGROUND_DATA_DIR: DATA }
  beforeAll(() => {
    git(DIR, "init", "-q", ORG)
    git(ORG, "remote", "add", "origin", "https://github.com/acme-blue/demo.git")
    mkdirSync(join(BROKEN, ".git"), { recursive: true })
    mkdirSync(LOOSE)
  })
  const call = (name: string, toolInput: Record<string, unknown>, cwd = REPO) =>
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      session_id: "s-none",
      tool_input: toolInput,
      tool_name: name,
    })
  const both = async (raw: string) => ({
    claude: await refusal(raw, ON_CLAUDE, CALM),
    glm: await refusal(raw, ON_GLM, CALM),
  })

  test("each read tool and a shell read of an org's checkout are refused on GLM, naming the org and the glm rule, and pass on Claude", async () => {
    for (const raw of [
      call("Read", { file_path: join(ORG, "README.md") }),
      call("Grep", { path: ORG, pattern: "token" }),
      call("Glob", { path: join(ORG, "src"), pattern: "**/*.ts" }),
      call("Grep", { pattern: "token" }, ORG),
      input(`cat ${join(ORG, "README.md")}`),
      input("cd ../read-org-repo && ls"),
      input("head README.md", ORG),
    ]) {
      const { claude, glm } = await both(raw)
      expect(claude).toBeUndefined()
      expect(glm).toContain("acme-blue/demo")
      expect(glm).toContain("glm rule")
      expect(glm).toContain("report to your lead")
    }
  })

  test("a shell read naming an org's checkout by a bare word, and a call in one the hook cannot parse, are refused on GLM", async () => {
    for (const raw of [
      input("rg token read-org-repo", DIR),
      input("ls read-org-repo", DIR),
      input(`cat README.md "`, ORG),
    ]) {
      const { claude, glm } = await both(raw)
      expect(claude).toBeUndefined()
      expect(glm).toContain("acme-blue/demo")
      expect(glm).toContain("glm rule")
    }
  })

  test("a read outside any guarded checkout passes on GLM: its own checkout, a folder in no checkout, and a checkout whose remotes git cannot read", async () => {
    for (const raw of [
      call("Read", { file_path: join(REPO, "README.md") }),
      call("Grep", { pattern: "token" }),
      call("Read", { file_path: join(LOOSE, "notes.md") }),
      call("Glob", { path: LOOSE, pattern: "*" }),
      call("Read", { file_path: join(BROKEN, "README.md") }),
      input(`cat ${join(LOOSE, "notes.md")}`),
      input(`cat ${join(BROKEN, "README.md")}`),
    ])
      expect(await refusal(raw, ON_GLM, CALM)).toBeUndefined()
  })

  test("a database client or URL aimed off this machine is refused on GLM, naming the host and the glm rule, and passes on Claude", async () => {
    for (const [command, names] of [
      ["psql -h db.example.com -U app app", "db.example.com"],
      ["psql postgres://app@db.example.com:5432/app", "db.example.com"],
      [`psql "host=db.example.com dbname=app"`, "db.example.com"],
      ["PGHOST=db.example.com psql app", "db.example.com"],
      ["pg_dump --host=db.example.com app", "db.example.com"],
      ["mysql -hdb.example.com app", "db.example.com"],
      ["mongosh mongodb+srv://app@cluster.example.net/app", "cluster.example.net"],
      ["redis-cli -h cache.example.com", "cache.example.com"],
      ["bun run seed.ts postgres://app@db.example.com/app", "db.example.com"],
      ["psql $DATABASE_URL", "cannot read"],
    ]) {
      const { claude, glm } = await both(input(command))
      expect(claude).toBeUndefined()
      expect(glm).toContain(names)
      expect(glm).toContain("glm rule")
      expect(glm).toContain("report to your lead")
    }
  })

  test("a read of an org's checkout through what the shell opens is refused on GLM: a redirect, a substitution, a glob, ~+ and a link", async () => {
    writeFileSync(join(ORG, "README.md"), "demo\n")
    symlinkSync(join("..", "read-org-repo", "README.md"), join(REPO, "org-link.md"))
    for (const raw of [
      input("cat < ../read-org-repo/README.md"),
      input('while read l; do echo "$l"; done < ../read-org-repo/README.md'),
      input('echo "$(< ../read-org-repo/README.md)"'),
      input("echo ../read-org-repo/README.md | xargs cat"),
      input("cat ../read-org-rep*/README.md"),
      input("ls ~+/../read-org-repo"),
      input("cat org-link.md"),
      input("sort -o out.txt ../read-org-repo/README.md"),
      input("echo x > ../read-org-repo/notes.md"),
    ]) {
      const { claude, glm } = await both(raw)
      expect(claude).toBeUndefined()
      expect(glm).toContain("acme-blue/demo")
      expect(glm).toContain("glm rule")
    }
  })

  test("a shell read that opens nothing in a guarded checkout passes on GLM: its own files by a redirect, a glob of its docs or ~+, and echo's plain words inside the checkout", async () => {
    for (const raw of [
      input("cat < README.md"),
      input("cat docs/*.md"),
      input("ls ~+/src"),
      input('echo "$(< README.md)"'),
      input("echo hi there", ORG),
      input("printf '%s\\n' done", ORG),
      input("cat ../read-loos*/notes.md"),
    ])
      expect(await refusal(raw, ON_GLM, CALM)).toBeUndefined()
  })

  test("a database client reading a host past its first is refused on GLM: hostaddr, a later host, a URL's host list and parameters, a service, MYSQL_HOST, a positional mongo host, a pg_ program, pgcli and docker", async () => {
    for (const [command, names] of [
      ["PGHOSTADDR=10.0.0.5 psql app", "10.0.0.5"],
      [`psql "hostaddr=10.0.0.5 dbname=app"`, "10.0.0.5"],
      [`psql "host=127.0.0.1 dbname=app host=db.example.com"`, "db.example.com"],
      ["psql postgresql://app@127.0.0.1:1,db.example.com/app", "db.example.com"],
      [`psql "postgresql:///app?host=db.example.com"`, "db.example.com"],
      ["psql service=prod", "cannot tell"],
      ["PGSERVICE=prod psql", "cannot tell"],
      ["MYSQL_HOST=db.example.com mysql app", "db.example.com"],
      ["mongosh db.example.com:27017/app", "db.example.com"],
      ["pg_basebackup -h db.example.com -D out", "db.example.com"],
      ["pgcli -h db.example.com app", "db.example.com"],
      ["docker exec x psql -h db.example.com app", "db.example.com"],
      ["docker run --rm postgres psql -h db.example.com", "db.example.com"],
      ["docker exec -e PGHOST=db.example.com x psql app", "db.example.com"],
      ["docker compose exec db psql -h db.example.com app", "db.example.com"],
    ]) {
      const { claude, glm } = await both(input(command))
      expect(claude).toBeUndefined()
      expect(glm).toContain(names)
      expect(glm).toContain("glm rule")
    }
  })

  test("a database client aimed off this machine is refused on GLM under a policy that guards no org", async () => {
    const open = storeWith(join(DIR, "no-org-data"), {}, {})
    for (const command of [
      "psql -h db.example.com app",
      "pg_basebackup -h db.example.com -D out",
      "pgcli -h db.example.com app",
      "pgbench -h db.example.com app",
      "mycli -h db.example.com app",
      "mysqldump -h db.example.com app",
      "mongo --host db.example.com",
      "mongosh --host db.example.com",
      "redis-cli -h db.example.com",
    ]) {
      const reason = await refusal(input(command), { ...GLM, PLAYGROUND_DATA_DIR: open }, CALM)
      expect(reason).toContain("db.example.com")
      expect(reason).toContain("glm rule")
    }
  })

  test("a database client on this machine passes on GLM", async () => {
    for (const command of [
      "psql -h 127.0.0.1 -U postgres app",
      "psql -h localhost app",
      "psql app",
      "psql postgres://postgres@127.0.0.1:55432/app",
      "psql postgresql://postgres@[::1]/app",
      "redis-cli",
      "redis-cli -h 127.0.0.1 ping",
      "docker exec playground-x-db psql -U postgres -c 'select 1'",
      "docker exec x psql -h 127.0.0.1 app",
      "echo postgres://app@db.example.com/app",
      "mongosh -h",
      "mongosh app",
      "mongosh ./scripts/seed.js",
      "mongosh localhost:27017/app",
      "psql postgresql://app@%2Fvar%2Frun/app",
      `psql "host=127.0.0.1 hostaddr=127.0.0.1 dbname=app"`,
      "psql postgresql://app@127.0.0.1:5432,localhost/app",
      `psql "postgresql:///app?host=/tmp"`,
    ])
      expect(await refusal(input(command), ON_GLM, CALM)).toBeUndefined()
  })
})

describe("its registration", () => {
  // the matcher each settings file registers the hook under, read from the file a session loads
  const matchers = async () =>
    Promise.all(
      [".claude/settings.json", "scripts/factory-settings.json"].map(async (file) => {
        const { hooks } = (await Bun.file(join(root, file)).json()) as {
          hooks: { PreToolUse: { hooks: { command: string }[]; matcher: string }[] }
        }
        const entry = hooks.PreToolUse.find((e) =>
          e.hooks.some((h) => h.command.includes("no-glm-heavy-path")),
        )
        return { file, matcher: new RegExp(entry?.matcher ?? "(?!)") }
      }),
    )

  // Bash reaches it through guards (tests/scripts/hooks/guards.test.ts).
  test("both settings files send it every MCP tool and Claude Code's three MCP resource tools, and no other tool", async () => {
    for (const { file, matcher } of await matchers()) {
      for (const tool of [
        "ListMcpResourcesTool",
        "ReadMcpResourceDirTool",
        "ReadMcpResourceTool",
        "mcp__linear-shared__list_issues",
        "mcp__slack-shared__conversations_history",
      ])
        expect({ file, tool, sent: matcher.test(tool) }).toEqual({ file, tool, sent: true })
      for (const tool of [
        "Bash",
        "Edit",
        "Write",
        "WebFetch",
        "Agent",
        "xBash",
        "Bashful",
        "ListMcpResourcesToolx",
      ])
        expect({ file, tool, sent: matcher.test(tool) }).toEqual({ file, tool, sent: false })
    }
  })
})
