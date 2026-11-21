import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  parseWords,
  runStore,
  terminalIo,
  type Io,
} from "../../../../../packages/scripts/src/playground/store"
import { mustGit, writeFiles } from "../../../../../packages/settings/src/folder"
import { GUARD_LISTS, scopeDir } from "../../../../../packages/settings/src/rendered"

const scratch = mkdtempSync(join(tmpdir(), "playground-store-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

describe("parseWords", () => {
  test("positional words, options with their values, a repeated option in order and a bare flag", () => {
    expect(
      parseWords(
        ["doc", "owner", "a", "--attach", "x.png", "--attach", "y.png", "--dry-run"],
        ["--dry-run"],
      ),
    ).toEqual({
      options: { "--attach": ["x.png", "y.png"], "--dry-run": [""] },
      positional: ["doc", "owner", "a"],
    })
  })
})

describe("playground ext", () => {
  const folder = (name: string) => {
    const at = join(scratch, name)
    mkdirSync(join(at, "extensions"), { recursive: true })
    writeFileSync(join(at, "extensions", "login"), "tester\n")
    return at
  }
  const ext = async (at: string, words: string[], stdin = "", role?: string, name?: string) => {
    const out: string[] = []
    const err: string[] = []
    const io: Io = {
      data: at,
      name,
      out: (l) => out.push(l),
      role,
      stdin: async () => stdin,
      write: Bun.write,
    }
    const code = await runStore("ext", words, io, (l) => err.push(l))
    return { code, err: err.join("\n"), out: out.join("\n") }
  }
  const git = (at: string, scope: string, args: string[]) => mustGit(scopeDir(at, scope), args)

  test.skipIf(!Bun.which("chflags"))(
    "lock sets the extensions root's file lock and unlock clears it",
    async () => {
      const at = folder("lock")
      const root = join(at, "extensions")
      const flags = () => Bun.spawnSync(["stat", "-f", "%Sf", root]).stdout.toString().trim()
      expect(await ext(at, ["lock"])).toEqual({ code: 0, err: "", out: `locked ${root}` })
      expect(flags()).toBe("uchg")
      expect(await ext(at, ["unlock"])).toEqual({ code: 0, err: "", out: `unlocked ${root}` })
      expect(flags()).toBe("-")
    },
  )

  test("put writes a rule's body as a proposal and each attachment by its hash, one commit with the reason, which a 5 accepts", async () => {
    const at = folder("put")
    writeFileSync(join(scratch, "rule.md"), "Keep it short.\n")
    writeFileSync(join(scratch, "shot.png"), Buffer.from([1, 2, 3]))
    const put = await ext(at, [
      "put",
      "tester",
      "rule",
      "short",
      join(scratch, "rule.md"),
      "--reason",
      "shorter replies",
      "--attach",
      join(scratch, "shot.png"),
    ])
    expect(put.code).toBe(0)
    const { rev, state } = JSON.parse(put.out) as { rev: string; state: string }
    expect(state).toBe("proposed")
    const hash = new Bun.CryptoHasher("sha256").update(Buffer.from([1, 2, 3])).digest("hex")
    expect(git(at, "tester", ["ls-files"]).split("\n")).toEqual([
      `attachments/${hash}.png`,
      "proposed/rules/short.md",
    ])
    expect(git(at, "tester", ["log", "-1", "--format=%an|%s"])).toBe("owner|shorter replies")
    const stale = await ext(at, [
      "score",
      "tester",
      "rule",
      "short",
      "0000000",
      "5",
      "--reason",
      "r",
    ])
    expect(stale).toMatchObject({ code: 1 })
    expect(stale.err).toContain("409 the proposal is at")
    const scored = await ext(
      at,
      ["score", "tester", "rule", "short", rev, "5", "--reason", "clear"],
      "",
      "reviewer",
      "rev-x",
    )
    expect(scored.out).toBe(`rev ${git(at, "tester", ["rev-parse", "HEAD"])} is accepted`)
    expect(
      git(at, "tester", ["log", "-1", "--format=%an|%(trailers:key=Reviewer,valueonly)"]),
    ).toBe("rev-x|rev-x")
    expect(readFileSync(join(scopeDir(at, "tester"), "rules/short.md"), "utf8")).toBe(
      "Keep it short.\n",
    )
    const why = JSON.parse((await ext(at, ["why", "tester", "rule", "short"])).out) as {
      reason: string
    }[]
    expect(why.map((entry) => entry.reason)).toEqual(["clear", "shorter replies"])
  })

  test("why keeps a score below 5 with its reason between the revision it scored and the next one, and a 5 that accepts, and lists no other item's commit", async () => {
    const at = folder("why-rounds")
    const put = async (key: string, text: string, reason: string) => {
      writeFileSync(join(scratch, `${key}.md`), text)
      const out = await ext(
        at,
        ["put", "tester", "rule", key, join(scratch, `${key}.md`), "--reason", reason],
        "",
        "worker",
        "a-worker",
      )
      return (JSON.parse(out.out) as { rev: string }).rev
    }
    const score = (key: string, rev: string, n: string, reason: string) =>
      ext(
        at,
        ["score", "tester", "rule", key, rev, n, "--reason", reason],
        "",
        "reviewer",
        "b-reviewer",
      )
    const why = async (key: string) =>
      (
        JSON.parse((await ext(at, ["why", "tester", "rule", key])).out) as {
          reason: string
          trailers: [string, string][]
        }[]
      ).map((entry) => [entry.reason, Object.fromEntries(entry.trailers).Score ?? "-"])
    const first = await put("rounds", "Name the rounds.\n", "first draft")
    expect((await score("rounds", first, "4", "round 1: name each case")).out).toContain(
      "is proposed",
    )
    const other = await put("other", "Another rule.\n", "other draft")
    expect((await score("other", other, "3", "other round 1")).out).toContain("is proposed")
    const second = await put("rounds", "Name each round and its case.\n", "second draft")
    expect((await score("rounds", second, "5", "round 2: clear")).out).toContain("is accepted")
    expect(await why("rounds")).toEqual([
      ["round 2: clear", "5"],
      ["second draft", "-"],
      ["round 1: name each case", "4"],
      ["first draft", "-"],
    ])
    expect(await why("other")).toEqual([
      ["other round 1", "3"],
      ["other draft", "-"],
    ])
  })

  test("a write's author is the calling session, its role when no name is known and the owner with no role, and --by is refused", async () => {
    const at = folder("author")
    writeFileSync(join(scratch, "author.md"), "Name the caller.\n")
    const put = (key: string, role?: string, name?: string) =>
      ext(
        at,
        ["put", "tester", "rule", key, join(scratch, "author.md"), "--reason", "r"],
        "",
        role,
        name,
      )
    const author = () => git(at, "tester", ["log", "-1", "--format=%an"])
    expect((await put("named", "worker", "a-worker")).code).toBe(0)
    expect(author()).toBe("a-worker")
    expect((await put("unnamed", "worker")).code).toBe(0)
    expect(author()).toBe("worker")
    expect((await put("mine")).code).toBe(0)
    expect(author()).toBe("owner")
    const { rev } = JSON.parse((await put("by", "worker", "a-worker")).out) as { rev: string }
    for (const role of ["reviewer", undefined]) {
      const by = await ext(
        at,
        ["score", "tester", "rule", "by", rev, "3", "--reason", "r", "--by", "someone-else"],
        "",
        role,
        "b-reviewer",
      )
      expect(by.code).toBe(2)
      expect(by.err).toContain("--by is gone: a write's author is the calling session")
    }
    expect(author()).toBe("a-worker")
  })

  test("a score by the proposal's own author, named, unnamed or the owner, is refused, and another session's score records, its 5 accepting", async () => {
    const at = folder("self-score")
    writeFileSync(join(scratch, "self.md"), "Review another's work.\n")
    const put = await ext(
      at,
      ["put", "tester", "rule", "self", join(scratch, "self.md"), "--reason", "r"],
      "",
      "worker",
      "a-worker",
    )
    const { rev } = JSON.parse(put.out) as { rev: string }
    const score = (n: string, role?: string, name?: string) =>
      ext(at, ["score", "tester", "rule", "self", rev, n, "--reason", "r"], "", role, name)
    const own = await score("5", "worker", "a-worker")
    expect(own.code).toBe(1)
    expect(own.err).toContain("a-worker wrote this proposal, so another session scores it")
    expect(existsSync(join(scopeDir(at, "tester"), "rules/self.md"))).toBe(false)
    const low = await score("3", "reviewer", "b-reviewer")
    expect(low.out).toBe(`rev ${git(at, "tester", ["rev-parse", "HEAD"])} is proposed`)
    expect(git(at, "tester", ["log", "-1", "--format=%an|%(trailers:key=Score,valueonly)"])).toBe(
      "b-reviewer|3",
    )
    const high = await score("5")
    expect(high.out).toBe(`rev ${git(at, "tester", ["rev-parse", "HEAD"])} is accepted`)
    expect(git(at, "tester", ["log", "-1", "--format=%an"])).toBe("owner")
    expect(readFileSync(join(scopeDir(at, "tester"), "rules/self.md"), "utf8")).toBe(
      "Review another's work.\n",
    )
    const mine = await ext(at, [
      "put",
      "tester",
      "rule",
      "mine",
      join(scratch, "self.md"),
      "--reason",
      "r",
    ])
    const { rev: proposed } = JSON.parse(mine.out) as { rev: string }
    const scored = await ext(at, [
      "score",
      "tester",
      "rule",
      "mine",
      proposed,
      "5",
      "--reason",
      "r",
    ])
    expect(scored.code).toBe(1)
    expect(scored.err).toContain("owner wrote this proposal, so another session scores it")
  })

  test("a score from a session with a role whose name does not resolve is refused before it is judged, on another session's proposal and on one an unnamed session of its role wrote", async () => {
    const at = folder("unnamed-score")
    writeFileSync(join(scratch, "unnamed.md"), "Name the scorer.\n")
    const put = async (key: string, role: string, name?: string) =>
      (
        JSON.parse(
          (
            await ext(
              at,
              ["put", "tester", "rule", key, join(scratch, "unnamed.md"), "--reason", "r"],
              "",
              role,
              name,
            )
          ).out,
        ) as { rev: string }
      ).rev
    for (const [key, rev] of [
      ["named", await put("named", "worker", "a-worker")],
      ["unnamed", await put("unnamed", "worker")],
    ] as const) {
      const head = git(at, "tester", ["rev-parse", "HEAD"])
      const scored = await ext(
        at,
        ["score", "tester", "rule", key, rev, "5", "--reason", "r"],
        "",
        "worker",
      )
      expect(scored.code).toBe(1)
      expect(scored.err).toContain(
        "no name in Claude Code's registry resolves for this session (role worker)",
      )
      expect(git(at, "tester", ["rev-parse", "HEAD"])).toBe(head)
    }
  })

  test("accept from a session with a role is refused, by --by owner too and before its words are read, and the owner's own accept with no role accepts", async () => {
    const at = folder("accept")
    writeFileSync(join(scratch, "accept.md"), "Say less.\n")
    const put = await ext(at, [
      "put",
      "tester",
      "rule",
      "less",
      join(scratch, "accept.md"),
      "--reason",
      "r",
    ])
    const { rev } = JSON.parse(put.out) as { rev: string }
    for (const by of [[], ["--by", "owner"]]) {
      const refused = await ext(
        at,
        ["accept", "tester", "rule", "less", rev, "--reason", "r", ...by],
        "",
        "worker",
      )
      expect(refused.code).toBe(1)
      expect(refused.err).toContain("accept is the owner's own call")
      expect(refused.err).toContain(
        "asks for the accept as an accept decision with bun run ask new, whose Approve has the dashboard run it",
      )
      expect(refused.err).not.toContain("! command")
      expect(existsSync(join(scopeDir(at, "tester"), "rules/less.md"))).toBe(false)
    }
    const bare = await ext(at, ["accept"], "", "worker")
    expect(bare.code).toBe(1)
    expect(bare.err).toContain("accept is the owner's own call")
    const accepted = await ext(at, ["accept", "tester", "rule", "less", rev, "--reason", "r"])
    expect(accepted.code).toBe(0)
    expect(accepted.out).toBe(`rev ${git(at, "tester", ["rev-parse", "HEAD"])} is accepted`)
    expect(readFileSync(join(scopeDir(at, "tester"), "rules/less.md"), "utf8")).toBe("Say less.\n")
  })

  test("the terminal's Io carries PLAYGROUND_ROLE to accept's check and the session's registry name, and an empty role counts as none", async () => {
    const at = folder("terminal")
    writeFileSync(join(scratch, "terminal.md"), "Ask once.\n")
    const put = await ext(at, [
      "put",
      "tester",
      "rule",
      "once",
      join(scratch, "terminal.md"),
      "--reason",
      "r",
    ])
    const { rev } = JSON.parse(put.out) as { rev: string }
    const words = ["accept", "tester", "rule", "once", rev, "--reason", "r"]
    const config = join(at, "claude")
    mkdirSync(join(config, "sessions"), { recursive: true })
    writeFileSync(
      join(config, "sessions", "1.json"),
      JSON.stringify({ name: "q-dispatcher", sessionId: "s-1" }),
    )
    const io = (role: string) =>
      terminalIo({
        CLAUDE_CODE_SESSION_ID: "s-1",
        CLAUDE_CONFIG_DIR: config,
        HOME: scratch,
        PLAYGROUND_DATA_DIR: at,
        PLAYGROUND_ROLE: role,
      })
    expect(await io("dispatcher")).toMatchObject({
      data: at,
      name: "q-dispatcher",
      role: "dispatcher",
    })
    const err: string[] = []
    expect(await runStore("ext", words, await io("dispatcher"), (l) => err.push(l))).toBe(1)
    expect(err.join("\n")).toContain("a session with a role (dispatcher)")
    expect(await io("")).toMatchObject({ name: undefined, role: undefined })
    expect(await runStore("ext", words, await io(""), (l) => err.push(l))).toBe(0)
    expect(readFileSync(join(scopeDir(at, "tester"), "rules/once.md"), "utf8")).toBe("Ask once.\n")
  })

  test("a skill is put from its folder, a list from its JSON and accepted at once, and - reads stdin", async () => {
    const at = folder("kinds")
    mkdirSync(join(scratch, "skill", "refs"), { recursive: true })
    writeFileSync(join(scratch, "skill", "SKILL.md"), "# s\n")
    writeFileSync(join(scratch, "skill", "refs", "a.md"), "a\n")
    writeFileSync(join(scratch, "terms.json"), '["b","a"]')
    expect(
      (await ext(at, ["put", "tester", "skill", "s", join(scratch, "skill"), "--reason", "r"]))
        .code,
    ).toBe(0)
    const list = await ext(at, [
      "put",
      "acme",
      "list",
      "terms",
      join(scratch, "terms.json"),
      "--reason",
      "r",
    ])
    expect(JSON.parse(list.out)).toMatchObject({ state: "accepted" })
    expect(
      (await ext(at, ["put", "tester", "doc", "notes", "-", "--reason", "r"], "from stdin\n")).code,
    ).toBe(0)
    expect(git(at, "tester", ["ls-files"]).split("\n")).toEqual([
      "proposed/docs/notes.md",
      "proposed/skills/s/SKILL.md",
      "proposed/skills/s/refs/a.md",
    ])
    const shown = JSON.parse((await ext(at, ["show", "tester", "skill", "s"])).out)
    expect(shown).toMatchObject({
      content: { files: { "SKILL.md": "# s\n", "refs/a.md": "a\n" } },
      state: "proposed",
    })
    expect(JSON.parse((await ext(at, ["list", "--scope", "acme"])).out)).toEqual([
      {
        accepted: true,
        key: "terms",
        kind: "list",
        proposed: false,
        readOnly: false,
        scope: "acme",
      },
    ])
    expect(
      (
        await ext(at, [
          "put",
          "acme",
          "list",
          "terms",
          join(scratch, "terms.json"),
          "--reason",
          "r",
        ])
      ).err,
    ).toContain("409 the item already holds this content")
  })

  // core ships with the checkout, so list shows its items beside the scopes' own, marked read-only; a folder's .gitkeep only keeps an empty folder in git, so it is no item.
  test("list shows core's items marked read-only, and skips a .gitkeep", async () => {
    const at = folder("list-core")
    writeFiles(
      at,
      "acme",
      new Map([
        ["proposed/templates/.gitkeep", ""],
        ["templates/.gitkeep", ""],
        ["templates/welcome.md", "Hi.\n"],
      ]),
      { author: "owner", reason: "an empty folder kept, and a template" },
    )
    expect(JSON.parse((await ext(at, ["list", "--scope", "acme"])).out)).toEqual([
      {
        accepted: true,
        key: "welcome",
        kind: "template",
        proposed: false,
        readOnly: false,
        scope: "acme",
      },
    ])
    const core = JSON.parse((await ext(at, ["list", "--scope", "core", "--kind", "skill"])).out)
    expect(core).toContainEqual({
      accepted: true,
      key: "code-review-loop",
      kind: "skill",
      proposed: false,
      readOnly: true,
      scope: "core",
    })
    expect(core.every((row: { readOnly: boolean }) => row.readOnly)).toBe(true)
  })

  test("why with a skill's name prints the copy a session loads and the scopes whose copies it shadows", async () => {
    const at = folder("why-skill")
    writeFiles(at, "tester", new Map([["skills/code-review-loop/SKILL.md", "# mine\n"]]), {
      author: "owner",
      reason: "my own review loop",
    })
    const io: Io = { data: at, out: () => {}, stdin: async () => "", write: Bun.write }
    const set = ["set", "ext.order", "[]", "--reason", "a policy to resolve by"]
    expect(await runStore("settings", set, io, () => {})).toBe(0)
    const why = await ext(at, ["why", "code-review-loop"])
    expect(why.code).toBe(0)
    expect(JSON.parse(why.out)).toEqual({
      dir: join(scopeDir(at, "tester"), "skills", "code-review-loop"),
      from: "tester",
      shadowed: ["core"],
    })
    expect(JSON.parse((await ext(at, ["why", "tdd"])).out)).toMatchObject({
      from: "core",
      shadowed: [],
    })
    expect((await ext(at, ["why", "no-such-skill"])).err).toContain(
      "no scope holds the skill no-such-skill",
    )
  })

  test("which with a skill's name prints only the folder of the copy a session loads, and exits 2 on a name no scope holds", async () => {
    const at = folder("which-skill")
    writeFiles(at, "tester", new Map([["skills/code-review-loop/SKILL.md", "# mine\n"]]), {
      author: "owner",
      reason: "my own review loop",
    })
    const io: Io = { data: at, out: () => {}, stdin: async () => "", write: Bun.write }
    const set = ["set", "ext.order", "[]", "--reason", "a policy to resolve by"]
    expect(await runStore("settings", set, io, () => {})).toBe(0)
    expect(await ext(at, ["which", "code-review-loop"])).toMatchObject({
      code: 0,
      out: join(scopeDir(at, "tester"), "skills", "code-review-loop"),
    })
    const missing = await ext(at, ["which", "no-such-skill"])
    expect(missing.code).toBe(2)
    expect(missing.err).toContain("no scope holds the skill no-such-skill")
    expect((await ext(at, ["which"])).code).toBe(2)
  })

  test("show --rev of a proposal beside an accepted copy prints the proposal's body and its state", async () => {
    const at = folder("show-rev")
    const put = async (body: string, role?: string) =>
      JSON.parse(
        (await ext(at, ["put", "tester", "doc", "notes", "-", "--reason", "r"], body, role)).out,
      ) as { rev: string; state: string }
    const first = await put("accepted")
    const accept = await ext(at, ["accept", "tester", "doc", "notes", first.rev, "--reason", "r"])
    const accepted = { rev: accept.out.split(" ")[1]!, state: accept.out.split(" ").at(-1) }
    const proposed = await put("proposed", "worker")
    expect([accepted.state, proposed.state]).toEqual(["accepted", "proposed"])
    const show = async (rev: string) =>
      JSON.parse((await ext(at, ["show", "tester", "doc", "notes", "--rev", rev])).out)
    expect(await show(proposed.rev)).toMatchObject({
      content: { body: "proposed" },
      state: "proposed",
    })
    expect(await show(accepted.rev)).toMatchObject({
      content: { body: "accepted" },
      state: "accepted",
    })
  })

  test("search finds the words in accepted items, and diff shows an item's change between two commits", async () => {
    const at = folder("search")
    writeFileSync(join(scratch, "one.json"), '["first"]')
    writeFileSync(join(scratch, "two.json"), '["first","xylograph"]')
    const first = JSON.parse(
      (
        await ext(at, [
          "put",
          "tester",
          "list",
          "words",
          join(scratch, "one.json"),
          "--reason",
          "a",
        ])
      ).out,
    )
    const second = JSON.parse(
      (
        await ext(at, [
          "put",
          "tester",
          "list",
          "words",
          join(scratch, "two.json"),
          "--reason",
          "b",
        ])
      ).out,
    )
    const found = JSON.parse((await ext(at, ["search", "xylograph"])).out) as {
      key: string
      scope: string
    }[]
    expect(found).toMatchObject([{ key: "words", kind: "list", scope: "tester" }])
    const diff = await ext(at, [
      "diff",
      "tester",
      "list",
      "words",
      "--from",
      first.rev,
      "--to",
      second.rev,
    ])
    expect(diff.out.split("\n")).toContain('+  "xylograph"')
  })

  test("export clones each scope into a new folder, refuses one that holds anything, and import brings it to another machine", async () => {
    const at = folder("export")
    writeFileSync(join(scratch, "x.json"), '["x"]')
    await ext(at, ["put", "acme", "list", "x", join(scratch, "x.json"), "--reason", "r"])
    const into = join(scratch, "exported")
    expect((await ext(at, ["export", into])).out).toBe(`exported acme to ${join(into, "acme")}`)
    expect((await ext(at, ["export", into])).err).toContain("is not empty")
    const other = folder("import")
    const dry = await ext(other, ["import", into, "--dry-run"])
    expect(dry.out).toBe("+ acme: new, 1 files")
    expect(existsSync(scopeDir(other, "acme"))).toBe(false)
    expect((await ext(other, ["import", into])).code).toBe(0)
    expect(git(other, "acme", ["rev-parse", "HEAD"])).toBe(git(at, "acme", ["rev-parse", "HEAD"]))
  })

  test("import --from-tree puts each guard's list file into the login's lists in one commit, derives the hooks, and names the ones it lacks", async () => {
    const at = folder("tree")
    const tree = join(scratch, "tree")
    mkdirSync(tree, { recursive: true })
    const [first, ...rest] = GUARD_LISTS
    writeFileSync(join(tree, `${first}.json`), '["made-up"]')
    const r = await ext(at, ["import", "--from-tree", tree])
    expect(r.code).toBe(0)
    expect(r.out.split("\n")).toEqual([
      `+ list tester ${first} from ${join(tree, `${first}.json`)}`,
      ...rest.map(
        (name) =>
          `- ${name}: no ${join(tree, `${name}.json`)}; add it with playground ext put tester list ${name} <file> --reason <why>`,
      ),
      `committed ${git(at, "tester", ["rev-parse", "HEAD"]).slice(0, 12)}`,
    ])
    expect(
      JSON.parse(readFileSync(join(at, "extensions", "hooks", `${first}.json`), "utf8")),
    ).toEqual(["made-up"])
  })

  // PG-1377: put stored every file 644, so a skill's script run directly failed with a permission error once accepted
  test("put keeps a file's executable bit, as a proposal and once accepted, so the script runs directly (PG-1377)", async () => {
    const at = folder("modes")
    const script = join(scratch, "hello.sh")
    writeFileSync(script, "#!/bin/sh\necho made-up hello\n")
    chmodSync(script, 0o755)
    const skill = join(scratch, "greeter")
    mkdirSync(join(skill, "scripts"), { recursive: true })
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: greeter\ndescription: d\n---\nRun scripts/greet.sh.\n",
    )
    writeFileSync(join(skill, "scripts", "greet.sh"), "#!/bin/sh\necho made-up greet\n")
    chmodSync(join(skill, "scripts", "greet.sh"), 0o755)
    const modes = () =>
      git(at, "tester", ["ls-files", "-s"])
        .split("\n")
        .map((line) => line.replace(/ [0-9a-f]{40} 0\t/, " "))
    const put = async (kind: string, key: string, path: string) =>
      JSON.parse((await ext(at, ["put", "tester", kind, key, path, "--reason", "r"])).out) as {
        rev: string
      }
    const one = await put("script", "hello", script)
    const two = await put("skill", "greeter", skill)
    expect(modes()).toEqual([
      "100755 proposed/scripts/hello",
      "100644 proposed/skills/greeter/SKILL.md",
      "100755 proposed/skills/greeter/scripts/greet.sh",
    ])
    for (const [kind, key, rev] of [
      ["script", "hello", one.rev],
      ["skill", "greeter", two.rev],
    ] as const)
      expect((await ext(at, ["accept", "tester", kind, key, rev, "--reason", "r"])).code).toBe(0)
    expect(modes()).toEqual([
      "100755 scripts/hello",
      "100644 skills/greeter/SKILL.md",
      "100755 skills/greeter/scripts/greet.sh",
    ])
    for (const [path, said] of [
      ["scripts/hello", "made-up hello"],
      ["skills/greeter/scripts/greet.sh", "made-up greet"],
    ]) {
      const ran = Bun.spawnSync([join(scopeDir(at, "tester"), path)])
      expect(ran.exitCode).toBe(0)
      expect(ran.stdout.toString().trim()).toBe(said)
    }
  })

  test("check-modes lists each stored file that starts with #! but lost its executable bit, and changes nothing (PG-1377)", async () => {
    const at = folder("check-modes")
    writeFiles(
      at,
      "tester",
      new Map([
        ["scripts/old", "#!/bin/sh\necho old\n"],
        ["skills/s/SKILL.md", "Run run.py with python3.\n"],
        ["skills/s/run.py", "print(1)\n"],
        ["attachments/0a1b.sh", "#!/bin/sh\necho attached\n"],
        ["docs/shebang.md", "#! a doc that starts like a script\n"],
      ]),
      { author: "owner", reason: "seeded" },
    )
    const kept = join(scratch, "kept.sh")
    writeFileSync(kept, "#!/bin/sh\necho kept\n")
    chmodSync(kept, 0o755)
    await ext(at, ["put", "tester", "script", "kept", kept, "--reason", "r"])
    const head = git(at, "tester", ["rev-parse", "HEAD"])
    const r = await ext(at, ["check-modes"])
    expect(r.code).toBe(0)
    expect(r.out.split("\n")).toEqual([
      "tester scripts/old",
      "put each again from a copy that has its executable bit: playground ext put <scope> <kind> <key> <path> --reason <why>",
    ])
    expect(git(at, "tester", ["rev-parse", "HEAD"])).toBe(head)
    const none = await ext(folder("check-modes-none"), ["check-modes"])
    expect(none).toMatchObject({
      code: 0,
      out: "every stored file that starts with #! keeps its executable bit",
    })
  })

  test("a command it does not have is a usage error", async () => {
    const r = await ext(folder("usage"), ["merge", "tester", "rule", "short"])
    expect(r.code).toBe(2)
    expect(r.err).toStartWith("playground ext: no ext command merge\nusage: playground ext")
  })
})
