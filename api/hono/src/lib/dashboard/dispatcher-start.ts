import { join } from "node:path"

import { spawnEnv } from "@packages/env/api-hono"
import { type HarnessId, readSetting } from "@packages/settings"

import { checkoutRoot, fixtureStart, readsLive } from "@/lib/dashboard/fixture"
import { DISPATCHER } from "@/lib/dashboard/workers"
import { CODEX_LIVE_REFUSAL, isLiveFolder } from "@/lib/onboard/harness"
import { dataDir } from "@/lib/sessions/paths"

// The home's Start <dispatcher>: the CLI's own dispatcher step, run through one fixed argv from the API's own checkout, which writes the dispatcher's brief when it is missing and starts it with spawn.sh on the harness harness.alpha names. A Codex start on the live data folder is refused in plain words before anything runs, as spawn.sh would refuse it. A fixture stack runs nothing and brings its made-up dispatcher back, or makes one on a fixture with none.

export type Run = (argv: string[]) => Promise<{ code: number; stderr: string; stdout: string }>

export type Started =
  | { name: string; status: "running" }
  | { name: string; status: "started" }
  | { detail: string; name: string; status: "failed" | "refused" }

export const dispatcherArgv = (
  root: string,
  harness: HarnessId = "claude-code",
  brief?: string,
): string[] => [
  "bun",
  join(root, "packages/scripts/src/playground/cli.ts"),
  "dispatcher",
  ...(harness === "codex" ? ["--harness", "codex"] : []),
  ...(brief ? ["--brief", brief] : []),
]

// The harness the first dispatcher starts on, harness.alpha's value.
export const alphaHarness = (): HarnessId =>
  (readSetting(dataDir(), "harness.alpha")?.value as HarnessId | undefined) ?? "claude-code"

// One fixed argv run to its end, its output read whole; Switch Alpha's close runs through it too.
export const runCommand: Run = async (argv) => {
  const child = Bun.spawn(argv, {
    env: spawnEnv(),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stderr, stdout }
}

// The CLI's last line, whole: a refusal names its gate and reading, and the app shows all of it.
const said = (text: string) => text.trim().split("\n").at(-1) ?? ""

export async function startDispatcher({
  brief,
  dir,
  env = process.env,
  harness = alphaHarness(),
  live = readsLive(),
  name = DISPATCHER,
  root = checkoutRoot(),
  run: runCli = runCommand,
}: {
  brief?: string
  dir?: string
  env?: Record<string, string | undefined>
  harness?: HarnessId
  live?: boolean
  name?: string
  root?: string | null
  run?: Run
} = {}): Promise<Started> {
  if (harness === "codex" && isLiveFolder(env))
    return { detail: CODEX_LIVE_REFUSAL, name, status: "refused" }
  if (!live) return { name, status: fixtureStart(name, dir) ? "started" : "running" }
  if (!root) return { detail: "this API has no checkout to start it from", name, status: "failed" }
  const result = await runCli(dispatcherArgv(root, harness, brief))
  if (result.code === 0) return { name, status: "started" }
  if (result.code === 3) return { name, status: "running" }
  const detail = said(result.stderr) || said(result.stdout) || `exit ${result.code}`
  return { detail, name, status: result.code === 1 ? "refused" : "failed" }
}
