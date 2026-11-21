// bun run docs:wrap: writes the shared docs one sentence per line, proves the rendered text unchanged, and with --check is the guard.
import { join } from "node:path"
import { parseArgs } from "node:util"

import { LIMIT, overLimit, wrap } from "./wrap"

const USAGE = `Usage: bun run docs:wrap [--check | --proof <ref>]

Writes the shared docs one sentence per line, a sentence over ${LIMIT} characters broken at a clause.

  (no option)     rewraps every file, refusing one whose characters or rendered text would change
  --check         exits 1 naming each line over ${LIMIT} characters and each file a rewrap would change
  --proof <ref>   compares each file with its copy at <ref>: same characters but whitespace, same rendered text

Every mode fails when a pattern in PATTERNS matches no file, naming it.`

const ROOT = join(import.meta.dir, "../../../..")

// The docs held to one sentence per line. CLAUDE.md is a link to AGENTS.md, so it is read once.
export const PATTERNS = [
  ".agents/dashboard/*.md",
  ".agents/shipping.md",
  ".agents/skill-trial.md",
  ".agents/testing.md",
  "AGENTS.md",
  "docs/playground/*.md",
  "scripts/README.md",
  "scripts/hooks/README.md",
  "extensions/core/skills/playbook/*.md",
  "web/next/content/docs/dashboard.mdx",
]

// Each pattern with the files it matches, so a pattern a rename left matching nothing can be named.
async function matches(root: string): Promise<[string, string[]][]> {
  const all: [string, string[]][] = []
  for (const pattern of PATTERNS)
    all.push([pattern, (await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }))).sort()])
  return all
}

export async function files(root = ROOT): Promise<string[]> {
  return (await matches(root)).flatMap(([, paths]) => paths)
}

type Stats = { lines: number; longest: number; over: number }

const statsOf = (text: string): Stats => {
  const over = overLimit(text, 0)
  return {
    lines: text.split("\n").length,
    longest: Math.max(0, ...over.map((o) => o.length)),
    over: over.filter((o) => o.length > LIMIT).length,
  }
}

const sum = (all: Stats[]): Stats => ({
  lines: all.reduce((n, s) => n + s.lines, 0),
  longest: Math.max(0, ...all.map((s) => s.longest)),
  over: all.reduce((n, s) => n + s.over, 0),
})

const line = (label: string, s: Stats) =>
  `${label}: ${s.lines} lines, ${s.over} prose lines over ${LIMIT}, longest prose line ${s.longest}`

async function resolves(root: string, ref: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    {
      stderr: "ignore",
      stdout: "ignore",
    },
  )
  return (await proc.exited) === 0
}

async function show(root: string, ref: string, path: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "-C", root, "show", `${ref}:${path}`], {
    stderr: "ignore",
    stdout: "pipe",
  })
  const text = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? text : undefined
}

export async function run(argv: string[], root = ROOT, print = console.log): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean" },
      help: { short: "h", type: "boolean" },
      proof: { type: "string" },
    },
  })
  const ref = values.proof
  const proving = ref !== undefined
  if (values.help || (values.check && proving)) {
    print(USAGE)
    return values.help ? 0 : 2
  }
  if (proving && !(await resolves(root, ref))) {
    print(`--proof: ${ref} does not resolve to a commit`)
    return 1
  }
  const found = await matches(root)
  const empty = found.filter(([, paths]) => !paths.length).map(([pattern]) => pattern)
  for (const pattern of empty)
    print(
      `${pattern} matches no file: name the doc's new path in PATTERNS in packages/scripts/src/docs-wrap/cli.ts`,
    )
  if (empty.length) return 1
  const paths = found.flatMap(([, matched]) => matched)
  const failures: string[] = []
  const before: Stats[] = []
  const after: Stats[] = []
  for (const path of paths) {
    const current = await Bun.file(join(root, path)).text()
    const mdx = path.endsWith(".mdx")
    if (values.check) {
      for (const o of overLimit(current))
        failures.push(`${path}:${o.line} is ${o.length} characters`)
      if (wrap(current) !== current) failures.push(`${path} holds a line of more than one sentence`)
      continue
    }
    const old = proving ? await show(root, ref, path) : current
    const next = proving ? current : wrap(current)
    if (old === undefined) {
      print(`${path}: not at ${ref}, left out`)
      continue
    }
    const { differs } = await import("./proof")
    const why = differs(old, next, mdx)
    if (why) {
      failures.push(`${path}: ${why}`)
      continue
    }
    before.push(statsOf(old))
    after.push(statsOf(next))
    if (!proving && next !== current) await Bun.write(join(root, path), next)
  }
  if (values.check) {
    for (const f of failures) print(f)
    if (failures.length)
      print(
        `one sentence per line: run \`bun run docs:wrap\`, then break any line still over ${LIMIT} at a clause`,
      )
    return failures.length ? 1 : 0
  }
  print(
    `${proving ? `proof against ${ref}` : "rewrapped"}: ${before.length} files, same characters but whitespace and same rendered text`,
  )
  print(line(proving ? "  at the ref" : "  before", sum(before)))
  print(line(proving ? "  now" : "  after", sum(after)))
  for (const f of failures) print(`refused ${f}`)
  if (proving && !before.length && !failures.length) {
    print(`--proof: no file compared against ${ref}`)
    return 1
  }
  return failures.length ? 1 : 0
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))
