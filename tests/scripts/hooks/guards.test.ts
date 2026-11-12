import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check, type Guard, GUARDS } from "../../../scripts/hooks/guards"
import { inspectAs, type Policy } from "../../../scripts/hooks/no-playground-leak"
import { pastDeadline, withDeadline } from "../../../scripts/hooks/shell"

const ROOT = join(import.meta.dir, "..", "..", "..")
const HOOKS = join(ROOT, "scripts", "hooks")

// Every Bash guard, which guards.ts runs in one process.
const BASH_GUARDS = [
  "no-desktop-owner-app",
  "no-env-dump",
  "no-extension-repo-write",
  "no-extensions-write",
  "no-false-green",
  "no-glm-heavy-path",
  "no-headless-login",
  "no-kill-by-name",
  "no-linear-ticket",
  "no-mac-web-build",
  "no-main-checkout",
  "no-off-palette-label",
  "no-ours-merge",
  "no-playground-leak",
  "no-prompt-stop",
  "no-public-leak",
  "no-raw-delete",
  "no-raw-spawn",
  "no-raw-wa",
  "no-release-comment",
  "no-stash",
  "no-unslotted-run",
]

// A guard's main block, the lines its own process runs.
const mainBlock = async (name: string) => {
  const text = await Bun.file(join(HOOKS, `${name}.ts`)).text()
  return text.slice(text.indexOf("if (import.meta.main)"))
}

const input = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    cwd: ROOT,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: "Bash",
    ...extra,
  })

const fake = (name: string, factory: boolean, run: Guard["run"]): Guard => ({ factory, name, run })

describe("guards.ts runs every Bash guard", () => {
  test("it names each Bash guard once, A to Z", () => {
    expect(GUARDS.map((g) => g.name)).toEqual(BASH_GUARDS)
  })

  // Each settings file runs a Bash call's guards through guards.ts alone, so a guard a later PR registers on Bash fails here until GUARDS runs it.
  test.each(["scripts/factory-settings.json", ".claude/settings.json"])(
    "%s registers guards.ts once on Bash, blocking on a failure, and no other Bash guard",
    async (file) => {
      const settings = (await Bun.file(join(ROOT, file)).json()) as {
        hooks: {
          PreToolUse: {
            hooks: { command: string; onFailure?: string; timeout?: number }[]
            matcher: string
          }[]
        }
      }
      const registered = settings.hooks.PreToolUse.filter(({ matcher }) =>
        new RegExp(matcher).test("Bash"),
      ).flatMap(({ hooks }) =>
        hooks.map(({ command, onFailure, timeout }) => ({
          hook: command.match(/bundled\/([a-z-]+)\.js/)?.[1],
          onFailure,
          timeout,
        })),
      )
      expect(registered).toEqual([{ hook: "guards", onFailure: "block", timeout: 15 }])
    },
  )

  test.each(BASH_GUARDS)("%s keeps its own main block's factory gate", async (name) => {
    const gated = (await mainBlock(name)).includes("await fromFactory(raw)")
    expect({ gated: GUARDS.find((g) => g.name === name)?.factory, name }).toEqual({ gated, name })
  })

  test.each(BASH_GUARDS)("%s runs the entry its own main block calls", async (name) => {
    const entry = (await mainBlock(name)).match(/await (check|guarded|refusal)\(/)?.[1]
    const source = await Bun.file(join(HOOKS, "guards.ts")).text()
    const imported = source.match(
      new RegExp(`import \\{ (\\w+) as \\w+ \\} from "\\./${name}"`),
    )?.[1]
    expect({ imported, name }).toEqual({ imported: entry, name })
  })
})

describe("check", () => {
  const worker = { PLAYGROUND_ROLE: "worker" }

  test("passes a call no guard refuses", async () => {
    expect(await check(input("true"), worker, [fake("a", true, async () => undefined)])).toBe(
      undefined,
    )
  })

  test("refuses with every refusal, one paragraph each, in the guards' order", async () => {
    const guards = [
      fake("a", true, async () => "a hook refuses"),
      fake("b", false, async () => undefined),
      fake("c", false, async () => "c hook refuses"),
    ]
    expect(await check(input("x"), worker, guards)).toBe("a hook refuses\n\nc hook refuses")
  })

  test("a guard that throws refuses the call, naming the guard, and the others still run", async () => {
    const guards = [
      fake("thrower", false, async () => {
        throw new Error("boom")
      }),
      fake("b", false, async () => "b hook refuses"),
    ]
    const reason = await check(input("x"), worker, guards)
    expect(reason).toContain("guards hook: thrower threw (boom), so the call is refused")
    expect(reason).toContain("b hook refuses")
  })

  test("a guard that throws a non-Error still refuses", async () => {
    const guards = [
      fake("thrower", true, () => {
        throw "plain"
      }),
    ]
    expect(await check(input("x"), worker, guards)).toContain("thrower threw (plain)")
  })

  test("an owner's own session runs the ungated guards alone", async () => {
    const ran: string[] = []
    const guards = [
      fake("gated", true, async () => (ran.push("gated"), "gated hook refuses")),
      fake("open", false, async () => (ran.push("open"), undefined)),
    ]
    expect(await check(input("x"), {}, guards)).toBe(undefined)
    expect(ran).toEqual(["open"])
  })

  test("a factory session runs every guard, with the environment it was given", async () => {
    const seen: (string | undefined)[] = []
    const guards = [
      fake("gated", true, async (_, env) => (seen.push(env.PLAYGROUND_ROLE), undefined)),
      fake("open", false, async (_, env) => (seen.push(env.PLAYGROUND_ROLE), undefined)),
    ]
    await check(input("x"), worker, guards)
    expect(seen).toEqual(["worker", "worker"])
  })

  test("the real guards refuse a bare stash for a factory session and pass a plain call", async () => {
    const env = { ...process.env, ...worker }
    expect(await check(input("git stash"), env)).toContain("no-stash hook ")
    expect(await check(input("true"), env)).toBe(undefined)
  })
})

// guards.ts runs its guards at once in one process, so each keeps the state a check holds per call in its async context: inspectAs's policy (#1702, fixed by #1721) and withDeadline's deadline (#1699).
describe("each guard keeps its own per-call state in one process", () => {
  const env = { HOME: tmpdir(), PATH: process.env.PATH, PLAYGROUND_ROLE: "worker" }
  const at = (command: string) => input(command, { cwd: tmpdir() })
  // two made-up policies, as #1721's row has them: A guards acme/ext on any write, B guards nothing
  const guarding: Policy = {
    anyWrite: true,
    find: () => undefined,
    git: true,
    guard: "A",
    guarded: (r) => `${r.owner}/${r.repo}`.toLowerCase() === "acme/ext",
    hosts: false,
    place: "p",
    what: "w",
    why: "y",
  }
  const none: Policy = {
    ...guarding,
    anyWrite: undefined,
    guard: "B",
    guarded: () => false,
    hosts: true,
  }
  const leak = (name: string, policy: Policy) =>
    fake(name, false, (raw, e) => withDeadline(10_000, () => inspectAs(policy, raw, e)))
  // reading files first gives the walk awaits, so the other guard runs inside it
  const merge = at("cat /etc/hosts /etc/shells > /dev/null; gh pr merge 1 -R acme/ext")

  test("two guards on one engine, under different policies, each give their own verdict in either order", async () => {
    const alone = await check(merge, env, [leak("a", guarding)])
    expect(alone).toContain("A hook refused")
    expect(await check(merge, env, [leak("b", none)])).toBeUndefined()
    expect(await check(merge, env, [leak("a", guarding), leak("b", none)])).toBe(alone)
    expect(await check(merge, env, [leak("b", none), leak("a", guarding)])).toBe(alone)
  })

  // a guard reads its own deadline once its wait is over, refusing when it is past
  const timed = (name: string, budget: number, wait: number) =>
    fake(name, false, () =>
      withDeadline(budget, async () => {
        await Bun.sleep(wait)
        try {
          pastDeadline()
          return undefined
        } catch {
          return `${name} past`
        }
      }),
    )

  test("a guard's short deadline cuts neither a long one beside it nor leaves one behind, in either order", async () => {
    const short = () => timed("short", 1, 20)
    const long = () => timed("long", 60_000, 40)
    expect(await check(at("true"), env, [short(), long()])).toBe("short past")
    expect(await check(at("true"), env, [long(), short()])).toBe("short past")
    expect(() => pastDeadline()).not.toThrow()
  })
})

// The bundle, run as its own process with the input on stdin, as guard-probe runs it.
describe("the bundle runs as a hook", () => {
  const run = async (raw: string) => {
    const proc = Bun.spawn(
      ["bun", "--no-env-file", join(ROOT, "scripts", "hooks", "bundled", "guards.js")],
      {
        cwd: ROOT,
        env: { ...process.env, PLAYGROUND_ROLE: "worker" },
        stderr: "pipe",
        stdin: new TextEncoder().encode(raw),
        stdout: "pipe",
      },
    )
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
  }

  test("exits 2 with the reason on stderr for a refused call", async () => {
    const { code, stderr } = await run(input("git stash"))
    expect(code).toBe(2)
    expect(stderr).toContain("no-stash hook ")
  })

  test("exits 0 for a plain call and for guard-probe's empty input", async () => {
    expect(await run(input("true"))).toEqual({ code: 0, stderr: "" })
    expect((await run("{}")).code).toBe(0)
  })
})
