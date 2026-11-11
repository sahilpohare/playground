// Vendoring the upstream skills core keeps from their repo, byte for byte, into extensions/core/: this module holds the file work and no network, so the test drives it offline; cli.ts passes download its gh and calls the rest. The staged files are verified against MANIFEST before the swap, so a changed byte leaves core as it was.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { isProtected, makeScratch, removeScratch, type Roots } from "@packages/safe-delete"

import { toTrash } from "../trash"

export type UpstreamFile = { path: string; bytes: Uint8Array }
export type ManifestEntry = { sha: string; path: string }
export type Vendored = { ok: true; files: number } | { ok: false; mismatches: string[] }

// One repo core takes skills from: its own files (licenses, SOURCE, MANIFEST) live in upstream/<name>/, and coreFor maps each upstream path to the core path it lands at, relative to extensions/core/, or null for a path core does not take.
export type Upstream = {
  coreFor: (path: string) => string | null
  name: string
  ref: string
  repo: string
  skills: string[]
}

const licenseFor =
  (name: string, files: string[]) =>
  (path: string): string | null =>
    files.includes(path) ? `upstream/${name}/${path}` : null

const MATTPOCOCK_SKILLS = [
  "code-review",
  "codebase-design",
  "diagnosing-bugs",
  "domain-modeling",
  "handoff",
  "research",
  "tdd",
  "to-spec",
  "writing-for-agents",
]

// The upstreams core keeps skills from, and the skills in use from each; mattpocock's `pr` is core's own version, so upstream's is not taken.
export const UPSTREAMS: Upstream[] = [
  {
    // graphify's own installer writes skill.md as SKILL.md beside its claude references/
    coreFor: (path) =>
      path === "graphify/skill.md"
        ? "skills/graphify/SKILL.md"
        : path.startsWith("graphify/skills/claude/references/")
          ? path.replace("graphify/skills/claude/", "skills/graphify/")
          : licenseFor("graphify", ["LICENSE", "LICENSE-MIT", "NOTICE"])(path),
    name: "graphify",
    ref: "v8",
    repo: "Graphify-Labs/graphify",
    skills: ["graphify"],
  },
  {
    coreFor: (path) =>
      path.startsWith(".claude/skills/impeccable/")
        ? path.replace(".claude/", "")
        : licenseFor("impeccable", ["LICENSE", "NOTICE.md"])(path),
    name: "impeccable",
    ref: "main",
    repo: "pbakaus/impeccable",
    skills: ["impeccable"],
  },
  {
    coreFor: (path) => {
      const skill = /^skills\/[^/]+\/([^/]+)\//.exec(path)?.[1]
      return skill && MATTPOCOCK_SKILLS.includes(skill)
        ? path.replace(/^skills\/[^/]+\//, "skills/")
        : licenseFor("mattpocock", ["LICENSE"])(path)
    },
    name: "mattpocock",
    ref: "main",
    repo: "mattpocock/skills",
    skills: MATTPOCOCK_SKILLS,
  },
]

// Every upstream skill core keeps, the ones only vendor:upstream writes.
export const UPSTREAM_SKILLS = UPSTREAMS.flatMap(({ skills }) => skills).sort()

export const upstreamNamed = (name: string): Upstream | undefined =>
  UPSTREAMS.find((upstream) => upstream.name === name)

// The paths core takes from an upstream.
export const upstreamKeep = (upstream: Upstream, path: string): boolean =>
  upstream.coreFor(path) !== null

// Each kept file at its core path, so MANIFEST and every staged path are relative to extensions/core/.
export const vendored = (upstream: Upstream, files: UpstreamFile[]): UpstreamFile[] =>
  files.map(({ path, bytes }) => ({ path: upstream.coreFor(path)!, bytes }))

// A git blob sha, the same value git stores for the bytes.
export const blobSha = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha1")
  hasher.update(`blob ${bytes.byteLength}\0`)
  hasher.update(bytes)
  return hasher.digest("hex")
}

export const parseManifest = (text: string): ManifestEntry[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, 40), path: line.slice(41) }))

export const manifestText = (entries: ManifestEntry[]): string =>
  [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ sha, path }) => `${sha} ${path}`)
    .join("\n") + "\n"

export const manifestFor = (files: UpstreamFile[]): string =>
  manifestText(files.map(({ path, bytes }) => ({ path, sha: blobSha(bytes) })))

// The tree an extracted tarball holds, as paths relative to its root.
export const readTree = (dir: string): UpstreamFile[] => {
  const files: UpstreamFile[] = []
  const walk = (sub: string): void => {
    const entries = readdirSync(join(dir, sub), { withFileTypes: true })
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const { name, dir: isDir } of entries) {
      const rel = sub ? `${sub}/${name}` : name
      if (isDir) walk(rel)
      else files.push({ path: rel, bytes: readFileSync(join(dir, rel)) })
    }
  }
  walk("")
  return files
}

// A GitHub codeload tarball sits in one folder named for the sha; strip it, so destDir is the repo root.
export const extractTarball = (tarPath: string, destDir: string): void => {
  mkdirSync(destDir, { recursive: true })
  const tar = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", destDir, "--strip-components=1"], {
    stderr: "pipe",
  })
  if (tar.exitCode !== 0) throw new Error(`tar -xzf failed: ${tar.stderr.toString().trim()}`)
}

const SKILL = /^skills\/([^/]+)\/SKILL\.md$/

const skillsIn = (entries: ManifestEntry[]): Set<string> =>
  new Set(entries.flatMap(({ path }) => SKILL.exec(path)?.[1] ?? []))

// Each skill added or removed since the old MANIFEST; a skill is its SKILL.md folder.
export const diffSkills = (oldText: string | null, entries: ManifestEntry[]): string[] => {
  const was = skillsIn(oldText === null ? [] : parseManifest(oldText))
  const now = skillsIn(entries)
  return [
    ...[...now]
      .filter((name) => !was.has(name))
      .sort()
      .map((name) => `added: ${name}`),
    ...[...was]
      .filter((name) => !now.has(name))
      .sort()
      .map((name) => `removed: ${name}`),
  ]
}

// Downloads sha's tarball through gh into a scratch folder of its own, since a download is untrusted data, and hands back the kept files with each kept path the tree lists that the tarball lacks; the folder goes once they are read.
export const download = async (
  gh: (...args: string[]) => Buffer,
  upstream: Upstream,
  sha: string,
  tmp = tmpdir(),
): Promise<{ kept: UpstreamFile[]; missing: string[] }> => {
  const scratch = makeScratch("vendor-upstream-", tmp)
  try {
    const tarball = join(scratch, "tarball.tgz")
    await Bun.write(tarball, gh(`repos/${upstream.repo}/tarball/${sha}`))
    const extracted = join(scratch, "upstream")
    extractTarball(tarball, extracted)
    const tree = JSON.parse(
      gh(`repos/${upstream.repo}/git/trees/${sha}?recursive=1`).toString(),
    ) as { tree: { path: string; type: string }[] }
    const kept = readTree(extracted).filter(({ path }) => upstreamKeep(upstream, path))
    const missing = tree.tree
      .filter((entry) => entry.type === "blob" && upstreamKeep(upstream, entry.path))
      .map((entry) => entry.path)
      .filter((path) => !kept.some(({ path: got }) => got === path))
    return { kept, missing }
  } finally {
    const refused = removeScratch(scratch, tmp)
    if (refused) console.error(`vendor:upstream: ${refused}`)
  }
}

// Drops the staging folder, a scratch folder in core, or leaves it and says why.
const dropStaging = (staging: string, coreDir: string) => {
  const refused = removeScratch(staging, coreDir)
  if (refused) console.error(`vendor:upstream: ${refused}`)
}

const REPLACED = ".upstream-replaced"

// Stages one upstream's files in core, writes its upstream/<name>/SOURCE and MANIFEST, and swaps each of its skill folders and its upstream/<name>/ in only when every staged byte matches its manifest sha; a skill's CREDITS.md, which is core's, stays, a skill the old MANIFEST held and the new one does not leaves, and a mismatch leaves core as it was; the staging folder goes however the run ends. Each folder it replaces is moved into one REPLACED folder that goes to the trash whole, so a run is one quarantine under the tripwire's 3 a minute, and a refusal throws its text. It never commits.
export const vendor = ({
  coreDir,
  files,
  manifest,
  name,
  repo,
  roots,
  session,
  sha,
}: {
  coreDir: string
  files: UpstreamFile[]
  manifest: string
  name: string
  repo: string
  roots: Roots
  session: string
  sha: string
}): Vendored => {
  const own = join("upstream", name)
  const entries = parseManifest(manifest)
  const bytesOf = new Map(files.map(({ path, bytes }) => [path, bytes]))
  const protectedWhy = isProtected(join(coreDir, REPLACED), roots)
  if (protectedWhy) throw new Error(protectedWhy)
  const staging = makeScratch(".upstream-staging-", coreDir)
  try {
    for (const { path } of entries) {
      const dest = join(staging, path)
      mkdirSync(dirname(dest), { recursive: true })
      const bytes = bytesOf.get(path)
      if (bytes === undefined)
        throw new Error(`vendor: MANIFEST names ${path}, which the downloaded tree does not hold`)
      writeFileSync(dest, bytes)
    }
    mkdirSync(join(staging, own), { recursive: true })
    writeFileSync(
      join(staging, own, "SOURCE"),
      `${repo} ${sha}\n${new Date().toISOString().slice(0, 10)}\n`,
    )
    writeFileSync(join(staging, own, "MANIFEST"), manifest)
    const mismatches = entries.flatMap(({ path, sha: wanted }) => {
      const got = blobSha(readFileSync(join(staging, path)))
      return got === wanted ? [] : [`${path}: staged ${got}, MANIFEST says ${wanted}`]
    })
    if (mismatches.length > 0) return { ok: false, mismatches }
    const oldManifest = join(coreDir, own, "MANIFEST")
    const was = existsSync(oldManifest)
      ? skillsIn(parseManifest(readFileSync(oldManifest, "utf8")))
      : new Set<string>()
    const now = skillsIn(entries)
    const replaced = join(coreDir, REPLACED)
    const reason = "vendor:upstream replaced it"
    toTrash(replaced, reason, roots, session)
    const moveAside = (from: string, to: string) => {
      if (!existsSync(from)) return
      mkdirSync(dirname(join(replaced, to)), { recursive: true })
      renameSync(from, join(replaced, to))
    }
    for (const name of new Set([...was, ...now])) {
      const live = join(coreDir, "skills", name)
      const credits = join(live, "CREDITS.md")
      const kept = existsSync(credits) ? readFileSync(credits) : null
      moveAside(live, join("skills", name))
      if (!now.has(name)) continue
      mkdirSync(dirname(live), { recursive: true })
      renameSync(join(staging, "skills", name), live)
      if (kept) writeFileSync(credits, kept)
    }
    moveAside(join(coreDir, own), own)
    mkdirSync(join(coreDir, "upstream"), { recursive: true })
    renameSync(join(staging, own), join(coreDir, own))
    try {
      toTrash(replaced, reason, roots, session)
    } catch (error) {
      throw new Error(
        `${(error as Error).message}; the replaced folders stay in ${replaced}, which the next run moves to the trash first`,
      )
    }
    return { ok: true, files: entries.length }
  } finally {
    dropStaging(staging, coreDir)
  }
}
