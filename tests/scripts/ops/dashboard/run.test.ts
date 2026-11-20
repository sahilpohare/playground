import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..", "..", "..")
const script = await Bun.file(join(root, "scripts", "ops", "dashboard", "run.sh")).text()
const dashboardResult = script.match(/^dashboard_result\(\) \{.*\}$/m)?.[0]
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "dashboard-result-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const resultOf = async (line: string) => {
  await Bun.write(
    join(scratch, "results.log"),
    `2026-10-19T05:05:10Z START 4ef3c13a PASS verify=PASS\n${line}\n`,
  )
  const proc = Bun.spawn(["bash", "-c", `S=${scratch}\n${dashboardResult}\ndashboard_result`], {
    stdout: "pipe",
  })
  expect(await proc.exited).toBe(0)
  return (await new Response(proc.stdout).text()).trim()
}

describe("the dashboard's heartbeat result", () => {
  test("reads ok once a roll passes", async () => {
    expect(
      await resultOf("2026-10-19T05:05:10Z START 4ef3c13a PASS version=0.0.1-4ef3c13a verify=PASS"),
    ).toBe("ok")
  })

  test("reads ok while the dashboard is already on its branch's head", async () => {
    expect(await resultOf("2026-10-19T05:05:41Z CURRENT 4ef3c13a")).toBe("ok")
  })

  test("reads ok once a follower restart is healthy", async () => {
    expect(
      await resultOf("2026-10-19T05:05:41Z RESTART follower follower=running follower: running"),
    ).toBe("ok")
  })

  // the alias check's lines sit last in results.log between rolls, so its PASS reads ok and its FAIL reads as failing
  test("reads ok once the bare aliases hold the live ports again, and failing while one does not", async () => {
    expect(
      await resultOf(
        "2026-10-31T21:00:00Z ALIAS PASS playground.localhost and api.playground.localhost hold the live stack's ports 4842 and 4843",
      ),
    ).toBe("ok")
    expect(
      await resultOf(
        "2026-10-31T21:00:00Z ALIAS FAIL playground.localhost points at port 4851, but the live stack's desk.playground.localhost is on 4842",
      ),
    ).toStartWith("ALIAS FAIL playground.localhost points at port 4851")
  })

  test("reads ok once the follower's first start after first run's setup is healthy", async () => {
    expect(
      await resultOf("2026-10-19T05:05:41Z START follower follower=running follower: running"),
    ).toBe("ok")
  })

  test("names a follower restart that failed", async () => {
    expect(await resultOf("2026-10-19T05:05:41Z FAIL follower follower=down")).toBe(
      "FAIL follower follower=down",
    )
  })

  test("names a head held back after a failed roll", async () => {
    expect(
      await resultOf(
        "2026-10-19T05:05:41Z SKIP 1234567 FAIL 1234567 failed its roll before (bad-builds)",
      ),
    ).toBe("SKIP 1234567 FAIL 1234567 failed its roll before (bad-builds)")
  })
})

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe" })
    .stdout.toString()
    .trim()

describe("the dashboard's loop after a roll that changed its own code (#1330)", () => {
  test("stops its watch and execs the checkout's run.sh in its own pid, still found as ops-dashboard, even with this file rewritten under it", async () => {
    // ops-dashboard starts from the main checkout's copy (main) and runs in the dashboard's checkout (wt)
    const main = join(scratch, "main", "scripts", "ops", "dashboard")
    const mainRun = join(main, "run.sh")
    const wt = join(scratch, "wt")
    const beats = join(scratch, "beats")
    const watchPid = join(scratch, "watch-pid")
    const out = join(wt, "out")
    await Bun.write(mainRun, script)
    await Bun.write(
      join(main, "..", "beat.py"),
      `import os, sys\nopen(os.environ["BEATS"], "a").write(" ".join(sys.argv[1:]) + "\\n")\n`,
    )
    await Bun.write(join(main, "..", "notify.sh"), "#!/bin/sh\n")
    chmodSync(join(main, "..", "notify.sh"), 0o755)
    await Bun.write(
      join(main, "watch-stuck.py"),
      `import os, time\nopen(os.environ["WATCH_PID"], "w").write(str(os.getpid()))\ntime.sleep(60)\n`,
    )
    // the supervisor once run.sh's loop has beat: the roll rewrites the running run.sh, then hands on with 75
    await Bun.write(
      join(main, "supervisor.sh"),
      `while [ ! -s "$BEATS" ]; do sleep 0.1; done\nprintf 'echo rewritten\\n' > "${mainRun}"\nexit 75\n`,
    )
    // the checkout's run.sh: records its pid, then waits for the test
    await Bun.write(
      join(wt, "scripts", "ops", "dashboard", "run.sh"),
      `echo $$ > "${out}.tmp"; mv "${out}.tmp" "${out}"\nwhile [ ! -e done ]; do sleep 0.1; done\n`,
    )
    git(wt, "init", "-q")
    git(wt, "add", ".")
    git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c0")
    const proc = Bun.spawn(["bash", mainRun], {
      cwd: wt,
      env: {
        ...process.env,
        BEATS: beats,
        CLAUDE_CONFIG_DIR: scratch,
        PLAYGROUND_DATA_DIR: join(scratch, "playground"),
        WATCH_PID: watchPid,
      },
      stdout: "ignore",
    })
    let found = ""
    try {
      // fail named and bounded when the exec never writes the file; 30s is twice the measured healthy cost, the loop's 15s tick
      const deadline = Date.now() + 30_000
      while (!(await Bun.file(out).exists())) {
        if (Date.now() > deadline) throw new Error(`run.sh wrote no pid file at ${out} within 30s`)
        await Bun.sleep(100)
      }
      expect((await Bun.file(out).text()).trim()).toBe(String(proc.pid))
      // once.py's and up.py's own read of the job, from jobs.json's path to the main checkout's run.sh, in the data folder run.sh made
      await Bun.write(join(scratch, "playground", "ops", "ops-dashboard.pid"), `${proc.pid}\n`)
      found = Bun.spawnSync(
        [
          "python3",
          "-I",
          "-c",
          "import sys; sys.path.insert(0, sys.argv[1]); import once; print(once.running('ops-dashboard', once.marker_of(sys.argv[2])))",
          join(root, "scripts", "ops"),
          mainRun,
        ],
        {
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: scratch,
            PLAYGROUND_DATA_DIR: join(scratch, "playground"),
          },
          stdout: "pipe",
        },
      )
        .stdout.toString()
        .trim()
    } finally {
      await Bun.write(join(wt, "done"), "")
    }
    expect(await proc.exited).toBe(0)
    expect(found).toBe(String(proc.pid))
    expect(await Bun.file(beats).text()).toContain(
      `reloading ${git(wt, "rev-parse", "--short", "HEAD")}`,
    )
    const watch = Number(await Bun.file(watchPid).text())
    expect(() => process.kill(watch, 0)).toThrow()
  }, 40_000)
})
