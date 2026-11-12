import { afterAll, describe, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { dataDir } from "../../../../../packages/env/src/data-dir"
import { MARKER } from "../../../../../packages/safe-delete/src"
import {
  runSpawn,
  SPAWN_LOCK,
  dispatcherOptions,
  startDispatcher,
  takeLock,
} from "../../../../../packages/scripts/src/playground/spawn"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-spawn-"))
  dirs.push(dir)
  return dir
}
const fake = (home: string, body: string): string => {
  const path = join(home, "spawn.sh")
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  return path
}

describe("runSpawn", () => {
  test("hands back a gate's refusal line with a non-zero exit", async () => {
    const home = scratch()
    const spawn = fake(
      home,
      'echo "spawn.sh refuses worker-otter: load 31.2 is at or over 30 (16 cores x 1.0)" >&2\necho "more" >&2\nexit 1',
    )
    const result = await runSpawn(
      spawn,
      ["worker", "worker-otter", "handoffs/new-worker.md"],
      join(home, "dispatcher"),
    )
    expect(result.code).toBe(1)
    expect(result.message).toBe(
      "spawn.sh refuses worker-otter: load 31.2 is at or over 30 (16 cores x 1.0)",
    )
    expect(existsSync(join(home, "dispatcher", SPAWN_LOCK))).toBe(false)
  })

  test("passes the argv to spawn.sh on a start", async () => {
    const home = scratch()
    const argv = join(home, "argv")
    const spawn = fake(home, `echo "$@" > ${argv}`)
    const result = await runSpawn(
      spawn,
      ["worker", "worker-otter", "b.md"],
      join(home, "dispatcher"),
    )
    expect(result).toEqual({ code: 0, message: "" })
    expect(readFileSync(argv, "utf8")).toBe("worker worker-otter b.md\n")
  })

  test("refuses while another start holds the lock, and never runs spawn.sh", async () => {
    const home = scratch()
    const acme = join(home, "dispatcher")
    mkdirSync(join(acme, SPAWN_LOCK), { recursive: true })
    writeFileSync(join(acme, SPAWN_LOCK, "pid"), String(process.pid))
    const marker = join(home, "ran")
    const spawn = fake(home, `touch ${marker}`)
    const result = await runSpawn(spawn, ["worker", "worker-otter", "b.md"], acme)
    expect(result.code).toBe(1)
    expect(result.message).toBe(
      `another start is running (pid ${process.pid}); try again once it ends`,
    )
    expect(existsSync(marker)).toBe(false)
  })
})

describe("runSpawn on the real spawn.sh", () => {
  const SPAWN = join(import.meta.dir, "..", "..", "..", "..", "..", "scripts", "spawn.sh")
  // The data folder as spawn.sh names it: under ~ when it sits in the home folder, else in full, as the suite's sandbox puts it.
  const data = dataDir()
  const shown = data.startsWith(`${homedir()}/`) ? `~${data.slice(homedir().length)}` : data

  test.each([
    ["a file outside ~/.playground", "/etc/hosts"],
    ["a sibling folder", join(homedir(), ".claude", "dispatcher-old", "b-x.md")],
    ["the folder itself", join(homedir(), ".playground")],
    ["a path with ..", "../x.md"],
  ])("hands back spawn.sh's brief rule for %s (#1546)", async (_, brief) => {
    const result = await runSpawn(
      SPAWN,
      ["worker", "worker-otter", brief, "--title", "Fix the CSV export"],
      scratch(),
    )
    expect(result).toEqual({
      code: 1,
      message: `spawn.sh refuses worker-otter: a brief is a file name under ${shown}`,
    })
  })
})

describe("takeLock", () => {
  test("a lock appears with its pid and makeScratch's marker inside, so a second take reads it as held, and its release removes it", () => {
    const acme = join(scratch(), "dispatcher")
    const first = takeLock(acme)
    expect(readFileSync(join(acme, SPAWN_LOCK, "pid"), "utf8")).toBe(String(process.pid))
    expect(existsSync(join(acme, SPAWN_LOCK, MARKER))).toBe(true)
    expect(takeLock(acme)).toEqual({ held: process.pid })
    expect(readdirSync(acme)).toEqual([SPAWN_LOCK])
    if ("release" in first) first.release()
    expect(readdirSync(acme)).toEqual([])
  })

  test("takes over a lock whose holder has gone", () => {
    const acme = join(scratch(), "dispatcher")
    mkdirSync(join(acme, SPAWN_LOCK), { recursive: true })
    writeFileSync(join(acme, SPAWN_LOCK, "pid"), "999999")
    writeFileSync(join(acme, SPAWN_LOCK, MARKER), "")
    const lock = takeLock(acme)
    expect("release" in lock).toBe(true)
    if ("release" in lock) lock.release()
    expect(readdirSync(acme)).toEqual([])
  })

  test("takes over an unmarked lock whose holder has gone, leaving it aside and logging why it stays (#545)", () => {
    const acme = join(scratch(), "dispatcher")
    mkdirSync(join(acme, SPAWN_LOCK), { recursive: true })
    writeFileSync(join(acme, SPAWN_LOCK, "pid"), "999999")
    const said = spyOn(console, "error").mockImplementation(() => {})
    try {
      const lock = takeLock(acme)
      expect("release" in lock).toBe(true)
      if ("release" in lock) lock.release()
      const left = readdirSync(acme)
      expect(left).toHaveLength(1)
      expect(left[0]).toStartWith(`${SPAWN_LOCK}.stale-`)
      expect(readFileSync(join(acme, left[0]!, "pid"), "utf8")).toBe("999999")
      expect(String(said.mock.calls[0]?.[0])).toContain(`has no ${MARKER} marker`)
    } finally {
      said.mockRestore()
    }
  })
})

describe("startDispatcher", () => {
  const setup = () => {
    const home = scratch()
    const template = join(home, "dispatcher.md")
    writeFileSync(template, "The standing brief.\n")
    const spawn = fake(home, `echo "$@" > "${home}/argv"`)
    return { data: join(home, "data"), home, spawn, template }
  }

  test("writes the brief once from the template, then runs spawn.sh manager with it", async () => {
    const { data, home, spawn, template } = setup()
    mkdirSync(data)
    expect(await startDispatcher({ data, live: [], name: "dispatcher", spawn, template })).toEqual({
      code: 0,
      message: "Started dispatcher",
    })
    expect(readFileSync(join(home, "argv"), "utf8")).toBe(
      "manager dispatcher brief-dispatcher.md\n",
    )
    expect(readFileSync(join(data, "brief-dispatcher.md"), "utf8")).toBe("The standing brief.\n")
    writeFileSync(join(data, "brief-dispatcher.md"), "The owner's own edit.\n")
    await startDispatcher({ data, live: [], name: "dispatcher", spawn, template })
    expect(readFileSync(join(data, "brief-dispatcher.md"), "utf8")).toBe("The owner's own edit.\n")
  })

  test("--harness codex reaches spawn.sh manager with --harness codex (#1835)", async () => {
    const { data, home, spawn, template } = setup()
    const started = await startDispatcher({
      data,
      harness: "codex",
      live: [],
      name: "dispatcher",
      spawn,
      template,
    })
    expect(started.code).toBe(0)
    expect(readFileSync(join(home, "argv"), "utf8")).toBe(
      "manager dispatcher brief-dispatcher.md --harness codex\n",
    )
  })

  test("--brief starts it from Switch's handoff, writing no brief from the template", async () => {
    const { data, home, spawn, template } = setup()
    const brief = "handoffs/dispatcher-switch.md"
    await startDispatcher({
      brief,
      data,
      harness: "codex",
      live: [],
      name: "dispatcher",
      spawn,
      template,
    })
    expect(readFileSync(join(home, "argv"), "utf8")).toBe(
      `manager dispatcher ${brief} --harness codex\n`,
    )
    expect(existsSync(join(data, "brief-dispatcher.md"))).toBe(false)
  })

  test("exits 3 and runs nothing while a session holds the name", async () => {
    const { data, home, spawn, template } = setup()
    expect(
      await startDispatcher({ data, live: ["dispatcher"], name: "dispatcher", spawn, template }),
    ).toEqual({ code: 3, message: "dispatcher is already running" })
    expect(existsSync(join(home, "argv"))).toBe(false)
  })

  test("exits 1 with spawn.sh's refusal line when it refuses", async () => {
    const { data, spawn: _, template } = setup()
    const home = scratch()
    const spawn = fake(home, 'echo "spawn.sh refuses dispatcher: a made-up gate" >&2; exit 4')
    expect(await startDispatcher({ data, live: [], name: "dispatcher", spawn, template })).toEqual({
      code: 1,
      message: "spawn.sh refuses dispatcher: a made-up gate",
    })
  })
})

describe("dispatcherOptions", () => {
  test("takes --harness and --brief, claude-code adding nothing", () => {
    expect(dispatcherOptions([])).toEqual({})
    expect(dispatcherOptions(["--harness", "claude-code"])).toEqual({})
    expect(dispatcherOptions(["--harness", "codex", "--brief", "handoffs/d-switch.md"])).toEqual({
      brief: "handoffs/d-switch.md",
      harness: "codex",
    })
  })

  test.each([
    [["--harness", "glm"]],
    [["--harness"]],
    [["--brief", "/etc/passwd"]],
    [["--brief", "../x.md"]],
    [["--model", "x"]],
  ])("refuses %p with its usage", (words) => {
    expect(dispatcherOptions(words)).toStartWith("usage: playground dispatcher")
  })
})
