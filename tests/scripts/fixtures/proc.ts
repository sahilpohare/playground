import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// /proc's text in the Linux kernel's own formats (Documentation/filesystems/proc.rst and accounting/psi.rst), for the machine readings' Linux branch on a Mac: a test writes it with procDir, points PLAYGROUND_PROC at the folder under the test sandbox (TEST_SANDBOX_HOME), and leaves the macOS command each reading takes first unread.
export type Proc = {
  // /proc/stat's btime, the boot in seconds since the epoch
  boot?: number
  // the cpu<n> lines in /proc/stat
  cores?: number
  // the first whole disk's reads and writes completed between the two /proc/diskstats reads
  diskIos?: number
  // the first whole disk's MB (of 1,048,576 bytes) read and written between the two /proc/diskstats reads
  diskMB?: number
  // MemAvailable's share of MemTotal, in percent
  free?: number
  // PSI's full avg10 for memory, in percent
  full?: number
  // the CPU's idle share between the two /proc/stat reads, in percent
  idle?: number
  load1?: number
  load5?: number
  // PSI's some avg10 for memory, in percent
  some?: number
  // pswpin's rise between each two /proc/vmstat reads, or each read's own rise in turn
  swapins?: number | number[]
  // SwapTotal less SwapFree, in MB
  swapUsedMB?: number
}

const TOTAL_KB = 128 * 1024 * 1024
const PSWPIN = 4_049_933

// Each file's first read, as the kernel prints it.
const cpus = (cores: number) =>
  Array.from({ length: cores }, (_, n) => `cpu${n} 5000 10 2500 42500 50 0 15 0 0 0\n`).join("")

const BOOT = 1_763_100_000

// /proc/diskstats with a loop device and a partition ahead of the whole disk, each busy, so a reader that takes either first reads the wrong figures; the disk's reads (field 4), sectors read (6), writes (8) and sectors written (10) grow by ios and MB, half each way.
const diskstats = (ios: number, mb: number) => {
  const reads = 88_987 + Math.floor(ios / 2)
  const writes = 3_584_993 + Math.ceil(ios / 2)
  const sectorsRead = 6_078_266 + mb * 1024
  const sectorsWritten = 306_940_476 + mb * 1024
  return [
    `   7       0 loop0 ${14 + 2 * ios} 0 ${34 + mb * 4096} 0 0 0 0 0 0 0 0 0 0 0 0 0 0`,
    ` 259       1 nvme0n1p1 ${341 + 3 * ios} 473 ${14360 + mb * 6144} 46 2 0 2 0 0 9 46 0 0 0 0 0 0`,
    ` 259       0 nvme0n1 ${reads} 11889 ${sectorsRead} 24070 ${writes} 14033180 ${sectorsWritten} 15388858 0 1049043 15601998 0 0 0 0 297432 189069`,
    "",
  ].join("\n")
}

// /sys/class/block's links for diskstats' three devices, as the kernel makes them: loop0 under devices/virtual, nvme0n1 a PCI device, nvme0n1p1 inside it with a partition file.
const NVME = "devices/pci0004:00/0004:00:00.0/0004:01:00.0/nvme/nvme0/nvme0n1"
const SYS_BLOCK: Record<string, string> = {
  loop0: "devices/virtual/block/loop0",
  nvme0n1: NVME,
  nvme0n1p1: `${NVME}/nvme0n1p1`,
}

export const procText = ({
  boot = BOOT,
  cores = 20,
  free = 50,
  full = 0,
  load1 = 1.25,
  load5 = 2.5,
  some = 0,
  swapUsedMB = 0,
}: Proc = {}): Record<string, string> => ({
  diskstats: diskstats(0, 0),
  loadavg: `${load1.toFixed(2)} ${load5.toFixed(2)} 3.00 2/1834 99120\n`,
  meminfo: [
    `MemTotal:       ${TOTAL_KB} kB`,
    `MemFree:        ${Math.floor(TOTAL_KB / 10)} kB`,
    `MemAvailable:   ${Math.ceil((TOTAL_KB * free) / 100)} kB`,
    "Buffers:          482112 kB",
    "Cached:         40123456 kB",
    "SwapCached:            0 kB",
    "SwapTotal:      16777212 kB",
    `SwapFree:       ${16_777_212 - swapUsedMB * 1024} kB`,
    "",
  ].join("\n"),
  "pressure/memory": `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1200\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=300\n`,
  stat: `cpu  100000 200 50000 850000 1000 0 300 0 0 0\n${cpus(cores)}intr 123456\nctxt 7890123\nbtime ${boot}\nprocesses 99120\n`,
  vmstat: `nr_free_pages 3276800\npgpgin 123456\npswpin ${PSWPIN}\npswpout 116968\n`,
})

// The text the `step`th move of a file brings in: 1000 more jiffies of CPU at `idle`, `swapins` more pages swapped in (a list's `step`th rise, its last held past it), and `diskIos` more transfers of `diskMB` more MB, each step on from the last.
export const laterText = (
  { boot = BOOT, cores = 20, diskIos = 0, diskMB = 0, idle = 60, swapins = 0 }: Proc = {},
  step = 1,
): Record<string, string> => ({
  diskstats: diskstats(step * diskIos, step * diskMB),
  stat: `cpu  ${100000 + step * (1000 - Math.round(idle * 10))} 200 50000 ${850000 + step * Math.round(idle * 10)} 1000 0 300 0 0 0\n${cpus(cores)}btime ${boot}\n`,
  vmstat: `nr_free_pages 3276800\npgpgin 123456\npswpin ${PSWPIN + swappedIn(swapins, step)}\npswpout 116968\n`,
})

const swappedIn = (swapins: number | number[], step: number) =>
  Array.isArray(swapins)
    ? Array.from({ length: step }, (_, i) => swapins[Math.min(i, swapins.length - 1)]!).reduce(
        (a, b) => a + b,
        0,
      )
    : step * swapins

// A folder of /proc text for `proc`, with each name in `omit` left out, and its sys folder standing for /sys's block links (omit "sys" to leave it out). `later` lists the second reads in the order the readings take them, run-slot's gauges (stat, then vmstat with diskstats) first wherever spawn.sh reads its room: the fake sleep moves later/1's files in, then later/2's.
export const procDir = (proc: Proc = {}, omit: string[] = [], later: string[][] = []): string => {
  const dir = mkdtempSync(join(tmpdir(), "proc-"))
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  for (const [name, text] of Object.entries(procText(proc)))
    if (!omit.includes(name)) write(join(dir, name), text)
  if (!omit.includes("sys")) {
    mkdirSync(join(dir, "sys", "class", "block"), { recursive: true })
    for (const [name, device] of Object.entries(SYS_BLOCK)) {
      mkdirSync(join(dir, "sys", device), { recursive: true })
      symlinkSync(join("..", "..", device), join(dir, "sys", "class", "block", name))
    }
    write(join(dir, "sys", SYS_BLOCK.nvme0n1p1!, "partition"), "1\n")
  }
  const steps: Record<string, number> = {}
  later.forEach((names, i) => {
    for (const name of names) {
      steps[name] = (steps[name] ?? 0) + 1
      write(join(dir, "later", String(i + 1), name), laterText(proc, steps[name])[name]!)
    }
  })
  return dir
}

// A fake sleep for the bin folder a test puts first on PATH: it moves the next later/<n> folder's files over the /proc text, then sleeps as the real one does, so a two-read reading sees the second text.
export const FAKE_SLEEP = `#!/bin/bash
if [ -n "$PLAYGROUND_PROC" ]; then
  for d in "$PLAYGROUND_PROC"/later/*/; do
    [ -d "$d" ] || break
    mv "$d"* "$PLAYGROUND_PROC"/ && rmdir "$d"
    break
  done
fi
exec /bin/sleep "$@"
`

// /proc/<pid>/stat as the kernel prints it for a process started `ticks` clock ticks after boot (field 22), its command holding a space and a ")", as a command may, so a reader must count the fields past the last ")".
export const pidStat = (pid: number, ticks: string): string =>
  `${pid} (claude) x) S 1 ${pid} ${pid} 0 -1 4194304 107 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 19529728 380 18446744073709551615 0 0 0\n`

// A folder of /proc text holding each pid's stat, its process started at the ticks given.
export const pidsDir = (starts: Record<number, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "proc-"))
  for (const [pid, ticks] of Object.entries(starts)) {
    mkdirSync(join(dir, pid), { recursive: true })
    writeFileSync(join(dir, pid, "stat"), pidStat(Number(pid), ticks))
  }
  return dir
}

// read's answer with PLAYGROUND_PROC at dir, which a reader takes under the test sandbox's marker, then PLAYGROUND_PROC put back.
export async function withProc<T>(dir: string, read: () => T | Promise<T>): Promise<T> {
  const saved = process.env.PLAYGROUND_PROC
  process.env.PLAYGROUND_PROC = dir
  try {
    return await read()
  } finally {
    if (saved === undefined) delete process.env.PLAYGROUND_PROC
    else process.env.PLAYGROUND_PROC = saved
  }
}
