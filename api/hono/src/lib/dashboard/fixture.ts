import "@packages/env/aliases"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path"

import { threadIdSchema } from "@packages/config/threads"
import type { Roots } from "@packages/safe-delete"
import { deriveRoot, HARNESS_IDS } from "@packages/settings"
import { z } from "zod"

// Relative, not @/: paths.ts imports this file, and the web's tests type-check it under web/next's own @/ paths.
import shipped from "../../fixtures/dashboard.json" with { type: "json" }
import { livePair } from "../dev/live-dashboard"
import { startOf } from "../dev/stop"
import { FIX_IDS } from "../onboard/fix-ids"
import { discard, trashRoots } from "../trash"

// Where the dashboard's data comes from, chosen by who runs the stack (ADR 0008): a person's own clone reads their own machine (herdr's sessions, Claude Code's config folder, git, GitHub and the System panel's probes), and a factory, test or PLAYGROUND_FIXTURE stack reads a fixture, a made-up machine written into a scratch folder of its own, so real rows never reach a screenshot or a PR. A refused source reads nothing at all.
export type DashboardSource =
  | { file: string | null; kind: "fixture"; rule: "factory" | "fixture" | "test" }
  | { kind: "hosted" }
  | { kind: "live"; rule: "live-branch" | "live-reads" | "own" }
  | { kind: "refused"; reason: string }

export type DashboardRule = Exclude<DashboardSource, { kind: "hosted" | "refused" }>["rule"]

// Each rule in words, as the launcher prints the one a stack matched.
export const DASHBOARD_RULES: Record<DashboardRule, string> = {
  factory: "a factory stack (a checkout under .claude/worktrees/, or PLAYGROUND_ROLE set)",
  fixture: "PLAYGROUND_FIXTURE is set",
  "live-branch": "the live checkout (the branch live.branch names)",
  "live-reads": "PLAYGROUND_LIVE_READS is set",
  own: "your own clone, outside the factory",
  test: "a test run (NODE_ENV=test)",
}

// PLAYGROUND_FIXTURE=shipped names the fixture that ships in api/hono/src/fixtures/dashboard.json.
export const SHIPPED_FIXTURE = "shipped"

// The shipped fixture's own file, whose mtime tells a copy written from it that it changed.
const SHIPPED_PATH = join(import.meta.dir, "../../fixtures/dashboard.json")

const yes = (value: string | undefined): boolean => /^(1|true)$/i.test(value?.trim() ?? "")

const set = (value: string | undefined): boolean => Boolean(value?.trim())

// A worker's checkout: any folder directly under a .claude/worktrees folder, or inside one.
export const inFactoryCheckout = (root: string): boolean =>
  /(^|[\\/])\.claude[\\/]worktrees[\\/][^\\/]+/.test(root)

// Pure: the source a stack on this branch, in this checkout, with this environment, reads; the first rule that matches wins. 0 the hosted build (PLAYGROUND_HOSTED) reads no machine, whatever else is set; 1 the live dashboard's branch and 2 PLAYGROUND_LIVE_READS read live (a fixture beside either is refused); 3 a test run, 4 PLAYGROUND_FIXTURE (relative to the checkout's root, or absolute) and 5 a factory stack, a checkout under .claude/worktrees/ or PLAYGROUND_ROLE set read a fixture; 6 anything else is a person's own clone and reads their own machine, unless it runs under Claude Code with no role, which is an agent's stack and is refused. A CLAUDE_CONFIG_DIR alone never decides. A test run's PLAYGROUND_FIXTURE counts for nothing: the suite reads the shipped fixture, or the live paths its liveReads opts into, never the worktree's dev fixture left in .env.
export function dashboardSource({
  branch,
  env,
  live = livePair(env).branch,
  root,
}: {
  branch: string | null
  env: Record<string, string | undefined>
  live?: string
  root: string
}): DashboardSource {
  if (yes(env.PLAYGROUND_HOSTED)) return { kind: "hosted" }
  let fixture = env.PLAYGROUND_FIXTURE?.trim() || null
  if (env.NODE_ENV?.trim() === "test") fixture = null
  if (branch === live) {
    return fixture
      ? {
          kind: "refused",
          reason: `this checkout is on ${live}, which always reads the live machine; unset PLAYGROUND_FIXTURE`,
        }
      : { kind: "live", rule: "live-branch" }
  }
  if (yes(env.PLAYGROUND_LIVE_READS)) {
    return fixture
      ? {
          kind: "refused",
          reason:
            "PLAYGROUND_LIVE_READS reads the live machine and PLAYGROUND_FIXTURE a made-up one; set one of them",
        }
      : { kind: "live", rule: "live-reads" }
  }
  if (env.NODE_ENV?.trim() === "test") return { file: null, kind: "fixture", rule: "test" }
  if (fixture) {
    return {
      file: fixture === SHIPPED_FIXTURE ? null : resolve(root, fixture),
      kind: "fixture",
      rule: "fixture",
    }
  }
  if (inFactoryCheckout(root) || set(env.PLAYGROUND_ROLE)) {
    return { file: null, kind: "fixture", rule: "factory" }
  }
  if (set(env.CLAUDECODE)) {
    return {
      kind: "refused",
      reason: `this stack would read your own machine, but it runs under Claude Code with no PLAYGROUND_ROLE, so an agent started it; start it from your own terminal, or set PLAYGROUND_FIXTURE=${SHIPPED_FIXTURE} for test data`,
    }
  }
  return { kind: "live", rule: "own" }
}

// The checkout this file sits in: the nearest folder holding .git, walking up, so source and bundle alike find their own and a worktree never falls through to the main checkout around it. null in a Docker image, which carries none.
export function checkoutRoot(from: string = import.meta.dir): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir
    if (dirname(dir) === dir) return null
  }
}

// The branch a checkout is on, read once for currentSource: null on a detached HEAD or where git cannot say, undefined when the read gave up on its timeout, so a wedged git is not pinned into the cache.
const branchRead = (root: string | null): string | null | undefined => {
  if (!root) return null
  const read = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: root,
    stderr: "ignore",
    stdin: "ignore",
    // a wedged git must not hold a test or a request that reaches readsLive()
    timeout: 5_000,
  })
  if (read.exitCode === null) return undefined
  return read.exitCode === 0 ? read.stdout.toString().trim() || null : null
}

// The branch a checkout is on, null on a detached HEAD or where git cannot say.
export function branchOf(root: string | null): string | null {
  return branchRead(root) ?? null
}

let checkout: { branch: string | null; root: string } | null = null

// This process's source, from its own branch (read once; a read that gave up on its timeout answers as no branch but stays uncached, so the next call asks git again) and its environment as it is now (the API's entry loads .env before any dashboard code runs, and a test sets PLAYGROUND_LIVE_READS for the live paths it drives).
export const currentSource = (): DashboardSource => {
  if (yes(process.env.PLAYGROUND_HOSTED)) return { kind: "hosted" }
  if (!checkout) {
    const root = checkoutRoot()
    const branch = branchRead(root)
    if (branch === undefined)
      return dashboardSource({ branch: null, env: process.env, root: root ?? process.cwd() })
    checkout = { branch, root: root ?? process.cwd() }
  }
  return dashboardSource({ ...checkout, env: process.env })
}

export const readsLive = (): boolean => currentSource().kind === "live"

// The scratch folder a fixture is written into: inside a worktree's own .turbo (ignored by git and Docker, beside the launcher's record), else the system's temp folder, one per clone, since the trash refuses a folder inside a main checkout. PLAYGROUND_FIXTURE_DIR lets a test keep it elsewhere, as DEV_RECORD does the record, relative to the checkout's root as PLAYGROUND_FIXTURE is, so the launcher and the API, which run from different folders, name the same one.
export const fixtureDir = (
  env: Record<string, string | undefined> = process.env,
  root: string | null = checkoutRoot(),
  tmp: string = tmpdir(),
): string => {
  if (env.PLAYGROUND_FIXTURE_DIR) return resolve(root ?? process.cwd(), env.PLAYGROUND_FIXTURE_DIR)
  const scratch = join(tmp, `playground-dashboard-fixture-${process.getuid?.() ?? 0}`)
  if (!root) return scratch
  if (statSync(join(root, ".git")).isFile()) return join(root, ".turbo", "dashboard-fixture")
  return `${scratch}-${new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 8)}`
}

// The fixture's Claude Code config folder, which stands in for ~/.claude on a fixture stack.
export const fixtureConfigDir = (dir = fixtureDir()): string => join(dir, "claude")

// The Claude Code config folder this process reads: the live one only on a live source, the fixture's on a fixture source (written first when missing), and the fixture's unwritten one on a hosted or refused source, so neither reads anything real. The live one is where spawn.sh's sessions register: under inscope (INSCOPE_CCD) spawn.sh starts them from ~/.claude, as the CLI's probe.ts reads them, so the board never reads inscope's own folder and misses a dispatcher the CLI sees.
export function configDir(): string {
  const source = currentSource()
  if (source.kind === "live")
    return (!process.env.INSCOPE_CCD && process.env.CLAUDE_CONFIG_DIR) || join(homedir(), ".claude")
  return fixtureConfigDir(source.kind === "fixture" ? ensureFixture(source) : fixtureDir())
}

const json = z.record(z.string(), z.unknown())

// A path under the config folder: relative, and never climbing out of it.
const relativePath = z
  .string()
  .refine(
    (path) => !isAbsolute(path) && !normalize(path).split(sep).includes(".."),
    "a path inside the config folder",
  )

// A session's transcript, which a message typed into the session is appended to: `$CONFIG/` and a path inside the config folder.
const transcriptPath = z
  .string()
  .refine(
    (path) =>
      path.startsWith("$CONFIG/") && relativePath.safeParse(path.slice("$CONFIG/".length)).success,
    "a path in the config folder, starting $CONFIG/",
  )

// A made-up thread (lib/dashboard/threads.ts): each message is the uuid of one of the session's transcript lines, in the thread's order.
const fixtureThread = z.object({
  archivedAt: z.iso.datetime({ offset: true }).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  id: threadIdSchema,
  lastReadAt: z.iso.datetime({ offset: true }).optional(),
  messages: z.array(z.string().min(1)),
  pinnedAt: z.iso.datetime({ offset: true }).optional(),
  session: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.iso.datetime({ offset: true }),
})

// One row of onboarding's list (lib/onboard/checks.ts), as the API answers it.
const doctorCheck = z.object({
  action: z.object({ id: z.enum([...FIX_IDS, "settings"]), label: z.string().min(1) }).nullable(),
  detail: z.string(),
  name: z.string().min(1),
  need: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(["MISSING", "ok", "optional", "waiting"]),
})

// A harness's made-up facts: the version installed (null when none), whether it is signed in, and its plan.
const harnessFacts = z.object({
  plan: z.string().nullable(),
  signedIn: z.boolean(),
  version: z.string().nullable(),
})

export const fixtureSchema = z.object({
  // The made-up Claude account of Claude Code's config, which the user menu shows when usage.json names no login (lib/dashboard/account.ts).
  account: z.object({ email: z.email(), name: z.string().nullable() }).optional(),
  // Every ISO time in the file, and every epoch-seconds `resets_at`, moves by the time between this and the moment the fixture is written, so ages, ETAs and usage stay as current as they read here.
  anchor: z.iso.datetime({ offset: true }),
  // Onboarding's tool rows on the made-up machine, the database's left to the API: every one ok, and the missing set a stack answers while PLAYGROUND_ONBOARD_MISSING is set; and each harness's facts its card is built from (lib/onboard/harness.ts).
  doctor: z
    .object({
      checks: z.array(doctorCheck),
      harnesses: z.record(z.enum(HARNESS_IDS), harnessFacts).optional(),
      missing: z.array(doctorCheck),
    })
    .optional(),
  // Each file under the config folder by its path: a .jsonl as an array of lines, a { "$base64": … } as bytes, anything else as JSON. `$CONFIG` in any string is that folder.
  files: z.record(relativePath, z.unknown()),
  git: z.record(
    z.string(),
    z.object({ branch: z.string().nullable(), repo: z.string().nullable() }),
  ),
  // herdr's playground server on the made-up machine, which herdr.ts answers its requests from (herdr.json): each pane as session.snapshot gives it, with the processes pane.process_info names and the session its messages go to, what each pane's screen shows above its input box, the picker a blocked pane draws in place of that box, and the workspaces.
  herdr: z.object({
    panes: z.array(
      z.looseObject({
        pane_id: z.string().min(1),
        processes: z.array(json),
        // the session a prompt or a sent input goes to; a pane with no transcript takes them and records nothing
        session_id: z.string().min(1).optional(),
        terminal_id: z.string().min(1),
        transcript_path: transcriptPath.optional(),
        workspace_id: z.string().min(1),
      }),
    ),
    prompts: z.record(z.string(), z.string()),
    // set while a made-up restore can still bring the dispatcher back, as restoring() in herdr.ts reads a live one, so the home says the factory is coming back; absent otherwise
    restoring: z.iso.datetime({ offset: true }).optional(),
    screens: z.record(z.string(), z.string()),
    workspaces: z.array(json),
  }),
  // Each repo's merged PullRequest nodes, as the Usage app's query reads them (lib/usage/prs.ts).
  merged: z.record(z.string(), z.array(json)).optional(),
  // The made-up checkout's origin remote, which the sidebar's GitHub icon links to as its pull requests page.
  origin: z.string().optional(),
  // The processes the made-up machine runs, by pid: what `ps` would say of each.
  processes: z.record(z.string(), z.object({ command: z.string(), start: z.string() })),
  // A GitHub PullRequest node by lookup (a PR URL, or owner/name#branch), as the dashboard's query reads it.
  pulls: z.record(z.string(), json),
  system: z.object({
    cores: z.number().int().positive(),
    disk: z.object({ freeBytes: z.number(), totalBytes: z.number() }),
    load: z.tuple([z.number(), z.number(), z.number()]),
    // Each System panel probe's stdout, by its name in probe.ts's COMMANDS.
    probes: z.record(z.string(), z.string()),
    totalBytes: z.number(),
  }),
  // The owner's made-up threads, which bun run ingest writes into a fixture stack's database once it has read the transcripts their messages are in.
  threads: z.array(fixtureThread).optional(),
  // How far the made-up dashboard's build is behind the branch it follows, as the update check reports it (lib/dashboard/update.ts), so a fixture stack shows the update icon and Update now without running git.
  update: z
    .object({
      behind: z.number().int().nonnegative(),
      branch: z.string(),
      live: z.boolean().default(false),
      newest: z.object({ at: z.iso.datetime({ offset: true }), title: z.string() }),
      pulled: z.boolean(),
      upstream: z.enum(["canary", "main"]),
    })
    .optional(),
  // The owner's made-up open pull requests in the work org, as the work queue's search answers them (lib/dashboard/work-queue.ts); a stack shows them once WORK_GITHUB_ORG is set.
  work: z.array(json).optional(),
  // The made-up worktrees the Inbox's Preview row lists (lib/dashboard/stacks.ts), each its stack's URL while it runs, `$WEB` naming this stack's own web URL so its link opens in a tab, else null.
  worktrees: z
    .array(
      z.object({
        branch: z.string().nullable(),
        path: z.string().min(1),
        project: z.string().min(1),
        url: z.string().nullable(),
        vibe: z.boolean().optional(),
      }),
    )
    .optional(),
})

export type Fixture = z.infer<typeof fixtureSchema>

// The fixture a file holds, the shipped one when none is named, or why it cannot be read.
export function loadFixture(
  file: string | null,
): { fixture: Fixture; ok: true } | { error: string; ok: false } {
  let raw: unknown = shipped
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      return { error: `${file} does not read as JSON: ${messageOf(error)}`, ok: false }
    }
  }
  const parsed = fixtureSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: `${file ?? "the shipped fixture"} is not a fixture: ${issue?.path.join(".") || "its root"}: ${issue?.message}`,
      ok: false,
    }
  }
  return { fixture: parsed.data, ok: true }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

// A moment in prose, as linear-scan's heading writes one: `Thu 1 Jan, 11:30 am UTC`.
export const proseTime = (at: Date): string => {
  const part = (options: Intl.DateTimeFormatOptions) =>
    at.toLocaleString("en-GB", { ...options, timeZone: "UTC" })
  const hours = at.getUTCHours()
  const minutes = String(at.getUTCMinutes()).padStart(2, "0")
  return `${part({ weekday: "short" })} ${at.getUTCDate()} ${part({ month: "short" })}, ${hours % 12 || 12}:${minutes} ${hours < 12 ? "am" : "pm"} UTC`
}

// Pure: a value with every ISO time and epoch `resets_at` moved by shiftMs, every `$WHEN{<ISO time>}` in prose made that moment moved and written as proseTime writes it, and `$CONFIG` made the config folder.
export function settle(value: unknown, shiftMs: number, config: string, key = ""): unknown {
  if (typeof value === "string") {
    if (ISO_TIME.test(value)) return new Date(Date.parse(value) + shiftMs).toISOString()
    return value
      .replace(/\$WHEN\{([^}]+)\}/g, (_, at: string) =>
        proseTime(new Date(Date.parse(at) + shiftMs)),
      )
      .replaceAll("$CONFIG", config)
  }
  if (typeof value === "number") {
    return key === "resets_at" ? Math.round(value + shiftMs / 1000) : value
  }
  if (Array.isArray(value)) return value.map((item) => settle(item, shiftMs, config))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, settle(v, shiftMs, config, k)]),
    )
  }
  return value
}

const STAMP = "stamp.json"

// The launcher's pid and start in the copy it wrote, so a CLI in the same checkout leaves a running stack's copy alone.
const LAUNCHER = "launcher.json"

const writeEntry = (path: string, content: unknown): void => {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true })
  if (path.endsWith(".jsonl") && Array.isArray(content)) {
    writeFileSync(path, content.map((line) => `${JSON.stringify(line)}\n`).join(""), {
      mode: 0o600,
    })
  } else if (
    typeof content === "object" &&
    content !== null &&
    typeof (content as { $base64?: unknown }).$base64 === "string"
  ) {
    writeFileSync(path, Buffer.from((content as { $base64: string }).$base64, "base64"), {
      mode: 0o600,
    })
  } else {
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), {
      mode: 0o600,
    })
  }
}

// Marks dir's copy as the running launcher's own, by its pid and start, which a reused pid never matches; the launcher passes the start it already read.
export function markLaunched(dir: string, pid = process.pid, started = startOf(pid)): void {
  writeEntry(join(dir, LAUNCHER), { pid, started })
}

// Each launcher record this process has matched by ps, so a later read asks only whether its pid still runs, and a follower that reads the fixture on every call spawns no ps for it; a pid reused after the match reads as the launcher, so this process keeps the copy until it restarts.
const matched = new Set<string>()

// Whether dir's copy belongs to a launcher that still runs; start reads a pid's start, ps by default.
export const launcherRuns = (dir: string, start = startOf): boolean => {
  try {
    const { pid, started } = JSON.parse(readFileSync(join(dir, LAUNCHER), "utf8"))
    if (!Number.isInteger(pid) || typeof started !== "string") return false
    if (matched.has(`${pid} ${started}`)) return running(pid)
    if (start(pid) !== started) return false
    matched.add(`${pid} ${started}`)
    return true
  } catch {
    return false
  }
}

// Signal 0 delivers nothing: it only asks whether the pid exists (EPERM means it does, under another user).
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Moves a fixture's folder into the trash under this process's own session, so a restart within the minute is not held to the last one's tripwire; a refusal throws in its words.
const trashFixture = (path: string, roots: Roots) => {
  const refused = discard(
    path,
    { reason: "dashboard fixture", session: `fixture-${process.pid}` },
    roots,
  )
  if (refused) throw new Error(`the fixture's ${path} stays: ${refused}`)
}

// Writes a fixture into dir, fresh, as of now: the config folder, herdr's state (herdr.json) and the rest of the machine (machine.json). The folder is replaced whole and only when it is a fixture's own (its stamp.json), so a misnamed folder (a real config folder) is refused rather than overwritten; the one it replaces goes to the trash of the roots given before anything is written, so a refusal changes nothing.
export function writeFixture(
  fixture: Fixture,
  dir: string,
  roots: Roots,
  now = new Date(),
  rename = renameSync,
): void {
  const target = resolve(dir)
  if (existsSync(target) && !existsSync(join(target, STAMP))) {
    throw new Error(`${target} exists and is not a fixture's folder, so it is left alone`)
  }
  const fresh = `${target}.writing-${process.pid}`
  trashFixture(fresh, roots)
  if (existsSync(target)) trashFixture(target, roots)
  mkdirSync(fresh, { mode: 0o700, recursive: true })
  const config = join(target, "claude")
  const shift = now.getTime() - Date.parse(fixture.anchor)
  const at = <T>(value: T): T => settle(value, shift, config) as T
  for (const [path, content] of Object.entries(fixture.files)) {
    writeEntry(join(fresh, "claude", path), at(content))
  }
  // A settings scope counts only once it is a repository (scopesIn), so each one the fixture seeds is made one, as its first write would, its settings.json left for that write to commit.
  const extensions = join(fresh, "claude", "playground", "extensions")
  for (const entry of existsSync(extensions)
    ? readdirSync(extensions, { withFileTypes: true })
    : []) {
    if (!entry.isDirectory()) continue
    const init = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
      cwd: join(extensions, entry.name),
      stderr: "pipe",
      stdin: "ignore",
    })
    if (init.exitCode !== 0)
      throw new Error(`git init in the fixture's ${entry.name}: ${init.stderr}`)
  }
  // policy.json and the guards' lists, derived from the scopes as a first write would, so Why reads them.
  const login = join(extensions, "login")
  if (existsSync(login)) deriveRoot(dirname(extensions), readFileSync(login, "utf8").trim())
  for (const folder of ["playground/attachments"]) {
    mkdirSync(join(fresh, "claude", folder), { mode: 0o700, recursive: true })
    chmodSync(join(fresh, "claude", folder), 0o700)
  }
  writeEntry(join(fresh, "herdr.json"), { inputs: {}, ...at(fixture.herdr) })
  writeEntry(join(fresh, "machine.json"), {
    account: fixture.account ?? null,
    doctor: fixture.doctor ?? null,
    git: at(fixture.git),
    merged: at(fixture.merged ?? {}),
    origin: fixture.origin ?? null,
    processes: at(fixture.processes),
    pulls: at(fixture.pulls),
    system: fixture.system,
    threads: at(fixture.threads ?? []),
    update: at(fixture.update ?? null),
    work: at(fixture.work ?? []),
    worktrees: fixture.worktrees ?? [],
  })
  writeEntry(join(fresh, STAMP), { writtenAt: now.toISOString() })
  try {
    rename(fresh, target)
  } catch (error) {
    // Another writer's rename landed first (two test files in one shard), so its complete fixture stands and this one's copy goes.
    const code = (error as NodeJS.ErrnoException).code
    if ((code !== "ENOTEMPTY" && code !== "EEXIST") || !existsSync(join(target, STAMP))) throw error
    trashFixture(fresh, roots)
  }
}

// Moves a fixture's folder into the trash of the roots given when it is one (a stack's scratch state goes with the stack).
export function dropFixture(dir: string, roots: Roots): void {
  const target = resolve(dir)
  if (existsSync(join(target, STAMP))) trashFixture(target, roots)
}

// The folder this process reads its fixture from, written from its source's file when it is not there yet (the API started without the launcher, or a CLI before any stack). Throws on a hosted, live or refused source.
export function ensureFixture(source: DashboardSource = currentSource()): string {
  if (source.kind !== "fixture") {
    throw new Error(
      source.kind === "refused"
        ? source.reason
        : source.kind === "hosted"
          ? "the hosted build reads no machine, not even a fixture"
          : "this stack reads the live machine, not a fixture",
    )
  }
  const dir = fixtureDir()
  const stamp = join(dir, STAMP)
  const launched = yes(process.env.PLAYGROUND_FIXTURE_LAUNCHED)
  // A copy is written again only when its source file changed after the copy was stamped, read from disk so the edit reaches it; a stack's copy is its launcher's, kept with its own writes while that launcher runs, read from inside the stack or beside it.
  const from = source.file ?? SHIPPED_PATH
  const newer = (): boolean => existsSync(from) && statSync(from).mtimeMs > statSync(stamp).mtimeMs
  if (existsSync(stamp) && (launched || !newer() || launcherRuns(dir))) return dir
  // The launcher wrote this stack's fixture and drops it as the stack stops, so a process that outlives the stop (the API until its group is killed) finds it gone and writes nothing back.
  if (launched) {
    throw new Error(
      `the stack's fixture at ${dir} went when it stopped; start it again with bun run dev`,
    )
  }
  const loaded = loadFixture(existsSync(stamp) ? from : source.file)
  if (!loaded.ok) throw new Error(loaded.error)
  writeFixture(loaded.fixture, dir, trashRoots())
  return dir
}

export type FixtureHerdr = Fixture["herdr"] & {
  // What has been typed into each pane's input and not yet sent.
  inputs: Record<string, string>
}

const NO_HERDR: Fixture["herdr"] = {
  panes: [],
  prompts: {},
  screens: {},
  workspaces: [],
}

export type FixtureMachine = {
  account?: Fixture["account"] | null
  doctor?: Fixture["doctor"] | null
  git: Fixture["git"]
  merged?: NonNullable<Fixture["merged"]>
  origin?: string | null
  processes: Fixture["processes"]
  pulls: Fixture["pulls"]
  system: Fixture["system"]
  threads?: NonNullable<Fixture["threads"]>
  update?: Fixture["update"] | null
  work?: NonNullable<Fixture["work"]>
  worktrees?: NonNullable<Fixture["worktrees"]>
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

// A fixture written before herdr.json was runs no herdr server.
export const readFixtureHerdr = (dir = ensureFixture()): FixtureHerdr => {
  const path = join(dir, "herdr.json")
  return existsSync(path) ? readJson<FixtureHerdr>(path) : { ...NO_HERDR, inputs: {} }
}

const writeFixtureHerdr = (state: FixtureHerdr, dir: string): void => {
  const path = join(dir, "herdr.json")
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

let machine: { at: number; path: string; value: FixtureMachine } | null = null

export const readFixtureMachine = (dir = ensureFixture()): FixtureMachine => {
  const path = join(dir, "machine.json")
  const at = statSync(path).mtimeMs
  if (machine?.path !== path || machine.at !== at) {
    machine = { at, path, value: readJson<FixtureMachine>(path) }
  }
  return machine.value
}

// Told whenever a write changes the fixture's herdr state, so the dashboard's hub refreshes as herdr's events would make it.
const listeners = new Set<() => void>()

export const onFixtureChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const changed = () => {
  for (const listener of listeners) listener()
}

const str = (value: unknown): string => (typeof value === "string" ? value : "")

// An input box as Claude Code draws it, between two rules: empty, or holding what has been typed.
const inputBox = (above: string, typed: string): string => {
  const rule = "─".repeat(60)
  const box = typed ? typed.split("\n").map((line, i) => `${i ? "  " : "❯ "}${line}`) : ["❯"]
  return [above, rule, ...box, rule, "  ? for shortcuts"].join("\n")
}

// A Vibeground's Start or Stop on a fixture stack: its made-up worktree runs on this stack's own dashboard, a path of its own so the pane tells it from `$WEB`, or stops, in the scratch copy alone.
export function fixtureVibe(path: string, running: boolean, dir = ensureFixture()): void {
  const file = join(dir, "machine.json")
  const state = readJson<FixtureMachine>(file)
  state.worktrees = (state.worktrees ?? []).map((worktree) =>
    worktree.path === path
      ? { ...worktree, url: running ? "$WEB/dashboard" : null, vibe: running }
      : worktree,
  )
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

const IMAGE_PATH = /\.(gif|jpe?g|png|webp)$/i

// The lines Claude Code writes for a paste (measured on 2.1.304): it splits the paste at a space before a path and at each line end, drops empty lines, and takes each image path it can read in as an image, its [Image #n] marks put first, a space between them as 2.1.309 writes them; a meta line of the same prompt then names each image's source. A paste with no image it could read is kept whole, wrapped in pasted_content tags when long.
const pastedLines = (typed: string, line: Record<string, unknown>): Record<string, unknown>[] => {
  const parts = typed
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap((part) => part.split("\n"))
    .filter((part) => part.trim())
  const images: string[] = []
  const words: string[] = []
  for (const part of parts) {
    if (IMAGE_PATH.test(part.trim()) && existsSync(part.trim())) images.push(part.trim())
    else words.push(part)
  }
  // shortcut: 200 chars sits between the longest plain paste (151) and the shortest wrapped one (211) measured in real transcripts; upgrade when Claude Code's own rule is known
  if (!images.length && typed.length > 200) {
    const id = crypto.randomUUID().slice(0, 4)
    const content = `\n\n<pasted_content id="${id}">\n${typed}\n</pasted_content id="${id}">\n`
    return [{ ...line, message: { content, role: "user" } }]
  }
  if (!images.length) return [line]
  const promptId = crypto.randomUUID()
  const blocks = images.map((path) => ({
    source: {
      data: readFileSync(path).toString("base64"),
      media_type: `image/${IMAGE_PATH.exec(path)?.[1]?.toLowerCase().replace("jpg", "jpeg")}`,
      type: "base64",
    },
    type: "image",
  }))
  const marks = images.map((_, i) => `[Image #${i + 1}]`).join(" ")
  return [
    {
      ...line,
      imagePasteIds: images.map((_, i) => i + 1),
      message: {
        content: [{ text: marks + words.join("\n"), type: "text" }, ...blocks],
        role: "user",
      },
      promptId,
    },
    ...images.map((path) => ({
      ...line,
      isMeta: true,
      message: { content: [{ text: `[Image: source: ${path}]`, type: "text" }], role: "user" },
      origin: undefined,
      promptId,
      uuid: crypto.randomUUID(),
    })),
  ]
}

// A message sent into a made-up session, as the lines its transcript records for typed words or a paste, so the page sees it delivered as it would a live session's.
const sent = (
  session: Record<string, unknown>,
  typed: string,
  pasted: boolean,
  dir: string,
  now: Date,
): void => {
  const path = str(session.transcript_path)
  if (!path) return
  if (!resolve(path).startsWith(`${resolve(fixtureConfigDir(dir))}${sep}`)) {
    throw new Error(`${path} is outside the fixture's folder`)
  }
  const line = {
    cwd: str(session.cwd),
    message: { content: typed, role: "user" },
    origin: { kind: "human" },
    sessionId: str(session.session_id),
    timestamp: now.toISOString(),
    type: "user",
    uuid: crypto.randomUUID(),
  }
  const lines = pasted ? pastedLines(typed, line) : [line]
  appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""))
}

// The name a fixture session was started with, `claude -n <name>`, as workers.ts reads a live one's.
const startedAs = (args: unknown): string => {
  const argv = Array.isArray(args) ? args.map(str) : []
  const at = argv.findIndex((arg) => arg === "-n" || arg === "--name")
  return at === -1 ? "" : (argv[at + 1] ?? "")
}

// A process start as ps's lstart prints it ("Thu Oct  1 08:00:00 2026"), the form Claude's registry keeps beside it.
const lstart = (at: Date): string => {
  const [day, month, date = "", year] = at.toDateString().split(" ")
  return `${day} ${month} ${date.padStart(2, " ")} ${at.toTimeString().slice(0, 8)} ${year}`
}

// A made-up session started as name, as a spawn leaves one: its herdr workspace and pane, Claude's registry file at a new pid, and that pid's row in ps, so the live proof holds.
const madeUp = (state: FixtureHerdr, name: string, dir: string, now: Date): void => {
  const like = state.panes[0]?.processes[0] ?? {}
  const cwd = str(like.cwd) || "/fixture/playground"
  const claude = (Array.isArray(like.argv) && str(like.argv[0])) || "claude"
  const machine = readFixtureMachine(dir)
  const pid = Math.max(900000, ...Object.keys(machine.processes).map(Number)) + 1
  const sessionId = crypto.randomUUID()
  const workspace = `w${(state.workspaces.length + 1).toString(36).toUpperCase()}`
  const start = lstart(now)
  const transcript = join(
    fixtureConfigDir(dir),
    "projects",
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  )
  state.workspaces.push({ label: name, workspace_id: workspace })
  state.panes.push({
    agent_session: { kind: "id", value: sessionId },
    agent_status: "idle",
    pane_id: `${workspace}:p1`,
    processes: [{ argv: [claude, "-n", name], cwd, pid }],
    scroll: { offset_from_bottom: 0 },
    session_id: sessionId,
    terminal_id: `t-${crypto.randomUUID()}`,
    transcript_path: transcript,
    workspace_id: workspace,
  })
  writeEntry(transcript, "")
  writeEntry(join(fixtureConfigDir(dir), "sessions", `${pid}.json`), {
    cwd,
    kind: "interactive",
    name,
    pid,
    procStart: start,
    sessionId,
    startedAt: now.getTime(),
    status: "idle",
  })
  const path = join(dir, "machine.json")
  const processes = { ...machine.processes, [pid]: { command: `claude -n ${name}`, start } }
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...machine, processes }, null, 2), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

// A start of a made-up session on a fixture stack, which spawns nothing: a pane runs the session started as name, or a made-up one starts in a pane of its own, as spawn.sh would start it in herdr. True when one started, false when one already runs.
export function fixtureStart(name: string, dir = ensureFixture(), now = new Date()): boolean {
  const state = readFixtureHerdr(dir)
  if (state.panes.some((p) => p.processes.some((x) => startedAs(x.argv) === name))) return false
  madeUp(state, name, dir, now)
  writeFixtureHerdr(state, dir)
  changed()
  return true
}

// herdr refusing a request on a fixture stack, by the code herdr's own error would carry (herdr.ts answers it as HerdrRefused).
export class FixtureHerdrRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const paneOf = (state: FixtureHerdr, pane: string) => {
  const found = state.panes.find((p) => p.pane_id === pane)
  if (!found) throw new FixtureHerdrRefusal("pane_not_found", `no pane ${pane}`)
  return found
}

// One made-up pane as the fixture's herdr.json holds it, or herdr's refusal when there is none.
export const fixtureHerdrPane = (pane: string, dir = ensureFixture()) =>
  paneOf(readFixtureHerdr(dir), pane)

// A made-up pane's screen: what it shows above, then the picker a blocked pane draws, else its input box.
export function fixtureHerdrScreen(pane: string, dir = ensureFixture()): string {
  const state = readFixtureHerdr(dir)
  paneOf(state, pane)
  const above = state.screens[pane] ?? ""
  const picker = state.prompts[pane]
  return picker === undefined ? inputBox(above, state.inputs[pane] ?? "") : `${above}\n${picker}`
}

export type FixtureHerdrInput = { keys: string[] } | { prompt: string } | { text: string }

// What a request types into a made-up pane. A prompt (agent.prompt) sends its text as a paste and its Enter, as herdr's bracketed paste does, refused while the pane draws a picker, as herdr refuses one into a blocked session; words fill the input box; Enter sends the box, and Enter or a number key answers a picker, whose rows the arrows and Space move over unseen. A message sent or a picker answered sets the pane working.
export function fixtureHerdrInput(
  pane: string,
  input: FixtureHerdrInput,
  dir = ensureFixture(),
  now = new Date(),
): void {
  const state = readFixtureHerdr(dir)
  const found = paneOf(state, pane)
  const session = { ...found, cwd: str(found.processes[0]?.cwd) }
  const send = (typed: string, pasted: boolean) => {
    sent(session, typed, pasted, dir, now)
    found.agent_status = "working"
  }
  if ("prompt" in input) {
    if (state.prompts[pane] !== undefined) {
      throw new FixtureHerdrRefusal("agent_blocked", `${pane} waits on a prompt`)
    }
    send(input.prompt, true)
  } else if ("text" in input) {
    if (state.prompts[pane] === undefined)
      state.inputs[pane] = (state.inputs[pane] ?? "") + input.text
  } else {
    for (const key of input.keys) {
      if (state.prompts[pane] !== undefined && (key === "enter" || /^\d$/.test(key))) {
        delete state.prompts[pane]
        found.agent_status = "working"
      } else if (key === "enter" && state.inputs[pane]) {
        send(state.inputs[pane], false)
        delete state.inputs[pane]
      }
    }
  }
  writeFixtureHerdr(state, dir)
  changed()
}
