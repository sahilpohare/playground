import { describe, expect, test } from "bun:test"

import { sshLaunchOf, sshProcessOf } from "../../../../packages/config/src/ssh-probe"

const SID = "6aafeb8a-bce0-4ceb-92cf-97f92cece832"
const record = (exec: string, server = "# server: playground-probes\n") =>
  `#!/bin/bash\n# spawn.sh writes this at every herdr start and resume.\n${server}# account: a@b.c\n${exec}\n`

describe("sshLaunchOf", () => {
  test("an --ssh probe's resume record names its name, its server and its session", () => {
    const exec = `exec /x/scripts/spawn.sh resume rbwxpg-probe /x/playground ${SID} --account a@b.c --ssh u@10.0.0.2 --key /k/spark`
    expect(sshLaunchOf(record(exec))).toEqual({
      name: "rbwxpg-probe",
      server: "playground-probes",
      sessionId: SID,
    })
    // spawn.sh writes the exec line with %q, so a folder may hold an escaped space
    const spaced = `exec /x/scripts/spawn.sh resume p-probe /x/my\\ leads ${SID} --ssh u@h --key /k`
    expect(sshLaunchOf(record(spaced))?.sessionId).toBe(SID)
    // spawn.sh writes its own path with %q too, so a checkout under a folder with a space reads whole
    const checkout = `exec /Users/me/My\\ Code/playground/scripts/spawn.sh resume p1-probe /Users/me/My\\ Code/playground ${SID} --ssh me@far --key /k`
    expect(sshLaunchOf(record(checkout))).toEqual({
      name: "p1-probe",
      server: "playground-probes",
      sessionId: SID,
    })
    // a record with no server line ran on playground, as spawn.sh's restore reads it
    expect(sshLaunchOf(record(exec, ""))?.server).toBe("playground")
  })

  test("any other record names no launch", () => {
    expect(sshLaunchOf(record(`exec /x/scripts/spawn.sh resume w-worker /x ${SID}`))).toBeNull()
    expect(
      sshLaunchOf(record(`exec /x/scripts/spawn.sh resume p /x not-a-session --ssh u@h --key /k`)),
    ).toBeNull()
    // --ssh counts only as a flag after the session, never as part of an escaped folder name
    expect(
      sshLaunchOf(record(`exec /x/scripts/spawn.sh resume w-worker /x/a\\ --ssh\\ b ${SID}`)),
    ).toBeNull()
    expect(sshLaunchOf("")).toBeNull()
  })
})

describe("sshProcessOf", () => {
  const launch = { name: "rbwxpg-probe", server: "playground-probes", sessionId: SID }
  const ssh = { argv: ["ssh", "-i", "/k", "-tt", "u@10.0.0.2", "cd /x && claude"], pid: 7 }
  const pane = (label: string | null, ...argvs: string[][]) => ({
    label,
    processes: argvs.map((argv, i) => ({ argv, pid: i })),
  })

  test("a pane on the launch's server, under its name, running ssh in front, holds it", () => {
    expect(
      sshProcessOf(launch, "playground-probes", { label: launch.name, processes: [ssh] }),
    ).toBe(ssh)
    expect(
      sshProcessOf(launch, "playground-probes", pane(launch.name, ["/usr/bin/ssh", "u@h"])),
    ).toMatchObject({ pid: 0 })
  })

  test("a pane back at its shell, another server, another label or a word naming ssh holds none", () => {
    expect(sshProcessOf(launch, "playground-probes", pane(launch.name, ["bash"]))).toBeUndefined()
    expect(
      sshProcessOf(launch, "playground", { label: launch.name, processes: [ssh] }),
    ).toBeUndefined()
    expect(
      sshProcessOf(launch, "playground-probes", { label: "other-probe", processes: [ssh] }),
    ).toBeUndefined()
    expect(sshProcessOf(launch, "playground-probes", pane(null, ssh.argv))).toBeUndefined()
    expect(
      sshProcessOf(launch, "playground-probes", pane(launch.name, ["bash", "-c", "ssh u@h"])),
    ).toBeUndefined()
  })
})
