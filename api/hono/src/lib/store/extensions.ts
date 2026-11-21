import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  extRepoOf,
  linkExtension,
  listBundled,
  listExtensions,
  loginOf,
  loginPath,
  orderExtensions,
  removeExtension,
  type Result,
  setBundled,
  showItem,
  unlinkExtension,
  type Who,
  writeAtomically,
} from "@packages/settings"

// Relative, not @/: the web's tests type-check this file under web/next's own @/ paths.
import { checkoutRoot, readsLive } from "../dashboard/fixture"
import type { CloneRun, OwnerApps } from "../dashboard/inbox"
import { OWNER_APPS } from "../dashboard/owner-apps"
import { dataDir } from "../sessions/paths"
import { NOT_SET_UP } from "./app-words"

// Settings > Extensions: the extensions in their order with each one's links, and the writes that rearrange them, the same ones `playground ext order|link|unlink|remove` make; Add, Sync now and Why reach GitHub or the skill resolver, so they run `playground ext` itself with a fixed argv, and Add's check before it runs its --dry-run.

export const EXTENSION_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/
export const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/

export type CliRun = { code: number; err: string; out: string }
export type Cli = (args: string[], stdin?: string) => Promise<CliRun>

const CLI_TIMEOUT_MS = 180_000

// `playground ext <args>` from this checkout under this process's bun, reading the data folder the API reads, with no shell, only what gh and git need from the environment, and stdin on its input when given.
export const runCli =
  (cli = join(checkoutRoot() ?? process.cwd(), "packages/scripts/src/playground/cli.ts")): Cli =>
  async (args, stdin) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, "ext", ...args], {
      env: { HOME: process.env.HOME, PATH: process.env.PATH, PLAYGROUND_DATA_DIR: dataDir() },
      stderr: "pipe",
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      timeout: CLI_TIMEOUT_MS,
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, err: err.trim(), out: out.trim() }
  }

// What a clone card's Approve runs with: the CLI, and this checkout's guard lists, which it seeds after the clone (the step `playground ext import --from-tree extensions/core/lists` takes).
export const cloneRun = (): CloneRun => ({
  lists: join(checkoutRoot() ?? process.cwd(), "extensions/core/lists"),
  run: runCli(),
})

const NO_LOGIN = {
  message: `Extensions are kept beside your settings, which are ${NOT_SET_UP}`,
  ok: false,
  status: 409,
} as const

const FIXTURE_GITHUB = {
  message:
    "This stack shows test data, so it reaches no GitHub repo: add or sync from a stack that reads this Mac",
  ok: false,
  status: 409,
} as const

// The owner's own apps list (OwnerApps in inbox.ts): the login's scope, its desktop-owner-apps list as accepted there, and the CLI that writes it; undefined before playground ext init names a login.
export const ownerApps = (data = dataDir(), cli = runCli()): OwnerApps | undefined => {
  let login: string
  try {
    login = loginOf(data)
  } catch {
    return undefined
  }
  return {
    login,
    read: () => {
      const item = showItem(data, { kind: "list", key: OWNER_APPS, scope: login })
      if (item?.state !== "accepted") return []
      const value = item.content.value
      return Array.isArray(value) && value.every((name) => typeof name === "string") ? value : null
    },
    run: cli,
  }
}

// Whether playground ext init has named a login, which every account and extension write needs.
export const hasLogin = (data = dataDir()): boolean => {
  try {
    loginOf(data)
    return true
  } catch {
    return false
  }
}

// gh with no login, in the words Settings shows, since the app has no GitHub sign-in of its own yet.
const NO_GITHUB = {
  message: "Sign in to GitHub first; a Sign in button comes in the next update",
  ok: false,
  status: 409,
} as const

// The fixture's own login (fixtures/dashboard.json), which a fixture stack's setup writes back in place of ext init's run.
const FIXTURE_LOGIN = "taylor"
const FIXTURE_REPO = `${FIXTURE_LOGIN}/playground-${FIXTURE_LOGIN}`

const initRefusal = (run: CliRun): Result<never> =>
  run.err.includes("gh has no login here") ? NO_GITHUB : refusal(run)

// What Set up settings would use on GitHub, through ext init --dry-run, making nothing: the private repository and whether it is there yet; a fixture stack names the fixture's own.
export const checkSettings = async (
  cli: Cli = runCli(),
): Promise<Result<{ exists: boolean; repo: string }>> => {
  if (!readsLive()) return { exists: true, ok: true, repo: FIXTURE_REPO }
  const run = await cli(["init", "--dry-run"])
  if (run.code !== 0) return initRefusal(run)
  const found = JSON.parse(run.out) as { exists: boolean; repo: string }
  return { exists: found.exists, ok: true, repo: found.repo }
}

// Set up settings: ext init --yes, which makes or adopts the login's private repository and names the login, so every account and extension write can go on; a fixture stack reaches no GitHub and writes the fixture's login back.
export const setUpSettings = async (
  cli: Cli = runCli(),
  data = dataDir(),
): Promise<Result<{ repo: string }>> => {
  if (!readsLive()) {
    mkdirSync(dirname(loginPath(data)), { recursive: true })
    writeAtomically(loginPath(data), `${FIXTURE_LOGIN}\n`)
    return { ok: true, repo: FIXTURE_REPO }
  }
  const run = await cli(["init", "--yes"])
  if (run.code !== 0) return initRefusal(run)
  const login = loginOf(data)
  return { ok: true, repo: extRepoOf(data, login, login) }
}

export type ExtensionRow = ReturnType<typeof listExtensions>[number]

export type BundledRow = ReturnType<typeof listBundled>[number]

// The extensions Playground ships under extensions/, each with whether ext.bundled turns it on, or none before playground ext init names a login.
export const bundledOf = (data = dataDir()): BundledRow[] | null =>
  hasLogin(data) ? listBundled(data) : null

// The extensions in priority order with core last, or none before playground ext init names a login.
export const extensionsOf = (data = dataDir()): ExtensionRow[] | null =>
  hasLogin(data) ? listExtensions(data) : null

// The CLI's refusal as the answer: its first line without the command's prefix, a usage error (exit 2) a 400 and any other a 409.
const refusal = (run: CliRun): Result<never> => ({
  message: (run.err.split("\n")[0] ?? "").replace(/^playground ext: /, "") || `exit ${run.code}`,
  ok: false,
  status: run.code === 2 ? 400 : 409,
})

const CREATE = /^playground ext: (\S+) was not created\b/

// ext add as Add asks it: with no yes, a repository that is not there yet comes back as the one it would create, for the page to confirm by name, and nothing is made; with yes, it is made private.
export const addExtension = async (
  input: { name: string; repo?: string; yes: boolean },
  cli: Cli = runCli(),
  data = dataDir(),
): Promise<Result<{ create: string } | { lines: string[] }>> => {
  if (!hasLogin(data)) return NO_LOGIN
  if (!readsLive()) return FIXTURE_GITHUB
  const run = await cli([
    "add",
    input.name,
    ...(input.repo ? [input.repo] : []),
    ...(input.yes ? ["--yes"] : []),
  ])
  if (run.code === 0) return { lines: run.out.split("\n").filter(Boolean), ok: true }
  const create = !input.yes && CREATE.exec(run.err)?.[1]
  return create ? { create, ok: true } : refusal(run)
}

// What Add would find on GitHub before it runs, through ext add --dry-run: the repository it would use, whether it is there yet, and how many entries its skills/ holds; nothing is made.
export const checkExtension = async (
  input: { name: string; repo?: string },
  cli: Cli = runCli(),
  data = dataDir(),
): Promise<Result<{ exists: boolean; repo: string; skills: number }>> => {
  if (!hasLogin(data)) return NO_LOGIN
  if (!readsLive()) return FIXTURE_GITHUB
  const run = await cli(["add", input.name, ...(input.repo ? [input.repo] : []), "--dry-run"])
  if (run.code !== 0) return refusal(run)
  const found = JSON.parse(run.out) as { exists: boolean; repo: string; skills: number }
  return { exists: found.exists, ok: true, repo: found.repo, skills: found.skills }
}

export const syncExtension = async (
  name: string,
  cli: Cli = runCli(),
  data = dataDir(),
): Promise<Result<{ lines: string[] }>> => {
  if (!hasLogin(data)) return NO_LOGIN
  if (!readsLive()) return FIXTURE_GITHUB
  const run = await cli(["sync", name])
  return run.code === 0 ? { lines: run.out.split("\n").filter(Boolean), ok: true } : refusal(run)
}

// Which extension a session in a repo of org (the home set with none) takes skill from, and each one whose copy it hides.
export const whySkill = async (
  skill: string,
  org: string | undefined,
  cli: Cli = runCli(),
  data = dataDir(),
): Promise<Result<{ from: string; shadowed: string[] }>> => {
  if (!hasLogin(data)) return NO_LOGIN
  const run = await cli(["why", skill, ...(org ? ["--org", org] : [])])
  if (run.code !== 0)
    return run.err.includes("no scope holds the skill")
      ? { message: `no extension holds the skill ${skill}`, ok: false, status: 404 }
      : refusal(run)
  const found = JSON.parse(run.out) as { from: string; shadowed: string[] }
  return { from: found.from, ok: true, shadowed: found.shadowed }
}

const withLogin =
  <A extends unknown[], T>(write: (data: string, ...args: A) => Result<T>) =>
  (data: string, ...args: A): Result<T> =>
    hasLogin(data) ? write(data, ...args) : NO_LOGIN

export const orderOf = withLogin((data, names: string[], who: Who) =>
  orderExtensions(data, names, who),
)
export const linkOf = withLogin((data, name: string, org: string, who: Who) =>
  linkExtension(data, name, org, who),
)
export const unlinkOf = withLogin((data, name: string, org: string, who: Who) =>
  unlinkExtension(data, name, org, who),
)
export const removeOf = withLogin((data, name: string, who: Who) =>
  removeExtension(data, name, who),
)
export const bundledSwitchOf = withLogin((data, name: string, on: boolean, who: Who) =>
  setBundled(data, name, on, who),
)
