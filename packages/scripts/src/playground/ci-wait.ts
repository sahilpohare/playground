// playground ci-wait <pr> [--repo <owner/name>]: one wait on a PR's CI for every session, so none writes its own loop, which once read a required check GitHub had not yet created as done. It waits until each of pr:merge's REQUIRED_CHECKS exists at the PR's current head and has concluded, then prints each conclusion and exits 0 when all passed, 1 when any did not, 1 at once on a PR GitHub reads as conflicting with its base (it starts no pull_request run on one), and 2 on a PR or repo GitHub does not know; it reads over REST every POLL_SECONDS (the github rule), waits out a rate limit's reset, and waits afresh on a head that moves.
import { ghSkipped } from "../gh-read"
import { PASSED, REQUIRED_CHECKS, REQUIRED_WORKFLOWS } from "../pr-merge/gates"

export const POLL_SECONDS = 300

const USAGE = "usage: playground ci-wait <pr> [--repo <owner/name>]"

export type CiWaitDeps = {
  err: (line: string) => void
  gh: (args: string[]) => { code: number; stderr: string; stdout: string }
  now: () => number
  out: (line: string) => void
  repo: () => Promise<string>
  sleep: (seconds: number) => Promise<void>
}

// gh on this machine, skipped while ghSkipped names why, so a waiter polls a broken gh no more than the gh sign-in probe does.
export const machineGh: CiWaitDeps["gh"] = (args) => {
  const skipped = ghSkipped()
  if (skipped) return { code: 1, stderr: skipped, stdout: "" }
  const run = Bun.spawnSync(["gh", ...args], { stderr: "pipe", stdout: "pipe" })
  return { code: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString() }
}

type Run = { conclusion: string | null; id: number; name: string; status: string }

// gh api -i's answer: its headers, then its body after the first blank line.
const split = (text: string): [Record<string, string>, string] => {
  const [head = "", body = ""] = text.replace(/\r\n/g, "\n").split("\n\n", 2)
  const headers: Record<string, string> = {}
  for (const line of head.split("\n").slice(1)) {
    const i = line.indexOf(":")
    if (i >= 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return [headers, body]
}

// A read that no wait can mend: a PR or repo GitHub does not know (404), or a login it refuses (401).
class Unreadable extends Error {}

// One REST read, or null once a failed read has waited out its pause: a spent rate limit until its reset, any other failure a poll; a 404 or 401 throws Unreadable, since reading again would wait for good.
const read = async <T>(deps: CiWaitDeps, path: string, jq: string): Promise<T | null> => {
  const answer = deps.gh(["api", "-i", path, "--jq", jq])
  if (answer.code === 0) return JSON.parse(split(answer.stdout)[1]) as T
  const status = answer.stdout.split("\n", 1)[0]!.trim()
  if (/^HTTP\/\S+ 40[14]\b/.test(status)) throw new Unreadable(`gh api ${path}: ${status}`)
  const [headers] = split(answer.stdout)
  const reset = headers["x-ratelimit-reset"] ?? ""
  const pause =
    headers["x-ratelimit-remaining"] === "0" && /^\d+$/.test(reset)
      ? Math.max(Number(reset) - Math.floor(deps.now() / 1000), 0) + 5
      : POLL_SECONDS
  deps.err(`gh api ${path} failed, reading again in ${pause}s: ${answer.stderr.trim()}`)
  await deps.sleep(pause)
  return null
}

// Pure: each required check's newest run by id, matched by its exact name, so a near-twin such as Lint and Build never stands in for Audit, Lint, and Build.
export const newestRequired = (runs: Run[]): (Run | undefined)[] =>
  REQUIRED_CHECKS.map((name) =>
    runs
      .filter((run) => run.name === name)
      .reduce<Run | undefined>((held, run) => (held && held.id > run.id ? held : run), undefined),
  )

export async function ciWait(repo: string, n: string, deps: CiWaitDeps): Promise<number> {
  let head = ""
  for (;;) {
    const pr = await read<{ base: string; mergeable: boolean | null; sha: string; state: string }>(
      deps,
      `repos/${repo}/pulls/${n}`,
      "{base: .base.ref, mergeable, sha: .head.sha, state}",
    )
    if (!pr) continue
    if (pr.mergeable === false) {
      deps.out(`#${n} conflicts with ${pr.base}: no CI runs until ${pr.base} is merged in`)
      return 1
    }
    // GitHub works mergeable out after a read asks for it, so an open PR's null is read again a poll on, before any check counts; a closed or merged PR reads null for good, so its checks are read as they stand
    if (pr.mergeable === null && pr.state === "open") {
      await deps.sleep(POLL_SECONDS)
      continue
    }
    if (pr.sha !== head) {
      deps.out(
        `${head ? "head moved: waiting afresh" : "waiting"} on ${REQUIRED_CHECKS.join(" and ")} at ${pr.sha.slice(0, 7)}`,
      )
      head = pr.sha
    }
    const runs = await read<Run[]>(
      deps,
      `repos/${repo}/commits/${head}/check-runs?per_page=100`,
      "[.check_runs[] | {conclusion, id, name, status}]",
    )
    if (!runs) continue
    const newest = newestRequired(runs)
    if (newest.every((run) => run?.status === "completed")) {
      for (const run of newest) deps.out(`${run!.conclusion} ${run!.name}`)
      return newest.every((run) => PASSED.has(run!.conclusion?.toUpperCase() ?? "")) ? 0 : 1
    }
    const missing = REQUIRED_CHECKS.filter((_, i) => !newest[i])
    if (missing.length) {
      const workflows = await read<{ id: number; name: string; status: string }[]>(
        deps,
        `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`,
        "[.workflow_runs[] | {id, name, status}]",
      )
      if (!workflows) continue
      for (const name of missing) {
        const ended = workflows
          .filter((run) => run.name === REQUIRED_WORKFLOWS[name])
          .reduce<{ id: number; status: string } | undefined>(
            (held, run) => (held && held.id > run.id ? held : run),
            undefined,
          )
        if (ended?.status === "completed") {
          deps.out(
            `no ${name} check at ${head.slice(0, 7)}, though its ${REQUIRED_WORKFLOWS[name]} run finished: GitHub ended it without creating the check; rerun it with \`gh run rerun ${ended.id}\``,
          )
          return 1
        }
      }
    }
    await deps.sleep(POLL_SECONDS)
  }
}

// playground ci-wait's words: the PR's number and --repo's owner/name, the factory's own repo when left out; 2 on a usage error.
export async function runCiWait(words: string[], deps: CiWaitDeps): Promise<number> {
  const at = words.indexOf("--repo")
  const repo = at >= 0 ? words[at + 1] : await deps.repo()
  const n = words.filter((_, i) => at < 0 || (i !== at && i !== at + 1))[0]
  if (!n || !/^\d+$/.test(n) || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    deps.err(USAGE)
    return 2
  }
  try {
    return await ciWait(repo, n, deps)
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error
    deps.err(error.message)
    return 2
  }
}
