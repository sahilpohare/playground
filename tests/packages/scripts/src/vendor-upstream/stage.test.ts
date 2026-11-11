import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MARKER } from "../../../../../packages/safe-delete/src"
import {
  blobSha,
  diffSkills,
  download,
  manifestFor,
  manifestText,
  parseManifest,
  readTree,
  upstreamKeep,
  upstreamNamed,
  UPSTREAMS,
  vendored,
  vendor,
  type UpstreamFile,
} from "../../../../../packages/scripts/src/vendor-upstream/stage"

const bytes = (text: string) => new TextEncoder().encode(text)

// Upstream-shaped paths, the way the extracted tarball holds them: two kept skills, one skill core does not keep, a category README and the plugin manifest.
const UPSTREAM: UpstreamFile[] = [
  { path: ".claude-plugin/plugin.json", bytes: bytes('{"name":"skills"}\n') },
  { path: "LICENSE", bytes: bytes("MIT License\n") },
  { path: "skills/engineering/README.md", bytes: bytes("Engineering.\n") },
  { path: "skills/engineering/tdd/SKILL.md", bytes: bytes("---\nname: tdd\n---\n\nTdd.\n") },
  { path: "skills/engineering/triage/SKILL.md", bytes: bytes("---\nname: triage\n---\n") },
  {
    path: "skills/productivity/handoff/SKILL.md",
    bytes: bytes("---\nname: handoff\n---\n\nHandoff.\n"),
  },
]

// mattpocock's upstream under the test's own repo name, which the fake gh answers for.
const MATT = { ...upstreamNamed("mattpocock")!, repo: "upstream/skills" }

const kept = (): UpstreamFile[] =>
  vendored(
    MATT,
    UPSTREAM.filter(({ path }) => upstreamKeep(MATT, path)),
  )

const put = (dir: string, path: string, data: Uint8Array): void => {
  const dest = join(dir, path)
  mkdirSync(join(dest, ".."), { recursive: true })
  writeFileSync(dest, data)
}

// A core folder the way a later run finds it: our own skill, a kept skill with its CREDITS, a skill the new MANIFEST drops, and the old upstream/ files.
const coreOf = (root: string): string => {
  const core = join(root, "extensions", "core")
  put(core, "skills/pr/SKILL.md", bytes("---\nname: pr\n---\n\nOurs.\n"))
  put(core, "skills/tdd/SKILL.md", bytes("old\n"))
  put(core, "skills/tdd/CREDITS.md", bytes("Our credits.\n"))
  put(core, "skills/research/SKILL.md", bytes("old\n"))
  put(
    core,
    "upstream/mattpocock/MANIFEST",
    bytes(`${"0".repeat(40)} skills/research/SKILL.md\n${"0".repeat(40)} skills/tdd/SKILL.md\n`),
  )
  put(core, "upstream/mattpocock/SOURCE", bytes("stub\n"))
  return core
}

// The trash's roots on the test's own mkdtemp root: a HOME and a main checkout beside the core folder, the trash in the HOME's data folder.
const rootsOf = (root: string) => ({
  roots: {
    home: join(root, "home"),
    main: join(root, "main"),
    trash: join(root, "home", ".playground", "trash"),
  },
  session: "vendor-test",
})

// The staging folders a run left in core.
const staged = (core: string): string[] =>
  readdirSync(core).filter((name) => name.startsWith(".upstream-staging"))

const snapshot = (dir: string): string =>
  JSON.stringify(readTree(dir).map(({ path, bytes: data }) => [path, blobSha(data)]))

describe("blobSha", () => {
  test("matches the sha git stores for the same bytes", () => {
    expect(blobSha(bytes("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
    expect(blobSha(bytes("x"))).toBe("c1b0730e0133447badcfd47fd144e254807b06e1")
  })
})

describe("the manifest", () => {
  test("keeps the kept skills and LICENSE alone, flat under skills/ and upstream/, sorted by path", () => {
    expect(upstreamKeep(MATT, "skills/engineering/tdd/SKILL.md")).toBe(true)
    expect(upstreamKeep(MATT, "LICENSE")).toBe(true)
    expect(upstreamKeep(MATT, "skills/engineering/triage/SKILL.md")).toBe(false)
    expect(upstreamKeep(MATT, "skills/engineering/pr/SKILL.md")).toBe(false)
    expect(upstreamKeep(MATT, ".claude-plugin/plugin.json")).toBe(false)
    expect(upstreamKeep(MATT, "README.md")).toBe(false)
    const text = manifestFor([...kept()].reverse())
    expect(parseManifest(text).map(({ path }) => path)).toEqual([
      "skills/handoff/SKILL.md",
      "skills/tdd/SKILL.md",
      "upstream/mattpocock/LICENSE",
    ])
  })
})

describe("each upstream's paths", () => {
  test("graphify lands as its installer lays it out, impeccable from its Claude build, each license under upstream/<name>/", () => {
    const graphify = upstreamNamed("graphify")!
    expect(graphify.coreFor("graphify/skill.md")).toBe("skills/graphify/SKILL.md")
    expect(graphify.coreFor("graphify/skills/claude/references/query.md")).toBe(
      "skills/graphify/references/query.md",
    )
    expect(graphify.coreFor("graphify/skills/codex/references/query.md")).toBeNull()
    expect(graphify.coreFor("graphify/skill-codex.md")).toBeNull()
    expect(graphify.coreFor("LICENSE-MIT")).toBe("upstream/graphify/LICENSE-MIT")
    const impeccable = upstreamNamed("impeccable")!
    expect(impeccable.coreFor(".claude/skills/impeccable/scripts/context.mjs")).toBe(
      "skills/impeccable/scripts/context.mjs",
    )
    expect(impeccable.coreFor(".agents/skills/impeccable/SKILL.md")).toBeNull()
    expect(impeccable.coreFor("NOTICE.md")).toBe("upstream/impeccable/NOTICE.md")
    expect(impeccable.coreFor("README.md")).toBeNull()
    expect(UPSTREAMS.map(({ name }) => name)).toEqual(["graphify", "impeccable", "mattpocock"])
  })
})

describe("vendoring", () => {
  test("a matching tree swaps the kept skills in, keeps core's own files and CREDITS, and drops a skill no longer kept", () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-upstream-test-"))
    try {
      const core = coreOf(root)
      const files = kept()
      const manifest = manifestFor(files)
      expect(
        vendor({
          coreDir: core,
          files,
          manifest,
          name: "mattpocock",
          repo: "upstream/skills",
          sha: "a".repeat(40),
          ...rootsOf(root),
        }),
      ).toEqual({
        ok: true,
        files: 3,
      })
      expect(
        readTree(core)
          .map(({ path }) => path)
          .sort(),
      ).toEqual([
        "skills/handoff/SKILL.md",
        "skills/pr/SKILL.md",
        "skills/tdd/CREDITS.md",
        "skills/tdd/SKILL.md",
        "upstream/mattpocock/LICENSE",
        "upstream/mattpocock/MANIFEST",
        "upstream/mattpocock/SOURCE",
      ])
      expect(readFileSync(join(core, "skills/tdd/SKILL.md"), "utf8")).toBe(
        "---\nname: tdd\n---\n\nTdd.\n",
      )
      expect(readFileSync(join(core, "skills/tdd/CREDITS.md"), "utf8")).toBe("Our credits.\n")
      expect(readFileSync(join(core, "upstream/mattpocock/MANIFEST"), "utf8")).toBe(manifest)
      expect(readFileSync(join(core, "upstream/mattpocock/SOURCE"), "utf8")).toBe(
        `upstream/skills ${"a".repeat(40)}\n${new Date().toISOString().slice(0, 10)}\n`,
      )
      expect(staged(core)).toEqual([])
      expect(existsSync(join(core, ".upstream-replaced"))).toBe(false)
      const trash = join(root, "home", ".playground", "trash")
      const [batch] = readdirSync(trash)
      const replaced = join(trash, batch!, "1", ".upstream-replaced")
      expect(readFileSync(join(replaced, "skills", "tdd", "SKILL.md"), "utf8")).toBe("old\n")
      expect(readFileSync(join(replaced, "skills", "research", "SKILL.md"), "utf8")).toBe("old\n")
      expect(readFileSync(join(replaced, "upstream", "mattpocock", "SOURCE"), "utf8")).toBe(
        "stub\n",
      )
      // A second run over the same sha swaps the same bytes in again.
      expect(
        vendor({
          coreDir: core,
          files,
          manifest,
          name: "mattpocock",
          repo: "upstream/skills",
          sha: "a".repeat(40),
          ...rootsOf(root),
        }),
      ).toEqual({
        ok: true,
        files: 3,
      })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test("a core folder inside the main checkout is refused before anything moves", () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-upstream-test-"))
    try {
      const core = coreOf(join(root, "main"))
      const before = snapshot(core)
      const files = kept()
      expect(() =>
        vendor({
          coreDir: core,
          files,
          manifest: manifestFor(files),
          name: "mattpocock",
          repo: "upstream/skills",
          sha: "a".repeat(40),
          ...rootsOf(root),
        }),
      ).toThrow("main checkout")
      expect(snapshot(core)).toBe(before)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test("a MANIFEST path the files lack throws, leaves core as it was and takes its staging folder with it (#545)", () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-upstream-test-"))
    try {
      const core = coreOf(root)
      const before = snapshot(core)
      const entries = parseManifest(manifestFor(kept()))
      entries.push({ path: "skills/tdd/EXTRA.md", sha: "0".repeat(40) })
      expect(() =>
        vendor({
          coreDir: core,
          files: kept(),
          manifest: manifestText(entries),
          name: "mattpocock",
          repo: "upstream/skills",
          sha: "a".repeat(40),
          ...rootsOf(root),
        }),
      ).toThrow("MANIFEST names skills/tdd/EXTRA.md")
      expect(snapshot(core)).toBe(before)
      expect(staged(core)).toEqual([])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test("one changed byte fails and leaves core as it was", () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-upstream-test-"))
    try {
      const core = coreOf(root)
      const before = snapshot(core)
      const entries = parseManifest(manifestFor(kept()))
      const first = entries[0]!
      const real = first.sha
      first.sha = (first.sha.startsWith("a") ? "b" : "a") + first.sha.slice(1)
      const done = vendor({
        coreDir: core,
        files: kept(),
        manifest: manifestText(entries),
        name: "mattpocock",
        repo: "upstream/skills",
        sha: "a".repeat(40),
        ...rootsOf(root),
      })
      expect(done.ok).toBe(false)
      if (!done.ok)
        expect(done.mismatches).toEqual([
          `${first.path}: staged ${real}, MANIFEST says ${first.sha}`,
        ])
      expect(snapshot(core)).toBe(before)
      expect(staged(core)).toEqual([])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

describe("the download", () => {
  test("lands in a marked scratch folder, gone once it is read, and names a path the tree wants that the tarball lacks (#545)", async () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-upstream-test-"))
    try {
      for (const { path, bytes: data } of UPSTREAM)
        put(join(root, "src", "skills-main"), path, data)
      const tarball = join(root, "upstream.tgz")
      Bun.spawnSync(["tar", "-czf", tarball, "-C", join(root, "src"), "skills-main"])
      const tmp = join(root, "tmp")
      mkdirSync(tmp)
      const marked: boolean[] = []
      const wanted = [...UPSTREAM.map(({ path }) => path), "skills/engineering/tdd/EXTRA.md"]
      const gh = (...args: string[]): Buffer => {
        marked.push(readdirSync(tmp).some((name) => existsSync(join(tmp, name, MARKER))))
        return args[0]!.includes("/tarball/")
          ? readFileSync(tarball)
          : Buffer.from(JSON.stringify({ tree: wanted.map((path) => ({ path, type: "blob" })) }))
      }
      const { kept: got, missing } = await download(gh, MATT, "a".repeat(40), tmp)
      expect(got.map(({ path }) => path).sort()).toEqual(
        UPSTREAM.filter(({ path }) => upstreamKeep(MATT, path))
          .map(({ path }) => path)
          .sort(),
      )
      expect(missing).toEqual(["skills/engineering/tdd/EXTRA.md"])
      expect(marked).toEqual([true, true])
      expect(readdirSync(tmp)).toEqual([])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

describe("the skill diff", () => {
  test("names each skill added or removed", () => {
    const old = manifestText([
      { sha: "0".repeat(40), path: "skills/alpha/SKILL.md" },
      { sha: "0".repeat(40), path: "skills/gamma/SKILL.md" },
    ])
    const now = parseManifest(
      manifestText([
        { sha: "0".repeat(40), path: "skills/alpha/SKILL.md" },
        { sha: "0".repeat(40), path: "skills/delta/SKILL.md" },
        { sha: "0".repeat(40), path: "upstream/mattpocock/LICENSE" },
      ]),
    )
    expect(diffSkills(old, now)).toEqual(["added: delta", "removed: gamma"])
  })

  test("a first run reads every skill as added", () => {
    const now = parseManifest(manifestText([{ sha: "0".repeat(40), path: "skills/beta/SKILL.md" }]))
    expect(diffSkills(null, now)).toEqual(["added: beta"])
  })
})
