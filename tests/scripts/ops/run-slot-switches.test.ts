import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { settingsFor } from "../../../packages/settings/src/settings"
import { slotSettings } from "../../../packages/settings/src/slots"
import { SCRIPT, machine, runSlot, set, stop } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

// optimizer, 19 Oct: in single-slot mode run-slot-2 opens at a 40% free share with pressure normal, not 50%
describe("run-slot-2 in single-slot mode", () => {
  const busy = (free: number) => {
    const m = machine({ free, off: ["run-slot.single"] })
    m.hold("run-slot", 1, "small")
    return m
  }

  test("opens at 40% free", async () => {
    expect(await busy(40).runs("worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })

  test("stays shut under 40% free", async () => {
    expect(await busy(39).waits("worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })
})

// retro 22: run-slot-2 shut by the load left the merge train's type check racing the queue for run-slot alone, and two 5/5 PRs sat about 55 min
describe("run-slot-2 with the lanes shut", () => {
  const busy = () => {
    const m = machine({ idle: 30 })
    m.hold("run-slot", 1, "small")
    return m
  }

  test("stays shut to an ordinary waiter", async () => {
    expect(await busy().waits("worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })

  for (const who of ["ops-dashboard", "ops-merge-train"]) {
    test(`opens to ${who}`, async () => {
      expect(await busy().runs(who, { RUN_SLOT_SIZE: "small" })).toBe(true)
    })
  }
})

// a hand-set runner-host/slot-off kept the runner box idle for two days, so a switch carries a reason and an expiry, and drops itself past it
describe("an ops switch carries a reason and an expiry", () => {
  const aside = (m: ReturnType<typeof machine>) =>
    readdirSync(m.ops).filter((f) => f.startsWith("run-slot.3-off.expired-"))
  const log = (m: ReturnType<typeof machine>) => {
    const path = join(m.ops, "run-slot.runs.log")
    return existsSync(path) ? readFileSync(path, "utf8") : ""
  }

  test("a set with no reason is refused and writes nothing", async () => {
    const m = machine()
    const r = await set(m, "ops", "3-off")
    expect(r.code).toBe(2)
    expect(r.err).toContain("--reason")
    expect(existsSync(join(m.ops, "run-slot.3-off"))).toBe(false)
  })

  test("a set writes who, when, an expiry 4 hours on and the reason, and the switch holds", async () => {
    const m = machine()
    expect((await set(m, "ops", "3-off", "--reason", "load5 24.79")).code).toBe(0)
    const [who, at, until, ...why] = readFileSync(join(m.ops, "run-slot.3-off"), "utf8")
      .trim()
      .split(" ")
    expect(who).toBe("ops")
    expect(Date.parse(until!) - Date.parse(at!)).toBe(4 * 3600_000)
    expect(why.join(" ")).toBe("load5 24.79")
    expect(await m.canTake("run-slot-3", "worker-x")).toBe(false)
  })

  test("--for sets the expiry, and a value goes on the line below", async () => {
    const m = machine()
    expect(
      (await set(m, "builder", "load5-cap", "12", "--for", "30m", "--reason", "cmux")).code,
    ).toBe(0)
    const [line, value] = readFileSync(join(m.ops, "run-slot.load5-cap"), "utf8").trim().split("\n")
    const [, at, until] = line!.split(" ")
    expect(Date.parse(until!) - Date.parse(at!)).toBe(30 * 60_000)
    expect(value).toBe("12")
  })

  test("--for 0m is refused", async () => {
    const m = machine()
    expect((await set(m, "ops", "3-off", "--for", "0m", "--reason", "x")).code).toBe(2)
    expect(existsSync(join(m.ops, "run-slot.3-off"))).toBe(false)
  })

  test("an expired switch is moved aside, logged, and holds no more", async () => {
    const m = machine()
    const line = "ops 2026-10-22T08:10:00Z 2026-10-22T12:10:00Z load5 24.79"
    writeFileSync(join(m.ops, "run-slot.3-off"), `${line}\n`)
    expect(await m.canTake("run-slot-3", "worker-x")).toBe(true)
    expect(existsSync(join(m.ops, "run-slot.3-off"))).toBe(false)
    expect(aside(m)).toHaveLength(1)
    expect(log(m)).toMatch(new RegExp(`Z expire worker-x \\d+ run-slot\\.3-off ${line}\\n`))
  })

  test("an old-shape file counts as set at its mtime: past 4 hours it drops, younger it holds", async () => {
    const m = machine({ off: ["run-slot.3-off"] })
    expect(await m.canTake("run-slot-3", "worker-x")).toBe(false)
    const at = Date.now() / 1000 - 4 * 3600 - 60
    utimesSync(join(m.ops, "run-slot.3-off"), at, at)
    expect(await m.canTake("run-slot-3", "worker-x")).toBe(true)
    expect(aside(m)).toHaveLength(1)
    expect(log(m)).toMatch(/Z expire worker-x \d+ run-slot\.3-off \n/)
  })
})

describe("a model-bound run", () => {
  // Starts argv through run-slot --model-bound in the background, reading its stderr as it comes
  const model = (m: ReturnType<typeof machine>, who: string, argv: string[]) => {
    const p = runSlot(["bash", SCRIPT, who, "--model-bound", "--", ...argv], {
      cwd: m.root,
      env: m.env(),
      stderr: "pipe",
      ops: m.ops,
    })
    let err = ""
    let ended = false
    void p.exited.then(() => (ended = true))
    void (async () => {
      const text = new TextDecoder()
      for await (const chunk of p.stderr) err += text.decode(chunk, { stream: true })
    })()
    const saw = async (re: RegExp) => {
      while (!ended && !re.test(err)) await Bun.sleep(20)
      return re.test(err)
    }
    return { p, saw }
  }

  test("takes a model-bound slot, so a run beside it still takes the one CPU slot free", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 2, "medium")
    const marker = join(m.root, "replaying")
    const replay = model(m, "worker-replay", ["bash", "-c", `touch ${marker}; sleep 30`])
    expect(await replay.saw(/holds run-slot-model-1\n/)).toBe(true)
    while (!existsSync(marker)) await Bun.sleep(20)
    expect(existsSync(join(m.ops, "run-slot-2"))).toBe(false)
    expect(readFileSync(join(m.ops, "run-slot-model-1.holder"), "utf8")).toMatch(
      new RegExp(`^worker-replay ${replay.p.pid} \\S+Z 0 model\\n$`),
    )
    expect(await m.runs("worker-suite", { RUN_SLOT_SIZE: "small" })).toBe(true)
    await stop(replay.p)
    expect(existsSync(join(m.ops, "run-slot-model-1"))).toBe(false)
  })

  test("waits while its default cap, slots.modelBound's 2, is held, with no extensions on the machine", async () => {
    const m = machine()
    m.hold("run-slot-model-1", 0, "model")
    m.hold("run-slot-model-2", 0, "model")
    const third = model(m, "worker-third", ["true"])
    expect(await third.saw(/waiting for one of the 2 model-bound slots\n/)).toBe(true)
    await stop(third.p)
    expect(slotSettings.get(settingsFor([], "me"), "slots.modelBound")).toBe(2)
  })

  test("takes its cap from the settings reader", async () => {
    const m = machine()
    writeFileSync(
      join(m.bin, "bun"),
      `#!/bin/bash\necho "$*" >> ${join(m.root, "bun.log")}\n[ "$2" = slots.modelBound ] && echo 1\n`,
    )
    chmodSync(join(m.bin, "bun"), 0o755)
    m.hold("run-slot-model-1", 0, "model")
    const second = model(m, "worker-second", ["true"])
    expect(await second.saw(/waiting for one of the 1 model-bound slots\n/)).toBe(true)
    await stop(second.p)
    expect(readFileSync(join(m.root, "bun.log"), "utf8")).toMatch(
      /\/packages\/scripts\/src\/playground\/setting\.ts slots\.modelBound\n/,
    )
  })

  test("clear-stale clears a model-bound slot whose holder died", async () => {
    const m = machine()
    const gone = Bun.spawn(["true"])
    await gone.exited
    mkdirSync(join(m.ops, "run-slot-model-1"))
    writeFileSync(
      join(m.ops, "run-slot-model-1.holder"),
      `worker-gone ${gone.pid} 2026-10-29T00:00:00Z 0 model\n`,
    )
    const p = runSlot(["bash", SCRIPT, "clear-stale"], {
      env: m.env(),
      stdout: "pipe",
      ops: m.ops,
    })
    expect(await new Response(p.stdout).text()).toContain(
      "run-slot-model-1: cleared a stale holder",
    )
    expect(existsSync(join(m.ops, "run-slot-model-1"))).toBe(false)
  })
})

// 31 Oct: a suite's `bun test --isolate` worker outlived its suite by 5 hours at 50% CPU, reparented to launchd once the suite's own process exited
// review round 1: a run stopped by a signal logged no end, so ran_short never saw it run long and kept its line on the quick slot
test("a run stopped by TERM logs its end with rc=143 and how long it ran", async () => {
  const m = machine()
  // the command touches the marker, its $0, once it runs, so TERM lands while run-slot waits on it
  const run = m.start("worker-t", { RUN_SLOT_SIZE: "small" }, SCRIPT, [
    "bash",
    "-c",
    'touch "$0"; sleep 30',
  ])
  while (!existsSync(run.marker)) await Bun.sleep(20)
  run.p.kill("SIGTERM")
  await run.p.exited
  const end = readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
    .split("\n")
    .find((l) => l.split(" ")[1] === "end" && l.split(" ")[2] === "worker-t")
  expect(end).toMatch(/ rc=143 ran=\d+s$/)
})

describe("what the command leaves in its process group", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // Runs, through run-slot from a calling bash, a command that starts a loop in the background, writes its pid and exits 7; `trap` set to ignore TERM in the loop makes it need the KILL. Returns the caller's stdout, the run's code, the loop's pid and the runs log.
  const leaves = async (trap = "") => {
    const m = machine()
    const pidFile = join(m.root, "loop.pid")
    const loop = `${trap}while :; do sleep 0.2; done`
    // the loop's output goes to /dev/null, so a loop left behind never holds the caller's stdout open; the command exits only once the loop has exec'd, since until then the fork still carries this command line (its pid file's path) and the reap logs that one (#592: a loaded CI run did)
    const command = `bash -c '${loop}' >/dev/null 2>&1 & echo $! > ${pidFile}; while ps -p $! -o command= | grep -qF ${pidFile}; do sleep 0.05; done; exit 7`
    const p = runSlot(
      [
        "bash",
        "-c",
        '"$@"; echo "caller-alive $?"',
        "bash",
        "bash",
        SCRIPT,
        "worker-x",
        "--",
        "bash",
        "-c",
        command,
      ],
      { cwd: m.root, env: m.env(), stdout: "pipe", ops: m.ops },
    )
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    const pid = Number(readFileSync(pidFile, "utf8"))
    // read at once after run-slot has ended, so a loop it left reads alive
    const left = alive(pid)
    // the test started the loop, so a loop left alive is stopped by its own pid at once, before that pid could pass to another process
    if (left) process.kill(pid, "SIGKILL")
    return { code, left, log: readFileSync(join(m.ops, "run-slot.runs.log"), "utf8"), out, pid }
  }

  test("is stopped once the command exits, and logged by pid with its command line", async () => {
    const r = await leaves()
    expect(r.left).toBe(false)
    expect(r.log).toMatch(
      new RegExp(`reap worker-x \\d+ pid=${r.pid} bash -c while :; do sleep 0\\.2; done`),
    )
  })

  test("that ignores TERM, by KILL after the grace", async () => {
    const r = await leaves('trap "" TERM; ')
    expect(r.left).toBe(false)
  })

  test("while run-slot's caller lives on and the command's own exit code comes back", async () => {
    const r = await leaves()
    expect(r.out).toBe("caller-alive 7\n")
    expect(r.code).toBe(0)
  })
})

describe("box-off", () => {
  // run-slot.sh box-off's words for a scratch state folder, the ssh key at a path of its own
  const boxOff = async (m: ReturnType<typeof machine>, key?: string) => {
    const p = runSlot(["bash", SCRIPT, "box-off"], {
      env: m.env(key ? { RUNNER_HOST_KEY: key } : {}),
      stdout: "pipe",
      ops: m.ops,
    })
    expect(await p.exited).toBe(0)
    return (await new Response(p.stdout).text()).split("\n").filter(Boolean)
  }

  test("names each precondition of the runner-box route that fails, and nothing once every one holds (#129)", async () => {
    const m = machine()
    const key = join(m.ops, "a-key")
    expect(await boxOff(m, key)).toEqual(["no-ci-sh", "no-host", "no-ssh-key"])
    mkdirSync(join(m.ops, "runner-host"))
    writeFileSync(join(m.ops, "runner-host", "ci.sh"), "#!/bin/bash\n")
    chmodSync(join(m.ops, "runner-host", "ci.sh"), 0o755)
    writeFileSync(join(m.ops, "runner-host", "ip"), "10.0.0.2\n")
    writeFileSync(key, "")
    expect(await boxOff(m, key)).toEqual([])
    writeFileSync(join(m.ops, "runner-host", "off"), "")
    expect(await boxOff(m, key)).toEqual(["runner-host-off"])
    rmSync(join(m.ops, "runner-host", "off"))
    writeFileSync(join(m.ops, "runner-host", "slot-off"), "")
    expect(await boxOff(m, key)).toEqual(["slot-off"])
  })

  test("reads the key from runner-host/key when RUNNER_HOST_KEY is unset (#2529)", async () => {
    const m = machine()
    mkdirSync(join(m.ops, "runner-host"))
    writeFileSync(join(m.ops, "runner-host", "ci.sh"), "#!/bin/bash\n")
    chmodSync(join(m.ops, "runner-host", "ci.sh"), 0o755)
    writeFileSync(join(m.ops, "runner-host", "ip"), "10.0.0.2\n")
    const key = join(m.ops, "peer-key")
    writeFileSync(join(m.ops, "runner-host", "key"), key)
    expect(await boxOff(m)).toEqual(["no-ssh-key"])
    writeFileSync(key, "")
    expect(await boxOff(m)).toEqual([])
  })
})
