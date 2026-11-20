import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  refreshBriefs,
  tellPending,
} from "../../../../../packages/scripts/src/playground/brief-refresh"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const git = (repo: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.test", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  })
    .stdout.toString()
    .trim()

// A scratch checkout whose builder template went from v1 to v2 in one update, and a scratch data folder.
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "brief-refresh-"))
  dirs.push(home)
  const repo = join(home, "repo")
  const data = join(home, "data")
  mkdirSync(join(repo, "scripts", "briefs"), { recursive: true })
  mkdirSync(data)
  git(repo, "init", "-q")
  const template = join(repo, "scripts", "briefs", "builder.md")
  writeFileSync(template, "Brief v1.\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "v1")
  const old = git(repo, "rev-parse", "HEAD")
  writeFileSync(template, "Brief v2.\n")
  git(repo, "commit", "-qam", "v2")
  const sent: { text: string; to: string }[] = []
  const send = async (to: string, text: string) => {
    sent.push({ text, to })
    return true
  }
  const copy = join(data, "brief-builder.md")
  const run = (live: boolean) =>
    refreshBriefs({
      data,
      live: () => live,
      log: () => {},
      managers: [{ kind: "builder", name: "builder" }],
      old,
      repo,
      send,
    })
  return { copy, data, old, repo, run, send, sent }
}

test("an update back to an older template, as --to <older tag> moves, keeps an unedited copy on the template and logs no edits", async () => {
  const { copy, data, old: v1, repo, send, sent } = setup()
  const v2 = git(repo, "rev-parse", "HEAD")
  writeFileSync(copy, "Brief v2.\n")
  git(repo, "checkout", "-q", v1)
  const said: string[] = []
  await refreshBriefs({
    data,
    live: () => true,
    log: (line) => said.push(line),
    managers: [{ kind: "builder", name: "builder" }],
    old: v2,
    repo,
    send,
  })
  expect(readFileSync(copy, "utf8")).toBe("Brief v1.\n")
  expect(said.some((line) => line.includes("holds edits"))).toBe(false)
  expect(sent).toHaveLength(1)
  const diff = readFileSync(join(data, "brief-builder.sent.diff"), "utf8")
  expect(diff).toStartWith("# brief-builder.md followed this change\n")
  expect(diff).toContain("-Brief v2.")
  expect(diff).toContain("+Brief v1.")
})

test("an unedited copy follows its template, and its live manager gets the template's diff", async () => {
  const { copy, data, run, sent } = setup()
  writeFileSync(copy, "Brief v1.\n")
  await run(true)
  expect(readFileSync(copy, "utf8")).toBe("Brief v2.\n")
  expect(sent.map((s) => s.to)).toEqual(["builder"])
  expect(sent[0]?.text).toContain(join(data, "brief-builder.sent.diff"))
  const diff = readFileSync(join(data, "brief-builder.sent.diff"), "utf8")
  expect(diff).toStartWith("# brief-builder.md followed this change\n")
  expect(diff).toContain("-Brief v1.")
  expect(diff).toContain("+Brief v2.")
  expect(existsSync(join(data, "brief-builder.diff"))).toBe(false)
})

test("an owner-edited copy keeps its text, and its live manager gets the template's diff", async () => {
  const { copy, data, run, sent } = setup()
  writeFileSync(copy, "Brief v1, with the owner's own line.\n")
  await run(true)
  expect(readFileSync(copy, "utf8")).toBe("Brief v1, with the owner's own line.\n")
  expect(sent.map((s) => s.to)).toEqual(["builder"])
  const diff = readFileSync(join(data, "brief-builder.sent.diff"), "utf8")
  expect(diff).toStartWith("# brief-builder.md kept its edits; this change is not in it\n")
  expect(diff).toContain("-Brief v1.")
  expect(diff).toContain("+Brief v2.")
})

test("a copy already at the template, or no copy at all, sends nothing", async () => {
  const { copy, data, run, sent } = setup()
  await run(true)
  expect(existsSync(copy)).toBe(false)
  writeFileSync(copy, "Brief v2.\n")
  await run(true)
  expect(readFileSync(copy, "utf8")).toBe("Brief v2.\n")
  expect(sent).toEqual([])
  expect(existsSync(join(data, "brief-builder.diff"))).toBe(false)
})

test("a manager that is not live gets the diff held for its next start, which tellPending sends once", async () => {
  const { copy, data, run, send, sent } = setup()
  writeFileSync(copy, "Brief v1, edited.\n")
  await run(false)
  expect(sent).toEqual([])
  expect(readFileSync(join(data, "brief-builder.diff"), "utf8")).toContain("+Brief v2.")
  expect(await tellPending(data, "builder", send)).toBe(true)
  expect(sent.map((s) => s.to)).toEqual(["builder"])
  expect(existsSync(join(data, "brief-builder.diff"))).toBe(false)
  expect(readFileSync(join(data, "brief-builder.sent.diff"), "utf8")).toContain("+Brief v2.")
  expect(await tellPending(data, "builder", async () => true)).toBe(false)
})
