// The trace ratchet: counts each kind of private trace (kinds.ts), and each Mac-only call with no Linux branch in front of it (mac-only.ts), over the tree, past every live name the switch's migration moves (LIVE_NAMES, its allowlist, piece 21's reason) and past the paths the seed leaves out, so a check fails when any count rises above counts.json and each trace-out lowers it.
import { existsSync } from "node:fs"
import { join } from "node:path"

import { LIVE_NAMES } from "../rename/rules"
import { UPSTREAM_SKILLS } from "../vendor-upstream/stage"
import {
  EMPTY_LIST,
  isPublicList,
  type Kind,
  LIST_KEYS,
  ownerWord,
  patterns,
  type PublicList,
  readPast,
  type Repos,
  UNSET_REPOS,
} from "./kinds"
import { macOnlyAt, macOnlyLines } from "./mac-only"

// Each kind the ratchet holds: the private traces kinds.ts patterns, and the Mac-only calls mac-only.ts counts, which no guard refuses.
export type Counted = Kind | "macOnly"
export type Counts = Partial<Record<Counted, number>>
export type File = { path: string; text: string }

export const COUNTS = join(import.meta.dir, "counts.json")
export const KEPT = join(import.meta.dir, "kept.json")

// A hit kept on purpose: the line, trimmed, that holds it in its file, how many of its kind that line holds, how many identical lines carry it (copies, 1 when absent), and why it stays.
export type Kept = {
  copies?: number
  hits: number
  kind: Kind
  line: string
  path: string
  reason: string
}

// Left out of the seed, so never counted: these counts and the kept hits, whose lines hold the hits they keep, the files that define the old names, core's upstream skills, whose text is upstream's, and the guards' bundles, built from sources counted here.
export const LEFT_OUT = [
  /^packages\/scripts\/src\/rename\/rules\.ts$/,
  /^packages\/scripts\/src\/trace-count\/counts\.json$/,
  /^packages\/scripts\/src\/trace-count\/kept\.json$/,
  /^packages\/scripts\/src\/trace-count\/kinds\.ts$/,
  new RegExp(`^extensions/core/(upstream|skills/(${UPSTREAM_SKILLS.join("|")}))/`),
  /^scripts\/hooks\/bundled\//,
]

// In the seed but never counted, nor swapped: a lockfile, whose integrity hashes can spell a list value by chance and break the install when rewritten.
export const LOCKFILES = [/(?:^|\/)bun\.lock$/, /(?:^|\/)package-lock\.json$/]

// Made-up data: the dashboard's and the Changelog's fixtures and the recorded replays mimic real data, and the tests hold their own.
export const MADE_UP_DATA = [
  /^api\/hono\/src\/fixtures\/dashboard\.json$/,
  /^api\/hono\/src\/plugins\/changelog\/fixture\.ts$/,
  /^packages\/scripts\/src\/parity\/replay\/fixtures\//,
  /^tests\//,
]

// Left out of one kind alone: made-up data's PR and issue numbers are no provenance.
const LEFT_OUT_OF: Partial<Record<Kind, RegExp[]>> = { issueRefs: MADE_UP_DATA }

const LIVE = new RegExp(LIVE_NAMES.join("|"), "g")
// A file's text as the kinds read it: past every live name and every public repository.
export const readable = (text: string, repos: Repos): string =>
  readPast(text.replace(LIVE, ""), repos)

// No person's address, so no trace: a domain reserved for examples (RFC 2606 and 6761) or the fixtures' local.host, an ssh remote's git user, and a package's version.
const NOT_A_PERSON = [
  /@(?:[a-z\d-]+\.)*(?:example\.(?:com|net|org)|example|test|invalid|localhost|local\.host)$/i,
  /^git@/,
  /@\d+\.\d+/,
]

// The paths of the files whose text, as the ownerName kind reads it, holds the name, so a name's hits show before a commit counts them.
export const holding = (files: File[], name: string, repos: Repos): string[] => {
  const word = new RegExp(ownerWord(name))
  return files
    .filter(({ path, text }) => {
      if ([...LEFT_OUT, ...LOCKFILES].some((re) => re.test(path))) return false
      return word.test(readable(text, repos))
    })
    .map((file) => file.path)
}

// Each kind's hits in one file's text, past the live names, the read-past repositories and the kinds its path is left out of.
const hitsIn = (path: string, text: string, kinds: [Kind, RegExp][], repos: Repos): Counts => {
  const said = readable(text, repos)
  const hits: Counts = {}
  for (const [kind, re] of kinds) {
    if (LEFT_OUT_OF[kind]?.some((out) => out.test(path))) continue
    hits[kind] = (said.match(re) ?? []).filter(
      (hit) => kind !== "emails" || !NOT_A_PERSON.some((re) => re.test(hit)),
    ).length
  }
  return hits
}

// Why a kept entry no longer stands in its file, or nothing when its one line still holds its hits.
const keptMiss = (
  entry: Kept,
  file: File | undefined,
  kinds: [Kind, RegExp][],
  repos: Repos,
): string | undefined => {
  if (!file) return "its file is gone"
  if ([...LEFT_OUT, ...LOCKFILES].some((re) => re.test(entry.path)))
    return "its file is never counted"
  const copies = entry.copies ?? 1
  const lines = file.text.split("\n").filter((line) => line.trim() === entry.line)
  if (lines.length === 0) return "no line reads as its text"
  if (lines.length !== copies)
    return `${lines.length} ${lines.length === 1 ? "line reads" : "lines read"} as its text, not ${copies}, so set its copies or give it a longer one`
  const held = hitsIn(entry.path, lines[0]!, kinds, repos)[entry.kind] ?? 0
  if (held < entry.hits) return `its line holds ${held} ${entry.kind}, not ${entry.hits}`
}

// Every kind with a pattern gets a count, 0 included, and macOnly always, so a kind a run could not measure (an empty list) is absent rather than read as gone; each kept entry that still stands takes its hits off.
export function count(
  files: File[],
  list: PublicList = EMPTY_LIST,
  repos: Repos = UNSET_REPOS,
  kept: Kept[] = [],
): Counts {
  const kinds = patterns(list, repos)
  const counts: Counts = Object.fromEntries(kinds.map(([kind]) => [kind, 0]))
  const byPath = new Map(files.map((file) => [file.path, file]))
  counts.macOnly = 0
  for (const file of files) {
    if ([...LEFT_OUT, ...LOCKFILES].some((re) => re.test(file.path))) continue
    for (const [kind, n] of Object.entries(hitsIn(file.path, file.text, kinds, repos)))
      counts[kind as Kind]! += n!
    counts.macOnly += macOnlyLines(file).length
  }
  for (const entry of kept)
    if (counts[entry.kind] !== undefined && !keptMiss(entry, byPath.get(entry.path), kinds, repos))
      counts[entry.kind]! -= entry.hits * (entry.copies ?? 1)
  return counts
}

// Each kept entry that no longer stands, by its path and line, so the commit that clears its hit drops it too.
export function stale(
  files: File[],
  kept: Kept[],
  list: PublicList = EMPTY_LIST,
  repos: Repos = UNSET_REPOS,
): string[] {
  const kinds = patterns(list, repos)
  const byPath = new Map(files.map((file) => [file.path, file]))
  return kept.flatMap((entry) => {
    if (!kinds.some(([kind]) => kind === entry.kind)) return []
    const miss = keptMiss(entry, byPath.get(entry.path), kinds, repos)
    return miss ? [`${entry.path}: "${entry.line}" (${entry.kind}): ${miss}`] : []
  })
}

// Each measured kind whose count is over its baseline, or has none yet.
export const risen = (now: Counts, baseline: Counts): string[] =>
  Object.entries(now).flatMap(([kind, n]) => {
    const was = baseline[kind as Counted]
    if (was !== undefined && n <= was) return []
    return [
      `${kind}: ${n} in the tree, counts.json allows ${was ?? "none, since it has no count yet"}`,
    ]
  })

// The refusal for the risen lines, naming the fix where a kind has one, then each file and line located found.
export const refusal = (over: string[], at: string[] = []): string =>
  `trace-count: a count rose; write the new text in plain words${over.some((line) => line.startsWith("issueRefs:")) ? "; describe the case in words; a doc cites no issue number, and the PR body's Merge Danger or Links carry it" : ""}${over.some((line) => line.startsWith("macOnly:")) ? "; put a Linux branch in front of a Mac-only call (a uname or process.platform check that takes Linux another way)" : ""}:\n${[...over, ...at].join("\n")}`

// Each line holding a hit of one of the kinds, as path:line: kind, past the paths never counted and the lines kept.json keeps while they hold no more than its hits; for each kind, the changed files' alone when they hold one, since a kind's floor can hold many older hits.
export function located(
  files: File[],
  wanted: Counted[],
  list: PublicList = EMPTY_LIST,
  repos: Repos = UNSET_REPOS,
  kept: Kept[] = [],
  changed: string[] = [],
): string[] {
  const near = files.filter((file) => changed.includes(file.path))
  const counted = files.filter(
    ({ path }) => ![...LEFT_OUT, ...LOCKFILES].some((re) => re.test(path)),
  )
  return [
    ...patterns(list, repos)
      .filter(([kind]) => wanted.includes(kind))
      .flatMap((kind) => {
        const own = locatedIn(near, [kind], repos, kept)
        return own.length > 0 ? own : locatedIn(files, [kind], repos, kept)
      }),
    ...(wanted.includes("macOnly") ? macOnlyAt(counted, changed) : []),
  ]
}

const locatedIn = (from: File[], kinds: [Kind, RegExp][], repos: Repos, kept: Kept[]) =>
  from.flatMap(({ path, text }) =>
    [...LEFT_OUT, ...LOCKFILES].some((re) => re.test(path))
      ? []
      : text.split("\n").flatMap((line, i) =>
          Object.entries(hitsIn(path, line, kinds, repos))
            .filter(
              ([kind, n]) =>
                n &&
                !kept.some(
                  (entry) =>
                    entry.kind === kind &&
                    entry.path === path &&
                    entry.line === line.trim() &&
                    n <= entry.hits,
                ),
            )
            .map(([kind]) => `${path}:${i + 1}: ${kind}`),
        ),
  )

// The files the index or the working tree changes against HEAD, which located names first.
export const changedFiles = (root: string): string[] => {
  const diff = Bun.spawnSync(["git", "diff", "HEAD", "--name-only", "-z"], {
    cwd: root,
    env: { ...process.env },
  })
  return diff.exitCode === 0 ? diff.stdout.toString().split("\0").filter(Boolean) : []
}

// The kinds the risen lines name.
export const risenKinds = (over: string[]): Counted[] =>
  over.map((line) => line.slice(0, line.indexOf(":")) as Counted)

// The baseline with each measured kind lowered to its count; a kind this run did not measure keeps its count.
export const lowered = (now: Counts, baseline: Counts): Counts =>
  Object.fromEntries(
    [...new Set([...Object.keys(baseline), ...Object.keys(now)])]
      .sort()
      .map((kind) => [
        kind,
        Math.min(baseline[kind as Counted] ?? Infinity, now[kind as Counted] ?? Infinity),
      ]),
  )

const SKIPPED = /(?:^|\/)(?:\.git|\.next|\.turbo|coverage|dist|node_modules)\//

// The tree's text files: the ones git's index holds, tracked or staged, where a .git is, so a harness's untracked output never counts (git reads process.env as it is now, which Bun's default spawn env does not); else every file but build output and installs (the runner box's copy, which holds no ignored file).
export async function tree(root: string): Promise<File[]> {
  const listed = existsSync(join(root, ".git"))
    ? Bun.spawnSync(["git", "ls-files", "-z", "--cached"], { cwd: root, env: { ...process.env } })
    : undefined
  const paths =
    listed?.exitCode === 0
      ? listed.stdout.toString().split("\0").filter(Boolean)
      : [...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true })].filter((p) => !SKIPPED.test(p))
  const files: File[] = []
  for (const path of paths) {
    const file = Bun.file(join(root, path))
    if (!(await file.exists())) continue
    const bytes = await file.bytes()
    if (!bytes.includes(0)) files.push({ path, text: new TextDecoder().decode(bytes) })
  }
  return files
}

// No-public-leak's list, or the refusal for one the count cannot trust: a missing file or a key with no entry leaves its kinds with no pattern, so they would count nothing and a trace would pass unseen.
export async function list(path: string): Promise<{ list: PublicList } | { refusal: string }> {
  const fix = `tell your lead, and the dispatcher hands the owner ! playground ext put <scope> list no-public-leak <file> --reason <why> to type in the dispatcher's terminal window, every key (${LIST_KEYS.join(", ")}) holding an entry`
  if (!existsSync(path)) return { refusal: `no ${path}, so its kinds would count nothing: ${fix}` }
  const value: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined)
  if (!isPublicList(value)) return { refusal: `${path} is not no-public-leak's list: ${fix}` }
  const empty = LIST_KEYS.filter((key) => value[key].length === 0)
  if (empty.length > 0)
    return {
      refusal: `${path} has no ${empty.join(", ")}, so those kinds would count nothing: ${fix}`,
    }
  return { list: value }
}

// The list file at path for the list checks (commit, push, CI): undefined with none, so a machine with no list checks nothing; the refusal for a file that is not the list.
export async function readList(path: string): Promise<PublicList | string | undefined> {
  if (!existsSync(path)) return undefined
  const value: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined)
  return isPublicList(value) ? value : `trace-count: ${path} is not no-public-leak's list`
}

// The commit's count of the list-fed kinds, from the list at path, which the sandboxed tree test cannot see: nothing with no list there (the runner box, a machine with no org), else the refusal when one of them is over counts.json; an empty key counts nothing, so a partial list still gates the kinds it holds.
export async function listGate(root: string, path: string): Promise<string> {
  const value = await readList(path)
  if (value === undefined || typeof value === "string") return value ?? ""
  const files = await tree(root)
  const kept = (await Bun.file(KEPT).json()) as Kept[]
  const counted = count(files, value, UNSET_REPOS, kept)
  const now: Counts = Object.fromEntries(LIST_KEYS.map((kind) => [kind, counted[kind] ?? 0]))
  const over = risen(now, (await Bun.file(COUNTS).json()) as Counts)
  return over.length
    ? refusal(over, located(files, risenKinds(over), value, UNSET_REPOS, kept, changedFiles(root)))
    : ""
}

// The list kinds a text holds (a commit's message, a branch's name), by kind alone, so a refusal never prints the term.
export const listKindsIn = (text: string, list: PublicList): Kind[] => {
  const counted = count([{ path: "", text }], list)
  return LIST_KEYS.filter((kind) => (counted[kind] ?? 0) > 0)
}

const gitIn = (root: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env } })

// The pull request's list gate, as CI runs it: each list kind a changed file holds more of than at its merge-base with base, a new file's path, each commit message since that merge-base and the branch's name hold, by place and kind alone; nothing with no list at path.
export async function listSince(
  root: string,
  base: string,
  path: string,
  branch = "",
): Promise<string> {
  const value = await readList(path)
  if (value === undefined || typeof value === "string") return value ?? ""
  const merged = gitIn(root, ["merge-base", base, "HEAD"])
  if (merged.exitCode !== 0) return `trace-count: ${base} and HEAD have no merge-base`
  const from = merged.stdout.toString().trim()
  const kept = (await Bun.file(KEPT).json()) as Kept[]
  const at = (rev: string, file: string): File | undefined => {
    const shown = gitIn(root, ["show", `${rev}:${file}`])
    if (shown.exitCode !== 0) return undefined
    return { path: file, text: shown.stdout.includes(0) ? "" : shown.stdout.toString() }
  }
  const hits: string[] = []
  const changed = gitIn(root, ["diff", "--name-only", "-z", "--no-renames", from, "HEAD"])
  for (const file of changed.stdout.toString().split("\0").filter(Boolean)) {
    const now = at("HEAD", file)
    if (!now) continue
    const was = at(from, file)
    const inPath = listKindsIn(file, value)
    const place = inPath.length ? "a changed file's path" : file
    if (!was) hits.push(...inPath.map((kind) => `${place}: ${kind}`))
    const before = was ? count([was], value, UNSET_REPOS, kept) : {}
    const after = count([now], value, UNSET_REPOS, kept)
    for (const kind of LIST_KEYS)
      if ((after[kind] ?? 0) > (before[kind] ?? 0)) hits.push(`${place}: ${kind}`)
  }
  const log = gitIn(root, ["log", "--format=%H%x00%B%x01", `${from}..HEAD`])
  for (const entry of log.stdout.toString().split("\x01")) {
    const [sha, body] = entry.replace(/^\n/, "").split("\0")
    if (sha && body !== undefined)
      hits.push(...listKindsIn(body, value).map((kind) => `${sha.slice(0, 9)}'s message: ${kind}`))
  }
  hits.push(...listKindsIn(branch, value).map((kind) => `the branch's name: ${kind}`))
  return hits.length
    ? `trace-count: the pull request adds a term from no-public-leak's list, named here by place and kind alone; reword each in plain words:\n${[...new Set(hits)].join("\n")}`
    : ""
}
