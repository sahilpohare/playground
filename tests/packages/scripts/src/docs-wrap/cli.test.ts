import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { files, PATTERNS, run } from "../../../../../packages/scripts/src/docs-wrap/cli"

const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-wrap-"))
  // A file for every pattern, since a pattern that matches nothing fails the run.
  for (const pattern of PATTERNS) {
    const path = join(dir, pattern.replace("*", "a"))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "One.\n")
  }
  writeFileSync(join(dir, ".agents/dashboard/a.md"), "- One. Two.\n")
  writeFileSync(join(dir, "AGENTS.md"), "# A\n\nThree. Four.\n")
  return dir
}

const git = (dir: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args])

// A repository whose one commit holds README.md alone, so no doc of the list is at HEAD.
const repo = () => {
  const dir = root()
  writeFileSync(join(dir, "README.md"), "One.\n")
  git(dir, "init", "-q")
  git(dir, "add", "README.md")
  git(dir, "commit", "-qm", "init")
  return dir
}

const runIn = async (dir: string, argv: string[]) => {
  const out: string[] = []
  const code = await run(argv, dir, (s) => out.push(s))
  return { code, out: out.join("\n") }
}

describe("docs:wrap", () => {
  test("--check fails on a line of two sentences and names the fix", async () => {
    const { code, out } = await runIn(root(), ["--check"])
    expect(code).toBe(1)
    expect(out).toContain(".agents/dashboard/a.md holds a line of more than one sentence")
    expect(out).toContain("bun run docs:wrap")
  })

  test("a rewrap writes one sentence per line, after which --check passes", async () => {
    const dir = root()
    expect((await runIn(dir, [])).code).toBe(0)
    expect(readFileSync(join(dir, ".agents/dashboard/a.md"), "utf8")).toBe("- One.\n  Two.\n")
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# A\n\nThree.\nFour.\n")
    expect((await runIn(dir, ["--check"])).code).toBe(0)
  })

  test("--check fails on a prose line over the limit", async () => {
    const dir = root()
    writeFileSync(join(dir, "AGENTS.md"), `${"word ".repeat(100)}end\n`)
    const { code, out } = await runIn(dir, ["--check"])
    expect(code).toBe(1)
    expect(out).toContain("AGENTS.md:1 is 503 characters")
  })

  test("reads only the files it names", async () => {
    const dir = root()
    writeFileSync(join(dir, "README.md"), "One. Two.\n")
    writeFileSync(join(dir, "docs/playground/pr.md"), "One.\n")
    expect(await files(dir)).toEqual([
      ".agents/dashboard/a.md",
      ".agents/shipping.md",
      ".agents/skill-trial.md",
      ".agents/testing.md",
      "AGENTS.md",
      "docs/playground/a.md",
      "docs/playground/pr.md",
      "scripts/README.md",
      "scripts/hooks/README.md",
      "extensions/core/skills/playbook/a.md",
      "web/next/content/docs/dashboard.mdx",
    ])
  })

  test("--proof refuses a ref git cannot resolve", async () => {
    const { code, out } = await runIn(repo(), ["--proof", "origin/no-such-ref"])
    expect(code).toBe(1)
    expect(out).toContain("--proof: origin/no-such-ref does not resolve to a commit")
  })

  test("--proof refuses a run that compares no file", async () => {
    const { code, out } = await runIn(repo(), ["--proof", "HEAD"])
    expect(code).toBe(1)
    expect(out).toContain("--proof: no file compared against HEAD")
  })

  test("every mode fails naming a pattern that matches no file, and writes nothing", async () => {
    for (const argv of [["--check"], [], ["--proof", "HEAD"]]) {
      const dir = repo()
      rmSync(join(dir, "web/next/content/docs/dashboard.mdx"))
      const { code, out } = await runIn(dir, argv)
      expect(code).toBe(1)
      expect(out).toContain("web/next/content/docs/dashboard.mdx matches no file")
      expect(readFileSync(join(dir, ".agents/dashboard/a.md"), "utf8")).toBe("- One. Two.\n")
    }
  })

  test('--proof "" checks its ref rather than rewrapping in place', async () => {
    const dir = repo()
    const { code, out } = await runIn(dir, ["--proof", ""])
    expect(code).toBe(1)
    expect(out).toContain("does not resolve to a commit")
    expect(readFileSync(join(dir, ".agents/dashboard/a.md"), "utf8")).toBe("- One. Two.\n")
  })
})
