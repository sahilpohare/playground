import { expect, test } from "bun:test"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../..")
const read = (path: string) => Bun.file(join(ROOT, path)).text()

// the one line of each audit gate that runs the audit: a PR's, canary's, a direct push's and local CI's
const gates = async () => {
  const lines: Record<string, string> = {
    "audit-canary.yml": (await read(".github/workflows/audit-canary.yml"))
      .split("\n")
      .find((l) => l.includes("audit-canary.ts"))!,
    "auto-check-build.yml": (await read(".github/workflows/auto-check-build.yml"))
      .split("\n")
      .find((l) => l.includes("src/audit.ts"))!,
    "lefthook.yml": (await read("lefthook.yml")).split("\n").find((l) => l.includes("bun audit"))!,
    "suite.sh": (await read("scripts/ops/runner-host/suite.sh"))
      .split("\n")
      .find((l) => l.startsWith("step audit"))!,
  }
  return Object.entries(lines)
}

const ignores = (line: string) => [...line.matchAll(/--ignore (\S+)/g)].map((m) => m[1]).sort()

test("every audit gate fails on a moderate advisory", async () => {
  for (const [name, line] of await gates())
    expect([name, line.match(/--audit-level (\S+)/)?.[1]]).toEqual([name, "moderate"])
})

test("every audit gate ignores just the advisories docs/dependencies.md records as ignored", async () => {
  const doc = await read("docs/dependencies.md")
  const section = doc.split("## Ignored advisories")[1]?.split("\n## ")[0] ?? ""
  const recorded = [...section.matchAll(/^### .*\((?:\[)?(GHSA-[\w-]+)/gm)].map((m) => m[1]).sort()
  for (const [name, line] of await gates()) expect([name, ignores(line)]).toEqual([name, recorded])
})
