import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..")

// AGENTS.md plus every file it imports, in chars: what every session loads before its first turn, set at 32,935 plus 5% after #1473's trim, the skills tables moved out.
const BUDGET = 34_600

// The test goes red at this share of BUDGET, which keeps 3% of it free for PRs that pass alone and merge together.
const MARGIN = 0.97

// Every ALWAYS rule by its first five words: each keeps its line in AGENTS.md, so it loads into every session, while a dashboard rule's full text stays in its topic file.
const ALWAYS = [
  "Do every change in its",
  "Settle a new or altered",
  "Point local database work at",
  "Keep documentation in sync with",
  "When code, a convention, a",
  "Make the smallest change that",
  "Use `@/` for imports, if",
  "Put every test under the",
  "Put a new build or",
  "TypeScript under Bun for every",
  "Prefer a Bun-native API when",
  "Keep enumerable lists alphabetical (A→Z),",
  "Version every root `catalog` entry",
  "Follow the `design` skill for",
  "For any frontend or UI",
  "Write repo text (docs, skills,",
  "Call the Skill tool with",
  "Land everything you learn in",
  "Track Playground's work as GitHub",
  "Keep app copy generic, so anyone",
  "In every comment and review",
  "File a new Linear ticket",
  "Keep Playground out of every",
  "Send every link in a",
  "Load [playbook](./extensions/core/skills/playbook/SKILL.md) when you are",
  "Signal only processes you started;",
  "Start it (`bun run dev`)",
  "Serve first run's setup with",
  "A person's stack reads their",
  "Keep it on loopback: the",
  "Stop `bun run dev` before",
  "Keep the dashboard on the",
  "Keep the `claude_*` tables (`packages/db/src/schema/claude.ts`:",
  "Read an organisation's own values",
  "Route every herdr call through",
  "Count a session record as",
  "Run the System panel's commands",
  "Send anything to a session",
  "Send a herdr session (herdr.md)",
  "Reach the session the dashboard",
  "Keep a message's files in",
  "Render text from a session's",
  "Send a message from the",
  "Guard every dashboard write with",
  "Test a dashboard write on",
  "Verify dashboard work with `bun",
  "Keep the dashboard map current.",
]

// An import as AGENTS.md writes one: a line that is only `@` and a path, read relative to the file that holds it, outside a code fence.
const importsOf = (text: string): string[] => {
  let fenced = false
  return text.split("\n").flatMap((line) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced
    const path = !fenced && /^@(\S+)$/.exec(line)?.[1]
    return path ? [path] : []
  })
}

// AGENTS.md and every file it imports, its imports' imports included, as Claude Code loads them.
async function loaded(file: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(file)) return []
  seen.add(file)
  const text = await Bun.file(file).text()
  const nested = await Promise.all(
    importsOf(text).map((path) => loaded(join(dirname(file), path), seen)),
  )
  return [text, ...nested.flat()]
}

describe("AGENTS.md", () => {
  test("every @ import resolves to a file", async () => {
    const missing: string[] = []
    for (const path of importsOf(await Bun.file(join(ROOT, "AGENTS.md")).text()))
      if (!(await Bun.file(join(ROOT, path)).exists())) missing.push(path)
    expect(missing).toEqual([])
  })

  // A topic file holds dashboard rules with no ALWAYS line too, so each is reached by a pointer naming when to read it.
  test("every dashboard topic file is reached by a pointer", async () => {
    const text = await Bun.file(join(ROOT, "AGENTS.md")).text()
    const topics = [...new Bun.Glob(".agents/dashboard/*.md").scanSync({ cwd: ROOT, dot: true })]
    expect(topics.length).toBeGreaterThan(0)
    expect(
      topics.filter((file) => !text.includes(`read \`${file}\` before you change`)).sort(),
    ).toEqual([])
  })

  test("every ALWAYS rule keeps its line in AGENTS.md", async () => {
    const text = await Bun.file(join(ROOT, "AGENTS.md")).text()
    const topics = [...new Bun.Glob(".agents/dashboard/*.md").scanSync({ cwd: ROOT, dot: true })]
    const dashboard = await Promise.all(topics.map((file) => Bun.file(join(ROOT, file)).text()))
    const heads = dashboard.flatMap((topic) =>
      [...topic.matchAll(/^- ALWAYS: (\S+(?: \S+){0,4})/gm)].map((match) => match[1]),
    )
    expect(
      [...new Set([...ALWAYS, ...heads])].filter((head) => !text.includes(`- ALWAYS: ${head}`)),
    ).toEqual([])
  })

  // A dashboard rule's line in AGENTS.md sits under its topic's pointer, indented or not, until the next heading, and that topic file still holds the rule whole.
  test("every dashboard ALWAYS line opens a rule its topic file holds", async () => {
    const lost: string[] = []
    let topic = ""
    for (const line of (await Bun.file(join(ROOT, "AGENTS.md")).text()).split("\n")) {
      if (line.startsWith("#")) topic = ""
      topic = /read `(\.agents\/dashboard\/[^`]+)` before you change/.exec(line)?.[1] ?? topic
      const head = /^\s*- ALWAYS: (\S+(?: \S+){0,4})/.exec(line)?.[1]
      if (!head || !topic) continue
      if (!(await Bun.file(join(ROOT, topic)).text()).includes(`- ALWAYS: ${head}`))
        lost.push(`${topic}: ${head}`)
    }
    expect(lost).toEqual([])
  })

  test("AGENTS.md and its imports load under MARGIN of BUDGET chars", async () => {
    const size = (await loaded(join(ROOT, "AGENTS.md"))).join("").length
    const limit = Math.floor(BUDGET * MARGIN)
    const topics = [".agents/*.md", ".agents/dashboard/*.md"]
      .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })])
      .sort()
    expect(
      size < limit
        ? ""
        : `AGENTS.md and its imports load ${size} chars, at or over ${limit}, ${MARGIN * 100}% of BUDGET ${BUDGET}: move reference out of AGENTS.md into the topic file it belongs to (${topics.join(", ")}), leaving a pointer`,
    ).toBe("")
  })

  test("every hook .claude/settings.json registers is named in AGENTS.md (#2242)", async () => {
    const settings = await Bun.file(join(ROOT, ".claude/settings.json")).text()
    const hooks = [
      ...new Set(
        [...settings.matchAll(/scripts\/hooks\/(?:bundled\/)?([a-z0-9-]+)\.[jt]s/g)].map(
          (m) => m[1],
        ),
      ),
    ]
    const agents = await Bun.file(join(ROOT, "AGENTS.md")).text()
    expect(hooks.length).toBeGreaterThan(10)
    expect(hooks).toContain("guards")
    expect(hooks.filter((hook) => !agents.includes(`\`${hook}\``))).toEqual([])
  })

  test("Shipping step 1 settles docs, skills and the body before the review's round 1 (#2205)", async () => {
    expect(await Bun.file(join(ROOT, "AGENTS.md")).text()).toContain(
      "settle in your own pass what a round should never spend its turn on",
    )
  })

  test("the tracking rule files an org's or a person's work in that extension's repo (PG-83)", async () => {
    const text = await Bun.file(join(ROOT, "AGENTS.md")).text()
    const lines = text.split("\n")
    const at = lines.findIndex((l) => l.includes("Track Playground's work as GitHub issues"))
    expect(at).toBeGreaterThan(-1)
    const line = `${lines[at]}\n${lines[at + 1]}`
    expect(line).toContain(
      "The repo tracks the factory's own work alone, since an org's work goes in that org's extension repo and a person's in their login extension",
    )
    expect(line).toContain("[ADR 0016]")
  })

  test("CLAUDE.md is AGENTS.md, so both load the same rules", async () => {
    expect(await Bun.file(join(ROOT, "CLAUDE.md")).text()).toBe(
      await Bun.file(join(ROOT, "AGENTS.md")).text(),
    )
  })

  test("a canary merge runs the changed-term grep for what the incoming commits changed, with its measured case", async () => {
    const lines = (await Bun.file(join(ROOT, "AGENTS.md")).text()).split("\n")
    const at = lines.findIndex((l) => l.includes("After you merge `canary` into the branch"))
    const line = `${lines[at]}\n${lines[at + 1]}`
    expect(
      lines.filter((l) => l.includes("After you merge `canary` into the branch")),
    ).toHaveLength(1)
    expect(lines[at - 1]).toContain(
      "run the changed-term grep for each term whose meaning the diff changes",
    )
    expect(line).toContain("`git log -p HEAD^1..HEAD^2` while the merge commit is `HEAD`")
    expect(line).toContain("the PR's own changed docs")
    expect(line).toContain("before you ask for the next round")
    expect(line).toContain("two docs-only rounds")
    expect(line).toContain(
      "done when no line of the PR's docs describes a meaning those commits changed",
    )
  })
})
