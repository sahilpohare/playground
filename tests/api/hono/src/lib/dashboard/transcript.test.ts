import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { attachmentsDir } from "../../../../../../api/hono/src/lib/dashboard/attachments"
import {
  commandOf,
  completeLines,
  factsOf,
  lastAgentName,
  NO_FACTS,
  parseLine,
  parseLines,
  readSession,
  readTail,
  readTask,
  recipientOf,
  sentIn,
  shownTasks,
  subagentPath,
  TAIL_CEILING,
  taskOf,
  toolSummary,
  type SessionTask,
} from "../../../../../../api/hono/src/lib/dashboard/transcript"

const line = (value: unknown) => JSON.stringify(value)

const human = (text: string, uuid = "h1") =>
  line({
    type: "user",
    uuid,
    timestamp: "2026-10-06T10:00:00.000Z",
    origin: { kind: "human" },
    message: { role: "user", content: text },
  })

const peer = (body: string, uuid = "p1") =>
  line({
    type: "user",
    uuid,
    isMeta: true,
    timestamp: "2026-10-06T10:00:01.000Z",
    origin: { kind: "peer", name: "dispatcher", from: "uds:/tmp/cc-socks/1.sock", body },
    message: { role: "user", content: `Another Claude session sent a message:\n${body}` },
  })

describe("parseLine", () => {
  test("a person's message is a human entry with its text", () => {
    expect(parseLine(human("ship it"))).toEqual([
      {
        at: "2026-10-06T10:00:00.000Z",
        from: null,
        id: "h1",
        kind: "human",
        text: "ship it",
        tool: null,
      },
    ])
  })

  test("a person's slash command is a human entry, read back as the command it ran", () => {
    const [entry] = parseLine(
      human(
        "<command-message>linear</command-message>\n<command-name>/linear</command-name>\n<command-args>QA</command-args>",
      ),
    )
    expect([entry?.kind, entry?.text]).toEqual(["human", "/linear QA"])
  })

  // Claude Code records a long paste wrapped in <pasted_content> tags
  test("a person's long paste is read back as the words pasted, without its wrapper", () => {
    const words = "Rameen  [3:53 PM]\n@Soren can we\n\nAre the evals progressing."
    const wrapped = `\n\n<pasted_content id="79a0">\n${words}\n</pasted_content id="79a0">\n`
    expect(parseLine(human(wrapped))[0]?.text).toBe(words)
    const twice = `${wrapped}and\n<pasted_content id="b1">\nmore\n</pasted_content id="b1">`
    expect(parseLine(human(twice))[0]?.text).toBe(`${words}\nand\nmore`)
    const quoted = 'see <pasted_content id="x">\nhi\n</pasted_content id="y">'
    expect(parseLine(human(quoted))[0]?.text).toBe(quoted)
  })

  test("a peer session's message is a peer entry, named for the sender, with the body alone", () => {
    const [entry] = parseLine(peer("Go: build P1"))
    expect(entry?.kind).toBe("peer")
    expect(entry?.from).toBe("dispatcher")
    expect(entry?.text).toBe("Go: build P1")
  })

  test("a message typed mid-turn (a queued_command attachment) is a human entry", () => {
    const entries = parseLine(
      line({
        type: "attachment",
        uuid: "q1",
        timestamp: "2026-10-06T10:00:02.000Z",
        attachment: {
          type: "queued_command",
          prompt: "keep it running",
          origin: { kind: "human" },
        },
      }),
    )
    expect(entries.map((e) => [e.kind, e.text])).toEqual([["human", "keep it running"]])
  })

  test("a message the dashboard sent with files keeps its words as text and its files as attachments", () => {
    const png = "11111111-2222-4333-8444-555555555555.png"
    const sent = `look\n\nAttached: ${join(attachmentsDir(), png)}`
    expect(parseLine(human(sent))).toEqual([
      {
        at: "2026-10-06T10:00:00.000Z",
        attachments: [{ id: png, kind: "image" }],
        from: null,
        id: "h1",
        kind: "human",
        text: "look",
        tool: null,
      },
    ])
    const [alone] = parseLine(human(`Attached: ${join(attachmentsDir(), png)}`))
    expect(alone).toMatchObject({ attachments: [{ id: png, kind: "image" }], text: "" })
  })

  test("an Attached line naming any path outside the attachments folder stays the person's words", () => {
    const [entry] = parseLine(human("see\n\nAttached: /etc/passwd"))
    expect(entry?.text).toBe("see\n\nAttached: /etc/passwd")
    expect(entry?.attachments).toBeUndefined()
  })

  // herdr pastes the message whole: Claude Code takes each image path in as an image, puts its [Image #n] first, drops blank lines and splits a line at " /", so "Attached: <pdf>" lands as two lines (measured on 2.1.304)
  const png = "11111111-2222-4333-8444-555555555555.png"
  const pdf = "11111111-2222-4333-8444-555555555556.pdf"
  const txt = "11111111-2222-4333-8444-555555555557.txt"
  const pasted = (text: string, images = 1) =>
    line({
      type: "user",
      uuid: "h2",
      promptId: "p-files",
      imagePasteIds: Array.from({ length: images }, (_, i) => i + 1),
      timestamp: "2026-10-06T10:00:00.000Z",
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [
          { type: "text", text },
          ...Array.from({ length: images }, () => ({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          })),
        ],
      },
    })
  const source = (path: string, uuid = "m1") =>
    line({
      type: "user",
      uuid,
      isMeta: true,
      promptId: "p-files",
      timestamp: "2026-10-06T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: `[Image: source: ${path}]` }] },
    })
  const herdrText = () =>
    [
      "[Image #1]Three files.",
      "Second paragraph.",
      "Attached:",
      "Attached:",
      join(attachmentsDir(), pdf),
      "Attached:",
      join(attachmentsDir(), txt),
    ].join("\n")

  test("a message herdr pasted with files keeps its words and its files, each image named by the source line after it", () => {
    const entries = parseLines(
      [pasted(herdrText()), source(join(attachmentsDir(), png))].join("\n"),
    )
    expect(entries).toEqual([
      {
        at: "2026-10-06T10:00:00.000Z",
        attachments: [
          { id: png, kind: "image" },
          { id: pdf, kind: "pdf" },
          { id: txt, kind: "text" },
        ],
        from: null,
        id: "h2",
        kind: "human",
        text: "Three files.\nSecond paragraph.",
        tool: null,
      },
    ])
  })

  test("a pasted image whose source line is not in the read is still a file, its id unknown", () => {
    const [entry] = parseLine(pasted(herdrText()))
    expect(entry).toMatchObject({
      attachments: [
        { id: null, kind: "image" },
        { id: pdf, kind: "pdf" },
        { id: txt, kind: "text" },
      ],
      text: "Three files.\nSecond paragraph.",
    })
    // files alone: the first file's line follows the image's mark
    const [alone] = parseLine(
      pasted(`[Image #1]Attached:\nAttached:\n${join(attachmentsDir(), pdf)}`),
    )
    expect(alone).toMatchObject({
      attachments: [
        { id: null, kind: "image" },
        { id: pdf, kind: "pdf" },
      ],
      text: "",
    })
  })

  // 2.1.309 also writes a space between the marks, and the message then never read delivered
  test("a message herdr pasted with images keeps its words and its files with or without a space between the marks", () => {
    const second = "11111111-2222-4333-8444-555555555558.png"
    for (const marks of ["[Image #3][Image #4]", "[Image #3] [Image #4]"]) {
      const entries = parseLines(
        [
          pasted(`${marks}Two screenshots.\nAttached:\nAttached:`, 2),
          source(join(attachmentsDir(), png)),
          source(join(attachmentsDir(), second), "m2"),
        ].join("\n"),
      )
      expect(entries).toMatchObject([
        {
          attachments: [
            { id: png, kind: "image" },
            { id: second, kind: "image" },
          ],
          kind: "human",
          text: "Two screenshots.",
        },
      ])
    }
  })

  test("a source line naming a file outside the attachments folder names no image", () => {
    const [entry] = parseLines([pasted(herdrText()), source("/etc/passwd.png")].join("\n"))
    expect(entry?.attachments?.[0]).toEqual({ id: null, kind: "image" })
  })

  test("a bare Attached line with no image of its own stays the person's words", () => {
    const [typed] = parseLine(human("see below\nAttached:"))
    expect(typed?.text).toBe("see below\nAttached:")
    expect(typed?.attachments).toBeUndefined()
    const [two] = parseLine(pasted("[Image #1]look\nAttached:\nAttached:"))
    expect(two?.text).toBe("[Image #1]look\nAttached:\nAttached:")
    expect(two?.attachments).toBeUndefined()
  })

  test("a message with files queued mid-turn is a human entry with its words and files", () => {
    const entries = parseLine(
      line({
        type: "attachment",
        uuid: "q2",
        timestamp: "2026-10-06T10:00:02.000Z",
        attachment: {
          type: "queued_command",
          prompt: [
            { type: "text", text: "[Image #1]look\nAttached:" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
          origin: { kind: "human" },
        },
      }),
    )
    expect(entries).toMatchObject([
      { attachments: [{ id: null, kind: "image" }], kind: "human", text: "look" },
    ])
  })

  test("an assistant line yields its thinking, its text and each tool call, in order", () => {
    const entries = parseLine(
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-10-06T10:00:03.000Z",
        message: {
          content: [
            { type: "thinking", thinking: "Weighing the board first." },
            { type: "thinking", thinking: "", signature: "redacted" },
            { type: "text", text: "Checking the board." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls", description: "List files" },
            },
          ],
        },
      }),
    )
    expect(entries.map((e) => [e.id, e.kind, e.tool, e.text])).toEqual([
      ["a1:0", "reasoning", null, "Weighing the board first."],
      ["a1:2", "assistant", null, "Checking the board."],
      ["a1:3", "tool", "Bash", "List files"],
    ])
    expect(entries[2]).toMatchObject({
      input: '{\n  "command": "ls",\n  "description": "List files"\n}',
      toolUseId: "toolu_1",
    })
  })

  test("the last step of a line that ends its turn (stop_reason end_turn) is marked, so the stream knows the reply has stopped", () => {
    const ending = parseLine(
      line({
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-10-06T10:00:04.000Z",
        message: { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" },
      }),
    )
    expect(ending).toMatchObject([{ endsTurn: true, id: "a2:0", kind: "assistant" }])
    const going = parseLine(
      line({
        type: "assistant",
        uuid: "a3",
        timestamp: "2026-10-06T10:00:05.000Z",
        message: { content: [{ type: "text", text: "Reading." }], stop_reason: "tool_use" },
      }),
    )
    expect(going[0]?.endsTurn).toBeUndefined()
  })

  test("a tool result is a result step naming the call it answers, with its text clipped and its failure kept", () => {
    const entries = parseLine(
      line({
        type: "user",
        uuid: "r1",
        timestamp: "2026-10-06T10:00:04.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: true,
              content: [{ type: "text", text: "x".repeat(5000) }, { type: "image" }],
            },
          ],
        },
      }),
    )
    expect(entries.map((e) => [e.id, e.kind, e.toolUseId, e.isError ?? false])).toEqual([
      ["r1:0", "result", "toolu_1", false],
      ["r1:1", "result", "toolu_2", true],
    ])
    expect(entries[0]?.text).toBe("a.txt\nb.txt")
    expect(entries[1]?.text).toHaveLength(2000)
    expect(entries[1]?.text.endsWith("…")).toBe(true)
  })

  test("an Agent call's result names its subagent, from toolUseResult or, as the database keeps it, its text", () => {
    const result = (extra: Record<string, unknown>, text: string) =>
      parseLine(
        line({
          type: "user",
          uuid: "r2",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: text }] },
          ...extra,
        }),
      )[0]?.agentId
    expect(result({ toolUseResult: { agentId: "a12bc" } }, "done")).toBe("a12bc")
    expect(result({}, "Report.\nagentId: a77de (use SendMessage to continue)")).toBe("a77de")
    expect(result({}, "no subagent here")).toBeUndefined()
  })

  test("the line naming the subagent leaves its report, which reads as the subagent wrote it", () => {
    const [entry] = parseLine(
      line({
        type: "user",
        uuid: "r3",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: "Report.\nagentId: a77de (use SendMessage to continue)",
            },
          ],
        },
      }),
    )
    expect(entry).toMatchObject({ agentId: "a77de", text: "Report." })
  })

  test("a subagent's own lines are read only when the transcript read is that subagent's", () => {
    const own = line({
      type: "assistant",
      uuid: "s1",
      isSidechain: true,
      message: { content: [{ type: "text", text: "subagent at work" }] },
    })
    expect(parseLine(own)).toEqual([])
    expect(parseLine(own, { sidechain: true }).map((e) => e.text)).toEqual(["subagent at work"])
  })

  test("system reminders, task notifications, sidechains and junk are left out", () => {
    const notification = line({
      type: "user",
      uuid: "n1",
      origin: { kind: "task-notification" },
      message: { content: "<task-notification>done</task-notification>" },
    })
    const sidechain = line({
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "subagent" }] },
    })
    for (const raw of [notification, sidechain, "not json", line({ type: "mode" })]) {
      expect(parseLine(raw)).toEqual([])
    }
  })
})

describe("subagentPath", () => {
  test("is the subagent's file beside its session's transcript", () => {
    expect(subagentPath("/p/-dir/abc.jsonl", "a12bc")).toBe(
      "/p/-dir/abc/subagents/agent-a12bc.jsonl",
    )
  })

  test("refuses an id that could leave the folder", () => {
    for (const id of ["../x", "a/b", "", "A1", "a.b"])
      expect(subagentPath("/p/abc.jsonl", id)).toBeNull()
  })
})

describe("toolSummary", () => {
  test("SendMessage reads as its recipient and first line", () => {
    expect(toolSummary("SendMessage", { to: "dispatcher", message: "PR opened\nmore" })).toBe(
      "to dispatcher: PR opened",
    )
  })

  test("other tools use the most telling input, description before command", () => {
    expect(toolSummary("Bash", { command: "rm -rf x", description: "Remove x" })).toBe("Remove x")
    expect(toolSummary("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts")
    expect(toolSummary("Weird", { other: 1 })).toBe("")
  })
})

describe("commandOf", () => {
  test("a slash command's tags read back as the command it ran", () => {
    expect(
      commandOf(
        "<command-message>linear</command-message>\n<command-name>/linear</command-name>\n<command-args>QA</command-args>",
      ),
    ).toBe("/linear QA")
  })

  test("a message tag alone is no command: only the name tag says what ran", () => {
    expect(commandOf("<command-message>linear</command-message>")).toBeNull()
    expect(
      commandOf("<command-message>init is analyzing your codebase…</command-message>"),
    ).toBeNull()
  })

  test("text that does not start with a command's tags is no command", () => {
    expect(commandOf("Review <command-name>/rename</command-name>")).toBeNull()
    expect(commandOf("<local-command-stdout>Renamed</local-command-stdout>")).toBeNull()
  })
})

describe("taskOf", () => {
  test("is the first line of the first thing a person or peer asked", () => {
    const entries = parseLines([peer("Task from dispatcher\nDetails"), human("later")].join("\n"))
    expect(taskOf(entries)).toBe("Task from dispatcher")
  })

  test("is null when nobody has asked anything yet", () => {
    expect(taskOf([])).toBeNull()
  })

  test("a message of files alone has no words to be the task, so the next ask is", () => {
    const files = human(
      `Attached: ${join(attachmentsDir(), "11111111-2222-4333-8444-555555555555.png")}`,
    )
    const entries = parseLines([files, human("what is wrong here?", "h2")].join("\n"))
    expect(taskOf(entries)).toBe("what is wrong here?")
  })
})

describe("readTail and readTask", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-transcript-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("readTail returns the last entries; readTask the first ask", async () => {
    const path = join(dir, "s.jsonl")
    const lines = [
      peer("first ask", "p0"),
      ...Array.from({ length: 5 }, (_, i) => human(`m${i}`, `h${i}`)),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`)
    expect((await readTail(path, 2)).map((e) => e.text)).toEqual(["m3", "m4"])
    expect(await readTask(path)).toBe("first ask")
  })

  test("a session a person started with a slash command has the command as its task", async () => {
    const path = join(dir, "command.jsonl")
    const skill = line({
      type: "user",
      uuid: "m1",
      isMeta: true,
      message: { role: "user", content: [{ type: "text", text: "Base directory for this skill" }] },
    })
    const lines = [
      human("<command-message>linear</command-message>\n<command-name>/linear</command-name>"),
      skill,
      human("later", "h2"),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`)
    expect(await readTask(path)).toBe("/linear")
  })

  test("a half-written last line is not parsed until it is complete", async () => {
    const path = join(dir, "partial.jsonl")
    writeFileSync(path, `${human("done", "h9")}\n{"type":"user","uuid":"x`)
    expect((await readTail(path, 10)).map((e) => e.text)).toEqual(["done"])
  })

  const shot = (bytes: number) =>
    line({
      type: "user",
      uuid: "shot",
      timestamp: "2026-10-06T10:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) },
              },
            ],
          },
        ],
      },
    })
  const progress = (i: number) =>
    line({ type: "progress", uuid: `g${i}`, data: { blob: "p".repeat(10_000) } })

  test("a last line longer than the window still shows the steps before it", async () => {
    const path = join(dir, "big-last.jsonl")
    writeFileSync(path, `${human("early", "h1")}\n${shot(700_000)}\n`)
    expect((await readTail(path, 10)).map((e) => e.kind)).toEqual(["human", "result"])
  })

  test("a window of bookkeeping lines alone still shows the steps before it", async () => {
    const path = join(dir, "progress-tail.jsonl")
    const lines = [human("early", "h1"), ...Array.from({ length: 60 }, (_, i) => progress(i))]
    writeFileSync(path, `${lines.join("\n")}\n`)
    expect((await readTail(path, 10)).map((e) => e.text)).toEqual(["early"])
  })

  test("a window that holds a step reads no further back", async () => {
    const path = join(dir, "holds-a-step.jsonl")
    const lines = [
      human("old", "h0"),
      ...Array.from({ length: 60 }, (_, i) => progress(i)),
      human("new", "h1"),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`)
    expect((await readTail(path, 10)).map((e) => e.text)).toEqual(["new"])
  })

  test("a step further back than TAIL_CEILING is not read", async () => {
    const path = join(dir, "past-ceiling.jsonl")
    const count = Math.ceil(TAIL_CEILING / 10_000) + 1
    const lines = [human("early", "h1"), ...Array.from({ length: count }, (_, i) => progress(i))]
    writeFileSync(path, `${lines.join("\n")}\n`)
    expect(await readTail(path, 10)).toEqual([])
  })
})

describe("completeLines", () => {
  const encode = (text: string) => new TextEncoder().encode(text)

  test("takes whole lines only, and counts what it took in bytes", () => {
    const bytes = encode("first é line\nsecond line still being wri")
    const { consumed, text } = completeLines(bytes)
    expect(text).toBe("first é line\n")
    expect(consumed).toBe(encode("first é line\n").length)
  })

  test("an offset after a multi-byte character lands exactly on the next line", () => {
    const bytes = encode('é\n{"next":1}\n')
    const first = completeLines(bytes.subarray(0, 3))
    expect(first.consumed).toBe(3)
    expect(completeLines(bytes.subarray(first.consumed)).text).toBe('{"next":1}\n')
  })

  test("a slice that starts inside a character counts its bytes, not the replacement character it decodes to", () => {
    expect(completeLines(new Uint8Array([0xa9, 0x0a])).consumed).toBe(2)
  })

  test("no newline yet means nothing is consumed", () => {
    expect(completeLines(encode("half a line"))).toEqual({ consumed: 0, text: "" })
  })
})

const named = (agentName: string) =>
  `${line({ type: "custom-title", customTitle: agentName, sessionId: "s1" })}\n${line({ type: "agent-name", agentName, sessionId: "s1" })}\n`

describe("lastAgentName", () => {
  test("is the newest name a whole agent-name line records", () => {
    expect(lastAgentName(named("wrath") + human("go") + "\n" + named("worker-wrath"))).toBe(
      "worker-wrath",
    )
  })

  test("a half-written agent-name line does not count yet", () => {
    const partial = named("wrath") + line({ type: "agent-name", agentName: "worker-wrath" })
    expect(lastAgentName(partial)).toBe("wrath")
  })

  test("the words quoted inside another line, such as a tool result that printed a transcript, are not a name", () => {
    const quoted = line({
      type: "user",
      message: { content: '{"type":"agent-name","agentName":"evil"}' },
    })
    expect(lastAgentName(`${quoted}\n`)).toBeNull()
  })

  test("a structured record nested in another line (a tool's input) is not a name, so the real one before it stands", () => {
    const nested = line({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { type: "agent-name", agentName: "dispatcher" },
          },
        ],
      },
    })
    expect(nested).toContain('"type":"agent-name"')
    expect(lastAgentName(`${named("worker-wrath")}${nested}\n`)).toBe("worker-wrath")
  })

  test("is null when the text holds no name", () => {
    expect(lastAgentName(`${human("hi")}\n`)).toBeNull()
  })
})

const send = (to: string, message: string, timestamp: string, extra: object = {}) =>
  line({
    type: "assistant",
    timestamp,
    ...extra,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reporting" },
        { type: "tool_use", name: "SendMessage", input: { to, message } },
      ],
    },
  })

describe("sentIn", () => {
  test("reads each SendMessage in a line: its recipient without the [ref], its message and the line's time", () => {
    expect(sentIn(send("builder [9919]", "  done  ", "2026-10-06T10:00:00Z"))).toEqual([
      { at: "2026-10-06T10:00:00Z", text: "done", to: "builder" },
    ])
    expect(recipientOf(" uds:/tmp/cc-socks/1.sock ")).toBe("uds:/tmp/cc-socks/1.sock")
  })

  test("a subagent's line, a person's line and a line with no recipient send nothing", () => {
    expect(sentIn(send("builder", "hi", "2026-10-06T10:00:00Z", { isSidechain: true }))).toEqual([])
    expect(sentIn(human("call SendMessage for me"))).toEqual([])
    expect(sentIn(send(" ", "hi", "2026-10-06T10:00:00Z"))).toEqual([])
  })
})

describe("readSession", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-name-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const filler = (bytes: number) =>
    `${line({ type: "user", message: { content: "x".repeat(bytes) } })}\n`

  test("the first read finds the newest name near the end, and remembers how far it read", async () => {
    const path = join(dir, "near.jsonl")
    writeFileSync(path, named("greed") + filler(1000) + named("worker-greed"))
    const read = await readSession(path, null)
    expect(read).toEqual({
      ...NO_FACTS,
      name: "worker-greed",
      offset: Bun.file(path).size,
      path,
    })
  })

  test("the first read walks back past a long turn to the last name before it", async () => {
    const path = join(dir, "far.jsonl")
    writeFileSync(path, named("runner-pride") + filler(3 * 1024 * 1024))
    expect((await readSession(path, null)).name).toBe("runner-pride")
  })

  test("a name further back than the scan limit is not found", async () => {
    const path = join(dir, "too-far.jsonl")
    writeFileSync(path, named("lost") + filler(9 * 1024 * 1024))
    expect((await readSession(path, null)).name).toBeNull()
  })

  test("later reads take only what was appended: a rename shows, and a turn without one keeps the name", async () => {
    const path = join(dir, "grow.jsonl")
    writeFileSync(path, named("wrath"))
    const first = await readSession(path, null)
    expect(await readSession(path, first)).toBe(first)
    appendFileSync(path, filler(500))
    const quiet = await readSession(path, first)
    expect(quiet).toEqual({
      ...NO_FACTS,
      name: "wrath",
      offset: Bun.file(path).size,
      path,
    })
    appendFileSync(path, named("worker-wrath"))
    expect((await readSession(path, quiet)).name).toBe("worker-wrath")
  })

  test("a rename written in two pieces is read once its line is whole", async () => {
    const path = join(dir, "split.jsonl")
    writeFileSync(path, named("wrath"))
    const before = await readSession(path, null)
    const record = line({ type: "agent-name", agentName: "worker-wrath", sessionId: "s1" })
    appendFileSync(path, record.slice(0, 10))
    const mid = await readSession(path, before)
    expect(mid.name).toBe("wrath")
    appendFileSync(path, `${record.slice(10)}\n`)
    expect((await readSession(path, mid)).name).toBe("worker-wrath")
  })

  test("a name line split by the first megabyte's edge is still found, with multibyte text around it", async () => {
    const path = join(dir, "edge.jsonl")
    const record = `${line({ type: "agent-name", agentName: "worker-gluttony", sessionId: "s1" })}\n`
    // a multibyte line sized so the point 1MB before the end falls 40 bytes inside the name record
    const target = 1024 * 1024 - 40
    const empty = Buffer.byteLength(`${line({ type: "user", message: { content: "" } })}\n`)
    const wide = Math.floor((target - empty) / 3)
    const after = `${line({ type: "user", message: { content: "数".repeat(wide) + "x".repeat(target - empty - wide * 3) } })}\n`
    expect(Buffer.byteLength(after)).toBe(target)
    writeFileSync(path, named("old") + filler(1024 * 1024) + record + after)
    expect((await readSession(path, null)).name).toBe("worker-gluttony")
  })

  test("offsets count bytes, so a multibyte name appended later is read whole", async () => {
    const path = join(dir, "multibyte.jsonl")
    writeFileSync(
      path,
      `${line({ type: "user", message: { content: "猫".repeat(100) } })}\n${named("wrath")}`,
    )
    const first = await readSession(path, null)
    expect(first.offset).toBe(Bun.file(path).size)
    appendFileSync(path, named("worker-憤怒"))
    const next = await readSession(path, first)
    expect(next.name).toBe("worker-憤怒")
    expect(next.offset).toBe(Bun.file(path).size)
  })

  test("a rename half-written at the first read is picked up once it is whole", async () => {
    const path = join(dir, "first-partial.jsonl")
    const record = line({ type: "agent-name", agentName: "worker-wrath", sessionId: "s1" })
    writeFileSync(path, named("wrath") + record.slice(0, 20))
    const first = await readSession(path, null)
    expect(first.name).toBe("wrath")
    expect(first.offset).toBeLessThan(Bun.file(path).size)
    appendFileSync(path, `${record.slice(20)}\n`)
    expect((await readSession(path, first)).name).toBe("worker-wrath")
  })

  test("a gap past the scan's reach is scanned back over instead of read whole, keeping the old name when it holds none", async () => {
    const path = join(dir, "away.jsonl")
    writeFileSync(path, named("worker-sloth"))
    const first = await readSession(path, null)
    // a rename at the start of a 9MB gap lies beyond the scan, so only the bounded path keeps the old name; reading the gap whole would find it
    appendFileSync(path, named("runner-sloth") + filler(9 * 1024 * 1024))
    const later = await readSession(path, first)
    expect(later).toEqual({
      ...NO_FACTS,
      name: "worker-sloth",
      offset: Bun.file(path).size,
      path,
    })
    appendFileSync(path, filler(9 * 1024 * 1024) + named("runner-sloth"))
    expect((await readSession(path, later)).name).toBe("runner-sloth")
  })

  test("a session whose transcript moved is read afresh from the new file", async () => {
    const oldPath = join(dir, "old-path.jsonl")
    const newPath = join(dir, "new-path.jsonl")
    writeFileSync(oldPath, filler(100) + named("worker-old"))
    writeFileSync(newPath, named("worker-new") + filler(5000))
    const first = await readSession(oldPath, null)
    expect((await readSession(newPath, first)).name).toBe("worker-new")
  })

  test("a transcript that shrank is read again from its end", async () => {
    const path = join(dir, "shrunk.jsonl")
    writeFileSync(path, filler(2000) + named("old"))
    const first = await readSession(path, null)
    writeFileSync(path, named("new"))
    expect((await readSession(path, first)).name).toBe("new")
  })

  test("turnAt carries across reads, and a turn appended later moves it", async () => {
    const path = join(dir, "turn.jsonl")
    const user = (timestamp: string) =>
      `${line({ type: "user", timestamp, message: { content: "go on" } })}\n`
    writeFileSync(path, user("2026-10-06T10:00:00Z") + filler(100))
    const first = await readSession(path, null)
    expect(first.turnAt).toBe("2026-10-06T10:00:00Z")
    appendFileSync(path, filler(100))
    const quiet = await readSession(path, first)
    expect(quiet.turnAt).toBe("2026-10-06T10:00:00Z")
    appendFileSync(path, user("2026-10-06T11:00:00Z"))
    expect((await readSession(path, quiet)).turnAt).toBe("2026-10-06T11:00:00Z")
  })
})

describe("factsOf", () => {
  const T0 = "2026-10-06T12:00:00.000Z"
  const T1 = "2026-10-06T12:05:00.000Z"
  const assistant = (content: unknown[], fields: Record<string, unknown> = {}) =>
    line({
      type: "assistant",
      timestamp: T0,
      effort: "high",
      message: { model: "claude-opus-5-5", content },
      ...fields,
    })
  const use = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "tool_use",
    id,
    name,
    input,
  })
  const result = (
    id: string,
    toolUseResult: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    line({
      type: "user",
      timestamp: T1,
      toolUseResult,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] },
    })
  const notice = (taskId: string, toolUseId: string, status: string) =>
    line({
      type: "user",
      timestamp: T1,
      origin: { kind: "task-notification" },
      message: {
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
      },
    })
  const states = (text: string) =>
    Object.values(factsOf(text).tasks).map((t) => [t.kind, t.label, t.state, t.taskId])

  test("turnAt is when the newest user or assistant line was written, never a subagent's", () => {
    const user = (timestamp: string, fields: Record<string, unknown> = {}) =>
      line({ type: "user", timestamp, message: { content: "go on" }, ...fields })
    expect(factsOf(user(T0)).turnAt).toBe(T0)
    expect(factsOf(assistant([{ type: "text", text: "ok" }], { timestamp: T1 })).turnAt).toBe(T1)
    expect(factsOf([user(T0), user(T1, { isSidechain: true })].join("\n")).turnAt).toBe(T0)
    expect(factsOf(line({ type: "system", timestamp: T1 }), factsOf(user(T0))).turnAt).toBe(T0)
  })

  test("failed while the newest reply is an API error, cleared by the next reply, never by a subagent's", () => {
    const error = assistant([{ type: "text", text: "API Error: overloaded" }], {
      isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] },
    })
    const reply = assistant([{ type: "text", text: "back" }])
    const sidechain = assistant([{ type: "text", text: "x" }], { isSidechain: true })
    expect(factsOf(error).failed).toBe(true)
    expect(factsOf([error, reply].join("\n")).failed).toBe(false)
    expect(factsOf([reply, error].join("\n")).failed).toBe(true)
    expect(factsOf([error, sidechain].join("\n")).failed).toBe(true)
    expect(factsOf(reply).failed).toBe(false)
  })

  test("loginExpired while the newest reply is Claude Code's expired-login error, cleared by the next reply", () => {
    const expired = assistant([{ type: "text", text: "Login expired · Please run /login" }], {
      isApiErrorMessage: true,
    })
    const overloaded = assistant([{ type: "text", text: "API Error: overloaded" }], {
      isApiErrorMessage: true,
    })
    const reply = assistant([{ type: "text", text: "back" }])
    expect(factsOf(expired).loginExpired).toBe(true)
    expect(factsOf([expired, reply].join("\n")).loginExpired).toBe(false)
    expect(factsOf(overloaded).loginExpired).toBe(false)
    // the words alone, in a reply that is no API error, are only text
    expect(factsOf(assistant([{ type: "text", text: "Please run /login" }])).loginExpired).toBe(
      false,
    )
  })

  test("the newest reply's model and effort, skipping a synthetic reply and a subagent's lines", () => {
    const text = [
      assistant([], { effort: "medium" }),
      line({ type: "assistant", message: { model: "<synthetic>", content: [] } }),
      line({
        type: "assistant",
        isSidechain: true,
        effort: "low",
        message: { model: "claude-haiku-4-5-20251001", content: [] },
      }),
    ].join("\n")
    expect(factsOf(text)).toMatchObject({ effort: "medium", model: "claude-opus-5-5" })
    expect(factsOf("")).toEqual(NO_FACTS)
  })

  // a herdr session's card is built from the call that raised its prompt.
  test("a tool call is open from its call until its result, a subagent's and an Agent call's never", () => {
    const text = [
      assistant([
        use("toolu_bash", "Bash", { command: "ls" }),
        use("toolu_agent", "Agent", { description: "Look around" }),
        use("toolu_ask", "AskUserQuestion", { questions: [] }),
      ]),
      assistant([use("toolu_side", "Write", { file_path: "/x" })], { isSidechain: true }),
    ].join("\n")
    expect(factsOf(text).calls).toEqual([
      { at: T0, id: "toolu_bash", input: { command: "ls" }, name: "Bash" },
      { at: T0, id: "toolu_ask", input: { questions: [] }, name: "AskUserQuestion" },
    ])
    const ran = factsOf(result("toolu_bash", {}), factsOf(text))
    expect(ran.calls.map((call) => call.id)).toEqual(["toolu_ask"])
  })

  test("only the newest open calls are kept, so calls a crash left open never pile up", () => {
    const text = Array.from({ length: 10 }, (_, i) =>
      assistant([use(`toolu_${i}`, "Read", { file_path: `/f${i}` })]),
    ).join("\n")
    expect(factsOf(text).calls.map((call) => call.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `toolu_${i + 2}`),
    )
  })

  test("a picker is open from its call until its result, and the newest answer is when that result landed", () => {
    const ask = (id: string) => assistant([use(id, "AskUserQuestion", { questions: [] })])
    const asked = [ask("toolu_a"), ask("toolu_b")].join("\n")
    expect(factsOf(asked).pickers).toEqual({
      answeredAt: null,
      interrupted: false,
      open: ["toolu_a", "toolu_b"],
    })
    const one = factsOf([asked, result("toolu_a", {})].join("\n"))
    expect(one.pickers).toEqual({ answeredAt: T1, interrupted: false, open: ["toolu_b"] })
    const both = factsOf([result("toolu_b", {}, { is_error: true })].join("\n"), one)
    expect(both.pickers).toEqual({ answeredAt: T1, interrupted: false, open: [] })
  })

  test("an interrupt after a picker's answer marks it, and the next picker clears the mark", () => {
    const ask = (id: string) => assistant([use(id, "AskUserQuestion", { questions: [] })])
    const interrupt = line({
      type: "user",
      timestamp: T1,
      message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
    })
    const rejected = [ask("toolu_a"), result("toolu_a", {}, { is_error: true }), interrupt]
    expect(factsOf(rejected.join("\n")).pickers).toEqual({
      answeredAt: T1,
      interrupted: true,
      open: [],
    })
    expect(factsOf([...rejected, ask("toolu_b")].join("\n")).pickers.interrupted).toBe(false)
    expect(factsOf(rejected.slice(0, 2).join("\n")).pickers.interrupted).toBe(false)
  })

  test("another tool's result answers no picker", () => {
    const text = [
      assistant([use("toolu_a", "AskUserQuestion", { questions: [] })]),
      result("toolu_other", {}),
    ].join("\n")
    expect(factsOf(text).pickers).toEqual({
      answeredAt: null,
      interrupted: false,
      open: ["toolu_a"],
    })
  })

  test("a foreground subagent runs until its result, and fails on an error result", () => {
    const start = assistant([
      use("t1", "Agent", { description: "Review the diff", subagent_type: "Explore" }),
    ])
    expect(states(start)).toEqual([["agent", "Review the diff", "running", null]])
    expect(states(`${start}\n${result("t1", { status: "completed" })}`)).toEqual([
      ["agent", "Review the diff", "done", null],
    ])
    expect(states(`${start}\n${result("t1", {}, { is_error: true })}`)).toEqual([
      ["agent", "Review the diff", "failed", null],
    ])
  })

  test("a background subagent and process keep running past their launch result, until a notification ends them", () => {
    const text = [
      assistant([
        use("t1", "Agent", { description: "Look up the schema", run_in_background: true }),
        use("t2", "Bash", {
          command: "bun run dev",
          description: "Start the dev stack",
          run_in_background: true,
        }),
        use("t3", "Bash", { command: "ls" }),
      ]),
      result("t1", { isAsync: true, status: "async_launched", agentId: "a123" }),
      result("t2", { backgroundTaskId: "b456" }),
    ].join("\n")
    expect(states(text)).toEqual([
      ["agent", "Look up the schema", "running", "a123"],
      ["process", "Start the dev stack", "running", "b456"],
    ])
    const ended = [text, notice("a123", "t1", "completed"), notice("b456", "t2", "failed")].join(
      "\n",
    )
    expect(states(ended)).toEqual([
      ["agent", "Look up the schema", "done", "a123"],
      ["process", "Start the dev stack", "failed", "b456"],
    ])
    expect(Object.values(factsOf(ended).tasks).every((t) => t.endedAt === T1)).toBe(true)
  })

  test("a process is named by its description, and carries its command's first line", () => {
    const text = assistant([
      use("t2", "Bash", {
        command: "python3 -I /tmp/pace.py\n--every 60",
        description: "Watch the 5-hour pace\nevery minute",
        run_in_background: true,
      }),
    ])
    const task = factsOf(text).tasks.t2
    expect([task?.label, task?.command]).toEqual([
      "Watch the 5-hour pace",
      "python3 -I /tmp/pace.py",
    ])
  })

  test("a process with no description is named by its command's first line", () => {
    const task = factsOf(
      assistant([use("t2", "Bash", { command: "tail -f log\nmore", run_in_background: true })]),
    ).tasks.t2
    expect([task?.label, task?.command]).toEqual(["tail -f log", "tail -f log"])
  })

  test("a process with neither a description nor a command is named Process", () => {
    const task = factsOf(assistant([use("t2", "Bash", { run_in_background: true })])).tasks.t2
    expect([task?.label, task?.command]).toEqual(["Process", undefined])
  })

  test("TaskStop and a killed notification stop a task", () => {
    const text = [
      assistant([use("t2", "Bash", { command: "tail -f log\nmore", run_in_background: true })]),
      result("t2", { backgroundTaskId: "b456" }),
      assistant([use("t9", "TaskStop", { task_id: "b456" })]),
    ].join("\n")
    expect(states(text)).toEqual([["process", "tail -f log", "stopped", "b456"]])
    const killed = [text.split("\n").slice(0, 2).join("\n"), notice("b456", "t2", "killed")].join(
      "\n",
    )
    expect(states(killed)).toEqual([["process", "tail -f log", "stopped", "b456"]])
  })

  test("a process's job is its working directory and command, so restarts under new descriptions make one row", () => {
    const start = (id: string, cwd: string, description: string, timestamp: string) =>
      assistant(
        [use(id, "Bash", { command: "bun run sweep", description, run_in_background: true })],
        { cwd, timestamp },
      )
    const text = [
      start("t1", "/repo", "Restart the sweep with the new watcher", T0),
      start("t2", "/repo", "Restart the sweep with a longer timeout", T1),
      start("t3", "/other", "Restart the sweep", T0),
    ].join("\n")
    const tasks = factsOf(text).tasks
    expect([tasks.t1?.job, tasks.t2?.job, tasks.t3?.job]).toEqual([
      "/repo\nbun run sweep",
      "/repo\nbun run sweep",
      "/other\nbun run sweep",
    ])
    const shown = shownTasks(tasks, Date.parse(T0)).map((t) => [t.id, t.label])
    expect(shown).toEqual([
      ["t2", "Restart the sweep with a longer timeout"],
      ["t3", "Restart the sweep"],
    ])
  })

  test("a quoted notification or a subagent's own tool calls start and end nothing", () => {
    const text = [
      line({
        type: "assistant",
        isSidechain: true,
        message: { content: [use("s1", "Bash", { command: "x", run_in_background: true })] },
      }),
      assistant([
        {
          type: "text",
          text: "<task-notification><task-id>b1</task-id><status>completed</status>",
        },
      ]),
    ].join("\n")
    expect(factsOf(text).tasks).toEqual({})
  })
})

describe("shownTasks", () => {
  const now = Date.parse("2026-10-06T13:00:00.000Z")
  const task = (
    id: string,
    state: SessionTask["state"],
    startedAt: string,
    endedAt: string | null = null,
    fields: Partial<SessionTask> = {},
  ): SessionTask => ({
    endedAt,
    id,
    kind: "process",
    label: id,
    startedAt,
    state,
    taskId: null,
    ...fields,
  })
  const agent = { kind: "agent" } as const

  test("running first, then subagents that ended in the last half hour, newest first", () => {
    const tasks = {
      a: task("a", "done", "2026-10-06T12:00:00.000Z", "2026-10-06T12:10:00.000Z", agent),
      b: task("b", "done", "2026-10-06T12:40:00.000Z", "2026-10-06T12:45:00.000Z", agent),
      c: task("c", "running", "2026-10-06T10:00:00.000Z"),
      d: task("d", "running", "2026-10-06T12:50:00.000Z", null, agent),
    }
    expect(shownTasks(tasks, now).map((t) => t.id)).toEqual(["d", "c", "b"])
  })

  test("a process lists only while it runs: one that exited, failed or was stopped leaves at once", () => {
    const ended = "2026-10-06T12:59:00.000Z"
    const tasks = {
      done: task("done", "done", "2026-10-06T12:50:00.000Z", ended),
      failed: task("failed", "failed", "2026-10-06T12:50:00.000Z", ended),
      running: task("running", "running", "2026-10-06T12:00:00.000Z"),
      stopped: task("stopped", "stopped", "2026-10-06T12:50:00.000Z", ended),
    }
    expect(shownTasks(tasks, now).map((t) => t.id)).toEqual(["running"])
  })

  test("a session whose processes have all ended lists none, so its row has no chevron", () => {
    const tasks = {
      done: task("done", "done", "2026-10-06T12:50:00.000Z", "2026-10-06T12:59:00.000Z"),
      stopped: task("stopped", "stopped", "2026-10-06T12:50:00.000Z", "2026-10-06T12:59:00.000Z"),
    }
    expect(shownTasks(tasks, now)).toEqual([])
  })

  test("three restarts of one job make one row, the newest, while the same command in another checkout keeps its own", () => {
    const job = { job: "/repo\nbun run sweep", label: "bun run sweep" }
    const tasks = {
      r1: task("r1", "running", "2026-10-06T12:10:00.000Z", null, job),
      r2: task("r2", "running", "2026-10-06T12:20:00.000Z", null, job),
      r3: task("r3", "running", "2026-10-06T12:30:00.000Z", null, job),
      x: task("x", "running", "2026-10-06T12:05:00.000Z", null, {
        job: "/other\nbun run sweep",
        label: "bun run sweep",
      }),
    }
    expect(shownTasks(tasks, now).map((t) => t.id)).toEqual(["r3", "x"])
  })

  test("at most twelve", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `t${i}`,
        task(`t${i}`, "running", `2026-10-06T12:${String(i).padStart(2, "0")}:00.000Z`),
      ]),
    )
    expect(shownTasks(many, now)).toHaveLength(12)
  })
})
