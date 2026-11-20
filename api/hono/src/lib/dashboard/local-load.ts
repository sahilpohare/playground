import { join } from "node:path"

import { MODEL_NAME } from "@packages/scripts/local-model/model"
import { localModelSettings, readPolicyOrDefaults } from "@packages/settings"

import { checkoutRoot, readsLive } from "@/lib/dashboard/fixture"
import { runArgv } from "@/lib/dashboard/run-argv"
import { dataDir } from "@/lib/sessions/paths"

// How long one `playground model use` may run: it waits for the server it starts to answer /health, so its timeout sits past the 15 minutes a load is given.
export const START_MS = 20 * 60_000

export type Started = { code: number; line: string }

// The model the local server's machine keeps up (localModels.peerModel), which a pick starts when the server is down: "" when none is set or the settings do not read, so the pick is refused as before.
export const keptLocalModel = (data: string = dataDir()): string => {
  const read = readPolicyOrDefaults(data)
  return read.settings ? localModelSettings.get(read.settings, "localModels.peerModel") : ""
}

// Pure: the one fixed argv a local pick starts a model with, the playground CLI's own `model use` run by this bun with no shell, so its hold, memory floor and refusals stay the single path; a name `model use`'s own MODEL_NAME refuses throws before anything runs.
export function loadArgv(model: string, root: string, bun: string = process.execPath): string[] {
  if (!MODEL_NAME.test(model))
    throw new Error(`${JSON.stringify(model)} is not a model folder name`)
  return [bun, join(root, "packages/scripts/src/playground/cli.ts"), "model", "use", model]
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.slice(0, 300) || "no output"

// Starts model on the machine `playground model use` picks for it, and gives back its exit code and last line; a fixture stack starts nothing, so no ssh leaves the machine.
export async function startModel(
  model: string,
  root: string | null = checkoutRoot(),
  timeoutMs = START_MS,
): Promise<Started> {
  if (!readsLive()) return { code: 0, line: "a fixture stack starts no model" }
  if (!root) return { code: 1, line: "this build has no checkout to run playground model use from" }
  return runStart(loadArgv(model, root), root, timeoutMs)
}

// Runs one start's argv in cwd through runArgv, killed past timeoutMs: its exit code and the last line it printed, stdout's on success and stderr's on a failure, or the signal that stopped it, named as a timeout only once timeoutMs has passed.
export async function runStart(argv: string[], cwd: string, timeoutMs: number): Promise<Started> {
  const begun = Date.now()
  const run = await runArgv(argv, timeoutMs, undefined, cwd)
  if (run.signal)
    return {
      code: run.code || 1,
      line:
        Date.now() - begun >= timeoutMs
          ? "playground model use ran too long and was stopped"
          : `playground model use was stopped by ${run.signal}`,
    }
  return { code: run.code, line: lastLine(run.code === 0 ? run.out : run.err || run.out) }
}
