import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

// Every skill's frontmatter holds the properties the repo relies on: a name matching its folder, a description, the clause sending what it learns to the dispatcher, disallowed-tools only in a fork (ADR 0002) and naming no tool it blocks, and setup user-invoked only.

const ROOT = join(import.meta.dir, "..")

// Skills copied whole from upstream, held to its text by tests/extensions/core/skills/<name>/drift.test.ts.
const COPIED = new Set(["pr"])

// gh 2.102 command groups and aliases that can write; search, status, browse, attestation, licenses and completion are read-only and stay open.
const GH_WRITE_GROUPS = [
  "pr",
  "issue",
  "workflow",
  "run",
  "repo",
  "release",
  "label",
  "secret",
  "variable",
  "gist",
  "project",
  "ruleset",
  "cache",
  "codespace",
  "org",
  "auth",
  "config",
  "extension",
  "alias",
  "ssh-key",
  "gpg-key",
  "api",
  "co",
  "discussion",
  "agent-task",
  "skill",
  "copilot",
  "preview",
]
const GIT_WRITE = [
  "push",
  "commit",
  "-C",
  "-c",
  "--no-pager",
  "--git-dir",
  "--work-tree",
  "format-patch",
  "checkout",
  "switch",
  "reset",
  "restore",
  "stash",
  "merge",
  "rebase",
  "pull",
  "clean",
  "rm",
  "mv",
  "add",
  "tag",
  "worktree",
  "branch",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "bisect",
  "config",
  "remote",
  "notes",
  "update-ref",
  "submodule",
  "clone",
  "init",
  "fetch",
  "gc",
  "prune",
  "filter-branch",
  "replace",
  "symbolic-ref",
]

// A read-only skill's blocklist: every write a fork must not make, the planted sentences' list.
const WRITE_BLOCKLIST = [
  ...new Set([
    "Write",
    "Edit",
    "NotebookEdit",
    "Agent",
    "mcp__linear-shared__save_*",
    "mcp__linear-shared__create_*",
    "mcp__linear-shared__delete_*",
    "mcp__github-shared__create_*",
    "mcp__github-shared__merge_*",
    "mcp__slack-shared__chat_*",
    "Bash(git push:*)",
    "Bash(git -C:*)",
    "Bash(gh pr:*)",
    "Bash(gh issue:*)",
    "Bash(gh api:*)",
    "Bash(gh workflow:*)",
    "Bash(git checkout:*)",
    "Bash(git reset:*)",
    "Skill",
    "mcp__claude_ai_Claude_Docs",
    "mcp__notion",
    "mcp__datadog",
    "mcp__langsmith",
    ...GH_WRITE_GROUPS.map((g) => `Bash(gh ${g}:*)`),
    ...GIT_WRITE.map((c) => `Bash(git ${c}:*)`),
    // a prefix rule does not match the `--opt=value` spelling, so it needs its own rule
    "Bash(git --git-dir=*)",
    "Bash(git --work-tree=*)",
  ]),
].sort()

// Python's fnmatch.fnmatchcase: a glob over the whole string, `*` crossing any character, `/` and spaces included.
const fnmatch = (name: string, pattern: string): boolean => {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? ""
    if (c === "*") source += "[\\s\\S]*"
    else if (c === "?") source += "[\\s\\S]"
    else if (c === "[") {
      let j = i + 1
      if (pattern[j] === "!") j++
      if (pattern[j] === "]") j++
      while (j < pattern.length && pattern[j] !== "]") j++
      if (j >= pattern.length) {
        source += "\\["
        continue
      }
      let set = pattern
        .slice(i + 1, j)
        .replaceAll("\\", "\\\\")
        .replaceAll("]", "\\]")
      if (set.startsWith("!")) set = `^${set.slice(1)}`
      else if (set.startsWith("^")) set = `\\${set}`
      source += `[${set}]`
      i = j
    } else source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  }
  return new RegExp(`^(?:${source})$`).test(name)
}

// Whether a disallowed-tools Bash rule refuses a single command: a `:*` rule by its prefix as a whole word, any other rule as a glob over the whole command.
const bashBlocked = (command: string, entries: string[]): boolean =>
  entries.some((entry) => {
    const rule = /^Bash\((.*)\)$/.exec(entry)?.[1]
    if (rule === undefined) return false
    if (!rule.endsWith(":*")) return fnmatch(command, rule)
    const prefix = rule.slice(0, -2)
    return command === prefix || command.startsWith(`${prefix} `)
  })

// Whether a disallowed-tools entry covers a tool: exact, a glob, or a whole MCP server.
const blocks = (entry: string, tool: string): boolean =>
  entry === tool || (/[*?[]/.test(entry) && fnmatch(tool, entry)) || tool.startsWith(`${entry}__`)

const PUNCTUATION = "();<>|&"
const SHELL_OPS = new Set(["&&", "||", ";", "|", "&", "|&", "(", ")", ";;"])

// Python's shlex.shlex(posix=True, punctuation_chars=True) with whitespace_split and no commenters: a run of punctuation is one token and quotes stay in their word; null where shlex raises (an unclosed quote, a trailing backslash).
const shellTokens = (command: string): string[] | null => {
  const tokens: string[] = []
  let token = ""
  let quoted = false
  let state: " " | "a" | "c" | "'" | '"' = " "
  const emit = () => {
    if (token || quoted) tokens.push(token)
    token = ""
    quoted = false
    state = " "
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ""
    if (state === "'") {
      if (c === "'") state = "a"
      else token += c
    } else if (state === '"') {
      if (c === '"') state = "a"
      else if (c === "\\") {
        const next = command[++i]
        if (next === undefined) return null
        token += next === '"' || next === "\\" ? next : `\\${next}`
      } else token += c
    } else if (" \t\r\n".includes(c)) {
      if (state !== " ") emit()
    } else if (state === "c") {
      if (PUNCTUATION.includes(c)) token += c
      else {
        emit()
        i--
      }
    } else if (PUNCTUATION.includes(c)) {
      if (state === "a") {
        emit()
        i--
      } else {
        token = c
        state = "c"
      }
    } else if (c === "'" || c === '"') {
      state = c
      quoted = true
    } else if (c === "\\") {
      const next = command[++i]
      if (next === undefined) return null
      token += next
      state = "a"
    } else {
      token += c
      state = "a"
    }
  }
  if (state === "'" || state === '"') return null
  if (state !== " ") emit()
  return tokens
}

// A command's parts between shell operators, read the way a shell would: a `|` or `;` inside quotes (a grep alternation, a sed script) stays in its word, and text a shell cannot read (an unclosed quote) is one part, as written.
const commandParts = (command: string): string[] => {
  const tokens = shellTokens(command)
  if (tokens === null) return command.trim() ? [command.trim()] : []
  const parts: string[] = []
  let current: string[] = []
  for (const token of tokens) {
    if (SHELL_OPS.has(token)) {
      parts.push(current.join(" "))
      current = []
    } else current.push(token)
  }
  parts.push(current.join(" "))
  return parts.filter(Boolean)
}

const WARNED = /^[^.;()]*?\b(?:is|are) blocked/

// The commands and tools a skill's body names, as code spans, lines of a fenced shell block, or a built-in tool by name ("the Skill tool"), that its own disallowed-tools blocks; one the same clause calls blocked ("`gh pr` is blocked here") is a warning, not an instruction, and is left out.
const blockedMentions = (body: string, entries: string[]): [string, string][] => {
  const names: [string, string][] = [...body.matchAll(/`([^`\n]+)`/g)].map((m) => {
    const end = m.index + m[0].length
    return [(m[1] ?? "").trim(), body.slice(end, end + 60)]
  })
  for (const block of body.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? "").split("\n")) if (line.trim()) names.push([line.trim(), ""])
  }
  const hits: [string, string][] = []
  for (const entry of entries) {
    if (!/^[A-Z]\w+$/.test(entry)) continue
    for (const m of body.matchAll(new RegExp(`(?:\`${entry}\`|\\b${entry} tool\\b)`, "g"))) {
      const end = m.index + m[0].length
      if (!WARNED.test(body.slice(end, end + 60))) hits.push([m[0], entry])
    }
  }
  // A compound command is refused whole when any part is blocked, so each part is judged on its own.
  const parts = names.flatMap(([name, after]) =>
    commandParts(name).map((part): [string, string] => [part, after]),
  )
  for (const [name, after] of parts) {
    if (WARNED.test(after)) continue
    for (const entry of entries) {
      if (entry.startsWith("Bash(")) {
        if (bashBlocked(name, [entry])) hits.push([name, entry])
      } else if (name.startsWith("mcp__")) {
        if (blocks(entry, name)) hits.push([name, entry])
      } else {
        const tool = /^mcp__[\w-]+?__(\w[\w*?]*)$/.exec(entry)?.[1]
        if (tool && /^[a-z][a-z_]+$/.test(name) && fnmatch(name, tool)) hits.push([name, entry])
      }
    }
  }
  return hits
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/

// Each failed check under root as `<check> (<detail>)`, the frontmatter parsed as real YAML, as Claude Code parses it; core's upstream skills, held byte for byte to each extensions/core/upstream/<name>/MANIFEST, are left out, since their frontmatter is upstream's.
const frontmatterFailures = (root: string): string[] => {
  const fails: string[] = []
  const check = (ok: boolean, name: string, detail = "") => {
    if (!ok) fails.push(detail ? `${name} (${detail})` : name)
  }
  const upstream = new Set(
    [...new Bun.Glob("extensions/core/upstream/*/MANIFEST").scanSync({ cwd: root })]
      .flatMap((manifest) => readFileSync(join(root, manifest), "utf8").split("\n"))
      .filter((line) => line.endsWith("/SKILL.md"))
      .map((line) => line.slice(line.indexOf(" ") + 1).split("/")[1]),
  )
  const scan = (pattern: string) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: root, followSymlinks: true }),
  ]
  const skills = [
    ...scan("skills/playground/*/SKILL.md"),
    ...scan("extensions/core/skills/*/SKILL.md").filter(
      (path) => !upstream.has(basename(dirname(path))),
    ),
  ].sort()
  check(skills.length > 0, "skills found", "no SKILL.md under skills/playground/<name>/")
  const byName = new Map<string, Record<string, unknown>>()
  for (const path of skills) {
    const folder = basename(dirname(path))
    const text = readFileSync(join(root, path), "utf8")
    const block = FRONTMATTER.exec(text)?.[1]
    check(block !== undefined, `${folder}: has frontmatter`)
    if (block === undefined) continue
    let parsed: unknown
    try {
      parsed = Bun.YAML.parse(block)
    } catch (error) {
      check(false, `${folder}: frontmatter is valid YAML`, (error as Error).message.split("\n")[0])
      continue
    }
    const fm: Record<string, unknown> =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    byName.set(folder, fm)
    check(
      fm.name === folder,
      `${folder}: name matches its folder`,
      `name=${JSON.stringify(fm.name)}`,
    )
    check(
      COPIED.has(folder) ||
        (text.includes("## Keep the skills learning") &&
          text.includes("`SendMessage` to `dispatcher`")),
      `${folder}: sends what it learns to the dispatcher session`,
    )
    check(Boolean(fm.description), `${folder}: has a description`)
    if ("disallowed-tools" in fm) {
      check(
        fm.context === "fork" && fm.background === false,
        `${folder}: disallowed-tools only in a fork (context: fork, background: false)`,
        `context=${JSON.stringify(fm.context)} background must be the YAML boolean false`,
      )
      const entries = [fm["disallowed-tools"]]
        .flat()
        .filter((entry): entry is string => typeof entry === "string")
      const close = text.indexOf("\n---\n")
      const hits = blockedMentions(close < 0 ? text : text.slice(close + 5), entries)
      check(
        hits.length === 0,
        `${folder}: names no tool its own disallowed-tools blocks`,
        JSON.stringify(hits),
      )
    }
  }
  const setup = byName.get("setup")
  check(
    setup !== undefined && String(setup["disable-model-invocation"]).toLowerCase() === "true",
    "setup is user-invoked only (it installs software)",
    String(setup?.["disable-model-invocation"]),
  )
  return fails
}

describe("skill frontmatter", () => {
  test("every skill's frontmatter holds what the repo relies on", () => {
    expect(frontmatterFailures(ROOT)).toEqual([])
  })

  test("the blocked-tool check catches an instruction, a blocked part of a compound command, and passes over a warning", () => {
    const planted: [string, boolean][] = [
      ["Read `gh api repos/o/r/pulls/1` for its reviewers.", true],
      ["Then `save_issue`.", true],
      ["```bash\ngit -C repo push\n```", true],
      ["Call the Skill tool with claim.", true],
      ["Write it with `Edit`.", true],
      ["`gh pr` is blocked here, so use `gh search prs --owner o`.", false],
      ["The Skill tool is blocked here.", false],
      // a compound read a headless scan sent on 6 Oct 2026, refused whole for its `git branch` part
      [
        "`cd repo && git log -1 origin/develop && git branch --show-current && grep -rn parking src`",
        true,
      ],
      ["```bash\ncd repo && git rev-parse --abbrev-ref HEAD | head -1; git push\n```", true],
      [
        "`git rev-parse --abbrev-ref HEAD`, then `git log -1 --format='%h %cd' origin/develop`",
        false,
      ],
      // quoted operators stay in their word; a background & still splits
      ["`grep -E 'x|git push origin' log`", false],
      ["`date '+%a' | sed 's/AM/am/;s/PM/pm/'`", false],
      ["`sleep 1 & git branch -a`", true],
    ]
    expect(planted.map(([text]) => blockedMentions(text, WRITE_BLOCKLIST).length > 0)).toEqual(
      planted.map(([, caught]) => caught),
    )
  })

  describe("a tree of bad frontmatter fails each check", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-frontmatter-"))
    afterAll(() => rmSync(root, { force: true, recursive: true }))
    const LEARNS = "\n## Keep the skills learning\n\nTell it with `SendMessage` to `dispatcher`.\n"
    const skill = (name: string, text: string) => {
      mkdirSync(join(root, "extensions/core/skills", name), { recursive: true })
      writeFileSync(join(root, "extensions/core/skills", name, "SKILL.md"), text)
    }
    mkdirSync(join(root, "extensions/core/upstream/vendor"), { recursive: true })
    writeFileSync(
      join(root, "extensions/core/upstream/vendor/MANIFEST"),
      "0000000000000000000000000000000000000000 skills/vendored/SKILL.md\n",
    )
    skill("good", `---\nname: good\ndescription: "Fine."\n---\n${LEARNS}`)
    skill("vendored", "---\nname: vendored\ndescription: Use when: x\n---\n")
    skill("bad-yaml", `---\nname: bad-yaml\ndescription: Use when: x\n---\n${LEARNS}`)
    skill("bare", `# bare\n${LEARNS}`)
    skill("misnamed", `---\nname: other\ndescription: Fine.\n---\n${LEARNS}`)
    skill("blank", `---\nname: blank\ndescription: ""\n---\n${LEARNS}`)
    skill("quiet", "---\nname: quiet\ndescription: Fine.\n---\nNo clause.\n")
    skill(
      "loose",
      `---\nname: loose\ndescription: Fine.\ndisallowed-tools:\n  - Write\n---\n${LEARNS}`,
    )
    skill(
      "strict",
      `---\nname: strict\ndescription: Fine.\ncontext: fork\nbackground: "false"\ndisallowed-tools:\n  - Write\n---\n${LEARNS}`,
    )
    skill(
      "blocked",
      `---\nname: blocked\ndescription: Fine.\ncontext: fork\nbackground: false\ndisallowed-tools:\n  - Write\n  - Bash(git push:*)\n---\nSave it with \`Write\`, then \`git push\`.\n${LEARNS}`,
    )
    skill("setup", `---\nname: setup\ndescription: Fine.\n---\n${LEARNS}`)

    test("each bad skill fails its own check, and the good and upstream ones pass", () => {
      expect(frontmatterFailures(root)).toEqual([
        expect.stringMatching(/^bad-yaml: frontmatter is valid YAML \(.+\)$/),
        "bare: has frontmatter",
        "blank: has a description",
        'blocked: names no tool its own disallowed-tools blocks ([["`Write`","Write"],["git push","Bash(git push:*)"]])',
        "loose: disallowed-tools only in a fork (context: fork, background: false) (context=undefined background must be the YAML boolean false)",
        'misnamed: name matches its folder (name="other")',
        "quiet: sends what it learns to the dispatcher session",
        'strict: disallowed-tools only in a fork (context: fork, background: false) (context="fork" background must be the YAML boolean false)',
        "setup is user-invoked only (it installs software) (undefined)",
      ])
    })
  })
})
