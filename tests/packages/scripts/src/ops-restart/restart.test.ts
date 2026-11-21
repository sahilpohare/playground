import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { restart } from "../../../../../packages/scripts/src/ops-restart/restart"
import { userSystemctl } from "../../../../../packages/scripts/src/user-systemctl"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

const put = (root: string, path: string, text = "") => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

// A checkout holding each job's entry and what it imports, a folder of links into it (as ~/.playground/ops/checks/ holds), an ops folder with jobs.json and a heartbeat per job, and a stubbed run: every argv recorded, git diff answering the move's files, ps each live pid's command line and kill ending the pid unless it is stubborn.
const world = (changed: string[], live: Record<number, string> = {}, stubborn: number[] = []) => {
  const co = temp("ops-restart-co-")
  put(
    co,
    "packages/scripts/src/ops-sweep/cli.ts",
    'import { db } from "@packages/db"\nimport { writeAtomic } from "../write-atomic"\nwriteAtomic(db)\n',
  )
  put(co, "packages/scripts/src/write-atomic.ts", "export const writeAtomic = () => {}\n")
  put(
    co,
    "packages/scripts/src/ops-tick/cli.ts",
    'import { kindOf } from "@packages/config/kinds"\nimport "./tick"\nkindOf()\n',
  )
  put(co, "packages/scripts/src/ops-tick/tick.ts")
  put(
    co,
    "packages/scripts/src/ops-herdr/cli.ts",
    'import { org } from "@packages/config/org"\norg()\n',
  )
  put(co, "scripts/ops/unstick/run.py", "import os, sys\nfrom beat import beat\n")
  put(co, "scripts/ops/beat.py")
  put(co, "scripts/ops/paused/run.py")
  put(co, "scripts/ops/dashboard/run.sh")
  put(co, "scripts/ops/checks/go.py", "from outside import listed\n")
  put(co, "scripts/ops/checks/outside.py")
  const links = temp("ops-restart-links-")
  symlinkSync(`${co}/scripts/ops/checks/go.py`, join(links, "go.py"))
  put(
    co,
    "packages/db/package.json",
    JSON.stringify({ dependencies: { "@packages/env": "workspace:*" } }),
  )
  const ops = temp("ops-restart-ops-")
  const entry = {
    checks: join(links, "go.py"),
    dashboard: `${co}/scripts/ops/dashboard/run.sh`,
    herdr: `${co}/packages/scripts/src/ops-herdr/cli.ts`,
    paused: `${co}/scripts/ops/paused/run.py`,
    sweep: `${co}/packages/scripts/src/ops-sweep/cli.ts`,
    tick: `${co}/packages/scripts/src/ops-tick/cli.ts`,
    unstick: `${co}/scripts/ops/unstick/run.py`,
  }
  const jobs = [
    {
      command: `python3 -I ${entry.checks}`,
      heartbeat: "ops-checks-go",
      name: "ops-checks-go",
      runtime: "herdr",
    },
    {
      command: "python3 -I ~/.playground/ops/changelog/run.py",
      heartbeat: "ops-changelog",
      name: "ops-changelog",
      runtime: "herdr",
    },
    {
      command: entry.dashboard,
      heartbeat: "ops-dashboard",
      name: "ops-dashboard",
      runtime: "herdr",
      stop: "dashboard",
    },
    { heartbeat: "ops-herdr", launchd: "com.playground.ops-herdr", name: "ops-herdr" },
    {
      command: `python3 -I ${entry.paused}`,
      disabled: true,
      heartbeat: "ops-paused",
      name: "ops-paused",
      runtime: "herdr",
    },
    {
      command: `bun --no-env-file ${entry.sweep} no-headroom`,
      heartbeat: "ops-sweep",
      name: "ops-sweep",
      runtime: "herdr",
    },
    { heartbeat: "ops-tick", launchd: "com.playground.ops-tick", name: "ops-tick" },
    {
      command: `python3 -I ${entry.unstick}`,
      heartbeat: "ops-unstick",
      name: "ops-unstick",
      runtime: "herdr",
    },
  ]
  writeFileSync(join(ops, "jobs.json"), JSON.stringify({ jobs }))
  const pids: Record<string, number> = {
    "ops-changelog": 100,
    "ops-checks-go": 107,
    "ops-dashboard": 106,
    "ops-herdr": 105,
    "ops-paused": 103,
    "ops-sweep": 101,
    "ops-tick": 104,
    "ops-unstick": 102,
  }
  for (const [name, pid] of Object.entries(pids))
    writeFileSync(join(ops, `${name}.json`), JSON.stringify({ job: name, pid }))
  const procs: Record<number, string> = {
    100: "python3 -I /Users/x/.playground/ops/changelog/run.py",
    101: `bun --no-env-file ${entry.sweep} no-headroom`,
    102: `Python -I ${entry.unstick}`,
    103: `Python -I ${entry.paused}`,
    104: `/Users/x/.bun/bin/bun --no-env-file ${entry.tick}`,
    105: `/Users/x/.bun/bin/bun --no-env-file ${entry.herdr} run`,
    106: `bash ${entry.dashboard}`,
    107: `Python -I ${entry.checks}`,
    ...live,
  }
  const plists: Record<string, string[]> = {
    "com.playground.ops-herdr": ["/Users/x/.bun/bin/bun", "--no-env-file", entry.herdr, "run"],
    "com.playground.ops-tick": ["/Users/x/.bun/bin/bun", "--no-env-file", entry.tick],
  }
  const runs: string[][] = []
  const run = async (argv: string[]) => {
    runs.push(argv)
    if (argv[0] === "git") return { code: 0, out: changed.map((f) => `${f}\n`).join("") }
    if (argv[0] === "plutil") {
      const label = Object.keys(plists).find((l) => argv.some((a) => a.endsWith(`/${l}.plist`)))
      return label
        ? { code: 0, out: JSON.stringify({ ProgramArguments: plists[label] }) }
        : { code: 1, out: "" }
    }
    if (argv.includes("systemctl")) {
      const label = Object.keys(plists).find((l) => argv.at(-1) === `${l}.service`)
      return label
        ? {
            code: 0,
            out: `{ path=${plists[label]![0]} ; argv[]=${plists[label]!.join(" ")} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`,
          }
        : { code: 1, out: "" }
    }
    if (argv[0] === "ps") {
      const cmd = procs[Number(argv.at(-1))]
      return cmd ? { code: 0, out: `${cmd}\n` } : { code: 1, out: "" }
    }
    if (argv[0] === "kill" && !stubborn.includes(Number(argv.at(-1))))
      delete procs[Number(argv.at(-1))]
    return { code: 0, out: "" }
  }
  const kills = () => runs.filter((a) => a[0] === "kill").map((a) => a.join(" "))
  const ups = () => runs.filter((a) => a.some((w) => w.endsWith("/scripts/ops/up.py")))
  const pass = (platform: NodeJS.Platform = "darwin") =>
    restart({ checkout: co, from: "a1", ops, platform, run, sleep: async () => {}, to: "b2" })
  return { co, kills, ops, pass, runs, ups }
}

describe("restart", () => {
  test("a move changing one job's source restarts that job alone, then starts it again through up.py", async () => {
    const w = world(["packages/scripts/src/write-atomic.ts"])
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 101"])
    expect(w.ups()).toEqual([
      ["python3", "-I", `${w.co}/scripts/ops/up.py`, "--restarted", "ops-sweep"],
    ])
    expect(w.runs.find((a) => a[0] === "git")).toEqual([
      "git",
      "-C",
      w.co,
      "diff",
      "--name-only",
      "a1",
      "b2",
    ])
  })

  test("an entry that starts with a shebang is still scanned for its imports", async () => {
    const w = world(["packages/scripts/src/write-atomic.ts"])
    put(
      w.co,
      "packages/scripts/src/ops-sweep/cli.ts",
      '#!/usr/bin/env bun\nimport { writeAtomic } from "../write-atomic"\nwriteAtomic()\n',
    )
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 101"])
  })

  test("a job whose source imports a shebang file lists that file's own imports", async () => {
    const w = world(["packages/scripts/src/beat.ts"])
    put(
      w.co,
      "packages/scripts/src/write-atomic.ts",
      '#!/usr/bin/env bun\nimport { beat } from "./beat"\nexport const writeAtomic = () => beat()\n',
    )
    put(w.co, "packages/scripts/src/beat.ts", "export const beat = () => {}\n")
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 101"])
  })

  test("a move changing nothing a job runs restarts none", async () => {
    const w = world([
      "README.md",
      "web/next/src/app/page.tsx",
      "packages/scripts/src/ops-flow/flow.ts",
    ])
    await w.pass()
    expect(w.kills()).toEqual([])
    expect(w.ups()).toEqual([])
  })

  test("ops-herdr and ops-dashboard are never picked, even when their own source changed", async () => {
    const w = world(["packages/scripts/src/ops-herdr/cli.ts", "scripts/ops/dashboard/run.sh"])
    await w.pass()
    expect(w.kills()).toEqual([])
    expect(w.ups()).toEqual([])
  })

  test("a paused job stays down", async () => {
    const w = world(["scripts/ops/paused/run.py"])
    await w.pass()
    expect(w.kills()).toEqual([])
    expect(w.ups()).toEqual([])
  })

  test("a shared module counts for each job importing it: a python sibling and a workspace package", async () => {
    const w = world(["scripts/ops/beat.py", "packages/config/src/kinds.ts"])
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 104", "kill -TERM 102"])
    expect(w.ups()).toEqual([
      ["python3", "-I", `${w.co}/scripts/ops/up.py`, "--restarted", "ops-unstick"],
    ])
  })

  test("a launchd job alone is left to launchd to start again, with no up.py pass", async () => {
    const w = world(["packages/scripts/src/ops-tick/tick.ts"])
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 104"])
    expect(w.ups()).toEqual([])
  })

  // #2203: on Linux systemd holds the job, so its entry is read from the unit systemd loaded
  test("on Linux a launchd job's entry is read from its systemd unit's ExecStart, with no plutil", async () => {
    const w = world(["packages/scripts/src/ops-tick/tick.ts"])
    await w.pass("linux")
    expect(w.kills()).toEqual(["kill -TERM 104"])
    expect(w.ups()).toEqual([])
    expect(w.runs).toContainEqual(
      userSystemctl(["show", "--property=ExecStart", "--value", "com.playground.ops-tick.service"]),
    )
    expect(w.runs.some((argv) => argv[0] === "plutil")).toBe(false)
  })

  test("a heartbeat pid whose command line no longer holds the job's entry is left alone", async () => {
    const w = world(["packages/scripts/src/write-atomic.ts"], { 101: "/usr/bin/vim notes.md" })
    const lines = await w.pass()
    expect(w.kills()).toEqual([])
    expect(w.ups()).toEqual([])
    expect(lines.join("\n")).toContain("ops-sweep")
  })

  test("a pid still running after the wait is reported, and up.py is not run for it", async () => {
    const w = world(["packages/scripts/src/write-atomic.ts"], {}, [101])
    const lines = await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 101"])
    expect(w.ups()).toEqual([])
    expect(lines).toEqual(["ops-sweep: source changed, but pid 101 still runs after 60s"])
  })

  test("a workspace package counts with the workspace packages it depends on", async () => {
    const w = world(["packages/env/src/index.ts"])
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 101"])
  })

  test("a job whose entry is a link into the checkout restarts when its target's folder changed, and only then", async () => {
    const w = world(["scripts/ops/checks/outside.py"])
    await w.pass()
    expect(w.kills()).toEqual(["kill -TERM 107"])
    expect(w.ups()).toEqual([
      ["python3", "-I", `${w.co}/scripts/ops/up.py`, "--restarted", "ops-checks-go"],
    ])
    const elsewhere = world(["scripts/ops/README.md"])
    await elsewhere.pass()
    expect(elsewhere.kills()).toEqual([])
  })

  test("a job the new code turns on, running nowhere yet, gets one up.py pass after the settings render", async () => {
    const w = world(["packages/settings/src/jobs.ts"])
    const list = join(w.ops, "jobs.json")
    const { jobs } = JSON.parse(readFileSync(list, "utf8")) as { jobs: object[] }
    const usage = { command: "python3 -I run.py", heartbeat: "ops-usage", name: "ops-usage" }
    writeFileSync(list, JSON.stringify({ jobs: [...jobs, { ...usage, runtime: "herdr" }] }))
    const lines = await w.pass()
    expect(w.runs.find((a) => a.includes("render"))?.slice(-7)).toEqual([
      "render",
      "--data",
      dirname(w.ops),
      "--jobs",
      list,
      "--launch-agents",
      join(w.ops, "launch-agents"),
    ])
    expect(w.kills()).toEqual([])
    expect(w.ups()).toEqual([["python3", "-I", `${w.co}/scripts/ops/up.py`]])
    expect(lines.at(-1)).toStartWith("ops-usage: on, but not running; up.py exited 0")
  })

  test("a missing jobs.json restarts none, in one line", async () => {
    const w = world(["packages/scripts/src/write-atomic.ts"])
    rmSync(join(w.ops, "jobs.json"))
    expect(await w.pass()).toEqual([`no ${join(w.ops, "jobs.json")}, so no job to restart`])
    expect(w.kills()).toEqual([])
  })
})
