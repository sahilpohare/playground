import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { peerArgv } from "../../api/hono/src/lib/system/peer"
import { machineTest, zshMissing } from "../machine"
import { OLD } from "../session-names"
import {
  bin,
  capacityLog,
  execLine,
  launchOf,
  lw,
  paneRun,
  placing,
  root,
  scratch,
  spawn,
  TOKEN,
  transcript,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them.
setDefaultTimeout(40_000)

// A fake ssh ahead of spawn-fake's bin: it runs spawn.sh's check of the other machine in bash with a scratch PATH of that machine's own (remote-bin) and logs it apart, failing it under FAKE_SSH_FAIL; it answers the gate's peer read with FAKE_PEER_LOAD, FAKE_PEER_CORES and FAKE_PEER_AVAIL (kB of 100000), logging it apart and failing it under FAKE_PEER_FAIL; it logs every other call's words, keeps the copy's tar stream, and runs the -tt call's remote command in bash, as the other machine's shell would.
const sshBin = join(scratch, "ssh-bin")
mkdirSync(sshBin, { recursive: true })
writeFileSync(
  join(sshBin, "ssh"),
  `#!/bin/bash
case " $* " in *hasCompletedOnboarding*)
  printf '%s\\037' "$@" >> "$HOME/ssh.checks"; echo >> "$HOME/ssh.checks"
  [ -z "$FAKE_SSH_FAIL" ] || { echo "ssh: connect to host spark-bravo port 22: Connection refused" >&2; exit 255; }
  exec env -i HOME="$HOME" PATH="$HOME/remote-bin" /bin/bash -c "\${!#}" ;;
*" /proc/loadavg "*)
  printf '%s\\037' "$@" >> "$HOME/ssh.peer"; echo >> "$HOME/ssh.peer"
  [ -z "$FAKE_PEER_FAIL" ] || { echo "ssh: connect to host spark-bravo port 22: Connection timed out" >&2; exit 255; }
  echo "\${FAKE_PEER_LOAD:-0.50 0.60} 0.70 1/100 1234"
  printf 'MemTotal: 100000 kB\\nMemAvailable: %s kB\\n' "\${FAKE_PEER_AVAIL:-80000}"
  for ((i = 0; i < \${FAKE_PEER_CORES:-20}; i++)); do echo "cpu$i 1 2 3 4"; done
  exit 0 ;;
esac
printf '%s\\037' "$@" >> "$HOME/ssh.calls"; echo >> "$HOME/ssh.calls"
case " $* " in *" -tt "*) exec bash -c "\${!#}" ;; *) cat > "$HOME/ssh.stdin" ;; esac
`,
)
chmodSync(join(sshBin, "ssh"), 0o755)

// The other machine, in the run's own home: Linux, with grep and head, the tools each case puts on its PATH or in its ~/.bun/bin, a bwrap answering as the case says, and a ~/.claude.json.
type Far = {
  bun?: string[]
  bwrap?: { rc: number; says: string }
  claude?: string | null
  tools?: string[]
}
const ONBOARDED = '{\n  "hasCompletedOnboarding": true,\n  "numStartups": 3\n}\n'
const tool = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}
const far =
  ({ bun = [], bwrap, claude = ONBOARDED, tools = ["bwrap", "socat"] }: Far = {}) =>
  (home: string) => {
    key(home)
    const remote = join(home, "remote-bin")
    tool(remote, "uname", "echo Linux")
    for (const name of ["grep", "head"]) tool(remote, name, `exec ${Bun.which(name)} "$@"`)
    const answer = bwrap ? `echo '${bwrap.says}' >&2\nexit ${bwrap.rc}` : "exit 0"
    for (const name of tools) tool(remote, name, name === "bwrap" ? answer : "exit 0")
    for (const name of bun)
      tool(join(home, ".bun", "bin"), name, name === "bwrap" ? answer : "exit 0")
    if (claude !== null) writeFileSync(join(home, ".claude.json"), claude)
  }
const farPath = { PATH: `${sshBin}:${bin}:${process.env.PATH}` }
const checks = (home: string) =>
  existsSync(join(home, "ssh.checks")) ? readFileSync(join(home, "ssh.checks"), "utf8") : ""
const APPARMOR = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
const sshCalls = (home: string) =>
  readFileSync(join(home, "ssh.calls"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f").slice(0, -1))

const key = (home: string) => {
  writeFileSync(join(home, "key"), "fake key\n")
}
const probe = ["probe", "probe-far", OLD.ops, "b.md"]
const ssh = ["--ssh", "pride@spark-bravo", "--key", "{home}/key"]

describe("--remote-control and --ssh are a probe's start alone", () => {
  test.each([
    ["--remote-control", ["--remote-control", "rc-a"]],
    ["--ssh", ssh],
    ["--key", ["--key", "{home}/key"]],
  ])("%s is refused in every mode but probe, naming the flag and the mode", async (flag, words) => {
    for (const [mode, args] of [
      ["worker", ["worker", "worker-brave-otter", "b.md"]],
      ["runner", ["runner", "runner-calm-heron", "b.md"]],
      ["column", ["column", "probe", "probe-x", "worker-y", "w1:p2", "b.md"]],
      ["resume", ["resume", OLD.ops, root, "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"]],
    ] as const) {
      const r = await spawn([...args, ...words], [], {}, undefined, undefined, key)
      expect(r.code).toBe(2)
      expect(r.err).toContain(`${flag} is for a probe's start (spawn.sh probe), not a ${mode}'s`)
      expect(placing(r)).toEqual([])
    }
  })
})

describe("--remote-control warns where Remote Control forms no link, a start on a token", () => {
  const warns = "--remote-control rc-a forms no Remote Control link, since"
  test("an --account start", async () => {
    const r = await spawn(
      [...probe, "--remote-control", "rc-a", "--account", "spare@example.com"],
      [],
    )
    expect(r.code).toBe(0)
    expect(r.err).toContain(`${warns} --account spare@example.com starts it on a token`)
  })

  test("an --ssh start to a machine with no claude.ai sign-in, and none to one with it", async () => {
    const rc = [...probe, ...ssh, "--remote-control", "rc-a"]
    const bare = await spawn(rc, [], farPath, undefined, undefined, far())
    expect(bare.code).toBe(0)
    expect(bare.err).toContain(
      `${warns} pride@spark-bravo holds no claude.ai sign-in (~/.claude/.credentials.json), so it runs on a token`,
    )
    const signed = await spawn(rc, [], farPath, undefined, undefined, (home) => {
      far()(home)
      mkdirSync(join(home, ".claude"), { recursive: true })
      writeFileSync(join(home, ".claude", ".credentials.json"), "{}\n")
    })
    expect(signed.code).toBe(0)
    expect(signed.err).not.toContain(warns)
  })

  test("a start on this machine's own login, and an --ssh start with no --remote-control, stay quiet", async () => {
    const own = await spawn([...probe, "--remote-control", "rc-a"], [])
    expect(own.code).toBe(0)
    expect(launchOf(own)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(own.err).not.toContain(warns)
    const far_ = await spawn(probe.concat(ssh), [], farPath, undefined, undefined, far())
    expect(far_.code).toBe(0)
    expect(checks(far_.home)).not.toContain("credentials")
  })
})

describe("--remote-control", () => {
  test("passes Claude Code's --remote-control <name> and keeps the probe's row", async () => {
    const r = await spawn([...probe, "--remote-control", "rc-a"], [])
    expect(r.code).toBe(0)
    expect(launchOf(r)).toContain(" --dangerously-skip-permissions --remote-control rc-a ")
    expect(r.roster).toContain("kind=probe")
    expect(execLine(r, "probe-far")).toEndWith(" --remote-control rc-a")
  })

  test.each([["Bad Name"], ["--ssh"], ["a;b"]])("refuses the name %p", async (name) => {
    const r = await spawn([...probe, "--remote-control", name], [])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--remote-control")
    expect(placing(r)).toEqual([])
  })
})

describe("--ssh runs the probe's claude on another machine", () => {
  machineTest(
    zshMissing(),
    "the pane copies the settings and skills into one remote folder, then runs claude there under ssh -tt",
    async () => {
      const email = "spare@example.com"
      const r = await spawn(
        [...probe, ...ssh, "--account", email],
        [],
        farPath,
        undefined,
        undefined,
        far(),
      )
      expect(r.code).toBe(0)
      expect(r.roster).toContain("kind=probe")
      const launch = launchOf(r)
      const remote = launch.match(/mkdir -m 700 (\/tmp\/playground-probe-far\.[A-Za-z0-9]{6})/)?.[1]
      expect(remote).toBeDefined()
      expect(launch).not.toContain(TOKEN)

      const pane = await paneRun(r, { PATH: `${sshBin}:${bin}:${process.env.PATH}` })
      expect(pane.code).toBe(0)
      const calls = sshCalls(r.home)
      const opts = ["-i", join(r.home, "key"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"]
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual([
        ...opts,
        "pride@spark-bravo",
        `mkdir -m 700 ${remote} && tar -xf - -C ${remote}`,
      ])
      expect(calls[1]?.slice(0, -1)).toEqual([...opts, "-tt", "pride@spark-bravo"])
      const command = calls[1]?.at(-1) ?? ""
      expect(command).toStartWith(`cd ${root} && export TMPDIR=${remote} PLAYGROUND_REPO=`)
      // ssh's command PATH is the system's alone, so the remote shell adds its own ~/.bun/bin, expanding $HOME there
      expect(command).toContain(` PATH="$HOME/.bun/bin:$PATH" && (`)
      expect(command).toContain(
        `tk="$(security find-generic-password -s playground-claude-oauth -a ${email} -w)"`,
      )

      // The copy holds three names, each relative, so nothing lands outside the remote folder: the settings, the skills and the brief, which the prompt names there.
      const listed = Bun.spawnSync(["tar", "-tf", join(r.home, "ssh.stdin")]).stdout.toString()
      const entries = listed.split("\n").filter(Boolean)
      expect(entries.every((e) => !e.startsWith("/") && !e.split("/").includes(".."))).toBe(true)
      const tops = [...new Set(entries.map((e) => e.split("/")[0]))].sort()
      expect(tops).toHaveLength(3)
      expect(tops.some((t) => /^factory-settings-sandbox-.*\.json$/.test(t ?? ""))).toBe(true)
      expect(tops).toContain("b.md")

      // The remote shell ran claude with its settings and skills from that folder, the token in no word.
      const args = readFileSync(join(r.home, "claude.args"), "utf8")
      expect(args).toContain(`--settings ${remote}/factory-settings-sandbox-`)
      expect(args).toMatch(new RegExp(`--plugin-dir ${remote}/[0-9a-f]+ `))
      expect(args).toContain(`Your brief is in ${remote}/b.md: read it in full`)
      expect(args).not.toContain(TOKEN)
      expect(readFileSync(join(r.home, "ssh.calls"), "utf8")).not.toContain(TOKEN)
      expect([r.out, r.err, ...(r.roster ?? [])].join("\n")).not.toContain(TOKEN)
      expect(execLine(r, "probe-far")).toEndWith(
        ` --account ${email} --ssh pride@spark-bravo --key ${join(r.home, "key")}`,
      )
    },
  )

  test("an --ssh probe reports with playground send and waits on its own alerts-wait, and a probe here keeps SendMessage (PG-2444)", async () => {
    const there = await spawn([...probe, ...ssh], [], farPath, undefined, undefined, far())
    expect(there.code).toBe(0)
    // the remote command is printf %q's, so its prompt reads with each escape taken off
    const remote = launchOf(there).replace(/\\(.)/g, "$1")
    expect(remote).toContain(
      ` Report to ${OLD.ops} with: playground send ${OLD.ops} <your text>, since SendMessage does not reach ${OLD.ops} from this machine, and keep playground alerts-wait probe-far running as a background task, started again after each line it prints, for the answers."`,
    )
    expect(remote).not.toContain("with SendMessage (to:")
    const here = await spawn(probe, [])
    expect(here.code).toBe(0)
    expect(launchOf(here)).toContain(` Report to ${OLD.ops} with SendMessage (to: ${OLD.ops}).`)
    expect(launchOf(here)).not.toContain("playground send")
  })

  test("on Linux the remote folder takes the probe's own temp folder's name, which its settings' sandbox writes", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, LINUX_GETCONF: "1" },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(0)
    const own = launchOf(r).match(/^export TMPDIR=(\S+)$/m)?.[1] ?? ""
    expect(own).toMatch(/\/playground-probe-far\.[A-Za-z0-9]{6}$/)
    expect(launchOf(r)).toContain(`'mkdir -m 700 ${own} && tar -xf - -C ${own}'`)
  })

  test.each([
    ["a probe", [], "factory-settings-sandbox-400k-probe-far.json"],
    ["a closed probe", ["--sandbox"], "factory-settings-sandbox-closed-400k-probe-far.json"],
  ])(
    "from macOS %s's sandbox writes the remote folder, in a settings file of its own",
    async (_, extra, file) => {
      const r = await spawn([...probe, ...ssh, ...extra], [], farPath, undefined, undefined, far())
      expect(r.code).toBe(0)
      const remote = launchOf(r).match(/mkdir -m 700 (\S+) /)?.[1] ?? ""
      const built = JSON.parse(readFileSync(lw(r.home, file), "utf8"))
      expect(built.sandbox.filesystem.allowWrite).toContain(remote)
      // the remote command rides ssh as one %q-quoted word, each space escaped
      expect(launchOf(r)).toContain(`--settings\\ ${remote}/${file}\\ `)
      expect(existsSync(lw(r.home, file.replace("-probe-far", "")))).toBe(false)
    },
  )

  test.each([
    ["an option for a host", ["--ssh", "-oProxyCommand=x@h", "--key", "{home}/key"], "--ssh"],
    ["a host with no user", ["--ssh", "spark-bravo", "--key", "{home}/key"], "--ssh"],
    ["a host with a space", ["--ssh", "a b@h", "--key", "{home}/key"], "--ssh"],
    ["a host with a shell word", ["--ssh", "u@h;id", "--key", "{home}/key"], "--ssh"],
    ["a relative key", ["--ssh", "u@h", "--key", "key"], "--key"],
    ["a missing key", ["--ssh", "u@h", "--key", "{home}/none"], "--key"],
    ["a folder for a key", ["--ssh", "u@h", "--key", "{home}"], "--key"],
    ["--ssh with no --key", ["--ssh", "u@h"], "--ssh needs --key"],
    ["--key with no --ssh", ["--key", "{home}/key"], "--key needs --ssh"],
  ])("refuses %s before any pane opens", async (_, words, says) => {
    const r = await spawn([...probe, ...words], [], farPath, undefined, undefined, far())
    expect(r.code).toBe(2)
    expect(r.err).toContain(says)
    expect(placing(r)).toEqual([])
    expect(existsSync(lw(r.home, "launch", "probe-far.sh"))).toBe(false)
  })
})

describe("an --ssh probe's load and memory gates read its target, through the System view's peer read", () => {
  const target = "pride@spark-bravo"
  const peerCalls = (home: string) =>
    readFileSync(join(home, "ssh.peer"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\x1f").slice(0, -1))
  const recent = (n: number, readings: object) =>
    Array.from({ length: n }, () =>
      JSON.stringify({ at: new Date().toISOString(), readings, verdict: "pass" }),
    ).join("\n") + "\n"

  test("a free target passes while this machine is busy, its pass logged with the target's readings and host", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, FAKE_LOAD1: "40.00", FAKE_LOAD5: "40.00", CAPACITY_JSONL: recent(30, {}) },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(0)
    expect(peerCalls(r.home)).toEqual([peerArgv(target, join(r.home, "key")).slice(1)])
    const pass = capacityLog(r).at(-1)
    expect(pass.verdict).toBe("pass")
    expect(pass.readings).toMatchObject({
      cores: 20,
      free: 80,
      host: target,
      load5: 0.6,
      starts: 0,
    })
  })

  test("a busy target is refused while this machine is free, naming the target", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, FAKE_PEER_LOAD: "30.00 30.00" },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("the load gate holds it: max(load1, load5) is 30.00 and 0 started")
    expect(r.err).toContain(`the 20 cores on ${target}`)
    expect(placing(r)).toEqual([])
  })

  test("the starts logged for the target count against it, and this machine's own do not", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, CAPACITY_JSONL: recent(25, { host: target }) },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("max(load1, load5) is 0.60 and 25 started")
    const here = await spawn(probe, [], { CAPACITY_JSONL: recent(25, { host: target }) })
    expect(here.code).toBe(0)
    expect(capacityLog(here).at(-1).readings).toMatchObject({ starts: 0 })
    expect(capacityLog(here).at(-1).readings.host).toBeUndefined()
  })

  test("a target short of memory is refused by its free share", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, FAKE_PEER_AVAIL: "3000" },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`the memory gate holds it: free is 3% (${target}'s /proc/meminfo)`)
  })

  test("a target whose read fails is refused with ssh's words", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, FAKE_PEER_FAIL: "1" },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      `the load gate holds it: it cannot read ${target}'s load and memory over ssh (ssh: connect to host spark-bravo port 22: Connection timed out)`,
    )
    expect(placing(r)).toEqual([])
  })
})

describe("a sandboxed start reads its machine before any pane opens", () => {
  test("an --ssh probe reads the other machine with the launch's ssh options, under the launch's PATH", async () => {
    const r = await spawn(probe.concat(ssh), [], farPath, undefined, undefined, far())
    expect(r.code).toBe(0)
    const call = checks(r.home).split("\x1f")
    expect(call.slice(0, 7)).toEqual([
      "-i",
      join(r.home, "key"),
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "pride@spark-bravo",
    ])
    expect(call[7]).toStartWith('PATH="$HOME/.bun/bin:$PATH"; ')
  })

  test("an --ssh probe's claude runs on the other machine, so this machine's folder trust is not asked", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, NO_CLAUDE_TRUST: "1" },
      undefined,
      undefined,
      far(),
    )
    expect(r.err).not.toContain("folder trust question")
    expect(r.code).toBe(0)
  })

  test.each([
    ["socat found only in its ~/.bun/bin", { bun: ["socat"], tools: ["bwrap"] }],
    ["a bwrap that warns on stderr and exits 0", { bwrap: { rc: 0, says: "bwrap: a warning" } }],
  ])("an --ssh probe starts with %s", async (_, machine) => {
    const r = await spawn(probe.concat(ssh), [], farPath, undefined, undefined, far(machine))
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
  })

  const onboarding = `~/.claude.json there lacks "hasCompletedOnboarding": true, so claude would wait on its first-run screens: start claude there once by hand`
  test.each([
    ["no ~/.claude.json", { claude: null }, onboarding],
    ["a ~/.claude.json without the flag", { claude: '{"numStartups": 1}\n' }, onboarding],
    ["the flag false", { claude: '{"hasCompletedOnboarding": false}\n' }, onboarding],
    ["no socat", { tools: ["bwrap"] }, "socat is not on PATH, and claude's sandbox needs it"],
    ["no bwrap", { tools: ["socat"] }, "bwrap is not on PATH, and claude's sandbox needs it"],
    [
      "a bwrap AppArmor stops",
      { bwrap: { rc: 1, says: APPARMOR } },
      `bwrap cannot open the sandbox's network namespace (${APPARMOR}): Ubuntu 24.04's kernel.apparmor_restrict_unprivileged_userns=1 refuses it unless an AppArmor profile lets bwrap use user namespaces`,
    ],
  ])(
    "an --ssh probe is refused on %s, naming it, before any pane opens",
    async (_, machine, says) => {
      const r = await spawn(probe.concat(ssh), [], farPath, undefined, undefined, far(machine))
      expect(r.code).toBe(1)
      expect(r.err).toContain(`spawn.sh refuses probe-far: on pride@spark-bravo ${says}`)
      expect(r.err).toContain(
        "so its claude would exit in its pane (failIfUnavailable); spawn.sh installs nothing",
      )
      expect(placing(r)).toEqual([])
      expect(existsSync(lw(r.home, "launch", "probe-far.sh"))).toBe(false)
    },
  )

  test("an --ssh probe names every missing piece in one refusal", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      farPath,
      undefined,
      undefined,
      far({ claude: null, tools: ["bwrap"] }),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(`${onboarding}; socat is not on PATH`)
  })

  test("an --ssh probe whose ssh fails is refused with ssh's words", async () => {
    const r = await spawn(
      probe.concat(ssh),
      [],
      { ...farPath, FAKE_SSH_FAIL: "1" },
      undefined,
      undefined,
      far(),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(
      "spawn.sh refuses probe-far: it cannot read pride@spark-bravo over ssh (ssh: connect to host spark-bravo port 22: Connection refused)",
    )
    expect(placing(r)).toEqual([])
  })

  test("--check reads the other machine too", async () => {
    const r = await spawn(
      [...probe, ...ssh, "--check"],
      [],
      farPath,
      undefined,
      undefined,
      far({ claude: null }),
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(onboarding)
  })

  test.each([
    ["a probe", probe],
    ["a --sandbox worker", ["worker", "worker-brave-otter", "b.md", "--sandbox"]],
  ])(
    "on Linux %s here is refused when bwrap cannot open the sandbox, before any pane opens",
    async (_, args) => {
      const r = await spawn(args, [], {
        FAKE_BWRAP_RC: "1",
        FAKE_BWRAP_SAYS: APPARMOR,
        LINUX_GETCONF: "1",
      })
      expect(r.code).toBe(1)
      expect(r.err).toContain(
        `on this machine bwrap cannot open the sandbox's network namespace (${APPARMOR})`,
      )
      expect(placing(r)).toEqual([])
    },
  )

  test("on Linux a probe here whose bwrap warns on stderr and exits 0 starts", async () => {
    const r = await spawn(probe, [], { FAKE_BWRAP_SAYS: "bwrap: a warning", LINUX_GETCONF: "1" })
    expect(r.code).toBe(0)
  })
})

describe("restore and resume leave a remote probe down", () => {
  test.each([["--ssh u@h --key /k"], ["--remote-control rc-a"]])(
    "a resume of a probe whose record carries %s is refused, its record kept",
    async (extra) => {
      const sid = "eeeeeeee-0000-4000-8000-0000000000e1"
      const record = `#!/bin/bash\n# server: playground\nexec /x/scripts/spawn.sh resume probe-far ${root} ${sid} ${extra}\n`
      const r = await spawn(
        ["resume", "probe-far", root, sid],
        [],
        {},
        undefined,
        { name: "probe-far", backend: "claude" },
        (home) => {
          mkdirSync(lw(home, "resume"), { recursive: true })
          writeFileSync(lw(home, "resume", "probe-far.sh"), record)
        },
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain(
        "spawn.sh refuses probe-far: it started as a probe with --ssh or --remote-control, which a resume would drop: start it again with spawn.sh probe",
      )
      expect(placing(r)).toEqual([])
      expect(readFileSync(lw(r.home, "resume", "probe-far.sh"), "utf8")).toBe(record)
    },
  )

  test("a record carrying --ssh or --remote-control is skipped with its reason", async () => {
    const sid = "eeeeeeee-0000-4000-8000-0000000000e1"
    const r = await spawn(["restore"], [], {}, undefined, undefined, (home) => {
      for (const dir of ["resume", "runtimes", "backends"])
        mkdirSync(lw(home, dir), { recursive: true })
      for (const [name, extra] of [
        ["probe-far", "--ssh u@h --key /k"],
        ["probe-rc", "--remote-control rc-a"],
      ]) {
        writeFileSync(
          lw(home, "resume", `${name}.sh`),
          `#!/bin/bash\n# server: playground\nexec /x/scripts/spawn.sh resume ${name} ${root} ${sid} ${extra}\n`,
        )
        writeFileSync(lw(home, "runtimes", name), "herdr\n")
      }
      transcript(home, sid)
    })
    const reason =
      "it started with --ssh or --remote-control, a probe's start alone, so restore leaves it down"
    expect(r.out).toBe(`skipped probe-far: ${reason}\nskipped probe-rc: ${reason}\n`)
    expect(placing(r)).toEqual([])
  })
})
