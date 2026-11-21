import { describe, expect, test } from "bun:test"

import {
  answerOf,
  type Card,
  cardOf,
  goesOut,
  HIDDEN,
  pollOf,
  redact,
  replyOf,
  termsOf,
  waitingLine,
  waits,
} from "../../../../../packages/scripts/src/ops-wa/cards"
import { UNSET_REPOS } from "../../../../../packages/scripts/src/trace-count/kinds"

// A made-up list for no-public-leak: none of its words is a real person, handle, company, channel or ticket key.
const LIST = {
  companies: ["Acmeworks"],
  handles: ["zed-handle"],
  linearKeys: ["ZZQ"],
  names: ["Quillon Barr"],
  slackIds: ["C0FAKE0001"],
}
const TERMS = termsOf(LIST, UNSET_REPOS)

const ask = (over: Partial<Card> = {}, preview: Partial<Card["preview"]> = {}): Card => ({
  answer: null,
  from: "builder",
  id: "00000000-0000-4000-8000-000000000012",
  kind: "decision",
  preview: { scope: "factory", text: "Merge the fix tonight?", type: "ask", ...preview },
  ref: 12,
  status: "open",
  title: "Merge tonight",
  ...over,
})

describe("which cards go to WhatsApp", () => {
  test("an open ask decision and an update from a factory session go", () => {
    expect(goesOut(ask(), TERMS)).toBe(true)
    expect(
      goesOut(ask({ kind: "update" }, { outcome: "merged", type: undefined } as never), TERMS),
    ).toBe(true)
    expect(goesOut(ask({ from: "k3m9px-worker" }), TERMS)).toBe(true)
  })

  // door 2: an allowlist, so every other kind stays in the Inbox whatever its words
  test.each([
    ["a delete decision", { preview: { type: "delete", what: "/tmp/x", why: "old" } }],
    ["a secret ask", { preview: { key: "FAKE_KEY", type: "secret" } }],
    ["a reveal card", { preview: { type: "reveal", why: "to read it" } }],
    ["a budget decision", { preview: { amount: "$5", type: "budget", why: "a run" } }],
    ["a ship decision", { preview: { sha: "abcdef1", type: "ship" } }],
    ["a schema decision", { preview: { shape: "a table", type: "schema" } }],
    ["a ticket decision", { preview: { team: "Core", title: "x", type: "ticket" } }],
    ["a slack decision", { preview: { text: "hi", to: "a thread", type: "slack" } }],
    ["a guard decision", { preview: { key: "jobs.opsWa", type: "guard" } }],
    ["a draft", { kind: "draft", preview: { text: "a reply", to: "a thread" } }],
    ["a multi-question ask", { preview: { questions: [{}, {}], text: "two", type: "ask" } }],
  ] as [string, Partial<Card>][])("%s stays in the Inbox", (_, over) => {
    expect(goesOut({ ...ask(), ...over } as Card, TERMS)).toBe(false)
  })

  // door 2, failing closed: the poster's scope says whose work it is, so a card goes only when it names the factory's
  test.each([
    ["no scope", { scope: undefined }],
    ["an org's scope, though its words hold no listed term", { scope: "zyx-org" }],
  ])("a card with %s stays", (_, preview) => {
    expect(goesOut(ask({}, preview), TERMS)).toBe(false)
    expect(goesOut(ask({ kind: "update" }, { ...preview, type: undefined }), TERMS)).toBe(false)
  })

  test("a card from a session that is no factory session's, as an org's own job posts, stays", () => {
    expect(goesOut(ask({ from: "acme-sync" }), TERMS)).toBe(false)
  })

  test("a card whose words hold an org's term stays, in its title, text or a choice", () => {
    expect(goesOut(ask({ title: "Acmeworks deploy" }), TERMS)).toBe(false)
    expect(goesOut(ask({}, { text: "for acmeworks" }), TERMS)).toBe(false)
    expect(
      goesOut(ask({}, { options: [{ label: "Ship Acmeworks" }, { label: "Hold" }] }), TERMS),
    ).toBe(false)
  })

  test("an answered card stays", () => {
    expect(goesOut(ask({ status: "approved" }), TERMS)).toBe(false)
  })
})

describe("which kept cards count as waiting", () => {
  const NOW = Date.parse("2026-11-11T03:00:00Z")
  test("an open card counts, one the owner replied to or put away until a later time does not", () => {
    expect(waits(ask(), NOW)).toBe(true)
    expect(waits(ask({ answer: { choice: "replied" } }), NOW)).toBe(false)
    expect(waits(ask({ answer: { snoozedUntil: "2026-11-12T00:00:00Z" } }), NOW)).toBe(false)
  })
  test("a put-away counts once its time passes, and an archived one only after a dismissal", () => {
    expect(waits(ask({ answer: { snoozedUntil: "2026-11-11T00:00:00Z" } }), NOW)).toBe(true)
    expect(waits(ask({ answer: { archivedAt: "2026-11-10T00:00:00Z" } }), NOW)).toBe(false)
    expect(
      waits(
        ask({
          answer: { archivedAt: "2026-11-10T00:00:00Z", dismissedAt: "2026-11-11T00:00:00Z" },
        }),
        NOW,
      ),
    ).toBe(true)
    expect(waits(ask({ status: "approved" }), NOW)).toBe(false)
  })
})

describe("the redactor", () => {
  test.each([
    ["a person's name", "ask Quillon Barr first"],
    ["a handle", "ping zed-handle"],
    ["a company term", "the Acmeworks build"],
    ["a Slack id", "see C0FAKE0001"],
    ["a Linear key", "filed ZZQ-42"],
    ["an email", "mail made.up@example.com"],
    ["a GitHub token", `token ghp_${"a".repeat(36)}`],
    ["a Slack token", "token xoxb-1234567890-fake"],
    ["an Anthropic key", `key sk-ant-${"b".repeat(24)}`],
    ["a URL with a password", "db postgres://user:pw@127.0.0.1/x"],
  ])("hides %s", (_, text) => {
    const said = redact(text, TERMS)
    expect(said).toContain(HIDDEN)
    expect(said).not.toBe(text)
  })

  test("hides a private key's whole block", () => {
    const said = redact(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----",
      TERMS,
    )
    expect(said).toBe(HIDDEN)
  })

  test("leaves plain factory status as it is", () => {
    expect(redact("#1828 merged; the suite is green", TERMS)).toBe(
      "#1828 merged; the suite is green",
    )
  })
})

describe("a card as WhatsApp shows it", () => {
  test("a yes or no ask: its title, words and two numbered rows naming its id", () => {
    const { rows, text } = cardOf(ask({}, { approve: "Merge it", deny: "Hold it" }), TERMS)
    expect(text).toBe(
      "*Merge tonight*\nMerge the fix tonight?\nReply 1 #i12 to Merge it\nReply 2 #i12 to Hold it",
    )
    expect(rows).toEqual([
      { go: true, label: "Merge it" },
      { go: false, label: "Hold it" },
    ])
  })

  test("a lettered ask numbers each option, then None of these", () => {
    const { text } = cardOf(
      ask({}, { options: [{ label: "Tonight" }, { label: "Tomorrow" }] }),
      TERMS,
    )
    expect(text).toContain(
      "Reply 1 #i12 to Tonight\nReply 2 #i12 to Tomorrow\nReply 3 #i12 to None of these",
    )
  })

  test("files stay in the Inbox, and the text says so", () => {
    expect(cardOf(ask({}, { attachments: [{}, {}] }), TERMS).text).toContain(
      "It holds 2 files: open it in the Inbox.",
    )
  })

  test("an update asks nothing and has no rows", () => {
    const card = cardOf(
      ask({ kind: "update", title: "#1828 merged" }, { text: "CI is green", type: undefined }),
      TERMS,
    )
    expect(card).toEqual({
      poll: undefined,
      rows: [],
      text: "*#1828 merged*\nCI is green\n#i12 is an update: it asks nothing.",
    })
  })

  test("the redactor runs over the rows too", () => {
    const { rows, text } = cardOf(ask({}, { approve: "Tell Quillon Barr", deny: "Hold" }), TERMS)
    expect(rows[0]!.label).toBe(`Tell ${HIDDEN}`)
    expect(text).not.toContain("Quillon")
  })

  test("its poll names the card's id and redacted title, one numbered option per row, and fits WhatsApp's 2 to 12 options (#2752)", () => {
    const { poll } = cardOf(
      ask({ title: "Tell Quillon Barr?" }, { approve: "Merge it", deny: "Hold it" }),
      TERMS,
    )
    expect(poll).toEqual({
      name: `#i12 Tell ${HIDDEN}?`,
      values: ["1. Merge it", "2. Hold it"],
    })
    const row = (label: string) => ({ go: true, label })
    expect(pollOf(3, "x", [row("only")])).toBeUndefined()
    expect(
      pollOf(
        3,
        "x",
        Array.from({ length: 13 }, (_, i) => row(`r${i}`)),
      ),
    ).toBeUndefined()
    expect(pollOf(3, "x", [row("same"), row("same")])!.values).toEqual(["1. same", "2. same"])
  })

  test("the waiting message names each kept card by its title alone, one 📥 line each", () => {
    const titled = (...titles: string[]) => titles.map((title) => ({ title }))
    expect(waitingLine(titled("Add the second number", "Merge #12?"), TERMS)).toBe(
      "📥 Add the second number\n📥 Merge #12?",
    )
  })

  test("past 5 cards it shows 5, then one line counting the rest", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `Card ${i + 1}` }))
    expect(waitingLine(seven, TERMS).split("\n")).toEqual([
      "📥 Card 1",
      "📥 Card 2",
      "📥 Card 3",
      "📥 Card 4",
      "📥 Card 5",
      "📥 +2 more in the Inbox",
    ])
  })

  test("a title's token or hide term reads [hidden], and a title holding a kept-back term shows only in the count", () => {
    const lines = waitingLine(
      [
        { title: `Rotate ghp_${"a".repeat(36)}` },
        { title: "Ask Quillon Barr" },
        { title: "Acmeworks renewal" },
      ],
      TERMS,
    )
    expect(lines).toBe("📥 Rotate [hidden]\n📥 Ask [hidden]\n📥 +1 more in the Inbox")
    expect(lines).not.toContain("Acmeworks")
    expect(waitingLine([{ title: "Acmeworks renewal" }], TERMS)).toBe("📥 1 card in the Inbox")
  })

  test("while the terms cannot be read, the count alone goes", () => {
    expect(waitingLine([{ title: "a" }, { title: "b" }], undefined)).toBe("📥 2 cards in the Inbox")
  })
})

describe("reading a reply", () => {
  test.each([
    ["1 #i12", { number: 1, ref: 12 }],
    ["2#i12", { number: 2, ref: 12 }],
    ["#i12 2", { number: 2, ref: 12 }],
    [" 1 #I12 ", { number: 1, ref: 12 }],
    ["1", { number: 1 }],
    ["#i12", { ref: 12 }],
  ])("%s", (text, reply) => {
    expect(replyOf(text)).toEqual(reply)
  })

  test.each(["is #i12 merged?", "1 and 2", "status?", "#1828"])("%s is no card reply", (text) => {
    expect(replyOf(text)).toBeNull()
  })

  test("a go row approves, the place naming the option only when there are several, and the no-go row denies", () => {
    const yesNo = [
      { go: true, label: "Merge" },
      { go: false, label: "Hold" },
    ]
    expect(answerOf(yesNo, 0)).toEqual({ action: "approve" })
    expect(answerOf(yesNo, 1)).toEqual({ action: "deny" })
    const letters = [
      { go: true, label: "A" },
      { go: true, label: "B" },
      { go: false, label: "None" },
    ]
    expect(answerOf(letters, 1)).toEqual({ action: "approve", option: 1 })
    expect(answerOf(letters, 2)).toEqual({ action: "deny" })
  })
})
