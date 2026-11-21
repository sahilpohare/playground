import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cwdsOf,
  endOrphans,
  orphansOf,
  PS,
  procsOf,
} from "../../../../../packages/scripts/src/ops-tick/orphans"
import type { Context } from "../../../../../packages/scripts/src/ops-tick/tick"

const root = mkdtempSync(join(tmpdir(), "orphans-"))
const worktrees = join(root, "main", ".claude", "worktrees")
const kept = join(worktrees, "PG-2-kept")
mkdirSync(kept, { recursive: true })
const gone = join(worktrees, "review-947")
afterAll(() => rmSync(root, { force: true, recursive: true }))

// a ps -A -ww -o pid=,ppid=,etime=,command= row, as ps pads it
const row = (pid: number, ppid: number, command: string, age = "02:13:07") =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${age.padStart(11)} ${command}`

// who adopts an orphan: pid 1 alone, as on macOS, or with the user's systemd --user (pid 1500), as on a Linux desktop
const PID1 = new Set([1])
const LINUX = new Set([1, 1500])
// no session's roster row reads ended
const noneEnded = () => false

describe("procsOf", () => {
  test("reads each row's pid, parent, age and whole command, spaces kept", () => {
    expect(
      procsOf(
        [
          row(314, 1, "/usr/libexec/logd"),
          row(58523, 1, `bash ${gone}/scripts/ops/run-slot.sh worker-a -- sleep 5`, "1-04:05:06"),
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { age: "02:13:07", command: "/usr/libexec/logd", pid: 314, ppid: 1 },
      {
        age: "1-04:05:06",
        command: `bash ${gone}/scripts/ops/run-slot.sh worker-a -- sleep 5`,
        pid: 58523,
        ppid: 1,
      },
    ])
  })
})

describe("cwdsOf", () => {
  test("reads each pid's working folder from lsof -F pn, spaces kept, and skips a pid lsof names no folder for", () => {
    expect(cwdsOf("p314\nfcwd\nn/\np750\nfcwd\nn/tmp/test-sandbox-a b/t\np751\nfcwd\n")).toEqual(
      new Map([
        [314, "/"],
        [750, "/tmp/test-sandbox-a b/t"],
      ]),
    )
  })
})

describe("orphansOf", () => {
  const select = (rows: string[]) =>
    orphansOf(procsOf(rows.join("\n")), worktrees, existsSync, PID1, noneEnded).map((o) => o.pid)

  // the 7 Nov shape: a run-slot waiter a test fixture started from a review clone, left with parent pid 1 after the clone was removed
  test("selects a script of a worktree that is gone, once its parent is pid 1, a reaper given", () => {
    expect(
      select([row(58523, 1, `bash ${gone}/scripts/ops/run-slot.sh worker-a -- sleep 5`)]),
    ).toEqual([58523])
    expect(
      orphansOf(
        procsOf(row(63802, 1, `bun ${gone}/packages/scripts/src/x.ts`)),
        worktrees,
        existsSync,
        PID1,
        noneEnded,
      ),
    ).toEqual([
      {
        age: "02:13:07",
        command: `bun ${gone}/packages/scripts/src/x.ts`,
        pid: 63802,
        ppid: 1,
        worktree: gone,
      },
    ])
  })

  test("never selects a live session's process: its parent is the session, not pid 1", () => {
    expect(select([row(700, 650, `bash ${gone}/scripts/ops/run-slot.sh w -- sleep 5`)])).toEqual([])
  })

  test("never selects a process whose worktree still exists", () => {
    expect(select([row(701, 1, `bash ${kept}/scripts/ops/run-slot.sh w -- sleep 5`)])).toEqual([])
    // one named worktree still there keeps it, whatever else the command names
    expect(select([row(702, 1, `bun ${gone}/a.ts --cwd ${kept}/web/next`)])).toEqual([])
  })

  // a worktree is matched on its whole folder name, never a prefix: a gone foo leaves the live foo-2's process alone, and a gone bar-2 leaves the live bar's
  test("matches a worktree on its whole folder name, never on a prefix", () => {
    mkdirSync(join(worktrees, "foo-2"), { recursive: true })
    mkdirSync(join(worktrees, "bar"), { recursive: true })
    expect(
      select([
        row(710, 1, `bash ${worktrees}/foo-2/scripts/ops/run-slot.sh w -- sleep 5`),
        row(711, 1, `bash ${worktrees}/bar/scripts/ops/run-slot.sh w -- sleep 5`),
        row(712, 1, `bash ${worktrees}/foo/scripts/ops/run-slot.sh w -- sleep 5`),
        row(713, 1, `bash ${worktrees}/bar-2/scripts/ops/run-slot.sh w -- sleep 5`),
      ]),
    ).toEqual([712, 713])
  })

  // an ops job launchd runs from the main checkout has parent pid 1 too, and its checkout stays
  test("never selects a launchd ops job that runs a script of the main checkout", () => {
    expect(
      select([
        row(720, 1, `bun ${join(root, "main")}/packages/scripts/src/ops-tick/cli.ts`),
        row(721, 1, `bash ${join(root, "main")}/scripts/ops/run-slot.sh ops-tick -- git fetch`),
      ]),
    ).toEqual([])
  })

  // portless's shared proxy, which a stack's dev.ts starts from its worktree's node_modules and portless detaches, so its parent is pid 1; every stack routes through it, so a dependency's binary under node_modules is never this repo's script
  test("never selects a dependency's binary under a gone worktree's node_modules, the shared proxy's shape", () => {
    expect(
      select([
        row(
          730,
          1,
          `bun ${gone}/node_modules/portless/dist/cli.js proxy start --foreground -p 1355 --skip-trust`,
          "1-02:00:00",
        ),
        row(731, 1, `${gone}/node_modules/.bin/portless proxy start -p 1355`),
        row(732, 1, `${gone}/node_modules/turbo-darwin-arm64/bin/turbo daemon`),
        row(733, 1, `bun ${gone}/web/next/node_modules/next/dist/bin/next dev`),
      ]),
    ).toEqual([])
    // this repo's own script run through a dependency's binary is still this repo's script
    expect(select([row(734, 1, `${gone}/node_modules/.bin/tsx ${gone}/scripts/x.ts`)])).toEqual([
      734,
    ])
  })

  // only a script file counts: an app opened on a gone worktree's folder, or a reader of a log there, may have parent pid 1 too, and is no factory script
  test("never selects a program that names only a gone worktree's folder or a file that is no script", () => {
    expect(
      select([
        row(740, 1, `/Applications/Editor.app/Contents/MacOS/Electron ${gone}/`),
        row(741, 1, `/Applications/Editor.app/Contents/MacOS/Electron ${gone}`),
        row(742, 1, `tail -f ${gone}/.turbo/dev.log`),
        row(743, 1, `less ${gone}/README.md`),
      ]),
    ).toEqual([])
    expect(
      select([
        row(744, 1, `bash ${gone}/scripts/ops/run-slot.sh w -- sleep 5`),
        row(745, 1, `bun ${gone}/packages/scripts/src/x.ts`),
        row(746, 1, `node ${gone}/scripts/x.mjs`),
        row(747, 1, `python3 ${gone}/scripts/x.py`),
      ]),
    ).toEqual([744, 745, 746, 747])
  })

  // #2177: a stub checkout's hook ran a relative script with parent pid 1 from a test sandbox's temp folder, which the run had removed, and no worktree in its command ever matched; lsof still names a removed working folder
  test("selects a process whose working folder sits under a test sandbox that is gone, and leaves a live run's child alone", () => {
    const tmp = join(root, "T")
    const live = join(tmp, "test-sandbox-live01")
    mkdirSync(join(live, "t", "hooks-abs-path-x", "stuck"), { recursive: true })
    const ended = join(tmp, "test-sandbox-ended1")
    const at = (pid: number, ppid: number, cwd: string) =>
      Object.assign(procsOf(row(pid, ppid, "bun --no-env-file scripts/hooks/guards.ts"))[0]!, {
        cwd,
      })
    const found = orphansOf(
      [
        at(750, 1, join(ended, "t", "hooks-abs-path-x", "stuck")),
        at(751, 1, join(live, "t", "hooks-abs-path-x", "stuck")),
        at(752, 640, join(ended, "t", "hooks-abs-path-x", "stuck")),
        // a run nested in a live run's sandbox, whose own sandbox is gone
        at(753, 1, join(live, "t", "test-sandbox-inner1", "home")),
        at(754, 1, join(root, "elsewhere")),
      ],
      worktrees,
      existsSync,
      PID1,
      // the session this test's own temp folder may sit under reads ended, so the sandbox alone decides
      () => true,
    )
    expect(found.map((o) => o.pid)).toEqual([750, 753])
  })

  // #2402: on Linux an orphan goes to the user's systemd --user, so a pick by parent pid 1 alone found none
  test("selects an orphan whose parent is a reaper given, the user manager included, and no other parent", () => {
    const script = `bash ${gone}/scripts/ops/run-slot.sh w -- sleep 5`
    const rows = [row(760, 1500, script), row(761, 1600, script), row(762, 1, script)]
    expect(
      orphansOf(procsOf(rows.join("\n")), worktrees, existsSync, LINUX, noneEnded).map(
        (o) => o.pid,
      ),
    ).toEqual([760, 762])
    expect(select(rows)).toEqual([762])
  })

  // #2402: the 16 Nov shape: TERM-trapping run-slot loops from an ended reviewer's test sandboxes, under its session temp folder, which still exists
  // the paths are made up and every sandbox reads gone, since this test's own temp folder sits under its session's and would name that session first
  test("selects a sandbox orphan under a session's temp folder only once that session's roster row reads ended, a nested sandbox's too", () => {
    const temp = (name: string) => `/tmp/playground-${name}.deAm5P`
    const direct = (name: string) => `${temp(name)}/test-sandbox-Xy12z`
    const nested = (name: string) => `${direct(name)}/t/test-sandbox-In1/t`
    const at = (pid: number, cwd: string) =>
      Object.assign(procsOf(row(pid, 1500, "bash -c while :; do sleep 0.2; done"))[0]!, { cwd })
    const ended = (name: string) => name === "42fmjw-reviewer"
    const found = orphansOf(
      [
        at(770, `${direct("42fmjw-reviewer")}/t/run-slot-1 (deleted)`),
        // a live session's daemon, double-forked so the user manager adopted it, whose test run removed its sandbox: kept while that session's row reads live
        at(771, `${direct("ab12cd-worker")}/t/run-slot-1`),
        // a session with no roster row
        at(772, `${direct("zz99zz-probe")}/t/run-slot-1`),
        // a test run's own test run, whose sandbox sits in its outer run's t folder: the outer session folder names the session
        at(773, `${nested("42fmjw-reviewer")}/x`),
        at(774, `${nested("ab12cd-worker")}/x`),
      ],
      worktrees,
      () => false,
      LINUX,
      ended,
    )
    expect(found.map((o) => [o.pid, "sandbox" in o && o.sandbox])).toEqual([
      [770, direct("42fmjw-reviewer")],
      [773, `${direct("42fmjw-reviewer")}/t/test-sandbox-In1`],
    ])
  })

  test("never selects a process that names no worktree of this checkout", () => {
    expect(
      select([
        row(314, 1, "/usr/libexec/logd"),
        row(703, 1, `bash ${root}/elsewhere/.claude/worktrees/x/run.sh`),
        row(704, 1, `bash ${worktrees}-old/review-947/run.sh`),
        // the worktrees folder itself, no worktree in it
        row(705, 1, `ls ${worktrees}`),
      ]),
    ).toEqual([])
  })
})

describe("endOrphans", () => {
  // processes this test spawns itself, each listed by a fake ps row whose parent is the user manager and with a gone worktree's script, so the real kill reaches only them
  const spawnOwn = (script: string) =>
    Bun.spawn(["bun", "-e", script], { stdio: ["ignore", "ignore", "ignore"] })
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test("sends TERM, waits the grace, sends KILL only to one still listed with the same command, and names how each ended", async () => {
    const calm = spawnOwn("setInterval(() => {}, 1000)")
    const stubborn = spawnOwn("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")
    await Bun.sleep(300)
    const own = new Map([
      [calm.pid, `bun ${gone}/scripts/calm.ts`],
      [stubborn.pid, `bun ${gone}/scripts/stubborn.ts`],
    ])
    const runs: string[][] = []
    const run: Context["run"] = async (argv) => {
      runs.push(argv)
      if (argv.join(" ") === PS.join(" "))
        return {
          code: 0,
          out: [...own]
            .filter(([pid]) => alive(pid))
            .map(([pid, c]) => row(pid, 1500, c))
            .join("\n"),
        }
      if (argv[0] === "kill" && own.has(Number(argv[2]))) {
        const done = Bun.spawnSync(argv)
        return { code: done.exitCode, out: done.stderr.toString() }
      }
      throw new Error(`not this test's: ${argv.join(" ")}`)
    }
    try {
      const found = orphansOf(procsOf((await run(PS)).out), worktrees, existsSync, LINUX, noneEnded)
      expect(found.map((o) => o.pid).sort()).toEqual([calm.pid, stubborn.pid].sort())
      const waits: number[] = []
      const said = await endOrphans(found, run, async (ms) => {
        waits.push(ms)
        await Bun.sleep(500)
      })
      expect(await calm.exited).toBe(143)
      await stubborn.exited
      expect(stubborn.signalCode).toBe("SIGKILL")
      expect(waits).toEqual([5000])
      expect(runs.filter((r) => r[0] === "kill").map((r) => `${r[1]} ${r[2]}`)).toEqual([
        `-TERM ${calm.pid}`,
        `-TERM ${stubborn.pid}`,
        `-KILL ${stubborn.pid}`,
      ])
      expect(said.kept).toEqual([])
      expect(said.ended).toEqual([
        `orphan pid ${calm.pid} ended by TERM (age 02:13:07, its worktree ${gone} gone): bun ${gone}/scripts/calm.ts`,
        `orphan pid ${stubborn.pid} ended by KILL (age 02:13:07, its worktree ${gone} gone): bun ${gone}/scripts/stubborn.ts`,
      ])
    } finally {
      calm.kill("SIGKILL")
      stubborn.kill("SIGKILL")
    }
  })

  test("sends no KILL to a pid ps now lists with another command, as a reused pid would be", async () => {
    const runs: string[][] = []
    const run: Context["run"] = async (argv) => {
      runs.push(argv)
      if (argv.join(" ") === PS.join(" ")) return { code: 0, out: row(424242, 1, "/usr/bin/other") }
      return { code: 0, out: "" }
    }
    const found = orphansOf(
      procsOf(row(424242, 1, `bun ${gone}/x.ts`)),
      worktrees,
      existsSync,
      PID1,
      noneEnded,
    )
    const said = await endOrphans(found, run, async () => {})
    expect(runs.filter((r) => r[0] === "kill").map((r) => r[1])).toEqual(["-TERM"])
    expect(said.ended).toEqual([
      `orphan pid 424242 ended by TERM (age 02:13:07, its worktree ${gone} gone): bun ${gone}/x.ts`,
    ])
  })

  test("names a pid whose signals fail as kept, and asks nothing for none", async () => {
    const run: Context["run"] = async (argv) =>
      argv[0] === "kill"
        ? { code: 1, out: "kill: 424243: Operation not permitted" }
        : { code: 0, out: row(424243, 1, `bun ${gone}/x.ts`) }
    const found = orphansOf(
      procsOf(row(424243, 1, `bun ${gone}/x.ts`)),
      worktrees,
      existsSync,
      PID1,
      noneEnded,
    )
    expect(await endOrphans(found, run, async () => {})).toEqual({
      ended: [],
      kept: [
        `orphan pid 424243 kept: its KILL failed: kill: 424243: Operation not permitted (age 02:13:07, its worktree ${gone} gone): bun ${gone}/x.ts`,
      ],
    })
    const none: string[][] = []
    expect(
      await endOrphans(
        [],
        async (argv) => {
          none.push(argv)
          return { code: 0, out: "" }
        },
        async () => {},
      ),
    ).toEqual({ ended: [], kept: [] })
    expect(none).toEqual([])
  })
})
