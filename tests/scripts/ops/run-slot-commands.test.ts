import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SCRIPT, dirs, machine, runSlot } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

// 22 Oct: `run-slot.sh <name> -- python - <<EOF` read an empty program and exited 0, since bash gives a script's background job /dev/null
describe("the command reads run-slot's own stdin", () => {
  // Runs argv through run-slot from bash, with `heredoc` as a heredoc on its stdin, or its stdin closed when null, returning its exit code and stdout
  const piped = async (argv: string[], heredoc: string | null) => {
    const m = machine()
    // reads stdin for `commit` alone, since run-slot calls `git symbolic-ref` itself first and a fake reading it there takes the command's input
    writeFileSync(join(m.bin, "git"), '#!/bin/bash\n[ "$1" != commit ] || cat > "$GIT_INPUT"\n')
    chmodSync(join(m.bin, "git"), 0o755)
    const gitInput = join(m.root, "git-input")
    const script = heredoc === null ? '"$@" <&-' : `"$@" <<'EOF'\n${heredoc}EOF\n`
    const p = runSlot(["bash", "-c", script, "bash", "bash", SCRIPT, "worker-x", "--", ...argv], {
      cwd: m.root,
      env: m.env({ GIT_INPUT: gitInput }),
      stdout: "pipe",
      ops: m.ops,
    })
    const out = await new Response(p.stdout).text()
    return { code: await p.exited, gitInput: () => readFileSync(gitInput, "utf8"), out }
  }

  test("a heredoc program runs, and its exit code comes back", async () => {
    const r = await piped(["python3", "-"], 'print("stdin-marker")\nraise SystemExit(3)\n')
    expect(r.out).toContain("stdin-marker")
    expect(r.code).toBe(3)
  })

  test("so does a quick run's", async () => {
    const r = await piped(["git", "commit", "-F", "-"], "fix: a message\n")
    expect(r.code).toBe(0)
    expect(r.gitInput()).toBe("fix: a message\n")
  })

  test("a command that reads no stdin runs as before", async () => {
    const r = await piped(["python3", "-c", 'print("no-stdin")'], "unread\n")
    expect(r.out).toBe("no-stdin\n")
    expect(r.code).toBe(0)
  })

  test("a closed stdin gives the command an empty one, as before", async () => {
    const r = await piped(["python3", "-c", "import sys; print(repr(sys.stdin.read()))"], null)
    expect(r.out).toBe("''\n")
    expect(r.code).toBe(0)
  })
})

describe("one argument holding a list of paths", () => {
  test("a joined list of real paths warns, and the run goes ahead as before", async () => {
    const m = machine()
    writeFileSync(join(m.root, "a.test.ts"), "")
    writeFileSync(join(m.root, "b.test.ts"), "")
    const p = runSlot(["bash", SCRIPT, "worker-x", "--", "touch", "a.test.ts b.test.ts"], {
      cwd: m.root,
      env: m.env(),
      stderr: "pipe",
      ops: m.ops,
    })
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    expect(code).toBe(0)
    expect(err).toContain("which zsh did not word-split")
    expect(err).toContain("${=VAR} in zsh, or xargs")
    expect(existsSync(join(m.root, "a.test.ts b.test.ts"))).toBe(true)
  })

  test("a list joined by newlines warns too, as `FILES=$(git diff --name-only)` holds them", async () => {
    const m = machine()
    writeFileSync(join(m.root, "a.test.ts"), "")
    writeFileSync(join(m.root, "b.test.ts"), "")
    const p = runSlot(["bash", SCRIPT, "worker-x", "--", "touch", "a.test.ts\nb.test.ts"], {
      cwd: m.root,
      env: m.env(),
      stderr: "pipe",
      ops: m.ops,
    })
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    expect(code).toBe(0)
    expect(err).toContain("which zsh did not word-split")
    expect(existsSync(join(m.root, "a.test.ts\nb.test.ts"))).toBe(true)
  })

  test("a message whose first word alone names a path does not warn", async () => {
    const m = machine()
    writeFileSync(join(m.root, "a.test.ts"), "")
    const p = runSlot(
      ["bash", SCRIPT, "worker-x", "--", "printf", "%s\\n", "a.test.ts is a message"],
      { cwd: m.root, env: m.env(), stderr: "pipe", ops: m.ops },
    )
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    expect(code).toBe(0)
    expect(err).not.toContain("word-split")
  })
})

// dispatcher, 18 Oct: keen-ledger's dev stack held a slot from 21:13Z to 21:58Z
const refused = async (argv: string[]) => {
  const m = machine()
  const p = runSlot(["bash", SCRIPT, "worker-x", "--", ...argv], {
    cwd: tmpdir(),
    env: m.env(),
    stderr: "pipe",
    ops: m.ops,
  })
  return { code: await p.exited, err: await new Response(p.stderr).text(), tickets: m.tickets() }
}

// reviewer-ops-load-units, 19 Oct: a holder line left naming a finished run's pid let a waiter reclaim the next taker's slot
test("a finished run leaves no holder line", async () => {
  const m = machine()
  expect(await m.runs("worker-x")).toBe(true)
  expect(existsSync(join(m.ops, "run-slot"))).toBe(false)
  expect(existsSync(join(m.ops, "run-slot.holder"))).toBe(false)
})

// reviewer-ops-up-runtime, review round 6: a run killed between free()'s holder rm and its rmdir left a slot folder no rule freed
describe("a slot folder with no holder line", () => {
  const bare = (m: ReturnType<typeof machine>, slot: string, ago: number) => {
    mkdirSync(join(m.ops, slot))
    const at = Date.now() / 1000 - ago
    utimesSync(join(m.ops, slot), at, at)
  }
  const both = (ago: number) => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    bare(m, "run-slot", ago)
    bare(m, "run-slot-2", ago)
    return m
  }

  test("is reclaimed once it has aged 2 hours", async () => {
    expect(await both(3 * 3600).runs("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("is held while it is young", async () => {
    expect(await both(60).waits("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("clear-stale clears an aged one and leaves a young one", async () => {
    const m = machine()
    bare(m, "run-slot", 3 * 3600)
    bare(m, "run-slot-2", 60)
    const p = runSlot(["bash", SCRIPT, "clear-stale"], {
      env: m.env(),
      stdout: "pipe",
      ops: m.ops,
    })
    expect(await p.exited).toBe(0)
    expect(await new Response(p.stdout).text()).toContain("run-slot: cleared")
    expect(existsSync(join(m.ops, "run-slot"))).toBe(false)
    expect(existsSync(join(m.ops, "run-slot-2"))).toBe(true)
  })

  test("clear-stale clears an aged run-slot-quick", async () => {
    const m = machine()
    bare(m, "run-slot-quick", 3 * 3600)
    const p = runSlot(["bash", SCRIPT, "clear-stale"], {
      env: m.env(),
      stdout: "pipe",
      ops: m.ops,
    })
    expect(await p.exited).toBe(0)
    expect(existsSync(join(m.ops, "run-slot-quick"))).toBe(false)
  })
})

// the dispatcher, 4 Nov: a slot with no pid in its holder line, whose mtime read back empty, printed "<epoch> -  : syntax error: operand expected"
test("a slot with no holder pid and no readable mtime reads as young, with no error line", async () => {
  const m = machine()
  mkdirSync(join(m.ops, "run-slot"))
  writeFileSync(
    join(m.bin, "stat"),
    `#!/bin/bash\ncase "\${@: -1}" in */run-slot|*/run-slot.holder) exit 0 ;; esac\nexec /usr/bin/stat "$@"\n`,
  )
  chmodSync(join(m.bin, "stat"), 0o755)
  const p = runSlot(["bash", SCRIPT, "clear-stale"], { env: m.env(), stderr: "pipe", ops: m.ops })
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
  expect(err).toBe("")
  expect(code).toBe(0)
  expect(existsSync(join(m.ops, "run-slot"))).toBe(true)
})

// #884's reviewer: the set file's expiry and prio_holder did the same arithmetic as stale, unguarded, so an empty mtime printed the syntax error there too
describe("an ops file whose mtime reads back empty reads as gone, with no error line", () => {
  // a machine whose stat prints nothing, and succeeds, for the ops file named
  const blind = (file: string, text: string) => {
    const m = machine()
    writeFileSync(join(m.ops, file), text)
    writeFileSync(
      join(m.bin, "stat"),
      `#!/bin/bash\ncase "\${@: -1}" in */${file}) exit 0 ;; esac\nexec /usr/bin/stat "$@"\n`,
    )
    chmodSync(join(m.bin, "stat"), 0o755)
    return m
  }

  test("a set file with no expiry line leaves its slot open", async () => {
    const m = blind("run-slot.3-off", "")
    const p = runSlot(["bash", SCRIPT, "slots"], {
      env: m.env(),
      stderr: "pipe",
      stdout: "pipe",
      ops: m.ops,
    })
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    expect(err).toBe("")
    expect(code).toBe(0)
    expect(out).toBe("4\n")
  })

  test("run-slot.priority names no holder, so a run takes its slot", async () => {
    const m = blind("run-slot.priority", "worker-p\n")
    const p = runSlot(["bash", SCRIPT, "worker-m", "--", "true"], {
      cwd: m.root,
      env: m.env({ RUN_SLOT_SIZE: "medium" }),
      stderr: "pipe",
      ops: m.ops,
    })
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    expect(err).not.toContain("syntax error")
    expect(code).toBe(0)
  })
})

// dispatcher, 19 Oct: a tester's `bun run dev` held run-slot.single with 7 waiters
describe("a dev stack is refused", () => {
  for (const argv of [
    ["bun", "run", "dev"],
    ["bun", "run", "dev:stop"],
    ["npx", "next", "dev", "--port", "3000"],
  ])
    test(argv.join(" "), async () => {
      const r = await refused(argv)
      expect(r.code).toBe(2)
      expect(r.err).toContain(
        "run-slot.sh: a dev stack runs as a background task under the load gate, not through run-slot",
      )
      expect(r.tickets).toEqual([])
    })

  test("bun run test is not", async () => {
    const r = await refused(["echo", "bun", "run", "test"])
    expect(r.code).toBe(0)
  })
})

describe("a command that never exits is refused", () => {
  for (const argv of [
    ["bun", "run", "ingest", "--follow"],
    ["bun", "test", "--watch"],
    ["bash", "-c", "cd web && bun run dev"],
  ])
    test(argv.join(" "), async () => {
      const r = await refused(argv)
      expect(r.code).toBe(2)
      expect(r.err).toContain(
        "(slots): start a fixture stack outside run-slot, only while you take shots",
      )
    })
})

// ops, 31 Oct: another factory's pool on this Mac never saw this one's, and the two together took load1 to 77 and swap to 7.6 GB
describe("another factory's runs (slots.peers)", () => {
  // a peer's ops folder holding run-slot with a holder line whose pid is `pid`
  const peerHolding = (pid: number) => {
    const peer = mkdtempSync(join(tmpdir(), "peer-ops-"))
    dirs.push(peer)
    mkdirSync(join(peer, "run-slot"))
    writeFileSync(join(peer, "run-slot.holder"), `b8-worker ${pid} 2026-10-31T00:50:00Z 3 big\n`)
    return peer
  }

  test("a medium run waits while a peer's live run holds 3 units", async () => {
    const peer = peerHolding(process.pid)
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"], peers: [peer] })
    expect(await m.waits("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
    expect(readFileSync(join(peer, "run-slot.holder"), "utf8")).toContain(`${process.pid}`)
  })

  test("a peer's holder whose pid has died counts nothing, and its folder is left as it is", async () => {
    const gone = Bun.spawn(["true"])
    await gone.exited
    const peer = peerHolding(gone.pid)
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"], peers: [peer] })
    expect(await m.runs("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
    expect(existsSync(join(peer, "run-slot"))).toBe(true)
    expect(existsSync(join(peer, "run-slot.holder"))).toBe(true)
  })

  test("can-take counts a peer's units as for any run", async () => {
    const peer = peerHolding(process.pid)
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"], peers: [peer] })
    expect(await m.canTake("run-slot", "worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(false)
    expect(await m.canTake("run-slot", "worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })
})

// localci and the merge train take their slots themselves; they ask run-slot.sh, so an off-switch reaches them too (18 Oct: localci took slot 3 past run-slot.3-off)
// R3.2, 31 Oct: ops-unstick's slot-stuck alert named the oldest ticket, which can rank behind by design
describe("head", () => {
  test("prints the ticket the queue serves next, a medium one ahead of an older big one, and changes nothing", async () => {
    const m = machine()
    m.ticket(1, "worker-big", "s2 23 3 big")
    m.ticket(2, "worker-m", "s2 22 2 medium")
    const before = m.tickets().sort()
    const run = Bun.spawnSync(["bash", SCRIPT, "head"], { cwd: m.root, env: m.env() })
    expect([run.exitCode, run.stdout.toString()]).toEqual([0, `2-${process.pid}-worker-m\n`])
    expect(m.tickets().sort()).toEqual(before)
    expect(existsSync(join(m.ops, "run-slot.runs.log"))).toBe(false)
  })

  test("exits 2 on an extra argument", async () => {
    const m = machine()
    const run = Bun.spawnSync(["bash", SCRIPT, "head", "x"], { cwd: m.root, env: m.env() })
    expect([run.exitCode, run.stdout.toString()]).toEqual([2, ""])
  })
})

describe("can-take", () => {
  test("a slot its off-switch closes", async () => {
    const m = machine({ off: ["run-slot.3-off"] })
    expect(await m.canTake("run-slot-3", "ops-localci")).toBe(false)
    expect(await m.canTake("run-slot-4", "ops-localci")).toBe(true)
  })

  test("a slot already held", async () => {
    const m = machine()
    m.hold("run-slot", 2, "medium")
    expect(await m.canTake("run-slot", "ops-localci")).toBe(false)
    expect(await m.canTake("run-slot-2", "ops-localci")).toBe(true)
  })

  test("the units decide as for any run", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    expect(await m.canTake("run-slot-2", "worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(false)
    expect(await m.canTake("run-slot-2", "worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })

  test("leaves no ticket in the queue", async () => {
    const m = machine()
    await m.canTake("run-slot", "ops-localci")
    expect(await m.runs("worker-b", { RUN_SLOT_SIZE: "big" })).toBe(true)
  })
})

// dispatcher, 18 Oct: a committed test, type check, lint or build runs on the runner host through ci.sh exec, and falls back to a slot here
describe("the runner host", () => {
  // four test files, past the quick lane's three, so the run is the box's to take
  const FOUR = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"]
  // A stub ci.sh that logs its arguments and exits with `rc`, and a stub bun that logs what the Mac ran, answering the settings reader and a check-types dry run with nothing.
  const box = (rc: number, off?: string) => {
    const m = machine()
    const host = join(m.ops, "runner-host")
    mkdirSync(host)
    if (off) writeFileSync(join(host, off), "")
    writeFileSync(
      join(host, "ci.sh"),
      `#!/bin/bash\necho "$*" >> ${join(host, "calls")}\nexit ${rc}\n`,
    )
    chmodSync(join(host, "ci.sh"), 0o755)
    writeFileSync(
      join(m.bin, "bun"),
      `#!/bin/bash\ncase "$1 $*" in */setting.ts*|*" --dry=json"*) exit 0 ;; esac\necho "$*" >> ${join(m.root, "mac")}\n`,
    )
    chmodSync(join(m.bin, "bun"), 0o755)
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "")
    const run = async (argv: string[], extra: Record<string, string> = {}) => {
      const p = runSlot(["bash", SCRIPT, "worker-x", "--", ...argv], {
        cwd: m.root,
        env: m.env(extra),
        stderr: "pipe",
        ops: m.ops,
      })
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
      return {
        box: read(join(host, "calls")),
        code,
        err,
        log: read(join(host, "runs.log")),
        mac: read(join(m.root, "mac")),
        root: realpathSync(m.root),
      }
    }
    return Object.assign(run, { root: m.root })
  }

  test("a bun test goes to the box and its exit code comes back", async () => {
    const r = await box(3)(["bun", "test", ...FOUR])
    expect(r.code).toBe(3)
    expect(r.box).toBe(`exec ${r.root} -- bun test ${FOUR.join(" ")}\n`)
    expect(r.mac).toBe("")
    expect(r.log).toContain(`start worker-x ${r.root} bun test ${FOUR.join(" ")}`)
    expect(r.log).toContain("end worker-x rc=3")
  })

  // #2529: the box route comes after the quick lane, so a short run stays in its quick slot here and the box takes the heavy ones
  for (const argv of [
    ["bun", "test", "tests/x.test.ts"],
    ["bun", "run", "test:file", "tests/x.test.ts", "tests/y.test.ts"],
    ["bun", "run", "format:check"],
  ])
    test(`${argv.join(" ")} takes the quick lane here, never the box`, async () => {
      const r = await box(0)(argv)
      expect(r.box).toBe("")
      expect(r.mac).toBe(`${argv.slice(1).join(" ")}\n`)
      expect(r.err).toContain("worker-x holds run-slot-quick")
    })

  test("a run the box cannot take (255) waits for a slot here", async () => {
    const r = await box(255)(["bun", "test", ...FOUR])
    expect(r.code).toBe(0)
    expect(r.box).not.toBe("")
    expect(r.mac).toBe(`test ${FOUR.join(" ")}\n`)
    expect(r.err).toContain("the runner host could not take it")
    expect(r.err).toContain("worker-x holds run-slot")
  })

  // PG-2368: the box gets no PLAYGROUND_REPO, so test:file there could not refuse a relative path from the factory's main checkout
  test("a test:file from the factory's main checkout stays here, and one from another checkout goes to the box", async () => {
    const run = box(0)
    const here = await run(["bun", "run", "test:file", ...FOUR], {
      PLAYGROUND_REPO: run.root,
    })
    expect(here.box).toBe("")
    expect(here.mac).toBe(`run test:file ${FOUR.join(" ")}\n`)
    const elsewhere = join(run.root, "elsewhere")
    mkdirSync(elsewhere)
    const other = await run(["bun", "run", "test:file", ...FOUR], {
      PLAYGROUND_REPO: elsewhere,
    })
    expect(other.box).toBe(`exec ${other.root} -- bun run test:file ${FOUR.join(" ")}\n`)
  })

  // builder, 19 Oct: a Mac rerun of a red seen only on the box
  test("RUN_SLOT_HERE in run-slot's environment keeps a test here", async () => {
    const r = await box(0)(["bun", "test"], { RUN_SLOT_HERE: "1" })
    expect(r.box).toBe("")
    expect(r.mac).toBe("test\n")
    expect(r.err).toContain("worker-x holds run-slot")
  })

  test("RUN_SLOT_HERE as an env word of the command keeps it here", async () => {
    const r = await box(0)(["env", "RUN_SLOT_HERE=1", "bun", "test"])
    expect(r.box).toBe("")
    expect(r.mac).toBe("test\n")
    expect(r.err).toContain("worker-x holds run-slot")
  })

  // review round 2: a type check also builds packages/*/dist, which a later run on the Mac imports
  test("check-types stays here while a package's dist is missing", async () => {
    const run = box(0)
    writeFileSync(join(run.root, ".git"), "gitdir: x\n")
    mkdirSync(join(run.root, "packages", "a"), { recursive: true })
    writeFileSync(
      join(run.root, "packages", "a", "package.json"),
      JSON.stringify({ scripts: { build: "tsdown" } }),
    )
    const before = await run(["bun", "run", "check-types"])
    expect(before.box).toBe("")
    expect(before.mac).toBe("run check-types\n")
    expect((await run(["bun", "test"])).box).toContain("-- bun test")
    mkdirSync(join(run.root, "packages", "a", "dist"))
    expect((await run(["bun", "run", "check-types"])).box).toContain("-- bun run check-types")
  })

  // worker-firm-keel, 19 Oct: a type check from a subfolder read the other workspaces' dist, which the box lacks (332 false errors)
  describe("from a checkout's root or a subfolder", () => {
    const checkout = () => {
      const run = box(0)
      writeFileSync(join(run.root, ".git"), "gitdir: x\n")
      mkdirSync(join(run.root, "web", "next"), { recursive: true })
      return Object.assign(run, { sub: `--cwd=${join(run.root, "web", "next")}` })
    }

    test("a build from the root stays here", async () => {
      const r = await checkout()(["bun", "run", "build"])
      expect(r.box).toBe("")
      expect(r.mac).toBe("run build\n")
    })

    test("a subfolder check-types stays here", async () => {
      const run = checkout()
      const r = await run(["bun", run.sub, "run", "check-types"])
      expect(r.box).toBe("")
      expect(r.mac).toBe(`${run.sub} run check-types\n`)
    })

    test("a root check-types goes to the box", async () => {
      const r = await checkout()(["bun", "run", "check-types"])
      expect(r.box).toBe(`exec ${r.root} -- bun run check-types\n`)
      expect(r.mac).toBe("")
    })

    test("a subfolder test goes to the box", async () => {
      const run = checkout()
      const r = await run(["bun", run.sub, "test"])
      expect(r.box).toBe(`exec ${join(run.root, "web", "next")} -- bun ${run.sub} test\n`)
      expect(r.mac).toBe("")
    })
  })

  // ops, 20 Oct: slot-off keeps run-slot's runs here and leaves the box to Checks
  for (const off of ["off", "slot-off"])
    test(`runner-host/${off} takes a slot`, async () => {
      const r = await box(0, off)(["bun", "test"])
      expect(r.box).toBe("")
      expect(r.mac).toBe("test\n")
    })

  // the switch that kept the box idle for two days
  test("an expired runner-host/slot-off drops, and the run goes to the box", async () => {
    const run = box(0)
    const off = join(run.root, "ops", "runner-host", "slot-off")
    writeFileSync(off, "ops 2026-10-22T08:10:00Z 2026-10-22T12:10:00Z box queue deep\n")
    const r = await run(["bun", "test"])
    expect(r.box).toBe(`exec ${r.root} -- bun test\n`)
    expect(existsSync(off)).toBe(false)
  })

  // 9jhtsd, 24 Oct: a test of another worktree's file, started from this one, ran in this tree on the box and went red as "Script not found"
  test("a path in another checkout is refused with the fix, and one in its own goes to the box", async () => {
    const run = box(0)
    writeFileSync(join(run.root, ".git"), "gitdir: x\n")
    const other = join(run.root, "other")
    mkdirSync(join(other, "tests"), { recursive: true })
    writeFileSync(join(other, ".git"), "gitdir: y\n")
    const r = await run(["bun", "test", join(other, "tests", "x.test.ts")])
    expect(r.code).toBe(2)
    expect(r.box).toBe("")
    expect(r.err).toContain(`pass --cwd ${realpathSync(other)}`)
    const own = await run(["bun", "test", join(run.root, "tests", "x.test.ts"), ...FOUR])
    expect(own.box).toContain(" -- bun test ")
  })

  // a review: a path holding "verify" (a test file, a worktree) is still a test; only an e2e file in a path keeps it here
  for (const argv of [
    ["bun", "test", "tests/packages/scripts/src/verify/dashboard-map.test.ts"],
    ["bun", "--cwd=/x/worktrees/review-verify-1", "test", "tests/a.test.ts"],
    ["bun", "run", "test:file", "tests/a.test.ts"],
    ["bun", "run", "--cwd", "/x/worktrees/a", "test:file", "tests/a.test.ts"],
    ["bun", "--cwd=/x/worktrees/a", "run", "test:file", "tests/a.test.ts"],
  ])
    test(`${argv.join(" ")} goes to the box with three more files`, async () => {
      const r = await box(0)([...argv, ...FOUR.slice(1)])
      expect(r.box).toContain(` -- ${[...argv, ...FOUR.slice(1)].join(" ")}`)
      expect(r.mac).toBe("")
    })

  for (const argv of [
    ["bun", "run", "verify"],
    ["bun", "run", "test:e2e"],
    ["bun", "test", "tests/api/hono/src/routers/admin.e2e.test.ts"],
    ["bun", "install"],
    ["bun", "run", "test:docker"],
    ["bash", "-c", "bun test"],
  ])
    test(`${argv.join(" ")} takes a slot`, async () => {
      const r = await box(0)(argv)
      expect(r.box).toBe("")
      expect(r.code).toBe(0)
      expect(r.err).toContain("worker-x holds run-slot")
    })

  for (const argv of [
    ["bun", "run", "build", "--watch"],
    ["bun", "run", "dev"],
  ])
    test(`${argv.join(" ")} never goes to the box`, async () => {
      expect((await box(0)(argv)).box).toBe("")
    })
})

// optimizer, 19 Oct: a run's wait beside its run time, one line when a Mac run asks, takes its slot and ends
test("run-slot.runs.log has a Mac run's ask, start and end", async () => {
  const m = machine()
  expect(await m.runs("worker-x")).toBe(true)
  // a lanes line records the gauges as the run first reads them, and a next line the oldest waiter's run-slot.next write, beside the run's own three
  const log = readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => !/^\S+ (lanes|next) /.test(line))
  expect(log).toHaveLength(3)
  expect(log[0]).toMatch(/Z ask worker-x \d+ touch /)
  expect(log[1]).toMatch(/Z start worker-x \d+ run-slot waited=\d+s$/)
  expect(log[2]).toMatch(/Z end worker-x \d+ rc=0 ran=\d+s$/)
})
