// PreToolUse hook on Bash: runs every Bash guard's check in this one process, as each guard's own main block runs it, and refuses with every refusal they give, so a Bash call starts one bun rather than one a guard; a guard that throws refuses the call, naming it.

import { check as desktopOwnerApp } from "./no-desktop-owner-app"
import { check as envDump } from "./no-env-dump"
import { check as extensionRepoWrite } from "./no-extension-repo-write"
import { guarded as extensionsWrite } from "./no-extensions-write"
import { check as falseGreen } from "./no-false-green"
import { refusal as glmHeavyPath } from "./no-glm-heavy-path"
import { check as headlessLogin } from "./no-headless-login"
import { check as killByName } from "./no-kill-by-name"
import { check as linearTicket } from "./no-linear-ticket"
import { check as macWebBuild } from "./no-mac-web-build"
import { check as mainCheckout } from "./no-main-checkout"
import { check as offPaletteLabel } from "./no-off-palette-label"
import { check as oursMerge } from "./no-ours-merge"
import { check as playgroundLeak } from "./no-playground-leak"
import { check as promptStop } from "./no-prompt-stop"
import { check as publicLeak } from "./no-public-leak"
import { check as rawDelete } from "./no-raw-delete"
import { check as rawSpawn } from "./no-raw-spawn"
import { check as rawWa } from "./no-raw-wa"
import { check as releaseComment } from "./no-release-comment"
import { check as stash } from "./no-stash"
import { check as unslottedRun } from "./no-unslotted-run"
import { fromFactory } from "./role"

type Environment = Record<string, string | undefined>

export type Guard = {
  // whether its main block runs it for a factory session alone (fromFactory)
  factory: boolean
  name: string
  run: (raw: string, environment: Environment) => Promise<string | undefined>
}

// Each Bash guard with the gate and the entry its own main block runs.
export const GUARDS: readonly Guard[] = [
  { factory: false, name: "no-desktop-owner-app", run: (raw, env) => desktopOwnerApp(raw, env) },
  { factory: true, name: "no-env-dump", run: (raw) => envDump(raw) },
  {
    factory: true,
    name: "no-extension-repo-write",
    run: (raw, env) => extensionRepoWrite(raw, env),
  },
  { factory: true, name: "no-extensions-write", run: (raw, env) => extensionsWrite(raw, env) },
  { factory: true, name: "no-false-green", run: (raw, env) => falseGreen(raw, env.SHELL ?? "zsh") },
  { factory: true, name: "no-glm-heavy-path", run: (raw, env) => glmHeavyPath(raw, env) },
  { factory: false, name: "no-headless-login", run: (raw, env) => headlessLogin(raw, env) },
  { factory: true, name: "no-kill-by-name", run: (raw) => killByName(raw) },
  { factory: false, name: "no-linear-ticket", run: (raw, env) => linearTicket(raw, env) },
  { factory: true, name: "no-mac-web-build", run: (raw, env) => macWebBuild(raw, env) },
  { factory: true, name: "no-main-checkout", run: (raw, env) => mainCheckout(raw, env) },
  { factory: false, name: "no-off-palette-label", run: (raw) => offPaletteLabel(raw) },
  { factory: true, name: "no-ours-merge", run: (raw, env) => oursMerge(raw, env) },
  { factory: true, name: "no-playground-leak", run: (raw, env) => playgroundLeak(raw, env) },
  { factory: true, name: "no-prompt-stop", run: (raw) => promptStop(raw) },
  { factory: true, name: "no-public-leak", run: (raw, env) => publicLeak(raw, env) },
  { factory: false, name: "no-raw-delete", run: (raw, env) => rawDelete(raw, env) },
  { factory: true, name: "no-raw-spawn", run: (raw, env) => rawSpawn(raw, env) },
  { factory: true, name: "no-raw-wa", run: (raw, env) => rawWa(raw, env) },
  { factory: false, name: "no-release-comment", run: (raw, env) => releaseComment(raw, env) },
  { factory: true, name: "no-stash", run: (raw, env) => stash(raw, env) },
  { factory: true, name: "no-unslotted-run", run: (raw, env) => unslottedRun(raw, env) },
]

const threw = (name: string, error: unknown) =>
  `guards hook: ${name} threw (${error instanceof Error ? error.message : String(error)}), so the call is refused until it runs; report it to your lead.`

// Every refusal the guards give, in GUARDS' order, one paragraph each, or undefined when none refuses; the factory's gate is read once, for the guards that take it.
export async function check(
  raw: string,
  environment: Environment = process.env,
  guards: readonly Guard[] = GUARDS,
): Promise<string | undefined> {
  let factory: Promise<boolean> | undefined
  const reasons = await Promise.all(
    guards.map(async ({ factory: gated, name, run }) => {
      try {
        if (gated && !(await (factory ??= fromFactory(raw, environment)))) return
        return await run(raw, environment)
      } catch (error) {
        return threw(name, error)
      }
    }),
  )
  return reasons.filter(Boolean).join("\n\n") || undefined
}

// The hook's exit: 2 with the reasons on stderr, else 0.
export async function hook(): Promise<number> {
  const reason = await check(await Bun.stdin.text())
  if (!reason) return 0
  console.error(reason)
  return 2
}

if (import.meta.main) process.exit(await hook())
