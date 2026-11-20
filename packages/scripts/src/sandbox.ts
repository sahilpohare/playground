// The sandbox test-sandbox.ts and test-skills.ts run their children in: HOME and CLAUDE_CONFIG_DIR in a fresh scratch folder, PLAYGROUND_DATA_DIR unset so the data folder is the scratch HOME's ~/.playground, and a fake claude, gh, herdr, launchctl, loginctl, portless and systemctl first on PATH and a .gitconfig refusing git's network transports, so no test or check can start a real session, reach GitHub (make a repo, post a comment, read a remote with a real credential), close a live herdr pane, start or stop a live ops job or the live proxy, or write the real ~/.claude or ~/.playground; a test isolates through PLAYGROUND_DATA_DIR or a scratch HOME, since CLAUDE_CONFIG_DIR never places the data folder. TMPDIR is the scratch folder's short t folder, so every temp folder a test or its child makes with tmpdir() or a Python tempfile goes with the scratch, where those it left behind once held 24,008 entries in the caller's temp folder (issue 1306), and the short name keeps a Unix socket under it within macOS's 104-byte path cap. TZ=UTC, so a child reads the same zone on the Mac and the runner box; a child env that sets its own TZ keeps it. uv's Pythons and cache stay the real home's. PLAYGROUND_PROC names a folder that does not exist, so a machine reading a test leaves to Linux's /proc (packages/scripts/src/ops-machine/readings.ts) reads nothing on the Linux runner rather than its real load; a test of a Linux reading points it at recorded text. PYTHONDONTWRITEBYTECODE=1 keeps a Python child from leaving `__pycache__` in the worktree, where an ignored stale `.pyc` outlives its source. PORTLESS_STATE_DIR, XDG_RUNTIME_DIR, HERDR_CONFIG_PATH and HERDR_SOCKET_PATH name folders in the scratch, so a call that gets past a fake still finds no user bus or herdr server and writes none of portless's live state, though a real stop of portless's proxy still finds a proxy by its port; tests/live-tools-scan.test.ts fails on such a call in a test, and on Linux wrap (below) runs each child in a pid view of its own, which leaves it no live pid to signal. TEST_SANDBOX_HOME names the folder; each fake exits non-zero and names the sandbox, so a child that reaches one by mistake fails loudly, and a test that needs a tool's output puts its own fake ahead of it. Every other variable comes from the caller through SANDBOX_KEYS alone (boxEnv), so one naming live state by an absolute path, such as a herdr session, the user's DBUS_SESSION_BUS_ADDRESS or the data folder, never reaches a test, nor does a git hook's GIT_DIR or GIT_INDEX_FILE, which would turn a test's scratch git init or commit onto the real repository. The folder is a makeScratch folder, which the caller removes with removeScratch when its run ends.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { dataDirOf } from "@packages/env/data-dir"
import { MARKER, makeScratch } from "@packages/safe-delete"

import { BOX_ENV_KEYS, boxEnv } from "./box-env"

// The caller's variables a test or check still reads: the suite's own switches, Docker's socket and the URLs `test:e2e` passes; every other one, the live state an absolute path names included, stays out
export const SANDBOX_KEYS: readonly string[] = [
  ...BOX_ENV_KEYS,
  "CI",
  "CLOCK_AHEAD_DAYS",
  "DOCKER_HOST",
  "E2E_API_URL",
  "E2E_POSTGRES_URL",
  "E2E_WEB_URL",
  "NODE_ENV",
  "SKIP_ENV_VALIDATION",
]

export const sandbox = () => {
  const scratch = makeScratch("test-sandbox-")
  const home = join(scratch, "home")
  const bin = join(scratch, "bin")
  const tmp = join(scratch, "t")
  mkdirSync(home, { recursive: true })
  mkdirSync(bin)
  mkdirSync(tmp)
  const fake = (name: string, why: string) => {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "the test sandbox stopped a real ${name} call: ${why} (sandbox.ts)" >&2\nexit 99\n`,
    )
    chmodSync(join(bin, name), 0o755)
  }
  fake("claude", "no test may start a session")
  fake("gh", "no test may reach GitHub; put a fake gh ahead of it on PATH")
  // each of these changes the live machine: a herdr call can close a live session's pane, launchctl, loginctl and systemctl start or stop its ops jobs, and portless can stop or move the proxy every stack routes through
  const live: Record<string, string> = {
    herdr: "no test may reach a live herdr server",
    launchctl: "no test may load or stop a live launchd job",
    loginctl: "no test may change the user's login settings",
    portless: "no test may start, stop or install the live proxy",
    systemctl: "no test may start or stop a live systemd unit",
  }
  for (const [name, why] of Object.entries(live))
    fake(name, `${why}; put a fake ${name} ahead of it on PATH`)
  // the folders each tool reads its live state from
  const run = join(scratch, "run")
  mkdirSync(run)
  // a push scan's git ls-remote of a test's GitHub URL would otherwise reach GitHub with the credential helper's real token
  writeFileSync(
    join(home, ".gitconfig"),
    ["git", "http", "https", "ssh"].map((p) => `[protocol "${p}"]\n\tallow = never\n`).join(""),
  )
  // uv's Pythons and cache stay the real home's, read before the swap, so a child's `uv run --python 3.13` downloads no CPython into the scratch home (66 MB, which under load ran past the unstick tests' timeouts)
  const uvBin = Bun.which("uv", { PATH: process.env.PATH ?? "" })
  const uv = (what: string) =>
    uvBin ? Bun.spawnSync([uvBin, what, "dir"], { env: process.env }).stdout.toString().trim() : ""
  const env = boxEnv(
    home,
    {
      CLAUDE_CONFIG_DIR: join(scratch, "claude-config"),
      HERDR_CONFIG_PATH: join(scratch, "herdr", "config.toml"),
      HERDR_SOCKET_PATH: join(scratch, "herdr", "herdr.sock"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PLAYGROUND_PROC: join(scratch, "no-proc"),
      PORTLESS_STATE_DIR: join(scratch, "portless"),
      PYTHONDONTWRITEBYTECODE: "1",
      TEST_SANDBOX_HOME: scratch,
      TMPDIR: tmp,
      TZ: "UTC",
      UV_CACHE_DIR: uv("cache") || undefined,
      UV_PYTHON_INSTALL_DIR: uv("python") || undefined,
      XDG_RUNTIME_DIR: run,
    },
    SANDBOX_KEYS,
  )
  // a sandbox built inside the box (a test of the runner, a test:skills step's own test:file) adds no second one, since the outer box already holds its children and GitHub's runner refuses a user namespace inside one (measured); it keeps the caller's box folder, the proof insideBox reads
  const nested = process.platform === "linux" && insideBox()
  const box = nested ? process.env.TEST_SANDBOX_BOX! : join(scratch, "box")
  mkdirSync(box, { recursive: true })
  env.TEST_SANDBOX_BOX = box
  const boxed = process.platform === "linux" && !nested
  // the outermost runner's pid, which tests/sandbox.test.ts tries to signal, to show a test cannot reach a process outside the suite
  env.TEST_SANDBOX_OUTER_PID = process.env.TEST_SANDBOX_OUTER_PID ?? String(process.pid)
  // off PATH, since wrap binds it over each root tool's own path
  const refused = join(scratch, "root-refused")
  writeFileSync(
    refused,
    `#!/bin/sh\necho "the test sandbox stopped a real root call: no test may run a command as root (sandbox.ts)" >&2\nexit 99\n`,
  )
  chmodSync(refused, 0o755)
  if (boxed) {
    const why = bwrapRefusal(wrap(["true"], refused, box))
    if (why) throw new Error(why)
  }
  return { env, scratch, wrap: (argv: string[]) => (boxed ? wrap(argv, refused, box) : argv) }
}

// Whether this process runs inside the box, by proof a variable alone never gives: its own mounts hold the tmpfs wrap mounts at TEST_SANDBOX_BOX, in a scratch folder makeScratch marked, which no process outside the box sees, since only a namespace lets a user mount there; a TEST_SANDBOX_BOX naming a tmpfs the system mounted, such as /dev/shm, sits in no marked folder, so it and a TEST_SANDBOX_HOME set outside the box still box, or still refuse
export const insideBox = (
  box = process.env.TEST_SANDBOX_BOX,
  mounts = () => readFileSync("/proc/self/mountinfo", "utf8"),
  marked = (dir: string) => existsSync(join(dirname(dir), MARKER)),
): boolean => {
  if (!box || !marked(box)) return false
  return mounts()
    .split("\n")
    .some((line) => {
      const fields = line.split(" ")
      return fields[4] === box && fields[fields.indexOf("-") + 1] === "tmpfs"
    })
}

// The live state a full path reaches past a scratch HOME: the user's bus and keyring, Claude's own config, herdr's default server, the data folder with the factory's herdr sockets, and portless's folder
export const hidden = (home: string, uid: number, env: Record<string, string | undefined>) => [
  `/run/user/${uid}`,
  join(home, ".claude"),
  join(home, ".config", "herdr"),
  dataDirOf(env, home),
  join(home, ".playground"),
  join(home, ".portless"),
]

// The root tools a test could call by full path, where a fake first on PATH cannot reach
export const ROOT_TOOLS = ["/usr/bin/pkexec", "/usr/bin/sudo"]

// A file's own path past every link, resolving only its folder by realpath, since bun's realpathSync opens the file and so throws EACCES on one this user cannot read, as macOS's /usr/bin/sudo
const ownFile = (path: string): string =>
  lstatSync(path).isSymbolicLink()
    ? ownFile(resolve(realpathSync(dirname(path)), readlinkSync(path)))
    : join(realpathSync(dirname(path)), basename(path))

// Each root tool's own file, since bwrap cannot bind over a symlink and GitHub's runner image links /usr/bin/sudo to the binary it picks; a call by the link's path then reaches the stand-in too
export const rootFiles = (tools = ROOT_TOOLS) => [
  ...new Set(tools.filter((tool) => existsSync(tool)).map(ownFile)),
]

// On Linux each child runs under bwrap in a pid view of its own, so no test can signal a live process (portless's stop finds the live proxy's pid by its port and signals it), with an empty folder over each live one, the root stand-in over each root tool and ~/.ssh read-only; the host network stays, since the Docker tests reach their containers on 127.0.0.1, only a path that exists is mounted over, since bwrap would make a missing one on the real disk, and argv leads a process group of its own, as on macOS, since a group whose leader is bwrap outside the view reads as group 0 there (the dev launcher's record then names none); macOS runs argv as it is
export const wrap = (
  argv: string[],
  refused: string,
  box: string,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  uid = userInfo().uid,
  env: Record<string, string | undefined> = process.env,
): string[] => {
  if (platform !== "linux") return argv
  const over = [...new Set(hidden(home, uid, env))].filter((dir) => existsSync(dir))
  const ssh = join(home, ".ssh")
  return [
    "bwrap",
    "--bind",
    "/",
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "--tmpfs",
    box,
    ...over.flatMap((dir) => ["--tmpfs", dir]),
    ...(existsSync(ssh) ? ["--ro-bind", ssh, ssh] : []),
    ...rootFiles().flatMap((file) => ["--ro-bind", refused, file]),
    "setsid",
    "--wait",
    ...argv,
  ]
}

// Why bwrap cannot start the box here, or null, tried as wrap's own argv around a no-op: missing, or, once it ran, refused a user namespace (Ubuntu 24.04's AppArmor restriction, lifted by an AppArmor profile for bwrap) or one of wrap's mounts, so a Linux run fails at its start with this line rather than running any test unsandboxed
export const bwrapRefusal = (probe: string[]): string | null => {
  if (basename(probe[0] ?? "") !== "bwrap")
    throw new Error(`bwrapRefusal takes wrap's argv, whose program is bwrap, not ${probe[0]}`)
  const tool = Bun.which("bwrap", { PATH: process.env.PATH ?? "" })
  if (!tool)
    return "the test sandbox needs bwrap on Linux: install the bubblewrap package (sandbox.ts)"
  const run = Bun.spawnSync([tool, ...probe.slice(1)], {
    stderr: "pipe",
    stdout: "ignore",
  })
  if (run.exitCode === 0) return null
  const line = run.stderr.toString().trim().split("\n").at(-1) ?? ""
  return `the test sandbox's bwrap refused the box (${line}): where AppArmor restricts unprivileged user namespaces, give bwrap an AppArmor profile that allows them, else fix the mount its line names (sandbox.ts)`
}
