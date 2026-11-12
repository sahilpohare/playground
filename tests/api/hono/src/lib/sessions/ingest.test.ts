import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SQL } from "bun"

import { provenLocal } from "../../../../../../api/hono/src/lib/sessions/guard"
import {
  backfill,
  connect,
  INGEST_LOCK,
  ingestFile,
  mergeSession,
  readAll,
} from "../../../../../../api/hono/src/lib/sessions/ingest"
import { emptyFacts } from "../../../../../../api/hono/src/lib/sessions/lines"
import { listSessions } from "../../../../../../api/hono/src/lib/sessions/read"
import { testContainerName } from "../../../../../container"

// Runs the importer against a throwaway Postgres in Docker, published on 127.0.0.1 only, with the repo's own migrations applied; skipped where Docker is not running.
const IMAGE = "postgres:18-alpine"
const PASSWORD = "ingest-test"
const MIGRATIONS = join(import.meta.dir, "../../../../../../packages/db/drizzle")

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

const SESSION = "11111111-2222-4333-8444-555555555555"
const LAUNCHER = "99999999-8888-4777-8666-555555555555"
const PROJECT = "-Users-me-repo"

const line = (value: unknown) => `${JSON.stringify(value)}\n`

const human = (uuid: string, text: string, at: string) =>
  line({
    type: "user",
    uuid,
    timestamp: at,
    sessionId: SESSION,
    cwd: "/Users/me/repo",
    entrypoint: "cli",
    gitBranch: "main",
    version: "2.1.289",
    origin: { kind: "human" },
    message: { role: "user", content: text },
  })

const block = (uuid: string, messageId: string, content: unknown, at: string, output = 10) =>
  line({
    type: "assistant",
    uuid,
    timestamp: at,
    sessionId: SESSION,
    message: {
      id: messageId,
      model: "claude-opus-5-5",
      content: [content],
      usage: {
        input_tokens: 2,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
    },
  })

describe.skipIf(!dockerUp())("ingest", () => {
  let container = ""
  let url = ""
  let projects = ""
  let root = ""
  let admin: SQL
  let db: ReturnType<typeof connect>

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("sessions-ingest"),
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1::5432",
      IMAGE,
      "-c",
      "shared_preload_libraries=pg_stat_statements",
    ])
      .stdout.toString()
      .trim()
    const port = Bun.spawnSync(["docker", "port", container, "5432/tcp"])
      .stdout.toString()
      .trim()
      .split(":")
      .at(-1)
    url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`
    for (let i = 0; i < 60; i++) {
      try {
        admin = new SQL(url, { max: 1 })
        await admin`select 1`
        break
      } catch {
        await Bun.sleep(500)
      }
    }
    const journal = await Bun.file(join(MIGRATIONS, "meta/_journal.json")).json()
    for (const { tag } of journal.entries as { tag: string }[]) {
      for (const statement of (await Bun.file(join(MIGRATIONS, `${tag}.sql`)).text()).split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await admin.unsafe(statement)
      }
    }
    await admin`create extension if not exists pg_stat_statements`
    db = connect(url)
    root = mkdtempSync(join(tmpdir(), "ingest-"))
    projects = join(root, "projects")
    mkdirSync(join(projects, PROJECT, SESSION, "subagents"), { recursive: true })
  }, 60_000)

  afterAll(() => {
    if (container)
      Bun.spawnSync(["docker", "rm", "-fv", container], { stderr: "ignore", stdout: "ignore" })
    if (root) rmSync(root, { force: true, recursive: true })
  })

  const main = () => join(projects, PROJECT, `${SESSION}.jsonl`)
  const sessionRow = async (id: string) =>
    (await admin`select * from claude_session where id = ${id}`)[0]
  const entryCount = async (id: string) =>
    (await admin`select count(*)::int as n from claude_entry where session_id = ${id}`)[0]
      .n as number
  // Loaded per test, so a checkout of canary's source (before the token window) fails only the tests that need it.
  const flushTokens = async () =>
    (await import("../../../../../../api/hono/src/lib/sessions/ingest")).flushTokens(db)
  // The window these tests wait on, set short on this database so a test waits seconds rather than the live minute.
  const tokenWindow = async () => {
    const ms = 2_000
    ;(await import("../../../../../../api/hono/src/lib/sessions/ingest")).setTokenWindow(db, ms)
    return ms
  }

  test("a backfill stores each line once, names the session, and counts each message's tokens from its last line", async () => {
    writeFileSync(
      main(),
      [
        line({ type: "agent-name", agentName: "pride", sessionId: SESSION }),
        human("u1", "Fix the login bug\nwith details", "2026-10-06T10:00:00.000Z"),
        block(
          "a1",
          "msg_1",
          { type: "thinking", thinking: "", signature: "x" },
          "2026-10-06T10:00:01.000Z",
          3,
        ),
        block(
          "a2",
          "msg_1",
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } },
          "2026-10-06T10:00:02.000Z",
        ),
        line({
          type: "user",
          uuid: "r1",
          timestamp: "2026-10-06T10:00:03.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "clean\u0000" }],
          },
        }),
        block("a3", "msg_2", { type: "text", text: "Done." }, "2026-10-06T10:00:04.000Z", 20),
        line({ type: "agent-name", agentName: "worker-pride", sessionId: SESSION }),
        line({ type: "pr-link", prUrl: "https://github.com/acme/archive/pull/38" }),
        line({ type: "cost-state", startTime: 1, totalCostUSD: 0.5 }),
      ].join(""),
    )
    const result = await ingestFile(db, projects, main())
    await flushTokens()
    expect(result).toEqual({ entries: 5, id: SESSION })
    const row = await sessionRow(SESSION)
    expect(row).toMatchObject({
      cache_creation_tokens: "10",
      cache_read_tokens: "200",
      cwd: "/Users/me/repo",
      entry_count: 5,
      input_tokens: "4",
      kind: "interactive",
      name: "worker-pride",
      output_tokens: "30",
      pr_urls: ["https://github.com/acme/archive/pull/38"],
      project_dir: PROJECT,
      task: "Fix the login bug",
    })
    expect(Number(row.cost_usd)).toBe(0.5)
    expect(new Date(row.started_at).toISOString()).toBe("2026-10-06T10:00:00.000Z")
    expect(new Date(row.last_active_at).toISOString()).toBe("2026-10-06T10:00:04.000Z")
  })

  test("a second run over an unchanged file adds nothing", async () => {
    expect(await ingestFile(db, projects, main())).toEqual({ entries: 0, id: SESSION })
    expect(await entryCount(SESSION)).toBe(5)
  })

  // A fresh Playground on a Mac where another checkout's factory runs: a stack that reads this machine stores Playground's own sessions alone (lib/sessions/own.ts), so another's transcript and its subagent never reach the database, rather than being stored and hidden, and the Sessions pages list the own one alone
  test("a stack that reads this machine stores and lists Playground's own sessions alone, and every one once it opts in", async () => {
    const OWN = "aaaaaaaa-0000-4000-8000-000000000001"
    const FOREIGN = "aaaaaaaa-0000-4000-8000-000000000002"
    const data = join(root, "own-data")
    mkdirSync(join(data, "session-state"), { recursive: true })
    writeFileSync(join(data, "session-state", `${OWN}.json`), "{}")
    const dir = join(projects, "-Users-me-own")
    mkdirSync(join(dir, FOREIGN, "subagents"), { recursive: true })
    const ask = (id: string, text: string) =>
      line({
        type: "user",
        uuid: `${id.slice(-1)}-${text.length}`,
        timestamp: "2026-10-30T10:00:00.000Z",
        sessionId: id,
        cwd: "/Users/me/own",
        entrypoint: "cli",
        version: "2.1.289",
        origin: { kind: "human" },
        message: { role: "user", content: text },
      })
    const paths = [
      join(dir, `${OWN}.jsonl`),
      join(dir, `${FOREIGN}.jsonl`),
      join(dir, FOREIGN, "subagents", "agent-f1.jsonl"),
    ]
    writeFileSync(paths[0]!, ask(OWN, "own work"))
    writeFileSync(paths[1]!, ask(FOREIGN, "another factory's work"))
    writeFileSync(paths[2]!, ask(FOREIGN, "another factory's subagent"))
    const pass = async (optIn: string | undefined) => {
      const keys = [
        "PLAYGROUND_ALL_SESSIONS",
        "PLAYGROUND_DATA_DIR",
        "PLAYGROUND_FIXTURE",
        "PLAYGROUND_LIVE_READS",
      ]
      const saved = keys.map((key) => [key, process.env[key]] as const)
      Object.assign(process.env, { PLAYGROUND_DATA_DIR: data, PLAYGROUND_LIVE_READS: "1" })
      delete process.env.PLAYGROUND_FIXTURE
      if (optIn === undefined) delete process.env.PLAYGROUND_ALL_SESSIONS
      else process.env.PLAYGROUND_ALL_SESSIONS = optIn
      try {
        for (const path of paths) await ingestFile(db, projects, path)
        const stored =
          await admin`select id from claude_session where id in (${OWN}, ${FOREIGN}, ${"f1"}) order by id`
        const listed = await listSessions(
          db,
          { dir: "desc", kinds: [], page: 1, perPage: 100, sort: "lastActive" },
          new Map(),
        )
        return {
          listed: listed.rows.map((row) => row.id).filter((id) => [OWN, FOREIGN].includes(id)),
          stored: stored.map((row: { id: string }) => row.id),
        }
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
    expect(await pass(undefined)).toEqual({ listed: [OWN], stored: [OWN] })
    expect(await pass("true")).toEqual({ listed: [OWN, FOREIGN], stored: [OWN, FOREIGN, "f1"] })
  })

  test("costs and each line are stored as JSON objects, never as one JSON string", async () => {
    const costs =
      await admin`select jsonb_typeof(costs) as type from claude_session where id = ${SESSION}`
    expect(costs.map((r: { type: string }) => r.type)).toEqual(["object"])
    const lines =
      await admin`select distinct jsonb_typeof(raw) as type from claude_entry where session_id = ${SESSION}`
    expect(lines.map((r: { type: string }) => r.type)).toEqual(["object"])
  })

  test("costs stored as one JSON string, as the importer once wrote them, still merge with the next run's", async () => {
    await admin`update claude_session set costs = to_jsonb('{"1":0.5}'::text) where id = ${SESSION}`
    appendFileSync(main(), line({ type: "cost-state", startTime: 2, totalCostUSD: 1 }))
    await ingestFile(db, projects, main())
    const [row] =
      await admin`select costs, jsonb_typeof(costs) as type from claude_session where id = ${SESSION}`
    expect([row.type, row.costs]).toEqual(["object", { "1": 0.5, "2": 1 }])
    expect(Number((await sessionRow(SESSION)).cost_usd)).toBe(1.5)
  })

  test("new lines are read from where the last run stopped, and a half-written line waits for its newline", async () => {
    const next = human("u2", "and the tests", "2026-10-06T10:01:00.000Z")
    appendFileSync(main(), next + next.slice(0, 20).replace(/\n/g, ""))
    expect((await ingestFile(db, projects, main()))?.entries).toBe(1)
    appendFileSync(main(), next.replace("u2", "u3").slice(20))
    expect((await ingestFile(db, projects, main()))?.entries).toBe(1)
  })

  test("a file replaced under the same path is read again from the start, its entries replaced rather than doubled", async () => {
    const copy = `${main()}.tmp`
    const text = await Bun.file(main()).text()
    writeFileSync(copy, text.split("\n").slice(1).join("\n"))
    renameSync(copy, main())
    expect((await ingestFile(db, projects, main()))?.entries).toBe(7)
    expect(await entryCount(SESSION)).toBe(7)
    const [first] =
      await admin`select seq from claude_entry where session_id = ${SESSION} and uuid = 'u1'`
    expect(Number(first.seq)).toBe(0)
  })

  test("a file replaced under the same path keeps each kept line's thread tag by its uuid, across chunks, and a dropped line's tag goes with it", async () => {
    const id = "66666666-7777-4888-8999-aaaaaaaaaaaa"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    const lines = Array.from({ length: 20 }, (_, i) =>
      human(
        `t${i}`,
        `step ${i} ${"x".repeat(80)}`,
        `2026-10-06T13:00:${String(i).padStart(2, "0")}.000Z`,
      ),
    )
    writeFileSync(path, lines.join(""))
    await ingestFile(db, projects, path, { chunkBytes: 1024 })
    await admin`insert into thread (id, title) values ('w3rd', 'A thread')`
    await admin`update claude_entry set thread_id = 'w3rd', thread_seq = case uuid when 't1' then 0 when 't5' then 1 else 2 end where session_id = ${id} and uuid in ('t1', 't5', 't18')`
    const copy = `${path}.tmp`
    writeFileSync(copy, lines.filter((_, i) => i !== 5).join(""))
    renameSync(copy, path)
    await ingestFile(db, projects, path, { chunkBytes: 1024 })
    const tagged =
      await admin`select uuid, thread_seq from claude_entry where session_id = ${id} and thread_id = 'w3rd' order by thread_seq`
    expect(
      tagged.map((row: { thread_seq: number; uuid: string }) => [row.uuid, row.thread_seq]),
    ).toEqual([
      ["t1", 0],
      ["t18", 2],
    ])
    expect(await entryCount(id)).toBe(19)
  })

  test("a reset stopped after its first chunk keeps every thread tag, and the resumed read drops a dropped line's", async () => {
    const id = "77777777-8888-4999-8aaa-bbbbbbbbbbbb"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    const lines = Array.from({ length: 20 }, (_, i) =>
      human(
        `r${i}`,
        `step ${i} ${"x".repeat(80)}`,
        `2026-10-06T14:00:${String(i).padStart(2, "0")}.000Z`,
      ),
    )
    writeFileSync(path, lines.join(""))
    await ingestFile(db, projects, path, { chunkBytes: 1024 })
    await admin`insert into thread (id, title) values ('q4zx', 'Another thread')`
    await admin`update claude_entry set thread_id = 'q4zx', thread_seq = case uuid when 'r1' then 0 when 'r5' then 1 else 2 end where session_id = ${id} and uuid in ('r1', 'r5', 'r18')`
    const copy = `${path}.tmp`
    writeFileSync(copy, lines.filter((_, i) => i !== 5).join(""))
    renameSync(copy, path)
    let checks = 0
    const stopAfterOne = {
      get aborted() {
        checks += 1
        return checks > 1
      },
    }
    await ingestFile(db, projects, path, { chunkBytes: 1024, signal: stopAfterOne })
    const cut =
      await admin`select uuid from claude_entry where session_id = ${id} and thread_id = 'q4zx' order by uuid`
    expect(cut.map((row: { uuid: string }) => row.uuid)).toEqual(["r1", "r18", "r5"])
    await ingestFile(db, projects, path, { chunkBytes: 1024 })
    const tagged =
      await admin`select uuid, seq, thread_seq from claude_entry where session_id = ${id} and thread_id = 'q4zx' order by thread_seq`
    expect(
      tagged.map((row: { seq: number; thread_seq: number; uuid: string }) => [
        row.uuid,
        row.thread_seq,
        Number(row.seq) >= 0,
      ]),
    ).toEqual([
      ["r1", 0, true],
      ["r18", 2, true],
    ])
    expect(await entryCount(id)).toBe(19)
    expect((await sessionRow(id)).entry_count).toBe(19)
  })

  test("a reset that keeps every tagged line, line 0 included, counts a re-read tagged line once, and gives it the new file's text", async () => {
    const id = "88888888-9999-4aaa-8bbb-cccccccccccc"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    const line = (i: number, text: string) =>
      human(`k${i}`, text, `2026-10-06T15:00:${String(i).padStart(2, "0")}.000Z`)
    const lines = Array.from({ length: 20 }, (_, i) => line(i, `step ${i} ${"x".repeat(80)}`))
    writeFileSync(path, lines.join(""))
    await ingestFile(db, projects, path, { chunkBytes: 1024 })
    await admin`insert into thread (id, title) values ('m8kp', 'A third thread')`
    await admin`update claude_entry set thread_id = 'm8kp', thread_seq = case uuid when 'k0' then 0 else 1 end where session_id = ${id} and uuid in ('k0', 'k18')`
    const copy = `${path}.tmp`
    writeFileSync(
      copy,
      lines
        .map((text, i) => (i === 0 || i === 18 ? line(i, `step ${i}, rewritten`) : text))
        .join(""),
    )
    renameSync(copy, path)
    await ingestFile(db, projects, path, { chunkBytes: 1024 })
    // Line 0 is why the mark is -1 - seq: a mark of -seq would leave it at 0, where the re-read cannot take it.
    const kept =
      await admin`select uuid, text, raw::text as raw, thread_id, seq from claude_entry where session_id = ${id} and uuid in ('k0', 'k18') order by uuid`
    expect(
      kept.map(
        (row: { raw: string; seq: number; text: string; thread_id: string; uuid: string }) => [
          row.uuid,
          row.text,
          row.raw.includes(row.text),
          row.thread_id,
          Number(row.seq) >= 0,
        ],
      ),
    ).toEqual([
      ["k0", "step 0, rewritten", true, "m8kp", true],
      ["k18", "step 18, rewritten", true, "m8kp", true],
    ])
    expect(await entryCount(id)).toBe(20)
    expect((await sessionRow(id)).entry_count).toBe(20)
  })

  test("a file replaced under the same path takes its task and launch directory from its new first lines", async () => {
    const id = "55555555-6666-4777-8888-999999999999"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    const first = (task: string, cwd: string) =>
      line({
        type: "user",
        uuid: `${id}-u1`,
        timestamp: "2026-10-06T11:00:00.000Z",
        sessionId: id,
        cwd,
        origin: { kind: "human" },
        message: { role: "user", content: task },
      })
    writeFileSync(path, first("Read /Users/me/old", "/Users/me/repo"))
    await ingestFile(db, projects, path)
    writeFileSync(`${path}.tmp`, first("Read /fixture/new", "/fixture/repo"))
    renameSync(`${path}.tmp`, path)
    await ingestFile(db, projects, path)
    expect(await sessionRow(id)).toMatchObject({ cwd: "/fixture/repo", task: "Read /fixture/new" })
  })

  test("a subagent is its own session under its parent, with its type and description from its meta file", async () => {
    const sub = join(projects, PROJECT, SESSION, "subagents", "agent-a1b2c3.jsonl")
    writeFileSync(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Find the hub" }),
    )
    writeFileSync(
      sub,
      line({
        type: "user",
        uuid: "s1",
        isSidechain: true,
        agentId: "a1b2c3",
        timestamp: "2026-10-06T10:02:00.000Z",
        message: { role: "user", content: "look" },
      }),
    )
    expect((await ingestFile(db, projects, sub))?.entries).toBe(1)
    expect(await sessionRow("a1b2c3")).toMatchObject({
      agent_type: "Explore",
      description: "Find the hub",
      kind: "subagent",
      parent_id: SESSION,
    })
  })

  test("a fork started by a subagent is a fork under that subagent, from its meta file", async () => {
    const sub = join(projects, PROJECT, SESSION, "subagents", "agent-d4e5f6.jsonl")
    writeFileSync(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentType: "general-purpose", isFork: true, parentAgentId: "a1b2c3" }),
    )
    writeFileSync(
      sub,
      line({
        type: "user",
        uuid: "f1",
        isSidechain: true,
        isMeta: true,
        timestamp: "2026-10-06T10:02:30.000Z",
        message: {
          role: "user",
          content: "Base directory for this skill: /skills/linear-scan",
        },
      }),
    )
    await ingestFile(db, projects, sub)
    expect(await sessionRow("d4e5f6")).toMatchObject({
      kind: "fork",
      parent_id: "a1b2c3",
      task: "/linear-scan",
    })
  })

  test("a headless run from a session's scratchpad points at that session, even before its transcript is read", async () => {
    const probe = "22222222-3333-4444-8555-666666666666"
    const dir = join(projects, "-private-tmp")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${probe}.jsonl`),
      line({
        type: "user",
        uuid: "p1",
        entrypoint: "sdk-cli",
        cwd: `/private/tmp/claude-501/${PROJECT}/${LAUNCHER}/scratchpad/probe`,
        timestamp: "2026-10-06T10:03:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "probe" },
      }),
    )
    const pass = await backfill(db, projects)
    expect([pass.entries, pass.failed]).toEqual([1, 0])
    expect(await sessionRow(probe)).toMatchObject({ kind: "headless", parent_id: LAUNCHER })
    expect(await sessionRow(LAUNCHER)).toMatchObject({ entry_count: 0, kind: null })
  })

  test("a read cut short after its first chunk resumes from there on the next pass, and ends up whole", async () => {
    const big = join(projects, PROJECT, "33333333-4444-4555-8666-777777777777.jsonl")
    const lines = Array.from({ length: 40 }, (_, i) =>
      human(
        `b${i}`,
        `step ${i} ${"x".repeat(80)}`,
        `2026-10-06T11:00:${String(i).padStart(2, "0")}.000Z`,
      ),
    )
    writeFileSync(big, lines.join(""))
    let checks = 0
    const stopAfterOne = {
      get aborted() {
        checks += 1
        return checks > 1
      },
    }
    await ingestFile(db, projects, big, { chunkBytes: 1024, signal: stopAfterOne })
    const [cut] = await admin`select byte_offset, size from claude_transcript where path = ${big}`
    expect(Number(cut.byte_offset)).toBeLessThan(Bun.file(big).size)
    expect(Number(cut.size)).toBeLessThan(Bun.file(big).size)
    await ingestFile(db, projects, big, { chunkBytes: 1024 })
    const [whole] = await admin`select byte_offset, size from claude_transcript where path = ${big}`
    expect(Number(whole.byte_offset)).toBe(Bun.file(big).size)
    const row = await sessionRow("33333333-4444-4555-8666-777777777777")
    expect([row.entry_count, new Date(row.last_active_at).toISOString()]).toEqual([
      40,
      "2026-10-06T11:00:39.000Z",
    ])
  })

  test("a line longer than a chunk widens the read rather than stalling it", async () => {
    const long = join(projects, PROJECT, "44444444-5555-4666-8777-888888888888.jsonl")
    writeFileSync(long, human("l1", "y".repeat(5000), "2026-10-06T12:00:00.000Z"))
    expect((await ingestFile(db, projects, long, { chunkBytes: 512 }))?.entries).toBe(1)
  })

  test("a transcript emptied in place clears its entries", async () => {
    const id = "44444444-5555-4666-8777-888888888888"
    truncateSync(join(projects, PROJECT, `${id}.jsonl`), 0)
    await ingestFile(db, projects, join(projects, PROJECT, `${id}.jsonl`))
    expect(await entryCount(id)).toBe(0)
  })

  // Two transcript files carrying one session id (a checkout copied to a new folder): the importer reads each path from its own offset, and a reset in the shorter one must not wipe the longer one's rows.
  test("a reset in a shorter copy never wipes a longer transcript's rows", async () => {
    const id = "77777777-8888-4888-9999-000000000001"
    const olderDir = join(projects, `${PROJECT}-old`)
    mkdirSync(olderDir, { recursive: true })
    const older = join(olderDir, `${id}.jsonl`)
    const at = (i: number) => `2026-10-06T13:00:0${i}.000Z`
    writeFileSync(
      older,
      [
        human(`${id}-u1`, "older 1", at(1)),
        human(`${id}-u2`, "older 2", at(2)),
        human(`${id}-u3`, "older 3", at(3)),
      ].join(""),
    )
    await ingestFile(db, projects, older)
    expect(await entryCount(id)).toBe(3)
    const copy = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(
      copy,
      [human(`${id}-u1`, "older 1", at(1)), human(`${id}-u2`, "older 2", at(2))].join(""),
    )
    await ingestFile(db, projects, copy)
    expect(await entryCount(id)).toBe(3)
    writeFileSync(`${copy}.tmp`, human(`${id}-u1`, "older 1", at(1)))
    renameSync(`${copy}.tmp`, copy)
    const result = await ingestFile(db, projects, copy)
    expect(await entryCount(id)).toBe(3)
    expect(result?.duplicate).toBe(older)
  })

  test("a rewritten longer copy still replaces the session's rows", async () => {
    const id = "77777777-8888-4888-9999-000000000002"
    const olderDir = join(projects, `${PROJECT}-old`)
    mkdirSync(olderDir, { recursive: true })
    const older = join(olderDir, `${id}.jsonl`)
    const at = (i: number) => `2026-10-06T14:30:0${i}.000Z`
    writeFileSync(older, [human(`${id}-u1`, "a", at(1)), human(`${id}-u2`, "b", at(2))].join(""))
    await ingestFile(db, projects, older)
    const long = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(
      long,
      [
        human(`${id}-u1`, "a", at(1)),
        human(`${id}-u2`, "b", at(2)),
        human(`${id}-u3`, "c", at(3)),
      ].join(""),
    )
    await ingestFile(db, projects, long)
    expect(await entryCount(id)).toBe(3)
    writeFileSync(
      `${long}.tmp`,
      [
        human(`${id}-u1`, "a", at(1)),
        human(`${id}-u2`, "b", at(2)),
        human(`${id}-u3`, "c", at(3)),
        human(`${id}-u4`, "d", at(4)),
      ].join(""),
    )
    renameSync(`${long}.tmp`, long)
    const result = await ingestFile(db, projects, long)
    expect(await entryCount(id)).toBe(4)
    expect(result?.duplicate).toBeUndefined()
  })

  test("a pass reports each duplicate transcript it folded without wiping", async () => {
    const id = "77777777-8888-4888-9999-000000000005"
    const olderDir = join(projects, `${PROJECT}-old`)
    mkdirSync(olderDir, { recursive: true })
    const older = join(olderDir, `${id}.jsonl`)
    const at = (i: number) => `2026-10-06T15:30:0${i}.000Z`
    writeFileSync(
      older,
      [
        human(`${id}-u1`, "older 1", at(1)),
        human(`${id}-u2`, "older 2", at(2)),
        human(`${id}-u3`, "older 3", at(3)),
      ].join(""),
    )
    await ingestFile(db, projects, older)
    const copy = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(copy, human(`${id}-u1`, "older 1", at(1)))
    await ingestFile(db, projects, copy)
    writeFileSync(`${copy}.tmp`, human(`${id}-u1`, "older 1", at(1)))
    renameSync(`${copy}.tmp`, copy)
    const pass = await readAll(db, projects, [copy])
    expect(pass.duplicates).toEqual([`session ${id}: kept ${older} over ${copy}`])
    expect(await entryCount(id)).toBe(3)
  })

  test("a shorter copy read after the longer one leaves the session's facts as they are", async () => {
    const id = "77777777-8888-4888-9999-000000000007"
    const at = (i: number) => `2026-10-06T18:00:0${i}.000Z`
    const named = (uuid: string, branch: string, i: number) =>
      line({
        type: "user",
        uuid,
        timestamp: at(i),
        sessionId: id,
        cwd: "/Users/me/repo",
        gitBranch: branch,
        origin: { kind: "human" },
        message: { role: "user", content: `work ${i}` },
      })
    const long = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(
      long,
      [
        line({ type: "agent-name", agentName: "new-name", sessionId: id }),
        named(`${id}-u1`, "new-branch", 1),
        named(`${id}-u2`, "new-branch", 2),
        named(`${id}-u3`, "new-branch", 3),
      ].join(""),
    )
    expect((await ingestFile(db, projects, long))?.duplicate).toBeUndefined()
    expect(await sessionRow(id)).toMatchObject({ git_branch: "new-branch", name: "new-name" })
    const olderDir = join(projects, `${PROJECT}-old`)
    mkdirSync(olderDir, { recursive: true })
    const short = join(olderDir, `${id}.jsonl`)
    writeFileSync(
      short,
      [
        line({ type: "agent-name", agentName: "old-name", sessionId: id }),
        named(`${id}-u1`, "old-branch", 1),
      ].join(""),
    )
    const result = await ingestFile(db, projects, short)
    expect(result?.duplicate).toBe(long)
    expect(await entryCount(id)).toBe(3)
    expect(await sessionRow(id)).toMatchObject({ git_branch: "new-branch", name: "new-name" })
  })

  test("a chunk of plain lines folds the session without re-reading its entries", async () => {
    const id = "77777777-8888-4888-9999-000000000003"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(path, human(`${id}-u1`, "one", "2026-10-06T15:00:00.000Z"))
    await ingestFile(db, projects, path)
    await flushTokens()
    // The end-of-file sweep of a reset's marked rows probes (session_id, seq) and finds none outside a reset, so it is counted on its own, once per chunk that reaches the end.
    const SWEEP = `query ilike 'delete from %claude_entry%"seq" < %'`
    const calls = async (where: string) =>
      Number(
        (
          await admin.unsafe(
            `select coalesce(sum(calls), 0) as calls from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database()) and ${where}`,
          )
        )[0].calls,
      )
    const entryQueries = () => calls(`query ilike '%from %claude_entry%' and not (${SWEEP})`)
    const before = await entryQueries()
    const sweepsBefore = await calls(SWEEP)
    expect(before).toBeGreaterThan(0)
    appendFileSync(path, human(`${id}-u2`, "two", "2026-10-06T15:00:01.000Z"))
    await ingestFile(db, projects, path)
    expect(Number((await entryQueries()) - before)).toBe(0)
    expect((await calls(SWEEP)) - sweepsBefore).toBe(1)
    expect(await entryCount(id)).toBe(2)
    await flushTokens()
  })

  test("totals match a full recompute after every chunked append, a message split across chunks included", async () => {
    const id = "77777777-8888-4888-9999-000000000004"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    const foldedEqualsFull = async () => {
      const [folded] =
        await admin`select entry_count, started_at, last_active_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens from claude_session where id = ${id}`
      await admin`
        update claude_session s set
          entry_count = a.entry_count,
          started_at = a.started_at,
          last_active_at = a.last_active_at,
          input_tokens = t.input_tokens,
          output_tokens = t.output_tokens,
          cache_read_tokens = t.cache_read_tokens,
          cache_creation_tokens = t.cache_creation_tokens
        from (
          select count(*)::int as entry_count, min(at) as started_at, max(at) as last_active_at
          from claude_entry where session_id = ${id}
        ) a, (
          select coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens,
            coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
            coalesce(sum(cache_creation_tokens), 0) as cache_creation_tokens
          from (
            select distinct on (message_id) input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
            from claude_entry
            where session_id = ${id} and message_id is not null
            order by message_id, seq desc
          ) m
        ) t
        where s.id = ${id}`
      const [full] =
        await admin`select entry_count, started_at, last_active_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens from claude_session where id = ${id}`
      expect(folded).toEqual(full)
    }
    writeFileSync(
      path,
      [
        human(`${id}-u1`, "start", "2026-10-06T16:00:00.000Z"),
        block(
          `${id}-a1`,
          "m1",
          { type: "thinking", thinking: "", signature: "x" },
          "2026-10-06T16:00:01.000Z",
          3,
        ),
        block(`${id}-a2`, "m1", { type: "text", text: "one" }, "2026-10-06T16:00:02.000Z"),
      ].join(""),
    )
    await ingestFile(db, projects, path)
    await flushTokens()
    await foldedEqualsFull()
    appendFileSync(
      path,
      [
        block(`${id}-a3`, "m1", { type: "text", text: "two" }, "2026-10-06T16:00:03.000Z", 7),
        block(`${id}-a4`, "m2", { type: "text", text: "next" }, "2026-10-06T16:00:04.000Z", 5),
      ].join(""),
    )
    await ingestFile(db, projects, path)
    await flushTokens()
    await foldedEqualsFull()
    const parts = [
      human(`${id}-u2`, "z".repeat(900), "2026-10-06T16:00:05.000Z"),
      block(`${id}-a5`, "m3", { type: "text", text: "split" }, "2026-10-06T16:00:06.000Z", 4),
      block(`${id}-a6`, "m3", { type: "text", text: "across" }, "2026-10-06T16:00:07.000Z", 9),
      human(`${id}-u3`, "done", "2026-10-06T16:00:08.000Z"),
    ]
    appendFileSync(path, parts.join(""))
    const cut = Buffer.byteLength(parts.slice(0, 2).join(""))
    await ingestFile(db, projects, path, { chunkBytes: cut })
    await flushTokens()
    await foldedEqualsFull()
    expect(await entryCount(id)).toBe(9)
  })

  test("many chunks in one window recompute a session's tokens once", async () => {
    const TOKEN_WINDOW_MS = await tokenWindow()
    const id = "77777777-8888-4888-9999-000000000006"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(path, human(`${id}-u1`, "one", "2026-10-06T17:00:00.000Z"))
    await ingestFile(db, projects, path)
    await flushTokens()
    // The end-of-file sweep of a reset's marked rows probes (session_id, seq) and finds none outside a reset, so it is not a re-read.
    const entryQueries = async () =>
      Number(
        (
          await admin`select coalesce(sum(calls), 0) as calls from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database()) and query ilike '%from %claude_entry%' and query not ilike 'delete from %claude_entry%"seq" < %'`
        )[0].calls,
      )
    const before = await entryQueries()
    expect(before).toBeGreaterThan(0)
    for (let i = 2; i <= 5; i++) {
      appendFileSync(
        path,
        block(
          `${id}-a${i}`,
          `m${i}`,
          { type: "text", text: `part ${i}` },
          `2026-10-06T17:00:0${i}.000Z`,
        ),
      )
      await ingestFile(db, projects, path)
    }
    await Bun.sleep(TOKEN_WINDOW_MS + 1500)
    expect(Number((await entryQueries()) - before)).toBe(1)
    const [row] = await admin`select output_tokens from claude_session where id = ${id}`
    expect(row.output_tokens).toBe("40")
    await flushTokens()
  }, 20_000)

  test("a token recompute that waits behind a chunk's transaction stores the chunk's rows too", async () => {
    const TOKEN_WINDOW_MS = await tokenWindow()
    const id = "77777777-8888-4888-9999-000000000008"
    const path = join(projects, PROJECT, `${id}.jsonl`)
    writeFileSync(
      path,
      [
        human(`${id}-u1`, "one", "2026-10-06T19:00:00.000Z"),
        human(`${id}-u2`, "two", "2026-10-06T19:00:01.000Z"),
      ].join(""),
    )
    // The first chunk opens the window; the fire then waits behind a chunk that is still in flight, and must take its snapshot only once that chunk has committed.
    await ingestFile(db, projects, path)
    const release = await holdLock(id)
    let chunk: Promise<unknown> = Promise.resolve()
    try {
      appendFileSync(path, human(`${id}-u3`, "three", "2026-10-06T19:00:02.000Z"))
      chunk = ingestFile(db, projects, path)
      await Bun.sleep(TOKEN_WINDOW_MS + 500)
    } finally {
      await release()
    }
    await chunk
    expect((await sessionRow(id)).entry_count).toBe(3)
    expect(await entryCount(id)).toBe(3)
    await flushTokens()
  }, 20_000)

  const tokenPath = (id: string) => join(projects, PROJECT, `${id}.jsonl`)
  const reply = (id: string, n: number) =>
    block(
      `${id}-a${n}`,
      `${id}-m${n}`,
      { type: "text", text: `reply ${n}` },
      `2026-10-06T20:00:0${n}.000Z`,
    )
  // Holds a session's row lock in a transaction of its own, as a chunk in flight does, until the returned release commits it.
  const holdLock = async (id: string) => {
    const holder = new SQL(url, { max: 1 })
    await holder`begin`
    await holder`select id from claude_session where id = ${id} for update`
    return async () => {
      await holder`commit`
      holder.close()
    }
  }

  test("the live token window is a minute", async () => {
    const { TOKEN_WINDOW_MS } = await import("../../../../../../api/hono/src/lib/sessions/ingest")
    expect(TOKEN_WINDOW_MS).toBe(60_000)
  })

  test("two sessions' recounts run one at a time, the second behind the first", async () => {
    const TOKEN_WINDOW_MS = await tokenWindow()
    const [a, b] = ["77777777-8888-4888-9999-000000000009", "77777777-8888-4888-9999-000000000010"]
    for (const id of [a, b]) {
      writeFileSync(tokenPath(id), reply(id, 1))
      await ingestFile(db, projects, tokenPath(id))
    }
    await flushTokens()
    for (const id of [a, b]) {
      appendFileSync(tokenPath(id), reply(id, 2))
      await ingestFile(db, projects, tokenPath(id))
    }
    // Both windows are open; a's recount then waits on this lock, and b's must wait behind it rather than run beside it.
    const release = await holdLock(a)
    try {
      await Bun.sleep(TOKEN_WINDOW_MS + 1500)
      expect((await sessionRow(b)).output_tokens).toBe("10")
    } finally {
      await release()
    }
    await flushTokens()
    expect((await sessionRow(a)).output_tokens).toBe("20")
    expect((await sessionRow(b)).output_tokens).toBe("20")
  }, 20_000)

  test("a session that fires again while its recount still waits in the chain is recounted once", async () => {
    const TOKEN_WINDOW_MS = await tokenWindow()
    const [x, y] = ["77777777-8888-4888-9999-000000000012", "77777777-8888-4888-9999-000000000013"]
    for (const id of [x, y]) {
      writeFileSync(tokenPath(id), reply(id, 1))
      await ingestFile(db, projects, tokenPath(id))
    }
    await flushTokens()
    // Only a recount writes output_tokens, so this log holds one row a recount.
    await admin`create table recount_log (id text)`
    await admin.unsafe(
      "create function log_recount() returns trigger language plpgsql as $$ begin insert into recount_log values (new.id::text); return new; end $$",
    )
    await admin.unsafe(
      "create trigger log_recount after update of output_tokens on claude_session for each row execute function log_recount()",
    )
    try {
      appendFileSync(tokenPath(x), reply(x, 2))
      await ingestFile(db, projects, tokenPath(x))
      const release = await holdLock(x)
      try {
        // x's recount waits on the lock and y's queues behind it; y's next window then closes while that recount still waits.
        appendFileSync(tokenPath(y), reply(y, 2))
        await ingestFile(db, projects, tokenPath(y))
        await Bun.sleep(TOKEN_WINDOW_MS + 500)
        appendFileSync(tokenPath(y), reply(y, 3))
        await ingestFile(db, projects, tokenPath(y))
        await Bun.sleep(TOKEN_WINDOW_MS + 500)
      } finally {
        await release()
      }
      await flushTokens()
      expect(await admin`select id from recount_log where id = ${y}`).toHaveLength(1)
      expect((await sessionRow(y)).output_tokens).toBe("30")
    } finally {
      await admin`drop trigger log_recount on claude_session`
      await admin`drop function log_recount`
      await admin`drop table recount_log`
    }
  }, 30_000)

  test("a recount that throws marks its session again, so a later window totals it", async () => {
    const TOKEN_WINDOW_MS = await tokenWindow()
    const id = "77777777-8888-4888-9999-000000000011"
    writeFileSync(tokenPath(id), reply(id, 1))
    await ingestFile(db, projects, tokenPath(id))
    await flushTokens()
    appendFileSync(tokenPath(id), reply(id, 2))
    await ingestFile(db, projects, tokenPath(id))
    const release = await holdLock(id)
    try {
      await Bun.sleep(TOKEN_WINDOW_MS + 500)
      // The recount waits on the lock; ending its connection makes it throw.
      const ended =
        await admin`select pg_terminate_backend(pid) from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid()`
      expect(ended.length).toBe(1)
    } finally {
      await release()
    }
    await Bun.sleep(TOKEN_WINDOW_MS + 1500)
    expect((await sessionRow(id)).output_tokens).toBe("20")
    await flushTokens()
  }, 20_000)

  test("the guard proves this container local by its system identifier, and refuses a tunnel in front of it", async () => {
    expect(await provenLocal(url)).toMatch(
      /^127\.0\.0\.1:\d+\/postgres is \S+ \(postgres:18-alpine\), published on 127\.0\.0\.1 only, PostgreSQL /,
    )
    const [, port] = /:(\d+)\/postgres$/.exec(url) ?? []
    const forwarder = Bun.listen<{ upstream?: Awaited<ReturnType<typeof Bun.connect>> }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        async open(client) {
          client.data = {
            upstream: await Bun.connect({
              hostname: "127.0.0.1",
              port: Number(port),
              socket: {
                close: () => void client.end(),
                data: (_upstream, chunk) => void client.write(chunk),
              },
            }),
          }
        },
        close: (client) => void client.data?.upstream?.end(),
        data: (client, chunk) => void client.data?.upstream?.write(chunk),
      },
    })
    try {
      const tunnel = url.replace(`:${port}/`, `:${forwarder.port}/`)
      await expect(provenLocal(tunnel)).rejects.toThrow(
        `no single running Docker container publishes port ${forwarder.port}`,
      )
    } finally {
      forwarder.stop(true)
    }
  })

  test("search finds an entry by a word in it", async () => {
    const rows =
      await admin`select uuid from claude_entry where search @@ plainto_tsquery('simple', 'login bug')`
    expect(rows.map((r: { uuid: string }) => r.uuid)).toEqual(["u1"])
  })
  // a line that opens with [thread:<id>] is routed to that thread as ingest stores it
  describe("a thread's marker", () => {
    const at = (second: number) => `2026-10-23T10:00:${String(second).padStart(2, "0")}.000Z`
    const marked = (session: string) => ({
      assistant: (uuid: string, text: string, second: number) =>
        line({
          type: "assistant",
          uuid,
          timestamp: at(second),
          sessionId: session,
          message: {
            id: `msg_${uuid}`,
            model: "claude-opus-5-5",
            content: [{ type: "text", text }],
          },
        }),
      human: (uuid: string, text: string, second: number) =>
        line({
          type: "user",
          uuid,
          timestamp: at(second),
          sessionId: session,
          origin: { kind: "human" },
          message: { role: "user", content: text },
        }),
      peer: (uuid: string, text: string, second: number) =>
        line({
          type: "user",
          uuid,
          timestamp: at(second),
          sessionId: session,
          origin: { kind: "peer", from: "builder", body: text },
          message: { role: "user", content: text },
        }),
    })
    const pathOf = (session: string) => join(projects, PROJECT, `${session}.jsonl`)
    const tagOf = async (session: string, uuid: string) =>
      (
        await admin`select thread_id, thread_seq from claude_entry where session_id = ${session} and uuid = ${uuid}`
      )[0] as { thread_id: string | null; thread_seq: number | null }
    const updatedAt = async (id: string) =>
      (
        (await admin`select updated_at from thread where id = ${id}`)[0].updated_at as Date
      ).toISOString()
    const thread = (id: string) =>
      admin`insert into thread (id, title, updated_at) values (${id}, ${id}, '2026-01-01T00:00:00Z')`

    test("an assistant line that opens with [thread:bc23] is routed to it as its next, and bumps its updatedAt", async () => {
      const session = "11111111-2222-4333-8444-000000001848"
      const { assistant, human } = marked(session)
      await thread("bc23")
      writeFileSync(pathOf(session), human("h1", "[thread:bc23] Rename the sidebar", 1))
      await ingestFile(db, projects, pathOf(session))
      appendFileSync(
        pathOf(session),
        assistant("a1", "[thread:bc23] Renamed: it reads Threads now.", 2),
      )
      await ingestFile(db, projects, pathOf(session))
      expect(await tagOf(session, "h1")).toEqual({ thread_id: "bc23", thread_seq: 1 })
      expect(await tagOf(session, "a1")).toEqual({ thread_id: "bc23", thread_seq: 2 })
      expect(await updatedAt("bc23")).toBe(at(2))
    })

    test("a peer line is routed the same way", async () => {
      const session = "11111111-2222-4333-8444-000000001849"
      await thread("cd34")
      writeFileSync(pathOf(session), marked(session).peer("p1", "[thread:cd34] Merged #97.", 3))
      await ingestFile(db, projects, pathOf(session))
      expect(await tagOf(session, "p1")).toEqual({ thread_id: "cd34", thread_seq: 1 })
      expect(await updatedAt("cd34")).toBe(at(3))
    })

    test("a marker naming no thread and one past the start leave the line untagged, and a tagged line never moves", async () => {
      const session = "11111111-2222-4333-8444-000000001850"
      const { assistant, human } = marked(session)
      await thread("fg56")
      writeFileSync(
        pathOf(session),
        human("n1", "[thread:zz99] no such thread", 1) +
          assistant("n2", "Done, see [thread:fg56] for it.", 2) +
          human("n3", "[thread:gh78] filed elsewhere first", 3),
      )
      await ingestFile(db, projects, pathOf(session))
      expect(await tagOf(session, "n1")).toEqual({ thread_id: null, thread_seq: null })
      expect(await tagOf(session, "n2")).toEqual({ thread_id: null, thread_seq: null })
      expect(await tagOf(session, "n3")).toEqual({ thread_id: null, thread_seq: null })
      // a route files n3 under fg56, then gh78 appears and the file is read again from 0
      await admin`update claude_entry set thread_id = 'fg56', thread_seq = 1 where session_id = ${session} and uuid = 'n3'`
      await thread("gh78")
      const copy = `${pathOf(session)}.new`
      writeFileSync(
        copy,
        human("n1", "[thread:zz99] no such thread", 1) +
          assistant("n2", "Done, see [thread:fg56] for it.", 2) +
          human("n3", "[thread:gh78] filed elsewhere first", 3),
      )
      renameSync(copy, pathOf(session))
      await ingestFile(db, projects, pathOf(session))
      expect(await tagOf(session, "n3")).toEqual({ thread_id: "fg56", thread_seq: 1 })
      expect(await updatedAt("gh78")).toBe("2026-01-01T00:00:00.000Z")
    })

    test("two lines for one thread ingested together take its numbers in turn", async () => {
      const session = "11111111-2222-4333-8444-000000001851"
      const { assistant, human } = marked(session)
      await thread("jk9m")
      writeFileSync(
        pathOf(session),
        human("t1", "[Image #1] [thread:jk9m] first", 1) +
          assistant("t2", "[thread:jk9m] second", 2),
      )
      await ingestFile(db, projects, pathOf(session))
      expect(await tagOf(session, "t1")).toEqual({ thread_id: "jk9m", thread_seq: 1 })
      expect(await tagOf(session, "t2")).toEqual({ thread_id: "jk9m", thread_seq: 2 })
    })
  })

  test("a fenced client writes while its lock connection holds the lock; once the lock is gone its next chunk rolls back and it is told (#584)", async () => {
    // Loaded here, so a checkout of canary's source (no fence) fails only this test.
    const ingest = await import("../../../../../../api/hono/src/lib/sessions/ingest")
    const session = "11111111-2222-4333-8444-000000000584"
    const path = join(projects, PROJECT, `${session}.jsonl`)
    const offset = async () =>
      (await admin`select byte_offset from claude_transcript where path = ${path}`)[0]
        ?.byte_offset as number
    const holder = await new SQL(url, { max: 1 }).reserve()
    try {
      const [row] = await holder`select pg_advisory_lock(${INGEST_LOCK}), pg_backend_pid() as pid`
      const fenced = connect(url)
      const told: string[] = []
      ingest.fence(fenced, Number(row?.pid), (why) => told.push(why))
      writeFileSync(path, human("f1", "first", "2026-10-06T10:00:00.000Z"))
      await ingestFile(fenced, projects, path)
      await ingest.flushTokens(fenced)
      expect(await entryCount(session)).toBe(1)
      const before = await offset()
      expect(told).toEqual([])

      await holder`select pg_advisory_unlock(${INGEST_LOCK})`
      appendFileSync(path, human("f2", "second", "2026-10-06T10:00:01.000Z"))
      await expect(ingestFile(fenced, projects, path)).rejects.toThrow("no longer holds it")
      for (let i = 0; i < 100 && told.length === 0; i++) await Bun.sleep(10)
      expect(await entryCount(session)).toBe(1)
      expect(await offset()).toBe(before)
      expect(told).toEqual([`pid ${row?.pid} no longer holds it, so a write rolled back`])
    } finally {
      holder.release()
    }
  })

  // A made-up Codex rollout, its lines in the shapes Codex writes at rust-v0.167.1 (RolloutLine in codex-rs/history/src/lib.rs, ResponseItem in codex-rs/protocol/src/models.rs).
  const THREAD = "019a7c00-0000-7000-8000-00000000c0de"
  const ZST_THREAD = "019a7c00-0000-7000-8000-00000000beef"
  const rollout = (thread: string) =>
    [
      line({
        timestamp: "2026-11-11T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: thread,
          session_id: thread,
          timestamp: "2026-11-11T10:00:00.000Z",
          cwd: "/Users/me/repo",
          originator: "codex_cli_rs",
          cli_version: "0.167.1",
          source: "cli",
          model_provider: "openai",
          git: { branch: "main" },
        },
      }),
      line({
        timestamp: "2026-11-11T10:00:00.100Z",
        type: "turn_context",
        payload: { cwd: "/Users/me/repo", model: "gpt-5.5-codex" },
      }),
      line({
        timestamp: "2026-11-11T10:00:00.200Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>a sandbox</environment_context>" },
          ],
        },
      }),
      line({
        timestamp: "2026-11-11T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the flaky test\nwith details" }],
        },
      }),
      line({
        timestamp: "2026-11-11T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Reading the test" }],
        },
      }),
      line({
        timestamp: "2026-11-11T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ command: ["bun", "test"] }),
          call_id: "call_1",
        },
      }),
      line({
        timestamp: "2026-11-11T10:00:04.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_1", output: "1 pass" },
      }),
      line({
        timestamp: "2026-11-11T10:00:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fixed." }],
        },
      }),
      line({
        timestamp: "2026-11-11T10:00:05.100Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("")

  const rolloutDir = () => join(root, "codex", "sessions", "2026", "11", "11")
  const rolloutPath = (thread: string, suffix = "") =>
    join(rolloutDir(), `rollout-2026-11-11T10-00-00-${thread}.jsonl${suffix}`)
  type RolloutReader = (
    db: ReturnType<typeof connect>,
    sessions: string,
    path: string,
  ) => Promise<{ entries: number; id: string } | null>
  // Loaded per test, and typed here, so the Claude Code rows above still run and type-check on a checkout with no rollout reader.
  const ingestRollout = async (path: string) => {
    const reader = (await import("../../../../../../api/hono/src/lib/sessions/ingest")) as {
      ingestRollout?: RolloutReader
    }
    if (!reader.ingestRollout) throw new Error("no rollout reader")
    return reader.ingestRollout(db, join(root, "codex", "sessions"), path)
  }

  test("a Codex rollout ingests into one codex session keyed on its thread id, its turns kinded as the chat shows them", async () => {
    mkdirSync(rolloutDir(), { recursive: true })
    writeFileSync(rolloutPath(THREAD), rollout(THREAD))
    expect(await ingestRollout(rolloutPath(THREAD))).toEqual({ entries: 9, id: THREAD })
    expect(await sessionRow(THREAD)).toMatchObject({
      cwd: "/Users/me/repo",
      entry_count: 9,
      git_branch: "main",
      harness: "codex",
      kind: "interactive",
      model: "gpt-5.5-codex",
      task: "Fix the flaky test",
      version: "0.167.1",
    })
    const turns =
      await admin`select kind, text, tool from claude_entry where session_id = ${THREAD} and kind <> 'meta' order by seq`
    expect(
      turns.map((t: { kind: string; text: string; tool: string | null }) => [
        t.kind,
        t.text.split("\n")[0],
        t.tool,
      ]),
    ).toEqual([
      ["human", "Fix the flaky test", null],
      ["thinking", "Reading the test", null],
      ["tool", "bun test", "shell"],
      ["result", "1 pass", null],
      ["assistant", "Fixed.", null],
    ])
  })

  test("a second run over a rollout adds nothing, and its compressed copy stays the same one session", async () => {
    expect(await ingestRollout(rolloutPath(THREAD))).toEqual({ entries: 0, id: THREAD })
    writeFileSync(rolloutPath(THREAD, ".zst"), Bun.zstdCompressSync(rollout(THREAD)))
    expect(await ingestRollout(rolloutPath(THREAD, ".zst"))).toEqual({ entries: 0, id: THREAD })
    expect(await entryCount(THREAD)).toBe(9)
    const sessions = await admin`select count(*)::int as n from claude_session where id = ${THREAD}`
    expect(sessions[0].n).toBe(1)
  })

  test("a rollout that is only a .jsonl.zst ingests whole, and once", async () => {
    writeFileSync(rolloutPath(ZST_THREAD, ".zst"), Bun.zstdCompressSync(rollout(ZST_THREAD)))
    expect(await ingestRollout(rolloutPath(ZST_THREAD, ".zst"))).toEqual({
      entries: 9,
      id: ZST_THREAD,
    })
    expect(await ingestRollout(rolloutPath(ZST_THREAD, ".zst"))).toEqual({
      entries: 0,
      id: ZST_THREAD,
    })
    expect((await sessionRow(ZST_THREAD)).harness).toBe("codex")
  })

  test("a Claude Code transcript still ingests as a claude-code session", async () => {
    expect((await sessionRow(SESSION)).harness).toBe("claude-code")
  })

  test("a compressed rollout whose read is stopped part way ends up whole on the next pass", async () => {
    const CUT = "019a7c00-0000-7000-8000-00000000c07a"
    writeFileSync(rolloutPath(CUT, ".zst"), Bun.zstdCompressSync(rollout(CUT)))
    const { ingestRollout: read } =
      await import("../../../../../../api/hono/src/lib/sessions/ingest")
    let checks = 0
    const stopAfterOne = {
      get aborted() {
        checks += 1
        return checks > 1
      },
    }
    const sessions = join(root, "codex", "sessions")
    await read(db, sessions, rolloutPath(CUT, ".zst"), { chunkBytes: 512, signal: stopAfterOne })
    await read(db, sessions, rolloutPath(CUT, ".zst"))
    expect(await entryCount(CUT)).toBe(9)
  })

  test("a stack that reads this machine skips a rollout that is not Playground's own, unread", async () => {
    const FOREIGN = "019a7c00-0000-7000-8000-00000000f00d"
    writeFileSync(rolloutPath(FOREIGN), rollout(FOREIGN))
    const keys = [
      "PLAYGROUND_ALL_SESSIONS",
      "PLAYGROUND_DATA_DIR",
      "PLAYGROUND_FIXTURE",
      "PLAYGROUND_LIVE_READS",
    ]
    const saved = keys.map((key) => [key, process.env[key]] as const)
    Object.assign(process.env, {
      PLAYGROUND_DATA_DIR: join(root, "own-data"),
      PLAYGROUND_LIVE_READS: "1",
    })
    delete process.env.PLAYGROUND_ALL_SESSIONS
    delete process.env.PLAYGROUND_FIXTURE
    try {
      expect(await ingestRollout(rolloutPath(FOREIGN))).toBeNull()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(await sessionRow(FOREIGN)).toBeUndefined()
  })
})

describe("mergeSession", () => {
  const file = { id: SESSION, parentId: null, projectDir: PROJECT, subagent: false }

  test("the launch directory, kind and parent stay once known; a later name, branch or model replaces the earlier one", () => {
    const first = mergeSession(file, null, {
      ...emptyFacts(),
      cwd: "/a",
      entrypoint: "cli",
      gitBranch: "main",
      name: "pride",
    })
    const second = mergeSession(file, first, {
      ...emptyFacts(),
      cwd: "/b",
      entrypoint: "sdk-cli",
      gitBranch: "feat/x",
      name: "worker-pride",
    })
    expect(second).toMatchObject({
      cwd: "/a",
      gitBranch: "feat/x",
      kind: "interactive",
      name: "worker-pride",
    })
  })

  test("costs keep each run's highest total and PRs accumulate", () => {
    const first = mergeSession(file, null, { ...emptyFacts(), costs: { "1": 0.5 }, prUrls: ["a"] })
    const second = mergeSession(file, first, {
      ...emptyFacts(),
      costs: { "1": 0.25, "2": 1 },
      prUrls: ["a", "b"],
    })
    expect(second.costs).toEqual({ "1": 0.5, "2": 1 })
    expect(second.costUsd).toBe(1.5)
    expect(second.prUrls).toEqual(["a", "b"])
  })

  test("a nested subagent's parent comes from its meta file, even over a parent read before the meta existed", () => {
    const sub = { ...file, id: "a2", parentId: SESSION, subagent: true }
    const early = mergeSession(sub, null, emptyFacts())
    expect(early.parentId).toBe(SESSION)
    const meta = { agentType: "Explore", description: null, isFork: false, parentAgentId: "a1" }
    expect(mergeSession(sub, early, emptyFacts(), meta).parentId).toBe("a1")
  })

  test("a subagent becomes a fork once a fork-context-ref is seen, and stays one", () => {
    const sub = { ...file, id: "a1", parentId: SESSION, subagent: true }
    const forked = mergeSession(sub, null, { ...emptyFacts(), forkParent: SESSION })
    expect(forked.kind).toBe("fork")
    expect(mergeSession(sub, forked, emptyFacts()).kind).toBe("fork")
  })
})
