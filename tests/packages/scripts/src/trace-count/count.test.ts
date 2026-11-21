import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  COUNTS,
  type Counts,
  count,
  type File,
  changedFiles,
  KEPT,
  type Kept,
  list,
  listGate,
  listKindsIn,
  listSince,
  located,
  lowered,
  refusal,
  risen,
  risenKinds,
  stale,
  tree,
} from "../../../../../packages/scripts/src/trace-count/count"
import {
  EMPTY_LIST,
  reposOf,
  UNSET_REPOS,
} from "../../../../../packages/scripts/src/trace-count/kinds"
import { capital } from "../../../../session-names"

const root = join(import.meta.dir, "..", "..", "..", "..", "..")
// Built at run time, so this file's own text adds no trace to the tree's count.
const ref = (n: number) => `#${n}`
const OLD = ["light", "kid"].join("")
const OLD_NAME = { builder: OLD, dispatcher: ["light", "man"].join("") }
const OLD_SKILL = ["light", "review"].join("")
// Made-up values, one per list key.
const LIST = {
  companies: ["Vantorix"],
  handles: ["qmarsh"],
  linearKeys: ["MADEVX"],
  names: ["Quilla Marsh"],
  slackIds: ["C0MADE0401"],
}

describe("the trace count", () => {
  test("counts each kind, its list-fed kinds from the list", () => {
    const text = [
      "Quilla Marsh and @qmarsh at Vantorix, in C0MADE0401, on MADEVX-12",
      `mail ${["quilla", "qwerty.io"].join("@")}, see #123, as ${OLD_NAME.dispatcher} and ${OLD_NAME.builder} said`,
      "https://github.com/octo/vault/pull/4",
      `run ${OLD_SKILL} and ${OLD_SKILL}-scan, not playground-review`,
    ].join("\n")
    const repos = reposOf({
      schemaVersion: 1,
      values: { "factory.archiveRepo": "octo/vault", "owner.names": ["tobin"] },
    })
    expect(count([{ path: "a.md", text }], LIST, repos)).toEqual({
      archiveLinks: 1,
      companies: 1,
      companyName: 0,
      emails: 1,
      handles: 1,
      issueRefs: 1,
      lightWords: 0,
      linearKeys: 1,
      macOnly: 0,
      names: 1,
      oldNames: 2,
      oldSkillNames: 2,
      ownerName: 0,
      slackIds: 1,
    })
  })

  test("counts the owner's names the settings give and the archive's owner, past an address and an archive link", () => {
    const repos = reposOf({
      schemaVersion: 1,
      values: { "factory.archiveRepo": "qmarsh/vault", "owner.names": ["quilla"] },
    })
    const text = [
      "Quilla asked for it, QUILLA again, and @qmarsh said so at github.com/qmarsh",
      `mail ${["quilla", "vantorix.io"].join("@")}, see qmarsh/vault/pull/3, quillas and qmarshes`,
    ].join("\n")
    const counts = count([{ path: "a.md", text }], undefined, repos)
    expect(counts.ownerName).toBe(4)
    expect(counts.archiveLinks).toBe(1)
  })

  test("leaves the owner's handle out where it is the owner part of a repository URL or slug", () => {
    const repos = reposOf({ schemaVersion: 1, values: { "owner.names": ["quilla"] } })
    const counts = count(
      [
        {
          path: "a.md",
          text: "the main product lives at https://github.com/quilla/zerosdk, which comes later",
        },
        { path: "b.md", text: "clone it as quilla/zerosdk to run it" },
      ],
      undefined,
      repos,
    )
    expect(counts.ownerName).toBe(0)
  })

  test("still counts the owner's handle in prose beside a repository slug", () => {
    const repos = reposOf({ schemaVersion: 1, values: { "owner.names": ["quilla"] } })
    const text = "quilla wrote the warning line, and the clone line beside it reads quilla/zerosdk."
    expect(count([{ path: "a.md", text }], undefined, repos).ownerName).toBe(1)
  })

  test("leaves the owner's handle out before any path word, a path in prose included", () => {
    const repos = reposOf({ schemaVersion: 1, values: { "owner.names": ["quilla"] } })
    const text = "the drafts sit in quilla/notes for now"
    expect(count([{ path: "a.md", text }], undefined, repos).ownerName).toBe(0)
  })

  test("counts a quote set against the owner and anyone's dated quote, as a name is, and nothing with no names to read", () => {
    // Built at run time, so this file's own text holds no quote.
    const owner = ["the", "owner"].join(" ")
    const text = [
      `${owner}, 24 Oct: "ship it"`,
      `Test note (${["Corin", "23 Oct"].join(", ")}: "do it this way").`,
      `as ${owner} said, and ${owner} wrote it down`,
      `${owner}'s go through the Inbox, by 24 Oct: no quote`,
    ].join("\n")
    const repos = reposOf({ schemaVersion: 1, values: { "owner.names": ["tobin"] } })
    expect(count([{ path: "a.md", text }], undefined, repos).ownerName).toBe(4)
    expect(count([{ path: "a.md", text }]).ownerName).toBeUndefined()
  })

  test("counts the company's name in any spacing, and no longer word that holds it", () => {
    const company = ["light", "work"].join("")
    const product = ["new", "gen"].join("")
    const text = `${company}-blue, ${["Light", "Work"].join(" ")}, ${["light", "work"].join("-")}, ${product.toUpperCase()}; ${company}ers, ${product}eration`
    expect(count([{ path: "a.md", text }]).companyName).toBe(4)
  })

  test("counts a factory or old skill word glued into a longer one, which the old-name kinds read past", () => {
    const old = OLD_NAME.dispatcher
    const text = [
      `${old}Music, from${capital(old)}, the ${old}s, run ${["light", "quill"].join("")}`,
      `${old} alone, a highlight, lightfacts, the worker-light`,
    ].join("\n")
    const counts = count([{ path: "a.ts", text }])
    expect(counts.lightWords).toBe(4)
    expect(counts.oldNames).toBe(1)
  })

  test("a list kind is unmeasured with no list, not counted as gone", () => {
    const counts = count([{ path: "a.md", text: "Quilla Marsh" }], EMPTY_LIST)
    expect(counts.names).toBeUndefined()
    expect(counts.issueRefs).toBe(0)
  })

  test("reads past a lockfile, whose integrity hash can hold a list value by chance", () => {
    const hash = `"sha512-abc${LIST.slackIds[0]}xyz=="`
    const lock = count([{ path: "bun.lock", text: ` "x": ["x@1.0.0", "", {}, ${hash}],` }], LIST)
    expect(lock.slackIds).toBe(0)
    expect(count([{ path: "tests/a.ts", text: `"${LIST.slackIds[0]}"` }], LIST).slackIds).toBe(1)
  })

  test("reads past a live name the migration moves, the public repositories' names and the seed's left-out paths", () => {
    const counts = count([
      {
        path: "a.ts",
        text: `const db = "${OLD_NAME.dispatcher}-desk-db"\nsee ${UNSET_REPOS.public.join(" and ")}`,
      },
      { path: "packages/scripts/src/trace-count/counts.json", text: `#123 ${OLD_NAME.dispatcher}` },
      { path: "packages/scripts/src/trace-count/kept.json", text: "#456" },
    ])
    expect(counts.oldNames).toBe(0)
    expect(counts.issueRefs).toBe(0)
  })

  test("reads past the files that define the old names, and a fixture's made-up PR numbers but not its other traces", () => {
    const counts = count([
      { path: "packages/scripts/src/rename/rules.ts", text: `${OLD} ${ref(123)}` },
      { path: "packages/scripts/src/trace-count/kinds.ts", text: `${OLD} ${ref(124)}` },
      {
        path: "api/hono/src/fixtures/dashboard.json",
        text: `"pr": "${ref(97)}", "from": "${OLD}"`,
      },
      { path: "packages/scripts/src/parity/replay/fixtures/scan/slack.json", text: ref(28) },
    ])
    expect(counts.issueRefs).toBe(0)
    expect(counts.oldNames).toBe(1)
  })

  test("reads past tests/ for issue numbers alone, so a test's other traces still count", () => {
    const counts = count([{ path: "tests/a.test.ts", text: `${ref(123)} MADEVX-12 ${OLD}` }], LIST)
    expect(counts.issueRefs).toBe(0)
    expect(counts.linearKeys).toBe(1)
    expect(counts.oldNames).toBe(1)
  })

  test("counts a key only through the list: no fixed key kind, so an empty list counts none", () => {
    expect(count([{ path: "a.md", text: "fixes MADEVX-42" }], LIST).linearKeys).toBe(1)
    const empty = count([{ path: "a.md", text: "fixes MADEVX-42" }], EMPTY_LIST)
    expect(empty).not.toHaveProperty("archiveKeys")
    expect(Object.values(empty).every((n) => n === 0)).toBe(true)
  })

  test("reads a hex colour as no issue, since an issue number never starts with 0", () => {
    expect(count([{ path: "a.css", text: `0 0 #0000; #000 6px; see ${ref(120)}` }]).issueRefs).toBe(
      1,
    )
  })

  test("reads past a made-up address, an ssh remote's git user and a package's version, so only a real address is a trace", () => {
    const text = [
      "merritt@example.com ada@example.org pat@example.net own@shop.example.com",
      "robin@example.test x@nowhere.invalid dev@app.localhost agent@local.host",
      "git@github.com:acme/app.git next-themes@0.4.6.patch",
      ["real", "vantorix.io"].join("@"),
    ].join("\n")
    expect(count([{ path: "a.ts", text }]).emails).toBe(1)
  })
})

describe("the ratchet", () => {
  test("a rise or a kind with no count yet fails, a fall passes", () => {
    expect(risen({ emails: 2, issueRefs: 4 }, { emails: 3, issueRefs: 3 })).toEqual([
      "issueRefs: 4 in the tree, counts.json allows 3",
    ])
    expect(risen({ names: 1 }, {})).toHaveLength(1)
    expect(risen({ emails: 2 }, { emails: 3 })).toEqual([])
  })

  test("a risen issueRefs count names its fix and where the number goes, and another kind keeps the plain reason", () => {
    expect(refusal(risen({ emails: 2, issueRefs: 4 }, { emails: 3, issueRefs: 3 }))).toBe(
      "trace-count: a count rose; write the new text in plain words; describe the case in words; a doc cites no issue number, and the PR body's Merge Danger or Links carry it:\nissueRefs: 4 in the tree, counts.json allows 3",
    )
    expect(refusal(risen({ emails: 4 }, { emails: 3 }))).toBe(
      "trace-count: a count rose; write the new text in plain words:\nemails: 4 in the tree, counts.json allows 3",
    )
  })

  test("writing lowers each measured kind and keeps one this run did not measure", () => {
    expect(lowered({ emails: 2, issueRefs: 3 }, { emails: 3, issueRefs: 3, names: 9 })).toEqual({
      emails: 2,
      issueRefs: 3,
      names: 9,
    })
  })

  // a made-up owner name turns on ownerName's quote patterns, which read no real name, so a new quote fails here; the owner's own names count only in bun run trace-count
  test("no count in the tree, less the kept hits, is over counts.json", async () => {
    const baseline = (await Bun.file(COUNTS).json()) as Counts
    const kept = (await Bun.file(KEPT).json()) as Kept[]
    const files = await tree(root)
    const repos = { ...UNSET_REPOS, owner: [["zq", "made", "up"].join("-")] }
    const over = risen(count(files, undefined, repos, kept), baseline)
    const at = () => located(files, risenKinds(over), undefined, repos, kept, changedFiles(root))
    expect(over.length ? refusal(over, at()) : "").toBe("")
  })
})

describe("the kept hits", () => {
  const entry = (over: Partial<Kept> = {}): Kept => ({
    hits: 1,
    kind: "oldNames",
    line: `const role = "${OLD}"`,
    path: "a.ts",
    reason: "a made-up reason",
    ...over,
  })
  const file = { path: "a.ts", text: `const role = "${OLD}"\nsee ${OLD} again` }

  test("a kept line's hits come off its kind's count, and the file's other hits still count", () => {
    expect(count([file]).oldNames).toBe(2)
    expect(count([file], undefined, undefined, [entry()]).oldNames).toBe(1)
    expect(stale([file], [entry()])).toEqual([])
  })

  test("an entry with copies takes its hits off once for each identical line it names", () => {
    const two = { path: "a.ts", text: `const role = "${OLD}"\nconst role = "${OLD}"` }
    expect(count([two], undefined, undefined, [entry({ copies: 2 })]).oldNames).toBe(0)
    expect(stale([two], [entry({ copies: 2 })])).toEqual([])
  })

  test.each<[string, Kept, string, File?]>([
    ["its file is gone", entry({ path: "b.ts" }), "its file is gone"],
    [
      "its file is never counted",
      entry({ path: "packages/scripts/src/trace-count/counts.json" }),
      "its file is never counted",
      { path: "packages/scripts/src/trace-count/counts.json", text: `const role = "${OLD}"` },
    ],
    ["no line reads as its text", entry({ line: "const role = 1" }), "no line reads as its text"],
    [
      "two lines read as its text",
      entry(),
      "2 lines read as its text, not 1, so set its copies or give it a longer one",
      { path: "a.ts", text: `const role = "${OLD}"\nconst role = "${OLD}"` },
    ],
    [
      "one line reads as its text of copies 2",
      entry({ copies: 2 }),
      "1 line reads as its text, not 2, so set its copies or give it a longer one",
    ],
    [
      "three lines read as its text of copies 2",
      entry({ copies: 2 }),
      "3 lines read as its text, not 2, so set its copies or give it a longer one",
      { path: "a.ts", text: `const role = "${OLD}"\nconst role = "${OLD}"\nconst role = "${OLD}"` },
    ],
    ["its line lost its hit", entry({ hits: 2 }), "its line holds 1 oldNames, not 2"],
  ])("an entry is stale, named by path and text, when %s", (_, kept, says, tree = file) => {
    expect(stale([tree], [kept])).toEqual([`${kept.path}: "${kept.line}" (oldNames): ${says}`])
    expect(count([tree], undefined, undefined, [kept]).oldNames).toBe(count([tree]).oldNames)
  })

  test("every entry in kept.json stands in the tree, with a reason that holds no trace", async () => {
    const kept = (await Bun.file(KEPT).json()) as Kept[]
    expect(stale(await tree(root), kept)).toEqual([])
    const reasons = count([{ path: "reasons", text: kept.map((e) => e.reason).join("\n") }])
    expect(Object.values(reasons).every((n) => n === 0)).toBe(true)
    expect(kept.every((e) => e.reason.trim().length > 0 && e.hits > 0 && (e.copies ?? 2) > 1)).toBe(
      true,
    )
  })
})

describe("no-public-leak's list", () => {
  const scratch = mkdtempSync(join(tmpdir(), "trace-count-list-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))
  const at = (name: string, value?: unknown): string => {
    const path = join(scratch, name, "no-public-leak.json")
    mkdirSync(join(scratch, name), { recursive: true })
    if (value !== undefined) writeFileSync(path, JSON.stringify(value))
    return path
  }

  test("a list with an entry under every key is read", async () => {
    expect(await list(at("full", LIST))).toEqual({ list: LIST })
  })

  test.each([
    ["missing", undefined, "no "],
    ["not the list", { names: "Quilla" }, "is not no-public-leak's list"],
    ["with an empty key", { ...LIST, handles: [], slackIds: [] }, "has no handles, slackIds"],
  ])("a list file %s is refused, naming the fix", async (name, value, says) => {
    const path = at(name.replaceAll(" ", "-"), value)
    const read = await list(path)
    expect(read).toEqual({ refusal: expect.stringContaining(says) })
    expect((read as { refusal: string }).refusal).toContain(
      "tell your lead, and the dispatcher hands the owner ! playground ext put <scope> list no-public-leak <file> --reason <why> to type in the dispatcher's terminal window",
    )
  })

  test("a run with no owner.names or no archive exits 2 before it counts, naming each unset key", () => {
    const run = (values: Record<string, unknown>) => {
      const data = join(scratch, `policy-${Object.keys(values).length}`)
      mkdirSync(join(data, "extensions", "hooks"), { recursive: true })
      writeFileSync(join(data, "extensions", "hooks", "no-public-leak.json"), JSON.stringify(LIST))
      writeFileSync(join(data, "extensions", "login"), "made-up-me\n")
      writeFileSync(
        join(data, "extensions", "policy.json"),
        JSON.stringify({ orgs: {}, schemaVersion: 1, values }),
      )
      return Bun.spawnSync(
        [process.execPath, join(root, "packages/scripts/src/trace-count/cli.ts")],
        { env: { ...process.env, PLAYGROUND_DATA_DIR: data }, stderr: "pipe", stdout: "pipe" },
      )
    }
    const none = run({})
    expect(none.exitCode).toBe(2)
    expect(none.stdout.toString()).toBe("")
    expect(none.stderr.toString()).toContain("factory.archiveRepo and owner.names are unset")
    expect(none.stderr.toString()).toContain(
      "tell your lead, and the dispatcher asks the owner to fill in Privacy on the Dashboard's Settings page, which sets them",
    )
    expect(none.stderr.toString()).toContain("nothing was counted")
    expect(none.stderr.toString()).toContain(
      "bun run test:file tests/packages/scripts/src/trace-count/count.test.ts",
    )
    const named = run({ "factory.archiveRepo": "qmarsh/vault" })
    expect(named.exitCode).toBe(2)
    expect(named.stderr.toString()).toContain("owner.names is unset")
    expect(named.stderr.toString()).toContain(
      "Privacy on the Dashboard's Settings page, which sets it",
    )
    expect(none.stderr.toString() + named.stderr.toString()).not.toContain("terminal")
    expect(named.stderr.toString()).toContain("nothing was counted")
    expect(named.stderr.toString()).toContain(
      "bun run test:file tests/packages/scripts/src/trace-count/count.test.ts",
    )
  })

  test("a run with no list file exits 2 before it counts", () => {
    const data = join(scratch, "no-data")
    mkdirSync(data, { recursive: true })
    const run = Bun.spawnSync(
      [process.execPath, join(root, "packages/scripts/src/trace-count/cli.ts")],
      { env: { ...process.env, PLAYGROUND_DATA_DIR: data }, stderr: "pipe", stdout: "pipe" },
    )
    expect(run.exitCode).toBe(2)
    expect(run.stdout.toString()).toBe("")
    expect(run.stderr.toString()).toContain(
      join(data, "extensions", "hooks", "no-public-leak.json"),
    )
    expect(run.stderr.toString()).toContain("nothing was counted")
    expect(run.stderr.toString()).toContain(
      "bun run test:file tests/packages/scripts/src/trace-count/count.test.ts",
    )
  })

  test("a run whose policy.json does not parse exits 2 before it counts", () => {
    const data = join(scratch, "bad-policy")
    mkdirSync(join(data, "extensions"), { recursive: true })
    writeFileSync(join(data, "extensions", "policy.json"), "{ not json")
    const run = Bun.spawnSync(
      [process.execPath, join(root, "packages/scripts/src/trace-count/cli.ts")],
      { env: { ...process.env, PLAYGROUND_DATA_DIR: data }, stderr: "pipe", stdout: "pipe" },
    )
    expect(run.exitCode).toBe(2)
    expect(run.stderr.toString()).toContain("does not parse")
    expect(run.stderr.toString()).toContain("nothing was counted")
    expect(run.stderr.toString()).toContain(
      "bun run test:file tests/packages/scripts/src/trace-count/count.test.ts",
    )
  })
})

// a harness's untracked output in a worktree tripped the ratchet, and the refusal named no file
describe("the tree a count reads", () => {
  const scratch = mkdtempSync(join(tmpdir(), "trace-count-tree-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))
  // nothing from this machine's git: a hook exports GIT_DIR and GIT_INDEX_FILE, which would point every git call here, tree()'s included, at the checkout being committed
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", scratch, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    })

  test("counts a tracked or staged file, never an untracked one", async () => {
    const hook = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"))
    for (const [key] of hook) delete process.env[key]
    try {
      expect(git("init", "-q").exitCode).toBe(0)
      writeFileSync(join(scratch, "notes.ts"), `see ${ref(12)}\n`)
      git("add", "notes.ts")
      expect(git("commit", "-qm", "first").exitCode).toBe(0)
      writeFileSync(join(scratch, "dump.txt"), `a replay of ${ref(34)}\n`)
      expect(count(await tree(scratch)).issueRefs).toBe(1)
      git("add", "dump.txt")
      expect(count(await tree(scratch)).issueRefs).toBe(2)
    } finally {
      for (const [key, value] of hook) process.env[key] = value
    }
  })
})

describe("a refusal names where each hit is", () => {
  const files: File[] = [
    { path: "docs/a.md", text: `one\nsee ${ref(12)}\n` },
    { path: "docs/b.md", text: `also ${ref(34)}\n` },
    { path: "c.ts", text: "clean\n" },
  ]

  test("names each file and line holding a risen kind", () => {
    const at = located(files, ["issueRefs"])
    expect(at).toEqual(["docs/a.md:2: issueRefs", "docs/b.md:1: issueRefs"])
    expect(refusal(["issueRefs: 2 in the tree, counts.json allows 0"], at)).toContain(
      "\ndocs/a.md:2: issueRefs\ndocs/b.md:1: issueRefs",
    )
  })

  test("leaves out a line kept.json keeps", () => {
    const kept: Kept = {
      hits: 1,
      kind: "issueRefs",
      line: `see ${ref(12)}`,
      path: "docs/a.md",
      reason: "made up",
    }
    expect(located(files, ["issueRefs"], undefined, undefined, [kept])).toEqual([
      "docs/b.md:1: issueRefs",
    ])
  })

  test("names a changed file's hits alone, and every file's when the changed ones hold none", () => {
    expect(located(files, ["issueRefs"], undefined, undefined, [], ["docs/b.md"])).toEqual([
      "docs/b.md:1: issueRefs",
    ])
    expect(located(files, ["issueRefs"], undefined, undefined, [], ["c.ts"])).toHaveLength(2)
  })

  test("names every risen kind, each from the changed files when they hold it and from every file when they do not", () => {
    const two: File[] = [...files, { path: "docs/old.md", text: `ask ${OLD}\n` }]
    expect(
      located(two, ["issueRefs", "oldNames"], undefined, undefined, [], ["docs/b.md"]),
    ).toEqual(["docs/b.md:1: issueRefs", "docs/old.md:1: oldNames"])
  })

  test("names a kept line once it holds more hits than kept.json keeps", () => {
    const kept: Kept = {
      hits: 1,
      kind: "issueRefs",
      line: `see ${ref(12)} and ${ref(34)}`,
      path: "docs/a.md",
      reason: "made up",
    }
    const grown: File[] = [{ path: "docs/a.md", text: `see ${ref(12)} and ${ref(34)}\n` }]
    expect(located(grown, ["issueRefs"], undefined, undefined, [kept])).toEqual([
      "docs/a.md:1: issueRefs",
    ])
  })
})

// The commit's list step reads this machine's list, which the sandboxed tree test cannot see, so a listed key in a staged file fails the commit; each key is built at run time, so this file adds no hit of its own.
describe("the commit's list gate", () => {
  const scratch = mkdtempSync(join(tmpdir(), "trace-count-gate-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))
  const key = (team: string) => [team, "12"].join("-")
  const listAt = (value: unknown): string => {
    const path = join(scratch, `list-${crypto.randomUUID()}.json`)
    writeFileSync(path, JSON.stringify(value))
    return path
  }
  const treeWith = (text: string): string => {
    const root = join(scratch, `tree-${crypto.randomUUID()}`)
    mkdirSync(join(root, "docs"), { recursive: true })
    writeFileSync(join(root, "docs", "a.md"), `${text}\n`)
    return root
  }
  const made = { ...LIST, linearKeys: ["QZX"] }

  test("a file holding a listed key fails, naming the kind and its line, and another made-up key passes", async () => {
    const refused = await listGate(treeWith(`Filed as ${key("QZX")}.`), listAt(made))
    expect(refused).toContain("linearKeys: 1 in the tree, counts.json allows 0")
    expect(refused).toContain("docs/a.md:1: linearKeys")
    expect(await listGate(treeWith(`Filed as ${key("MADE")}.`), listAt(made))).toBe("")
  })

  // the files whose own tests once named the real prefixes to keep them out: the gate counts each, none of them left out of linearKeys
  test.each([
    "api/hono/src/fixtures/dashboard.json",
    "packages/scripts/src/verify/dashboard-map.json",
    "extensions/core/skills/pr/SKILL.md",
  ])("a listed key in %s fails, named by its path and line", async (path) => {
    const root = join(scratch, `tree-${crypto.randomUUID()}`)
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), `{\n  "title": "${key("QZX")} report"\n}\n`)
    expect(await listGate(root, listAt(made))).toContain(`${path}:2: linearKeys`)
  })

  test("a partial list still gates the keys it holds", async () => {
    const partial = { ...EMPTY_LIST, linearKeys: ["QZX"] }
    expect(await listGate(treeWith(`Filed as ${key("QZX")}.`), listAt(partial))).toContain(
      "linearKeys: 1 in the tree",
    )
  })

  test("no list on the machine counts nothing, and a file that is not the list is refused", async () => {
    const root = treeWith(`Filed as ${key("QZX")}.`)
    expect(await listGate(root, join(scratch, "none.json"))).toBe("")
    expect(await listGate(root, listAt({ names: "Quilla" }))).toContain(
      "is not no-public-leak's list",
    )
  })
})

// CI's list step: the pull request's changed files, their paths, its commit messages and its branch's name, against a list the step writes outside the checkout; a refusal names each place and kind and never the term, since the log is public.
describe("the pull request's list gate", () => {
  const scratch = mkdtempSync(join(tmpdir(), "trace-count-pr-"))
  afterAll(() => rmSync(scratch, { force: true, recursive: true }))
  const listPath = join(scratch, "list.json")
  writeFileSync(listPath, JSON.stringify(LIST))
  const repo = () => {
    const dir = join(scratch, `repo-${crypto.randomUUID()}`)
    mkdirSync(join(dir, "docs"), { recursive: true })
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: dir, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } },
      )
      expect(result.exitCode).toBe(0)
      return result.stdout.toString().trim()
    }
    const commit = (path: string, text: string, message: string) => {
      writeFileSync(join(dir, path), text)
      git("add", path)
      git("commit", "-q", "-m", message)
      return git("rev-parse", "HEAD")
    }
    git("init", "-q", "-b", "base")
    commit("docs/a.md", "Plain text.\n", "docs: start")
    git("branch", "canary")
    git("checkout", "-q", "-b", "work")
    return { commit, dir }
  }
  const TERMS = [...LIST.companies, ...LIST.handles, ...LIST.names].map((t) => t.toLowerCase())
  const printsNoTerm = (out: string) =>
    expect(TERMS.filter((term) => out.toLowerCase().includes(term))).toEqual([])

  test("a term the pull request adds to a file, a path or a message fails, by place and kind alone", async () => {
    const { commit, dir } = repo()
    commit("docs/a.md", `Plain text.\nBuilt for ${LIST.companies[0]}.\n`, "docs: a line")
    const sha = commit("docs/b.md", "More.\n", `docs: thanks ${LIST.handles[0]}`)
    commit(`docs/${LIST.handles[0]}.md`, "Plain.\n", "docs: a page")
    const refused = await listSince(
      dir,
      "canary",
      listPath,
      `${LIST.names[0]!.split(" ")[0]}-${LIST.names[0]!.split(" ")[1]}`,
    )
    expect(refused).toContain("docs/a.md: companies")
    expect(refused).toContain(`${sha.slice(0, 9)}'s message: handles`)
    expect(refused).toContain("a changed file's path: handles")
    printsNoTerm(refused)
  })

  // the log is every byte the process writes, git's own stderr included, which once named a new file's path
  test("the gate's process prints no term on any stream", () => {
    const { commit, dir } = repo()
    commit(`docs/${LIST.handles[0]}.md`, `By ${LIST.names[0]}.\n`, `docs: for ${LIST.companies[0]}`)
    const count = join(import.meta.dir, "../../../../../packages/scripts/src/trace-count/count.ts")
    const ran = Bun.spawnSync(
      [
        "bun",
        "-e",
        `const { listSince } = await import(${JSON.stringify(count)}); const out = await listSince(${JSON.stringify(dir)}, "canary", ${JSON.stringify(listPath)}); console.error(out); process.exit(out ? 1 : 0)`,
      ],
      { cwd: dir, stderr: "pipe", stdout: "pipe" },
    )
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(ran.exitCode).toBe(1)
    expect(out).toContain("a changed file's path: handles")
    expect(out).toContain("a changed file's path: names")
    printsNoTerm(out)
  })

  test("the branch's name holding a term fails, and the name is not printed", async () => {
    const { commit, dir } = repo()
    commit("docs/b.md", "More.\n", "docs: more")
    const refused = await listSince(dir, "canary", listPath, `fix-${LIST.handles[0]}-page`)
    expect(refused).toContain("the branch's name: handles")
    printsNoTerm(refused)
  })

  test("a clean pull request, a term already at the merge-base and no list pass", async () => {
    const { commit, dir } = repo()
    commit("docs/b.md", "More.\n", "docs: more")
    expect(await listSince(dir, "canary", listPath, "docs-more")).toBe("")
    const held = repo()
    held.commit("docs/a.md", `Plain text.\n${LIST.companies[0]} once.\n`, "docs: held")
    const { dir: later } = held
    Bun.spawnSync(["git", "branch", "-f", "canary", "HEAD"], { cwd: later })
    held.commit(
      "docs/a.md",
      `Plain text.\n${LIST.companies[0]} once.\nA new line.\n`,
      "docs: after",
    )
    expect(await listSince(later, "canary", listPath, "docs-after")).toBe("")
    expect(await listSince(dir, "canary", join(scratch, "none.json"), "x")).toBe("")
  })

  test("a list kind in a text is named by kind alone", () => {
    expect(listKindsIn(`ping ${LIST.handles[0]} at ${LIST.companies[0]}`, LIST)).toEqual([
      "companies",
      "handles",
    ])
    expect(listKindsIn("plain words", LIST)).toEqual([])
  })
})
