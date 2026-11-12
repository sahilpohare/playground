import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { GUARD_SETTING_KEYS } from "../../../packages/settings/src/guard-keys"
import { check, GUARD_KEYS, guarded } from "../../../scripts/hooks/no-extensions-write"
import { overBaseline, stepsOf } from "./pace"

// A home whose data folder holds an extensions root, with a list, policy.json and a scope's sources, as a machine with extensions has.
const HOME = mkdtempSync(join(tmpdir(), "no-extensions-write-"))
const DATA = join(HOME, ".playground")
const ROOT = join(DATA, "extensions")
const LIST = join(ROOT, "hooks", "desktop-owner-apps.json")
const SCOPE = join(ROOT, "login")
mkdirSync(join(ROOT, "hooks"), { recursive: true })
mkdirSync(join(SCOPE, "lists"), { recursive: true })
mkdirSync(join(DATA, "handoffs"), { recursive: true })
writeFileSync(LIST, '["Slack"]\n')
writeFileSync(join(ROOT, "policy.json"), "{}\n")
writeFileSync(join(SCOPE, "lists", "release-owners.json"), "[]\n")
const LINK = join(HOME, "store")
const WORK = join(HOME, "work")
const BIG = [join(HOME, "big-a"), join(HOME, "big-b")]
for (const file of BIG) writeFileSync(file, "x".repeat(900_000))
const WORDS = join(HOME, "words")
writeFileSync(WORDS, "y ".repeat(400_000))
mkdirSync(join(WORK, "playground"), { recursive: true })
symlinkSync(ROOT, LINK)
// Links whose names no glob of the root's own names matches: one to the root in the data folder, one to the data folder in the home.
symlinkSync(ROOT, join(DATA, "store"))
symlinkSync(DATA, join(HOME, "pg"))
afterAll(() => rmSync(HOME, { force: true, recursive: true }))

const ENV = { HOME }
const CHECKOUT = join(import.meta.dir, "..", "..", "..")
const CLI_DIR = join(CHECKOUT, "packages", "scripts", "src", "playground")

const bash = (command: string, cwd = HOME, budget?: number) =>
  check(
    JSON.stringify({
      cwd,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    ENV,
    budget,
  )

// A harmless git alias nest of the given depth around an inner command line, each level double-quoted.
const escape = (text: string) => text.replace(/[\\"$`]/g, (c) => `\\${c}`)
const nest = (depth: number, inner: string): string =>
  depth === 0 ? inner : `git -c alias.x="!${escape(nest(depth - 1, inner))}" x`

const tool = (tool_name: string, input: Record<string, unknown>) =>
  check(
    JSON.stringify({ cwd: HOME, hook_event_name: "PreToolUse", tool_input: input, tool_name }),
    ENV,
  )

describe("a direct write into the extensions root is refused, naming the owner's route", () => {
  test.each([
    ["Edit of a list", "Edit", { file_path: LIST, new_string: "[]", old_string: '["Slack"]' }],
    ["Write of a list", "Write", { content: "[]", file_path: LIST }],
    ["MultiEdit of policy.json", "MultiEdit", { edits: [], file_path: join(ROOT, "policy.json") }],
    ["NotebookEdit under the root", "NotebookEdit", { notebook_path: join(ROOT, "a.ipynb") }],
    [
      "Write of a scope's list source",
      "Write",
      { content: "[]", file_path: join(SCOPE, "lists", "release-owners.json") },
    ],
    [
      "Write through a link to the root",
      "Write",
      { content: "[]", file_path: join(LINK, "hooks", "a.json") },
    ],
    [
      "Write by a path relative to the cwd",
      "Write",
      { content: "[]", file_path: ".playground/extensions/policy.json" },
    ],
  ])("%s", async (_, name, input) => {
    const reason = await tool(name, input)
    expect(reason).toContain("no-extensions-write hook refuses")
    expect(reason).toContain(
      "the owner typing the playground command as a ! command in the dispatcher's terminal window, which runs without hooks: tell your lead, and the dispatcher hands the owner the command.",
    )
  })

  test.each([
    ["a redirect", `echo '[]' > ${LIST}`],
    [
      "a redirect by $HOME",
      'echo [] > "$HOME/.playground/extensions/hooks/desktop-owner-apps.json"',
    ],
    ["an appending redirect", `echo x >> ${join(ROOT, "policy.json")}`],
    ["a redirect through a link", `echo '[]' > ${join(LINK, "hooks", "a.json")}`],
    ["cp onto a list", `cp /tmp/empty.json ${LIST}`],
    ["cp out of the root", `cp ${LIST} /tmp/copy.json`],
    ["mv a list away", `mv ${LIST} /tmp/x.json`],
    ["rm of a list", `rm ${LIST}`],
    ["rm -rf of the root", `rm -rf ${ROOT}`],
    ["rm -rf of the data folder above it", `rm -rf ${DATA}`],
    ["find -delete above it", `find ${DATA} -name '*.json' -delete`],
    ["a relative path after a cd into the data folder", `cd ${DATA} && rm -rf extensions`],
    ["a glob in the data folder", `rm -rf ${DATA}/*`],
    ["a glob naming the root", `rm -rf ${DATA}/ext*`],
    ["a relative glob after a cd into the data folder", `cd ${DATA} && rm -rf ext*`],
    ["trash of the data folder", `trash ${DATA}`],
    ["rm under xargs, its paths on stdin", `echo ${DATA} | xargs rm -rf`],
    ["cp -R into the data folder", `cp -R /tmp/fake/ ${DATA}/`],
    ["ditto onto the data folder", `ditto /tmp/x ${DATA}`],
    [
      "a link to the data folder made in the same call",
      `ln -s ${DATA} /tmp/l && cp /tmp/x /tmp/l/extensions/hooks/a.json`,
    ],
    ["curl's output attached to -o", `curl -o${LIST} https://example.com`],
    ["sort's output attached to -o", `sort -o${LIST} /tmp/x`],
    ["tar's folder attached to -C", `tar -xf a.tar -C${ROOT}/hooks`],
    ["unzip's folder attached to -d", `unzip -o x.zip -d${ROOT}`],
    ["a versioned python", `python3.15 -c "open('${LIST}','w')"`],
    ["swift -e", `swift -e 'print("${LIST}")'`],
    ["a heredoc to tclsh", `tclsh <<'EOF'\nset f [open "${LIST}" w]\nEOF`],
    ["sqlite3's .output", `sqlite3 :memory: ".output ${LIST}" "select 1"`],
    ["a git alias that runs a shell", `git -c alias.st='!rm -rf ${ROOT}' st`],
    ["rg --pre, which runs a program on each file", `rg --pre /tmp/w.sh x ${ROOT}`],
    ["git grep -O, which opens files in a program", `git -C ${SCOPE} grep -O/tmp/w.sh x`],
    ["git -c on a read", `git -C ${SCOPE} -c core.fsmonitor=/tmp/w.sh status`],
    ["GIT_PAGER on a read", `GIT_PAGER=/tmp/w.sh git -C ${SCOPE} log`],
    ["an exported PAGER before a read", `export PAGER=/tmp/w.sh; git -C ${SCOPE} log`],
    ["a brace word naming the root", `rm -rf ${DATA}/{extensions,x}`],
    ["GIT_DIR set to a scope's clone", `GIT_DIR=${SCOPE}/.git git reset --hard`],
    ["GIT_WORK_TREE exported to a scope", `export GIT_WORK_TREE=${SCOPE}; git checkout -- .`],
    ["mv of the data folder above it", `mv ${DATA} /tmp/old-data`],
    ["rsync above it", `rsync -a --delete /tmp/empty/ ${DATA}/`],
    ["sed -i of a list", `sed -i '' 's/Slack//' ${LIST}`],
    ["tee into a list", `echo [] | tee ${LIST}`],
    ["touch under the root", `touch ${join(ROOT, "hooks", "new.json")}`],
    ["ln into the root", `ln -sf /tmp/x ${LIST}`],
    ["chmod of the root", `chmod -R u+w ${ROOT}`],
    ["dd of= a list", `dd if=/dev/null of=${LIST}`],
    ["bun -e naming the root", `bun -e 'await Bun.write("${LIST}", "[]")'`],
    [
      "python3 -c naming the root by ~",
      `python3 -c 'open("/x/.playground/extensions/hooks/a.json","w")'`,
    ],
    [
      "a heredoc to an interpreter naming the root",
      `python3 - <<'EOF'\nopen("${LIST}", "w").write("[]")\nEOF`,
    ],
    ["a cd into a scope, then git commit", `cd ${SCOPE} && git commit -am x`],
    [
      "a cd into the root, then a relative write by an interpreter",
      `cd ${ROOT} && node -e 'require("fs").writeFileSync("policy.json","{}")'`,
    ],
    ["git -C a scope reset", `git -C ${SCOPE} reset --hard HEAD~1`],
    ["git -C a scope checkout", `git -C ${SCOPE} checkout HEAD~1 -- lists`],
    ["git diff --output into the root", `git diff --output=${LIST}`],
    ["through run-slot", `~/.playground/ops/run-slot.sh w -- rm ${LIST}`],
    ["through bash -c", `bash -c "rm ${LIST}"`],
    ["through env", `env FOO=1 rm ${LIST}`],
  ])("%s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-extensions-write hook refuses")
  })

  test("a script naming the root relative to a cwd above it", async () => {
    const reason = await bash(
      `python3.15 -c "open('.playground/extensions/hooks/a.json','w')"`,
      HOME,
    )
    expect(reason).toContain("no-extensions-write hook refuses")
  })

  test("a heredoc naming the root relative to a cwd above it", async () => {
    const reason = await bash("python3 - <<'EOF'\nopen('extensions/policy.json','w')\nEOF", DATA)
    expect(reason).toContain("no-extensions-write hook refuses")
  })

  test.each([
    ["-S attached", `env -S'bun ${CLI_DIR}/cli.ts' settings set owner.names x --reason r`],
    [
      "--split-string=",
      `env --split-string='bun ${CLI_DIR}/cli.ts' settings set owner.names x --reason r`,
    ],
    ["-v -S", `env -v -S 'bun ${CLI_DIR}/cli.ts' settings set owner.names x --reason r`],
    ["-vS attached", `env -vS'bun ${CLI_DIR}/cli.ts' settings set owner.names x --reason r`],
  ])("the CLI behind env %s", async (_, command) => {
    expect(await bash(command)).toContain("no-extensions-write hook refuses")
  })

  test("the CLI behind env -S", async () => {
    const reason = await bash(
      `env -S 'bun ${CLI_DIR}/cli.ts' settings set owner.names x --reason r`,
    )
    expect(reason).toContain("no-extensions-write hook refuses")
  })

  test.each([
    ["a group's redirect", `{ echo '[]'; } > ${LIST}`],
    ["a subshell's redirect", `( echo '[]' ) > ${LIST}`],
    ["a bare redirect", `> ${LIST}`],
    ["exec's redirect", `exec > ${LIST}`],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("no-extensions-write hook refuses")
  })

  test.each([
    [
      "bun --cwd to the CLI's folder, from the checkout",
      "bun --cwd packages/scripts/src/playground cli.ts ext put login list x /tmp/l.json --reason y",
    ],
    ["the command's name in upper case", "PLAYGROUND ext put login list x /tmp/l.json --reason y"],
    [
      "the CLI behind find -exec",
      "find /tmp -maxdepth 0 -exec playground ext put login list x /tmp/l.json --reason y ';'",
    ],
    ["the CLI behind arch", "arch -arm64 playground settings set owner.names x --reason r"],
    ["the CLI behind watch", "watch playground ext sync"],
    ["the CLI behind npm exec", "npm exec -- playground ext sync"],
    ["settings set of ext.repos", "playground settings set ext.repos '{}' --reason r"],
  ])("%s", async (_, command) => {
    expect(await bash(command, CHECKOUT)).toContain("no-extensions-write hook refuses")
  })

  test.each([
    ["a substitution in ${X:-…}", `echo \${X:-$(touch ${LIST})}`],
    ["a substitution in ${X:=…}", `: \${X:=$(touch ${LIST})}`],
    ["a substitution in ${X:+…}", `echo \${X:+$(touch ${LIST})}`],
    ["a substitution in ${X/a/…}", `echo \${X/a/$(touch ${LIST})}`],
    ["a substitution in ${X#…}", `echo \${X#$(touch ${LIST})}`],
    ["a backquote in ${X:-…}", `echo \${X:-\`touch ${LIST}\`}`],
    ["a substitution in $((…))", `echo $(($(touch ${LIST})+1))`],
    ["rm -rf of the data folder in ${X:-…}", `echo \${X:-$(rm -rf ${DATA})}`],
    ["the CLI in ${X:-…}", "echo ${X:-$(playground ext sync)}"],
    ["bash reading a process substitution", `bash <(echo touch ${LIST})`],
    ["zsh reading a process substitution", `zsh <(echo touch ${LIST})`],
    ["source of a process substitution", `source <(echo touch ${LIST})`],
    [". of a process substitution", `. <(echo touch ${LIST})`],
    ["sh reading a process substitution as stdin", `sh < <(echo touch ${LIST})`],
    ["sh -s reading a process substitution as stdin", `sh -s < <(echo touch ${LIST})`],
    ["bash reading /dev/stdin", `bash /dev/stdin <<< 'touch ${LIST}'`],
    ["bash reading a heredoc's process substitution", `bash <(cat <<'EOF'\ntouch ${LIST}\nEOF\n)`],
    ["the CLI as git's pager", "GIT_PAGER='playground ext sync' git log"],
    ["the CLI as git's -c pager", "git -c core.pager='playground ext sync' log"],
    ["a write as PAGER", `PAGER='touch ${LIST}' git log`],
    ["the CLI as watch's command line", "watch -n1 'playground ext sync'"],
    ["the CLI as tmux's command line", "tmux new -d 'playground ext sync'"],
    [
      "the CLI as sh -c's script under find -exec",
      "find /tmp -maxdepth 0 -exec sh -c 'playground ext sync' ';'",
    ],
    ["the CLI as sh -c's script under arch", "arch -arm64 sh -c 'playground ext sync'"],
    ["the CLI as ssh's ProxyCommand", "ssh -o ProxyCommand='playground ext sync' host"],
    ["the CLI as rsync's shell", "rsync -e 'playground ext sync' /tmp/a host:/tmp/b"],
    ["the CLI as script's command", "script -q -c 'playground ext sync' /dev/null"],
    ["the CLI as concurrently's command", "npx -y concurrently 'playground ext sync'"],
    ["the CLI as a git alias", "git -c alias.x='!playground ext sync' x"],
    ["the CLI as MANPAGER", "MANPAGER='playground ext sync' man ls"],
    ["the CLI as GH_PAGER", "GH_PAGER='playground ext sync' gh pr view 1"],
    [
      "the CLI as git's --config-env pager",
      "X='playground ext sync' git --config-env=core.pager=X log",
    ],
    ["a write after a word with an unbalanced quote", `git commit -m "it's"; rm -rf ${ROOT}`],
    [
      "the CLI by name from a cwd holding a folder named playground",
      `cd ${WORK} && playground ext sync`,
    ],
    ["the CLI by name under env -C to such a folder", `env -C ${WORK} playground ext sync`],
    ["the CLI's words from xargs' stdin", "printf 'ext sync' | xargs playground"],
    ["the CLI's words from xargs' here-string", `xargs playground <<< "ext sync"`],
    [
      "the CLI's words through xargs -I into sh -c",
      "printf 'ext sync' | xargs -I{} sh -c 'playground {}'",
    ],
    ["a redirect on bash -c", `bash -c true > ${LIST}`],
    ["a redirect on eval", `eval true > ${LIST}`],
    ["a redirect on cd", `cd /tmp > ${LIST}`],
    [
      "a process substitution whose first command prints the script",
      `bash <(echo 'rm ${LIST}'; echo true)`,
    ],
    ["a group's output piped into sh", `{ echo 'rm ${LIST}'; echo true; } | sh`],
    ["a subshell's output piped into sh", `( echo 'rm ${LIST}'; echo true ) | sh`],
    ["rg with --hostname-bin", `rg --hostname-bin /tmp/w.sh x ${ROOT}`],
    ["settings set of ext.order", "playground settings set ext.order login --reason r"],
    ["settings reset of ext.order", "playground settings reset ext.order --reason r"],
    ["a redirect into a [ ] glob", `echo '{}' > ${DATA}/extensio[n]s/policy.json`],
    ["a redirect into a ? glob", `echo '{}' > ${DATA}/extensio?s/policy.json`],
    ["a redirect into a * glob", `echo '{}' > ${DATA}/ext*/policy.json`],
    ["zsh's >! redirect", `echo '[]' >! ${LIST}`],
    ["zsh's >>! redirect", `echo '[]' >>! ${LIST}`],
    [
      "a one-line nested group's output piped into sh",
      `{ { echo 'rm ${LIST}'; }; echo true; } | sh`,
    ],
    ["rm of a zsh ( ) glob", `rm -rf ${DATA}/extensio(n)s`],
    ["env -C attached to a scope", `env -C${SCOPE} git reset --hard`],
    ["env --chdir= to a scope", `env --chdir=${SCOPE} git reset --hard`],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("no-extensions-write hook refuses")
  })

  // refused before its first counted step, with the alias reader's seen set reverted too, so the cap holds the walk to under one clock read
  test("a deep harmless nest ahead of the CLI is refused in a bounded count of steps", async () => {
    const [reason, steps] = await stepsOf(() =>
      bash(`${nest(16, "true")}; playground ext sync`, HOME, 120_000),
    )
    expect(reason).toContain("no-extensions-write hook refuses")
    expect(steps).toBeLessThan(1_024)
  })

  // about 21,000 steps; reading every variable set before each command took 1.9M
  test("many variables ahead of a write are refused in a bounded count of steps", async () => {
    const vars = Array.from({ length: 800 }, (_, i) => `V${i}=x${i}`).join("; ")
    const [reason, steps] = await stepsOf(() =>
      bash(`${vars}; ${": ; ".repeat(800)}rm -rf ${ROOT}`, HOME, 120_000),
    )
    expect(reason).toContain("no-extensions-write hook refuses")
    expect(steps).toBeLessThan(200_000)
  })

  test.each([
    ["nested substitutions", `x=${"$(".repeat(20_000)}${")".repeat(20_000)}; playground ext sync`],
    ["nested groups", `${"(".repeat(20_000)}true${")".repeat(20_000)}; playground ext sync`],
    [
      "nested quoted substitutions",
      `${'"$('.repeat(5_000)}${')"'.repeat(5_000)}; playground ext sync`,
    ],
  ])("%s too deep for the reader's stack are refused", async (_, command) => {
    expect(await bash(command, "/tmp")).toContain("no-extensions-write hook refuses")
  })

  test("a command longer than the reader can lex inside the hook's time is refused", async () => {
    const reason = await bash(`echo ${"${a:-".repeat(30_000)}${"}".repeat(30_000)}`, "/tmp")
    expect(reason).toContain("split it into shorter calls")
  })

  // with a scan back for each brace's open this ran past the test's 60 s, where the stack of opens stays under x60 the baseline's CPU time
  test("a long run of closing braces ahead of the CLI is read in a time linear in its length", async () => {
    const command = `${"ls; }\n".repeat(21_000)}playground ext sync`
    expect(await bash(command, "/tmp")).toContain("no-extensions-write hook refuses")
    expect(await overBaseline((c) => bash(c, "/tmp"), command)).toBeLessThan(300)
  }, 60_000)

  // a variable set once, then a program after each, at the cap
  const variables = (each: string) => {
    let script = ""
    for (let i = 0; script.length < 130_000; i++) script += `V${i}=x${i}; ${each}`
    return `${script}true`
  }
  const fill = (head: string, unit: string, tail: string) =>
    head + unit.repeat(Math.floor((130_000 - head.length - tail.length) / unit.length)) + tail
  // a native step the walk cannot count (a backtracking regex, a string built whole, an array shifted), bounded by its CPU time over a same-length echo; with the guard reverted it ran x400 to x950
  test.each([
    ["a brace with no close", fill("echo {", ",", ""), false, 50],
    [
      "xargs -I over a large stdin",
      fill(`cat ${WORDS} | xargs -I@ git -c alias.x="!`, "@ ", '" x'),
      true,
      150,
    ],
    ["env -S", fill("env -S'", "-S ", "' true"), false, 150],
  ])(
    "%s at the command cap is read in a time linear in its length",
    async (_, command, refused, ratio) => {
      const reason = await bash(command, "/tmp")
      if (refused) expect(reason).toContain("split it into shorter calls")
      else expect(reason).toBeUndefined()
      expect(await overBaseline((c) => bash(c, "/tmp"), command)).toBeLessThan(ratio)
    },
    60_000,
  )

  // each variable read once and each printf escape decoded once: canary's reread every variable before each command and decoded the format each round, past 40 million steps
  test.each([
    ["distinct variables", variables(""), 400_000],
    ["distinct variables, each with a program", variables("true; "), 400_000],
    [
      "a printf escape format over many arguments",
      `printf '%s${"\\\\x41".repeat(16_000)}' ${"x ".repeat(3_000)}> /tmp/nxw-p`,
      100_000,
    ],
  ])(
    "%s at the command cap is read in a bounded count of steps",
    async (_, command, cap) => {
      const [reason, steps] = await stepsOf(() => bash(command, "/tmp", 120_000))
      expect(reason).toBeUndefined()
      expect(steps).toBeLessThan(cap)
    },
    60_000,
  )

  // under the cap on shells a call runs, 300 levels took 753,387 steps and each level about 3000; without it, 300 took 1,148,304 and 8000 took 303M
  test.each([
    [300, 1_000_000],
    [8_000, 32_000_000],
  ])(
    "an eval chain %d deep ahead of a write is refused in a count of steps linear in its depth",
    async (depth, cap) => {
      const [reason, steps] = await stepsOf(() =>
        bash(`${"eval 'eval '\\''".repeat(depth)}\nrm ${LIST}`, "/tmp", 120_000),
      )
      expect(reason).toContain("no-extensions-write hook refuses")
      expect(steps).toBeLessThan(cap)
    },
    60_000,
  )

  // doubling text, held at 1 MB and a script at 128 KB, is bounded by its steps; a native step (a backtracking width match, a copy per read, a walk up a long path) by its CPU time over a same-length echo, which ran x440 and past with the guard reverted
  test.each<[string, string, number | undefined, number | undefined]>([
    [
      "24 doubling cat stages",
      `echo hi | ${"cat - - | ".repeat(24)}bash; echo x > ${LIST}`,
      5_000,
      undefined,
    ],
    [
      "12 rounds of files that double each other",
      `echo a > /tmp/nxw-f; ${"cat /tmp/nxw-f /tmp/nxw-f > /tmp/nxw-g; cat /tmp/nxw-g /tmp/nxw-g > /tmp/nxw-f; ".repeat(12)}bash < /tmp/nxw-f; echo x > ${LIST}`,
      10_000,
      undefined,
    ],
    ["a 120 KB path", `touch /tmp/${"a/".repeat(60_000)}x; echo x > ${LIST}`, undefined, 100],
    [
      "a printf format of 100000 zeros through three cat stages",
      `printf '%${"0".repeat(100_000)}!' | cat > /tmp/nxw-a | cat > /tmp/nxw-b | cat > /tmp/nxw-c; echo x > ${LIST}`,
      undefined,
      50,
    ],
    [
      "4600 reads of a 45 KB file in one word",
      `echo ${"A".repeat(45_000)} > /tmp/nxw-r; echo "${"$(cat /tmp/nxw-r)".repeat(4_600)}" > /tmp/nxw-o; echo x > ${LIST}`,
      undefined,
      100,
    ],
  ])(
    "%s ahead of a write are read in bounded work",
    async (_, command, cap, ratio) => {
      const [reason, steps] = await stepsOf(() => bash(command, "/tmp"))
      expect(reason).toContain("no-extensions-write hook refuses")
      if (cap !== undefined) expect(steps).toBeLessThan(cap)
      if (ratio !== undefined)
        expect(await overBaseline((c) => bash(c, "/tmp"), command)).toBeLessThan(ratio)
    },
    60_000,
  )

  test.each([
    [
      "a group whose first part it cannot read",
      `{ curl -s https://example.com; echo 'echo x > ${LIST}'; } | bash`,
    ],
    [
      "a group whose second part it cannot read",
      `{ echo 'echo x > ${LIST}'; curl -s https://example.com; } | bash`,
    ],
    [
      "a subshell with a part it cannot read",
      `(curl -s https://example.com; echo 'echo x > ${LIST}') | sh`,
    ],
    [
      "a process substitution with a part it cannot read",
      `bash <(curl -s https://example.com; echo 'echo x > ${LIST}')`,
    ],
    ["cat of a file it cannot read and stdin", `echo 'echo x > ${LIST}' | cat /dev/null - | bash`],
  ])("a shell reading %s still reads the rest", async (_, command) => {
    expect(await bash(command, "/tmp")).toContain("no-extensions-write hook refuses")
  })

  // a deadline already past stops the walk at its first clock read, 1024 steps in, where the whole lex takes tens of thousands
  test("a slow lex refuses at the walk's deadline, whatever made it slow", async () => {
    const command = `echo ${"a(".repeat(20_000)}${")".repeat(20_000)}`
    const [reason, steps] = await stepsOf(() =>
      check(JSON.stringify({ cwd: "/tmp", tool_input: { command }, tool_name: "Bash" }), ENV, 0),
    )
    expect(reason).toContain("split it into shorter calls")
    expect(steps).toBeLessThan(2_048)
  })

  test("a Bash call whose cwd is already inside the root runs no writer", async () => {
    expect(await bash("node -e 'x'", SCOPE)).toContain("no-extensions-write hook refuses")
  })

  // zsh's ~- is the folder it last left, so an OLDPWD assignment keeps it in the root, and a popd that lands back leaves it unread
  test("pushd ~- after an OLDPWD assignment is still the folder zsh last left", async () => {
    expect(await bash(`cd ${SCOPE}; cd /usr; OLDPWD=/usr; pushd ~-; touch f`)).toContain("refuses")
  })

  // zsh lands in /usr here, but the reader cannot see popd's stack, so it takes every folder the line named after a popd, the scope among them, as it does for popd itself
  test("pushd ~- after a popd may go back to any folder the line named", async () => {
    expect(await bash(`cd ${SCOPE}; pushd /usr; popd; pushd ~-; touch f`)).toContain("refuses")
    expect(await bash(`cd ${SCOPE}; pushd /usr; pushd ~-; touch f`)).toContain("refuses")
  })
})

// The shell reads ~ as the process's home, so these rows judge the real home's root, which the hook only reads.
describe("a write by ~ is judged against the home the shell expands it to", () => {
  const real = { HOME: homedir() }
  test.each([
    ["a redirect by ~", "echo '[]' > ~/.playground/extensions/hooks/desktop-owner-apps.json"],
    ["rm of the root by ~", "rm ~/.playground/extensions"],
    ["rm of the data folder by ~", "rm ~/.playground"],
    ["a cd by ~, then a relative rm", "cd ~ && rm -rf .playground/extensions/.no-such-folder"],
  ])("%s", async (_, command) => {
    const reason = await check(
      JSON.stringify({ cwd: tmpdir(), tool_input: { command }, tool_name: "Bash" }),
      real,
    )
    expect(reason).toContain("no-extensions-write hook refuses")
  })

  test("ls by ~ runs", async () => {
    const raw = JSON.stringify({
      cwd: tmpdir(),
      tool_input: { command: "ls ~/.playground/extensions/hooks" },
      tool_name: "Bash",
    })
    expect(await check(raw, real)).toBeUndefined()
  })

  // A folder below the home that is neither the root nor above it, so canary's whole-program-glob fallback resolves there and runs, which is what makes the extraction the only thing that can refuse these rows.
  const worktree = join(homedir(), "worktree")

  // PG-840: the command string a shell-running call is given runs through a shell, which expands its leading ~ to the home, so a data-folder glob in it is judged against the home from any folder, a worktree included; canary read only the program's own call parens as a glob in the worktree, so it ran this from a worktree.
  test.each([
    [
      "a data-folder glob removed through execSync",
      `node -e 'require("child_process").execSync("rmdir ~/.play*")'`,
    ],
    [
      "a data-folder glob removed through execSync joined from two strings",
      `node -e 'require("child_process").execSync("rmdir " + "~/.play*")'`,
    ],
    [
      "a data-folder glob removed through spawnSync with shell true",
      `node -e 'require("child_process").spawnSync("rmdir ~/.play*", { shell: true })'`,
    ],
    [
      "a data-folder glob removed through execSync beside an unrelated shell variable",
      `node -e 'require("child_process").execSync("rmdir ~/.play* $1")'`,
    ],
    [
      "a data-folder glob removed through execSync before an echo of a variable",
      `node -e 'require("child_process").execSync("rmdir ~/.play*; echo $HOME")'`,
    ],
  ])("%s is refused from a worktree", async (_, command) => {
    const reason = await check(
      JSON.stringify({ cwd: worktree, tool_input: { command }, tool_name: "Bash" }),
      real,
    )
    expect(reason).toContain("no-extensions-write hook refuses")
  })

  // PG-840 residual, named in the hook's README as the guard's known limit: a command string the hook cannot read as literals (a variable, a template with a substitution), an argument list no shell runs its ~, and a regex's .exec whose string no shell runs, each stays as canary judged them, so none is newly refused from a worktree. The README names the rest of the residual, whose working forms are kept out of this file.
  test.each([
    [
      "a removal built from a variable through execSync",
      `node -e 'const d=process.argv[1]; require("child_process").execSync("rmdir " + d)' ~/.play`,
    ],
    [
      "an argument list no shell runs, its ~ left literal",
      `bun -e 'Bun.spawnSync(["rmdir", "~/.play*"])'`,
    ],
    [
      "a benign home path removed through execSync",
      `node -e 'require("child_process").execSync("rmdir ~/.no-such-benign-dir")'`,
    ],
    [
      "a regex exec whose string no shell runs",
      `node -e 'const re = /a b/; re.exec("rmdir ~/.play*")'`,
    ],
  ])("%s runs from a worktree", async (_, command) => {
    const reason = await check(
      JSON.stringify({ cwd: worktree, tool_input: { command }, tool_name: "Bash" }),
      real,
    )
    expect(reason).toBeUndefined()
  })
})

// A quoted argument with a space is read as a command line unless every command on the line is on a closed list of readers (awk with a program that runs nothing, cat, grep, head, tail, wc, sort, uniq, cut, echo, lsof), with no redirect that writes a file; an awk program that runs a command has its literals read wherever it stands, and sed keeps canary's reading.
describe("a quoted argument is read as a command line only where a program runs it", () => {
  // #1455: a quiet commit's message is text git never runs, so a gated call it names runs, in any case of git, while a gated call beside it stays refused
  test.each([
    ["names playground ext sync", `git commit -m "docs: the hook refuses playground ext sync now"`],
    ["names playground migrate", "git commit -q -m 'fix: playground migrate seeds the lists'"],
    ["names a gated call under Git", "Git commit -m 'docs: playground ext sync'"],
  ])("a quiet commit whose message %s runs from the home", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  // #1799: a quiet commit's message names the home by ~/ as text, under run-slot and with its own log redirect too; the real home, since the shell reads ~ as the process's home
  const atHome = (command: string) =>
    check(JSON.stringify({ cwd: tmpdir(), tool_input: { command }, tool_name: "Bash" }), {
      HOME: homedir(),
    })
  const log = join(tmpdir(), "commit.log")
  test.each([
    [
      "under run-slot, with its log redirect",
      `~/.playground/ops/run-slot.sh w -- git commit -q -m "fix(x): reads each checkout in ~/<org>" > ${log} 2>&1`,
    ],
    [
      "under run-slot",
      `~/.playground/ops/run-slot.sh w -- git commit -q -m "fix(x): files in ~/ stay"`,
    ],
    ["with its log redirect", `git commit -q -m "fix(x): files in ~/ stay" > ${log} 2>&1`],
  ])("a quiet commit whose message names ~/ runs %s", async (_, command) => {
    expect(await atHome(command)).toBeUndefined()
  })

  test.each([
    [
      "a substitution in its message writes into the root",
      `~/.playground/ops/run-slot.sh w -- git commit -q -m "fix(x): $(touch ~/.playground/extensions/f)" > ${log} 2>&1`,
    ],
    [
      "its redirect writes into the root",
      `git commit -q -m "fix(x): y" > ~/.playground/extensions/f`,
    ],
  ])("a quiet commit stays refused when %s", async (_, command) => {
    expect(await atHome(command)).toContain("no-extensions-write hook refuses")
  })

  test("a gated call after a quiet commit stays refused", async () => {
    expect(await bash("git commit -m 'fix: x' && playground migrate")).toContain(
      "playground migrate",
    )
  })

  const real = { HOME: homedir() }
  const at = (command: string, cwd: string) =>
    check(JSON.stringify({ cwd, tool_input: { command }, tool_name: "Bash" }), real)
  const homes = [homedir(), join(homedir(), ".playground")]
  test.each([
    ["awk matching a field to a regex", "awk '$3 ~ /runner/' /dev/null"],
    ["awk matching a field to a string", `awk '$3 ~ "runner"' /dev/null`],
    ["awk matching a line naming a runner", "awk '/watch/' /dev/null"],
    ["awk matching a regex alternation", "awk '/foo|bar/' f"],
    ["awk matching a regex alternation with a block", "awk '/foo|bar/ {print $2}' f"],
    ["awk matching a field to a string alternation", `awk '$1 ~ "a|b"' f`],
    ["awk matching a field to a grouped alternation", "awk '$1 ~ /^(a|b)/' f"],
    [
      "awk counting a field's regex alternation",
      "awk '$3 ~ /runner|watch/ {n++} END {print n}' /dev/null",
    ],
    [
      "awk matching an escaped paren and a quoted word",
      `awk '/startsWith\\("--del"\\)/{print NR}' f`,
    ],
    ["awk matching a line of three dashes and a space", "awk '/^--- /' f"],
    ["sed printing a line of three dashes and a space", "sed -n '/^--- /p' f"],
    ["jq formatting two fields around a slash", `jq -r '"\\(.a)/-\\(.b)"' f`],
    [
      "awk printing from a heading in a handoff",
      "awk '/^## .*6/{p=1} p' ~/.playground/handoffs/x.md",
    ],
    [
      "awk printing from a heading alternation in a handoff",
      "awk '/^## .*6|7/{p=1} p' ~/.playground/handoffs/x.md",
    ],
    [
      "sed -i replacing text with a slash and parens in a handoff",
      "sed -i '' 's/a / b (c)/new/' ~/.playground/handoffs/x.md",
    ],
    ["awk with a block matching a line naming a runner", "awk '/watch/ {print}' /dev/null"],
    ["awk with its errors sent to /dev/null", "awk '$3 ~ /runner/' /dev/null 2>/dev/null"],
    [
      "awk with its errors joined and piped to head",
      "awk '$3 ~ /runner/' /dev/null 2>&1 | head -3",
    ],
    ["awk reading cat's output", "cat /dev/null | awk '$3 ~ /runner/'"],
    ["awk by its system path", "/usr/bin/awk '$3 ~ /runner/' /dev/null"],
    ["grep over the folder after !", "! grep -r x ."],
    ["grep over the folder after then", "if true; then grep -r x .; fi"],
    ["awk after then", "if grep -q x /dev/null; then awk '$3 ~ /runner/' /dev/null; fi"],
    [
      "grep, awk, sort, uniq and head in a pipe",
      "grep x /dev/null | awk '$3 ~ /runner/' | sort | uniq -c | head -3",
    ],
    ["awk's output cut at a spaced delimiter", "awk '$3 ~ /runner/' /dev/null | cut -d' ' -f1"],
    ["awk's output counted by wc and tail", "awk '$3 ~ /runner/' /dev/null | tail -n 2 | wc -l"],
    ["awk printing a field in a quoted block", "awk '{print $1}' /dev/null"],
    [
      "awk matching a worktree's line with a variable",
      `awk -v b="branch refs/heads/$B" '/^worktree /{w=substr($0,10)} $0==b{print w}' /dev/null`,
    ],
    ["cut at a quoted brace", "cut -d'{' -f1 /dev/null"],
    ["sort keyed at a quoted bracket", "sort -t'[' -k2 /dev/null"],
    ["awk matching a regex that starts at / and holds a glob", "awk '/^a*b/' /dev/null"],
    ["sed printing a bold list item's lines", "sed -n '/^- \\*\\*/p' ~/.playground/x.md"],
    [
      "sed printing a bold list item's text",
      "sed -n 's/^- \\*\\*\\([^*]*\\)\\*\\*.*/\\1/p' ~/.playground/x.md",
    ],
    [
      "sed printing a range between two regex addresses",
      "sed -n '/## latest (proposal, round 2/,/^## Notes/p' notes.md",
    ],
    [
      "awk printing a range between two regexes by a flag",
      "awk '/^## latest \\(proposal, round 2/{f=1} /^## Notes/{f=0} f' notes.md",
    ],
    ["sed printing from a regex to the last line", "sed -n '/[Nn]it/,$p' notes.md"],
    ["sed printing a regex and the six lines after it", "sed -n '/[Rr]eviewer/,+6p' notes.md"],
    ["sed printing a function's lines", "sed -n '/^f() {/,/^}/p' notes.md"],
    [
      "awk printing a function's range from git show's output",
      "git show c668f859:scripts/ops/run-slot.sh | awk '/^memstat\\(\\)/,/^}/' | head -30",
    ],
    [
      "sed printing a function's range from git show's output",
      "git show c668f859:scripts/ops/run-slot.sh | sed -n '/^memstat()/,/^}/p'",
    ],
    [
      "awk after a sed that prints a line naming a shell",
      "sed -n '/sh -c/p' /dev/null; awk '$3 ~ /runner/' /dev/null",
    ],
    [
      "perl printing each match of a /g regex",
      `perl -ne 'print "$1\\n" while /#(\\d+)/g' notes.md`,
    ],
    ["perl printing every match with -l", "perl -lne 'print for /PG-\\d+/g' notes.md"],
    ["perl replacing a match with its variable", "perl -pe 's/(a)/<$1>/' notes.md"],
    [
      "sed printing the issue's line ranges after a grep",
      `grep -n -E "^ {0,2}(if |elif |else$|fi$)" scripts/spawn.sh | sed -n '/^13[2-9][0-9]:\\|^1[45][0-9][0-9]:/p'`,
    ],
    ["sed replacing a tag by a bracket class", "sed 's/<pasted_content[^>]*>/[P]/g' notes.md"],
    ["git -c with a literal pager", "git -c core.pager=less log"],
    ["rm of a glob in a build folder", "rm -rf build/*"],
    ["rm of a held folder's glob", "X=build; rm -rf $X/*"],
    ["rm of a held temporary folder", 'D=/tmp/x.1; rm -rf "$D"'],
    ["rm under HOME, which the hook holds", 'rm -rf "$HOME/tmp-x"'],
    [
      "rm of a held variable on a line whose print prints it",
      'X=/tmp/a; print -r -- "$X"; rm -rf "$X"',
    ],
    [
      "rm of a held variable beside a printf -v of another",
      'X=/tmp/a; printf -v Y "%s" a; rm -rf "$X"',
    ],
    ["rm of a held variable beside set -o", 'X=/tmp/a; set -o pipefail; rm -rf "$X"'],
    ["rm of a held variable zsh ties to nothing", 'P=/tmp/a; rm -rf "$P"'],
    ["rm of a held variable beside bash's name list", 'X=/tmp/a; echo "${!N*}"; rm -rf "$X"'],
    ["rm of a held variable beside bash's array keys", 'X=/tmp/a; echo "${!N[@]}"; rm -rf "$X"'],
    [
      "rm of a held variable beside the last background job's pid",
      'X=/tmp/a; echo "${!}"; rm -rf "$X"',
    ],
    [
      "rm of a held variable beside tests that read no name",
      'X=/tmp/a; test -v Y && [ -n "$X" ] && [ "$X" = /tmp/a ] && rm -rf "$X"',
    ],
    [
      "rm of a held variable beside arithmetic on literals",
      'X=/tmp/a; echo $((1 + 2)); rm -rf "$X"',
    ],
    [
      "rm of a held variable beside subscripts that name nothing",
      'X=/tmp/a; echo ${a[1]} $a[-1] ${a[@]} "${a[*]}" ${a[]} ${a[0:9]} $a[1,5] ${a[^V]}; rm -rf "$X"',
    ],
    [
      "rm of a held variable beside a glob qualifier that runs nothing",
      'X=/tmp/a; : build/*(.N); rm -rf "$X"',
    ],
    [
      "rm of a held variable beside a single-quoted jq filter that reads as a qualifier",
      `X=/tmp/a; jq '(.items[]|select(.id=="x"))' f; rm -rf "$X"`,
    ],
    [
      "rm of a held variable beside a jq filter after a heredoc whose body holds a lone quote",
      `X=/tmp/a; cat > f <<'EOF'\nit's\nEOF\njq '(.items[]|select(.id=="x"))' f; rm -rf "$X"`,
    ],
    ["a quiet commit with -m", `git commit -m "fix(x): y"`],
    ["a quiet commit with -am", `git commit -am "fix(x): y"`],
    ["a quiet commit with --message", `git commit --message "fix(x): y"`],
    ["a quiet commit with --message=", `git commit --message="fix(x): y"`],
    ["a quiet commit with a parenthesised scope and body", `git commit -m "feat(a,b): do (z)"`],
    ["a quiet commit reusing a commit, with a held message", `git commit -C HEAD -m "fix(x): y"`],
    ["a quiet commit by a system path", `/usr/bin/git commit -m "fix(x): y"`],
    [
      "a quiet commit on a quiet line after a reader",
      `grep -q x /dev/null; git commit -m "fix(x): y"`,
    ],
    ["gh api with a jq filter", `gh api repos/o/r/pulls --jq '.[] | "\\(.number) \\(.title)"'`],
    [
      "gh search with an attached jq filter",
      `gh search prs x --json number --jq='.[] | "\\(.number) x"'`,
    ],
    ["gh issue view with a jq filter", `gh issue view 1 --json title -q '"\\(.title) (open)"'`],
    ["gh issue view with a sliced body", `gh issue view 522 --json body -q '.body[0:900]'`],
    [
      "gh issue list with a jq filter",
      `gh issue list --json number,title --jq '.[]|"\\(.number) \\(.title[0:90])"'`,
    ],
    ["gh api with a Go template", `gh api x --template '{{range .}}{{.a}} {{end}}'`],
    ["gh api with a Go template by -t", `gh api x -t '{{range .}}{{.a}} {{end}}'`],
    ["gh pr view with a Go template", `gh pr view 1 --json a --template '{{.a}} x'`],
    [
      "gh issue create with a title naming the data folder",
      `gh issue create --title "a note about ~/.playground" --body x`,
    ],
    ["gh pr comment with a body naming the data folder", `gh pr comment 1 -b "see ~/.playground"`],
    [
      "a cd to a folder, then a sed range from a bracket regex",
      "cd /tmp && sed -n '/[Ff]ollow/,$p' f",
    ],
    [
      "a cd to the checkout, then gh's jq body through a sed range and head",
      `cd ${CHECKOUT} && gh api repos/o/r/issues/comments/1 --jq .body | sed -n '/[Ff]ollow/,$p' | head -40`,
    ],
  ])("%s runs from the home and the data folder", async (_, command) => {
    for (const cwd of homes) expect(await at(command, cwd)).toBeUndefined()
  })

  test("a gh post that opens an editor keeps canary's reading of its title", async () => {
    const command = `gh issue create --editor --title "a note about ~/.playground"`
    for (const cwd of homes) expect(await at(command, cwd)).toContain("no-extensions-write hook ")
  })

  test.each([
    ["ls of a glob", "ls *.md"],
    ["grep through a glob", "grep -n foo src/*.ts"],
    ["git add of a glob", "git add docs/*.md"],
    ["cat of a brace", "cat {a,b}.txt"],
    ["rm of a glob outside the root", "rm -f build/*.tmp"],
    ["grep of spaced text through a glob", "grep -rn 'foo bar' docs/*.md"],
    ["cp of a glob into a spaced folder", "cp docs/*.md 'out dir'"],
    ["a glob listing, then awk", "ls *.md; awk '{print $1}' f"],
    ["an unknown variable set, then awk", "x=\"$1\"; awk '{print $1}' f"],
    ["find running grep on spaced text", "find . -name '*.ts' -exec grep -l 'foo bar' {} +"],
    ["awk over each file of a glob", "for f in *.md; do awk '/sh -c/ {print}' \"$f\"; done"],
    [
      "a git call given an unread word, then a plain commit",
      "git log \"$REV\"; git commit -m 'fix(x): y'",
    ],
    ["a word piped to a root shell", "echo hi | sudo -s"],
    ["a listing piped to a root shell", "echo 'ls -la' | sudo -s"],
    ["a root shell given its command", "sudo -s ls"],
    [
      "sudo with a flag cluster holding a value option",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo -ui",
    ],
    [
      "gh pr view with a jq filter joining fields",
      `gh pr view 436 --json state,title,additions,deletions -q '.state+" "+.title+" +\\(.additions)/-\\(.deletions)"'`,
    ],
    [
      "gh run view with a jq filter joining a job's status and conclusion",
      `gh run view 1 --json jobs --jq '.jobs[] | "\\(.name) \\(.status)/\\(.conclusion)"'`,
    ],
    [
      "gh pr list with a jq filter joining fields",
      `gh pr list --json number,additions --jq '.[] | "\\(.number) +\\(.additions)/-x"'`,
    ],
    [
      "sudo whose user option comes first in a cluster and takes the shell letter as its value",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo -us",
    ],
    [
      "sudo whose user option comes first in a cluster, its value a uid",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo -us#0",
    ],
    [
      "doas whose user option comes first in a cluster and takes the shell letter as its value",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | doas -us",
    ],
    ["a quoted root shell flag given its command", "sudo '-s' ls"],
    ["a quoted root shell cluster given its command", "sudo '-su' root ls"],
    ["a quoted doas shell flag given its command", "doas '-s' ls"],
    ["a quoted sudo given its command", "'sudo' -s ls"],
    ["a quoted attached user value given its command", "sudo -su'root' ls"],
    ["an escaped shell letter given its command", "sudo -\\s ls"],
    ["a here-string to a quoted cluster given its command", "sudo -su'root' cat <<< 'ls -la'"],
    ["a second wrapper behind a quoted doas given its command", "'doas' sudo -i ls"],
    ["the shell long option given its command", "sudo --shell ls"],
    ["a shortened login long option given its command", "sudo --lo -u root ls"],
    [
      "sudo whose quoted user option comes first in a cluster and takes the shell letter as its value",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo '-us'",
    ],
    [
      "sudo whose user value is a quoted shell flag",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo -u'-s'",
    ],
    [
      "sudo given a long option prefix shared by its shell, set-home and stdin options",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo --s",
    ],
    [
      "sudo given a long option prefix shared by its list and login options",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo --l",
    ],
    [
      "sudo with its full user option and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo --user root ls",
    ],
    [
      "sudo with no options and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo ls",
    ],
    [
      "sudo with a shortened user option and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | sudo --us root ls",
    ],
    [
      "env's split string naming sudo and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | env -S 'sudo ls'",
    ],
    [
      "busybox running a harmless applet",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | busybox ls",
    ],
    [
      "nice running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | nice ls",
    ],
    [
      "time running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | time ls",
    ],
    [
      "timeout running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | timeout 5 ls",
    ],
    [
      "stdbuf running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | stdbuf -o0 ls",
    ],
    [
      "command running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | command ls",
    ],
    [
      "a quoted env's split string naming sudo and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | 'env' -S 'sudo ls'",
    ],
    [
      "a second env behind nice whose split string names sudo and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | env nice env -S 'sudo ls'",
    ],
    [
      "an abbreviated split-string option naming sudo and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | 'env' --split='sudo ls'",
    ],
    [
      "argv0's option ahead of a split string naming sudo and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | env nice env -a name -S 'sudo ls'",
    ],
    [
      "a lone dash ahead of a split string naming sudo and a harmless command",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | 'env' - -S 'sudo ls'",
    ],
    [
      "su given a harmless command of its own",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | su -c ls",
    ],
    [
      "su with a user given a harmless command of its own",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | su root -c 'ls -la'",
    ],
    [
      "busybox's su applet given a harmless command of its own",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | busybox su -c ls",
    ],
    [
      "busybox running another harmless applet",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | busybox cat",
    ],
    ["a harmless here-string on a brace group around bash", "{ bash; } <<< 'ls -la'"],
    ["a harmless here-string on descriptor 3 duplicated onto bash's stdin", "bash 3<<< 'ls' <&3"],
    [
      "pkexec running a program of its own",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | pkexec cat",
    ],
    [
      "env's lone dash ahead of a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | env - ls",
    ],
    ["a redirect through a variable set to a scratch path", "D=/tmp/scratch-dir; echo x > $D/x"],
    ["a redirect through a for loop's literal words", "for id in 1 2; do echo x > $id.log; done"],
    [
      "env's lone dash and an unset ahead of a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | env - -u X ls",
    ],
    [
      "genv running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | genv -u X ls",
    ],
    [
      "gnice running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | gnice -n 5 ls",
    ],
    [
      "gnohup running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | gnohup ls",
    ],
    [
      "gstdbuf running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | gstdbuf -o0 ls",
    ],
    [
      "gtimeout running a harmless program",
      "echo 'rm -rf ~/.playground/extensions/.no-such-folder' | gtimeout -k 1 5 ls",
    ],
    ["a quoted ~- used as a literal folder name", "mkdir '~-' && touch '~-/f'"],
    ["a write under ~+, the worktree itself", "touch ~+/f"],
    ["a write under ~- after a cd out of the worktree", "cd /usr; touch ~-/f"],
  ])("%s runs from a worktree", async (_, command) => {
    expect(await at(command, join(homedir(), "x", ".claude", "worktrees", "y"))).toBeUndefined()
  })

  test.each([
    [
      "bun -e holding a regex with a lookbehind",
      `bun -e 'const r = /(?<=x)y/; console.log(r.test("xy"))'`,
    ],
    [
      "node -e holding a regex with a lookbehind",
      `node -e 'const r = /(?<=a)b/; console.log(r.test("ab"))'`,
    ],
    [
      "agent-browser eval holding an anchored regex of a tag",
      `agent-browser eval 'const ok = /^<div>/.test(document.body.innerHTML); ok'`,
    ],
    ["node -pe holding a regex with a lookbehind", `node -pe '/(?<=a)b/.test("ab")'`],
    [
      "agent-browser eval after a valued option holding an anchored regex of a tag",
      `agent-browser --session x eval 'const ok = /^<div>/.test(document.body.innerHTML); ok'`,
    ],
    ["node -e opening with a regex with a lookbehind", `node -e '/(?<=a)b/.test("ab")'`],
    [
      "bun -e holding a regex with a lookbehind, piped into a reader",
      `bun -e 'const r = /(?<=a)b/; console.log(r.test("ab"))' | head -1`,
    ],
    [
      "awk reading a file into a variable with getline",
      `awk 'BEGIN { while ((getline line < "notes.md") > 0) n++; print n }'`,
    ],
  ])("%s runs from a worktree", async (_, command) => {
    expect(await at(command, join(homedir(), "x", ".claude", "worktrees", "y"))).toBeUndefined()
  })

  test.each([
    ["node -e opening with a regex that tests a string", `node -e '/^a/.test("ab")'`],
    ["node -pe opening with a regex that tests a string", `node -pe '/^a/.test("ab")'`],
    ["bun -e opening with a regex that tests a string", `bun -e '/x/.test("x")'`],
  ])(
    "%s runs from the home, the data folder and a worktree, as canary reads it",
    async (_, command) => {
      for (const cwd of [
        homedir(),
        join(homedir(), ".playground"),
        join(homedir(), "x", ".claude", "worktrees", "y"),
      ])
        expect(await at(command, cwd)).toBeUndefined()
    },
  )

  test.each([
    ["rm of mktemp's folder", 'T=$(mktemp -d); rm -rf "$T"'],
    ["rm of mktemp's quiet folder", 'T="$(mktemp -dq)"; rm -rf "$T"'],
    ["rm of mktemp's file", 'F=$(mktemp); rm -f "$F"'],
    ["rm of a pid-named temporary file", "rm -f /tmp/x.$$"],
    ["rm of mktemp's folder from a literal template", 'T=$(mktemp -d /tmp/x.XXXX); rm -rf "$T"'],
    [
      "rm of mktemp's folder from a held variable's template",
      'D=/tmp/w; T=$(mktemp -d "$D/x.XXXX"); rm -rf "$T"',
    ],
  ])("%s runs from the home with TMPDIR set", async (_, command) => {
    const env = { HOME: homedir(), TMPDIR: tmpdir() }
    const raw = JSON.stringify({ cwd: homedir(), tool_input: { command }, tool_name: "Bash" })
    expect(await check(raw, env)).toBeUndefined()
  })

  // #1123: the hook reads a plain mktemp's folder by its exact name, so one named in another case reads as a folder it cannot know, and a miss fails closed
  test("rm of a folder made by mktemp in capitals is refused from the home with TMPDIR set", async () => {
    const env = { HOME: homedir(), TMPDIR: tmpdir() }
    const command = 'T=$(MKTEMP -d); rm -rf "$T"'
    const raw = JSON.stringify({ cwd: homedir(), tool_input: { command }, tool_name: "Bash" })
    expect(await check(raw, env)).toBeDefined()
  })

  test("the dispatcher brief's call that finds the Dashboard's checkout runs from a worktree", async () => {
    const step = readFileSync(
      join(import.meta.dir, "../../../scripts/briefs/dispatcher.md"),
      "utf8",
    )
      .split("\n")
      .find((line) => line.startsWith("2. "))
    const spans = [...(step ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const call = ['R="', "curl ", "bun run --cwd "]
      .map((start) => spans.find((span) => span.startsWith(start)))
      .join("; ")
    expect(call).toContain("worktree list")
    expect(await at(call, join(homedir(), "x", ".claude", "worktrees", "y"))).toBeUndefined()
  })

  test.each([
    [
      "awk printing into the root",
      `awk '{print > "${join(homedir(), ".playground", "extensions", "x")}"}' /dev/null`,
    ],
    [
      "awk's system() naming the root",
      `awk 'BEGIN{system("touch ${join(homedir(), ".playground", "extensions", "x")}")}'`,
    ],
    ["touch in the root by ~", "touch ~/.playground/extensions/x"],
    [
      "awk's system() removing a path in the root",
      `awk 'BEGIN{system("rm -rf ~/.playground/extensions/.no-such-folder")}'`,
    ],
    [
      "awk printing into a command removing a path in the root",
      `awk 'BEGIN{print "x" | "rm -rf ~/.playground/extensions/.no-such-folder"}'`,
    ],
    [
      "awk reading a command removing a path in the root",
      `awk 'BEGIN{"rm -rf ~/.playground/extensions/.no-such-folder" | getline}'`,
    ],
    [
      "awk writing a removal into a git hook",
      `awk 'BEGIN{print "rm -rf ~/.playground/extensions/.no-such-folder" > ".git/hooks/pre-commit"}'`,
    ],
    [
      "awk's system() of a -v value removing a path in the root",
      "awk -v c='rm -rf ~/.playground/extensions/.no-such-folder' 'BEGIN{system(c)}'",
    ],
    [
      "gawk's system() removing a path in the root",
      `gawk 'BEGIN{system("rm -rf ~/.playground/extensions/.no-such-folder")}'`,
    ],
    [
      "nawk's system() removing a path in the root",
      `nawk 'BEGIN{system("rm -rf ~/.playground/extensions/.no-such-folder")}'`,
    ],
    [
      "sed's e command removing a path in the root",
      "sed 'e rm -rf ~/.playground/extensions/.no-such-folder' /dev/null",
    ],
    [
      "sed's addressed e command removing a path in the root",
      "sed '1e rm -rf ~/.playground/extensions/.no-such-folder' /dev/null",
    ],
    [
      "gsed's e command removing a path in the root",
      "gsed '1e rm -rf ~/.playground/extensions/.no-such-folder' /dev/null",
    ],
    [
      "awk's output sorted into a git hook by sort -o",
      "awk '$3 ~ /runner/' /dev/null | sort -o .git/hooks/pre-commit",
    ],
    [
      "awk's output written into a git hook by uniq's second file",
      "awk '$3 ~ /runner/' /dev/null | uniq - .git/hooks/pre-commit",
    ],
    [
      "awk's output sorted through a compress program",
      "awk '$3 ~ /runner/' /dev/null | sort --compress-program=sh",
    ],
    [
      "awk's output sorted into a git hook by an abbreviated --out",
      "awk '$3 ~ /runner/' /dev/null | sort --out=.git/hooks/pre-commit",
    ],
    [
      "awk's output sorted through an abbreviated --comp",
      "awk '$3 ~ /runner/' /dev/null | sort --comp=sh",
    ],
    [
      "a script named awk in the folder given a removal",
      "./awk 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a script named awk by a relative path given a removal",
      "bin/awk 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "awk run with PATH set in the call",
      "PATH=. awk 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "cut given a removal in a subshell",
      "( cut 'rm -rf ~/.playground/extensions/.no-such-folder' )",
    ],
    [
      "awk named as /usr/bin/time -o's output file, running watch",
      "/usr/bin/time -o awk watch 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "awk named as sudo --prompt's value, running watch",
      "sudo --prompt awk watch 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "cut under time, given watch and a removal",
      "time cut watch 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "sort under nohup, given watch and a removal",
      "nohup sort watch 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "uniq under exec, given watch and a removal",
      "exec uniq watch 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "awk after a printf, which keeps canary's reading",
      "printf '%s\\n' '/sh -c/p'; awk '$3 ~ /runner/' /dev/null",
    ],
    [
      "sed -i '' inserting a removal into a git hook",
      "sed -i '' '1i\\\nrm -rf ~/.playground/extensions/.no-such-folder' .git/hooks/pre-commit",
    ],
    [
      "sed -i '' appending a removal to a git hook",
      "sed -i '' '$a\\\nrm -rf ~/.playground/extensions/.no-such-folder' .git/hooks/pre-commit",
    ],
    [
      "sed -i '' prefixing a removal in a git hook",
      "sed -i '' 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed -i prefixing a removal in a git hook",
      "sed -i 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed -i.bak prefixing a removal in a git hook",
      "sed -i.bak 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed --in-place prefixing a removal in a git hook",
      "sed --in-place 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed --in-place= with a suffix prefixing a removal in a git hook",
      "sed --in-place=.bak 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed -ni prefixing a removal in a git hook",
      "sed -ni 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |p' .git/hooks/pre-commit",
    ],
    [
      "sed -Ei prefixing a removal in a git hook",
      "sed -Ei 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed with a trailing -i prefixing a removal in a git hook",
      "sed 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit -i",
    ],
    [
      "gsed -i prefixing a removal in a git hook",
      "gsed -i 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "/usr/bin/sed -i prefixing a removal in a git hook",
      "/usr/bin/sed -i '' 's|^|rm -rf ~/.playground/extensions/.no-such-folder; |' .git/hooks/pre-commit",
    ],
    [
      "sed's w command writing into the root",
      `sed 'w ${join(homedir(), ".playground", "extensions", "x")}' /dev/null`,
    ],
    [
      "sed's s///w flag writing into the root",
      `sed 's/a/b/w ${join(homedir(), ".playground", "extensions", "x")}' /dev/null`,
    ],
    [
      "watch removing a path in the root",
      "watch 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "watch removing by a glob in the data folder",
      "watch 'rm -rf ~/.playground/ext*/.no-such-folder'",
    ],
    [
      "watch with an unknown word ahead of rm",
      "watch '$3 rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "watch running the home, its substitution removing a path in the root",
      "watch '~ $(rm -rf ~/.playground/extensions/.no-such-folder)'",
    ],
    [
      "a git alias removing a path in the root",
      "git -c alias.x='!rm -rf ~/.playground/extensions/.no-such-folder' x",
    ],
    ["a git alias running its argument on the home", "git -c alias.x='!$1 ~' x rm"],
    [
      "git config setting an alias that removes a path in the root",
      "git config alias.x '!rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "ssh's ProxyCommand touching the root",
      "ssh -o ProxyCommand='touch ~/.playground/extensions/x' h",
    ],
    [
      "tmux's command removing a path in the root",
      "tmux new-session 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "rsync's -e removing a path in the root",
      "rsync -e 'rm -rf ~/.playground/extensions/.no-such-folder' a b",
    ],
    [
      "find's -exec removing a path in the root",
      "find . -exec sh -c 'rm -rf ~/.playground/extensions/.no-such-folder' \\;",
    ],
    [
      "GIT_SSH_COMMAND removing a path in the root",
      "GIT_SSH_COMMAND='rm -rf ~/.playground/extensions/.no-such-folder' git fetch",
    ],
    [
      "a git alias evaluating the word after -m",
      `git -c alias.x='!eval "$2"' x -m 'rm -rf ~/.playground/extensions/.no-such-folder'`,
    ],
    [
      "a git alias's sh -c running the word after -m",
      `git -c alias.x='!sh -c "$2"' x -m 'rm -rf ~/.playground/extensions/.no-such-folder'`,
    ],
    [
      "a git alias from the environment running the word after -m behind --attr-source commit",
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!eval "$2"' git --attr-source commit x -m 'rm -rf ~/.playground/extensions/.no-such-folder'`,
    ],
    [
      "a commit message under a call that sets config",
      "git -c x.y=z commit -m 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "screen's shell removing a path in the root",
      "screen -dm sh -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "flock's shell removing a path in the root",
      "flock /tmp/l sh -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    ["a shell held in a variable", "S=sh; $S -c 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    ["the user's shell", "$SHELL -c 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    ["ssh held in a variable", "x=ssh; $x host 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    [
      "watch held in a loop variable",
      "for p in watch; do $p 'rm -rf ~/.playground/extensions/.no-such-folder'; done",
    ],
    ["a shell in capitals", "SH -c 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    ["watch with a capital", "Watch 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    [
      "git in capitals running an alias",
      "GIT -c alias.x='!rm -rf ~/.playground/extensions/.no-such-folder' x",
    ],
    ["taskpolicy's shell", "taskpolicy -b sh -c 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    ["lockf's shell", "lockf -t0 /tmp/l sh -c 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    ["watch through bun x", "bun x watch 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    [
      "a shell through pnpm exec",
      "pnpm exec sh -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    ["eval through setsid", "setsid eval 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    ["ssh through sshpass", "sshpass -p x ssh h 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    [
      "scp's ProxyCommand removing a path in the root",
      "scp -o ProxyCommand='rm -rf ~/.playground/extensions/.no-such-folder' a h:b",
    ],
    ["a shell named by a ? glob", "/bin/s? -c 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    [
      "a shell named by a bracket glob",
      "/bin/[s]h -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a shell and its -c from a brace",
      "{sh,-c} 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a shell from a brace with an empty member",
      "{sh,} -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a globbed shell behind taskpolicy",
      "taskpolicy -b /bin/s? -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    ["a braced shell behind env", "env {sh,-c} 'rm -rf ~/.playground/extensions/.no-such-folder'"],
    [
      "a braced shell in bash -c's script",
      `bash -c "{sh,-c} 'rm -rf ~/.playground/extensions/.no-such-folder'"`,
    ],
    [
      "a shell named by a POSIX class",
      "/bin/[[:alpha:]]h -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a shell named by a brace range",
      "/bin/{r..t}h -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a shell named by an extglob",
      "/bin/@(sh) -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a shell named by a leading star",
      "/bin/*h -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a shell from a brace inside the name",
      "{s,}h -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a copy of a shell named by a glob",
      "./x? -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a star-named shell behind taskpolicy",
      "taskpolicy -b /bin/*h -c 'rm -rf ~/.playground/extensions/.no-such-folder'",
    ],
    [
      "a function that evals its arguments",
      `f() { eval "$@"; }; f 'rm -rf ~/.playground/extensions/.no-such-folder'`,
    ],
    [
      "a function that runs its argument by sh -c",
      `f() { sh -c "$1"; }; f 'rm -rf ~/.playground/extensions/.no-such-folder'`,
    ],
    [
      "a function by the function keyword",
      `function f { eval "$@"; }; f 'rm -rf ~/.playground/extensions/.no-such-folder'`,
    ],
    [
      "a payload set as an argument, then evaluated",
      `set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; eval "$1"`,
    ],
    [
      "a payload set as an argument, then run by bash -c",
      `set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; bash -c "$1"`,
    ],
    [
      "a payload set as an argument, then run by ssh",
      `set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; ssh h "$1"`,
    ],
    [
      "a payload set as an argument, then run by watch",
      `set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; watch "$1"`,
    ],
    [
      "a payload set as an argument, then run by the user's shell",
      `set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; "$SHELL" -c "$1"`,
    ],
    [
      "a payload held in the last argument",
      `true 'rm -rf ~/.playground/extensions/.no-such-folder'; eval "$_"`,
    ],
    [
      "a payload held by getopts",
      `getopts x o 'rm -rf ~/.playground/extensions/.no-such-folder'; eval "$o"`,
    ],
    [
      "a payload set in bash -c's script, then evaluated",
      `bash -c 'set -- "rm -rf ~/.playground/extensions/.no-such-folder"; eval "$1"'`,
    ],
    [
      "a commit message run by eval through $_",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; eval \"$_\"",
    ],
    [
      "a commit message run by eval through git log",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder' && eval \"$(git log -1 --format=%s)\"",
    ],
    [
      "a commit message run by sh -c through git log",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; sh -c \"$(git log -1 --format=%s)\"",
    ],
    [
      "a tag message run by eval through git tag",
      "git tag -m 'rm -rf ~/.playground/extensions/.no-such-folder' v1; eval \"$(git tag -l --format='%(contents)' v1)\"",
    ],
    [
      "a commit message piped into sh",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | sh",
    ],
    [
      "a commit message run through xargs and sh -c",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | xargs -I{} sh -c '{}'",
    ],
    [
      "a payload held in an array",
      `args=('rm -rf ~/.playground/extensions/.no-such-folder'); sh -c "\${args[0]}"`,
    ],
    [
      "a commit message sourced through process substitution",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; source <(git log -1 --format=%s)",
    ],
    [
      "a commit message fed to sh as a here-string",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; sh <<< \"$(git log -1 --format=%s)\"",
    ],
    [
      "a commit message sourced from stdin",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; . /dev/stdin <<< \"$(git log -1 --format=%s)\"",
    ],
    [
      "a commit message written to a script sh runs",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s > f.sh; sh f.sh",
    ],
    [
      "a commit message run as a substitution",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; $(git log -1 --format=%s)",
    ],
    [
      "a commit message run through a variable",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; x=$(git log -1 --format=%s); $x",
    ],
    [
      "a commit message piped into a glob program",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | /bin/s?",
    ],
    [
      "a commit message piped into ssh",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | ssh h",
    ],
    [
      "a commit message piped into ssh's sh",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | ssh h sh",
    ],
    [
      "a commit message piped into watch's sh",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | watch -x sh",
    ],
    [
      "an argument fed to sh as a here-string through $_",
      "true 'rm -rf ~/.playground/extensions/.no-such-folder'; sh <<< \"$_\"",
    ],
    [
      "an argument sourced through $_",
      "true 'rm -rf ~/.playground/extensions/.no-such-folder'; source <(echo \"$_\")",
    ],
    [
      "a positional fed to sh as a here-string",
      "set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; sh <<< \"$1\"",
    ],
    [
      "a positional piped into a glob program",
      "set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; echo \"$1\" | /bin/s?",
    ],
    [
      "a positional piped into ssh",
      "set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; echo \"$1\" | ssh h",
    ],
    [
      "a positional run as a command",
      "set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; $1",
    ],
    [
      "a positional written to a script sh runs",
      "set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; echo \"$1\" > f.sh; sh f.sh",
    ],
    [
      "a commit message run by a stored git alias through $_",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git x \"$_\"",
    ],
    [
      "a commit message run by git rebase -x",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git rebase -x \"$_\" HEAD~1",
    ],
    [
      "a commit message run by git rebase --exec",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git rebase --exec \"$_\" HEAD~1",
    ],
    [
      "a commit message run by git bisect run",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git bisect run \"$_\"",
    ],
    [
      "a commit message run by git submodule foreach",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git submodule foreach \"$_\"",
    ],
    [
      "a commit message run by git filter-branch",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git filter-branch -f --tree-filter \"$_\" HEAD",
    ],
    [
      "a commit message run by git difftool -x",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git difftool -y -x \"$_\" HEAD~1",
    ],
    [
      "a positional run by git rebase -x",
      "set -- 'rm -rf ~/.playground/extensions/.no-such-folder'; git rebase -x \"$1\" HEAD~1",
    ],
    [
      "an argument run by git submodule foreach",
      "true 'rm -rf ~/.playground/extensions/.no-such-folder'; git submodule foreach \"$_\"",
    ],
    [
      "a commit message run by a stored git alias with no argument",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git x",
    ],
    [
      "a commit message xargs hands git rebase -x",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | xargs -I{} git rebase -x {} HEAD~1",
    ],
    [
      "a commit message xargs hands git submodule foreach",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | xargs git submodule foreach",
    ],
    [
      "a commit message written to a script git rebase -x runs",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s > .git/x.sh; git rebase -x 'sh .git/x.sh' HEAD~1",
    ],
    [
      "a commit message written to a script git submodule foreach runs",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s > f.sh; git submodule foreach 'sh f.sh'",
    ],
    [
      "a commit message piped into git submodule foreach's sh",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | git submodule foreach sh",
    ],
    [
      "a commit message piped into git submodule foreach's sh -s",
      "git commit --allow-empty -m 'rm -rf ~/.playground/extensions/.no-such-folder'; git log -1 --format=%s | git submodule foreach 'sh -s'",
    ],
  ])("%s stays refused", async (_, command) => {
    for (const cwd of [...homes, join(homedir(), "x", ".claude", "worktrees", "y")])
      expect(await at(command, cwd)).toContain("no-extensions-write hook refuses")
  })

  // #1599: a refusal of a command that shows no write routes to the lead as a likely false positive, while one that writes keeps the owner's route
  test("a refusal of a command that shows no write asks for a false-positive report", async () => {
    const reason = await at("lsof -nP | awk 'NR>1 {print $2}'", homedir())
    expect(reason).toContain(
      "If this command writes nothing, report it to your lead as a false positive.",
    )
    expect(reason).not.toContain("the dispatcher hands the owner the command")
  })

  // a program that writes as called keeps the owner's route, whether or not the hook lists it as a writer
  test.each([
    ["touch on a file in the root", "touch ~/.playground/extensions/login/x"],
    [
      "an in-place sed on a file in the root",
      "sed -i '' 's/a/b/' ~/.playground/extensions/login/x.json",
    ],
    [
      "an in-place perl on a file in the root",
      "perl -pi -e 's/a/b/' ~/.playground/extensions/login/x.json",
    ],
    ["a chmod on a file in the root", "chmod 644 ~/.playground/extensions/login/x.json"],
    ["a chmod on a glob above the root", "chmod 644 ~/.playground/e*"],
  ])("%s keeps the owner's route", async (_, command) => {
    const reason = await at(command, homedir())
    expect(reason).toContain("the dispatcher hands the owner the command")
    expect(reason).not.toContain("report it to your lead as a false positive")
  })

  test("a refusal names a program it cannot read as such", async () => {
    expect(await at("git -c alias.x='!$1 ~' x rm", homedir())).toContain(
      "refuses a program it cannot read on",
    )
  })

  test.each([
    ["a glob of the data folder", "rm -rf .pl*", HOME],
    ["a brace of the data folder", "rm -rf {.playground,x}", HOME],
    ["a zsh group of the data folder", "rm -rf (.playground|x)", HOME],
    ["a zsh qualifier on every folder", "rm -rf *(/)", HOME],
    ["a glob through a link to the data folder", "rm -rf p*/extensions/x", HOME],
    ["bash's extglob @() of the data folder", "shopt -s extglob; rm -rf @(.playground)", HOME],
    ["bash's extglob +() of the data folder", "shopt -s extglob; rm -rf +(.playground)", HOME],
    ["bash's extglob ?() of the data folder", "shopt -s extglob; rm -rf ?(.playground)", HOME],
    ["bash's extglob !() of every other name", "shopt -s extglob; rm -rf !(x)", HOME],
    ["rm of a glob through a link to the root", "rm -rf s*/", DATA],
    ["a redirect through a glob of a link to the root", "echo x > s*/policy.json", DATA],
    ["a glob climbing back out to the data folder", "rm -rf w*/../.p*", HOME],
    [
      "a redirect climbing back out into the root",
      "echo x > w*/../.playground/extension?/policy.json",
      HOME,
    ],
    ["a glob in the data folder climbing to the root", "rm -rf .playground/h*/../e*", HOME],
    ["a glob climbing to the root from the data folder", "rm -rf h*/../e*", DATA],
    ["a glob climbing out to any other folder", "rm -rf w*/../Documents/x", HOME],
    ["a glob past a link and its `..`", "rm -rf store/../e*", HOME],
    ["a redirect to a glob no entry matches", "echo x > q*", DATA],
    ["rm of a glob no entry matches", "rm -rf q*", HOME],
  ])("%s stays refused, as every glob above the root is", async (_, command, cwd) => {
    expect(await bash(command, cwd)).toContain("no-extensions-write hook refuses")
  })

  test.each([
    [
      "git config set in the call, dropping its -c guard runs it",
      `git -c x.y=z commit -m "fix(x): y"`,
    ],
    [
      "a runner on the line, dropping its quiet-line guard runs it",
      `git commit -m "fix(x): y"; sh -c 'true'`,
    ],
    [
      "a redirect that writes a file from another call on the line, dropping its redirect guard runs it",
      `git commit -m "fix(x): y"; echo x > f`,
    ],
    [
      "a message holding the root's path as text, dropping its text guard runs it",
      `git commit -m "see ${join(homedir(), ".playground", "extensions")} now"`,
    ],
    [
      "a globbing file name after -F, which names a file not a held message",
      `git commit -F "my(x) file"`,
    ],
    [
      "a globbing name after --template, which names a file not a held message",
      `git commit --template "t(x) pl"`,
    ],
    [
      "a commit relocated by git -C, dropping its global guard runs it",
      `git -C /tmp commit -m "fix(x): y"`,
    ],
    [
      "a commit relocated by --git-dir, dropping its global guard runs it",
      `git --git-dir=/tmp/.git commit -m "fix(x): y"`,
    ],
    [
      "a commit relocated by --work-tree, dropping its global guard runs it",
      `git --work-tree=/tmp commit -m "fix(x): y"`,
    ],
  ])(
    "a git commit the hook does not read as text stays refused from the home: %s",
    async (_, command) => {
      for (const cwd of homes)
        expect(await at(command, cwd)).toContain("no-extensions-write hook refuses")
    },
  )

  test.each([
    "sudo git",
    "sudo -u x git",
    "doas git",
    "env git",
    "env -i git",
    "env -S 'git'",
    "xargs git",
    "nice git",
    "nice -n 5 git",
    "nohup git",
    "timeout 5 git",
    "time git",
    "stdbuf -o0 git",
    "caffeinate git",
    "command git",
    "builtin git",
    "exec git",
    "./git",
    "bin/git",
    "~/bin/git",
    "/tmp/x/git",
  ])(
    "a quiet message on %s, a program narrow() would not read, keeps canary's refusal",
    async (program) => {
      for (const cwd of homes)
        expect(await at(`${program} commit -m "fix(x): y"`, cwd)).toContain(
          "no-extensions-write hook refuses",
        )
    },
  )
})

describe("a read of the root, and writes elsewhere, run", () => {
  test.each([
    ["cat of a list", `cat ${LIST}`],
    ["jq of policy.json", `jq . ${join(ROOT, "policy.json")}`],
    ["ls of the root by ~", "ls -la ~/.playground/extensions ~/.playground/extensions/hooks"],
    ["grep in the root", `grep -rn Slack ${ROOT}`],
    ["grep named in capitals over the home, a read like grep's", "GREP -rn foo ."],
    ["head and wc", `head -5 ${LIST} && wc -l ${LIST}`],
    ["find without an action", `find ${ROOT} -name '*.json'`],
    ["git log in a scope", `git -C ${SCOPE} log --oneline -5`],
    ["git show in a scope", `cd ${SCOPE} && git show HEAD --stat`],
    ["git status in a scope", `git -C ${SCOPE} status`],
    ["a list read into a file elsewhere", `cat ${LIST} > /tmp/copy.json`],
    ["a handoff in the data folder", `echo next > ${join(DATA, "handoffs", "w.md")}`],
    ["the roster's writer", "bun scripts/roster.ts set w status=working"],
    ["a write in a worktree", "echo x > notes.txt"],
    ["rm elsewhere", "rm -rf /tmp/scratch-dir"],
    ["a redirect through a variable set to a scratch path", "D=/tmp/scratch-dir; echo x > $D/x"],
    [
      "an append through a variable exported to a scratch path",
      'export D=/tmp/scratch-dir; echo x >> "$D/x"',
    ],
    [
      "a redirect through a for loop's literal words",
      "for id in 1 2; do gh run view $id > /tmp/run-$id.log; done",
    ],
    [
      "a redirect through two nested for loops' literal words",
      "for id in 1 2; do for j in a b; do echo x > /tmp/$id-$j.log; done; done",
    ],
    ["a glob elsewhere", "rm -rf /tmp/scratch-dir/*"],
    ["a printer naming the root", `echo ${ROOT}`],
    ["tr with a bare slash", "tr / _ < /tmp/x"],
    ["rg naming the CLI's words", "rg playground settings"],
    ["grep naming a gated call", `grep -rn "playground ext sync" docs`],
    ["echo naming a gated call", "echo playground ext sync"],
    ["a default in ${X:-…}", "echo ${X:-default}"],
    ["bash reading a process substitution that writes elsewhere", "bash <(echo ls /tmp)"],
    ["git log with a pager", "GIT_PAGER=cat git log"],
    ["git -c of a name", "git -c user.name=x commit -m y"],
    ["a commit message naming ext sync", `git commit -m "fix: read ext sync forms"`],
    [
      "a comment naming a settings set no guard reads",
      `gh pr comment 1 --body "run playground settings set ui.theme dark"`,
    ],
    ["rg of a gated call", "rg 'playground ext sync'"],
    ["cat of two 900 KB files into one elsewhere", `cat ${BIG[0]} ${BIG[1]} > /tmp/nxw-all`],
    ["rg with --pre-glob alone", "rg --pre-glob '*.gz' x /tmp"],
    ["a git author name with a space", "GIT_AUTHOR_NAME='A B' git log"],
    ["a pager with an option", "GIT_PAGER='less -R' git log"],
    ["a commit message with an unbalanced quote", `git commit -m "it's fine"`],
    [
      "the CLI's render through ext put of a doc",
      "playground ext put login doc audit-x /tmp/a.md --reason why",
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("a reader inside the root", async () => {
    expect(await bash("cat policy.json", ROOT)).toBeUndefined()
  })

  test("grep named in capitals over the data folder, a read like grep's", async () => {
    expect(await bash("GREP -rn foo .", DATA)).toBeUndefined()
  })

  test.each([
    ["Read is no write", "Read", { file_path: LIST }],
    ["Write elsewhere", "Write", { content: "x", file_path: join(DATA, "handoffs", "w.md") }],
    [
      "Edit of a sibling folder named alike",
      "Edit",
      { file_path: join(DATA, "extensions-notes", "a.md") },
    ],
  ])("%s", async (_, name, input) => {
    expect(await tool(name, input)).toBeUndefined()
  })
})

describe("a write the hook can place outside the root runs, after a cd it cannot read too (PG-646)", () => {
  test.each([
    ["rm of a relative path after a cd to a literal path", "cd /tmp/x && rm -rf build"],
    ["a reader after a cd to a variable", `cd "$X"; ls`],
    [
      "a program after a cd to the checkout's top",
      `cd "$(git rev-parse --show-toplevel)" && bun test`,
    ],
    ["git status after a cd to a variable", `cd "$X" && git status`],
    ["a redirect to an absolute path after a cd to a variable", `cd "$X"; echo x > /tmp/y`],
    ["rm of an absolute path after a cd to a variable", `cd "$X"; rm -rf /tmp/scratch-dir`],
    ["cp of a relative file to an absolute path after a cd to a variable", `cd "$X"; cp a /tmp/b`],
    [
      "a redirect to a file the line holds after a cd to a variable",
      `F=/tmp/y; cd "$X"; echo x > "$F"`,
    ],
    ["a plain git log", "git log"],
    ["a plain git status", "git status"],
    ["git -c of a pager", "git -c core.pager=less log"],
    ["a git author name from a variable", `GIT_AUTHOR_NAME="$N" git commit -m x`],
    ["cp to a literal path elsewhere", "cp x /tmp/y"],
    ["cp to a path the line holds", `D=/tmp/d; cp x "$D/y"`],
    [
      "cp to a path the line holds beside trap, sched and autoload as words",
      `D=/tmp/d; echo trap sched autoload; cp x "$D/y"`,
    ],
    [
      "cp to a path the line holds after a program named by its path",
      `D=/tmp/d; /bin/echo hi; cp x "$D/y"`,
    ],
    ["cp of a variable to a literal path", `cp "$S" /tmp/y`],
    ["touch with a reference file from a variable", `touch -r "$R" /tmp/y`],
    ["dd reading a variable to a literal path", `dd if="$S" of=/tmp/y`],
    ["tee to a literal path", "echo x | tee /tmp/y"],
    ["tee to its own output", "echo x | tee -"],
    ["a reading redirect after a cd to a variable", `cd "$X"; wc -l < notes.txt`],
    ["cp to an absolute path holding an = after a cd to a variable", `cd "$X"; cp x /tmp/a=b`],
    ["dd to an absolute path after a cd to a variable", `cd "$X"; dd if=x of=/tmp/y`],
    ["cp into an absolute target folder after a cd to a variable", `cd "$X"; cp -t /tmp/d x`],
    ["ln between absolute paths after a cd to a variable", `cd "$X"; ln -s /tmp/x /tmp/y`],
    ["cp to a path the line holds after a cd to a variable", `D=/tmp/d; cd "$X"; cp x "$D/y"`],
    ["mkdir with a mode from a variable", `mkdir -m "$M" /tmp/x`],
    ["cp of a variable into a literal target folder", `cp -t /tmp/d "$S"`],
    ["ln of a variable to a literal path", `ln -s "$S" /tmp/l`],
    ["install of a variable past its mode", `install -m 644 "$S" /tmp/i`],
    ["install of literal folders", "install -d /tmp/a /tmp/b"],
    ["touch with a date from a variable", `touch -d "$W" /tmp/y`],
    ["touch with a stamp from a variable", `touch -t "$W" /tmp/y`],
    [
      "git with a pager the call sets over an exported one",
      `export GIT_PAGER="$P"; GIT_PAGER=less git log`,
    ],
    ["git with a variable git does not read from a variable", `FOO="$F" git log`],
    ["git with a pager the line holds", `P=less; GIT_PAGER="$P" git log`],
    ["git with a literal config home", "XDG_CONFIG_HOME=/tmp/c git log"],
    ["git with a literal home", "HOME=/tmp/h git log"],
    ["GNU cp of a variable after the end of options", `gcp -- "$S" /tmp/y`],
    ["GNU cp of a variable the line holds", `S=/tmp/s; gcp "$S" /tmp/y`],
    ["GNU cp to a literal path", "gcp x /tmp/y"],
    ["GNU rm of a literal path elsewhere", "grm -rf /tmp/scratch-dir"],
    ["GNU install with a mode from a variable", `ginstall -m "$M" x /tmp/y`],
    ["install with a group and an owner from variables", `install -g "$G" -o "$O" x /tmp/y`],
    ["install past a group holding a t", "install -gstaff x /tmp/y"],
    ["GNU ln with a suffix from a variable", `gln -S "$B" /tmp/src /tmp/dst`],
    ["GNU cp with a long suffix from a variable", `gcp --suffix "$B" x /tmp/y`],
    ["git commit with a variable git does not read from a variable", `FOO="$F" git commit -m x`],
    ["GNU mkdir with a mode from a variable after its first operand", `gmkdir /tmp/x -m "$M"`],
    ["macOS install of folders past a destdir from a variable", `install -d -D "$R" /tmp/a`],
    [
      "GNU cp by its gnubin path of a variable after the end of options",
      `/opt/homebrew/opt/coreutils/libexec/gnubin/cp -- "$S" /tmp/y`,
    ],
    [
      "rm past an option before its first operand after a cd to a variable",
      `cd "$X"; rm -f /tmp/x`,
    ],
    [
      "GNU rm past an option after its first operand after a cd to a variable",
      `cd "$X"; grm /tmp/x -f`,
    ],
    [
      "unlink of an absolute path past its end of options after a cd to a variable",
      `cd "$X"; unlink -- /tmp/x`,
    ],
    ["find with its expression after a cd to a variable", `cd "$X"; find /tmp/x -delete`],
    ["rsync of absolute paths after a cd to a variable", `cd "$X"; rsync -a /tmp/a /tmp/b`],
    [
      "GNU rm by its gnubin path past an option after its first operand after a cd to a variable",
      `cd "$X"; /opt/homebrew/opt/coreutils/libexec/gnubin/rm /tmp/x -f`,
    ],
    [
      "GNU mv to an absolute target folder after a cd to a variable",
      `cd "$X"; gmv -t /tmp/d /tmp/f`,
    ],
    [
      "GNU mv to an absolute target folder attached after a cd to a variable",
      `cd "$X"; gmv -t/tmp/d /tmp/f`,
    ],
    [
      "GNU mv to an absolute target folder by its long option after a cd to a variable",
      `cd "$X"; gmv --target-directory=/tmp/d /tmp/f`,
    ],
    [
      "rsync with an absolute log file attached after a cd to a variable",
      `cd "$X"; rsync -a --log-file=/tmp/l /tmp/a /tmp/b`,
    ],
    [
      "rsync with an absolute temp folder attached to its short option after a cd to a variable",
      `cd "$X"; rsync -a -T/tmp/t /tmp/a /tmp/b`,
    ],
    [
      "rsync with a filter rule holding a T after a cd to a variable",
      `cd "$X"; rsync -a -f'+ Tx' /tmp/a /tmp/b`,
    ],
    [
      "rsync with an absolute partial folder by a shortened long option after a cd to a variable",
      `cd "$X"; rsync -a --partial-d=/tmp/p /tmp/a /tmp/b`,
    ],
    [
      "rsync with a log format by a shortened long option after a cd to a variable",
      `cd "$X"; rsync -a --log-file-f=x /tmp/a /tmp/b`,
    ],
    [
      "rsync with a relative link folder it only reads after a cd to a variable",
      `cd "$X"; rsync -a --link-dest=prev /tmp/a /tmp/b`,
    ],
    [
      "rsync with an absolute partial folder as the next word after a cd to a variable",
      `cd "$X"; rsync -a --partial-dir /tmp/p /tmp/a /tmp/b`,
    ],
    [
      "rsync with an absolute temp folder after a cluster ending in its short option after a cd to a variable",
      `cd "$X"; rsync -aT /tmp/t /tmp/a /tmp/b`,
    ],
    [
      "rsync with a dash-led block size after its short option after a cd to a variable",
      `cd "$X"; rsync -a -B -1 /tmp/a /tmp/b`,
    ],
    [
      "rsync with its partial flag, a prefix of its partial folder option, after a cd to a variable",
      `cd "$X"; rsync -a --partial --progress /tmp/a /tmp/b`,
    ],
    [
      "rsync with its backup flag, a prefix of its backup folder option, after a cd to a variable",
      `cd "$X"; rsync -a --backup --suffix=.bak /tmp/a /tmp/b`,
    ],
    [
      "find printing to an absolute file after a cd to a variable",
      `cd "$X"; find /tmp/x -fprint /tmp/out`,
    ],
    [
      "GNU find by its g name printing to an absolute file after a cd to a variable",
      `cd "$X"; gfind /tmp/x -fprint /tmp/out`,
    ],
    [
      "GNU find by its g name deleting an absolute path after a cd to a variable",
      `cd "$X"; gfind /tmp/x -delete`,
    ],
    [
      "GNU find by its g name printing names after a cd to a variable",
      `cd "$X"; gfind /tmp -name x -print`,
    ],
    ["GNU xargs by its g name running echo", "echo a | gxargs echo"],
    [
      "GNU xargs by its g name running echo after a cd to a variable",
      `cd "$X"; echo a | gxargs echo`,
    ],
    [
      "GNU find by its g name printing to a held absolute file after a cd to a variable",
      `O=/tmp/out; cd "$X"; gfind /tmp/x -fprint "$O"`,
    ],
    [
      "GNU find by a path to its g name printing to an absolute file after a cd to a variable",
      `cd "$X"; /opt/homebrew/bin/gfind /tmp/x -fprint /tmp/out`,
    ],
    [
      "GNU find by its g name in capitals printing names after a cd to a variable",
      `cd "$X"; GFIND /tmp/x -name x`,
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command, WORK)).toBeUndefined()
  })

  test.each([
    ["a write after a sure cd out of the root", "cd /tmp && echo x > y"],
    ["a reader after a cd to a variable", `cd "$X"; cat policy.json`],
  ])("%s, from the root", async (_, command) => {
    expect(await bash(command, ROOT)).toBeUndefined()
  })
})

describe("a quoted or held value stays one word in every shell (PG-1133, PG-1268)", () => {
  test.each([
    ["ln of one quoted variable in bash -c", `bash -c 'ln -s "$X"'`],
    ["ln of a quoted command substitution", `ln -s "$(cat /tmp/f)" /tmp/l`],
    ["cp of a command substitution to a literal last path", "cp $(cat /tmp/f) /tmp/x"],
    ["ln of a quoted default", `ln -s "\${X:-/tmp/d}"`],
    ["dd with a quoted variable after if=", `dd if="$X"`],
    ["ln of a quoted positional parameter", `ln -s "$1"`],
    ["ln of a held variable", "D=/tmp/d; ln -s $D"],
    [
      "dd of a quoted pattern cut holding the positional parameters in bash -c",
      `bash -c 'dd if="\${X#$@}"'`,
    ],
    ["dd of a quoted default holding zsh's argv", `dd if="\${X:-$argv}"`],
  ])("%s", async (_, command) => {
    expect(await bash(command, WORK)).toBeUndefined()
  })
})

describe("a playground CLI call that changes what a guard reads is refused, naming the owner's route", () => {
  test.each([
    [
      "ext put of a list",
      "playground ext put login list desktop-owner-apps /tmp/l.json --reason x",
    ],
    [
      "ext put of a list past an option",
      "playground ext put --reason x login list release-owners -",
    ],
    [
      "ext put of a list by the CLI's path",
      "bun ~/playground/packages/scripts/src/playground/cli.ts ext put login list x /tmp/l.json --reason y",
    ],
    [
      "ext put of a list by the bin's path",
      "~/.bun/bin/playground ext put login list x /tmp/l.json --reason y",
    ],
    [
      "ext put of a list through run-slot",
      "~/.playground/ops/run-slot.sh w -- playground ext put login list x /tmp/l.json --reason y",
    ],
    [
      "ext put of a list through bash -c",
      "bash -c 'playground ext put login list x /tmp/l.json --reason y'",
    ],
    [
      "ext put by bun on the installed link",
      "bun ~/.bun/bin/playground ext put login list x /tmp/l.json --reason y",
    ],
    [
      "ext put by bun --cwd to its folder",
      `bun --cwd ${CLI_DIR} cli.ts ext put login list x /tmp/l.json --reason y`,
    ],
    [
      "ext put by bun on cli with no extension",
      `bun ${CLI_DIR}/cli ext put login list x /tmp/l.json --reason y`,
    ],
    [
      "ext put by cli.ts run directly",
      `${CLI_DIR}/cli.ts ext put login list x /tmp/l.json --reason y`,
    ],
    [
      "ext put by bun past --preload",
      `bun --preload /tmp/x.ts ${CLI_DIR}/cli.ts ext put login list x /tmp/l.json --reason y`,
    ],
    [
      "ext put past a word it cannot read",
      'playground ext put "$(printf -- --dry-run)" login list x /tmp/x.json --reason r',
    ],
    ["settings set of live.branch", "playground settings set live.branch x --reason r"],
    ["settings set of paths.codeRoot", "playground settings set paths.codeRoot / --reason r"],
    ["settings set of sessions.names", "playground settings set sessions.names '{}' --reason r"],
    [
      "settings set of sessions.aliases",
      "playground settings set sessions.aliases '{}' --reason r",
    ],
    ["ext import --from-tree", "playground ext import --from-tree extensions/core/lists"],
    ["ext import of a folder", "playground ext import /tmp/scopes"],
    ["ext sync", "playground ext sync"],
    ["ext sync of one scope", "playground ext sync login"],
    ["ext add", "playground ext add acme --yes"],
    ["ext init", "playground ext init --yes"],
    ["ext remove", "playground ext remove acme"],
    ["ext link", "playground ext link acme '*'"],
    ["ext unlink", "playground ext unlink acme acme-org"],
    ["ext order", "playground ext order acme login"],
    ["ext remove with a --dry-run it ignores", "playground ext remove acme --dry-run"],
    ["settings set of ext.links", "playground settings set ext.links '{}' --reason x"],
    [
      "settings set of factory.publicRepo",
      "playground settings set factory.publicRepo a/b --reason x",
    ],
    [
      "settings set of usage.keychainService",
      "playground settings set usage.keychainService x --reason x",
    ],
    [
      "settings set of glm.readOnlyLoad5",
      "playground settings set glm.readOnlyLoad5 99 --reason x",
    ],
    [
      "settings set of a guard key past an option",
      "playground settings set --scope acme owner.names '[]' --reason x",
    ],
    ["settings reset of a guard key", "playground settings reset glm.readOnlyLoad5 --reason x"],
    ["settings set of a key the hook cannot read", 'playground settings set "$KEY" 1 --reason x'],
    ["migrate", "playground migrate --archive /tmp/a --pre-squash abc --org acme"],
    ["uninstall --purge", "playground uninstall --purge"],
    ["a command word the hook cannot read", 'playground "$CMD" put login list x /tmp/l.json'],
    ["an ext verb the hook cannot read", 'playground ext "$VERB" acme'],
    ["ext put of a kind the hook cannot read", 'playground ext put login "$KIND" x /tmp/l.json'],
  ])("%s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-extensions-write hook refuses")
    expect(reason).toContain("!")
  })

  test.each([
    ["settings set of owner.names", "playground settings set owner.names '[]' --reason x"],
    [
      "settings set of factory.archiveRepo",
      "playground settings set factory.archiveRepo a/b --reason x",
    ],
    [
      "settings set past --yes, which settings takes as an option",
      `playground settings set --yes ui.theme owner.names '["x"]' --reason r`,
    ],
    [
      "settings reset past --yes",
      "playground settings reset --yes ui.theme owner.names --reason r",
    ],
  ])(
    "%s at your login's scope routes the owner to Privacy on the Settings page",
    async (_, command) => {
      const reason = await bash(command)
      expect(reason).toContain("no-extensions-write hook refuses")
      expect(reason).toContain(
        "tell your lead, and the dispatcher asks the owner to save it in Privacy on the Dashboard's Settings page.",
      )
      expect(reason).not.toContain("terminal window")
    },
  )

  test("a Privacy key at an org's scope, which Privacy does not save, keeps the ! route", async () => {
    const reason = await bash("playground settings set --scope acme owner.names '[]' --reason x")
    expect(reason).toContain("in the dispatcher's terminal window")
  })

  test.each([
    [
      "ext put by bun cli.ts in its folder",
      "bun cli.ts ext put login list x /tmp/l.json --reason y",
      CLI_DIR,
    ],
    [
      "ext put by bun ./cli.ts in its folder",
      "bun ./cli.ts ext put login list x /tmp/l.json --reason y",
      CLI_DIR,
    ],
    [
      "ext put by ./cli.ts in its folder",
      "./cli.ts ext put login list x /tmp/l.json --reason y",
      CLI_DIR,
    ],
    [
      "ext put by bun run from the checkout",
      "bun run packages/scripts/src/playground/cli.ts ext put login list x /tmp/l.json --reason y",
      CHECKOUT,
    ],
  ])("%s", async (_, command, cwd) => {
    expect(await bash(command, cwd)).toContain("no-extensions-write hook refuses")
  })
})

describe("a factory session's ext accept is refused, since accepting a proposal is the owner's own call", () => {
  test.each([
    ["ext accept", "playground ext accept login rule x abc --reason ok"],
    ["ext accept --by owner", "playground ext accept login rule x abc --reason ok --by owner"],
    ["ext accept past an option", "playground ext accept --reason ok login rule x abc"],
    [
      "ext accept with the role cleared",
      "PLAYGROUND_ROLE= playground ext accept login rule x abc --reason ok",
    ],
    [
      "ext accept behind env -u",
      "env -u PLAYGROUND_ROLE playground ext accept login rule x abc --reason ok",
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain(
      "refuses playground ext accept, the owner's own call: post it as an accept decision with playground ask new (.agents/dashboard/asks.md), whose Approve has the dashboard run it with no role",
    )
  })
})

describe("git's global options before a push keep a bare push's verdict", () => {
  test.each([
    ["the data folder", DATA],
    ["the home folder", HOME],
  ])("from %s", async (_, cwd) => {
    for (const command of [
      "git push",
      "git --attr-source HEAD push",
      "git -c k=v push",
      "git -C /usr push",
    ])
      expect(await bash(command, cwd)).toBeUndefined()
  })
})

describe("a playground CLI call that no guard reads runs", () => {
  test.each([
    ["ext put of a doc", "playground ext put login doc plan-x /tmp/p.md --reason x"],
    ["ext put of a rule", "playground ext put login rule voice /tmp/r.md --reason x"],
    ["ext put of a skill", "playground ext put login skill x /tmp/s --reason x"],
    ["ext list", "playground ext list"],
    ["ext show of a list", "playground ext show login list release-owners"],
    ["ext search", "playground ext search guard list"],
    ["ext which", "playground ext which playbook"],
    ["ext why of a list", "playground ext why login list release-owners"],
    ["ext diff", "playground ext diff login list x --from a --to b"],
    ["ext export", "playground ext export /tmp/out"],
    ["ext score", "playground ext score login doc x abc 5 --reason ok"],
    [
      "ext score behind env -u of another variable",
      "env -u HOME playground ext score login doc x abc 5 --reason ok",
    ],
    [
      "ext score with another data folder variable",
      "TZ=UTC playground ext score login doc x abc 5 --reason ok",
    ],
    ["ext list behind env -u of the role", "env -u PLAYGROUND_ROLE playground ext list"],
    ["ext show behind env -i", "env -i playground ext show login list release-owners"],
    [
      "ext search after the role is exported empty",
      "export PLAYGROUND_ROLE=; playground ext search x",
    ],
    ["ext import --dry-run", "playground ext import --from-tree extensions/core/lists --dry-run"],
    ["ext init --dry-run", "playground ext init --dry-run"],
    ["ext add --dry-run", "playground ext add acme --dry-run"],
    ["settings list", "playground settings list"],
    ["settings get", "playground settings get owner.names"],
    ["settings why", "playground settings why ext.links"],
    ["settings set of a key no guard reads", "playground settings set ui.theme dark --reason x"],
    ["settings reset of a key no guard reads", "playground settings reset ui.theme --reason x"],
    ["settings import-jobs --dry-run", "playground settings import-jobs /tmp/jobs.json --dry-run"],
    ["rules", "playground rules voice"],
    ["uninstall without --purge", "playground uninstall"],
    ["status", "playground status"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("the hook's run", () => {
  test("a check in its Worker answers as the check does", async () => {
    const raw = JSON.stringify({
      cwd: HOME,
      tool_input: { command: `rm ${LIST}` },
      tool_name: "Bash",
    })
    expect(await guarded(raw, ENV)).toBe(await check(raw, ENV))
    const read = JSON.stringify({
      cwd: HOME,
      tool_input: { command: `cat ${LIST}` },
      tool_name: "Bash",
    })
    expect(await guarded(read, ENV)).toBeUndefined()
  })

  // the timer fires at 1 s; a slow step left to the worker answers only at the walk's 10 s deadline or later, past this test's time
  test("a single step the deadline cannot interrupt is refused when the main thread's timer fires", async () => {
    const command = `printf '%s${",".repeat(60)}' '{' ${"x ".repeat(6_000)}| xargs -I @ watch '@ a'; playground ext import x`
    const raw = JSON.stringify({ cwd: "/tmp", tool_input: { command }, tool_name: "Bash" })
    expect(await guarded(raw, ENV, 1_000)).toContain("split it into shorter calls")
  }, 5_000)

  // a worker that never answers leaves only the main thread's timer to end the call
  test("a check that never answers is refused when the main thread's timer fires", async () => {
    const busy = new URL("./fixtures/busy-worker.ts", import.meta.url).href
    expect(await guarded("{}", ENV, 300, busy)).toContain("split it into shorter calls")
  })

  test("it fails open on input it cannot read", async () => {
    expect(await check("not json", ENV)).toBeUndefined()
  })

  test("a machine with no extensions root still refuses a write that would make one", async () => {
    const home = mkdtempSync(join(tmpdir(), "no-extensions-write-bare-"))
    try {
      const reason = await check(
        JSON.stringify({
          cwd: home,
          tool_input: { command: `mkdir -p ${home}/.playground/extensions/hooks` },
          tool_name: "Bash",
        }),
        { HOME: home },
      )
      expect(reason).toContain("no-extensions-write hook refuses")
    } finally {
      rmSync(home, { force: true, recursive: true })
    }
  })
})

// Every settings key a hook (and the helper no-public-leak reads its repos through) names is gated, so a guard that starts reading a new key fails here until it joins GUARD_KEYS; spawn.sh's code root is pinned by name.
describe("the gated keys are every key the guards read", () => {
  const read = async (path: string) => Bun.file(join(CHECKOUT, path)).text()
  const defined = async () => {
    const keys = new Set<string>()
    for await (const file of new Bun.Glob("packages/settings/src/*.ts").scan(CHECKOUT))
      for (const m of (await read(file)).matchAll(/^ {2}"([a-z]+\.[A-Za-z0-9]+)": \{/gm))
        keys.add(m[1]!)
    return keys
  }

  test("each key a hook names is gated", async () => {
    const keys = await defined()
    expect(keys.size).toBeGreaterThan(20)
    const files = [
      ...(await Array.fromAsync(new Bun.Glob("scripts/hooks/*.ts").scan(CHECKOUT))),
      "packages/scripts/src/trace-count/kinds.ts",
    ].filter((file) => !file.endsWith("no-extensions-write.ts"))
    const named: string[] = []
    for (const file of files) {
      const text = await read(file)
      for (const key of keys) if (text.includes(`"${key}"`)) named.push(`${file}: ${key}`)
    }
    expect(named.length).toBeGreaterThan(5)
    expect(named.filter((hit) => !GUARD_KEYS.has(hit.split(": ")[1]!))).toEqual([])
  })

  test("ext.order, which orders the extensions every guard reads, is gated", async () => {
    expect(await read("packages/settings/src/settings.ts")).toContain('values["ext.order"]')
    expect(GUARD_KEYS.has("ext.order")).toBe(true)
  })

  test("spawn.sh's code root is gated", async () => {
    expect(await read("scripts/spawn.sh")).toContain("setting_text paths.codeRoot")
    expect(GUARD_KEYS.has("paths.codeRoot")).toBe(true)
  })
})

// PG-1090: the Inbox's guard decision takes the keys GUARD_SETTING_KEYS names, so the two lists are one, and a session's own write of each stays refused.
describe("a guard decision's keys are the keys the hook gates (PG-1090)", () => {
  test("GUARD_KEYS holds GUARD_SETTING_KEYS, no more and no fewer", () => {
    expect([...GUARD_KEYS].sort()).toEqual([...GUARD_SETTING_KEYS].sort())
  })

  test.each([...GUARD_SETTING_KEYS])(
    "a session's own settings set and reset of %s are refused",
    async (key) => {
      expect(
        await bash(`playground settings set ${key} '{}' --scope acme-test --reason r`),
      ).toContain("no-extensions-write hook refuses")
      expect(await bash(`playground settings reset ${key} --scope acme-test --reason r`)).toContain(
        "no-extensions-write hook refuses",
      )
    },
  )
})

// PG-1196: the guard decision also sets a job's enabled field, so a session's own write of it stays refused, the owner's Approve or Settings > Jobs the one way in.
describe("a job's setting is the owner's alone (PG-1196)", () => {
  test.each(["jobs.opsZaiUsage", "jobs.opsSweep"])(
    "a session's own settings set and reset of %s are refused",
    async (key) => {
      expect(await bash(`playground settings set ${key} '{"enabled":true}' --reason r`)).toContain(
        "no-extensions-write hook refuses",
      )
      expect(await bash(`playground settings reset ${key} --reason r`)).toContain(
        "no-extensions-write hook refuses",
      )
    },
  )

  // import-jobs writes a jobs.<name> for each job its file lists, on unless the file marks it disabled, so a session's run would turn a job on itself
  test.each([
    "playground settings import-jobs /tmp/jobs.json",
    "playground settings import-jobs /tmp/jobs.json --scope acme-test",
    "playground settings import-jobs /tmp/jobs.json --launch-agents /tmp/agents",
  ])("a session's own %s is refused, naming the guard decision", async (command) => {
    const refusal = await bash(command)
    expect(refusal).toContain("no-extensions-write hook refuses")
    expect(refusal).toContain("post a guard decision with playground ask new")
  })
})

describe("a refusal for a value the hook does not hold names it in readable text", () => {
  test.each([
    ["a variable", "rm -f $X/x", "rm on $X/x,"],
    ["a loop variable", 'for d in a b; do rm -f "$d/x"; done', 'rm on "$d/x",'],
    ["a variable inside a nested shell's script", 'bash -c "rm -f $X/x"', "rm on $…/x,"],
    [
      "a held variable after a command named by a variable from the environment",
      'D=/tmp/d; $EDITOR f; cp x "$D/y"',
      'cp on "$D/y",',
    ],
    [
      "git -c with a variable",
      'git -c core.pager="$P" log',
      'git -c core.pager="$P", a value built from',
    ],
    [
      "git -c attached, with a variable",
      'git -ccore.pager="$P" log',
      'git -ccore.pager="$P", a value built from',
    ],
  ])("%s", async (_, command, named) => {
    const reason = await bash(command, "/tmp")
    expect(reason).toContain(named)
    expect(reason).not.toContain("\u0000")
  })
})

describe("a held path runs past a quoted heredoc's body, which the shell expands nothing in (PG-1128)", () => {
  test.each([
    [
      "cp to a held path after a quoted heredoc whose body holds arithmetic",
      `D=/tmp/d; cat > /tmp/s.sh <<'EOF'\necho $((i + 1))\nEOF\ncp x "$D/y"`,
    ],
    [
      "cp to a held path after a quoted heredoc whose body holds a [[ -eq ]] test",
      `D=/tmp/d; cat > /tmp/s.sh <<'EOF'\n[[ $n -eq 1 ]] && echo one\nEOF\ncp x "$D/y"`,
    ],
    [
      "cp to a held path after a double-quoted heredoc whose body holds a subscript",
      `D=/tmp/d; cat > /tmp/s.sh <<"EOF"\necho \${a[i]}\nEOF\ncp x "$D/y"`,
    ],
    [
      "rm of a held path after a backslashed tab-stripped heredoc whose body holds arithmetic",
      `D=/tmp/d; cat > /tmp/s.sh <<-\\EOF\n\techo $((i))\n\tEOF\nrm -rf "$D"`,
    ],
    [
      "rm of a held path after a quoted heredoc to an interpreter whose body holds an indirection",
      `D=/tmp/d; python3 - <<'EOF'\nprint("\${!x} \${(P)y}")\nEOF\nrm -rf "$D"`,
    ],
    [
      "rm of a held path after two quoted heredocs on one line",
      `D=/tmp/d; cat <<'A' > /tmp/a <<'B'\n$((i))\nA\n\${a[i]}\nB\nrm -rf "$D"`,
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command, WORK)).toBeUndefined()
  })
})

describe("a held path past any other heredoc or a quote the scan cannot place is refused (PG-1128)", () => {
  test.each([
    [
      "cp after an unquoted heredoc whose body holds arithmetic",
      `D=/tmp/d; cat > /tmp/s.sh <<EOF\necho $((i + 1))\nEOF\ncp x "$D/y"`,
    ],
    [
      "cp after a quoted heredoc and an unquoted one whose body holds a subscript",
      `D=/tmp/d; cat <<'A' > /tmp/a <<B\nok\nA\n\${a[i]}\nB\ncp x "$D/y"`,
    ],
    [
      "cp after a quoted heredoc beside a single-quoted read operand with a subscript",
      `D=/tmp/d; cat > /tmp/f <<'EOF'\nok\nEOF\nread 'a[i]' < /tmp/f; cp x "$D/y"`,
    ],
    [
      "cp after a quoted heredoc beside a single-quoted printf -v operand with a subscript",
      `D=/tmp/d; cat > /tmp/f <<'EOF'\nok\nEOF\nprintf -v 'a[i]' x; cp x "$D/y"`,
    ],
    [
      "cp into the guarded folder after a quoted heredoc",
      `cat > /tmp/s.sh <<'EOF'\necho $((i))\nEOF\ncp x ${LIST}`,
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command, WORK)).toBeDefined()
  })
})

// #1616: the subscript scan read quoted text, so a selector or a jq filter in single quotes left no variable held on its line
describe("a single-quoted subscript no command reads as a name leaves the line's variables held", () => {
  test.each([
    [
      "cp to a held path beside an assignment's single-quoted value",
      `D=/tmp/d; ST='x[y]'; cp x "$D/y"`,
    ],
    [
      "tee to a held path beside an assignment's single-quoted value",
      `D=/tmp/d; ST='x[\\"'; echo x | tee "$D/a.log"`,
    ],
    ["cp to a held path beside a jq filter", `D=/tmp/d; jq '.a[b]' f; cp x "$D/y"`],
    [
      "cp to a held path beside a selector an echo prints",
      `D=/tmp/d; echo 'q("a[href]")'; cp x "$D/y"`,
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command, WORK)).toBeUndefined()
  })
})

describe("a single-quoted subscript a command reads as a name still holds no variable", () => {
  test.each([
    ["read", `D=/tmp/d; read 'a[i]' < /tmp/f; cp x "$D/y"`],
    ["printf -v", `D=/tmp/d; printf -v 'a[i]' x; cp x "$D/y"`],
    ["unset", `D=/tmp/d; unset 'a[i]'; cp x "$D/y"`],
    ["[[ -v", `D=/tmp/d; [[ -v 'a[i]' ]]; cp x "$D/y"`],
    ["declare", `D=/tmp/d; declare 'a[i]=1'; cp x "$D/y"`],
    ["declare -n", `D=/tmp/d; declare -n r='a[i]'; cp x "$D/y"`],
    ["getopts", `D=/tmp/d; getopts ab 'a[i]'; cp x "$D/y"`],
    ["mapfile", `D=/tmp/d; mapfile 'a[i]' < /tmp/f; cp x "$D/y"`],
    ["wait -p", `D=/tmp/d; wait -p 'a[i]'; cp x "$D/y"`],
    ["test -v", `D=/tmp/d; test -v 'a[i]'; cp x "$D/y"`],
    ["unset behind command", `D=/tmp/d; command unset 'a[i]'; cp x "$D/y"`],
    ["let", `D=/tmp/d; let 'a[i]'; cp x "$D/y"`],
    ["arithmetic", `D=/tmp/d; (( 'a[i]' )); cp x "$D/y"`],
    ["eval", `D=/tmp/d; eval 'a[i]=1'; cp x "$D/y"`],
    ["read of a held value", `D=/tmp/d; X='a[i]'; read "$X" < /tmp/f; cp x "$D/y"`],
    ["unset of a held value", `D=/tmp/d; X='a[i]'; unset "$X"; cp x "$D/y"`],
    ["printf -v of a held value", `D=/tmp/d; X='a[i]'; printf -v "$X" x; cp x "$D/y"`],
  ])("%s", async (_, command) => {
    expect(await bash(command, WORK)).toBeDefined()
  })
})

// An eval of literal text is followed as the line its words make, so it runs where those commands would; refused-forms/1198.ts holds the forms it refuses
describe("an eval of literal text runs", () => {
  test.each([
    ["an eval of one quoted line", "eval 'echo hi'"],
    ["an eval of literal words", "eval echo hi"],
    ["an eval of a chain", "eval 'cd /tmp && ls'"],
    ["an eval of a heredoc read by a substitution", "eval \"$(cat <<'EOF'\necho hi\nEOF\n)\""],
    ["an eval of plain words", "eval git status"],
    ["an eval of each plain character", "eval echo a-b.c/d=e,f:g@h%i"],
    ["an eval of a quoted glob operator", "eval 'ls ^x'"],
    ["an eval of an escaped glob operator", "eval echo \\^x"],
  ])("%s runs from the checkout and the home", async (_, command) => {
    for (const cwd of [CHECKOUT, HOME]) expect(await bash(command, cwd)).toBeUndefined()
  })
})

// The Ops lead sets a guard setting that only tunes a number: glm.readOnlyLoad5 to a positive limit, and a job's row changed in its schedule's interval alone, read against the row the login's scope stores, since a set replaces that row and the render reads every field it leaves out from the registry; every other change, and every other session, stays with the owner
describe("the Ops lead's tuning of a guard setting", () => {
  const home = mkdtempSync(join(tmpdir(), "no-extensions-write-tuning-"))
  const data = join(home, ".playground")
  const config = join(home, "config")
  // a call runs from a worktree, since from the home, which holds the data folder, a glob character in a word reads as a path into the extensions
  const work = join(home, "work")
  mkdirSync(work)
  mkdirSync(join(data, "extensions", "hooks"), { recursive: true })
  mkdirSync(join(config, "sessions"), { recursive: true })
  // each job as policy.json renders it, its stored row over the registry's entry
  const job = (fields: object) => ({
    callsModel: false,
    command: "bun run x",
    cwd: "{checkout}",
    description: "a job",
    enabled: false,
    runtime: "launchd",
    ...fields,
  })
  writeFileSync(
    join(data, "extensions", "policy.json"),
    JSON.stringify({
      values: {
        "jobs.opsAlways": job({ enabled: true, schedule: { always: true } }),
        "jobs.opsAwake": job({ enabled: true, schedule: { every: 300 } }),
        "jobs.opsOrg": job({ enabled: true, schedule: { every: 60 } }),
      },
    }),
  )
  // the rows each scope stores: the login's, one under jobs.opsDashboard's old name, and an org's that holds a row for a job; no scope stores jobs.opsUsage, so policy.json lacks it and the registry's entry is its row
  writeFileSync(join(data, "extensions", "login"), "me\n")
  for (const [scope, values] of [
    [
      "me",
      {
        "jobs.opsAlways": { enabled: true },
        "jobs.opsAwake": { enabled: true },
        "jobs.opsDesk": { enabled: true },
      },
    ],
    ["acme", { "jobs.opsOrg": { enabled: true } }],
  ] as const) {
    mkdirSync(join(data, "extensions", scope, ".git"), { recursive: true })
    writeFileSync(join(data, "extensions", scope, "settings.json"), JSON.stringify(values))
  }
  writeFileSync(
    join(data, "roster.json"),
    JSON.stringify({
      agents: [
        { kind: "ops", name: "ops", status: "working" },
        { kind: "builder", name: "builder", status: "working" },
        { kind: "worker", name: "abc-worker", status: "working" },
      ],
    }),
  )
  for (const [session, name] of [
    ["s-ops", "ops"],
    ["s-builder", "builder"],
    ["s-worker", "abc-worker"],
  ])
    writeFileSync(
      join(config, "sessions", `${session}.json`),
      JSON.stringify({ name, sessionId: session }),
    )
  afterAll(() => rmSync(home, { force: true, recursive: true }))

  const as = (session: string, role: string, command: string) =>
    check(
      JSON.stringify({
        cwd: work,
        hook_event_name: "PreToolUse",
        session_id: session,
        tool_input: { command },
        tool_name: "Bash",
      }),
      { CLAUDE_CONFIG_DIR: config, HOME: home, PLAYGROUND_ROLE: role },
    )
  const ops = (command: string) => as("s-ops", "lead", command)

  const TUNES = [
    ["glm.readOnlyLoad5 to a new limit", "playground settings set glm.readOnlyLoad5 20 --reason r"],
    [
      "a job's interval, its stored row otherwise as it stands",
      `playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "the interval of a registry job no scope stores a row for",
      `playground settings set jobs.opsUsage '{"schedule":{"every":600}}' --reason r`,
    ],
  ]

  test.each(TUNES)("the Ops lead sets %s", async (_, command) => {
    expect(await ops(command)).toBeUndefined()
  })

  test.each(TUNES)("the Builder lead and a worker are refused %s", async (_, command) => {
    for (const [session, role] of [
      ["s-builder", "lead"],
      ["s-worker", "worker"],
      ["s-unnamed", "lead"],
    ])
      expect(await as(session, role, command)).toContain(
        "no-extensions-write hook refuses playground settings",
      )
  })

  test.each([
    ["glm.readOnlyLoad5 to 0", "playground settings set glm.readOnlyLoad5 0 --reason r"],
    ["glm.readOnlyLoad5 to a word", "playground settings set glm.readOnlyLoad5 high --reason r"],
    [
      "glm.readOnlyLoad5 to a value it cannot read",
      'playground settings set glm.readOnlyLoad5 "$N" --reason r',
    ],
    [
      "glm.readOnlyLoad5 at a scope",
      "playground settings set glm.readOnlyLoad5 20 --scope acme --reason r",
    ],
    ["a reset of glm.readOnlyLoad5", "playground settings reset glm.readOnlyLoad5 --reason r"],
    [
      "a job turned off with its interval",
      `playground settings set jobs.opsAwake '{"enabled":false,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's row that drops a field",
      `playground settings set jobs.opsAwake '{"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's row that adds a command",
      `playground settings set jobs.opsAwake '{"command":"x","enabled":true,"schedule":{"every":300}}' --reason r`,
    ],
    [
      "a number in a job's config",
      `playground settings set jobs.opsAwake '{"config":{"timeout":5},"enabled":true,"schedule":{"every":300}}' --reason r`,
    ],
    [
      "a job's interval that is no positive integer",
      `playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":1.5}}' --reason r`,
    ],
    [
      "a job's whole rendered row with a new interval, which would pin the registry's fields",
      `playground settings set jobs.opsAwake '{"callsModel":false,"command":"bun run x","cwd":"{checkout}","description":"a job","enabled":true,"runtime":"launchd","schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job whose rendered schedule is no interval, moved to one",
      `playground settings set jobs.opsAlways '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job its login stores under an old name",
      `playground settings set jobs.opsDashboard '{"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job an org's scope stores a row for",
      `playground settings set jobs.opsOrg '{"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job policy.json holds no row for",
      `playground settings set jobs.opsNone '{"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's row at a scope",
      `playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --scope acme --reason r`,
    ],
    ["a reset of a job", "playground settings reset jobs.opsAwake --reason r"],
    ["import-jobs", "playground settings import-jobs /tmp/jobs.json --reason r"],
    [
      "live.branch, a key naming what a guard allows",
      "playground settings set live.branch x --reason r",
    ],
    ["owner.names", "playground settings set owner.names '[]' --reason r"],
    [
      "a tuning set chained with a refused one",
      "playground settings set glm.readOnlyLoad5 20 --reason r && playground settings set live.branch x --reason r",
    ],
    [
      "a job's interval with PLAYGROUND_LOGIN set before it, which moves the set to another scope",
      `PLAYGROUND_LOGIN=acme playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's interval after an export of PLAYGROUND_LOGIN",
      `export PLAYGROUND_LOGIN=acme; playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's interval under env with PLAYGROUND_LOGIN",
      `env PLAYGROUND_LOGIN=acme playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's interval with another data folder",
      `PLAYGROUND_DATA_DIR=/tmp/other playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's interval with another home",
      `HOME=/tmp/other playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's interval after a sourced file, which may export the login",
      `. ./login.sh; playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r`,
    ],
    [
      "a job's interval in a subshell",
      `(playground settings set jobs.opsAwake '{"enabled":true,"schedule":{"every":600}}' --reason r)`,
    ],
    [
      "glm.readOnlyLoad5 with PLAYGROUND_LOGIN set before it",
      `PLAYGROUND_LOGIN=acme playground settings set glm.readOnlyLoad5 20 --reason r`,
    ],
  ])("the Ops lead is refused %s", async (_, command) => {
    expect(await ops(command)).toContain("no-extensions-write hook refuses playground settings")
  })
})
