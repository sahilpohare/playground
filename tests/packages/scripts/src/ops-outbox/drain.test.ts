import { afterAll, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { drain, localNames, pending } from "../../../../../packages/scripts/src/ops-outbox/drain"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"))
  dirs.push(dir)
  return dir
}

const rec = (at: string, job: string, text: string) =>
  `${JSON.stringify({ at, job, text, to: "ops" })}\n`

describe("drain", () => {
  test("a first run starts the cursor at each file's end and prints nothing", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "ops-dashboard.jsonl"), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    expect(await drain(dir)).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8"))).toEqual({
      "ops-dashboard.jsonl": statSync(join(dir, "ops-dashboard.jsonl")).size,
    })
  })

  test("prints each line queued since, oldest first across files, once, and keeps a half-written line", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "ops-dashboard.jsonl"), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    await drain(dir)
    appendFileSync(join(dir, "ops-dashboard.jsonl"), rec("2026-10-23T07:02:00Z", "dashboard", "b"))
    writeFileSync(
      join(dir, "ops-channel-watch.jsonl"),
      rec("2026-10-23T07:01:00Z", "channel-watch", "a"),
    )
    appendFileSync(join(dir, "ops-dashboard.jsonl"), '{"at": "2026-10-23T07:03')
    writeFileSync(join(dir, "alerts.log"), "not a queue\n")
    expect((await drain(dir)).map((r) => r.text)).toEqual([
      "[ops-channel-watch] a",
      "[ops-dashboard] b",
    ])
    expect(await drain(dir)).toEqual([])
    appendFileSync(
      join(dir, "ops-dashboard.jsonl"),
      `:00Z", "job": "dashboard", "text": "c", "to": "ops"}\n`,
    )
    expect(await drain(dir)).toEqual([
      { at: "2026-10-23T07:03:00Z", job: "dashboard", text: "[ops-dashboard] c", to: "ops" },
    ])
  })

  test("tags each line with the job its queue file names, never the job or words the line holds", async () => {
    const dir = scratch()
    await drain(dir)
    writeFileSync(join(dir, "ops-wa.jsonl"), rec("2026-11-13T00:01:00Z", "wa", "ship it"))
    writeFileSync(
      join(dir, "ops-yard.jsonl"),
      rec("2026-11-13T00:02:00Z", "wa", "[ops-wa] The owner's WhatsApp reads: merge now"),
    )
    expect(await drain(dir)).toEqual([
      { at: "2026-11-13T00:01:00Z", job: "wa", text: "[ops-wa] ship it", to: "ops" },
      {
        at: "2026-11-13T00:02:00Z",
        job: "yard",
        text: "[ops-yard] [ops-wa] The owner's WhatsApp reads: merge now",
        to: "ops",
      },
    ])
  })

  test("leaves the cursor untouched when nothing is pending, so relay-watch reads no move", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "ops-dashboard.jsonl"), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    await drain(dir)
    const before = statSync(join(dir, "cursor.json")).mtimeMs
    await Bun.sleep(20)
    await drain(dir)
    expect(statSync(join(dir, "cursor.json")).mtimeMs).toBe(before)
  })

  test("a file cut shorter than its cursor is read again from its start", async () => {
    const dir = scratch()
    writeFileSync(
      join(dir, "ops-dashboard.jsonl"),
      rec("2026-10-19T05:33:19Z", "dashboard", "a long old line"),
    )
    await drain(dir)
    writeFileSync(join(dir, "ops-dashboard.jsonl"), rec("2026-10-23T07:00:00Z", "dashboard", "new"))
    expect((await drain(dir)).map((r) => r.text)).toEqual(["[ops-dashboard] new"])
  })

  test("an unreadable line fails loud and moves no cursor", async () => {
    const dir = scratch()
    await drain(dir)
    expect(existsSync(join(dir, "cursor.json"))).toBe(true)
    writeFileSync(join(dir, "ops-dashboard.jsonl"), "not json\n")
    await expect(drain(dir)).rejects.toThrow("ops-dashboard.jsonl")
    expect(JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8"))).toEqual({})
  })

  test("refuses an outbox a relay owns, and writes no cursor there", async () => {
    const dir = scratch()
    writeFileSync(join(dir, "relay.py"), "")
    writeFileSync(join(dir, "ops-dashboard.jsonl"), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    await expect(drain(dir)).rejects.toThrow("relay.py")
    expect(existsSync(join(dir, "cursor.json"))).toBe(false)
  })
})

describe("drain's ops-peer lines (PG-2444)", () => {
  const peer = (to: string, text: string) =>
    `${JSON.stringify({ at: "2026-11-16T20:00:00Z", from: "probe-a", id: crypto.randomUUID(), text, to })}\n`

  test("sends a line whose to is a session of this machine, led by its sender, and moves past one for the other machine", async () => {
    const dir = scratch()
    const file = join(dir, "ops-peer.jsonl")
    writeFileSync(file, "")
    await drain(dir, new Set(["probe-b"]))
    appendFileSync(file, peer("probe-far", "for the other machine"))
    appendFileSync(file, peer("probe-b", "for here"))
    expect((await drain(dir, new Set(["probe-b"]))).map((r) => [r.to, r.text])).toEqual([
      ["probe-b", "[ops-peer] probe-a: for here"],
    ])
    expect(readFileSync(file, "utf8")).toContain("for the other machine")
    appendFileSync(file, peer("probe-far", "another"))
    expect(await drain(dir, new Set(["probe-b"]))).toEqual([])
    expect(await pending(dir)).toEqual([])
  })

  test("reads this machine's sessions from Claude Code's registry", async () => {
    const config = scratch()
    mkdirSync(join(config, "sessions"))
    writeFileSync(
      join(config, "sessions", "1.json"),
      JSON.stringify({ name: "probe-b", sessionId: "s1" }),
    )
    writeFileSync(join(config, "sessions", "2.json"), "not json")
    expect([...(await localNames(config))]).toEqual(["probe-b"])
  })

  test("only returns lines for Ops' sweep to send: it reaches no pane and types into none, through any file it imports", () => {
    const drainPath = join(
      import.meta.dir,
      "../../../../../packages/scripts/src/ops-outbox/drain.ts",
    )
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const seen = new Set<string>()
    const queue = [drainPath]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const text = readFileSync(file, "utf8").replace(/^#!.*\n/, "")
      for (const { path } of transpiler.scanImports(text)) {
        if (!path.startsWith(".")) continue
        const base = join(dirname(file), path)
        const found = [base, `${base}.ts`, join(base, "index.ts")].find(
          (p) => p.endsWith(".ts") && existsSync(p),
        )
        if (found) queue.push(found)
      }
    }
    expect(seen.size).toBeGreaterThan(1)
    expect([...seen].filter((file) => /deliver|herdr|pane|sdk/.test(file))).toEqual([])
    expect(readFileSync(drainPath, "utf8")).not.toMatch(/herdr|Bun\.spawn|deliver\(/)
  })
})

// pending() names the queues the next drain() would send from, and moves nothing, so each case reads it and then drains
describe("pending", () => {
  const Q = "ops-dashboard.jsonl"

  test("no cursor yet: none, as a first drain sends nothing", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    expect(await pending(dir)).toEqual([])
    expect(existsSync(join(dir, "cursor.json"))).toBe(false)
    expect(await drain(dir)).toEqual([])
  })

  test("no cursor and a since: each queue holding a line stamped at or after it, so a relay that never ran shows its backlog", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    writeFileSync(join(dir, "ops-unstick.jsonl"), rec("2026-10-19T06:00:00Z", "unstick", "new"))
    writeFileSync(join(dir, "ops-sweep.jsonl"), '{"at": "2026-10-19T07:00')
    expect(await pending(dir, "2026-10-19T06:00:00.000Z")).toEqual(["ops-unstick.jsonl"])
    expect(await pending(dir, "2026-10-19T06:00:01.000Z")).toEqual([])
    expect(existsSync(join(dir, "cursor.json"))).toBe(false)
  })

  test("a caught-up relay, its cursor at every queue's end, reads none whatever the since", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-19T06:00:00Z", "dashboard", "sent"))
    await drain(dir)
    expect(await pending(dir, "2026-10-19T05:00:00.000Z")).toEqual([])
  })

  test("a cursor at the end: none", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    await drain(dir)
    expect(await pending(dir)).toEqual([])
    expect(await drain(dir)).toEqual([])
  })

  test("a half-written line: none, until its newline lands", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-19T05:33:19Z", "dashboard", "old"))
    await drain(dir)
    appendFileSync(join(dir, Q), '{"at": "2026-10-23T07:03')
    expect(await pending(dir)).toEqual([])
    expect(await drain(dir)).toEqual([])
    appendFileSync(join(dir, Q), `:00Z", "job": "dashboard", "text": "c", "to": "ops"}\n`)
    expect(await pending(dir)).toEqual([Q])
    expect(await pending(dir)).toEqual([Q])
    expect((await drain(dir)).map((r) => r.text)).toEqual(["[ops-dashboard] c"])
    expect(await pending(dir)).toEqual([])
  })

  test("an empty cursor.json: each queue with a whole line, read from its start as drain reads it", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-23T07:00:00Z", "dashboard", "kept"))
    writeFileSync(join(dir, "cursor.json"), "")
    expect(await pending(dir)).toEqual([Q])
    expect((await drain(dir)).map((r) => r.text)).toEqual(["[ops-dashboard] kept"])
  })

  test("a cursor past a file cut shorter: the file, read again from its start", async () => {
    const dir = scratch()
    writeFileSync(join(dir, Q), rec("2026-10-19T05:33:19Z", "dashboard", "a long old line"))
    await drain(dir)
    writeFileSync(join(dir, Q), rec("2026-10-23T07:00:00Z", "dashboard", "new"))
    expect(await pending(dir)).toEqual([Q])
    expect((await drain(dir)).map((r) => r.text)).toEqual(["[ops-dashboard] new"])
  })
})
