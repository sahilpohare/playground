import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

const GITHUB = join(import.meta.dir, "../../../.github")
const SHA = "0123456789abcdef0123456789abcdef01234567"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

// The two folders GitHub runs from: actions holds the composite actions the workflows call.
const yamlFiles = (root: string): string[] =>
  ["actions", "workflows"]
    .map((sub) => join(root, sub))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()

// A uses: line passes as a local action, a docker image by digest, or an action at a full commit sha with its tag in a trailing comment; a workflow also needs a top-level permissions block.
const problems = async (root: string): Promise<string[]> => {
  const found: string[] = []
  for (const path of yamlFiles(root)) {
    const name = relative(root, path)
    const text = await Bun.file(path).text()
    for (const [i, line] of text.split("\n").entries()) {
      const ref = line.match(/^\s*(?:-\s+)?uses:\s*(.*)$/)?.[1]?.trim()
      if (ref === undefined) continue
      if (ref.startsWith("./")) continue
      if (/^docker:\/\/\S+@sha256:[0-9a-f]{64}$/.test(ref)) continue
      if (/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*\S+$/.test(ref)) continue
      found.push(`${name}:${i + 1}: ${ref}`)
    }
    if (
      name.startsWith("workflows/") &&
      (Bun.YAML.parse(text) as Record<string, unknown>).permissions === undefined
    )
      found.push(`${name}: no top-level permissions`)
  }
  return found
}

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "pins-"))
  dirs.push(root)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true })
    writeFileSync(join(root, name), body)
  }
  return root
}

const job = (uses: string): string =>
  `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`

test("a tag-only uses: line and a workflow with no top-level permissions are each found, and the rest pass", async () => {
  const root = fixture({
    "actions/local/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: acme/cache-action/restore@v3\n`,
    "workflows/docker-tag.yml": `permissions:\n  contents: read\n${job("docker://ghcr.io/acme/tool:1")}`,
    "workflows/docker.yml": `permissions:\n  contents: read\n${job(`docker://ghcr.io/acme/tool@sha256:${"a".repeat(64)}`)}`,
    "workflows/local.yml": `permissions:\n  contents: read\n${job("./.github/actions/local")}`,
    "workflows/open.yml": job(`acme/build-action@${SHA} # v2`),
    "workflows/pinned.yml": `permissions:\n  contents: read\n${job(`acme/build-action@${SHA} # v2`)}`,
    "workflows/tag.yml": `permissions:\n  contents: read\n${job("acme/build-action@v2")}`,
    "workflows/untagged.yml": `permissions:\n  contents: read\n${job(`acme/build-action@${SHA}`)}`,
  })
  expect(await problems(root)).toEqual([
    "actions/local/action.yml:4: acme/cache-action/restore@v3",
    "workflows/docker-tag.yml:7: docker://ghcr.io/acme/tool:1",
    "workflows/open.yml: no top-level permissions",
    "workflows/tag.yml:7: acme/build-action@v2",
    "workflows/untagged.yml:7: acme/build-action@0123456789abcdef0123456789abcdef01234567",
  ])
})

test("every uses: in .github names a full commit sha with its tag, and every workflow has a top-level permissions block", async () => {
  expect(await problems(GITHUB)).toEqual([])
})

// AGENTS.md, which CLAUDE.md links to, is the one file that runs inscope
test("inscope runs at one pinned version, so every session takes the same one", async () => {
  const text = await Bun.file(join(GITHUB, "../AGENTS.md")).text()
  expect(text).toMatch(/`npx -y inscope@\d+\.\d+\.\d+ <command>`/)
  expect(text).not.toMatch(/inscope@(?!\d)/)
})
