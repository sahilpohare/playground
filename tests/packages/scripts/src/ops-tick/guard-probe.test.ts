import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  guardProbe,
  preToolUseGuards,
} from "../../../../../packages/scripts/src/ops-tick/guard-probe"
import { BEATS, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"
import { fakeRun } from "./fake-run"

const root = join(import.meta.dir, "..", "..", "..", "..", "..")
// The scratch folder stays for the system to clear, since a test removes no tree.
const scratch = mkdtempSync(join(tmpdir(), "guard-probe-"))

const wrapper = (hook: string) =>
  `R=x; cd -P "$R" && bun --no-env-file scripts/hooks/bundled/${hook}.js`
const repo = join(scratch, "repo")
mkdirSync(join(repo, "scripts"), { recursive: true })
writeFileSync(
  join(repo, "scripts", "factory-settings.json"),
  JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ command: wrapper("no-stash") }], matcher: "^Bash$" },
        { hooks: [{ command: wrapper("no-env-dump") }], matcher: "^Bash$" },
        { hooks: [{ command: wrapper("no-stash") }], matcher: "^Write$" },
        { hooks: [{ command: wrapper("no-kill-by-name") }], matcher: "^Bash$" },
      ],
      Stop: [{ hooks: [{ command: wrapper("session-state") }] }],
    },
  }),
)
const ops = join(scratch, "ops")

// Bun's own crash output on stderr: the error, a note, then its version banner last.
const CRASH = "error: Cannot find package 'x'\nnote: GET x\n\nBun v1.4.4 (macOS arm64)\n"

// One beat run whose guards exit as codes says (0 when unnamed), recording each run and each send; no guard is ever started.
const probe = async (codes: Record<string, number>, sendOk = true) => {
  const runs: { argv: string[]; stdin?: string }[] = []
  const sent: { text: string; to: string }[] = []
  const { run } = fakeRun(
    Object.fromEntries(
      Object.entries(codes).map(([guard, code]) => [guard, { code, err: code === 1 ? CRASH : "" }]),
    ),
  )
  const ctx: Context = {
    now: new Date(Date.UTC(2026, 10, 2, 12, 0)),
    ops,
    repo,
    run: async (argv, timeout, stdin) => {
      runs.push({ argv, stdin })
      return run(argv, timeout, stdin)
    },
    send: async (to, text) => {
      sent.push({ text, to })
      return sendOk
    },
  }
  await guardProbe(ctx)
  return { runs, sent }
}

test("the guards are the factory settings' PreToolUse hooks, each once", async () => {
  expect(await preToolUseGuards(repo)).toEqual(["no-stash", "no-env-dump", "no-kill-by-name"])
  const real = await preToolUseGuards(root)
  expect(real).toContain("guards")
  expect(real).not.toContain("session-state")
})

test("each guard gets {} without its wrapper's tail, and a crash is told to the dispatcher once, a refusal never", async () => {
  const first = await probe({ "no-env-dump": 2, "no-stash": 1 })
  expect(first.runs).toHaveLength(3)
  expect(first.runs[0]).toEqual({
    argv: [
      "sh",
      "-c",
      'cd -P "$1" && s="scripts/hooks/bundled/$2.js" && { [ -f "$s" ] || s="scripts/hooks/$2.ts"; } && exec bun --no-env-file "$s"',
      "guard-probe",
      repo,
      "no-stash",
    ],
    stdin: "{}",
  })
  expect(first.sent).toEqual([
    {
      text: `1 of 3 PreToolUse guards cannot start, so their wrappers refuse every factory call they guard. Fix: git checkout scripts/hooks/bundled, or bun run hooks:bundle, in ${repo}. no-stash (exit 1: error: Cannot find package 'x')`,
      to: "dispatcher",
    },
  ])
  expect((await probe({ "no-stash": 1 })).sent).toEqual([])
  const worse = await probe({ "no-kill-by-name": 127, "no-stash": 1 })
  expect(worse.sent.map((s) => s.text)).toEqual([
    expect.stringContaining(
      "no-stash (exit 1: error: Cannot find package 'x'); no-kill-by-name (exit 127)",
    ),
  ])
  expect((await probe({})).sent).toEqual([])
  expect(existsSync(join(ops, "tick", "guard-probe.json"))).toBe(false)
  expect((await probe({ "no-stash": 1 })).sent).toHaveLength(1)
  await probe({})
})

test("with every real guard broken, the fix sits inside the 400 characters notify.sh keeps", async () => {
  const guards = await preToolUseGuards(root)
  const sent: string[] = []
  await guardProbe({
    now: new Date(),
    ops: join(scratch, "ops-all"),
    repo: root,
    run: fakeRun({ "guard-probe": { code: 1, err: CRASH } }).run,
    send: async (_to, text) => {
      sent.push(text)
      return true
    },
  })
  expect(sent).toHaveLength(1)
  expect(sent[0]!.length).toBeGreaterThan(400)
  expect(sent[0]!.slice(0, 400)).toContain(`${guards.length} of ${guards.length} PreToolUse guards`)
  expect(sent[0]!.slice(0, 400)).toContain(
    `Fix: git checkout scripts/hooks/bundled, or bun run hooks:bundle, in ${root}.`,
  )
})

test("a send that fails is not marked told, so the next run tells it", async () => {
  expect((await probe({ "no-stash": 1 }, false)).sent).toHaveLength(1)
  expect((await probe({ "no-stash": 1 })).sent).toHaveLength(1)
  await probe({})
})

test("ops-tick runs the probe every 10 minutes for the dispatcher", () => {
  expect(BEATS.find((b) => b.name === "guard-probe")).toMatchObject({
    cron: "*/10 * * * *",
    run: guardProbe,
    to: "dispatcher",
  })
})
