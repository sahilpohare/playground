import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

// Each object literal that spreads the caller's env beside a HOME of its own, kept on purpose: file, then the literal with its whitespace collapsed, then why
const ALLOWLIST: Record<string, Record<string, string>> = {
  "packages/scripts/src/hook-differential.ts": {
    "{ ...process.env, HOME: home }":
      "--role session reads the real roster and config as the real user, its home the caller's own HOME or homedir()",
  },
}

const RULE =
  "a child given a HOME of its own takes its env from boxEnv (packages/scripts/src/box-env.ts), since an absolute variable in the caller's env (PORTLESS_STATE_DIR) survives the new HOME and reaches the real machine's state"

// The names a file binds to the caller's env or a copy of it: a rest of a destructured process.env, or an assignment from process.env or a filtered copy of its entries
const envNames = (text: string) => {
  const names = new Set(["process.env", "Bun.env"])
  for (const m of text.matchAll(/\.\.\.(\w+)\s*\}\s*=\s*(?:process|Bun)\.env\b/g)) names.add(m[1]!)
  for (const m of text.matchAll(
    /(?:const|let)\s+(\w+)\b[^=\n]*=\s*(?:Object\.fromEntries\(\s*Object\.entries\(\s*)?(?:process|Bun)\.env\b(?!\.)/g,
  ))
    names.add(m[1]!)
  return names
}

// The object literal around index at: from its unmatched { to the matching }, and whether its own top level sets HOME to anything but process.env.HOME
const literalAt = (text: string, at: number) => {
  let start = at
  for (let depth = 0; start > 0; start--) {
    const c = text[start - 1]
    if (c === "}") depth++
    else if (c === "{") {
      if (depth === 0) break
      depth--
    }
  }
  let end = start
  let home = false
  for (let depth = 0; end < text.length; end++) {
    const c = text[end]
    if (c === "{" || c === "(" || c === "[") depth++
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) break
      depth--
    } else if (
      depth === 0 &&
      /^(?:"HOME"|'HOME'|HOME)\s*(?::(?!\s*process\.env\.HOME\b)|[,}])/.test(
        text.slice(end, end + 40),
      ) &&
      !/[\w.$]/.test(text[end - 1] ?? "")
    )
      home = true
  }
  return { home, literal: text.slice(start - 1, end + 1).replace(/\s+/g, " ") }
}

const spreads = (text: string) => {
  const found: string[] = []
  const names = [...envNames(text)].map((name) => `${name.replace(".", "\\.")}\\b(?!\\.)`)
  // a filtered copy spread in place, its entries read from process.env
  names.push(String.raw`Object\.fromEntries\(\s*Object\.entries\(\s*(?:process|Bun)\.env\b`)
  for (const name of names) {
    for (const m of text.matchAll(new RegExp(`\\.\\.\\.${name}`, "g"))) {
      const { home, literal } = literalAt(text, m.index!)
      if (home) found.push(literal)
    }
  }
  return found
}

const tracked = () =>
  Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"],
    {
      cwd: ROOT,
    },
  )
    .stdout.toString()
    .split("\n")
    .filter(
      (file) =>
        file &&
        file !== "tests/scratch-home-env.test.ts" &&
        !file.startsWith("tests/scripts/hooks/fixtures/"),
    )

test("the scan finds a plain, a rest and a filtered spread of process.env beside a HOME, and leaves a real HOME alone", () => {
  expect(spreads("const env = { ...process.env, HOME: home }")).toHaveLength(1)
  expect(spreads("const env = { ...process.env, HOME }")).toHaveLength(1)
  expect(spreads("const env = { ...process.env, HOME, PATH: p }")).toHaveLength(1)
  expect(spreads('const env = { ...process.env, "HOME": home }')).toHaveLength(1)
  expect(spreads("const env = { ...process.env, X: process.env.HOME, HOMEDIR: d }")).toEqual([])
  expect(spreads("const { A: _, ...rest } = process.env\nrun({ ...rest, HOME: at })")).toHaveLength(
    1,
  )
  expect(
    spreads(
      "const base = Object.fromEntries(\n  Object.entries(process.env).filter(([k]) => k),\n)\nreturn { ...base, HOME: home }",
    ),
  ).toHaveLength(1)
  expect(
    spreads(
      "env: {\n  ...Object.fromEntries(\n    Object.entries(process.env).filter(([key]) => key),\n  ),\n  HOME: home,\n}",
    ),
  ).toHaveLength(1)
  expect(spreads("env: { TZ: 'UTC', HOME: process.env.HOME, ...process.env }")).toEqual([])
  expect(spreads("env: { ...process.env, CODEX_HOME: dir, TEST_SANDBOX_HOME: dir }")).toEqual([])
  expect(spreads("env: { ...process.env, nested: { HOME: dir } }")).toEqual([])
  expect(spreads("env: boxEnv(home, { PATH: bin })")).toEqual([])
})

test(`no file spreads the caller's env beside a HOME of its own: ${RULE}`, () => {
  const found: string[] = []
  const kept: string[] = []
  for (const file of tracked()) {
    let text: string
    try {
      text = readFileSync(join(ROOT, file), "utf8")
    } catch {
      continue
    }
    for (const literal of spreads(text)) {
      if (ALLOWLIST[file]?.[literal]) kept.push(`${file}: ${literal}`)
      else found.push(`${file}: ${literal}`)
    }
  }
  expect(found).toEqual([])
  expect(kept).toHaveLength(Object.values(ALLOWLIST).flatMap(Object.keys).length)
})
