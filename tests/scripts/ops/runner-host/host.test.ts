import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { peerRecordArgv } from "../../../../packages/scripts/src/machine-record/record"

// The runner host is a small rented machine of about 4 GB.
const DIR = join(import.meta.dir, "../../../../scripts/ops/runner-host")
// each test spawns scripts and a scratch git repo, which runs past bun's 5s default under load (44 on 19 Oct)
setDefaultTimeout(20_000)
const TOKEN = "AAAREGTOKEN0123456789"
// the box's user home a stub ssh answers ci.sh's first read with, the state folder under it, and free memory well past the floor
const BOX_HOME = "/home/box"
const BOX_CI_DIR =
  readFileSync(join(DIR, "ci.sh"), "utf8").match(/^BOX_CI_DIR=(\S+)$/m)?.[1] ?? "BOX_CI_DIR unread"
const BOX_CI = `${BOX_HOME}/${BOX_CI_DIR}`
const BIG_KB = 64 * 1024 * 1024
// the MemAvailable ci.sh passes suite.sh as a run's need: the model server's 15 GiB floor past a suite's 4.5 GiB peak, or an exec's 2 GiB
const SUITE_NEED_KB = (15 * 1024 + 4608) * 1024
const EXEC_NEED_KB = 17 * 1024 * 1024

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const bin = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

const SYSTEM_TOOLS = [
  "awk",
  "bash",
  "cat",
  "cut",
  "grep",
  "head",
  "nproc",
  "sed",
  "sort",
  "tr",
  "uname",
]

type Host = {
  containers?: string
  docker?: boolean
  dockerFails?: boolean
  listeners?: string
  ss?: boolean
}

// A scratch PATH whose ss, docker and the other reads answer as the host given, and whose ssh runs `bash -s` here, records every
// argv, and keeps what the setup script would receive on its stdin, so nothing reaches a real machine.
const host = ({
  containers = "",
  docker = true,
  dockerFails = false,
  listeners = "",
  ss = true,
}: Host = {}) => {
  const root = mkdtempSync(join(tmpdir(), "runner-host-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  writeFileSync(join(root, "listeners"), listeners)
  writeFileSync(join(root, "containers"), containers)
  if (ss) bin(b, "ss", `cat "${root}/listeners"`)
  if (docker) bin(b, "docker", dockerFails ? "exit 1" : `cat "${root}/containers"`)
  // with no docker, PATH holds the scratch bin alone, with links to the tools the scripts call, since a runner box has a real docker
  else
    for (const name of SYSTEM_TOOLS) {
      const real = Bun.which(name)
      if (real) symlinkSync(real, join(b, name))
    }
  for (const name of ["df", "free", "swapon", "systemctl"]) bin(b, name, "true")
  bin(
    b,
    "ssh",
    `echo "ssh $*" >> "${root}/argv"
case "\${@: -1}" in
  -s) exec bash -s ;;
  "mkdir -p /root/playground-runner && cat > /root/playground-runner/setup.sh") cat > "${root}/copied" ;;
  "cat > /root/playground-runner/tools.sh") cat > "${root}/tools" ;;
  acme/app) cat > "${root}/stdin" ;;
esac`,
  )
  bin(b, "gh", `echo "gh $*" >> "${root}/argv"; echo ${TOKEN}`)
  // the settings reader, answering factory.repo as a store that sets it would
  bin(b, "bun", `echo '"acme/app"'`)
  const run = (args: string[], script = "host.sh") => {
    const p = Bun.spawnSync(["bash", join(DIR, script), ...args], {
      env: {
        HOME: root,
        PATH: docker ? `${b}:/usr/bin:/bin` : b,
        RUNNER_HOST_KEY: join(root, "key"),
      },
      stdin: script === "survey.sh" ? "ignore" : undefined,
    })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""
  return { read, run }
}

const SSH = "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\ntcp LISTEN 0 4096 [::]:22 [::]:*"
const RESOLVER =
  "udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\ntcp LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*"
const DHCP = "udp UNCONN 0 0 203.0.113.7%eth0:68 0.0.0.0:*"

describe("survey.sh", () => {
  test("a fresh host reads clean", () => {
    const r = host({ listeners: [SSH, RESOLVER, DHCP].join("\n") }).run([], "survey.sh")
    expect(r.code).toBe(0)
    expect(r.out).toContain("clean:")
  })

  test("a host with no docker reads clean", () => {
    expect(host({ docker: false, listeners: SSH }).run([], "survey.sh").code).toBe(0)
  })

  test("a web server off loopback is live", () => {
    const r = host({ listeners: `${SSH}\ntcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:*` }).run(
      [],
      "survey.sh",
    )
    expect(r.code).toBe(3)
    expect(r.out).toContain("live listener: tcp 0.0.0.0:443")
  })

  test("a listener on an IPv6 address is live", () => {
    expect(host({ listeners: "tcp LISTEN 0 511 [::]:5432 [::]:*" }).run([], "survey.sh").code).toBe(
      3,
    )
  })

  test("a host whose listeners or containers it cannot read stops setup", () => {
    const noSs = host({ docker: false, ss: false }).run([], "survey.sh")
    expect(noSs.code).toBe(4)
    expect(noSs.out).toContain("unread: could not read the listeners (ss)")
    const r = host({ dockerFails: true, listeners: SSH }).run([], "survey.sh")
    expect(r.code).toBe(4)
    expect(r.out).toContain("unread: could not read the containers (docker ps)")
  })

  test("a running container is live", () => {
    const r = host({ containers: "shop nginx:1 Up 3 days", listeners: SSH }).run([], "survey.sh")
    expect(r.code).toBe(3)
    expect(r.out).toContain("running container: shop nginx:1 Up 3 days")
  })
})

describe("host.sh", () => {
  test("refuses an address that is not IPv4", () => {
    expect(host().run(["survey", "203.0.113.7; rm -rf /"]).code).toBe(2)
  })

  test("setup stops at a live survey and copies nothing", () => {
    const h = host({ listeners: "tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:*" })
    const r = h.run(["setup", "203.0.113.7"])
    expect(r.code).toBe(3)
    expect(h.read("copied")).toBe("")
    expect(h.read("argv")).not.toContain("registration-token")
  })

  test("setup hands the token to the script on stdin, never on an argv", () => {
    const h = host({ listeners: SSH })
    expect(h.run(["setup", "203.0.113.7"]).code).toBe(0)
    expect(h.read("copied")).toBe(readFileSync(join(DIR, "setup.sh"), "utf8"))
    expect(h.read("tools")).toBe(readFileSync(join(DIR, "tools.sh"), "utf8"))
    expect(h.read("stdin").trim()).toBe(TOKEN)
    expect(h.read("argv")).toContain("repos/acme/app/actions/runners/registration-token")
    expect(h.read("argv")).toContain("bash /root/playground-runner/setup.sh acme/app\n")
    expect(h.read("argv")).not.toContain(TOKEN)
  })

  test("drift names a live copy that differs from the ref's and exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-drift-"))
    dirs.push(root)
    const live = join(root, ".playground", "ops", "runner-host")
    mkdirSync(live, { recursive: true })
    const head = Bun.spawnSync(["git", "-C", DIR, "show", "HEAD:scripts/ops/runner-host/ci.sh"])
    writeFileSync(join(live, "ci.sh"), head.stdout)
    writeFileSync(join(live, "suite.sh"), "an old copy\n")
    const p = Bun.spawnSync(["bash", join(DIR, "host.sh"), "drift", "HEAD"], {
      env: { HOME: root, PATH: "/usr/bin:/bin" },
    })
    expect(p.exitCode).toBe(1)
    expect(p.stdout.toString()).toContain("same ci.sh\n")
    expect(p.stdout.toString()).toContain("differs suite.sh: copy it to a dot-file in")
  })
})

describe("setup.sh", () => {
  test("has the token on no command line", () => {
    const s = readFileSync(join(DIR, "setup.sh"), "utf8")
    expect(s).not.toMatch(/--token/)
    expect(s).toContain("ACTIONS_RUNNER_INPUT_TOKEN=\\$(cat ~/.runner-token)")
  })
  // Only say, die and fetch run, cut out of setup.sh's text, with a curl on PATH that writes made-up bytes, so no install step runs and nothing reaches the network.
  const fetchRun = (sum: string) => {
    const root = mkdtempSync(join(tmpdir(), "runner-fetch-"))
    dirs.push(root)
    const b = join(root, "bin")
    mkdirSync(b)
    bin(
      b,
      "curl",
      `echo "curl $*" >> "${root}/calls"\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && printf 'made-up bytes' > "$2"; shift; done`,
    )
    for (const tool of ["apt-get", "install", "su", "systemctl", "tar", "unzip"])
      bin(b, tool, `echo "${tool} $*" >> "${root}/calls"`)
    const text = readFileSync(join(DIR, "setup.sh"), "utf8")
    const fns = ["say", "die", "fetch"].map((name) => {
      const start = text.split("\n").findIndex((l) => l.startsWith(`${name}() {`))
      if (start < 0) return ""
      const lines = text.split("\n").slice(start)
      const end = lines[0]!.endsWith("}") ? 0 : lines.findIndex((l) => l === "}")
      return lines.slice(0, end + 1).join("\n")
    })
    const out = Bun.spawnSync(
      [
        "bash",
        "-c",
        `set -euo pipefail\n${fns.join("\n")}\nfetch https://example.invalid/tool.tar.gz ${sum} "${root}/tool.tar.gz"\necho fetched`,
      ],
      { env: { PATH: `${b}:/usr/bin:/bin:/usr/sbin:/sbin` }, stderr: "pipe", stdout: "pipe" },
    )
    const calls = existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : ""
    return {
      calls,
      code: out.exitCode,
      kept: existsSync(join(root, "tool.tar.gz")),
      out: out.stdout.toString(),
      err: out.stderr.toString(),
    }
  }
  const MADE_UP_SUM = new Bun.CryptoHasher("sha256").update("made-up bytes").digest("hex")

  test("fetch stops the script on a download whose sha256 is not the pinned one, and removes it", () => {
    const r = fetchRun("0".repeat(64))
    expect(r.code).toBe(1)
    expect(r.out).toBe("")
    expect(r.err).toContain(
      `https://example.invalid/tool.tar.gz has sha256 ${MADE_UP_SUM}, not the pinned ${"0".repeat(64)}`,
    )
    expect(r.kept).toBe(false)
    expect(r.calls).toMatch(/^curl -fsSL -o \S+ https:\/\/example\.invalid\/tool\.tar\.gz\n$/)
  })

  test("fetch keeps a download whose sha256 is the pinned one, and the script goes on", () => {
    const r = fetchRun(MADE_UP_SUM)
    expect([r.code, r.out, r.kept]).toEqual([0, "fetched\n", true])
    expect(r.calls.split("\n").filter(Boolean)).toHaveLength(1)
  })

  test("pins bun, uv and the runner by version and sha256, with no installer piped to a shell", () => {
    const s = readFileSync(join(DIR, "setup.sh"), "utf8")
    for (const name of ["BUN", "UV", "RUNNER"])
      expect(s).toMatch(new RegExp(`^${name}_VERSION=\\d+\\.\\d+\\.\\d+$`, "m"))
    expect(s.match(/_SHA256=[0-9a-f]{64}\b/g)).toHaveLength(6)
    expect(s).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/)
    expect(s).not.toContain("releases/latest")
  })
})

// ci.sh exec against a scratch box: ssh keeps the run's .cmd and answers its output and exit line from a file
const boxExec = (
  out: string,
  {
    cmd = (real: string): string[] => ["bun", "test", join(real, "web", "a.test.ts")],
    dirty = false,
    freeKb = BIG_KB,
    home = BOX_HOME,
    key = "",
    more = (_: string): string[] => [],
    unit = "inactive",
    untracked = [] as string[],
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-exec-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  writeFileSync(join(root, "out"), out)
  bin(
    b,
    "ssh",
    `echo "ssh \${@: -1}" >> "${root}/argv"
printf '%s\\n' "$*" >> "${root}/full"
case "\${@: -1}" in
  *"/proc/meminfo"*) printf '%s\\n%s\\n' '${home}' '${freeKb}' ;;
  *"systemctl --user is-active"*) echo "unit ${unit}"; tail -n 1 "${root}/out"; echo ;;
  "tail -n 1 ${BOX_CI}/"*) tail -n 1 "${root}/out" ;;
  "sed '\\$d' ${BOX_CI}/"*) sed '$d' "${root}/out" ;;
  "cat > ${BOX_CI}/"*.cmd) cat > "${root}/cmd" ;;
  *".tar") cat > "${root}/tar" ;;
  *) cat > /dev/null ;;
esac`,
  )
  const repo = join(root, "repo")
  mkdirSync(join(repo, "web"), { recursive: true })
  if (key) {
    mkdirSync(join(root, "data", "ops", "runner-host"), { recursive: true })
    writeFileSync(join(root, "data", "ops", "runner-host", "key"), key)
  }
  const env = {
    HOME: root,
    PATH: `${b}:/usr/bin:/bin`,
    PLAYGROUND_DATA_DIR: join(root, "data"),
    RUNNER_HOST: "203.0.113.7",
    RUNNER_HOST_CLONE: "~/code/playground",
    RUNNER_HOST_POLL: "0",
  }
  writeFileSync(join(repo, "web", "kept.ts"), "committed")
  for (const args of [
    ["init", "-q"],
    ["add", "web/kept.ts"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"],
  ])
    Bun.spawnSync(["git", ...args], { cwd: repo, env })
  if (dirty) {
    writeFileSync(join(repo, "web", "draft.ts"), "untracked")
    writeFileSync(join(repo, "web", "kept.ts"), "edited")
  }
  for (const file of untracked) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), "untracked")
  }
  const status = () =>
    Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, env }).stdout.toString()
  const before = status()
  const real = realpathSync(repo)
  const p = Bun.spawnSync(
    ["bash", join(DIR, "ci.sh"), "exec", join(real, "web"), "--", ...cmd(real), ...more(real)],
    { cwd: repo, env },
  )
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""
  const sent = (file: string) =>
    Bun.spawnSync(["tar", "-xOf", join(root, "tar"), file]).stdout.toString()
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
    read,
    repo: real,
    sent,
    statusKept: status() === before,
  }
}

// suite.sh's run, the script it hands its steps, run here with a docker that does not answer
const suiteRun = (mode: string) => {
  const root = mkdtempSync(join(tmpdir(), "runner-suite-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  mkdirSync(join(root, "tree"))
  bin(b, "docker", "exit 1")
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const start = suite.indexOf(") << 'EOF'\n", suite.indexOf("exec env -i CI_RUN"))
  const script = suite.slice(suite.indexOf("\n", start) + 1, suite.indexOf("\nEOF\n", start))
  const p = Bun.spawnSync(["bash", "-s"], {
    env: {
      DIR: join(root, "tree"),
      F: join(root, "run"),
      HOME: root,
      MODE: mode,
      PATH: `${b}:/usr/bin:/bin`,
      RUN: "0123456789ab-abcdef",
    },
    stdin: Buffer.from(script),
  })
  return { code: p.exitCode, out: p.stdout.toString() }
}

// suite.sh's web mode, the script it hands its steps, run here with a docker that records its calls and answers `build` with
// `build`'s code
const suiteWeb = (build = 0) => {
  const root = mkdtempSync(join(tmpdir(), "runner-web-mode-"))
  dirs.push(root)
  const b = join(root, "bin")
  const tree = join(root, "tree")
  mkdirSync(b)
  mkdirSync(tree)
  writeFileSync(
    join(tree, ".env.example"),
    "BETTER_AUTH_SECRET=\nPOSTGRES_URL=\nAGENT_SIGNIN_ENABLED=\nNEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=\n",
  )
  bin(
    b,
    "docker",
    `echo "docker $*" >> "${root}/calls"; [ "$1 $2" = "compose build" ] && exit ${build}; exit 0`,
  )
  bin(b, "timeout", `shift; exec "$@"`)
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const start = suite.indexOf(") << 'EOF'\n", suite.indexOf("exec env -i CI_RUN"))
  const script = suite.slice(suite.indexOf("\n", start) + 1, suite.indexOf("\nEOF\n", start))
  const p = Bun.spawnSync(["bash", "-s"], {
    env: {
      DIR: tree,
      F: join(root, "run"),
      HOME: root,
      MODE: "web",
      PATH: `${b}:/usr/bin:/bin`,
      RUN: "0123456789ab-abcdef",
    },
    stdin: Buffer.from(script),
  })
  const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n")
  return { calls, code: p.exitCode, env: readFileSync(join(tree, ".env"), "utf8") }
}

// the box's bash; the exec path reads its command with mapfile, which a Mac's bash 3.2 lacks
const BASH4 = Bun.spawnSync(["bash", "-c", "[ ${BASH_VERSINFO[0]} -ge 4 ]"]).exitCode === 0

// suite.sh's exec mode (or the given one), the script it hands its steps, run here with a docker that answers, a bun that records its calls, and the base lockfile ci.sh sends when `base` is given
const suiteExec = (
  argv: string[],
  docker = `[ "$1" = port ] && echo 127.0.0.1:5432; exit 0`,
  mode = "exec",
  base?: string,
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-exec-mode-"))
  dirs.push(root)
  const b = join(root, "bin")
  const tree = join(root, "tree")
  mkdirSync(b)
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true })
  writeFileSync(join(tree, ".env.example"), "POSTGRES_URL=\nBETTER_AUTH_SECRET=\n")
  bin(b, "docker", docker.replaceAll("ROOT", root))
  bin(b, "timeout", `shift; exec "$@"`)
  bin(b, "sleep", "exit 0")
  bin(b, "bun", `echo "bun $*" >> "${root}/calls"`)
  bin(join(tree, "node_modules", ".bin"), "turbo", "exit 0")
  writeFileSync(join(root, "run.cmd"), `\n${argv.map((a) => `${a}\0`).join("")}`)
  if (base !== undefined) writeFileSync(join(root, "run.base"), base)
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const start = suite.indexOf(") << 'EOF'\n", suite.indexOf("exec env -i CI_RUN"))
  const script = suite.slice(suite.indexOf("\n", start) + 1, suite.indexOf("\nEOF\n", start))
  const p = Bun.spawnSync(["bash", "-s"], {
    env: {
      DIR: tree,
      EMAIL: "t@t",
      F: join(root, "run"),
      HOME: root,
      MODE: mode,
      PATH: `${b}:/usr/bin:/bin`,
      RUN: "0123456789ab-abcdef",
    },
    stdin: Buffer.from(script),
  })
  const calls = existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : ""
  return { code: p.exitCode, calls: calls.trim().split("\n"), out: p.stdout.toString(), root }
}

// suite.sh's slot wait run here: its state folder a scratch one, its free memory past the floor, tickets already queued, and the units in `live` reading active;
// flock records each try and takes the lock, and the run is cut off after `wait` ms when it never gets one
const slotWait = (queued: string[], live: string[], wait: number) => {
  const root = mkdtempSync(join(tmpdir(), "runner-slots-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  mkdirSync(join(root, "queue"))
  for (const t of queued) writeFileSync(join(root, "queue", t), "")
  bin(b, "systemctl", `case " ${live.join(" ")} " in *" \${@: -1} "*) exit 0 ;; esac; exit 3`)
  bin(b, "flock", `echo try >> "${root}/flock"`)
  bin(b, "sleep", "/bin/sleep 0.05")
  writeFileSync(join(root, "meminfo"), `MemAvailable:   ${BIG_KB} kB\n`)
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const block = suite
    .slice(suite.indexOf("SLOTS=$("), suite.indexOf('rm -f "$TICKET"\n') + 16)
    .replaceAll("/proc/meminfo", join(root, "meminfo"))
  const p = Bun.spawnSync(["bash", "-c", `${block}\necho got`], {
    env: {
      CI: root,
      MODE: "exec",
      NEED_KB: String(EXEC_NEED_KB),
      PATH: `${b}:/usr/bin:/bin`,
      RUN: "0123456789ab-zzzzzz",
    },
    timeout: wait,
  })
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""
  return {
    got: p.stdout.toString().includes("got"),
    queue: readdirSync(join(root, "queue")).sort(),
    tries: read("flock"),
  }
}

// suite.sh's take() run here over 3 slots under a scratch folder: flock fails on the tries `busy` numbers, from 1, and the run prints take's exit and how many slot locks it holds after it
const slotTake = (mode: string, busy: number[], argv?: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "runner-take-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  if (argv) writeFileSync(join(root, "run.cmd"), `\n${argv.map((a) => `${a}\0`).join("")}`)
  bin(
    b,
    "flock",
    `n=$(($(cat "${root}/n" 2> /dev/null || echo 0) + 1)); echo "$n" > "${root}/n"
case " ${busy.join(" ")} " in *" $n "*) exit 1 ;; esac; exit 0`,
  )
  writeFileSync(join(root, "meminfo"), `MemAvailable:   ${BIG_KB} kB\n`)
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const block = suite.slice(suite.indexOf("TAKE=$MODE"), suite.indexOf("\n}\nwhile :; do") + 3)
  const p = Bun.spawnSync(
    [
      "bash",
      "-c",
      `${block.replaceAll("/proc/meminfo", join(root, "meminfo"))}\ntake; echo "$? \${#LOCKS[@]}"`,
    ],
    {
      env: {
        CI: root,
        F: join(root, "run"),
        MODE: mode,
        NEED_KB: String(SUITE_NEED_KB),
        PATH: `${b}:/usr/bin:/bin`,
        SLOTS: "3",
      },
    },
  )
  return p.stdout.toString().trim()
}

// suite.sh's take() over 2 slots in a scratch folder for a run whose need is `needKb`, /proc/meminfo a file holding `availableKb`, and the suites in `lanes` holding every slot shared and their lane (the stub reads a descriptor's file from /proc, or lsof on a Mac)
const suiteBeside = (
  mode: string,
  lanes: number[],
  availableKb: number,
  needKb = mode === "exec" ? EXEC_NEED_KB : SUITE_NEED_KB,
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-beside-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  writeFileSync(join(root, "slots"), "2\n")
  writeFileSync(
    join(root, "meminfo"),
    `MemTotal:       131072000 kB\nMemAvailable:   ${availableKb} kB\n`,
  )
  bin(
    b,
    "flock",
    `fd=\${@: -1}
if [ -e "/proc/self/fd/$fd" ]; then f=$(readlink "/proc/self/fd/$fd"); else f=$(/usr/sbin/lsof -a -p $$ -d "$fd" -Fn | sed -n 's/^n//p'); fi
[ "${lanes.length ? 1 : 0}" = 1 ] || exit 0
case "$(basename "$f")" in
  slot-*.lock) case " $* " in *" -s "*) exit 0 ;; esac; exit 1 ;;
${lanes.map((n) => `  suite-${n}.lock) exit 1 ;;`).join("\n")}
esac
exit 0`,
  )
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const block = suite
    .slice(suite.indexOf("SLOTS=$("), suite.indexOf("\n}\nwhile :; do") + 3)
    .replaceAll("/proc/meminfo", join(root, "meminfo"))
  const p = Bun.spawnSync(["bash", "-c", `${block}\ntake; echo "$? \${#LOCKS[@]}"`], {
    env: {
      CI: root,
      F: join(root, "run"),
      MODE: mode,
      NEED_KB: String(needKb),
      PATH: `${b}:/usr/bin:/bin`,
      RUN: "0123456789ab-zzzzzz",
    },
  })
  return p.stdout.toString().trim()
}

// a suite.sh function by its name, whole
const suiteFn = (name: string) => {
  const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
  const start = suite.indexOf(`${name}() {`)
  const block = suite[suite.indexOf("\n", start) - 1] === "{"
  return suite.slice(start, suite.indexOf(block ? "\n}\n" : "\n", start) + (block ? 3 : 1))
}

// one of suite.sh's output readers run on `out`
const readOut = (name: string, out: string) => {
  const root = mkdtempSync(join(tmpdir(), "runner-read-out-"))
  dirs.push(root)
  writeFileSync(join(root, "out"), out)
  const p = Bun.spawnSync([
    "bash",
    "-c",
    `${suiteFn(name)}\n${name} "$1"`,
    "bash",
    join(root, "out"),
  ])
  return p.stdout.toString()
}

// suite.sh's test step run here: the first full run fails tests/a.test.ts, that file passes alone, and the second full run fails tests/b.test.ts instead
const testStep = (
  bun = `[ "$2" = test:file ] && exit 0
n=$(($(cat "ROOT/n" 2> /dev/null || echo 0) + 1)); echo "$n" > "ROOT/n"
[ "$n" = 1 ] && f=a || f=b
printf 'tests/%s.test.ts:\n(fail) %s > breaks [1.00ms]\n\n 9 pass\n 1 fail\n' "$f" "$f"
exit 1`,
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-test-step-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  bin(b, "timeout", `shift; exec "$@"`)
  bin(b, "bun", bun.replaceAll("ROOT", root))
  const script = ["failing_files", "failing_names", "sandbox_ok", "summary", "test_step"]
    .map(suiteFn)
    .join("\n")
  const p = Bun.spawnSync(["bash", "-c", `failed=0\n${script}\ntest_step`], {
    env: { F: join(root, "run"), LOG: join(root, "log"), PATH: `${b}:/usr/bin:/bin` },
  })
  return p.stdout.toString()
}

// suite.sh's test step when a file fails in the batch, passes alone, and the rerun is green: it names the file a BATCH-RED and still passes
const testStepRedTurnsGreen = (
  bun = `[ "$2" = test:file ] && exit 0
n=$(($(cat "ROOT/n" 2> /dev/null || echo 0) + 1)); echo "$n" > "ROOT/n"
if [ "$n" -lt 2 ]; then
printf 'tests/a.test.ts:\n(fail) a > breaks [1.00ms]\n\n 9 pass\n 1 fail\n'
exit 1
fi
printf ' 10 pass\n 0 fail\ntest-sandbox: parallel pass passed, serial pass passed\n'
exit 0`,
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-test-red-green-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  bin(b, "timeout", `shift; exec "$@"`)
  bin(b, "bun", bun.replaceAll("ROOT", root))
  const script = ["failing_files", "failing_names", "sandbox_ok", "summary", "test_step"]
    .map(suiteFn)
    .join("\n")
  const p = Bun.spawnSync(["bash", "-c", `failed=0\n${script}\ntest_step`], {
    env: { F: join(root, "run"), LOG: join(root, "log"), PATH: `${b}:/usr/bin:/bin` },
  })
  return p.stdout.toString()
}

describe("suite.sh", () => {
  test("a second full run that fails names its own files, so the Mac never re-runs the first run's", () => {
    const out = testStep()
    expect(out).toContain("failed test b > breaks\n")
    expect(out).toContain("files test tests/b.test.ts\n")
    expect(out).not.toContain("files test tests/a.test.ts")
    expect(out).toContain("tally test 1 0\n")
  })

  test("a red its rerun turns green is named a BATCH-RED, and the step still passes", () => {
    const out = testStepRedTurnsGreen()
    expect(out).toContain(
      "BATCH-RED: tests/a.test.ts (open one issue to root-cause it, by code-review-loop's step 2)\n",
    )
    expect(out).toContain("ok test ")
    expect(out).not.toContain("fail test ")
  })

  test("only the oldest live waiter tries a slot, first come first served, and dead tickets drop", () => {
    const behind = slotWait(["1000-aaaaaaaaaaaa-aaaaaa"], ["ci-aaaaaaaaaaaa-aaaaaa"], 1500)
    expect(behind.got).toBe(false)
    expect(behind.tries).toBe("")
    const next = slotWait(["1000-dead00000000-dddddd"], [], 15_000)
    expect(next.got).toBe(true)
    expect(next.tries).toBe("try\n")
    expect(next.queue).toEqual([])
  })

  // a run whose ci.sh has gone (a SIGKILL, a restart, a tool's timeout) stops itself once ci.sh's polls stop touching its heartbeat
  const watch = (beat: "fresh" | "none" | "stale", wait: number) => {
    const root = mkdtempSync(join(tmpdir(), "runner-beat-"))
    dirs.push(root)
    const b = join(root, "bin")
    mkdirSync(b)
    bin(b, "systemctl", `echo "$*" >> "${root}/systemctl"`)
    bin(b, "sleep", "/bin/sleep 0.05")
    if (beat !== "none") writeFileSync(join(root, "run.beat"), "")
    if (beat === "stale") Bun.spawnSync(["touch", "-t", "202001010000", join(root, "run.beat")])
    // in the foreground here, as suite.sh's launch line would run it in the background, so the cut-off ends the loop with its shell
    const p = Bun.spawnSync(
      ["bash", "-c", `${suiteFn("watch_beat")}\n[ -f "$F.beat" ] && watch_beat`],
      {
        env: { F: join(root, "run"), PATH: `${b}:/usr/bin:/bin`, RUN: "0123456789ab-abcdef" },
        timeout: wait,
      },
    )
    const stopped = existsSync(join(root, "systemctl"))
      ? readFileSync(join(root, "systemctl"), "utf8")
      : ""
    return { out: p.stdout.toString(), stopped }
  }

  test("a run whose heartbeat goes stale stops its own unit, saying why in its output", () => {
    const r = watch("stale", 5000)
    expect(r.stopped).toBe("--user stop --no-block ci-0123456789ab-abcdef\n")
    expect(r.out).toContain("fail run: ")
  })

  test("a run whose heartbeat is fresh runs on, and one with none, started by a ci.sh before the heartbeat, is never watched", () => {
    expect(watch("fresh", 1000).stopped).toBe("")
    expect(watch("none", 1000).stopped).toBe("")
  })

  test("only a run with a heartbeat is watched, and the unit's stop and the sweep of a stopped run's files both take it", () => {
    const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
    expect(suite).toContain('[ -f "$F.beat" ] && watch_beat')
    expect(suite).toContain('"$F.base" "$F.beat"')
    expect(suite).toContain("-o -name '*-*.beat'")
  })

  test("a run that exits 0 while its serial pass failed never reads green", () => {
    const out =
      testStep(`printf ' 9 pass\\n 0 fail\\ntest-sandbox: parallel pass passed, serial pass failed\\n'
exit 0`)
    expect(out).not.toContain("ok test")
  })

  test("the counts sum across both passes", () => {
    expect(readOut("summary", " 9 pass\n 1 fail\n 2 errors\n 3 pass\n 1 fail\n")).toBe(
      "12 pass, 2 fail, 2 errors\n",
    )
  })

  test("the failing files stop at the recap, which names each failure again under no file", () => {
    const out =
      "tests/a.test.ts:\n(fail) a > breaks\n\n1 tests failed:\n(fail) a > breaks\n(fail) b > breaks\n"
    expect(readOut("failing_files", out)).toBe("tests/a.test.ts\n")
  })

  test("a suite takes every slot or none, and an exec run takes one", () => {
    expect(slotTake("suite", [])).toBe("0 3")
    expect(slotTake("suite", [2])).toBe("1 0")
    expect(slotTake("exec", [1])).toBe("0 1")
    expect(slotTake("exec", [1, 2, 3])).toBe("1 0")
  })

  // one suite at a time (dispatcher, 24 Oct: side by side took 632s each against 316s alone)
  test("a second suite waits while one runs, even with MemAvailable to spare", () => {
    expect(suiteBeside("suite", [1], BIG_KB)).toBe("1 0")
    expect(suiteBeside("suite", [2], BIG_KB)).toBe("1 0")
  })

  test("a suite waits while both lanes are held, whatever the memory", () => {
    expect(suiteBeside("suite", [1, 2], BIG_KB)).toBe("1 0")
  })

  test("a lone suite takes its slots, and a web build or an exec run still waits for a running suite", () => {
    expect(suiteBeside("suite", [], BIG_KB)).toBe("0 2")
    expect(suiteBeside("web", [1], BIG_KB)).toBe("1 0")
    expect(suiteBeside("exec", [1], BIG_KB)).toBe("1 0")
    expect(suiteBeside("web", [], BIG_KB)).toBe("0 2")
  })

  // #2529: the box is spark-9dfb, whose model server keeps 15 GiB; a suite or web build peaks at 4.5 GiB, an exec at 2 GiB
  test("a run takes a slot only while the box's free memory covers the need ci.sh passed it, the floor past its own peak", () => {
    const gib = (n: number) => Math.round(n * 1024 * 1024)
    expect(suiteBeside("suite", [], gib(19.4))).toBe("1 0")
    expect(suiteBeside("suite", [], gib(19.5))).toBe("0 2")
    expect(suiteBeside("web", [], gib(19.4))).toBe("1 0")
    expect(suiteBeside("exec", [], gib(16.9))).toBe("1 0")
    expect(suiteBeside("exec", [], gib(17))).toBe("0 1")
    expect(suiteBeside("exec", [], gib(17), gib(18))).toBe("1 0")
    expect(suiteBeside("suite", [], gib(18), gib(18))).toBe("0 2")
  })

  // a box can hold a suite.sh beside an older ci.sh that passes no need, so the run refuses before it queues rather than take a slot past the floor
  test("suite.sh refuses a run with no need, or one that is not a number, before it queues", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-need-"))
    dirs.push(root)
    cpSync(join(DIR, "suite.sh"), join(root, "suite.sh"))
    const run = (...args: string[]) =>
      Bun.spawnSync(["bash", join(root, "suite.sh"), "0123456789ab-aaaaaa", ...args], {
        env: { HOME: root, PATH: "/usr/bin:/bin" },
      })
    for (const args of [["suite"], ["exec"], ["web"], ["exec", "17G"]]) {
      const p = run(...args)
      expect(p.exitCode).toBe(2)
      expect(p.stderr.toString()).toContain(
        "the MemAvailable in KiB the run needs, which ci.sh passes",
      )
    }
    expect(existsSync(join(root, "queue"))).toBe(false)
  })

  test.skipIf(!BASH4)(
    "an exec run of the whole suite takes every slot, and one of a file takes one",
    () => {
      expect(slotTake("exec", [], ["bun", `--cwd=${BOX_CI}/x`, "run", "test"])).toBe("0 3")
      expect(slotTake("exec", [], ["bun", "run", "--cwd", `${BOX_CI}/x`, "test"])).toBe("0 3")
      expect(slotTake("exec", [3], ["bun", "run", "test"])).toBe("1 0")
      expect(slotTake("exec", [], ["bun", "run", "test", "tests/a.test.ts"])).toBe("0 1")
      expect(slotTake("exec", [], ["bun", "test", "a.test.ts"])).toBe("0 1")
      expect(slotTake("exec", [], ["bun", "run", "test:file"])).toBe("0 3")
      expect(slotTake("exec", [], ["bun", "run", "test:file", "a.test.ts"])).toBe("0 1")
    },
  )

  // as a suite, 10 queued test:skills runs of about 200s each held the box one at a time; one 37-minute wait was 5 suites in a row
  test.skipIf(!BASH4)("an exec run of dispatcher's checks takes one slot, as any exec does", () => {
    expect(slotTake("exec", [], ["bun", "run", "test:skills"])).toBe("0 1")
    expect(slotTake("exec", [], ["bun", `--cwd=${BOX_CI}/x`, "run", "test:skills"])).toBe("0 1")
    expect(slotTake("exec", [1], ["bun", "run", "--cwd", `${BOX_CI}/x`, "test:skills"])).toBe("0 1")
    expect(slotTake("exec", [1, 2, 3], ["bun", "run", "test:skills"])).toBe("1 0")
  })

  test.skipIf(!BASH4)(
    "an exec test run writes the root test script's generated file first, and any other command does not",
    () => {
      const run = suiteExec(["bun", "test", "a.test.ts"])
      expect(run.code).toBe(0)
      expect(run.calls.slice(-2)).toEqual([
        "bun packages/scripts/src/data-table-metrics.ts",
        "bun test a.test.ts",
      ])
      expect(suiteExec(["bun", "run", "test:file", "a.test.ts"]).calls.slice(-2)).toEqual([
        "bun packages/scripts/src/data-table-metrics.ts",
        "bun run test:file a.test.ts",
      ])
      const types = suiteExec(["bun", "run", "check-types"])
      expect(types.code).toBe(0)
      expect(types.calls).not.toContain("bun packages/scripts/src/data-table-metrics.ts")
      expect(types.calls.at(-1)).toBe("bun run check-types")
      expect(suiteExec(["bun", "x", "latest"]).calls).not.toContain(
        "bun packages/scripts/src/data-table-metrics.ts",
      )
    },
  )

  test.skipIf(!BASH4)(
    "a suite run audits over the base lockfile ci.sh sent, and strictly with none (#1704)",
    () => {
      const audit = (calls: string[]) =>
        calls.find((c) => c.startsWith("bun packages/scripts/src/audit.ts"))
      const strict =
        "bun packages/scripts/src/audit.ts --audit-level moderate --ignore GHSA-67mh-4wv8-2f99 --ignore GHSA-g3hv-75wg-m249"
      const over = suiteExec([], undefined, "suite", "{}")
      expect(audit(over.calls)).toBe(`${strict} --new-over ${join(over.root, "run.base")}`)
      expect(audit(suiteExec([], undefined, "suite").calls)).toBe(strict)
    },
  )

  // postgres:alpine's first start runs a temporary server for initdb that answers on the Unix socket alone, then stops it for the real one,
  // so a check over the socket can pass on it and the next land in the gap: 5 of 344 runner-host runs failed `fail db:` on 19 Oct.
  test("both db checks ask over TCP, where the first start's temporary server takes no connection", () => {
    const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
    expect(suite.match(/pg_isready[^\n]*/g)).toEqual([
      "pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1 && break; sleep 1; done",
      'pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1 || { echo "fail db: Postgres did not answer in 60s"; [ "$MODE" = exec ] && exit 255; exit 1; }',
    ])
  })

  test.skipIf(!BASH4)(
    "a db check that passes on the temporary server alone never reads as ready",
    () => {
      // the socket answers its first check (the temporary server), then nothing in the gap; TCP answers from its third, the real server
      const docker = `[ "$1" = port ] && { echo 127.0.0.1:5432; exit 0; }
[ "$1" = exec ] || exit 0
case " $* " in *" -h 127.0.0.1 "*) f=ROOT/tcp ;; *) f=ROOT/socket ;; esac
n=$(($(cat "$f" 2>/dev/null || echo 0) + 1)); echo $n > "$f"
case "$f" in *socket) [ $n -eq 1 ] ;; *) [ $n -ge 3 ] ;; esac`
      const run = suiteExec(["bun", "x", "latest"], docker)
      expect(run.out).not.toContain("fail db")
      expect(run.code).toBe(0)
    },
  )

  test("a run whose Docker does not answer never reads green: red in suite mode, 255 in exec", () => {
    const suite = suiteRun("suite")
    expect(suite.code).toBe(1)
    expect(suite.out).toContain("fail docker: Docker does not answer for this user")
    const exec = suiteRun("exec")
    expect(exec.code).toBe(255)
    expect(exec.out).toContain("fail docker")
    expect(suiteRun("web").code).toBe(255)
  })

  test("a web run builds the web image with the smoke .env, checks it holds one libc, and removes it", () => {
    const run = suiteWeb()
    expect(run.code).toBe(0)
    expect(run.env).toBe(
      "BETTER_AUTH_SECRET=dummy\nPOSTGRES_URL=postgres://dummy:dummy@localhost:5432/dummy\nAGENT_SIGNIN_ENABLED=true\nNEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=\n",
    )
    expect(run.calls[0]).toBe("docker info")
    expect(run.calls.slice(1, 3)).toEqual([
      "docker compose build --no-cache web",
      expect.stringMatching(/^docker run --rm --entrypoint sh 0123456789ab-abcdef-web -c find /),
    ])
    expect(run.calls.at(-1)).toBe("docker compose down --rmi local")
  })

  test("a web build that fails exits with its code, skips the check, and still removes what it made", () => {
    const run = suiteWeb(1)
    expect(run.code).toBe(1)
    expect(run.calls.some((c) => c.startsWith("docker run"))).toBe(false)
    expect(run.calls.at(-1)).toBe("docker compose down --rmi local")
  })

  test("a container a step starts with no name or label is the run's, and the unit's stop removes it with its volumes", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-shim-"))
    dirs.push(root)
    const [shimDir, real, stubs] = ["shim", "real", "stubs"].map((d) => join(root, d))
    for (const d of [shimDir, real, stubs]) mkdirSync(d)
    const tree = join(root, "srv", ".claude", "worktrees", "0123456789ab-aaaaaa")
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(root, "containers"), "")
    bin(
      real,
      "docker",
      `s="${root}/containers"
echo "$*" >> "${root}/calls"
case "$1" in
  run) l=none; while [ $# -gt 0 ]; do [ "$1" = --label ] && { l=$2; shift; }; shift; done; id=c$(wc -l < "$s" | tr -d ' '); echo "$id $l" >> "$s"; echo "$id" ;;
  ps) awk -v w="\${4#label=}" '$2 == w { print $1 }' "$s" ;;
  rm) shift; for c in "$@"; do grep -v "^$c " "$s" > "$s.n"; mv "$s.n" "$s"; done ;;
esac`,
    )
    const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
    const shim = suite.slice(suite.indexOf("<< 'SHIM'\n") + 10, suite.indexOf("\nSHIM\n"))
    bin(
      shimDir,
      "docker",
      shim.replace("#!/bin/bash\n", "").replaceAll("/usr/bin/docker", join(real, "docker")),
    )
    for (const run of ["0123456789ab-aaaaaa", "0123456789ab-bbbbbb"])
      // not a container start: the docker on PATH is the shim written above, so no container starts
      Bun.spawnSync(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::6379", "redis:alpine"], {
        env: { CI_RUN: run, PATH: `${shimDir}:/usr/bin:/bin` },
      })
    Bun.spawnSync(["docker", "info"], { env: { CI_RUN: "x", PATH: `${shimDir}:/usr/bin:/bin` } })
    expect(readFileSync(join(root, "containers"), "utf8")).toBe(
      "c0 playground.ci.run=0123456789ab-aaaaaa\nc1 playground.ci.run=0123456789ab-bbbbbb\n",
    )
    expect(readFileSync(join(root, "calls"), "utf8")).toContain("\ninfo\n")
    bin(stubs, "timeout", `shift; exec "$@"`)
    writeFileSync(join(root, "srv", "suite.sh"), suite)
    const p = Bun.spawnSync(
      ["bash", join(root, "srv", "suite.sh"), "0123456789ab-aaaaaa", "stop"],
      {
        env: { PATH: `${stubs}:${real}:/usr/bin:/bin` },
      },
    )
    expect(p.exitCode).toBe(0)
    expect(readFileSync(join(root, "containers"), "utf8")).toBe(
      "c1 playground.ci.run=0123456789ab-bbbbbb\n",
    )
    expect(readFileSync(join(root, "calls"), "utf8")).toContain("rm -fv c0\n")
    expect(existsSync(tree)).toBe(false)
    expect(readFileSync(join(DIR, "ci.sh"), "utf8")).toContain(
      "--property='ExecStopPost=/bin/bash $CI/suite.sh $RUN stop'",
    )
  })

  test("the box's run tree sits under .claude/worktrees/, as a Mac worktree does", () => {
    expect(readFileSync(join(DIR, "suite.sh"), "utf8")).toContain(
      "DIR=$CI/.claude/worktrees/$RUN\n",
    )
    expect(readFileSync(join(DIR, "ci.sh"), "utf8")).toContain(
      "BOXDIR=$CI/.claude/worktrees/$RUN\n",
    )
  })
})

// ci.sh exec (or the given mode) against a box faked on this machine: ssh runs each command here, the box's home this scratch folder and its
// free memory past the floor, systemd-run runs the unit in place, and the unit runs a stand-in suite that records its mode and need and prints the given output
const fakeBox = (
  output: string,
  { argv = (repo: string) => ["exec", repo, "--", "true"], code = 0, clone = true } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-fake-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  // the box's clone, whose record CLI a stand-in bun on the box's ~/.bun/bin answers, keeping where it ran, its words and its stdin
  if (clone) {
    mkdirSync(join(root, "clone"))
    mkdirSync(join(root, ".bun", "bin"), { recursive: true })
    bin(
      join(root, ".bun", "bin"),
      "bun",
      `{ printf '%s\\n' "$PWD" "$*"; cat; } > "${root}/recorded"`,
    )
  }
  writeFileSync(
    join(root, "fake-suite.sh"),
    `echo "$2" > "${root}/mode"; echo "$3" > "${root}/need"; printf '%s' '${output}'; exit ${code}\n`,
  )
  bin(
    b,
    "ssh",
    String.raw`case "${"$"}{@: -1}" in *"/proc/meminfo"*) printf 'ROOT
BIG
'; exit 0 ;; esac
printf '%s\n' "${"$"}{@: -1}" >> ROOT/argv
c=$(printf '%s' "${"$"}{@: -1}" | sed -e 's#ROOT/${BOX_CI_DIR}/suite.sh #ROOT/fake-suite.sh #g')
exec bash -c "$c"`
      .replaceAll("ROOT", root)
      .replace("BIG", String(BIG_KB)),
  )
  bin(b, "systemd-run", `while [[ "$1" == --* ]]; do shift; done; "$@"`)
  bin(b, "systemctl", "echo inactive; exit 3")
  const repo = join(root, "repo")
  mkdirSync(repo)
  const env = {
    HOME: root,
    PATH: `${b}:/usr/bin:/bin`,
    RUNNER_HOST: "203.0.113.7",
    RUNNER_HOST_CLONE: join(root, "clone"),
    RUNNER_HOST_POLL: "0",
  }
  for (const args of [
    ["init", "-q"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"],
  ])
    Bun.spawnSync(["git", ...args], { cwd: repo, env })
  const p = Bun.spawnSync(["bash", join(DIR, "ci.sh"), ...argv(realpathSync(repo))], {
    cwd: repo,
    env,
  })
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""
  return {
    argv: read("argv"),
    code: p.exitCode,
    err: p.stderr.toString(),
    mode: read("mode").trim(),
    need: read("need").trim(),
    out: p.stdout.toString(),
    recorded: read("recorded"),
    root,
  }
}

describe("what a run puts on the box goes into the box's machine record (PG-2538)", () => {
  test("each upload hands the box clone's record CLI the run folder and the Postgres image, by peerRecordArgv's own remote words", () => {
    const r = fakeBox("done")
    expect(r.code).toBe(0)
    const clone = join(r.root, "clone")
    expect(r.argv.split("\n")).toContain(peerRecordArgv(undefined, "box", clone, "add").at(-1)!)
    const [where, words, stdin] = r.recorded.split("\n")
    expect([where, words]).toEqual([
      clone,
      "--no-env-file packages/scripts/src/machine-record/cli.ts add --stdin",
    ])
    const ci = join(r.root, BOX_CI_DIR)
    expect(JSON.parse(stdin!)).toEqual([
      {
        by: "ci.sh",
        kind: "folder",
        path: ci,
        undo: `remove ${ci} and what it holds`,
        why: "ci.sh runs heavy runs here",
      },
      {
        by: "ci.sh",
        kind: "image",
        path: "docker image postgres:alpine",
        undo: "docker image rm postgres:alpine",
        why: "suite.sh starts each run's Postgres from it",
      },
    ])
  })

  test("a box whose clone cannot take the record still runs, with one line saying what is not in it", () => {
    const r = fakeBox("done", { clone: false })
    expect(r.code).toBe(0)
    expect(r.out).toBe("done\n")
    expect(r.err.split("\n")[0]).toBe(
      `ci.sh: ${r.root}/${BOX_CI_DIR} and docker image postgres:alpine are not in the box's machine record (its clone ${r.root}/clone); its next check names them`,
    )
    expect(r.err.split("\n")[1]).toMatch(/^ci\.sh: ci-\S+ started on the box; /)
  })
})

describe("ci.sh exec", () => {
  test("a command whose output has no final newline still ends green, its output whole", () => {
    const r = fakeBox("done-no-newline")
    expect(r.err).toMatch(RUN_LINE)
    expect(r.code).toBe(0)
    expect(r.out).toBe("done-no-newline\n")
  })

  test("untracked source and an edited tracked file both reach the box, and git status stays as it was", () => {
    const r = boxExec("exit 0\n", { dirty: true, untracked: ["tests/new.test.ts"] })
    expect(r.code).toBe(0)
    expect(r.sent("web/draft.ts")).toBe("untracked")
    expect(r.sent("tests/new.test.ts")).toBe("untracked")
    expect(r.sent("web/kept.ts")).toBe("edited")
    expect(r.statusKept).toBe(true)
  })

  test.each([["id_ed25519"], ["tests/token.txt"], ["tests/.netrc"]])(
    "an untracked %s that is not source exits 255 and uploads nothing, so the run stays on the Mac",
    (file) => {
      const r = boxExec("exit 0\n", { dirty: true, untracked: [file] })
      expect(r.code).toBe(255)
      expect(r.err).toContain(`untracked file the box does not take (${file})`)
      expect(r.read("tar")).toBe("")
      expect(r.read("argv")).toBe("")
      expect(r.statusKept).toBe(true)
    },
  )

  test("the command goes over with its folder and every checkout path moved to the box's copy", () => {
    const r = boxExec("exit 0\n")
    const [rel, args] = r.read("cmd").split("\n")
    expect(rel).toBe("/web")
    const argv = args.split("\0").filter(Boolean)
    expect(argv.slice(0, 2)).toEqual(["bun", "test"])
    expect(argv[2]).toStartWith(`${BOX_CI}/.claude/worktrees/`)
    expect(argv[2].slice(BOX_CI.length)).toMatch(
      /^\/\.claude\/worktrees\/[0-9a-f]{12}-[0-9a-z]{6}\/web\/a\.test\.ts$/,
    )
  })

  test("the checkout's own path moves, and a sibling that starts with the same text stays", () => {
    const r = boxExec("exit 0\n", {
      more: (real) => [
        real,
        `${real}x/b.ts`,
        `--root=${real}/c`,
        `--cwd=${real}`,
        `-C${real}`,
        `${real}-x`,
        `/x${real}`,
        `/x${real}/f`,
      ],
    })
    const argv = r.read("cmd").split("\n")[1].split("\0").filter(Boolean)
    const box = argv[2].replace(/\/web\/a\.test\.ts$/, "")
    expect(argv.slice(3)).toEqual([
      box,
      `${r.repo}x/b.ts`,
      `--root=${box}/c`,
      `--cwd=${box}`,
      `-C${box}`,
      `${r.repo}-x`,
      `/x${r.repo}`,
      `/x${r.repo}/f`,
    ])
  })

  test("a unit that ended with no exit line finishes red, saying why", () => {
    const r = boxExec("ok install 3s\n", { unit: "inactive" })
    expect(r.code).toBe(1)
    expect(r.err).toContain("is inactive on the box with no exit line")
  })

  test("the command's output and exit code come back", () => {
    const r = boxExec(" 3 pass\n 1 fail\nexit 1\n")
    expect(r.code).toBe(1)
    expect(r.out).toBe(" 3 pass\n 1 fail\n")
    expect(boxExec("ok\nexit 0\n").code).toBe(0)
  })

  // #2529: the box is a peer of this user's own, reached with no root, under user units; #2554: its state sits outside that user's data folder, which a test sandbox may hide
  test(`it logs in as this user, never root, and keeps every remote path under the box user's ~/${BOX_CI_DIR} in user units`, () => {
    const r = boxExec("exit 0\n")
    expect(r.code).toBe(0)
    const me = Bun.spawnSync(["id", "-un"]).stdout.toString().trim()
    const full = r.read("full").trim().split("\n")
    expect(full.length).toBeGreaterThan(3)
    for (const line of full) expect(line).toContain(` ${me}@203.0.113.7 `)
    const sent = r.read("argv")
    expect(sent).not.toMatch(/\/srv\/ci|\/root|root@|runuser/)
    expect(sent).toContain(`cat > ${BOX_CI}/`)
    expect(sent).not.toContain(`${BOX_HOME}/.playground`)
    expect(sent).toContain("systemd-run --user ")
    expect(sent).toContain("systemctl --user is-active ")
  })

  test("the key comes from RUNNER_HOST_KEY, else the data folder's runner-host/key", () => {
    const r = boxExec("exit 0\n", { key: "/keys/peer" })
    expect(r.read("full").split("\n")[0]).toStartWith("-i /keys/peer -o IdentitiesOnly=yes ")
  })

  test("a box whose free memory would go under the model server's 15 GiB floor exits 255 before any upload, so the run stays here", () => {
    const low = boxExec("exit 0\n", { freeKb: 17 * 1024 * 1024 - 1 })
    expect(low.code).toBe(255)
    expect(low.err).toContain("under the model server's 15 GiB floor")
    expect(low.read("tar")).toBe("")
    expect(low.read("argv").trim().split("\n")).toHaveLength(1)
    expect(boxExec("exit 0\n", { freeKb: 17 * 1024 * 1024 }).code).toBe(0)
    for (const home of ["", "/home/two words", "relative/home"]) {
      const lost = boxExec("exit 0\n", { home })
      expect(lost.code).toBe(255)
      expect(lost.err).toContain("the box's home or free memory did not read")
      expect(lost.read("tar")).toBe("")
    }
  })

  test.each([
    [["bun", "run", "test"]],
    [["bun", "run", "test:file"]],
    [["bun", "run", "--cwd", "web", "test"]],
  ])(
    "an exec of the whole suite (%p) keeps the suite's 4.5 GiB peak, so at 18 GiB free it exits 255 before any upload, as suite.sh's take() would wait",
    (argv) => {
      const low = boxExec("exit 0\n", { cmd: () => argv, freeKb: 18 * 1024 * 1024 })
      expect(low.code).toBe(255)
      expect(low.err).toContain("under the model server's 15 GiB floor")
      expect(low.read("tar")).toBe("")
      expect(low.read("argv").trim().split("\n")).toHaveLength(1)
      expect(boxExec("exit 0\n", { cmd: () => argv, freeKb: 19.5 * 1024 * 1024 }).code).toBe(0)
    },
  )

  test("an exec of named test files keeps the exec's 2 GiB peak, so 18 GiB free takes it", () => {
    const argv = ["bun", "run", "test:file", "tests/a.test.ts"]
    expect(boxExec("exit 0\n", { cmd: () => argv, freeKb: 18 * 1024 * 1024 }).code).toBe(0)
  })

  // ci.sh holds the floor and the peaks alone, and suite.sh's slot wait reads the need it passes
  test.each([
    ["an exec", (repo: string) => ["exec", repo, "--", "true"], EXEC_NEED_KB],
    [
      "a whole-suite exec",
      (repo: string) => ["exec", repo, "--", "bun", "run", "test"],
      SUITE_NEED_KB,
    ],
    ["a web build", () => ["web", "HEAD"], SUITE_NEED_KB],
    ["a suite", () => ["HEAD"], SUITE_NEED_KB],
  ])("%s passes suite.sh the floor past its own peak as its need", (_, argv, need) => {
    expect(fakeBox("ok\n", { argv }).need).toBe(String(need))
  })

  // dispatcher, 17 Nov: on spark-a566, linger kept a locked keyring daemon alive, and the factory's calls jammed on it
  test("nothing ci.sh sends or suite.sh runs reaches the keyring: no gh, credential helper or docker login, and the steps' env drops the bus", () => {
    const keyring = /\bgh\b|credential|docker login|secret-tool|keyring|DBUS/i
    const sent = boxExec("exit 0\n").read("argv")
    expect(sent).not.toMatch(keyring)
    // the two settings that shut the bus and gh's own config are the one place either word may stand
    const shut = ["DBUS_SESSION_BUS_ADDRESS=disabled: ", 'GH_CONFIG_DIR="$CI/gh" ']
    const code = (name: string) =>
      readFileSync(join(DIR, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n")
    expect(code("ci.sh")).not.toMatch(keyring)
    const steps = code("suite.sh").match(/exec env -i [^\n]*/)?.[0] ?? ""
    for (const s of shut) expect(steps).toContain(s)
    expect(steps).toContain('DOCKER_CONFIG="$CI/docker"')
    expect(steps).toContain("GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1")
    expect(shut.reduce((s, cut) => s.replace(cut, ""), code("suite.sh"))).not.toMatch(keyring)
  })

  test("a box with no node on the steps' own PATH gives them bun as node, and one with its own node drops that link", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-node-"))
    dirs.push(root)
    mkdirSync(join(root, "ci", "bin"), { recursive: true })
    const suite = readFileSync(join(DIR, "suite.sh"), "utf8")
    const line = suite.split("\n").find((l) => l.includes('"$CI/bin/node"')) ?? ""
    const run = () =>
      Bun.spawnSync(["bash", "-c", line.replace(":/usr/bin:/bin", "")], {
        env: {
          CI: join(root, "ci"),
          HOME: root,
          PATH: "/usr/bin:/bin",
          RUN: "0123456789ab-abcdef",
        },
      }).exitCode
    expect(run()).toBe(0)
    expect(readlinkSync(join(root, "ci", "bin", "node"))).toBe(join(root, ".bun", "bin", "bun"))
    expect(readdirSync(join(root, "ci", "bin"))).toEqual(["node"])
    mkdirSync(join(root, ".local", "bin"), { recursive: true })
    writeFileSync(join(root, ".local", "bin", "node"), "")
    chmodSync(join(root, ".local", "bin", "node"), 0o755)
    expect(run()).toBe(0)
    expect(readdirSync(join(root, "ci", "bin"))).toEqual([])
  })
})

describe("ci.sh web", () => {
  test("it builds on the box in web mode, and the build's output and exit code come back", () => {
    const ok = fakeBox("#1 built\nok single-libc\n", { argv: () => ["web", "HEAD"] })
    expect(ok.mode).toBe("web")
    expect(ok.code).toBe(0)
    expect(ok.out).toBe("#1 built\nok single-libc\n")
    const red = fakeBox("FAIL: glibc stack shipped\n", { argv: () => ["web", "HEAD"], code: 1 })
    expect(red.code).toBe(1)
    expect(red.out).toBe("FAIL: glibc stack shipped\n")
  })

  test("a box it cannot reach exits 255 with nothing built here, and a bad call exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-web-"))
    dirs.push(root)
    const env = { HOME: root, PATH: "/usr/bin:/bin" }
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, env })
    const run = (...args: string[]) =>
      Bun.spawnSync(["bash", join(DIR, "ci.sh"), ...args], { cwd: root, env })
    const lost = run("web", "HEAD")
    expect(lost.exitCode).toBe(255)
    expect(lost.stderr.toString()).toContain("no runner host address")
    const near = (...args: string[]) =>
      Bun.spawnSync(["bash", join(DIR, "ci.sh"), ...args], {
        cwd: root,
        env: { ...env, RUNNER_HOST: "203.0.113.7" },
      }).exitCode
    expect(near("web")).toBe(2)
    expect(near("web", "HEAD")).toBe(2)
  })
})

describe("usage", () => {
  // each prints its whole leading comment block as its usage, a line added to the header included, and no code line after it
  test.each(["ci.sh", "host.sh"])(
    "%s with no arguments prints its header and stops before its code",
    (name) => {
      const copy = mkdtempSync(join(tmpdir(), "runner-usage-"))
      try {
        cpSync(DIR, copy, { recursive: true })
        const [shebang, ...rest] = readFileSync(join(DIR, name), "utf8").split("\n")
        writeFileSync(
          join(copy, name),
          [shebang, "# A line added to the header.", ...rest].join("\n"),
        )
        const r = Bun.spawnSync(["bash", join(copy, name)], {
          env: { HOME: copy, PATH: "/usr/bin:/bin", RUNNER_HOST: "203.0.113.7" },
        })
        const header = ["# A line added to the header.", ...rest]
        const block = header.slice(
          0,
          header.findIndex((line) => !line.startsWith("#")),
        )
        expect(r.exitCode).toBe(2)
        expect(r.stderr.toString()).toBe(`${block.join("\n")}\n`)
      } finally {
        rmSync(copy, { force: true, recursive: true })
      }
    },
  )
})

const FULLTIME = "fullTime > gives the date and the seconds, for a hover"
// the one stderr line every run prints as its unit starts, so the caller can stop its own run by id
const RUN_LINE =
  /^ci\.sh: ci-([0-9a-f]{12}-[0-9a-z]{6}) started on the box; ci\.sh cancel \1 stops it\n$/

type Box = {
  active?: number
  dirty?: boolean
  linuxOnly?: string | null
  macPasses?: boolean
  older?: boolean
  place?: string
  progress?: string
  reachable?: boolean
  unit?: string
}

// ci.sh against a scratch box: ssh answers the run's lines from a file, and bun stands in for the Mac's re-run of the Linux-only
// files; older runs ci.sh on the commit before HEAD, whose tree the checkout no longer holds; the unit reads active, at place in the
// queue when given, for its first `active` polls
const box = (
  out: string,
  {
    active = 0,
    dirty = false,
    linuxOnly = FULLTIME,
    macPasses = true,
    older = false,
    place = "",
    progress,
    reachable = true,
    unit = "inactive",
  }: Box = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "runner-ci-"))
  dirs.push(root)
  const b = join(root, "bin")
  mkdirSync(b)
  writeFileSync(join(root, "out"), out)
  bin(
    b,
    "ssh",
    reachable
      ? `case "\${@: -1}" in *"/proc/meminfo"*) printf '%s\\n%s\\n' '${BOX_HOME}' '${BIG_KB}' ;; *"systemctl --user is-active"*) n=$(cat "${root}/polls" 2> /dev/null || echo 0); echo $((n + 1)) > "${root}/polls"; if [ "$n" -lt ${active} ]; then echo "unit active ${place}"; [ -n "${place}" ] || echo "ok install 3s"; else echo "unit ${unit}"; tail -n 1 "${root}/out"; fi; echo ;; "tail -n 1 ${BOX_CI}/"*) tail -n 1 "${root}/out" ;; "cat ${BOX_CI}/"*) cat "${root}/out" ;; *) cat > /dev/null ;; esac`
      : "exit 255",
  )
  bin(
    b,
    "bun",
    `echo "bun $*" >> "${root}/bun"; echo " 3 pass"; echo " 0 fail"; exit ${macPasses ? 0 : 1}`,
  )
  const repo = join(root, "repo")
  mkdirSync(repo)
  const env = {
    HOME: root,
    PATH: `${b}:/usr/bin:/bin`,
    RUNNER_HOST: "203.0.113.7",
    RUNNER_HOST_CLONE: "~/code/playground",
    ...(linuxOnly === null ? {} : { RUNNER_HOST_LINUX_ONLY: linuxOnly }),
    RUNNER_HOST_POLL: active ? "1" : "0",
    ...(progress === undefined ? {} : { RUNNER_HOST_PROGRESS: progress }),
  }
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env })
  const commit = (file: string) => {
    writeFileSync(join(repo, file), file)
    git("add", file)
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", file)
  }
  git("init", "-q")
  commit("a")
  if (older) commit("b")
  if (dirty) writeFileSync(join(repo, "draft.ts"), "x")
  const p = Bun.spawnSync(["bash", join(DIR, "ci.sh"), older ? "HEAD~1" : "HEAD"], {
    cwd: repo,
    env,
  })
  const read = (name: string) =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : ""
  return { code: p.exitCode, err: p.stderr.toString(), out: p.stdout.toString(), read }
}

const LINUX_ONLY_FAIL = [
  "ok check-types 20s",
  `failed test ${FULLTIME}`,
  "files test tests/web/next/src/lib/time.test.ts",
  "tally test 1 0",
  "fail test 300s: exit 1: 5346 pass, 1 fail",
  "ok build 38s",
  "done 400s",
  "exit 1",
].join("\n")

describe("ci.sh", () => {
  test("a box it cannot reach exits 255, so the caller runs the suite on the Mac", () => {
    expect(box("", { reachable: false }).code).toBe(255)
  })

  test("a run whose unit failed with no exit line is red, saying why", () => {
    const r = box("ok install 3s\n", { unit: "failed" })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(
      /^fail run: the run's unit ci-\S+ is failed on the box with no exit line/m,
    )
  })

  test("a green run passes its lines through", () => {
    const r = box("ok test 300s: 5347 pass\ndone 400s\nexit 0\n")
    expect(r.code).toBe(0)
    expect(r.out).toContain("ok test 300s: 5347 pass")
  })

  test("a failure only in a Linux-only test re-runs its file on the Mac, and passes when it passes there", () => {
    const r = box(LINUX_ONLY_FAIL)
    expect(r.code).toBe(0)
    expect(r.read("bun")).toBe("bun run test:file tests/web/next/src/lib/time.test.ts\n")
    expect(r.out).toMatch(
      /^ok test 300s: the suite ran on the runner host, and fullTime .* passed here/m,
    )
  })

  test("that file failing on the Mac too keeps the run red", () => {
    const r = box(LINUX_ONLY_FAIL, { macPasses: false })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^fail test 300s/m)
  })

  test("any other failure is red with no re-run", () => {
    const other = box(LINUX_ONLY_FAIL.replace(FULLTIME, "something else > breaks"))
    expect(other.code).toBe(1)
    expect(other.read("bun")).toBe("")
    const step = box(LINUX_ONLY_FAIL.replace("ok build 38s", "fail build 38s: exit 1: boom"))
    expect(step.code).toBe(1)
    expect(step.read("bun")).toBe("")
  })

  // A fix took the one test it named, so with RUNNER_HOST_LINUX_ONLY unset a failure on the box is a failure.
  test("ci.sh's own list is empty, so with none named a failure is red with no re-run", () => {
    expect(readFileSync(join(DIR, "ci.sh"), "utf8")).toMatch(
      /^LINUX_ONLY=\$\{RUNNER_HOST_LINUX_ONLY:-\}$/m,
    )
    const r = box(LINUX_ONLY_FAIL, { linuxOnly: null })
    expect(r.code).toBe(1)
    expect(r.read("bun")).toBe("")
    expect(r.out).toMatch(/^fail test 300s/m)
  })

  test("a checkout with changes, or one whose HEAD is not the box's tree, stays red with the reason", () => {
    for (const [opts, why] of [
      [{ dirty: true }, "this checkout has changes not committed"],
      [{ older: true }, "this checkout's HEAD is not the tree the runner host ran"],
    ] as const) {
      const r = box(LINUX_ONLY_FAIL, opts)
      expect(r.code).toBe(1)
      expect(r.read("bun")).toBe("")
      expect(r.out).toMatch(/^fail test 300s/m)
      expect(r.out).toContain(`re-run skipped: ${why}`)
    }
  })

  test("a file that throws as it loads keeps the run red, though its only (fail) line is Linux-only", () => {
    const r = box(LINUX_ONLY_FAIL.replace("tally test 1 0", "tally test 2 1"))
    expect(r.code).toBe(1)
    expect(r.read("bun")).toBe("")
  })

  // a run silent for 49 minutes read the same as a stuck one
  test("a run that goes past the interval says on stderr where it stands, and its stdout stays the run's own", () => {
    const green = "ok test 300s: 5347 pass\ndone 400s\nexit 0\n"
    const running = box(green, { active: 2, progress: "1" })
    expect(running.code).toBe(0)
    expect(running.out).toBe(box(green).out)
    expect(running.err).toMatch(/^ci\.sh: ci-\S+ running, \d+ min in, last line: ok install 3s$/m)
    const queued = box(green, { active: 2, place: "3", progress: "1" })
    expect(queued.out).toBe(running.out)
    expect(queued.err).toMatch(/^ci\.sh: ci-\S+ queued, 2 ahead, \d+ min in$/m)
  })

  test("a run that ends before the interval prints its run id alone on stderr, with the cancel that stops it", () => {
    expect(
      box("ok test 300s: 5347 pass\ndone 400s\nexit 0\n", { active: 1, progress: "3600" }).err,
    ).toMatch(RUN_LINE)
  })
})

describe("ci.sh against the box", () => {
  // runs ci.sh HEAD on a scratch repo, whose history `commit` builds, against a fake ssh that logs each command and keeps the `.base` upload
  const startCi = async (
    commit: (git: (...args: string[]) => void, repo: string) => void,
    args = (_repo: string) => ["HEAD"],
  ) => {
    const root = mkdtempSync(join(tmpdir(), "runner-ci-"))
    dirs.push(root)
    const b = join(root, "bin")
    mkdirSync(b)
    bin(
      b,
      "ssh",
      `printf '%s\\n' "$*" >> "${root}/argv"; printf '%s\\n' "\${@: -1}" >> "${root}/ssh"; case "\${@: -1}" in *"/proc/meminfo"*) printf '%s\\n%s\\n' '${BOX_HOME}' '${BIG_KB}' ;; *"systemctl --user is-active"*) printf 'unit active\\nok install 3s\\n\\n' ;; *.base) cat > "${root}/base" ;; *) cat > /dev/null ;; esac`,
    )
    const repo = join(root, "repo")
    mkdirSync(repo)
    const env = {
      HOME: root,
      PATH: `${b}:/usr/bin:/bin`,
      RUNNER_HOST: "203.0.113.7",
      RUNNER_HOST_POLL: "0.1",
    }
    const git = (...args: string[]) => {
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: repo,
        env,
      })
    }
    git("init", "-q")
    commit(git, repo)
    const run = Bun.spawn(["bash", join(DIR, "ci.sh"), ...args(realpathSync(repo))], {
      cwd: repo,
      detached: true,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    })
    const calls = () =>
      existsSync(join(root, "ssh")) ? readFileSync(join(root, "ssh"), "utf8") : ""
    for (let i = 0; i < 200 && !calls().includes("systemctl --user is-active"); i++)
      await Bun.sleep(25)
    const argv = () =>
      existsSync(join(root, "argv")) ? readFileSync(join(root, "argv"), "utf8") : ""
    return { argv, calls, root, run }
  }
  const stop = (run: Bun.Subprocess) => {
    if (run.exitCode === null && run.signalCode === null) process.kill(-run.pid, "SIGKILL")
  }

  // go.py voids a run with a TERM to its process group; the box must not keep a unit queued for its slots
  test("a TERM to its group while the run waits stops the run's unit on the box", async () => {
    const { calls, run } = await startCi((git, repo) => {
      writeFileSync(join(repo, "a"), "a")
      git("add", "a")
      git("commit", "-q", "-m", "a")
    })
    try {
      expect(calls()).toContain("systemctl --user is-active")
      process.kill(-run.pid, "SIGTERM")
      expect(await run.exited).toBe(143)
      const unit = calls().match(/systemd-run .*--unit=(ci-\S+)/)?.[1]
      expect(unit).toBeTruthy()
      expect(calls()).toContain(`systemctl --user stop ${unit}`)
    } finally {
      stop(run)
    }
  })

  const oneFile = (git: (...args: string[]) => void, repo: string) => {
    writeFileSync(join(repo, "a"), "a")
    git("add", "a")
    git("commit", "-q", "-m", "a")
  }

  // run-slot's box runs are exec runs, and a TERM to one (TaskStop's first signal, an ending tool call) left its unit queued
  test("a TERM to its group while an exec run waits stops the run's unit on the box", async () => {
    const { calls, run } = await startCi(oneFile, (repo) => ["exec", repo, "--", "true"])
    try {
      process.kill(-run.pid, "SIGTERM")
      expect(await run.exited).toBe(143)
      const unit = calls().match(/systemd-run .*--unit=(ci-\S+)/)?.[1]
      expect(unit).toBeTruthy()
      expect(calls()).toContain(`systemctl --user stop ${unit}`)
    } finally {
      stop(run)
    }
  })

  // a SIGKILL runs no trap, so the box stops a run on its own once these touches stop
  test("the unit starts with a heartbeat, and every poll touches it", async () => {
    const { calls, run } = await startCi(oneFile)
    try {
      const id = calls().match(/systemd-run .*--unit=ci-(\S+)/)?.[1]
      expect(id).toBeTruthy()
      const lines = calls().split("\n")
      expect(lines.find((l) => l.includes("systemd-run"))).toStartWith(
        `touch ${BOX_CI}/${id}.beat && `,
      )
      const polls = lines.filter((l) => l.includes("systemctl --user is-active"))
      expect(polls.length).toBeGreaterThan(0)
      for (const poll of polls) expect(poll).toStartWith(`touch -c ${BOX_CI}/${id}.beat; `)
    } finally {
      stop(run)
    }
  })

  // 90 ci.sh processes polling every 20s opened 4 to 5 connections a second, past the box's MaxStartups
  test("every ssh shares one control connection, its socket under this user's home", async () => {
    const { argv, root, run } = await startCi(oneFile)
    try {
      const lines = argv().trim().split("\n")
      expect(lines.length).toBeGreaterThan(2)
      for (const line of lines) {
        expect(line).toContain("-o ControlMaster=auto")
        expect(line).toMatch(/-o ControlPersist=\d+/)
        expect(line).toContain(`-o ControlPath=${root}/.ssh/`)
      }
    } finally {
      stop(run)
    }
  })

  test("cancel stops the caller's own run by its id, and refuses anything that is not a run id", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-cancel-"))
    dirs.push(root)
    const b = join(root, "bin")
    mkdirSync(b)
    bin(b, "ssh", `printf '%s\\n' "\${@: -1}" >> "${root}/ssh"; echo inactive`)
    const env = { HOME: root, PATH: `${b}:/usr/bin:/bin`, RUNNER_HOST: "203.0.113.7" }
    const cancel = (id: string) =>
      Bun.spawnSync(["bash", join(DIR, "ci.sh"), "cancel", id], { cwd: root, env })
    const ok = cancel("0123456789ab-abcdef")
    expect(ok.exitCode).toBe(0)
    expect(readFileSync(join(root, "ssh"), "utf8")).toContain(
      "systemctl --user stop ci-0123456789ab-abcdef",
    )
    expect(ok.stdout.toString()).toBe("ci.sh: ci-0123456789ab-abcdef inactive\n")
    for (const bad of ["ci-0123456789ab-abcdef", "0123456789ab-abcdef; reboot", "*"]) {
      rmSync(join(root, "ssh"), { force: true })
      expect(cancel(bad).exitCode).toBe(2)
      expect(existsSync(join(root, "ssh"))).toBe(false)
    }
  })

  // the tree the box gets has no history, so suite.sh's audit reads canary's lockfile from the file ci.sh sends
  test("sends the lockfile at the head's merge base with origin/canary, not canary's later one, as the run's .base", async () => {
    const { calls, root, run } = await startCi((git, repo) => {
      const lock = (text: string, msg: string) => {
        writeFileSync(join(repo, "bun.lock"), text)
        git("add", "bun.lock")
        git("commit", "-q", "-m", msg)
      }
      lock("at the merge base", "base")
      git("checkout", "-q", "-b", "canary")
      lock("canary's later", "later")
      git("update-ref", "refs/remotes/origin/canary", "canary")
      git("checkout", "-q", "-b", "head", "HEAD~1")
      lock("the head's", "head")
    })
    try {
      const id = calls().match(/systemd-run .*--unit=ci-(\S+)/)?.[1]
      expect(id).toBeTruthy()
      expect(calls()).toContain(`cat > ${BOX_CI}/${id}.base`)
      expect(readFileSync(join(root, "base"), "utf8")).toBe("at the merge base")
    } finally {
      stop(run)
    }
  })
})
