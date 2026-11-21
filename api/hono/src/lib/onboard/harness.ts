import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { site } from "@packages/config/site"
import { dataDirOf } from "@packages/env/data-dir"
import { HARNESSES, type HarnessId } from "@packages/settings"

import {
  type DashboardSource,
  checkoutRoot,
  currentSource,
  readFixtureMachine,
} from "@/lib/dashboard/fixture"
import type { Check } from "@/lib/onboard/checks"
import { type FixId, fixtureFixed } from "@/lib/onboard/fix-ids"
import { askOnce, machine, type Reader } from "@/lib/onboard/machine"

// The harness cards first run and Settings show, one for each harness in HARNESSES: whether it is installed at the version the factory tested, whether it is signed in, for Claude Code whether it trusts the checkout's folder, and its plan, each a row in the checks' shape, a failed row naming the fix that installs it or signs it in (fix-ids.ts). Every probe is a fixed argv built here and only reports; a fixture stack runs none and reads its fixture's facts.

export type HarnessCard = {
  checks: Check[]
  id: HarnessId
  label: string
  ready: boolean
  refusal: string | null
}

// What a card is built from: the version installed (null when none), whether it is signed in, the plan read after sign-in, and for Claude Code whether its config trusts the checkout's folder.
export type HarnessFacts = {
  plan: string | null
  signedIn: boolean
  trusted: boolean
  version: string | null
}

type Env = Record<string, string | undefined>
type Ask = (argv: string[], lines: string[], id: number) => Promise<unknown>
// A fixed file's text, null when it is not there.
type Read = (path: string) => Promise<string | null>

const readText: Read = async (path) => {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : null
}

// Each harness's name, the version the factory tested it at, and the fixes that install it and sign it in.
const SPECS: Record<HarnessId, { install: FixId; label: string; login: FixId; tested: string }> = {
  "claude-code": {
    install: "claude",
    label: "Claude Code",
    login: "claude-login",
    tested: "2.1.322",
  },
  codex: { install: "codex", label: "Codex", login: "codex-login", tested: "0.167.1" },
}

// Codex's own folder, spawn.sh's CODEX_HOME: the data folder's codex/, where its login stays in auth.json.
export const codexHome = (env: Env): string => join(dataDirOf(env), "codex")

export const HARNESS_COMMANDS = {
  checkoutOf: (root: string) => [
    "git",
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ],
  claudeStatus: () => ["claude", "auth", "status"],
  codexLogin: (home: string) => ["env", `CODEX_HOME=${home}`, "codex", "login", "status"],
  codexServer: (home: string) => ["env", `CODEX_HOME=${home}`, "codex", "app-server"],
  version: (tool: string) => [tool, "--version"],
} as const

// What a Codex start says on the live data folder, which spawn.sh refuses until a later phase lifts it.
export const CODEX_LIVE_REFUSAL =
  "Codex can start Alpha only on a test copy of Playground for now, not on this Mac's own sessions. A later update turns this on."

const versionOf = (stdout: string): string | null => /\d+\.\d+(?:\.\d+)?/.exec(stdout)?.[0] ?? null

// Pure: -1, 0 or 1 as version a is older than, the same as or newer than b, part by part.
export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number))
  for (let i = 0; i < Math.max(x!.length, y!.length); i++) {
    const d = (x![i] ?? 0) - (y![i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

// Whether the env's data folder is the live one, the folder dataDir gives with no PLAYGROUND_DATA_DIR, as spawn.sh reads it.
export const isLiveFolder = (env: Env): boolean => {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  return real(dataDirOf(env)) === real(dataDirOf({}, env.HOME || homedir()))
}

const row = (
  name: string,
  status: Check["status"],
  detail: string,
  note: string | null = null,
  action: Check["action"] = null,
): Check => ({ action, detail, name, need: null, note, status })

// Pure: a harness's card from its facts: Installed at the tested version or newer, Signed in, for Claude Code Trusted, and its plan; ready once each but the plan passes.
export const cardOf = (id: HarnessId, facts: HarnessFacts, refusal: string | null): HarnessCard => {
  const { install, label, login, tested } = SPECS[id]
  const { plan, signedIn, trusted, version } = facts
  const installed = !version
    ? row("Installed", "MISSING", "not installed", `${label} is not installed.`, {
        id: install,
        label: `Install ${label}`,
      })
    : compareVersions(version, tested) < 0
      ? row(
          "Installed",
          "MISSING",
          `${version}, older than tested`,
          `${label} ${version} is older than ${tested}, the version tested.`,
          { id: install, label: `Update ${label}` },
        )
      : row(
          "Installed",
          "ok",
          compareVersions(version, tested) > 0 ? `${version}, newer than tested` : version,
        )
  const signed = !version
    ? row("Signed in", "waiting", "waits for the install")
    : signedIn
      ? row("Signed in", "ok", "signed in")
      : row("Signed in", "MISSING", "not signed in", `${label} is not signed in.`, {
          id: login,
          label: "Sign in",
        })
  // Claude Code asks whether you trust a folder before its first session there and waits on the answer, so Alpha starts only once the owner has said yes here; Codex's trust spawn.sh writes itself.
  const trust =
    id !== "claude-code"
      ? []
      : !version
        ? [row("Trusted", "waiting", "waits for the install")]
        : trusted
          ? [row("Trusted", "ok", "trusted")]
          : [
              row(
                "Trusted",
                "MISSING",
                "not trusted",
                `Claude Code asks whether you trust ${site.name}'s folder before its first session there, and Alpha would wait on that question. The installer trusts the folder it cloned; trust this one here once, and it covers every session ${site.name} starts in it.`,
                { id: "claude-trust", label: "Trust this folder" },
              ),
            ]
  const planRow =
    id === "claude-code"
      ? row("Plan", "optional", "not read yet")
      : !version || !signedIn
        ? row("Plan", "waiting", "waits for sign-in")
        : plan
          ? row("Plan", "ok", plan)
          : row("Plan", "optional", "not read")
  return {
    checks: [installed, signed, ...trust, planRow],
    id,
    label,
    ready: [installed, signed, ...trust].every((check) => check.status === "ok"),
    refusal,
  }
}

// Codex's plan from its app-server's account/read: a ChatGPT login's plan type, an API key's words, else null.
const codexPlan = async (home: string, ask: Ask): Promise<string | null> => {
  const lines = [
    { id: 1, method: "initialize", params: { clientInfo: { name: "playground", version: "1" } } },
    { method: "initialized" },
    { id: 2, method: "account/read", params: { refreshToken: false } },
  ].map((message) => JSON.stringify(message))
  const answer = (await ask([...HARNESS_COMMANDS.codexServer(home)], lines, 2)) as {
    result?: { account?: { planType?: unknown; type?: unknown } | null }
  } | null
  const account = answer?.result?.account
  if (account?.type === "chatgpt" && typeof account.planType === "string") return account.planType
  if (account?.type === "apiKey") return "API key"
  return null
}

const parsed = (text: string | null) => {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Claude Code's sign-in: claude auth status's loggedIn, else ~/.claude.json's oauthAccount, which an older Claude Code keeps.
const claudeSignedIn = async (
  reader: Reader,
  config: Record<string, unknown> | null,
): Promise<boolean> => {
  const status = await reader.run([...HARNESS_COMMANDS.claudeStatus()])
  if (status.code === 0 && parsed(status.stdout)?.loggedIn === true) return true
  return Boolean(config?.oauthAccount)
}

// A path as given and as the disk resolves it, the two forms spawn.sh's claude_trusts compares.
const forms = (path: string): string[] => {
  const given = resolve(path)
  try {
    return [given, realpathSync(given)]
  } catch {
    return [given]
  }
}

// Whether Claude Code's config holds the owner's yes to its folder trust question for the checkout itself: projects[<checkout>].hasTrustDialogAccepted, which covers every worktree in it, while a yes on a folder above the checkout counts for nothing, as Claude Code reads it and spawn.sh's claude_trusts checks.
export const trustsFolder = (config: Record<string, unknown> | null, checkout: string): boolean => {
  const projects = (config?.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: unknown }>
  const yes = new Set(
    Object.entries(projects)
      .filter(([, project]) => project?.hasTrustDialogAccepted === true)
      .flatMap(([path]) => forms(path)),
  )
  return forms(checkout).some((form) => yes.has(form))
}

// The main checkout of the API's own checkout, whose leads worktree the first dispatcher starts in: git's common folder's parent, or the checkout itself where git does not say.
const mainCheckout = async (reader: Reader, root: string): Promise<string> => {
  const common = (await reader.run([...HARNESS_COMMANDS.checkoutOf(root)])).stdout.trim()
  return common ? dirname(common) : root
}

const liveFacts = async (
  id: HarnessId,
  reader: Reader,
  env: Env,
  ask: Ask,
  read: Read,
  root: string,
): Promise<HarnessFacts> => {
  const tool = id === "claude-code" ? "claude" : "codex"
  if (!reader.has(tool)) return { plan: null, signedIn: false, trusted: false, version: null }
  const version = versionOf((await reader.run([...HARNESS_COMMANDS.version(tool)])).stdout)
  if (id === "claude-code") {
    const config = parsed(await read(join(env.HOME || homedir(), ".claude.json")))
    return {
      plan: null,
      signedIn: await claudeSignedIn(reader, config),
      trusted: trustsFolder(config, await mainCheckout(reader, root)),
      version,
    }
  }
  const home = codexHome(env)
  const signedIn = (await reader.run([...HARNESS_COMMANDS.codexLogin(home)])).code === 0
  return { plan: signedIn ? await codexPlan(home, ask) : null, signedIn, trusted: true, version }
}

// A fixture's made-up facts, a made-up install, sign-in or trust fix (fixtureFixed) turning its part on; a fixture that says nothing of trust reads as trusted.
const fixtureFacts = (id: HarnessId): HarnessFacts => {
  const facts = readFixtureMachine().doctor?.harnesses?.[id]
  if (!facts) throw new Error(`the fixture holds no doctor.harnesses.${id}`)
  const { install, login, tested } = SPECS[id]
  return {
    ...facts,
    signedIn: facts.signedIn || fixtureFixed.has(login),
    trusted: (facts.trusted ?? true) || fixtureFixed.has("claude-trust"),
    version: facts.version ?? (fixtureFixed.has(install) ? tested : null),
  }
}

// Every harness's card in HARNESSES' order, Codex's carrying the live folder's refusal while spawn.sh would refuse it.
export async function harnessCards({
  ask = askOnce,
  env = process.env,
  read = readText,
  reader = machine,
  root = checkoutRoot() ?? process.cwd(),
  source = currentSource(),
}: {
  ask?: Ask
  env?: Env
  read?: Read
  reader?: Reader
  root?: string
  source?: DashboardSource
} = {}): Promise<HarnessCard[]> {
  return Promise.all(
    HARNESSES.map(async ({ id }) =>
      cardOf(
        id,
        source.kind === "live"
          ? await liveFacts(id, reader, env, ask, read, root)
          : fixtureFacts(id),
        id === "codex" && isLiveFolder(env) ? CODEX_LIVE_REFUSAL : null,
      ),
    ),
  )
}
