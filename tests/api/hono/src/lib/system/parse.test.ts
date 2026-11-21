import { describe, expect, test } from "bun:test"

import {
  bytesOf,
  cpuSecondsOf,
  parseContainers,
  parseContainerStats,
  parseCwds,
  parseDockerHost,
  parseHolders,
  parsePeer,
  parsePs,
  parseSockets,
  parseSysctl,
  parseVmStat,
} from "../../../../../../api/hono/src/lib/system/parse"

const MIB = 1024 * 1024

describe("parseSysctl", () => {
  test("free share, pressure level and swap, by name in any order", () => {
    const out = [
      "vm.swapusage: total = 6144.00M  used = 4437.62M  free = 1706.38M  (encrypted)",
      "kern.memorystatus_level: 66",
      "kern.memorystatus_vm_pressure_level: 1",
    ].join("\n")
    expect(parseSysctl(out)).toEqual({
      freePercent: 66,
      pressure: "normal",
      swap: { totalBytes: 6144 * MIB, usedBytes: 4437.62 * MIB },
    })
  })

  test("levels 2 and 4 are warn and critical; anything unread is null", () => {
    expect(parseSysctl("kern.memorystatus_vm_pressure_level: 2").pressure).toBe("warn")
    expect(parseSysctl("kern.memorystatus_vm_pressure_level: 4").pressure).toBe("critical")
    expect(parseSysctl("kern.memorystatus_vm_pressure_level: 3").pressure).toBeNull()
    expect(parseSysctl("")).toEqual({ freePercent: null, pressure: null, swap: null })
    expect(parseSysctl("kern.memorystatus_level: 140").freePercent).toBeNull()
  })
})

describe("parseVmStat", () => {
  test("Memory Used as Activity Monitor adds it: app (anonymous less purgeable), wired, compressed", () => {
    const out = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                   147361.",
      "Pages purgeable:                                9075.",
      '"Translation faults":                    10626764199.',
      "Pages wired down:                             252951.",
      "Anonymous pages:                              536047.",
      "Pages occupied by compressor:                 249883.",
    ].join("\n")
    expect(parseVmStat(out)).toEqual({
      usedBytes: (536047 - 9075 + 252951 + 249883) * 16384,
    })
  })

  test("output missing a page count it needs is no reading", () => {
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)")).toBeNull()
    expect(parseVmStat("")).toBeNull()
  })
})

describe("cpuSecondsOf", () => {
  test("ps's minutes run past 59; hours and days come when present", () => {
    expect(cpuSecondsOf("0:00.43")).toBeCloseTo(0.43)
    expect(cpuSecondsOf("473:33.21")).toBeCloseTo(473 * 60 + 33.21)
    expect(cpuSecondsOf("1:02:03.50")).toBeCloseTo(3723.5)
    expect(cpuSecondsOf("2-01:00:00")).toBe(2 * 86_400 + 3600)
    expect(cpuSecondsOf("")).toBeNull()
    expect(cpuSecondsOf("abc")).toBeNull()
  })
})

describe("parsePs", () => {
  test("pid, parent, resident bytes and CPU seconds; a malformed line is passed over", () => {
    const out = ["  4313     1 1083632  57:40.70", "89017 88399 324592   1:02.00", "junk", ""].join(
      "\n",
    )
    expect(parsePs(out)).toEqual([
      { cpuSeconds: 57 * 60 + 40.7, pid: 4313, ppid: 1, rssBytes: 1083632 * 1024 },
      { cpuSeconds: 62, pid: 89017, ppid: 88399, rssBytes: 324592 * 1024 },
    ])
  })
})

describe("lsof", () => {
  test("parseCwds: each process's working directory", () => {
    const out =
      "p9919\nfcwd\nn/Users/you/dispatcher/.claude/worktrees/leads\np16065\nfcwd\nn/Users/you/dispatcher\n"
    expect([...parseCwds(out)]).toEqual([
      [9919, "/Users/you/dispatcher/.claude/worktrees/leads"],
      [16065, "/Users/you/dispatcher"],
    ])
  })

  test("parseSockets: listeners, and connections by the far end's port when it is on this machine", () => {
    const out = [
      "p85872",
      "f770",
      "n127.0.0.1:4623->127.0.0.1:60681",
      "f800",
      "n127.0.0.1:59532->127.0.0.1:65521",
      "f801",
      "n[::1]:59663->[::1]:443",
      "p89017",
      "f7",
      "n192.168.68.109:57580->160.79.104.10:443",
      "p49690",
      "f15",
      "n[::1]:443",
      "f16",
      "n127.0.0.1:443",
      "p9816",
      "f12",
      "n*:4319",
    ].join("\n")
    const { connects, listens } = parseSockets(out)
    expect([...listens].sort()).toEqual([49690, 9816])
    expect([...(connects.get(85872) ?? [])].sort()).toEqual([443, 60681, 65521])
    expect(connects.has(89017)).toBe(false)
  })

  test("parseHolders: the processes holding a file open", () => {
    expect(parseHolders("p4313\nf91\nf99\np12\n")).toEqual([4313, 12])
    expect(parseHolders("")).toEqual([])
  })
})

describe("docker", () => {
  test("parseDockerHost: a unix socket's path, else nothing", () => {
    expect(parseDockerHost('"unix:///Users/you/.orbstack/run/docker.sock"\n')).toBe(
      "/Users/you/.orbstack/run/docker.sock",
    )
    expect(parseDockerHost('"tcp://10.0.0.2:2375"')).toBeNull()
    expect(parseDockerHost("")).toBeNull()
  })

  test("parseContainers: each container's first name and the host ports it publishes, once each", () => {
    const out = [
      JSON.stringify({
        ID: "2fee49809174",
        Names: "playground-a-db",
        Ports: "127.0.0.1:33522->5432/tcp",
      }),
      JSON.stringify({
        ID: "cc114e930121",
        Names: "web,alias",
        Ports: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 9000/tcp",
      }),
      JSON.stringify({ ID: "", Names: "nameless" }),
      "not json",
    ].join("\n")
    expect(parseContainers(out)).toEqual([
      { id: "2fee49809174", name: "playground-a-db", ports: [33522] },
      { id: "cc114e930121", name: "web", ports: [8080] },
    ])
  })

  test("parseContainerStats: memory in use by short id, in docker's units", () => {
    const out = [
      JSON.stringify({ ID: "2fee49809174", MemUsage: "26.32MiB / 11.73GiB" }),
      JSON.stringify({ ID: "cc114e930121", MemUsage: "1.5GiB / 11.73GiB" }),
      JSON.stringify({ ID: "aaaaaaaaaaaa", MemUsage: "--" }),
    ].join("\n")
    expect([...parseContainerStats(out)]).toEqual([
      ["2fee49809174", 26.32 * MIB],
      ["cc114e930121", 1.5 * 1024 * MIB],
    ])
    expect(bytesOf("512kB")).toBe(512_000)
    expect(bytesOf("0B")).toBe(0)
    expect(bytesOf("12 parsecs")).toBeNull()
  })
})

describe("parsePeer", () => {
  // what `df -kP ~; cat /proc/loadavg /proc/meminfo /proc/stat` prints on a 4-core Linux machine, shortened
  const DF = [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/nvme0n1p2  3936872448 299186688 3637685760       8% /",
  ]
  const OUT = [
    ...DF,
    "0.01 0.07 0.06 1/794 1112766",
    "MemTotal:       127598704 kB",
    "MemFree:        100000000 kB",
    "MemAvailable:   123169288 kB",
    "SwapTotal:      16777212 kB",
    "SwapFree:       16777212 kB",
    "cpu  7990 1 16886 31958492 3496 0 313 0 0 0",
    "cpu0 1995 0 3498 7989093 269 0 295 0 0 0",
    "cpu1 2146 0 4822 7991464 257 0 15 0 0 0",
    "cpu2 2265 1 5068 7988971 2970 0 3 0 0 0",
    "cpu3 1584 0 3498 7988964 0 0 0 0 0 0",
    "intr 1 2 3",
  ].join("\n")

  test("reads the home's free and total size, the load, memory in use as free counts it, swap and one core per cpuN line", () => {
    expect(parsePeer(OUT)).toEqual({
      cores: 4,
      disk: { freeBytes: 3637685760 * 1024, totalBytes: 3936872448 * 1024 },
      load: [0.01, 0.07, 0.06],
      memory: { totalBytes: 127598704 * 1024, usedBytes: (127598704 - 123169288) * 1024 },
      swap: { totalBytes: 16777212 * 1024, usedBytes: 0 },
    })
  })

  test("a reading missing its load, memory or cores is no reading, never zeros; swap alone may be missing", () => {
    expect(parsePeer("")).toBeNull()
    expect(parsePeer(OUT.replace(/^MemAvailable.*$/m, ""))).toBeNull()
    expect(parsePeer(OUT.replace(/^cpu\d+ .*$/gm, ""))).toBeNull()
    expect(parsePeer(OUT.replace("0.01 0.07 0.06", "Permission denied"))).toBeNull()
    expect(parsePeer(OUT.replace(/^Swap.*$/gm, ""))?.swap).toBeNull()
  })

  test("a df that printed nothing leaves the disk out and keeps every other figure", () => {
    const withoutDf = parsePeer(OUT.replace(DF.join("\n"), ""))
    expect(withoutDf?.disk).toBeNull()
    expect(withoutDf).toMatchObject({ cores: 4, load: [0.01, 0.07, 0.06] })
  })
})
