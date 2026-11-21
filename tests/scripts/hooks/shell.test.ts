import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type Env,
  GIT_TAKES,
  lex,
  parse,
  type Parsed,
  pastDeadline,
  places,
  run,
  runsScript,
  stdinShell,
  type StdinKind,
  UNKNOWN,
  withDeadline,
} from "../../../scripts/hooks/shell"
import { type Paths, REFUSED_FORMS } from "./fixtures/refused-forms"

const HOOKS = join(import.meta.dir, "..", "..", "..", "scripts", "hooks")

describe("git's value-taking options live in one list", () => {
  test("GIT_TAKES holds every option git 2.56 steps over before its subcommand", () => {
    expect([...GIT_TAKES].sort()).toEqual([
      "--attr-source",
      "--config-env",
      "--exec-path",
      "--git-dir",
      "--namespace",
      "--work-tree",
      "-C",
      "-c",
    ])
  })

  test("no hook keeps a copy of its own", () => {
    const copies = readdirSync(HOOKS)
      .filter((file) => file.endsWith(".ts") && file !== "shell.ts")
      .filter((file) => readFileSync(join(HOOKS, file), "utf8").includes('"--namespace"'))
    expect(copies).toEqual([])
  })
})

describe("each withDeadline call keeps its own deadline (PG-1690)", () => {
  // a check reads its verdict once its wait is over: past its own deadline, or in time
  const check = (budget: number, wait: Promise<unknown>) =>
    withDeadline(budget, async () => {
      await wait
      try {
        pastDeadline()
        return "in time"
      } catch {
        return "past"
      }
    })

  test("two overlapping checks in one Promise.all both keep their verdicts, and leave no deadline behind", async () => {
    const short = check(1, Bun.sleep(20))
    const long = check(60_000, short)
    expect(await Promise.all([short, long])).toEqual(["past", "in time"])
    expect(() => pastDeadline()).not.toThrow()
  })
})

describe("an alternate reading runs on its own copy of the env", () => {
  // sudo -Z is an option sudo's list lacks, so the call is read twice: x as the program, and x as -Z's value with the rest as the program
  const seen = async (line: string) => {
    const env: Env = { cwd: "/start", files: new Map(), known: {}, process: {}, vars: new Map() }
    let probe: Env | undefined
    await run(lex(line), env, async (_cmd, parsed, here) => {
      if (parsed.name === "probe") probe = here
      return undefined
    })
    return { cwd: probe?.cwd, vars: [...(probe?.vars.keys() ?? [])] }
  }

  test("a cd only an alternate reading runs leaves the next command's folder as it was", async () => {
    expect(await seen("sudo -Z x cd /; probe")).toEqual({ cwd: "/start", vars: [] })
  })

  test("an export only an alternate reading runs leaves the next command's variables as they were", async () => {
    expect(await seen("sudo -Z x export A=1; probe")).toEqual({ cwd: "/start", vars: [] })
  })

  test("the primary reading still moves the folder and sets the variables", async () => {
    expect(await seen("cd /; export A=1; probe")).toEqual({ cwd: "/", vars: ["A"] })
  })
})

// Env.cwd's own reading follows zsh's ~- through the one folder Env.old names, and the proven reading through the set Env.cwdBack holds, so the set must hold that folder or the two readings could disagree on where a `cd -` or `pushd ~-` goes back to.
// The fixture's paths as folders made under a mkdtemp root, so Env.cwd's reading lands in them; each line is read as text by the reader alone and never run.
const madePaths = (prefix: string): Paths => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const extensions = join(root, "data", "extensions")
  const paths: Paths = {
    BARE: join(root, "bare"),
    CLI_DIR: join(root, "cli"),
    DATA: join(root, "data"),
    FOREIGN_TREE: join(root, "foreign-tree"),
    FOREIGN_TREE_IN_MAIN: join(root, "main", ".claude", "worktrees", "foreign"),
    HOME: join(root, "home"),
    LINK: join(root, "home", "store"),
    LIST: join(extensions, "hooks", "list.json"),
    MAIN: join(root, "main"),
    ROOT: extensions,
    SCOPE: join(extensions, "login"),
    TREE_LINK: join(root, "main", ".claude", "worktrees", "a", "into-main"),
    WORDS: join(root, "home", "words"),
    WORK: join(root, "home", "work"),
  }
  for (const [key, dir] of Object.entries(paths))
    if (key !== "LIST") mkdirSync(dir, { recursive: true })
  mkdirSync(join(paths.MAIN, ".claude", "worktrees", "a"), { recursive: true })
  return paths
}

const fixtureLines = (paths: Paths) =>
  REFUSED_FORMS.flatMap(({ rows }) => rows(paths))
    .map(([, call]) => call)
    .filter((call): call is string => typeof call === "string")

describe("the folder Env.old names is always one Env.cwdBack holds", () => {
  const paths = madePaths("old-in-back-")

  const read = async (lines: string[]) => {
    let reads = 0
    const misses: string[] = []
    for (const line of lines) {
      const start = paths.WORK
      const env: Env = {
        cwd: start,
        cwdSure: start,
        files: new Map(),
        known: {},
        old: { dir: start },
        process: {},
        vars: new Map(),
      }
      await run(lex(line), env, async (_cmd, _parsed, here) => {
        const dir = here.old?.dir
        if (dir === undefined || here.cwdBack === undefined) return undefined
        reads++
        if (!here.cwdBack.includes(dir)) misses.push(`${line} :: ${dir}`)
        return undefined
      })
    }
    return { misses, reads }
  }

  test("after every cd, pushd and popd of the refused-forms rows", async () => {
    const lines = fixtureLines(paths).filter((call) => /\b(?:cd|pushd|popd)\b/.test(call))
    const { misses, reads } = await read(lines)
    expect(misses).toEqual([])
    expect(reads).toBeGreaterThan(50)
  })

  // a body's cd moves Env.cwd's reading but not the proven one, so a relative cd after it lands somewhere only Env.cwd's reading names, and the cd after that leaves it as the folder Env.old names
  test("after a relative cd that follows a function body's cd", async () => {
    const { misses, reads } = await read(["f() { cd /usr; }; cd lib; cd ..; touch x"])
    expect(misses).toEqual([])
    expect(reads).toBeGreaterThan(0)
  })
})

// The hooks that judge each folder places() names see what canary's hooks see only while that set holds the folder Env.cwd's own reading names, so a form whose folder only Env.cwd's reading reaches would run under them; past the cap the reader names no set and each hook refuses outright.
describe("places() holds the folder Env.cwd names, unless the reader passed its cap", () => {
  const paths = madePaths("places-hold-cwd-")
  const worktree = join(paths.MAIN, ".claude", "worktrees", "a")

  const read = async (lines: string[]) => {
    let reads = 0
    const misses: string[] = []
    for (const line of lines)
      for (const start of [worktree, paths.MAIN]) {
        const env: Env = {
          cwd: start,
          cwdSure: start,
          files: new Map(),
          known: {},
          old: { dir: start },
          process: {},
          vars: new Map(),
        }
        const visit: Parameters<typeof run>[2] = async (_cmd, _parsed, here) => {
          if (here.cwd === undefined || here.cwdAnywhere) return undefined
          reads++
          const folders = places(here, start).map((place) => place.cwd)
          if (!folders.includes(here.cwd)) misses.push(`${line} :: ${here.cwd}`)
          return undefined
        }
        try {
          await withDeadline(2_000, async () => run(lex(line), env, visit, true))
        } catch {
          // a line the reader throws on, or reads past its deadline, is one every hook refuses whole, so it holds no folder to compare
        }
      }
    return { misses, reads }
  }

  test("at every command of the refused-forms rows", async () => {
    const { misses, reads } = await read(fixtureLines(paths))
    expect(misses).toEqual([])
    expect(reads).toBeGreaterThan(500)
  }, 120_000)

  // a body's cd, then a cd or pushd relative to wherever it reached, from a worktree and from the main checkout
  test("at every command after a body's cd and a relative one", async () => {
    const lines: string[] = []
    for (const open of [
      "{ cd X; }",
      "f() { cd X; }; f",
      "f() { cd X; }",
      "coproc cd X",
      "{ cd X; cd ..; }",
    ])
      for (const to of ["..", "../..", paths.MAIN, `${paths.MAIN}/.claude`, "/tmp"])
        for (const tail of [
          "cd ..; P",
          "cd ..; cd ..; P",
          "pushd .. >/dev/null; P",
          "(cd ..; P)",
          "cd .. && P",
          "cd worktrees/a && P",
          "cd -; P",
          "pushd; P",
        ])
          lines.push(`${open.replace("X", to)}; ${tail.replaceAll("P", "git commit -m x")}`)
    const { misses, reads } = await read(lines)
    expect(misses).toEqual([])
    expect(reads).toBeGreaterThan(lines.length)
  })
})

describe("stdinShell reads a privilege wrapper's root shell", () => {
  test.each<[string, string, "root" | undefined]>([
    ["a program in a variable behind a quoted bare wrapper", `'sudo' "$X"`, "root"],
    ["a second wrapper's shell option behind a plain first wrapper", "doas sudo -i", "root"],
    ["a quoted shell option", "sudo '-s'", "root"],
    ["the shell long option given its command", "sudo --shell ls", undefined],
  ])("%s", (_, line, kind) => {
    expect(stdinShell(lex(line).commands[0])).toBe(kind)
  })
})

describe("stdinShell reads env's split string as the words it runs", () => {
  test.each<[string, string, StdinKind | undefined]>([
    ["sudo's shell in a split string", "env -S 'sudo -s'", "root"],
    ["sudo's shell in a long split-string option", "env --split-string='sudo -s'", "root"],
    ["a shell given no script in a split string", "env -S 'sh'", "shell"],
    ["a harmless command in a split string", "env -S 'sudo ls'", undefined],
    ["a quoted env's split string", "'env' -S 'sudo -s'", "root"],
    ["a second env's split string behind nice", "env nice env -S 'sudo -s'", "root"],
    ["an abbreviated split-string option", "env --split='sudo -s'", "root"],
    ["a split string after an abbreviated unset", "env nice env --u X -S 'sudo -s'", "root"],
    ["a split string after argv0's value", "env -a name -S 'sudo -s'", "root"],
    ["a split string after a lone dash, env's -i", "'env' - -S 'sudo -s'", "root"],
  ])("%s", (_, line, kind) => {
    expect(stdinShell(lex(line).commands[0])).toBe(kind)
  })
})

describe("stdinShell reads su with no command of its own as a root shell", () => {
  test.each<[string, string, StdinKind | undefined]>([
    ["su alone", "su", "root"],
    ["su with a user", "su root", "root"],
    ["su with its shell option", "su -s /bin/sh root", "root"],
    ["busybox's su applet with its shell option", "busybox su -s /bin/sh", "root"],
    ["su behind sudo", "sudo su", "root"],
    ["su given a command of its own", "su -c ls", undefined],
    ["su with a user given a command of its own", "su root -c 'ls -la'", undefined],
  ])("%s", (_, line, kind) => {
    expect(stdinShell(lex(line).commands[0])).toBe(kind)
  })
})

// The shell expands an unquoted heredoc's body as it reads it, so each command substitution and each backquoted command there runs; a quoted delimiter expands nothing, and a backslash keeps a dollar or a backquote literal
describe("an unquoted heredoc body's substitutions are lexed as the commands the shell runs (PG-1428)", () => {
  const programs = (line: string) =>
    lex(line).commands.map((c) => c.words.map((w) => w.value).join(" "))

  test.each<[string, string, string[]]>([
    [
      "a command substitution in an unquoted body",
      "true <<EOF\n$(probe a)\nEOF",
      ["probe a", "true"],
    ],
    ["a backquoted command in an unquoted body", "true <<EOF\n`probe a`\nEOF", ["probe a", "true"]],
    [
      "a command substitution in a tab-stripped body",
      "cat <<-EOF\n\t$(probe a)\n\tEOF",
      ["probe a", "cat"],
    ],
    [
      "a command substitution inside a parameter expansion's default",
      "true <<EOF\n${X:-$(probe a)}\nEOF",
      ["probe a", "true"],
    ],
    [
      "a command substitution after a lone quote, which a body keeps as text",
      "true <<EOF\nit's $(probe a)\nEOF",
      ["probe a", "true"],
    ],
    [
      "two substitutions on two lines",
      "true <<EOF\n$(probe a)\n`probe b`\nEOF",
      ["probe a", "probe b", "true"],
    ],
    [
      "a substitution in the second of two heredocs on one command",
      "cat <<A <<B\nfirst\nA\n$(probe a)\nB",
      ["probe a", "cat"],
    ],
    [
      "a substitution in a heredoc on a descriptor other than stdin",
      "cat 3<<EOF\n$(probe a)\nEOF",
      ["probe a", "cat"],
    ],
    [
      "a substitution in a heredoc feeding a loop",
      'while read l; do echo "$l"; done <<EOF\n$(probe a)\nEOF',
      ["while read l", `do echo ${UNKNOWN}`, "probe a", "done"],
    ],
    [
      "a command substitution past a quote inside a parameter expansion",
      "true <<EOF\nA ${X:-'$(probe a)'} B\nEOF",
      ["probe a", "true"],
    ],
    [
      "a command substitution on the line after a parameter expansion's quote",
      "true <<EOF\n${X:-'}\n$(probe a)\n'\nEOF",
      ["probe a", "true"],
    ],
    [
      "a command substitution inside an arithmetic expansion",
      "true <<EOF\n$(( $(probe a) + 1 ))\nEOF",
      ["probe a", "true"],
    ],
    ["a quoted delimiter's body", "true <<'EOF'\n$(probe a)\nEOF", ["true"]],
    ["a double-quoted delimiter's body", 'true <<"EOF"\n$(probe a)\nEOF', ["true"]],
    ["an escaped dollar in an unquoted body", "true <<EOF\n\\$(probe a)\nEOF", ["true"]],
    ["escaped backquotes in an unquoted body", "true <<EOF\n\\`probe a\\`\nEOF", ["true"]],
    [
      "a substitution in an unquoted body inside a command substitution, whose own value stays unread",
      "x=$(cat <<EOF\n$(probe a)\nEOF\n); true",
      ["probe a", "cat", `x=${UNKNOWN}`, "true"],
    ],
  ])("%s", (_, line, expected) => {
    expect(programs(line)).toEqual(expected)
  })

  // inside double quotes a quote is a plain character too, so the substitution past one in a parameter expansion runs (PG-1571), while an unquoted word's quote still quotes it
  test.each<[string, string, string[]]>([
    [
      "a double-quoted parameter expansion with a substitution past a quote",
      `echo "\${X:-'$(probe a)'}"`,
      ["probe a", `echo ${UNKNOWN}`],
    ],
    [
      "a double-quoted arithmetic expansion with a substitution",
      'echo "$(( $(probe a) + 1 ))"',
      ["probe a", `echo ${UNKNOWN}`],
    ],
    [
      "an unquoted parameter expansion's single-quoted default",
      "echo ${X:-'$(probe a)'}",
      [`echo ${UNKNOWN}`],
    ],
  ])("%s", (_, line, expected) => {
    expect(programs(line)).toEqual(expected)
  })

  test("the body's own value stays the text the shell reads it as, marked unread where it expands", () => {
    const [sub, cmd] = lex("true <<EOF\n$(probe a)\nEOF").commands
    expect(sub.words.map((w) => w.value)).toEqual(["probe", "a"])
    expect(cmd.redirects[0].body?.unknown).toBe("an expansion in an unquoted heredoc")
  })
})

// #2198: GNU xargs' input options: xargs fills its program from each item of the input -a names in place of stdin, split at a -d or -0 delimiter, and the reader reads the program as unread wherever it cannot read that input or decode that delimiter
describe("xargs fills its program from the input GNU's input options name", () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-xargs-input-"))
  afterAll(() => rmSync(dir, { force: true, recursive: true }))
  writeFileSync(join(dir, "f"), "turbo\n")
  writeFileSync(join(dir, "big"), "turbo ".repeat(200_000))
  writeFileSync(join(dir, "h"), "zz\n")
  mkdirSync(join(dir, "sub"))
  writeFileSync(join(dir, "sub", "h"), "turbo\n")
  const filled = async (line: string) => {
    const env: Env = { cwd: dir, files: new Map(), known: {}, process: {}, vars: new Map() }
    const seen: string[] = []
    await run(lex(line), env, async (_cmd, parsed) => {
      seen.push([parsed.name, ...parsed.args.map((a) => a.value)].join(" "))
      return undefined
    })
    return seen
  }

  test.each([
    ["an item -d's comma splits off", "printf 'a,turbo' | xargs -d, -I X nice X run"],
    ["an item -d's hex escape splits off", "printf 'a,turbo' | xargs -d '\\x2c' -I X nice X run"],
    ["an item -d's octal escape splits off", "printf 'a,turbo' | xargs -d '\\054' -I X nice X run"],
    ["an item -0 splits off", "printf 'a\\0turbo' | xargs -0 -I X nice X run"],
    ["a line of -a's file", "echo a | xargs -a f -I X nice X run"],
    ["a line of -a's process substitution", "echo a | xargs -a <(echo turbo) -I X nice X run"],
    ["a line of -a's file in env -C's folder", "echo a | env -C sub xargs -a h -I X nice X run"],
    [
      "a line of -a's file in env --chdir='s folder",
      "echo a | env --chdir=sub xargs -a h -I X nice X run",
    ],
  ])("%s fills the program", async (_, line) => {
    expect(await filled(line)).toContain("turbo run")
  })

  test.each([
    ["a -d escape the reader cannot decode", "printf 'a,turbo' | xargs -d '\\q' -I X nice X run"],
    ["a -d delimiter in a variable", "printf 'a,turbo' | xargs -d \"$D\" -I X nice X run"],
    ["a -d of more than one character", "printf 'a,turbo' | xargs -d ab -I X nice X run"],
    ["an -a file that does not exist", "echo a | xargs -a missing -I X nice X run"],
    ["an -a folder", "echo a | xargs -a . -I X nice X run"],
    ["an -a descriptor other than stdin", "echo a | xargs -a /dev/fd/3 -I X nice X run"],
    ["an -a file over the reader's size cap", "echo a | xargs -a big -I X nice X run"],
    ["an -a file in a variable", 'echo a | xargs -a "$F" -I X nice X run'],
    [
      "an -a relative file sudo -D may read from its folder",
      "echo a | sudo -D sub xargs -a h -I X nice X run",
    ],
    [
      "an -a relative file sudo --chdir= may read from its folder",
      "echo a | sudo --chdir=sub xargs -a h -I X nice X run",
    ],
    [
      "an -a absolute file after sudo -D",
      `echo a | sudo -D sub xargs -a ${dir}/sub/h -I X nice X run`,
    ],
    [
      "an -a absolute file sudo -R reads under its root",
      `echo a | sudo -R sub xargs -a ${dir}/h -I X nice X run`,
    ],
    [
      "an -a absolute file sudo --chroot= reads under its root",
      `echo a | sudo --chroot=sub xargs -a ${dir}/h -I X nice X run`,
    ],
  ])("%s reads the program as unread", async (_, line) => {
    expect(await filled(line)).toContain(`${UNKNOWN} run`)
  })
})

// #2292: a paren where a wrapper's program word goes keeps its subshell reading in the command list, and its opener carries zsh's glob reading beside it
describe("a wrapper's group word keeps the command list and carries the glob reading on its opener", () => {
  const read = (line: string) => {
    const { commands } = lex(line)
    return {
      commands: commands.map((c) => c.words.map((w) => w.value)),
      glob: commands.flatMap((c) => (c.glob ? [c.glob.words.map((w) => w.value)] : [])),
    }
  }
  test.each([
    ["nice (r|x)m a", [["nice"], ["r"], ["x"], ["m", "a"]], [["nice", "(r|x)m", "a"]]],
    [
      "nice (r|x)(m|y) a",
      [["nice"], ["r"], ["x"], [], ["m"], ["y"], ["a"]],
      [["nice", "(r|x)(m|y)", "a"]],
    ],
    ["nice (bun test | tail)", [["nice"], ["bun", "test"], ["tail"], []], []],
    ['nice (a|")") ; ls x', [["nice"], ["a"], [")"], [], ["ls", "x"]], [["nice", '(a|")")']]],
  ])("%s", (line, commands, glob) => {
    expect(read(line)).toEqual({ commands, glob })
  })
})

// #2397: a package runner's program is one more reading beside the runner's own, marked with the runner it runs through
describe("a package runner's program reads beside the runner", () => {
  const readings = (p: Parsed): Parsed[] => [p, ...p.also.flatMap(readings)]
  const via = (line: string) =>
    readings(parse(lex(line).commands[0]))
      .filter((r) => r.via)
      .map((r) => [r.via, r.name, r.args.map((a) => a.value).join(" ")])
  test.each([
    ["npx -y inscope@0.18.0 check", [["npx", "inscope", "check"]]],
    ["npx --call='tsc -v'", [["npx", "sh", "-c tsc -v"]]],
    ["pnpm --filter app exec -c tsc -v", [["pnpm exec", "sh", "-c tsc -v"]]],
    ["pnpm tsc -v", [["pnpm", "tsc", "-v"]]],
    [
      "corepack pnpm@9 exec tsc",
      [
        ["corepack", "pnpm", "exec tsc"],
        ["pnpm exec", "tsc", ""],
      ],
    ],
    ["deno run -A npm:portless@0.15.11 get", [["deno run", "portless", "get"]]],
    ["mise x node@20 -- tsc -v", [["mise x", "tsc", "-v"]]],
    ["yarn exec tsc --noEmit", [["yarn exec", "sh", "-c tsc --noEmit"]]],
    ["bun --silent exec 'tsc -v'", [["bun exec", "sh", "-c tsc -v"]]],
    ["deno -A npm:portless get", [["deno", "portless", "get"]]],
    ["deno x npm:portless get", [["deno x", "portless", "get"]]],
    ["pnpm -r exec -yc tsc -v", [["pnpm exec", "sh", "-c tsc -v"]]],
    ["pnpm exec --shell-mode=false tsc -v", [["pnpm exec", "sh", "-c tsc -v"]]],
    ["pnpm exec -r tsc -v", [["pnpm exec", "tsc", "-v"]]],
    ["yarn workspace app exec tsc", [["yarn exec", "sh", "-c tsc"]]],
    ["yarn workspaces foreach -A -j 2 exec tsc", [["yarn exec", "sh", "-c tsc"]]],
    ["yarn workspace app build", []],
    ["deno -A main.ts", []],
    ["pnpm rm lodash", []],
    ["bun run scripts/x.ts", []],
    ["deno run -A main.ts", []],
    ["npx", []],
  ])("%s", (line, want) => {
    expect(via(line)).toEqual(want)
  })

  test("bun run's name reads as no program where the nearest package.json above names its script", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-script-"))
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { del: "echo del" } }))
    const reading = (line: string) =>
      readings(parse(lex(line).commands[0])).find((r) => r.via) as Parsed
    const at = (cwd: string): Env => ({
      cwd,
      files: new Map(),
      known: {},
      process: {},
      vars: new Map(),
    })
    expect(runsScript(reading("bun run del"), at(join(root, "sub")))).toBe(true)
    expect(runsScript(reading("pnpm del"), at(root))).toBe(true)
    expect(runsScript(reading("bun run rmx"), at(root))).toBe(false)
    expect(runsScript(reading("bun run del"), { ...at(root), cwdUnread: true })).toBe(false)
  })
})
