import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..")

const lint = async (code: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "oxlintrc-")), "probe.ts")
  await Bun.write(file, code)
  const run = Bun.spawnSync([
    join(REPO, "node_modules/.bin/oxlint"),
    "-c",
    join(REPO, ".oxlintrc.jsonc"),
    // one output layout everywhere, since oxlint picks its own layout under an agent session
    "-f",
    "unix",
    file,
  ])
  return { exitCode: run.exitCode, out: run.stdout.toString() }
}

test("an unused import fails lint, so it never reaches canary as a warning (#2328)", async () => {
  const { exitCode, out } = await lint(
    'import { join, sep } from "node:path"\nexport const root = sep\n',
  )
  expect(out).toContain("[Error/eslint(no-unused-vars)]")
  expect(exitCode).toBe(1)
})

test("a name led by an underscore, or a key a rest destructure drops, stays allowed", async () => {
  const code = [
    "export const stub = (_path: string): string[] => []",
    "export const omit = ({ id: _, ...rest }: { id: string; name: string }) => rest",
    "",
  ].join("\n")
  expect(await lint(code)).toEqual({
    exitCode: 0,
    out: expect.not.stringContaining("no-unused-vars"),
  })
})
