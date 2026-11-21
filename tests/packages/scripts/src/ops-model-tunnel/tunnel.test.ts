import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { peerOf } from "../../../../../packages/scripts/src/local-model/peer"
import {
  FORWARDS,
  JOB,
  keep,
  tunnelArgv,
} from "../../../../../packages/scripts/src/ops-model-tunnel/tunnel"
import { CYCLE_SECONDS } from "../../../../../packages/scripts/src/ops-tick/tick"

const ENV = "PLAYGROUND_PEERS=spark-test=me@spark-test\nPLAYGROUND_PEER_KEY=/home/me/.ssh/k\n"

describe("ops-model-tunnel (PG-2543)", () => {
  test("ssh holds the forwards alone: no remote command, no prompt, the key alone", () => {
    expect(tunnelArgv("/home/me/.ssh/k", "me@spark-test")).toEqual([
      "-N",
      "-F",
      "none",
      "-i",
      "/home/me/.ssh/k",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ServerAliveInterval=15",
      "-L",
      "127.0.0.1:18000:127.0.0.1:8000",
      "-L",
      "127.0.0.1:18001:127.0.0.1:8001",
      "me@spark-test",
    ])
  })

  test("every forward binds 127.0.0.1 on this machine, so no other machine on the network reaches the model server", () => {
    const argv = tunnelArgv("/k", "me@spark-test")
    const binds = argv.filter((_, i) => argv[i - 1] === "-L")
    expect(binds).toHaveLength(FORWARDS.length)
    for (const bind of binds) expect(bind).toMatch(/^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/)
    expect(argv).not.toContain("-g")
    expect(argv.join(" ")).not.toMatch(/GatewayPorts|0\.0\.0\.0|\*:/)
    expect(FORWARDS).toEqual([
      [18000, 8000],
      [18001, 8001],
    ])
  })

  test("the peer is the one localModels.machine names, or the only one PLAYGROUND_PEERS names", () => {
    expect(peerOf(ENV, "/home/me", "")).toEqual({
      key: "/home/me/.ssh/k",
      name: "spark-test",
      target: "me@spark-test",
    })
    expect(peerOf(ENV, "/home/me", "spark-test")).toMatchObject({ target: "me@spark-test" })
    expect(peerOf(ENV, "/home/me", "spark-other")).toEqual({
      why: "PLAYGROUND_PEERS names no spark-other",
    })
    expect(peerOf(`${ENV}PLAYGROUND_PEERS=a=me@a,b=me@b\n`, "/home/me", "")).toEqual({
      why: "PLAYGROUND_PEERS names more than one machine: set localModels.machine to one",
    })
    expect(peerOf("", "/home/me", "")).toEqual({
      why: "PLAYGROUND_PEERS names no machine: set localModels.machine and PLAYGROUND_PEERS",
    })
  })

  test("beats up each cycle while ssh holds, so the sweep never reads a held tunnel as stale, and stops beating once ssh exits", async () => {
    const data = mkdtempSync(join(tmpdir(), "model-tunnel-"))
    const path = join(data, "ops", `${JOB}.json`)
    const stop = new AbortController()
    let drop = (_code: number) => {}
    const timers: { cleared: boolean; ms: number; tick: () => unknown }[] = []
    const kept = keep({
      data,
      envText: async () => ENV,
      every: (ms, tick) => {
        const timer = { cleared: false, ms, tick }
        timers.push(timer)
        return () => void (timer.cleared = true)
      },
      home: "/home/me",
      machine: () => "",
      record: async () => {},
      signal: stop.signal,
      spawn: () => ({
        exited: new Promise<number>((done) => (drop = done)),
        kill: () => drop(143),
        stderr: Promise.resolve(""),
      }),
      ssh: "/usr/bin/ssh",
      wait: async () => void stop.abort(),
    })
    for (let tries = 0; !timers.length && tries < 200; tries++) await Bun.sleep(1)
    expect(timers).toHaveLength(1)
    const [timer] = timers
    expect(timer!.ms).toBe(CYCLE_SECONDS * 1000)
    // three cycles of a link that holds: each one writes the up line again
    for (let cycle = 0; cycle < 3; cycle++) {
      await Bun.write(path, `${JSON.stringify({ lastResult: "stale" })}\n`)
      await timer!.tick()
      expect((await Bun.file(path).json()).lastResult).toBe(
        "up: 127.0.0.1:18000 to spark-test:8000, 127.0.0.1:18001 to spark-test:8001",
      )
    }
    drop(255)
    await kept
    expect(timer!.cleared).toBe(true)
    expect(timers).toHaveLength(1)
  })

  test("starts ssh again after it drops, records its heartbeat once, and stops by its own handle", async () => {
    const data = mkdtempSync(join(tmpdir(), "model-tunnel-"))
    const started: string[][] = []
    const recorded: string[] = []
    const stop = new AbortController()
    const waits: number[] = []
    let killed = 0
    await keep({
      data,
      envText: async () => ENV,
      every: () => () => {},
      home: "/home/me",
      machine: () => "",
      record: async (entries) => void recorded.push(...entries.map((entry) => entry.path)),
      signal: stop.signal,
      spawn: (argv) => {
        started.push(argv)
        // the first ssh drops at once; the second holds until the signal
        const exited =
          started.length === 1
            ? Promise.resolve(255)
            : new Promise<number>((done) =>
                stop.signal.addEventListener("abort", () => done(143), { once: true }),
              )
        if (started.length === 2) queueMicrotask(() => stop.abort())
        return {
          exited,
          kill: () => void killed++,
          stderr: Promise.resolve(started.length === 1 ? "Connection refused\n" : ""),
        }
      },
      ssh: "/usr/bin/ssh",
      wait: async (ms) => void waits.push(ms),
    })
    expect(started).toHaveLength(2)
    expect(started[0]).toEqual(["/usr/bin/ssh", ...tunnelArgv("/home/me/.ssh/k", "me@spark-test")])
    expect(waits).toEqual([2_000])
    expect(killed).toBe(1)
    expect(recorded).toEqual([join(data, "ops", `${JOB}.json`)])
    const beat = await Bun.file(join(data, "ops", `${JOB}.json`)).json()
    expect(beat.job).toBe(JOB)
  })
})
