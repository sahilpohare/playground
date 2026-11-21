import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ops = join(import.meta.dir, "..", "..", "..", "scripts", "ops")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "once-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const runningFor = (script: string) =>
  Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import once; print(once.running('ops-dashboard', once.marker_of(sys.argv[2])))",
      ops,
      script,
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

describe("once.py's read of a running job", () => {
  test("finds a holder running the job's folder from another checkout, and not one running another job's folder", async () => {
    const held = join(scratch, "dashboard-checkout", "scripts", "ops", "dashboard", "run.sh")
    await Bun.write(held, "sleep 30\n")
    const holder = Bun.spawn(["bash", held])
    try {
      await Bun.write(join(scratch, "playground", "ops", "ops-dashboard.pid"), `${holder.pid}\n`)
      expect(runningFor(join(scratch, "main", "scripts", "ops", "dashboard", "run.sh"))).toBe(
        String(holder.pid),
      )
      expect(runningFor(join(scratch, "main", "scripts", "ops", "fixture", "run.sh"))).toBe("None")
    } finally {
      holder.kill()
    }
  })
})

// a job's herdr pane closes the moment its job exits (measured on a scratch herdr server), so once.py keeps the job's last stderr line in ops/<job>.last for ops-up (PG-2878)
describe("once.py's last stderr line", () => {
  const data = join(scratch, "last")
  const opsDir = join(data, "ops")
  const once = (job: string, command: string) =>
    Bun.spawn(["python3", "-I", join(ops, "once.py"), job, command], {
      detached: true,
      env: { ...process.env, CLAUDE_CONFIG_DIR: scratch, PLAYGROUND_DATA_DIR: data },
      stderr: "pipe",
      stdout: "pipe",
    })
  // the reader file reads empty while a start holds it, so this waits for a pid, never signalling 0, the test's own group
  const readerPid = async (job: string) => {
    const read = () => {
      try {
        return Number(readFileSync(join(opsDir, `${job}.reader`), "utf8").trim())
      } catch {
        return 0
      }
    }
    for (let i = 0; i < 50 && !(read() > 0); i++) await Bun.sleep(100)
    const pid = read()
    if (!(pid > 0)) throw new Error(`${job}: no reader pid`)
    return pid
  }
  const groupOf = (pid: number) =>
    Number(
      Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
        .stdout.toString()
        .trim(),
    )
  // the job leads its own process group (detached), so an empty group is the reader gone, a check no reused pid can pass (.agents/testing.md)
  const groupAlive = (pgid: number) => {
    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }
  const gone = async (pgid: number) => {
    for (let i = 0; i < 50 && groupAlive(pgid); i++) await Bun.sleep(100)
    return !groupAlive(pgid)
  }

  test("a job that dies leaves its last non-empty stderr line, cut to 200 characters, in a 0600 file, its stderr file 0600 too and its stderr still reaching the pane", async () => {
    await Bun.write(join(opsDir, "keep"), "")
    writeFileSync(join(opsDir, "ops-t1.stderr"), "an older copy's stderr\n", { mode: 0o644 })
    const long = "x".repeat(300)
    const job = once(
      "ops-t1",
      `sh -c 'echo first >&2; echo "vault: cache unreadable: ${long}" >&2; echo >&2; exit 2'`,
    )
    expect(await job.exited).toBe(2)
    expect(await gone(job.pid)).toBe(true)
    const last = readFileSync(join(opsDir, "ops-t1.last"), "utf8")
    expect(last).toBe(`vault: cache unreadable: ${long}`.slice(0, 200))
    expect(statSync(join(opsDir, "ops-t1.last")).mode & 0o777).toBe(0o600)
    expect(statSync(join(opsDir, "ops-t1.stderr")).mode & 0o777).toBe(0o600)
    expect(await new Response(job.stderr).text()).toContain("vault: cache unreadable:")
  })

  // a herdr job leads its pty's session, so its exit hangs up the terminal's foreground group, the reader included (measured on the live jobs: ps reads the job's pid as its own pgid and tpgid)
  test("a job that leads its pty's session, as in a herdr pane, still leaves the line it wrote as it died, and its reader still ends", async () => {
    const driver = [
      "import os, sys",
      "pid, master = os.forkpty()",
      "if pid == 0: os.execvp('python3', ['python3', '-I'] + sys.argv[1:])",
      "print(pid, flush=True)",
      "while True:",
      "    try: b = os.read(master, 65536)",
      "    except OSError: break",
      "    if not b: break",
      "os.waitpid(pid, 0)",
    ].join("\n")
    const pane = Bun.spawn(
      [
        "python3",
        "-I",
        "-c",
        driver,
        join(ops, "once.py"),
        "ops-t6",
        "sh -c 'echo early-line >&2; sleep 1; echo DEATH-reason >&2; exit 3'",
      ],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: scratch, PLAYGROUND_DATA_DIR: data },
        stdout: "pipe",
      },
    )
    expect(await pane.exited).toBe(0)
    const leader = Number((await new Response(pane.stdout).text()).trim())
    const last = join(opsDir, "ops-t6.last")
    const read = () => (existsSync(last) ? readFileSync(last, "utf8") : "")
    for (let i = 0; i < 30 && read() !== "DEATH-reason"; i++) await Bun.sleep(100)
    expect(read()).toBe("DEATH-reason")
    expect(await gone(leader)).toBe(true)
  })

  test("the reader, by its own pid, ends once the job has, and never outlives it", async () => {
    const job = once("ops-t2", "sh -c 'sleep 1; echo bye >&2'")
    const reader = await readerPid("ops-t2")
    expect(groupOf(reader)).toBe(job.pid)
    expect(await job.exited).toBe(0)
    expect(await gone(job.pid)).toBe(true)
  })

  test("a reader that dies leaves the job running: its stderr writes neither block nor kill it", async () => {
    const job = once(
      "ops-t3",
      "sh -c 'sleep 1; i=0; while [ $i -lt 3000 ]; do echo line-$i >&2; i=$((i+1)); done; echo done'",
    )
    process.kill(await readerPid("ops-t3"), "SIGKILL")
    expect(await job.exited).toBe(0)
    expect(await new Response(job.stdout).text()).toBe("done\n")
  })

  test("the job's stderr file, a regular file the job appends to, is emptied past 1 MiB with no hole of NULs left behind, so a job that runs for weeks never fills the disk, while its lines still reach the pane", async () => {
    const job = once(
      "ops-t5",
      "sh -c 'yes 0123456789012345678901234567890123456789 | head -n 80000 >&2; sleep 1; echo last-of-many >&2; sleep 0.5'",
    )
    const pane = new Response(job.stderr).text()
    expect(await job.exited).toBe(0)
    expect(await gone(job.pid)).toBe(true)
    const file = readFileSync(join(opsDir, "ops-t5.stderr"), "latin1")
    expect(file.length).toBeLessThan(1 << 20)
    expect(file.includes("\0")).toBe(false)
    expect(file).toEndWith("last-of-many\n")
    expect(await pane).toEndWith("last-of-many\n")
    expect(readFileSync(join(opsDir, "ops-t5.last"), "utf8")).toBe("last-of-many")
  })

  test("a start drops the last copy's line, so a stale one never stands for this copy", async () => {
    await Bun.write(join(opsDir, "ops-t4.last"), "an old line from yesterday")
    const job = once("ops-t4", "sh -c 'exit 0'")
    expect(await job.exited).toBe(0)
    expect(await gone(job.pid)).toBe(true)
    expect(existsSync(join(opsDir, "ops-t4.last"))).toBe(false)
  })
})
