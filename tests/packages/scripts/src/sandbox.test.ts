import { expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { MARKER, removeScratch } from "../../../../packages/safe-delete/src"
import {
  bwrapRefusal,
  insideBox,
  rootFiles,
  sandbox,
  wrap,
} from "../../../../packages/scripts/src/sandbox"

// Builds the sandbox while the parent reads Asia/Kolkata, as the Mac does, and returns the zone a Python child reports with that env plus the given overrides
const childZone = (overrides: Record<string, string> = {}) => {
  const parent = process.env.TZ
  process.env.TZ = "Asia/Kolkata"
  const { env, scratch } = sandbox()
  if (parent === undefined) delete process.env.TZ
  else process.env.TZ = parent
  try {
    const run = Bun.spawnSync(["python3", "-c", "import time; print(time.strftime('%Z'))"], {
      env: { ...env, ...overrides },
    })
    return run.stdout.toString().trim()
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
}

// a child's uv run --python 3.13 in a fresh scratch home downloaded a 66 MB CPython, which under load ran past the unstick tests' timeouts
test("the sandbox keeps uv's Pythons and cache the real home's, read before the swap", () => {
  const real = mkdtempSync(join(tmpdir(), "sandbox-real-uv-"))
  const parent = { HOME: process.env.HOME, PATH: process.env.PATH }
  writeFileSync(
    join(real, "uv"),
    `#!/bin/sh\ncase "$1" in cache) echo "$HOME/uv-cache" ;; python) echo "$HOME/uv-python" ;; esac\n`,
  )
  chmodSync(join(real, "uv"), 0o755)
  Object.assign(process.env, { HOME: real, PATH: `${real}:${parent.PATH}` })
  const { env, scratch } = sandbox()
  Object.assign(process.env, parent)
  try {
    expect([env.UV_CACHE_DIR, env.UV_PYTHON_INSTALL_DIR]).toEqual([
      join(real, "uv-cache"),
      join(real, "uv-python"),
    ])
  } finally {
    rmSync(real, { force: true, recursive: true })
    rmSync(scratch, { force: true, recursive: true })
  }
})

test("a child spawned in the sandbox reads UTC whatever the parent's zone", () => {
  expect(childZone()).toBe("UTC")
})

test("a child given its own TZ keeps it", () => {
  expect(childZone({ TZ: "Asia/Kolkata" })).toBe("IST")
})

test("a Python child in the sandbox leaves no __pycache__ behind", () => {
  const { env, scratch } = sandbox()
  try {
    writeFileSync(join(scratch, "mod.py"), "x = 1\n")
    const run = Bun.spawnSync(["python3", "-c", "import mod"], { cwd: scratch, env })
    expect(run.exitCode).toBe(0)
    expect(existsSync(join(scratch, "__pycache__"))).toBe(false)
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})

test("gh in the sandbox is its fake: gh repo create exits non-zero and names the sandbox, so no test reaches GitHub", () => {
  const { env, scratch } = sandbox()
  try {
    // resolved before it runs, so a sandbox without the fake fails here and never calls the real gh
    expect(Bun.which("gh", { PATH: env.PATH })).toBe(join(scratch, "bin", "gh"))
    const run = Bun.spawnSync(["gh", "repo", "create", "made-up/repo", "--private"], { env })
    expect(run.exitCode).toBe(99)
    expect(run.stderr.toString()).toContain("the test sandbox stopped a real gh call")
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})

// a test run on Linux once reached the user's live systemd manager through a real render and stopped four running ops jobs, so every tool that changes the live machine is a fake first on PATH
test.each(["herdr", "launchctl", "loginctl", "portless", "systemctl"])(
  "%s in the sandbox is its fake: it exits non-zero and names the sandbox, so no test reaches the live machine",
  (tool) => {
    const { env, scratch } = sandbox()
    try {
      // resolved before it runs, so a sandbox without the fake fails here and never calls the real tool
      expect(Bun.which(tool, { PATH: env.PATH })).toBe(join(scratch, "bin", tool))
      const run = Bun.spawnSync([tool, "--user", "stop", "com.playground.ops-tick.service"], {
        env,
      })
      expect(run.exitCode).toBe(99)
      expect(run.stderr.toString()).toContain(`the test sandbox stopped a real ${tool} call`)
    } finally {
      rmSync(scratch, { force: true, recursive: true })
    }
  },
)

// a parent shell that names the live proxy's folder, the user's bus or a herdr server (one ~/.zshrc set PORTLESS_STATE_DIR) never hands it to a test, which reads folders in its scratch alone
test("the sandbox's portless, runtime and herdr folders are in its scratch, whatever the parent sets", () => {
  const live = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    HERDR_CONFIG_PATH: "/live/herdr/config.toml",
    HERDR_SOCKET_PATH: "/live/herdr/playground.sock",
    PORTLESS_STATE_DIR: "/live/.portless",
    XDG_RUNTIME_DIR: "/run/user/1000",
  }
  const saved = Object.fromEntries(Object.keys(live).map((key) => [key, process.env[key]]))
  Object.assign(process.env, live)
  const { env, scratch } = sandbox()
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  try {
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(env.HERDR_CONFIG_PATH).toBe(join(scratch, "herdr", "config.toml"))
    expect(env.HERDR_SOCKET_PATH).toBe(join(scratch, "herdr", "herdr.sock"))
    expect(env.PORTLESS_STATE_DIR).toBe(join(scratch, "portless"))
    expect(env.XDG_RUNTIME_DIR).toBe(join(scratch, "run"))
    expect(existsSync(env.XDG_RUNTIME_DIR!)).toBe(true)
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})

// a test in an agent session read CLAUDECODE where CI's does not, so the sandbox drops it as it drops every other agent variable
test("the sandbox drops the caller's CLAUDECODE, so a test sees what CI sees", () => {
  const was = process.env.CLAUDECODE
  process.env.CLAUDECODE = "1"
  const { env, scratch } = sandbox()
  if (was === undefined) delete process.env.CLAUDECODE
  else process.env.CLAUDECODE = was
  try {
    expect(env.CLAUDECODE).toBeUndefined()
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})

// GitHub's runner refuses a user namespace inside the box, so a nested runner (test-sandbox.test.ts, a test:skills step's test:file) failed to start
test("a sandbox built inside the box runs argv as it is, keeping the outermost runner's pid", () => {
  if (!process.env.TEST_SANDBOX_HOME)
    throw new Error("run the suite through bun run test: the sandbox wraps it")
  const { env, scratch, wrap: boxed } = sandbox()
  try {
    expect(boxed(["bun", "test"])).toEqual(["bun", "test"])
    expect(env.TEST_SANDBOX_OUTER_PID).toBe(process.env.TEST_SANDBOX_OUTER_PID ?? "")
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})

// a box folder named by a variable alone, as a script outside the box could set it, holds no tmpfs in this process's mounts
test.skipIf(process.platform !== "linux")(
  "a TEST_SANDBOX_BOX set to a folder the box never mounted still boxes, or still refuses",
  () => {
    const fake = mkdtempSync(join(tmpdir(), "sandbox-fake-box-"))
    const was = process.env.TEST_SANDBOX_BOX
    process.env.TEST_SANDBOX_BOX = fake
    try {
      const { scratch, wrap: boxed } = sandbox()
      rmSync(scratch, { force: true, recursive: true })
      expect(boxed(["bun", "test"])[0]).toBe("bwrap")
    } catch (error) {
      expect(String(error)).toContain("the test sandbox's bwrap refused the box")
    } finally {
      if (was === undefined) delete process.env.TEST_SANDBOX_BOX
      else process.env.TEST_SANDBOX_BOX = was
      rmSync(fake, { force: true, recursive: true })
    }
  },
)

test("insideBox takes a tmpfs at the box folder of a marked scratch alone as proof", () => {
  const line = (point: string, type: string) =>
    `41 30 0:52 / ${point} rw,nosuid,nodev - ${type} ${type} rw`
  const marked = () => true
  expect(insideBox("/s/box", () => line("/s/box", "tmpfs"), marked)).toBe(true)
  expect(insideBox("/s/box", () => line("/s/other", "tmpfs"), marked)).toBe(false)
  expect(insideBox("/s/box", () => line("/s/box", "ext4"), marked)).toBe(false)
  expect(insideBox(undefined, () => line("/s/box", "tmpfs"), marked)).toBe(false)
  expect(insideBox("/dev/shm", () => line("/dev/shm", "tmpfs"))).toBe(false)
})

// /dev/shm is a tmpfs the system mounts outside any box, so a variable naming it alone must not read as the box
test.skipIf(process.platform !== "linux" || !existsSync("/dev/shm"))(
  "a TEST_SANDBOX_BOX naming a tmpfs the system mounted still boxes, or still refuses",
  () => {
    const was = process.env.TEST_SANDBOX_BOX
    process.env.TEST_SANDBOX_BOX = "/dev/shm"
    try {
      const { scratch, wrap: boxed } = sandbox()
      rmSync(scratch, { force: true, recursive: true })
      expect(boxed(["bun", "test"])[0]).toBe("bwrap")
    } catch (error) {
      expect(String(error)).toContain("the test sandbox's bwrap refused the box")
    } finally {
      if (was === undefined) delete process.env.TEST_SANDBOX_BOX
      else process.env.TEST_SANDBOX_BOX = was
    }
  },
)

test("on macOS wrap runs argv as it is", () => {
  expect(wrap(["bun", "test"], "/r", "/b", "darwin")).toEqual(["bun", "test"])
})

test("on Linux wrap runs argv under bwrap in a pid view, over each live folder that exists, ~/.ssh read-only and each root tool", () => {
  const home = mkdtempSync(join(tmpdir(), "sandbox-wrap-"))
  try {
    for (const dir of [".claude", ".playground", ".ssh", "elsewhere"]) mkdirSync(join(home, dir))
    const argv = wrap(["bun", "test"], "/r", "/b", "linux", home, 4242, {
      PLAYGROUND_DATA_DIR: join(home, "elsewhere"),
    })
    expect(argv.slice(0, 11)).toEqual([
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
    ])
    expect(argv.slice(11)).toEqual([
      "--tmpfs",
      "/b",
      "--tmpfs",
      join(home, ".claude"),
      "--tmpfs",
      join(home, "elsewhere"),
      "--tmpfs",
      join(home, ".playground"),
      "--ro-bind",
      join(home, ".ssh"),
      join(home, ".ssh"),
      ...rootFiles().flatMap((file) => ["--ro-bind", "/r", file]),
      "setsid",
      "--wait",
      "bun",
      "test",
    ])
  } finally {
    rmSync(home, { force: true, recursive: true })
  }
})

// bwrap cannot bind over a symlink, which GitHub's runner image makes /usr/bin/sudo, so every shard failed to start
test("each root tool is bound at its own file, a link's target once, and a missing one not at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-root-"))
  try {
    writeFileSync(join(dir, "real"), "")
    symlinkSync(join(dir, "real"), join(dir, "sudo"))
    expect(rootFiles([join(dir, "sudo"), join(dir, "real"), join(dir, "pkexec")])).toEqual([
      realpathSync(join(dir, "real")),
    ])
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

// macOS's /usr/bin/sudo is mode 4511, and bun's realpathSync opens the file, so it threw EACCES
test("a root tool this user cannot read is bound at its own file all the same", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-root-")))
  try {
    writeFileSync(join(dir, "real"), "")
    chmodSync(join(dir, "real"), 0o111)
    symlinkSync("real", join(dir, "sudo"))
    expect(rootFiles([join(dir, "sudo"), join(dir, "real")])).toEqual([join(dir, "real")])
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("a test's own fake gh ahead of the sandbox's answers instead", () => {
  const { env, scratch } = sandbox()
  try {
    const mine = join(scratch, "mine")
    mkdirSync(mine)
    writeFileSync(join(mine, "gh"), "#!/bin/sh\necho made-up-me\n")
    chmodSync(join(mine, "gh"), 0o755)
    const run = Bun.spawnSync(["gh", "api", "user"], {
      env: { ...env, PATH: `${mine}:${env.PATH}` },
    })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString().trim()).toBe("made-up-me")
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})

test("the sandbox is a marked scratch folder in the temp folder, which removeScratch removes (#545)", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-tmp-"))
  const was = process.env.TMPDIR
  process.env.TMPDIR = root
  try {
    const { scratch } = sandbox()
    expect(realpathSync(dirname(scratch))).toBe(realpathSync(root))
    expect(existsSync(join(scratch, MARKER))).toBe(true)
    expect(removeScratch(scratch, root)).toBeNull()
    expect(readdirSync(root)).toEqual([])
  } finally {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
    rmSync(root, { force: true, recursive: true })
  }
})

// bwrapRefusal under a PATH holding only a stand-in bwrap that prints `err` and exits with `code`, or no bwrap for null
const refusal = (probe: string[], code: number | null, err = "") => {
  const bin = mkdtempSync(join(tmpdir(), "sandbox-bwrap-"))
  if (code !== null) {
    writeFileSync(join(bin, "err"), `${err}\n`)
    writeFileSync(
      join(bin, "bwrap"),
      `#!/bin/sh\n/bin/cat "${join(bin, "err")}" >&2\nexit ${code}\n`,
    )
    chmodSync(join(bin, "bwrap"), 0o755)
  }
  const was = process.env.PATH
  process.env.PATH = bin
  try {
    return bwrapRefusal(probe)
  } finally {
    if (was === undefined) delete process.env.PATH
    else process.env.PATH = was
    rmSync(bin, { force: true, recursive: true })
  }
}

test("bwrapRefusal names the package only when bwrap is missing, and words a refusal by a bwrap that ran apart from it", () => {
  expect(refusal(["bwrap", "true"], 0)).toBeNull()
  expect(refusal(["bwrap", "true"], null)).toBe(
    "the test sandbox needs bwrap on Linux: install the bubblewrap package (sandbox.ts)",
  )
  const mount = "bwrap: Can't mount tmpfs on /newroot/x: No such file or directory"
  const refused = refusal(["bwrap", "true"], 1, mount)
  expect(refused).toContain(`the test sandbox's bwrap refused the box (${mount})`)
  expect(refused).not.toContain("install the bubblewrap package")
})

test("bwrapRefusal takes wrap's argv alone, whose program is bwrap", () => {
  expect(() => refusal(["setsid", "--wait", "true"], 0)).toThrow(
    "bwrapRefusal takes wrap's argv, whose program is bwrap",
  )
  expect(refusal(["/usr/bin/bwrap", "true"], 0)).toBeNull()
})
