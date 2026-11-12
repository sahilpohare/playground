import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MAX_ATTACHMENTS,
  withAttachments,
  type Attachment,
} from "../../../../../../api/hono/src/lib/dashboard/attachments"
import {
  deliver,
  holdsMessage,
  inputState,
  MAX_CHARS,
  MAX_LINES,
  normalize,
  QUEUED_MS,
  readSkills,
  refusal,
  SETTLE_GAP_MS,
  SETTLE_READS,
  skillCommand,
  skillDirs,
  type DeliverDeps,
} from "../../../../../../api/hono/src/lib/dashboard/deliver"
import {
  HerdrDown,
  HerdrRefused,
  HerdrTimedOut,
} from "../../../../../../api/hono/src/lib/dashboard/herdr"
import {
  clip,
  TEXT_LIMIT,
  type Entry,
} from "../../../../../../api/hono/src/lib/dashboard/transcript"
import type { Live, Worker } from "../../../../../../api/hono/src/lib/dashboard/workers"
import {
  MESSAGE_MAX_CHARS,
  MESSAGE_MAX_LINES,
  pastedFile,
} from "../../../../../../web/next/src/lib/paste"
import { LEADING_SKILL } from "../../../../../../web/next/src/lib/skill-menu"
import { NORMALIZE_CASES } from "../../../../../dashboard-normalize-cases"

const SURFACE = "herdr:factory:w2:p1"

const worker = (over: Partial<Worker> = {}): Worker => ({
  cwd: "/repo",
  effort: null,
  eta: null,
  failed: false,
  feed: [],
  lastActiveAt: null,
  lifecycle: "idle",
  light: "idle",
  model: null,
  name: "dispatcher",
  questions: [],
  role: "dispatcher",
  sessionId: "s-dispatcher",
  startedAt: null,
  task: null,
  tasks: [],
  title: null,
  updatedAt: null,
  workspace: null,
  ...over,
})

const live = (workers: Worker[], surfaces: Record<string, string> = {}): Live => ({
  surfaces: new Map(Object.entries(surfaces)),
  transcripts: new Map(),
  workers,
})

// A Claude Code screen's last lines as the screen read gives them, measured on a probe session: the input box between the rule carrying the session's name and a plain rule, then the status lines.
const RULE = "─".repeat(40)
const screen = (...box: string[]) =>
  [
    "✻ Crystallizing…",
    "",
    `${"─".repeat(30)} dispatcher ─`,
    ...box,
    RULE,
    "  ⚡ $1.1k/d · 📂 dispatcher",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n")
const EMPTY = screen("❯")
// The same in an 18-column herdr pane, its shape as a live dispatcher pane drew it: a rule as wide as the pane, and status lines cut at its edge.
const narrow = (...box: string[]) =>
  [
    "  ⎿  $ cd ~/some",
    "     /folder",
    "",
    `${"─".repeat(7)} dispatcher ─`,
    ...box,
    "─".repeat(18),
    "  ⚡ $1.1k/d · …",
    "  💡 Opus 5.5 h…",
  ].join("\n")
const NBSP = " "
// A person's message an hour before any paste here, so a transcript read reaches back past each one
const OLDER: Entry = {
  at: "2026-10-06T11:00:00.000Z",
  from: null,
  id: "e0",
  kind: "human",
  text: "earlier",
  tool: null,
}

// A person's line as Claude Code writes it for each prompt it takes, so a send whose box reads empty at once is shown to have gone.
const tookLine = (text: string, at: Date, n: number): Entry => ({
  at: at.toISOString(),
  from: null,
  id: `took-${n}`,
  kind: "human",
  text,
  tool: null,
})

// A fake herdr pane and activity table: each message as it went, whole, as one prompt to the pane it went to, and what was recorded, in order. `failOn` refuses a send as herdr does before sending anything.
function fakes(board: Live, failOn?: (text: string, index: number) => boolean) {
  const typed: { surface: string; text: string }[] = []
  const wrote: Entry[] = []
  const took = (text: string) => void wrote.push(tookLine(text, deps.now(), wrote.length))
  const recorded: string[] = []
  const rows = new Map<string, Date>()
  const skillsRead: string[] = []
  const deps: DeliverDeps = {
    board: async () => board,
    delivered: async (id) => rows.get(id) ?? null,
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    pressEnter: async () => {},
    prompt: async (surface, text) => {
      if (failOn?.(text, typed.length)) throw new Error("no such pane")
      typed.push({ surface, text })
      took(text)
    },
    readScreen: async () => EMPTY,
    readSession: async () => board,
    record: async (event, typing) => {
      recorded.push(event.summary)
      await typing()
      if (event.id) rows.set(event.id, deps.now())
    },
    said: async () => [OLDER, ...wrote],
    skills: async (cwd) => {
      skillsRead.push(cwd)
      return new Set(["end-of-day", "acme"])
    },
    wait: async () => {},
  }
  return { deps, recorded, skillsRead, took, typed }
}

const actor = { email: "owner@local.host", id: "u-1" }
const board = () => live([worker()], { "s-dispatcher": SURFACE })

describe("normalize", () => {
  test("line ends become \\n, tabs four spaces, every control character goes (C0, DEL, C1), and the ends are trimmed", () => {
    for (const [input, typed] of NORMALIZE_CASES) expect(normalize(input)).toBe(typed)
  })
})

describe("refusal", () => {
  test("text the dashboard will not type", () => {
    expect(refusal("")).toMatchObject({ code: "EMPTY", ok: false })
    expect(refusal("x".repeat(MAX_CHARS + 1))).toMatchObject({ code: "TOO_LONG" })
    expect(
      refusal(
        Array(MAX_LINES + 1)
          .fill("x")
          .join("\n"),
      ),
    ).toMatchObject({ code: "TOO_LONG" })
    expect(refusal("/clear")).toMatchObject({ code: "COMMAND" })
    expect(refusal("!rm -rf build")).toMatchObject({ code: "COMMAND" })
    expect(refusal("!rm -rf build")?.reason).toContain(
      "Type a ! command in the dispatcher's terminal window.",
    )
  })

  test("the composer's paste rule holds the same caps, so a long paste goes as a file and his words alone are judged", () => {
    expect([MESSAGE_MAX_CHARS, MESSAGE_MAX_LINES]).toEqual([MAX_CHARS, MAX_LINES])
    const pasted = "Made-up meeting notes. ".repeat(700)
    expect(refusal(normalize(`Summarise this:\n${pasted}`))).toMatchObject({ code: "TOO_LONG" })
    expect(pastedFile(pasted, "Summarise this:\n")).not.toBeNull()
    expect(refusal(normalize("Summarise this:\n"), 1)).toBeNull()
    expect(refusal("", 1)).toBeNull()
  })

  test("the paste rule fills the box to deliver()'s cap, with five files beside the words", () => {
    // what deliver() would be asked to send: the words as typed and five files, whose Attached lines no cap counts
    const fits = (pasted: string, before: string, after: string) =>
      !refusal(normalize(`${before}${pasted}${after}`), MAX_ATTACHMENTS)
    const typed = "Made-up meeting notes. ".repeat(400).slice(0, 7100)
    for (const [pasted, words, asFile, after = ""] of [
      ["x".repeat(995), typed, true],
      ["x".repeat(1000), typed.slice(0, 7000), false],
      ["x".repeat(1000), typed.slice(0, 7001), true],
      // lone carriage returns are line ends
      [Array(MAX_LINES).fill("z").join("\r"), "", false],
      [
        Array(MAX_LINES + 1)
          .fill("z")
          .join("\r"),
        "",
        true,
      ],
      // a paste ending in \r beside a box line starting with \n is two line ends
      [
        `${Array(MAX_LINES - 1)
          .fill("z")
          .join("\n")}\r`,
        "",
        true,
        "\nz",
      ],
    ] as const) {
      expect(pastedFile(pasted, words, after) !== null).toBe(asFile)
      if (!asFile) expect(fits(pasted, words, after)).toBe(true)
    }
  })

  test("a command behind invisible characters is still a command", () => {
    for (const text of ["\u200B/exit", "\u2060!rm -rf x", "\uFEFF\u200B /clear", "\u00A0!ls"]) {
      expect(refusal(normalize(text))).toMatchObject({ code: "COMMAND" })
    }
    expect(refusal(normalize("\u0085/exit"))).toMatchObject({ code: "COMMAND" })
  })

  test("everything else goes, a leading # or @ and a / mid-text included", () => {
    for (const text of ["# heading", "@greed look", "run /acme MADECEDAR-1 next", "a\n/b"]) {
      expect(refusal(text)).toBeNull()
    }
  })
})

describe("readSkills", () => {
  const skill = async (dir: string, name: string, front: string | null) => {
    await mkdir(join(dir, name), { recursive: true })
    const text = front === null ? "no frontmatter" : `---\n${front}\n---\nBody\n`
    await writeFile(join(dir, name, "SKILL.md"), text)
  }

  test("every skill folder whose SKILL.md a person may invoke, across the folders given", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-"))
    const user = join(root, "user")
    const project = join(root, "project")
    const elsewhere = join(root, "checkout")
    await skill(user, "end-of-day", "name: end-of-day\ndescription: lines")
    await skill(user, "linear-scan", "name: linear-scan\nuser-invocable: false")
    await skill(user, "broken", "name: [unclosed")
    await skill(user, "bare", null)
    await skill(user, "dotted.name", "name: dotted")
    await skill(user, "Upper", "name: Upper")
    await skill(elsewhere, "linked", "name: linked")
    await symlink(join(elsewhere, "linked"), join(user, "linked"))
    await mkdir(join(user, "folder-not-file", "SKILL.md"), { recursive: true })
    await skill(project, "codebase-map", "name: codebase-map\nuser-invocable: true")
    expect([...(await readSkills([user, project, join(root, "missing")]))].sort()).toEqual([
      "codebase-map",
      "end-of-day",
      "linked",
    ])
  })
})

describe("the composer's copy of a skill's command", () => {
  test("reads the same leading skill as skillCommand, so the / menu and the send check agree", () => {
    for (const text of [
      "/a",
      "/a b",
      "/a\nb",
      "/a/b",
      "/A",
      "/-a",
      "/a-b c",
      " /a",
      "/a\tb",
      "a /b",
    ]) {
      expect(LEADING_SKILL.exec(text)?.[0].trimEnd().slice(1) ?? null).toBe(skillCommand(text))
    }
  })
})

describe("skillDirs", () => {
  test("the config folder's skills, and the project's only for a session whose cwd is known", () => {
    expect(skillDirs("/work/app", "/home/.claude", true)).toEqual([
      "/home/.claude/skills",
      "/work/app/.claude/skills",
    ])
    for (const cwd of ["", "relative/app"]) {
      expect(skillDirs(cwd, "/home/.claude", true)).toEqual(["/home/.claude/skills"])
    }
  })

  test("a stack that does not read this machine never reads a session's cwd, which a fixture made up", () => {
    expect(skillDirs("/work/app", "/fixture/claude", false)).toEqual(["/fixture/claude/skills"])
  })
})

describe("holdsMessage", () => {
  test("the box starts as the message does, cut at the screen's edge, or as the fold of a paste or an image", () => {
    const text = "Is send on the right? why\n\nAttached: /x/a.png"
    expect(holdsMessage(screen("❯ Is send on the right? why"), text)).toBe(true)
    expect(holdsMessage(screen("❯ Is send on the ri"), text)).toBe(true)
    expect(holdsMessage(screen("❯ [Pasted text #1 +3 lines]"), text)).toBe(true)
    expect(holdsMessage(screen("❯ [Image #1] Is send"), text)).toBe(true)
    expect(holdsMessage(screen("❯ something else"), text)).toBe(false)
    expect(holdsMessage(EMPTY, text)).toBe(false)
    expect(holdsMessage("no box at all", text)).toBe(false)
  })

  test("a fold wrapped onto a second line in a narrow pane still reads as the paste", () => {
    expect(holdsMessage(narrow("❯ [Pasted text", "  #1 +12 lines]"), "a\nb\nc")).toBe(true)
    expect(holdsMessage(narrow("❯ [Image #1][Pas", "  ted text #2]"), "a")).toBe(true)
  })
})

describe("inputState", () => {
  test("an input holding only its prompt is empty, busy or not", () => {
    expect(inputState(EMPTY)).toBe("empty")
    expect(inputState(`${EMPTY}\n\n`)).toBe("empty")
  })

  // A busy session shows this hint while a message waits in its queue: a second message joins the queue rather than waiting for the turn to end.
  test("an input showing only the queued-messages hint is empty", () => {
    expect(inputState(screen("❯\u00a0Press up to edit queued messages"))).toBe("empty")
    expect(inputState(screen("❯\u00a0Press up to edit queued"))).toBe("holds")
    expect(inputState(screen("❯\u00a0Press up to edit queued messages", "  more"))).toBe("holds")
  })

  // a busy probe's own screen (Claude Code 2.1.309 in herdr) with two dashboard messages and a peer message in its queue, which it draws above the box, never in it.
  const PROBE_QUEUED = [
    "  ⎿  $ sleep 540 (1m 58s)",
    "     (ctrl+b to run in background)",
    "❯ first queued probe message",
    "❯ second queued probe message",
    "› Message from @worker: third message, sent as a peer message while",
    "you sleep: answer ok after your sleep. (ctrl+o to expand)",
    "  ctrl+enter to send now",
    "✢ Meandering… (2m 4s · ↓ 328 tokens)",
    `  ⎿${NBSP}Tip: Use /btw to ask a quick side question without interrupting`,
    "     Claude's current work",
    `${"─".repeat(60)} probe-queue ─`,
    `❯${NBSP}Press up to edit queued messages`,
    "─".repeat(74),
    "  ⚡ $1.7k/d · 📂 dispatcher · 🌱 main · 💾 5%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n")

  test("a busy session with messages in its queue reads empty, as the probe's screen shows it", () => {
    expect(inputState(PROBE_QUEUED)).toBe("empty")
  })

  // Claude Code's queue hints (its prompt input's placeholder while messages wait), each drawn alone in an empty box, wrapped onto a second line in a narrow pane, and read with a no-break space or a plain one after the ❯.
  test("every queue hint Claude Code draws reads empty, wrapped or not, after either space", () => {
    for (const hint of [
      "Press up to edit queued messages",
      "Press up to edit queued messages, Enter to send them immediately",
      "Press up to select a queued message to edit, or Enter to send them now",
      "Press up to select a queued message, then Enter to edit it",
    ]) {
      expect(inputState(screen(`❯${NBSP}${hint}`))).toBe("empty")
      expect(inputState(screen(`❯ ${hint}`))).toBe("empty")
    }
    expect(
      inputState(screen("❯ Press up to edit queued messages, Enter to send", "  them immediately")),
    ).toBe("empty")
  })

  // a pane narrower than the hint cuts it off with an ellipsis, as the 18-column dispatcher pane drew it after every send to it while busy
  test("a queue hint cut off at a narrow pane's edge reads empty", () => {
    expect(inputState(narrow("❯ Press up to edi…"))).toBe("empty")
    expect(inputState(narrow(`❯${NBSP}Press up to select a…`))).toBe("empty")
    expect(inputState(narrow("❯ Press up to see…"))).toBe("holds")
    expect(inputState(narrow("❯ Press up to edi…", "  more"))).toBe("holds")
    expect(inputState(narrow("❯ …"))).toBe("holds")
  })

  test("a hand-typed draft holds, even one that starts as a queue hint does", () => {
    expect(inputState(screen("❯ Press up to see more"))).toBe("holds")
    expect(inputState(screen("❯ Press up to edit queued messages please"))).toBe("holds")
    expect(inputState(screen("❯ Press up to edit queued messages", "  and then stop"))).toBe(
      "holds",
    )
    // the owner pressed up in the terminal and is editing a queued message
    expect(
      inputState(screen("❯ Press Enter to edit the selected message, or up again for history")),
    ).toBe("holds")
  })

  // A prompt suggestion is the dim text Claude Code fills an empty box with after a turn: the screen read drops the dimming, so it reads like a draft and the dashboard refuses the send rather than typing over it. Factory sessions start with suggestions off (scripts/factory-settings.json), so this is the shape a session with them on still shows.
  test("an input holding only a prompt suggestion holds something", () => {
    expect(inputState(screen('❯ Try "run the suite"'))).toBe("holds")
    expect(inputState(screen('❯\u00a0Try "run the suite"'))).toBe("holds")
  })

  test("a draft, shell mode, an open / menu or two lines of input hold something", () => {
    expect(inputState(screen("❯\u00a0a draft left here"))).toBe("holds")
    expect(inputState(screen("!"))).toBe("holds")
    expect(inputState(screen("❯\u00a0/"))).toBe("holds")
    expect(inputState(screen("❯\u00a0line one", "  line two"))).toBe("holds")
  })

  test("a picker between rules holds something, and a screen with no rules has no input box", () => {
    const picker = [
      RULE,
      " ☐ Color",
      "Pick a color?",
      "❯ 1. Red",
      "  2. Blue",
      RULE,
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n")
    expect(inputState(picker)).toBe("holds")
    expect(inputState("")).toBe("missing")
    expect(inputState("❯")).toBe("missing")
    expect(inputState(`${RULE}\n❯`)).toBe("missing")
  })
})

describe("deliver", () => {
  test("sends the message whole to the named session's own pane and records its size, not its words", async () => {
    const { deps, recorded, typed } = fakes(board())
    const result = await deliver(
      { actor, text: "check the queue\nthen stop", to: "dispatcher" },
      deps,
    )
    expect(result).toEqual({ at: "2026-10-06T12:00:00.000Z", ok: true, sessionId: "s-dispatcher" })
    expect(typed).toEqual([{ surface: SURFACE, text: "check the queue\nthen stop" }])
    expect(recorded).toEqual(["Sent dispatcher a message of 25 characters on 2 lines"])
    expect(recorded[0]).not.toContain("queue")
  })

  test("a busy session takes the message: it queues as typed input does", async () => {
    const { deps, typed } = fakes(
      live([worker({ lifecycle: "running", light: "working" })], { "s-dispatcher": SURFACE }),
    )
    expect((await deliver({ actor, text: "next", to: "dispatcher" }, deps)).ok).toBe(true)
    expect(typed).toHaveLength(1)
  })

  test("two live sessions named for the dispatcher: the oldest keeps the role and takes the send, with no 409", async () => {
    const { deps, typed } = fakes(
      live(
        [
          // the read's own rule has already demoted the newer one to other (workers.ts)
          worker({ role: "other", sessionId: "s-new", startedAt: "2026-10-06T13:00:00.000Z" }),
          worker({ startedAt: "2026-10-06T09:00:00.000Z" }),
        ],
        { "s-dispatcher": SURFACE, "s-new": "herdr:factory:w3:p1" },
      ),
    )
    expect((await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).ok).toBe(true)
    expect(typed).toEqual([{ surface: SURFACE, text: "hi" }])
  })

  // #i520: the second dispatcher is a target as the primary is, its name reaching the session that holds its role
  test("the second dispatcher takes the send into its own pane, and of two by its name the one holding the role does", async () => {
    const { deps, typed } = fakes(
      live(
        [
          worker(),
          worker({ name: "dispatcher-2", role: "other", sessionId: "s-glm-new" }),
          worker({ name: "dispatcher-2", sessionId: "s-glm" }),
        ],
        {
          "s-glm": "herdr:factory:w4:p1",
          "s-glm-new": "herdr:factory:w3:p1",
          "s-dispatcher": SURFACE,
        },
      ),
    )
    expect(await deliver({ actor, text: "hi", to: "dispatcher-2" }, deps)).toMatchObject({
      ok: true,
      sessionId: "s-glm",
    })
    expect(typed).toEqual([{ surface: "herdr:factory:w4:p1", text: "hi" }])
  })

  test("two live sessions sharing another name still refuse as ambiguous", async () => {
    const { deps, typed } = fakes(
      live(
        [
          worker({ name: "worker-x", role: "worker" }),
          worker({ name: "worker-x", role: "worker", sessionId: "s-two" }),
        ],
        { "s-dispatcher": SURFACE },
      ),
    )
    expect(await deliver({ actor, text: "hi", to: "worker-x" }, deps)).toMatchObject({
      code: "AMBIGUOUS",
      ok: false,
    })
    expect(typed).toEqual([])
  })

  test("refuses, typing nothing and recording nothing, when it cannot tell the right session or it is on a picker", async () => {
    const cases: [Live, string][] = [
      [live([], {}), "NOT_FOUND"],
      [
        live([worker({ light: "needs-you", lifecycle: "needsInput" })], {
          "s-dispatcher": SURFACE,
        }),
        "ON_PICKER",
      ],
      [live([worker()], {}), "NOT_FOUND"],
    ]
    for (const [state, code] of cases) {
      const { deps, recorded, typed } = fakes(state)
      expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
        code,
        ok: false,
      })
      expect(typed).toEqual([])
      expect(recorded).toEqual([])
    }
  })

  test("a read cut short that misses the session is read once more, and still missing it is a failed read, never NOT_FOUND (PG-880)", async () => {
    const cut: Live = { ...live([], {}), partial: true }
    const { deps, recorded, typed } = fakes(cut)
    let reads = 0
    deps.board = async () => (reads++, cut)
    const refused = await deliver({ actor, text: "hi", to: "dispatcher" }, deps)
    expect(refused).toMatchObject({ code: "SESSIONS_FAILED", ok: false })
    expect(refused.ok ? "" : refused.reason).not.toContain("No live session is named")
    expect(reads).toBe(2)
    expect(typed).toEqual([])
    expect(recorded).toEqual([])

    const second = fakes(board())
    const reads2: Live[] = [cut, board()]
    second.deps.board = async () => reads2.shift() ?? board()
    expect(await deliver({ actor, text: "hi", to: "dispatcher" }, second.deps)).toMatchObject({
      ok: true,
    })
  })

  test("refuses to type into an input that already holds something, which the message would join", async () => {
    for (const box of ["❯\u00a0a draft", "!", "❯\u00a0/"]) {
      const { deps, recorded, typed } = fakes(board())
      deps.readScreen = async () => screen(box)
      expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
        code: "INPUT_NOT_EMPTY",
        ok: false,
      })
      expect(typed).toEqual([])
      expect(recorded).toEqual([])
    }
  })

  test("a screen with no input box is refused with its own reason, so a changed layout shows", async () => {
    const { deps, typed } = fakes(board())
    deps.readScreen = async () => "a dialog with no rules"
    const result = await deliver({ actor, text: "hi", to: "dispatcher" }, deps)
    expect(result).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
    expect(result.ok ? "" : result.reason).toContain("Cannot find dispatcher's input box")
    expect(typed).toEqual([])
  })

  test("refuses text it will not type before it reads the board", async () => {
    const { deps, typed } = fakes(board())
    deps.board = async () => {
      throw new Error("must not be read")
    }
    deps.readSession = deps.board
    for (const [text, code] of [
      ["   ", "EMPTY"],
      ["!ls", "COMMAND"],
      ["\u200B/end-of-day", "COMMAND"],
    ]) {
      expect(await deliver({ actor, text: text!, to: "dispatcher" }, deps)).toMatchObject({ code })
    }
    expect(typed).toEqual([])
  })

  test("a / and the name of a skill the session can run is sent, as the owner would type it", async () => {
    const { deps, skillsRead, typed } = fakes(
      live([worker({ cwd: "/work/dispatcher" })], { "s-dispatcher": SURFACE }),
    )
    expect(
      await deliver({ actor, text: "/end-of-day for me", to: "dispatcher" }, deps),
    ).toMatchObject({
      ok: true,
    })
    expect(skillsRead).toEqual(["/work/dispatcher"])
    expect(typed).toEqual([{ surface: SURFACE, text: "/end-of-day for me" }])
  })

  test("any other / is refused once the session's skills are read: a built-in, an unknown name, a lookalike", async () => {
    for (const text of [
      "/clear",
      "/exit",
      "/model opus",
      "/nope",
      "/End-of-day",
      "/light\u200Bday",
      "/end-of-day\u200B now",
      "/end-of-day/../x",
      "/end-of-day.md",
      "/end-of-day:x",
    ]) {
      const { deps, recorded, typed } = fakes(board())
      expect(await deliver({ actor, text, to: "dispatcher" }, deps)).toMatchObject({
        code: "COMMAND",
        ok: false,
      })
      expect(typed).toEqual([])
      expect(recorded).toEqual([])
    }
  })

  test("a ! is a shell command, refused even when a skill bears the name", async () => {
    const { deps, typed } = fakes(board())
    expect(await deliver({ actor, text: "!end-of-day", to: "dispatcher" }, deps)).toMatchObject({
      code: "COMMAND",
    })
    expect(typed).toEqual([])
  })

  test("a board that cannot be read is SESSIONS_FAILED, with the read's own words", async () => {
    const { deps } = fakes(live([]))
    deps.board = async () => {
      throw new Error("Access denied")
    }
    const result = await deliver({ actor, text: "hi", to: "dispatcher" }, deps)
    expect(result).toMatchObject({ code: "SESSIONS_FAILED" })
    expect(result.ok ? "" : result.reason).toBe("Could not read the sessions: Access denied")
  })

  test("a record that cannot be inserted throws, and nothing is typed", async () => {
    const { deps, typed } = fakes(board())
    deps.record = async () => {
      throw new Error("database down")
    }
    await expect(deliver({ actor, text: "hi", to: "dispatcher" }, deps)).rejects.toThrow(
      "database down",
    )
    expect(typed).toEqual([])
  })

  test("a commit that fails after the Enter throws although the message went: the contract says so", async () => {
    const { deps, typed } = fakes(board())
    deps.record = async (_, typing) => {
      await typing()
      throw new Error("commit failed")
    }
    await expect(deliver({ actor, text: "hi", to: "dispatcher" }, deps)).rejects.toThrow(
      "commit failed",
    )
    expect(typed.map((sent) => sent.text)).toEqual(["hi"])
  })

  // deliver logs every failed try; a test that expects one listens, the rest stay quiet.
  const logged = async (run: (warn: ReturnType<typeof spyOn>) => Promise<void>) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await run(warn)
    } finally {
      warn.mockRestore()
    }
  }

  test("the second try reads the screen again, so text that landed after all refuses it rather than joining it", async () => {
    const { deps, typed } = fakes(board())
    const screens = [EMPTY, screen("❯ hello")]
    deps.readScreen = async () => screens.shift() ?? EMPTY
    deps.prompt = async () => {
      throw new Error("no such pane")
    }
    await logged(async () => {
      expect(await deliver({ actor, text: "hello", to: "dispatcher" }, deps)).toMatchObject({
        code: "INPUT_NOT_EMPTY",
        ok: false,
      })
      expect(typed).toEqual([])
    })
  })

  test("a queued delivery reads the session when its turn comes: a picker the first one raised refuses the second", async () => {
    let state = board()
    const typed: string[] = []
    const deps: DeliverDeps = {
      board: async () => state,
      delivered: async () => null,
      now: () => new Date(),
      pressEnter: async () => {},
      prompt: async (_, text) => {
        await Bun.sleep(1)
        typed.push(text)
        // The first message makes the session ask the owner something.
        state = live([worker({ light: "needs-you" })], { "s-dispatcher": SURFACE })
      },
      readScreen: async () => EMPTY,
      readSession: async () => state,
      record: async (_, typing) => typing(),
      said: async () => [OLDER],
      skills: async () => new Set(),
      wait: async () => {},
    }
    const [first, second] = await Promise.all([
      deliver({ actor, text: "first", to: "dispatcher" }, deps),
      deliver({ actor, text: "second", to: "dispatcher" }, deps),
    ])
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ code: "ON_PICKER", ok: false })
    expect(typed).toEqual(["first"])
  })

  // A fake pane that takes each message whole a moment after it is sent, and refuses `failOn` before sending anything.
  function terminal(failOn?: string) {
    const typed: string[] = []
    const rows = new Map<string, Date>()
    const deps: DeliverDeps = {
      board: async () => board(),
      delivered: async (id) => rows.get(id) ?? null,
      now: () => new Date(),
      pressEnter: async () => {},
      prompt: async (_, text) => {
        await Bun.sleep(1)
        if (text === failOn) throw new Error("no such pane")
        typed.push(text)
      },
      readScreen: async () => EMPTY,
      readSession: async () => board(),
      record: async (event, typing) => {
        await typing()
        if (event.id) rows.set(event.id, new Date())
      },
      said: async () => [OLDER, ...typed.map((text, n) => tookLine(text, new Date(), n))],
      skills: async () => new Set(),
      wait: async () => {},
    }
    return { deps, typed }
  }

  test("two deliveries to one session type one after the other, never interleaved", async () => {
    const { deps, typed } = terminal()
    await Promise.all([
      deliver({ actor, text: "a1\na2", to: "dispatcher" }, deps),
      deliver({ actor, text: "b1\nb2", to: "dispatcher" }, deps),
    ])
    expect(typed).toEqual(["a1\na2", "b1\nb2"])
  })

  // A retry of a request whose answer was lost, as when the dashboard restarts: the row its first try committed answers it.
  test("a message already recorded under its id is answered as delivered, not typed again", async () => {
    const { deps, typed } = terminal()
    const id = "7d0c6a8e-1f2b-4c3d-9e4f-5a6b7c8d9e0f"
    const first = await deliver({ actor, id, text: "once", to: "dispatcher" }, deps)
    const again = await deliver({ actor, id, text: "once", to: "dispatcher" }, deps)
    expect(first.ok).toBe(true)
    expect(again).toMatchObject({ ok: true, sessionId: "s-dispatcher" })
    expect(typed).toEqual(["once"])
  })

  // The session may answer the message with a picker before the retry arrives: the row still answers it, while a fresh send is refused.
  test("a recorded message is answered as delivered even with its session now on a picker", async () => {
    const { deps, typed } = fakes(board())
    const id = "7d0c6a8e-1f2b-4c3d-9e4f-5a6b7c8d9e0f"
    expect((await deliver({ actor, id, text: "once", to: "dispatcher" }, deps)).ok).toBe(true)
    deps.board = async () => live([worker({ light: "needs-you" })], { "s-dispatcher": SURFACE })
    expect(await deliver({ actor, id, text: "once", to: "dispatcher" }, deps)).toMatchObject({
      ok: true,
      sessionId: "s-dispatcher",
    })
    expect(await deliver({ actor, text: "fresh", to: "dispatcher" }, deps)).toMatchObject({
      code: "ON_PICKER",
    })
    expect(typed).toHaveLength(1)
  })

  // Two live sessions named for the dispatcher: the retry finds the one holding the role, as a send does, so its row still answers it.
  test("with two sessions by the dispatcher's name, a retry to it on a picker reads its recorded time", async () => {
    const { deps, typed } = fakes(board())
    const id = "7d0c6a8e-1f2b-4c3d-9e4f-5a6b7c8d9e0f"
    expect((await deliver({ actor, id, text: "once", to: "dispatcher" }, deps)).ok).toBe(true)
    deps.board = async () =>
      live(
        [
          // the read's own rule has already demoted the newer one to other (workers.ts)
          worker({ light: "needs-you", role: "other", sessionId: "s-new" }),
          worker({ light: "needs-you" }),
        ],
        { "s-dispatcher": SURFACE, "s-new": "herdr:factory:w3:p1" },
      )
    expect(await deliver({ actor, id, text: "once", to: "dispatcher" }, deps)).toEqual({
      at: "2026-10-06T12:00:00.000Z",
      ok: true,
      replayed: true,
      sessionId: "s-dispatcher",
    })
    expect(typed).toHaveLength(1)
  })

  test("a retry that arrives while its first try still types waits for it, then is answered as delivered", async () => {
    const { deps, typed } = terminal()
    const id = "7d0c6a8e-1f2b-4c3d-9e4f-5a6b7c8d9e0f"
    const [first, again] = await Promise.all([
      deliver({ actor, id, text: "a1\na2", to: "dispatcher" }, deps),
      deliver({ actor, id, text: "a1\na2", to: "dispatcher" }, deps),
    ])
    expect(first.ok && again.ok).toBe(true)
    expect(typed).toEqual(["a1\na2"])
  })

  test("a first delivery that fails before typing does not block the second", async () => {
    const { deps, typed } = terminal("a1\na2")
    await logged(async () => {
      const [a, b] = await Promise.all([
        deliver({ actor, text: "a1\na2", to: "dispatcher" }, deps),
        deliver({ actor, text: "b1", to: "dispatcher" }, deps),
      ])
      expect(a).toMatchObject({ code: "SESSIONS_FAILED" })
      expect(b.ok).toBe(true)
      expect(typed).toEqual(["b1"])
    })
  })

  test("a name that moves to another session while its delivery waits is refused, not typed into the new one", async () => {
    const { deps, typed } = fakes(board())
    deps.readSession = async () =>
      live([worker({ sessionId: "s-renamed" })], { "s-renamed": SURFACE })
    expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
      code: "NOT_FOUND",
      ok: false,
    })
    expect(typed).toEqual([])
  })

  // A read of every session is slow on a busy machine, so the board finds the session, and only that session is read again.
  test("finds the session on the board once, then reads only that session: when its turn comes and before the send", async () => {
    const { deps } = fakes(board())
    const reads: string[] = []
    deps.board = async () => {
      reads.push("board")
      return board()
    }
    deps.readSession = async (found) => {
      reads.push(found.sessionId)
      return board()
    }
    expect((await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).ok).toBe(true)
    expect(reads).toEqual(["board", "s-dispatcher", "s-dispatcher"])
  })

  test("the session's own read decides over a board a moment old: ended, renamed or on a picker, nothing is typed", async () => {
    const cases: [Live, string][] = [
      [live([], {}), "NOT_FOUND"],
      [live([worker({ name: "dispatcher-2" })], { "s-dispatcher": SURFACE }), "NOT_FOUND"],
      [live([worker({ light: "needs-you" })], { "s-dispatcher": SURFACE }), "ON_PICKER"],
    ]
    for (const [own, code] of cases) {
      const { deps, recorded, typed } = fakes(board())
      deps.readSession = async () => own
      expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
        code,
        ok: false,
      })
      expect(typed).toEqual([])
      expect(recorded).toEqual([])
    }
  })

  test("a session's own read that does not answer is SESSIONS_FAILED, and nothing is typed", async () => {
    const { deps, typed } = fakes(board())
    deps.readSession = async () => {
      throw new Error("herdr did not answer")
    }
    const result = await deliver({ actor, text: "hi", to: "dispatcher" }, deps)
    expect(result).toMatchObject({ code: "SESSIONS_FAILED", ok: false })
    expect(result.ok ? "" : result.reason).toBe("Could not read the sessions: herdr did not answer")
    expect(typed).toEqual([])
  })
})

describe("deliver with attachments", () => {
  const DIR = "/home/x/.playground/attachments"
  const file = (name: string, size: number): Attachment => ({
    id: name,
    kind: name.endsWith(".png") ? "image" : "pdf",
    path: `${DIR}/${name}`,
    size,
  })
  const png = file("11111111-2222-4333-8444-555555555555.png", 300_000)
  const pdf = file("11111111-2222-4333-8444-666666666666.pdf", 1_100_000)

  test("each file's absolute path follows the words on a line of its own, and the record gives the files' count and size, never their names or paths", async () => {
    const { deps, recorded, typed } = fakes(board())
    const result = await deliver(
      { actor, attachments: [png, pdf], text: "look at these", to: "dispatcher" },
      deps,
    )
    expect(result.ok).toBe(true)
    expect(typed).toEqual([
      { surface: SURFACE, text: `look at these\n\nAttached: ${png.path}\nAttached: ${pdf.path}` },
    ])
    expect(recorded).toEqual([
      "Sent dispatcher a message of 13 characters with 2 attachments of 1.3 MB",
    ])
    expect(recorded[0]).not.toContain("1111")
    expect(recorded[0]).not.toContain(DIR)
  })

  test("files alone go, and the message starts with a word rather than a path", async () => {
    const { deps, recorded, typed } = fakes(board())
    expect(
      (await deliver({ actor, attachments: [png], text: "  ", to: "dispatcher" }, deps)).ok,
    ).toBe(true)
    expect(typed).toEqual([{ surface: SURFACE, text: `Attached: ${png.path}` }])
    expect(recorded).toEqual(["Sent dispatcher 1 attachment of 293 KB"])
  })

  test("a leading / or ! is still a command when files come with it, and nothing is typed", async () => {
    for (const text of ["/clear", "!ls", "\u200B/exit"]) {
      const { deps, recorded, typed } = fakes(board())
      expect(
        await deliver({ actor, attachments: [png], text, to: "dispatcher" }, deps),
      ).toMatchObject({ code: "COMMAND", ok: false })
      expect(typed).toEqual([])
      expect(recorded).toEqual([])
    }
  })

  test("a session on a picker, or an input holding a draft, refuses a message with files as it refuses words", async () => {
    const onPicker = fakes(live([worker({ light: "needs-you" })], { "s-dispatcher": SURFACE }))
    expect(
      await deliver({ actor, attachments: [png], text: "", to: "dispatcher" }, onPicker.deps),
    ).toMatchObject({ code: "ON_PICKER" })
    const drafted = fakes(board())
    drafted.deps.readScreen = async () => screen("❯ half a thought")
    expect(
      await deliver({ actor, attachments: [png], text: "hi", to: "dispatcher" }, drafted.deps),
    ).toMatchObject({ code: "INPUT_NOT_EMPTY" })
    expect([...onPicker.typed, ...drafted.typed]).toEqual([])
  })

  test("the caps count the person's words: the Attached lines come on top, so words that fit still go with their files", async () => {
    const long = fakes(board())
    expect(
      (
        await deliver(
          { actor, attachments: [png], text: "x".repeat(MAX_CHARS - 50), to: "dispatcher" },
          long.deps,
        )
      ).ok,
    ).toBe(true)
    const tall = fakes(board())
    const lines = Array(MAX_LINES).fill("x").join("\n")
    expect(
      (await deliver({ actor, attachments: [png, pdf], text: lines, to: "dispatcher" }, tall.deps))
        .ok,
    ).toBe(true)
    expect(tall.typed.at(-1)?.text).toEndWith(`Attached: ${pdf.path}`)
    const over = fakes(board())
    expect(
      await deliver(
        { actor, attachments: [png], text: "x".repeat(MAX_CHARS + 1), to: "dispatcher" },
        over.deps,
      ),
    ).toMatchObject({
      code: "TOO_LONG",
      reason: `A message holds at most ${MAX_CHARS} characters.`,
    })
  })

  test("a total just under a megabyte reads as one, not 1024 KB", async () => {
    const { deps, recorded } = fakes(board())
    await deliver(
      { actor, attachments: [file(png.id, 1_048_300)], text: "", to: "dispatcher" },
      deps,
    )
    expect(recorded).toEqual(["Sent dispatcher 1 attachment of 1.0 MB"])
  })

  test("more files than a message holds are refused", async () => {
    const { deps, typed } = fakes(board())
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => png)
    expect(
      await deliver({ actor, attachments: many, text: "hi", to: "dispatcher" }, deps),
    ).toMatchObject({ code: "TOO_LONG" })
    expect(typed).toEqual([])
  })
})

// deliver() types into a session's pane as if the owner typed it, so only the owner's own acts reach it, and nothing else speaks for the owner: the composer, the owner's answer to an inbox item or his comment through its Reply, and his answer to a card from WhatsApp, which ask whatsapp reads from ops-wa's own folder (ADR 0024). An ops job, a script or any other route sends through SendMessage instead.
const ROOT = join(import.meta.dir, "../../../../../..")
const DELIVER = "api/hono/src/lib/dashboard/deliver.ts"
const CALLERS = [
  "api/hono/src/bin/dashboard-ask.ts",
  "api/hono/src/routers/dashboard.ts",
  "api/hono/src/routers/inbox.ts",
]
const SOURCE = /\.(?:[cm]?[jt]sx?)$/
const DELIVER_MODULE = /["'][^"']*\/deliver(?:\.[cm]?[jt]sx?)?["']/
const DELIVER_STAR = /\*\s*(?:as\s+[\w$]+\s*)?from\s*["'][^"']*\/deliver(?:\.[cm]?[jt]sx?)?["']/
const SPECIFIER = /\bfrom\s*["'][^"']*["']|\bimport\s*\(\s*["'][^"']*["']\s*\)/g
const transpiler = new Bun.Transpiler({ deadCodeElimination: false, loader: "tsx" })

// Each source file, other than deliver.ts, that reaches deliver(): it names deliver beside a module ending in /deliver, or takes that module whole.
const deliverCallers = (files: Record<string, string>): string[] =>
  Object.entries(files)
    .filter(([path, source]) => {
      if (path === DELIVER) return false
      let code = source
      try {
        code = transpiler.transformSync(source)
      } catch {}
      if (!DELIVER_MODULE.test(code)) return false
      return /\bdeliver\b/.test(code.replace(SPECIFIER, "")) || DELIVER_STAR.test(code)
    })
    .map(([path]) => path)

describe("who calls deliver()", () => {
  test("only the composer's route, the inbox's, its answer and its Reply, and ask whatsapp", async () => {
    const listed = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: ROOT,
        stdin: "ignore",
      },
    )
    expect(listed.exitCode).toBe(0)
    const files: Record<string, string> = {}
    for (const path of listed.stdout.toString().split("\n")) {
      if (!SOURCE.test(path) || path.startsWith("tests/") || path.endsWith(".d.ts")) continue
      const file = Bun.file(join(ROOT, path))
      if (await file.exists()) files[path] = await file.text()
    }
    expect(Object.keys(files)).toContain(DELIVER)
    expect(deliverCallers(files).sort()).toEqual(CALLERS)
  })

  test("an import, a dynamic import or a star import of deliver counts; a sibling export or a comment does not", () => {
    const calling = {
      "dynamic.ts": 'const m = await import("@/lib/dashboard/deliver")\nawait m.deliver(d)',
      "named.ts": 'import { deliver } from "@/lib/dashboard/deliver"\nawait deliver(d)',
      "renamed.ts": 'import { deliver as send } from "../dashboard/deliver.ts"\nawait send(d)',
      "star.ts": 'import * as d from "@/lib/dashboard/deliver"\nawait d.deliver(x)',
    }
    const clear = {
      "comment.ts":
        '// deliver() in deliver.ts types it\nimport { normalize } from "@/lib/dashboard/deliver"\nnormalize("x")',
      "otherstar.ts":
        'import { normalize } from "@/lib/dashboard/deliver"\nimport * as z from "zod"\nnormalize(z.string().parse("x"))',
      [DELIVER]: "export async function deliver() {}",
    }
    expect(deliverCallers({ ...calling, ...clear }).sort()).toEqual(Object.keys(calling).sort())
  })
})

// The one route beside deliver()'s that types into a pane: a herdr prompt's answer, the owner's own Submit on its card, which answerFeed() hands to answerHerdr() past its guards: the same contract as deliver() for the composer. herdr.test.ts holds typeKeys() to feed.ts.
const HERDR_ANSWER_ROUTE = {
  file: "api/hono/src/routers/dashboard.ts",
  path: "/workers/:sessionId/feed/:requestId",
}

describe("the herdr answer route", () => {
  test("answerFeed() is reached from the dashboard router's feed route alone", async () => {
    const listed = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: ROOT, stdin: "ignore" },
    )
    expect(listed.exitCode).toBe(0)
    const callers: string[] = []
    for (const path of listed.stdout.toString().split("\n")) {
      if (
        !SOURCE.test(path) ||
        path.startsWith("tests/") ||
        path === "api/hono/src/lib/dashboard/feed.ts"
      )
        continue
      const file = Bun.file(join(ROOT, path))
      if (!(await file.exists())) continue
      let code = await file.text()
      try {
        code = transpiler.transformSync(code)
      } catch {}
      if (
        /["'][^"']*\/feed(?:\.[cm]?[jt]sx?)?["']/.test(code) &&
        /\banswerFeed\b/.test(code.replace(SPECIFIER, ""))
      )
        callers.push(path)
    }
    expect(callers).toEqual([HERDR_ANSWER_ROUTE.file])
    const router = await Bun.file(join(ROOT, HERDR_ANSWER_ROUTE.file)).text()
    expect(router).toContain(`"${HERDR_ANSWER_ROUTE.path}"`)
  })
})

describe("deliver to a herdr session", () => {
  const HERDR = "herdr:factory:w1:p1"
  // A herdr session's board and a terminal that takes its message as one agent.prompt, which `fail` refuses as herdr would; a test whose message is left unproven names a session of its own, since deliver() then holds that session's next message.
  function herdr(fail?: unknown, sessionId = "s-dispatcher") {
    const state = live([worker({ sessionId })], { [sessionId]: HERDR })
    const sent: { surface: string; text: string }[] = []
    const recorded: string[] = []
    const { deps, took } = fakes(state)
    // as the real record's transaction, a row stands only once the typing went whole
    deps.record = async (event, typing) => {
      await typing()
      recorded.push(event.summary)
    }
    // Claude Code writes a prompt's line once it takes it: the first read after the paste that shows the box empty, not holding it nor a queue hint, whatever screen a test sets
    const owed: string[] = []
    let read = deps.readScreen
    Object.defineProperty(deps, "readScreen", {
      get: () => async (surface: string) => {
        const shown = await read(surface)
        if (inputState(shown) === "empty" && !shown.includes("Press up to")) {
          for (const text of owed.splice(0)) took(text)
        }
        return shown
      },
      set: (next: DeliverDeps["readScreen"]) => {
        read = next
      },
    })
    // a paste a test names here Claude Code leaves in its box, its Enter lost, so it writes no line until a later Enter takes it (`took`)
    const stays = new Set<string>()
    deps.prompt = async (surface, text) => {
      if (fail) throw fail
      sent.push({ surface, text })
      if (!stays.has(text)) owed.push(text)
    }
    return { deps, recorded, sent, stays, took }
  }

  test("the whole message goes as one prompt to its pane, after the input box reads empty", async () => {
    const { deps, recorded, sent } = herdr()
    const read: string[] = []
    deps.readScreen = async (surface) => {
      read.push(surface)
      return EMPTY
    }
    const result = await deliver({ actor, text: "line one\nline two", to: "dispatcher" }, deps)
    expect(result).toMatchObject({ ok: true, sessionId: "s-dispatcher" })
    expect(sent).toEqual([{ surface: HERDR, text: "line one\nline two" }])
    // once before the send, and once after it to see the box empty
    expect(read).toEqual([HERDR, HERDR])
    expect(recorded).toHaveLength(1)
  })

  test("a setting types its one slash command, recorded whole, while the same words typed by hand stay refused", async () => {
    const { deps, recorded, sent } = herdr()
    deps.readScreen = async () => EMPTY
    const set = await deliver(
      { actor, setting: { model: "opus" }, text: "", to: "dispatcher" },
      deps,
    )
    expect(set).toMatchObject({ ok: true, sessionId: "s-dispatcher" })
    expect(sent).toEqual([{ surface: HERDR, text: "/model opus" }])
    expect(recorded).toEqual(["Set dispatcher's model to opus"])
    const typed = await deliver({ actor, text: "/model opus", to: "dispatcher" }, deps)
    expect(typed).toMatchObject({ code: "COMMAND", ok: false })
    expect(sent).toHaveLength(1)
  })

  // herdr pastes the message and then presses Enter, and the Enter can land while Claude Code is still taking a pasted image's path in, so the message sat unsent in dispatcher's box and every later delivery read it as a draft
  describe("the box read after the send", () => {
    const MESSAGE = "Is send on the right? why"
    const HELD = screen(`❯ ${MESSAGE}`)
    const NO_BOX = "a screen with no rules to frame a box"
    // the box empty before the send, then each read after it from `first` until an Enter, then from `second`, the last of each repeating; an Error read throws
    function after(
      first: (string | Error)[],
      second: (string | Error)[] = [EMPTY],
      fail?: unknown,
    ) {
      const run = herdr(fail)
      let reads = [EMPTY, ...first]
      const enters: string[] = []
      const waits: number[] = []
      let count = 0
      run.deps.readScreen = async () => {
        count += 1
        const read = reads.length > 1 ? reads.shift() : reads[0]
        if (read instanceof Error) throw read
        return read ?? EMPTY
      }
      run.deps.pressEnter = async (surface) => {
        enters.push(surface)
        reads = [...second]
      }
      run.deps.wait = async (ms) => {
        waits.push(ms)
      }
      const send = (id?: string) =>
        deliver({ actor, id, text: MESSAGE, to: "dispatcher" }, run.deps)
      return { ...run, enters, reads: () => count, send, waits }
    }

    test("a clean send finds the box empty after one gap, and presses nothing more", async () => {
      const { enters, reads, recorded, send, sent, waits } = after([EMPTY])
      expect(await send()).toMatchObject({ ok: true })
      expect(sent).toHaveLength(1)
      expect(enters).toEqual([])
      expect(reads()).toBe(2)
      expect(waits).toEqual([SETTLE_GAP_MS])
      expect(recorded).toHaveLength(1)
    })

    // Claude Code takes the Enter a frame or more after herdr sends it, so a box still drawn holding the message is read again before it gets an Enter
    test("a box that empties on its second read went, with no Enter", async () => {
      const { enters, reads, send } = after([HELD, EMPTY])
      expect(await send()).toMatchObject({ ok: true })
      expect(enters).toEqual([])
      expect(reads()).toBe(3)
    })

    // the frames a live 18-column pane drew: the paste wrapped, then, the session busy, the message queued and the queue hint cut off at the pane's edge until its turn ended
    test("a busy narrow pane that queues the message went, with no Enter", async () => {
      const { enters, recorded, send } = after([
        narrow("❯ Is send on the", "  right? why"),
        narrow("❯ Press up to edi…"),
      ])
      expect(await send()).toMatchObject({ ok: true })
      expect(enters).toEqual([])
      expect(recorded).toHaveLength(1)
    })

    test("a message whose Enter was lost gets one more Enter, and goes", async () => {
      const { enters, reads, send } = after([HELD], [HELD, EMPTY])
      expect(await send()).toMatchObject({ ok: true })
      expect(enters).toEqual([HERDR])
      expect(reads()).toBe(1 + SETTLE_READS + 2)
    })

    test("a box that never empties, after one more Enter, is typed but not submitted", async () => {
      const { enters, reads, recorded, send, waits } = after([HELD], [HELD])
      const result = await send()
      expect(result).toMatchObject({ code: "INTERRUPTED", ok: false })
      expect(result.ok ? "" : result.reason).toContain("typed but not submitted")
      expect(enters).toEqual([HERDR])
      expect(reads()).toBe(1 + 2 * SETTLE_READS)
      expect(waits).toEqual(Array(2 * SETTLE_READS).fill(SETTLE_GAP_MS))
      expect(recorded).toEqual([])
    })

    test("a box holding someone else's text gets no Enter, and reads interrupted", async () => {
      const { enters, recorded, send } = after([screen("❯ half a thought of his own")])
      expect(await send()).toMatchObject({ code: "INTERRUPTED", ok: false })
      expect(enters).toEqual([])
      expect(recorded).toEqual([])
    })

    test("a screen that frames no box after the send gets no Enter, and reads interrupted", async () => {
      const { enters, recorded, send } = after([NO_BOX])
      const result = await send()
      expect(result).toMatchObject({ code: "INTERRUPTED", ok: false })
      expect(result.ok ? "" : result.reason).toContain("Cannot find")
      expect(enters).toEqual([])
      expect(recorded).toEqual([])
    })

    test("a screen that cannot be read after the send, or an Enter herdr refuses, reads interrupted", async () => {
      const unread = after([new Error("pane gone")])
      expect(await unread.send()).toMatchObject({ code: "INTERRUPTED", ok: false })
      expect(unread.recorded).toEqual([])
      const refused = after([HELD])
      refused.deps.pressEnter = async () => {
        throw new Error("no such pane")
      }
      expect(await refused.send()).toMatchObject({ code: "INTERRUPTED", ok: false })
      expect(refused.recorded).toEqual([])
    })

    // an outbox message is retried on its own, so one left unsent in the box waits for its next try's Enter rather than failing in front of the owner
    test("a box that never empties, for a message with an id, is queued for another Enter, not failed", async () => {
      const { enters, recorded, send } = after([HELD], [HELD])
      const result = await send("11111111-2222-4333-8444-000000000001")
      expect(result).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false, pasted: true })
      expect(result.ok ? "" : result.reason).toContain("unsent")
      expect(enters).toEqual([HERDR])
      expect(recorded).toEqual([])
    })

    test("its retry presses Enter on the message in the box and pastes nothing again", async () => {
      const id = "11111111-2222-4333-8444-000000000002"
      const run = after([HELD], [HELD])
      expect(await run.send(id)).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      run.deps.readScreen = async () => (run.enters.length < 2 ? HELD : EMPTY)
      expect(await run.send(id)).toMatchObject({ ok: true })
      expect(run.sent).toHaveLength(1)
      expect(run.enters).toEqual([HERDR, HERDR])
      expect(run.recorded).toHaveLength(1)
    })

    // the owner pressed Enter in the terminal (03:13Z on 24 Oct), so the box is empty when the retry comes: typing it again would send it twice
    test("its retry after the message left the box by hand types nothing and reads it delivered", async () => {
      const id = "11111111-2222-4333-8444-000000000003"
      const run = after([HELD], [HELD])
      expect(await run.send(id)).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      run.deps.readScreen = async () => EMPTY
      expect(await run.send(id)).toMatchObject({ ok: true })
      expect(run.sent).toHaveLength(1)
      expect(run.enters).toEqual([HERDR])
      expect(run.recorded).toHaveLength(1)
    })

    // Claude Code holds a message typed while it compacts in its box, and one sent while it works in its queue above the box, and takes each on its own once free, so either reads queued, never failed; a retry under the same id reads it again and types nothing
    describe("a message Claude Code holds", () => {
      // deliver() keeps a queued id across calls, as the API process does, so each test queues its own
      let n = 0
      const nextId = () => `11111111-2222-4333-8444-659${String(++n).padStart(9, "0")}`
      // the spinner line Claude Code draws while it compacts (its "Compacting conversation" status, 2.1.3xx)
      const compacting = (...box: string[]) =>
        screen(...box).replace(
          "✻ Crystallizing…",
          "✻ Compacting conversation… (38s · esc to interrupt)",
        )
      // a busy session's queue, as the probe's screen above draws it: the message above the box, the box showing the queue hint
      const QUEUED_ABOVE = screen(`❯${NBSP}Press up to edit queued messages`).replace(
        "✻ Crystallizing…",
        `❯ ${MESSAGE}\n  ctrl+enter to send now\n✻ Crystallizing… (2m 4s · ↓ 328 tokens)`,
      )
      const NOW = Date.parse("2026-10-06T12:00:00.000Z")
      const arrived: Entry = {
        at: "2026-10-06T12:00:40.000Z",
        from: null,
        id: "e1",
        kind: "human",
        text: MESSAGE,
        tool: null,
      }
      const queuedRun = (held: string) => {
        const run = after([held], [held])
        let now = NOW
        run.deps.now = () => new Date(now)
        const id = nextId()
        return { ...run, at: (ms: number) => (now = NOW + ms), send: () => run.send(id) }
      }

      test("compacting with the message in the box gives queued, with no Enter pressed into it", async () => {
        const { enters, recorded, send } = queuedRun(compacting(`❯ ${MESSAGE}`))
        const result = await send()
        expect(result).toMatchObject({ code: "QUEUED", ok: false })
        expect(result.ok ? "" : result.reason).not.toMatch(/terminal/i)
        expect(enters).toEqual([])
        expect(recorded).toEqual([])
      })

      test("the queue hint with the message queued above the box gives queued", async () => {
        const { enters, recorded, send } = queuedRun(QUEUED_ABOVE)
        expect(await send()).toMatchObject({ code: "QUEUED", ok: false })
        expect(enters).toEqual([])
        expect(recorded).toEqual([])
      })

      test("its retry while the screen still holds it reads queued again and types nothing", async () => {
        const run = queuedRun(compacting(`❯ ${MESSAGE}`))
        await run.send()
        run.at(QUEUED_MS + 60_000)
        expect(await run.send()).toMatchObject({ code: "QUEUED", ok: false })
        expect(run.sent).toHaveLength(1)
        expect(run.enters).toEqual([])
      })

      test("the box emptied with a transcript line gives delivered, typing nothing more", async () => {
        const run = queuedRun(compacting(`❯ ${MESSAGE}`))
        await run.send()
        run.deps.readScreen = async () => EMPTY
        run.deps.said = async () => [OLDER, arrived]
        run.at(60_000)
        expect(await run.send()).toMatchObject({ ok: true, sessionId: "s-dispatcher" })
        expect(run.sent).toHaveLength(1)
        expect(run.recorded).toHaveLength(1)
      })

      test("the box emptied with no transcript line yet, inside the bound, still reads queued", async () => {
        const run = queuedRun(QUEUED_ABOVE)
        await run.send()
        run.deps.readScreen = async () => EMPTY
        run.deps.said = async () => [OLDER]
        run.at(QUEUED_MS - 1)
        expect(await run.send()).toMatchObject({ code: "QUEUED", ok: false })
        expect(run.sent).toHaveLength(1)
        expect(run.recorded).toEqual([])
      })

      test("no transcript line past the bound gives lost, and its Retry sends it again", async () => {
        const run = queuedRun(compacting(`❯ ${MESSAGE}`))
        await run.send()
        run.deps.readScreen = async () => EMPTY
        // no line for the held paste; the Retry's paste is taken at once and writes one
        run.deps.said = async () =>
          run.sent.length > 1 ? [OLDER, tookLine(MESSAGE, run.deps.now(), 0)] : [OLDER]
        run.at(QUEUED_MS)
        const lost = await run.send()
        expect(lost).toMatchObject({ code: "LOST", ok: false })
        expect(lost.ok ? "" : lost.reason).toContain("Retry")
        expect(lost.ok ? "" : lost.reason).not.toMatch(/terminal/i)
        expect(run.recorded).toEqual([])
        expect(await run.send()).toMatchObject({ ok: true })
        expect(run.sent).toHaveLength(2)
        expect(run.recorded).toHaveLength(1)
      })

      // a busy session can write more than the tail read in the wait, so a transcript that starts after the message was held cannot say it never went
      test("past the bound, a transcript that does not reach back to the hold reads unconfirmed, and no Retry pastes it", async () => {
        const run = queuedRun(compacting(`❯ ${MESSAGE}`))
        await run.send()
        run.deps.readScreen = async () => EMPTY
        run.deps.said = async () => [{ ...OLDER, at: "2026-10-06T12:05:00.000Z", text: "later" }]
        run.at(QUEUED_MS)
        const unknown = await run.send()
        expect(unknown).toMatchObject({ code: "INTERRUPTED", ok: false })
        expect(unknown.ok ? "" : unknown.reason).toContain("may have gone")
        expect(run.sent).toHaveLength(1)
        expect(run.recorded).toEqual([])
      })

      test("past the bound, a transcript that cannot be read reads unconfirmed", async () => {
        const run = queuedRun(compacting(`❯ ${MESSAGE}`))
        await run.send()
        run.deps.readScreen = async () => EMPTY
        run.deps.said = async () => {
          throw new Error("no transcript")
        }
        run.at(QUEUED_MS)
        expect(await run.send()).toMatchObject({ code: "INTERRUPTED", ok: false })
        expect(run.sent).toHaveLength(1)
      })

      // Claude Code stamps a queued_command at its Enter, and a loaded machine can take more than the transcript's 5s slack from the paste to the read that sees it held
      test("a hold is timed from the paste, so after a restart a line stamped at its Enter reads delivered", async () => {
        const run = queuedRun(compacting(`❯ ${MESSAGE}`))
        const prompt = run.deps.prompt
        run.deps.prompt = async (surface, text) => {
          await prompt(surface, text)
          run.at(8000)
        }
        const held = await run.send()
        expect(held).toMatchObject({
          code: "QUEUED",
          ok: false,
          queuedAt: new Date(NOW).toISOString(),
        })
        run.deps.readScreen = async () => EMPTY
        run.deps.said = async () => [OLDER, { ...arrived, at: new Date(NOW + 1000).toISOString() }]
        run.at(QUEUED_MS)
        const queuedAt = held.ok ? undefined : held.queuedAt
        const id = nextId()
        expect(
          await deliver({ actor, id, queuedAt, text: MESSAGE, to: "dispatcher" }, run.deps),
        ).toMatchObject({ ok: true })
        expect(run.sent).toHaveLength(1)
      })

      // a model or effort setting types its slash command the way a message types its words, so Claude Code holds it as it holds a message
      describe("a setting", () => {
        const COMMAND = "/model opus"
        const settingRun = (held: string) => {
          const run = after([held], [held])
          run.deps.now = () => new Date(NOW)
          const id = nextId()
          const send = () =>
            deliver({ actor, id, setting: { model: "opus" }, text: "", to: "dispatcher" }, run.deps)
          return { ...run, send }
        }

        test("sent while the session compacts reads queued, not interrupted, with no Enter pressed into it", async () => {
          const { enters, recorded, send } = settingRun(compacting(`❯ ${COMMAND}`))
          expect(await send()).toMatchObject({ code: "QUEUED", ok: false })
          expect(enters).toEqual([])
          expect(recorded).toEqual([])
        })

        test("its retry under the same id while still held types nothing new", async () => {
          const run = settingRun(compacting(`❯ ${COMMAND}`))
          await run.send()
          expect(await run.send()).toMatchObject({ code: "QUEUED", ok: false })
          expect(run.sent).toEqual([{ surface: HERDR, text: COMMAND }])
          expect(run.enters).toEqual([])
        })

        test("sent to an idle session reads delivered", async () => {
          const run = settingRun(EMPTY)
          expect(await run.send()).toMatchObject({ ok: true, sessionId: "s-dispatcher" })
          expect(run.sent).toEqual([{ surface: HERDR, text: COMMAND }])
          expect(run.recorded).toEqual(["Set dispatcher's model to opus"])
        })
      })

      // an API restart forgets the ids it queued, and the outbox's queuedAt stands in for them, so the message is read again and never pasted twice
      describe("after an API restart", () => {
        const restarted = (shown: string, ms: number) => {
          const run = herdr()
          const enters: string[] = []
          run.deps.readScreen = async () => (enters.length ? EMPTY : shown)
          run.deps.pressEnter = async (surface) => {
            enters.push(surface)
          }
          run.deps.wait = async () => {}
          run.deps.now = () => new Date(NOW + ms)
          const queuedAt = new Date(NOW).toISOString()
          const send = () =>
            deliver({ actor, id: nextId(), queuedAt, text: MESSAGE, to: "dispatcher" }, run.deps)
          return { ...run, enters, send }
        }

        test("a message its transcript shows reads delivered, typing nothing", async () => {
          const run = restarted(EMPTY, 60_000)
          run.deps.said = async () => [OLDER, arrived]
          expect(await run.send()).toMatchObject({ ok: true, sessionId: "s-dispatcher" })
          expect(run.sent).toEqual([])
          expect(run.recorded).toHaveLength(1)
        })

        test("a message still queued above the box reads queued, typing nothing", async () => {
          const run = restarted(QUEUED_ABOVE, 60_000)
          expect(await run.send()).toMatchObject({ code: "QUEUED", ok: false })
          expect(run.sent).toEqual([])
          expect(run.enters).toEqual([])
        })

        test("a message gone with no transcript line past the bound reads lost, typing nothing", async () => {
          const run = restarted(EMPTY, QUEUED_MS)
          expect(await run.send()).toMatchObject({ code: "LOST", ok: false })
          expect(run.sent).toEqual([])
        })

        test("a message back in the box once the compaction ends gets its Enter, pasted once", async () => {
          const run = restarted(screen(`❯ ${MESSAGE}`), 60_000)
          expect(await run.send()).toMatchObject({ ok: true })
          expect(run.sent).toEqual([])
          expect(run.enters).toEqual([HERDR])
        })
      })
    })

    // 24 Oct 02:58Z: dispatcher's box held the owner's image message, pasted and never submitted, which every later try refused as a draft until the owner pressed Enter in the terminal; the box's shape is the one dispatcher's transcript recorded at 03:13Z
    test("an image message whose box read empty before its paste was drawn waits queued, and its own retry presses Enter on it before the next message goes", async () => {
      const { deps, recorded, sent, stays, took } = herdr()
      const words = "I have Linear status twice. We can remove the next block, no?"
      const png: Attachment = {
        id: "a.png",
        kind: "image",
        path: "/home/x/.playground/attachments/11111111-2222-4333-8444-555555555555.png",
        size: 9000,
      }
      const pasted = withAttachments(words, [png])
      stays.add(pasted)
      const id = "11111111-2222-4333-8444-000000000004"
      const stuckBox = screen(`❯ [Image #6]${words}`, "  Attached:")
      const enters: string[] = []
      let drawn = false
      deps.pressEnter = async (surface) => {
        enters.push(surface)
        if (drawn) took(pasted)
        drawn = false
      }
      // its own settle reads the box empty before the paste is drawn (the live dashboard's log, 200 in 2s), and no transcript line shows it went, so it waits queued rather than reading sent
      deps.readScreen = async () => (drawn ? stuckBox : EMPTY)
      const message = { actor, attachments: [png], text: words, to: "dispatcher" }
      const first = await deliver({ ...message, id }, deps)
      expect(first).toMatchObject({ code: "QUEUED", ok: false })
      drawn = true
      // its own retry finds the paste drawn in the box and presses Enter on it, pasting nothing again
      const queuedAt = first.ok ? undefined : first.queuedAt
      expect(await deliver({ ...message, id, queuedAt }, deps)).toMatchObject({ ok: true })
      // then the next message goes on its own, never after it in the box
      const next = await deliver(
        { actor, id: "11111111-2222-4333-8444-000000000005", text: "and this", to: "dispatcher" },
        deps,
      )
      expect(next).toMatchObject({ ok: true })
      expect(enters).toEqual([HERDR])
      expect(sent.map((s) => s.text)).toEqual([pasted, "and this"])
      expect(recorded).toHaveLength(2)
    })

    // a reviewer: Claude Code folds a paste of more than 2 line breaks or 800 characters into [Pasted text #n +k lines], k its line breaks, so a long message stuck the 24 Oct way is known by that count
    test("an earlier paste Claude Code folded gets its Enter from the next message when the fold counts its line breaks", async () => {
      const { deps, recorded, sent, stays, took } = herdr()
      const words = "one\n\ntwo\n\nthree"
      stays.add(words)
      const enters: string[] = []
      let box = EMPTY
      deps.pressEnter = async (surface) => {
        enters.push(surface)
        if (box !== EMPTY) took(words)
        box = EMPTY
      }
      deps.readScreen = async () => box
      const first = {
        actor,
        id: "11111111-2222-4333-8444-000000000010",
        text: words,
        to: "dispatcher",
      }
      // drawn after its settle, with no line, so it waits queued
      const firstTry = await deliver(first, deps)
      expect(firstTry).toMatchObject({ code: "QUEUED", ok: false })
      box = screen("❯ [Pasted text #1 +3 lines]")
      const other = {
        actor,
        id: "11111111-2222-4333-8444-000000000011",
        text: "and this",
        to: "dispatcher",
      }
      expect(await deliver(other, deps)).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(enters).toEqual([])
      box = screen("❯ [Pasted text #1 +4 lines]")
      expect(await deliver(other, deps)).toMatchObject({ ok: true })
      expect(enters).toEqual([HERDR])
      expect(sent.map((s) => s.text)).toEqual([words, "and this"])
      // the first's own retry reads its line and types nothing
      const queuedAt = firstTry.ok ? undefined : firstTry.queuedAt
      expect(await deliver({ ...first, queuedAt }, deps)).toMatchObject({ ok: true })
      expect(sent).toHaveLength(2)
      expect(recorded).toHaveLength(2)
    })

    // a reviewer: the message whose Enter sent an earlier held one leaves it unsent in memory, so that one's own retry reads it gone and types nothing
    test("a held message another message's Enter sent reads delivered on its own retry, typing nothing", async () => {
      const { deps, sent, took } = herdr()
      const enters: string[] = []
      let box = EMPTY
      deps.prompt = async (surface, text) => {
        sent.push({ surface, text })
        if (text === "the held one") box = screen("❯ the held one")
        else took(text)
      }
      deps.pressEnter = async (surface) => {
        enters.push(surface)
        if (enters.length > 1) {
          took("the held one")
          box = EMPTY
        }
      }
      deps.readScreen = async () => box
      const held = {
        actor,
        id: "11111111-2222-4333-8444-000000000015",
        text: "the held one",
        to: "dispatcher",
      }
      expect(await deliver(held, deps)).toMatchObject({ code: "INPUT_NOT_EMPTY", pasted: true })
      const other = {
        actor,
        id: "11111111-2222-4333-8444-000000000016",
        text: "another",
        to: "dispatcher",
      }
      expect(await deliver(other, deps)).toMatchObject({ ok: true })
      expect(await deliver(held, deps)).toMatchObject({ ok: true })
      expect(sent.map((s) => s.text)).toEqual(["the held one", "another"])
      expect(enters).toEqual([HERDR, HERDR])
    })

    test("a later message waits, typing nothing, while an earlier paste of the dashboard's stays in the box after its Enter", async () => {
      const { deps, recorded, sent, stays } = herdr(undefined, "s-stuck")
      stays.add("the first, still stuck")
      const enters: string[] = []
      let drawn = false
      deps.pressEnter = async (surface) => {
        enters.push(surface)
      }
      deps.readScreen = async () => (drawn ? screen("❯ the first, still stuck") : EMPTY)
      const first = {
        actor,
        id: "11111111-2222-4333-8444-000000000006",
        text: "the first, still stuck",
      }
      // drawn after its settle, with no line, so it waits queued
      expect(await deliver({ ...first, to: "dispatcher" }, deps)).toMatchObject({ code: "QUEUED" })
      drawn = true
      const next = await deliver(
        { actor, id: "11111111-2222-4333-8444-000000000007", text: "the second", to: "dispatcher" },
        deps,
      )
      expect(next).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(next).not.toHaveProperty("pasted")
      expect(enters).toEqual([HERDR])
      expect(sent.map((s) => s.text)).toEqual(["the first, still stuck"])
      expect(recorded).toEqual([])
    })

    // a reviewer: Up in the terminal recalls a message that went back into the box, which must never be sent again
    test("a box holding a paste the transcript shows went is the owner's recall, and holds with no Enter", async () => {
      const { deps, recorded, sent } = herdr()
      const enters: string[] = []
      let recalled = false
      deps.pressEnter = async (surface) => {
        enters.push(surface)
      }
      // it went at once, its line written
      deps.said = async () => [
        OLDER,
        { ...OLDER, at: "2026-10-06T12:00:01.000Z", id: "e1", text: "the recalled one" },
      ]
      deps.readScreen = async () => (recalled ? screen("❯ the recalled one") : EMPTY)
      const first = { actor, id: "11111111-2222-4333-8444-00000000000a", text: "the recalled one" }
      expect(await deliver({ ...first, to: "dispatcher" }, deps)).toMatchObject({ ok: true })
      recalled = true
      const next = await deliver(
        { actor, id: "11111111-2222-4333-8444-00000000000b", text: "the next", to: "dispatcher" },
        deps,
      )
      expect(next).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(enters).toEqual([])
      expect(sent.map((s) => s.text)).toEqual(["the recalled one"])
      expect(recorded).toHaveLength(1)
    })

    // a reviewer: a transcript read that does not reach back to the paste cannot show it did not go, so the box holds
    test("a remembered paste the transcript read does not reach back to holds with no Enter", async () => {
      const { deps, sent } = herdr(undefined, "s-out-of-reach")
      const enters: string[] = []
      let drawn = false
      deps.pressEnter = async (surface) => {
        enters.push(surface)
      }
      deps.said = async () => [{ ...OLDER, at: "2026-10-06T12:30:00.000Z", kind: "assistant" }]
      deps.readScreen = async () => (drawn ? screen("❯ an old one, out of reach") : EMPTY)
      const first = {
        actor,
        id: "11111111-2222-4333-8444-00000000000c",
        text: "an old one, out of reach",
      }
      // no line it can read shows it went, so it waits queued
      expect(await deliver({ ...first, to: "dispatcher" }, deps)).toMatchObject({ code: "QUEUED" })
      drawn = true
      const next = await deliver(
        { actor, id: "11111111-2222-4333-8444-00000000000d", text: "the next", to: "dispatcher" },
        deps,
      )
      expect(next).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(enters).toEqual([])
      expect(sent).toHaveLength(1)
    })

    test("a one-line message past the transcript's clip is proven by its clipped line", async () => {
      const { deps } = herdr(undefined, "s-long")
      const text = "long ".repeat(1000).trim()
      deps.said = async () => [OLDER, tookLine(clip(text, TEXT_LIMIT), deps.now(), 0)]
      const id = "11111111-2222-4333-8444-000000001331"
      expect(await deliver({ actor, id, text, to: "dispatcher" }, deps)).toMatchObject({ ok: true })
    })

    // a reviewer: a message of files alone has no first line of words, so its transcript entry is matched by its files
    test("a message of files alone the transcript shows went is the owner's recall, and holds with no Enter", async () => {
      const { deps, sent } = herdr()
      const png: Attachment = {
        id: "c.png",
        kind: "image",
        path: "/home/x/.playground/attachments/11111111-2222-4333-8444-777777777777.png",
        size: 9000,
      }
      const enters: string[] = []
      let recalled = false
      deps.pressEnter = async (surface) => {
        enters.push(surface)
      }
      // it went at once, its line written
      deps.said = async () => [
        OLDER,
        {
          ...OLDER,
          at: "2026-10-06T12:00:01.000Z",
          attachments: [{ id: null, kind: "image" as const }],
          id: "e2",
          text: "",
        },
      ]
      deps.readScreen = async () => (recalled ? screen("❯ [Image #3]", "  Attached:") : EMPTY)
      const first = {
        actor,
        attachments: [png],
        id: "11111111-2222-4333-8444-00000000000e",
        text: "",
      }
      expect(await deliver({ ...first, to: "dispatcher" }, deps)).toMatchObject({ ok: true })
      recalled = true
      const next = await deliver(
        { actor, id: "11111111-2222-4333-8444-00000000000f", text: "the next", to: "dispatcher" },
        deps,
      )
      expect(next).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(enters).toEqual([])
      expect(sent).toHaveLength(1)
    })

    // Claude Code folds a long paste into one mark, so its words cannot be read: a fold is taken as a paste of the dashboard's only when that paste would fold and its line breaks are the fold's count
    test("a retry presses Enter on its own paste folded into [Pasted text #n +k lines], and not on a fold of another count or of a message too short to fold", async () => {
      const { deps, sent, took } = herdr()
      const words = "seven\n\neight\n\nnine"
      const enters: string[] = []
      let box = EMPTY
      deps.prompt = async (surface, text) => {
        sent.push({ surface, text })
        box = screen("❯ [Pasted text #1 +4 lines]")
      }
      deps.pressEnter = async (surface) => {
        enters.push(surface)
      }
      deps.readScreen = async () => box
      const message = {
        actor,
        id: "11111111-2222-4333-8444-000000000012",
        text: words,
        to: "dispatcher",
      }
      expect(await deliver(message, deps)).toMatchObject({ code: "INPUT_NOT_EMPTY", pasted: true })
      expect(enters).toEqual([HERDR])
      // a reviewer: the owner cleared it and pasted a long text of their own
      box = screen("❯ [Pasted text #2 +2 lines]")
      expect(await deliver(message, deps)).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(enters).toEqual([HERDR])
      box = screen("❯ [Pasted text #1 +4 lines]")
      deps.pressEnter = async (surface) => {
        enters.push(surface)
        box = EMPTY
      }
      expect(await deliver(message, deps)).toMatchObject({ ok: true })
      expect(enters).toEqual([HERDR, HERDR])
      expect(sent).toHaveLength(1)
      deps.prompt = async (surface, text) => {
        sent.push({ surface, text })
        took(text)
      }
      const short = {
        actor,
        id: "11111111-2222-4333-8444-000000000013",
        text: "too short to fold",
        to: "dispatcher",
      }
      expect(await deliver(short, deps)).toMatchObject({ ok: true })
      box = screen("❯ [Pasted text #3]")
      const next = {
        actor,
        id: "11111111-2222-4333-8444-000000000014",
        text: "the next",
        to: "dispatcher",
      }
      expect(await deliver(next, deps)).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
      expect(enters).toEqual([HERDR, HERDR])
      expect(sent).toHaveLength(2)
    })

    test("a box holding other words, or this message with more, still holds and gets nothing", async () => {
      for (const box of [`❯ ${MESSAGE} and more`, "❯ Is send on the", `❯ [Image #1]${MESSAGE}`]) {
        const { deps, recorded, sent } = herdr()
        const enters: string[] = []
        deps.pressEnter = async (surface) => {
          enters.push(surface)
        }
        deps.readScreen = async () => screen(box)
        const result = await deliver({ actor, text: MESSAGE, to: "dispatcher" }, deps)
        expect(result).toMatchObject({ code: "INPUT_NOT_EMPTY", ok: false })
        expect(sent).toEqual([])
        expect(enters).toEqual([])
        expect(recorded).toEqual([])
      }
    })

    // a prompt that failed as typed may have gone or never been pasted, which an empty box cannot tell, so it stays interrupted; the message seen in the box is ours, and an Enter sends it
    test("after a prompt that failed as typed, only the message seen and then sent counts", async () => {
      const stalled = new HerdrRefused("agent.prompt", "agent_prompt_stalled", "")
      const empty = after([EMPTY], [EMPTY], stalled)
      expect(await empty.send()).toMatchObject({ code: "INTERRUPTED", ok: false })
      expect(empty.enters).toEqual([])
      const seen = after([HELD], [EMPTY], stalled)
      expect(await seen.send()).toMatchObject({ ok: true })
      expect(seen.enters).toEqual([HERDR])
    })
  })

  // The outbox reads a message delivered only when the transcript holds its words and files exactly, so the prompt carries the Attached lines as withAttachments writes them
  test("a message's files go in the same prompt, one Attached line each after a blank line", async () => {
    const { deps, recorded, sent } = herdr()
    const DIR = "/home/x/.playground/attachments"
    const png: Attachment = {
      id: "a.png",
      kind: "image",
      path: `${DIR}/11111111-2222-4333-8444-555555555555.png`,
      size: 300_000,
    }
    const pdf: Attachment = {
      id: "b.pdf",
      kind: "pdf",
      path: `${DIR}/11111111-2222-4333-8444-666666666666.pdf`,
      size: 1_100_000,
    }
    const result = await deliver(
      { actor, attachments: [png, pdf], text: "line one\nline two", to: "dispatcher" },
      deps,
    )
    expect(result.ok).toBe(true)
    expect(sent).toEqual([
      {
        surface: HERDR,
        text: `line one\nline two\n\nAttached: ${png.path}\nAttached: ${pdf.path}`,
      },
    ])
    expect(recorded).toEqual([
      "Sent dispatcher a message of 17 characters on 2 lines with 2 attachments of 1.3 MB",
    ])
  })

  // A herdr pane's id changes when it moves, so the session read once more before the send decides where it goes, and a name that now holds another session sends nothing.
  test("the message goes where the session is at the send, and never to another session", async () => {
    const moved = herdr()
    let screened = false
    moved.deps.readScreen = async () => {
      screened = true
      return EMPTY
    }
    moved.deps.readSession = async () =>
      screened
        ? live([worker()], { "s-dispatcher": "herdr:factory:w2:p1" })
        : live([worker()], { "s-dispatcher": HERDR })
    expect(await deliver({ actor, text: "hi", to: "dispatcher" }, moved.deps)).toMatchObject({
      ok: true,
    })
    expect(moved.sent).toEqual([{ surface: "herdr:factory:w2:p1", text: "hi" }])

    const other = herdr()
    screened = false
    other.deps.readScreen = moved.deps.readScreen
    other.deps.readSession = async () =>
      screened
        ? live([worker({ sessionId: "s-other" })], { "s-other": HERDR })
        : live([worker()], { "s-dispatcher": HERDR })
    expect(await deliver({ actor, text: "hi", to: "dispatcher" }, other.deps)).toMatchObject({
      code: "NOT_FOUND",
      ok: false,
    })
    expect(other.sent).toEqual([])
  })

  test("a draft in its input box refuses before anything is sent", async () => {
    const { deps, sent } = herdr()
    deps.readScreen = async () => screen("❯ half a thought")
    expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
      code: "INPUT_NOT_EMPTY",
    })
    expect(sent).toEqual([])
  })

  test("herdr's refusals map as #910 lists them", async () => {
    const cases: [unknown, string][] = [
      [new HerdrRefused("agent.prompt", "agent_blocked", ""), "ON_PICKER"],
      [new HerdrRefused("agent.prompt", "agent_not_running", ""), "NOT_FOUND"],
      [new HerdrRefused("agent.prompt", "not_found", ""), "NOT_FOUND"],
      [new HerdrRefused("agent.prompt", "timeout", ""), "INTERRUPTED"],
      [new HerdrRefused("agent.prompt", "agent_prompt_stalled", ""), "INTERRUPTED"],
      [new HerdrTimedOut("agent.prompt"), "INTERRUPTED"],
      [new HerdrDown("connect ENOENT"), "SESSIONS_FAILED"],
      [new HerdrRefused("agent.prompt", "invalid_request", ""), "SESSIONS_FAILED"],
    ]
    for (const [error, code] of cases) {
      const { deps } = herdr(error)
      expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
        code,
        ok: false,
      })
    }
  })

  test("a refusal that sent nothing is tried once more at once", async () => {
    let tries = 0
    const { deps, sent } = herdr()
    deps.prompt = async (surface, text) => {
      tries += 1
      if (tries === 1) throw new HerdrDown("connect ECONNREFUSED")
      sent.push({ surface, text })
    }
    expect((await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).ok).toBe(true)
    expect(tries).toBe(2)
  })

  test("a session found on a prompt when its turn comes is not sent to", async () => {
    const { deps, sent } = herdr()
    deps.readSession = async () => live([worker({ light: "needs-you" })], { "s-dispatcher": HERDR })
    expect(await deliver({ actor, text: "hi", to: "dispatcher" }, deps)).toMatchObject({
      code: "ON_PICKER",
    })
    expect(sent).toEqual([])
  })
})

// The owner works in the dashboard alone, so no delivery, Feed or outbox copy sends them to a session's terminal; each offers Retry, or Check it for me, in its place
test("no delivery or answer copy sends the owner to a terminal", async () => {
  const root = join(import.meta.dir, "../../../../../..")
  const files = [
    "api/hono/src/lib/dashboard/deliver.ts",
    "api/hono/src/lib/dashboard/feed.ts",
    "web/next/src/lib/inbox.ts",
    "web/next/src/lib/outbox.ts",
  ]
  for (const file of files) {
    const source = await Bun.file(join(root, file)).text()
    const strings = source.match(/`[^`]*`|"[^"\n]*"/g) ?? []
    const sent = strings.filter((s) =>
      /(?:look at|check) [^`"]*terminal|in its terminal first/i.test(s),
    )
    expect({ file, sent }).toEqual({ file, sent: [] })
  }
})

// Two messages sent to a busy dispatcher reached it as one prompt, the second pasted after the first with no break ("…Inbox preferablythe tick…"): the first's Enter was lost while Claude Code, slow under load, had not yet drawn its paste, so the box read empty after the send and the first read typed, and the second was pasted after it. A fake Claude Code here draws each paste a while after it lands and loses the first paste's Enter.
describe("a paste Claude Code draws late", () => {
  const PANE = "herdr:factory:w3:p1"
  const NOW = Date.parse("2026-10-06T12:00:00.000Z")
  const FIRST = "What reads the Inbox preferably"
  const SECOND = "the tick and loader, should be one until sent"
  // the box as Claude Code holds it, the prompts it took, and how many more reads still show the box as it was before the last paste
  function lateClaude(lag: number) {
    const state = live([worker()], { "s-dispatcher": PANE })
    const { deps } = fakes(state)
    let box = ""
    let shown = ""
    let behind = 0
    let pastes = 0
    const took: string[] = []
    const draw = () => (box ? screen(`❯ ${box}`) : EMPTY)
    deps.prompt = async (_surface, text) => {
      shown = draw()
      box += text
      behind = lag
      // the first paste's Enter lands while the paste is still being taken in, and is lost
      if (pastes++ > 0) {
        took.push(box)
        box = ""
      }
    }
    deps.pressEnter = async () => {
      if (!box) return
      took.push(box)
      box = ""
    }
    deps.readScreen = async () => {
      if (behind > 0) {
        behind--
        return shown
      }
      return draw()
    }
    deps.said = async () => [
      OLDER,
      ...took.map((text, i): Entry => ({
        at: new Date(NOW).toISOString(),
        from: null,
        id: `took-${i}`,
        kind: "human",
        text,
        tool: null,
      })),
    ]
    return { deps, took }
  }

  // each message as the outbox sends it: again under its own id and queuedAt while the API reads it held, and the next only once the one before settles
  async function sendInTurn(deps: DeliverDeps, texts: string[]) {
    for (const [i, text] of texts.entries()) {
      const id = `22222222-3333-4444-8555-${String(i + 1).padStart(12, "0")}`
      let queuedAt: string | undefined
      for (let tries = 0; tries < 20; tries++) {
        const result = await deliver({ actor, id, queuedAt, text, to: "dispatcher" }, deps)
        if (result.ok || result.code !== "QUEUED") break
        queuedAt = result.queuedAt
      }
    }
  }

  test("two messages reach the session as two prompts, never one joined", async () => {
    const { deps, took } = lateClaude(12)
    await sendInTurn(deps, [FIRST, SECOND])
    expect(took).toEqual([FIRST, SECOND])
  })

  // the composer's outbox and the Inbox's answers each send in their own order and retry on their own, so neither waits for the other: deliver() holds the second while the first's paste is unproven
  test("an Inbox answer and a composer message sent in the same second arrive as two prompts", async () => {
    const { deps, took } = lateClaude(12)
    const sends = [
      { id: "33333333-4444-4555-8666-000000000001", text: FIRST },
      { id: "33333333-4444-4555-8666-000000000002", text: SECOND },
    ].map((send) => ({ ...send, done: false, queuedAt: undefined as string | undefined }))
    for (let round = 0; round < 20 && sends.some((send) => !send.done); round++) {
      for (const send of sends.filter((one) => !one.done)) {
        const { id, queuedAt, text } = send
        const result = await deliver({ actor, id, queuedAt, text, to: "dispatcher" }, deps)
        if (result.ok) send.done = true
        else if (result.code === "QUEUED") send.queuedAt = result.queuedAt
      }
    }
    expect(took).toEqual([FIRST, SECOND])
  })
})
