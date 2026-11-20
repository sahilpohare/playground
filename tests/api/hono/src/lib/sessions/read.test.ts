import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SQL } from "bun"

import { processStarts } from "../../../../../../api/hono/src/lib/dashboard/peers"
import { parseLines } from "../../../../../../api/hono/src/lib/dashboard/transcript"
import { backfill, connect } from "../../../../../../api/hono/src/lib/sessions/ingest"
import { projectsDir } from "../../../../../../api/hono/src/lib/sessions/paths"
import {
  listSessions,
  liveRegistered,
  liveSessions,
  readEntries,
  readEntriesAfter,
  readSession,
  readSteps,
  relationOf,
  sessionExists,
  startOf,
  type Live,
} from "../../../../../../api/hono/src/lib/sessions/read"
import { testContainerName } from "../../../../../container"
import { onLiveDashboard } from "../../../../../dashboard-fixture"
import { liveReads } from "../../../../../live-reads"
import { pidsDir, withProc } from "../../../../../scripts/fixtures/proc"

// These drive the live paths against the test's own scratch files, every one of them stored as on a stack opted in to every session (own.ts).
liveReads({ PLAYGROUND_ALL_SESSIONS: "true" })

// Reads back what the importer wrote, from a throwaway Postgres in Docker published on 127.0.0.1 only, with the repo's migrations applied; skipped where Docker is not running.
const MIGRATIONS = join(import.meta.dir, "../../../../../../packages/db/drizzle")
const PASSWORD = "read-test"

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

const LEAD = "11111111-aaaa-4aaa-8aaa-111111111111"
const WORKER = "22222222-bbbb-4bbb-8bbb-222222222222"
const PROBE = "33333333-cccc-4ccc-8ccc-333333333333"
const AGENT = "a0b1c2d3e4f5a6b7c"
const ODD = "44444444-dddd-4ddd-8ddd-444444444444"
const MIXED = "55555555-eeee-4eee-8eee-555555555555"
const FILES = "66666666-ffff-4fff-8fff-666666666666"
const CUT_LOG = "77777777-aaaa-4aaa-8aaa-777777777777"
const CUT_SEARCH = "88888888-bbbb-4bbb-8bbb-888888888888"
// Four sessions of one name: a fresh start, a /clear after it, a handover from a note, and one beside the handover.
const CHAIN_FRESH = "99999999-0001-4999-8999-999999999999"
const CHAIN_CLEAR = "99999999-0002-4999-8999-999999999999"
const CHAIN_HANDOVER = "99999999-0003-4999-8999-999999999999"
const CHAIN_BESIDE = "99999999-0004-4999-8999-999999999999"
// dispatcher's session in the shipped fixture, and builder's, which picked up from a handover note.
const FIXTURE_LEAD = "11111111-1111-4111-8111-000000000001"
const FIXTURE_BUILDER = "11111111-1111-4111-8111-000000000002"
// A reply whose word "needle" sits past the 4,000 characters a matching line is drawn from, and which runs past the 8,000 a page shows.
const LONG = `${"x ".repeat(2100)}needle ${"y ".repeat(2000)}`
const PROJECT = "-Users-me-repo"

let clock = 0
const line = (session: string, fields: Record<string, unknown>) => {
  clock += 1
  return `${JSON.stringify({
    cwd: "/Users/me/repo",
    entrypoint: "cli",
    sessionId: session,
    timestamp: new Date(Date.UTC(2026, 9, 6, 10, 0, clock)).toISOString(),
    ...fields,
  })}\n`
}

const said = (session: string, uuid: string, text: string) =>
  line(session, {
    message: { content: [{ text, type: "text" }], id: `m-${uuid}`, model: "claude-opus-5-5" },
    type: "assistant",
    uuid,
  })

const none = new Map<string, Live>()

const list = (db: ReturnType<typeof connect>, input: Partial<Parameters<typeof listSessions>[1]>) =>
  listSessions(
    db,
    { dir: "desc", kinds: [], page: 1, perPage: 50, sort: "lastActive", ...input },
    none,
  )

describe.skipIf(!dockerUp())("reading sessions back", () => {
  let container = ""
  let home = ""
  let db: ReturnType<typeof connect>
  let mixedText = ""
  let url = ""

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("sessions-read"),
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18-alpine",
    ])
      .stdout.toString()
      .trim()
    const port = Bun.spawnSync(["docker", "port", container, "5432/tcp"])
      .stdout.toString()
      .trim()
      .split(":")
      .at(-1)
    url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`
    let admin: SQL | null = null
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
      const migration = await Bun.file(join(MIGRATIONS, `${tag}.sql`)).text()
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await admin!.unsafe(statement)
      }
    }
    home = mkdtempSync(join(tmpdir(), "sessions-read-"))
    const projects = join(home, "projects")
    mkdirSync(join(projects, PROJECT, WORKER, "subagents"), { recursive: true })
    mkdirSync(join(projects, "-tmp"), { recursive: true })
    writeFileSync(
      join(projects, PROJECT, `${LEAD}.jsonl`),
      line(LEAD, { agentName: "dispatcher", type: "agent-name" }) +
        line(LEAD, {
          message: { content: "Ship it" },
          origin: { kind: "human" },
          type: "user",
          uuid: "l1",
        }) +
        said(LEAD, "l2", "Handing it to a worker") +
        line(LEAD, { startTime: 1, totalCostUSD: 1.5, type: "cost-state" }),
    )
    writeFileSync(
      join(projects, PROJECT, `${WORKER}.jsonl`),
      line(WORKER, { agentName: "worker-sloth", type: "agent-name" }) +
        line(WORKER, {
          isMeta: true,
          message: { content: "build it" },
          origin: { body: "Build the importer", kind: "peer", name: "dispatcher" },
          type: "user",
          uuid: "w1",
        }) +
        said(WORKER, "w2", "The advisory lock keeps one importer per database") +
        line(WORKER, {
          attachment: { stdout: "ok", type: "hook_success" },
          type: "attachment",
          uuid: "w3",
        }) +
        said(WORKER, "w4", "Done") +
        line(WORKER, { prUrl: "https://github.com/o/r/pull/7", type: "pr-link" }),
    )
    writeFileSync(
      join(projects, PROJECT, WORKER, "subagents", `agent-${AGENT}.jsonl`),
      line(WORKER, { message: { content: "Find the hub" }, type: "user", uuid: "s1" }),
    )
    writeFileSync(
      join(projects, PROJECT, WORKER, "subagents", `agent-${AGENT}.meta.json`),
      JSON.stringify({ agentType: "Explore", description: "Find the hub" }),
    )
    writeFileSync(
      join(projects, "-tmp", `${PROBE}.jsonl`),
      line(PROBE, {
        cwd: `/private/tmp/claude-501/${PROJECT}/${LEAD}/scratchpad/probe`,
        entrypoint: "sdk-cli",
        message: { content: "/probe-scan" },
        type: "user",
        uuid: "p1",
      }),
    )
    writeFileSync(
      join(projects, PROJECT, `${ODD}.jsonl`),
      line(ODD, { aiTitle: "Nightly backfill", type: "ai-title" }) +
        line(ODD, {
          message: { content: "rate 100% done_ok" },
          origin: { kind: "human" },
          type: "user",
          uuid: "o1",
        }) +
        said(ODD, "o2", LONG) +
        line(ODD, {
          message: {
            content: [
              {
                id: "t1",
                input: { command: "bun run test", description: "Run the tests" },
                name: "Bash",
                type: "tool_use",
              },
            ],
            id: "m-o3",
          },
          type: "assistant",
          uuid: "o3",
        }),
    )
    const mixed =
      line(MIXED, {
        message: { content: "start" },
        origin: { kind: "human" },
        type: "user",
        uuid: "x1",
      }) +
      line(MIXED, {
        message: {
          content: [
            { text: "Checking first", type: "text" },
            {
              id: "t1",
              input: { command: "ls", description: "List files" },
              name: "Bash",
              type: "tool_use",
            },
          ],
          id: "m-mb",
        },
        type: "assistant",
        uuid: "mb",
      }) +
      line(MIXED, {
        message: { content: [{ content: "a.txt", tool_use_id: "t1", type: "tool_result" }] },
        toolUseResult: { stdout: "a.txt" },
        type: "user",
        uuid: "r1",
      }) +
      line(MIXED, {
        message: { content: [{ signature: "s", thinking: "", type: "thinking" }], id: "m-th" },
        type: "assistant",
        uuid: "th",
      }) +
      line(MIXED, {
        attachment: { origin: { kind: "human" }, prompt: "also this", type: "queued_command" },
        type: "attachment",
        uuid: "q1",
      }) +
      line(MIXED, {
        attachment: {
          origin: { body: "from the lead", kind: "peer", name: "builder" },
          prompt: "x",
          type: "queued_command",
        },
        type: "attachment",
        uuid: "q2",
      }) +
      line(MIXED, {
        message: {
          content: [
            { source: { data: "QUJD", media_type: "image/png", type: "base64" }, type: "image" },
            { text: "see the picture", type: "text" },
          ],
        },
        origin: { kind: "human" },
        type: "user",
        uuid: "im",
      }) +
      Array.from({ length: 150 }, (_, i) =>
        line(MIXED, {
          isSidechain: true,
          message: { content: [{ text: "an aside", type: "text" }], id: `m-s${i}` },
          type: "assistant",
          uuid: `sc${i}`,
        }),
      ).join("") +
      line(MIXED, {
        message: { content: "end" },
        origin: { kind: "human" },
        type: "user",
        uuid: "x2",
      })
    writeFileSync(join(projects, PROJECT, `${MIXED}.jsonl`), mixed)
    mixedText = mixed
    db = connect(url)
    await backfill(db, projects)
  }, 60_000)

  // docker rm -fv of a container on a loaded machine can cross bun's 5s default, the recorded hook timeout
  afterAll(() => {
    if (container) {
      Bun.spawnSync(["docker", "rm", "-fv", container], { stderr: "ignore", stdout: "ignore" })
    }
    if (home) rmSync(home, { force: true, recursive: true })
  }, 60_000)

  test("lists every session, newest activity first", async () => {
    const { rows, total } = await list(db, {})
    expect(total).toBe(6)
    expect(rows.map((row) => row.id)).toEqual([MIXED, ODD, PROBE, AGENT, WORKER, LEAD])
    expect(rows.find((row) => row.id === LEAD)).toMatchObject({
      costUsd: 1.5,
      kind: "interactive",
      live: false,
      name: "dispatcher",
      task: "Ship it",
    })
  })

  test("a session imported before a person's slash command was read back shows the command", async () => {
    const sql = new SQL(url, { max: 1 })
    const tags =
      "<command-message>linear</command-message>\n<command-name>/linear</command-name>\n<command-args>QA</command-args>"
    try {
      await sql`update claude_session set task = '<command-message>linear</command-message>' where id = ${LEAD}`
      await sql`update claude_entry set text = ${tags} where session_id = ${LEAD} and uuid = 'l1'`
      expect((await list(db, {})).rows.find((row) => row.id === LEAD)?.task).toBe("/linear")
      expect((await readSession(db, LEAD, none))?.task).toBe("/linear")
      const { entries } = await readEntries(db, LEAD, { kinds: ["human"], limit: 10 })
      expect(entries.map((entry) => entry.text)).toEqual(["/linear QA"])
      // the headline drops tags, so the matching line is read from the entry's own text
      const found = await list(db, { q: "QA" })
      expect(found.rows.find((row) => row.id === LEAD)?.match).toBe("/linear QA")
      await sql`update claude_session set task = '<command-message>init is analyzing your codebase…</command-message>' where id = ${LEAD}`
      expect((await readSession(db, LEAD, none))?.task).toBe("/init")
    } finally {
      await sql`update claude_session set task = 'Ship it' where id = ${LEAD}`
      await sql`update claude_entry set text = 'Ship it' where session_id = ${LEAD} and uuid = 'l1'`
      await sql.close()
    }
  })

  test("filters by kind, pages, and sorts by a whitelisted column", async () => {
    expect((await list(db, { kinds: ["headless", "subagent"] })).rows.map((row) => row.id)).toEqual(
      [PROBE, AGENT],
    )
    const page = await list(db, { page: 2, perPage: 4 })
    expect([page.total, page.rows.map((row) => row.id)]).toEqual([6, [WORKER, LEAD]])
    expect((await list(db, { dir: "asc", sort: "entries" })).rows[0]?.id).toBe(PROBE)
  })

  test("a query matches a name, a task, a title or the start of an id", async () => {
    expect((await list(db, { q: "sloth" })).rows.map((row) => row.id)).toEqual([WORKER])
    expect((await list(db, { q: "importer" })).rows.map((row) => row.id)).toEqual([WORKER])
    expect((await list(db, { q: "nightly" })).rows.map((row) => row.id)).toEqual([ODD])
    expect((await list(db, { q: "44444444-dddd" })).rows.map((row) => row.id)).toEqual([ODD])
    expect((await list(db, { q: "dddd-4ddd" })).total).toBe(0)
    expect((await list(db, { q: "nothing-like-this" })).total).toBe(0)
  })

  test("% and _ match themselves, not any text", async () => {
    expect((await list(db, { q: "100%" })).rows.map((row) => row.id)).toEqual([ODD])
    expect((await list(db, { q: "%" })).rows.map((row) => row.id)).toEqual([ODD])
    expect((await list(db, { q: "_" })).rows.map((row) => row.id)).toEqual([ODD])
  })

  test("a word only the log holds matches, and the row says which line held it", async () => {
    const words = await list(db, { q: "advisory lock" })
    expect(words.rows.map((row) => [row.id, row.task])).toEqual([[WORKER, "Build the importer"]])
    expect(words.rows[0]?.match).toContain("advisory lock")
  })

  test("a word past the part a line is drawn from still matches, with no line rather than a wrong one", async () => {
    const far = await list(db, { q: "needle" })
    expect(far.rows.map((row) => [row.id, row.match])).toEqual([[ODD, null]])
  })

  test("search input websearch reads oddly never fails", async () => {
    for (const q of ['"', "-", "or", "!", "(", "<->", ":*", "a & b | !c", "'", "\\"]) {
      expect(Array.isArray((await list(db, { q })).rows)).toBe(true)
    }
  })

  test("live comes from the registry, and is unknown for a subagent, which has no registry file", async () => {
    const live = new Map<string, Live>([
      [WORKER, { status: "busy" }],
      [AGENT, { status: "busy" }],
    ])
    const { rows } = await listSessions(
      db,
      { dir: "desc", kinds: [], page: 1, perPage: 50, sort: "lastActive" },
      live,
    )
    expect(rows.find((row) => row.id === WORKER)).toMatchObject({ live: true, status: "busy" })
    expect(rows.find((row) => row.id === LEAD)).toMatchObject({ live: false, status: null })
    expect(rows.find((row) => row.id === AGENT)?.live).toBeNull()
  })

  test("a session reads with its PRs, the sessions it started and the one that started it", async () => {
    const worker = await readSession(db, WORKER, none)
    expect(worker?.prUrls).toEqual(["https://github.com/o/r/pull/7"])
    expect(worker?.childCount).toBe(1)
    expect(worker?.children.map((child) => [child.id, child.description])).toEqual([
      [AGENT, "Find the hub"],
    ])
    const probe = await readSession(db, PROBE, none)
    expect(probe?.parent).toEqual({
      agentType: null,
      aiTitle: null,
      cwd: "/Users/me/repo",
      description: null,
      id: LEAD,
      name: "dispatcher",
    })
    expect(await readSession(db, "no-such-session", none)).toBeNull()
  })

  test("the log pages back from the newest lines, each page in file order, never repeating a line", async () => {
    const newest = await readEntries(db, WORKER, { kinds: [], limit: 2 })
    expect(newest.entries.map((entry) => entry.uuid)).toEqual(["w3", "w4"])
    const older = await readEntries(db, WORKER, { before: newest.before!, kinds: [], limit: 2 })
    expect([older.entries.map((entry) => entry.uuid), older.before]).toEqual([["w1", "w2"], null])
  })

  test("the log pages forward after a cursor, for a bot's read of the dispatcher's log (#1888)", async () => {
    const first = (await readEntries(db, WORKER, { kinds: [], limit: 10 })).entries[0]!.seq
    const page = await readEntriesAfter(db, WORKER, { after: first, limit: 2 })
    expect([page.entries.map((entry) => entry.uuid), page.hasMore]).toEqual([["w2", "w3"], true])
    const next = await readEntriesAfter(db, WORKER, { after: page.entries.at(-1)!.seq, limit: 2 })
    expect([next.entries.map((entry) => entry.uuid), next.hasMore]).toEqual([["w4"], false])
  })

  test("the log can hold only the kinds asked for", async () => {
    const steps = await readEntries(db, WORKER, { kinds: ["assistant", "peer"], limit: 10 })
    expect(steps.entries.map((entry) => [entry.kind, entry.sender])).toEqual([
      ["peer", "dispatcher"],
      ["assistant", null],
      ["assistant", null],
    ])
    expect(steps.entries[0]?.clipped).toBe(false)
  })

  test("a long line is cut to what the page shows and says so, and a tool step sends only its summary", async () => {
    const odd = await readEntries(db, ODD, { kinds: ["assistant", "tool"], limit: 10 })
    const [long, tool] = odd.entries
    expect([long?.clipped, long?.text.length]).toEqual([true, 8000])
    expect([tool?.kind, tool?.text, tool?.clipped]).toEqual(["tool", "Run the tests", false])
  })

  test("a worker's older steps come from the database as its live view makes them, paged back from a step it shows", async () => {
    const steps = await readSteps(db, WORKER, { beforeId: "w4:0", limit: 10 })
    expect([steps.anchored, steps.hasMore]).toEqual([true, false])
    expect(steps.entries.map((entry) => [entry.id, entry.kind, entry.from, entry.text])).toEqual([
      ["w1", "peer", "dispatcher", "Build the importer"],
      ["w2:0", "assistant", null, "The advisory lock keeps one importer per database"],
    ])
  })

  test("a line stored as one JSON string, as the importer once wrote it, reads back beside a stored object as the same steps", async () => {
    const before = await readSteps(db, WORKER, { beforeId: "w4:0", limit: 10 })
    const admin = new SQL(url, { max: 1 })
    try {
      await admin`update claude_entry set raw = to_jsonb(raw::text) where session_id = ${WORKER} and uuid = 'w2'`
      const types =
        await admin`select uuid, jsonb_typeof(raw) as type from claude_entry where session_id = ${WORKER} and uuid in ('w1', 'w2') order by uuid`
      expect(types.map((r: { type: string; uuid: string }) => [r.uuid, r.type])).toEqual([
        ["w1", "object"],
        ["w2", "string"],
      ])
      expect(await readSteps(db, WORKER, { beforeId: "w4:0", limit: 10 })).toEqual(before)
    } finally {
      await admin`update claude_entry set raw = (raw #>> '{}')::jsonb where session_id = ${WORKER} and jsonb_typeof(raw) = 'string'`
      await admin.close()
    }
  })

  test("paging back from a step through every older page gives exactly the steps the live parser makes from the file", async () => {
    const pick = (entry: { id: string; kind: string; text: string }) => [
      entry.id,
      entry.kind,
      entry.text,
    ]
    let page = await readSteps(db, MIXED, { beforeId: "x2", limit: 3 })
    const pages = [page.entries]
    for (let guard = 0; page.hasMore && guard < 200; guard++) {
      page = await readSteps(db, MIXED, { before: page.before ?? 0, limit: 3 })
      pages.unshift(page.entries)
    }
    const expected = parseLines(mixedText).filter((entry) => entry.id !== "x2")
    expect(pages.flat().map(pick)).toEqual(expected.map(pick))
    expect(expected.map((entry) => entry.id)).toEqual([
      "x1",
      "mb:0",
      "mb:1",
      "r1:0",
      "q1",
      "q2",
      "im",
    ])
  })

  test("a page of lines that make no step still moves the cursor on, so the steps before them are reached", async () => {
    const first = await readSteps(db, MIXED, { beforeId: "x2", limit: 100 })
    expect([first.entries, first.hasMore]).toEqual([[], true])
    const next = await readSteps(db, MIXED, { before: first.before ?? 0, limit: 100 })
    expect(next.entries.map((entry) => entry.id)).toEqual([
      "x1",
      "mb:0",
      "mb:1",
      "r1:0",
      "q1",
      "q2",
      "im",
    ])
  })

  test("from a later block of a line, the blocks before it are steps that come earlier", async () => {
    const steps = await readSteps(db, MIXED, { beforeId: "mb:1", limit: 10 })
    expect(steps.entries.map((entry) => entry.id)).toEqual(["x1", "mb:0"])
  })

  test("a tagged line a stopped reset has not reached yet, at a negative seq, stays out of the log, the steps and a search", async () => {
    const admin = new SQL(url, { max: 1 })
    try {
      await admin`update claude_entry set seq = -1 - seq where session_id = ${WORKER} and uuid = 'w2'`
      const log = await readEntries(db, WORKER, { kinds: [], limit: 10 })
      expect([log.entries.map((entry) => entry.uuid), log.before]).toEqual([
        ["w1", "w3", "w4"],
        null,
      ])
      const steps = await readSteps(db, WORKER, { beforeId: "w4:0", limit: 10 })
      expect(steps.entries.map((entry) => entry.id)).toEqual(["w1"])
      expect((await readSteps(db, WORKER, { beforeId: "w2:0", limit: 10 })).anchored).toBe(false)
      expect((await list(db, { q: "advisory lock" })).rows).toEqual([])
    } finally {
      await admin`update claude_entry set seq = -1 - seq where session_id = ${WORKER} and uuid = 'w2'`
      await admin.close()
    }
  })

  test("a step the database has not read yet anchors nothing", async () => {
    expect(await readSteps(db, WORKER, { beforeId: "not-read-yet", limit: 10 })).toEqual({
      anchored: false,
      before: null,
      entries: [],
      hasMore: false,
    })
  })

  const ATTACHMENT = "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png"

  // A person's message sent with one file, as the dashboard types it, into a session of its own, read into the database with this test's attachments folder in place.
  const withFile = async (
    session: string,
    words: string,
    check: (folder: string) => Promise<void>,
  ) => {
    const folder = join(home, "attachments")
    const before = process.env.PLAYGROUND_ATTACHMENTS_DIR
    process.env.PLAYGROUND_ATTACHMENTS_DIR = folder
    try {
      writeFileSync(
        join(home, "projects", PROJECT, `${session}.jsonl`),
        line(session, {
          message: { content: `${words}\n\nAttached: ${join(folder, ATTACHMENT)}` },
          origin: { kind: "human" },
          type: "user",
          uuid: `${session}-1`,
        }),
      )
      await backfill(db, join(home, "projects"))
      await check(folder)
    } finally {
      if (before === undefined) delete process.env.PLAYGROUND_ATTACHMENTS_DIR
      else process.env.PLAYGROUND_ATTACHMENTS_DIR = before
    }
  }

  test("a log and a search line show an attached file by its id, never the attachments folder's path", async () => {
    await withFile(FILES, "the kettle sketch", async (folder) => {
      const { entries } = await readEntries(db, FILES, { kinds: ["human"], limit: 10 })
      expect(entries.map((entry) => entry.text)).toEqual([
        `the kettle sketch\n\nAttached: ${ATTACHMENT}`,
      ])
      const match = (await list(db, { q: "Attached" })).rows.find((row) => row.id === FILES)?.match
      expect(match).toContain(ATTACHMENT)
      expect(match).not.toContain(folder)
    })
  })

  test("a long paste imported with Claude Code's tags shows only its words in the log", async () => {
    const sql = new SQL(url, { max: 1 })
    const wrapped = '\n\n<pasted_content id="ab12">\nlong words\n</pasted_content id="ab12">\n'
    try {
      await sql`update claude_entry set text = ${wrapped} where session_id = ${LEAD} and uuid = 'l1'`
      const { entries } = await readEntries(db, LEAD, { kinds: ["human"], limit: 10 })
      expect(entries.map((entry) => entry.text)).toEqual(["long words"])
    } finally {
      await sql`update claude_entry set text = 'Ship it' where session_id = ${LEAD} and uuid = 'l1'`
      await sql.close()
    }
  })

  // The words end 8 characters short of the 8,000 a log shows, and 9 short of the 4,000 a search line is drawn from, so a path left in until the cut would show its first characters.
  test("a log cut inside an Attached line shows none of the folder's path", async () => {
    await withFile(CUT_LOG, "zebra ".repeat(1330), async (folder) => {
      const [entry] = (await readEntries(db, CUT_LOG, { kinds: ["human"], limit: 10 })).entries
      expect(entry?.clipped).toBe(true)
      expect(entry?.text).toEndWith("Attached: 3f0e7a52")
      expect(entry?.text).not.toContain(folder.slice(0, 5))
    })
  })

  test("a search line cut inside an Attached line shows none of the folder's path", async () => {
    await withFile(CUT_SEARCH, `${"y ".repeat(1984)}quaggafinal`, async (folder) => {
      const match = (await list(db, { q: "quaggafinal" })).rows.find(
        (row) => row.id === CUT_SEARCH,
      )?.match
      expect(match).toContain("quaggafinal")
      expect(match).not.toContain(folder.slice(0, 5))
    })
  })

  test("a session lists the others of its name, nearest first on each side, each with how it began and where it sits", async () => {
    const [fresh, cleared, handed, beside] = [
      CHAIN_FRESH,
      CHAIN_CLEAR,
      CHAIN_HANDOVER,
      CHAIN_BESIDE,
    ]
    const named = (session: string) =>
      line(session, { agentName: "worker-chain", type: "agent-name" })
    const ask = (session: string, uuid: string, fields: Record<string, unknown>) =>
      line(session, { type: "user", uuid, ...fields })
    const dir = join(home, "projects", PROJECT)
    writeFileSync(
      join(dir, `${fresh}.jsonl`),
      named(fresh) +
        ask(fresh, "c1", { message: { content: "Build the board" }, origin: { kind: "human" } }) +
        said(fresh, "c2", "Built"),
    )
    writeFileSync(
      join(dir, `${cleared}.jsonl`),
      named(cleared) +
        ask(cleared, "c3", {
          isMeta: true,
          message: { content: "<local-command-caveat>Caveat</local-command-caveat>" },
        }) +
        ask(cleared, "c4", {
          message: {
            content:
              "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
          },
        }) +
        said(cleared, "c5", "Carrying on"),
    )
    // The handover and the session beside it overlap: one starts while the other still runs.
    const handover = ask(handed, "c6", {
      message: { content: "x" },
      origin: {
        body: "Pick up from ~/.playground/handoffs/worker-chain-2026-10-06.md, then go on.",
        kind: "peer",
        name: "builder",
      },
    })
    const besideAsk = ask(beside, "c7", {
      message: { content: "Also on the board" },
      origin: { kind: "human" },
    })
    const handedLast = said(handed, "c8", "Picked up")
    writeFileSync(join(dir, `${handed}.jsonl`), named(handed) + handover + handedLast)
    writeFileSync(join(dir, `${beside}.jsonl`), named(beside) + besideAsk)
    await backfill(db, join(home, "projects"))

    const middle = await readSession(db, cleared, none)
    expect(middle?.start).toEqual({ kind: "clear", note: null })
    expect(middle?.chain?.total).toBe(3)
    expect(
      middle?.chain?.sessions.map((session) => [session.id, session.relation, session.start]),
    ).toEqual([
      [fresh, "before", { kind: "fresh", note: null }],
      [handed, "after", { kind: "handover", note: "worker-chain-2026-10-06.md" }],
      [beside, "after", { kind: "fresh", note: null }],
    ])
    expect(
      (await readSession(db, handed, none))?.chain?.sessions.map((session) => session.relation),
    ).toEqual(["before", "before", "alongside"])
    expect((await readSession(db, LEAD, none))?.chain).toEqual({ sessions: [], total: 0 })
    expect((await readSession(db, AGENT, none))?.chain).toBeNull()
    expect((await readSession(db, ODD, none))?.chain).toBeNull()

    const { rows, total } = await list(db, { names: ["worker-chain", "no-such-name"] })
    expect(total).toBe(4)
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([fresh, cleared, handed, beside]))
  })

  test("a chain lists the five nearest on each side in the order they started, counts the rest, and leaves out a subagent of the name", async () => {
    const dir = join(home, "projects", PROJECT)
    const ids = Array.from(
      { length: 13 },
      (_, i) => `99999999-1${String(i).padStart(3, "0")}-4999-8999-999999999999`,
    )
    for (const [i, id] of ids.entries()) {
      writeFileSync(
        join(dir, `${id}.jsonl`),
        line(id, { agentName: "worker-many", type: "agent-name" }) +
          line(id, {
            message: { content: `Round ${i}` },
            origin: { kind: "human" },
            type: "user",
            uuid: `m${i}`,
          }),
      )
    }
    const parent = ids[0] ?? ""
    mkdirSync(join(dir, parent, "subagents"), { recursive: true })
    writeFileSync(
      join(dir, parent, "subagents", "agent-a9b8c7d6e5f4a3b2c.jsonl"),
      line(parent, { agentName: "worker-many", type: "agent-name" }) +
        line(parent, { message: { content: "Look around" }, type: "user", uuid: "ms" }),
    )
    await backfill(db, join(home, "projects"))
    // The subagent carries the name too: the list holds it, the chain does not.
    const named = await list(db, { names: ["worker-many"] })
    expect(named.total).toBe(14)
    expect(named.rows.filter((row) => row.kind === "subagent").length).toBe(1)

    const middle = await readSession(db, ids[6] ?? "", none)
    expect(middle?.chain?.total).toBe(12)
    expect(middle?.chain?.sessions.map((session) => session.id)).toEqual([
      ...ids.slice(1, 6),
      ...ids.slice(7, 12),
    ])
    expect(new Set(middle?.chain?.sessions.map((session) => session.relation))).toEqual(
      new Set(["before", "after"]),
    )
    const first = await readSession(db, parent, none)
    expect(first?.chain?.sessions.map((session) => session.id)).toEqual(ids.slice(1, 6))
    expect(first?.chain?.sessions.every((session) => session.kind === "interactive")).toBe(true)
  })

  // Last in this block: it adds the fixture's sessions to the database.
  test.skipIf(onLiveDashboard())(
    "a fixture stack shows only the sessions read from its own fixture, never rows a live config folder left in its database",
    async () => {
      const before = {
        dir: process.env.PLAYGROUND_FIXTURE_DIR,
        live: process.env.PLAYGROUND_LIVE_READS,
      }
      delete process.env.PLAYGROUND_LIVE_READS
      process.env.PLAYGROUND_FIXTURE_DIR = join(home, "fixture")
      try {
        await backfill(db, projectsDir())
        const { rows, total } = await list(db, {})
        const ids = rows.map((row) => row.id)
        expect(ids).toContain(FIXTURE_LEAD)
        expect(ids.filter((id) => [AGENT, LEAD, MIXED, ODD, PROBE, WORKER].includes(id))).toEqual(
          [],
        )
        expect(total).toBe(rows.length)
        expect(await readSession(db, FIXTURE_LEAD, none)).not.toBeNull()
        const builder = await readSession(db, FIXTURE_BUILDER, none)
        expect(builder?.start.kind).toBe("handover")
        expect(
          builder?.chain?.sessions.map((session) => [session.start.kind, session.relation]),
        ).toEqual([
          ["fresh", "before"],
          ["clear", "before"],
          ["fresh", "alongside"],
        ])
        expect(await readSession(db, LEAD, none)).toBeNull()
        expect(await readSession(db, WORKER, none)).toBeNull()
        expect(await sessionExists(db, LEAD)).toBe(false)
        expect((await readEntries(db, LEAD, { kinds: [], limit: 10 })).entries).toEqual([])
        expect((await readSteps(db, LEAD, { beforeId: "l2", limit: 10 })).entries).toEqual([])
      } finally {
        if (before.dir === undefined) delete process.env.PLAYGROUND_FIXTURE_DIR
        else process.env.PLAYGROUND_FIXTURE_DIR = before.dir
        if (before.live === undefined) delete process.env.PLAYGROUND_LIVE_READS
        else process.env.PLAYGROUND_LIVE_READS = before.live
      }
    },
    // its backfill reads the container; on a loaded machine it crossed bun's 5s default, the recorded failure
    30_000,
  )
})

describe("liveSessions", () => {
  test("lists a registry file whose process runs, and skips a dead one, a broken one and anything not a registry file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-registry-"))
    try {
      writeFileSync(
        join(dir, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: "alive", status: "busy" }),
      )
      // A pid from this test's own process tree that has already exited, so no other process is ever probed.
      const gone = Bun.spawnSync(["true"]).pid
      writeFileSync(join(dir, `${gone}.json`), JSON.stringify({ pid: gone, sessionId: "gone" }))
      // a pid neither file above holds, since the test sandbox's pid view on Linux gives small pids, and a fixed 12.json once overwrote the live file of a test running as pid 12; three, since the two pids rule out two at most
      const broken = [12, 13, 14].find((pid) => pid !== process.pid && pid !== gone)
      writeFileSync(join(dir, `${broken}.json`), "{ not json")
      writeFileSync(
        join(dir, "notes.json"),
        JSON.stringify({ pid: process.pid, sessionId: "notes" }),
      )
      writeFileSync(join(dir, `${process.pid}.abc.key`), "secret")
      expect([...(await liveSessions(dir)).entries()]).toEqual([["alive", { status: "busy" }]])
      expect((await liveSessions(join(dir, "missing"))).size).toBe(0)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a file whose pid now runs a process started at another time is a recycled pid, not a live session", async () => {
    const start = (await processStarts([process.pid]))?.get(process.pid)
    expect(start).toBeString()
    const own = mkdtempSync(join(tmpdir(), "sessions-registry-"))
    const recycled = mkdtempSync(join(tmpdir(), "sessions-registry-"))
    try {
      writeFileSync(
        join(own, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, procStart: start, sessionId: "own" }),
      )
      writeFileSync(
        join(recycled, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          procStart: "Mon Jan  1 00:00:00 2001",
          sessionId: "old",
        }),
      )
      expect([...(await liveSessions(own)).keys()]).toEqual(["own"])
      expect((await liveSessions(recycled)).size).toBe(0)
    } finally {
      rmSync(own, { force: true, recursive: true })
      rmSync(recycled, { force: true, recursive: true })
    }
  })

  test("a Linux file, its procStart clock ticks since boot, is live while /proc gives its pid that start, and a recycled pid once it gives another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-registry-"))
    try {
      writeFileSync(
        join(dir, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, procStart: "1801742", sessionId: "linux" }),
      )
      const live = (ticks: string) =>
        withProc(pidsDir({ [process.pid]: ticks }), async () => [
          ...(await liveSessions(dir)).keys(),
        ])
      expect(await live("1801742")).toEqual(["linux"])
      expect(await live("2900000")).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe("liveRegistered", () => {
  const START = "Fri Oct 16 21:00:00 2026"
  const session = (pid: number, procStart?: string, status?: string) => ({
    name: `s${pid}`,
    pid,
    sessionId: `id${pid}`,
    ...(procStart ? { procStart } : {}),
    ...(status ? { status } : {}),
  })
  const none = () => false

  test("a session is live when its process runs and started when its file says", () => {
    const starts = new Map([
      [10, START],
      [11, "Fri Oct 16 22:00:00 2026"],
      [12, START],
    ])
    const sessions = [
      session(10, START, "busy"),
      session(11, START),
      session(12),
      session(13, START),
    ]
    expect([...liveRegistered(sessions, starts, none).entries()]).toEqual([
      ["id10", { status: "busy" }],
      ["id12", { status: null }],
    ])
  })

  test("when ps cannot be run, whether the pid runs decides alone", () => {
    const sessions = [session(10, START), session(11)]
    expect([...liveRegistered(sessions, null, (pid) => pid === 10).keys()]).toEqual(["id10"])
  })
})

describe("how a session began", () => {
  test("a /clear, stored as its command or its tags, carries on, and /clear with words after it does not", () => {
    expect(startOf("/clear")).toEqual({ kind: "clear", note: null })
    expect(
      startOf("<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
    ).toEqual({ kind: "clear", note: null })
    expect(startOf("/clear the board")).toEqual({ kind: "fresh", note: null })
    expect(startOf(null)).toEqual({ kind: "fresh", note: null })
  })

  test("a note under the data folder's handoffs/, whatever the folder's name, is handed over by a cue in its clause, or by being the session's own", () => {
    const fresh = { kind: "fresh", note: null } as const
    for (const folder of ["an-old-name", "my-factory"])
      expect(startOf(`Pick up from ~/.claude/${folder}/handoffs/PG-101.md.`)).toEqual({
        kind: "handover",
        note: "PG-101.md",
      })
    expect(startOf("Pick up from ~/.playground/handoffs/PG-539.md.")).toEqual({
      kind: "handover",
      note: "PG-539.md",
    })
    expect(startOf("Pick up from ~/.claude/acme/handoffs/PG-539.md.")).toEqual({
      kind: "handover",
      note: "PG-539.md",
    })
    expect(startOf("Fresh session, handoff ~/.playground/handoffs/120-labels.md.")).toEqual({
      kind: "handover",
      note: "120-labels.md",
    })
    expect(startOf("1. ~/.playground/handoffs/builder-2026-10-12.md", "builder")).toEqual({
      kind: "handover",
      note: "builder-2026-10-12.md",
    })
    expect(startOf("1. ~/.playground/handoffs/builder-2026-10-12.md", "ops")).toEqual(fresh)
    // A brief that cites a spec or notes file kept in the folder is no handover.
    expect(startOf("Spec notes: ~/.playground/handoffs/pb-labs-behaviour.md")).toEqual(fresh)
    expect(
      startOf("Resume the review: the ticket, ADR notes in ~/.playground/handoffs/adr-diff.md"),
    ).toEqual(fresh)
    expect(startOf("Read the behaviour in ~/.playground/handoffs/pb-labs.md")).toEqual(fresh)
    // Only the factory's own folder, and only a name that ends at .md.
    expect(startOf("Resume from docs/handoffs/spec.md")).toEqual(fresh)
    expect(startOf("Resume from ~/.playground/handoffs/x.md.bak")).toEqual(fresh)
    expect(startOf("write a handoff to ~/.playground/handoffs/<you>.md at 300k")).toEqual(fresh)
  })

  test("two sessions whose activity overlaps ran alongside; otherwise one came before or after", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 9, 6, hour))
    const session = { lastActiveAt: at(12), startedAt: at(10) }
    expect(relationOf(session, { lastActiveAt: at(9), startedAt: at(8) })).toBe("before")
    expect(relationOf(session, { lastActiveAt: at(14), startedAt: at(13) })).toBe("after")
    expect(relationOf(session, { lastActiveAt: at(11), startedAt: at(9) })).toBe("alongside")
    expect(relationOf(session, { lastActiveAt: at(13), startedAt: at(11) })).toBe("alongside")
    expect(relationOf(session, { lastActiveAt: at(10), startedAt: at(9) })).toBe("before")
    expect(relationOf(session, { lastActiveAt: null, startedAt: at(8) })).toBe("before")
  })
})
