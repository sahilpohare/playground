import { afterAll, describe, expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import { check as dispatch, GUARDS as DISPATCHED } from "../../../scripts/hooks/guards"
import { check as desktopOwnerApp } from "../../../scripts/hooks/no-desktop-owner-app"
import { check as envDump } from "../../../scripts/hooks/no-env-dump"
import { check as extensionRepoWrite } from "../../../scripts/hooks/no-extension-repo-write"
import { check as extensionsWrite } from "../../../scripts/hooks/no-extensions-write"
import { check as glmHeavyPath } from "../../../scripts/hooks/no-glm-heavy-path"
import { check as headlessLogin } from "../../../scripts/hooks/no-headless-login"
import { check as killByName } from "../../../scripts/hooks/no-kill-by-name"
import { check as linearTicket } from "../../../scripts/hooks/no-linear-ticket"
import { check as mainCheckout } from "../../../scripts/hooks/no-main-checkout"
import { check as outsidePrCode, live } from "../../../scripts/hooks/no-outside-pr-code"
import { check as playgroundLeak } from "../../../scripts/hooks/no-playground-leak"
import { check as publicLeak } from "../../../scripts/hooks/no-public-leak"
import { check as rawDelete } from "../../../scripts/hooks/no-raw-delete"
import { check as rawSpawn } from "../../../scripts/hooks/no-raw-spawn"
import { check as releaseComment } from "../../../scripts/hooks/no-release-comment"
import { check as stash } from "../../../scripts/hooks/no-stash"
import { check as unslottedRun } from "../../../scripts/hooks/no-unslotted-run"
import {
  ALLOWED,
  type Call,
  type Folder,
  type Guard,
  type Paths,
  NEVER_MADE,
  REFUSED_FORMS,
} from "./fixtures/refused-forms"
import { storeWith } from "./render-set"
import { git } from "./scratch-git"

const CHECKOUT = join(import.meta.dir, "..", "..", "..")
// where it lands, since no-outside-pr-code judges a skill script's path past this Mac's /var link
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "refused-forms-")))
afterAll(() => rmSync(SCRATCH, { force: true, recursive: true }))

// A home whose data folder holds an extensions root, its links and files, as the guards' own tests build it.
const HOME = join(SCRATCH, "home")
const DATA = join(HOME, ".playground")
const ROOT = join(DATA, "extensions")
const SCOPE = join(ROOT, "login")
const OTHER = join(SCRATCH, "other")
const PATHS: Paths = {
  BARE: join(SCRATCH, "bare"),
  CLI_DIR: join(CHECKOUT, "packages", "scripts", "src", "playground"),
  DATA,
  FOREIGN_TREE: join(SCRATCH, "foreign-tree"),
  FOREIGN_TREE_IN_MAIN: join(SCRATCH, "main", ".claude", "worktrees", "foreign"),
  HOME,
  LINK: join(HOME, "store"),
  LIST: join(ROOT, "hooks", "desktop-owner-apps.json"),
  MAIN: join(SCRATCH, "main"),
  ROOT,
  SCOPE,
  TREE_LINK: join(SCRATCH, "main", ".claude", "worktrees", "a", "into-main"),
  WORDS: join(HOME, "words"),
  WORK: join(HOME, "work"),
}
for (const dir of [
  join(ROOT, "hooks"),
  join(SCOPE, "lists"),
  join(ROOT, "hooks", "~-"),
  join(ROOT, "hooks", "~+"),
  join(DATA, "handoffs"),
  join(PATHS.WORK, "playground"),
  join(PATHS.MAIN, ".claude", "worktrees", "a"),
  PATHS.BARE,
])
  mkdirSync(dir, { recursive: true })
writeFileSync(PATHS.LIST, '["Slack"]\n')
writeFileSync(join(ROOT, "policy.json"), "{}\n")
writeFileSync(join(SCOPE, "lists", "release-owners.json"), "[]\n")
writeFileSync(PATHS.WORDS, "y ".repeat(400_000))
symlinkSync(ROOT, PATHS.LINK)
// the main checkout's worktree a, by its .git file, holding a link into the main checkout, and a plain folder beside it that no worktree holds, for #1663's rows
writeFileSync(join(PATHS.MAIN, ".claude", "worktrees", "a", ".git"), "gitdir: x\n")
symlinkSync(join(PATHS.MAIN, ".claude"), PATHS.TREE_LINK)
mkdirSync(join(PATHS.MAIN, ".claude", "worktrees", "plain"))
symlinkSync(ROOT, join(DATA, "store"))
symlinkSync(DATA, join(HOME, "pg"))
symlinkSync(join(PATHS.CLI_DIR, "cli.ts"), join(HOME, "pc"))
git(SCRATCH, "init", "-q", OTHER)
git(OTHER, "remote", "add", "origin", "https://github.com/acme-labs/demo.git")
// Another repository and two worktrees it lists, whose .git file and admin gitdir point at each other, for #1653's rows: one outside the main checkout and one under its .claude/worktrees.
const FOREIGN = join(SCRATCH, "foreign")
git(SCRATCH, "init", "-q", "-b", "canary", FOREIGN)
git(FOREIGN, "commit", "-q", "--allow-empty", "-m", "base")
for (const tree of [PATHS.FOREIGN_TREE, PATHS.FOREIGN_TREE_IN_MAIN])
  git(FOREIGN, "worktree", "add", "-q", "--detach", tree)
// A repo with a heavy path staged, as no-glm-heavy-path's own test stages one.
const GLM_REPO = join(SCRATCH, "glm-repo")
git(SCRATCH, "init", "-q", "-b", "canary", GLM_REPO)
git(GLM_REPO, "commit", "-q", "--allow-empty", "-m", "base")
mkdirSync(join(GLM_REPO, "web", "next", "src"), { recursive: true })
writeFileSync(join(GLM_REPO, "web", "next", "src", "x.ts"), "x\n")
git(GLM_REPO, "add", ".")
// The package scripts that run the tracker's and the DM's scripts, as the factory's root package.json names them, and their package's folder, for the org-script rows.
mkdirSync(join(GLM_REPO, "packages", "scripts", "src", "linear-read"), { recursive: true })
writeFileSync(
  join(GLM_REPO, "package.json"),
  JSON.stringify({
    scripts: {
      dm: "bun --no-env-file packages/scripts/src/dm/cli.ts",
      "linear:read": "bun --no-env-file packages/scripts/src/linear-read/cli.ts",
    },
  }),
)
// A checkout of the made-up org acme-blue, which the leak data folder's ext.links guards, for a GLM session's org rows.
const GLM_ORG_REPO = join(SCRATCH, "glm-org-repo")
git(SCRATCH, "init", "-q", GLM_ORG_REPO)
git(GLM_ORG_REPO, "remote", "add", "origin", "https://github.com/acme-blue/demo.git")
// A file of the org's checkout, and a link to it from the session's own checkout, for the read rows a glob or a link reaches it through.
writeFileSync(join(GLM_ORG_REPO, "README.md"), "demo\n")
symlinkSync(join("..", "glm-org-repo", "README.md"), join(GLM_REPO, "org-link.md"))
// The leak guard's lists as core holds them, with ext.links guarding a made-up org's repositories, as its own test sets them.
const LISTS = join(CHECKOUT, "extensions", "core", "lists")
const LEAK = join(SCRATCH, "leak")
// no-linear-ticket reads its approvals folder under PLAYGROUND_DATA_DIR, so its rows cd into the data folder the fixture makes
const TICKETS = join(SCRATCH, "tickets")
storeWith(
  join(LEAK, "playground"),
  {
    "playground-terms.json": readFileSync(join(LISTS, "playground-terms.json"), "utf8"),
    "slack-cleared.json": readFileSync(join(LISTS, "slack-cleared.json"), "utf8"),
  },
  { "ext.links": { "made-up-org": ["acme-blue"] } },
)
// A data folder whose extensions root lacks no-public-leak's list, which core never ships, so its rows pin the writes that refusal still refuses.
const LISTLESS = storeWith(join(SCRATCH, "listless"), {})
const OWNED = storeWith(join(SCRATCH, "owned"), { "release-owners.json": '["qmarsh"]' })
const DESKTOP = storeWith(join(SCRATCH, "desktop"), { "desktop-owner-apps.json": '["Slack"]' })
// A data folder whose scope acme syncs with the made-up extension repo quillco/acme-skills.
const SYNCED = storeWith(
  join(SCRATCH, "synced"),
  {},
  { "ext.repos": { acme: "quillco/acme-skills" } },
)
mkdirSync(join(SYNCED, "extensions", "acme"), { recursive: true })
git(join(SYNCED, "extensions", "acme"), "init", "-q")
// A fabricated main checkout (holds scripts/spawn.sh and maps ask/thread to their Playground entries) and a linked worktree of it whose package.json and entry files match byte for byte, since no-desktop-owner-app's prose allowance holds from the main checkout alone. PLAYGROUND_REPO pins mainCheckout() to NDMAIN, restored after.
const NDMAIN = join(SCRATCH, "nd-main")
const { ask, thread } = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"),
).scripts
const SCRIPT_LINES = { ask, thread }
const NDWORK = join(SCRATCH, "nd-work")
git(SCRATCH, "init", "-q", "-b", "canary", NDMAIN)
mkdirSync(join(NDMAIN, "scripts"), { recursive: true })
writeFileSync(join(NDMAIN, "scripts", "spawn.sh"), "#!/bin/sh\n")
mkdirSync(join(NDMAIN, "api", "hono", "src", "bin"), { recursive: true })
writeFileSync(join(NDMAIN, "api", "hono", "src", "bin", "dashboard-ask.ts"), "")
writeFileSync(join(NDMAIN, "api", "hono", "src", "bin", "dashboard-thread.ts"), "")
writeFileSync(join(NDMAIN, "package.json"), `${JSON.stringify({ scripts: SCRIPT_LINES })}\n`)
git(NDMAIN, "add", ".")
git(NDMAIN, "commit", "-q", "-m", "base")
git(NDMAIN, "worktree", "add", "-q", "--detach", NDWORK)
const PRIOR_REPO = process.env.PLAYGROUND_REPO
process.env.PLAYGROUND_REPO = NDMAIN
afterAll(() =>
  PRIOR_REPO === undefined
    ? delete process.env.PLAYGROUND_REPO
    : (process.env.PLAYGROUND_REPO = PRIOR_REPO),
)

type Run = (raw: string, home: string) => Promise<string | undefined>

// Each guard's check() by the name this file calls it: the source's, and the bundle's its wrapper runs.
// oxlint-disable-next-line typescript/no-explicit-any
type Checks = Record<(typeof CHECK_NAMES)[number], (...args: any[]) => Promise<string | undefined>>
const CHECK_NAMES = [
  "desktopOwnerApp",
  "envDump",
  "extensionRepoWrite",
  "extensionsWrite",
  "glmHeavyPath",
  "headlessLogin",
  "killByName",
  "linearTicket",
  "mainCheckout",
  "playgroundLeak",
  "publicLeak",
  "rawDelete",
  "rawSpawn",
  "releaseComment",
  "stash",
  "unslottedRun",
] as const
const SOURCE: Checks = {
  desktopOwnerApp,
  envDump,
  extensionRepoWrite,
  extensionsWrite,
  glmHeavyPath,
  headlessLogin,
  killByName,
  linearTicket,
  mainCheckout,
  playgroundLeak,
  publicLeak,
  rawDelete,
  rawSpawn,
  releaseComment,
  stash,
  unslottedRun,
}
const GUARD_OF: Record<(typeof CHECK_NAMES)[number], Guard> = {
  desktopOwnerApp: "no-desktop-owner-app",
  envDump: "no-env-dump",
  extensionRepoWrite: "no-extension-repo-write",
  extensionsWrite: "no-extensions-write",
  glmHeavyPath: "no-glm-heavy-path",
  headlessLogin: "no-headless-login",
  killByName: "no-kill-by-name",
  linearTicket: "no-linear-ticket",
  mainCheckout: "no-main-checkout",
  playgroundLeak: "no-playground-leak",
  publicLeak: "no-public-leak",
  rawDelete: "no-raw-delete",
  rawSpawn: "no-raw-spawn",
  releaseComment: "no-release-comment",
  stash: "no-stash",
  unslottedRun: "no-unslotted-run",
}

// Each guard's bundle, copied into a scratch checkout with no node_modules above it, as a damaged install leaves one; the folders the bundles read beside them (extensions' lists, the settings reader role.ts runs in its own process) link to this checkout's.
const bundledCheckout = (root: string) => {
  const dir = join(root, "scripts", "hooks", "bundled")
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(join(CHECKOUT, "scripts", "hooks", "bundled")))
    copyFileSync(join(CHECKOUT, "scripts", "hooks", "bundled", file), join(dir, file))
  for (const path of [
    "extensions",
    "packages",
    join("scripts", "roster-statuses.json"),
    join("scripts", "spawn.sh"),
  ])
    symlinkSync(join(CHECKOUT, path), join(root, path))
  return dir
}
const BUNDLED_DIR = bundledCheckout(join(SCRATCH, "bundled-checkout"))
// A guard registered on Bash alone has no bundle of its own: guards.js runs it, so its bundled check is guards.js's entry for it.
type GuardsBundle = {
  GUARDS: {
    name: string
    run: (raw: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>
  }[]
}
const GUARDS_BUNDLE = (await import(join(BUNDLED_DIR, "guards.js"))) as GuardsBundle
// guards.js passes no main checkout, so no-unslotted-run reads its bundle's own: this copy sits in a worktree of PATHS.MAIN by its .git file, as its source is handed PATHS.MAIN
const WORKTREE_BUNDLED = join(SCRATCH, "bundled-worktree")
const WORKTREE_GUARDS_BUNDLE = (await import(
  join(bundledCheckout(WORKTREE_BUNDLED), "guards.js")
)) as GuardsBundle
writeFileSync(
  join(WORKTREE_BUNDLED, ".git"),
  `gitdir: ${join(PATHS.MAIN, ".git", "worktrees", "bundled")}\n`,
)
const TAKES_MAIN = new Set(["no-unslotted-run"])
const inGuardsBundle = (guard: string) =>
  (TAKES_MAIN.has(guard) ? WORKTREE_GUARDS_BUNDLE : GUARDS_BUNDLE).GUARDS.find(
    ({ name }) => name === guard,
  )
const BUNDLED: Checks = Object.fromEntries(
  await Promise.all(
    CHECK_NAMES.map(async (name) => {
      const own = join(BUNDLED_DIR, `${GUARD_OF[name]}.js`)
      if (existsSync(own)) return [name, (await import(own)).check]
      const entry = inGuardsBundle(GUARD_OF[name])
      if (!entry) throw new Error(`${GUARD_OF[name]} has no bundle and guards.js runs none of it`)
      return [name, (raw: string, env?: NodeJS.ProcessEnv) => entry.run(raw, env ?? process.env)]
    }),
  ),
) as Checks

// A reviewer of a made-up outside author's PR, for no-outside-pr-code: its skill scripts are real files whose shebangs the live lookup reads, and its clones real folders whose .git and bunfig.toml it finds; the main checkout, which holds a bunfig.toml of its own, is PATHS.MAIN.
const REVIEW = join(SCRATCH, "review")
const CLONE = join(REVIEW, "outside")
const UNDER_BUNFIG = join(REVIEW, "under-bunfig")
const PLAIN = join(REVIEW, "plain")
const ENV_CLONE = join(REVIEW, "env-file")
const LOOSE = join(REVIEW, "loose")
for (const dir of [
  join(ENV_CLONE, ".git"),
  join(LOOSE, "sub"),
  join(PATHS.MAIN, ".git"),
  join(PATHS.MAIN, "docs"),
  join(CLONE, ".git"),
  join(CLONE, "sub"),
  join(CLONE, "own"),
  join(UNDER_BUNFIG, "clone", ".git"),
  join(PLAIN, ".git"),
])
  mkdirSync(dir, { recursive: true })
for (const folder of [CLONE, join(CLONE, "own"), UNDER_BUNFIG, PATHS.MAIN])
  writeFileSync(join(folder, "bunfig.toml"), 'preload = ["./pre.ts"]\n')
// an env file bun loads into the script's variables, a harmless one: the hook judges the folder, never the file's lines
for (const folder of [ENV_CLONE, PATHS.MAIN]) writeFileSync(join(folder, ".env"), "MADE_UP=1\n")
for (const skills of [
  join(DATA, "orgs", "home", "abc123", "skills"),
  join(PATHS.MAIN, "extensions", "core", "skills"),
]) {
  const scripts = join(skills, "code-review-loop", "scripts")
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, "state.ts"), "#!/usr/bin/env bun\n")
  writeFileSync(join(scripts, "script.py"), "#!/usr/bin/env python3\n")
  writeFileSync(join(scripts, "state.mjs"), "#!/usr/bin/env node\n")
  writeFileSync(join(scripts, "canary.ts"), "#!/usr/bin/env bun-canary\n")
  writeFileSync(join(scripts, "glued.ts"), "#!/usr/bin/env -SFOO=1 bun\n")
  writeFileSync(join(scripts, "quoted.ts"), "#!/usr/bin/env -S'bun'\n")
}
const OUTSIDE_PR = {
  author: "ext-dev",
  owner: "acme-owner",
  ownerType: "User",
}

// Each guard's check with the environment its own test gives it, and the folders it runs in, each a cwd and the HOME that goes with it.
const guardsOf = (
  c: Checks,
): Record<Guard, { folders: Partial<Record<Folder, [string, string]>>; run: Run }> => ({
  "no-desktop-owner-app": {
    folders: {
      checkout: [CHECKOUT, HOME],
      home: [HOME, HOME],
      "main checkout": [NDMAIN, HOME],
      worktree: [NDWORK, HOME],
    },
    run: (raw) => c.desktopOwnerApp(raw, { PLAYGROUND_DATA_DIR: DESKTOP }),
  },
  "no-env-dump": { folders: { checkout: [CHECKOUT, HOME] }, run: (raw) => c.envDump(raw) },
  "no-extension-repo-write": {
    folders: { checkout: [OTHER, HOME] },
    run: (raw, home) =>
      c.extensionRepoWrite(raw, {
        HOME: home,
        PLAYGROUND_DATA_DIR: SYNCED,
        PLAYGROUND_ROLE: "worker",
      }),
  },
  "no-extensions-write": {
    folders: {
      "bare home": [PATHS.BARE, PATHS.BARE],
      checkout: [CHECKOUT, HOME],
      "cli folder": [PATHS.CLI_DIR, HOME],
      "data folder": [DATA, HOME],
      "extensions root": [SCOPE, HOME],
      home: [HOME, HOME],
      "process data folder": [join(homedir(), ".playground"), homedir()],
      "process home": [homedir(), homedir()],
      "process tmp": [tmpdir(), homedir()],
      "process worktree": [join(homedir(), "x", ".claude", "worktrees", "y"), homedir()],
      tmp: ["/tmp", HOME],
    },
    run: (raw, home) => c.extensionsWrite(raw, { HOME: home }),
  },
  "no-glm-heavy-path": {
    folders: { "glm org repo": [GLM_ORG_REPO, HOME], "glm repo": [GLM_REPO, HOME] },
    run: (raw) =>
      c.glmHeavyPath(
        raw,
        {
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          PLAYGROUND_DATA_DIR: join(LEAK, "playground"),
        },
        1,
      ),
  },
  "no-headless-login": {
    folders: { checkout: [CHECKOUT, "/nonexistent"] },
    run: (raw, home) =>
      c.headlessLogin(raw, {
        CLAUDE_CONFIG_DIR: "/nonexistent",
        HOME: home,
        PLAYGROUND_ROLE: "worker",
      }),
  },
  "no-kill-by-name": { folders: { checkout: [CHECKOUT, HOME] }, run: (raw) => c.killByName(raw) },
  "no-linear-ticket": {
    folders: { checkout: [CHECKOUT, HOME], "data folder": [DATA, HOME] },
    run: (raw, home) =>
      c.linearTicket(raw, {
        CLAUDE_CONFIG_DIR: TICKETS,
        HOME: home,
        PLAYGROUND_DATA_DIR: DATA,
        PLAYGROUND_ROLE: "worker",
      }),
  },
  "no-main-checkout": {
    folders: {
      checkout: [join(PATHS.MAIN, ".claude", "worktrees", "a"), HOME],
      home: [HOME, HOME],
      "main checkout": [PATHS.MAIN, HOME],
    },
    run: (raw, home) => c.mainCheckout(raw, { HOME: home }, PATHS.MAIN),
  },
  // run from its source alone, since this guard has no bundle
  "no-outside-pr-code": {
    folders: {
      "main checkout": [PATHS.MAIN, HOME],
      "main checkout subfolder": [join(PATHS.MAIN, "docs"), HOME],
      "outside clone": [CLONE, HOME],
      "outside clone subfolder": [join(CLONE, "sub"), HOME],
      "outside clone subfolder with bunfig": [join(CLONE, "own"), HOME],
      "outside clone under a bunfig": [join(UNDER_BUNFIG, "clone"), HOME],
      "outside clone with an env file": [ENV_CLONE, HOME],
      "plain clone": [PLAIN, HOME],
      "scratch folder": [join(LOOSE, "sub"), HOME],
      "unknown folder": ["outside", HOME],
    },
    run: (raw, home) => {
      const environment = { HOME: home, PATH: "/usr/bin:/bin", PLAYGROUND_ROLE: "reviewer" }
      return outsidePrCode(raw, environment, {
        ...live(environment),
        author: async () => OUTSIDE_PR,
        main: PATHS.MAIN,
        prsOf: async () => ["https://github.com/acme-owner/widgets/pull/501"],
      })
    },
  },
  "no-playground-leak": {
    folders: { "data folder": [DATA, HOME], home: [HOME, HOME] },
    run: (raw) =>
      c.playgroundLeak(
        raw,
        { CLAUDE_CONFIG_DIR: LEAK, PLAYGROUND_DATA_DIR: join(LEAK, "playground") },
        undefined,
        LISTS,
      ),
  },
  "no-public-leak": {
    folders: { checkout: [CHECKOUT, HOME], home: [HOME, HOME] },
    run: (raw) => c.publicLeak(raw, { CLAUDE_CONFIG_DIR: SCRATCH, PLAYGROUND_DATA_DIR: LISTLESS }),
  },
  "no-raw-delete": {
    folders: {
      checkout: [CHECKOUT, HOME],
      "process data folder": [join(homedir(), ".playground"), homedir()],
      "process home": [homedir(), homedir()],
      "process worktree": [join(homedir(), "x", ".claude", "worktrees", "y"), homedir()],
    },
    run: (raw) => c.rawDelete(raw),
  },
  "no-raw-spawn": { folders: { checkout: [CHECKOUT, HOME] }, run: (raw) => c.rawSpawn(raw) },
  "no-release-comment": {
    folders: { checkout: [OTHER, HOME] },
    run: (raw) => c.releaseComment(raw, { PLAYGROUND_DATA_DIR: OWNED }),
  },
  "no-stash": {
    folders: { checkout: [CHECKOUT, HOME], "data folder": [DATA, HOME], home: [HOME, HOME] },
    run: (raw) => c.stash(raw, {}),
  },
  "no-unslotted-run": {
    folders: {
      checkout: [join(PATHS.MAIN, ".claude", "worktrees", "a"), HOME],
      "main checkout": [PATHS.MAIN, HOME],
    },
    run: (raw, home) => c.unslottedRun(raw, { HOME: home, PLAYGROUND_ROLE: "worker" }, PATHS.MAIN),
  },
})

const GUARDS = guardsOf(SOURCE)
const BUNDLED_GUARDS = guardsOf(BUNDLED)
const BUNDLED_PASS = new Set<Guard>(Object.values(GUARD_OF))

const input = (call: Call, cwd: string) =>
  JSON.stringify(
    typeof call === "string"
      ? { cwd, hook_event_name: "PreToolUse", tool_input: { command: call }, tool_name: "Bash" }
      : { cwd, hook_event_name: "PreToolUse", tool_input: call.input, tool_name: call.tool },
  )

const CASES = REFUSED_FORMS.flatMap(({ folders, guards, rows, source }) =>
  rows(PATHS).flatMap(([what, call, own]) =>
    guards.flatMap((guard) =>
      (own ? [own] : folders).map((folder) => ({
        call,
        folder,
        guard,
        id: `${source} ${what}`,
        key: `${source} ${what} | ${guard} | ${folder}`,
      })),
    ),
  ),
)

const allowed = ({ id, key }: { id: string; key: string }) =>
  ALLOWED.includes(id) || ALLOWED.includes(key)

// #646's refusals each name the fix a session can make at once; its #603 row that canary's redirect check refuses keeps canary's reason
const FIX =
  /hold it in the same call \(X=<path>; .+ "\$X"\) or write the path literally|cd to a literal path first, or name the path absolutely|write the value literally (?:with git -c|in the call)/
const PINNED = "#646 a redirect into the root after a cd that may not run"

describe("each refusal of a #646 row names its fix", () => {
  test.each(
    CASES.filter(
      (c) => c.id.startsWith("#646 ") && c.guard === "no-extensions-write" && c.id !== PINNED,
    ).map((c) => [c.key, c] as const),
  )("%s", async (_, c) => {
    const at = GUARDS[c.guard].folders[c.folder] as [string, string]
    expect(await GUARDS[c.guard].run(input(c.call, at[0]), at[1])).toMatch(FIX)
  })
})

describe("each refusal of a #1198 row names the eval and its fix", () => {
  test.each(CASES.filter((c) => c.id.startsWith("#1198 ")).map((c) => [c.key, c] as const))(
    "%s",
    async (_, c) => {
      const at = GUARDS[c.guard].folders[c.folder] as [string, string]
      expect(await GUARDS[c.guard].run(input(c.call, at[0]), at[1])).toContain(
        "a value the hook cannot read; run its commands as calls of their own, with no eval",
      )
    },
  )
})

// a call the shell runs when it reads an unquoted heredoc's body is judged as one typed on the line, so its refusal names the call itself: the settings set of a guard key, or the rm on the root, which from a folder above the root reads as the root in its text, as a typed rm does
describe("each no-extensions-write refusal of a #1428 row names the call as one typed on the line does", () => {
  test.each(
    CASES.filter(
      (c) => c.id.startsWith("#1428 ") && c.guard === "no-extensions-write" && !allowed(c),
    ).map((c) => [c.key, c] as const),
  )("%s", async (_, c) => {
    const at = GUARDS[c.guard].folders[c.folder] as [string, string]
    expect(await GUARDS[c.guard].run(input(c.call, at[0]), at[1])).toMatch(
      /playground settings set of live\.branch, a key a guard reads|refuses rm on \S+\/extensions( in its text)?:/,
    )
  })
})

// A Bash row of a guard guards.ts runs reaches it through guards.ts's check(), gated as a factory session's call, with the guard set up as its own test sets it up.
const dispatched = (guard: Guard) => DISPATCHED.find((g) => g.name === guard)
const verdict = (c: (typeof CASES)[number], cwd: string, home: string) => {
  const entry = dispatched(c.guard)
  if (typeof c.call !== "string" || !entry) return GUARDS[c.guard].run(input(c.call, cwd), home)
  return dispatch(input(c.call, cwd), { PLAYGROUND_ROLE: "worker" }, [
    { ...entry, run: (raw) => GUARDS[c.guard].run(raw, home) },
  ])
}

describe("every refused form stays refused unless the allow list names it", () => {
  test.each(CASES.map((c) => [c.key, c] as const))(
    "%s",
    async (_, c) => {
      const at = GUARDS[c.guard].folders[c.folder]
      if (!at) throw new Error(`${c.guard} has no ${c.folder} folder`)
      const reason = await verdict(c, at[0], at[1])
      if (allowed(c)) expect(reason).toBeUndefined()
      else expect(reason).toContain(`${c.guard} hook `)
    },
    60_000,
  )

  // the extensions root left out, since no-extensions-write refuses any program run inside it
  test.each(
    Object.entries(GUARDS).flatMap(([guard, { folders }]) =>
      Object.keys(folders)
        .filter((folder) => folder !== "extensions root")
        .map((folder) => [guard, folder] as const),
    ),
  )("%s's setup lets a plain call run from its %s folder", async (guard, folder) => {
    const { folders, run } = GUARDS[guard as Guard]
    const at = folders[folder as Folder] as [string, string]
    expect(await run(input("true", at[0]), at[1])).toBeUndefined()
  })

  test("each row's name is its source's only one", () => {
    const ids = new Set<string>()
    for (const { guards, rows, source } of REFUSED_FORMS)
      for (const [what] of rows(PATHS))
        for (const guard of guards) {
          const id = `${source} ${what} | ${guard}`
          expect(ids.has(id)).toBe(false)
          ids.add(id)
        }
  })

  // A recursive rm (-r, -R or --recursive, alone or in a cluster) and the folder it names, read from a row's text, where a backslash starts an escape (printf's \n) rather than the folder's name.
  const RECURSIVE = /\brm\s+((?:-\S+\s+)*)([^\s'"`;)&|\\]+)/g
  // A folder named from HOME, and a cd or pushd to HOME, after which a relative folder is in HOME too; a bare cd or pushd goes there as well, as the shared reader reads one
  const HOME_PATH = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/
  const CD_HOME = /\b(?:cd|pushd)\s+(?:~|\$HOME|\$\{HOME\})\/?(?=[\s;&|)]|$)/
  // A bare cd or pushd, with no folder word and a redirect of its own aside, which the shared reader reads as the home too
  const BARE_HOME = /\b(?:cd|pushd)(?:\s+\d?>{1,2}\s*\S+)*\s*(?=[;&|)]|$)/
  // A folder written from ~ is NEVER_MADE itself, or a glob of it that keeps its last name
  const never = (path: string) =>
    path.endsWith(NEVER_MADE.slice(NEVER_MADE.lastIndexOf("/"))) &&
    new Bun.Glob(path).match(NEVER_MADE)
  // Each recursive delete in a text whose folder is in HOME and is not NEVER_MADE
  const homeDeletes = (text: string) =>
    [...text.matchAll(RECURSIVE)].flatMap(({ 0: rm, 1: flags = "", 2: target = "", index = 0 }) => {
      if (!/(?:^|\s)(?:-[a-zA-Z]*[rR]|--recursive)/.test(flags)) return []
      const path = HOME_PATH.test(target)
        ? target.replace(HOME_PATH, "~")
        : !/^[/~$]/.test(target) &&
            (CD_HOME.test(text.slice(0, index)) || BARE_HOME.test(text.slice(0, index)))
          ? `~/${target}`
          : undefined
      return path !== undefined && !never(path) ? [rm] : []
    })

  test("every recursive delete from HOME names a path under the root that never exists", () => {
    const left: string[] = []
    for (const { rows, source } of REFUSED_FORMS)
      for (const [what, call] of rows(PATHS)) {
        const text = typeof call === "string" ? call : JSON.stringify(call)
        for (const rm of homeDeletes(text)) left.push(`${source} ${what}: ${rm}`)
      }
    expect(left).toEqual([])
  })

  // Test files that hold commands as strings outside the fixture, read line by line as source, a \n escape read as the line break it writes
  test.each([
    "tests/packages/scripts/src/playground/picker.test.ts",
    "tests/scripts/hooks/no-extensions-write.test.ts",
  ])(
    "every recursive delete from HOME in %s names a path under the root that never exists",
    (file) => {
      const lines = readFileSync(join(CHECKOUT, file), "utf8").split("\n")
      const left = lines.flatMap((line, i) =>
        homeDeletes(line.replaceAll("\\n", "\n")).map((rm) => `${file}:${i + 1}: ${rm}`),
      )
      expect(left).toEqual([])
    },
  )

  test("every allow-list entry names a case", () => {
    for (const entry of ALLOWED)
      expect(CASES.some(({ id, key }) => entry === id || entry === key)).toBe(true)
  })
})

// A Codex session's hook input (codex-cli 0.167.1): its own fields beside Claude Code's, a shell call as Bash with its command, an MCP call by its mcp__ name and arguments, and an edit in two shapes, an apply_patch call whose command is the patch, or an apply_patch command run in the shell.
const THREAD = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"
const CODEX_FIELDS = {
  model: "gpt-made-up",
  permission_mode: "bypassPermissions",
  session_id: THREAD,
  tool_use_id: "call-made-up",
  transcript_path: null,
  turn_id: "turn-made-up",
}
const EDITS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"])
const added = (text: string) =>
  text
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n")
// The patch Codex sends for an edit row: a Write adds its file, every other edit updates it.
const patchOf = ({ input }: { input: Record<string, unknown> }) => {
  const path = String(input.file_path ?? input.notebook_path)
  const body =
    typeof input.content === "string"
      ? `*** Add File: ${path}\n${added(input.content)}`
      : `*** Update File: ${path}\n@@\n-${String(input.old_string ?? "x")}\n${added(String(input.new_string ?? "y"))}`
  return `*** Begin Patch\n${body}\n*** End Patch`
}
type Shape = { input: Record<string, unknown>; shape: string; tool: string }
// Each Codex shape of a row; a read by Read, Glob or Grep has none, since Codex reads through the shell.
const codexShapes = (call: Call): Shape[] => {
  if (typeof call === "string") return [{ input: { command: call }, shape: "shell", tool: "Bash" }]
  if (call.tool.startsWith("mcp__")) return [{ input: call.input, shape: "mcp", tool: call.tool }]
  if (!EDITS.has(call.tool)) return []
  const patch = patchOf(call)
  return [
    { input: { command: patch }, shape: "apply_patch call", tool: "apply_patch" },
    {
      input: { command: `apply_patch <<'EOF'\n${patch}\nEOF` },
      shape: "apply_patch in the shell",
      tool: "Bash",
    },
  ]
}
const codexInput = ({ input, tool }: Shape, cwd: string) =>
  JSON.stringify({
    ...CODEX_FIELDS,
    cwd,
    hook_event_name: "PreToolUse",
    tool_input: input,
    tool_name: tool,
  })
const CODEX_CASES = CASES.flatMap((c) =>
  codexShapes(c.call).map((shape) => ({ ...c, codex: shape, key: `${c.key} | ${shape.shape}` })),
)

describe("every refused form stays refused in its Codex shape", () => {
  test.each(CODEX_CASES.map((c) => [c.key, c] as const))(
    "%s",
    async (_, c) => {
      const at = GUARDS[c.guard].folders[c.folder] as [string, string]
      const reason = await GUARDS[c.guard].run(codexInput(c.codex, at[0]), at[1])
      if (allowed(c)) expect(reason).toBeUndefined()
      else expect(reason).toContain(`${c.guard} hook `)
    },
    60_000,
  )

  test("every edit row has both Codex edit shapes", () => {
    const edits = CASES.filter((c) => typeof c.call !== "string" && EDITS.has(c.call.tool))
    expect(edits.length).toBeGreaterThan(0)
    for (const c of edits)
      expect(codexShapes(c.call).map((s) => s.shape)).toEqual([
        "apply_patch call",
        "apply_patch in the shell",
      ])
  })
})

// Each path flag a row names, listed once, with the joins its program reads between the flag and its folder: "=" joined, " " spaced, "" attached; git reads -C spaced alone.
const PATH_FLAGS = [
  { flag: "--cwd", joins: ["=", " "], program: "bun" },
  { flag: "--cwd", joins: ["=", " "], program: "bunx" },
  { flag: "--chdir", joins: ["=", " "], program: "env" },
  { flag: "-C", joins: [" ", ""], program: "env" },
  { flag: "-D", joins: [" ", ""], program: "gh" },
  { flag: "-C", joins: [" "], program: "git" },
  { flag: "--exec-path", joins: ["="], program: "git" },
  { flag: "--git-dir", joins: ["=", " "], program: "git" },
  { flag: "--work-tree", joins: ["=", " "], program: "git" },
  { flag: "-C", joins: [" ", ""], program: "tar" },
  { flag: "-d", joins: [" ", ""], program: "unzip" },
] as const
type PathFlag = (typeof PATH_FLAGS)[number]

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// The program, the words before its flag, the join and a folder of plain characters alone, so a folder held in a variable, written from ~ or quoted stays as its row writes it
const flagIn = ({ flag, joins, program }: PathFlag) =>
  new RegExp(
    `((?:^|[\\s;&|(])${escaped(program)}\\s(?:[^;&|\\n'"\`]*?\\s)?)${escaped(flag)}(${joins.map((j) => (j === " " ? "\\s+" : escaped(j))).join("|")})([\\w.,@+:/-]+)(?=$|[\\s;&|)])`,
    "g",
  )
const LINKS = join(SCRATCH, "spelling-links")
mkdirSync(LINKS)
let links = 0
const realOf = (path: string, physical = false) => {
  try {
    return statSync(path).isDirectory()
      ? (physical ? realpathSync.native : realpathSync)(path)
      : undefined
  } catch {
    return undefined
  }
}

// Each row and path flag that keeps its single spelling, with why: the row moves folders (cd, pushd, popd), or the flag names no folder; the pinned list below shows a row that stops being spelt
const UNSPELT = new Set<string>()

// Each other spelling of one path flag's folder in a case's call: its other joins, the folder relative from the case's own folder, a ./ hop, an <x>/../<x> hop and a link made in a scratch folder, each kept only where it names the folder the row's does, by its real path.
function spellingsOf(call: Call, cwd: string, id: string): { spelling: string; text: string }[] {
  if (typeof call !== "string" || !isAbsolute(cwd)) return []
  const moves = /\b(?:cd|pushd|popd)\b/.test(call)
  const found: { spelling: string; text: string }[] = []
  for (const pathFlag of PATH_FLAGS)
    for (const m of call.matchAll(flagIn(pathFlag))) {
      const [all, before = "", glue = "", folder = ""] = m
      const at = resolve(cwd, folder)
      const real = moves ? undefined : realOf(at)
      // a `..` after a link names the folder above the link's target, which resolve() reads as the folder above the link, so no spelling built from `at` names the folder the row's does
      const kernel = realOf(isAbsolute(folder) ? folder : `${cwd}/${folder}`, true)
      const climbs = !!real && kernel !== undefined && kernel !== real
      if (!real || climbs) {
        UNSPELT.add(
          `${id} | ${pathFlag.program} ${pathFlag.flag}, ${moves ? "it moves folders" : climbs ? "it climbs out of a link" : "no folder"}`,
        )
        continue
      }
      const own = /^\s+$/.test(glue) ? " " : glue
      const rel = relative(cwd, at) || "."
      const link = join(LINKS, `${++links}-${basename(at)}`)
      symlinkSync(at, link)
      const others: [string, string, string][] = [
        ...pathFlag.joins
          .filter((j) => j !== own)
          .map((j) => [`${JSON.stringify(j)} join`, j, folder] as [string, string, string]),
        ["relative from its folder", own, rel],
        ["a ./ hop", own, `./${rel}`],
        ["an <x>/../<x> hop", own, `${dirname(at)}/../${basename(dirname(at))}/${basename(at)}`],
        ["a link in a scratch folder", own, link],
      ]
      for (const [spelling, j, path] of others) {
        if (path === folder && j === own) continue
        if (realOf(resolve(cwd, path)) !== real) continue
        const text =
          call.slice(0, m.index) +
          before +
          pathFlag.flag +
          j +
          path +
          call.slice(m.index! + all.length)
        found.push({ spelling: `${pathFlag.program} ${pathFlag.flag}, ${spelling}`, text })
      }
    }
  return found
}

const SPELLINGS = CASES.flatMap((c) => {
  const at = GUARDS[c.guard].folders[c.folder]
  return at ? spellingsOf(c.call, at[0], c.id).map((s) => ({ ...c, ...s, at })) : []
})

describe("every spelling of a row's path flag keeps the row's verdict", () => {
  // the row's own verdict, read once per case
  const verdicts = new Map<string, string | undefined>()
  const verdictOf = async (c: (typeof SPELLINGS)[number]) => {
    if (!verdicts.has(c.key))
      verdicts.set(c.key, await GUARDS[c.guard].run(input(c.call, c.at[0]), c.at[1]))
    return verdicts.get(c.key)
  }

  test.each(SPELLINGS.map((s) => [`${s.key} | ${s.spelling}`, s] as const))(
    "%s",
    async (_, s) => {
      const row = await verdictOf(s)
      const spelt = await GUARDS[s.guard].run(input(s.text, s.at[0]), s.at[1])
      expect({ refused: spelt !== undefined, text: s.text }).toEqual({
        refused: row !== undefined,
        text: s.text,
      })
      if (spelt !== undefined) expect(spelt).toContain(`${s.guard} hook `)
    },
    60_000,
  )

  test("the rows whose path flag keeps its single spelling are the ones pinned here", () => {
    expect([...UNSPELT].sort()).toEqual([
      // a `..` after a link, which the kernel reads from the link's target
      "#1663 a commit by one -C that climbs out of a link | git -C, it climbs out of a link",
      // the row's cd moves the shell, so its --cwd is read from a folder no spelling knows
      "#1663 turbo by bunx --cwd that runs only when the cd before its || failed | bunx --cwd, it moves folders",
      // bunx's spelling takes the row's last --cwd, which bun reads from the --cwd=/ before it, so the row's own folder holds none
      "#1732 a runner --cwd read from the one before it | bunx --cwd, no folder",
      "#1732 turbo's relative --cwd read from the runner's | bunx --cwd, no folder",
      "#1747 bunx running a commit in a --cwd read from the one before | bunx --cwd, no folder",
      "#1747 bunx running bun's build in a --cwd in a worktree read from the one before | bunx --cwd, no folder",
      "#1747 bunx running bun's build in a --cwd read from the one before | bunx --cwd, no folder",
      "#466 git --work-tree with a subcommand for its value | git --work-tree, no folder",
      "#466 git -C with a subcommand for its value | git -C, no folder",
    ])
  })

  // Every flag a row gives a folder, joined by =, by spaces or attached as /… or ./…, read from the row's text wherever its program sits
  const FLAG_FOLDER =
    /(?<=^|[\s;&|(])(--?[A-Za-z][\w-]*?)(?:(?:=|\s+)([^\s;&|()'"`$\\]+)|([/.][^\s;&|()'"`$\\]*))(?=$|[\s;&|)])/g
  test("every flag a row gives a folder is in PATH_FLAGS, or pinned here as no path flag", () => {
    const left = new Set<string>()
    for (const c of CASES) {
      const at = GUARDS[c.guard].folders[c.folder]
      if (typeof c.call !== "string" || !at) continue
      const call = c.call
      const listed = new Set(
        PATH_FLAGS.flatMap((p) => [...call.matchAll(flagIn(p))].map((m) => `${p.flag} ${m[3]}`)),
      )
      for (const [, flag = "", spaced, attached] of call.matchAll(FLAG_FOLDER)) {
        const value = spaced ?? attached ?? ""
        if (realOf(resolve(at[0], value)) && !listed.has(`${flag} ${value}`))
          left.add(`${c.id} | ${flag}`)
      }
    }
    expect([...left].sort()).toEqual([
      // GNU mv's target folder, on rows that cd to a variable first, so no spelling names the same folder
      "#1173 GNU mv to the shell's folder attached to its short target option after a cd to a variable | -t",
      "#1173 GNU mv to the shell's folder attached to its target option in a cluster after a cd to a variable | -ft",
      "#1173 GNU mv to the shell's folder by its long target option after a cd to a variable | --target-directory",
      "#1173 GNU mv to the shell's folder by its shortened long target option after a cd to a variable | --target",
      // cd's -P, alone or among its other options, which take no value: the folder after it is the cd's own operand
      "#1663 a commit after a cd whose -P comes before -L | -PL",
      "#1663 a commit after a physical cd into a link, then a climb | -P",
      "#1663 a commit after a physical cd that climbs out of a link | -P",
      "#1663 a commit after a quiet physical pushd that climbs out of a link | -qP",
      "#1663 a commit after zsh's quiet physical cd that climbs out of a link | -qP",
      // git's second -C, read from where the first lands through a link, so a spelling of it alone from the row's folder names another folder
      "#1663 a commit by a -C read from a link into the main checkout | -C",
      "#1663 a commit by a -C read from a link named by its absolute path | -C",
      // turbo's own --cwd, which no path flag spells
      "#1663 turbo by its --cwd in a plain folder of the worktrees folder | --cwd",
      "#1663 turbo by its --cwd in the worktrees folder | --cwd",
      // the --cwd=/ that bunx's spelling passes over for the row's last --cwd, read from it
      "#1732 a runner --cwd read from the one before it | --cwd",
      "#1732 turbo's relative --cwd read from the runner's | --cwd",
      "#1747 bunx running a commit in a --cwd read from the one before | --cwd",
      "#1747 bunx running bun's build in a --cwd in a worktree read from the one before | --cwd",
      "#1747 bunx running bun's build in a --cwd read from the one before | --cwd",
      // an option that takes no value, followed by an operand
      "#356 a link to the data folder made in the same call | -s",
      "#356 a write after a word with an unbalanced quote | -rf",
      "#356 many variables ahead of a write | -rf",
      "#356 rm -rf of the data folder above it | -rf",
      "#356 rm -rf of the data folder in ${X:-…} | -rf",
      "#356 rm -rf of the root | -rf",
      "#402 rm of a glob with a .. after it | -rf",
      "#402 rm of a link to the root through a missing folder and .. | -rf",
      "#402 rm through a missing folder, .., then a link to the data folder | -rf",
      "#402 rm through a missing folder, .., then a link to the root | -rf",
      "#402 rm through two missing folders, .., .., then a link to the root | -rf",
      // a folder flag inside a cluster (env -iP, sudo -sD) or behind a quoted program ('env' --ch), which its row holds in that one form
      "#508 ext score behind env's -i grouped with -P | -iP",
      "#533 a removal echoed to sudo's shell, its chdir value a path attached in the cluster | -sD",
      "#716 a recursive delete echoed to sudo's shell in a quoted env's split string after an abbreviated chdir | --ch",
    ])
  })

  test("each path flag is listed once, and each is spelt again on some row", () => {
    const names = PATH_FLAGS.map(({ flag, program }) => `${program} ${flag}`)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names)
      expect({ name, spelt: SPELLINGS.some((s) => s.spelling.startsWith(`${name},`)) }).toEqual({
        name,
        spelt: true,
      })
  })
})

// Each guard PR puts its rows in its own source's file, so two of them merge in either order.
describe("two branches that each add a source's file merge with no conflict, in either order", () => {
  // A new source's file with one row, as a guard PR writes it.
  const sourceFile = (what: string) =>
    [
      `import { type Group } from "./_shared"`,
      ``,
      `export const groups: Group[] = [`,
      `  { folders: ["checkout"], guards: ["no-stash"], rows: () => [[${JSON.stringify(what)}, "git stash"]] },`,
      `]`,
      ``,
      `export const allowed: string[] = [${JSON.stringify(what)}]`,
      ``,
    ].join("\n")

  // A scratch repo holding a copy of the fixture, its reader and its folder, with two branches from one base each adding its own source's file.
  const repo = () => {
    const dir = mkdtempSync(join(SCRATCH, "merge-"))
    const from = join(import.meta.dir, "fixtures")
    mkdirSync(join(dir, "refused-forms"))
    copyFileSync(join(from, "refused-forms.ts"), join(dir, "refused-forms.ts"))
    for (const name of readdirSync(join(from, "refused-forms")))
      copyFileSync(join(from, "refused-forms", name), join(dir, "refused-forms", name))
    git(dir, "init", "-q", "-b", "base")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "base")
    for (const [branch, n] of [
      ["a", 9001],
      ["b", 9002],
    ] as const) {
      git(dir, "checkout", "-q", "-b", branch, "base")
      writeFileSync(join(dir, "refused-forms", `${n}.ts`), sourceFile(`branch ${branch}'s row`))
      git(dir, "add", "-A")
      git(dir, "commit", "-q", "-m", branch)
    }
    return dir
  }

  test.each([
    ["a", "b"],
    ["b", "a"],
  ])("%s, then %s merged into it", async (first, second) => {
    const dir = repo()
    git(dir, "checkout", "-q", first)
    const merge = git(dir, "merge", "-q", "--no-edit", second)
    expect(merge.exitCode).toBe(0)
    expect(git(dir, "diff", "--name-only", "--diff-filter=U").stdout.toString()).toBe("")
    const merged = await import(join(dir, "refused-forms.ts"))
    const sources = merged.REFUSED_FORMS.map((group: { source: string }) => group.source)
    expect(sources).toContain("#9001")
    expect(sources).toContain("#9002")
    expect(merged.ALLOWED).toEqual(
      expect.arrayContaining(["#9001 branch a's row", "#9002 branch b's row"]),
    )
  })
})

// A guard's wrapper runs its bundle, so the bundle is held to its source's verdict on every row, run where no node_modules can be reached.
describe("each bundled guard gives its source's verdict with no node_modules reachable", () => {
  test("no package resolves from the bundles' folder", () => {
    expect(() => Bun.resolveSync("zod", BUNDLED_DIR)).toThrow()
  })

  // A guard with a bundle, its own or guards.js running it, goes through that bundle, so registering one with no entry in GUARD_OF fails here rather than comparing its source with itself.
  test("every guard here has a bundle exactly when GUARD_OF names its check", () => {
    for (const guard of Object.keys(GUARDS))
      expect({
        bundled: existsSync(join(BUNDLED_DIR, `${guard}.js`)) || !!inGuardsBundle(guard),
        guard,
      }).toEqual({
        bundled: BUNDLED_PASS.has(guard as Guard),
        guard,
      })
  })

  test.each(CASES.filter((c) => BUNDLED_PASS.has(c.guard)).map((c) => [c.key, c] as const))(
    "%s",
    async (_, c) => {
      const at = GUARDS[c.guard].folders[c.folder] as [string, string]
      const [source, bundled] = await Promise.all([
        GUARDS[c.guard].run(input(c.call, at[0]), at[1]),
        BUNDLED_GUARDS[c.guard].run(input(c.call, at[0]), at[1]),
      ])
      expect(bundled === undefined).toBe(source === undefined)
      if (bundled !== undefined) expect(bundled).toContain(`${c.guard} hook `)
    },
    60_000,
  )

  test("the bundled no-extensions-write's worker gives its check's verdict", async () => {
    const { guarded } = await import(join(BUNDLED_DIR, "no-extensions-write.js"))
    const refused = CASES.find((c) => c.guard === "no-extensions-write" && !allowed(c))!
    const [cwd, home] = GUARDS["no-extensions-write"].folders[refused.folder]!
    expect(await guarded(input(refused.call, cwd), { HOME: home })).toContain(
      "no-extensions-write hook ",
    )
    expect(await guarded(input("true", CHECKOUT), { HOME })).toBeUndefined()
  })
})
