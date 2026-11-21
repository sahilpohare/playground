import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  deriveRoot,
  extGit,
  extRepoOf,
  loginOf,
  scopeDir,
  scopesIn,
  secretIn,
  withLock,
} from "@packages/settings"

import type { Run } from "../ops-tick/tick"

// ext sync: each scope's clone in the extensions folder pulled with rebase from, then pushed to, its private repository, <login>/playground-<scope> unless ext.repos names another, once its files and its history pass the secrets scan (secretIn on every file, and gitleaks when installed). The root's derived files are rebuilt after, so what the pulls brought reaches sessions. It never creates a repository; playground ext init does.

// The repository a scope syncs with and the URL gh gives for it, or why it stays local; a public one is refused, since a scope holds private prose.
export const remoteOf = async (
  run: Run,
  slug: string,
): Promise<{ url: string } | { local: string } | { refused: string }> => {
  const viewed = await run(
    ["gh", "repo", "view", slug, "--json", "visibility,url", "--jq", '.visibility + " " + .url'],
    120_000,
  )
  if (viewed.code !== 0) return { local: `there is no ${slug}; playground ext init creates it` }
  const [visibility = "", url = ""] = viewed.out.trim().split(" ")
  if (visibility !== "PRIVATE")
    return {
      refused: `${slug} is ${visibility.toLowerCase()}, and a scope syncs only with a private repository`,
    }
  return { url }
}

// Which of a scope's files hold something secret-shaped, by path and kind, never the text.
export const secretsIn = (dir: string): string[] =>
  extGit(dir, ["ls-files", "-z"])
    .out.split("\0")
    .filter(Boolean)
    .map((path) => [path, secretIn(readFileSync(join(dir, path), "utf8"))] as const)
    .filter(([, kind]) => kind)
    .map(([path, kind]) => `${path} holds ${kind}`)

// One scope synced, as its line, or why not, thrown.
const syncScope = async (data: string, scope: string, slug: string, run: Run): Promise<string> => {
  const where = await remoteOf(run, slug)
  if ("refused" in where) throw new Error(`${scope}: refused: ${where.refused}`)
  const dir = scopeDir(data, scope)
  const found = secretsIn(dir)
  if (Bun.which("gitleaks", { PATH: process.env.PATH ?? "" })) {
    const scan = await run(["gitleaks", "git", dir, "--no-banner", "--redact"], 300_000)
    if (scan.code !== 0)
      found.push("gitleaks found a leak in its history (gitleaks git <folder> --redact names it)")
  }
  if (found.length) throw new Error(`${scope}: refused, nothing pushed: ${found.join("; ")}`)
  if ("local" in where) return `${scope} stays on this machine: ${where.local}`
  if (extGit(dir, ["rev-parse", "-q", "--verify", "HEAD"]).code !== 0)
    return `${scope} has no commit yet, so nothing is pushed`
  const git = (...args: string[]) => {
    const done = extGit(dir, args)
    if (done.code !== 0) throw new Error(`${scope}: git ${args[0]} failed: ${done.err}`)
    return done.out
  }
  // every git write here, the fetch and the push included, runs under the one lock, which lifts this scope's folder of a locked root for it
  withLock(
    data,
    () => {
      if (extGit(dir, ["remote", "set-url", "origin", where.url]).code !== 0)
        git("remote", "add", "origin", where.url)
      git("fetch", "-q", "origin")
      if (extGit(dir, ["rev-parse", "-q", "--verify", "origin/main"]).code !== 0) return
      // a rebase commits again, so a machine with no git identity (a fresh runner) takes writeFiles' committer, and one with its own keeps it
      const committer = Object.fromEntries(
        [
          ["user.name", "GIT_COMMITTER_NAME", "Playground"],
          ["user.email", "GIT_COMMITTER_EMAIL", "playground"],
        ]
          .filter(([key]) => extGit(dir, ["config", key!]).code !== 0)
          .map(([, name, value]) => [name!, value!]),
      )
      if (extGit(dir, ["rebase", "-q", "origin/main"], committer).code === 0) return
      extGit(dir, ["rebase", "--abort"])
      throw new Error(
        `${scope}: its commits do not rebase onto ${slug}'s; nothing pushed, so resolve it by hand in ${dir}`,
      )
    },
    { scopes: [scope] },
  )
  withLock(data, () => git("push", "-q", "origin", "HEAD:main"), { scopes: [scope] })
  return `${scope} synced with ${slug} at ${git("rev-parse", "--short", "HEAD")}`
}

// Every scope's clone synced, or the one named; the lines it reports, and it throws naming each scope that was refused or failed, after syncing the rest, so the beat sends it to ops.
export async function syncExtensions({
  data,
  only,
  run,
}: {
  data: string
  only?: string
  run: Run
}): Promise<string[]> {
  const scopes = scopesIn(data).filter((scope) => !only || scope === only)
  if (!scopes.length) return [only ? `no ${only} scope to sync` : "no scope to sync yet"]
  const login = loginOf(data)
  const lines: string[] = []
  const problems: string[] = []
  for (const scope of scopes)
    try {
      lines.push(await syncScope(data, scope, extRepoOf(data, login, scope), run))
    } catch (error) {
      problems.push((error as Error).message)
    }
  withLock(data, () => deriveRoot(data, login))
  if (problems.length) throw new Error(`ext sync: ${[...lines, ...problems].join("; ")}`)
  return lines
}
