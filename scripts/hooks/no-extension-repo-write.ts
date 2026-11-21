// PreToolUse hook for the factory's sessions, loaded from the factory settings file and, for a session resumed without its settings, the project settings, acting only for a factory session (role.ts): refuses a write that changes an extension repository's git data or name (a git push, a gh or gh api write, a curl, a GitHub MCP write), since the sync pushes each scope's clone to that repository and renders it into every session's store; issue and pull request conversation there passes, as does a git push of branches other than the default, which ext:merge then lands.
import "../../packages/env/src/aliases"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { dataDir } from "../../packages/env/src/data-dir"
import { scopesIn } from "../../packages/settings/src/folder"
import { extensionsDir, loginOf, readPolicy } from "../../packages/settings/src/rendered"
import { remoteRepo } from "./github"
import { input } from "./input"
import { type Hit, inspectAs, type Policy, refusedList } from "./no-playground-leak"
import { fromFactory } from "./role"
import { withDeadline } from "./shell"

type Environment = Record<string, string | undefined>

const GUARD = "no-extension-repo-write"
const OWNER_ROUTE =
  "Only the owner changes one, typing the command as a ! command in the dispatcher's terminal window: tell your lead what it should do, and the dispatcher hands the owner the command."
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
// GitHub decodes a percent escape in a repository's owner or name.
const decoded = (text: string) =>
  text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )

// The repositories the sync pushes to, lowercase: each ext.repos value, and <login>/playground-<scope> for each scope clone it does not name, under the environment's login and the login file's.
export function guardedRepos(
  data: string,
  values: Record<string, unknown>,
  environment: Environment,
) {
  const given = values["ext.repos"]
  const named = new Map<string, string>()
  if (typeof given === "object" && given !== null)
    for (const [scope, repo] of Object.entries(given))
      if (typeof repo === "string" && REPO.test(repo)) named.set(scope, repo.toLowerCase())
  const repos = new Set(named.values())
  const scopes = scopesIn(data)
  // A clone's origin, which follows a rename or transfer, since the sync pushes to the URL gh resolves.
  for (const scope of scopes) {
    const config = join(extensionsDir(data), scope, ".git", "config")
    const url = Bun.spawnSync(["git", "config", "--file", config, "--get", "remote.origin.url"], {
      stderr: "ignore",
    })
    const repo = remoteRepo(url.stdout.toString())
    if (repo) repos.add(`${repo.owner}/${repo.repo}`.toLowerCase())
  }
  const unnamed = scopes.filter((scope) => !named.has(scope))
  if (unnamed.length === 0) return repos
  const logins = new Set([loginOf(data, environment)])
  try {
    logins.add(loginOf(data, {}))
  } catch {}
  for (const login of logins)
    for (const scope of unnamed) repos.add(`${login}/playground-${scope}`.toLowerCase())
  return repos
}

// A hit is a whole owner/name, so quillco/acme-skills-archive is not quillco/acme-skills.
function finder(repos: Set<string>): (text: string) => Hit | undefined {
  const names = [...repos].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = new RegExp(`(?<![\\w.-])(?:${names.join("|")})(?:\\.git)?(?![\\w.-])`, "i")
  return (text) => {
    const found = pattern.exec(decoded(text))?.[0]
    return found ? { detail: `it names ${found}`, fix: OWNER_ROUTE } : undefined
  }
}

const policy = (repos: Set<string>): Policy => ({
  anyWrite: true,
  branchPush: true,
  find: finder(repos),
  git: true,
  guard: GUARD,
  // An owner of * is one gh picks itself, the signed-in account, so any guarded repository of that name matches; one still holding a % or a / once decoded cannot be placed, so it counts as guarded.
  guarded: (repo) => {
    const owner = decoded(repo.owner).toLowerCase()
    const name = decoded(repo.repo)
      .replace(/\.git$/i, "")
      .toLowerCase()
    if (/[%/]/.test(owner + name)) return true
    if (owner !== "*") return repos.has(`${owner}/${name}`)
    return [...repos].some((guarded) => guarded.endsWith(`/${name}`))
  },
  hosts: false,
  place: "an extension repository",
  what: "a write to an extension repository",
  why: `The sync renders each extension repository's main into every session's store. A session commits in its clone on a branch other than the default, as a git commit call of its own, pushes that branch by its remote and refspec (git push origin HEAD:<branch>), opens a pull request, and lands it with bun run ext:merge <owner>/<repo> <n> at the review's 5/5. For anything else: ${OWNER_ROUTE}`,
})

// Passes every call with no extensions root, since nothing is synced; fails closed, as the leak guards do, only on a call that may write, when policy.json or the login does not read.
export async function check(
  raw: string,
  environment: Environment = process.env,
  budget = 8_000,
): Promise<string | undefined> {
  const data = dataDir(environment)
  if (!existsSync(extensionsDir(data))) return
  const read = await readPolicy(data)
  if (read.refusal !== undefined)
    return refusedList(
      raw,
      `${GUARD} hook refused this call: ${read.refusal}, then run the call again.`,
    )
  let repos: Set<string>
  try {
    repos = guardedRepos(data, read.settings.values, environment)
  } catch (error) {
    return refusedList(
      raw,
      `${GUARD} hook refused this call: ${(error as Error).message}, so it cannot name the extension repositories. ${OWNER_ROUTE}`,
    )
  }
  if (repos.size === 0) return
  // The walk refuses past its deadline, inside the hook's 15s timeout, which would otherwise let the call through.
  return withDeadline(budget, () => inspectAs(policy(repos), raw, environment))
}

if (import.meta.main) {
  const raw = await input("no-extension-repo-write", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
