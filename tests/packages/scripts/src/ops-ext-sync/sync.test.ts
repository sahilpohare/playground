import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { syncExtensions } from "../../../../../packages/scripts/src/ops-ext-sync/sync"
import type { Run } from "../../../../../packages/scripts/src/ops-tick/tick"
import {
  extGit,
  rootLocked,
  setRootLock,
  writeFiles,
} from "../../../../../packages/settings/src/folder"
import { extensionsDir, scopeDir } from "../../../../../packages/settings/src/rendered"
import { setSetting } from "../../../../../packages/settings/src/settings-folder"

process.env.PLAYGROUND_LOGIN = "made-up-me"
const ME = "made-up-me"

const scratch = mkdtempSync(join(tmpdir(), "ext-sync-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))
let n = 0

const who = (reason: string) => ({ actor: "cli", author: "owner", inboxRef: null, reason })
const note = (data: string, scope: string, text: string) =>
  writeFiles(data, scope, new Map([["docs/notes.md", text]]), {
    author: "owner",
    reason: text.trim(),
  })

// A data folder with the login's scope and an org's, each with a scratch bare repository standing in for its private GitHub one; gh answers each repo's visibility and URL, gitleaks finds nothing, unless a rule says otherwise.
const fixture = (visibility: Record<string, string> = {}) => {
  const data = join(scratch, `data-${n++}`)
  setSetting(data, { key: "factory.repo", scope: ME, value: "made-up-me/app" }, who("my repo"))
  note(data, "acme", "an acme note\n")
  const bares: Record<string, string> = {}
  for (const slug of [`${ME}/playground-${ME}`, `${ME}/playground-acme`, "acme/shared"]) {
    bares[slug] = join(scratch, `${n}-${slug.replace("/", "-")}.git`)
    Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bares[slug]!])
  }
  const calls: string[] = []
  const run: Run = async (argv) => {
    calls.push(argv.join(" "))
    if (argv[0] === "gh" && argv[1] === "repo" && argv[2] === "view") {
      const slug = argv[3]!
      if (!bares[slug]) return { code: 1, out: "" }
      return { code: 0, out: `${visibility[slug] ?? "PRIVATE"} ${bares[slug]}\n` }
    }
    return { code: 0, out: "" }
  }
  return { bares, calls, data, run }
}

const head = (dir: string) => extGit(dir, ["rev-parse", "HEAD"]).out.trim()

// The root's file lock: every git write a sync makes, its fetch and push included, runs under withLock, which lifts that scope's folder of a locked root for it.
test.skipIf(!Bun.which("chflags"))("a locked root syncs every scope and stays locked", async () => {
  const { bares, data, run } = fixture()
  setRootLock(data, true)
  try {
    const lines = await syncExtensions({ data, run })
    expect(lines).toHaveLength(2)
    expect(extGit(bares[`${ME}/playground-acme`]!, ["rev-parse", "main"]).out.trim()).toBe(
      head(scopeDir(data, "acme")),
    )
    expect(rootLocked(extensionsDir(data))).toBe(true)
  } finally {
    setRootLock(data, false)
  }
})

test("every scope's clone is pushed to <login>/playground-<scope>, set as its origin", async () => {
  const { bares, data, run } = fixture()
  const lines = await syncExtensions({ data, run })
  expect(lines).toEqual([
    `acme synced with ${ME}/playground-acme at ${head(scopeDir(data, "acme")).slice(0, 7)}`,
    `${ME} synced with ${ME}/playground-${ME} at ${head(scopeDir(data, ME)).slice(0, 7)}`,
  ])
  expect(extGit(bares[`${ME}/playground-acme`]!, ["rev-parse", "main"]).out.trim()).toBe(
    head(scopeDir(data, "acme")),
  )
  expect(extGit(scopeDir(data, ME), ["remote", "get-url", "origin"]).out.trim()).toBe(
    bares[`${ME}/playground-${ME}`]!,
  )
})

test("ext.repos names another repository for a scope, and a sync names one scope alone", async () => {
  const { bares, data, run } = fixture()
  setSetting(data, { key: "ext.repos", scope: ME, value: { acme: "acme/shared" } }, who("shared"))
  expect(await syncExtensions({ data, only: "acme", run })).toEqual([
    `acme synced with acme/shared at ${head(scopeDir(data, "acme")).slice(0, 7)}`,
  ])
  expect(extGit(bares["acme/shared"]!, ["rev-parse", "main"]).out.trim()).toBe(
    head(scopeDir(data, "acme")),
  )
  expect(
    extGit(bares[`${ME}/playground-${ME}`]!, ["rev-parse", "-q", "--verify", "main"]).code,
  ).not.toBe(0)
})

// The fixture synced once, then a commit pushed from another machine and a new note here, with the clone's git told never to guess an identity (a fresh runner's has none to guess from) and given the identity named, if any.
const behind = async (identity: string[] = []) => {
  const { bares, data, run } = fixture()
  await syncExtensions({ data, run })
  const clone = scopeDir(data, "acme")
  extGit(clone, ["config", "user.useConfigOnly", "true"])
  for (const [key, value] of [
    ["user.name", identity[0]],
    ["user.email", identity[1]],
  ])
    if (value) extGit(clone, ["config", key!, value])
  const other = join(scratch, `other-${n}`)
  Bun.spawnSync(["git", "clone", "-q", bares[`${ME}/playground-acme`]!, other])
  Bun.write(join(other, "docs/other.md"), "from the other machine\n")
  for (const args of [
    ["add", "-A"],
    ["-c", "user.name=x", "-c", "user.email=x@example.test", "commit", "-qm", "other"],
    ["push", "-q", "origin", "HEAD:main"],
  ])
    Bun.spawnSync(["git", "-C", other, ...args])
  note(data, "acme", "a second acme note\n")
  return { bares, clone, data, run }
}

const committer = (clone: string) => extGit(clone, ["log", "-1", "--format=%cn <%ce>"]).out.trim()

test("a commit pushed from another machine is pulled in with a rebase before the push, on a machine with no git identity", async () => {
  const { bares, clone, data, run } = await behind()
  await syncExtensions({ data, only: "acme", run })
  expect(extGit(clone, ["log", "--format=%s"]).out.trim().split("\n")).toEqual([
    "a second acme note",
    "other",
    "an acme note",
  ])
  expect(extGit(bares[`${ME}/playground-acme`]!, ["rev-parse", "main"]).out.trim()).toBe(
    head(clone),
  )
  expect(committer(clone)).toBe("Playground <playground>")
})

test("the rebase keeps the machine's own git identity as its committer", async () => {
  const { clone, data, run } = await behind(["Made Up", "made-up@example.test"])
  await syncExtensions({ data, only: "acme", run })
  expect(committer(clone)).toBe("Made Up <made-up@example.test>")
})

test("a public repository is refused and nothing is pushed there, while the other scopes still sync", async () => {
  const { bares, data, run } = fixture({ [`${ME}/playground-acme`]: "PUBLIC" })
  await expect(syncExtensions({ data, run })).rejects.toThrow(
    `acme: refused: ${ME}/playground-acme is public, and a scope syncs only with a private repository`,
  )
  expect(
    extGit(bares[`${ME}/playground-acme`]!, ["rev-parse", "-q", "--verify", "main"]).code,
  ).not.toBe(0)
  expect(extGit(bares[`${ME}/playground-${ME}`]!, ["rev-parse", "main"]).out.trim()).toBe(
    head(scopeDir(data, ME)),
  )
})

test("a secret-shaped file stops that scope's push, naming the file and its kind alone", async () => {
  const { calls, data, run } = fixture()
  note(data, "acme", `token ghp_${"a".repeat(36)}\n`)
  await expect(syncExtensions({ data, only: "acme", run })).rejects.toThrow(
    "acme: refused, nothing pushed: docs/notes.md holds a GitHub token",
  )
  expect(calls.some((call) => call.includes("push"))).toBe(false)
})

test("gitleaks finding a leak in a scope's history stops its push", async () => {
  if (!Bun.which("gitleaks")) return
  const { data } = fixture()
  const run: Run = async (argv) =>
    argv[0] === "gitleaks" ? { code: 1, out: "leaks found" } : { code: 1, out: "" }
  await expect(syncExtensions({ data, only: "acme", run })).rejects.toThrow("gitleaks found a leak")
})

test("a scope with no commit yet is skipped, and the others still sync", async () => {
  const { bares, data, run } = fixture()
  Bun.spawnSync(["git", "init", "-q", "-b", "main", scopeDir(data, "corp")])
  Bun.spawnSync([
    "git",
    "init",
    "-q",
    "--bare",
    "-b",
    "main",
    (bares[`${ME}/playground-corp`] = join(scratch, `${n++}-corp.git`)),
  ])
  const lines = await syncExtensions({ data, run })
  expect(lines).toContain("corp has no commit yet, so nothing is pushed")
  expect(lines.filter((line) => line.includes(" synced with "))).toHaveLength(2)
})

test("with no repository the scope stays local, and with no scope there is nothing to sync", async () => {
  const { data } = fixture()
  const none: Run = async (argv) => ({ code: argv[0] === "gh" ? 1 : 0, out: "" })
  expect(await syncExtensions({ data, only: "acme", run: none })).toEqual([
    `acme stays on this machine: there is no ${ME}/playground-acme; playground ext init creates it`,
  ])
  expect(await syncExtensions({ data: join(scratch, "empty"), run: none })).toEqual([
    "no scope to sync yet",
  ])
})
