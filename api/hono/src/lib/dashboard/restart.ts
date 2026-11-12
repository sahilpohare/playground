import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { spawnEnv } from "@packages/env/api-hono"

import { checkoutRoot, readsLive } from "@/lib/dashboard/fixture"
import { unstickPath } from "@/lib/dashboard/unstick"

// A session whose Claude login expired, restarted from the app: spawn.sh closes the pane it opened, then resumes the same conversation on the account the owner just added, or with none on this Mac's own login, a reviewer or tester with --pr naming its PRs since spawn.sh refuses every checker start that names none, so no step needs a terminal. A fixture stack runs nothing: it clears the session's login block, as a fresh start would.

export type Run = (argv: string[]) => Promise<{ code: number; stderr: string; stdout: string }>

export type Restarted = { status: "restarted" } | { detail: string; status: "refused" }

const run: Run = async (argv) => {
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

const said = (text: string) => text.trim().split("\n").at(-1) ?? ""

// Pure: the PRs a restart's resume names with --pr (its pr first, as spawn.sh sets an ended row's pr to the first named), since spawn.sh refuses every checker start that names no pull request: a checker's pr, then the rest of its prs, else null, as for a row naming only issues or extension items, which the route refuses before the close, failing closed; none for a session that is no checker or has no row.
const PULL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/

export const restartPrs = (
  checker: boolean,
  row?: { pr?: string; prs?: string[] },
): string[] | null | undefined => {
  if (!checker || !row) return undefined
  const prs = [...new Set([row.pr, ...(row.prs ?? [])].filter((u): u is string => !!u))]
  return prs.some((u) => PULL.test(u)) ? prs : null
}

// Pure: spawn.sh's two steps, a close by the pane's label and a resume of the same session id in its folder, with --account only when one is named and --pr with a checker's prs, since the close ends its row.
export const restartArgv = (
  root: string,
  session: { account?: string; cwd: string; name: string; prs?: string[]; sessionId: string },
): string[][] => {
  const spawn = join(root, "scripts", "spawn.sh")
  return [
    [spawn, "close", session.name],
    [
      spawn,
      "resume",
      session.name,
      session.cwd,
      session.sessionId,
      ...(session.account ? ["--account", session.account] : []),
      ...(session.prs?.length ? ["--pr", session.prs.join(",")] : []),
    ],
  ]
}

// The fixture's restart: every login entry naming the session leaves ops-unstick's state, so its card clears as a real restart's would.
export function fixtureRestart(name: string, path = unstickPath()): void {
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    blocked?: { kind?: string; name?: string }[]
  }
  state.blocked = (state.blocked ?? []).filter((e) => !(e.kind === "login" && e.name === name))
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2))
  renameSync(`${path}.tmp`, path)
}

export async function restartSession(
  session: { account?: string; cwd: string; name: string; prs?: string[]; sessionId: string },
  {
    live = readsLive(),
    root = checkoutRoot(),
    run: runCommand = run,
  }: { live?: boolean; root?: string | null; run?: Run } = {},
): Promise<Restarted> {
  if (!live) {
    fixtureRestart(session.name)
    return { status: "restarted" }
  }
  if (!root) return { detail: "this API has no checkout to restart it from", status: "refused" }
  for (const argv of restartArgv(root, session)) {
    const result = await runCommand(argv)
    if (result.code !== 0)
      return {
        detail: said(result.stderr) || said(result.stdout) || `exit ${result.code}`,
        status: "refused",
      }
  }
  return { status: "restarted" }
}
