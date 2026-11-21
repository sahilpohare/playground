import "@packages/env/aliases"
import { mkdir, rename } from "node:fs/promises"
import { join } from "node:path"

import { envValue } from "@packages/config/org"
import { dataDir } from "@packages/env/data-dir"
import type { LockStore } from "@packages/redis"

import { endMergedLive } from "../../../../scripts/ops/optimizer/auto_end"
import { ghSkipped } from "../gh-read"
import { sendAs } from "../ops-job/job"
import { factoryRepoOf } from "../playground/setting"
import { bareTokens, ownerAsk, templatePlaceholders } from "./body"
import {
  BASE,
  GATE_CODE,
  gatesOf,
  marksReady,
  mergeLine,
  parentsOf,
  withReadyDraft,
  type Check,
  type Comment,
  type Gate,
  type GateOptions,
  type PrFacts,
} from "./gates"
import { heldPath, readHeld } from "./held"
import { lostLines } from "./lost"
import { onStop, settleFirst, stopping } from "./stop"
import { ciSteps, typesExplained, typesGate, type TypeSteps } from "./types"

export type RunResult = { code: number; stderr: string; stdout: string }

// Runs gh with these arguments; a test hands in a stub, as the Usage app's prs.ts does.
export type Run = (args: string[]) => Promise<RunResult>

// gh, skipped while the gh-auth beat's fresh result reads failed (ghSkipped), so the train never floods a broken gh.
export const runGh: Run = async (args) => {
  const skipped = ghSkipped()
  if (skipped) return { code: 1, stderr: skipped, stdout: "" }
  const proc = Bun.spawn(["gh", ...args], { stderr: "pipe", stdin: "ignore", stdout: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stderr, stdout }
}

export const runGit: Run = async (args) => {
  const proc = Bun.spawn(["git", ...args], { stderr: "pipe", stdin: "ignore", stdout: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stderr, stdout }
}

// What runs outside GitHub's API: git in this checkout, the folder the merge lock lives in, the Redis store that holds it (REDIS_URL's under the command, none under a test that hands in none), and the types gate's steps (CI's own under the command) and time budget.
export type Local = {
  ended?: Ended
  git?: Run
  lockRoot?: string
  shipNow?: ShipNow
  store?: LockStore | null
  types?: TypeSteps
  typesBudgetMs?: number
}

// Sends Ops the ship-now line for a merged PR that carries the `ship-now` label and that shipNowLine ships.
export type ShipNow = (line: string) => Promise<unknown>

// Pure: the release rule's ship-now for a merged PR: a fix( title, or a Links line naming the owner's ask (ownerAsk), ships with the line Ops reads, which the release skill keys on; any other answers with the rule's line and no ship.
export const shipNowLine = (
  n: number,
  sha: string,
  pr: { body?: string; title?: string },
): { line: string; ship: boolean } =>
  /^fix\(/.test(pr.title ?? "") || ownerAsk(pr.body ?? "")
    ? {
        line: `#${n} carries ship-now and merged at ${sha}: ship canary now by the release skill, unless a ship you are already running pinned a canary that holds ${sha}.`,
        ship: true,
      }
    : {
        line: `#${n} carries ship-now but starts no ship: its title opens no fix( and its Links holds no line opening "Owner ask:" with an Inbox #i id, a PG issue or the owner's quoted words (extensions/core/rules/release.md).`,
        ship: false,
      }

// The live send, for the pr:merge and pr:train commands alone: one line to the ops lead through the ops relay.
export const liveShipNow: ShipNow = (line) => sendAs("ops-ship")("ops", line)

// Ends a merged PR's worker, reviewer and tester, given the PR's URL and its merge sha.
export type Ended = (url: string, sha: string) => Promise<void>

// The live end, for the pr:merge and pr:train commands alone: auto_end.ts, each line to its session's lead through the ops relay.
export const liveEnded: Ended = (url, sha) => endMergedLive(url, sha, sendAs("auto-end"))

// Runs the end after a merge; a failure is printed and never fails the merge.
export async function endSessions(url: string, sha: string, ended?: Ended): Promise<void> {
  if (!ended) return
  try {
    await ended(url, sha)
  } catch (err) {
    console.error(
      `ending the sessions of ${url} failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

// The factory's merge lock and its released copies live in the data folder (data-dir.ts), beside merge-lock.md; PLAYGROUND_MERGE_LOCK_DIR moves them, as the tests do, so no test ever takes the real lock.
export const realLockRoot = (): string => dataDir()

export const lockRootOf = (): string =>
  envValue(process.env, "PLAYGROUND_MERGE_LOCK_DIR") || realLockRoot()

// The merge queue the Builder keeps, as PR numbers in order, beside the merge lock; PLAYGROUND_MERGE_QUEUE moves it, as the tests do.
export const queuePath = (): string =>
  envValue(process.env, "PLAYGROUND_MERGE_QUEUE") || join(lockRootOf(), "merge-queue.json")

export async function readQueue(path: string): Promise<number[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const data = (await file.json()) as { queue?: { pr?: unknown }[] }
  return (data.queue ?? [])
    .map((entry) => Number(entry.pr))
    .filter((n) => Number.isInteger(n) && n > 0)
}

// Fetches PR n's head into this checkout: its pull ref, else, while GitHub has not made that ref yet (one PR had only its merge ref 6 minutes after it opened), its head branch on origin, refused unless its tip is the head the gates judge, so a moved or same-named branch never stands in for it.
export async function fetchHead(git: Run, n: number, head: string, branch: string): Promise<void> {
  const pull = await git(["fetch", "--quiet", "origin", `refs/pull/${n}/head`])
  if (pull.code === 0) return
  if (!pull.stderr.includes("couldn't find remote ref"))
    throw new Error(`git fetch exited ${pull.code}: ${pull.stderr.trim()}`)
  const fetched = await git(["fetch", "--quiet", "origin", `refs/heads/${branch}`])
  if (fetched.code !== 0)
    throw new Error(
      `refs/pull/${n}/head is missing, and git fetch of its branch ${branch} exited ${fetched.code}: ${fetched.stderr.trim()}`,
    )
  const tip = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim()
  if (tip !== head)
    throw new Error(
      `refs/pull/${n}/head is missing, and its branch ${branch} is at ${tip.slice(0, 7) || "nothing"}, not the head ${head.slice(0, 7)}`,
    )
}

// canary now, and the tree of the head merged with it: from this checkout's git, after fetching canary and the PR's head. A merge that conflicts has no tree (null), and names its files.
async function mergeOf(
  git: Run,
  n: number,
  head: string,
  branch: string,
): Promise<{ canary: string; conflicts: string[] | null; mergeTree: string | null }> {
  const fetched = await git(["fetch", "--quiet", "origin", BASE])
  if (fetched.code !== 0)
    throw new Error(`git fetch exited ${fetched.code}: ${fetched.stderr.trim()}`)
  await fetchHead(git, n, head, branch)
  const canary = await git(["rev-parse", `origin/${BASE}`])
  if (canary.code !== 0) throw new Error(`git rev-parse origin/${BASE} exited ${canary.code}`)
  const merged = parseMergeTree(
    await git(["merge-tree", "--write-tree", "--name-only", head, `origin/${BASE}`]),
  )
  return {
    canary: canary.stdout.trim(),
    conflicts: merged && !merged.clean ? [...new Set(merged.files)] : null,
    mergeTree: merged?.clean ? merged.tree : null,
  }
}

// Each GATE_CODE file whose working copy in this checkout, uncommitted edits included, differs from canary's tip, after mergeOf fetched it, each path read from the checkout's top (`:(top)`) whatever folder git runs in; a diff that cannot run throws, as a failed fetch does.
export async function gateCodeOf(git: Run, canary: string): Promise<string[]> {
  const paths = GATE_CODE.map((path) => `:(top)${path}`)
  const diff = await git(["diff", "--name-only", canary, "--", ...paths])
  if (diff.code !== 0)
    throw new Error(`git diff of the gate code exited ${diff.code}: ${diff.stderr.trim()}`)
  return diff.stdout.split("\n").filter(Boolean)
}

// The gate's own folders, whose code, docs and tests name sample tokens (SUITE_LINE), so the grep leaves them out and a sample stays unfound.
export const GATE_OWN = ["packages/scripts/src/pr-merge", "tests/packages/scripts/src/pr-merge"]

// The tokens no file at the head holds outside GATE_OWN, by one git grep -w -F a token in this checkout, after mergeOf fetched the head; a grep that cannot run throws, as a failed fetch does.
export async function unfoundTokens(git: Run, head: string, tokens: string[]): Promise<string[]> {
  const outside = GATE_OWN.map((folder) => `:(exclude)${folder}`)
  const found = await Promise.all(
    tokens.map(async (token) => {
      const grep = await git(["grep", "-q", "-w", "-F", "-e", token, head, "--", ".", ...outside])
      if (grep.code !== 0 && grep.code !== 1)
        throw new Error(`git grep exited ${grep.code}: ${grep.stderr.trim()}`)
      return grep.code === 0
    }),
  )
  return tokens.filter((_, i) => !found[i])
}

// The pr skill's file whose template the body gate reads its placeholders from.
const PR_TEMPLATE = "extensions/core/skills/pr/SKILL.md"

// Pure: git merge-tree --write-tree --name-only's answer: whether it merged clean (exit 0), the tree it wrote, and the files that conflict; null when it did not run.
export function parseMergeTree(
  result: RunResult,
): { clean: boolean; files: string[]; tree: string } | null {
  const lines = result.stdout.split("\n")
  const tree = lines[0]?.trim() ?? ""
  if ((result.code !== 0 && result.code !== 1) || !/^[0-9a-f]{40}$/.test(tree)) return null
  const end = lines.indexOf("", 1)
  const files =
    result.code === 1 ? lines.slice(1, end === -1 ? undefined : end).filter(Boolean) : []
  return { clean: result.code === 0, files, tree }
}

// Pure: who holds the merge lock, as a refusal names it: a PR by its number, a train by its name.
export const holderText = (holder: string): string => (/^\d+$/.test(holder) ? `#${holder}` : holder)

// Every comment on one PR, with its author.
export const commentsOf = (run: Run, repo: string, n: number): Promise<Comment[]> =>
  listComments(run, `repos/${repo}/issues/${n}/comments`)

// Every comment one GitHub comments path lists, with its author.
async function listComments(run: Run, path: string): Promise<Comment[]> {
  const listed = await gh(run, [
    "api",
    path,
    "--paginate",
    "--jq",
    ".[] | {author: .user.login, body: .body, createdAt: .created_at, url: .html_url} | tojson",
  ])
  return listed
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Comment)
}

export const gh = async (run: Run, args: string[]): Promise<string> => {
  const result = await run(args)
  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

// The repo pr:merge acts on: the one --repo names, else the one gh sees from this checkout.
export const repoOf = async (run: Run, repo?: string): Promise<string> =>
  repo || gh(run, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])

// The files PR n changes; a renamed file counts by both paths, so canary's edit to its old path, which git's merge carries onto the new one, reads as the PR's. removed: each file the diff deletes a line from, and each renamed file's old path, which the checks gate reads for a refused-forms row; a line with no tab is a file's name alone.
async function filesOf(
  run: Run,
  repo: string,
  n: number,
): Promise<{ files: string[]; removed: string[] }> {
  const files: string[] = []
  const removed: string[] = []
  const rows = await gh(run, [
    "api",
    `repos/${repo}/pulls/${n}/files`,
    "--paginate",
    "--jq",
    '.[] | [.filename, (.previous_filename // ""), (.deletions // 0)] | @tsv',
  ])
  for (const row of rows.split("\n").filter(Boolean)) {
    const [name = "", previous = "", deletions = "0"] = row.split("\t")
    files.push(name)
    if (previous) files.push(previous)
    if (Number(deletions) > 0) removed.push(name)
    if (previous) removed.push(previous)
  }
  return { files, removed }
}

// Everything the gates read about one PR, from gh: its state, head and base, the files its diff touches, every comment with its author, how far canary is ahead of its head, the state of each PR its body says it is stacked on, and its merge with canary now.
export async function factsOf(
  run: Run,
  repo: string,
  n: number,
  git: Run = runGit,
): Promise<PrFacts> {
  const view = JSON.parse(
    await gh(run, [
      "pr",
      "view",
      String(n),
      "-R",
      repo,
      "--json",
      "author,baseRefName,body,headRefName,headRefOid,isDraft,labels,state,statusCheckRollup,title",
    ]),
  ) as {
    author: { login: string } | null
    baseRefName: string
    body: string
    headRefName: string
    headRefOid: string
    isDraft: boolean
    labels?: { name: string }[] | null
    state: string
    statusCheckRollup: Check[] | null
    title?: string
  }
  const [{ files, removed }, comments, ahead, held] = await Promise.all([
    filesOf(run, repo, n),
    commentsOf(run, repo, n),
    gh(run, ["api", `repos/${repo}/compare/${view.headRefOid}...${BASE}`, "--jq", ".ahead_by"]),
    readHeld(heldPath(), repo, n, Date.now()),
  ])
  const owner = repo.split("/")[0] ?? ""
  const parents = await Promise.all(
    parentsOf(view.body ?? "").map(async (parent) => ({
      n: parent,
      state: await gh(run, [
        "pr",
        "view",
        String(parent),
        "-R",
        repo,
        "--json",
        "state",
        "--jq",
        ".state",
      ]).catch((error: Error) => `unreadable: ${error.message}`),
    })),
  )
  const { canary, conflicts, mergeTree } = await mergeOf(git, n, view.headRefOid, view.headRefName)
  const gateCode = await gateCodeOf(git, canary)
  const lost = await lostLines(git, `origin/${BASE}`, view.headRefOid, mergeTree)
  const template = await git(["show", `${view.headRefOid}:${PR_TEMPLATE}`])
  const placeholders = template.code === 0 ? templatePlaceholders(template.stdout) : []
  if (placeholders.length === 0)
    throw new Error(
      `the body gate cannot read the pr template's placeholders at ${view.headRefOid.slice(0, 7)} (${PR_TEMPLATE}): ${template.code === 0 ? "its first markdown fence holds none" : `git show exited ${template.code}: ${template.stderr.trim()}`}`,
    )
  const unfound = await unfoundTokens(git, view.headRefOid, bareTokens(view.body ?? ""))
  return {
    aheadBy: /^\d+$/.test(ahead) ? Number(ahead) : Number.NaN,
    author: view.author?.login ?? "",
    base: view.baseRefName,
    body: view.body,
    canary,
    checks: view.statusCheckRollup ?? [],
    comments,
    conflicts,
    draft: view.isDraft,
    files,
    gateCode,
    head: view.headRefOid,
    held,
    labels: (view.labels ?? []).map((label) => label.name),
    lost,
    mergeTree,
    n,
    owner,
    parents,
    placeholders,
    removed,
    state: view.state,
    title: view.title,
    unfound,
  }
}

// A GitHub server error, which a second try at the same head may get past.
export const isServerError = (stderr: string): boolean =>
  /\bHTTP 5\d\d\b|status code: 5\d\d\b|Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error/i.test(
    stderr,
  )

const stateOf = async (run: Run, repo: string, n: number) =>
  JSON.parse(
    await gh(run, ["pr", "view", String(n), "-R", repo, "--json", "mergeCommit,state"]),
  ) as { mergeCommit: { oid: string } | null; state: string }

// The comment pr:merge leaves on a PR it merged: the head it merged and each gate.
export function mergeNote(head: string, gates: Gate[]): string {
  const lines = [`Merged by bun run pr:merge at ${head.slice(0, 7)}.`, ""]
  for (const gate of gates) lines.push(`- ${gate.name}: ${gate.detail}`)
  return lines.join("\n")
}

export type Outcome =
  | { gates: Gate[]; kind: "explained"; merge: string }
  | { gates: Gate[]; kind: "refused" }
  | { gates: Gate[]; holder: string; kind: "locked" }
  | { gates: Gate[]; kind: "merged"; sha: string }
  | { gates: Gate[]; kind: "failed"; reason: string }

// The gate options for a repo: GitGuardian's check is needed on the one it scans, the factory's own (factory.repo, the checkout's origin when unset).
export async function gateOptions(
  repo: string,
  { outsideAuthor }: Pick<GateOptions, "outsideAuthor"> = {},
  environment: Record<string, string | undefined> = process.env,
  checkout?: string,
): Promise<GateOptions> {
  const factory = await factoryRepoOf(environment, checkout)
  return { gitGuardian: repo.toLowerCase() === factory, outsideAuthor }
}

// The merge lock's key in Redis, and how long it lives unless its holder renews it (a third of the way through, from the moment it is taken).
const LOCK_KEY = "playground:merge.lock"
const LOCK_TTL_MS = 60_000

// The store's one error a taker falls back on: Redis did not answer. Read by its name, so this module imports the package only when REDIS_URL asks for it.
const unreachable = (err: unknown): boolean =>
  err instanceof Error && err.name === "RedisUnreachable"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM"
  }
}

// What a lock folder holds: who (`pr`), and for a Redis holder its key's value and pid (`marker`, its `redis` file); a folder with no `redis` file was taken while Redis did not answer.
async function folderOf(lock: string): Promise<{ holder: string; marker: string; pid?: number }> {
  const holder = await Bun.file(join(lock, "pr"))
    .text()
    .catch(() => "")
  const marker = await Bun.file(join(lock, "redis"))
    .text()
    .catch(() => "")
  const pid = Number(marker.split("\n")[1])
  return { holder: holder.trim() || "an unnamed merge", marker, pid: pid > 0 ? pid : undefined }
}

const makeFolder = async (lock: string): Promise<boolean> => {
  try {
    await mkdir(lock)
    return true
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") return false
    throw err
  }
}

// Makes a folder only one taker can make; false when it is there already, or the lock folder it sits in has gone.
const claim = async (path: string): Promise<boolean> => {
  try {
    await mkdir(path)
    return true
  } catch (err) {
    if (err instanceof Error && "code" in err && (err.code === "EEXIST" || err.code === "ENOENT"))
      return false
    throw err
  }
}

// Takes the factory's merge lock, with the PR's number (or the train's name) as its holder; who holds it when another merge has it. With a Redis store its key holds the lock with a time to live, renewed from the moment it is taken, and the folder (a folder only one process can make) is made beside it, marked with the key's value and this pid, so a taker that cannot reach Redis, which keeps to the folder alone, is always refused. A Redis taker takes over a marked folder whose pid has gone (its holder crashed and its key lapsed), and is refused by any other folder: one taken while Redis was down, or a holder still alive that could not renew. A takeover never moves the stale folder: it claims it in place by making `over-<its key's token>` inside it, which one taker alone can make, then reads the marker again, since a taker paused past its key's life can find the stale folder already let go and another taker's in its place, where its claim succeeds too; any marker but the stale one refuses it.
export async function takeLock(
  root: string,
  n: number | string,
  { store = null, ttlMs = LOCK_TTL_MS }: { store?: LockStore | null; ttlMs?: number } = {},
): Promise<{ holder: string } | { release: () => Promise<void> }> {
  const lock = join(root, "merge.lock")
  let value: string | null = null
  if (store) {
    try {
      const taken = await store.take(LOCK_KEY, String(n), ttlMs)
      if ("holder" in taken) return taken
      value = taken.value
    } catch (err) {
      if (!unreachable(err)) throw err
    }
  }
  const held = value
  const renewing =
    store && held !== null
      ? setInterval(() => store.renew(LOCK_KEY, held, ttlMs).catch(() => false), ttlMs / 3)
      : null
  renewing?.unref()
  const letGo = async () => {
    if (renewing) clearInterval(renewing)
    if (store && held !== null) await store.free(LOCK_KEY, held).catch(() => false)
  }
  const refuse = async (holder: string) => {
    await letGo()
    return { holder }
  }
  if (!(await makeFolder(lock))) {
    const found = await folderOf(lock)
    if (held === null || found.pid === undefined || alive(found.pid)) return refuse(found.holder)
    const over = join(lock, `over-${found.marker.split(" ")[0]}`)
    if (!(await claim(over)) || (await folderOf(lock)).marker !== found.marker)
      return refuse((await folderOf(lock)).holder)
  }
  await Bun.write(join(lock, "pr"), `${n}\n`)
  if (held !== null) await Bun.write(join(lock, "redis"), `${held}\n${process.pid}\n`)
  // Moves the lock aside only while it still names this PR, so a lock someone else took after it went stale is never moved, then frees the key; once, however many ends ask, and named for the signal stopping the run in place of the random tag. It stops listening only once done, so a signal's exit waits for a release already under way.
  let released: Promise<void> | null = null
  const release = (): Promise<void> =>
    (released ??= (async () => {
      if ((await folderOf(lock)).holder === String(n)) {
        await mkdir(join(root, "merge-locks"), { recursive: true })
        const tag = stopping() ?? crypto.randomUUID().slice(0, 8)
        await rename(lock, join(root, "merge-locks", `${n}-${Date.now()}-${tag}`))
      }
      await letGo()
      unlisten()
    })())
  const unlisten = onStop(release)
  return { release }
}

// The Redis lock store REDIS_URL names, for the pr:merge and pr:train commands alone, or null: none set, or the package will not load (unbuilt, or REDIS_URL is not a URL), which keeps the lock folder alone.
async function redisStore(): Promise<LockStore | null> {
  if (!process.env.REDIS_URL) return null
  try {
    const { lockStore } = await import("@packages/redis")
    return lockStore()
  } catch (err) {
    console.error(`the merge lock keeps to its folder, since Redis's client did not load: ${err}`)
    return null
  }
}

// The store a lock taker uses: the one a test hands in, else REDIS_URL's under the command itself, else none, so a test never reaches a real Redis.
export const storeOf = async (
  local: { store?: LockStore | null },
  cli: boolean,
): Promise<LockStore | null> =>
  "store" in local ? (local.store ?? null) : cli ? redisStore() : null

// Reads the PR, judges every gate at its head, and squash-merges it at exactly that head only when every gate passed: `--match-head-commit` refuses if the head moved since. A merge holds the factory's merge lock from before it reads anything until the merge is confirmed, so canary is read inside it and no other merge lands between, and lets it go however it ends, a refusal included; a lock another merge holds refuses, naming that PR. A GitHub server error is tried once more at the same head, after checking the first try did not merge it. explain judges and stops, without the lock. The merge comment goes up after the lock is let go.
export async function prMerge(
  n: number,
  {
    explain = false,
    outsideAuthor,
    repo,
  }: { explain?: boolean; outsideAuthor?: string; repo?: string },
  run: Run = runGh,
  local: Local = {},
): Promise<Outcome> {
  const { git = runGit, lockRoot = lockRootOf() } = local
  // Anything but the pr:merge command or pr:train's ready (a test, which bun runs under NODE_ENV=production here) must bring its own git and lock folder, or it would fetch for real and take the factory's real lock.
  const cli = [join(import.meta.dir, "cli.ts"), join(import.meta.dir, "train-cli.ts")].includes(
    Bun.main,
  )
  if (!cli && (!local.git || lockRoot === realLockRoot())) {
    throw new Error(
      "prMerge under test needs a git stub and PLAYGROUND_MERGE_LOCK_DIR or a scratch lockRoot",
    )
  }
  const name = await repoOf(run, repo)
  const options = await gateOptions(name, { outsideAuthor })
  if (explain) {
    const facts = await factsOf(run, name, n, git)
    const gates = withReadyDraft(facts, gatesOf(facts, options), WILL_MARK)
    gates.push(await typesExplained(git, facts))
    return { gates, kind: "explained", merge: mergeLine(n, facts) }
  }
  // a test whose head lacks canary's tip hands in its own steps, or the gate refuses: none may run CI's for real
  const steps: TypeSteps =
    local.types ??
    (cli
      ? ciSteps
      : () => {
          throw new Error("prMerge under test needs its types gate's steps (local.types)")
        })
  const store = await storeOf(local, cli)
  let outcome: Outcome
  let head = ""
  let labels: string[] = []
  let pr: { body?: string; title?: string } = {}
  try {
    const lock = await takeLock(lockRoot, n, { store })
    if ("holder" in lock) return { gates: [], holder: lock.holder, kind: "locked" }
    try {
      const facts = await factsOf(run, name, n, git)
      head = facts.head
      labels = facts.labels ?? []
      pr = { body: facts.body, title: facts.title }
      outcome = await mergeAt(run, name, n, facts, options, {
        budgetMs: local.typesBudgetMs,
        git,
        lockRoot,
        steps,
      })
    } finally {
      await lock.release()
    }
  } finally {
    store?.close()
  }
  // a signal's stop exits once its cleanups finish, so a stopped run waits for that: no merge comment, no session ends, and no exit code of its own
  if (stopping()) await new Promise<never>(() => {})
  if (outcome.kind === "merged") {
    await run(["pr", "comment", String(n), "-R", name, "--body", mergeNote(head, outcome.gates)])
    await endSessions(
      `https://github.com/${name}/pull/${n}`,
      outcome.sha,
      local.ended ?? (cli ? liveEnded : undefined),
    )
    const shipNow = local.shipNow ?? (cli ? liveShipNow : undefined)
    const ship = labels.includes("ship-now") ? shipNowLine(n, outcome.sha, pr) : null
    if (ship && !ship.ship) console.error(ship.line)
    if (shipNow && ship?.ship) {
      await shipNow(ship.line).catch((err: unknown) =>
        console.error(
          `telling ops to ship #${n} failed: ${err instanceof Error ? err.message : err}`,
        ),
      )
    }
  }
  return outcome
}

async function mergeAt(
  run: Run,
  name: string,
  n: number,
  facts: PrFacts,
  options: GateOptions,
  types: { budgetMs?: number; git: Run; lockRoot: string; steps: TypeSteps },
): Promise<Outcome> {
  const judged = gatesOf(facts, options)
  const gates = withReadyDraft(facts, judged, MARKED)
  if (gates.some((gate) => !gate.ok)) return { gates, kind: "refused" }
  // last, since it is the one slow gate: a PR another gate refuses never waits on a type check
  gates.push(await typesGate({ ...types, facts }))
  if (gates.some((gate) => !gate.ok)) return { gates, kind: "refused" }
  // read again inside the lock, since a hold written while the types gate ran would otherwise not stop the merge
  const heldNow = await readHeld(heldPath(), name, n, Date.now())
  if (heldNow !== null) {
    const detail = `read again before the merge: ${heldNow}`
    return {
      gates: gates.map((gate) => (gate.name === "held" ? { ...gate, detail, ok: false } : gate)),
      kind: "refused",
    }
  }
  // a signal before this point has let the lock go already, so nothing merges outside it; one from here on waits for the squash to settle, since its spawned gh would carry on past an exit, so nothing is awaited between this check and settleFirst
  if (stopping()) return { gates, kind: "failed", reason: `stopped by ${stopping()}` }
  return settleFirst(async () => {
    if (marksReady(facts, judged)) {
      const reason = await markReady(run, name, n)
      if (reason) return { gates, kind: "failed", reason }
    }
    const squashed = await squashAt(run, name, n, facts.head)
    return "sha" in squashed
      ? { gates, kind: "merged", sha: squashed.sha }
      : { gates, kind: "failed", reason: squashed.reason }
  })
}

// The ready gate's words for a draft the merge path marks ready: before, as --explain reads it, and after.
const WILL_MARK = "a draft whose every other gate passes; pr:merge marks it ready before it merges"
export const MARKED = "a draft whose every other gate passes; marked ready before the merge"

// Marks a draft ready for review, returning why GitHub refused, or null once it is ready.
export async function markReady(run: Run, name: string, n: number): Promise<string | null> {
  const result = await run(["pr", "ready", String(n), "-R", name])
  return result.code === 0 ? null : `gh pr ready exited ${result.code}: ${result.stderr.trim()}`
}

// Squash-merges the PR at exactly this head, tries once more on a GitHub 5xx after checking the first try did not merge it, and returns the merge SHA once the PR reads MERGED; its body is the PR's less every Co-authored-by line, which GitHub's own squash body copies from the commits.
export async function squashAt(
  run: Run,
  name: string,
  n: number,
  head: string,
): Promise<{ sha: string } | { reason: string }> {
  const body = (
    await gh(run, ["pr", "view", String(n), "-R", name, "--json", "body", "--jq", ".body"])
  )
    .split("\n")
    .filter((line) => !/^co-authored-by:/i.test(line))
    .join("\n")
  const args = [
    "pr",
    "merge",
    String(n),
    "-R",
    name,
    "--squash",
    "--body",
    body,
    "--match-head-commit",
    head,
  ]
  for (let attempt = 1; ; attempt++) {
    const result = await run(args)
    const after = await stateOf(run, name, n)
    if (after.state === "MERGED" && after.mergeCommit) return { sha: after.mergeCommit.oid }
    if (result.code === 0) return { reason: `gh pr merge exited 0 but the PR reads ${after.state}` }
    if (attempt === 1 && isServerError(result.stderr) && after.state === "OPEN") continue
    return { reason: `gh pr merge exited ${result.code}: ${result.stderr.trim()}` }
  }
}
