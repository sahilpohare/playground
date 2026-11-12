import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check, mainCheckout } from "../../../scripts/hooks/no-main-checkout"

// The worktree path every refusal gives: absolute, beside the main checkout's .git, so none nests in another worktree (AGENTS.md's Workflow rule).
const ABS_WORKTREE =
  '"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<name>"'

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-main-checkout.ts")
// real directories, since the reader follows a cd only into one that exists
const MAIN = mkdtempSync(join(tmpdir(), "no-main-checkout-main-"))
const WORKTREE = `${MAIN}/.claude/worktrees/a`
mkdirSync(join(WORKTREE, "api", "hono"), { recursive: true })
writeFileSync(join(WORKTREE, ".git"), `gitdir: ${MAIN}/.git/worktrees/a\n`)
afterAll(() => rmSync(MAIN, { force: true, recursive: true }))
// the settings the main checkout's packages build needs, as the release skill's step 5 types them
const OFF = "env NODE_ENV=production SKIP_ENV_VALIDATION=true"

const bash = (command: string, cwd = MAIN) =>
  check(
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    { HOME: "/u" },
    MAIN,
  )

describe("a build, a test run, lefthook, turbo or a file write in the main checkout is refused, with the fix", () => {
  test.each([
    ["the reviewer's pre-commit run", "lefthook run pre-commit"],
    ["lefthook through bunx", "bunx lefthook run pre-commit"],
    ["lefthook by its path", "node_modules/.bin/lefthook run pre-commit"],
    ["a commit, which runs pre-commit", "git commit -m 'chore: x'"],
    ["bun run build", "bun run build"],
    ["bun run test", "bun run test"],
    ["bun run check-types", "bun run check-types"],
    ["bun test", "bun test tests/scripts/hooks"],
    ["bun run test:file", "bun run test:file tests/scripts/hooks"],
    ["bun run test:file naming no file", "bun run test:file"],
    ["bun run test:file past --cwd", "bun run --cwd . test:file tests/a.test.ts"],
    ["turbo", "turbo run build"],
    ["turbo through bun x", "bun x turbo run build"],
    ["turbo past the packages", "turbo run build --filter=@web/next"],
    [
      "the packages build with another filter",
      "turbo run build --filter=./packages/* --filter=@web/next",
    ],
    ["the packages build forced", "turbo run build --filter=./packages/* --force"],
    ["the packages' dev", "turbo run dev --filter=./packages/*"],
    ["the packages' type check", "turbo run check-types --filter=./packages/*"],
    ["another build through bunx", "bunx turbo run build"],
    ["another build through npx", "npx turbo run build --filter=@web/next"],
    [
      "the packages build then a test run",
      `${OFF} turbo run build --filter=./packages/* && bun run test`,
    ],
    ["a redirect", "echo hi > notes.txt"],
    ["an appending redirect", "date >> log.txt"],
    ["a curl cookie jar", "curl -sS -c cookies.txt -X POST https://api.example"],
    ["a curl output file", "curl -o out.json https://example.com"],
    ["a curl output file, attached", "curl --output=out.json https://example.com"],
    ["cp into it", "cp /tmp/a b.txt"],
    ["mv into it", "mv /tmp/a b.txt"],
    ["touch", "touch stray"],
    ["tee", "echo hi | tee stray"],
    ["sed -i, BSD's, as #299's stray edit ran", "sed -i '' 's/a/b/' scripts/ops/run-slot.sh"],
    ["sed -i, GNU's", "sed -i 's/a/b/' notes.txt"],
    ["sed -i with a suffix", "sed -i.bak 's/a/b/' notes.txt"],
    ["sed --in-place past -e", "sed --in-place -e 's/a/b/' notes.txt"],
    ["sed with -i among its flags", "sed -Ei 's/a/b/' notes.txt"],
    ["perl -pi -e", "perl -pi -e 's/a/b/' notes.txt"],
    ["perl -i past its other flags", "perl -0777 -i -pe 's/a/b/' notes.txt"],
    ["sed -i past a flag group ending in E", "sed -nE -i 's/a/b/' notes.txt"],
    ["sed -i with its script attached to -e, quoted", "sed -i -e's/a/b/' notes.txt"],
    ["sed -i with its script attached to -e", "sed -i -es/a/b/ notes.txt"],
    ["sed --in-place with --expression=", "sed --in-place --expression=s/a/b/ notes.txt"],
    ["sed --in-place with --file=", "sed --in-place --file=edit.sed notes.txt"],
    ["perl -i after -0 in one flag group", "perl -0pi -e 's/a/b/' notes.txt"],
    ["perl -i after -0's digits in one flag group", "perl -0777pi -e 's/a/b/' notes.txt"],
    ["BSD sed -I with a suffix word", "sed -I .bak 's/a/b/' notes.txt"],
    ["BSD sed -I with an empty suffix", "sed -I '' 's/a/b/' notes.txt"],
    ["git add, which moves the index", "git add -A"],
    [
      "a commit through run-slot, as #299's ran",
      "~/.playground/ops/run-slot.sh w -- env NODE_ENV=production SKIP_ENV_VALIDATION=true git commit -q -F /tmp/m.txt",
    ],
    ["a build through run-slot", "~/.playground/ops/run-slot.sh w -- bun run build"],
    ["a write through run-slot", "~/.playground/ops/run-slot.sh w -- sed -i 's/a/b/' notes.txt"],
    ["a commit through bash run-slot", "bash ~/.playground/ops/run-slot.sh w -- git commit -m x"],
    ["a build through sh -e run-slot", "sh -e ~/.playground/ops/run-slot.sh w -- bun run build"],
    ["a commit in zsh -O -c, whose -O takes no value", "zsh -O -c 'git commit -m x'"],
    ["a commit in zsh -c -O, whose -O takes no value", "zsh -c -O 'git commit -m x'"],
    [
      "a commit through bash -O run-slot",
      "bash -O extglob ~/.playground/ops/run-slot.sh w -- git commit -m x",
    ],
    [
      "a commit through bash +O run-slot",
      "bash +O extglob ~/.playground/ops/run-slot.sh w -- git commit -m x",
    ],
    [
      "a commit through bash --rcfile run-slot",
      "bash --rcfile /tmp/rc ~/.playground/ops/run-slot.sh w -- git commit -m x",
    ],
    [
      "a commit through bash --init-file run-slot",
      "bash --init-file /tmp/rc ~/.playground/ops/run-slot.sh w -- git commit -m x",
    ],
    ["inside a shell it starts", "bash -c 'lefthook run pre-commit'"],
    [
      "lefthook started by bun, as lefthook.yml spells it",
      "bun node_modules/.bin/lefthook run pre-commit",
    ],
    ["lefthook as a bun script", "bun run lefthook run pre-commit"],
    ["turbo as a bun script", "bun run turbo run build"],
    ["a script past bun's --filter", "bun run --filter @packages/env build"],
    [
      "a --cwd after the script, which bun hands the script",
      "bun run build --cwd .claude/worktrees/a",
    ],
    ["a --cwd after --, which bun hands the script", "bun run test -- --cwd .claude/worktrees/a"],
    ["check-types by its bare name", "bun check-types"],
    ["a bare build under --filter, which is the script", "bun --filter '*' build"],
    ["a bare build under --filter=", "bun --filter='*' build"],
    ["a bare build under -F", "bun -F @packages/env build"],
    ["after other commands", "git status && bun run build"],
    ["turbo through bunx past an option", "bunx --bun turbo run build"],
    [
      "bun's --cwd before x, which bun x ignores",
      "bun --cwd=.claude/worktrees/a x turbo run build",
    ],
    ["bun's --cwd after x, which bun x ignores", "bun x --cwd=.claude/worktrees/a turbo run build"],
    ["bunx's --cwd, which it ignores", "bunx --cwd=.claude/worktrees/a turbo run build"],
    [
      "lefthook through bunx past its ignored --cwd",
      "bunx --cwd=.claude/worktrees/a lefthook run pre-commit",
    ],
  ])("%s", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-main-checkout hook refuses")
    expect(reason).toContain(".claude/worktrees/")
    // the worktree start it advises writes no branch config into the shared .git/config, which Claude Code's sandbox refuses
    expect(reason).toContain(
      `git worktree add --no-track ${ABS_WORKTREE} -b <branch> origin/canary`,
    )
  })

  test.each([
    ["the packages build with no settings", "turbo run build --filter='./packages/*'"],
    ["the packages build through bunx", "bunx turbo run build --filter='./packages/*'"],
    [
      "the packages build as the release skill types it, its settings left out",
      `${MAIN}/node_modules/.bin/turbo run build --filter='./packages/*' --cwd ${MAIN}`,
    ],
    [
      "the packages build with only one setting",
      "env SKIP_ENV_VALIDATION=true turbo run build --filter='./packages/*'",
    ],
    [
      "the packages build with validation left on",
      "env NODE_ENV=production SKIP_ENV_VALIDATION=false turbo run build --filter='./packages/*'",
    ],
  ])("%s, since the main checkout has no .env", async (_name, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-main-checkout hook refuses")
    expect(reason).toContain(OFF)
  })

  // #573: a cd the shell may not run, or one whose folder the hook cannot read, leaves the folder unknown, which this hook reads as the folder the line started in
  test.each([
    ["a cd to a word it cannot read", "cd $DIR && bun run build"],
    ["a cd to a folder that is not there", `cd ${MAIN}/.no-such-folder; bun run build`],
    ["a cd the shell runs only on the one before it", `true || cd ${WORKTREE}; bun run build`],
    ["a cd in a then branch", `if false; then cd ${WORKTREE}; fi; git commit -m x`],
    ["a cd in a loop's body", `for i in 1 2; do cd ${WORKTREE}; done; git commit -m x`],
    ["a cd env cannot run", `env cd ${WORKTREE}; git commit -m x`],
    ["a backgrounded cd", `cd ${WORKTREE} & bun run build`],
    ["a cd in a pipeline", `cd ${WORKTREE} | cat; bun run build`],
    ["a popd", `pushd ${WORKTREE}; popd; bun run build`],
    ["a cd back", `cd ${WORKTREE}; cd -; bun run build`],
    ["a write after a cd it cannot read", "cd $DIR && echo x > stray.txt"],
    [
      "a readable cd into a worktree, then one it cannot read",
      `cd ${WORKTREE}; cd $D; bun run build`,
    ],
  ])("from the main checkout, %s is judged in every folder it may run in", async (_n, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-main-checkout hook refuses")
    expect(reason).toContain("every folder the shell may be in")
  })

  // #573: a body's own cd stays a folder the shell may be in, while the folder the line is in is still named, so the refusal names that folder's own fix
  test("from the main checkout, a cd in a function's body, never called, is refused", async () => {
    const reason = await bash(`f() { cd ${WORKTREE}; }; git commit -m x`)
    expect(reason).toContain("no-main-checkout hook refuses")
    expect(reason).toContain("Run it in your own worktree")
  })

  // #573: the folder a sure cd lands in is the one the commands after it run from, and a reserved word an argument spells opens and closes no body
  test.each([
    ["a readable cd into a worktree", `cd ${WORKTREE} && bun run build`],
    ["a cd into a worktree by builtin", `builtin cd ${WORKTREE} && git commit -m x`],
    ["a cd into a worktree by command", `command cd ${WORKTREE} && git commit -m x`],
    ["a second cd into a subfolder of it", `cd ${WORKTREE} && cd packages && git commit -m x`],
    ["an argument that spells an opener before it", `echo if; cd ${WORKTREE} && bun run build`],
    [
      "an argument that spells a closer before it",
      `grep -q done f; cd ${WORKTREE} && bun run build`,
    ],
    ["a function whose body holds no cd", `function f { :; }; cd ${WORKTREE} && bun run build`],
    ["a brace group that holds no cd", `{ echo hi; }; cd ${WORKTREE} && bun run build`],
  ])("from the main checkout, %s runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  // #573: a cd an && joins to the commands after it has certainly run for each of them, since a cd that does not run, or fails, stops the chain before them: so the folder it names is the one they run from, whether or not that folder is there when the hook reads the line
  test.each([
    ["a chained cd into a worktree", `true && cd ${WORKTREE} && bun run build`],
    [
      "a chained cd after a real command",
      `git fetch -q origin canary && cd ${WORKTREE} && git add -A`,
    ],
    ["two chained cds, the second into a worktree", `cd ${MAIN} && cd ${WORKTREE} && git add -A`],
    [
      "a chained cd into the worktree the same line makes, as the Workflow rule types it",
      `git fetch origin canary && git worktree add ${MAIN}/.claude/worktrees/new -b PG-1-x origin/canary && cd ${MAIN}/.claude/worktrees/new && git merge origin/canary --no-edit`,
    ],
    [
      "a chained cd into the folder mkdir makes",
      `mkdir -p ${WORKTREE}/sub && cd ${WORKTREE}/sub && git commit -m x`,
    ],
    [
      "a twice-negated chained cd, whose status is the cd's own again",
      `true && ! ! cd ${WORKTREE} && git commit -m x`,
    ],
    ["a chained cd, then a script sh runs", `true && cd ${WORKTREE} && sh -c "git add -A"`],
    ["a chained cd, then an eval", `true && cd ${WORKTREE} && eval "git add -A"`],
    ["a subshell the chain reaches", `true && cd ${WORKTREE} && (git commit -m x)`],
    [
      "a chain carried on past an eval that holds its own",
      `eval 'true && cd ${WORKTREE}' && git commit -m x`,
    ],
    ["an eval whose cd is sure", `eval 'cd ${WORKTREE}'; git commit -m x`],
    ["a substitution the run reaches", `true && cd ${WORKTREE} && echo $(git commit -m x)`],
    [
      "a pipeline's own stage, which runs with the command the run reached",
      `true && cd ${WORKTREE} && echo x | tee stray.txt`,
    ],
    ["a brace group the chain reaches", `true && cd ${WORKTREE} && { git commit -m x; }`],
    ["an if the chain reaches", `true && cd ${WORKTREE} && if true; then git commit -m x; fi`],
    ["a loop the chain reaches", `true && cd ${WORKTREE} && for i in 1; do git commit -m x; done`],
  ])("from the main checkout, %s runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("a pipe into a shell from the main checkout is refused, since its script is unread", async () => {
    expect(await bash("bun run ask list | sh")).toContain("no-main-checkout hook refuses")
  })

  test("a pipe into a shell from the main checkout is judged by the script it reads", async () => {
    expect(await bash("echo 'git commit -m x' | sh")).toContain(
      "git commit, which runs lefthook's pre-commit",
    )
    expect(await bash("echo 'git status' | sh")).toBeUndefined()
  })

  test("a root shell from the main checkout is judged by the script file it reads", async () => {
    writeFileSync(join(MAIN, "commit.sh"), "git commit -m x\n")
    writeFileSync(join(MAIN, "status.sh"), "git status\n")
    for (const input of ["<", "0<"])
      expect(await bash(`sudo -s ${input} ${MAIN}/commit.sh`)).toContain(
        "git commit, which runs lefthook's pre-commit",
      )
    expect(await bash(`sudo -s < ${MAIN}/status.sh`)).toBeUndefined()
  })

  test.each([
    ["xargs sh -c", "| xargs sh -c"],
    ["xargs with a placeholder script", "| xargs -I{} sh -c {}"],
    ["a while loop piped into a shell", "| while read l; do echo $l; done | sh"],
    [". /dev/stdin", "| . /dev/stdin"],
    ["source /dev/stdin", "| source /dev/stdin"],
    ["sh -c of a substitution reading stdin", '| sh -c "$(cat)"'],
  ])(
    "a script's output handed to a shell through %s is judged as a pipe into one",
    async (_name, tail) => {
      expect(await bash(`bun run ask list ${tail}`)).toContain("no-main-checkout hook refuses")
      expect(await bash(`echo 'git commit -m x' ${tail}`)).toContain(
        "no-main-checkout hook refuses",
      )
    },
  )

  const interpreters: [string, string][] = [
    ["node", "| node"],
    ["python3", "| python3"],
    ["perl", "| perl"],
    ["ruby", "| ruby"],
    ["osascript", "| osascript"],
    ["bun -", "| bun -"],
    ["python3 -", "| python3 -"],
    ["node /dev/stdin", "| node /dev/stdin"],
    ["deno run -", "| deno run -"],
    ["nice python3 -", "| nice python3 -"],
    ["xargs node", "| xargs node"],
    ["xargs python3", "| xargs python3"],
    ["xargs perl", "| xargs perl"],
    ["xargs ruby", "| xargs ruby"],
    ["xargs osascript", "| xargs osascript"],
    ["xargs bun -", "| xargs bun -"],
    ["xargs running node -e on each line", "| xargs -I{} node -e {}"],
    ["xargs perl -e", "| xargs perl -e"],
    ["a while loop handing each line to python3", "| while read l; do python3; done"],
  ]

  test.each([
    [". /dev/fd/0", "| . /dev/fd/0"],
    ["source /dev/fd/0", "| source /dev/fd/0"],
    [". /proc/self/fd/0", "| . /proc/self/fd/0"],
    [". -", "| . -"],
    ["eval of a substitution reading stdin", '| eval "$(cat)"'],
    ["sh -c of a quoted substitution", "| sh -c '$(cat)'"],
    ["sh -", "| sh -"],
    ["sh /dev/stdin", "| sh /dev/stdin"],
    ["bash of a process substitution", "| bash <(cat)"],
    ["a while loop that evals each line", "| while read l; do eval $l; done"],
    ["sh -c sourcing stdin", "| sh -c '. /dev/stdin'"],
    ["sh -c piping stdin into a shell", "| sh -c 'cat | sh'"],
    ["xargs running $SHELL", "| xargs -I{} $SHELL -c {}"],
    ["$SHELL -", "| $SHELL -"],
    ["env -i bash -s", "| env -i bash -s"],
    ["command eval", '| command eval "$(cat)"'],
    ["nice sh /dev/fd/0", "| nice sh /dev/fd/0"],
    ["a brace group that evals a line", '| { read a; eval "$a"; }'],
    ["an until loop handing each line to sh -c", '| until ! read l; do sh -c "$l"; done'],
    ...interpreters,
  ])(
    "a script's output piped into %s, a command that can run its input as code, is judged as a pipe into a shell",
    async (_name, tail) => {
      expect(await bash(`bun run ask list ${tail}`)).toContain("no-main-checkout hook refuses")
      expect(await bash(`echo 'git commit -m x' ${tail}`)).toContain(
        "no-main-checkout hook refuses",
      )
    },
  )

  // the hook reads no other language, so even a harmless input it reads is refused when it feeds an interpreter, while a shell fed the same text runs
  test.each(interpreters)(
    "a harmless input the hook reads, piped into %s, is refused from the main checkout",
    async (_name, tail) => {
      expect(await bash(`echo x ${tail}`)).toContain("no-main-checkout hook refuses")
    },
  )

  test("a harmless input the hook reads, piped into sh, runs from the main checkout", async () => {
    expect(await bash("echo x | sh")).toBeUndefined()
  })

  test.each([
    ["xargs sh -c of a script that only reads", "echo 'git status' | xargs sh -c"],
    ["xargs handing words to a script it names", "echo x | xargs sh -c 'echo $0'"],
    ["a while loop piped into a reader", "echo x | while read l; do echo $l; done | cat"],
    ["a script's output piped into a reader", "bun run ask list | cat"],
    ["a script's output handed to grep by xargs", "bun run ask list | xargs grep x"],
    [
      "a script's output read by a loop that runs no code",
      "bun run ask list | while read l; do echo $l; done",
    ],
    ["an eval of a script that only reads, fed by a pipe", "echo x | eval 'git status'"],
    ["a pipe into sh of a script that only reads", "echo 'git status' | sh -"],
    ["a script's output piped into a node script", "bun run ask list | node x.js"],
    ["a script's output piped into a python3 module", "bun run ask list | python3 -m json.tool"],
    ["a script's output piped into an attached python3 module", "echo '{}' | python3 -mjson.tool"],
    [
      "a script's output piped into a node script past a preload",
      "bun run ask list | node -r fs x.js",
    ],
    ["a script's output piped into a script bun runs", "bun run ask list | bun run x.ts"],
    [
      "a script's output piped into a versioned python3's script",
      "bun run ask list | python3.12 x.py",
    ],
    [
      "a script's output handed by xargs to a python3 script",
      "bun run ask list | xargs python3 x.py",
    ],
    ["a script's output piped into jq", "bun run ask list | jq ."],
  ])("from the main checkout, %s runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test.each([
    ["a cd into it", `cd ${MAIN} && bun run build`],
    ["bun's --cwd", `bun run --cwd ${MAIN} build`],
    ["bun's --cwd=", `bun --cwd=${MAIN} test`],
    ["turbo's --cwd", `turbo run build --cwd ${MAIN}`],
    ["turbo's --cwd through bun x", `bun x turbo run build --cwd=${MAIN}`],
    ["bun test's own --cwd after test", `bun test --cwd ${MAIN} tests/x.test.ts`],
    ["git -C", `git -C ${MAIN} commit -m x`],
    ["git -C behind --attr-source's value", `git --attr-source HEAD -C ${MAIN} commit -m x`],
    ["a redirect into it by its path", `echo x > ${MAIN}/stray.txt`],
    ["cp into it by its path", `cp a ${MAIN}/b`],
    ["sed -i on a file in it by its path", `sed -i 's/a/b/' ${MAIN}/scripts/ops/run-slot.sh`],
    ["a commit through run-slot by git -C", `run-slot.sh w -- git -C ${MAIN} commit -m x`],
    ["a cd into it by a path that climbs", `cd ${WORKTREE}/../../.. && bun run build`],
    ["a redirect into it by a path that climbs", `echo x > ${WORKTREE}/../../../stray.txt`],
  ])("from a worktree, %s", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toContain("no-main-checkout hook refuses")
  })
})

// a home whose installed skills and settings link into the main checkout, as link-skills.sh makes them, beside the dispatcher folder's own files
const HOME = mkdtempSync(join(tmpdir(), "no-main-checkout-home-"))
afterAll(() => rmSync(HOME, { force: true, recursive: true }))
mkdirSync(join(MAIN, "skills", "x"), { recursive: true })
mkdirSync(join(MAIN, "scripts"), { recursive: true })
writeFileSync(join(MAIN, "scripts", "factory-settings.json"), "{}")
mkdirSync(join(HOME, ".claude", "skills"), { recursive: true })
mkdirSync(join(HOME, ".playground", "handoffs"), { recursive: true })
symlinkSync(join(MAIN, "skills", "x"), join(HOME, ".claude", "skills", "x"))
symlinkSync(
  join(MAIN, "scripts", "factory-settings.json"),
  join(HOME, ".playground", "factory-settings.json"),
)
symlinkSync(WORKTREE, join(HOME, "wt"))

const tool = (tool_name: string, tool_input: Record<string, unknown>, cwd = MAIN) =>
  check(JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_input, tool_name }), {}, MAIN)

describe("a file tool's write into the main checkout is refused, with the fix", () => {
  test.each([
    ["a Write", "Write", { content: "x", file_path: `${MAIN}/stray.txt` }],
    ["an Edit", "Edit", { file_path: `${MAIN}/AGENTS.md`, new_string: "b", old_string: "a" }],
    ["a MultiEdit", "MultiEdit", { edits: [], file_path: `${MAIN}/AGENTS.md` }],
    ["a NotebookEdit", "NotebookEdit", { new_source: "x", notebook_path: `${MAIN}/n.ipynb` }],
    ["a Write by a relative path", "Write", { content: "x", file_path: "stray.txt" }],
    [
      "a Write into a folder it has yet to make",
      "Write",
      { content: "x", file_path: `${MAIN}/new/deeper/stray.txt` },
    ],
    [
      "a Write through an installed skill's link",
      "Write",
      { content: "x", file_path: `${HOME}/.claude/skills/x/SKILL.md` },
    ],
    [
      "an Edit through the factory settings' link",
      "Edit",
      {
        file_path: `${HOME}/.playground/factory-settings.json`,
        new_string: "b",
        old_string: "a",
      },
    ],
    [
      "a Write by a path that climbs out of a worktree",
      "Write",
      { content: "x", file_path: `${WORKTREE}/../../../stray.txt` },
    ],
  ])("%s", async (_name, name, input) => {
    const reason = await tool(name, input)
    expect(reason).toContain("no-main-checkout hook refuses a write to")
    expect(reason).toContain(".claude/worktrees/")
  })

  test.each([
    ["a Write in a worktree", "Write", { content: "x", file_path: `${WORKTREE}/api/hono/a.ts` }],
    [
      "a Write through a link into a worktree",
      "Write",
      { content: "x", file_path: `${HOME}/wt/a.ts` },
    ],
    [
      "a handoff under the dispatcher folder",
      "Write",
      { content: "x", file_path: `${HOME}/.playground/handoffs/a-worker.md` },
    ],
    [
      "the roster under the dispatcher folder",
      "Edit",
      { file_path: `${HOME}/.playground/roster.json`, new_string: "b", old_string: "a" },
    ],
    ["a scratch file", "Write", { content: "x", file_path: "/tmp/scratch/a.md" }],
  ])("%s runs", async (_name, name, input) => {
    expect(await tool(name, input)).toBeUndefined()
  })

  test("an Edit in a worktree by a relative path, from the worktree, runs", async () => {
    const input = { file_path: "api/hono/a.ts", new_string: "b", old_string: "a" }
    expect(await tool("Edit", input, WORKTREE)).toBeUndefined()
  })
})

describe("what keeps the main checkout up to date, or only reads it, runs", () => {
  test.each([
    ["fetch", `git -C ${MAIN} fetch`],
    ["link-skills", "scripts/link-skills.sh"],
    ["link-skills by its path", `${MAIN}/scripts/link-skills.sh`],
    ["the packages build after a pull", `${OFF} turbo run build --filter='./packages/*'`],
    ["the packages build unquoted", `${OFF} turbo run build --filter=./packages/*`],
    ["the packages build with its filter apart", `${OFF} turbo run build --filter './packages/*'`],
    ["the packages build through bun x", `${OFF} bun x turbo run build --filter='./packages/*'`],
    ["the packages build through bunx", `${OFF} bunx turbo run build --filter='./packages/*'`],
    ["the packages build through npx", `${OFF} npx turbo run build --filter='./packages/*'`],
    [
      "the packages build as the release skill types it",
      `${OFF} ${MAIN}/node_modules/.bin/turbo run build --filter='./packages/*' --cwd ${MAIN}`,
    ],
    [
      "the packages build with its settings before it",
      "NODE_ENV=production SKIP_ENV_VALIDATION=true turbo run build --filter='./packages/*'",
    ],
    [
      "the packages build with its settings exported first",
      "export NODE_ENV=production SKIP_ENV_VALIDATION=true && turbo run build --filter='./packages/*'",
    ],
    ["git status", "git status --short"],
    ["git log", "git log --oneline -3"],
    ["a read", "cat README.md"],
    ["a search", "grep -rn hook scripts/hooks"],
    ["output to /dev/null", "ls > /dev/null 2>&1"],
    ["stderr into stdout", "git status 2>&1"],
    ["a write outside it", "echo hi > /tmp/x"],
    ["cp out of it", "cp README.md /tmp/readme"],
    ["sed with no -i, to stdout", "sed -n 's/a/b/p' notes.txt"],
    ["sed -i, GNU's, on a file outside it", "sed -i 's/a/b/' /tmp/x"],
    ["sed -i, BSD's, on a file outside it", "sed -i '' 's/a/b/' /tmp/x"],
    ["perl -pi -e on a file outside it", "perl -pi -e 's/a/b/' /tmp/x"],
    ["perl with a module holding an i, no -i", "perl -Mstrict scripts/x.pl notes.txt"],
    ["perl -C holding an i, no -i", "perl -Ci -ne 'print' notes.txt"],
    ["perl -F holding an i, no -i", "perl -Fi -lane 'print' notes.txt"],
    ["BSD sed -i with a suffix word, on a file outside it", "sed -i .bak 's/a/b/' /tmp/x"],
    ["a read through run-slot", "~/.playground/ops/run-slot.sh w -- git status --short"],
    [
      "a commit through run-slot in a worktree by git -C",
      `~/.playground/ops/run-slot.sh w -- env K=V git -C ${WORKTREE} commit -m x`,
    ],
    ["run-slot with no command", "~/.playground/ops/run-slot.sh w"],
    ["a read through bash run-slot", "bash ~/.playground/ops/run-slot.sh w -- git status --short"],
    ["another script through bash", "bash scripts/other.sh w -- git commit -m x"],
    ["curl to stdout", "curl -sS https://example.com"],
    ["curl to stdout by -o -", "curl -sS -o - https://example.com"],
    ["turbo in a worktree by its --cwd", "turbo run build --cwd .claude/worktrees/a"],
    [
      "turbo through bun x in a worktree by its --cwd",
      "bun x turbo run build --cwd .claude/worktrees/a",
    ],
    ["test:skills", "bun run test:skills"],
    ["bun's own bundler", "bun build ./x.ts --outdir /tmp/out"],
    [
      "bun test's own --cwd after test, into a worktree",
      "bun test --cwd .claude/worktrees/a tests/x.test.ts",
    ],
    ["a worktree's start", "git worktree add .claude/worktrees/x -b pg-1-x origin/canary"],
    ["a worktree's end", "git worktree remove --force .claude/worktrees/x"],
    ["worktree prune", "git worktree prune"],
    ["worktree list", "git worktree list"],
    ["a PR's head", "git fetch origin pull/12/head:refs/remotes/pr/12"],
    ["a branch's end", "git branch -D pg-1-x"],
    ["ls-remote", "git ls-remote origin refs/heads/canary"],
    ["rev-parse", "git rev-parse HEAD"],
    ["diff", "git diff --stat origin/canary...HEAD"],
    ["show", "git show origin/canary:AGENTS.md"],
    ["merge-tree", "git merge-tree --write-tree origin/canary HEAD"],
    ["a -C after the subcommand is the subcommand's", `git -C ${WORKTREE} commit -C HEAD`],
    ["an install into a worktree", "bun install --cwd .claude/worktrees/x"],
    ["a build in a worktree by bun's --cwd", "bun run --cwd .claude/worktrees/a build"],
    ["a test run in a worktree by bun's --cwd", "bun run --cwd .claude/worktrees/a test"],
    ["a build in a worktree by bun's --cwd=", "bun --cwd=.claude/worktrees/a run build"],
    [
      "the packages build through bun x past an ignored --cwd",
      `${OFF} bun --cwd=.claude/worktrees/a x turbo run build --filter='./packages/*'`,
    ],
    [
      "the packages build through bunx past an ignored --cwd",
      `${OFF} bunx --cwd=.claude/worktrees/a turbo run build --filter='./packages/*'`,
    ],
  ])("%s", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("the packages build with its settings in the session's own environment", async () => {
    const raw = JSON.stringify({
      cwd: MAIN,
      hook_event_name: "PreToolUse",
      tool_input: { command: "turbo run build --filter='./packages/*'" },
      tool_name: "Bash",
    })
    const environment = { HOME: "/u", NODE_ENV: "production", SKIP_ENV_VALIDATION: "true" }
    expect(await check(raw, environment, MAIN)).toBeUndefined()
  })

  test.each([
    ["the packages build with no settings", "turbo run build --filter='./packages/*'"],
    ["bun run build", "bun run build"],
    ["lefthook", "lefthook run pre-commit"],
    ["a redirect", "echo x > f"],
    ["a cd within it", "cd api/hono && bun test"],
  ])("in a worktree, %s", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toBeUndefined()
  })

  test("from a worktree, a cd the hook cannot follow leaves the command alone", async () => {
    expect(await bash("cd $DIR && bun run build", WORKTREE)).toBeUndefined()
  })

  // #573: a cd the shell may not run, may run many times, or runs through a builtin wrapper reaches the main checkout from a worktree, so each folder it may leave the shell in is judged
  test.each([
    [
      "a relative cd past the worktree's own root",
      `true || cd ${HOME}; cd ../../..; git commit -m x`,
    ],
    ["a relative cd a count runs three times", "repeat 3 cd ..; git commit -m x"],
    ["a relative cd a loop's body holds", "for i in 1 2 3; do cd ..; done; git commit -m x"],
    [
      "a function body's cd a later cd does not undo",
      `f() { cd ${MAIN}; }; cd ${HOME}; f; git commit -m x`,
    ],
    ["the cd a pipeline's last element runs", `echo | cd ${MAIN}; git commit -m x`],
    ["a cd builtin runs", `builtin cd ${MAIN}; git commit -m x`],
    ["a cd command runs", `command cd ${MAIN}; git commit -m x`],
  ])("from a worktree, %s is refused", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toContain("no-main-checkout hook refuses")
  })

  // #1663: a climb the shell runs once reaches the worktrees folder, which no worktree holds, so git walks up to the main checkout from there
  test.each([
    ["a function whose cd climbs, called once", "f() { cd ..; }; f; git commit -m x"],
    ["an if condition that climbs", "if cd ..; then git commit -m x; fi"],
    ["a single eval of a climb", "eval 'cd ..'; git commit -m x"],
    ["one climb through a variable", "U=..; cd $U; git commit -m x"],
    ["a function called once beside a variable argument", 'f() { cd ..; }; f; git commit -m "$m"'],
  ])("from a worktree, %s is refused", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toContain("no-main-checkout hook refuses")
  })

  // #623: a file a climb writes in the worktrees folder lands in no checkout, and a line with no climb stays where it started
  test.each([
    ["a function called once beside a file of its name", "f() { cd ..; }; f; echo x > f"],
    ["an if condition with a brace argument", "if grep -q { f; then :; fi; git commit -m x"],
    ["a for loop with no cd", "for i in 1 2 3; do echo $i; done; git commit -m x"],
  ])("from a worktree, %s runs", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toBeUndefined()
  })

  // #623: a while's or an until's condition runs at least once, so its cd leaves the main checkout behind
  test.each([
    [
      "a while condition's cd into a worktree",
      `while cd ${WORKTREE} && false; do :; done; git commit -m x`,
    ],
    [
      "an until condition's cd into a worktree",
      `until cd ${WORKTREE}; do :; done; git commit -m x`,
    ],
    ["a while condition's climb out of it", "while cd .. && false; do :; done; git commit -m x"],
    [
      "a while condition's eval of a cd into a worktree",
      `while eval 'cd ${WORKTREE}' && false; do :; done; git commit -m x`,
    ],
  ])("from the main checkout, %s runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("from a worktree, bun's --cwd into another worktree runs", async () => {
    expect(await bash(`bun run --cwd ${MAIN}/.claude/worktrees/b build`, WORKTREE)).toBeUndefined()
  })

  // #1663: what a cd's || runs, runs where the cd failed; after an exit there, or an || that answers a later command of the cd's run, what follows runs where the cd landed
  test.each([
    ["an exit", `cd ${WORKTREE} || exit; git commit -m x`],
    ["an exit with a status", `cd ${WORKTREE} || exit 1; git commit -m x`],
    [
      "a true after a later command of its run",
      `cd ${WORKTREE} && echo x || true; git commit -m x`,
    ],
  ])(
    "from the main checkout, a commit after a cd whose || runs %s runs",
    async (_name, command) => {
      expect(await bash(command)).toBeUndefined()
    },
  )

  test.each([
    ["an echo", `cd ${WORKTREE} || echo no; git commit -m x`],
    ["a cd back", `cd ${WORKTREE} || cd ${MAIN}; git commit -m x`],
    // bash -c carries on past a top-level return, which fails there
    ["a return", `cd ${WORKTREE} || return; git commit -m x`],
    ["a commit after a later command of its run", `cd ${WORKTREE} && echo x || git commit -m x`],
  ])(
    "from the main checkout, a commit after a cd whose || runs %s is refused",
    async (_name, command) => {
      expect(await bash(command)).toContain("no-main-checkout hook refuses")
    },
  )
})

// Each git command that moves HEAD, the index or the files, as a session would type it
const MOVES = [
  ["reset --hard", "reset -q --hard 55ae3262ec"],
  ["a mixed reset", "reset HEAD~1"],
  ["checkout", "checkout 55ae3262ec"],
  ["checkout of a file", "checkout -- README.md"],
  ["switch", "switch -c x"],
  ["restore", "restore README.md"],
  ["merge", "merge origin/playground"],
  ["rebase", "rebase origin/canary"],
  ["rebase --abort", "rebase --abort"],
  ["pull", "pull --ff-only"],
  ["cherry-pick", "cherry-pick 55ae3262ec"],
  ["revert", "revert --no-edit HEAD"],
  ["am", "am /tmp/x.patch"],
  ["apply", "apply /tmp/x.patch"],
  ["stash", "stash push -m x"],
  ["clean", "clean -fdx"],
  ["a forced branch move", "branch -f main 55ae3262ec"],
  ["update-ref", "update-ref refs/heads/main 55ae3262ec"],
  ["bisect", "bisect start HEAD HEAD~1"],
  ["mv", "mv README.md x.md"],
  ["rm", "rm -f README.md"],
]

describe("a git command that moves the main checkout's HEAD, index or files is refused, with the fix", () => {
  test.each(MOVES)("%s, from its own folder", async (_name, words) => {
    const reason = await bash(`git ${words}`)
    expect(reason).toContain("no-main-checkout hook refuses")
    expect(reason).toContain("git -C <your worktree>")
    // #1678: a relative worktree path made from inside another worktree nests in it
    expect(reason).toContain(
      `git worktree add --no-track ${ABS_WORKTREE} -b <branch> origin/canary`,
    )
  })

  test.each(MOVES)("%s, by git -C from a worktree", async (_name, words) => {
    expect(await bash(`git -C ${MAIN} ${words}`, WORKTREE)).toContain(
      "no-main-checkout hook refuses",
    )
  })

  test.each(MOVES)("%s, by --work-tree and --git-dir from elsewhere", async (_name, words) => {
    expect(
      await bash(`git --work-tree=${MAIN} --git-dir=${MAIN}/.git ${words}`, tmpdir()),
    ).toContain("no-main-checkout hook refuses")
    expect(await bash(`git --git-dir ${MAIN}/.git ${words}`, tmpdir())).toContain(
      "no-main-checkout hook refuses",
    )
  })

  test.each([
    ["a cd left in it", `cd ${MAIN} && git reset --hard 55ae3262ec`],
    ["a -C relative to an earlier -C", `git -C ${WORKTREE} -C ../../.. reset --hard HEAD`],
    ["inside a shell it starts", `bash -c 'git -C ${MAIN} checkout 55ae3262ec'`],
    ["a fast-forward to another branch", `git -C ${MAIN} merge --ff-only -q origin/playground`],
    ["a --git-dir with a trailing slash", `git --git-dir=${MAIN}/.git/ reset --hard HEAD`],
    ["git --attr-source before the move", `git -C ${MAIN} --attr-source HEAD checkout 55ae3262ec`],
    [
      "git --namespace with a subcommand for its value",
      `git -C ${MAIN} --namespace log checkout 55ae3262ec`,
    ],
    [
      "a --git-dir of the main checkout beside another --work-tree",
      `git --git-dir ${MAIN}/.git --work-tree ${WORKTREE} reset --hard HEAD`,
    ],
  ])("%s", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toContain("no-main-checkout hook refuses")
  })

  test.each(MOVES)("%s, in a worktree, runs", async (_name, words) => {
    expect(await bash(`git ${words}`, WORKTREE)).toBeUndefined()
    expect(await bash(`git -C ${WORKTREE} ${words}`)).toBeUndefined()
  })

  test.each([
    [
      "the release skill's step 5, as it types it",
      `git -C ${MAIN} fetch -q origin main && git -C ${MAIN} merge --ff-only -q origin/main`,
    ],
    ["status", "git status --short"],
    ["log", "git log --oneline -3"],
    ["reflog", "git reflog --date=iso -5"],
    ["diff", "git diff HEAD~1"],
    ["show", "git show HEAD"],
    ["fetch", "git fetch origin canary"],
    ["rev-parse", "git rev-parse --show-toplevel"],
    ["a worktree's start", "git worktree add .claude/worktrees/x -b fix-x origin/canary"],
    ["worktree list", "git worktree list"],
    ["a worktree's end", "git worktree remove .claude/worktrees/x"],
    ["a branch's end", "git branch -D fix-x"],
    ["a branch list", "git branch --list 'vx-*'"],
    ["stash list", "git stash list"],
    ["a dry clean", "git clean -n"],
    ["a dry add", "git add -n -A"],
    ["a dry add, by its long name", "git add --dry-run ."],
    ["apply --check", "git apply --check /tmp/x.patch"],
  ])("%s in the main checkout runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("git reset --keep origin/main, the one way back from a stray local commit on the main checkout's main", () => {
  const scratch = mkdtempSync(join(tmpdir(), "no-main-checkout-reset-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))
  const AS = {
    ...process.env,
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_AUTHOR_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
  }
  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(["git", ...args], { cwd, env: AS, stderr: "pipe", stdout: "pipe" })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  }
  // A main checkout on main one local commit over origin/main, which no remote holds; each state is its own repo.
  const repo = (name: string, setup?: (main: string) => void) => {
    const origin = join(scratch, `${name}-origin.git`)
    const main = join(scratch, name)
    git(scratch, "init", "-q", "--bare", "-b", "main", origin)
    git(scratch, "clone", "-q", origin, main)
    git(main, "commit", "-q", "--allow-empty", "-m", "shipped")
    git(main, "push", "-q", "origin", "main")
    writeFileSync(join(main, "run-slot.sh"), "stray\n")
    git(main, "add", "run-slot.sh")
    git(main, "commit", "-q", "-m", "stray")
    setup?.(main)
    return main
  }
  const reset = (main: string, command: string) =>
    check(
      JSON.stringify({
        cwd: main,
        hook_event_name: "PreToolUse",
        tool_input: { command },
        tool_name: "Bash",
      }),
      { HOME: "/u" },
      main,
    )

  const stray = repo("stray")
  test.each([
    ["by git -C", `git -C ${stray} reset --keep origin/main`],
    ["by a cd into it", `cd ${stray} && git reset --keep origin/main`],
    ["from its own folder", "git reset --keep origin/main"],
  ])("runs %s, with the tree clean and the commit on no remote", async (_name, command) => {
    expect(await reset(stray, command)).toBeUndefined()
  })

  test.each([
    ["--hard", "git reset --hard origin/main"],
    ["--soft", "git reset --soft origin/main"],
    ["--mixed", "git reset --mixed origin/main"],
    ["a bare reset", "git reset origin/main"],
    ["another target", "git reset --keep HEAD~1"],
    ["--keep with another flag", "git reset --keep -q origin/main"],
  ])("refuses %s", async (_name, command) => {
    expect(await reset(stray, command)).toContain("no-main-checkout hook refuses git reset")
  })

  test.each([
    ["a dirty tree", repo("dirty", (main) => writeFileSync(join(main, "run-slot.sh"), "edit\n"))],
    ["an untracked file", repo("untracked", (main) => writeFileSync(join(main, "new.txt"), "x\n"))],
    [
      "a commit another remote holds",
      repo("pushed", (main) => {
        const mirror = join(scratch, "pushed-mirror.git")
        git(scratch, "init", "-q", "--bare", "-b", "main", mirror)
        git(main, "remote", "add", "mirror", mirror)
        git(main, "push", "-q", "mirror", "main")
      }),
    ],
    ["another branch", repo("branch", (main) => git(main, "checkout", "-q", "-b", "other"))],
  ])("refuses it with %s", async (_name, main) => {
    expect(await reset(main, "git reset --keep origin/main")).toContain(
      "no-main-checkout hook refuses git reset",
    )
  })
})

describe("it fails open", () => {
  test("on input it cannot read", async () => {
    expect(await check("{not json", {}, MAIN)).toBeUndefined()
  })

  test("on a tool it does not judge", async () => {
    const raw = JSON.stringify({ cwd: MAIN, tool_input: { file_path: "x" }, tool_name: "Read" })
    expect(await check(raw, {}, MAIN)).toBeUndefined()
  })

  test("as its own process, on input it cannot read", async () => {
    const proc = Bun.spawn(["bun", "--no-env-file", script], {
      stderr: "pipe",
      stdin: new Blob(["{not json"]),
    })
    expect(await proc.exited).toBe(0)
  })

  test("as its own process, it refuses with exit 2", async () => {
    const raw = JSON.stringify({
      cwd: mainCheckout(root),
      tool_input: { command: "lefthook run pre-commit" },
      tool_name: "Bash",
    })
    const proc = Bun.spawn(["bun", "--no-env-file", script], {
      env: { ...process.env, PLAYGROUND_ROLE: "worker" },
      stderr: "pipe",
      stdin: new Blob([raw]),
    })
    expect(await proc.exited).toBe(2)
    expect(await new Response(proc.stderr).text()).toContain("no-main-checkout hook refuses")
  })
})

describe("mainCheckout", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-main-checkout-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))

  test("is the checkout itself where .git is a directory", () => {
    const main = join(dir, "main")
    mkdirSync(join(main, ".git"), { recursive: true })
    expect(mainCheckout(main)).toBe(main)
  })

  test("is the checkout a worktree's .git file points into", () => {
    const worktree = join(dir, "wt")
    mkdirSync(worktree)
    writeFileSync(join(worktree, ".git"), `gitdir: ${MAIN}/.git/worktrees/wt\n`)
    expect(mainCheckout(worktree)).toBe(MAIN)
  })
})

describe("a git write in the live Dashboard's checkout is refused to every session but its runner and the ops lead", () => {
  // a main checkout whose .git lists the live Dashboard's worktree on live.branch's default branch, and a data folder and registry that name the ops lead
  const LMAIN = mkdtempSync(join(tmpdir(), "no-main-checkout-live-"))
  const LIVE = join(LMAIN, ".claude", "worktrees", "desk")
  const OTHER = join(LMAIN, ".claude", "worktrees", "b")
  const DATA_DIR = join(LMAIN, "data")
  const CONFIG = join(LMAIN, "config")
  for (const dir of [LIVE, OTHER, DATA_DIR, join(CONFIG, "sessions")])
    mkdirSync(dir, { recursive: true })
  for (const [name, branch] of [
    ["desk", "live/dashboard"],
    ["b", "PG-1-b"],
  ]) {
    mkdirSync(join(LMAIN, ".git", "worktrees", name), { recursive: true })
    writeFileSync(
      join(LMAIN, ".claude", "worktrees", name, ".git"),
      `gitdir: ${join(LMAIN, ".git", "worktrees", name)}\n`,
    )
    writeFileSync(join(LMAIN, ".git", "worktrees", name, "HEAD"), `ref: refs/heads/${branch}\n`)
    writeFileSync(
      join(LMAIN, ".git", "worktrees", name, "gitdir"),
      `${join(LMAIN, ".claude", "worktrees", name)}/.git\n`,
    )
  }
  writeFileSync(
    join(DATA_DIR, "roster.json"),
    JSON.stringify({
      agents: [
        { kind: "ops", name: "ops" },
        { kind: "builder", name: "builder" },
      ],
    }),
  )
  writeFileSync(
    join(CONFIG, "sessions", "1.json"),
    JSON.stringify({ name: "ops", sessionId: "s-ops" }),
  )
  writeFileSync(
    join(CONFIG, "sessions", "2.json"),
    JSON.stringify({ name: "builder", sessionId: "s-builder" }),
  )
  afterAll(() => rmSync(LMAIN, { force: true, recursive: true }))

  const live = (command: string, role: string, cwd = LIVE, session = "s-other") =>
    check(
      JSON.stringify({
        cwd,
        hook_event_name: "PreToolUse",
        session_id: session,
        tool_input: { command },
        tool_name: "Bash",
      }),
      {
        CLAUDE_CONFIG_DIR: CONFIG,
        HOME: "/u",
        PLAYGROUND_DATA_DIR: DATA_DIR,
        PLAYGROUND_ROLE: role,
      },
      LMAIN,
    )

  test.each([
    ["a commit", "git commit -m x"],
    ["a merge", "git merge origin/canary"],
    [
      "step 5's fast-forward, which only the main checkout takes",
      "git merge --ff-only origin/main",
    ],
    ["a checkout", "git checkout canary"],
    ["a hard reset", "git reset --hard origin/canary"],
    ["the keep reset, which only the main checkout takes", "git reset --keep origin/main"],
    ["a pull", "git pull"],
    ["a rebase", "git rebase origin/canary"],
    ["a switch", "git switch canary"],
    ["a stash", "git stash"],
    ["a restore", "git restore ."],
    ["a commit through run-slot", "~/.playground/ops/run-slot.sh w -- git commit -m x"],
    ["a pull in a shell's script", "bash -c 'git pull'"],
  ])("%s, from a worker", async (_, command) => {
    const reason = await live(command, "worker")
    expect(reason).toContain("the live Dashboard's checkout")
    expect(reason).toContain("Ops")
  })

  test.each([
    ["git -C", `git -C ${LIVE} reset --hard`],
    ["--git-dir", `git --git-dir=${LIVE}/.git checkout canary`],
    ["--work-tree", `git --work-tree=${LIVE} checkout canary`],
    ["a cd", `cd ${LIVE} && git commit -m x`],
    // #1326: GIT_DIR and GIT_WORK_TREE name git's tree as --git-dir and --work-tree do
    ["a GIT_DIR set for the call", `GIT_DIR=${LIVE}/.git git checkout canary`],
    ["a GIT_WORK_TREE set through env", `env GIT_WORK_TREE=${LIVE} git reset --hard`],
    ["a GIT_DIR exported earlier", `export GIT_DIR=${LIVE}/.git; git merge canary`],
    // the main checkout's guard lets step 5's merge through, so only the live checkout's refuses it
    ["a GIT_DIR the hook cannot read", 'GIT_DIR="$(cat dir)" git merge --ff-only -q origin/main'],
  ])(
    "a git write that names the live checkout from another worktree by %s, from a worker",
    async (_, command) => {
      expect(await live(command, "worker", OTHER)).toContain("the live Dashboard's checkout")
    },
  )

  test.each([
    ["a builder lead", "lead", "s-builder"],
    ["a reviewer", "reviewer", "s-other"],
    ["a lead the registry does not name", "lead", "s-unknown"],
  ])("from %s", async (_, role, session) => {
    expect(await live("git reset --hard origin/canary", role, LIVE, session)).toContain(
      "the live Dashboard's checkout",
    )
  })

  test.each([
    ["its runner", "runner", "s-other"],
    ["the ops lead", "lead", "s-ops"],
  ])("runs from %s", async (_, role, session) => {
    for (const command of ["git reset --hard origin/canary", "git commit -m x", "git pull"])
      expect(await live(command, role, LIVE, session)).toBeUndefined()
  })

  test.each([
    ["git status", "git status"],
    ["git log", "git log --oneline -3"],
    ["git fetch", "git fetch -q origin canary"],
    ["git diff", "git diff HEAD~1"],
    ["a dry-run add", "git add -n ."],
  ])("a read there runs from a worker: %s", async (_, command) => {
    expect(await live(command, "worker")).toBeUndefined()
  })

  test("a lead whose registry folder is missing is refused, and the main checkout's guard after it holds", async () => {
    const noRegistry = (command: string, cwd: string) =>
      check(
        JSON.stringify({ cwd, session_id: "s-ops", tool_input: { command }, tool_name: "Bash" }),
        {
          CLAUDE_CONFIG_DIR: join(LMAIN, "no-such-config"),
          HOME: "/u",
          PLAYGROUND_DATA_DIR: DATA_DIR,
          PLAYGROUND_ROLE: "lead",
        },
        LMAIN,
      )
    expect(await noRegistry("git commit -m x", LIVE)).toContain("the live Dashboard's checkout")
    expect(await noRegistry(`git commit -m x; git -C ${LMAIN} reset --hard`, LIVE)).toContain(
      "no-main-checkout hook refuses",
    )
  })

  test("a git write in another worktree runs", async () => {
    expect(await live("git commit -m x", "worker", OTHER)).toBeUndefined()
  })
})

describe("the live checkout's reading", () => {
  const RMAIN = mkdtempSync(join(tmpdir(), "no-main-checkout-live-read-"))
  const DESK = join(RMAIN, ".claude", "worktrees", "desk")
  mkdirSync(DESK, { recursive: true })
  writeFileSync(join(DESK, ".git"), "gitdir: ../../../.git/worktrees/desk\n")
  mkdirSync(join(RMAIN, ".git", "worktrees", "desk"), { recursive: true })
  writeFileSync(
    join(RMAIN, ".git", "worktrees", "desk", "HEAD"),
    "ref: refs/heads/live/dashboard\n",
  )
  // worktree.useRelativePaths writes gitdir relative to the admin folder
  writeFileSync(
    join(RMAIN, ".git", "worktrees", "desk", "gitdir"),
    "../../../.claude/worktrees/desk/.git\n",
  )
  const BAD = join(RMAIN, "bad-data")
  mkdirSync(join(BAD, "extensions"), { recursive: true })
  writeFileSync(
    join(BAD, "extensions", "policy.json"),
    JSON.stringify({ values: { "live.branch": 5 } }),
  )
  afterAll(() => rmSync(RMAIN, { force: true, recursive: true }))

  const at = (command: string, cwd: string, data = join(RMAIN, "data")) =>
    check(
      JSON.stringify({ cwd, tool_input: { command }, tool_name: "Bash" }),
      { HOME: "/u", PLAYGROUND_DATA_DIR: data, PLAYGROUND_ROLE: "worker" },
      RMAIN,
    )

  test("finds the checkout from a gitdir written relative to its admin folder", async () => {
    expect(await at("git reset --hard", DESK)).toContain("the live Dashboard's checkout")
  })

  test("a live.branch the policy holds in no form it reads keeps the main checkout's guard", async () => {
    expect(await at("lefthook run pre-commit", RMAIN, BAD)).toContain(
      "no-main-checkout hook refuses",
    )
  })
})

// #1663: git lands where the kernel takes a -C, so a -C through a link out of the main checkout that then climbs runs, as git runs it outside the main checkout; a logical cd folds its `..` by text
describe("a -C or a cd read where it lands", () => {
  const OUTSIDE = mkdtempSync(join(tmpdir(), "no-main-checkout-outside-"))
  mkdirSync(join(OUTSIDE, "deep"))
  symlinkSync(join(OUTSIDE, "deep"), join(MAIN, "out"))
  symlinkSync(join(WORKTREE, "api"), join(MAIN, "towt"))
  symlinkSync(join(MAIN, ".claude"), join(WORKTREE, "into-main"))
  afterAll(() => rmSync(OUTSIDE, { force: true, recursive: true }))

  test.each([
    ["a -C through a link out of it, then a -C that climbs", "git -C out -C .. commit -m x"],
    ["a -C that climbs out of a link out of it", "git -C out/.. commit -m x"],
    [
      "a -C through a link into a worktree's folder, then a -C that climbs",
      "git -C towt -C .. commit -m x",
    ],
    ["a -C that climbs out of a link into a worktree's folder", "git -C towt/.. commit -m x"],
  ])("from the main checkout, %s runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test.each([
    ["a logical cd that climbs out of a link", "cd -L into-main/.. && git commit -m x"],
    ["a physical cd into a folder of its own", "cd -P api && git commit -m x"],
  ])("from a worktree, %s runs", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toBeUndefined()
  })

  test("from the main checkout, a commit after a cd whose || runs an exit in a brace group runs", async () => {
    expect(await bash(`cd ${WORKTREE} || { exit; }; git commit -m x`)).toBeUndefined()
  })
})

// #1663: a file in the worktrees folder is no folder git, turbo or bun can walk up from, so a write to it runs whether or not it is there yet, as the folder is git-ignored
describe("a file in the worktrees folder", () => {
  writeFileSync(join(MAIN, ".claude", "worktrees", "there.log"), "x\n")

  test.each([
    ["one that is there", `echo x > ${MAIN}/.claude/worktrees/there.log`],
    ["one not there yet", `echo x > ${MAIN}/.claude/worktrees/new.log`],
  ])("from the main checkout, a write to %s runs", async (_name, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("a GIT_DIR or GIT_WORK_TREE that names your own worktree", () => {
  test.each([
    ["set for the call", `GIT_DIR=${WORKTREE}/.git git commit -m x`],
    ["set through env", `env GIT_WORK_TREE=${WORKTREE} git reset --hard`],
    ["exported earlier", `export GIT_WORK_TREE=${WORKTREE}; git commit -m x`],
    ["by a relative path", "GIT_WORK_TREE=. git reset --hard"],
  ])("from the worktree, %s, runs", async (_name, command) => {
    expect(await bash(command, WORKTREE)).toBeUndefined()
  })
})
