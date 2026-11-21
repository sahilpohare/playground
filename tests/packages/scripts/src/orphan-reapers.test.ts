import { expect, test } from "bun:test"

import { orphanReapers, reapersOf, rowsOf } from "../../../../packages/scripts/src/orphan-reapers"

// #2350: on Linux under systemd --user an orphan goes to that subreaper, not pid 1, so endChildren's orphan guard read every one as another's and left the fixture's loop running.
test("an orphan of this run is adopted by one of orphanReapers()", async () => {
  const p = Bun.spawn(["bash", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { stdout: "pipe" })
  const orphan = Number((await new Response(p.stdout).text()).trim())
  await p.exited
  try {
    const ppid = Number(
      Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(orphan)])
        .stdout.toString()
        .trim(),
    )
    expect(orphanReapers().has(ppid)).toBe(true)
  } finally {
    process.kill(orphan, "SIGKILL")
  }
})

// #2402: a Linux desktop session's tree, as ps lists it: the user manager adopts its orphans, while the shell and the launcher between it and this process adopt none.
const TREE = rowsOf(
  [
    "    1     0 /sbin/init splash",
    " 1500     1 /usr/lib/systemd/systemd --user",
    " 1600     1 /usr/lib/systemd/systemd --user",
    " 2000  1500 /home/me/.playground/bin/herdr server",
    " 2100  2000 /bin/zsh",
    " 2200  2100 bun ops-tick.ts",
  ].join("\n"),
)

test("reapersOf takes pid 1 and the user manager above this process, never a shell or launcher between", () => {
  expect([...reapersOf(TREE, 2200)].sort((a, b) => a - b)).toEqual([1, 1500])
})

test("reapersOf leaves out another user's manager, which is no ancestor of this process", () => {
  expect(reapersOf(TREE, 2200).has(1600)).toBe(false)
})

test("reapersOf on a Mac, with no user manager, is pid 1 alone", () => {
  const mac = rowsOf(
    ["    1     0 /sbin/launchd", "  900     1 /bin/zsh", "  950   900 bun ops-tick.ts"].join("\n"),
  )
  expect([...reapersOf(mac, 950)]).toEqual([1])
})

test("reapersOf ends on a parent loop or a pid ps no longer lists", () => {
  expect([...reapersOf(rowsOf(" 10 11 a\n 11 10 b"), 10)]).toEqual([1])
  expect([...reapersOf(TREE, 9999)]).toEqual([1])
})
