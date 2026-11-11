import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  blobSha,
  parseManifest,
  UPSTREAM_SKILLS,
  UPSTREAMS,
} from "../../../../packages/scripts/src/vendor-upstream/stage"

// The upstream skills core keeps are upstream's bytes, held to MANIFEST offline: this test reads core alone, so a changed byte, a stray file, or a rewritten skill fails without a network call.
const CORE = join(import.meta.dir, "..", "..", "..", "..", "extensions", "core")

const manifestOf = (name: string) =>
  parseManifest(readFileSync(join(CORE, "upstream", name, "MANIFEST"), "utf8"))
const manifest = UPSTREAMS.flatMap(({ name }) => manifestOf(name))
const manifestPaths = manifest.map(({ path }) => path)

const walk = (dir: string, sub = ""): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...walk(dir, rel))
    else if (entry.isFile()) found.push(rel)
  }
  return found
}

const frontmatterName = (text: string): string | null => {
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") return null
  const end = lines.indexOf("---", 1)
  if (end === -1) return null
  return /^name:\s*(.+?)\s*$/m.exec(lines.slice(1, end).join("\n"))?.[1] ?? null
}

describe("the upstream skills in core", () => {
  test("every MANIFEST path exists and holds the bytes its sha names", () => {
    expect(manifestPaths.length).toBeGreaterThan(0)
    const broken = manifest.flatMap(({ path, sha }) => {
      const file = join(CORE, path)
      if (!existsSync(file)) return [`${path}: missing`]
      const got = blobSha(readFileSync(file))
      return got === sha ? [] : [`${path}: holds ${got}, MANIFEST says ${sha}`]
    })
    expect(broken).toEqual([])
  })

  test("each kept skill's folder holds MANIFEST's paths and core's CREDITS.md, nothing more", () => {
    const extra = UPSTREAM_SKILLS.flatMap((name) =>
      walk(join(CORE, "skills", name))
        .map((path) => `skills/${name}/${path}`)
        .filter((path) => !manifestPaths.includes(path) && path !== `skills/${name}/CREDITS.md`),
    )
    expect(extra).toEqual([])
  })

  test("the MANIFESTs hold the kept skills, each named by its frontmatter, and the NOTICE names them with core's pr", () => {
    const skills = manifestPaths.filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    expect(skills.map((path) => path.split("/")[1]).sort()).toEqual([...UPSTREAM_SKILLS].sort())
    const renamed = skills.flatMap((path) => {
      const name = frontmatterName(readFileSync(join(CORE, path), "utf8"))
      const folder = path.split("/")[1]
      return name === folder ? [] : [`${path}: frontmatter names ${name}, folder is ${folder}`]
    })
    expect(renamed).toEqual([])
    const notice = readFileSync(join(CORE, "NOTICE"), "utf8")
    for (const name of [...UPSTREAM_SKILLS, "pr"]) expect(notice).toContain(name)
    expect([...UPSTREAM_SKILLS, "pr"]).toHaveLength(12)
  })

  // tdd calls codebase-design, which only the user scope carried, so a session without that copy found no skill (PG-167)
  test("every skill a core skill calls by name is a core skill", () => {
    const called = readdirSync(join(CORE, "skills")).flatMap((name) => {
      const file = join(CORE, "skills", name, "SKILL.md")
      if (!existsSync(file)) return []
      return [...readFileSync(file, "utf8").matchAll(/Skill tool with "([a-z0-9-]+)"/g)].map(
        ([, skill]) => `${name} -> ${skill}`,
      )
    })
    expect(called.length).toBeGreaterThan(0)
    expect(
      called.filter(
        (call) => !existsSync(join(CORE, "skills", call.split(" -> ")[1]!, "SKILL.md")),
      ),
    ).toEqual([])
  })

  test("each upstream's license travels with its bytes, the NOTICE names its repo, its SOURCE its sha, and each skill's CREDITS its license", () => {
    const licenses: Record<string, string> = {
      graphify: "Apache License",
      impeccable: "Apache License",
      mattpocock: "MIT License",
    }
    expect(Object.keys(licenses).sort()).toEqual(UPSTREAMS.map(({ name }) => name).sort())
    const notice = readFileSync(join(CORE, "NOTICE"), "utf8")
    for (const { name, repo, skills } of UPSTREAMS) {
      const license = readFileSync(join(CORE, "upstream", name, "LICENSE"), "utf8")
      expect(license).toContain(licenses[name]!)
      expect(notice).toContain(repo)
      const source = readFileSync(join(CORE, "upstream", name, "SOURCE"), "utf8").split("\n")
      expect(source[0]).toBe(`${repo} ${source[0]!.split(" ")[1]}`)
      expect(source[0]).toMatch(/^[\w.-]+\/[\w.-]+ [0-9a-f]{40}$/)
      expect(source[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const skill of skills)
        expect(readFileSync(join(CORE, "skills", skill, "CREDITS.md"), "utf8")).toContain(
          licenses[name]!,
        )
    }
    const mit = readFileSync(join(CORE, "upstream", "mattpocock", "LICENSE"), "utf8")
    expect(notice).toContain(/^Copyright \(c\) .+$/m.exec(mit)?.[0] ?? "missing")
  })
})
