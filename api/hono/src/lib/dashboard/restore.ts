import { join } from "node:path"

import { runCommand } from "@/lib/dashboard/dispatcher-start"
import {
  checkoutRoot,
  currentSource,
  type DashboardSource,
  ensureFixture,
} from "@/lib/dashboard/fixture"
import { dataDir } from "@/lib/sessions/paths"

// Settings > Jobs' Restore now: ops-restore's own steps (packages/scripts/src/ops-restore/cli.ts, --now) run once from this API's checkout, for the true block LIFECYCLE.md names, when the main checkout's guards are gone and the job is stopped or off.

export type Restored = { status: "intact" | "restored" | "stopped"; text: string }

export class RestoreError extends Error {}

// The checkout Restore now puts back, from the server alone, never the request: on a stack that reads this machine, the main checkout this API's checkout is a worktree of, by its path, as the jobs render places the Dashboard's checkout at <main>/.claude/worktrees/desk, since a lost .git takes git's own answer with it; on a fixture or test stack the fixture's scratch checkout, so no test or browser check reaches a real one; on a hosted or refused stack none.
export const restoreMain = (
  root: string | null = checkoutRoot(),
  source: DashboardSource = currentSource(),
): string | null => {
  if (source.kind === "fixture") return join(ensureFixture(source), "checkout")
  if (source.kind !== "live" || !root) return null
  return /^(.+)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/.exec(root)?.[1] ?? root
}

const STATUS = { 0: "restored", 1: "stopped", 3: "intact" } as const

let running = false

// One press: the CLI's --now run to its end with this stack's data folder, its last line the page's words; one at a time, since two would race on the same checkout.
export async function restoreCheckout({
  main = restoreMain(),
  root = checkoutRoot(),
}: { main?: string | null; root?: string | null } = {}): Promise<Restored> {
  if (!main || !root) throw new RestoreError("This stack has no checkout to restore")
  if (running) throw new RestoreError("A restore is already running")
  running = true
  try {
    // through env, so the child's data folder is this stack's own (the fixture's on a fixture stack), on runCommand's one spawner
    const { code, stderr, stdout } = await runCommand([
      "env",
      `PLAYGROUND_DATA_DIR=${dataDir()}`,
      "bun",
      "--no-env-file",
      join(root, "packages/scripts/src/ops-restore/cli.ts"),
      "--main",
      main,
      "--now",
    ])
    const text = (stdout.trim() || stderr.trim()).split("\n").at(-1) || `exit ${code}`
    return { status: STATUS[code as keyof typeof STATUS] ?? "stopped", text }
  } finally {
    running = false
  }
}
