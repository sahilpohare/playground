import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, machine, type Setup } from "./run-slot-fake"

// a check waits on its run's exit, so the timeout only catches a hang
setDefaultTimeout(60_000)

// how many of run-slot to run-slot-4 are held or open now, and what the run printed on stderr
const look = (m: ReturnType<typeof machine>) => {
  const run = Bun.spawnSync(["bash", SCRIPT, "slots"], { cwd: m.root, env: m.env() })
  return { err: run.stderr.toString(), slots: run.stdout.toString() }
}
const slots = (setup: Setup) => look(machine(setup)).slots
// slots at a load5 of 2, under load_line's cap, so a row reads the CPU gate alone and run-slot-2's load5 wait (issue 1403) stays open
const cpu = (setup: Setup) => slots({ load5: 2, ...setup })
// a machine whose cached reading is past its 10 s with `last` swap-ins a second, so its next look reads vm_stat again with that as the reading before
const after = (setup: Setup, last: number) => {
  const m = machine(setup)
  writeFileSync(join(m.ops, "run-slot.gauges"), `0 80 ${last} 120 3.50 -\n`)
  return m
}
// the fake vm_stat's last second now reads `n` swap-ins, and the cached reading is past its 10 s, so the next look reads it
const swapins = (m: ReturnType<typeof machine>, n: number) => {
  writeFileSync(
    join(m.bin, "vm_stat"),
    `#!/bin/bash\necho "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\necho "    free  swapins swapouts"\necho "  203349  4049933   116968"\necho "  194438  ${n}        0"\n`,
  )
  const path = join(m.ops, "run-slot.gauges")
  writeFileSync(path, readFileSync(path, "utf8").replace(/^\d+/, "0"))
}
// run-slot.runs.log's lanes lines
const lanes = (m: ReturnType<typeof machine>) => {
  const path = join(m.ops, "run-slot.runs.log")
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => / lanes /.test(line))
    : []
}

// 3 Nov: the factory's resting sessions hold load1 at 14 to 20 on 15 cores while the CPU sits 53 to 67% idle, so the old load1 lines (12 for the third and fourth slots, the cores for the second) left one lane open with 24 to 33 runs waiting
describe("slots 2 to 4 open on the CPU's idle share", () => {
  test("the 05:59Z sample opens all four: load1 18.6 and load5 19.0, over the old lines, with the CPU 52.9% idle", () => {
    expect(slots({ idle: 52.9, load1: 18.6, load5: 19.0 })).toBe("4\n")
  })

  test("at 40% idle all four open", () => {
    expect(slots({ idle: 40, load1: 18 })).toBe("4\n")
  })

  test("under 40% idle slots 2 to 4 shut, and a holder keeps each", () => {
    const m = machine({ idle: 39.9, load1: 2 })
    expect(look(m).slots).toBe("1\n")
    m.hold("run-slot-2", 2, "medium")
    m.hold("run-slot-3", 2, "medium")
    m.hold("run-slot-4", 2, "medium")
    expect(look(m).slots).toBe("4\n")
  })
})

// load1 64 after a burst of starts, 73 after a clone let through at load5 under 30, and 58 at 04:15Z on 3 Nov: a spike shuts the lanes however idle top found the CPU
describe("load1 at 45, the stop while run-slot.load1-max is absent, is a hard stop", () => {
  test("load1 at 45 shuts slots 2 to 4 at 80% idle", () => {
    expect(slots({ idle: 80, load1: 45 })).toBe("1\n")
  })

  test("load1 64 shuts them at 60% idle", () => {
    expect(slots({ idle: 60, load1: 64 })).toBe("1\n")
  })
})

// retro 36, 4 Nov: lanes 2 to 4 were shut 109 of 120 minutes at load1 30 or more with the CPU about half idle ("shut idle=60.94% load1=33.75" at 19:29:23Z), and heavy runs waited up to 122 minutes
// 5 Nov, 06:19 to 07:45Z: a 50% bar from load1 30 to 45 left the CPU at a median 48% idle, and 14 of its 30 CPU shuts read 40 to 49% idle
describe("from load1 30 up to 45 the CPU must be 40% idle", () => {
  test("idle 56% at load1 31 opens them", () => {
    expect(cpu({ idle: 56, load1: 31 })).toBe("4\n")
  })

  test("idle 50% at load1 44.9 opens them", () => {
    expect(cpu({ idle: 50, load1: 44.9 })).toBe("4\n")
  })

  test("idle 45% at load1 31 opens them", () => {
    expect(cpu({ idle: 45, load1: 31 })).toBe("4\n")
  })

  test("idle 40% at load1 44.9 opens them, and 39.9% at load1 30 shuts them", () => {
    expect(cpu({ idle: 40, load1: 44.9 })).toBe("4\n")
    expect(cpu({ idle: 39.9, load1: 30 })).toBe("1\n")
  })

  test("idle 56% at load1 31 with swap-ins at 100/s two readings in a row shuts them, as mem_ok reads it", () => {
    expect(look(after({ idle: 56, load1: 31, swapins: 100 }, 100)).slots).toBe("1\n")
  })

  // PG-704's 08:47Z reading on 3 Nov, its runs waiting on paging: 176M of this Mac's 24 GB unused, a free share under 1%, so mem_ok shuts it
  test("the 08:47Z reading shuts them through mem_ok: load1 31, 57% idle, 176M of memory unused", () => {
    expect(cpu({ free: 0, idle: 57, load1: 31 })).toBe("1\n")
  })

  test("the 10:39:51Z reading on 3 Nov shuts them: load1 31.53, 32.89% idle, swap-ins at 335/s", () => {
    expect(cpu({ idle: 32.89, load1: 31.53, swapins: 335 })).toBe("1\n")
  })

  test("4 Nov's 19:29:23Z reading opens them: load1 33.75, 60.94% idle, no swap-ins", () => {
    expect(cpu({ idle: 60.94, load1: 33.75, swapins: 0 })).toBe("4\n")
  })
})

describe("under load1 30 the CPU must be 40% idle", () => {
  test("load1 at 29 leaves them open", () => {
    expect(cpu({ idle: 80, load1: 29.9 })).toBe("4\n")
  })

  test("idle 45% at load1 29.9 opens them", () => {
    expect(cpu({ idle: 45, load1: 29.9 })).toBe("4\n")
  })
})

// spawn.sh's swapins() reads vm_stat's swap-ins a second, and a GLM session starts under 100/s
describe("memory shuts slots 2 to 4 as mem_ok reads it", () => {
  test("swap-ins at 100/s two readings in a row shut them, and one reading, or 99/s after 100/s, leaves them open", () => {
    expect(slots({ swapins: 100 })).toBe("4\n")
    expect(look(after({ swapins: 100 }, 100)).slots).toBe("1\n")
    expect(look(after({ swapins: 99 }, 100)).slots).toBe("4\n")
  })

  // 5 Nov, 06:19 to 07:45Z: 17 of the 24 memory shuts came at pressure 1 with 70 to 80% free, from one-second samples such as 128, 242 and 1116 between 0, 8, 20 and 44
  test("a reading of 128 swap-ins then one under 100 leave them open on both, and two in a row over 100 shut them with why=mem", async () => {
    const m = machine({ swapins: 128 })
    expect(look(m).slots).toBe("4\n")
    swapins(m, 44)
    expect(look(m).slots).toBe("4\n")
    const high = after({ idle: 80, load1: 18, swapins: 242 }, 128)
    expect(await high.runs("worker-x")).toBe(true)
    expect(lanes(high)).toEqual([
      expect.stringMatching(/ shut why=mem idle=80% load1=18\.00 free=80% pressure=1 swapins=242 /),
    ])
  })

  test("a free share under 40% shuts them, as does pressure over normal", () => {
    expect(slots({ free: 39 })).toBe("1\n")
    expect(slots({ pressure: 2 })).toBe("1\n")
  })
})

describe("the gauges", () => {
  test("an unread top keeps slots 2 to 4 open and says so once a run", () => {
    const m = machine()
    writeFileSync(join(m.bin, "top"), "#!/bin/bash\nexit 1\n")
    chmodSync(join(m.bin, "top"), 0o755)
    const { err, slots } = look(m)
    expect(slots).toBe("4\n")
    expect(
      err.match(
        /^run-slot\.sh: cannot read the CPU's idle share \(top -l 2 -n 0\), so the lanes go by the load and memory alone$/gm,
      ),
    ).toHaveLength(1)
  })

  // an idle share that reads - is a dark sensor, not a busy CPU (issue 1818)
  test("a top that prints no CPU usage line keeps them open", () => {
    const m = machine()
    writeFileSync(join(m.bin, "top"), "#!/bin/bash\necho no cpu usage reading\n")
    chmodSync(join(m.bin, "top"), 0o755)
    expect(look(m).slots).toBe("4\n")
  })

  // top's first sample reads since boot, so a top that prints it alone gives no idle share, rather than its 98%, which no longer counts as busy (issue 1818)
  test("a top that prints its first sample alone keeps them open", () => {
    const m = machine()
    writeFileSync(
      join(m.bin, "top"),
      '#!/bin/bash\necho "CPU usage: 1.00% user, 1.00% sys, 98.00% idle "\n',
    )
    chmodSync(join(m.bin, "top"), 0o755)
    expect(look(m).slots).toBe("4\n")
  })

  test("a run that said an unread top once leaves no marker behind", async () => {
    const m = machine()
    writeFileSync(join(m.bin, "top"), "#!/bin/bash\nexit 1\n")
    chmodSync(join(m.bin, "top"), 0o755)
    const tmp = join(m.root, "tmp")
    mkdirSync(tmp)
    expect(await m.runs("worker-x", { TMPDIR: tmp })).toBe(true)
    expect(readdirSync(tmp).filter((name) => name.startsWith("run-slot-mem-told"))).toEqual([])
  })

  test("an unread swap-in count shuts them too", () => {
    const m = machine()
    writeFileSync(join(m.bin, "vm_stat"), "#!/bin/bash\nexit 1\n")
    chmodSync(join(m.bin, "vm_stat"), 0o755)
    expect(look(m).slots).toBe("1\n")
  })

  // the first row counts since boot, so with the second sample missing no rate is read, rather than the boot count's 4 a second
  test("a vm_stat that prints its first sample alone shuts them", () => {
    const m = machine()
    writeFileSync(
      join(m.bin, "vm_stat"),
      '#!/bin/bash\necho "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\necho "    free  swapins swapouts"\necho "  203349        4        0"\n',
    )
    chmodSync(join(m.bin, "vm_stat"), 0o755)
    expect(look(m).slots).toBe("1\n")
  })

  test("the rate is the second sample's: 4,049,933 swap-ins since boot and none in the last second leave them open", () => {
    expect(slots({ swapins: 0 })).toBe("4\n")
  })

  test("every look within 10 s shares one top reading, as top's own sample", () => {
    const m = machine()
    look(m)
    look(m)
    expect(readFileSync(join(m.root, "top.log"), "utf8")).toBe("-l 2 -n 0\n")
  })

  test("a run's look records idle% and load1 in run-slot.runs.log when the lanes open and when they shut, and nothing while they stay", async () => {
    const m = machine({ idle: 52.9, load1: 18.6 })
    expect(await m.runs("worker-x")).toBe(true)
    expect(await m.runs("worker-x")).toBe(true)
    expect(lanes(m)).toEqual([
      expect.stringMatching(
        /^\S+Z lanes worker-x \d+ open idle=52\.9% load1=18\.60 free=80% pressure=1 swapins=0 disk0_tps=120 disk0_mbs=3\.50$/,
      ),
    ])
    writeFileSync(
      join(m.bin, "top"),
      '#!/bin/bash\necho "CPU usage: 1.00% user, 1.00% sys, 98.00% idle "\necho "CPU usage: 40.00% user, 30.00% sys, 30.00% idle "\n',
    )
    // a reading taken at the epoch is past its 10 s, so the next look reads top again
    writeFileSync(join(m.ops, "run-slot.gauges"), "0 52.9 0 120 3.50\n")
    expect(await m.runs("worker-x")).toBe(true)
    expect(lanes(m)).toHaveLength(2)
    expect(lanes(m)[1]).toMatch(
      / lanes worker-x \d+ shut why=cpu idle=30\.00% load1=18\.60 free=80% pressure=1 swapins=0 disk0_tps=120 disk0_mbs=3\.50$/,
    )
  })

  // a bound on disk load needs a day of disk readings first, so each lanes line carries disk0's, and the verdict reads none of them
  test("a lanes line carries disk0's transfers/s and MB/s, and a busy disk changes no verdict", async () => {
    const m = machine({ disk: [9000, 400], idle: 52.9, load1: 18.6 })
    expect(await m.runs("worker-x")).toBe(true)
    expect(lanes(m)).toEqual([
      expect.stringMatching(
        /^\S+Z lanes worker-x \d+ open idle=52\.9% load1=18\.60 free=80% pressure=1 swapins=0 disk0_tps=9000 disk0_mbs=400\.00$/,
      ),
    ])
    expect(slots({ disk: [9000, 400], idle: 52.9, load1: 18.6 })).toBe("4\n")
  })

  test("an unread iostat logs disk0 as -, and the lanes still open", async () => {
    const m = machine({ idle: 52.9, load1: 18.6 })
    writeFileSync(join(m.bin, "iostat"), "#!/bin/bash\nexit 1\n")
    expect(await m.runs("worker-x")).toBe(true)
    expect(lanes(m)).toEqual([
      expect.stringMatching(
        / open idle=52\.9% load1=18\.60 free=80% pressure=1 swapins=0 disk0_tps=- disk0_mbs=-$/,
      ),
    ])
  })

  // dispatcher, 5 Nov: retro 39 counted 19 shuts by the CPU, 12 by memory and 6 by load1, read from the gauges alone, so a shut line names its cause
  test.each([
    ["load1", { idle: 80, load1: 50 }, /shut why=load1 idle=80% load1=50\.00 free=80% pressure=1 /],
    ["cpu", { idle: 35, load1: 31 }, /shut why=cpu idle=35% load1=31\.00 free=80% pressure=1 /],
    [
      "mem",
      { free: 20, idle: 80, load1: 18 },
      /shut why=mem idle=80% load1=18\.00 free=20% pressure=1 /,
    ],
    [
      "mem",
      { idle: 80, load1: 18, pressure: 2 },
      /shut why=mem idle=80% load1=18\.00 free=80% pressure=2 /,
    ],
    [
      "cpu",
      { free: 20, idle: 35, load1: 31 },
      /shut why=cpu idle=35% load1=31\.00 free=20% pressure=1 /,
    ],
  ] as const)(
    "a shut lanes line names why=%s, the first gauge that shut it",
    async (_why, setup, line) => {
      const m = machine(setup)
      expect(await m.runs("worker-x")).toBe(true)
      expect(lanes(m)).toEqual([expect.stringMatching(line)])
    },
  )

  test("an unread top keeps them open, its lanes line naming the dark idle", async () => {
    const m = machine({ idle: 80, load1: 18 })
    writeFileSync(join(m.bin, "top"), "#!/bin/bash\nexit 1\n")
    expect(await m.runs("worker-x")).toBe(true)
    expect(lanes(m)).toEqual([expect.stringMatching(/ open idle=-% load1=18\.00 /)])
  })

  test("a read subcommand records no lanes line", () => {
    const m = machine()
    look(m)
    expect(lanes(m)).toEqual([])
  })
})

// each switch closes what it closed before the gauges changed
describe("the ops switches work as before", () => {
  test("run-slot.3-off closes the third, and run-slot.4-off the fourth", () => {
    expect(slots({ off: ["run-slot.3-off"] })).toBe("3\n")
    expect(slots({ off: ["run-slot.4-off"] })).toBe("3\n")
  })

  test("run-slot.single leaves run-slot-2 alone open, under load5 22 with memory passing", () => {
    expect(slots({ load1: 21, off: ["run-slot.single"] })).toBe("2\n")
    expect(slots({ load1: 22, off: ["run-slot.single"] })).toBe("1\n")
  })

  test("run-slot.load5-cap lowers single-slot mode's load5 line", () => {
    const capped = (load1: number) => {
      const m = machine({ load1, off: ["run-slot.single"] })
      writeFileSync(join(m.ops, "run-slot.load5-cap"), "12\n")
      return look(m).slots
    }
    expect(capped(11)).toBe("2\n")
    expect(capped(12)).toBe("1\n")
  })
})
