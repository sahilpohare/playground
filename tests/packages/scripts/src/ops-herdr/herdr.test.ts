import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  attachPlan,
  beat,
  CONFIG_SOURCE,
  configWarnings,
  cycle,
  envReport,
  herdrDir,
  leftOverLines,
  owedFile,
  pinFor,
  pinProblem,
  restoreEnv,
  restoreLines,
  restoreProblem,
  restoreResult,
  restoreSummary,
  runJob,
  serverEnv,
  serverNames,
  serverStatusLines,
  socketServers,
  startOnce,
  stateDir,
  statusLine,
  stopRefusal,
  type Pin,
} from "../../../../../packages/scripts/src/ops-herdr/herdr"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ops-herdr-"))
  dirs.push(dir)
  return dir
}

const PIN: Pin = {
  path: "/opt/homebrew/bin/herdr",
  sha256: "a".repeat(64),
  tag: "arm64_golden_gate",
  version: "0.9.5",
}

const ARM64 = "fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2"
const X64 = "5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369"
const DATA = { HOME: "/scratch/home" }

describe("serverEnv", () => {
  const shell = {
    CLAUDE_CODE_OAUTH_TOKEN: "secret-token",
    CLAUDE_CODE_SESSION_ID: "abc",
    CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    CMUX_SURFACE_ID: "surface:1",
    GH_TOKEN: "ghp_secret",
    HOME: "/Users/me",
    LANG: "en_GB.UTF-8",
    LOGNAME: "me",
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
    TERM: "xterm-ghostty",
    USER: "me",
  }

  test("keeps the seven basics and herdr's own three, and no other name", () => {
    const env = serverEnv(shell, "/Users/me/.playground/herdr", "factory")
    expect(Object.keys(env).toSorted()).toEqual([
      "HERDR_CONFIG_PATH",
      "HERDR_SESSION",
      "HERDR_SOCKET_PATH",
      "HOME",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TERM",
      "USER",
    ])
    expect(env.HERDR_SESSION).toBe("factory")
    expect(env.HERDR_SOCKET_PATH).toBe("/Users/me/.playground/herdr/factory.sock")
    expect(env.HERDR_CONFIG_PATH).toBe("/Users/me/.playground/herdr/config.toml")
    expect(envReport(env).forbidden).toEqual([])
  })

  test("fills TERM and LANG when a login item starts it with neither", () => {
    const { LANG: _lang, TERM: _term, ...bare } = shell
    const env = serverEnv(bare, "/d", "probes")
    expect(env.TERM).toBe("xterm-256color")
    expect(env.LANG).toBe("en_US.UTF-8")
  })

  // A start from a GUI app or env -i carries no SHELL, USER or LOGNAME, so the server takes this uid's account and login shell from the platform's own reader, each a fake inside the sandbox.
  const uid = process.getuid?.()
  const { LOGNAME: _logname, SHELL: _shell, USER: _user, ...bare } = shell
  const program = (dir: string, name: string, lines: string[]) => {
    const file = join(dir, name)
    writeFileSync(file, ["#!/bin/sh", ...lines, "exit 0"].join("\n"))
    chmodSync(file, 0o755)
    return file
  }
  const passwdLine = `someone:x:${uid}:20:Some One:/home/someone:/bin/made-up-sh`

  test.each([
    [
      "macOS, through dscl",
      "darwin",
      (dir: string) => ({
        PLAYGROUND_DSCL: program(dir, "dscl", [
          `[ "$1 $2 $3 $4 $5" = ". -search /Users UniqueID ${uid}" ] && printf 'someone\\t\\tUniqueID = (\\n    1\\n)\\n'`,
          '[ "$1 $2 $3 $4" = ". -read /Users/someone UserShell" ] && echo "UserShell: /bin/made-up-sh"',
        ]),
      }),
    ],
    [
      "Linux, through getent passwd",
      "linux",
      (dir: string) => ({
        PLAYGROUND_GETENT: program(dir, "getent", [
          `[ "$1 $2" = "passwd ${uid}" ] && echo '${passwdLine}'`,
        ]),
        PLAYGROUND_PASSWD: join(dir, "no-passwd"),
      }),
    ],
    [
      "Linux, from /etc/passwd where getent does not answer",
      "linux",
      (dir: string) => {
        const passwd = join(dir, "passwd")
        writeFileSync(
          passwd,
          `root:x:0:0:root:/root:/bin/bash\n${passwdLine}\nother:x:${Number(uid) + 1}:20::/home/other:/bin/sh\n`,
        )
        return { PLAYGROUND_GETENT: join(dir, "no-getent"), PLAYGROUND_PASSWD: passwd }
      },
    ],
  ] as const)("on %s, the server gets this uid's account and login shell", (_, platform, fakes) => {
    const dir = scratch()
    const env = { ...bare, ...fakes(dir), TEST_SANDBOX_HOME: dir }
    const found = serverEnv(env, "/d", "factory", platform)
    expect([found.SHELL, found.USER, found.LOGNAME]).toEqual([
      "/bin/made-up-sh",
      "someone",
      "someone",
    ])
    expect(serverEnv({ ...env, ...shell, SHELL: "/bin/bash" }, "/d", "p", platform)).toMatchObject({
      LOGNAME: "me",
      SHELL: "/bin/bash",
      USER: "me",
    })
  })

  test.each([
    [
      "darwin",
      { PLAYGROUND_DSCL: "no-dscl" },
      `dscl . -read /Users/<name> UserShell for uid ${uid}`,
    ],
    [
      "linux",
      { PLAYGROUND_GETENT: "no-getent", PLAYGROUND_PASSWD: "no-passwd" },
      `getent passwd ${uid} or `,
    ],
  ] as const)(
    "on %s with no login shell to read, the start is refused naming where it looked, never a guessed shell",
    (platform, missing, source) => {
      const dir = scratch()
      const env = {
        ...bare,
        ...Object.fromEntries(Object.entries(missing).map(([k, v]) => [k, join(dir, v)])),
        TEST_SANDBOX_HOME: dir,
      }
      expect(() => serverEnv(env, "/d", "factory", platform)).toThrow(
        `no login shell: SHELL is unset and ${source}`,
      )
    },
  )

  // Outside the sandbox the fakes are ignored: this machine's own reader answers.
  test("outside the test sandbox no fake is read", () => {
    const dir = scratch()
    const dscl = program(dir, "dscl", ['echo "UserShell: /bin/made-up-sh"'])
    const getent = program(dir, "getent", [`echo '${passwdLine}'`])
    const outside = serverEnv(
      { ...bare, PLAYGROUND_DSCL: dscl, PLAYGROUND_GETENT: getent },
      "/d",
      "factory",
    )
    expect(outside.SHELL).not.toBe("/bin/made-up-sh")
    expect(outside.SHELL).toStartWith("/")
    expect(outside.USER).not.toBe("someone")
  })
})

describe("herdrDir", () => {
  test("follows HOME, as herdr's state does, whatever Claude login the caller is on", () => {
    expect(herdrDir({ CLAUDE_CONFIG_DIR: "/Users/me/.claude-pride", HOME: "/Users/me" })).toBe(
      "/Users/me/.playground/herdr",
    )
  })

  test("moves to a scratch folder for a drill", () => {
    expect(herdrDir({ PLAYGROUND_HERDR_DIR: "/tmp/scratch", HOME: "/Users/me" })).toBe(
      "/tmp/scratch",
    )
  })
})

describe("serverNames", () => {
  test("lists both servers by default", () => {
    expect(serverNames({})).toEqual({ sessions: ["playground", "playground-probes"], skipped: [] })
  })

  // herdr keeps a server's state by its name alone, so Playground's servers named factory and probes restored the factory's own saved layout on a Mac that runs both
  test("each default server keeps its state in a folder of its own, never the factory's", () => {
    const theirs = ["factory", "probes"].map((name) => stateDir("/Users/me", name))
    for (const session of serverNames({}).sessions) {
      expect(stateDir("/Users/me", session)).toBe(`/Users/me/.config/herdr/sessions/${session}`)
      expect(theirs).not.toContain(stateDir("/Users/me", session))
    }
  })

  test("keeps each word from the list and skips any other name", () => {
    expect(serverNames({ PLAYGROUND_HERDR_SESSIONS: "factory,../x,probes,Probes" })).toEqual({
      sessions: ["factory", "probes"],
      skipped: ["../x", "Probes"],
    })
  })

  test("skips default, herdr's own server, so the job never starts or restores it", () => {
    expect(serverNames({ PLAYGROUND_HERDR_SESSIONS: "factory,default" })).toEqual({
      sessions: ["factory"],
      skipped: ["default"],
    })
  })
})

describe("socketServers", () => {
  test("names each server on a socket in the folder, an old name's included, and no client's socket or herdr's default", () => {
    expect(
      socketServers([
        "config.toml",
        "default.sock",
        "factory.sock",
        "pin.json",
        "playground-client.sock",
        "playground-probes.sock",
        "playground.out",
        "playground.sock",
        "Bad.sock",
      ]),
    ).toEqual(["factory", "playground", "playground-probes"])
  })
})

describe("leftOverLines", () => {
  const sessions = ["playground", "playground-probes"]
  const servers = ["factory", "playground", "playground-probes", "probes"]

  test("an old-named server still running in the folder gets one line naming the stop, and is left running", () => {
    expect(leftOverLines(servers, sessions, ["factory", "playground"], "/h")).toEqual([
      "Left for you: herdr server factory still runs from an older Playground in /h, beside the current ones; playground herdr stop stops every server there, then playground starts the current ones",
    ])
  })

  test("none running, or only the current ones, gives no line", () => {
    expect(leftOverLines(servers, sessions, [], "/h")).toEqual([])
    expect(leftOverLines(servers, sessions, sessions, "/h")).toEqual([])
  })
})

describe("envReport", () => {
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "secret-token",
    CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    HOME: "/Users/me",
  }

  test("names a CLAUDE_CODE_ or CMUX_ variable as forbidden", () => {
    expect(envReport(env).forbidden).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CMUX_SOCKET_PATH"])
  })

  test("lists names and lengths only, never a value", () => {
    const { lines } = envReport(env)
    expect(lines).toEqual(["CLAUDE_CODE_OAUTH_TOKEN 12", "CMUX_SOCKET_PATH 14", "HOME 9"])
    expect(lines.join("\n")).not.toContain("secret-token")
    expect(lines.join("\n")).not.toContain("/Users/me")
  })
})

describe("stopRefusal", () => {
  test("refuses a stop while a pane is live, naming it", () => {
    const panes = {
      result: {
        panes: [
          { cwd: "/Users/me/dispatcher", pane_id: "w1:p1" },
          { agent: "worker-keen-loom", cwd: "/Users/me/x", pane_id: "w2:p1" },
        ],
        type: "pane_list",
      },
    }
    const refusal = stopRefusal("factory", panes)
    expect(refusal).toContain("refusing to stop factory")
    expect(refusal).toContain("w1:p1 (/Users/me/dispatcher)")
    expect(refusal).toContain("worker-keen-loom (/Users/me/x)")
  })

  test("allows a stop with no pane", () => {
    expect(stopRefusal("probes", { result: { panes: [], type: "pane_list" } })).toBeNull()
  })

  test("refuses when the pane list does not read", () => {
    expect(stopRefusal("factory", { error: "socket" })).toContain("cannot read")
  })

  test("stops the default server over a shell pane, and refuses while one of its panes runs an agent", () => {
    const shell = { cwd: "/Users/me/notes", pane_id: "w1:p1" }
    expect(stopRefusal("default", { result: { panes: [shell] } })).toBeNull()
    const claude = { agent: "claude", cwd: "/Users/me/x", pane_id: "w1:p2" }
    expect(stopRefusal("default", { result: { panes: [shell, claude] } })).toBe(
      "refusing to stop default: 1 live, claude (/Users/me/x)",
    )
    expect(stopRefusal("factory", { result: { panes: [shell] } })).toContain("1 live")
  })

  test("reads a default-server pane with no agent key, as herdr 0.9.5 sends a shell pane, as no one's work", () => {
    const shell = { cwd: "/Users/me/y", pane_id: "w1:p3" }
    expect(stopRefusal("default", { result: { panes: [shell] } })).toBeNull()
  })
})

describe("pinProblem", () => {
  test("passes the pinned version and hash", () => {
    expect(pinProblem(PIN, { sha256: PIN.sha256, version: "0.9.5" })).toBeNull()
  })

  test("names both when the binary's hash changed", () => {
    const problem = pinProblem(PIN, { sha256: "b".repeat(64), version: "0.9.5" })
    expect(problem).toContain("a".repeat(64))
    expect(problem).toContain("b".repeat(64))
  })

  test("names both when the version changed", () => {
    const problem = pinProblem(PIN, { sha256: PIN.sha256, version: "0.9.6" })
    expect(problem).toContain("0.9.5")
    expect(problem).toContain("0.9.6")
  })

  test("names a binary that is missing", () => {
    expect(pinProblem(PIN, null)).toContain("/opt/homebrew/bin/herdr")
  })

  test("refuses a machine the pin names no release asset for", () => {
    const pin = pinFor(DATA, null)
    const problem = pinProblem(pin, { sha256: ARM64, version: "0.9.5" })
    expect(problem).toContain("sha256 for release asset")
    expect(pinProblem(pin, { sha256: "", version: "0.9.5" })).not.toBeNull()
  })

  test("refuses another asset's binary", () => {
    const pin = pinFor(DATA, "darwin-arm64")
    expect(pinProblem(pin, { sha256: ARM64, version: "0.9.5" })).toBeNull()
    expect(pinProblem(pin, { sha256: X64, version: "0.9.5" })).toContain(X64)
  })
})

// A restore with every session back or failed, none a gate holds.
const DONE = { owed: false, problem: null }

describe("cycle", () => {
  const deps = (
    found: { sha256: string; version: string } | null,
    up: boolean | ((session: string) => boolean),
  ) => {
    const started: string[] = []
    const restores: string[] = []
    const owed = new Set<string>()
    return {
      restores,
      started,
      value: {
        found: async () => found,
        log: async () => null,
        owed: (session: string) => ({
          get: async () => owed.has(session),
          set: async (value: boolean) => void (value ? owed.add(session) : owed.delete(session)),
        }),
        pin: PIN,
        restore: async (session: string) => {
          restores.push(session)
          return DONE
        },
        running: async (session: string) => (typeof up === "function" ? up(session) : up),
        sessions: ["factory", "probes"],
        skipped: [] as string[],
        start: async (session: string) => {
          started.push(session)
          return null
        },
      },
    }
  }

  test("starts each session that is down", async () => {
    const { started, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    expect(await cycle(value)).toBe("ok")
    expect(started).toEqual(["factory", "probes"])
  })

  test("runs spawn.sh restore for each server it starts", async () => {
    const { restores, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    expect(await cycle(value)).toBe("ok")
    expect(restores).toEqual(["factory", "probes"])
  })

  test("a killed probes server comes back with its own sessions, the factory's left running", async () => {
    let probesUp = false
    const { restores, started, value } = deps(
      { sha256: PIN.sha256, version: "0.9.5" },
      (session) => session === "factory" || probesUp,
    )
    const job = {
      ...value,
      start: async (session: string) => {
        started.push(session)
        probesUp = true
        return null
      },
    }
    expect(await cycle(job)).toBe("ok")
    expect(started).toEqual(["probes"])
    expect(restores).toEqual(["probes"])
    expect(await value.owed("probes").get()).toBe(false)
  })

  test("names each name in the list that is not a server's, and checks the rest", async () => {
    const { started, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    expect(await cycle({ ...value, sessions: ["factory"], skipped: ["../x"] })).toBe(
      "../x: not a herdr server name (a word of a-z, 0-9 and -), skipped",
    )
    expect(started).toEqual(["factory"])
  })

  test("never restores a server that was already running", async () => {
    const { restores, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, true)
    expect(await cycle(value)).toBe("ok")
    expect(restores).toEqual([])
  })

  test("restores again each cycle while a session waits on a gate, then stops", async () => {
    const { restores, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    const answers = [
      { owed: true, problem: "restore: not restored worker-a: its brief is gone" },
      DONE,
    ]
    let up = false
    const job = {
      ...value,
      restore: async () => {
        restores.push("restore")
        return answers.shift() ?? DONE
      },
      running: async () => up,
      start: async () => {
        up = true
        return null
      },
    }
    expect(await cycle({ ...job, sessions: ["factory"] })).toBe(
      "factory: restore: not restored worker-a: its brief is gone",
    )
    expect(await cycle({ ...job, sessions: ["factory"] })).toBe("ok")
    expect(await cycle({ ...job, sessions: ["factory"] })).toBe("ok")
    expect(restores).toEqual(["restore", "restore"])
  })

  // #1682: the owed file is there for the home to read as the factory coming back, so it stays while a gate holds a session, and goes once none does.
  test("keeps the restore owed while a gate holds a session, with no problem, and clears it once none waits", async () => {
    const { restores, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    const log = "/h/factory.restore.log"
    const answers = [
      restoreResult(0, "restored dispatcher\nwaiting a-worker: the load gate holds it: x\n", log),
      restoreResult(0, "restored a-worker\n", log),
    ]
    let up = false
    const job = {
      ...value,
      restore: async () => {
        restores.push("restore")
        return answers.shift() ?? DONE
      },
      running: async () => up,
      start: async () => {
        up = true
        return null
      },
      sessions: ["factory"],
    }
    expect(await cycle(job)).toBe("ok")
    expect(await value.owed("factory").get()).toBe(true)
    expect(await cycle(job)).toBe("ok")
    expect(await value.owed("factory").get()).toBe(false)
    expect(await cycle(job)).toBe("ok")
    expect(restores).toEqual(["restore", "restore"])
  })

  test("a real failure with no session waiting is named once and clears the restore", async () => {
    const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    const failed = restoreResult(1, "not restored a-worker: its brief is gone\n", "/h/p.log")
    expect(await cycle({ ...value, restore: async () => failed, sessions: ["factory"] })).toBe(
      "factory: restore: 1 not restored; each session's line: /h/p.log",
    )
    expect(await value.owed("factory").get()).toBe(false)
  })

  // #1682 round 1: focus ends by itself, so a session it holds waits like a gate's, and comes back once focus ends.
  test("keeps the restore owed while focus holds a session, with no problem", async () => {
    const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    const held = restoreResult(
      0,
      "waiting a-worker: focus stands for other-worker, so no new session starts until it ends\n",
      "/h/p.log",
    )
    expect(await cycle({ ...value, restore: async () => held, sessions: ["factory"] })).toBe("ok")
    expect(await value.owed("factory").get()).toBe(true)
  })

  test("a restore that tried no session, another's lock or an unreadable roster, is named and stays owed", async () => {
    for (const said of [
      "a restore is already running (pid 4242), so this one stops; nothing is wrong\n",
      "spawn.sh refuses restore: it cannot read the roster or the resume files\n",
    ]) {
      const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
      const failed = restoreResult(1, said, "/h/p.log")
      expect(await cycle({ ...value, restore: async () => failed, sessions: ["factory"] })).toBe(
        `factory: restore: ${said.trim()}`,
      )
      expect(await value.owed("factory").get()).toBe(true)
    }
  })

  test("finishes a restore another process owed, on a server it found running", async () => {
    const { restores, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, true)
    await value.owed("factory").set(true)
    expect(await cycle(value)).toBe("ok")
    expect(restores).toEqual(["factory"])
    expect(await value.owed("factory").get()).toBe(false)
  })

  test("owes the restore before a start that gives up while the server still comes up", async () => {
    const { restores, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    let up = false
    const job = {
      ...value,
      running: async () => up,
      start: async () => {
        up = true
        return "started, but its status did not read running within 10s"
      },
    }
    expect(await cycle({ ...job, sessions: ["factory"] })).toBe(
      "factory: started, but its status did not read running within 10s",
    )
    expect(restores).toEqual([])
    expect(await cycle({ ...job, sessions: ["factory"] })).toBe("ok")
    expect(restores).toEqual(["factory"])
    expect(await value.owed("factory").get()).toBe(false)
  })

  test("a restore that throws is named, and the next server is still checked", async () => {
    const { started, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
    const job = {
      ...value,
      restore: async () => {
        throw new Error("spawn failed")
      },
    }
    expect(await cycle(job)).toBe("factory: restore: spawn failed; probes: restore: spawn failed")
    expect(started).toEqual(["factory", "probes"])
    expect(await value.owed("factory").get()).toBe(true)
    expect(await value.owed("probes").get()).toBe(true)
  })

  test("refuses to start on a changed binary, naming both", async () => {
    const { started, value } = deps({ sha256: "b".repeat(64), version: "0.9.5" }, false)
    const result = await cycle(value)
    expect(started).toEqual([])
    expect(result).toContain("b".repeat(64))
  })

  test("names a changed binary on a beat and never restarts a running server", async () => {
    const { started, value } = deps({ sha256: "b".repeat(64), version: "0.9.6" }, true)
    const result = await cycle(value)
    expect(started).toEqual([])
    expect(result).toContain("0.9.6")
  })

  test("names the server log's config warnings", async () => {
    const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, true)
    const log = [
      "2026-10-18T00:39:03Z  INFO herdr::server::headless::bootstrap: herdr server started api_socket=/x",
      "2026-10-18T00:39:04Z  WARN herdr::config::keybinds: config diagnostic invalid keybinding: keys.prefix; using fallback ctrl+b",
    ].join("\n")
    const result = await cycle({
      ...value,
      log: async (s: string) => (s === "factory" ? log : null),
    })
    expect(result).toContain("factory: invalid keybinding: keys.prefix; using fallback ctrl+b")
  })

  test("names a binary that cannot run, and still reads every session", async () => {
    const { value } = deps(null, true)
    const result = await cycle({
      ...value,
      running: async () => {
        throw new Error("ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/herdr'")
      },
    })
    expect(result).toContain("cannot be read")
    expect(result).toContain("factory: cannot read its status: ENOENT")
    expect(result).toContain("probes: cannot read its status: ENOENT")
  })

  test("names a check that throws rather than throwing", async () => {
    const { value } = deps(null, true)
    const result = await cycle({
      ...value,
      found: async () => {
        throw new Error("EACCES")
      },
    })
    expect(result).toBe("EACCES")
  })

  describe("startOnce", () => {
    test("names each server it started, then ok", async () => {
      const { started, value } = deps(
        { sha256: PIN.sha256, version: "0.9.5" },
        (session) => session === "probes",
      )
      expect(await startOnce(value)).toEqual({ lines: ["started factory", "ok"], ok: true })
      expect(started).toEqual(["factory"])
    })

    test("says every server was up when it started none", async () => {
      const { started, value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, true)
      expect(await startOnce(value)).toEqual({
        lines: ["all were up: factory, probes"],
        ok: true,
      })
      expect(started).toEqual([])
    })

    test("names a failing restore's counts once, with its log", async () => {
      const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, (s) => s === "probes")
      const log = "/h/factory.restore.log"
      const job = { ...value, restore: async () => restoreResult(1, AFTER_BOOT, log) }
      const { lines, ok } = await startOnce(job)
      expect(ok).toBe(false)
      expect(lines).toEqual([
        "started factory",
        `factory: restore: 1 restored · 2 already running · 2 down in the roster · 1 passed over · 3 waiting for load to drop · 1 waiting on the usage gate · 1 not restored (the waiting ones come back on their own); each session's line: ${log}`,
      ])
    })

    // #1682: Start prints the restore's waits as progress and exits 0, and a real failure still fails it.
    test("a restore a gate alone held is progress: ok, and its line names the waits", async () => {
      const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, (s) => s === "probes")
      const log = "/h/factory.restore.log"
      const output = "restored dispatcher\nwaiting a-worker: the load gate holds it: x\n"
      const job = { ...value, restore: async () => restoreResult(0, output, log) }
      expect(await startOnce(job)).toEqual({ lines: ["started factory", "ok"], ok: true })
      expect(restoreLines("factory", 0, output, log)).toEqual([
        `restore factory: 1 restored · 1 waiting for load to drop (the waiting ones come back on their own); each session's line: ${log}`,
      ])
    })

    test("names a start that failed, the others it started kept", async () => {
      const { value } = deps({ sha256: PIN.sha256, version: "0.9.5" }, false)
      const job = {
        ...value,
        start: async (session: string) => (session === "probes" ? "no socket after 10s" : null),
      }
      expect(await startOnce(job)).toEqual({
        lines: ["started factory", "probes: no socket after 10s"],
        ok: false,
      })
    })
  })
})

describe("runJob", () => {
  test("beats a changed binary rather than exiting before the first beat", async () => {
    const path = join(scratch(), "ops-herdr.json")
    const stop = runJob(
      {
        found: async () => ({ sha256: "b".repeat(64), version: "0.9.6" }),
        log: async () => null,
        owed: () => ({ get: async () => false, set: async () => {} }),
        pin: PIN,
        restore: async () => DONE,
        running: async () => false,
        sessions: ["factory"],
        skipped: [],
        start: async () => null,
      },
      path,
      60_000,
    )
    try {
      for (let i = 0; i < 50 && !(await Bun.file(path).exists()); i++) await Bun.sleep(20)
      const written = JSON.parse(await readFile(path, "utf8")) as { lastResult: string }
      expect(written.lastResult).toContain("0.9.6")
      expect(written.lastResult).toContain("factory: down, not started on an unpinned binary")
    } finally {
      stop()
    }
  })
})

describe("restoreEnv", () => {
  test("keeps the caller's environment and points spawn.sh at the server it started", () => {
    const env = restoreEnv({ HOME: "/Users/me", PATH: "/usr/bin" }, "/d", "factory")
    expect(env).toEqual({
      PLAYGROUND_HERDR_DIR: "/d",
      PLAYGROUND_HERDR_SESSION: "factory",
      HOME: "/Users/me",
      PATH: "/usr/bin",
    })
  })
})

describe("owedFile", () => {
  test("holds a restore owed across processes, beside the server's socket", async () => {
    const dir = scratch()
    const owed = owedFile(dir, "factory")
    expect(await owed.get()).toBe(false)
    await owed.set(true)
    expect(await Bun.file(join(dir, "factory.restore")).exists()).toBe(true)
    expect(await owedFile(dir, "factory").get()).toBe(true)
    await owed.set(false)
    expect(await owed.get()).toBe(false)
    await owed.set(false)
  })
})

// spawn.sh restore's lines for a server after a reboot: one back, two running, two the roster keeps down, one passed over, one the usage gate holds, three the load gate holds, one that failed.
const AFTER_BOOT = [
  "restored a-worker",
  "skipped b-worker: live",
  "skipped c-worker: live",
  "skipped i-worker: its roster row reads ended",
  "skipped j-worker: its roster row reads parked",
  "skipped k-worker: its exec line does not parse",
  "waiting g-worker: the usage gate holds it: the 5-hour window is at 90% (usage.json five_hour.used_percentage), 90 is its cap",
  ...["d", "e", "f"].map(
    (id) =>
      `waiting ${id}-worker: the load gate holds it: max(load1, load5) is 17.23 and 10 started in the last 5 minutes. Wait for it to fall, or close a session that is done, and run it again.`,
  ),
  "not restored h-worker: its brief is gone",
].join("\n")

describe("restoreSummary", () => {
  test("counts each kind of line, the gates' waits apart from the failures and in A to Z order", () => {
    expect(restoreSummary(`${AFTER_BOOT}\n`)).toBe(
      "1 restored · 2 already running · 2 down in the roster · 1 passed over · 3 waiting for load to drop · 1 waiting on the usage gate · 1 not restored (the waiting ones come back on their own)",
    )
  })

  test("leaves out a kind with none", () => {
    expect(restoreSummary("restored a-worker\nskipped b-worker: live\n")).toBe(
      "1 restored · 1 already running",
    )
  })

  test("is null for output with no session line, a refusal before any session", () => {
    expect(restoreSummary("spawn.sh refuses restore: it cannot read the roster\n")).toBeNull()
    expect(restoreSummary("")).toBeNull()
  })
})

describe("restoreLines", () => {
  test("prints one summary line for a restore that passed, naming the file that holds each session's line", () => {
    const passed = "restored a-worker\nskipped b-worker: live\n"
    expect(restoreLines("playground", 0, passed, "/h/playground.restore.log")).toEqual([
      "restore playground: 1 restored · 1 already running; each session's line: /h/playground.restore.log",
    ])
  })

  test("prints nothing for a restore that failed, whose problem the cycle names once", () => {
    expect(restoreLines("playground", 1, AFTER_BOOT, "/h/playground.restore.log")).toEqual([])
    expect(restoreLines("playground", 1, "spawn.sh refuses restore: x\n", "/h/p.log")).toEqual([])
  })
})

describe("restoreResult", () => {
  test("a wait alone is no problem, and keeps the restore owed", () => {
    const output =
      "restored a\nwaiting b: the load gate holds it: x\nwaiting c: the usage gate holds it: y\n"
    expect(restoreResult(0, output, "/h/p.log")).toEqual({ owed: true, problem: null })
  })

  test("a real failure is a problem, owed only while a session also waits", () => {
    expect(restoreResult(1, "not restored a: its brief is gone\n", "/h/p.log")).toEqual({
      owed: false,
      problem: "restore: 1 not restored; each session's line: /h/p.log",
    })
    expect(restoreResult(1, AFTER_BOOT, "/h/p.log").owed).toBe(true)
  })

  test("a line that names a gate but does not wait keeps nothing owed", () => {
    expect(restoreResult(0, "skipped a: the load gate holds it\n", "/h/p.log").owed).toBe(false)
    expect(
      restoreResult(
        1,
        "not restored a: the load gate holds it: PLAYGROUND_LOAD_MULT is abc\n",
        "/h/p.log",
      ).owed,
    ).toBe(false)
  })
})

describe("restoreProblem", () => {
  test("passes a restore that exits 0", () => {
    expect(restoreProblem(0, "restored worker-a\nskipped worker-b: live\n", "/h/p.log")).toBeNull()
  })

  test("names counts and the log, never the joined lines", () => {
    const output = "restored worker-a\nnot restored worker-b: x\nnot restored worker-c: y\n"
    expect(restoreProblem(1, output, "/h/p.log")).toBe(
      "restore: 1 restored · 2 not restored; each session's line: /h/p.log",
    )
  })

  test("names the last line of a restore that failed before any session", () => {
    expect(
      restoreProblem(
        1,
        "spawn.sh refuses restore: it cannot read the roster or the resume files\n",
        "/h/p.log",
      ),
    ).toBe("restore: spawn.sh refuses restore: it cannot read the roster or the resume files")
  })

  test("names an exit with no output by its code", () => {
    expect(restoreProblem(2, "", "/h/p.log")).toBe("restore: exited 2")
  })
})

const lines = (log: string[], count: number) => log.slice(0, count).join("\n")

describe("configWarnings", () => {
  test("reads only the warnings since the server's last start", () => {
    const log = [
      "2026-10-17T10:00:00Z  WARN herdr::config::io: config parse error, using defaults err=old",
      "2026-10-18T00:39:03Z  INFO herdr::server::headless::bootstrap: herdr server started api_socket=/x",
      "2026-10-18T00:39:09Z  WARN herdr::config::io: config parse error, using defaults err=TOML parse error at line 18, column 26",
      "   |",
      "2026-10-18T00:39:10Z  WARN herdr::persist::io: not a config line",
    ].join("\n")
    expect(configWarnings(log)).toEqual([
      "config parse error, using defaults err=TOML parse error at line 18, column 26",
    ])
  })

  test("reads only the warnings since the last reload, so a fixed config clears", () => {
    const log = [
      "2026-10-18T01:45:38Z  INFO herdr::server::headless::bootstrap: herdr server started api_socket=/x",
      '2026-10-18T01:45:49Z  INFO herdr::logging: api request received event="api.request.start" subsystem="api" outcome="started" request_id="cli:server:reload-config" method="server.reload_config" changes_ui=true',
      "2026-10-18T01:45:49Z  WARN herdr::config::keybinds: config diagnostic invalid keybinding: keys.prefix; using fallback ctrl+b",
      '2026-10-18T01:45:49Z  INFO herdr::logging: api request completed event="api.request.complete" subsystem="api" outcome="ok" request_id="cli:server:reload-config" method="server.reload_config"',
      '2026-10-18T01:45:51Z  INFO herdr::logging: api request received event="api.request.start" subsystem="api" outcome="started" request_id="cli:server:reload-config" method="server.reload_config" changes_ui=true',
      '2026-10-18T01:45:51Z  INFO herdr::logging: api request completed event="api.request.complete" subsystem="api" outcome="ok" request_id="cli:server:reload-config" method="server.reload_config"',
    ]
    expect(configWarnings(lines(log, 4))).toEqual([
      "invalid keybinding: keys.prefix; using fallback ctrl+b",
    ])
    expect(configWarnings(lines(log, 6))).toEqual([])
  })
})

describe("the pinned config", () => {
  const config = Bun.TOML.parse(CONFIG_SOURCE) as Record<string, Record<string, unknown>>

  test("takes a prefix Claude Code does not use", () => {
    expect(config.keys?.prefix).toBe("ctrl+alt+b")
  })

  test("turns off both update checks and onboarding", () => {
    expect(config.update).toEqual({ manifest_check: false, version_check: false })
    expect((config as Record<string, unknown>).onboarding).toBe(false)
  })

  test("pins the headless size, restore spacing and scrollback, with history and nesting off", () => {
    expect(config.server).toEqual({ headless_cols: 120, headless_rows: 40 })
    expect(config.session?.startup_per_agent_delay_ms).toBe(1000)
    expect(config.session?.resume_agents_on_restore).toBe(false)
    expect(config.advanced?.scrollback_limit_bytes).toBe(2_000_000)
    expect(config.experimental).toEqual({ allow_nested: false, pane_history: false })
  })

  test("turns off the sounds herdr plays when an agent finishes or needs attention", () => {
    expect(config.ui?.sound).toEqual({ enabled: false })
  })

  test("adds no custom command bindings", () => {
    expect(CONFIG_SOURCE).not.toContain("keys.command")
  })
})

describe("the pin", () => {
  test("runs Playground's own copy in HOME's data folder, by its release asset's sum", () => {
    expect(pinFor(DATA, "darwin-x64")).toEqual({
      path: "/scratch/home/.playground/bin/herdr",
      sha256: X64,
      tag: "darwin-x64",
      version: "0.9.5",
    })
  })
})

describe("beat", () => {
  test("writes the heartbeat every ops job writes", async () => {
    const path = join(scratch(), "ops-herdr.json")
    await beat(
      path,
      new Date("2026-10-18T00:00:00.000Z"),
      new Date("2026-10-18T00:01:00.000Z"),
      "ok",
    )
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(written).toEqual({
      cycleSeconds: 60,
      job: "ops-herdr",
      lastBeatAt: "2026-10-18T00:01:00.000Z",
      lastResult: "ok",
      pid: process.pid,
      startedAt: "2026-10-18T00:00:00.000Z",
    })
  })
})

describe("statusLine", () => {
  test("counts the panes that hold an agent, never a bare shell", () => {
    const list = {
      result: {
        panes: [
          { agent: "worker-a", cwd: "/w", pane_id: "w1:p1" },
          { agent: "builder", cwd: "/m", pane_id: "w1:p2" },
          { cwd: "/m", pane_id: "w1:p3" },
        ],
        type: "pane_list",
      },
    }
    expect(statusLine("factory", true, list)).toBe("herdr factory: up, 2 sessions")
    expect(statusLine("probes", true, { result: { panes: [{ agent: "p", pane_id: "x" }] } })).toBe(
      "herdr probes: up, 1 session",
    )
  })

  test("a server down, or one whose panes cannot be read, says so", () => {
    expect(statusLine("factory", false, null)).toBe("herdr factory: down")
    expect(statusLine("factory", true, { error: "socket" })).toBe(
      "herdr factory: up, its panes cannot be read",
    )
  })
})

describe("serverStatusLines", () => {
  test("one line a server, its panes read only while it is up, a status that throws reading down", async () => {
    const read: string[] = []
    const lines = await serverStatusLines(
      ["factory", "probes", "spare"],
      async (session) => {
        if (session === "spare") throw new Error("ENOENT")
        return session === "factory"
      },
      (session) => {
        read.push(session)
        return { result: { panes: [{ agent: "builder", pane_id: "w1:p1" }] } }
      },
    )
    expect(lines).toEqual([
      "herdr factory: up, 1 session",
      "herdr probes: down",
      "herdr spare: down",
    ])
    expect(read).toEqual(["factory"])
  })
})

describe("attachPlan", () => {
  const pin: Pin = { path: "/stub/herdr", sha256: "abc", tag: "arm64_tahoe", version: "0.9.5" }
  const on = { sha256: "abc", version: "0.9.5" }
  const shell = { HOME: "/Users/me", HERDR_SESSION: "x", CMUX_SOCKET_PATH: "/tmp/c", PATH: "/bin" }

  test("hands the pinned binary the server's own environment, with no other env var of this shell", () => {
    const plan = attachPlan(shell, "/d", "factory", ["factory", "probes"], pin, on, true)
    if ("error" in plan) throw new Error(plan.error)
    expect(plan.argv).toEqual(["/stub/herdr"])
    expect(plan.env).toEqual(serverEnv(shell, "/d", "factory"))
    expect(plan.env.HERDR_SESSION).toBe("factory")
    expect(plan.env.HERDR_SOCKET_PATH).toBe("/d/factory.sock")
    expect(plan.env.HERDR_CONFIG_PATH).toBe("/d/config.toml")
    expect(plan.env.CMUX_SOCKET_PATH).toBeUndefined()
  })

  test("refuses a server not in the list, a binary off the pin, and a server that is down", () => {
    expect(attachPlan(shell, "/d", "other", ["factory", "probes"], pin, on, true)).toEqual({
      error: "attach takes one of factory, probes",
    })
    const off = attachPlan(shell, "/d", "factory", ["factory"], pin, { ...on, sha256: "def" }, true)
    expect("error" in off && off.error).toBe(
      "herdr at /stub/herdr is 0.9.5 def; the pin names 0.9.5 abc; playground herdr pin puts herdr 0.9.5 back at /stub/herdr, or move the pin in a PR to packages/scripts/src/ops-herdr/pin.json",
    )
    const unread = attachPlan(shell, "/d", "factory", ["factory"], pin, null, true)
    expect("error" in unread && unread.error).toContain(
      "playground herdr pin puts herdr 0.9.5 back at /stub/herdr",
    )
    expect(attachPlan(shell, "/d", "factory", ["factory"], pin, on, false)).toEqual({
      error: "factory is not running; playground, or bun run ops:herdr start, brings it up",
    })
  })
})

describe("login item", () => {
  test("no ops script under packages/scripts/src names the old dev.dispatcher.ops-herdr label (#2145)", async () => {
    const src = join(import.meta.dir, "../../../../../packages/scripts/src")
    const writers: string[] = []
    for await (const path of new Bun.Glob("**/*.ts").scan(src))
      if ((await Bun.file(join(src, path)).text()).includes("dev.dispatcher.ops-herdr"))
        writers.push(path)
    expect(writers).toEqual([])
  })
})
