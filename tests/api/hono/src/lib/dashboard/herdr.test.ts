import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  answerKeys,
  bringsBack,
  FIXTURE_SOCKET,
  HerdrDown,
  herdrEvents,
  herdrProblem,
  herdrRecords,
  HerdrRefused,
  herdrServers,
  herdrState,
  HerdrTimedOut,
  herdrWorkspaces,
  paneSchema,
  pressEnter,
  processSchema,
  promptOnScreen,
  promptOutcome,
  readHerdr,
  readScreen,
  readServer,
  request,
  restoring,
  RESUBSCRIBE,
  showsAsk,
  typeKeys,
  WATCHED,
  withHerdrState,
  workspaceSchema,
  type ServerRead,
} from "../../../../../../api/hono/src/lib/dashboard/herdr"
import { movesTheBoard } from "../../../../../../api/hono/src/lib/dashboard/hub"
import { answeredSince, liveRecords } from "../../../../../../api/hono/src/lib/dashboard/workers"
import type { SessionState } from "../../../../../../packages/config/src/session-state"
import { herdrDir, sessionsOf } from "../../../../../../packages/scripts/src/ops-herdr/herdr"
import { herdrPath } from "../../../../../../packages/scripts/src/ops-herdr/pin"
import { liveReads } from "../../../../../live-reads"

liveReads()

type Json = Record<string, unknown>
type Handler = (params: Json) => Json | { error: { code: string; message: string } } | null

// A stub of herdr's socket that serves as v0.9.5's does: one request per connection, read to its newline however many chunks it takes, answered with one JSON line, then closed; an events.subscribe stays open and takes pushed events. A method it has no handler for is closed with no answer, and a handler that answers null leaves the request hanging.
function stubServer(handlers: Record<string, Handler>, path?: string) {
  const dir = path ? "" : mkdtempSync(join(tmpdir(), "hd-"))
  const socket = path ?? join(dir, "s.sock")
  const seen: { method: string; params: Json }[] = []
  type Conn = { end: () => void; write: (s: Uint8Array) => number }
  const subscribers: Conn[] = []
  const buffers = new Map<Conn, string>()
  const decoders = new Map<Conn, TextDecoder>()
  const unsent = new Map<Conn, { bytes: Uint8Array; end: boolean }>()
  // A socket takes only part of a long write, so the rest goes out as it drains, and the connection closes after the last byte when asked to.
  const flush = (conn: Conn) => {
    const left = unsent.get(conn)
    if (!left) return
    while (left.bytes.length) {
      const wrote = conn.write(left.bytes)
      if (wrote <= 0) return
      left.bytes = left.bytes.subarray(wrote)
    }
    unsent.delete(conn)
    if (left.end) conn.end()
  }
  const send = (conn: Conn, text: string, end = false) => {
    const queued = unsent.get(conn)
    const bytes = new TextEncoder().encode(text)
    unsent.set(conn, {
      bytes: queued ? new Uint8Array([...queued.bytes, ...bytes]) : bytes,
      end: end || (queued?.end ?? false),
    })
    flush(conn)
  }
  const server = Bun.listen({
    socket: {
      drain: flush,
      close(conn) {
        unsent.delete(conn)
        buffers.delete(conn)
        decoders.delete(conn)
        const at = subscribers.indexOf(conn)
        if (at >= 0) subscribers.splice(at, 1)
      },
      data(conn, chunk) {
        const decoder = decoders.get(conn) ?? new TextDecoder()
        decoders.set(conn, decoder)
        const buffered = (buffers.get(conn) ?? "") + decoder.decode(chunk, { stream: true })
        const end = buffered.indexOf("\n")
        buffers.set(conn, end < 0 ? buffered : "")
        if (end < 0) return
        const req = JSON.parse(buffered.slice(0, end)) as {
          id: string
          method: string
          params: Json
        }
        seen.push({ method: req.method, params: req.params })
        const handler = handlers[req.method]
        if (req.method === "events.subscribe" && handler === undefined) {
          subscribers.push(conn)
          send(
            conn,
            `${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`,
          )
          return
        }
        if (handler === undefined) return void conn.end()
        const answer = handler(req.params)
        if (answer === null) return
        send(
          conn,
          `${JSON.stringify("error" in answer ? { error: answer.error, id: req.id } : { id: req.id, result: answer })}\n`,
          true,
        )
      },
    },
    unix: socket,
  })
  return {
    close: () => {
      for (const s of subscribers) s.end()
      server.stop(true)
      if (dir) rmSync(dir, { force: true, recursive: true })
    },
    dir,
    path: socket,
    push: (...events: Json[]) => {
      const chunk = events.map((event) => `${JSON.stringify(event)}\n`).join("")
      for (const conn of subscribers) send(conn, chunk)
    },
    seen,
    subscribers,
  }
}

const SESSION = "11111111-2222-4333-8444-555555555555"
// A pane as session.snapshot gives it, fields the dashboard does not read included.
const PANE = {
  agent: "claude",
  agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: SESSION },
  agent_status: "working",
  cwd: "/tmp/home",
  focused: true,
  foreground_cwd: "/tmp/probe-a",
  pane_id: "w1:p1",
  revision: 2,
  scroll: { offset_from_bottom: 0 },
  tab_id: "w1:t1",
  terminal_id: "term_1",
  workspace_id: "w1",
}
const CLAUDE = {
  argv: ["claude", "-n", "probe-herdr-a"],
  cwd: "/tmp/probe-a",
  name: "2.1.302",
  pid: 4242,
}
const PROCESS = {
  foreground_processes: [{ argv: ["/bin/zsh"], cwd: "/tmp/home", name: "zsh", pid: 10 }, CLAUDE],
  pane_id: "w1:p1",
  shell_pid: 10,
}
const SNAPSHOT = {
  snapshot: {
    agents: [],
    panes: [
      PANE,
      { ...PANE, agent: null, agent_session: null, pane_id: "w1:p2", terminal_id: "term_2" },
    ],
    protocol: 1,
    tabs: [],
    version: "0.9.5",
    workspaces: [{ focused: true, label: "probes", workspace_id: "w1" }],
  },
  type: "session_snapshot",
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const stub = (handlers: Record<string, Handler> = {}) => {
  const s = stubServer({
    "pane.get": () => ({ pane: PANE, type: "pane_info" }),
    "pane.process_info": (params) => ({
      process_info:
        params.pane_id === "w1:p1"
          ? PROCESS
          : { foreground_processes: [{ argv: ["/bin/zsh"], pid: 11 }] },
      type: "pane_process_info",
    }),
    "pane.read": () => ({ read: { text: "screen text" }, type: "pane_read" }),
    "session.snapshot": () => SNAPSHOT,
    ...handlers,
  })
  cleanups.push(s.close)
  return s
}

const registered = (entries: [number, string | null][]) =>
  new Map(
    entries.map(([pid, id]) => [pid, id === null ? null : { procStart: null, sessionId: id }]),
  )

const failure = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: unknown) => error,
  )

describe("request", () => {
  test("answers with herdr's result, and names herdr's error code", async () => {
    const s = stub({ "pane.close": () => ({ error: { code: "not_found", message: "no pane" } }) })
    expect(await request(s.path, "session.snapshot", {})).toMatchObject({
      type: "session_snapshot",
    })
    const refused = await failure(request(s.path, "pane.close", {}))
    expect(refused).toBeInstanceOf(HerdrRefused)
    expect((refused as HerdrRefused).reason).toBe("not_found")
  })

  test("a missing socket is a server that is down, and one closed with no answer is timed out", async () => {
    expect(await failure(request("/nonexistent/herdr.sock", "ping", {}))).toBeInstanceOf(HerdrDown)
    const s = stub()
    expect(await failure(request(s.path, "pane.unknown", {}))).toBeInstanceOf(HerdrTimedOut)
  })

  // A unix socket send on this Mac takes 8192 bytes at a time (net.local.stream.sendspace), so a long message goes out in parts until every byte is written.
  test("a request past the socket's send buffer goes whole", async () => {
    const s = stub({
      "agent.prompt": (params) => ({ chars: String(params.text).length, type: "ok" }),
    })
    const text = "\u00e9".repeat(12_000)
    expect(await request(s.path, "agent.prompt", { target: "w1:p1", text })).toMatchObject({
      chars: 12_000,
    })
  })
})

describe("readServer and herdrRecords", () => {
  test("a server that hangs mid-read is given up at its deadline, so it never holds the board, and is named", async () => {
    const panes = Array.from({ length: 30 }, (_, i) => ({
      ...PANE,
      pane_id: `w1:p${i}`,
      terminal_id: `term_${i}`,
    }))
    const s = stub({
      "pane.process_info": () => null,
      "session.snapshot": () => ({ ...SNAPSHOT, snapshot: { ...SNAPSHOT.snapshot, panes } }),
    })
    const start = performance.now()
    expect(await readHerdr([{ name: "hung", socket: s.path }], 300)).toEqual([
      { panes: [], partial: true, server: "hung", workspaces: [] },
    ])
    expect(performance.now() - start).toBeLessThan(1500)
    expect(herdrProblem()).toContain("hung")
  })

  test("a pane whose processes did not answer marks its server's read partial, so a session missing from it is not taken for ended (PG-880)", async () => {
    const s = stub({ "pane.process_info": () => ({ error: { code: "busy", message: "busy" } }) })
    const [read] = await readHerdr([{ name: "slow", socket: s.path }], 1000)
    expect(read?.partial).toBe(true)
    expect(read?.panes.length).toBeGreaterThan(0)
    const whole = await readHerdr([{ name: "whole", socket: stub().path }], 1000)
    expect(whole[0]?.partial).toBeUndefined()
  })

  test("a pane holds a session when a foreground process has a registry file naming it, and is keyed by server and pane", async () => {
    const s = stub()
    const read = await readServer({ name: "probes", socket: s.path })
    expect(read.panes.map((p) => p.processes.map((proc) => proc.pid))).toEqual([[10, 4242], [11]])
    const [record, ...rest] = herdrRecords(
      [read],
      registered([[4242, SESSION]]),
      "2026-10-18T00:00:00.000Z",
    )
    expect(rest).toEqual([])
    expect(record).toMatchObject({
      agent: "claude",
      agent_lifecycle: "running",
      cwd: "/tmp/probe-a",
      herdr_status: "working",
      launch_arguments: ["claude", "-n", "probe-herdr-a"],
      pid: 4242,
      session_id: SESSION,
      surface_id: "herdr:probes:w1:p1",
      workspace_id: "herdr:probes:w1",
    })
    expect(String(record?.transcript_path)).toEndWith(`/-tmp-probe-a/${SESSION}.jsonl`)
    expect(herdrWorkspaces([read])).toEqual([
      { custom_title: null, id: "herdr:probes:w1", ref: "herdr:probes:w1", title: "probes" },
    ])
  })

  test("with no registry file the pane is no session, so the roster reads it Down; a file mid-rewrite or no registry leaves herdr's own session id", () => {
    const read: ServerRead = {
      panes: [
        {
          ...paneSchema.parse(PANE),
          processes: [{ argv: CLAUDE.argv, cwd: CLAUDE.cwd, pid: 4242 }],
        },
      ],
      server: "probes",
      workspaces: [],
    }
    expect(herdrRecords([read], registered([]), "t")).toEqual([])
    expect(herdrRecords([read], registered([[4242, "another-session"]]), "t")[0]).toMatchObject({
      session_id: "another-session",
    })
    expect(herdrRecords([read], registered([[4242, null]]), "t")[0]).toMatchObject({
      session_id: SESSION,
    })
    expect(herdrRecords([read], null, "t")[0]).toMatchObject({ session_id: SESSION })
  })

  test("a board that reads no herdr server, or not every one, keeps the others' change times", () => {
    const at = (server: string, agent_status: "blocked" | "idle"): ServerRead => ({
      panes: [
        { ...paneSchema.parse(PANE), agent_status, processes: [{ cwd: CLAUDE.cwd, pid: 4242 }] },
      ],
      server,
      workspaces: [],
    })
    const registry = new Map([
      [4242, { procStart: "Sat Oct 18 01:00:00 2026", sessionId: SESSION }],
    ])
    herdrRecords([at("kept-a", "idle")], registry, "2026-10-18T10:00:00.000Z")
    herdrRecords([at("kept-a", "blocked")], registry, "2026-10-18T10:00:05.000Z")
    // a board whose every server failed reads none, and a failed server's read is left out
    herdrRecords([], registry, "2026-10-18T10:00:06.000Z")
    herdrRecords([at("kept-b", "idle")], registry, "2026-10-18T10:00:06.500Z")
    // a server read cut short, whole or by a pane, keeps the times of the sessions it did not see (PG-880)
    herdrRecords(
      [{ panes: [], partial: true, server: "kept-a", workspaces: [] }],
      registry,
      "2026-10-18T10:00:06.700Z",
    )
    const cut = at("kept-a", "blocked")
    herdrRecords(
      [{ ...cut, panes: cut.panes.map((p) => ({ ...p, processes: [] })), partial: true }],
      registry,
      "2026-10-18T10:00:06.800Z",
    )
    expect(
      herdrRecords([at("kept-a", "blocked")], registry, "2026-10-18T10:00:07.000Z")[0],
    ).toMatchObject({
      herdr_seen_at: "2026-10-18T10:00:05.000Z",
      updated_at: "2026-10-18T10:00:05.000Z",
    })
  })

  test("a record keeps the time its state last changed, and is live by the registry's proof", () => {
    const read: ServerRead = {
      panes: [{ ...paneSchema.parse(PANE), processes: [{ cwd: CLAUDE.cwd, pid: 4242 }] }],
      server: "probes",
      workspaces: [],
    }
    const registry = new Map([
      [4242, { procStart: "Sat Oct 18 01:00:00 2026", sessionId: SESSION }],
    ])
    const first = herdrRecords([read], registry, "2026-10-18T00:00:00.000Z")
    expect(herdrRecords([read], registry, "2026-10-18T00:00:20.000Z")[0]?.updated_at).toBe(
      first[0]?.updated_at,
    )
    // a read minutes after the last cannot tell the state held, so it began at that read
    expect(herdrRecords([read], registry, "2026-10-18T00:05:00.000Z")[0]?.updated_at).toBe(
      "2026-10-18T00:05:00.000Z",
    )
    const blocked = {
      ...read,
      panes: read.panes.map((p) => ({ ...p, agent_status: "blocked" as const })),
    }
    expect(herdrRecords([blocked], registry, "2026-10-18T00:05:20.000Z")[0]?.updated_at).toBe(
      "2026-10-18T00:05:20.000Z",
    )
    expect(first[0]?.herdr_seen_at).toBeNull()
    expect(herdrRecords([blocked], registry, "2026-10-18T00:05:40.000Z")[0]?.herdr_seen_at).toBe(
      "2026-10-18T00:05:20.000Z",
    )
    // the hub reads only while a Dashboard is open, so a state first read an hour after the last read began at some time unknown, and carries no start
    expect(herdrRecords([read], registry, "2026-10-18T01:00:00.000Z")[0]?.herdr_seen_at).toBeNull()
    expect(
      herdrRecords([blocked], registry, "2026-10-18T02:00:00.000Z")[0]?.herdr_seen_at,
    ).toBeNull()
    const projects = String(first[0]?.transcript_path).split("/-tmp-probe-a/")[0] ?? ""
    const proof = (start: string) => ({ projects, registry, starts: new Map([[4242, start]]) })
    expect(
      liveRecords({ sessions: first }, proof("Sat Oct 18 01:00:00 2026")).sessions,
    ).toHaveLength(1)
    expect(
      liveRecords({ sessions: first }, proof("Sat Oct 18 02:00:00 2026")).sessions,
    ).toHaveLength(0)
  })

  // with no Dashboard open the hub does not read, so a picker answered and a permission raised between two reads minutes apart both read blocked; a long-running process kept the picker's start, answeredSince() read the new prompt as answered, and it showed no card while a fresh process showed it
  test("a prompt raised between two reads minutes apart lists as it does on a fresh process", () => {
    const at = (server: string): ServerRead => ({
      panes: [
        {
          ...paneSchema.parse(PANE),
          agent_status: "blocked",
          processes: [{ cwd: CLAUDE.cwd, pid: 4242 }],
        },
      ],
      server,
      workspaces: [],
    })
    const registry = new Map([
      [4242, { procStart: "Sat Oct 18 01:00:00 2026", sessionId: SESSION }],
    ])
    // a picker goes up and this process reads it twice
    herdrRecords([at("gap-long")], registry, "2026-10-18T10:00:00.000Z")
    herdrRecords([at("gap-long")], registry, "2026-10-18T10:00:10.000Z")
    // the picker is answered at 10:01, and a permission goes up at 10:03, both unread
    const pickers = { answeredAt: "2026-10-18T10:01:00.000Z", interrupted: false, open: [] }
    const stuck: SessionState = {
      at: "2026-10-18T10:03:00.000Z",
      event: "PermissionRequest",
      reason: "permission",
      sessionId: SESSION,
      state: "stuck",
      tool: "Bash",
    }
    const board = (server: string) => {
      const records = herdrRecords([at(server)], registry, "2026-10-18T10:04:00.000Z")
      const [record] = withHerdrState(
        { sessions: records },
        new Map([[SESSION, stuck]]),
        () => "2026-10-18T10:02:59.000Z",
      ).sessions
      return { answered: answeredSince(pickers, String(record?.updated_at)), record }
    }
    const fresh = board("gap-fresh")
    const long = board("gap-long")
    expect(fresh).toMatchObject({
      answered: false,
      record: { agent_lifecycle: "needsInput", herdr_wait: { reason: "permission", tool: "Bash" } },
    })
    expect(long.answered).toBe(false)
    expect(long.record).toMatchObject({
      agent_lifecycle: fresh.record?.agent_lifecycle,
      herdr_seen_at: fresh.record?.herdr_seen_at,
      herdr_wait: fresh.record?.herdr_wait,
      updated_at: fresh.record?.updated_at,
    })
  })
})

describe("herdrState", () => {
  const file = (
    state: SessionState["state"],
    at = "2026-10-18T01:00:00.000Z",
    resetsAt?: string,
  ): SessionState => ({ at, event: "Notification", resetsAt, sessionId: SESSION, state })

  test("herdr's own state comes first", () => {
    expect(herdrState("blocked", null, null).lifecycle).toBe("needsInput")
    expect(herdrState("working", file("idle"), null).lifecycle).toBe("running")
    expect(herdrState("done", null, null).lifecycle).toBe("idle")
    expect(herdrState("idle", file("stuck"), null).lifecycle).toBe("idle")
  })

  test("the C5 file speaks where herdr reports unknown", () => {
    expect(herdrState("unknown", file("working"), null).lifecycle).toBe("running")
    expect(herdrState("unknown", file("stuck"), null).lifecycle).toBe("needsInput")
    expect(herdrState("unknown", file("failed"), null).lifecycle).toBe("idle")
    expect(herdrState("unknown", null, null).lifecycle).toBe("unknown")
  })

  test("a usage limit and its reset come from the file", () => {
    expect(
      herdrState("blocked", file("usage-limit", undefined, "2026-10-18T05:00:00.000Z"), null),
    ).toEqual({
      lifecycle: "needsInput",
      usageLimit: { resets: null, resetsAt: "2026-10-18T05:00:00.000Z" },
      wait: null,
    })
  })

  // herdr has no Feed, so the hooks' stuck record names the prompt a card is built from.
  test("a blocked session's stuck record names its prompt, and nothing else does", () => {
    const stuck = (extra: Partial<SessionState>): SessionState => ({
      ...file("stuck"),
      event: "PermissionRequest",
      ...extra,
    })
    expect(herdrState("blocked", stuck({ reason: "permission", tool: "Bash" }), null).wait).toEqual(
      { agentId: null, reason: "permission", tool: "Bash" },
    )
    expect(herdrState("blocked", stuck({ agentId: "a1", reason: "question" }), null).wait).toEqual({
      agentId: "a1",
      reason: "question",
      tool: null,
    })
    // herdr blocked with no file, or a file older than the prompt herdr shows: the kind is not known
    expect(herdrState("blocked", null, null).wait).toBeNull()
    const seen = "2026-10-18T01:09:00.000Z"
    expect(herdrState("blocked", stuck({ reason: "plan" }), null, seen).wait).toBeNull()
    expect(herdrState("working", stuck({ reason: "plan" }), null).wait).toBeNull()
    expect(herdrState("blocked", file("usage-limit"), null).wait).toBeNull()
  })

  test("a stuck record the transcript has moved past (an Escape) ends herdr's blocked too, by #911's rule", () => {
    expect(herdrState("blocked", file("stuck"), "2026-10-18T01:00:05.000Z").lifecycle).toBe("idle")
    expect(herdrState("blocked", file("stuck"), "2026-10-18T00:59:00.000Z").lifecycle).toBe(
      "needsInput",
    )
    expect(herdrState("unknown", file("stuck"), "2026-10-18T01:00:05.000Z").lifecycle).toBe(
      "unknown",
    )
  })

  // A herdr-restored session runs without its --settings, so its file keeps its last record while herdr shows a new prompt: a record older than the blocked state this process saw begin is not the prompt herdr shows.
  test("a file older than the blocked state herdr shows never ends it, and only a stuck record can", () => {
    const later = "2026-10-18T01:10:00.000Z"
    const seen = "2026-10-18T01:09:00.000Z"
    expect(herdrState("blocked", file("stuck"), later, seen).lifecycle).toBe("needsInput")
    expect(herdrState("blocked", file("failed"), later, seen).lifecycle).toBe("needsInput")
    expect(herdrState("blocked", file("failed"), later, null).lifecycle).toBe("needsInput")
    expect(
      herdrState("blocked", file("stuck", "2026-10-18T01:08:50.000Z"), later, seen).lifecycle,
    ).toBe("idle")
  })

  test("withHerdrState applies it to herdr's records alone", () => {
    const cmux = { agent_lifecycle: "running", session_id: "cmux-session" }
    const herdr = { agent_lifecycle: "unknown", herdr_status: "unknown", session_id: SESSION }
    const out = withHerdrState(
      { sessions: [cmux, herdr] },
      new Map([[SESSION, file("usage-limit")]]),
      () => null,
    )
    expect(out.sessions[0]).toBe(cmux)
    expect(out.sessions[1]).toMatchObject({
      agent_lifecycle: "needsInput",
      herdr_wait: null,
      usage_limit: { resets: null, resetsAt: null },
    })
  })
})

describe("promptOutcome", () => {
  test("maps herdr's failures as #910 lists them", () => {
    const refused = (code: string) => new HerdrRefused("agent.prompt", code, "")
    expect(promptOutcome(refused("agent_blocked"))).toBe("picker")
    expect(promptOutcome(refused("agent_not_running"))).toBe("gone")
    expect(promptOutcome(refused("not_found"))).toBe("gone")
    // herdr 0.9.5's own answer for a pane id that holds no agent, measured on the scratch server
    expect(promptOutcome(refused("agent_not_found"))).toBe("gone")
    expect(promptOutcome(refused("timeout"))).toBe("typed")
    expect(promptOutcome(refused("agent_prompt_stalled"))).toBe("typed")
    // herdr had the request, so it may have pasted and submitted it before its answer failed to read
    expect(promptOutcome(refused("malformed"))).toBe("typed")
    expect(promptOutcome(new HerdrTimedOut("agent.prompt"))).toBe("typed")
    expect(promptOutcome(new HerdrDown("ENOENT"))).toBe("unsent")
    expect(promptOutcome(refused("invalid_request"))).toBe("unsent")
  })
})

// Claude Code's prompts as a pane shows them: a picker, a multi-select, a permission and a plan.
const PICKER = [
  "● Asking which colour",
  "",
  " ☐ Color",
  "",
  "Pick a color?",
  "",
  "❯ 1. Red",
  "     Red color",
  "  2. Blue",
  "     Blue color",
  "  3. Type something.",
  "──────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n")
const MULTI = [
  "Add anything",
  "else?",
  "",
  "❯ 1. [ ] Foam",
  "     Extra foam",
  "  2. [✔] Shot",
  "  3. [ ] No sugar",
  "  4. [ ] Type something",
  "  5. Submit",
].join("\n")
// As Claude Code 2.1 draws one: its Submit row carries no number, and Chat about this comes after it.
const MULTI_LIVE = [
  " ←  ☐ Extras  ✔ Submit  →",
  "",
  "Add anything else?",
  "",
  "❯ 1. [ ] Foam",
  "     Extra foam",
  "  2. [✔] Shot",
  "  3. [ ] No sugar",
  "  4. [ ] Type something",
  "     Submit",
  "──────────────────",
  "  5. Chat about this",
].join("\n")
const colour = {
  choices: ["Blue"],
  labels: ["Red", "Blue"],
  multiSelect: false,
  prompt: "Pick a color?",
  text: null,
}
const extras = {
  choices: ["Foam", "No sugar"],
  labels: ["Foam", "Shot", "No sugar"],
  multiSelect: true,
  prompt: "Add anything else?",
  text: null,
}

describe("promptOnScreen", () => {
  test("reads the last numbered list on the screen, its cursor and boxes, and the words above it", () => {
    const picker = promptOnScreen(PICKER)
    expect(picker.options.map((o) => [o.number, o.label, o.on])).toEqual([
      [1, "Red", true],
      [2, "Blue", false],
      [3, "Type something.", false],
      [4, "Chat about this", false],
    ])
    expect(picker.text).toBe("● Asking which colour ☐ Color Pick a color?")
    expect(promptOnScreen(MULTI).options.map((o) => o.checked)).toEqual([
      false,
      true,
      false,
      false,
      null,
    ])
    // a numbered list in the session's own output above the prompt is not the prompt
    expect(promptOnScreen(`1. step one\n2. step two\n${PICKER}`).options[0]?.label).toBe("Red")
    expect(promptOnScreen("❯ ready\n> ").options).toEqual([])
  })
})

describe("showsAsk", () => {
  test("a question still shows while its words and labels do, own words typed in its last row included", () => {
    const typedIn = promptOnScreen(PICKER.replace("3. Type something.", "3. green please"))
    expect(showsAsk(typedIn, colour)).toBe(true)
    expect(showsAsk(promptOnScreen("● Blue it is.\n\n> "), colour)).toBe(false)
  })
})

describe("answerKeys", () => {
  const keys = (screen: string, ask: Parameters<typeof answerKeys>[1]) =>
    answerKeys(promptOnScreen(screen), ask)

  test("a picker's option by the arrows from the cursor, then Enter", () => {
    expect(keys(PICKER, colour)).toEqual({ keys: [{ key: "down" }, { key: "enter" }], ok: true })
    expect(keys(PICKER, { ...colour, choices: ["Red"] })).toEqual({
      keys: [{ key: "enter" }],
      ok: true,
    })
  })

  test("a multi-select ticks what differs with Space, then submits", () => {
    expect(keys(MULTI, extras)).toEqual({
      keys: [
        { key: "space" },
        { key: "down" },
        { key: "space" },
        { key: "down" },
        { key: "space" },
        { key: "down" },
        { key: "down" },
        { key: "enter" },
      ],
      ok: true,
    })
  })

  test("a multi-select whose Submit row has no number moves to that row", () => {
    expect(promptOnScreen(MULTI_LIVE).options.map((o) => [o.number, o.label])).toEqual([
      [1, "Foam"],
      [2, "Shot"],
      [3, "No sugar"],
      [4, "Type something"],
      [0, "Submit"],
      [5, "Chat about this"],
    ])
    expect(keys(MULTI_LIVE, extras)).toEqual(keys(MULTI, extras))
  })

  test("the person's own words go in the option after the picker's own", () => {
    expect(keys(PICKER, { ...colour, choices: [], text: "teal" })).toEqual({
      keys: [{ key: "down" }, { key: "down" }, { text: "teal" }, { key: "enter" }],
      ok: true,
    })
  })

  test("own words need the free-text row, and a multi-select its Submit row", () => {
    const noFree = PICKER.replace("3. Type something.", "3. Green")
    expect(keys(noFree, { ...colour, choices: [], text: "teal" })).toMatchObject({ ok: false })
    expect(keys(MULTI.replace("  5. Submit", ""), extras)).toMatchObject({ ok: false })
  })

  test("a pane that does not show the prompt asked, or its options, or a cursor, gets no keys", () => {
    expect(keys(PICKER, { ...colour, prompt: "Pick a size?" })).toMatchObject({ ok: false })
    expect(keys(PICKER, { ...colour, labels: ["Red", "Green"] })).toMatchObject({ ok: false })
    expect(keys(PICKER.replace("❯", " "), colour)).toMatchObject({ ok: false })
    expect(keys("❯ ", colour)).toMatchObject({ ok: false })
    expect(keys(PICKER, extras)).toMatchObject({ ok: false })
  })
})

describe("herdrServers and readScreen", () => {
  const configure = (dir: string) => {
    const before = [process.env.PLAYGROUND_HERDR_DIR, process.env.PLAYGROUND_HERDR_SESSIONS]
    process.env.PLAYGROUND_HERDR_DIR = dir
    process.env.PLAYGROUND_HERDR_SESSIONS = "s"
    cleanups.push(() => {
      for (const [key, value] of [
        ["PLAYGROUND_HERDR_DIR", before[0]],
        ["PLAYGROUND_HERDR_SESSIONS", before[1]],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
  }

  test("reads the visible screen of the pane a surface names, and never a pane scrolled up", async () => {
    const s = stub()
    configure(s.dir)
    expect(herdrServers()).toEqual([{ name: "s", socket: s.path }])
    expect(await readScreen("herdr:s:wA:p1", 40)).toBe("screen text")
    expect(s.seen.at(-1)?.params.pane_id).toBe("wA:p1")
    expect(await readScreen("herdr:s:w1:p1", 40)).toBe("screen text")
    expect(s.seen.at(-1)).toEqual({
      method: "pane.read",
      params: { lines: 40, pane_id: "w1:p1", source: "visible" },
    })
    const scrolled = stub({
      "pane.get": () => ({ pane: { ...PANE, scroll: { offset_from_bottom: 3 } } }),
    })
    configure(scrolled.dir)
    expect(await failure(readScreen("herdr:s:w1:p1", 40))).toBeInstanceOf(HerdrRefused)
    expect(scrolled.seen.some((r) => r.method === "pane.read")).toBe(false)
    // a pane.get answer that does not read says nothing of the scroll, so the screen may be history: refused, never read
    const unread = stub({ "pane.get": () => ({ pane: "not a pane" }) })
    configure(unread.dir)
    expect(await failure(readScreen("herdr:s:w1:p1", 40))).toMatchObject({ reason: "malformed" })
    expect(unread.seen.some((r) => r.method === "pane.read")).toBe(false)
  })

  // an answer goes key by key, one request each, so herdr takes them in order and Claude Code reads each as its own press
  test("types an answer's keys and words into the pane a surface names, one request each, in order", async () => {
    const s = stub({ "pane.send_keys": () => ({}), "pane.send_text": () => ({}) })
    configure(s.dir)
    await typeKeys("herdr:s:w1:p1", [{ key: "down" }, { text: "teal" }, { key: "enter" }])
    expect(s.seen).toEqual([
      { method: "pane.send_keys", params: { keys: ["down"], pane_id: "w1:p1" } },
      { method: "pane.send_text", params: { pane_id: "w1:p1", text: "teal" } },
      { method: "pane.send_keys", params: { keys: ["enter"], pane_id: "w1:p1" } },
    ])
    const refusing = stub({
      "pane.send_keys": () => ({ error: { code: "pane_not_found", message: "" } }),
    })
    configure(refusing.dir)
    expect(
      await failure(typeKeys("herdr:s:w1:p1", [{ key: "1" }, { key: "enter" }])),
    ).toBeInstanceOf(HerdrRefused)
    expect(refusing.seen).toHaveLength(1)
  })

  // the one Enter deliver() presses when a message's own did not land
  test("presses one Enter into the pane a surface names", async () => {
    const s = stub({ "pane.send_keys": () => ({}) })
    configure(s.dir)
    await pressEnter("herdr:s:w1:p1")
    expect(s.seen).toEqual([
      { method: "pane.send_keys", params: { keys: ["enter"], pane_id: "w1:p1" } },
    ])
  })

  test("a stack reading a fixture names the fixture's own server alone and connects to no socket, though one listens where the settings point", async () => {
    const s = stub()
    const env = { PLAYGROUND_HERDR_DIR: s.dir, PLAYGROUND_HERDR_SESSIONS: "s" }
    expect(herdrServers(env)).toEqual([{ name: "s", socket: s.path }])
    const live = process.env.PLAYGROUND_LIVE_READS
    delete process.env.PLAYGROUND_LIVE_READS
    try {
      expect(herdrServers(env)).toEqual([{ name: "playground", socket: FIXTURE_SOCKET }])
      const events = herdrEvents(herdrServers(env), 20)
      await Bun.sleep(100)
      events.kill()
      expect(s.seen).toEqual([])
    } finally {
      process.env.PLAYGROUND_LIVE_READS = live
    }
  })

  test("names Playground's servers by default, where ops-herdr serves them, and only names herdr takes", () => {
    // ops-herdr's sockets follow HOME, never CLAUDE_CONFIG_DIR, so a session on another login reads the same servers
    expect(
      herdrServers({ CLAUDE_CONFIG_DIR: "/c", HOME: "/home/someone" }).map((s) => s.socket),
    ).toEqual([
      "/home/someone/.playground/herdr/playground.sock",
      "/home/someone/.playground/herdr/playground-probes.sock",
    ])
    for (const env of [
      { HOME: "/home/someone" },
      { PLAYGROUND_HERDR_DIR: "/h", PLAYGROUND_HERDR_SESSIONS: "a,b" },
    ]) {
      expect(herdrServers(env).map((s) => s.socket)).toEqual(
        sessionsOf(env).map((name) => join(herdrDir(env), `${name}.sock`)),
      )
    }
    expect(
      herdrServers({ PLAYGROUND_HERDR_DIR: "/h", PLAYGROUND_HERDR_SESSIONS: "a, ../b ,c" }),
    ).toEqual([
      { name: "a", socket: "/h/a.sock" },
      { name: "c", socket: "/h/c.sock" },
    ])
  })
})

// A dispatcher on a server v0.0.2 started as factory stayed off the board after the rename to playground, while Start counted it from the registry and said it was already running
test("herdrServers also names each server socket an older Playground left in its folder, unless PLAYGROUND_HERDR_SESSIONS names them", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-old-"))
  cleanups.push(() => rmSync(home, { force: true, recursive: true }))
  const dir = join(home, ".playground", "herdr")
  mkdirSync(dir, { recursive: true })
  for (const file of [
    "factory.sock",
    "factory-client.sock",
    "default.sock",
    "playground.sock",
    "probes.sock",
    "factory.out",
  ])
    writeFileSync(join(dir, file), "")
  expect(herdrServers({ HOME: home }).map((s) => s.name)).toEqual([
    "playground",
    "playground-probes",
    "factory",
    "probes",
  ])
  expect(herdrServers({ HOME: home }).at(2)).toEqual({
    name: "factory",
    socket: join(dir, "factory.sock"),
  })
  expect(
    herdrServers({ HOME: home, PLAYGROUND_HERDR_SESSIONS: "playground" }).map((s) => s.name),
  ).toEqual(["playground"])
})

describe("herdrEvents", () => {
  const lines = async (events: ReturnType<typeof herdrEvents>, count: number) => {
    const out: string[] = []
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of events.stdout) {
      buffered += decoder.decode(chunk, { stream: true })
      const parts = buffered.split("\n")
      buffered = parts.pop() ?? ""
      out.push(...parts)
      if (out.length >= count) break
    }
    return out
  }

  test("each subscription that starts is an ack and each event a move, and it subscribes to every pane's status", async () => {
    const s = stub()
    const events = herdrEvents([{ name: "s", socket: s.path }], 20)
    cleanups.push(events.kill)
    const read = lines(events, 2)
    while (s.subscribers.length === 0) await Bun.sleep(5)
    s.push({ data: { pane_id: "w1:p1", status: "blocked" }, event: "pane.agent_status_changed" })
    const [ack, event] = await read
    expect(JSON.parse(ack ?? "")).toEqual({ type: "ack" })
    expect(JSON.parse(event ?? "")).toEqual({
      name: "herdr.pane.agent_status_changed",
      type: "event",
    })
    expect([ack, event].every((line) => movesTheBoard(line ?? ""))).toBe(true)
    const subscribe = s.seen.find((r) => r.method === "events.subscribe")
    expect(subscribe?.params.subscriptions).toContainEqual({
      pane_id: "w1:p1",
      type: "pane.agent_status_changed",
    })
    expect(subscribe?.params.subscriptions).toContainEqual({ type: "pane.created" })
  })

  test("a server that goes and comes back is subscribed to again, by itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hd-"))
    cleanups.push(() => rmSync(dir, { force: true, recursive: true }))
    const path = join(dir, "s.sock")
    const events = herdrEvents([{ name: "s", socket: path }], 20)
    cleanups.push(events.kill)
    const read = lines(events, 2)
    await Bun.sleep(60)
    const first = stubServer({ "session.snapshot": () => SNAPSHOT }, path)
    while (first.subscribers.length === 0) await Bun.sleep(5)
    first.close()
    const second = stubServer({ "session.snapshot": () => SNAPSHOT }, path)
    cleanups.push(second.close)
    expect(await read).toEqual(['{"type":"ack"}', '{"type":"ack"}'])
  })

  // herdr names a general event frame by its EventKind (pane_created), and only a subscription and its own events by dotted names (`herdr api schema --json`).
  test("a pane opened after the hub subscribed is subscribed to, from herdr's own event names", async () => {
    let panes = [PANE]
    const s = stub({
      "session.snapshot": () => ({ ...SNAPSHOT, snapshot: { ...SNAPSHOT.snapshot, panes } }),
    })
    const events = herdrEvents([{ name: "s", socket: s.path }], 20)
    cleanups.push(events.kill)
    while (s.subscribers.length === 0) await Bun.sleep(5)
    panes = [PANE, { ...PANE, pane_id: "w1:p3", terminal_id: "term_3" }]
    s.push({ data: { pane_id: "w1:p3" }, event: "pane_created" })
    const newest = () =>
      JSON.stringify(s.seen.filter((r) => r.method === "events.subscribe").at(-1)?.params)
    for (let i = 0; i < 100 && !newest().includes("w1:p3"); i++) await Bun.sleep(10)
    expect(newest()).toContain("w1:p3")
  })

  test("a pane ending, exited then closed in one chunk, leaves one subscription open", async () => {
    const s = stub()
    const events = herdrEvents([{ name: "s", socket: s.path }], 20)
    cleanups.push(events.kill)
    while (s.subscribers.length === 0) await Bun.sleep(5)
    s.push(
      { data: { pane_id: "w1:p2" }, event: "pane_exited" },
      { data: { pane_id: "w1:p2" }, event: "pane_closed" },
    )
    await Bun.sleep(300)
    expect(s.seen.filter((r) => r.method === "events.subscribe").length).toBeGreaterThan(1)
    expect(s.subscribers).toHaveLength(1)
  })

  test("a subscription herdr keeps refusing is tried again ever more slowly", async () => {
    const s = stub({
      "events.subscribe": () => ({ error: { code: "pane_not_found", message: "gone" } }),
    })
    const events = herdrEvents([{ name: "s", socket: s.path }], 20)
    cleanups.push(events.kill)
    await Bun.sleep(500)
    expect(s.seen.filter((r) => r.method === "events.subscribe").length).toBeLessThanOrEqual(7)
  })

  test("events_lost subscribes afresh", async () => {
    const s = stub()
    const events = herdrEvents([{ name: "s", socket: s.path }], 20)
    cleanups.push(events.kill)
    const read = lines(events, 2)
    while (s.subscribers.length === 0) await Bun.sleep(5)
    s.push({ error: { code: "events_lost", message: "lagged" }, id: "x" })
    expect(await read).toEqual(['{"type":"ack"}', '{"type":"ack"}'])
    expect(s.seen.filter((r) => r.method === "events.subscribe")).toHaveLength(2)
  })
})

// The parts of herdr's answers the dashboard reads, against the pinned binary's own schema, so a field herdr renames or retypes fails here before it fails the board. Skipped where the pinned herdr is not installed (CI).
const HERDR = herdrPath()
describe.skipIf(!existsSync(HERDR))("herdr's schema", () => {
  test("every field the dashboard reads is in herdr's own schema, required where the dashboard requires it", () => {
    const out = Bun.spawnSync([HERDR, "api", "schema", "--json"], { stderr: "ignore" })
    const defs = (
      JSON.parse(out.stdout.toString()) as {
        schemas: { success_response: { $defs: Record<string, Json> } }
      }
    ).schemas.success_response.$defs
    const pairs: [typeof paneSchema | typeof processSchema | typeof workspaceSchema, string][] = [
      [paneSchema, "PaneInfo"],
      [processSchema, "PaneProcessInfoProcess"],
      [workspaceSchema, "WorkspaceInfo"],
    ]
    for (const [schema, name] of pairs) {
      const def = defs[name] as { properties: Json; required?: string[] }
      for (const [key, field] of Object.entries(schema.shape)) {
        expect([name, key, key in def.properties]).toEqual([name, key, true])
        if (!field.safeParse(undefined).success) {
          expect([name, key, def.required?.includes(key)]).toEqual([name, key, true])
        }
      }
    }
    expect(Object.keys((defs.PaneScrollInfo as { properties: Json }).properties)).toContain(
      "offset_from_bottom",
    )
    expect(Object.keys((defs.PaneReadResult as { properties: Json }).properties)).toContain("text")
    const schemas = (
      JSON.parse(out.stdout.toString()) as { schemas: Record<string, { $defs: Json }> }
    ).schemas
    const subscription = schemas.request?.$defs.Subscription as
      | { oneOf: { properties: { type: { const: string } } }[] }
      | undefined
    const asked = (subscription?.oneOf ?? []).map((s) => s.properties.type.const)
    for (const type of [...WATCHED, "pane.agent_status_changed"]) {
      expect([type, asked.includes(type)]).toEqual([type, true])
    }
    const kinds = (schemas.event?.$defs.EventKind as { enum: string[] } | undefined)?.enum ?? []
    for (const kind of RESUBSCRIBE) expect([kind, kinds.includes(kind)]).toEqual([kind, true])
    expect(((defs.AgentStatus as { enum?: string[] }).enum ?? []).sort()).toEqual([
      "blocked",
      "done",
      "idle",
      "unknown",
      "working",
    ])
  })
})

// Every herdr call in the dashboard goes through herdr.ts, and only deliver.ts sends a message, beside the idle compact's `/compact` (ADR 0020).
const API = join(import.meta.dir, "../../../../../../api/hono/src")
const sources = () =>
  [...new Bun.Glob("**/*.ts").scanSync({ cwd: API })].map((file) => ({
    file,
    text: readFileSync(join(API, file), "utf8"),
  }))

describe("herdr's boundary", () => {
  test("no dashboard source but herdr.ts speaks herdr's protocol", () => {
    // herdr's method names, a socket path handed to Bun (`unix: path`, `unix:path`, the `{ unix }` shorthand) and node:net; a `unix:///` URL (parse.ts's Docker host) is not a socket call
    const protocol =
      /["'`](?:agent\.prompt|events\.subscribe|pane\.(?:get|list|process_info|read|send_keys|send_text)|session\.snapshot)["'`]|\bunix\s*:(?!\/\/)|[{,]\s*unix\s*[,}]|["'`](?:node:)?net["'`]/
    expect(
      sources()
        // pglite.ts serves the Postgres wire protocol on 127.0.0.1 with node:net, not herdr's
        .filter(
          ({ file, text }) =>
            protocol.test(text) && file !== "lib/dashboard/herdr.ts" && file !== "lib/pglite.ts",
        )
        .map((s) => s.file),
    ).toEqual([])
  })

  // prompt() or pressEnter() named from any path to herdr (`@/lib/dashboard/herdr`, `./herdr`, `../dashboard/herdr`), imported or re-exported, and the whole module taken (a namespace import, `export *`, `import()`), which reaches both too
  test("only deliver.ts and idle-compact.ts import herdr's prompt and pressEnter", () => {
    const from = String.raw`\s*from\s*["'][^"']*\/herdr["']`
    const reaches = new RegExp(
      [
        String.raw`(?:import|export)\s*(?:type\s*)?\{[^}]*\b(?:pressEnter|prompt)\b[^}]*\}` + from,
        String.raw`import\s*\*\s*as\s+\w+` + from,
        String.raw`export\s*\*(?:\s*as\s+\w+)?` + from,
        String.raw`import\(\s*["'\x60][^"'\x60]*\/herdr["'\x60]\s*\)`,
      ].join("|"),
    )
    expect(
      sources()
        .filter(({ text }) => reaches.test(text))
        .map((s) => s.file)
        .sort(),
    ).toEqual(["lib/dashboard/deliver.ts", "lib/dashboard/idle-compact.ts"])
    for (const form of [
      'import { prompt } from "../dashboard/herdr"',
      'export { prompt } from "@/lib/dashboard/herdr"',
      'import * as h from "./herdr"',
      'const h = await import("@/lib/dashboard/herdr")',
      'import { prompt as p } from "@/lib/dashboard/herdr"',
      'import { pressEnter } from "./herdr"',
    ]) {
      expect([form, reaches.test(form)]).toEqual([form, true])
    }
  })
})

const ROOT = join(import.meta.dir, "../../../../../..")
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
// deadCodeElimination stays off: with it on, the transpiler inlines NODE_ENV and drops the branch that cannot run, so a dev-only import would vanish under CI's NODE_ENV=production
const transpilers = {
  js: new Bun.Transpiler({ deadCodeElimination: false, loader: "js" }),
  jsx: new Bun.Transpiler({ deadCodeElimination: false, loader: "jsx" }),
  ts: new Bun.Transpiler({ deadCodeElimination: false, loader: "ts" }),
  tsx: new Bun.Transpiler({ deadCodeElimination: false, loader: "tsx" }),
}

// Code with its comments and types gone and its strings and imports kept, so a comment that names a writer crosses nothing.
const codeOf = (path: string, source: string): string => {
  const ext = path.split(".").at(-1) ?? "ts"
  const loader = ext.includes("x")
    ? ext.includes("t")
      ? "tsx"
      : "jsx"
    : ext.includes("t")
      ? "ts"
      : "js"
  try {
    return transpilers[loader].transformSync(source)
  } catch {
    return source
  }
}

// Every file git tracks or would track, read through `keep`, which takes a path and says whether to read it.
const repoFiles = async (keep: (path: string) => boolean): Promise<Record<string, string>> => {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    stdin: "ignore",
  })
  expect(listed.exitCode).toBe(0)
  const files: Record<string, string> = {}
  for (const path of listed.stdout.toString().split("\n")) {
    if (!path || !keep(path)) continue
    const file = Bun.file(join(ROOT, path))
    if (await file.exists()) files[path] = await file.text()
  }
  return files
}

// Text typed into a pane lands as a user turn and reads as the owner's, and nothing may speak for the owner, so only herdr.ts's writes type, for the owner's own clicks and the idle compact's `/compact` the owner approved (ADR 0020); sessions talk through SendMessage. A cmux command that types is held here while cmux can still be installed, and a script's key into a herdr pane further below, to run.py's Escape and `playground picker`.
const PANE_TYPING = [
  /(?:^|[^\w-])[$"'{]*[\w./~-]*cmux\b[}"']?(?:\s+--?[\w-]+(?:=\S+)?)*\s+send(?:-key)?\s+(?!(?:or|and)\b)[^\s`]/i,
  /["']cmux["']\s*,\s*["']send(?:-key)?["']/i,
  /\bsend-key\s+--?\w/i,
]
// Each text file with a line that types into a pane through cmux.
const paneTypers = (files: Record<string, string>): string[] =>
  Object.entries(files)
    .filter(([, text]) =>
      text.split("\n").some((line) => PANE_TYPING.some((typing) => typing.test(line))),
    )
    .map(([path]) => path)

describe("typing into a pane", () => {
  test("no text in the repo types into a pane through cmux", async () => {
    const files = await repoFiles((path) => !path.startsWith("tests/"))
    const texts = Object.fromEntries(
      Object.entries(files).filter(([, text]) => text.length <= 2_000_000 && !text.includes("\0")),
    )
    expect(paneTypers(texts)).toEqual([])
  })

  test("a command, a script's argv or a key, Escape included, types; prose about the rule does not", () => {
    const typing = {
      "argv.py": 'subprocess.run(["cmux", "send", "--surface", s, text])',
      "doc.md": 'cmux send --workspace workspace:N --surface surface:N "/rename x"',
      "flagged.sh": 'cmux --json send --surface "$S" "hi"',
      "key.sh": 'cmux send-key --surface "$S" Enter',
      "quoted.sh": 'cmux send "hello"',
      "variable.sh": '"$CMUX" send-key --surface "$S" Enter',
      "variabletext.sh": '"$CMUX" send --surface "$S" "hi"',
      "escape.md": "cmux send-key --workspace workspace:N --surface surface:N escape",
      "escape.py":
        'args = ["cmux", "send-key", "--force", "--workspace", s["workspace_id"], "--surface", s["surface_id"], "escape"]',
    }
    const clear = {
      "prose.md": "nothing types into a pane: no `cmux send` or `send-key`, and no deliver()",
      "words.md": "cmux sends its Feed as JSON, and cmux send or send-key would type",
    }
    expect(paneTypers({ ...typing, ...clear }).sort()).toEqual(Object.keys(typing).sort())
  })
})

// herdr's pane writes, the one way the dashboard types into a pane: herdr.ts alone names them, and of those that type, prompt() and pressEnter() reach only deliver.ts (the owner's composer, the Linear app's row actions and the owner's inbox answers), with prompt() also reaching idle-compact.ts, the one ops pass the owner approved (ADR 0020), and typeKeys() only feed.ts, whose answerHerdr() serves the herdr answer route, POST /api/v1/workers/:sessionId/feed/:requestId, the owner's own Submit on a prompt's card, since an answer from the card is the owner's own Submit.
const HERDR_TS = "api/hono/src/lib/dashboard/herdr.ts"
const HERDR_WRITES =
  /["'`](?:agent\.(?:prompt|send_keys)|pane\.(?:send_input|send_keys|send_text))["'`]/
const HERDR_TYPERS: Record<string, string[]> = {
  pressEnter: ["api/hono/src/lib/dashboard/deliver.ts"],
  prompt: ["api/hono/src/lib/dashboard/deliver.ts", "api/hono/src/lib/dashboard/idle-compact.ts"],
  typeKeys: ["api/hono/src/lib/dashboard/feed.ts"],
}

// Each source file, other than herdr.ts, that imports or re-exports `name` from a module ending in /herdr, or takes that module whole (a star or a dynamic import).
const HERDR_MODULE = String.raw`["'][^"']*\/herdr(?:\.[cm]?[jt]sx?)?["']`
const herdrTypers = (files: Record<string, string>, name: string): string[] =>
  Object.entries(files)
    .filter(([path, source]) => {
      if (path === HERDR_TS) return false
      const code = codeOf(path, source)
      const whole = new RegExp(
        String.raw`\*\s*(?:as\s+[\w$]+\s*)?from\s*${HERDR_MODULE}|\bimport\s*\(\s*${HERDR_MODULE}\s*\)`,
      )
      const lists = code.matchAll(
        new RegExp(
          String.raw`(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${HERDR_MODULE}`,
          "g",
        ),
      )
      const named = [...lists].some((list) =>
        (list[1] ?? "").split(",").some(
          (part) =>
            part
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0] === name,
        ),
      )
      return named || whole.test(code)
    })
    .map(([path]) => path)

describe("herdr's pane writes", () => {
  const sourceFiles = () =>
    repoFiles((path) => SOURCE.test(path) && !path.startsWith("tests/") && !path.endsWith(".d.ts"))

  test("no source but herdr.ts names a herdr method that types into a pane", async () => {
    const files = await sourceFiles()
    expect(HERDR_WRITES.test(files[HERDR_TS] ?? "")).toBe(true)
    expect(
      Object.entries(files)
        .filter(([path, text]) => path !== HERDR_TS && HERDR_WRITES.test(text))
        .map(([path]) => path),
    ).toEqual([])
  })

  test("prompt() reaches only deliver.ts and idle-compact.ts, pressEnter() only deliver.ts, and typeKeys() only feed.ts's herdr answer route", async () => {
    const files = await sourceFiles()
    for (const [name, allowed] of Object.entries(HERDR_TYPERS)) {
      expect([name, herdrTypers(files, name).sort()]).toEqual([name, allowed])
    }
  })

  test("a named, renamed, dynamic or star import counts; a sibling read does not", () => {
    const typing = {
      "dynamic.ts": 'const h = await import("@/lib/dashboard/herdr")\nawait h.typeKeys(s, k)',
      "named.ts": 'import { typeKeys } from "@/lib/dashboard/herdr"\nawait typeKeys(s, k)',
      "renamed.ts": 'import { typeKeys as press } from "./herdr"\nawait press(s, k)',
      "star.ts": 'import * as h from "../dashboard/herdr"\nh.herdrServers()',
    }
    const clear = {
      "reads.ts": 'import { readScreen } from "@/lib/dashboard/herdr"\nawait readScreen(s, 40)',
      [HERDR_TS]: "export async function typeKeys() {}",
    }
    expect(herdrTypers({ ...typing, ...clear }, "typeKeys").sort()).toEqual(
      Object.keys(typing).sort(),
    )
  })
})

// a script's key into a herdr pane (herdr's CLI `send-keys`) or a Feed reply (`feed.<kind>.reply`) comes only from run.py's Escape on the usage-limit dialog and `playground picker`, a manager's answer to its session's permission prompt, since the managers handle those.
describe("a script's key into a pane or answer to a prompt", () => {
  test("comes from run.py's Escape and playground picker alone", () => {
    const listed = Bun.spawnSync(
      [
        "git",
        "grep",
        "--untracked",
        "-lE",
        String.raw`["']send-keys["']|feed\.[a-z_]+\.reply`,
        "--",
        ":!tests",
      ],
      { cwd: ROOT, stdin: "ignore" },
    )
    const files = listed.stdout.toString().trim().split("\n").filter(Boolean)
    expect(files.filter((path) => !path.endsWith(".md")).sort()).toEqual([
      "packages/scripts/src/playground/picker.ts",
      "scripts/ops/unstick/run.py",
    ])
  })
})

// #1682: ops-herdr keeps <server>.restore beside the server's socket from its start until no session its restore owes waits on a gate or focus, and writes each restore's lines to <server>.restore.log, so the home reads whether this restore can still bring the dispatcher back.
describe("bringsBack", () => {
  const at = Date.parse("2026-11-10T18:14:47Z")
  const minute = 60_000
  const ran = (log: string, logAt = at + minute) =>
    bringsBack({ dispatcher: "dispatcher", log, logAt, now: logAt + 1000, owedAt: at })

  test("before the restore's first run since the owe, for up to 5 minutes, so a start or restore that never runs gives Start back", () => {
    const owed = { dispatcher: "dispatcher", log: "", logAt: null, owedAt: at }
    expect(bringsBack({ ...owed, now: at + 4 * minute })).toBe(true)
    expect(bringsBack({ ...owed, now: at + 6 * minute })).toBe(false)
    const older = { ...owed, log: "restored dispatcher\n", logAt: at - minute }
    expect(bringsBack({ ...older, now: at + minute })).toBe(true)
    expect(bringsBack({ ...older, now: at + 6 * minute })).toBe(false)
  })

  test("while the dispatcher waits, or for 2 minutes after it was restored, as its pane comes up", () => {
    expect(
      ran("waiting dispatcher: focus holds it\nwaiting a-worker: the load gate holds it\n"),
    ).toBe(true)
    expect(ran("restored dispatcher\nwaiting a-worker: the load gate holds it\n")).toBe(true)
    const restored = {
      dispatcher: "dispatcher",
      log: "restored dispatcher\n",
      logAt: at,
      owedAt: at,
    }
    expect(bringsBack({ ...restored, now: at + 3 * minute })).toBe(false)
  })

  test("never once the run failed the dispatcher, skipped it, or held no line for it, whatever else still waits", () => {
    const wait = "waiting a-worker: the load gate holds it\n"
    expect(ran(`not restored dispatcher: herdr refused\n${wait}`)).toBe(false)
    expect(ran(`skipped dispatcher: its roster row reads ended\n${wait}`)).toBe(false)
    expect(ran(wait)).toBe(false)
    expect(ran("waiting dispatcher-2: focus holds it\n")).toBe(false)
  })

  test("a run that named no session, such as another restore's lock, counts as not run yet", () => {
    const locked = {
      dispatcher: "dispatcher",
      log: "restore: another restore runs\n",
      logAt: at + minute,
      owedAt: at,
    }
    expect(bringsBack({ ...locked, now: at + 2 * minute })).toBe(true)
    expect(bringsBack({ ...locked, now: at + 6 * minute })).toBe(false)
  })
})

describe("restoring", () => {
  test("reads each owing server's newest restore log for the dispatcher's line", () => {
    const dir = mkdtempSync(join(tmpdir(), "restoring-"))
    cleanups.push(() => rmSync(dir, { force: true, recursive: true }))
    const servers = [
      { name: "playground", socket: join(dir, "playground.sock") },
      { name: "playground-probes", socket: join(dir, "playground-probes.sock") },
    ]
    const now = Date.now()
    const at = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000)
    const read = () => restoring({ dispatcher: "dispatcher", now, servers })
    expect(read()).toBe(false)
    const owed = join(dir, "playground.restore")
    writeFileSync(owed, "x\n")
    at(owed, now - 60_000)
    expect(read()).toBe(true)
    const log = join(dir, "playground.restore.log")
    writeFileSync(
      log,
      "not restored dispatcher: herdr refused\nwaiting a-worker: the load gate holds it\n",
    )
    at(log, now - 30_000)
    expect(read()).toBe(false)
    writeFileSync(log, "waiting dispatcher: focus holds it\n")
    at(log, now - 30_000)
    expect(read()).toBe(true)
    rmSync(owed)
    expect(read()).toBe(false)
    // probes never holds the dispatcher: once its restore has run, its owe says nothing of it
    const probes = join(dir, "playground-probes.restore")
    writeFileSync(probes, "x\n")
    at(probes, now - 60_000)
    writeFileSync(
      join(dir, "playground-probes.restore.log"),
      "waiting a-probe: the load gate holds it\n",
    )
    at(join(dir, "playground-probes.restore.log"), now - 30_000)
    expect(read()).toBe(false)
  })

  test("a fixture stack reads it from the fixture's herdr.json, and a stack that reads no machine never restores", () => {
    const dir = mkdtempSync(join(tmpdir(), "restoring-fixture-"))
    cleanups.push(() => rmSync(dir, { force: true, recursive: true }))
    const fixture = [{ name: "playground", socket: FIXTURE_SOCKET }]
    const read = (servers: typeof fixture) =>
      restoring({ dispatcher: "dispatcher", fixtureDir: dir, servers })
    writeFileSync(
      join(dir, "herdr.json"),
      JSON.stringify({ panes: [], prompts: {}, screens: {}, workspaces: [] }),
    )
    expect(read(fixture)).toBe(false)
    writeFileSync(
      join(dir, "herdr.json"),
      JSON.stringify({
        panes: [],
        prompts: {},
        restoring: "2026-11-10T18:14:47Z",
        screens: {},
        workspaces: [],
      }),
    )
    expect(read(fixture)).toBe(true)
    expect(read([])).toBe(false)
  })
})
