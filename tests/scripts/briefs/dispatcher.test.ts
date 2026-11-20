import { expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { dashboardCheckout } from "../../../packages/scripts/src/playground/probe"

test("the dispatcher's brief template loads the playbook and carries the signal rule", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/dispatcher.md")).text()
  expect(text).toContain("Load the playbook skill")
  expect(text).toContain("**signal**: signal only processes you started")
})

test("the dispatcher starts the Optimizer at its own start, so ops-tick's retro beats reach a running session", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/dispatcher.md")).text()
  expect(text).toContain("start the Optimizer with `playground optimizer`")
})

test("the dispatcher reads the Dashboard by /api/health and the Inbox by bun run ask at its start, and reports each by that result (PG-280)", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/dispatcher.md")).text()
  const step = text.match(/^2\. .*$/m)?.[0] ?? ""
  expect(step).toContain(
    'R="${PLAYGROUND_REPO:-$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")}"',
  )
  expect(step).toContain("playground settings get live.branch")
  expect(step).toContain('git -C "$R" worktree list | grep -F "[$B]"')
  expect(step).toContain('[ -n "$D" ] || {')
  expect(step).toContain("`dashboardCheckout()`")
  expect(step).toContain("a session the Dashboard hosts gets no `PLAYGROUND_REPO`")
  expect(step).toContain(
    '`curl -sS ${C:+--cacert} ${C:+"$C"} "$(cd "$D" && PORTLESS_STATE_DIR="$P" bunx portless get api.playground)/api/health"`',
  )
  expect(step).toContain(
    'up in first-run setup, with no database yet, when it answers `"setup":true`',
  )
  expect(step).toContain(
    'its database read from `db`, reachable on `"db":"ok"` and unreachable on `"db":"unreachable"`',
  )
  expect(step).not.toContain('`"message":"ok"`')
  expect(step).toContain("down on any other answer")
  expect(step).toContain('`bun run --cwd "$D" ask open`')
  expect(step).toContain("it has run neither read")
  expect(step).toContain("Report each by that command's output alone")
  expect(step).toContain("Done when your first report quotes each command's result")
  expect(text).toMatch(/^3\. Read your roster entry and each manager's roster row, then/m)
})

const stepTwo = async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/dispatcher.md")).text()
  const step = text.match(/^2\. .*$/m)?.[0] ?? ""
  const spans = [...step.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
  return {
    curl: spans.find((s) => s.startsWith("curl ")) ?? "",
    finds: spans.find((s) => s.startsWith("R=")) ?? "",
    step,
  }
}

// The step's call run in bash with fakes first on PATH: playground prints the setting given (or fails on null), bunx names an API, and curl prints its arguments one a line.
const runStep = (
  shell: string,
  opts: { branch: string | null; caDir?: string; cwd?: string; home?: string; repo?: string },
) => {
  const bin = mkdtempSync(join(tmpdir(), "dispatcher-step-bin-"))
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake(
    "playground",
    opts.branch === null
      ? 'echo "playground: settings failed" >&2; exit 1'
      : `echo '{"key":"live.branch","value":"${opts.branch}"}'`,
  )
  fake("bunx", 'echo "https://api.example.localhost"; echo "state:$PORTLESS_STATE_DIR" >&2')
  fake("curl", 'for a in "$@"; do echo "arg:$a"; done')
  const bun = dirname(process.execPath)
  const child = Bun.spawnSync(["bash", "-c", shell], {
    cwd: opts.cwd,
    env: {
      HOME: opts.home ?? process.env.HOME!,
      PATH: `${bin}:${bun}:/usr/bin:/bin`,
      ...(opts.caDir ? { PORTLESS_STATE_DIR: opts.caDir } : {}),
      ...(opts.repo ? { PLAYGROUND_REPO: opts.repo } : {}),
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  return { code: child.exitCode, err: child.stderr.toString(), out: child.stdout.toString() }
}

const fixtureRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "dispatcher-step-repo-"))
  const repo = join(root, "repo")
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=fixture", "-c", "user.name=a", "-C", repo, ...args])
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo])
  git("commit", "-q", "--allow-empty", "-m", "first")
  git("worktree", "add", "-q", "-b", "live-old", join(repo, ".claude", "worktrees", "old"))
  git("worktree", "add", "-q", "-b", "live", join(repo, ".claude", "worktrees", "desk"))
  git("worktree", "add", "-q", "--detach", join(repo, ".claude", "worktrees", "loose"))
  symlinkSync(join(import.meta.dir, "../../../api"), join(repo, "api"))
  return realpathSync(repo)
}

test("a failed live.branch read stops the step with its own line and exit 1, never the no-Dashboard line (PG-289)", async () => {
  const { finds, step } = await stepTwo()
  const got = runStep(finds, { branch: null, repo: fixtureRepo() })
  expect(got.code).toBe(1)
  expect(got.out).toContain("could not read the live.branch setting")
  expect(got.out).not.toContain("no worktree is on")
  expect(step).toContain("When the call prints that it could not read the live.branch setting")
})

test("the step finds the checkout dashboardCheckout() finds, from PLAYGROUND_REPO or from a worktree under the clone root (PG-289)", async () => {
  const { finds } = await stepTwo()
  const repo = fixtureRepo()
  for (const branch of ["live", "live-old", "main", "missing"]) {
    const expected = dashboardCheckout(repo, undefined, branch)
    for (const where of [{ repo }, { cwd: join(repo, ".claude", "worktrees", "loose") }]) {
      const got = runStep(`${finds}; echo "D=$D"`, { branch, ...where })
      if (expected === null) {
        expect(got.out).toContain(`no worktree is on ${branch}, so no Dashboard is set up yet`)
        expect(got.code).toBe(0)
      } else expect(got.out.trim().split("\n").at(-1)).toBe(`D=${expected}`)
    }
  }
})

test("the health read passes portless's CA to curl when portless has one, as probe.ts's health check trusts it (PG-289)", async () => {
  const { curl, finds } = await stepTwo()
  const repo = fixtureRepo()
  const caDir = mkdtempSync(join(tmpdir(), "dispatcher-step-ca-"))
  const call = `${finds}; ${curl}`
  const without = runStep(call, { branch: "live", caDir, repo })
  expect(without.out).not.toContain("arg:--cacert")
  expect(without.out).toContain("arg:https://api.example.localhost/api/health")
  writeFileSync(join(caDir, "ca.pem"), "fixture")
  const withCa = runStep(call, { branch: "live", caDir, repo })
  expect(withCa.out).toContain(`arg:--cacert\narg:${join(caDir, "ca.pem")}\n`)
  expect(withCa.out).toContain("arg:https://api.example.localhost/api/health")
})

// On Linux the stack's API starts the 1355 proxy in ~/.portless/fallback with TLS on, so portless get names its https URL only when asked in that folder (#2299).
test("the health read asks portless get in the folder portlessDir() names, the 1355 proxy's while only it serves (#2299)", async () => {
  const { curl, finds } = await stepTwo()
  const home = mkdtempSync(join(tmpdir(), "dispatcher-step-home-"))
  const fallback = join(home, ".portless", "fallback")
  mkdirSync(fallback, { recursive: true })
  writeFileSync(join(fallback, "proxy.pid"), String(process.pid))
  const got = runStep(`${finds}; ${curl}`, { branch: "live", home, repo: fixtureRepo() })
  expect(got.err).toContain(`state:${fallback}\n`)
})
