import { join } from "node:path"

// A hook wrapper runs its script from the main checkout, which follows main, so a factory session on canary loses the hook's tool the moment canary registers a script main lacks; this check fails such a registration until a ship puts its script on main.

type Wrapper = { file: string; line: number; scripts: string[] }

const SCRIPT = /scripts\/hooks\/(?:bundled\/)?[\w-]+\.(?:ts|js)/g
const RUNS = "bun --no-env-file"

// Pure: the wrappers in one file's text, each a line that runs a hook script with bun, with every script it may run (a bundle-then-source wrapper names two); a SKILL.md registers hooks in its frontmatter alone.
export function wrappersOf(file: string, text: string): Wrapper[] {
  const lines = text.split("\n")
  const end = file.endsWith(".md") ? frontmatterEnd(lines) : lines.length
  const wrappers: Wrapper[] = []
  for (const [i, line] of lines.slice(0, end).entries()) {
    const scripts = [...new Set(line.match(SCRIPT) ?? [])]
    if (line.includes(RUNS) && scripts.length) wrappers.push({ file, line: i + 1, scripts })
  }
  return wrappers
}

// The index of a Markdown file's closing frontmatter fence, or 0 when it opens with none or never closes it.
const frontmatterEnd = (lines: string[]): number =>
  lines[0] === "---" ? Math.max(lines.indexOf("---", 1), 0) : 0

const git = async (root: string, ...args: string[]) => {
  const proc = Bun.spawn(["git", "-C", root, ...args], { stderr: "pipe", stdout: "pipe" })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout }
}

const reads = async (root: string, ref: string) =>
  (await git(root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).code === 0

// Every wrapper in the tracked settings and skill files under root whose scripts ref holds none of, as one line each; throws when ref does not read, so an unread main never passes.
export async function missingOn(root: string, ref: string): Promise<string[]> {
  if (!(await reads(root, ref)))
    throw new Error(
      `${ref} does not read in ${root}; fetch it (git fetch origin main) and run again`,
    )
  const listed = await git(
    root,
    "grep",
    "-l",
    "-e",
    RUNS,
    "--and",
    "-e",
    "scripts/hooks/",
    "--",
    "*.json",
    "*SKILL.md",
    ":!tests",
  )
  // git grep exits 1 when no file matches; any other failure would read as no wrappers at all, so it throws
  if (listed.code > 1) throw new Error(`git grep exited ${listed.code} in ${root}`)
  const missing: string[] = []
  for (const file of listed.stdout.split("\n").filter(Boolean)) {
    for (const wrapper of wrappersOf(file, await Bun.file(join(root, file)).text())) {
      const held = await Promise.all(
        wrapper.scripts.map(
          async (script) => (await git(root, "cat-file", "-e", `${ref}:${script}`)).code === 0,
        ),
      )
      if (!held.includes(true))
        missing.push(
          `${file}:${wrapper.line} runs ${wrapper.scripts.join(" or ")}, which ${ref} lacks: the main checkout follows main, so register a hook in the ship after its script`,
        )
    }
  }
  return missing
}

if (import.meta.main) {
  const root = (await git(".", "rev-parse", "--show-toplevel")).stdout.trim() || "."
  // the runner host's run clone is a fresh git init with no origin, so main cannot be read there; GitHub CI's checkout has one, so under CI no origin fails
  if ((await git(root, "remote", "get-url", "origin")).code !== 0) {
    if (process.env.CI) {
      console.log("FAIL the checkout has no origin to read main from, which CI's checkout has")
      process.exit(1)
    }
    console.log(
      "SKIP the checkout has no origin to read main from; GitHub CI and a local run check it",
    )
    process.exit(0)
  }
  // a shallow checkout carries no origin/main, so fetch it, and fail below when even that does not read
  if (!(await reads(root, "origin/main")))
    await git(root, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main")
  try {
    const missing = await missingOn(root, "origin/main")
    // stdout, as FAIL lines, so test:skills' summary names the first one
    for (const line of missing) console.log(`FAIL ${line}`)
    if (missing.length) process.exit(1)
    console.log("every hook registration runs a script origin/main holds")
  } catch (error) {
    console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
