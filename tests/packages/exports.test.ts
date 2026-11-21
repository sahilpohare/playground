import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "../..")
const FACTORY = ["packages/scripts/src", "scripts", "extensions"]

// A factory script's import that reads a dist, by file and specifier, each with the build that runs before it.
const OWN_BUILD: Record<string, Record<string, string>> = {
  "packages/scripts/src/env-keys.ts": {
    "@packages/env/gaps": "pre-commit's env-keys step builds @packages/env first (lefthook.yml)",
  },
  "packages/scripts/src/generate-env.ts": {
    "@packages/env/auth": "a package's build runs it after turbo builds @packages/env",
    "@packages/env/load-dotenv": "a package's build runs it after turbo builds @packages/env",
    "@packages/env/web-next": "a package's build runs it after turbo builds @packages/env",
  },
  "packages/scripts/src/lock/cli.ts": {
    "@packages/redis":
      "its dynamic import falls back to the lock folders when Redis's client does not load",
  },
  "packages/scripts/src/pr-merge/merge.ts": {
    "@packages/redis": "pr:merge and pr:train run verify/prebuild.ts first",
  },
  "packages/scripts/src/test-sandbox.ts": {
    "@packages/env/gaps": "its dynamic import runs after prebuildTests",
  },
}

const scanner = new Bun.Transpiler({ loader: "tsx" })

// Each @packages/* import of a factory script whose file under Bun is no package's src, as `<file> <specifier>`.
const distReads = async (): Promise<string[]> => {
  const reads: string[] = []
  for (const dir of FACTORY)
    for (const name of new Bun.Glob("**/*.{ts,tsx}").scanSync(join(ROOT, dir))) {
      if (name.split("/").includes("node_modules")) continue
      const file = join(ROOT, dir, name)
      let imports: { path: string }[] = []
      try {
        imports = scanner.scanImports(await Bun.file(file).text())
      } catch {
        continue
      }
      for (const { path } of imports) {
        if (!path.startsWith("@packages/")) continue
        let to = ""
        try {
          to = relative(ROOT, Bun.resolveSync(path, file))
        } catch {}
        if (!/^packages\/[\w-]+\/src\//.test(to)) reads.push(`${relative(ROOT, file)} ${path}`)
      }
    }
  return [...new Set(reads)].sort()
}

describe("a factory script in a worktree with no build", () => {
  test("reads each workspace package it imports from src under Bun, but for an import whose build runs first", async () => {
    const allowed = Object.entries(OWN_BUILD).flatMap(([file, specifiers]) =>
      Object.keys(specifiers).map((specifier) => `${file} ${specifier}`),
    )
    expect(await distReads()).toEqual(allowed.sort())
  })
})
