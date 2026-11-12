import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// No file in the repo deletes a folder tree on its own: a delete goes through the trash (playground rm) or removeScratch (@packages/safe-delete), so a wrong path is refused or can be put back (#598).
const ROOT = join(import.meta.dir, "..")

// Folders whose every delete is allowed, with why.
const ALLOWED: Record<string, string> = {
  "packages/safe-delete/":
    "the safe delete itself: removeScratch, and purgeTrash, the trash-purge beat's one recursive delete",
  "scripts/hooks/": "the guards hold the delete forms they refuse as data",
  "tests/":
    "a test holds delete commands as data (the refused-forms fixture, the picker's screens) or removes the mkdtemp root it made, inside test-sandbox's scratch HOME, which require-sandbox.test.ts holds every run to",
}

// Files that keep a raw delete, each with its number of delete lines and why; a new delete line in one changes its count and fails (a second delete on a line that holds one already does not), and a site that moves onto the trash lowers it.
const CARVE_OUTS: Record<string, { lines: number; reason: string }> = {
  "api/hono/src/lib/dashboard/vibe.ts": {
    lines: 2,
    reason:
      "a Vibeground's stop, or its failed start, removes the stack's own clone of the data folder under the worktree's .turbo/vibe-data, a copy made to be thrown away",
  },
  "packages/scripts/src/clean.ts": {
    lines: 1,
    reason:
      "bun run clean removes gitignored build outputs by name, node_modules among them, far past the trash's 2 GB and 5000-file limits, and never enters a dot-folder",
  },
  "packages/scripts/src/hooks-bundle.ts": {
    lines: 2,
    reason:
      "--check's mirror is a temp folder the process made itself one call ago, in the OS's tmpdir, holding the merged tree's own sources and never a worktree file; mirrorOf removes it when its own write or link throws, bundle when the build over it does",
  },
  "packages/scripts/src/pr-merge/README.md": {
    lines: 1,
    reason:
      "documents the types gate's reset of its own kept merge-types worktree, as types.ts runs it",
  },
  "packages/scripts/src/pr-merge/types.ts": {
    lines: 3,
    reason:
      "the types gate keeps one detached merge-types worktree across merges: it resets it to each merged tree, node_modules kept, and removes it whole only when it cannot be reused; it holds a commit's tree and that tree's install",
  },
  "packages/settings/src/items.ts": {
    lines: 3,
    reason:
      "a write replaces an item's path, or a proposal's, inside an extension's git-tracked scope, and every write commits, so git keeps what it replaces",
  },
  "scripts/briefs/brief-rush.md": {
    lines: 1,
    reason: "prose that names the form as one never to run",
  },
  "scripts/ops/dashboard/supervisor.sh": {
    lines: 2,
    reason:
      "the live dashboard's runner removes its own staging worktree under its state folder, whose node_modules clone of about 108k files is past the trash's tripwire; its build folders go to the trash through trash-build.ts",
  },
  "scripts/ops/runner-host/suite.sh": {
    lines: 5,
    reason:
      "runs on the CI runner host under /srv/ci, which has no trash: it removes a run's own unpacked tree and files, the trees of runs whose unit has stopped, and logs and outputs older than 7 days",
  },
  "web/next/package.json": {
    lines: 2,
    reason: "build and check-types clear .next/dev/types, which next typegen writes again at once",
  },
}

const ARG = `['"]-[a-zA-Z]*['"]\\s*,\\s*`
const RECURSIVE_FLAG = `(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)`

// Each raw form, by name, A to Z; the text is read as written, so options held in a variable or a computed flag pass unseen.
const FORMS: [string, RegExp][] = [
  ["find -delete", /\bfind\b[^\n|;]*\s-delete\b/],
  ["git clean -f", /\bgit\b[^\n|;]*\bclean\s+(?:-[a-zA-Z-]+\s+)*(?:--force\b|-[a-zA-Z]*f)/],
  [
    "git clean -f",
    /['"]clean['"]\s*,\s*(?:['"]-[a-zA-Z-]+['"]\s*,\s*)*['"](?:--force|-[a-zA-Z]*f[a-zA-Z]*)['"]/,
  ],
  ["git worktree remove --force", /\bworktree\s+remove\b[^\n|;]*(?:--force|\s-f\b)/],
  [
    "git worktree remove --force",
    /['"]worktree['"]\s*,\s*['"]remove['"]\s*,[^\]\n]*['"](?:--force|-f)['"]/,
  ],
  [
    "rm -r",
    new RegExp(
      `(?:^|[\\s;&|(\`'"/\\\\])(?<!\\bgit\\s)rm\\s+(?:-[a-zA-Z-]+\\s+)*${RECURSIVE_FLAG}(?=[\\s'"\`;)]|$)`,
    ),
  ],
  ["rm -r", new RegExp(`['"]rm['"]\\s*,\\s*\\[?\\s*(?:${ARG})*['"]${RECURSIVE_FLAG}['"]`)],
  ["rmtree", /\brmtree\b/],
]

// A call to rmSync, rm, rmdirSync or rmdir counts when its own arguments, across lines, ask for recursive.
const CALL = /\b(?:rmSync|rmdirSync|rm|rmdir)\(/g

// The text from an opening parenthesis to its match, or to the end.
const argumentsOf = (text: string, open: number): string => {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    if (text[at] === "(") depth++
    else if (text[at] === ")" && --depth === 0) return text.slice(open, at + 1)
  }
  return text.slice(open)
}

// The line numbers holding a raw recursive delete, each with the forms found there.
const rawDeletes = (text: string): Map<number, string[]> => {
  const found = new Map<number, string[]>()
  const add = (line: number, form: string) => {
    const forms = found.get(line) ?? []
    if (!forms.includes(form)) found.set(line, [...forms, form])
  }
  text.split("\n").forEach((line, index) => {
    for (const [form, pattern] of FORMS) if (pattern.test(line)) add(index + 1, form)
  })
  for (const call of text.matchAll(CALL)) {
    const open = call.index + call[0].length - 1
    if (/\brecursive\s*:\s*true\b/.test(argumentsOf(text, open)))
      add(text.slice(0, call.index).split("\n").length, "recursive rm")
  }
  return found
}

const allowedFolder = (path: string) =>
  Object.keys(ALLOWED).find((folder) => path.startsWith(folder))

// Each file outside the allowed folders that holds a raw delete, with its delete lines.
const offenders = (files: Record<string, string>): Map<string, Map<number, string[]>> =>
  new Map(
    Object.entries(files)
      .filter(([path]) => !allowedFolder(path))
      .map(([path, text]) => [path, rawDeletes(text)] as const)
      .filter(([, lines]) => lines.size > 0),
  )

const trackedText = async (): Promise<Record<string, string>> => {
  const list = Bun.spawnSync(["git", "ls-files", "--cached", "-z"], {
    cwd: ROOT,
    stderr: "pipe",
  })
  if (list.exitCode !== 0) throw new Error(`git ls-files failed: ${list.stderr}`)
  const files: Record<string, string> = {}
  for (const path of list.stdout.toString().split("\0").filter(Boolean)) {
    const file = Bun.file(join(ROOT, path))
    if (!(await file.exists())) continue
    const text = await file.text().catch(() => "")
    if (!text.includes("\0")) files[path] = text
  }
  return files
}

describe("no raw recursive delete in the repo", () => {
  test("each delete outside the allowed folders is a carve-out, at its counted lines", async () => {
    const found = offenders(await trackedText())
    const report = [...found].map(
      ([path, lines]) =>
        `${path}: ${lines.size} delete line(s): ${[...lines].map(([n, forms]) => `${n} (${forms.join(", ")})`).join("; ")}`,
    )
    const counted = Object.fromEntries([...found].map(([path, lines]) => [path, lines.size]))
    const carved = Object.fromEntries(
      Object.entries(CARVE_OUTS).map(([path, { lines }]) => [path, lines]),
    )
    expect(
      counted,
      `move each new delete onto playground rm or removeScratch, else carve it out with its reason:\n${report.join("\n")}`,
    ).toEqual(carved)
  }, 60_000)

  test("names a reason for every allowed folder and carve-out", () => {
    for (const [path, reason] of [
      ...Object.entries(ALLOWED),
      ...Object.entries(CARVE_OUTS).map(([path, { reason }]) => [path, reason] as const),
    ])
      expect(reason.length, path).toBeGreaterThan(20)
  })

  test("finds each raw form, and a recursive call across lines", () => {
    const forms = (text: string) => [...rawDeletes(text).values()].flat()
    expect(forms("rm -rf build")).toEqual(["rm -r"])
    expect(forms("rm -f -R build")).toEqual(["rm -r"])
    expect(forms("x && rm --recursive build")).toEqual(["rm -r"])
    expect(forms('spawn(["rm", "-f", "-r", dir])')).toEqual(["rm -r"])
    expect(forms("shutil.rmtree(path)")).toEqual(["rmtree"])
    expect(forms("find /srv -type f -delete")).toEqual(["find -delete"])
    expect(forms("git clean -fdx")).toEqual(["git clean -f"])
    expect(forms('git(["clean", "-d", "-f"])')).toEqual(["git clean -f"])
    expect(forms('git worktree remove --force "$w"')).toEqual(["git worktree remove --force"])
    expect(forms('git(["worktree", "remove", "--force", w])')).toEqual([
      "git worktree remove --force",
    ])
    expect(forms("rmSync(dir, { force: true, recursive: true })")).toEqual(["recursive rm"])
    expect(forms('execFileSync("rm", ["-rf", dir])')).toEqual(["rm -r"])
    expect(forms('spawnSync("rm", ["-r", "-f", dir])')).toEqual(["rm -r"])
    expect(forms("/bin/rm -rf build")).toEqual(["rm -r"])
    expect(forms("\\rm -rf build")).toEqual(["rm -r"])
    expect(forms("git clean --force -dx")).toEqual(["git clean -f"])
    expect(forms('git(["clean", "--force", "-dx"])')).toEqual(["git clean -f"])
    expect(rawDeletes("await rm(\n  join(a, b),\n  { recursive: true },\n)")).toEqual(
      new Map([[1, ["recursive rm"]]]),
    )
  })

  test("leaves a single file's delete, a recursive mkdir and a plain worktree remove alone", () => {
    for (const text of [
      "rm -f build.log",
      "rmSync(file, { force: true })",
      "mkdirSync(dir, { recursive: true })",
      'git worktree remove "$w"',
      "git rm -r --cached x",
      "firm -r",
    ])
      expect([...rawDeletes(text).keys()], text).toEqual([])
  })

  test("a raw delete added to a file outside the allowed folders is caught, and one inside them is not", () => {
    const files = {
      "packages/scripts/src/new.ts": "rmSync(dir, { force: true, recursive: true })\n",
      "scripts/hooks/guard.ts": "const refused = 'rm -rf /'\n",
      "tests/x.test.ts": "rmSync(root, { force: true, recursive: true })\n",
    }
    expect([...offenders(files).keys()]).toEqual(["packages/scripts/src/new.ts"])
  })
})
