import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { makeScratch, removeScratch } from "@packages/safe-delete"

// The Agent Skills reference validator, pinned to one commit of agentskills/agentskills and run through uv, over every skill core and the buckets ship. The keys Claude Code reads beside the spec's are dropped from a copy of each SKILL.md first, so any other key fails as the spec has it.
export const PIN =
  "skills-ref @ git+https://github.com/agentskills/agentskills@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref"

export const CLAUDE_CODE_KEYS = [
  "argument-hint",
  "background",
  "context",
  "disable-model-invocation",
  "disallowed-tools",
  "hooks",
  "user-invocable",
]

// Upstream's own keys on the skills synced or vendored from it, which a local edit would lose at the next sync: ZeroStarter's bucket, and impeccable in core.
export const UPSTREAM_KEYS: [RegExp, string[]][] = [
  [/^extensions\/core\/skills\/impeccable\//, ["version"]],
  [/^skills\/zerostarter\//, ["files", "hidden", "source"]],
]

export const GLOBS = ["extensions/core/skills/*/SKILL.md", "skills/*/*/SKILL.md"]

// A SKILL.md with each Claude Code key, and the lines nested under it, out of its frontmatter, and with the upstream keys its path carries.
export const specOnly = (text: string, path = ""): string => {
  const dropped = [
    ...CLAUDE_CODE_KEYS,
    ...UPSTREAM_KEYS.flatMap(([re, keys]) => (re.test(path) ? keys : [])),
  ]
  const match = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text)
  if (!match) return text
  let dropping = false
  const kept = match[1]!.split("\n").filter((line) => {
    const key = /^([A-Za-z][\w-]*):/.exec(line)?.[1]
    if (key !== undefined) dropping = dropped.includes(key)
    return !dropping
  })
  return `---\n${kept.join("\n")}\n---${match[2]}${text.slice(match[0].length)}`
}

const UV = ["uv", "run", "--quiet", "--python", "3.13", "--with", PIN]
const said = (run: { stderr: Buffer; stdout: Buffer }) =>
  `${run.stdout}${run.stderr}`.trim().split("\n").join(" ")

// One fetch of the pin per run, from uv's cache when the package index is down, so every skill after it validates offline; undefined once skills-ref is in the cache.
const resolve = (): string | undefined => {
  const help = ["skills-ref", "validate", "--help"]
  const online = Bun.spawnSync([...UV, ...help], { stderr: "pipe", stdout: "pipe" })
  if (online.exitCode === 0) return
  const cached = Bun.spawnSync([...UV, "--offline", ...help], { stderr: "pipe", stdout: "pipe" })
  if (cached.exitCode === 0) {
    console.error(
      `skills-ref: the package index is out of reach, so each skill validates from uv's cache: ${said(online)}`,
    )
    return
  }
  return `skills-ref: uv found skills-ref's packages neither on the package index nor in its cache: ${said(online)}`
}

if (import.meta.main) {
  const unresolved = resolve()
  if (unresolved) {
    console.log(unresolved)
    process.exit(1)
  }
  const root = join(import.meta.dir, "..", "..", "..", "..")
  const scratch = makeScratch("skills-ref-")
  const failed: string[] = []
  try {
    const files = GLOBS.flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: root })]).sort()
    for (const file of files) {
      const copy = join(scratch, dirname(file))
      mkdirSync(copy, { recursive: true })
      await Bun.write(
        join(copy, "SKILL.md"),
        specOnly(await Bun.file(join(root, file)).text(), file),
      )
      const run = Bun.spawnSync([...UV, "--offline", "skills-ref", "validate", copy], {
        stderr: "pipe",
        stdout: "pipe",
      })
      if (run.exitCode === 0) continue
      failed.push(`FAIL ${dirname(file)}: ${said(run)}`)
    }
    for (const line of failed) console.log(line)
    console.log(
      `${files.length - failed.length} of ${files.length} skills pass skills-ref validate`,
    )
  } finally {
    const refused = removeScratch(scratch)
    if (refused) console.error(`skills-ref: ${refused}`)
  }
  process.exit(failed.length ? 1 : 0)
}
