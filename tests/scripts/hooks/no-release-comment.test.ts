import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check as hookCheck } from "../../../scripts/hooks/no-release-comment"
import { storeWith } from "./render-set"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-release-comment.ts")
let scratch = ""
let guarded = ""
let other = ""
let plain = ""
// A data folder whose extensions guard the owner these tests comment as, since the checkout's own list names none.
let owned = ""

const check = (raw: string, environment: Record<string, string | undefined> = {}) =>
  hookCheck(raw, { PLAYGROUND_DATA_DIR: owned, ...environment })

const repo = (dir: string, url: string) => {
  Bun.spawnSync(["git", "init", "-q", dir])
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url])
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-release-comment-"))
  guarded = join(scratch, "guarded")
  other = join(scratch, "other")
  plain = join(scratch, "plain")
  owned = storeWith(join(scratch, "data"), { "release-owners.json": '["qmarsh"]' })
  repo(guarded, "git@github.com:qmarsh/demo.git")
  repo(other, "https://github.com/acme-labs/demo.git")
  await Bun.write(join(plain, "clean.md"), "Ready to ship\n")
  await Bun.write(join(guarded, "clean.md"), "Ready to ship\n")
  await Bun.write(join(guarded, "notes.md"), "Released in v2\n")
  await Bun.write(join(guarded, "release-clean.md"), "Ready to ship\n")
  await Bun.write(join(other, "notes.md"), "Released in v2\n")
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const bash = (command: string, cwd = guarded) =>
  check(
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    {},
  )

const mcp = (tool_name: string, tool_input: unknown) =>
  check(JSON.stringify({ cwd: guarded, hook_event_name: "PreToolUse", tool_input, tool_name }), {})

const where = (dir: "guarded" | "other" | "plain") => ({ guarded, other, plain })[dir]

describe("a gh comment on a guarded owner's repo that contains the word is refused", () => {
  test.each([
    ["an inline --body", 'gh pr comment 12 --body "Ready for release"', "guarded"],
    ["--body=", "gh pr comment 12 --body='RELEASED'", "guarded"],
    ["a short flag with its value attached", "gh issue comment 3 -bRelease", "guarded"],
    ["a --body-file", "gh pr comment 12 --body-file notes.md", "guarded"],
    [
      "a heredoc on stdin",
      "gh pr comment 12 --body-file - <<'EOF'\nprerelease notes\nEOF",
      "guarded",
    ],
    [
      "a heredoc inside $(cat)",
      "gh pr comment 12 --body \"$(cat <<'EOF'\n## Evidence\nRelease it (see 1)\nEOF\n)\"",
      "guarded",
    ],
    ["$(cat file)", 'gh pr comment 12 --body "$(cat notes.md)"', "guarded"],
    ["$(< file)", 'gh pr comment 12 --body "$(< notes.md)"', "guarded"],
    [
      "a body file written earlier in the command",
      "cat > body.md <<'EOF'\nrelease\nEOF\ngh pr comment 12 -F body.md",
      "guarded",
    ],
    [
      "a clean file overwritten earlier in the command",
      "cat > clean.md <<'EOF'\nrelease\nEOF\ngh pr comment 12 -F clean.md",
      "guarded",
    ],
    [
      "a file appended to with echo",
      "echo Release >> clean.md && gh pr comment 12 -F clean.md",
      "guarded",
    ],
    ["echo piped to stdin", 'echo "release" | gh pr comment 12 -F -', "guarded"],
    ["a here-string", "gh pr comment 12 -F - <<< 'Release'", "guarded"],
    ["$'...' escapes", "gh pr comment 12 -b $'\\x72elease'", "guarded"],
    ["gh pr review --comment -b", 'gh pr review 12 --comment -b "Release"', "guarded"],
    ["gh pr review -r -F", "gh pr review 12 -r -F notes.md", "guarded"],
    ["gh pr close -c", 'gh pr close 12 -c "superseded by the release"', "guarded"],
    [
      "gh issue close --comment",
      'gh issue close 3 --reason completed --comment "fixed in the release"',
      "guarded",
    ],
    ["gh pr reopen --comment=", "gh pr reopen 12 --comment=Release", "guarded"],
    ["gh issue reopen -c", "gh issue reopen 3 -c release", "guarded"],
    ["--attach alt text", "gh pr comment 12 --attach './after.png#The release page'", "guarded"],
    ["--edit-last", "gh pr comment 12 --edit-last --body release", "guarded"],
    ["a cd into the repo first", "cd GUARDED && gh pr comment 12 -b release", "plain"],
    ["-R from another checkout", "gh pr comment 12 -R qmarsh/gitpick -b release", "other"],
    [
      "--repo= from another checkout",
      "gh pr comment 12 --repo=github.com/qmarsh/gitpick -b release",
      "other",
    ],
    ["-R before the subcommand", "gh pr -R qmarsh/gitpick comment 12 -b release", "other"],
    [
      "a pull request URL",
      "gh pr comment https://github.com/qmarsh/gitpick/pull/3 -b release",
      "other",
    ],
    ["the owner in another case", "gh pr comment 12 -R QMarsh/gitpick -b release", "other"],
    ["GH_REPO before the command", "GH_REPO=qmarsh/gitpick gh pr comment 3 -b release", "other"],
    ["env GH_REPO", "env GH_REPO=qmarsh/gitpick gh issue comment 3 -b release", "other"],
    [
      "an exported GH_REPO",
      "export GH_REPO=qmarsh/gitpick; gh issue comment 3 -b release",
      "other",
    ],
    ["env -C into the repo", "env -C GUARDED gh pr comment 12 -b release", "plain"],
    ["a full path to gh", "/opt/homebrew/bin/gh pr comment 12 -b release", "guarded"],
    ["a wrapper", "timeout 30 command gh pr comment 12 -b release", "guarded"],
    ["bash -c", "bash -c 'gh pr comment 12 -b release'", "guarded"],
    ["bash reading a heredoc script", "bash <<'EOF'\ngh pr comment 12 -b release\nEOF", "guarded"],
    ["eval", 'eval "gh pr comment 12 -b release"', "guarded"],
    ["a command substitution", "url=$(gh pr comment 12 -b release)", "guarded"],
    ["backticks", "url=`gh pr comment 12 -b release`", "guarded"],
    ["a subshell", "(gh pr comment 12 -b release)", "guarded"],
    ["an if", "if true; then gh pr comment 12 -b release; fi", "guarded"],
    ["a repository it cannot resolve", "gh pr comment 12 -b release", "plain"],
  ] as const)("%s", async (_, command, dir) => {
    const reason = await bash(command.replaceAll("GUARDED", guarded), where(dir))
    expect(reason).toContain("no-release-comment hook refused")
    expect(reason).toContain('its text contains "release"')
    expect(reason).toContain('Write "ship" or "publish step" instead')
  })

  test("a comment naming the ship rule's file is told the way out: name it by what it is, and send a patch to the author, never attach it", async () => {
    const reason = await bash(
      'gh pr comment 12 --body "Per extensions/core/rules/release.md:1, ship at three merges"',
    )
    expect(reason).toContain('its text contains "release"')
    expect(reason).toContain("name it by what it is")
    expect(reason).toContain("with its line number")
    expect(reason).toContain(
      "write the patch to a file in your scratchpad, send its absolute path to the PR's worker by SendMessage, and say in the comment that a patch went to the author",
    )
    expect(reason).toContain("gh's `--attach` uploads only images and video")
    expect(reason).not.toContain("--attach <file>")
  })
})

describe("a gh comment on a guarded owner's repo whose text the hook cannot read is refused", () => {
  test.each([
    ["a shell variable", 'gh pr comment 12 --body "$BODY"'],
    ["another command substitution", 'gh pr comment 12 --body "$(git log -1 --format=%s)"'],
    ["a body file that does not exist", "gh pr comment 12 -F missing.md"],
    ["stdin piped from a program", "git log -1 | gh pr comment 12 -F -"],
    [
      "an unquoted heredoc with an expansion",
      "gh pr comment 12 -F - <<EOF\nfixed in $VERSION\nEOF",
    ],
    ["a body file a program writes first", "git log -1 > body.md && gh pr comment 12 -F body.md"],
    [
      "a relative body file after a cd it cannot follow",
      'cd "$DIR" && gh pr comment 12 -F clean.md -R qmarsh/demo',
    ],
  ])("%s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-release-comment hook refused")
    expect(reason).toContain("the hook cannot read its text before the command runs")
  })
})

test.each([
  { $label: "--body-file", command: 'gh pr comment 12 --body-file "$S/body.md"' },
  { $label: "-F", command: "gh pr comment 12 -F $S/body.md" },
])(
  "a body file named through a shell variable is refused, naming a literal path ($label)",
  async ({ command }) => {
    expect(await bash(command)).toContain("name the file by its literal absolute path")
  },
)

test.each([
  ["a --body-file named through a variable", 'gh pr comment 12 --body-file "$S/comment.md"'],
  [
    "a --body-file a heredoc writes in the same call",
    "cat > /tmp/body.md <<EOF\nShip $VERSION\nEOF\ngh pr comment 12 --body-file /tmp/body.md",
  ],
])(
  "a refusal for text it cannot read names the Write-then-literal-path recipe (%s)",
  async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("the hook cannot read its text before the command runs")
    expect(reason).toContain("write the text to a file with the Write tool first")
    expect(reason).toContain("--body-file /abs/body.md")
  },
)

describe("allowed gh commands", () => {
  test.each([
    ["a clean inline body", 'gh pr comment 12 --body "Ready to ship"', "guarded"],
    ["a clean body file", "gh pr comment 12 -F clean.md", "guarded"],
    ["a clean file whose name holds the word", "gh pr comment 12 -F release-clean.md", "guarded"],
    ["a clean heredoc", "gh pr comment 12 --body \"$(cat <<'EOF'\nShip it\nEOF\n)\"", "guarded"],
    ["another owner by -R", "gh pr comment 3 -R acme-labs/demo -b release", "guarded"],
    ["another owner by checkout", "gh pr comment 3 -b release", "other"],
    ["another owner by checkout, with a body file", "gh pr comment 3 -F notes.md", "other"],
    ["another owner, with a body it cannot read", 'gh pr comment 3 --body "$BODY"', "other"],
    [
      "another owner by pull request URL",
      "gh pr comment https://github.com/acme-labs/demo/pull/3 -b release",
      "guarded",
    ],
    [
      "a pull request body",
      'gh pr create --title "Add the hook" --body "quotes the word release"',
      "guarded",
    ],
    ["a pull request edit", 'gh pr edit 12 --body "release"', "guarded"],
    ["an issue body", 'gh issue create --title x --body "release"', "guarded"],
    ["gh release", "gh release list", "guarded"],
    ["a read", "gh pr view 12 --comments", "guarded"],
    ["an approval with no body", "gh pr review 12 --approve", "guarded"],
    ["review -c is a switch, not a value", 'gh pr review 12 -c -b "ship it"', "guarded"],
    ["a close with no comment", "gh pr close 12 -d", "guarded"],
    ["a delete", "gh pr comment 12 --delete-last --yes", "guarded"],
    ["a comment with no body", "gh pr comment 12", "guarded"],
    ["a commit message", 'git commit -m "release"', "guarded"],
    ["echo", "echo release", "guarded"],
    ["the word in a later command only", "gh pr comment 12 -b ship && echo release", "guarded"],
  ] as const)("%s", async (_, command, dir) => {
    expect(await bash(command, where(dir))).toBeUndefined()
  })
})

describe("command shapes from review", () => {
  test.each([
    ["refuse", "guarded", "printf '50%%done: ready for release\\n' x | gh pr comment 1 -F -"],
    ["refuse", "guarded", "printf '%%s release\\n' x > body.md && gh pr comment 1 -F body.md"],
    ["refuse", "guarded", 'printf "%\'d release\\n" 1000 | gh pr comment 1 -F -'],
    ["refuse", "guarded", "printf '%5 release' 1 2 | gh pr comment 1 -F -"],
    ["refuse", "guarded", "{ gh pr comment 12 -F -; } < notes.md"],
    ["refuse", "guarded", "( gh pr comment 12 -F - ) < notes.md"],
    ["refuse", "guarded", "printf 'x\\nRelease\\n' | { read -r first; gh pr comment 12 -F -; }"],
    ["refuse", "guarded", "gh pr comment 12 -F -"],
    ["refuse", "guarded", "g\\h pr comment 12 -b release"],
    ["refuse", "guarded", "g''h pr comment 12 -b release"],
    ["refuse", "guarded", '"g"h pr comment 12 -b release'],
    ["refuse", "guarded", "$'\\x67h' pr comment 12 -b release"],
    ["refuse", "guarded", "gh pr comm\\ent 12 -b release"],
    ["refuse", "guarded", "cd OTHER | cat; gh pr comment 12 -b release"],
    ["refuse", "guarded", "cd OTHER & gh pr comment 12 -b release"],
    [
      "allow",
      "guarded",
      "gh pr list --json number --jq '.[].number' | xargs -I{} gh api repos/qmarsh/demo/issues/{}/comments --jq '.[].body'",
    ],
    [
      "refuse",
      "guarded",
      "echo 1 | xargs -I{} gh api repos/qmarsh/demo/issues/1/comments -f body={}",
    ],
    ["refuse", "guarded", "echo 1 | xargs gh api repos/qmarsh/demo/issues/1/comments"],
    ["allow", "guarded", "echo 1 | xargs gh api -X GET repos/qmarsh/demo/issues/1/comments"],
    ["allow", "guarded", 'gh pr comment 67 -F "$PWD/clean.md"'],
    ["refuse", "guarded", 'gh pr comment 67 -F "$PWD/notes.md"'],
    ["refuse", "guarded", 'cd OTHER; gh pr comment 67 -R qmarsh/demo -F "$PWD/clean.md"'],
    ["refuse", "other", 'PR=https://github.com/qmarsh/demo/pull/3; gh pr comment "$PR" -b release'],
    ["refuse", "other", 'gh pr comment "$PR_URL" -b release'],
    [
      "refuse",
      "other",
      "gh pr comment \"$(gh pr list -R qmarsh/demo --json url -q '.[0].url')\" -b release",
    ],
    ["refuse", "other", "gh issue comment `cat url.txt` -b release"],
    [
      "refuse",
      "other",
      "echo https://github.com/qmarsh/demo/pull/1 | xargs -I{} gh pr comment {} -b release",
    ],
    [
      "refuse",
      "other",
      "echo https://github.com/qmarsh/demo/pull/1 | xargs gh pr comment -b release",
    ],
    ["allow", "other", 'gh pr comment "$PR" -b ship'],
    ["allow", "guarded", "for n in 1 2 3; do gh pr comment $n -b ship; done"],
    ["refuse", "guarded", "echo '-b release' | xargs -I@@ gh pr comment 12 @@"],
    ["refuse", "guarded", "echo '--body=release' | xargs -I{} gh pr comment 12 {}"],
    ["refuse", "guarded", "seq 3 | xargs -I{} gh pr comment {} -b ship"],
    ["refuse", "guarded", "echo body=release | xargs -I{} gh pr comment 12 --{}"],
    ["refuse", "guarded", "echo brelease | xargs -I{} gh pr comment 12 -{}"],
    [
      "refuse",
      "guarded",
      "echo body=release | xargs -I{} gh api repos/qmarsh/demo/issues/1/comments -f{}",
    ],
    ["refuse", "guarded", "seq 3 | xargs -I % gh pr comment % -b 'see %'"],
    ["refuse", "guarded", "seq 3 | xargs -J % gh pr comment 12 -b %"],
    ["refuse", "guarded", "ls *.md | xargs -I{} gh pr comment 12 -F {}"],
    [
      "refuse",
      "guarded",
      "echo body=release | xargs -I{} gh api repos/qmarsh/demo/issues/1/comments -f {}",
    ],
    [
      "refuse",
      "other",
      "echo qmarsh | xargs -I{} gh api repos/{}/demo/issues/1/comments -f body=release",
    ],
    [
      "refuse",
      "other",
      "echo repos/qmarsh/demo/issues/1/comments | xargs -I{} gh api {} -f body=release",
    ],
    ["refuse", "guarded", "exec < notes.md; gh pr comment 12 -F -"],
    ["allow", "guarded", "gh pr comment 12 -F - <<< 'ship it'"],
    ["allow", "guarded", "echo ship | gh pr comment 12 -F -"],
    ["allow", "guarded", "cd OTHER && git status | head -3 && gh pr comment 12 -b release"],
    ["refuse", "guarded", "gh pr c'o'mment 12 -b release"],
    ["refuse", "guarded", 'PWD=/x gh pr comment 12 -F "$PWD/clean.md"'],
    ["refuse", "guarded", "gh pr comment 12 -F <(echo release)"],
    ["refuse", "guarded", "gh pr comment 12 --body-file <(printf 'release')"],
    ["refuse", "guarded", 'gh pr comment 12 -b "$(< <(echo release))"'],
    ["refuse", "guarded", "echo release | xargs gh pr comment 12 -b"],
    ["refuse", "guarded", "echo release | xargs -I{} gh pr comment 12 -b {}"],
    ["refuse", "guarded", "(cd OTHER && git status); gh pr comment 12 -b release"],
    ["refuse", "guarded", "x=$(cd OTHER && pwd); gh pr comment 12 -b release"],
    ["refuse", "guarded", "pushd OTHER && popd && gh pr comment 12 -b release"],
    ["refuse", "guarded", "cd OTHER && cd - && gh pr comment 12 -b release"],
    ["refuse", "guarded", "cd OTHER || exit; cd GUARDED; gh pr comment 12 -b release"],
    ["allow", "guarded", "if cd OTHER; then :; fi; gh pr comment 12 -b release"],
    ["refuse", "other", "cd /no/such/dir; gh pr comment 12 -b release"],
    ["refuse", "guarded", "gh pr comment 12 -b {rel,}ease"],
    ["refuse", "guarded", "echo -e 'rel\\x65ase' | gh pr comment 12 -F -"],
    ["refuse", "guarded", "printf 'rel%sase' e | gh pr comment 12 -F -"],
    ["refuse", "guarded", "printf '%s\\n' 'Release notes' > b.md && gh pr comment 12 -F b.md"],
    ["refuse", "guarded", "gh api /repositories/123/issues/1/comments -f body=release"],
    ["refuse", "guarded", '"$(which gh)" pr comment 12 -b release'],
    ["refuse", "guarded", "GH=gh; $GH pr comment 12 -b release"],
    ["refuse", "other", "sudo GH_REPO=qmarsh/x gh pr comment 12 -b release"],
    ["refuse", "other", "GH_REPO=qmarsh/x; export GH_REPO; gh pr comment 12 -b release"],
    ["refuse", "other", "export GH_REPO=qmarsh/x\ngh pr comment 12 -b release"],
    ["refuse", "other", "env -u GH_REPO GH_REPO=qmarsh/x gh pr comment 12 -b release"],
    ["refuse", "guarded", "GH_REPO=acme-labs/x gh pr comment 12 -b release"],
    ["allow", "other", "GH_REPO=acme-labs/x gh pr comment 12 -b release"],
    ["refuse", "guarded", "noglob gh pr comment 12 -b release"],
    ["refuse", "guarded", "nocorrect gh pr comment 12 -b release"],
    ["refuse", "guarded", "=gh pr comment 12 -b release"],
    ["refuse", "guarded", "repeat 1 gh pr comment 12 -b release"],
    ["refuse", "guarded", "op run --env-file x.env -- gh pr comment 12 -b release"],
    ["refuse", "guarded", "function f { gh pr comment 1 -b release; }; f"],
    ["refuse", "guarded", "coproc gh pr comment 1 -b release"],
    ["refuse", "guarded", 'post() { gh pr comment 1 -F "$1"; }; post notes.md'],
    ["refuse", "guarded", "select x in a; do gh pr comment 1 -b release; done"],
    ["refuse", "guarded", "case a in a) gh pr comment 1 -b release;; esac"],
    ["refuse", "guarded", "[[ -n x ]] && gh pr comment 1 -b release"],
    ["refuse", "guarded", "! gh pr comment 1 -b release"],
    ["refuse", "guarded", "x=$(cat <<'EOF'\nship\nEOF)\ngh pr comment 12 -b release"],
    ["refuse", "guarded", 'gh pr comment 12 -b "$(echo "a) release")"'],
    [
      "refuse",
      "guarded",
      "gh pr comment 12 -b \"$(cat <<'EOF'\nship\nEOF\n)\" && gh pr comment 12 -b release",
    ],
    [
      "refuse",
      "guarded",
      '{\n  echo "## Review"\n  echo\n  echo "Ready for the release"\n} > body2.md\ngh pr comment 67 --body-file body2.md',
    ],
    [
      "refuse",
      "guarded",
      "for l in Ship Release; do echo $l; done > b3.md; gh pr comment 1 -F b3.md",
    ],
    ["refuse", "guarded", "for l in Ship Release; do echo $l; done | gh pr comment 1 -F -"],
    ["refuse", "guarded", "if true; then echo release; fi > b4.md; gh pr comment 1 -F b4.md"],
    ["refuse", "guarded", "{ cat <<'EOF'\nRelease\nEOF\n} | gh pr comment 1 -F -"],
    ["refuse", "guarded", "{ cat clean.md; cat notes.md; } | gh pr comment 1 -F -"],
    ["refuse", "guarded", "( cat notes.md ) > b5.md && gh pr comment 1 -F b5.md"],
    ["allow", "guarded", "> b6.md; gh pr comment 1 -F b6.md"],
    ["refuse", "guarded", "{ echo release; } >> clean.md; gh pr comment 1 -F clean.md"],
    ["refuse", "guarded", "(echo ship; echo release) > b.md && gh pr comment 12 -F b.md"],
    ["refuse", "guarded", "(echo release) | gh pr comment 12 -F -"],
    ["refuse", "guarded", "echo release | (gh pr comment 12 -F -)"],
    ["refuse", "guarded", "echo release | { gh pr comment 12 -F -; }"],
    ["refuse", "guarded", "cat <<'EOF' > b.md\nrelease\nEOF\ncat b.md | gh pr comment 12 -F -"],
    ["refuse", "guarded", "tee b.md <<'EOF'\nrelease\nEOF\ngh pr comment 12 -F b.md"],
    ["refuse", "guarded", "cat notes.md | tee body.md && gh pr comment 12 -F body.md"],
    ["refuse", "guarded", "cp notes.md body.md && gh pr comment 12 -F body.md"],
    [
      "refuse",
      "guarded",
      "mkdir -p sub && cd sub && echo release > b.md && gh pr comment 12 -F b.md",
    ],
    ["refuse", "guarded", "echo 'gh pr comment 12 -b release' | bash"],
    ["refuse", "guarded", "env bash -c 'gh pr comment 12 -b release'"],
    ["refuse", "guarded", "gh pr comment 12 -b release 2>&1 | tail -5"],
    ["refuse", "guarded", "gh pr comment 12 -b ship#release"],
    ["refuse", "guarded", "gh pr comment 12 -b re\\lease"],
    ["refuse", "guarded", "gh pr comment 12 -b re''lease"],
    ["refuse", "guarded", "gh pr comment 12 --body=$'\\122elease'"],
    ["refuse", "guarded", "gh pr comment 12 --body $'\\u0052elease'"],
    ["refuse", "guarded", 'gh pr comment 12 -b "$(cat notes.md | head -1)"'],
    ["refuse", "guarded", 'gh pr comment 12 -b "${BODY:-release}"'],
    ["refuse", "guarded", 'gh pr comment 12 -b "Header\n$(cat clean.md)$(cat notes.md)\nFooter"'],
    ["allow", "guarded", 'gh pr comment 12 -b "Header\n$(cat clean.md)\nFooter"'],
    ["refuse", "guarded", "gh pr comment 12 -F clean.md --attach ./shots/release.png"],
    ["allow", "guarded", "gh pr comment 12 -F clean.md --attach './release-page.png#After'"],
    // gh reads only the alt text, else the file's name, so a variable earlier in the path does not reach the comment
    ["allow", "guarded", 'gh pr comment 12 -F clean.md --attach "$S/a.png#After"'],
    ["allow", "guarded", 'gh pr comment 12 -F clean.md --attach "$S/after.png"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "$S/a.png#release notes"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "$S/a.png#$ALT"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "$S.png"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "./a.png#x$ALT/y"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "./a.png#$ALT#After"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "/abs/a.png#$ALT/x"'],
    ["refuse", "guarded", 'gh pr comment 12 -F clean.md --attach "./a.png#$(cat notes.md)/x"'],
    ["refuse", "guarded", "gh pr review 12 -a -brelease"],
    ["refuse", "other", "gh issue close 1 -R qmarsh/x -r 'not planned' -c release"],
    ["refuse", "guarded", "gh api -XPOST repos/qmarsh/demo/issues/1/comments -fbody=release"],
    ["refuse", "guarded", "gh api repos/qmarsh/demo/issues/1/comments --field=body=release"],
    ["refuse", "guarded", "gh api repos/QMARSH/demo/issues/1/comments -f body=release"],
    [
      "refuse",
      "guarded",
      "jq -n '{body:\"release\"}' | gh api repos/qmarsh/demo/issues/1/comments --input -",
    ],
    [
      "refuse",
      "other",
      'gh api repos/qmarsh/x/pulls/1/reviews --input - <<\'EOF\'\n{"event":"COMMENT","comments":[{"path":"a","body":"Release"}]}\nEOF',
    ],
    [
      "allow",
      "other",
      'gh api repos/qmarsh/x/pulls/1/reviews --input - <<\'EOF\'\n{"event":"COMMENT","comments":[{"path":"src/release.ts","body":"Ship"}]}\nEOF',
    ],
    [
      "allow",
      "guarded",
      "gh api repos/qmarsh/demo/pulls/2/comments -f body=LGTM -f path=src/release.ts -f commit_id=abc",
    ],
    ["allow", "guarded", "gh api repos/qmarsh/demo/issues/1/comments -f body=re -f body=lease"],
    [
      "refuse",
      "guarded",
      "curl -X POST https://api.github.com/repos/qmarsh/demo/issues/1/comments --data-binary @notes.md",
    ],
  ] as const)("%s in %s: %s", async (want, dir, command) => {
    const reason = await bash(
      command.replaceAll("GUARDED", guarded).replaceAll("OTHER", other),
      where(dir),
    )
    if (want === "refuse") expect(reason).toContain("no-release-comment hook refused")
    else expect(reason).toBeUndefined()
  })
})

describe("files and variables", () => {
  test("resolves $TMPDIR and $HOME in a body file path", async () => {
    const payload = (command: string) =>
      JSON.stringify({ cwd: plain, tool_input: { command }, tool_name: "Bash" })
    const environment = { HOME: other, TMPDIR: guarded }
    expect(
      await check(payload('gh pr comment 1 -R qmarsh/demo -F "$TMPDIR/clean.md"'), environment),
    ).toBeUndefined()
    expect(
      await check(payload("gh pr comment 1 -R qmarsh/demo -F ${HOME}/notes.md"), environment),
    ).toContain('its text contains "release"')
    expect(
      await check(
        payload('TMPDIR=/elsewhere gh pr comment 1 -R qmarsh/demo -F "$TMPDIR/clean.md"'),
        environment,
      ),
    ).toContain("the hook cannot read its text")
  })

  test("reads no FIFO, and leaves a command that names neither gh nor github alone", async () => {
    const fifo = join(plain, "pipe.fifo")
    Bun.spawnSync(["mkfifo", fifo])
    expect(await bash(`cat ${fifo} > out.txt`, plain)).toBeUndefined()
    expect(
      await bash(`cat ${fifo} > out.txt && gh pr comment 1 -R qmarsh/demo -F out.txt`, plain),
    ).toContain("not a regular file")
  })
})

const MUTATION = `mutation { addComment(input: {subjectId: "I_1", body: "release"}) { clientMutationId } }`

describe("gh api", () => {
  test.each([
    [
      "an issue comment",
      'gh api repos/qmarsh/demo/issues/1/comments -f body="Release it"',
      "other",
    ],
    [
      "a review through placeholders",
      "gh api 'repos/{owner}/{repo}/pulls/2/reviews' -f body=Release -f event=COMMENT",
      "guarded",
    ],
    [
      "--input from a heredoc",
      'gh api repos/qmarsh/demo/issues/1/comments --input - <<\'EOF\'\n{"body":"release"}\nEOF',
      "other",
    ],
    ["-F body=@file", "gh api repos/qmarsh/demo/issues/1/comments -F body=@notes.md", "guarded"],
    [
      "a reply to a review comment",
      "gh api -X POST /repos/qmarsh/demo/pulls/2/comments/9/replies -f body=release",
      "other",
    ],
    [
      "a comment edit",
      "gh api -X PATCH repos/qmarsh/demo/issues/comments/5 -f body=release",
      "other",
    ],
    [
      "a full URL",
      "gh api https://api.github.com/repos/qmarsh/demo/issues/1/comments -f body=release",
      "other",
    ],
    ["an endpoint it cannot read", 'gh api "$URL" -f body=release', "other"],
    [
      "a GraphQL addComment",
      'gh api graphql -f query=\'mutation { addComment(input: {subjectId: "I_1", body: "release"}) { clientMutationId } }\'',
      "other",
    ],
    [
      "a GraphQL variable",
      "gh api graphql -f query='mutation($b: String!) { addComment(input: {subjectId: \"I_1\", body: $b}) { clientMutationId } }' -f b=Release",
      "other",
    ],
    [
      "a GraphQL query from a file it cannot read",
      "gh api graphql -F query=@missing.graphql -f body=release",
      "guarded",
    ],
    [
      "a GraphQL mutation held in a variable set earlier in the command",
      `Q='mutation { addComment(input: {subjectId: "I_1", body: "release"}) { clientMutationId } }'; gh api graphql -f query="$Q"`,
      "other",
    ],
    [
      "a GraphQL query held in a variable set in a subshell",
      `(Q='query { viewer { login } }'); gh api graphql -f query="$Q"`,
      "other",
    ],
    [
      "a GraphQL query held in a variable set in a pipeline",
      `Q='query { viewer { login } }' | cat; gh api graphql -f query="$Q"`,
      "other",
    ],
    ...(
      [
        ["print -v", `print -vQ '${MUTATION}'`],
        ["printf -v", `printf -vQ %s '${MUTATION}'`],
        ["zsh's ${Q::=}", `: \${Q::='${MUTATION}'}`],
      ] as const
    ).map(
      ([how, sets]) =>
        [
          `a GraphQL query in a variable that ${how} sets to a mutation after`,
          `Q='query { viewer { login } }'; ${sets}; gh api graphql -f query="$Q"`,
          "other",
        ] as const,
    ),
    [
      "a GraphQL query in a variable that a name built in typeset sets to a mutation after",
      `A=QU; B=ERY; QUERY='query { viewer { login } }'; typeset -g "$A$B=${MUTATION}"; gh api graphql -f query="$QUERY"`,
      "other",
    ],
    [
      "a mutation a zsh modifier makes from a variable",
      `Q='mutation { addCXomment(input: {subjectId: "I_1", body: "ship"}) { clientMutationId } }'; gh api graphql -f query="$Q:s/X//"`,
      "other",
    ],
    [
      "a GraphQL query in a variable read unquoted after IFS is set",
      `IFS=:; Q='query { viewer { login } }:--input:/abs/mutation.json'; gh api graphql -f query=$Q`,
      "other",
    ],
    [
      "a GraphQL query read in a function body after typeset sets the variable to a mutation",
      `QUERY='query { viewer { login } }'; function f { gh api graphql -f query="$QUERY"; }; typeset QU""ERY='${MUTATION}'; f`,
      "other",
    ],
    [
      "a GraphQL query read in a while condition whose body sets the variable to a mutation",
      `QUERY='query { viewer { login } }'; while gh api graphql -f query="$QUERY"; do typeset QU""ERY='${MUTATION}'; done`,
      "other",
    ],
    [
      "a GraphQL query read in an until condition whose body sets the variable to a mutation",
      `QUERY='query { viewer { login } }'; until ! gh api graphql -f query="$QUERY"; do typeset QU""ERY='${MUTATION}'; done`,
      "other",
    ],
    [
      "a GraphQL query read in a zsh repeat body that sets the variable to a mutation",
      `QUERY='query { viewer { login } }'; repeat 2 { gh api graphql -f query="$QUERY"; typeset QU""ERY='${MUTATION}' }`,
      "other",
    ],
    [
      "a GraphQL query read in a DEBUG trap that sets the variable to a mutation",
      `trap 'typeset QU""ERY=${MUTATION}' DEBUG; QUERY='query { viewer { login } }'; gh api graphql -f query="$QUERY"`,
      "other",
    ],
    [
      "a GraphQL query read in an alias that sets the variable to a mutation",
      `alias gh='typeset QU""ERY=${MUTATION}; command gh'
QUERY='query { viewer { login } }'
gh api graphql -f query="$QUERY"`,
      "other",
    ],
    [
      "a GraphQL query in a variable set in a case branch",
      `case b in a) Q='query { viewer { login } }';; esac; gh api graphql -f query="$Q"`,
      "other",
    ],
    [
      "a GraphQL query in a variable read unquoted, which bash splits into --input",
      `Q='query { viewer { login } } --input /abs/mutation.json'; gh api graphql -f query=$Q`,
      "other",
    ],
  ] as const)("refuses %s", async (_, command, dir) => {
    expect(await bash(command, where(dir))).toContain("no-release-comment hook refused")
  })

  test.each([
    ["a read of comments", 'gh api repos/qmarsh/demo/issues/1/comments --jq ".[].body"'],
    ["a GET with fields", 'gh api -X GET search/issues -f q="release"'],
    ["another owner", "gh api repos/acme-labs/demo/issues/1/comments -f body=release"],
    ["an endpoint that is not a comment", 'gh api repos/qmarsh/demo/releases --jq ".[0].tag_name"'],
    [
      "a GraphQL query",
      'gh api graphql -f query=\'query { repository(owner: "qmarsh", name: "demo") { releases(last: 1) { nodes { tagName } } } }\'',
    ],
    ["a clean body", 'gh api repos/qmarsh/demo/issues/1/comments -f body="ship it"'],
    [
      "a GraphQL query with variables written in the command itself",
      `gh api graphql -f query='query($n: Int!) { viewer { repositories(first: $n) { totalCount } } }' -F n=5`,
    ],
  ])("allows %s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("refuses a GraphQL query held in a variable with a reason that names the query written in the command itself", async () => {
    const reason = await bash(`Q='query { viewer { login } }'; gh api graphql -f query="$Q"`)
    expect(reason).toContain("the hook cannot read its text")
    expect(reason).toContain(
      "Write the query and each of its fields in the command itself, not in a variable",
    )
  })
})

describe("curl to the GitHub API", () => {
  test("refuses a comment that contains the word", async () => {
    const command = `curl -sS -X POST -H "Authorization: token x" https://api.github.com/repos/qmarsh/demo/issues/1/comments -d '{"body":"release"}'`
    expect(await bash(command)).toContain("no-release-comment hook refused")
  })

  test.each([
    ["a read", "curl -sS https://api.github.com/repos/qmarsh/demo/issues/1/comments"],
    [
      "another owner",
      `curl -sS https://api.github.com/repos/acme-labs/demo/issues/1/comments -d '{"body":"release"}'`,
    ],
  ])("allows %s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("GitHub MCP comments", () => {
  const tools = [
    "add_comment_to_pending_review",
    "add_issue_comment",
    "add_reply_to_pull_request_comment",
    "pull_request_review_write",
    "update_issue_comment",
  ]

  test.each(
    tools.flatMap((tool) => ["Release", "RELEASED", "a prerelease"].map((body) => [tool, body])),
  )("refuses %s with %p", async (tool, body) => {
    const reason = await mcp(`mcp__github-shared__${tool}`, {
      body,
      owner: "qmarsh",
      pullNumber: 2,
      repo: "demo",
    })
    expect(reason).toContain(`refused github-shared__${tool} on qmarsh/demo`)
    expect(reason).toContain('Write "ship" or "publish step" instead')
  })

  test("refuses a body on a server under another name", async () => {
    expect(
      await mcp("mcp__github__add_issue_comment", {
        body: "release",
        owner: "qmarsh",
        repo: "demo",
      }),
    ).toContain("refused")
  })

  test("refuses when the owner is missing", async () => {
    expect(
      await mcp("mcp__github-shared__add_issue_comment", { body: "release", repo: "demo" }),
    ).toContain("a repository the hook cannot resolve")
  })

  test("refuses a body that is not text", async () => {
    expect(
      await mcp("mcp__github-shared__add_issue_comment", {
        body: ["release"],
        owner: "qmarsh",
        repo: "demo",
      }),
    ).toContain("not text")
  })

  test.each([
    ["another owner", "add_issue_comment", { body: "release", owner: "acme-labs", repo: "demo" }],
    ["a clean body", "add_issue_comment", { body: "Ready to ship", owner: "qmarsh", repo: "demo" }],
    [
      "no body",
      "pull_request_review_write",
      { method: "delete_pending", owner: "qmarsh", pullNumber: 2, repo: "demo" },
    ],
    [
      "a reaction",
      "add_issue_comment",
      { issue_number: 2, owner: "qmarsh", reaction: "rocket", repo: "demo" },
    ],
  ] as const)("allows %s", async (_, tool, input) => {
    expect(await mcp(`mcp__github-shared__${tool}`, input)).toBeUndefined()
  })

  test("leaves other tools alone", async () => {
    expect(
      await mcp("mcp__github-shared__issue_write", {
        body: "release",
        owner: "qmarsh",
        repo: "demo",
      }),
    ).toBeUndefined()
  })
})

describe("its input", () => {
  test("refuses input it cannot parse that reads as a comment", async () => {
    expect(await check("{ not json: gh pr comment 1 -b release", {})).toContain("could not parse")
  })

  test("allows input it cannot parse that reads as no comment", async () => {
    expect(await check("{ not json: release", {})).toBeUndefined()
  })

  test("an error inside the hook refuses a comment call and lets any other call run", async () => {
    const deep = "$(".repeat(200_000)
    expect(await bash(`gh pr view 1 --comments && echo ${deep}`)).toBeUndefined()
    expect(await bash(`gh pr comment 1 -b ship && echo ${deep}`)).toContain(
      "could not read this call",
    )
  })

  test("reads GH_REPO from the session's environment", async () => {
    const payload = JSON.stringify({
      cwd: other,
      tool_input: { command: "gh pr comment 3 -b release" },
      tool_name: "Bash",
    })
    expect(await check(payload, { GH_REPO: "qmarsh/gitpick" })).toContain("qmarsh/gitpick")
    expect(await check(payload, {})).toBeUndefined()
  })
})

describe("as Claude Code runs it", () => {
  const settings = async () =>
    (await Bun.file(join(root, ".claude", "settings.json")).json()) as {
      hooks: { PreToolUse: { hooks: { command: string; type: string }[]; matcher: string }[] }
    }

  const entry = async () => {
    const found = (await settings()).hooks.PreToolUse.find((e) =>
      e.hooks.some((h) => h.command.includes("scripts/hooks/bundled/no-release-comment.js")),
    )
    if (!found) throw new Error(".claude/settings.json registers no no-release-comment hook")
    return found
  }

  test("the matcher takes every GitHub MCP comment tool, and nothing else, Bash reaching it through guards", async () => {
    const matcher = new RegExp((await entry()).matcher)
    for (const tool of [
      "mcp__github-shared__add_comment_to_pending_review",
      "mcp__github-shared__add_issue_comment",
      "mcp__github-shared__add_reply_to_pull_request_comment",
      "mcp__github-shared__pull_request_review_write",
      "mcp__github-shared__update_issue_comment",
      "mcp__github__add_issue_comment",
      "mcp__GitHub__add_issue_comment",
    ]) {
      expect(matcher.test(tool)).toBe(true)
    }
    for (const tool of [
      "Bash",
      "Read",
      "BashOutput",
      "mcp__github-shared__issue_read",
      "mcp__slack-shared__chat_post_message",
    ]) {
      expect(matcher.test(tool)).toBe(false)
    }
  })

  const hook = async (
    payload: object,
    cwd = plain,
    project = root,
    env: Record<string, string> = {},
  ) => {
    const [{ command }] = (await entry()).hooks
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        GIT_CEILING_DIRECTORIES: scratch,
        PLAYGROUND_DATA_DIR: owned,
        PLAYGROUND_REPO: project,
        ...env,
      },
      stderr: "pipe",
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: "pipe",
    })
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
  }

  test("its command exits 2 with the reason on stderr when it refuses", async () => {
    const result = await hook({
      cwd: plain,
      tool_input: { command: "gh pr comment 3 -R qmarsh/demo -b Release" },
      tool_name: "Bash",
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Write "ship" or "publish step" instead')
  })

  test("its command exits 0 and says nothing when it allows", async () => {
    expect(
      await hook({
        cwd: plain,
        tool_input: { command: "gh pr comment 3 -R qmarsh/demo -b ship" },
        tool_name: "Bash",
      }),
    ).toEqual({
      code: 0,
      stderr: "",
    })
  })

  test("its command runs from the project, so a broken bunfig.toml in the session's cwd blocks nothing", async () => {
    const broken = join(scratch, "broken")
    await Bun.write(join(broken, "bunfig.toml"), "[install\n")
    await Bun.write(join(broken, ".env"), "GH_REPO=acme-labs/demo\n")
    const payload = (command: string) => ({
      cwd: broken,
      tool_input: { command },
      tool_name: "Bash",
    })
    expect(await hook(payload("ls"), broken)).toEqual({ code: 0, stderr: "" })
    expect(await hook(payload("gh pr comment 3 -R acme-labs/demo -b ship"), broken)).toEqual({
      code: 0,
      stderr: "",
    })
    expect((await hook(payload("gh pr comment 3 -R qmarsh/demo -b Release"), broken)).code).toBe(2)
  })

  test("a hook that finds no checkout refuses a factory session's call and lets any other through", async () => {
    const payload = {
      cwd: plain,
      tool_input: { command: "gh pr comment 3 -R qmarsh/demo -b Release" },
      tool_name: "Bash",
    }
    const refused = await hook(payload, plain, scratch, { PLAYGROUND_ROLE: "worker" })
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("Restoring the main checkout")
    expect(await hook(payload, plain, scratch, { PLAYGROUND_ROLE: "" })).toEqual({
      code: 0,
      stderr: "",
    })
  })

  test("the script runs on its own", async () => {
    const proc = Bun.spawn(["bun", script], {
      env: { ...process.env, PLAYGROUND_DATA_DIR: owned },
      stderr: "pipe",
      stdin: new Blob([
        JSON.stringify({
          tool_input: { body: "release", owner: "qmarsh", repo: "demo" },
          tool_name: "mcp__github-shared__add_issue_comment",
        }),
      ]),
    })
    expect(await proc.exited).toBe(2)
  })
})
