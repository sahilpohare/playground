import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  guarded,
  type Put,
  share,
  type Spec,
  upload,
  wordsOf,
} from "../../../../../../extensions/slack/skills/slack/scripts/upload"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

type Step = { at: string; params?: Record<string, string>; size?: number }

type Member = {
  deleted?: boolean
  id: string
  name: string
  profile: { display_name: string; real_name: string }
}

// Made-up workspace members, as users.list hands them back.
const MEMBERS: Member[] = [
  {
    id: "U0MADEUP01",
    name: "merritt.lee",
    profile: { display_name: "Merritt", real_name: "Merritt Lee" },
  },
  { id: "U0MADEUP02", name: "alex", profile: { display_name: "Alex", real_name: "Alex One" } },
  { id: "U0MADEUP03", name: "alex.two", profile: { display_name: "alex", real_name: "Alex Two" } },
  {
    deleted: true,
    id: "U0MADEUP04",
    name: "ida",
    profile: { display_name: "Ida", real_name: "Ida Gone" },
  },
  { id: "U0MADEUP05", name: "jose", profile: { display_name: "José", real_name: "José Ruiz" } },
]

// Slack's HTTP, stubbed: each getUploadURLExternal hands back its own URL and file id, users.list hands back the members a page at a time, and every step lands in one log, so the order reads whole.
const stub = ({ complete = true, members = MEMBERS, page = 100, putStatus = 200 } = {}) => {
  const steps: Step[] = []
  let n = 0
  const slack = async (method: string, params: Record<string, string>) => {
    steps.push({ at: method, params })
    if (method === "users.list") {
      const from = Number(params.cursor ?? 0)
      const next = from + page < members.length ? String(from + page) : ""
      return {
        members: members.slice(from, from + page),
        ok: true,
        response_metadata: { next_cursor: next },
      }
    }
    if (method === "files.getUploadURLExternal") {
      n += 1
      return { file_id: `F0MADEUP0${n}`, ok: true, upload_url: `https://files.example/upload/${n}` }
    }
    return complete ? { ok: true } : { error: "not_in_channel", ok: false }
  }
  const put: Put = async (url, bytes) => {
    steps.push({ at: url, size: bytes.length })
    return { ok: putStatus < 300, status: putStatus }
  }
  return { put, slack, steps }
}

const FILES = [
  { bytes: new Uint8Array([1, 2, 3]), name: "before.png", text: false },
  { bytes: new Uint8Array([4, 5, 6, 7]), name: "after.png", text: false },
]

describe("dm upload (PG-649)", () => {
  test("two files: each asks for an upload URL and posts its bytes, then one complete shares both into the channel and thread", async () => {
    const { put, slack, steps } = stub()
    const count = await upload({
      channel: "C0MADEUP01",
      files: FILES,
      put,
      slack,
      thread: "1700000000.000100",
    })
    expect(count).toBe(2)
    expect(steps).toEqual([
      { at: "files.getUploadURLExternal", params: { filename: "before.png", length: "3" } },
      { at: "https://files.example/upload/1", size: 3 },
      { at: "files.getUploadURLExternal", params: { filename: "after.png", length: "4" } },
      { at: "https://files.example/upload/2", size: 4 },
      {
        at: "files.completeUploadExternal",
        params: {
          channel_id: "C0MADEUP01",
          files: JSON.stringify([
            { id: "F0MADEUP01", title: "before.png" },
            { id: "F0MADEUP02", title: "after.png" },
          ]),
          thread_ts: "1700000000.000100",
        },
      },
    ])
  })

  test("a draft's words ride with its files as the complete's initial_comment, so they post once (PG-1921)", async () => {
    const { put, slack, steps } = stub()
    const sent = {
      channel: "C0MADEUP01",
      files: FILES,
      put,
      slack,
      text: "the fix is live",
      thread: "1700000000.000100",
    }
    await upload(sent)
    const completes = steps.filter((step) => step.at === "files.completeUploadExternal")
    expect(completes.map((step) => step.params?.initial_comment)).toEqual(["the fix is live"])
  })

  test("a channel with no thread shares the files at its top level", async () => {
    const { put, slack, steps } = stub()
    await upload({ channel: "D0MADEUP11", files: FILES.slice(0, 1), put, slack })
    expect(steps.at(-1)?.params).toEqual({
      channel_id: "D0MADEUP11",
      files: JSON.stringify([{ id: "F0MADEUP01", title: "before.png" }]),
    })
  })

  test("a byte post Slack refuses fails the upload, naming the file, and shares nothing", async () => {
    const { put, slack, steps } = stub({ putStatus: 500 })
    await expect(
      upload({ channel: "C0MADEUP01", files: FILES, put, slack, thread: "1700000000.000100" }),
    ).rejects.toThrow("before.png")
    expect(steps.map((s) => s.at)).not.toContain("files.completeUploadExternal")
  })

  test("a complete Slack refuses fails the upload with Slack's error", async () => {
    const { put, slack } = stub({ complete: false })
    await expect(upload({ channel: "C0MADEUP01", files: FILES, put, slack })).rejects.toThrow(
      "files.completeUploadExternal: not_in_channel",
    )
  })

  // the guards dm send runs on a post, run on each file as one post would carry it
  describe("guarded", () => {
    const seen = () => {
      const texts: string[] = []
      const raws: string[] = []
      return {
        checks: {
          playground: async (text: string) => (texts.push(text), undefined),
          public: async (raw: string) => (raws.push(raw), undefined),
        },
        raws,
        texts,
      }
    }

    test("a text file's words reach both guards with its name, a picture's name alone", async () => {
      const { checks, raws, texts } = seen()
      const notes = { bytes: new TextEncoder().encode("hello"), name: "notes.png", text: true }
      expect(await guarded("C0MADEUP01", wordsOf(notes), checks)).toBeUndefined()
      expect(await guarded("C0MADEUP01", wordsOf(FILES[0]!), checks)).toBeUndefined()
      expect(texts).toEqual(["notes.png\nhello", "before.png"])
      expect(JSON.parse(raws[0]!)).toEqual({
        tool_input: { channel: "C0MADEUP01", text: "notes.png\nhello" },
        tool_name: "mcp__slack-shared__chat_post_message",
      })
    })

    test("either guard's refusal is the reason", async () => {
      const refuse = async () => "a term the channel may not see"
      const pass = async () => undefined
      expect(await guarded("C0MADEUP01", "before.png", { playground: refuse, public: pass })).toBe(
        "a term the channel may not see",
      )
      expect(await guarded("C0MADEUP01", "before.png", { playground: pass, public: refuse })).toBe(
        "a term the channel may not see",
      )
    })
  })

  describe("share", () => {
    const SPEC: Spec = {
      channel: "C0MADEUP01",
      files: [
        { bytes: Buffer.from([1, 2, 3]).toString("base64"), name: "before.png", text: false },
        { bytes: Buffer.from("hello").toString("base64"), name: "notes.txt", text: true },
      ],
      thread: "1700000000.000100",
    }

    test("shares the files of the item its id names, into the place that item's spec reads", async () => {
      const { put, slack, steps } = stub()
      const asked: string[] = []
      const count = await share("item-1", {
        check: async () => undefined,
        put,
        read: async (id) => (asked.push(id), SPEC),
        slack,
      })
      expect(asked).toEqual(["item-1"])
      expect(count).toBe(2)
      expect(steps.filter((step) => step.size !== undefined).map((step) => step.size)).toEqual([
        3, 5,
      ])
      expect(steps.at(-1)?.params).toMatchObject({
        channel_id: "C0MADEUP01",
        thread_ts: "1700000000.000100",
      })
    })

    test("the spec's words reach Slack as the complete's initial_comment (PG-1921)", async () => {
      const { put, slack, steps } = stub()
      const words: Spec = { ...SPEC, text: "the fix is live" }
      await share("item-1", { check: async () => undefined, put, read: async () => words, slack })
      expect(steps.at(-1)?.params?.initial_comment).toBe("the fix is live")
    })

    test("words a guard refuses fail the share as the message's, before any file reaches Slack (PG-1921)", async () => {
      const { put, slack, steps } = stub()
      await expect(
        share("item-1", {
          check: async (_channel, words) =>
            words === "the fix is live" ? "a term the channel may not see" : undefined,
          put,
          read: async () => ({ ...SPEC, text: "the fix is live" }),
          slack,
        }),
      ).rejects.toThrow("the message: a term the channel may not see")
      expect(steps).toEqual([])
    })

    test("a file a guard refuses fails the share, naming it, before any file reaches Slack", async () => {
      const { put, slack, steps } = stub()
      await expect(
        share("item-1", {
          check: async (_channel, words) =>
            words.includes("hello") ? "a term the channel may not see" : undefined,
          put,
          read: async () => SPEC,
          slack,
        }),
      ).rejects.toThrow("notes.txt: a term the channel may not see")
      expect(steps).toEqual([])
    })

    const sharing = (text: string, opts?: Parameters<typeof stub>[0]) => {
      const { put, slack, steps } = stub(opts)
      const shared = share("item-1", {
        check: async () => undefined,
        put,
        read: async () => ({ ...SPEC, text }),
        slack,
      })
      return { shared, steps }
    }

    test("words holding a mention and a URL post with the files as one message: the mention as its user's token, the URL as a link labelled without its scheme (PG-1983)", async () => {
      const { shared, steps } = sharing("@Merritt the fix is live: https://example.com/fix.")
      expect(await shared).toBe(2)
      const completes = steps.filter((step) => step.at === "files.completeUploadExternal")
      expect(completes.map((step) => step.params?.initial_comment)).toEqual([
        "<@U0MADEUP01> the fix is live: <https://example.com/fix|example.com/fix>.",
      ])
      expect(steps.map((step) => step.at)).not.toContain("chat.postMessage")
    })

    test("a mention matches a member's username, display name or real name, in any case, past a page of users.list (PG-1983)", async () => {
      const { shared, steps } = sharing("cc @MERRITT.LEE, (@merritt)", { page: 1 })
      await shared
      expect(steps.at(-1)?.params?.initial_comment).toBe("cc <@U0MADEUP01>, (<@U0MADEUP01>)")
      expect(steps.filter((step) => step.at === "users.list").map((s) => s.params?.cursor)).toEqual(
        [undefined, "1", "2", "3", "4"],
      )
    })

    test("a name that matches no member, a removed one alone, or two, fails the share naming it, before any file reaches Slack (PG-1983)", async () => {
      for (const [text, reason] of [
        ["@nobody hi", "@nobody matches no Slack user: only a person can be tagged"],
        ["@here hi", "@here matches no Slack user: only a person can be tagged"],
        ["@Ida hi", "@Ida matches no Slack user"],
        ["@alex hi", "@alex matches 2 Slack users"],
      ] as const) {
        const { shared, steps } = sharing(text)
        await expect(shared).rejects.toThrow(reason)
        expect(steps.map((step) => step.at)).not.toContain("files.getUploadURLExternal")
      }
    })

    test("a code span, a fenced block and a Slack link already in the words stay exactly as written, and a name past ASCII reads whole (PG-1983)", async () => {
      const fenced = "run\n```\nnpm i @types/node\nhttps://example.com/b\n```"
      for (const [text, comment] of [
        ["see `https://example.com/a` now", "see `https://example.com/a` now"],
        ["install `@types/node` first", "install `@types/node` first"],
        [fenced, fenced],
        [
          "@Merritt see <https://example.com|the doc>",
          "<@U0MADEUP01> see <https://example.com|the doc>",
        ],
        ["@José hi", "<@U0MADEUP05> hi"],
      ] as const) {
        const { shared, steps } = sharing(text)
        await shared
        expect(steps.at(-1)?.params?.initial_comment).toBe(comment)
      }
    })

    test("a URL inside Slack's bold, italic, strike or brackets leaves the closing mark outside its link (PG-1983)", async () => {
      for (const [open, close] of [
        ["*", "*"],
        ["_", "_"],
        ["~", "~"],
        ["[", "]"],
      ]) {
        const { shared, steps } = sharing(`see ${open}https://example.com/a${close} now`)
        await shared
        expect(steps.at(-1)?.params?.initial_comment).toBe(
          `see ${open}<https://example.com/a|example.com/a>${close} now`,
        )
      }
    })

    test("words with no mention look no member up, and an email or a mention inside a URL stays as written (PG-1983)", async () => {
      const { shared, steps } = sharing("mail a@b.example or see https://example.com/@alex")
      await shared
      expect(steps.map((step) => step.at)).not.toContain("users.list")
      expect(steps.at(-1)?.params?.initial_comment).toBe(
        "mail a@b.example or see <https://example.com/@alex|example.com/@alex>",
      )
    })
  })

  // dm upload takes one item id: a channel, a thread or a path a caller adds is refused before the slack extension's script runs
  test("playground dm upload refuses anything but one item id", () => {
    for (const args of [
      [],
      ["/etc/hosts"],
      ["C0MADEUP01"],
      ["3f0e7a52-1c4b-4d2a-9e6f-0000000000a1", "--channel", "C0MADE0101"],
      ["3f0e7a52-1c4b-4d2a-9e6f-0000000000a1", "1700000000.000100"],
    ]) {
      const run = Bun.spawnSync(
        ["bun", "--no-env-file", join(REPO, "packages/scripts/src/dm/cli.ts"), "upload", ...args],
        { stderr: "pipe", stdin: "ignore", stdout: "pipe" },
      )
      expect(run.exitCode).toBe(2)
      expect(run.stderr.toString()).toContain("playground dm upload <item id>")
    }
  })
})
