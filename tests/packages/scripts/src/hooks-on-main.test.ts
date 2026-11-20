import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { missingOn, wrappersOf } from "../../../../packages/scripts/src/hooks-on-main"

// #634: #551 registered a hook whose script only canary held, and every factory session on canary lost Bash until #631 took it out.
const scratch = mkdtempSync(join(tmpdir(), "hooks-on-main-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const CLI = join(REPO_ROOT, "packages", "scripts", "src", "hooks-on-main.ts")

// today's single-path guard wrapper, as .claude/settings.json writes it
const single = (name: string) =>
  `R="\${PLAYGROUND_REPO}"; [ -n "$R" ] && [ -f "$R/scripts/hooks/${name}.ts" ] || { [ -z "$PLAYGROUND_ROLE" ] && exit 0; echo "${name}: no guard script in the main checkout (\${R:-not found}); refusing." >&2; exit 2; }; cd -P "$R" && bun --no-env-file scripts/hooks/${name}.ts`
// the bundle-then-source wrapper #581 brings
const bundled = (name: string) =>
  `R="\${PLAYGROUND_REPO}"; [ -n "$R" ] && { s=scripts/hooks/bundled/${name}.js; [ -f "$R/$s" ] || s=scripts/hooks/${name}.ts; [ -f "$R/$s" ]; } || { [ -z "$PLAYGROUND_ROLE" ] && exit 0; echo "${name}: no guard script in the main checkout (\${R:-not found}); refusing." >&2; exit 2; }; cd -P "$R" && bun --no-env-file "$s"`

const settings = (...commands: string[]) =>
  JSON.stringify(
    {
      hooks: {
        PreToolUse: commands.map((command) => ({
          hooks: [{ command, type: "command" }],
          matcher: "^Bash$",
        })),
      },
    },
    null,
    2,
  )

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.toString()
}

const put = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

// A throwaway repo whose origin/main holds mainFiles, with head's files committed on top, as a PR's head sits on a canary main lacks; its origin is a path that holds no repo, so a fetch fails.
const repo = (mainFiles: Record<string, string>, head: Record<string, string>) => {
  const root = mkdtempSync(join(scratch, "repo-"))
  git(root, "init", "-q", "-b", "canary")
  git(root, "remote", "add", "origin", join(scratch, "no-such-remote"))
  put(root, { "README.md": "x\n", ...mainFiles })
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "main")
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
  put(root, head)
  git(root, "add", "-A")
  git(root, "commit", "-q", "--allow-empty", "-m", "head")
  return root
}

describe("wrappersOf", () => {
  test("reads the script a single-path wrapper runs", () => {
    expect(wrappersOf(".claude/settings.json", settings(single("no-stash")))).toEqual([
      { file: ".claude/settings.json", line: 7, scripts: ["scripts/hooks/no-stash.ts"] },
    ])
  })

  test("reads both scripts a bundle-then-source wrapper may run", () => {
    expect(
      wrappersOf("scripts/factory-settings.json", settings(bundled("no-stash")))[0]?.scripts,
    ).toEqual(["scripts/hooks/bundled/no-stash.js", "scripts/hooks/no-stash.ts"])
  })

  test("reads a SKILL.md's frontmatter alone", () => {
    const text = [
      "---",
      "name: x",
      "hooks:",
      "  PreToolUse:",
      `    - command: '[ -f "$PLAYGROUND_REPO/scripts/hooks/no-linear-ticket.ts" ] || exit 0; cd -P "$PLAYGROUND_REPO" && bun --no-env-file scripts/hooks/no-linear-ticket.ts'`,
      "---",
      "",
      "An example in the body: `bun --no-env-file scripts/hooks/not-a-hook.ts`",
    ].join("\n")
    expect(wrappersOf("skills/x/SKILL.md", text)).toEqual([
      { file: "skills/x/SKILL.md", line: 5, scripts: ["scripts/hooks/no-linear-ticket.ts"] },
    ])
  })
})

describe("missingOn origin/main", () => {
  test("fails a registration whose script origin/main lacks, naming it", async () => {
    const root = repo(
      { "scripts/hooks/no-stash.ts": "" },
      {
        ".claude/settings.json": settings(single("no-stash"), single("no-raw-delete")),
        "scripts/hooks/no-raw-delete.ts": "",
      },
    )
    const missing = await missingOn(root, "origin/main")
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain(".claude/settings.json:")
    expect(missing[0]).toContain("scripts/hooks/no-raw-delete.ts")
  })

  test("passes a bundle-then-source wrapper whose bundle main lacks but whose source main holds", async () => {
    const root = repo(
      { "scripts/hooks/no-stash.ts": "" },
      {
        "scripts/factory-settings.json": settings(bundled("no-stash")),
        "scripts/hooks/bundled/no-stash.js": "",
      },
    )
    expect(await missingOn(root, "origin/main")).toEqual([])
  })

  test("fails a bundle-then-source wrapper when main holds neither, naming both", async () => {
    const root = repo({}, { "scripts/factory-settings.json": settings(bundled("no-stash")) })
    const missing = await missingOn(root, "origin/main")
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain("scripts/hooks/bundled/no-stash.js or scripts/hooks/no-stash.ts")
  })

  test("fails a skill's frontmatter registration whose script main lacks", async () => {
    const skill = [
      "---",
      "hooks:",
      `  command: 'cd -P "$PLAYGROUND_REPO" && bun --no-env-file scripts/hooks/no-new.ts'`,
      "---",
    ].join("\n")
    const missing = await missingOn(repo({}, { "skills/x/SKILL.md": skill }), "origin/main")
    expect(missing).toEqual([expect.stringContaining("skills/x/SKILL.md:3")])
  })

  test("throws when the ref does not read, rather than passing", async () => {
    const root = repo({}, {})
    await expect(missingOn(root, "origin/nope")).rejects.toThrow("origin/nope does not read")
  })

  test("every hook this checkout registers runs a script its own tree holds", async () => {
    const missing = await missingOn(REPO_ROOT, "HEAD")
    expect(missing).toEqual([])
  })
})

describe("the command", () => {
  test("exits 1, saying so, when origin/main does not read and cannot be fetched", () => {
    const root = repo({}, {})
    git(root, "update-ref", "-d", "refs/remotes/origin/main")
    const result = Bun.spawnSync(["bun", CLI], { cwd: root })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("FAIL origin/main does not read")
  })

  test("skips, saying why, in a checkout with no origin, as the runner host's run clone is, and fails there under CI", () => {
    const root = repo({}, {})
    git(root, "remote", "remove", "origin")
    const off = Bun.spawnSync(["bun", CLI], { cwd: root, env: { ...process.env, CI: "" } })
    expect(off.exitCode).toBe(0)
    expect(off.stdout.toString()).toContain("SKIP the checkout has no origin to read main from")
    const ci = Bun.spawnSync(["bun", CLI], { cwd: root, env: { ...process.env, CI: "true" } })
    expect(ci.exitCode).toBe(1)
    expect(ci.stdout.toString()).toContain("FAIL the checkout has no origin")
  })

  test("exits 1, naming the script, when a registration's script main lacks", () => {
    const root = repo({}, { ".claude/settings.json": settings(single("no-raw-delete")) })
    const result = Bun.spawnSync(["bun", CLI], { cwd: root })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("FAIL .claude/settings.json:")
    expect(result.stdout.toString()).toContain("scripts/hooks/no-raw-delete.ts")
  })
})
