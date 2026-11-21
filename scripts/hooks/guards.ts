// PreToolUse hook on Bash: runs every Bash guard's check in this one process, as each guard's own main block runs it, and refuses with every refusal they give, so a Bash call starts one bun rather than one a guard; a guard that throws refuses the call, naming it.

import { withLiveBudget } from "../../packages/safe-delete/src/live-refs"
import { DEADLINE, input } from "./input"
import { check as desktopOwnerApp } from "./no-desktop-owner-app"
import { check as envDump } from "./no-env-dump"
import { check as extensionRepoWrite } from "./no-extension-repo-write"
import { guarded as extensionsWrite } from "./no-extensions-write"
import { check as falseGreen } from "./no-false-green"
import { refusal as glmHeavyPath } from "./no-glm-heavy-path"
import { check as headlessLogin } from "./no-headless-login"
import { check as hiddenProgram } from "./no-hidden-program"
import { check as killByName } from "./no-kill-by-name"
import { check as linearTicket } from "./no-linear-ticket"
import { check as liveSignIn } from "./no-live-sign-in"
import { check as macWebBuild } from "./no-mac-web-build"
import { check as mainCheckout } from "./no-main-checkout"
import { check as offPaletteLabel } from "./no-off-palette-label"
import { check as oursMerge } from "./no-ours-merge"
import { check as outsidePrCode } from "./no-outside-pr-code"
import { check as playgroundLeak } from "./no-playground-leak"
import { check as prepareWrite } from "./no-prepare-write"
import { check as promptStop } from "./no-prompt-stop"
import { check as protectedPush } from "./no-protected-push"
import { check as publicLeak } from "./no-public-leak"
import { check as rawDelete } from "./no-raw-delete"
import { check as rawSpawn } from "./no-raw-spawn"
import { check as rawVercel } from "./no-raw-vercel"
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
  { factory: true, name: "no-hidden-program", run: (raw, env) => hiddenProgram(raw, env) },
  { factory: true, name: "no-kill-by-name", run: (raw) => killByName(raw) },
  { factory: false, name: "no-linear-ticket", run: (raw, env) => linearTicket(raw, env) },
  { factory: true, name: "no-live-sign-in", run: (raw, env) => liveSignIn(raw, env) },
  { factory: true, name: "no-mac-web-build", run: (raw, env) => macWebBuild(raw, env) },
  { factory: true, name: "no-main-checkout", run: (raw, env) => mainCheckout(raw, env) },
  { factory: false, name: "no-off-palette-label", run: (raw) => offPaletteLabel(raw) },
  { factory: true, name: "no-ours-merge", run: (raw, env) => oursMerge(raw, env) },
  { factory: false, name: "no-outside-pr-code", run: (raw, env) => outsidePrCode(raw, env) },
  { factory: true, name: "no-playground-leak", run: (raw, env) => playgroundLeak(raw, env) },
  { factory: true, name: "no-prepare-write", run: (raw, env) => prepareWrite(raw, env) },
  { factory: true, name: "no-prompt-stop", run: (raw) => promptStop(raw) },
  { factory: true, name: "no-protected-push", run: (raw, env) => protectedPush(raw, env) },
  { factory: true, name: "no-public-leak", run: (raw, env) => publicLeak(raw, env) },
  { factory: false, name: "no-raw-delete", run: (raw, env) => rawDelete(raw, env) },
  { factory: true, name: "no-raw-spawn", run: (raw, env) => rawSpawn(raw, env) },
  { factory: true, name: "no-raw-vercel", run: (raw, env) => rawVercel(raw, env) },
  { factory: true, name: "no-raw-wa", run: (raw, env) => rawWa(raw, env) },
  { factory: false, name: "no-release-comment", run: (raw, env) => releaseComment(raw, env) },
  { factory: true, name: "no-stash", run: (raw, env) => stash(raw, env) },
  { factory: true, name: "no-unslotted-run", run: (raw, env) => unslottedRun(raw, env) },
]

const threw = (name: string, error: unknown) =>
  `guards hook: ${name} threw (${error instanceof Error ? error.message : String(error)}), so the call is refused until it runs; report it to your lead.`

const late = (names: string[]) =>
  `guards hook: ${names.join(", ")} did not answer by its deadline, about ${DEADLINE / 1000} s, inside the runner's 15 s timeout, so the call is refused; split it into smaller calls, or report it to your lead.`

// Every refusal the guards give, in GUARDS' order, one paragraph each, or undefined when none refuses; the factory's gate is read once, for the guards that take it. Past the wait, each guard that has not answered refuses the call, naming it, so no runner's timeout decides it; the timer fires only while no guard holds the event loop.
export async function check(
  raw: string,
  environment: Environment = process.env,
  guards: readonly Guard[] = GUARDS,
  wait = DEADLINE,
): Promise<string | undefined> {
  let factory: Promise<boolean> | undefined
  const verdicts: (string | undefined)[] = []
  const answered = new Set<number>()
  // every guard's live reads of a push's remote share one budget, so a hung remote leaves the call inside its timeout
  const all = withLiveBudget(() =>
    Promise.all(
      guards.map(async ({ factory: gated, name, run }, i) => {
        try {
          if (!gated || (await (factory ??= fromFactory(raw, environment))))
            verdicts[i] = await run(raw, environment)
        } catch (error) {
          verdicts[i] = threw(name, error)
        }
        answered.add(i)
      }),
    ),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = await Promise.race([
    all.then(() => []),
    new Promise<string[]>((done) => {
      timer = setTimeout(
        () => done(guards.filter((_, i) => !answered.has(i)).map(({ name }) => name)),
        wait,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  const reasons = [...verdicts, slow.length > 0 ? late(slow) : undefined]
  return reasons.filter(Boolean).join("\n\n") || undefined
}

// The hook's exit: 2 with the reasons on stderr, else 0; its deadline counts from the process's start, so the imports and the input's read spend it too, and an input unread by then refuses the call in input().
export async function hook(
  guards: readonly Guard[] = GUARDS,
  deadline = DEADLINE,
): Promise<number> {
  const raw = await input("guards", "guard", deadline)
  const reason = await check(raw, process.env, guards, deadline - performance.now())
  if (!reason) return 0
  console.error(reason)
  return 2
}

if (import.meta.main) process.exit(await hook())
