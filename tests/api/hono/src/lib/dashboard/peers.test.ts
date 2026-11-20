import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  peerOf,
  processStarts,
  readRegistry,
  registeredOf,
  registeredSessions,
  registryOf,
  sessionsDir,
  socketNames,
  startsOf,
} from "../../../../../../api/hono/src/lib/dashboard/peers"
import { liveReads } from "../../../../../live-reads"

// These drive the live paths against the test's own scratch files.
liveReads()

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

describe("peerOf", () => {
  test("a registry file is the address its peers message and the session's name", () => {
    const text = JSON.stringify({
      messagingSocketPath: "/tmp/cc-socks/23210.sock",
      name: "dispatcher",
      pid: 23210,
    })
    expect(peerOf(text)).toEqual({ address: "uds:/tmp/cc-socks/23210.sock", name: "dispatcher" })
  })

  test("a file with no socket, no name, or no JSON names no one", () => {
    expect(peerOf(JSON.stringify({ name: "dispatcher" }))).toBeNull()
    expect(
      peerOf(JSON.stringify({ messagingSocketPath: "/tmp/cc-socks/1.sock", name: " " })),
    ).toBeNull()
    expect(peerOf("not json")).toBeNull()
    expect(peerOf("null")).toBeNull()
  })
})

describe("socketNames", () => {
  test("every <pid>.json in the registry, A to Z by address; other files are passed over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"))
    dirs.push(dir)
    const write = (file: string, socket: string, name: string) =>
      writeFileSync(join(dir, file), JSON.stringify({ messagingSocketPath: socket, name }))
    write("6399.json", "/tmp/cc-socks/6399.sock", "worker-wrath")
    write("23210.json", "/tmp/cc-socks/23210.sock", "dispatcher")
    write("notes.json", "/tmp/cc-socks/1.sock", "not-a-session")
    writeFileSync(join(dir, "6399.abc.key"), "secret")
    writeFileSync(join(dir, "broken.json"), "{")
    mkdirSync(join(dir, "12.json"))
    expect(await socketNames(dir)).toEqual({
      "uds:/tmp/cc-socks/23210.sock": "dispatcher",
      "uds:/tmp/cc-socks/6399.sock": "worker-wrath",
    })
  })

  test("a missing registry names no one", async () => {
    expect(await socketNames(join(tmpdir(), "no-such-registry-dir"))).toEqual({})
  })

  test("the registry sits under CLAUDE_CONFIG_DIR", () => {
    const before = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = "/x/config"
    try {
      expect(sessionsDir()).toBe("/x/config/sessions")
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
    }
  })
})

describe("registeredOf", () => {
  test("a registry file is the session's claude process, its id and its name", () => {
    const text = JSON.stringify({ name: "worker-envy", pid: 89017, sessionId: "6651c171-821a" })
    expect(registeredOf(text)).toEqual({
      name: "worker-envy",
      pid: 89017,
      sessionId: "6651c171-821a",
    })
    expect(registeredOf(JSON.stringify({ pid: 7, sessionId: "s", status: "busy" }))).toEqual({
      name: "session s",
      pid: 7,
      sessionId: "s",
      status: "busy",
    })
  })

  test("a session with no name goes by its folder, as the sidebar names it", () => {
    const text = JSON.stringify({ cwd: "/Users/me/acme-app", pid: 7, sessionId: "s" })
    expect(registeredOf(text)?.name).toBe("session acme-app")
  })

  test("a session with no name or folder goes by its id; one with no pid or id, or a pid of launchd, is no one", () => {
    expect(registeredOf(JSON.stringify({ pid: 7, sessionId: "abcdef123456" }))).toEqual({
      name: "session abcdef12",
      pid: 7,
      sessionId: "abcdef123456",
    })
    expect(registeredOf(JSON.stringify({ name: "x", sessionId: "s" }))).toBeNull()
    expect(registeredOf(JSON.stringify({ name: "x", pid: 7 }))).toBeNull()
    expect(registeredOf(JSON.stringify({ name: "x", pid: 1, sessionId: "s" }))).toBeNull()
    expect(registeredOf(JSON.stringify({ name: "x", pid: "7", sessionId: "s" }))).toBeNull()
    expect(registeredOf("{")).toBeNull()
  })
})

describe("registeredSessions", () => {
  test("every <pid>.json in the registry by pid, never the .key files beside them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"))
    dirs.push(dir)
    writeFileSync(
      join(dir, "9919.json"),
      JSON.stringify({ name: "builder", pid: 9919, sessionId: "b" }),
    )
    writeFileSync(
      join(dir, "300.json"),
      JSON.stringify({ name: "dispatcher", pid: 300, sessionId: "a" }),
    )
    writeFileSync(
      join(dir, "9919.abc.key"),
      JSON.stringify({ name: "secret", pid: 5, sessionId: "k" }),
    )
    writeFileSync(join(dir, "notes.json"), JSON.stringify({ name: "n", pid: 6, sessionId: "n" }))
    expect(await registeredSessions(dir)).toEqual([
      { name: "dispatcher", pid: 300, sessionId: "a" },
      { name: "builder", pid: 9919, sessionId: "b" },
    ])
    expect(await registeredSessions(join(tmpdir(), "no-such-registry-dir"))).toEqual([])
  })
})

describe("readRegistry", () => {
  test("every <pid>.json by the pid its name gives; an unreadable folder is null, an empty one empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"))
    dirs.push(dir)
    expect(await readRegistry(dir)).toEqual([])
    writeFileSync(join(dir, "95475.json"), "{}")
    writeFileSync(join(dir, "95475.abc.key"), "secret")
    writeFileSync(join(dir, "notes.json"), "{}")
    mkdirSync(join(dir, "12.json"))
    expect(await readRegistry(dir)).toEqual([{ pid: 95475, text: "{}" }])
    expect(await readRegistry(join(tmpdir(), "no-such-registry-dir"))).toBeNull()
  })
})

describe("registryOf", () => {
  test("each pid's session and its process's start, with the start's spaces made one", () => {
    const text = JSON.stringify({
      name: "greed",
      pid: 95475,
      procStart: "Mon Oct  5 23:37:23 2026",
      sessionId: "s-greed",
    })
    expect(registryOf([{ pid: 95475, text }])).toEqual(
      new Map([[95475, { procStart: "Mon Oct 5 23:37:23 2026", sessionId: "s-greed" }]]),
    )
    expect(registryOf([{ pid: 7, text: JSON.stringify({ pid: 7, sessionId: "s" }) }])).toEqual(
      new Map([[7, { procStart: null, sessionId: "s" }]]),
    )
  })

  test("a procStart of clock ticks, as Claude Code writes it on Linux, is kept as it is", () => {
    const text = JSON.stringify({ pid: 7, procStart: "1801742", sessionId: "s" })
    expect(registryOf([{ pid: 7, text }])).toEqual(
      new Map([[7, { procStart: "1801742", sessionId: "s" }]]),
    )
  })

  test("a procStart in any shape but ps's C lstart or clock ticks is dropped, leaving the session id to decide", () => {
    for (const procStart of ["2026-10-05T23:37:23.000Z", 1791243443000, ""]) {
      const text = JSON.stringify({ pid: 7, procStart, sessionId: "s" })
      expect(registryOf([{ pid: 7, text }])).toEqual(
        new Map([[7, { procStart: null, sessionId: "s" }]]),
      )
    }
  })

  test("a file caught mid-rewrite, or one that could not be read, makes its pid unknown rather than ended", () => {
    expect(registryOf([{ pid: 95475, text: "" }])).toEqual(new Map([[95475, null]]))
    expect(registryOf([{ pid: 95475, text: '{"pid": 954' }])).toEqual(new Map([[95475, null]]))
    expect(registryOf([{ pid: 95475, text: null }])).toEqual(new Map([[95475, null]]))
  })

  test("an unreadable registry is null, an empty one an empty map", () => {
    expect(registryOf(null)).toBeNull()
    expect(registryOf([])).toEqual(new Map())
  })
})

describe("startsOf", () => {
  test("ps's pid and start lines as each pid's start, spaces made one", () => {
    const out = " 9919 Mon Oct  5 23:37:23 2026    \n11239 Tue Oct  6 12:02:22 2026    \n"
    expect(startsOf(out)).toEqual(
      new Map([
        [9919, "Mon Oct 5 23:37:23 2026"],
        [11239, "Tue Oct 6 12:02:22 2026"],
      ]),
    )
    expect(startsOf("")).toEqual(new Map())
  })
})

describe("processStarts", () => {
  test("a running pid's start is read in UTC as the registry records it; a pid no process holds is absent", async () => {
    const ended = Bun.spawn(["true"])
    await ended.exited
    const starts = await processStarts([process.pid, ended.pid])
    const [, month, day, time, year] = (starts?.get(process.pid) ?? "").split(" ")
    const [h, m, s] = (time ?? "").split(":").map(Number)
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]
    const read = Date.UTC(Number(year), months.indexOf(month ?? ""), Number(day), h, m, s)
    expect(Math.abs(read - performance.timeOrigin)).toBeLessThan(5000)
    expect(starts?.has(ended.pid)).toBe(false)
    expect(await processStarts([ended.pid])).toEqual(new Map())
    expect(await processStarts([])).toEqual(new Map())
  })
})
