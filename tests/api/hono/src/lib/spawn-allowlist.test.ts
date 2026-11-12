import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

import { Glob } from "bun"

const LIB = join(import.meta.dir, "../../../../../api/hono/src/lib")

// Every file under api/hono/src/lib allowed to start a process, the 24 that spawn today: a new one fails here, and one that stops spawning leaves the list.
const ALLOWLIST = [
  "accounts/claude-setup.ts",
  "dashboard/agents.ts",
  "dashboard/dispatcher-start.ts",
  "dashboard/fixture.ts",
  "dashboard/repo.ts",
  "dashboard/restart.ts",
  "dashboard/run-argv.ts",
  "dashboard/secret-sink.ts",
  "dashboard/slack-upload.ts",
  "dashboard/templates.ts",
  "dashboard/update.ts",
  "dashboard/vibe.ts",
  "dev/launch.ts",
  "dev/proxy.ts",
  "dev/stop.ts",
  "keychain.ts",
  "onboard/fix.ts",
  "onboard/machine.ts",
  "pglite.ts",
  "sessions/guard.ts",
  "setup/container.ts",
  "store/extensions.ts",
  "system/probe.ts",
  "trash.ts",
]

// A call shape, not the word: Bun's spawners and shell tag, a `$` imported from bun (matched through the import, so a regex source ending in `$` before its template's backtick never reads as one), the child_process module in any import form (probe.test.ts's SPAWNS shapes), or a bare call of the child_process family, so prose and re.exec never match. `from "bun"` alone is not a spawn (Glob reaches lib through it), and `= Bun` matches every `= Bun.file(...)` at repo scale.
const SPAWN =
  /\bBun\.(?:spawn(?:Sync)?\s*\(|\$)|import\s*\{[^}]*(?<![\w$])\$(?![\w$])[^}]*\}\s*from\s*["']bun["']|\bfrom\s*["'](?:node:child_process|child_process|execa|zx)["']|\b(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)|(?<![.\w$])(?:spawn|spawnSync|exec|execFile|execFileSync|execSync)\s*\(/

const codeOf = (source: string): string => {
  try {
    return new Bun.Transpiler({ loader: "ts" }).transformSync(source)
  } catch {
    return source
  }
}

const spawners = (files: Record<string, string>): string[] =>
  Object.entries(files)
    .filter(([, source]) => SPAWN.test(codeOf(source)))
    .map(([path]) => path)

describe("who starts a process under api/hono/src/lib", () => {
  test("only the allowlisted files, and the list names every one of them", async () => {
    const files: Record<string, string> = {}
    for await (const path of new Glob("**/*.ts").scan(LIB)) {
      files[relative(LIB, join(LIB, path))] = await Bun.file(join(LIB, path)).text()
    }
    const found = spawners(files)
    expect(found.filter((f) => !ALLOWLIST.includes(f))).toEqual([])
    expect(found.sort()).toEqual([...ALLOWLIST].sort())
  })

  test("a call flags, and prose, a method or a lookalike does not", () => {
    const flagging = {
      "bun.ts": 'export const a = () => Bun.spawnSync(["true"])',
      "bare.ts": 'const p = spawn(["ls"])',
      "child.ts": 'import { execFile } from "node:child_process"\nexecFile("ls", [])',
      "namespace.ts":
        'import * as cp from "node:child_process"\nexport const s = () => cp.execFileSync("true")',
      "required.ts":
        'const { execSync } = require("node:child_process")\nexport const r = () => execSync("true")',
      "shell.ts": "export const sh = () => Bun.$`true`",
      "aliased-dollar.ts": 'import { $ as sh } from "bun"\nexport const t = () => sh`true`',
    }
    const clear = {
      "prose.ts": "// Bun.spawnSync would run herdr here; spawns stay in herdr.ts",
      "method.ts": 're.exec(text); opts.execFile;\nBun.spawnmock(["x"])',
      "suffix.ts": "respawn(cmd); fastspawnSync(cmd)",
      "glob.ts": 'import { Glob } from "bun"\nexport const scan = () => new Glob("**/*.ts")',
      "aliased.ts": "const run = Bun",
    }
    expect(spawners({ ...flagging, ...clear }).sort()).toEqual(Object.keys(flagging).sort())
  })
})
